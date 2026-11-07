import assert from "node:assert/strict";
import test from "node:test";
import { runSync } from "../../CivilizationApocalypse_BP/scripts/civ/regions.js";
import { SITE_STAGES } from "../../CivilizationApocalypse_BP/scripts/civ/districtplan.js";
import { previewWallLeavesSteps,formatWallLeafPreview,WALL_LEAF_PREVIEW_LIMITS } from "../../CivilizationApocalypse_BP/scripts/civ/wallleafpreview.js";
const key=p=>`${p.x},${p.y},${p.z}`;
const p=i=>({x:-433+i*5,y:64,z:-578});
const op=(at,id="minecraft:stone_bricks",kind="wall")=>({...at,id,kind});
const block=(typeId="minecraft:air",persistent)=>({isValid:true,typeId,states:{persistent_bit:persistent}});
function fixture(n=17) {
    const record={checksum:"35635162",...Object.fromEntries(SITE_STAGES.map(s=>[s,[]]))};
    record.walls=Array.from({length:n},(_,i)=>({id:`wall-${i}`,ops:[op(p(i))]}));
    const cells=new Map(Array.from({length:n},(_,i)=>[key(p(i)),block("minecraft:oak_leaves",false)])),protectedColumns=new Set();
    const readLog=[];
    const input={record,records:[record],read(at){readLog.push(key(at));return structuredClone(cells.get(key(at))??block());},
        isProtected:(x,z)=>protectedColumns.has(`${x},${z}`)};
    const deps={opsFor:(r,s,i)=>r[s][i].ops};
    return {record,cells,protectedColumns,input,deps,readLog,run:()=>runSync(previewWallLeavesSteps(input,deps))};
}

test("synthetic seventeen-target production preview lists every coordinate and all27 contacts without mutation",()=>{
    const f=fixture(),before=structuredClone([...f.cells]),result=f.run();
    assert.equal(result.complete,true);assert.equal(result.targets,17);assert.equal(result.tree,17);assert.equal(result.eligible,17);
    assert.equal(result.rows.length,17);assert.ok(result.rows.every(r=>r.contacts.length===27&&r.persistent===false));
    assert.deepEqual([...f.cells],before);
    const lines=formatWallLeafPreview(result);assert.ok(lines.length<=32);
    for(let i=0;i<17;i++)assert.ok(lines.some(line=>line.startsWith(key(p(i))+" ")),"each candidate is individually reported");
    assert.ok(result.stats.maxReads<=WALL_LEAF_PREVIEW_LIMITS.readsPerSlice);assert.ok(result.stats.maxOps<=WALL_LEAF_PREVIEW_LIMITS.opsPerSlice);
});

test("preview respects full final ownership and historical decoration from all source plans",()=>{
    const air=fixture(1);air.record.dressing.push({id:"later-air",ops:[op(p(0),"minecraft:air","dressing")]});assert.equal(air.run().targets,0);
    const later=fixture(1);later.record.roads.push({id:"later-same-id",ops:[op(p(0),"minecraft:stone_bricks","road")]});assert.match(later.run().rows[0].reason,/final stateless solid masonry wall owner/);
    for(const own of [false,true]) {
        const f=fixture(1),r=own?f.record:{checksum:"1234abcd",...Object.fromEntries(SITE_STAGES.map(s=>[s,[]]))};
        if(!own)f.input.records.push(r);
        const at={...p(0),x:p(0).x+1};r.lots.push({id:"old-decoration",ops:[op(at,"minecraft:oak_leaves","building")]});
        r.dressing.push({id:"overwrite",ops:[op(at,"minecraft:air","dressing")]});
        const result=f.run();assert.equal(result.refused,1);assert.match(result.rows[0].reason,/historical planned vegetation\/decor/);
    }
});

test("protection, player leaves, logs/vines, local copper and unknown contacts produce exact refusals",()=>{
    const cases=[
        {target:block("minecraft:oak_leaves",true),reason:/nonpersistent natural leaf/},
        {target:block("minecraft:oak_leaves"),reason:/nonpersistent natural leaf/},
        {target:block("minecraft:oak_log"),reason:/nonpersistent natural leaf/},
        {target:block("minecraft:vine"),reason:/nonpersistent natural leaf/},
        {contact:block("minecraft:copper_ore"),reason:/foreign contact.*copper_ore/},
        {contact:block("minecraft:chest"),reason:/foreign contact.*chest/},
        {contact:block("minecraft:oak_leaves",true),reason:/persistent or unknown-state leaf contact/},
        {protect:true,reason:/protected or unknown neighboring column/},
    ];
    for(const row of cases) {
        const f=fixture(1),at={...p(0),x:p(0).x+1};
        if(row.target)f.cells.set(key(p(0)),row.target);if(row.contact)f.cells.set(key(at),row.contact);if(row.protect)f.protectedColumns.add(`${at.x},${at.z}`);
        const result=f.run();assert.equal(result.eligible,0);assert.equal(result.refused,1);assert.match(result.rows[0].reason,row.reason);assert.equal(result.rows[0].contacts.length,27);
    }
});

test("unreadable wall targets or contacts remain incomplete and expose exact coordinates",()=>{
    const f=fixture(1),read=f.input.read;
    f.input.read=at=>key(at)===key(p(0))?undefined:read(at);
    let result=f.run();assert.equal(result.complete,false);assert.equal(result.unloaded,1);assert.match(result.unloadedSamples[0],new RegExp(key(p(0))));
    const g=fixture(1),original=g.input.read,at={...p(0),x:p(0).x+1};
    g.input.read=q=>key(q)===key(at)?undefined:original(q);
    result=g.run();assert.equal(result.complete,false);assert.equal(result.contactsUnread,1);assert.match(result.rows[0].reason,/unreadable contact/);assert.equal(result.rows[0].contacts.length,27);
    assert.match(formatWallLeafPreview(result).join("\n"),/unreadable walls 0, contacts 1/);
});

test("candidate cap and pagination are explicit, bounded and deterministic; cancellation does no write",()=>{
    const f=fixture(65),result=f.run();assert.equal(result.tree,65);assert.equal(result.rows.length,64);assert.equal(result.truncated,true);assert.equal(result.complete,false);
    for(let page=1;page<=3;page++){const lines=formatWallLeafPreview(result,page);assert.ok(lines.length<=32);assert.ok(lines[2].includes(`page ${page}/3`));}
    assert.match(formatWallLeafPreview(result,4).join("\n"),/outside 1\.\.3/);
    const g=fixture(1);g.input.cancelled=()=>true;assert.throws(()=>g.run(),/cancelled/);assert.equal(g.readLog.length,0);
});

test("native-command boundary uses saved-plan proof and never writes properties, blocks or leases",{timeout:120000},async()=>{
    const h=await import("../lib/civharness.mjs");
    h.resetWorld(1);let outcome;h.builder.seams.onOutcome=o=>{outcome=o;};
    const player=h.makePlayer();h.send(h.CIV_EVENT_IDS.generate,"seed=7",player);await h.pump({until:()=>h.builder.hasSession()});
    assert.ok(outcome?.record);h.send(h.CIV_EVENT_IDS.abort,"",player);await h.pump();
    const jobStore=h.jobsModule.createJobStore(h.mc.world,{prefix:h.builder.jobPrefixFor(1)}),loaded=jobStore.loadQueue();
    for(let i=0;i<loaded.queue.total.length;i++)h.jobsModule.markProgress(loaded.queue,i,loaded.queue.total[i]);assert.equal(loaded.queue.state,"complete");assert.equal(jobStore.saveQueue(loaded.queue).ok,true);
    const kingdom=h.store.load().kingdom;kingdom.districts[0].civ.status="complete";kingdom.districts[0].civ.stage="complete";h.store.save(kingdom);
    const target=outcome.record.walls.flatMap((_,i)=>h.siteplan.siteOpsFor(outcome.record,"walls",i)).find(o=>o.id==="minecraft:stone_bricks"&&o.kind==="wall");assert.ok(target);
    const oldRead=h.dimension.getBlock,oldSet=h.mc.world.setDynamicProperty,manager=h.mc.world.tickingAreaManager;
    const methods=["createTickingArea","removeTickingArea","getAllTickingAreas","hasCapacity"].map(name=>[name,manager[name]]),calls=[];
    h.dimension.getBlock=at=>key(at)===key(target)?block("minecraft:oak_leaves",false):block();
    h.mc.world.setDynamicProperty=()=>{calls.push("property write");throw Error("preview must not save");};
    for(const [name] of methods)manager[name]=()=>{calls.push(name);throw Error("preview must not mutate leases");};
    const before=h.propsSnapshot(),blocks=h.worldFingerprint(),writes=h.mc.writes,reply=h.makePlayer();
    try {
        h.send(h.CIV_EVENT_IDS.diag,"leafpreview district=1",reply);await h.pump();
        assert.match(h.text(reply),/Wall leaf preview: complete/);assert.ok(h.text(reply).includes(key(target)+" minecraft:oak_leaves"),h.text(reply).slice(-1500));
        assert.match(h.text(reply),/no blocks\/properties\/queues\/leases changed/);
        assert.deepEqual(calls,[]);assert.deepEqual(h.propsSnapshot(),before);assert.deepEqual(h.worldFingerprint(),blocks);assert.equal(h.mc.writes,writes);assert.equal(h.districtBuilder.isBusy(),false);
    } finally {
        h.dimension.getBlock=oldRead;h.mc.world.setDynamicProperty=oldSet;for(const [name,method] of methods)manager[name]=method;
    }
});
