import assert from "node:assert/strict";
import test from "node:test";
import {SITE_STAGES} from "../../CivilizationApocalypse_BP/scripts/civ/districtplan.js";
import {compileLeafTrim,POLICY} from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js";
import {previewWallLeavesSteps,collectWallLeafCensusSteps,accumulateWallLeafPreviewSourceSteps,finishWallLeafPreviewSteps} from "../../CivilizationApocalypse_BP/scripts/civ/wallleafpreview.js";
import {compileFreshLeafSourcesSteps,prepareLeafSourceBatchSteps,consumePreparedLeafBatch} from "../../CivilizationApocalypse_BP/scripts/civ/leafSourceStreaming.js";
import {wallLeafRepairSteps} from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js";
const run=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
const key=p=>`${p.x},${p.y},${p.z}`;
function fixture(count=17){
 const a={districtIndex:4,checksum:"35635162",...Object.fromEntries(SITE_STAGES.map(s=>[s,[]]))};
 const b={districtIndex:5,checksum:"23a6aeca",...Object.fromEntries(SITE_STAGES.map(s=>[s,[]]))};
 a.walls=Array.from({length:count},(_,i)=>({id:`wall-${i}`,ops:[{x:i*5,y:70,z:0,id:"minecraft:stone_bricks",kind:"wall"}]}));
 const cells=new Map(a.walls.map(e=>[key(e.ops[0]),{isValid:true,typeId:"minecraft:oak_leaves",states:{old_leaf_type:"oak",persistent_bit:false,update_bit:false}}]));
 const unloaded=new Set(),protectedColumns=new Set(),loadOrder=[];
 let current=true,journals=true,cancelled=false;
 const read=p=>unloaded.has(key(p))?undefined:structuredClone(cells.get(key(p))??{isValid:true,typeId:"minecraft:air",states:{}});
 const isProtected=(x,z)=>protectedColumns.has(`${x},${z}`),opsFor=(r,s,i)=>r[s][i].ops;
 const sources=[a,b].map(record=>({index:record.districtIndex,checksum:record.checksum,status:"complete",dimension:"minecraft:overworld"}));
 const input={policy:POLICY,index:4,checksum:a.checksum,masterHash:"9e5e307e",dimension:"minecraft:overworld",sources};
 const deps={sourcesCurrent:()=>current,journalsCurrent:()=>journals,cancelled:()=>cancelled,read,isProtected,compilerDependencies:{opsFor},*loadSourceSteps(index){loadOrder.push(index);yield;return{ok:true,plan:{same:"master"},queue:{state:"complete"},record:index===4?a:b};}};
 return{a,b,cells,unloaded,protectedColumns,loadOrder,input,deps,read,isProtected,opsFor,set current(v){current=v;},set journals(v){journals=v;},set cancelled(v){cancelled=v;},
 batchPreview:()=>run(previewWallLeavesSteps({record:a,records:[a,b],read,isProtected,cancelled:()=>cancelled},{opsFor})),
 stream:()=>run(compileFreshLeafSourcesSteps(input,deps))};
}
test("fresh sequential survey exactly preserves ordered rows, all27 contacts, counts and strict plan",()=>{
 const f=fixture(),before=structuredClone([...f.cells]),expected=f.batchPreview(),actual=f.stream();
 assert.deepEqual(actual.survey,expected);assert.equal(actual.state,"preview");assert.equal(actual.plan.proposals.length,17);assert.deepEqual(f.loadOrder,[4,5]);assert.deepEqual([...f.cells],before);
 const sources=[f.a,f.b].map(record=>({record,civ:{status:"complete",checksum:record.checksum,dimension:"minecraft:overworld"},masterHash:f.input.masterHash}));
 assert.deepEqual(actual.plan,compileLeafTrim({...f.input,candidates:expected.rows.filter(r=>r.state==="eligible").map(r=>r.target),sources},{opsFor:f.opsFor}));
});
test("unloaded walls remain incomplete and refused logs, vines, persistent leaves and protected rows remain visible",()=>{
 const f=fixture(6);f.unloaded.add("25,70,0");
 f.cells.get("0,70,0").typeId="minecraft:oak_log";f.cells.get("5,70,0").typeId="minecraft:vine";f.cells.get("10,70,0").states.persistent_bit=true;f.protectedColumns.add("15,0");
 const actual=f.stream(),expected=f.batchPreview();assert.deepEqual(actual.survey,expected);assert.equal(actual.survey.unloaded,1);assert.equal(actual.survey.complete,false);assert.equal(actual.survey.tree,5);assert.equal(actual.survey.refused,4);assert.equal(actual.plan.proposals.length,1);assert.equal(actual.plan.requested[0].x,20);
});
test("more than64 observed tree targets cannot create a capped partial batch",()=>{
 const f=fixture(65),actual=f.stream();assert.equal(actual.plan,null);assert.equal(actual.survey.tree,65);assert.equal(actual.survey.rows.length,64);assert.equal(actual.survey.truncated,true);assert.match(actual.state,/no partial capped admission/);assert.deepEqual(f.loadOrder,[4,5]);
});
test("zero eligible candidates still verifies every source and preserves refusal and survey counts",()=>{
 const f=fixture(1);f.cells.get("0,70,0").states.persistent_bit=true;const actual=f.stream();assert.equal(actual.plan,null);assert.equal(actual.state,"no eligible loaded targets");assert.equal(actual.survey.refused,1);assert.deepEqual(f.loadOrder,[4,5]);
 const empty=fixture(0),result=empty.stream();assert.equal(result.plan,null);assert.equal(result.survey.targets,0);assert.deepEqual(empty.loadOrder,[4,5]);
});
test("partial census capability cannot classify before all neighbor contributions",()=>{
 const f=fixture(1),token=run(collectWallLeafCensusSteps(f.a,{read:f.read,isProtected:f.isProtected},{sourceCount:2,opsFor:f.opsFor}));
 assert.throws(()=>run(finishWallLeafPreviewSteps(token)),/incomplete/);run(accumulateWallLeafPreviewSourceSteps(token,f.a,0,{opsFor:f.opsFor}));assert.throws(()=>run(finishWallLeafPreviewSteps(token)),/incomplete/);run(accumulateWallLeafPreviewSourceSteps(token,f.b,1,{opsFor:f.opsFor}));assert.equal(run(finishWallLeafPreviewSteps(token)).eligible,1);
});
test("source, journal and cancellation changes across source loads stop before a partial result",()=>{
 for(const fault of ["current","journals","cancelled"]){const f=fixture(1),g=compileFreshLeafSourcesSteps(f.input,f.deps);g.next();f[fault]=fault==="cancelled";assert.throws(()=>g.next(),/guard refused/);assert.deepEqual(f.loadOrder,[4]);}
});
test("historical decor from a later source vetoes first-source leaves even after AIR overwrite",()=>{
 const f=fixture(1);f.b.lots=[{id:"old",ops:[{x:1,y:70,z:0,id:"minecraft:oak_leaves"}]}];f.b.dressing=[{id:"later",ops:[{x:1,y:70,z:0,id:"minecraft:air"}]}];const actual=f.stream();assert.equal(actual.plan,null);assert.equal(actual.survey.refused,1);assert.match(actual.survey.rows[0].reason,/historical/);assert.deepEqual(actual.survey,f.batchPreview());
});
test("prepared batches require a private one-use capability, identical guard and exact metadata binding",()=>{
 const f=fixture(1),token=run(prepareLeafSourceBatchSteps(f.input,f.deps));
 const payload=consumePreparedLeafBatch(token,{input:f.input,sourcesCurrent:f.deps.sourcesCurrent,receiptRaw:undefined});assert.equal(payload.plan.proposals.length,1);assert.equal(Object.isFrozen(payload),true);assert.equal(Object.isFrozen(payload.survey.rows),true);
 assert.throws(()=>consumePreparedLeafBatch(token,{input:f.input,sourcesCurrent:f.deps.sourcesCurrent,receiptRaw:undefined}),/already-consumed/);
 for(const fault of ["plain","partial","guard","identity","receipt"]){const g=fixture(1);let candidate;
 if(fault==="plain")candidate={plan:payload.plan};
 else if(fault==="partial")candidate=run(collectWallLeafCensusSteps(g.a,{read:g.read,isProtected:g.isProtected},{sourceCount:2,opsFor:g.opsFor}));
 else candidate=run(prepareLeafSourceBatchSteps(g.input,g.deps));
 const input=fault==="identity"?{...g.input,masterHash:"00000000"}:g.input;
 assert.throws(()=>consumePreparedLeafBatch(candidate,{input,sourcesCurrent:fault==="guard"?()=>true:g.deps.sourcesCurrent,receiptRaw:fault==="receipt"?"foreign":undefined}),/foreign\/stale|binding/);
 }
});
test("proposed controller rejects arbitrary plans before any journal or block setter",()=>{
 const f=fixture(1),properties=new Map(),writes=[],propertyWrites=[];
 const world={getDynamicPropertyIds:()=>[...properties.keys()],getDynamicProperty:k=>properties.get(k),setDynamicProperty(k,v){propertyWrites.push([k,v]);properties.set(k,v);}};
 const input={...f.input,candidates:[],sources:f.input.sources.map(s=>({record:{districtIndex:s.index,checksum:s.checksum},civ:{status:s.status,checksum:s.checksum,dimension:s.dimension},masterHash:f.input.masterHash}))};
 const context={read:f.read,isProtected:f.isProtected,sourcesCurrent:()=>true,write:op=>writes.push(op)};
 const result=run(wallLeafRepairSteps(input,context,world,{confirm:true,policy:POLICY,readTick:()=>0,streamSourcesSteps:function*(){return{plan:{trusted:false}};}}));
 assert.match(result.state,/held:.*foreign\/stale/);assert.equal(writes.length,0);assert.equal(propertyWrites.length,0);
});
test("verified master initialization precedes every fresh native census read and its failure grants nothing",()=>{
 const f=fixture(1);let initialized=false,reads=0;
 f.deps.onVerifiedMaster=()=>{initialized=true;};f.deps.read=p=>{assert.equal(initialized,true);reads++;return f.read(p);};
 assert.equal(run(prepareLeafSourceBatchSteps(f.input,f.deps))!==undefined,true);assert.ok(reads>0);
 const bad=fixture(1);bad.deps.onVerifiedMaster=()=>{throw Error("protection initialization fault");};assert.throws(()=>run(prepareLeafSourceBatchSteps(bad.input,bad.deps)),/initialization fault/);assert.deepEqual(bad.loadOrder,[4]);
});
test("proposed controller consumes only its guarded prepared source token and preserves ordinary strict admission",()=>{
 const f=fixture(1),properties=new Map(),writes=[],propertyWrites=[];
 const world={getDynamicPropertyIds:()=>[...properties.keys()],getDynamicProperty:k=>properties.get(k),setDynamicProperty(k,v){propertyWrites.push([k,v]);properties.set(k,v);}};
 const input={...f.input,candidates:[],sources:f.input.sources.map(s=>({record:{districtIndex:s.index,checksum:s.checksum},civ:{status:s.status,checksum:s.checksum,dimension:s.dimension},masterHash:f.input.masterHash}))};
 const context={read:f.read,isProtected:f.isProtected,sourcesCurrent:()=>true,write:op=>{writes.push(structuredClone(op));f.cells.set(key(op),{isValid:true,typeId:op.id,states:{}});}};
 const options={policy:POLICY,readTick:()=>0,streamSourcesSteps:({context:guarded,receiptStore})=>prepareLeafSourceBatchSteps(f.input,{...f.deps,sourcesCurrent:guarded.sourcesCurrent,journalsCurrent:guarded.sourcesCurrent,receiptStore})};
 const preview=run(wallLeafRepairSteps(input,context,world,{...options,confirm:false}));assert.equal(preview.state,"preview");assert.equal(preview.rows.length,1);assert.equal(propertyWrites.length,0);assert.equal(writes.length,0);
 const confirmed=run(wallLeafRepairSteps(input,context,world,{...options,confirm:true}));assert.equal(confirmed.state,"batch complete");assert.equal(confirmed.verifiedChanges,1);assert.equal(writes.length,1);assert.ok(propertyWrites.length>=2);
 const count=propertyWrites.length,repeat=run(wallLeafRepairSteps(input,context,world,{...options,confirm:true}));assert.equal(repeat.writeAttempts,0);assert.equal(writes.length,1);assert.equal(propertyWrites.length,count);
});
