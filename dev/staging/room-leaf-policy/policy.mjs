// Exploratory pure preview. Binding declarations are not loader/native authentication.
// No imported runtime, block writes, persistent state or capability is produced.
/** @typedef {{x:number,y:number,z:number}} Point */
/** @typedef {Record<string,string|number|boolean>} States */
/** @typedef {Point&{status:"loaded",id:string,states:States}} Snapshot */
/** @typedef {{sourceIndex:number,id:string,states:States,stage:string,element:string}} Claim */
/** @typedef {{index:number,checksum:string,queue:string,dimension:string}} SourceBinding */
/** @typedef {{id:string,baseY:number,bbox:{x0:number,x1:number,z0:number,z1:number}}} RoomBuilding */
export const POLICY = 'chapel-interior-leaves-preview-v1';
export const LIMITS = Object.freeze({targets:8, sources:5, ops:2000000, slice:400, states:32, stateChars:2048});
export const SOURCE_STAGES = Object.freeze(['clear','walls','gates','roads','lots','dressing']);
const STAGES=SOURCE_STAGES;
const LEAF = /^minecraft:(?:(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|azalea)_leaves|azalea_leaves_flowered|leaves2?)$/;
const PLANT = /^minecraft:(?:.*_(?:log|wood|leaves|sapling)|azalea_leaves_flowered|log2?|leaves2?|vine|weeping_vines|twisting_vines|mangrove_propagule|wheat|carrots|potatoes|beetroot|short_grass|tall_grass|fern|large_fern)$/;
const STRUCTURE = /^minecraft:(?:stone_bricks|mossy_stone_bricks|cracked_stone_bricks|cobblestone|stone|glass|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_planks)$/;
const SPECIAL = /^minecraft:(?:.*(?:sand|gravel|anvil|concrete_powder)|barrel|chest|trapped_chest|furnace|smoker|blast_furnace|hopper|lectern|dispenser|dropper|shulker_box|.*_shulker_box|vine|weeping_vines|twisting_vines|.*_torch|torch|.*_button|lever|.*_door|.*_trapdoor|.*_fence_gate)$/;
/** Planned plants and unknown decorations are hazards even after laterAIR.
 * Only explicitly known inert structural families and lantern fixtures bypass this historical veto.
 * @param {string} blockId */
const historicalHazard=blockId=>blockId!=="minecraft:air"&&(PLANT.test(blockId)||LEAF.test(blockId)||(!STRUCTURE.test(blockId)&&blockId!=="minecraft:lantern"));
const key = (/** @type {Point} */p) => `${p.x},${p.y},${p.z}`;
/** @param {string} s @returns {never} */
const fail = s => {throw Error(s);};
const hash = (/** @type {any} */s) => typeof s==='string'&&/^[a-f0-9]{8}$/.test(s);
const point = (/** @type {any} */p) => p&&[p.x,p.y,p.z].every(Number.isSafeInteger)&&Math.abs(p.x)<=29999999&&Math.abs(p.z)<=29999999&&p.y>=-64&&p.y<=319;
const id = (/** @type {any} */s) => typeof s==='string'&&/^[a-z0-9_.-]+:[a-z0-9_./-]{1,128}$/.test(s);
/** @param {any} object */
function data(object){
 if(!object||typeof object!=='object'||Array.isArray(object)||![Object.prototype,null].includes(Object.getPrototypeOf(object)))fail('primitive plain evidence required');
 const descriptors=Object.getOwnPropertyDescriptors(object);
 if(Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')))fail('accessor evidence refused');
 return descriptors;
}
/** @param {any} raw @returns {States} */
function states(raw){
 const descriptors=data(raw),keys=Object.keys(descriptors).sort();if(keys.length>LIMITS.states)fail('state count cap');
 /** @type {States} */const out={};for(const k of keys){const v=descriptors[k].value;if(!/^[a-z0-9_:.-]{1,64}$/.test(k)||!(typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=128))fail('state primitive unknown');Object.defineProperty(out,k,{value:v,enumerable:true});}
 if(JSON.stringify(out).length>LIMITS.stateChars)fail('state character cap');return out;
}
/** @param {any} raw @returns {Snapshot} */
function cell(raw){
 data(raw);if(!point(raw)||raw.status!=='loaded'||!id(raw.id))fail('unloaded/unknown cell');
 return{x:raw.x,y:raw.y,z:raw.z,status:'loaded',id:raw.id,states:states(raw.states)};
}
/** Untrusted declarations; a runtime adapter must authenticate their origin. @param {any} input */
function binding(input){
 if(input.policy!==POLICY||input.dimension!=='minecraft:overworld'||!hash(input.masterHash)||!Number.isInteger(input.index)||input.index<1||input.index>5||!Array.isArray(input.sources)||input.sources.length!==5)fail('explicit policy and five source bindings required');
 /** @type {SourceBinding[]} */const rows=input.sources.map((/** @type {any} */s)=>{if(!Number.isInteger(s.index)||s.index<1||s.index>5||!hash(s.checksum)||s.queue!=='complete'||s.dimension!==input.dimension)fail('complete source binding mismatch');return{index:s.index,checksum:s.checksum,queue:s.queue,dimension:s.dimension}; }).sort((/** @type {SourceBinding} */a,/** @type {SourceBinding} */b)=>a.index-b.index);
 if(rows.some((r,i)=>r.index!==i+1))fail('missing/duplicate source');
 if(!hash(input.checksum)||rows[input.index-1].checksum!==input.checksum)fail('selected checksum mismatch');
 const e=input.building,b=e?.bbox;if(e?.id!==`building-d${input.index}-chapel-${e?.ordinal}`||!Number.isInteger(e.ordinal)||e.ordinal<1||e.ordinal>999||e.blueprint!=='chapel_v2'||e.kind!=='building-chapel'||e.stage!=='lots'||!hash(e.sourceElementHash)||!Number.isInteger(e.rot)||e.rot<0||e.rot>3||!Number.isSafeInteger(e.baseY)||!b)fail('supported selected chapel source required');
 const width=e.rot%2?15:9,depth=e.rot%2?9:15;
 if(![b.x0,b.x1,b.z0,b.z1].every(Number.isSafeInteger)||b.x1-b.x0+1!==width||b.z1-b.z0+1!==depth||[b.x0,b.x1,b.z0,b.z1].some(n=>Math.abs(n)>29999998)||e.baseY+1< -63||e.baseY+5>318)fail('chapel geometry mismatch');
 return{policy:POLICY,geometryIntent:'chapel-interior-five-layers-v1',checksum:input.checksum,dimension:input.dimension,masterHash:input.masterHash,index:input.index,building:{id:e.id,sourceElementHash:e.sourceElementHash,blueprint:e.blueprint,rot:e.rot,baseY:e.baseY,bbox:{x0:b.x0,x1:b.x1,z0:b.z0,z1:b.z1}},sources:rows};
}
const inside = (/** @type {RoomBuilding} */b,/** @type {Point} */p) => p.x>b.bbox.x0&&p.x<b.bbox.x1&&p.z>b.bbox.z0&&p.z<b.bbox.z1&&p.y>=b.baseY+1&&p.y<=b.baseY+5;
/** @param {Point} target @param {any} raw @returns {Map<string,Snapshot>} */
function neighbors(target,raw){
 if(!Array.isArray(raw)||raw.length!==27)fail('exact loaded27 snapshots required');
 /** @type {Map<string,Snapshot>} */const map=new Map();for(const item of raw){const c=cell(item);if(Math.abs(c.x-target.x)>1||Math.abs(c.y-target.y)>1||Math.abs(c.z-target.z)>1||map.has(key(c)))fail('neighbor cube incomplete/duplicate');map.set(key(c),c);}
 return map;
}
/** Exact full states: a subset claim must not bless unreviewed current metadata.
 * @param {Snapshot} observed @param {Claim} claim */
const sameClaim = (observed,claim) => {const actual=Object.keys(observed.states).sort(),expected=Object.keys(claim.states).sort();return observed.id===claim.id&&actual.length===expected.length&&actual.every((k,i)=>k===expected[i]&&observed.states[k]===claim.states[k]);};
/** @param {Point} target @param {Map<string,Snapshot>} cube @param {Map<string,Claim>[]} finals
 * @param {Set<string>} historical @param {Set<string>} targetHistory @param {Set<string>} protectedCells
 * @param {{index:number,building:RoomBuilding}} bound */
function classify(target,cube,finals,historical,targetHistory,protectedCells,bound){
 if(!inside(bound.building,target))return 'outside explicit versioned chapel interior';
 if(targetHistory.has(key(target)))return 'historical planned non-air target';
 const center=cube.get(key(target));if(!center||!LEAF.test(center.id)||center.states.persistent_bit!==false)return 'target not proven nonpersistent known leaf';
 for(const observed of cube.values()){
  const at=key(observed);if(protectedCells.has(at))return 'neighbor interior/prototype/unknown protection';
  const claims=finals.map(m=>m.get(at)).filter(c=>c!==undefined);
  if(historical.has(at))return 'historical planned plant/log/leaf or unknown decoration in neighborhood';
  if(at===key(target)&&claims.some(c=>c.id!=='minecraft:air'))return 'final planned non-air target';
  if(claims.some(c=>!(at===key(target)&&c.id==='minecraft:air')&&!sameClaim(observed,c)))return 'final structural claim differs from current neighborhood';
  if(observed.id==='minecraft:air')continue;
  if(LEAF.test(observed.id)){
   if(observed.states.persistent_bit!==false||(at===key(target)?claims.some(c=>c.id!=='minecraft:air'):claims.length))return 'persistent or planned neighboring leaf';
   continue;
  }
  if(SPECIAL.test(observed.id))return 'attachment/gravity/block-entity proximity';
  // Never infer unknown log provenance or clip/clear a trunk. No log write exists.
  if(PLANT.test(observed.id))return 'log/plant neighborhood provenance unresolved';
  if(!claims.length)return 'foreign or unknown non-air neighborhood';
  if(STRUCTURE.test(observed.id))continue;
  if(observed.id==='minecraft:lantern'){
   if(observed.states.hanging!==false||!claims.every(c=>c.sourceIndex===bound.index&&c.element===bound.building.id&&c.states.hanging===false))return 'fixture attachment not exact standing claim';
   const below=cube.get(key({...observed,y:observed.y-1}));
   if(!below||!STRUCTURE.test(below.id)||!finals.some(m=>{const c=m.get(key(below));return c&&c.sourceIndex===bound.index&&c.element===bound.building.id&&sameClaim(below,c);}))return 'fixture support not freshly exact';
   continue;
  }
  return 'unsupported structural contact';
 }
 return null;
}
/** Streams all source operations, retaining only at most8×27 relevant coordinates.
 * Current() must bind the real loader/raw snapshot in a future adapter. This pure
 * preview cannot authenticate declared checksum strings or grant write permission. */
/** @param {any} input @param {{current?:()=>boolean}} [deps] */
export function* previewRoomLeaves(input,{current=()=>false}={}){
 const check=()=>{if(current()!==true)fail('source binding changed');};check();const bound=binding(input);
 if(!Array.isArray(input.targets)||input.targets.length<1||input.targets.length>LIMITS.targets)fail('small target batch required');
 const targets=[],wanted=new Set(),seen=new Set();
 for(const row of input.targets){data(row);if(!point(row)||seen.has(key(row)))fail('malformed/duplicate target');seen.add(key(row));let cube,reason=null;try{cube=neighbors(row,row.neighbors);}catch(e){reason=String(e instanceof Error?e.message:e);cube=new Map();}const target={x:row.x,y:row.y,z:row.z};targets.push({target,cube,reason});for(const c of cube.values())wanted.add(key(c));}
 /** @type {Map<string,Claim>[]} */const finals=[];const historical=new Set(),targetHistory=new Set(),protectedCells=new Set();let operations=0,work=0;
 for(const source of [...input.sources].sort((a,b)=>a.index-b.index)){
  if(!Array.isArray(source.protectedCells)||source.protectedCells.length>216)fail('bounded source protection projection missing');
  for(const p of source.protectedCells){data(p);if(!point(p)||!['interior','prototype','unknown'].includes(p.kind))fail('unknown protection projection');
   if(p.kind==='interior'&&(typeof p.buildingId!=='string'||!/^building-d[1-5]-[a-z0-9_]+-[1-9]\d{0,2}$/.test(p.buildingId)||!p.buildingId.startsWith(`building-d${source.index}-`)))fail('interior protection requires authenticated source-building identity');
   const selectedRoom=source.index===bound.index&&p.kind==='interior'&&p.buildingId===bound.building.id;
   if(wanted.has(key(p))&&!selectedRoom)protectedCells.add(key(p));
  }
  if(!source.ops||typeof source.ops[Symbol.iterator]!=='function')fail('source operation stream missing');
  /** @type {Map<string,Claim>} */const final=new Map();finals.push(final);let priorStage=-1;
  for(const op of source.ops){check();if(++operations>LIMITS.ops)fail('source operation budget');const stage=STAGES.indexOf(op?.stage);
   if(stage<0||stage<priorStage||!point(op)||!id(op.id)||typeof op.element!=='string'||op.element.length>128)fail('malformed/out-of-order source operation');priorStage=stage;
   const at=key(op);if(wanted.has(at)){const value={sourceIndex:source.index,id:op.id,states:states(op.states??{}),stage:op.stage,element:op.element};final.set(at,value);if(historicalHazard(op.id))historical.add(at);if(seen.has(at)&&op.id!=='minecraft:air')targetHistory.add(at);}
   if(++work>=LIMITS.slice){check();yield;check();work=0;}
  }
 }
 check();const rows=targets.map(({target,cube,reason})=>{
  reason=reason??classify(target,cube,finals,historical,targetHistory,protectedCells,bound);
  return{target,eligible:reason===null,reason:reason??'preview subset meets current narrow checks',observed:cube.get(key(target))??null,observedNeighbors:[...cube.values()]};
 });check();
 return{policy:POLICY,binding:bound,operations,eligible:rows.filter(r=>r.eligible).length,refused:rows.filter(r=>!r.eligible).length,rows,writePermission:false,scope:'Detached pure preview only. Supplied snapshots/bindings require real native/loader authentication before any later policy. No cleanup, AIR repair, tree topology, origin or lasting world-state proof.'};
}
