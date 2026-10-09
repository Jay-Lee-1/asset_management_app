#!/usr/bin/env node
/* 경량 회귀 테스트 러너 — 빌드 도구 없이 `node test/run.js`로 바로 실행된다.
 * 순수 로직 함수의 소스는 두 경로로 들어온다: (1) logic.js는 index.html처럼 그대로 읽어 vm에
 * 로드하고, (2) 아직 index.html 안에 있는 나머지는 정규식으로 텍스트를 슬라이싱해 추출한다.
 * 두 경로 모두 실제 앱 코드와 항상 같은 소스를 공유한다(복제/재구현 아님).
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

// netlify/functions/{stock,rates}.js는 브라우저가 아니라 Node(Netlify Functions)에서 도는
// 평범한 CommonJS 모듈이라, index.html처럼 정규식 슬라이싱을 할 필요 없이 그냥 require한다
// (module.exports는 exports.handler와 별개로 순수 함수만 추려 노출한다).
let stockFns = null, ratesFns = null;
try {
  stockFns = require(path.join(__dirname, '..', 'netlify', 'functions', 'stock.js'));
  ratesFns = require(path.join(__dirname, '..', 'netlify', 'functions', 'rates.js'));
} catch (e) {
  console.error('경고: netlify/functions require 실패, 관련 테스트를 건너뜁니다 —', e.message);
}

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(HTML_PATH, 'utf8');
// logic.js는 index.html이 정규식으로 슬라이싱하지 않고 브라우저처럼 그대로 로드하는 순수 로직
// 모듈이다 — 여기 있는 함수는 extractFunction/extractConst의 특수 케이스에서 벗어난다.
const LOGIC_PATH = path.join(__dirname, '..', 'logic.js');
const logicSrc = fs.readFileSync(LOGIC_PATH, 'utf8');

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

// extractConst는 첫 ";"를 종료 지점으로 보므로, AUTH/APPLOCK처럼 메서드 본문 안에 ";"가
// 여러 번 나오는 객체 리터럴에는 못 쓴다(첫 메서드 본문에서 끊겨버림). extractFunction과
// 같은 중괄호 깊이 세기 방식으로 `const NAME={...};` 선언 전체를 끊어낸다(app-evolve
// cycle148 advance, APPLOCK이 AUTH._lockStatus/_recordFail/_clearFails를 재사용하는지
// 실제 실행으로 검증하려면 둘 다 끌어와야 함).
function extractConstBlock(name) {
  const marker = `const ${name}=`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`extractConstBlock: "${name}" 선언을 index.html에서 찾지 못함`);
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error(`extractConstBlock: "${name}" 중괄호 짝이 맞지 않음(추출 로직 확인 필요)`);
  if (src[i] === ';') i++;
  return src.slice(start + 'const '.length, i);
}

// 위 extractFunction/extractConst/extractLet은 FUNCTIONS/CONSTS/LETS 목록에 이름을 올린
// 대상만 개별적으로 뽑아 vm에 태운다 — 목록 밖의 코드(이벤트 리스너 등 최상위 문, 또는
// 아직 FUNCTIONS에 추가되지 않은 새 함수)에 backtick 누락이나 중괄호 짝 안 맞음 같은 구문
// 오류가 있어도, 그 오류가 하필 어떤 함수의 몸통 밖에 있으면 개별 추출 테스트들은 전혀
// 건드리지 않고 계속 통과한다. 하지만 브라우저는 <script> 블록 하나를 통째로 한 번에
// 파싱하므로, 그 구문 오류 하나가 앱 전체(모든 탭)를 백지로 만든다. extractMainScript는
// 그 간극을 메우려고 메인 인라인 <script> 블록 전체를 원본 그대로(추출/가공 없이) 반환해,
// 아래 스모크 테스트가 실제 브라우저처럼 전체를 한 번에 구문 검사할 수 있게 한다.
// src.includes('id="X" attr="y"')는 파일 전체에서 그 문자열이 "어딘가에 존재하는지"만 보므로,
// 속성이 실제로는 그 엘리먼트에서 빠졌는데 같은 문자열이 주석/다른 엘리먼트/문자열 리터럴에 남아있어도
// 거짓으로 통과한다(app-evolve cycle146 critique가 짚은 거짓 안전감). extractTag(id)는 `id="X"`가
// 나오는 지점을 기준으로 그 **여는 태그 하나**의 범위(가장 가까운 앞쪽 "<"부터 그 태그를 닫는 ">"까지)만
// 잘라내 반환해, 이후 assert가 그 엘리먼트의 속성 문자열 안에서만 검사하도록 좁힌다.
// (이 프로젝트의 태그 속성값엔 ">"가 들어가지 않으므로 가장 단순한 lastIndexOf/indexOf 짝짓기로 충분하다.)
function extractTag(id) {
  const marker = `id="${id}"`;
  const idPos = src.indexOf(marker);
  if (idPos === -1) throw new Error(`extractTag: id="${id}" 엘리먼트를 index.html에서 찾지 못함`);
  const tagStart = src.lastIndexOf('<', idPos);
  if (tagStart === -1) throw new Error(`extractTag: id="${id}" 앞에서 여는 태그("<")를 찾지 못함`);
  const tagEnd = src.indexOf('>', idPos);
  if (tagEnd === -1) throw new Error(`extractTag: id="${id}" 뒤에서 태그를 닫는 ">"를 찾지 못함`);
  return src.slice(tagStart, tagEnd + 1);
}

function extractMainScript() {
  const afterExternalTags = src.indexOf('<script src="logic.js"></script>');
  if (afterExternalTags === -1) throw new Error('extractMainScript: logic.js 스크립트 태그를 찾지 못함');
  const openTag = '<script>';
  const start = src.indexOf(openTag, afterExternalTags);
  if (start === -1) throw new Error('extractMainScript: 메인 인라인 <script> 블록의 시작을 찾지 못함');
  const bodyStart = start + openTag.length;
  const end = src.indexOf('</script>', bodyStart);
  if (end === -1) throw new Error('extractMainScript: 메인 인라인 <script> 블록의 끝을 찾지 못함');
  return src.slice(bodyStart, end);
}

// 테스트 대상 + 그 대상이 내부에서 호출하는 순수 함수들.
// addDays/daysBetween/shiftWeekend/recDates/addMonthsStr/recNthDate/recCountUntil/truncateRecEnd,
// mergeCollection/gcTombstones/isCloudConflict/decidePushOutcome/computeRelinkBaseline,
// parseCSV/csvDateValid/csvDedupeKey,
// esc/normName/lastDay/monthEndStr/monthStartStr/matchTxnQuery/budgetKey/budgetProgress는
// index.html이 아니라 logic.js에 있다 — 위 logicSrc로 직접 로드하므로 이 목록에는 없다
// (app-evolve cycle97 advance, cycle111 advance).
const FUNCTIONS = [
  'addMonths', 'fetchWithTimeout', 'withTimeout',
  'dateBelowRangeFloor', 'dateAboveRangeCeil', 'recalcEndCond', 'isVarCat', 'setCatVar', 'activeRecsForAssets', 'activeRecsForCat',
  'num', 'doRenameCat', 'doDeleteCat', 'totalBudgetSummary', 'budgetForMonth', 'setBudgetFrom', 'addCat',
  'updateNwHistory', 'pruneNwHistory', 'nwChartPath', 'txnsToCSV',
  'unguardCsv', 'csvRowToImportTxn', 'buildImportPreview', 'doCsvImport',
  'twActive', 'twGuard', 'deleteTxnsUndo', 'deleteRecsUndo', 'deleteAssetsUndo', 'unsnapshotAssetName', 'doBulkCat', 'bulkCatPickFor',
  'deletedAssetHistoryExists', 'relinkDeletedAsset',
  'recApply', 'recSave', 'saveQuickAmount', 'migrate', 'restoreBackup', 'storageOutcomeMsg', 'shouldWarnUnpersisted', 'shouldWarnStorageSize', 'toggleRecActive', 'toggleAdjustSurplus', 'touchSave',
  'sanitizeAmount', 'sanitizeBackup',
  'saveRec', 'recHistFieldsChanged', 'splitRecOverrides', 'splitRecurrenceAt', 'recSaveScopeConfirm', 'recSaveScopeApply',
  'expandRec', 'allTxns', 'txnsByDateInRange', 'spendByCategory', 'spendTrend', 'spendTrendBadge', 'histSumTotals',
  'dayTypeTotals', 'isPending', 'isDuePending', 'pendingTransferCount', 'expenseBreakdownCard',
  'bigMin', 'upcomingOutflows', 'monthOutflows', 'syncAssetInputs', 'asOpenType', 'asOpenCur', 'asCur', 'asToggleNeg', 'openAssetSheet', 'saveAsset', 'groupItems', 'clampRecurringToMaturity', 'mergeRemoteDataIntoLocal', 'fmtAmt', 'fmtQty',
  'wname', 'fmtDate', 'shortDate', 'fmtDateFull', 'localHasUnsyncedChanges', 'shouldRetryCloudSync',
  'pullCloud', 'afterCloudAuth', 'resolveCloudPullRemote', 'pushCloud', 'measureCloudClockSkew',
  'shouldPullCloud', 'pullCloudIfStale', 'appIsOpen',
  'recordError', 'showErrBanner', 'hideErrBanner', 'renderCurrent', 'rowKeydown',
  'clampDay', 'saveTx', 'assetBase', 'balancesUpTo', 'balanceAt', 'balancesAtDates', 'balanceAtFromMap',
  'addBalanceAdjust', 'updateBalanceAdjust', 'toggleConfirmTransfers', 'rollPendingTransfers',
  'assetEval', 'assetGainLoss', 'assetGainLossBadge', 'costBasisField', 'assetBalance', 'schHorizon', 'ym', 'openAssetPicker', 'delOwner', 'doMaturity', 'openMaturity', 'firstCash',
  'detectStaleMarketValuedTxns', 'delBudget', 'saveBudget', 'openBudgetPrompt', 'openBigMinSheet',
  'hasFutureTxns', 'emptyAssets', 'tidySnoozed', 'snoozeTidy', 'emptyAssetCards', 'openTidyAsset', 'openTidyList', 'tidyListSnooze',
  'rateUnknown', 'setRate', 'filteredHist', 'histInvalidate', 'openAssetHistory', 'openAssetQtyLog', 'delAssetQtyLog', 'openCatHistory', 'histClearFilter', 'histClearAssetFilter', 'histClearCatFilter',
  'genSalt', 'pbkdf2Hash', 'genRecoveryCode', 'assetNm', 'confirmRecTransfer', 'postponeRecTransfer', 'openConfirmTransfer',
  'renderLockView', 'openForgotPinSheet', 'doForgotPin', 'tickForgotPinWait',
  'confirmTransferNow', 'postponeTransfer', 'confirmRecNow', 'openConfirmTransferList',
  'foreignSaveIsNewer', 'applyForeignSave', 'openCopyBackup', 'copyBackup', 'findDonors',
  'recIsVarying', 'varyingRecs', 'fixShortfallDefaultDate', 'openFixShortfall', 'lastActualAmount', 'openQuickAmount',
  'backupDue', 'planNegatives', 'homeAlerts', 'updateAlerts', 'goPlanTo', 'openNegList',
 'notifyAlertInfo', 'pickNotifyAlerts', 'pruneNotifiedIds', 'syncNotifyPermission',
  'catIconOf', 'catGlyph', 'openCatManage', 'openCatPicker',
  'catListOf', 'catAv', 'assetPickBtn', 'endCondFields', 'dayPickerHTML', 'openFormSheet', 'renderTxSheet', '_applyType', '_applyFreq', '_applyDay', '_applyCount', '_applyOpenCat', '_applyOpenAsset', 'txType', 'txToggleRepeat',
  'accountName', 'dbIsEmpty', 'guestHasData',
  'txScheduled', 'monthStats', 'monthStats2', 'expenseByCat', 'needGold', 'inQuietWindow', 'fmtSynced', 'rateStatusText',
  'nextBigOutflow', 'dday', 'balanceOn', 'nextOutflowCard', 'monthOutflowCard', 'planGaugeCard', 'homeAlertCard', 'renderHome',
  'totalAssets', 'totalDebt', 'ownerAssets', 'ownerDebt', 'ownerListArr', 'nwPane', 'shortDate2', 'nwPresetSegHTML', 'nwHistoryCard', 'allocationCard', 'doRenameOwner', 'addOwner',
  'goalOwnerEff', 'nearestGoal', 'goalRowHTML', 'goalsSummaryCard', 'openGoalsList', 'syncGoalInputs', 'goalClearDate', 'goalOwnerSel', 'renderGoalForm', 'openGoalForm', 'saveGoal', 'delGoal',
  'openInquiry', 'sendInquiry', 'openInquiryList', 'delInquiry',
  'pageHead', 'assetSubline', 'assetBodyHTML', 'renderAssets', 'assetSelPartial', 'assetToggleSel', 'visibleAssetsForSel', 'assetSelAll', 'activeSel',
  'modeSeg', 'monthNav', 'abbr', 'calCellsFor', 'ledSumInner', 'ledSumBox', 'ledSumTap', 'calPane', 'txRowCore', 'txRow', 'dayTxns',
  'ledgerRowsHtml', 'ledgerDayHeadHtml', 'renderLedger', 'selDayPartial',
  'ledgerSelPartial', 'ledgerToggleSel', 'ledgerSelAll', 'visibleTx',
  'fmtDot', 'splitHist', 'histRow', 'histTotHTML', 'updateHist', 'renderHistory',
  'lowestInMonth', 'planBalInner', 'planBalCard', 'planTrackHTML', 'planRowsHTML', 'renderPlan',
  'refreshPlanBody', 'planAsset', 'nextGroupOrder', 'movedGroupOrder', 'moveGroup', 'movedAssetOrder', 'moveAsset', 'monthSwipeCommitDir', 'overlayEscapeTarget', 'recFreq',
  'planSplitTransfer', 'planTransfer',
  'sbErrMsg',
  // 아래 10개는 app-evolve cycle152 advance가 FUNCTIONS 커버리지 공백(critique가 지적한 48개
  // 미검증 render*/open*/do* 함수)에서 끌어온 것 — openSheet/openTxSheet/openRecSheet/renderMenu/
  // renderAssetSheet처럼 DOM 전역(classList, requestAnimationFrame 등)에 깊이 엮인 화면 진입점은
  // 범위가 한 사이클을 넘어서므로 제외했고(여전히 openSheet()은 스텁), 그보다 의존이 적어 기존
  // 공유 sandbox 스텁(confirmSheet/openSheet/closeSheet 등)만으로 실제 실행 검증이 가능한 함수부터
  // 가져왔다. 나머지 미검증 함수(openTxSheet/openRecSheet/renderMenu/renderAssetSheet/openSheet 등)는
  // 다음 cycle이 이어받을 백로그로 남긴다.
  'sbCfg', 'emptyDB', 'accountKind',
  'openSetPinSheet', 'openChangePinSheet', 'openDisableAppLockSheet',
  'doForgotPassword', 'doForgotPasswordLocal', 'doLogout', 'doResetAll',
  // renderAssetSheet는 cycle153 advance에서 끌어왔다 — 실제로 살펴보니 setTimeout(포커스)과
  // openSheet() 호출 외에는 classList/requestAnimationFrame 같은 DOM 전역을 직접 건드리지
  // 않고(기존 openSheet/setTimeout 스텁만으로 충분), 몸통 전체가 문자열 템플릿 조립이라
  // "DOM 전역에 깊이 엮여 범위가 크다"던 위 cycle152의 가정이 이 함수엔 맞지 않았다.
  // openTxSheet/openRecSheet/renderMenu/openSheet 자체는 여전히 더 깊이 엮여 있어 백로그로 남김.
  'renderAssetSheet',
  // kakaoSyncLabel/openKakaoSwitchSheet는 cycle154 critique(카카오 로그인이 기기 간 동기화를
  // 전혀 지원하지 않는데 UI에 그 사실이 전혀 드러나지 않던 공백)의 advance 구현 — 둘 다 shallow해서
  // (순수 문자열 반환, openSheet() 호출뿐) 기존 공유 스텁만으로 실행 검증 가능.
  'kakaoSyncLabel', 'openKakaoSwitchSheet',
];
// ASSET_TYPES는 DEFAULT_GROUP_ORDER(=Object.keys(ASSET_TYPES))가 참조하므로 먼저 와야 함 —
// CONSTS는 순서대로 실행되는 평범한 대입문으로 변환되기 때문(위 extractConst 주석 참고).
// _balCache/BAL_CACHE_MAX는 balancesUpTo()가 참조하는 모듈 스코프 캐시 상태라 같은 방식으로 끌어온다.
// _recCache/REC_CACHE_MAX는 expandRec()가 참조하는 모듈 스코프 캐시 상태라 같은 방식으로 끌어온다.
// _lastEditCache는 lastActualAmount()가 참조하는 모듈 스코프 캐시 상태라 같은 방식으로 끌어온다
// (app-evolve cycle75 advance: 매번 r.edits 전체를 스캔하지 않도록 추가).
// isPlanAcct는 planNegatives()가 DB.assets.filter(isPlanAcct)로 부르는 "플랜 대상 통장"
// 판정 상수라 같은 방식(extractConst)으로 끌어온다.
// _savedDrafts는 saveTx/saveRec의 더블탭 중복 저장 가드(app-evolve cycle79 advance)가 쓰는
// WeakSet — 저장 완료된 draft 객체를 표시해 같은 draft로 재호출되면 조용히 무시한다.
// SUPABASE_URL/SUPABASE_ANON_KEY는 sbCfg()가 localStorage에 저장된 값이 없을 때 돌아가는
// 기본값이다(app-evolve cycle152 advance, doForgotPassword/doForgotPasswordLocal 분기 테스트용).
const CONSTS = ['catKey', 'comma', 'commaQty', 'ASSET_TYPES', 'DEFAULT_GROUP_ORDER', 'TYPE_COLOR', 'CURRENCY_LIST', 'EXP_CATS_DEFAULT', 'ADJUST_CAT', 'INC_CATS_DEFAULT', 'SAV_CATS_DEFAULT', 'RANGE_FROM', 'BUDGET_EPOCH', 'isFuture', 'BAL_CACHE_MAX', '_balCache', 'REC_CACHE_MAX', '_recCache', '_lastEditCache', 'GOLD_G_PER_DON', 'isCashLike', 'isMarketValued', 'TYPEBYLABEL', 'SANITIZE_QTY_FIELDS', 'SANITIZE_FREE_FIELDS', 'isPlanAcct', 'CAT_LABEL', 'CATICON', 'won', 'PAGE_TITLE', 'wonS', '_savedDrafts', 'APPLOCK_FAIL_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'FPIN_WAIT_SEC'];
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
// _planLive는 planBalCard(live=true)가 재대입하는 "롱프레스 대상 플랜 카드" 상태라 같은 이유로
// LETS를 통해 가져온다. 소스에서 `let _planLive=null,_planT=null,_planPeek=false;` 한 줄로
// 선언돼 있어 "_planLive"만 추출해도 셋 다 딸려온다(_fixWhen/_fixCtx와 같은 패턴).
// _sujiTimer는 ledSumTap()이 참조하는 "방금 롱프레스로 오늘까지 미리보기를 했는가" 플래그
// (_sujiPeeked)를 함께 끌어오기 위한 것 — 소스에서 `let _sujiTimer=null,_sujiPeeking=false,
// _sujiPeeked=false;` 한 줄로 선언돼 있어 "_sujiTimer"만 추출해도 셋 다 딸려온다
// (_fixWhen/_fixCtx와 같은 패턴, app-evolve cycle116 develop).
const LETS = ['_histCache', '_copyIsCsv', '_fixWhen', '_lastNwOwner', '_lastLedYM', '_planLive', '_sujiTimer'];

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
  CLOUD_LAST_SYNCED_AT: null,
  // PUSH_CLOUD_INFLIGHT(app-evolve cycle116)도 같은 이유로 pushCloud() 테스트에서 직접 세팅한다
  // (scheduleCloudPush()의 디바운스와 visibilitychange 핸들러가 겹쳐도 SB.from()을 중복 호출하지
  // 않도록 막는 가드 플래그).
  PUSH_CLOUD_INFLIGHT: false,
  // sbReady()는 localStorage(sbCfg)와 window.supabase의 존재 여부를 따지는 비순수 함수라
  // (SESSION/AUTH와 같은 이유) 재현하지 않고, pullCloud()/afterCloudAuth() 테스트에서
  // "클라우드 연결됨"을 뜻하는 true 고정 스텁으로 대체한다.
  sbReady: () => true,
  cloudSyncOk: () => {},
  cloudSyncFailed: () => {},
  // markCloudSynced()는 dataKey()+'__syncedAt'을 실제 시간으로 찍는 부수효과뿐이라(내용 자체는
  // 검증할 게 없음), pullCloud()/afterCloudAuth()/resolveCloudPullRemote() 테스트에서는 "이
  // 사이클에 로컬이 remote와 같아졌다고 표시했는가"만 스파이로 기록한다(app-evolve cycle77 develop:
  // pullCloud()가 remote 채택 여부와 무관하게 이걸 직접 불러 conflict로 되돌아간 뒤에도
  // '__syncedAt'이 갱신되던 버그의 회귀 테스트).
  markCloudSyncedCalls: 0,
  markCloudSynced: () => { sandbox.markCloudSyncedCalls++; },
  // pullCloud()가 부르는 SB.from('user_data').select(...).eq(...).maybeSingle() 체인만 흉내내는
  // 최소 목업 — sandbox._sbMaybeSingleResult에 원하는 {data,error}를 세팅해 응답을 흉내낸다.
  _sbMaybeSingleResult: { data: null, error: null },
  // pushCloud()의 조건부 UPDATE 체인(.update().eq().eq().select())과 fallback UPSERT
  // 체인(.upsert())을 흉내내는 목업 — sandbox._sbUpdateResult/_sbUpsertResult에 원하는
  // {data,error}를 세팅해 응답을 흉내낸다. conflict 시 재시도가 부르는 재조회는 select().eq().
  // maybeSingle() 체인을 그대로 재사용하므로(_sbMaybeSingleResult), 별도 목업이 필요 없다.
  // pushCloud()가 conflict→재시도로 같은 호출을 두 번 하는 테스트에서는 매번 다른 응답이
  // 필요하므로, 배열로 세팅해두면(_sbUpdateResults) 호출마다 하나씩 소비하고, 없으면
  // 단일값(_sbUpdateResult)을 계속 재사용한다.
  _sbUpdateResult: { data: [{ updated_at: 'unused' }], error: null },
  _sbUpdateResults: null,
  _sbUpsertResult: { error: null },
  SB: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => sandbox._sbMaybeSingleResult }) }),
      update: () => ({ eq: () => ({ eq: () => ({ select: async () => (Array.isArray(sandbox._sbUpdateResults) && sandbox._sbUpdateResults.length ? sandbox._sbUpdateResults.shift() : sandbox._sbUpdateResult) }) }) }),
      upsert: async () => sandbox._sbUpsertResult,
    }),
  },
  STORAGE_PERSISTED: null,
  // DB_JSON_LEN은 save()/load()가 실제 직렬화 길이로 채우는 파생 상태고, STORAGE_SIZE_*_LEN은
  // 그 문턱 상수다 — homeAlerts()가 shouldWarnStorageSize()에 넘기므로 STORAGE_PERSISTED와
  // 같은 이유로 테스트에서 직접 세팅한다(기본값은 문턱 아래라 평소엔 경고가 안 뜸).
  DB_JSON_LEN: 0,
  STORAGE_SIZE_WARN_LEN: 3000000,
  STORAGE_SIZE_CRIT_LEN: 4500000,
  // CLOCK_SKEW_MS는 measureCloudClockSkew()(index.html)가 Supabase REST 응답의 Date 헤더로 채우는
  // 파생 상태(기본값 null=측정 전/실패)라 CLOUD_UID/STORAGE_PERSISTED와 같은 이유로 테스트에서
  // 직접 세팅한다. CLOCK_SKEW_WARN_MS/CRIT_MS는 그 문턱 상수(app-evolve cycle165 advance).
  CLOCK_SKEW_MS: null,
  CLOCK_SKEW_WARN_MS: 5 * 60 * 1000,
  CLOCK_SKEW_CRIT_MS: 24 * 60 * 60 * 1000,
  // CLOUD_PULL_STALE_MS는 pullCloudIfStale()이 shouldPullCloud()에 넘기는 문턱 상수(app-evolve
  // cycle167 advance) — 위 CLOCK_SKEW_WARN_MS/CRIT_MS와 같은 이유로 테스트에서 직접 세팅한다.
  CLOUD_PULL_STALE_MS: 3 * 60 * 1000,
  // SESSION은 `let SESSION=localStorage.getItem(...)`으로 파생되는 로그인 이메일/카카오 id고,
  // AUTH는 localStorage 기반 계정 저장소 객체라(accountName()이 AUTH.rec(SESSION)을 부름) 둘 다
  // RANGE_TO/CLOUD_UID와 같은 이유(파생·비순수 상태, localStorage 의존)로 재현하지 않고
  // accountName() 테스트에서 직접 세팅한다.
  SESSION: null,
  // doLogout()이 호출하는 AUTH.signOut() — 실제 로그아웃(세션 삭제)은 화면 전용 부수효과라
  // closeSheet/toast와 같은 이유로 호출 여부만 기록하는 스파이로 흉내낸다(app-evolve cycle152 advance).
  authSignOutCalls: 0,
  AUTH: { rec: () => null, signOut: () => { sandbox.authSignOutCalls++; } },
  // GUEST는 index.html에서 `let GUEST=localStorage.getItem('asset_app_guest')==='1'`로 파생되는
  // 비순수 상태라(SESSION/CLOUD_UID와 같은 이유) doLogout/doResetAll 테스트에서 직접 세팅한다.
  GUEST: null,
  catRenameDraft: null,
  catAddDraft: null,
  asDraft: null,
  goalDraft: null,
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
  // sumTap()은 go()/histInvalidate() 등 화면 전환 체인을 끌고 오므로(이 테스트의 대상이 아님),
  // ledSumTap()의 "롱프레스 직후 릴리즈는 삼킨다" 가드 로직만 검증하는 테스트를 위해 스파이로
  // 대체 가능한 no-op 스텁을 기본값으로 둔다(app-evolve cycle116 develop).
  sumTap: () => {},
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
  // assetBody는 renderAssets()가 그린 page-assets 안의 자식 노드를 흉내낸다.
  // assetSelPartial()이 renderAssets() 전체 대신 이 노드만 갱신하는지 확인하는 테스트용
  // (assetBodyMissing=true면 $('assetBody')가 null을 반환해 fallback 경로를 재현한다).
  assetBodyMissing: false,
  assetBodyEl: {
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
  // ledgerCard는 renderLedger()가 그린 page-ledger 안의 자식 노드를 흉내낸다.
  // ledgerSelPartial()이 renderLedger() 전체 대신 이 노드만 갱신하는지 확인하는 테스트용
  // (ledgerCardMissing=true면 $('ledgerCard')가 null을 반환해 fallback 경로를 재현한다).
  ledgerCardMissing: false,
  ledgerCardEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  },
  // page-plan도 같은 이유(renderPlan()이 $('page-plan').innerHTML=...로 직접 꽂음)로
  // 같은 getter/setter 패턴을 재사용한다. querySelector는 refreshPlanBody()가 부분 갱신
  // 대상을 못 찾는 폴백 경로(renderPlan() 전 최초 상태)를 재현하도록 항상 null을 반환한다 —
  // 실제 자식 구조가 필요한 성공 경로 테스트는 makePlanDom()으로 $ 자체를 바꿔서 검증한다.
  pagePlanEl: {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelector: () => null,
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
  // fpinPwIn/fpinErr/fpinBtn/fpinWaitMsg는 doForgotPin()의 email 분기(계정 비밀번호 검증)와
  // guest/kakao 분기(강제 대기 카운트다운)를 실제 실행으로 검증하기 위한 흉내다(app-evolve
  // cycle155 advance). fpinErrEl/fpinBtnEl/fpinWaitMsgEl은 함수가 직접 style/textContent/disabled를
  // 대입하므로 bkTextEl처럼 호출 간에도 값이 남는 공유 객체로 선언한다.
  fpinErrEl: { style: { display: 'none' }, textContent: '' },
  fpinBtnEl: { disabled: false },
  fpinWaitMsgEl: { style: { display: 'none' }, textContent: '' },
  $: (id) => id === 'txAmt' ? { value: sandbox.txAmtValue } : id === 'qAmt' ? { value: sandbox.qAmtValue } : id === 'budgetIn' ? { value: sandbox.budgetInValue } : id === 'goalName' ? (sandbox.goalNameValue === undefined ? null : { value: sandbox.goalNameValue }) : id === 'goalAmt' ? (sandbox.goalAmtValue === undefined ? null : { value: sandbox.goalAmtValue }) : id === 'inqText' ? (sandbox.inqTextValue === undefined ? null : { value: sandbox.inqTextValue }) : id === 'asName' ? (sandbox.asNameValue === undefined ? null : { value: sandbox.asNameValue }) : id === 'errBanner' ? sandbox.errBannerEl : id === 'bkText' ? sandbox.bkTextEl : id === 'planBadge' ? sandbox.planBadgeEl : id === 'page-home' ? sandbox.pageHomeEl : id === 'page-assets' ? sandbox.pageAssetsEl : id === 'page-ledger' ? sandbox.pageLedgerEl : id === 'page-plan' ? sandbox.pagePlanEl : id === 'page-history' ? sandbox.pageHistoryEl : id === 'histTotals' ? sandbox.histTotalsEl : id === 'histList' ? sandbox.histListEl : id === 'ledgerCard' ? (sandbox.ledgerCardMissing ? null : sandbox.ledgerCardEl) : id === 'assetBody' ? (sandbox.assetBodyMissing ? null : sandbox.assetBodyEl) : id === 'newOwner' ? (sandbox.newOwnerValue === undefined ? null : { value: sandbox.newOwnerValue }) : id === 'renameOwner' ? (sandbox.renameOwnerValue === undefined ? null : { value: sandbox.renameOwnerValue }) : id === 'auEmail' ? (sandbox.auEmailValue === undefined ? null : { value: sandbox.auEmailValue }) : id === 'fpinPwIn' ? (sandbox.fpinPwInValue === undefined ? null : { value: sandbox.fpinPwInValue }) : id === 'fpinErr' ? sandbox.fpinErrEl : id === 'fpinBtn' ? sandbox.fpinBtnEl : id === 'fpinWaitMsg' ? sandbox.fpinWaitMsgEl : null,
  bkTextEl: { value: 'backup-text', select: () => {}, setSelectionRange: () => {} },
  // copyBackup()의 navigator.clipboard 체크가 ReferenceError 없이 "지원 안 함"으로 지나가게
  // 하는 최소 흉내(document.execCommand는 try/catch로 감싸져 있어 굳이 스텁이 필요 없음).
  navigator: {},
  toast: (msg) => { sandbox.lastToast = msg; sandbox.toastCalls.push(msg); },
  toastCalls: [],
  // Notification은 브라우저 전용 전역이라(SESSION/CLOUD_UID와 같은 이유) syncNotifyPermission()/
  // toggleOsNotify() 테스트에서 {permission:'granted'|'denied'|'default'}로 직접 세팅한다.
  // undefined로 두면 실제 코드의 typeof Notification==='undefined' 분기(미지원 브라우저)를 재현한다.
  Notification: undefined,
  // doForgotPin()(app-evolve cycle151 develop)이 부르는 APPLOCK.disable()/unlockApp() —
  // 둘 다 화면 전용 부수효과(실제 APPLOCK 객체/화면 전환)라 closeSheet/toast와 같은 이유로
  // 호출 여부만 기록하는 스파이로 흉내낸다.
  appLockDisableCalls: 0,
  APPLOCK: { disable: () => { sandbox.appLockDisableCalls++; } },
  unlockAppCalls: 0,
  unlockApp: () => { sandbox.unlockAppCalls++; },
  // renderLockView()가 잠김(backoff) 상태에서 재시도 타이머를 재설정할 때 부르는
  // clearTimeout — setTimeout처럼 화면 전용이라 no-op으로 흉내낸다.
  clearTimeout: () => {},
  save: () => {},
  invalidateBalances: () => {},
  renderCurrent: () => {},
  openCatManage: () => {},
  openOwnerManage: () => {},
  openRecManage: () => {},
  // asOpenType()이 여는 자산 종류 피커 — 실제 DOM/블롭 렌더는 화면 전용이라 openPicker처럼
  // no-op으로 흉내내고, onPick 콜백만 캡처해 테스트가 직접 호출할 수 있게 한다.
  lastTypePickerOnPick: null,
  openTypePicker: (o) => { sandbox.lastTypePickerOnPick = o.onPick; },
  // asOpenCur()이 여는 통화 피커 — openTypePicker와 같은 이유(화면 전용)로 no-op으로
  // 흉내내고, 넘겨받은 current/onPick만 캡처해 테스트가 검증·직접 호출할 수 있게 한다.
  lastCurrencyPickerCurrent: null,
  lastCurrencyPickerOnPick: null,
  openCurrencyPicker: (o) => { sandbox.lastCurrencyPickerCurrent = o.current; sandbox.lastCurrencyPickerOnPick = o.onPick; },
  // renderAssets()가 부수효과로 부르는 실 DOM/드래그/스크롤/애니메이션 와이어링 여섯 개 —
  // fitAll처럼 화면 전용이라 순수 로직 테스트 대상이 아니므로 전부 no-op으로 흉내낸다
  // (renderAssets 자체와 그 안의 문자열 빌더 헬퍼들만 실제 소스로 검증하면 충분).
  wireGroupDrag: () => {},
  wireLongPress: () => {},
  wireNwCarousel: () => {},
  restoreNwScroll: () => {},
  animNums: () => {},
  updateSelBottomCalls: 0,
  updateSelBottom: () => { sandbox.updateSelBottomCalls++; },
  // renderLedger()가 부수효과로 부르는 달력 캐러셀 스와이프 와이어링 — 같은 이유(화면 전용)로
  // no-op으로 흉내낸다.
  wireMonthCarousel: () => {},
  openSpendAnalysis: () => {},
  // bulkCatPickFor()의 onPick이 되돌아갈 이전 시트가 없는 피커를 직접 닫는 호출 — goCalls와
  // 같은 이유(화면 전용)로 호출 여부만 기록하는 스파이로 흉내낸다.
  closeSheetCalls: 0,
  closeSheet: () => { sandbox.closeSheetCalls++; },
  // openAssetHistory/openCatHistory가 필터 세팅 후 부르는 탭 전환 — closeSheet와 같은 이유(화면
  // 전용, 이 함수들의 테스트 대상은 ST.hist/ST.ledger 필터 세팅뿐)로 호출 여부만 기록하는 스파이로
  // 흉내낸다.
  goCalls: [],
  go: (tab) => { sandbox.goCalls.push(tab); },
  // doLogout()이 로그아웃 후 부르는 로그인 화면 전환 — closeSheet/go와 같은 이유(화면 전용)로
  // 호출 여부만 기록하는 스파이로 흉내낸다(app-evolve cycle152 advance).
  showAuthCalls: 0,
  showAuth: () => { sandbox.showAuthCalls++; },
  // doResetAll()이 초기화 직후(비동기 디바운스로) 부르는 클라우드 재푸시 예약 — setTimeout이
  // 이미 no-op 스텁이라 실제로 실행되지는 않지만, `setTimeout(scheduleCloudPush,6000)`처럼
  // 식별자로 참조만 해도 선언돼 있어야 ReferenceError가 안 난다(app-evolve cycle152 advance).
  scheduleCloudPush: () => {},
  renderTxSheet: () => {},
  // renderAssetSheet는 cycle153 advance부터 FUNCTIONS(실제 실행)로 승격돼 위 no-op 스텁을
  // 더 이상 쓰지 않는다 — vm이 실제 함수로 이 프로퍼티를 덮어쓴다(doLogout/doResetAll 등
  // cycle152 승격분과 같은 패턴).
  uid: () => 'test-uid',
  // touch()는 Date.now()를 쓰는데, saveTx/saveAsset/saveRec 테스트에서 매번 값이 달라지면
  // 그 필드를 assert하기 번거로우므로(assert하지 않는 테스트도 실행 시각마다 스냅샷이 흔들림)
  // uid와 같은 이유로 고정값 스텁을 쓴다. touch() 자체의 동작(필드 세팅)은 별도 단위 테스트로 검증.
  touch: (obj) => { obj.updatedAt = 'test-updatedAt'; return obj; },
  // saveTx()는 txDraft(전역 폼 상태)를 다루는데, syncTxInputs()는 DOM 입력칸을 읽어 그
  // txDraft에 반영하는 순수 로직이 아닌 함수라 여기선 no-op으로 흉내낸다 — saveTx 테스트는
  // txDraft를 직접 세팅해서 검증하므로 DOM 동기화 자체는 대상이 아니다.
  txDraft: null,
  syncTxInputs: () => {},
  undoToast: (msg, undoFn) => { sandbox.lastUndo = { msg, undoFn }; },
  // planSplitTransfer/planTransfer가 성공 안내로 부르는 축하 애니메이션 — 화면 효과일 뿐이라
  // toast처럼 마지막 메시지만 기록하는 no-op 스텁으로 대체한다(app-evolve cycle88 advance).
  celebrate: (msg) => { sandbox.lastCelebrate = msg; },
  // applyForeignSave()가 다른 탭이 남긴 최신 데이터를 읽어오는 localStorage.getItem(dataKey())
  // 경로 — 실제 dataKey()는 SESSION/AUTH/emailKey에 파생되는 비순수 값이라(위 SESSION 주석과
  // 같은 이유) 재현하지 않고 고정 키 스텁으로 대체한다. sandbox._lsRaw에 원하는 문자열을
  // 세팅해 getItem이 그 값을 돌려주게 한다(기본은 아무 것도 없는 것처럼 null).
  dataKey: () => 'test-key',
  _lsRaw: null,
  // _lsMap은 afterCloudAuth() 테스트처럼 dataKey()+'__savedAt'/'__syncedAt'같이 서로 다른 키를
  // 구분해서 읽어야 하는 경우에만 쓴다(null이면 기존처럼 키와 무관하게 _lsRaw를 돌려줌 — applyForeignSave
  // 테스트 등 단일 키만 쓰던 기존 테스트와 호환). setItem은 실제로 쓰지 않고 호출만 기록한다.
  _lsMap: null,
  _lsSetCalls: [],
  localStorage: {
    getItem: (k) => (sandbox._lsMap && Object.prototype.hasOwnProperty.call(sandbox._lsMap, k)) ? sandbox._lsMap[k] : sandbox._lsRaw,
    setItem: (k, v) => { sandbox._lsSetCalls.push([k, v]); },
  },
  TAB_SAVED_AT: 0,
  TAB_SYNC_PENDING: null,
  snapshotAssetName: (id) => { sandbox.snapshotCalls.push(id); },
  // toggleConfirmTransfers()가 끄기 전 확인을 받는 confirmSheet() 스텁 — 실제 시트를 띄우는
  // 대신 호출 인자를 기록하고 콜백만 저장해서, 테스트가 "확인" 버튼을 누른 것처럼 cb를 직접 실행할 수 있게 한다.
  confirmSheet: (title, msg, ok, cb) => { sandbox.confirmSheetCalls.push({ title, msg, ok, cb }); },
  confirmSheetCalls: [],
  // openAssetPicker()가 실제로 그리는 시트 DOM 대신, 넘겨받은 bodyHtml을 그대로 기록만 하는
  // openPicker() 스텁 — excludeMarketValued 필터가 최종 목록 문자열에 반영됐는지 검증하는 데 쓴다.
  lastPickerHtml: null,
  openPicker: (title, bodyHtml) => { sandbox.lastPickerHtml = bodyHtml; },
  // saveRec()가 편집 대상 필드를 읽는 recDraft(전역 폼 상태) — syncRecInputs()는 DOM 입력칸을
  // recDraft에 반영하는 순수 로직이 아닌 함수라 no-op으로 흉내낸다(saveTx/syncTxInputs와 같은 이유).
  recDraft: null,
  syncRecInputs: () => {},
  // recFreq()가 끝에 부르는 시트 재렌더 — renderAssetSheet/renderTxSheet와 같은 이유로
  // no-op으로 흉내낸다(recFreq 테스트는 recDraft 필드 변화만 검증).
  renderRecSheet: () => {},
  // recSaveScopeConfirm()이 띄우는 확인 시트 — 실제 DOM 대신 마지막으로 그려진 html만 기록한다.
  lastSheetHtml: null,
  openSheet: (html) => { sandbox.lastSheetHtml = html; },
  // saveAsset()의 새 자산 등록 경로가 부르는 "삭제된 동명 자산 재연동" 시트 — deletedAssetHistoryExists
  // 자체는 이제 FUNCTIONS의 실제 소스로 검증하므로(아래 테스트 참고), 여기선 실제 시트(DOM) 대신
  // 호출 여부와 넘겨받은 draft만 기록하는 스텁으로 흉내낸다.
  lastAskRelinkDeletedArg: null,
  askRelinkDeleted: (d) => { sandbox.lastAskRelinkDeletedArg = d; },
  clampRecurringToMaturity: () => {},
  // saveAsset()이 저장 직후 '가격 미확인'인 fx/gold/stock 자산에 대해 TTL을 기다리지 않고
  // 부르는 즉시 시세 동기화 — 실제 네트워크 호출 대신 호출 여부만 기록한다.
  syncRatesCalls: [],
  syncRates: (silent) => { sandbox.syncRatesCalls.push(silent); },
  // genSalt/pbkdf2Hash(비밀번호 해싱)는 브라우저와 동일한 Web Crypto API 모양을 쓰므로,
  // Node 19+의 전역 webcrypto를 그대로 넘기면 index.html과 같은 소스가 그대로 돌아간다.
  crypto,
  TextEncoder,
  // fetchWithTimeout(app-evolve cycle115)이 쓰는 AbortController는 Node 전역 구현 그대로 넘긴다
  // (브라우저와 동일한 모양). fetch는 기본값을 두지 않고(호출되면 바로 ReferenceError 대신
  // "sandbox.fetch is not a function" 형태로 실패하게) 각 테스트가 필요한 모양으로 직접 채운다.
  AbortController,
  clearTimeout: () => {},
};
vm.createContext(sandbox);
// index.html이 <script src="logic.js">로 로드하는 순서를 그대로 따라 logic.js를 먼저 실행한다
// (함수 선언끼리는 순서가 무관하지만, 실제 로드 순서와 맞춰 둔다).
vm.runInContext(logicSrc, sandbox, { filename: 'logic.js' });
vm.runInContext(extracted, sandbox, { filename: 'extracted-from-index.html' });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- touch()-before-save() 동기화 불변식 구조적 가드 (app-evolve cycle132 advance) ----------
 * mergeCollection()(logic.js)은 DB.assets/txns/recurrences/goals의 교차기기 충돌을 updatedAt
 * 비교만으로 해소한다. 레코드를 바꾸면서 touch()를 빠뜨리면 동기화 시 그 변경이 조용히 되돌아가는데,
 * 이 버그 클래스가 cycle128/129에서 독립적으로 두 번 재발견돼 전체 재감사(수 시간)로만 잡혔다.
 * 매번 비싼 재감사를 반복하는 대신, index.html 본문을 정적으로 스캔해 "DB.(assets|txns|recurrences|
 * goals).find(...)로 바인딩한 변수가 필드 대입을 받은 뒤 touch(그변수)/touchSave(그변수) 없이
 * save()나 touchSave(...)가 호출되는" 패턴을 토큰 매칭으로 찾아낸다. 완벽한 정적 분석이 아니라
 * 텍스트 기반 휴리스틱이라(실제 제어흐름을 실행하지 않음) 놓치는 경우는 있을 수 있지만, 지금까지
 * 고쳐진 패턴들을 회귀로 다시 깨뜨리면 확실히 잡아낸다. */
function findTouchBeforeSaveViolations() {
  // 주석(/* ... */) 안에 "touchSave()"/"save()"라는 말이 그대로 등장하면(이 테스트 코드 자신의
  // 설명 주석 포함) 실제 호출로 오인되므로, 길이를 보존한 공백으로 먼저 지워 라인 번호/오프셋에는
  // 영향을 주지 않으면서 텍스트 매칭에서만 제외한다.
  const body = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const fnStartRe = /^(?:async function|function) (\w+)\(/gm;
  const fns = [];
  let fm;
  while ((fm = fnStartRe.exec(body))) {
    const start = fm.index;
    const braceStart = body.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    fns.push({ name: fm[1], text: body.slice(start, i) });
  }
  const BIND_RE = /(?:const|let|var)\s+(\w+)\s*=\s*DB\.(?:assets|txns|recurrences|goals)\.find\(/g;
  const violations = [];
  for (const fn of fns) {
    const text = fn.text;
    BIND_RE.lastIndex = 0;
    let bm;
    while ((bm = BIND_RE.exec(text))) {
      const V = bm[1];
      const bindPos = bm.index + bm[0].length;
      const mutRe = new RegExp('\\b' + V + '\\.(\\w+)\\s*=(?!=)', 'g');
      mutRe.lastIndex = bindPos;
      let mm;
      while ((mm = mutRe.exec(text))) {
        const mutPos = mm.index + mm[0].length;
        const commitRe = /\b(touchSave|save)\(/g;
        commitRe.lastIndex = mutPos;
        const cm = commitRe.exec(text);
        if (!cm) continue; // 이 함수에서 해당 대입 뒤로 save()/touchSave()가 전혀 안 불리면 위험 없음
        if (cm[1] === 'touchSave') {
          const argsStart = cm.index + cm[0].length;
          let depth = 1, j = argsStart;
          for (; j < text.length; j++) {
            if (text[j] === '(') depth++;
            else if (text[j] === ')') { depth--; if (depth === 0) break; }
          }
          const argsText = text.slice(argsStart, j);
          if (!new RegExp('\\b' + V + '\\b').test(argsText)) {
            violations.push(`${fn.name}(): ${V}.${mm[1]} 대입 후 touchSave(${argsText})에 ${V}가 없음`);
          }
        } else {
          const between = text.slice(mutPos, cm.index);
          if (!new RegExp('\\btouch\\(\\s*' + V + '\\s*[,)]').test(between)) {
            violations.push(`${fn.name}(): ${V}.${mm[1]} 대입 후 save() 전에 touch(${V})가 없음`);
          }
        }
      }
    }
  }
  return violations;
}
test('touch()-before-save() 동기화 불변식: DB.assets/txns/recurrences/goals를 find()로 찾아 필드를 바꾸는 모든 함수가 save() 전에 touch()(또는 touchSave())를 호출한다', () => {
  const violations = findTouchBeforeSaveViolations();
  assert.deepStrictEqual(violations, [], `touch()-before-save() 위반 발견:\n${violations.join('\n')}`);
});

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

/* ---------- addMonthsStr(logic.js): addMonths와 이름은 비슷하지만 day를 clamp하지 않는 별도 함수 ----------
 * addMonths()는 day를 그 달의 마지막 날로 clamp하지만, addMonthsStr()은 recNthDate/recCountUntil이
 * recDates()에 넘길 상한(to)을 구하기 위한 용도라 clamp 없이 new Date().setMonth() 롤오버를 그대로
 * 반환한다(예: 1/31+1개월 → 2/28이 아니라 3/3). 상한을 계산할 뿐이라 롤오버가 날짜를 앞이 아니라
 * 항상 뒤로만 미루므로 현재는 버그가 아니지만(app-evolve cycle153 develop 조사), 지금까지 recNthDate/
 * recCountUntil 테스트는 day 29/30/31 시작을 다루지 않아 이 롤오버 경로가 테스트로 한 번도 실행된
 * 적이 없었다. addMonths와 섞어 쓰지 않도록 현재 동작을 여기 명시적으로 고정해 둔다. */
test('addMonthsStr: 짧은 달로 넘어가는 말일 기준 날짜는 clamp 없이 다음 달로 롤오버된다(addMonths와 다름)', () => {
  assert.strictEqual(sandbox.addMonthsStr('2026-01-31', 1), '2026-03-03');
});
test('addMonthsStr: 연 경계를 넘는 이동도 월만 정확히 이동한다', () => {
  assert.strictEqual(sandbox.addMonthsStr('2026-12-15', 1), '2027-01-15');
});
test('addMonthsStr: 윤년 2/29 시작에서 평년으로 넘어가는 이동은 2/29로 clamp되지 않고 3/1로 롤오버된다', () => {
  assert.strictEqual(sandbox.addMonthsStr('2024-02-29', 12), '2025-03-01');
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

/* ---------- inQuietWindow: KRX/원화 장 마감(토 06:00~월 08:00)은 KST 기준 고정이어야
 * 하는데, 예전 구현은 d.getDay()/d.getHours()로 기기(Node 프로세스) 로컬 시간대를
 * 읽어 판정했다(app-evolve cycle156 develop). 아래 각 instant는 "KST 벽시계 기준"으로
 * 고른 절대 시각(UTC epoch)이라, 기본 TZ와 America/New_York(UTC-4) 양쪽에서 같은
 * 결과가 나와야 KST에 고정된 것이 맞다 — 고치기 전 코드로는 두 TZ의 결과가 갈렸다. */
test('inQuietWindow: 토요일 06:00 KST부터 휴장 시작(그 직전 05:59는 아직 거래시간)', () => {
  const start = new Date('2026-10-02T21:00:00.000Z'); // = 토 2026-10-03 06:00 KST
  const before = new Date('2026-10-02T20:59:00.000Z'); // = 토 2026-10-03 05:59 KST
  assert.strictEqual(sandbox.inQuietWindow(start), true);
  assert.strictEqual(sandbox.inQuietWindow(before), false);
  withTZ('America/New_York', () => {
    assert.strictEqual(sandbox.inQuietWindow(start), true);
    assert.strictEqual(sandbox.inQuietWindow(before), false);
  });
});
test('inQuietWindow: 일요일은 시간과 무관하게 항상 휴장이다', () => {
  const sunday = new Date('2026-10-04T06:00:00.000Z'); // = 일 2026-10-04 15:00 KST
  assert.strictEqual(sandbox.inQuietWindow(sunday), true);
  withTZ('America/New_York', () => {
    assert.strictEqual(sandbox.inQuietWindow(sunday), true);
  });
});
test('inQuietWindow: 월요일 08:00 KST에 휴장이 끝난다(그 직전 07:59는 아직 휴장)', () => {
  const stillQuiet = new Date('2026-10-04T22:59:00.000Z'); // = 월 2026-10-05 07:59 KST
  const ended = new Date('2026-10-04T23:00:00.000Z'); // = 월 2026-10-05 08:00 KST
  assert.strictEqual(sandbox.inQuietWindow(stillQuiet), true);
  assert.strictEqual(sandbox.inQuietWindow(ended), false);
  withTZ('America/New_York', () => {
    assert.strictEqual(sandbox.inQuietWindow(stillQuiet), true);
    assert.strictEqual(sandbox.inQuietWindow(ended), false);
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

/* ---------- recFreq: 매월에서 다른 주기로 바꾸면 weekend가 리셋돼야 함 (app-evolve cycle75) ----------
 * weekend 필드는 UI에서 freq==='monthly'일 때만 노출되는데(index.html:3478), recDates()의
 * shiftWeekend 적용은 freq와 무관하게 항상 일어난다(1919행). 매월+주말조정을 켠 뒤 화면에서
 * 안 보이는 채로 주기를 매주/매일/매년으로 바꾸면, 안 보이는 weekend 값이 그대로 남아
 * 계속 날짜를 조정해버린다(화면엔 원인이 전혀 안 보임) — recFreq()가 monthly를 벗어날 때
 * weekend를 'none'으로 리셋해 이 불일치를 막는다. */
test('recFreq: 매월에서 매주로 바꾸면 recDraft.weekend가 none으로 리셋된다', () => {
  sandbox.recDraft = { freq: 'monthly', weekend: 'later', startDate: '2026-01-10', day: 10 };
  sandbox.recFreq('weekly');
  assert.strictEqual(sandbox.recDraft.freq, 'weekly');
  assert.strictEqual(sandbox.recDraft.weekend, 'none');
});
test('recFreq: 매월에서 매일/매년으로 바꿔도 weekend가 none으로 리셋된다', () => {
  sandbox.recDraft = { freq: 'monthly', weekend: 'earlier', startDate: '2026-01-10', day: 10 };
  sandbox.recFreq('daily');
  assert.strictEqual(sandbox.recDraft.weekend, 'none');
  sandbox.recDraft = { freq: 'monthly', weekend: 'earlier', startDate: '2026-01-10', day: 10 };
  sandbox.recFreq('yearly');
  assert.strictEqual(sandbox.recDraft.weekend, 'none');
});
test('recFreq: 매월에서 매월로(변화 없음) 유지되면 기존 weekend 값을 건드리지 않는다', () => {
  sandbox.recDraft = { freq: 'monthly', weekend: 'later', startDate: '2026-01-10', day: 10 };
  sandbox.recFreq('monthly');
  assert.strictEqual(sandbox.recDraft.weekend, 'later', 'monthly로 유지되는 한 weekend는 사용자가 고른 값 그대로여야 함');
});
test('recFreq: 매주에서 매월로 바꾸면 weekend는 건드리지 않는다(그대로면 사용자가 다시 선택 가능)', () => {
  sandbox.recDraft = { freq: 'weekly', weekend: 'none', startDate: '2026-01-10', day: null };
  sandbox.recFreq('monthly');
  assert.strictEqual(sandbox.recDraft.weekend, 'none');
  assert.strictEqual(sandbox.recDraft.day, 10, '매월로 바뀌면서 day가 비어있었으므로 시작일 기준으로 채워져야 함');
});

/* ---------- _applyType/_applyDay/_applyCount: tx/rec 폼이 공유하는 헬퍼(app-evolve cycle108/114
 * advance에서 _applyCount/_applyType·_applyFreq·_applyDay·dayPickerHTML로 각각 통합됐지만, recFreq
 * 테스트(위)가 _applyFreq를 간접으로만 덮을 뿐 나머지는 cycle114 advance 이후 한 번도 직접
 * 테스트되지 않았다 — 지금은 tx/rec 두 폼이 동시에 의존하므로 이 헬퍼 하나의 회귀가 두 폼을
 * 한꺼번에 깨뜨린다) ---------- */
test('_applyType: type을 바꾸면 category가 catListOf(t)의 첫 항목으로 바뀐다', () => {
  sandbox.DB = { categories: { expense: ['식비', '교통비'], income: ['급여'], saving: ['저축'] }, assets: [] };
  const d = { type: 'expense', category: '식비' };
  sandbox._applyType(d, 'income');
  assert.strictEqual(d.type, 'income');
  assert.strictEqual(d.category, '급여');
});
test("_applyType: type이 'transfer'면 catListOf와 무관하게 category가 항상 '이체'로 고정된다", () => {
  sandbox.DB = { categories: { expense: ['식비'], income: [], saving: [] }, assets: [] };
  const d = { type: 'expense', category: '식비' };
  sandbox._applyType(d, 'transfer');
  assert.strictEqual(d.category, '이체');
});
test("_applyType: catListOf(t)가 빈 배열이면 category가 '기타'로 폴백한다", () => {
  sandbox.DB = { categories: { expense: ['식비'], income: [], saving: [] }, assets: [] };
  const d = { type: 'expense', category: '식비' };
  sandbox._applyType(d, 'income');
  assert.strictEqual(d.category, '기타');
});
test("_applyType: income/transfer/saving으로 바뀌고 toAssetId가 비어있으면 firstCash()로 채워진다", () => {
  sandbox.DB = { categories: { expense: ['식비'], income: ['급여'], saving: ['저축'] }, assets: [{ id: 'cash1', type: 'cash', owner: '나' }] };
  const d = { type: 'expense', category: '식비', toAssetId: null };
  sandbox._applyType(d, 'income');
  assert.strictEqual(d.toAssetId, 'cash1');
});
test('_applyType: toAssetId가 이미 있으면 income/transfer/saving으로 바뀌어도 덮어쓰지 않는다', () => {
  sandbox.DB = { categories: { expense: ['식비'], income: ['급여'], saving: ['저축'] }, assets: [{ id: 'cash1', type: 'cash', owner: '나' }] };
  const d = { type: 'expense', category: '식비', toAssetId: 'existing' };
  sandbox._applyType(d, 'saving');
  assert.strictEqual(d.toAssetId, 'existing');
});
test("_applyType: 'expense'로 바뀌면 toAssetId는 건드리지 않는다(출금 자산은 fromAssetId 몫)", () => {
  sandbox.DB = { categories: { expense: ['식비'], income: ['급여'], saving: ['저축'] }, assets: [{ id: 'cash1', type: 'cash', owner: '나' }] };
  const d = { type: 'income', category: '급여', toAssetId: null };
  sandbox._applyType(d, 'expense');
  assert.strictEqual(d.toAssetId, null);
});

test("_applyDay: v='last'면 day='last', _custom=false로 고정된다", () => {
  const d = { day: 22, _custom: true };
  sandbox._applyDay(d, '2026-03-07', 'last');
  assert.strictEqual(d.day, 'last');
  assert.strictEqual(d._custom, false);
});
test("_applyDay: v='custom'이고 기존 day가 프리셋(1/5/15/25)이면 시작일의 일자로 초기화된다", () => {
  const d = { day: 15, _custom: false };
  sandbox._applyDay(d, '2026-03-07', 'custom');
  assert.strictEqual(d._custom, true);
  assert.strictEqual(d.day, 7, "시작일(2026-03-07)의 일자 7로 초기화돼야 함");
});
test("_applyDay: v='custom'이고 기존 day가 'last'거나 비어있어도 시작일 기준으로 초기화된다", () => {
  const d1 = { day: 'last', _custom: false };
  sandbox._applyDay(d1, '2026-01-20', 'custom');
  assert.strictEqual(d1.day, 20);
  const d2 = { day: null, _custom: false };
  sandbox._applyDay(d2, '2026-01-20', 'custom');
  assert.strictEqual(d2.day, 20);
});
test("_applyDay: v='custom'인데 시작일에서 유효한 일자를 못 뽑으면(빈 문자열) 10으로 폴백한다", () => {
  const d = { day: null, _custom: false };
  sandbox._applyDay(d, '', 'custom');
  assert.strictEqual(d.day, 10);
});
test("_applyDay: v='custom'이고 기존 day가 이미 프리셋 밖의 값(예: 22)이면 그대로 유지된다(이미 커스텀 값)", () => {
  const d = { day: 22, _custom: false };
  sandbox._applyDay(d, '2026-03-07', 'custom');
  assert.strictEqual(d._custom, true);
  assert.strictEqual(d.day, 22, '이미 프리셋이 아닌 값이므로 시작일로 덮어쓰면 안 됨');
});
test("_applyDay: v가 숫자 문자열이면 day=Number(v), _custom=false로 초기화된다", () => {
  const d = { day: 22, _custom: true };
  sandbox._applyDay(d, '2026-03-07', '5');
  assert.strictEqual(d.day, 5);
  assert.strictEqual(d._custom, false);
});

test('_applyCount: 횟수가 0이거나 숫자가 아니면 count/endDate가 모두 null이 된다', () => {
  const d = { freq: 'monthly', day: 10, startDate: '2026-01-01', weekend: 'none' };
  sandbox._applyCount('tx', d, '0', () => {});
  assert.strictEqual(d.count, null);
  assert.strictEqual(d.endDate, null);
  sandbox._applyCount('tx', d, 'abc', () => {});
  assert.strictEqual(d.count, null);
  assert.strictEqual(d.endDate, null);
});
test('_applyCount: 숫자가 아닌 문자는 무시하고 숫자만 뽑아 count로 쓴다', () => {
  const d = { freq: 'monthly', day: 10, startDate: '2026-01-01', weekend: 'none' };
  sandbox._applyCount('tx', d, 'abc5xyz', () => {});
  assert.strictEqual(d.count, 5);
});
test('_applyCount: 999를 넘는 횟수는 999로 clamp된다', () => {
  const d = { freq: 'monthly', day: 10, startDate: '2026-01-01', weekend: 'none' };
  sandbox._applyCount('tx', d, '9999', () => {});
  assert.strictEqual(d.count, 999);
});
test('_applyCount: 횟수가 1 이상이면 recNthDate와 동일한 규칙으로 endDate가 계산된다', () => {
  const d = { freq: 'monthly', day: 10, startDate: '2026-01-01', weekend: 'none' };
  sandbox._applyCount('rec', d, '3', () => {});
  assert.strictEqual(d.count, 3);
  assert.strictEqual(d.endDate, sandbox.recNthDate({ freq: 'monthly', day: 10, startDate: '2026-01-01', weekend: 'none' }, 3));
  assert.strictEqual(d.endDate, '2026-03-10');
});

test('dayPickerHTML: 현재 day가 프리셋이면 해당 버튼에 on 클래스가 붙고 커스텀 입력칸은 없다', () => {
  const html = sandbox.dayPickerHTML({ day: 15, _custom: false }, 'tx');
  assert.match(html, /class="on" onclick="txDay\('15'\)"/);
  assert.doesNotMatch(html, /id="txDayIn"/);
});
test("dayPickerHTML: day가 'last'면 말일 버튼에 on 클래스가 붙는다", () => {
  const html = sandbox.dayPickerHTML({ day: 'last', _custom: false }, 'rec');
  assert.match(html, /class="on" onclick="recDay\('last'\)"/);
});
test('dayPickerHTML: day가 프리셋 밖의 숫자면(직접 입력 상태) 커스텀 입력칸이 렌더되고 현재 값이 채워진다', () => {
  const html = sandbox.dayPickerHTML({ day: 22, _custom: false }, 'tx');
  assert.match(html, /id="txDayIn"[^>]*value="22"/);
  assert.doesNotMatch(html, /class="on"/, '프리셋 버튼 중 어느 것도 22와 일치하지 않으므로 on 클래스가 없어야 함');
});
test('dayPickerHTML: 커스텀 입력칸에 aria-label이 있어 스크린리더가 용도를 알 수 있다', () => {
  const html = sandbox.dayPickerHTML({ day: 22, _custom: false }, 'rec');
  assert.match(html, /id="recDayIn"[^>]*aria-label="반복일 직접 입력[^"]*"/);
});

/* ---------- endCondFields: 반복 횟수 입력(${pfx}CountBox)에 aria-label 존재 확인
 * (app-evolve cycle163 advance — placeholder="횟수"만 있고 label/aria-label이 없어 입력 후
 * 스크린리더로 구분이 안 되던 유일한 입력이었다. tx/rec 두 prefix가 공유하는 함수라 둘 다 확인한다.) */
test('endCondFields: tx 종료조건의 횟수 입력에 aria-label이 있다', () => {
  const html = sandbox.endCondFields({ freq: 'monthly', day: 10, startDate: '2026-01-01', weekend: 'none' }, 'tx');
  assert.match(html, /id="txCountBox"[^>]*aria-label="반복 횟수"/);
});
test('endCondFields: rec 종료조건의 횟수 입력에 aria-label이 있다', () => {
  const html = sandbox.endCondFields({ freq: 'monthly', day: 10, startDate: '2026-01-01', weekend: 'none' }, 'rec');
  assert.match(html, /id="recCountBox"[^>]*aria-label="반복 횟수"/);
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

/* ---------- recDates: daily 반복 + weekend 조정 시 금/월요일 3중 카운트 버그 (app-evolve cycle74 develop)
 * shiftWeekend()는 토요일과 일요일을 같은 평일로 몰아준다(earlier: 둘 다 금요일로, later: 둘 다 월요일로).
 * monthly/yearly는 기간당 원시 후보가 하나뿐이고 weekly는 매번 같은 요일만 후보로 나와 충돌이 없지만,
 * daily는 하루 간격으로 원시 후보를 만들기 때문에 주말이 낀 주에는 (조정 안 된 금요일 또는 월요일) +
 * (토요일 조정분) + (일요일 조정분)이 같은 날짜로 겹쳐 recDates()가 그 날짜를 3번 반환했다.
 * expandRec()이 이 결과를 그대로 가상 거래로 펼쳐 balancesUpTo()/totalAssets가 해당 금액을 3배로
 * 합산해 잔액이 조용히 틀어졌다. push()가 직전에 실제로 담긴 날짜와 같으면 건너뛰도록 고쳤다
 * (원시 후보가 항상 증가하는 날짜 순으로 생성되므로 연속 중복만 확인하면 충분). */
test('recDates: daily+weekend earlier에서 토/일 조정이 금요일로 겹쳐도 금요일이 한 번만 나온다', () => {
  const r = { freq: 'daily', startDate: '2026-06-01', endDate: null, weekend: 'earlier' };
  const dates = Array.from(sandbox.recDates(r, '2026-06-01', '2026-06-08'));
  assert.deepStrictEqual(dates, ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08']);
});
test('recDates: daily+weekend later에서 토/일 조정이 월요일로 겹쳐도 월요일이 한 번만 나온다', () => {
  const r = { freq: 'daily', startDate: '2026-06-01', endDate: null, weekend: 'later' };
  const dates = Array.from(sandbox.recDates(r, '2026-06-01', '2026-06-08'));
  assert.deepStrictEqual(dates, ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08']);
});

/* ---------- num()/fmtAmt(): 음수 입력 처리 (app-evolve cycle56 develop, cycle56 review에서 num() 수정)
 * 자산 "현재 금액" 필드(asAmt)는 마이너스통장(오버드래프트)처럼 잔액이 음수일 수 있는데,
 * fmtAmt()가 매 키 입력마다 '-' 문자까지 통째로 제거해 사용자가 애초에 음수를 입력할 수 없었다.
 * num()도 부호를 무시하고 절댓값만 파싱해, 설령 값에 '-'가 남아 있어도 양수로 읽혔다.
 * develop 커밋은 fmtAmt(inp,allowNeg)에는 allowNeg 게이팅을 넣었지만 num(el)은 게이팅 없이
 * 부호를 무조건 보존하도록 고쳐, syncTxInputs()/syncRecInputs()가 num($('txAmt'))/num($('rAmt'))로
 * 읽는 거래·반복 금액까지 전부 영향을 받았다 — editTx()가 txDraft=JSON.parse(JSON.stringify(t))로
 * DB.txns의 t.amount를 그대로 복제해 열기 때문에, 백업 복원/클라우드 동기화로 이미 음수가 된
 * t.amount(당시 SANITIZE_FREE_FIELDS는 amount를 "마이너스도 유효"로 취급해 걸러내지 않았음 —
 * cycle57 develop에서 sanitizeBackup()이 txns/recurrences amount도 min 0으로 클램프하도록
 * 고쳐 이 진입 경로 자체는 막혔다. sanitizeAmount 부근 주석 참고)를 가진 기존 거래를 열어
 * 금액칸을 건드리지 않고 저장만 해도(oninput이 한 번도 안 일어나 fmtAmt가 부호를 지울 기회가
 * 없음) num()이 그 음수를 그대로 통과시켜 income/expense/saving/transfer 타입별 부호 관례
 * (t.amount는 항상 크기, 부호는 type이 결정)를 깨는 회귀였다 — 다른 경로로 음수가 섞여 들어올
 * 가능성에 대비한 방어선으로 여전히 유효하다.
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

/* ---------- fmtQty(): FX/금/주식 보유 수량 입력란 실시간 정제 (app-evolve cycle119 advance)
 * fmtAmt는 콤마 포맷용이라 소수점을 아예 지워버려 보유 수량(소수 가능)엔 못 쓴다. 문자/기호는
 * 제거하되 소수점은 하나까지만 허용 — syncAssetInputs()가 이미 콤마 제거 후 parseFloat하므로
 * 콤마 포맷은 불필요. */
test('fmtQty(): 숫자가 아닌 문자/기호를 제거한다', () => {
  const inp = { value: '12a,3bc' };
  sandbox.fmtQty(inp);
  assert.strictEqual(inp.value, '123');
});
test('fmtQty(): 소수점 하나는 그대로 유지한다', () => {
  const inp = { value: '12.5' };
  sandbox.fmtQty(inp);
  assert.strictEqual(inp.value, '12.5');
});
test('fmtQty(): 소수점이 여러 개면 첫 번째만 남기고 나머지는 제거한다', () => {
  const inp = { value: '1.2.3.4' };
  sandbox.fmtQty(inp);
  assert.strictEqual(inp.value, '1.234');
});
test('fmtQty(): 빈 문자열은 그대로 빈 문자열로 남는다', () => {
  const inp = { value: '' };
  sandbox.fmtQty(inp);
  assert.strictEqual(inp.value, '');
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
/* ---------- doRenameCat: 거래(txns)의 memo도 반복거래와 대칭으로 이동해야 함 (app-evolve cycle80 develop) ----------
 * saveTx()는 메모를 비워 두면 카테고리명을 그대로 memo에 채운다(예: memo==='식비'). doRenameCat은
 * 반복거래는 memo===old일 때 memo도 함께 옮기면서, 정작 훨씬 흔한 일반 거래(txns)는 category만 바꾸고
 * memo는 그대로 두는 비대칭이 있었다. 그 결과 렌더는 t.memo||t.category를 주 이름으로 쓰므로
 * (memo가 채워져 있으면 그게 우선 표시), 이름을 바꾼 뒤에도 과거 거래 목록에는 옛 카테고리명이
 * 계속 주 이름으로 남고 새 이름은 작은 보조 텍스트로만 보이는 눈에 띄는 회귀가 생겼다. */
test('doRenameCat: 메모가 옛 카테고리명과 같았던(자동 채움) 거래는 memo도 새 이름으로 함께 이동한다', () => {
  sandbox.DB = {
    categories: { expense: ['식비'] }, catIcon: {}, catVar: {}, recurrences: [],
    txns: [{ id: 't1', type: 'expense', category: '식비', memo: '식비' }],
  };
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.txns[0].category, '외식비');
  assert.strictEqual(sandbox.DB.txns[0].memo, '외식비', '메모가 옛 카테고리명 그대로 남으면 목록에 옛 이름이 주 이름으로 계속 표시됨');
});
test('doRenameCat: 사용자가 직접 입력한(카테고리명과 다른) 거래 메모는 이름변경 후에도 그대로 유지된다', () => {
  sandbox.DB = {
    categories: { expense: ['식비'] }, catIcon: {}, catVar: {}, recurrences: [],
    txns: [{ id: 't1', type: 'expense', category: '식비', memo: '점심 김밥' }],
  };
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.txns[0].category, '외식비');
  assert.strictEqual(sandbox.DB.txns[0].memo, '점심 김밥', '사용자가 직접 쓴 메모는 카테고리 이름변경과 무관하게 보존돼야 함');
});

/* ---------- doRenameCat: 카테고리 이름이 바뀐 txns/recurrences에도 touch()로 updatedAt이 갱신돼야 함 (app-evolve cycle92 advance) ----------
 * doRenameOwner()와 완전히 같은 이유로(위 doRenameOwner touch() 테스트 참고), mergeCollection()의
 * 3-way 병합은 updatedAt만 보고 승자를 고른다. doRenameCat()은 DB.txns/DB.recurrences의 category(및
 * memo)만 바꾸고 touch()를 부르지 않아, 다른 기기가 오프라인 중 같은 레코드의 다른 필드만 더 나중에
 * 고쳐뒀다면 다음 동기화 때 그 사본이 이겨 카테고리 이름변경이 조용히 되돌아갈 수 있었다. 이름이
 * 바뀐 레코드에는 touch()가 호출되어야 하고, 무관한(다른 카테고리) 레코드는 건드리지 않아야 한다. */
test('doRenameCat: 카테고리가 바뀐 거래(txns)/반복거래(recurrences)에는 touch()가 호출돼 updatedAt이 갱신된다', () => {
  sandbox.DB = {
    categories: { expense: ['식비'] }, catIcon: {}, catVar: {},
    txns: [
      { id: 't1', type: 'expense', category: '식비', memo: '점심', updatedAt: 111 },
      { id: 't2', type: 'expense', category: '교통비', memo: '버스', updatedAt: 222 }, // 무관한 카테고리 — 건드리면 안 됨
    ],
    recurrences: [
      { id: 'r1', type: 'expense', category: '식비', memo: '월세', updatedAt: 333 },
      { id: 'r2', type: 'expense', category: '교통비', memo: '지하철', updatedAt: 444 }, // 무관한 카테고리 — 건드리면 안 됨
    ],
  };
  sandbox.catRenameDraft = { name: '외식비', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.txns[0].category, '외식비');
  assert.strictEqual(sandbox.DB.txns[0].updatedAt, 'test-updatedAt', '이름이 바뀐 거래에는 touch()가 호출되어야 함');
  assert.strictEqual(sandbox.DB.txns[1].updatedAt, 222, '무관한 거래의 updatedAt은 그대로여야 함');
  assert.strictEqual(sandbox.DB.recurrences[0].category, '외식비');
  assert.strictEqual(sandbox.DB.recurrences[0].updatedAt, 'test-updatedAt', '이름이 바뀐 반복거래에는 touch()가 호출되어야 함');
  assert.strictEqual(sandbox.DB.recurrences[1].updatedAt, 444, '무관한 반복거래의 updatedAt은 그대로여야 함');
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

/* ---------- goalPct/goalProgress: 순자산 목표 진행률 + 추세 투사 (app-evolve cycle122 advance) ----------
 * Plan 탭 광고 문구가 광고하던 '목표 달성' 기능이 실제로는 전혀 없었던 공백을 메우는 MVP.
 * goalProgress는 nwHistory(일별 {date,nw} 스냅샷)의 처음·끝 두 점만으로 선형 추세를 투사하므로,
 * 0%/100%+(이미 달성)/이력 없음/정체·감소(음수 진행) 네 경계를 모두 검증해 둔다. */
test('goalPct: 목표 금액이 설정돼 있으면 0~100%로 선형 계산한다(0% 경계)', () => {
  assert.strictEqual(sandbox.goalPct(0, 1000000), 0);
  assert.strictEqual(sandbox.goalPct(500000, 1000000), 50);
});
test('goalPct: 100%를 넘으면 clamp한다(100%+ 경계) — 초과분을 그대로 보여주는 budgetProgress와 달리 바 하나뿐이라 clamp', () => {
  assert.strictEqual(sandbox.goalPct(1000000, 1000000), 100);
  assert.strictEqual(sandbox.goalPct(1500000, 1000000), 100);
});
test('goalPct: 목표 금액이 0 이하(미설정)면 모은 돈이 있으면 100%, 없으면 0%로 방어적으로 처리한다', () => {
  assert.strictEqual(sandbox.goalPct(0, 0), 0);
  assert.strictEqual(sandbox.goalPct(500, 0), 100);
});
test('goalProgress: 순자산 이력이 없으면(0건) 현재값 0·진행률 0%·투사 날짜 없음', () => {
  const p = sandbox.goalProgress({ targetAmount: 1000000 }, [], '2026-02-01');
  assert.strictEqual(p.cur, 0);
  assert.strictEqual(p.pct, 0);
  assert.strictEqual(p.remaining, 1000000);
  assert.strictEqual(p.achieved, false);
  assert.strictEqual(p.projectedDate, null);
});
test('goalProgress: 이미 목표를 달성했으면(100%+) achieved=true이고 투사 날짜는 null이다', () => {
  const hist = [{ date: '2026-01-01', nw: 500000 }, { date: '2026-02-01', nw: 1200000 }];
  const p = sandbox.goalProgress({ targetAmount: 1000000 }, hist, '2026-02-01');
  assert.strictEqual(p.cur, 1200000);
  assert.strictEqual(p.pct, 100);
  assert.strictEqual(p.remaining, -200000);
  assert.strictEqual(p.achieved, true);
  assert.strictEqual(p.projectedDate, null);
});
test('goalProgress: 순자산이 꾸준히 늘고 있으면 일평균 증가량으로 도달일을 투사한다', () => {
  const hist = [{ date: '2026-01-01', nw: 0 }, { date: '2026-01-11', nw: 100000 }]; // 10일간 10만원 증가 = 1만원/일
  const p = sandbox.goalProgress({ targetAmount: 300000 }, hist, '2026-01-11');
  assert.strictEqual(p.cur, 100000);
  assert.strictEqual(p.remaining, 200000);
  assert.strictEqual(p.achieved, false);
  assert.strictEqual(p.projectedDate, '2026-01-31', '남은 20만원 ÷ 1만원/일 = 20일 뒤');
});
test('goalProgress: 순자산이 정체·감소 중(음수 진행)이면 추측 투사 없이 null을 돌려준다', () => {
  const hist = [{ date: '2026-01-01', nw: 500000 }, { date: '2026-02-01', nw: 400000 }]; // 감소 추세
  const p = sandbox.goalProgress({ targetAmount: 1000000 }, hist, '2026-02-01');
  assert.strictEqual(p.cur, 400000);
  assert.strictEqual(p.pct, 40);
  assert.strictEqual(p.remaining, 600000);
  assert.strictEqual(p.achieved, false);
  assert.strictEqual(p.projectedDate, null, '감소 추세로는 도달일을 예측할 수 없다고 말해야 함(추측 금지)');
});
test('goalProgress: today 이후의 미래 스냅샷은 무시하고 그 시점까지의 이력만 본다', () => {
  const hist = [{ date: '2026-01-01', nw: 100000 }, { date: '2026-06-01', nw: 999999 }];
  const p = sandbox.goalProgress({ targetAmount: 200000 }, hist, '2026-01-01');
  assert.strictEqual(p.cur, 100000, '미래 스냅샷을 섞어 쓰면 안 됨');
  assert.strictEqual(p.pct, 50);
  assert.strictEqual(p.projectedDate, null, '필터 후 이력이 1건뿐이면 추세를 계산할 수 없음');
});
test('goalProgress: 오래된 이력 전체는 완만했지만 최근 90일 구간만 급증했으면, 전체 평균이 아니라 최근 구간의 빠른 추세로 투사한다 (app-evolve cycle168 advance)', () => {
  // 2년(730일)간 10만원만 늘다가(거의 0에 가까운 추세) 최근 90일 동안 90만원이 늘었음(1만원/일).
  // 전체 평균(730일에 100만원 = ~1370원/일)으로 투사하면 남은 500만원에 수천 일이 걸리지만,
  // 최근 추세(1만원/일)로는 500일이면 된다 — 창을 안 두면 '거의 영원히 못 간다'로 잘못 보임.
  const hist = [
    { date: '2024-01-01', nw: 100000 },
    { date: '2026-01-03', nw: 200000 }, // 최근 90일 창(cutoff=2026-01-02) 안, 완만한 2년 추세의 끝점
    { date: '2026-04-02', nw: 1100000 }, // today, 최근 창 구간(89일)에 +900,000 ≈ 10,112/일
  ];
  const p = sandbox.goalProgress({ targetAmount: 6000000 }, hist, '2026-04-02');
  assert.strictEqual(p.cur, 1100000);
  assert.strictEqual(p.remaining, 4900000);
  assert.strictEqual(p.projectedDate, '2027-07-31', '전체 2년 평균(2024-01-01부터)이 아니라 최근 90일 창(2026-01-03부터)의 빠른 추세로 투사해야 함');
});
test('goalProgress: 최근 90일 구간에 스냅샷이 1개뿐이면(데이터가 희소해도) 전체 이력으로 폴백해 기존 동작을 유지한다', () => {
  const hist = [{ date: '2026-01-01', nw: 0 }, { date: '2026-04-01', nw: 90000 }]; // 90일간 90,000 = 1,000/일, 두 점 모두 창(90일) 경계 안팎에 걸침
  const p = sandbox.goalProgress({ targetAmount: 300000 }, hist, '2026-04-01');
  assert.strictEqual(p.cur, 90000);
  assert.notStrictEqual(p.projectedDate, null, '창 안에 2점 미만이면 전체 이력으로 폴백해야 함(투사 자체가 사라지면 안 됨)');
});

/* ---------- debtPayoffProjection: debt 자산 상환완료 예상일 투사 (app-evolve cycle144 advance) ----------
 * goalProgress와 대칭되는 부채 쪽 선형투사. pts는 assetBalanceSeries(sign=-1)가 반환하는 날짜순
 * {date,bal} 배열(bal은 양수=남은 빚)을 그대로 받는다고 가정해 네 경계를 검증한다. */
test('debtPayoffProjection: 잔액이 이미 0 이하면 achieved=true이고 투사 날짜는 null이다', () => {
  const pts = [{ date: '2026-01-01', bal: 100000 }, { date: '2026-02-01', bal: 0 }];
  const p = sandbox.debtPayoffProjection(pts, '2026-02-01');
  assert.strictEqual(p.achieved, true);
  assert.strictEqual(p.projectedDate, null);
});
test('debtPayoffProjection: 포인트가 1개뿐이면(이력 부족) 투사할 수 없다', () => {
  const pts = [{ date: '2026-01-01', bal: 500000 }];
  const p = sandbox.debtPayoffProjection(pts, '2026-01-01');
  assert.strictEqual(p.achieved, false);
  assert.strictEqual(p.projectedDate, null);
});
test('debtPayoffProjection: 잔액이 정체·증가 중이면 추측 투사 없이 null을 돌려준다', () => {
  const pts = [{ date: '2026-01-01', bal: 400000 }, { date: '2026-02-01', bal: 500000 }]; // 오히려 늘어남
  const p = sandbox.debtPayoffProjection(pts, '2026-02-01');
  assert.strictEqual(p.achieved, false);
  assert.strictEqual(p.projectedDate, null, '증가 추세로는 완납일을 예측할 수 없다고 말해야 함(추측 금지)');
});
test('debtPayoffProjection: 꾸준히 갚고 있으면 일평균 감소량으로 완납일을 투사한다', () => {
  const pts = [{ date: '2026-01-01', bal: 300000 }, { date: '2026-01-11', bal: 200000 }]; // 10일간 10만원 감소 = 1만원/일
  const p = sandbox.debtPayoffProjection(pts, '2026-01-11');
  assert.strictEqual(p.achieved, false);
  assert.strictEqual(p.projectedDate, '2026-01-31', '남은 20만원 ÷ 1만원/일 = 20일 뒤');
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
    categories: { expense: ['커피', '식비'] },
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
    categories: { income: ['용돈', '급여'] },
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
test('doRenameCat: 대소문자만 다른 이름으로 바꾸면 다른 카테고리와 근접 중복으로 막고 기존 이름을 토스트에 보여준다', () => {
  sandbox.DB = {
    categories: { expense: ['Food', '교통비'] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.catRenameDraft = { name: 'food', icon: '' };
  sandbox.lastToast = null;
  sandbox.doRenameCat('expense', 1);
  assert.strictEqual(sandbox.DB.categories.expense[1], '교통비', '근접 중복이면 이름이 바뀌면 안 됨');
  assert.strictEqual(sandbox.lastToast, '비슷한 카테고리가 있어요: Food');
});
test('doRenameCat: 자기 자신의 대소문자만 바꾸는 변경은 근접 중복으로 막지 않는다', () => {
  sandbox.DB = {
    categories: { expense: ['Food'] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.catRenameDraft = { name: 'food', icon: '' };
  sandbox.doRenameCat('expense', 0);
  assert.strictEqual(sandbox.DB.categories.expense[0], 'food', '자기 자신과의 대소문자 변경은 허용돼야 함');
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
      { id: 'r1', active: true, type: 'expense', category: '외식', updatedAt: 1 },
      { id: 'r2', active: false, type: 'expense', category: '외식', updatedAt: 1 }, // 이미 비활성 — 건드리면 안 됨
      { id: 'r3', active: true, type: 'expense', category: '교통', updatedAt: 1 },  // 무관한 카테고리 — 건드리면 안 됨
    ],
  };
  sandbox.lastUndo = null;
  sandbox.doDeleteCat('expense', 0);
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['교통'], '카테고리가 삭제돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r1').active, false, '연결된 활성 반복거래가 비활성화돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r1').updatedAt, 'test-updatedAt', '비활성화된 반복거래는 touch()되어야 함 (클라우드 동기화 시 되돌아가지 않도록)');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r3').active, true, '무관한 카테고리의 반복거래는 건드리면 안 됨');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r3').updatedAt, 1, '무관한 카테고리의 반복거래는 touch()되면 안 됨');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['외식', '교통'], '되돌리면 카테고리가 원래 위치로 복원돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r1').active, true, '되돌리면 반복거래도 다시 활성화돼야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r1').updatedAt, 'test-updatedAt', '되돌릴 때도 touch()되어야 함');
  assert.strictEqual(sandbox.DB.recurrences.find(r => r.id === 'r2').active, false, '원래부터 비활성이던 반복거래는 그대로 비활성 유지');
  assert.strictEqual(sandbox.DB.catIcon['expense:외식'], 'food', '아이콘도 복원돼야 함');
  assert.strictEqual(sandbox.isVarCat('expense', '외식'), true, '변동 카테고리 플래그도 복원돼야 함');
  assert.strictEqual(sandbox.budgetForMonth('외식', 2026, 6), 50000, '예산 이력도 복원돼야 함');
});
test('doDeleteCat: 연결된 활성 반복거래가 없으면 undo해도 반복거래 배열은 그대로다', () => {
  sandbox.DB = {
    categories: { expense: ['교통', '기타'] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.lastUndo = null;
  sandbox.doDeleteCat('expense', 0);
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['교통', '기타']);
  assert.deepStrictEqual(sandbox.DB.recurrences, []);
});

/* ---------- doDeleteCat: 마지막 카테고리는 삭제되지 않는다 (delOwner와 동일 패턴, cycle69) ----------
 * 카테고리가 0개가 되면 openTxSheet/txType이 undefined 카테고리로 거래를 만들고, 그 뒤로는
 * openCatPicker도 고를 카테고리가 없어 되돌릴 방법이 없어진다. */
test('doDeleteCat: 마지막 남은 지출 카테고리 하나는 삭제할 수 없다', () => {
  sandbox.DB = {
    categories: { expense: ['식비'] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.lastToast = null;
  sandbox.doDeleteCat('expense', 0);
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['식비']);
  assert.ok(sandbox.lastToast, '안내 토스트가 떴어야 함');
});
test('doDeleteCat: 마지막 남은 수입 카테고리 하나는 삭제할 수 없다', () => {
  sandbox.DB = {
    categories: { income: ['급여'] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.lastToast = null;
  sandbox.doDeleteCat('income', 0);
  assert.deepStrictEqual(sandbox.DB.categories.income, ['급여']);
  assert.ok(sandbox.lastToast, '안내 토스트가 떴어야 함');
});
test('doDeleteCat: 마지막 남은 저축 카테고리 하나는 삭제할 수 없다', () => {
  sandbox.DB = {
    categories: { saving: ['비상금'] },
    catIcon: {}, catVar: {}, budgetHistory: {}, txns: [], recurrences: [],
  };
  sandbox.lastToast = null;
  sandbox.doDeleteCat('saving', 0);
  assert.deepStrictEqual(sandbox.DB.categories.saving, ['비상금']);
  assert.ok(sandbox.lastToast, '안내 토스트가 떴어야 함');
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

/* ---------- openBudgetPrompt: budgetIn도 다른 금액 입력란과 같은 지우기(×) 버튼 관례를 따라야 함
 * (app-evolve develop cycle — txAmt/rAmt/goalAmt/asCostBasis/asAmt/qAmt/bigMinInput은 모두
 * .field-clear로 감싸 입력값이 있을 때 누르면 즉시 비워지는 fc-x 버튼을 제공하는데, budgetIn만
 * 빠져 있었다. cycle121이 콤마 포맷/num() 파서를 통일한 것과 같은 이유로, 다른 금액 입력란과
 * 나란히 쓰는 사용자에게 이 칸만 지우는 방법이 다르면(전체 선택 후 삭제) 눈에 띄는 불일치다). */
test('openBudgetPrompt: budgetIn도 다른 금액 입력란(txAmt/rAmt/goalAmt/asCostBasis/qAmt)과 동일하게 field-clear(×) 버튼이 있다', () => {
  sandbox.DB = { txns: [], recurrences: [], budgetHistory: { 식비: [{ from: '2026-01', amount: 50000 }] } };
  sandbox.ST = { ledger: { y: 2026, m: 6 } };
  sandbox.lastSheetHtml = null;
  sandbox.openBudgetPrompt(0);
  assert.ok(sandbox.lastSheetHtml.includes('<div class="field-clear"><input id="budgetIn"'), 'budgetIn 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(sandbox.lastSheetHtml.includes(`<button type="button" class="fc-x" aria-label="예산 금액 지우기" onclick="clrInput('budgetIn')">`), 'budgetIn에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
/* bigMinInput('큰 지출' 기준 금액, openBigMinSheet)도 budgetIn/qAmt와 같은 누락이 있던 금액 입력란이다. */
test('openBigMinSheet: bigMinInput도 다른 금액 입력란과 동일하게 field-clear(×) 버튼이 있다', () => {
  sandbox.DB = { settings: {} };
  sandbox.lastSheetHtml = null;
  sandbox.openBigMinSheet();
  assert.ok(sandbox.lastSheetHtml.includes('<div class="field-clear"><input id="bigMinInput"'), 'bigMinInput 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(sandbox.lastSheetHtml.includes(`<button type="button" class="fc-x" aria-label="기준 금액 지우기" onclick="clrInput('bigMinInput')">`), 'bigMinInput에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});

/* ---------- saveBudget: budgetIn 입력란이 다른 금액 입력란(txAmt/rAmt/asAmt 등)처럼 천단위
 * 콤마 포맷(fmtAmt)+공용 num() 파서를 쓰도록 통일 (app-evolve cycle121 develop) — 이전에는
 * budgetIn만 유일하게 type="number" 네이티브 입력란이라 콤마 표시가 전혀 없었고, saveBudget()도
 * Math.round(Number(el.value))로 직접 파싱해 다른 모든 save*류가 쓰는 num()과 다른 경로였다.
 * num()은 콤마를 제거하고 파싱하므로, 포맷된 "1,500,000" 문자열을 그대로 줘도 올바르게 읽혀야 한다. */
test('saveBudget: 천단위 콤마가 포함된 budgetIn 값(num() 파서 경로)을 올바르게 저장한다', () => {
  sandbox.DB = { txns: [{ type: 'expense', category: '식비', amount: 10000, date: '2026-06-10' }], recurrences: [], budgetHistory: {} };
  sandbox.ST = { ledger: { y: 2026, m: 6 } };
  sandbox.budgetInValue = '1,500,000';
  sandbox.saveBudget(0); // rows[0] === {c:'식비',v:10000} (이번 달 지출이 있는 유일한 카테고리)
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 1500000);
});
test('saveBudget: 빈 값이면 저장하지 않고 안내 토스트만 띄운다', () => {
  sandbox.DB = { txns: [{ type: 'expense', category: '식비', amount: 10000, date: '2026-06-10' }], recurrences: [], budgetHistory: {} };
  sandbox.ST = { ledger: { y: 2026, m: 6 } };
  sandbox.budgetInValue = '';
  sandbox.lastToast = null;
  sandbox.saveBudget(0);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 0, '저장되지 않아야 함');
  assert.ok(sandbox.lastToast, '안내 토스트가 떴어야 함');
});
test('saveBudget: 존재하지 않는 idx를 넘기면 아무것도 하지 않는다', () => {
  sandbox.DB = { txns: [{ type: 'expense', category: '식비', amount: 10000, date: '2026-06-10' }], recurrences: [], budgetHistory: {} };
  sandbox.ST = { ledger: { y: 2026, m: 6 } };
  sandbox.budgetInValue = '100000';
  sandbox.saveBudget(99);
  assert.strictEqual(sandbox.budgetForMonth('식비', 2026, 6), 0);
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

/* ---------- normName: 카테고리/귀속 근접 중복(대소문자·연속 공백) 판정용 정규화 (app-evolve cycle85 advance) ----------
 * addCat/doRenameCat/addOwner/doRenameOwner 네 곳 모두 trim() 후 완전 일치로만 중복을 판정해,
 * "Food"와 "food", "용   돈"과 "용 돈"처럼 대소문자·내부 공백만 다른 이름이 별개 항목으로 조용히
 * 생성돼 이름 기반 집계(expenseByCat/ownerAssets 등)가 사용자도 모르게 두 갈래로 쪼개지는 문제를 막는다. */
test('normName: 대소문자만 다르면 같은 정규화 결과를 낸다', () => {
  assert.strictEqual(sandbox.normName('Food'), sandbox.normName('food'));
  assert.strictEqual(sandbox.normName('FOOD'), 'food');
});
test('normName: 연속 공백·전각공백만 다르면 같은 정규화 결과를 낸다', () => {
  assert.strictEqual(sandbox.normName('용   돈'), sandbox.normName('용 돈'));
  assert.strictEqual(sandbox.normName('용　돈'), sandbox.normName('용 돈'));
});
test('normName: 앞뒤 공백은 trim되고, 실제로 다른 이름은 다른 결과를 낸다', () => {
  assert.strictEqual(sandbox.normName('  식비  '), '식비');
  assert.notStrictEqual(sandbox.normName('식비'), sandbox.normName('교통비'));
});
/* 한글 완성형(NFC)과 조합형(NFD, macOS/HFS+ 클립보드나 일부 CSV 내보내기가 생성)은 같은 글자를
 * 다르게 인코딩한다. normalize('NFC') 없이는 두 폼이 다른 문자열로 비교돼 같은 이름인데도
 * 근접중복 판정을 피해 조용히 별개 항목이 생길 수 있었다 (app-evolve cycle141 advance). */
test('normName: 한글 NFC(완성형)와 NFD(조합형)는 같은 정규화 결과를 낸다', () => {
  const nfc = '식비'.normalize('NFC');
  const nfd = '식비'.normalize('NFD');
  assert.notStrictEqual(nfc, nfd, '테스트 전제: 두 문자열은 바이트 수준에서 달라야 한다');
  assert.strictEqual(sandbox.normName(nfc), sandbox.normName(nfd));
  const nfcOwner = '공동명의'.normalize('NFC');
  const nfdOwner = '공동명의'.normalize('NFD');
  assert.strictEqual(sandbox.normName(nfcOwner), sandbox.normName(nfdOwner));
});

test('addCat: 대소문자만 다른 이름은 근접 중복으로 막고 기존 이름을 토스트에 보여준다', () => {
  sandbox.DB = { categories: { expense: ['Food'] }, catIcon: {}, catVar: {}, txns: [], recurrences: [] };
  sandbox.catAddDraft = { name: 'food', icon: 'coffee' };
  sandbox.lastToast = null;
  sandbox.addCat('expense');
  assert.strictEqual(sandbox.lastToast, '비슷한 카테고리가 있어요: Food');
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['Food'], '근접 중복이면 배열에 추가되면 안 됨');
});
test('addCat: 내부 공백만 다른 이름도 근접 중복으로 막는다', () => {
  sandbox.DB = { categories: { expense: ['용 돈'] }, catIcon: {}, catVar: {}, txns: [], recurrences: [] };
  sandbox.catAddDraft = { name: '용   돈', icon: '' };
  sandbox.lastToast = null;
  sandbox.addCat('expense');
  assert.strictEqual(sandbox.lastToast, '비슷한 카테고리가 있어요: 용 돈');
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['용 돈']);
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
test('migrate: DB.owners가 빈 배열이면(categories와 마찬가지로) 기본 귀속 3개로 채워진다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: [],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
  };
  sandbox.migrate();
  assert.deepStrictEqual([...sandbox.DB.owners], ['나', '배우자', '공용'], '[]는 truthy라 ||로는 안 잡히므로 categories처럼 .length로 검사해야 함');
});
test('migrate: DB.owners가 이미 값을 가지고 있으면 그대로 유지한다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['커스텀귀속'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
  };
  sandbox.migrate();
  assert.deepStrictEqual(sandbox.DB.owners, ['커스텀귀속']);
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
test('updateNwHistory: byOwner 인자를 넘기면 스냅샷에 귀속별 ta/td가 함께 저장된다(nwHistoryCard의 귀속별 추이용)', () => {
  const hist = sandbox.updateNwHistory([], '2026-01-01', 300, 20, { 나: { ta: 200, td: 10 }, 배우자: { ta: 100, td: 10 } });
  assert.deepStrictEqual(hist[0].byOwner, { 나: { ta: 200, td: 10 }, 배우자: { ta: 100, td: 10 } });
});
test('updateNwHistory: byOwner를 넘기지 않으면(하위호환) 항목에 byOwner 필드가 아예 생기지 않는다', () => {
  const hist = sandbox.updateNwHistory([], '2026-01-01', 300, 20);
  assert.strictEqual('byOwner' in hist[0], false);
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
/* ---------- nwHistoryRange/nwNearestPointIndex: 순자산 추이 카드 기간 선택 (app-evolve cycle135 critique/advance) ----------
 * nwHistoryCard가 항상 hist.slice(-60)으로 최근 60일 고정 스파크라인만 보여주던 걸 1개월/3개월/1년/전체
 * 프리셋으로 바꿀 수 있게 한 순수 함수. pruneNwHistory가 이미 90일 이후를 월별로 압축해두므로
 * 추가 다운샘플링 없이 날짜 cutoff로 거르기만 한다. */
test('nwHistoryRange: preset이 "all"이면 다운샘플링 없이 원본을 그대로 돌려준다', () => {
  const hist = [{ date: '2020-01-01', nw: 1 }, { date: '2026-01-01', nw: 2 }];
  assert.strictEqual(sandbox.nwHistoryRange(hist, 'all', '2026-06-15'), hist);
});
test('nwHistoryRange: hist가 비어있으면 preset과 무관하게 빈 배열을 그대로 돌려준다', () => {
  // vm 컨텍스트에서 만든 배열 리터럴은 메인 realm의 []와 "같은 구조지만 참조가 다름"으로
  // deepStrictEqual이 실패한다(cycle131에서 처음 발견한 realm 경계 문제와 동일) — length만 비교.
  assert.strictEqual(sandbox.nwHistoryRange([], 'm1', '2026-06-15').length, 0);
  assert.strictEqual(sandbox.nwHistoryRange(null, 'y1', '2026-06-15').length, 0);
});
test('nwHistoryRange: "m1"은 today 기준 최근 30일보다 오래된 스냅샷을 제외한다(경계는 포함하지 않음)', () => {
  const hist = [
    { date: '2026-05-16', nw: 0 }, // today-30일: cutoff와 정확히 같은 날 → h.date>cutoff가 false라 제외
    { date: '2026-05-17', nw: 1 },
    { date: '2026-06-15', nw: 2 },
  ];
  const out = sandbox.nwHistoryRange(hist, 'm1', '2026-06-15');
  assert.deepStrictEqual(out.map(h => h.date), ['2026-05-17', '2026-06-15']);
});
test('nwHistoryRange: "y1"은 최근 1년치만, "m3"(기본값)은 최근 90일치만 남긴다', () => {
  const hist = [
    { date: '2024-01-01', nw: 0 },
    { date: '2025-07-01', nw: 1 }, // 2026-06-15 기준 1년(365일) 이내
    { date: '2026-04-01', nw: 2 }, // 90일 이내는 아님(약 75일 전이라 포함)
    { date: '2026-06-15', nw: 3 },
  ];
  const y1 = sandbox.nwHistoryRange(hist, 'y1', '2026-06-15');
  assert.deepStrictEqual(y1.map(h => h.date), ['2025-07-01', '2026-04-01', '2026-06-15']);
  const m3 = sandbox.nwHistoryRange(hist, 'm3', '2026-06-15');
  assert.deepStrictEqual(m3.map(h => h.date), ['2026-04-01', '2026-06-15'], '90일보다 오래된 2024/2025 스냅샷은 제외돼야 함');
});
test('nwHistoryRange: today를 생략하면(falsy) hist의 마지막 항목 날짜를 기준으로 삼는다', () => {
  const hist = [{ date: '2026-01-01', nw: 0 }, { date: '2026-01-02', nw: 1 }];
  const out = sandbox.nwHistoryRange(hist, 'm1');
  assert.deepStrictEqual(out.map(h => h.date), ['2026-01-01', '2026-01-02'], '둘 다 마지막 날짜(01-02) 기준 30일 이내라 그대로 남아야 함');
});
test('nwNearestPointIndex: 점이 없으면 -1, 1개면 0을 돌려준다', () => {
  assert.strictEqual(sandbox.nwNearestPointIndex([], 0.5), -1);
  assert.strictEqual(sandbox.nwNearestPointIndex(null, 0.5), -1);
  assert.strictEqual(sandbox.nwNearestPointIndex([{ date: '2026-01-01' }], 0.9), 0);
});
test('nwNearestPointIndex: ratio 0/1이면 첫/마지막 점을, 날짜 간격이 불균등해도 비율 기준으로 가장 가까운 점을 돌려준다', () => {
  const pts = [
    { date: '2026-01-01' }, { date: '2026-01-02' }, { date: '2026-01-31' }, // 30일 구간, 둘째 점은 1/30 지점
  ];
  assert.strictEqual(sandbox.nwNearestPointIndex(pts, 0), 0);
  assert.strictEqual(sandbox.nwNearestPointIndex(pts, 1), 2);
  // 28.5일째(ratio 0.95)는 셋째 점(30일째)이 첫째/둘째 점보다 훨씬 가까워야 함 — 날짜 간격 기준 거리임을 확인
  assert.strictEqual(sandbox.nwNearestPointIndex(pts, 0.95), 2, '28.5일째는 30일째 점이 가장 가까워야 함');
  assert.strictEqual(sandbox.nwNearestPointIndex(pts, 0.02), 1, '1일째 근처는 둘째 점(1/30일)이 가장 가까워야 함');
});
test('nwChartPath: 점이 2개 미만이면 빈 경로를 반환한다', () => {
  const r = sandbox.nwChartPath([{ nw: 100 }], 300, 80);
  assert.strictEqual(r.line, '');
  assert.strictEqual(r.area, '');
});

/* ---------- assetBalSampleDates/assetBalanceSeries: 개별 자산 잔액 추이 (app-evolve cycle140 critique/advance) ----------
 * openAssetHistory가 전체내역을 계좌 하나로 필터했을 때 꽂는 미니 차트용 샘플링+재생 순수 함수.
 * vm 샌드박스가 만든 배열/객체 리터럴은 host realm과 프로토타입이 달라 deepStrictEqual이 값이
 * 같아도 "same structure but not reference-equal"로 실패하므로(위 recDates 테스트들과 동일한 이유),
 * JSON.parse(JSON.stringify(...))로 host realm 값으로 정규화해 비교한다(parseCSV 테스트와 동일 패턴). */
test('assetBalSampleDates: from>to면 빈 배열', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.assetBalSampleDates('2026-02-01', '2026-01-01', 30))), []);
});
test('assetBalSampleDates: 구간이 maxPoints보다 짧으면 다운샘플링 없이 매일 하나씩 반환한다', () => {
  const out = JSON.parse(JSON.stringify(sandbox.assetBalSampleDates('2026-01-01', '2026-01-05', 30)));
  assert.deepStrictEqual(out, ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
});
test('assetBalSampleDates: 구간이 maxPoints보다 길면 균등 샘플링하되 첫/끝 날짜는 항상 포함한다', () => {
  const out = JSON.parse(JSON.stringify(sandbox.assetBalSampleDates('2026-01-01', '2027-01-01', 5)));
  assert.strictEqual(out[0], '2026-01-01');
  assert.strictEqual(out[out.length - 1], '2027-01-01');
  assert.ok(out.length <= 5, `최대 5개를 넘지 않아야 함 (실제 ${out.length})`);
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1] < out[i], '날짜가 오름차순이어야 함');
});
test('assetBalanceSeries: 기준액만 있고 거래가 없으면 모든 날짜가 기준액 그대로다', () => {
  const dates = ['2026-01-01', '2026-01-15', '2026-02-01'];
  const out = JSON.parse(JSON.stringify(sandbox.assetBalanceSeries([], 'a1', 10000, 1, dates)));
  assert.deepStrictEqual(out, dates.map(d => ({ date: d, bal: 10000 })));
});
test('assetBalanceSeries: 날짜 순서와 무관하게 정렬해 날짜별 거래를 누적한다(일반 자산은 입금 +, 출금 -)', () => {
  const txns = [
    { date: '2026-01-20', fromAssetId: 'a1', amount: 2000 }, // a1에서 출금
    { date: '2026-01-10', toAssetId: 'a1', amount: 5000 },   // a1으로 입금
  ];
  const dates = ['2026-01-01', '2026-01-15', '2026-02-01'];
  const out = JSON.parse(JSON.stringify(sandbox.assetBalanceSeries(txns, 'a1', 1000, 1, dates)));
  assert.deepStrictEqual(out, [
    { date: '2026-01-01', bal: 1000 },   // 아직 거래 전
    { date: '2026-01-15', bal: 6000 },   // 1/10 입금만 반영
    { date: '2026-02-01', bal: 4000 },   // 1/20 출금까지 반영
  ]);
});
test('assetBalanceSeries: sign=-1(부채)이면 입금이 잔액을 줄이고 출금이 늘린다', () => {
  const txns = [{ date: '2026-01-10', toAssetId: 'd1', amount: 3000 }]; // 부채 상환(입금) → 잔여원금 감소
  const out = JSON.parse(JSON.stringify(sandbox.assetBalanceSeries(txns, 'd1', 10000, -1, ['2026-01-20'])));
  assert.deepStrictEqual(out, [{ date: '2026-01-20', bal: 7000 }]);
});
test('assetBalanceSeries: 다른 자산의 거래는 무시한다', () => {
  const txns = [{ date: '2026-01-10', toAssetId: 'other', amount: 5000 }];
  const out = JSON.parse(JSON.stringify(sandbox.assetBalanceSeries(txns, 'a1', 1000, 1, ['2026-01-20'])));
  assert.deepStrictEqual(out, [{ date: '2026-01-20', bal: 1000 }]);
});

/* ---------- notifyReliabilityTier/notifyReliabilityMsg: OS 알림 토스트/캡션의 실제 능력 고지
 * (app-evolve cycle145 critique/advance) ----------
 * checkNotifyAlerts()는 document.hidden일 때만 동작하는 foreground/background 로컬 알림일 뿐
 * periodicSync/푸시 서버가 없다 — '앱을 닫아둬도 알려드려요' 같은 과잉 약속 대신 실제 범위만
 * 말하는 두 등급(foreground-tab=iOS, background-tab=그 외)으로 좁혀 고정한다. */
test('notifyReliabilityTier: iOS는 foreground-tab, 그 외는 background-tab이다', () => {
  assert.strictEqual(sandbox.notifyReliabilityTier(true), 'foreground-tab');
  assert.strictEqual(sandbox.notifyReliabilityTier(false), 'background-tab');
});
test('notifyReliabilityMsg: foreground-tab/background-tab 등급마다 다른 문구를 돌려주고, 둘 다 "완전히 종료하면" 한계를 명시한다', () => {
  const fg = sandbox.notifyReliabilityMsg('foreground-tab');
  const bg = sandbox.notifyReliabilityMsg('background-tab');
  assert.notStrictEqual(fg, bg);
  assert.ok(fg.includes('완전히 종료하면'), 'foreground-tab 문구에 종료 시 한계가 빠짐');
  assert.ok(bg.includes('완전히 종료하면'), 'background-tab 문구에 종료 시 한계가 빠짐');
  assert.ok(!fg.includes('앱을 닫아둬도') && !bg.includes('앱을 닫아둬도'), '과거의 과잉 약속 문구("앱을 닫아둬도")가 남아있으면 안 됨');
});
// (app-evolve cycle147 review: "toast(...)가 notifyReliabilityMsg를 쓴다"는 toggleOsNotify
// 함수 하나의 문제인데 src.includes()로 보면 파일 전체 어딘가에 그 문자열만 있어도 통과한다 —
// 정작 toggleOsNotify가 그 토스트 호출을 잃고 다른 데(예: 주석)에 같은 문자열이 남아도 거짓
// 안전감을 준다. extractFunction으로 그 함수 몸통만 잘라 검사하도록 좁힌다. "앱을 닫아둬도"
// 부재 확인은 파일 전체에서 "어디에도 없어야" 하는 전역 네거티브 체크라 src 그대로 쓴다.)
test('toggleOsNotify: 켤 때 토스트가 notifyReliabilityMsg(notifyReliabilityTier(IS_IOS))를 쓰고, 과거의 "앱을 닫아둬도" 문구는 완전히 제거됐다', () => {
  assert.ok(extractFunction('toggleOsNotify').includes("toast('OS 알림을 켰어요 · '+notifyReliabilityMsg(notifyReliabilityTier(IS_IOS)))"), 'toggleOsNotify 토스트가 notifyReliabilityMsg를 쓰지 않음');
  assert.ok(!src.includes('앱을 닫아둬도'), '과거의 과잉 약속 문구("앱을 닫아둬도")가 소스에 남아있음');
});
// Notification.requestPermission()은 권한 정책 차단 등으로 reject될 수 있는데, .then()만 있고
// .catch()가 없으면 그 실패가 콘솔의 unhandled rejection으로만 남고 화면엔 아무 반응이 없다 —
// 토글을 눌렀는데 꺼진 채 그대로라 사용자는 버튼이 멈췄다고 오인한다(app-evolve cycle151 develop).
// extractFunction으로 몸통만 좁혀 .then(...) 뒤에 에러 토스트를 띄우는 .catch(...)가 실제로
// 체이닝돼 있는지 검사한다(파일 전체 src.includes()면 다른 함수의 비슷한 catch에도 속아 통과함).
test('toggleOsNotify: Notification.requestPermission()이 reject돼도 unhandled rejection으로 묻히지 않고 .catch()로 실패 토스트를 띄운다', () => {
  const body = extractFunction('toggleOsNotify');
  assert.ok(/\.then\([^]*?\}\)\.catch\(\(\)=>toast\(/.test(body), 'toggleOsNotify의 requestPermission() 체인에 .catch() 실패 처리가 없음');
  assert.ok(!/\.then\([^]*?\}\);\s*\}$/.test(body), 'toggleOsNotify가 .catch() 없이 .then()만으로 끝남(reject 시 무반응)');
});
test('renderMenu: OS 알림이 켜져 있으면 "알림 · 기준" 그룹 아래 실제 능력 고지 캡션이 상시 노출된다', () => {
  const body = extractFunction('renderMenu');
  assert.ok(body.includes("g.cap==='알림 · 기준'&&DB.settings.osNotify"), 'renderMenu가 OS 알림 캡션을 조건부로 렌더하지 않음');
  assert.ok(body.includes('notifyReliabilityMsg(notifyReliabilityTier(IS_IOS))'), 'renderMenu의 캡션이 notifyReliabilityMsg를 쓰지 않음');
});
// toggleOsNotify()가 켤 때 한 번 Notification.requestPermission()으로 DB.settings.osNotify=true를
// 세팅한 뒤로는 아무도 실제 권한 상태를 다시 확인하지 않아서, 사용자가 나중에 OS/브라우저 설정에서
// 알림 권한을 꺼버리면 checkNotifyAlerts()는 조용히 멈추지만 메뉴 스위치는 계속 켜진 것처럼 보이던
// 버그의 회귀 테스트(app-evolve cycle161 advance, cycle160 critique의 계획).
test('syncNotifyPermission: OS 알림이 켜진 상태에서 브라우저 알림 권한이 꺼지면(denied) 토글을 자동으로 내리고 안내한다', () => {
  sandbox.DB = { settings: { osNotify: true } };
  sandbox.Notification = { permission: 'denied' };
  sandbox.lastToast = null;
  sandbox.syncNotifyPermission();
  assert.strictEqual(sandbox.DB.settings.osNotify, false, '권한이 꺼졌으면 osNotify도 false로 내려가야 함');
  assert.ok(sandbox.lastToast, '권한이 꺼져서 토글이 내려갔다는 안내 토스트가 떴어야 함');
});
test('syncNotifyPermission: 권한이 아직 granted면 아무것도 건드리지 않는다', () => {
  sandbox.DB = { settings: { osNotify: true } };
  sandbox.Notification = { permission: 'granted' };
  sandbox.lastToast = null;
  sandbox.syncNotifyPermission();
  assert.strictEqual(sandbox.DB.settings.osNotify, true, 'granted 상태에서는 osNotify를 건드리면 안 됨');
  assert.strictEqual(sandbox.lastToast, null, 'granted 상태에서는 안내 토스트가 뜨면 안 됨');
});
test('syncNotifyPermission: osNotify가 이미 꺼져 있으면 권한 상태와 무관하게 아무 일도 하지 않는다', () => {
  sandbox.DB = { settings: { osNotify: false } };
  sandbox.Notification = { permission: 'denied' };
  sandbox.lastToast = null;
  sandbox.syncNotifyPermission();
  assert.strictEqual(sandbox.DB.settings.osNotify, false);
  assert.strictEqual(sandbox.lastToast, null, 'osNotify가 꺼져 있으면 토스트가 뜨면 안 됨');
});
test('renderMenu: 브라우저 알림 권한이 차단(denied)되면 "OS 알림" 메뉴 라벨에 차단됨을 표시한다', () => {
  const body = extractFunction('renderMenu');
  assert.ok(body.includes("Notification.permission==='denied')?'OS 알림 · 차단됨':'OS 알림'"), 'renderMenu가 denied 권한을 라벨에 반영하지 않음');
});
test('nwChartPath: 모든 값이 같으면(span=0) 0으로 나누지 않고 수평선을 그린다', () => {
  const { line } = sandbox.nwChartPath([
    { date: '2026-01-01', nw: 100 }, { date: '2026-01-02', nw: 100 }, { date: '2026-01-03', nw: 100 },
  ], 300, 80);
  assert.ok(!line.includes('NaN'), '값이 모두 같아도 NaN이 나오면 안 됨');
  assert.strictEqual(line, 'M0.0,80.0 L150.0,80.0 L300.0,80.0');
});
test('nwChartPath: 값이 오르면 마지막 y좌표가 첫 y좌표보다 위(작은 값)에 온다', () => {
  const { line } = sandbox.nwChartPath([{ date: '2026-01-01', nw: 0 }, { date: '2026-01-02', nw: 100 }], 300, 80);
  assert.strictEqual(line, 'M0.0,80.0 L300.0,0.0');
});
test('nwChartPath: 날짜 간격이 등간격이면(매일 스냅샷) 기존처럼 x좌표도 등간격이다', () => {
  const { line } = sandbox.nwChartPath([
    { date: '2026-01-01', nw: 0 }, { date: '2026-01-02', nw: 0 }, { date: '2026-01-03', nw: 0 },
  ], 300, 80);
  assert.strictEqual(line, 'M0.0,80.0 L150.0,80.0 L300.0,80.0');
});
test('nwChartPath: 날짜 간격이 불균등하면(일 단위+월 단위 압축 혼재) x좌표가 인덱스가 아니라 날짜 간격에 비례한다', () => {
  const { line } = sandbox.nwChartPath([
    { date: '2026-01-01', nw: 0 }, { date: '2026-01-02', nw: 50 }, { date: '2026-01-31', nw: 100 },
  ], 300, 80);
  const coords = line.split(' ').map(c => c.slice(1).split(',').map(Number));
  assert.notStrictEqual(coords[1][0], 150, '인덱스 기준 등간격(중앙)이 아니어야 함');
  assert.ok(coords[1][0] < 150, '이틀째 점은 30일 구간 중 하루만 지났으므로 중앙보다 훨씬 왼쪽에 있어야 함');
  assert.strictEqual(coords[1][0], +((1 / 30 * 300).toFixed(1)));
});
test('nwChartPath: 날짜가 늘어날수록 x좌표는 단조 비감소이며 daysBetween에 선형 비례한다', () => {
  const pts = [
    { date: '2026-01-01', nw: 10 }, { date: '2026-01-05', nw: 20 },
    { date: '2026-01-06', nw: 30 }, { date: '2026-02-04', nw: 40 },
  ];
  const { line } = sandbox.nwChartPath(pts, 340, 80);
  const xs = line.split(' ').map(c => +c.slice(1).split(',')[0]);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1], '날짜 순서대로 x좌표가 감소하면 안 됨');
  const totalDays = sandbox.daysBetween(pts[0].date, pts[pts.length - 1].date);
  pts.forEach((p, i) => {
    const expected = +((sandbox.daysBetween(pts[0].date, p.date) / totalDays * 340).toFixed(1));
    assert.strictEqual(xs[i], expected);
  });
});

/* ---------- nwHistoryCard: 순자산 추이 카드가 자산 캐러셀의 귀속 전환을 따라가는지 (app-evolve cycle71 critique/advance) ----------
 * nwCarousel은 owner별 순자산을 스와이프로 보여주는데, nwHistoryCard는 항상 DB.nwHistory의 전체
 * 합계(ta/td/nw)만 그려 캐러셀에서 보고 있는 귀속과 무관하게 동일한 추이만 보여주던 불일치를 수정.
 * updateNwHistory가 저장한 byOwner 스냅샷을 owner별로 필터링해 그 귀속만의 추이를 그리도록 한다. */
test('nwHistoryCard: owner를 생략하거나 "all"이면 기존처럼 전체 합계(byOwner 무시) 추이를 그린다', () => {
  sandbox.DB = { nwHistory: [
    { date: '2026-01-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 200, td: 10 } } },
    { date: '2026-01-02', ta: 320, td: 20, nw: 300, byOwner: { 나: { ta: 210, td: 10 } } },
  ] };
  const html = sandbox.nwHistoryCard();
  assert.ok(html.includes('순자산 추이'));
  assert.ok(html.includes('+' + sandbox.comma(20) + '원'), '전체 합계(nw 300-280=20) 증감이 나와야 함 — byOwner 값이 아님');
});
test('nwHistoryCard: owner가 지정되면 그 귀속의 byOwner 스냅샷(ta-td)만으로 추이를 그린다', () => {
  sandbox.DB = { nwHistory: [
    { date: '2026-01-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 200, td: 10 }, 배우자: { ta: 100, td: 10 } } },
    { date: '2026-01-02', ta: 320, td: 20, nw: 300, byOwner: { 나: { ta: 230, td: 10 }, 배우자: { ta: 90, td: 10 } } },
  ] };
  const html = sandbox.nwHistoryCard('나');
  assert.ok(html.includes('순자산 추이'));
  assert.ok(html.includes('+' + sandbox.comma(30) + '원'), '나의 순자산은 190->220으로 30 증가해야 함(전체 합계 20과 달라야 함)');
});
test('nwHistoryCard: 지정한 귀속의 byOwner 스냅샷이 2개 미만이면(막 전환 등) 빈 카드 대신 안내 문구를 보여준다', () => {
  sandbox.DB = { nwHistory: [
    { date: '2026-01-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 200, td: 10 } } },
    { date: '2026-01-02', ta: 320, td: 20, nw: 300 }, // 마이그레이션 이전 항목: byOwner 없음
  ] };
  const html = sandbox.nwHistoryCard('배우자');
  assert.ok(html.includes('이 귀속의 추이는 곧 쌓여요'));
  assert.ok(!html.includes('<svg'), '그릴 점이 부족하면 차트 svg는 렌더되지 않아야 함');
});
test('nwHistoryCard: 스냅샷이 1개 이하면 owner 지정 여부와 무관하게 빈 문자열을 반환한다(기존 동작 유지)', () => {
  sandbox.DB = { nwHistory: [{ date: '2026-01-01', ta: 300, td: 20, nw: 280 }] };
  assert.strictEqual(sandbox.nwHistoryCard('all'), '');
});
/* 차트 svg는 증감/기간이 이미 바로 위 텍스트(nwh-range)로 전부 노출되는 순수 장식용 스파크라인이라,
 * 스크린리더가 unlabeled <svg>를 별도 이미지/문서로 잡아 중복·의미없는 소음을 내지 않도록 보조기술에서
 * 숨겨야 한다(app-evolve cycle119 develop). */
test('nwHistoryCard: 차트 svg는 장식용이라 aria-hidden="true"로 보조기술에서 숨긴다(증감/기간은 이미 옆 텍스트로 노출됨)', () => {
  sandbox.DB = { nwHistory: [
    { date: '2026-01-01', ta: 300, td: 20, nw: 280 },
    { date: '2026-01-02', ta: 320, td: 20, nw: 300 },
  ] };
  const html = sandbox.nwHistoryCard();
  assert.ok(html.includes('<svg'), '점이 2개 이상이면 차트 svg가 렌더돼야 함');
  assert.ok(/<svg[^>]*\baria-hidden="true"/.test(html), 'svg 태그 자체에 aria-hidden="true"가 있어야 함');
});
/* ---------- nwHistoryCard 기간 선택(preset) (app-evolve cycle135 critique/advance) ----------
 * 전엔 항상 최근 60일(hist.slice(-60))만 보여줬는데, 1개월/3개월/1년/전체 세그먼트를 추가해
 * nwHistoryRange(logic.js)로 보이는 구간을 바꿀 수 있게 했다. */
test('nwHistoryCard: preset을 생략하면 기본값 "m3"(최근 90일)로 거른다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = { nwHistory: [
    { date: '2024-01-01', ta: 100, td: 0, nw: 100 }, // 90일보다 훨씬 오래돼 preset 기본값에서 제외돼야 함
    { date: '2026-06-01', ta: 300, td: 20, nw: 280 },
    { date: '2026-06-15', ta: 320, td: 20, nw: 300 },
  ] };
  const html = sandbox.nwHistoryCard();
  assert.ok(html.includes('06/01 ~ 06/15'), '기본 preset(m3)은 90일 이내만 남겨 2024년 스냅샷은 범위 밖이어야 함');
});
test('nwHistoryCard: preset="all"이면 다운샘플링 없이 가장 오래된 스냅샷부터 보여준다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = { nwHistory: [
    { date: '2024-01-01', ta: 100, td: 0, nw: 100 },
    { date: '2026-06-15', ta: 320, td: 20, nw: 300 },
  ] };
  const html = sandbox.nwHistoryCard('all', 'all');
  assert.ok(html.includes('01/01 ~ 06/15'), 'preset="all"이면 2024년 스냅샷도 포함돼야 함');
});
test('nwHistoryCard: 선택한 preset에 맞는 세그먼트 버튼에만 "on" 클래스가 붙는다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = { nwHistory: [
    { date: '2026-06-01', ta: 300, td: 20, nw: 280 },
    { date: '2026-06-15', ta: 320, td: 20, nw: 300 },
  ] };
  const html = sandbox.nwHistoryCard('all', 'y1');
  // 버튼 태그 자체를 파싱해 "on" 클래스가 정확히 preset과 일치하는 버튼에만 붙는지 확인
  const buttons = [...html.matchAll(/<button[^>]*onclick="nwPresetSel\('(\w+)'\)"[^>]*>([^<]+)<\/button>/g)];
  assert.strictEqual(buttons.length, 4, '1개월/3개월/1년/전체 네 개 세그먼트 버튼이 렌더돼야 함');
  buttons.forEach(([full, p]) => {
    const isOn = full.includes('class="on"');
    assert.strictEqual(isOn, p === 'y1', `preset="y1"일 때는 ${p} 버튼의 on 여부가 (${p === 'y1'})이어야 함`);
    // on 클래스와 aria-pressed가 항상 같은 값을 가리켜야 함(스크린리더가 선택 상태를 알 수 없던
    // 공백 — app-evolve cycle147 critique/advance, 세그먼트 컨트롤 9곳에 aria-pressed 추가).
    assert.ok(full.includes(`aria-pressed="${isOn}"`), `${p} 버튼의 aria-pressed가 on 클래스(${isOn})와 일치하지 않음`);
  });
  assert.ok(/<div class="seg nwh-seg" role="group" aria-label="[^"]+">/.test(html), '기간 세그먼트 래퍼에 role="group"/aria-label이 없음');
});
test('nwHistoryCard: 귀속별 추이가 비어있는 빈 상태 카드에도 기간 세그먼트가 함께 렌더된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = { nwHistory: [{ date: '2026-06-15', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 200, td: 10 } } }] };
  const html = sandbox.nwHistoryCard('배우자', 'y1');
  assert.ok(html.includes('이 귀속의 추이는 곧 쌓여요'));
  assert.ok(html.includes("onclick=\"nwPresetSel('y1')\""), '데이터가 없어도 기간을 바꿔볼 수 있는 세그먼트는 보여야 함');
});

/* ---------- 목표(Goals) UI: goalsSummaryCard/openGoalsList/openGoalForm/saveGoal/delGoal (app-evolve cycle122 advance) ---------- */
test('goalsSummaryCard: 목표가 없으면 nwHistoryCard와 같은 원칙으로 아무것도 광고하지 않고 빈 문자열을 반환한다', () => {
  sandbox.DB = { goals: [], nwHistory: [] };
  assert.strictEqual(sandbox.goalsSummaryCard(), '');
});
test('goalsSummaryCard: 목표가 있으면 가장 가까운 목표의 진행률 카드를 보여준다', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '내 집 마련', targetAmount: 1000000, targetDate: null }],
    nwHistory: [{ date: '2026-01-01', nw: 500000 }] };
  sandbox.TODAY = '2026-01-01';
  const html = sandbox.goalsSummaryCard();
  assert.ok(html.includes('내 집 마련'));
  assert.ok(html.includes('50%'));
});
test('openGoalsList: 목표가 없으면 빈 상태 안내를 보여준다', () => {
  sandbox.DB = { goals: [], nwHistory: [] };
  sandbox.lastSheetHtml = null;
  sandbox.openGoalsList();
  assert.ok(sandbox.lastSheetHtml.includes('아직 목표가 없어요'));
});
test('openGoalsList: 목표가 있으면 목표별 진행률·목표일을 목록으로 보여준다', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '비상금 1000만원', targetAmount: 10000000, targetDate: '2026-12-31' }],
    nwHistory: [{ date: '2026-01-01', nw: 2000000 }] };
  sandbox.TODAY = '2026-01-01';
  sandbox.lastSheetHtml = null;
  sandbox.openGoalsList();
  assert.ok(sandbox.lastSheetHtml.includes('비상금 1000만원'));
  assert.ok(sandbox.lastSheetHtml.includes('20%'));
  assert.ok(sandbox.lastSheetHtml.includes(sandbox.fmtDateFull('2026-12-31')), '목표일은 다른 화면들처럼 사람이 읽는 형식으로 보여야 함(app-evolve cycle159 develop)');
  assert.ok(!sandbox.lastSheetHtml.includes('목표일 2026-12-31<'), '목표일이 가공 없이 ISO 원문 그대로 노출되면 안 됨');
});
test('openGoalForm: id 없이 열면 goalDraft가 빈 새 목표로 초기화된다(uid 스텁 경로)', () => {
  sandbox.DB = { goals: [] };
  sandbox.goalDraft = null;
  sandbox.openGoalForm();
  assert.strictEqual(sandbox.goalDraft.id, 'test-uid');
  assert.strictEqual(sandbox.goalDraft.name, '');
  assert.strictEqual(sandbox.goalDraft.targetAmount, 0);
});
test('openGoalForm: id를 넘기면 기존 목표를 복사해 goalDraft로 연다(원본은 수정되지 않음)', () => {
  const g = { id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: '2026-08-01' };
  sandbox.DB = { goals: [g] };
  sandbox.goalDraft = null;
  sandbox.openGoalForm('g1');
  assert.strictEqual(sandbox.goalDraft.name, '여행자금');
  sandbox.goalDraft.name = '변경됨';
  assert.strictEqual(g.name, '여행자금', '원본 DB.goals 항목이 그대로 보존돼야 함');
});
test('saveGoal: 이름이 비어 있으면 저장하지 않고 안내 토스트만 띄운다', () => {
  sandbox.DB = { goals: [] };
  sandbox.goalDraft = { id: 'test-uid', name: '', type: 'networth', targetAmount: 1000000, targetDate: null };
  sandbox.goalNameValue = '   ';
  sandbox.goalAmtValue = '1,000,000';
  sandbox.lastToast = null;
  sandbox.saveGoal(false);
  assert.strictEqual(sandbox.DB.goals.length, 0);
  assert.ok(sandbox.lastToast.includes('이름'));
});
test('saveGoal: 목표 금액이 0이면 저장하지 않고 안내 토스트만 띄운다', () => {
  sandbox.DB = { goals: [] };
  sandbox.goalDraft = { id: 'test-uid', name: '내 집 마련', type: 'networth', targetAmount: 0, targetDate: null };
  sandbox.goalNameValue = '내 집 마련';
  sandbox.goalAmtValue = '';
  sandbox.lastToast = null;
  sandbox.saveGoal(false);
  assert.strictEqual(sandbox.DB.goals.length, 0);
  assert.ok(sandbox.lastToast.includes('금액'));
});
test('saveGoal: 새 목표는 천단위 콤마가 섞인 입력(num() 파서 경로)도 올바르게 저장되고 폼을 닫는다', () => {
  sandbox.DB = { goals: [] };
  sandbox.goalDraft = { id: 'test-uid', name: '', type: 'networth', targetAmount: 0, targetDate: '2026-12-31' };
  sandbox.goalNameValue = '내 집 마련';
  sandbox.goalAmtValue = '1,000,000';
  sandbox.saveGoal(false);
  assert.strictEqual(sandbox.DB.goals.length, 1);
  assert.strictEqual(sandbox.DB.goals[0].name, '내 집 마련');
  assert.strictEqual(sandbox.DB.goals[0].targetAmount, 1000000);
  assert.strictEqual(sandbox.DB.goals[0].targetDate, '2026-12-31');
  assert.strictEqual(sandbox.goalDraft, null, '저장 후 draft는 비워야 함');
});
test('saveGoal: 기존 목표를 수정하면(id 일치) 같은 자리에서 교체되고 새 항목이 추가되지 않는다', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: null }] };
  sandbox.goalDraft = { id: 'g1', name: '', type: 'networth', targetAmount: 0, targetDate: null };
  sandbox.goalNameValue = '여행자금(유럽)';
  sandbox.goalAmtValue = '5,000,000';
  sandbox.saveGoal(true);
  assert.strictEqual(sandbox.DB.goals.length, 1);
  assert.strictEqual(sandbox.DB.goals[0].id, 'g1');
  assert.strictEqual(sandbox.DB.goals[0].name, '여행자금(유럽)');
  assert.strictEqual(sandbox.DB.goals[0].targetAmount, 5000000);
});
test('delGoal: 바로 지우지 않고 확인 시트를 띄우며, 확인해야 DB.goals에서 제거된다', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: null }] };
  sandbox.confirmSheetCalls = [];
  sandbox.delGoal('g1');
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '바로 지우지 않고 확인 시트를 띄워야 함');
  assert.strictEqual(sandbox.DB.goals.length, 1, '확인 전에는 그대로여야 함');
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(sandbox.DB.goals.length, 0);
});
test('delGoal: 존재하지 않는 id를 넘기면 확인 시트조차 띄우지 않는다', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: null }] };
  sandbox.confirmSheetCalls = [];
  sandbox.delGoal('없는id');
  assert.strictEqual(sandbox.confirmSheetCalls.length, 0);
  assert.strictEqual(sandbox.DB.goals.length, 1);
});
/* app-evolve cycle123 critique가 발견한 버그의 회귀 테스트: DB.goals(cycle122 신설)가 saveGoal에
 * touch()가 없어 updatedAt을 안 찍고, delGoal도 DB.deletedIds 톰스톤을 안 남겨 mergeRemoteDataIntoLocal
 * (mergeCollection 기반 3-way 병합)에서 다른 기기의 변경과 충돌 시 조용히 소실/복원될 수 있었다. */
test('saveGoal: 새 목표를 저장하면 touch()로 updatedAt이 찍힌다(mergeCollection이 다른 기기와 병합할 때 승자를 고르는 유일한 근거)', () => {
  sandbox.DB = { goals: [] };
  sandbox.goalDraft = { id: 'test-uid', name: '', type: 'networth', targetAmount: 0, targetDate: null };
  sandbox.goalNameValue = '내 집 마련';
  sandbox.goalAmtValue = '1,000,000';
  sandbox.saveGoal(false);
  assert.strictEqual(sandbox.DB.goals[0].updatedAt, 'test-updatedAt');
});
test('saveGoal: 기존 목표를 수정해도 touch()로 updatedAt이 다시 찍힌다', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: null, updatedAt: 100 }] };
  sandbox.goalDraft = { id: 'g1', name: '', type: 'networth', targetAmount: 0, targetDate: null };
  sandbox.goalNameValue = '여행자금(유럽)';
  sandbox.goalAmtValue = '5,000,000';
  sandbox.saveGoal(true);
  assert.strictEqual(sandbox.DB.goals[0].updatedAt, 'test-updatedAt');
});
test('delGoal: 확인하면 DB.deletedIds에 삭제 시각 톰스톤을 남긴다(deleteTxnsUndo 등과 동일 — 없으면 병합 시 다른 기기가 모르고 되살림)', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: null }], deletedIds: {} };
  sandbox.confirmSheetCalls = [];
  sandbox.delGoal('g1');
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(sandbox.DB.goals.length, 0);
  assert.ok(typeof sandbox.DB.deletedIds.g1 === 'number', 'deletedIds에 숫자 타임스탬프가 남아야 함');
});
test('delGoal: undoToast의 되돌리기를 누르면 목표가 되살아나고(touch()로 updatedAt 재갱신) 톰스톤도 지워진다', () => {
  sandbox.DB = { goals: [{ id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: null, updatedAt: 1 }], deletedIds: {} };
  sandbox.confirmSheetCalls = [];
  sandbox.lastUndo = null;
  sandbox.delGoal('g1');
  sandbox.confirmSheetCalls[0].cb();
  assert.ok(sandbox.lastUndo && typeof sandbox.lastUndo.undoFn === 'function', 'undoToast가 호출되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.goals.length, 1);
  assert.strictEqual(sandbox.DB.goals[0].id, 'g1');
  assert.strictEqual(sandbox.DB.goals[0].updatedAt, 'test-updatedAt', '되살린 레코드는 다시 touch()되어야 mergeCollection에서 안 탈락함');
  assert.strictEqual('g1' in sandbox.DB.deletedIds, false, '되돌리면 톰스톤도 지워져야 함');
});
/* app-evolve cycle124 develop가 발견한 버그의 회귀 테스트: 목표일 지우기(✕) 버튼이 txClearEnd/recClearEnd와
 * 달리 syncGoalInputs()를 안 부르고 바로 goalDraft.targetDate를 지운 뒤 renderGoalForm을 다시 그렸다.
 * renderGoalForm은 입력칸 value를 goalDraft에서 그대로 읽으므로, 이름/금액을 고친 뒤 날짜만 지우면
 * 그 사이 입력한 값이 동기화 전 상태로 되돌려써져 조용히 사라졌다. */
test('goalClearDate: 날짜를 지우기 전에 이름/금액 입력을 먼저 동기화해 사용자가 입력한 값을 보존한다', () => {
  sandbox.goalDraft = { id: 'g1', name: '여행자금', type: 'networth', targetAmount: 3000000, targetDate: '2026-12-31' };
  sandbox.goalNameValue = '여행자금(유럽)';
  sandbox.goalAmtValue = '5,000,000';
  sandbox.goalClearDate(true);
  assert.strictEqual(sandbox.goalDraft.targetDate, '', '목표일은 지워져야 함');
  assert.strictEqual(sandbox.goalDraft.name, '여행자금(유럽)', '지우기 전에 동기화되지 않으면 이 값이 되돌려써짐');
  assert.strictEqual(sandbox.goalDraft.targetAmount, 5000000, '지우기 전에 동기화되지 않으면 이 값이 되돌려써짐');
});

/* ---------- 목표(Goals)에 owner(귀속) 스코프 추가 (app-evolve cycle124 advance) ----------
 * 자산(ST.assetOwner)·순자산추이(nwHistory.byOwner)·지출분석(ST.spendOwner)까지 전부 owner-aware인데
 * DB.goals(cycle122 신설)만 owner가 없어 캐러셀에서 귀속을 바꿔도 목표 카드가 전체 순자산 기준
 * 진행률만 보여주던 불일치를 수정. nwHistoryForOwner(logic.js)를 nwHistoryCard와 공유해 같은 귀속을
 * 보면 같은 숫자를 보도록 한다. */
test('nwHistoryForOwner: owner가 생략되거나 "all"이면 원본 nwHistory를 그대로 돌려준다(가구 전체 집계)', () => {
  const hist = [{ date: '2026-01-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 200, td: 10 } } }];
  assert.strictEqual(sandbox.nwHistoryForOwner(hist, 'all'), hist);
  assert.strictEqual(sandbox.nwHistoryForOwner(hist), hist);
  assert.strictEqual(sandbox.nwHistoryForOwner(null, 'all').length, 0);
});
test('nwHistoryForOwner: owner를 지정하면 그 귀속의 byOwner 스냅샷(ta-td)만 추려 새 배열로 돌려준다', () => {
  const hist = [
    { date: '2026-01-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 200, td: 10 }, 배우자: { ta: 100, td: 10 } } },
    { date: '2026-01-02', ta: 320, td: 20, nw: 300 }, // byOwner 없는(마이그레이션 이전) 항목은 제외
  ];
  const out = sandbox.nwHistoryForOwner(hist, '나');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].nw, 190);
});
test('goalOwnerEff: owner가 없거나 "all"이면 "all"(전체)로 본다', () => {
  sandbox.DB = { owners: ['나', '배우자'] };
  assert.strictEqual(sandbox.goalOwnerEff({}), 'all');
  assert.strictEqual(sandbox.goalOwnerEff({ owner: 'all' }), 'all');
});
test('goalOwnerEff: owner가 지금의 DB.owners에 있으면 그대로, 이미 사라진 귀속명이면 "all"로 간주한다(ST.assetOwner와 동일한 "귀속 사라지면 전체로" 원칙)', () => {
  sandbox.DB = { owners: ['나', '배우자'] };
  assert.strictEqual(sandbox.goalOwnerEff({ owner: '나' }), '나');
  assert.strictEqual(sandbox.goalOwnerEff({ owner: '삭제된귀속' }), 'all');
});
test('goalOwnerEff: DB.owners가 아예 없어도(최소 테스트 DB) 예외 없이 "all"로 처리한다', () => {
  sandbox.DB = {};
  assert.strictEqual(sandbox.goalOwnerEff({ owner: '나' }), 'all');
});
test('openGoalsList: owner가 지정된 목표는 전체 순자산이 아니라 그 귀속만의 byOwner 추이로 진행률을 계산한다(전체 합계와 달라야 함)', () => {
  sandbox.DB = {
    owners: ['나', '배우자'],
    goals: [{ id: 'g1', name: '내 명의 비상금', targetAmount: 200000, targetDate: null, owner: '나' }],
    nwHistory: [{ date: '2026-01-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 100000 + 100, td: 0 }, 배우자: { ta: 180, td: 0 } } }],
  };
  sandbox.TODAY = '2026-01-01';
  sandbox.lastSheetHtml = null;
  sandbox.openGoalsList();
  // 나의 byOwner.ta=100100 → 목표 200000 대비 50%. 전체 합계(ta-td=280)로 계산했다면 0%가 나왔을 것.
  assert.ok(sandbox.lastSheetHtml.includes('50%'), '귀속별 byOwner 추이로 진행률이 계산돼야 함');
  assert.ok(sandbox.lastSheetHtml.includes(' · 나'), '목표가 특정 귀속에 속해 있으면 그 귀속명을 함께 보여줘야 함');
});
test('goalsSummaryCard: owner를 넘기면 그 귀속이 소유한 목표만 보여주고, 다른 귀속의 목표는 보이지 않는다', () => {
  sandbox.DB = {
    owners: ['나', '배우자'],
    goals: [
      { id: 'g1', name: '내 목표', targetAmount: 100000, targetDate: null, owner: '나' },
      { id: 'g2', name: '배우자 목표', targetAmount: 100000, targetDate: null, owner: '배우자' },
    ],
    nwHistory: [],
  };
  sandbox.TODAY = '2026-01-01';
  assert.ok(sandbox.goalsSummaryCard('나').includes('내 목표'));
  assert.ok(!sandbox.goalsSummaryCard('나').includes('배우자 목표'));
  assert.strictEqual(sandbox.goalsSummaryCard('배우자').includes('내 목표'), false);
});
test('goalsSummaryCard: owner를 생략하면(기본 "all") 가구 전체(owner:"all") 목표만 보여주고, 특정 귀속 목표는 숨긴다', () => {
  sandbox.DB = {
    owners: ['나'],
    goals: [{ id: 'g1', name: '내 전용 목표', targetAmount: 100000, targetDate: null, owner: '나' }],
    nwHistory: [],
  };
  sandbox.TODAY = '2026-01-01';
  assert.strictEqual(sandbox.goalsSummaryCard(), '', '전체(all) 보기에는 귀속 전용 목표를 광고하지 않아야 함');
});
test('openGoalForm: 기존 목표의 owner가 이미 사라진 귀속이면 "all"로 보정해서 연다', () => {
  sandbox.DB = { owners: ['나'], goals: [{ id: 'g1', name: '여행자금', owner: '삭제된귀속', targetAmount: 100 }] };
  sandbox.goalDraft = null;
  sandbox.openGoalForm('g1');
  assert.strictEqual(sandbox.goalDraft.owner, 'all');
});
test('openGoalForm: id 없이 새로 열면 owner 기본값은 "all"(가구 공동 목표)이다', () => {
  sandbox.DB = { owners: ['나'], goals: [] };
  sandbox.goalDraft = null;
  sandbox.openGoalForm();
  assert.strictEqual(sandbox.goalDraft.owner, 'all');
});
test('renderGoalForm: 귀속 세그먼트가 goalDraft.owner와 일치하는 버튼에 on 클래스를 준다', () => {
  sandbox.DB = { owners: ['나', '배우자'] };
  sandbox.goalDraft = { id: 'g1', name: '', targetAmount: 0, targetDate: '', owner: '배우자' };
  sandbox.lastSheetHtml = null;
  sandbox.renderGoalForm(true);
  assert.ok(/class="on"[^>]*>배우자/.test(sandbox.lastSheetHtml), '배우자 버튼이 선택 상태여야 함');
  assert.ok(!/class="on"[^>]*>전체/.test(sandbox.lastSheetHtml), '전체 버튼은 선택 상태가 아니어야 함');
  // on 클래스뿐 아니라 aria-pressed도 선택 상태와 일치해야 함(스크린리더가 선택된 귀속을
  // 알 수 없던 공백 — app-evolve cycle147 critique/advance).
  assert.ok(/aria-pressed="true"[^>]*>배우자/.test(sandbox.lastSheetHtml), '배우자 버튼의 aria-pressed가 true가 아님');
  assert.ok(/aria-pressed="false"[^>]*>전체/.test(sandbox.lastSheetHtml), '전체 버튼의 aria-pressed가 false가 아님');
  assert.ok(/role="group" aria-label="귀속 선택"/.test(sandbox.lastSheetHtml), '귀속 세그먼트 래퍼에 role="group"/aria-label이 없음');
});
test('goalOwnerSel: 귀속 버튼을 고르면 입력값을 먼저 동기화한 뒤 goalDraft.owner를 바꾸고 폼을 다시 연다', () => {
  sandbox.DB = { owners: ['나', '배우자'] };
  sandbox.goalDraft = { id: 'g1', name: '', targetAmount: 0, targetDate: '', owner: 'all' };
  sandbox.goalNameValue = '동기화된이름';
  sandbox.goalAmtValue = '';
  sandbox.lastSheetHtml = null;
  sandbox.goalOwnerSel(1, true); // ['all','나','배우자'][1] === '나'
  assert.strictEqual(sandbox.goalDraft.owner, '나');
  assert.strictEqual(sandbox.goalDraft.name, '동기화된이름', 'onclick 순서상 전환 전 입력값이 보존돼야 함');
  assert.ok(sandbox.lastSheetHtml, '폼이 다시 열려야 함');
});
test('saveGoal: 저장 시 goalDraft.owner를 그대로 담고, 지정하지 않았으면 "all"로 저장한다', () => {
  sandbox.DB = { owners: ['나'], goals: [] };
  sandbox.goalDraft = { id: 'test-uid', name: '', type: 'networth', targetAmount: 0, targetDate: null, owner: '나' };
  sandbox.goalNameValue = '내 집 마련';
  sandbox.goalAmtValue = '1,000,000';
  sandbox.saveGoal(false);
  assert.strictEqual(sandbox.DB.goals[0].owner, '나');

  sandbox.DB = { owners: ['나'], goals: [] };
  sandbox.goalDraft = { id: 'test-uid-2', name: '', type: 'networth', targetAmount: 0, targetDate: null };
  sandbox.goalNameValue = '공동 목표';
  sandbox.goalAmtValue = '1,000,000';
  sandbox.saveGoal(false);
  assert.strictEqual(sandbox.DB.goals[0].owner, 'all', 'owner를 지정하지 않으면 전체(가구 공동)로 저장돼야 함');
});
test('doRenameOwner: 이름변경 시 DB.goals의 owner도 함께 옮기고 touch()로 updatedAt을 다시 찍는다(mergeCollection 병합 불변식)', () => {
  sandbox.DB = {
    owners: ['나', '아빠'], assets: [],
    goals: [{ id: 'g1', name: '아빠 전용 목표', owner: '아빠', updatedAt: 1 }, { id: 'g2', name: '내 목표', owner: '나', updatedAt: 1 }],
  };
  sandbox.ST = { assetOwner: '전체', plan: { owner: '전체' }, spendOwner: '전체' };
  const $orig = sandbox.$;
  sandbox.$ = (id) => (id === 'renameOwner' ? { value: '아버지' } : $orig(id));
  try {
    sandbox.doRenameOwner(1);
  } finally {
    sandbox.$ = $orig;
  }
  assert.strictEqual(sandbox.DB.goals[0].owner, '아버지', '옛 이름을 가리키던 목표가 새 이름을 따라가야 함');
  assert.strictEqual(sandbox.DB.goals[0].updatedAt, 'test-updatedAt', 'touch()로 다시 찍혀야 병합 시 이 변경이 보존됨');
  assert.strictEqual(sandbox.DB.goals[1].owner, '나', '무관한 귀속의 목표는 건드리지 않아야 함');
});
test('migrate: owner 필드가 없는 기존 목표(cycle124 이전 생성분)는 "all"로 채워진다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
    goals: [{ id: 'g1', name: '옛 목표', targetAmount: 1000 }],
  };
  sandbox.migrate();
  assert.strictEqual(sandbox.DB.goals[0].owner, 'all');
});
test('sanitizeBackup: 목표의 owner가 이 백업(obj.owners) 기준으로 존재하지 않는 귀속이면 "all"로 clamp하고 fixedCount를 센다', () => {
  const r = sandbox.sanitizeBackup({ txns: [], assets: [], owners: ['나'], goals: [{ id: 'g1', name: '목표', owner: '없는귀속' }] });
  assert.strictEqual(r.data.goals[0].owner, 'all');
  assert.strictEqual(r.fixedCount, 1);
});
test('sanitizeBackup: 목표의 owner가 "all"이거나 obj.owners에 실제로 있으면 그대로 둔다(정상 케이스는 회귀 없음)', () => {
  const r = sandbox.sanitizeBackup({ txns: [], assets: [], owners: ['나'], goals: [
    { id: 'g1', name: '전체목표', owner: 'all' },
    { id: 'g2', name: '내목표', owner: '나' },
  ] });
  assert.strictEqual(r.data.goals[0].owner, 'all');
  assert.strictEqual(r.data.goals[1].owner, '나');
  assert.strictEqual(r.fixedCount, 0);
});
test('sanitizeBackup: 목표에 owner가 없으면(구버전 백업) "all"로 기본값을 채운다', () => {
  const r = sandbox.sanitizeBackup({ txns: [], assets: [], owners: ['나'], goals: [{ id: 'g1', name: '목표' }] });
  assert.strictEqual(r.data.goals[0].owner, 'all');
});
test('sanitizeBackup: 백업에 owners 목록이 없으면 지금 이 기기의 DB.owners를 기준으로 owner를 검증한다', () => {
  sandbox.DB = { owners: ['나'] };
  const r = sandbox.sanitizeBackup({ txns: [], assets: [], goals: [{ id: 'g1', name: '목표', owner: '나' }] });
  assert.strictEqual(r.data.goals[0].owner, '나', 'obj.owners가 없을 때 현재 DB.owners에 있는 이름은 유지돼야 함');
});

/* mergeRemoteDataIntoLocal이 DB.txns/recurrences/assets처럼 DB.goals도 mergeCollection으로
 * 병합하는지 직접 확인 — cycle122가 DB.goals를 신설할 때 이 배선이 누락됐었다(critique cycle123). */
function minimalMergeDB(overrides) {
  return Object.assign({
    txns: [], recurrences: [], assets: [], categories: {}, owners: [],
    budgetHistory: {}, settings: {}, inquiries: [], nwHistory: [], goals: [], assetQtyLog: [], deletedIds: {},
  }, overrides);
}
test('mergeRemoteDataIntoLocal: DB.goals도 다른 컬렉션과 동일하게 mergeCollection으로 병합된다(둘 다 있으면 updatedAt이 더 큰 쪽이 이김)', () => {
  sandbox.DB = minimalMergeDB({
    goals: [
      { id: 'local-only', name: 'local', targetAmount: 1000, updatedAt: 100 },
      { id: 'both', name: 'stale-local', targetAmount: 1000, updatedAt: 100 },
    ],
  });
  sandbox.mergeRemoteDataIntoLocal({
    goals: [
      { id: 'remote-only', name: 'remote', targetAmount: 2000, updatedAt: 100 },
      { id: 'both', name: 'fresh-remote', targetAmount: 3000, updatedAt: 200 },
    ],
    deletedIds: {},
  });
  const byId = Object.fromEntries(sandbox.DB.goals.map(g => [g.id, g]));
  assert.ok(byId['local-only'], 'local에만 있던 목표는 그대로 남아야 함');
  assert.ok(byId['remote-only'], 'remote에만 있던 목표도 들어와야 함');
  assert.strictEqual(byId['both'].name, 'fresh-remote', 'updatedAt이 더 큰 remote 쪽이 이겨야 함');
});
test('mergeRemoteDataIntoLocal: 로컬에서 삭제한(톰스톤) 목표는 원격이 그 이후 수정하지 않았으면 병합 후에도 되살아나지 않는다', () => {
  sandbox.DB = minimalMergeDB({ goals: [], deletedIds: { g1: 200 } });
  sandbox.mergeRemoteDataIntoLocal({
    goals: [{ id: 'g1', name: '여행자금', targetAmount: 1000, updatedAt: 100 }],
    deletedIds: {},
  });
  assert.strictEqual(sandbox.DB.goals.find(g => g.id === 'g1'), undefined, '삭제 이후 원격이 손대지 않은 사본은 되살리면 안 됨');
});

/* ---------- 문의하기(개인 메모): openInquiry/sendInquiry/openInquiryList/delInquiry (app-evolve cycle133 advance)
 * '문의 접수' write-only dead end를 '이 기기에 저장되는 메모'로 재정의하면서 id/touch()/mergeCollection
 * 등록/목록·삭제 화면을 추가했다 — delGoal과 동일한 확인 시트+undoToast+톰스톤 패턴. ---------- */
test('sendInquiry: 내용이 비어 있으면 저장하지 않고 안내 토스트만 띄운다', () => {
  sandbox.DB = { inquiries: [] };
  sandbox.inqTextValue = '   ';
  sandbox.sendInquiry();
  assert.strictEqual(sandbox.DB.inquiries.length, 0);
  assert.strictEqual(sandbox.lastToast, '메모 내용을 입력해 주세요');
});
test('sendInquiry: 저장하면 id와 touch()로 찍은 updatedAt을 채운 레코드가 들어간다(mergeCollection이 다른 기기와 병합할 때 쓰는 유일한 식별자/근거 — 예전엔 둘 다 없어 write-only였고 병합 대상에도 등록될 수 없었음)', () => {
  sandbox.DB = { inquiries: [] };
  sandbox.inqTextValue = '다크모드에 OLED 블랙 옵션도 있으면 좋겠어요';
  sandbox.sendInquiry();
  assert.strictEqual(sandbox.DB.inquiries.length, 1);
  assert.strictEqual(sandbox.DB.inquiries[0].id, 'test-uid');
  assert.strictEqual(sandbox.DB.inquiries[0].updatedAt, 'test-updatedAt');
  assert.strictEqual(sandbox.DB.inquiries[0].text, '다크모드에 OLED 블랙 옵션도 있으면 좋겠어요');
});
test('openInquiryList: 최신(updatedAt이 큰) 메모가 먼저 나오도록 정렬된다', () => {
  sandbox.DB = { inquiries: [
    { id: 'old', text: '오래된메모', updatedAt: 100 },
    { id: 'new', text: '최신메모', updatedAt: 300 },
    { id: 'mid', text: '중간메모', updatedAt: 200 },
  ] };
  sandbox.openInquiryList();
  const html = sandbox.lastSheetHtml;
  assert.ok(html.indexOf('최신메모') < html.indexOf('중간메모'), '최신 메모가 중간 메모보다 먼저 나와야 함');
  assert.ok(html.indexOf('중간메모') < html.indexOf('오래된메모'), '중간 메모가 오래된 메모보다 먼저 나와야 함');
});
test('delInquiry: 바로 지우지 않고 확인 시트를 띄우며, 확인해야 DB.inquiries에서 제거되고 DB.deletedIds에 톰스톤이 남는다', () => {
  sandbox.DB = { inquiries: [{ id: 'q1', text: '메모', updatedAt: 1 }], deletedIds: {} };
  sandbox.confirmSheetCalls = [];
  sandbox.delInquiry('q1');
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '바로 지우지 않고 확인 시트를 띄워야 함');
  assert.strictEqual(sandbox.DB.inquiries.length, 1, '확인 전에는 그대로여야 함');
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(sandbox.DB.inquiries.length, 0);
  assert.ok(typeof sandbox.DB.deletedIds.q1 === 'number', 'deletedIds에 숫자 타임스탬프가 남아야 함');
});
test('delInquiry: 존재하지 않는 id를 넘기면 확인 시트조차 띄우지 않는다', () => {
  sandbox.DB = { inquiries: [{ id: 'q1', text: '메모', updatedAt: 1 }], deletedIds: {} };
  sandbox.confirmSheetCalls = [];
  sandbox.delInquiry('없는id');
  assert.strictEqual(sandbox.confirmSheetCalls.length, 0);
  assert.strictEqual(sandbox.DB.inquiries.length, 1);
});
test('delInquiry: undoToast의 되돌리기를 누르면 메모가 되살아나고(touch()로 updatedAt 재갱신) 톰스톤도 지워진다', () => {
  sandbox.DB = { inquiries: [{ id: 'q1', text: '메모', updatedAt: 1 }], deletedIds: {} };
  sandbox.confirmSheetCalls = [];
  sandbox.lastUndo = null;
  sandbox.delInquiry('q1');
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(sandbox.DB.inquiries.length, 0);
  assert.ok(sandbox.lastUndo, 'undoToast가 호출돼야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.inquiries.length, 1);
  assert.strictEqual(sandbox.DB.inquiries[0].id, 'q1');
  assert.strictEqual(sandbox.DB.inquiries[0].updatedAt, 'test-updatedAt');
  assert.strictEqual(sandbox.DB.deletedIds.q1, undefined, '되돌리면 톰스톤도 지워져야 함');
});

/* mergeRemoteDataIntoLocal이 DB.goals처럼 DB.inquiries도 mergeCollection으로 병합하는지 확인
 * (app-evolve cycle133 critique: id/updatedAt 없이 push만 하던 write-only 구조라 애초에 이 배선에
 * 등록돼 있지 않았음 — goals가 cycle122 신설 당시 겪었던 것과 동일한 버그 클래스). */
test('mergeRemoteDataIntoLocal: DB.inquiries도 다른 컬렉션과 동일하게 mergeCollection으로 병합된다(둘 다 있으면 updatedAt이 더 큰 쪽이 이김)', () => {
  sandbox.DB = minimalMergeDB({
    inquiries: [
      { id: 'local-only', text: 'local', updatedAt: 100 },
      { id: 'both', text: 'stale-local', updatedAt: 100 },
    ],
  });
  sandbox.mergeRemoteDataIntoLocal({
    inquiries: [
      { id: 'remote-only', text: 'remote', updatedAt: 100 },
      { id: 'both', text: 'fresh-remote', updatedAt: 200 },
    ],
    deletedIds: {},
  });
  const byId = Object.fromEntries(sandbox.DB.inquiries.map(q => [q.id, q]));
  assert.ok(byId['local-only'], 'local에만 있던 메모는 그대로 남아야 함');
  assert.ok(byId['remote-only'], 'remote에만 있던 메모도 들어와야 함');
  assert.strictEqual(byId['both'].text, 'fresh-remote', 'updatedAt이 더 큰 remote 쪽이 이겨야 함');
});
test('mergeRemoteDataIntoLocal: 로컬에서 삭제한(톰스톤) 메모는 원격이 그 이후 수정하지 않았으면 병합 후에도 되살아나지 않는다', () => {
  sandbox.DB = minimalMergeDB({ inquiries: [], deletedIds: { q1: 200 } });
  sandbox.mergeRemoteDataIntoLocal({
    inquiries: [{ id: 'q1', text: '불편사항', updatedAt: 100 }],
    deletedIds: {},
  });
  assert.strictEqual(sandbox.DB.inquiries.find(q => q.id === 'q1'), undefined, '삭제 이후 원격이 손대지 않은 사본은 되살리면 안 됨');
});

/* mergeRemoteDataIntoLocal이 DB.goals/DB.inquiries와 동일하게 DB.assetQtyLog도 mergeCollection으로
 * 병합하는지 확인한다(app-evolve cycle138 advance) — 이 버그 클래스(새 최상위 DB 컬렉션을 이 함수에
 * 등록하는 걸 빠뜨림)가 goals(cycle123 critique)/inquiries(cycle137 develop)에 이어 또 반복되지
 * 않도록, 신설 시점에 바로 배선하고 그 증거로 "두 기기가 오프라인에서 각자 독립적으로 수량 변경
 * 기록을 남겨도 한쪽이 소실되지 않는다"를 직접 검증한다. */
test('mergeRemoteDataIntoLocal: DB.assetQtyLog도 다른 컬렉션과 동일하게 mergeCollection으로 병합된다(두 기기가 각자 만든 기록이 소실 없이 합쳐짐)', () => {
  sandbox.DB = minimalMergeDB({
    assetQtyLog: [
      { id: 'local-only', assetId: 'a1', date: '2026-01-01', prevQty: 0, newQty: 10, field: 'stockQty', updatedAt: 100 },
      { id: 'both', assetId: 'a1', date: '2026-01-02', prevQty: 10, newQty: 20, field: 'stockQty', updatedAt: 100 },
    ],
  });
  sandbox.mergeRemoteDataIntoLocal({
    assetQtyLog: [
      { id: 'remote-only', assetId: 'a2', date: '2026-01-03', prevQty: 0, newQty: 5, field: 'goldDon', updatedAt: 100 },
      { id: 'both', assetId: 'a1', date: '2026-01-02', prevQty: 10, newQty: 30, field: 'stockQty', updatedAt: 200 },
    ],
    deletedIds: {},
  });
  const byId = Object.fromEntries(sandbox.DB.assetQtyLog.map(q => [q.id, q]));
  assert.ok(byId['local-only'], '이 기기에서만 만든 기록은 그대로 남아야 함(소실되면 안 됨)');
  assert.ok(byId['remote-only'], '다른 기기에서만 만든 기록도 들어와야 함(소실되면 안 됨)');
  assert.strictEqual(byId['both'].newQty, 30, 'updatedAt이 더 큰 remote 쪽이 이겨야 함');
});
test('mergeRemoteDataIntoLocal: 로컬에서 삭제한(톰스톤) 수량 변경 기록은 원격이 그 이후 수정하지 않았으면 병합 후에도 되살아나지 않는다', () => {
  sandbox.DB = minimalMergeDB({ assetQtyLog: [], deletedIds: { q1: 200 } });
  sandbox.mergeRemoteDataIntoLocal({
    assetQtyLog: [{ id: 'q1', assetId: 'a1', date: '2026-01-01', prevQty: 0, newQty: 10, field: 'stockQty', updatedAt: 100 }],
    deletedIds: {},
  });
  assert.strictEqual(sandbox.DB.assetQtyLog.find(q => q.id === 'q1'), undefined, '삭제 이후 원격이 손대지 않은 사본은 되살리면 안 됨');
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

/* ---------- doExport(csv) 회귀: 잔액 조정(adjust) 항목은 monthStats/histSumTotals 등
 * 다른 모든 집계처럼 항목별 포함 설정(inSurplus)을 따라야 한다(app-evolve cycle83 develop).
 * doExport()는 실제로 filter(t=>!(t.adjust&&!t.inSurplus))를 거친 뒤 txnsToCSV를 호출하므로
 * 그 조합을 그대로 재현해 검증한다. */
test('txnsToCSV+doExport 필터: inSurplus가 꺼진 잔액 조정 항목은 CSV에서 제외된다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const txns = [
    { id: 't1', date: '2026-01-01', type: 'expense', category: '식비', amount: -5000, fromAssetId: 'a1', memo: '점심' },
    { id: 't2', date: '2026-01-02', type: 'income', category: '잔액 조정', amount: 999999, toAssetId: 'a1', memo: '재등록 잔액 조정', adjust: true, adjustAsset: 'a1' },
  ];
  const csv = sandbox.txnsToCSV(txns.filter(t => !(t.adjust && !t.inSurplus)), assets);
  assert.ok(csv.includes('점심'), '일반 거래는 그대로 포함돼야 함');
  assert.ok(!csv.includes('잔액 조정'), 'inSurplus가 꺼진(기본값) 잔액 조정 항목은 제외돼야 함');
});
test('txnsToCSV+doExport 필터: inSurplus를 켠 잔액 조정 항목은 다른 집계와 동일하게 CSV에 포함된다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const txns = [
    { id: 't2', date: '2026-01-02', type: 'income', category: '잔액 조정', amount: 999999, toAssetId: 'a1', memo: '재등록 잔액 조정', adjust: true, adjustAsset: 'a1', inSurplus: true },
  ];
  const csv = sandbox.txnsToCSV(txns.filter(t => !(t.adjust && !t.inSurplus)), assets);
  assert.ok(csv.includes('잔액 조정'), 'inSurplus를 켠 잔액 조정 항목은 monthStats 등과 동일하게 포함돼야 함');
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
// addCat/addOwner/saveAsset(동명 자산 가드, line 3358)는 모두 normName()으로 대소문자·연속 공백·
// 유니코드 정규화(NFC/NFD) 차이를 "같은 이름"으로 본다. CSV findAsset()만 예전엔 String===로
// 엄격 비교해, 엑셀에서 내보내거나 macOS(파일시스템이 NFD로 정규화)에서 만든 CSV를 다시
// 가져올 때 같은 자산인데도 표기만 미세하게 다르면 매칭에 실패해 unmatched로 떨어졌다
// (cycle141에서 "bonus item, out of scope"로 남겨둔 항목 — cycle142에서 수정).
test('csvRowToImportTxn: 대소문자·공백·유니코드 정규화(NFC/NFD) 차이만 있는 자산명도 normName 기준으로 매칭한다', () => {
  const assets = [{ id: 'a1', name: '주 계좌' }];
  const spaced = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '주  계좌', '', ''], assets);
  assert.strictEqual(spaced.ok, true);
  assert.strictEqual(spaced.txn.fromAssetId, 'a1', '연속 공백 차이는 같은 자산으로 매칭되어야 함');
  assert.strictEqual(spaced.txn.fromAssetName, undefined);
  const caseAssets = [{ id: 'a2', name: 'USD Cash' }];
  const cased = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', 'usd cash', '', ''], caseAssets);
  assert.strictEqual(cased.ok, true);
  assert.strictEqual(cased.txn.fromAssetId, 'a2', '대소문자 차이는 같은 자산으로 매칭되어야 함');
  // NFD(자모 분리형)로 들어온 이름도 NFC 저장 자산과 매칭되어야 함(macOS CSV 내보내기 등)
  const nfdAssets = [{ id: 'a3', name: '우리은행'.normalize('NFD') }];
  const nfc = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '우리은행', '', ''], nfdAssets);
  assert.strictEqual(nfc.ok, true);
  assert.strictEqual(nfc.txn.fromAssetId, 'a3', 'NFC/NFD 정규화 차이는 같은 자산으로 매칭되어야 함');
});
// isMarketValued(fx/gold/stock)는 assetEval()이 원장과 무관하게 qty×시세로 평가하므로,
// CSV 임포트가 이름만 보고 매칭해버리면 그 거래가 잔액에 반영되지 않아 순자산이 조용히 어긋난다.
// 수동 입력 폼(txOpenAsset/recOpenAsset)은 이미 excludeMarketValued로 막고 있으니 CSV 경로도 맞춘다.
test('csvRowToImportTxn: 시세평가 자산(fx/gold/stock)과 이름이 같아도 매칭하지 않고 unmatched로 남긴다', () => {
  const assets = [{ id: 's1', name: '삼성전자', type: 'stock' }];
  const exp = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '삼성전자', '', ''], assets);
  assert.strictEqual(exp.ok, true);
  assert.strictEqual(exp.txn.fromAssetId, null);
  assert.strictEqual(exp.txn.fromAssetName, '삼성전자');
  assert.deepStrictEqual(Array.from(exp.unmatched), ['삼성전자']);
  const tr = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '5000', '주계좌', '삼성전자', ''], [{ id: 'a1', name: '주계좌' }, ...assets]);
  assert.strictEqual(tr.ok, true);
  assert.strictEqual(tr.txn.toAssetId, null);
  assert.strictEqual(tr.txn.toAssetName, '삼성전자');
});
// saveAsset()의 중복명 가드는 같은 type끼리만 막아, 서로 다른 type(예: cash/savings)의
// 자산이 같은 이름을 갖는 건 막지 않는다. CSV는 이름만으로 매칭하므로 이런 동명이인이 있으면
// find()가 배열상 첫 번째 자산을 조용히 골라 실제로는 다른 계좌의 거래를 잘못 연결할 수 있다.
// 후보가 2개 이상이면 추측하지 말고 unmatched로 남겨(기존 "못 찾음" 경로 재사용) 사용자가 알게 한다.
test('csvRowToImportTxn: 같은 이름의 자산이 2개 이상이면 추측해서 연결하지 않고 unmatched로 남긴다', () => {
  const assets = [{ id: 'a1', name: '우리은행', type: 'cash' }, { id: 'a2', name: '우리은행', type: 'savings' }];
  const exp = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '우리은행', '', ''], assets);
  assert.strictEqual(exp.ok, true);
  assert.strictEqual(exp.txn.fromAssetId, null);
  assert.strictEqual(exp.txn.fromAssetName, '우리은행');
  assert.deepStrictEqual(Array.from(exp.unmatched), ['우리은행']);
  const tr = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '5000', '주계좌', '우리은행', ''], [{ id: 'a0', name: '주계좌', type: 'cash' }, ...assets]);
  assert.strictEqual(tr.ok, true);
  assert.strictEqual(tr.txn.toAssetId, null);
  assert.strictEqual(tr.txn.toAssetName, '우리은행');
});
// deletedAssetHistoryExists/relinkDeletedAsset — saveAsset()의 "삭제된 동명 자산 재연동" 경로는
// 이름만 비교하고 type을 전혀 검사하지 않았다: 현금 자산을 삭제 후 같은 이름으로 완전히 다른
// type(예: stock)의 자산을 새로 등록하면, 원래 거래의 fromAssetId/toAssetId가 타입이 다른
// 새 자산으로 조용히 옮겨간다. stock 등 시세평가 자산은 assetEval()이 DB.txns를 안 보므로
// 이 재연결이 잔액에 전혀 반영되지 않아 순자산이 조용히 어긋난다. saveAsset의 살아있는 자산
// 중복 체크(dup, type까지 비교)와 CSV findAsset(위 동명이인 테스트)은 이미 타입을 검사하므로,
// 이 삭제->재등록 연동 경로도 snapshotAssetName이 함께 남기는 DB.deletedType으로 타입을 맞춘다.
test('deletedAssetHistoryExists: 삭제된 자산과 type까지 같아야 매칭되고, type이 다르면 매칭하지 않는다', () => {
  sandbox.DB = {
    deletedType: { '카카오뱅크': 'cash' },
    txns: [{ fromAssetId: 'gone', fromAssetName: '카카오뱅크', toAssetId: null }],
    recurrences: [],
    assets: [],
  };
  assert.strictEqual(sandbox.deletedAssetHistoryExists('카카오뱅크', 'cash'), true, 'type이 같으면 매칭되어야 함');
  assert.strictEqual(sandbox.deletedAssetHistoryExists('카카오뱅크', 'stock'), false, 'type이 다르면 매칭되지 않아야 함');
});
test('deletedAssetHistoryExists: DB.deletedType에 기록이 없는(마이그레이션 이전) 데이터는 안전하게 매칭 안 됨 처리한다', () => {
  sandbox.DB = {
    txns: [{ fromAssetId: 'gone', fromAssetName: '카카오뱅크', toAssetId: null }],
    recurrences: [],
    assets: [],
  };
  assert.strictEqual(sandbox.deletedAssetHistoryExists('카카오뱅크', 'cash'), false);
});
test('relinkDeletedAsset: type이 같을 때만 과거 내역을 새 자산에 재연결한다', () => {
  sandbox.DB = {
    deletedType: { '카카오뱅크': 'cash' },
    txns: [{ fromAssetId: 'gone', fromAssetName: '카카오뱅크', toAssetId: null }],
    recurrences: [{ id: 'r1', fromAssetId: 'gone', fromAssetName: '카카오뱅크', toAssetId: null, active: true }],
    assets: [],
  };
  const newCash = { id: 'new1', name: '카카오뱅크', type: 'cash' };
  sandbox.relinkDeletedAsset(newCash);
  assert.strictEqual(sandbox.DB.txns[0].fromAssetId, 'new1', '같은 type이면 거래가 새 자산에 재연결되어야 함');
  assert.strictEqual(sandbox.DB.txns[0].fromAssetName, undefined, '재연결되면 이름 스냅샷은 지워져야 함');
  assert.strictEqual(sandbox.DB.recurrences[0].fromAssetId, 'new1', '같은 type이면 반복거래도 재연결되어야 함');
  // app-evolve cycle143/144: 재연결로 fromAssetId/fromAssetName이 바뀐 레코드는 touch()되어야
  // mergeCollection()이 이 재연결을 다른 기기의 미동기화 사본에게 조용히 되돌리지 않는다.
  assert.strictEqual(sandbox.DB.txns[0].updatedAt, 'test-updatedAt', '재연결된 거래는 touch()로 updatedAt이 갱신되어야 함(mergeCollection 병합 불변식)');
  assert.strictEqual(sandbox.DB.recurrences[0].updatedAt, 'test-updatedAt', '재연결된 반복거래도 touch()로 updatedAt이 갱신되어야 함');
});
test('relinkDeletedAsset: type이 다른 동명 자산으로는 재연결하지 않는다(deletedAssetHistoryExists 가드를 우회한 직접 호출 방어)', () => {
  sandbox.DB = {
    deletedType: { '카카오뱅크': 'cash' },
    txns: [{ fromAssetId: 'gone', fromAssetName: '카카오뱅크', toAssetId: null }],
    recurrences: [],
    assets: [],
  };
  const newStock = { id: 'new1', name: '카카오뱅크', type: 'stock' };
  sandbox.relinkDeletedAsset(newStock);
  assert.strictEqual(sandbox.DB.txns[0].fromAssetId, 'gone', 'type이 다르면 fromAssetId가 그대로여야 함');
  assert.strictEqual(sandbox.DB.txns[0].fromAssetName, '카카오뱅크', 'type이 다르면 이름 스냅샷도 지워지지 않아야 함');
  assert.strictEqual(sandbox.DB.txns[0].updatedAt, undefined, '재연결이 아예 일어나지 않았으면 touch()도 호출되면 안 됨');
});
test('relinkDeletedAsset: DB.deletedType 기록이 없으면(마이그레이션 이전 데이터) 재연결하지 않는다', () => {
  sandbox.DB = {
    txns: [{ fromAssetId: 'gone', fromAssetName: '카카오뱅크', toAssetId: null }],
    recurrences: [],
    assets: [],
  };
  const newCash = { id: 'new1', name: '카카오뱅크', type: 'cash' };
  sandbox.relinkDeletedAsset(newCash);
  assert.strictEqual(sandbox.DB.txns[0].fromAssetId, 'gone');
});
// askRelinkDeleted 자체는 saveAsset()의 재연동 분기 테스트(아래)가 스파이 스텁(sandbox.askRelinkDeleted)에
// 의존하고 있어(FUNCTIONS로 실제 구현을 끌어오면 그 스텁을 덮어써 해당 테스트가 깨짐) 여기선 단위 테스트를
// 추가하지 않는다 — index.html의 _amLink/_amFresh 내부 DB.assets.push(d) 두 곳에 touch(d)를 적용한 것은
// 다른 자동 생성 경로(doMaturity 등)와 동일한 기계적 패턴이라 코드 리뷰로 충분히 검증 가능하다고 판단.
// 다만 _amLink 안의 잔액 연동 산술(remembered/H/gap)은 이 화면 전용 기계적 배선이 아니라 실질적인
// 화폐 계산이라, DB/클로저 의존 없는 순수 함수 computeRelinkBaseline으로 뽑아 아래에서 직접 검증한다
// (별개 심볼이라 sandbox.askRelinkDeleted 스텁과 충돌하지 않음, app-evolve cycle96).
// snapshotAssetName() 자체는 balanceAt 등 잔액 계산 체인 전체를 끌고 와 이 파일에서 스텁으로
// 대체돼 있어(위 sandbox.snapshotAssetName 참고) 직접 실행 테스트는 못 하지만, deletedType을
// deletedBal과 나란히 남기지 않으면 위의 relinkDeletedAsset 가드가 항상 false가 되어 재연동
// 기능 자체가 조용히 죽어버리므로, 소스 텍스트 수준에서 그 대입이 빠지지 않았는지 가드한다.
test('computeRelinkBaseline: remembered(삭제 시점 잔액)가 있으면 그 값으로 기준을 이어간다', () => {
  // 삭제 시점 잔액 10000, 재연결된 과거 내역만의 현재 잔액(H) 3000 → base=10000-3000=7000
  const out = sandbox.computeRelinkBaseline(10000, 3000, 10000);
  assert.strictEqual(out.base, 7000);
  assert.strictEqual(out.gap, 0, 'entered가 remembered와 같으면 갭 없음');
});
test('computeRelinkBaseline: DB.deletedBal 결측 시 호출부가 remembered로 H를 넘기면 base가 0이 된다', () => {
  // askRelinkDeleted()는 DB.deletedBal[d.name]이 없으면 remembered에 H를 그대로 넘긴다 —
  // 그 폴백 자체는 호출부 책임이고, 이 함수는 remembered===H일 때 base=0을 보장하기만 하면 된다.
  const out = sandbox.computeRelinkBaseline(3000, 3000, 5000);
  assert.strictEqual(out.base, 0);
  assert.strictEqual(out.gap, 2000);
});
test('computeRelinkBaseline: entered가 remembered보다 크면 양수 갭(입금 조정)', () => {
  const out = sandbox.computeRelinkBaseline(10000, 4000, 12000);
  assert.strictEqual(out.base, 6000);
  assert.strictEqual(out.gap, 2000);
});
test('computeRelinkBaseline: entered가 remembered보다 작으면 음수 갭(출금 조정)', () => {
  const out = sandbox.computeRelinkBaseline(10000, 4000, 7000);
  assert.strictEqual(out.base, 6000);
  assert.strictEqual(out.gap, -3000);
});
test('computeRelinkBaseline: 소수점은 반올림된다(base/gap 각각 독립적으로)', () => {
  const out = sandbox.computeRelinkBaseline(10000.5, 3000.4, 10000.5);
  assert.strictEqual(out.base, 7000, 'Math.round(10000.5-3000.4)=Math.round(7000.1)=7000');
  assert.strictEqual(out.gap, 0);
});
test('computeRelinkBaseline: debt 타입도 호출부(addBalanceAdjust)가 부호를 해석하므로 이 함수 자체는 부호 규약과 무관하게 산술만 한다', () => {
  // addBalanceAdjust(asset,gap)이 asset.type==='debt'일 때 gap<0을 입금으로 해석하는 부호 규약을 갖고
  // 있지만, computeRelinkBaseline은 asset을 아예 받지 않는 순수 산술이라 타입에 무관하게 같은 결과를 낸다.
  const out = sandbox.computeRelinkBaseline(-5000, -8000, -5000);
  assert.strictEqual(out.base, 3000);
  assert.strictEqual(out.gap, 0);
});
test('snapshotAssetName: 삭제 시점 잔액(deletedBal)과 나란히 자산 type(deletedType)도 기록한다', () => {
  const body = extractFunction('snapshotAssetName');
  assert.ok(/DB\.deletedType\s*=\s*DB\.deletedType\s*\|\|\s*\{\}/.test(body), 'DB.deletedType 초기화가 빠짐');
  assert.ok(/DB\.deletedType\[nm\]\s*=\s*a\.type/.test(body), 'DB.deletedType[nm]=a.type 대입이 빠짐');
});
test('saveAsset: 새 자산 등록 시 삭제된 동명 자산의 type까지 같아야 재연동 시트를 띄운다', () => {
  sandbox.DB = {
    settings: {},
    assets: [],
    deletedType: { '카카오뱅크': 'cash' },
    txns: [{ fromAssetId: 'gone', fromAssetName: '카카오뱅크', toAssetId: null }],
    recurrences: [],
    rates: { fx: {}, stocks: {} },
  };
  sandbox.asDraft = { type: 'cash', name: '카카오뱅크', baseAmount: 0 };
  sandbox.lastAskRelinkDeletedArg = null;
  sandbox.saveAsset();
  assert.ok(sandbox.lastAskRelinkDeletedArg, 'type이 같으면 askRelinkDeleted(재연동 시트)가 호출되어야 함');
  assert.strictEqual(sandbox.lastAskRelinkDeletedArg.name, '카카오뱅크');
  assert.strictEqual(sandbox.DB.assets.length, 0, '재연동 시트가 뜨면 아직 자산이 등록되지 않아야 함(사용자 선택 대기)');

  sandbox.DB.assets = [];
  sandbox.asDraft = { type: 'stock', name: '카카오뱅크', stockCode: 'S1', stockQty: 10 };
  sandbox.lastAskRelinkDeletedArg = null;
  sandbox.saveAsset();
  assert.strictEqual(sandbox.lastAskRelinkDeletedArg, null, 'type이 다르면 askRelinkDeleted가 호출되지 않고 바로 새 자산으로 등록되어야 함');
  assert.strictEqual(sandbox.DB.assets.length, 1, '재연동 시트를 안 거치면 saveAsset()이 바로 새 자산을 등록해야 함');
  assert.strictEqual(sandbox.DB.assets[0].name, '카카오뱅크');
  assert.strictEqual(sandbox.DB.assets[0].type, 'stock');
  assert.strictEqual(sandbox.DB.txns[0].fromAssetId, 'gone', 'type이 다르므로 기존 거래는 재연결되지 않고 그대로여야 함');
});
test('csvRowToImportTxn: 이체/저축인데 보내는·받는 자산 중 하나라도 비어 있으면 무효 처리한다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const r1 = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '10000', '주계좌', '', ''], assets);
  assert.strictEqual(r1.ok, false);
  const r2 = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '10000', '주계좌', '적금통장', ''], assets);
  assert.strictEqual(r2.ok, true);
});
// saveTx/saveRec(수동 입력)은 지출/수입에 보내는·받는 자산이 비어 있으면 toast로 막고 저장을 거부하는데
// (app-evolve cycle81), CSV 임포트는 이 가드가 없어 보내는/받는 자산 칸이 비어도 fromAssetId/toAssetId가
// null인 채 이름 스냅샷도 없이(findAsset('')이 null을 반환하고 unmatched.push도 fromName이 falsy라 건너뜀)
// 그대로 통과했다 — buildImportPreview의 assetUnmatchedCount에도 안 잡혀 사용자가 알 방법이 없는 채
// 잔액에 영영 반영 안 되는 지출/수입이 조용히 저장되는 버그.
test('csvRowToImportTxn: 지출인데 보내는 자산이 비어 있으면 무효 처리한다(수입은 받는 자산)', () => {
  const exp = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '', '', ''], []);
  assert.strictEqual(exp.ok, false);
  assert.strictEqual(exp.error, 'asset');
  const inc = sandbox.csvRowToImportTxn(['2026-01-01', '수입', '급여', '5000', '', '', ''], []);
  assert.strictEqual(inc.ok, false);
  assert.strictEqual(inc.error, 'asset');
});
test('csvRowToImportTxn: 지출/수입인데 자산 이름이 있지만 매칭 안 되면(unmatched) 이름 스냅샷으로 여전히 허용한다', () => {
  const exp = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000', '없는통장', '', ''], []);
  assert.strictEqual(exp.ok, true);
  assert.strictEqual(exp.txn.fromAssetName, '없는통장');
  const inc = sandbox.csvRowToImportTxn(['2026-01-01', '수입', '급여', '5000', '', '없는통장', ''], []);
  assert.strictEqual(inc.ok, true);
  assert.strictEqual(inc.txn.toAssetName, '없는통장');
});
// 수동 입력(saveTx/saveRec)은 fromAssetId===toAssetId일 때 toast로 막고 저장을 거부하는데,
// CSV 임포트에는 같은 가드가 없어 보내는/받는 자산이 같은 이체·저축 행이 그대로 들어올 수 있었다.
test('csvRowToImportTxn: 이체/저축인데 보내는·받는 자산 이름이 같으면 무효 처리한다', () => {
  const assets = [{ id: 'a1', name: '주계좌' }];
  const same = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '10000', '주계좌', '주계좌', ''], assets);
  assert.strictEqual(same.ok, false);
  assert.strictEqual(same.error, 'asset');
  const sameSaving = sandbox.csvRowToImportTxn(['2026-01-01', '저축', '저축', '10000', '주계좌', '주계좌', ''], assets);
  assert.strictEqual(sameSaving.ok, false);
  assert.strictEqual(sameSaving.error, 'asset');
});
// 위 테스트는 fromName/toName 문자열이 글자 그대로 같은 경우만 다룬다. findAsset()은(line 3130
// 테스트처럼) 연속 공백·대소문자·NFC/NFD 차이를 normName()으로 같은 자산으로 매칭하므로, 두 셀의
// 문자열이 "다르지만" 같은 자산 하나를 가리키면 과거엔 이 가드를 통과해 fromAssetId===toAssetId인
// 자기 자신 이체가 그대로 저장됐다(app-evolve cycle164 develop에서 수정).
test('csvRowToImportTxn: 이체/저축인데 보내는·받는 자산 이름이 문자열은 달라도 normName 기준으로 같은 자산이면 무효 처리한다', () => {
  const assets = [{ id: 'a1', name: '주 계좌' }];
  const spaced = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '10000', '주  계좌', '주 계좌', ''], assets);
  assert.strictEqual(spaced.ok, false);
  assert.strictEqual(spaced.error, 'asset');
  const spacedSaving = sandbox.csvRowToImportTxn(['2026-01-01', '저축', '저축', '10000', '주  계좌', '주 계좌', ''], assets);
  assert.strictEqual(spacedSaving.ok, false);
  assert.strictEqual(spacedSaving.error, 'asset');
  // 대소문자 차이(한글엔 적용되지 않으므로 영문 자산명으로 별도 확인)
  const enAssets = [{ id: 'a2', name: 'USD Cash' }];
  const casedEn = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '10000', 'USD Cash', 'usd cash', ''], enAssets);
  assert.strictEqual(casedEn.ok, false);
  assert.strictEqual(casedEn.error, 'asset');
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
// amount는 항상 크기(magnitude)이고 부호는 type/fromAssetId/toAssetId로만 표현하는 게 앱 전체 관례
// (sanitizeBackup의 SANITIZE_QTY_FIELDS 참고) — CSV 임포트만 예외로 음수를 허용하면
// balancesUpTo()가 부호를 그대로 빼면서 거래 방향이 조용히 뒤집히는 데이터 결함이 생긴다.
test('csvRowToImportTxn: 음수 금액은 지출/이체/저축 어느 타입이든 무효 처리한다', () => {
  const assets = [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }];
  const exp = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '-5000', '', '', ''], []);
  assert.strictEqual(exp.ok, false); assert.strictEqual(exp.error, 'amount');
  const tr = sandbox.csvRowToImportTxn(['2026-01-01', '이체', '이체', '-5000', 'A', 'B', ''], assets);
  assert.strictEqual(tr.ok, false); assert.strictEqual(tr.error, 'amount');
  const sav = sandbox.csvRowToImportTxn(['2026-01-01', '저축', '저축', '-5000', 'A', 'B', ''], assets);
  assert.strictEqual(sav.ok, false); assert.strictEqual(sav.error, 'amount');
});
// num()으로 입력하는 다른 모든 경로(거래/반복거래 폼)는 [^0-9]를 걷어내 amount가 항상 정수인 게
// 앱 전체 관례(원 단위는 소수가 없음). CSV만 이 검증을 거치지 않고 Number()로 바로 파싱해
// 15000.5 같은 소수 금액이 그대로 통과하면 balancesUpTo() 잔액에 영구히 소수 잔여가 남는다.
test('csvRowToImportTxn: 소수 금액은 무효 처리하고, 정수로 떨어지는 소수 표기(예: 5000.0)는 허용한다', () => {
  const frac = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '15000.5', '', '', ''], []);
  assert.strictEqual(frac.ok, false); assert.strictEqual(frac.error, 'amount');
  const whole = sandbox.csvRowToImportTxn(['2026-01-01', '지출', '식비', '5000.0', '주계좌', '', ''], []);
  assert.strictEqual(whole.ok, true);
  assert.strictEqual(whole.txn.amount, 5000);
});
// RANGE_FROM(2023-01-01) 이전 날짜는 balancesUpTo 등 allTxns(RANGE_FROM,*) 기반 집계에서
// 조용히 빠지므로, 형식은 유효해도 별도의 'range' 에러로 구분해 걸러낸다(형식 오류 'date'와 다름).
test("csvRowToImportTxn: RANGE_FROM 이전 날짜는 형식은 유효해도 error:'range'로 걸러진다", () => {
  const r = sandbox.csvRowToImportTxn(['2022-12-31', '지출', '식비', '1000', '', '', ''], []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'range');
  const ok = sandbox.csvRowToImportTxn(['2023-01-01', '지출', '식비', '1000', '주계좌', '', ''], []);
  assert.strictEqual(ok.ok, true, 'RANGE_FROM 당일은 하한선에 포함되어야 함');
});
// app-evolve cycle120 advance: RANGE_TO(상한)는 RANGE_FROM(하한)과 대칭으로 검증되지 않던
// 경계버그 — dateAboveRangeCeil() 신설 후 csvRowToImportTxn에도 동일하게 적용했는지 확인한다.
test("csvRowToImportTxn: RANGE_TO 이후 날짜는 형식은 유효해도 error:'range'로 걸러진다", () => {
  sandbox.RANGE_TO = '2028-06-15';
  const r = sandbox.csvRowToImportTxn(['2028-06-16', '지출', '식비', '1000', '', '', ''], []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'range');
  const ok = sandbox.csvRowToImportTxn(['2028-06-15', '지출', '식비', '1000', '주계좌', '', ''], []);
  assert.strictEqual(ok.ok, true, 'RANGE_TO 당일은 상한선에 포함되어야 함');
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
  const txns = [{ id: 't1', date: '2026-01-01', type: 'expense', category: '식비', amount: 5000, fromAssetId: 'a1', toAssetId: null, memo: '점심' }];
  const csv = sandbox.txnsToCSV(txns, assets);
  const preview = sandbox.buildImportPreview(csv, assets, { expense: ['식비'], income: [], saving: [] }, txns);
  assert.strictEqual(preview.totalRows, 1);
  assert.strictEqual(preview.newCount, 0);
  assert.strictEqual(preview.dupCount, 1);
});
test('buildImportPreview: 음수 금액 행은 형식 오류와 같은 invalidCount로 잡히고 새 항목으로 세지 않는다', () => {
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2026-01-01,지출,식비,-5000,,,점심\r\n';
  const preview = sandbox.buildImportPreview(csv, [], { expense: ['식비'], income: [], saving: [] }, []);
  assert.strictEqual(preview.totalRows, 1);
  assert.strictEqual(preview.invalidCount, 1);
  assert.strictEqual(preview.newCount, 0);
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
test('buildImportPreview: 기존 내역에 없으면 같은 파일 안에 완전히 똑같은 행이 반복돼도 전부 새 항목으로 센다(같은 날 같은 금액의 서로 다른 거래 2건)', () => {
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2026-01-01,지출,식비,5000,주계좌,,점심\r\n2026-01-01,지출,식비,5000,주계좌,,점심\r\n';
  const preview = sandbox.buildImportPreview(csv, [], { expense: ['식비'], income: [], saving: [] }, []);
  assert.strictEqual(preview.newCount, 2);
  assert.strictEqual(preview.dupCount, 0);
});
test('buildImportPreview: 기존 내역에 키가 같은 게 1건만 있으면, CSV에 똑같은 행이 2개 있어도 1건만 중복 매칭되고 나머지 1건은 새 항목이다(다대다 중복판정)', () => {
  const txns = [{ id: 't1', date: '2026-01-01', type: 'expense', category: '식비', amount: 5000, fromAssetId: null, toAssetId: null, fromAssetName: '주계좌', memo: '점심' }];
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2026-01-01,지출,식비,5000,주계좌,,점심\r\n2026-01-01,지출,식비,5000,주계좌,,점심\r\n';
  const preview = sandbox.buildImportPreview(csv, [], { expense: ['식비'], income: [], saving: [] }, txns);
  assert.strictEqual(preview.newCount, 1);
  assert.strictEqual(preview.dupCount, 1);
});
/* ---------- doCsvImport: 일괄 저장되는 거래에도 touch()로 updatedAt 스탬프
 * (app-evolve cycle88 advance, doMaturity/addBalanceAdjust 쪽과 동일 목적) ---------- */
test('doCsvImport: window._csvImport.items로 일괄 저장하는 거래마다 touch()가 호출된다', () => {
  sandbox.DB = { categories: { expense: [], income: [], saving: [] }, txns: [] };
  sandbox.window._csvImport = {
    items: [
      { dup: false, txn: { type: 'expense', category: '식비', memo: '점심', amount: 5000, date: '2026-01-01', fromAssetId: null, toAssetId: null } },
      { dup: true, txn: { type: 'expense', category: '식비', memo: '중복', amount: 3000, date: '2026-01-01', fromAssetId: null, toAssetId: null } },
    ],
    newCats: { expense: [], income: [], saving: [] },
  };
  sandbox.doCsvImport();
  assert.strictEqual(sandbox.DB.txns.length, 1, '중복(dup) 행은 저장되면 안 됨');
  assert.strictEqual(sandbox.DB.txns[0].updatedAt, 'test-updatedAt', '가져온 거래에도 touch()가 호출되어야 함');
});
/* saveTx()는 새 이체를 저장할 때 confirmed가 비어 있으면 !(confirmTransfers&&isFuture(date))로
 * 기본값을 채우는데(app-evolve cycle81 이전부터의 규칙), CSV는 이 컬럼이 없어(txnsToCSV 헤더에
 * confirmed가 없음) csvRowToImportTxn이 만든 txn에는 confirmed가 항상 undefined로 들어왔다.
 * isPending()은 t.confirmed===false일 때만 미확인으로 보므로, confirmTransfers가 켜진 상태에서
 * 미래 날짜 이체를 CSV로 가져오면 수동 입력(saveTx)과 달리 확인 과정 없이 조용히 '확인 완료'로
 * 저장되고, 이체 확인 홈 알림/가계부 확인 버튼에도 영영 나타나지 않았다. */
test('doCsvImport: confirmTransfers가 켜져 있으면 미래 날짜 이체는 saveTx()와 동일하게 confirmed:false(미확인)로 들어온다', () => {
  sandbox.DB = { categories: { expense: [], income: [], saving: [] }, txns: [], settings: { confirmTransfers: true } };
  sandbox.TODAY = '2026-06-15';
  sandbox.window._csvImport = {
    items: [
      { dup: false, txn: { type: 'transfer', category: '이체', memo: '', amount: 50000, date: '2026-06-20', fromAssetId: 'a1', toAssetId: 'a2' } },
    ],
    newCats: { expense: [], income: [], saving: [] },
  };
  sandbox.doCsvImport();
  assert.strictEqual(sandbox.DB.txns[0].confirmed, false, 'confirmTransfers가 켜진 상태의 미래 이체는 미확인으로 들어와야 함');
});
test('doCsvImport: confirmTransfers가 켜져 있어도 오늘/과거 날짜 이체는 saveTx()와 동일하게 confirmed:true로 들어온다', () => {
  sandbox.DB = { categories: { expense: [], income: [], saving: [] }, txns: [], settings: { confirmTransfers: true } };
  sandbox.TODAY = '2026-06-15';
  sandbox.window._csvImport = {
    items: [
      { dup: false, txn: { type: 'transfer', category: '이체', memo: '', amount: 10000, date: '2026-06-10', fromAssetId: 'a1', toAssetId: 'a2' } },
      { dup: false, txn: { type: 'transfer', category: '이체', memo: '', amount: 20000, date: '2026-06-15', fromAssetId: 'a1', toAssetId: 'a2' } },
    ],
    newCats: { expense: [], income: [], saving: [] },
  };
  sandbox.doCsvImport();
  assert.strictEqual(sandbox.DB.txns[0].confirmed, true, '과거 날짜 이체는 이미 끝난 일로 보고 확인 완료로 들어와야 함');
  assert.strictEqual(sandbox.DB.txns[1].confirmed, true, '오늘 날짜 이체도 확인 완료로 들어와야 함');
});
test('doCsvImport: confirmTransfers가 꺼져 있으면 이체 날짜와 무관하게 confirmed:true로 들어온다', () => {
  sandbox.DB = { categories: { expense: [], income: [], saving: [] }, txns: [], settings: { confirmTransfers: false } };
  sandbox.TODAY = '2026-06-15';
  sandbox.window._csvImport = {
    items: [
      { dup: false, txn: { type: 'transfer', category: '이체', memo: '', amount: 50000, date: '2026-06-20', fromAssetId: 'a1', toAssetId: 'a2' } },
    ],
    newCats: { expense: [], income: [], saving: [] },
  };
  sandbox.doCsvImport();
  assert.strictEqual(sandbox.DB.txns[0].confirmed, true, '이체 확인 기능 자체가 꺼져 있으면 항상 확인 완료여야 함');
});
test("buildImportPreview: RANGE_FROM 이전 날짜 행은 형식 오류(invalidCount)와 구분해 rangeCount로 센다", () => {
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2022-12-31,지출,식비,5000,,,오래된 내역\r\n' +
    'bad-row,지출,식비,abc,,,\r\n' +
    '2026-01-01,지출,식비,5000,주계좌,,정상 내역\r\n';
  const preview = sandbox.buildImportPreview(csv, [], { expense: ['식비'], income: [], saving: [] }, []);
  assert.strictEqual(preview.totalRows, 3);
  assert.strictEqual(preview.rangeCount, 1);
  assert.strictEqual(preview.invalidCount, 1, '형식 오류 카운트는 range 행을 포함하지 않아야 함');
  assert.strictEqual(preview.newCount, 1);
});
// app-evolve cycle120 advance: RANGE_TO 이후 날짜도 RANGE_FROM 이전과 동일하게 rangeCount로 센다.
test("buildImportPreview: RANGE_TO 이후 날짜 행도 형식 오류(invalidCount)와 구분해 rangeCount로 센다", () => {
  sandbox.RANGE_TO = '2028-06-15';
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2028-06-16,지출,식비,5000,,,먼 미래 내역\r\n' +
    'bad-row,지출,식비,abc,,,\r\n' +
    '2026-01-01,지출,식비,5000,주계좌,,정상 내역\r\n';
  const preview = sandbox.buildImportPreview(csv, [], { expense: ['식비'], income: [], saving: [] }, []);
  assert.strictEqual(preview.totalRows, 3);
  assert.strictEqual(preview.rangeCount, 1);
  assert.strictEqual(preview.invalidCount, 1, '형식 오류 카운트는 range 행을 포함하지 않아야 함');
  assert.strictEqual(preview.newCount, 1);
});
/* ---------- buildImportPreview/doCsvImport: CSV 카테고리도 addCat/renameCatSheet와 같은
 * normName() 근접중복 판정을 따라야 한다(app-evolve cycle95 develop) ---------- */
test('buildImportPreview: 기존 카테고리의 앞뒤 공백·대소문자 변형은 새 카테고리로 세지 않고 기존 표기로 맞춘다', () => {
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2026-01-01,지출,식비 ,5000,주계좌,,뒤 공백\r\n' +
    '2026-01-01,지출, 식비,3000,주계좌,,앞 공백\r\n' +
    '2026-01-01,지출,RENT,2000,주계좌,,대문자\r\n';
  const preview = sandbox.buildImportPreview(csv, [{ id: 'a1', name: '주계좌' }], { expense: ['식비', 'Rent'], income: [], saving: [] }, []);
  assert.strictEqual(preview.newCats.expense.length, 0, '기존 카테고리의 공백/대소문자 변형은 신규 카테고리로 세면 안 됨');
  assert.strictEqual(preview.items[0].txn.category, '식비', '가져온 내역의 카테고리도 기존 표기로 맞춰져야 함');
  assert.strictEqual(preview.items[1].txn.category, '식비');
  assert.strictEqual(preview.items[2].txn.category, 'Rent');
});
test('buildImportPreview: 정말 새 카테고리인데 같은 파일 안에 공백 변형이 여러 번 나오면 하나로만 합쳐서 신규 생성한다', () => {
  const csv = '날짜,구분,카테고리,금액,보내는 자산,받는 자산,메모\r\n' +
    '2026-01-01,지출,새카테고리,5000,주계좌,,\r\n' +
    '2026-01-01,지출,새카테고리 ,3000,주계좌,,\r\n';
  const preview = sandbox.buildImportPreview(csv, [{ id: 'a1', name: '주계좌' }], { expense: [], income: [], saving: [] }, []);
  assert.deepStrictEqual(Array.from(preview.newCats.expense), ['새카테고리'], '같은 파일 안의 변형끼리도 첫 표기로 합쳐져 하나만 신규 생성돼야 함');
  assert.strictEqual(preview.items[0].txn.category, '새카테고리');
  assert.strictEqual(preview.items[1].txn.category, '새카테고리');
});
test('doCsvImport: newCats에 기존 카테고리의 공백/대소문자 변형이 섞여 있어도 DB.categories에 중복 추가하지 않는다', () => {
  sandbox.DB = { categories: { expense: ['Rent'], income: [], saving: [] }, txns: [] };
  sandbox.window._csvImport = {
    items: [
      { dup: false, txn: { type: 'expense', category: 'rent ', memo: '', amount: 1000, date: '2026-01-01', fromAssetId: null, toAssetId: null } },
    ],
    newCats: { expense: ['rent '], income: [], saving: [] },
  };
  sandbox.doCsvImport();
  assert.deepStrictEqual(sandbox.DB.categories.expense, ['Rent'], '기존 카테고리와 근접중복이면 DB.categories에 추가되면 안 됨');
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
test('matchTxnQuery: 금액으로도 검색할 수 있다(쉼표 없이 입력)', () => {
  const t = { memo: '', category: '식비', amount: 50000, fromAssetId: null, toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, '50000', []), true);
});
test('matchTxnQuery: 검색어에 쉼표가 있어도("50,000") 쉼표 없는 금액과 매칭된다', () => {
  const t = { memo: '', category: '식비', amount: 50000, fromAssetId: null, toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, '50,000', []), true);
});
test('matchTxnQuery: 금액의 일부 숫자만 넣어도 부분일치로 찾을 수 있다(기존 텍스트 검색과 동일한 includes 규칙)', () => {
  const t = { memo: '', category: '식비', amount: 123456, fromAssetId: null, toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, '2345', []), true);
});
test('matchTxnQuery: 금액이 일치하지 않고 메모/카테고리/자산명에도 없으면 매칭되지 않는다', () => {
  const t = { memo: '점심', category: '식비', amount: 12000, fromAssetId: null, toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, '99999', []), false);
});
test('matchTxnQuery: 메모에 실제 쉼표가 들어있어도 쉼표를 사이에 둔 글자들이 이어 붙어 오탐되지 않는다', () => {
  const t = { memo: '우유,계란', category: '식비', amount: 3000, fromAssetId: null, toAssetId: null };
  assert.strictEqual(sandbox.matchTxnQuery(t, '유계', []), false);
});

/* ---------- matchesAssetId: 자산 행 '내역' 버튼(openAssetHistory)이 쓰는 계좌 필터 ---------- */
test('matchesAssetId: assetId가 없으면(전체) 항상 매칭된다', () => {
  const t = { fromAssetId: 'a1', toAssetId: null };
  assert.strictEqual(sandbox.matchesAssetId(t, null), true);
  assert.strictEqual(sandbox.matchesAssetId(t, ''), true);
});
test('matchesAssetId: fromAssetId가 일치하면 매칭된다', () => {
  const t = { fromAssetId: 'a1', toAssetId: null };
  assert.strictEqual(sandbox.matchesAssetId(t, 'a1'), true);
});
test('matchesAssetId: toAssetId가 일치하면 매칭된다(이체 받는 쪽)', () => {
  const t = { fromAssetId: 'a1', toAssetId: 'a2' };
  assert.strictEqual(sandbox.matchesAssetId(t, 'a2'), true);
});
test('matchesAssetId: fromAssetId/toAssetId 둘 다 불일치하면 매칭되지 않는다', () => {
  const t = { fromAssetId: 'a1', toAssetId: 'a2' };
  assert.strictEqual(sandbox.matchesAssetId(t, 'a3'), false);
});

/* ---------- filteredHist: ST.hist.catExact(+owner) — 지출 분석 카테고리 행에서 전체내역으로
 * drill-down(openCatHistory, app-evolve cycle131 advance)할 때 쓰는 필터. H.cat(TYPEBYLABEL)은
 * 거래유형(수입/지출/이체/저축)만 거르고 카테고리명 자체는 못 거르므로, 별도 필드로 추가했다.
 * spendByCategory()와 동일하게 지출(expense)만 대상으로 고정해야 다른 유형의 동일 카테고리명과
 * 안 섞인다(예: '생활' 지출 카테고리와 같은 이름의 저축 목적). */
test('filteredHist: catExact는 지출(expense)만, 카테고리명이 정확히 일치하는 것만 매칭한다', () => {
  setupHistoryDB();
  sandbox.DB.txns = [
    { id: 't1', date: '2026-06-01', type: 'expense', category: '식비', amount: 1000 },
    { id: 't2', date: '2026-06-02', type: 'expense', category: '교통', amount: 2000 },
    { id: 't3', date: '2026-06-03', type: 'saving', category: '식비', amount: 3000 }, // 유형이 다른 동일 카테고리명
  ];
  sandbox.ST.hist.catExact = '식비';
  const list = sandbox.filteredHist();
  assert.deepStrictEqual(list.map((t) => t.id), ['t1'], 'expense+카테고리명이 정확히 일치하는 것만 남아야 함');
});
test('filteredHist: catExact가 비어있으면(null) 평소처럼 걸러지지 않는다', () => {
  setupHistoryDB();
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-01', type: 'expense', category: '식비', amount: 1000 }];
  assert.strictEqual(sandbox.filteredHist().length, 1);
});
test('filteredHist: owner는 filterTxnsByOwner()와 동일 규칙으로 걸러진다(catExact와 조합)', () => {
  setupHistoryDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '내 카드', owner: '나' },
    { id: 'a2', name: '배우자 카드', owner: '배우자' },
  ];
  sandbox.DB.txns = [
    { id: 't1', date: '2026-06-01', type: 'expense', category: '식비', amount: 1000, fromAssetId: 'a1' },
    { id: 't2', date: '2026-06-02', type: 'expense', category: '식비', amount: 2000, fromAssetId: 'a2' },
  ];
  sandbox.ST.hist.catExact = '식비';
  sandbox.ST.hist.owner = '나';
  assert.deepStrictEqual(sandbox.filteredHist().map((t) => t.id), ['t1'], '해당 귀속의 거래만 남아야 함');
  sandbox.ST.hist.owner = '전체';
  sandbox.histInvalidate();
  assert.deepStrictEqual(sandbox.filteredHist().map((t) => t.id), ['t1', 't2'], "owner가 '전체'면 귀속 필터가 없어야 함");
});

/* ---------- openCatHistory/openAssetHistory: 지출 분석/자산 행의 '내역' 버튼이 ST.hist(+ST.ledger
 * 기준 범위)를 올바르게 세팅하고 화면만 전환하는지(go 호출) 검증 (app-evolve cycle131 advance) ---------- */
test('openCatHistory: ST.ledger 월 기준 범위로 좁히고 ST.spendOwner를 귀속 필터로 반영하며, 다른 필터는 리셋한다', () => {
  setupHistoryDB();
  sandbox.goCalls = [];
  sandbox.ST.spendOwner = '나';
  sandbox.ST.ledger = { y: 2026, m: 5 };
  sandbox.ST.hist.assetId = 'a1'; sandbox.ST.hist.cat = '지출'; sandbox.ST.hist.q = 'abc';
  sandbox.DB.budgetHistory = null;
  sandbox.DB.assets = [{ id: 'a1', name: '내 카드', owner: '나' }];
  sandbox.DB.txns = [{ id: 't1', date: '2026-05-10', type: 'expense', category: '교통', amount: 5000, fromAssetId: 'a1' }];
  sandbox.openCatHistory(0); // spendByCategory(2026,5,'나')의 유일한 행(교통)
  assert.strictEqual(sandbox.ST.hist.catExact, '교통');
  assert.strictEqual(sandbox.ST.hist.owner, '나');
  assert.strictEqual(sandbox.ST.hist.cat, '전체', '거래유형 필터는 리셋돼야 함');
  assert.strictEqual(sandbox.ST.hist.q, '', '검색어는 리셋돼야 함');
  assert.strictEqual(sandbox.ST.hist.assetId, null, '계좌 필터는 리셋돼야 함');
  // ST.hist.range={from,to}는 openCatHistory() 내부(vm 컨텍스트)에서 새로 만든 객체 리터럴이라
  // 테스트 파일(메인 realm)의 리터럴과 deepStrictEqual로 비교하면 내용이 같아도 프로토타입이 달라
  // "same structure but not reference-equal"로 실패한다 — 필드별로 비교한다.
  assert.strictEqual(sandbox.ST.hist.range.from, '2026-05-01', '지출 분석이 보던 달로 범위가 좁혀져야 함(from)');
  assert.strictEqual(sandbox.ST.hist.range.to, '2026-05-31', '지출 분석이 보던 달로 범위가 좁혀져야 함(to)');
  assert.deepStrictEqual(sandbox.goCalls, ['history'], "화면만 전체내역 탭으로 전환해야 함(go('history'))");
});
test('openCatHistory: idx가 가리키는 행이 없으면(삭제/재정렬 등) 아무 것도 바꾸지 않는다', () => {
  setupHistoryDB();
  sandbox.goCalls = [];
  sandbox.ST.spendOwner = '전체';
  sandbox.ST.ledger = { y: 2026, m: 5 };
  sandbox.DB.txns = [];
  sandbox.openCatHistory(0);
  assert.strictEqual(sandbox.ST.hist.catExact, null);
  assert.deepStrictEqual(sandbox.goCalls, [], 'go()가 호출되지 않아야 함');
});
test('openAssetHistory: catExact/owner 필터도 함께 리셋한다(openCatHistory 이후 재진입 대비)', () => {
  setupHistoryDB();
  sandbox.goCalls = [];
  sandbox.ST.hist.catExact = '식비'; sandbox.ST.hist.owner = '나';
  sandbox.openAssetHistory('a1');
  assert.strictEqual(sandbox.ST.hist.assetId, 'a1');
  assert.strictEqual(sandbox.ST.hist.catExact, null);
  assert.strictEqual(sandbox.ST.hist.owner, '전체');
  assert.deepStrictEqual(sandbox.goCalls, ['history']);
});

/* ---------- openAssetHistory가 fx/gold/stock에선 전체내역 대신 수량 변경 기록(openAssetQtyLog)으로
 * 가고, 그 시트의 delAssetQtyLog가 delGoal/delInquiry와 동일한 확인+undoToast+톰스톤 패턴을
 * 따르는지 확인한다(app-evolve cycle138 advance). openAssetPicker(excludeMarketValued:true)가
 * 이 자산들을 거래의 from/to로 영원히 못 쓰게 막아 matchesAssetId()가 항상 빈 목록을 돌려주므로,
 * '내역 보기' 버튼이 그대로였다면 영구히 빈 화면이었다. ---------- */
test('openAssetHistory: fx/gold/stock(시가평가) 자산은 전체내역 탭 대신 수량 변경 기록 시트를 연다', () => {
  sandbox.DB = { assets: [{ id: 'mv1', type: 'stock', name: '삼성전자', stockCode: '005930', stockQty: 10 }], assetQtyLog: [] };
  sandbox.goCalls = [];
  sandbox.lastSheetHtml = null;
  sandbox.openAssetHistory('mv1');
  assert.deepStrictEqual(sandbox.goCalls, [], "전체내역 탭으로 가면 안 됨(go('history')가 불리면 안 됨)");
  assert.ok(sandbox.lastSheetHtml && sandbox.lastSheetHtml.includes('삼성전자'), '수량 변경 기록 시트가 열려야 함');
});
test('openAssetQtyLog: 날짜·부호 있는 변화량을 보여주고, 최신(updatedAt이 큰) 기록이 먼저 나온다', () => {
  sandbox.DB = {
    assets: [{ id: 'a1', type: 'fx', name: '달러통장', currency: 'USD' }],
    assetQtyLog: [
      { id: 'q1', assetId: 'a1', date: '2026-01-01', prevQty: 100, newQty: 150, field: 'fxAmount', updatedAt: 100 },
      { id: 'q2', assetId: 'a1', date: '2026-02-01', prevQty: 150, newQty: 120, field: 'fxAmount', updatedAt: 200 },
    ],
  };
  sandbox.openAssetQtyLog('a1');
  const html = sandbox.lastSheetHtml;
  assert.ok(html.includes('달러통장'));
  assert.ok(html.indexOf('-30') < html.indexOf('+50'), '최신 기록(q2, -30)이 더 오래된 기록(q1, +50)보다 먼저 나와야 함');
});
test('delAssetQtyLog: 바로 지우지 않고 확인 시트를 띄우며, 확인해야 DB.assetQtyLog에서 제거되고 DB.deletedIds에 톰스톤이 남는다', () => {
  sandbox.DB = { assets: [{ id: 'a1', type: 'stock', name: '삼성전자', stockCode: '005930', stockQty: 10 }],
    assetQtyLog: [{ id: 'q1', assetId: 'a1', date: '2026-01-01', prevQty: 5, newQty: 10, field: 'stockQty', updatedAt: 1 }], deletedIds: {} };
  sandbox.confirmSheetCalls = [];
  sandbox.delAssetQtyLog('q1');
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '바로 지우지 않고 확인 시트를 띄워야 함');
  assert.strictEqual(sandbox.DB.assetQtyLog.length, 1, '확인 전에는 그대로여야 함');
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(sandbox.DB.assetQtyLog.length, 0);
  assert.ok(typeof sandbox.DB.deletedIds.q1 === 'number', 'deletedIds에 숫자 타임스탬프가 남아야 함');
});
test('delAssetQtyLog: undoToast의 되돌리기를 누르면 기록이 되살아나고(touch()로 updatedAt 재갱신) 톰스톤도 지워진다', () => {
  sandbox.DB = { assets: [{ id: 'a1', type: 'stock', name: '삼성전자', stockCode: '005930', stockQty: 10 }],
    assetQtyLog: [{ id: 'q1', assetId: 'a1', date: '2026-01-01', prevQty: 5, newQty: 10, field: 'stockQty', updatedAt: 1 }], deletedIds: {} };
  sandbox.confirmSheetCalls = [];
  sandbox.lastUndo = null;
  sandbox.delAssetQtyLog('q1');
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(sandbox.DB.assetQtyLog.length, 0);
  assert.ok(sandbox.lastUndo, 'undoToast가 호출돼야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.assetQtyLog.length, 1);
  assert.strictEqual(sandbox.DB.assetQtyLog[0].id, 'q1');
  assert.strictEqual(sandbox.DB.assetQtyLog[0].updatedAt, 'test-updatedAt');
  assert.strictEqual(sandbox.DB.deletedIds.q1, undefined, '되돌리면 톰스톤도 지워져야 함');
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

/* ---------- lastDay/monthStartStr/monthEndStr/budgetKey: cycle111에서 index.html→logic.js로 옮겨진 뒤
 * 개별 회귀 테스트가 한 번도 없었다(FUNCTIONS 목록 위 주석에만 이름이 언급됨) — recDates/budgetForMonth 등이
 * 내부에서 호출해 간접적으로만 실행돼 왔을 뿐, 이 네 함수 자체를 직접 겨냥한 assert는 없었다.
 * budgetForMonth()는 budgetKey(y,m)로 만든 "YYYY-MM" 문자열을 사전식(lexicographic) 비교(from<=key)로
 * 시점 순서를 판정하므로, 월을 반드시 두 자리로 0-패딩해야만 그 비교가 실제 시간 순서와 일치한다
 * (패딩이 빠지면 "2025-9" > "2025-10"이 돼 9월 예산이 10월보다 미래로 잘못 판정된다) — 아래 순서
 * 비교 테스트가 바로 그 불변식을 지킨다. */
test('lastDay: 평년 2월은 28일, 윤년 2월은 29일까지', () => {
  assert.strictEqual(sandbox.lastDay(2026, 2), 28);
  assert.strictEqual(sandbox.lastDay(2024, 2), 29);
});
test('lastDay: 30일/31일 달을 정확히 구분한다', () => {
  assert.strictEqual(sandbox.lastDay(2026, 4), 30);
  assert.strictEqual(sandbox.lastDay(2026, 1), 31);
  assert.strictEqual(sandbox.lastDay(2026, 12), 31);
});
test('monthStartStr: 항상 그 달 1일이고 월은 두 자리로 0-패딩된다', () => {
  assert.strictEqual(sandbox.monthStartStr(2026, 3), '2026-03-01');
  assert.strictEqual(sandbox.monthStartStr(2026, 11), '2026-11-01');
});
test('monthEndStr: 그 달의 마지막 날(윤년 2월 포함)로 끝난다', () => {
  assert.strictEqual(sandbox.monthEndStr(2026, 2), '2026-02-28');
  assert.strictEqual(sandbox.monthEndStr(2024, 2), '2024-02-29');
  assert.strictEqual(sandbox.monthEndStr(2026, 4), '2026-04-30');
});
test('budgetKey: "YYYY-MM" 형식이고 월이 한 자리여도 0-패딩된다', () => {
  assert.strictEqual(sandbox.budgetKey(2026, 3), '2026-03');
  assert.strictEqual(sandbox.budgetKey(2026, 11), '2026-11');
});
test('budgetKey: 0-패딩 덕분에 사전식 비교가 실제 월 순서와 일치한다(budgetForMonth가 기대는 불변식)', () => {
  assert.ok(sandbox.budgetKey(2025, 9) < sandbox.budgetKey(2025, 10), '9월이 10월보다 사전식으로도 앞서야 함');
  assert.ok(sandbox.budgetKey(2025, 12) < sandbox.budgetKey(2026, 1), '연도가 바뀌어도 순서가 유지돼야 함');
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
test('deleteTxnsUndo: 삭제 시 DB.deletedIds에 시각을 남기고, undo하면 정확히 지운다(app-evolve cycle89)', () => {
  sandbox.TWi = -1;
  const t1 = { id: 'x1', amount: 1000 };
  const t2 = { id: 'x2', amount: 500 };
  sandbox.DB = { txns: [t1, t2] };
  sandbox.lastUndo = null;
  const before = Date.now();
  sandbox.deleteTxnsUndo(new Set(['x1', 'x2']));
  assert.ok(typeof sandbox.DB.deletedIds.x1 === 'number' && sandbox.DB.deletedIds.x1 >= before, 'x1에 삭제 시각이 기록되어야 함');
  assert.ok(typeof sandbox.DB.deletedIds.x2 === 'number' && sandbox.DB.deletedIds.x2 >= before, 'x2에도 삭제 시각이 기록되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.deletedIds.x1, undefined, '되돌리면 x1의 툼스톤이 지워져야 함');
  assert.strictEqual(sandbox.DB.deletedIds.x2, undefined, '되돌리면 x2의 툼스톤도 지워져야 함');
  sandbox.TWi = -1;
});
test('deleteTxnsUndo: undo로 되살린 내역에는 touch()가 호출되어 updatedAt이 갱신된다(app-evolve cycle94, mergeCollection이 살아난 레코드를 병합에서 탈락시키지 않게 함)', () => {
  sandbox.TWi = -1;
  const t1 = { id: 'x1', amount: 1000, updatedAt: 1 };
  const other = { id: 'x2', amount: 500, updatedAt: 1 };
  sandbox.DB = { txns: [t1, other] };
  sandbox.lastUndo = null;
  sandbox.deleteTxnsUndo(new Set(['x1']));
  sandbox.lastUndo.undoFn();
  const restored = sandbox.DB.txns.find(t => t.id === 'x1');
  assert.strictEqual(restored.updatedAt, 'test-updatedAt', '되살린 내역에는 touch()가 호출되어야 함');
  assert.strictEqual(other.updatedAt, 1, '무관한 내역은 그대로 유지되어야 함');
  sandbox.TWi = -1;
});
test('deleteTxnsUndo: 튜토리얼 모드에서 막히면 deletedIds도 전혀 건드리지 않는다(app-evolve cycle89)', () => {
  sandbox.TWi = 0;
  const t = { id: 'x1', amount: 1000 };
  sandbox.DB = { txns: [t] };
  sandbox.deleteTxnsUndo(new Set(['x1']));
  assert.strictEqual(sandbox.DB.deletedIds, undefined, '삭제가 막히면 deletedIds가 아예 생기지 않아야 함');
  sandbox.TWi = -1;
});

/* ---------- bulkCatTargets(logic.js)/doBulkCat/bulkCatPickFor: 선택 모드(일별거래/전체내역)
   일괄 카테고리 변경 (app-evolve cycle136 advance — activeSel()/updateSelBottom()이 전체선택/닫기/
   삭제 3개뿐이라 일괄 카테고리 변경 경로가 없던 공백 해소) ---------- */
// vm 컨텍스트에서 만든 객체 리터럴은 메인 realm 리터럴과 deepStrictEqual 비교 시 "same
// structure but not reference-equal"로 실패한다(cycle131에서 처음 발견한 realm 경계 문제와
// 동일) — 필드별 strictEqual로 비교한다.
test('bulkCatTargets: 선택이 비었으면 reason:empty', () => {
  const txns = [{ id: 'a', type: 'expense', category: '식비' }];
  const r = sandbox.bulkCatTargets(txns, new Set());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty');
});
test('bulkCatTargets: ids가 실제 거래와 하나도 안 맞아도 reason:empty', () => {
  const txns = [{ id: 'a', type: 'expense', category: '식비' }];
  const r = sandbox.bulkCatTargets(txns, new Set(['없는id']));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty');
});
test('bulkCatTargets: 선택에 이체가 하나라도 섞이면 reason:transfer(이체는 카테고리 개념이 없음)', () => {
  const txns = [
    { id: 'a', type: 'expense', category: '식비' },
    { id: 'b', type: 'transfer' },
  ];
  const r = sandbox.bulkCatTargets(txns, new Set(['a', 'b']));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'transfer');
});
test('bulkCatTargets: 선택한 거래들의 종류(expense/income/saving)가 섞이면 reason:mixed', () => {
  const txns = [
    { id: 'a', type: 'expense', category: '식비' },
    { id: 'b', type: 'income', category: '급여' },
  ];
  const r = sandbox.bulkCatTargets(txns, new Set(['a', 'b']));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'mixed');
});
test('bulkCatTargets: 같은 종류끼리만 선택하면 ok:true로 해당 거래들을 돌려준다', () => {
  const a = { id: 'a', type: 'expense', category: '식비' };
  const b = { id: 'b', type: 'expense', category: '교통' };
  const c = { id: 'c', type: 'expense', category: '기타' }; // 선택 안 됨
  const r = sandbox.bulkCatTargets([a, b, c], new Set(['a', 'b']));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'expense');
  assert.deepStrictEqual(r.items, [a, b], '선택되지 않은 거래는 포함되지 않아야 함');
});

test('doBulkCat: 선택한 거래들의 카테고리를 바꾸고, 메모가 이전 카테고리명과 같았다면(자동 채움) 메모도 함께 옮긴다', () => {
  sandbox.TWi = -1;
  const t1 = { id: 'x1', type: 'expense', category: '식비', memo: '식비', updatedAt: 1 };
  const t2 = { id: 'x2', type: 'expense', category: '식비', memo: '편의점 간식', updatedAt: 1 }; // 메모를 직접 입력한 경우
  sandbox.DB = { txns: [t1, t2] };
  sandbox.lastUndo = null;
  sandbox.doBulkCat(new Set(['x1', 'x2']), '외식');
  assert.strictEqual(t1.category, '외식');
  assert.strictEqual(t1.memo, '외식', '메모가 카테고리명과 같았던 경우(자동 채움)엔 메모도 같이 이동해야 함');
  assert.strictEqual(t2.category, '외식');
  assert.strictEqual(t2.memo, '편의점 간식', '사용자가 직접 입력한 메모는 그대로 유지돼야 함');
  assert.strictEqual(t1.updatedAt, 'test-updatedAt', 'touchSave로 touch()가 호출되어야 함(mergeCollection 동기화 불변식)');
  assert.ok(sandbox.lastUndo, 'undoToast가 호출되어야 함');
});
test('doBulkCat: undo 콜백을 부르면 카테고리/메모를 정확히 원복한다', () => {
  sandbox.TWi = -1;
  const t1 = { id: 'x1', type: 'expense', category: '식비', memo: '식비', updatedAt: 1 };
  sandbox.DB = { txns: [t1] };
  sandbox.lastUndo = null;
  sandbox.doBulkCat(new Set(['x1']), '외식');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(t1.category, '식비', '되돌리면 카테고리가 원래대로 복원되어야 함');
  assert.strictEqual(t1.memo, '식비', '되돌리면 메모도 원래대로 복원되어야 함');
});
test('doBulkCat: 튜토리얼 모드 중에는 twGuard가 막아서 실제로 바뀌지 않는다', () => {
  sandbox.TWi = 0;
  const t1 = { id: 'x1', type: 'expense', category: '식비' };
  sandbox.DB = { txns: [t1] };
  sandbox.doBulkCat(new Set(['x1']), '외식');
  assert.strictEqual(t1.category, '식비');
  sandbox.TWi = -1;
});
test('doBulkCat: bulkCatTargets이 실패(이체 포함/혼합/빈 선택)로 판정하면 아무 것도 바꾸지 않는다(bulkCatPickFor가 먼저 걸러내므로 여기선 안전망)', () => {
  sandbox.TWi = -1;
  const t1 = { id: 'x1', type: 'transfer' };
  sandbox.DB = { txns: [t1] };
  sandbox.lastUndo = null;
  sandbox.doBulkCat(new Set(['x1']), '외식');
  assert.strictEqual(t1.category, undefined, '이체는 category 자체가 없으니 손대면 안 됨');
  assert.strictEqual(sandbox.lastUndo, null, 'undoToast도 호출되지 않아야 함');
});

test('bulkCatPickFor: 선택이 비어 있으면 안내 토스트만 띄우고 카테고리 피커를 열지 않는다', () => {
  sandbox.DB = { txns: [] };
  sandbox.lastPickerHtml = null;
  sandbox.toastCalls = [];
  sandbox.bulkCatPickFor(new Set(), () => {});
  assert.strictEqual(sandbox.lastToast, '선택된 내역이 없어요');
  assert.strictEqual(sandbox.lastPickerHtml, null, '피커를 열지 않아야 함');
});
test('bulkCatPickFor: 선택에 이체가 섞여 있으면 이체 전용 안내를 띄우고 피커를 열지 않는다', () => {
  sandbox.DB = { txns: [{ id: 'a', type: 'transfer' }] };
  sandbox.lastPickerHtml = null;
  sandbox.bulkCatPickFor(new Set(['a']), () => {});
  assert.strictEqual(sandbox.lastToast, '이체 내역은 카테고리를 바꿀 수 없어요');
  assert.strictEqual(sandbox.lastPickerHtml, null);
});
test('bulkCatPickFor: 선택한 거래들의 종류가 섞여 있으면 안내를 띄우고 피커를 열지 않는다', () => {
  sandbox.DB = { txns: [{ id: 'a', type: 'expense', category: '식비' }, { id: 'b', type: 'income', category: '급여' }] };
  sandbox.lastPickerHtml = null;
  sandbox.bulkCatPickFor(new Set(['a', 'b']), () => {});
  assert.strictEqual(sandbox.lastToast, '같은 종류의 내역만 한번에 바꿀 수 있어요');
  assert.strictEqual(sandbox.lastPickerHtml, null);
});
test('bulkCatPickFor: 유효한 선택이면 해당 종류의 카테고리 피커를 열고, 고르면 적용→시트 닫기→afterApply까지 이어진다', () => {
  sandbox.TWi = -1;
  const t1 = { id: 'x1', type: 'expense', category: '식비', memo: '식비', updatedAt: 1 };
  sandbox.DB = { txns: [t1], categories: { expense: ['식비', '외식', '교통'] } };
  sandbox.lastPickerHtml = null;
  sandbox.closeSheetCalls = 0;
  sandbox.lastUndo = null;
  let afterApplyCalled = false;
  sandbox.bulkCatPickFor(new Set(['x1']), () => { afterApplyCalled = true; });
  assert.ok(sandbox.lastPickerHtml, '카테고리 피커(openCatPicker)가 열려야 함');
  assert.strictEqual(typeof sandbox.window._pkPick, 'function', 'onPick 콜백이 피커에 전달되어야 함');
  sandbox.window._pkPick('외식'); // 사용자가 피커에서 '외식'을 고른 상황을 흉내냄
  assert.strictEqual(t1.category, '외식', '고른 카테고리가 실제로 적용되어야 함');
  assert.strictEqual(sandbox.closeSheetCalls, 1, '되돌아갈 이전 시트가 없는 단독 피커이므로 onPick이 직접 closeSheet를 불러야 함');
  assert.ok(afterApplyCalled, 'afterApply(선택모드 종료)가 호출되어야 함');
  assert.ok(sandbox.lastUndo, 'doBulkCat의 undoToast까지 그대로 이어져야 함');
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
test('deleteRecsUndo: 삭제 시 DB.deletedIds에 시각을 남기고, undo하면 정확히 지운다(app-evolve cycle89)', () => {
  sandbox.TWi = -1;
  const rec = { id: 'r1', category: '식비', amount: 1000 };
  sandbox.DB = { recurrences: [rec] };
  sandbox.lastUndo = null;
  const before = Date.now();
  sandbox.deleteRecsUndo(new Set(['r1']));
  assert.ok(typeof sandbox.DB.deletedIds.r1 === 'number' && sandbox.DB.deletedIds.r1 >= before, 'r1에 삭제 시각이 기록되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.deletedIds.r1, undefined, '되돌리면 r1의 툼스톤이 지워져야 함');
  sandbox.TWi = -1;
});
test('deleteRecsUndo: undo로 되살린 반복에는 touch()가 호출되어 updatedAt이 갱신된다(app-evolve cycle94)', () => {
  sandbox.TWi = -1;
  const rec = { id: 'r1', category: '식비', amount: 1000, updatedAt: 1 };
  sandbox.DB = { recurrences: [rec] };
  sandbox.lastUndo = null;
  sandbox.deleteRecsUndo(new Set(['r1']));
  sandbox.lastUndo.undoFn();
  const restored = sandbox.DB.recurrences.find(r => r.id === 'r1');
  assert.strictEqual(restored.updatedAt, 'test-updatedAt', '되살린 반복에는 touch()가 호출되어야 함');
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
  const rec = { id: 'r1', active: true, fromAssetId: 'a1', toAssetId: null, updatedAt: 1 };
  sandbox.DB = { assets: [a1], recurrences: [rec] };
  sandbox.lastUndo = null;
  sandbox.snapshotCalls = [];
  sandbox.deleteAssetsUndo(new Set(['a1']));
  assert.strictEqual(rec.active, false, '연결된 반복거래는 비활성화되어야 함');
  assert.strictEqual(rec.updatedAt, 'test-updatedAt', '비활성화된 반복거래는 touch()되어야 함 (클라우드 동기화 시 되돌아가지 않도록)');
  rec.updatedAt = 1;
  sandbox.lastUndo.undoFn();
  assert.strictEqual(rec.active, true, '되돌리면 반복거래도 다시 활성화되어야 함');
  assert.strictEqual(rec.updatedAt, 'test-updatedAt', '되돌릴 때도 touch()되어야 함');
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
test('deleteAssetsUndo: undo 콜백이 snapshotAssetName이 남긴 fromAssetName/toAssetName을 지워 id/name 이중상태를 없앤다(app-evolve cycle79)', () => {
  sandbox.TWi = -1;
  const a1 = { id: 'a1', name: '통장1' };
  // 실제 snapshotAssetName은 스텁으로 대체돼 있으므로(위 sandbox.snapshotAssetName 참고),
  // delAsset()이 삭제 직전에 이미 남겨뒀을 상태를 그대로 흉내내 미리 세팅해둔다.
  const t = { date: '2026-01-01', type: 'expense', amount: 1000, category: '', memo: '',
    fromAssetId: 'a1', fromAssetName: '통장1', toAssetId: null };
  sandbox.DB = { assets: [a1], recurrences: [], txns: [t] };
  sandbox.lastUndo = null;
  sandbox.snapshotCalls = [];
  sandbox.deleteAssetsUndo(new Set(['a1']));
  sandbox.lastUndo.undoFn();
  assert.strictEqual(t.fromAssetName, undefined, 'undo 후에는 fromAssetId가 다시 살아있는 자산을 가리키므로 스냅샷 이름이 남아있으면 안 됨');
  // app-evolve cycle143/144: unsnapshotAssetName이 fromAssetName을 지우면서 touch()도 호출해야
  // mergeCollection()이 이 되돌림을 다른 기기의 미동기화 사본에게 조용히 되돌리지 않는다.
  assert.strictEqual(t.updatedAt, 'test-updatedAt', '스냅샷 이름이 지워진 거래는 touch()로 updatedAt이 갱신되어야 함(mergeCollection 병합 불변식)');
  const sameTxnRebuiltFromId = { ...t, fromAssetName: undefined };
  assert.strictEqual(
    sandbox.csvDedupeKey(t), sandbox.csvDedupeKey(sameTxnRebuiltFromId),
    'undo 후에는 id 기반 키로 비교되어야 CSV 재가져오기 시 같은 거래로 인식됨(수정 전에는 n:통장1 키가 남아 i:a1 키인 새 파싱 결과와 영원히 어긋나 중복 저장됐음)',
  );
});
test('deleteAssetsUndo: 삭제 시 DB.deletedIds에 시각을 남기고, undo하면 정확히 지운다(app-evolve cycle89)', () => {
  sandbox.TWi = -1;
  const a1 = { id: 'a1', name: '통장1' };
  const a2 = { id: 'a2', name: '통장2' };
  sandbox.DB = { assets: [a1, a2], recurrences: [] };
  sandbox.lastUndo = null;
  sandbox.snapshotCalls = [];
  const before = Date.now();
  sandbox.deleteAssetsUndo(new Set(['a1', 'a2']));
  assert.ok(typeof sandbox.DB.deletedIds.a1 === 'number' && sandbox.DB.deletedIds.a1 >= before, 'a1에 삭제 시각이 기록되어야 함');
  assert.ok(typeof sandbox.DB.deletedIds.a2 === 'number' && sandbox.DB.deletedIds.a2 >= before, 'a2에도 삭제 시각이 기록되어야 함');
  sandbox.lastUndo.undoFn();
  assert.strictEqual(sandbox.DB.deletedIds.a1, undefined, '되돌리면 a1의 툼스톤이 지워져야 함');
  assert.strictEqual(sandbox.DB.deletedIds.a2, undefined, '되돌리면 a2의 툼스톤도 지워져야 함');
  sandbox.TWi = -1;
});
test('deleteAssetsUndo: undo로 되살린 자산에는 touch()가 호출되어 updatedAt이 갱신된다(app-evolve cycle94)', () => {
  sandbox.TWi = -1;
  const a1 = { id: 'a1', name: '통장1', updatedAt: 1 };
  sandbox.DB = { assets: [a1], recurrences: [] };
  sandbox.lastUndo = null;
  sandbox.snapshotCalls = [];
  sandbox.deleteAssetsUndo(new Set(['a1']));
  sandbox.lastUndo.undoFn();
  const restored = sandbox.DB.assets.find(a => a.id === 'a1');
  assert.strictEqual(restored.updatedAt, 'test-updatedAt', '되살린 자산에는 touch()가 호출되어야 함');
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
test("recApply: scope='future' 삭제는 cutoff 이후의 skip/edits도 함께 버리고, undo하면 원래대로 복원된다(app-evolve cycle121)", () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', skip: ['2026-01-05', '2026-03-05'], edits: { '2026-01-10': { amount: 1 }, '2026-03-10': { amount: 2 } }, endDate: null };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastUndo = null;
  sandbox.recApply('r1', '2026-02-05', 'delete', 'future');
  // splitRecOverrides의 editsPast/editsFuture는 vm 샌드박스 안에서 새로 만든 객체 리터럴이라
  // host의 Object와 realm이 달라 deepStrictEqual이 (값은 같아도) 실패하므로, JSON.stringify로
  // 정규화해 비교한다(위 recSave future 분할 테스트와 같은 이유). skip은 원본 배열을 filter()해
  // species로 realm이 보존되므로 그대로 deepStrictEqual을 쓸 수 있다.
  assert.deepStrictEqual(r.skip, ['2026-01-05'], 'cutoff(2/5) 이후 skip(3/5)은 끊어낸 구간이므로 함께 버려지고, 이전 skip(1/5)만 남아야 함');
  assert.strictEqual(JSON.stringify(r.edits), JSON.stringify({ '2026-01-10': { amount: 1 } }), 'cutoff 이후 edits(3/10)도 함께 버려지고, 이전 edits(1/10)만 남아야 함');
  sandbox.lastUndo.undoFn();
  assert.deepStrictEqual(r.skip, ['2026-01-05', '2026-03-05'], '되돌리면 skip이 원래 배열로 복원되어야 함');
  assert.strictEqual(JSON.stringify(r.edits), JSON.stringify({ '2026-01-10': { amount: 1 }, '2026-03-10': { amount: 2 } }), '되돌리면 edits도 원래 객체로 복원되어야 함');
});
test("recApply: scope='future' 삭제로 끊어낸 구간의 skip이 가지치기되어 있어, 나중에 endDate를 다시 늘려도(DB.recurrences[i]=d 직접 치환과 동일한 상태) 삭제됐던 회차가 skip으로 되살아나 거래가 사라지지 않는다(app-evolve cycle121 회귀)", () => {
  sandbox.TWi = -1;
  sandbox._recCache.clear();
  const r = { id: 'r1', active: true, freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, weekend: 'none', type: 'expense', category: '식비', memo: '', amount: 1000, skip: ['2026-05-05'], edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.recApply('r1', '2026-03-01', 'delete', 'future');
  assert.deepStrictEqual(r.skip, [], '3/1부터 끊었으므로 그 이후 날짜였던 5/5 skip은 더 이상 의미가 없어 함께 제거되어야 함');
  r.endDate = null; r.count = null; // 사용자가 나중에 다시 무기한으로 늘렸다고 가정
  sandbox._recCache.clear();
  // expandRec()의 반환 배열은 vm 샌드박스 안에서 만든 것이라 host의 Array와 realm이 달라
  // deepStrictEqual이 실패하므로(위 edits와 같은 이유), JSON.stringify로 정규화해 비교한다.
  const dates = sandbox.expandRec('2026-05-01', '2026-05-31').map(t => t.date);
  assert.strictEqual(JSON.stringify(dates), JSON.stringify(['2026-05-05']), '끊어낸 뒤 버려졌어야 할 skip이 남아있었다면 5/5 회차가 되살아난 skip에 가려져 사라졌을 것(회귀 확인)');
  sandbox._recCache.clear(); // 이 테스트가 채운 '2026-05-01|2026-05-31' 캐시 항목이 이후 다른 테스트(spendTrend 등)의 같은 구간 조회에 새지 않도록 정리
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
/* ---------- recSave/recApply/splitRecurrenceAt: touch()로 updatedAt 스탬프 (app-evolve cycle87 advance) ----------
 * cycle86 advance가 saveTx/saveAsset/saveRec 주경로에만 touch()를 배선했는데, 충돌 위험이 가장 큰
 * 반복거래 개별수정/분리 경로(이 파일의 recSave='one'/'future'/'all', recApply의 delete 분기,
 * splitRecurrenceAt)엔 빠져 있어(cycle87 critique) 3-way 병합이 이 경로들을 지나온 레코드에서
 * 잘못된 승자를 조용히 고를 위험이 있었다. 여기서도 saveRec 테스트와 같은 이유로 touch()의
 * 스텁 반환값('test-updatedAt')이 호출됐는지만 검증한다. */
test("recSave: scope='one'/'future'/'all' 모두 수정 대상 레코드(및 future의 새 분리 레코드)에 touch()가 호출된다", () => {
  sandbox.TWi = -1;
  let r = { id: 'r1', amount: 1000, edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'one' };
  sandbox.txDraft = { amount: 5000 };
  sandbox.recSave();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='one'은 r에 touch()가 호출되어야 함");
  // forward 경로의 touch() 스텁 값이 그대로 남아있어 undo를 안 불러도 통과하는 거짓양성을 막기 위해
  // undo 호출 직전에 센티널로 리셋한다(app-evolve cycle129 advance).
  r.updatedAt = 1;
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='one'의 되돌리기(undo)에도 touch()가 호출되어야 함");

  r = { id: 'r1', amount: 1000, endDate: null, skip: [], edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-03-01', scope: 'future' };
  sandbox.txDraft = { amount: 7000 };
  sandbox.recSave();
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='future'는 잘린 원본에도 touch()가 호출되어야 함");
  assert.strictEqual(newRec.updatedAt, 'test-updatedAt', "scope='future'는 새로 분리된 레코드에도 touch()가 호출되어야 함");
  r.updatedAt = 1;
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='future'의 되돌리기(undo)에도 잘린 원본에 touch()가 호출되어야 함");

  r = { id: 'r1', amount: 1000 };
  sandbox.DB = { recurrences: [r] };
  sandbox.window._recCtx = { recId: 'r1', date: '2026-02-05', scope: 'all' };
  sandbox.txDraft = { amount: 9999 };
  sandbox.recSave();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='all'은 r에 touch()가 호출되어야 함");
  r.updatedAt = 1;
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='all'의 되돌리기(undo)에도 touch()가 호출되어야 함");
});
test("recApply: scope='one'/'future' 삭제도 대상 레코드에 touch()가 호출된다", () => {
  sandbox.TWi = -1;
  let r = { id: 'r1', skip: [] };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastUndo = null;
  sandbox.recApply('r1', '2026-02-05', 'delete', 'one');
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='one' 삭제도 touch()가 호출되어야 함");
  // forward 경로의 touch() 스텁 값이 그대로 남아있어 undo를 안 불러도 통과하는 거짓양성을 막기 위해
  // undo 호출 직전에 센티널로 리셋한다(app-evolve cycle129 advance).
  r.updatedAt = 1;
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='one' 삭제의 되돌리기(undo)에도 touch()가 호출되어야 함");

  r = { id: 'r1', freq: 'monthly', day: 5, startDate: '2026-01-05', weekend: 'none', endDate: null, count: null, skip: [], edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastUndo = null;
  sandbox.recApply('r1', '2026-02-05', 'delete', 'future');
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='future' 삭제도 touch()가 호출되어야 함");
  r.updatedAt = 1;
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', "scope='future' 삭제의 되돌리기(undo)에도 touch()가 호출되어야 함");
});
test('splitRecurrenceAt: 잘린 원본과 새로 분리된 레코드 모두에 touch()가 호출된다', () => {
  const orig = { id: 'r1', freq: 'monthly', day: 5, startDate: '2026-01-05', weekend: 'none', endDate: null, skip: [], edits: {} };
  const draft = { freq: 'monthly', day: 5, startDate: '2026-06-05', weekend: 'none', amount: 2000, skip: [], edits: {} };
  const { updatedOriginal, newRec } = sandbox.splitRecurrenceAt(orig, draft, '2026-06-05');
  assert.strictEqual(updatedOriginal.updatedAt, 'test-updatedAt', '잘린 원본에도 touch()가 호출되어야 함');
  assert.strictEqual(newRec.updatedAt, 'test-updatedAt', '새로 분리된 레코드에도 touch()가 호출되어야 함');
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
test('recHistFieldsChanged: fromAssetId/toAssetId/amount/category/day/freq/startDate/weekend가 바뀌면 true', () => {
  const orig = { fromAssetId: 'a1', toAssetId: 'a2', amount: 1000, category: '식비', day: 5, freq: 'monthly', startDate: '2026-01-05', memo: 'm', weekend: 'none' };
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, fromAssetId: 'a9' }), true);
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, amount: 2000 }), true);
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, freq: 'weekly' }), true);
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, startDate: '2026-02-05' }), true);
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, weekend: 'later' }), true);
});
test('recHistFieldsChanged: 메모만 바뀌면 false (이력 비영향 필드)', () => {
  const orig = { fromAssetId: 'a1', toAssetId: 'a2', amount: 1000, category: '식비', day: 5, freq: 'monthly', startDate: '2026-01-05', memo: 'm', weekend: 'none' };
  assert.strictEqual(sandbox.recHistFieldsChanged(orig, { ...orig, memo: '다른 메모' }), false);
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

/* splitRecOverrides 자체는 위 splitRecurrenceAt 테스트들이 간접적으로 통과시키지만(app-evolve
 * cycle80 critique가 지적한 "직접 assertion 0건"), 여기서는 splitRecurrenceAt의 날짜 재계산·
 * 필드 병합 로직 없이 skip/edits 분기 규칙 자체만 떼어 직접 검증한다. */
test('splitRecOverrides: skip은 effectiveDate 미만/이상으로 갈라지고, effectiveDate 당일은 future 쪽으로 간다(경계 포함)', () => {
  const { skipPast, skipFuture } = sandbox.splitRecOverrides(['2026-06-01', '2026-06-05', '2026-06-10'], {}, '2026-06-05');
  assert.deepStrictEqual(skipPast, ['2026-06-01']);
  assert.deepStrictEqual(skipFuture, ['2026-06-05', '2026-06-10']);
});
test('splitRecOverrides: edits도 같은 경계 규칙(effectiveDate 당일 포함 이후는 future)으로 갈라진다', () => {
  const { editsPast, editsFuture } = sandbox.splitRecOverrides([], { '2026-06-01': { amount: 1 }, '2026-06-05': { amount: 2 } }, '2026-06-05');
  assert.strictEqual(JSON.stringify(editsPast), JSON.stringify({ '2026-06-01': { amount: 1 } }));
  assert.strictEqual(JSON.stringify(editsFuture), JSON.stringify({ '2026-06-05': { amount: 2 } }));
});
test('splitRecOverrides: skip/edits가 없으면(null/undefined) 예외 없이 양쪽 다 빈 값을 반환한다', () => {
  const { skipPast, skipFuture, editsPast, editsFuture } = sandbox.splitRecOverrides(null, undefined, '2026-06-05');
  // vm 샌드박스 안에서 새로 만들어진 배열/객체는 host realm과 프로토타입이 달라 deepStrictEqual이
  // 값이 같아도 실패한다(위 splitRecurrenceAt 테스트와 같은 이유) — 길이/JSON으로 비교한다.
  assert.strictEqual(skipPast.length, 0);
  assert.strictEqual(skipFuture.length, 0);
  assert.strictEqual(JSON.stringify(editsPast), '{}');
  assert.strictEqual(JSON.stringify(editsFuture), '{}');
});

/* recSaveScopeConfirm 자체도 지금까지 saveRec()을 거쳐서만 실행됐다(app-evolve cycle80 critique) —
 * 여기서는 saveRec의 "과거 회차 판정" 로직 없이 확인 시트를 띄우는 동작 자체만 직접 검증한다. */
test('recSaveScopeConfirm: window._recSaveScope에 orig/d/i를 그대로 저장하고, memo(없으면 category)가 들어간 확인 시트를 띄운다', () => {
  const orig = { id: 'r1', memo: '월세', category: '주거' };
  const d = { id: 'r1', memo: '월세', category: '주거', amount: 500000 };
  sandbox.lastSheetHtml = null;
  sandbox.window._recSaveScope = null;
  sandbox.recSaveScopeConfirm(orig, d, 2);
  assert.strictEqual(sandbox.window._recSaveScope.orig, orig);
  assert.strictEqual(sandbox.window._recSaveScope.d, d);
  assert.strictEqual(sandbox.window._recSaveScope.i, 2);
  assert.ok(sandbox.lastSheetHtml.includes('월세'), '메모가 있으면 메모로 안내해야 함');
  assert.ok(sandbox.lastSheetHtml.includes('오늘부터 이후 모두') && sandbox.lastSheetHtml.includes('전체 적용'), '두 선택지가 모두 보여야 함');
});
test('recSaveScopeConfirm: memo가 없으면 category로 안내한다', () => {
  const orig = { id: 'r1', memo: '', category: '주거' };
  sandbox.lastSheetHtml = null;
  sandbox.recSaveScopeConfirm(orig, { ...orig }, 0);
  assert.ok(sandbox.lastSheetHtml.includes('주거'));
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
test('saveRec: 과거 회차가 있는 반복에서 시작일(startDate)만 바꿔 저장하면, 곧바로 덮어쓰지 않고 범위 확인 시트를 띄운다(cycle59 develop에서 고친 버그의 회귀 방지)', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), startDate: '2026-02-05' };
  sandbox.lastSheetHtml = null;
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '확인 없이 즉시 분리/덮어쓰기가 일어나면 안 됨');
  assert.strictEqual(r.startDate, '2026-01-05', '확인 전에는 원본이 그대로여야 함');
  assert.ok(sandbox.lastSheetHtml, '범위 확인 시트가 떠야 함');
});
test("saveRec: 시작일 변경에서 '전체 적용'을 고르면 새 시작일이 그대로 반영된다", () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), startDate: '2026-02-05' };
  sandbox.saveRec();
  sandbox.recSaveScopeApply('all');
  assert.strictEqual(sandbox.DB.recurrences.length, 1);
  assert.strictEqual(sandbox.DB.recurrences[0].startDate, '2026-02-05');
});
test("saveRec: 시작일 변경에서 '오늘부터 이후 모두'를 고르면, 새로 분리되는 구간은 사용자가 입력한 시작일이 아니라 분리 시점(오늘)부터 시작한다(split 시맨틱상 의도된 동작)", () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const r = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, skip: [], edits: {}, active: true };
  sandbox.DB = { recurrences: [r] };
  sandbox.recDraft = { ...JSON.parse(JSON.stringify(r)), startDate: '2026-02-05' };
  sandbox.saveRec();
  sandbox.recSaveScopeApply('future');
  assert.strictEqual(sandbox.DB.recurrences.length, 2);
  const pastRec = sandbox.DB.recurrences.find(x => x.id === 'r1');
  assert.strictEqual(pastRec.startDate, '2026-01-05', '과거 구간(원본)의 시작일은 그대로 유지되어야 함');
  assert.strictEqual(pastRec.endDate, '2026-06-14', '원본은 오늘 하루 전까지로 끊겨야 함');
  const newRec = sandbox.DB.recurrences.find(x => x.id !== 'r1');
  assert.strictEqual(newRec.startDate, '2026-06-15', 'future 분기는 항상 오늘부터 새 구간을 시작함');
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
/* ---------- saveTx/saveAsset/saveRec: touch()로 updatedAt 스탬프 (app-evolve cycle86 advance) ----------
 * 클라우드 동기화가 문서 전체를 한 덩어리로 취급해 서로 무관한 레코드를 고친 두 기기도 충돌로
 * 처리되는 문제(cycle85/86 critique)를 풀려면 향후 레코드 단위 병합이 필요하고, 그 전제로 생성·
 * 수정 시점에 레코드마다 updatedAt이 채워져야 한다. 여기선 그 전제(touch 호출)만 검증한다 —
 * 병합 로직 자체는 아직 없다. */
test('saveRec: 신규 등록 시 touch()로 updatedAt이 채워진다', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  sandbox.DB = { recurrences: [] };
  sandbox.recDraft = { id: null, type: 'expense', freq: 'monthly', day: 5, startDate: '2026-07-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, active: true };
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences[0].updatedAt, 'test-updatedAt');
});
test('saveRec: 기존 반복 수정 시(이력 비영향 필드) 즉시 적용 경로에서도 updatedAt이 갱신된다', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  const orig = { id: 'r1', type: 'expense', freq: 'monthly', day: 5, startDate: '2026-01-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '옛 메모', fromAssetId: 'a1', toAssetId: null, active: true, skip: [], edits: {}, updatedAt: 'old' };
  sandbox.DB = { recurrences: [orig] };
  sandbox.recDraft = Object.assign({}, orig, { memo: '새 메모' });
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences[0].updatedAt, 'test-updatedAt');
});
/* ---------- saveRec: 더블탭 중복 저장 가드 (app-evolve cycle79 critique/advance) ----------
 * closeSheet()는 .sheet에서 'show' 클래스만 떼고 트랜지션(.46s)을 거는 것이지 innerHTML을
 * 지우지 않으므로, 저장 버튼은 애니메이션이 끝날 때까지 DOM에 그대로 남아 클릭 가능하다.
 * 더블탭으로 click 이벤트가 두 번 들어오면 saveRec()이 완전히 동기적으로 두 번 완주해
 * 같은 반복이 DB.recurrences에 2건 push됐다(월세·구독·급여처럼 매달 자동 계상되는 항목이라
 * 사용자가 원장에서 우연히 발견하기 전까지 드러나지 않음). _savedDrafts(WeakSet)에 저장
 * 완료된 recDraft 객체를 표시해 같은 draft로의 재호출을 조용히 무시하도록 고쳤다. */
test('saveRec: 같은 draft로 두 번 연속 호출해도(더블탭) 반복이 중복 저장되지 않는다', () => {
  sandbox.TWi = -1; sandbox.TODAY = '2026-06-15';
  sandbox.DB = { recurrences: [] };
  sandbox.recDraft = { id: null, type: 'expense', freq: 'monthly', day: 5, startDate: '2026-07-05', endDate: null, count: null, amount: 1000, category: '관리비', memo: '관리비', fromAssetId: 'a1', toAssetId: null, active: true };
  sandbox.saveRec();
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '같은 draft로 다시 저장해도 반복이 1개만 있어야 함');
  assert.ok(!('_saved' in sandbox.DB.recurrences[0]), '가드 마커가 저장된 레코드에 섞여 들어가면 안 됨(WeakSet이어야 함)');
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
/* ---------- saveQuickAmount: 변동 카테고리 실제 금액 입력에도 touch()로 updatedAt이 갱신돼야 함
 * (app-evolve develop) ----------
 * recSave()의 scope='one' 경로(3543행: edits[date]={amount,memo};touch(r))는 정확히 같은 모양의
 * "r.edits에 회차별 실제 금액을 기록"인데도 touch(r)를 호출한다. saveQuickAmount()는 홈 화면의
 * "눌러서 금액만 넣기" 카드에서 같은 edits 갱신을 하면서도 touch(r)를 빠뜨리고 있었다 —
 * doRenameOwner/doRenameCat/rollPendingTransfers와 동일한 이유로, mergeCollection()의 3-way 병합은
 * updatedAt만 보고 승자를 고르므로 touch() 누락 시 이 기기에서 방금 입력한 실제 금액이 클라우드
 * 동기화 충돌 때 상대 기기의 옛 사본(더 최근에 다른 필드가 바뀌어 updatedAt이 더 큰)에 조용히
 * 덮여 사라질 수 있다. */
test('saveQuickAmount: 실제 금액을 저장하면 touch()가 호출돼 updatedAt이 갱신된다', () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', category: '식비', memo: '식비', edits: {}, updatedAt: 111 };
  sandbox.DB = { recurrences: [r] };
  sandbox.qAmtValue = '12,000';
  sandbox.lastUndo = null;
  sandbox.saveQuickAmount('r1', '2026-02-05');
  assert.strictEqual(r.updatedAt, 'test-updatedAt', '실제 금액을 기록한 회차에는 touch()가 호출되어야 함');
  // forward 경로의 touch() 스텁 값이 그대로 남아있어 undo를 안 불러도 통과하는 거짓양성을 막기 위해
  // undo 호출 직전에 센티널로 리셋한다(app-evolve cycle129 advance, deleteAssetsUndo 테스트와 동일 패턴).
  r.updatedAt = 1;
  sandbox.lastUndo.undoFn();
  assert.strictEqual(r.updatedAt, 'test-updatedAt', '되돌리기(undo)에도 touch()가 호출되어야 함 — 안 그러면 되돌린 직후 다른 기기와의 동기화가 이 복구를 조용히 덮어씀');
});
test('saveQuickAmount: 금액을 비워두면(저장 실패) touch()가 호출되면 안 된다', () => {
  sandbox.TWi = -1;
  const r = { id: 'r1', category: '식비', memo: '식비', edits: {}, updatedAt: 111 };
  sandbox.DB = { recurrences: [r] };
  sandbox.qAmtValue = '';
  sandbox.saveQuickAmount('r1', '2026-02-05');
  assert.strictEqual(r.updatedAt, 111, '저장하지 않았으면 updatedAt이 그대로여야 함');
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
/* ---------- lastActualAmount: _lastEditCache 회귀 (app-evolve cycle75 advance) ----------
 * openQuickAmount()를 열 때마다 r.edits 전체를 Object.keys().sort()로 스캔하던 걸 없애려고
 * "가장 최근 edits 날짜"만 회차별로 기억해 두는 캐시를 추가했다. 캐시는 lastActualAmount() 안에서
 * 읽기 전용으로만 채워지고, 실제 쓰기 경로(saveQuickAmount/recSave)는 항상 save()->
 * invalidateBalances()를 거쳐 지워지므로 정상 흐름에서는 낡을 일이 없다 — 그 계약을 balancesUpTo/
 * _balCache 테스트(위 3600행 부근)와 같은 방식으로 확인한다: 캐시를 비우지 않고 r.edits를 직접
 * 바꾸면 옛 값이 그대로 나오는 것까지 보여줘야 "캐시가 실제로 동작 중"이라는 게 증명된다. */
test('lastActualAmount: 캐시 히트(미래 날짜 조회)가 전체 스캔과 같은 결과를 준다', () => {
  const r = { amount: 1000, edits: { '2026-01-05': { amount: 100 }, '2026-03-05': { amount: 300 }, '2026-02-05': { amount: 200 } } };
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-04-01'), 300, '가장 최근(2026-03-05) edits 금액이 나와야 함');
  // vm 샌드박스에서 만들어진 객체는 host의 Object와 realm이 달라 deepStrictEqual이
  // (값은 같아도 프로토타입이 다름) 실패하므로, 필드별로 비교한다.
  assert.strictEqual(sandbox._lastEditCache.get(r).date, '2026-03-05', '캐시가 날짜순 정렬 후 가장 최근 날짜로 채워져야 함');
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-05-01'), 300, '캐시 히트로도 같은 결과여야 함');
});
test('lastActualAmount: 캐시된 날짜 이하로 조회하면 폴백 전체 스캔으로 그 시점 직전 값을 정확히 돌려준다', () => {
  const r = { amount: 1000, edits: { '2026-01-05': { amount: 100 }, '2026-03-05': { amount: 300 } } };
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-04-01'), 300, '캐시를 먼저 채움(latest=2026-03-05)');
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-02-01'), 100, '캐시된 날짜(03-05)보다 이전 조회는 폴백 스캔으로 01-05 값을 줘야 함');
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-01-01'), 1000, '그보다 더 이전이면 edits가 없어 기본 amount로 폴백해야 함');
});
test('lastActualAmount: 캐시를 비우지 않으면 그 뒤에 추가된 더 최신 edits가 즉시 반영되지 않는다(캐시가 실제로 동작 중임을 확인) → invalidateBalances 역할의 _lastEditCache.clear() 뒤엔 반영된다', () => {
  const r = { amount: 1000, edits: { '2026-01-05': { amount: 100 } } };
  sandbox._lastEditCache.delete(r);
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-06-01'), 100, '캐시를 채움(latest=2026-01-05)');
  r.edits['2026-05-05'] = { amount: 500 };
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-06-01'), 100, '캐시를 비우지 않으면 새로 추가된 edits가 아직 반영 안 됨 — 실사용에선 saveQuickAmount/recSave가 항상 save()->invalidateBalances()를 거쳐 이 캐시를 비우므로 발생하지 않음');
  sandbox._lastEditCache.clear();
  assert.strictEqual(sandbox.lastActualAmount(r, '2026-06-01'), 500, '캐시를 비운 뒤에는 새 edits가 반영되어야 함');
});
test('lastActualAmount: 서로 다른 recurrence 객체는 캐시가 독립적으로 관리된다', () => {
  const r1 = { amount: 1, edits: { '2026-01-01': { amount: 11 } } };
  const r2 = { amount: 2, edits: { '2026-02-01': { amount: 22 } } };
  assert.strictEqual(sandbox.lastActualAmount(r1, '2026-06-01'), 11);
  assert.strictEqual(sandbox.lastActualAmount(r2, '2026-06-01'), 22);
  assert.strictEqual(sandbox._lastEditCache.get(r1).date, '2026-01-01');
  assert.strictEqual(sandbox._lastEditCache.get(r2).date, '2026-02-01');
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
test('openQuickAmount: qAmt(실제 금액)의 Enter-제출도 다른 금액 입력(rAmt/goalAmt/asCostBasis)과 동일하게 isComposing 가드를 쓴다' +
  '(한글 IME 조합 중 엔터로 조합을 확정하려다 금액이 덜 입력된 채로 saveQuickAmount가 먼저 불리는 걸 방지)', () => {
  const r = { id: 'r1', type: 'expense', category: '변동비', memo: '변동비', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastSheetHtml = null;
  sandbox.openQuickAmount('r1', '2026-03-05');
  assert.ok(
    sandbox.lastSheetHtml.includes(`onkeydown="if(event.key==='Enter'&&!event.isComposing)saveQuickAmount('r1','2026-03-05')"`),
    'qAmt의 Enter→saveQuickAmount() 연결에 !event.isComposing 가드가 없음'
  );
});
test('openQuickAmount: qAmt도 다른 금액 입력란(txAmt/rAmt/goalAmt/asCostBasis)과 동일하게 field-clear(×) 버튼이 있다', () => {
  const r = { id: 'r1', type: 'expense', category: '변동비', memo: '변동비', edits: {} };
  sandbox.DB = { recurrences: [r] };
  sandbox.lastSheetHtml = null;
  sandbox.openQuickAmount('r1', '2026-03-05');
  assert.ok(sandbox.lastSheetHtml.includes('<div class="field-clear"><input id="qAmt"'), 'qAmt 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(sandbox.lastSheetHtml.includes(`<button type="button" class="fc-x" aria-label="금액 지우기" onclick="clrInput('qAmt')">`), 'qAmt에 fc-x 지우기 버튼의 clrInput 연결이 없음');
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

/* ---------- shouldWarnStorageSize: localStorage quota 근접 경고 카드 노출 판정 ---------- */
test('shouldWarnStorageSize: warnLen 미만이면 경고하지 않는다', () => {
  assert.strictEqual(sandbox.shouldWarnStorageSize(1000, false, 3000, 4500), false);
});
test('shouldWarnStorageSize: warnLen을 넘고 아직 dismiss 전이면 경고한다', () => {
  assert.strictEqual(sandbox.shouldWarnStorageSize(3500, false, 3000, 4500), true);
});
test('shouldWarnStorageSize: warnLen을 넘었어도 dismiss했으면 조용하다', () => {
  assert.strictEqual(sandbox.shouldWarnStorageSize(3500, true, 3000, 4500), false);
});
test('shouldWarnStorageSize: dismiss했어도 critLen까지 넘으면 다시 경고한다(방치 방지)', () => {
  assert.strictEqual(sandbox.shouldWarnStorageSize(5000, true, 3000, 4500), true);
});
test('shouldWarnStorageSize: 문턱 값 자체(경계)에서는 경고한다', () => {
  assert.strictEqual(sandbox.shouldWarnStorageSize(3000, false, 3000, 4500), true);
  assert.strictEqual(sandbox.shouldWarnStorageSize(4500, true, 3000, 4500), true);
});

/* ---------- clockSkewSeverity/shouldWarnClockSkew: 클라우드 동기화 시계 오차 경고 판정 (logic.js, app-evolve cycle165 advance) ----------
 * mergeCollection()의 LWW가 두 기기 로컬 시계만으로 병합 승자를 정해, 한쪽 시계가 크게 틀리면
 * 수정이 조용히 사라질 수 있다는 critique(cycle165)의 감지+경고 계획을 구현한다. */
const CSKEW_WARN_MS = 5 * 60 * 1000, CSKEW_CRIT_MS = 24 * 60 * 60 * 1000;
test('clockSkewSeverity: 아직 측정 전(null)이거나 측정 실패(NaN)면 ok다', () => {
  assert.strictEqual(sandbox.clockSkewSeverity(null, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'ok');
  assert.strictEqual(sandbox.clockSkewSeverity(NaN, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'ok');
});
test('clockSkewSeverity: warnMs 미만이면 ok다', () => {
  assert.strictEqual(sandbox.clockSkewSeverity(60 * 1000, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'ok');
});
test('clockSkewSeverity: warnMs 이상 critMs 미만이면 warn이고, 기기가 느려도(음수 drift) 절대값으로 판정한다', () => {
  assert.strictEqual(sandbox.clockSkewSeverity(10 * 60 * 1000, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'warn');
  assert.strictEqual(sandbox.clockSkewSeverity(-10 * 60 * 1000, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'warn');
});
test('clockSkewSeverity: critMs 이상이면 severe다', () => {
  assert.strictEqual(sandbox.clockSkewSeverity(2 * 24 * 60 * 60 * 1000, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'severe');
});
test('clockSkewSeverity: 문턱 값 자체(경계)에서는 그 등급으로 올라간다', () => {
  assert.strictEqual(sandbox.clockSkewSeverity(CSKEW_WARN_MS, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'warn');
  assert.strictEqual(sandbox.clockSkewSeverity(CSKEW_CRIT_MS, CSKEW_WARN_MS, CSKEW_CRIT_MS), 'severe');
});
test('shouldWarnClockSkew: ok면 dismiss 여부와 무관하게 경고하지 않는다', () => {
  assert.strictEqual(sandbox.shouldWarnClockSkew('ok', false), false);
  assert.strictEqual(sandbox.shouldWarnClockSkew('ok', true), false);
});
test('shouldWarnClockSkew: warn은 dismiss 전엔 경고하고, dismiss하면 조용하다', () => {
  assert.strictEqual(sandbox.shouldWarnClockSkew('warn', false), true);
  assert.strictEqual(sandbox.shouldWarnClockSkew('warn', true), false);
});
test('shouldWarnClockSkew: severe는 dismiss했어도 항상 경고한다(방치 방지)', () => {
  assert.strictEqual(sandbox.shouldWarnClockSkew('severe', true), true);
  assert.strictEqual(sandbox.shouldWarnClockSkew('severe', false), true);
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
test('restoreBackup: 백업 JSON에 owners:[]가 들어있어도 migrate()가 기본 귀속 3개로 복구한다', () => {
  sandbox.DB = { assets: [{ id: 'old' }], txns: [], categories: { expense: ['옛카테고리'] }, catIcon: {}, catVar: {}, budgets: {}, owners: ['나'], recurrences: [] };
  const backup = { assets: [{ id: 'new1' }], txns: [], owners: [] };
  sandbox.restoreBackup(backup);
  assert.deepStrictEqual([...sandbox.DB.owners], ['나', '배우자', '공용'], '빈 owners 배열로 복원해도 자산 등록 시 귀속을 고를 수 있어야 함');
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
/* app-evolve cycle57 develop: t.amount는 항상 크기(magnitude)이고 방향은 type/fromAssetId/
 * toAssetId가 결정하는 관례라(3596/3604줄의 -t.amount 사용, addBalanceAdjust의 Math.abs(gap) 등
 * 코드 전체가 이 전제로 짜여 있음), 자산의 baseAmount/amountKRW 같은 "마이너스도 유효한 잔액성
 * 필드"와는 다르다. 이전에는 SANITIZE_FREE_FIELDS에 amount가 끼어 있어(실제로는 assets 루프에서만
 * 쓰이고 txns/recurrences 루프는 이 배열과 무관하게 직접 sanitizeAmount(d.amount)를 min 없이
 * 불렀음) 손상된 백업/원격 데이터의 음수 amount가 그대로 통과됐다 — balancesUpTo()의
 * map[fromAssetId]-=sign*t.amount에서 부호가 뒤집혀 출금이 입금처럼 반영되는 등 잔액 계산이
 * 조용히 오염됐다(num()의 allowNeg 게이팅으로 UI 입력 경로는 cycle56에서 막았지만, 백업 복원·
 * 클라우드 풀로 들어오는 경로는 그대로 열려 있었다). min 0으로 클램프해 막는다. */
test('sanitizeBackup: 거래 금액이 음수면 0으로 클램프한다(방향은 type/fromAssetId/toAssetId가 정하므로 amount 자체의 음수는 무효)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    assets: [],
    txns: [{ id: 't1', date: '2026-01-01', type: 'expense', amount: -50000 }],
  });
  assert.strictEqual(data.txns[0].amount, 0);
  assert.strictEqual(fixedCount, 1);
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
/* ---------- sanitizeBackup: 저축 자산의 maturityDate도 반복거래 startDate/endDate와 동일하게
 * csvDateValid()로 형식/달력 유효성을 검증한다(app-evolve cycle127 advance). 만기일 없음은
 * 기존에도 정상 상태라(만기 미설정) 레코드를 버리지 않고 깨진 값만 null로 정규화한다. ---------- */
test('sanitizeBackup: 형식/달력상 무효한 자산 maturityDate는 null로 정규화하고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [],
    assets: [
      { id: 'a1', type: 'savings', maturityDate: 'not-a-date' },
      { id: 'a2', type: 'savings', maturityDate: '2026-13-01' },
    ],
  });
  assert.strictEqual(data.assets[0].maturityDate, null);
  assert.strictEqual(data.assets[1].maturityDate, null);
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: 유효한 자산 maturityDate와 만기 미설정(없음/null)은 그대로 둔다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [],
    assets: [
      { id: 'a1', type: 'savings', maturityDate: '2026-06-15' },
      { id: 'a2', type: 'savings', maturityDate: null },
      { id: 'a3', type: 'cash' },
    ],
  });
  assert.strictEqual(data.assets[0].maturityDate, '2026-06-15');
  assert.strictEqual(data.assets[1].maturityDate, null);
  assert.strictEqual(data.assets[2].maturityDate, undefined);
  assert.strictEqual(fixedCount, 0);
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
/* app-evolve cycle83 advance: CSV 가져오기(buildImportPreview)는 RANGE_FROM 이전 행을
 * rangeCount로 세어 사용자에게 보여주는데(1915줄), 백업/클라우드 복원(sanitizeBackup) 경로는
 * 이 카운트가 없어 복원된 txn이 DB엔 남으면서도 잔액·집계에서만 조용히 빠지는 걸 사용자가
 * 알 방법이 없었다. droppedCount(레코드 자체 제거)와 구분되는 rangeCount를 추가했다. */
test("sanitizeBackup: RANGE_FROM 이전 날짜 거래는 제거하지 않되 rangeCount로 센다(droppedCount와 구분)", () => {
  const { data, droppedCount, rangeCount } = sandbox.sanitizeBackup({
    assets: [],
    txns: [
      { id: 't1', date: '2020-01-01', amount: 1000 },
      { id: 't2', date: sandbox.RANGE_FROM, amount: 2000 },
      { id: 't3', date: '2026-01-01', amount: 3000 },
    ],
  });
  assert.strictEqual(data.txns.length, 3, 'RANGE_FROM 이전이어도 레코드는 그대로 유지되어야 함');
  assert.strictEqual(droppedCount, 0);
  assert.strictEqual(rangeCount, 1, 'RANGE_FROM 당일은 하한선에 포함되어 rangeCount에 안 잡혀야 함');
});
// app-evolve cycle120 advance: RANGE_TO(상한)도 RANGE_FROM(하한)과 대칭으로 rangeCount에 잡혀야 한다.
test("sanitizeBackup: RANGE_TO 이후 날짜 거래도 제거하지 않되 rangeCount로 센다(droppedCount와 구분)", () => {
  sandbox.RANGE_TO = '2028-06-15';
  const { data, droppedCount, rangeCount } = sandbox.sanitizeBackup({
    assets: [],
    txns: [
      { id: 't1', date: '2028-06-16', amount: 1000 },
      { id: 't2', date: sandbox.RANGE_TO, amount: 2000 },
      { id: 't3', date: '2026-01-01', amount: 3000 },
    ],
  });
  assert.strictEqual(data.txns.length, 3, 'RANGE_TO 이후여도 레코드는 그대로 유지되어야 함');
  assert.strictEqual(droppedCount, 0);
  assert.strictEqual(rangeCount, 1, 'RANGE_TO 당일은 상한선에 포함되어 rangeCount에 안 잡혀야 함');
});
test("sanitizeBackup: RANGE_FROM 이전 날짜가 없으면 rangeCount는 0이다(정상 케이스는 회귀 없음)", () => {
  const { rangeCount } = sandbox.sanitizeBackup({
    assets: [],
    txns: [{ id: 't1', date: '2026-01-01', amount: 1000 }],
  });
  assert.strictEqual(rangeCount, 0);
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
test('sanitizeBackup: 반복거래 금액이 음수면 0으로 클램프한다(txns와 동일 이유 — 매달 새로 생기는 회차라 방치하면 계속 오염됨)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [{ id: 'r1', startDate: '2026-01-01', amount: -30000 }],
  });
  assert.strictEqual(data.recurrences[0].amount, 0);
  assert.strictEqual(fixedCount, 1);
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
test('sanitizeBackup: 반복거래 회차별 수정(edits[date].amount)이 음수면 0으로 클램프한다(변동 카테고리는 0을 유효값으로 허용하되 음수는 무효)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [{ id: 'r1', startDate: '2026-01-01', amount: 10000, edits: { '2026-02-01': { amount: -5000 } } }],
  });
  assert.strictEqual(data.recurrences[0].edits['2026-02-01'].amount, 0);
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
test('sanitizeBackup: startDate가 비어있지 않아도 형식이 깨졌거나 달력상 존재하지 않으면 제거한다(csvDateValid와 동일 기준 — "2026-13-01"처럼 정규식만 통과하는 값도 recDates()를 무한루프에 빠뜨림)', () => {
  const { data, droppedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [
      { id: 'r1', startDate: 'not-a-date', amount: 1000 },
      { id: 'r2', startDate: '2026-13-01', amount: 1000 },
      { id: 'r3', startDate: '2026-01-01', amount: 2000 },
    ],
  });
  assert.strictEqual(data.recurrences.length, 1, '형식/달력상 유효하지 않은 startDate는 제거되어야 함');
  assert.strictEqual(data.recurrences[0].id, 'r3');
  assert.strictEqual(droppedCount, 2);
});
test('sanitizeBackup: endDate가 형식/달력상 무효하면 레코드는 유지하되 null로 떨어뜨린다(endDate는 비어있는 게 정상인 무기한 반복이라 startDate처럼 통째로 버리진 않지만, "2026-01-32" 같은 값이 남으면 recDates()의 end가 Invalid Date가 되어 cur>endd 비교가 항상 false라 무한루프에 빠짐)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [
      { id: 'r1', startDate: '2026-01-01', endDate: '2026-01-32', amount: 1000 },
      { id: 'r2', startDate: '2026-01-01', endDate: 'not-a-date', amount: 1000 },
      { id: 'r3', startDate: '2026-01-01', endDate: '2026-06-30', amount: 1000 },
      { id: 'r4', startDate: '2026-01-01', endDate: null, amount: 1000 },
    ],
  });
  assert.strictEqual(data.recurrences.length, 4, '무효한 endDate가 있어도 레코드는 제거되지 않아야 함');
  assert.strictEqual(data.recurrences[0].endDate, null, '무효한 endDate("2026-01-32")는 null로 보정되어야 함');
  assert.strictEqual(data.recurrences[1].endDate, null, '무효한 endDate("not-a-date")는 null로 보정되어야 함');
  assert.strictEqual(data.recurrences[2].endDate, '2026-06-30', '유효한 endDate는 그대로 유지되어야 함');
  assert.strictEqual(data.recurrences[3].endDate, null, '이미 null인 endDate는 그대로 유지되어야 함');
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: 매월 반복의 day가 숫자가 아니거나 범위를 벗어나면 clampDay와 동일하게 보정한다(recDates()의 "2024-01-NaN" 같은 깨진 날짜 생성을 방지)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [
      { id: 'r1', freq: 'monthly', startDate: '2026-01-01', amount: 1000, day: '오' },
      { id: 'r2', freq: 'monthly', startDate: '2026-01-01', amount: 1000, day: 500 },
      { id: 'r3', freq: 'monthly', startDate: '2026-01-01', amount: 1000, day: -5 },
      { id: 'r4', freq: 'monthly', startDate: '2026-01-01', amount: 1000, day: 15 },
    ],
  });
  assert.strictEqual(data.recurrences[0].day, 1);
  assert.strictEqual(data.recurrences[1].day, 31);
  assert.strictEqual(data.recurrences[2].day, 1);
  assert.strictEqual(data.recurrences[3].day, 15, '정상 범위 값은 그대로 유지되어야 함');
  assert.strictEqual(fixedCount, 3);
});
test("sanitizeBackup: 매월 반복의 day가 'last'(말일)면 그대로 두고(clampDay가 잘못 1일로 바꾸지 않음), 매월이 아닌 반복은 day를 건드리지 않는다", () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    recurrences: [
      { id: 'r1', freq: 'monthly', startDate: '2026-01-01', amount: 1000, day: 'last' },
      { id: 'r2', freq: 'weekly', startDate: '2026-01-01', amount: 1000, day: 'garbage' },
    ],
  });
  assert.strictEqual(data.recurrences[0].day, 'last');
  assert.strictEqual(data.recurrences[1].day, 'garbage');
  assert.strictEqual(fixedCount, 0);
});
/* DB.goals(app-evolve cycle122 신설)는 sanitizeBackup에 검증 분기가 전혀 없어 손상된 백업/원격
 * payload의 targetAmount/targetDate가 그대로 통과했었다(critique cycle123이 발견). */
test('sanitizeBackup: 목표의 NaN/문자열 목표금액을 보정하고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    goals: [{ id: 'g1', name: '목표', targetAmount: 'NaN이상한값' }],
  });
  assert.strictEqual(data.goals[0].targetAmount, 0);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: 목표금액이 음수면 0으로 클램프한다(크기 필드라 음수 무효)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    goals: [{ id: 'g1', name: '목표', targetAmount: -5000 }],
  });
  assert.strictEqual(data.goals[0].targetAmount, 0);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: 목표일(targetDate)이 YYYY-MM-DD 형식이 아니면 null로 보정한다(fmtDateFull이 Invalid Date를 보여주는 것을 방지)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    goals: [{ id: 'g1', name: '목표', targetAmount: 1000, targetDate: 'not-a-date' }],
  });
  assert.strictEqual(data.goals[0].targetDate, null);
  assert.strictEqual(fixedCount, 1);
});
/* app-evolve cycle128: 형식(YYYY-MM-DD)만 보던 정규식은 "2026-13-45"·"2026-02-30"처럼 모양은
 * 맞지만 달력상 존재하지 않는 날짜를 그대로 통과시켰다 — startDate/endDate/maturityDate는 이미
 * csvDateValid()로 달력 유효성까지 검증하는데 targetDate만 빠져 있던 불일치를 수정. */
test('sanitizeBackup: 목표일이 형식은 맞지만 달력상 존재하지 않으면(13월/32일 등) null로 보정한다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    goals: [
      { id: 'g1', name: '목표1', targetAmount: 1000, targetDate: '2026-13-01' },
      { id: 'g2', name: '목표2', targetAmount: 1000, targetDate: '2026-02-30' },
    ],
  });
  assert.strictEqual(data.goals[0].targetDate, null);
  assert.strictEqual(data.goals[1].targetDate, null);
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: 목표일이 올바른 형식이거나 null이면 그대로 둔다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    goals: [
      { id: 'g1', name: '목표1', targetAmount: 1000, targetDate: '2026-12-31' },
      { id: 'g2', name: '목표2', targetAmount: 1000, targetDate: null },
    ],
  });
  assert.strictEqual(data.goals[0].targetDate, '2026-12-31');
  assert.strictEqual(data.goals[1].targetDate, null);
  assert.strictEqual(fixedCount, 0);
});
test('sanitizeBackup: id 없는 목표는 통째로 제거하고, goals가 없거나 배열이 아니어도 터지지 않는다', () => {
  const dropped = sandbox.sanitizeBackup({ txns: [], assets: [], goals: [{ name: '목표', targetAmount: 1000 }] });
  assert.strictEqual(dropped.data.goals.length, 0);
  assert.strictEqual(dropped.droppedCount, 1);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.strictEqual(missing.data.goals.length, 0);
});

/* ---------- sanitizeBackup: DB.inquiries(문의하기 메모, cycle133)도 txns/assets/recurrences/goals와
 * 동일하게 백업 복원·클라우드 풀 경로에서 검증돼야 한다 — 이전에는 이 블록이 아예 없어서
 * id/text 없는 레코드가 그대로 통과됐고, text 없는 레코드는 delInquiry()의 q.text.length에서
 * TypeError로 터졌다(app-evolve cycle137 develop). ---------- */
test('sanitizeBackup: id 없는 문의 메모는 통째로 제거하고, inquiries가 없거나 배열이 아니어도 터지지 않는다', () => {
  const dropped = sandbox.sanitizeBackup({ txns: [], assets: [], inquiries: [{ date: '2026-01-01', text: '메모' }] });
  assert.strictEqual(dropped.data.inquiries.length, 0);
  assert.strictEqual(dropped.droppedCount, 1);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.strictEqual(missing.data.inquiries.length, 0);
  const notArray = sandbox.sanitizeBackup({ txns: [], assets: [], inquiries: { oops: true } });
  assert.strictEqual(notArray.data.inquiries.length, 0);
});
test('sanitizeBackup: text 필드가 없거나 문자열이 아닌 문의 메모는 빈 문자열로 정규화하고 fixedCount를 센다(delInquiry의 q.text.length가 TypeError로 터지는 것을 방지)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    inquiries: [{ id: 'q1', date: '2026-01-01' }, { id: 'q2', date: '2026-01-02', text: 123 }],
  });
  assert.strictEqual(data.inquiries[0].text, '');
  assert.strictEqual(data.inquiries[1].text, '123');
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: text가 정상 문자열인 문의 메모는 그대로 둔다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    inquiries: [{ id: 'q1', date: '2026-01-01', text: '기능 요청' }],
  });
  assert.strictEqual(data.inquiries[0].text, '기능 요청');
  assert.strictEqual(data.inquiries[0].id, 'q1');
  assert.strictEqual(fixedCount, 0);
});

/* ---------- sanitizeBackup: DB.assetQtyLog(fx/gold/stock 수량 변경 기록, app-evolve cycle138)도
 * txns/assets/recurrences/goals/inquiries와 동일하게 백업 복원·클라우드 풀 경로에서 검증돼야
 * 한다 — assetId 없는 레코드는 openAssetQtyLog()가 어느 자산의 기록인지 알 수 없어 무의미하므로
 * 통째로 제거하고, prevQty/newQty는 SANITIZE_QTY_FIELDS와 동일한 수량성 필드라 min 0으로
 * 클램프한다. ---------- */
test('sanitizeBackup: id나 assetId 없는 수량 변경 기록은 통째로 제거하고, assetQtyLog가 없거나 배열이 아니어도 터지지 않는다', () => {
  const droppedNoId = sandbox.sanitizeBackup({ txns: [], assets: [], assetQtyLog: [{ assetId: 'a1', date: '2026-01-01', prevQty: 0, newQty: 10, field: 'stockQty' }] });
  assert.strictEqual(droppedNoId.data.assetQtyLog.length, 0);
  assert.strictEqual(droppedNoId.droppedCount, 1);
  const droppedNoAssetId = sandbox.sanitizeBackup({ txns: [], assets: [], assetQtyLog: [{ id: 'q1', date: '2026-01-01', prevQty: 0, newQty: 10, field: 'stockQty' }] });
  assert.strictEqual(droppedNoAssetId.data.assetQtyLog.length, 0);
  assert.strictEqual(droppedNoAssetId.droppedCount, 1);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.strictEqual(missing.data.assetQtyLog.length, 0);
  const notArray = sandbox.sanitizeBackup({ txns: [], assets: [], assetQtyLog: { oops: true } });
  assert.strictEqual(notArray.data.assetQtyLog.length, 0);
});
test('sanitizeBackup: 수량 변경 기록의 prevQty/newQty가 음수·비정상이면 0으로 클램프하고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    assetQtyLog: [{ id: 'q1', assetId: 'a1', date: '2026-01-01', prevQty: -5, newQty: 'oops', field: 'stockQty' }],
  });
  assert.strictEqual(data.assetQtyLog[0].prevQty, 0);
  assert.strictEqual(data.assetQtyLog[0].newQty, 0);
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: 정상적인 수량 변경 기록은 그대로 둔다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    assetQtyLog: [{ id: 'q1', assetId: 'a1', date: '2026-01-01', prevQty: 10, newQty: 25, field: 'stockQty' }],
  });
  assert.strictEqual(data.assetQtyLog[0].prevQty, 10);
  assert.strictEqual(data.assetQtyLog[0].newQty, 25);
  assert.strictEqual(fixedCount, 0);
});

/* ---------- sanitizeBackup: DB.categories/DB.owners(카테고리·귀속 이름 목록)도 txns/assets/
 * recurrences/goals/inquiries/assetQtyLog와 동일하게 검증돼야 한다 — 이전에는 이 블록이 아예
 * 없어서, obj.categories.income/expense/saving나 obj.owners가 배열이 아니면(손상된 백업·레거시
 * 포맷·오염된 클라우드 문서) 그대로 통과됐다. 파일 복원(restoreBackup)은 migrate()를 try/catch로
 * 감싸 실패해도 되돌리지만, 클라우드 풀 경로(afterCloudAuth 등)는 보호 없이 migrate()를 바로
 * 불러 DB.categories.income.push(ADJUST_CAT)이나 DB.owners.forEach(...)에서 그대로 TypeError로
 * 터진다(app-evolve cycle141 develop). ---------- */
test('sanitizeBackup 없이 손상된 categories를 그대로 migrate()에 넘기면 TypeError로 터진다(버그 재현 — 클라우드 풀 경로는 migrate()를 try/catch 없이 바로 부른다)', () => {
  sandbox.DB = { txns: [], assets: [], recurrences: [], categories: { income: '손상됨', expense: [], saving: [] }, owners: ['나'] };
  assert.throws(() => sandbox.migrate());
});
test('sanitizeBackup 없이 손상된 owners를 그대로 addOwner()에 넘기면 TypeError로 터진다(버그 재현 — DB.owners.find/push가 문자열엔 없음)', () => {
  sandbox.DB = { owners: '손상됨' };
  sandbox.newOwnerValue = '배우자';
  assert.throws(() => sandbox.addOwner());
});
// vm 샌드박스 안에서 만들어진 배열은 host의 Array와 realm이 달라 deepStrictEqual이
// (값은 같아도) 실패하므로(위 recDates와 동일한 이유), Array.from으로 host realm 배열로
// 정규화한 뒤 비교한다.
test('sanitizeBackup: categories.expense/income/saving가 배열이 아니면 빈 배열로 되돌리고 fixedCount를 센다(migrate()가 이어서 기본 카테고리로 채움)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    categories: { expense: '식비,교통', income: ['급여'], saving: null },
  });
  assert.deepStrictEqual(Array.from(data.categories.expense), []);
  assert.deepStrictEqual(Array.from(data.categories.income), ['급여']);
  assert.deepStrictEqual(Array.from(data.categories.saving), []);
  assert.strictEqual(fixedCount, 1, 'saving:null은 undefined와 동일하게 migrate()가 조용히 기본값으로 메우므로 fixedCount에 넣지 않는다');
  assert.doesNotThrow(() => { sandbox.DB = data; sandbox.migrate(); });
});
test('sanitizeBackup: categories 배열 안의 문자열이 아니거나 빈 값인 항목은 걸러내고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    categories: { expense: ['식비', 123, '', '  ', null], income: [], saving: [] },
  });
  assert.deepStrictEqual(Array.from(data.categories.expense), ['식비']);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: 정상적인 categories는 그대로 두고, categories가 없어도 터지지 않는다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    categories: { expense: ['식비', '교통'], income: ['급여'], saving: ['저축'] },
  });
  assert.deepStrictEqual(Array.from(data.categories.expense), ['식비', '교통']);
  assert.deepStrictEqual(Array.from(data.categories.income), ['급여']);
  assert.deepStrictEqual(Array.from(data.categories.saving), ['저축']);
  assert.strictEqual(fixedCount, 0);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.deepStrictEqual(Array.from(missing.data.categories.expense), []);
  assert.deepStrictEqual(Array.from(missing.data.categories.income), []);
  assert.deepStrictEqual(Array.from(missing.data.categories.saving), []);
  assert.strictEqual(missing.fixedCount, 0);
});
test('sanitizeBackup: owners가 배열이 아니면 빈 배열로 되돌리고 fixedCount를 센다(migrate()가 이어서 기본 귀속으로 채움)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({ txns: [], assets: [], owners: '나,배우자' });
  assert.deepStrictEqual(Array.from(data.owners), []);
  assert.strictEqual(fixedCount, 1);
  assert.doesNotThrow(() => { sandbox.DB = data; sandbox.migrate(); });
});
test('sanitizeBackup: owners 배열 안의 문자열이 아니거나 빈 값인 항목은 걸러낸다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({ txns: [], assets: [], owners: ['나', '', 42, '배우자'] });
  assert.deepStrictEqual(Array.from(data.owners), ['나', '배우자']);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: 정상적인 owners는 그대로 둔다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({ txns: [], assets: [], owners: ['나', '배우자'] });
  assert.deepStrictEqual(Array.from(data.owners), ['나', '배우자']);
  assert.strictEqual(fixedCount, 0);
});

/* ---------- sanitizeBackup: DB.budgetHistory(카테고리→[{from:"YYYY-MM",amount}])도 같은 이유로
 * 검증이 없었다 — from이 깨지면 budgetForMonth()가, amount가 음수/NaN이면 budgetProgress()·
 * totalBudgetSummary()가 조용히 오염(NaN 전파)된다. ---------- */
test('sanitizeBackup: budgetHistory 항목의 from이 "YYYY-MM" 형식이 아니면 그 항목만 제거하고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    budgetHistory: { 식비: [{ from: '2026-01', amount: 300000 }, { from: 'not-a-month', amount: 100000 }, { from: '2026-13', amount: 1 }] },
  });
  assert.strictEqual(data.budgetHistory['식비'].length, 1);
  assert.strictEqual(data.budgetHistory['식비'][0].from, '2026-01');
  assert.strictEqual(data.budgetHistory['식비'][0].amount, 300000);
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: budgetHistory amount가 음수/NaN이면 0으로 클램프하고 fixedCount를 센다(크기 필드라 음수 무효)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    budgetHistory: { 식비: [{ from: '2026-01', amount: -5000 }, { from: '2026-02', amount: 'NaN이상한값' }] },
  });
  assert.strictEqual(data.budgetHistory['식비'][0].amount, 0);
  assert.strictEqual(data.budgetHistory['식비'][1].amount, 0);
  assert.strictEqual(fixedCount, 2);
});
test('sanitizeBackup: budgetHistory 카테고리 값이 배열이 아니면 빈 배열로 되돌리고, budgetHistory가 없거나 객체가 아니어도 터지지 않는다', () => {
  const notArrayPerCat = sandbox.sanitizeBackup({ txns: [], assets: [], budgetHistory: { 식비: 'oops' } });
  assert.strictEqual(notArrayPerCat.data.budgetHistory['식비'].length, 0);
  assert.strictEqual(notArrayPerCat.fixedCount, 1);
  const notObject = sandbox.sanitizeBackup({ txns: [], assets: [], budgetHistory: ['oops'] });
  assert.strictEqual(Object.keys(notObject.data.budgetHistory).length, 0);
  assert.strictEqual(notObject.fixedCount, 1);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.strictEqual(Object.keys(missing.data.budgetHistory).length, 0);
  assert.strictEqual(missing.fixedCount, 0);
});
test('sanitizeBackup: 정상적인 budgetHistory는 from 오름차순으로 정렬해 그대로 둔다(setBudgetFrom과 동일한 불변식, 정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    budgetHistory: { 식비: [{ from: '2026-03', amount: 100 }, { from: '2026-01', amount: 200 }] },
  });
  assert.strictEqual(data.budgetHistory['식비'][0].from, '2026-01');
  assert.strictEqual(data.budgetHistory['식비'][0].amount, 200);
  assert.strictEqual(data.budgetHistory['식비'][1].from, '2026-03');
  assert.strictEqual(data.budgetHistory['식비'][1].amount, 100);
  assert.strictEqual(fixedCount, 0);
});

/* ---------- sanitizeBackup: DB.budgets(budgetHistory 신설 전 시간축 없는 레거시 flat 맵,
 * 카테고리→금액)는 migrate()의 1회 변환(DB._budgetHistV1 가드)이 이 값을 그대로
 * budgetHistory[cat]=[{from:BUDGET_EPOCH,amount}]에 복사해 넣으므로, budgetHistory의 amount와
 * 동일하게 검증해야 한다. ---------- */
test('sanitizeBackup: budgets의 NaN/문자열 값을 0으로 보정하고 fixedCount를 센다(migrate()가 그대로 budgetHistory로 복사하는 값이라 budgetHistory.amount와 동일 기준)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    budgets: { 식비: 'abc', 교통: 300000 },
  });
  assert.strictEqual(data.budgets['식비'], 0);
  assert.strictEqual(data.budgets['교통'], 300000);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: budgets 값이 음수면 0으로 클램프한다(budgetHistory.amount와 동일 — 크기 필드라 음수 무효)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    budgets: { 식비: -5000 },
  });
  assert.strictEqual(data.budgets['식비'], 0);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: budgets가 객체가 아니면(배열 등) 빈 맵으로 되돌리고, budgets가 없거나 객체가 아니어도 터지지 않는다', () => {
  const notObject = sandbox.sanitizeBackup({ txns: [], assets: [], budgets: ['oops'] });
  assert.strictEqual(Object.keys(notObject.data.budgets).length, 0);
  assert.strictEqual(notObject.fixedCount, 1);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.strictEqual(Object.keys(missing.data.budgets).length, 0);
  assert.strictEqual(missing.fixedCount, 0);
});
test('sanitizeBackup: 정상적인 budgets는 그대로 둔다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    budgets: { 식비: 300000, 교통: 50000 },
  });
  assert.strictEqual(data.budgets['식비'], 300000);
  assert.strictEqual(data.budgets['교통'], 50000);
  assert.strictEqual(fixedCount, 0);
});
test('sanitizeBackup: 손상된 budgets 값을 보정하지 않은 채 두면 migrate()의 1회 변환이 그 값을 그대로 budgetHistory로 복사해 budgetForMonth()가 깨진 값을 돌려준다(버그 재현 — 보정된 data를 쓰면 정상 숫자가 나와야 함)', () => {
  const { data } = sandbox.sanitizeBackup({ txns: [], assets: [], budgets: { 식비: 'abc' } });
  sandbox.DB = { budgets: data.budgets, budgetHistory: {} };
  sandbox.migrate();
  assert.strictEqual(sandbox.DB.budgetHistory['식비'][0].amount, 0, 'sanitizeBackup이 보정했으므로 migrate() 변환 후에도 숫자 0이어야 함(원래 버그였다면 문자열 "abc"가 그대로 들어갔을 것)');
});

/* ---------- sanitizeBackup: catIcon/catVar(카테고리 아이콘·변동 카테고리 플래그)·deletedType/
 * deletedBal(삭제된 자산 재연동용 타입·잔액 기억)은 모두 '타입:이름'(또는 자산명) → 값의 평평한
 * 객체 맵이다 — 배열 등 다른 타입이 들어오면 mergeFlatMap()의 Object.assign이 데이터를 뒤튼다. ---------- */
test('sanitizeBackup: catIcon/catVar/deletedType/deletedBal이 객체가 아니면(배열 등) 빈 맵으로 되돌리고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    catIcon: ['oops'], catVar: 'oops', deletedType: 123, deletedBal: null,
  });
  assert.strictEqual(Object.keys(data.catIcon).length, 0);
  assert.strictEqual(Object.keys(data.catVar).length, 0);
  assert.strictEqual(Object.keys(data.deletedType).length, 0);
  assert.strictEqual(Object.keys(data.deletedBal).length, 0);
  assert.strictEqual(fixedCount, 3); // deletedBal:null은 '없음'과 동일하게 취급(fixedCount 제외)
});
test('sanitizeBackup: 정상적인 catIcon/catVar/deletedType/deletedBal은 그대로 두고, 없어도 터지지 않는다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    catIcon: { 'expense:식비': 'food' }, catVar: { 'expense:용돈': true },
    deletedType: { '옛통장': 'cash' }, deletedBal: { '옛통장': 10000 },
  });
  assert.strictEqual(data.catIcon['expense:식비'], 'food');
  assert.strictEqual(data.catVar['expense:용돈'], true);
  assert.strictEqual(data.deletedType['옛통장'], 'cash');
  assert.strictEqual(data.deletedBal['옛통장'], 10000);
  assert.strictEqual(fixedCount, 0);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.strictEqual(Object.keys(missing.data.catIcon).length, 0);
  assert.strictEqual(Object.keys(missing.data.deletedBal).length, 0);
});

/* ---------- sanitizeBackup: DB.nwHistory(순자산 추이 일별 스냅샷)도 txns/assets/recurrences/goals/
 * inquiries/assetQtyLog/categories/owners/budgetHistory와 동일하게 검증돼야 한다 — afterCloudAuth()의
 * 미동기화 없음 분기/resolveCloudPullRemote()는 mergeRemoteDataIntoLocal()을 거치지 않고
 * DB=sanitizeBackup(remote).data로 통째로 교체하므로, 원격 문서의 nwHistory가 손상돼 있으면 그대로
 * 이 기기 DB에 들어온다. 검증 없이 두면 다음 save() 호출에서 updateNwHistory()가 그 값으로
 * TypeError를 던진다(아래 '버그 재현' 테스트로 확인). ---------- */
test('sanitizeBackup 없이 손상된 nwHistory를 그대로 updateNwHistory()에 넘기면 TypeError로 터진다(버그 재현 — 클라우드 풀 경로는 mergeRemoteDataIntoLocal을 거치지 않고 DB를 통째로 교체한 뒤 save()를 try/catch 없이 바로 부른다)', () => {
  assert.throws(() => sandbox.updateNwHistory('손상됨', '2026-06-01', 100, 10));
  assert.throws(() => sandbox.updateNwHistory({ oops: true }, '2026-06-01', 100, 10));
});
test('sanitizeBackup: nwHistory가 배열이 아니면 빈 배열로 되돌리고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({ txns: [], assets: [], nwHistory: '손상됨' });
  assert.deepStrictEqual(Array.from(data.nwHistory), []);
  assert.strictEqual(fixedCount, 1);
  assert.doesNotThrow(() => sandbox.updateNwHistory(data.nwHistory, '2026-06-01', 100, 10));
});
test('sanitizeBackup: nwHistory 항목에 날짜가 없거나 형식/달력상 무효하면 통째로 제거하고 droppedCount로 센다(csvDateValid와 동일 기준)', () => {
  const { data, droppedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    nwHistory: [
      { ta: 100, td: 10, nw: 90 },
      { date: 'not-a-date', ta: 100, td: 10, nw: 90 },
      { date: '2026-13-01', ta: 100, td: 10, nw: 90 },
      { date: '2026-06-01', ta: 100, td: 10, nw: 90 },
    ],
  });
  assert.strictEqual(data.nwHistory.length, 1);
  assert.strictEqual(data.nwHistory[0].date, '2026-06-01');
  assert.strictEqual(droppedCount, 3);
});
test('sanitizeBackup: nwHistory의 ta/td가 NaN/문자열/음수면 0으로 클램프하고, nw는 그 값으로 다시 계산해 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    nwHistory: [{ date: '2026-06-01', ta: 'NaN이상한값', td: -10, nw: 999 }],
  });
  assert.strictEqual(data.nwHistory[0].ta, 0);
  assert.strictEqual(data.nwHistory[0].td, 0);
  assert.strictEqual(data.nwHistory[0].nw, 0);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: nwHistory의 byOwner가 일반 객체가 아니면(배열 등) 그 필드만 떨어뜨리고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    nwHistory: [{ date: '2026-06-01', ta: 100, td: 10, nw: 90, byOwner: ['oops'] }],
  });
  assert.strictEqual(data.nwHistory[0].byOwner, undefined);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: nwHistory의 byOwner는 객체라도 내부 귀속별 ta/td가 NaN/문자열이면 top-level ta/td와 동일하게 0으로 클램프하고, 귀속 값 자체가 객체가 아니면 그 귀속만 떨어뜨린다(nwHistoryForOwner/goalProgress가 b.ta-b.td를 그대로 계산에 씀)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    nwHistory: [{ date: '2026-06-01', ta: 100, td: 10, nw: 90, byOwner: { 나: { ta: 'oops', td: -5 }, 배우자: 'not-an-object' } }],
  });
  // vm 샌드박스에서 만들어진 객체는 host의 Object와 realm이 달라 deepStrictEqual이
  // 실패하므로(값은 같아도 프로토타입이 다름), 필드별로 비교한다.
  assert.deepStrictEqual(Object.keys(data.nwHistory[0].byOwner), ['나']);
  assert.strictEqual(data.nwHistory[0].byOwner.나.ta, 0);
  assert.strictEqual(data.nwHistory[0].byOwner.나.td, 0);
  assert.strictEqual(fixedCount, 2); /* 나.ta/나.td 클램프 1건 + 배우자 통째로 떨어뜨림 1건 */
});
test('sanitizeBackup: 정상적인 nwHistory는 그대로 두고, 없어도 터지지 않는다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    nwHistory: [{ date: '2026-06-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 300, td: 20 } } }],
  });
  assert.strictEqual(data.nwHistory[0].ta, 300);
  assert.strictEqual(data.nwHistory[0].td, 20);
  assert.strictEqual(data.nwHistory[0].nw, 280);
  assert.deepStrictEqual(Object.keys(data.nwHistory[0].byOwner), ['나']);
  assert.strictEqual(data.nwHistory[0].byOwner.나.ta, 300);
  assert.strictEqual(data.nwHistory[0].byOwner.나.td, 20);
  assert.strictEqual(fixedCount, 0);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.deepStrictEqual(Array.from(missing.data.nwHistory), []);
  assert.strictEqual(missing.fixedCount, 0);
});

/* ---------- sanitizeBackup: DB.deletedIds({id:삭제시각(ms)} 톰스톤 맵)도 검증돼야 한다 — catIcon/
 * catVar/deletedType/deletedBal과 같은 평평한 맵이지만, 그쪽의 sanitizeFlatMap은 객체 형태만
 * 보고 값 타입은 안 본다. mergeCollection()(logic.js)과 mergeRemoteDataIntoLocal()이 이 값을
 * (r.updatedAt||0)>delLocalTs처럼 순수 숫자 비교로만 쓰므로, 값이 숫자가 아니면 Number>NaN이
 * 항상 false가 되어 삭제 뒤 다른 기기에서 수정된 사본을 살리는 복구 경로가 조용히 막힌다. ---------- */
test('sanitizeBackup 없이 손상된(비숫자) deletedIds 톰스톤을 그대로 mergeCollection()에 넘기면 수정된 원격 사본을 못 살린다(버그 재현)', () => {
  const remote = [{ id: 't1', updatedAt: 999999 }]; // 삭제 시각보다 훨씬 나중에 수정된 사본
  const out = sandbox.mergeCollection([], remote, { t1: '2026-01-01T00:00:00Z' }, {});
  assert.strictEqual(out.length, 0, 'ISO 문자열 톰스톤은 숫자 비교에서 항상 false가 되어 수정된 사본이 영구 소실됨');
});
test('sanitizeBackup: deletedIds가 객체가 아니면 빈 맵으로 되돌리고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({ txns: [], assets: [], deletedIds: '손상됨' });
  assert.deepStrictEqual(Object.keys(data.deletedIds), []);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: deletedIds 값이 숫자가 아니면(ISO 문자열 등) 그 id만 제거하고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    deletedIds: { t1: '2026-01-01T00:00:00Z', t2: 1700000000000, t3: 'not-a-number' },
  });
  assert.deepStrictEqual(Object.keys(data.deletedIds), ['t2']);
  assert.strictEqual(data.deletedIds.t2, 1700000000000);
  assert.strictEqual(fixedCount, 2);
  // 정규화된 뒤에는 mergeCollection이 의도대로 동작한다(비교 가능한 숫자만 남음).
  const out = sandbox.mergeCollection([], [{ id: 't2', updatedAt: 1800000000000 }], data.deletedIds, {});
  assert.strictEqual(out.length, 1, '정규화된 숫자 톰스톤은 더 나중에 수정된 원격 사본을 정상적으로 살려야 함');
});
test('sanitizeBackup: 정상적인 deletedIds는 그대로 두고, 없어도 터지지 않는다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({ txns: [], assets: [], deletedIds: { t1: 1700000000000 } });
  assert.strictEqual(data.deletedIds.t1, 1700000000000);
  assert.strictEqual(fixedCount, 0);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.deepStrictEqual(Object.keys(missing.data.deletedIds), []);
  assert.strictEqual(missing.fixedCount, 0);
});

/* ---------- sanitizeBackup: DB.settings도 검증돼야 한다 — categories/owners/budgetHistory/catIcon류/
 * deletedIds/nwHistory와 달리 지금까지 전혀 검증되지 않던 유일한 컬렉션이었다. dismissedStaleMvIds는
 * new Set(DB.settings.dismissedStaleMvIds||[])로 직접 소비되는데, truthy한 비배열 값(객체/숫자)이면
 * new Set()이 "not iterable" TypeError를 던진다(homeAlerts 경로라 바깥 try/catch가 삼켜 조용히 매
 * 렌더마다 깨짐). ---------- */
test('sanitizeBackup 없이 손상된(객체) dismissedStaleMvIds를 그대로 new Set()에 넘기면 TypeError가 난다(버그 재현)', () => {
  assert.throws(() => new Set({ x: 1 }), TypeError);
});
test('sanitizeBackup: settings가 객체가 아니면 빈 객체로 되돌리고 fixedCount를 센다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({ txns: [], assets: [], settings: '손상됨' });
  // vm 샌드박스 안에서 만들어진 {}는 host의 Object와 realm이 달라 deepStrictEqual이 (값은 같아도)
  // 실패하므로, JSON round-trip으로 host realm 구조로 정규화해 비교한다.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(data.settings)), {});
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: settings.dismissedStaleMvIds가 배열이 아니면(객체/숫자) 빈 배열로 정규화해 new Set()이 안전해진다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [], settings: { dismissedStaleMvIds: { x: 1 } },
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(data.settings.dismissedStaleMvIds)), []);
  assert.strictEqual(fixedCount, 1);
  assert.doesNotThrow(() => new Set(data.settings.dismissedStaleMvIds));
});
test('sanitizeBackup: settings.dismissedStaleMvIds 배열 안에 문자열이 아닌 항목이 섞여 있으면 그 항목만 걸러낸다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [], settings: { dismissedStaleMvIds: ['a:b', 1, null, 'c:d'] },
  });
  assert.deepStrictEqual(data.settings.dismissedStaleMvIds, ['a:b', 'c:d']);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: settings.groupOrder가 배열이 아니면 기본 그룹 순서로 되돌린다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [], settings: { groupOrder: '손상됨' },
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(data.settings.groupOrder)), [...sandbox.DEFAULT_GROUP_ORDER]);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: settings.groupOrder 배열 안에 문자열이 아닌 항목이 섞여 있으면 그 항목만 걸러낸다', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [], settings: { groupOrder: ['cash', 5, 'stock'] },
  });
  assert.deepStrictEqual(data.settings.groupOrder, ['cash', 'stock']);
  assert.strictEqual(fixedCount, 1);
});
test('sanitizeBackup: 정상적인 settings는 그대로 두고, 없어도 터지지 않는다(정상 케이스는 회귀 없음)', () => {
  const { data, fixedCount } = sandbox.sanitizeBackup({
    txns: [], assets: [],
    settings: { themeMode: 'dark', confirmTransfers: false, dismissedStaleMvIds: ['a:b'], groupOrder: ['cash', 'stock'] },
  });
  assert.strictEqual(data.settings.themeMode, 'dark');
  assert.strictEqual(data.settings.confirmTransfers, false);
  assert.deepStrictEqual(data.settings.dismissedStaleMvIds, ['a:b']);
  assert.deepStrictEqual(data.settings.groupOrder, ['cash', 'stock']);
  assert.strictEqual(fixedCount, 0);
  const missing = sandbox.sanitizeBackup({ txns: [], assets: [] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(missing.data.settings)), {});
  assert.strictEqual(missing.fixedCount, 0);
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

/* ---------- spendTrend/spendTrendBadge: 지출 분석의 최근 3개월 평균/지난달 대비 증감 배지 ---------- */
test('spendTrend: 최근 3개월 평균보다 이번 달에 더 썼으면 양수 deltaPct를 반환한다', () => {
  sandbox.DB = {
    txns: [
      { date: '2026-03-05', type: 'expense', category: '식비', amount: 100000 }, // 3월
      { date: '2026-04-05', type: 'expense', category: '식비', amount: 100000 }, // 4월
      { date: '2026-05-05', type: 'expense', category: '식비', amount: 100000 }, // 5월(=지난달)
      { date: '2026-06-05', type: 'expense', category: '식비', amount: 200000 }, // 6월(이번 달)
    ],
    recurrences: [],
  };
  const t = sandbox.spendTrend('식비', 2026, 6);
  assert.strictEqual(t.avg, 100000, '최근 3개월(3~5월) 평균은 이번 달을 빼고 계산해야 함');
  assert.strictEqual(t.prevMonth, 100000, '지난달(5월) 지출');
  assert.strictEqual(t.deltaPct, 100, '10만원 평균 대비 20만원 지출은 +100%');
});
test('spendTrend: 최근 3개월치 지출이 전혀 없으면(avg=0) deltaPct는 비교 기준이 없어 null이다', () => {
  sandbox.DB = {
    txns: [{ date: '2026-06-05', type: 'expense', category: '식비', amount: 50000 }],
    recurrences: [],
  };
  const t = sandbox.spendTrend('식비', 2026, 6);
  assert.strictEqual(t.avg, 0);
  assert.strictEqual(t.deltaPct, null);
});
test('spendTrend: 연초(1월)를 조회하면 이전 해로 넘어가 최근 3개월을 계산한다', () => {
  sandbox.DB = {
    txns: [
      { date: '2025-10-05', type: 'expense', category: '식비', amount: 30000 },
      { date: '2025-11-05', type: 'expense', category: '식비', amount: 30000 },
      { date: '2025-12-05', type: 'expense', category: '식비', amount: 30000 },
      { date: '2026-01-05', type: 'expense', category: '식비', amount: 60000 },
    ],
    recurrences: [],
  };
  const t = sandbox.spendTrend('식비', 2026, 1);
  assert.strictEqual(t.avg, 30000);
  assert.strictEqual(t.prevMonth, 30000, '전월(2025-12) 지출');
  assert.strictEqual(t.deltaPct, 100);
});
test('spendTrendBadge: deltaPct가 null이면 배지를 렌더하지 않는다', () => {
  assert.strictEqual(sandbox.spendTrendBadge(null), '');
});
test('spendTrendBadge: 양수(지출 증가)는 expense색 위쪽 화살표를, 음수(지출 감소)는 income색 아래쪽 화살표를 쓴다', () => {
  assert.match(sandbox.spendTrendBadge(25), /var\(--expense\)/);
  assert.match(sandbox.spendTrendBadge(25), /▲25%/);
  assert.match(sandbox.spendTrendBadge(-10), /var\(--income\)/);
  assert.match(sandbox.spendTrendBadge(-10), /▼10%/);
});
test('spendTrendBadge: deltaPct가 0이면 화살표 없이 중립색으로 표시한다', () => {
  const html = sandbox.spendTrendBadge(0);
  assert.match(html, /var\(--text-3\)/);
  assert.match(html, />0%</);
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

/* ---------- planGaugeCard: 홈 "저축" 게이지는 이체(transfer)를 저축과 섞으면 안 된다 ---------- */
test('planGaugeCard: 계좌 간 이체가 있어도 저축 게이지의 실제/예정 금액은 saving 금액만 반영한다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.DB = {
    settings: {},
    txns: [
      { id: 't1', type: 'saving', date: '2026-06-05', amount: 50000 },
      { id: 't2', type: 'transfer', date: '2026-06-10', amount: 500000 },
      { id: 't3', type: 'saving', date: '2026-06-20', amount: 50000 }, // 미래 회차(예정)
    ],
    recurrences: [],
  };
  const S = sandbox.monthStats(2026, 6);
  const html = sandbox.planGaugeCard(S, 2026, 6);
  const savingRow = html.split('pg-row')[3]; // 수입/지출/저축 순서 중 세 번째 행
  assert.ok(savingRow.includes(sandbox.comma(50000))); // 실제(오늘까지)는 saving 50000뿐, transfer 500000은 섞이지 않음
  assert.ok(savingRow.includes(sandbox.comma(100000))); // 예정(plan)도 saving 50000+50000=100000뿐
  assert.ok(!savingRow.includes(sandbox.comma(550000)));
  assert.ok(!savingRow.includes(sandbox.comma(600000)));
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
test('toggleConfirmTransfers: 아직 도래하지 않은(미래 날짜) 일반 이체만 있으면 확인 시트 없이 바로 꺼지고, 그 이체는 미확정으로 남는다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  const future = { id: 't1', type: 'transfer', date: '2026-06-20', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [future], recurrences: [] };
  sandbox.toggleConfirmTransfers();
  assert.strictEqual(sandbox.confirmSheetCalls.length, 0, '미래 이체만으로는 확인 시트가 뜨면 안 됨');
  assert.strictEqual(sandbox.DB.settings.confirmTransfers, false);
  assert.strictEqual(future.confirmed, false, '아직 도래하지 않은 이체는 조기 확정되면 안 됨');
});
test('toggleConfirmTransfers: 도래한 이체와 미래 이체가 섞여 있으면 도래한 것만 세고 확정하며, 미래 것은 그대로 둔다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  const due = { id: 't1', type: 'transfer', date: '2026-06-10', confirmed: false, amount: 5000 };
  const future = { id: 't2', type: 'transfer', date: '2026-06-20', confirmed: false, amount: 7000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [due, future], recurrences: [] };
  sandbox.toggleConfirmTransfers();
  assert.ok(sandbox.confirmSheetCalls[0].msg.includes('1건'), '미래 이체는 대기 건수에서 빠져야 함');
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(due.confirmed, true, '도래한 이체는 확정돼야 함');
  assert.strictEqual(future.confirmed, false, '미래 이체는 확정되면 안 됨');
});
test('toggleConfirmTransfers: 오늘 날짜 일반 이체는 도래한 것으로 취급돼 확정 대상에 포함된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  const today = { id: 't1', type: 'transfer', date: '2026-06-15', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [today], recurrences: [] };
  sandbox.toggleConfirmTransfers();
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1);
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(today.confirmed, true);
});
/* ---------- toggleConfirmTransfers: "끄기" 콜백이 pendingOneOff/pendingRecList를 일괄
 * confirmed=true/confirmedDates.push()로 고치면서 touch()를 전혀 안 불러, mergeCollection()이
 * updatedAt만 보고 승자를 고르는 cloud sync에서 다른 기기의 더 오래된 사본이 이겨 이 일괄 확인
 * 처리가 조용히 되돌아갈 위험이 있었다(app-evolve cycle128 advance, doMaturity/toggleRecActive/
 * toggleAdjustSurplus 쪽과 같은 패턴). ---------- */
test('toggleConfirmTransfers: "끄기"를 누르면 일괄 확인 처리된 일반 이체/반복거래 모두에 touch()가 호출된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.confirmSheetCalls = [];
  const rec = pendingRec();
  const oneOff = { id: 't1', type: 'transfer', date: '2026-06-10', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [oneOff], recurrences: [rec] };
  sandbox.toggleConfirmTransfers();
  sandbox.confirmSheetCalls[0].cb();
  assert.strictEqual(oneOff.updatedAt, 'test-updatedAt', '일괄 확인된 일반 이체에도 touch()가 호출되어야 함');
  assert.strictEqual(rec.updatedAt, 'test-updatedAt', '도래 회차가 기록된 반복거래에도 touch()가 호출되어야 함');
});

/* ---------- rollPendingTransfers: 이체 확인이 켜진 상태에서 기한이 지난(과거 날짜) 미확인 이체를 오늘로 당긴다 ---------- */
test('rollPendingTransfers: 이체 확인이 꺼져 있으면 아무것도 하지 않는다', () => {
  sandbox.TODAY = '2026-06-15';
  const overdue = { id: 't1', type: 'transfer', date: '2026-06-10', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: false }, txns: [overdue] };
  sandbox.rollPendingTransfers();
  assert.strictEqual(overdue.date, '2026-06-10');
});
test('rollPendingTransfers: 기한이 지난 미확인 일반 이체는 오늘 날짜로 당겨진다', () => {
  sandbox.TODAY = '2026-06-15';
  const overdue = { id: 't1', type: 'transfer', date: '2026-06-10', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [overdue] };
  sandbox.rollPendingTransfers();
  assert.strictEqual(overdue.date, '2026-06-15');
});
test('rollPendingTransfers: 아직 도래하지 않은(미래) 미확인 이체는 건드리지 않는다', () => {
  sandbox.TODAY = '2026-06-15';
  const future = { id: 't1', type: 'transfer', date: '2026-06-20', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [future] };
  sandbox.rollPendingTransfers();
  assert.strictEqual(future.date, '2026-06-20', '미래 이체는 앞당겨지면 안 됨');
});
test('rollPendingTransfers: 이미 확정된(confirmed:true) 이체는 날짜와 무관하게 건드리지 않는다', () => {
  sandbox.TODAY = '2026-06-15';
  const confirmed = { id: 't1', type: 'transfer', date: '2026-06-10', confirmed: true, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [confirmed] };
  sandbox.rollPendingTransfers();
  assert.strictEqual(confirmed.date, '2026-06-10');
});
/* ---------- rollPendingTransfers: 날짜를 오늘로 당긴 이체에도 touch()로 updatedAt이 갱신돼야 함 (app-evolve cycle93 develop) ----------
 * doRenameOwner/doRenameCat과 동일한 이유로, mergeCollection()의 3-way 병합은 updatedAt만 보고 승자를
 * 고른다. rollPendingTransfers()는 앱 로드 시(및 confirmTransfers 설정 토글 시) 기한이 지난 미확인
 * 이체의 date를 오늘로 밀지만 touch()를 부르지 않아, 다른 기기가 오프라인 중 같은 이체의 다른 필드만
 * 더 나중에 고쳤다면(그래서 그 기기의 updatedAt이 더 최신이라면) 병합 시 옛 날짜가 실린 원격 사본이
 * 이겨 방금 앞당긴 날짜가 조용히 되돌아갈 수 있었다. */
test('rollPendingTransfers: 날짜가 앞당겨진 이체에는 touch()가 호출돼 updatedAt이 갱신된다', () => {
  sandbox.TODAY = '2026-06-15';
  const overdue = { id: 't1', type: 'transfer', date: '2026-06-10', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [overdue] };
  sandbox.rollPendingTransfers();
  assert.strictEqual(overdue.updatedAt, 'test-updatedAt', '날짜가 앞당겨진 이체에는 touch()가 호출되어야 함');
});
test('rollPendingTransfers: 건드리지 않는(미래·확정·기능꺼짐) 이체는 touch()도 호출되지 않는다', () => {
  sandbox.TODAY = '2026-06-15';
  const future = { id: 't1', type: 'transfer', date: '2026-06-20', confirmed: false, amount: 5000 };
  sandbox.DB = { settings: { confirmTransfers: true }, txns: [future] };
  sandbox.rollPendingTransfers();
  assert.strictEqual(future.updatedAt, undefined, '건드리지 않은 이체의 updatedAt은 그대로여야 함');
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

/* ---------- saveAsset: 동명·동종 중복 차단이 완전 일치(===)만 잡아, 대소문자나 연속 공백
 * 개수만 다른 이름은 통과시키던 버그(app-evolve cycle89 develop, Explore 서브에이전트로 발견).
 * addCat/doRenameCat/addOwner/doRenameOwner는 이미 normName()으로 근접 중복을 막는데
 * (cycle85 advance) saveAsset()만 a.name===d.name 완전일치만 검사해 "Woori Bank"와
 * "woori   bank"(공백 개수만 다름, normName의 trim+연속공백1칸 축약+소문자화로는 같아짐) 같은
 * 이름이 같은 종류로 각각 별개 자산으로 등록될 수 있었다(주의: normName은 공백을 아예 없애지
 * 않고 "연속 공백을 한 칸으로" 축약할 뿐이라 "우리은행"과 "우리 은행"처럼 공백 유무 자체가
 * 다른 경우는 여전히 서로 다른 이름으로 취급됨). dup 판정을 normName() 비교로 교체하고,
 * 완전일치일 때는 기존 문구를, 근접 중복일 때는 category/owner와 같은 톤으로 어떤 자산과
 * 비슷한지 알려주는 문구를 띄우도록 함. ---------- */
test('saveAsset: 대소문자·연속 공백 개수만 다른 동종 자산 이름도 근접 중복으로 차단된다', () => {
  sandbox.DB = { assets: [{ id: 'a1', name: 'Woori Bank', type: 'cash', baseAmount: 1000 }], rates: { stocks: {} } };
  sandbox.asDraft = { name: 'woori   bank', type: 'cash', includeInTotal: true };
  sandbox.lastToast = null;
  sandbox.saveAsset(false);
  assert.ok(sandbox.lastToast, '근접 중복 경고 토스트가 떴어야 함');
  assert.ok(sandbox.lastToast.includes('Woori Bank'), '어떤 자산과 비슷한지 알려줘야 함');
  assert.strictEqual(sandbox.DB.assets.length, 1, '근접 중복이면 새 자산이 추가되면 안 됨');
});
test('saveAsset: 이름이 같아도 종류(type)가 다르면 여전히 중복이 아니다', () => {
  sandbox.DB = { assets: [{ id: 'a1', name: '비상금', type: 'cash', baseAmount: 1000 }], rates: { stocks: {} } };
  sandbox.asDraft = { name: '비상금', type: 'savings', includeInTotal: true };
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 2, '종류가 다르면 새 자산이 등록돼야 함');
  assert.strictEqual(sandbox.DB.assets[1].name, '비상금', '종류가 다르면 이름이 같아도 그대로 등록돼야 함');
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

/* ---------- CURRENCY_LIST: FX 자산 등록 시트가 하드코딩 3종(USD/JPY/EUR) 버튼 대신 피커
 * 시트로 골라 쓰는 통화 큐레이션 목록(app-evolve cycle58 advance). netlify/functions/rates.js는
 * 임의의 ISO 3자리 코드를 다 처리할 수 있지만 UI에서 고를 수 있는 범위는 이 배열이 정한다 —
 * 코드 형식이 깨지거나 중복되면 시세 조회 URL(cur=A,B,C)과 통화 피커가 조용히 망가지므로
 * 순수 데이터 형태를 검증한다. ---------- */
test('CURRENCY_LIST: 모든 코드가 중복 없는 3자리 대문자 ISO 코드이고, 기존 하드코딩 3종(USD/JPY/EUR)을 그대로 포함한다', () => {
  const codes = sandbox.CURRENCY_LIST.map(c => c.code);
  assert.ok(codes.every(c => /^[A-Z]{3}$/.test(c)), '모든 통화 코드는 3자리 대문자여야 함');
  assert.strictEqual(new Set(codes).size, codes.length, '통화 코드가 중복되면 안 됨');
  assert.ok(sandbox.CURRENCY_LIST.every(c => typeof c.label === 'string' && c.label.length > 0), '모든 통화는 표시용 한글 라벨을 가져야 함');
  ['USD', 'JPY', 'EUR'].forEach(c => assert.ok(codes.includes(c), `기존에 하드코딩돼 있던 ${c}가 빠지면 하위호환이 깨짐`));
});

/* ---------- asOpenCur/asCur: FX 자산의 통화 선택이 openCurrencyPicker를 거쳐 asDraft.currency에
 * 반영되는지 검증한다(asOpenType과 같은 패턴 — 실제 DOM 렌더는 스텁이 대신하고, 여기선 현재값이
 * 피커에 올바르게 전달되고 onPick 콜백이 asDraft를 갱신하는 순수 로직만 확인). ---------- */
test('asOpenCur: 현재 통화를 피커에 넘기고, onPick으로 고른 통화가 asDraft.currency에 반영된다', () => {
  // onPick(asCur)이 asDraft.currency를 바꾼 뒤 renderAssetSheet를 재호출하므로(아래 실행형
  // renderAssetSheet 테스트부터 FUNCTIONS에 끌어와 실제 실행), DB.rates.fx가 있어야 함 —
  // 없으면 leftover DB(이전 테스트가 남긴 { rates: { stocks: {} } })로 fx가 없어 크래시한다.
  sandbox.DB = { rates: { fx: {}, stocks: {} } };
  sandbox.asDraft = { id: 'a1', type: 'fx', owner: '나', currency: 'USD', fxAmount: 100 };
  sandbox.asOpenCur();
  assert.strictEqual(sandbox.lastCurrencyPickerCurrent, 'USD', '피커를 열 때 현재 선택된 통화를 넘겨야 함');
  sandbox.lastCurrencyPickerOnPick('THB');
  assert.strictEqual(sandbox.asDraft.currency, 'THB', 'onPick으로 고른 통화가 asDraft.currency에 반영돼야 함(하드코딩 3종 밖의 통화도 선택 가능해야 함)');
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
/* ---------- setRate: 시세 연동 관리 시트에서 입력을 지우면(onchange로 빈 문자열이 넘어옴)
 * n=Number('')||0 으로 0이 되는데, 이걸 그대로 DB.rates.fx/stocks에 저장하면
 * rateUnknown()의 ==null 판정을 피해가 '미확인' 배지 없이 조용히 ₩0으로 평가되던 버그
 * (app-evolve cycle78 critique/advance). fx/stock은 값이 0 이하면 키를 delete해
 * rateUnknown이 계속 미확인으로 보게 하고, gold는 원래 !goldPerG 판정이라 0을 그대로 둬도
 * 이미 미확인 취급됨을 함께 검증. ---------- */
test('setRate: fx 입력을 지우면(빈 문자열) 기존 값이 0으로 저장되지 않고 키가 지워져 미확인 상태로 남는다', () => {
  sandbox.DB = { rates: { fx: { USD: 1350 }, stocks: {}, goldPerG: 0 } };
  assert.strictEqual(sandbox.rateUnknown({ type: 'fx', currency: 'USD' }), false);
  sandbox.setRate('fx', 'USD', '');
  assert.strictEqual(sandbox.DB.rates.fx.USD, undefined, '빈 입력이 0으로 확정 저장되면 안 됨');
  assert.strictEqual(sandbox.rateUnknown({ type: 'fx', currency: 'USD' }), true, '값을 지웠으면 다시 미확인으로 인식돼야 함');
});
test('setRate: stock 입력에 숫자 아닌 값을 넣어도 0으로 저장되지 않고 미확인 상태로 남는다', () => {
  sandbox.DB = { rates: { fx: {}, stocks: { '005930': 70000 }, goldPerG: 0 } };
  sandbox.setRate('stock', '005930', 'abc');
  assert.strictEqual(sandbox.DB.rates.stocks['005930'], undefined);
  assert.strictEqual(sandbox.rateUnknown({ type: 'stock', stockCode: '005930' }), true);
});
test('setRate: 정상적인 숫자 입력은 그대로 저장되고 미확인 상태가 풀린다', () => {
  sandbox.DB = { rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.setRate('fx', 'USD', '1,384.5');
  assert.strictEqual(sandbox.DB.rates.fx.USD, 1384.5);
  assert.strictEqual(sandbox.rateUnknown({ type: 'fx', currency: 'USD' }), false);
  sandbox.setRate('gold', '', '152,000');
  assert.strictEqual(sandbox.DB.rates.goldPerG, 152000);
  assert.strictEqual(sandbox.rateUnknown({ type: 'gold' }), false);
});
test('setRate: gold 입력을 지우면 0으로 저장되지만 rateUnknown은 이미 0을 미확인으로 취급한다', () => {
  sandbox.DB = { rates: { fx: {}, stocks: {}, goldPerG: 152000 } };
  sandbox.setRate('gold', '', '');
  assert.strictEqual(sandbox.DB.rates.goldPerG, 0);
  assert.strictEqual(sandbox.rateUnknown({ type: 'gold' }), true);
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
/* ---------- saveAsset: touch()로 updatedAt 스탬프 (app-evolve cycle86 advance, saveRec 쪽과 동일 목적) ---------- */
test('saveAsset: 신규 등록·기존 수정 모두 touch()로 updatedAt이 채워진다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 10 };
  sandbox.syncRatesCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets[0].updatedAt, 'test-updatedAt', '신규 등록 시 updatedAt이 채워져야 함');

  const asset = { id: 'a1', type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 10 };
  sandbox.DB = { assets: [asset], rates: { fx: {}, stocks: { '005930': 70000 }, goldPerG: 0 } };
  sandbox.asDraft = { id: 'a1', type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 20 };
  sandbox.saveAsset(true);
  assert.strictEqual(sandbox.DB.assets[0].updatedAt, 'test-updatedAt', '수정 시에도 updatedAt이 갱신되어야 함');
});
/* ---------- saveAsset: fx/gold/stock(isMarketValued) 수량을 수정하면 DB.assetQtyLog에 변경 전/후
 * 수량이 기록된다(app-evolve cycle138 advance). cash/savings 등(balType)은 수정 시 addBalanceAdjust/
 * updateBalanceAdjust로 거래가 남아 '내역 보기'에서 추적되는데, fx/gold/stock은 saveAsset()이
 * 수량을 그냥 덮어써서 언제·얼마나 바뀌었는지 아무 기록도 없었고, 그 '내역 보기' 버튼도
 * matchesAssetId()가 거래에서 못 찾아 항상 빈 화면으로 가는 막다른 길이었다. ---------- */
test('saveAsset: 주식 보유 수량을 수정하면 DB.assetQtyLog에 변경 전/후 수량이 기록된다', () => {
  const asset = { id: 'a1', type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 10 };
  sandbox.DB = { assets: [asset], assetQtyLog: [], rates: { fx: {}, stocks: { '005930': 70000 }, goldPerG: 0 } };
  sandbox.asDraft = { id: 'a1', type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 25 };
  sandbox.saveAsset(true);
  assert.strictEqual(sandbox.DB.assets[0].stockQty, 25, '자산의 실제 보유수량도 새 값으로 저장돼야 함');
  assert.strictEqual(sandbox.DB.assetQtyLog.length, 1, '수량이 바뀌었으니 기록이 정확히 한 건 남아야 함');
  const log = sandbox.DB.assetQtyLog[0];
  assert.strictEqual(log.assetId, 'a1');
  assert.strictEqual(log.field, 'stockQty');
  assert.strictEqual(log.prevQty, 10);
  assert.strictEqual(log.newQty, 25);
  assert.strictEqual(log.updatedAt, 'test-updatedAt', 'touch()로 찍혀야 mergeCollection이 병합할 수 있음');
});
test('saveAsset: fx/gold/stock 수량이 그대로면(바뀌지 않았으면) DB.assetQtyLog에 기록을 남기지 않는다', () => {
  const asset = { id: 'a1', type: 'gold', owner: '나', includeInTotal: true, name: '금', goldDon: 5 };
  sandbox.DB = { assets: [asset], assetQtyLog: [], rates: { fx: {}, stocks: {}, goldPerG: 80000 } };
  sandbox.asDraft = { id: 'a1', type: 'gold', owner: '나', includeInTotal: true, name: '금', goldDon: 5 };
  sandbox.saveAsset(true);
  assert.strictEqual(sandbox.DB.assetQtyLog.length, 0, '수량 변화가 없으면 기록할 게 없음');
});
test('saveAsset: cash 등 balType 자산을 수정해도 DB.assetQtyLog는 건드리지 않는다(잔액 조정 내역으로 이미 별도 추적됨)', () => {
  const asset = { id: 'a1', type: 'cash', owner: '나', includeInTotal: true, name: '지갑', baseAmount: 10000 };
  sandbox.DB = { assets: [asset], assetQtyLog: [], txns: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { id: 'a1', type: 'cash', owner: '나', includeInTotal: true, name: '지갑', baseAmount: 10000, _dispAmt: 20000 };
  sandbox.saveAsset(true);
  assert.strictEqual(sandbox.DB.assetQtyLog.length, 0, 'balType 자산은 isMarketValued가 아니므로 이 분기를 타면 안 됨');
});
/* ---------- saveAsset: 주식 자산의 종목코드가 비어 있으면 저장을 막는다 (cycle58 develop).
 * syncAssetInputs()는 종목코드를 trim/uppercase만 할 뿐 필수 여부를 검사하지 않고, saveAsset()도
 * transfer의 from/to 자산처럼 다른 필수 조합은 저장 전에 막으면서 stockCode는 검사하지 않아
 * 종목코드 없이 저장된 주식 자산이 assetEval()에서 영원히 ₩0으로 평가되고 heldStockCodes()가
 * 빈 문자열을 걸러내 시세 자동 동기화 대상에서도 빠지는 문제였다. ---------- */
test('saveAsset: 종목코드를 비워두고 저장하면 토스트로 막고 자산이 추가되지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '', stockQty: 10 };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 0, '종목코드 없이는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.includes('종목코드를 입력해 주세요'));
});
test('saveAsset: 공백만 입력한 종목코드도 trim 후 빈 값으로 취급해 막는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '   ', stockQty: 10 };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 0);
  assert.ok(sandbox.toastCalls.includes('종목코드를 입력해 주세요'));
});
test('saveAsset: 다른 자산 타입은 종목코드가 없어도 이 검증에 걸리지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'cash', owner: '나', includeInTotal: true, name: '지갑', baseAmount: 10000 };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 1);
  assert.ok(!sandbox.toastCalls.includes('종목코드를 입력해 주세요'));
});
/* ---------- saveAsset: FX/금/주식의 보유 수량이 0(또는 미입력)이면 저장을 막는다 (app-evolve
 * cycle119 advance). 다른 모든 숫자 입력란은 oninput="fmtAmt(this,...)"로 실시간 정제되는데
 * 이 세 입력란만 그런 정제가 없었고, syncAssetInputs()의 parseFloat(...)||0이 파싱 불가 입력을
 * 조용히 0으로 바꿔도 saveAsset()은 stockCode만 검사해 수량 0인 자산이 에러 없이 저장됐다. ---------- */
test('saveAsset: fx 보유 수량이 0이면 토스트로 막고 자산이 추가되지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'fx', owner: '나', includeInTotal: true, name: '달러', currency: 'USD', fxAmount: 0 };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 0);
  assert.ok(sandbox.toastCalls.includes('보유 수량을 입력해 주세요'));
});
test('saveAsset: 금 보유 수량이 미입력(undefined)이면 토스트로 막고 자산이 추가되지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'gold', owner: '나', includeInTotal: true, name: '금' };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 0);
  assert.ok(sandbox.toastCalls.includes('보유 수량을 입력해 주세요'));
});
test('saveAsset: 주식 보유 수가 0이면 종목코드가 있어도 토스트로 막고 자산이 추가되지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 0 };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 0);
  assert.ok(sandbox.toastCalls.includes('보유 수량을 입력해 주세요'));
});
test('saveAsset: fx/금/주식이 아닌 자산 타입은 보유 수량 검증에 걸리지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'cash', owner: '나', includeInTotal: true, name: '지갑', baseAmount: 0 };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 1);
  assert.ok(!sandbox.toastCalls.includes('보유 수량을 입력해 주세요'));
});
/* ---------- saveAsset: 만기일(maturityDate)도 saveTx/saveRec/planTransfer 등과 동일하게
 * RANGE_FROM/RANGE_TO 경계를 벗어나면 저장을 막는다(app-evolve cycle127 advance). 날짜피커가
 * 무제한 스크롤이라 범위 밖 만기일을 그대로 저장하면, doMaturity()가 만든 이체 거래가
 * allTxns(RANGE_FROM,RANGE_TO) 조회 범위 밖에 쌓여 가계부/전체내역/잔액 어디에도 다시
 * 나타나지 않는 조용한 소실로 이어진다(cycle123 planTransfer 버그와 동일 패턴). ---------- */
test('saveAsset: RANGE_FROM 이전 만기일은 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'savings', owner: '나', includeInTotal: true, name: '적금', baseAmount: 0, maturityDate: '2022-12-31' };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 0, 'RANGE_FROM 이전 만기일은 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some(m => m.includes('2023-01-01')), '하한 날짜를 알려주는 토스트가 떠야 함');
});
test('saveAsset: RANGE_TO 이후 만기일은 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.RANGE_TO = '2028-06-15';
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'savings', owner: '나', includeInTotal: true, name: '적금', baseAmount: 0, maturityDate: '2028-06-16' };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 0, 'RANGE_TO 이후 만기일은 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some(m => m.includes('2028-06-15')), '상한 날짜를 알려주는 토스트가 떠야 함');
});
test('saveAsset: 범위 안 만기일은 정상 저장된다(정상 케이스는 회귀 없음)', () => {
  sandbox.DB = { assets: [], rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  sandbox.asDraft = { type: 'savings', owner: '나', includeInTotal: true, name: '적금', baseAmount: 0, maturityDate: '2026-06-15' };
  sandbox.toastCalls = [];
  sandbox.saveAsset(false);
  assert.strictEqual(sandbox.DB.assets.length, 1);
  assert.strictEqual(sandbox.DB.assets[0].maturityDate, '2026-06-15');
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

/* ---------- assetGainLoss: fx/gold/stock 자산의 매입 원가(costBasis) 기반 손익 (cycle64 advance).
 * costBasis는 옵트인 필드라 미설정 시 undefined를 유지해야 하며, 0으로 기본값을 두면
 * rateUnknown()과 같은 이유로 "모름"과 "0원에 취득"을 구분하지 못해 손익이 -100%로
 * 오표시된다 — 그래서 costBasis>0일 때만 값을 인정하고, 그 외에는 null을 반환한다. ---------- */
test('assetGainLoss: costBasis가 없으면 null (0원 손익으로 오표시하지 않음)', () => {
  sandbox.DB = { rates: { fx: { USD: 1350 }, stocks: {}, goldPerG: 0 } };
  assert.strictEqual(sandbox.assetGainLoss({ type: 'fx', currency: 'USD', fxAmount: 100 }), null);
  assert.strictEqual(sandbox.assetGainLoss({ type: 'fx', currency: 'USD', fxAmount: 100, costBasis: 0 }), null, 'costBasis=0은 미설정과 동일하게 취급');
});
test('assetGainLoss: 시세평가 대상이 아닌 자산 타입은 costBasis가 있어도 항상 null', () => {
  sandbox.DB = { rates: { fx: {}, stocks: {}, goldPerG: 0 } };
  assert.strictEqual(sandbox.assetGainLoss({ type: 'cash', baseAmount: 10000, costBasis: 5000 }), null);
});
test('assetGainLoss: 평가액이 매입가보다 높으면 이익(+금액, +%)을 반환한다', () => {
  sandbox.DB = { rates: { fx: {}, stocks: { '005930': 12000 }, goldPerG: 0 } }; // 평가액 120,000
  const gl = sandbox.assetGainLoss({ type: 'stock', stockCode: '005930', stockQty: 10, costBasis: 100000 });
  assert.strictEqual(gl.amount, 20000);
  assert.strictEqual(gl.pct, 20);
});
test('assetGainLoss: 평가액이 매입가보다 낮으면 손실(음수 금액, 음수 %)을 반환한다', () => {
  sandbox.DB = { rates: { fx: {}, stocks: { '005930': 8000 }, goldPerG: 0 } };
  const gl = sandbox.assetGainLoss({ type: 'stock', stockCode: '005930', stockQty: 10, costBasis: 100000 }); // 평가액 80,000
  assert.strictEqual(gl.amount, -20000);
  assert.strictEqual(gl.pct, -20);
});
test('assetGainLossBadge: 이익이면 income 색상 배지를, 손실이면 expense 색상 배지를 반환한다', () => {
  sandbox.DB = { rates: { fx: {}, stocks: { '005930': 12000 }, goldPerG: 0 } };
  const upBadge = sandbox.assetGainLossBadge({ type: 'stock', stockCode: '005930', stockQty: 10, costBasis: 100000 });
  assert.ok(upBadge.includes('+20.0%'), upBadge);
  assert.ok(upBadge.includes('var(--income)'), upBadge);
  sandbox.DB.rates.stocks['005930'] = 8000;
  const downBadge = sandbox.assetGainLossBadge({ type: 'stock', stockCode: '005930', stockQty: 10, costBasis: 100000 });
  assert.ok(downBadge.includes('-20.0%'), downBadge);
  assert.ok(downBadge.includes('var(--expense)'), downBadge);
});
test('assetGainLossBadge: costBasis 미설정이면 빈 문자열(배지 없음)', () => {
  sandbox.DB = { rates: { fx: {}, stocks: { '005930': 12000 }, goldPerG: 0 } };
  assert.strictEqual(sandbox.assetGainLossBadge({ type: 'stock', stockCode: '005930', stockQty: 10 }), '');
});
test('assetSubline: fx/gold/stock은 costBasis가 있을 때만 손익 배지를 덧붙인다', () => {
  sandbox.DB = { rates: { fx: { USD: 1400 }, stocks: {}, goldPerG: 500000 } };
  const noBasis = sandbox.assetSubline({ type: 'fx', currency: 'USD', fxAmount: 100 });
  assert.ok(!noBasis.includes('%'), noBasis);
  const withBasis = sandbox.assetSubline({ type: 'fx', currency: 'USD', fxAmount: 100, costBasis: 100000 });
  assert.ok(withBasis.includes('%'), withBasis);
});
test('syncAssetInputs: 매입 금액 입력을 costBasis로 저장하고, 비우면 필드를 지운다', () => {
  const $orig = sandbox.$;
  const input = { value: '1,000,000' };
  sandbox.$ = (id) => (id === 'asCostBasis' ? input : null);
  try {
    sandbox.asDraft = { type: 'stock', stockCode: '005930', stockQty: 10, costBasis: 999 };
    sandbox.syncAssetInputs();
    assert.strictEqual(sandbox.asDraft.costBasis, 1000000);
    input.value = '';
    sandbox.syncAssetInputs();
    assert.strictEqual('costBasis' in sandbox.asDraft, false, '비우면 0으로 남기지 않고 필드 자체를 지워야 undefined와 0을 구분하는 assetGainLoss가 정상 동작함');
  } finally {
    sandbox.$ = $orig;
  }
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
test('clampRecurringToMaturity: count가 0(첫 회차부터 삭제해 실제 발생 0건)이어도 falsy라는 이유로 자동 클램프로 오인해 되살리면 안 된다(app-evolve cycle73)', () => {
  const rec = maturityRec({ endDate: '2026-01-14', count: 0 }); // recApply future-delete를 반복의 startDate(1/15) 자체에 적용하면 truncateRecEnd()의 recCountUntil이 0을 반환 — 사용자가 명시적으로 정한 실제 값
  sandbox.DB = { recurrences: [rec] };
  sandbox.clampRecurringToMaturity('a2', '2026-09-01', '2026-03-01');
  assert.strictEqual(rec.endDate, '2026-01-14', 'count:0은 !r.count로는 falsy지만 사용자가 명시적으로 정한 종료일이므로 만기 연장으로 되살아나면 안 됨(회귀 확인)');
  assert.strictEqual(rec.count, 0, 'count 자체도 그대로 보존돼야 함');
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

/* ---------- filterTxnsByOwner: 예산 탭 지출 분석이 자산 탭(ST.assetOwner)/플랜 탭(ST.plan.owner)과
 * 달리 DB.owners 귀속 모델을 전혀 쓰지 않던 공백을 메운 순수 필터(app-evolve cycle109 critique/advance).
 * expense는 출금 자산(fromAssetId), income은 입금 자산(toAssetId) 기준이고, transfer/saving은 둘 다
 * 관여하므로 fromAssetId를 우선하고 없으면 toAssetId로 폴백한다. */
test('filterTxnsByOwner: owner가 "전체"거나 falsy면 그대로 반환한다(필터 없음)', () => {
  const txns = [{ type: 'expense', fromAssetId: 'a1' }, { type: 'income', toAssetId: 'a2' }];
  const assets = [{ id: 'a1', owner: '나' }, { id: 'a2', owner: '배우자' }];
  assert.strictEqual(sandbox.filterTxnsByOwner(txns, assets, '전체').length, 2);
  assert.strictEqual(sandbox.filterTxnsByOwner(txns, assets, null).length, 2);
  assert.strictEqual(sandbox.filterTxnsByOwner(txns, assets, undefined).length, 2);
});
test('filterTxnsByOwner: expense는 fromAssetId의 owner로 필터한다', () => {
  const assets = [{ id: 'a1', owner: '나' }, { id: 'a2', owner: '배우자' }];
  const txns = [
    { id: 't1', type: 'expense', fromAssetId: 'a1' },
    { id: 't2', type: 'expense', fromAssetId: 'a2' },
  ];
  const out = sandbox.filterTxnsByOwner(txns, assets, '나');
  assert.deepStrictEqual(out.map((t) => t.id), ['t1']);
});
test('filterTxnsByOwner: income은 toAssetId의 owner로 필터한다(expense와 반대 방향)', () => {
  const assets = [{ id: 'a1', owner: '나' }, { id: 'a2', owner: '배우자' }];
  const txns = [
    { id: 't1', type: 'income', fromAssetId: null, toAssetId: 'a1' },
    { id: 't2', type: 'income', fromAssetId: null, toAssetId: 'a2' },
  ];
  const out = sandbox.filterTxnsByOwner(txns, assets, '배우자');
  assert.deepStrictEqual(out.map((t) => t.id), ['t2']);
});
test('filterTxnsByOwner: transfer/saving은 fromAssetId를 우선하고, 없으면 toAssetId로 폴백한다', () => {
  const assets = [{ id: 'a1', owner: '나' }, { id: 'a2', owner: '배우자' }, { id: 'a3', owner: '공용' }];
  const txns = [
    { id: 't1', type: 'transfer', fromAssetId: 'a1', toAssetId: 'a3' }, // from 우선 -> 나
    { id: 't2', type: 'saving', fromAssetId: null, toAssetId: 'a3' }, // from 없음 -> to로 폴백 -> 공용
  ];
  assert.deepStrictEqual(sandbox.filterTxnsByOwner(txns, assets, '나').map((t) => t.id), ['t1']);
  assert.deepStrictEqual(sandbox.filterTxnsByOwner(txns, assets, '공용').map((t) => t.id), ['t2']);
});
test('filterTxnsByOwner: 기준 자산을 찾을 수 없으면(삭제된 자산 등) 어느 귀속에도 속하지 않는 것으로 보고 제외한다', () => {
  const assets = [{ id: 'a1', owner: '나' }];
  const txns = [{ id: 't1', type: 'expense', fromAssetId: 'gone' }];
  assert.strictEqual(sandbox.filterTxnsByOwner(txns, assets, '나').length, 0);
});
test('filterTxnsByOwner: txns/assets가 없어도(undefined) 터지지 않는다', () => {
  assert.strictEqual(sandbox.filterTxnsByOwner(undefined, undefined, '나').length, 0);
});

/* ---------- mergeCollection: afterCloudAuth()의 localUnsynced 충돌 분기가 DB.txns를 문서 전체
 * 교체 대신 레코드 단위로 합치는 데 쓰는 순수 3-way 병합 함수(app-evolve cycle90 critique/advance).
 * 두 기기가 서로 무관한 거래만 각자 편집·삭제해도 전체 충돌로 취급돼 한쪽 편집이 통째로 사라지던
 * 문제(pushCloud/afterCloudAuth가 문서 단위 낙관적 락만 쓰던 것)를 DB.txns 한 컬렉션에 한해 푼다. */
test('mergeCollection: 양쪽이 같은 id를 각자 수정했으면 updatedAt이 더 큰(더 최근) 쪽이 이긴다', () => {
  const local = [{ id: 't1', memo: 'local-edit', updatedAt: 100 }];
  const remote = [{ id: 't1', memo: 'remote-edit', updatedAt: 200 }];
  const out = sandbox.mergeCollection(local, remote, {}, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].memo, 'remote-edit');
  assert.strictEqual(out[0].updatedAt, 200);
});
test('mergeCollection: updatedAt이 완전히 같으면 local이 이긴다', () => {
  const local = [{ id: 't1', memo: 'local-edit', updatedAt: 100 }];
  const remote = [{ id: 't1', memo: 'remote-edit', updatedAt: 100 }];
  const out = sandbox.mergeCollection(local, remote, {}, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].memo, 'local-edit');
});
test('mergeCollection: 한쪽이 삭제(tombstone)했고 다른 쪽은 그 이후 손대지 않았으면 삭제가 이긴다', () => {
  const local = []; // local이 t1을 삭제
  const remote = [{ id: 't1', memo: 'untouched', updatedAt: 50 }];
  const out = sandbox.mergeCollection(local, remote, { t1: 100 }, {}); // 삭제 시각(100) > remote updatedAt(50)
  assert.strictEqual(out.length, 0);
});
test('mergeCollection: 한쪽이 삭제(tombstone)했지만 다른 쪽이 그 삭제 이후에 수정했으면 수정이 삭제를 이긴다', () => {
  const local = []; // local이 t1을 삭제(시각 100)
  const remote = [{ id: 't1', memo: 'edited-after-delete', updatedAt: 150 }]; // remote가 그 뒤(150)에 수정
  const out = sandbox.mergeCollection(local, remote, { t1: 100 }, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].memo, 'edited-after-delete');
});
test('mergeCollection: id가 한쪽에만 있고 tombstone도 없으면 그대로 채택한다', () => {
  const local = [{ id: 't1', memo: 'only-local', updatedAt: 10 }];
  const remote = [{ id: 't2', memo: 'only-remote', updatedAt: 10 }];
  const out = sandbox.mergeCollection(local, remote, {}, {});
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.find((r) => r.id === 't1').memo, 'only-local');
  assert.strictEqual(out.find((r) => r.id === 't2').memo, 'only-remote');
});
test('mergeCollection: updatedAt이 없는 레거시 레코드도 크래시하지 않고 0으로 취급한다', () => {
  const local = [{ id: 't1', memo: 'legacy-no-updatedAt' }];
  const remote = [{ id: 't1', memo: 'remote-with-updatedAt', updatedAt: 1 }];
  const out = sandbox.mergeCollection(local, remote, {}, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].memo, 'remote-with-updatedAt');
});
test('mergeCollection: localArr/remoteArr/deletedIds가 없어도(undefined) 터지지 않는다', () => {
  const out = sandbox.mergeCollection(undefined, undefined, undefined, undefined);
  assert.strictEqual(out.length, 0);
});
test('mergeCollection: 로컬에서 삭제 후 undo로 되살린 내역은(touch()로 updatedAt이 삭제 시각 이후로 갱신됨), 원격이 아직 그 삭제(tombstone)만 알고 있어도 병합에서 살아남는다(app-evolve cycle94 통합 테스트 — 수정 전에는 undo 콜백에 touch()가 없어 되살린 레코드의 updatedAt이 삭제 이전 값 그대로였고, 그 값은 항상 그 삭제 자체의 tombstone 시각보다 작아 mergeCollection의 delRemoteTs!=null&&!r 분기가 l.updatedAt>delRemoteTs 조건을 만족 못 해 병합 결과에서 조용히 완전히 탈락시켰음)', () => {
  const deleteTs = 1000; // 삭제(및 원격이 알고 있는 tombstone) 시각
  // touch()가 실제로 하는 일(updatedAt = 삭제 이후의 현재 시각)을 그대로 흉내낸 되살아난 레코드
  const restoredByUndo = { id: 't1', memo: 'restored-by-undo', updatedAt: deleteTs + 500 };
  const localDeletedIds = {}; // undo가 로컬 tombstone은 이미 지움
  const remoteDeletedIds = { t1: deleteTs }; // 원격은 아직 이 삭제만 알고 있음(t1이 remoteArr엔 없음)
  const out = sandbox.mergeCollection([restoredByUndo], [], localDeletedIds, remoteDeletedIds);
  assert.strictEqual(out.length, 1, '되살린 내역이 병합 결과에서 사라지면 안 됨');
  assert.strictEqual(out[0].memo, 'restored-by-undo');
});
test('mergeCollection: (회귀 방지) touch() 없이 되살린 내역처럼 updatedAt이 삭제 이전 값 그대로면, 원격의 tombstone에 병합에서 탈락한다 — 수정 전 버그가 실제로 이 조건에서 발생했음을 보여주는 대조군', () => {
  const deleteTs = 1000;
  const restoredWithoutTouch = { id: 't1', memo: 'restored-without-touch', updatedAt: 1 }; // 삭제 이전 시각 그대로(버그 상황)
  const remoteDeletedIds = { t1: deleteTs };
  const out = sandbox.mergeCollection([restoredWithoutTouch], [], {}, remoteDeletedIds);
  assert.strictEqual(out.length, 0, 'touch() 없이는 되살린 내역이 tombstone에 져서 사라져야 함(수정 전 버그 재현)');
});
test('mergeCollection: (app-evolve cycle144) 자산 삭제로 이름 스냅샷이 찍힌 거래가 touch()로 updatedAt이 더 커지면, 다른 기기의 미동기화(스냅샷 없음) 사본보다 병합에서 이긴다 — snapshotAssetName/unsnapshotAssetName/relinkDeletedAsset touch() 누락 버그의 실제 증상 재현', () => {
  // 기기A: 자산을 삭제하고 snapshotAssetName()이 fromAssetName을 남긴 뒤 touch()로 updatedAt을 올림
  const snapshotted = { id: 't1', fromAssetName: '카카오뱅크', amount: 1000, updatedAt: 200 };
  // 기기B: 아직 동기화 전이라 스냅샷 없는 옛 사본을 그대로 들고 있음(touch() 없이 생성된 원본과 같은 updatedAt)
  const unsyncedCopy = { id: 't1', amount: 1000, updatedAt: 100 };
  const out = sandbox.mergeCollection([snapshotted], [unsyncedCopy], {}, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].fromAssetName, '카카오뱅크', '더 최근에 touch()된 스냅샷 있는 사본이 채택되어야 함 — assetNm()이 \'—\'로 떨어지지 않음');
});
test('mergeCollection: (회귀 방지) touch() 없이 이름 스냅샷만 찍혔다면(updatedAt이 그대로) 동일 updatedAt인 다른 기기의 미동기화 사본에 동률로 밀려 스냅샷이 사라진다 — 수정 전 버그가 실제로 이 조건에서 발생했음을 보여주는 대조군', () => {
  const snapshottedWithoutTouch = { id: 't1', fromAssetName: '카카오뱅크', amount: 1000, updatedAt: 100 }; // touch() 누락: updatedAt이 원본과 동일
  const unsyncedCopy = { id: 't1', amount: 1000, updatedAt: 100 };
  const out = sandbox.mergeCollection([snapshottedWithoutTouch], [unsyncedCopy], {}, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].fromAssetName, '카카오뱅크', 'updatedAt 동률이면 local(snapshottedWithoutTouch)이 이기므로 이 재현에서는 우연히 스냅샷이 남음 — 아래 반대 순서 재현이 실제 소실 조건');
  // local/remote를 뒤집으면: 미동기화(스냅샷 없음) 사본이 local이 되어 동률에서 이김 — 이것이 버그의 실제 소실 경로
  const out2 = sandbox.mergeCollection([unsyncedCopy], [snapshottedWithoutTouch], {}, {});
  assert.strictEqual(out2[0].fromAssetName, undefined, 'touch() 없이는 동률 시 local(스냅샷 없는 미동기화 사본)이 이겨 이름 스냅샷이 조용히 사라짐(수정 전 버그 재현)');
});

/* ---------- mergeNameList/mergeBudgetHistory: mergeRemoteDataIntoLocal()이 DB.categories/
 * DB.owners/DB.budgetHistory를 병합하는 데 쓰는 순수 함수(app-evolve cycle102 critique/advance).
 * 이전엔 이 셋이 전혀 병합되지 않아, 두 기기가 오프라인 상태에서 각자 카테고리/귀속/예산을
 * 고치면 로컬 값이 조용히 이기고 이어지는 push가 상대 기기의 편집을 영구히 덮어썼다. ---------- */
// mergeNameList/mergeBudgetHistory는 local/remote가 undefined일 때 vm 샌드박스 안에서
// []/{} 리터럴로 기본값을 새로 만드는데, 이 빈 컨테이너는 host의 Array/Object와 realm이 달라
// deepStrictEqual이 (값은 같아도) 실패한다(recDates/parseCSV 테스트와 같은 이유) — 그래서
// JSON.parse(JSON.stringify(...))로 host realm 값으로 정규화한 뒤 비교한다.
const j = (v) => JSON.parse(JSON.stringify(v));
test('mergeNameList: remote에만 있는 새 이름은 local 순서를 유지한 채 뒤에 추가된다', () => {
  const out = sandbox.mergeNameList(['식비', '교통'], ['식비', '문화'], sandbox.normName);
  assert.deepStrictEqual(j(out), ['식비', '교통', '문화']);
});
test('mergeNameList: 대소문자·공백만 다른 remote 이름은 중복 추가되지 않는다', () => {
  const out = sandbox.mergeNameList(['Netflix'], [' netflix '], sandbox.normName);
  assert.deepStrictEqual(j(out), ['Netflix']);
});
test('mergeNameList: 한글 NFC/NFD만 다른 remote 이름은 중복 추가되지 않는다', () => {
  const nfc = '식비'.normalize('NFC');
  const nfd = '식비'.normalize('NFD');
  const out = sandbox.mergeNameList([nfc], [nfd], sandbox.normName);
  assert.deepStrictEqual(j(out), [nfc]);
});
test('mergeNameList: local/remote가 비어 있거나 undefined여도 터지지 않는다', () => {
  assert.deepStrictEqual(j(sandbox.mergeNameList(undefined, undefined, sandbox.normName)), []);
  assert.deepStrictEqual(j(sandbox.mergeNameList(['A'], undefined, sandbox.normName)), ['A']);
  assert.deepStrictEqual(j(sandbox.mergeNameList(undefined, ['B'], sandbox.normName)), ['B']);
});
test('mergeBudgetHistory: remote에만 있는 카테고리는 그대로 포함된다', () => {
  const out = sandbox.mergeBudgetHistory({}, { 문화: [{ from: '2026-01', amount: 50000 }] });
  assert.deepStrictEqual(j(out), { 문화: [{ from: '2026-01', amount: 50000 }] });
});
test('mergeBudgetHistory: 같은 카테고리에 remote가 local에 없는 월을 추가하면 합쳐지고 from 오름차순으로 정렬된다', () => {
  const local = { 식비: [{ from: '2026-03', amount: 300000 }] };
  const remote = { 식비: [{ from: '2026-01', amount: 250000 }] };
  const out = sandbox.mergeBudgetHistory(local, remote);
  assert.deepStrictEqual(j(out), { 식비: [{ from: '2026-01', amount: 250000 }, { from: '2026-03', amount: 300000 }] });
});
test('mergeBudgetHistory: 같은 (카테고리,from)이 양쪽에 다른 금액으로 있으면 local 금액이 이기고 중복 항목이 생기지 않는다', () => {
  const local = { 식비: [{ from: '2026-01', amount: 300000 }] };
  const remote = { 식비: [{ from: '2026-01', amount: 250000 }] };
  const out = sandbox.mergeBudgetHistory(local, remote);
  assert.deepStrictEqual(j(out), { 식비: [{ from: '2026-01', amount: 300000 }] });
});
test('mergeBudgetHistory: localMap/remoteMap이 undefined이거나 카테고리 항목이 빈 배열이어도 터지지 않는다', () => {
  assert.deepStrictEqual(j(sandbox.mergeBudgetHistory(undefined, undefined)), {});
  assert.deepStrictEqual(j(sandbox.mergeBudgetHistory({ 식비: [] }, { 식비: [] })), { 식비: [] });
});

/* ---------- mergeFlatMap: DB.catIcon/DB.catVar(카테고리 아이콘·변동 카테고리, '타입:이름'→값
 * 평평한 맵) 병합(app-evolve cycle125 develop). mergeRemoteDataIntoLocal이 신설(cycle97/111)
 * 이래로 이 두 맵을 전혀 병합하지 않고 로컬 값을 그대로 둬서, 한 기기가 오프라인에서 고른
 * 아이콘/변동 플래그가 다른 기기의 병합 경로 동기화 시 조용히 사라지던 버그. ---------- */
test('mergeFlatMap: remote에만 있는 키는 그대로 포함된다', () => {
  const out = sandbox.mergeFlatMap({}, { 'expense:문화': 'movie' });
  assert.deepStrictEqual(j(out), { 'expense:문화': 'movie' });
});
test('mergeFlatMap: local에만 있는 키도 그대로 유지된다', () => {
  const out = sandbox.mergeFlatMap({ 'expense:식비': 'food' }, {});
  assert.deepStrictEqual(j(out), { 'expense:식비': 'food' });
});
test('mergeFlatMap: 같은 키가 양쪽에 다른 값으로 있으면 local 값이 이긴다', () => {
  const out = sandbox.mergeFlatMap({ 'expense:식비': 'food' }, { 'expense:식비': 'rice' });
  assert.deepStrictEqual(j(out), { 'expense:식비': 'food' });
});
test('mergeFlatMap: localMap/remoteMap이 undefined여도 터지지 않는다', () => {
  assert.deepStrictEqual(j(sandbox.mergeFlatMap(undefined, undefined)), {});
  assert.deepStrictEqual(j(sandbox.mergeFlatMap({ a: 1 }, undefined)), { a: 1 });
  assert.deepStrictEqual(j(sandbox.mergeFlatMap(undefined, { b: 2 })), { b: 2 });
});
test('mergeRemoteDataIntoLocal: DB.catIcon/DB.catVar도 mergeFlatMap으로 병합된다(이전엔 전혀 병합 안 돼 로컬 값이 조용히 원격 변경을 덮어씀)', () => {
  sandbox.DB = minimalMergeDB({
    catIcon: { 'expense:식비': 'food' },
    catVar: { 'expense:식비': true },
  });
  sandbox.mergeRemoteDataIntoLocal({
    catIcon: { 'expense:문화': 'movie', 'expense:식비': 'rice' },
    catVar: { 'expense:교통': true },
    deletedIds: {},
  });
  assert.strictEqual(sandbox.DB.catIcon['expense:문화'], 'movie', 'remote에만 있던 아이콘도 들어와야 함');
  assert.strictEqual(sandbox.DB.catIcon['expense:식비'], 'food', '같은 키는 local 값이 이겨야 함');
  assert.strictEqual(sandbox.DB.catVar['expense:교통'], true, 'remote에만 있던 변동 플래그도 들어와야 함');
});
test('mergeRemoteDataIntoLocal: DB.deletedType/DB.deletedBal도 mergeFlatMap으로 병합된다(이전엔 전혀 병합 안 돼 재연동 기록이 기기 간에 사라짐)', () => {
  sandbox.DB = minimalMergeDB({
    deletedType: { '카카오뱅크': 'cash' },
    deletedBal: { '카카오뱅크': 10000 },
  });
  sandbox.mergeRemoteDataIntoLocal({
    deletedType: { '증권계좌': 'stock', '카카오뱅크': 'savings' },
    deletedBal: { '증권계좌': 5000 },
    deletedIds: {},
  });
  assert.strictEqual(sandbox.DB.deletedType['증권계좌'], 'stock', 'remote에만 있던 기록도 들어와야 함');
  assert.strictEqual(sandbox.DB.deletedType['카카오뱅크'], 'cash', '같은 키는 local 값이 이겨야 함');
  assert.strictEqual(sandbox.DB.deletedBal['증권계좌'], 5000, 'remote에만 있던 잔액 기록도 들어와야 함');
});

/* ---------- gcTombstones: migrate()가 부팅마다 DB.deletedIds에서 오래된(maxAgeMs 이전) tombstone을
 * 걸러내는 순수 함수(app-evolve cycle95 advance) — GC 없이는 삭제할 때마다 쌓이기만 해 수년 사용 시
 * 무한히 커지고, 매 pushCloud/pullCloud마다 전체가 그대로 오간다. ---------- */
test('gcTombstones: maxAgeMs보다 오래된 tombstone은 제거된다', () => {
  const now = 10_000;
  const out = sandbox.gcTombstones({ old: now - 500 - 1 }, now, 500);
  assert.strictEqual(Object.keys(out).length, 0);
});
test('gcTombstones: maxAgeMs 이내인 tombstone은 유지된다', () => {
  const now = 10_000;
  const out = sandbox.gcTombstones({ recent: now - 100 }, now, 500);
  assert.strictEqual(Object.keys(out).length, 1);
  assert.strictEqual(out.recent, now - 100);
});
test('gcTombstones: 경계값(정확히 maxAgeMs만큼 지난 tombstone)은 유지 쪽으로 처리된다(<=)', () => {
  const now = 10_000;
  const out = sandbox.gcTombstones({ boundary: now - 500 }, now, 500);
  assert.strictEqual(Object.keys(out).length, 1);
  assert.strictEqual(out.boundary, now - 500);
});
test('gcTombstones: deletedIds가 비어있거나 undefined여도 안전하다', () => {
  assert.strictEqual(Object.keys(sandbox.gcTombstones({}, Date.now(), 500)).length, 0);
  assert.strictEqual(Object.keys(sandbox.gcTombstones(undefined, Date.now(), 500)).length, 0);
});
test('gcTombstones: maxAgeMs를 생략하면 기본값(400일)이 적용된다', () => {
  const now = Date.now();
  const DAY = 1000 * 60 * 60 * 24;
  const out = sandbox.gcTombstones({ old: now - 401 * DAY, recent: now - 399 * DAY }, now);
  assert.strictEqual(Object.keys(out).length, 1);
  assert.strictEqual(out.recent, now - 399 * DAY);
});
test('migrate: DB.deletedIds의 오래된(400일 초과) tombstone은 sanitize되어 사라지고, 그 이내인 것은 유지된다(app-evolve cycle95 advance 통합 테스트)', () => {
  const now = Date.now();
  const DAY = 1000 * 60 * 60 * 24;
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
    deletedIds: { old: now - 500 * DAY, recent: now - 10 * DAY },
  };
  sandbox.migrate();
  assert.strictEqual(Object.keys(sandbox.DB.deletedIds).length, 1);
  assert.strictEqual(sandbox.DB.deletedIds.recent, now - 10 * DAY);
});
test('migrate: DB.deletedIds가 아예 없어도(migrate 이전 상태) 예외 없이 빈 객체로 채워진다', () => {
  sandbox.DB = {
    version: 5, catsV2: true,
    settings: { themeMode: 'system', includeScheduled: false, assetSort: 'custom', groupOrder: [...sandbox.DEFAULT_GROUP_ORDER] },
    owners: ['나', '배우자', '공용'],
    assets: [], txns: [], recurrences: [], inquiries: [],
    categories: { expense: [...sandbox.EXP_CATS_DEFAULT], income: [...sandbox.INC_CATS_DEFAULT], saving: [...sandbox.SAV_CATS_DEFAULT] },
  };
  assert.doesNotThrow(() => sandbox.migrate());
  assert.strictEqual(Object.keys(sandbox.DB.deletedIds).length, 0);
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

/* ---------- shouldRetryCloudSync: 'online' 이벤트에서 동기화 재시도 여부를 판정하는 순수 로직 ---------- */
test('shouldRetryCloudSync: 클라우드 계정이 없으면 재시도하지 않는다', () => {
  assert.strictEqual(sandbox.shouldRetryCloudSync(null, 'error', true), false);
});
test('shouldRetryCloudSync: 동기화 상태가 정상이면 재시도할 필요가 없다', () => {
  assert.strictEqual(sandbox.shouldRetryCloudSync('u1', 'ok', true), false);
});
test('shouldRetryCloudSync: 실패 상태에서 온라인으로 복귀하면 재시도한다', () => {
  assert.strictEqual(sandbox.shouldRetryCloudSync('u1', 'error', true), true);
});
test('shouldRetryCloudSync: 실패 상태여도 아직 오프라인이면 재시도하지 않는다', () => {
  assert.strictEqual(sandbox.shouldRetryCloudSync('u1', 'error', false), false);
});
test('shouldRetryCloudSync: 충돌 상태는 사용자의 명시적 해결이 필요하므로 자동 재시도하지 않는다', () => {
  assert.strictEqual(sandbox.shouldRetryCloudSync('u1', 'conflict', true), false);
});

/* ---------- shouldPullCloud/pullCloudIfStale: 포그라운드 복귀 시 클라우드 재-pull 스로틀
 * (app-evolve cycle167 advance — visibilitychange-visible/focus/pageshow가 maybeRollDay()만
 * 부르고 네트워크는 전혀 건드리지 않아 다른 기기의 수정이 강제종료 후 재실행 전까지 반영되지
 * 않던 공백을 메운다) ---------- */
test('shouldPullCloud: 한 번도 동기화된 적이 없으면(lastSyncedAtMs 없음) 곧장 pull한다', () => {
  assert.strictEqual(sandbox.shouldPullCloud(100000, null, 180000), true);
  assert.strictEqual(sandbox.shouldPullCloud(100000, 0, 180000), true);
});
test('shouldPullCloud: 마지막 동기화로부터 문턱 시간이 아직 안 지났으면 pull하지 않는다', () => {
  assert.strictEqual(sandbox.shouldPullCloud(200000, 100000, 180000), false);
});
test('shouldPullCloud: 문턱 시간이 지났으면(경계값 포함) pull한다', () => {
  assert.strictEqual(sandbox.shouldPullCloud(280000, 100000, 180000), true);
  assert.strictEqual(sandbox.shouldPullCloud(280001, 100000, 180000), true);
});

test('pullCloudIfStale: 클라우드 계정이 아니면(CLOUD_UID 없음) pull을 시도하지 않는다', async () => {
  sandbox.CLOUD_UID = null;
  sandbox.DB = { assets: [], txns: [] };
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [{ id: 'remote' }], txns: [] }, updated_at: '2026-01-01T00:00:00.000Z' }, error: null };
  await sandbox.pullCloudIfStale();
  assert.strictEqual(sandbox.DB.assets.length, 0, '클라우드 계정이 아니므로 로컬 DB가 건드려지면 안 됨');
});
test('pullCloudIfStale: DB가 아직 로드되지 않았으면(부팅 전) pull을 시도하지 않는다', async () => {
  sandbox.CLOUD_UID = 'u1';
  sandbox.DB = null;
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [{ id: 'remote' }], txns: [] }, updated_at: '2026-01-01T00:00:00.000Z' }, error: null };
  await sandbox.pullCloudIfStale();
  assert.strictEqual(sandbox.DB, null);
  sandbox.CLOUD_UID = null;
});
test('pullCloudIfStale: 시트가 열려 있으면(편집 중일 수 있음) 동기화가 오래됐어도 건드리지 않고 건너뛴다', async () => {
  sandbox.CLOUD_UID = 'u1';
  sandbox.DB = { assets: [{ id: 'local-only', type: 'cash', updatedAt: 100 }], txns: [] };
  sandbox._lsMap = { 'test-key__syncedAt': String(Date.now() - 10 * 60 * 1000) }; // 10분 전 → CLOUD_PULL_STALE_MS(3분) 초과
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [{ id: 'remote-only', type: 'cash', updatedAt: 100 }], txns: [] }, updated_at: '2026-01-01T00:00:00.000Z' }, error: null };
  const origDollar = sandbox.$;
  sandbox.$ = (id) => id === 'sheet' ? { classList: { contains: () => true } } : origDollar(id);
  await sandbox.pullCloudIfStale();
  sandbox.$ = origDollar;
  assert.strictEqual(sandbox.DB.assets.length, 1, '시트가 열려 있는 동안은 원격 데이터가 병합되면 안 됨');
  sandbox._lsMap = null;
  sandbox.CLOUD_UID = null;
});
test('pullCloudIfStale: 아직 동기화가 오래되지 않았으면(문턱 이내) pull 자체를 하지 않는다', async () => {
  sandbox.CLOUD_UID = 'u1';
  sandbox.DB = { assets: [{ id: 'local-only', type: 'cash', updatedAt: 100 }], txns: [] };
  sandbox._lsMap = { 'test-key__syncedAt': String(Date.now() - 60 * 1000) }; // 1분 전 → 3분 문턱 이내
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [{ id: 'remote-only', type: 'cash', updatedAt: 100 }], txns: [] }, updated_at: '2026-01-01T00:00:00.000Z' }, error: null };
  await sandbox.pullCloudIfStale();
  assert.strictEqual(sandbox.DB.assets.length, 1, '아직 신선한 동기화 상태면 원격 데이터를 가져오면 안 됨');
  sandbox._lsMap = null;
  sandbox.CLOUD_UID = null;
});
test('pullCloudIfStale: 동기화가 오래됐고 시트도 닫혀 있으면 원격을 로컬에 병합하고 save()를 부른다', async () => {
  sandbox.CLOUD_UID = 'u1';
  sandbox.DB = { assets: [{ id: 'local-only', type: 'cash', updatedAt: 100 }], txns: [], recurrences: [], goals: [], inquiries: [], assetQtyLog: [], deletedIds: {} };
  sandbox._lsMap = { 'test-key__syncedAt': String(Date.now() - 10 * 60 * 1000) }; // 10분 전 → 3분 문턱 초과
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [{ id: 'remote-only', type: 'cash', updatedAt: 100 }], txns: [], recurrences: [], goals: [], inquiries: [], assetQtyLog: [], deletedIds: {} }, updated_at: '2026-01-01T00:00:00.000Z' }, error: null };
  let saveCalls = 0;
  const origSave = sandbox.save;
  sandbox.save = () => { saveCalls++; };
  await sandbox.pullCloudIfStale();
  sandbox.save = origSave;
  assert.strictEqual(saveCalls, 1, '원격 변경을 받아왔으면 save()로 로컬에 반영해야 함');
  assert.ok(sandbox.DB.assets.some(a => a.id === 'local-only'), '기존 로컬 레코드가 사라지면 안 됨');
  assert.ok(sandbox.DB.assets.some(a => a.id === 'remote-only'), '원격에만 있던 레코드가 병합돼야 함');
  sandbox._lsMap = null;
  sandbox.CLOUD_UID = null;
});

/* ---------- pullCloud/afterCloudAuth/resolveCloudPullRemote: markCloudSynced() 호출 시점
 * (app-evolve cycle77 develop 회귀 테스트). pullCloud()는 원래 원격 fetch에 성공하기만 하면
 * markCloudSynced()(dataKey()+'__syncedAt'을 지금 시각으로 찍음)를 곧장 불렀다. 그런데
 * afterCloudAuth()는 localUnsynced(로컬에 아직 클라우드로 못 올라간 편집이 있음)일 때 remote를
 * 버리고 conflict 상태로만 돌아가는데, 이때도 pullCloud()가 이미 markCloudSynced()를 불러버려
 * '__syncedAt'이 지금 시각으로 갱신된다. 그 다음 재부팅(추가 편집 없이 재실행)에서는
 * savedAt<syncedAt이 되어 localHasUnsyncedChanges()가 false를 돌려주고, afterCloudAuth()가
 * 곧장 DB=remote로 덮어써 그 미동기화 편집이 조용히 사라진다. 고친 뒤에는 pullCloud() 자신은
 * markCloudSynced()를 부르지 않고, 실제로 remote를 채택하는 호출자(afterCloudAuth의 비-conflict
 * 분기, resolveCloudPullRemote)만 부른다. ---------- */
test('pullCloud: 원격 fetch에 성공해도 markCloudSynced를 직접 부르지 않는다(호출자가 remote를 실제로 채택할 때만 불러야 함)', async () => {
  sandbox.CLOUD_UID = 'u1';
  sandbox.markCloudSyncedCalls = 0;
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [], txns: [] }, updated_at: '2026-01-01T00:00:00.000Z' }, error: null };
  const remote = await sandbox.pullCloud();
  assert.deepStrictEqual(remote, { assets: [], txns: [] });
  assert.strictEqual(sandbox.CLOUD_LAST_SYNCED_AT, '2026-01-01T00:00:00.000Z', 'pushCloud()의 조건부 UPDATE가 쓰는 기준시각은 그대로 갱신되어야 함');
  assert.strictEqual(sandbox.markCloudSyncedCalls, 0, 'pullCloud() 스스로는 로컬이 remote와 같아졌다고 표시하면 안 됨');
});
test('afterCloudAuth: 로컬에 미동기화 편집이 있어도 DB.txns/recurrences/assets 세 컬렉션 모두 mergeCollection으로 합치고 status:"merged"·CLOUD_SYNC_STATE:"ok"를 반환한다(app-evolve cycle91 develop 회귀 테스트 — 예전엔 txns만 합치고 assets/recurrences는 방치한 채 CLOUD_SYNC_STATE를 무조건 conflict로 강제해 이미 안전 병합된 상태에서도 파괴적 양자택일 배너가 계속 떴다)', async () => {
  sandbox.DB = {
    assets: [
      { id: 'local-only-asset', type: 'cash', updatedAt: 100 },
      { id: 'both-asset', type: 'cash', name: 'stale-local', updatedAt: 100 },
    ],
    recurrences: [
      { id: 'local-only-rec', startDate: '2026-01-01', updatedAt: 100 },
      { id: 'both-rec', startDate: '2026-01-01', memo: 'stale-local', updatedAt: 100 },
    ],
    txns: [
      { id: 'local-only', date: '2026-01-01', updatedAt: 100 },
      { id: 'both', date: '2026-01-01', memo: 'stale-local', updatedAt: 100 },
    ],
    deletedIds: { 'local-deleted': Date.now() - 300 }, // gcTombstones(app-evolve cycle95)가 오래된 것으로 오인해 지우지 않도록 현재 시각 근방 값 사용
  };
  sandbox.CLOUD_UID = 'u1';
  sandbox.CLOUD_SYNC_STATE = 'idle';
  sandbox._lsMap = { 'test-key__savedAt': '2000', 'test-key__syncedAt': '1000' }; // savedAt>syncedAt → 미동기화
  sandbox._sbMaybeSingleResult = {
    data: {
      data: {
        assets: [
          { id: 'remote-asset', type: 'cash', updatedAt: 100 },
          { id: 'both-asset', type: 'cash', name: 'newer-remote', updatedAt: 200 },
        ],
        recurrences: [
          { id: 'remote-rec', startDate: '2026-01-01', updatedAt: 100 },
          { id: 'both-rec', startDate: '2026-01-01', memo: 'newer-remote', updatedAt: 200 },
        ],
        txns: [
          { id: 'remote-only', date: '2026-01-01', updatedAt: 100 },
          { id: 'both', date: '2026-01-01', memo: 'newer-remote', updatedAt: 200 },
        ],
        deletedIds: { 'remote-deleted': Date.now() - 400 },
      },
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    error: null,
  };
  const result = await sandbox.afterCloudAuth('u1');
  assert.strictEqual(result.status, 'merged');
  // sandbox.cloudSyncOk는 다른 테스트와 동일한 이유로 no-op 스텁이라(위 168행) 실제로 'ok'가
  // 되는지는 여기서 검증할 수 없다 — 대신 예전처럼 병합 후 강제로 'conflict'를 대입하는 코드가
  // 없어져 호출 전 값('idle')이 그대로 남아있는지로 "강제 conflict 제거"를 검증한다.
  assert.strictEqual(sandbox.CLOUD_SYNC_STATE, 'idle', '세 컬렉션 모두 병합됐으니 더 이상 conflict를 강제로 대입하면 안 됨(실제 앱에서는 pullCloud의 cloudSyncOk()가 이미 ok로 둔 상태가 그대로 유지됨)');
  assert.strictEqual(sandbox.DB.txns.length, 3);
  assert.ok(sandbox.DB.txns.some((t) => t.id === 'local-only'));
  assert.ok(sandbox.DB.txns.some((t) => t.id === 'remote-only'));
  assert.strictEqual(sandbox.DB.txns.find((t) => t.id === 'both').memo, 'newer-remote', '더 최근(updatedAt 200)인 remote 쪽이 이겨야 함');
  assert.strictEqual(sandbox.DB.recurrences.length, 3);
  assert.ok(sandbox.DB.recurrences.some((r) => r.id === 'local-only-rec'));
  assert.ok(sandbox.DB.recurrences.some((r) => r.id === 'remote-rec'));
  assert.strictEqual(sandbox.DB.recurrences.find((r) => r.id === 'both-rec').memo, 'newer-remote');
  assert.strictEqual(sandbox.DB.assets.length, 3);
  assert.ok(sandbox.DB.assets.some((a) => a.id === 'local-only-asset'));
  assert.ok(sandbox.DB.assets.some((a) => a.id === 'remote-asset'));
  assert.strictEqual(sandbox.DB.assets.find((a) => a.id === 'both-asset').name, 'newer-remote');
  assert.ok(sandbox.DB.deletedIds['local-deleted'] != null, '양쪽 deletedIds가 합쳐져야 함');
  assert.ok(sandbox.DB.deletedIds['remote-deleted'] != null, '양쪽 deletedIds가 합쳐져야 함');
  sandbox._lsMap = null;
});
test('afterCloudAuth: 로컬에 미동기화 편집이 없으면 remote를 그대로 채택하고 markCloudSynced를 부른다', async () => {
  sandbox.DB = { assets: [{ id: 'local-old' }], txns: [] };
  sandbox.CLOUD_UID = 'u1';
  sandbox.CLOUD_SYNC_STATE = 'idle';
  sandbox.markCloudSyncedCalls = 0;
  sandbox._lsMap = { 'test-key__savedAt': '1000', 'test-key__syncedAt': '2000' }; // savedAt<=syncedAt → 동기화됨
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [{ id: 'remote', type: 'cash' }], txns: [] }, updated_at: '2026-01-02T00:00:00.000Z' }, error: null };
  await sandbox.afterCloudAuth('u1');
  assert.ok(sandbox.DB.assets.some(a => a.id === 'remote'), 'remote 데이터를 채택해야 함');
  assert.strictEqual(sandbox.markCloudSyncedCalls, 1);
  sandbox._lsMap = null;
});
/* afterCloudAuth()가 remote===null && guestHasData() 경로(신규 클라우드 계정/첫 가입에 게스트
 * 데이터가 조용히 병합되는 경우)를 status로 알려주지 않아, doLogin()이 dbIsEmpty(DB)만 보고
 * "게스트 데이터가 합쳐지지 않았어요"라는 사실과 반대되는 메시지를 띄우던 버그
 * (app-evolve cycle84 critique/advance) 재발 방지. */
test('afterCloudAuth: remote가 없고(신규 계정) 게스트 데이터가 있으면 게스트 DB를 채택하고 status:"guestMerged"를 반환한다', async () => {
  sandbox.DB = { assets: [], txns: [] };
  sandbox.CLOUD_UID = null;
  sandbox.CLOUD_SYNC_STATE = 'idle';
  sandbox._sbMaybeSingleResult = { data: null, error: null }; // remote 없음
  const guestDb = { assets: [{ id: 'guest-1' }], txns: [] };
  sandbox._lsMap = { 'asset_app_db_v3__guest': JSON.stringify(guestDb) };
  const result = await sandbox.afterCloudAuth('u1');
  assert.strictEqual(result.status, 'guestMerged');
  assert.ok(sandbox.DB.assets.some(a => a.id === 'guest-1'), '게스트 DB를 그대로 채택해야 함');
  sandbox._lsMap = null;
});
test('afterCloudAuth: remote도 없고 게스트 데이터도 없으면(완전 신규 계정) status:"empty"를 반환한다', async () => {
  sandbox.DB = { assets: [], txns: [] };
  sandbox.CLOUD_UID = null;
  sandbox._sbMaybeSingleResult = { data: null, error: null };
  sandbox._lsMap = { 'asset_app_db_v3__guest': null };
  const result = await sandbox.afterCloudAuth('u1');
  assert.strictEqual(result.status, 'empty');
  sandbox._lsMap = null;
});
test('resolveCloudPullRemote(사용자가 명시적으로 누르는 "가져오기"): remote를 채택하며 markCloudSynced를 부른다', async () => {
  sandbox.DB = { assets: [{ id: 'local-old' }], txns: [] };
  sandbox.CLOUD_UID = 'u1';
  sandbox.markCloudSyncedCalls = 0;
  sandbox._sbMaybeSingleResult = { data: { data: { assets: [{ id: 'remote2', type: 'cash' }], txns: [] }, updated_at: '2026-01-03T00:00:00.000Z' }, error: null };
  const origRenderCurrent = sandbox.renderCurrent;
  sandbox.renderCurrent = () => {};
  try {
    await sandbox.resolveCloudPullRemote();
  } finally {
    sandbox.renderCurrent = origRenderCurrent;
  }
  assert.ok(sandbox.DB.assets.some(a => a.id === 'remote2'));
  assert.strictEqual(sandbox.markCloudSyncedCalls, 1);
});

/* ---------- pushCloud: 조건부 UPDATE 충돌 시 수동 양자택일로 곧장 멈추는 대신 mergeCollection()으로
 * 자동 병합 후 1회 재시도한다(app-evolve cycle93 critique/advance). 예전엔 decidePushOutcome()이
 * 'conflict'를 반환하면 afterCloudAuth()가 이미 쓰는 병합 인프라(touch()/deletedIds/mergeCollection,
 * 세 컬렉션 모두 완비)를 이 경로만 못 쓰고 CLOUD_SYNC_STATE='conflict'로 멈춰 confirmCloudForcePush()의
 * 전부-내것/전부-상대것 양자택일만 강제했다 — 부부 등 계정 공유 시나리오에서 서로 무관한 레코드를
 * 각자 다른 기기에서 거의 동시에 편집했을 뿐인데도 한쪽 기기의 편집 전체가 사라질 위험이 있었다. ---------- */
test('pushCloud: 첫 조건부 UPDATE가 충돌해도 원격 최신본을 자동 병합해 1회 재시도하면 성공하고, 양쪽 txns가 모두 살아남는다', async () => {
  sandbox.DB = {
    txns: [{ id: 'local-only', date: '2026-01-01', updatedAt: 100 }],
    recurrences: [], assets: [], deletedIds: {},
  };
  sandbox.CLOUD_UID = 'u1';
  sandbox.CLOUD_SYNC_STATE = 'idle';
  sandbox.CLOUD_LAST_SYNCED_AT = '2026-01-01T00:00:00.000Z';
  sandbox.CLOUD_CONFLICT_TOASTED = false;
  sandbox.markCloudSyncedCalls = 0;
  sandbox.lastToast = null; sandbox.toastCalls = [];
  // 1번째 조건부 UPDATE는 matchedRowCount=0(충돌), 2번째(재시도)는 matchedRowCount=1(성공).
  sandbox._sbUpdateResults = [
    { data: [], error: null },
    { data: [{ updated_at: 'retry-ok' }], error: null },
  ];
  // rowExistedBefore 판정과 병합 재시도가 함께 재사용하는 원격 최신 행.
  sandbox._sbMaybeSingleResult = {
    data: { data: { txns: [{ id: 'remote-only', date: '2026-01-02', updatedAt: 100 }], recurrences: [], assets: [], deletedIds: {} }, updated_at: '2026-02-01T00:00:00.000Z' },
    error: null,
  };
  await sandbox.pushCloud();
  assert.strictEqual(sandbox.DB.txns.length, 2, '충돌 시 로컬 편집을 버리지 않고 원격과 병합해야 함');
  assert.ok(sandbox.DB.txns.some(t => t.id === 'local-only'), '로컬 전용 거래가 살아남아야 함');
  assert.ok(sandbox.DB.txns.some(t => t.id === 'remote-only'), '원격 전용 거래도 병합돼야 함');
  assert.strictEqual(sandbox.markCloudSyncedCalls, 1, '재시도가 최종 성공했으니 markCloudSynced가 불려야 함');
  assert.notStrictEqual(sandbox.CLOUD_SYNC_STATE, 'conflict', '재시도가 성공했으니 수동 충돌 상태로 남으면 안 됨');
  assert.strictEqual(sandbox.toastCalls.length, 0, '자동 병합·재시도로 조용히 해결됐으니 충돌 토스트가 뜨면 안 됨');
});
test('pushCloud: 재시도까지 두 번 다 충돌이면(극단적 3중 경합) 병합은 반영된 채로 기존처럼 수동 충돌 폴백으로 떨어진다', async () => {
  sandbox.DB = {
    txns: [{ id: 'local-only', date: '2026-01-01', updatedAt: 100 }],
    recurrences: [], assets: [], deletedIds: {},
  };
  sandbox.CLOUD_UID = 'u1';
  sandbox.CLOUD_SYNC_STATE = 'idle';
  sandbox.CLOUD_LAST_SYNCED_AT = '2026-01-01T00:00:00.000Z';
  sandbox.CLOUD_CONFLICT_TOASTED = false;
  sandbox.markCloudSyncedCalls = 0;
  sandbox.lastToast = null; sandbox.toastCalls = [];
  // 1번째·2번째(재시도) 조건부 UPDATE 모두 matchedRowCount=0(계속 충돌).
  sandbox._sbUpdateResults = [
    { data: [], error: null },
    { data: [], error: null },
  ];
  sandbox._sbMaybeSingleResult = {
    data: { data: { txns: [{ id: 'remote-only', date: '2026-01-02', updatedAt: 100 }], recurrences: [], assets: [], deletedIds: {} }, updated_at: '2026-02-01T00:00:00.000Z' },
    error: null,
  };
  await sandbox.pushCloud();
  assert.strictEqual(sandbox.CLOUD_SYNC_STATE, 'conflict', '1회 재시도까지 실패하면 기존처럼 수동 충돌 상태로 떨어져야 함');
  assert.strictEqual(sandbox.toastCalls.length, 1, '무한 재시도 없이 딱 1번만 충돌 토스트를 띄워야 함');
  assert.ok(sandbox.lastToast.includes('다른 기기에 더 최신 데이터가 있어요'));
  assert.ok(sandbox.DB.txns.some(t => t.id === 'remote-only'), '최종 push는 실패했어도 재시도 과정의 병합 자체는 로컬 DB에 남아 데이터 손실이 없어야 함');
  assert.strictEqual(sandbox.markCloudSyncedCalls, 0, '끝내 성공하지 못했으니 markCloudSynced는 불리면 안 됨');
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

/* ---------- applyForeignSave: 다른 탭이 저장한 최신 DB를 반영할 때 _balCache/_recCache/_lastEditCache를
 * 함께 비우지 않던 버그의 회귀 테스트(app-evolve cycle76 develop). save()는 항상 맨 앞에서
 * invalidateBalances()를 부르는데(1871행), applyForeignSave()·resolveCloudPullRemote()·afterCloudAuth()
 * 는 save()를 거치지 않고 DB를 통째로 갈아치우면서 이 호출을 빠뜨렸다 — 그래서 같은 [from,to]/[upto,dateStr]
 * 키로 이미 채워진 잔액·반복거래 캐시가 옛 DB 기준 값을 그대로 돌려줘, 다른 탭에서 방금 저장한 거래가
 * 화면(잔액/순자산/알림)에 반영되지 않는 채로 남았다(로컬스토리지·DB 자체는 최신이라 오직 표시값만 낡음). */
test('applyForeignSave: localStorage의 최신 데이터로 DB를 교체하며 invalidateBalances를 호출해 낡은 잔액 캐시를 비운다', () => {
  sandbox.DB = { assets: [{ id: 'old' }], txns: [], categories: { expense: ['옛카테고리'] }, catIcon: {}, catVar: {}, budgets: {}, owners: ['나'], recurrences: [] };
  sandbox._lsRaw = JSON.stringify({ assets: [{ id: 'new1' }], txns: [{ id: 't1' }], owners: ['나'], recurrences: [] });
  sandbox.TAB_SAVED_AT = 1000;
  sandbox.TAB_SYNC_PENDING = 2000;
  let invalidateCalls = 0, renderCalls = 0;
  const origInvalidate = sandbox.invalidateBalances, origRender = sandbox.renderCurrent;
  sandbox.invalidateBalances = () => { invalidateCalls++; };
  sandbox.renderCurrent = () => { renderCalls++; };
  try {
    sandbox.applyForeignSave(3000);
  } finally {
    sandbox.invalidateBalances = origInvalidate;
    sandbox.renderCurrent = origRender;
  }
  assert.ok(sandbox.DB.assets.some(a => a.id === 'new1'), 'localStorage에서 읽은 새 DB로 교체되어야 함');
  assert.strictEqual(sandbox.TAB_SAVED_AT, 3000);
  assert.strictEqual(sandbox.TAB_SYNC_PENDING, null);
  assert.strictEqual(invalidateCalls, 1, '다른 탭의 최신 DB를 반영할 때도 save()와 마찬가지로 캐시를 비워야 함 — 안 그러면 같은 날짜 범위 키로 채워진 옛 잔액/반복거래 캐시가 그대로 남는다');
  assert.strictEqual(renderCalls, 1);
});
test('applyForeignSave: localStorage에 저장된 값이 없으면 DB를 건드리지 않는다', () => {
  const before = sandbox.DB;
  sandbox._lsRaw = null;
  sandbox.applyForeignSave(9999);
  assert.strictEqual(sandbox.DB, before, 'localStorage가 비어있으면 조용히 아무 것도 하지 않아야 함');
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

/* ---------- saveTx: touch()로 updatedAt 스탬프 (app-evolve cycle86 advance, saveRec/saveAsset와 동일 목적) ---------- */
test('saveTx: 신규 저장·기존 수정 모두 touch()로 updatedAt이 채워진다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '식비', memo: '점심',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns[0].updatedAt, 'test-updatedAt', '신규 저장 시 updatedAt이 채워져야 함');

  sandbox.txDraft = Object.assign({}, sandbox.DB.txns[0], { amount: 10000 });
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns[0].updatedAt, 'test-updatedAt', '수정 시에도 updatedAt이 갱신되어야 함');
});

/* ---------- saveTx: 더블탭 중복 저장 가드 (app-evolve cycle79 critique/advance) ----------
 * saveRec()과 같은 이유(closeSheet()가 innerHTML을 지우지 않아 저장 버튼이 트랜지션 동안
 * DOM에 남아있음)로, saveTx()도 반복 등록 분기(DB.recurrences.push)와 일회성 내역 분기
 * (DB.txns.push) 둘 다 더블탭 시 같은 항목이 2건 저장될 수 있었다. _savedDrafts(WeakSet)
 * 가드로 같은 txDraft 객체로의 재호출을 조용히 무시하도록 고쳤다. */
test('saveTx: 반복 켜고 저장 시 같은 draft로 두 번 연속 호출해도(더블탭) 반복이 중복 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '월세', memo: '',
    amount: 500000, fromAssetId: 'a1', toAssetId: null,
    repeat: true, freq: 'monthly', day: 10, endDate: null, count: null,
  };
  sandbox.saveTx();
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.recurrences.length, 1, '같은 draft로 다시 저장해도 반복이 1개만 있어야 함');
});
test('saveTx: 일회성 내역도 같은 draft로 두 번 연속 호출하면 두 번째는 무시된다(더블탭 가드)', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '식비', memo: '점심',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 1, '같은 draft로 다시 저장해도 거래가 1개만 있어야 함');
  assert.ok(!('_saved' in sandbox.DB.txns[0]), '가드 마커가 저장된 레코드에 섞여 들어가면 안 됨(WeakSet이어야 함)');
});
test('saveTx: 검증 실패(금액 없음)로 저장이 안 된 draft는 값을 채워 다시 저장하면 정상 저장된다(더블탭 가드가 실패 경로까지 막으면 안 됨)', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '식비', memo: '',
    amount: 0, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 0, '금액 없이는 저장되지 않아야 함');
  sandbox.txDraft.amount = 9000;
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 1, '값을 채워 같은 draft로 재시도하면 저장되어야 함');
});

/* ---------- saveTx/saveRec: RANGE_FROM(2023-01-01) 이전 날짜는 balancesUpTo 등
 * allTxns(RANGE_FROM,*) 기반 집계에서 조용히 빠지는데, 저장 시점엔 이를 막는 검증이 없었다.
 * dateBelowRangeFloor()로 두 저장 경로 모두 토스트로 막고 DB를 건드리지 않는지 확인한다. */
test('saveTx: RANGE_FROM 이전 날짜는 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2022-12-31', category: '식비', memo: '',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.toastCalls = [];
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 0, 'RANGE_FROM 이전 날짜는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some(m => m.includes('2023-01-01')), '하한 날짜를 알려주는 토스트가 떠야 함');
});
test('saveTx: RANGE_FROM 당일은 하한선에 포함되어 정상 저장된다(정상 케이스는 회귀 없음)', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2023-01-01', category: '식비', memo: '',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 1, 'RANGE_FROM 당일은 저장되어야 함');
});
// app-evolve cycle120 advance: RANGE_TO(상한)도 RANGE_FROM(하한)과 대칭으로 저장 시점에 막아야 한다.
test('saveTx: RANGE_TO 이후 날짜는 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.RANGE_TO = '2028-06-15';
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2028-06-16', category: '식비', memo: '',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.toastCalls = [];
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 0, 'RANGE_TO 이후 날짜는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some(m => m.includes('2028-06-15')), '상한 날짜를 알려주는 토스트가 떠야 함');
});
test('saveTx: RANGE_TO 당일은 상한선에 포함되어 정상 저장된다(정상 케이스는 회귀 없음)', () => {
  sandbox.TWi = -1;
  sandbox.RANGE_TO = '2028-06-15';
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2028-06-15', category: '식비', memo: '',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 1, 'RANGE_TO 당일은 저장되어야 함');
});

/* ---------- saveTx: 카테고리가 비어있으면(예: doDeleteCat 가드를 뚫고 마지막 카테고리가
 * 지워졌거나, migrate 이전 데이터 등) undefined 카테고리로 저장되지 않게 막는다 (cycle69) ---------- */
test('saveTx: category가 없으면(undefined) 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: undefined, memo: '',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.toastCalls = [];
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 0, 'category가 없으면 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.length, '안내 토스트가 떴어야 함');
});
test('saveTx: transfer는 category가 없어도(고정 카테고리 없음) 저장을 막지 않는다(정상 케이스는 회귀 없음)', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'transfer', date: '2026-01-15', category: undefined, memo: '',
    amount: 9000, fromAssetId: 'a1', toAssetId: 'a2', repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 1, 'transfer는 category 가드의 영향을 받지 않아야 함');
});
/* ---------- saveTx/saveRec: expense/income에 자산 선택 없이 저장되던 버그 (app-evolve cycle81 develop) ----------
 * transfer/saving은 fromAssetId/toAssetId가 없으면 '보내는·받는 자산을 선택해 주세요' 토스트로
 * 막았지만, expense/income은 이 가드가 전혀 없이 d.type==='expense'?d.toAssetId=null:... 로 남은
 * 쪽만 null 처리할 뿐 정작 써야 할 fromAssetId(expense)/toAssetId(income) 자체가 null이어도 그냥
 * 저장됐다. openTxSheet()/openRecSheet()가 fromAssetId 기본값으로 쓰는 firstCash()는 현금성
 * 자산이 하나도 없으면(예: 주식·금 등만 보유한 계정, 유일한 현금 자산을 삭제한 직후) null을
 * 반환하므로, 실사용에서 자산 없이 지출/수입을 저장하는 경로가 실제로 존재했다. 이렇게 저장된
 * 거래는 balanceAt/balancesUpTo가 fromAssetId/toAssetId 매치로만 잔액에 반영하므로 어떤 자산의
 * 잔액에도 반영되지 않고, 총자산에서 조용히 빠진 채 지출/수입 총계·카테고리 집계에만 남는다. */
test('saveTx: 지출인데 fromAssetId가 없으면(현금성 자산 없음) 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '식비', memo: '',
    amount: 9000, fromAssetId: null, toAssetId: null, repeat: false,
  };
  sandbox.toastCalls = [];
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 0, 'fromAssetId 없이는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.includes('자산을 선택해 주세요'));
});
test('saveTx: 수입인데 toAssetId가 없으면 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'income', date: '2026-01-15', category: '급여', memo: '',
    amount: 3000000, fromAssetId: null, toAssetId: null, repeat: false,
  };
  sandbox.toastCalls = [];
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 0, 'toAssetId 없이는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.includes('자산을 선택해 주세요'));
});
test('saveTx: 자산을 정상적으로 고른 지출/수입은 이 가드의 영향을 받지 않는다(정상 케이스는 회귀 없음)', () => {
  sandbox.TWi = -1;
  sandbox.DB = { txns: [], settings: {} };
  sandbox.txDraft = {
    id: null, type: 'expense', date: '2026-01-15', category: '식비', memo: '',
    amount: 9000, fromAssetId: 'a1', toAssetId: null, repeat: false,
  };
  sandbox.saveTx();
  assert.strictEqual(sandbox.DB.txns.length, 1);
});
test('saveRec: 지출인데 fromAssetId가 없으면 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.recDraft = {
    id: null, type: 'expense', category: '월세', memo: '', amount: 500000,
    fromAssetId: null, toAssetId: null, freq: 'monthly', day: 10,
    startDate: '2026-01-15', endDate: null, count: null, weekend: 'onDay',
  };
  sandbox.toastCalls = [];
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 0, 'fromAssetId 없이는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.includes('자산을 선택해 주세요'));
});
test('saveRec: 수입인데 toAssetId가 없으면 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.recDraft = {
    id: null, type: 'income', category: '급여', memo: '', amount: 3000000,
    fromAssetId: null, toAssetId: null, freq: 'monthly', day: 25,
    startDate: '2026-01-15', endDate: null, count: null, weekend: 'onDay',
  };
  sandbox.toastCalls = [];
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 0, 'toAssetId 없이는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.includes('자산을 선택해 주세요'));
});
test('saveRec: 시작일이 RANGE_FROM 이전이면 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.recDraft = {
    id: null, type: 'expense', category: '식비', memo: '', amount: 9000,
    fromAssetId: 'a1', toAssetId: null, freq: 'monthly', day: 10,
    startDate: '2022-06-01', endDate: null, count: null, weekend: 'onDay',
  };
  sandbox.toastCalls = [];
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 0, 'RANGE_FROM 이전 시작일은 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some(m => m.includes('2023-01-01')), '하한 날짜를 알려주는 토스트가 떠야 함');
});
// app-evolve cycle120 advance: RANGE_TO(상한)도 RANGE_FROM(하한)과 대칭으로 저장 시점에 막아야 한다.
test('saveRec: 시작일이 RANGE_TO 이후이면 토스트만 뜨고 저장되지 않는다', () => {
  sandbox.TWi = -1;
  sandbox.RANGE_TO = '2028-06-15';
  sandbox.DB = { recurrences: [], settings: {} };
  sandbox.recDraft = {
    id: null, type: 'expense', category: '식비', memo: '', amount: 9000,
    fromAssetId: 'a1', toAssetId: null, freq: 'monthly', day: 10,
    startDate: '2028-06-16', endDate: null, count: null, weekend: 'onDay',
  };
  sandbox.toastCalls = [];
  sandbox.saveRec();
  assert.strictEqual(sandbox.DB.recurrences.length, 0, 'RANGE_TO 이후 시작일은 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some(m => m.includes('2028-06-15')), '상한 날짜를 알려주는 토스트가 떠야 함');
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

/* ---------- balancesAtDates: 여러 날짜를 한 번의 정렬+포인터 누적으로 계산하는 배치 API
 * (app-evolve cycle149 critique/advance) ----------
 * planNegatives()/lowestInMonth()/planRowsHTML()처럼 같은 렌더 안에서 여러 날짜로 balanceAt()을
 * 거듭 부르면 balancesUpTo()의 날짜별 캐시(_balCache)가 매번 새 키라 allTxns(RANGE_FROM,RANGE_TO)
 * 전체를 처음부터 재스캔한다. balancesAtDates()는 assetBalanceSeries(logic.js)와 같은 원칙으로
 * 모든 자산·여러 날짜를 한 번의 정렬된 순회로 계산한다 — balanceAt()과 완전히 같은 값을 내야
 * 하고, dateStr>TODAY(proj=true, 미확인 이체 포함)/그 외(proj=false, 제외) 그룹을 올바르게 나눠야
 * 하며, allTxns() 호출 횟수가 날짜 수와 무관해야 한다. */
test('balancesAtDates: 여러 날짜를 배치로 계산해도 balanceAt()/balancesUpTo()와 완전히 같은 값을 낸다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox._balCache.clear();
  sandbox._recCache.clear(); // 바로 앞 테스트가 같은 (RANGE_FROM,RANGE_TO) 키에 daily 반복거래 확장 결과를 캐시해뒀을 수 있어, 이 테스트의 recurrences:[]와 어긋나지 않게 비운다
  sandbox.DB = {
    settings: {},
    assets: [
      { id: 'a1', type: 'cash', baseAmount: 10000 },
      { id: 'd1', type: 'debt', baseAmount: 50000 },
    ],
    txns: [
      { date: '2026-06-01', type: 'expense', category: '식비', amount: 1000, fromAssetId: 'a1' },
      { date: '2026-06-10', type: 'income', category: '용돈', amount: 3000, toAssetId: 'a1' },
      { date: '2026-06-20', type: 'transfer', amount: 5000, fromAssetId: 'a1', toAssetId: 'd1' },
    ],
    recurrences: [],
  };
  const dates = ['2026-06-05', '2026-06-15', '2026-06-25'];
  const balMap = sandbox.balancesAtDates(dates);
  dates.forEach(d => {
    sandbox._balCache.clear();
    assert.strictEqual(sandbox.balanceAtFromMap(balMap, d, 'a1'), sandbox.balanceAt('a1', d), `a1 @ ${d}는 balanceAt()과 같아야 함`);
    sandbox._balCache.clear();
    assert.strictEqual(sandbox.balanceAtFromMap(balMap, d, 'd1'), sandbox.balanceAt('d1', d), `d1(부채, 부호 반전) @ ${d}는 balanceAt()과 같아야 함`);
  });
});
test('balancesAtDates: dateStr>TODAY(예정)와 그 이전(완료)이 같은 배치에 섞여도 각각 올바른 미확인 이체 포함 규칙을 적용한다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox.DB = {
    settings: { confirmTransfers: true },
    assets: [
      { id: 'a1', type: 'cash', baseAmount: 500000 },
      { id: 'a2', type: 'cash', baseAmount: 0 },
    ],
    txns: [
      { id: 't1', date: sandbox.TODAY, type: 'transfer', amount: 600000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false },
    ],
    recurrences: [],
  };
  const pastDate = sandbox.TODAY, futureDate = '2026-07-01';
  const balMap = sandbox.balancesAtDates([pastDate, futureDate]);
  assert.strictEqual(sandbox.balanceAtFromMap(balMap, pastDate, 'a1'), 500000, '오늘(완료 잔액, proj=false)은 미확인 이체를 제외해야 함');
  assert.strictEqual(sandbox.balanceAtFromMap(balMap, futureDate, 'a1'), -100000, '미래 날짜(예정 반영, proj=true)는 미확인 이체도 포함해야 함');
});
test('balancesAtDates: 날짜 수와 무관하게 allTxns()는 단 한 번만 불린다(날짜마다 전체 재스캔하던 문제 회귀 방지)', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', type: 'cash', baseAmount: 0 }],
    txns: [{ date: '2026-01-10', type: 'expense', category: '식비', amount: 1000, fromAssetId: 'a1' }],
    recurrences: [],
  };
  const origAllTxns = sandbox.allTxns;
  let calls = 0;
  sandbox.allTxns = (...args) => { calls++; return origAllTxns(...args); };
  try {
    sandbox.balancesAtDates(['2026-06-01', '2026-06-10', '2026-06-20', '2026-06-30']);
    assert.strictEqual(calls, 1, '날짜가 몇 개든 allTxns()는 한 번만 불려야 함(각 날짜마다 다시 부르면 날짜 수만큼 늘어남)');
  } finally {
    sandbox.allTxns = origAllTxns;
  }
});
test('balanceAtFromMap: 맵에 값이 있으면 그대로, 없으면 balanceAt()과 동일하게 assetBase()로 폴백하고 자산이 없으면 0을 반환한다', () => {
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', type: 'cash', baseAmount: 7000 }],
    txns: [],
    recurrences: [],
  };
  const balMap = new Map([['2026-06-01', { a1: 1234 }]]);
  assert.strictEqual(sandbox.balanceAtFromMap(balMap, '2026-06-01', 'a1'), 1234, '맵에 있는 값을 그대로 써야 함');
  assert.strictEqual(sandbox.balanceAtFromMap(balMap, '2026-07-01', 'a1'), 7000, '맵에 그 날짜 자체가 없으면 assetBase()로 폴백해야 함');
  assert.strictEqual(sandbox.balanceAtFromMap(balMap, '2026-06-01', 'ghost'), 0, '자산이 DB에 없으면(삭제됨 등) 0을 반환해야 함(balanceAt()과 동일)');
});
test('lowestInMonth/planRowsHTML/planNegatives: batch 적용 후에도 allTxns()가 조회 날짜 수와 무관하게 상수 번만 불린다(app-evolve cycle149 advance 성능 개선 회귀 방지)', () => {
  sandbox.TODAY = '2026-06-05';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  // 한 달 내내(6/1~6/30) 매일 거래가 있어 날짜별 balanceAt()을 날짜마다 부르는 예전 구조였다면
  // allTxns() 호출 수가 거래 일수에 비례해 늘어난다 — batch 적용 후에는 호출 수가 상수(아래 count
  // 목록 길이)로 고정되어야 한다.
  const txns = [];
  for (let d = 1; d <= 30; d++) txns.push({ id: `t${d}`, date: `2026-06-${String(d).padStart(2, '0')}`, type: 'expense', category: '식비', amount: 100, fromAssetId: 'a1' });
  sandbox.DB = {
    settings: {},
    assets: [{ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: 100000 }],
    txns,
    recurrences: [],
  };
  const origAllTxns = sandbox.allTxns;
  const run = (fn) => {
    sandbox._balCache.clear();
    let calls = 0;
    sandbox.allTxns = (...args) => { calls++; return origAllTxns(...args); };
    try { fn(); } finally { sandbox.allTxns = origAllTxns; }
    return calls;
  };
  const lowCalls = run(() => sandbox.lowestInMonth('a1', 2026, 6));
  assert.ok(lowCalls <= 2, `lowestInMonth는 allTxns()를 거의 상수 번만 불러야 함(날짜 수와 무관) — 실제 ${lowCalls}번`);
  const rowsCalls = run(() => sandbox.planRowsHTML(sandbox.DB.assets[0], 2026, 6));
  assert.ok(rowsCalls <= 2, `planRowsHTML은 allTxns()를 거의 상수 번만 불러야 함 — 실제 ${rowsCalls}번`);
  const negCalls = run(() => sandbox.planNegatives());
  assert.ok(negCalls <= 2, `planNegatives는 allTxns()를 자산 수만큼만 불러야 하고(통장 하나) 조회 날짜 수와는 무관해야 함 — 실제 ${negCalls}번`);
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

/* ---------- addBalanceAdjust/updateBalanceAdjust: 자동 생성 조정 거래에도 touch()로 updatedAt
 * 스탬프 (app-evolve cycle88 advance, doMaturity 쪽과 동일 목적) ---------- */
test('addBalanceAdjust: 새로 만드는 조정 내역에도 touch()가 호출된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  const asset = { id: 'a1', type: 'cash', baseAmount: 4000 };
  sandbox.DB = { settings: {}, assets: [asset], txns: [], recurrences: [] };
  sandbox._balCache.clear();
  sandbox.addBalanceAdjust(asset, 1000);
  const adj = sandbox.DB.txns.find((t) => t.adjust && t.adjustAsset === 'a1');
  assert.strictEqual(adj.updatedAt, 'test-updatedAt', '새 조정 내역에도 touch()가 호출되어야 함');
});
test('updateBalanceAdjust: 기존 조정 내역을 재계산해 갱신할 때도 touch()가 호출된다', () => {
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
  sandbox.updateBalanceAdjust(asset, 6000);
  const adj = sandbox.DB.txns.find((t) => t.adjust && t.adjustAsset === 'a1');
  assert.strictEqual(adj.updatedAt, 'test-updatedAt', '재계산으로 갱신된 기존 조정 내역에도 touch()가 호출되어야 함');
});

/* ---------- toggleRecActive/toggleAdjustSurplus: 반복거래 일시중지·재시작 토글과 조정 내역의
 * "수지에 포함" 토글이 각각 r.active/t.inSurplus만 바꾸고 touch()를 안 불러, mergeCollection()이
 * updatedAt만 보고 승자를 고르는 cloud sync에서 다른 기기의 더 오래된 사본이 이겨 이 토글이
 * 조용히 되돌아갈 위험이 있었다(app-evolve cycle128 advance, doMaturity 쪽과 동일 패턴). ---------- */
test('toggleRecActive: 반복거래 일시중지/재시작 토글에도 touch()가 호출된다', () => {
  const rec = { id: 'r1', active: true };
  sandbox.DB = { settings: {}, recurrences: [rec] };
  sandbox.toggleRecActive('r1');
  assert.strictEqual(rec.active, false, '토글로 active가 꺼져야 함');
  assert.strictEqual(rec.updatedAt, 'test-updatedAt', '일시중지 토글에도 touch()가 호출되어야 함');
  sandbox.toggleRecActive('r1');
  assert.strictEqual(rec.active, true, '다시 토글하면 재시작돼야 함');
  assert.strictEqual(rec.updatedAt, 'test-updatedAt', '재시작 토글에도 touch()가 호출되어야 함');
});
test('toggleAdjustSurplus: 조정 내역의 "수지에 포함" 토글에도 touch()가 호출된다', () => {
  const t = { id: 't1', inSurplus: false };
  sandbox.DB = { settings: {}, txns: [t] };
  const el = { classList: { _on: false, toggle(c) { this._on = !this._on; }, contains() { return this._on; } }, setAttribute: () => {} };
  sandbox.toggleAdjustSurplus('t1', el);
  assert.strictEqual(t.inSurplus, true, '토글로 inSurplus가 켜져야 함');
  assert.strictEqual(t.updatedAt, 'test-updatedAt', '"수지에 포함" 토글에도 touch()가 호출되어야 함');
});

/* ---------- addBalanceAdjust/updateBalanceAdjust: 부채(debt) 자산에 잔액 조정 내역을
 * 만들 때 방향이 반대로 기록되던 버그의 회귀 테스트.
 * balancesUpTo()(2070줄)는 부채 자산에 sign=-1을 매겨, toAssetId로 들어오는 금액은 잔액을
 * 줄이고(상환) fromAssetId로 나가는 금액은 잔액을 늘린다(추가 대출) — balanceAt()가 부채를
 * "잔여원금(양수)"으로 보여주는 것과 일치하는 관례다. 그런데 addBalanceAdjust/updateBalanceAdjust는
 * 이 부호 관례를 몰라서 현금 자산과 똑같이 gap>0이면 무조건 toAssetId(입금) 방향으로 기록했다 —
 * 그 결과 부채가 늘어야 할 상황(gap>0, 빚이 더 생김)에 오히려 잔액이 줄어드는 조정 내역이 만들어졌다. */
test('addBalanceAdjust: 부채 자산은 gap>0(빚 증가)일 때 toAssetId가 아니라 fromAssetId로 기록해 잔액이 실제로 늘어난다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  const asset = { id: 'd1', type: 'debt', baseAmount: 100000 };
  sandbox.DB = { settings: {}, assets: [asset], txns: [], recurrences: [] };
  sandbox._balCache.clear();
  sandbox.addBalanceAdjust(asset, 50000); // 부채가 100000 -> 150000으로 늘어남
  assert.strictEqual(sandbox.balanceAt('d1', sandbox.TODAY), 150000, '부채 증가분(gap>0)이 잔액에 그대로 더해져야 함');
  const adj = sandbox.DB.txns.find((t) => t.adjust && t.adjustAsset === 'd1');
  assert.strictEqual(adj.type, 'expense');
  assert.strictEqual(adj.fromAssetId, 'd1');
  assert.strictEqual(adj.toAssetId, null);
});

test('addBalanceAdjust: 부채 자산은 gap<0(상환)일 때 toAssetId로 기록해 잔액이 실제로 줄어든다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  const asset = { id: 'd1', type: 'debt', baseAmount: 100000 };
  sandbox.DB = { settings: {}, assets: [asset], txns: [], recurrences: [] };
  sandbox._balCache.clear();
  sandbox.addBalanceAdjust(asset, -30000); // 상환으로 100000 -> 70000
  assert.strictEqual(sandbox.balanceAt('d1', sandbox.TODAY), 70000, '상환분(gap<0)이 잔액에서 그대로 빠져야 함');
  const adj = sandbox.DB.txns.find((t) => t.adjust && t.adjustAsset === 'd1');
  assert.strictEqual(adj.type, 'income');
  assert.strictEqual(adj.toAssetId, 'd1');
  assert.strictEqual(adj.fromAssetId, null);
});

test('updateBalanceAdjust: 부채 자산 수정 시에도(기존 조정 내역 갱신 경로) 방향이 올바르게 뒤집힌다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  const asset = { id: 'd1', type: 'debt', baseAmount: 100000 };
  sandbox.DB = {
    settings: {},
    assets: [asset],
    txns: [{ id: 'adj1', date: '2026-06-01', type: 'expense', category: sandbox.ADJUST_CAT, memo: '재등록 잔액 조정', amount: 50000, fromAssetId: 'd1', toAssetId: null, adjust: true, adjustAsset: 'd1' }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  assert.strictEqual(sandbox.balanceAt('d1', sandbox.TODAY), 150000, '기존 조정 포함 잔액(100000+50000)');
  const origInvalidate = sandbox.invalidateBalances;
  sandbox.invalidateBalances = () => sandbox._balCache.clear();
  try {
    sandbox.updateBalanceAdjust(asset, 200000); // 표시 잔액을 200000으로 더 늘림
  } finally {
    sandbox.invalidateBalances = origInvalidate;
  }
  const adj = sandbox.DB.txns.find((t) => t.adjust && t.adjustAsset === 'd1');
  assert.strictEqual(adj.amount, 100000, '기준값 100000 + 조정 100000 = 200000이어야 함');
  assert.strictEqual(adj.type, 'expense');
  assert.strictEqual(adj.fromAssetId, 'd1');
  sandbox._balCache.clear(); // updateBalanceAdjust 내부에서 base 계산 시 캐시된 값(조정 제외)이 아니라 최신 조정 반영값을 확인
  assert.strictEqual(sandbox.balanceAt('d1', sandbox.TODAY), 200000);
});

/* ---------- lowestInMonth: 거래별 증감을 직접 누적하지 않고 날짜별 balanceAt()을 불러야
 * balancesUpTo()가 이미 적용 중인 미확인 이체 제외 규칙이 그대로 반영된다. 예전 코드는
 * byDay 델타를 amount 그대로 누적해 isPending()을 전혀 확인하지 않았다. */
test('lowestInMonth: 오늘 날짜의 미확인(pending) 이체는 balanceAt(TODAY)처럼 제외되어야 한다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: { confirmTransfers: true },
    assets: [
      { id: 'a1', type: 'cash', baseAmount: 500000 },
      { id: 'a2', type: 'cash', baseAmount: 0 },
    ],
    txns: [{ id: 't1', date: '2026-06-15', type: 'transfer', amount: 300000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  assert.strictEqual(sandbox.balanceAt('a1', sandbox.TODAY), 500000, '미확인 이체는 오늘 잔액에서 제외되어야 함(기준값)');
  sandbox._balCache.clear();
  const low = sandbox.lowestInMonth('a1', 2026, 6);
  assert.strictEqual(low.amount, 500000, '미확인 이체가 섞이면 안 되므로 이번 달 최저 잔액도 그대로 500000이어야 함');
  assert.strictEqual(low.date, '2026-06-01');
});
test('lowestInMonth: 확인된(pending 아닌) 이체는 그 날짜부터 최저 잔액에 정상 반영된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: { confirmTransfers: true },
    assets: [
      { id: 'a1', type: 'cash', baseAmount: 500000 },
      { id: 'a2', type: 'cash', baseAmount: 0 },
    ],
    txns: [{ id: 't1', date: '2026-06-10', type: 'transfer', amount: 300000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: true }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  const low = sandbox.lowestInMonth('a1', 2026, 6);
  assert.strictEqual(low.amount, 200000);
  assert.strictEqual(low.date, '2026-06-10');
});

/* ---------- planRowsHTML: lowestInMonth와 같은 이유로, 날짜별 표시 잔액을 거래별 증감 직접
 * 누적이 아니라 balanceAt()으로 구해야 한다. 예전 코드는 startBal에서 flows의 delta를 그대로
 * 누적해(r+=dayFlows...) isPending()을 전혀 확인하지 않았고, 그 결과 이체 확인 기능을 켠 상태에서
 * 미확인 이체가 있으면 플랜 탭 일별 카드의 잔액이 같은 화면 상단의 월말/오늘까지 잔액
 * 카드(planBalInner, balanceAt 사용)와 서로 다른 값을 보여줬다. */
test('planRowsHTML: 미확인(pending) 이체는 날짜별 표시 잔액에서 balanceAt()과 동일하게 제외되어야 한다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.DB = {
    settings: { confirmTransfers: true },
    assets: [
      { id: 'a1', type: 'cash', baseAmount: 500000 },
      { id: 'a2', type: 'cash', baseAmount: 0 },
    ],
    txns: [{ id: 't1', date: '2026-06-10', type: 'transfer', amount: 300000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  const html = sandbox.planRowsHTML(sandbox.DB.assets[0], 2026, 6);
  const idx = html.indexOf('data-d="2026-06-10"');
  assert.ok(idx !== -1, '2026-06-10 날짜 카드가 없음');
  const nextIdx = html.indexOf('data-d=', idx + 1);
  const dayHtml = html.slice(idx, nextIdx === -1 ? html.length : nextIdx);
  assert.ok(dayHtml.includes('500,000원'), `미확인 이체는 표시 잔액에서 빠져야 하는데 500,000원이 없음: ${dayHtml.slice(0, 200)}`);
  assert.ok(!dayHtml.includes('200,000원'), '미확인 이체 금액이 표시 잔액에 잘못 반영됨(200,000원)');
});
test('planRowsHTML: 확인된(pending 아닌) 이체는 그 날짜부터 표시 잔액에 정상 반영된다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.DB = {
    settings: { confirmTransfers: true },
    assets: [
      { id: 'a1', type: 'cash', baseAmount: 500000 },
      { id: 'a2', type: 'cash', baseAmount: 0 },
    ],
    txns: [{ id: 't1', date: '2026-06-10', type: 'transfer', amount: 300000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: true }],
    recurrences: [],
  };
  sandbox._balCache.clear();
  const html = sandbox.planRowsHTML(sandbox.DB.assets[0], 2026, 6);
  const idx = html.indexOf('data-d="2026-06-10"');
  assert.ok(idx !== -1, '2026-06-10 날짜 카드가 없음');
  const nextIdx = html.indexOf('data-d=', idx + 1);
  const dayHtml = html.slice(idx, nextIdx === -1 ? html.length : nextIdx);
  assert.ok(dayHtml.includes('200,000원'), `확인된 이체는 표시 잔액에 반영돼야 하는데 200,000원이 없음: ${dayHtml.slice(0, 200)}`);
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

/* ---------- totalAssets/totalDebt/ownerAssets/ownerDebt: 순자산 숫자의 유일한 산술 근원인데
 * 지금까지 다른 테스트(renderHome/renderAssets 등)의 호출 그래프를 통해서만 간접 실행됐을 뿐
 * 직접 assertion이 없었다(app-evolve cycle80 critique). pruneNwHistory가 오래된 일별 스냅샷을
 * 월별로 비가역 압축해버리므로, 여기 회귀는 화면 표시가 아니라 과거 순자산 차트에 영구히 박제된다. ---------- */
function setupNetWorthDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = {
    settings: {},
    assets: [
      { id: 'a_cash', name: '내지갑', type: 'cash', owner: '나', baseAmount: 10000, includeInTotal: true },
      { id: 'a_sav', name: '배우자적금', type: 'savings', owner: '배우자', baseAmount: 5000, includeInTotal: true },
      { id: 'a_usd', name: '달러', type: 'fx', owner: '나', currency: 'USD', fxAmount: 100, includeInTotal: true },
      { id: 'a_gold', name: '금', type: 'gold', owner: '배우자', goldDon: 1, includeInTotal: true },
      { id: 'd_card', name: '카드빚', type: 'debt', owner: '나', baseAmount: 3000, includeInTotal: true },
      { id: 'a_hidden', name: '숨긴통장', type: 'cash', owner: '나', baseAmount: 999999, includeInTotal: false },
    ],
    txns: [],
    recurrences: [],
    rates: { fx: { USD: 1300 }, goldPerG: 90000, stocks: {} },
  };
  sandbox._balCache.clear();
}
test('totalAssets/totalDebt: 부채 자산은 totalDebt에만 잡히고 totalAssets에서는 제외되며, 값은 순수 현금성+시세 자산의 합이다', () => {
  setupNetWorthDB();
  // 10000(현금) + 5000(적금) + 100*1300(달러) + 1*3.75*90000(금, GOLD_G_PER_DON)
  const expectedAssets = 10000 + 5000 + 100 * 1300 + 1 * sandbox.GOLD_G_PER_DON * 90000;
  assert.strictEqual(sandbox.totalAssets(), expectedAssets);
  assert.strictEqual(sandbox.totalDebt(), 3000);
});
test('totalAssets/totalDebt: includeInTotal=false인 자산은 금액이 아무리 커도 어느 쪽 합계에도 잡히지 않는다', () => {
  setupNetWorthDB();
  const before = sandbox.totalAssets();
  sandbox.DB.assets.find(a => a.id === 'a_hidden').includeInTotal = true;
  sandbox._balCache.clear();
  assert.strictEqual(sandbox.totalAssets(), before + 999999, 'includeInTotal을 켜면 그제서야 합산에 반영되어야 함(반대로 꺼져 있으면 제외되어야 함을 함께 확인)');
});
test('ownerAssets/ownerDebt: owner로 필터링되어 다른 귀속의 자산·부채는 서로 섞이지 않는다', () => {
  setupNetWorthDB();
  assert.strictEqual(sandbox.ownerAssets('나'), 10000 + 100 * 1300, '"나"는 현금+달러만 포함(적금·금은 배우자 소유)');
  assert.strictEqual(sandbox.ownerDebt('나'), 3000);
  assert.strictEqual(sandbox.ownerAssets('배우자'), 5000 + 1 * sandbox.GOLD_G_PER_DON * 90000, '"배우자"는 적금+금만 포함');
  assert.strictEqual(sandbox.ownerDebt('배우자'), 0, '배우자 명의 부채가 없으면 0이어야 함(다른 귀속의 부채가 섞이면 안 됨)');
  assert.strictEqual(sandbox.ownerAssets('나') + sandbox.ownerAssets('배우자'), sandbox.totalAssets(), '귀속별 합은 전체 합과 일치해야 함');
});
/* ---------- assetAllocation(logic.js)/allocationCard: 자산유형별 비중 카드 (app-evolve cycle125 critique/advance) ---------- */
test('assetAllocation: 혼합 포트폴리오는 금액 내림차순으로 정렬되고 pct 합이 100에 근접한다', () => {
  const r = sandbox.assetAllocation([{ type: 'cash', amount: 10000 }, { type: 'stock', amount: 70000 }, { type: 'gold', amount: 20000 }]);
  assert.strictEqual(r.length, 3);
  // r은 vm 샌드박스(다른 realm)에서 만들어진 배열이라 deepStrictEqual이 프로토타입 불일치로
  // 거짓 실패한다(cycle121 advance에서 겪은 것과 동일한 cross-realm 문제) — JSON.stringify로 비교.
  assert.strictEqual(JSON.stringify(r.map(x => x.type)), JSON.stringify(['stock', 'gold', 'cash']), '금액 큰 순으로 정렬되어야 함');
  const pctSum = r.reduce((s, x) => s + x.pct, 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-9, `부동소수점 오차 안에서 pct 합은 100이어야 함(실제 ${pctSum})`);
  assert.strictEqual(r.find(x => x.type === 'stock').pct, 70);
});
test('assetAllocation: 같은 type이 여러 항목이면 합산한다', () => {
  const r = sandbox.assetAllocation([{ type: 'cash', amount: 3000 }, { type: 'cash', amount: 7000 }, { type: 'stock', amount: 10000 }]);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r.find(x => x.type === 'cash').amount, 10000);
  assert.strictEqual(r.find(x => x.type === 'cash').pct, 50);
});
test('assetAllocation: 빈 배열/전부 0이면 divide-by-zero 없이 빈 배열을 반환한다', () => {
  assert.strictEqual(sandbox.assetAllocation([]).length, 0);
  assert.strictEqual(sandbox.assetAllocation([{ type: 'cash', amount: 0 }]).length, 0);
  assert.strictEqual(sandbox.assetAllocation(null).length, 0);
});
test('assetAllocation: 단일 유형이면 100%', () => {
  const r = sandbox.assetAllocation([{ type: 'cash', amount: 50000 }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].pct, 100);
});
test('assetAllocation: amount가 0 이하인 항목(가격 미확인 등)은 분모에 포함되지만 집계 목록에는 나타나지 않는다', () => {
  const r = sandbox.assetAllocation([{ type: 'cash', amount: 10000 }, { type: 'stock', amount: 0 }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, 'cash');
  assert.strictEqual(r[0].pct, 100, 'amount=0인 항목은 분모(total)에도 안 잡혀야 cash가 100%가 됨');
});
test('allocationCard: owner="all"(기본)이면 includeInTotal 자산 중 부채를 뺀 나머지를 유형별로 보여준다(배우자 포함 가구 전체)', () => {
  setupNetWorthDB();
  const html = sandbox.allocationCard();
  assert.ok(html.includes('자산 비중'));
  assert.ok(html.includes('금'), '배우자 소유 금도 전체(all) 보기에는 포함되어야 함');
  assert.ok(html.includes('70%'), '금(337500) / 전체(482500) ≈ 70%가 되어야 함');
  assert.ok(html.includes('337,500원'));
  assert.ok(!html.includes('카드빚'), '부채는 비중 집계에서 제외되어야 함');
});
test('allocationCard: owner를 넘기면 ownerAssets와 동일하게 그 귀속의 자산만 집계하고, includeInTotal=false 자산은 제외한다', () => {
  setupNetWorthDB();
  const html = sandbox.allocationCard('나');
  assert.ok(html.includes('외화'), '"나"는 현금+달러(외화)만 보유');
  assert.ok(!html.includes('저축'), '적금(배우자 소유)은 "나" 비중에 안 섞여야 함');
  assert.ok(!html.includes('999,999원'), 'includeInTotal=false인 숨긴통장은 금액이 커도 집계에서 빠져야 함');
});
test('allocationCard: 집계 대상 자산이 전혀 없으면(모두 부채거나 미포함) 카드를 광고하지 않고 빈 문자열을 반환한다', () => {
  sandbox.DB = { settings: {}, assets: [{ id: 'd1', type: 'debt', owner: '나', baseAmount: 1000, includeInTotal: true }], txns: [], recurrences: [], rates: { fx: {}, goldPerG: 0, stocks: {} } };
  sandbox._balCache.clear();
  assert.strictEqual(sandbox.allocationCard(), '', '부채만 있으면 비중 카드는 숨겨야 함(nwHistoryCard/goalsSummaryCard와 동일한 빈 상태 원칙)');
  assert.strictEqual(sandbox.allocationCard('없는귀속'), '', '아무도 소유하지 않은 귀속이면 빈 문자열');
});
test('openAssetPicker: excludeId(만기이체 picker에서 자기 자신 제외)를 넘기면 그 자산은 목록에서 빠지고 나머지는 그대로 남는다', () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  sandbox.openAssetPicker({ cashOnly: true, excludeId: 'a_sav', onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(html.includes('data-val="a_cash"'), '다른 현금성 자산은 그대로 있어야 함');
  assert.ok(!html.includes('data-val="a_sav"'), 'excludeId로 지정한 자산 본인은 빠져야 함');
});

/* ---------- openAssetPicker: 조건에 맞는 자산이 0개면(신규 가입자/게스트가 자산 0개로 시작해
 * 첫 거래 입력에서 이 경로를 그대로 밟는다, emptyDB()) 예전엔 아이콘/안내/CTA 없이
 * `<p>선택할 자산이 없어요</p>` 맨 텍스트만 보여줘 사용자가 왜 막혔는지 알 방법이 없는 막다른
 * 길이었다(app-evolve cycle139 advance). openPlanAsset()의 통장 선택 빈 상태·assetBodyHTML()의
 * 자산목록 빈 상태와 같은 .empty(아이콘+제목+설명+CTA) 패턴으로 교체했다. ---------- */
test('openAssetPicker: 조건에 맞는 자산이 0개면 맨 텍스트 대신 .empty 패턴(아이콘+제목+설명+자산 추가 CTA)을 보여준다', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DB = { settings: { groupOrder: ['cash', 'savings', 'fx', 'gold', 'stock'] }, assets: [], txns: [], recurrences: [], rates: {} };
  sandbox._balCache.clear();
  sandbox.lastPickerHtml = null;
  sandbox.openAssetPicker({ onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(!html.includes('선택할 자산이 없어요'), '예전의 맨 텍스트 안내문은 더는 없어야 함');
  assert.ok(html.includes('class="empty"'), '다른 화면과 동일한 .empty 빈 상태 래퍼를 써야 함');
  assert.ok(html.includes('등록된 자산이 없어요'), '제목이 있어야 함');
  assert.ok(html.includes('class="empty-cta"') && html.includes("onclick=\"openAssetSheet()\""), '자산 추가 CTA가 있어야 함');
});
test('openAssetPicker: cashOnly/excludeMarketValued 필터로 0개가 되는 경우도 동일한 .empty 패턴을 보여준다', () => {
  setupAssetPickerDB();
  sandbox.DB.assets = sandbox.DB.assets.filter((a) => a.type === 'fx' || a.type === 'gold' || a.type === 'stock'); // 현금성 자산 없음
  sandbox.lastPickerHtml = null;
  sandbox.openAssetPicker({ cashOnly: true, onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(!html.includes('선택할 자산이 없어요'));
  assert.ok(html.includes('class="empty"') && html.includes('class="empty-cta"'));
});

/* ---------- _applyOpenAsset: 이체/저축 입력 화면(txOpenAsset/recOpenAsset)에서 보내는/받는
 * 자산 picker가 이미 고른 반대쪽 자산을 제외하지 않던 버그(app-evolve cycle122 develop).
 * asOpenMat()이 여는 만기이체 picker는 excludeId로 자기 자신을 걸러내는데(cycle34), 같은
 * self-reference 문제가 이체/저축 폼의 from/to picker에는 전혀 막혀있지 않아 같은 자산을
 * 양쪽에 고를 수 있었다 — saveTx/saveRec의 fromAssetId===toAssetId 가드(3507/3698)가 저장
 * 시점에야 막아 사용자가 저장 버튼을 누른 뒤에야 실수를 알게 됐다. excludeId를 type이
 * transfer/saving일 때만 반대쪽 필드로 넘기도록 고쳤다 — expense/income은 fromAssetId/
 * toAssetId 중 하나만 쓰므로(저장 시점에야 나머지가 null로 치워짐, 3511/3704) 무조건
 * 반대쪽을 excludeId로 쓰면 그 사이 남아있는 값 때문에 멀쩡한 자산이 숨을 수 있어 제외했다. ---------- */
test("_applyOpenAsset: type='transfer'면 'to' picker에서 이미 고른 fromAssetId가 목록에서 빠진다", () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  const d = { type: 'transfer', fromAssetId: 'a_cash', toAssetId: null };
  sandbox._applyOpenAsset(d, 'to', () => {}, () => {});
  const html = sandbox.lastPickerHtml;
  assert.ok(!html.includes('data-val="a_cash"'), '이미 보내는 자산으로 고른 a_cash는 받는 자산 후보에서 빠져야 함');
  assert.ok(html.includes('data-val="a_sav"'), '다른 자산은 그대로 남아야 함');
});
test("_applyOpenAsset: type='saving'이면 'from' picker에서 이미 고른 toAssetId가 목록에서 빠진다", () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  const d = { type: 'saving', fromAssetId: null, toAssetId: 'a_sav' };
  sandbox._applyOpenAsset(d, 'from', () => {}, () => {});
  const html = sandbox.lastPickerHtml;
  assert.ok(!html.includes('data-val="a_sav"'), '이미 받는 자산으로 고른 a_sav는 보내는 자산 후보에서 빠져야 함');
  assert.ok(html.includes('data-val="a_cash"'), '다른 자산은 그대로 남아야 함');
});
test("_applyOpenAsset: type='expense'면 반대쪽(toAssetId)에 값이 남아있어도 'from' picker에서 제외하지 않는다", () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  // expense는 toAssetId를 쓰지 않지만 saveTx가 저장 시점에야 null로 치우므로(3511) 폼 편집
  // 도중엔 다른 타입에서 넘어온 값이 남아있을 수 있다 — 그 값으로 자산이 숨으면 안 된다.
  const d = { type: 'expense', fromAssetId: null, toAssetId: 'a_cash' };
  sandbox._applyOpenAsset(d, 'from', () => {}, () => {});
  const html = sandbox.lastPickerHtml;
  assert.ok(html.includes('data-val="a_cash"'), 'expense에서는 남아있는 toAssetId로 자산이 숨으면 안 됨');
});
test("_applyOpenAsset: type='income'이면 반대쪽(fromAssetId)에 값이 남아있어도 'to' picker에서 제외하지 않는다", () => {
  setupAssetPickerDB();
  sandbox.lastPickerHtml = null;
  const d = { type: 'income', fromAssetId: 'a_cash', toAssetId: null };
  sandbox._applyOpenAsset(d, 'to', () => {}, () => {});
  const html = sandbox.lastPickerHtml;
  assert.ok(html.includes('data-val="a_cash"'), 'income에서는 남아있는 fromAssetId로 자산이 숨으면 안 됨');
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
/* ---------- doMaturity: assetEval()이 저축 자산에 대해 schHorizon() 투영(예정 포함 설정 시
 * 이번 달 말까지 반영)을 쓰는 assetBalance()로 흐르는데, 만기 이체 금액을 그 값으로 계산해
 * 아직 도래하지 않은 이번 달 예정 입금까지 실제 이체 금액에 얹던 버그(app-evolve cycle86 develop).
 * balanceAt(a.id, date)로 바꿔 '만기 이체 시점'까지 실제 반영된 잔액만 옮기도록 고쳤다. ---------- */
test('doMaturity: 예정 포함 설정에서도 오늘 이후 예정된 입금은 만기 이체 금액에 포함되지 않는다', () => {
  setupMaturityDB();
  sandbox.DB.settings.includeScheduled = true;
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  sandbox.DB.txns.push({ id: 't_future', type: 'income', date: '2026-06-28', category: '급여', memo: '', amount: 2000, fromAssetId: null, toAssetId: 'a_sav', confirmed: true });
  sandbox.doMaturity('a_sav');
  const t = sandbox.DB.txns.find(x => x.type === 'transfer' && x.fromAssetId === 'a_sav');
  assert.strictEqual(t.amount, 5000, '아직 오지 않은 6/28 예정 입금 2000은 6/15 만기 이체 금액에 섞이면 안 됨');
});
/* ---------- doMaturity: 자동 생성 이체에도 touch()로 updatedAt 스탬프 (app-evolve cycle88 advance) ----------
 * cycle86/87이 saveTx/saveAsset/saveRec 및 recSave/recApply/splitRecurrenceAt에 touch()를 배선했지만,
 * 사용자가 직접 누르지 않고 앱이 자동 생성하는 거래(만기 이체, 잔액 조정, CSV 가져오기 등)에는
 * 빠져 있어 클라우드 3-way 병합이 들어오면 이 레코드들이 스탬프 없이 조용히 질 위험이 있었다. ---------- */
test('doMaturity: 자동 생성된 만기 이체 거래에도 touch()가 호출된다', () => {
  setupMaturityDB();
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  sandbox.doMaturity('a_sav');
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.updatedAt, 'test-updatedAt', '만기 이체 거래에도 touch()가 호출되어야 함');
});
/* ---------- doMaturity: 레거시 백업/오입력으로 만기일이 RANGE_FROM(2023-01-01) 이전이면,
 * 기존엔 그 범위 밖 날짜로 거래를 그대로 push해 allTxns(RANGE_FROM,RANGE_TO) 조회 범위 밖에
 * 쌓이고 가계부/전체내역/잔액 어디에도 다시 나타나지 않는 조용한 소실로 이어졌다(cycle123
 * planTransfer 버그와 동일 패턴). 자동 플로우라 saveTx처럼 저장을 거부할 수 없으므로,
 * sanitizeBackup의 endDate 정규화 관례를 따라 RANGE_FROM으로 클램프한다(app-evolve cycle127 advance). ---------- */
test('doMaturity: RANGE_FROM 이전 레거시 만기일은 거래 날짜를 RANGE_FROM으로 클램프해 가시 범위 안에 남긴다', () => {
  setupMaturityDB();
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityDate = '2020-01-01';
  sandbox.toastCalls = [];
  sandbox.doMaturity('a_sav');
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.date, sandbox.RANGE_FROM, 'RANGE_FROM 이전 만기일은 RANGE_FROM으로 보정되어야 함');
  assert.ok(sandbox.toastCalls.some(m => m.includes(sandbox.RANGE_FROM)), '보정했다는 안내가 떠야 함');
});
test('doMaturity: 정상 범위 안 만기일은 클램프 없이 그대로 이체 날짜로 쓰인다(정상 케이스는 회귀 없음)', () => {
  setupMaturityDB();
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  sandbox.doMaturity('a_sav');
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.date, '2026-06-10');
});
/* ---------- doMaturity: 저축 자산은 overdraft 가드가 없어 잔액이 0 이하로 내려갈 수 있는데,
 * 그 상태로 만기를 맞으면 amount<=0인 transfer 거래가 생겨 "amount는 항상 양수(방향은 from/to로만
 * 표현)"라는 앱 전체의 불변식(sanitizeBackup이 백업/클라우드 복원에서만 강제하던 것과 동일한 규칙)을
 * 깨고, balancesUpTo()의 흐름 방향이 뒤집힌다(app-evolve cycle169 develop). ---------- */
test('doMaturity: 잔액이 0 이하면 이체 거래를 만들지 않고 안내만 한다', () => {
  setupMaturityDB();
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  sandbox.DB.assets.find(a => a.id === 'a_sav').baseAmount = 0;
  const before = sandbox.DB.txns.length;
  sandbox.doMaturity('a_sav');
  assert.strictEqual(sandbox.DB.txns.length, before, '잔액이 0이면 만기 이체 거래가 생기면 안 됨');
  assert.strictEqual(sandbox.DB.assets.find(a => a.id === 'a_sav').maturityDate, '2026-06-10', '실행 안 됐으니 만기일도 그대로 남아야 함');
  assert.ok(sandbox.toastCalls.some(m => m.includes('잔액이 없어요')), '잔액이 없다는 안내가 떠야 함');
});
test('doMaturity: 인출로 잔액이 음수가 된 저축 자산도 이체 거래를 만들지 않는다', () => {
  setupMaturityDB();
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  sandbox.DB.txns.push({ id: 't_wd', type: 'expense', date: '2026-06-01', category: '기타', memo: '', amount: 8000, fromAssetId: 'a_sav', toAssetId: null, confirmed: true });
  const before = sandbox.DB.txns.length;
  sandbox.doMaturity('a_sav');
  assert.strictEqual(sandbox.DB.txns.length, before, '잔액이 음수면 만기 이체 거래가 생기면 안 됨');
  assert.ok(sandbox.toastCalls.some(m => m.includes('잔액이 없어요')), '잔액이 없다는 안내가 떠야 함');
});
/* ---------- openMaturity: 만기일을 ISO 원문('2026-06-10')으로 그대로 노출하던 버그
 * (app-evolve cycle159 develop) — 같은 필드를 쓰는 다른 화면(homeAlerts의 mat, 목표관리 목표일)은
 * 전부 shortDate/fmtDateFull로 사람이 읽는 형식을 쓰는데 이 시트만 가공 없이 날짜 문자열을 그대로
 * 템플릿에 꽂고 있었다. shortDate(a.maturityDate)로 바꿔 통일했다. ---------- */
test('openMaturity: 만기일을 shortDate 형식으로 보여주고 ISO 원문은 노출하지 않는다', () => {
  setupMaturityDB();
  sandbox.lastSheetHtml = null;
  sandbox.openMaturity();
  assert.ok(sandbox.lastSheetHtml.includes(sandbox.shortDate('2026-06-10')), '만기일이 shortDate 형식으로 보여야 함');
  assert.ok(!sandbox.lastSheetHtml.includes('만기 2026-06-10'), '만기일이 가공 없이 ISO 원문 그대로 노출되면 안 됨');
});
/* ---------- doMaturity: maturityDate=null로 지우는 자산 자체에는 touch()가 없어, cloud sync
 * 병합 시 다른 기기의 더 오래된 사본이 이겨 만기 처리(이체 생성+플래그 클리어)가 되돌아가면
 * maturityDate가 되살아나 '만기 임박' 알림이 재발하고, 사용자가 다시 '이체'를 누르면 동일 금액의
 * 이체 거래가 중복 생성될 위험이 있었다(app-evolve cycle128 advance). ---------- */
test('doMaturity: 만기 처리된 자산(maturityDate=null) 자체에도 touch()가 호출된다', () => {
  setupMaturityDB();
  sandbox.DB.assets.find(a => a.id === 'a_sav').maturityTargetId = 'a_cash';
  sandbox.doMaturity('a_sav');
  const a = sandbox.DB.assets.find(x => x.id === 'a_sav');
  assert.strictEqual(a.updatedAt, 'test-updatedAt', '만기 처리된 자산에도 touch()가 호출되어야 함');
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
test('emptyAssetCards: 정리 대상이 1건이면 기존처럼 상세 카드가 나오고, snoozeTidy() 이후엔 빈 문자열이 된다', () => {
  setupEmptyAssetsDB();
  sandbox.DB.assets = sandbox.DB.assets.filter((a) => a.id !== 'a_stockHasTxn'); // a_savings0 하나만 남김
  const before = sandbox.emptyAssetCards();
  assert.ok(before.includes('만기지난적금'), '1건이면 자산 이름이 보이는 상세 카드여야 함');
  assert.ok(!before.includes('onclick="openTidyList()"'), '1건이면 목록 시트로 보내면 안 됨');
  sandbox.snoozeTidy('a_savings0');
  const after = sandbox.emptyAssetCards();
  assert.ok(!after.includes('만기지난적금'), 'snoozeTidy() 이후에도 카드가 계속 노출됨');
  assert.strictEqual(after, '', '1건뿐이었으면 미루고 난 뒤엔 빈 문자열이어야 함');
});
test('emptyAssetCards: 정리할 자산이 없으면 빈 문자열을 반환한다', () => {
  setupEmptyAssetsDB();
  sandbox.DB.assets = sandbox.DB.assets.filter((a) => a.id === 'a_cash');
  assert.strictEqual(sandbox.emptyAssetCards(), '');
});
test('emptyAssetCards: 정리 대상이 2건 이상이면 confirm/neg/mat/quick/budgetOver처럼 요약 카드 1장으로 묶인다(app-evolve cycle158)', () => {
  setupEmptyAssetsDB(); // a_savings0 + a_stockHasTxn = 2건
  const html = sandbox.emptyAssetCards();
  assert.ok(html.includes('다 쓴 자산 정리 2건'), '건수 안내가 있어야 함');
  assert.ok(html.includes('onclick="openTidyList()"'), '요약 카드는 openTidyList()로 열려야 함');
  assert.ok(!html.includes('만기지난적금') && !html.includes('예정거래있는주식'), '요약 카드에는 개별 자산 이름이 보이면 안 됨');
  assert.ok(!html.includes(`onclick="openTidyAsset('a_savings0')"`), '요약 카드에서 바로 개별 정리로 연결되면 안 됨');
});
test('emptyAssetCards: snoozeTidy()로 2건 중 1건을 미루면 남은 1건은 다시 상세 카드로 돌아온다', () => {
  setupEmptyAssetsDB();
  sandbox.snoozeTidy('a_stockHasTxn');
  const after = sandbox.emptyAssetCards();
  assert.ok(after.includes('만기지난적금'), '1건만 남으면 상세 카드로 돌아와야 함');
  assert.ok(!after.includes('다 쓴 자산 정리'), '1건이면 요약 카드 문구가 남으면 안 됨');
});
test('renderHome: 다 쓴 자산 정리 제안(emptyAssetCards)이 실제로 렌더링 템플릿에 포함되어 있다', () => {
  // 예전부터 정의만 돼 있고 어디서도 호출되지 않던 죽은 코드였던 emptyAssetCards()를
  // renderHome()에 연결했다 — 다시 호출이 빠지면 이 테스트가 잡는다.
  const body = extractFunction('renderHome');
  assert.ok(body.includes('emptyAssetCards()'), 'renderHome()이 emptyAssetCards()를 호출하지 않음');
});
test('emptyAssetCards: 1건일 때의 정리 제안 행(ha-b)에 키보드/스크린리더 접근 패턴이 있다', () => {
  setupEmptyAssetsDB();
  sandbox.DB.assets = sandbox.DB.assets.filter((a) => a.id !== 'a_stockHasTxn');
  const html = sandbox.emptyAssetCards();
  assert.ok(html.includes('role="button"'), 'ha-b 행에 role="button"이 없음');
  assert.ok(html.includes('onkeydown="rowKeydown('), 'ha-b 행에 rowKeydown 연결이 없음');
});
/* openTidyList: emptyAssetCards()가 2건 이상일 때 여는 목록 시트. openStaleMvReview()/dismissStaleMv()와
 * 동일한 "행을 처리하면 시트를 다시 그려 유지"하는 패턴 — '나중에'를 눌러도 시트가 닫히지 않고
 * 그 행만 목록에서 빠지며, 1건만 남으면 기존 개별 확인 흐름(openTidyAsset)으로 넘어간다.
 * (app-evolve cycle158 advance) */
test('openTidyList: 정리 대상이 없으면 시트를 닫기만 한다', () => {
  setupEmptyAssetsDB();
  sandbox.DB.assets = sandbox.DB.assets.filter((a) => a.id === 'a_cash');
  sandbox.closeSheetCalls = 0;
  sandbox.lastSheetHtml = null;
  sandbox.openTidyList();
  assert.strictEqual(sandbox.closeSheetCalls, 1, '정리할 자산이 없으면 시트를 닫아야 함');
  assert.strictEqual(sandbox.lastSheetHtml, null, '항목이 없으면 시트를 새로 열면 안 됨');
});
test('openTidyList: 정확히 1건이면 목록 없이 바로 openTidyAsset의 개별 확인 시트로 간다', () => {
  setupEmptyAssetsDB();
  sandbox.DB.assets = sandbox.DB.assets.filter((a) => a.id !== 'a_stockHasTxn'); // a_savings0 하나만
  sandbox.closeSheetCalls = 0;
  sandbox.confirmSheetCalls = [];
  sandbox.openTidyList();
  assert.strictEqual(sandbox.closeSheetCalls, 1, '목록 시트로 가기 전에 닫아야 함(openTidyAsset이 자기 확인 시트를 새로 염)');
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '1건이면 openTidyAsset의 개별 확인 시트가 떠야 함');
  assert.ok(sandbox.confirmSheetCalls[0].msg.includes('만기지난적금'), '그 자산에 대한 확인 시트여야 함');
});
test('openTidyList: 2건 이상이면 한 시트에 한 줄씩 보여주고 각 행에 정리/나중에 버튼이 연결된다', () => {
  setupEmptyAssetsDB(); // a_savings0 + a_stockHasTxn
  sandbox.lastSheetHtml = null;
  sandbox.openTidyList();
  const html = sandbox.lastSheetHtml;
  assert.ok(html, '2건 이상이면 목록 시트를 열어야 함');
  assert.ok(html.includes('자산 2개'), '건수 안내가 있어야 함');
  assert.ok(html.includes('만기지난적금') && html.includes('예정거래있는주식'), '각 자산 이름이 한 줄씩 보여야 함');
  assert.ok(html.includes(`onclick="openTidyAsset('a_savings0')"`), '정리 버튼은 openTidyAsset으로 연결돼야 함');
  assert.ok(html.includes(`onclick="tidyListSnooze('a_savings0')"`), '나중에 버튼은 tidyListSnooze로 연결돼야 함');
});
test('openTidyList: 2건 중 1건을 나중에로 미루면 시트를 닫지 않고 남은 1건으로 다시 그린다', () => {
  setupEmptyAssetsDB();
  sandbox.lastSheetHtml = null;
  sandbox.closeSheetCalls = 0;
  sandbox.confirmSheetCalls = [];
  sandbox.openTidyList();
  assert.ok(sandbox.lastSheetHtml.includes('만기지난적금') && sandbox.lastSheetHtml.includes('예정거래있는주식'));
  sandbox.tidyListSnooze('a_stockHasTxn');
  assert.strictEqual(sandbox.closeSheetCalls, 1, '남은 게 1건이면 openTidyList가 openTidyAsset으로 넘기며 목록 시트를 닫아야 함(닫기 1회)');
  assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '미룬 자산을 빼고 남은 1건의 개별 확인 시트가 떠야 함');
  assert.ok(sandbox.confirmSheetCalls[0].msg.includes('만기지난적금'), '남은 자산에 대한 확인 시트여야 함');
  assert.ok(!sandbox.confirmSheetCalls[0].msg.includes('예정거래있는주식'), '나중에를 누른 자산은 더 이상 보이면 안 됨');
});

/* ---------- bare onclick 행 키보드/스크린리더 접근성 — flow-item/acct-card/spend-row/of-row/backup ha-b ----------
 * 자산 카드·캘린더 셀 등 다른 상호작용 행들은 tabindex/role="button"/aria-label과 rowKeydown()을
 * 함께 쓰는데, 이 5곳은 한동안 bare <div onclick=...>로만 남아 키보드/스크린리더로 조작할 수 없었다.
 * 이 함수들은 $/openSheet 등 DOM 의존성이 있어 실행 대신 소스 텍스트로 패턴 유지를 확인한다
 * (renderHome의 emptyAssetCards() 연결 테스트와 같은 방식). */
test('renderPlan: 플랜 탭 일별 거래 행(flow-item)에 키보드/스크린리더 접근 패턴이 있다', () => {
  // flow-item 마크업은 renderPlan()이 아니라 그 안에서 호출하는 planRowsHTML()에 있다
  // (planAsset()이 renderPlan() 전체 대신 refreshPlanBody()로 목록만 갱신할 수 있도록 분리됨).
  const body = extractFunction('planRowsHTML');
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
/* ---------- doRenameOwner: 귀속 이름변경 시 활성 필터(ST.assetOwner/ST.plan.owner/ST.spendOwner)가 낡은 이름으로 남던 버그 ----------
 * renderAssets/renderPlan/openSpendAnalysis의 "귀속 사라지면 전체로" 가드는 실제 삭제(delOwner)를 위한
 * 안전망인데, doRenameOwner()가 DB.owners[i]/자산의 owner만 새 이름으로 옮기고 ST.assetOwner/ST.plan.owner/
 * ST.spendOwner는 옛 이름 그대로 두는 바람에, 이름변경만 했을 뿐인데도 위 가드가 "귀속이 사라졌다"고 오판해
 * 사용자가 보고 있던 귀속 필터가 아무 설명 없이 전체/'전체'로 조용히 풀렸다. doRenameOwner가
 * 활성 필터도 함께 새 이름으로 옮기도록 고쳤다. (ST.spendOwner는 cycle118에서 추가 — assetOwner/plan.owner는
 * 이미 고쳐져 있었는데 나중에 생긴 예산탭 지출분석 귀속 필터만 이 마이그레이션에서 빠져 있었음) */
test('doRenameOwner: 이름변경 시 ST.assetOwner/ST.plan.owner/ST.spendOwner가 옛 이름을 가리키고 있었다면 새 이름으로 함께 옮겨간다', () => {
  sandbox.DB = { owners: ['나', '아빠'], assets: [{ owner: '아빠' }] };
  sandbox.ST = { assetOwner: '아빠', plan: { owner: '아빠' }, spendOwner: '아빠' };
  const $orig = sandbox.$;
  sandbox.$ = (id) => (id === 'renameOwner' ? { value: '아버지' } : $orig(id));
  try {
    sandbox.doRenameOwner(1);
  } finally {
    sandbox.$ = $orig;
  }
  assert.strictEqual(sandbox.DB.owners[1], '아버지');
  assert.strictEqual(sandbox.DB.assets[0].owner, '아버지');
  assert.strictEqual(sandbox.ST.assetOwner, '아버지', '자산 탭 귀속 필터가 새 이름을 따라가지 않음');
  assert.strictEqual(sandbox.ST.plan.owner, '아버지', '플랜 탭 귀속 필터가 새 이름을 따라가지 않음');
  assert.strictEqual(sandbox.ST.spendOwner, '아버지', '예산 탭 지출분석 귀속 필터가 새 이름을 따라가지 않음');
});
test('doRenameOwner: 이름변경 대상과 무관한 귀속을 보고 있었다면 필터를 건드리지 않는다', () => {
  sandbox.DB = { owners: ['나', '아빠'], assets: [] };
  sandbox.ST = { assetOwner: '나', plan: { owner: '전체' }, spendOwner: '전체' };
  const $orig = sandbox.$;
  sandbox.$ = (id) => (id === 'renameOwner' ? { value: '아버지' } : $orig(id));
  try {
    sandbox.doRenameOwner(1);
  } finally {
    sandbox.$ = $orig;
  }
  assert.strictEqual(sandbox.ST.assetOwner, '나');
  assert.strictEqual(sandbox.ST.plan.owner, '전체');
  assert.strictEqual(sandbox.ST.spendOwner, '전체');
});
/* ---------- doRenameOwner: 귀속 이름변경 시 ST.hist.owner(전체내역 탭 귀속 필터)가 낡은 이름으로 남던 버그 (app-evolve cycle140 develop) ----------
 * 위 ST.assetOwner/ST.plan.owner/ST.spendOwner와 똑같은 사연의 네 번째 자리인데, 이번엔 doRenameOwner 자체가
 * 챙기지 않고 있었다. ST.hist.owner는 지출분석 카테고리 드릴다운(openSpendAnalysis → histClear...이 아니라
 * 4092번째 줄 "ST.hist.owner=ST.spendOwner")에서 세팅돼 전체내역 탭의 활성 칩으로 남는데, 그 상태로 귀속
 * 이름을 바꾸면 ST.hist.owner만 옛 이름 그대로 남는다. filterTxnsByOwner(logic.js)는 owner 문자열을
 * DB.assets[].owner와 정확히 비교하므로, 자산들은 이미 새 이름으로 옮겨간 뒤라 옛 이름과는 아무것도 매칭되지
 * 않아 전체내역이 설명 없이 텅 비어 보인다. */
test('doRenameOwner: 이름변경 시 ST.hist.owner(전체내역 탭 귀속 필터)가 옛 이름을 가리키고 있었다면 새 이름으로 함께 옮겨간다', () => {
  sandbox.DB = { owners: ['나', '아빠'], assets: [{ owner: '아빠' }] };
  sandbox.ST = { assetOwner: '아빠', plan: { owner: '아빠' }, spendOwner: '아빠', hist: { owner: '아빠' } };
  const $orig = sandbox.$;
  sandbox.$ = (id) => (id === 'renameOwner' ? { value: '아버지' } : $orig(id));
  try {
    sandbox.doRenameOwner(1);
  } finally {
    sandbox.$ = $orig;
  }
  assert.strictEqual(sandbox.ST.hist.owner, '아버지', '전체내역 탭 귀속 필터가 새 이름을 따라가지 않음');
});
test('doRenameOwner: ST.hist가 다른 귀속을 보고 있었다면(또는 아예 없어도) 건드리지 않고 에러도 내지 않는다', () => {
  sandbox.DB = { owners: ['나', '아빠'], assets: [] };
  sandbox.ST = { assetOwner: '나', plan: { owner: '전체' }, spendOwner: '전체', hist: { owner: '전체' } };
  const $orig = sandbox.$;
  sandbox.$ = (id) => (id === 'renameOwner' ? { value: '아버지' } : $orig(id));
  try {
    sandbox.doRenameOwner(1);
  } finally {
    sandbox.$ = $orig;
  }
  assert.strictEqual(sandbox.ST.hist.owner, '전체');
  // ST.hist 자체가 없는 호출부(이 파일의 다른 doRenameOwner 테스트들)에서도 TypeError 없이 끝나야 함
  sandbox.ST = { assetOwner: '나', plan: { owner: '전체' }, spendOwner: '전체' };
  sandbox.$ = (id) => (id === 'renameOwner' ? { value: '아버지2' } : $orig(id));
  try {
    assert.doesNotThrow(() => sandbox.doRenameOwner(1));
  } finally {
    sandbox.$ = $orig;
  }
});
/* ---------- doRenameOwner: 귀속 이름변경 시 DB.nwHistory의 byOwner 스냅샷 키도 함께 옮기는지 (app-evolve cycle71 advance) ----------
 * nwHistoryCard(owner)가 DB.nwHistory[i].byOwner[owner] 키로 과거 추이를 조회하므로, 이름변경 후에도
 * 옛 이름 키만 남아 있으면 새 이름으로는 지금까지 쌓인 추이를 하나도 못 찾아 "곧 쌓여요" 안내만 계속 보게 된다. */
test('doRenameOwner: DB.nwHistory의 byOwner 키도 옛 이름에서 새 이름으로 옮겨간다', () => {
  sandbox.DB = {
    owners: ['나', '아빠'], assets: [{ owner: '아빠' }],
    nwHistory: [
      { date: '2026-01-01', ta: 300, td: 20, nw: 280, byOwner: { 나: { ta: 200, td: 10 }, 아빠: { ta: 100, td: 10 } } },
      { date: '2026-01-02', ta: 320, td: 20, nw: 300 }, // byOwner 없는 마이그레이션 이전 항목도 예외 없이 넘어가야 함
    ],
  };
  sandbox.ST = { assetOwner: '아빠', plan: { owner: '전체' } };
  const $orig = sandbox.$;
  sandbox.$ = (id) => (id === 'renameOwner' ? { value: '아버지' } : $orig(id));
  try {
    assert.doesNotThrow(() => sandbox.doRenameOwner(1));
  } finally {
    sandbox.$ = $orig;
  }
  assert.deepStrictEqual(sandbox.DB.nwHistory[0].byOwner, { 나: { ta: 200, td: 10 }, 아버지: { ta: 100, td: 10 } }, '옛 이름(아빠) 키가 새 이름(아버지)으로 이동해야 함');
  assert.strictEqual('아빠' in sandbox.DB.nwHistory[0].byOwner, false);
  assert.strictEqual(sandbox.DB.nwHistory[1].byOwner, undefined, 'byOwner가 없던 항목은 그대로 없어야 함');
});

/* ---------- addOwner/doRenameOwner: 대소문자·공백만 다른 근접 중복 귀속명 방지 (app-evolve cycle85 advance) ----------
 * addCat/doRenameCat과 동일한 이유로, 귀속명도 완전 일치만 보면 "나"와 "Na"가 아니라 "아빠"/"아 빠"처럼
 * 공백만 다른 이름이 별개 귀속으로 생겨 ownerAssets/ownerDebt 집계가 조용히 쪼개진다. */
test('addOwner: 대소문자만 다른 이름은 근접 중복으로 막고 기존 이름을 토스트에 보여준다', () => {
  sandbox.DB = { owners: ['Dad'] };
  sandbox.newOwnerValue = 'dad';
  sandbox.lastToast = null;
  sandbox.addOwner();
  assert.strictEqual(sandbox.lastToast, '비슷한 귀속이 있어요: Dad');
  assert.deepStrictEqual(sandbox.DB.owners, ['Dad'], '근접 중복이면 배열에 추가되면 안 됨');
});
test('addOwner: 완전히 같은 이름은 기존과 동일한 안내 문구를 띄운다', () => {
  sandbox.DB = { owners: ['나'] };
  sandbox.newOwnerValue = '나';
  sandbox.lastToast = null;
  sandbox.addOwner();
  assert.strictEqual(sandbox.lastToast, '이미 있는 귀속이에요');
});
test('addOwner: 실제로 다른 이름은 정상적으로 추가된다', () => {
  sandbox.DB = { owners: ['나'] };
  sandbox.newOwnerValue = '배우자';
  sandbox.lastToast = null;
  sandbox.addOwner();
  assert.strictEqual(sandbox.lastToast, null);
  assert.deepStrictEqual(sandbox.DB.owners, ['나', '배우자']);
});
test('doRenameOwner: 공백만 다른 이름으로 바꾸면 다른 귀속과 근접 중복으로 막는다', () => {
  sandbox.DB = { owners: ['용 돈', '배우자'], assets: [] };
  sandbox.ST = { assetOwner: '전체', plan: { owner: '전체' } };
  sandbox.renameOwnerValue = '용   돈';
  sandbox.lastToast = null;
  sandbox.doRenameOwner(1);
  assert.strictEqual(sandbox.DB.owners[1], '배우자', '근접 중복이면 이름이 바뀌면 안 됨');
  assert.strictEqual(sandbox.lastToast, '비슷한 귀속이 있어요: 용 돈');
});
test('doRenameOwner: 자기 자신의 대소문자만 바꾸는 변경은 근접 중복으로 막지 않는다', () => {
  sandbox.DB = { owners: ['Dad'], assets: [] };
  sandbox.ST = { assetOwner: '전체', plan: { owner: '전체' } };
  sandbox.renameOwnerValue = 'dad';
  sandbox.doRenameOwner(0);
  assert.strictEqual(sandbox.DB.owners[0], 'dad', '자기 자신과의 대소문자 변경은 허용돼야 함');
});

/* ---------- doRenameOwner: 귀속 이름이 바뀐 자산에도 touch()로 updatedAt이 갱신돼야 함 (app-evolve cycle92 develop) ----------
 * saveAsset/askRelinkDeleted처럼 DB.assets 항목을 고치는 모든 경로는 touch()로 updatedAt을 갱신해야
 * mergeCollection()의 3-way 병합(위 mergeCollection 테스트 참고: updatedAt이 더 큰 쪽이 이김)이 이
 * 변경을 "최신"으로 인식한다. doRenameOwner()는 DB.owners[i]와 a.owner만 바꾸고 touch(a)를 부르지
 * 않아, 클라우드 동기화 전에 다른 기기가 그 자산을 건드리지 않았더라도(즉 자산의 updatedAt이 그대로
 * 옛 값) 병합 시 그 오래된 updatedAt만으로 비교돼 이름변경이 실제로 반영됐는지와 무관하게 원격의
 * 더 최근 사본에 조용히 덮여 사라질 수 있었다(예: 원격에서 같은 자산을 다른 필드만 더 나중에 고친
 * 경우). 이름이 바뀐 자산에는 touch()가 호출되어야 하고, 무관한(다른 귀속) 자산은 건드리지 않아야
 * 한다. */
test('doRenameOwner: 귀속 이름이 바뀐 자산에는 touch()가 호출돼 updatedAt이 갱신된다', () => {
  sandbox.DB = {
    owners: ['나', '아빠'],
    assets: [
      { id: 'a1', owner: '아빠', updatedAt: 111 },
      { id: 'a2', owner: '나', updatedAt: 222 }, // 무관한 귀속 — 건드리면 안 됨
    ],
  };
  sandbox.ST = { assetOwner: '전체', plan: { owner: '전체' } };
  sandbox.renameOwnerValue = '아버지';
  sandbox.doRenameOwner(1);
  assert.strictEqual(sandbox.DB.assets[0].owner, '아버지');
  assert.strictEqual(sandbox.DB.assets[0].updatedAt, 'test-updatedAt', '이름이 바뀐 자산에는 touch()가 호출되어야 함');
  assert.strictEqual(sandbox.DB.assets[1].owner, '나');
  assert.strictEqual(sandbox.DB.assets[1].updatedAt, 222, '무관한 자산의 updatedAt은 그대로여야 함');
});

test('renderMenu: 메뉴 탭 계정 진입점(acct-card)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('renderMenu');
  assert.ok(/class="card acct-card"[^>]*role="button"/.test(body), 'acct-card에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>openAccountSheet())"'), 'acct-card에 rowKeydown 연결이 없음');
});
test('renderMenu: 결제 연동 없이 toast만 띄우던 "Pro로 업그레이드" 프로모 카드가 제거됐다', () => {
  const body = extractFunction('renderMenu');
  assert.ok(!body.includes('class="promo"'), 'Pro 업그레이드 프로모 카드(.promo)가 아직 남아있음');
  assert.ok(!body.includes("toast('Pro 안내')"), "동작 없는 toast('Pro 안내') 더미 핸들러가 아직 남아있음");
  assert.ok(!body.includes('Pro로 업그레이드'), '"Pro로 업그레이드" 문구가 아직 남아있음');
});
test('openSpendAnalysis: 지출 분석 카테고리 행(spend-row)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('openSpendAnalysis');
  assert.ok(/class="spend-row"[^>]*role="button"/.test(body), 'spend-row에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>openBudgetPrompt('), 'spend-row에 rowKeydown 연결이 없음');
});
/* 지출분석 귀속 필터 세그먼트도 class="on"만으로 선택 상태를 표시해 스크린리더가 어떤 귀속이
 * 선택돼 있는지 알 수 없던 공백 — app-evolve cycle147 critique/advance. */
test('openSpendAnalysis: 귀속 필터 세그먼트 버튼에 aria-pressed, 래퍼에 role/aria-label이 있다', () => {
  const body = extractFunction('openSpendAnalysis');
  assert.ok(
    /\['전체',\.\.\.DB\.owners\]\.map\(\(o,oi\)=>`<button class="\$\{ST\.spendOwner===o\?'on':''\}" aria-pressed="\$\{ST\.spendOwner===o\}" onclick="spendOwnerSel/.test(body),
    '귀속 필터 세그먼트 버튼에 aria-pressed가 없음'
  );
  assert.ok(/<div class="seg" role="group" aria-label="귀속 선택">/.test(body), '귀속 필터 세그먼트 래퍼에 role="group"/aria-label이 없음');
});
test('monthOutflowCard: 홈 탭 이번 달 나갈 돈 행(of-row)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('monthOutflowCard');
  assert.ok(/class="of-row"[^>]*role="button"/.test(body), 'of-row에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>goLedgerTo('), 'of-row에 rowKeydown 연결이 없음');
});
/* ---------- nextOutflowCard: 카드 전체가 <button>인데 그 안의 "해결 방법 보기"(nc-fix)가 onclick div였던 버그
 * (app-evolve cycle160 develop) ----------
 * 잔액부족(short>0)일 때만 나타나는 nc-fix는 마우스로는 stopPropagation()으로 바깥 <button>의 goPlanTo와
 * 분리돼 동작했지만, 자체 role/tabindex가 없는 div라 Tab으로는 아예 도달할 수 없었다 — 이 카드에서
 * 가장 중요한 바로가기(해결 방법 보기)가 키보드/스위치 접근 사용자에게만 막혀 있던 셈. 바깥을
 * spend-row/of-row와 동일한 role="button" div로, nc-fix는 실제 <button>으로 뒤집어 두 액션 모두
 * 키보드로 닿게 했다. */
test('nextOutflowCard: 카드(next-card)와 해결 방법 보기(nc-fix)가 각각 키보드로 접근 가능하다', () => {
  const body = extractFunction('nextOutflowCard');
  assert.ok(/<div class="next-card \$\{short\?'warn':''\}" role="button" tabindex="0"/.test(body), 'next-card에 role="button"/tabindex가 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>goPlanTo('), 'next-card에 rowKeydown 연결이 없음');
  assert.ok(/<button type="button" class="nc-fix"/.test(body), 'nc-fix가 실제 <button>이 아님(예전 onclick div는 Tab으로 닿을 수 없었음)');
  assert.ok(!/<div class="nc-fix"/.test(body), 'nc-fix가 여전히 onclick div로 남아있음');
});
/* ---------- nextOutflowCard: nc-fix에 포커스된 채 Enter/Space를 누르면 keydown이 바깥
 * role="button" div로 버블돼 rowKeydown이 preventDefault()를 호출, 네이티브 버튼 클릭 활성화
 * (openFixShortfall)를 막고 goPlanTo가 대신 실행되던 버그 (app-evolve cycle160 review) ----------
 * cycle160 develop이 nc-fix를 실제 <button>으로 바꿔 Tab 도달은 고쳤지만, 버블링을 막지 않아
 * 키보드로 활성화하면 엉뚱한 동작(goPlanTo)이 실행되는 새 문제를 만들었다. nc-fix의 keydown에도
 * stopPropagation을 걸어 버블을 끊었다 — 이 핸들러는 preventDefault를 호출하지 않으므로 네이티브
 * Enter/Space 클릭 활성화(및 그 onclick의 openFixShortfall)는 그대로 유지된다. */
test('nextOutflowCard: nc-fix의 keydown이 바깥 next-card로 버블되지 않는다(goPlanTo 오발동 방지)', () => {
  const body = extractFunction('nextOutflowCard');
  assert.ok(/<button type="button" class="nc-fix"[^>]*onkeydown="event\.stopPropagation\(\)"/.test(body), 'nc-fix에 onkeydown="event.stopPropagation()"이 없음 — Enter/Space가 바깥 div로 버블돼 goPlanTo가 대신 실행됨');
});
test('homeAlertCard: 백업 알림 행(ha-b)에 키보드/스크린리더 접근 패턴이 있다', () => {
  const body = extractFunction('homeAlertCard');
  assert.ok(/class="ha-b"\s+tabindex="0"\s+role="button"[^>]*onclick="exportData\(\)"/.test(body), '백업 ha-b에 role="button"이 없음');
  assert.ok(body.includes('onkeydown="rowKeydown(event,()=>exportData())"'), '백업 ha-b에 rowKeydown 연결이 없음');
});
/* ---------- renderAssetSheet: app-evolve cycle146 critique가 짚은 "src.includes 거짓 안전감"을
 * 메우는 첫 실행형 전환(cycle153 critique 계획) — 바로 아래 5개 테스트는 과거 extractFunction()
 * 소스 문자열 regex/includes 매칭이었다(실행 시에만 드러나는 버그를 못 잡음). renderAssetSheet를
 * FUNCTIONS에 끌어와 sandbox.renderAssetSheet(editing)을 실제로 실행하고, 기존처럼 openSheet()
 * 스텁(sandbox.lastSheetHtml)이 받은 실제 렌더 결과에 대해 같은 assert를 건다 — 검증 내용은
 * 그대로 유지하되 "그 문자열이 파일 어딘가에 있는가"가 아니라 "이 draft로 실제로 그 HTML이
 * 나오는가"를 확인한다. openTxSheet/openRecSheet/renderMenu/openSheet 자체는 DOM 전역
 * (classList/requestAnimationFrame 등)에 더 깊이 엮여 있어 여전히 백로그(아래 8558줄 부근 주석). */
function renderAsset(draft) {
  // savings 타입은 "만기 시 이체할 통장" 필드에서 assetPickBtn(maturityTargetId)을 부르는데,
  // assetPickBtn은 DB.assets.find(...)를 바로 쓰므로 DB.assets가 항상 배열로 있어야 한다
  // (이전 테스트가 남긴 leftover DB를 그대로 쓰면 .assets가 없어 크래시한다).
  sandbox.DB = { assets: [], rates: { fx: { USD: 1300 }, stocks: {}, goldPerG: 100000 } };
  sandbox.asDraft = draft;
  sandbox.lastSheetHtml = null;
  sandbox.renderAssetSheet(!!draft.id);
  return sandbox.lastSheetHtml;
}
test('renderAssetSheet: cash/debt/realestate/etc/pension의 asAmt에 Enter-제출이 있고, savings는 제외된다(만기일 입력이 이어지므로)', () => {
  ['cash', 'debt', 'realestate', 'etc', 'pension'].forEach(ty => {
    const html = renderAsset({ type: ty, owner: '나', includeInTotal: true, name: '' });
    assert.ok(
      html.includes(`onkeydown="if(event.key==='Enter'&&!event.isComposing)saveAsset(false)"`),
      `${ty} 타입의 asAmt에 Enter-제출이 없음`
    );
  });
  const savingsHtml = renderAsset({ type: 'savings', owner: '나', includeInTotal: true, name: '' });
  assert.ok(
    !savingsHtml.includes(`onkeydown="if(event.key==='Enter'&&!event.isComposing)saveAsset(false)"`),
    'savings는 만기일 입력이 이어지므로 asAmt에 Enter-제출이 없어야 함'
  );
});
/* ---------- renderAssetSheet: fx/gold/stock의 보유 수량 입력(asFx/asGold/asQty)도 다른 금액/이름
 * 입력란(asAmt/asCostBasis/asName 등)과 같은 field-clear(×) 버튼 관례를 따라야 한다. 이 세 입력만
 * .with-unit(단위 표시용 flex 래퍼)으로 감싸져 있어 field-clear가 없었다(app-evolve cycle147 develop
 * — budgetIn/qAmt/bigMinInput을 통일한 cycle146이 "금액" 입력만 다루고 "수량" 입력은 남겨둔 공백). */
test('renderAssetSheet: fx 타입의 asFx(보유 수량)도 다른 입력란과 동일하게 field-clear(×) 버튼이 있다', () => {
  const html = renderAsset({ type: 'fx', owner: '나', includeInTotal: true, name: '', currency: 'USD', fxAmount: 100 });
  assert.ok(html.includes('<div class="with-unit"><div class="field-clear"><input id="asFx"'), 'asFx 입력이 with-unit 안에서 field-clear로 감싸져 있지 않음');
  assert.ok(html.includes(`<button type="button" class="fc-x" aria-label="보유 수량 지우기" onclick="clrInput('asFx')">`), 'asFx에 fc-x 지우기 버튼의 clrInput 연결이 없음');
  assert.ok(html.includes('id="asCostBasis"'), 'fx 타입에는 매입 원가(costBasisField) 입력이 있어야 함');
});
test('renderAssetSheet: gold 타입의 asGold(보유 수량)도 동일하게 field-clear(×) 버튼이 있다', () => {
  const html = renderAsset({ type: 'gold', owner: '나', includeInTotal: true, name: '', goldDon: 5 });
  assert.ok(html.includes('<div class="with-unit"><div class="field-clear"><input id="asGold"'), 'asGold 입력이 with-unit 안에서 field-clear로 감싸져 있지 않음');
  assert.ok(html.includes(`<button type="button" class="fc-x" aria-label="보유 수량 지우기" onclick="clrInput('asGold')">`), 'asGold에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('renderAssetSheet: stock 타입의 asQty(보유 주식 수)도 동일하게 field-clear(×) 버튼이 있다', () => {
  const html = renderAsset({ type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 10 });
  assert.ok(html.includes('<div class="with-unit"><div class="field-clear"><input id="asQty"'), 'asQty 입력이 with-unit 안에서 field-clear로 감싸져 있지 않음');
  assert.ok(html.includes(`<button type="button" class="fc-x" aria-label="보유 주식 수 지우기" onclick="clrInput('asQty')">`), 'asQty에 fc-x 지우기 버튼의 clrInput 연결이 없음');
  assert.ok(!html.includes('id="asAmt"'), 'stock 타입은 cash류의 asAmt 필드를 보여주면 안 됨');
});
/* renderAssetSheet: stock 타입의 asCode(종목코드)는 같은 폼의 asName/asQty 사이에 끼어 있으면서도
 * field-clear가 빠져 있었다(app-evolve cycle149 develop — asFx/asGold/asQty를 통일한 cycle147이
 * "수량" 입력만 다루고, 같은 줄에 있는 종목코드 텍스트 입력은 남겨둔 공백). autocapitalize/대문자
 * 변환 oninput은 유지하면서 다른 텍스트 입력과 동일한 .field-clear+fc-x 구조로 감쌌다. */
test('renderAssetSheet: stock 타입의 asCode(종목코드)도 asName/asQty와 동일하게 field-clear(×) 버튼이 있다', () => {
  const html = renderAsset({ type: 'stock', owner: '나', includeInTotal: true, name: '삼성전자', stockCode: '005930', stockQty: 10 });
  assert.ok(html.includes('<div class="field-clear"><input id="asCode"'), 'asCode 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(html.includes(`<button type="button" class="fc-x" aria-label="종목코드 지우기" onclick="clrInput('asCode')">`), 'asCode에 fc-x 지우기 버튼의 clrInput 연결이 없음');
  assert.ok(html.includes(`oninput="this.value=this.value.toUpperCase()"`), 'asCode의 대문자 변환 oninput이 유지되지 않음');
});
test('renderAssetSheet: savings 타입은 만기일 필드를 보여주고, cash 타입은 만기일 필드가 없다', () => {
  const savingsHtml = renderAsset({ type: 'savings', owner: '나', includeInTotal: true, name: '', baseAmount: 0 });
  assert.ok(savingsHtml.includes('id="asMat"'), 'savings 타입에는 만기일 필드(asMat)가 있어야 함');
  const cashHtml = renderAsset({ type: 'cash', owner: '나', includeInTotal: true, name: '', baseAmount: 0 });
  assert.ok(!cashHtml.includes('id="asMat"'), 'cash 타입에는 만기일 필드가 없어야 함');
  assert.ok(!cashHtml.includes('id="asCostBasis"'), 'cash 타입에는 매입 원가 필드가 없어야 함(fx/gold/stock 전용)');
});
/* openOwnerManage/renameOwnerSheet/renameCatSheet는 FUNCTIONS(실제 실행) 목록 밖이라
 * renderAssetSheet의 asFx/asGold/asQty 검증과 같은 extractFunction() 소스 패턴 검증을 쓴다
 * (app-evolve cycle148 develop — newCat은 openCatManage가 FUNCTIONS에 있어 실제 실행으로 검증). */
test('openOwnerManage: newOwner(귀속 추가 입력)도 다른 이름 입력란과 동일하게 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('openOwnerManage');
  assert.ok(body.includes('<div class="add-inline"><div class="field-clear"><input id="newOwner"'), 'newOwner 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="귀속 이름 지우기" onclick="clrInput('newOwner')">`), 'newOwner에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('renameOwnerSheet: renameOwner(귀속 이름 수정 입력)도 동일하게 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('renameOwnerSheet');
  assert.ok(body.includes('<div class="field"><div class="field-clear"><input id="renameOwner"'), 'renameOwner 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="이름 지우기" onclick="clrInput('renameOwner')">`), 'renameOwner에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('renameOwnerSheet: renameOwner 입력에 aria-label이 있다(앱 전체에서 유일하게 label도 placeholder도 없던 입력이었음)', () => {
  const body = extractFunction('renameOwnerSheet');
  assert.ok(body.includes('<input id="renameOwner" aria-label="귀속 이름"'), 'renameOwner에 aria-label="귀속 이름"이 없음');
});
test('renameCatSheet: renameCat(카테고리 이름 수정 입력)도 동일하게 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('renameCatSheet');
  assert.ok(body.includes('<div class="cat-edit-row">') && body.includes('<div class="field-clear"><input id="renameCat"'), 'renameCat 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="카테고리 이름 지우기" onclick="clrInput('renameCat')">`), 'renameCat에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test("costBasisField: fx/gold/stock 공용 매입금액 입력(asCostBasis)에 Enter-제출이 있다(세 타입 모두의 마지막 입력)", () => {
  assert.strictEqual(
    sandbox.costBasisField({ costBasis: 0 }, false),
    '<div class="field"><label for="asCostBasis">매입 금액 (원, 선택)</label><div class="field-clear"><input id="asCostBasis" class="num" inputmode="numeric" value="" placeholder="입력 시 손익을 계산해요" oninput="fmtAmt(this,false)" onkeydown="if(event.key===\'Enter\'&&!event.isComposing)saveAsset(false)"><button type="button" class="fc-x" aria-label="매입 금액 지우기" onclick="clrInput(\'asCostBasis\')">✕</button></div></div>'
  );
  assert.ok(sandbox.costBasisField({ costBasis: 0 }, true).includes('saveAsset(true)'), 'editing=true(수정 모드)일 때 saveAsset 호출에 전달되지 않음');
});
test('renderTxSheet: 반복이 꺼져 있으면(일반 입력/수정) txMemo가 마지막 필드라 Enter-제출이 있고, 반복이 켜져 있으면(주기/종료조건 필드가 뒤따름) 제외된다', () => {
  const body = extractFunction('renderTxSheet');
  assert.ok(
    /rpt\?'':`\s*onkeydown="if\(event\.key==='Enter'&&!event\.isComposing\)saveTx\(\)"`/.test(body),
    'txMemo의 Enter-제출이 rpt(반복 켜짐)를 제외하고 나머지에만 적용되지 않음'
  );
});
test('renderTxSheet: 반복 개별/범위 수정 시트(rc 분기)의 txAmt(금액)에 Enter-제출이 있다(recSave()가 요구하는 유일한 입력이고, 삭제/저장하기 버튼뿐 뒤따르는 필드가 없음, app-evolve cycle145 develop)', () => {
  const body = extractFunction('renderTxSheet');
  assert.ok(
    body.includes(`id="txAmt" class="amount-in num" inputmode="numeric" value="${'${d.amount?comma(d.amount):\'\'}'}" placeholder="0" oninput="fmtAmt(this)" onkeydown="if(event.key==='Enter'&&!event.isComposing)recSave()"`),
    'rc 분기의 txAmt에 Enter→recSave() 연결이 없음'
  );
});
test('renderRecSheet: rAmt(금액)에 Enter-제출이 있다(saveRec()가 요구하는 유일한 필수 입력이고, 나머지 필드는 모두 기본값이 있음)', () => {
  const body = extractFunction('renderRecSheet');
  assert.ok(
    body.includes(`id="rAmt" class="num" inputmode="numeric" value="${'${d.amount?comma(d.amount):\'\'}'}" placeholder="0" oninput="fmtAmt(this)" onkeydown="if(event.key==='Enter'&&!event.isComposing)saveRec()"`),
    'rAmt에 Enter→saveRec() 연결이 없음'
  );
});
/* renderRecSheet는 renderTxSheet와 달리 vm 실행 스모크 테스트 fixture가 없어(DB.settings 등
 * 의존이 더 많음) extractFunction 소스 패턴으로 구분 세그먼트의 aria-pressed/role을 확인한다
 * (app-evolve cycle147 critique/advance, 세그먼트 컨트롤 9곳에 aria-pressed 추가). */
test('renderRecSheet: 구분 세그먼트 버튼에 aria-pressed, 래퍼에 role/aria-label이 있다', () => {
  const body = extractFunction('renderRecSheet');
  assert.ok(
    /typeSeg=\[.*\]\.map\(\(\[v,l\]\)=>`<button class="\$\{d\.type===v\?'on':''\}" aria-pressed="\$\{d\.type===v\}" onclick="recType/.test(body),
    'renderRecSheet의 구분 세그먼트 버튼에 aria-pressed가 없음'
  );
  assert.ok(/<div class="seg" role="group" aria-label="구분 선택">/.test(body), '구분 세그먼트 래퍼에 role="group"/aria-label이 없음');
});
test('renderGoalForm: goalAmt(목표 금액)에 Enter-제출이 있다(saveGoal()의 유일한 필수 수치 입력이고, 목표일은 선택 항목이라 그 뒤에 이어지지 않음)', () => {
  const body = extractFunction('renderGoalForm');
  assert.ok(
    body.includes(`id="goalAmt" class="num" inputmode="numeric" value="${'${d.targetAmount?comma(d.targetAmount):\'\'}'}" placeholder="0" oninput="fmtAmt(this)" onkeydown="if(event.key==='Enter'&&!event.isComposing)saveGoal(${'${editing}'})"`),
    'goalAmt에 Enter→saveGoal() 연결이 없음'
  );
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

/* ---------- APPLOCK(기기 단위 앱 잠금 PIN, app-evolve cycle148 advance): genSalt/pbkdf2Hash로
 * PIN을 해싱하고 AUTH._lockStatus/_recordFail/_clearFails의 지수 백오프를 그대로 재사용한다.
 * 위 pbkdf2Hash 테스트들과 달리 setPin()→verify()의 실제 localStorage 읽기/쓰기 왕복과,
 * 로그인 실패 카운터(AUTH._fails)를 'applock' 키로 공유하면서도 잠그고 풀리는 흐름 자체를
 * 끝까지 실행해 검증해야 하므로, sandbox.localStorage(단일 _lsRaw 스텁)가 아니라 실제
 * get/set이 맞물리는 Map 기반 목업을 둔 별도 vm 컨텍스트에 AUTH+APPLOCK+genSalt+pbkdf2Hash를
 * 함께 태운다(nwChartPeekKey 완전 실행형 파일럿과 같은 패턴). */
function makeAppLockCtx() {
  const store = new Map();
  const ctx = {
    crypto, TextEncoder,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    [extractFunction('genSalt'), extractFunction('pbkdf2Hash'), extractConst('APPLOCK_KEY'), extractConst('APPLOCK_FAIL_KEY'), extractConstBlock('AUTH'), extractConstBlock('APPLOCK')].join('\n'),
    ctx
  );
  return ctx;
}
test('APPLOCK: 초기 상태(미설정)에서는 enabled()가 false, verify()는 PIN 없이도 통과한다', async () => {
  const ctx = makeAppLockCtx();
  assert.strictEqual(ctx.APPLOCK.enabled(), false);
  const r = await ctx.APPLOCK.verify('아무거나');
  assert.strictEqual(r.ok, true, 'PIN이 설정 안 됐으면 잠금 자체가 없으므로 통과해야 함');
});
test('APPLOCK: setPin()으로 저장한 PIN은 verify()로 그대로 검증된다(salt가 매번 달라도 왕복 성공)', async () => {
  const ctx = makeAppLockCtx();
  await ctx.APPLOCK.setPin('1234');
  assert.strictEqual(ctx.APPLOCK.enabled(), true);
  const ok = await ctx.APPLOCK.verify('1234');
  assert.strictEqual(ok.ok, true);
  const bad = await ctx.APPLOCK.verify('9999');
  assert.ok(bad.err, '틀린 PIN은 err를 돌려줘야 함');
});
test('APPLOCK: 5회 연속 틀리면 AUTH._lockStatus의 지수 백오프로 잠긴다(재사용 확인)', async () => {
  const ctx = makeAppLockCtx();
  await ctx.APPLOCK.setPin('1234');
  for (let i = 0; i < 5; i++) {
    const r = await ctx.APPLOCK.verify('0000');
    assert.ok(r.err, `${i + 1}번째 오답은 잠기기 전이므로 PIN 불일치 에러여야 함`);
  }
  const locked = await ctx.APPLOCK.verify('1234'); // 맞는 PIN이라도 잠긴 동안은 막혀야 함
  assert.ok(locked.err, '5회 실패 후에는 맞는 PIN을 넣어도 잠금 대기가 먼저 막아야 함');
  assert.match(locked.err, /너무 많이/, '잠금 중엔 AUTH._lockStatus의 대기 안내 문구가 나와야 함');
});
test('APPLOCK: disable()은 설정을 지우고 실패 카운터도 함께 초기화한다', async () => {
  const ctx = makeAppLockCtx();
  await ctx.APPLOCK.setPin('1234');
  await ctx.APPLOCK.verify('0000'); // 실패 카운터 1 적립
  ctx.APPLOCK.disable();
  assert.strictEqual(ctx.APPLOCK.enabled(), false);
  const r = await ctx.APPLOCK.verify('1234'); // PIN 자체가 없으니 뭘 넣어도 통과
  assert.strictEqual(r.ok, true);
});
test("APPLOCK: 'applock' 실패 카운터는 AUTH 로그인 실패 카운터와 같은 localStorage 키를 공유하지만 다른 object key로 구분된다", async () => {
  const ctx = makeAppLockCtx();
  await ctx.APPLOCK.setPin('1234');
  await ctx.APPLOCK.verify('0000');
  const raw = JSON.parse(ctx.localStorage.getItem('asset_app_login_fails'));
  assert.ok(raw.applock, "실패 카운터가 'asset_app_login_fails'의 'applock' 키에 적립돼야 함(AUTH._recordFail 재사용 증거)");
  assert.strictEqual(raw.applock.count, 1);
});

/* ---------- 재잠금 유예시간(graceSec, app-evolve cycle151 advance) — 그레이스는 lockApp()을
 * 미루는 게 아니라(그러면 백그라운드 전환 중 OS 앱 전환화면에 데이터가 그대로 노출됨), 화면은
 * 즉시 가리고(lockApp) 유예시간 안에 돌아왔을 때만 PIN 재입력 없이 조용히 풀어주는 쪽으로
 * 설계했다 — 그 설계를 보장하는 건 visibilitychange 핸들러이므로, 여기 APPLOCK 단위 테스트는
 * getGrace/setGrace 저장 왕복과 setPin()이 그레이스 값을 보존하는지만 검증한다(핸들러 자체의
 * '즉시 가리고 유예시간 안엔 자동 해제' 로직은 lockApp/unlockApp/document 의존이라 이 vm
 * 컨텍스트 밖이라 못 실행형으로 태운다; 아래 index.html 구문 검사는 그 핸들러가 getGrace()를
 * 쓰는 모양까지 정적으로 확인한다). ---------- */
test('APPLOCK: getGrace()의 기본값은 0(즉시 재잠금)이다 — PIN 미설정 상태에서도, 설정 직후에도', async () => {
  const ctx = makeAppLockCtx();
  assert.strictEqual(ctx.APPLOCK.getGrace(), 0, 'PIN 미설정 상태의 기본값');
  await ctx.APPLOCK.setPin('1234');
  assert.strictEqual(ctx.APPLOCK.getGrace(), 0, 'setPin() 직후(첫 설정)에도 기존 기본 동작과 같아야 함');
});
test('APPLOCK: setGrace()로 저장한 유예시간은 getGrace()로 그대로 왕복된다', async () => {
  const ctx = makeAppLockCtx();
  await ctx.APPLOCK.setPin('1234');
  ctx.APPLOCK.setGrace(60);
  assert.strictEqual(ctx.APPLOCK.getGrace(), 60);
});
test('APPLOCK: setPin()(PIN 변경 포함)으로 기존에 설정해 둔 유예시간이 조용히 초기화되지 않는다', async () => {
  const ctx = makeAppLockCtx();
  await ctx.APPLOCK.setPin('1234');
  ctx.APPLOCK.setGrace(300);
  await ctx.APPLOCK.setPin('5678'); // doChangePin()이 부르는 것과 같은 경로
  assert.strictEqual(ctx.APPLOCK.getGrace(), 300, 'PIN을 바꿔도 유예시간 설정은 그대로 유지돼야 함');
  const ok = await ctx.APPLOCK.verify('5678');
  assert.strictEqual(ok.ok, true, '바뀐 PIN으로 정상 검증되는지도 함께 확인');
});
test('APPLOCK: disable()은 유예시간 설정도 함께 지운다(재설정 시 기본값 0으로 돌아옴)', async () => {
  const ctx = makeAppLockCtx();
  await ctx.APPLOCK.setPin('1234');
  ctx.APPLOCK.setGrace(60);
  ctx.APPLOCK.disable();
  await ctx.APPLOCK.setPin('1234'); // 다시 켬(toggleAppLock() 끈 뒤 다시 켜는 것과 같은 경로)
  assert.strictEqual(ctx.APPLOCK.getGrace(), 0, '꺼졌다가 다시 켜지면 그레이스는 보안 기본값(즉시)으로 리셋돼야 함');
});
test('APPLOCK: setGrace()는 PIN이 설정돼 있지 않으면(저장된 게 없으면) 조용히 무시한다', () => {
  const ctx = makeAppLockCtx();
  ctx.APPLOCK.setGrace(60); // PIN 설정 전 — 쓸 저장소가 없음
  assert.strictEqual(ctx.APPLOCK.enabled(), false, '없는 설정을 만들어 enabled()를 true로 바꿔버리면 안 됨');
  assert.strictEqual(ctx.APPLOCK.getGrace(), 0);
});
test('index.html 소스: visibilitychange 핸들러가 hidden 분기에서 lockApp()을 즉시 부르고, visible 분기에서만 APPLOCK.getGrace()로 유예시간을 비교한다', () => {
  const full = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = full.indexOf("document.addEventListener('visibilitychange'");
  assert.notStrictEqual(start, -1, 'visibilitychange 리스너를 못 찾음');
  const end = full.indexOf('});', start) + 3;
  const handler = full.slice(start, end);
  assert.match(handler, /if\(appIsOpen\(\)\)\{APP_HIDDEN_AT=Date\.now\(\);lockApp\(\)\}/, 'hidden으로 전환되면 그레이스 판단 없이 즉시 lockApp()을 불러 화면을 가려야 함');
  assert.match(handler, /APPLOCK\.getGrace\(\)/, '돌아올 때 getGrace()로 유예시간을 비교해야 함');
  assert.match(handler, /unlockApp\(\)/, '유예시간 안이면 unlockApp()으로 PIN 재입력 없이 풀어야 함');
});

/* ---------- PIN을 잊었을 때의 탈출구(app-evolve cycle151 develop) — APPLOCK에는 복구 코드
 * 개념이 없어서, 이게 없으면 verify() 성공 없이는 영원히 #lockView에 막혀 앱 잠금을 풀기
 * 위해 사이트 데이터 전체를 지워야 했다(이 기기에만 있는 자산 내역 전체가 함께 사라짐).
 * cycle155 advance부터는 email 계정은 계정 비밀번호 검증(AUTH.signIn 재사용)을 통과해야만 풀리고,
 * 비밀번호가 없는 guest/kakao 계정은 짧은 강제 대기 뒤에만 풀린다 — 질문 없이 확인 한 번으로
 * App-Lock 자체가 무력화되던 문제의 수정. ---------- */
test('renderLockView: PIN 잠금 화면에 계정 비밀번호 찾기(auth-forgot)와 같은 스타일의 "PIN을 잊으셨나요?" 링크가 openForgotPinSheet로 연결돼 있다', () => {
  const $orig = sandbox.$;
  const authOrig = sandbox.AUTH;
  const lockViewEl = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
  sandbox.$ = (id) => (id === 'lockView' ? lockViewEl : $orig(id));
  sandbox.AUTH = { _lockStatus: () => ({ locked: false, waitSec: 0 }) };
  try {
    sandbox.renderLockView();
    assert.ok(
      lockViewEl.innerHTML.includes('<button type="button" class="auth-forgot" onclick="openForgotPinSheet()">PIN을 잊으셨나요?</button>'),
      '잠금 화면에 PIN 찾기 링크(auth-forgot 스타일)가 없음'
    );
  } finally {
    sandbox.$ = $orig;
    sandbox.AUTH = authOrig;
  }
});
test('openForgotPinSheet: guest/kakao(비밀번호 없는) 계정은 경고 문구와 함께 확인 버튼이 처음엔 비활성이다(강제 대기)', () => {
  assert.strictEqual(sandbox.SESSION, null, '이 테스트는 기본(guest) 세션 상태를 가정함');
  sandbox.lastSheetHtml = null;
  sandbox.openForgotPinSheet();
  assert.ok(sandbox.lastSheetHtml.includes('본인 확인을 할 수 없어요'), '비밀번호 없는 계정 경고 문구가 없음');
  assert.ok(sandbox.lastSheetHtml.includes('저장된 자산 데이터는 그대로 남아요'), '데이터는 안전하다는 안내가 없음');
  assert.ok(sandbox.lastSheetHtml.includes('id="fpinBtn" disabled onclick="doForgotPin()"'), '대기 중엔 확인 버튼이 비활성이어야 함');
  assert.ok(sandbox.lastSheetHtml.includes('onclick="closeSheet()"'), '취소 버튼이 없음');
});
test('openForgotPinSheet: email 계정은 비밀번호 확인이 필요하다는 안내와 함께 비밀번호 입력칸(즉시 활성화된 확인 버튼)을 띄운다', () => {
  const sessionOrig = sandbox.SESSION, authOrig = sandbox.AUTH;
  sandbox.SESSION = 'user@example.com';
  sandbox.AUTH = { rec: () => null };
  try {
    sandbox.lastSheetHtml = null;
    sandbox.openForgotPinSheet();
    assert.ok(sandbox.lastSheetHtml.includes('id="fpinPwIn"'), '계정 비밀번호 입력칸이 없음');
    assert.ok(sandbox.lastSheetHtml.includes("togglePwVis('fpinPwIn')"), '비밀번호 표시 토글이 연결돼 있지 않음');
    assert.ok(sandbox.lastSheetHtml.includes('저장된 자산 데이터는 그대로 남아요'), '데이터는 안전하다는 안내가 없음');
    assert.ok(sandbox.lastSheetHtml.includes('id="fpinBtn" onclick="doForgotPin()"'), 'email 계정은 대기 없이 바로 확인 버튼이 활성이어야 함(비밀번호 검증이 대신 막음)');
    assert.ok(sandbox.lastSheetHtml.includes('onclick="closeSheet()"'), '취소 버튼이 없음');
  } finally {
    sandbox.SESSION = sessionOrig;
    sandbox.AUTH = authOrig;
  }
});
test('doForgotPin: guest/kakao(비밀번호 없는) 계정은 PIN을 묻지 않고 APPLOCK만 초기화해 잠금을 풀고, 시트를 닫고 토스트로 알린다(자산 데이터 자체는 건드리지 않음)', () => {
  assert.strictEqual(sandbox.SESSION, null, '이 테스트는 기본(guest) 세션 상태를 가정함');
  sandbox.appLockDisableCalls = 0;
  sandbox.unlockAppCalls = 0;
  sandbox.closeSheetCalls = 0;
  sandbox.lastToast = null;
  sandbox.doForgotPin();
  assert.strictEqual(sandbox.appLockDisableCalls, 1, 'APPLOCK.disable()이 호출돼야 함');
  assert.strictEqual(sandbox.unlockAppCalls, 1, 'unlockApp()으로 화면이 풀려야 함');
  assert.strictEqual(sandbox.closeSheetCalls, 1);
  assert.ok(/초기화/.test(sandbox.lastToast));
});
test('doForgotPin: email 계정은 계정 비밀번호(AUTH.signIn)가 맞아야만 APPLOCK을 초기화한다', async () => {
  const sessionOrig = sandbox.SESSION, authOrig = sandbox.AUTH;
  sandbox.SESSION = 'user@example.com';
  let signInArgs = null;
  sandbox.AUTH = { rec: () => null, signIn: async (email, pw) => { signInArgs = [email, pw]; return { ok: true, email: 'user@example.com' }; } };
  sandbox.fpinPwInValue = 'correct-pw';
  sandbox.fpinErrEl.style.display = 'block'; sandbox.fpinErrEl.textContent = 'stale';
  sandbox.appLockDisableCalls = 0; sandbox.unlockAppCalls = 0; sandbox.closeSheetCalls = 0; sandbox.lastToast = null;
  try {
    await sandbox.doForgotPin();
    assert.deepStrictEqual(signInArgs, ['user@example.com', 'correct-pw'], '현재 세션 이메일과 입력한 비밀번호로 AUTH.signIn을 불러야 함');
    assert.strictEqual(sandbox.appLockDisableCalls, 1, '비밀번호가 맞으면 APPLOCK.disable()이 호출돼야 함');
    assert.strictEqual(sandbox.unlockAppCalls, 1);
    assert.strictEqual(sandbox.closeSheetCalls, 1);
    assert.ok(/초기화/.test(sandbox.lastToast));
  } finally {
    sandbox.SESSION = sessionOrig;
    sandbox.AUTH = authOrig;
    sandbox.fpinPwInValue = undefined;
  }
});
test('doForgotPin: email 계정은 비밀번호가 틀리면 AUTH.signIn의 에러 메시지를 보여주고 APPLOCK을 건드리지 않는다', async () => {
  const sessionOrig = sandbox.SESSION, authOrig = sandbox.AUTH;
  sandbox.SESSION = 'user@example.com';
  sandbox.AUTH = { rec: () => null, signIn: async () => ({ err: '비밀번호가 일치하지 않아요' }) };
  sandbox.fpinPwInValue = 'wrong-pw';
  sandbox.fpinErrEl.style.display = 'none'; sandbox.fpinErrEl.textContent = '';
  sandbox.appLockDisableCalls = 0; sandbox.unlockAppCalls = 0; sandbox.closeSheetCalls = 0; sandbox.lastToast = null;
  try {
    await sandbox.doForgotPin();
    assert.strictEqual(sandbox.appLockDisableCalls, 0, '비밀번호가 틀리면 APPLOCK.disable()이 절대 호출되면 안 됨');
    assert.strictEqual(sandbox.unlockAppCalls, 0, '잠금이 풀리면 안 됨');
    assert.strictEqual(sandbox.closeSheetCalls, 0, '시트가 닫히면 안 됨');
    assert.strictEqual(sandbox.lastToast, null);
    assert.strictEqual(sandbox.fpinErrEl.textContent, '비밀번호가 일치하지 않아요');
    assert.strictEqual(sandbox.fpinErrEl.style.display, 'block');
  } finally {
    sandbox.SESSION = sessionOrig;
    sandbox.AUTH = authOrig;
    sandbox.fpinPwInValue = undefined;
  }
});
test('tickForgotPinWait: 대기칸/버튼이 아직 있으면 남은 초를 보여주고 0초가 되면 버튼을 활성화한다', () => {
  sandbox.fpinWaitMsgEl.style.display = 'block'; sandbox.fpinWaitMsgEl.textContent = '';
  sandbox.fpinBtnEl.disabled = true;
  sandbox.tickForgotPinWait(2);
  assert.strictEqual(sandbox.fpinWaitMsgEl.textContent, '2초 후 초기화할 수 있어요…');
  assert.strictEqual(sandbox.fpinBtnEl.disabled, true, '대기 중엔 버튼이 계속 비활성이어야 함');
  sandbox.tickForgotPinWait(0);
  assert.strictEqual(sandbox.fpinWaitMsgEl.textContent, '이제 초기화할 수 있어요');
  assert.strictEqual(sandbox.fpinBtnEl.disabled, false, '대기가 끝나면 버튼이 활성화돼야 함');
});
test('tickForgotPinWait: 시트가 닫혀 대기칸/버튼이 더 이상 없으면(=null) 조용히 멈춘다(재오픈하지 않음)', () => {
  const $orig = sandbox.$;
  sandbox.$ = (id) => (id === 'fpinWaitMsg' || id === 'fpinBtn') ? null : $orig(id);
  try {
    assert.doesNotThrow(() => sandbox.tickForgotPinWait(3), '닫힌 시트의 틱이 예외를 던지면 안 됨');
  } finally {
    sandbox.$ = $orig;
  }
});

/* ---------- genRecoveryCode: 로컬 계정 비밀번호 복구 코드(가입 시 1회 발급, 해시만 저장) ---------- */
test('genRecoveryCode: XXXX-XXXX-XXXX 형태(0/O/1/I 제외 알파벳+숫자)를 만든다', () => {
  const c = sandbox.genRecoveryCode();
  assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
});
test('genRecoveryCode: 매번 다른 코드를 만든다', () => {
  const a = sandbox.genRecoveryCode();
  const b = sandbox.genRecoveryCode();
  assert.notStrictEqual(a, b);
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
/* postponeRecTransfer: 미룰 때 새로 생기는 일회성 거래에도 touch()로 updatedAt 스탬프
 * (app-evolve cycle88 advance, doMaturity/addBalanceAdjust 쪽과 동일 목적) */
test('postponeRecTransfer: 새로 생기는 일회성 거래에도 touch()가 호출된다', () => {
  setupRecTransferDB();
  sandbox.postponeRecTransfer('r1', '2026-09-17');
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.updatedAt, 'test-updatedAt', '새로 생긴 일회성 거래에도 touch()가 호출되어야 함');
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
/* postponeRecTransfer: 새로 생기는 일회성 거래뿐 아니라 r.skip을 두 번 건드리는 반복 자체에도
 * touch()가 필요함 (app-evolve cycle96 develop) — confirmTransferNow/postponeTransfer/confirmRecNow와
 * 같은 이유로, r.skip 변경이 touch() 없이 남으면 mergeCollection()이 updatedAt만 보고 병합하다
 * 다른 기기의 옛 사본이 이겨 미룬 결과(skip 추가)가 조용히 되돌아갈 수 있음. */
test('postponeRecTransfer: 반복(r) 자체에도 touch()가 호출된다', () => {
  setupRecTransferDB();
  sandbox.postponeRecTransfer('r1', '2026-09-17');
  assert.strictEqual(sandbox.DB.recurrences[0].updatedAt, 'test-updatedAt', 'r.skip이 바뀐 반복 자체에도 touch()가 호출되어야 함');
});

/* ---------- confirmTransferNow/postponeTransfer/confirmRecNow: 이체 확인/미루기 처리에
 * touch() 누락 (app-evolve cycle96 develop) — rollPendingTransfers/doRenameOwner/doRenameCat과
 * 완전히 같은 불변식(mergeCollection()은 updatedAt만 보고 승자를 고름)인데, "이체 확인" 시트의
 * 세 액션(완료 처리/내일로 미루기 - 일반 이체, 완료 처리 - 반복 이체 회차)만 이 audit에서
 * 빠져 있었다. ---------- */
test('confirmTransferNow: 완료 처리한 이체에는 touch()가 호출된다', () => {
  sandbox.DB = { txns: [{ id: 't1', type: 'transfer', confirmed: false, amount: 5000 }], recurrences: [], settings: {} };
  sandbox.confirmTransferNow('t1');
  const t = sandbox.DB.txns[0];
  assert.strictEqual(t.confirmed, true);
  assert.strictEqual(t.updatedAt, 'test-updatedAt', '완료 처리된 이체에는 touch()가 호출되어야 함');
});
test('postponeTransfer: 내일로 미룬 이체에는 touch()가 호출된다', () => {
  sandbox.TODAY = '2026-09-17';
  sandbox.DB = { txns: [{ id: 't1', type: 'transfer', date: '2026-09-17', confirmed: false, amount: 5000 }], recurrences: [], settings: {} };
  sandbox.postponeTransfer('t1');
  const t = sandbox.DB.txns[0];
  assert.strictEqual(t.date, sandbox.addDays('2026-09-17', 1));
  assert.strictEqual(t.updatedAt, 'test-updatedAt', '날짜가 미뤄진 이체에는 touch()가 호출되어야 함');
});
test('confirmRecNow: 완료 처리한 반복 이체 회차의 반복(r)에는 touch()가 호출된다', () => {
  setupRecTransferDB();
  sandbox.confirmRecNow('r1', '2026-09-17');
  const r = sandbox.DB.recurrences[0];
  assert.ok(r.confirmedDates.includes('2026-09-17'));
  assert.strictEqual(r.updatedAt, 'test-updatedAt', 'confirmedDates가 바뀐 반복에는 touch()가 호출되어야 함');
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

/* ---------- varyingRecs: daily/weekly 반복거래가 필터에서 제외돼 변동 카테고리 "실제 금액 입력"
 * 알림이 전혀 뜨지 않던 버그의 회귀 테스트(app-evolve cycle67). renderRecSheet()의 주기 선택은
 * monthly/weekly/daily/yearly를 자유롭게 조합할 수 있는데, varyingRecs()의 필터가
 * freq==='monthly'||freq==='yearly'로만 걸려 있어 daily/weekly 변동 반복거래는 회차가 도래해도
 * 절대 알림/빠른입력에 뜨지 않고 expandRec()이 항상 템플릿의 고정 amount로 거래를 만들었다. */
test('varyingRecs: weekly 변동 반복거래도 도래한 회차가 알림 목록에 포함돼야 함', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.DB = { catVar: {}, recurrences: [] };
  sandbox.setCatVar('expense', '장보기', true);
  sandbox.DB.recurrences.push({
    id: 'w1', active: true, freq: 'weekly', type: 'expense', category: '장보기',
    startDate: '2026-06-01', endDate: null, count: null, amount: 30000,
    weekend: 'none', skip: [], edits: {},
  });
  const vr = sandbox.varyingRecs();
  // 2026-06-01(월)부터 매주: 06-01, 06-08, 06-15가 TODAY(06-15)까지 도래
  assert.deepStrictEqual([...vr].map((x) => x.date).sort(), ['2026-06-01', '2026-06-08', '2026-06-15']);
});
test('varyingRecs: daily 변동 반복거래도 도래한 회차가 알림 목록에 포함되고 skip/edits가 여전히 적용돼야 함', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.DB = { catVar: {}, recurrences: [] };
  sandbox.setCatVar('expense', '커피', true);
  sandbox.DB.recurrences.push({
    id: 'd1', active: true, freq: 'daily', type: 'expense', category: '커피',
    startDate: '2026-06-13', endDate: null, count: null, amount: 5000,
    weekend: 'none', skip: ['2026-06-14'], edits: { '2026-06-13': { amount: 4500 } },
  });
  const vr = sandbox.varyingRecs();
  // 06-13은 edits로, 06-14는 skip으로 빠지고 06-15만 남아야 함
  assert.deepStrictEqual([...vr].map((x) => x.date), ['2026-06-15']);
});

/* ---------- varyingRecs: 이번 달로 넘어가면 지난달 이전에 실제 금액을 안 넣은 변동 회차가
 * 알림 목록에서 영영 사라지던 버그의 회귀 테스트(app-evolve cycle71). varyingRecs()가
 * recDates()를 monthStartStr(TM.y,TM.m)~monthEndStr(TM.y,TM.m)로만 스캔해, 지난달 회차는
 * 달이 바뀌는 순간 창밖으로 빠져 사용자가 다시는 실제 금액을 입력할 방법이 없었고
 * expandRec()은 그 달을 계속 템플릿 amount로 조용히 채웠다. */
test('varyingRecs: 달이 바뀌어도 지난달의 미입력 변동 회차가 계속 알림에 남아야 함', () => {
  sandbox.TODAY = '2026-07-05';
  sandbox.TM = { y: 2026, m: 7 };
  sandbox.DB = { catVar: {}, recurrences: [] };
  sandbox.setCatVar('expense', '전기요금', true);
  sandbox.DB.recurrences.push({
    id: 'r1', active: true, freq: 'monthly', type: 'expense', category: '전기요금',
    day: 10, startDate: '2026-01-10', endDate: null, count: null, amount: 50000,
    weekend: 'none', skip: [], edits: {},
  });
  const vr = sandbox.varyingRecs();
  assert.ok(vr.some((x) => x.date === '2026-06-10'), '지난달(6월) 미입력 회차가 7월이 돼도 알림 목록에 남아 있어야 함');
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

/* ---------- planTransfer/planSplitTransfer: 예정 이체로 남기며 새로 push하는 거래에도
 * touch()로 updatedAt 스탬프 (app-evolve cycle88 advance, doMaturity/addBalanceAdjust 쪽과
 * 동일 목적) ---------- */
test('planTransfer: 새로 남기는 예정 이체 거래에도 touch()가 호출된다', () => {
  setupFixShortfallDB();
  sandbox.planTransfer('donor', 'assetA', '2026-06-19', 50000);
  const t = sandbox.DB.txns[sandbox.DB.txns.length - 1];
  assert.strictEqual(t.updatedAt, 'test-updatedAt', '새로 남긴 예정 이체 거래에도 touch()가 호출되어야 함');
});
test('planSplitTransfer: 여러 출처로 나눠 남기는 예정 이체 거래 각각에 touch()가 호출된다', () => {
  setupFixShortfallDB();
  sandbox.planSplitTransfer([{ id: 'donor', amount: 30000 }, { id: 'assetB', amount: 20000 }], 'assetA', '2026-06-19');
  assert.strictEqual(sandbox.DB.txns.length, 2);
  assert.ok(sandbox.DB.txns.every((t) => t.updatedAt === 'test-updatedAt'), '나눠 남기는 예정 이체 거래 각각에 touch()가 호출되어야 함');
});

/* ---------- planTransfer/planSplitTransfer: 날짜피커('날짜 선택')로 고른 날짜가
 * RANGE_FROM/RANGE_TO 범위를 벗어나도 saveTx/saveRec과 달리 아무 검증 없이 DB.txns.push로
 * 직접 적재되던 경계버그(app-evolve cycle123 develop). 이 두 함수는 saveTx를 거치지 않아
 * cycle120에서 saveTx/saveRec/csvRowToImportTxn/sanitizeBackup 네 곳에 추가한 대칭 검증이
 * 전혀 적용되지 않았고, 범위 밖으로 저장된 거래는 allTxns(RANGE_FROM,RANGE_TO) 조회 범위
 * 밖이라 "남겼어요" 토스트만 뜨고 가계부/홈 어디에도 다시 나타나지 않는 조용한 데이터 유실로
 * 이어졌다. */
test('planTransfer: RANGE_FROM 이전 날짜는 토스트만 뜨고 저장되지 않는다', () => {
  setupFixShortfallDB();
  sandbox.toastCalls = [];
  sandbox.planTransfer('donor', 'assetA', '2022-12-31', 50000);
  assert.strictEqual(sandbox.DB.txns.length, 0, 'RANGE_FROM 이전 날짜는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some((m) => m.includes('2023-01-01')), '하한 날짜를 알려주는 토스트가 떠야 함');
});
test('planTransfer: RANGE_TO 이후 날짜는 토스트만 뜨고 저장되지 않는다', () => {
  setupFixShortfallDB();
  sandbox.RANGE_TO = '2028-06-15';
  sandbox.toastCalls = [];
  sandbox.planTransfer('donor', 'assetA', '2028-06-16', 50000);
  assert.strictEqual(sandbox.DB.txns.length, 0, 'RANGE_TO 이후 날짜는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some((m) => m.includes('2028-06-15')), '상한 날짜를 알려주는 토스트가 떠야 함');
});
test('planSplitTransfer: RANGE_FROM 이전 날짜는 토스트만 뜨고 저장되지 않는다', () => {
  setupFixShortfallDB();
  sandbox.toastCalls = [];
  sandbox.planSplitTransfer([{ id: 'donor', amount: 30000 }], 'assetA', '2022-12-31');
  assert.strictEqual(sandbox.DB.txns.length, 0, 'RANGE_FROM 이전 날짜는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some((m) => m.includes('2023-01-01')), '하한 날짜를 알려주는 토스트가 떠야 함');
});
test('planSplitTransfer: RANGE_TO 이후 날짜는 토스트만 뜨고 저장되지 않는다', () => {
  setupFixShortfallDB();
  sandbox.RANGE_TO = '2028-06-15';
  sandbox.toastCalls = [];
  sandbox.planSplitTransfer([{ id: 'donor', amount: 30000 }], 'assetA', '2028-06-16');
  assert.strictEqual(sandbox.DB.txns.length, 0, 'RANGE_TO 이후 날짜는 저장되면 안 됨');
  assert.ok(sandbox.toastCalls.some((m) => m.includes('2028-06-15')), '상한 날짜를 알려주는 토스트가 떠야 함');
});

/* ---------- fixShortfallDefaultDate/openFixShortfall: 부족해지는 날이 오늘/내일이면
 * '결제 전날'이 이미 지난 날짜가 되어, 부족 알림의 기본 이체일과 퀵픽 버튼이 과거 날짜를
 * 가리키고 그대로 선택하면 confirmed:false인 과거 날짜 이체가 DB.txns에 만들어지던
 * 버그의 회귀 테스트(app-evolve cycle63). 전날이 오늘보다 이르면 오늘로 올려 잡아야 한다. */
test('fixShortfallDefaultDate: 부족해지는 날이 오늘이면 전날(=어제)이 아니라 오늘을 기본값으로 준다', () => {
  assert.strictEqual(sandbox.fixShortfallDefaultDate('2026-06-15', '2026-06-15'), '2026-06-15');
});
test('fixShortfallDefaultDate: 부족해지는 날이 내일이면 전날(=오늘)이 오늘과 같으므로 그대로 오늘을 준다', () => {
  assert.strictEqual(sandbox.fixShortfallDefaultDate('2026-06-16', '2026-06-15'), '2026-06-15');
});
test('fixShortfallDefaultDate: 부족해지는 날이 모레 이상이면 평소처럼 결제 전날을 그대로 기본값으로 준다', () => {
  assert.strictEqual(sandbox.fixShortfallDefaultDate('2026-06-20', '2026-06-15'), sandbox.addDays('2026-06-20', -1));
});
test('openFixShortfall: 부족해지는 날이 오늘이면 이체 기본일을 과거(어제)가 아니라 오늘로 잡는다(회귀 확인)', () => {
  setupFixShortfallDB();
  sandbox.openFixShortfall('assetA', '2026-06-15', 50000);
  assert.strictEqual(sandbox._fixWhen, '2026-06-15', '기본 이체일이 오늘보다 이전이면 안 됨');
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
test('planNegatives: 오늘 날짜의 미확인(pending) 이체는 아직 나간 돈이 아니므로 거짓 마이너스 경고를 만들지 않는다(app-evolve cycle90 회귀 확인)', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: { confirmTransfers: true },
    assets: [
      { id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: 500000 },
      { id: 'a2', name: '통장2', owner: '나', type: 'cash', baseAmount: 0 },
    ],
    txns: [
      { id: 't1', date: sandbox.TODAY, type: 'transfer', amount: 600000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false },
    ],
    recurrences: [],
  };
  assert.deepStrictEqual(Array.from(sandbox.planNegatives()), [], '미확인 이체를 확정된 것처럼 반영해 오늘 마이너스로 잘못 표시하면 안 됨');
});
test('planNegatives: 같은 이체라도 확인 완료(confirmed:true)면 정상적으로 마이너스를 잡아낸다(app-evolve cycle90 회귀 확인)', () => {
  sandbox.TODAY = '2026-06-15';
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox.DB = {
    settings: { confirmTransfers: true },
    assets: [
      { id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: 500000 },
      { id: 'a2', name: '통장2', owner: '나', type: 'cash', baseAmount: 0 },
    ],
    txns: [
      { id: 't1', date: sandbox.TODAY, type: 'transfer', amount: 600000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: true },
    ],
    recurrences: [],
  };
  const out = sandbox.planNegatives();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].assetId, 'a1');
  assert.strictEqual(out[0].date, sandbox.TODAY);
  assert.strictEqual(out[0].min, -100000);
});
test('homeAlerts: 변동 항목(quick)이 정확히 1건이면 quick, 2건으로 늘면 quickMulti로 묶인다(app-evolve cycle43)', () => {
  // varyingRecs()가 RANGE_FROM~TODAY 전체를 스캔하므로(cycle71), 이 테스트의 목적인
  // "그룹핑 개수(1건 vs 2건)" 검증이 지난달 이전 미입력 회차 섞임에 흔들리지 않도록
  // startDate를 이번 달로 둬 각 반복거래마다 회차가 정확히 1개씩만 생기게 한다.
  setupHomeAlertsDB();
  sandbox.setCatVar('expense', '전기요금', true);
  sandbox.DB.recurrences.push({
    id: 'r1', active: true, freq: 'monthly', type: 'expense', category: '전기요금',
    day: 10, startDate: '2026-06-01', endDate: null, count: null, amount: 50000,
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
    day: 12, startDate: '2026-06-01', endDate: null, count: null, amount: 30000,
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
/* 미확인 이체(confirm)도 quick/quickMulti·budgetOver/budgetOverMulti와 동일한 1건/N건 묶음 패턴을 쓴다
 * (app-evolve cycle156 critique: 반복 이체를 방치하면 홈 알림이 confirm 카드로 도배되던 비대칭을 해소) */
test('homeAlerts: 미확인 이체(confirm)가 정확히 1건이면 confirm, 2건으로 늘면 confirmMulti로 묶인다(app-evolve cycle156)', () => {
  setupHomeAlertsDB();
  sandbox.DB.settings.confirmTransfers = true;
  sandbox.DB.assets.push({ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: 1000000 });
  sandbox.DB.assets.push({ id: 'a2', name: '통장2', owner: '나', type: 'cash', baseAmount: 0 });
  sandbox.DB.txns.push({ id: 't1', date: '2026-06-10', type: 'transfer', amount: 50000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false });
  let alerts = sandbox.homeAlerts([]);
  let confirm = alerts.filter((a) => a.kind === 'confirm' || a.kind === 'confirmMulti');
  assert.strictEqual(confirm.length, 1);
  assert.strictEqual(confirm[0].kind, 'confirm', '정확히 1건이면 confirm이어야 함');
  assert.strictEqual(confirm[0].id, 't1');

  sandbox.DB.txns.push({ id: 't2', date: '2026-06-11', type: 'transfer', amount: 30000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false });
  alerts = sandbox.homeAlerts([]);
  confirm = alerts.filter((a) => a.kind === 'confirm' || a.kind === 'confirmMulti');
  assert.strictEqual(confirm.length, 1);
  assert.strictEqual(confirm[0].kind, 'confirmMulti', '2건이 되면 confirmMulti 하나로 묶여야 함');
  assert.strictEqual(confirm[0].count, 2);
});
test('notifyAlertInfo: confirmMulti도 budgetOverMulti처럼 건수가 바뀌면 다시 알리도록 키에 count가 들어간다(app-evolve cycle156)', () => {
  sandbox.TODAY = '2026-06-15';
  const confirmMulti = sandbox.notifyAlertInfo({ kind: 'confirmMulti', count: 2 });
  assert.ok(confirmMulti && confirmMulti.key === 'confirmMulti:2026-06-15:2', '날짜+건수로 키가 잡혀야 함');
  assert.ok(confirmMulti.body.includes('2건'));
  const confirmMulti3 = sandbox.notifyAlertInfo({ kind: 'confirmMulti', count: 3 });
  assert.notStrictEqual(confirmMulti3.key, confirmMulti.key, '건수가 늘면 키도 바뀌어 다시 알려야 함');
});
/* ---------- homeAlerts/homeAlertCard: clockSkew (app-evolve cycle165 advance) ----------
 * critique(cycle165)가 발견한 "mergeCollection() LWW가 두 기기 로컬 시계만 본다" 데이터 손실
 * 위험에 대한 감지+경고. CLOUD_UID가 있어야만(클라우드 동기화 계정) 의미가 있고, 로컬/카카오
 * 전용 계정은 같은 기기 시계만 쓰므로 CLOUD_UID가 없으면 CLOCK_SKEW_MS가 커도 뜨지 않는다. */
test('homeAlerts: CLOUD_UID가 없으면(로컬/카카오 전용) CLOCK_SKEW_MS가 커도 clockSkew를 띄우지 않는다', () => {
  setupHomeAlertsDB();
  sandbox.CLOUD_UID = null;
  sandbox.CLOCK_SKEW_MS = 2 * 24 * 60 * 60 * 1000;
  const alerts = sandbox.homeAlerts([]);
  assert.ok(!alerts.some((a) => a.kind === 'clockSkew'));
});
test('homeAlerts: CLOUD_UID가 있고 drift가 warn 문턱을 넘으면(dismiss 전) clockSkew(warn)를 띄운다', () => {
  setupHomeAlertsDB();
  sandbox.CLOUD_UID = 'u1';
  sandbox.CLOCK_SKEW_MS = 10 * 60 * 1000;
  sandbox.DB.settings.clockSkewWarnDismissed = false;
  const alerts = sandbox.homeAlerts([]);
  const skew = alerts.find((a) => a.kind === 'clockSkew');
  assert.ok(skew, 'clockSkew 알림이 있어야 함');
  assert.strictEqual(skew.severity, 'warn');
});
test('homeAlerts: warn 등급은 dismiss하면 조용해지지만, severe 등급은 dismiss해도 다시 뜬다', () => {
  setupHomeAlertsDB();
  sandbox.CLOUD_UID = 'u1';
  sandbox.CLOCK_SKEW_MS = 10 * 60 * 1000;
  sandbox.DB.settings.clockSkewWarnDismissed = true;
  let alerts = sandbox.homeAlerts([]);
  assert.ok(!alerts.some((a) => a.kind === 'clockSkew'), 'warn + dismiss면 조용해야 함');

  sandbox.CLOCK_SKEW_MS = 2 * 24 * 60 * 60 * 1000;
  alerts = sandbox.homeAlerts([]);
  const skew = alerts.find((a) => a.kind === 'clockSkew');
  assert.ok(skew, 'severe는 dismiss했어도 떠야 함(방치 방지)');
  assert.strictEqual(skew.severity, 'severe');
});
test('homeAlerts: drift가 아직 null(측정 전/실패)이면 CLOUD_UID가 있어도 clockSkew를 띄우지 않는다', () => {
  setupHomeAlertsDB();
  sandbox.CLOUD_UID = 'u1';
  sandbox.CLOCK_SKEW_MS = null;
  const alerts = sandbox.homeAlerts([]);
  assert.ok(!alerts.some((a) => a.kind === 'clockSkew'));
});
test('homeAlertCard: clockSkew는 severity별로 다른 문구를 쓰고, 눌러서 동기화 상태를 보고 확인으로 dismiss할 수 있다', () => {
  const warnHtml = sandbox.homeAlertCard({ kind: 'clockSkew', severity: 'warn' });
  assert.ok(warnHtml.includes('기기 시간을 확인해 주세요'), 'warn 문구가 보여야 함');
  assert.ok(warnHtml.includes('onclick="openAccountSheet()"'), '눌러서 동기화 상태(계정 화면)로 가야 함');
  assert.ok(warnHtml.includes('onkeydown="rowKeydown(event,openAccountSheet)"'), '키보드 접근 가능해야 함');
  assert.ok(warnHtml.includes('dismissClockSkewWarn()'), '확인 버튼으로 dismiss할 수 있어야 함');

  const severeHtml = sandbox.homeAlertCard({ kind: 'clockSkew', severity: 'severe' });
  assert.ok(severeHtml.includes('기기 시간이 많이 틀려요'), 'severe는 더 강한 문구를 써야 함');
  assert.notStrictEqual(severeHtml, warnHtml, 'severity별로 다른 카드여야 함');
});
test('homeAlertCard: confirmMulti는 openConfirmTransferList()로 열리고 건수가 보인다(app-evolve cycle156)', () => {
  const html = sandbox.homeAlertCard({ kind: 'confirmMulti', count: 3 });
  assert.ok(html.includes('onclick="openConfirmTransferList()"'), 'confirmMulti 카드가 openConfirmTransferList()를 호출해야 함');
  assert.ok(html.includes('이체 확인 3건'), '건수가 보여야 함');
});
test('homeAlertCard: negMulti는 openNegList()로 열리고 건수가 보인다(app-evolve cycle157)', () => {
  const html = sandbox.homeAlertCard({ kind: 'negMulti', count: 2 });
  assert.ok(html.includes('onclick="openNegList()"'), 'negMulti 카드가 openNegList()를 호출해야 함');
  assert.ok(html.includes('잔액 부족 예상 2건'), '건수가 보여야 함');
});
test('homeAlertCard: matMulti는 openMaturity()로 열리고 건수가 보인다(기존 저축 만기 목록 시트를 재사용, app-evolve cycle157)', () => {
  const html = sandbox.homeAlertCard({ kind: 'matMulti', count: 3 });
  assert.ok(html.includes('onclick="openMaturity()"'), 'matMulti 카드가 새 시트를 만들지 않고 기존 openMaturity()를 재사용해야 함');
  assert.ok(html.includes('저축 만기 임박 3건'), '건수가 보여야 함');
});
test('openConfirmTransferList: 미확인 이체가 없으면 안내 토스트만 뜨고, 정확히 1건이면 목록 없이 바로 그 건의 개별 확인 시트로 간다(app-evolve cycle156)', () => {
  setupHomeAlertsDB();
  sandbox.DB.settings.confirmTransfers = true;
  sandbox.DB.assets.push({ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: 1000000 });
  sandbox.DB.assets.push({ id: 'a2', name: '통장2', owner: '나', type: 'cash', baseAmount: 0 });
  sandbox.lastToast = null;
  sandbox.lastSheetHtml = null;
  sandbox.openConfirmTransferList();
  assert.ok(sandbox.lastToast, '확인할 이체가 없으면 안내 토스트가 떠야 함');
  assert.strictEqual(sandbox.lastSheetHtml, null, '항목이 없으면 시트를 열면 안 됨');

  sandbox.DB.txns.push({ id: 't1', date: '2026-06-10', type: 'transfer', amount: 50000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false });
  sandbox.lastSheetHtml = null;
  sandbox.openConfirmTransferList();
  assert.ok(sandbox.lastSheetHtml, '1건이면 개별 확인 시트가 떠야 함');
  assert.ok(sandbox.lastSheetHtml.includes(`confirmTransferNow('t1')`), '1건이면 목록이 아니라 openConfirmTransfer의 개별 시트로 바로 가야 함');
});
test('openConfirmTransferList: 2건 이상이면 일반 이체와 반복 이체를 한 시트에 한 줄씩 보여주고, 각자 올바른 확인 함수로 연결된다(app-evolve cycle156)', () => {
  setupHomeAlertsDB();
  sandbox.DB.settings.confirmTransfers = true;
  sandbox.DB.assets.push({ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: 1000000 });
  sandbox.DB.assets.push({ id: 'a2', name: '통장2', owner: '나', type: 'cash', baseAmount: 0 });
  sandbox.DB.txns.push({ id: 't1', date: '2026-06-10', type: 'transfer', amount: 50000, fromAssetId: 'a1', toAssetId: 'a2', confirmed: false });
  sandbox.DB.recurrences.push({
    id: 'r1', active: true, freq: 'monthly', type: 'transfer', category: '이체',
    day: 12, startDate: '2026-06-01', endDate: null, count: null, amount: 30000,
    fromAssetId: 'a1', toAssetId: 'a2', weekend: 'none', skip: [], edits: {},
    autoConfirm: false, confirmedDates: [],
  });
  sandbox.lastSheetHtml = null;
  sandbox.openConfirmTransferList();
  const html = sandbox.lastSheetHtml;
  assert.ok(html.includes('미확인 이체 2건'), '건수 안내가 있어야 함');
  assert.ok(html.includes(`openConfirmTransfer('t1')`), '일반 이체 행은 openConfirmTransfer로 연결돼야 함');
  assert.ok(html.includes(`confirmRecTransfer('r1','2026-06-12')`), '반복 이체 행은 confirmRecTransfer로 연결돼야 함');
  assert.ok(html.includes(sandbox.comma(50000)) && html.includes(sandbox.comma(30000)), '각 행에 금액이 표시돼야 함');
});
/* openNegList: openConfirmTransferList()/openQuickList()와 동일 패턴 — 0건이면 토스트만, 1건이면
 * 목록 없이 바로 plan 탭으로, 2건 이상이면 한 시트에 한 줄씩 보여주고 눌렀을 때 시트를 닫고
 * plan 탭으로 이동한다(sheet 위에 plan 탭이 그대로 깔리는 걸 막기 위해 closeSheet 필요,
 * openConfirmTransferList/openQuickList의 개별 확인 시트와 달리 sheet가 아니라 탭 전환이라서).
 * (app-evolve cycle157 advance) */
test('openNegList: 부족 예상 통장이 없으면 안내 토스트만 뜨고, 정확히 1곳이면 목록 없이 바로 plan 탭으로 간다(app-evolve cycle157)', () => {
  setupHomeAlertsDB();
  sandbox.ST = { plan: { owner: '전체' } };
  sandbox.goCalls = [];
  sandbox.closeSheetCalls = 0;
  sandbox.lastToast = null;
  sandbox.lastSheetHtml = null;
  sandbox.openNegList();
  assert.ok(sandbox.lastToast, '부족 예상 통장이 없으면 안내 토스트가 떠야 함');
  assert.strictEqual(sandbox.lastSheetHtml, null, '항목이 없으면 시트를 열면 안 됨');
  assert.deepStrictEqual(sandbox.goCalls, [], '항목이 없으면 탭 전환도 없어야 함');

  sandbox.DB.assets.push({ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: -30000 });
  sandbox.lastSheetHtml = null;
  sandbox.openNegList();
  assert.strictEqual(sandbox.lastSheetHtml, null, '1곳이면 목록 시트를 열지 않고 바로 plan 탭으로 가야 함');
  assert.strictEqual(sandbox.closeSheetCalls, 1, '탭 전환 전에 열려있던 시트를 닫아야 함');
  assert.deepStrictEqual(sandbox.goCalls, ['plan'], "1곳이면 바로 go('plan')으로 가야 함");
  assert.strictEqual(sandbox.ST.plan.assetId, 'a1', 'plan 탭이 그 통장을 선택한 상태로 열려야 함');
});
test('openNegList: 2곳 이상이면 한 시트에 한 줄씩 보여주고, 누르면 시트를 닫고 그 통장의 plan 탭으로 이동한다(app-evolve cycle157)', () => {
  setupHomeAlertsDB();
  sandbox.DB.assets.push({ id: 'a1', name: '통장1', owner: '나', type: 'cash', baseAmount: -30000 });
  sandbox.DB.assets.push({ id: 'a2', name: '통장2', owner: '나', type: 'cash', baseAmount: 10000 });
  sandbox.DB.txns.push({ id: 't1', date: '2026-06-20', type: 'expense', category: '식비', amount: 15000, fromAssetId: 'a2' });
  sandbox.lastSheetHtml = null;
  sandbox.openNegList();
  const html = sandbox.lastSheetHtml;
  assert.ok(html, '2곳 이상이면 목록 시트를 열어야 함');
  assert.ok(html.includes('통장 2곳'), '건수 안내가 있어야 함');
  assert.ok(html.includes(`closeSheet();goPlanTo('a1','2026-06-15')`), '이미 마이너스인 통장 행은 오늘 날짜로 closeSheet 후 goPlanTo로 연결돼야 함');
  assert.ok(html.includes(`closeSheet();goPlanTo('a2','2026-06-20')`), '예정 지출로 마이너스 전환되는 통장 행은 그 날짜로 연결돼야 함');
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
/* neg(잔액부족예상)도 quick/quickMulti·confirm/confirmMulti와 동일한 1건/N건 묶음 패턴을 쓴다
 * (app-evolve cycle157 critique: confirm/quick/budgetOver는 이미 묶는데 바로 옆줄의 neg/mat만
 * 묶지 않아 자산이 여러 개 동시에 부족해지면 홈 알림이 카드로 도배되던 비대칭을 해소) */
test('homeAlerts: 잔액부족예상(neg)이 정확히 1건이면 neg, 2건으로 늘면 negMulti로 묶인다(app-evolve cycle157)', () => {
  setupHomeAlertsDB();
  let alerts = sandbox.homeAlerts([{ assetId: 'a1', name: '통장1', owner: '나', date: '2026-06-20', min: -5000 }]);
  let neg = alerts.filter((a) => a.kind === 'neg' || a.kind === 'negMulti');
  assert.strictEqual(neg.length, 1);
  assert.strictEqual(neg[0].kind, 'neg', '정확히 1건이면 neg여야 함');
  assert.strictEqual(neg[0].assetId, 'a1');

  alerts = sandbox.homeAlerts([
    { assetId: 'a1', name: '통장1', owner: '나', date: '2026-06-20', min: -5000 },
    { assetId: 'a2', name: '통장2', owner: '나', date: '2026-06-22', min: -2000 },
  ]);
  neg = alerts.filter((a) => a.kind === 'neg' || a.kind === 'negMulti');
  assert.strictEqual(neg.length, 1);
  assert.strictEqual(neg[0].kind, 'negMulti', '2건이 되면 negMulti 하나로 묶여야 함');
  assert.strictEqual(neg[0].count, 2);
});
test('homeAlerts: 저축 만기 임박(mat)이 정확히 1건이면 mat, 2건으로 늘면 matMulti로 묶인다(app-evolve cycle157)', () => {
  setupHomeAlertsDB();
  sandbox.DB.assets.push({ id: 's1', name: '적금1', owner: '나', type: 'savings', baseAmount: 1000000, maturityDate: '2026-06-18' });
  let alerts = sandbox.homeAlerts([]);
  let mat = alerts.filter((a) => a.kind === 'mat' || a.kind === 'matMulti');
  assert.strictEqual(mat.length, 1);
  assert.strictEqual(mat[0].kind, 'mat', '정확히 1건이면 mat여야 함');
  assert.strictEqual(mat[0].assetId, 's1');

  sandbox.DB.assets.push({ id: 's2', name: '적금2', owner: '나', type: 'savings', baseAmount: 500000, maturityDate: '2026-06-20' });
  alerts = sandbox.homeAlerts([]);
  mat = alerts.filter((a) => a.kind === 'mat' || a.kind === 'matMulti');
  assert.strictEqual(mat.length, 1);
  assert.strictEqual(mat[0].kind, 'matMulti', '2건이 되면 matMulti 하나로 묶여야 함');
  assert.strictEqual(mat[0].count, 2);
  assert.strictEqual(mat[0].dueCount, 0, '둘 다 오늘/내일(1일 이내)이 아니면 dueCount는 0이어야 함');
});
test('homeAlerts: matMulti의 dueCount는 1일 이내(오늘·내일·지남)로 만기인 건수만 센다(app-evolve cycle157)', () => {
  setupHomeAlertsDB();
  sandbox.DB.assets.push({ id: 's1', name: '적금1', owner: '나', type: 'savings', baseAmount: 1000000, maturityDate: '2026-06-15' }); // 오늘
  sandbox.DB.assets.push({ id: 's2', name: '적금2', owner: '나', type: 'savings', baseAmount: 500000, maturityDate: '2026-06-20' }); // 5일 뒤(7일 이내지만 1일 이내 아님)
  const alerts = sandbox.homeAlerts([]);
  const matMulti = alerts.find((a) => a.kind === 'matMulti');
  assert.ok(matMulti);
  assert.strictEqual(matMulti.count, 2);
  assert.strictEqual(matMulti.dueCount, 1, '오늘 만기 1건만 1일 이내로 카운트돼야 함');
});
/* ---------- notifyAlertInfo/pickNotifyAlerts/pruneNotifiedIds: OS 알림 대상 선별/dedupe 회귀 테스트
 * (app-evolve cycle59 advance) — homeAlerts()가 이미 계산해두는 confirm/mat/budgetOver(Multi) 중
 * "앱을 열지 않으면 그날 놓치는" 긴급 알림만 골라 OS 알림으로 보내되, 같은 항목을 반복 호출마다
 * 중복 발송하지 않는지가 이 로직의 핵심이라 별도로 커버한다. ---------- */
test('notifyAlertInfo: confirm/budgetOver(Multi)는 즉시 알림 대상이 되고, backup/neg처럼 관계없는 kind는 대상에서 빠진다', () => {
  sandbox.TODAY = '2026-06-15';
  const confirm = sandbox.notifyAlertInfo({ kind: 'confirm', id: 't1', date: '2026-06-15', from: '통장1', to: '통장2', amount: 10000 });
  assert.ok(confirm && confirm.key === 'confirm:t1:2026-06-15', '이체 확인 알림은 거래 id+날짜로 키가 잡혀야 함');
  const budgetOver = sandbox.notifyAlertInfo({ kind: 'budgetOver', cat: '식비', spent: 150000, budget: 100000 });
  assert.ok(budgetOver && budgetOver.key === 'budget:식비:2026-06');
  const budgetMulti = sandbox.notifyAlertInfo({ kind: 'budgetOverMulti', count: 2 });
  assert.ok(budgetMulti && budgetMulti.key === 'budgetMulti:2026-06');
  assert.strictEqual(sandbox.notifyAlertInfo({ kind: 'backup' }), null, 'OS 알림 대상이 아닌 kind는 null이어야 함');
  assert.strictEqual(sandbox.notifyAlertInfo({ kind: 'neg', assetId: 'a1' }), null);
});
test('notifyAlertInfo: 저축 만기(mat)는 오늘·내일만 알림 대상이고, 이틀 뒤부터는 아직 대상이 아니다', () => {
  sandbox.TODAY = '2026-06-15';
  const today = sandbox.notifyAlertInfo({ kind: 'mat', assetId: 's1', name: '적금', date: '2026-06-15', amount: 1000000 });
  assert.ok(today && today.key === 'mat:s1:2026-06-15');
  assert.ok(today.body.includes('오늘'), '오늘 만기면 본문에 "오늘"이 들어가야 함');
  const tomorrow = sandbox.notifyAlertInfo({ kind: 'mat', assetId: 's1', name: '적금', date: '2026-06-16', amount: 1000000 });
  assert.ok(tomorrow, '내일 만기는 아직 임박 알림 대상이어야 함');
  assert.ok(tomorrow.body.includes('내일'), '내일 만기면 본문에 "내일"이 들어가야 함');
  const dayAfter = sandbox.notifyAlertInfo({ kind: 'mat', assetId: 's1', name: '적금', date: '2026-06-17', amount: 1000000 });
  assert.strictEqual(dayAfter, null, '이틀 뒤 만기는 아직 알림 대상이 아니어야 함');
});
/* homeAlerts()의 'mat' 포함 조건(a.maturityDate<=addDays(TODAY,7))은 하한이 없어, doMaturity()로
 * 아직 처리하지 않은 지난 만기(overdue)도 계속 포함된다 — notifyAlertInfo가 날짜만 보고
 * "오늘이 아니면 내일"로 단정하면 이미 여러 날 지난 만기를 "내일 만기"라고 잘못 알리게 된다
 * (app-evolve cycleN develop에서 발견). overdue는 별도 문구("만기가 지났어요")로 구분해야 한다. */
test('notifyAlertInfo: 이미 지난 저축 만기(overdue, doMaturity 미처리)는 "내일"이 아니라 "지났어요"로 알린다', () => {
  sandbox.TODAY = '2026-06-15';
  const overdue = sandbox.notifyAlertInfo({ kind: 'mat', assetId: 's1', name: '적금', date: '2026-06-05', amount: 1000000 });
  assert.ok(overdue, '지난 만기도 계속 알림 대상이어야 함(사용자가 아직 이체 처리를 안 했으므로)');
  assert.ok(!overdue.body.includes('내일'), '10일 지난 만기를 "내일 만기"라고 말하면 안 됨');
  assert.ok(overdue.body.includes('지났'), '지난 만기는 본문에 "지났다"는 사실이 드러나야 함');
  assert.ok(overdue.title.includes('지났'), '제목도 "임박"이 아니라 "지났다"로 구분돼야 함');
  // 지난 지 하루뿐(어제)이어도 overdue 분기를 타야 한다(오늘/내일이 아님)
  const yesterday = sandbox.notifyAlertInfo({ kind: 'mat', assetId: 's1', name: '적금', date: '2026-06-14', amount: 1000000 });
  assert.ok(yesterday.body.includes('지났'));
  assert.ok(!yesterday.body.includes('내일'));
});
test('notifyAlertInfo: matMulti는 묶인 건 중 1일 이내(dueCount)로 임박한 게 있을 때만 알리고, 날짜+건수로 키가 잡힌다(app-evolve cycle157)', () => {
  sandbox.TODAY = '2026-06-15';
  const urgent = sandbox.notifyAlertInfo({ kind: 'matMulti', count: 3, dueCount: 1 });
  assert.ok(urgent && urgent.key === 'matMulti:2026-06-15:3', '날짜+건수로 키가 잡혀야 함');
  assert.ok(urgent.body.includes('3건'));
  const notYet = sandbox.notifyAlertInfo({ kind: 'matMulti', count: 2, dueCount: 0 });
  assert.strictEqual(notYet, null, '전부 1일 이내가 아니면(아직 임박 아님) 알림 대상이 아니어야 함');
  const urgent4 = sandbox.notifyAlertInfo({ kind: 'matMulti', count: 4, dueCount: 2 });
  assert.notStrictEqual(urgent4.key, urgent.key, '건수가 늘면 키도 바뀌어 다시 알려야 함');
});
test('pickNotifyAlerts: 이미 알림 보낸 key는 다시 보내지 않고(dedupe), 처음 보는 key만 toNotify에 담긴다', () => {
  sandbox.TODAY = '2026-06-15';
  const alerts = [
    { kind: 'confirm', id: 't1', date: '2026-06-15', from: '통장1', to: '통장2', amount: 10000 },
    { kind: 'backup' },
  ];
  const first = sandbox.pickNotifyAlerts(alerts, {});
  assert.strictEqual(first.toNotify.length, 1);
  assert.strictEqual(first.toNotify[0].key, 'confirm:t1:2026-06-15');
  assert.ok(first.notifiedIds['confirm:t1:2026-06-15'], '보낸 key는 notifiedIds에 기록돼야 함');
  const second = sandbox.pickNotifyAlerts(alerts, first.notifiedIds);
  assert.strictEqual(second.toNotify.length, 0, '같은 key는 두 번째 호출에서 다시 보내면 안 됨');
});
test('pruneNotifiedIds: 30일 이내 항목은 남기고, 30일 지난 항목은 정리해 무한정 커지지 않게 한다', () => {
  const now = Date.now();
  const notifiedIds = {
    fresh: now - 1000,
    old: now - 31 * 24 * 60 * 60 * 1000,
  };
  const out = sandbox.pruneNotifiedIds(notifiedIds, now);
  assert.deepStrictEqual(Object.keys(out), ['fresh']);
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
/* 구분(지출/수입/저축) 세그먼트가 class="on"만으로 선택 상태를 표시해 스크린리더가 어떤 탭이
 * 선택돼 있는지 알 수 없던 공백 — app-evolve cycle147 critique/advance. */
test('openCatManage: 구분 세그먼트가 현재 탭(kind)과 일치하는 버튼에만 aria-pressed="true"를 준다', () => {
  setupCatManageDB();
  sandbox.openCatManage('income');
  const html = sandbox.lastSheetHtml;
  const buttons = [...html.matchAll(/<button class="([^"]*)" aria-pressed="(true|false)" onclick="openCatManage\('(\w+)'\)">/g)];
  assert.strictEqual(buttons.length, 3, '지출/수입/저축 세 개 구분 버튼이 렌더돼야 함');
  buttons.forEach(([, cls, pressed, k]) => {
    assert.strictEqual(cls === 'on', pressed === 'true', `${k} 버튼의 on 클래스(${cls})와 aria-pressed(${pressed})가 일치하지 않음`);
    assert.strictEqual(pressed === 'true', k === 'income', `kind="income"일 때는 ${k} 버튼의 aria-pressed가 (${k === 'income'})이어야 함`);
  });
  assert.ok(/<div class="seg" role="group" aria-label="구분 선택">/.test(html), '구분 세그먼트 래퍼에 role="group"/aria-label이 없음');
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
/* newOwner/renameOwner/newCat/renameCat — asName/goalName/txMemo 등 다른 모든 짧은 텍스트
 * 입력란은 수 사이클에 걸쳐 field-clear(×) 관례를 갖췄는데, 귀속/카테고리 추가·수정의 이 네
 * 입력란만 같은 .add-inline/.field/.cat-edit-row 패턴이면서 빠져 있었다(app-evolve cycle148 develop). */
test('openCatManage: newCat(카테고리 추가 입력)도 다른 이름 입력란과 동일하게 field-clear(×) 버튼이 있다', () => {
  setupCatManageDB();
  sandbox.openCatManage('expense');
  const html = sandbox.lastSheetHtml;
  assert.ok(html.includes('<div class="field-clear"><input id="newCat"'), 'newCat 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(html.includes(`<button type="button" class="fc-x" aria-label="카테고리 이름 지우기" onclick="clrInput('newCat')">`), 'newCat에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});

/* ---------- openCatPicker: 카테고리명 onclick 문자열보간 인젝션 봉합 회귀 (app-evolve cycle82 advance) ----------
 * critique(cycle82)가 발견: openCatPicker()가 카테고리명 c를 표시 텍스트만 esc()로 감싸고
 * data-cat="${c}" 속성값과 onclick="pkPickCat('${c}')" 인라인 JS 인자에는 이스케이프 없이 그대로
 * 문자열보간했다. addCat()이 카테고리명 길이/문자 제한이 전혀 없어 따옴표를 포함한 이름을 넣으면
 * onclick 속성이 깨져 임의 JS가 실행되는 저장형 인젝션이었다. 고침: onclick 인라인 보간 자체를
 * 없애고 data-cat만 esc()로 감싼 뒤 위임 클릭으로 pkPickCat(b.dataset.cat)을 부르므로, 카테고리명
 * 내용과 무관하게 안전해야 한다. */
function setupCatPickerDB() {
  sandbox.DB = {
    categories: { expense: ['식비', '교통'], income: ['급여'], saving: ['적금'] },
    catIcon: {}, catVar: {},
  };
  sandbox.lastPickerHtml = null;
}
test('openCatPicker: 정상 카테고리명은 그대로 그려지고 onclick 문자열보간 없이 위임 클릭용 data-cat만 남는다', () => {
  setupCatPickerDB();
  sandbox.openCatPicker({ kind: 'expense', current: '교통', onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(html, 'openPicker가 호출돼야 함');
  assert.ok(html.includes('식비'));
  assert.ok(/class="pk-cat on" data-cat="교통"/.test(html), '현재 선택된 카테고리 버튼에 on 클래스가 붙어야 함');
  assert.ok(!html.includes('onclick="pkPickCat'), '개별 버튼에 onclick="pkPickCat(...)" 인라인 보간이 있으면 안 됨(위임 클릭으로 대체됨)');
});
test('openCatPicker: 카테고리명에 작은따옴표/세미콜론이 섞여 있어도 onclick 문자열보간이 없어 임의 JS를 만들 수 없다', () => {
  setupCatPickerDB();
  const evil = `x');fetch('//evil');//`;
  sandbox.DB.categories.expense = [evil];
  sandbox.openCatPicker({ kind: 'expense', onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(!html.includes('pkPickCat('), 'onclick="pkPickCat(...)" 인라인 보간이 재도입되면 안 됨 — 위임 클릭만 써야 함');
  assert.ok(!html.includes(`data-cat="${evil}"`), 'data-cat 속성값이 이스케이프 없이 그대로 꽂히면 안 됨');
  assert.ok(html.includes('data-cat="x&#39;)'), 'data-cat 속성값은 esc()로 이스케이프돼야 함');
});
test('openCatPicker: 카테고리명에 큰따옴표가 섞여 있어도 새 HTML 속성을 주입하지 못한다', () => {
  setupCatPickerDB();
  const evil = `식비" onmouseover="alert(1)`;
  sandbox.DB.categories.expense = [evil];
  sandbox.openCatPicker({ kind: 'expense', onPick: () => {} });
  const html = sandbox.lastPickerHtml;
  assert.ok(!html.includes('onmouseover="alert'), '큰따옴표가 이스케이프되지 않으면 data-cat 속성을 깨고 onmouseover 속성이 실제 따옴표로 새로 열려야 하는데, 이스케이프됐다면 그런 일이 없어야 함');
  assert.ok(html.includes('&quot;'), '큰따옴표는 &quot;로 이스케이프돼야 함');
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
/* 구분(지출/수입/이체/저축) 세그먼트가 class="on"만으로 선택 상태를 표시해 스크린리더가 어떤
 * 구분이 선택돼 있는지 전혀 알 수 없던 공백 — app-evolve cycle147 critique/advance, 세그먼트
 * 컨트롤 9곳에 aria-pressed 추가. */
test('renderTxSheet: 구분 세그먼트가 d.type과 일치하는 버튼에만 aria-pressed="true"를 준다', () => {
  setupTxSheetDB();
  sandbox.txDraft = { type: 'transfer', category: '이체', date: '2026-01-01', amount: 1000, fromAssetId: 'a1', toAssetId: 'a2', repeat: false };
  sandbox.renderTxSheet();
  const html = sandbox.lastSheetHtml;
  const buttons = [...html.matchAll(/<button class="([^"]*)" aria-pressed="(true|false)" onclick="txType\('(\w+)'\)">/g)];
  assert.strictEqual(buttons.length, 4, '지출/수입/이체/저축 네 개 구분 버튼이 렌더돼야 함');
  buttons.forEach(([, cls, pressed, v]) => {
    assert.strictEqual(cls === 'on', pressed === 'true', `${v} 버튼의 on 클래스(${cls})와 aria-pressed(${pressed})가 일치하지 않음`);
    assert.strictEqual(pressed === 'true', v === 'transfer', `d.type="transfer"일 때는 ${v} 버튼의 aria-pressed가 (${v === 'transfer'})이어야 함`);
  });
  assert.ok(/<div class="seg" role="group" aria-label="구분 선택">/.test(html), '구분 세그먼트 래퍼에 role="group"/aria-label이 없음');
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

/* ---------- planAsset/refreshPlanBody: 통장 전환 부분 갱신 (app-evolve cycle62 advance) ----------
 * planAsset()(통장 선택 시트에서 계좌를 바꿀 때)은 renderPlan() 전체를 다시 그려 page-plan을
 * 통째로 교체했다. ledgerToggleSel과 같은 결함으로, #planVP가 매번 새 DOM 노드가 돼
 * wireMonthCarousel()의 viewport._c 가드를 무력화하고 계좌를 바꿀 때마다 ResizeObserver/터치
 * 리스너가 누적된다. refreshPlanBody()는 #planVP 노드는 그대로 두고 그 안의 .mc-track과
 * 필터 라벨(.fv)·목록(.plan-list)만 갱신한다. renderPlan()과 달리 실제 DOM 트리(querySelector)를
 * 다루므로 renderLedger 스모크 테스트와 같은 방식으로 실행 기반으로 검증한다. */
// 아래 setupPlanDB()는 이 파일 뒤쪽(renderPlan 스모크 테스트)에 이미 정의돼 있고 함수 선언
// 호이스팅으로 그쪽이 최종 정의가 되므로(둘 다 최상위 function 선언 — 나중 선언이 이긴다),
// 여기서는 같은 이름을 새로 만들지 않고 그 정의 + 자산 2건 세팅을 각 테스트에서 직접 한다.
function setPlanTwoAssets() {
  sandbox.DB.owners = ['나'];
  sandbox.DB.assets = [
    { id: 'a1', name: '월급통장', owner: '나', type: 'cash', baseAmount: 500000, includeInTotal: true },
    { id: 'a2', name: '비상금통장', owner: '나', type: 'cash', baseAmount: 200000, includeInTotal: true },
  ];
}
// planVP는 실제 DOM이 아니라, refreshPlanBody()가 필요로 하는 최소 뼈대(자식 노드 3개:
// .filter-2 .fv, .mc-viewport > .mc-track, .plan-list)만 흉내내는 극소 querySelector 모형이다.
// renderPlan()이 innerHTML=...으로 이 뼈대를 만들고, refreshPlanBody()가 querySelector로
// 찾아 부분 갱신하는 실제 흐름을 그대로 재현해야 "#planVP 노드가 재사용되는지"를 검증할 수 있다.
function makePlanDom() {
  const fv = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
  const track = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
  const list = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
  let alignCalls = 0;
  const vp = { _c: true, _align: () => { alignCalls++; }, querySelector: (sel) => sel === '.mc-track' ? track : null };
  return {
    fv, track, list, vp,
    get alignCalls() { return alignCalls; },
    querySelector: (sel) => sel === '.filter-2 .fv' ? fv : sel === '.plan-list' ? list : null,
  };
}
test('refreshPlanBody: 통장을 바꾸면 #planVP 노드는 그대로 두고 트랙·라벨·목록만 갱신한다', () => {
  setupPlanDB();
  setPlanTwoAssets();
  sandbox.ST.plan.assetId = 'a1';
  const page = makePlanDom();
  const vpBefore = page.vp;
  const $orig = sandbox.$;
  sandbox.$ = (id) => id === 'page-plan' ? page : id === 'planVP' ? page.vp : $orig(id);
  try {
    sandbox.ST.plan.assetId = 'a2'; // planAsset()이 시트에서 통장을 바꾼 것과 동일한 상태 변화
    const ok = sandbox.refreshPlanBody();
    assert.strictEqual(ok, true);
    assert.strictEqual(page.vp, vpBefore, '#planVP DOM 노드 자체는 재사용돼야 함(wireMonthCarousel 재부착 방지)');
    assert.ok(page.fv.innerHTML.includes('비상금통장'), '필터 라벨이 새로 고른 통장 이름으로 갱신돼야 함');
    assert.ok(page.vp.querySelector('.mc-track').innerHTML.includes('비상금통장'), '캐러셀 트랙이 새 통장 기준 잔액 카드로 갱신돼야 함');
    assert.strictEqual(page.alignCalls > 0, true, '트랙 내용이 바뀌면 viewport._align()으로 재정렬해야 함');
  } finally {
    sandbox.$ = $orig;
  }
});
test('refreshPlanBody: #planVP를 못 찾으면(아직 렌더 전 등) false를 반환해 호출부가 전체 렌더로 폴백한다', () => {
  setupPlanDB();
  setPlanTwoAssets();
  // $('planVP')는 기본 $ 디스패처에서 처리하지 않는 id라 렌더 전처럼 그냥 null이 온다.
  assert.strictEqual(sandbox.refreshPlanBody(), false);
});
test('planAsset: 통장을 바꾸면 renderPlan() 전체 대신 refreshPlanBody()로 부분 갱신한다', () => {
  setupPlanDB();
  setPlanTwoAssets();
  sandbox.ST.plan.assetId = 'a1';
  const page = makePlanDom();
  const $orig = sandbox.$;
  sandbox.$ = (id) => id === 'page-plan' ? page : id === 'planVP' ? page.vp : $orig(id);
  try {
    sandbox.pagePlanEl._html = '이전 렌더 스냅샷';
    sandbox.planAsset('a2');
    assert.strictEqual(sandbox.ST.plan.assetId, 'a2');
    assert.strictEqual(sandbox.pagePlanEl.innerHTML, '이전 렌더 스냅샷', 'renderPlan() 전체가 다시 호출돼선 안 됨(page-plan이 그대로여야 함)');
    assert.ok(page.fv.innerHTML.includes('비상금통장'), 'refreshPlanBody()로 필터 라벨이 갱신돼야 함');
  } finally {
    sandbox.$ = $orig;
  }
});
test('planAsset: #planVP가 없으면(폴백) renderPlan()으로 전체를 다시 그린다', () => {
  setupPlanDB();
  setPlanTwoAssets();
  sandbox.ST.plan.assetId = 'a1';
  sandbox.pagePlanEl._html = '';
  sandbox.planAsset('a2'); // $('planVP')가 기본적으로 null이라 refreshPlanBody()가 false를 반환 → renderPlan() 폴백
  assert.ok(sandbox.pagePlanEl.innerHTML, '폴백 시 renderPlan()이 page-plan을 다시 채워야 함');
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
  // 복구 전 하드코딩된 `{ rec: () => null }`은 AUTH.signOut 같이 다른 테스트가 기대하는 메서드를
  // 영구히 지워버렸다(app-evolve cycle152 advance가 doLogout 실행형 테스트 추가 중 발견) — 원본을
  // 저장해 그대로 복원한다(위 renderLockView 테스트의 authOrig 패턴과 동일).
  const authOrig = sandbox.AUTH;
  sandbox.AUTH = { rec: () => ({ kakao: true, nick: '<b>닉네임</b>' }) };
  try {
    assert.strictEqual(sandbox.accountName(), '<b>닉네임</b>');
    assert.ok(sandbox.esc(sandbox.accountName()).includes('&lt;b&gt;'), 'esc()를 거치면 닉네임의 태그도 이스케이프돼야 함');
  } finally {
    sandbox.AUTH = authOrig;
  }
});

/* ---------- kakaoSyncLabel/openKakaoSwitchSheet: 카카오 로그인은 kakaoLogin()이 afterCloudAuth()/
 * CLOUD_UID 설정을 거치지 않아 100% 기기-로컬 저장인데, 메뉴/계정 화면에 그 사실이 전혀 드러나지
 * 않아 '로그인했으니 동기화되겠지'라는 합리적 기대가 깨지던 신뢰 문제 (app-evolve cycle154
 * critique가 발견, 같은 cycle advance가 고정 배지 + 전환 안내 시트로 고침) ---------- */
test('kakaoSyncLabel: 카카오 계정은 기기 간 동기화가 안 된다는 고정 문구를 반환한다', () => {
  const label = sandbox.kakaoSyncLabel();
  assert.ok(label.includes('이 기기'), '"이 기기"에만 저장된다는 문구가 없음');
  assert.ok(/동기화.*안|안.*동기화/.test(label), '동기화가 안 된다는 문구가 없음');
});
test('openKakaoSwitchSheet: 바로 로그아웃시키지 않고 내보내기부터 안내하는 시트를 연다', () => {
  sandbox.lastSheetHtml = null;
  sandbox.openKakaoSwitchSheet();
  assert.ok(sandbox.lastSheetHtml.includes('다른 기기와는 동기화되지 않아요'), '카카오가 동기화되지 않는다는 설명이 없음');
  assert.ok(sandbox.lastSheetHtml.includes('onclick="exportData()"'), '지금 내보내기 버튼이 exportData()로 연결돼 있지 않음 — 데이터가 사라진 것처럼 보일 위험');
  assert.ok(sandbox.lastSheetHtml.includes('onclick="closeSheet()"'), '취소(나중에) 버튼이 없음');
});
test('renderMenu: 카카오 계정은 계정 카드 부제에 kakaoSyncLabel()을 쓴다(동기화 안내 없이 "카카오 계정"만 보이면 안 됨)', () => {
  const body = extractFunction('renderMenu');
  assert.ok(body.includes("kind==='kakao'?kakaoSyncLabel()"), "renderMenu의 계정 카드가 kind==='kakao'일 때 kakaoSyncLabel()을 쓰지 않음");
});
test('openAccountSheet: 카카오 계정은 부제에 kakaoSyncLabel(), 이메일 전환 CTA를 보여준다', () => {
  const body = extractFunction('openAccountSheet');
  assert.ok(body.includes("kind==='kakao'?kakaoSyncLabel()"), "openAccountSheet의 계정 부제가 kind==='kakao'일 때 kakaoSyncLabel()을 쓰지 않음");
  assert.ok(body.includes("kind==='kakao'?`<button onclick=\"openKakaoSwitchSheet()\">"), '카카오 계정에 "이메일로 전환해 동기화하기" CTA가 없음');
});
test('renderAuth: 카카오 버튼 바로 아래에 Supabase 연결 여부와 무관하게 항상 동기화 미지원 캡션이 보인다', () => {
  const body = extractFunction('renderAuth');
  const btnIdx = body.indexOf('카카오로 시작하기');
  const capIdx = body.indexOf('기기 간 동기화는 이메일 로그인에서만 지원돼요');
  assert.ok(btnIdx !== -1 && capIdx !== -1 && capIdx > btnIdx, '카카오 버튼 아래에 동기화 미지원 캡션이 없음');
  // sbCfg().url 조건부(연결 여부에 따라 문구가 사라지던 기존 auth-note)와 달리, 이 캡션은
  // 그 삼항식 바깥에 독립된 리터럴 div로 있어야 한다 — sbCfg 조건 안에 있으면 다시 숨을 수 있음.
  const capLine = body.slice(body.lastIndexOf('\n', capIdx), body.indexOf('\n', capIdx) + 1);
  assert.ok(!capLine.includes('sbCfg()'), '캡션이 sbCfg() 조건부 삼항식 안에 있어 다시 숨겨질 수 있음');
});

/* ---------- togglePwVis: 비밀번호 입력칸(auPw/frPwIn/newPwIn)에 표시/숨기기 눈 아이콘 토글을
 * 추가 (app-evolve cycle155 develop가 발견 — 긴 비밀번호를 칠 때 특히 계정 복구(doLocalRecover)
 * 같은 한 번뿐인/고위험 플로우에서 타이핑한 내용을 확인할 길이 전혀 없어, 오타가 나면 자신이
 * 실제로 설정한 비밀번호를 영문 모르고 잠겨버릴 수 있었음). togglePwVis 자체는 closest()/type
 * 같은 실DOM 조작이라 이 테스트 스위트엔 jsdom이 없어 실행형으로 못 돌리므로(다른 openSheet류
 * 함수처럼), 소스 문자열 검증(정규식 기반)으로 로직과 각 렌더 함수의 배선을 확인한다. ---------- */
test('togglePwVis: password<->text를 뒤집고 버튼 아이콘/aria-label을 eye<->eyeOff로 맞춰 바꾼다', () => {
  const body = extractFunction('togglePwVis');
  assert.ok(/el\.type\s*=\s*show\s*\?\s*'text'\s*:\s*'password'/.test(body), "togglePwVis가 el.type을 'text'<->'password'로 뒤집지 않음");
  assert.ok(body.includes("svg(show?'eyeOff':'eye'"), 'togglePwVis가 아이콘을 eye<->eyeOff로 바꾸지 않음');
  assert.ok(body.includes("btn.setAttribute('aria-label'"), 'togglePwVis가 버튼의 aria-label을 갱신하지 않음 — 스크린리더가 토글 상태를 못 읽음');
});
for (const [fn, id] of [['renderAuth', 'auPw'], ['doForgotPasswordLocal', 'frPwIn'], ['openChangePasswordSheet', 'newPwIn']]) {
  test(`${fn}: ${id} 비밀번호 입력을 .pw-wrap으로 감싸고 눈 토글 버튼을 togglePwVis('${id}')에 연결한다`, () => {
    const body = extractFunction(fn);
    assert.ok(body.includes(`id="${id}" type="password"`), `${fn}에 id="${id}" type="password" 입력이 없음`);
    const wrapIdx = body.indexOf('class="pw-wrap"');
    const inputIdx = body.indexOf(`id="${id}"`);
    assert.ok(wrapIdx !== -1 && wrapIdx < inputIdx, `${id} 입력이 .pw-wrap 안에 있지 않음`);
    assert.ok(body.includes(`togglePwVis('${id}')`), `${fn}에 togglePwVis('${id}')로 연결된 버튼이 없음`);
  });
}

/* ---------- App-Lock PIN 입력 7곳(lockPinIn/pinNewIn/pinNewIn2/pinOffIn/pinChgCurIn/pinChgNewIn/
 * pinChgNewIn2)에도 togglePwVis 눈 아이콘 토글 추가 (app-evolve cycle159 advance — cycle155가
 * auPw/frPwIn/newPwIn/fpinPwIn 비밀번호 입력에만 적용하고 App-Lock PIN 입력은 범위 밖으로 뺐던
 * 공백. 특히 lockPinIn은 확인 입력도 없는 단일 필드라 오타를 쳐도 확인할 길이 없어 AUTH._lockStatus
 * 지수 백오프 잠금을 거쳐 cycle155가 일부러 무겁게 만든 openForgotPinSheet/doForgotPin 복구
 * 플로우로 떨어질 위험이 있었음. 각 함수가 PIN 입력을 둘 이상 갖고 있어(renderAuth류와 달리)
 * body.indexOf 단일 탐색 대신, pw-wrap과 input이 바로 붙어있는지를 각 id별로 직접 확인한다. ---------- */
for (const [fn, id] of [
  ['renderLockView', 'lockPinIn'],
  ['openSetPinSheet', 'pinNewIn'],
  ['openSetPinSheet', 'pinNewIn2'],
  ['openDisableAppLockSheet', 'pinOffIn'],
  ['openChangePinSheet', 'pinChgCurIn'],
  ['openChangePinSheet', 'pinChgNewIn'],
  ['openChangePinSheet', 'pinChgNewIn2'],
]) {
  test(`${fn}: ${id} PIN 입력을 .pw-wrap으로 감싸고 눈 토글 버튼을 togglePwVis('${id}')에 연결한다`, () => {
    const body = extractFunction(fn);
    assert.ok(
      new RegExp(`class="pw-wrap"><input id="${id}" type="password"`).test(body),
      `${fn}의 ${id} 입력이 .pw-wrap으로 바로 감싸여 있지 않음`
    );
    assert.ok(body.includes(`togglePwVis('${id}')`), `${fn}에 togglePwVis('${id}')로 연결된 버튼이 없음`);
  });
}

/* ---------- renderAuth: auEmail/kkeyIn도 field-clear(×) 관례를 따름
 * (app-evolve cycle158 develop — 다른 텍스트 입력란은 전부 field-clear(×) 버튼을 갖췄는데,
 * auth 메인 화면(renderAuth)의 auEmail/kkeyIn만 openSheet()가 아닌 별도 화면이라 cycle154
 * critique 때 범위 밖(별도 CSS·수동 fcWire 배선 필요)으로 백로그에 남아 있었음. histQ(renderHistory)가
 * 이미 쓰던 것과 동일한 패턴 — .field-clear+fc-x로 감싸고 renderAuth()가 직접 fcWire()를
 * 호출 — 을 그대로 적용했다. ---------- */
test('renderAuth: auEmail도 다른 텍스트 입력란과 동일하게 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('renderAuth');
  assert.ok(body.includes('<div class="field-clear"><input id="auEmail"'), 'auEmail 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="이메일 지우기" onclick="clrInput('auEmail')">`), 'auEmail에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('renderAuth: kkeyIn(카카오 JavaScript 키 입력)도 동일하게 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('renderAuth');
  assert.ok(body.includes('<div class="field-clear"><input id="kkeyIn"'), 'kkeyIn 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="카카오 JavaScript 키 지우기" onclick="clrInput('kkeyIn')">`), 'kkeyIn에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('renderAuth: 함수 본문이 fcWire()를 호출해 auEmail/kkeyIn의 지우기 버튼을 실제로 배선한다(시트가 아닌 별도 화면이라 openSheet()의 자동 배선을 못 타므로 직접 호출해야 함)', () => {
  const body = extractFunction('renderAuth');
  assert.ok(/fcWire\(\)/.test(body), 'renderAuth()가 fcWire()를 호출하지 않음');
});

/* ---------- dbIsEmpty:로그인 시 게스트 데이터 자동 병합/안내 판단에 쓰이는 순수 함수
 * (app-evolve cycle63 critique/advance — doLogin()이 기존 계정 데이터를 게스트 데이터로
 * 조용히 덮어쓰거나 반대로 게스트 데이터를 안내 없이 버리지 않도록, "이 계정이 비어 있는가"를
 * 판정하는 로직을 emptyDB()와 나란히 두고 테스트한다) ---------- */
test('dbIsEmpty: assets/txns가 모두 비어있으면 true', () => {
  assert.strictEqual(sandbox.dbIsEmpty({ assets: [], txns: [] }), true);
});
test('dbIsEmpty: assets나 txns 중 하나라도 항목이 있으면 false', () => {
  assert.strictEqual(sandbox.dbIsEmpty({ assets: [{ id: 'a1' }], txns: [] }), false);
  assert.strictEqual(sandbox.dbIsEmpty({ assets: [], txns: [{ id: 't1' }] }), false);
});
test('dbIsEmpty: db 자체가 없거나 필드가 비정상이어도 예외 없이 true를 반환한다', () => {
  assert.strictEqual(sandbox.dbIsEmpty(null), true);
  assert.strictEqual(sandbox.dbIsEmpty({}), true);
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
test('renderAssets: 편집 모드(ST.editAssets)에서는 드래그용 그룹 목록이 렌더되고, assetSort가 custom이면 그룹 헤더 아래 개별 자산 위/아래 버튼도 함께 렌더된다(app-evolve cycle134 advance 전에는 그룹만 나왔음)', () => {
  setupAssetsDB(); // setupAssetsDB()는 assetSort:'custom'
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '비상금', owner: '나', type: 'cash', order: 1, includeInTotal: true, baseAmount: 100000 },
  ];
  sandbox.ST.editAssets = true;
  sandbox.renderAssets();
  const html = sandbox.pageAssetsEl.innerHTML;
  assert.ok(html.includes('id="dragList"'), '편집 모드에서는 그룹 순서 드래그 목록이 렌더돼야 함');
  assert.ok(html.includes('2개 자산'), '그룹별 자산 개수가 렌더돼야 함');
  assert.ok(html.includes('주계좌') && html.includes('비상금'), 'custom 정렬에서는 그룹 안 개별 자산 이름도 나와야 함');
  assert.ok(html.includes("onclick=\"moveAsset('a1',1)\""), '첫 자산은 아래로 이동 버튼이 있어야 함');
  assert.ok(html.includes("onclick=\"moveAsset('a2',-1)\""), '둘째 자산은 위로 이동 버튼이 있어야 함');
  const firstUpBtn = html.indexOf("moveAsset('a1',-1)");
  const lastDnBtn = html.indexOf("moveAsset('a2',1)");
  assert.ok(html.slice(firstUpBtn, firstUpBtn + 40).includes('disabled'), '그룹 안 첫 자산의 위로 버튼은 disabled여야 함');
  assert.ok(html.slice(lastDnBtn, lastDnBtn + 40).includes('disabled'), '그룹 안 마지막 자산의 아래로 버튼은 disabled여야 함');
});
test('renderAssets: 편집 모드에서 그룹 안에 "총자산 미포함" 자산이 섞여 있으면, 포함/미포함 경계를 넘는 위/아래 버튼도 양끝처럼 disabled여야 한다(groupItems()가 order 정렬 뒤 includeInTotal로 다시 안정정렬해 경계를 못 넘으므로, 안 그러면 눌러도 화면이 그대로인 죽은 버튼이 된다 — app-evolve cycle139 develop)', () => {
  setupAssetsDB(); // setupAssetsDB()는 assetSort:'custom'
  sandbox.DB.assets = [
    { id: 'a1', name: '포함1', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '포함2', owner: '나', type: 'cash', order: 1, includeInTotal: true, baseAmount: 100000 },
    { id: 'a3', name: '미포함1', owner: '나', type: 'cash', order: 2, includeInTotal: false, baseAmount: 10000 },
    { id: 'a4', name: '미포함2', owner: '나', type: 'cash', order: 3, includeInTotal: false, baseAmount: 20000 },
  ];
  sandbox.ST.editAssets = true;
  sandbox.renderAssets();
  const html = sandbox.pageAssetsEl.innerHTML;
  const dnA2 = html.indexOf("moveAsset('a2',1)"); // 포함 쪽 마지막 → 경계를 넘어가므로 disabled여야 함
  const upA3 = html.indexOf("moveAsset('a3',-1)"); // 미포함 쪽 첫 → 경계를 넘어가므로 disabled여야 함
  const upA1 = html.indexOf("moveAsset('a1',-1)"); // 그룹 절대 맨 위 → 기존 양끝 규칙으로 disabled
  const dnA4 = html.indexOf("moveAsset('a4',1)"); // 그룹 절대 맨 아래 → 기존 양끝 규칙으로 disabled
  const dnA1 = html.indexOf("moveAsset('a1',1)"); // 포함1→포함2는 경계 안 → 그대로 활성
  const upA4 = html.indexOf("moveAsset('a4',-1)"); // 미포함2→미포함1은 경계 안 → 그대로 활성
  assert.ok(html.slice(dnA2, dnA2 + 40).includes('disabled'), '포함 쪽 마지막(a2) 아래로 버튼은 disabled여야 함');
  assert.ok(html.slice(upA3, upA3 + 40).includes('disabled'), '미포함 쪽 첫(a3) 위로 버튼은 disabled여야 함');
  assert.ok(html.slice(upA1, upA1 + 40).includes('disabled'), '그룹 절대 맨 위(a1) 위로 버튼은 disabled여야 함');
  assert.ok(html.slice(dnA4, dnA4 + 40).includes('disabled'), '그룹 절대 맨 아래(a4) 아래로 버튼은 disabled여야 함');
  assert.ok(!html.slice(dnA1, dnA1 + 40).includes('disabled'), '포함1→포함2(경계 안)는 활성 상태여야 함');
  assert.ok(!html.slice(upA4, upA4 + 40).includes('disabled'), '미포함2→미포함1(경계 안)은 활성 상태여야 함');
});
test('renderAssets: 편집 모드에서 assetSort가 custom이 아니면(예: amount) 그룹 내 개별 자산 버튼은 렌더되지 않는다(a.order가 화면에 반영 안 돼 버튼이 무의미하므로)', () => {
  setupAssetsDB();
  sandbox.DB.settings.assetSort = 'amount';
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.editAssets = true;
  sandbox.renderAssets();
  const html = sandbox.pageAssetsEl.innerHTML;
  assert.ok(html.includes('id="dragList"'));
  assert.ok(!html.includes('주계좌'), 'custom이 아니면 개별 자산 이름/버튼이 나오지 않아야 함');
  assert.ok(!html.includes('asset-sub-list'));
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

/* ---------- assetSelPartial/assetToggleSel/assetSelAll: 다중선택 부분 갱신 (app-evolve cycle64 develop) ----------
 * assetToggleSel()/assetSelAll()은 체크박스를 탭할 때마다 renderAssets() 전체를 다시 그려
 * page-assets를 통째로 교체했다. ledgerToggleSel()이 고치기 전(cycle62) 겪던 것과 같은 결함으로,
 * 순자산 캐러셀(#nwCarousel)·히스토리 차트까지 체크박스를 탭할 때마다 다시 그리고, 방금 탭한
 * 자산 행의 tabindex 노드가 파괴돼 키보드(Enter/Space)로 토글하면 포커스가 body로 빠진다.
 * assetSelPartial()은 #assetBody만 갱신해 이 문제를 피하므로, 두 함수가 renderAssets() 대신
 * 이걸 먼저 쓰는지 확인한다(ledgerSelPartial 회귀 테스트와 동일한 구조). */
test('assetSelPartial: #assetBody가 있으면 현재 선택 상태로 그 목록만 갱신하고 true를 반환한다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.aSel = { mode: true, ids: new Set(['a1']) };
  sandbox.assetBodyEl._html = '';
  sandbox.pageAssetsEl._html = '이전 렌더 스냅샷'; // 부분 갱신이면 이 값이 그대로 남아있어야 함
  sandbox.updateSelBottomCalls = 0;
  const ok = sandbox.assetSelPartial();
  assert.strictEqual(ok, true, 'assetBody가 있으면 true를 반환해야 함');
  assert.ok(sandbox.assetBodyEl.innerHTML.includes('sel-on'), '선택된 자산 행에 sel-on 클래스가 반영돼야 함');
  assert.strictEqual(sandbox.pageAssetsEl.innerHTML, '이전 렌더 스냅샷', 'renderAssets() 전체가 다시 호출돼선 안 됨(page-assets가 그대로여야 함)');
  assert.strictEqual(sandbox.updateSelBottomCalls, 1, '선택 개수 바(하단 바)도 함께 갱신돼야 함');
});
test('assetSelPartial: #assetBody를 못 찾으면(아직 렌더 전 등) false를 반환해 호출부가 전체 렌더로 폴백한다', () => {
  setupAssetsDB();
  sandbox.assetBodyMissing = true;
  try {
    assert.strictEqual(sandbox.assetSelPartial(), false);
  } finally {
    sandbox.assetBodyMissing = false;
  }
});
test('assetToggleSel: 다중선택 중 항목을 탭해도 renderAssets() 전체를 다시 그리지 않는다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.aSel = { mode: true, ids: new Set() };
  sandbox.pageAssetsEl._html = '이전 렌더 스냅샷';
  sandbox.assetToggleSel('a1');
  assert.ok(sandbox.ST.aSel.ids.has('a1'), 'a1이 선택 목록에 추가돼야 함');
  assert.strictEqual(sandbox.pageAssetsEl.innerHTML, '이전 렌더 스냅샷', 'renderAssets() 전체가 다시 호출돼선 안 됨');
  assert.ok(sandbox.assetBodyEl.innerHTML.includes('sel-on'), 'assetBody가 새 선택 상태로 갱신돼야 함');
});
test('assetToggleSel: 같은 항목을 다시 탭하면 선택이 해제된다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.aSel = { mode: true, ids: new Set(['a1']) };
  sandbox.assetToggleSel('a1');
  assert.ok(!sandbox.ST.aSel.ids.has('a1'), 'a1이 선택 목록에서 제거돼야 함');
  assert.ok(!sandbox.assetBodyEl.innerHTML.includes('sel-on'), '선택 해제 후에는 sel-on 클래스가 없어야 함');
});
test('assetToggleSel: #assetBody가 없으면(폴백) renderAssets()로 전체를 다시 그린다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.aSel = { mode: true, ids: new Set() };
  sandbox.assetBodyMissing = true;
  try {
    sandbox.pageAssetsEl._html = '';
    sandbox.assetToggleSel('a1');
    assert.ok(sandbox.pageAssetsEl.innerHTML, '폴백 시 renderAssets()가 page-assets를 다시 채워야 함');
  } finally {
    sandbox.assetBodyMissing = false;
  }
});
test('assetSelAll: 전체선택 토글도 renderAssets() 전체를 다시 그리지 않는다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '적금', owner: '나', type: 'savings', order: 1, includeInTotal: true, baseAmount: 300000 },
  ];
  sandbox.ST.aSel = { mode: true, ids: new Set() };
  sandbox.pageAssetsEl._html = '이전 렌더 스냅샷';
  sandbox.assetSelAll();
  assert.strictEqual(sandbox.ST.aSel.ids.size, 2, '전체선택 시 두 건 모두 선택돼야 함');
  assert.strictEqual(sandbox.pageAssetsEl.innerHTML, '이전 렌더 스냅샷', 'renderAssets() 전체가 다시 호출돼선 안 됨');
});
test('assetSelAll: 이미 전체선택된 상태에서 다시 부르면 전체 해제된다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 }];
  sandbox.ST.aSel = { mode: true, ids: new Set(['a1']) };
  sandbox.assetSelAll();
  assert.strictEqual(sandbox.ST.aSel.ids.size, 0, '전체선택 상태에서 다시 부르면 선택이 모두 해제돼야 함');
});

/* ---------- assetSelAll/activeSel: 귀속 필터가 켜져 있으면 화면에 보이는 자산만 전체선택 대상이어야 함
 * (app-evolve cycle68 develop) ----------
 * assetSelAll()이 ST.assetOwner 귀속 필터를 무시하고 DB.assets 전체를 선택 대상으로 삼고 있었다.
 * assetBodyHTML()은 귀속 필터가 켜지면 다른 귀속의 자산을 아예 렌더하지 않는데(2575행), "전체 선택"을
 * 누르면 화면에 보이지도 않는 다른 귀속의 자산 id까지 ST.aSel.ids에 담겨 "선택 삭제"로 함께
 * 지워질 수 있었다(ledgerSelAll/histSelAll은 이미 각자의 필터링된 목록만 대상으로 삼고 있어 자산 탭만
 * 예외였다). visibleAssetsForSel()로 assetSelAll()과 activeSel()의 total을 모두 귀속 필터에 맞춰
 * 스코프했는지 확인한다. */
test('visibleAssetsForSel: 귀속 필터가 all이면 전체 자산을 그대로 반환한다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '아이통장', owner: '아이', type: 'cash', order: 1, includeInTotal: true, baseAmount: 100000 },
  ];
  sandbox.ST.assetOwner = 'all';
  assert.strictEqual(sandbox.visibleAssetsForSel().length, 2, '전체 필터에서는 모든 귀속의 자산이 대상이어야 함');
});
test('visibleAssetsForSel: 귀속 필터가 켜져 있으면 그 귀속의 자산만 반환한다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '아이통장', owner: '아이', type: 'cash', order: 1, includeInTotal: true, baseAmount: 100000 },
  ];
  sandbox.ST.assetOwner = '나';
  const ids = sandbox.visibleAssetsForSel().map(a => a.id);
  assert.deepStrictEqual(ids, ['a1'], '필터된 귀속의 자산 id만 반환해야 함');
});
test('assetSelAll: 귀속 필터가 켜져 있으면 다른 귀속의 자산은 선택 대상에서 제외된다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '아이통장', owner: '아이', type: 'cash', order: 1, includeInTotal: true, baseAmount: 100000 },
  ];
  sandbox.ST.assetOwner = '나';
  sandbox.ST.aSel = { mode: true, ids: new Set() };
  sandbox.assetSelAll();
  assert.deepStrictEqual([...sandbox.ST.aSel.ids], ['a1'], '화면에 보이지 않는 다른 귀속(아이)의 자산은 전체선택에 포함되면 안 됨');
});
test('assetSelAll: 필터된 귀속이 이미 전체선택된 상태에서 다시 부르면 그 귀속만 해제된다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '아이통장', owner: '아이', type: 'cash', order: 1, includeInTotal: true, baseAmount: 100000 },
  ];
  sandbox.ST.assetOwner = '나';
  sandbox.ST.aSel = { mode: true, ids: new Set(['a1']) };
  sandbox.assetSelAll();
  assert.strictEqual(sandbox.ST.aSel.ids.size, 0, '필터된 귀속이 이미 전체선택 상태면 전체 해제돼야 함');
});
test('activeSel: 귀속 필터가 켜져 있으면 자산 선택 total도 필터된 개수를 반영한다', () => {
  setupAssetsDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', order: 0, includeInTotal: true, baseAmount: 500000 },
    { id: 'a2', name: '아이통장', owner: '아이', type: 'cash', order: 1, includeInTotal: true, baseAmount: 100000 },
  ];
  sandbox.ST.assetOwner = '나';
  sandbox.ST.aSel = { mode: true, ids: new Set(['a1']) };
  const s = sandbox.activeSel();
  assert.strictEqual(s.total, 1, '하단 바의 total이 DB.assets 전체가 아니라 필터된 자산 개수여야 함');
});
test('activeSel: 자산목록 선택모드(aSel)엔 일괄 카테고리 변경 버튼(cat)이 없다(자산엔 카테고리 개념이 없음, app-evolve cycle136 advance)', () => {
  setupAssetsDB();
  sandbox.ST.aSel = { mode: true, ids: new Set() };
  const s = sandbox.activeSel();
  assert.strictEqual(s.cat, undefined);
});
test('activeSel: 일별거래 선택모드(lSel)엔 일괄 카테고리 변경 버튼(cat)이 있다(app-evolve cycle136 advance)', () => {
  setupLedgerDB();
  sandbox.ST.aSel = { mode: false, ids: new Set() }; // activeSel()이 aSel.mode를 먼저 확인하므로 있어야 함
  sandbox.ST.lSel = { mode: true, ids: new Set() };
  const s = sandbox.activeSel();
  assert.strictEqual(s.cat, 'ledgerCatSel()');
});
test('activeSel: 전체내역 선택모드(hist.selMode)엔 일괄 카테고리 변경 버튼(cat)이 있다(app-evolve cycle136 advance)', () => {
  setupHistoryDB();
  sandbox.ST.aSel = { mode: false, ids: new Set() };
  sandbox.ST.lSel = { mode: false, ids: new Set() };
  sandbox.ST.hist.selMode = true;
  const s = sandbox.activeSel();
  assert.strictEqual(s.cat, 'histCatSel()');
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
/* modeSeg는 달력/검색 전환을 위한 순수 문자열 빌더(.mseg)로, "on" 클래스만 있고 aria-pressed/role이
 * 없어 스크린리더가 현재 달력/검색 중 뭐가 선택돼 있는지 알 수 없던 공백이었다
 * (app-evolve cycle147 critique/advance, 세그먼트 컨트롤 9곳에 aria-pressed 추가). */
test('modeSeg: 탭에 맞는 버튼에만 on 클래스와 aria-pressed="true"가 붙고, 래퍼에 role/aria-label이 있다', () => {
  sandbox.ST = { hist: { cat: '전체', q: '', assetId: null } };
  const cal = sandbox.modeSeg('ledger');
  assert.ok(/class="on" aria-pressed="true"[^>]*>달력/.test(cal), 'ledger 탭이면 달력 버튼이 on+aria-pressed=true여야 함');
  assert.ok(/class="" aria-pressed="false"[^>]*>검색/.test(cal), 'ledger 탭이면 검색 버튼이 aria-pressed=false여야 함');
  const list = sandbox.modeSeg('history');
  assert.ok(/class="" aria-pressed="false"[^>]*>달력/.test(list), 'history 탭이면 달력 버튼이 aria-pressed=false여야 함');
  assert.ok(/class="on" aria-pressed="true"[^>]*>검색/.test(list), 'history 탭이면 검색 버튼이 on+aria-pressed=true여야 함');
  assert.ok(cal.includes('role="group" aria-label="보기 방식 선택"'), 'mseg 래퍼에 role="group"/aria-label이 없음');
});
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

/* ---------- ledSumBox/ledSumInner/ledSumTap: 가계부 요약 카드 탭 → 전체내역 이동 (app-evolve cycle116 develop) ----------
 * sumTap(kind)은 예전부터 구현돼 있었지만("요약 탭 → 전체내역") 가계부 수지/수입/지출/저축/내부이체
 * 카드의 버튼 어디에도 onclick으로 배선된 적이 없어, 눌러도 아무 반응 없는 죽은 버튼이었다. 이제
 * ledSumBox()가 ledSumInner(...,tap=true)로 호출해 각 버튼이 ledSumTap(kind)로 이어지는지,
 * 그리고 전체내역(history) 탭 자신의 합계 카드(histTotBox → tap 인자 생략)는 여전히 배선되지
 * 않는지(ST.ledger 기준 범위 리셋이 현재 보고 있는 범위와 어긋나는 걸 피하기 위한 의도적 설계)를
 * 확인한다. */
test('ledSumBox: 가계부 카드의 수지/수입/지출/저축/내부이체 버튼이 ledSumTap으로 배선된다', () => {
  setupLedgerDB();
  const html = sandbox.ledSumBox(2026, 6, true);
  ['전체', '수입', '지출', '저축', '이체'].forEach((k) => {
    assert.ok(html.includes(`onclick="ledSumTap('${k}')"`), `${k} 버튼에 ledSumTap('${k}') 배선이 있어야 함`);
  });
});
test('ledSumBox: 좌우 미리보기 패널(live=false)도 동일하게 배선된다(카드 자체는 pointer-events:none으로만 막힘)', () => {
  setupLedgerDB();
  const html = sandbox.ledSumBox(2026, 6, false);
  assert.ok(html.includes("onclick=\"ledSumTap('수입')\""));
  assert.ok(html.includes('pointer-events:none'));
});
test('ledSumInner: tap 인자를 생략하면(전체내역 탭 자신의 합계 카드) onclick이 전혀 없다', () => {
  const a = { income: 1000, expense: 500, saving: 0, transfer: 0, suji: 500 };
  const sc = { income: 0, expense: 0, saving: 0, transfer: 0, suji: 0 };
  const html = sandbox.ledSumInner(a, sc, false);
  assert.ok(!html.includes('ledSumTap'), 'tap을 넘기지 않으면 ledSumTap 배선이 없어야 함');
});
test('ledSumTap: 롱프레스로 "오늘까지" 미리보기를 했던 직후의 릴리즈 클릭 한 번은 sumTap을 삼킨다', () => {
  const orig = sandbox.sumTap;
  const calls = [];
  sandbox.sumTap = (k) => calls.push(k);
  try {
    sandbox._sujiPeeked = true;
    sandbox.ledSumTap('수입');
    assert.strictEqual(calls.length, 0, '롱프레스 직후 릴리즈 클릭은 전체내역으로 이동시키면 안 됨');
    assert.strictEqual(sandbox._sujiPeeked, false, '한 번 삼킨 뒤에는 플래그가 풀려야 다음 탭을 막지 않음');
    sandbox.ledSumTap('수입');
    assert.deepStrictEqual(calls, ['수입'], '플래그가 풀린 다음 탭은 정상적으로 sumTap을 불러야 함');
  } finally {
    sandbox.sumTap = orig;
    sandbox._sujiPeeked = false;
  }
});
test('ledSumTap: 평소(롱프레스 없이 가볍게 탭)에는 매번 그대로 sumTap을 부른다', () => {
  const orig = sandbox.sumTap;
  const calls = [];
  sandbox.sumTap = (k) => calls.push(k);
  try {
    sandbox._sujiPeeked = false;
    sandbox.ledSumTap('지출');
    sandbox.ledSumTap('저축');
    assert.deepStrictEqual(calls, ['지출', '저축']);
  } finally {
    sandbox.sumTap = orig;
  }
});

/* ---------- ledgerSelPartial/ledgerToggleSel/ledgerSelAll: 다중선택 부분 갱신 (app-evolve cycle62 advance) ----------
 * ledgerToggleSel()/ledgerSelAll()은 체크박스를 탭할 때마다 renderLedger() 전체를 다시 그려
 * page-ledger를 통째로 교체했다. selDay()가 selDayPartial()로 우회한 것과 같은 결함으로,
 * #ledgerVP가 매번 새 DOM 노드가 돼 wireMonthCarousel()의 viewport._c 가드를 무력화하고
 * ResizeObserver/터치 리스너가 탭마다 누적된다. ledgerSelPartial()은 #ledgerCard 행만
 * 갱신해 이 문제를 피하므로, 두 함수가 renderLedger() 대신 이걸 먼저 쓰는지 확인한다. */
test('ledgerSelPartial: #ledgerCard가 있으면 현재 선택 상태로 그 행만 갱신하고 true를 반환한다', () => {
  setupLedgerDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-15', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' }];
  sandbox.ST.lSel = { mode: true, ids: new Set(['t1']) };
  sandbox.pageLedgerEl._html = '이전 렌더 스냅샷'; // 부분 갱신이면 이 값이 그대로 남아있어야 함
  const ok = sandbox.ledgerSelPartial();
  assert.strictEqual(ok, true, 'ledgerCard가 있으면 true를 반환해야 함');
  assert.ok(sandbox.ledgerCardEl.innerHTML.includes('sel-on'), '선택된 행에 sel-on 클래스가 반영돼야 함');
  assert.strictEqual(sandbox.pageLedgerEl.innerHTML, '이전 렌더 스냅샷', 'renderLedger() 전체가 다시 호출돼선 안 됨(page-ledger가 그대로여야 함)');
});
test('ledgerSelPartial: #ledgerCard를 못 찾으면(아직 렌더 전 등) false를 반환해 호출부가 전체 렌더로 폴백한다', () => {
  setupLedgerDB();
  sandbox.ledgerCardMissing = true;
  try {
    assert.strictEqual(sandbox.ledgerSelPartial(), false);
  } finally {
    sandbox.ledgerCardMissing = false;
  }
});
test('ledgerToggleSel: 다중선택 중 항목을 탭해도 renderLedger() 전체를 다시 그리지 않는다', () => {
  setupLedgerDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-15', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' }];
  sandbox.ST.lSel = { mode: true, ids: new Set() };
  sandbox.pageLedgerEl._html = '이전 렌더 스냅샷';
  sandbox.ledgerToggleSel('t1');
  assert.ok(sandbox.ST.lSel.ids.has('t1'), 't1이 선택 목록에 추가돼야 함');
  assert.strictEqual(sandbox.pageLedgerEl.innerHTML, '이전 렌더 스냅샷', 'renderLedger() 전체가 다시 호출돼선 안 됨');
  assert.ok(sandbox.ledgerCardEl.innerHTML.includes('sel-on'), 'ledgerCard가 새 선택 상태로 갱신돼야 함');
});
test('ledgerToggleSel: #ledgerCard가 없으면(폴백) renderLedger()로 전체를 다시 그린다', () => {
  setupLedgerDB();
  sandbox.DB.txns = [{ id: 't1', date: '2026-06-15', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' }];
  sandbox.ST.lSel = { mode: true, ids: new Set() };
  sandbox.ledgerCardMissing = true;
  try {
    sandbox.pageLedgerEl._html = '';
    sandbox.ledgerToggleSel('t1');
    assert.ok(sandbox.pageLedgerEl.innerHTML, '폴백 시 renderLedger()가 page-ledger를 다시 채워야 함');
  } finally {
    sandbox.ledgerCardMissing = false;
  }
});
test('ledgerSelAll: 전체선택 토글도 renderLedger() 전체를 다시 그리지 않는다', () => {
  setupLedgerDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 500000 }];
  sandbox.DB.txns = [
    { id: 't1', date: '2026-06-15', type: 'expense', category: '식비', memo: '점심', amount: 8000, fromAssetId: 'a1' },
    { id: 't2', date: '2026-06-15', type: 'expense', category: '식비', memo: '저녁', amount: 12000, fromAssetId: 'a1' },
  ];
  sandbox.ST.lSel = { mode: true, ids: new Set() };
  sandbox.pageLedgerEl._html = '이전 렌더 스냅샷';
  sandbox.ledgerSelAll();
  assert.strictEqual(sandbox.ST.lSel.ids.size, 2, '전체선택 시 두 건 모두 선택돼야 함');
  assert.strictEqual(sandbox.pageLedgerEl.innerHTML, '이전 렌더 스냅샷', 'renderLedger() 전체가 다시 호출돼선 안 됨');
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
      cat: '전체', q: '', assetId: null, catExact: null, owner: '전체', selMode: false, sel: new Set(), sortAsc: false,
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
  assert.ok(html.includes('메모·카테고리·자산·금액 검색'), '전체 내역 탭 검색바가 렌더돼야 함');
  assert.ok(sandbox.histListEl.innerHTML.includes('이 기간에는 내역이 없어요'), '내역이 없으면 빈 상태 안내가 나와야 함');
});
/* app-evolve cycle149 develop: histQ(전체내역 검색창)는 txAmt/budgetIn/newOwner 등 다른 텍스트
 * 입력란과 달리 시트가 아니라 메인 탭 화면에 있어, openSheet()가 매번 호출해주는 fcWire() 자동
 * 배선(5952행)을 타지 못해 field-clear(×) 버튼 관례에서 혼자 빠져 있었다 — renderHistory()가
 * 직접 fcWire()를 호출하도록 고치고(아래 두 번째 테스트) histQ를 다른 입력란과 같은
 * .field-clear+fc-x 구조로 감쌌다(이 테스트). */
test('renderHistory: histQ(검색창)도 다른 텍스트 입력란과 동일하게 field-clear(×) 버튼이 있다', () => {
  setupHistoryDB();
  sandbox.renderHistory();
  const html = sandbox.pageHistoryEl.innerHTML;
  assert.ok(html.includes('<div class="field-clear"><input id="histQ"'), 'histQ 입력이 field-clear로 감싸져 있지 않음');
  assert.ok(html.includes(`<button type="button" class="fc-x" aria-label="검색어 지우기" onclick="clrInput('histQ')">`), 'histQ에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('renderHistory: 함수 본문이 fcWire()를 호출해 histQ의 지우기 버튼을 실제로 배선한다(시트가 아닌 탭 화면이라 openSheet()의 자동 배선을 못 타므로 직접 호출해야 함)', () => {
  const body = extractFunction('renderHistory');
  assert.ok(/fcWire\(\)/.test(body), 'renderHistory()가 fcWire()를 호출하지 않음');
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
  assert.ok(!sandbox.pageHistoryEl.innerHTML.includes('메모·카테고리·자산·금액 검색'), '멀티셀렉트 모드에서는 검색바가 숨겨져야 함');
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
/* app-evolve cycle65 develop: DB.settings.histSortAsc는 기본값도, 기존 사용자 1회 마이그레이션(_sortV2)도
 * 둘 다 true(오름차순)라 사실상 전체 사용자가 이 상태였는데, updateHist()의 페이징이 actual.slice(0,shown)
 * 으로 배열 앞(오름차순이면 가장 오래된 기록)부터 잘랐다. 날짜 그룹 렌더(groupHTML)는 항상 최신순 고정이라
 * "더보기"를 눌러야만 최근 내역에 닿는 역전이 생겼음 — sortAsc일 때는 배열 뒤(최신 쪽)에서 잘라야 한다. */
test('updateHist: sortAsc(오름차순) 상태에서도 첫 페이지는 가장 최근 내역부터 채워진다(app-evolve cycle65)', () => {
  setupHistoryDB();
  sandbox.ST.hist.sortAsc = true;
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 1000000 }];
  sandbox.DB.txns = Array.from({ length: 25 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return { id: 't' + day, date: `2026-05-${day}`, type: 'expense', category: '식비', memo: 'd' + day, amount: 1000 + i, fromAssetId: 'a1' };
  });
  sandbox.renderHistory();
  const listHtml = sandbox.histListEl.innerHTML;
  assert.ok(listHtml.includes('d25'), '첫 페이지에 가장 최근 내역(5/25)이 보여야 함');
  assert.ok(listHtml.includes('d06'), '20건짜리 첫 페이지는 5/06까지 포함돼야 함(최근 20건)');
  assert.ok(!listHtml.includes('d05'), '가장 오래된 5건(5/01~5/05)은 "더보기" 전에는 안 보여야 함');
  assert.ok(listHtml.includes('5건 남음'), '숨겨진 5건이 더보기 배지에 정확히 표시돼야 함');
});
test('updateHist: sortAsc:false(기본값)에서는 기존처럼 최신 20건이 첫 페이지에 보인다', () => {
  setupHistoryDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 1000000 }];
  sandbox.DB.txns = Array.from({ length: 25 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return { id: 't' + day, date: `2026-05-${day}`, type: 'expense', category: '식비', memo: 'd' + day, amount: 1000 + i, fromAssetId: 'a1' };
  });
  sandbox.renderHistory();
  const listHtml = sandbox.histListEl.innerHTML;
  assert.ok(listHtml.includes('d25'), '첫 페이지에 가장 최근 내역이 보여야 함');
  assert.ok(!listHtml.includes('d05'), '가장 오래된 5건은 아직 안 보여야 함');
});

/* ---------- txRow/histRow: 공용 txRowCore 동기화 회귀 (app-evolve cycle126 advance) ----------
 * 가계부 탭의 txRow()와 전체내역 탭의 histRow()가 sign/cls/av/ic/glyph/faN/taN/asset 계산과
 * 선택모드/일반모드 마크업을 완전히 동일하게 중복 구현해오다, 이번 사이클에 공용 txRowCore(t,sel)
 * 헬퍼로 통합하고 txRow/histRow를 얇은 래퍼로 바꿨다(선택 상태 소스만 ST.lSel vs ST.hist, 토글
 * 핸들러 이름만 ledgerToggleSel vs histToggleSel로 다름). 이 테스트는 향후 누군가 txRow나 histRow
 * 쪽에만 마크업을 손대 다시 갈라지는 걸 잡아낸다: 일반(비선택) 모드는 토글 핸들러 자체가 안 쓰여
 * 완전히 같은 문자열이어야 하고, 선택 모드는 핸들러 이름만 서로 바꿔치면 같은 문자열이어야 한다. */
function makeTxRowFixture() {
  return { id: 't1', date: '2026-06-10', type: 'expense', category: '식비', memo: '점심 김밥', amount: 8000, fromAssetId: 'a1' };
}
test('txRow/histRow: 일반(비선택) 모드에서는 완전히 동일한 마크업을 낸다', () => {
  const t = makeTxRowFixture();
  sandbox.ST = {
    lSel: { mode: false, ids: new Set() },
    hist: { selMode: false, sel: new Set() },
  };
  const ledgerHtml = sandbox.txRow(t);
  const histHtml = sandbox.histRow(t);
  assert.strictEqual(ledgerHtml, histHtml, 'txRow와 histRow는 비선택 모드에서 토글 핸들러를 쓰지 않으므로 바이트 단위로 같아야 함');
  assert.ok(ledgerHtml.includes('점심 김밥'), '회귀 테스트 자체가 의미 있으려면 실제 내용이 렌더돼야 함');
});
test('txRow/histRow: 선택 모드에서는 토글 핸들러 이름만 다르고 나머지는 동일하다 (선택 안 됨)', () => {
  const t = makeTxRowFixture();
  sandbox.ST = {
    lSel: { mode: true, ids: new Set() },
    hist: { selMode: true, sel: new Set() },
  };
  const ledgerHtml = sandbox.txRow(t);
  const histHtml = sandbox.histRow(t);
  assert.ok(ledgerHtml.includes("ledgerToggleSel('t1')"), 'txRow는 ledgerToggleSel을 호출해야 함');
  assert.ok(histHtml.includes("histToggleSel('t1')"), 'histRow는 histToggleSel을 호출해야 함');
  assert.strictEqual(
    ledgerHtml.split('ledgerToggleSel').join('TOGGLE'),
    histHtml.split('histToggleSel').join('TOGGLE'),
    '토글 핸들러 이름만 바꿔치면 나머지 마크업은 완전히 같아야 함'
  );
});
test('txRow/histRow: 선택 모드에서 선택된 상태(on)도 두 함수가 동일하게 반영한다', () => {
  const t = makeTxRowFixture();
  sandbox.ST = {
    lSel: { mode: true, ids: new Set(['t1']) },
    hist: { selMode: true, sel: new Set(['t1']) },
  };
  const ledgerHtml = sandbox.txRow(t);
  const histHtml = sandbox.histRow(t);
  assert.ok(ledgerHtml.includes('sel-on'), '선택된 항목은 txRow에서 sel-on 클래스가 붙어야 함');
  assert.ok(histHtml.includes('sel-on'), '선택된 항목은 histRow에서도 sel-on 클래스가 붙어야 함');
  assert.strictEqual(
    ledgerHtml.split('ledgerToggleSel').join('TOGGLE'),
    histHtml.split('histToggleSel').join('TOGGLE'),
    '선택된 상태(on)에서도 토글 핸들러 이름만 바꿔치면 나머지 마크업은 완전히 같아야 함'
  );
});

/* ---------- renderPlan: 렌더 함수 스모크 테스트 (app-evolve cycle57 critique/advance) ----------
 * render* 함수 중 실행 커버리지가 전혀 없던 유이한 함수(다른 하나는 정적 템플릿인 renderMenu)였다.
 * 지금까지 renderPlan 테스트(위쪽의 esc/접근성/owner 가드 테스트들)는 전부 extractFunction()으로
 * 소스 텍스트만 확인했을 뿐, sandbox.renderPlan()을 실제로 호출해 startBal/flows/dayNeg/firstNegIdx
 * 로 이어지는 잔액 마이너스 전환일 계산이나 danger/danger-start 존·bell 아이콘·빈 상태·오늘 자동삽입
 * 같은 분기 로직을 DOM으로 검증하는 테스트는 없었다. renderHome/renderAssets/renderLedger/
 * renderHistory와 같은 이유(부수효과는 wireMonthCarousel/requestAnimationFrame(fitAll) 두 개뿐이고
 * 둘 다 이미 no-op 스텁이 있음)로 같은 패턴을 적용한다. */
function setupPlanDB() {
  sandbox.TODAY = '2026-06-15';
  sandbox.TM = { y: 2026, m: 6 };
  sandbox.RANGE_TO = '2099-12-31';
  sandbox.DISP_TO = sandbox.addDays(sandbox.TODAY, 92);
  sandbox._balCache.clear();
  sandbox._recCache.clear();
  sandbox._planLive = null;
  sandbox.pagePlanEl._html = '';
  sandbox.ST = { plan: { owner: '전체', assetId: null, y: 2026, m: 6 } };
  sandbox.DB = {
    settings: { includeScheduled: true },
    assets: [],
    owners: ['나'],
    txns: [],
    recurrences: [],
  };
}
test('renderPlan: 이번 달이 아니고 흐름도 없으면 예외 없이 실행되고 빈 상태 안내가 렌더된다', () => {
  setupPlanDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 10000 }];
  sandbox.ST.plan.m = 7; // TM은 6월이라 7월은 "이번 달"이 아니므로 TODAY 자동삽입이 없어 dates가 진짜로 빈다
  assert.doesNotThrow(() => sandbox.renderPlan());
  const html = sandbox.pagePlanEl.innerHTML;
  assert.ok(html, "$('page-plan').innerHTML이 채워져야 함");
  assert.ok(html.includes('7월은 통장이 평화로워요'), '흐름이 전혀 없으면 빈 상태 안내가 나와야 함');
  assert.ok(html.includes('예정된 이체도, 나갈 돈도 없어요'));
});
test('renderPlan: 잔액이 처음 마이너스로 전환되는 날에만 danger-start가 붙고, 이후 마이너스가 유지되는 날은 danger만 붙는다(오늘 자동삽입 포함)', () => {
  setupPlanDB();
  sandbox.DB.assets = [{ id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 10000 }];
  sandbox.DB.txns = [
    { id: 't1', date: '2026-06-10', type: 'expense', category: '쇼핑', memo: '가전제품', amount: 15000, fromAssetId: 'a1' },
  ];
  sandbox.renderPlan();
  const html = sandbox.pagePlanEl.innerHTML;
  const day10 = html.match(/<div class="([^"]*)" data-d="2026-06-10">/);
  const day15 = html.match(/<div class="([^"]*)" data-d="2026-06-15">/);
  assert.ok(day10, '거래가 있는 2026-06-10 플랜 카드가 렌더돼야 함');
  assert.ok(day15, '거래가 없어도 TODAY(2026-06-15)가 자동 삽입돼 렌더돼야 함');
  assert.ok(/\bdanger\b/.test(day10[1]) && /\bdanger-start\b/.test(day10[1]), '잔액이 처음 마이너스로 전환되는 날에는 danger-start가 붙어야 함');
  assert.ok(/\bdanger\b/.test(day15[1]) && !/\bdanger-start\b/.test(day15[1]), '마이너스가 계속 유지되는 날은 danger만 붙고 danger-start가 다시 붙으면 안 됨');
  assert.ok(day15[1].includes('today'), 'TODAY 카드에는 today 클래스가 붙어야 함');
  const block10 = html.slice(html.indexOf('data-d="2026-06-10"'), html.indexOf('data-d="2026-06-15"'));
  const block15 = html.slice(html.indexOf('data-d="2026-06-15"'));
  assert.ok(block10.includes('pd-bell'), '마이너스인 날에는 종 아이콘이 나와야 함(06-10)');
  assert.ok(block15.includes('pd-bell'), '마이너스가 유지되는 오늘에도 종 아이콘이 나와야 함(06-15)');
  assert.ok(block15.includes('오늘은 통장이 평화로워요 🌱'), '자동삽입된 TODAY에 거래가 없으면 일별 빈 상태 문구가 나와야 함');
});
test('renderPlan: 수입/이체/지출 항목이 상대 자산명과 부호가 있는 금액으로 렌더된다', () => {
  setupPlanDB();
  sandbox.DB.assets = [
    { id: 'a1', name: '주계좌', owner: '나', type: 'cash', baseAmount: 100000 },
    { id: 'a2', name: '저축', owner: '나', type: 'savings', baseAmount: 0 },
  ];
  sandbox.DB.txns = [
    { id: 't1', date: '2026-06-05', type: 'income', category: '급여', memo: '월급', amount: 50000, toAssetId: 'a1' },
    { id: 't2', date: '2026-06-10', type: 'transfer', category: '이체', memo: '저축 이체', amount: 20000, fromAssetId: 'a1', toAssetId: 'a2' },
    { id: 't3', date: '2026-06-12', type: 'expense', category: '식비', memo: '장보기', amount: 8000, fromAssetId: 'a1' },
  ];
  sandbox.ST.plan.assetId = 'a1';
  sandbox.renderPlan();
  const html = sandbox.pagePlanEl.innerHTML;
  assert.ok(html.includes('월급') && html.includes('+50,000원'), '수입 항목의 메모와 + 금액이 렌더돼야 함');
  assert.ok(html.includes('<span class="fl">주계좌</span>'), '수입 항목의 flow에 입금 자산명이 나와야 함');
  assert.ok(html.includes('저축 이체') && html.includes('-20,000원'), '이체 항목의 메모와 - 금액(선택 자산 기준 출금)이 렌더돼야 함');
  assert.ok(html.includes('<span class="fl">주계좌→저축</span>'), '이체 항목의 flow에 출발→도착 자산명이 나와야 함');
  assert.ok(html.includes('장보기') && html.includes('-8,000원'), '지출 항목의 메모와 - 금액이 렌더돼야 함');
});

/* ---------- abbr() 억 단위 반올림 비대칭 버그 회귀 테스트 (app-evolve cycle72 develop) ----------
 * abbr()의 억 단위 분기가 원래 Math.abs(v%1)<0.05로 "정수보다 살짝 큰" 값(예: 2.02억)만
 * 반올림 표시("2억")하고, "정수보다 살짝 작은" 값(예: 1.96억)은 같은 정도로 반올림 대상인데도
 * toFixed(1)로 빠져 "2.0억"처럼 어색한 소수점이 남았다. 두 값 모두 2억에서 2% 이내인데
 * 한쪽만 정수로 뭉개지는 게 일관성 없어, 정수까지의 거리(Math.min(f,1-f))로 대칭 판정하도록 고쳤다.
 */
test('abbr: 정수보다 살짝 작은 값(1.96억)도 살짝 큰 값(2.02억)과 동일하게 반올림돼 "2억"으로 표시된다', () => {
  assert.strictEqual(sandbox.abbr(196000000), '2억');
  assert.strictEqual(sandbox.abbr(202000000), '2억');
});
test('abbr: 정수와 충분히 먼 소수점 값(1.5억)은 그대로 toFixed(1)로 "1.5억"이 유지된다', () => {
  assert.strictEqual(sandbox.abbr(150000000), '1.5억');
});
test('abbr: 음수도 부호를 유지한 채 동일한 반올림 규칙이 적용된다(-1.96억 -> "-2억")', () => {
  assert.strictEqual(sandbox.abbr(-196000000), '-2억');
});

/* ---------- abbr() 만→억 경계 반올림 버그 회귀 테스트 (app-evolve cycle91 develop) ----------
 * a<1e8(1억 미만)이면 '만' 분기(a>=10000)를 타는데, 99,995,000~99,999,999원처럼 만 단위로
 * 반올림한 값이 정확히 10000이 되는 구간에서는 '10000만원'으로 표시됐다 — 수치는 맞지만
 * "10000만"은 자연스러운 한국어 단위 표기가 아니라(1억=10000만이므로 그 즉시 '억'으로
 * 넘어가야 함) 캘린더 하루 합계(calCellsFor)에 어색한 값이 그대로 노출되던 문제.
 * 억 분기(a>=1e8)의 경계 바로 아래에서만 재현되며, 그보다 작은 값(9999만 이하)은 영향 없다. */
test('abbr: 반올림 시 10000만이 되는 값(99,999,999원)은 "1억"으로 표시된다(10000만 X)', () => {
  assert.strictEqual(sandbox.abbr(99999999), '1억');
});
test('abbr: 반올림 경계 바로 안쪽(99,995,000원)도 "1억"으로 표시된다', () => {
  assert.strictEqual(sandbox.abbr(99995000), '1억');
});
test('abbr: 반올림 경계 바로 바깥쪽(99,994,999원)은 그대로 "9999만"이 유지된다', () => {
  assert.strictEqual(sandbox.abbr(99994999), '9999만');
});
test('abbr: 음수 경계값(-99,999,999원)도 동일하게 "-1억"으로 표시된다', () => {
  assert.strictEqual(sandbox.abbr(-99999999), '-1억');
});

/* ---------- nextGroupOrder: wireGroupDrag() 드래그 완료 시 순서 병합 로직 (app-evolve cycle73 advance) ----------
 * wireGroupDrag()가 pointercancel(엣지 스와이프-백, 인터럽트 등으로 드래그 중단)을 처리하지 않아
 * document에 리스너가 영구히 남고, 다음 드래그가 그 위에 또 겹쳐 등록돼 자산 그룹 순서(DB.settings.groupOrder)가
 * 손상될 수 있던 버그를 고치면서, 드래그 완료 시 화면에 보이는 순서와 숨겨진(자산이 없는) 그룹을
 * 합치는 순수 로직을 nextGroupOrder(existingOrder, visibleTypes)로 분리했다. DOM/포인터 이벤트 배선 자체는
 * 순수 함수가 아니라 여기서 직접 테스트할 수 없지만, 이 병합 로직만은 회귀를 막는다.
 */
test('nextGroupOrder: 화면에 보이는 순서를 앞에 두고, 화면에 없는(자산 0개) 그룹은 기존 순서 그대로 뒤에 붙인다', () => {
  const existing = ['cash', 'savings', 'stock', 'realestate', 'debt'];
  const visible = ['stock', 'cash']; // 드래그로 재배치된 순서, 'savings'는 자산이 없어 화면에 안 보임
  assert.deepStrictEqual(
    sandbox.nextGroupOrder(existing, visible),
    ['stock', 'cash', 'savings', 'realestate', 'debt']
  );
});
test('nextGroupOrder: 모든 그룹이 화면에 보이면 그 순서를 그대로 채택한다', () => {
  const existing = ['cash', 'savings', 'stock'];
  const visible = ['stock', 'savings', 'cash'];
  assert.deepStrictEqual(sandbox.nextGroupOrder(existing, visible), ['stock', 'savings', 'cash']);
});

/* ---------- movedGroupOrder: 드래그를 쓸 수 없는 키보드/스크린리더 사용자를 위한 '위로/아래로 이동'
 * 버튼(assetBodyHTML의 .grp-move-btn, moveGroup())이 쓰는 순수 로직 (app-evolve cycle108 advance).
 * wireGroupDrag()의 pointerup 핸들러가 하는 일(화면에 보이는 순서를 재배치 → nextGroupOrder로 숨김
 * 그룹과 병합)과 동일한 최종 상태를 인접 교환(swap)만으로 만들어, 두 입력 경로의 결과가 일치하는지 검증한다. */
test('movedGroupOrder: 위로 이동(dir=-1)하면 바로 앞 항목과 자리를 바꾼다', () => {
  const existing = ['cash', 'savings', 'stock'];
  const visible = ['cash', 'savings', 'stock'];
  assert.deepStrictEqual(
    sandbox.movedGroupOrder(existing, visible, 'stock', -1),
    ['cash', 'stock', 'savings']
  );
});
test('movedGroupOrder: 아래로 이동(dir=1)하면 바로 뒤 항목과 자리를 바꾼다', () => {
  const existing = ['cash', 'savings', 'stock'];
  const visible = ['cash', 'savings', 'stock'];
  assert.deepStrictEqual(
    sandbox.movedGroupOrder(existing, visible, 'cash', 1),
    ['savings', 'cash', 'stock']
  );
});
test('movedGroupOrder: 맨 위 항목을 위로, 맨 아래 항목을 아래로 이동하려 하면(경계) 기존 순서를 그대로 반환한다', () => {
  const existing = ['cash', 'savings', 'stock'];
  const visible = ['cash', 'savings', 'stock'];
  assert.deepStrictEqual(sandbox.movedGroupOrder(existing, visible, 'cash', -1), existing);
  assert.deepStrictEqual(sandbox.movedGroupOrder(existing, visible, 'stock', 1), existing);
});
test('movedGroupOrder: 화면에 없는(자산 0개) 숨김 그룹은 기존 순서 그대로 뒤에 유지된다', () => {
  const existing = ['cash', 'savings', 'stock', 'realestate', 'debt'];
  const visible = ['stock', 'cash']; // 'savings'는 자산이 없어 화면에 안 보임(nextGroupOrder 테스트와 동일 전제)
  assert.deepStrictEqual(
    sandbox.movedGroupOrder(existing, visible, 'cash', -1),
    ['cash', 'stock', 'savings', 'realestate', 'debt']
  );
});

/* ---------- movedAssetOrder: '사용자 정의순'일 때 그룹 '안'의 개별 자산을 재배열하는 .asset-sub-row
 * 위/아래 버튼(moveAsset())이 쓰는 순수 로직 (app-evolve cycle134 advance). movedGroupOrder와 똑같이
 * 인접 교환(swap)만 하지만, 대상이 "화면에 보이는 그룹들"이 아니라 "한 그룹 안의 자산 id들"이고
 * 반환값도 순서 배열이 아니라 {id:순번} order 맵이라는 점이 다르다(moveAsset()이 이 맵의 값만
 * 해당 자산들의 a.order에 대입하므로 다른 그룹 자산의 order는 전혀 건드리지 않는다). */
// vm 컨텍스트에서 만든 객체 리터럴은 메인 realm 리터럴과 deepStrictEqual 비교 시
// "same structure but not reference-equal"로 실패하므로(cycle131 advance에서 처음 발견한 realm 경계
// 문제와 동일) 필드별 strictEqual로 비교한다.
test('movedAssetOrder: 중간 항목을 위로 이동하면 바로 앞 항목과 자리를 바꾼다', () => {
  const ids = ['a1', 'a2', 'a3'];
  const map = sandbox.movedAssetOrder(ids, 'a2', -1);
  assert.strictEqual(map.a2, 0);
  assert.strictEqual(map.a1, 1);
  assert.strictEqual(map.a3, 2);
});
test('movedAssetOrder: 중간 항목을 아래로 이동하면 바로 뒤 항목과 자리를 바꾼다', () => {
  const ids = ['a1', 'a2', 'a3'];
  const map = sandbox.movedAssetOrder(ids, 'a2', 1);
  assert.strictEqual(map.a1, 0);
  assert.strictEqual(map.a3, 1);
  assert.strictEqual(map.a2, 2);
});
test('movedAssetOrder: 맨 위 항목을 위로, 맨 아래 항목을 아래로 이동하려 하면(경계) null을 반환한다', () => {
  const ids = ['a1', 'a2', 'a3'];
  assert.strictEqual(sandbox.movedAssetOrder(ids, 'a1', -1), null);
  assert.strictEqual(sandbox.movedAssetOrder(ids, 'a3', 1), null);
});
test('movedAssetOrder: 반환된 order 맵은 넘겨준 ids(그 그룹 안 자산들)에만 있고, 다른 그룹 자산의 order엔 영향이 없다(moveAsset()이 groupItems(type)으로 같은 타입만 넘기므로)', () => {
  const ids = ['cash1', 'cash2']; // 다른 타입(stock 등) 자산 id는 애초에 이 배열에 들어오지 않는다
  const map = sandbox.movedAssetOrder(ids, 'cash1', 1);
  assert.strictEqual(map.cash2, 0);
  assert.strictEqual(map.cash1, 1);
  assert.strictEqual(Object.keys(map).sort().join(','), ids.slice().sort().join(','));
});

/* ---------- nwClampIdx: Assets 탭 귀속(나/배우자/공용/전체) 캐러셀의 점 클릭/화살표 키가 쓰는
 * 인덱스 정규화 (app-evolve cycle113 advance, logic.js). wireNwCarousel()의 클론-루프 스크롤 스냅과
 * 동일한 경계 규칙(loop면 wrap, 아니면 clamp)을 공유해 스크롤/클릭/키보드 세 경로가 항상 같은
 * 카드를 가리키게 한다. */
test('nwClampIdx: loop(카드 2장 이상)이면 마지막을 넘어가는 인덱스는 0으로 wrap된다', () => {
  assert.strictEqual(sandbox.nwClampIdx(3, 3, true), 0);
  assert.strictEqual(sandbox.nwClampIdx(4, 3, true), 1);
});
test('nwClampIdx: loop이면 0 아래로 내려가는 인덱스는 마지막으로 wrap된다', () => {
  assert.strictEqual(sandbox.nwClampIdx(-1, 3, true), 2);
  assert.strictEqual(sandbox.nwClampIdx(-4, 3, true), 2);
});
test('nwClampIdx: loop이 아니면(카드 1장) 범위를 벗어난 인덱스는 양끝에 고정(clamp)된다', () => {
  assert.strictEqual(sandbox.nwClampIdx(-1, 1, false), 0);
  assert.strictEqual(sandbox.nwClampIdx(5, 1, false), 0);
});
test('nwClampIdx: 범위 안의 인덱스는 그대로 반환한다', () => {
  assert.strictEqual(sandbox.nwClampIdx(1, 3, true), 1);
  assert.strictEqual(sandbox.nwClampIdx(0, 1, false), 0);
});
test('nwClampIdx: n<=0(카드 없음)이면 항상 0을 반환한다', () => {
  assert.strictEqual(sandbox.nwClampIdx(0, 0, true), 0);
  assert.strictEqual(sandbox.nwClampIdx(2, 0, false), 0);
});

/* ---------- whTargetIdx: 연/월 휠 피커(wh-col)의 ArrowUp/ArrowDown/Home/End 키가 쓰는 인덱스
 * 계산 (app-evolve cycle118 advance, logic.js). nwClampIdx(캐러셀)와 달리 wrap 없이 양끝에서
 * 멈춘다(clamp) — 휠은 "루프"가 아니라 유한한 연/월 목록이기 때문. */
test('whTargetIdx: Home/End는 각각 0과 마지막 인덱스로 이동한다', () => {
  assert.strictEqual(sandbox.whTargetIdx(5, 12, 'Home'), 0);
  assert.strictEqual(sandbox.whTargetIdx(5, 12, 'End'), 11);
});
test('whTargetIdx: ArrowUp/ArrowDown은 한 칸씩 이동한다', () => {
  assert.strictEqual(sandbox.whTargetIdx(5, 12, 'ArrowUp'), 4);
  assert.strictEqual(sandbox.whTargetIdx(5, 12, 'ArrowDown'), 6);
});
test('whTargetIdx: 양끝을 넘어가면 wrap 없이 그 자리에 고정(clamp)된다', () => {
  assert.strictEqual(sandbox.whTargetIdx(0, 12, 'ArrowUp'), 0);
  assert.strictEqual(sandbox.whTargetIdx(11, 12, 'ArrowDown'), 11);
});
test('whTargetIdx: cur===-1(아직 선택 안 됨)은 0으로 취급해 이동을 계산한다', () => {
  assert.strictEqual(sandbox.whTargetIdx(-1, 12, 'ArrowDown'), 1);
  assert.strictEqual(sandbox.whTargetIdx(-1, 12, 'ArrowUp'), 0);
  assert.strictEqual(sandbox.whTargetIdx(-1, 12, 'Home'), 0);
  assert.strictEqual(sandbox.whTargetIdx(-1, 12, 'End'), 11);
});
test('whTargetIdx: n<=0(항목 없음)이면 항상 0을 반환한다', () => {
  assert.strictEqual(sandbox.whTargetIdx(3, 0, 'ArrowDown'), 0);
  assert.strictEqual(sandbox.whTargetIdx(-1, 0, 'Home'), 0);
});
test('whTargetIdx: 모르는 key는 cur를 그대로 돌려준다(호출부가 "이동 없음"으로 처리)', () => {
  assert.strictEqual(sandbox.whTargetIdx(5, 12, 'PageUp'), 5);
  assert.strictEqual(sandbox.whTargetIdx(-1, 12, 'Tab'), -1);
});

/* ---------- monthSwipeCommitDir: wireMonthCarousel() 스와이프 커밋 방향 판정 (app-evolve cycle74 advance) ----------
 * wireMonthCarousel()이 touchcancel(엣지 백제스처, 알림 배너, 전화 수신 등으로 스와이프 중단)을
 * 처리하지 않아 drag 상태가 정리되지 않고 트랙이 마지막 touchmove 위치에 고정된 채 라벨과
 * 패널이 어긋나던 버그를 고치면서, touchend/touchcancel 양쪽이 공유하는 "커밋 방향" 판정을
 * monthSwipeCommitDir(dx, stepPx, cancelled)로 분리했다. cancelled=true(touchcancel)면 dx와
 * 무관하게 항상 취소(null)돼야 한다.
 */
test('monthSwipeCommitDir: 임계값(15%) 미만으로 밀면 취소(null)', () => {
  assert.strictEqual(sandbox.monthSwipeCommitDir(10, 100, false), null);
  assert.strictEqual(sandbox.monthSwipeCommitDir(-15, 100, false), null);
});
test('monthSwipeCommitDir: 임계값 이상 오른쪽으로 밀면 이전 달(-1)', () => {
  assert.strictEqual(sandbox.monthSwipeCommitDir(20, 100, false), -1);
});
test('monthSwipeCommitDir: 임계값 이상 왼쪽으로 밀면 다음 달(1)', () => {
  assert.strictEqual(sandbox.monthSwipeCommitDir(-20, 100, false), 1);
});
test('monthSwipeCommitDir: cancelled=true면 dx가 임계값을 넘어도 항상 취소(null)', () => {
  assert.strictEqual(sandbox.monthSwipeCommitDir(50, 100, true), null);
  assert.strictEqual(sandbox.monthSwipeCommitDir(-50, 100, true), null);
});

/* ---------- overlayEscapeTarget: onSheetKeydown()의 Tab 트랩·Escape 대상 판정 (app-evolve cycle74 advance) ----------
 * #dpModal/#dpWheel(날짜·연월 선택 오버레이)이 시트보다 z-index상 위에 뜨는데도 onSheetKeydown이
 * 항상 #sheet만 대상으로 해 Tab 진입이 불가능하고 Escape가 캘린더 대신 배경 시트를 통째로 닫던
 * 버그를 고치면서, "현재 최상단 오버레이가 무엇인가" 판정을 overlayEscapeTarget(dpWheelOpen,
 * dpModalOpen,sheetOpen)로 분리했다. dpWheel > dpModal > sheet 순으로 우선한다(실제 z-index 순서와
 * 일치: dp-wheel:160 > dp-modal:151 > sheet:101).
 */
test('overlayEscapeTarget: 셋 다 열려 있으면 dpWheel이 최우선', () => {
  assert.strictEqual(sandbox.overlayEscapeTarget(true, true, true), 'wheel');
});
test('overlayEscapeTarget: dpWheel이 닫혀 있고 dpModal이 열려 있으면 modal', () => {
  assert.strictEqual(sandbox.overlayEscapeTarget(false, true, true), 'modal');
});
test('overlayEscapeTarget: dpWheel·dpModal 모두 닫혀 있고 시트만 열려 있으면 sheet', () => {
  assert.strictEqual(sandbox.overlayEscapeTarget(false, false, true), 'sheet');
});
test('overlayEscapeTarget: 아무 오버레이도 열려 있지 않으면 null(onSheetKeydown이 조기 반환)', () => {
  assert.strictEqual(sandbox.overlayEscapeTarget(false, false, false), null);
});

/* ---------- tabNavAction: go(tab) 하단 탭 전환의 백버튼 history entry 판정 (app-evolve cycle138 advance, logic.js) ----------
 * 안드로이드 백버튼은 history 스택이 비면 standalone PWA를 바로 종료시킨다. _ovHistDepth/
 * ovHistPush()는 오버레이(시트/dpModal/dpWheel)에만 적용돼 있어, 시트가 안 열린 비홈 탭(자산관리·
 * 가계부·전체내역·플랜·메뉴)에서 뒤로가기를 누르면 홈으로 안 돌아가고 앱이 종료되는 비대칭이
 * 있었다. go(tab)가 매 호출마다 이 함수로 홈 진입용 history entry를 push/pop할지 판정한다. */
test('tabNavAction: 홈→비홈 최초 진입이면 push(entry를 쌓음)', () => {
  assert.strictEqual(sandbox.tabNavAction('ledger', false), 'push');
  assert.strictEqual(sandbox.tabNavAction('assets', false), 'push');
  assert.strictEqual(sandbox.tabNavAction('menu', false), 'push');
});
test('tabNavAction: entry가 이미 쌓인 채로 다른 비홈 탭으로 또 전환하면 none(재사용, 또 안 쌓음)', () => {
  assert.strictEqual(sandbox.tabNavAction('assets', true), 'none');
  assert.strictEqual(sandbox.tabNavAction('plan', true), 'none');
});
test('tabNavAction: entry가 쌓인 채로 홈 복귀면 pop(그 entry를 소비)', () => {
  assert.strictEqual(sandbox.tabNavAction('home', true), 'pop');
});
test('tabNavAction: entry가 없는데 홈이면(이미 홈이거나 entry를 이미 소비) none', () => {
  assert.strictEqual(sandbox.tabNavAction('home', false), 'none');
});

/* ---------- go(tab)/popstate: 위 tabNavAction 판정이 실제로 history.pushState/back과 연결돼
 * 있는지(소스 패턴 대조) — go/popstate 리스너는 DOM API(history)를 직접 쓰므로 vm 실행 대상인
 * FUNCTIONS 목록에 넣지 않고(다른 테스트들의 sandbox.go는 스파이로 남겨둠), 실제 배선이 빠지지
 * 않았는지만 원본 텍스트로 확인한다. */
test('go(tab): tabNavAction 판정에 따라 history.pushState/back이 호출되도록 배선돼 있다', () => {
  const body = extractFunction('go');
  assert.ok(body.includes('tabNavAction(tab,_tabNavPushed)'), 'go(tab)가 tabNavAction으로 판정하지 않음');
  assert.ok(/push.*history\.pushState\(\{tabNav:true\},''\)/.test(body), "'push' 판정 시 history.pushState가 호출되지 않음");
  assert.ok(/pop.*history\.back\(\)/.test(body), "'pop' 판정 시 history.back()이 호출되지 않음");
});
test('popstate: _ovHistDepth가 0이고 _tabNavPushed면 진짜 백버튼으로 간주해 go(\'home\')으로 복귀한다', () => {
  assert.ok(src.includes("if(_tabNavPushed){_tabNavPushed=false;go('home');}"), 'popstate 리스너에 _tabNavPushed 소비 후 go(\'home\') 호출이 없음');
});

/* ---------- 하단 탭바(.nav-btn) aria-current: 지금까지 'on' CSS 클래스만으로 활성 탭을
 * 표시해서 스크린리더 사용자는 어느 탭이 선택됐는지 알 수 없었다(nw-dots/날짜피커는 이미
 * aria-current를 쓰고 있었는데 nav-btn만 빠져 있던 불일치). buildNav/go 둘 다 DOM API를
 * 직접 쓰므로(innerHTML 조립, querySelectorAll) FUNCTIONS vm 실행 대상에 넣지 않고 go
 * 테스트와 동일하게 소스 패턴으로 확인한다. */
test('buildNav: 각 탭 버튼에 초기 aria-current를 넣는다(home만 page, 나머지는 false)', () => {
  const body = extractFunction('buildNav');
  assert.ok(/aria-current="\$\{t\.id===.home.\?.page.:.false.\}"/.test(body), 'buildNav가 탭 버튼에 aria-current를 배선하지 않음');
});
test('go(tab): .nav-btn의 aria-current를 활성 탭에 맞춰 갱신한다', () => {
  const body = extractFunction('go');
  assert.ok(/setAttribute\('aria-current',\s*on\?'page':'false'\)/.test(body), "go(tab)이 nav-btn의 aria-current를 갱신하지 않음");
  assert.ok(/b\.dataset\.tab===navTabOf\(tab\)/.test(body), 'go(tab)의 aria-current 갱신이 활성 탭 판정(navTabOf)과 연결돼 있지 않음');
});

/* ---------- sbErrMsg: Supabase 에러 메시지 매핑 (app-evolve cycle98 advance: 비밀번호 변경/재설정 추가) ----------
 * changePassword/resetPassword가 추가되면서 signUp/signIn 흐름에는 없던 두 메시지("기존과 같은
 * 비밀번호"·"요청 빈도 제한")가 새로 생겼다. 이 둘은 generic한 /password/i 분기보다 앞에 있어야 하는데,
 * 순서가 뒤집히면 "New password should be different from the old password."가 엉뚱하게 "6자 이상"
 * 메시지로 뭉개진다 — 그 순서 자체를 이 테스트가 지킨다.
 */
test('sbErrMsg: 회원가입 중복 이메일', () => {
  assert.strictEqual(sandbox.sbErrMsg({ message: 'User already registered' }), '이미 가입된 이메일이에요');
});
test('sbErrMsg: 로그인 자격 불일치', () => {
  assert.strictEqual(sandbox.sbErrMsg({ message: 'Invalid login credentials' }), '이메일 또는 비밀번호가 올바르지 않아요');
});
test('sbErrMsg: 이메일 인증 필요', () => {
  assert.strictEqual(sandbox.sbErrMsg({ message: 'Email not confirmed' }), '이메일 인증이 필요해요 · 메일함을 확인해 주세요');
});
test('sbErrMsg: 새 비밀번호가 기존과 같음(changePassword) — generic password 분기보다 먼저 매칭돼야 함', () => {
  assert.strictEqual(
    sandbox.sbErrMsg({ message: 'New password should be different from the old password.' }),
    '새 비밀번호는 기존 비밀번호와 달라야 해요'
  );
});
test('sbErrMsg: 재설정 메일 요청 빈도 제한(resetPassword)', () => {
  assert.strictEqual(
    sandbox.sbErrMsg({ message: 'For security purposes, you can only request this after 34 seconds.' }),
    '요청이 너무 잦아요 · 잠시 후 다시 시도해 주세요'
  );
});
test('sbErrMsg: 그 외 비밀번호 관련 메시지는 기존처럼 길이 안내로 매핑', () => {
  assert.strictEqual(sandbox.sbErrMsg({ message: 'Password should be at least 6 characters.' }), '비밀번호는 6자 이상이어야 해요');
});
test('sbErrMsg: 매칭되는 패턴이 없으면 원본 메시지를 그대로 보여준다', () => {
  assert.strictEqual(sandbox.sbErrMsg({ message: 'Some unmapped error' }), 'Some unmapped error');
});
test('sbErrMsg: 에러 객체 자체가 없으면 기본 안내 문구', () => {
  assert.strictEqual(sandbox.sbErrMsg(null), '클라우드 연결에 실패했어요');
});

/* ---------- netlify/functions/stock.js·rates.js: 시세/환율 프록시 순수 함수 (app-evolve cycle103) ----------
 * fetch()를 실제로 하는 함수(getJSON 의존 함수들)는 네트워크 모킹 인프라가 없어 범위 밖 —
 * 여기서는 순수 계산/파싱 함수만 검증한다. stockFns/ratesFns가 null이면(require 실패) 건너뛴다. */
if (stockFns && ratesFns) {
  test('stock.toNum: 콤마·통화기호가 섞인 문자열도 숫자만 뽑는다', () => {
    assert.strictEqual(stockFns.toNum('1,234원'), 1234);
  });
  test('stock.toNum: 빈 문자열/쓰레기 값은 0', () => {
    assert.strictEqual(stockFns.toNum(''), 0);
    assert.strictEqual(stockFns.toNum('abc'), 0);
    assert.strictEqual(stockFns.toNum(null), 0);
    assert.strictEqual(stockFns.toNum(undefined), 0);
  });
  test('stock.toNum: 부호는 숫자가 아닌 문자로 걸러지므로 음수 문자열도 절댓값으로 파싱된다(의도된 동작)', () => {
    assert.strictEqual(stockFns.toNum('-5'), 5);
  });

  test('stock.toKrw: KRW는 반올림만 하고 그대로 통과', () => {
    assert.strictEqual(stockFns.toKrw({ currency: 'KRW', price: 1000.6 }, null), 1001);
  });
  test('stock.toKrw: 환율이 있으면 곱해서 반올림', () => {
    assert.strictEqual(stockFns.toKrw({ currency: 'USD', price: 10 }, { USD: 1300 }), 13000);
  });
  test('stock.toKrw: 해당 통화의 환율이 없으면 null(가격 표시 안 함, 0원으로 오표시 방지)', () => {
    assert.strictEqual(stockFns.toKrw({ currency: 'EUR', price: 10 }, { USD: 1300 }), null);
    assert.strictEqual(stockFns.toKrw({ currency: 'EUR', price: 10 }, null), null);
  });

  test('stock.applyJpyScale/rates.applyJpyScale: 엔은 100으로 나누고(100엔 고시), 그 외 통화는 그대로', () => {
    assert.strictEqual(stockFns.applyJpyScale('JPY', 900), 9);
    assert.strictEqual(stockFns.applyJpyScale('USD', 900), 900);
    assert.strictEqual(ratesFns.applyJpyScale('JPY', 900), 9);
    assert.strictEqual(ratesFns.applyJpyScale('USD', 900), 900);
  });

  test('pickRows: 배열/{result:[...]}/{result:{prices:[...]}}} 세 형태를 모두 행 배열로', () => {
    assert.deepStrictEqual(stockFns.pickRows([1, 2]), [1, 2]);
    assert.deepStrictEqual(stockFns.pickRows({ result: [1, 2] }), [1, 2]);
    assert.deepStrictEqual(stockFns.pickRows({ result: { prices: [1, 2] } }), [1, 2]);
  });
  test('pickRows: null/undefined/형태가 다른 값은 빈 배열(예외 던지지 않음)', () => {
    assert.deepStrictEqual(stockFns.pickRows(null), []);
    assert.deepStrictEqual(stockFns.pickRows(undefined), []);
    assert.deepStrictEqual(stockFns.pickRows({}), []);
    assert.deepStrictEqual(stockFns.pickRows({ result: 'nope' }), []);
  });

  test('errText: HTTP 상태가 있으면 "HTTP <상태>", 없으면 에러 메시지', () => {
    assert.strictEqual(stockFns.errText({ status: 404 }), 'HTTP 404');
    assert.strictEqual(stockFns.errText(new Error('boom')), 'boom');
  });

  test('rates.ratesUsdBaseToKrw: "1 USD = ? X" 원본을 요청 통화별 원화 환율로 변환(KRW/USD=KRW/X÷KRW/USD... 교차환율)', () => {
    const m = ratesFns.ratesUsdBaseToKrw({ KRW: 1385, JPY: 150, EUR: 0.92 }, ['USD', 'KRW', 'JPY', 'EUR']);
    assert.strictEqual(m.USD, 1385);
    assert.strictEqual(m.KRW, 1);
    assert.strictEqual(m.JPY, 1385 / 150);
    assert.strictEqual(m.EUR, 1385 / 0.92);
    assert.strictEqual(m._usdKrw, 1385);
  });
  test('rates.ratesUsdBaseToKrw: 원본 rates에 KRW가 없으면 전체를 신뢰할 수 없다고 보고 null', () => {
    assert.strictEqual(ratesFns.ratesUsdBaseToKrw({ JPY: 150 }, ['USD']), null);
    assert.strictEqual(ratesFns.ratesUsdBaseToKrw(null, ['USD']), null);
  });
  test('rates.ratesUsdBaseToKrw: 요청한 통화가 원본 rates에 없으면 에러 없이 그 통화만 결과에서 빠진다', () => {
    const m = ratesFns.ratesUsdBaseToKrw({ KRW: 1385 }, ['USD', 'GBP']);
    assert.strictEqual(m.USD, 1385);
    assert.strictEqual('GBP' in m, false);
  });
}

/* ---------- fetchWithTimeout (app-evolve cycle115) ----------
 * fetchFxGold/fetchStocks의 bare fetch가 AbortController/타임아웃이 전혀 없어, 서버가 응답을
 * 멎으면(캡티브 포털·모바일 네트워크 전환·함수 콜드스타트 중 연결 끊김) syncRates()의 syncing
 * mutex가 영구 고정되던 버그의 회귀를 막는다. sandbox.setTimeout/clearTimeout은 기본값이
 * no-op(다른 테스트의 지연 포커스 등을 무력화하기 위함)이라, 이 블록에서만 실제 Node 타이머로
 * 잠깐 바꿔주고 매 테스트가 끝나면 원복한다. */
(() => {
  const origSetTimeout = sandbox.setTimeout, origClearTimeout = sandbox.clearTimeout, origFetch = sandbox.fetch;
  function restoreTimers() { sandbox.setTimeout = origSetTimeout; sandbox.clearTimeout = origClearTimeout; sandbox.fetch = origFetch; }

  test('fetchWithTimeout: 서버가 응답하지 않으면 지정 시간 후 signal을 abort하고 프로미스가 reject된다(mutex 영구 고정 방지)', async () => {
    sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
    let capturedSignal = null;
    sandbox.fetch = (url, opts) => new Promise((resolve, reject) => {
      capturedSignal = opts.signal;
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    try {
      await assert.rejects(sandbox.fetchWithTimeout('/x', {}, 10));
      assert.strictEqual(capturedSignal.aborted, true, '타임아웃 후 signal.aborted가 true여야 함');
    } finally { restoreTimers(); }
  });

  test('fetchWithTimeout: 응답이 제때 오면 결과를 그대로 반환하고, finally에서 타이머를 정리한다(늦은 abort가 다음 요청에 새지 않음)', async () => {
    let clearCalls = 0;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = (t) => { clearCalls++; clearTimeout(t); };
    sandbox.fetch = async () => ({ ok: true, mock: 'resp' });
    try {
      const r = await sandbox.fetchWithTimeout('/x', {}, 50);
      assert.strictEqual(r.mock, 'resp');
      assert.strictEqual(clearCalls, 1, '성공 경로에서도 타이머를 정리해야 함');
    } finally { restoreTimers(); }
  });

  test('fetchWithTimeout: ms를 생략하면 기본 8000ms를 타임아웃으로 쓴다', async () => {
    let capturedMs = null;
    sandbox.setTimeout = (fn, ms) => { capturedMs = ms; return setTimeout(fn, ms); };
    sandbox.clearTimeout = clearTimeout;
    sandbox.fetch = async () => ({ ok: true });
    try {
      await sandbox.fetchWithTimeout('/x', {});
      assert.strictEqual(capturedMs, 8000);
    } finally { restoreTimers(); }
  });

  test('fetchWithTimeout: 기존 opts(headers 등)를 보존하면서 signal만 추가한다', async () => {
    let capturedOpts = null;
    sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
    sandbox.fetch = async (url, opts) => { capturedOpts = opts; return { ok: true }; };
    try {
      await sandbox.fetchWithTimeout('/x', { headers: { a: 1 } }, 50);
      assert.strictEqual(capturedOpts.headers.a, 1);
      assert.ok(capturedOpts.signal, 'signal이 opts에 병합되어야 함');
    } finally { restoreTimers(); }
  });

  test('fetchWithTimeout: opts를 생략해도(undefined) 에러 없이 signal만 담아 호출한다(fetchFxGold/fetchStocks의 실제 호출 형태)', async () => {
    let capturedOpts;
    sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
    sandbox.fetch = async (url, opts) => { capturedOpts = opts; return { ok: true }; };
    try {
      await sandbox.fetchWithTimeout('/x');
      assert.ok(capturedOpts.signal);
    } finally { restoreTimers(); }
  });
})();

/* ---------- measureCloudClockSkew (app-evolve cycle165 advance) ----------
 * critique(cycle165)가 발견한 "mergeCollection()의 LWW가 두 기기 로컬 시계만으로 병합 승자를
 * 정해, 한쪽 시계가 틀리면 수정이 조용히 사라질 수 있다"는 위험의 감지 쪽 구현. afterCloudAuth()가
 * 이미 하는 클라우드 왕복에 얹어 Supabase REST 응답의 Date 헤더로 서버 시각을 얻고, 이 기기
 * Date.now()와의 차이를 CLOCK_SKEW_MS에 남긴다(homeAlerts()가 clockSkewSeverity()로 판정).
 * fetchWithTimeout과 같은 이유로 sandbox.fetch를 이 블록에서만 실제로 바꿔주고 매 테스트 후 원복한다. */
(() => {
  const origFetch = sandbox.fetch, origCloudUid = sandbox.CLOUD_UID, origSkew = sandbox.CLOCK_SKEW_MS,
    origTab = sandbox.ST && sandbox.ST.tab, origRender = sandbox.renderCurrent, origDB = sandbox.DB;
  function restore() {
    sandbox.fetch = origFetch; sandbox.CLOUD_UID = origCloudUid; sandbox.CLOCK_SKEW_MS = origSkew;
    if (sandbox.ST) sandbox.ST.tab = origTab;
    sandbox.renderCurrent = origRender; sandbox.DB = origDB;
  }

  test('measureCloudClockSkew: CLOUD_UID가 없으면(로컬/카카오 전용) 네트워크를 전혀 부르지 않고 조용히 리턴한다', async () => {
    sandbox.CLOUD_UID = null;
    sandbox.CLOCK_SKEW_MS = null;
    let fetchCalled = false;
    sandbox.fetch = async () => { fetchCalled = true; return { headers: { get: () => null } }; };
    try {
      await sandbox.measureCloudClockSkew();
      assert.strictEqual(fetchCalled, false, 'CLOUD_UID가 없으면 fetch를 부르면 안 됨');
      assert.strictEqual(sandbox.CLOCK_SKEW_MS, null);
    } finally { restore(); }
  });

  test('measureCloudClockSkew: 응답의 Date 헤더와 이 기기 시계 차이를 CLOCK_SKEW_MS에 남긴다', async () => {
    sandbox.CLOUD_UID = 'u1';
    sandbox.CLOCK_SKEW_MS = null;
    sandbox.ST = sandbox.ST || {};
    sandbox.ST.tab = 'ledger'; // 홈 탭이 아니므로 renderCurrent를 부르지 않는 경로도 함께 확인
    sandbox.DB = { settings: {} };
    let renderCalls = 0;
    sandbox.renderCurrent = () => { renderCalls++; };
    const now = Date.now();
    const serverMs = now - 10 * 60 * 1000; // 서버가 10분 "과거"로 응답 → 이 기기가 10분 빠름
    sandbox.fetch = async () => ({ headers: { get: (h) => (h === 'date' ? new Date(serverMs).toUTCString() : null) } });
    try {
      await sandbox.measureCloudClockSkew();
      assert.ok(Math.abs(sandbox.CLOCK_SKEW_MS - 10 * 60 * 1000) < 2000, 'drift가 약 10분으로 계산돼야 함(Date 헤더는 초 단위라 약간의 오차 허용)');
      assert.strictEqual(renderCalls, 0, '홈 탭이 아니면 renderCurrent를 부르지 않아야 함');
    } finally { restore(); }
  });

  test('measureCloudClockSkew: 홈 탭에서 측정에 성공하면 renderCurrent를 불러 새 경고 카드가 바로 보이게 한다', async () => {
    sandbox.CLOUD_UID = 'u1';
    sandbox.CLOCK_SKEW_MS = null;
    sandbox.ST = sandbox.ST || {};
    sandbox.ST.tab = 'home';
    sandbox.DB = { settings: {} };
    let renderCalls = 0;
    sandbox.renderCurrent = () => { renderCalls++; };
    sandbox.fetch = async () => ({ headers: { get: (h) => (h === 'date' ? new Date().toUTCString() : null) } });
    try {
      await sandbox.measureCloudClockSkew();
      assert.strictEqual(renderCalls, 1, '홈 탭이면 측정 후 renderCurrent를 한 번 불러야 함');
      assert.notStrictEqual(sandbox.CLOCK_SKEW_MS, null);
    } finally { restore(); }
  });

  test('measureCloudClockSkew: fetch가 실패하거나(네트워크) Date 헤더가 없으면 CLOCK_SKEW_MS를 그대로 두고 renderCurrent도 부르지 않는다', async () => {
    sandbox.CLOUD_UID = 'u1';
    sandbox.CLOCK_SKEW_MS = 123; // 이전에 측정된 값이 있다고 가정
    sandbox.ST = sandbox.ST || {};
    sandbox.ST.tab = 'home';
    sandbox.DB = { settings: {} };
    let renderCalls = 0;
    sandbox.renderCurrent = () => { renderCalls++; };
    try {
      sandbox.fetch = async () => { throw new Error('network down'); };
      await sandbox.measureCloudClockSkew();
      assert.strictEqual(sandbox.CLOCK_SKEW_MS, 123, '네트워크 실패를 시계 오차로 오인해 이전 값을 지우면 안 됨');
      assert.strictEqual(renderCalls, 0);

      sandbox.fetch = async () => ({ headers: { get: () => null } }); // Date 헤더가 없는 응답
      await sandbox.measureCloudClockSkew();
      assert.strictEqual(sandbox.CLOCK_SKEW_MS, 123);
      assert.strictEqual(renderCalls, 0);
    } finally { restore(); }
  });
})();

/* ---------- withTimeout (app-evolve cycle116) ----------
 * boot()/pullCloud()/pushCloud()가 쓰는 supabase-js 호출(SB.auth.getSession()/SB.from(...))은
 * fetch와 달리 signal 옵션이 없어 fetchWithTimeout의 AbortController 방식을 못 쓴다. 대신
 * reject-after 타이머로 감싸, 캡티브 포털·죽은 와이파이·Supabase 응답 지연으로 원래 프로미스가
 * 영원히 pending이어도 호출자가 ms 뒤에 reject를 받아 #app이 빈 화면으로 멈추지 않게 한다.
 * sandbox.setTimeout/clearTimeout은 기본값이 no-op이라, 이 블록에서만 실제 Node 타이머로
 * 잠깐 바꿔주고 매 테스트가 끝나면 원복한다. */
(() => {
  const origSetTimeout = sandbox.setTimeout, origClearTimeout = sandbox.clearTimeout;
  function restoreTimers() { sandbox.setTimeout = origSetTimeout; sandbox.clearTimeout = origClearTimeout; }

  test('withTimeout: 원래 프로미스가 영원히 pending이면 지정 시간 후 reject된다(boot()/afterCloudAuth 무기한 흰 화면 방지)', async () => {
    sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
    try {
      const neverSettles = new Promise(() => {});
      await assert.rejects(sandbox.withTimeout(neverSettles, 10));
    } finally { restoreTimers(); }
  });

  test('withTimeout: 원래 프로미스가 제때 resolve하면 그 값을 그대로 반환하고 타이머를 정리한다', async () => {
    let clearCalls = 0;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = (t) => { clearCalls++; clearTimeout(t); };
    try {
      const r = await sandbox.withTimeout(Promise.resolve({ data: 'ok' }), 50);
      assert.strictEqual(r.data, 'ok');
      assert.strictEqual(clearCalls, 1, '성공 경로에서도 타이머를 정리해야 함');
    } finally { restoreTimers(); }
  });

  test('withTimeout: 원래 프로미스가 제때 reject하면 그 reject를 그대로 전파하고 타이머를 정리한다(타임아웃 에러로 덮어쓰지 않음)', async () => {
    let clearCalls = 0;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = (t) => { clearCalls++; clearTimeout(t); };
    try {
      const origErr = new Error('network down');
      await assert.rejects(sandbox.withTimeout(Promise.reject(origErr), 50), (e) => e === origErr);
      assert.strictEqual(clearCalls, 1, '실패 경로에서도 타이머를 정리해야 함');
    } finally { restoreTimers(); }
  });

  test('withTimeout: ms를 생략하면 기본 8000ms를 타임아웃으로 쓴다', async () => {
    let capturedMs = null;
    sandbox.setTimeout = (fn, ms) => { capturedMs = ms; return setTimeout(fn, ms); };
    sandbox.clearTimeout = clearTimeout;
    try {
      await sandbox.withTimeout(Promise.resolve(1));
      assert.strictEqual(capturedMs, 8000);
    } finally { restoreTimers(); }
  });
})();

test('CDN 리소스: pretendard/kakao/supabase 태그가 pinned 버전과 crossorigin을 유지한다(SRI 준비 회귀 방지)', () => {
  assert.ok(
    src.includes('crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"'),
    'pretendard link 태그의 pinned 버전(v1.3.9) 또는 crossorigin이 누락되었습니다'
  );
  assert.ok(
    src.includes('src="https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js" crossorigin="anonymous"'),
    'kakao.min.js 태그의 pinned 버전(2.7.4) 또는 crossorigin이 누락되었습니다'
  );
  assert.ok(
    src.includes('src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js" crossorigin="anonymous"'),
    'supabase.js 태그의 pinned 버전(2.45.4) 또는 crossorigin이 누락되었습니다'
  );
});

test('dpMonthBlock: 날짜 선택기의 일(day) 버튼에 연·월이 포함된 aria-label이 있다(여러 달이 동시에 DOM에 붙어 "15" 같은 숫자만으로는 스크린리더가 어느 달의 15일인지 구분 못 함)', () => {
  const body = extractFunction('dpMonthBlock');
  assert.ok(
    /aria-label="\$\{y\}년 \$\{m\}월 \$\{dn\}일"/.test(body),
    'dpMonthBlock의 일 버튼에 연/월/일을 모두 담은 aria-label이 없음'
  );
  assert.ok(
    /isToday\?' aria-current="date"':''/.test(body),
    '오늘 날짜 셀에 aria-current="date"가 없음'
  );
  assert.ok(
    /aria-pressed="\$\{sel\}"/.test(body),
    '선택된 날짜 셀에 aria-pressed 상태가 반영되지 않음'
  );
});
test('dpPick: 날짜를 다시 선택하면 이전 선택 셀의 aria-pressed가 false로 풀리고 새 선택 셀만 true가 된다', () => {
  const body = extractFunction('dpPick');
  assert.ok(
    body.includes(`c.classList.remove('sel');c.setAttribute('aria-pressed','false')`),
    'dpPick이 기존 선택 셀들의 aria-pressed를 false로 되돌리지 않음'
  );
  assert.ok(
    body.includes(`cell.classList.add('sel');cell.setAttribute('aria-pressed','true')`),
    'dpPick이 새로 선택된 셀의 aria-pressed를 true로 설정하지 않음'
  );
});
test('index.html 메인 인라인 <script> 전체가 구문 오류 없이 파싱된다(개별 함수 추출 테스트가 못 잡는 전면 장애 회귀 방지)', () => {
  const mainScript = extractMainScript();
  // 353KB 안팎(2026-09 기준)인 블록이 어쩌다 몇 줄만 추출되면 경계 로직이 깨진 것이므로,
  // "짧아도 유효한 JS라 파싱은 통과"하는 거짓 성공을 막기 위해 크기도 함께 확인한다.
  assert.ok(
    mainScript.length > 100000,
    `extractMainScript가 반환한 블록이 비정상적으로 짧습니다(${mainScript.length}자) — 추출 경계(<script src="logic.js"></script> 직후의 <script>~</script>) 확인 필요`
  );
  assert.doesNotThrow(() => {
    new vm.Script(mainScript, { filename: 'index.html (main inline script)' });
  }, /* 실제 실행은 하지 않는다(브라우저 전역 없이 실행하면 무관한 ReferenceError만 납) — new vm.Script()는
      * 컴파일만 하므로 SyntaxError(짝 안 맞는 backtick/중괄호/괄호 등)만 정확히 잡아낸다. */);
});

if (!stockFns || !ratesFns) {
  test('netlify/functions require 실패로 stock.js/rates.js 테스트를 건너뜀', () => {
    throw new Error('stock.js/rates.js를 require하지 못했습니다 — 위 경고 메시지를 확인하세요');
  });
}

/* ---------- nwChartKeyStep: 순자산/잔액 추이 차트 스크러버(nwhChart·assetBalChart)의
 * ArrowLeft/ArrowRight/Home/End 키가 쓰는 인덱스 계산 (app-evolve cycle142 critique/advance,
 * logic.js). whTargetIdx(위)와 같은 clamp 원칙(wrap 없음)이지만, 시작 전엔 선택된 포인트가 없는
 * 상태(curIdx가 null/-1)가 있다는 점이 다르다 — 차트가 포인터 전용이라 키보드로 처음 들어왔을 땐
 * "현재 보고 있던 포인트"가 없기 때문. */
test('nwChartKeyStep: Home/End는 각각 0과 마지막 인덱스로 이동한다', () => {
  assert.strictEqual(sandbox.nwChartKeyStep(5, 'Home', 12), 0);
  assert.strictEqual(sandbox.nwChartKeyStep(5, 'End', 12), 11);
});
test('nwChartKeyStep: ArrowLeft/ArrowRight는 한 칸씩 이동한다', () => {
  assert.strictEqual(sandbox.nwChartKeyStep(5, 'ArrowLeft', 12), 4);
  assert.strictEqual(sandbox.nwChartKeyStep(5, 'ArrowRight', 12), 6);
});
test('nwChartKeyStep: 양끝을 넘어가면 wrap 없이 그 자리에 고정(clamp)된다', () => {
  assert.strictEqual(sandbox.nwChartKeyStep(0, 'ArrowLeft', 12), 0);
  assert.strictEqual(sandbox.nwChartKeyStep(11, 'ArrowRight', 12), 11);
});
test('nwChartKeyStep: curIdx가 null/-1(아직 아무 포인트도 안 본 상태)이면 마지막(가장 최근) 포인트에서 시작한다', () => {
  assert.strictEqual(sandbox.nwChartKeyStep(null, 'ArrowLeft', 12), 10);
  assert.strictEqual(sandbox.nwChartKeyStep(null, 'ArrowRight', 12), 11);
  assert.strictEqual(sandbox.nwChartKeyStep(-1, 'ArrowLeft', 12), 10);
});
test('nwChartKeyStep: Home/End는 curIdx가 null이어도 그대로 0/len-1을 반환한다', () => {
  assert.strictEqual(sandbox.nwChartKeyStep(null, 'Home', 12), 0);
  assert.strictEqual(sandbox.nwChartKeyStep(null, 'End', 12), 11);
});
test('nwChartKeyStep: len<=0(포인트 없음)이면 항상 -1을 반환한다', () => {
  assert.strictEqual(sandbox.nwChartKeyStep(3, 'ArrowRight', 0), -1);
  assert.strictEqual(sandbox.nwChartKeyStep(null, 'Home', 0), -1);
});
test('nwChartKeyStep: 모르는 key는 curIdx를 그대로 돌려준다(호출부가 "이동 없음"으로 처리)', () => {
  assert.strictEqual(sandbox.nwChartKeyStep(5, 'PageUp', 12), 5);
  assert.strictEqual(sandbox.nwChartKeyStep(null, 'Tab', 12), null);
});

/* ---------- nwhChart/assetBalChart 마크업: 키보드로 스크러버에 닿을 수 있는지(tabindex+onkeydown)
 * 확인하는 회귀 테스트. 포인터 핸들러만 있던 것(app-evolve cycle135/140)을 cycle142에서 고쳤다 —
 * 이 둘이 다시 onpointer*만 남고 키보드 경로가 빠지면 조용히 재발할 수 있어 마크업 자체를 지킨다.
 * (app-evolve cycle147 review: 예전엔 src.includes()로 파일 전체에서 문자열 존재만 봤는데,
 * 그 속성이 실제로 이 div에서 빠져도 같은 문자열이 파일 다른 곳(주석 등)에 남아있으면 거짓으로
 * 통과했다 — extractTag(id)로 이 div의 여는 태그 범위 안에서만 검사하도록 좁혔다.) */
test('nwhChart: tabindex와 키보드 핸들러(onkeydown)가 있다', () => {
  const tag = extractTag('nwhChart');
  assert.ok(tag.includes('tabindex="0"'), 'nwhChart div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="img"'), 'nwhChart div에 role="img"가 없음');
  assert.ok(tag.includes('onkeydown="nwChartPeekKey(event)"'), 'nwhChart div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
});
test('assetBalChart: tabindex와 키보드 핸들러(onkeydown)가 있다', () => {
  const tag = extractTag('assetBalChart');
  assert.ok(tag.includes('tabindex="0"'), 'assetBalChart div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="img"'), 'assetBalChart div에 role="img"가 없음');
  assert.ok(tag.includes('onkeydown="assetBalPeekKey(event)"'), 'assetBalChart div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
});
/* ---------- ledsumLive/histTotLive/histTotals/planBalLive 마크업: nwhChart/assetBalChart와
 * 똑같이 "롱프레스로 다른 값 미리보기" UX를 쓰면서도 onpointer*만 있고 키보드 경로가 전혀 없던
 * 공백(app-evolve cycle160 critique)을 cycle161에서 메웠다 — tabindex+onkeydown이 다시 빠지면
 * 조용히 재발할 수 있어 마크업 자체를 지킨다. extractTag(id)로 각 엘리먼트의 여는 태그
 * 범위 안에서만 검사한다(nwhChart 테스트와 같은 이유). */
test('ledsumLive: tabindex와 키보드 핸들러(onkeydown/onkeyup/onblur)가 있다', () => {
  const tag = extractTag('ledsumLive');
  assert.ok(tag.includes('tabindex="0"'), 'ledsumLive div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="button"'), 'ledsumLive div에 role="button"이 없음');
  assert.ok(tag.includes('onkeydown="sujiPeekKey(event)"'), 'ledsumLive div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('onkeyup="sujiPeekEnd()"'), 'ledsumLive div에 onkeyup이 없음 — 키를 떼도 피크가 끝나지 않음');
  assert.ok(tag.includes('onblur="sujiPeekEnd()"'), 'ledsumLive div에 onblur가 없음 — 포커스를 잃어도 피크가 끝나지 않음');
});
test('histTotLive: tabindex와 키보드 핸들러(onkeydown/onkeyup/onblur)가 있다', () => {
  const tag = extractTag('histTotLive');
  assert.ok(tag.includes('tabindex="0"'), 'histTotLive div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="button"'), 'histTotLive div에 role="button"이 없음');
  assert.ok(tag.includes('onkeydown="histPeekKey(event)"'), 'histTotLive div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('onkeyup="histPeekEnd()"'), 'histTotLive div에 onkeyup이 없음 — 키를 떼도 피크가 끝나지 않음');
  assert.ok(tag.includes('onblur="histPeekEnd()"'), 'histTotLive div에 onblur가 없음 — 포커스를 잃어도 피크가 끝나지 않음');
});
test('planBalLive: tabindex와 키보드 핸들러(onkeydown/onkeyup/onblur)가 있다', () => {
  const tag = extractTag('planBalLive');
  assert.ok(tag.includes('tabindex="0"'), 'planBalLive div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="button"'), 'planBalLive div에 role="button"이 없음');
  assert.ok(tag.includes('onkeydown="planPeekKey(event)"'), 'planBalLive div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('onkeyup="planPeekEnd()"'), 'planBalLive div에 onkeyup이 없음 — 키를 떼도 피크가 끝나지 않음');
  assert.ok(tag.includes('onblur="planPeekEnd()"'), 'planBalLive div에 onblur가 없음 — 포커스를 잃어도 피크가 끝나지 않음');
});
test('histTotals: tabindex와 키보드 핸들러(onkeydown)가 있다(토글형이라 즉시 토글)', () => {
  const tag = extractTag('histTotals');
  assert.ok(tag.includes('tabindex="0"'), 'histTotals div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="button"'), 'histTotals div에 role="button"이 없음');
  assert.ok(tag.includes('onkeydown="rowKeydown(event,histTotToggle)"'), 'histTotals div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
});
/* ---------- m-suji(튜토리얼 가짜 '이번 달 수지' 카드): ledsumLive와 동일한 롱프레스 미리보기
 * UX를 흉내 내는 튜토리얼 전용 목업인데, 실제 ledsumLive가 cycle160에서 받은 키보드 접근성을
 * 못 받아 TW 단계(#m-suji, try:'꾹 눌러봐')가 키보드 사용자에게는 완료 불가능했다(app-evolve
 * cycle161 develop). twScreen의 mSeg 세그먼트 테스트와 같은 이유로 vm 실행 대신 마크업만 지킨다. */
test('m-suji(튜토리얼): tabindex와 키보드 핸들러(onkeydown/onkeyup/onblur)가 있다', () => {
  const tag = extractTag('m-suji');
  assert.ok(tag.includes('tabindex="0"'), 'm-suji div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="button"'), 'm-suji div에 role="button"이 없음');
  assert.ok(tag.includes('onkeydown="mSujiPeekKey(event)"'), 'm-suji div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('onkeyup="mSujiUp()"'), 'm-suji div에 onkeyup이 없음 — 키를 떼도 피크가 끝나지 않음');
  assert.ok(tag.includes('onblur="mSujiUp()"'), 'm-suji div에 onblur가 없음 — 포커스를 잃어도 피크가 끝나지 않음');
});
/* ---------- m-fab(튜토리얼 가짜 '+' FAB): 실제 .fab 버튼은 네이티브 <button>이라 키보드로
 * 바로 닿지만, 이를 흉내 낸 튜토리얼 목업(#m-fab)은 bare <div onclick>이라 TW 단계(try:'+ 버튼을
 * 눌러봐')를 키보드 사용자가 완료할 수 없었다(m-suji와 같은 결함 유형, app-evolve cycle162 develop). */
test('m-fab(튜토리얼): tabindex와 키보드 핸들러(onkeydown)가 있다', () => {
  const tag = extractTag('m-fab');
  assert.ok(tag.includes('tabindex="0"'), 'm-fab div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="button"'), 'm-fab div에 role="button"이 없음');
  assert.ok(tag.includes('onkeydown="rowKeydown(event,mFab)"'), 'm-fab div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
});
/* ---------- swUpdateBar(서비스워커 업데이트 배너): role="button" tabindex="0"을 선언한 이 앱의
 * 다른 모든 요소(pg-row/manage-row/asset-item/next-card/of-row/ha-b/m-fab/histTotals 등)는
 * 예외 없이 onkeydown="rowKeydown(event,...)"를 함께 달지만 swUpdateBar만 빠져 있어, 포인터로는
 * 탭하면 바로 새로고침되는데 키보드로 포커스 후 Enter/Space를 눌러도 아무 일도 일어나지 않았다
 * (app-evolve cycle164 critique → cycle164 advance). */
test('swUpdateBar: tabindex와 키보드 핸들러(onkeydown)가 있다', () => {
  const tag = extractTag('swUpdateBar');
  assert.ok(tag.includes('tabindex="0"'), 'swUpdateBar div에 tabindex="0"이 없음 — 키보드 접근 경로가 빠짐');
  assert.ok(tag.includes('role="button"'), 'swUpdateBar div에 role="button"이 없음');
  assert.ok(tag.includes('onkeydown="rowKeydown(event,reloadForUpdate)"'), 'swUpdateBar div에 onkeydown이 없음 — 키보드 접근 경로가 빠짐');
});
/* sujiPeekKey/histPeekKey/planPeekKey 공통 가드 — extractFunction으로 몸통만 잘라 검사한다.
 * 1) e.target!==e.currentTarget: 카드 안의 다른 버튼(수입/지출/가장 낮을 때 등)에서 버블된
 *    keydown까지 처리하면 그 버튼의 네이티브 Enter/Space 클릭 활성화를 preventDefault가
 *    막아버린다(nc-fix가 겪은 버블링 함정과 동일 원인) — 이걸 보장하는 게 핵심이라 소스에
 *    그 가드가 남아있는지를 지킨다.
 * 2) e.repeat 무시: 키를 누르고 있으면 브라우저가 keydown을 반복 발생시키는데, 매번
 *    Start()를 다시 부르면 안 된다(포인터는 pointerdown이 1회뿐이라 대응 사례가 없음). */
test('sujiPeekKey/histPeekKey/planPeekKey/mSujiPeekKey가 버블링 가드(e.target)와 반복 가드(e.repeat)를 둔다', () => {
  for (const fn of ['sujiPeekKey', 'histPeekKey', 'planPeekKey', 'mSujiPeekKey']) {
    const body = extractFunction(fn);
    assert.ok(body.includes('e.target!==e.currentTarget'), `${fn}에 e.target!==e.currentTarget 버블링 가드가 없음`);
    assert.ok(body.includes('e.repeat'), `${fn}에 e.repeat 가드가 없음 — 키를 누르고 있으면 Start()가 반복 호출됨`);
    assert.ok(body.includes(`if(e.key==='Escape'){${fn.replace('Key','End')}()`) || body.includes("e.key==='Escape'"), `${fn}에 Escape 처리가 없음`);
  }
});
/* histTotDown(롱프레스 450ms)과 키보드(Enter/Space 즉시)가 같은 토글 로직(histTotToggle)을
 * 공유하는지 확인 — 둘이 각자 ST.hist.avgMode를 따로 뒤집으면 한쪽만 고치고 다른 쪽을 잊어버리는
 * 회귀가 생기기 쉽다. */
test('histTotDown/histTotals onkeydown이 같은 histTotToggle을 공유한다', () => {
  assert.ok(extractFunction('histTotDown').includes('histTotToggle'), 'histTotDown이 histTotToggle을 쓰지 않음(롱프레스/키보드가 로직을 공유하지 않음)');
  assert.ok(extractFunction('histTotToggle').includes('ST.hist.avgMode=!ST.hist.avgMode'), 'histTotToggle이 avgMode를 뒤집지 않음');
});
/* assetBalCard의 기간 세그먼트(1개월/3개월/1년/전체)는 DOM을 직접 만지지 않는 순수 문자열 생성
 * 함수지만 assetBalSampleDates 등 FUNCTIONS 목록 밖 의존이 많아 vm 실행 대상이 아니다 — extractFunction
 * 소스 패턴으로 좁혀 aria-pressed/role이 실제로 이 함수가 만드는 segHTML에 있는지 확인한다
 * (app-evolve cycle147 critique/advance, 세그먼트 컨트롤 9곳에 aria-pressed 추가). */
test('assetBalCard: 기간 세그먼트 버튼에 aria-pressed, 래퍼에 role/aria-label이 있다', () => {
  const body = extractFunction('assetBalCard');
  assert.ok(/segHTML=`<div class="seg nwh-seg" role="group" aria-label="[^"]+">/.test(body), 'assetBalCard의 세그먼트 래퍼에 role="group"/aria-label이 없음');
  assert.ok(/class="\$\{preset===p\?'on':''\}" aria-pressed="\$\{preset===p\}" onclick="assetBalPresetSel/.test(body), 'assetBalCard의 세그먼트 버튼에 aria-pressed가 없음');
});
/* nwChartPeekKey/assetBalPeekKey는 둘 다 함수라 extractFunction으로 그 몸통만 정확히 잘라
 * 검사할 수 있다(src.includes처럼 파일 전체를 보지 않음). */
test('nwChartPeekKey/assetBalPeekKey가 nwChartKeyStep을 호출해 다음 인덱스를 고른다', () => {
  assert.ok(extractFunction('nwChartPeekKey').includes('nwChartKeyStep(_nwPeekIdx,e.key,_nwChartPts.length)'), 'nwChartPeekKey가 nwChartKeyStep을 호출하지 않음');
  assert.ok(extractFunction('assetBalPeekKey').includes('nwChartKeyStep(_assetBalPeekIdx,e.key,_assetBalChartPts.length)'), 'assetBalPeekKey가 nwChartKeyStep을 호출하지 않음');
});
/* ---------- nwChartPeekKey 완전 실행형 파일럿: 위 테스트들은 소스 텍스트 패턴만 보지만, 여기선
 * nwChartPeekKey/chartPeekRenderAt을 실제 vm에 태워 ArrowRight 키 이벤트를 흉내 내 호출하고
 * _nwPeekIdx 상태가 실제로 바뀌는지까지 확인한다(app-evolve cycle146 critique가 제안한
 * "완전 실행형 테스트로 가는 길" 파일럿 — 나머지 render/open 함수들은 범위 밖으로 남긴다). */
test('[실행형] nwChartPeekKey(ArrowRight) 키 이벤트는 _nwPeekIdx를 다음 인덱스로 옮긴다', () => {
  const ctx = {
    $: () => null, // chartPeekRenderAt이 스크러버 라인/라벨 엘리먼트를 못 찾아도(null) 안전하게 넘어감
    announceLive: () => {},
    shortDate2: sandbox.shortDate2,
    comma: sandbox.comma,
    daysBetween: sandbox.daysBetween,
    nwChartKeyStep: sandbox.nwChartKeyStep,
    _nwChartPts: [
      { date: '2026-01-01', nw: 100 }, { date: '2026-01-02', nw: 110 }, { date: '2026-01-03', nw: 120 },
    ],
    _nwPeekIdx: null,
  };
  vm.createContext(ctx);
  vm.runInContext([extractFunction('chartPeekRenderAt'), extractFunction('nwChartPeekKey')].join('\n'), ctx);
  let prevented = false;
  ctx.nwChartPeekKey({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.strictEqual(ctx._nwPeekIdx, 2, 'curIdx가 null인 상태에서 ArrowRight면 마지막 포인트(인덱스 2)로 가야 함');
  assert.ok(prevented, 'ArrowRight는 e.preventDefault()를 호출해야 함(스크롤 등 기본 동작 방지)');
  ctx.nwChartPeekKey({ key: 'ArrowLeft', preventDefault: () => {} });
  assert.strictEqual(ctx._nwPeekIdx, 1, '이어서 ArrowLeft면 한 칸 앞(인덱스 1)으로 이동해야 함');
});

/* ---------- refreshNwHistoryCard/assetBalPresetSel 포커스 보존: 기간 세그먼트(1개월/3개월/...)
 * 버튼을 눌렀을 때 innerHTML 재렌더로 그 버튼 자체가 사라지며 포커스가 <body>로 떨어지던 문제
 * (app-evolve cycle142 critique가 러너업으로 남기고 cycle143에서 고침). 두 함수 모두 DOM 전역을
 * 직접 건드려(FUNCTIONS로 추출해 vm에서 실행하지 않음) 위 nwhChart/assetBalChart 마크업
 * 테스트와 같은 소스 패턴 검사로 "재렌더 전 포커스가 카드 안에 있었는지 기억했다가, 재렌더 후
 * 새 preset의 .on 버튼으로 되돌리는 코드"가 빠지지 않았는지 지킨다. */
test('refreshNwHistoryCard: 세그먼트 버튼에 포커스가 있었으면 재렌더 후 새 .on 버튼으로 되돌린다', () => {
  const body = extractFunction('refreshNwHistoryCard');
  assert.ok(body.includes('el.contains(document.activeElement)'), 'refreshNwHistoryCard가 재렌더 전 포커스 위치를 기억하지 않음');
  assert.ok(body.includes(`el.querySelector('.seg button.on')`), 'refreshNwHistoryCard가 재렌더 후 새 .on 버튼을 찾지 않음');
});
test('assetBalPresetSel: 세그먼트 버튼에 포커스가 있었으면 재렌더 후 새 .on 버튼으로 되돌린다', () => {
  const body = extractFunction('assetBalPresetSel');
  assert.ok(body.includes('el.contains(document.activeElement)'), 'assetBalPresetSel이 재렌더 전 포커스 위치를 기억하지 않음');
  assert.ok(body.includes(`el.querySelector('.seg button.on')`), 'assetBalPresetSel이 재렌더 후 새 .on 버튼을 찾지 않음');
});

/* ---------- twScreen(튜토리얼 가짜 화면)의 달력/목록 세그먼트(mSeg) ----------
 * twScreen은 가짜 데이터로 그리는 인터랙티브 튜토리얼 전용 화면이라 실제 DB/렌더 체인과
 * 무관하지만, 버튼 자체는 실제 DOM에 붙어 스크린리더가 읽는다 — 다른 8곳과 같은 공백
 * (class="on"만 있고 aria-pressed 없음)이 똑같이 있었다(app-evolve cycle147 critique/advance,
 * 세그먼트 컨트롤 9곳에 aria-pressed 추가). 의존(TWi/MOWN 등)이 깊어 vm 실행 대신 소스
 * 패턴으로 확인한다. */
test('twScreen: 튜토리얼 화면의 달력/목록 세그먼트 버튼에 aria-pressed, 래퍼에 role/aria-label이 있다', () => {
  const body = extractFunction('twScreen');
  assert.ok(
    /const seg=`<div class="mseg tws-live" id="m-seg" role="group" aria-label="[^"]+">/.test(body),
    'twScreen의 mSeg 래퍼에 role="group"/aria-label이 없음'
  );
  assert.ok(
    /class="\$\{name==='cal'\?'on':''\}" aria-pressed="\$\{name==='cal'\}" onclick="mSeg\('cal'\)"/.test(body),
    'twScreen의 달력 버튼에 aria-pressed가 없음'
  );
  assert.ok(
    /class="\$\{name==='list'\?'on':''\}" aria-pressed="\$\{name==='list'\}" onclick="mSeg\('list'\)"/.test(body),
    'twScreen의 목록 버튼에 aria-pressed가 없음'
  );
});

/* ---------- prefers-reduced-motion이 무한반복 keyframe animation도 멈추는지 ----------
 * 이 미디어쿼리는 CSS 선언이라 vm에서 실행할 수 없어(함수가 아님) src.includes류 정적
 * 텍스트 검사로 확인한다 — cycle146 critique가 경계한 "실행 함수인데 문자열 검사만 하는"
 * 패턴과는 다르다(CSS는 원래 비실행 정적 텍스트). 예전엔 transition-duration만 .01ms로
 * 깎아 .nav-badge.on(warnPulse)/.tw-dot(twGlow)/.tw-try·.tw-hint(twPulse)/.tw-char(twHop)
 * 5곳의 무한반복 keyframe animation은 reduce-motion 설정과 무관하게 계속 돌았다
 * (app-evolve cycle150 critique/advance). */
test('prefers-reduced-motion(reduce)이 transition뿐 아니라 keyframe animation도 전역으로 멈춘다', () => {
  const marker = '@media (prefers-reduced-motion:reduce)';
  const markerStart = src.indexOf(marker);
  assert.ok(markerStart !== -1, 'prefers-reduced-motion:reduce 미디어쿼리를 찾지 못함');
  const openBrace = src.indexOf('{', markerStart);
  let depth = 0, i = openBrace;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const block = src.slice(openBrace, i + 1);
  assert.ok(block.includes('transition-duration:.01ms!important'), 'transition-duration 규칙이 사라짐(기존 동작 유지 확인)');
  assert.ok(block.includes('animation-duration:.01ms!important'), 'animation-duration 오버라이드가 없어 무한반복 keyframe animation이 reduce-motion에서도 계속 돎');
  assert.ok(block.includes('animation-iteration-count:1!important'), 'animation-iteration-count 오버라이드가 없어 infinite animation이 reduce-motion에서도 계속 반복됨');
});

/* ---------- [실행형] FUNCTIONS 커버리지 공백 보강: openSetPinSheet/openChangePinSheet/
 * openDisableAppLockSheet/doForgotPassword/doForgotPasswordLocal/doLogout/doResetAll ----------
 * cycle146 critique가 지적한 "src.includes 거짓 안전감"에 이어 cycle152 critique는 index.html의
 * render, open, do로 시작하는 함수 83개 중 48개가 FUNCTIONS(vm 실제 실행) 밖에 있음을 확인했다.
 * 그중 파급력이 큰 함수들(계정 메뉴의 로그아웃, 초기화, 비밀번호 찾기, PIN 설정/변경/해제 진입점)
 * 일부를 여기서 실제로 실행해 검증한다 — openSheet 자체는 기존처럼 lastSheetHtml만 기록하는
 * 스텁이라, 이 함수들이 그 스텁에 넘기는 html, 인자가 실제로 기대한 모양인지까지 확인할 수 있다.
 * openTxSheet, openRecSheet, renderMenu, openSheet 자체처럼 DOM 전역(classList,
 * requestAnimationFrame, attachDetent 등)에 깊이 엮인 화면 진입점은 범위가 한 사이클을 넘어서므로
 * 다음 cycle의 백로그로 남긴다(renderAssetSheet는 cycle153 advance에서 실제로는 그 정도로
 * DOM 전역에 엮여 있지 않음이 확인돼 FUNCTIONS로 승격됐다 — 위 8595줄 부근 주석 참고). */
test('[실행형] openSetPinSheet: PIN 설정 폼(새 PIN/확인/설정 버튼)을 openSheet에 넘긴다', () => {
  sandbox.lastSheetHtml = null;
  sandbox.openSetPinSheet();
  assert.ok(sandbox.lastSheetHtml.includes('id="pinNewIn"'), '새 PIN 입력칸이 없음');
  assert.ok(sandbox.lastSheetHtml.includes('id="pinNewIn2"'), 'PIN 확인 입력칸이 없음');
  assert.ok(sandbox.lastSheetHtml.includes('onclick="doSetPin()"'), '설정 버튼이 doSetPin()에 연결돼 있지 않음');
});
test('[실행형] openChangePinSheet: PIN 변경 폼(현재/새 PIN/확인/변경 버튼)을 openSheet에 넘긴다', () => {
  sandbox.lastSheetHtml = null;
  sandbox.openChangePinSheet();
  assert.ok(sandbox.lastSheetHtml.includes('id="pinChgCurIn"'), '현재 PIN 입력칸이 없음');
  assert.ok(sandbox.lastSheetHtml.includes('id="pinChgNewIn"'), '새 PIN 입력칸이 없음');
  assert.ok(sandbox.lastSheetHtml.includes('id="pinChgNewIn2"'), 'PIN 확인 입력칸이 없음');
  assert.ok(sandbox.lastSheetHtml.includes('onclick="doChangePin()"'), '변경 버튼이 doChangePin()에 연결돼 있지 않음');
});
test('[실행형] openDisableAppLockSheet: 현재 PIN 입력 후 끄기 버튼을 openSheet에 넘긴다', () => {
  sandbox.lastSheetHtml = null;
  sandbox.openDisableAppLockSheet();
  assert.ok(sandbox.lastSheetHtml.includes('id="pinOffIn"'), '현재 PIN 입력칸이 없음');
  assert.ok(sandbox.lastSheetHtml.includes('onclick="doDisableAppLock()"'), '끄기 버튼이 doDisableAppLock()에 연결돼 있지 않음');
});
test('[실행형] doForgotPassword: Supabase가 설정돼 있지 않으면(sbCfg().url이 빈 값) 로컬 복구(doForgotPasswordLocal) 시트로 바로 넘어간다', () => {
  const lsRawOrig = sandbox._lsRaw;
  sandbox._lsRaw = null; // localStorage에 sb url/key 저장값이 없고 SUPABASE_URL 기본값도 ''라 sbCfg().url===''
  sandbox.lastSheetHtml = null;
  sandbox.auEmailValue = 'local@example.com';
  try {
    sandbox.doForgotPassword();
    assert.ok(sandbox.lastSheetHtml.includes('id="frEmailIn"'), 'Supabase 미설정이면 doForgotPasswordLocal의 복구 코드 입력 시트로 가야 하는데 못 감');
    assert.ok(sandbox.lastSheetHtml.includes('value="local@example.com"'), 'auEmail에 입력했던 이메일이 복구 폼에 그대로 넘어가지 않음');
    assert.ok(sandbox.lastSheetHtml.includes('onclick="doLocalRecover()"'), '복구하기 버튼이 doLocalRecover()에 연결돼 있지 않음');
  } finally {
    sandbox._lsRaw = lsRawOrig;
    sandbox.auEmailValue = undefined;
  }
});
test('[실행형] doForgotPassword: Supabase가 설정돼 있으면(sbCfg().url이 값이 있음) 이메일 재설정 메일 시트를 띄운다', () => {
  const lsRawOrig = sandbox._lsRaw;
  sandbox._lsRaw = 'https://example.supabase.co'; // localStorage.getItem('asset_app_sb_url')이 이 값을 돌려줌
  sandbox.lastSheetHtml = null;
  sandbox.auEmailValue = 'cloud@example.com';
  try {
    sandbox.doForgotPassword();
    assert.ok(sandbox.lastSheetHtml.includes('id="fpEmailIn"'), 'Supabase 설정 상태면 이메일 재설정 메일 시트로 가야 하는데 못 감');
    assert.ok(sandbox.lastSheetHtml.includes('value="cloud@example.com"'), 'auEmail에 입력했던 이메일이 재설정 메일 폼에 그대로 넘어가지 않음');
    assert.ok(sandbox.lastSheetHtml.includes('onclick="doSendResetEmail()"'), '재설정 메일 보내기 버튼이 doSendResetEmail()에 연결돼 있지 않음');
  } finally {
    sandbox._lsRaw = lsRawOrig;
    sandbox.auEmailValue = undefined;
  }
});
test('[실행형] doLogout: 확인 시트에서 로그아웃을 누르면 AUTH.signOut 후 게스트 플래그를 끄고 로그인 화면으로 간다', () => {
  const sessionOrig = sandbox.SESSION, guestOrig = sandbox.GUEST;
  sandbox.SESSION = 'test@example.com';
  sandbox.GUEST = true;
  sandbox.authSignOutCalls = 0;
  sandbox.closeSheetCalls = 0;
  sandbox.showAuthCalls = 0;
  sandbox.confirmSheetCalls = [];
  sandbox._lsSetCalls = [];
  try {
    sandbox.doLogout();
    assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '로그아웃 전 확인 시트를 띄우지 않음');
    assert.strictEqual(sandbox.authSignOutCalls, 0, '확인 전에 벌써 로그아웃돼 버림(확인 없이 바로 실행)');
    sandbox.confirmSheetCalls[0].cb(); // "로그아웃" 확인 버튼을 누른 상태를 흉내냄
    assert.strictEqual(sandbox.authSignOutCalls, 1, '확인 후 AUTH.signOut()을 호출하지 않음');
    assert.strictEqual(sandbox.GUEST, false, '로그아웃 후 GUEST 플래그를 꺼야 함');
    assert.deepStrictEqual(sandbox._lsSetCalls[sandbox._lsSetCalls.length - 1], ['asset_app_guest', '0'], 'localStorage의 게스트 플래그를 0으로 갱신하지 않음');
    assert.strictEqual(sandbox.closeSheetCalls, 1, '로그아웃 후 시트를 닫지 않음');
    assert.strictEqual(sandbox.showAuthCalls, 1, '로그아웃 후 로그인 화면으로 가지 않음');
  } finally {
    sandbox.SESSION = sessionOrig;
    sandbox.GUEST = guestOrig;
  }
});
test('[실행형] doResetAll: 확인 시트에서 초기화를 누르면 DB가 빈 상태로 바뀌고 되돌리기 토스트를 띄운다', () => {
  const dbOrig = sandbox.DB, stOrig = sandbox.ST;
  const originalDb = { owners: ['나'], assets: [{ id: 'a1' }], txns: [{ id: 't1' }], categories: { expense: ['식비'], income: [], saving: [] } };
  sandbox.DB = originalDb;
  sandbox.ST = { tab: 'ledger' };
  sandbox.closeSheetCalls = 0;
  sandbox.goCalls = [];
  sandbox.confirmSheetCalls = [];
  sandbox.lastUndo = null;
  try {
    sandbox.doResetAll();
    assert.strictEqual(sandbox.confirmSheetCalls.length, 1, '초기화 전 확인 시트를 띄우지 않음');
    assert.strictEqual(sandbox.DB, originalDb, '확인 전에 벌써 DB가 바뀌어 버림(확인 없이 바로 실행)');
    sandbox.confirmSheetCalls[0].cb(); // "초기화" 확인 버튼을 누른 상태를 흉내냄
    assert.notStrictEqual(sandbox.DB, originalDb, '확인 후 DB가 emptyDB()로 교체되지 않음');
    // emptyDB()는 vm 샌드박스 안에서 실행돼 그 결과(DB.assets/txns)도 vm realm 배열이다 —
    // 위 recDates 테스트와 같은 이유(host Array와 realm이 달라 deepStrictEqual이 값이 같아도
    // 실패)로 Array.from으로 host realm 배열로 정규화한다.
    assert.deepStrictEqual(Array.from(sandbox.DB.assets), [], '초기화 후 자산이 비어있지 않음');
    assert.deepStrictEqual(Array.from(sandbox.DB.txns), [], '초기화 후 내역이 비어있지 않음');
    assert.strictEqual(sandbox.closeSheetCalls, 1, '초기화 후 시트를 닫지 않음');
    assert.strictEqual(sandbox.ST.tab, 'home', '초기화 후 홈 탭으로 이동하지 않음');
    assert.ok(sandbox.goCalls.includes('home'), '초기화 후 go("home")으로 탭 전환하지 않음');
    assert.ok(sandbox.lastUndo && sandbox.lastUndo.msg === '전체 초기화했어요', '되돌리기 토스트를 띄우지 않음');
    assert.ok(typeof sandbox.lastUndo.undoFn === 'function', '되돌리기 콜백이 없음');
    const resetDb = sandbox.DB;
    sandbox.lastUndo.undoFn(); // "되돌리기"를 누른 상태를 흉내냄
    assert.strictEqual(sandbox.DB, originalDb, '되돌리기를 눌러도 원래 DB로 복원되지 않음');
    assert.notStrictEqual(sandbox.DB, resetDb);
  } finally {
    sandbox.DB = dbOrig;
    sandbox.ST = stOrig;
  }
});

/* ---------- openRateSheet: 금/외화/주식 시세 직접수정 input 3종도 field-clear(×) 관례를 따름
 * (app-evolve cycle162 advance — 이름/귀속/카테고리/인증 등 다른 입력 전부에 이미 적용된
 * field-clear(×) 패턴이 .rate-row 래퍼 때문에 fcWire()의 '.field-clear input' 셀렉터 대상에서
 * 구조적으로 빠져 있었고, <label>/aria-label도 전혀 없어 보유 통화·종목이 여러 개면 스크린리더로
 * 어느 입력이 어느 자산인지 구분이 안 됐다. openSheet()가 fcWire()를 자동 호출하므로(renderAuth와
 * 달리 이 함수는 openSheet()를 통해 열리는 시트라 직접 fcWire() 호출은 불필요) field-clear로
 * 감싸기만 하면 지우기 버튼은 자동 배선된다. openRateSheet는 FUNCTIONS(vm 실행) 목록 밖이라
 * renderAuth/openOwnerManage와 동일하게 extractFunction 소스 문자열 검사로 검증한다. ---------- */
test('openRateSheet: 금(gold) 시세 입력에 aria-label과 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('openRateSheet');
  assert.ok(body.includes('<div class="field-clear"><input id="rateGold" class="num" inputmode="numeric" value="${comma(R.goldPerG)}" aria-label="금 시세"'), '금 시세 입력이 aria-label과 함께 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="금 시세 지우기" onclick="clrInput('rateGold')">`), '금 시세 입력에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('openRateSheet: 외화(fx) 시세 입력에 통화별 aria-label과 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('openRateSheet');
  assert.ok(/const id=`rateFx_\$\{c\}`/.test(body), 'fx 시세 입력에 통화별 고유 id(rateFx_통화코드)가 없음');
  assert.ok(body.includes('<div class="field-clear"><input id="${id}" class="num" inputmode="numeric" value="${comma(R.fx[c]||0)}" aria-label="${c} 환율"'), 'fx 시세 입력이 통화별 aria-label과 함께 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="${'$'}{c} 환율 지우기" onclick="clrInput('${'$'}{id}')">`), 'fx 시세 입력에 fc-x 지우기 버튼의 clrInput 연결이 없음');
});
test('openRateSheet: 주식(stock) 시세 입력에 종목별 aria-label과 field-clear(×) 버튼이 있다', () => {
  const body = extractFunction('openRateSheet');
  assert.ok(/const id=`rateStock_\$\{a\.stockCode\}`/.test(body), 'stock 시세 입력에 종목별 고유 id(rateStock_종목코드)가 없음');
  assert.ok(body.includes('<div class="field-clear"><input id="${id}" class="num" inputmode="numeric" value="${comma(R.stocks[a.stockCode]||0)}" aria-label="${esc(a.name)} 현재가"'), 'stock 시세 입력이 종목별 aria-label과 함께 field-clear로 감싸져 있지 않음');
  assert.ok(body.includes(`<button type="button" class="fc-x" aria-label="${'$'}{esc(a.name)} 현재가 지우기" onclick="clrInput('${'$'}{id}')">`), 'stock 시세 입력에 fc-x 지우기 버튼의 clrInput 연결이 없음');
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
