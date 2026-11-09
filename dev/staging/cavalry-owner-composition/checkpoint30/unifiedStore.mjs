// @ts-check
import{createCreationBindings as createSingleV2,FAMILY}from'./singleV2.mjs';
import{createUnifiedV3Bindings,ROLE_TYPES,SINGLE_TYPES}from'./unifiedV3.mjs';
/** Version dispatch never rewrites v2 metadata or guesses migration.
 * format3 is a trusted factory choice, not a public command permission.
 * @param {any} world @param {any} [deps] */
export function createUnifiedStore(world,deps={}){
 const v2=createSingleV2(world,deps),v3=createUnifiedV3Bindings(world,deps),removals=new WeakMap();
 function format(){const ids=world.getDynamicPropertyIds();if(!Array.isArray(ids)||ids.length>4096||ids.some((/** @type {any} */k)=>typeof k!=='string'))throw Error('unified namespace unreadable');const keys=ids.filter((/** @type {string} */k)=>k.startsWith(FAMILY));const versions=new Set(keys.map((/** @type {string} */k)=>k.split(':')[2]));if(versions.size>1||[...versions].some(v=>v!=='v2'&&v!=='v3'))throw Error('mixed/unknown creation versions preserved');return keys.length?([...versions][0]==='v2'?2:3):(deps.format===3?3:2);}
 /** @param {any} input */function initialize(input){return format()===2?v2.initialize(input):input.mode==='fresh'?v3.initialize(input.epoch,input.fixture):(()=>{throw Error('v3 legacy migration is not implemented');})();}
 /** @param {string} g */function inspect(g){if(format()===2)return v2.inspect(g);const r=v3.inspect(g);return !r||r.kind==='compound'?r:{v:3,epoch:r.epoch,group:r.group,generation:r.generation,...r.single,phase:r.single.phase==='terminal'?'retired':r.single.phase};}
 /** @param {string} g @param {string} type */function canBirth(g,type){if(format()===2)return v2.canBirth(g,type);if(!SINGLE_TYPES.includes(type))throw Error('single birth type unsupported');const r=v3.inspect(g);if(r&&r.kind!=='single')return{allowed:false,reason:'compound history requires compound owner'};if(r&&r.single.type!==type)throw Error('single bound type changed');return{allowed:!r||['never','terminal','cancelled'].includes(r.single.phase),reason:r?'single '+r.single.phase:'exact inventory never issued'};}
 /** @param {string} g @param {string} type */function prepare(g,type){if(format()===2)return v2.prepare(g,type);const r=v3.inspect(g);if(!r||r.kind==='single'&&['terminal','cancelled'].includes(r.single.phase))v3.reserveSingle(g,type);else if(r.kind!=='single'||r.single.type!==type)throw Error('single/compound history conflict');return v3.prepareRole(g,'single');}
 /** @param {any} ticket @param {string} id */const recordSpawned=(ticket,id)=>format()===2?v2.recordSpawned(ticket,id):v3.recordSpawned(ticket,id);
 /** @param {any} ticket @param {any} live */const confirmBorn=(ticket,live)=>format()===2?v2.confirmBorn(ticket,live):v3.confirmBorn(ticket,{...live,role:'single'});
 /** @param {any} ticket @param {string} id */const rollbackRemoved=(ticket,id)=>format()===2?v2.rollbackRemoved(ticket,id):v3.rollbackRemoved(ticket,id);
 /** @param {any} live */const assertOwned=live=>format()===2?v2.assertOwned(live):v3.assertOwned({...live,role:live.role??'single'});
 /** @param {any} live */function beginRemove(live){if(format()===2){const t=v2.beginRemove(live),wrapper=Object.freeze({...t,tag:`civbirth:v2:${t?.epoch}:${t?.group}:${t?.generation}`});removals.set(wrapper,t);return wrapper;}const r=v3.inspect(live.groupId);if(!r||r.kind!=='single')throw Error('compound removal needs both-role adapter');const t=v3.beginRemove({...live,role:'single'}),wrapper=Object.freeze({group:r.group,epoch:r.epoch,generation:r.generation,type:r.single.type,actor:r.single.actor,tag:`civbirth:v3:${r.epoch}:${r.group}:${r.generation}`});removals.set(wrapper,t);return wrapper;}
 /** @param {any} ticket */function commitRemoved(ticket){const t=removals.get(ticket);removals.delete(ticket);if(!t)throw Error('unissued unified removal ticket');return format()===2?v2.commitRemoved(t):v3.commitRemoved(t);}
 /** @param {any} live */const confirmDeath=live=>format()===2?v2.confirmDeath(live):v3.confirmDeath({...live,role:live.role??'single'});
 /** @param {any[]} rows */const observeLoaded=rows=>format()===2?v2.observeLoaded(rows):v3.observeLoaded(rows.map(r=>({...r,role:r.role??'single'})));
 function compound(){if(format()!==3)throw Error('cavalry requires explicit v2-to-v3 migration; v2 preserved');return v3;}
 return{initialize,inspect,canBirth,prepare,recordSpawned,confirmBorn,rollbackRemoved,assertOwned,beginRemove,commitRemoved,confirmDeath,observeLoaded,recoverIssuance:()=>format()===2?v2.recoverIssuance():v3.recoverIssuance(),compound,format};
}
