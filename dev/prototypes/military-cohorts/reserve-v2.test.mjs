import assert from 'node:assert/strict';
import test from 'node:test';
import {V2_LIMITS,migrateReserveV2,transactReserveV2 as tx,validateV2,v2Aggregate,v2SavedBytes,deathReceiptV2} from './reserve-v2.mjs';
const MAX=Number.MAX_SAFE_INTEGER;
const initial=(soldiers=30,extra=[])=>{const r=migrateReserveV2({lineage:'trial',provinces:[{id:'A',controller:'kingdom',soldiers},...extra]});assert.equal(r.ok,true,r.reason);return r.state;};
const apply=(s,type,fields={})=>{const r=tx(s,{type,revision:s.revision,...fields});assert.equal(r.ok,true,r.reason);return r.state;};
const reject=(s,type,fields={},pattern)=>{const before=JSON.stringify(s),cmd={type,revision:s.revision,...fields},raw=JSON.stringify(cmd),r=tx(s,cmd);assert.equal(r.ok,false);assert.equal(r.state,s);assert.equal(JSON.stringify(s),before);assert.equal(JSON.stringify(cmd),raw);if(pattern)assert.match(r.reason,pattern);return r;};
const materialize=(s,home='A',host='A',headcount=5)=>apply(s,'materialize',{home,host,headcount});
const bind=(s,c=s.cohorts.at(-1),actorToken='actor_'+c.generation)=>apply(s,'bind',{cohortId:c.id,actorToken});
const open=s=>apply(s,'open',{host:'A',cohortIds:s.cohorts.filter(c=>c.host==='A').map(c=>c.id)});
const close=s=>apply(s,'close',{sequence:s.engagement.sequence,quiescent:true,pendingReceipts:0,survivors:s.engagement.coverage.filter(c=>!c.consumed).map(c=>({cohortId:c.id,instanceGeneration:c.instanceGeneration,actorToken:c.actorToken}))});
const release=(s,c=s.cohorts[0])=>apply(s,'release',{cohortId:c.id,instanceGeneration:s.bindings.find(b=>b.cohortId===c.id).instanceGeneration,quiescent:true,pendingReceipts:0,reason:'lod'});
function deepFreeze(s){if(s&&typeof s==='object'){Object.freeze(s);for(const c of Object.values(s))deepFreeze(c);}return s;}

test('legacy aggregate migration allocates reserve only, including huge safe counts and no inferred actor births',()=>{
 for(const count of [0,1,128,641,10000,MAX]){const s=initial(count);assert.equal(s.soldiers,count);assert.equal(s.cohorts.length,0);assert.equal(s.bindings.length,0);assert.equal(s.pools.length,1);assert.equal(s.nextGeneration,1);assert.equal(validateV2(s),true);}
 assert.equal(migrateReserveV2({lineage:'bad',provinces:[{id:'A',controller:'k',soldiers:MAX},{id:'B',controller:'k',soldiers:1}]}).ok,false);
});
test('10000 single graduations never allocate rank-slot cohorts or hit128tracking cap',()=>{
 let s=initial(0);const bytes=v2SavedBytes(s);
 for(let i=0;i<10000;i++)s=apply(s,'recruit',{host:'A',count:1});
 assert.equal(s.soldiers,10000);assert.equal(s.pools[0].count,10000);assert.equal(s.cohorts.length,0);assert.equal(s.nextGeneration,1);assert.equal(s.pools.length,1);assert.ok(v2SavedBytes(s)<bytes+32);
});
test('partial materialization snapshots exact immutable headcount without changing aggregate',()=>{
 let s=initial(7);s=materialize(s);const first=structuredClone(s.cohorts[0]);s=materialize(s,'A','A',2);assert.equal(s.soldiers,7);assert.deepEqual(s.cohorts.map(c=>c.headcount),[5,2]);
 s=apply(s,'recruit',{host:'A',count:11});assert.deepEqual(s.cohorts[0],first);assert.equal(s.pools[0].count,11);assert.equal(s.soldiers,18);
 reject(s,'materialize',{home:'A',host:'A',headcount:6},/bound/);
});
test('bounded128live birth retention deliberately refuses129th materialization but never ordinary recruitment',()=>{
 let s=initial(10000);for(let i=0;i<V2_LIMITS.tracked;i++)s=materialize(s,'A','A',1);
 const births=structuredClone(s.cohorts);reject(s,'materialize',{home:'A',host:'A',headcount:1},/capacity/);
 for(let i=0;i<10000;i++)s=apply(s,'recruit',{host:'A',count:1});assert.equal(s.soldiers,20000);assert.deepEqual(s.cohorts,births);assert.equal(s.cohorts.length,128);
 assert.ok(v2SavedBytes(s)<V2_LIMITS.savedBytes);
});
test('visiting and releasing129distinct surviving groups is NOT a solved lifecycle; identities are never silently folded',()=>{
 let s=initial(1000);for(let i=0;i<128;i++){s=materialize(s,'A','A',1);s=bind(s);s=release(s,s.cohorts.at(-1));}
 assert.equal(s.bindings.length,0);assert.equal(s.cohorts.length,128);reject(s,'materialize',{home:'A',host:'A',headcount:1},/capacity/);
 assert.equal(s.cohorts[0].generation,1);assert.equal(s.nextGeneration,129);assert.equal(s.soldiers,1000);
});
test('reserve reinforcement and returns preserve original home across multiple hosts and conserve totals',()=>{
 let s=initial(30,[{id:'B',controller:'kingdom',soldiers:7},{id:'C',controller:'kingdom',soldiers:0}]);
 s=apply(s,'transferReserve',{home:'A',from:'A',to:'B',count:10,reason:'reinforcement'});s=apply(s,'transferReserve',{home:'A',from:'B',to:'C',count:4,reason:'reinforcement'});
 assert.deepEqual(v2Aggregate(s).hosts,{A:20,B:13,C:4});assert.deepEqual(v2Aggregate(s).homes,{A:30,B:7,C:0});
 s=apply(s,'transferReserve',{home:'A',from:'C',to:'B',count:4,reason:'return'});s=apply(s,'transferReserve',{home:'A',from:'B',to:'A',count:10,reason:'return'});
 assert.equal(s.soldiers,37);assert.equal(s.pools.length,3);assert.deepEqual(v2Aggregate(s).hosts,{A:30,B:7,C:0});
 reject(s,'transferReserve',{home:'B',from:'A',to:'B',count:1,reason:'return'},/insufficient/);
});
test('cohort deployment changes host only; same birth and headcount survive and bound/covered transfers refuse',()=>{
 let s=initial(15,[{id:'B',controller:'kingdom',soldiers:0}]);s=materialize(s);const c=structuredClone(s.cohorts[0]);s=bind(s);
 reject(s,'transferCohort',{cohortId:c.id,to:'B',reason:'reinforcement'},/held/);s=release(s);s=apply(s,'transferCohort',{cohortId:c.id,to:'B',reason:'reinforcement'});
 assert.deepEqual(s.cohorts[0],{...c,host:'B'});assert.deepEqual(v2Aggregate(s).hosts,{A:10,B:5});assert.deepEqual(v2Aggregate(s).homes,{A:15,B:0});
 s=bind(s);s=apply(s,'open',{host:'B',cohortIds:[c.id]});reject(s,'transferCohort',{cohortId:c.id,to:'A',reason:'return'},/held/);
});
test('expansion founding plus reserve deployment is one rollback-safe transaction; capture changes no soldier identities',()=>{
 let s=initial(20);const before=JSON.stringify(s);reject(s,'found',{province:'B',controller:'kingdom',from:'A',home:'A',count:21},/insufficient/);assert.equal(JSON.stringify(s),before);
 s=apply(s,'found',{province:'B',controller:'kingdom',from:'A',home:'A',count:8});assert.deepEqual(v2Aggregate(s).hosts,{A:12,B:8});assert.deepEqual(v2Aggregate(s).homes,{A:20,B:0});
 s=materialize(s,'A','B',3);const c=structuredClone(s.cohorts[0]);s=apply(s,'capture',{host:'B',controller:'other'});assert.deepEqual(s.cohorts[0],c);assert.equal(s.soldiers,20);assert.equal(s.provinces.find(p=>p.id==='B').controller,'other');
 s=bind(s);reject(s,'capture',{host:'B',controller:'kingdom'},/settled/);
});
test('garrison assignments partition current host totals, never mint or destroy soldiers',()=>{
 let s=initial(30,[{id:'B',controller:'kingdom',soldiers:0}]);s=apply(s,'assignGarrison',{host:'A',front:28});
 s=apply(s,'transferReserve',{home:'A',from:'A',to:'B',count:10,reason:'reinforcement'});assert.deepEqual(s.provinces.find(p=>p.id==='A'),{id:'A',controller:'kingdom',front:20,reserve:0});assert.equal(s.soldiers,30);
 reject(s,'assignGarrison',{host:'A',front:21},/exceeds/);
});
test('native instance generation changes across explicit LOD release/rebind while birth generation survives',()=>{
 let s=bind(materialize(initial(10)));const c=structuredClone(s.cohorts[0]),old=structuredClone(s.bindings[0]);s=release(s);assert.equal(s.soldiers,10);assert.deepEqual(s.cohorts[0],c);
 s=bind(s,c,'new_actor');assert.ok(s.bindings[0].instanceGeneration>old.instanceGeneration);assert.equal(s.cohorts[0].generation,c.generation);s=open(s);
 const receipt=deathReceiptV2(s,c.id);reject(s,'physicalDeath',{receipt:{...receipt,instanceGeneration:old.instanceGeneration,actorToken:old.actorToken}},/mismatch/);
});
test('covered physical death debits exact partial snapshot once; lowest killed birth never reappears',()=>{
 let s=initial(12);s=materialize(s,'A','A',2);s=bind(s);s=materialize(s);s=bind(s);const survivor=structuredClone(s.cohorts[1]);s=open(s);
 const receipt=deathReceiptV2(s,s.cohorts[0].id),oldRevision=s.revision;s=apply(s,'physicalDeath',{receipt});assert.equal(s.soldiers,10);assert.deepEqual(s.cohorts,[survivor]);
 const duplicate=tx(s,{type:'physicalDeath',revision:oldRevision,receipt});assert.equal(duplicate.ok,true);assert.equal(duplicate.changed,false);assert.equal(duplicate.state,s);
 s=close(s);s=apply(s,'recruit',{host:'A',count:2});s=materialize(s,'A','A',2);assert.ok(s.cohorts.at(-1).generation>receipt.generation);assert.equal(s.cohorts.some(c=>c.id===receipt.cohortId),false);
 const late=tx(s,{type:'physicalDeath',revision:oldRevision,receipt});assert.equal(late.ok,true);assert.equal(late.changed,false);assert.equal(late.state,s);
});
test('covered physical and explicitly uncovered reserve losses commute and never double-debit',()=>{
 let s=open(bind(materialize(initial(20)))),receipt=deathReceiptV2(s,s.cohorts[0].id),sequence=s.engagement.sequence;
 const a=apply(apply(s,'physicalDeath',{receipt}),'simulatedLoss',{host:'A',sequence,scope:'uncovered-reserve',count:4});
 const b=apply(apply(s,'simulatedLoss',{host:'A',sequence,scope:'uncovered-reserve',count:4}),'physicalDeath',{receipt});assert.deepEqual(a,b);assert.equal(a.soldiers,11);
 reject(s,'simulatedLoss',{host:'A',sequence,scope:'whole-garrison',count:4},/ambiguous/);reject(s,'simulatedLoss',{host:'A',sequence,scope:'uncovered-reserve',count:16},/no spill/);
});
test('assault and counterattack both require fresh revision and explicit reserve authority',()=>{
 let s=open(bind(materialize(initial(20)))),sequence=s.engagement.sequence;
 const assault={type:'simulatedLoss',revision:s.revision,host:'A',sequence,scope:'uncovered-reserve',count:3};s=tx(s,assault).state;
 assert.equal(tx(s,assault).ok,false,'same pure command revision cannot double-charge an assault');
 s=apply(s,'simulatedLoss',{host:'A',sequence,scope:'uncovered-reserve',count:2});assert.equal(s.soldiers,15);assert.equal(s.cohorts[0].headcount,5);
 reject(s,'simulatedLoss',{host:'A',sequence:null,scope:'uncovered-reserve',count:1},/sequence/);
});
test('unbound/uncovered tracked births cannot silently become simulated casualty authority',()=>{
 let s=materialize(initial(20));reject(s,'simulatedLoss',{host:'A',sequence:null,scope:'uncovered-reserve',count:1},/unsettled/);
 reject(s,'open',{host:'A',cohortIds:[]},/all tracked/);reject(s,'open',{host:'A',cohortIds:[s.cohorts[0].id]},/binding/);
 s=bind(s);s=open(s);reject(s,'materialize',{home:'A',host:'A',headcount:1},/close engagement/);reject(s,'release',{cohortId:s.cohorts[0].id,instanceGeneration:s.bindings[0].instanceGeneration,quiescent:true,pendingReceipts:0,reason:'lod'},/held/);
});
test('authority close requires exact surviving native instances, quiet ingress and empty receipt backlog',()=>{
 const s=open(bind(materialize(initial(10)))),fields={sequence:s.engagement.sequence,quiescent:true,pendingReceipts:0,survivors:s.bindings.map(b=>({...b}))};
 for(const patch of [{quiescent:false},{pendingReceipts:1},{survivors:[]},{survivors:[{...fields.survivors[0],instanceGeneration:99}]}])reject(s,'close',{...fields,...patch},/handoff|instances/);
 assert.equal(close(s).engagement,null);
});
test('foreign/future/wrong-snapshot receipts reject immutably; only covered native instance can debit',()=>{
 const s=open(bind(materialize(initial(10)))),r=deathReceiptV2(s,s.cohorts[0].id);
 for(const patch of [{lineage:'other'},{sequence:r.sequence+1},{headcount:4},{generation:99,cohortId:'trial:cohort:99'},{home:'B'},{host:'B'},{actorToken:'stranger'},{instanceGeneration:r.instanceGeneration+1}])reject(s,'physicalDeath',{receipt:{...r,...patch}},/receipt|coverage|lineage|snapshot/);
});
test('recruitment while engagement open remains reserve and does not amend physical snapshot or invent class mix',()=>{
 let s=open(bind(materialize(initial(5)))),snapshot=structuredClone(s.engagement.coverage);s=apply(s,'recruit',{host:'A',count:10000});assert.deepEqual(s.engagement.coverage,snapshot);assert.equal(s.pools[0].count,10000);assert.equal(s.cohorts.length,1);assert.equal(s.cohorts[0].class,undefined);
});
test('300 death-close-recruit-rematerialize cycles retain bounded receipt memory and monotonic birth/native watermarks',()=>{
 let s=initial(5),first;
 for(let i=0;i<300;i++){s=bind(materialize(s));s=open(s);const r=deathReceiptV2(s,s.cohorts[0].id);first??=r;s=apply(s,'physicalDeath',{receipt:r});s=close(s);s=apply(s,'recruit',{host:'A',count:5});assert.equal(s.cohorts.length,0);assert.equal(s.bindings.length,0);assert.equal(s.engagement,null);assert.ok(v2SavedBytes(s)<1000);}
 assert.equal(s.nextGeneration,301);assert.equal(s.nextInstance,301);assert.equal(s.closedThrough,300);assert.equal(tx(s,{type:'physicalDeath',revision:0,receipt:first}).changed,false);assert.equal(s.soldiers,5);
});
test('safe-integer overflow, exhausted counters, corrupt state and future version reject without mutation',()=>{
 const max=initial(MAX);reject(max,'recruit',{host:'A',count:1},/safe integer/);
 for(const field of ['revision','nextGeneration','nextInstance','nextEngagement']){let s=initial(10);if(field==='nextInstance')s=materialize(s);if(field==='nextEngagement')s=bind(materialize(s));s[field]=MAX;if(field==='nextEngagement')s.closedThrough=MAX-1;
 const type=field==='revision'?'recruit':field==='nextGeneration'?'materialize':field==='nextInstance'?'bind':'open';const fields=type==='recruit'?{host:'A',count:1}:type==='materialize'?{home:'A',host:'A',headcount:1}:type==='bind'?{cohortId:s.cohorts[0].id,actorToken:'new'}:{host:'A',cohortIds:s.cohorts.map(c=>c.id)};reject(s,type,fields,/exhausted|capacity|generation/);}
 for(const patch of [{v:3},{soldiers:9},{revision:NaN},{nextGeneration:1.5},{extra:true}]){const s={...initial(10),...patch};assert.equal(tx(s,{type:'recruit',revision:0,host:'A',count:1}).ok,false);}
});
test('frozen input and command remain unchanged on success and rejection; deterministic roundtrip validates',()=>{
 const s=deepFreeze(initial(20)),command=deepFreeze({type:'recruit',revision:0,host:'A',count:7}),a=tx(s,command),b=tx(s,command);assert.deepEqual(a,b);assert.equal(s.soldiers,20);assert.equal(a.state.soldiers,27);assert.equal(validateV2(JSON.parse(JSON.stringify(a.state))),true);reject(s,'recruit',{host:'A',count:-1});
});

test('full bounded transfer-pool table never consumes preallocated ordinary recruitment slots',()=>{
 const districts=Array.from({length:31},(_,i)=>({id:'P'+String(i).padStart(2,'0'),controller:'kingdom',soldiers:1000}));let s=initial(1000,districts),filled=false;
 for(const home of s.provinces.map(p=>p.id)){for(const host of s.provinces.map(p=>p.id)){if(home===host)continue;if(s.pools.length===V2_LIMITS.pools){filled=true;break;}s=apply(s,'transferReserve',{home,from:home,to:host,count:1,reason:'reinforcement'});}if(filled)break;}
 assert.equal(s.pools.length,256);const total=s.soldiers;
 for(const host of s.provinces.map(p=>p.id))s=apply(s,'recruit',{host,count:1});assert.equal(s.soldiers,total+32);assert.equal(s.pools.length,256);
 const home=s.provinces.find(p=>s.pools.filter(x=>x.home===p.id).length===1).id,to=s.provinces.find(p=>p.id!==home).id;
 reject(s,'transferReserve',{home,from:home,to,count:1,reason:'reinforcement'},/pool capacity/);
});
test('natural death outside covered engagement and unresolved LOD removal are never inferred casualties',()=>{
 let s=bind(materialize(initial(10)));const c=s.cohorts[0],b=s.bindings[0];
 reject(s,'physicalDeath',{receipt:{lineage:s.lineage,sequence:1,cohortId:c.id,generation:c.generation,headcount:c.headcount,home:c.home,host:c.host,instanceGeneration:b.instanceGeneration,actorToken:b.actorToken}},/active coverage/);
 for(const fields of [{quiescent:false,pendingReceipts:0},{quiescent:true,pendingReceipts:1}])reject(s,'release',{cohortId:c.id,instanceGeneration:b.instanceGeneration,reason:'lod',...fields},/settled/);
 assert.equal(s.soldiers,10);assert.equal(s.cohorts.length,1);assert.equal(s.bindings.length,1);
});
