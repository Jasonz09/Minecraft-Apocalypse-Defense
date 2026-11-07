import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {SITE_STAGES} from "../../CivilizationApocalypse_BP/scripts/civ/districtplan.js";
import * as core from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js";
import {compilePendingLeafSourcesSteps} from "../../CivilizationApocalypse_BP/scripts/civ/leafSourceStreaming.js";
const run=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
function fixture(){
 const pos={x:0,y:70,z:0},mk=(index,checksum)=>({districtIndex:index,checksum,...Object.fromEntries(SITE_STAGES.map(stage=>[stage,[]]))});
 const a=mk(4,"35635162"),b=mk(5,"23a6aeca");
 a.walls=[{id:"wall",ops:[{...pos,id:"minecraft:stone_bricks",kind:"wall"}]}];
 b.walls=[{id:"support",ops:[{x:0,y:69,z:0,id:"minecraft:cobblestone",kind:"wall"}]}];
 const sources=[a,b].map(record=>({record,civ:{status:"complete",checksum:record.checksum,dimension:"minecraft:overworld"},masterHash:"9e5e307e"}));
 const input={index:4,checksum:a.checksum,masterHash:"9e5e307e",dimension:"minecraft:overworld",candidates:[pos],sources};
 const compilerDependencies={opsFor:(r,stage,i)=>r[stage][i].ops},plan=core.compileLeafTrim(input,compilerDependencies);
 let raw,okay=true,cancelled=false,loads=0,active=0,maximum=0;
 const io={load:()=>raw,save:r=>{raw=r;}},ctx={sourcesCurrent:()=>okay,isProtected:()=>false,read:p=>({isValid:true,typeId:p.x===0&&p.y===70&&p.z===0?"minecraft:oak_leaves":"minecraft:air",states:p.x===0&&p.y===70&&p.z===0?{persistent_bit:false,update_bit:false}:{} }),write(){assert.fail("compiler must never write");}};
 core.prepareLeafTrim(plan,ctx,io,{policy:core.POLICY});
 const streamInput={...input,policy:core.POLICY,sources:sources.map(s=>({index:s.record.districtIndex,checksum:s.record.checksum,status:s.civ.status,dimension:s.civ.dimension}))};
 const deps={sourcesCurrent:()=>okay,cancelled:()=>cancelled,receiptStore:io,compilerDependencies,*loadSourceSteps(index){loads++;active++;maximum=Math.max(maximum,active);try{yield;const source=sources.find(s=>s.record.districtIndex===index);return{ok:true,queue:{state:"complete"},plan:{same:"master"},record:source.record};}finally{active--;}}};
 return{input,sources,plan,streamInput,deps,io,ctx,compilerDependencies,get loads(){return loads;},get maximum(){return maximum;},get raw(){return raw;},set raw(v){raw=v;},set okay(v){okay=v;},set cancel(v){cancelled=v;}};
}
test("public batch and sequential source compiler share exact body, history and source ordering",()=>{
 const f=fixture(),before=f.raw,actual=run(compilePendingLeafSourcesSteps(f.streamInput,f.deps));assert.deepEqual(actual,f.plan);assert.equal(f.raw,before);assert.equal(f.loads,2);assert.equal(f.maximum,1);
 const t=core.createLeafTrimAccumulator(f.input);for(const source of [...f.sources].reverse())run(core.accumulateLeafSourceSteps(t,source,f.compilerDependencies));assert.deepEqual(core.finishLeafTrimAccumulator(t),f.plan);
});
test("incomplete, foreign, duplicate and cancelled accumulators cannot finalize",()=>{
 const f=fixture(),t=core.createLeafTrimAccumulator(f.input);assert.throws(()=>core.finishLeafTrimAccumulator(t),/all verified/);run(core.accumulateLeafSourceSteps(t,f.sources[0],f.compilerDependencies));assert.throws(()=>core.finishLeafTrimAccumulator(t),/all verified/);
 assert.throws(()=>core.finishLeafTrimAccumulator({}),/foreign/);assert.throws(()=>run(core.accumulateLeafSourceSteps(t,f.sources[0],f.compilerDependencies)),/ambiguous/);
 const g=fixture();g.sources[0].record.walls[0].ops.push(...Array.from({length:500},(_,i)=>({x:100+i,y:70,z:0,id:"minecraft:air"})));
 const token=core.createLeafTrimAccumulator(g.input),pending=core.accumulateLeafSourceSteps(token,g.sources[0],g.compilerDependencies);assert.equal(pending.next().done,false);pending.return();assert.throws(()=>core.finishLeafTrimAccumulator(token),/foreign/);
});
test("source, receipt and cancellation faults across loader yields stop before next source",()=>{
 for(const fault of ["source","receipt","cancel"]){const f=fixture(),before=f.raw,g=compilePendingLeafSourcesSteps(f.streamInput,f.deps);assert.equal(g.next().done,false);if(fault==="source")f.okay=false;if(fault==="receipt")f.raw=before+" ";if(fault==="cancel")f.cancel=true;assert.throws(()=>g.next(),/guard refused/);assert.equal(f.loads,1);if(fault!=="receipt")assert.equal(f.raw,before);}
});
test("absent or complete receipt explicitly refuses instead of omitting no-pending wall census",()=>{
 for(const value of [undefined,JSON.stringify({...JSON.parse(fixture().raw),complete:true,entries:JSON.parse(fixture().raw).entries.map(e=>({...e,done:true}))})]){const f=fixture();f.raw=value;assert.throws(()=>run(compilePendingLeafSourcesSteps(f.streamInput,f.deps)),/pending/i);assert.equal(f.loads,0);}
});
test("late AIR, historical decoration and neighboring foreign final claims remain in shared summaries",()=>{
 for(const variant of ["air","historical","foreign"]){const f=fixture(),b=f.sources[1].record;
 if(variant==="air")b.dressing=[{id:"late",ops:[{x:0,y:70,z:0,id:"minecraft:air"}]}];
 if(variant==="historical")b.lots=[{id:"decor",ops:[{x:0,y:70,z:0,id:"minecraft:oak_leaves"},{x:0,y:70,z:0,id:"minecraft:stone_bricks",kind:"wall"}]}];
 if(variant==="foreign")b.dressing=[{id:"foreign",ops:[{x:1,y:70,z:0,id:"minecraft:chest"}]}];
 const batch=core.compileLeafTrim(f.input,f.compilerDependencies),t=core.createLeafTrimAccumulator(f.input);for(const source of f.sources)run(core.accumulateLeafSourceSteps(t,source,f.compilerDependencies));assert.deepEqual(core.finishLeafTrimAccumulator(t),batch);
 if(variant!=="foreign")assert.equal(batch.refused.length,1);else assert.deepEqual(batch.proposals[0].contacts.find(c=>c.point.x===1&&c.point.y===70&&c.point.z===0).expected,[]);
 }
});

test("shared assembly stays byte-exact with frozen production golden plans including refused candidate metadata",()=>{
 const golden=JSON.parse(readFileSync(new URL("../fixtures/leaf-source-streaming-compiler-golden.json",import.meta.url),"utf8"));
 for(const name of Object.keys(golden.cases)){const f=fixture();
 if(name==="candidate-metadata-refusal"){f.input.candidates[0]={...f.input.candidates[0],id:"minecraft:stone_bricks",label:"original-refusal-metadata"};f.sources[0].record.dressing=[{id:"late",ops:[{x:0,y:70,z:0,id:"minecraft:air"}]}];}
 if(name==="historical")f.sources[1].record.lots=[{id:"decor",ops:[{x:0,y:70,z:0,id:"minecraft:oak_leaves"},{x:0,y:70,z:0,id:"minecraft:stone_bricks",kind:"wall"}]}];
 assert.deepEqual(core.compileLeafTrim(f.input,f.compilerDependencies),golden.cases[name]);
 }
});
test("source metadata change or throwing op iterator invalidates a partial accumulator",()=>{
 for(const mode of ["metadata","throw"]){const f=fixture();f.sources[0].record.walls[0].ops.push(...Array.from({length:500},(_,i)=>({x:100+i,y:70,z:0,id:"minecraft:air"})));
 const token=core.createLeafTrimAccumulator(f.input),pending=core.accumulateLeafSourceSteps(token,f.sources[0],f.compilerDependencies);pending.next();
 if(mode==="metadata"){f.sources[0].record.checksum="00000000";assert.throws(()=>run(pending),/identity changed/);}else assert.throws(()=>pending.throw(Error("iterator fault")),/iterator fault/);
 assert.throws(()=>core.finishLeafTrimAccumulator(token),/foreign/);
 }
});
