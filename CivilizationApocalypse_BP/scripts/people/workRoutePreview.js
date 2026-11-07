import {destinationProofIsCurrent} from './destinations.js';
import {isKnownTravelFooting,isTravelBodyClear} from './walkSafety.js';
import {isLiveSite,siteOpSlices} from '../civ/districtplan.js';
import {MinHeap} from '../civ/geom.js';

export const LOADED_ROUTE_LIMITS=Object.freeze({nodes:8192,directedEdges:32768,pathEdges:256,readsPerSlice:256,totalReads:65536,cachedCells:32768,workPerSlice:400,roadHints:8192,sourceOps:2000000});
const ENDPOINTS=new WeakSet();
/** @param {string} message @returns {never} */
const fail=message=>{throw new Error(message);};
/** @param {any} p */
const key=p=>`${p.x},${p.y},${p.z}`;
/** @param {any} p */
const column=p=>`${p.x},${p.z}`;
/** @param {any} value @returns {any} */
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;};
/** @param {any} value @returns {any} */
const clone=value=>JSON.parse(JSON.stringify(value));
/** @param {any} p */
const validPoint=p=>p&&[p.x,p.y,p.z].every(Number.isSafeInteger)&&Math.abs(p.x)<=29999980&&Math.abs(p.z)<=29999980&&p.y>=-64&&p.y<=319;
/** Private compiler-owned SAVED endpoints; no group/job/household inference.
 * @param {any} compiled @param {{homeBuilding:string,farmBuilding:string,index:number,checksum:string,masterHash:string}} input */
export function compileWorkRouteEndpoints(compiled,input){
 if(!destinationProofIsCurrent(compiled)||compiled.index!==input.index||compiled.checksum!==input.checksum||!(/^[a-f0-9]{8}$/).test(input.masterHash))fail('current saved destination compiler provenance required');
 /** @param {string} id @param {string} role */
 function choose(id,role){
  if(typeof id!=='string'||!/^building-[A-Za-z0-9_-]{1,87}$/.test(id))fail('invalid saved endpoint identity');
  const rows=compiled.candidates.filter((/** @type {any} */ c)=>c.id===id&&c.role===role);if(rows.length!==1)fail('saved endpoint role missing/ambiguous');
  const c=rows[0],p=c.frontageFeet,f=c.frontageSurface;
  if(!validPoint(p)||!validPoint(f)||f.y>317||p.y!==f.y+1||p.x!==f.x||p.z!==f.z||f.kind!=='road'||!isKnownTravelFooting(f.id)||c.checksum!==compiled.checksum||c.districtId!==`district-${input.index}`)fail('exact known saved frontage unresolved');
  return clone({id:c.id,lotId:c.lotId,role,blueprint:c.blueprint,floor:f,feet:p});
 }
 const home=choose(input.homeBuilding,'home'),farm=choose(input.farmBuilding,'farm');
 if(home.lotId===farm.lotId||key(home.floor)===key(farm.floor))fail('distinct saved endpoints required');
 const result=freeze({v:1,policy:'loaded-work-route-preview-v1',index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:'minecraft:overworld',home,farm});ENDPOINTS.add(result);return result;
}
/** Road cells are TIE-BREAKING HINTS only. No neighbor/property ownership quorum.
 * @param {any} record @param {any} endpoints */
export function* collectWorkRoadHintsSteps(record,endpoints){
 if(!ENDPOINTS.has(endpoints)||!isLiveSite(record)||record.districtIndex!==endpoints.index||record.checksum!==endpoints.checksum)fail('selected saved road-hint source differs');
 const hints=new Set();let work=0,scanned=0;
 for(const slice of siteOpSlices(record,{maxOps:256}))for(const op of slice.ops){
  if(++scanned>LOADED_ROUTE_LIMITS.sourceOps)fail('road hint source budget exceeded');
  if(slice.stage==='roads'&&op.kind==='road'&&validPoint(op)&&isKnownTravelFooting(op.id)){
   hints.add(column(op));if(hints.size>LOADED_ROUTE_LIMITS.roadHints)fail('road hint budget exceeded; no truncated hint set');
  }
  if(++work>=LOADED_ROUTE_LIMITS.workPerSlice){work=0;yield;}
 }
 return Object.freeze([...hints]);
}
/** Read-only loaded-footing A*. Every native call is budgeted; no entity API,
 * holds, edits, impulses or timers. Returned observations never grant movement.
 * @param {any} endpoints
 * @param {{read:(p:{x:number,y:number,z:number})=>any,current:()=>boolean,cancelled?:()=>boolean,roadHints?:readonly string[]}} ctx */
export function* previewLoadedWorkRouteSteps(endpoints,ctx){
 if(!ENDPOINTS.has(endpoints))fail('private saved endpoint token required');
 const L=LOADED_ROUTE_LIMITS;
 if(ctx.roadHints!==undefined&&(!Array.isArray(ctx.roadHints)||ctx.roadHints.length>L.roadHints||ctx.roadHints.some(s=>typeof s!=='string'||s.length>64)))fail('bounded road hints required');
 const roadHints=new Set(ctx.roadHints??[]),cache=new Map();let reads=0,inSlice=0,work=0,maxReads=0,yields=0,unloaded=0,directed=0;
 const reasons={unknownFooting:0,body:0,unloaded:0,headroom:0};
 /** @type {any[]} */ const samples=[];
 // Observations only: overlapping search rejections do not establish a global cause.
 /** @param {string} kind @param {any} p @param {string|undefined} observedId @param {string} expected */
 function sample(kind,p,observedId,expected){
  if(samples.length>=8||samples.filter(s=>s.kind===kind).length>=2||samples.some(s=>s.kind===kind&&key(s.point)===key(p)))return;
  samples.push({kind,reason:kind==='unloaded'?'unloaded/unreadable':kind,point:{x:p.x,y:p.y,z:p.z},observedId:observedId??null,expected});
 }
 function current(){if(ctx.cancelled?.()||ctx.current()!==true)fail('source/player/dimension/cancellation changed during loaded route preview');}
 function* pace(){current();if(inSlice>=L.readsPerSlice||work>=L.workPerSlice){maxReads=Math.max(maxReads,inSlice);yield;current();inSlice=0;work=0;yields++;}}
 /** @param {any} p @param {boolean} [fresh] @returns {Generator<undefined,string|undefined,unknown>} */
 function* read(p,fresh=false){
  if(!validPoint(p))return undefined;
  const at=key(p);if(!fresh&&cache.has(at)){work++;yield* pace();return cache.get(at);}
  yield* pace();if(reads>=L.totalReads)fail('total native read budget exceeded');reads++;inSlice++;work++;
  let id,valid;
  try{const block=ctx.read({x:p.x,y:p.y,z:p.z});valid=block?.isValid;id=block?.typeId;}catch{valid=false;}
  current();if(valid!==true||typeof id!=='string'){sample('unloaded',p,typeof id==='string'?id:undefined,'readable valid loaded block with typeId');id=undefined;unloaded++;reasons.unloaded++;}
  if(!fresh){if(cache.size>=L.cachedCells&&!cache.has(at))fail('bounded native-cell cache exceeded');cache.set(at,id);}
  return id;
 }
 /** @param {any} p @returns {Generator<undefined,any,unknown>} */
 function* stand(p){
  if(p.y< -64||p.y>317)return undefined;
  const floor=yield* read(p);if(!isKnownTravelFooting(floor)){reasons.unknownFooting++;sample('unknownFooting',p,floor,'known travel footing (existing policy)');return undefined;}
  const feet=yield* read({...p,y:p.y+1}),head=yield* read({...p,y:p.y+2});
  if(!isTravelBodyClear(feet)||!isTravelBodyClear(head)){reasons.body++;if(!isTravelBodyClear(feet))sample('body',{...p,y:p.y+1},feet,'AIR or short grass at feet');if(!isTravelBodyClear(head))sample('body',{...p,y:p.y+2},head,'AIR or short grass at head');return undefined;}
  return{x:p.x,y:p.y,z:p.z,id:floor,feetId:feet,headId:head};
 }
 /** @param {any} a @param {any} b */
 function distance(a,b){return Math.max(Math.abs(a.x-b.x)+Math.abs(a.z-b.z),Math.abs(a.y-b.y));}
 /** @param {any} p @param {number} g */
 function priority(p,g){const h=distance(p,endpoints.farm.floor);return(g+h)*65536+(roadHints.has(column(p))?0:32768)+Math.min(h,32767);}
 /** @type {any[]} */ const nodes=[];const best=new Map(),closed=new Set(),heap=new MinHeap();
 /** @param {any} p @param {number} g @param {number|null} parent */
 function push(p,g,parent){if(nodes.length>=L.directedEdges)fail('bounded search entry budget exceeded');const at=key(p),old=best.get(at);if(old!==undefined&&nodes[old].g<=g)return;
  if(old===undefined&&best.size>=L.nodes)fail('native route node budget exceeded');const index=nodes.length;nodes.push({...p,g,parent});best.set(at,index);heap.push(priority(p,g),index);}
 let goalIndex;
 try{
  current();const start=yield* stand(endpoints.home.floor),goal=yield* stand(endpoints.farm.floor);
  if(!start||!goal)return freeze({state:'REFUSED_ENDPOINT',reason:'saved frontage is unloaded, obstructed or unsafe',permission:false,verticalPermission:false,reads,maxReadsPerSlice:Math.max(maxReads,inSlice),unloaded,reasons,samples});
  if(start.id!==endpoints.home.floor.id||goal.id!==endpoints.farm.floor.id){
   if(start.id!==endpoints.home.floor.id)sample('endpointMaterial',endpoints.home.floor,start.id,`exact saved footing ${endpoints.home.floor.id}`);
   if(goal.id!==endpoints.farm.floor.id)sample('endpointMaterial',endpoints.farm.floor,goal.id,`exact saved footing ${endpoints.farm.floor.id}`);
   return freeze({state:'REFUSED_ENDPOINT',reason:'saved endpoint floor differs from exact planned material',permission:false,verticalPermission:false,reads,maxReadsPerSlice:Math.max(maxReads,inSlice),unloaded,reasons,samples});
  }
  push(start,0,null);const order=[[0,-1],[1,0],[0,1],[-1,0]],height=[0,1,-1];
  while(heap.size){
   yield* pace();work++;const[,index]=heap.pop(),p=nodes[index],at=key(p);if(best.get(at)!==index||closed.has(at))continue;closed.add(at);
   if(at===key(goal)){goalIndex=index;break;}if(p.g>=L.pathEdges)continue;
   for(const[dx,dz]of order){let selected;
    for(const dy of height){const candidate=yield* stand({x:p.x+dx,y:p.y+dy,z:p.z+dz});if(!candidate)continue;
     if(dy===1){const overhead=yield* read({x:p.x,y:p.y+3,z:p.z});if(!isTravelBodyClear(overhead)){reasons.headroom++;sample('headroom',{x:p.x,y:p.y+3,z:p.z},overhead,'AIR or short grass above rising actor');continue;}candidate.riseFromHead=overhead;}
     selected=candidate;break;
    }
    if(!selected)continue;if(++directed>L.directedEdges)fail('native route edge budget exceeded');push(selected,p.g+1,index);yield* pace();
   }
  }
  if(goalIndex===undefined)return freeze({state:unloaded?'PARTIAL_NO_PATH':'BOUNDED_NO_PATH',reason:'No loaded known-safe path found within finite search/path limits; no world-wide impossibility claim.',permission:false,verticalPermission:false,reads,maxReadsPerSlice:Math.max(maxReads,inSlice),unloaded,visited:closed.size,reasons,samples});
  /** @type {any[]} */ const path=[];let i=goalIndex;
  for(;;){const n=nodes[i];path.push(n);if(path.length>L.pathEdges+1)fail('native path length budget exceeded');if(n.parent===null)break;i=n.parent;}
  path.reverse();
  // Fresh path-only recheck, no stale search cache used as final observation.
  // Reads span slices: this remains a time-distributed PREVIEW, not atomic or
  // future movement permission. Driver would fresh-prove every actual segment.
  for(let pathIndex=0;pathIndex<path.length;pathIndex++){const p=path[pathIndex];
   for(let dy=0;dy<=2;dy++){const observed=yield* read({x:p.x,y:p.y+dy,z:p.z},true),expected=dy===0?p.id:dy===1?p.feetId:p.headId;if(observed!==expected)fail('path changed/unloaded during fresh loaded preview');}
   const next=path[pathIndex+1];if(next&&next.y===p.y+1&&(yield* read({x:p.x,y:p.y+3,z:p.z},true))!==next.riseFromHead)fail('rise headroom changed/unloaded during fresh preview');
  }
  current();maxReads=Math.max(maxReads,inSlice);
  return freeze({state:'OBSERVED_LOADED_PATH',index:endpoints.index,checksum:endpoints.checksum,home:endpoints.home,farm:endpoints.farm,
   waypoints:path.map(p=>({x:p.x+0.5,y:p.y+1,z:p.z+0.5,floor:{x:p.x,y:p.y,z:p.z,id:p.id}})),edges:path.slice(1).map((/** @type {any} */ p,/** @type {number} */ index)=>({deltaY:p.y-path[index].y,verticalMicrogateRequired:p.y!==path[index].y})),
   permission:false,verticalPermission:false,reads,maxReadsPerSlice:maxReads,maxAllowedPerSlice:L.readsPerSlice,totalReadCap:L.totalReads,yields,visited:closed.size,directedEdges:directed,unloaded,partialSurroundings:unloaded>0,reasons,samples,
   scope:'Time-distributed loaded point/edge observations only. No actor/footprint motion, step/hop physics, atomic world snapshot, work or resource credit proved. Fresh driver collision/identity proof required before any movement.'});
 }catch(error){return freeze({state:'REFUSED',reason:String(error),permission:false,verticalPermission:false,reads,maxReadsPerSlice:Math.max(maxReads,inSlice),unloaded,visited:closed.size,reasons,samples});}
}
/** @param {any} view */
export function formatLoadedWorkRoutePreview(view){return[
 `Saved work route preview: ${view.state}; ${view.reason??view.scope}`,
 `Native reads${view.reads}; max/slice${view.maxReadsPerSlice}/256; visited${view.visited??0}; unloaded${view.unloaded??0}; path edges${view.waypoints?view.waypoints.length-1:0}.`,
 ...(view.reasons?[`Search rejection counts (overlapping observations): footing${view.reasons.unknownFooting}; body${view.reasons.body}; rise headroom${view.reasons.headroom}; unloaded/unreadable${view.reasons.unloaded}.`]:[]),
 ...(view.samples?.length?[`Observed samples${view.samples.length}/8 (max2 per reason); examples, not proof of why the entire path was not found.`,...view.samples.slice(0,8).map((/** @type {any} */ s)=>`${s.kind} at ${key(s.point)}: observed ${s.observedId??'unavailable'}; expected ${s.expected}.`)]:[]),
 ...(view.waypoints?[`Home${view.home.id} lot${view.home.lotId}; farm${view.farm.id} lot${view.farm.lotId}; checksum${view.checksum}.`,...view.waypoints.slice(0,8).map((/** @type {any} */ p,/** @type {number} */ index)=>`point${index}: ${p.x},${p.y},${p.z}; floor${p.floor.id}`),...(view.waypoints.length>8?[`Showing8/${view.waypoints.length} observed points; no movement permission.`]:[])]:[]),
 'Read-only: no blocks, properties, entities, impulses, teleports, chunk holds, timer or production changed. Vertical stepping remains a separate native microgate.'
];}
