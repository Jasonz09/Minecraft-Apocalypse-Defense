// @ts-check
import {parseGroupId} from "./groups.js";
import {createRoleBudget} from "./roleBudget.js";
/** Capacity is reserved for BOTH components until the full generation is terminal.
 * Missing loaded actors do not release a reservation. Metadata was authenticated by the store.
 * @param {any[]} rows @returns {{groupId:string,district:string,cost:2}[]} */
export function compoundReservations(rows){
 if(!Array.isArray(rows)||rows.length>24)throw Error("compound reservation cap");
 const seen=new Set();return rows.map(r=>{const g=parseGroupId(r?.group);if(!g||g.kind!=="sol"||seen.has(r.group)||r.kind!=="compound"||!Number.isSafeInteger(r.generation)||r.generation<1||typeof r.epoch!=="string"||!r.epoch)throw Error("invalid compound reservation");seen.add(r.group);for(const role of ["rider","mount"]){const m=r[role];if(!m||!["never","pending","alive","removing","terminal","cancelled"].includes(m.phase))throw Error("invalid reserved role");}return{r,g};}).filter(({r})=>![r.rider,r.mount].every(m=>["terminal","cancelled"].includes(m.phase))).map(({r,g})=>({groupId:r.group,district:g.district,cost:/** @type {2} */(2)}));
}
/** Read-only role scheduling. A pending role means outcome unknown, never absence-retry.
 * Returned jobs do not authorize native creation; actual owner must first prove BOTH body clearances.
 * @param {any[]} rows @param {string[]} admitted @param {{tick:number|null,ops:number,spawns:number}} prior
 * @param {number} tick @param {{maxOpsPerTick:number,maxSpawnsPerTick:number}} config */
export function planCompoundCompletion(rows,admitted,prior,tick,config){
 compoundReservations(rows);if(!Array.isArray(admitted)||admitted.length>24||new Set(admitted).size!==admitted.length)throw Error("invalid compound admission");
 const budget=createRoleBudget(prior,tick,config),jobs=[],held=[];
 for(const r of [...rows].sort((a,b)=>a.group<b.group?-1:a.group>b.group?1:0)){
  if(!admitted.includes(r.group))continue;
  if([r.rider,r.mount].some(m=>["pending","removing","terminal","cancelled"].includes(m.phase))){held.push(r.group+": unresolved/terminal role requires maintenance");continue;}
  const role=r.rider.phase==="never"?"rider":r.mount.phase==="never"?"mount":null;
  if(!role)continue;
  if(!budget.reserve("spawn")){held.push(r.group+": role spawn budget pending");continue;}
  jobs.push({groupId:r.group,role,epoch:r.epoch,generation:r.generation,type:r[role].type,expected:JSON.stringify(r),tick});
 }
 return{jobs,held,budget:budget.status(),nativeBirthEnabled:false};
}
