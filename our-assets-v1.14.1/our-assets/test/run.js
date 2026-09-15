#!/usr/bin/env node
/* 경량 회귀 테스트 러너 — 빌드 도구 없이 `node test/run.js`로 바로 실행된다.
 * index.html에서 순수 로직 함수들의 소스를 텍스트로 그대로 추출해 실행하므로,
 * 여기 함수 목록은 실제 앱 코드와 항상 같은 소스를 공유한다(복제/재구현 아님).
 * 지금까지 app-evolve 사이클에서 실제로 고친 버그들의 회귀를 막는 게 목적이라,
 * 새 기능을 찾기보다는 "예전에 고친 게 다시 깨지지 않았는가"를 확인한다.
 * 함수 하나를 실패 없이 실행하려면 필요한 다른 순수 함수들도 함께 추출해야 한다
 * (예: recDates는 shiftWeekend/lastDay를 부른다) — 그래서 FUNCTIONS 목록에
 * 최종 테스트 대상이 아닌 의존 함수도 포함돼 있다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(HTML_PATH, 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`extractFunction: "${name}" 함수를 index.html에서 찾지 못함`);
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error(`extractFunction: "${name}" 중괄호 짝이 맞지 않음(추출 로직 확인 필요)`);
  return src.slice(start, i);
}

function extractConst(name) {
  const marker = `const ${name}=`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`extractConst: "${name}" 선언을 index.html에서 찾지 못함`);
  const end = src.indexOf(';', start);
  if (end === -1) throw new Error(`extractConst: "${name}" 선언에 종료 ";"가 없음`);
  // vm.runInContext에서 최상위 const/let 선언은 컨텍스트 객체의 프로퍼티가 되지 않는다
  // (함수 선언과 달리 글로벌에 붙지 않음) — "const "를 떼서 평범한 대입문으로 바꿔야
  // sandbox.<name>으로 접근할 수 있다.
  return src.slice(start + 'const '.length, end + 1);
}

// 테스트 대상 + 그 대상이 내부에서 호출하는 순수 함수들.
const FUNCTIONS = [
  'lastDay', 'addDays', 'shiftWeekend', 'recDates', 'addMonthsStr', 'addMonths',
  'recNthDate', 'recCountUntil', 'isVarCat', 'setCatVar', 'activeRecsForAssets', 'activeRecsForCat',
  'num', 'doRenameCat', 'doDeleteCat', 'budgetProgress', 'totalBudgetSummary', 'addCat',
  'updateNwHistory', 'pruneNwHistory', 'nwChartPath', 'txnsToCSV', 'esc', 'matchTxnQuery',
  'twActive', 'twGuard', 'deleteTxnsUndo', 'deleteRecsUndo', 'deleteAssetsUndo',
  'recApply', 'recSave', 'saveQuickAmount', 'migrate', 'restoreBackup', 'storageOutcomeMsg',
  'monthStartStr', 'monthEndStr', 'expandRec', 'allTxns', 'spendByCategory', 'histSumTotals',
  'dayTypeTotals', 'isPending', 'isDuePending', 'pendingTransferCount', 'expenseBreakdownCard',
  'bigMin', 'upcomingOutflows', 'monthOutflows', 'syncAssetInputs', 'saveAsset', 'isCloudConflict',
  'wname', 'fmtDate', 'shortDate', 'fmtDateFull', 'localHasUnsyncedChanges',
  'recordError', 'showErrBanner', 'hideErrBanner', 'renderCurrent', 'rowKeydown',
  'clampDay', 'saveTx', 'assetBase', 'balancesUpTo', 'balanceAt',
  'addBalanceAdjust', 'updateBalanceAdjust', 'toggleConfirmTransfers',
  'assetEval', 'assetBalance', 'schHorizon', 'ym', 'openAssetPicker', 'delOwner',
  'detectStaleMarketValuedTxns',
];
// ASSET_TYPES는 DEFAULT_GROUP_ORDER(=Object.keys(ASSET_TYPES))가 참조하므로 먼저 와야 함 —
// CONSTS는 순서대로 실행되는 평범한 대입문으로 변환되기 때문(위 extractConst 주석 참고).
// _balCache/BAL_CACHE_MAX는 balancesUpTo()가 참조하는 모듈 스코프 캐시 상태라 같은 방식으로 끌어온다.
// _recCache/REC_CACHE_MAX는 expandRec()가 참조하는 모듈 스코프 캐시 상태라 같은 방식으로 끌어온다.
const CONSTS = ['catKey', 'comma', 'commaQty', 'ASSET_TYPES', 'DEFAULT_GROUP_ORDER', 'EXP_CATS_DEFAULT', 'ADJUST_CAT', 'INC_CATS_DEFAULT', 'SAV_CATS_DEFAULT', 'RANGE_FROM', 'isFuture', 'BAL_CACHE_MAX', '_balCache', 'REC_CACHE_MAX', '_recCache', 'GOLD_G_PER_DON', 'isCashLike', 'isMarketValued'];

const extracted = FUNCTIONS.map(extractFunction).join('\n') + '\n' + CONSTS.map(extractConst).join('\n');

// doRenameCat()은 DB 조작 외에 UI 함수도 몇 개 부르므로($, toast, save, renderCurrent,
// openCatManage) 여기선 아무 일도 안 하는 스텁으로 채운다 — 우리가 검증하려는 건
// DB.catVar/DB.catIcon 마이그레이션 로직이지, 화면 갱신이 아니다.
// snapshotAssetName은 balanceAt/TODAY 등 잔액 계산 체인 전체를 끌고 오므로(이 테스트의
// 대상이 아님) 실제 소스 대신, 어떤 id로 호출됐는지만 기록하는 스텁으로 대체한다 —
// doRenameCat의 UI 스텁($, toast 등)과 같은 이유.
const sandbox = {
  DB: null,
  TODAY: null,
  // RANGE_TO는 index.html에서 `let RANGE_TO=addDays(TODAY,760)`로 TODAY에 파생되는데,
  // 이 파일은 addDays 실행 결과를 그대로 재현하기보다(굳이 필요치도 않아) balancesUpTo/balanceAt을
  // 쓰는 테스트에서 TODAY처럼 직접 값을 세팅하게 둔다.
  RANGE_TO: null,
  catRenameDraft: null,
  catAddDraft: null,
  asDraft: null,
  lastToast: null,
  lastUndo: null,
  snapshotCalls: null,
  TWi: -1,
  window: {},
  txAmtValue: '',
  qAmtValue: '',
  // renderCurrent()의 에러 바운더리 테스트용 상태 — 실제 index.html의 ST/renderers를
  // 그대로 끌어오지 않고(그 둘은 화면 상태/렌더 함수 묶음이라 순수 로직이 아님) 이 테스트가
  // 필요로 하는 최소한의 모양만 흉내낸다(renderers[ST.tab]() 호출 하나만 있으면 됨).
  ST: { tab: 'home' },
  renderers: { home: () => {} },
  // renderHome()이 계산해 넣는 모듈 스코프 변수(_homeNeg) — renderHome 자체는 순수 로직이
  // 아니라 여기선 추출하지 않으므로(위 renderers.home 스텁과 같은 이유), renderCurrent()가
  // 읽기만 하는 이 값을 최소 상태로 흉내낸다.
  _homeNeg: null,
  updateAlerts: () => {},
  requestAnimationFrame: () => {},
  fitAll: () => {},
  svg: () => '',
  console: { error: () => {} },
  lastError: null,
  // errBanner의 최소 DOM 흉내 — classList.add/remove/contains와, "이미 내용을 채웠는지"를
  // 판단하는 showErrBanner()의 el.childElementCount 체크만 흉내내면 된다.
  errBannerEl: {
    _html: '',
    classList: {
      list: [],
      add(c) { if (!this.list.includes(c)) this.list.push(c); },
      remove(c) { this.list = this.list.filter((x) => x !== c); },
      contains(c) { return this.list.includes(c); },
    },
    get childElementCount() { return this._html ? 1 : 0; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  // recSave()/saveQuickAmount()는 각각 $('txAmt')/$('qAmt').value를 읽어 금액을 얻으므로,
  // 그 두 id만 값을 갖는 입력칸처럼 동작시킨다. errBanner는 renderCurrent 에러 바운더리 테스트용.
  $: (id) => id === 'txAmt' ? { value: sandbox.txAmtValue } : id === 'qAmt' ? { value: sandbox.qAmtValue } : id === 'errBanner' ? sandbox.errBannerEl : null,
  toast: (msg) => { sandbox.lastToast = msg; sandbox.toastCalls.push(msg); },
  toastCalls: [],
  save: () => {},
  invalidateBalances: () => {},
  renderCurrent: () => {},
  openCatManage: () => {},
  openOwnerManage: () => {},
  closeSheet: () => {},
  renderTxSheet: () => {},
  uid: () => 'test-uid',
  // saveTx()는 txDraft(전역 폼 상태)를 다루는데, syncTxInputs()는 DOM 입력칸을 읽어 그
  // txDraft에 반영하는 순수 로직이 아닌 함수라 여기선 no-op으로 흉내낸다 — saveTx 테스트는
  // txDraft를 직접 세팅해서 검증하므로 DOM 동기화 자체는 대상이 아니다.
  txDraft: null,
  syncTxInputs: () => {},
  undoToast: (msg, undoFn) => { sandbox.lastUndo = { msg, undoFn }; },
  snapshotAssetName: (id) => { sandbox.snapshotCalls.push(id); },
  // toggleConfirmTransfers()가 끄기 전 확인을 받는 confirmSheet() 스텁 — 실제 시트를 띄우는
  // 대신 호출 인자를 기록하고 콜백만 저장해서, 테스트가 "확인" 버튼을 누른 것처럼 cb를 직접 실행할 수 있게 한다.
  confirmSheet: (title, msg, ok, cb) => { sandbox.confirmSheetCalls.push({ title, msg, ok, cb }); },
  confirmSheetCalls: [],
  rollPendingTransfers: () => {},
  // openAssetPicker()가 실제로 그리는 시트 DOM 대신, 넘겨받은 bodyHtml을 그대로 기록만 하는
  // openPicker() 스텁 — excludeMarketValued 필터가 최종 목록 문자열에 반영됐는지 검증하는 데 쓴다.
  lastPickerHtml: null,
  openPicker: (title, bodyHtml) => { sandbox.lastPickerHtml = bodyHtml; },
};
vm.createContext(sandbox);
vm.runInContext(extracted, sandbox, { filename: 'extracted-from-index.html' });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- addMonths: 월말 롤오버 버그 (72ce67f) ---------- */
test('addMonths: 5/31에서 -3개월은 윤년 아닌 해 2월 말(2/28)로 클램프된다', () => {
  assert.strictEqual(sandbox.addMonths('2026-05-31', -3), '2026-02-28');
});
test('addMonths: 7/31에서 -3개월은 30일까지인 4월의 마지막 날(4/30)로 클램프된다', () => {
  assert.strictEqual(sandbox.addMonths('2026-07-31', -3), '2026-04-30');
});
test('addMonths: 윤년 2월(2/29)로 클램프되는 경우', () => {
  assert.strictEqual(sandbox.addMonths('2024-05-31', -3), '2024-02-29');
});
test('addMonths: 롤오버가 없는 평범한 날짜는 그대로 이동한다', () => {
  assert.strictEqual(sandbox.addMonths('2026-06-15', -3), '2026-03-15');
});
test('addMonths: n이 양수면 앞으로 이동한다', () => {
  assert.strictEqual(sandbox.addMonths('2026-01-15', 2), '2026-03-15');
});

/* ---------- addDays/wname/fmtDate/shortDate/fmtDateFull: UTC-오프셋 음수 시간대에서 날짜가 하루 밀리던 버그 ----------
 * `new Date('2026-09-13')`처럼 시간 없는 날짜 문자열은 UTC 자정으로 파싱되는데,
 * getFullYear/getMonth/getDate/getDay는 로컬 시간대로 읽으므로 UTC-오프셋이 음수인
 * 시간대(미국 등)에서는 그 값이 하루 전 날짜로 밀린다. recDates/addMonthsStr 등은
 * 이미 `new Date(s+'T00:00:00')`로 로컬 자정에 앵커링해 이 문제를 피해가지만
 * addDays/wname/fmtDate/shortDate/fmtDateFull은 그 앵커링이 빠져 있었다.
 * 컨테이너 자체가 UTC/KST(오프셋>=0)라 문제가 보이지 않으므로, 여기서는 일부러
 * process.env.TZ를 미국 동부(America/New_York, UTC-4/-5)로 바꿔가며 검증한다. */
function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { process.env.TZ = prev; }
}
test('addDays: 음수 UTC 오프셋 시간대에서도 날짜가 하루 밀리지 않는다', () => {
  withTZ('America/New_York', () => {
    assert.strictEqual(sandbox.addDays('2026-09-13', 1), '2026-09-14');
    assert.strictEqual(sandbox.addDays('2026-09-13', 0), '2026-09-13');
  });
});
test('wname: 음수 UTC 오프셋 시간대에서도 요일이 하루 밀리지 않는다(2026-09-13은 일요일)', () => {
  withTZ('America/New_York', () => {
    assert.strictEqual(sandbox.wname('2026-09-13'), '일');
  });
});
test('fmtDate/shortDate/fmtDateFull: 음수 UTC 오프셋 시간대에서도 날짜/요일이 하루 밀리지 않는다', () => {
  withTZ('America/New_York', () => {
    assert.strictEqual(sandbox.fmtDate('2026-09-13'), '9월 13일 일요일');
    assert.strictEqual(sandbox.shortDate('2026-09-13'), '09.13 (일)');
    assert.strictEqual(sandbox.fmtDateFull('2026-09-13'), '2026년 9월 13일 (일)');
  });
});

/* ---------- recDates: 월간 day clamp ---------- */
test('recDates: 매월 31일 반복은 짧은 달에서 그 달의 마지막 날로 clamp된다', () => {
  const r = { freq: 'monthly', day: 31, startDate: '2026-01-01', endDate: null, weekend: 'none' };
  // vm 샌드박스 안에서 만들어진 배열은 host의 Array와 realm이 달라 deepStrictEqual이
  // (값은 같아도) 실패하므로, Array.from으로 host realm 배열로 정규화한다.
  const dates = Array.from(sandbox.recDates(r, '2026-01-01', '2026-04-30'));
  assert.deepStrictEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

/* ---------- recDates: 연간 2/29 시작은 평년에 3/1로 밀리지 않고 2/28로 clamp된다 ---------- */
test('recDates: 2/29 시작 연간 반복은 평년에 2/28로 clamp되고 3/1로 영구히 밀리지 않는다', () => {
  const r = { freq: 'yearly', startDate: '2024-02-29', endDate: null, weekend: 'none' };
  const dates = Array.from(sandbox.recDates(r, '2024-01-01', '2027-12-31'));
  assert.deepStrictEqual(dates, ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
});
test('recDates: 2/29 시작 연간 반복은 다음 윤년에 다시 2/29로 돌아온다', () => {
  const r = { freq: 'yearly', startDate: '2024-02-29', endDate: null, weekend: 'none' };
  const dates = Array.from(sandbox.recDates(r, '2024-01-01', '2028-12-31'));
  assert.strictEqual(dates[dates.length - 1], '2028-02-29', '2028년은 윤년이므로 다시 2/29가 나와야 함');
});
test('recDates: 윤년 아닌 날짜(예: 6/15)로 시작한 연간 반복은 매년 같은 날짜를 유지한다', () => {
  const r = { freq: 'yearly', startDate: '2026-06-15', endDate: null, weekend: 'none' };
  const dates = Array.from(sandbox.recDates(r, '2026-01-01', '2029-12-31'));
  assert.deepStrictEqual(dates, ['2026-06-15', '2027-06-15', '2028-06-15', '2029-06-15']);
});

/* ---------- recNthDate/recCountUntil: 주말 조정 무시 버그 (78d96a5) ---------- */
function nextSaturdayOnOrAfter(y, m, d) {
  const dt = new Date(y, m - 1, d);
  while (dt.getDay() !== 6) dt.setDate(dt.getDate() + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
test('recNthDate/recCountUntil: 주말 조정(later)이 있는 주간 반복의 횟수↔종료일 변환이 실제 생성 결과와 일치한다', () => {
  const sat = nextSaturdayOnOrAfter(2026, 1, 1);
  const base = { freq: 'weekly', day: null, startDate: sat, weekend: 'later' };
  const fifth = sandbox.recNthDate(base, 5);
  assert.ok(fifth, '5번째 날짜를 계산하지 못함');
  const generated = sandbox.recDates(
    { freq: 'weekly', day: null, startDate: sat, endDate: null, weekend: 'later' },
    sat, fifth
  );
  assert.strictEqual(generated.length, 5, '주말 조정 반영 시 실제 생성 개수는 5개여야 함');
  assert.strictEqual(sandbox.recCountUntil(base, fifth), 5, '종료일→횟수 역변환도 5로 일치해야 함');
});
test('recNthDate/recCountUntil: 주말 조정이 없는 경우는 영향받지 않는다', () => {
  const base = { freq: 'weekly', day: null, startDate: '2026-01-05', weekend: 'none' };
  const sixth = sandbox.recNthDate(base, 6);
  const generated = sandbox.recDates(
    { freq: 'weekly', day: null, startDate: '2026-01-05', endDate: null, weekend: 'none' },
    '2026-01-05', sixth
  );
  assert.strictEqual(generated.length, 6);
  assert.strictEqual(sandbox.recCountUntil(base, sixth), 6);
});

/* ---------- recDates: weekend 조정이 달/연도 경계를 넘어 앞당겨지는 회차 누락 버그 ---------- */
test('recDates: 매월 1일+earlier 반복에서 다음달 1일이 일요일이면 이번달 말일로 당겨진 회차가 이번달 조회에 나온다', () => {
  // 2026-02-01은 일요일이라 2026-01-30(금)으로 당겨짐 — 이 회차는 1월 조회에서 나와야 함
  const r = { freq: 'monthly', day: 1, startDate: '2025-01-01', endDate: null, weekend: 'earlier' };
  const jan = Array.from(sandbox.recDates(r, '2026-01-01', '2026-01-31'));
  assert.deepStrictEqual(jan, ['2026-01-01', '2026-01-30'], '1월 자체 회차와 2월분이 당겨진 회차가 모두 나와야 함');
  const feb = Array.from(sandbox.recDates(r, '2026-02-01', '2026-02-28'));
  assert.ok(!feb.includes('2026-01-30'), '당겨진 회차가 2월 조회에 중복으로 나오면 안 됨');
});
test('recDates: 매년 1/1+earlier 반복에서 1/1이 일요일이면 전년도 말일로 당겨진 회차가 전년도 조회에 나온다', () => {
  // 2027-01-01은 금요일이라 shift 없음 예시 대신, 실제로 일요일인 해를 찾아 검증
  // 2023-01-01은 일요일 -> 2022-12-30(금)으로 당겨짐
  const r = { freq: 'yearly', startDate: '2020-01-01', endDate: null, weekend: 'earlier' };
  const y2022 = Array.from(sandbox.recDates(r, '2022-01-01', '2022-12-31'));
  assert.ok(y2022.includes('2022-12-30'), '다음 해 1/1이 당겨진 회차가 전년도 조회에 나와야 함');
  const y2023 = Array.from(sandbox.recDates(r, '2023-01-01', '2023-12-31'));
  assert.ok(!y2023.includes('2022-12-30'), '당겨진 회차가 원래 해 조회에 중복으로 나오면 안 됨');
});

/* ---------- recDates: daily/weekly 스캔 시작점을 from 근처로 당기는 최적화의 회귀 테스트 ----------
 * (app-evolve cycle26 advance) recDates()의 daily/weekly 분기는 예전엔 항상 r.startDate부터
 * 하루/일주일씩 순회해 to까지 진행했다 — 오래전 시작된 반복거래일수록 매 호출 비용이 컸다.
 * 최적화 후엔 [from,to] 결과가 완전히 같아야 하며(behavior-preserving), 특히 weekend 조정으로
 * from 직전 날짜가 범위 안으로 당겨져 들어오는 경계 케이스를 놓치면 안 된다. */
test('recDates: 오래전 시작한 weekly 반복에서 from 직전 일요일이 later 조정으로 from(월요일)로 들어오면 빠지지 않는다', () => {
  // startDate(2020-01-05, 일요일)에서 정확히 7의 배수만큼 지난 2026-06-14도 일요일이라,
  // weekend:'later' 조정으로 2026-06-15(월)로 밀려 들어온다 — from을 바로 그 월요일로 잡는다.
  const r = { freq: 'weekly', startDate: '2020-01-05', endDate: null, weekend: 'later' };
  const dates = Array.from(sandbox.recDates(r, '2026-06-15', '2026-06-18'));
  assert.ok(dates.includes('2026-06-15'), 'from 직전 회차가 later 조정으로 from에 들어오는 경계 케이스가 스캔 시작점 최적화로 누락되면 안 됨');
});
test('recDates: 오래전 시작한 daily 반복에서 from 직전 날짜가 later 조정으로 from에 들어오면 빠지지 않는다', () => {
  // 2026-06-13(토)은 daily 후보이자 later 조정 대상 — 토요일은 +2일이라 2026-06-15(월)로 밀림.
  const r = { freq: 'daily', startDate: '2010-01-01', endDate: null, weekend: 'later' };
  const dates = Array.from(sandbox.recDates(r, '2026-06-15', '2026-06-16'));
  assert.ok(dates.includes('2026-06-15'), '토요일 후보가 later 조정(+2일)으로 from에 들어오는 경계 케이스가 누락되면 안 됨');
});
test('recDates: 오래전 시작한 daily/weekly 반복도 좁은 [from,to] 구간에서 매일 회차를 빠짐없이 반환한다', () => {
  const daily = { freq: 'daily', startDate: '2010-01-01', endDate: null, weekend: 'none' };
  assert.deepStrictEqual(
    Array.from(sandbox.recDates(daily, '2026-06-10', '2026-06-13')),
    ['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'],
  );
  const weekly = { freq: 'weekly', startDate: '2015-03-02', endDate: null, weekend: 'none' }; // 2015-03-02는 월요일
  assert.deepStrictEqual(
    Array.from(sandbox.recDates(weekly, '2026-06-01', '2026-06-30')),
    ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29'],
  );
});

/* ---------- num(): 음수 입력 처리 ---------- */
test('num(): 숫자가 아닌 문자(부호 포함)를 제거하고 파싱한다', () => {
  assert.strictEqual(sandbox.num({ value: '-100' }), 100);
  assert.strictEqual(sandbox.num({ value: '1,234' }), 1234);
});
test('num(): 값이 없거나 엘리먼트가 없으면 0을 반환한다', () => {
  assert.strictEqual(sandbox.num({ value: '' }), 0);
  assert.strictEqual(sandbox.num(null), 0);
});

/* ---------- catVar / doRenameCat: 카테고리 이름변경 시 '변동' 플래그 마이그레이션 (c38ee65) ---------- */
test('doRenameCat: 이름변경 시 catVar(변동 카테고리) 플래그가 새 이름으로 함께 이동한다', () => {
  sandbox.DB = { categories: { expense: ['식비'] }, catIcon: {}, catVar: {}, txns: [], recurrences: [] };
  sandbox.setCatVar('expense', '식비', true);
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.categories.expense[0], '외식비');
  assert.strictEqual(sandbox.isVarCat('expense', '외식비'), true, '새 이름에 변동 플래그가 붙어 있어야 함');
  assert.strictEqual(sandbox.isVarCat('expense', '식비'), false, '옛 이름의 플래그는 제거돼야 함');
});
test('doRenameCat: 고정(변동 아님) 카테고리는 이름변경 후에도 계속 고정이다', () => {
  sandbox.DB = { categories: { expense: ['교통비'] }, catIcon: {}, catVar: {}, txns: [], recurrences: [] };
  sandbox.catRenameDraft = { name: '대중교통', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.isVarCat('expense', '대중교통'), false);
});
test('doRenameCat: 연결된 반복거래의 category/memo도 함께 이동한다', () => {
  sandbox.DB = {
    categories: { expense: ['식비'] }, catIcon: {}, catVar: {}, txns: [],
    recurrences: [{ id: 1, type: 'expense', category: '식비', memo: '식비', active: true }],
  };
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.recurrences[0].category, '외식비');
  assert.strictEqual(sandbox.DB.recurrences[0].memo, '외식비');
});

/* ---------- activeRecsForAssets: 자산 삭제 시 연결 반복거래 비활성화 (125886a) ---------- */
test('activeRecsForAssets: 단일 id — 활성 상태이고 해당 자산을 참조하는 반복거래만 찾는다', () => {
  sandbox.DB = {
    recurrences: [
      { id: 1, active: true, fromAssetId: 'a1', toAssetId: null },
      { id: 2, active: false, fromAssetId: 'a1', toAssetId: null },
      { id: 3, active: true, fromAssetId: 'a2', toAssetId: null },
      { id: 4, active: true, fromAssetId: null, toAssetId: 'a1' },
    ],
  };
  const hit = sandbox.activeRecsForAssets('a1').map(r => r.id).sort();
  assert.deepStrictEqual(hit, [1, 4]);
});
test('activeRecsForAssets: Set을 넘기면 여러 자산을 한 번에 찾는다(대량 삭제 경로)', () => {
  sandbox.DB = {
    recurrences: [
      { id: 1, active: true, fromAssetId: 'a1', toAssetId: null },
      { id: 2, active: true, fromAssetId: 'a2', toAssetId: null },
      { id: 3, active: true, fromAssetId: 'a3', toAssetId: null },
    ],
  };
  const hit = sandbox.activeRecsForAssets(new Set(['a1', 'a3'])).map(r => r.id).sort();
  assert.deepStrictEqual(hit, [1, 3]);
});

/* ---------- commaQty: 자산 목록의 소수 보유수량이 반올림되던 버그 ---------- */
test('commaQty: 정수는 comma()와 동일하게 천단위 콤마만 붙는다', () => {
  assert.strictEqual(sandbox.commaQty(30), '30');
  assert.strictEqual(sandbox.commaQty(1250), '1,250');
});
test('commaQty: 소수는 반올림하지 않고 그대로 표시한다', () => {
  assert.strictEqual(sandbox.commaQty(1.5), '1.5');
  assert.strictEqual(sandbox.commaQty(6.8), '6.8');
});
test('commaQty: 값이 없으면 0으로 취급한다', () => {
  assert.strictEqual(sandbox.commaQty(0), '0');
  assert.strictEqual(sandbox.commaQty(null), '0');
});

/* ---------- budgetProgress: 카테고리별 예산 대비 지출 진행률 계산 ---------- */
test('budgetProgress: 예산 미설정(0)이면 진행률은 항상 0이고 초과가 아니다', () => {
  // vm 샌드박스에서 만들어진 객체는 host의 Object와 realm이 달라 deepStrictEqual이
  // 실패하므로(값은 같아도 프로토타입이 다름), 필드별로 비교한다.
  const a = sandbox.budgetProgress(50000, 0);
  assert.strictEqual(a.pct, 0); assert.strictEqual(a.barPct, 0); assert.strictEqual(a.over, false);
  const b = sandbox.budgetProgress(0, 0);
  assert.strictEqual(b.pct, 0); assert.strictEqual(b.barPct, 0); assert.strictEqual(b.over, false);
});
test('budgetProgress: 예산 안에서 쓴 경우 퍼센트와 바 길이가 그대로 반영된다', () => {
  const r = sandbox.budgetProgress(30000, 100000);
  assert.strictEqual(r.pct, 30);
  assert.strictEqual(r.barPct, 30);
  assert.strictEqual(r.over, false);
});
test('budgetProgress: 예산을 정확히 다 쓰면(100%) 아직 초과는 아니다', () => {
  const r = sandbox.budgetProgress(100000, 100000);
  assert.strictEqual(r.pct, 100);
  assert.strictEqual(r.barPct, 100);
  assert.strictEqual(r.over, false);
});
test('budgetProgress: 예산을 초과하면 over=true이고 바 길이는 100%를 넘지 않게 clamp된다', () => {
  const r = sandbox.budgetProgress(150000, 100000);
  assert.strictEqual(r.pct, 150, '표시용 퍼센트는 실제 초과분(150%)을 그대로 보여줘야 함');
  assert.strictEqual(r.barPct, 100, '바 자체는 100%를 넘어 그려지면 안 됨');
  assert.strictEqual(r.over, true);
});

/* ---------- totalBudgetSummary: 지출 분석의 '이번 달 예산' 요약 카드 집계 ---------- */
test('totalBudgetSummary: 예산을 하나도 설정하지 않았으면 budgetedTotal=0(집계할 게 없음)', () => {
  const rows = [{ c: '식비', v: 50000 }, { c: '교통', v: 20000 }];
  const r = sandbox.totalBudgetSummary(rows, {});
  assert.strictEqual(r.budgetedTotal, 0);
  assert.strictEqual(r.spentOnBudgeted, 0);
  assert.strictEqual(r.overCount, 0);
  assert.strictEqual(r.unsetCount, 2, '예산이 없으면 지출이 있는 두 카테고리 모두 미설정으로 집계돼야 함');
});
test('totalBudgetSummary: 예산이 설정된 카테고리만 합산하고, 미설정 카테고리는 unsetCount로만 센다', () => {
  const rows = [{ c: '식비', v: 50000 }, { c: '교통', v: 20000 }, { c: '취미', v: 10000 }];
  const r = sandbox.totalBudgetSummary(rows, { 식비: 100000, 교통: 30000 });
  assert.strictEqual(r.budgetedTotal, 130000, '예산이 설정된 식비+교통 한도만 합산');
  assert.strictEqual(r.spentOnBudgeted, 70000, '예산이 설정된 카테고리의 지출만 합산(취미 10000은 제외)');
  assert.strictEqual(r.overCount, 0);
  assert.strictEqual(r.unsetCount, 1, '취미만 예산 미설정');
});
test('totalBudgetSummary: 예산을 초과한 카테고리 수를 overCount로 센다', () => {
  const rows = [{ c: '식비', v: 150000 }, { c: '교통', v: 20000 }];
  const r = sandbox.totalBudgetSummary(rows, { 식비: 100000, 교통: 30000 });
  assert.strictEqual(r.budgetedTotal, 130000);
  assert.strictEqual(r.spentOnBudgeted, 170000);
  assert.strictEqual(r.overCount, 1, '식비만 예산을 초과함');
  assert.strictEqual(r.unsetCount, 0);
});
test('totalBudgetSummary: DB.budgets가 없어도(undefined) 터지지 않고 전부 미설정으로 처리한다', () => {
  const rows = [{ c: '식비', v: 50000 }];
  const r = sandbox.totalBudgetSummary(rows, undefined);
  assert.strictEqual(r.budgetedTotal, 0);
  assert.strictEqual(r.unsetCount, 1);
});

/* ---------- doRenameCat: 카테고리 이름변경 시 예산 한도도 함께 이동 ---------- */
test('doRenameCat: 지출 카테고리 이름변경 시 DB.budgets의 한도가 새 이름으로 이동한다', () => {
  sandbox.DB = { categories: { expense: ['식비'] }, catIcon: {}, catVar: {}, budgets: { 식비: 300000 }, txns: [], recurrences: [] };
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.budgets['외식비'], 300000);
  assert.strictEqual('식비' in sandbox.DB.budgets, false, '옛 이름의 예산 항목은 제거돼야 함');
});
test('doRenameCat: 예산이 설정되지 않은 카테고리를 이름변경해도 오류 없이 통과한다', () => {
  sandbox.DB = { categories: { expense: ['교통비'] }, catIcon: {}, catVar: {}, budgets: {}, txns: [], recurrences: [] };
  sandbox.catRenameDraft = { name: '대중교통', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(Object.keys(sandbox.DB.budgets).length, 0);
});

/* ---------- doDeleteCat: 카테고리 삭제 시 아이콘/변동/예산 정리 (동명 재생성 시 이전 설정이 남지 않도록) ---------- */
test('doDeleteCat: 삭제 시 catIcon/catVar/budgets 항목이 함께 제거된다', () => {
  sandbox.DB = {
    categories: { expense: ['커피', '식비'] },
    catIcon: { 'expense:커피': 'coffee' },
    catVar: { 'expense:커피': true },
    budgets: { 커피: 30000 },
    txns: [], recurrences: [],
  };
  sandbox.doDeleteCat('expense', 0);
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['식비']);
  assert.strictEqual('expense:커피' in sandbox.DB.catIcon, false);
  assert.strictEqual('expense:커피' in sandbox.DB.catVar, false);
  assert.strictEqual('커피' in sandbox.DB.budgets, false);
});
test('doDeleteCat: 같은 이름으로 다시 추가해도 지워진 카테고리의 이전 아이콘/변동/예산을 물려받지 않는다', () => {
  sandbox.DB = {
    categories: { expense: ['커피'] },
    catIcon: { 'expense:커피': 'coffee' },
    catVar: { 'expense:커피': true },
    budgets: { 커피: 30000 },
    txns: [], recurrences: [],
  };
  sandbox.doDeleteCat('expense', 0);
  sandbox.DB.categories.expense.push('커피'); // 사용자가 같은 이름으로 재생성
  assert.strictEqual('expense:커피' in sandbox.DB.catIcon, false);
  assert.strictEqual(sandbox.isVarCat('expense', '커피'), false);
  assert.strictEqual('커피' in sandbox.DB.budgets, false);
});
test('doDeleteCat: 수입/저축 카테고리는 budgets를 건드리지 않는다', () => {
  sandbox.DB = {
    categories: { income: ['용돈'] },
    catIcon: {}, catVar: {}, budgets: { 용돈: 100000 },
    txns: [], recurrences: [],
  };
  sandbox.doDeleteCat('income', 0);
  assert.strictEqual(sandbox.DB.budgets['용돈'], 100000, 'expense가 아닌 타입은 budgets 키 공간이 겹치지 않으므로 건드리면 안 됨');
});

/* ---------- ADJUST_CAT: '잔액 조정' 시스템 카테고리는 이름변경/삭제로부터 보호된다 ---------- */
test('doDeleteCat: 수입의 잔액 조정 카테고리는 삭제되지 않고 안내 토스트만 뜬다', () => {
  sandbox.DB = {
    categories: { income: ['급여', sandbox.ADJUST_CAT] },
    catIcon: {}, catVar: {}, budgets: {}, txns: [], recurrences: [],
  };
  sandbox.lastToast = null;
  sandbox.doDeleteCat('income', 1);
  assert.deepStrictEqual(sandbox.DB.categories.income, ['급여', sandbox.ADJUST_CAT], '카테고리 배열이 그대로 유지돼야 함');
  assert.ok(sandbox.lastToast, '안내 토스트가 떴어야 함');
});
test('doRenameCat: 수입의 잔액 조정 카테고리는 이름을 바꿀 수 없다', () => {
  sandbox.DB = {
    categories: { income: [sandbox.ADJUST_CAT] },
    catIcon: {}, catVar: {}, budgets: {}, txns: [], recurrences: [],
  };
  sandbox.catRenameDraft = { name: '정정', icon: '' };
  sandbox.lastToast = null;
  sandbox.doRenameCat('income', 0);
  assert.strictEqual(sandbox.DB.categories.income[0], sandbox.ADJUST_CAT, '이름이 바뀌면 안 됨');
  assert.ok(sandbox.lastToast, '안내 토스트가 떴어야 함');
});
test('doDeleteCat/doRenameCat: 같은 이름이어도 지출 카테고리라면(가정) 잔액 조정 가드가 적용되지 않는다', () => {
  // ADJUST_CAT은 income 전용 시스템 카테고리이므로, k!=='income'이면 이름이 같아도 평범한 카테고리로 취급돼야 함
  sandbox.DB = {
    categories: { expense: [sandbox.ADJUST_CAT, '기타'] },
    catIcon: {}, catVar: {}, budgets: {}, txns: [], recurrences: [],
  };
  sandbox.catRenameDraft = { name: '정정', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.categories.expense[0], '정정', '지출 카테고리는 이름 보호 대상이 아님');
});
test('doDeleteCat: 잔액 조정이 아닌 평범한 수입 카테고리는 그대로 삭제된다(가드 과잉 적용 아님)', () => {
  sandbox.DB = {
    categories: { income: ['급여', sandbox.ADJUST_CAT] },
    catIcon: {}, catVar: {}, budgets: {}, txns: [], recurrences: [],
  };
  sandbox.doDeleteCat('income', 0);
  assert.deepStrictEqual(sandbox.DB.categories.income, [sandbox.ADJUST_CAT]);
});

/* ---------- activeRecsForCat: 카테고리 삭제 시 연결된 활성 반복거래를 찾는다 (activeRecsForAssets와 동일 패턴) ---------- */
test('activeRecsForCat: 같은 타입+이름의 활성 반복거래를 찾아낸다', () => {
  sandbox.DB = {
    recurrences: [
      { id: 'r1', active: true, type: 'expense', category: '외식' },
      { id: 'r2', active: true, type: 'expense', category: '교통' },
    ],
  };
  const hit = sandbox.activeRecsForCat('expense', '외식');
  assert.deepStrictEqual(hit.map(r => r.id), ['r1']);
});
test('activeRecsForCat: 비활성(active:false) 반복거래는 제외한다', () => {
  sandbox.DB = {
    recurrences: [{ id: 'r1', active: false, type: 'expense', category: '외식' }],
  };
  assert.deepStrictEqual(sandbox.activeRecsForCat('expense', '외식'), []);
});
test('activeRecsForCat: 이름이 같아도 타입이 다르면 제외한다', () => {
  sandbox.DB = {
    recurrences: [{ id: 'r1', active: true, type: 'income', category: '외식' }],
  };
  assert.deepStrictEqual(sandbox.activeRecsForCat('expense', '외식'), []);
});
test('activeRecsForCat: 무관한 카테고리는 빈 배열을 반환한다', () => {
  sandbox.DB = {
    recurrences: [{ id: 'r1', active: true, type: 'expense', category: '교통' }],
  };
  assert.deepStrictEqual(sandbox.activeRecsForCat('expense', '외식'), []);
});

/* ---------- doDeleteCat: 연결된 활성 반복거래를 비활성화하고, undo로 카테고리+반복거래 모두 복원한다 ---------- */
test('doDeleteCat: 연결된 활성 반복거래를 비활성화하고, undo 콜백을 부르면 카테고리와 반복거래 상태를 모두 복원한다', () => {
  sandbox.DB = {
    categories: { expense: ['외식', '교통'] },
    catIcon: { 'expense:외식': 'food' },
    catVar: { 'expense:외식': true },
    budgets: { 외식: 50000 },
    txns: [], recurrences: [
      { id: 'r1', active: true, type: 'expense', category: '외식' },
      { id: 'r2', active: false, type: 'expense', category: '외식' }, // 이미 비활성 — 건드리면 안 됨
      { id: 'r3', active: true, type: 'expense', category: '교통' },  // 무관한 카테고리 — 건드리면 안 됨
    ],
  };
  sandbox.lastUndo = null;
  sandbox.doDeleteCat('expense', 0);
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['교통'], '카테고리가 삭제돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r1').active, false, '연결된 활성 반복거래가 비활성화돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r3').active, true, '무관한 카테고리의 반복거래는 건드리면 안 됨');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['외식', '교통'], '되돌리면 카테고리가 원래 위치로 복원돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r1').active, true, '되돌리면 반복거래도 다시 활성화돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r2').active, false, '원래부터 비활성이던 반복거래는 그대로 비활성 유지');
  assert.strictEqual(sandbox.DB.catIcon['expense:외식'], 'food', '아이콘도 복원돼야 함');
  assert.strictEqual(sandbox.isVarCat('expense', '외식'), true, '변동 카테고리 플래그도 복원돼야 함');
  assert.strictEqual(sandbox.DB.budgets['외식'], 50000, '예산 한도도 복원돼야 함');
});
test('doDeleteCat: 연결된 활성 반복거래가 없으면 undo해도 반복거래 배열은 그대로다', () => {
  sandbox.DB = {
    categories: { expense: ['교통'] },
    catIcon: {}, catVar: {}, budgets: {}, txns: [], recurrences: [],
  };
  sandbox.lastUndo = null;
  sandbox.doDeleteCat('expense', 0);
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['교통']);
  assert.deepStrictEqual(sandbox.DB.recurrences, []);
});

/* ---------- delOwner: 귀속 삭제도 delCat/delTx처럼 undo 가능해야 한다 (cycle28) ---------- */
test('delOwner: 사용 중인 자산이 없으면 확인 시트 후 삭제하고 undoToast로 되돌릴 수 있다', () => {
  sandbox.DB = { owners: ['나', '아내', '아이'], assets: [] };
  sandbox.lastUndo = null;
  sandbox.confirmSheetCalls = [];
  sandbox.delOwner(1);
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '바로 지우지 않고 확인 시트를 띄워야 함');
  assert.deepStrictEqual(sandbox.DB.owners, ['나', '아내', '아이'], '확인 전에는 배열이 그대로여야 함');
  sandbox.confirmSheetCalls[0].cb();
  assert.deepStrictEqual(sandbox.DB.owners, ['나', '아이'], '확인 후 해당 귀속이 삭제돼야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(sandbox.DB.owners, ['나', '아내', '아이'], '되돌리면 원래 위치로 복원돼야 함');
});
test('delOwner: 사용 중인 자산이 있으면 삭제하지 않고 안내 토스트만 띄운다', () => {
  sandbox.DB = { owners: ['나', '아내'], assets: [{ owner: '아내' }] };
  sandbox.lastUndo = null;
  sandbox.confirmSheetCalls = [];
  sandbox.delOwner(1);
  assert.strictEqual(sandbox.confirmSheetCalls.length, 0, '확인 시트를 띄우면 안 됨');
  assert.deepStrictEqual(sandbox.DB.owners, ['나', '아내']);
  assert.ok(sandbox.lastToast.includes('아내'));
});
test('delOwner: 마지막 남은 귀속 하나는 삭제할 수 없다', () => {
  sandbox.DB = { owners: ['나'], assets: [] };
  sandbox.lastUndo = null;
  sandbox.confirmSheetCalls = [];
  sandbox.delOwner(0);
  assert.strictEqual(sandbox.confirmSheetCalls.length, 0);
  assert.deepStrictEqual(sandbox.DB.owners, ['나']);
});

/* ---------- addCat: 중복 이름 추가 시 무반응 대신 안내 토스트 ---------- */
test('addCat: 이미 있는 카테고리명을 추가하면 토스트를 띄우고 배열/아이콘을 건드리지 않는다', () => {
  sandbox.DB = { categories: { expense: ['식비'] }, catIcon: { 'expense:식비': 'food' }, catVar: {}, txns: [], recurrences: [] };
  sandbox.catAddDraft = { name: '식비', icon: 'coffee' };
  sandbox.lastToast = null;
  sandbox.addCat('expense');
  assert.strictEqual(sandbox.lastToast, '이미 있는 카테고리예요');
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['식비'], '중복이면 배열에 추가되면 안 됨');
  assert.strictEqual(sandbox.DB.catIcon['expense:식비'], 'food', '중복 이름의 기존 아이콘이 덮어써지면 안 됨');
});
test('addCat: 새 이름은 정상적으로 추가되고 토스트가 뜨지 않는다', () => {
  sandbox.DB = { categories: { expense: ['식비'] }, catIcon: {}, catVar: {}, txns: [], recurrences: [] };
  sandbox.catAddDraft = { name: '교통비', icon: 'car' };
  sandbox.lastToast = null;
  sandbox.addCat('expense');
  assert.strictEqual(sandbox.lastToast, null);
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['식비', '교통비']);
  assert.strictEqual(sandbox.DB.catIcon['expense:교통비'], 'car');
});

/* ---------- migrate() 없이 곧장 쓰는 seed()/emptyDB() 직후 상태(catIcon/catVar/budgets 필드 자체가 없음)에서
 * addCat/doDeleteCat/doRenameCat/setCatVar를 호출해도 TypeError 없이 안전해야 한다.
 * load()가 첫 부팅/손상데이터 복구 분기에서 migrate() 호출 없이 곧장 save()하던 과거 버그(신규 게스트가
 * 새로고침 전에 카테고리를 만지면 그 자리에서 크래시) 재발 방지 — migrate() 호출 추가가 근본 수정,
 * 아래 네 함수의 방어 가드는 이중 안전망. */
test('addCat: DB.catIcon 필드가 아예 없어도(migrate 이전 상태) 예외 없이 카테고리를 추가한다', () => {
  sandbox.DB = { categories: { expense: ['식비'] }, txns: [], recurrences: [] };
  sandbox.catAddDraft = { name: '교통비', icon: 'car' };
  assert.doesNotThrow(() => sandbox.addCat('expense'));
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['식비', '교통비']);
  assert.strictEqual(sandbox.DB.catIcon['expense:교통비'], 'car');
});
test('doDeleteCat: DB.catIcon/catVar/budgets 필드가 아예 없어도(migrate 이전 상태) 예외 없이 삭제한다', () => {
  sandbox.DB = { categories: { expense: ['외식', '교통'] }, txns: [], recurrences: [] };
  assert.doesNotThrow(() => sandbox.doDeleteCat('expense', 0));
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['교통']);
});
test('doRenameCat: DB.catIcon/catVar/budgets 필드가 아예 없어도(migrate 이전 상태) 예외 없이 이름을 바꾼다', () => {
  sandbox.DB = { categories: { expense: ['식비'] }, txns: [], recurrences: [] };
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  assert.doesNotThrow(() => sandbox.doRenameCat('expense', 0));
  assert.strictEqual(sandbox.DB.categories.expense[0], '외식비');
});
test('setCatVar: DB.catVar 필드가 아예 없어도(migrate 이전 상태) 예외 없이 변동 플래그를 켠다', () => {
  sandbox.DB = {};
  assert.doesNotThrow(() => sandbox.setCatVar('expense', '식비', true));
  assert.strictEqual(sandbox.DB.catVar['expense:식비'], true);
});
test('migrate: seed()/emptyDB()가 만드는 형태(catIcon/catVar/budgets 필드 없음)에 돌리면 세 필드 모두 빈 객체로 채워진다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
  };
  sandbox.migrate();
  assert.strictEqual(Object.keys(sandbox.DB.catIcon).length, 0);
  assert.strictEqual(Object.keys(sandbox.DB.catVar).length, 0);
  assert.strictEqual(Object.keys(sandbox.DB.budgets).length, 0);
});
/* doResetAll()/afterCloudAuth()가 DB=emptyDB() 직후 migrate()를 빠뜨렸던 버그(전체초기화·게스트데이터 없는
 * 신규가입 시 '이체 확인'·'시세 자동 연동' 설정이 조용히 꺼진 채 남음) 재발 방지. emptyDB()는 catIcon/catVar/
 * budgets와 마찬가지로 confirmTransfers/autoRates/histSortAsc/bigMin 등 DB.settings 기본값을 채우지
 * 않고 migrate()가 채우는 역할이라, migrate()를 건너뛰면 이 값들이 undefined(=falsy)로 남는다. */
test('migrate: emptyDB() 직후(settings에 confirmTransfers/autoRates 등이 없는 상태)에 돌리면 모두 기본값 true로 채워진다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
  };
  sandbox.migrate();
  assert.strictEqual(sandbox.DB.settings.confirmTransfers, true);
  assert.strictEqual(sandbox.DB.settings.autoRates, true);
  assert.strictEqual(sandbox.DB.settings.histSortAsc, true);
  assert.strictEqual(sandbox.DB.settings.bigMin, 100000);
});
test('migrate: emptyDB()가 이미 정해둔 themeMode/assetSort/groupOrder는 migrate()가 덮어쓰지 않는다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'dark', includeScheduled: false, assetSort: 'name', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
  };
  sandbox.migrate();
  assert.strictEqual(sandbox.DB.settings.themeMode, 'dark');
  assert.strictEqual(sandbox.DB.settings.assetSort, 'name');
});

/* ---------- updateNwHistory/pruneNwHistory: 순자산 추이 일별 스냅샷 ---------- */
test('updateNwHistory: 새 날짜면 스냅샷을 추가한다', () => {
  const hist = sandbox.updateNwHistory([{ date: '2026-01-01', ta: 100, td: 10, nw: 90 }], '2026-01-02', 120, 10);
  assert.strictEqual(hist.length, 2);
  assert.strictEqual(hist[1].date, '2026-01-02');
  assert.strictEqual(hist[1].ta, 120);
  assert.strictEqual(hist[1].td, 10);
  assert.strictEqual(hist[1].nw, 110);
});
test('updateNwHistory: 같은 날짜에 다시 호출하면 새로 추가하지 않고 마지막 항목을 덮어쓴다', () => {
  const hist = sandbox.updateNwHistory([{ date: '2026-01-01', ta: 100, td: 10, nw: 90 }], '2026-01-01', 150, 10);
  assert.strictEqual(hist.length, 1, '같은 날짜는 새 항목이 아니라 갱신이어야 함');
  assert.strictEqual(hist[0].ta, 150);
  assert.strictEqual(hist[0].nw, 140);
});
test('updateNwHistory: 원본 배열을 변형하지 않는다(불변)', () => {
  const orig = [{ date: '2026-01-01', ta: 100, td: 10, nw: 90 }];
  sandbox.updateNwHistory(orig, '2026-01-02', 120, 10);
  assert.strictEqual(orig.length, 1, '입력 배열은 그대로 유지돼야 함');
});
test('pruneNwHistory: 120개 이하는 그대로 둔다', () => {
  const hist = Array.from({ length: 120 }, (_, i) => ({ date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, ta: i, td: 0, nw: i }));
  assert.strictEqual(sandbox.pruneNwHistory(hist).length, 120);
});
test('pruneNwHistory: 90일보다 오래된 기록은 월 1개로 압축한다', () => {
  // 2023-01-01부터 2024-01-01까지 일 단위(약 366개) — 최근 90일을 뺀 나머지는 달마다 하나로 줄어야 함
  const hist = [];
  let d = new Date('2023-01-01T00:00:00');
  const end = new Date('2024-01-01T00:00:00');
  while (d <= end) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    hist.push({ date: ds, ta: 0, td: 0, nw: 0 });
    d.setDate(d.getDate() + 1);
  }
  const pruned = sandbox.pruneNwHistory(hist);
  assert.ok(pruned.length < hist.length, '압축 후 개수가 줄어야 함');
  const last90Cutoff = sandbox.addDays(hist[hist.length - 1].date, -90);
  const recentCount = hist.filter(h => h.date > last90Cutoff).length;
  assert.strictEqual(pruned.filter(h => h.date > last90Cutoff).length, recentCount, '최근 90일 구간은 일 단위 그대로 보존돼야 함');
});
test('nwChartPath: 점이 2개 미만이면 빈 경로를 반환한다', () => {
  const r = sandbox.nwChartPath([{ nw: 100 }], 300, 80);
  assert.strictEqual(r.line, '');
  assert.strictEqual(r.area, '');
});
test('nwChartPath: 모든 값이 같으면(span=0) 0으로 나누지 않고 수평선을 그린다', () => {
  const { line } = sandbox.nwChartPath([{ nw: 100 }, { nw: 100 }, { nw: 100 }], 300, 80);
  assert.ok(!line.includes('NaN'), '값이 모두 같아도 NaN이 나오면 안 됨');
  assert.strictEqual(line, 'M0.0,80.0 L150.0,80.0 L300.0,80.0');
});
test('nwChartPath: 값이 오르면 마지막 y좌표가 첫 y좌표보다 위(작은 값)에 온다', () => {
  const { line } = sandbox.nwChartPath([{ nw: 0 }, { nw: 100 }], 300, 80);
  assert.strictEqual(line, 'M0.0,80.0 L300.0,0.0');
});

/* ---------- txnsToCSV: 거래 내역 CSV 내보내기 ---------- */
test('txnsToCSV: 빈 배열이면 BOM과 헤더만 있는 한 줄을 반환한다', () => {
  const csv = sandbox.txnsToCSV([], []);
  assert.strictEqual(csv, '﻿날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모');
});
test('txnsToCSV: 메모에 콤마가 있으면 필드 전체를 따옴표로 감싼다', () => {
  const csv = sandbox.txnsToCSV(
    [{ date: '2026-01-01', type: 'expense', category: '식비', amount: 1000, fromAssetId: null, toAssetId: null, memo: '김밥, 라면' }],
    []
  );
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[1], '2026-01-01,지출,식비,1000,,,"김밥, 라면"');
});
test('txnsToCSV: 메모에 큰따옴표가 있으면 두 배로 이스케이프하고 필드 전체를 따옴표로 감싼다', () => {
  const csv = sandbox.txnsToCSV(
    [{ date: '2026-01-01', type: 'expense', category: '기타', amount: 500, fromAssetId: null, toAssetId: null, memo: '"급함"' }],
    []
  );
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[1], '2026-01-01,지출,기타,500,,,"""급함"""');
});
test('txnsToCSV: 살아있는 자산은 assets 배열에서 이름을 찾고, 삭제된 자산은 *AssetName 스냅샷으로 대체한다', () => {
  const assets = [{ id: 'a1', name: '우리은행' }];
  const csv = sandbox.txnsToCSV(
    [{ date: '2026-01-02', type: 'transfer', category: '이체', amount: 50000, fromAssetId: 'a1', toAssetId: 'a_deleted', toAssetName: '옛 카카오뱅크', memo: '' }],
    assets
  );
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[1], '2026-01-02,이체,이체,50000,우리은행,옛 카카오뱅크,');
});
test('txnsToCSV: 날짜 오름차순으로 정렬한다', () => {
  const csv = sandbox.txnsToCSV(
    [
      { date: '2026-02-01', type: 'expense', category: '기타', amount: 1, fromAssetId: null, toAssetId: null, memo: '' },
      { date: '2026-01-01', type: 'expense', category: '기타', amount: 2, fromAssetId: null, toAssetId: null, memo: '' },
    ],
    []
  );
  const lines = csv.slice(1).split('\r\n');
  assert.ok(lines[1].startsWith('2026-01-01'));
  assert.ok(lines[2].startsWith('2026-02-01'));
});
test('txnsToCSV: 메모가 =,+,-,@ 로 시작하면 앞에 \'를 붙여 수식 인젝션을 막는다', () => {
  const csv = sandbox.txnsToCSV(
    [
      { date: '2026-01-01', type: 'expense', category: '기타', amount: 1, fromAssetId: null, toAssetId: null, memo: "=cmd|'/c calc'!A1" },
      { date: '2026-01-02', type: 'expense', category: '기타', amount: 1, fromAssetId: null, toAssetId: null, memo: '+1+1' },
      { date: '2026-01-03', type: 'expense', category: '기타', amount: 1, fromAssetId: null, toAssetId: null, memo: '@SUM(A1)' },
      { date: '2026-01-04', type: 'expense', category: '기타', amount: -500, fromAssetId: null, toAssetId: null, memo: '-2000원 환불' },
    ],
    []
  );
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[1], "2026-01-01,지출,기타,1,,,'=cmd|'/c calc'!A1");
  assert.strictEqual(lines[2], "2026-01-02,지출,기타,1,,,'+1+1");
  assert.strictEqual(lines[3], "2026-01-03,지출,기타,1,,,'@SUM(A1)");
  assert.strictEqual(lines[4], "2026-01-04,지출,기타,-500,,,'-2000원 환불");
});
test('txnsToCSV: 카테고리/자산명이 =,+,-,@ 로 시작해도 같은 방식으로 방어한다', () => {
  const assets = [{ id: 'a1', name: '=HYPERLINK("http://evil")' }];
  const csv = sandbox.txnsToCSV(
    [{ date: '2026-01-01', type: 'transfer', category: '=1+1', amount: 100, fromAssetId: 'a1', toAssetId: null, memo: '' }],
    assets
  );
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[1], `2026-01-01,이체,'=1+1,100,"'=HYPERLINK(""http://evil"")",,`);
});
test('txnsToCSV: 금액이 음수여도 필드 자체는 그대로 두고(guard 대상 아님) 텍스트 필드만 방어한다', () => {
  const csv = sandbox.txnsToCSV(
    [{ date: '2026-01-01', type: 'expense', category: '기타', amount: -1000, fromAssetId: null, toAssetId: null, memo: '' }],
    []
  );
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[1], '2026-01-01,지출,기타,-1000,,,');
});

/* ---------- matchTxnQuery: 거래 검색은 대소문자를 구분하지 않는다 ---------- */
test('matchTxnQuery: 빈 검색어는 항상 매칭된다', () => {
  const t = { memo: '', category: '식비', fromAssetId: null, toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, '', []), true);
});
test('matchTxnQuery: 메모가 대문자로 저장돼 있어도 소문자 검색어로 찾을 수 있다', () => {
  const t = { memo: 'Coffee Shop', category: '식비', fromAssetId: null, toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, 'coffee', []), true);
});
test('matchTxnQuery: 검색어가 대문자여도 소문자로 저장된 자산명을 찾을 수 있다', () => {
  const assets = [{ id: 'a1', name: 'kakaobank' }];
  const t = { memo: '', category: '이체', fromAssetId: 'a1', toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, 'KAKAOBANK', assets), true);
});
test('matchTxnQuery: 삭제된 자산은 *AssetName 스냅샷으로 대소문자 구분 없이 매칭된다', () => {
  const t = { memo: '', category: '이체', fromAssetId: 'gone', fromAssetName: 'OldBank', toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, 'oldbank', []), true);
});
test('matchTxnQuery: 메모/카테고리/자산명 어디에도 없으면 매칭되지 않는다', () => {
  const assets = [{ id: 'a1', name: '우리은행' }];
  const t = { memo: '점심', category: '식비', fromAssetId: 'a1', toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, 'xyz', assets), false);
});

/* ---------- esc: 저장형 XSS 방지 (asset/memo/category 등 사용자 입력값을 innerHTML에 넣기 전 이스케이프) ---------- */
test('esc: 스크립트 태그를 무력화한다', () => {
  assert.strictEqual(sandbox.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});
test('esc: 속성 컨텍스트를 깨는 큰따옴표/작은따옴표를 이스케이프한다', () => {
  assert.strictEqual(sandbox.esc(`"onmouseover="x`), '&quot;onmouseover=&quot;x');
  assert.strictEqual(sandbox.esc(`'onclick='x`), '&#39;onclick=&#39;x');
});
test('esc: 앰퍼샌드를 이스케이프한다', () => {
  assert.strictEqual(sandbox.esc('용돈 & 저축'), '용돈 &amp; 저축');
});
test('esc: 평범한 텍스트는 그대로 둔다', () => {
  assert.strictEqual(sandbox.esc('우리은행 통장'), '우리은행 통장');
});
test('esc: null/undefined는 빈 문자열로 처리한다', () => {
  assert.strictEqual(sandbox.esc(null), '');
  assert.strictEqual(sandbox.esc(undefined), '');
});

/* ---------- expenseBreakdownCard: 홈 화면 지출 분석 카드는 사용자가 지은 카테고리명을 이스케이프해야 한다 ---------- */
test('expenseBreakdownCard: 카테고리명에 HTML 특수문자가 있어도 이스케이프되어 렌더링을 깨지 않는다', () => {
  const html = sandbox.expenseBreakdownCard([{ cat: '외식&카페<script>', v: 10000 }], 10000);
  assert.ok(html.includes('외식&amp;카페&lt;script&gt;'), 'HTML이 이스케이프되어야 함');
  assert.ok(!html.includes('<script>'), '원본 태그가 그대로 남아있으면 안 됨');
});
test('expenseBreakdownCard: 평범한 카테고리명은 그대로 표시된다', () => {
  const html = sandbox.expenseBreakdownCard([{ cat: '식비', v: 5000 }], 5000);
  assert.ok(html.includes('식비'));
});

/* ---------- deleteTxnsUndo: 단일/대량 삭제 공용 되돌리기 인프라 (delAdjust도 여기 합류) ---------- */
test('deleteTxnsUndo: 지정한 id의 내역을 삭제하고, undo 콜백을 부르면 정확히 복원한다', () => {
  sandbox.TWi = -1;
  const adjust = { id: 'x1', adjust: true, amount: 1000 };
  const other = { id: 'x2', amount: 500 };
  sandbox.DB = { txns: [adjust, other] };
  sandbox.lastUndo = null;
  sandbox.deleteTxnsUndo(new Set(['x1']));
  assert.deepStrictEqual(sandbox.DB.txns, [other], '지정한 항목만 제거되어야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.txns.length, 2, '되돌리기를 부르면 삭제된 항목이 복원되어야 함');
  assert.ok(sandbox.DB.txns.some(t => t.id === 'x1'), '삭제됐던 조정 내역이 그대로 복원되어야 함');
});
test('deleteTxnsUndo: 튜토리얼 모드 중에는 twGuard가 막아서 실제로 삭제되지 않는다', () => {
  sandbox.TWi = 0;
  const t = { id: 'x1', adjust: true, amount: 1000 };
  sandbox.DB = { txns: [t] };
  sandbox.deleteTxnsUndo(new Set(['x1']));
  assert.strictEqual(sandbox.DB.txns.length, 1, '튜토리얼 중에는 삭제가 막혀야 함');
  sandbox.TWi = -1;
});

/* ---------- deleteRecsUndo: 반복 삭제(전체) 공용 되돌리기 인프라 (delRecConfirm/recApply 'all' scope) ---------- */
test('deleteRecsUndo: 지정한 id의 반복을 삭제하고, undo 콜백을 부르면 정확히 복원한다', () => {
  sandbox.TWi = -1;
  const rec = { id: 'r1', category: '식비', amount: 1000 };
  const other = { id: 'r2', category: '월세', amount: 500000 };
  sandbox.DB = { recurrences: [rec, other] };
  sandbox.lastUndo = null;
  sandbox.deleteRecsUndo(new Set(['r1']));
  assert.deepStrictEqual(sandbox.DB.recurrences, [other], '지정한 반복만 제거되어야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.recurrences.length, 2, '되돌리기를 부르면 삭제된 반복이 복원되어야 함');
  assert.ok(sandbox.DB.recurrences.some(r => r.id === 'r1'), '삭제됐던 반복이 그대로 복원되어야 함');
});
test('deleteRecsUndo: 튜토리얼 모드 중에는 twGuard가 막아서 실제로 삭제되지 않는다', () => {
  sandbox.TWi = 0;
  const rec = { id: 'r1', category: '식비', amount: 1000 };
  sandbox.DB = { recurrences: [rec] };
  sandbox.deleteRecsUndo(new Set(['r1']));
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '튜토리얼 중에는 삭제가 막혀야 함');
  sandbox.TWi = -1;
});

/* ---------- deleteAssetsUndo: 자산 삭제(단일/대량) 공용 되돌리기 인프라 (delAsset도 여기 합류) ---------- */
test('deleteAssetsUndo: 지정한 id의 자산을 삭제하고, undo 콜백을 부르면 정확히 복원한다', () => {
  sandbox.TWi = -1;
  const a1 = { id: 'a1', name: '통장1' };
  const a2 = { id: 'a2', name: '통장2' };
  sandbox.DB = { assets: [a1, a2], recurrences: [] };
  sandbox.lastUndo = null;
  sandbox.snapshotCalls = [];
  sandbox.deleteAssetsUndo(new Set(['a1']));
  assert.deepStrictEqual(sandbox.DB.assets, [a2], '지정한 자산만 제거되어야 함');
  assert.deepStrictEqual(sandbox.snapshotCalls, ['a1'], '삭제 전 이름 스냅샷을 남겨야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.assets.length, 2, '되돌리기를 부르면 삭제된 자산이 복원되어야 함');
  assert.ok(sandbox.DB.assets.some(a => a.id === 'a1'), '삭제됐던 자산이 그대로 복원되어야 함');
});
test('deleteAssetsUndo: 연결된 활성 반복거래를 비활성화하고, undo 콜백을 부르면 다시 활성화한다', () => {
  sandbox.TWi = -1;
  const a1 = { id: 'a1', name: '통장1' };
  const rec = { id: 'r1', active: true, fromAssetId: 'a1', toAssetId: null };
  sandbox.DB = { assets: [a1], recurrences: [rec] };
  sandbox.lastUndo = null;
  sandbox.snapshotCalls = [];
  sandbox.deleteAssetsUndo(new Set(['a1']));
  assert.strictEqual(rec.active, false, '연결된 반복거래는 비활성화되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(rec.active, true, '되돌리면 반복거래도 다시 활성화되어야 함');
});
test('deleteAssetsUndo: 튜토리얼 모드 중에는 twGuard가 막아서 실제로 삭제되지 않는다', () => {
  sandbox.TWi = 0;
  const a1 = { id: 'a1', name: '통장1' };
  sandbox.DB = { assets: [a1], recurrences: [] };
  sandbox.snapshotCalls = [];
  sandbox.deleteAssetsUndo(new Set(['a1']));
  assert.strictEqual(sandbox.DB.assets.length, 1, '튜토리얼 중에는 삭제가 막혀야 함');
  assert.deepStrictEqual(sandbox.snapshotCalls, [], '튜토리얼 중에는 스냅샷도 남기지 않아야 함');
  sandbox.TWi = -1;
});

/* ---------- recApply(mode='delete'): 부분 삭제(scope='one'/'future')도 twGuard+undo를 쓴다 ---------- */
test("recApply: scope='one' 삭제는 해당 날짜만 skip에 넣고, undo하면 skip 목록이 원래대로 돌아간다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', skip: ['2026-01-05'] };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastUndo = null;
  sandbox.recApply('r1', '2026-02-05', 'delete', 'one');
  assert.deepStrictEqual(r.skip, ['2026-01-05', '2026-02-05'], '지정한 날짜가 skip에 추가되어야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(r.skip, ['2026-01-05'], '되돌리면 skip이 원래 배열로 복원되어야 함');
});
test("recApply: scope='future' 삭제는 endDate를 자르고, undo하면 원래 endDate로 돌아간다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', skip: [], endDate: null };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastUndo = null;
  sandbox.recApply('r1', '2026-02-05', 'delete', 'future');
  assert.strictEqual(r.endDate, '2026-02-04', '이후 반복을 끊기 위해 하루 전날로 endDate가 설정되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.endDate, null, '되돌리면 endDate가 원래 값(null)으로 복원되어야 함');
});
test("recApply: 튜토리얼 모드 중에는 twGuard가 막아서 scope='one'/'future' 삭제도 실제로 반영되지 않는다", () => {
  sandbox.TWi = 0;
  const r1 = { id: 'r1', skip: [] };
  const r2 = { id: 'r2', skip: [], endDate: null };
  sandbox.DB = { recurrences: [r1, r2] };
  sandbox.recApply('r1', '2026-02-05', 'delete', 'one');
  sandbox.recApply('r2', '2026-02-05', 'delete', 'future');
  assert.deepStrictEqual(r1.skip, [], "튜토리얼 중에는 scope='one' 삭제가 막혀야 함");
  assert.strictEqual(r2.endDate, null, "튜토리얼 중에는 scope='future' 삭제가 막혀야 함");
  sandbox.TWi = -1;
});

/* ---------- recSave(): 반복 내역 부분 수정(one/future/all)도 twGuard+undo를 쓴다 ---------- */
test("recSave: scope='one' 수정은 r.edits[date]에 금액을 기록하고, undo하면 이전 상태로 돌아간다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, edits: { '2026-01-05': { amount: 999 } } };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'one' };
  sandbox.txAmtValue = '5,000';
  sandbox.lastUndo = null;
  sandbox.recSave();
  assert.strictEqual(r.edits['2026-02-05'].amount, 5000, '해당 날짜의 edits에 새 금액이 기록되어야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.edits['2026-02-05'], undefined, '이전에 없던 날짜였다면 되돌릴 때 edits에서 제거되어야 함');
  assert.deepStrictEqual(r.edits['2026-01-05'], { amount: 999 }, '다른 날짜의 기존 edits는 영향받지 않아야 함');
});
test("recSave: scope='one'에서 이미 있던 edits를 덮어쓴 경우, undo하면 이전 값으로 복원된다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, edits: { '2026-02-05': { amount: 111 } } };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'one' };
  sandbox.txAmtValue = '222';
  sandbox.recSave();
  assert.strictEqual(r.edits['2026-02-05'].amount, 222);
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(r.edits['2026-02-05'], { amount: 111 }, '되돌리면 덮어쓰기 전 값으로 복원되어야 함');
});
test("recSave: scope='future' 수정은 endDate를 끊고 새 분리 레코드를 추가하며, undo하면 원상복구된다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, endDate: null, skip: ['2026-01-01'], edits: { '2026-01-01': { amount: 1 } } };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-03-01', scope: 'future' };
  sandbox.txAmtValue = '7000';
  sandbox.recSave();
  assert.strictEqual(r.endDate, '2026-02-28', '기존 반복은 새 반복 시작일 하루 전에 끊겨야 함');
  assert.strictEqual(sandbox.DB.recurrences.length, 2, '이후 구간을 위한 새 반복 레코드가 추가되어야 함');
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  assert.strictEqual(newRec.amount, 7000);
  assert.strictEqual(newRec.startDate, '2026-03-01');
  assert.strictEqual(newRec.skip.length, 0, '새 레코드는 원본의 skip/edits를 물려받지 않아야 함');
  assert.strictEqual(Object.keys(newRec.edits).length, 0, '새 레코드는 원본의 edits를 물려받지 않아야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.endDate, null, '되돌리면 기존 반복의 endDate가 복원되어야 함');
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '되돌리면 새로 만든 분리 레코드가 제거되어야 함');
});
test("recSave: scope='future' 분할 시 원래 반복에 종료일이 있었다면 새 레코드도 그 종료일을 물려받아야 한다(무한 반복으로 바뀌면 안 됨)", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: '2026-12-05', count: 12, skip: [], edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-06-05', scope: 'future' };
  sandbox.txAmtValue = '2000';
  sandbox.recSave();
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  assert.strictEqual(r.endDate, '2026-06-04', '기존 반복은 새 반복 시작일 하루 전에 끊겨야 함');
  assert.strictEqual(r.count, 5, '잘린 원래 반복의 count도 새 endDate에 맞게 재계산되어야 함 (2026-01-05~2026-06-04 매월 5일 = 5회, 원래 count=12가 그대로 남아있으면 endDate와 어긋남)');
  assert.strictEqual(newRec.endDate, '2026-12-05', '새 레코드는 원래 종료일을 물려받아야 함 (전에는 null로 강제되어 무한 반복이 되는 버그가 있었음)');
  assert.strictEqual(newRec.count, 7, '종료일이 있으면 그에 맞는 count도 함께 계산되어야 함 (2026-06-05~2026-12-05 매월 5일 = 7회)');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.endDate, '2026-12-05', '되돌리면 원래 종료일로 복원되어야 함');
  assert.strictEqual(r.count, 12, '되돌리면 원래 count도 함께 복원되어야 함');
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '되돌리면 새로 만든 분리 레코드가 제거되어야 함');
});
test("recSave: scope='future' 분할 시 원래 반복이 무기한(endDate=null)이었다면 새 레코드도 무기한으로 유지된다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, skip: [], edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-06-05', scope: 'future' };
  sandbox.txAmtValue = '2000';
  sandbox.recSave();
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  assert.strictEqual(newRec.endDate, null, '원래 종료일이 없었다면 새 레코드도 무기한이어야 함');
  assert.strictEqual(newRec.count, null, '종료일이 없으면 count도 null이어야 함');
  sandbox.lastUndo.undoFn();
});
test("recSave: scope='all' 수정은 r.amount를 바꾸고, undo하면 이전 금액으로 돌아간다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000 };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'all' };
  sandbox.txAmtValue = '9999';
  sandbox.recSave();
  assert.strictEqual(r.amount, 9999);
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.amount, 1000, '되돌리면 원래 금액으로 복원되어야 함');
});
test('recSave: 튜토리얼 모드 중에는 twGuard가 막아서 실제로 수정되지 않는다', () => {
  sandbox.TWi = 0;
  const r = { id: 'r1', amount: 1000 };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'all' };
  sandbox.txAmtValue = '9999';
  sandbox.recSave();
  assert.strictEqual(r.amount, 1000, '튜토리얼 중에는 수정이 막혀야 함');
  assert.strictEqual(sandbox.window._recCtx.recId, 'r1', '튜토리얼 중에는 _recCtx도 지워지지 않아야 함(가드가 최상단에서 반환하므로)');
  sandbox.TWi = -1;
  sandbox.window._recCtx = null;
});

/* ---------- saveQuickAmount: 변동 카테고리 '실제 금액 입력'도 recSave(scope='one')와 동일하게 undo를 지원한다 ---------- */
test("saveQuickAmount: 실제 금액을 edits에 기록하고, undo하면 이전 상태(없었음)로 돌아간다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', category: '식비', memo: '식비', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.qAmtValue = '12,000';
  sandbox.lastUndo = null;
  sandbox.saveQuickAmount('r1', '2026-02-05');
  assert.strictEqual(r.edits['2026-02-05'].amount, 12000, '입력한 실제 금액이 edits에 기록되어야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함(recSave와 동일한 되돌리기 UX)');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.edits['2026-02-05'], undefined, '되돌리면 이전에 없던 항목은 edits에서 제거되어야 함');
});
test("saveQuickAmount: 이미 있던 edits를 덮어쓴 경우, undo하면 이전 값으로 복원된다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', category: '식비', memo: '식비', edits: { '2026-02-05': { amount: 111 } } };
  sandbox.DB = { recurrences: [r] };
  sandbox.qAmtValue = '222';
  sandbox.saveQuickAmount('r1', '2026-02-05');
  assert.strictEqual(r.edits['2026-02-05'].amount, 222);
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(r.edits['2026-02-05'], { amount: 111 }, '되돌리면 덮어쓰기 전 값으로 복원되어야 함');
});
test('saveQuickAmount: 금액을 비워두면 저장하지 않고 안내 토스트만 띄운다', () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', category: '식비', memo: '식비', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.qAmtValue = '';
  sandbox.lastUndo = null;
  sandbox.lastToast = null;
  sandbox.saveQuickAmount('r1', '2026-02-05');
  assert.strictEqual(sandbox.lastToast, '금액을 넣어주세요');
  assert.strictEqual(r.edits['2026-02-05'], undefined);
  assert.strictEqual(sandbox.lastUndo, null, '저장하지 않았으면 undo도 등록되면 안 됨');
});
test('saveQuickAmount: 튜토리얼 모드 중에는 twGuard가 막아서 실제로 저장되지 않는다', () => {
  sandbox.TWi = 0;
  const r = { id: 'r1', category: '식비', memo: '식비', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.qAmtValue = '9000';
  sandbox.lastUndo = null;
  sandbox.saveQuickAmount('r1', '2026-02-05');
  assert.strictEqual(r.edits['2026-02-05'], undefined, '튜토리얼 중에는 edits에 기록되면 안 됨');
  assert.strictEqual(sandbox.lastUndo, null);
  sandbox.TWi = -1;
});

/* ---------- storageOutcomeMsg: save()가 저장 성공/실패를 더 이상 숨기지 않는지 ---------- */
test('storageOutcomeMsg: 계속 정상 저장 중이면 토스트를 띄우지 않는다(매 save() 호출마다 스팸 방지)', () => {
  assert.strictEqual(sandbox.storageOutcomeMsg(true, true), null);
});
test('storageOutcomeMsg: 정상→실패로 전환되는 순간 실패 토스트를 띄운다', () => {
  const notice = sandbox.storageOutcomeMsg(false, true);
  assert.strictEqual(notice.kind, 'fail');
  assert.ok(notice.msg.includes('저장 실패'), '실패했다는 사실이 메시지에 명확히 드러나야 함(예전에는 무조건 성공 토스트만 떴음)');
});
test('storageOutcomeMsg: 이미 실패 상태로 알고 있으면 매 호출마다 또 띄우지 않는다', () => {
  assert.strictEqual(sandbox.storageOutcomeMsg(false, false), null);
});
test('storageOutcomeMsg: 실패→정상으로 회복되면 회복 토스트를 띄운다', () => {
  const notice = sandbox.storageOutcomeMsg(true, false);
  assert.strictEqual(notice.kind, 'ok');
});

/* ---------- restoreBackup: JSON 백업 복원의 스키마 검증 + 실패 시 롤백 ---------- */
test('restoreBackup: assets/txns가 배열이 아니면 DB를 건드리지 않고 예외를 던진다', () => {
  const orig = { assets: [{ id: 'a1' }], txns: [], categories: {}, catIcon: {}, catVar: {}, budgets: {}, owners: [], recurrences: [] };
  sandbox.DB = orig;
  assert.throws(() => sandbox.restoreBackup({ assets: 'not-an-array', txns: [] }));
  assert.strictEqual(sandbox.DB, orig, 'assets가 배열이 아니면 DB가 그대로 유지되어야 함');
  assert.throws(() => sandbox.restoreBackup({ assets: [], txns: {} }));
  assert.strictEqual(sandbox.DB, orig, 'txns가 배열이 아니면 DB가 그대로 유지되어야 함');
  assert.throws(() => sandbox.restoreBackup(null));
  assert.strictEqual(sandbox.DB, orig, 'obj 자체가 없으면 DB가 그대로 유지되어야 함');
});
test('restoreBackup: 정상 백업이면 DB를 교체하고 migrate()로 마이그레이션한 뒤, 교체 전 스냅샷을 반환한다', () => {
  sandbox.DB = { assets: [{ id: 'old' }], txns: [], categories: { expense: ['옛카테고리'] }, catIcon: {}, catVar: {}, budgets: {}, owners: ['나'], recurrences: [] };
  const backup = { assets: [{ id: 'new1' }, { id: 'new2' }], txns: [{ id: 't1' }] };
  const prev = sandbox.restoreBackup(backup);
  assert.strictEqual(sandbox.DB.assets.length, 2, 'DB가 백업 내용으로 교체되어야 함');
  assert.ok(sandbox.DB.assets.some(a => a.id === 'new1'));
  assert.ok(Array.isArray(sandbox.DB.categories.expense) && sandbox.DB.categories.expense.length, 'migrate()가 실행되어 카테고리 기본값이 채워져야 함');
  assert.strictEqual(prev.assets[0].id, 'old', '되돌리기용으로 교체 전 DB 스냅샷이 반환되어야 함');
  assert.strictEqual(prev.categories.expense[0], '옛카테고리');
});
test('restoreBackup: migrate() 도중 손상된 데이터로 throw하면 DB가 오염되지 않고 교체 전 상태로 롤백된다', () => {
  // restoreBackup 내부의 prev 스냅샷은 vm 샌드박스의 JSON으로 만들어져 host의 orig와는
  // 참조가 다르므로(realm이 다름), 참조 비교(strictEqual) 대신 필드값으로 롤백 여부를 확인한다.
  sandbox.DB = { assets: [{ id: 'safe' }], txns: [], categories: { expense: ['원래'] }, catIcon: {}, catVar: {}, budgets: {}, owners: ['나'], recurrences: [] };
  const realMigrate = sandbox.migrate;
  sandbox.migrate = () => { throw new Error('손상된 백업 데이터'); };
  try {
    assert.throws(() => sandbox.restoreBackup({ assets: [{ id: 'corrupt' }], txns: [] }), /손상된 백업 데이터/);
    assert.strictEqual(sandbox.DB.assets.length, 1, 'migrate()가 실패하면 DB가 교체 전 상태로 롤백되어야 함');
    assert.strictEqual(sandbox.DB.assets[0].id, 'safe', '손상된 백업의 내용(corrupt)이 아니라 원래 데이터로 남아있어야 함');
    assert.strictEqual(sandbox.DB.categories.expense[0], '원래');
  } finally {
    sandbox.migrate = realMigrate;
  }
});

/* ---------- spendByCategory: 지출 분석 카테고리별 합계는 잔액 조정(기본 제외)을 빼야 한다 ---------- */
test('spendByCategory: 수지에 포함되지 않은 잔액 조정 지출은 카테고리 합계에서 제외된다', () => {
  sandbox.DB = {
    txns: [
      { date: '2026-06-05', type: 'expense', category: '식비', amount: 10000 },
      { date: '2026-06-10', type: 'expense', category: '잔액 조정', amount: 5000, adjust: true, inSurplus: false },
    ],
    recurrences: [],
  };
  const rows = sandbox.spendByCategory(2026, 6);
  assert.deepStrictEqual(Array.from(rows).map(r => ({ c: r.c, v: r.v })), [{ c: '식비', v: 10000 }]);
});
test('spendByCategory: 수지 포함으로 켜둔 잔액 조정 지출은 그대로 합산된다', () => {
  sandbox.DB = {
    txns: [
      { date: '2026-06-05', type: 'expense', category: '식비', amount: 10000 },
      { date: '2026-06-10', type: 'expense', category: '잔액 조정', amount: 5000, adjust: true, inSurplus: true },
    ],
    recurrences: [],
  };
  const rows = sandbox.spendByCategory(2026, 6);
  const byCat = Object.fromEntries(Array.from(rows).map(r => [r.c, r.v]));
  assert.strictEqual(byCat['잔액 조정'], 5000);
});
test('spendByCategory: 수입/저축 등 지출이 아닌 거래는 집계하지 않는다', () => {
  sandbox.DB = {
    txns: [{ date: '2026-06-05', type: 'income', category: '급여', amount: 3000000 }],
    recurrences: [],
  };
  assert.deepStrictEqual(Array.from(sandbox.spendByCategory(2026, 6)), []);
});
test('spendByCategory: 이번 달에 쓴 게 없어도 예산이 설정된 카테고리는 v:0으로 계속 나타난다 (예산 관리 화면에서 사라지지 않아야 함)', () => {
  sandbox.DB = {
    txns: [{ date: '2026-06-05', type: 'expense', category: '식비', amount: 10000 }],
    recurrences: [],
    budgets: { 식비: 300000, 여행: 500000 },
  };
  const byCat = Object.fromEntries(Array.from(sandbox.spendByCategory(2026, 6)).map(r => [r.c, r.v]));
  assert.strictEqual(byCat['식비'], 10000, '실제 지출이 있는 예산 카테고리는 기존처럼 실제 합계가 나와야 함');
  assert.strictEqual(byCat['여행'], 0, '이번 달 지출이 0원이라도 예산이 설정돼 있으면 행이 사라지면 안 됨');
});
test('spendByCategory: 예산이 없는 카테고리는 지출이 없으면 여전히 목록에 나타나지 않는다', () => {
  sandbox.DB = {
    txns: [],
    recurrences: [],
    budgets: { 식비: 300000 },
  };
  const rows = Array.from(sandbox.spendByCategory(2026, 6));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].c, '식비');
});
test('spendByCategory: DB.budgets가 없어도(undefined) 터지지 않는다', () => {
  sandbox.DB = {
    txns: [{ date: '2026-06-05', type: 'expense', category: '식비', amount: 10000 }],
    recurrences: [],
  };
  assert.doesNotThrow(() => sandbox.spendByCategory(2026, 6));
});

/* ---------- histSumTotals: 전체내역 검색 합계 카드도 monthStats2()와 같은 규칙으로 잔액 조정을 뺀다 ---------- */
test('histSumTotals: 수지에 포함되지 않은 잔액 조정은 실제/예정 합계 어느 쪽에서도 제외된다', () => {
  const actual = [
    { type: 'expense', amount: 10000 },
    { type: 'expense', amount: 5000, adjust: true, inSurplus: false },
  ];
  const sched = [
    { type: 'income', amount: 3000 },
    { type: 'income', amount: 7000, adjust: true, inSurplus: false },
  ];
  const { a, sc } = sandbox.histSumTotals(actual, sched);
  assert.strictEqual(a.expense, 10000);
  assert.strictEqual(sc.income, 3000);
});
test('histSumTotals: 수지 포함으로 켜둔 잔액 조정은 그대로 합산된다', () => {
  const actual = [{ type: 'income', amount: 5000, adjust: true, inSurplus: true }];
  const { a } = sandbox.histSumTotals(actual, []);
  assert.strictEqual(a.income, 5000);
});
test('histSumTotals: 잔액 조정이 없으면 평범하게 타입별로 합산된다', () => {
  const actual = [{ type: 'expense', amount: 1000 }, { type: 'expense', amount: 2000 }, { type: 'saving', amount: 500 }];
  const { a } = sandbox.histSumTotals(actual, []);
  assert.strictEqual(a.expense, 3000);
  assert.strictEqual(a.saving, 500);
});

/* ---------- dayTypeTotals: 달력 하루 칸 합계도 monthStats2()와 같은 규칙으로 잔액 조정을 뺀다 ---------- */
test('dayTypeTotals: 수지에 포함되지 않은 잔액 조정은 그 날짜 칸 합계에서 제외된다', () => {
  const tx = [
    { type: 'expense', amount: 10000 },
    { type: 'expense', amount: 5000, adjust: true, inSurplus: false },
  ];
  const { ex } = sandbox.dayTypeTotals(tx);
  assert.strictEqual(ex, 10000);
});
test('dayTypeTotals: 수지 포함으로 켜둔 잔액 조정은 그대로 합산된다', () => {
  const tx = [{ type: 'income', amount: 5000, adjust: true, inSurplus: true }];
  const { inn } = sandbox.dayTypeTotals(tx);
  assert.strictEqual(inn, 5000);
});
test('dayTypeTotals: 잔액 조정이 없으면 평범하게 타입별로 합산된다', () => {
  const tx = [
    { type: 'income', amount: 1000 },
    { type: 'expense', amount: 2000 },
    { type: 'saving', amount: 500 },
    { type: 'transfer', amount: 999 },
  ];
  const { inn, ex, sv } = sandbox.dayTypeTotals(tx);
  assert.strictEqual(inn, 1000);
  assert.strictEqual(ex, 2000);
  assert.strictEqual(sv, 500);
});

/* ---------- upcomingOutflows/monthOutflows: 잔액 조정은 실제 나갈 돈이 아니므로 제외돼야 한다 ---------- */
test('upcomingOutflows: 수지에 포함되지 않은 잔액 조정 지출은 다가오는 큰 지출 목록에서 제외된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: {},
    txns: [{ id: 't1', type: 'expense', date: '2026-06-16', amount: 500000, adjust: true, inSurplus: false }],
    recurrences: [],
  };
  assert.strictEqual(sandbox.upcomingOutflows(45).length, 0);
});
test('upcomingOutflows: 같은 금액이어도 잔액 조정이 아닌 일반 지출은 그대로 잡힌다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: {},
    txns: [{ id: 't1', type: 'expense', date: '2026-06-16', amount: 500000 }],
    recurrences: [],
  };
  assert.strictEqual(sandbox.upcomingOutflows(45).length, 1);
});
test('upcomingOutflows: 수지 포함으로 켜둔 잔액 조정은 그대로 포함된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: {},
    txns: [{ id: 't1', type: 'expense', date: '2026-06-16', amount: 500000, adjust: true, inSurplus: true }],
    recurrences: [],
  };
  assert.strictEqual(sandbox.upcomingOutflows(45).length, 1);
});
test('monthOutflows: 수지에 포함되지 않은 잔액 조정은 이번 달 나갈 돈 목록/합계에서 제외된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: {},
    txns: [
      { id: 't1', type: 'expense', date: '2026-06-10', amount: 500000, adjust: true, inSurplus: false },
      { id: 't2', type: 'expense', date: '2026-06-12', amount: 30000 },
    ],
    recurrences: [],
  };
  const { list, total } = sandbox.monthOutflows(2026, 6);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(total, 30000);
});
test('monthOutflows: 잔액 조정이 없으면 지출/저축이 평범하게 합산된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: {},
    txns: [
      { id: 't1', type: 'expense', date: '2026-06-10', amount: 30000 },
      { id: 't2', type: 'saving', date: '2026-06-12', amount: 100000 },
      { id: 't3', type: 'income', date: '2026-06-12', amount: 999999 },
    ],
    recurrences: [],
  };
  const { list, total } = sandbox.monthOutflows(2026, 6);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(total, 130000);
});

/* ---------- pendingTransferCount: 반복거래로 만들어지는 미확인 이체도 세어야 한다 ---------- */
function pendingRec(overrides) {
  return Object.assign({
    id: 'r1', active: true, type: 'transfer', category: '이체', memo: '적금이체',
    amount: 100000, fromAssetId: 'a1', toAssetId: 'a2', fromAssetName: '통장', toAssetName: '적금',
    freq: 'monthly', day: 15, startDate: '2026-06-15', endDate: null, weekend: 'none',
    autoConfirm: false, confirmedDates: [],
  }, overrides);
}
test('pendingTransferCount: 반복거래로 생성된 미확인 이체(오늘 도래)도 카운트에 잡힌다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [], recurrences: [pendingRec()] };
  assert.strictEqual(sandbox.pendingTransferCount(), 1);
});
test('pendingTransferCount: 이미 확인 처리된(confirmedDates 포함) 회차는 카운트에서 빠진다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [], recurrences: [pendingRec({ confirmedDates: ['2026-06-15'] })] };
  assert.strictEqual(sandbox.pendingTransferCount(), 0);
});
test('pendingTransferCount: autoConfirm이 꺼져 있지 않은(자동확인) 반복이면 카운트되지 않는다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [], recurrences: [pendingRec({ autoConfirm: true })] };
  assert.strictEqual(sandbox.pendingTransferCount(), 0);
});
test('pendingTransferCount: 일반 미확인 이체(DB.txns)와 반복 미확인 이체를 합쳐서 센다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: { confirmTransfers: true },
    txns: [{ id: 't1', type: 'transfer', date: '2026-06-10', confirmed: false, amount: 5000 }],
    recurrences: [pendingRec()],
  };
  assert.strictEqual(sandbox.pendingTransferCount(), 2);
});

/* ---------- toggleConfirmTransfers: 이체 확인 끄기 시 일반 이체뿐 아니라 반복 이체의 미확인 회차도 세야 한다 ---------- */
test('toggleConfirmTransfers: 반복 이체만 미확인(도래)이어도 끄기 전 확인 시트가 뜬다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [], recurrences: [pendingRec()] };
  sandbox.toggleConfirmTransfers();
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1);
  assert.ok(sandbox.confirmSheetCalls[0].msg.includes('1건'));
  // 확인 시트가 뜬 시점엔 아직 꺼지지 않아야 한다(사용자가 콜백을 실행해야 실제로 꺼짐)
  assert.strictEqual(sandbox.DB.settings.confirmTransfers, true);
});
test('toggleConfirmTransfers: 확인 시트에서 "끄기"를 누르면 반복 이체의 도래 회차가 confirmedDates에 기록되고 설정이 꺼진다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  const rec = pendingRec();
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [], recurrences: [rec] };
  sandbox.toggleConfirmTransfers();
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(sandbox.DB.settings.confirmTransfers, false);
  assert.deepStrictEqual(rec.confirmedDates, ['2026-06-15']);
});
test('toggleConfirmTransfers: 일반 이체와 반복 이체가 섞여 있으면 둘 다 완료 처리된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  const rec = pendingRec();
  const oneOff = { id: 't1', type: 'transfer', date: '2026-06-10', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [oneOff], recurrences: [rec] };
  sandbox.toggleConfirmTransfers();
  assert.ok(sandbox.confirmSheetCalls[0].msg.includes('2건'));
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(oneOff.confirmed, true);
  assert.deepStrictEqual(rec.confirmedDates, ['2026-06-15']);
});
test('toggleConfirmTransfers: 미확인 이체가 전혀 없으면 확인 시트 없이 바로 꺼진다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [], recurrences: [] };
  sandbox.toggleConfirmTransfers();
  assert.strictEqual(sandbox.confirmSheetCalls.length, 0);
  assert.strictEqual(sandbox.DB.settings.confirmTransfers, false);
});

/* ---------- saveAsset: 동명·동종 자산 중복 차단이 수정(edit)에도 적용되는지 (자산 등록 때만 막고 수정 때는 안 막던 버그) ---------- */
test('saveAsset: 다른 자산을 이미 있는 자산과 같은 이름·종류로 수정하면 차단된다', () => {
  sandbox.DB = { assets: [{ id: 'a1', name: '비상금', type: 'cash', baseAmount: 1000 }, { id: 'a2', name: '여행자금', type: 'cash', baseAmount: 500 }], rates: { stocks: {} } };
  sandbox.asDraft = { id: 'a2', name: '비상금', type: 'cash', includeInTotal: true };
  sandbox.lastToast = null;
  sandbox.saveAsset(true);
  assert.ok(sandbox.lastToast, '중복 경고 토스트가 떴어야 함');
  assert.strictEqual(sandbox.DB.assets[1].name, '여행자금', '중복이면 원래 자산이 덮어써지면 안 됨');
});
test('saveAsset: 새로 등록할 자산이 기존 자산과 이름·종류가 같으면 여전히 차단된다', () => {
  sandbox.DB = { assets: [{ id: 'a1', name: '비상금', type: 'cash', baseAmount: 1000 }], rates: { stocks: {} } };
  sandbox.asDraft = { name: '비상금', type: 'cash', includeInTotal: true };
  sandbox.lastToast = null;
  sandbox.saveAsset(false);
  assert.ok(sandbox.lastToast, '중복 경고 토스트가 떴어야 함');
  assert.strictEqual(sandbox.DB.assets.length, 1, '중복이면 새 자산이 추가되면 안 됨');
});

/* ---------- isCloudConflict: pushCloud()가 충돌로 빠지는 조건의 순수 판정 로직 ---------- */
test('isCloudConflict: 원격 updated_at이 마지막 동기화 시점보다 최신이면 충돌이다', () => {
  assert.strictEqual(sandbox.isCloudConflict('2026-06-15T10:00:00.000Z', '2026-06-15T09:00:00.000Z'), true);
});
test('isCloudConflict: 원격 updated_at이 마지막 동기화 시점과 같으면 충돌이 아니다', () => {
  assert.strictEqual(sandbox.isCloudConflict('2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z'), false);
});
test('isCloudConflict: 원격 updated_at이 더 오래됐으면 충돌이 아니다', () => {
  assert.strictEqual(sandbox.isCloudConflict('2026-06-15T08:00:00.000Z', '2026-06-15T09:00:00.000Z'), false);
});
test('isCloudConflict: 마지막 동기화 기록이 없으면(첫 push) 충돌로 보지 않는다', () => {
  assert.strictEqual(sandbox.isCloudConflict('2026-06-15T09:00:00.000Z', null), false);
});
test('isCloudConflict: 원격에 데이터가 아직 없으면(updated_at 없음) 충돌이 아니다', () => {
  assert.strictEqual(sandbox.isCloudConflict(null, '2026-06-15T09:00:00.000Z'), false);
});

/* ---------- localHasUnsyncedChanges: afterCloudAuth()가 부팅 시 로컬을 조용히 덮어쓸지 판단하는 순수 로직 ---------- */
test('localHasUnsyncedChanges: 마지막 저장이 마지막 동기화보다 나중이면 미동기화 변경이 있다', () => {
  assert.strictEqual(sandbox.localHasUnsyncedChanges(2000, 1000), true);
});
test('localHasUnsyncedChanges: 마지막 저장이 마지막 동기화보다 먼저(또는 같음)면 미동기화 변경이 없다', () => {
  assert.strictEqual(sandbox.localHasUnsyncedChanges(1000, 2000), false);
  assert.strictEqual(sandbox.localHasUnsyncedChanges(1000, 1000), false);
});
test('localHasUnsyncedChanges: 동기화 기록 자체가 없으면(이 기기에서 한 번도 동기화 못한 채 로컬 저장만 있음) 미동기화로 본다', () => {
  assert.strictEqual(sandbox.localHasUnsyncedChanges(1000, null), true);
});
test('localHasUnsyncedChanges: 로컬 저장 기록 자체가 없으면(최초 부팅 등) 미동기화 변경이 없다', () => {
  assert.strictEqual(sandbox.localHasUnsyncedChanges(null, null), false);
  assert.strictEqual(sandbox.localHasUnsyncedChanges(null, 1000), false);
});

/* ---------- renderCurrent: 전역 에러 바운더리 ---------- */
function resetErrBanner() {
  sandbox.errBannerEl._html = '';
  sandbox.errBannerEl.classList.list = [];
  sandbox.lastError = null;
}
test('renderCurrent: 정상 렌더러는 그대로 실행되고 에러 배너는 뜨지 않는다', () => {
  resetErrBanner();
  let rendered = false;
  sandbox.ST = { tab: 'home' };
  sandbox.renderers = { home: () => { rendered = true; } };
  sandbox.renderCurrent();
  assert.strictEqual(rendered, true, '정상 렌더러가 호출되지 않음');
  assert.strictEqual(sandbox.errBannerEl.classList.contains('show'), false);
  assert.strictEqual(sandbox.lastError, null);
});
test('renderCurrent: 렌더러가 예외를 던지면 화면이 멈추지 않고(예외가 밖으로 새지 않고) 에러 배너가 뜬다', () => {
  resetErrBanner();
  sandbox.ST = { tab: 'home' };
  sandbox.renderers = { home: () => { throw new Error('강제 렌더 실패'); } };
  assert.doesNotThrow(() => sandbox.renderCurrent());
  assert.strictEqual(sandbox.errBannerEl.classList.contains('show'), true, '에러 배너의 show 클래스가 붙지 않음');
  assert.ok(sandbox.errBannerEl.innerHTML.length > 0, '에러 배너 내용이 채워지지 않음');
  assert.ok(sandbox.lastError, 'lastError가 기록되지 않음');
  assert.strictEqual(sandbox.lastError.message, '강제 렌더 실패');
  assert.strictEqual(sandbox.lastError.kind, 'renderCurrent');
});
test('renderCurrent: 예외 이후 재렌더가 성공하면 에러 배너가 다시 사라진다', () => {
  resetErrBanner();
  sandbox.ST = { tab: 'home' };
  sandbox.renderers = { home: () => { throw new Error('일시적 실패'); } };
  sandbox.renderCurrent();
  assert.strictEqual(sandbox.errBannerEl.classList.contains('show'), true);
  sandbox.renderers = { home: () => {} };
  sandbox.renderCurrent();
  assert.strictEqual(sandbox.errBannerEl.classList.contains('show'), false, '재렌더 성공 후에도 에러 배너가 남아있음');
});
test('rowKeydown: Enter를 누르면 preventDefault 후 콜백을 부른다', () => {
  let called = 0, prevented = false;
  sandbox.rowKeydown({ key: 'Enter', preventDefault: () => { prevented = true; } }, () => { called++; });
  assert.strictEqual(called, 1);
  assert.strictEqual(prevented, true);
});
test('rowKeydown: 스페이스를 누르면 preventDefault 후 콜백을 부른다', () => {
  let called = 0, prevented = false;
  sandbox.rowKeydown({ key: ' ', preventDefault: () => { prevented = true; } }, () => { called++; });
  assert.strictEqual(called, 1);
  assert.strictEqual(prevented, true);
});
test('rowKeydown: 다른 키는 무시하고 콜백을 부르지 않는다', () => {
  let called = 0, prevented = false;
  sandbox.rowKeydown({ key: 'Tab', preventDefault: () => { prevented = true; } }, () => { called++; });
  assert.strictEqual(called, 0);
  assert.strictEqual(prevented, false);
});
/* ---------- saveTx: 반복 매월 '말일(last)' 선택이 clampDay에 의해 1일로 잘못 바뀌던 버그 ----------
 * saveRec()은 `d.freq==='monthly'&&d.day!=='last'`로 clampDay를 건너뛰지만, saveTx()의
 * "내역 입력 화면에서 반복 켜고 바로 저장" 경로는 이 가드 없이 무조건 clampDay(d)를 불러
 * d.day='last'를 숫자가 아니라는 이유로 1로 덮어썼다(잘못된 "1일로 맞췄어요" 토스트까지 뜸). */
test("saveTx: 반복 매월 '말일' 선택으로 저장하면 day가 1로 잘못 clamp되지 않고 'last'로 유지된다", () => {
  sandbox.TWi = -1;
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '월세', memo: '',
    amount: 500000, fromAssetId: 'a1', toAssetId: null,
    repeat: true, freq: 'monthly', day: 'last', endDate: null, count: null,
  };
  sandbox.toastCalls = [];
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '반복 항목이 하나 생성되어야 함');
  assert.strictEqual(sandbox.DB.recurrences[0].day, 'last', "day가 'last'로 유지되어야 함(1로 잘못 clamp되면 안 됨)");
  assert.ok(!sandbox.toastCalls.includes('1일로 맞췄어요'), "'말일' 선택 시 1일로 맞췄다는 잘못된 안내가 뜨면 안 됨");
});
test('saveTx: 반복 매월 숫자 day가 31 초과면 여전히 31로 clamp된다(정상 케이스는 회귀 없음)', () => {
  sandbox.TWi = -1;
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '월세', memo: '',
    amount: 100000, fromAssetId: 'a1', toAssetId: null,
    repeat: true, freq: 'monthly', day: 45, endDate: null, count: null,
  };
  sandbox.toastCalls = [];
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.recurrences[0].day, 31);
  assert.ok(sandbox.toastCalls.includes('31일로 맞췄어요'), '31일 초과는 여전히 31로 clamp된다는 안내가 떠야 함');
});

/* ---------- balancesUpTo: 단일 슬롯 캐시를 다중 슬롯(Map)으로 바꾼 회귀 테스트 ----------
 * 예전 _balCache={key,map} 구조는 슬롯이 하나뿐이라 renderPlan() 한 번의 렌더 안에서
 * 서로 다른 날짜(startBal/이전달 말일/다음달 말일 등)로 balanceAt을 번갈아 부르면 매번
 * 이전 결과를 버리고 RANGE_FROM부터 전체 이력을 재스캔했다. Map 기반으로 바꾼 뒤에는
 * 날짜별로 독립적으로 캐시되어야 하므로, allTxns 호출 횟수를 세어 그걸 직접 확인한다. */
test('balancesUpTo: 서로 다른 두 날짜를 번갈아 호출해도 각각 한 번만 계산되고 이후엔 캐시에서 반환된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', type: 'cash', baseAmount: 0 }],
    txns: [{ date: '2026-01-10', type: 'expense', category: '식비', amount: 1000, fromAssetId: 'a1' }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  const origAllTxns = sandbox.allTxns;
  let calls = 0;
  sandbox.allTxns = (...args) => { calls++; return origAllTxns(...args); };
  try {
    assert.strictEqual(sandbox.balanceAt('a1', '2026-06-01'), -1000);
    assert.strictEqual(sandbox.balanceAt('a1', '2026-06-30'), -1000);
    assert.strictEqual(calls, 2, '서로 다른 두 날짜는 각각 한 번씩 재계산되어야 함');
    sandbox.balancesUpTo('2026-06-01');
    sandbox.balancesUpTo('2026-06-30');
    assert.strictEqual(calls, 2, '이미 계산한 두 날짜를 다시 불러도 캐시에서 반환되어야 함(단일 슬롯 캐시였다면 서로를 밀어내 여기서 2번 더 불렸을 것)');
  } finally {
    sandbox.allTxns = origAllTxns;
  }
});
test('balancesUpTo: invalidateBalances 없이도 _balCache를 비우면 다음 호출은 다시 계산된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', type: 'cash', baseAmount: 0 }],
    txns: [{ date: '2026-01-10', type: 'expense', category: '식비', amount: 1000, fromAssetId: 'a1' }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  assert.strictEqual(sandbox.balanceAt('a1', '2026-06-01'), -1000);
  sandbox.DB.txns.push({ date: '2026-02-01', type: 'expense', category: '식비', amount: 500, fromAssetId: 'a1' });
  assert.strictEqual(sandbox.balanceAt('a1', '2026-06-01'), -1000, '캐시를 비우지 않으면 DB가 바뀌어도 이전 값이 그대로 나와야 함(캐시가 실제로 동작 중임을 확인)');
  sandbox._balCache.clear();
  assert.strictEqual(sandbox.balanceAt('a1', '2026-06-01'), -1500, '캐시를 비운 뒤에는 새 거래가 반영되어야 함');
});

/* ---------- expandRec/_recCache: 반복거래 확장 결과 캐시의 회귀 테스트 (app-evolve cycle26 advance) ----------
 * balancesUpTo()의 _balCache와 같은 규칙으로 expandRec()에도 [from,to] 키의 Map 캐시를 추가했다.
 * DB.recurrences 순회 횟수를 직접 세어 같은 구간을 다시 부르면 재계산 없이 캐시에서 반환되는지,
 * 캐시를 비우면(=invalidateBalances 호출과 같은 계약) 새 반복거래가 반영되는지 확인한다. */
test('expandRec: 같은 [from,to]를 다시 불러도 DB.recurrences를 다시 순회하지 않고 캐시에서 반환된다', () => {
  sandbox._recCache.clear();
  sandbox.DB = {
    recurrences: [{ id: 'r1', active: true, freq: 'daily', startDate: '2026-01-01', endDate: null, weekend: 'none', type: 'expense', category: '식비', memo: '', amount: 1000, skip: [], edits: {} }],
  };
  let scans = 0;
  const origForEach = Array.prototype.forEach;
  // DB.recurrences.forEach 호출 횟수만 세면 되므로, 배열 자체를 감싸지 않고 스파이 배열로 교체한다.
  sandbox.DB.recurrences.forEach = (...args) => { scans++; return origForEach.apply(sandbox.DB.recurrences, args); };
  const a = sandbox.expandRec('2026-06-01', '2026-06-05');
  const b = sandbox.expandRec('2026-06-01', '2026-06-05');
  assert.strictEqual(scans, 1, '같은 구간을 두 번 불러도 DB.recurrences 순회는 한 번만 일어나야 함');
  assert.strictEqual(a, b, '캐시된 동일 결과(같은 배열 레퍼런스)를 반환해야 함');
  assert.strictEqual(a.length, 5);
});
test('expandRec: _recCache를 비우면 새로 추가된 반복거래가 다음 호출부터 반영된다', () => {
  sandbox._recCache.clear();
  sandbox.DB = {
    recurrences: [{ id: 'r1', active: true, freq: 'daily', startDate: '2026-01-01', endDate: null, weekend: 'none', type: 'expense', category: '식비', memo: '', amount: 1000, skip: [], edits: {} }],
  };
  assert.strictEqual(sandbox.expandRec('2026-06-01', '2026-06-01').length, 1, '캐시를 비우지 않으면 DB가 바뀌어도 이전 값이 그대로 나와야 함(캐시가 실제로 동작 중임을 확인)');
  sandbox.DB.recurrences.push({ id: 'r2', active: true, freq: 'daily', startDate: '2026-01-01', endDate: null, weekend: 'none', type: 'expense', category: '교통', memo: '', amount: 500, skip: [], edits: {} });
  assert.strictEqual(sandbox.expandRec('2026-06-01', '2026-06-01').length, 1, '캐시를 비우지 않으면 새 반복거래가 반영되면 안 됨(캐시 동작 확인)');
  sandbox._recCache.clear();
  assert.strictEqual(sandbox.expandRec('2026-06-01', '2026-06-01').length, 2, '캐시를 비운 뒤에는 새 반복거래가 반영되어야 함');
});

/* ---------- updateBalanceAdjust: 자산 수정 화면에서 채워진 잔액 캐시가 조정 내역
 * 재계산에 그대로 남아 엉뚱한 조정 금액을 만드는 버그의 회귀 테스트.
 * openAssetSheet()는 편집 진입 시 balanceAt(id,TODAY)를 미리 호출해 _balCache를 채워두는데,
 * 예전 updateBalanceAdjust()는 기존 조정 내역을 DB.txns에서 잠시 빼고 balanceAt을 다시 불러도
 * invalidateBalances()를 안 불러 그 캐시를 그대로 돌려받았다 — 그래서 "뺀 조정 내역"이 여전히
 * 잔액에 포함된 채로 새 조정 금액이 계산됐다(사용자가 입력한 금액과 실제 표시 잔액이 어긋남). */
test('updateBalanceAdjust: 편집 화면 진입 시 채워진 잔액 캐시가 있어도 기존 조정 내역을 뺀 값으로 새 조정 금액을 계산한다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  const asset = { id: 'a1', type: 'cash', baseAmount: 4000 };
  sandbox.DB = {
    settings: {},
    assets: [asset],
    txns: [{ id: 'adj1', date: '2026-06-01', type: 'income', category: sandbox.ADJUST_CAT, memo: '재등록 잔액 조정', amount: 1000, fromAssetId: null, toAssetId: 'a1', adjust: true, adjustAsset: 'a1' }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  // openAssetSheet()가 편집 진입 시 미리 채워두는 캐시를 흉내냄(기존 조정 내역 +1000 포함 → 5000).
  assert.strictEqual(sandbox.balanceAt('a1', sandbox.TODAY), 5000);
  const origInvalidate = sandbox.invalidateBalances;
  sandbox.invalidateBalances = () => sandbox._balCache.clear();
  try {
    sandbox.updateBalanceAdjust(asset, 6000); // 사용자가 표시 잔액을 6000으로 수정
  } finally {
    sandbox.invalidateBalances = origInvalidate;
  }
  const adj = sandbox.DB.txns.find((t) => t.adjust && t.adjustAsset === 'a1');
  assert.strictEqual(adj.amount, 2000, '기준값 4000 + 새 조정 2000 = 6000이어야 함(캐시가 남아있으면 1000으로 잘못 계산됨)');
  assert.strictEqual(adj.type, 'income');
});

/* ---------- isMarketValued/openAssetPicker: fx·금·주식을 일반 거래의 통장으로 선택하면
 * 순자산이 조용히 어긋나던 구조적 버그(app-evolve cycle27 advance)의 회귀 테스트.
 * assetEval()은 fx/gold/stock 세 타입만 원장(DB.txns)과 무관하게 qty×시세로 평가하는데,
 * saveTx()/saveRec()는 fromAssetId/toAssetId를 저장만 할 뿐 fxAmount/goldDon/stockQty를
 * 갱신하지 않는다. 그런데 openAssetPicker()는 이체/지출/수입 입력 화면(txOpenAsset/recOpenAsset)
 * 에서 이 세 타입도 다른 통장과 동일하게 선택 목록에 올렸다 — cashOnly 필터는 만기이체 picker
 * 한 곳에만 있었다. excludeMarketValued 옵션을 추가해 거래 입력 경로에서 이 세 타입을 제외한다. ---------- */
test('isMarketValued: fx/gold/stock만 참, 그 외 타입은 거짓', () => {
  assert.strictEqual(sandbox.isMarketValued({ type: 'fx' }), true);
  assert.strictEqual(sandbox.isMarketValued({ type: 'gold' }), true);
  assert.strictEqual(sandbox.isMarketValued({ type: 'stock' }), true);
  assert.strictEqual(sandbox.isMarketValued({ type: 'cash' }), false);
  assert.strictEqual(sandbox.isMarketValued({ type: 'savings' }), false);
  assert.strictEqual(sandbox.isMarketValued({ type: 'realestate' }), false);
  assert.strictEqual(sandbox.isMarketValued({ type: 'debt' }), false);
});
function setupAssetPickerDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: { groupOrder: ['cash', 'savings', 'fx', 'gold', 'stock'] },
    assets: [
      { id: 'a_cash', name: '지갑', type: 'cash', owner: '나', baseAmount: 10000, includeInTotal: true },
      { id: 'a_sav', name: '적금', type: 'savings', owner: '나', baseAmount: 5000, includeInTotal: true },
      { id: 'a_usd', name: '달러', type: 'fx', owner: '나', currency: 'USD', fxAmount: 100, includeInTotal: true },
      { id: 'a_gold', name: '금', type: 'gold', owner: '나', goldDon: 1, includeInTotal: true },
      { id: 'a_samsung', name: '삼성전자', type: 'stock', owner: '나', stockCode: 'a005930', stockQty: 10, includeInTotal: true },
    ],
    txns: [],
    recurrences: [],
    rates: { fx: { USD: 1300 }, goldPerG: 90000, stocks: { a005930: 70000 } },
  };
  sandbox._balCache.clear();
}
test('openAssetPicker: excludeMarketValued 옵션을 켜면 이체/지출/수입 입력 화면(txOpenAsset/recOpenAsset)에서 fx/gold/stock 자산이 목록에서 빠진다', () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  sandbox.openAssetPicker({ excludeMarketValued: true, onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(html.includes('data-val="a_cash"'), '현금 자산은 그대로 있어야 함');
  assert.ok(html.includes('data-val="a_sav"'), '저축 자산은 그대로 있어야 함');
  assert.ok(!html.includes('data-val="a_usd"'), '외화 자산은 제외돼야 함');
  assert.ok(!html.includes('data-val="a_gold"'), '금 자산은 제외돼야 함');
  assert.ok(!html.includes('data-val="a_samsung"'), '주식 자산은 제외돼야 함');
});
test('openAssetPicker: 옵션 없이 부르는 기존 호출부는 회귀 없이 fx/gold/stock도 그대로 보인다', () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  sandbox.openAssetPicker({ onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(html.includes('data-val="a_usd"'));
  assert.ok(html.includes('data-val="a_gold"'));
  assert.ok(html.includes('data-val="a_samsung"'));
});
test('openAssetPicker: cashOnly(만기이체 picker)는 excludeMarketValued 없이도 기존처럼 현금성 자산만 남긴다', () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  sandbox.openAssetPicker({ cashOnly: true, onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(html.includes('data-val="a_cash"'));
  assert.ok(html.includes('data-val="a_sav"'));
  assert.ok(!html.includes('data-val="a_usd"'));
  assert.ok(!html.includes('data-val="a_gold"'));
  assert.ok(!html.includes('data-val="a_samsung"'));
});

/* ---------- detectStaleMarketValuedTxns: excludeMarketValued(cycle27) 적용 이전에 이미
   저장된 fx/gold/stock 오용 이체·지출·수입·저축 기록 탐지 ---------- */
function setupStaleMvDB() {
  sandbox.DB = {
    settings: { dismissedStaleMvIds: [] },
    assets: [
      { id: 'a_cash', name: '주거래통장', type: 'cash', owner: '나' },
      { id: 'a_usd', name: '달러', type: 'fx', owner: '나', currency: 'USD' },
      { id: 'a_gold', name: '금', type: 'gold', owner: '나' },
      { id: 'a_stock', name: '삼성전자', type: 'stock', owner: '나' },
    ],
    txns: [],
    recurrences: [],
  };
}
test('detectStaleMarketValuedTxns: 정상 거래(현금↔현금)만 있으면 빈 배열을 반환한다', () => {
  setupStaleMvDB();
  sandbox.DB.txns.push({ id: 't1', type: 'transfer', date: '2026-01-05', amount: 1000, fromAssetId: 'a_cash', toAssetId: 'a_cash' });
  const out = Array.from(sandbox.detectStaleMarketValuedTxns(sandbox.DB));
  assert.deepStrictEqual(out, []);
});
test('detectStaleMarketValuedTxns: transfer/expense/income/saving 각 타입에서 market-valued 자산을 걸러낸다', () => {
  setupStaleMvDB();
  sandbox.DB.txns.push(
    { id: 't_transfer', type: 'transfer', date: '2026-01-05', amount: 1000, fromAssetId: 'a_cash', toAssetId: 'a_usd' },
    { id: 't_expense', type: 'expense', date: '2026-01-06', amount: 2000, fromAssetId: 'a_gold', toAssetId: null },
    { id: 't_income', type: 'income', date: '2026-01-07', amount: 3000, fromAssetId: null, toAssetId: 'a_stock' },
  );
  sandbox.DB.recurrences.push(
    { id: 'r_saving', type: 'saving', startDate: '2026-01-08', amount: 4000, fromAssetId: 'a_cash', toAssetId: 'a_usd' },
  );
  const out = Array.from(sandbox.detectStaleMarketValuedTxns(sandbox.DB));
  const keys = out.map((o) => o.key).sort();
  assert.deepStrictEqual(keys, ['rec:r_saving:to', 'tx:t_expense:from', 'tx:t_income:to', 'tx:t_transfer:to'].sort());
  const transferHit = out.find((o) => o.key === 'tx:t_transfer:to');
  assert.strictEqual(transferHit.assetName, '달러');
  assert.strictEqual(transferHit.amount, 1000);
});
test('detectStaleMarketValuedTxns: dismissedStaleMvIds에 이미 있는 key는 결과에서 빠진다', () => {
  setupStaleMvDB();
  sandbox.DB.txns.push({ id: 't1', type: 'transfer', date: '2026-01-05', amount: 1000, fromAssetId: 'a_cash', toAssetId: 'a_usd' });
  sandbox.DB.settings.dismissedStaleMvIds = ['tx:t1:to'];
  const out = Array.from(sandbox.detectStaleMarketValuedTxns(sandbox.DB));
  assert.deepStrictEqual(out, []);
});
test('detectStaleMarketValuedTxns: 삭제되어 존재하지 않는 assetId를 참조해도 크래시 없이 건너뛴다', () => {
  setupStaleMvDB();
  sandbox.DB.txns.push({ id: 't1', type: 'transfer', date: '2026-01-05', amount: 1000, fromAssetId: 'a_cash', toAssetId: 'a_deleted' });
  const out = Array.from(sandbox.detectStaleMarketValuedTxns(sandbox.DB));
  assert.deepStrictEqual(out, []);
});

/* ---------- 실행 ---------- */
let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
  }
}
console.log(`\n${pass}/${tests.length} passed`);
if (fail > 0) {
  console.error(`${fail} test(s) failed`);
  process.exit(1);
}
