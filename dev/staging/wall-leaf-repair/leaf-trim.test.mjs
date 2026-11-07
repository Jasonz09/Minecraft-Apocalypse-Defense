import assert from "node:assert/strict";
import test from "node:test";
import { SITE_STAGES } from "../../../CivilizationApocalypse_BP/scripts/civ/districtplan.js";
import { POLICY,LIMITS,key,compileLeafTrim,compileLeafTrimSteps,previewLeafTrim,commitOneLeafTrim,prepareLeafTrim,prepareLeafTrimSteps,resumeLeafTrimSteps,runLeafTrimSteps } from "./leaf-trim.mjs";

const pos=(x,y=70,z=0)=>({x,y,z});
const cell=(typeId,states={})=>({isValid:true,typeId,states});
const op=(p,id="minecraft:stone_bricks",kind="wall")=>({...p,id,kind});
const leaf=()=>cell("minecraft:oak_leaves",{persistent_bit:false});
function fixture(count=1,change=()=>{}) {
    const candidates=Array.from({length:count},(_,i)=>pos(i*5));
    const record={districtIndex:4,checksum:"35635162",...Object.fromEntries(SITE_STAGES.map(stage=>[stage,[]]))};
    record.walls=candidates.map((p,i)=>({id:`wall-${i}`,ops:[op(p),op({...p,y:p.y-1},"minecraft:cobblestone")]}));
    const source={record,civ:{status:"complete",checksum:record.checksum,dimension:"minecraft:overworld"},masterHash:"9e5e307e"};
    const input={index:4,checksum:record.checksum,masterHash:source.masterHash,dimension:source.civ.dimension,candidates,sources:[source]};
    const blocks=new Map(candidates.flatMap(p=>[[key(p),leaf()],[key({...p,y:p.y-1}),cell("minecraft:cobblestone")]]));
    const protectedColumns=new Set(),writes=[];
    let raw,reads=0,saves=0;
    const io={load:()=>raw,save(value){raw=value;saves++;}};
    const ctx={sourcesCurrent:()=>true,read(p){reads++;return structuredClone(blocks.get(key(p))??cell("minecraft:air"));},
        isProtected:(x,z)=>protectedColumns.has(`${x},${z}`),write(value){writes.push(structuredClone(value));blocks.set(key(value),cell(value.id,value.states));}};
    const f={input,record,source,candidates,blocks,protectedColumns,writes,io,ctx,
        get raw(){return raw;},set raw(value){raw=value;},get reads(){return reads;},get saves(){return saves;}};
    change(f);
    f.compile=()=>compileLeafTrim(input,{opsFor:(r,stage,index)=>r[stage][index].ops});
    f.plan=f.compile();f.prepare=()=>prepareLeafTrim(f.plan,ctx,io,{policy:POLICY});f.commit=(index=0)=>{if(f.raw===undefined)f.prepare();return commitOneLeafTrim(f.plan,key(candidates[index]),ctx,io,{policy:POLICY});};
    return f;
}

test("synthetic seventeen-target preview is read-only and direct trim changes only those leaves",()=>{
    const f=fixture(17);f.blocks.set(key(pos(-1)),cell("minecraft:oak_log"));f.blocks.set(key(pos(-3)),cell("minecraft:copper_ore"));
    const before=structuredClone([...f.blocks]),preview=previewLeafTrim(f.plan,f.ctx);
    assert.equal(preview.eligible,17);assert.equal(preview.refused,0);assert.equal(f.saves,0);assert.equal(f.writes.length,0);assert.deepEqual([...f.blocks],before);
    for(let i=0;i<17;i++){const result=f.commit(i);assert.equal(result.changed,1);assert.equal(result.reads,LIMITS.readsPerCommit);}
    assert.equal(f.writes.length,17);assert.ok(f.writes.every(w=>w.id==="minecraft:stone_bricks"&&f.candidates.some(p=>key(p)===key(w))));
    for(const [at,b] of before)if(!f.candidates.some(p=>key(p)===at))assert.deepEqual(f.blocks.get(at),b,"log/ore/neighbor bytes never change");
    assert.equal(JSON.parse(f.raw).complete,true);
    for(let i=0;i<17;i++)assert.equal(f.commit(i).changed,0);
    assert.equal(f.writes.length,17,"completed repeat has zero additional block writes");
});

test("all stages decide final wall ownership; later AIR/gate/decor and nonmasonry/stateful targets refuse",()=>{
    for(const change of [
        f=>f.record.dressing.push({id:"later-air",ops:[op(f.candidates[0],"minecraft:air","dressing")]}),
        f=>f.record.gates.push({id:"later-gate",ops:[op(f.candidates[0],"minecraft:stone_bricks","gate")]}),
        f=>f.record.walls[0].ops[0].id="minecraft:oak_planks",
        f=>f.record.walls[0].ops[0].states={unreviewed:true},
        f=>f.record.walls[0].ops.unshift(op(f.candidates[0],"minecraft:oak_leaves","planting")),
    ]) {
        const f=fixture(1,change),preview=previewLeafTrim(f.plan,f.ctx);
        assert.equal(preview.eligible,0);assert.equal(preview.refused,1);assert.equal(f.reads,0);assert.equal(f.saves,0);
    }
});

test("historical vegetation/decor from own or another verified plan vetoes even after later overwrite",()=>{
    for(const neighbor of [false,true])for(const historicalId of ["minecraft:birch_log","minecraft:wheat","minecraft:chest"]) {
        const f=fixture(1,f=>{
            const r=neighbor?{districtIndex:3,checksum:"1234abcd",...Object.fromEntries(SITE_STAGES.map(s=>[s,[]]))}:f.record;
            if(neighbor)f.input.sources.push({record:r,civ:{status:"complete",checksum:r.checksum,dimension:"minecraft:overworld"},masterHash:f.input.masterHash});
            r.lots.push({id:"planted",ops:[op(pos(1),historicalId,"building")]});
            r.dressing.push({id:"later-air",ops:[op(pos(1),"minecraft:air","dressing")]});
        });
        assert.match(previewLeafTrim(f.plan,f.ctx).rows[0].reason,/historical planned/);
        assert.throws(()=>f.commit(),/historical planned/);assert.equal(f.writes.length,0);
    }
});

test("current target and every neighboring column are protected without shared-wall exemptions",()=>{
    for(const p of [pos(0),pos(1),pos(-1,70,1)]) {
        const f=fixture();f.protectedColumns.add(`${p.x},${p.z}`);
        assert.throws(()=>f.commit(),/protected or unknown/);assert.equal(f.writes.length,0);
    }
    const f=fixture();f.ctx.isProtected=()=>undefined;assert.throws(()=>f.commit(),/protected or unknown/);
});

test("target logs, vines, ores, AIR, persistent/player leaves and unknown leaf state never qualify",()=>{
    for(const b of [cell("minecraft:oak_log"),cell("minecraft:vine"),cell("minecraft:copper_ore"),cell("minecraft:air"),cell("minecraft:oak_leaves",{persistent_bit:true}),cell("minecraft:oak_leaves")]) {
        const f=fixture();f.blocks.set(key(pos(0)),b);assert.throws(()=>f.commit(),/not a readable nonpersistent/);assert.deepEqual(f.blocks.get(key(pos(0))),b);assert.equal(f.writes.length,0);
    }
});

test("local copper/foreign builds and persistent leaf contacts remain vetoes; distant copper is never traversed",()=>{
    for(const b of [cell("minecraft:copper_ore"),cell("minecraft:oak_planks"),cell("minecraft:chest"),cell("minecraft:oak_leaves",{persistent_bit:true}),cell("minecraft:oak_leaves")]) {
        const f=fixture();f.blocks.set(key(pos(1)),b);assert.throws(()=>f.commit(),/foreign local contact|persistent or unknown-state/);assert.equal(f.writes.length,0);
    }
    const f=fixture();f.blocks.set(key(pos(2)),cell("minecraft:copper_ore"));assert.equal(f.commit().changed,1);assert.equal(f.blocks.get(key(pos(2))).typeId,"minecraft:copper_ore");
});

test("missing/invalid/throwing local reads and unreadable protection preserve leaves and pending journal",()=>{
    for(const get of [()=>undefined,()=>({isValid:false,typeId:"minecraft:air"}),()=>{throw Error("unload");}]) {
        const f=fixture(),original=f.ctx.read;f.ctx.read=p=>key(p)===key(pos(1))?get():original(p);
        assert.throws(()=>f.commit(),/unloaded|unreadable/);assert.equal(f.writes.length,0);assert.equal(f.raw,undefined,"failed admission creates no orphan receipt");
    }
    const f=fixture();f.ctx.isProtected=()=>{throw Error("bad geometry");};assert.throws(()=>f.commit(),/protection is unreadable/);assert.equal(f.writes.length,0);
});

test("contact mutation and final-barrier player-leaf mutation both stop before a block write",()=>{
    const f=fixture();f.prepare();const preparedReads=f.reads,read=f.ctx.read;let count=0;
    f.ctx.read=p=>{if(++count===28)f.blocks.set(key(pos(1)),cell("minecraft:oak_planks"));return read(p);};
    assert.throws(()=>f.commit(),/foreign local contact|changed before commit/);assert.equal(f.writes.length,0);assert.ok(f.reads-preparedReads<=LIMITS.readsPerCommit);
    const g=fixture();g.prepare();const original=g.ctx.read;count=0;
    g.ctx.read=p=>{if(++count===55)g.blocks.set(key(pos(0)),cell("minecraft:oak_leaves",{persistent_bit:true}));return original(p);};
    assert.throws(()=>g.commit(),/final write barrier/);assert.equal(g.writes.length,0);
});

test("write-ahead checkpoint failure and silent block-write failure cannot mark work complete",()=>{
    const f=fixture();f.io.save=()=>{};assert.throws(()=>f.commit(),/checkpoint could not be read back/);assert.equal(f.reads,27);assert.equal(f.writes.length,0);
    const g=fixture();g.ctx.write=()=>{};assert.throws(()=>g.commit(),/write could not be verified/);assert.equal(g.blocks.get(key(pos(0))).typeId,"minecraft:oak_leaves");assert.equal(JSON.parse(g.raw).entries[0].done,false);
});

test("crash after the single masonry write rejoins by adoption with zero repeated write",()=>{
    const f=fixture(),write=f.ctx.write;
    f.ctx.write=p=>{write(p);throw Error("process died before journal commit");};
    assert.throws(()=>f.commit(),/process died/);assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.raw).entries[0].done,false);
    f.plan=f.compile();f.ctx.write=write;
    assert.equal(f.commit().changed,0);assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.raw).complete,true);
});

test("crash after the done checkpoint retains idempotence; source/policy corruption cannot be resumed",()=>{
    const f=fixture(),save=f.io.save;let saves=0;
    f.io.save=raw=>{save(raw);if(++saves===2)throw Error("process died after done checkpoint");};
    assert.throws(()=>f.commit(),/process died/);assert.equal(JSON.parse(f.raw).complete,true);f.io.save=save;
    assert.equal(f.commit().changed,0);assert.equal(f.writes.length,1);
    const original=f.raw;
    for(const patch of [{v:3},{policy:"normal-repair"},{checksum:"ffffffff"},{planId:"ffffffff"},{dimension:"minecraft:nether"}]) {
        f.raw=JSON.stringify({...JSON.parse(original),...patch});const before=f.raw;
        assert.throws(()=>f.commit(),/source\/policy differs/);assert.equal(f.raw,before);assert.equal(f.writes.length,1);
    }
});

test("ordinary repair/no policy cannot read or consume this separate trim journal",()=>{
    const f=fixture(),trap={load(){throw Error("must not be reached");},save(){throw Error("must not be reached");}};
    assert.throws(()=>commitOneLeafTrim(f.plan,key(pos(0)),f.ctx,trap),/explicit versioned/);assert.equal(f.reads,0);assert.equal(f.writes.length,0);
});

test("compiler enforces unique verified sources/candidates and bounded work before any proof",()=>{
    for(const change of [f=>f.input.sources.push(f.source),f=>f.source.civ.status="building",f=>f.source.civ.checksum="ffffffff",f=>f.source.masterHash="ffffffff",f=>f.input.candidates.push(f.candidates[0])])assert.throws(()=>fixture(1,change),/proof|checksum|candidate/);
    assert.throws(()=>fixture(65),/oversized/);
    const f=fixture(17);for(let i=0;i<1600;i++)f.record.roads.push({id:`road-${i}`,ops:[op(pos(200+i),"minecraft:grass_path","road")]});
    const g=compileLeafTrimSteps(f.input,{opsFor:(r,s,i)=>r[s][i].ops});let yields=0,result;
    for(;;){const next=g.next();if(next.done){result=next.value;break;}yields++;}
    assert.ok(yields>=4);assert.equal(result.compileScannedOps,1634);assert.ok(Object.isFrozen(result));
});

test("a later player change to a completed target is preserved rather than repaired by the trim policy",()=>{
    const f=fixture();f.commit();f.blocks.set(key(pos(0)),cell("minecraft:gold_block"));const before=f.raw;
    assert.throws(()=>f.commit(),/not a readable nonpersistent|completed target/);assert.equal(f.blocks.get(key(pos(0))).typeId,"minecraft:gold_block");assert.equal(f.raw,before);assert.equal(f.writes.length,1);
});

const opsFor=(record,stage,index)=>record[stage][index].ops;
const drain=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
function addNeighbor(f){const record={districtIndex:3,checksum:"1234abcd",...Object.fromEntries(SITE_STAGES.map(s=>[s,[]]))};record.walls.push({id:"neighbor-shared",ops:[op(f.candidates[0])]});f.input.sources.push({record,civ:{status:"complete",checksum:record.checksum,dimension:f.input.dimension},masterHash:f.input.masterHash});return record;}

test("another verified record's later AIR, road, gate or different masonry claim vetoes the target itself",()=>{
    for(const [stage,id,kind]of [["roads","minecraft:air","clear"],["roads","minecraft:grass_path","road"],["gates","minecraft:stone_bricks","gate"],["walls","minecraft:cobblestone","wall"]]){
        const f=fixture();const neighbor=addNeighbor(f);neighbor[stage].push({id:"later-claim",ops:[op(f.candidates[0],id,kind)]});f.plan=f.compile();
        assert.equal(f.plan.proposals.length,0,stage+id);assert.match(f.plan.refused[0].reason,/conflicting final target claim/);assert.equal(f.reads,0);assert.equal(f.saves,0);assert.equal(f.writes.length,0);
    }
    const same=fixture();addNeighbor(same);same.plan=same.compile();assert.equal(same.plan.proposals.length,1,"matching exact final wall claim remains valid");
});

test("admission checkpoints original target list, exact leaf states/materials and digests with <=27 reads between yields",()=>{
    const f=fixture(3);f.blocks.get(key(f.candidates[0])).states.update_bit=false;
    const g=prepareLeafTrimSteps(f.plan,f.ctx,f.io,{policy:POLICY});let peak=0,last=0,steps=0;
    for(;;){const n=g.next();peak=Math.max(peak,f.reads-last);last=f.reads;if(n.done)break;steps++;assert.equal(f.raw,undefined,"no journal before every admission proof completes");}
    assert.equal(steps,3);assert.ok(peak<=LIMITS.readsPerPrepareSlice);assert.equal(f.writes.length,0);
    const receipt=JSON.parse(f.raw);assert.equal(receipt.v,2);assert.deepEqual(receipt.requested,f.candidates);assert.equal(receipt.entries.length,3);assert.equal(receipt.entries[0].before.typeId,"minecraft:oak_leaves");assert.deepEqual(receipt.entries[0].before.states,{persistent_bit:false,update_bit:false});assert.deepEqual(receipt.entries[0].desired,{id:"minecraft:stone_bricks"});assert.equal(typeof receipt.requestedDigest,"string");assert.equal(typeof receipt.entriesDigest,"string");
});

test("real crash after write resumes ORIGINAL admitted list although audit dropped masonry, then empty-audit rejoin writes zero",()=>{
    const f=fixture(2),write=f.ctx.write;f.prepare();f.ctx.write=p=>{write(p);throw Error("crash after replacing leaf");};
    assert.throws(()=>f.commit(0),/crash after replacing leaf/);assert.equal(f.writes.length,1);const pending=f.raw;
    f.ctx.write=write;
    const afterCrashInput={...f.input,candidates:[f.candidates[1]]};
    const resumed=drain(runLeafTrimSteps(afterCrashInput,f.ctx,f.io,{opsFor},{policy:POLICY}));assert.equal(resumed.changed,1);assert.equal(resumed.complete,true);assert.equal(f.writes.length,2);
    const receipt=JSON.parse(f.raw);assert.deepEqual(receipt.requested,f.candidates);assert.equal(receipt.entries.length,2);assert.ok(receipt.entries.every(e=>e.done));assert.notEqual(f.raw,pending);
    const completeRaw=f.raw,saves=f.saves;
    const repeated=drain(runLeafTrimSteps({...f.input,candidates:[]},f.ctx,f.io,{opsFor},{policy:POLICY}));assert.equal(repeated.changed,0);assert.equal(f.writes.length,2);assert.equal(f.saves,saves);assert.equal(f.raw,completeRaw);
});

test("journal CAS and source receipts are rechecked immediately AFTER each compile yield",()=>{
    for(const change of ["journal","source"]){const f=fixture();for(let i=0;i<500;i++)f.record.roads.push({id:`remote-${i}`,ops:[op(pos(1000+i),"minecraft:grass_path","road")]});const g=resumeLeafTrimSteps(f.input,f.ctx,f.io,{opsFor},{policy:POLICY});assert.equal(g.next().done,false);if(change==="journal")f.raw="foreign receipt";else f.source.civ.status="building";const before=f.raw;assert.throws(()=>g.next(),/journal changed externally|source receipts changed/);assert.equal(f.raw,before);assert.equal(f.reads,0);assert.equal(f.writes.length,0);}
});

test("journal replacement or source change during admission yield stops before next read or checkpoint",()=>{
    for(const change of ["journal","source"]){const f=fixture(2),g=runLeafTrimSteps(f.input,f.ctx,f.io,{opsFor},{policy:POLICY});assert.equal(g.next().done,false);assert.equal(f.reads,27);if(change==="journal")f.raw="foreign pending journal";else f.source.civ.status="building";const before=f.raw;assert.throws(()=>g.next(),/journal changed externally|source receipts changed/);assert.equal(f.reads,27);assert.equal(f.raw,before);assert.equal(f.saves,0);assert.equal(f.writes.length,0);}
});

test("late journal mutation during second 27-cell proof OR final target read vetoes the writer",()=>{
    for(const trigger of [28,55]){const f=fixture();f.prepare();const read=f.ctx.read;let n=0;f.ctx.read=p=>{if(++n===trigger)f.raw="external journal mutation";return read(p);};assert.throws(()=>f.commit(),/journal changed externally/);assert.equal(f.writes.length,0);assert.equal(f.raw,"external journal mutation");assert.ok(n<=LIMITS.readsPerCommit);assert.equal(f.blocks.get(key(f.candidates[0])).typeId,"minecraft:oak_leaves");}
});

test("required fresh-source hook fails closed and is checked again after local proof immediately before writer",()=>{
    const missing=fixture();delete missing.ctx.sourcesCurrent;assert.throws(()=>missing.prepare(),/fresh source/);assert.equal(missing.raw,undefined);assert.equal(missing.reads,0);
    const f=fixture();f.prepare();const admitted=f.reads;f.ctx.sourcesCurrent=()=>f.reads<admitted+54;assert.throws(()=>f.commit(),/fresh source/);assert.equal(f.writes.length,0);assert.equal(JSON.parse(f.raw).entries[0].done,false);
});

test("changed admitted leaf states retain the pending receipt instead of adopting a new natural-looking leaf",()=>{
    const f=fixture();f.blocks.get(key(f.candidates[0])).states.update_bit=false;f.prepare();const before=f.raw;f.blocks.get(key(f.candidates[0])).states.update_bit=true;assert.throws(()=>f.commit(),/admitted leaf identity\/states changed/);assert.equal(f.writes.length,0);assert.equal(f.raw,before);assert.equal(f.blocks.get(key(f.candidates[0])).states.update_bit,true);
});

test("source or neighboring protection changing during final target read refuses before the writer",()=>{
    for(const change of ["source","protection"]){
        const f=fixture();f.prepare();const pending=f.raw,read=f.ctx.read;let n=0,current=true;
        f.ctx.sourcesCurrent=()=>current;
        f.ctx.read=p=>{const block=read(p);if(++n===55){if(change==="source")current=false;else f.protectedColumns.add("1,1");}return block;};
        assert.throws(()=>f.commit(),/fresh source|protected or unknown/);
        assert.equal(f.writes.length,0);assert.equal(n,55);assert.equal(f.raw,pending);
        assert.equal(f.blocks.get(key(f.candidates[0])).typeId,"minecraft:oak_leaves");
    }
});

test("negative control reproduces the final-read source gap when the last full barrier is weakened",async()=>{
    const {readFileSync}=await import("node:fs"),url=new URL("./leaf-trim.mjs",import.meta.url),text=readFileSync(url,"utf8");
    const weakened=text.replace("barrier(ctx,io,raw,plan);\n        ctx.write", "journalCAS(io,raw);\n        ctx.write");
    assert.notEqual(weakened,text);
    const mutant=await import("data:text/javascript,"+encodeURIComponent(weakened.replace(/from\s+"(\.[^"]+)"/g,(_,s)=>"from "+JSON.stringify(new URL(s,url).href))));
    const f=fixture();f.prepare();const pending=f.raw,read=f.ctx.read;let n=0,current=true,sourceAtWrite;
    f.ctx.sourcesCurrent=()=>current;f.ctx.read=p=>{const block=read(p);if(++n===55)current=false;return block;};
    const write=f.ctx.write;f.ctx.write=p=>{sourceAtWrite=current;write(p);};
    assert.throws(()=>mutant.commitOneLeafTrim(f.plan,key(f.candidates[0]),f.ctx,f.io,{policy:POLICY}),/fresh source/);
    assert.equal(f.writes.length,1);assert.equal(sourceAtWrite,false);assert.equal(f.raw,pending);
});

test("corrupt admitted list/state digests, unknown versions and source mismatch retain original raw bytes",()=>{
    const f=fixture();f.prepare();const valid=f.raw;
    const edits=[r=>r.requested.pop(),r=>r.entries[0].before.states.update_bit=true,r=>r.entries[0].desired.id="minecraft:cobblestone",r=>r.v=1,r=>r.checksum="ffffffff",r=>r.sources[0].checksum="ffffffff"];
    for(const edit of edits){const receipt=JSON.parse(valid);edit(receipt);f.raw=JSON.stringify(receipt);const before=f.raw;assert.throws(()=>drain(resumeLeafTrimSteps({...f.input,candidates:[]},f.ctx,f.io,{opsFor},{policy:POLICY})),/journal|source/);assert.equal(f.raw,before);assert.equal(f.writes.length,0);}
});

test("after checkpoint yield the batch keeps its own exact CAS stamp and never adopts a replacement journal",()=>{
    const f=fixture(2),g=runLeafTrimSteps(f.input,f.ctx,f.io,{opsFor},{policy:POLICY});let sawWrite=false;
    for(;;){const n=g.next();if(n.done)throw Error("expected a post-write yield");if(f.writes.length){sawWrite=true;break;}}
    assert.equal(sawWrite,true);assert.equal(f.writes.length,1);f.raw="replacement after checkpoint";
    assert.throws(()=>g.next(),/journal changed externally/);assert.equal(f.writes.length,1);assert.equal(f.raw,"replacement after checkpoint");assert.equal(f.blocks.get(key(f.candidates[1])).typeId,"minecraft:oak_leaves");
});

test("independent in-memory negative controls expose each removed ownership, CAS and original-list recovery guard",async()=>{
    const {readFileSync}=await import("node:fs"),url=new URL("./leaf-trim.mjs",import.meta.url),text=readFileSync(url,"utf8");
    const load=async code=>import("data:text/javascript,"+encodeURIComponent(code.replace(/from\s+"(\.[^"]+)"/g,(_,s)=>"from "+JSON.stringify(new URL(s,url).href))));
    const noClaimVeto=await load(text.replace("if(reason||conflicting)","if(reason)"));
    const ownership=fixture();const neighbor=addNeighbor(ownership);neighbor.roads.push({id:"neighbor-final-air",ops:[op(ownership.candidates[0],"minecraft:air","clear")]});
    assert.equal(ownership.compile().proposals.length,0,"live implementation rejects final neighbor AIR");
    assert.equal(noClaimVeto.compileLeafTrim(ownership.input,{opsFor},{policy:POLICY}).proposals.length,1,"negative control becomes unsafe if final-claim veto is removed");
    const noCAS=await load(text.replace(/function journalCAS\(io,expected\)\{[^\n]+\}/,"function journalCAS(io,expected){}"));
    const cas=fixture();cas.prepare();let reads=0;const read=cas.ctx.read;cas.ctx.read=p=>{if(++reads===55)cas.raw="foreign journal at last read";return read(p);};
    noCAS.commitOneLeafTrim(cas.plan,key(cas.candidates[0]),cas.ctx,cas.io,{policy:POLICY});
    assert.equal(cas.writes.length,1,"negative control wrongly writes and overwrites the foreign receipt without CAS");assert.notEqual(cas.raw,"foreign journal at last read");
    const noRestore=await load(text.replace("const request=receipt?{...input,candidates:clone(receipt.requested)}:input;","const request=input;"));
    const recovery=fixture(2);recovery.prepare();const write=recovery.ctx.write;recovery.ctx.write=p=>{write(p);throw Error("crash after write");};assert.throws(()=>recovery.commit(0));recovery.ctx.write=write;
    const originalRaw=recovery.raw,remaining={...recovery.input,candidates:[recovery.candidates[1]]};
    assert.equal(drain(resumeLeafTrimSteps(remaining,recovery.ctx,recovery.io,{opsFor},{policy:POLICY})).requested.length,2);
    assert.throws(()=>drain(noRestore.resumeLeafTrimSteps(remaining,recovery.ctx,recovery.io,{opsFor},{policy:POLICY})),/journal source\/policy differs|admitted target\/source set differs/);
    assert.equal(recovery.raw,originalRaw);assert.equal(recovery.writes.length,1,"negative control cannot recover after dropping the already-written original coordinate");
});


test("every admission/resume/batch entry refuses missing policy before touching the separate journal",()=>{
    const f=fixture(),trap={load(){throw Error("journal must not be read");},save(){throw Error("journal must not be written");}};
    assert.throws(()=>prepareLeafTrimSteps(f.plan,f.ctx,trap).next(),/explicit versioned/);
    assert.throws(()=>resumeLeafTrimSteps(f.input,f.ctx,trap,{opsFor}).next(),/explicit versioned/);
    assert.throws(()=>runLeafTrimSteps(f.input,f.ctx,trap,{opsFor}).next(),/explicit versioned/);
    assert.equal(f.reads,0);assert.equal(f.writes.length,0);
});
