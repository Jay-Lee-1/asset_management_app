/* 우리의 자산 — 순수 로직 모듈
 * DOM/DB/전역 상태를 전혀 참조하지 않는 순수 함수만 모아둔다. index.html의 메인 인라인
 * <script>보다 먼저 로드되며(일반 전역 함수가 되므로 호출부는 그대로 동작), test/run.js는
 * 이 파일을 정규식 슬라이싱(extractFunction 등) 없이 그대로 읽어 vm에 로드해 테스트한다.
 * 97사이클 동안 쌓인 문자열 추출 메커니즘의 특수 케이스(ASYNC_PREFIX, 순서 강제, LETS 등)에서
 * 완전히 벗어나므로, 앞으로도 조건에 맞는 순수 함수는 index.html 대신 여기로 옮긴다
 * (app-evolve cycle97 critique/advance).
 */

/* ================= DATE / RECURRENCE ================= */
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
 const push=ds=>{const d=shiftWeekend(ds,r.weekend);if(d>=from&&d<=to&&d>=r.startDate&&(!r.endDate||d<=r.endDate)&&out[out.length-1]!==d)out.push(d);};
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
/* 반복 종료 조건: 횟수 ↔ 종료일 (엔진 recDates 재사용 → 규칙 100% 일치) */
function addMonthsStr(ds,m){const d=new Date(ds+'T00:00:00');d.setMonth(d.getMonth()+m);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function recNthDate(base,n){ /* n번째 반복 날짜 */
 n=Math.min(999,Math.max(0,Number(n)||0));if(n<1||!base.startDate)return null;
 const f=base.freq||'monthly';let to;
 if(f==='monthly')to=addMonthsStr(base.startDate,n+2);
 else if(f==='yearly')to=addMonthsStr(base.startDate,(n+2)*12);
 else if(f==='weekly')to=addDays(base.startDate,(n+2)*7);
 else to=addDays(base.startDate,n+2);
 const ds=recDates({freq:f,day:base.day,startDate:base.startDate,endDate:null,weekend:base.weekend},base.startDate,to);
 return ds[n-1]||null;
}
function recCountUntil(base,endDate){ /* 시작일~종료일 사이 반복 횟수 */
 if(!endDate||!base.startDate)return null;
 return recDates({freq:base.freq||'monthly',day:base.day,startDate:base.startDate,endDate:null,weekend:base.weekend},base.startDate,endDate).length;
}
function truncateRecEnd(base,cutoffDate){ /* 반복을 cutoffDate까지로 자를 때 endDate·count를 항상 함께 맞춘다 — count 없이 endDate만 남으면 clampRecurringToMaturity()가 이 명시적 절단을 자기 auto-clamp로 오인해 나중에 만기 연장 시 삭제된 회차를 되살린다(recApply/recSave/splitRecurrenceAt이 공유하는 불변식) */
 return {endDate:cutoffDate,count:recCountUntil(base,cutoffDate)};
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
/* 이름 목록(카테고리/귀속) 병합 — id가 없는 순수 문자열 배열이라 mergeCollection의 tombstone
 * 방식은 쓸 수 없다. local 순서를 그대로 유지하고, remote에만 있는 이름 중 normalize(정규화)
 * 기준으로 local에 이미 없는 것만 뒤에 덧붙인다(addCat/addOwner가 normName()으로 중복을
 * 막는 것과 동일한 기준). 삭제는 병합 대상이 아니다 — 카테고리/귀속 삭제는 사용 중이면 막히므로
 * (doDeleteCat/delOwner) 상대 기기의 '아직 지우지 않은' 상태를 지우는 쪽으로 병합하면 그 기기가
 * 쓰고 있던 값이 사라질 수 있어, 이름이 사라지는 방향은 항상 로컬에서 명시적으로 지운 뒤 다음
 * push로만 반영되게 둔다. */
function mergeNameList(localArr,remoteArr,normalize){
 localArr=localArr||[];remoteArr=remoteArr||[];
 const seen=new Set(localArr.map(normalize));
 const out=localArr.slice();
 remoteArr.forEach(name=>{const key=normalize(name);if(!seen.has(key)){seen.add(key);out.push(name)}});
 return out;
}
/* 예산 이력(카테고리→[{from,amount}]) 병합 — 각 카테고리별로 local/remote 항목을 from(월) 키로
 * 유니온한다. 같은 (카테고리,from)이 양쪽에 다른 금액으로 있으면(동시에 같은 달 예산을 고쳤을 때)
 * 이 값 자체엔 mergeCollection처럼 항목별 updatedAt이 없어 승패를 가릴 다른 기준이 없으므로,
 * mergeCollection의 "updatedAt 동률이면 local이 이긴다" 관례를 그대로 따라 local을 우선한다.
 * setBudgetFrom()과 동일하게 from 오름차순으로 재정렬해 반환한다. */
function mergeBudgetHistory(localMap,remoteMap){
 localMap=localMap||{};remoteMap=remoteMap||{};
 const out={};
 new Set([...Object.keys(localMap),...Object.keys(remoteMap)]).forEach(cat=>{
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
 * 그대로 포함)를 쓰되 항목이 배열이 아니라 단일 값이라 더 단순하다. 삭제는 대상이 아니다 —
 * mergeNameList와 동일한 이유로(doDeleteCat/doRenameCat이 지운 키를 상대 기기의 '아직 안 지운'
 * 값으로 되살리면 그 기기가 쓰던 값이 사라질 수 있음) 키가 사라지는 방향은 로컬에서 명시적으로
 * 지운 뒤 다음 push로만 반영되게 둔다. */
function mergeFlatMap(localMap,remoteMap){
 return Object.assign({},remoteMap||{},localMap||{});
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
/* push 직전 순수 충돌 판정 — 원격이 우리가 마지막으로 안전하게 동기화한 시점보다 최신이면 충돌 */
function isCloudConflict(curUpdatedAt,lastSyncedAt){return !!(curUpdatedAt&&lastSyncedAt&&curUpdatedAt>lastSyncedAt)}
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
/* 카테고리/귀속 이름 중복 비교용 정규화 — 대소문자·연속 공백(전각공백 포함)만 다른 이름을 같은 이름으로 취급.
   저장/표시용 원본 이름은 건드리지 않고 비교할 때만 사용한다. */
function normName(s){return String(s==null?'':s).trim().replace(/[\s　]+/g,' ').toLowerCase()}
function lastDay(y,m){return new Date(y,m,0).getDate()}
function monthEndStr(y,m){return `${y}-${String(m).padStart(2,'0')}-${String(lastDay(y,m)).padStart(2,'0')}`}
function monthStartStr(y,m){return `${y}-${String(m).padStart(2,'0')}-01`}
/* 메모·카테고리·자산명 검색을 대소문자 구분 없이 매칭(영문 메모/자산명 대비) */
function matchTxnQuery(t,q,assets){
 if(!q)return true;
 const fa=(assets||[]).find(a=>a.id===t.fromAssetId),ta=(assets||[]).find(a=>a.id===t.toAssetId);
 const hay=(t.memo||'')+' '+t.category+' '+(fa?fa.name:(t.fromAssetName||'—'))+' '+(ta?ta.name:(t.toAssetName||'—'));
 return hay.toLowerCase().includes(q.toLowerCase());
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
/* target<=0(설정 전/잘못된 값)이면 비율이 무의미하므로, 현재 금액이 있으면 100%, 없으면 0%로 본다
 * (budgetProgress의 '미설정=0%'과 달리 음수 목표는 원래 saveGoal이 막아 생기지 않지만, 방어적으로 처리) */
function goalPct(cur,target){
 if(!(target>0))return cur>0?100:0;
 return Math.max(0,Math.min(100,Math.round(cur/target*100)));
}
/* 순자산 목표 진행률 + 추세 투사. nwHistory(일별 {date,nw} 스냅샷)의 처음·끝 두 점으로 하루 평균
 * 증가량을 구해 남은 금액을 나누는 단순 선형 투사(spendTrend류와 동일하게 복잡한 회귀는 쓰지 않음).
 * 이력이 1개 이하거나 증가세가 0 이하(정체·감소)면 목표 도달 시점을 예측할 수 없으므로 null —
 * '못 간다'를 추측으로 단정하지 않고 모른다고 말하는 쪽을 택함. */
function goalProgress(goal,nwHistory,today){
 const hist=(nwHistory||[]).filter(h=>h.date<=today);
 const cur=hist.length?hist[hist.length-1].nw:0;
 const target=goal&&goal.targetAmount||0;
 const pct=goalPct(cur,target);
 const remaining=target-cur;
 const achieved=target>0&&cur>=target;
 let projectedDate=null;
 if(!achieved&&remaining>0&&hist.length>=2){
  const first=hist[0],last=hist[hist.length-1];
  const days=daysBetween(first.date,last.date);
  const rate=days>0?(last.nw-first.nw)/days:0;
  if(rate>0)projectedDate=addDays(last.date,Math.ceil(remaining/rate));
 }
 return {cur,target,pct,remaining,achieved,projectedDate};
}

/* ================= ASSET ALLOCATION (자산유형별 비중, 순수) ================= */
/* items: [{type,amount}] — 호출부(allocationCard)가 owner/includeInTotal/부채 제외 필터링과
 * assetEval(DB.rates에 의존하는 index.html 쪽 함수) 평가를 이미 끝낸 뒤 넘긴다(여기선 DB를 몰라야
 * 하므로 assetEval을 직접 부르지 않는다 — nwHistoryForOwner가 DOM/전역 없이 데이터만 받는 것과
 * 동일한 분리). type별로 합산해 amount 내림차순 pct(%)를 매긴다. amount<=0인 항목(가격 미확인
 * fx/gold/stock 등)은 분모(total)에는 포함하되 집계 맵에서는 제외해 0% 세그먼트로 목록이 지저분해지지
 * 않게 한다. total<=0(자산 없음/전부 0)이면 비중이 무의미하므로 빈 배열(호출부가 카드 자체를 숨김). */
function assetAllocation(items){
 items=items||[];
 const total=items.reduce((s,it)=>s+(it.amount||0),0);
 if(!(total>0))return [];
 const map=new Map();
 items.forEach(it=>{if(!(it.amount>0))return;map.set(it.type,(map.get(it.type)||0)+it.amount)});
 return [...map.entries()].map(([type,amount])=>({type,amount,pct:amount/total*100})).sort((a,b)=>b.amount-a.amount);
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
