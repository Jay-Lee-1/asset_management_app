/* 암호화폐 시세 중계 함수 — 업비트 공개 티커 API를 그대로 중계합니다(키 불필요).
 *
 * 호출: /.netlify/functions/crypto?codes=BTC,ETH
 * 응답: { "BTC": 143250000, "ETH": 5120000 }   ← 모두 '원' 단위 (업비트 KRW 마켓 현재가 그대로)
 * 진단: ?debug=1 을 붙이면 _debug(출처/에러)를 함께 반환
 *
 * stock.js와 동일한 getJSON(재시도+타임아웃) 유틸을 재사용한다. 업비트는 KRW 마켓 현재가를
 * 그대로 주므로(해외 주식과 달리 환율 환산이 필요 없음) stock.js의 fx 변환 단계가 없다.
 */
exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || null;

  const rl = shouldThrottle(rlHistory, Date.now(), RL_WINDOW_MS, RL_MAX);
  rlHistory = rl.history;
  if (!rl.allow) {
    return json(429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' }, 0, origin);
  }

  const codes = parseCodes((event.queryStringParameters || {}).codes || '');
  if (!codes.length) {
    return json(400, { error: 'codes 파라미터가 필요해요 (예: ?codes=BTC,ETH)' }, 0, origin);
  }

  const out = {};
  const debug = { errors: {} };

  try {
    const markets = marketsParam(codes);
    const j = await getJSON(`https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(markets)}`, { headers: UPBIT_HEADERS });
    Object.assign(out, pricesFromTickers(Array.isArray(j) ? j : []));
    codes.forEach(c => { if (!(c in out)) debug.errors[c] = 'not found'; });
  } catch (e) {
    codes.forEach(c => { debug.errors[c] = errText(e); });
  }

  const wantDebug = (event.queryStringParameters || {}).debug === '1';
  return json(200, wantDebug ? { ...out, _debug: debug } : out, Object.keys(out).length ? 30 : 0, origin);
};

/* ── codes 파라미터 파싱: 중복 제거·대문자화·업비트 심볼 형태(영문+숫자 2~10자)만 허용 ──────── */
function parseCodes(raw) {
  return [...new Set(
    raw.split(',').map(c => c.trim().toUpperCase()).filter(c => /^[A-Z0-9]{2,10}$/.test(c))
  )].slice(0, 20);
}

/* ── BTC,ETH → KRW-BTC,KRW-ETH (업비트는 항상 "마켓-심볼" 형태) ─────────────────────────────── */
function marketsParam(codes) { return codes.map(c => `KRW-${c}`).join(','); }

/* ── 업비트 티커 응답([{market:'KRW-BTC',trade_price:...}, ...]) → {BTC: price} ─────────────── */
function pricesFromTickers(tickers) {
  const out = {};
  tickers.forEach(t => {
    if (!t || typeof t.market !== 'string' || !t.market.startsWith('KRW-')) return;
    const code = t.market.slice(4);
    const price = toNum(t.trade_price);
    if (price > 0) out[code] = price;
  });
  return out;
}

/* ── 공통 유틸 (netlify/functions/_shared.js로 이동 — app-evolve cycle228 advance) ─────────── */
const shared = require('./_shared');
const { errText, toNum, getJSON, isAllowedOrigin, shouldThrottle } = shared;

const UPBIT_HEADERS = { Accept: 'application/json' };

/* ── 공개 프록시 남용 완화 (app-evolve cycle225 critique) ──────────────────────
 * stock.js/rates.js와 같은 이유로 ALLOWED_ORIGINS/RL_WINDOW_MS/RL_MAX/rlHistory는
 * 엔드포인트별로 분리 유지한다(레이트리밋 버킷이 섞이면 분당 한도가 의도와 달라짐). */
const ALLOWED_ORIGINS = shared.parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const RL_WINDOW_MS = 60000;
const RL_MAX = 30;
let rlHistory = [];

function json(status, body, maxAge, origin) {
  return shared.json(status, body, maxAge, origin, ALLOWED_ORIGINS);
}

// 테스트(test/run.js)에서 순수 함수만 골라 require하기 위한 exports.
// exports.handler는 그대로 유지되므로 Netlify 배포/동작에는 영향 없다.
module.exports = { parseCodes, marketsParam, pricesFromTickers, toNum, errText, isAllowedOrigin, shouldThrottle };
