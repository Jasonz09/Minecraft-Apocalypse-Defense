import {isLiveSite,siteOpSlices,SITE_STAGES} from '../civ/districtplan.js';
import {destinationProofIsCurrent} from './destinations.js';

// AUTHORING ONLY: compact saved-road planner. A route is NOT native-clearance,
// movement, jumping, work, resource, or population permission.
export const ROAD_ROUTE_POLICY='saved-owned-road-route-v1';
export const ROAD_ROUTE_LIMITS=Object.freeze({sources:1,nodes:8192,pathEdges:256,directedEdges:32768,scannedOps:2000000,workPerYield:400,contactsPerNode:3});
const AIR=new Set(['minecraft:air','minecraft:cave_air','minecraft:void_air']);
const FLOOR=/^minecraft:(?:grass_path|dirt_path|stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|cobblestone|mossy_cobblestone|andesite|polished_andesite|(?:oak|spruce|birch|jungle|acacia|dark_oak)_planks)$/;
// No prototype/grow-margin/foreign-historical-op BLOCK-EDIT veto applies here.
const BUILDERS=new WeakMap(),ROUTES=new WeakSet();
/** @param {string} message @returns {never} */
const fail=message=>{throw new Error(message);};
/** @param {any} p */
const key=p=>`${p.x},${p.y},${p.z}`;
/** @param {any} p */
const col=p=>`${p.x},${p.z}`;
/** @param {any} value @returns {any} */
const clone=value=>JSON.parse(JSON.stringify(value));
/** @param {any} value @returns {any} */
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
/** @param {any} s */
const hash=s=>typeof s==='string'&&/^[a-f0-9]{8}$/.test(s);
/** @param {any} p */
const point=p=>p&&[p.x,p.y,p.z].every(Number.isSafeInteger)&&Math.abs(p.x)<=29999980&&Math.abs(p.z)<=29999980&&p.y>=-64&&p.y<=319;
/** @param {object} token @returns {any} */
function builder(token){const state=BUILDERS.get(token);if(!state)fail('unknown/completed route collector');return state;}
/** @param {any} record */
function metadataStamp(record){const stamp=JSON.stringify([record.districtIndex,record.checksum,...SITE_STAGES.map(stage=>record[stage])]);if(stamp.length>512000)fail('source descriptor snapshot budget exceeded');return stamp;}
/** @param {any} state @param {any} record @param {any} proof */
function verifySource(state,record,proof){
 if(!isLiveSite(record)||!proof||proof.queue?.state!=='complete'||proof.queue.planHash!==record.checksum||proof.civ?.status!=='complete'||proof.civ.stage!=='complete'||proof.civ.dimension!=='minecraft:overworld'||proof.civ.checksum!==record.checksum||proof.masterHash!==state.masterHash)fail('verified completed source/master/queue/dimension missing');
 if(record.districtIndex!==state.index||record.checksum!==state.checksum)fail('selected source identity differs');
 return record.districtIndex;
}
/** @param {any} state */
function* tick(state){if(++state.work>=ROAD_ROUTE_LIMITS.workPerYield){state.work=0;yield;}}
/** @param {any} state @param {any} record @param {(op:any,stage:string,element:string)=>void} visit @param {typeof siteOpSlices} opsFor */
function* scan(state,record,visit,opsFor){
 for(const slice of opsFor(record,{maxOps:256}))for(const op of slice.ops){
  if(++state.scannedOps>ROAD_ROUTE_LIMITS.scannedOps)fail('road source scan budget exceeded');
  if(!point(op)||typeof op.id!=='string'||op.id.length>128||typeof slice.stage!=='string'||typeof slice.element!=='string')fail('invalid bounded saved operation');
  visit(op,slice.stage,slice.element);yield* tick(state);
 }
}
/** @param {any} compiled @param {string} id @param {string} role */
function choose(compiled,id,role){
 if(typeof id!=='string'||id.length>96)fail('invalid endpoint building identity');
 const rows=compiled.candidates.filter((/** @type {any} */ c)=>c.id===id&&c.role===role);if(rows.length!==1)fail('saved endpoint building role missing/ambiguous');
 const c=rows[0],p=c.frontageFeet,f=c.frontageSurface;
 if(!p||!f||!point(p)||!point(f)||p.x!==f.x||p.z!==f.z||p.y!==f.y+1||f.kind!=='road'||f.y>317||!FLOOR.test(f.id)||c.checksum!==compiled.checksum)fail('exact known saved endpoint frontage unresolved');
 return clone({id:c.id,lotId:c.lotId,role:c.role,blueprint:c.blueprint,checksum:c.checksum,districtId:c.districtId,floor:f,feet:p});
}
/** Selected source first, before dropping its heavy record. Caller drives this
 * generator under fresh selected raw source/master/queue guards across EVERY
 * yield. Input assertions do not replace actual loadSavedRunSteps verification.
 * deps.sourceSlices is an explicit test/stream adapter; default is actual saved
 * live source slices. No builder or route stores a site record/lazy generator.
 */
/** @param {any} record @param {any} compiled @param {any} input @param {{sourceSlices?:typeof siteOpSlices}} [deps] */
export function* beginSavedRoadRouteSteps(record,compiled,input,deps={}){
 if(!destinationProofIsCurrent(compiled)||record.districtIndex!==compiled.index||record.checksum!==compiled.checksum||!hash(input.masterHash))fail('compiler-owned selected endpoint/source provenance required');
 const home=choose(compiled,input.homeBuilding,'home'),farm=choose(compiled,input.farmBuilding,'farm');
 if(home.districtId!==farm.districtId||home.districtId!==`district-${compiled.index}`||home.lotId===farm.lotId||key(home.floor)===key(farm.floor))fail('endpoint district/lot differs or trip has zero length');
 const state={index:compiled.index,checksum:compiled.checksum,masterHash:input.masterHash,sources:[{index:record.districtIndex,checksum:record.checksum}],home,farm,
  work:0,scannedOps:0,selectedVerified:false,candidates:new Map(),wanted:new Set(),final:new Map(),invalidSamples:[]};
 verifySource(state,record,input.proof);const originalMetadata=metadataStamp(record);const sourceSlices=deps.sourceSlices??siteOpSlices;
 // Candidate surface coordinates only; no all-op object cache.
 yield* scan(state,record,(op,stage)=>{
  if(stage!=='roads'||op.kind!=='road'||op.y>317||!FLOOR.test(op.id))return;
  const at=key(op);if(!state.candidates.has(at)&&state.candidates.size>=ROAD_ROUTE_LIMITS.nodes)fail('road node budget exceeded; no truncated path');
  state.candidates.set(at,{x:op.x,y:op.y,z:op.z});
 },sourceSlices);
 for(const p of state.candidates.values())for(let dy=0;dy<=2;dy++){state.wanted.add(key({...p,y:p.y+dy}));yield* tick(state);}
 yield* scan(state,record,(op,stage,element)=>{
  const at=key(op);if(!state.wanted.has(at))return;
  const states=op.states??{};if(typeof states!=='object'||Array.isArray(states))fail('unreadable planned states');
  state.final.set(at,{id:op.id,kind:op.kind,stage,element,hasStates:Object.keys(states).length!==0});
 },sourceSlices);
 if(!destinationProofIsCurrent(compiled)||metadataStamp(record)!==originalMetadata)fail('endpoint source mutated during road compilation');
 verifySource(state,record,input.proof);
 state.selectedVerified=true;const token=Object.freeze({policy:ROAD_ROUTE_POLICY,index:state.index});BUILDERS.set(token,state);return token;
}
// No neighboring-source rehydration or historical block-edit authority is
// required for ordinary NPC walking. Selected saved roads guide routing only;
// actual loaded footing/body/collision/hazard proof remains mandatory.
/** Compile graph from exact FINAL own road material, planned AIR/absence body
 * plus mandatory future native proof. Planned absent body cells are UNVERIFIED,
 * never an assertion of AIR. Explicit non-AIR/stateful body claims are blocked.
 */
/** @param {object} token */
export function* finishSavedRoadRouteSteps(token){
 const s=builder(token);if(s.selectedVerified!==true)fail('selected completed source was not verified');
 /** @type {Map<string,any>} */ const byColumn=new Map();
 const ambiguous=new Set();
 /** @param {any} p @param {string} why */
 function reject(p,why){if(s.invalidSamples.length<8)s.invalidSamples.push({point:clone(p),reason:why});}
 for(const [at,p]of s.candidates){
  yield* tick(s);const floor=s.final.get(at),feet=s.final.get(key({...p,y:p.y+1})),head=s.final.get(key({...p,y:p.y+2}));
  if(!floor||floor.stage!=='roads'||floor.kind!=='road'||floor.hasStates||!FLOOR.test(floor.id)){reject(p,'final road floor was overwritten/stateful/unknown');continue;}
  if([feet,head].some(body=>body&&(!AIR.has(body.id)||body.hasStates))){reject(p,'planned body/head obstruction or unknown states');continue;}
  const column=col(p);if(byColumn.has(column)){ambiguous.add(column);continue;}
  byColumn.set(column,{...p,id:floor.id,owner:floor.element,plannedBody:[feet?'explicit-air':'unplanned-native-required',head?'explicit-air':'unplanned-native-required']});
 }
 for(const c of ambiguous){byColumn.delete(c);yield* tick(s);}
 const start=byColumn.get(col(s.home.floor)),goal=byColumn.get(col(s.farm.floor));
 if(!start||!goal||start.y!==s.home.floor.y||goal.y!==s.farm.floor.y||start.id!==s.home.floor.id||goal.id!==s.farm.floor.id)fail('exact endpoint road floor missing/blocked/ambiguous');
 const queue=[col(start)];
 /** @type {Map<string,string|null>} */ const parent=new Map([[col(start),null]]);let cursor=0,directedEdges=0;
 const order=[[0,-1],[1,0],[0,1],[-1,0]];
 while(cursor<queue.length&&!parent.has(col(goal))){
  const currentKey=queue[cursor++],p=byColumn.get(currentKey);
  for(const[dx,dz]of order){yield* tick(s);const c=`${p.x+dx},${p.z+dz}`,next=byColumn.get(c);if(!next||Math.abs(next.y-p.y)>1)continue;
   if(++directedEdges>ROAD_ROUTE_LIMITS.directedEdges)fail('road edge budget exceeded');
   if(!parent.has(c)){if(parent.size>=ROAD_ROUTE_LIMITS.nodes)fail('road search budget exceeded');parent.set(c,currentKey);queue.push(c);}
  }
 }
 if(!parent.has(col(goal))){
  const closest=[];
  for(const k of parent.keys()){const node=byColumn.get(k),distance=Math.abs(node.x-goal.x)+Math.abs(node.z-goal.z);closest.push({...node,distance});closest.sort((a,b)=>a.distance-b.distance||a.x-b.x||a.z-b.z);if(closest.length>8)closest.pop();}
  // Bounded diagnostic only: planned component cut, never a movement veto/policy.
  const candidateColumns=new Map();for(const p of s.candidates.values()){const c=col(p),list=candidateColumns.get(c)??[];list.push(p.y);candidateColumns.set(c,list);yield* tick(s);}
  /** @type {Record<string,number>} */ const boundaryCounts={};const boundarySamples=[];
  for(const k of parent.keys()){const p=byColumn.get(k);for(const[dx,dz]of order){yield* tick(s);const c=`${p.x+dx},${p.z+dz}`,next=byColumn.get(c);if(next&&Math.abs(next.y-p.y)<=1)continue;
   const heights=candidateColumns.get(c)??[];let category=next?'height-gap-greater-than-one':ambiguous.has(c)?'ambiguous-road-column':heights.length?'planned-road-rejected':'no-saved-road-column';
   boundaryCounts[category]=(boundaryCounts[category]??0)+1;
   if(boundarySamples.length<32){const nearby=heights.slice().sort((/** @type {number} */ a,/** @type {number} */ b)=>Math.abs(a-p.y)-Math.abs(b-p.y)).slice(0,3);
    boundarySamples.push({from:{x:p.x,y:p.y,z:p.z},column:c,category,candidateHeightCount:heights.length,candidateSamples:nearby.map((/** @type {number} */ y)=>{const point={x:p.x+dx,y,z:p.z+dz};return{point,finalFloor:s.final.get(key(point)),feet:s.final.get(key({...point,y:y+1})),head:s.final.get(key({...point,y:y+2}))};})});
   }
  }}
  const goalQueue=[col(goal)],goalSeen=new Set(goalQueue);for(let cursor=0;cursor<goalQueue.length;cursor++){const p=byColumn.get(goalQueue[cursor]);for(const[dx,dz]of order){yield* tick(s);const c=`${p.x+dx},${p.z+dz}`,next=byColumn.get(c);if(next&&Math.abs(next.y-p.y)<=1&&!goalSeen.has(c)){goalSeen.add(c);goalQueue.push(c);}}}
  let nearestGap,pairChecks=0,gapSearchTruncated=false;
  outer:for(const aKey of parent.keys())for(const bKey of goalSeen){if(++pairChecks>65536){gapSearchTruncated=true;break outer;}yield* tick(s);const a=byColumn.get(aKey),b=byColumn.get(bKey),distance=Math.max(Math.abs(a.x-b.x)+Math.abs(a.z-b.z),Math.abs(a.y-b.y));if(!nearestGap||distance<nearestGap.distance)nearestGap={from:{x:a.x,y:a.y,z:a.z},to:{x:b.x,y:b.y,z:b.z},distance};}
  const error=new Error('no saved cardinal road route; missing/overwritten/obstructed/stair/gap or unsupported height transition');
  Object.assign(error,{routeDiagnostics:{candidateNodes:s.candidates.size,usableNodes:byColumn.size,ambiguousColumns:ambiguous.size,visited:parent.size,directedEdges,scannedOps:s.scannedOps,start,goal,closestReached:closest,startComponentSize:parent.size,goalComponentSize:goalSeen.size,boundaryCounts,boundarySamples,nearestComponentGap:nearestGap,gapPairChecks:Math.min(pairChecks,65536),gapSearchTruncated,invalidSamples:s.invalidSamples}});throw error;
 }
 /** @type {string|null|undefined} */ let pathKey=col(goal);
 const keys=[];while(pathKey!==null){if(pathKey===undefined)fail('broken route parent chain');keys.push(pathKey);if(keys.length>ROAD_ROUTE_LIMITS.pathEdges+1)fail('shortest saved route exceeds path budget');pathKey=parent.get(pathKey);yield* tick(s);}
 keys.reverse();const nodes=keys.map(k=>byColumn.get(k)),edges=[];
 for(let i=1;i<nodes.length;i++){const a=nodes[i-1],b=nodes[i],dy=b.y-a.y;edges.push({from:i-1,to:i,kind:dy===0?'flat':dy===1?'rise-one-native-microgate-required':'fall-one-native-microgate-required',deltaY:dy});yield* tick(s);}
 const result=freeze({v:1,policy:ROAD_ROUTE_POLICY,index:s.index,checksum:s.checksum,masterHash:s.masterHash,sources:s.sources,home:s.home,farm:s.farm,
  waypoints:nodes.map(p=>({x:p.x+0.5,y:p.y+1,z:p.z+0.5,floor:{x:p.x,y:p.y,z:p.z,id:p.id,owner:p.owner},plannedBody:p.plannedBody})),edges,
  stats:{scannedOps:s.scannedOps,candidateNodes:s.candidates.size,usableNodes:byColumn.size,ambiguousColumns:ambiguous.size,visited:parent.size,directedEdges,pathEdges:edges.length,retainedProofCells:s.final.size},
  invalidSamples:s.invalidSamples,nativeClearance:'UNVERIFIED: fresh footprint/two-high sweep/floors/source/identity/read-budget proof required',movementPermission:false,verticalMovementPermission:false});
 ROUTES.add(result);BUILDERS.delete(token);return result;
}
/** @param {any} route */
export function isCompiledSavedRoadRoute(route){return ROUTES.has(route);}
/** @param {object} token */
export function abortSavedRoadRoute(token){BUILDERS.delete(token);}
