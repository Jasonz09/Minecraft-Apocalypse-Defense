// Exploratory archive v3, pure/nonintegrated. No engine imports, storage, spawning or timers.
// Stable birth ranges solve sequential129+ visual materialization in this model.
// Fragmented archive ranges still cap128; at-capacity splits refuse without loss.
// Dormant births hold combat-authority handoff, not an anonymous simulation pool.
// `settled`/zero-pending are supplied contracts, not native absence authentication.
// Still needs durable manifest/inbox/real-owner barrier and production integration.
// No total native event capture, unlimited lifecycle or one-property96KB claim.
import {validateV2} from "./reserve-v2.mjs";
export const V3_LIMITS=Object.freeze({tracked:128,archiveRanges:128,covered:32,provinces:32,pools:256,groupSize:1024,savedBytes:96000});
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
export const v3SavedBytes=s=>JSON.stringify(s).length; // Permitted strings are ASCII.
export function v3Aggregate(s){
 const hosts=Object.fromEntries(s.provinces.map(p=>[p.id,0])),homes={...hosts};let total=0;
 for(const p of [...s.pools,...s.cohorts,...s.archives]){const count=p.from===undefined?(p.count??p.headcount):n((p.to-p.from+1)*p.headcount,"archived represented count");hosts[p.host]=add(hosts[p.host],count,"host sum");homes[p.home]=add(homes[p.home],count,"home sum");total=add(total,count,"aggregate total");}
 return{total,hosts,homes};
}
function canonical(s){s.archives.sort((a,b)=>a.from-b.from);s.provinces.sort((a,b)=>a.id.localeCompare(b.id));s.pools.sort((a,b)=>poolKey(a).localeCompare(poolKey(b)));s.cohorts.sort((a,b)=>a.generation-b.generation);s.bindings.sort((a,b)=>a.instanceGeneration-b.instanceGeneration);}
function rebuild(s){canonical(s);const a=v3Aggregate(s);s.soldiers=a.total;for(const p of s.provinces){p.front=Math.min(p.front,a.hosts[p.id]);p.reserve=a.hosts[p.id]-p.front;}return a;}
function assertBirth(s,c,label){
 keys(c,["id","generation","headcount","home","host"],label);positive(c.generation,label+" generation");positive(c.headcount,label+" headcount");
 if(c.generation>=s.nextGeneration||c.id!==id(s,c.generation)||c.headcount>s.groupSize)fail(label+" identity/snapshot invalid");province(s,c.home);province(s,c.host);
}
const snapshotKeys=["id","generation","headcount","home","host","instanceGeneration","actorToken","consumed"];
export function validateV3(s){
 keys(s,["v","lineage","groupSize","revision","soldiers","nextGeneration","nextInstance","nextEngagement","closedThrough","provinces","pools","cohorts","bindings","archives","engagement"],"archive v3 roster");
 if(s.v!==3||!name(s.lineage))fail("unsupported archive v3 lineage/version");positive(s.groupSize,"groupSize");if(s.groupSize>V3_LIMITS.groupSize)fail("groupSize bound");
 for(const field of ["revision","soldiers","closedThrough"])n(s[field],field);
 for(const field of ["nextGeneration","nextInstance","nextEngagement"])positive(s[field],field);
 for(const [field,max]of [["provinces",V3_LIMITS.provinces],["pools",V3_LIMITS.pools],["cohorts",V3_LIMITS.tracked],["bindings",V3_LIMITS.tracked],["archives",V3_LIMITS.archiveRanges]])if(!Array.isArray(s[field])||s[field].length>max)fail(field+" capacity bound");
 if(!s.provinces.length)fail("province list empty");
 const unique=(list,k,label)=>{if(new Set(list.map(k)).size!==list.length)fail(label+" duplicate");};
 unique(s.provinces,p=>p.id,"province");
 for(const p of s.provinces){keys(p,["id","controller","front","reserve"],"province");if(!name(p.id)||!name(p.controller))fail("province identity/controller");n(p.front,"front");n(p.reserve,"garrison reserve");}
 unique(s.pools,poolKey,"pool");
 for(const p of s.pools){keys(p,["home","host","count"],"pool");province(s,p.home);province(s,p.host);n(p.count,"reserve pool");if(!p.count&&p.home!==p.host)fail("empty foreign pool must compact");}
 for(const p of s.provinces)if(!s.pools.some(x=>x.home===p.id&&x.host===p.id))fail("preallocated recruitment pool missing");
 unique(s.cohorts,c=>c.id,"birth");unique(s.cohorts,c=>c.generation,"birth generation");for(const c of s.cohorts)assertBirth(s,c,"cohort");
 let lastEnd=0;
 for(const r of s.archives){
  keys(r,["from","to","headcount","home","host"],"archive range");positive(r.from,"archive generation start");positive(r.to,"archive generation end");positive(r.headcount,"archive headcount");province(s,r.home);province(s,r.host);
  if(r.from>r.to||r.to>=s.nextGeneration||r.from<=lastEnd||r.headcount>s.groupSize)fail("archive range identity/order/headcount invalid");
  n((r.to-r.from+1)*r.headcount,"archive count");lastEnd=r.to;
  if(s.cohorts.some(c=>c.generation>=r.from&&c.generation<=r.to))fail("archived birth also present in working roster");
  if(s.engagement?.coverage?.some(c=>c.generation>=r.from&&c.generation<=r.to))fail("archive overlaps a currently covered or consumed birth");
 }
 for(let i=1;i<s.archives.length;i++){const a=s.archives[i-1],b=s.archives[i];if(a.to+1===b.from&&a.headcount===b.headcount&&a.home===b.home&&a.host===b.host)fail("adjacent compatible archives require compaction");}
 unique(s.bindings,b=>b.cohortId,"binding");unique(s.bindings,b=>b.instanceGeneration,"native instance generation");unique(s.bindings,b=>b.actorToken,"actor token");
 for(const b of s.bindings){keys(b,["cohortId","instanceGeneration","actorToken"],"binding");cohort(s,b.cohortId);positive(b.instanceGeneration,"native instance generation");if(b.instanceGeneration>=s.nextInstance||!token(b.actorToken))fail("native binding invalid");}
 const a=v3Aggregate(s);if(s.soldiers!==a.total)fail("soldier aggregate mismatch");
 for(const p of s.provinces)if(add(p.front,p.reserve,"garrison sum")!==a.hosts[p.id])fail("host garrison mismatch");
 if(s.engagement===null){if(s.closedThrough!==s.nextEngagement-1)fail("closed sequence watermark");}
 else{
  const e=s.engagement;keys(e,["sequence","host","coverage"],"engagement");positive(e.sequence,"sequence");province(s,e.host);if(s.archives.some(r=>r.host===e.host))fail("archived host has ambiguous active authority");
  if(e.sequence!==s.nextEngagement-1||s.closedThrough!==e.sequence-1)fail("active sequence watermark");
  if(!Array.isArray(e.coverage)||e.coverage.length>V3_LIMITS.covered)fail("coverage bound");unique(e.coverage,c=>c.id,"coverage");
  for(const c of e.coverage){keys(c,snapshotKeys,"coverage");const {instanceGeneration,actorToken,consumed,...birth}=c;assertBirth(s,birth,"coverage birth");positive(instanceGeneration,"coverage instance");if(instanceGeneration>=s.nextInstance||!token(actorToken)||typeof consumed!=="boolean"||c.host!==e.host)fail("coverage instance/host invalid");
   const live=s.cohorts.find(x=>x.id===c.id),b=binding(s,c.id);
   if(consumed){if(live||b)fail("consumed birth still live");}
   else if(!live||JSON.stringify(live)!==JSON.stringify(birth)||!b||b.instanceGeneration!==instanceGeneration||b.actorToken!==actorToken)fail("coverage snapshot/binding changed");
  }
  for(const c of s.cohorts.filter(c=>c.host===e.host))if(!e.coverage.some(x=>x.id===c.id&&!x.consumed))fail("uncovered tracked authority at engagement host");
 }
 if(v3SavedBytes(s)>V3_LIMITS.savedBytes)fail("saved byte bound");
 const sorted=clone(s);canonical(sorted);if(JSON.stringify(sorted)!==JSON.stringify(s))fail("noncanonical state order");return true;
}
function pool(s,home,host,create=false){province(s,home);province(s,host);let p=s.pools.find(x=>x.home===home&&x.host===host);if(!p&&create){if(s.pools.length>=V3_LIMITS.pools)fail("transfer pool capacity");p={home,host,count:0};s.pools.push(p);}return p;}
function compact(s){s.pools=s.pools.filter(p=>p.count||p.home===p.host);}
function transfer(s,home,from,to,amount){positive(amount,"transfer count");if(from===to)fail("same-host transfer");const source=pool(s,home,from);if(!source||source.count<amount)fail("insufficient reserve transfer");const target=pool(s,home,to,true);target.count=add(target.count,amount,"transferred reserve");source.count-=amount;compact(s);}
// Live birth identity remains explicit in these ranges. No pool credit is made.
function compactArchives(s){
 s.archives.sort((a,b)=>a.from-b.from);const ranges=[];
 for(const r of s.archives){const prior=ranges.at(-1);if(prior&&prior.to+1===r.from&&prior.headcount===r.headcount&&prior.home===r.home&&prior.host===r.host)prior.to=r.to;else ranges.push({...r});}
 s.archives=ranges;
 if(ranges.length>V3_LIMITS.archiveRanges)fail("archive fragmentation capacity; no identity discarded");
}
function archiveBirth(s,generation){const r=s.archives.find(r=>generation>=r.from&&generation<=r.to);return r?{id:id(s,generation),generation,headcount:r.headcount,home:r.home,host:r.host}:null;}
// Direct lookup scans at most128 ranges; it never expands an entire generation interval.
export function archivedBirthV3(s,cohortId,generation){validateV3(s);positive(generation,"archive lookup generation");if(cohortId!==id(s,generation))throw new Error("archive lookup identity mismatch");return archiveBirth(s,generation);}
const ok=(state,effect,changed=true)=>({ok:true,state,aggregate:v3Aggregate(state),consumedReceipt:effect.receipt??null,effect,changed});
const no=(input,error)=>({ok:false,state:input,aggregate:null,consumedReceipt:null,changed:false,reason:String(error)});
export function migrateArchiveV3({lineage,provinces,groupSize=5}={}){
 try{
  if(!name(lineage)||!Array.isArray(provinces)||!provinces.length||provinces.length>V3_LIMITS.provinces)fail("migration identity/provinces bound");
  const s={v:3,lineage,groupSize,revision:0,soldiers:0,nextGeneration:1,nextInstance:1,nextEngagement:1,closedThrough:0,provinces:[],pools:[],cohorts:[],bindings:[],archives:[],engagement:null};
  for(const p of provinces){keys(p,["id","controller","soldiers"],"legacy province");n(p.soldiers,"legacy soldiers");s.provinces.push({id:p.id,controller:p.controller,front:0,reserve:p.soldiers});s.pools.push({home:p.id,host:p.id,count:p.soldiers});}
  rebuild(s);validateV3(s);return ok(s,{kind:"migrated-reserve"});
 }catch(e){return no(null,e);}
}
function receiptShape(r,s){
 keys(r,["lineage","sequence","cohortId","generation","headcount","home","host","instanceGeneration","actorToken"],"death receipt");
 if(r.lineage!==s.lineage)fail("foreign receipt lineage");for(const k of ["sequence","generation","headcount","instanceGeneration"])positive(r[k],"receipt "+k);
 if(r.cohortId!==id(s,r.generation)||r.headcount>s.groupSize||!name(r.home)||!name(r.host)||!token(r.actorToken))fail("receipt identity invalid");
}
/** One pure logical transaction; no native event authenticity, storage CAS or disk atomicity. */
export function transactArchiveV3(input,command){
 try{
  validateV3(input);
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
    if(s.cohorts.length>=V3_LIMITS.tracked||s.nextGeneration===MAX)fail("tracked cohort/generation capacity");const p=pool(s,command.home,command.host);if(!p||p.count<command.headcount)fail("insufficient reserve to materialize");p.count-=command.headcount;compact(s);
    const generation=s.nextGeneration++,c={id:id(s,generation),generation,headcount:command.headcount,home:command.home,host:command.host};s.cohorts.push(c);effect={kind:"materialized",cohort:clone(c)};break;
   }
   case "archive":{
    keys(command,["type","revision","cohortId","settled","pendingReceipts"],"archive birth");
    const c=cohort(s,command.cohortId);
    // A real owner must establish this barrier. Missing/unloaded is NOT settled.
    if(s.engagement||binding(s,c.id)||command.settled!==true||command.pendingReceipts!==0)fail("archive requires settled unbound birth and closed receipt ingress");
    s.archives.push({from:c.generation,to:c.generation,headcount:c.headcount,home:c.home,host:c.host});compactArchives(s);
    s.cohorts=s.cohorts.filter(x=>x.id!==c.id);effect={kind:"archived-preserved-birth",cohort:clone(c)};break;
   }
   case "reactivate":{
    keys(command,["type","revision","cohortId","generation","settled","pendingReceipts"],"reactivate birth");positive(command.generation,"reactivation generation");
    if(s.engagement||command.settled!==true||command.pendingReceipts!==0)fail("reactivation requires closed settled receipt ingress");
    if(s.cohorts.length>=V3_LIMITS.tracked)fail("working birth capacity; archive preserved");
    if(command.cohortId!==id(s,command.generation))fail("reactivation identity mismatch");const c=archiveBirth(s,command.generation);if(!c)fail("absent archived birth; no inferred replacement");
    const ranges=[];for(const r of s.archives){if(command.generation<r.from||command.generation>r.to){ranges.push(r);continue;}if(r.from<command.generation)ranges.push({...r,to:command.generation-1});if(r.to>command.generation)ranges.push({...r,from:command.generation+1});}
    s.archives=ranges;compactArchives(s);s.cohorts.push(c);effect={kind:"reactivated-exact-birth",cohort:clone(c)};break;
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
    keys(command,["type","revision","province","controller","from","home","count"],"found province");if(!name(command.province)||!name(command.controller)||s.provinces.some(p=>p.id===command.province)||s.provinces.length>=V3_LIMITS.provinces)fail("new province bound/identity");s.provinces.push({id:command.province,controller:command.controller,front:0,reserve:0});pool(s,command.province,command.province,true);transfer(s,command.home,command.from,command.province,command.count);effect={kind:"founded"};break;
   }
   case "capture":{
    keys(command,["type","revision","host","controller"],"capture");const p=province(s,command.host);if(!name(command.controller)||s.engagement?.host===p.id||s.bindings.some(b=>cohort(s,b.cohortId).host===p.id))fail("capture requires settled political/physical authority");p.controller=command.controller;effect={kind:"controller-change-no-casualty"};break;
   }
   case "assignGarrison":{
    keys(command,["type","revision","host","front"],"assign garrison");const p=province(s,command.host);n(command.front,"front");if(command.front>v3Aggregate(s).hosts[p.id])fail("front exceeds host aggregate");p.front=command.front;effect={kind:"garrison-only"};break;
   }
   case "open":{
    keys(command,["type","revision","host","cohortIds"],"open coverage");province(s,command.host);if(s.engagement||s.nextEngagement===MAX)fail("existing/exhausted engagement");if(s.archives.some(r=>r.host===command.host))fail("archived host births require explicit combat authority; handoff held");
    if(!Array.isArray(command.cohortIds)||command.cohortIds.length>V3_LIMITS.covered||new Set(command.cohortIds).size!==command.cohortIds.length)fail("coverage bound/duplicate");
    const all=s.cohorts.filter(c=>c.host===command.host);if(all.length!==command.cohortIds.length||all.some(c=>!command.cohortIds.includes(c.id)))fail("coverage must include all tracked host births");
    const coverage=all.map(c=>{const b=binding(s,c.id);if(!b)fail("tracked host birth lacks native binding");return{...c,instanceGeneration:b.instanceGeneration,actorToken:b.actorToken,consumed:false};});s.engagement={sequence:s.nextEngagement++,host:command.host,coverage};effect={kind:"opened",sequence:s.engagement.sequence};break;
   }
   case "simulatedLoss":{
    keys(command,["type","revision","host","sequence","scope","count"],"simulated loss");province(s,command.host);n(command.count,"loss");if(command.scope!=="uncovered-reserve")fail("ambiguous whole-garrison loss scope");
    if(s.engagement?.host===command.host){if(command.sequence!==s.engagement.sequence)fail("active engagement sequence required");}
    else if(command.sequence!==null||s.cohorts.some(c=>c.host===command.host)||s.archives.some(r=>r.host===command.host))fail("tracked authority unsettled or wrong sequence");
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
   default:fail("unknown archive v3 operation");
  }
  rebuild(s);s.revision++;validateV3(s);return ok(s,effect);
 }catch(e){return no(input,e);}
}
export function deathReceiptV3(s,cohortId){validateV3(s);const e=s.engagement,c=e?.coverage.find(c=>c.id===cohortId);if(!c)throw new Error("no explicit coverage snapshot");const {id,generation,headcount,home,host,instanceGeneration,actorToken}=c;return{lineage:s.lineage,sequence:e.sequence,cohortId:id,generation,headcount,home,host,instanceGeneration,actorToken};}

// Explicit experimental version transition; never reconstruct known births from totals.
export function upgradeReserveV2ToArchiveV3(input,{settled,pendingReceipts}={}){
 try{validateV2(input);if(settled!==true||pendingReceipts!==0||input.engagement||input.bindings.length)fail("upgrade requires settled unbound closed authority");if(input.revision===MAX)fail("revision exhausted");
 const s=clone(input);s.v=3;s.archives=[];s.revision++;validateV3(s);return ok(s,{kind:"explicit-v2-to-v3-preserving-births"});
 }catch(error){return no(input,error);}
}
