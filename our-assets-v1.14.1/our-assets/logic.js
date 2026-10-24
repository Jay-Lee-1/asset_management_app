/* 우리의 자산 — 순수 로직 모듈
 * DOM/DB/전역 상태를 전혀 참조하지 않는 순수 함수만 모아둔다. index.html의 메인 인라인
 * <script>보다 먼저 로드되며(일반 전역 함수가 되므로 호출부는 그대로 동작), test/run.js는
 * 이 파일을 정규식 슬라이싱(extractFunction 등) 없이 그대로 읽어 vm에 로드해 테스트한다.
 * 97사이클 동안 쌓인 문자열 추출 메커니즘의 특수 케이스(ASYNC_PREFIX, 순서 강제, LETS 등)에서
 * 완전히 벗어나므로, 앞으로도 조건에 맞는 순수 함수는 index.html 대신 여기로 옮긴다
 * (app-evolve cycle97 critique/advance).
 */

/* ================= DATE / RECURRENCE ================= */
/* 반복이체 1일 등 한국 은행업무일 기준 이벤트의 '오늘'은 기기 로컬 캘린더가 아니라 KST여야 한다 —
 * index.html의 inQuietWindow()가 쓰는 것과 동일한 d.getTime()+9*60*60000 UTC+9 고정 산술(기기
 * 시간대/DST 전환 시각 전부 무관)로 'YYYY-MM-DD'를 뽑는다. todayStr()/TODAY(index.html)는 신규거래
 * 기본 날짜·예산월 경계처럼 정당히 기기-로컬 날짜가 맞는 용도라 그대로 두고, 은행업무일 기준
 * 도래 판정(isDuePending() 등)만 이걸 쓴다(app-evolve cycle237 critique/advance). */
function kstTodayStr(d){
 d=d||new Date();
 const kst=new Date(d.getTime()+9*60*60000);
 return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,'0')}-${String(kst.getUTCDate()).padStart(2,'0')}`;
}
function addDays(s,n){const d=new Date(s+'T00:00:00');d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function daysBetween(a,b){return Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/86400000)}
function shiftWeekend(ds,mode){ /* 주말 조정: earlier=금요일로 당김, later=월요일로 미룸 */
 if(!mode||mode==='none')return ds;
 const dow=new Date(ds+'T00:00:00').getDay();
 if(mode==='earlier'){if(dow===6)return addDays(ds,-1);if(dow===0)return addDays(ds,-2);}
 else if(mode==='later'){if(dow===6)return addDays(ds,2);if(dow===0)return addDays(ds,1);}
 return ds;
}
function recDates(r,from,to){
 const out=[];const end=new Date(((r.endDate&&r.endDate<to)?r.endDate:to)+'T00:00:00');
 const rs=new Date(r.startDate+'T00:00:00');
 /* d>=r.startDate를 여기서 재검사하지 않는다: 모든 호출부가 이미 원본(미조정) 후보 ds가
    ds>=r.startDate일 때만 push(ds)를 부른다. 재검사하면 '이동된' d가 기준이 되어, 시작일이
    주말+weekend='earlier'(당겨서)인 반복거래의 첫 회차가 d<r.startDate로 걸러져 통째로
    유실된다(예: monthly startDate=2024-06-01(토) → shiftWeekend가 2024-05-31로 당기면서
    6월 전체 누락). end 경계(위 주석 참고)와 대칭을 맞춘다. */
 const push=ds=>{const d=shiftWeekend(ds,r.weekend);if(d>=from&&d<=to&&(!r.endDate||d<=r.endDate)&&out[out.length-1]!==d)out.push(d);};
 if(r.freq==='monthly'){
   /* endd 이후 한 달을 더 생성한다: weekend 조정이 달을 넘겨 앞당겨지면(예: 매월 1일+earlier가 전달 말일로 이동) 그 달의 후보를 만들어야만 push()가 올바른 달로 걸러낼 수 있다 */
   let cur=new Date(rs.getFullYear(),rs.getMonth(),1);const endd=new Date(end.getFullYear(),end.getMonth(),1);
   while(true){const y=cur.getFullYear(),m=cur.getMonth()+1;
     const day=r.day==='last'?lastDay(y,m):Math.min(r.day,lastDay(y,m));
     const ds=`${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
     if(ds>=r.startDate)push(ds);
     if(cur>endd)break;
     cur.setMonth(cur.getMonth()+1);}
 }else if(r.freq==='yearly'){
   const mo=rs.getMonth()+1,day=rs.getDate(); /* 2/29 시작 등은 윤년 아닌 해에 clamp (setFullYear 롤오버로 3/1로 밀리는 것 방지) */
   for(let y=rs.getFullYear();;y++){
     const d2=Math.min(day,lastDay(y,mo));
     const raw=new Date(y,mo-1,d2);
     const ds=`${y}-${String(mo).padStart(2,'0')}-${String(d2).padStart(2,'0')}`;
     if(ds>=r.startDate)push(ds);
     if(raw>end)break; /* end를 넘긴 해도 한 번 더 생성해 weekend 조정으로 앞당겨지는 경우를 놓치지 않는다 */
   }
 }else{
   const step=r.freq==='daily'?1:7;
   let cd=new Date(rs);
   /* from 이전 회차는 어차피 push()가 버리므로, weekend 조정(최대 ±2일) 여유를 둔 지점까지는
      건너뛰고 스캔을 시작한다 — 오래전 시작된 daily/weekly 반복거래를 매번 처음부터 순회하지 않기 위함.
      결과(out)는 최적화 전후로 동일해야 하며(behavior-preserving), 오직 시작점만 앞당긴다. */
   const target=addDays(from,-2);
   if(target>r.startDate){
     const diffDays=Math.round((new Date(target+'T00:00:00')-rs)/86400000);
     const k=Math.floor(diffDays/step);
     if(k>0)cd.setDate(cd.getDate()+k*step);
   }
   while(true){const ds=`${cd.getFullYear()}-${String(cd.getMonth()+1).padStart(2,'0')}-${String(cd.getDate()).padStart(2,'0')}`;
     if(ds>=r.startDate)push(ds);
     if(cd>end)break; /* 위와 동일한 이유로 end 이후 한 회차를 더 생성 */
     cd.setDate(cd.getDate()+step);}
 }
 return out.sort();
}
/* 반복 내역 관리 화면(openRecManage/index.html)의 반복 주기 요약 레이블 — monthly는 r.day
 * 필드로 '매월 15일'/'매월 말일'까지 구체적으로 보여주는데, weekly/yearly는 각각 요일/월일이
 * recDates()에서 r.startDate로부터 그대로 파생되는데도(위 recDates의 yearly mo/day, weekly의
 * step=7 기준) 레이블은 그냥 '매주'/'매년'으로만 떠서 monthly와 구체성이 어긋나 있었다 — 특히
 * 같은 유형(지출/수입 등) 안에 요일이 다른 매주 반복이 여러 개면(예: 매주 월요일 용돈 vs 매주
 * 금요일 장보기) 목록만 보고는 서로 구분할 수 없었다(app-evolve cycle192 develop). startDate가
 * 있으면(정상 데이터는 항상 있음, 방어적으로만 없을 때 폴백) 요일/월일을 덧붙인다. */
function recFreqLabelStr(freq,day,startDate){
 if(freq==='monthly')return `매월 ${day==='last'?'말일':day+'일'}`;
 if(freq==='daily')return '매일';
 if(!startDate)return freq==='weekly'?'매주':'매년';
 const d=new Date(startDate+'T00:00:00');
 if(isNaN(d))return freq==='weekly'?'매주':'매년';
 if(freq==='weekly')return `매주 ${['일','월','화','수','목','금','토'][d.getDay()]}요일`;
 return `매년 ${d.getMonth()+1}월 ${d.getDate()}일`;
}
/* 반복 종료 조건: 횟수 ↔ 종료일 (엔진 recDates 재사용 → 규칙 100% 일치) */
function addMonthsStr(ds,m){const d=new Date(ds+'T00:00:00');d.setMonth(d.getMonth()+m);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function recNthDate(base,n){ /* n번째 반복 날짜 */
 n=Math.min(999,Math.max(0,Number(n)||0));if(n<1||!base.startDate)return null;
 const f=base.freq||'monthly';
 const rbase={freq:f,day:base.day,startDate:base.startDate,endDate:null,weekend:base.weekend};
 /* 아래 버퍼(+2단위)는 "후보 n+2개를 만들면 결과도 n+2개 안팎"이라는 가정인데, freq='daily'+
    weekend='earlier'|'later'에서는 토/일 후보가 평일로 당겨지거나 미뤄지면서 그 평일에 이미 push된
    날짜와 같아져 recDates()의 인접 중복 제거(push())로 사라진다 — 주 7일 중 2일이 매번 다른 날과
    겹쳐 사실상 5일치만 남으므로, 후보 개수와 결과 개수가 7:5 비율로 어긋난다. UI는 weekend를
    freq==='monthly'일 때만 노출하고(recFreq가 그 외 주기로 바꿀 때마다 'none'으로 되돌림) 백업/원격
    데이터도 sanitizeBackup이 같은 불변식을 강제해 지금은 freq='daily'+weekend!=='none'이 실제로
    저장되지 않지만, recNthDate는 그 전제에 기대지 않고 받은 그대로 정확히 동작해야 하는 순수
    엔진 함수다(주석의 "100% 일치" 약속) — 버퍼가 부족하면 결과가 n개에 못 미쳐 ds[n-1]이
    undefined(null)가 되고, "반복 횟수" 종료조건이 조용히 끝없이 반복(endDate 미설정)으로
    새 버려진다. 결과가 n개에 못 미치면 버퍼를 두 배씩 늘려 다시 생성한다(평일은 매주 최소 5일
    나오므로 항상 수렴, span 상한은 방어적 안전장치일 뿐 정상 입력에서는 첫 시도에 바로 끝난다). */
 let span=1,ds=[];
 do{
  let to;
  if(f==='monthly')to=addMonthsStr(base.startDate,(n+2)*span);
  else if(f==='yearly')to=addMonthsStr(base.startDate,(n+2)*12*span);
  else if(f==='weekly')to=addDays(base.startDate,(n+2)*7*span);
  else to=addDays(base.startDate,(n+2)*span);
  ds=recDates(rbase,base.startDate,to);
  span*=2;
 }while(ds.length<n&&span<=64);
 return ds[n-1]||null;
}
function recCountUntil(base,endDate){ /* 시작일~종료일 사이 반복 횟수 */
 if(!endDate||!base.startDate)return null;
 return recDates({freq:base.freq||'monthly',day:base.day,startDate:base.startDate,endDate:null,weekend:base.weekend},base.startDate,endDate).length;
}
function truncateRecEnd(base,cutoffDate){ /* 반복을 cutoffDate까지로 자를 때 endDate·count를 항상 함께 맞춘다 — count 없이 endDate만 남으면 clampRecurringToMaturity()가 이 명시적 절단을 자기 auto-clamp로 오인해 나중에 만기 연장 시 삭제된 회차를 되살린다(recApply/recSave/splitRecurrenceAt이 공유하는 불변식) */
 return {endDate:cutoffDate,count:recCountUntil(base,cutoffDate)};
}
/* 오래된 거래 아카이브(archiveTxnsBefore/index.html)가 cutoffDate 이전 반복거래 발생분을
 * archiveBaselines()로 자산 baseAmount에 흡수한 뒤, 그 반복이 다음 잔액 계산에서 같은 과거
 * 회차를 또 만들어내지 않게 하려면 startDate 자체를 cutoffDate 이후로 당겨야 한다 — 반복거래는
 * DB.txns처럼 실제로 저장/삭제되는 레코드가 아니라 매번 RANGE_FROM부터 recDates()/expandRec()로
 * 즉석 재전개되므로, 베이스라인만 바꾸고 startDate를 그대로 두면 흡수된 과거 회차가 다음 계산에서
 * 또 더해져 이중 계산된다(app-evolve cycle230 critique가 cycle222의 archiveBaselines+UI 연결에서
 * 발견한 공백 — 테스트가 전부 recurrences:[]만 써서 이 경로를 전혀 검증하지 않고 있었다).
 * startDate를 cutoffDate+1 같은 임의의 날짜로 당기면 weekly/yearly처럼 startDate 자체가 요일/월일
 * 기준이 되는 주기가 어긋난다(예: 매주 월요일 반복의 startDate를 화요일로 바꾸면 그 뒤로 전부
 * 화요일 반복이 됨, monthly는 r.day가 별도 필드라 영향 없지만 weekly/yearly는 startDate가 곧 패턴).
 * recDates()가 cutoffDate 다음날부터 생성한 '그 반복 자신의 첫 미래 회차'를 그대로 새 startDate로
 * 쓰면 이미 그 패턴에 맞는 날짜(shiftWeekend 적용 후 값 포함)라 어긋나지 않는다. endDate가
 * cutoffDate 이전이라 미래 회차가 전혀 없으면(이미 끝난 반복) startDate를 cutoffDate+1로만 밀어
 * 더는 아무 날짜도 생성되지 않게 한다 — 끝난 반복이라 보존할 패턴 자체가 없으므로 날짜가
 * 어긋날 일도 없다. horizonDays(기본 400)는 1년 주기(yearly)도 반드시 한 번은 걸리는 여유다.
 * 변경이 필요 없으면(아직 시작 안 한 미래 반복 등) 받은 r.startDate를 그대로 돌려준다 — 호출부가
 * '반환값===r.startDate'로 손댈지 말지 판정한다. */
function recArchiveStartDate(r,cutoffDate,horizonDays){
 horizonDays=horizonDays||400;
 const from=addDays(cutoffDate,1);
 const future=recDates(r,from,addDays(cutoffDate,horizonDays));
 return future.length?future[0]:from;
}

/* ================= OWNER / SPEND ANALYSIS ================= */
/* 거래를 귀속(owner)으로 거른다 — assets는 {id,owner} 배열(DB.assets 그대로 넘기면 됨).
 * owner가 falsy거나 '전체'면 그대로 반환(필터 없음). expense는 출금 자산(fromAssetId)의 owner,
 * income은 입금 자산(toAssetId)의 owner를 기준으로 삼고, transfer/saving은 두 자산 모두 관여하므로
 * fromAssetId를 우선하고 없으면(예: 반복거래 확장 등으로 from이 비어있는 경우) toAssetId로 폴백한다.
 * 기준 자산 자체를 찾을 수 없으면(삭제된 자산 등) 어느 귀속에도 속하지 않는 것으로 보고 제외한다. */
function filterTxnsByOwner(txns,assets,owner){
 if(!owner||owner==='전체')return txns||[];
 const ownerOf=id=>{if(!id)return null;const a=(assets||[]).find(x=>x.id===id);return a?a.owner:null};
 return (txns||[]).filter(t=>{
  let o=null;
  if(t.type==='expense')o=ownerOf(t.fromAssetId);
  else if(t.type==='income')o=ownerOf(t.toAssetId);
  else if(t.type==='transfer'||t.type==='saving')o=ownerOf(t.fromAssetId)||ownerOf(t.toAssetId);
  return o===owner;
 });
}

/* ================= CLOUD MERGE / TOMBSTONE ================= */
/* localArr/remoteArr(둘 다 {id,...,updatedAt?} 배열)를 id 단위로 3-way 병합하는 순수 함수.
 * DB/전역 상태를 전혀 읽지 않아 afterCloudAuth() 밖에서도 그대로 단위 테스트할 수 있다.
 * 규칙: 한쪽에서 삭제(deletedIds에 tombstone timestamp)됐어도 다른 쪽의 살아있는 사본이 그
 * tombstone 이후에 수정됐으면(updatedAt>ts) "수정이 삭제를 이긴다"로 보고 살려낸다 — 삭제 시각
 * 이전 상태 그대로 남아있으면 진짜로 지워진 것이므로 제외. 양쪽 다 살아있으면 updatedAt이 더 큰
 * 쪽(없으면 0 취급)을 채택, 완전히 같으면 local이 이긴다. 한쪽에만 있으면(tombstone도 없으면)
 * 그대로 채택. */
function mergeCollection(localArr,remoteArr,localDeletedIds,remoteDeletedIds){
 localDeletedIds=localDeletedIds||{};remoteDeletedIds=remoteDeletedIds||{};
 const lMap=new Map((localArr||[]).map(r=>[r.id,r]));
 const rMap=new Map((remoteArr||[]).map(r=>[r.id,r]));
 const ids=new Set([...lMap.keys(),...rMap.keys(),...Object.keys(localDeletedIds),...Object.keys(remoteDeletedIds)]);
 const out=[];
 ids.forEach(id=>{
  const l=lMap.get(id),r=rMap.get(id);
  const delLocalTs=localDeletedIds[id],delRemoteTs=remoteDeletedIds[id];
  if(delLocalTs!=null&&!l){ // 로컬이 지움: remote 사본이 그 이후 수정됐으면 살림
   if(r&&(r.updatedAt||0)>delLocalTs)out.push(r);
   return;
  }
  if(delRemoteTs!=null&&!r){ // 원격이 지움: local 사본이 그 이후 수정됐으면 살림
   if(l&&(l.updatedAt||0)>delRemoteTs)out.push(l);
   return;
  }
  if(l&&r){out.push((l.updatedAt||0)>=(r.updatedAt||0)?l:r);return}
  if(l){out.push(l);return}
  if(r){out.push(r)}
 });
 return out;
}
/* mergeCollection()이 그대로 병합을 수행해버리기 전에, 그 병합이 어느 레코드를 조용히 버릴지
 * 미리 알아내는 순수 헬퍼(app-evolve cycle211 critique) — local/remote 양쪽에 같은 id가 있고
 * updatedAt이 서로 다르며(동률이면 mergeCollection은 그냥 local을 쓸 뿐 실제 충돌이 아님) id/updatedAt을
 * 제외한 나머지 필드 중 하나라도 실제로 달라야만(단순히 두 기기가 같은 내용을 다른 시각에 저장한
 * 경우는 손실이 아니므로 제외) "진 쪽의 수정이 버려진다"로 보고 {id,discardedSide,fields}를 반환한다.
 * mergeCollection과 완전히 같은 입력으로 호출하면 그 호출이 실제로 몇 건을 소실시킬지 미리 센 뒤
 * 사용자에게 알릴 수 있다(문서 단위 push-time conflict와 달리 레코드 단위 merge-time 손실은 지금까지
 * CLOUD_SYNC_STATE가 'ok'로 남아 아무 신호가 없었음).
 * fields(실제로 값이 다른 필드명, 정렬됨)는 app-evolve cycle223 advance에서 추가됐다 — cycle211 critique가
 * 제안한 "진 쪽 수정을 필드 단위로 합쳐 살리는" mergeRecordFields(winner,loser) 방식을 실제로 검토한 결과,
 * 레코드별 updatedAt 하나만 있고 필드별 변경 시점이 없는 현재 데이터 모델에서는 "승자가 실제로 건드린
 * 필드"와 "승자가 그냥 안 건드려서 오래전 값 그대로인 필드"를 구분할 근거가 전혀 없어(공통 조상 스냅샷도,
 * 필드별 타임스탬프도 없음) 자동으로 필드를 채워 넣으면 반대의 새 버그(승자가 실제로 되돌린 값을 패자의
 * 오래된 값으로 되살림)를 조용히 만들 위험이 있다고 판단해 보류했다(이 판단 자체를 app-evolve-state.json
 * history에 남겨 다음 critique가 같은 미검증 전제로 재제안하지 않게 함). 진짜 필드 단위 병합은 saveAsset/
 * saveTx 등 모든 쓰기 경로에 "이번에 어떤 필드를 실제로 바꿨는지"부터 먼저 기록해야 가능한, 범위가 훨씬
 * 큰 별도 작업이다. 그 전 단계로, 손실 경고에 "무엇이 덮어써졌는지"(필드명)까지 보여주면 사용자가 적어도
 * 어느 값을 다시 확인해야 할지 알 수 있어 안전하게 가치를 더한다. */
function mergeCollectionConflicts(localArr,remoteArr){
 const lMap=new Map((localArr||[]).map(r=>[r.id,r]));
 const rMap=new Map((remoteArr||[]).map(r=>[r.id,r]));
 const out=[];
 lMap.forEach((l,id)=>{
  const r=rMap.get(id);
  if(!r)return;
  const lu=l.updatedAt||0,ru=r.updatedAt||0;
  if(lu===ru)return;
  const keys=new Set([...Object.keys(l),...Object.keys(r)]);
  keys.delete('id');keys.delete('updatedAt');
  const fields=[];
  for(const k of keys){if(JSON.stringify(l[k])!==JSON.stringify(r[k]))fields.push(k)}
  if(!fields.length)return;
  out.push({id,discardedSide:lu>=ru?'remote':'local',fields:fields.sort()});
 });
 return out;
}
/* 반복거래(recurrences) 전용 3-way 병합 — id/tombstone 판정(동시 삭제·복원)은 mergeCollection과
 * 완전히 동일하지만, 양쪽 다 살아있는 같은 id 레코드를 통째로 승자/패자로 가르는 mergeCollection과
 * 달리 skip[]/edits{}/confirmedDates[]만은 합쳐서 보존한다. 이 세 필드는 레코드 저장 한 번이 아니라
 * 여러 독립된 사용자 행동(개별 회차 삭제/수정/확인)으로 누적되는 하위 필드라, updatedAt 하나로
 * 레코드 전체의 승/패를 가르면 진 쪽이 그동안 쌓아온 개별 삭제·수정·확인이 경고 없이 통째로
 * 사라진다(app-evolve cycle177 critique — 가족 공유/다기기 동기화에서 두 기기가 오프라인 중 같은
 * 반복거래의 서로 다른 회차를 각자 skip/edit/confirm한 뒤 동기화하면 재현). day/freq/startDate/
 * weekend/amount 등 나머지 스칼라 필드는 mergeCollection과 동일하게 updatedAt이 더 큰 쪽(동률이면
 * local)을 그대로 쓴다. skip/confirmedDates는 Set 합집합(mergeNameList와 동일한 '값 기준 중복
 * 제거'), edits는 날짜 키 유니온에 같은 키가 양쪽에서 다르게 수정됐으면 local이 이기는
 * mergeBudgetHistory와 동일한 관례를 따른다(항목별 updatedAt이 없어 다른 기준으로 승패를 가를 수
 * 없음). base로 고른 쪽의 day/freq/startDate/weekend가 진 쪽과 다르면 합쳐진 skip/edits/
 * confirmedDates 중 일부가 그 새 스케줄에서 더는 생성되지 않는 날짜일 수 있는데, 그 정리는
 * recDates()에 RANGE_FROM/RANGE_TO가 필요해 이 순수 함수 밖(index.html의 mergeRemoteDataIntoLocal,
 * pruneOrphanRecOverrides 호출부)에서 병합 직후 맡는다. */
function mergeRecurrences(localArr,remoteArr,localDeletedIds,remoteDeletedIds){
 localDeletedIds=localDeletedIds||{};remoteDeletedIds=remoteDeletedIds||{};
 const lMap=new Map((localArr||[]).map(r=>[r.id,r]));
 const rMap=new Map((remoteArr||[]).map(r=>[r.id,r]));
 const ids=new Set([...lMap.keys(),...rMap.keys(),...Object.keys(localDeletedIds),...Object.keys(remoteDeletedIds)]);
 const out=[];
 ids.forEach(id=>{
  const l=lMap.get(id),r=rMap.get(id);
  const delLocalTs=localDeletedIds[id],delRemoteTs=remoteDeletedIds[id];
  if(delLocalTs!=null&&!l){
   if(r&&(r.updatedAt||0)>delLocalTs)out.push(r);
   return;
  }
  if(delRemoteTs!=null&&!r){
   if(l&&(l.updatedAt||0)>delRemoteTs)out.push(l);
   return;
  }
  if(l&&r){
   const base=(l.updatedAt||0)>=(r.updatedAt||0)?l:r;
   const skip=[...new Set([...(l.skip||[]),...(r.skip||[])])];
   const edits=Object.assign({},r.edits||{},l.edits||{}); // 동일 키 충돌 시 local 우선(mergeBudgetHistory와 동일 관례)
   const confirmedDates=[...new Set([...(l.confirmedDates||[]),...(r.confirmedDates||[])])];
   out.push(Object.assign({},base,{skip,edits,confirmedDates}));
   return;
  }
  if(l){out.push(l);return}
  if(r){out.push(r)}
 });
 return out;
}
/* mergeCollectionConflicts와 같은 목적(mergeCollection이 실제로 병합을 수행하기 전에 그 병합이 몇 건을
 * 조용히 버릴지 미리 세기)이지만 DB.recurrences 전용 — mergeRecurrences()가 skip/edits/confirmedDates는
 * 합집합으로 보존해 이 셋만 다른 경우는 실제 손실이 아니므로 diff 대상에서 제외하고, day/amount/freq/
 * startDate/endDate/weekend/category/fromAssetId/toAssetId 등 나머지 스칼라 필드(mergeRecurrences가
 * updatedAt 승자독식으로 처리하는 부분)만 비교한다. 이 셋을 빼지 않으면 '스케줄은 똑같고 skip/
 * confirmedDates 회차만 서로 다른' 정상적인 합집합까지 가짜 충돌(과탐)로 잡아버린다 — mergeDataLoss
 * 경고가 실제로 아무것도 잃지 않은 상황에서도 뜨면 사용자가 경고 자체를 신뢰하지 않게 되므로 과탐
 * 방지가 과소탐지보다 더 중요하다(app-evolve cycle238 critique/advance — mergeRemoteDataIntoLocal이
 * txns/assets/goals/inquiries/assetQtyLog 5개만 mergeCollectionConflicts로 다루고 recurrences는
 * "mergeRecurrences가 이미 피해간다"는 잘못된 전제로 빠져 있던 공백을 메운다). */
function mergeRecurrenceConflicts(localArr,remoteArr){
 const lMap=new Map((localArr||[]).map(r=>[r.id,r]));
 const rMap=new Map((remoteArr||[]).map(r=>[r.id,r]));
 const out=[];
 lMap.forEach((l,id)=>{
  const r=rMap.get(id);
  if(!r)return;
  const lu=l.updatedAt||0,ru=r.updatedAt||0;
  if(lu===ru)return;
  const keys=new Set([...Object.keys(l),...Object.keys(r)]);
  keys.delete('id');keys.delete('updatedAt');keys.delete('skip');keys.delete('edits');keys.delete('confirmedDates');
  const fields=[];
  for(const k of keys){if(JSON.stringify(l[k])!==JSON.stringify(r[k]))fields.push(k)}
  if(!fields.length)return;
  out.push({id,discardedSide:lu>=ru?'remote':'local',fields:fields.sort()});
 });
 return out;
}
/* 이름 목록(카테고리/귀속) 병합의 바탕 — id가 없는 순수 문자열 배열이라 mergeCollection의
 * id/updatedAt 톰스톤 방식을 그대로 쓸 수 없다. local 순서를 그대로 유지하고, remote에만
 * 있는 이름 중 normalize(정규화) 기준으로 local에 이미 없는 것만 뒤에 덧붙인다(addCat/addOwner가
 * normName()으로 중복을 막는 것과 동일한 기준). 삭제는 다루지 않는 순수 union이라, 이 함수
 * 자체만 쓰면 한쪽 기기에서 지운 이름이 아직 지우지 않은 다른 기기와 동기화되는 순간 되살아난다
 * (app-evolve cycle179 critique) — mergeRemoteDataIntoLocal은 이제 아래 mergeNameListWithTombstones를
 * 쓰고, 이 함수는 그 안전장치(툼스톤 적용 결과가 비면 폴백)로만 남는다. */
function mergeNameList(localArr,remoteArr,normalize){
 localArr=localArr||[];remoteArr=remoteArr||[];
 const seen=new Set(localArr.map(normalize));
 const out=localArr.slice();
 remoteArr.forEach(name=>{const key=normalize(name);if(!seen.has(key)){seen.add(key);out.push(name)}});
 return out;
}
/* 이름 목록(카테고리/귀속) 병합 — DB.deletedIds에 남긴 합성 키(owner:<normName>, cat:<type>:<normName>,
 * mergeRemoteDataIntoLocal 호출부 참고)로 '삭제된 이름'을 판정해 mergeNameList의 순수 union에서
 * 제외한다. deletedIds는 호출 시점에 이미 local/remote 양쪽 톰스톤이 max-timestamp로 합쳐진 뒤이므로
 * (mergeRemoteDataIntoLocal이 DB.txns 등을 병합하기 전에 먼저 합치는 것과 동일한 전제) 여기선 그냥
 * 존재 여부만 본다 — 레코드 id 톰스톤처럼 "그 이후 수정했으면 삭제를 이긴다"는 되살림 규칙은 두지
 * 않는다(이름에는 updatedAt이 없어 "그 이후"를 판정할 기준 자체가 없고, 카테고리/귀속이 삭제돼도
 * 그 이름을 참조하던 기존 내역·자산은 그대로 남는 걸 doDeleteCat/goalOwnerEff/ST.assetOwner 등이
 * 이미 지원하므로 — 최악의 경우도 "그 이름으로 더는 못 고름"이지 데이터 손상이 아니다). 재추가하면
 * addOwner/addCat이 해당 키의 톰스톤을 지워 다음 병합부터 다시 살아나게 한다. 툼스톤을 전부 적용한
 * 결과가 비면(카테고리/귀속이 0개가 되는 불변식 위반) mergeNameList의 순수 union으로 폴백한다. */
function mergeNameListWithTombstones(localArr,remoteArr,deletedIds,tombstoneKeyFn,normalize){
 localArr=localArr||[];remoteArr=remoteArr||[];deletedIds=deletedIds||{};
 const isTombstoned=name=>tombstoneKeyFn(name) in deletedIds;
 const out=localArr.filter(name=>!isTombstoned(name));
 const seen=new Set(out.map(normalize));
 remoteArr.forEach(name=>{
  const key=normalize(name);
  if(seen.has(key)||isTombstoned(name))return;
  seen.add(key);out.push(name);
 });
 return out.length?out:mergeNameList(localArr,remoteArr,normalize);
}
/* 예산 이력(카테고리→[{from,amount}]) 병합 — 각 카테고리별로 local/remote 항목을 from(월) 키로
 * 유니온한다. 같은 (카테고리,from)이 양쪽에 다른 금액으로 있으면(동시에 같은 달 예산을 고쳤을 때)
 * 이 값 자체엔 mergeCollection처럼 항목별 updatedAt이 없어 승패를 가릴 다른 기준이 없으므로,
 * mergeCollection의 "updatedAt 동률이면 local이 이긴다" 관례를 그대로 따라 local을 우선한다.
 * setBudgetFrom()과 동일하게 from 오름차순으로 재정렬해 반환한다.
 * deletedIds/tombKeyFn(둘 다 선택)은 mergeNameListWithTombstones와 동일한 합성 키 방식으로
 * '삭제된 카테고리'를 판정해 그 카테고리의 예산 한도 전체(local 자신의 사본 포함)를 결과에서
 * 제외한다(app-evolve cycle180 critique/cycle181 advance) — 이전엔 카테고리 이름 자체는
 * mergeNameListWithTombstones로 톰스톤되는데, 같은 이름으로 키잉되는 이 보조 맵은 순수
 * key-union이라 톰스톤을 전혀 몰라, doDeleteCat이 지운 예산 한도가 아직 그 삭제를 모르는
 * 다른 기기와 병합하는 순간 되살아났다. tombKeyFn을 안 넘기면(과거 호출 호환) 톰스톤 판정을
 * 건너뛰고 이전과 동일하게 동작한다. */
function mergeBudgetHistory(localMap,remoteMap,deletedIds,tombKeyFn){
 localMap=localMap||{};remoteMap=remoteMap||{};deletedIds=deletedIds||{};
 const isTombstoned=tombKeyFn?(cat=>tombKeyFn(cat) in deletedIds):(()=>false);
 const out={};
 new Set([...Object.keys(localMap),...Object.keys(remoteMap)]).forEach(cat=>{
  if(isTombstoned(cat))return;
  const merged=new Map((remoteMap[cat]||[]).map(e=>[e.from,e.amount]));
  (localMap[cat]||[]).forEach(e=>merged.set(e.from,e.amount));
  out[cat]=[...merged.entries()].map(([from,amount])=>({from,amount})).sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:0);
 });
 return out;
}
/* DB.catIcon('타입:이름'→아이콘 키)·DB.catVar('타입:이름'→true, 변동 카테고리)처럼 id도 updatedAt도
 * 없는 평평한 문자열 키 맵을 병합한다(app-evolve cycle125) — mergeRemoteDataIntoLocal이 이전엔 이
 * 두 맵을 아예 병합하지 않고 로컬 값을 그대로 둬서, 한 기기가 오프라인에서 카테고리 아이콘을
 * 고르거나 변동 카테고리로 지정한 뒤 다른 기기가 나중에 병합 경로로 동기화하면 그 변경이 조용히
 * 사라지고(로컬 맵에 없는 키는 버려짐) 뒤이은 push가 사라진 상태를 클라우드에 영구히 되밀었다.
 * mergeBudgetHistory와 동일한 관례(같은 키가 양쪽에 다른 값이면 local이 이김, 한쪽에만 있는 키는
 * 그대로 포함)를 쓰되 항목이 배열이 아니라 단일 값이라 더 단순하다.
 * deletedIds/tombKeyFn(둘 다 선택)은 mergeBudgetHistory와 동일한 이유(app-evolve cycle180
 * critique/cycle181 advance)로 추가됐다 — 삭제된 카테고리의 아이콘/변동 플래그가 톰스톤 없이는
 * 되살아나던 걸 막는다. 안 넘기면(DB.deletedType/DB.deletedBal처럼 톰스톤 개념이 없는 다른 flat
 * map 호출부) 이전과 동일하게 순수 key-union으로 동작한다. */
function mergeFlatMap(localMap,remoteMap,deletedIds,tombKeyFn){
 localMap=localMap||{};remoteMap=remoteMap||{};deletedIds=deletedIds||{};
 const out=Object.assign({},remoteMap,localMap);
 if(tombKeyFn)Object.keys(out).forEach(key=>{if(tombKeyFn(key) in deletedIds)delete out[key]});
 return out;
}
/* DB.rates(fx/stocks/goldPerG 현재 시세)는 txns/assets 같은 id 기반 레코드 모음이 아니라
 * '한 기기가 아는 가장 최신 시세 스냅샷' 통째 하나이므로, mergeCollection류의 레코드별 병합이
 * 아니라 최신 수정 시각(last-write-wins) 하나로 전체를 교체한다 — fx['USD']만 따로 합치면
 * 한쪽 기기의 절반만 최신인 짬뽕 스냅샷이 나와 더 혼란스럽다. mergeRemoteDataIntoLocal()이
 * 지금까지 DB.rates를 전혀 병합하지 않아(app-evolve cycle192 critique), 기기A가 setRate()로
 * 수동 입력한 시세를 push한 뒤 오프라인이던 기기B가 복귀해 병합하면 B의 구닥다리 rates가 그대로
 * 남아 뒤이은 push가 A의 입력을 조용히 덮어썼다. ratesUpdatedAt(수동 입력 포함 모든 변경에서
 * 찍힘)이 없으면 syncRates()가 늘 찍어온 syncedAt으로 대신 비교한다(과거에 저장된 rates가
 * ratesUpdatedAt 없이도 동작하도록). 둘 다 없으면(최초 상태) local을 유지한다. */
function mergeRates(local,remote){
 local=local||{};
 if(!remote)return local;
 const localTs=local.ratesUpdatedAt||local.syncedAt||0;
 const remoteTs=remote.ratesUpdatedAt||remote.syncedAt||0;
 return remoteTs>localTs?remote:local;
}
/* deletedIds는 삭제할 때마다(deleteTxnsUndo 등) 영구히 쌓이기만 하고 지금까지 지우는 경로가
 * 없어 수년 사용하면 무한히 커지고, 매 pushCloud/pullCloud마다 전체가 그대로 오간다. 순수 함수로
 * maxAgeMs(기본 400일)보다 오래된 tombstone만 걸러낸 새 객체를 반환한다(원본 불변). 이 기간이면
 * mergeCollection()의 tombstone 살림 조건(살아있는 사본의 updatedAt>tombstone시각)을 발동시킬 만한
 * '그 사이 동기화 안 된 오프라인 사본'은 이 앱의 실사용 패턴(매일 열어보는 가계부)에서 사실상
 * 없다고 보고 안전하게 지운다. */
function gcTombstones(deletedIds,now,maxAgeMs){
 maxAgeMs=maxAgeMs==null?1000*60*60*24*400:maxAgeMs;
 const out={};
 Object.keys(deletedIds||{}).forEach(id=>{if(now-deletedIds[id]<=maxAgeMs)out[id]=deletedIds[id]});
 return out;
}
/* pushCloud()의 조건부 UPDATE(.eq('updated_at',CLOUD_LAST_SYNCED_AT)) 결과를 어떻게 처리할지 판정하는 순수 로직.
 * matchedRowCount>0: 우리가 마지막으로 본 updated_at 그대로였다는 뜻이므로 그대로 진행(proceed).
 * matchedRowCount===0인데 행 자체가 아직 없으면(첫 push 등) upsert로 폴백(fallback).
 * matchedRowCount===0인데 행은 있으면 그 사이 다른 기기가 이미 갱신한 것이므로 충돌(conflict). */
function decidePushOutcome(matchedRowCount,rowExistedBefore){
 if(matchedRowCount>0)return'proceed';
 return rowExistedBefore?'conflict':'fallback';
}
/* askRelinkDeleted()의 _amLink 잔액 연동 산술을 DB/클로저 의존 없이 분리 — remembered(삭제 시점 잔액,
   결측 시 H로 폴백)/H(재연결된 과거 내역만의 현재 잔액)로 이어갈 기준값과, entered(사용자 입력값) 대비
   갭(오늘 조정 내역용)을 계산해 반환한다 */
function computeRelinkBaseline(remembered,H,entered){
 return {base:Math.round(remembered-H),gap:Math.round(entered-remembered)};
}

/* ================= DATE/FORMAT/BUDGET (cycle111) ================= */
function esc(s){const m={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};return String(s==null?'':s).replace(/[&<>"']/g,c=>m[c])}
/* 카테고리/귀속 이름 중복 비교용 정규화 — 대소문자·연속 공백(전각공백 포함)·한글 조합형(NFD)/완성형(NFC) 차이만
   다른 이름을 같은 이름으로 취급. 저장/표시용 원본 이름은 건드리지 않고 비교할 때만 사용한다. */
function normName(s){return String(s==null?'':s).normalize('NFC').trim().replace(/[\s　]+/g,' ').toLowerCase()}
/* 귀속(owner) 이름으로 쓸 수 없는 예약어 — '전체'/'all'은 "모든 귀속" 센티넬로 여러 화면이
 * 나눠서 쓴다: ST.assetOwner/goalOwnerSel(목표 폼)은 'all', ST.plan.owner/ST.spendOwner/
 * ST.hist.owner(가계부 플랜·지출분석·전체내역)는 '전체'. addOwner()/doRenameOwner()가 중복명만
 * normName()으로 막고 이 두 센티넬 문자열 자체는 막지 않고 있었다 — 사용자가 실제로 "전체"라는
 * 이름으로 귀속을 만들면(한국어 UI에서 충분히 시도할 법한 이름), 그 귀속만 따로 보려는 모든
 * 필터가 '전체 보기'로 오인되어 해당 귀속 전용 화면으로 들어갈 방법이 영구히 사라진다(addCat의
 * ADJUST_CAT 예약어 가드, k==='income'&&old===ADJUST_CAT와 동일한 '예약어 보호' 원칙을 귀속에도
 * 적용). normName()으로 비교해 대소문자/공백/정규화 차이(ALL, 전체 , 전체 등)도 함께 막는다. */
function isReservedOwnerName(v){
 const n=normName(v);
 return n==='전체'||n==='all';
}
function lastDay(y,m){return new Date(y,m,0).getDate()}
function monthEndStr(y,m){return `${y}-${String(m).padStart(2,'0')}-${String(lastDay(y,m)).padStart(2,'0')}`}
function monthStartStr(y,m){return `${y}-${String(m).padStart(2,'0')}-01`}
/* 거래 1건이 카테고리 하나에 묶이지 않고 여러 카테고리로 나뉠 수 있게 하는 선택적 필드
 * t.splits:[{category,amount,memo?}] 를 읽는 공용 헬퍼(app-evolve cycle198 critique/advance) —
 * 마트 한 건에 식비+생활용품이 섞이는 실제 상황에서 "제일 비슷한 카테고리 하나"를 억지로
 * 고르게 하던 데이터 모델 공백을 없앤다. t.splits가 없거나 비었으면 기존과 똑같이
 * t.category/t.amount 단일 쌍을 그대로 반환해(하위호환), spendByCategory 등 집계 함수와
 * matchTxnQuery 같은 검색 함수가 분할 여부와 무관하게 이 헬퍼 하나만 거치면 된다. 최상위
 * t.amount는 분할 여부와 무관하게 늘 전체 합계로 유지해야 한다(assetBalanceSeries 등 잔액
 * 계산은 카테고리와 무관하게 거래 전체 금액만 보므로, 분할 합계가 t.amount와 어긋나면
 * 잔액이 조용히 틀어진다 — saveTx()가 저장 시점에 이 불변식을 검증한다). */
function splitLines(t){
 return (Array.isArray(t.splits)&&t.splits.length)?t.splits:[{category:t.category,amount:t.amount,memo:t.memo}];
}
/* 거래 목록 등에서 카테고리를 한 단어로 보여줄 때 쓰는 라벨 — 분할 거래면 "카테고리 N개"로
 * 뭉뚱그리고(어느 한 카테고리만 대표로 보여주면 나머지가 안 보여 오해를 살 수 있음), 아니면
 * 기존처럼 t.category 그대로. */
function txCatLabel(t){
 const n=splitLines(t).length;
 return n>1?`카테고리 ${n}개`:t.category;
}
/* 메모·카테고리·자산명·금액 검색을 대소문자 구분 없이 매칭(영문 메모/자산명 대비).
 * 금액은 쉼표 없는 숫자 그대로 들어있으므로, 검색어 쪽 쉼표만 지워 "50000"이든 "50,000"이든
 * 똑같이 찾을 수 있게 한다(haystack 쪽까지 쉼표를 지우면 메모/자산명에 들어있는 실제 쉼표가
 * 사라지면서 원래라면 안 걸릴 단어가 우연히 이어 붙어 매칭되는 오탐이 생길 수 있어 제외).
 * 분할 거래(t.splits)는 카테고리/메모가 여러 개로 나뉘므로 splitLines()로 모두 모아
 * haystack에 합친다 — 안 그러면 분할된 두 번째 이후 카테고리/메모로는 검색해도 못 찾는다.
 * normName()과 동일한 이유(app-evolve cycle224 develop)로 hay/q 둘 다 .normalize('NFC')를
 * 거친다 — 한글은 조합형(NFD, 자모가 분리된 코드포인트 나열)과 완성형(NFC, 한 음절=한 코드포인트)
 * 두 형태가 같은 글자를 서로 다른 문자열로 표현하는데(예: "메모".length는 NFC 2, NFD 4),
 * JS의 includes()는 코드포인트를 그대로 비교해 두 형태가 섞이면(예: 과거 macOS/HFS+에서 복사해
 * 붙여넣은 메모·자산명은 NFD로 저장되는 경우가 있음) 검색어와 저장된 글자가 눈에는 완전히
 * 같아 보여도 전혀 매칭되지 않는다. normName()은 카테고리/귀속 '이름' 중복 비교에만 이 정규화를
 * 적용했을 뿐, 자유 텍스트 검색(#histQ 전체내역 검색, 자산 검색)에는 적용된 적이 없었다. */
function matchTxnQuery(t,q,assets){
 if(!q)return true;
 const fa=(assets||[]).find(a=>a.id===t.fromAssetId),ta=(assets||[]).find(a=>a.id===t.toAssetId);
 const amt=t.amount!=null?String(t.amount):'';
 const lines=splitLines(t);
 const cats=lines.map(s=>s.category||'').join(' ');
 const lineMemos=lines.map(s=>s.memo||'').join(' ');
 const hay=(t.memo||'')+' '+cats+' '+lineMemos+' '+(fa?fa.name:(t.fromAssetName||'—'))+' '+(ta?ta.name:(t.toAssetName||'—'))+' '+amt;
 return hay.normalize('NFC').toLowerCase().includes(q.normalize('NFC').toLowerCase().replace(/,/g,''));
}
/* 자산명(+fx 보유통화) 검색 — matchTxnQuery와 동일하게 대소문자 구분 없이 includes로 매칭하고,
 * 같은 이유로 NFC 정규화도 함께 적용한다(위 matchTxnQuery 주석 참고).
 * 자산은 종목코드 같은 별도 필드가 없어 이름이 유일한 식별자이지만(stock은 보유 종목명을
 * name에 직접 쓴다), fx는 화면에 '달러'처럼 이름을 붙여도 실제로 찾는 건 보유 통화(USD 등)인
 * 경우가 많아 currency도 함께 haystack에 넣는다. */
function matchAssetQuery(a,q){
 if(!q)return true;
 const hay=(a.name||'')+' '+(a.currency||'');
 return hay.normalize('NFC').toLowerCase().includes(q.normalize('NFC').toLowerCase());
}
/* 계좌(자산) 단위 거래내역 필터 — assetId가 없으면(전체) 항상 통과, 있으면 보내거나 받은 쪽 중 하나라도 일치해야 함 */
function matchesAssetId(t,assetId){
 if(!assetId)return true;
 return t.fromAssetId===assetId||t.toAssetId===assetId;
}
function budgetKey(y,m){return `${y}-${String(m).padStart(2,'0')}`}
/* budget=0(미설정)이면 진행률은 의미가 없으므로 항상 0으로 clamp — 호출부는 이 경우 전체 대비 비중을 대신 쓴다 */
function budgetProgress(spent,budget){
 if(!budget)return{pct:0,barPct:0,over:false};
 const ratio=spent/budget;
 return{pct:Math.round(ratio*100),barPct:Math.min(100,ratio*100),over:spent>budget};
}

/* ================= GOALS (순자산 목표, 순수) ================= */
/* nwHistory(일별 {date,ta,td,nw,byOwner?} 스냅샷)를 귀속(owner) 하나의 추이로 좁힌다.
 * nwHistoryCard(index.html)의 캐러셀 귀속별 추이 필터와 goalProgress에 넘길 귀속별 nwHistory를
 * 똑같은 byOwner[owner].ta/td 기준으로 계산해야 해서(어느 한쪽만 고치면 "목표"와 "순자산 추이"
 * 카드가 같은 귀속을 보면서도 서로 다른 숫자를 보여주게 됨) 양쪽이 공유하는 순수 함수로 뽑았다.
 * owner가 'all'(또는 생략)이면 가구 전체 집계인 hist를 그대로 돌려준다. */
function nwHistoryForOwner(hist,owner){
 hist=hist||[];
 if(!owner||owner==='all')return hist;
 return hist.filter(p=>p.byOwner&&p.byOwner[owner]).map(p=>{const b=p.byOwner[owner];return {date:p.date,ta:b.ta,td:b.td,nw:b.ta-b.td}});
}
/* 순자산 추이 카드 기간 선택(1개월/3개월/1년/전체). pruneNwHistory가 이미 최근 90일은 일별,
 * 그 이전은 월 1회로 압축해 저장해두므로 preset을 날짜 cutoff로 거르기만 하면 긴 구간도 포인트도
 * 자연히 월 단위로 듬성듬성해져 추가 다운샘플링이 필요 없다(app-evolve cycle135 critique/advance —
 * nwHistoryCard가 항상 hist.slice(-60)으로 최근 60일 고정 스파크라인만 보여주던 공백 해소).
 * today를 안 주면 hist의 마지막 날짜를 기준으로 삼는다(호출부는 항상 TODAY를 넘기므로 실사용에는
 * 영향 없고, 테스트에서 고정된 과거 날짜 데이터를 쓸 때의 기본값 용도). */
function nwHistoryRange(hist,preset,today){
 hist=hist||[];
 if(!hist.length||preset==='all')return hist;
 const end=today||hist[hist.length-1].date;
 const days={m1:30,m3:90,y1:365}[preset]||90;
 const cutoff=addDays(end,-days);
 return hist.filter(h=>h.date>cutoff);
}
/* 순자산 추이 차트에서 탭/드래그한 x좌표(컨테이너 너비 기준 0~1 비율)에 가장 가까운 스냅샷의
 * 인덱스를 찾는다. nwChartPath(index.html)가 쓰는 것과 동일한 '날짜 간격 비례' x좌표 매핑을
 * 그대로 따라야 손가락 위치가 실제로 그려진 점과 맞아떨어진다(포인트 개수 기준 균등분할이면
 * 일별+월별 압축이 섞인 구간에서 어긋남). */
function nwNearestPointIndex(pts,ratio){
 if(!pts||!pts.length)return -1;
 if(pts.length===1)return 0;
 const totalDays=Math.max(1,daysBetween(pts[0].date,pts[pts.length-1].date));
 const target=Math.max(0,Math.min(1,ratio))*totalDays;
 let best=0,bestDist=Infinity;
 pts.forEach((p,i)=>{const dist=Math.abs(daysBetween(pts[0].date,p.date)-target);if(dist<bestDist){bestDist=dist;best=i;}});
 return best;
}
/* target<=0(설정 전/잘못된 값)이면 비율이 무의미하므로, 현재 금액이 있으면 100%, 없으면 0%로 본다
 * (budgetProgress의 '미설정=0%'과 달리 음수 목표는 원래 saveGoal이 막아 생기지 않지만, 방어적으로 처리) */
function goalPct(cur,target){
 if(!(target>0))return cur>0?100:0;
 return Math.max(0,Math.min(100,Math.round(cur/target*100)));
}
/* 순자산 목표 진행률 + 추세 투사. 추세(rate)는 nwHistory 전체가 아니라 최근 trendWindowDays일
 * (기본 90일) 구간의 처음·끝 점으로 하루 평균 증가량을 구해 남은 금액을 나누는 단순 선형 투사
 * (spendTrend류와 동일하게 복잡한 회귀는 쓰지 않음) — debtPayoffProjection(아래)도 동일한 '최근
 * trendWindowDays일' 원칙을 자체 내부 윈도로 공유한다(둘 다 호출부가 넘긴 pts의 기간과 무관하게
 * 투사 기준을 고정). 전엔
 * 설치일부터의 전체 이력 처음·끝만 썼어서, 오래전 가입해 저축 패턴이 바뀐 사용자의 예측이 몇 년치
 * 평균으로 왜곡됐었다(app-evolve cycle168 critique → cycle168 advance). 윈도 안에 2점 미만이면
 * (신규 사용자 등) 전체 이력으로 폴백해 기존 동작을 그대로 유지한다. cur/pct/achieved는 창과 무관하게
 * 항상 최신 스냅샷 기준. 이력이 1개 이하거나 증가세가 0 이하(정체·감소)면 목표 도달 시점을 예측할 수
 * 없으므로 null — '못 간다'를 추측으로 단정하지 않고 모른다고 말하는 쪽을 택함. */
function goalProgress(goal,nwHistory,today,trendWindowDays){
 trendWindowDays=trendWindowDays||90;
 const hist=(nwHistory||[]).filter(h=>h.date<=today);
 const cur=hist.length?hist[hist.length-1].nw:0;
 const target=goal&&goal.targetAmount||0;
 const pct=goalPct(cur,target);
 const remaining=target-cur;
 const achieved=target>0&&cur>=target;
 let projectedDate=null;
 if(!achieved&&remaining>0&&hist.length>=2){
  const last=hist[hist.length-1];
  const cutoff=addDays(last.date,-trendWindowDays);
  const windowed=hist.filter(h=>h.date>cutoff);
  const first=(windowed.length>=2?windowed:hist)[0];
  const days=daysBetween(first.date,last.date);
  const rate=days>0?(last.nw-first.nw)/days:0;
  if(rate>0)projectedDate=addDays(last.date,Math.ceil(remaining/rate));
 }
 return {cur,target,pct,remaining,achieved,projectedDate};
}

/* 목표일이 지났는데도 아직 달성하지 못한 목표인지 — homeAlerts()의 goalBehind 알림은 hist.length>=2(이력
 * 2건 이상)와 !goalHasUnknown(미확인 자산 없음)을 요구해 신규 목표나 미확인 자산이 섞인 목표에는 뜨지 않는데,
 * 목표 화면(goalRowHTML/openGoalsList) 자체에는 그 알림과 무관하게 "목표일이 지났다"는 가장 단순한 사실조차
 * 보여줄 데가 없었다(app-evolve cycle195 develop). 그래서 이 판정은 알림의 그 두 전제를 전혀 요구하지 않고
 * targetDate<today && !achieved만 본다 — targetDate===today(오늘이 목표일)는 아직 지나지 않았으므로 false. */
function goalIsOverdue(targetDate,achieved,today){
 return !!(targetDate&&!achieved&&targetDate<today);
}

/* debt 자산의 상환완료 예상일 투사 — goalProgress와 동일한 '최근 trendWindowDays일(기본 90일) 구간의
 * 처음·끝 두 점 선형투사' 철학을 공유한다. pts는 assetBalanceSeries(assetId,...,sign=-1)가 반환하는
 * 날짜순 {date,bal} 배열을 그대로 받는다(부채 잔액은 양수로 표현되고 갚을수록 줄어듦). 잔액이 이미
 * 0 이하면 완납. 전엔 호출부(assetBalCard)가 넘긴 pts 전체의 처음·끝만 썼는데, pts는 사용자가 차트
 * 기간 세그먼트(1개월/3개월/1년/전체)를 바꿀 때마다 그대로 바뀌므로 '전체'를 고르면 초기 급증분까지
 * 섞여 최근엔 꾸준히 갚고 있어도 왜곡된 투사가 나왔다(app-evolve cycle172 develop). goalProgress와
 * 똑같이 내부에서 자체 윈도를 적용해 호출부가 어떤 기간을 보여주고 있든 투사 기준은 고정한다. 윈도
 * 안에 2점 미만이면(신규 사용자 등) 전체 이력으로 폴백해 기존 동작을 유지한다. 포인트가 2개 미만이거나
 * 처음·끝 구간의 일별 감소율이 0 이하(안 갚고 있거나 오히려 늘고 있음)면 projectedDate:null —
 * goalProgress와 마찬가지로 '못 갚는다'를 추측으로 단정하지 않고 모른다고 말하는 쪽을 택한다. */
function debtPayoffProjection(pts,today,trendWindowDays){
 trendWindowDays=trendWindowDays||90;
 const hist=(pts||[]).filter(p=>p.date<=today);
 if(!hist.length)return {achieved:false,projectedDate:null};
 const last=hist[hist.length-1];
 if(last.bal<=0)return {achieved:true,projectedDate:null};
 let projectedDate=null;
 if(hist.length>=2){
  const cutoff=addDays(last.date,-trendWindowDays);
  const windowed=hist.filter(h=>h.date>cutoff);
  const first=(windowed.length>=2?windowed:hist)[0];
  const days=daysBetween(first.date,last.date);
  const rate=days>0?(first.bal-last.bal)/days:0;
  if(rate>0)projectedDate=addDays(last.date,Math.ceil(last.bal/rate));
 }
 return {achieved:false,projectedDate};
}

/* ================= 매입원가(costBasis) 수량변경 보정 (순수) ================= */
/* fx/gold/stock(isMarketValued)은 가중평균 없이 사용자가 한 번 입력한 총 매입금액 단일값을
 * costBasis로 쓴다(assetGainLoss). saveAsset()이 수량만 바꿔 덮어쓰면 costBasis는 그대로 남아
 * 손익(P/L)이 왜곡된다(app-evolve cycle190 critique) — 수량이 줄어드는 경우(일부 매도/정정)는
 * 평단을 유지한 채 남은 지분만큼 비례 축소하면 사용자 추가 입력 없이도 수학적으로 안전하게
 * 교정할 수 있다. 반대로 수량이 늘어나는 경우(추가매수)는 이번에 얼마를 더 투입했는지 추측할
 * 수 없으므로(goalProgress/debtPayoffProjection과 같은 "모르면 추측하지 않는다" 원칙) 여기서
 * 계산하지 않고 costBasisNeedsUpdate()로 경고만 띄운다. */
function scaleCostBasisForSale(origQty,newQty,costBasis){
 if(!(origQty>0)||!(newQty>0)||!(costBasis>0)||newQty>=origQty)return costBasis;
 return Math.round(costBasis*newQty/origQty);
}
function costBasisNeedsUpdate(origQty,newQty,costBasis){
 return costBasis>0&&newQty>origQty;
}
/* 추가매수(수량 증가) 시 "이번에 추가로 투입한 금액"만 입력받아 원래 매입원가에 더한다 —
 * scaleCostBasisForSale과 반대 방향의 짝. addedAmount<=0/undefined면 추측할 게 없으므로
 * origCostBasis를 그대로 반환(기존 "그대로 두고 경고만" 동작과 호환, app-evolve cycle191 advance) */
function addCostBasisForBuy(origCostBasis,addedAmount){
 if(!(addedAmount>0))return origCostBasis;
 return Math.round((origCostBasis||0)+addedAmount);
}

/* ================= 예산 이월(rollover, 순수) ================= */
/* budgetForMonth(index.html)는 '카테고리→[{from,amount}]' effective-dated flat 값을 그대로 쓰는
 * 월별 고정 한도라, 전달에 못 쓰고 남은 돈이나 초과한 돈이 다음 달 한도에 전혀 반영되지 않는다
 * (app-evolve cycle194 critique) — 흔한 봉투식(envelope) 예산처럼 opt-in 토글이 켜진 카테고리만
 * "전달에 아낀 만큼 이번 달에 더 쓸 수 있다"를 지원한다. 초과분은 0으로 clamp해(이미 초과한 걸
 * 또 다음 달에서 깎으면 두 달 다 압박만 커져 실사용에 안 맞음) 여윳돈만 이월한다. */
function budgetCarry(prevBudget,prevSpent){
 if(!(prevBudget>0))return 0;
 return Math.max(0,prevBudget-(prevSpent||0));
}
/* baseBudget(이번 달 flat 한도)이 0/미설정이면 이월을 더해도 '이번 달에 예산이 생긴 것'처럼
 * 보여선 안 되므로(scaleCostBasisForSale과 같은 "확실한 쪽만 계산" 원칙) 그대로 0을 반환해
 * budgetForMonth()의 기존 "falsy=미설정" 호출부 관례를 깨지 않는다. */
function budgetForMonthEffective(baseBudget,carry){
 if(!(baseBudget>0))return baseBudget;
 return baseBudget+(carry||0);
}

/* ================= ASSET ALLOCATION (자산유형별 비중, 순수) ================= */
/* items: [{type,amount}] — 호출부(allocationCard)가 owner/includeInTotal/부채 제외 필터링과
 * assetEval(DB.rates에 의존하는 index.html 쪽 함수) 평가를 이미 끝낸 뒤 넘긴다(여기선 DB를 몰라야
 * 하므로 assetEval을 직접 부르지 않는다 — nwHistoryForOwner가 DOM/전역 없이 데이터만 받는 것과
 * 동일한 분리). type별로 합산해 amount 내림차순 pct(%)를 매긴다. amount<=0인 항목(가격 미확인
 * fx/gold/stock 등, 또는 마이너스통장처럼 실제 음수인 현금/저축/부동산/연금)은 분모(total)와 집계 맵
 * 둘 다에서 제외한다 — 분모에 음수를 그대로 섞으면(마이너스 잔액이 있을 때) total이 "보이는" 항목들의
 * 합보다 작아져 pct 합이 100%를 넘는 버그가 난다(app-evolve cycle187 critique/advance). total<=0
 * (자산 없음/전부 0 또는 음수가 양수를 상회)이면 비중이 무의미하므로 빈 배열(호출부가 카드 자체를 숨김). */
function assetAllocation(items){
 items=items||[];
 const total=items.reduce((s,it)=>s+(it.amount>0?it.amount:0),0);
 if(!(total>0))return [];
 const map=new Map();
 items.forEach(it=>{if(!(it.amount>0))return;map.set(it.type,(map.get(it.type)||0)+it.amount)});
 return [...map.entries()].map(([type,amount])=>({type,amount,pct:amount/total*100})).sort((a,b)=>b.amount-a.amount);
}

/* ================= PORTFOLIO GAIN/LOSS (투자자산 전체 손익, 순수) ================= */
/* items: [{evalValue,costBasis}] — 호출부(investGainLossCard)가 owner/includeInTotal 필터링과
 * assetEval/rateUnknown 평가(DB.rates에 의존하는 index.html 쪽 함수)를 이미 끝낸 뒤 넘긴다
 * (assetAllocation과 동일한 "여기선 DB를 몰라야 한다" 분리). assetGainLoss(a)(index.html)가
 * 자산 1건의 손익만 계산하고 행별 미니 배지로만 노출되던 공백(app-evolve cycle226 critique)을
 * 메워, 여러 투자자산의 손익을 총평가-총매입 기준으로 합산한다. costBasis>0인 항목만 더한다
 * (assetGainLoss와 동일한 전제 — 매입가 미입력이면 손익 자체를 알 수 없어 0으로 섞으면 안 됨).
 * 대상이 하나도 없으면(costBasis 입력된 투자자산이 전혀 없음) null — 호출부가 카드 자체를 숨긴다. */
function portfolioGainLoss(items){
 items=(items||[]).filter(it=>it.costBasis>0);
 if(!items.length)return null;
 const totalEval=items.reduce((s,it)=>s+it.evalValue,0);
 const totalCost=items.reduce((s,it)=>s+it.costBasis,0);
 const amount=totalEval-totalCost;
 return {totalEval,totalCost,amount,pct:amount/totalCost*100,count:items.length};
}

/* ================= CSV IMPORT (순수) ================= */
/* RFC4180 스타일 CSV 파서. 따옴표로 감싼 필드 안의 콤마/줄바꿈/이스케이프된 큰따옴표("")를
   처리한다(txnsToCSV의 esc()가 만드는 형식과 대칭). BOM 제거, \r\n과 \n 둘 다 줄바꿈으로 인식. */
function parseCSV(text){
 const s=String(text==null?'':text).replace(/^﻿/,'');
 const rows=[];let row=[];let field='';let inQuotes=false;
 for(let i=0;i<s.length;i++){
  const c=s[i];
  if(inQuotes){
   if(c==='"'){if(s[i+1]==='"'){field+='"';i++}else inQuotes=false}
   else field+=c;
  }else{
   if(c==='"')inQuotes=true;
   else if(c===',')row.push(field),field='';
   else if(c==='\r'){/* \r\n의 \r는 무시, 다음 \n이 행을 끊는다 */}
   else if(c==='\n'){row.push(field);rows.push(row);row=[];field=''}
   else field+=c;
  }
 }
 if(field!==''||row.length){row.push(field);rows.push(row)}
 return rows.filter(r=>!(r.length===1&&r[0].trim()===''));
}
function csvDateValid(s){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
 const d=new Date(s+'T00:00:00');
 if(isNaN(d))return false;
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`===s;
}
/* 중복 판정 키 — 날짜/구분/금액/카테고리/보내는·받는 자산(연결된 자산이면 id, 아니면 이름)/메모가
   모두 같으면 같은 내역으로 본다. 같은 파일을 두 번 가져오거나, 이미 앱에 있는 내역을 다시
   가져오려 할 때(예: doExport로 내보낸 CSV를 그대로 재가져오기) 중복 추가를 막기 위함. */
function csvDedupeKey(t){
 return [t.date,t.type,t.amount,t.category||'',
  t.fromAssetName!=null?('n:'+t.fromAssetName):('i:'+(t.fromAssetId||'')),
  t.toAssetName!=null?('n:'+t.toAssetName):('i:'+(t.toAssetId||'')),
  t.memo||''].join('|');
}

/* 선택 모드(일별거래/전체내역)에서 고른 거래들에 카테고리 일괄 변경을 적용할 수 있는지 판정한다
 * (app-evolve cycle136 critique/advance — activeSel()/updateSelBottom()이 전체선택/닫기/삭제
 * 3개뿐이라 일괄 카테고리 변경 경로가 없던 공백 해소). 선택이 비었거나 ids가 실제 거래와 하나도
 * 안 맞으면 reason:'empty', transfer가 하나라도 섞이면 reason:'transfer'(이체는 category가 없는
 * 종류라 카테고리 피커 대상이 아님 — catListOf('transfer')도 항상 []), type(expense/income/saving)이
 * 섞여 있으면 reason:'mixed'(카테고리 집합이 종류별로 달라 하나의 피커로 고를 수 없음). adjust(잔액
 * 조정 자동 생성 거래)가 하나라도 섞이면 reason:'adjust' — editTx()의 openAdjustEdit()과
 * doRenameCat/doDeleteCat 모두 ADJUST_CAT을 사용자가 바꿀 수 없게 막는데, 일괄 변경만 이 가드가
 * 없어 선택 모드로 우회할 수 있던 구멍을 막는다(app-evolve cycle217 develop). 통과하면
 * {ok:true,kind,items}로 피커에 넘길 종류와 실제 적용 대상 거래 배열을 돌려준다. */
function bulkCatTargets(txns,ids){
 const idSet=ids instanceof Set?ids:new Set(ids||[]);
 if(!idSet.size)return{ok:false,reason:'empty'};
 const items=(txns||[]).filter(t=>idSet.has(t.id));
 if(!items.length)return{ok:false,reason:'empty'};
 if(items.some(t=>t.type==='transfer'))return{ok:false,reason:'transfer'};
 if(items.some(t=>t.adjust))return{ok:false,reason:'adjust'};
 if(items.some(t=>Array.isArray(t.splits)&&t.splits.length>1))return{ok:false,reason:'split'}; /* 분할 거래는 카테고리가 여러 개라 하나의 피커로 일괄 변경할 수 없음(app-evolve cycle198 advance) */
 const kind=items[0].type;
 if(items.some(t=>t.type!==kind))return{ok:false,reason:'mixed'};
 return{ok:true,kind,items};
}

/* ================= CAROUSEL INDEX (순수) ================= */
/* wireNwCarousel()의 클론-루프 스크롤 스냅과 동일한 경계 규칙으로, 화살표 키/점 클릭이 요청한
 * 인덱스를 실제 카드 인덱스로 정규화한다. loop(카드가 2장 이상이라 앞뒤에 클론을 붙인 경우)면
 * 양끝을 넘어갈 때 반대쪽으로 감싸고(wrap), loop가 아니면(카드 1장) 0에 고정(clamp)한다.
 * n<=0(카드 없음)이면 항상 0을 반환해 나눗셈/음수 모듈로 문제를 피한다. */
function nwClampIdx(i,n,loop){
 if(!(n>0))return 0;
 if(loop)return ((i%n)+n)%n;
 return Math.max(0,Math.min(n-1,i));
}

/* ================= WHEEL PICKER KEY NAV (순수) ================= */
/* 아이폰 시계식 휠(wh-col)의 ArrowUp/ArrowDown/Home/End 키가 현재 선택 인덱스(cur, 아직 아무것도
 * 선택 안 됐으면 -1)에서 다음에 선택할 인덱스를 고른다. 캐러셀(nwClampIdx)과 달리 휠은 wrap 없이
 * 양끝에서 멈춘다(clamp). n<=0(항목 없음)이면 항상 0. 모르는 key는 cur를 그대로 돌려줘
 * 호출부가 "이동 없음"으로 처리하게 한다. */
function whTargetIdx(cur,n,key){
 if(!(n>0))return 0;
 const c=cur===-1?0:cur;
 if(key==='Home')return 0;
 if(key==='End')return n-1;
 if(key==='ArrowUp')return Math.max(0,c-1);
 if(key==='ArrowDown')return Math.min(n-1,c+1);
 return cur;
}

/* 순자산/잔액 추이 차트 스크러버(nwhChart·assetBalChart)의 ArrowLeft/ArrowRight/Home/End 키가
 * 다음에 보여줄 포인트 인덱스를 고른다. whTargetIdx(위)와 같은 clamp 원칙(wrap 없음)이지만,
 * 이 차트는 포인터 전용이라 시작 시점엔 선택된 포인트가 없다(curIdx가 null/음수) — 이때 처음
 * 방향키를 누르면 가장 최근 포인트(len-1, 차트 맨 오른쪽=오늘)에서 시작해 거기서부터 좌우로
 * 움직이는 게, 포인터로 차트를 짚었을 때 보통 맨 끝부터 보게 되는 것과 가장 가깝다
 * (app-evolve cycle142 critique/advance — 두 차트 스크러버가 onpointer*로만 동작해 키보드/
 * 스위치 접근 사용자는 드릴다운 인터랙션에 전혀 닿을 수 없던 공백 해소). */
function nwChartKeyStep(curIdx,key,len){
 if(!(len>0))return -1;
 if(key==='Home')return 0;
 if(key==='End')return len-1;
 if(key!=='ArrowLeft'&&key!=='ArrowRight')return curIdx;
 const c=(curIdx==null||curIdx<0)?len-1:curIdx;
 if(key==='ArrowRight')return Math.min(len-1,c+1);
 return Math.max(0,c-1);
}

/* ================= ASSET BALANCE HISTORY (개별 자산 잔액 추이, 순수) ================= */
/* from~to 사이를 최대 maxPoints개의 날짜로 균등 샘플링한다(날짜 간격 기준, nwChartPath류와 동일한
 * '일수 비례' 원칙). 구간이 maxPoints보다 짧으면 매일 하나씩(다운샘플링 없이) 반환해 짧은 기간에서
 * 디테일을 잃지 않는다(1개월 보기가 nwHistoryRange처럼 일별이어야 함). from>to면 빈 배열.
 * maxPoints<=1은 호출부(assetBalCard/debtsBehind, 둘 다 항상 60 리터럴)가 실제로 넘기지는
 * 않지만, 이 함수는 로직 전용 파일에 모아둔 재사용 가능한 순수 함수라 평소처럼 입력 자체의
 * 정의역을 가드한다 — maxPoints===1이면 아래 균등분배 분기의 분모(maxPoints-1)가 0이 되어
 * Math.round(0/0)이 NaN이 되고 첫 샘플이 "NaN-NaN-NaN"이라는 깨진 날짜 문자열로 나간다
 * (maxPoints<=0은 루프가 0번 돌아 우연히 안전했던 것과 달리, 정확히 1일 때만 터지는 숨은
 * 0-나누기였다). 1개만 요청하면 구간을 대표하는 to 하나만 돌려준다(maxPoints<=0일 때의 기존
 * 동작과 동일 — 그쪽은 가드가 없어도 안전했지만 모양을 그대로 유지). */
function assetBalSampleDates(from,to,maxPoints){
 if(from>to)return [];
 if(maxPoints<=1)return [to];
 const totalDays=daysBetween(from,to);
 if(totalDays<=maxPoints-1){
  const out=[];for(let i=0;i<=totalDays;i++)out.push(addDays(from,i));return out;
 }
 const out=[];let lastDs=null;
 for(let i=0;i<maxPoints;i++){
  const d=addDays(from,Math.round(i*totalDays/(maxPoints-1)));
  if(d!==lastDs){out.push(d);lastDs=d;}
 }
 if(out[out.length-1]!==to)out.push(to);
 return out;
}
/* 자산 하나의 잔액 추이 — balancesUpTo()(index.html)와 동일한 재생 규칙(기준액 + 날짜순 이체·지출·
 * 수입 누적)을 자산 하나에, 미리 뽑은 날짜 배열(dates, 오름차순)에 대해서만 계산한다. txns는 날짜
 * 정렬 여부 무관(내부에서 정렬), base는 시작 잔액(assetBase(a)), sign은 부채면 -1 그 외 1
 * (balancesUpTo와 동일 규약 — 호출부가 DB 의존 없이 직접 넘긴다). 날짜마다 거래 전체를 처음부터
 * 다시 훑는 대신(O(n*m)) 정렬된 한 번의 순회로 모든 포인트를 계산한다(O(n+m)). dates는 오름차순이어야
 * 포인터 누적이 올바르다(assetBalSampleDates의 출력이 그 조건을 만족). */
function assetBalanceSeries(txns,assetId,base,sign,dates){
 const sorted=(txns||[]).filter(t=>t.fromAssetId===assetId||t.toAssetId===assetId)
   .slice().sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
 let bal=base,ti=0;
 return (dates||[]).map(d=>{
  while(ti<sorted.length&&sorted[ti].date<=d){
   const t=sorted[ti];
   if(t.fromAssetId===assetId)bal-=sign*t.amount;
   if(t.toAssetId===assetId)bal+=sign*t.amount;
   ti++;
  }
  return {date:d,bal};
 });
}

/* ================= OS 알림 신뢰도 (순수) ================= */
/* checkNotifyAlerts()(index.html)는 별도 푸시 서버 없이 로컬 Notification API만 쓰고, 화면이
 * 백그라운드(document.hidden)인 동안만 동작한다(periodicSync/푸시 등록 없음). 토글을 켤 때 뜨는
 * 토스트가 과거 '앱을 닫아둬도 알려드려요'라고 실제 능력보다 과장해 말했던 문제(app-evolve cycle145
 * critique)를 고치기 위해, 실제로 보장되는 범위만 두 등급으로 나눠 문구를 고른다. iOS는 Safari
 * PWA가 백그라운드 탭조차 금방 정지시켜 다른 플랫폼보다 범위가 더 좁다. */
function notifyReliabilityTier(isIOS){
 return isIOS?'foreground-tab':'background-tab';
}
function notifyReliabilityMsg(tier){
 if(tier==='foreground-tab')return '이 기기(iOS)는 앱을 열어둔 동안에만 알림이 와요 · 완전히 종료하면 오지 않아요';
 return '앱을 최근 사용 앱에 남겨두면 받을 수 있어요 · 완전히 종료하면 알림이 오지 않아요';
}

/* ================= TAB NAV HISTORY (순수) ================= */
/* 설치형 PWA(manifest display:standalone)에서 안드로이드 백버튼은 history 스택이 비면 바로 앱을
 * 종료시킨다. _ovHistDepth/ovHistPush()(index.html)는 시트·날짜피커 같은 오버레이를 열 때마다
 * entry를 쌓아 이 문제를 막아왔지만, 하단 탭 전환(go(tab))은 pushState를 전혀 호출하지 않아 같은
 * 버그 클래스가 그대로 남아 있었다(app-evolve cycle138 critique) — 시트가 안 열린 비홈 탭에서
 * 뒤로가기를 누르면 홈으로 안 돌아가고 앱이 종료됨. go(tab)가 이 함수로 매 호출마다 '홈 진입 1단
 * entry'를 push/pop할지 판정한다: 홈→비홈 최초 진입이면 'push'(entry 하나만 쌓음, 이후 비홈↔비홈
 * 전환은 재사용), 비홈→홈 복귀인데 entry가 쌓여 있으면 그 entry를 'pop'(소비), 그 외(이미 쌓인
 * 채로 또 비홈, entry 없이 홈 재진입 등)는 'none'. */
function tabNavAction(tab,alreadyPushed){
 if(tab==='home')return alreadyPushed?'pop':'none';
 return alreadyPushed?'none':'push';
}

/* ================= 클라우드 동기화 시계 오차 (순수) ================= */
/* mergeCollection()(위 3-way 병합)은 충돌 '존재'는 Supabase 서버 updated_at으로 감지해 시계
 * 틀어짐에 안전하지만, 일단 충돌이 감지된 뒤 어느 쪽 수정이 이기는지는 두 기기의 로컬 시계
 * (touch()가 찍는 Date.now())만 비교하는 순수 LWW다. 가족 공유 등 멀티 디바이스 동기화에서
 * 한 기기 시계가 크게 틀리면(배터리 방전, 리셋된 기기, NTP 미동기화 등) 그 기기 수정이 항상
 * 지거나 다른 기기의 최신 수정을 경고 없이 조용히 덮어쓸 수 있다 — 병합 알고리즘 자체를
 * 바꾸는 대신(모든 동기화 레코드 스키마 변경 필요) 감지+경고만 추가한다(app-evolve cycle165
 * critique/advance). measureCloudClockSkew()(index.html)가 Supabase REST 응답의 Date 헤더로
 * 얻은 서버 시각과 이 기기 Date.now()의 차이(driftMs, 기기가 빠르면 양수)를 넘겨준다. */
function clockSkewSeverity(driftMs,warnMs,critMs){
 if(driftMs==null||isNaN(driftMs))return'ok';
 const a=Math.abs(driftMs);
 if(a>=critMs)return'severe';
 if(a>=warnMs)return'warn';
 return'ok';
}
/* shouldWarnStorageSize와 동일한 정책: 'warn'은 한 번 뜨면 dismiss로 가라앉힐 수 있지만,
 * 'severe'는 dismiss 여부와 무관하게 항상 뜬다(방치하다 실제 데이터 손실로 이어지는 걸 막음). */
function shouldWarnClockSkew(severity,dismissed){
 if(severity==='severe')return true;
 if(severity==='warn')return!dismissed;
 return false;
}
/* ================= 테마/강조색 첫 페인트 캐시 (순수) ================= */
/* head 최상단 동기 인라인 스크립트(index.html)가 localStorage의 'asset_app_theme_cache' 키를
 * 읽어 JS 실행 전에도 <html data-theme>/data-accent를 맞춰 그리는데, 쓰는 쪽(migrate/setTheme/
 * applyAccent)마다 같은 payload 모양을 직접 조립하면 한쪽이 키 이름을 잘못 적거나 기본값을 빼먹어도
 * 발견하기 어렵다. themeCachePayload()로 "DB.settings → 캐시에 쓸 값" 변환만 떼어 테스트한다
 * (app-evolve cycle181 advance). */
function themeCachePayload(settings){
 return{themeMode:(settings&&settings.themeMode)||'system',accent:(settings&&settings.accent)||'teal'};
}

/* ================= 오래된 거래 아카이브 (순수) ================= */
/* index.html의 dismissStorageSizeWarn()는 저장공간 경고 시 '오래된 데이터는 백업 후 정리하는
 * 걸 권장해요'라고 안내하지만, 실제로 오래된 거래를 지울 수 있는 유일한 경로(전체내역
 * 일괄삭제, deleteTxnsUndo)는 잔액 보정이 전혀 없다. balancesUpTo()/assetBase()(index.html)는
 * 자산 잔액을 'baseAmount 고정 앵커 + RANGE_FROM부터의 모든 거래 합'으로 계산하므로, cutoffDate
 * 이전 거래를 보정 없이 지우면 그 거래들이 쌓아온 금액이 통째로 사라져 순자산이 조용히
 * 틀려진다(app-evolve cycle221 critique). archiveBaselines()는 각 자산의 cutoffDate 시점
 * 잔액을 balancesUpTo()와 완전히 같은 재생 규칙(기준액 + sign 부호 누적, 부채는 -1)으로
 * 계산해 돌려준다 — 호출부(다음 사이클의 archiveTxnsBefore() 등)가 이 값을 새 baseAmount로
 * 앉히면, cutoffDate 이전 거래를 지워도 잔액이 그대로 보존된다.
 * assets는 {id,type,baseAmount?,amountKRW?} 배열(DB.assets 그대로 넘기면 됨). expandedTxns는
 * 반복거래의 cutoffDate 이전 가상 발생분까지 포함해야 한다(반복거래는 DB.txns에 실제로 기록되지
 * 않고 매번 즉석 전개되므로, 호출부가 DB.txns.concat(expandRec(RANGE_FROM,cutoffDate))처럼
 * 넘겨야 함 — 이 함수는 받은 배열을 그대로 재생할 뿐 반복거래를 스스로 전개하지 않는다).
 * isPendingFn(t)은 balancesUpTo()의 '미확인 이체는 완료 잔액에서 제외' 규칙과 맞추기 위한
 * 선택적 콜백(DB.settings/DB.recurrences를 읽는 index.html의 isPending()은 이 모듈이 직접
 * 참조할 수 없으므로 호출부가 넘겨준다) — 생략하면 모든 거래를 확정된 것으로 본다. */
function archiveBaselines(assets,expandedTxns,cutoffDate,isPendingFn){
 const map={},sign={};
 (assets||[]).forEach(a=>{map[a.id]=a.baseAmount!=null?a.baseAmount:(a.amountKRW||0);sign[a.id]=(a.type==='debt'?-1:1)});
 (expandedTxns||[]).forEach(t=>{
  if(t.date>cutoffDate)return;
  if(isPendingFn&&isPendingFn(t))return;
  if(t.fromAssetId!=null&&map[t.fromAssetId]!=null)map[t.fromAssetId]-=sign[t.fromAssetId]*t.amount;
  if(t.toAssetId!=null&&map[t.toAssetId]!=null)map[t.toAssetId]+=sign[t.toAssetId]*t.amount;
 });
 return map;
}

/* ================= WCAG 명도대비 (순수) ================= */
/* .a-cash/.a-bank만 라이트 테마 전용 어두운 변형(--brand-ink)을 써 WCAG 1.4.11(비텍스트
 * 콘텐츠 3:1)을 넘기는데, 이후 추가된 .a-fx/.a-gold/.a-crypto/.a-save/.a-food/.a-debt/
 * .own-3/.own-4(index.html)는 원색 변수를 그대로 써 라이트 테마에서 기준에 못 미친다
 * (app-evolve cycle224 critique — 실측 a-fx 1.88:1~a-debt 2.92:1, --brand-ink 패턴은
 * 5.48:1). 팔레트를 다시 손볼 때마다 사람이 계산기로 재확인하지 않도록, WCAG 2.x 상대휘도
 * 공식으로 두 hex 색의 명도대비를 돌려주는 순수 함수를 둔다. test/run.js가 각 배지의 최종
 * 라이트테마 fg/bg 쌍을 이 함수로 단언해(아이콘 배지는 >=3, 글자가 들어가는 own-3/own-4는
 * >=4.5) 회귀를 막는다. */
function contrastRatio(hex1,hex2){
 function lin(c){c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4)}
 function lum(hex){hex=String(hex).replace('#','');const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)}
 const l1=lum(hex1),l2=lum(hex2),hi=Math.max(l1,l2),lo=Math.min(l1,l2);
 return(hi+0.05)/(lo+0.05);
}

/* ================= 객체 유틸 (순수) ================= */
/* AUTH.deleteLocalAccountRecord(index.html)가 asset_app_accounts/asset_app_login_fails 맵에서
 * 탈퇴하는 계정 1건만 제거할 때 쓴다 — 원본 obj는 건드리지 않고(불변) key가 없으면 얕은 복사만
 * 돌려준다(app-evolve cycle241 advance). */
function withoutKey(obj,key){
 const r=Object.assign({},obj);
 delete r[key];
 return r;
}
