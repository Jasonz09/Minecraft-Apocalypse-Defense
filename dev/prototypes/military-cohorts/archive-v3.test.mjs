import assert from 'node:assert/strict';
import test from 'node:test';
import {V3_LIMITS,migrateArchiveV3,transactArchiveV3 as tx,validateV3,v3Aggregate,v3SavedBytes,deathReceiptV3,archivedBirthV3,upgradeReserveV2ToArchiveV3} from './archive-v3.mjs';
import {migrateReserveV2,transactReserveV2} from './reserve-v2.mjs';
const initial=(count=1000,extra=[])=>{const r=migrateArchiveV3({lineage:'archive',provinces:[{id:'A',controller:'kingdom',soldiers:count},...extra]});assert.equal(r.ok,true,r.reason);return r.state;};
const apply=(s,type,fields={})=>{const r=tx(s,{type,revision:s.revision,...fields});assert.equal(r.ok,true,r.reason);return r.state;};
const reject=(s,type,fields={},match)=>{const before=JSON.stringify(s),cmd={type,revision:s.revision,...fields},raw=JSON.stringify(cmd),r=tx(s,cmd);assert.equal(r.ok,false);assert.equal(r.state,s);assert.equal(JSON.stringify(s),before);assert.equal(JSON.stringify(cmd),raw);if(match)assert.match(r.reason,match);return r;};
const create=(s,headcount=1,home='A',host='A')=>apply(s,'materialize',{home,host,headcount});
const archive=(s,c=s.cohorts.at(-1))=>apply(s,'archive',{cohortId:c.id,settled:true,pendingReceipts:0});
const reactivate=(s,g)=>apply(s,'reactivate',{cohortId:`archive:cohort:${g}`,generation:g,settled:true,pendingReceipts:0});
const bind=(s,c=s.cohorts.at(-1),actorToken='actor_'+s.nextInstance)=>apply(s,'bind',{cohortId:c.id,actorToken});
const release=(s,c=s.cohorts.at(-1))=>apply(s,'release',{cohortId:c.id,instanceGeneration:s.bindings.find(b=>b.cohortId===c.id).instanceGeneration,quiescent:true,pendingReceipts:0,reason:'lod'});
const open=s=>apply(s,'open',{host:'A',cohortIds:s.cohorts.filter(c=>c.host==='A').map(c=>c.id)});
const close=s=>apply(s,'close',{sequence:s.engagement.sequence,quiescent:true,pendingReceipts:0,survivors:s.engagement.coverage.filter(c=>!c.consumed).map(c=>({cohortId:c.id,instanceGeneration:c.instanceGeneration,actorToken:c.actorToken}))});
function frozen(s){if(s&&typeof s==='object'){Object.freeze(s);for(const c of Object.values(s))frozen(c);}return s;}

test('explicit settled v2 upgrade preserves existing128birth identities and headcounts before safe archiving',()=>{
 let s=migrateReserveV2({lineage:'archive',provinces:[{id:'A',controller:'kingdom',soldiers:1000}]}).state;
 for(let i=0;i<128;i++){const r=transactReserveV2(s,{type:'materialize',revision:s.revision,home:'A',host:'A',headcount:1});assert.equal(r.ok,true);s=r.state;}
 const before=JSON.stringify(s),up=upgradeReserveV2ToArchiveV3(s,{settled:true,pendingReceipts:0});assert.equal(up.ok,true,up.reason);assert.equal(JSON.stringify(s),before);assert.deepEqual(up.state.cohorts,s.cohorts);assert.equal(up.state.nextGeneration,s.nextGeneration);assert.equal(up.state.soldiers,1000);
 let v3=archive(up.state,up.state.cohorts[0]);v3=create(v3);assert.equal(v3.cohorts.at(-1).generation,129);assert.equal(v3.cohorts.length,128);assert.deepEqual(archivedBirthV3(v3,s.cohorts[0].id,1),s.cohorts[0]);
 assert.equal(upgradeReserveV2ToArchiveV3(s,{settled:false,pendingReceipts:0}).ok,false);
});
test('10000distinct simulated actor visits archive stable births in one range without renumbering or anonymous pool credits',()=>{
 let s=initial(10000),first,last,maxWorking=0;
 for(let i=0;i<10000;i++){s=create(s);const c=structuredClone(s.cohorts[0]);first??=c;last=c;s=bind(s);s=release(s);s=archive(s);maxWorking=Math.max(maxWorking,s.cohorts.length);}
 assert.equal(s.soldiers,10000);assert.equal(s.pools[0].count,0);assert.equal(s.cohorts.length,0);assert.equal(s.bindings.length,0);assert.equal(s.archives.length,1);assert.deepEqual(s.archives[0],{from:1,to:10000,headcount:1,home:'A',host:'A'});assert.equal(s.nextGeneration,10001);assert.equal(s.nextInstance,10001);assert.ok(maxWorking<=128);assert.ok(v3SavedBytes(s)<1000);
 assert.deepEqual(archivedBirthV3(s,first.id,1),first);assert.deepEqual(archivedBirthV3(s,last.id,10000),last);
});
test('middle-range reactivation returns exact birth without allocating new birth generation and rearchive merges both neighbors',()=>{
 let s=initial(20);for(let i=0;i<20;i++)s=archive(create(s));const birth=archivedBirthV3(s,'archive:cohort:10',10),next=s.nextGeneration;
 s=reactivate(s,10);assert.deepEqual(s.cohorts[0],birth);assert.equal(s.nextGeneration,next);assert.deepEqual(s.archives.map(r=>[r.from,r.to]),[[1,9],[11,20]]);assert.equal(s.pools[0].count,0);assert.equal(s.soldiers,20);
 s=archive(s);assert.deepEqual(s.archives.map(r=>[r.from,r.to]),[[1,20]]);assert.equal(s.soldiers,20);
});
test('reactivation preserves partial headcount/home across host transfer; no class mix or survivor refill',()=>{
 let s=initial(20,[{id:'B',controller:'kingdom',soldiers:0}]);s=create(s,2);const birth=structuredClone(s.cohorts[0]);s=apply(s,'transferCohort',{cohortId:birth.id,to:'B',reason:'reinforcement'});s=archive(s);s=apply(s,'recruit',{host:'A',count:20});s=reactivate(s,1);
 assert.deepEqual(s.cohorts[0],{...birth,host:'B'});assert.equal(s.cohorts[0].class,undefined);assert.deepEqual(v3Aggregate(s).hosts,{A:38,B:2});assert.deepEqual(v3Aggregate(s).homes,{A:40,B:0});
});
test('archiving never treats bound, active, pending or merely-unsettled birth as absent',()=>{
 let s=bind(create(initial(10))),id=s.cohorts[0].id;
 reject(s,'archive',{cohortId:id,settled:true,pendingReceipts:0},/settled unbound/);s=release(s);
 for(const fields of [{settled:false,pendingReceipts:0},{settled:true,pendingReceipts:1}])reject(s,'archive',{cohortId:id,...fields},/closed receipt ingress/);
 s=open(bind(s));reject(s,'archive',{cohortId:id,settled:true,pendingReceipts:0},/settled unbound/);
 assert.equal(s.soldiers,10);assert.equal(s.cohorts[0].generation,1);
});
test('archived births require explicit combat-domain resolution rather than silently entering simulation losses',()=>{
 const s=archive(create(initial(10)));
 reject(s,'open',{host:'A',cohortIds:[]},/archived host births/);reject(s,'simulatedLoss',{host:'A',sequence:null,scope:'uncovered-reserve',count:1},/unsettled/);
 assert.equal(s.soldiers,10);assert.equal(s.pools[0].count,9);
});
test('reactivated native instance uses a fresh generation; old closed receipt cannot debit the same surviving birth',()=>{
 let s=open(bind(create(initial(10),2))),old=deathReceiptV3(s,s.cohorts[0].id),birth=structuredClone(s.cohorts[0]);s=close(s);s=release(s);s=archive(s);s=reactivate(s,1);s=bind(s);s=open(s);
 assert.deepEqual(s.cohorts[0],birth);assert.ok(s.bindings[0].instanceGeneration>old.instanceGeneration);
 const replay=tx(s,{type:'physicalDeath',revision:0,receipt:old});assert.equal(replay.ok,true);assert.equal(replay.changed,false);assert.equal(replay.state,s);
 const current=deathReceiptV3(s,birth.id);reject(s,'physicalDeath',{receipt:{...current,instanceGeneration:old.instanceGeneration,actorToken:old.actorToken}},/mismatch/);
 s=apply(s,'physicalDeath',{receipt:current});assert.equal(s.soldiers,8);assert.equal(s.cohorts.length,0);assert.equal(s.engagement.coverage[0].consumed,true);
});
test('killed birth never appears in archive or reactivation and duplicate receipt stays a no-op',()=>{
 let s=open(bind(create(initial(5),2))),receipt=deathReceiptV3(s,s.cohorts[0].id);s=apply(s,'physicalDeath',{receipt});const replay=tx(s,{type:'physicalDeath',revision:0,receipt});assert.equal(replay.changed,false);s=close(s);
 reject(s,'reactivate',{cohortId:receipt.cohortId,generation:1,settled:true,pendingReceipts:0},/absent archived/);assert.equal(archivedBirthV3(s,receipt.cohortId,1),null);
 s=apply(s,'recruit',{host:'A',count:2});s=create(s,2);assert.equal(s.cohorts[0].generation,2);assert.equal(s.soldiers,5);
});
test('archive fragmentation cap refuses atomically; ordinary recruitment still succeeds and surviving identities remain explicit',()=>{
 let s=initial(1000);for(let i=0;i<V3_LIMITS.archiveRanges;i++)s=archive(create(s,i%2+1));assert.equal(s.archives.length,128);s=create(s,1);const birth=s.cohorts[0];
 reject(s,'archive',{cohortId:birth.id,settled:true,pendingReceipts:0},/fragmentation/);assert.equal(s.cohorts[0].id,birth.id);s=apply(s,'recruit',{host:'A',count:10000});assert.equal(s.soldiers,11000);assert.equal(s.archives.length,128);
});
test('splitting a full archive table can refuse reactivation without losing any saved birth or count',()=>{
 let s=initial(1000);for(let i=0;i<130;i++)s=archive(create(s,i<3?1:i%2+1));
 // Generation1..3 compress; the remaining127 alternating snapshots use127ranges.
 assert.equal(s.archives.length,128);assert.deepEqual([s.archives[0].from,s.archives[0].to],[1,3]);
 reject(s,'reactivate',{cohortId:'archive:cohort:2',generation:2,settled:true,pendingReceipts:0},/fragmentation/);
 assert.equal(archivedBirthV3(s,'archive:cohort:2',2).generation,2);assert.equal(s.soldiers,1000);
});
test('working birth capacity and identity-mismatched or duplicate reactivation preserve archive',()=>{
 let s=archive(create(initial(1000)));for(let i=0;i<128;i++)s=create(s);
 reject(s,'reactivate',{cohortId:'archive:cohort:1',generation:1,settled:true,pendingReceipts:0},/working birth capacity/);
 s=archive(s,s.cohorts[0]);reject(s,'reactivate',{cohortId:'archive:cohort:99',generation:1,settled:true,pendingReceipts:0},/identity mismatch/);
 s=reactivate(s,1);reject(s,'reactivate',{cohortId:'archive:cohort:1',generation:1,settled:true,pendingReceipts:0},/working birth capacity|absent archived/);
});
test('corrupt overlapping ranges, duplicated live birth, invalid snapshots and future version refuse',()=>{
 const base=archive(create(initial(20))),mutations=[s=>s.archives.push({...s.archives[0]}),s=>s.cohorts.push({id:'archive:cohort:1',generation:1,headcount:1,home:'A',host:'A'}),s=>s.archives[0].headcount=0,s=>s.archives[0].to=s.nextGeneration,s=>s.v=4,s=>s.soldiers++];
 for(const mutate of mutations){const s=structuredClone(base);mutate(s);const before=JSON.stringify(s),r=tx(s,{type:'recruit',revision:s.revision,host:'A',count:1});assert.equal(r.ok,false);assert.equal(r.state,s);assert.equal(JSON.stringify(s),before);}
});
test('huge safe generation spans support constant-range direct lookup and safe aggregate overflow refusal',()=>{
 const s=initial(0),max=Number.MAX_SAFE_INTEGER;s.nextGeneration=max;s.archives=[{from:1,to:max-1,headcount:1,home:'A',host:'A'}];s.soldiers=max-1;s.provinces[0].reserve=max-1;assert.equal(validateV3(s),true);assert.equal(archivedBirthV3(s,'archive:cohort:'+(max-2),max-2).generation,max-2);
 reject(s,'recruit',{host:'A',count:2},/safe integer/);assert.ok(v3SavedBytes(s)<1000);
});
test('archive receipts/metadata remain bounded after500reactivate-bind-release-archive cycles with stable birth',()=>{
 let s=archive(create(initial(10))),birth=archivedBirthV3(s,'archive:cohort:1',1);
 for(let i=0;i<500;i++){s=reactivate(s,1);s=bind(s);s=release(s);s=archive(s);}
 assert.deepEqual(archivedBirthV3(s,birth.id,1),birth);assert.equal(s.nextGeneration,2);assert.equal(s.nextInstance,501);assert.equal(s.archives.length,1);assert.equal(s.bindings.length,0);assert.equal(s.engagement,null);assert.ok(v3SavedBytes(s)<1000);
});
test('frozen archive transaction and state roundtrip preserve input; unsettled upgrade holds oldschema',()=>{
 const s=frozen(create(initial(10))),c=s.cohorts[0],cmd=frozen({type:'archive',revision:s.revision,cohortId:c.id,settled:true,pendingReceipts:0}),r=tx(s,cmd);assert.equal(r.ok,true,r.reason);assert.equal(s.archives.length,0);assert.equal(r.state.archives.length,1);assert.equal(validateV3(JSON.parse(JSON.stringify(r.state))),true);
 let v2=migrateReserveV2({lineage:'old',provinces:[{id:'A',controller:'kingdom',soldiers:5}]}).state;v2=transactReserveV2(v2,{type:'materialize',revision:0,home:'A',host:'A',headcount:5}).state;v2=transactReserveV2(v2,{type:'bind',revision:1,cohortId:v2.cohorts[0].id,actorToken:'actor'}).state;
 const held=upgradeReserveV2ToArchiveV3(v2,{settled:true,pendingReceipts:0});assert.equal(held.ok,false);assert.equal(held.state,v2);assert.equal(v2.v,2);
});

test('a current consumed receipt cannot coexist with an archived copy disguised at another host',()=>{
 let s=initial(5,[{id:'B',controller:'kingdom',soldiers:0}]);s=open(bind(create(s,2)));const receipt=deathReceiptV3(s,s.cohorts[0].id);s=apply(s,'physicalDeath',{receipt});
 s.archives=[{from:receipt.generation,to:receipt.generation,headcount:2,home:'A',host:'B'}];s.soldiers+=2;s.provinces.find(p=>p.id==='B').reserve+=2;
 assert.throws(()=>validateV3(s),/covered or consumed birth/);
 const before=JSON.stringify(s);assert.equal(tx(s,{type:'recruit',revision:s.revision,host:'A',count:1}).ok,false);assert.equal(JSON.stringify(s),before);
});

test('200 covered engagements compact death receipts while one exact survivor repeatedly archives and reactivates',()=>{
 let s=archive(create(initial(3),1)),firstDeath;
 for(let i=0;i<200;i++){
  s=reactivate(s,1);s=bind(s);s=create(s,2);s=bind(s);s=open(s);
  const casualty=s.cohorts.find(c=>c.generation!==1),receipt=deathReceiptV3(s,casualty.id);firstDeath??=receipt;s=apply(s,'physicalDeath',{receipt});
  assert.equal(tx(s,{type:'physicalDeath',revision:0,receipt}).changed,false);
  s=close(s);s=release(s,s.cohorts[0]);s=archive(s);s=apply(s,'recruit',{host:'A',count:2});
  assert.equal(s.soldiers,3);assert.equal(s.archives.length,1);assert.equal(s.engagement,null);assert.equal(s.cohorts.length,0);assert.ok(v3SavedBytes(s)<1000);
 }
 assert.equal(s.closedThrough,200);assert.equal(s.nextGeneration,202);assert.equal(archivedBirthV3(s,'archive:cohort:1',1).headcount,1);assert.equal(archivedBirthV3(s,firstDeath.cohortId,firstDeath.generation),null);
 const stale=tx(s,{type:'physicalDeath',revision:0,receipt:firstDeath});assert.equal(stale.ok,true);assert.equal(stale.changed,false);assert.equal(stale.state,s);
});
