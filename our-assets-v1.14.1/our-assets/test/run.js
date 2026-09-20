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
  let start = src.indexOf(marker);
  if (start === -1) throw new Error(`extractFunction: "${name}" 함수를 index.html에서 찾지 못함`);
  // pbkdf2Hash처럼 `async function name(`으로 선언된 경우 "function name(" 앞의 "async "도
  // 함께 가져와야 한다 — 안 그러면 추출된 소스에 await만 남고 async가 빠져 vm에서
  // "await is only valid in async functions" SyntaxError가 난다.
  const ASYNC_PREFIX = 'async ';
  if (start >= ASYNC_PREFIX.length && src.slice(start - ASYNC_PREFIX.length, start) === ASYNC_PREFIX) {
    start -= ASYNC_PREFIX.length;
  }
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

// _histCache처럼 재대입(_histCache={key,list})되는 모듈 스코프 캐시는 const가 아니라
// let으로 선언돼 있어 extractConst의 "const " 마커로는 못 찾는다 — 같은 이유(realm에 안 붙음)로
// "let "만 떼서 평범한 대입문으로 바꾼다.
function extractLet(name) {
  const marker = `let ${name}=`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`extractLet: "${name}" 선언을 index.html에서 찾지 못함`);
  const end = src.indexOf(';', start);
  if (end === -1) throw new Error(`extractLet: "${name}" 선언에 종료 ";"가 없음`);
  return src.slice(start + 'let '.length, end + 1);
}

// 테스트 대상 + 그 대상이 내부에서 호출하는 순수 함수들.
const FUNCTIONS = [
  'lastDay', 'addDays', 'shiftWeekend', 'recDates', 'addMonthsStr', 'addMonths',
  'recNthDate', 'recCountUntil', 'truncateRecEnd', 'recalcEndCond', 'isVarCat', 'setCatVar', 'activeRecsForAssets', 'activeRecsForCat',
  'num', 'doRenameCat', 'doDeleteCat', 'budgetProgress', 'totalBudgetSummary', 'budgetKey', 'budgetForMonth', 'setBudgetFrom', 'addCat',
  'updateNwHistory', 'pruneNwHistory', 'nwChartPath', 'txnsToCSV', 'esc', 'matchTxnQuery',
  'parseCSV', 'unguardCsv', 'csvDateValid', 'csvRowToImportTxn', 'csvDedupeKey', 'buildImportPreview',
  'twActive', 'twGuard', 'deleteTxnsUndo', 'deleteRecsUndo', 'deleteAssetsUndo',
  'recApply', 'recSave', 'saveQuickAmount', 'migrate', 'restoreBackup', 'storageOutcomeMsg', 'shouldWarnUnpersisted',
  'sanitizeAmount', 'sanitizeBackup',
  'saveRec', 'recHistFieldsChanged', 'splitRecOverrides', 'splitRecurrenceAt', 'recSaveScopeConfirm', 'recSaveScopeApply',
  'monthStartStr', 'monthEndStr', 'expandRec', 'allTxns', 'txnsByDateInRange', 'spendByCategory', 'histSumTotals',
  'dayTypeTotals', 'isPending', 'isDuePending', 'pendingTransferCount', 'expenseBreakdownCard',
  'bigMin', 'upcomingOutflows', 'monthOutflows', 'syncAssetInputs', 'asOpenType', 'asToggleNeg', 'openAssetSheet', 'saveAsset', 'groupItems', 'clampRecurringToMaturity', 'isCloudConflict', 'decidePushOutcome', 'fmtAmt',
  'wname', 'fmtDate', 'shortDate', 'fmtDateFull', 'localHasUnsyncedChanges',
  'recordError', 'showErrBanner', 'hideErrBanner', 'renderCurrent', 'rowKeydown',
  'clampDay', 'saveTx', 'assetBase', 'balancesUpTo', 'balanceAt',
  'addBalanceAdjust', 'updateBalanceAdjust', 'toggleConfirmTransfers',
  'assetEval', 'assetBalance', 'schHorizon', 'ym', 'openAssetPicker', 'delOwner', 'doMaturity', 'firstCash',
  'detectStaleMarketValuedTxns', 'delBudget',
  'hasFutureTxns', 'emptyAssets', 'tidySnoozed', 'snoozeTidy', 'emptyAssetCards',
  'rateUnknown', 'filteredHist', 'histInvalidate',
  'genSalt', 'pbkdf2Hash', 'assetNm', 'confirmRecTransfer', 'postponeRecTransfer', 'openConfirmTransfer',
  'foreignSaveIsNewer', 'openCopyBackup', 'copyBackup', 'findDonors',
  'recIsVarying', 'varyingRecs', 'openFixShortfall', 'lastActualAmount', 'openQuickAmount',
  'backupDue', 'planNegatives', 'homeAlerts', 'updateAlerts',
  'catIconOf', 'catGlyph', 'openCatManage',
  'catListOf', 'catAv', 'assetPickBtn', 'endCondFields', 'openFormSheet', 'renderTxSheet', 'txType', 'txToggleRepeat',
  'accountName',
  'txScheduled', 'monthStats', 'monthStats2', 'expenseByCat', 'needGold', 'inQuietWindow', 'fmtSynced', 'rateStatusText',
  'nextBigOutflow', 'dday', 'balanceOn', 'nextOutflowCard', 'monthOutflowCard', 'planGaugeCard', 'homeAlertCard', 'renderHome',
  'totalAssets', 'totalDebt', 'ownerAssets', 'ownerDebt', 'ownerListArr', 'nwPane', 'shortDate2', 'nwHistoryCard',
  'pageHead', 'assetSubline', 'assetBodyHTML', 'renderAssets',
  'modeSeg', 'monthNav', 'abbr', 'calCellsFor', 'ledSumInner', 'ledSumBox', 'calPane', 'txRow', 'dayTxns',
  'ledgerRowsHtml', 'ledgerDayHeadHtml', 'renderLedger', 'selDayPartial',
  'fmtDot', 'splitHist', 'histRow', 'histTotHTML', 'updateHist', 'renderHistory',
];
// ASSET_TYPES는 DEFAULT_GROUP_ORDER(=Object.keys(ASSET_TYPES))가 참조하므로 먼저 와야 함 —
// CONSTS는 순서대로 실행되는 평범한 대입문으로 변환되기 때문(위 extractConst 주석 참고).
// _balCache/BAL_CACHE_MAX는 balancesUpTo()가 참조하는 모듈 스코프 캐시 상태라 같은 방식으로 끌어온다.
// _recCache/REC_CACHE_MAX는 expandRec()가 참조하는 모듈 스코프 캐시 상태라 같은 방식으로 끌어온다.
// isPlanAcct는 planNegatives()가 DB.assets.filter(isPlanAcct)로 부르는 "플랜 대상 통장"
// 판정 상수라 같은 방식(extractConst)으로 끌어온다.
const CONSTS = ['catKey', 'comma', 'commaQty', 'ASSET_TYPES', 'DEFAULT_GROUP_ORDER', 'EXP_CATS_DEFAULT', 'ADJUST_CAT', 'INC_CATS_DEFAULT', 'SAV_CATS_DEFAULT', 'RANGE_FROM', 'BUDGET_EPOCH', 'isFuture', 'BAL_CACHE_MAX', '_balCache', 'REC_CACHE_MAX', '_recCache', 'GOLD_G_PER_DON', 'isCashLike', 'isMarketValued', 'TYPEBYLABEL', 'SANITIZE_QTY_FIELDS', 'SANITIZE_FREE_FIELDS', 'isPlanAcct', 'CAT_LABEL', 'CATICON', 'won', 'PAGE_TITLE', 'wonS'];
// _histCache는 filteredHist()가 재대입(={key,list})하는 let 선언이라 CONSTS(extractConst)로는
// 못 끌어오므로 별도의 LETS 목록으로 extractLet을 통해 가져온다.
// _copyIsCsv도 같은 이유(openCopyBackup()이 재대입)로 LETS를 통해 가져온다.
// _fixWhen/_fixCtx는 openFixShortfall()이 재대입하는 "부족해요" 시트의 이체일 선택 상태라
// 같은 이유(let 선언, realm에 안 붙음)로 LETS를 통해 가져온다. 소스에서 두 변수가 한 줄
// `let _fixWhen=null,_fixCtx=null;`로 선언돼 있어 "_fixWhen"만 추출해도 둘 다 딸려온다.
// _lastNwOwner는 renderAssets()가 재대입하는 "마지막으로 렌더한 순자산 카드 귀속" 상태라
// 같은 이유(let 선언, realm에 안 붙음)로 LETS를 통해 가져온다.
// _lastLedYM은 renderLedger()가 재대입하는 "마지막으로 렌더한 가계부 연-월"(숫자 전환 애니메이션
// 트리거용) 상태라 같은 이유로 LETS를 통해 가져온다. 소스에서 `let _lastLedYM=null,_lastHistYM=null;`
// 한 줄로 선언돼 있어 "_lastLedYM"만 추출해도 둘 다 딸려온다(_fixWhen/_fixCtx와 같은 패턴).
const LETS = ['_histCache', '_copyIsCsv', '_fixWhen', '_lastNwOwner', '_lastLedYM'];

const extracted = FUNCTIONS.map(extractFunction).join('\n') + '\n' + CONSTS.map(extractConst).join('\n') + '\n' + LETS.map(extractLet).join('\n');

// doRenameCat()은 DB 조작 외에 UI 함수도 몇 개 부르므로($, toast, save, renderCurrent,
// openCatManage) 여기선 아무 일도 안 하는 스텁으로 채운다 — 우리가 검증하려는 건
// DB.catVar/DB.catIcon 마이그레이션 로직이지, 화면 갱신이 아니다.
// snapshotAssetName은 balanceAt/TODAY 등 잔액 계산 체인 전체를 끌고 오므로(이 테스트의
// 대상이 아님) 실제 소스 대신, 어떤 id로 호출됐는지만 기록하는 스텁으로 대체한다 —
// doRenameCat의 UI 스텁($, toast 등)과 같은 이유.
const sandbox = {
  DB: null,
  TODAY: null,
  // TM은 index.html에서 `let TM=ym(TODAY)`로 파생되는 "현재 보고 있는 달"({y,m})인데,
  // varyingRecs()가 이걸 직접 참조하므로 TODAY처럼 테스트에서 직접 세팅한다.
  TM: null,
  // RANGE_TO는 index.html에서 `let RANGE_TO=addDays(TODAY,760)`로 TODAY에 파생되는데,
  // 이 파일은 addDays 실행 결과를 그대로 재현하기보다(굳이 필요치도 않아) balancesUpTo/balanceAt을
  // 쓰는 테스트에서 TODAY처럼 직접 값을 세팅하게 둔다.
  RANGE_TO: null,
  // DISP_TO도 RANGE_TO와 같은 이유로 `let DISP_TO=addDays(TODAY,92)` 파생값을 재현하지 않고,
  // hasFutureTxns()를 쓰는 테스트에서 TODAY처럼 직접 세팅한다.
  DISP_TO: null,
  // CLOUD_UID/CLOUD_SYNC_STATE/STORAGE_PERSISTED는 index.html에서 `let`으로 선언되는 클라우드
  // 로그인/동기화/저장공간 영속 상태로, homeAlerts()가 직접 참조한다. RANGE_TO/DISP_TO와 같은
  // 이유(파생·비순수 상태)로 재현하지 않고 테스트에서 직접 세팅한다.
  CLOUD_UID: null,
  CLOUD_SYNC_STATE: 'idle',
  STORAGE_PERSISTED: null,
  // SESSION은 `let SESSION=localStorage.getItem(...)`으로 파생되는 로그인 이메일/카카오 id고,
  // AUTH는 localStorage 기반 계정 저장소 객체라(accountName()이 AUTH.rec(SESSION)을 부름) 둘 다
  // RANGE_TO/CLOUD_UID와 같은 이유(파생·비순수 상태, localStorage 의존)로 재현하지 않고
  // accountName() 테스트에서 직접 세팅한다.
  SESSION: null,
  AUTH: { rec: () => null },
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
  // 읽기만 하는 이 값을 최소 상태로 흉내낸다. 실제 소스는 최초 렌더 전엔 null이지만, 'home' 탭일
  // 때 renderCurrent()가 곧바로 부르는 updateAlerts(_homeNeg)가 이제 실제 로직(neg.length 등)이라
  // null을 넘기면 renderHome()을 스텁한 다른 테스트들이 매번 크래시하므로 []로 흉내낸다.
  _homeNeg: [],
  // updateAlerts는 FUNCTIONS에도 있어 실제 소스로 덮어써지지만, saveQuickAmount 등 이 값을
  // (real 함수가 정의되기 전에) 참조하는 다른 스텁 호출부가 없도록 안전망으로 남겨둔다.
  updateAlerts: () => {},
  // updateAlerts()가 부르는 최소 DOM 흉내 — nav-btn 순회는 빈 배열로, planBadge는 errBannerEl과
  // 같은 패턴의 classList/textContent 흉내 엘리먼트로, moveBlob은 실제 소스가 아니라(FUNCTIONS에
  // 없음) 호출 여부만 흉내내는 no-op으로 둔다(물방울 이동은 순수 로직 검증 대상이 아님).
  document: { querySelectorAll: () => [] },
  moveBlob: () => {},
  planBadgeEl: {
    _text: '',
    classList: {
      list: [],
      add(c) { if (!this.list.includes(c)) this.list.push(c); },
      remove(c) { this.list = this.list.filter((x) => x !== c); },
      toggle(c, on) { if (on) this.add(c); else this.remove(c); },
      contains(c) { return this.list.includes(c); },
    },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
  },
  requestAnimationFrame: () => {},
  // renderTxSheet()가 자동포커스용으로 부르는 setTimeout — vm 컨텍스트는 브라우저/Node의
  // 전역 setTimeout을 자동으로 갖지 않으므로, 콜백은 실행하지 않는 no-op으로 흉내낸다
  // (테스트는 openFormSheet에 넘겨진 html 문자열만 검증하지 지연 포커스 자체는 대상이 아님).
  setTimeout: () => {},
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
  // page-home의 최소 DOM 흉내 — renderHome()이 $('page-home').innerHTML=... 으로 직접 꽂는
  // 결과 문자열만 확인하면 되므로 errBannerEl과 같은 getter/setter 패턴을 재사용한다.
  pageHomeEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  // page-assets도 pageHomeEl과 같은 이유(renderAssets()가 $('page-assets').innerHTML=...로
  // 직접 꽂음)로 같은 getter/setter 패턴을 재사용한다.
  pageAssetsEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  // page-ledger도 같은 이유(renderLedger()가 $('page-ledger').innerHTML=...로 직접 꽂음)로
  // 같은 getter/setter 패턴을 재사용한다.
  pageLedgerEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  // page-history/histTotals/histList도 같은 이유(renderHistory()/updateHist()가
  // $('page-history')/$('histTotals')/$('histList').innerHTML=...으로 직접 꽂음)로
  // 같은 getter/setter 패턴을 재사용한다.
  pageHistoryEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  histTotalsEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  histListEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  // saveQuickAmount()는 $('qAmt').value를 읽어 금액을 얻으므로 그 id만 값을 갖는 입력칸처럼
  // 동작시킨다(recSave()는 app-evolve cycle55부터 syncTxInputs()를 거쳐 txDraft.amount/memo를
  // 읽으므로 더는 $('txAmt')를 직접 참조하지 않는다 — syncTxInputs는 no-op 스텁이라 recSave
  // 테스트는 아래처럼 sandbox.txDraft를 직접 세팅한다). errBanner는 renderCurrent 에러 바운더리 테스트용.
  // bkText는 copyBackup()이 select()/setSelectionRange()/.value를 쓰는 백업 복사 textarea 흉내.
  // asName은 syncAssetInputs()의 이름 trim() 회귀 테스트용(공백만 있는 이름이 그대로 저장되던 버그).
  // asNameValue가 undefined인 기본 상태에서는 null을 반환해, 이 mock 추가 이전처럼 다른 테스트의
  // syncAssetInputs()/saveAsset() 호출에서 asDraft.name이 건드려지지 않도록 한다.
  $: (id) => id === 'txAmt' ? { value: sandbox.txAmtValue } : id === 'qAmt' ? { value: sandbox.qAmtValue } : id === 'asName' ? (sandbox.asNameValue === undefined ? null : { value: sandbox.asNameValue }) : id === 'errBanner' ? sandbox.errBannerEl : id === 'bkText' ? sandbox.bkTextEl : id === 'planBadge' ? sandbox.planBadgeEl : id === 'page-home' ? sandbox.pageHomeEl : id === 'page-assets' ? sandbox.pageAssetsEl : id === 'page-ledger' ? sandbox.pageLedgerEl : id === 'page-history' ? sandbox.pageHistoryEl : id === 'histTotals' ? sandbox.histTotalsEl : id === 'histList' ? sandbox.histListEl : null,
  bkTextEl: { value: 'backup-text', select: () => {}, setSelectionRange: () => {} },
  // copyBackup()의 navigator.clipboard 체크가 ReferenceError 없이 "지원 안 함"으로 지나가게
  // 하는 최소 흉내(document.execCommand는 try/catch로 감싸져 있어 굳이 스텁이 필요 없음).
  navigator: {},
  toast: (msg) => { sandbox.lastToast = msg; sandbox.toastCalls.push(msg); },
  toastCalls: [],
  save: () => {},
  invalidateBalances: () => {},
  renderCurrent: () => {},
  openCatManage: () => {},
  openOwnerManage: () => {},
  // asOpenType()이 여는 자산 종류 피커 — 실제 DOM/블롭 렌더는 화면 전용이라 openPicker처럼
  // no-op으로 흉내내고, onPick 콜백만 캡처해 테스트가 직접 호출할 수 있게 한다.
  lastTypePickerOnPick: null,
  openTypePicker: (o) => { sandbox.lastTypePickerOnPick = o.onPick; },
  // renderAssets()가 부수효과로 부르는 실 DOM/드래그/스크롤/애니메이션 와이어링 여섯 개 —
  // fitAll처럼 화면 전용이라 순수 로직 테스트 대상이 아니므로 전부 no-op으로 흉내낸다
  // (renderAssets 자체와 그 안의 문자열 빌더 헬퍼들만 실제 소스로 검증하면 충분).
  wireGroupDrag: () => {},
  wireLongPress: () => {},
  wireNwCarousel: () => {},
  restoreNwScroll: () => {},
  animNums: () => {},
  updateSelBottom: () => {},
  // renderLedger()가 부수효과로 부르는 달력 캐러셀 스와이프 와이어링 — 같은 이유(화면 전용)로
  // no-op으로 흉내낸다.
  wireMonthCarousel: () => {},
  openSpendAnalysis: () => {},
  closeSheet: () => {},
  renderTxSheet: () => {},
  // asOpenType()의 onPick 콜백이 마지막에 부르는 자산 시트 재렌더 — renderTxSheet와 같은 이유
  // (화면 전용, asOpenType 테스트는 asDraft 변화만 검증)로 no-op으로 흉내낸다.
  renderAssetSheet: () => {},
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
  // saveRec()가 편집 대상 필드를 읽는 recDraft(전역 폼 상태) — syncRecInputs()는 DOM 입력칸을
  // recDraft에 반영하는 순수 로직이 아닌 함수라 no-op으로 흉내낸다(saveTx/syncTxInputs와 같은 이유).
  recDraft: null,
  syncRecInputs: () => {},
  // recSaveScopeConfirm()이 띄우는 확인 시트 — 실제 DOM 대신 마지막으로 그려진 html만 기록한다.
  lastSheetHtml: null,
  openSheet: (html) => { sandbox.lastSheetHtml = html; },
  // saveAsset()의 새 자산 등록 경로가 부르는 "삭제된 동명 자산 재연동" 흐름 — dup 차단 테스트 외에
  // 실제로 자산을 등록하는 saveAsset 테스트에서만 도달하므로, 항상 "해당 없음"으로 흉내낸다.
  deletedAssetHistoryExists: () => false,
  askRelinkDeleted: () => {},
  clampRecurringToMaturity: () => {},
  // saveAsset()이 저장 직후 '가격 미확인'인 fx/gold/stock 자산에 대해 TTL을 기다리지 않고
  // 부르는 즉시 시세 동기화 — 실제 네트워크 호출 대신 호출 여부만 기록한다.
  syncRatesCalls: [],
  syncRates: (silent) => { sandbox.syncRatesCalls.push(silent); },
  // genSalt/pbkdf2Hash(비밀번호 해싱)는 브라우저와 동일한 Web Crypto API 모양을 쓰므로,
  // Node 19+의 전역 webcrypto를 그대로 넘기면 index.html과 같은 소스가 그대로 돌아간다.
  crypto,
  TextEncoder,
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

/* ---------- truncateRecEnd: endDate·count를 항상 함께 맞추는 헬퍼 (cycle56, recApply/recSave/splitRecurrenceAt이 공유) ---------- */
test('truncateRecEnd: 월간 반복을 cutoff 날짜로 자르면 endDate=cutoff, count는 그 시점까지의 실제 발생 횟수와 일치한다', () => {
  const base = { freq: 'monthly', day: 1, startDate: '2026-01-10', weekend: 'none' };
  const cutoff = '2026-06-01';
  const { endDate, count } = sandbox.truncateRecEnd(base, cutoff);
  assert.strictEqual(endDate, cutoff, 'endDate는 넘긴 cutoff 그대로여야 함');
  const generated = sandbox.recDates(Object.assign({}, base, { endDate: null }), base.startDate, cutoff);
  assert.strictEqual(count, generated.length, 'count는 cutoff까지의 실제 발생 횟수와 일치해야 함');
});
test('truncateRecEnd: 주말 조정(later)이 있는 주간 반복도 실제 생성 결과와 count가 정확히 일치한다', () => {
  const sat = nextSaturdayOnOrAfter(2026, 3, 1);
  const base = { freq: 'weekly', day: null, startDate: sat, weekend: 'later' };
  const cutoff = sandbox.recNthDate(base, 4);
  const { endDate, count } = sandbox.truncateRecEnd(base, cutoff);
  assert.strictEqual(endDate, cutoff);
  assert.strictEqual(count, 4, 'recNthDate(base,4)를 cutoff로 넘기면 count는 4여야 함');
});

/* ---------- recalcEndCond: 주기/반복일/주말규칙/시작일 변경 시 count↔endDate 쌍이 새 기준으로 재계산돼야 함 (cycle53) ---------- */
test('recalcEndCond: 매월 반복 횟수 12로 endDate를 고정한 뒤 매주로 주기를 바꾸면 endDate가 새 주기 기준 12회로 재계산된다', () => {
  const monthly = { freq: 'monthly', day: 1, startDate: '2026-01-10', weekend: 'none', count: 12, endDate: null };
  sandbox.recalcEndCond(monthly, monthly.startDate);
  assert.strictEqual(monthly.endDate, '2027-01-01', '매월 12회의 마지막 회차 날짜여야 함');
  const switched = { freq: 'weekly', day: monthly.day, startDate: monthly.startDate, weekend: monthly.weekend, count: monthly.count, endDate: monthly.endDate };
  sandbox.recalcEndCond(switched, switched.startDate);
  const generated = sandbox.recDates(
    { freq: 'weekly', day: switched.day, startDate: switched.startDate, endDate: null, weekend: switched.weekend },
    switched.startDate, switched.endDate
  );
  assert.strictEqual(generated.length, 12, 'count(12)가 우선이므로 주기를 바꿔도 실제 생성 회차는 여전히 12개여야 함');
  assert.strictEqual(sandbox.recCountUntil({ freq: 'weekly', day: switched.day, startDate: switched.startDate, weekend: switched.weekend }, switched.endDate), 12);
});
test('recalcEndCond: count 없이 endDate만 있으면 새 기준(주기 변경 후)으로 count를 다시 채운다', () => {
  const d = { freq: 'monthly', day: 1, startDate: '2026-01-10', weekend: 'none', count: null, endDate: '2027-01-01' };
  sandbox.recalcEndCond(d, d.startDate);
  assert.strictEqual(d.count, 12, 'endDate 기준으로 count가 역산돼야 함');
  // endDate가 사용자가 정한 값이므로(count는 방금 파생됐을 뿐) 그대로 두고 주기만 바꾸는 시나리오:
  // count를 다시 null로 돌려 "endDate가 진짜 기준"인 상태를 재현한다.
  d.count = null;
  d.freq = 'weekly';
  sandbox.recalcEndCond(d, d.startDate);
  assert.notStrictEqual(d.count, 12, '주기가 바뀌면 같은 endDate라도 회차 수는 12와 달라야 함(매주가 매월보다 훨씬 잦음)');
  assert.strictEqual(d.endDate, '2027-01-01', 'endDate 자체는 사용자가 정한 값이므로 그대로 유지된다');
});
test('recalcEndCond: count/endDate가 둘 다 없으면 아무것도 하지 않는다', () => {
  const d = { freq: 'monthly', day: 1, startDate: '2026-01-10', weekend: 'none', count: null, endDate: null };
  sandbox.recalcEndCond(d, d.startDate);
  assert.strictEqual(d.count, null);
  assert.strictEqual(d.endDate, null);
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

/* ---------- num()/fmtAmt(): 음수 입력 처리 (app-evolve cycle56 develop, cycle56 review에서 num() 수정)
 * 자산 "현재 금액" 필드(asAmt)는 마이너스통장(오버드래프트)처럼 잔액이 음수일 수 있는데,
 * fmtAmt()가 매 키 입력마다 '-' 문자까지 통째로 제거해 사용자가 애초에 음수를 입력할 수 없었다.
 * num()도 부호를 무시하고 절댓값만 파싱해, 설령 값에 '-'가 남아 있어도 양수로 읽혔다.
 * develop 커밋은 fmtAmt(inp,allowNeg)에는 allowNeg 게이팅을 넣었지만 num(el)은 게이팅 없이
 * 부호를 무조건 보존하도록 고쳐, syncTxInputs()/syncRecInputs()가 num($('txAmt'))/num($('rAmt'))로
 * 읽는 거래·반복 금액까지 전부 영향을 받았다 — editTx()가 txDraft=JSON.parse(JSON.stringify(t))로
 * DB.txns의 t.amount를 그대로 복제해 열기 때문에, 백업 복원/클라우드 동기화로 이미 음수가 된
 * t.amount(SANITIZE_FREE_FIELDS는 amount를 "마이너스도 유효"로 취급해 걸러내지 않음, sanitizeAmount
 * 부근 주석 참고)를 가진 기존 거래를 열어 금액칸을 건드리지 않고 저장만 해도(oninput이 한 번도
 * 안 일어나 fmtAmt가 부호를 지울 기회가 없음) num()이 그 음수를 그대로 통과시켜 income/expense/
 * saving/transfer 타입별 부호 관례(t.amount는 항상 크기, 부호는 type이 결정)를 깨는 회귀였다.
 * num(el,allowNeg)로 fmtAmt와 동일하게 게이팅해, asAmt(canNeg)만 부호를 보존하고 나머지 모든
 * 호출부(txAmt/rAmt/qAmt/bigMinInput, 인자 없이 호출)는 기존처럼 부호가 제거되는 동작을 유지한다. */
test('num(): allowNeg 없이 호출하면(거래금액 등) 앞의 - 부호를 무시하고 절댓값만 파싱한다', () => {
  assert.strictEqual(sandbox.num({ value: '-100' }), 100);
  assert.strictEqual(sandbox.num({ value: '1,234' }), 1234);
  assert.strictEqual(sandbox.num({ value: '-1,234' }), 1234);
});
test('num(): allowNeg=true면(자산 잔액) 앞에 붙은 - 부호를 유지하고 나머지 비숫자 문자만 제거해 파싱한다', () => {
  assert.strictEqual(sandbox.num({ value: '-100' }, true), -100);
  assert.strictEqual(sandbox.num({ value: '1,234' }, true), 1234);
  assert.strictEqual(sandbox.num({ value: '-1,234' }, true), -1234);
});
test('num(): 값이 없거나 엘리먼트가 없으면 0을 반환한다', () => {
  assert.strictEqual(sandbox.num({ value: '' }), 0);
  assert.strictEqual(sandbox.num(null), 0);
});
test('fmtAmt(): allowNeg 없이 호출하면(거래금액 등) 기존처럼 부호를 제거한 절댓값만 남긴다', () => {
  const inp = { value: '-500000' };
  sandbox.fmtAmt(inp);
  assert.strictEqual(inp.value, '500,000');
});
test('fmtAmt(): allowNeg=true면(자산 잔액) 음수 부호를 유지한 채 천단위 콤마를 적용한다', () => {
  const inp = { value: '-500000' };
  sandbox.fmtAmt(inp, true);
  assert.strictEqual(inp.value, '-500,000');
});
test('fmtAmt(): allowNeg=true여도 "-"만 입력된 상태에서는 숫자를 마저 입력할 수 있게 부호를 지우지 않는다', () => {
  const inp = { value: '-' };
  sandbox.fmtAmt(inp, true);
  assert.strictEqual(inp.value, '-');
});
test('fmtAmt(): 숫자를 모두 지우면 allowNeg 여부와 관계없이 빈 문자열이 된다', () => {
  const inp1 = { value: '' };
  sandbox.fmtAmt(inp1, true);
  assert.strictEqual(inp1.value, '');
  const inp2 = { value: '' };
  sandbox.fmtAmt(inp2);
  assert.strictEqual(inp2.value, '');
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

/* ---------- budgetForMonth/setBudgetFrom: 예산은 시점별 이력이라 과거/미래 조회에 서로 다른 값을 돌려줘야 한다 ---------- */
test('budgetForMonth: 이력이 없는 카테고리는 0(미설정)을 반환한다', () => {
  sandbox.DB = { budgetHistory: {} };
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 0);
});
test('budgetForMonth: DB.budgetHistory 자체가 없어도(undefined) 터지지 않고 0을 반환한다', () => {
  sandbox.DB = {};
  assert.doesNotThrow(() => sandbox.budgetForMonth('식비', 2026, 6));
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 0);
});
test('budgetForMonth: from 시점 이전 달을 조회하면 아직 그 예산이 적용되지 않아 0이다', () => {
  sandbox.DB = { budgetHistory: { 식비: [{ from: '2026-06', amount: 300000 }] } };
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 5), 0, '이력 시작 전 달은 미설정이어야 함');
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 300000, 'from 달 자체부터는 적용');
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 7), 300000, '이후 달에도 계속 적용');
});
test('setBudgetFrom: 예산을 조정해도 조정 이전 달의 값은 그대로 유지된다(소급 왜곡 방지)', () => {
  sandbox.DB = {};
  sandbox.setBudgetFrom('식비', 2026, 3, 200000);
  sandbox.setBudgetFrom('식비', 2026, 6, 300000); // 6월부터 인상
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 3), 200000);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 5), 200000, '인상 이전 달은 옛 금액을 유지해야 함');
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 300000);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 8), 300000);
});
test('setBudgetFrom: 같은 달에 다시 저장하면 그 달 항목만 덮어쓰고 새 항목을 추가하지 않는다', () => {
  sandbox.DB = {};
  sandbox.setBudgetFrom('식비', 2026, 6, 300000);
  sandbox.setBudgetFrom('식비', 2026, 6, 350000);
  assert.strictEqual(sandbox.DB.budgetHistory.식비.length, 1);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 350000);
});
test('setBudgetFrom: 과거 달을 보면서 저장해도(예: 6월을 보다가 5월 값을 조정) 이후 달에는 영향이 없다', () => {
  sandbox.DB = {};
  sandbox.setBudgetFrom('식비', 2026, 6, 300000);
  sandbox.setBudgetFrom('식비', 2026, 3, 100000); // from 오름차순이 아니게 나중에 삽입되는 경우
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 3), 100000);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 5), 100000);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 300000, '이후 달 값은 영향받지 않아야 함');
});

/* ---------- totalBudgetSummary: 지출 분석의 해당 달 '예산' 요약 카드 집계 ---------- */
test('totalBudgetSummary: 예산을 하나도 설정하지 않았으면 budgetedTotal=0(집계할 게 없음)', () => {
  sandbox.DB = { budgetHistory: {} };
  const rows = [{ c: '식비', v: 50000 }, { c: '교통', v: 20000 }];
  const r = sandbox.totalBudgetSummary(rows, 2026, 6);
  assert.strictEqual(r.budgetedTotal, 0);
  assert.strictEqual(r.spentOnBudgeted, 0);
  assert.strictEqual(r.overCount, 0);
  assert.strictEqual(r.unsetCount, 2, '예산이 없으면 지출이 있는 두 카테고리 모두 미설정으로 집계돼야 함');
});
test('totalBudgetSummary: 예산이 설정된 카테고리만 합산하고, 미설정 카테고리는 unsetCount로만 센다', () => {
  sandbox.DB = { budgetHistory: { 식비: [{ from: '2026-01', amount: 100000 }], 교통: [{ from: '2026-01', amount: 30000 }] } };
  const rows = [{ c: '식비', v: 50000 }, { c: '교통', v: 20000 }, { c: '취미', v: 10000 }];
  const r = sandbox.totalBudgetSummary(rows, 2026, 6);
  assert.strictEqual(r.budgetedTotal, 130000, '예산이 설정된 식비+교통 한도만 합산');
  assert.strictEqual(r.spentOnBudgeted, 70000, '예산이 설정된 카테고리의 지출만 합산(취미 10000은 제외)');
  assert.strictEqual(r.overCount, 0);
  assert.strictEqual(r.unsetCount, 1, '취미만 예산 미설정');
});
test('totalBudgetSummary: 예산을 초과한 카테고리 수를 overCount로 센다', () => {
  sandbox.DB = { budgetHistory: { 식비: [{ from: '2026-01', amount: 100000 }], 교통: [{ from: '2026-01', amount: 30000 }] } };
  const rows = [{ c: '식비', v: 150000 }, { c: '교통', v: 20000 }];
  const r = sandbox.totalBudgetSummary(rows, 2026, 6);
  assert.strictEqual(r.budgetedTotal, 130000);
  assert.strictEqual(r.spentOnBudgeted, 170000);
  assert.strictEqual(r.overCount, 1, '식비만 예산을 초과함');
  assert.strictEqual(r.unsetCount, 0);
});
test('totalBudgetSummary: DB.budgetHistory가 없어도(undefined) 터지지 않고 전부 미설정으로 처리한다', () => {
  sandbox.DB = {};
  const rows = [{ c: '식비', v: 50000 }];
  const r = sandbox.totalBudgetSummary(rows, 2026, 6);
  assert.strictEqual(r.budgetedTotal, 0);
  assert.strictEqual(r.unsetCount, 1);
});
test('totalBudgetSummary: 예산을 인상하기 전 과거 달을 조회하면 과거 당시의(인상 전) 예산으로 집계된다', () => {
  sandbox.DB = { budgetHistory: { 식비: [{ from: '2026-01', amount: 100000 }, { from: '2026-06', amount: 200000 }] } };
  const rows = [{ c: '식비', v: 150000 }];
  const past = sandbox.totalBudgetSummary(rows, 2026, 3); // 인상 전: 100000 예산 대비 150000 지출 -> 초과
  assert.strictEqual(past.budgetedTotal, 100000);
  assert.strictEqual(past.overCount, 1);
  const now = sandbox.totalBudgetSummary(rows, 2026, 6); // 인상 후: 200000 예산 대비 150000 지출 -> 이내
  assert.strictEqual(now.budgetedTotal, 200000);
  assert.strictEqual(now.overCount, 0, '나중에 예산을 올렸다고 과거 조회가 아니라 인상 이후 조회만 이내로 바뀌어야 함');
});

/* ---------- doRenameCat: 카테고리 이름변경 시 예산 이력도 함께 이동 ---------- */
test('doRenameCat: 지출 카테고리 이름변경 시 DB.budgetHistory의 이력이 새 이름으로 이동한다', () => {
  sandbox.DB = { categories: { expense: ['식비'] }, catIcon: {}, catVar: {}, budgetHistory: { 식비: [{ from: '2026-01', amount: 300000 }] }, txns: [], recurrences: [] };
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.budgetForMonth('외식비', 2026, 6), 300000);
  assert.strictEqual('식비' in sandbox.DB.budgetHistory, false, '옛 이름의 예산 이력은 제거돼야 함');
});
test('doRenameCat: 예산이 설정되지 않은 카테고리를 이름변경해도 오류 없이 통과한다', () => {
  sandbox.DB = { categories: { expense: ['교통비'] }, catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [] };
  sandbox.catRenameDraft = { name: '대중교통', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(Object.keys(sandbox.DB.budgetHistory).length, 0);
});

/* ---------- doDeleteCat: 카테고리 삭제 시 아이콘/변동/예산 정리 (동명 재생성 시 이전 설정이 남지 않도록) ---------- */
test('doDeleteCat: 삭제 시 catIcon/catVar/budgetHistory 항목이 함께 제거된다', () => {
  sandbox.DB = {
    categories: { expense: ['커피', '식비'] },
    catIcon: { 'expense:커피': 'coffee' },
    catVar: { 'expense:커피': true },
    budgetHistory: { 커피: [{ from: '2026-01', amount: 30000 }] },
    txns: [], recurrences: [],
  };
  sandbox.doDeleteCat('expense', 0);
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['식비']);
  assert.strictEqual('expense:커피' in sandbox.DB.catIcon, false);
  assert.strictEqual('expense:커피' in sandbox.DB.catVar, false);
  assert.strictEqual('커피' in sandbox.DB.budgetHistory, false);
});
test('doDeleteCat: 같은 이름으로 다시 추가해도 지워진 카테고리의 이전 아이콘/변동/예산을 물려받지 않는다', () => {
  sandbox.DB = {
    categories: { expense: ['커피'] },
    catIcon: { 'expense:커피': 'coffee' },
    catVar: { 'expense:커피': true },
    budgetHistory: { 커피: [{ from: '2026-01', amount: 30000 }] },
    txns: [], recurrences: [],
  };
  sandbox.doDeleteCat('expense', 0);
  sandbox.DB.categories.expense.push('커피'); // 사용자가 같은 이름으로 재생성
  assert.strictEqual('expense:커피' in sandbox.DB.catIcon, false);
  assert.strictEqual(sandbox.isVarCat('expense', '커피'), false);
  assert.strictEqual('커피' in sandbox.DB.budgetHistory, false);
});
test('doDeleteCat: 수입/저축 카테고리는 budgetHistory를 건드리지 않는다', () => {
  sandbox.DB = {
    categories: { income: ['용돈'] },
    catIcon: {}, catVar: {}, budgetHistory: { 용돈: [{ from: '2026-01', amount: 100000 }] },
    txns: [], recurrences: [],
  };
  sandbox.doDeleteCat('income', 0);
  assert.strictEqual(sandbox.budgetForMonth('용돈', 2026, 6), 100000, 'expense가 아닌 타입은 budgetHistory 키 공간이 겹치지 않으므로 건드리면 안 됨');
});

/* ---------- ADJUST_CAT: '잔액 조정' 시스템 카테고리는 이름변경/삭제로부터 보호된다 ---------- */
test('doDeleteCat: 수입의 잔액 조정 카테고리는 삭제되지 않고 안내 토스트만 뜬다', () => {
  sandbox.DB = {
    categories: { income: ['급여', sandbox.ADJUST_CAT] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.lastToast = null;
  sandbox.doDeleteCat('income', 1);
  assert.deepStrictEqual(sandbox.DB.categories.income, ['급여', sandbox.ADJUST_CAT], '카테고리 배열이 그대로 유지돼야 함');
  assert.ok(sandbox.lastToast, '안내 토스트가 떴어야 함');
});
test('doRenameCat: 수입의 잔액 조정 카테고리는 이름을 바꿀 수 없다', () => {
  sandbox.DB = {
    categories: { income: [sandbox.ADJUST_CAT] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
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
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.catRenameDraft = { name: '정정', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.categories.expense[0], '정정', '지출 카테고리는 이름 보호 대상이 아님');
});
test('doDeleteCat: 잔액 조정이 아닌 평범한 수입 카테고리는 그대로 삭제된다(가드 과잉 적용 아님)', () => {
  sandbox.DB = {
    categories: { income: ['급여', sandbox.ADJUST_CAT] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
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
    budgetHistory: { 외식: [{ from: '2026-01', amount: 50000 }] },
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
  assert.strictEqual(sandbox.budgetForMonth('외식', 2026, 6), 50000, '예산 이력도 복원돼야 함');
});
test('doDeleteCat: 연결된 활성 반복거래가 없으면 undo해도 반복거래 배열은 그대로다', () => {
  sandbox.DB = {
    categories: { expense: ['교통'] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
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

/* ---------- delBudget: 예산 삭제도 delCat/delOwner처럼 undo 가능해야 한다 (cycle29), 이제는 과거 이력을 보존한다 (cycle32) ---------- */
test('delBudget: 삭제하면 보고 있는 달부터 0(미설정)이 되고 undoToast로 원래 금액이 되돌아온다', () => {
  sandbox.DB = { txns: [], recurrences: [], budgetHistory: { 식비: [{ from: '2026-01', amount: 50000 }], 교통: [{ from: '2026-01', amount: 30000 }] } };
  sandbox.ST = { ledger: { y: 2026, m: 6 } };
  sandbox.lastUndo = null;
  sandbox.delBudget(0); // rows는 spendByCategory 순회 순서상 [{c:'식비',v:0},{c:'교통',v:0}]
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 0, '삭제 직후에는 보고 있는 달부터 예산이 없어야 함');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 50000, '되돌리면 원래 금액이 복원돼야 함');
  assert.strictEqual(sandbox.budgetForMonth('교통', 2026, 6), 30000, '다른 카테고리 예산은 영향받지 않아야 함');
});
test('delBudget: 존재하지 않는 idx를 넘기면 아무것도 하지 않는다', () => {
  sandbox.DB = { txns: [], recurrences: [], budgetHistory: { 식비: [{ from: '2026-01', amount: 50000 }] } };
  sandbox.ST = { ledger: { y: 2026, m: 6 } };
  sandbox.lastUndo = null;
  sandbox.delBudget(5);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 50000);
  assert.strictEqual(sandbox.lastUndo, null, 'undoToast가 호출되면 안 됨');
});
test('delBudget: 과거 달의 예산 표시는 삭제 이후에도 소급 왜곡되지 않고 그대로 남는다', () => {
  sandbox.DB = { txns: [], recurrences: [], budgetHistory: { 식비: [{ from: '2026-01', amount: 50000 }] } };
  sandbox.ST = { ledger: { y: 2026, m: 6 } }; // 6월을 보면서 삭제
  sandbox.delBudget(0);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 3), 50000, '삭제 이전 달(3월)의 예산은 그대로 남아야 함');
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 0, '삭제한 달(6월)부터는 미설정이어야 함');
});
test('delBudget: undo는 그 달에 원래 있던 값이 아니라 삭제 직전 상태 전체를 복원한다(다른 달에 새로 추가된 항목이 아니었다면 항목 자체를 제거)', () => {
  sandbox.DB = { txns: [], recurrences: [], budgetHistory: { 식비: [{ from: '2026-01', amount: 50000 }] } };
  sandbox.ST = { ledger: { y: 2026, m: 6 } }; // 1월 항목만 있고 6월엔 아직 별도 항목이 없는 상태에서 6월을 보며 삭제
  sandbox.delBudget(0);
  assert.strictEqual(sandbox.DB.budgetHistory.식비.length, 2, '삭제로 6월부터 0인 새 항목이 추가돼야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.budgetHistory.식비.length, 1, '되돌리면 원래 없던 6월 항목이 제거되고 1월 항목만 남아야 함');
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 8), 50000, '되돌린 뒤에는 8월도 다시 1월부터 이어지는 5만원이어야 함');
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
  assert.strictEqual(Object.keys(sandbox.DB.budgetHistory).length, 0);
});
/* 기존 사용자의 DB.budgets(시간 축 없는 flat 값)를 budgetHistory 이력으로 1회 변환 — 변환 직후에는
 * 어느 달을 조회해도(과거/현재/미래) 옛 값을 그대로 보여줘야 마이그레이션 전후 화면이 달라지지 않는다. */
test('migrate: 기존 DB.budgets(flat)가 있으면 budgetHistory 이력으로 1회 변환되고, 변환 직후엔 어느 달을 봐도 기존 값과 같다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
    budgets: { 식비: 300000, 교통: 100000 },
  };
  sandbox.migrate();
  assert.strictEqual(sandbox.budgetForMonth('식비', 2020, 1), 300000, '변환 전 과거 달을 조회해도 기존 값과 같아야 함(화면 급변 방지)');
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 300000);
  assert.strictEqual(sandbox.budgetForMonth('교통', 2026, 6), 100000);
});
test('migrate: DB._budgetHistV1이 이미 true면(재실행) DB.budgets를 다시 변환하지 않는다(중복 변환 방지)', () => {
  sandbox.DB = {
    version: 5, catsV2: true, _budgetHistV1: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
    budgets: { 식비: 300000 }, // 이미 삭제해서 남아있지 않아야 할 옛 필드가 아직 있어도
    budgetHistory: { 식비: [{ from: '2026-06', amount: 500000 }] }, // 사용자가 그 사이 직접 조정한 최신 이력을 덮어쓰면 안 됨
  };
  sandbox.migrate();
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 500000, '재실행에서 옛 flat 값으로 되돌리면 안 됨');
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

/* ---------- doExport(csv) 회귀: 반복거래는 확인 전까지 DB.txns에 저장되지 않고 expandRec()이
 * 매번 즉석 생성하는 가상 행이라(app-evolve cycle51 develop), doExport()가 DB.txns만 CSV로
 * 내보내면 반복 지출/수입/이체가 CSV에서 통째로 누락된다. 실제 앱 코드(index.html의 doExport)는
 * DB.txns.concat(expandRec(RANGE_FROM,RANGE_TO))를 txnsToCSV에 넘기므로, 그 조합을 그대로
 * 재현해 검증한다(allTxns()와 같은 합성 패턴, index.html:1960). */
test('txnsToCSV+expandRec: doExport(csv)와 같은 방식으로 합치면 반복거래도 CSV에 포함된다', () => {
  sandbox._recCache.clear();
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    txns: [{ id: 't1', date: '2026-01-01', type: 'expense', category: '식비', amount: -5000, fromAssetId: 'a1', memo: '점심' }],
    recurrences: [{ id: 'r1', active: true, freq: 'monthly', day: 1, startDate: '2026-01-01', endDate: null, weekend: 'none', type: 'expense', category: '월세', memo: '월세', amount: -500000, fromAssetId: 'a1', skip: [], edits: {} }],
    assets: [{ id: 'a1', name: '주계좌' }],
  };
  const merged = sandbox.DB.txns.concat(sandbox.expandRec(sandbox.RANGE_FROM, sandbox.RANGE_TO));
  const csv = sandbox.txnsToCSV(merged, sandbox.DB.assets);
  assert.ok(csv.includes('월세'), '반복거래(월세)가 DB.txns에 없어도 CSV에는 포함돼야 함');
  const rentRows = csv.split('\r\n').filter(l => l.includes('월세'));
  assert.ok(rentRows.length > 10, `2026-01-01부터 매달 반복이므로 여러 달치가 나와야 함(실제 ${rentRows.length}행)`);
});
test('txnsToCSV+expandRec: DB.txns만 넘기면(기존 버그) 반복거래가 CSV에서 빠진다', () => {
  sandbox._recCache.clear();
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    txns: [{ id: 't1', date: '2026-01-01', type: 'expense', category: '식비', amount: -5000, fromAssetId: 'a1', memo: '점심' }],
    recurrences: [{ id: 'r1', active: true, freq: 'monthly', day: 1, startDate: '2026-01-01', endDate: null, weekend: 'none', type: 'expense', category: '월세', memo: '월세', amount: -500000, fromAssetId: 'a1', skip: [], edits: {} }],
    assets: [{ id: 'a1', name: '주계좌' }],
  };
  const csv = sandbox.txnsToCSV(sandbox.DB.txns, sandbox.DB.assets);
  assert.ok(!csv.includes('월세'), 'DB.txns만 넘기면 반복거래는 애초에 그 안에 없으므로 CSV에도 없음(수정 전 doExport의 실제 동작)');
});

/* ---------- 거래 내역 CSV 가져오기 (app-evolve cycle54 advance) ---------- */
test('parseCSV: 따옴표로 감싼 필드 안의 콤마/줄바꿈/이스케이프된 큰따옴표를 올바르게 되돌린다', () => {
  // vm 샌드박스 안에서 만들어진 배열은 host의 Array와 realm이 달라 deepStrictEqual이
  // (값은 같아도) 실패하므로, JSON round-trip으로 host realm 구조로 정규화한다.
  const csv = '날짜,메모\r\n2026-01-01,"김밥, 라면"\r\n2026-01-02,"줄바꿈\n있음"\r\n2026-01-03,"""인용"""';
  const rows = JSON.parse(JSON.stringify(sandbox.parseCSV(csv)));
  assert.deepStrictEqual(rows, [
    ['날짜', '메모'],
    ['2026-01-01', '김밥, 라면'],
    ['2026-01-02', '줄바꿈\n있음'],
    ['2026-01-03', '"인용"'],
  ]);
});
test('parseCSV: BOM을 제거하고 빈 줄은 건너뛴다', () => {
  const rows = JSON.parse(JSON.stringify(sandbox.parseCSV('﻿a,b\r\n\r\n1,2')));
  assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
});
test('parseCSV ↔ txnsToCSV: 내보낸 CSV를 그대로 다시 파싱하면 원래 값으로 돌아온다(round-trip)', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const csv = sandbox.txnsToCSV(
    [{ date: '2026-01-01', type: 'expense', category: '식비', amount: -5000, fromAssetId: 'a1', toAssetId: null, memo: '김밥, "맛집"' }],
    assets
  );
  const rows = JSON.parse(JSON.stringify(sandbox.parseCSV(csv)));
  assert.deepStrictEqual(rows[1], ['2026-01-01', '지출', '식비', '-5000', '주계좌', '', '김밥, "맛집"']);
});
test('unguardCsv: guard()가 =,+,-,@ 앞에 붙인 보호용 \'를 되돌린다', () => {
  assert.strictEqual(sandbox.unguardCsv("'=1+1"), '=1+1');
  assert.strictEqual(sandbox.unguardCsv("'+foo"), '+foo');
  assert.strictEqual(sandbox.unguardCsv('평범한 이름'), '평범한 이름');
  assert.strictEqual(sandbox.unguardCsv("어포스트로피'가 중간에"), "어포스트로피'가 중간에");
});
test('csvDateValid: YYYY-MM-DD 형식이 아니거나 실존하지 않는 날짜(예: 2월 30일)는 거부한다', () => {
  assert.strictEqual(sandbox.csvDateValid('2026-01-15'), true);
  assert.strictEqual(sandbox.csvDateValid('2026-1-15'), false);
  assert.strictEqual(sandbox.csvDateValid('2026-02-30'), false);
  assert.strictEqual(sandbox.csvDateValid('not-a-date'), false);
});
test('csvRowToImportTxn: 자산명이 정확히 일치하면 id로 연결한다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const r = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '주계좌', '', '점심'], assets);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.txn.fromAssetId, 'a1');
  assert.strictEqual(r.txn.fromAssetName, undefined);
  assert.strictEqual(r.txn.toAssetId, null);
  assert.strictEqual(r.unmatched.length, 0);
});
test('csvRowToImportTxn: 자산명을 못 찾으면 id 없이 이름 스냅샷만 남기고 unmatched로 표시한다(내역은 보존)', () => {
  const r = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '없는통장', '', ''], []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.txn.fromAssetId, null);
  assert.strictEqual(r.txn.fromAssetName, '없는통장');
  assert.deepStrictEqual(Array.from(r.unmatched), ['없는통장']);
});
test('csvRowToImportTxn: 이체/저축인데 보내는·받는 자산 중 하나라도 비어 있으면 무효 처리한다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const r1 = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '10000', '주계좌', '', ''], assets);
  assert.strictEqual(r1.ok, false);
  const r2 = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '10000', '주계좌', '적금통장', ''], assets);
  assert.strictEqual(r2.ok, true);
});
test('csvRowToImportTxn: 지출/수입/저축인데 카테고리가 비어 있으면 무효, 이체는 카테고리 없어도 "이체"로 고정된다', () => {
  const assets = [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }];
  const bad = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '', '1000', '', '', ''], []);
  assert.strictEqual(bad.ok, false);
  const tr = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '', '1000', 'A', 'B', ''], assets);
  assert.strictEqual(tr.ok, true);
  assert.strictEqual(tr.txn.category, '이체');
});
test('csvRowToImportTxn: 날짜/구분/금액이 잘못되면 무효 처리한다', () => {
  assert.strictEqual(sandbox.csvRowToImportTxn(['bad-date', '지출', '식비', '1000', '', '', ''], []).ok, false);
  assert.strictEqual(sandbox.csvRowToImportTxn(['2026-01-01', '알수없음', '식비', '1000', '', '', ''], []).ok, false);
  assert.strictEqual(sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '0', '', '', ''], []).ok, false);
  assert.strictEqual(sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', 'abc', '', '', ''], []).ok, false);
});
test('csvRowToImportTxn: 지출은 fromAssetId만, 수입은 toAssetId만 채우고 반대쪽은 항상 null', () => {
  const assets = [{ id: 'a1', name: 'A' }];
  const exp = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '1000', 'A', 'A', ''], assets);
  assert.strictEqual(exp.txn.fromAssetId, 'a1'); assert.strictEqual(exp.txn.toAssetId, null);
  const inc = sandbox.csvRowToImportTxn(['2026-01-01', '수입', '급여', '1000', 'A', 'A', ''], assets);
  assert.strictEqual(inc.txn.fromAssetId, null); assert.strictEqual(inc.txn.toAssetId, 'a1');
});
test('csvDedupeKey: 연결된 자산은 id로, 스냅샷 이름은 이름으로 비교해 같은 자산을 가리켜도 섞이지 않는다', () => {
  const byId = { date: '2026-01-01', type: 'expense', amount: 1000, category: '식비', fromAssetId: 'a1', toAssetId: null, memo: '' };
  const byName = { date: '2026-01-01', type: 'expense', amount: 1000, category: '식비', fromAssetName: 'a1', toAssetId: null, memo: '' };
  assert.notStrictEqual(sandbox.csvDedupeKey(byId), sandbox.csvDedupeKey(byName));
  assert.strictEqual(sandbox.csvDedupeKey(byId), sandbox.csvDedupeKey({ ...byId }));
});
test('buildImportPreview: doExport가 내보낸 CSV를 그대로 다시 가져오려 하면 전부 중복으로 건너뛴다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const txns = [{ id: 't1', date: '2026-01-01', type: 'expense', category: '식비', amount: -5000, fromAssetId: 'a1', toAssetId: null, memo: '점심' }];
  const csv = sandbox.txnsToCSV(txns, assets);
  const preview = sandbox.buildImportPreview(csv, assets, { expense: ['식비'], income: [], saving: [] }, txns);
  assert.strictEqual(preview.totalRows, 1);
  assert.strictEqual(preview.newCount, 0);
  assert.strictEqual(preview.dupCount, 1);
});
test('buildImportPreview: 기존에 없는 내역만 새 항목으로 세고, 없는 카테고리는 자동 생성 목록에 담는다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2026-01-01,지출,새카테고리,5000,주계좌,,점심\r\n' +
    'bad-row,지출,식비,abc,,,\r\n';
  const preview = sandbox.buildImportPreview(csv, assets, { expense: ['식비'], income: [], saving: [] }, []);
  assert.strictEqual(preview.totalRows, 2);
  assert.strictEqual(preview.invalidCount, 1);
  assert.strictEqual(preview.newCount, 1);
  assert.deepStrictEqual(Array.from(preview.newCats.expense), ['새카테고리']);
});
test('buildImportPreview: 같은 파일 안에서 완전히 똑같은 행이 반복되면 두 번째부터는 중복으로 건너뛴다', () => {
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2026-01-01,지출,식비,5000,,,점심\r\n2026-01-01,지출,식비,5000,,,점심\r\n';
  const preview = sandbox.buildImportPreview(csv, [], { expense: ['식비'], income: [], saving: [] }, []);
  assert.strictEqual(preview.newCount, 1);
  assert.strictEqual(preview.dupCount, 1);
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
test("recApply: scope='future' 삭제는 endDate와 함께 count도 재계산해, clampRecurringToMaturity()가 이 명시적 삭제를 '자동 클램프'로 오인해 나중에 만기 연장 시 되살리지 않도록 한다(app-evolve cycle48)", () => {
  sandbox.TWi = -1;
  const r = maturityRec({ toAssetId: 'a2', endDate: null, count: null });
  sandbox.DB = { recurrences: [r] };
  sandbox.lastUndo = null;
  sandbox.recApply('r1', '2026-02-15', 'delete', 'future');
  assert.strictEqual(r.endDate, '2026-02-14', '이후 반복을 끊기 위해 하루 전날로 endDate가 설정되어야 함');
  assert.ok(r.count, 'endDate만 있고 count가 없으면 자동 클램프로 오인되므로, 명시적 삭제 시에도 다른 저장 경로들처럼 count를 함께 채워야 함');
  sandbox.clampRecurringToMaturity('a2', '2026-09-01', '2026-03-01'); // 이후 만기를 연장해도
  assert.strictEqual(r.endDate, '2026-02-14', '사용자가 명시적으로 삭제한 이후 회차가 만기 연장으로 되살아나면 안 됨(회귀 확인)');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.endDate, null, '되돌리면 endDate가 원래 값으로 복원되어야 함');
  assert.strictEqual(r.count, null, '되돌리면 count도 원래 값으로 복원되어야 함');
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
  sandbox.txDraft = { amount: 5000 };
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
  sandbox.txDraft = { amount: 222 };
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
  sandbox.txDraft = { amount: 7000 };
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
test("recSave: scope='future' 분할은 effectiveDate 이후의 skip/edits를 새 레코드로 옮기고, 이전 것은 원본에 남긴다(안 옮기면 개별 삭제·수정 이력이 조용히 사라짐)", () => {
  sandbox.TWi = -1;
  const r = {
    id: 'r1', amount: 1000, endDate: null,
    skip: ['2026-01-01', '2026-04-01', '2026-05-01'],
    edits: { '2026-02-01': { amount: 11 }, '2026-06-01': { amount: 22 } },
  };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-03-01', scope: 'future' };
  sandbox.txDraft = { amount: 7000 };
  sandbox.recSave();
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  // vm 샌드박스 안에서 새로 만들어진 edits 객체는 host의 Object와 realm이 달라 deepStrictEqual이
  // (값은 같아도) 실패하므로, JSON.stringify로 정규화해 비교한다(위 budgetProgress 테스트와 같은 이유).
  assert.deepStrictEqual(r.skip, ['2026-01-01'], 'effectiveDate 이전의 skip은 원본에 남아야 함');
  assert.strictEqual(JSON.stringify(r.edits), JSON.stringify({ '2026-02-01': { amount: 11 } }), 'effectiveDate 이전의 edits는 원본에 남아야 함');
  assert.deepStrictEqual(newRec.skip, ['2026-04-01', '2026-05-01'], 'effectiveDate 이후(포함)의 skip은 새 레코드로 옮겨져야 함');
  assert.strictEqual(JSON.stringify(newRec.edits), JSON.stringify({ '2026-06-01': { amount: 22 } }), 'effectiveDate 이후(포함)의 edits는 새 레코드로 옮겨져야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(r.skip, ['2026-01-01', '2026-04-01', '2026-05-01'], '되돌리면 원본의 skip이 분할 이전 상태로 복원되어야 함');
  assert.strictEqual(JSON.stringify(r.edits), JSON.stringify({ '2026-02-01': { amount: 11 }, '2026-06-01': { amount: 22 } }), '되돌리면 원본의 edits가 분할 이전 상태로 복원되어야 함');
});
test("recSave: scope='future' 분할 시 원래 반복에 종료일이 있었다면 새 레코드도 그 종료일을 물려받아야 한다(무한 반복으로 바뀌면 안 됨)", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: '2026-12-05', count: 12, skip: [], edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-06-05', scope: 'future' };
  sandbox.txDraft = { amount: 2000 };
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
  sandbox.txDraft = { amount: 2000 };
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
  sandbox.txDraft = { amount: 9999 };
  sandbox.recSave();
  assert.strictEqual(r.amount, 9999);
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.amount, 1000, '되돌리면 원래 금액으로 복원되어야 함');
});
/* recApply()가 여는 반복 편집 시트는 #txMemo를 고쳐 recDraft가 아닌 txDraft.memo에 담는데,
   recSave()는 (app-evolve cycle55 develop 이전까지) num($('txAmt'))로 금액만 직접 읽고
   syncTxInputs()를 부르지 않아 이 메모 편집이 세 scope 모두 조용히 버려졌다(cycle55 review 발견,
   cycle55 critique 채택). recSave()가 이제 시작부에서 syncTxInputs()를 부르므로(mock은 no-op이라
   아래 테스트들은 실제 DOM 대신 sandbox.txDraft를 직접 세팅해 그 결과를 흉내낸다), 세 scope
   모두 memo가 실제로 반영되는지 확인한다. */
test("recSave: scope='one' 수정은 메모 편집도 r.edits[date].memo에 함께 기록한다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, category: '월세', memo: '월세', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'one' };
  sandbox.txDraft = { amount: 1000, memo: '2월 월세 (관리비 포함)' };
  sandbox.recSave();
  // vm 샌드박스 안에서 만들어진 edits[date] 객체는 host Object와 realm이 달라 deepStrictEqual이
  // (값은 같아도) 실패하므로, JSON.stringify로 정규화해 비교한다(위 future 분할 테스트와 같은 이유).
  assert.strictEqual(JSON.stringify(r.edits['2026-02-05']), JSON.stringify({ amount: 1000, memo: '2월 월세 (관리비 포함)' }), '해당 날짜 edits에 금액과 메모가 함께 기록되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.edits['2026-02-05'], undefined, '되돌리면 이전에 없던 날짜의 edits는 제거되어야 함');
});
test("recSave: scope='one'에서 메모를 공백만 입력하면 saveTx/saveRec과 동일하게 반복의 카테고리로 대체된다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, category: '구독', memo: '넷플릭스', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'one' };
  sandbox.txDraft = { amount: 1000, memo: '   ' };
  sandbox.recSave();
  assert.strictEqual(r.edits['2026-02-05'].memo, '구독', '공백만 있는 메모는 카테고리로 대체되어야 함');
});
test("recSave: scope='future' 수정은 메모 편집을 새로 분리된 레코드의 memo에 반영한다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, category: '급여', memo: '급여', endDate: null, skip: [], edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-03-01', scope: 'future' };
  sandbox.txDraft = { amount: 3000000, memo: '이직 후 급여' };
  sandbox.recSave();
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  assert.strictEqual(newRec.memo, '이직 후 급여', '새로 분리된 레코드의 메모가 편집값을 반영해야 함');
  assert.strictEqual(r.memo, '급여', '과거로 남는 원본 레코드의 메모는 바뀌지 않아야 함');
});
test("recSave: scope='all' 수정은 메모 편집을 r.memo에 반영하고, undo하면 이전 메모로 돌아간다", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', amount: 1000, category: '구독', memo: '넷플릭스' };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'all' };
  sandbox.txDraft = { amount: 1000, memo: '넷플릭스 프리미엄' };
  sandbox.recSave();
  assert.strictEqual(r.memo, '넷플릭스 프리미엄', '반복 전체의 메모가 편집값으로 바뀌어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.memo, '넷플릭스', '되돌리면 이전 메모로 복원되어야 함');
});
test('recSave: 튜토리얼 모드 중에는 twGuard가 막아서 실제로 수정되지 않는다', () => {
  sandbox.TWi = 0;
  const r = { id: 'r1', amount: 1000 };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'all' };
  sandbox.txDraft = { amount: 9999 };
  sandbox.recSave();
  assert.strictEqual(r.amount, 1000, '튜토리얼 중에는 수정이 막혀야 함');
  assert.strictEqual(sandbox.window._recCtx.recId, 'r1', '튜토리얼 중에는 _recCtx도 지워지지 않아야 함(가드가 최상단에서 반환하므로)');
  sandbox.TWi = -1;
  sandbox.window._recCtx = null;
});

/* ---------- saveRec(): 반복 자체 세부 편집(openRecDetail→editRec→saveRec)이 과거 회차까지
   소급 변경하던 버그(cycle29 critique) — recSave()의 future 분기와 같은 분리 규칙을 적용한다 ---------- */
test('recHistFieldsChanged: fromAssetId/toAssetId/amount/category/day/freq가 바뀌면 true', () => {
  const orig = { fromAssetId: 'a1', toAssetId: 'a2', amount: 1000, category: '식비', day: 5, freq: 'monthly', memo: 'm', weekend: 'none' };
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, fromAssetId: 'a9' }), true);
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, amount: 2000 }), true);
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, freq: 'weekly' }), true);
});
test('recHistFieldsChanged: 메모/주말규칙 등 이력 비영향 필드만 바뀌면 false', () => {
  const orig = { fromAssetId: 'a1', toAssetId: 'a2', amount: 1000, category: '식비', day: 5, freq: 'monthly', memo: 'm', weekend: 'none' };
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, memo: '다른 메모', weekend: 'later' }), false);
});

test('splitRecurrenceAt: 원본은 effectiveDate 직전까지로 잘리고 count가 재계산된다', () => {
  const orig = { id: 'r1', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: '2026-12-05', count: 12, amount: 1000, fromAssetId: 'a1' };
  const draft = { ...orig, amount: 2000, fromAssetId: 'a9' };
  const { updatedOriginal, newRec } = sandbox.splitRecurrenceAt(orig, draft, '2026-06-05');
  assert.strictEqual(updatedOriginal.endDate, '2026-06-04', '원본은 새 시작일 하루 전에 끊겨야 함');
  assert.strictEqual(updatedOriginal.count, 5, '2026-01-05~2026-06-04 매월 5일=5회');
  assert.strictEqual(updatedOriginal.amount, 1000, '원본 필드는 옛 값 그대로 유지되어야 함(소급 변경 금지)');
});
test('splitRecurrenceAt: 새 레코드는 effectiveDate부터 새 필드값으로, 원래 종료일을 물려받는다', () => {
  const orig = { id: 'r1', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: '2026-12-05', count: 12, amount: 1000, fromAssetId: 'a1', skip: ['2026-01-05'], edits: { '2026-01-05': { amount: 1 } } };
  const draft = { ...orig, amount: 2000, fromAssetId: 'a9' };
  const { newRec } = sandbox.splitRecurrenceAt(orig, draft, '2026-06-05');
  assert.notStrictEqual(newRec.id, orig.id, '새 레코드는 별도 id를 가져야 함');
  assert.strictEqual(newRec.startDate, '2026-06-05');
  assert.strictEqual(newRec.amount, 2000);
  assert.strictEqual(newRec.fromAssetId, 'a9');
  assert.strictEqual(newRec.endDate, '2026-12-05', '원래 종료일을 물려받아야 함');
  assert.strictEqual(newRec.count, 7, '2026-06-05~2026-12-05 매월 5일=7회');
  assert.strictEqual(newRec.skip.length, 0, '원본의 skip을 물려받지 않아야 함');
  assert.strictEqual(Object.keys(newRec.edits).length, 0, '원본의 edits를 물려받지 않아야 함');
});
test('splitRecurrenceAt: 원본이 무기한(endDate=null)이면 새 레코드도 무기한으로 유지된다', () => {
  const orig = { id: 'r1', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000 };
  const { newRec } = sandbox.splitRecurrenceAt(orig, { ...orig, amount: 2000 }, '2026-06-05');
  assert.strictEqual(newRec.endDate, null);
  assert.strictEqual(newRec.count, null);
});
test('splitRecurrenceAt: effectiveDate 이후(포함)의 skip/edits는 새 레코드로, 이전 것은 원본에 남는다', () => {
  const orig = {
    id: 'r1', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: '2026-12-05', count: 12, amount: 1000, fromAssetId: 'a1',
    skip: ['2026-02-05', '2026-06-05', '2026-09-05'],
    edits: { '2026-03-05': { amount: 1 }, '2026-08-05': { amount: 2 } },
  };
  const draft = { ...orig, amount: 2000, fromAssetId: 'a9' };
  const { updatedOriginal, newRec } = sandbox.splitRecurrenceAt(orig, draft, '2026-06-05');
  assert.deepStrictEqual(updatedOriginal.skip, ['2026-02-05'], 'effectiveDate 이전 skip은 원본에 남아야 함');
  // edits는 vm 샌드박스 안에서 새로 만들어진 객체라 host realm과 프로토타입이 달라 deepStrictEqual이
  // 값이 같아도 실패한다(위 budgetProgress 테스트와 같은 이유) — JSON.stringify로 정규화해 비교한다.
  assert.strictEqual(JSON.stringify(updatedOriginal.edits), JSON.stringify({ '2026-03-05': { amount: 1 } }), 'effectiveDate 이전 edits는 원본에 남아야 함');
  assert.deepStrictEqual(newRec.skip, ['2026-06-05', '2026-09-05'], 'effectiveDate 이후(포함) skip은 새 레코드로 옮겨져야 함(전에는 조용히 사라지는 버그가 있었음)');
  assert.strictEqual(JSON.stringify(newRec.edits), JSON.stringify({ '2026-08-05': { amount: 2 } }), 'effectiveDate 이후(포함) edits는 새 레코드로 옮겨져야 함(전에는 조용히 사라지는 버그가 있었음)');
});

test('saveRec: 과거 회차가 있는 반복에서 결제 계좌(fromAssetId)를 바꿔 저장하면, 곧바로 덮어쓰지 않고 범위 확인 시트를 띄운다', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), fromAssetId: 'a2' };
  sandbox.lastSheetHtml = null;
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '확인 없이 즉시 분리/덮어쓰기가 일어나면 안 됨');
  assert.strictEqual(r.fromAssetId, 'a1', '확인 전에는 원본이 그대로여야 함');
  assert.ok(sandbox.lastSheetHtml, '범위 확인 시트가 떠야 함');
  assert.ok(sandbox.window._recSaveScope, '확인 시트의 선택을 처리할 컨텍스트가 저장되어야 함');
});
test("saveRec: 범위 확인 시트에서 '오늘부터 이후 모두'를 고르면 과거 회차는 원래 값대로 남고 오늘부터만 새 값이 적용된다", () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), fromAssetId: 'a2' };
  sandbox.saveRec();
  sandbox.recSaveScopeApply('future');
  assert.strictEqual(sandbox.DB.recurrences.length, 2);
  const pastRec = sandbox.DB.recurrences.find(x => x.id === 'r1');
  assert.strictEqual(pastRec.fromAssetId, 'a1', '과거 구간(원본)의 결제 계좌는 그대로 유지되어야 함 — 소급 변경 금지');
  assert.strictEqual(pastRec.endDate, '2026-06-14', '원본은 오늘 하루 전까지로 끊겨야 함');
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  assert.strictEqual(newRec.fromAssetId, 'a2', '오늘부터의 새 구간은 새 결제 계좌를 써야 함');
  assert.strictEqual(newRec.startDate, '2026-06-15');
});
test("saveRec: 범위 확인 시트에서 '전체 적용'을 고르면 기존처럼 통째로 덮어쓴다(명시적 선택 시에만)", () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), fromAssetId: 'a2' };
  sandbox.saveRec();
  sandbox.recSaveScopeApply('all');
  assert.strictEqual(sandbox.DB.recurrences.length, 1);
  assert.strictEqual(sandbox.DB.recurrences[0].fromAssetId, 'a2');
});
test('saveRec: 과거 회차가 없는 반복(시작일이 아직 안 옴)은 확인 시트 없이 즉시 적용된다', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-07-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), fromAssetId: 'a2' };
  sandbox.lastSheetHtml = null;
  sandbox.saveRec();
  assert.strictEqual(sandbox.lastSheetHtml, null, '아직 지난 회차가 없으므로 확인 시트가 뜨면 안 됨');
  assert.strictEqual(sandbox.DB.recurrences.length, 1);
  assert.strictEqual(sandbox.DB.recurrences[0].fromAssetId, 'a2', '즉시 적용되어야 함');
});
test('saveRec: 이력 비영향 필드(메모 등)만 바뀌면 과거 회차가 있어도 확인 시트 없이 즉시 적용된다', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true, weekend: 'none' };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), memo: '월세' };
  sandbox.lastSheetHtml = null;
  sandbox.saveRec();
  assert.strictEqual(sandbox.lastSheetHtml, null, '이력 비영향 필드만 바뀌면 확인 없이 바로 적용되어야 함');
  assert.strictEqual(sandbox.DB.recurrences[0].memo, '월세');
});
test('saveRec: 신규 반복 등록(id 없음)은 기존처럼 회귀 없이 바로 추가된다', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  sandbox.DB = { recurrences: [] };
  sandbox.recDraft = { id: null, type: 'expense', freq: 'monthly', day: 5, startDate: '2026-07-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, active: true };
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 1);
  assert.strictEqual(sandbox.DB.recurrences[0].id, 'test-uid');
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
test('saveQuickAmount: 실제 금액이 0원(무료/크레딧 처리 등)이어도 정상 저장된다(app-evolve cycle44)', () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', category: '변동비', memo: '변동비', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.qAmtValue = '0';
  sandbox.lastUndo = null;
  sandbox.lastToast = null;
  sandbox.saveQuickAmount('r1', '2026-02-05');
  assert.strictEqual(r.edits['2026-02-05'].amount, 0, '0원도 유효한 실제 금액으로 edits에 기록되어야 함');
  assert.strictEqual(sandbox.lastToast, null, '0원 저장은 안내 토스트 없이 성공해야 함');
  assert.ok(sandbox.lastUndo, '0원 저장도 undoToast가 호출되어야 함');
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

/* ---------- lastActualAmount/openQuickAmount: 직전 실제 금액이 0원인 경우를 "데이터 없음"과
   구분해야 한다(app-evolve cycle44 review 부수 발견 -> cycle45 develop에서 수정) ---------- */
test('lastActualAmount: 직전 회차 실제 금액이 0원이면 0을 그대로 돌려준다(데이터 없음과 구분)', () => {
  const r = { edits: { '2026-02-05': { amount: 0 } } };
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-03-05'), 0);
});
test('lastActualAmount: 직전 실제 금액 기록이 없으면 반복의 기본 금액을 돌려준다', () => {
  const r = { amount: 5000, edits: {} };
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-03-05'), 5000);
});
test('lastActualAmount: 기본 금액조차 없는 손상된 레코드면 null을 돌려준다(0원과 구분)', () => {
  const r = { edits: {} };
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-03-05'), null);
});
test('openQuickAmount: 직전 실제 금액이 0원이었으면 "0원이었어요" 힌트와 함께 입력값도 0으로 미리 채운다', () => {
  const r = { id: 'r1', type: 'expense', category: '변동비', memo: '변동비', edits: { '2026-02-05': { amount: 0 } } };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastSheetHtml = null;
  sandbox.openQuickAmount('r1', '2026-03-05');
  assert.ok(sandbox.lastSheetHtml.includes('지난달은 0원이었어요'), '0원도 유효한 지난 기록으로 힌트에 노출되어야 함');
  assert.ok(sandbox.lastSheetHtml.includes('value="0"'), '입력값도 0으로 미리 채워져야 함');
});
test('openQuickAmount: 지난 기록이 전혀 없는 손상된 레코드면 힌트를 띄우지 않고 입력값도 비워둔다', () => {
  const r = { id: 'r1', type: 'expense', category: '변동비', memo: '변동비', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastSheetHtml = null;
  sandbox.openQuickAmount('r1', '2026-03-05');
  assert.ok(!sandbox.lastSheetHtml.includes('이었어요'), '지난 기록이 없으면 힌트가 없어야 함');
  assert.ok(sandbox.lastSheetHtml.includes('value=""'), '지난 기록이 없으면 입력값도 비어 있어야 함');
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

/* ---------- shouldWarnUnpersisted: storage eviction 경고 카드 노출 판정 ---------- */
test('shouldWarnUnpersisted: persisted=false이고 클라우드 미연결이면 경고한다(로컬이 유일한 사본)', () => {
  assert.strictEqual(sandbox.shouldWarnUnpersisted(false, false), true);
});
test('shouldWarnUnpersisted: persisted=false여도 클라우드가 연결돼 있으면 경고하지 않는다(서버에 사본 있음)', () => {
  assert.strictEqual(sandbox.shouldWarnUnpersisted(false, true), false);
});
test('shouldWarnUnpersisted: 이미 persisted면 경고하지 않는다', () => {
  assert.strictEqual(sandbox.shouldWarnUnpersisted(true, false), false);
});
test('shouldWarnUnpersisted: API 미지원 등으로 아직 확인 전(null)이면 경고하지 않는다', () => {
  assert.strictEqual(sandbox.shouldWarnUnpersisted(null, false), false);
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

/* ---------- sanitizeAmount/sanitizeBackup: 백업 복원·클라우드 동기화 데이터 숫자 필드 검증 ---------- */
test('sanitizeAmount: NaN(비숫자 문자열 등)은 0으로 보정한다', () => {
  assert.strictEqual(sandbox.sanitizeAmount('abc'), 0);
  assert.strictEqual(sandbox.sanitizeAmount(undefined), 0);
  assert.strictEqual(sandbox.sanitizeAmount(NaN), 0);
});
test('sanitizeAmount: 숫자로 파싱 가능한 문자열은 숫자로 변환한다', () => {
  assert.strictEqual(sandbox.sanitizeAmount('1234'), 1234);
});
test('sanitizeAmount: min이 없으면 음수도 그대로 유효하다(잔액성 필드)', () => {
  assert.strictEqual(sandbox.sanitizeAmount(-500), -500);
});
test('sanitizeAmount: min이 주어지면 그 아래로 클램프한다(수량성 필드)', () => {
  assert.strictEqual(sandbox.sanitizeAmount(-500, 0), 0);
  assert.strictEqual(sandbox.sanitizeAmount(3, 0), 3);
});
test('sanitizeBackup: 거래의 NaN/문자열 금액을 보정하고 fixedCount를 센다', () => {
  const { data, fixedCount, droppedCount } = sandbox.sanitizeBackup({
    assets: [],
    txns: [{ id: 't1', date: '2026-01-01', amount: 'oops' }, { id: 't2', date: '2026-01-02', amount: '5000' }],
  });
  assert.strictEqual(data.txns[0].amount, 0);
  assert.strictEqual(data.txns[1].amount, 5000);
  assert.strictEqual(fixedCount, 2);
  assert.strictEqual(droppedCount, 0);
});
test('sanitizeBackup: 자산의 보유수량 필드(fxAmount/goldDon/stockQty)는 음수면 0으로 클램프한다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [],
    assets: [{ id: 'a1', type: 'fx', fxAmount: -100 }, { id: 'a2', type: 'gold', goldDon: -3 }],
  });
  assert.strictEqual(data.assets[0].fxAmount, 0);
  assert.strictEqual(data.assets[1].goldDon, 0);
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: 자산의 잔액성 필드(baseAmount/amountKRW)는 음수를 그대로 허용한다(오버드로우 등 유효 상태)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [],
    assets: [{ id: 'a1', type: 'cash', baseAmount: -1000 }],
  });
  assert.strictEqual(data.assets[0].baseAmount, -1000);
  assert.strictEqual(fixedCount, 0);
});
test('sanitizeBackup: id/date 등 필수 필드가 없는 레코드는 통째로 제거하고 droppedCount로 센다', () => {
  const { data, droppedCount } = sandbox.sanitizeBackup({
    txns: [{ id: 't1', date: '2026-01-01', amount: 100 }, { id: 't2', amount: 200 }, { date: '2026-01-03', amount: 300 }],
    assets: [{ id: 'a1', type: 'cash' }, { id: 'a2' }, { type: 'gold' }],
  });
  assert.strictEqual(data.txns.length, 1, 'date 없는 거래는 제거되어야 함');
  assert.strictEqual(data.assets.length, 1, 'type 없는 자산은 제거되어야 함');
  assert.strictEqual(droppedCount, 4);
});
test('sanitizeBackup: assets/txns가 없거나 배열이 아니어도 터지지 않고 빈 배열로 처리한다', () => {
  const { data, fixedCount, droppedCount } = sandbox.sanitizeBackup({});
  assert.strictEqual(data.txns.length, 0);
  assert.strictEqual(data.assets.length, 0);
  assert.strictEqual(fixedCount, 0);
  assert.strictEqual(droppedCount, 0);
});
test('sanitizeBackup: 원본 obj를 변형하지 않는다', () => {
  const orig = { txns: [{ id: 't1', date: '2026-01-01', amount: 'bad' }], assets: [] };
  const origAmount = orig.txns[0].amount;
  sandbox.sanitizeBackup(orig);
  assert.strictEqual(orig.txns[0].amount, origAmount, '원본 레코드는 그대로 유지되어야 함');
});
test('sanitizeBackup: 반복거래의 NaN/문자열 금액도 보정한다(매달 새로 생기는 거래라 방치하면 무한히 오염됨)', () => {
  const { data, fixedCount, droppedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [{ id: 'r1', startDate: '2026-01-01', amount: '오만원' }, { id: 'r2', startDate: '2026-01-01', amount: 50000 }],
  });
  assert.strictEqual(data.recurrences[0].amount, 0);
  assert.strictEqual(data.recurrences[1].amount, 50000);
  assert.strictEqual(fixedCount, 1);
  assert.strictEqual(droppedCount, 0);
});
test('sanitizeBackup: 반복거래 회차별 수정(edits[date].amount)도 검증한다(expandRec이 그대로 소비함)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [{ id: 'r1', startDate: '2026-01-01', amount: 10000, edits: { '2026-02-01': { amount: 'bad' }, '2026-03-01': { amount: 20000 } } }],
  });
  assert.strictEqual(data.recurrences[0].edits['2026-02-01'].amount, 0);
  assert.strictEqual(data.recurrences[0].edits['2026-03-01'].amount, 20000);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: id 없는 반복거래는 제거하고, recurrences가 없거나 배열이 아니어도 터지지 않는다', () => {
  const dropped = sandbox.sanitizeBackup({ txns: [], assets: [], recurrences: [{ startDate: '2026-01-01', amount: 1000 }] });
  assert.strictEqual(dropped.data.recurrences.length, 0);
  assert.strictEqual(dropped.droppedCount, 1);
  const missing = sandbox.sanitizeBackup({});
  assert.strictEqual(missing.data.recurrences.length, 0);
});
test('sanitizeBackup: startDate 없는 반복거래는 제거한다(recDates()가 Invalid Date로 무한루프에 빠지는 것을 방지)', () => {
  const { data, droppedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [{ id: 'r1', amount: 1000 }, { id: 'r2', startDate: '2026-01-01', amount: 2000 }],
  });
  assert.strictEqual(data.recurrences.length, 1, 'startDate 없는 레코드는 제거되어야 함');
  assert.strictEqual(data.recurrences[0].id, 'r2');
  assert.strictEqual(droppedCount, 1);
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
test('spendByCategory: 이번 달에 쓴 게 없어도 이번 달 기준 예산이 있는 카테고리는 v:0으로 계속 나타난다 (예산 관리 화면에서 사라지지 않아야 함)', () => {
  sandbox.DB = {
    txns: [{ date: '2026-06-05', type: 'expense', category: '식비', amount: 10000 }],
    recurrences: [],
    budgetHistory: { 식비: [{ from: '2026-01', amount: 300000 }], 여행: [{ from: '2026-01', amount: 500000 }] },
  };
  const byCat = Object.fromEntries(Array.from(sandbox.spendByCategory(2026, 6)).map(r => [r.c, r.v]));
  assert.strictEqual(byCat['식비'], 10000, '실제 지출이 있는 예산 카테고리는 기존처럼 실제 합계가 나와야 함');
  assert.strictEqual(byCat['여행'], 0, '이번 달 지출이 0원이라도 예산이 설정돼 있으면 행이 사라지면 안 됨');
});
test('spendByCategory: 예산이 없는 카테고리는 지출이 없으면 여전히 목록에 나타나지 않는다', () => {
  sandbox.DB = {
    txns: [],
    recurrences: [],
    budgetHistory: { 식비: [{ from: '2026-01', amount: 300000 }] },
  };
  const rows = Array.from(sandbox.spendByCategory(2026, 6));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].c, '식비');
});
test('spendByCategory: 조회 중인 달 이전에만 예산이 있고 아직 그 달부터는 시작되지 않은 카테고리는 나타나지 않는다', () => {
  sandbox.DB = {
    txns: [],
    recurrences: [],
    budgetHistory: { 식비: [{ from: '2026-08', amount: 300000 }] }, // 8월부터 시작
  };
  const rows = Array.from(sandbox.spendByCategory(2026, 6)); // 6월 조회
  assert.strictEqual(rows.length, 0, '예산 시작 전 달에는 budgetForMonth가 0이라 행이 나오면 안 됨');
});
test('spendByCategory: DB.budgetHistory가 없어도(undefined) 터지지 않는다', () => {
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

/* ---------- saveAsset: 자산 삭제 후 새 자산을 등록하면 order가 DB.assets.length(=줄어든 개수)로
 * 다시 채워져, 삭제 전에 등록됐던 자산의 order보다 더 작은 값을 받던 버그(app-evolve cycle49 develop).
 * groupItems()의 기본 정렬(a.order-b.order, "그룹 내 등록 순서 유지")이 이 order를 그대로 쓰므로,
 * 방금 등록한 자산이 훨씬 전에 등록된 자산보다 앞에 오는 역전이 생겼다. order를 length가 아니라
 * 기존 order 최댓값+1로 매겨 삭제로 배열이 줄어도 항상 새 값이 됨. ---------- */
test('saveAsset: 오래된 자산을 삭제한 뒤 등록해도 새 자산의 order가 남은 자산보다 작아지지 않는다', () => {
  // A(order=0),B(order=1) 삭제 → C(order=2),D(order=3)만 남음(length=2)
  sandbox.DB = { assets: [{ id: 'c', name: 'C', type: 'cash', order: 2, includeInTotal: true }, { id: 'd', name: 'D', type: 'cash', order: 3, includeInTotal: true }], rates: { stocks: {} }, settings: { assetSort: 'custom' }, owners: ['나'] };
  sandbox.asDraft = { type: 'cash', owner: '나', includeInTotal: true, name: 'E' };
  sandbox.saveAsset(false);
  const e = sandbox.DB.assets.find(a => a.name === 'E');
  assert.ok(e.order > sandbox.DB.assets.find(a => a.name === 'D').order, '삭제로 배열이 줄어도 새 자산의 order는 기존 최댓값보다 커야 함');
  const sorted = sandbox.groupItems('cash').map(a => a.name);
  assert.deepStrictEqual(sorted, ['C', 'D', 'E'], '기본(등록순서) 정렬에서 나중에 만든 자산이 먼저 만든 자산보다 앞서면 안 됨');
});

/* ---------- syncAssetInputs/saveAsset: 자산 이름 입력값이 category/owner 이름과 달리 trim()되지
 * 않던 버그(app-evolve cycle54 develop, Explore 서브에이전트로 발견). 공백만 입력해도
 * saveAsset()의 빈 이름 기본값 대체(d.name=d.name||라벨)가 falsy 체크라 통과하지 못해(공백은
 * truthy) 빈 것처럼 보이는 자산이 그대로 저장됐고, 앞뒤 공백이 붙은 이름은 dup 차단
 * (a.name===d.name)과 삭제된 동명 자산 재연동(deletedAssetHistoryExists)도 비껴갔다.
 * syncAssetInputs()에서 값을 읽을 때 trim()하도록 수정. ---------- */
test('syncAssetInputs: 이름 입력값의 앞뒤 공백을 제거한다', () => {
  sandbox.asDraft = { type: 'cash', owner: '나', includeInTotal: true };
  sandbox.asNameValue = '  우리은행 통장  ';
  sandbox.syncAssetInputs();
  assert.strictEqual(sandbox.asDraft.name, '우리은행 통장', '이름 앞뒤 공백이 제거돼야 함');
  sandbox.asNameValue = undefined;
});
test('saveAsset: 공백만 입력한 이름은 trim 후 빈 문자열이 되어 기본 라벨로 대체된다', () => {
  sandbox.DB = { assets: [], rates: { stocks: {} } };
  sandbox.asDraft = { type: 'cash', owner: '나', includeInTotal: true };
  sandbox.asNameValue = '   ';
  sandbox.saveAsset(false);
  sandbox.asNameValue = undefined;
  const a = sandbox.DB.assets[0];
  assert.ok(a, '자산이 등록됐어야 함');
  assert.strictEqual(a.name, sandbox.ASSET_TYPES.cash.label, '공백만 입력하면 종류 기본 라벨로 대체돼야 함');
});
test('saveAsset: 공백이 붙은 이름은 trim 후 기존 동명 자산과 중복으로 차단된다', () => {
  sandbox.DB = { assets: [{ id: 'a1', name: '비상금', type: 'cash', baseAmount: 1000 }], rates: { stocks: {} } };
  sandbox.asDraft = { type: 'cash', owner: '나', includeInTotal: true };
  sandbox.asNameValue = '  비상금  ';
  sandbox.lastToast = null;
  sandbox.saveAsset(false);
  sandbox.asNameValue = undefined;
  assert.ok(sandbox.lastToast, '앞뒤 공백만 다른 동명 자산도 중복 경고가 떴어야 함');
  assert.strictEqual(sandbox.DB.assets.length, 1, '중복이면 새 자산이 추가되면 안 됨');
});

/* ---------- asToggleNeg: 자산 잔액 필드의 "마이너스 잔액" 토글 (app-evolve cycle56 develop)
 * 마이너스통장처럼 잔액이 음수인 자산을 등록/수정할 때, asAmt 입력창의 inputmode="numeric" 모바일
 * 키패드에는 대개 '-' 키가 없어 fmtAmt(inp,true)만으로는 실제 입력 경로가 없다. asToggleNeg()는
 * asDraft._dispAmt의 부호를 반전해 renderAssetSheet가 다시 그리는 입력창 값에 그대로 반영되게 한다. */
test('asToggleNeg: asDraft._dispAmt의 부호를 반전한다(양수→음수→양수)', () => {
  sandbox.asDraft = { id: 'a1', type: 'cash', _dispAmt: 500000 };
  sandbox.asToggleNeg(true);
  assert.strictEqual(sandbox.asDraft._dispAmt, -500000);
  sandbox.asToggleNeg(true);
  assert.strictEqual(sandbox.asDraft._dispAmt, 500000);
});

/* ---------- asOpenType: 자산 종류를 연금(pension)으로 바꾸면 총자산 제외(includeInTotal=false)가
 * 자동으로 켜지는데(연금은 기본적으로 순자산 계산에서 빠짐), 종류를 다시 다른 걸로 바꿔도 이 자동
 * 제외를 원상복구하지 않던 버그(app-evolve cycle52 develop, Explore 서브에이전트로 발견). 연금이
 * 만기/전환돼 사용자가 자산 종류를 연금→현금예금 등으로 바꾸는 흔한 편집 흐름에서, 그 자산이 총자산에
 * 영구히 안 잡히는 조용한 데이터 결함이 됨. onPick에서 연금으로 바꿀 때만 _pensionAutoExcl 플래그를
 * 남기고, 연금에서 벗어날 때 그 플래그가 있을 때만(=자동으로 꺼진 경우만) includeInTotal을 true로
 * 되돌리도록 수정 — 사용자가 연금과 무관하게 스스로 이 스위치를 꺼둔 경우(플래그 없음)는 건드리지
 * 않는다. saveAsset()도 이 임시 플래그가 asDraft._dispAmt처럼 저장 시 DB.assets에 새는 걸 막도록
 * delete 처리를 추가했다. ---------- */
test('asOpenType: 자산 종류를 연금으로 바꾸면 총자산 제외가 자동으로 켜지고, 다시 다른 종류로 바꾸면 자동으로 풀린다', () => {
  sandbox.asDraft = { id: 'a1', type: 'cash', owner: '나', includeInTotal: true, name: '내 통장' };
  sandbox.asOpenType();
  sandbox.lastTypePickerOnPick('pension');
  assert.strictEqual(sandbox.asDraft.type, 'pension');
  assert.strictEqual(sandbox.asDraft.includeInTotal, false, '연금으로 바꾸면 총자산 제외가 자동으로 켜져야 함');
  sandbox.lastTypePickerOnPick('cash');
  assert.strictEqual(sandbox.asDraft.type, 'cash');
  assert.strictEqual(sandbox.asDraft.includeInTotal, true, '연금에서 벗어나면 자동으로 켜졌던 제외가 자동으로 풀려야 함');
  assert.strictEqual(sandbox.asDraft._pensionAutoExcl, false, '플래그도 함께 꺼져야 다음 번 연금 전환 때 다시 정확히 동작함');
});
test('asOpenType: 사용자가 직접 총자산 제외를 켜둔 자산은 연금을 거치지 않고 종류를 바꿔도 그대로 유지된다', () => {
  sandbox.asDraft = { id: 'a2', type: 'cash', owner: '나', includeInTotal: false, name: '숨긴 통장' };
  sandbox.asOpenType();
  sandbox.lastTypePickerOnPick('savings');
  assert.strictEqual(sandbox.asDraft.includeInTotal, false, '연금 자동 로직과 무관하게 사용자가 직접 꺼둔 값은 종류 변경만으로 켜지면 안 됨');
});
test('saveAsset: 연금 전환 시 임시로 남긴 _pensionAutoExcl 플래그가 저장된 자산 객체에 새지 않는다', () => {
  sandbox.DB = { assets: [], rates: { stocks: {} }, settings: {}, owners: ['나'] };
  sandbox.asDraft = { type: 'pension', owner: '나', includeInTotal: false, _pensionAutoExcl: true, name: '연금' };
  sandbox.saveAsset(false);
  const saved = sandbox.DB.assets.find(a => a.name === '연금');
  assert.ok(!('_pensionAutoExcl' in saved), '임시 플래그가 저장 시 DB.assets에 그대로 남으면 안 됨');
});

/* ---------- openAssetSheet/asOpenType: cycle52 develop 커밋의 _pensionAutoExcl 복원 로직이
 * 이 플래그를 onPick 호출 안에서만 세팅해, "이번 편집 세션에서 먼저 pension으로 바꿨다가 다시
 * 되돌리는" 왕복에만 동작하고, 정작 커밋 설명이 든 실사용 흐름 — 이미 DB에 저장돼 있던 기존 연금
 * 자산을 열어 종류를 곧장 다른 걸로 바꾸는 만기/전환 편집 — 에서는 asDraft가 DB에서 그대로
 * 복제되므로 _pensionAutoExcl이 애초에 없어 복원이 안 되던 잔여 버그(app-evolve cycle52 review로
 * 발견). openAssetSheet()가 편집 대상을 연금으로 로드할 때 _pensionAutoExcl을 다시 참으로 간주하게
 * 고쳐 실사용 흐름에서도 asOpenType의 복원 로직이 동작하게 함. ---------- */
test('openAssetSheet: DB에 저장돼 있던 기존 연금 자산을 열어 곧장 다른 종류로 바꿔도 총자산 제외가 자동으로 풀린다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'p1', type: 'pension', owner: '나', includeInTotal: false, name: '국민연금', amountKRW: 24000000 }],
    txns: [],
    recurrences: [],
  };
  sandbox._balCache.clear();
  sandbox.openAssetSheet('p1');
  assert.strictEqual(sandbox.asDraft._pensionAutoExcl, true, '기존 연금 자산을 열면 이번 세션에서 pension을 거치지 않았어도 자동 제외 상태로 간주해야 함');
  sandbox.asOpenType();
  sandbox.lastTypePickerOnPick('cash');
  assert.strictEqual(sandbox.asDraft.type, 'cash');
  assert.strictEqual(sandbox.asDraft.includeInTotal, true, '연금을 거치지 않고 곧장 다른 종류로 바꿔도(만기/전환 편집의 실사용 흐름) 총자산 제외가 자동으로 풀려야 함');
});

/* ---------- rateUnknown/saveAsset: 새로 등록한 fx/gold/stock 자산이 시세 미동기화 상태에서
 * 조용히 ₩0으로 평가되던 버그 (cycle31 critique). assetEval()의 (R.x||0) 폴백은 '아직 시세를
 * 못 받아온 상태'와 '실제 0원'을 구분하지 못하므로, saveAsset()이 신규 stockCode를 등록할 때
 * DB.rates.stocks[code]=0으로 미리 채우던 걸 없애 키 부재로 미확인 상태를 구분하고,
 * 그 상태면 autoSyncRates()의 10분 TTL을 기다리지 않고 즉시 syncRates(true)를 부르게 했다. ---------- */
test('rateUnknown: fx/gold/stock은 시세를 아직 못 받아왔으면 참, 받아왔으면 거짓', () => {
  sandbox.DB = { rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  assert.strictEqual(sandbox.rateUnknown({ type: 'fx', currency: 'USD' }), true);
  sandbox.DB.rates.fx.USD = 1350;
  assert.strictEqual(sandbox.rateUnknown({ type: 'fx', currency: 'USD' }), false);
  assert.strictEqual(sandbox.rateUnknown({ type: 'gold' }), true);
  sandbox.DB.rates.goldPerG = 550000;
  assert.strictEqual(sandbox.rateUnknown({ type: 'gold' }), false);
  assert.strictEqual(sandbox.rateUnknown({ type: 'stock', stockCode: '005930' }), true);
  sandbox.DB.rates.stocks['005930'] = 70000;
  assert.strictEqual(sandbox.rateUnknown({ type: 'stock', stockCode: '005930' }), false);
});
test('rateUnknown: 시세와 무관한 자산 타입(현금·저축 등)은 항상 거짓', () => {
  sandbox.DB = { rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  assert.strictEqual(sandbox.rateUnknown({ type: 'cash' }), false);
  assert.strictEqual(sandbox.rateUnknown({ type: 'savings' }), false);
  assert.strictEqual(sandbox.rateUnknown({ type: 'debt' }), false);
});
test('saveAsset: 새 종목코드를 등록해도 더 이상 DB.rates.stocks를 0으로 미리 채우지 않고, 미확인 상태라 즉시 시세 동기화를 부른다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 10 };
  sandbox.syncRatesCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 1);
  assert.strictEqual(sandbox.DB.rates.stocks['005930'], undefined, '아직 시세를 못 받아온 종목코드는 0으로 미리 채워지면 안 됨(미확인과 구분 불가해짐)');
  assert.deepStrictEqual(sandbox.syncRatesCalls, [true], '미확인 상태의 새 자산을 등록하면 TTL을 기다리지 않고 즉시 동기화해야 함');
});
test('saveAsset: 이미 시세를 알고 있는 종목을 수정할 때는 즉시 동기화를 부르지 않는다', () => {
  const asset = { id: 'a1', type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 10 };
  sandbox.DB = { assets: [asset], rates: { fx: {}, stocks: { '005930': 70000 }, goldPerG: 0 } };
  sandbox.asDraft = { id: 'a1', type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 20 };
  sandbox.syncRatesCalls = [];
  sandbox.saveAsset(true);
  assert.deepStrictEqual(sandbox.syncRatesCalls, [], '이미 시세를 알고 있으면 즉시 동기화를 부를 필요가 없음');
});
test('saveAsset: 처음 보는 fx 통화를 등록하면 즉시 동기화하고, 이미 보유 중이라 알고 있는 통화는 부르지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: { USD: 1350 }, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'fx', owner: '나', includeInTotal: true, name: '엔화', currency: 'JPY', fxAmount: 1000 };
  sandbox.syncRatesCalls = [];
  sandbox.saveAsset(false);
  assert.deepStrictEqual(sandbox.syncRatesCalls, [true], '처음 등록하는 통화는 시세를 몰라 즉시 동기화해야 함');

  sandbox.asDraft = { type: 'fx', owner: '나', includeInTotal: true, name: '달러', currency: 'USD', fxAmount: 500 };
  sandbox.syncRatesCalls = [];
  sandbox.saveAsset(false);
  assert.deepStrictEqual(sandbox.syncRatesCalls, [], '이미 보유 중인 통화라 시세를 알고 있으면 부를 필요가 없음');
});

/* ---------- clampRecurringToMaturity: 저축 만기일을 당겼다가 다시 늘려도 자동이체가 예전 만기에
 * 멈춘 채로 영영 안 늘어나던 버그(cycle46 develop). 종료일만 있고 count가 없는 건 이 함수가 자동으로
 * 잘라둔 값이라는 기존 불변식(사용자가 직접 정하면 항상 count가 함께 저장됨, saveRec/saveTx 참고)을
 * 이용해, 만기가 실제로 연장됐고 그 auto-clamp 흔적일 때만 다시 늘려준다. ---------- */
function maturityRec(overrides) {
  return Object.assign({
    id: 'r1', active: true, type: 'saving', category: '저축', memo: '적금이체',
    amount: 300000, fromAssetId: 'a1', toAssetId: 'a2',
    freq: 'monthly', day: 15, startDate: '2026-01-15', endDate: null, count: null, weekend: 'none',
    skip: [], edits: {},
  }, overrides);
}
test('clampRecurringToMaturity: 만기가 생기면 그 만기 이하의 마지막 회차로 종료일을 잘라준다', () => {
  const rec = maturityRec();
  sandbox.DB = { recurrences: [rec] };
  sandbox.clampRecurringToMaturity('a2', '2026-03-01');
  assert.strictEqual(rec.endDate, '2026-02-15', '3/1 만기 이하의 마지막 회차는 2/15');
  assert.ok(!rec.count, '자동으로 자른 종료일은 count가 없어(falsy) 사용자가 정한 값과 구분되게 함');
});
test('clampRecurringToMaturity: 만기를 당겼다가 다시 늘리면(연장) 자동으로 잘렸던 자동이체가 새 만기까지 다시 늘어난다', () => {
  const rec = maturityRec();
  sandbox.DB = { recurrences: [rec] };
  sandbox.clampRecurringToMaturity('a2', '2026-03-01'); // 1차: 만기가 3/1로 생겨 2/15까지 잘림
  assert.strictEqual(rec.endDate, '2026-02-15');
  sandbox.clampRecurringToMaturity('a2', '2026-09-01', '2026-03-01'); // 2차: 만기를 9/1로 연장(prevMaturity=3/1 전달)
  assert.strictEqual(rec.endDate, '2026-08-15', '연장된 새 만기(9/1) 이하의 마지막 회차까지 다시 늘어나야 함');
});
test('clampRecurringToMaturity: 사용자가 직접 정한 종료일(count 동반)은 만기가 늘어나도 건드리지 않는다', () => {
  const rec = maturityRec({ endDate: '2026-02-15', count: 2 }); // saveRec()이 만든 것처럼 count가 함께 있음
  sandbox.DB = { recurrences: [rec] };
  sandbox.clampRecurringToMaturity('a2', '2026-09-01', '2026-03-01');
  assert.strictEqual(rec.endDate, '2026-02-15', '사용자가 직접 정한 종료일은 만기 연장과 무관하게 그대로 유지돼야 함');
  assert.strictEqual(rec.count, 2);
});
test('clampRecurringToMaturity: prevMaturity가 없으면(신규 자산 연동 등) 기존 종료일을 무조건 보존한다', () => {
  const rec = maturityRec({ endDate: '2026-02-15' }); // count 없음이지만 prevMaturity 정보가 없는 호출(askRelinkDeleted 경로)
  sandbox.DB = { recurrences: [rec] };
  sandbox.clampRecurringToMaturity('a2', '2026-09-01');
  assert.strictEqual(rec.endDate, '2026-02-15', 'prevMaturity 없이는 연장 여부를 판단할 수 없으므로 보수적으로 그대로 둠');
});
test('clampRecurringToMaturity: 만기를 더 당기면(단축) count 유무와 무관하게 항상 새 만기에 맞춰 더 잘린다', () => {
  const rec = maturityRec({ endDate: '2026-08-15', count: 7 }); // 사용자가 정했더라도
  sandbox.DB = { recurrences: [rec] };
  sandbox.clampRecurringToMaturity('a2', '2026-03-01', '2026-09-01');
  assert.strictEqual(rec.endDate, '2026-02-15', '만기가 당겨지면 만기 이후 이체를 막기 위해 항상 재계산돼야 함');
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

/* ---------- decidePushOutcome: pushCloud()의 조건부 UPDATE 결과 판정(동시 기기 푸시 race condition 방지) ---------- */
test('decidePushOutcome: 조건부 UPDATE가 행을 매치했으면(우리가 본 updated_at 그대로) 그대로 진행한다', () => {
  assert.strictEqual(sandbox.decidePushOutcome(1, true), 'proceed');
});
test('decidePushOutcome: 매치된 행이 없고 행 자체도 없었으면(첫 push) upsert로 폴백한다', () => {
  assert.strictEqual(sandbox.decidePushOutcome(0, false), 'fallback');
});
test('decidePushOutcome: 매치된 행이 없는데 행은 있었으면(그 사이 다른 기기가 이미 갱신) 충돌이다', () => {
  assert.strictEqual(sandbox.decidePushOutcome(0, true), 'conflict');
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

/* ---------- foreignSaveIsNewer: handleForeignStorage()가 다른 탭의 save()를 반영할지 판단하는 순수 로직
 * (탭 간 localStorage 미동기화로 조용히 데이터가 사라지던 버그의 감지 조건) ---------- */
test('foreignSaveIsNewer: 다른 탭의 저장 시각이 이 탭이 마지막으로 알던 시각보다 나중이면 최신이다', () => {
  assert.strictEqual(sandbox.foreignSaveIsNewer('2000', 1000), true);
});
test('foreignSaveIsNewer: 다른 탭의 저장 시각이 이전이거나 같으면 최신이 아니다(이 탭 자신의 저장 반영 등)', () => {
  assert.strictEqual(sandbox.foreignSaveIsNewer('1000', 2000), false);
  assert.strictEqual(sandbox.foreignSaveIsNewer('1000', 1000), false);
});
test('foreignSaveIsNewer: storage 이벤트의 newValue가 없으면(키 삭제 등) 최신이 아니다', () => {
  assert.strictEqual(sandbox.foreignSaveIsNewer(null, 1000), false);
  assert.strictEqual(sandbox.foreignSaveIsNewer('', 1000), false);
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

/* ---------- saveTx: 메모가 공백만 있으면 trim되어 카테고리로 대체되지 않던 버그 ----------
 * saveRec()은 `d.memo=(d.memo||'').trim()||d.category`로 공백만 있는 메모를 카테고리로
 * 대체하는데, saveTx()에는 이 처리가 전혀 없었다 — 신규 반복 등록 분기는 `d.memo||cat`으로
 * (trim 없이) truthy면 그대로 통과시켰고, 일회성 저장 경로는 memo를 아예 건드리지 않았다.
 * 그래서 스페이스 몇 개만 입력하고 저장하면 목록에 빈 것처럼 보이는 줄이 남았다(반복이면
 * 매 회차마다). syncAssetInputs 이름 trim 수정(cycle54)과 같은 종류의 버그. */
test('saveTx: 반복 켜고 저장 시 메모가 공백만 있으면 trim되어 카테고리로 대체된다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '월세', memo: '   ',
    amount: 500000, fromAssetId: 'a1', toAssetId: null,
    repeat: true, freq: 'monthly', day: 10, endDate: null, count: null,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.recurrences[0].memo, '월세', '공백만 있는 메모는 trim되어 카테고리로 대체되어야 함');
});
test('saveTx: 일회성 내역 저장 시 메모가 공백만 있으면 trim되어 카테고리로 대체된다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '식비', memo: '   ',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns[0].memo, '식비', '공백만 있는 메모는 trim되어 카테고리로 대체되어야 함');
});
test('saveTx: 실제 메모 내용은 앞뒤 공백만 trim되고 그대로 유지된다(정상 케이스는 회귀 없음)', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '식비', memo: '  점심 김밥  ',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns[0].memo, '점심 김밥', '앞뒤 공백은 제거되고 내용은 그대로 유지되어야 함');
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

/* ---------- balancesUpTo: 서로 다른 날짜 조회 간 expandRec 재확장 회귀 테스트 (app-evolve cycle41 advance) ----------
 * balancesUpTo()가 allTxns(RANGE_FROM,upto)처럼 dateStr마다 다른 upto를 그대로 expandRec에 넘기면,
 * _recCache가 [from,to] 키로 캐시해도 매 호출마다 키가 달라 캐시가 전혀 재사용되지 않는다 — 플랜/자산
 * 상세 등 한 번의 렌더 안에서 서로 다른 날짜로 balanceAt을 여러 번 부르면 daily/weekly 반복거래를
 * 매번 처음부터 다시 확장하는 구조였다(critique cycle41). allTxns를 고정폭 (RANGE_FROM,RANGE_TO)로
 * 부르도록 고쳐 _recCache가 실제로 공유되는지 DB.recurrences.forEach 호출 횟수로 확인한다. */
test('balancesUpTo: 서로 다른 두 날짜를 조회해도 반복거래 확장은 한 번만 계산되고 _recCache로 공유된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', type: 'cash', baseAmount: 0 }],
    txns: [],
    recurrences: [{ id: 'r1', active: true, freq: 'daily', startDate: '2026-01-01', endDate: null, weekend: 'none', type: 'expense', category: '식비', memo: '', amount: 1000, fromAssetId: 'a1', skip: [], edits: {} }],
  };
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  let scans = 0;
  const origForEach = Array.prototype.forEach;
  sandbox.DB.recurrences.forEach = (...args) => { scans++; return origForEach.apply(sandbox.DB.recurrences, args); };
  try {
    assert.strictEqual(sandbox.balanceAt('a1', '2026-06-01'), -152000, '2026-01-01(포함)부터 2026-06-01까지 매일 1000원 지출 = 152일치');
    assert.strictEqual(sandbox.balanceAt('a1', '2026-06-10'), -161000, '같은 반복거래로 9일 더 = 161일치');
    assert.strictEqual(scans, 1, 'balancesUpTo가 dateStr마다 다른 upto로 expandRec을 부르면 날짜마다 반복거래를 처음부터 재확장하게 된다 — RANGE_TO까지 고정폭으로 한 번만 확장해 _recCache를 공유해야 함');
  } finally {
    delete sandbox.DB.recurrences.forEach;
  }
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
test('openAssetPicker: excludeId(만기이체 picker에서 자기 자신 제외)를 넘기면 그 자산은 목록에서 빠지고 나머지는 그대로 남는다', () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  sandbox.openAssetPicker({ cashOnly: true, excludeId: 'a_sav', onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(html.includes('data-val="a_cash"'), '다른 현금성 자산은 그대로 있어야 함');
  assert.ok(!html.includes('data-val="a_sav"'), 'excludeId로 지정한 자산 본인은 빠져야 함');
});

/* ---------- firstCash: asOpenType()이 자산 종류를 savings로 바꿀 때 maturityTargetId가
 * 비어있으면 firstCash()로 기본값을 채우는데(index.html 2635), excludeId 없이 DB.assets를
 * 그대로 훑던 예전 구현은 "지금 편집 중인 자산 자신"을 걸러내지 않았다(app-evolve cycle35 review).
 * asDraft는 DB.assets에서 JSON.parse(JSON.stringify(...))로 뜬 사본이라 asDraft.id는 원본과
 * 같고, 저장 전까지 DB.assets엔 여전히 옛 타입(cash 등)의 원본이 남아있다 — 그 원본이
 * isCashLike를 만족하는 첫 자산이면(흔히 사용자의 첫 계좌) firstCash()가 그 자산 자신의 id를
 * 돌려줘 maturityTargetId가 자기 자신으로 조용히 채워졌다. doMaturity()의 방어 가드(cycle34)가
 * 실행 시점에는 막아주지만, 그전에 사용자가 대상을 다시 고르지 않는 한 저장 화면엔 이미
 * 잘못된 값이 들어가 있었다. firstCash(excludeId)로 자기 자신을 제외하도록 고쳤다 ---------- */
test('firstCash: excludeId로 지정한 자산은 건너뛰고 그다음 현금성 자산을 반환한다', () => {
  sandbox.DB = { assets: [
    { id: 'a_cash1', type: 'cash' },
    { id: 'a_cash2', type: 'cash' },
    { id: 'a_gold', type: 'gold' },
  ] };
  assert.strictEqual(sandbox.firstCash('a_cash1'), 'a_cash2');
});
test('firstCash: excludeId가 유일한 현금성 자산이면 null을 반환한다(자기 자신으로 채워지면 안 됨)', () => {
  sandbox.DB = { assets: [
    { id: 'a_cash1', type: 'cash' },
    { id: 'a_gold', type: 'gold' },
  ] };
  assert.strictEqual(sandbox.firstCash('a_cash1'), null);
});
test('firstCash: excludeId 없이 부르는 기존 호출부(openTxSheet)는 회귀 없이 첫 현금성 자산을 그대로 반환한다', () => {
  sandbox.DB = { assets: [
    { id: 'a_cash1', type: 'cash' },
    { id: 'a_sav', type: 'savings' },
  ] };
  assert.strictEqual(sandbox.firstCash(), 'a_cash1');
});

/* ---------- doMaturity: 저축 통장 자신을 '만기 시 이체할 통장'으로 골라둔 채 만기 이체를 실행하면
 * fromAssetId===toAssetId인 자기 자신 이체 거래가 조용히 생기던 버그(app-evolve cycle34 develop).
 * saveTx()/saveRec()는 저장 시점에 `fromAssetId===toAssetId` 가드가 있는데(3052, 3233),
 * asOpenMat()이 여는 openAssetPicker(cashOnly)엔 수정 중인 자산 자신을 빼는 필터가 없어서
 * 골라둘 수 있었고, doMaturity()도 대상 검증 없이 그대로 거래를 push했다. openAssetPicker에
 * excludeId 옵션을 추가해 picker 단계에서 막고, doMaturity()에도 방어적으로 같은 가드를 추가했다.
 * (기존 DB에 이미 self-target으로 저장된 자산이 있을 수 있어 실행 시점 가드도 필요) ---------- */
function setupMaturityDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: { confirmTransfers: false },
    assets: [
      { id: 'a_sav', name: '적금', type: 'savings', owner: '나', baseAmount: 5000, maturityDate: '2026-06-10', maturityTargetId: 'a_sav', includeInTotal: true },
      { id: 'a_cash', name: '지갑', type: 'cash', owner: '나', baseAmount: 10000, includeInTotal: true },
    ],
    txns: [],
    recurrences: [],
    rates: {},
  };
  sandbox._balCache.clear();
  sandbox.toastCalls = [];
}
test("doMaturity: maturityTargetId가 자기 자신이면 거래를 만들지 않고 안내만 한다", () => {
  setupMaturityDB();
  const before = sandbox.DB.txns.length;
  sandbox.doMaturity('a_sav');
  assert.strictEqual(sandbox.DB.txns.length, before, '자기 자신 이체 거래가 생기면 안 됨');
  assert.strictEqual(sandbox.DB.assets.find(a => a.id === 'a_sav').maturityDate, '2026-06-10', '실행 안 됐으니 만기일도 그대로 남아야 함');
  assert.ok(sandbox.toastCalls.some(m => m.includes('자기 자신')), '자기 자신 이체를 막았다는 안내가 떠야 함');
});
test('doMaturity: 정상적인 다른 자산이 대상이면 기존처럼 이체 거래가 생기고 만기일이 지워진다', () => {
  setupMaturityDB();
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  const before = sandbox.DB.txns.length;
  sandbox.doMaturity('a_sav');
  assert.strictEqual(sandbox.DB.txns.length, before + 1);
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.fromAssetId, 'a_sav');
  assert.strictEqual(t.toAssetId, 'a_cash');
  assert.strictEqual(sandbox.DB.assets.find(a => a.id === 'a_sav').maturityDate, null);
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

test('renderHome: 예산(지출 분석) 진입점인 nextOutflowCard/monthOutflowCard가 실제로 렌더링 템플릿에 포함되어 있다', () => {
  // renderHome() 자체는 DOM($)·svg 등 화면 전용 의존성이 많아 여기서 직접 실행하지 않고,
  // 소스 텍스트 수준에서 두 카드 호출이 빠지지 않았는지만 확인한다 — 예전에 리팩터링 중
  // 이 호출이 통째로 누락되어 예산 기능에 진입할 방법이 없어졌던 회귀를 막기 위한 가드.
  const body = extractFunction('renderHome');
  assert.ok(body.includes('nextOutflowCard()'), 'renderHome()이 nextOutflowCard()를 호출하지 않음');
  assert.ok(body.includes('monthOutflowCard('), 'renderHome()이 monthOutflowCard()를 호출하지 않음');
});

/* emptyAssets()/emptyAssetCards() — 0원이 되고 앞으로 쓸 일 없는 자산을 홈에서 "정리할까요?"로
 * 제안하는 기능. emptyAssetCards()는 예전부터 정의만 돼 있었을 뿐 renderHome()이 호출하지 않아
 * 실제로는 한 번도 화면에 나온 적 없는 죽은 코드였다(nextOutflowCard/monthOutflowCard와 같은
 * 패턴) — renderHome()에 연결하면서 로직 자체의 회귀도 함께 가드한다. */
function setupEmptyAssetsDB() {
  sandbox.DB = {
    settings: {},
    assets: [
      { id: 'a_cash', name: '주거래통장', type: 'cash', owner: '나' },
      { id: 'a_savings0', name: '만기지난적금', type: 'savings', owner: '나' },
      { id: 'a_savingsFuture', name: '진행중적금', type: 'savings', owner: '나', maturityDate: '2099-01-01' },
      { id: 'a_stockHasTxn', name: '예정거래있는주식', type: 'stock', owner: '나', stockQty: 0, stockCode: 'S1' },
      { id: 'a_stockNonZero', name: '보유중인주식', type: 'stock', owner: '나', stockQty: 5, stockCode: 'S1' },
    ],
    rates: { fx: {}, stocks: { S1: 70000 } },
    txns: [],
    recurrences: [],
  };
  sandbox.TODAY = '2026-06-15';
  sandbox.DISP_TO = '2026-09-15';
  sandbox.RANGE_TO = '2026-09-15';
  sandbox.RANGE_FROM_OVERRIDE = undefined;
}
test('emptyAssets: 현금성 자산은 0원이어도 정리 대상에서 제외된다', () => {
  setupEmptyAssetsDB();
  const ids = sandbox.emptyAssets().map((a) => a.id);
  assert.ok(!ids.includes('a_cash'));
});
test('emptyAssets: 잔액이 남아있는 자산은 제외된다', () => {
  setupEmptyAssetsDB();
  const ids = sandbox.emptyAssets().map((a) => a.id);
  assert.ok(!ids.includes('a_stockNonZero'));
});
test('emptyAssets: 만기 전 저축은 0원이어도 제외된다', () => {
  setupEmptyAssetsDB();
  const ids = sandbox.emptyAssets().map((a) => a.id);
  assert.ok(!ids.includes('a_savingsFuture'));
});
test('emptyAssets: 앞으로 예정된 내역이 남아있으면 0원이어도 제외된다', () => {
  setupEmptyAssetsDB();
  sandbox.DB.txns.push({ id: 't1', type: 'income', date: '2026-07-01', amount: 1, fromAssetId: null, toAssetId: 'a_stockHasTxn' });
  const ids = sandbox.emptyAssets().map((a) => a.id);
  assert.ok(!ids.includes('a_stockHasTxn'));
});
test('hasFutureTxns: DISP_TO(92일) 너머・RANGE_TO(760일) 이내의 연 1회 반복 거래도 "예정 내역"으로 잡힌다', () => {
  // 회귀: hasFutureTxns()가 화면 표시용 짧은 범위(DISP_TO=92일)만 보면, 다음 회차가
  // 92일보다 멀리 있는 매년 반복 거래(예: 연 1회 이자/보너스 저축)를 가진 0원 자산이
  // "예정 내역 없음"으로 오판되어 정리 대상으로 잘못 제안된다.
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a_yearly', name: '연1회적금', type: 'savings', owner: '나' }],
    rates: { fx: {}, stocks: {} },
    txns: [],
    recurrences: [
      { id: 'r1', active: true, freq: 'yearly', startDate: '2026-01-10', type: 'income', category: '이자', memo: '', amount: 1000, fromAssetId: null, toAssetId: 'a_yearly' },
    ],
  };
  sandbox.TODAY = '2026-06-15';
  sandbox.DISP_TO = '2026-09-15'; // TODAY+92일 — 다음 회차(2027-01-10)는 이 범위 밖
  sandbox.RANGE_TO = '2028-06-15'; // TODAY+760일 — 다음 회차는 이 범위 안
  assert.ok(sandbox.hasFutureTxns('a_yearly'), 'DISP_TO 너머·RANGE_TO 이내의 연 1회 반복 거래를 놓침');
  const ids = sandbox.emptyAssets().map((a) => a.id);
  assert.ok(!ids.includes('a_yearly'), '연 1회 반복 거래가 있는데도 정리 대상으로 잘못 분류됨');
});
test('emptyAssets: 만기가 지났고(또는 없고) 0원에 예정 내역도 없는 자산만 정리 대상으로 남는다', () => {
  setupEmptyAssetsDB();
  const ids = sandbox.emptyAssets().map((a) => a.id).sort();
  assert.deepStrictEqual(ids, ['a_savings0', 'a_stockHasTxn']);
});
test('emptyAssetCards: snoozeTidy()로 미룬 자산은 다음 emptyAssetCards() 출력에서 빠진다', () => {
  setupEmptyAssetsDB();
  const before = sandbox.emptyAssetCards();
  assert.ok(before.includes('만기지난적금'));
  sandbox.snoozeTidy('a_savings0');
  const after = sandbox.emptyAssetCards();
  assert.ok(!after.includes('만기지난적금'), 'snoozeTidy() 이후에도 카드가 계속 노출됨');
});
test('emptyAssetCards: 정리할 자산이 없으면 빈 문자열을 반환한다', () => {
  setupEmptyAssetsDB();
  sandbox.DB.assets = sandbox.DB.assets.filter((a) => a.id === 'a_cash');
  assert.strictEqual(sandbox.emptyAssetCards(), '');
});
test('renderHome: 다 쓴 자산 정리 제안(emptyAssetCards)이 실제로 렌더링 템플릿에 포함되어 있다', () => {
  // 예전부터 정의만 돼 있고 어디서도 호출되지 않던 죽은 코드였던 emptyAssetCards()를
  // renderHome()에 연결했다 — 다시 호출이 빠지면 이 테스트가 잡는다.
  const body = extractFunction('renderHome');
  assert.ok(body.includes('emptyAssetCards()'), 'renderHome()이 emptyAssetCards()를 호출하지 않음');
});
test('emptyAssetCards: 정리 제안 행(ha-b)에 키보드/스크린리더 접근 패턴이 있다', () => {
  setupEmptyAssetsDB();
  const html = sandbox.emptyAssetCards();
  assert.ok(html.includes('role="button"'), 'ha-b 행에 role="button"이 없음');
  assert.ok(html.includes('onkeydown="rowKeydown('), 'ha-b 행에 rowKeydown 연결이 없음');
});

/* ---------- bare onclick 행 키보드/스크린리더 접근성 — flow-item/acct-card/spend-row/of-row/backup ha-b ----------
 * 자산 카드·캘린더 셀 등 다른 상호작용 행들은 tabindex/role="button"/aria-label과 rowKeydown()을
 * 함께 쓰는데, 이 5곳은 한동안 bare <div onclick=...>로만 남아 키보드/스크린리더로 조작할 수 없었다.
 * 이 함수들은 $/openSheet 등 DOM 의존성이 있어 실행 대신 소스 텍스트로 패턴 유지를 확인한다
 * (renderHome의 emptyAssetCards() 연결 테스트와 같은 방식). */
test('renderPlan: 플랜 탭 일별 거래 행(flow-item)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('renderPlan');
  assert.ok(body.includes('<div class="flow-item" tabindex="0" role="button"'), 'flow-item에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>planTap('), 'flow-item에 rowKeydown 연결이 없음');
});
/* ---------- renderPlan: 귀속(owner) 이름변경/삭제 후 ST.plan.owner가 낡은 값으로 남던 버그 ----------
 * renderAssets()는 ST.assetOwner가 더 이상 DB.owners에 없으면 'all'로 되돌리는 가드가 있는데,
 * renderPlan()에는 짝이 되는 가드가 없어서 doRenameOwner()로 귀속 이름을 바꾸면(플랜 탭에서
 * 그 귀속의 통장을 선택해둔 상태였을 때) ST.plan.owner가 사라진 이름 그대로 남는다. cashAssets
 * 필터가 그 이름과 일치하는 자산을 못 찾아 0개가 되고, assetId가 null로 떨어져 플랜 탭이
 * "통장 없음"으로 무너진다 — 통장 선택 시트를 다시 열어야만(planAsset이 owner를 재동기화) 복구됐다.
 * renderAssets와 동일한 패턴의 가드를 cashAssets 계산 전에 추가해 고쳤다. */
test('renderPlan: 귀속이 이름변경/삭제로 사라지면 ST.plan.owner를 renderAssets와 동일하게 전체로 되돌린다', () => {
  const body = extractFunction('renderPlan');
  const guardIdx = body.indexOf("if(ST.plan.owner!=='전체'&&!DB.owners.includes(ST.plan.owner))ST.plan.owner='전체'");
  const cashIdx = body.indexOf('const cashAssets=');
  assert.ok(guardIdx !== -1, "ST.plan.owner 존재 확인 가드가 없음");
  assert.ok(cashIdx !== -1 && guardIdx < cashIdx, '가드가 cashAssets 필터 계산보다 먼저 실행되지 않음');
});
test('renderMenu: 메뉴 탭 계정 진입점(acct-card)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('renderMenu');
  assert.ok(/class="card acct-card"[^>]*role="button"/.test(body), 'acct-card에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>openAccountSheet())"'), 'acct-card에 rowKeydown 연결이 없음');
});
test('openSpendAnalysis: 지출 분석 카테고리 행(spend-row)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('openSpendAnalysis');
  assert.ok(/class="spend-row"[^>]*role="button"/.test(body), 'spend-row에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>openBudgetPrompt('), 'spend-row에 rowKeydown 연결이 없음');
});
test('monthOutflowCard: 홈 탭 이번 달 나갈 돈 행(of-row)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('monthOutflowCard');
  assert.ok(/class="of-row"[^>]*role="button"/.test(body), 'of-row에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>goLedgerTo('), 'of-row에 rowKeydown 연결이 없음');
});
test('homeAlertCard: 백업 알림 행(ha-b)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('homeAlertCard');
  assert.ok(/class="ha-b"\s+tabindex="0"\s+role="button"[^>]*onclick="exportData\(\)"/.test(body), '백업 ha-b에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>exportData())"'), '백업 ha-b에 rowKeydown 연결이 없음');
});

/* ---------- filteredHist/_histCache: 전체 내역 탭에서 내역 추가/수정/삭제 후 캐시가 낡은 목록을 보여주던 버그 ----------
 * filteredHist()는 날짜범위|카테고리|검색어로만 캐시 키를 만들기 때문에, saveTx()/recApply()/
 * deleteTxnsUndo() 등으로 DB.txns가 바뀌어도 필터를 안 건드리면 캐시 키가 그대로라 예전 목록을
 * 계속 돌려줬다. renderHistory()가 매번 전체 페이지를 innerHTML로 새로 그리면서도 이 캐시를
 * 안 비웠던 게 원인 — renderHistory() 맨 앞에서 _histCache.key=null을 하도록 고쳤다(page는 유지). */
test('filteredHist: 캐시 키(범위/카테고리/검색어)가 그대로면 DB.txns가 바뀌어도 이전 목록을 그대로 돌려준다(캐싱 동작 자체 확인)', () => {
  sandbox.DB = { txns: [{ id: 't1', type: 'expense', category: '식비', date: '2026-06-01', amount: 1000 }], recurrences: [] };
  sandbox.ST = { hist: { range: { from: '2026-06-01', to: '2026-06-30' }, cat: '전체', q: '' } };
  const first = sandbox.filteredHist();
  assert.strictEqual(first.length, 1);
  sandbox.DB.txns.push({ id: 't2', type: 'expense', category: '식비', date: '2026-06-02', amount: 2000 });
  const second = sandbox.filteredHist();
  assert.strictEqual(second.length, 1, '필터를 안 건드렸는데 캐시가 갱신됐다면 이 테스트 자체가 캐싱 전제를 잘못 이해한 것');
});
test('filteredHist: renderHistory()가 매번 하는 것처럼 _histCache.key를 비우면 DB.txns 최신 상태를 반영한 새 목록을 돌려준다', () => {
  sandbox.DB = { txns: [{ id: 't1', type: 'expense', category: '식비', date: '2026-07-01', amount: 1000 }], recurrences: [] };
  sandbox.ST = { hist: { range: { from: '2026-07-01', to: '2026-07-31' }, cat: '전체', q: '' } };
  sandbox.filteredHist(); // 캐시를 한 번 채운다
  sandbox.DB.txns[0] = { id: 't1', type: 'expense', category: '식비', date: '2026-07-01', amount: 9999 }; // saveTx()의 DB.txns[i]=d와 동일한 교체
  sandbox.DB.txns.push({ id: 't2', type: 'income', category: '급여', date: '2026-07-15', amount: 5000 });
  sandbox._histCache.key = null; // renderHistory()의 수정 부분
  const list = sandbox.filteredHist();
  assert.strictEqual(list.length, 2, '추가된 내역이 반영되지 않음');
  assert.strictEqual(list.find((t) => t.id === 't1').amount, 9999, '수정된 내역이 반영되지 않고 옛 객체를 그대로 들고 있음');
});
test('histInvalidate: 캐시 키뿐 아니라 페이지도 1로 리셋한다(필터를 바꿀 때의 기존 동작, renderHistory 수정과 무관하게 유지)', () => {
  sandbox.ST = { hist: { range: { from: '2026-06-01', to: '2026-06-30' }, cat: '전체', q: '', page: 3 } };
  sandbox._histCache = { key: 'dummy', list: [] };
  sandbox.histInvalidate();
  assert.strictEqual(sandbox._histCache.key, null);
  assert.strictEqual(sandbox.ST.hist.page, 1);
});
test('renderHistory: 전체 내역 화면을 다시 그릴 때마다 _histCache.key를 실제로 비운다(위 filteredHist 테스트들이 검증한 메커니즘이 실제로 연결돼 있는지)', () => {
  // renderHistory()는 DOM($('page-history').innerHTML=...)을 직접 다루는 화면 함수라 이 테스트
  // 파일에서 실행 가능한 순수 로직으로 추출하지 않는다(다른 render* 함수들과 동일한 이유) — 대신
  // renderHome의 emptyAssetCards 연결 테스트와 같은 방식으로, 소스에 그 호출이 실제로 남아있는지 확인한다.
  const body = extractFunction('renderHistory');
  assert.ok(/^\s*_histCache\.key\s*=\s*null/m.test(body), 'renderHistory()가 함수 맨 앞에서 _histCache.key를 비우지 않음');
});

/* ---------- genSalt/pbkdf2Hash: 로컬 계정 비밀번호가 salt·반복 없는 DJB2 체크섬이라
 * 같은 기기를 쓰는 다른 사람이 DevTools에서 몇 초 안에 뚫을 수 있던 문제를 PBKDF2로 교체 ---------- */
test('genSalt: 매번 다른 32자 hex 문자열을 만든다(고정 salt로 레인보우 테이블에 뚫리지 않도록)', () => {
  const a = sandbox.genSalt();
  const b = sandbox.genSalt();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notStrictEqual(a, b, '매 호출마다 랜덤해야 하는데 같은 salt가 나옴');
});
test('pbkdf2Hash: 같은 비밀번호·salt면 항상 같은 해시를 돌려준다(로그인 시 재현 가능해야 함)', async () => {
  const salt = sandbox.genSalt();
  const h1 = await sandbox.pbkdf2Hash('correct horse battery staple', salt);
  const h2 = await sandbox.pbkdf2Hash('correct horse battery staple', salt);
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/, 'SHA-256 256bit 출력이므로 64자 hex여야 함');
});
test('pbkdf2Hash: 비밀번호가 다르면 같은 salt라도 다른 해시가 나온다', async () => {
  const salt = sandbox.genSalt();
  const h1 = await sandbox.pbkdf2Hash('password-one', salt);
  const h2 = await sandbox.pbkdf2Hash('password-two', salt);
  assert.notStrictEqual(h1, h2);
});
test('pbkdf2Hash: 같은 비밀번호라도 salt가 다르면 다른 해시가 나온다(무지개 테이블 방어의 핵심)', async () => {
  const s1 = sandbox.genSalt();
  const s2 = sandbox.genSalt();
  const h1 = await sandbox.pbkdf2Hash('same-password', s1);
  const h2 = await sandbox.pbkdf2Hash('same-password', s2);
  assert.notStrictEqual(h1, h2);
});

/* ---------- postponeRecTransfer/confirmRecTransfer: 반복 이체 회차에 개별 금액/메모 수정
 * (r.edits[date])이 있는 상태에서 "내일로" 미루면, 그 회차를 skip 처리하고 새 일회성 거래를
 * 대신 만드는데(app-evolve cycle36 develop 이전) recSave scope='one'으로 저장해둔 ed.amount를
 * 무시하고 반복의 기본값(r.amount)을 그대로 썼다 — expandRec()/recApply() 등 다른 모든
 * 반복 구체화 지점은 이미 ed 우선 패턴을 쓰는데 이 두 곳만 빠져 있었다. 예: 월 50만원 이체
 * 반복에서 이번 달만 70만원으로 수정해뒀는데 "내일로"를 누르면 완료 확인 시트도, 새로 생기는
 * 거래도 조용히 50만원으로 되돌아가 다음날 그 금액대로 이체 완료 처리될 뻔했다. ---------- */
function setupRecTransferDB() {
  sandbox.TODAY = '2026-09-17';
  sandbox.DB = {
    assets: [
      { id: 'a_cash', name: '지갑' },
      { id: 'a_sav', name: '적금' },
    ],
    recurrences: [
      { id: 'r1', type: 'transfer', memo: '적금이체', amount: 500000, fromAssetId: 'a_cash', toAssetId: 'a_sav', skip: [], edits: {} },
    ],
    txns: [],
  };
  sandbox.lastSheetHtml = null;
}
test('confirmRecTransfer: 회차별 금액 수정(edits)이 있으면 확인 시트에 수정된 금액을 보여준다', () => {
  setupRecTransferDB();
  sandbox.DB.recurrences[0].edits = { '2026-09-17': { amount: 700000 } };
  sandbox.confirmRecTransfer('r1', '2026-09-17');
  assert.ok(sandbox.lastSheetHtml.includes(sandbox.comma(700000)), '기본값(50만)이 아닌 수정된 금액(70만)이 표시돼야 함');
  assert.ok(!sandbox.lastSheetHtml.includes(sandbox.comma(500000) + '원'), '반복 기본 금액이 그대로 노출되면 안 됨');
});
test('postponeRecTransfer: 회차별 금액/메모 수정(edits)이 있으면 새로 생기는 거래도 그 값을 따른다', () => {
  setupRecTransferDB();
  sandbox.DB.recurrences[0].edits = { '2026-09-17': { amount: 700000, memo: '보너스 추가이체' } };
  sandbox.postponeRecTransfer('r1', '2026-09-17');
  assert.ok(sandbox.DB.recurrences[0].skip.includes('2026-09-17'));
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.amount, 700000, '반복 기본 금액(50만)이 아니라 수정된 금액(70만)으로 미뤄져야 함');
  assert.strictEqual(t.memo, '보너스 추가이체');
  assert.strictEqual(t.date, sandbox.addDays(sandbox.TODAY, 1));
});
test('postponeRecTransfer: 회차별 수정이 없으면 기존처럼 반복의 기본 금액/메모를 그대로 쓴다(회귀 확인)', () => {
  setupRecTransferDB();
  sandbox.postponeRecTransfer('r1', '2026-09-17');
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.amount, 500000);
  assert.strictEqual(t.memo, '적금이체');
});
/* postponeRecTransfer: daily 반복 이체를 "내일로" 미루면 +1일이 그 반복의 다음 정상 회차
 * 날짜와 겹쳐(daily는 매일이 회차이므로 항상 겹침), 엔진(expandRec)이 내일 몫 회차를 또
 * 만들어내 수동으로 넣은 이체와 중복 계상되던 버그(app-evolve cycle47 develop)의 회귀 테스트.
 * weekly/monthly/yearly는 +1일이 다음 정상 회차와 우연히 겹칠 일이 사실상 없어 영향 없다. */
test('postponeRecTransfer: daily 반복은 내일 날짜도 skip에 추가해 엔진이 중복 회차를 만들지 않는다', () => {
  setupRecTransferDB();
  sandbox.DB.recurrences[0].freq = 'daily';
  sandbox.DB.recurrences[0].startDate = '2026-01-01';
  sandbox.DB.recurrences[0].active = true;
  const tomorrow = sandbox.addDays(sandbox.TODAY, 1);
  sandbox.postponeRecTransfer('r1', '2026-09-17');
  assert.ok(sandbox.DB.recurrences[0].skip.includes(tomorrow), '내일 날짜도 skip에 들어가야 엔진이 중복 회차를 안 만듦');
  const occ = sandbox.expandRec(tomorrow, tomorrow);
  assert.strictEqual(occ.length, 0, '엔진이 내일 몫 회차를 또 만들면 안 됨(수동으로 넣은 거래와 중복)');
  const manual = sandbox.DB.txns.filter(t => t.date === tomorrow);
  assert.strictEqual(manual.length, 1, '수동으로 넣은 거래는 정확히 1건이어야 함');
});
test('postponeRecTransfer: 미룬 날짜가 이미 내일이면(예: weekly가 우연히 겹침) skip을 중복으로 넣지 않는다', () => {
  setupRecTransferDB();
  const tomorrow = sandbox.addDays(sandbox.TODAY, 1);
  sandbox.postponeRecTransfer('r1', tomorrow);
  const skipCount = sandbox.DB.recurrences[0].skip.filter(d => d === tomorrow).length;
  assert.strictEqual(skipCount, 1, 'date와 내일이 같아도 skip 항목은 중복 없이 1개여야 함');
});

/* ---------- openConfirmTransfer/confirmRecTransfer: 이체 확인 시트에 자산명을 esc() 없이
 * 꽂던 self-XSS(app-evolve cycle50 develop) — assetPickBtn()/renderPlan()/accountName() 등은
 * 이미 esc()로 감싸져 있었는데, assetNm()이 반환하는 자산명(살아있는 자산의 a.name 또는
 * 삭제된 자산의 캐시된 fromAssetName/toAssetName)을 두 확인 시트가 이스케이프 없이 그대로
 * innerHTML에 넣는 지점만 놓쳐 있었다. 이체 대기(pending) 배지를 확인만 해도 실행되는
 * 재현 가능한 stored XSS라 우선순위 높게 고쳤다. ---------- */
test('openConfirmTransfer: 자산명에 담긴 태그가 esc()로 이스케이프된다', () => {
  sandbox.DB = {
    assets: [{ id: 'a1', name: '<img src=x onerror=alert(1)>지갑' }, { id: 'a2', name: '적금' }],
    txns: [{ id: 't1', type: 'transfer', amount: 10000, fromAssetId: 'a1', toAssetId: 'a2', date: '2026-09-17' }],
  };
  sandbox.lastSheetHtml = null;
  sandbox.openConfirmTransfer('t1');
  assert.ok(sandbox.lastSheetHtml.includes('&lt;img'), '자산명의 태그가 무력화돼 렌더돼야 함');
  assert.ok(!sandbox.lastSheetHtml.includes('<img src=x onerror=alert(1)>'), '태그가 그대로 삽입되면 안 됨');
});
test('openConfirmTransfer: 삭제된 자산의 캐시된 이름(snap)도 esc()로 이스케이프된다', () => {
  sandbox.DB = {
    assets: [],
    txns: [{ id: 't1', type: 'transfer', amount: 10000, fromAssetId: 'gone1', fromAssetName: '<b>옛지갑</b>', toAssetId: 'gone2', toAssetName: '옛적금', date: '2026-09-17' }],
  };
  sandbox.lastSheetHtml = null;
  sandbox.openConfirmTransfer('t1');
  assert.ok(sandbox.lastSheetHtml.includes('&lt;b&gt;'), '삭제된 자산의 캐시된 이름도 이스케이프돼야 함');
});
test('confirmRecTransfer: 자산명에 담긴 태그가 esc()로 이스케이프된다', () => {
  setupRecTransferDB();
  sandbox.DB.assets[0].name = '<script>alert(1)</script>지갑';
  sandbox.confirmRecTransfer('r1', '2026-09-17');
  assert.ok(sandbox.lastSheetHtml.includes('&lt;script&gt;'), '반복 이체 확인 시트의 자산명도 이스케이프돼야 함');
  assert.ok(!sandbox.lastSheetHtml.includes('<script>alert(1)</script>'), '태그가 그대로 삽입되면 안 됨');
});

/* ---------- copyBackup/openCopyBackup: CSV 복사 폴백이 백업 알림 상태를 건드리던 버그
 * (app-evolve cycle37 develop) — doExport()는 CSV 내보내기일 때 isCsv 가드로 lastExport/
 * backupSnooze를 건드리지 않는데(done()의 if(!isCsv) 참고), 공유/다운로드가 막혀
 * copyFallback()->openCopyBackup()->"전체 복사" 버튼->copyBackup() 경로로 빠지면 그 가드가
 * 전혀 적용되지 않아 CSV를 복사만 해도 실제 JSON 백업을 한 것처럼 7일 알림이 꺼졌다. ---------- */
function setupCopyBackupDB() {
  sandbox.DB = { settings: { lastExport: 0, backupSnooze: 0 } };
  sandbox.toastCalls = [];
}
test('openCopyBackup: override.isCsv가 true면 _copyIsCsv를 true로 세팅한다', () => {
  setupCopyBackupDB();
  sandbox.openCopyBackup('csv-text', '이유', { title: 't', isCsv: true });
  assert.strictEqual(sandbox._copyIsCsv, true);
});
test('openCopyBackup: override가 없거나 isCsv가 없으면 _copyIsCsv를 false로 세팅한다', () => {
  setupCopyBackupDB();
  sandbox.openCopyBackup('json-text', '이유');
  assert.strictEqual(sandbox._copyIsCsv, false);
});
test('copyBackup: CSV 복사 폴백(_copyIsCsv=true)에서는 lastExport/backupSnooze를 건드리지 않는다', () => {
  setupCopyBackupDB();
  sandbox.DB.settings.backupSnooze = 12345;
  sandbox.openCopyBackup('csv-text', '이유', { title: 't', isCsv: true });
  sandbox.copyBackup();
  assert.strictEqual(sandbox.DB.settings.lastExport, 0, 'CSV 복사는 JSON 백업이 아니므로 lastExport가 갱신되면 안 됨');
  assert.strictEqual(sandbox.DB.settings.backupSnooze, 12345, 'backupSnooze도 CSV 복사로 리셋되면 안 됨');
});
test('copyBackup: 실제 JSON 백업 복사(_copyIsCsv=false)에서는 기존처럼 lastExport/backupSnooze를 갱신한다(회귀 확인)', () => {
  setupCopyBackupDB();
  sandbox.DB.settings.backupSnooze = 12345;
  sandbox.openCopyBackup('json-text', '이유');
  sandbox.copyBackup();
  assert.notStrictEqual(sandbox.DB.settings.lastExport, 0, 'JSON 백업 복사는 lastExport를 갱신해야 함');
  assert.strictEqual(sandbox.DB.settings.backupSnooze, 0, 'JSON 백업 복사는 backupSnooze를 리셋해야 함');
});

/* ---------- findDonors: '해결 방법 보기'가 이체가 실행될 날이 아니라 부족해지는 날 기준으로
 * 여유 통장을 골라 실제로는 아직 안 들어온 돈으로 이체를 권하던 버그의 회귀 테스트(app-evolve cycle39).
 * openFixShortfall()이 findDonors(need,targetId,date)처럼 부족해지는 날(date)을 넘기면,
 * date와 이체 실행일(when=내일/결제 전날/직접 고른 날) 사이에 들어오는 예정 수입까지
 * balanceAt이 미리 반영해버려 "내일 당장 옮겨도 충분하다"고 잘못 권하게 된다.
 * fix는 openFixShortfall이 findDonors를 date가 아니라 when으로 부르도록 고치는 것이므로,
 * 여기선 findDonors 자체가 넘겨받은 byDate를 그대로 존중해 날짜별로 다른 결과를 내는지 확인한다. */
function setupFindDonorsDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: {},
    assets: [
      { id: 'target', type: 'cash', baseAmount: 0 },
      { id: 'donor', type: 'cash', baseAmount: 0 },
    ],
    // donor 통장은 지금은 0원이지만, 내일(06-16)과 부족해지는 날(06-25) 사이인 06-20에
    // 10만원 예정 수입이 들어와 그 이후로는 잔액이 충분해진다.
    txns: [{ id: 'inc1', date: '2026-06-20', type: 'income', category: '월급', amount: 100000, toAssetId: 'donor' }],
    recurrences: [],
  };
}
test('findDonors: 이체 실행일(내일) 기준으로는 아직 안 들어온 돈이라 여유 통장 목록에서 빠진다', () => {
  setupFindDonorsDB();
  const tomorrow = sandbox.addDays(sandbox.TODAY, 1); // 2026-06-16, 예정 수입(06-20)보다 앞선 날
  const donors = sandbox.findDonors(50000, 'target', tomorrow);
  assert.ok(!donors.some((x) => x.a.id === 'donor'), '아직 수입이 들어오기 전 날짜 기준이면 donor는 여유 통장 목록에 없어야 함');
});
test('findDonors: 부족해지는 날 기준으로는 그 사이 들어온 예정 수입까지 포함돼 충분해 보인다(문제의 원인이 되는 날짜)', () => {
  setupFindDonorsDB();
  const shortfallDate = '2026-06-25'; // 예정 수입(06-20)보다 뒤 날짜
  const donors = sandbox.findDonors(50000, 'target', shortfallDate);
  const d = donors.find((x) => x.a.id === 'donor');
  assert.ok(d, '부족해지는 날 기준이면 그 사이 들어온 수입이 반영돼 donor가 여유 통장으로 나와야 함');
  assert.strictEqual(d.free, 100000);
});

/* ---------- varyingRecs: 이번 회차를 삭제(r.skip)했는데도 "실제 금액 입력" 알림이
 * 계속 뜨던 버그의 회귀 테스트(app-evolve cycle40). expandRec()은 r.skip에 있는
 * 날짜를 항상 걸러내는데(recApply의 scope='one' delete가 r.skip.push(date)로 만듦),
 * varyingRecs()는 recDates()가 만든 원시 회차 목록만 보고 r.skip을 확인하지 않아
 * 이미 삭제된 회차에 대해서도 계속 알림을 만들었다 — 사용자가 채워도 expandRec이
 * skip을 먼저 걸러내므로 아무 거래도 생기지 않는 죽은 알림이었다. */
function setupVaryingRecsDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.DB = { catVar: {}, recurrences: [] };
  sandbox.setCatVar('expense', '전기요금', true);
  sandbox.DB.recurrences.push({
    id: 'r1', active: true, freq: 'monthly', type: 'expense', category: '전기요금',
    day: 10, startDate: '2026-01-10', endDate: null, count: null, amount: 50000,
    weekend: 'none', skip: [], edits: {},
  });
}
test('varyingRecs: 이번 회차를 삭제(skip)했으면 실제 금액 입력 알림에서 빠져야 함', () => {
  setupVaryingRecsDB();
  sandbox.DB.recurrences[0].skip = ['2026-06-10'];
  const vr = sandbox.varyingRecs();
  assert.ok(!vr.some((x) => x.date === '2026-06-10'), '삭제된 회차는 알림 목록에 남으면 안 됨');
});
test('varyingRecs: skip이 없으면 기존처럼 실제 금액 입력 알림에 그대로 나와야 함(회귀 확인)', () => {
  setupVaryingRecsDB();
  const vr = sandbox.varyingRecs();
  assert.ok(vr.some((x) => x.date === '2026-06-10'), 'skip되지 않은 지난 회차는 알림 목록에 있어야 함');
});
test('varyingRecs: 이미 실제 금액을 입력(edits)한 회차는 skip과 무관하게 계속 빠져야 함(회귀 확인)', () => {
  setupVaryingRecsDB();
  sandbox.DB.recurrences[0].edits = { '2026-06-10': { amount: 45000 } };
  const vr = sandbox.varyingRecs();
  assert.ok(!vr.some((x) => x.date === '2026-06-10'), 'edits가 있는 회차는 여전히 알림 목록에서 빠져야 함');
});

/* ---------- openFixShortfall: "부족해요/해결 방법"에서 플랜을 실행하지 않고 시트를 닫으면
 * _fixWhen(고른 이체일)이 초기화되지 않아, 전혀 다른(다른 자산·다른 날짜) 부족 상황을 열어도
 * 예전에 고른 날짜를 그대로 이어쓰던 버그의 회귀 테스트(app-evolve cycle42).
 * _fixWhen은 planTransfer/planSplitTransfer가 실제로 실행됐을 때만 null로 리셋되므로,
 * "날짜 선택"만 하고 취소한 뒤 다른 자산의 알림을 열면 stale한 날짜 기준으로 findDonors가
 * 계산돼 아직 확정되지 않은 잔액을 보여주고, 그 날짜로 이체가 잘못 기록될 수 있었다. */
function setupFixShortfallDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: {},
    assets: [
      { id: 'assetA', name: 'A통장', type: 'cash', baseAmount: 0 },
      { id: 'assetB', name: 'B통장', type: 'cash', baseAmount: 0 },
      { id: 'donor', name: '여유통장', type: 'cash', baseAmount: 100000 },
    ],
    txns: [],
    recurrences: [],
  };
  sandbox._fixWhen = null;
  sandbox._fixCtx = null;
}
test('openFixShortfall: 실행 없이 닫은 뒤 다른(다른 자산·다른 날짜) 부족 상황을 열면 이전에 고른 이체일을 이어쓰지 않는다(app-evolve cycle42)', () => {
  setupFixShortfallDB();
  sandbox.openFixShortfall('assetA', '2026-06-20', 50000);
  assert.strictEqual(sandbox._fixWhen, sandbox.addDays('2026-06-20', -1), '처음 열면 결제 전날이 기본값이어야 함');
  // 사용자가 '날짜 선택'으로 임의의 날짜를 고르고, 플랜은 실행하지 않은 채 시트를 닫음
  // (fixSetWhen('pick')의 openFieldDatePicker 콜백이 하는 일과 동일 — planTransfer를 타지 않으므로 _fixWhen이 리셋되지 않음)
  sandbox._fixWhen = '2026-01-01';
  // 몇 주 뒤, 전혀 다른 자산·날짜의 부족 알림을 연다
  sandbox.openFixShortfall('assetB', '2026-07-25', 30000);
  assert.strictEqual(sandbox._fixWhen, sandbox.addDays('2026-07-25', -1), '다른 부족 상황을 열면 이전에 고른 날짜가 아니라 새 결제 전날로 기본값이 되어야 함');
});
test('openFixShortfall: 같은 부족 상황을 다시 열 때는(날짜 선택 후 재렌더) 고른 이체일을 그대로 유지한다(회귀 확인)', () => {
  setupFixShortfallDB();
  sandbox.openFixShortfall('assetA', '2026-06-20', 50000);
  sandbox._fixWhen = '2026-06-18'; // 사용자가 '날짜 선택'으로 직접 고른 날짜
  // fixSetWhen('pick')의 콜백은 같은 ctx(_fixCtx.targetId/date)로 openFixShortfall을 다시 부른다
  sandbox.openFixShortfall('assetA', '2026-06-20', 50000);
  assert.strictEqual(sandbox._fixWhen, '2026-06-18', '같은 (targetId,date) 컨텍스트면 직접 고른 날짜를 유지해야 함');
});

/* ---------- planNegatives/homeAlerts/updateAlerts: 홈 알림 엔진 회귀 테스트 (app-evolve cycle43)
 * critique(6440b90)에서 지적한 대로, 최근 10사이클 버그 수정 다수(budgetOver 알림 누락,
 * varyingRecs skip 필터, findDonors when/date, openFixShortfall stale _fixWhen 등)가 전부
 * planNegatives()/homeAlerts()의 9개 알림 kind로 흘러드는 코드인데 회귀 테스트가 전혀 없었다.
 * 특히 quick/quickMulti·budgetOver/budgetOverMulti는 단일/복수 카운트로 분기하는 복붙 패턴이라
 * 한쪽만 고치는 회귀에 취약해, 정확히 1건↔2건 경계를 명시적으로 커버한다. ---------- */
function setupHomeAlertsDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox.CLOUD_UID = null;
  sandbox.CLOUD_SYNC_STATE = 'idle';
  sandbox.STORAGE_PERSISTED = true; // '저장공간 보호 안 됨' 경고를 이번 알림 케이스에서 끄기 위함
  sandbox.DB = {
    settings: { lastExport: Date.now(), persistWarnDismissed: true },
    catVar: {},
    budgetHistory: {},
    assets: [],
    txns: [],
    recurrences: [],
  };
}
test('planNegatives: 오늘 이미 마이너스인 통장은 첫 마이너스 날짜가 오늘로 잡힌다(run<0?TODAY:null 분기)', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: -30000 }],
    txns: [],
    recurrences: [],
  };
  const out = sandbox.planNegatives();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].date, sandbox.TODAY, '이미 마이너스면 첫 마이너스 날짜는 오늘이어야 함');
  assert.strictEqual(out[0].min, -30000);
});
test('planNegatives: 지금은 플러스지만 예정 지출로 특정 날짜부터 마이너스로 전환되면 그 날짜와 최소 잔액을 정확히 찾는다(회귀 확인)', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: 10000 }],
    txns: [
      { id: 't1', date: '2026-06-20', type: 'expense', category: '식비', amount: 15000, fromAssetId: 'a1' },
      { id: 't2', date: '2026-06-25', type: 'income', category: '용돈', amount: 3000, toAssetId: 'a1' },
    ],
    recurrences: [],
  };
  const out = sandbox.planNegatives();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].date, '2026-06-20', '마이너스로 처음 전환되는 날짜를 찾아야 함');
  assert.strictEqual(out[0].min, -5000, '이후 입금으로 회복돼도 구간 내 최소 잔액을 유지해야 함');
});
test('planNegatives: 저축 등 플랜 대상이 아닌 통장(isPlanAcct=false)은 마이너스여도 목록에 포함되지 않는다(회귀 확인)', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: {},
    assets: [{ id: 's1', name: '적금', owner: '나', type: 'savings', baseAmount: -10000 }],
    txns: [],
    recurrences: [],
  };
  assert.deepStrictEqual(Array.from(sandbox.planNegatives()), []);
});
test('homeAlerts: 변동 항목(quick)이 정확히 1건이면 quick, 2건으로 늘면 quickMulti로 묶인다(app-evolve cycle43)', () => {
  setupHomeAlertsDB();
  sandbox.setCatVar('expense', '전기요금', true);
  sandbox.DB.recurrences.push({
    id: 'r1', active: true, freq: 'monthly', type: 'expense', category: '전기요금',
    day: 10, startDate: '2026-01-10', endDate: null, count: null, amount: 50000,
    weekend: 'none', skip: [], edits: {},
  });
  let alerts = sandbox.homeAlerts([]);
  let quick = alerts.filter((a) => a.kind === 'quick' || a.kind === 'quickMulti');
  assert.strictEqual(quick.length, 1);
  assert.strictEqual(quick[0].kind, 'quick', '정확히 1건이면 quick이어야 함');
  assert.strictEqual(quick[0].recId, 'r1');
  assert.strictEqual(quick[0].date, '2026-06-10');

  sandbox.setCatVar('expense', '통신비', true);
  sandbox.DB.recurrences.push({
    id: 'r2', active: true, freq: 'monthly', type: 'expense', category: '통신비',
    day: 12, startDate: '2026-01-12', endDate: null, count: null, amount: 30000,
    weekend: 'none', skip: [], edits: {},
  });
  alerts = sandbox.homeAlerts([]);
  quick = alerts.filter((a) => a.kind === 'quick' || a.kind === 'quickMulti');
  assert.strictEqual(quick.length, 1);
  assert.strictEqual(quick[0].kind, 'quickMulti', '2건이 되면 quickMulti 하나로 묶여야 함');
  assert.strictEqual(quick[0].count, 2);
});
test('homeAlerts: 예산 초과 카테고리가 정확히 1개면 budgetOver, 2개로 늘면 budgetOverMulti로 묶인다(app-evolve cycle43)', () => {
  setupHomeAlertsDB();
  sandbox.setBudgetFrom('식비', 2026, 6, 100000);
  sandbox.DB.txns.push({ id: 't1', date: '2026-06-05', type: 'expense', category: '식비', amount: 150000 });
  let alerts = sandbox.homeAlerts([]);
  let bo = alerts.filter((a) => a.kind === 'budgetOver' || a.kind === 'budgetOverMulti');
  assert.strictEqual(bo.length, 1);
  assert.strictEqual(bo[0].kind, 'budgetOver', '정확히 1개 초과면 budgetOver여야 함');
  assert.strictEqual(bo[0].cat, '식비');
  assert.strictEqual(bo[0].spent, 150000);
  assert.strictEqual(bo[0].budget, 100000);

  sandbox.setBudgetFrom('교통', 2026, 6, 50000);
  sandbox.DB.txns.push({ id: 't2', date: '2026-06-06', type: 'expense', category: '교통', amount: 80000 });
  alerts = sandbox.homeAlerts([]);
  bo = alerts.filter((a) => a.kind === 'budgetOver' || a.kind === 'budgetOverMulti');
  assert.strictEqual(bo.length, 1);
  assert.strictEqual(bo[0].kind, 'budgetOverMulti', '2개로 늘면 budgetOverMulti 하나로 묶여야 함');
  assert.strictEqual(bo[0].count, 2);
});
test('homeAlerts: 예산 이내(초과 없음)면 budgetOver/budgetOverMulti 둘 다 나타나지 않는다(회귀 확인)', () => {
  setupHomeAlertsDB();
  sandbox.setBudgetFrom('식비', 2026, 6, 100000);
  sandbox.DB.txns.push({ id: 't1', date: '2026-06-05', type: 'expense', category: '식비', amount: 90000 });
  const alerts = sandbox.homeAlerts([]);
  assert.ok(!alerts.some((a) => a.kind === 'budgetOver' || a.kind === 'budgetOverMulti'));
});
test('homeAlerts: planNegatives 결과(neg)를 그대로 넘겨받아 자산별 neg 알림으로 변환한다(회귀 확인)', () => {
  setupHomeAlertsDB();
  const neg = [{ assetId: 'a1', name: '통장1', owner: '나', date: '2026-06-20', min: -5000 }];
  const alerts = sandbox.homeAlerts(neg);
  const negAlerts = alerts.filter((a) => a.kind === 'neg');
  assert.strictEqual(negAlerts.length, 1);
  assert.strictEqual(negAlerts[0].assetId, 'a1');
  assert.strictEqual(negAlerts[0].date, '2026-06-20');
  assert.strictEqual(negAlerts[0].min, -5000);
});
test('updateAlerts: neg를 생략하면 planNegatives()를 다시 계산해서 배지 개수/on 상태에 반영한다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: -1000 }],
    txns: [],
    recurrences: [],
  };
  sandbox.planBadgeEl.classList.list = [];
  sandbox.planBadgeEl._text = '';
  const neg = sandbox.updateAlerts(undefined);
  assert.strictEqual(neg.length, 1, 'planNegatives()를 다시 계산해 반환해야 함');
  assert.strictEqual(sandbox.planBadgeEl.textContent, '1');
  assert.strictEqual(sandbox.planBadgeEl.classList.contains('on'), true);
});
test('updateAlerts: neg를 미리 넘기면 planNegatives()를 다시 계산하지 않고 그대로 써서 배지를 끈다(회귀 확인)', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox._balCache.clear();
  // planNegatives가 다시 불리면 마이너스로 잡힐 DB를 일부러 넣어두고, neg=[]를 직접 넘겨
  // updateAlerts가 그 값을 재계산하지 않고 그대로 신뢰하는지 확인한다.
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: -1000 }],
    txns: [],
    recurrences: [],
  };
  sandbox.planBadgeEl.classList.list = ['on'];
  sandbox.planBadgeEl._text = '3';
  const neg = sandbox.updateAlerts([]);
  assert.deepStrictEqual(neg, [], '넘겨준 neg를 그대로 반환해야 함(재계산 없음)');
  assert.strictEqual(sandbox.planBadgeEl.textContent, '0');
  assert.strictEqual(sandbox.planBadgeEl.classList.contains('on'), false);
});

/* ---------- openCatManage: 렌더 함수 스모크 테스트 ----------
 * test/run.js는 지금까지 순수 로직 함수만 검증했고, innerHTML을 직접 쓰는 렌더 함수는
 * 전부 커버 밖이었다(renderHome/renderAssets/renderTxSheet/renderHistory 등 파일 함수 대부분).
 * 빌드/타입체크가 전혀 없는 단일 파일이라 템플릿 리터럴 오타나 정의 안 된 변수 참조가
 * 순수 로직 테스트를 다 통과하고도 화면에서만 크래시할 수 있다. openCatManage는 렌더 함수 중
 * DOM/캐시 의존이 가장 얕아(openSheet 결과 문자열만 확인하면 됨) 첫 스모크 테스트 대상으로 골랐다.
 * 나머지 render*()는 monthStats/expenseByCat/histRow 등 더 깊은 의존 그래프가 있어 후속 사이클 과제로 남긴다. */
function setupCatManageDB() {
  sandbox.DB = {
    categories: { expense: ['식비', '교통'], income: ['급여', sandbox.ADJUST_CAT], saving: ['적금'] },
    catIcon: {},
    catVar: {},
  };
  sandbox.catAddDraft = null;
  sandbox.lastSheetHtml = null;
}
test('openCatManage: expense 탭 — throw 없이 카테고리 행과 변동/고정 뱃지를 그린다', () => {
  setupCatManageDB();
  sandbox.DB.catVar[sandbox.catKey('expense', '식비')] = true;
  sandbox.openCatManage('expense');
  const html = sandbox.lastSheetHtml;
  assert.ok(html, 'openSheet가 호출돼야 함');
  assert.ok(html.includes('식비'));
  assert.ok(html.includes('교통'));
  assert.ok(html.includes('변동'), '변동 카테고리는 "변동" 뱃지를 보여줘야 함');
  assert.ok(html.includes('고정'), '변동 아닌 카테고리는 "고정" 뱃지를 보여줘야 함');
});
test('openCatManage: saving 탭 — 변동/고정 뱃지(varPill) 없이 그린다(회귀 확인)', () => {
  setupCatManageDB();
  sandbox.openCatManage('saving');
  const html = sandbox.lastSheetHtml;
  assert.ok(html.includes('적금'));
  assert.ok(!html.includes('varpill'), 'saving 탭은 변동/고정 뱃지가 없어야 함');
});
test('openCatManage: income 탭의 ADJUST_CAT(잔액 조정)은 "자동 생성" 표시만 하고 수정/삭제 액션은 숨긴다', () => {
  setupCatManageDB();
  // 다른 income 카테고리(급여 등)의 delCat(/renameCatSheet( 호출과 뒤섞이지 않도록
  // ADJUST_CAT 하나만 남겨서 isSysAdjust 분기를 명확히 검증한다.
  sandbox.DB.categories.income = [sandbox.ADJUST_CAT];
  sandbox.openCatManage('income');
  assert.ok(sandbox.lastSheetHtml.includes('자동 생성'));
  assert.ok(!sandbox.lastSheetHtml.includes('delCat('), 'ADJUST_CAT은 삭제 버튼을 보여주면 안 됨');
  assert.ok(!sandbox.lastSheetHtml.includes('renameCatSheet('), 'ADJUST_CAT은 수정 버튼을 보여주면 안 됨');
});
test('openCatManage: keep=true로 다시 열면 진행 중이던 catAddDraft(이름/아이콘 입력값)를 리셋하지 않는다(회귀 확인)', () => {
  setupCatManageDB();
  sandbox.catAddDraft = { name: '새카테', icon: 'gift' };
  sandbox.openCatManage('expense', true);
  assert.strictEqual(sandbox.catAddDraft.name, '새카테', 'keep=true면 입력 중이던 이름이 지워지면 안 됨');
  assert.ok(sandbox.lastSheetHtml.includes('새카테'));
});

/* ---------- renderTxSheet: 렌더 함수 스모크 테스트 ----------
 * cycle43 advance의 openCatManage 사례를 이어받는다. renderTxSheet는 openCatManage와 비슷하게
 * 얕은 의존(txDraft 전역 상태 + catAv/catGlyph/assetPickBtn/endCondFields/openFormSheet)만 있으면서도,
 * 지출/수입/이체/저축 4타입 + 반복 on/off + 월간 반복일 커스텀 입력 등 분기가 가장 많고 이번
 * 로테이션에서만도 관련 폼 버그(openFixShortfall stale _fixWhen, varyingRecs skip 필터 등)가 여러 번
 * 나온 화면이라 안전망 공백의 실질 위험이 가장 크다고 판단해 두 번째 스모크 테스트 대상으로 골랐다.
 * openFormSheet는 실제 소스를 그대로 추출한다 — $('sheetScroll')이 sandbox.$에서 항상 null을
 * 돌려주므로 _formScroll을 실제로 건드리지 않고 openSheet(html) 호출만 그대로 통과시킨다. */
function setupTxSheetDB() {
  sandbox.DB = {
    categories: { expense: ['식비'], income: ['급여'], saving: ['적금'] },
    catIcon: {}, catVar: {},
    assets: [
      { id: 'a1', name: '주계좌', type: 'cash', owner: '나' },
      { id: 'a2', name: '적금통장', type: 'savings', owner: '나' },
    ],
  };
  sandbox.window._recCtx = null;
  sandbox.lastSheetHtml = null;
}
test('renderTxSheet: type별로 자산 필드가 from/to 중 올바른 조합으로 나온다', () => {
  setupTxSheetDB();
  sandbox.txDraft = { type: 'expense', category: '식비', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', toAssetId: null, repeat: false };
  sandbox.renderTxSheet();
  let html = sandbox.lastSheetHtml;
  assert.ok(html.includes('출금 자산'));
  assert.ok(!html.includes('입금 자산') && !html.includes('보내는 자산'), 'expense는 출금 자산만 나와야 함');

  sandbox.txDraft = { type: 'income', category: '급여', date: '2026-01-01', amount: 1000, fromAssetId: null, toAssetId: 'a1', repeat: false };
  sandbox.renderTxSheet();
  html = sandbox.lastSheetHtml;
  assert.ok(html.includes('입금 자산'));
  assert.ok(!html.includes('출금 자산') && !html.includes('보내는 자산'), 'income은 입금 자산만 나와야 함');

  sandbox.txDraft = { type: 'transfer', category: '이체', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', toAssetId: 'a2', repeat: false };
  sandbox.renderTxSheet();
  html = sandbox.lastSheetHtml;
  assert.ok(html.includes('보내는 자산') && html.includes('받는 자산'));
  assert.ok(!html.includes('출금 자산') && !html.includes('입금 자산'), 'transfer는 보내는/받는 자산만 나와야 함');
});
test('renderTxSheet: 신규 생성(d.id 없음) 시에만 반복 토글이 보이고, 편집 중(d.id 있음)엔 숨긴다', () => {
  setupTxSheetDB();
  sandbox.txDraft = { type: 'expense', category: '식비', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', repeat: false };
  sandbox.renderTxSheet();
  assert.ok(sandbox.lastSheetHtml.includes('txToggleRepeat()'), '신규 생성 시 반복 토글이 보여야 함');

  sandbox.txDraft = { id: 't1', type: 'expense', category: '식비', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', repeat: false };
  sandbox.renderTxSheet();
  assert.ok(!sandbox.lastSheetHtml.includes('txToggleRepeat()'), '편집 중(d.id 있음)엔 반복 토글이 보이면 안 됨');
});
test('renderTxSheet: 반복 on + 매월, day가 1/5/15/25 프리셋에 없으면 직접 입력 필드가 뜬다', () => {
  setupTxSheetDB();
  sandbox.txDraft = { type: 'expense', category: '식비', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', repeat: true, freq: 'monthly', day: 10 };
  sandbox.renderTxSheet();
  assert.ok(sandbox.lastSheetHtml.includes('id="txDayIn"'), 'day=10은 1/5/15/25 프리셋에 없으므로 직접 입력 필드가 떠야 함');

  sandbox.txDraft = { type: 'expense', category: '식비', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', repeat: true, freq: 'monthly', day: 15 };
  sandbox.renderTxSheet();
  assert.ok(!sandbox.lastSheetHtml.includes('id="txDayIn"'), 'day=15는 프리셋에 있으므로 직접 입력 필드가 뜨면 안 됨');
});
test('renderTxSheet: window._recCtx가 있으면 반복 개별 수정 모드(금액만)로 렌더되고 삭제 버튼이 recCtxDel()을 호출한다', () => {
  setupTxSheetDB();
  sandbox.txDraft = { type: 'expense', category: '식비', memo: '넷플릭스', amount: 5000 };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'one' };
  sandbox.renderTxSheet();
  const html = sandbox.lastSheetHtml;
  assert.ok(html.includes('반복 내역 수정'));
  assert.ok(html.includes('recCtxDel()'), '삭제 버튼은 recCtxDel()을 호출해야 함');
  assert.ok(!html.includes('txToggleRepeat()'), '반복 개별 수정 모드에선 타입/반복 전체 폼이 아니라 금액 입력만 나와야 함');
});
test('txType: 타입 전환 시 카테고리와 입금 자산 기본값이 갱신되고 재렌더된다', () => {
  setupTxSheetDB();
  sandbox.txDraft = { type: 'expense', category: '식비', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', toAssetId: null, repeat: false };
  sandbox.txType('income');
  assert.strictEqual(sandbox.txDraft.type, 'income');
  assert.strictEqual(sandbox.txDraft.category, '급여');
  assert.strictEqual(sandbox.txDraft.toAssetId, 'a1', 'income 전환 시 입금 자산이 비어 있으면 firstCash()로 채워져야 함');
  assert.ok(sandbox.lastSheetHtml.includes('입금 자산'), 'txType()이 renderTxSheet를 재호출해 income 폼을 그려야 함');
});
test('txToggleRepeat: 반복을 켜면 day 기본값이 시작일의 일자로 채워지고 반복 필드가 렌더된다', () => {
  setupTxSheetDB();
  sandbox.txDraft = { type: 'expense', category: '식비', date: '2026-01-13', amount: 1000, fromAssetId: 'a1', repeat: false };
  sandbox.txToggleRepeat();
  assert.strictEqual(sandbox.txDraft.repeat, true);
  assert.strictEqual(sandbox.txDraft.day, 13, '반복 첫 on 시 day 기본값은 시작일의 일자(13일)여야 함');
  // freq는 아직 비어 있어(txToggleRepeat은 day만 채우고 freq는 건드리지 않음) dayField는 안 뜨지만,
  // rpt=true라 주기 선택(freqBtns)·종료조건은 항상 렌더된다.
  assert.ok(sandbox.lastSheetHtml.includes('주기'), '반복 on 상태로 재렌더돼 주기 선택 필드가 나와야 함');
});

/* ---------- assetPickBtn/renderPlan: a.name·a.owner 미이스케이프 self-XSS 봉합 회귀 ----------
 * assetPickBtn()은 지출/수입/이체/저축만기이체/반복거래 폼 등에서 재사용되는 공용 컴포넌트라,
 * 자산 이름이나 귀속(owner)에 <img onerror=...> 같은 값이 저장되면(saveAsset()이 저장 시
 * 값을 검증하지 않음) 그 다음 아무 거래 폼을 열 때마다 실행되는 self-XSS였다. 바로 옆
 * openAssetPicker()의 자산 리스트는 이미 esc()로 감싸져 있어 이건 일관성 공백이었다.
 * accountName()(d3f7bdc)과 같은 계열이지만 다른 미해결 지점이라 esc-at-render 패턴을 그대로
 * 적용했다. */
test('assetPickBtn: 자산명·귀속에 담긴 태그가 esc()로 이스케이프된다', () => {
  sandbox.DB = { assets: [{ id: 'a1', name: '<img src=x onerror=alert(1)>', type: 'cash', owner: '<b>나</b>' }] };
  const html = sandbox.assetPickBtn('a1', 'noop()');
  assert.ok(!html.includes('<img'), 'assetPickBtn()은 자산명의 태그를 이스케이프해야 함');
  assert.ok(html.includes('&lt;img'), 'assetPickBtn()은 자산명을 esc()로 감싸야 함');
  assert.ok(!html.includes('<b>나</b>'), 'assetPickBtn()은 귀속(owner)의 태그도 이스케이프해야 함');
  assert.ok(html.includes('&lt;b&gt;나&lt;/b&gt;'), 'assetPickBtn()은 귀속을 esc()로 감싸야 함');
});
test('assetPickBtn: 선택된 자산이 없으면(id 불일치) placeholder만 그리고 크래시하지 않는다', () => {
  sandbox.DB = { assets: [] };
  const html = sandbox.assetPickBtn('missing', 'noop()');
  assert.ok(html.includes('선택하세요'));
});
// renderPlan()은 $/monthNav/planBalCard 등 화면 전용 의존성이 많아 실행 대신 소스 텍스트로
// esc() 사용 여부를 확인한다(위 renderPlan 접근성 테스트들과 같은 방식).
test('renderPlan: 통장 선택 버튼(fv)의 자산명이 esc()로 감싸져 있다', () => {
  const body = extractFunction('renderPlan');
  assert.ok(body.includes("${a?esc(a.name):'없음'}"), 'renderPlan()의 통장 선택 버튼이 a.name을 esc() 없이 그대로 꽂고 있음');
});

/* ---------- accountName/esc: self-XSS 봉합 회귀 (d3f7bdc) ---------- */
// 가입 이메일 검증 정규식(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)이 @와 공백만 막고 <,>,"는 걸러내지
// 않아 <img src=x onerror=...>@a.co 같은 이메일이 가입을 통과해 SESSION에 그대로 남는다.
// accountName()은 AUTH.rec(SESSION)이 없으면(r=null) SESSION을 그대로 반환하므로, 이 케이스는
// AUTH 스텁 없이 SESSION만 악성 문자열로 세팅해도 그대로 재현된다.
test('accountName: 로그인 계정이 없으면(r=null) SESSION 문자열을 그대로 반환한다(이스케이프는 호출부 책임)', () => {
  sandbox.SESSION = '<img src=x onerror=alert(1)>@a.co';
  assert.strictEqual(sandbox.accountName(), '<img src=x onerror=alert(1)>@a.co');
});
test('esc(accountName()): 악성 이메일이 SESSION에 남아 있어도 esc()를 거치면 태그가 무력화된다', () => {
  sandbox.SESSION = '<img src=x onerror=alert(1)>@a.co';
  const out = sandbox.esc(sandbox.accountName());
  assert.ok(!out.includes('<img'), 'esc() 이후엔 <img 태그가 그대로 남아있으면 안 됨');
  assert.strictEqual(out, '&lt;img src=x onerror=alert(1)&gt;@a.co');
});
test('accountName: 카카오 로그인이면 닉네임(없으면 기본값)을 반환한다', () => {
  sandbox.SESSION = 'kakao-1';
  sandbox.AUTH = { rec: () => ({ kakao: true, nick: '<b>닉네임</b>' }) };
  assert.strictEqual(sandbox.accountName(), '<b>닉네임</b>');
  assert.ok(sandbox.esc(sandbox.accountName()).includes('&lt;b&gt;'), 'esc()를 거치면 닉네임의 태그도 이스케이프돼야 함');
  sandbox.AUTH = { rec: () => null };
});

/* ---------- renderHome: 렌더 함수 스모크 테스트 (app-evolve cycle47 critique/advance) ----------
 * openCatManage(cycle43)·renderTxSheet(cycle44)에 이어 세 번째 render* 스모크 테스트 대상.
 * renderHome은 앱의 기본 진입 탭이라 깨지면 앱 진입 자체가 막히는 최악의 실패 모드인데, 지금까지
 * FUNCTIONS 목록에 없어 실행 기반 테스트가 전혀 없었고 기존 "커버리지"는 소스 문자열 포함 검사뿐이었다.
 * renderHome이 부르는 monthStats/expenseByCat/planNegatives/homeAlerts/emptyAssetCards/
 * nextOutflowCard/monthOutflowCard/planGaugeCard/expenseBreakdownCard/rateUnknown/needGold/
 * homeAlertCard는 전부 순수 문자열/데이터 빌더라, renderAssets가 필요로 하는 실제 DOM/드래그
 * 모킹 없이도 $('page-home').innerHTML 결과만 확인하면 검증할 수 있다. */
function setupHomeDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox.CLOUD_UID = null;
  sandbox.CLOUD_SYNC_STATE = 'idle';
  sandbox.STORAGE_PERSISTED = true;
  sandbox.pageHomeEl._html = '';
  sandbox.DB = {
    settings: { includeScheduled: true, lastExport: Date.now(), persistWarnDismissed: true },
    catVar: {},
    budgetHistory: {},
    assets: [],
    txns: [],
    recurrences: [],
    rates: { fx: {}, stocks: {}, goldPerG: 0, syncedAt: 0 },
  };
}
test('renderHome: 정상 DB로 호출하면 예외 없이 실행되고 기본 섹션들이 렌더된다', () => {
  setupHomeDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [
    { id: 't1', date: '2026-06-05', type: 'expense', category: '식비', amount: 20000, fromAssetId: 'a1' },
    { id: 't2', date: '2026-06-10', type: 'income', category: '급여', amount: 300000, toAssetId: 'a1' },
  ];
  assert.doesNotThrow(() => sandbox.renderHome());
  const html = sandbox.pageHomeEl.innerHTML;
  assert.ok(html, "$('page-home').innerHTML이 채워져야 함");
  assert.ok(html.includes('이번 달 살림'), '홈 헤더가 렌더돼야 함');
  assert.ok(html.includes('이번 달 예정 대비 오늘까지'), '플랜 게이지 섹션 타이틀이 렌더돼야 함');
  assert.ok(html.includes('식비'), '지출 분석 카드에 카테고리명이 나와야 함');
});
test('renderHome: homeAlerts()가 항목을 반환하면 alert-stack이 렌더되고 알림 내용이 실제로 나온다', () => {
  setupHomeDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.setBudgetFrom('식비', 2026, 6, 100000);
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-05', type: 'expense', category: '식비', amount: 150000, fromAssetId: 'a1' }];
  sandbox.renderHome();
  const html = sandbox.pageHomeEl.innerHTML;
  assert.ok(html.includes('class="alert-stack"'), '알림이 있으면 alert-stack이 렌더돼야 함');
  assert.ok(!html.includes('모든 통장이 안전해요'), '알림이 있으면 all-clear 문구는 나오면 안 됨');
  assert.ok(html.includes('식비 예산을'), 'budgetOver 알림 카드 내용이 실제로 렌더돼야 함');
});
test('renderHome: 알림이 없고 plan 계좌+거래가 있으면 all-clear 분기("모든 통장이 안전해요")가 렌더된다', () => {
  setupHomeDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-05', type: 'expense', category: '식비', amount: 20000, fromAssetId: 'a1' }];
  sandbox.renderHome();
  const html = sandbox.pageHomeEl.innerHTML;
  assert.ok(html.includes('모든 통장이 안전해요'), '알림 없음+플랜 계좌+거래 있음이면 all-clear가 나와야 함');
  assert.ok(!html.includes('class="alert-stack"'));
});
test('renderHome: 시장가(금/외화/주식) 자산이 있을 때만 시세 섹션이 나온다', () => {
  setupHomeDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [];
  sandbox.renderHome();
  assert.ok(!sandbox.pageHomeEl.innerHTML.includes('mkt-list'), '시장가 자산이 없으면 시세 섹션이 나오면 안 됨');

  sandbox.DB.assets.push({ id: 'g1', name: '금', owner: '나', type: 'gold', baseAmount: 0 });
  sandbox.DB.rates.goldPerG = 90000;
  sandbox.renderHome();
  const html = sandbox.pageHomeEl.innerHTML;
  assert.ok(html.includes('mkt-list'), '금 보유 자산이 있으면 시세 섹션이 나와야 함');
  assert.ok(html.includes('금 (순금 1g)'));
});

/* ---------- renderAssets: 렌더 함수 스모크 테스트 (app-evolve cycle49 critique/advance) ----------
 * openCatManage(cycle43)·renderTxSheet(cycle44)·renderHome(cycle47)에 이어 네 번째 render*
 * 안전망 대상. cycle43/44/46/47/48에서 "의존 그래프가 깊어 무인 사이클에 부담"이라는 이유로
 * 다섯 차례 이연됐지만, renderAssets()가 부르는 헬퍼(assetBodyHTML/nwPane/nwHistoryCard/
 * pageHead/totalAssets/totalDebt/ownerListArr 등)는 실제로는 전부 순수 문자열 빌더이고,
 * 진짜 부수효과가 있는 호출은 wireGroupDrag/wireLongPress/wireNwCarousel/restoreNwScroll/
 * animNums/updateSelBottom 여섯 개뿐이다 — fitAll처럼 이 여섯 개를 no-op으로 흉내내면
 * $('page-assets').innerHTML 결과만으로 검증할 수 있다. */
function setupAssetsDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox._lastNwOwner = null;
  sandbox.pageAssetsEl._html = '';
  sandbox.ST = { editAssets: false, aSel: { mode: false, ids: new Set() }, assetOwner: 'all' };
  sandbox.DB = {
    settings: { includeScheduled: true, groupOrder: sandbox.DEFAULT_GROUP_ORDER, assetSort: 'custom' },
    assets: [],
    owners: ['나'],
    txns: [],
    recurrences: [],
    nwHistory: [],
    rates: { fx: {}, stocks: {}, goldPerG: 0, syncedAt: 0 },
  };
}
test('renderAssets: 빈 자산 목록에서 예외 없이 실행되고 빈 상태 안내가 렌더된다', () => {
  setupAssetsDB();
  assert.doesNotThrow(() => sandbox.renderAssets());
  const html = sandbox.pageAssetsEl.innerHTML;
  assert.ok(html, "$('page-assets').innerHTML이 채워져야 함");
  assert.ok(html.includes('자산 관리'), '자산 탭 헤더가 렌더돼야 함');
  assert.ok(html.includes('아직 등록한 자산이 없어요'), '자산이 없으면 빈 상태 안내가 나와야 함');
});
test('renderAssets: 자산이 있으면 그룹 타이틀과 자산 카드가 실제로 렌더된다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.renderAssets();
  const html = sandbox.pageAssetsEl.innerHTML;
  assert.ok(html.includes('현금예금'), '자산 종류 그룹 타이틀이 렌더돼야 함');
  assert.ok(html.includes('주계좌'), '자산 이름이 렌더돼야 함');
  assert.ok(!html.includes('아직 등록한 자산이 없어요'));
});
test('renderAssets: 편집 모드(ST.editAssets)에서는 드래그용 그룹 목록이 렌더된다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.editAssets = true;
  sandbox.renderAssets();
  const html = sandbox.pageAssetsEl.innerHTML;
  assert.ok(html.includes('id="dragList"'), '편집 모드에서는 그룹 순서 드래그 목록이 렌더돼야 함');
  assert.ok(html.includes('1개 자산'), '그룹별 자산 개수가 렌더돼야 함');
  assert.ok(!html.includes('주계좌'), '편집 모드에서는 개별 자산 카드 대신 그룹만 나와야 함');
});
test('renderAssets: 멀티셀렉트 모드(ST.aSel.mode)에서는 선택 체크마크가 렌더된다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.aSel.mode = true;
  sandbox.renderAssets();
  const html = sandbox.pageAssetsEl.innerHTML;
  assert.ok(html.includes('sel-check'), '멀티셀렉트 모드에서는 선택 체크마크가 렌더돼야 함');
  assert.ok(html.includes("onclick=\"assetToggleSel('a1')\""), '자산 행 클릭이 assetToggleSel로 연결돼야 함');
});

/* ---------- renderLedger: 렌더 함수 스모크 테스트 (app-evolve cycle50 critique/advance) ----------
 * openCatManage(cycle43)·renderTxSheet(cycle44)·renderHome(cycle47)·renderAssets(cycle49)에
 * 이어 다섯 번째 render* 안전망 대상. renderLedger()는 홈 다음으로 가장 많이 보는 가계부 메인
 * 탭인데 test/run.js FUNCTIONS에 없어 실행 기반 테스트가 전혀 없었다. renderAssets와 같은 이유로
 * 실제 부수효과 호출은 wireMonthCarousel/wireLongPress/updateSelBottom/fitAll/animNums 다섯 개뿐이고
 * (모두 기존 no-op 스텁을 그대로 재사용하거나 이번에 wireMonthCarousel 하나만 새로 추가), 나머지
 * (dayTxns/txRow/calPane/calCellsFor/ledSumBox/ledSumInner/monthNav/modeSeg/pageHead)는 전부
 * 순수 문자열/데이터 빌더라 $('page-ledger').innerHTML 결과만으로 검증할 수 있다. */
function setupLedgerDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox._lastLedYM = null;
  sandbox.pageLedgerEl._html = '';
  sandbox.ST = {
    ledger: { y: 2026, m: 6, sel: '2026-06-15' },
    lSel: { mode: false, ids: new Set() },
    hist: { cat: '전체', q: '' },
  };
  sandbox.DB = {
    settings: { includeScheduled: true },
    assets: [],
    txns: [],
    recurrences: [],
  };
}
test('renderLedger: 선택한 날에 내역이 없으면 예외 없이 실행되고 빈 상태 안내가 렌더된다', () => {
  setupLedgerDB();
  assert.doesNotThrow(() => sandbox.renderLedger());
  const html = sandbox.pageLedgerEl.innerHTML;
  assert.ok(html, "$('page-ledger').innerHTML이 채워져야 함");
  assert.ok(html.includes('📒 가계부'), '가계부 탭 헤더가 렌더돼야 함');
  assert.ok(html.includes('이 날은 조용하네요'), '선택한 날에 내역이 없으면 빈 상태 안내가 나와야 함');
});
test('renderLedger: 선택한 날에 내역이 있으면 메모/금액이 실제로 렌더된다', () => {
  setupLedgerDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-15', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' }];
  sandbox.renderLedger();
  const html = sandbox.pageLedgerEl.innerHTML;
  assert.ok(html.includes('점심 김밥'), '내역 메모가 렌더돼야 함');
  assert.ok(html.includes('-8,000원'), '지출 금액이 렌더돼야 함');
  assert.ok(!html.includes('이 날은 조용하네요'));
});
test('renderLedger: 멀티셀렉트 모드(ST.lSel.mode)에서는 선택 체크마크가 렌더된다', () => {
  setupLedgerDB();
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-15', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' }];
  sandbox.ST.lSel.mode = true;
  sandbox.renderLedger();
  const html = sandbox.pageLedgerEl.innerHTML;
  assert.ok(html.includes('sel-check'), '멀티셀렉트 모드에서는 선택 체크마크가 렌더돼야 함');
  assert.ok(html.includes("onclick=\"ledgerToggleSel('t1')\""), '내역 행 클릭이 ledgerToggleSel로 연결돼야 함');
});
test('renderLedger: 오늘보다 미래 날짜를 선택하면 "예정" 라벨이 렌더된다', () => {
  setupLedgerDB();
  sandbox.ST.ledger.sel = '2026-06-20';
  sandbox.renderLedger();
  const html = sandbox.pageLedgerEl.innerHTML;
  assert.ok(html.includes('>예정<'), '오늘보다 미래인 날을 선택하면 day-head에 예정 라벨이 나와야 함');
});

/* ---------- txnsByDateInRange / calCellsFor 버킷화 회귀 테스트 (app-evolve cycle52 critique/advance) ----------
 * calCellsFor()가 42개 셀마다 dayTxns()→allTxns()를 개별 호출해, renderLedger()가 이전/현재/
 * 다음 3개월 패널을 그릴 때마다 DB.txns 전체를 수십 번 다시 스캔하던 문제(_recCache도 단일
 * 날짜 키 126개로 스래싱돼 무효화)를 없애기 위해 allTxns()를 범위당 한 번만 불러 날짜별로
 * 버킷화하는 txnsByDateInRange()를 도입했다. calCellsFor/calPane/renderLedger가 이제 이 맵을
 * 공유해서 쓰므로, 버킷 내용 자체와 그 맵을 실제로 소비하는 이전/다음 달 패널의 날짜 셀 금액이
 * 기존 셀별 조회(dayTxns)와 동일한 결과를 보여주는지 확인한다. */
test('txnsByDateInRange: 날짜별 버킷이 해당 날짜의 거래만 정확히 담는다', () => {
  setupLedgerDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [
    { id: 't1', date: '2026-06-01', type: 'expense', category: '식비', memo: '점심', amount: 8000, fromAssetId: 'a1' },
    { id: 't2', date: '2026-06-15', type: 'income', category: '급여', memo: '월급', amount: 3000000, toAssetId: 'a1' },
  ];
  const map = sandbox.txnsByDateInRange('2026-06-01', '2026-06-30');
  // vm 샌드박스에서 만들어진 배열은 host의 Array와 realm이 달라 deepStrictEqual이
  // (값은 같아도) 실패하므로, Array.from으로 host realm 배열로 정규화한다.
  assert.deepStrictEqual(Array.from(map.get('2026-06-01') || [], t => t.id), ['t1']);
  assert.deepStrictEqual(Array.from(map.get('2026-06-15') || [], t => t.id), ['t2']);
  assert.ok(!map.has('2026-06-02'), '거래가 없는 날짜는 버킷에 아예 없어야 함');
});
test('renderLedger: 이전/다음 달 패널의 실제 날짜 셀도 해당 날짜 거래 금액을 정확히 반영한다', () => {
  setupLedgerDB(); // ST.ledger는 2026-06 → 이전 패널 2026-05, 다음 패널 2026-07
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [
    { id: 'tp', date: '2026-05-20', type: 'expense', category: '식비', memo: '전달 지출', amount: 12000, fromAssetId: 'a1' },
    { id: 'tn', date: '2026-07-05', type: 'expense', category: '식비', memo: '다음달 지출', amount: 9000, fromAssetId: 'a1' },
  ];
  sandbox.renderLedger();
  const html = sandbox.pageLedgerEl.innerHTML;
  assert.ok(html.includes('1.2만'), '이전 달 패널의 실제 날짜 셀에 해당 날짜 지출(축약 표기)이 반영돼야 함');
  assert.ok(html.includes('9,000'), '다음 달 패널의 실제 날짜 셀에 해당 날짜 지출이 반영돼야 함');
});

/* ---------- renderHistory: 렌더 함수 스모크 테스트 (app-evolve cycle51 critique/advance) ----------
 * openCatManage(cycle43)·renderTxSheet(cycle44)·renderHome(cycle47)·renderAssets(cycle49)·
 * renderLedger(cycle50)에 이어 여섯 번째 render* 안전망 대상. renderHistory()는 내비게이션에서
 * 바로 접근 가능한 '전체 내역' 탭인데도 test/run.js에는 실행 기반 테스트가 없었다(filteredHist/
 * histInvalidate 순수 로직 테스트와, 소스 문자열에 '_histCache.key=null'이 있는지만 보는 텍스트
 * 검사뿐 — sandbox.renderHistory()를 호출한 적이 없음). renderHistory가 동기 호출하는 updateHist()가
 * 거치는 filteredHist/splitHist/histSumTotals/histTotHTML/histRow는 전부 순수 문자열/데이터
 * 빌더고, 실제 부수효과 호출은 wireLongPress/requestAnimationFrame(fitAll)/updateSelBottom 세
 * 개뿐(모두 기존 no-op 스텁 재사용) — $('page-history')/#histTotals/#histList innerHTML
 * 결과만으로 검증할 수 있다. */
function setupHistoryDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox._histCache = { key: null, list: null };
  sandbox.pageHistoryEl._html = '';
  sandbox.histTotalsEl._html = '';
  sandbox.histListEl._html = '';
  sandbox.ST = {
    hist: {
      cat: '전체', q: '', selMode: false, sel: new Set(), sortAsc: false,
      range: { from: '2026-01-01', to: '2026-12-31' }, preset: 'year', page: 1, avgMode: false,
    },
  };
  sandbox.DB = {
    settings: { includeScheduled: true },
    assets: [],
    txns: [],
    recurrences: [],
  };
}
test('renderHistory: 일치하는 거래가 없으면 예외 없이 실행되고 빈 상태 안내가 렌더된다', () => {
  setupHistoryDB();
  assert.doesNotThrow(() => sandbox.renderHistory());
  const html = sandbox.pageHistoryEl.innerHTML;
  assert.ok(html, "$('page-history').innerHTML이 채워져야 함");
  assert.ok(html.includes('메모·카테고리·자산 검색'), '전체 내역 탭 검색바가 렌더돼야 함');
  assert.ok(sandbox.histListEl.innerHTML.includes('이 기간에는 내역이 없어요'), '내역이 없으면 빈 상태 안내가 나와야 함');
});
test('renderHistory: 실제 거래가 있으면 메모/금액이 histList에, 건수가 histTotals에 실제로 렌더된다', () => {
  setupHistoryDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-10', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' }];
  sandbox.renderHistory();
  const listHtml = sandbox.histListEl.innerHTML;
  assert.ok(listHtml.includes('점심 김밥'), '내역 메모가 렌더돼야 함');
  assert.ok(listHtml.includes('-8,000원'), '지출 금액이 렌더돼야 함');
  assert.ok(!listHtml.includes('이 기간에는 내역이 없어요'));
  assert.ok(sandbox.histTotalsEl.innerHTML.includes('검색 결과 1건'), '합계 카드에 검색 결과 건수가 렌더돼야 함');
});
test('renderHistory: 멀티셀렉트 모드(ST.hist.selMode)에서는 검색바가 숨겨지고 선택 체크마크가 렌더된다', () => {
  setupHistoryDB();
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-10', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' }];
  sandbox.ST.hist.selMode = true;
  sandbox.renderHistory();
  assert.ok(!sandbox.pageHistoryEl.innerHTML.includes('메모·카테고리·자산 검색'), '멀티셀렉트 모드에서는 검색바가 숨겨져야 함');
  const listHtml = sandbox.histListEl.innerHTML;
  assert.ok(listHtml.includes('sel-check'), '멀티셀렉트 모드에서는 선택 체크마크가 렌더돼야 함');
  assert.ok(listHtml.includes("onclick=\"histToggleSel('t1')\""), '내역 행 클릭이 histToggleSel로 연결돼야 함');
});
test('renderHistory: 오늘보다 미래 날짜의 거래는 예정 라벨(sch-dot)이 렌더된다', () => {
  setupHistoryDB();
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-20', type: 'expense', category: '식비', memo: '예정 지출', amount: 5000 }];
  sandbox.renderHistory();
  const listHtml = sandbox.histListEl.innerHTML;
  assert.ok(listHtml.includes('sch-dot'), '오늘보다 미래인 거래는 예정 표시(sch-dot)가 나와야 함');
  assert.ok(listHtml.includes('>예정<'), '자산 정보가 없는 예정 거래는 "예정" 라벨이 나와야 함');
});

/* ---------- 실행 ---------- */
// pbkdf2Hash는 Web Crypto(subtle.deriveBits)를 쓰는 비동기 함수라, 러너도 async test를
// 지원해야 한다 — sync test는 그냥 await해도 즉시 반환되므로 기존 테스트에는 영향 없다.
(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
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
})();
