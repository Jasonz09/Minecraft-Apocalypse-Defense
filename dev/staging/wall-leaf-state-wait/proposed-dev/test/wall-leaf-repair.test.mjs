import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {mc,resetWorld,builder,civCommands,planstore,propsSnapshot} from "../lib/civharness.mjs";
import {newOps} from "../../CivilizationApocalypse_BP/scripts/civ/regions.js";
import {POLICY,key,compileLeafTrim,prepareLeafTrim,commitOneLeafTrim,readLeafTrimReceipt,LEAF_TRIM_MASONRY_IDS} from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js";
import {createWallLeafSourceGuard,wallLeafRepairSteps,createWallLeafBlockAdapter,WALL_LEAF_STATE_PREFIX} from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js";
const closed=JSON.parse(readFileSync(new URL("../fixtures/wall-leaf-closed-source-20261106.json",import.meta.url),"utf8"));
const {WRITE_PROTECT_GROW,inProtectedArea}=builder;
const evidence=JSON.parse(readFileSync(new URL("../fixtures/wall-leaf-preview-20261106.json",import.meta.url),"utf8"));
const run=g=>{for(;;){const s=g.next();if(s.done)return s.value;}};
let verified;
function sources(){if(verified)return verified;resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);
    const before=propsSnapshot(),kingdom=JSON.parse(closed.properties["civ:kingdom"]),masterHash=JSON.parse(closed.properties["civ:plan:meta"]).hash;
    const list=kingdom.districts.filter(d=>d.civ).map(d=>{const index=Number(d.id.slice(9)),saved=run(builder.loadSavedRunSteps(d.civ,newOps(),index));assert.equal(saved.ok,true,JSON.stringify(saved.reasons));assert.equal(saved.queue.state,"complete");assert.equal(saved.record.checksum,d.civ.checksum);return{...saved,civ:d.civ,masterHash};});
    assert.deepEqual(propsSnapshot(),before,"actual saved-plan rehydration does not mutate closed fixture properties");
    const serial=JSON.stringify(list[0].plan);assert.ok(list.every(s=>JSON.stringify(s.plan)===serial));
    return verified={kingdom,masterHash,plan:list[0].plan,sources:list.map(s=>({record:s.record,civ:s.civ,masterHash}))};
}
function fixture(){const saved=sources(),props=new Map(Object.entries(closed.properties)),propertyWrites=[],writes=[],blocks=new Map(),protectedColumns=new Set();
    const input={index:4,checksum:saved.sources.find(s=>s.record.districtIndex===4).record.checksum,masterHash:saved.masterHash,dimension:"minecraft:overworld",sources:saved.sources,candidates:[...evidence.eligible,...evidence.refused].map(c=>c.position)};
    const allPlan=compileLeafTrim(input),areas=civCommands.protectedRects(saved.kingdom,1,saved.plan,WRITE_PROTECT_GROW,4);
    for(const p of allPlan.proposals)for(const c of p.contacts)if(c.expected.length&&!blocks.has(key(c.point)))blocks.set(key(c.point),{isValid:true,typeId:c.expected[0],states:{}});
    for(const row of [...evidence.eligible,...evidence.refused])blocks.set(key(row.position),{isValid:true,typeId:row.actualId,states:{persistent_bit:row.persistent_bit}});
    let tick=0,cancelled=false,reads=0,inSlice=0,maxReads=0;
    const world={getDynamicPropertyIds:()=>[...props.keys()],getDynamicProperty:k=>props.get(k),setDynamicProperty(k,v){propertyWrites.push([k,v]);props.set(k,v);}};
    const guard=createWallLeafSourceGuard(world,()=>JSON.parse(props.get("civ:kingdom")),()=>cancelled);
    const ctx={read(p){reads++;inSlice++;maxReads=Math.max(maxReads,inSlice);return structuredClone(blocks.get(key(p))??{isValid:true,typeId:"minecraft:air",states:{}});},
        isProtected:(x,z)=>protectedColumns.has(`${x},${z}`)||inProtectedArea(areas,x,z),sourcesCurrent:()=>guard.current(),cancelled:()=>cancelled,
        write(op){writes.push(structuredClone(op));blocks.set(key(op),{isValid:true,typeId:op.id,states:{}});f.afterWrite?.(op);}};
    const f={input,props,blocks,writes,world,ctx,guard,propertyWrites,protectedColumns,afterWrite:null,get tick(){return tick;},set tick(value){tick=value;},cancel(){cancelled=true;},get reads(){return reads;},get maxReads(){return maxReads;},
        run(confirm=false){const g=wallLeafRepairSteps(input,ctx,world,{confirm,policy:POLICY,readTick:()=>tick});for(;;){inSlice=0;const s=g.next();if(s.done)return s.value;}},
        steps(confirm=true){return wallLeafRepairSteps(input,ctx,world,{confirm,policy:POLICY,readTick:()=>tick});}};return f;
}
test("closed authoritative sources rebuild all five complete checksums and compile native candidate materials without guessed provenance",()=>{
    const s=sources();assert.equal(s.masterHash,"9e5e307e");assert.deepEqual(s.sources.map(s=>s.record.checksum),["07515fcb","e6d55467","6b9f8114","35635162","23a6aeca"]);
    const f=fixture(),plan=compileLeafTrim({...f.input,candidates:evidence.eligible.map(c=>c.position)});assert.equal(plan.refused.length,0);assert.equal(plan.proposals.length,14);
    for(const row of evidence.eligible)assert.equal(plan.proposals.find(p=>key(p.target)===key(row.position)).target.id,row.expectedId);
    assert.equal(f.writes.length,0);assert.equal(f.propertyWrites.length,0);
});
test("real-source preview admits14 and preserves3 protected candidates; confirm writes only exact masonry and retains receipts",()=>{
    const f=fixture(),before=[...f.props],preview=f.run(false);assert.equal(preview.state,"preview");assert.equal(preview.rows.length,14);assert.equal(preview.globalSurvey.refused,3);assert.equal(f.writes.length,0);assert.deepEqual([...f.props],before);
    const result=f.run(true);assert.equal(result.state,"batch complete");assert.equal(result.verifiedChanges,14);assert.equal(result.writeAttempts,14);assert.equal(f.writes.length,14);assert.ok(f.maxReads<=64);
    const allowed=new Map(evidence.eligible.map(r=>[key(r.position),r.expectedId]));for(const op of f.writes)assert.equal(op.id,allowed.get(key(op)));
    for(const row of evidence.refused)assert.equal(f.blocks.get(key(row.position)).typeId,row.actualId);
    assert.ok(f.propertyWrites.every(([k])=>k.startsWith(WALL_LEAF_STATE_PREFIX)));for(const[k,v]of before)assert.equal(f.props.get(k),v);
    const count=f.propertyWrites.length;const again=f.run(true);assert.equal(again.writeAttempts,0);assert.equal(f.writes.length,14);assert.equal(f.propertyWrites.length,count);
});
test("cancel after one committed target preserves the original batch and resumes idempotently",()=>{
    const f=fixture(),g=f.steps();for(let i=0;i<20000;i++){const n=g.next();if(n.done)assert.fail("finished before interruption");if(f.writes.length===1)break;}
    assert.equal(f.writes.length,1);const props=new Map(f.props),journal=[...props.keys()].find(k=>k.startsWith(WALL_LEAF_STATE_PREFIX));assert.equal(readLeafTrimReceipt(props.get(journal)).complete,false);
    f.cancel();const stopped=run(g);assert.match(stopped.state,/cancelled/);assert.equal(f.writes.length,1);
    const resumed=fixture();resumed.props.clear();for(const[k,v]of props)resumed.props.set(k,v);for(const[k,v]of f.blocks)resumed.blocks.set(k,structuredClone(v));
    const result=resumed.run(true);assert.equal(result.state,"batch complete");assert.equal(result.writeAttempts,13);assert.equal(resumed.writes.length,13);
});
test("unknown receipt and changed source preserve block/property bytes",()=>{
    const f=fixture();f.props.set("civ:wall_leaf_trim:future","foreign bytes");const before=[...f.props];assert.match(f.run(true).state,/unknown/);assert.deepEqual([...f.props],before);assert.equal(f.writes.length,0);
    const g=fixture(),steps=g.steps();steps.next();g.props.set("civ:plan:a:0","changed source bytes");const held=run(steps);assert.match(held.state,/held/);assert.equal(g.writes.length,0);assert.equal(g.propertyWrites.length,0);
});
test("native adapter uses the final read handle with56reads, and late source/protection changes never reach a writer",()=>{
    for(const change of ["none","source","protection"]){const f=fixture(),candidate=evidence.eligible[0].position,plan=compileLeafTrim({...f.input,candidates:[candidate]});let raw;
        const io={load:()=>raw,save:v=>{raw=v;}};prepareLeafTrim(plan,f.ctx,io,{policy:POLICY});let gets=0,writes=0;
        const native={getBlock(p){gets++;if(gets===55){if(change==="source")f.props.set("civ:plan:a:0","late change");if(change==="protection")f.protectedColumns.add(`${candidate.x},${candidate.z}`);}
            const b=f.ctx.read(p);return{isValid:true,typeId:b.typeId,permutation:{getAllStates:()=>b.states},setPermutation(value){writes++;f.blocks.set(key(p),{isValid:true,typeId:value.id,states:{}});}};}};
        const adapter=createWallLeafBlockAdapter(native,new Map(LEAF_TRIM_MASONRY_IDS.map(id=>[id,{id}]))),ctx={...f.ctx,...adapter};
        if(change==="none"){assert.equal(commitOneLeafTrim(plan,key(candidate),ctx,io,{policy:POLICY}).changed,1);assert.equal(gets,56);assert.equal(writes,1);}
        else{const pending=raw;assert.throws(()=>commitOneLeafTrim(plan,key(candidate),ctx,io,{policy:POLICY}));assert.equal(gets,55);assert.equal(writes,0);assert.equal(raw,pending);}
    }
});

function interrupted(){const f=fixture(),g=f.steps();for(let i=0;i<20000;i++){const n=g.next();if(n.done)assert.fail("finished before interruption");if(f.writes.length===1)break;}g.return();const journal=[...f.props.keys()].find(k=>k.startsWith(WALL_LEAF_STATE_PREFIX));assert.ok(journal);return{f,journal};}
test("pending receipt never accepts an unreadable original target or external journal replacement",()=>{
    const {f,journal}=interrupted(),entry=readLeafTrimReceipt(f.props.get(journal)).requested[1],worldBefore=[...f.props],priorWrites=f.writes.length;
    const read=f.ctx.read;f.ctx.read=p=>key(p)===key(entry)?undefined:read(p);
    const held=f.run(true);assert.match(held.state,/held/);assert.equal(held.writeAttempts,0);assert.equal(f.writes.length,priorWrites);assert.deepEqual([...f.props],worldBefore);
    f.ctx.read=read;const g=f.steps();g.next();f.props.set(journal,"externally replaced unknown receipt");const replacement=[...f.props];
    assert.match(run(g).state,/held/);assert.equal(f.writes.length,priorWrites);assert.deepEqual([...f.props],replacement);
});
test("retained completed history binds every neighbor source, not only the selected checksum",()=>{
    const f=fixture();assert.equal(f.run(true).state,"batch complete");const journal=[...f.props.keys()].find(k=>k.startsWith(WALL_LEAF_STATE_PREFIX));
    const old=JSON.parse(f.props.get(journal));old.sources[0].checksum="12345678";f.props.set(journal,JSON.stringify(old));const before=[...f.props],writes=f.writes.length;
    const held=f.run(true);assert.match(held.state,/source\/key differs/);assert.equal(held.writeAttempts,0);assert.equal(f.writes.length,writes);assert.deepEqual([...f.props],before);
});
test("native adapter caps cached handles and setter failure retains the admitted pending receipt",()=>{
    const f=fixture(),candidate=evidence.eligible[0].position,plan=compileLeafTrim({...f.input,candidates:[candidate]});let raw;
    const io={load:()=>raw,save:v=>{raw=v;}};prepareLeafTrim(plan,f.ctx,io,{policy:POLICY});const initial=raw;let setters=0;
    const native={getBlock(p){const b=f.ctx.read(p);return{isValid:true,typeId:b.typeId,permutation:{getAllStates:()=>b.states},setPermutation(){setters++;throw new Error("native setter refused");}};}};
    const adapter=createWallLeafBlockAdapter(native,new Map(LEAF_TRIM_MASONRY_IDS.map(id=>[id,{id}])));
    assert.throws(()=>commitOneLeafTrim(plan,key(candidate),{...f.ctx,...adapter},io,{policy:POLICY}),/native setter refused/);assert.equal(setters,1);assert.equal(raw,initial);assert.equal(readLeafTrimReceipt(raw).complete,false);
    for(let i=0;i<1800;i++)adapter.read({x:i,y:70,z:0});assert.throws(()=>adapter.write(plan.proposals[0].target),/final native handle/);
});

test("five-source compiled native-policy controller waits through synthetic80tick updates without changing receipt identity",()=>{
 const f=fixture();for(const b of f.blocks.values())if(b.typeId.endsWith("_leaves"))b.states={old_leaf_type:b.typeId.slice(10,-7),persistent_bit:false,update_bit:false};
 let settle=0;f.afterWrite=()=>{for(const b of f.blocks.values())if(b.typeId.endsWith("_leaves"))b.states.update_bit=true;settle=f.tick+80;};
 const before=new Map(f.props),g=f.steps();let result,initialIdentity;
 for(let slice=0;slice<100000;slice++){
  const next=g.next();if(next.done){result=next.value;break;}
  const journal=[...f.props.keys()].find(k=>k.startsWith(WALL_LEAF_STATE_PREFIX));
  if(journal){const r=readLeafTrimReceipt(f.props.get(journal)),identity=JSON.stringify({requested:r.requested,entries:r.entries.map(({done,...entry})=>entry),planId:r.planId,policy:r.policy,v:r.v});if(initialIdentity===undefined)initialIdentity=identity;assert.equal(identity,initialIdentity);}
  f.tick++;if(f.tick>=settle)for(const b of f.blocks.values())if(b.typeId.endsWith("_leaves"))b.states.update_bit=false;
 }
 assert.ok(result,"bounded controller completed");assert.equal(result.state,"batch complete");assert.equal(result.verifiedChanges,14);assert.equal(f.writes.length,14);assert.ok(f.tick>200);
 for(const[k,v]of before)assert.equal(f.props.get(k),v,"original source/queue bytes unchanged");
 for(const row of evidence.refused)assert.equal(f.blocks.get(key(row.position)).typeId,row.actualId,"three protected candidates remain leaves");
 assert.equal(f.run(true).writeAttempts,0);
});
