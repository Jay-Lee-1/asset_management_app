/* 주식 시세 중계 함수 (국내 + 해외) — v2 폴백 강화판
 * 브라우저에서 증권 사이트를 직접 부르면 CORS로 막히므로, 서버가 대신 가져와 전달합니다.
 *
 * 호출: /.netlify/functions/stock?codes=005930,AAPL,TSLA
 * 응답: { "005930": 79800, "AAPL": 322150 }   ← 모두 '원' 단위
 * 진단: ?debug=1 을 붙이면 _debug(출처/에러/HTTP상태)를 함께 반환
 *
 * - 6자리 숫자 → 국내 주식 (네이버 금융)
 * - 그 외 티커 → 해외 주식 (네이버 worldstock) → 실패 시 Finnhub 폴백(선택) → 원화 환산
 *
 * 환율 폴백 체인: 네이버 시장지표 → fxapi.app(/api/usd.json) → open.er-api.com
 *   (기존 fxapi 엔드포인트 /api/latest?base=KRW 는 404 나서 신형으로 교체)
 *
 * 해외 폴백을 쓰려면 Netlify 환경변수 FINNHUB_KEY 를 설정하세요(무료, 60 calls/min).
 *   Site settings → Environment variables → FINNHUB_KEY
 *   키가 없으면 네이버만으로 동작하고, 실패 시 debug에 사유가 남습니다.
 *   (Stooq는 2026년 키/봇챌린지 도입으로 서버리스에서 사용 불가하여 제외했습니다.)
 */
exports.handler = async (event) => {
  const raw = ((event.queryStringParameters || {}).codes || '')
    .split(',')
    .map(c => c.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);

  if (!raw.length) {
    return json(400, { error: 'codes 파라미터가 필요해요 (예: ?codes=005930,AAPL)' });
  }

  const domestic = raw.filter(c => /^\d{6}$/.test(c));
  const overseas = raw.filter(c => !/^\d{6}$/.test(c) && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(c));

  const out = {};
  const debug = { fx: null, tried: {}, errors: {} };

  // 해외 주식이 있으면 환율표를 한 번만 조회 (통화별 → KRW)
  let fx = null;
  if (overseas.length) {
    try { fx = await fetchFxToKrw(debug); debug.fx = fx; }
    catch (e) { debug.errors.fx = errText(e); }
  }

  await Promise.all([
    ...domestic.map(async (code) => {
      try {
        const p = await fetchNaver(code);
        if (p) out[code] = p; else debug.errors[code] = 'naver: empty';
      } catch (e) { debug.errors[code] = 'naver: ' + errText(e); }
    }),
    ...overseas.map(async (code) => {
      // 1) 네이버 worldstock
      try {
        const q = await fetchOverseasNaver(code);
        if (q) {
          debug.tried[code] = q;
          const krw = toKrw(q, fx);
          if (krw != null) { out[code] = krw; return; }
          debug.errors[code] = `환율 없음 (${q.currency})`;
          return;
        }
      } catch (e) { debug.errors[code] = 'naver: ' + errText(e); }

      // 2) 폴백: Finnhub (FINNHUB_KEY 있을 때만) — 미국 티커는 USD로 간주
      try {
        const q = await fetchOverseasFinnhub(code);
        if (q) {
          debug.tried[code] = { ...q, via: 'finnhub' };
          const krw = toKrw(q, fx);
          if (krw != null) { out[code] = krw; return; }
          debug.errors[code] = `환율 없음 (${q.currency})`;
          return;
        }
        if (!debug.errors[code]) debug.errors[code] = 'not found (naver+finnhub 실패)';
      } catch (e) {
        debug.errors[code] = (debug.errors[code] ? debug.errors[code] + ' / ' : '') + 'finnhub: ' + errText(e);
      }
    })
  ]);

  const wantDebug = (event.queryStringParameters || {}).debug === '1';
  return json(200, wantDebug ? { ...out, _debug: debug } : out, 60);
};

/* 해외 시세 → 원화 변환 */
function toKrw(q, fx) {
  if (q.currency === 'KRW') return Math.round(q.price);
  const rate = fx && fx[q.currency];
  if (rate) return Math.round(q.price * rate);
  return null;
}

/* ── 국내: 네이버 금융 ────────────────────────────────────────────────────── */
async function fetchNaver(code) {
  const j = await getJSON(`https://m.stock.naver.com/api/stock/${code}/basic`, { headers: NAVER_HEADERS });
  return toNum(j.closePrice || j.nowVal);
}

/* ── 해외: 네이버 worldstock (reutersCode 접미사 .O/.K/.N/.A) ───────────────── */
const NAVER_SUFFIXES = ['O', 'K', 'N', 'A'];

async function fetchOverseasNaver(ticker) {
  const hasSuffix = /\.[A-Z]$/.test(ticker);
  const candidates = hasSuffix ? [ticker] : NAVER_SUFFIXES.map(s => `${ticker}.${s}`);

  let lastErr = null;
  for (const code of candidates) {
    let j;
    try {
      j = await getJSON(
        `https://m.stock.naver.com/api/worldstock/stock/${encodeURIComponent(code)}/basic`,
        { headers: NAVER_HEADERS, retries: 0 }   // 접미사 여러 개 도니 개별 재시도는 생략
      );
    } catch (e) { lastErr = e; continue; }       // HTTP 상태 보존 (404 진단용)
    const price = toNum(j.closePrice || j.currentPrice);
    if (!price) continue;
    const currency = (j.currencyType && j.currencyType.code) || j.currency || 'USD';
    return { price, currency: String(currency).toUpperCase() };
  }
  if (lastErr) throw lastErr;   // 전부 에러였다면 상태를 위로 던져 debug에 남김
  return null;                  // 200이지만 값이 없던 경우
}

/* ── 해외 폴백: Finnhub (무료 키 필요). 미국 티커는 USD로 간주 ─────────────── */
async function fetchOverseasFinnhub(ticker) {
  const key = process.env.FINNHUB_KEY;
  if (!key) { const e = new Error('FINNHUB_KEY 미설정'); e.status = 0; throw e; }
  const sym = ticker.replace(/\.[A-Z]$/, ''); // 네이버식 접미사 제거
  const d = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`);
  const price = toNum(d && d.c);               // c: current price (0이면 유효하지 않은 심볼)
  if (!price) return null;
  return { price, currency: 'USD' };
}

/* ── 환율: 각 통화 → KRW (네이버 → fxapi → open.er-api) ────────────────────── */
async function fetchFxToKrw(debug) {
  const out = { KRW: 1 };
  const curs = ['USD', 'JPY', 'EUR'];

  // 1순위: 네이버 시장지표 (신 경로 /front-api/v1/marketIndex/prices, 응답은 result 배열)
  await Promise.all(curs.map(async (cur) => {
    try {
      const d = await getJSON(
        `https://m.stock.naver.com/front-api/v1/marketIndex/prices?category=exchange&reutersCode=FX_${cur}KRW&page=1&pageSize=1`,
        { headers: NAVER_HEADERS }
      );
      const rows = pickRows(d);
      const p = toNum(rows && rows[0] && rows[0].closePrice);
      if (p) out[cur] = cur === 'JPY' ? p / 100 : p; // 엔은 100엔 고시
    } catch (e) { if (debug) debug.errors['fx_' + cur] = 'naver: ' + errText(e); }
  }));

  if (out.USD) return out;

  // 2순위: fxapi.app(신형) → 3순위: open.er-api.com  (둘 다 "1 USD = ? X" 형태)
  for (const [name, url] of [['fxapi', 'https://fxapi.app/api/usd.json'], ['er-api', 'https://open.er-api.com/v6/latest/USD']]) {
    try {
      const d = await getJSON(url);
      const rates = d && d.rates;
      if (rates && rates.KRW) {
        const usdKrw = Number(rates.KRW);
        out.USD = usdKrw;
        for (const c of ['JPY', 'EUR']) if (rates[c]) out[c] = usdKrw / Number(rates[c]);
        return out;
      }
    } catch (e) { if (debug) debug.errors['fx_' + name] = errText(e); }
  }

  throw new Error('fx: 모든 소스 실패');
}

/* ── 공통 유틸 ───────────────────────────────────────────────────────────── */
const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'Referer': 'https://m.stock.naver.com/',
  'Origin': 'https://m.stock.naver.com'
};

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
      if (attempt < retries && !e.status) { await sleep(250); continue; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function errText(e) { return e && e.status ? ('HTTP ' + e.status) : String(e && e.message || e); }

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
