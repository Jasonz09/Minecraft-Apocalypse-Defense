import {SITE_STAGES,siteOpsFor} from "./districtplan.js";
import {BLUEPRINTS2} from "../structures/blueprints2.js";
export const ROOM_PREVIEW_GEOMETRY="chapel-room-census-v1";
export const ROOM_PREVIEW_LIMITS=Object.freeze({cells:1024,readsPerSlice:256,rowsPerPage:32,sourceOps:250000,sourceOpsPerSlice:400,stateKeys:32,stateChars:2048});
class RoomPreviewRefused extends Error {}
/** @param {any} ctx */
function current(ctx){if(ctx.cancelled?.()||ctx.current()!==true||ctx.cancelled?.())throw new RoomPreviewRefused("Room census cancelled or source/player/dimension changed; no result accepted.");}
/** Every native property/method/state getter is bracketed; no references escape a cell read.
 * @param {()=>any} getter @param {any} ctx */
function native(getter,ctx){current(ctx);let value,error,failed=false;try{value=getter();}catch(e){failed=true;error=e;}current(ctx);if(failed)throw error;return value;}
/** @param {any} raw @param {any} ctx */
function primitiveStates(raw,ctx){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("full states unavailable");
 const keys=native(()=>Object.keys(raw),ctx).sort();if(keys.length>ROOM_PREVIEW_LIMITS.stateKeys)throw Error("state key cap exceeded");
 /** @type {Record<string,string|number|boolean>} */const out={};
 for(const k of keys){if(!/^[a-z0-9_:.-]{1,64}$/.test(k))throw Error("invalid state key");const v=native(()=>raw[k],ctx);if(!(typeof v==="boolean"||(typeof v==="number"&&Number.isFinite(v))||(typeof v==="string"&&v.length<=128)))throw Error("nonprimitive/oversize state");Object.defineProperty(out,k,{value:v,enumerable:true});}
 if(JSON.stringify(out).length>ROOM_PREVIEW_LIMITS.stateChars)throw Error("full states character cap exceeded");return out;
}
/** @param {{x:number,y:number,z:number}} p @param {any} ctx */
function snapshot(p,ctx){
 try{const block=native(()=>ctx.getBlock({...p}),ctx);if(!block)return{status:"unloaded",id:null,states:null,reason:"getBlock returned no block"};
  if(native(()=>block.isValid,ctx)===false)return{status:"unreadable",id:null,states:null,reason:"block invalid"};
  const id=native(()=>block.typeId,ctx);if(typeof id!=="string"||!/^[a-z0-9_.-]+:[a-z0-9_./-]{1,128}$/.test(id))throw Error("block ID unavailable");
  const permutation=native(()=>block.permutation,ctx);if(!permutation)throw Error("permutation unavailable");
  const method=native(()=>permutation.getAllStates,ctx);if(typeof method!=="function")throw Error("full state getter unavailable");
  const states=primitiveStates(native(()=>method.call(permutation),ctx),ctx);current(ctx);return{status:"loaded",id,states,reason:null};
 }catch(e){if(e instanceof RoomPreviewRefused)throw e;current(ctx);return{status:"unreadable",id:null,states:null,reason:String(e instanceof Error?e.message:"native snapshot unavailable").slice(0,160)};}
}
/** Geometry is an explicit READONLY census envelope, never old-plan AIR/write authority.
 * @param {any} record @param {string} building @returns {{element:any,points:{x:number,y:number,z:number,tags:string[]}[],roomCells:number}} */
export function roomPreviewGeometry(record,building){
 if(!record||typeof record.checksum!=="string"||!Array.isArray(record.lots)||record.lots.length>8192)throw Error("verified saved room source required");
 const matches=record.lots.filter((/** @type {any} */e)=>e.id===building);if(matches.length!==1)throw Error("room building missing or duplicate");const e=matches[0],b=e.bbox,bp=BLUEPRINTS2.chapel_v2;
 if(e.blueprint!=="chapel_v2"||e.kind!=="building-chapel"||e.stage!=="lots"||!Number.isInteger(e.rot)||e.rot<0||e.rot>3||!Number.isInteger(e.baseY)||!b)throw Error("only verified chapel_v2 room geometry is supported");
 if(bp.version!==2||JSON.stringify(bp.size)!=="[9,14,15]")throw Error("supported chapel blueprint version/dimensions changed");
 const width=e.rot%2?bp.size[2]:bp.size[0],depth=e.rot%2?bp.size[0]:bp.size[2];
 if(![b.x0,b.x1,b.z0,b.z1].every(Number.isSafeInteger)||b.x1-b.x0+1!==width||b.z1-b.z0+1!==depth||Math.max(Math.abs(b.x0),Math.abs(b.x1),Math.abs(b.z0),Math.abs(b.z1))>30000000||e.baseY+1< -64||e.baseY+5>319)throw Error("room dimensions/height do not match supported blueprint");
 /** @type {{x:number,y:number,z:number,tags:string[]}[]} */const points=[];
 for(let y=e.baseY+1;y<=e.baseY+5;y++)for(let z=b.z0+1;z<b.z1;z++)for(let x=b.x0+1;x<b.x1;x++)points.push({x,y,z,tags:["room"]});const roomCells=points.length;
 for(const x of[b.x0,b.x1])for(const z of[b.z0,b.z1])for(let y=e.baseY+1;y<=e.baseY+5;y++)points.push({x,y,z,tags:["corner-post"]});
 if(points.length>ROOM_PREVIEW_LIMITS.cells||new Set(points.map(p=>`${p.x},${p.y},${p.z}`)).size!==points.length)throw Error("room census cell cap/duplicate refused");return{element:e,points,roomCells};
}
/** No mutation, lease, timer or retained native handle. Caller verifies actual saved source first.
 * @param {any} record @param {string} building @param {{current:()=>boolean,cancelled?:()=>boolean,getBlock:(p:{x:number,y:number,z:number})=>any,opsFor?:typeof siteOpsFor}} ctx */
export function* roomVegetationPreviewSteps(record,building,ctx){
 current(ctx);const geometry=roomPreviewGeometry(record,building),key=(/** @type {any} */p)=>`${p.x},${p.y},${p.z}`,wanted=new Map(geometry.points.map(p=>[key(p),p]));
 /** @type {Map<string,{id:string,states:any,stage:string,element:string}>} */const final=new Map();let sourceOps=0,compiled=0;
 for(const stage of SITE_STAGES){if(!Array.isArray(record[stage]))throw Error("verified room source stage missing");for(let i=0;i<record[stage].length;i++)for(const op of(ctx.opsFor??siteOpsFor)(record,stage,i)){
  if(++sourceOps>ROOM_PREVIEW_LIMITS.sourceOps)throw Error("room source operation cap exceeded");
  const point=wanted.get(key(op));if(point){final.set(key(op),{id:op.id,states:op.states===undefined?null:JSON.parse(JSON.stringify(op.states)),stage,element:record[stage][i].id});if(stage==="lots"&&record[stage][i].id===building){if(op.id==="minecraft:lectern"&&!point.tags.includes("lectern"))point.tags.push("lectern");if(op.id==="minecraft:lantern"&&!point.tags.includes("fixture-lamp"))point.tags.push("fixture-lamp");}}
  if(++compiled>=ROOM_PREVIEW_LIMITS.sourceOpsPerSlice){current(ctx);yield;current(ctx);compiled=0;}
 }}
 for(const point of geometry.points)if(point.tags.includes("fixture-lamp")){const anchor=wanted.get(key({...point,y:point.y+(final.get(key(point))?.states?.hanging===true?1:-1)}));if(anchor&&!anchor.tags.includes("fixture-anchor"))anchor.tags.push("fixture-anchor");}
 /** @type {any[]} */const rows=[];let sliceReads=0,totalReads=0,loaded=0,unloaded=0,unreadable=0,obstructions=0;
 for(const point of geometry.points){if(sliceReads>=ROOM_PREVIEW_LIMITS.readsPerSlice){current(ctx);yield;current(ctx);sliceReads=0;}current(ctx);sliceReads++;totalReads++;
  const observed=snapshot(point,ctx),expected=final.get(key(point))??null;let classification=observed.status;
  if(observed.status==="loaded"){loaded++;if(observed.id==="minecraft:air"&&(!expected||expected.id==="minecraft:air"))classification="air";else if(expected&&observed.id===expected.id&&(expected.states===null||Object.entries(expected.states).every(([k,v])=>observed.states?.[k]===v)))classification="planned-ID/explicit-state-match";else{classification="source-discrepancy";obstructions++;}}
  else if(observed.status==="unloaded")unloaded++;else unreadable++;
  rows.push({x:point.x,y:point.y,z:point.z,tags:[...point.tags],classification,observed,expected});
  current(ctx);yield;current(ctx);sliceReads=0;
 }
 current(ctx);return{geometryVersion:ROOM_PREVIEW_GEOMETRY,building,checksum:record.checksum,blueprint:"chapel_v2",roomCells:geometry.roomCells,totalCells:geometry.points.length,reads:totalReads,loaded,unloaded,unreadable,obstructions,complete:unloaded===0&&unreadable===0,sourceOps,rows,scope:"Read-only room census across cooperative ticks, not atomic. No engine timestamp sampled or persistent paging cache; each command/page rereads; separate commands/pages are NOT the same snapshot. District-only expected ops, no cross-district ownership or AIR/cleanup permission; no writes."};
}
/** Pure bounded stored-result pagination. @param {any} view @param {number} [page] */
export function formatRoomVegetationPreview(view,page=1){
 if(!Number.isSafeInteger(page)||page<1||page>999)throw Error("invalid room preview page");
 const priority=(/** @type {any} */r)=>r.classification==="source-discrepancy"?(/^minecraft:(?:[a-z_]+_log|log2?)$/.test(r.observed.id??"")?0:/_leaves(?:_flowered)?$|:leaves2?$/.test(r.observed.id??"")?1:2):(r.observed.status!=="loaded"?2:3);
 const rows=view.rows.filter((/** @type {any} */r)=>r.classification!=="air"||r.tags.some((/** @type {string} */t)=>t!=="room")).sort((/** @type {any} */a,/** @type {any} */b)=>priority(a)-priority(b)||a.y-b.y||a.x-b.x||a.z-b.z),pages=Math.max(1,Math.ceil(rows.length/ROOM_PREVIEW_LIMITS.rowsPerPage));
 const selected=rows.slice((page-1)*ROOM_PREVIEW_LIMITS.rowsPerPage,page*ROOM_PREVIEW_LIMITS.rowsPerPage);
 return[`Room census ${view.building}; source ${view.checksum}; ${view.complete?"loaded snapshot":"INCOMPLETE"}.`,`Cells ${view.totalCells} (${view.roomCells} room + corner samples); reads ${view.reads}; loaded ${view.loaded}; unloaded ${view.unloaded}; unreadable ${view.unreadable}; source discrepancies ${view.obstructions}.`,`Non-air/typed/unreadable rows page ${page}/${pages}; ${selected.length} shown, limit32.`,...selected.map((/** @type {any} */r)=>`${r.x},${r.y},${r.z} [${r.tags.join(",")}] ${r.classification}; live=${r.observed.id??"UNKNOWN"} fullStates=${r.observed.states===null?"UNKNOWN":JSON.stringify(r.observed.states)}; saved=${r.expected?.id??"no district op"}${r.observed.reason?"; "+r.observed.reason:""}.`),view.scope];
}
