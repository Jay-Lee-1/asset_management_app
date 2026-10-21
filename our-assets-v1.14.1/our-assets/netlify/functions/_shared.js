/* netlify/functions 시세 중계 함수 3종(stock.js/rates.js/crypto.js)이 공유하는 순수 유틸.
 * 세 파일이 거의 동일한 ~140줄짜리 블록을 복붙으로 유지하다 drift가 시작된 것을 고치기
 * 위해 신설(app-evolve cycle228 advance, cycle228 critique가 세운 계획).
 *
 * RL_WINDOW_MS/RL_MAX/rlHistory(상태 있는 레이트리밋 버킷)는 여기로 올리지 않고 각 파일
 * 스코프에 그대로 둔다 — 엔드포인트별 분당 호출 한도가 서로 섞이면 안 되기 때문이다.
 * shouldThrottle 자체(순수 계산)만 공유한다. */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function errText(e) { return e && e.status ? ('HTTP ' + e.status) : String(e && e.message || e); }

function toNum(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 네이버 응답이 배열이든 { result:[...] }든 { result:{prices:[...]} }든 안전하게 행 배열로
function pickRows(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.result)) return d.result;
  if (d && d.result && Array.isArray(d.result.prices)) return d.result.prices;
  return [];
}

// 엔(JPY)은 100엔 단위로 고시되므로 원화 환산 전에 100으로 나눈다. 나머지 통화는 그대로.
function applyJpyScale(cur, price) { return cur === 'JPY' ? price / 100 : price; }

// 타임아웃 + 429/5xx 재시도. 실패 시 err.status 에 HTTP 상태를 담아 던짐. 네트워크성 오류도 재시도.
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

/* ── 공개 프록시 남용 완화 (app-evolve cycle225 critique) ──────────────────────
 * ALLOWED_ORIGINS 환경변수(쉼표구분) 설정 시에만 Access-Control-Allow-Origin을 그
 * 목록에 있는 Origin으로만 echo한다. 미설정이면 배포 도메인을 미리 알 수 없어(Netlify
 * Drop이 임의 서브도메인을 발급) 기존처럼 '*'로 전체 허용한다. curl 등 Origin 헤더
 * 자체가 없는 비브라우저 호출은 CORS로 원천적으로 못 거른다는 한계가 있다. */
function parseAllowedOrigins(raw) {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin, allowlist) {
  if (!allowlist || !allowlist.length) return true;
  if (!origin) return true;
  return allowlist.includes(origin);
}

function shouldThrottle(history, now, windowMs, maxCount) {
  const pruned = (history || []).filter(t => now - t < windowMs);
  if (pruned.length >= maxCount) return { allow: false, history: pruned };
  pruned.push(now);
  return { allow: true, history: pruned };
}

function corsOrigin(origin, allowlist) {
  if (!allowlist.length) return '*';
  return isAllowedOrigin(origin, allowlist) && origin ? origin : null;
}

function json(status, body, maxAge, origin, allowedOrigins) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store'
  };
  const aco = corsOrigin(origin, allowedOrigins);
  if (aco) headers['Access-Control-Allow-Origin'] = aco;
  if (allowedOrigins.length) headers['Vary'] = 'Origin';
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

module.exports = {
  sleep, errText, toNum, pickRows, applyJpyScale, getJSON,
  parseAllowedOrigins, isAllowedOrigin, shouldThrottle, corsOrigin, json
};
