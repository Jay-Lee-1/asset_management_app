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
  'recNthDate', 'recCountUntil', 'isVarCat', 'setCatVar', 'activeRecsForAssets',
  'num', 'doRenameCat', 'doDeleteCat', 'budgetProgress', 'totalBudgetSummary', 'addCat',
  'updateNwHistory', 'pruneNwHistory', 'nwChartPath', 'txnsToCSV', 'esc',
  'twActive', 'twGuard', 'deleteTxnsUndo', 'deleteRecsUndo', 'deleteAssetsUndo',
];
const CONSTS = ['catKey', 'comma', 'commaQty'];

const extracted = FUNCTIONS.map(extractFunction).join('\n') + '\n' + CONSTS.map(extractConst).join('\n');

// doRenameCat()은 DB 조작 외에 UI 함수도 몇 개 부르므로($, toast, save, renderCurrent,
// openCatManage) 여기선 아무 일도 안 하는 스텁으로 채운다 — 우리가 검증하려는 건
// DB.catVar/DB.catIcon 마이그레이션 로직이지, 화면 갱신이 아니다.
// snapshotAssetName은 balanceAt/TODAY 등 잔액 계산 체인 전체를 끌고 오므로(이 테스트의
// 대상이 아님) 실제 소스 대신, 어떤 id로 호출됐는지만 기록하는 스텁으로 대체한다 —
// doRenameCat의 UI 스텁($, toast 등)과 같은 이유.
const sandbox = {
  DB: null,
  catRenameDraft: null,
  catAddDraft: null,
  lastToast: null,
  lastUndo: null,
  snapshotCalls: null,
  TWi: -1,
  $: () => null,
  toast: (msg) => { sandbox.lastToast = msg; },
  save: () => {},
  renderCurrent: () => {},
  openCatManage: () => {},
  undoToast: (msg, undoFn) => { sandbox.lastUndo = { msg, undoFn }; },
  snapshotAssetName: (id) => { sandbox.snapshotCalls.push(id); },
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
