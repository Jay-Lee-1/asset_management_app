/* netlify/functions 시세 중계 함수 3종(stock.js/rates.js/crypto.js)이 공유하는 순수 유틸.
 * 세 파일이 거의 동일한 ~140줄짜리 블록을 복붙으로 유지하다 drift가 시작된 것을 고치기
 * 위해 신설(app-evolve cycle228 advance, cycle228 critique가 세운 계획).
 *
 * RL_WINDOW_MS/RL_MAX/rlBuckets(상태 있는 레이트리밋 버킷)는 여기로 올리지 않고 각 파일
 * 스코프에 그대로 둔다 — 엔드포인트별 분당 호출 한도가 서로 섞이면 안 되기 때문이다.
 * shouldThrottle/shouldThrottleByKey/clientKeyFromHeaders 자체(순수 계산)만 공유한다. */

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

/* shouldThrottle의 history 배열은 모듈 스코프 단일 변수(엔드포인트당 하나)라 caller를
 * 구분하지 못한다 — Netlify/Lambda가 트래픽에 따라 여러 인스턴스로 스케일아웃하면 인스턴스마다
 * 독립된 빈 배열을 갖게 돼 (1) 실질 전역 한도가 의도한 값보다 인스턴스 수만큼 느슨해지고,
 * (2) 같은 warm 인스턴스에 우연히 걸린, 자신은 요청을 전혀 안 보낸 다른 사용자가 한 명의
 * 버그 있는/재시도 루프 탭 때문에 429 collateral 차단을 당한다(app-evolve cycle239 critique).
 * caller별(IP 등) key로 버킷을 나눠 이 둘을 모두 완화한다 — 완전한 cross-instance 전역
 * 제한에는 외부 스토어(Netlify Blobs/Upstash 등)가 필요해 이번 범위 밖이다. map은
 * Map<string, number[]>이고 shouldThrottle의 기존 prune/count 로직을 그대로 재사용한다.
 * map.size가 RL_MAX_KEYS를 넘으면 가장 오래 접근하지 않은(= Map 삽입순서상 가장 앞) key를
 * 지우는 단순 LRU로 메모리 무한증가를 막는다. */
const RL_MAX_KEYS = 500;

function shouldThrottleByKey(map, key, now, windowMs, maxCount) {
  const r = shouldThrottle(map.get(key), now, windowMs, maxCount);
  map.delete(key); // 재삽입해 Map 순서상 가장 최근 접근으로 끌어올림(LRU 갱신)
  map.set(key, r.history);
  if (map.size > RL_MAX_KEYS) map.delete(map.keys().next().value);
  return r.allow;
}

/* 레이트리밋 key로 쓸 호출자 식별자. Netlify가 실제 호출자 IP를 담아주는
 * x-nf-client-connection-ip를 우선 쓰고, 없으면(로컬 개발 등) 표준 x-forwarded-for의 첫 IP를
 * 쓴다(프록시 체인을 거치면 콤마로 이어지는데 그 첫 항목이 원 클라이언트). 둘 다 없으면
 * 'unknown' 단일 버킷으로 합쳐 기존 shouldThrottle과 동일하게 동작한다. */
function clientKeyFromHeaders(headers) {
  const h = headers || {};
  const nfIp = h['x-nf-client-connection-ip'] || h['X-Nf-Client-Connection-Ip'];
  if (nfIp) return String(nfIp).trim();
  const fwd = h['x-forwarded-for'] || h['X-Forwarded-For'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return 'unknown';
}

/* stock.js는 개별 소스(네이버/Finnhub 등)가 아무리 느리거나 멈춰있어도 Netlify 서버리스
 * 실행시간 한도(보통 10초)를 넘겨 하드 502가 나는 대신 그때까지 모인 부분 결과를 그대로
 * 반환하도록 Promise.race([work, deadline]) 전체실행시간 상한을 이미 두고 있었다(app-evolve
 * cycle228 critique가 세운 계획, cycle233 advance가 그 deadline setTimeout의 clearTimeout
 * 누락만 고침) — 그런데 rates.js/crypto.js는 이 상한이 애초에 없었다. 둘 다 getJSON()을
 * 기본값(ms=6000, retries=1)으로 부르므로 업스트림이 느리면 "타임아웃→250ms 대기→재시도
 * →다시 타임아웃"으로 한 호출만으로도 최대 ~12.25초가 걸리고(rates.js는 환율+금 네이버 조회가
 * 끝난 뒤에도 fxFallbackChain·goldApiXau로 이어지는 추가 직렬 getJSON까지 있어 최악엔 그보다
 * 훨씬 길어진다), Netlify가 10초 한도에서 함수를 강제 종료해 "부분 결과"가 아니라 완전한 502
 * 실패로 끝난다 — 세 엔드포인트가 똑같이 '느린 업스트림에도 부분 결과를 돌려준다'는 설계
 * 철학(각 파일 상단 주석)을 표방하면서도 rates/crypto만 실제로는 그 철학을 지킬 방법이 없었던
 * 공백(app-evolve cycle237 develop). work가 예산 안에 끝나든 데드라인이 먼저 끝나든 타이머를
 * 항상 clearTimeout해(cycle233이 stock.js에서 사후에 고친 누수를, 공유 헬퍼로 빼면서 처음부터
 * 피한다) 이벤트 루프에 남기지 않는다. 반환값은 timedOut 여부뿐이다 — work 쪽이 그때까지
 * 채워둔 out/debug는 호출부가 클로저로 그대로 들고 있으므로(아직 안 끝났어도 그 시점까지 쓴
 * 값은 남아있음) 따로 전달할 필요가 없다.
 *
 * work가 reject하는 경우(현재 세 호출부 모두 내부에서 항목별로 try/catch해 실제로는 일어나지
 * 않지만, 이 공유 헬퍼 자체의 계약으로는 막아두지 않은 입력)는 원래 .then(onFulfilled)만 걸어둬
 * Promise.race가 reject로 끝나면 그 onFulfilled가 아예 안 불려 clearTimeout(timer)가 실행되지
 * 않았다 — resolve 경로만 정리되고 reject 경로는 budgetMs(최대 8초)짜리 타이머가 그대로 살아
 * 남는 누수였다(work가 resolve/timeout 중 하나로만 끝난다고 암묵 가정했던 버그, work 자체가
 * 100% 안전하다는 걸 이 함수가 검증할 방법은 없으므로 "확실한 쪽만 계산" 원칙과 반대로 암묵
 * 가정에 기댄 셈). .then을 .finally로 바꿔 resolve/reject 양쪽 다 타이머를 정리하면서,
 * reject는 그대로 통과시켜(work의 실패를 감추지 않음) 호출부가 필요하면 직접 처리하게 한다. */
function raceDeadline(work, budgetMs) {
  let timer, timedOut = false;
  const deadline = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, budgetMs); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)).then(() => timedOut);
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
  parseAllowedOrigins, isAllowedOrigin, shouldThrottle, shouldThrottleByKey, clientKeyFromHeaders,
  corsOrigin, json, raceDeadline
};
