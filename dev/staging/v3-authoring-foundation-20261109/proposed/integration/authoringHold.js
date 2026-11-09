// @ts-check
import {findValidationProblems} from '../kingdom/state.js';
import {buildStarterBaseline} from '../sim/starter.js';

/** Refusal-only authoring foundation. This module cannot establish freshness,
 * activate a store, arm a template, or authorize native writes.
 * The verified normal-source adapter does not exist yet; callers must NOT use
 * these pure DTO checks as a replacement for it.
 */

/** @param {any} value @returns {string} */
function stable(value){
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
 return JSON.stringify(value);
}

/** Check canonical simulation without resetting or normalizing saved state.
 * Geography is copied by the existing baseline helper; every remaining
 * simulation field must already match. A successful result is necessary only,
 * never a clean-starter or genesis certificate.
 * @param {{kingdom?:any,keys?:unknown,source?:any,activationRaw?:unknown,headerRaw?:unknown}} input */
export function preparedAuthoringProblems(input){
 const problems=[];
 const source=input.source;
 if(!source||source.kind!=='normal-authoring'||source.phase!=='held'||source.genuineGenesisReviewed!==true||typeof source.epoch!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(source.epoch))problems.push('reviewed held NORMAL authoring provenance is required; private fixtures are not eligible');
 const keys=input.keys;
 if(!Array.isArray(keys)||keys.length>4096||keys.some(k=>typeof k!=='string')||new Set(keys).size!==keys.length)problems.push('source census unreadable');
 else if(keys.some(k=>k.startsWith('civ:pop_bind:')&&k!=='civ:pop_bind:v3:meta'||k.startsWith('civ:creation_activation:')&&k!=='civ:creation_activation:v3'))problems.push('nonempty/orphan/foreign creation namespace must be preserved');
 else if(!keys.includes('civ:pop_bind:v3:meta')||!keys.includes('civ:creation_activation:v3'))problems.push('durable activation/header missing');
 try{
  if(typeof input.headerRaw!=='string'||input.headerRaw.length>8192)throw Error();
  const h=JSON.parse(input.headerRaw);
  const expected={v:3,epoch:source?.epoch,mode:'fresh',fixture:source?.fixture,dimension:'minecraft:overworld',chunks:[],issued:0,pending:null};
  if(typeof source?.fixture!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(source.fixture)||stable(h)!==stable(expected))throw Error();
 }catch{problems.push('exact never-issued v3 header required');}
 try{
  if(typeof input.activationRaw!=='string'||input.activationRaw.length>16384)throw Error();
  const a=JSON.parse(input.activationRaw);
  // Full receipt/profile validation remains the future native adapter's job.
  if(a.v!==3||a.bindingVersion!==3||a.phase!=='complete'||a.epoch!==source?.epoch||a.fixture!==source?.fixture)throw Error();
 }catch{problems.push('complete matching activation required');}
 const k=input.kingdom;
 if(findValidationProblems(k).length)problems.push('valid kingdom required');
 else{
  if(k.starter!==undefined)problems.push('already armed state is not an authoring source');
  const expected=buildStarterBaseline({current:k});delete expected.starter;
  if(stable(k)!==stable(expected))problems.push('simulation differs from canonical initial state; preserve it, never reset');
 }
 return problems;
}

/** Optional pre-step callback for the EXISTING simulation loop.
 * Enabled authoring always holds, even after complete activation. This callback
 * cannot release a world or enter public continuation. The future reviewed
 * handoff must select a different capability after its durable transition.
 * Defaults make no native reads and return no callback, preserving old wiring.
 * @param {{enabled?:boolean,readPrepared?:()=>any,onStatus?:(problems:string[])=>void}} [options] */
export function createAuthoringHold(options={}){
 if(options.enabled!==true)return undefined;
 return()=>{
  let problems;
  try{problems=typeof options.readPrepared==='function'?preparedAuthoringProblems(options.readPrepared()):['normal authoring source adapter is not configured'];}
  catch{problems=['authoring source unreadable; preserve and hold'];}
  try{options.onStatus?.(problems);}catch{/* Diagnostics cannot authorize a step. */}
  return false;
 };
}
