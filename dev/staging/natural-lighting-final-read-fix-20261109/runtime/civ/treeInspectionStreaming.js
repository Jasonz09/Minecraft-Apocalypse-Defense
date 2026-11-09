import {compileSharedTreeProtectionSteps} from "./sharedtree.js";

const READ_ONLY_PROTECTIONS=new WeakSet();
/** Prevent accidental forwarding of an inspection-only subset into a construction writer.
 * @param {unknown} value */
export const isTreeInspectionProtection=value=>!!value&&typeof value==="object"&&READ_ONLY_PROTECTIONS.has(value);

export const TREE_INSPECTION_SOURCE_LIMITS=Object.freeze({horizontal:17,vertical:41,entries:16384,sources:5});
/** Exact read envelope: existing traversal H16/V40, plus every neighbor/base probe.
 * @param {{x:number,y:number,z:number}} seed */
export function treeInspectionBounds(seed){
 if(!seed||![seed.x,seed.y,seed.z].every(Number.isSafeInteger)||seed.y< -63||seed.y>318||Math.abs(seed.x)>29999982||Math.abs(seed.z)>29999982)throw Error("Tree inspection seed is outside supported bounds");
 return {x0:seed.x-17,x1:seed.x+17,y0:seed.y-41,y1:seed.y+41,z0:seed.z-17,z1:seed.z+17};
}
/** @param {ReturnType<typeof treeInspectionBounds>} b @param {{x:number,y:number,z:number}} p */
export const withinTreeInspection=(b,p)=>p.x>=b.x0&&p.x<=b.x1&&p.y>=b.y0&&p.y<=b.y1&&p.z>=b.z0&&p.z<=b.z1;

/** Verify all selected/current completed sources, retaining only selected+ONE neighbor.
 * Source wrappers/generators stay inside one helper; returned safeguards are compact.
 * Existing predicate and shared-wall contact semantics remain unchanged.
 * @param {{index:number,dimension:string,seed:{x:number,y:number,z:number},sources:{index:number,civ:any}[]}} input
 * @param {{current:()=>boolean,cancelled?:()=>boolean,loadSourceSteps:(index:number,civ:any)=>Generator<any,any,any>,onMaster:(plan:any)=>void,relevant:(x:number,z:number)=>boolean,opsFor?:typeof import("./districtplan.js").siteOpsFor,onRetention?:(event:{phase:string,index:number,held:number})=>void}} deps */
export function* prepareTreeInspectionSourcesSteps(input,deps){
 const seed={x:input.seed?.x,y:input.seed?.y,z:input.seed?.z},bounds=treeInspectionBounds(seed),check=()=>{if(deps.cancelled?.()||deps.current()!==true)throw Error("Tree inspection source/player/job guard refused");};
 check();
 if(!Number.isInteger(input.index)||input.index<1||input.index>5||input.dimension!=="minecraft:overworld"||!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>5)throw Error("Tree inspection source manifest unsupported");
 const seen=new Set(),manifest=input.sources.map(s=>{
  if(!Number.isInteger(s.index)||s.index<1||s.index>5||seen.has(s.index))throw Error("Tree inspection refused: unsupported or duplicate saved-plan slot");
  const id=`district-${s.index}`;
  if(s.civ?.status!=="complete")throw Error(`Tree inspection refused: ${id} is still building or incomplete; shared tree protection needs its completed saved plan. Nothing changed.`);
  if(s.civ.dimension!==input.dimension)throw Error(`Tree inspection refused: ${id}'s dimension is missing or differs from this city; shared tree protection cannot be verified. Nothing changed.`);
  if(!/^[a-f0-9]{8}$/.test(s.civ.checksum))throw Error(`Tree inspection refused: Cannot verify ${id}'s shared tree protection: saved source checksum is invalid. Nothing changed.`);
  seen.add(s.index);return {index:s.index,civ:JSON.parse(JSON.stringify(s.civ))};
 });
 const selected=manifest.find(s=>s.index===input.index);if(!selected)throw Error("Selected tree source missing");
 /** @template T @param {Generator<any,T,any>} generator @returns {Generator<undefined,T,unknown>} */
 function* guarded(generator){for(;;){check();const n=generator.next();check();if(n.done)return n.value;yield;check();}}
 /** @type {Set<string>} */const plannedTrees=new Set();
 /** @type {Map<string,readonly string[]>} */const finalBlocks=new Map();
 /** @type {import("./sharedtree.js").BoundaryPlan[]} */const boundaryPlans=[];
 let held=0,peak=0,verified=0;
 const retention=(/** @type {string} */phase,/** @type {number} */index,/** @type {number} */delta)=>{held+=delta;peak=Math.max(peak,held);deps.onRetention?.({phase,index,held});check();};
 const cap=()=>{if(plannedTrees.size>16384||finalBlocks.size>16384||boundaryPlans.reduce((n,p)=>n+p.finalWalls.size,0)>16384)throw Error("Tree inspection compact source projection exceeds cap; nothing truncated");};
 /** @type {any} */let own;
 /** @type {string|undefined} */let master;
 try{
  // The selected record is required by the existing own-plan/tree predicate.
  own=yield* guarded(deps.loadSourceSteps(selected.index,selected.civ));
  if(!own?.ok||own.queue?.state!=="complete"||own.record?.districtIndex!==selected.index||own.record.checksum!==selected.civ.checksum||!own.plan)throw Error("Selected tree source is not verified complete");
  if(seed.x<own.region.x0||seed.x>own.region.x1||seed.z<own.region.z0||seed.z>own.region.z1)throw Error("Tree seed outside selected district");
  own={record:own.record,plan:own.plan,region:own.region,queue:{state:own.queue.state}};
  master=JSON.stringify(own.plan);retention("selected-retained",selected.index,1);verified++;deps.onMaster(own.plan);check();
  /** @param {{index:number,civ:any}} entry */
  function* one(entry){
   let retained=false;
   try{
    const other=yield* guarded(deps.loadSourceSteps(entry.index,entry.civ));
    if(!other?.ok||other.queue?.state!=="complete"||other.record?.districtIndex!==entry.index||other.record.checksum!==entry.civ.checksum||JSON.stringify(other.plan)!==master)throw Error("Neighbor tree source is not verified complete in same master");
    retained=true;retention("neighbor-retained",entry.index,1);verified++;
    const part=yield* guarded(compileSharedTreeProtectionSteps([other.record],{x0:seed.x,x1:seed.x,z0:seed.z,z1:seed.z},deps.relevant,{opsFor:deps.opsFor,within:p=>withinTreeInspection(bounds,p),entryLimit:16384}));
    for(const at of part.plannedTrees){plannedTrees.add(at);cap();}
    for(const [at,ids] of part.finalBlocks){finalBlocks.set(at,Object.freeze([...new Set([...(finalBlocks.get(at)??[]),...ids])]));cap();}
    for(const p of part.boundaryPlans??[])boundaryPlans.push({districtIndex:p.districtIndex,outline:p.outline.map(point=>Object.freeze(/** @type {[number,number]} */([point[0],point[1]]))),finalWalls:new Map(p.finalWalls)});
    cap();check();
   }finally{if(retained)retention("neighbor-released",entry.index,-1);}
  }
  for(const entry of manifest)if(entry.index!==selected.index){check();yield* one(entry);check();}
  check();
  const protection=Object.freeze({plannedTrees,finalBlocks,boundaryPlans});READ_ONLY_PROTECTIONS.add(protection);
  return {saved:own,protection,bounds,retention:{peakHeavyRecords:peak,selectedRetained:1,verifiedSources:verified}};
 }catch(error){if(own){own=undefined;held=0;deps.onRetention?.({phase:"selected-released",index:selected.index,held:0});}throw error;}
}
