// ISOLATED NODE PROTOTYPE. No Minecraft/world access or production integration.
// Logical atomic publication assumes each get is fresh and one set replaces one
// whole property. It proves neither LevelDB flush order nor native death capture.
// Official string-byte limit: https://feedback.minecraft.net/hc/en-us/articles/19244682051341-Minecraft-Beta-Preview-1-20-40-20
// Stable World API: https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/world?view=minecraft-bedrock-stable
// Node crypto MUST NOT be imported into an active Bedrock script as-is.
import {createHash} from 'node:crypto';
import {validateV3,V3_LIMITS} from './archive-v3.mjs';
export const STORE_LIMITS=Object.freeze({propertyBytes:32767,chunkBytes:24000,chunks:4,payloadBytes:V3_LIMITS.savedBytes,keys:12});
const MAX=Number.MAX_SAFE_INTEGER,FORMAT='military-archive-v3';
const fail=m=>{throw new Error(m);};
const exact=(v,fields,label)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...fields].sort().join(','))fail(label+' fields invalid');};
const integer=(v,min,label)=>{if(!Number.isSafeInteger(v)||v<min)fail(label+' integer invalid');};
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function utf8Bytes(text){if(typeof text!=='string')throw new TypeError('string required');let bytes=0;for(const point of text){const code=point.codePointAt(0);bytes+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;}return bytes;}
export function splitUtf8(text,limit=STORE_LIMITS.chunkBytes){integer(limit,4,'chunk limit');if(limit>STORE_LIMITS.propertyBytes)fail('chunk exceeds property bound');const parts=[];let part='',size=0;for(const point of text){const width=utf8Bytes(point);if(size+width>limit){parts.push(part);part='';size=0;}part+=point;size+=width;}if(part||!parts.length)parts.push(part);return parts;}
const property=(raw,label)=>{if(typeof raw!=='string'||utf8Bytes(raw)>STORE_LIMITS.propertyBytes)fail(label+' is not a bounded string property');return raw;};
function parseManifest(raw){
 property(raw,'manifest');let m;try{m=JSON.parse(raw);}catch{fail('corrupt manifest JSON');}
 exact(m,['v','bank','sequence','format','lineage','revision','previousHeadHash','payloadBytes','sha256','chunks'],'manifest');
 if(m.v!==2)fail('unknown/corrupt/future manifest version');if(m.bank!==0&&m.bank!==1||m.format!==FORMAT||typeof m.lineage!=='string'||!/^[-A-Za-z0-9_]{1,24}$/.test(m.lineage))fail('manifest identity/format invalid');
 integer(m.sequence,1,'sequence');integer(m.revision,0,'revision');integer(m.payloadBytes,1,'payload bytes');if(m.sequence===1?m.previousHeadHash!==null:!hash(m.previousHeadHash))fail('manifest prior-head hash invalid');
 if(m.payloadBytes>STORE_LIMITS.payloadBytes||!hash(m.sha256)||!Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>STORE_LIMITS.chunks)fail('manifest size/hash/chunk bound');
 let total=0;for(const c of m.chunks){exact(c,['bytes','sha256'],'chunk descriptor');integer(c.bytes,1,'chunk bytes');if(c.bytes>STORE_LIMITS.chunkBytes||!hash(c.sha256))fail('chunk descriptor bound');total+=c.bytes;}
 if(total!==m.payloadBytes)fail('manifest payload sum mismatch');return m;
}
// The current head authenticates the exact immediate historical standby token.
// A merely valid manifest with plausible counters is not ownership permission.
function allowedPriorStandby(raw,prior,nextBank){
 if(raw===null)return null;const m=parseManifest(raw);
 if(!prior||m.bank!==nextBank||m.lineage!==prior.lineage||prior.sequence<=1
    ||m.sequence!==prior.sequence-1||m.revision!==prior.revision-1||sha(raw)!==prior.previousHeadHash)
  fail('unknown/foreign/future standby manifest; preserve evidence');
 return m;
}
function parseJournal(raw){
 property(raw,'journal');let j;try{j=JSON.parse(raw);}catch{fail('corrupt journal JSON');}exact(j,['v','previous','next','standby'],'journal');if(j.v!==2)fail('unknown/corrupt/future journal version');
 const next=parseManifest(j.next),prior=j.previous===null?null:parseManifest(j.previous);
 if(prior?(next.bank===prior.bank||prior.sequence===MAX||next.sequence!==prior.sequence+1||next.lineage!==prior.lineage||prior.revision===MAX||next.revision!==prior.revision+1||next.previousHeadHash!==sha(j.previous)):(next.bank!==0||next.sequence!==1||next.previousHeadHash!==null))fail('journal transition invalid');
 const standby=allowedPriorStandby(j.standby,prior,next.bank);
 return{...j,prior,nextManifest:next,standbyManifest:standby};
}
/** Inject {get(key),set(key,value|undefined)}. Single sequential writer required. */
export function createArchiveChunkStore(kv,{prefix='trial:military_archive:'}={}){
 if(!kv||typeof kv.get!=='function'||typeof kv.set!=='function'||typeof prefix!=='string'||!/^[-A-Za-z0-9_:]{1,72}$/.test(prefix))throw new TypeError('bounded namespace and injected KV required');
 const headKey=prefix+'head',journalKey=prefix+'journal',meta=b=>prefix+'bank'+b+':manifest',chunk=(b,i)=>prefix+'bank'+b+':chunk'+i;
 const allKeys=[headKey,journalKey,...[0,1].flatMap(b=>[meta(b),...Array.from({length:STORE_LIMITS.chunks},(_,i)=>chunk(b,i))])];
 let busy=false;
 const get=k=>kv.get(k);
 const readRoot=()=>{const raw=get(headKey);if(raw!==undefined)property(raw,'head');return raw??null;};
 const readJournal=()=>{const raw=get(journalKey);return raw===undefined?null:{raw,...parseJournal(raw)};};
 function bank(raw){
  const m=parseManifest(raw);if(get(meta(m.bank))!==raw)fail('bank manifest missing/changed');let payload='';
  for(let i=0;i<m.chunks.length;i++){const part=property(get(chunk(m.bank,i)),'data chunk');if(utf8Bytes(part)!==m.chunks[i].bytes||sha(part)!==m.chunks[i].sha256)fail('data chunk hash/length mismatch');payload+=part;}
  for(let i=m.chunks.length;i<STORE_LIMITS.chunks;i++)if(get(chunk(m.bank,i))!==undefined)fail('unexpected extra bank chunk');
  if(utf8Bytes(payload)!==m.payloadBytes||sha(payload)!==m.sha256)fail('payload digest/size mismatch');let state;try{state=JSON.parse(payload);}catch{fail('corrupt roster payload JSON');}
  validateV3(state);if(state.lineage!==m.lineage||state.revision!==m.revision)fail('payload lineage/revision mismatch');if(JSON.stringify(state)!==payload)fail('noncanonical roster serialization');return{manifest:m,state};
 }
 function guard(root,journal){if(readRoot()!==root||get(journalKey)!==journal)fail('authority/journal changed; quarantined');}
 function setChecked(key,value){if(value!==undefined)property(value,'write value');kv.set(key,value);if(get(key)!==value)fail('property readback mismatch');}
 function stagingGuard(journal){
  const current=get(meta(journal.nextManifest.bank));
  if(current!==undefined&&current!==journal.standby&&current!==journal.next)fail('unknown staged manifest; preserve evidence');
  // Atomic whole-slot writes can contain only an authorized old/new chunk or an
  // already-cleared slot. Corrupt/foreign bytes are quarantined, not deleted.
  for(let i=0;i<STORE_LIMITS.chunks;i++){
   const part=get(chunk(journal.nextManifest.bank,i));if(part===undefined)continue;property(part,'staged data');
   const candidates=[journal.standbyManifest?.chunks[i],journal.nextManifest.chunks[i]].filter(Boolean);
   if(!candidates.some(c=>c.bytes===utf8Bytes(part)&&c.sha256===sha(part)))fail('unrecognized staged chunk; preserve evidence');
  }
 }
 function absentDataExcept(exceptBank=null){for(const b of [0,1])if(b!==exceptBank){if(get(meta(b))!==undefined)fail('orphan/foreign bank metadata; quarantined');for(let i=0;i<STORE_LIMITS.chunks;i++)if(get(chunk(b,i))!==undefined)fail('orphan/foreign bank data; quarantined');}}
 function inspect(){
  const root=readRoot(),journal=readJournal();
  if(root===null){if(journal){if(journal.previous!==null)fail('missing authoritative head; quarantined');absentDataExcept(journal.nextManifest.bank);guard(null,journal.raw);return{status:'pending',state:null,headToken:null,writable:false};}absentDataExcept();guard(null,undefined);return{status:'absent',state:null,headToken:null,writable:true};}
  const read=bank(root);if(journal&&root!==journal.previous&&root!==journal.next)fail('head conflicts with pending journal; quarantined');guard(root,journal?.raw);
  return{status:'ok',...read,headToken:root,writable:journal===null,pending:journal?root===journal.next?'published-needs-finalize':'preparing':null};
 }
 function load(){try{return inspect();}catch(error){return{status:'refused',state:null,writable:false,reason:String(error)};}}
 function publish(state,{expectedHead}={}){
  if(busy)return{ok:false,status:'refused',reason:'store writer is busy'};busy=true;
  try{
   validateV3(state);const payload=JSON.stringify(state),size=utf8Bytes(payload);if(size>STORE_LIMITS.payloadBytes)fail('payload byte bound');
   const current=inspect();if(!current.writable||!['ok','absent'].includes(current.status))fail('pending journal requires recovery');if(expectedHead!==current.headToken)fail('stale expected authoritative head');
   if(current.status==='ok'&&JSON.stringify(current.state)===payload)return{ok:true,status:'unchanged',state:current.state,headToken:current.headToken};
   const old=current.status==='ok'?current.manifest:null;
   if(old&&(state.lineage!==old.lineage||old.revision===MAX||state.revision!==old.revision+1))fail('lineage/revision transition invalid');if(old?.sequence===MAX)fail('publication sequence exhausted');
   const bankIndex=old?1-old.bank:0,parts=splitUtf8(payload);if(parts.length>STORE_LIMITS.chunks)fail('payload chunk bound');
   // Preserve unknown/corrupt standby evidence, rather than destroying it for capacity.
   const standby=get(meta(bankIndex))??null;allowedPriorStandby(standby,old,bankIndex);if(standby!==null)bank(property(standby,'standby manifest'));else for(let i=0;i<STORE_LIMITS.chunks;i++)if(get(chunk(bankIndex,i))!==undefined)fail('orphan standby chunk; quarantined');
   const manifest={v:2,bank:bankIndex,sequence:(old?.sequence??0)+1,format:FORMAT,lineage:state.lineage,revision:state.revision,previousHeadHash:current.headToken===null?null:sha(current.headToken),payloadBytes:size,sha256:sha(payload),chunks:parts.map(p=>({bytes:utf8Bytes(p),sha256:sha(p)}))};
   const raw=JSON.stringify(manifest);parseManifest(raw);const journal=JSON.stringify({v:2,previous:current.headToken,next:raw,standby});const evidence=parseJournal(journal);
   guard(current.headToken,undefined);setChecked(journalKey,journal);
   for(let i=0;i<STORE_LIMITS.chunks;i++){guard(current.headToken,journal);stagingGuard(evidence);setChecked(chunk(bankIndex,i),parts[i]);}
   guard(current.headToken,journal);stagingGuard(evidence);setChecked(meta(bankIndex),raw);bank(raw);
   // Reverify the old authoritative payload and both ownership stamps immediately before publish.
   if(current.headToken!==null)bank(current.headToken);bank(raw);guard(current.headToken,journal);stagingGuard(evidence);
   setChecked(headKey,raw);bank(raw);guard(raw,journal);setChecked(journalKey,undefined);
   return{ok:true,status:'committed',state:JSON.parse(payload),headToken:raw,manifest};
  }catch(error){return{ok:false,status:'interrupted-or-refused',reason:String(error),requiresReload:true};}
  finally{busy=false;}
 }
 function recover(){
  if(busy)return{ok:false,status:'refused',reason:'store writer is busy'};busy=true;
  try{
   const journal=readJournal();if(!journal)return{ok:true,status:'nothing-pending',load:inspect()};const root=readRoot();
   if(root===journal.next){bank(root);guard(root,journal.raw);setChecked(journalKey,undefined);return{ok:true,status:'finalized-published',load:inspect()};}
   if(root!==journal.previous)fail('authority conflicts with recovery journal; quarantined');
   if(root!==null)bank(root);else absentDataExcept(journal.nextManifest.bank);
   stagingGuard(journal);
   for(let i=0;i<STORE_LIMITS.chunks;i++){guard(root,journal.raw);stagingGuard(journal);setChecked(chunk(journal.nextManifest.bank,i),undefined);}
   guard(root,journal.raw);stagingGuard(journal);setChecked(meta(journal.nextManifest.bank),undefined);guard(root,journal.raw);stagingGuard(journal);setChecked(journalKey,undefined);
   return{ok:true,status:'rolled-back-unpublished',load:inspect()};
  }catch(error){return{ok:false,status:'refused',reason:String(error),requiresReload:true};}
  finally{busy=false;}
 }
 return{load,publish,recover,keys:Object.freeze({head:headKey,journal:journalKey,all:Object.freeze(allKeys),meta,chunk})};
}
