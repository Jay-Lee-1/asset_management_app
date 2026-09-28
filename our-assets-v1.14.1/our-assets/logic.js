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
