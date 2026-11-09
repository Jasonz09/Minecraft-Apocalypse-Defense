// @ts-check
import {createPlanStore,utf8Length} from "./planstore.js";
import {createJobStore} from "./jobs.js";
export const REALM_CLAIM_FAMILY="civ:realm_claims:",REALM_CLAIM_KEY=REALM_CLAIM_FAMILY+"v1",REALM_SOURCE_FAMILY="civ:realm:";
const BUILDER_CONTEXTS=new WeakMap();
const FOREIGN_METADATA=new WeakSet();
/** Object-identity brand prevents accidental forwarding to terrain writers.
 * @param {any} value */
export function markRealmMetadata(value){if(value&&typeof value==='object')FOREIGN_METADATA.add(value);return value;}
/** @param {any} value */
export const isRealmMetadata=value=>!!value&&typeof value==='object'&&FOREIGN_METADATA.has(value);
/** Internal metadata-only context, never a command-supplied namespace/boolean.
 * @param {any} context @param {any} world @param {number} district */
export function resolveRealmBuilderContext(context,world,district){const entry=BUILDER_CONTEXTS.get(context);if(!entry||entry.world!==world)throw Error('unissued/cross-world realm builder context');entry.check();const selected=entry.select(district);entry.check();return{keys:selected.keys,planStore:selected.master,siteStore:selected.site,jobStore:selected.jobs,current:entry.check,readFence:entry.readFence,terrainAuthorized:false};}
export const FOREIGN_REALMS=Object.freeze(["realm-1","realm-2","realm-3"]);
const DIM="minecraft:overworld",MAX_IDS=4096,MAX_RAW_BYTES=2*1024*1024,MAX_CLAIM_BYTES=4096,MAX_AREAS=32;
/** @param {unknown} value @returns {asserts value is string} */
function realm(value){if(value!=="player"&&!FOREIGN_REALMS.includes(/** @type {string} */(value)))throw Error("unknown realm scope; preserved");}
/** Player keys are byte-compatible; district1 retains the original unnumbered queue.
 * @param {string} id @param {number} district */
export function realmSourceKeys(id,district){realm(id);if(!Number.isInteger(district)||district<1||district>5)throw Error("district scope must be1..5");const root=id==="player"?"civ":REALM_SOURCE_FAMILY+id;return Object.freeze({master:root+":plan",site:root+":plan:site:d"+district,jobs:root+":jobs"+(district===1?"":":d"+district),repair:root+":jobs:repair:d"+district});}
/** @param {any} r */
function rect(r){return r&&typeof r==="object"&&[r.x0,r.z0,r.x1,r.z1].every(v=>Number.isSafeInteger(v)&&Math.abs(v)<=29000000)&&r.x0<=r.x1&&r.z0<=r.z1&&r.x1-r.x0<=2048&&r.z1-r.z0<=2048;}
/** @param {any} a */
function cloneArea(a){return{...a,...(Array.isArray(a.polygon)?{polygon:a.polygon.map((/** @type {any[]} */ p)=>[...p])}:{})};}
/** @param {any} a @param {any} b */
const overlaps=(a,b)=>a.x0<=b.x1&&a.x1>=b.x0&&a.z0<=b.z1&&a.z1>=b.z0;
/** @param {any} r */
const bounds=r=>({x0:r.x0,z0:r.z0,x1:r.x1,z1:r.z1});
/** @param {any} a @param {string[]} keys */
const exact=(a,keys)=>a&&typeof a==="object"&&!Array.isArray(a)&&JSON.stringify(Object.keys(a).sort())===JSON.stringify([...keys].sort());
/** @param {any} world */
function ids(world){const list=world.getDynamicPropertyIds();if(!Array.isArray(list)||list.length>MAX_IDS||new Set(list).size!==list.length||list.some(k=>typeof k!=="string"||!k||k.length>256))throw Error("source property census unreadable");return [...list].sort();}
/** @param {string} key */
function sourceRealm(key){if(!key.startsWith(REALM_SOURCE_FAMILY))return null;const id=key.slice(REALM_SOURCE_FAMILY.length).split(":")[0];if(!FOREIGN_REALMS.includes(id)||!key.startsWith(REALM_SOURCE_FAMILY+id+":"))throw Error("unknown foreign source namespace; preserved");return id;}
/** @param {string} key */
const playerSource=key=>key==="civ:kingdom"||key==="civ_gatereg"||key.startsWith("civ_gate_")||key==="civ:plan"||key.startsWith("civ:plan:")||key==="civ:jobs"||key.startsWith("civ:jobs:");
/** Exact raw source comparison, no hashes/native getters/block queries. Own metadata keys may evolve.
 * @param {any} world @param {string|null} [own] */
function sourceFence(world,own=null){
 function capture(){const keys=ids(world).filter(k=>playerSource(k)||(sourceRealm(k)!==null&&sourceRealm(k)!==own));let bytes=0;return keys.map(key=>{const value=world.getDynamicProperty(key);if(!["string","boolean","number"].includes(typeof value)||typeof value==="number"&&!Number.isFinite(value))throw Error("source raw property unreadable");bytes+=typeof value==="string"?utf8Length(value):8;if(bytes>MAX_RAW_BYTES)throw Error("source raw bound");return[key,value];});}
 const baseline=JSON.stringify(capture());return()=>{if(JSON.stringify(capture())!==baseline)throw Error("realm source changed; preserve all metadata");};
}
/** @param {any} world */
function registrySnapshot(world){const keys=ids(world),family=keys.filter(k=>k.startsWith(REALM_CLAIM_FAMILY));if(family.some(k=>k!==REALM_CLAIM_KEY))throw Error("unknown/future realm registry; preserved");const raw=world.getDynamicProperty(REALM_CLAIM_KEY);if((raw===undefined)!==!keys.includes(REALM_CLAIM_KEY))throw Error("realm registry census changed");let value={v:1,claims:/** @type {any[]} */([])};
 if(raw!==undefined){if(typeof raw!=="string"||utf8Length(raw)>MAX_CLAIM_BYTES)throw Error("realm registry raw unreadable");value=JSON.parse(raw);if(!exact(value,["v","claims"])||value.v!==1||!Array.isArray(value.claims)||value.claims.length>3)throw Error("realm registry unsupported");let last="";for(const c of value.claims){if(!exact(c,["realm","dimension","bounds"])||!FOREIGN_REALMS.includes(c.realm)||c.realm<=last||c.dimension!==DIM||!exact(c.bounds,["x0","z0","x1","z1"])||!rect(c.bounds))throw Error("realm claim invalid");last=c.realm;}for(let i=0;i<value.claims.length;i++)for(let j=i+1;j<value.claims.length;j++)if(overlaps(value.claims[i].bounds,value.claims[j].bounds))throw Error("realm claims overlap; preserved");}
 for(const key of keys){const id=sourceRealm(key);if(id&&!value.claims.some(c=>c.realm===id))throw Error("foreign source has no durable claim; preserved");}
 if(world.getDynamicProperty(REALM_CLAIM_KEY)!==raw)throw Error("realm registry changed during read");return{raw,value};
}
/** Metadata reservations ONLY, never surveyed land or terrain/actor authority.
 * Privileged capturePlayerProtection must validate ALL saved player sources and return
 * complete32-or-fewer areas, under this exact raw fence. No default or command bool.
 * @param {any} world @param {{capturePlayerProtection?:()=>{complete:true,areas:any[]}}} [deps] */
export function createRealmClaimRegistry(world,deps={}){
 /** @param {string|null} [own] */
 function capture(own=null){const current=sourceFence(world,own),snapshot=registrySnapshot(world);if(typeof deps.capturePlayerProtection!=="function")throw Error("verified full player source protection adapter is required");const projection=deps.capturePlayerProtection();if(projection?.complete!==true||!Array.isArray(projection.areas)||projection.areas.length>MAX_AREAS||projection.areas.some(a=>!rect(a)))throw Error("player protection incomplete/invalid; preserved");const areas=projection.areas.map(cloneArea);current();if(world.getDynamicProperty(REALM_CLAIM_KEY)!==snapshot.raw)throw Error("realm registry changed around protection capture");return{...snapshot,areas,current};}
 function load(){try{const s=registrySnapshot(world);return{status:"ok",claims:s.value.claims.map(c=>({...c,bounds:bounds(c.bounds)}))};}catch(e){return{status:"held",reason:String(e),claims:null};}}
 /** Append-only and idempotent. No update/delete/release API. @param {string} id @param {any} proposed */
 function reserve(id,proposed){realm(id);if(id==="player"||!rect(proposed)||!exact(proposed,["x0","z0","x1","z1"]))throw Error("exact foreign reservation bounds required");const s=capture();const prior=s.value.claims.find(c=>c.realm===id);if(prior){if(JSON.stringify(prior.bounds)!==JSON.stringify(bounds(proposed)))throw Error("existing realm claim is immutable");return{created:false,claim:{...prior,bounds:bounds(prior.bounds)},terrainAuthorized:false};}if(s.areas.some(a=>overlaps(a,proposed))||s.value.claims.some(c=>overlaps(c.bounds,proposed)))throw Error("realm reservation intersects protected land");const claim={realm:id,dimension:DIM,bounds:bounds(proposed)},next={v:1,claims:[...s.value.claims,claim].sort((a,b)=>a.realm.localeCompare(b.realm))},raw=JSON.stringify(next);if(utf8Length(raw)>MAX_CLAIM_BYTES)throw Error("realm claim byte cap");s.current();if(world.getDynamicProperty(REALM_CLAIM_KEY)!==s.raw)throw Error("realm claim CAS changed");world.setDynamicProperty(REALM_CLAIM_KEY,raw);if(world.getDynamicProperty(REALM_CLAIM_KEY)!==raw)throw Error("realm claim readback failed; retain protective state");s.current();return{created:true,claim,terrainAuthorized:false};}
 /** Keep every existing local area, append strict whole foreign rectangles. Never shared-wall indices.
  * @param {any[]} local @param {string} [self] */
 function exclusions(local,self="player"){realm(self);if(!Array.isArray(local)||local.length>MAX_AREAS||local.some(a=>!rect(a)))throw Error("local protection incomplete");const s=capture(self==="player"?null:self);return[...local.map(cloneArea),...(self==="player"?[]:s.areas.map(cloneArea)),...s.value.claims.filter(c=>c.realm!==self).map(c=>({...bounds(c.bounds),label:"foreign "+c.realm,realm:c.realm}))];}
 /** Existing codecs/stores, scoped metadata only. No builder/terrain API is exposed.
  * @param {string} id @param {number} district */
 function stores(id,district){const keys=realmSourceKeys(id,district);if(id==="player")return{keys,master:createPlanStore(world,{prefix:keys.master}),site:createPlanStore(world,{prefix:keys.site}),jobs:createJobStore(world,{prefix:keys.jobs}),terrainAuthorized:false};const s=capture(id);if(!s.value.claims.some(c=>c.realm===id))throw Error("realm has no reserved source scope");const ownClaim=s.value.claims.find(c=>c.realm===id);if(s.areas.some(a=>overlaps(a,ownClaim.bounds)))throw Error("reserved realm intersects current player protection; hold");const prefix=REALM_SOURCE_FAMILY+id+":";const check=()=>{s.current();if(world.getDynamicProperty(REALM_CLAIM_KEY)!==s.raw)throw Error("claim changed during scoped source access");};const allowed=(/** @type {string} */ key)=>{if(typeof key!=="string"||!key.startsWith(prefix)||!([prefix+"plan",prefix+"jobs"].some(p=>key===p||key.startsWith(p+":"))))throw Error("cross-realm metadata access refused");};const scoped={getDynamicProperty(/** @type {string} */ key){allowed(key);check();const value=world.getDynamicProperty(key);check();return value;},setDynamicProperty(/** @type {string} */ key,/** @type {any} */ value){allowed(key);check();world.setDynamicProperty(key,value);check();},getDynamicPropertyIds(){check();const result=ids(world).filter(k=>k.startsWith(prefix));check();return result;}};const safePlan=(/** @type {string} */ prefix)=>{const store=createPlanStore(scoped,{prefix});return{loadPlan:()=>store.loadPlan(),savePlan:store.savePlan,measurePlan:store.measurePlan};};const jobStore=createJobStore(scoped,{prefix:keys.jobs});return{keys,master:safePlan(keys.master),site:safePlan(keys.site),jobs:{loadQueue:()=>jobStore.loadQueue(),saveQueue:jobStore.saveQueue},terrainAuthorized:false};}
 /** A held live source fence around existing metadata codecs. No native authority.
  * @param {string} id */
 function builderContext(id){realm(id);if(id==='player')throw Error('player uses original default builder context');const s=capture(id),claim=s.value.claims.find(c=>c.realm===id);if(!claim)throw Error('realm has no reserved source scope');if(s.areas.some(a=>overlaps(a,claim.bounds)))throw Error('realm intersects current player protection');
  const check=()=>{s.current();if(world.getDynamicProperty(REALM_CLAIM_KEY)!==s.raw)throw Error('claim changed during builder context');};
  const readFence=()=>{check();const prefix=REALM_SOURCE_FAMILY+id+':';const captureOwn=()=>{check();let bytes=0;const rows=ids(world).filter(k=>k.startsWith(prefix)).map(key=>{const value=world.getDynamicProperty(key);if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Error('own realm source unreadable');bytes+=typeof value==='string'?utf8Length(value):8;if(bytes>MAX_RAW_BYTES)throw Error('own realm source bound');return[key,value];});check();return JSON.stringify(rows);};const raw=captureOwn();return()=>{if(captureOwn()!==raw)throw Error('own realm source changed during saved-source read');};};
  const context=Object.freeze({realm:id,dimension:DIM,terrainAuthorized:false});BUILDER_CONTEXTS.set(context,{world,check,readFence,select:(/** @type {number} */district)=>{check();const result=stores(id,district);check();return result;}});return context;
 }
 return{load,reserve,exclusions,stores,builderContext,terrainAuthorized:false};
}
