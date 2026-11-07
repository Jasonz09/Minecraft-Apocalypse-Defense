// Exploratory v2, pure/nonintegrated. No engine imports, storage, spawning or timers.
export const V2_LIMITS=Object.freeze({tracked:128,covered:32,provinces:32,pools:256,groupSize:1024,savedBytes:96000});
const MAX=Number.MAX_SAFE_INTEGER;
const fail=m=>{throw new Error(m);};
const n=(v,label)=>{if(!Number.isSafeInteger(v)||v<0)fail(label+" must be a nonnegative safe integer");return v;};
const positive=(v,label)=>{n(v,label);if(!v)fail(label+" must be positive");return v;};
const add=(a,b,label)=>n(a+b,label);
const name=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,24}$/.test(v);
const token=v=>typeof v==="string"&&/^[A-Za-z0-9_:-]{1,64}$/.test(v);
const keys=(v,names,label)=>{if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).sort().join(",")!==[...names].sort().join(","))fail(label+" fields invalid");};
const clone=v=>JSON.parse(JSON.stringify(v));
const id=(s,g)=>`${s.lineage}:cohort:${g}`;
const poolKey=p=>p.home+":"+p.host;
const province=(s,p)=>{const found=s.provinces.find(x=>x.id===p);if(!found)fail("unknown province "+p);return found;};
const cohort=(s,c)=>{const found=s.cohorts.find(x=>x.id===c);if(!found)fail("absent birth cohort");return found;};
const covered=(s,c)=>s.engagement?.coverage.some(x=>x.id===c)??false;
const binding=(s,c)=>s.bindings.find(x=>x.cohortId===c);
export const v2SavedBytes=s=>JSON.stringify(s).length; // Permitted strings are ASCII.
export function v2Aggregate(s){
 const hosts=Object.fromEntries(s.provinces.map(p=>[p.id,0])),homes={...hosts};let total=0;
 for(const p of [...s.pools,...s.cohorts]){const count=p.count??p.headcount;hosts[p.host]=add(hosts[p.host],count,"host sum");homes[p.home]=add(homes[p.home],count,"home sum");total=add(total,count,"aggregate total");}
 return{total,hosts,homes};
}
function canonical(s){s.provinces.sort((a,b)=>a.id.localeCompare(b.id));s.pools.sort((a,b)=>poolKey(a).localeCompare(poolKey(b)));s.cohorts.sort((a,b)=>a.generation-b.generation);s.bindings.sort((a,b)=>a.instanceGeneration-b.instanceGeneration);}
function rebuild(s){canonical(s);const a=v2Aggregate(s);s.soldiers=a.total;for(const p of s.provinces){p.front=Math.min(p.front,a.hosts[p.id]);p.reserve=a.hosts[p.id]-p.front;}return a;}
function assertBirth(s,c,label){
 keys(c,["id","generation","headcount","home","host"],label);positive(c.generation,label+" generation");positive(c.headcount,label+" headcount");
 if(c.generation>=s.nextGeneration||c.id!==id(s,c.generation)||c.headcount>s.groupSize)fail(label+" identity/snapshot invalid");province(s,c.home);province(s,c.host);
}
const snapshotKeys=["id","generation","headcount","home","host","instanceGeneration","actorToken","consumed"];
export function validateV2(s){
 keys(s,["v","lineage","groupSize","revision","soldiers","nextGeneration","nextInstance","nextEngagement","closedThrough","provinces","pools","cohorts","bindings","engagement"],"v2 roster");
 if(s.v!==2||!name(s.lineage))fail("unsupported v2 lineage/version");positive(s.groupSize,"groupSize");if(s.groupSize>V2_LIMITS.groupSize)fail("groupSize bound");
 for(const field of ["revision","soldiers","closedThrough"])n(s[field],field);
 for(const field of ["nextGeneration","nextInstance","nextEngagement"])positive(s[field],field);
 for(const [field,max]of [["provinces",V2_LIMITS.provinces],["pools",V2_LIMITS.pools],["cohorts",V2_LIMITS.tracked],["bindings",V2_LIMITS.tracked]])if(!Array.isArray(s[field])||s[field].length>max)fail(field+" capacity bound");
 if(!s.provinces.length)fail("province list empty");
 const unique=(list,k,label)=>{if(new Set(list.map(k)).size!==list.length)fail(label+" duplicate");};
 unique(s.provinces,p=>p.id,"province");
 for(const p of s.provinces){keys(p,["id","controller","front","reserve"],"province");if(!name(p.id)||!name(p.controller))fail("province identity/controller");n(p.front,"front");n(p.reserve,"garrison reserve");}
 unique(s.pools,poolKey,"pool");
 for(const p of s.pools){keys(p,["home","host","count"],"pool");province(s,p.home);province(s,p.host);n(p.count,"reserve pool");if(!p.count&&p.home!==p.host)fail("empty foreign pool must compact");}
 for(const p of s.provinces)if(!s.pools.some(x=>x.home===p.id&&x.host===p.id))fail("preallocated recruitment pool missing");
 unique(s.cohorts,c=>c.id,"birth");unique(s.cohorts,c=>c.generation,"birth generation");for(const c of s.cohorts)assertBirth(s,c,"cohort");
 unique(s.bindings,b=>b.cohortId,"binding");unique(s.bindings,b=>b.instanceGeneration,"native instance generation");unique(s.bindings,b=>b.actorToken,"actor token");
 for(const b of s.bindings){keys(b,["cohortId","instanceGeneration","actorToken"],"binding");cohort(s,b.cohortId);positive(b.instanceGeneration,"native instance generation");if(b.instanceGeneration>=s.nextInstance||!token(b.actorToken))fail("native binding invalid");}
 const a=v2Aggregate(s);if(s.soldiers!==a.total)fail("soldier aggregate mismatch");
 for(const p of s.provinces)if(add(p.front,p.reserve,"garrison sum")!==a.hosts[p.id])fail("host garrison mismatch");
 if(s.engagement===null){if(s.closedThrough!==s.nextEngagement-1)fail("closed sequence watermark");}
 else{
  const e=s.engagement;keys(e,["sequence","host","coverage"],"engagement");positive(e.sequence,"sequence");province(s,e.host);
  if(e.sequence!==s.nextEngagement-1||s.closedThrough!==e.sequence-1)fail("active sequence watermark");
  if(!Array.isArray(e.coverage)||e.coverage.length>V2_LIMITS.covered)fail("coverage bound");unique(e.coverage,c=>c.id,"coverage");
  for(const c of e.coverage){keys(c,snapshotKeys,"coverage");const {instanceGeneration,actorToken,consumed,...birth}=c;assertBirth(s,birth,"coverage birth");positive(instanceGeneration,"coverage instance");if(instanceGeneration>=s.nextInstance||!token(actorToken)||typeof consumed!=="boolean"||c.host!==e.host)fail("coverage instance/host invalid");
   const live=s.cohorts.find(x=>x.id===c.id),b=binding(s,c.id);
   if(consumed){if(live||b)fail("consumed birth still live");}
   else if(!live||JSON.stringify(live)!==JSON.stringify(birth)||!b||b.instanceGeneration!==instanceGeneration||b.actorToken!==actorToken)fail("coverage snapshot/binding changed");
  }
  for(const c of s.cohorts.filter(c=>c.host===e.host))if(!e.coverage.some(x=>x.id===c.id&&!x.consumed))fail("uncovered tracked authority at engagement host");
 }
 if(v2SavedBytes(s)>V2_LIMITS.savedBytes)fail("saved byte bound");
 const sorted=clone(s);canonical(sorted);if(JSON.stringify(sorted)!==JSON.stringify(s))fail("noncanonical state order");return true;
}
function pool(s,home,host,create=false){province(s,home);province(s,host);let p=s.pools.find(x=>x.home===home&&x.host===host);if(!p&&create){if(s.pools.length>=V2_LIMITS.pools)fail("transfer pool capacity");p={home,host,count:0};s.pools.push(p);}return p;}
function compact(s){s.pools=s.pools.filter(p=>p.count||p.home===p.host);}
function transfer(s,home,from,to,amount){positive(amount,"transfer count");if(from===to)fail("same-host transfer");const source=pool(s,home,from);if(!source||source.count<amount)fail("insufficient reserve transfer");const target=pool(s,home,to,true);target.count=add(target.count,amount,"transferred reserve");source.count-=amount;compact(s);}
const ok=(state,effect,changed=true)=>({ok:true,state,aggregate:v2Aggregate(state),consumedReceipt:effect.receipt??null,effect,changed});
const no=(input,error)=>({ok:false,state:input,aggregate:null,consumedReceipt:null,changed:false,reason:String(error)});
export function migrateReserveV2({lineage,provinces,groupSize=5}={}){
 try{
  if(!name(lineage)||!Array.isArray(provinces)||!provinces.length||provinces.length>V2_LIMITS.provinces)fail("migration identity/provinces bound");
  const s={v:2,lineage,groupSize,revision:0,soldiers:0,nextGeneration:1,nextInstance:1,nextEngagement:1,closedThrough:0,provinces:[],pools:[],cohorts:[],bindings:[],engagement:null};
  for(const p of provinces){keys(p,["id","controller","soldiers"],"legacy province");n(p.soldiers,"legacy soldiers");s.provinces.push({id:p.id,controller:p.controller,front:0,reserve:p.soldiers});s.pools.push({home:p.id,host:p.id,count:p.soldiers});}
  rebuild(s);validateV2(s);return ok(s,{kind:"migrated-reserve"});
 }catch(e){return no(null,e);}
}
function receiptShape(r,s){
 keys(r,["lineage","sequence","cohortId","generation","headcount","home","host","instanceGeneration","actorToken"],"death receipt");
 if(r.lineage!==s.lineage)fail("foreign receipt lineage");for(const k of ["sequence","generation","headcount","instanceGeneration"])positive(r[k],"receipt "+k);
 if(r.cohortId!==id(s,r.generation)||r.headcount>s.groupSize||!name(r.home)||!name(r.host)||!token(r.actorToken))fail("receipt identity invalid");
}
/** One pure logical transaction; no native event authenticity, storage CAS or disk atomicity. */
export function transactReserveV2(input,command){
 try{
  validateV2(input);
  // Receipt replay is safe even if its original optimistic revision is stale.
  if(command?.type==="physicalDeath"){
   keys(command,["type","revision","receipt"],"death command");n(command.revision,"revision");receiptShape(command.receipt,input);
   const r=command.receipt;if(r.sequence<=input.closedThrough)return ok(input,{kind:"closed-receipt",receipt:clone(r)},false);
   if(input.engagement?.sequence===r.sequence){const c=input.engagement.coverage.find(c=>c.id===r.cohortId);if(c?.consumed){for(const k of ["generation","headcount","home","host","instanceGeneration","actorToken"])if(c[k]!==r[k])fail("consumed receipt mismatch");return ok(input,{kind:"duplicate-receipt",receipt:clone(r)},false);}}
  }
  if(command?.revision!==input.revision)fail("stale transaction revision");if(input.revision===MAX)fail("revision exhausted");
  const s=clone(input);let effect;
  switch(command.type){
   case "recruit":{
    keys(command,["type","revision","host","count"],"recruit");n(command.count,"recruits");const p=pool(s,command.host,command.host);p.count=add(p.count,command.count,"recruited reserve");effect={kind:"recruited",count:command.count};break;
   }
   case "materialize":{
    keys(command,["type","revision","home","host","headcount"],"materialize");positive(command.headcount,"represented headcount");if(command.headcount>s.groupSize)fail("represented headcount bound");if(s.engagement?.host===command.host)fail("close engagement before adding tracked authority");
    if(s.cohorts.length>=V2_LIMITS.tracked||s.nextGeneration===MAX)fail("tracked cohort/generation capacity");const p=pool(s,command.home,command.host);if(!p||p.count<command.headcount)fail("insufficient reserve to materialize");p.count-=command.headcount;compact(s);
    const generation=s.nextGeneration++,c={id:id(s,generation),generation,headcount:command.headcount,home:command.home,host:command.host};s.cohorts.push(c);effect={kind:"materialized",cohort:clone(c)};break;
   }
   case "bind":{
    keys(command,["type","revision","cohortId","actorToken"],"bind");const c=cohort(s,command.cohortId);if(covered(s,c.id)||binding(s,c.id)||s.bindings.some(b=>b.actorToken===command.actorToken))fail("binding exists/authority held");if(!token(command.actorToken)||s.nextInstance===MAX)fail("native instance token/generation");
    const b={cohortId:c.id,instanceGeneration:s.nextInstance++,actorToken:command.actorToken};s.bindings.push(b);effect={kind:"bound",binding:clone(b)};break;
   }
   case "release":{
    keys(command,["type","revision","cohortId","instanceGeneration","quiescent","pendingReceipts","reason"],"release");const b=binding(s,command.cohortId);if(!b||b.instanceGeneration!==command.instanceGeneration||covered(s,b.cohortId))fail("binding/coverage held");if(command.quiescent!==true||command.pendingReceipts!==0||!["lod","trial-teardown"].includes(command.reason))fail("release requires settled owner barrier");s.bindings=s.bindings.filter(x=>x!==b);effect={kind:"released-no-casualty"};break;
   }
   case "transferReserve":{
    keys(command,["type","revision","home","from","to","count","reason"],"reserve transfer");if(!["reinforcement","return","expansion"].includes(command.reason))fail("transfer reason");transfer(s,command.home,command.from,command.to,command.count);effect={kind:"reserve-transfer",reason:command.reason};break;
   }
   case "transferCohort":{
    keys(command,["type","revision","cohortId","to","reason"],"cohort transfer");if(!["reinforcement","return","expansion"].includes(command.reason))fail("transfer reason");const c=cohort(s,command.cohortId);province(s,command.to);if(c.host===command.to||binding(s,c.id)||covered(s,c.id)||s.engagement?.host===command.to)fail("cohort host/authority held");c.host=command.to;effect={kind:"cohort-transfer",cohort:clone(c)};break;
   }
   case "found":{
    keys(command,["type","revision","province","controller","from","home","count"],"found province");if(!name(command.province)||!name(command.controller)||s.provinces.some(p=>p.id===command.province)||s.provinces.length>=V2_LIMITS.provinces)fail("new province bound/identity");s.provinces.push({id:command.province,controller:command.controller,front:0,reserve:0});pool(s,command.province,command.province,true);transfer(s,command.home,command.from,command.province,command.count);effect={kind:"founded"};break;
   }
   case "capture":{
    keys(command,["type","revision","host","controller"],"capture");const p=province(s,command.host);if(!name(command.controller)||s.engagement?.host===p.id||s.bindings.some(b=>cohort(s,b.cohortId).host===p.id))fail("capture requires settled political/physical authority");p.controller=command.controller;effect={kind:"controller-change-no-casualty"};break;
   }
   case "assignGarrison":{
    keys(command,["type","revision","host","front"],"assign garrison");const p=province(s,command.host);n(command.front,"front");if(command.front>v2Aggregate(s).hosts[p.id])fail("front exceeds host aggregate");p.front=command.front;effect={kind:"garrison-only"};break;
   }
   case "open":{
    keys(command,["type","revision","host","cohortIds"],"open coverage");province(s,command.host);if(s.engagement||s.nextEngagement===MAX)fail("existing/exhausted engagement");
    if(!Array.isArray(command.cohortIds)||command.cohortIds.length>V2_LIMITS.covered||new Set(command.cohortIds).size!==command.cohortIds.length)fail("coverage bound/duplicate");
    const all=s.cohorts.filter(c=>c.host===command.host);if(all.length!==command.cohortIds.length||all.some(c=>!command.cohortIds.includes(c.id)))fail("coverage must include all tracked host births");
    const coverage=all.map(c=>{const b=binding(s,c.id);if(!b)fail("tracked host birth lacks native binding");return{...c,instanceGeneration:b.instanceGeneration,actorToken:b.actorToken,consumed:false};});s.engagement={sequence:s.nextEngagement++,host:command.host,coverage};effect={kind:"opened",sequence:s.engagement.sequence};break;
   }
   case "simulatedLoss":{
    keys(command,["type","revision","host","sequence","scope","count"],"simulated loss");province(s,command.host);n(command.count,"loss");if(command.scope!=="uncovered-reserve")fail("ambiguous whole-garrison loss scope");
    if(s.engagement?.host===command.host){if(command.sequence!==s.engagement.sequence)fail("active engagement sequence required");}
    else if(command.sequence!==null||s.cohorts.some(c=>c.host===command.host))fail("tracked authority unsettled or wrong sequence");
    const eligible=s.pools.filter(p=>p.host===command.host);let left=command.count;if(eligible.reduce((sum,p)=>add(sum,p.count,"eligible sum"),0)<left)fail("loss exceeds uncovered reserve; no spill into physical births");
    for(const p of eligible){const loss=Math.min(left,p.count);p.count-=loss;left-=loss;}compact(s);effect={kind:"simulated-reserve-loss",count:command.count};break;
   }
   case "physicalDeath":{
    const r=command.receipt,e=s.engagement;if(!e||e.sequence!==r.sequence)fail("receipt outside active coverage");const c=e.coverage.find(c=>c.id===r.cohortId);if(!c)fail("receipt has no covered birth");for(const k of ["generation","headcount","home","host","instanceGeneration","actorToken"])if(c[k]!==r[k])fail("receipt snapshot/native instance mismatch");
    s.cohorts=s.cohorts.filter(x=>x.id!==c.id);s.bindings=s.bindings.filter(x=>x.cohortId!==c.id);c.consumed=true;effect={kind:"physical-cohort-loss",count:c.headcount,receipt:clone(r)};break;
   }
   case "close":{
    keys(command,["type","revision","sequence","quiescent","pendingReceipts","survivors"],"close coverage");const e=s.engagement;if(!e||e.sequence!==command.sequence||command.quiescent!==true||command.pendingReceipts!==0||!Array.isArray(command.survivors))fail("unsettled engagement handoff");
    const expected=e.coverage.filter(c=>!c.consumed).map(c=>({cohortId:c.id,instanceGeneration:c.instanceGeneration,actorToken:c.actorToken}));
    if(JSON.stringify(command.survivors)!==JSON.stringify(expected))fail("exact surviving native instances required");s.closedThrough=e.sequence;s.engagement=null;effect={kind:"closed"};break;
   }
   default:fail("unknown v2 operation");
  }
  rebuild(s);s.revision++;validateV2(s);return ok(s,effect);
 }catch(e){return no(input,e);}
}
export function deathReceiptV2(s,cohortId){validateV2(s);const e=s.engagement,c=e?.coverage.find(c=>c.id===cohortId);if(!c)throw new Error("no explicit coverage snapshot");const {id,generation,headcount,home,host,instanceGeneration,actorToken}=c;return{lineage:s.lineage,sequence:e.sequence,cohortId:id,generation,headcount,home,host,instanceGeneration,actorToken};}
