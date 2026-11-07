import test from 'node:test';
import assert from 'node:assert/strict';
import {validFullPlan} from '../../lib/civfixture.mjs';
import {makeField} from '../../lib/fakefield.mjs';
import {planDistrictSite} from '../../../CivilizationApocalypse_BP/scripts/civ/districtplan.js';
import {savedDestinationsSteps,destinationProofIsCurrent} from './scripts/people/destinations.js';
import {inspectSavedFrontage,parseFrontageCommand,formatFrontageInspection,FRONTAGE_LIMITS} from './scripts/people/frontage.js';
import {createCivilianDestinations} from './scripts/integration/civilianDestinations.js';
const finish=g=>{for(;;){const step=g.next();if(step.done)return step.value;}};
// One small real production layout, not a duplicate full planner suite.
const site=planDistrictSite(validFullPlan(1),1,makeField(3,{relief:0,forest:0,river:null}));assert.equal(site.ok,true);
const record=site.record,expected={index:1,checksum:record.checksum},compile=()=>finish(savedDestinationsSteps(record,expected));
const compiled=compile(),chosen=compiled.candidates.find(c=>c.role==='home'&&c.frontageFeet);assert.ok(chosen);
const lot=()=>record.lots.find(e=>e.id===chosen.id);
function context(change){
 const state={reads:[],fresh:true,writes:0};
 const ctx={fresh:()=>state.fresh,read:p=>{state.reads.push({...p});change?.(p,state);
  return {isValid:true,typeId:p.y===chosen.frontageSurface.y?chosen.frontageSurface.id:'minecraft:air',setPermutation(){state.writes++;throw Error('not allowed');}};}};
 return {state,ctx};
}
test('exact real saved frontage verifies3cells with checksum/building/lot provenance and no writes',()=>{
 const f=context(),view=inspectSavedFrontage(compiled,chosen.id,f.ctx);
 assert.equal(view.state,'verified');assert.equal(view.reads,3);assert.equal(view.lotId,chosen.lotId);assert.equal(view.checksum,record.checksum);assert.deepEqual(view.point,chosen.frontageFeet);
 assert.deepEqual(f.state.reads,[{x:chosen.frontageSurface.x,y:chosen.frontageSurface.y,z:chosen.frontageSurface.z},{...chosen.frontageFeet},{...chosen.frontageFeet,y:chosen.frontageFeet.y+1}]);
 assert.equal(f.state.writes,0);assert.equal(view.entityChanges,0);assert.match(formatFrontageInspection(view).join('\n'),/route, doorway access and future clearance unverified/);
});
test('only compiler-owned results can authorize a read; JSON or prototype clones cannot',()=>{
 for(const copy of [structuredClone(compiled),Object.create(compiled),undefined]){const f=context();assert.equal(inspectSavedFrontage(copy,chosen.id,f.ctx).state,'refused');assert.equal(f.state.reads.length,0);}
});
test('missing exact candidate refuses before native reads',()=>{const f=context();assert.equal(inspectSavedFrontage(compiled,'building-missing',f.ctx).state,'refused');assert.equal(f.state.reads.length,0);});
test('ambiguous saved candidate identity cannot compile or reach native access',()=>{const e=lot();record.lots.push({...e});try{assert.throws(compile,/duplicate/);}finally{record.lots.pop();}});
test('missing planned frontage height stays unresolved rather than guessed',()=>{
 const e=lot(),before=e.frontage;e.frontage={...before,x:before.x+1000};
 try{const changed=compile(),f=context(),view=inspectSavedFrontage(changed,chosen.id,f.ctx);assert.equal(view.state,'refused');assert.match(view.reason,/unresolved/);assert.equal(f.state.reads.length,0);}finally{e.frontage=before;}
});
test('record mutation after compilation rejects before any native reads',()=>{
 const e=lot(),before=e.lot;e.lot='different-household';try{const f=context();assert.equal(destinationProofIsCurrent(compiled),false);assert.equal(inspectSavedFrontage(compiled,chosen.id,f.ctx).state,'refused');assert.equal(f.state.reads.length,0);}finally{e.lot=before;}
});
test('source change across compiler yields publishes no native-read proof',()=>{
 const e=lot(),before=e.lot,g=savedDestinationsSteps(record,expected);assert.equal(g.next().done,false);
 e.lot='changed-between-yields';try{assert.throws(()=>finish(g),/changed during/);}finally{e.lot=before;}
});
test('record mutation from the fresh-context callback is checked before native access',()=>{
 const e=lot(),before=e.lot,f=context();f.ctx.fresh=()=>{e.lot='changed-inside-fresh-check';return true;};try{assert.equal(inspectSavedFrontage(compiled,chosen.id,f.ctx).state,'refused');assert.equal(f.state.reads.length,0);}finally{e.lot=before;}
});
for(const n of [1,2,3])test(`metadata change at native read${n} invalidates whole report`,()=>{
 const e=lot(),before=e.frontage,f=context((p,s)=>{if(s.reads.length===n)e.frontage={...before,x:before.x+1};});
 try{const view=inspectSavedFrontage(compiled,chosen.id,f.ctx);assert.equal(view.state,'refused');assert.equal(view.reads,n);}finally{e.frontage=before;}
});
for(const n of [1,2,3])test(`native missing/invalid/throw at sampled cell${n} is unloaded, never AIR`,()=>{
 for(const kind of ['missing','invalid','throw']){const f=context(),read=f.ctx.read;let calls=0;f.ctx.read=p=>{calls++;if(calls===n){if(kind==='throw')throw Error('unloaded');if(kind==='invalid')return {isValid:false,typeId:'minecraft:air'};return undefined;}return read(p);};const view=inspectSavedFrontage(compiled,chosen.id,f.ctx);assert.equal(view.state,'unloaded');assert.equal(view.reads,n);assert.ok(view.reads<=FRONTAGE_LIMITS.blockReads);}
});
for(const id of ['minecraft:water','minecraft:lava','minecraft:oak_slab','minecraft:oak_stairs','minecraft:short_grass','minecraft:fern','minecraft:unknown'])test(`floor ${id} cannot replace the exact planned full road block`,()=>{
 const f=context();f.ctx.read=()=>({isValid:true,typeId:id});const view=inspectSavedFrontage(compiled,chosen.id,f.ctx);assert.equal(view.state,'blocked');assert.equal(view.reads,1);
});
for(const id of ['minecraft:wooden_door','minecraft:fence_gate','minecraft:wheat','minecraft:short_grass','minecraft:fern','minecraft:water','minecraft:lava','minecraft:unknown'])test(`body ${id} remains blocked; separate flora proposal is not imported`,()=>{
 const f=context(),read=f.ctx.read;f.ctx.read=p=>p.y===chosen.frontageFeet.y?{isValid:true,typeId:id}:read(p);const view=inspectSavedFrontage(compiled,chosen.id,f.ctx);assert.equal(view.state,'blocked');assert.equal(view.reads,2);
});
test('head obstruction is reported after3reads',()=>{const f=context(),read=f.ctx.read;f.ctx.read=p=>p.y===chosen.frontageFeet.y+1?{isValid:true,typeId:'minecraft:stone'}:read(p);assert.equal(inspectSavedFrontage(compiled,chosen.id,f.ctx).state,'blocked');});
test('cancellation/native context invalidation at last getter refuses verified report',()=>{const f=context((p,s)=>{if(s.reads.length===3)s.fresh=false;});assert.equal(inspectSavedFrontage(compiled,chosen.id,f.ctx).state,'refused');assert.equal(f.state.reads.length,3);});
test('strict command parser rejects ambiguous options and out-of-range identities',()=>{
 assert.deepEqual(parseFrontageCommand(`inspect district=1 building=${chosen.id}`),{index:1,building:chosen.id});
 for(const text of ['inspect district=0 building=x','inspect district=1 building=x building=y','inspect district=1 building=../x','inspect district=1 building='+'x'.repeat(97),'inspect district=1 building=x page=1'])assert.ok(parseFrontageCommand(text).error);
});
function runtime(change){
 const state={civ:{status:'complete',stage:'complete',checksum:record.checksum,dimension:'minecraft:overworld',ops:58810,opsTotal:58810},reads:0,finished:0,token:{cancelled:false}};
 const player={typeId:'minecraft:player',isValid:true,dimension:{id:'minecraft:overworld',getBlock:p=>{state.reads++;change?.(state,player);return {isValid:true,typeId:p.y===chosen.frontageSurface.y?chosen.frontageSurface.id:'minecraft:air'};}}};
 const driver=createCivilianDestinations({readKingdom:()=>({districts:[{id:'district-1',civ:state.civ}]}),loadSaved:function*(){return{ok:true,district:1,record,queue:{state:'complete',planHash:record.checksum}};},runJob:async(token,g)=>finish(g),reserveJob:()=>state.token,finishJob:()=>{state.finished++;}});
 return {state,player,driver};
}
test('existing async command route reaches native inspection and releases its job',async()=>{const f=runtime();const lines=await f.driver.command(`inspect district=1 building=${chosen.id}`,{sourceEntity:f.player});assert.match(lines[0],/VERIFIED/);assert.equal(f.state.reads,3);assert.equal(f.state.finished,1);});
test('ordinary preview still performs zero native block reads',async()=>{const f=runtime();assert.match((await f.driver.command('district=1 page=1',{sourceEntity:f.player}))[0],/Saved civilian destinations/);assert.equal(f.state.reads,0);assert.equal(f.state.finished,1);});
for(const kind of ['checksum','dimension','cancel'])test(`native getter changing ${kind} is refused by integration and job is released`,async()=>{
 const f=runtime((s,p)=>{if(kind==='checksum')s.civ={...s.civ,checksum:'deadbeef'};if(kind==='dimension')p.dimension.id='minecraft:nether';if(kind==='cancel')s.token.cancelled=true;});
 const lines=await f.driver.command(`inspect district=1 building=${chosen.id}`,{sourceEntity:f.player});assert.match(lines[0],/REFUSED/);assert.equal(f.state.reads,1);assert.equal(f.state.finished,1);
});
