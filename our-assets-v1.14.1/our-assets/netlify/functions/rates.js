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
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || null;

  const rlKey = clientKeyFromHeaders(event.headers);
  if (!shouldThrottleByKey(rlBuckets, rlKey, Date.now(), RL_WINDOW_MS, RL_MAX)) {
    return json(429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' }, 0, origin);
  }

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

  // 전체 실행시간 상한: 1)~3) 단계가 네이버→fxapi/er-api→gold-api.com까지 최대 4단계 직렬
  // getJSON을 이어붙이는데, 그 각각이 기본 재시도(ms=6000, retries=1)만으로도 최악 ~12초가
  // 걸릴 수 있어 이 상한이 없으면 Netlify 서버리스 실행시간 한도(보통 10초)를 넘긴 하드 502로
  // 끝나버린다 — stock.js가 이미 쓰는 것과 똑같은 '부분 결과라도 돌려준다' 안전장치
  // (app-evolve cycle237 develop, raceDeadline은 _shared.js 공유 헬퍼).
  const HANDLER_BUDGET_MS = 8000;
  const work = (async () => {
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
    // 3)번 금 폴백(gold-api.com)은 XAU(USD/oz)→원 환산에 USD/KRW 환율이 꼭 필요한데, 클라이언트가
    // 보유 중인 fx 통화만 cur로 보내므로(index.html fetchFxGold의 heldCurrencies()) USD를 전혀
    // 들고 있지 않은 사용자(예: cur=JPY,EUR + gold=1)는 missing에 'USD'가 들어갈 길이 없다. 그 결과
    // 요청한 통화(JPY/EUR)는 네이버로 전부 채워져 missing이 비면 이 블록 자체가 건너뛰어지고, 네이버
    // 금 시세(naverGold)만 따로 실패했을 때 goldApiXau 폴백이 "USD 환율을 구한 적이 없음"으로
    // 막혀버렸다(app-evolve cycle240 develop) — ratesUsdBaseToKrw()는 curs와 무관하게 _usdKrw를
    // 항상 함께 돌려주므로, 금 폴백이 필요한데 아직 usdKrw를 못 구했을 때도 같은 체인을 한 번 더
    // 태워 그 _usdKrw만 흡수한다(missing이 비어 있으면 for 루프는 그대로 아무 것도 안 함 — 요청하지
    // 않은 USD를 out.fx에 끼워 넣지 않음).
    const needUsdForGold = wantGold && !out.goldPerG && !usdKrw;
    if (missing.length || needUsdForGold) {
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
  })();

  const timedOut = await raceDeadline(work, HANDLER_BUDGET_MS);
  if (timedOut) debug.timedOut = true; // 아직 못 받아온 통화/금은 out에 없고, wantDebug일 때 errors에도 안 남을 수 있음

  return json(200, wantDebug ? { ...out, _debug: debug } : out, timedOut ? 0 : 300, origin);
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
  return applyJpyScale(cur, p);
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

/* ── 공통 유틸 (netlify/functions/_shared.js로 이동 — app-evolve cycle228 advance) ─────────── */
const shared = require('./_shared');
const { errText, toNum, pickRows, applyJpyScale, getJSON, isAllowedOrigin, shouldThrottle, shouldThrottleByKey, clientKeyFromHeaders, raceDeadline } = shared;

const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'Referer': 'https://m.stock.naver.com/',
  'Origin': 'https://m.stock.naver.com'
};

/* ── 공개 프록시 남용 완화 (app-evolve cycle225 critique, cycle239 advance로 caller별 key 분리) ──
 * stock.js와 같은 이유로 ALLOWED_ORIGINS/RL_WINDOW_MS/RL_MAX/rlBuckets는 엔드포인트별로
 * 분리 유지한다(레이트리밋 버킷이 섞이면 분당 한도가 의도와 달라짐). rlBuckets는 호출자(IP)
 * key별로 버킷을 나눠, 인스턴스 스케일아웃으로 전역 한도가 느슨해지거나 다른 사용자 때문에
 * collateral 429를 맞는 문제를 완화한다(cycle239 critique). */
const ALLOWED_ORIGINS = shared.parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const RL_WINDOW_MS = 60000;
const RL_MAX = 30;
let rlBuckets = new Map();

function json(status, body, maxAge, origin) {
  return shared.json(status, body, maxAge, origin, ALLOWED_ORIGINS);
}

// 테스트(test/run.js)에서 순수 함수만 골라 require하기 위한 exports.
// module.exports를 통째로 덮어쓰면 맨 위 exports.handler가 가리키던 객체와 끊어져
// require(this).handler가 undefined가 돼버린다(Netlify가 바로 이 handler를 호출하므로
// 프로덕션 함수가 완전히 죽는다 — app-evolve cycle230 advance에서 발견/수정).
// Object.assign으로 기존 module.exports(=exports, handler 보유)에 병합해야 안전하다.
Object.assign(module.exports, { ratesUsdBaseToKrw, toNum, pickRows, errText, applyJpyScale, isAllowedOrigin, shouldThrottle, shouldThrottleByKey, clientKeyFromHeaders, raceDeadline });
