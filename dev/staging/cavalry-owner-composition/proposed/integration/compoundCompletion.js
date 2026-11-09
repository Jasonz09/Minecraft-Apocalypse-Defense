// @ts-check
import {planCompoundCompletion} from "../population/compoundPlanning.js";
import {createRoleBudget} from "../population/roleBudget.js";
import {decodeCursor,encodeCursor,cursorBytes} from "../population/cursor.js";
import {POP_CURSOR_KEY,POP_CURSOR_MAX_BYTES} from "../population/settings.js";
/** Metadata-only same-owner helper. It NEVER spawns, seats, removes or queries an actor.
 * Even its private ticket is not native clearance. Future owner must provide fresh two-body proof.
 * @param {any} world @param {any} core @param {any} config
 * @param {{currentAllowed:(groupId:string)=>boolean}} deps */
export function createCompoundCompletion(world,core,config,deps){
 const jobs=new WeakMap();let busy=false;
 /** @param {()=>any} fn */function enter(fn){if(busy)throw Error("compound completion reentry");busy=true;try{return fn();}finally{busy=false;}}
 function cursor(){const raw=world.getDynamicProperty(POP_CURSOR_KEY),decoded=decodeCursor(raw);if(decoded.status!=="ok")throw Error("compound completion requires valid quota cursor");return{raw,state:decoded.state};}
 /** @param {string[]} admitted @param {number} tick */function plan(admitted,tick){return enter(()=>{const c=cursor(),rows=core.listCompounds(),p=planCompoundCompletion(rows,admitted,c.state,tick,config);return{...p,jobs:p.jobs.map(j=>{const job=Object.freeze({...j});jobs.set(job,{expected:j.expected,tick,group:j.groupId,role:j.role});return job;})};});}
 /** Prepay one role attempt durably, then mark its exact NEVER role PENDING before any future native spawn.
  * A crash between these phases costs quota; it never implies that an actor was created or absent.
  * @param {any} job @param {number} tick */function prepare(job,tick){return enter(()=>{const privateJob=jobs.get(job);jobs.delete(job);if(!privateJob||privateJob.tick!==tick)throw Error("unknown/stale completion job");const c=cursor(),r=core.inspect(privateJob.group);if(JSON.stringify(r)!==privateJob.expected||!deps.currentAllowed(privateJob.group))throw Error("compound completion identity/admission changed");const b=createRoleBudget(c.state,tick,config);if(!b.reserve("spawn"))throw Error("compound completion quota exhausted");const next={...c.state,tick,...b.status()},raw=encodeCursor(next);if(cursorBytes(next)>POP_CURSOR_MAX_BYTES||world.getDynamicProperty(POP_CURSOR_KEY)!==c.raw)throw Error("compound completion cursor changed");world.setDynamicProperty(POP_CURSOR_KEY,raw);if(world.getDynamicProperty(POP_CURSOR_KEY)!==raw)throw Error("compound completion quota readback failed");if(!deps.currentAllowed(privateJob.group)||JSON.stringify(core.inspect(privateJob.group))!==privateJob.expected||world.getDynamicProperty(POP_CURSOR_KEY)!==raw)throw Error("compound completion changed after quota; preserved");const ticket=core.prepareRole(privateJob.group,privateJob.role,privateJob.expected);if(!deps.currentAllowed(privateJob.group)||world.getDynamicProperty(POP_CURSOR_KEY)!==raw)throw Error("compound completion quota/admission revoked during pending intent; preserved");return ticket;});}
 return{plan,prepare,nativeBirthEnabled:false};
}
