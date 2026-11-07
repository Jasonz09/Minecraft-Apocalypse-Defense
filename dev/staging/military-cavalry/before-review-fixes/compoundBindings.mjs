// @ts-check
/** Compound record experiment only. No entities, timers, implicit migration or casualty debit.
 * @typedef {{getDynamicProperty:(key:string)=>unknown,setDynamicProperty:(key:string,value:string)=>void,getDynamicPropertyIds:()=>string[],afterEvents?:any}} WorldPort
 * @typedef {{phase:string,type:string,actor:string|null,terminal:string}} Member
 * @typedef {{v:number,epoch:string,group:string,generation:number,rider:Member,mount:Member}} Binding
 * @typedef {{index:number,count:number,hash:string}} ChunkHead
 * @typedef {{group:string,type:string,index:number,oldChunkRaw:string|null,newChunkRaw:string,recordRaw:string}} Issue
 * @typedef {{v:number,epoch:string,mode:string,fixture:string,dimension:string,chunks:ChunkHead[],issued:number,pending:Issue|null}} Epoch
 * @typedef {{raw:string,value:Epoch,groups:Set<string>,chunks:Map<number,string>,records:Map<string,string>}} Snapshot
 * @typedef {{metaRaw:string,raw:string,group:string,epoch:string,generation:number,type:string,actor:string|null}} TicketContext
 */
export const FAMILY='civ:pop_bind:',PREFIX=FAMILY+'v3:',META=PREFIX+'meta',MAX_RECORDS=2048,MAX_BYTES=1536,CHUNK_GROUPS=64,MAX_CHUNKS=32,MAX_CHUNK_BYTES=4096,MAX_META_BYTES=8192;
export const ROLE_TYPES=Object.freeze({rider:'civ_trial:cavalry',mount:'civ_trial:cavalry_mount'});
const TYPES=new Set(Object.values(ROLE_TYPES));
const ROLES=/** @type {const} */(['rider','mount']);
const PHASES=new Set(['never','pending','alive','removing','terminal','cancelled']);
/** @param {any} s */const ascii=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
/** @param {any} s */const group=s=>typeof s==='string'&&/^district-(?:[1-9]|[12]\d|3[0-2]):(?:civ|sol):(?:0|[1-9]\d{0,5})$/.test(s);
/** @param {any} s */const actor=s=>typeof s==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(s);
/** @param {any} v @param {string[]} keys */const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
/** @param {any} tags @param {string} g */const canonical=(tags,g)=>Array.isArray(tags)&&tags.length<=64&&tags.every((/** @type {any} */t)=>typeof t==='string'&&t.length<=256)&&tags.filter((/** @type {string} */t)=>t.startsWith('civpop:')).length===1&&tags.includes('civpop:v1:'+g);
/** @param {string} g */const key=g=>PREFIX+g;
/** @param {number} n */const chunkKey=n=>PREFIX+'index:'+n;
/** @param {Binding} r @param {'rider'|'mount'} role */export const birthTag=(r,role)=>`civcavalry:v1:${r.epoch}:${r.group}:${r.generation}:${role}`;
/** Stable checksum for accidental/cross-version corruption; not adversarial authentication. @param {string} text */
function fingerprint(text){let n=2166136261;for(let i=0;i<text.length;i++){n^=text.charCodeAt(i);n=Math.imul(n,16777619);}return(n>>>0).toString(16).padStart(8,'0');}
/** @param {any} raw @param {number} cap @returns {any} */function json(raw,cap){if(typeof raw!=='string'||raw.length>cap||/[^\x00-\x7f]/.test(raw))throw Error('bounded ASCII metadata missing/corrupt');return JSON.parse(raw);}
/** @param {any} raw @param {Epoch} m @param {string} g @returns {Binding|null} */
function parseRecord(raw,m,g){if(raw===undefined)return null;const r=json(raw,MAX_BYTES);
 if(!exact(r,['v','epoch','group','generation','rider','mount'])||r.v!==3||r.epoch!==m.epoch||r.group!==g||!group(g)||!g.includes(':sol:')||!Number.isSafeInteger(r.generation)||r.generation<1)throw Error('compound binding malformed/foreign/future');
 for(const role of ROLES){const a=r[role];if(!exact(a,['phase','type','actor','terminal'])||!PHASES.has(a.phase)||a.type!==ROLE_TYPES[role]||!(a.actor===null||actor(a.actor)))throw Error('compound role identity invalid');
  if(a.phase==='never'&&(a.actor!==null||a.terminal!=='none'))throw Error('never role has history');
  if(a.phase==='cancelled'&&(a.actor!==null||a.terminal!=='never-created'))throw Error('cancelled role is not proven never-created');
  if(a.phase==='pending'&&a.terminal!=='none')throw Error('pending terminal invalid');
  if(['alive','removing','terminal'].includes(a.phase)&&!actor(a.actor))throw Error('compound role actor absent');
  if(a.phase==='terminal'?!['death','owner-remove','tag-rollback'].includes(a.terminal):a.phase!=='cancelled'&&a.terminal!=='none')throw Error('compound terminal inconsistent');
 }
 if(r.rider.actor!==null&&r.rider.actor===r.mount.actor)throw Error('one actor cannot fill both roles');return r;
}
/** @param {any} raw @returns {Epoch} */
function parseEpoch(raw){const m=json(raw,MAX_META_BYTES);if(!exact(m,['v','epoch','mode','fixture','dimension','chunks','issued','pending'])||m.v!==3||!ascii(m.epoch)||!ascii(m.fixture)||m.mode!=='fresh'||m.dimension!=='minecraft:overworld'||!Array.isArray(m.chunks)||m.chunks.length>MAX_CHUNKS||!Number.isSafeInteger(m.issued)||m.issued<0||m.issued>MAX_RECORDS)throw Error('binding epoch unsupported');let count=0;
 m.chunks.forEach((/** @type {any} */h,/** @type {number} */i)=>{if(!exact(h,['index','count','hash'])||h.index!==i||!Number.isSafeInteger(h.count)||h.count<1||h.count>CHUNK_GROUPS||typeof h.hash!=='string'||!/^[a-f0-9]{8}$/.test(h.hash))throw Error('issuance header invalid');count+=h.count;});if(count!==m.issued)throw Error('issuance count inconsistent');
 if(m.pending!==null){const p=m.pending;if(!exact(p,['group','type','index','oldChunkRaw','newChunkRaw','recordRaw'])||!group(p.group)||!TYPES.has(p.type)||!Number.isSafeInteger(p.index)||p.index<0||p.index>=MAX_CHUNKS||!(p.oldChunkRaw===null||typeof p.oldChunkRaw==='string')||typeof p.newChunkRaw!=='string'||typeof p.recordRaw!=='string')throw Error('issuance intent invalid');const r=parseRecord(p.recordRaw,m,p.group);if(!r||p.type!==ROLE_TYPES.rider||r.generation!==1||ROLES.some(role=>r[role].phase!=='never'||r[role].actor!==null))throw Error('issuance intent record differs');}
 return m;
}
/** @param {any} raw @param {Epoch} m @param {number} index @returns {string[]} */
function parseChunk(raw,m,index){const c=json(raw,MAX_CHUNK_BYTES);if(!exact(c,['v','epoch','index','groups'])||c.v!==3||c.epoch!==m.epoch||c.index!==index||!Array.isArray(c.groups)||c.groups.length<1||c.groups.length>CHUNK_GROUPS||!c.groups.every(group)||new Set(c.groups).size!==c.groups.length||JSON.stringify(c.groups)!==JSON.stringify([...c.groups].sort()))throw Error('issuance chunk malformed/foreign');return c.groups;}
/** @param {WorldPort} world @param {{verifyFreshWorld?:()=>{verified:boolean,fixtureId:string,dimension:string,ownerHistory:string}}} [deps] */
export function createCompoundBindings(world,deps={}){
 let busy=false;
 /** @type {WeakMap<object,TicketContext>} */const birthTickets=new WeakMap(),removalTickets=new WeakMap();
 /** @template T @param {()=>T} fn @returns {T} */function enter(fn){if(busy)throw Error('binding operation reentered');busy=true;try{return fn();}finally{busy=false;}}
 /** @param {boolean} [pendingAllowed] @returns {Snapshot} */
 function snapshot(pendingAllowed=false){
  const raw=world.getDynamicProperty(META);if(typeof raw!=='string')throw Error('binding epoch absent/corrupt');const m=parseEpoch(raw),ids=world.getDynamicPropertyIds();if(!Array.isArray(ids)||ids.length>4096||ids.some(k=>typeof k!=='string'||k.startsWith(FAMILY)&&!k.startsWith(PREFIX)))throw Error('unknown/future binding namespace');
  if(m.pending&&!pendingAllowed)throw Error('interrupted issuance needs metadata recovery');
  /** @type {Set<string>} */const groups=new Set();
  /** @type {Map<number,string>} */const chunks=new Map();
  /** @type {Map<string,string>} */const records=new Map();
  const allowed=new Set([META]);
  for(const h of m.chunks){const actual=world.getDynamicProperty(chunkKey(h.index));let indexed=actual;
   if(m.pending?.index===h.index){if(actual!==m.pending.oldChunkRaw&&actual!==m.pending.newChunkRaw)throw Error('issuance standby changed; preserved');indexed=m.pending.oldChunkRaw;}
   if(typeof indexed!=='string'||fingerprint(indexed)!==h.hash)throw Error('committed issuance chunk missing/changed');const members=parseChunk(indexed,m,h.index);if(members.length!==h.count)throw Error('chunk count differs');chunks.set(h.index,indexed);allowed.add(chunkKey(h.index));for(const g of members){if(groups.has(g))throw Error('duplicate issuance group');groups.add(g);allowed.add(key(g));}
  }
  if(groups.size!==m.issued)throw Error('exact issuance set differs');
  if(m.pending){const p=m.pending;if(groups.has(p.group))throw Error('issuance intent reused group');const old=p.index<m.chunks.length?chunks.get(p.index):null;
   if(p.index!==m.chunks.length-1&&p.index!==m.chunks.length||old!==p.oldChunkRaw)throw Error('issuance intent prior chunk differs');const prior=old===null?[]:parseChunk(old,m,p.index),next=parseChunk(p.newChunkRaw,m,p.index);if(prior.length>=CHUNK_GROUPS||JSON.stringify(next)!==JSON.stringify([...prior,p.group].sort()))throw Error('issuance intent membership differs');
   if(p.index===m.chunks.length){const rawNew=world.getDynamicProperty(chunkKey(p.index));if(rawNew!==undefined&&rawNew!==p.newChunkRaw)throw Error('unknown new index chunk; preserved');if(rawNew!==undefined)allowed.add(chunkKey(p.index));}
   const provisional=world.getDynamicProperty(key(p.group));if(provisional!==undefined){if(provisional!==p.recordRaw)throw Error('unexpected issuance record; preserved');allowed.add(key(p.group));}
  }
  const owned=ids.filter(k=>k.startsWith(FAMILY));if(owned.length!==allowed.size||owned.some(k=>!allowed.has(k)))throw Error('binding inventory keyset missing/substituted/unknown');
  for(const g of groups){const r=world.getDynamicProperty(key(g));if(typeof r!=='string'||!parseRecord(r,m,g))throw Error('issued binding missing; preserved');records.set(g,r);}
  if(world.getDynamicProperty(META)!==raw)throw Error('epoch changed during census');return{raw,value:m,groups,chunks,records};
 }
 /** @param {string} expected @param {Epoch} next */
 function putEpoch(expected,next){const raw=JSON.stringify(next);if(raw.length>MAX_META_BYTES)throw Error('epoch byte cap');if(world.getDynamicProperty(META)!==expected)throw Error('epoch changed before publication');world.setDynamicProperty(META,raw);if(world.getDynamicProperty(META)!==raw)throw Error('epoch readback failed');return raw;}
 /** @param {Snapshot} m @param {string} g @param {string} expected @param {Binding} next */
 function write(m,g,expected,next){const fresh=snapshot();if(fresh.raw!==m.raw||fresh.records.get(g)!==expected)throw Error('binding raw/epoch changed before write');const raw=JSON.stringify(next);if(raw.length>MAX_BYTES)throw Error('binding record cap');world.setDynamicProperty(key(g),raw);if(world.getDynamicProperty(key(g))!==raw||world.getDynamicProperty(META)!==m.raw)throw Error('binding write/readback failed');return raw;}
 /** Complete metadata only. Missing provision is UNKNOWNpending, NEVER spawn permission. @param {Snapshot} m */
 function finishIssue(m){const p=m.value.pending;if(!p)return m;const fresh=snapshot(true);if(fresh.raw!==m.raw)throw Error('issuance changed before recovery');
  const at=chunkKey(p.index),actual=world.getDynamicProperty(at);if(actual!==p.newChunkRaw){if(actual!==p.oldChunkRaw&&!(p.oldChunkRaw===null&&actual===undefined))throw Error('standby not owned; preserve');world.setDynamicProperty(at,p.newChunkRaw);if(world.getDynamicProperty(at)!==p.newChunkRaw)throw Error('index readback failed');}
  const existing=world.getDynamicProperty(key(p.group));if(existing===undefined){world.setDynamicProperty(key(p.group),p.recordRaw);if(world.getDynamicProperty(key(p.group))!==p.recordRaw)throw Error('pending record readback failed');}else if(existing!==p.recordRaw)throw Error('issuance record changed; preserved');
  const chunks=m.value.chunks.map(h=>({...h})),head={index:p.index,count:parseChunk(p.newChunkRaw,m.value,p.index).length,hash:fingerprint(p.newChunkRaw)};chunks[p.index]=head;
  putEpoch(m.raw,{...m.value,chunks,issued:m.value.issued+1,pending:null});return snapshot();
 }
 /** @param {Snapshot} m @param {Binding} record */
 function issue(m,record){if(m.groups.has(record.group)||m.value.issued>=MAX_RECORDS)throw Error('issued/capacity group held');let index=m.value.chunks.length-1,oldRaw=index<0?null:m.chunks.get(index)??null;let members=oldRaw===null?[]:parseChunk(oldRaw,m.value,index);if(members.length===CHUNK_GROUPS){index++;oldRaw=null;members=[];}if(index<0)index=0;if(index>=MAX_CHUNKS)throw Error('issuance capacity');
  const newRaw=JSON.stringify({v:3,epoch:m.value.epoch,index,groups:[...members,record.group].sort()}),recordRaw=JSON.stringify(record);if(newRaw.length>MAX_CHUNK_BYTES||recordRaw.length>MAX_BYTES)throw Error('issuance size cap');
  const intent={group:record.group,type:ROLE_TYPES.rider,index,oldChunkRaw:oldRaw,newChunkRaw:newRaw,recordRaw};putEpoch(m.raw,{...m.value,pending:intent});return finishIssue(snapshot(true));
 }
 /** @param {string} g @param {Snapshot} m */function read(g,m){if(!group(g))throw Error('invalid group');return{raw:m.records.get(g),value:parseRecord(m.records.get(g),m.value,g)};}
 /** @param {unknown} role @returns {'rider'|'mount'} */function roleOf(role){if(role!=='rider'&&role!=='mount')throw Error('unknown compound role');return role;}
 /** @param {Binding} r @param {'rider'|'mount'} role @param {any} live */
 function identity(r,role,live){const a=r[role];if(!live||live.groupId!==r.group||live.role!==role||live.id!==a.actor||live.typeId!==a.type||!Array.isArray(live.tags)||live.tags.length>64||live.tags.some((/** @type {any} */t)=>typeof t!=='string'||t.length>256))throw Error('compound native role identity differs');
  const own=live.tags.filter((/** @type {string} */t)=>t.startsWith('civpop:'));if(role==='rider'?(own.length!==1||own[0]!=='civpop:v1:'+r.group):own.length!==0)throw Error('compound canonical role differs');
  if(live.tags.filter((/** @type {string} */t)=>t.startsWith('civcavalry:')).length!==1||!live.tags.includes(birthTag(r,role)))throw Error('compound birth generation differs');
 }
 /** @param {string} epoch @param {string} fixture */function initialize(epoch,fixture){return enter(()=>{if(!ascii(epoch)||!ascii(fixture))throw Error('explicit valid fresh identity required');const ids=world.getDynamicPropertyIds();if(!Array.isArray(ids)||ids.length>4096||ids.some(k=>k.startsWith(FAMILY)))throw Error('existing single/compound namespace preserved; explicit migration required');
 const proof=deps.verifyFreshWorld?.();if(proof?.verified!==true||proof.fixtureId!==fixture||proof.dimension!=='minecraft:overworld'||proof.ownerHistory!=='never-started')throw Error('private fresh provenance required');
 /** @type {Epoch} */const m={v:3,epoch,mode:'fresh',fixture,dimension:'minecraft:overworld',chunks:[],issued:0,pending:null};const raw=JSON.stringify(m);if(world.getDynamicProperty(META)!==undefined)throw Error('compound epoch appeared');world.setDynamicProperty(META,raw);if(world.getDynamicProperty(META)!==raw)throw Error('compound epoch readback failed');return m;});}
 /** @param {string} g */function reservePair(g){return enter(()=>{let m=snapshot();const prior=read(g,m);if(!group(g)||!g.includes(':sol:')||prior.value&&!ROLES.every(role=>['terminal','cancelled'].includes(prior.value?.[role].phase??'')))throw Error('compound pair already issued or surviving; no absence replacement');
 const generation=(prior.value?.generation??0)+1;if(!Number.isSafeInteger(generation))throw Error('compound generation exhausted');
 /** @type {Binding} */const r={v:3,epoch:m.value.epoch,group:g,generation,rider:{phase:'never',type:ROLE_TYPES.rider,actor:null,terminal:'none'},mount:{phase:'never',type:ROLE_TYPES.mount,actor:null,terminal:'none'}};
 if(prior.value)write(m,g,/** @type {string} */(prior.raw),r);else issue(m,r);return r;});}
 /** @param {string} g @param {'rider'|'mount'} role */function prepareRole(g,role){return enter(()=>{role=roleOf(role);const m=snapshot(),r=read(g,m);if(!r.value||r.value[role].phase!=='never'||ROLES.some(k=>['pending','terminal','cancelled'].includes(r.value?.[k].phase??'')))throw Error('compound role issued/pending; preserve');
 const next={...r.value,[role]:{...r.value[role],phase:'pending'}},raw=write(m,g,/** @type {string} */(r.raw),next),ticket=Object.freeze({group:g,role,tag:birthTag(next,role)});
 birthTickets.set(ticket,{metaRaw:m.raw,raw,group:g,epoch:next.epoch,generation:next.generation,type:next[role].type,actor:null});return ticket;});}
 /** Exact never-created metadata permits explicit owner cancellation, not a death receipt.
  * Pending/known issued roles are never cancellable from absence.
  * @param {string} g @param {'rider'|'mount'} role */function cancelNeverCreated(g,role){return enter(()=>{role=roleOf(role);const m=snapshot(),r=read(g,m);if(!r.value||r.value[role].phase!=='never')throw Error('issued/unknown role cannot be cancelled as never-created');const next={...r.value,[role]:{...r.value[role],phase:'cancelled',terminal:'never-created'}};write(m,g,/** @type {string} */(r.raw),next);return next;});}
 /** @param {any} ticket */function pending(ticket){const info=birthTickets.get(ticket);if(!info)throw Error('unknown/consumed compound birth ticket');const role=roleOf(ticket.role),m=snapshot(),r=read(info.group,m);if(m.raw!==info.metaRaw||r.raw!==info.raw||!r.value||r.value.epoch!==info.epoch||r.value.generation!==info.generation||r.value[role].phase!=='pending'||r.value[role].type!==info.type)throw Error('compound pending raw/epoch/type differs');return{info,role,m,r:r.value,raw:/** @type {string} */(r.raw)};}
 /** @param {any} ticket @param {string} id */function recordSpawned(ticket,id){return enter(()=>{const p=pending(ticket);if(!actor(id)||p.r[p.role].actor!==null||ROLES.some(k=>p.r[k].actor===id))throw Error('compound spawned ID invalid/reused');const next={...p.r,[p.role]:{...p.r[p.role],actor:id}},raw=write(p.m,p.r.group,p.raw,next);p.info.raw=raw;p.info.actor=id;return next;});}
 /** @param {any} ticket @param {any} live */function confirmBorn(ticket,live){return enter(()=>{const p=pending(ticket);identity(p.r,p.role,live);birthTickets.delete(ticket);const next={...p.r,[p.role]:{...p.r[p.role],phase:'alive'}};write(p.m,p.r.group,p.raw,next);return next;});}
 /** Called ONLY after sole owner positively removed its exact newborn. @param {any} ticket @param {string} id */function rollbackRemoved(ticket,id){return enter(()=>{const p=pending(ticket);if(!actor(id)||p.r[p.role].actor!==null&&p.r[p.role].actor!==id)throw Error('compound rollback differs');birthTickets.delete(ticket);const next={...p.r,[p.role]:{...p.r[p.role],actor:id,phase:'terminal',terminal:'tag-rollback'}};write(p.m,p.r.group,p.raw,next);return next;});}
 /** Readonly assertion; native identity must be rechecked after these metadata getters by owner. @param {any} live */function assertOwned(live){return enter(()=>{const role=roleOf(live.role),m=snapshot(),r=read(live.groupId,m);if(!r.value||!['alive','removing'].includes(r.value[role].phase))throw Error('compound owned role unavailable');identity(r.value,role,live);return true;});}
 /** @param {any} live */function beginRemove(live){return enter(()=>{const role=roleOf(live.role),m=snapshot(),r=read(live.groupId,m);if(!r.value||!['alive','removing'].includes(r.value[role].phase))throw Error('compound removal unavailable');identity(r.value,role,live);const next={...r.value,[role]:{...r.value[role],phase:'removing'}},raw=write(m,r.value.group,/** @type {string} */(r.raw),next),ticket=Object.freeze({group:next.group,role});removalTickets.set(ticket,{metaRaw:m.raw,raw,group:next.group,epoch:next.epoch,generation:next.generation,type:next[role].type,actor:next[role].actor});return ticket;});}
 /** Called ONLY after exact successful native owner removal, never isValid=false/unload alone. @param {any} ticket */function commitRemoved(ticket){return enter(()=>{const info=removalTickets.get(ticket);removalTickets.delete(ticket);if(!info)throw Error('unknown/consumed compound removal ticket');const role=roleOf(ticket.role),m=snapshot(),r=read(info.group,m);if(m.raw!==info.metaRaw||r.raw!==info.raw||!r.value||r.value.epoch!==info.epoch||r.value.generation!==info.generation||r.value[role].phase!=='removing'||r.value[role].actor!==info.actor||r.value[role].type!==info.type)throw Error('stale compound removal authority');const next={...r.value,[role]:{...r.value[role],phase:'terminal',terminal:'owner-remove'}};write(m,info.group,/** @type {string} */(r.raw),next);return next;});}
 /** Fresh exact entityDie identity only; returns physical role receipt, never aggregate debit. @param {any} live */function confirmDeath(live){return enter(()=>{const role=roleOf(live.role),m=snapshot(),r=read(live.groupId,m);if(!r.value)return false;identity(r.value,role,live);if(r.value[role].phase==='terminal')return false;if(!['alive','pending','removing'].includes(r.value[role].phase))throw Error('unissued compound death');const next={...r.value,[role]:{...r.value[role],phase:'terminal',terminal:'death'}};write(m,r.value.group,/** @type {string} */(r.raw),next);return{record:next,role,humanCasualtyDebit:0};});}
 /** @param {any[]} rows */function observeLoaded(rows){return enter(()=>{if(!Array.isArray(rows)||rows.length>48)throw Error('compound observation cap');const seen=new Set();for(const live of rows){const role=roleOf(live.role),id=live.groupId+':'+role;if(seen.has(id))throw Error('compound duplicate role');seen.add(id);const m=snapshot(),r=read(live.groupId,m);if(!r.value)throw Error('unissued compound actor preserved');identity(r.value,role,live);if(['pending','removing'].includes(r.value[role].phase))write(m,r.value.group,/** @type {string} */(r.raw),{...r.value,[role]:{...r.value[role],phase:'alive'}});else if(r.value[role].phase!=='alive')throw Error('compound terminal actor reappeared; preserved');}});}
 /** @param {string} g */function inspect(g){return enter(()=>read(g,snapshot()).value);}
 const recoverIssuance=()=>enter(()=>finishIssue(snapshot(true)).value.pending===null);
 return{initialize,reservePair,prepareRole,cancelNeverCreated,recordSpawned,confirmBorn,rollbackRemoved,assertOwned,beginRemove,commitRemoved,confirmDeath,observeLoaded,inspect,recoverIssuance};
}
