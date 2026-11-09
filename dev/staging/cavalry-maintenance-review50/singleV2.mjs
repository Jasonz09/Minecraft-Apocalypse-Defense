// @ts-check
/** Injected prototype only. No entities, timers, implicit migration or casualty debit.
 * @typedef {{getDynamicProperty:(key:string)=>unknown,setDynamicProperty:(key:string,value:string)=>void,getDynamicPropertyIds:()=>string[],afterEvents?:any}} WorldPort
 * @typedef {{v:number,epoch:string,group:string,generation:number,phase:string,type:string,actor:string|null,terminal:string}} Binding
 * @typedef {{index:number,count:number,hash:string}} ChunkHead
 * @typedef {{group:string,type:string,index:number,oldChunkRaw:string|null,newChunkRaw:string,recordRaw:string}} Issue
 * @typedef {{v:number,epoch:string,mode:string,fixture:string,dimension:string,chunks:ChunkHead[],issued:number,pending:Issue|null}} Epoch
 * @typedef {{raw:string,value:Epoch,groups:Set<string>,chunks:Map<number,string>,records:Map<string,string>}} Snapshot
 * @typedef {{metaRaw:string,raw:string,group:string,epoch:string,generation:number,type:string,actor:string|null}} TicketContext
 */
export const FAMILY='civ:pop_bind:',PREFIX=FAMILY+'v2:',META=PREFIX+'meta',MAX_RECORDS=2048,MAX_BYTES=1024,CHUNK_GROUPS=64,MAX_CHUNKS=32,MAX_CHUNK_BYTES=4096,MAX_META_BYTES=8192;
export const CUSTOM_CREATION_ENTITY_TYPES=Object.freeze(['civ_trial:swordsman','civ_trial:archer']);
export const CREATION_ENTITY_TYPES=Object.freeze(['minecraft:villager_v2','minecraft:iron_golem',...CUSTOM_CREATION_ENTITY_TYPES]);
const TYPES=new Set(CREATION_ENTITY_TYPES);
const PHASES=new Set(['pending','alive','removing','retired','legacy','legacy-gone']);
/** @param {any} s */const ascii=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
/** @param {any} s */const group=s=>typeof s==='string'&&/^district-(?:[1-9]|[12]\d|3[0-2]):(?:civ|sol):(?:0|[1-9]\d{0,5})$/.test(s);
/** @param {any} s */const actor=s=>typeof s==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(s);
/** @param {any} v @param {string[]} keys */const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
/** @param {any} tags @param {string} g */const canonical=(tags,g)=>Array.isArray(tags)&&tags.length<=64&&tags.every((/** @type {any} */t)=>typeof t==='string'&&t.length<=256)&&tags.filter((/** @type {string} */t)=>t.startsWith('civpop:')).length===1&&tags.includes('civpop:v1:'+g);
/** @param {string} g */const key=g=>PREFIX+g;
/** @param {number} n */const chunkKey=n=>PREFIX+'index:'+n;
/** @param {Binding} r */export const birthTag=r=>`civbirth:v2:${r.epoch}:${r.group}:${r.generation}`;
/** Stable checksum for accidental/cross-version corruption; not adversarial authentication. @param {string} text */
function fingerprint(text){let n=2166136261;for(let i=0;i<text.length;i++){n^=text.charCodeAt(i);n=Math.imul(n,16777619);}return(n>>>0).toString(16).padStart(8,'0');}
/** @param {any} raw @param {number} cap @returns {any} */function json(raw,cap){if(typeof raw!=='string'||raw.length>cap||/[^\x00-\x7f]/.test(raw))throw Error('bounded ASCII metadata missing/corrupt');return JSON.parse(raw);}
/** @param {any} raw @param {Epoch} m @param {string} g @returns {Binding|null} */
function parseRecord(raw,m,g){if(raw===undefined)return null;const r=json(raw,MAX_BYTES);if(!exact(r,['v','epoch','group','generation','phase','type','actor','terminal'])||r.v!==2||r.epoch!==m.epoch||r.group!==g||!group(g)||!Number.isSafeInteger(r.generation)||r.generation<0||!PHASES.has(r.phase)||!TYPES.has(r.type)||!(r.actor===null||actor(r.actor))||!['none','death','owner-remove','tag-rollback','legacy-death'].includes(r.terminal))throw Error('binding record invalid/future/foreign');
 if(['alive','removing','retired','legacy','legacy-gone'].includes(r.phase)&&!actor(r.actor))throw Error('binding actor absent');
 if(['pending','alive','removing','retired'].includes(r.phase)&&r.generation<1)throw Error('issued generation invalid');
 if(['legacy','legacy-gone'].includes(r.phase)&&r.generation!==0)throw Error('legacy generation invalid');
 if(r.phase==='legacy-gone'&&r.terminal!=='legacy-death'||r.phase==='retired'&&!['death','owner-remove','tag-rollback'].includes(r.terminal)||['pending','alive','removing','legacy'].includes(r.phase)&&r.terminal!=='none')throw Error('terminal receipt inconsistent');return r;
}
/** @param {any} raw @returns {Epoch} */
function parseEpoch(raw){const m=json(raw,MAX_META_BYTES);if(!exact(m,['v','epoch','mode','fixture','dimension','chunks','issued','pending'])||m.v!==2||!ascii(m.epoch)||!ascii(m.fixture)||!['fresh','legacy'].includes(m.mode)||m.dimension!=='minecraft:overworld'||!Array.isArray(m.chunks)||m.chunks.length>MAX_CHUNKS||!Number.isSafeInteger(m.issued)||m.issued<0||m.issued>MAX_RECORDS)throw Error('binding epoch unsupported');let count=0;
 m.chunks.forEach((/** @type {any} */h,/** @type {number} */i)=>{if(!exact(h,['index','count','hash'])||h.index!==i||!Number.isSafeInteger(h.count)||h.count<1||h.count>CHUNK_GROUPS||typeof h.hash!=='string'||!/^[a-f0-9]{8}$/.test(h.hash))throw Error('issuance header invalid');count+=h.count;});if(count!==m.issued)throw Error('issuance count inconsistent');
 if(m.pending!==null){const p=m.pending;if(!exact(p,['group','type','index','oldChunkRaw','newChunkRaw','recordRaw'])||!group(p.group)||!TYPES.has(p.type)||!Number.isSafeInteger(p.index)||p.index<0||p.index>=MAX_CHUNKS||!(p.oldChunkRaw===null||typeof p.oldChunkRaw==='string')||typeof p.newChunkRaw!=='string'||typeof p.recordRaw!=='string')throw Error('issuance intent invalid');const r=parseRecord(p.recordRaw,m,p.group);if(!r||r.type!==p.type||!((r.phase==='pending'&&r.generation===1&&r.actor===null)||(r.phase==='legacy'&&r.generation===0)))throw Error('issuance intent record differs');}
 return m;
}
/** @param {any} raw @param {Epoch} m @param {number} index @returns {string[]} */
function parseChunk(raw,m,index){const c=json(raw,MAX_CHUNK_BYTES);if(!exact(c,['v','epoch','index','groups'])||c.v!==2||c.epoch!==m.epoch||c.index!==index||!Array.isArray(c.groups)||c.groups.length<1||c.groups.length>CHUNK_GROUPS||!c.groups.every(group)||new Set(c.groups).size!==c.groups.length||JSON.stringify(c.groups)!==JSON.stringify([...c.groups].sort()))throw Error('issuance chunk malformed/foreign');return c.groups;}
/** @param {WorldPort} world @param {{verifyFreshWorld?:()=>{verified:boolean,fixtureId:string,dimension:string,ownerHistory:string}}} [deps] */
export function createCreationBindings(world,deps={}){
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
  const newRaw=JSON.stringify({v:2,epoch:m.value.epoch,index,groups:[...members,record.group].sort()}),recordRaw=JSON.stringify(record);if(newRaw.length>MAX_CHUNK_BYTES||recordRaw.length>MAX_BYTES)throw Error('issuance size cap');
  const intent={group:record.group,type:record.type,index,oldChunkRaw:oldRaw,newChunkRaw:newRaw,recordRaw};putEpoch(m.raw,{...m.value,pending:intent});return finishIssue(snapshot(true));
 }
 /** @param {string} g @param {Snapshot} m */function read(g,m){if(!group(g))throw Error('invalid group');return{raw:m.records.get(g),value:parseRecord(m.records.get(g),m.value,g)};}
 /** @param {any} s @param {Binding} r @param {boolean} [tagged] */
 function identity(s,r,tagged=true){if(!s||s.groupId!==r.group||String(s.id)!==r.actor||s.typeId!==r.type||!canonical(s.tags,r.group))throw Error('binding actor identity differs');if(tagged&&(s.tags.filter((/** @type {string} */t)=>t.startsWith('civbirth:')).length!==1||!s.tags.includes(birthTag(r))))throw Error('birth generation differs');}
 /** @param {{mode:'fresh'|'legacy',epoch:string,fixture:string}} request */
 function initialize({mode,epoch,fixture}){return enter(()=>{if(!['fresh','legacy'].includes(mode)||!ascii(epoch)||!ascii(fixture))throw Error('explicit valid initialization required');const ids=world.getDynamicPropertyIds();if(!Array.isArray(ids)||ids.length>4096||ids.some(k=>k.startsWith(FAMILY)))throw Error('existing binding namespace preserved');if(mode==='fresh'){const proof=deps.verifyFreshWorld?.();if(proof?.verified!==true||proof.fixtureId!==fixture||proof.dimension!=='minecraft:overworld'||proof.ownerHistory!=='never-started')throw Error('verified fresh-world provenance required');}
  /** @type {Epoch} */const value={v:2,epoch,mode,fixture,dimension:'minecraft:overworld',chunks:[],issued:0,pending:null};const raw=JSON.stringify(value);if(world.getDynamicProperty(META)!==undefined)throw Error('epoch appeared');world.setDynamicProperty(META,raw);if(world.getDynamicProperty(META)!==raw)throw Error('epoch readback failed');return value;});}
 /** @param {string} g @param {string} type */
 function canBirth(g,type){return enter(()=>{const m=snapshot(),r=read(g,m).value;if(!TYPES.has(type)||r&&r.type!==type)throw Error('bound type changed');return r?{allowed:r.phase==='retired',reason:r.phase==='retired'?'positive terminal receipt':'existing '+r.phase+' binding; absence not death'}:{allowed:m.value.mode==='fresh',reason:m.value.mode==='fresh'?'not in exact issuance inventory':'legacy history unknown'};});}
 /** @param {string} g @param {string} type */
 function prepare(g,type){return enter(()=>{let m=snapshot(),old=read(g,m);if(!TYPES.has(type)||old.value&&old.value.type!==type)throw Error('bound type mismatch');if(old.value?.phase!=='retired'&&!(old.value===null&&m.value.mode==='fresh'))throw Error('birth not authorized');const generation=(old.value?.generation??0)+1;if(!Number.isSafeInteger(generation))throw Error('generation exhausted');
  /** @type {Binding} */const value={v:2,epoch:m.value.epoch,group:g,generation,phase:'pending',type,actor:null,terminal:'none'};let raw;if(!old.value){m=issue(m,value);raw=m.records.get(g);}else raw=write(m,g,/** @type {string} */(old.raw),value);if(typeof raw!=='string')throw Error('issued record absent');const ticket=Object.freeze({group:g,epoch:value.epoch,generation,tag:birthTag(value)});birthTickets.set(ticket,{metaRaw:m.raw,raw,group:g,epoch:value.epoch,generation,type,actor:null});return ticket;});}
 /** @param {object} ticket */
 function pending(ticket){const info=birthTickets.get(ticket);if(!info)throw Error('unissued/consumed birth ticket');const m=snapshot(),r=read(info.group,m);if(m.raw!==info.metaRaw||!r.value||r.raw!==info.raw||r.value.phase!=='pending'||r.value.epoch!==info.epoch||r.value.generation!==info.generation||r.value.type!==info.type)throw Error('pending birth raw/epoch/type changed');return{info,m,r:r.value,raw:/** @type {string} */(r.raw)};}
 /** @param {object} ticket @param {string} id */
 function recordSpawned(ticket,id){return enter(()=>{if(!actor(String(id)))throw Error('spawned ID unreadable');const p=pending(ticket);if(p.r.actor!==null&&p.r.actor!==String(id))throw Error('pending actor differs');const raw=write(p.m,p.r.group,p.raw,{...p.r,actor:String(id)});p.info.raw=raw;p.info.actor=String(id);return parseRecord(raw,p.m.value,p.r.group);});}
 /** @param {object} ticket @param {any} s */
 function confirmBorn(ticket,s){return enter(()=>{const p=pending(ticket);identity(s,p.r);birthTickets.delete(ticket);const raw=write(p.m,p.r.group,p.raw,{...p.r,phase:'alive'});return parseRecord(raw,p.m.value,p.r.group);});}
 /** @param {object} ticket @param {string} id */
 function rollbackRemoved(ticket,id){return enter(()=>{const p=pending(ticket);if(!actor(String(id))||p.r.actor!==null&&p.r.actor!==String(id))throw Error('rollback actor differs');birthTickets.delete(ticket);const raw=write(p.m,p.r.group,p.raw,{...p.r,actor:String(id),phase:'retired',terminal:'tag-rollback'});return parseRecord(raw,p.m.value,p.r.group);});}
 /** @param {any[]} rows */
 function observeLoaded(rows){return enter(()=>{if(!Array.isArray(rows)||rows.length>48)throw Error('observation cap');const seen=new Set();for(const s of rows){if(!group(s.groupId)||seen.has(s.groupId)||!actor(String(s.id))||!TYPES.has(s.typeId)||!canonical(s.tags,s.groupId))throw Error('ambiguous observation');seen.add(s.groupId);let m=snapshot();const r=read(s.groupId,m);if(!r.value){if(m.value.mode!=='legacy')throw Error('unissued actor in fresh epoch preserved');issue(m,{v:2,epoch:m.value.epoch,group:s.groupId,generation:0,phase:'legacy',type:s.typeId,actor:String(s.id),terminal:'none'});continue;}identity(s,r.value,!['legacy','legacy-gone'].includes(r.value.phase));if(['pending','removing'].includes(r.value.phase))write(m,s.groupId,/** @type {string} */(r.raw),{...r.value,phase:'alive'});else if(!['alive','legacy'].includes(r.value.phase))throw Error('terminal actor reappeared; preserved');}});}
 /** @param {any} s */
 function beginRemove(s){return enter(()=>{const m=snapshot(),r=read(s.groupId,m);if(!r.value||!['alive','removing'].includes(r.value.phase))throw Error('unverified legacy actor preserved');identity(s,r.value);const value={...r.value,phase:'removing'},raw=write(m,s.groupId,/** @type {string} */(r.raw),value),ticket=Object.freeze({...value});removalTickets.set(ticket,{metaRaw:m.raw,raw,group:value.group,epoch:value.epoch,generation:value.generation,type:value.type,actor:value.actor});return ticket;});}
 /** @param {object} ticket */
 function commitRemoved(ticket){return enter(()=>{const info=removalTickets.get(ticket);removalTickets.delete(ticket);if(!info)throw Error('unissued/consumed removal ticket');const m=snapshot(),r=read(info.group,m);if(m.raw!==info.metaRaw||!r.value||r.raw!==info.raw||r.value.epoch!==info.epoch||r.value.type!==info.type||r.value.actor!==info.actor||r.value.generation!==info.generation||r.value.phase!=='removing')throw Error('removal ticket raw/epoch/type differs');const raw=write(m,info.group,/** @type {string} */(r.raw),{...r.value,phase:'retired',terminal:'owner-remove'});return parseRecord(raw,m.value,info.group);});}
 /** @param {any} s */
 function confirmDeath(s){return enter(()=>{const m=snapshot(),r=read(s.groupId,m);if(!r.value)return false;if(['retired','legacy-gone'].includes(r.value.phase)){if(r.value.actor===String(s.id))return false;throw Error('stale death');}identity(s,r.value,r.value.phase!=='legacy');const raw=write(m,s.groupId,/** @type {string} */(r.raw),{...r.value,phase:r.value.phase==='legacy'?'legacy-gone':'retired',terminal:r.value.phase==='legacy'?'legacy-death':'death'});return parseRecord(raw,m.value,s.groupId);});}
 /** @param {any} s */function assertOwned(s){return enter(()=>{const m=snapshot(),r=read(s.groupId,m);if(!r.value||!['alive','removing'].includes(r.value.phase))throw Error('owned binding unavailable');identity(s,r.value);return true;});}
 /** @param {string} g */const inspect=g=>enter(()=>{const m=snapshot();return read(g,m).value;});
 const recoverIssuance=()=>enter(()=>finishIssue(snapshot(true)).value.pending===null);
 return{initialize,recoverIssuance,canBirth,prepare,recordSpawned,confirmBorn,rollbackRemoved,observeLoaded,beginRemove,commitRemoved,confirmDeath,assertOwned,inspect};
}
/** @type {WeakMap<object,object>} */const deathRegistrations=new WeakMap();
/** @param {WorldPort} world @param {ReturnType<typeof createCreationBindings>} store */
export function registerCreationDeaths(world,store){if(deathRegistrations.has(world)){if(deathRegistrations.get(world)!==store)throw Error('different death authority registered');return false;}world.afterEvents.entityDie.subscribe((/** @type {any} */event)=>{try{const h=event.deadEntity,tags=h.getTags(),claims=tags.filter((/** @type {string} */t)=>t.startsWith('civpop:v1:'));if(claims.length!==1)return;store.confirmDeath({groupId:claims[0].slice('civpop:v1:'.length),id:String(h.id),typeId:h.typeId,tags:[...tags]});}catch(_error){/* Hold; no loaded-absence fallback. */}},{entityTypes:[...CREATION_ENTITY_TYPES]});deathRegistrations.set(world,store);return true;}
