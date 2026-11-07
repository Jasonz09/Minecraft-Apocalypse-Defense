import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createArchiveChunkStore,STORE_LIMITS,utf8Bytes,splitUtf8} from './chunk-store-v1.mjs';
import {migrateArchiveV3,transactArchiveV3,validateV3,v3Aggregate} from './archive-v3.mjs';
const initial=n=>migrateArchiveV3({lineage:'store_trial',provinces:[{id:'A',controller:'kingdom',soldiers:n}]}).state;
const next=s=>{const r=transactArchiveV3(s,{type:'recruit',revision:s.revision,host:s.provinces[0].id,count:1});assert.equal(r.ok,true,r.reason);return r.state;};
function fake(entries=[]){
 const state={map:new Map(entries),writes:[],reads:0,attempt:0,fault:null,dead:false,onGet:null,onSet:null};
 const kv={get(key){if(state.dead)throw new Error('process dead');state.reads++;state.onGet?.(key);return state.map.get(key);},set(key,value){if(state.dead)throw new Error('process dead');state.attempt++;const hit=state.fault?.at===state.attempt,mode=state.fault?.mode;
  if(hit&&mode==='before'){state.dead=true;throw new Error('crash before write');}
  if(value!==undefined)assert.ok(utf8Bytes(value)<=32767,'actual native property byte limit');
  if(!(hit&&mode==='drop')){if(value===undefined)state.map.delete(key);else state.map.set(key,hit&&mode==='truncate'?value.slice(0,Math.max(1,value.length-3)):value);}
  state.writes.push({key,value,head:state.map.get('trial:military_archive:head')??null});state.onSet?.(key,value);
  if(hit&&mode==='after'){state.dead=true;throw new Error('crash after write');}
 }};
 const restart=()=>{state.dead=false;state.attempt=0;state.fault=null;state.onGet=null;state.onSet=null;return createArchiveChunkStore(kv);};
 return{state,kv,restart,store:createArchiveChunkStore(kv)};
}
function seeded(s=initial(10)){const h=fake(),r=h.store.publish(s,{expectedHead:null});assert.equal(r.ok,true,r.reason);h.state.writes=[];h.state.attempt=0;return{...h,s,head:r.headToken};}
const commit=(h,s)=>{const before=h.store.load();const r=h.store.publish(s,{expectedHead:before.headToken});assert.equal(r.ok,true,r.reason);return r;};
function largeState(){
 const lineage='X'.repeat(24),ids=Array.from({length:32},(_,i)=>'province_'+String(i).padStart(2,'0')+'_origin');
 const s={v:3,lineage,groupSize:5,revision:0,soldiers:0,nextGeneration:384,nextInstance:129,nextEngagement:2,closedThrough:0,
  provinces:ids.map(id=>({id,controller:'kingdom',front:0,reserve:0})),pools:[],cohorts:[],bindings:[],archives:[],engagement:null};
 for(const home of ids){s.pools.push({home,host:home,count:100000});}
 for(const home of ids)for(const host of ids){if(home!==host&&s.pools.length<256)s.pools.push({home,host,count:12345});}
 s.pools.sort((a,b)=>(a.home+':'+a.host).localeCompare(b.home+':'+b.host));
 for(let i=1;i<=128;i++){
  const c={id:lineage+':cohort:'+i,generation:i,headcount:5,home:ids[i%32],host:i<=32?ids[0]:ids[1+i%31]};s.cohorts.push(c);s.bindings.push({cohortId:c.id,instanceGeneration:i,actorToken:('actor_'+i+'_').padEnd(64,'x')});
  s.archives.push({from:127+i*2,to:127+i*2,headcount:i%2+1,home:ids[i%32],host:ids[1+i%31]});
 }
 s.engagement={sequence:1,host:ids[0],coverage:s.cohorts.slice(0,32).map((c,i)=>({...c,instanceGeneration:i+1,actorToken:s.bindings[i].actorToken,consumed:false}))};
 const totals=v3Aggregate(s);s.soldiers=totals.total;for(const p of s.provinces)p.reserve=totals.hosts[p.id];assert.equal(validateV3(s),true);return s;
}

test('UTF8 byte accounting and splitting handle multibyte/codepoint boundaries instead of UTF16 lengths',()=>{
 for(const text of ['ascii','é'.repeat(18000),'🎯'.repeat(10000),'a\ud800b','a\udfffz']){
  assert.equal(utf8Bytes(text),Buffer.byteLength(text,'utf8'));const parts=splitUtf8(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>Buffer.byteLength(p,'utf8')<=24000));
 }
 assert.throws(()=>splitUtf8('x',32768),/property bound/);assert.throws(()=>splitUtf8('x',3),/integer/);
});
test('first initialization and a second commit use12fixed keys and one head publication after verified chunks',()=>{
 const h=fake(),s=initial(10);assert.equal(h.store.load().status,'absent');const r=h.store.publish(s,{expectedHead:null});assert.equal(r.status,'committed');assert.equal(h.state.writes.length,8);
 const keys=h.store.keys;assert.equal(keys.all.length,12);assert.equal(new Set(keys.all).size,12);assert.ok(h.state.writes.slice(0,6).every(w=>w.head===null));assert.equal(h.state.writes[6].key,keys.head);
 const old=r.headToken;h.state.writes=[];const n=next(s);commit(h,n);assert.ok(h.state.writes.slice(0,6).every(w=>w.head===old));assert.deepEqual(h.store.load().state,n);assert.equal(h.store.load().writable,true);
});
test('sizing at32provinces/256pools/128births/128ranges/128bindings/32coverage chunks under32767bytes',t=>{
 const s=largeState(),h=fake(),r=h.store.publish(s,{expectedHead:null});assert.equal(r.ok,true,r.reason);assert.equal(r.manifest.chunks.length,4);assert.ok(r.manifest.payloadBytes>32767);assert.ok(r.manifest.payloadBytes<=96000);
 assert.deepEqual(h.store.load().state,s);assert.ok([...h.state.map.values()].every(v=>utf8Bytes(v)<=32767));assert.equal(h.state.map.size,6);assert.equal(h.state.writes.length,8);assert.ok(h.state.reads<180);
 t.diagnostic(`Payload ${r.manifest.payloadBytes} UTF8 bytes;4datachunks;maxproperty ${Math.max(...[...h.state.map.values()].map(utf8Bytes))} bytes;${h.state.reads} total injected reads through load,8writes.`);
});
test('failure before/after every one of8 initialization writes leaves absent-or-complete authority and recovers safely',()=>{
 for(const mode of ['before','after'])for(let at=1;at<=8;at++){
  const h=fake(),s=initial(10);h.state.fault={mode,at};assert.equal(h.store.publish(s,{expectedHead:null}).ok,false);h.store=h.restart();
  const before=h.store.load();assert.ok(['absent','pending','ok'].includes(before.status),`${mode}${at}:${before.reason}`);
  const root=h.state.map.get(h.store.keys.head);if(root!==undefined)assert.deepEqual(before.state,s);
  const r=h.store.recover();assert.equal(r.ok,true,r.reason);const loaded=h.store.load();assert.ok(['absent','ok'].includes(loaded.status));if(loaded.status==='ok')assert.deepEqual(loaded.state,s);else assert.equal(h.state.map.size,0);
 }
});
test('failure before/after every update write preserves old head until complete publish, never mixes generations',()=>{
 for(const mode of ['before','after'])for(let at=1;at<=8;at++){
  const h=seeded(),n=next(h.s),oldBank=JSON.parse(h.head).bank,oldData=[...h.state.map].filter(([k])=>k.includes('bank'+oldBank+':'));
  h.state.fault={mode,at};assert.equal(h.store.publish(n,{expectedHead:h.head}).ok,false);h.store=h.restart();const loaded=h.store.load();assert.equal(loaded.status,'ok',loaded.reason);assert.ok([h.s.revision,n.revision].includes(loaded.state.revision));
  if(at<7||at===7&&mode==='before'){assert.equal(loaded.headToken,h.head);assert.deepEqual(loaded.state,h.s);}else assert.deepEqual(loaded.state,n);
  for(const [key,value]of oldData)assert.equal(h.state.map.get(key),value,'previous committed bank unchanged');
  assert.equal(h.store.recover().ok,true);assert.equal(h.store.load().writable,true);assert.deepEqual(h.store.load().state,loaded.state);
 }
});
test('every rollback recovery delete tolerates before/after interruption without harming the committed bank',()=>{
 const base=seeded();base.state.fault={mode:'after',at:4};base.store.publish(next(base.s),{expectedHead:base.head});base.restart();const image=[...base.state.map];
 for(const mode of ['before','after'])for(let at=1;at<=6;at++){
  const h=fake(image);h.state.fault={mode,at};assert.equal(h.store.recover().ok,false);h.store=h.restart();assert.deepEqual(h.store.load().state,base.s);assert.equal(h.store.recover().ok,true);assert.deepEqual(h.store.load().state,base.s);assert.equal(h.store.load().writable,true);
 }
});
test('finalization interruption after head publication recovers the new state, never rolls it back',()=>{
 const h=seeded(),n=next(h.s);h.state.fault={mode:'after',at:7};h.store.publish(n,{expectedHead:h.head});h.store=h.restart();assert.equal(h.store.load().pending,'published-needs-finalize');
 for(const mode of ['before','after']){const replay=fake([...h.state.map]);replay.state.fault={mode,at:1};assert.equal(replay.store.recover().ok,false);replay.store=replay.restart();assert.deepEqual(replay.store.load().state,n);assert.equal(replay.store.recover().ok,true);assert.deepEqual(replay.store.load().state,n);}
});
test('silently dropped writes are detected by readback; no unverified root is published',()=>{
 for(let at=1;at<=8;at++){
  const h=seeded(),n=next(h.s);h.state.fault={mode:'drop',at};const r=h.store.publish(n,{expectedHead:h.head});
  // Deleting an already absent unused chunk is an idempotent no-op, not a lost required write.
  if([3,4,5].includes(at)){assert.equal(r.ok,true);assert.deepEqual(h.store.load().state,n);continue;}
  assert.equal(r.ok,false,`drop${at}`);const loaded=h.store.load();assert.equal(loaded.status,'ok',loaded.reason);assert.ok([h.s.revision,n.revision].includes(loaded.state.revision));assert.equal(h.store.recover().ok,true);
 }
});
test('corrupt/future active head and missing authority refuse without fallback or writes',()=>{
 for(const mutate of [(raw)=>'{',(raw)=>JSON.stringify({...JSON.parse(raw),v:3}),(raw)=>JSON.stringify({...JSON.parse(raw),format:'unknown'})]){
  const h=seeded();h.state.map.set(h.store.keys.head,mutate(h.head));const before=[...h.state.map],writes=h.state.writes.length;assert.equal(h.store.load().status,'refused');assert.equal(h.store.recover().ok,false);assert.equal(h.state.writes.length,writes);assert.deepEqual([...h.state.map],before);
 }
 const h=seeded();h.state.map.delete(h.store.keys.head);assert.equal(h.store.load().status,'refused');assert.equal(h.store.publish(initial(0),{expectedHead:null}).ok,false);assert.ok(h.state.map.size>0);
});
test('active payload tampering, truncation, missing/extra chunks and state mismatch all quarantine',()=>{
 const mutations=[(h,m)=>h.state.map.set(h.store.keys.chunk(m.bank,0),'{}'),(h,m)=>h.state.map.delete(h.store.keys.chunk(m.bank,0)),(h,m)=>h.state.map.set(h.store.keys.chunk(m.bank,1),'unexpected'),(h,m)=>h.state.map.set(h.store.keys.meta(m.bank),'{}')];
 for(const mutate of mutations){const h=seeded(),m=JSON.parse(h.head);mutate(h,m);const writes=h.state.writes.length;assert.equal(h.store.load().status,'refused');assert.equal(h.store.recover().ok,false);assert.equal(h.state.writes.length,writes);}
});
test('future/corrupt journal holds a valid prior head without deleting evidence or continuing publication',()=>{
 for(const raw of ['{',JSON.stringify({v:3,previous:null,next:'x',standby:null}),'x'.repeat(32768)]){
  const h=seeded();h.state.map.set(h.store.keys.journal,raw);const before=[...h.state.map];assert.equal(h.store.load().status,'refused');assert.equal(h.store.recover().ok,false);assert.equal(h.store.publish(next(h.s),{expectedHead:h.head}).ok,false);assert.deepEqual([...h.state.map],before);
 }
});
test('stale tokens, lineage reset, skipped revision and invalid roster reject before the first write',()=>{
 const h=seeded(),before=[...h.state.map];for(const [s,token]of [[next(h.s),'stale'],[{...next(h.s),lineage:'other'},h.head],[{...next(h.s),revision:9},h.head],[{...next(h.s),v:4},h.head]])assert.equal(h.store.publish(s,{expectedHead:token}).ok,false);
 assert.equal(h.state.writes.length,0);assert.deepEqual([...h.state.map],before);const noop=h.store.publish(h.s,{expectedHead:h.head});assert.equal(noop.status,'unchanged');assert.equal(h.state.writes.length,0);
});
test('unexpected external head or journal change holds staging without deleting foreign authority',()=>{
 for(const field of ['head','journal']){const h=seeded();let changed=false;h.state.onSet=(key)=>{if(!changed&&key===h.store.keys.chunk(1,0)){changed=true;h.state.map.set(h.store.keys[field],'foreign authority');}};
  assert.equal(h.store.publish(next(h.s),{expectedHead:h.head}).ok,false);assert.equal(h.state.map.get(h.store.keys[field]),'foreign authority');assert.equal(h.store.load().status,'refused');assert.equal(h.store.recover().ok,false);
 }
});
test('bounded standby cleanup never removes another namespace and future standby manifests are preserved',()=>{
 const h=seeded();h.state.map.set('other:valuable','keep');h.state.fault={mode:'after',at:3};h.store.publish(next(h.s),{expectedHead:h.head});h.store=h.restart();assert.equal(h.store.recover().ok,true);assert.equal(h.state.map.get('other:valuable'),'keep');
 h.state.map.set(h.store.keys.meta(1),JSON.stringify({...JSON.parse(h.head),v:3,bank:1}));const before=[...h.state.map];assert.equal(h.store.publish(next(h.s),{expectedHead:h.head}).ok,false);assert.deepEqual([...h.state.map],before);
});
test('pending initial publish never masquerades as fresh empty storage and corrupt staged future metadata refuses rollback',()=>{
 const h=fake();h.state.fault={mode:'after',at:1};h.store.publish(initial(10),{expectedHead:null});h.store=h.restart();assert.equal(h.store.load().status,'pending');assert.equal(h.store.publish(initial(0),{expectedHead:null}).ok,false);
 const journal=JSON.parse(h.state.map.get(h.store.keys.journal)),nextMeta=JSON.parse(journal.next);h.state.map.set(h.store.keys.meta(0),JSON.stringify({...nextMeta,v:9}));const before=[...h.state.map];assert.equal(h.store.recover().ok,false);assert.deepEqual([...h.state.map],before);
});
test('large-to-small-to-large valid transitions clear unused old chunks and stay bounded across100commits',()=>{
 const h=fake();let s=largeState();assert.equal(h.store.publish(s,{expectedHead:null}).ok,true);
 const mutate=(type,fields)=>{const r=transactArchiveV3(s,{type,revision:s.revision,...fields});assert.equal(r.ok,true,r.reason);s=r.state;return commit(h,s);};
 const survivors=s.engagement.coverage.map(c=>({cohortId:c.id,instanceGeneration:c.instanceGeneration,actorToken:c.actorToken}));
 let r=mutate('close',{sequence:1,quiescent:true,pendingReceipts:0,survivors});assert.equal(r.manifest.chunks.length,3);
 s=next(s);r=commit(h,s);assert.equal(r.manifest.bank,0);assert.equal(r.manifest.chunks.length,3);assert.equal(h.state.map.get(h.store.keys.chunk(0,3)),undefined,'previous4thchunk deleted only in inactive bank');
 r=mutate('open',{host:s.provinces[0].id,cohortIds:s.cohorts.filter(c=>c.host===s.provinces[0].id).map(c=>c.id)});assert.equal(r.manifest.chunks.length,4);
 for(let i=0;i<100;i++){s=next(s);commit(h,s);assert.ok(h.state.map.size<=11);assert.equal(h.store.load().pending,null);assert.deepEqual(h.store.load().state,s);}
 assert.equal(h.store.keys.all.length,12);assert.ok(h.state.writes.every(w=>w.value===undefined||utf8Bytes(w.value)<=32767));
});
function rewriteConsistentPayload(h,mutate){
 const state=structuredClone(h.s);mutate(state);const raw=JSON.stringify(state),parts=splitUtf8(raw),m=JSON.parse(h.head),digest=x=>createHash('sha256').update(x,'utf8').digest('hex');
 m.payloadBytes=utf8Bytes(raw);m.sha256=digest(raw);m.chunks=parts.map(p=>({bytes:utf8Bytes(p),sha256:digest(p)}));
 for(let i=0;i<4;i++){const key=h.store.keys.chunk(m.bank,i);if(parts[i]===undefined)h.state.map.delete(key);else h.state.map.set(key,parts[i]);}
 const head=JSON.stringify(m);h.state.map.set(h.store.keys.meta(m.bank),head);h.state.map.set(h.store.keys.head,head);
}
test('digest-consistent but invalid/future roster payloads and lineage mismatches still refuse without writes',()=>{
 for(const mutate of [s=>s.soldiers++,s=>s.v=4,s=>s.lineage='forged_lineage']){const h=seeded();rewriteConsistentPayload(h,mutate);const before=[...h.state.map];assert.equal(h.store.load().status,'refused');assert.equal(h.store.recover().ok,false);assert.deepEqual([...h.state.map],before);assert.equal(h.state.writes.length,0);}
});
test('journal cannot point staging at current bank or leap generations and thereby erase authoritative data',()=>{
 for(const change of [m=>m.bank=0,m=>m.sequence+=2,m=>m.revision+=2]){const h=seeded();h.state.fault={mode:'after',at:1};h.store.publish(next(h.s),{expectedHead:h.head});h.store=h.restart();const journal=JSON.parse(h.state.map.get(h.store.keys.journal)),m=JSON.parse(journal.next);change(m);journal.next=JSON.stringify(m);h.state.map.set(h.store.keys.journal,JSON.stringify(journal));const before=[...h.state.map],writes=h.state.writes.length;assert.equal(h.store.recover().ok,false);assert.deepEqual([...h.state.map],before);assert.equal(h.state.writes.length,writes);}
});
test('head or journal changing during a bank read prevents a stale writable load snapshot',()=>{
 for(const field of ['head','journal']){const h=seeded();let changed=false;h.state.onGet=key=>{if(!changed&&key===h.store.keys.chunk(0,0)){changed=true;h.state.map.set(h.store.keys[field],'foreign');}};assert.equal(h.store.load().status,'refused');assert.equal(h.state.writes.length,0);assert.equal(h.state.map.get(h.store.keys[field]),'foreign');}
});

test('torn/truncated property writes either roll back owned staging or refuse without resurrecting the prior roster',()=>{
 for(const at of [1,2,6,7]){const h=seeded(),n=next(h.s);h.state.fault={mode:'truncate',at};assert.equal(h.store.publish(n,{expectedHead:h.head}).ok,false);h.state.fault=null;
  const root=h.state.map.get(h.store.keys.head);if(at<7)assert.equal(root,h.head,'only staging was touched before publish');
  const recovered=h.store.recover();assert.equal(recovered.ok,false);assert.equal(h.state.map.get(h.store.keys.head),root);
 }
});
function injectedBankImage({lineage='foreign',bank=1,sequence=2,revision=1,count=10,previousHeadHash='f'.repeat(64)}={}){
 const state=migrateArchiveV3({lineage,provinces:[{id:'A',controller:'kingdom',soldiers:count}]}).state;state.revision=revision;const raw=JSON.stringify(state),parts=splitUtf8(raw),digest=x=>createHash('sha256').update(x,'utf8').digest('hex');
 const m={v:2,bank,sequence,format:'military-archive-v3',lineage,revision,previousHeadHash:sequence===1?null:previousHeadHash,payloadBytes:utf8Bytes(raw),sha256:digest(raw),chunks:parts.map(p=>({bytes:utf8Bytes(p),sha256:digest(p)}))};
 return{manifest:JSON.stringify(m),parts,state};
}
function installImage(h,image){const m=JSON.parse(image.manifest);h.state.map.set(h.store.keys.meta(m.bank),image.manifest);for(let i=0;i<4;i++){if(image.parts[i]===undefined)h.state.map.delete(h.store.keys.chunk(m.bank,i));else h.state.map.set(h.store.keys.chunk(m.bank,i),image.parts[i]);}}
function journalOnlyImage(){const h=seeded();h.state.fault={mode:'after',at:1};h.store.publish(next(h.s),{expectedHead:h.head});h.store=h.restart();assert.equal(h.store.load().pending,'preparing');return h;}

test('valid foreign-lineage or future inactive bank is refused before publish writes and preserved byte-for-byte',()=>{
 for(const image of [injectedBankImage(),injectedBankImage({lineage:'store_trial',sequence:100,revision:99})]){const h=seeded();installImage(h,image);const before=[...h.state.map],writes=h.state.writes.length,r=h.store.publish(next(h.s),{expectedHead:h.head});
 assert.equal(r.ok,false);assert.match(r.reason,/unknown\/foreign\/future standby/);assert.equal(h.state.writes.length,writes);assert.deepEqual([...h.state.map],before);assert.deepEqual(h.store.load().state,h.s);}
});
test('after journal-only crash valid foreign and future standby evidence cannot be deleted by recovery',()=>{
 for(const image of [injectedBankImage(),injectedBankImage({lineage:'store_trial',sequence:100,revision:99})]){
  const h=journalOnlyImage();installImage(h,image);const before=[...h.state.map],writes=h.state.writes.length,r=h.store.recover();
  assert.equal(r.ok,false);assert.match(r.reason,/unknown staged manifest/);assert.equal(h.state.writes.length,writes);assert.deepEqual([...h.state.map],before);assert.equal(h.state.map.get(h.store.keys.head),h.head);assert.equal(h.store.load().writable,false);
 }
});
test('same-lineage previous counters alone do not authorize forged historical standby; prior head hash must match',()=>{
 const h=seeded();commit(h,next(h.s));const root=h.store.load(),image=injectedBankImage({lineage:'store_trial',bank:0,sequence:1,revision:0,count:99});installImage(h,image);const before=[...h.state.map],writes=h.state.writes.length;
 assert.equal(h.store.publish(next(root.state),{expectedHead:root.headToken}).ok,false);assert.equal(h.state.writes.length,writes);assert.deepEqual([...h.state.map],before);assert.deepEqual(h.store.load().state,root.state);
});
test('journal binds exact authorized prior standby and next token; its token cannot be replaced by another valid past image',()=>{
 const h=seeded();commit(h,next(h.s));const current=h.store.load(),oldStandby=h.state.map.get(h.store.keys.meta(0));h.state.attempt=0;h.state.fault={mode:'after',at:1};h.store.publish(next(current.state),{expectedHead:current.headToken});h.store=h.restart();
 const j=JSON.parse(h.state.map.get(h.store.keys.journal));assert.equal(j.v,2);assert.equal(j.standby,oldStandby);assert.equal(JSON.parse(current.headToken).previousHeadHash,createHash('sha256').update(oldStandby).digest('hex'));
 const image=injectedBankImage({lineage:'store_trial',bank:0,sequence:1,revision:0,count:77});installImage(h,image);const before=[...h.state.map];assert.equal(h.store.recover().ok,false);assert.deepEqual([...h.state.map],before);
});
test('late foreign metadata or unrecognized bytes stop cleanup before another destructive delete',()=>{
 for(const change of ['metadata','data']){const h=journalOnlyImage(),image=injectedBankImage(),nextMeta=JSON.parse(JSON.parse(h.state.map.get(h.store.keys.journal)).next);let once=false;
  h.state.onSet=key=>{if(!once&&key===h.store.keys.chunk(nextMeta.bank,0)){once=true;if(change==='metadata')installImage(h,image);else h.state.map.set(h.store.keys.chunk(nextMeta.bank,1),'unknown foreign bytes');}};
  const before=h.state.writes.length,r=h.store.recover();assert.equal(r.ok,false);assert.equal(h.state.writes.length,before+1,'only the old authorized first delete precedes injection');assert.equal(h.state.map.get(h.store.keys.head),h.head);
  if(change==='metadata')assert.equal(h.state.map.get(h.store.keys.meta(1)),image.manifest);else assert.equal(h.state.map.get(h.store.keys.chunk(1,1)),'unknown foreign bytes');
 }
});
test('previous protocol manifests/journals refuse implicit migration and remain untouched',()=>{
 for(const which of ['head','journal']){const h=which==='head'?seeded():journalOnlyImage(),key=h.store.keys[which],old=JSON.parse(h.state.map.get(key));old.v=1;h.state.map.set(key,JSON.stringify(old));const before=[...h.state.map],writes=h.state.writes.length;assert.equal(h.store.load().status,'refused');assert.equal(h.store.recover().ok,false);assert.equal(h.state.writes.length,writes);assert.deepEqual([...h.state.map],before);}
});
test('in-memory negative controls reproduce foreign overwrite and foreign/future recovery deletion when authorization is removed',async()=>{
 const {readFileSync}=await import('node:fs'),url=new URL('./chunk-store-v1.mjs',import.meta.url),source=readFileSync(url,'utf8').replace(/\r\n/g,'\n');
 const load=code=>import('data:text/javascript,'+encodeURIComponent(code.replace(/from\s+['"](\.[^'"]+)['"]/g,(_,p)=>'from '+JSON.stringify(new URL(p,url).href))));
 const permissive=await load(source.replace(/function allowedPriorStandby\(raw,prior,nextBank\)\{[\s\S]*?\n\}\nfunction parseJournal/,"function allowedPriorStandby(raw,prior,nextBank){return raw===null?null:parseManifest(raw);}\nfunction parseJournal"));
 {const h=seeded(),image=injectedBankImage();installImage(h,image);assert.equal(h.store.publish(next(h.s),{expectedHead:h.head}).ok,false,'live authorization refuses');const broken=permissive.createArchiveChunkStore(h.kv);const r=broken.publish(next(h.s),{expectedHead:h.head});assert.equal(r.ok,true,r.reason);assert.notEqual(h.state.map.get(h.store.keys.meta(1)),image.manifest,'negative control overwrites the foreign manifest');}
 const noCleanupGuard=await load(source.replace(/ function stagingGuard\(journal\)\{[\s\S]*?\n \}\n function absentDataExcept/," function stagingGuard(journal){}\n function absentDataExcept"));
 for(const image of [injectedBankImage(),injectedBankImage({lineage:'store_trial',sequence:100,revision:99})]){const h=journalOnlyImage();installImage(h,image);assert.equal(h.store.recover().ok,false,'live cleanup preserves');const broken=noCleanupGuard.createArchiveChunkStore(h.kv),r=broken.recover();assert.equal(r.ok,true,r.reason);assert.equal(h.state.map.get(h.store.keys.meta(1)),undefined,'negative control deletes valid unknown evidence');assert.equal(h.state.map.get(h.store.keys.head),h.head);}
});

test('before/after every update write also recovers when an authenticated historical standby already exists',()=>{
 for(const mode of ['before','after'])for(let at=1;at<=8;at++){
  const h=seeded();const second=next(h.s);commit(h,second);const root=h.store.load(),third=next(second);h.state.attempt=0;h.state.fault={mode,at};assert.equal(h.store.publish(third,{expectedHead:root.headToken}).ok,false);h.store=h.restart();
  const seen=h.store.load();assert.equal(seen.status,'ok',seen.reason);assert.ok([second.revision,third.revision].includes(seen.state.revision));
  if(at<7||at===7&&mode==='before'){assert.deepEqual(seen.state,second);assert.equal(seen.headToken,root.headToken);}else assert.deepEqual(seen.state,third);
  const recovered=h.store.recover();assert.equal(recovered.ok,true,recovered.reason);assert.deepEqual(h.store.load().state,seen.state);assert.equal(h.store.load().writable,true);
 }
});
