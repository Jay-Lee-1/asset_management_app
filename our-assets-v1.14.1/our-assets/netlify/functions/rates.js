/* 환율 · 금 시세 중계 함수 (v2 — 폴백 강화판)
 * 브라우저에서 외부 시세 API를 직접 부르면 CORS로 막히므로, 서버가 대신 가져와 전달합니다.
 *
 * 호출: /.netlify/functions/rates?cur=USD,JPY&gold=1
 * 응답: { "fx": { "USD": 1385.2, "JPY": 9.12 }, "goldPerG": 152000 }
 * 진단: ?debug=1 을 붙이면 _debug(출처/에러/HTTP상태)를 함께 반환
 *
 * 출처 우선순위
 *   환율: 네이버 시장지표 → fxapi.app(/api/usd.json) → open.er-api.com
 *   금  : 네이버 metals → gold-api.com(XAU) 환산
 *
 * 변경점(중요)
 *   - 기존 fxapi 폴백 URL(/api/latest?base=KRW)이 404 나던 것을 신형(/api/usd.json)으로 교체
 *   - 네이버 실패 시 조용히 0 처리하던 것을 HTTP 상태까지 debug에 기록
 *   - 타임아웃 + 429/5xx 재시도 추가로 간헐적 차단 완화
 */
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const curs = (q.cur || 'USD')
    .split(',')
    .map(c => c.trim().toUpperCase())
    .filter(c => /^[A-Z]{3}$/.test(c))
    .slice(0, 10);
  const wantGold = q.gold === '1';
  const wantDebug = q.debug === '1';

  const out = { fx: {}, goldPerG: 0 };
  const debug = { errors: {}, source: {} };

  // 1) 네이버 우선 시도 (환율 + 금 병렬)
  await Promise.all([
    ...curs.map(async (cur) => {
      if (cur === 'KRW') { out.fx.KRW = 1; debug.source.KRW = 'const'; return; }
      try {
        const p = await naverFx(cur);
        if (p) { out.fx[cur] = p; debug.source[cur] = 'naver'; }
        else debug.errors[cur] = 'naver: empty';
      } catch (e) { debug.errors[cur] = 'naver: ' + errText(e); }
    }),
    (async () => {
      if (!wantGold) return;
      try {
        const g = await naverGold();
        if (g) { out.goldPerG = g; debug.source.gold = 'naver'; }
        else debug.errors.gold = 'naver: empty';
      } catch (e) { debug.errors.gold = 'naver: ' + errText(e); }
    })()
  ]);

  // 2) 환율 폴백: 네이버로 못 채운 통화가 있으면 공용 FX 체인으로 보충
  const missing = curs.filter(c => c !== 'KRW' && !out.fx[c]);
  let usdKrw = out.fx.USD || 0;
  if (missing.length) {
    try {
      const fx = await fxFallbackChain(curs, debug);   // { USD, JPY, ..., _usdKrw, _src }
      if (fx) {
        usdKrw = usdKrw || fx._usdKrw || 0;
        for (const c of missing) {
          if (fx[c]) { out.fx[c] = fx[c]; debug.source[c] = fx._src; }
        }
      }
    } catch (e) { debug.errors.fxFallback = errText(e); }
  }

  // 3) 금 폴백: 네이버 금 실패 시 gold-api.com(XAU, USD/oz) → 원/g 환산
  if (wantGold && !out.goldPerG) {
    if (!usdKrw) usdKrw = out.fx.USD || 0;
    if (usdKrw) {
      try {
        const perOzUsd = await goldApiXau();
        if (perOzUsd) {
          out.goldPerG = Math.round((perOzUsd * usdKrw) / 31.1034768);
          debug.source.gold = 'gold-api.com';
        } else debug.errors.goldFallback = 'gold-api: empty';
      } catch (e) { debug.errors.goldFallback = errText(e); }
    } else {
      debug.errors.goldFallback = 'no USD rate to convert';
    }
  }

  return json(200, wantDebug ? { ...out, _debug: debug } : out, 300);
};

/* ── 네이버 시장지표 (신 경로): 1 외화 = ? 원 (엔은 100엔 고시라 100으로 나눔) ──
   네이버가 /api/marketindex/... → /front-api/v1/marketIndex/prices 로 이전(구 경로는 404).
   응답은 { result: [ { closePrice, ... } ] } 형태라 result 배열에서 꺼냅니다. */
async function naverFx(cur) {
  const d = await getJSON(
    `https://m.stock.naver.com/front-api/v1/marketIndex/prices?category=exchange&reutersCode=FX_${cur}KRW&page=1&pageSize=1`,
    { headers: NAVER_HEADERS }
  );
  const rows = pickRows(d);
  const p = toNum(rows && rows[0] && rows[0].closePrice);
  if (!p) return 0;
  return cur === 'JPY' ? p / 100 : p;
}

/* 네이버 시장지표: 국제 금(USD/oz) → 원/g */
async function naverGold() {
  const d = await getJSON(
    'https://m.stock.naver.com/front-api/v1/marketIndex/prices?category=metals&reutersCode=CMDT_GC&page=1&pageSize=1',
    { headers: NAVER_HEADERS }
  );
  const rows = pickRows(d);
  const usdPerOz = toNum(rows && rows[0] && rows[0].closePrice);
  if (!usdPerOz) return 0;
  const usd = await naverFx('USD').catch(() => 0);
  if (!usd) return 0;
  return Math.round((usdPerOz * usd) / 31.1034768);
}

/* ── 공용 환율 폴백 체인: fxapi.app → open.er-api.com ──────────────────────────
   두 소스 모두 "1 USD = ? 각 통화" 형태의 rates를 주므로 동일 파서로 처리 */
async function fxFallbackChain(curs, debug) {
  // (a) fxapi.app 신형 엔드포인트
  try {
    const d = await getJSON('https://fxapi.app/api/usd.json');
    const m = ratesUsdBaseToKrw(d && d.rates, curs);
    if (m) { m._src = 'fxapi'; return m; }
  } catch (e) { debug.errors.fxapi = errText(e); }

  // (b) open.er-api.com (키 불필요, 서버리스에서 안정적)
  try {
    const d = await getJSON('https://open.er-api.com/v6/latest/USD');
    const m = ratesUsdBaseToKrw(d && d.rates, curs);
    if (m) { m._src = 'er-api'; return m; }
  } catch (e) { debug.errors.erapi = errText(e); }

  return null;
}

/* rates[X] = "1 USD 당 X" → 각 통화의 원화 환율로 변환 */
function ratesUsdBaseToKrw(rates, curs) {
  if (!rates || !rates.KRW) return null;
  const usdKrw = Number(rates.KRW);
  const out = { _usdKrw: usdKrw };
  for (const c of curs) {
    if (c === 'KRW') { out.KRW = 1; continue; }
    if (c === 'USD') { out.USD = usdKrw; continue; }
    if (rates[c]) out[c] = usdKrw / Number(rates[c]); // (KRW/USD)/(cur/USD)=KRW/cur
  }
  return out;
}

/* gold-api.com: 국제 금 현물 (USD/oz), 키 불필요 → { price: 2345.6 } */
async function goldApiXau() {
  const d = await getJSON('https://api.gold-api.com/price/XAU');
  return toNum(d && d.price);
}

/* ── 공통 유틸 ───────────────────────────────────────────────────────────── */
const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'Referer': 'https://m.stock.naver.com/',
  'Origin': 'https://m.stock.naver.com'
};

// 타임아웃 + 429/5xx 재시도. 실패 시 err.status 에 HTTP 상태를 담아 던짐.
async function getJSON(url, { headers = {}, ms = 6000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        if (attempt < retries && (res.status === 429 || res.status >= 500)) { lastErr = err; await sleep(250 + Math.random() * 400); continue; }
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries && e.name === 'AbortError') { await sleep(250); continue; }
      if (attempt < retries && !e.status) { await sleep(250); continue; } // 네트워크성 오류 재시도
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function errText(e) { return e && e.status ? ('HTTP ' + e.status) : String(e && e.message || e); }

// 네이버 응답이 배열이든 { result:[...] }든 { result:{prices:[...]} }든 안전하게 행 배열로
function pickRows(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.result)) return d.result;
  if (d && d.result && Array.isArray(d.result.prices)) return d.result.prices;
  return [];
}

function toNum(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function json(status, body, maxAge) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store'
    },
    body: JSON.stringify(body)
  };
}
