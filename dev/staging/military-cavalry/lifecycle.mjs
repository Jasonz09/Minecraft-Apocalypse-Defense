// @ts-check
/** Pure compound-lifecycle proposal. No returned object is a native write capability.
 * @typedef {'rider'|'mount'} Role
 * @typedef {{phase:'never'|'pending'|'alive'|'terminal',id:string|null,terminal:null|'entity-die'|'owner-remove'}} Member
 * @typedef {{v:1,epoch:string,group:string,generation:number,rider:Member,mount:Member}} Pair
 * @typedef {{id:string,type:string,tags:string[],dimension:string,x:number,y:number,z:number}} Actor
 */
export const PAIR_POLICY='compound-cavalry-design-v1';
export const ROLE_TYPES=Object.freeze({rider:'civ_trial:cavalry',mount:'civ_trial:cavalry_mount'});
const roles=/** @type {const} */(['rider','mount']);
/** @param {Pair} r @param {Role} role */export const pairTag=(r,role)=>`civcavalry:v1:${r.epoch}:${r.group}:${r.generation}:${role}`;
/** @param {unknown} id */const actorId=id=>typeof id==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(id);
/** @param {Pair} r */export function validPair(r){
 if(!r||Object.keys(r).sort().join(',')!=='epoch,generation,group,mount,rider,v'||r.v!==1||typeof r.group!=='string'||typeof r.epoch!=='string'||!/^district-[1-5]:sol:(0|[1-9]\d{0,4})$/.test(r.group)||!/^[A-Za-z0-9_-]{1,64}$/.test(r.epoch)||!Number.isSafeInteger(r.generation)||r.generation<1)return false;
 for(const role of roles){const m=r[role];if(!m||Object.keys(m).sort().join(',')!=='id,phase,terminal'||!['never','pending','alive','terminal'].includes(m.phase))return false;
  if(m.phase==='never'&&(m.id!==null||m.terminal!==null))return false;
  if(m.phase==='pending'&&(!(m.id===null||actorId(m.id))||m.terminal!==null))return false;
  if(m.phase==='alive'&&(!actorId(m.id)||m.terminal!==null))return false;
  if(m.phase==='terminal'&&(!actorId(m.id)||!['entity-die','owner-remove'].includes(/** @type {string} */(m.terminal))))return false;
 }return !r.rider.id||r.rider.id!==r.mount.id;
}
/** All native/metadata provenance is the future owner's responsibility, not these plain inputs.
 * @param {Pair} r @param {{rider:Actor[],mount:Actor[],ridingMount:string|null,mountRiders:string[],gateOn:boolean,physicalUsed:number,districtUsed:number,maxPhysical:number,maxDistrict:number}} observation */
export function planCavalryLifecycle(r,observation){
 const held=(/** @type {string} */reason)=>({policy:PAIR_POLICY,state:'held',reason,actions:[],writePermission:false,aggregateDelta:0});
 if(!validPair(r))return held('record unsupported/malformed; preserve');
 const o=observation;if(!o||typeof o.gateOn!=='boolean'||![o.physicalUsed,o.districtUsed,o.maxPhysical,o.maxDistrict].every(n=>Number.isSafeInteger(n)&&n>=0))return held('invalid physical budgets');
 if(!Array.isArray(o.mountRiders)||o.mountRiders.length>1)return held('ambiguous mount riders');
 for(const role of roles){const rows=o[role];if(!Array.isArray(rows)||rows.length>1)return held('query failed/duplicate '+role);
  const m=r[role],a=rows[0];if(a){if(a.id!==m.id||a.type!==ROLE_TYPES[role]||a.dimension!=='minecraft:overworld'||![a.x,a.y,a.z].every(Number.isFinite)||!Array.isArray(a.tags)||a.tags.length>64||a.tags.some(t=>typeof t!=='string'||t.length>256))return held('foreign or stale '+role);
   if(a.tags.filter(t=>t.startsWith('civcavalry:')).length!==1||!a.tags.includes(pairTag(r,role)))return held('wrong pair generation '+role);
   const canonical=a.tags.filter(t=>t.startsWith('civpop:'));if(role==='rider'?(canonical.length!==1||canonical[0]!=='civpop:v1:'+r.group):canonical.length!==0)return held('wrong canonical ownership '+role);
   if(m.phase==='never'||m.phase==='terminal')return held('unissued or terminal actor reappeared; preserve');
  }else if(m.phase==='alive'||m.phase==='pending')return held('unloaded/unknown '+role+' is not death; no replacement');
 }
 if(roles.every(role=>r[role].phase==='terminal'))return{policy:PAIR_POLICY,state:'retired-pair',actions:[],writePermission:false,aggregateDelta:0};
 if(roles.some(role=>r[role].phase==='pending'))return held('pending issuance needs exact persisted birth-ticket recovery; no second spawn');
 if(!o.gateOn||roles.some(role=>r[role].phase==='terminal')){
  const alive=roles.filter(role=>r[role].phase==='alive');return{policy:PAIR_POLICY,state:'cleanup-required',actions:alive.map(role=>({kind:'request-owner-remove',role,id:r[role].id})),writePermission:false,aggregateDelta:0};
 }
 const never=roles.filter(role=>r[role].phase==='never');if(never.length){
  // Current used counts must include reservations elsewhere. The compound owner
  // must reserve BOTH physical costs before any first-part birth; this is planning only.
  if(o.physicalUsed+never.length>o.maxPhysical||o.districtUsed+never.length>o.maxDistrict)return held('compound physical capacity unavailable');
  return{policy:PAIR_POLICY,state:'reservation-required',actions:never.map(role=>({kind:'request-durable-role-reservation',role})),writePermission:false,aggregateDelta:0};
 }
 const rider=o.rider[0],mount=o.mount[0];
 if(o.ridingMount!==null||o.mountRiders.length){if(o.ridingMount!==mount.id||o.mountRiders.length!==1||o.mountRiders[0]!==rider.id)return held('foreign/mismatched mount relationship');return{policy:PAIR_POLICY,state:'observed-mounted',actions:[],writePermission:false,aggregateDelta:0};}
 if(Math.hypot(rider.x-mount.x,rider.y-mount.y,rider.z-mount.z)>2)return held('do not seat distant actor; need physical approach');
 return{policy:PAIR_POLICY,state:'seating-proof-required',actions:[{kind:'request-fresh-two-body-clearance-and-owner-seat',rider:rider.id,mount:mount.id}],writePermission:false,aggregateDelta:0};
}
