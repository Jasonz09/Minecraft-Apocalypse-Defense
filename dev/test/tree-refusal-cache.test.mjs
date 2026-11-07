import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {compileSharedTreeProtectionSteps} from "../../CivilizationApocalypse_BP/scripts/civ/sharedtree.js";
import { mc,resetWorld,key,typeAt,dimension,jobsModule,builder,districtBuilder,planstore,siteplan,CIV_EVENT_IDS,makePlayer,send,pump,text } from "../lib/civharness.mjs";

// Exercise the unchanged private proof/eraser functions rather than a model of
// their decisions. Import locations/private exports are instrumented; one tiny
// operation-stream seam exercises later writes without mirroring the indexer.
const productionUrl=new URL("../../CivilizationApocalypse_BP/scripts/integration/civBuilder.js",import.meta.url);
const production=readFileSync(fileURLToPath(productionUrl),"utf8");
const instrumented=production.replace(/from\s+"(\.[^"]+)"/g,(_all,specifier)=>`from ${JSON.stringify(new URL(specifier,productionUrl).href)}`)
    .replace("siteOpsFor,", "siteOpsFor as actualSiteOpsFor,")
    +"\nfunction siteOpsFor(record,stage,index) { return record.__testOps ? record.__testOps[stage][index] : actualSiteOpsFor(record,stage,index); }\nexport {createConstructionSession,clearTree,indexOwnBlocks,applyOp};\n";
const {createConstructionSession,clearTree,indexOwnBlocks,applyOp}=await import("data:text/javascript,"+encodeURIComponent(instrumented));

function run(generator) { for(;;) { const result=generator.next();if(result.done)return result.value; } }

test("a cleared neighboring canopy invalidates an older size refusal without weakening the natural-tree proof",()=>{
    resetWorld(1,{field:{base:70,relief:0,hills:0,forest:0}});
    const a={x:0,y:71,z:0}, b={x:12,y:71,z:0};
    for(const x of [0,12])mc.placed.set(key(x,70,0),"minecraft:grass_block");
    for(let y=76;y<=99;y++)for(let x=-6;x<=6;x++)for(let z=-6;z<=6;z++)mc.placed.set(key(x,y,z),"minecraft:jungle_leaves");
    for(let y=83;y<=88;y++)for(let x=6;x<=18;x++)for(let z=-6;z<=6;z++)mc.placed.set(key(x,y,z),"minecraft:jungle_leaves");
    for(let y=71;y<=110;y++)mc.placed.set(key(0,y,0),"minecraft:jungle_log");
    for(let y=71;y<=88;y++)mc.placed.set(key(12,y,0),"minecraft:jungle_log");
    const journal=jobsModule.createJobStore(mc.world,{prefix:"probe:tree-cache"});
    function session() {
        const queue=jobsModule.createQueue({clear:[{total:1,hash:1}]},{planHash:"tree-cache-probe"});
        const s=createConstructionSession({token:{kind:"probe",cancelled:false},dimension,queue,
            record:{checksum:"tree-cache-probe"},plan:{},region:{x0:-50,z0:-50,x1:50,z1:50},protectedRects:[],
            say(){},onEnd(){},saveCiv(){},saveQueue:q=>journal.saveQueue(q)});
        s.cur={element:0,cursor:0};return s;
    }
    const s=session(), initial=run(clearTree(s,a));
    assert.equal(initial.ok,false);assert.match(initial.reason,/larger than 4000/);
    assert.equal(mc.writes,0,"the oversized canopy remains untouched");
    assert.ok(s.treeRefused.size>0,"unchanged vegetation can reuse the refusal");
    assert.equal(run(clearTree(s,b)).ok,true);
    assert.equal(mc.writes,1052,"only the separately proven neighboring tree is erased");
    assert.equal(typeAt(a.x,a.y,a.z),"minecraft:jungle_log","the other trunk remains intact");
    const retry=run(clearTree(s,a,true)), fresh=run(clearTree(session(),a,true));
    assert.equal(retry.ok,true,"same-session retry must inspect the changed canopy");
    assert.deepEqual(retry,fresh,"the result matches a fresh proof of the same live blocks");
    assert.equal(retry.cells,3968);assert.ok(retry.cells<=4000,"the original clearance cap still applies");
    const writes=mc.writes, propertyWrites=mc.propWrites;
    mc.placed.set(key(0,72,1),"minecraft:chest");
    assert.match(run(clearTree(s,a)).reason,/chest touches a tree/);
    assert.equal(mc.writes,writes,"the rechecked proof still preserves neighboring player work");
    assert.equal(mc.propWrites,propertyWrites,"a refused proof is not persisted");
    assert.equal(typeAt(0,72,1),"minecraft:chest");
    assert.equal(journal.loadQueue().status,"ok");
});

let marginPlan;
async function realMarginPlan() {
    if(marginPlan)return marginPlan;
    resetWorld(1,{field:{base:70,relief:0,hills:90,forest:0}});
    const player=makePlayer(0,0);send(CIV_EVENT_IDS.generate,"seed=1",player);
    await pump({until:()=>builder.hasSession()});assert.ok(builder.hasSession(),text(player));
    send(CIV_EVENT_IDS.abort,"",player);await pump();assert.equal(districtBuilder.isBusy(),false);
    const master=builder.loadMasterPlan(),stored=planstore.createPlanStore(mc.world,{prefix:builder.sitePrefixFor(1)}).loadPlan();
    const restored=siteplan.rehydrateSite(master.plan,1,stored.plan.ground,{...stored.plan.siteOptions,expectChecksum:stored.plan.siteChecksum});
    assert.ok(restored.ok);
    const record=restored.record,final=new Map(),walls=[];
    for(const stage of ["clear","walls","gates","roads","lots","dressing"])
        for(let i=0;i<record[stage].length;i++)for(const op of siteplan.siteOpsFor(record,stage,i)) {
            final.set(key(op.x,op.y,op.z),op);if(stage==="walls")walls.push(op);
        }
    const stone=op=>op?.kind==="wall"&&op.id.includes("stone")&&!op.id.includes("stairs");
    const spot=walls.find(op=>op.y>=71&&stone(op)&&[0,1,2,3].every(d=>stone(final.get(key(op.x,op.y+d,op.z)))));
    assert.ok(spot,"real plan supplies a final wall column");
    return marginPlan={record,plan:master.plan,region:record.ground.region,spot};
}

function marginArea(spot,interior=false) {
    const edge=spot.x+(interior?1:-1);
    return {x0:spot.x-9,z0:spot.z-9,x1:edge+3,z1:spot.z+9,grow:3,
        polygon:[[spot.x-6,spot.z-6],[edge,spot.z-6],[edge,spot.z+6],[spot.x-6,spot.z+6]]};
}
function marginSession(f,{protection={plannedTrees:new Set(),finalBlocks:new Map()},areas=[marginArea(f.spot)],repair=true,queue}={}) {
    const journal=jobsModule.createJobStore(mc.world,{prefix:"probe:shared-tree"});
    const s=createConstructionSession({token:{kind:"probe",cancelled:false},dimension,record:f.record,plan:f.plan,
        region:f.region,protectedRects:areas,completedCityRepair:repair,sharedTreeProtection:protection,
        queue:queue??jobsModule.createQueue(siteplan.siteJobSpecs(f.record),{planHash:f.record.checksum}),district:1,
        say(){},onEnd(){},saveCiv(){return true;},saveQueue:q=>journal.saveQueue(q)});
    s.cur={element:0,cursor:0};run(indexOwnBlocks(s));return s;
}
function plantMarginTree(spot,height=4) {
    resetWorld(1,{field:{base:70,relief:0,hills:90,forest:0}});
    mc.placed.set(key(spot.x,spot.y-1,spot.z),"minecraft:grass_block");
    for(let d=0;d<height;d++)mc.placed.set(key(spot.x,spot.y+d,spot.z),"minecraft:oak_log");
    mc.placed.set(key(spot.x,spot.y+height,spot.z),"minecraft:oak_leaves");
}

test("verified completed-city repair clears exact final shared-wall logs while ordinary construction and missing verification preserve them",async()=>{
    const f=await realMarginPlan();
    for(const options of [{repair:false},{protection:undefined}]) {
        plantMarginTree(f.spot);
        const s=marginSession(f,options);
        // Explicit undefined must model absent command verification, not the fixture default.
        if("protection" in options)s.opts.sharedTreeProtection=undefined;
        const before=new Map(mc.placed);
        assert.equal(run(clearTree(s,f.spot)).ok,false);assert.deepEqual(mc.placed,before);assert.equal(mc.writes,0);
    }
    plantMarginTree(f.spot);const s=marginSession(f), propertyWrites=mc.propWrites, inspected=run(clearTree(s,f.spot,true));
    assert.equal(inspected.ok,true,inspected.reason);assert.equal(mc.writes,0);assert.equal(mc.propWrites,propertyWrites);
    assert.equal(run(clearTree(s,f.spot)).ok,true);
    for(let d=0;d<4;d++)assert.equal(typeAt(f.spot.x,f.spot.y+d,f.spot.z),"minecraft:air");
    assert.ok(mc.propWrites>propertyWrites,"the normal exact write-ahead journal is retained");
});

for(const kind of ["interior","prototype","unplanned log","neighbor planting","foreign chest","persistent leaf"])
test(`shared-margin repair preserves the whole component for ${kind}`,async()=>{
    const f=await realMarginPlan(),spot=f.spot;
    plantMarginTree(spot);
    let areas=[marginArea(spot)],protection={plannedTrees:new Set(),finalBlocks:new Map()};
    if(kind==="interior")areas=[marginArea(spot,true)];
    if(kind==="prototype")areas=[{x0:spot.x,z0:spot.z,x1:spot.x,z1:spot.z}];
    if(kind==="unplanned log") {
        const y=spot.y+30;for(let d=4;d<=30;d++)mc.placed.set(key(spot.x,spot.y+d,spot.z),"minecraft:oak_log");
        mc.placed.set(key(spot.x,y+1,spot.z),"minecraft:oak_leaves");
    }
    if(kind==="neighbor planting")protection.plannedTrees.add(key(spot.x,spot.y+4,spot.z));
    if(kind==="foreign chest")mc.placed.set(key(spot.x,spot.y+1,spot.z+1),"minecraft:chest");
    if(kind==="persistent leaf")mc.persistent=(x,y,z)=>x===spot.x&&y===spot.y+4&&z===spot.z;
    const s=marginSession({...f,spot},{areas,protection}),before={blocks:new Map(mc.placed),props:new Map(mc.props),propertyWrites:mc.propWrites,queue:JSON.stringify(s.queue)};
    const result=run(clearTree(s,spot));assert.equal(result.ok,false,result.reason);
    assert.deepEqual(mc.placed,before.blocks);assert.deepEqual(mc.props,before.props);assert.equal(JSON.stringify(s.queue),before.queue);
    assert.equal(mc.writes,0);assert.equal(mc.propWrites,before.propertyWrites);
});

test("a later operation replacing a shared wall target does not authorize tree erasure",()=>{
    const spot={x:0,y:71,z:0};plantMarginTree(spot,1);
    const op={...spot,id:"minecraft:stone_bricks",kind:"wall"};
    const record={checksum:"overwritten-wall",walls:[{id:"wall"}],lots:[{id:"lot"}],
        __testOps:{walls:[[op]],lots:[[{...spot,id:"minecraft:air",kind:"clear"}]]}};
    const f={spot,record,plan:{},region:{x0:-10,z0:-10,x1:10,z1:10}};
    const queue=jobsModule.createQueue({walls:[{total:1,hash:1}],lots:[{total:1,hash:2}]},{planHash:record.checksum});
    const s=marginSession(f,{queue}),before=new Map(mc.placed),propertyWrites=mc.propWrites;
    assert.equal(run(clearTree(s,spot)).ok,false);
    assert.deepEqual(mc.placed,before);assert.equal(mc.writes,0);assert.equal(mc.propWrites,propertyWrites);
});

test("verified neighboring masonry permits contact without repainting it, while a different live block still vetoes clearance",async()=>{
    const f=await realMarginPlan(),spot=f.spot,contact={x:spot.x,y:spot.y+1,z:spot.z+1};
    for(const id of ["minecraft:chest","minecraft:stone_bricks"]) {
        plantMarginTree(spot);mc.placed.set(key(contact.x,contact.y,contact.z),id);
        const protection={plannedTrees:new Set(),finalBlocks:new Map([[key(contact.x,contact.y,contact.z),["minecraft:stone_bricks"]]])};
        const s=marginSession(f,{protection}),before=new Map(mc.placed),writes=mc.writes;
        const result=run(clearTree(s,spot));
        assert.equal(result.ok,id==="minecraft:stone_bricks",result.reason);
        assert.equal(typeAt(contact.x,contact.y,contact.z),id,"neighbor contact never becomes an erasure target");
        if(id==="minecraft:chest") {assert.deepEqual(mc.placed,before);assert.equal(mc.writes,writes);}
    }
});

test("a shared-margin pending proof resumes unchanged, but a new protected interior stops before another write",async()=>{
    const f=await realMarginPlan();
    for(const changed of [false,true]) {
        plantMarginTree(f.spot);const s=marginSession(f);
        s.meter.writes=399;const work=clearTree(s,f.spot);
        while(!mc.writes)assert.equal(work.next().done,false);
        assert.ok(s.queue.treeClearance,"interruption retains the exact proof");
        const queue=JSON.parse(JSON.stringify(s.queue)),before=new Map(mc.placed),writes=mc.writes;
        const resumed=marginSession(f,{queue,areas:[marginArea(f.spot,changed)]});
        if(changed) {
            assert.throws(()=>run(clearTree(resumed,f.spot)),/Pending tree clearance crosses protected clearance/);
            assert.equal(mc.writes,writes);assert.deepEqual(mc.placed,before);assert.ok(resumed.queue.treeClearance);
        } else {
            assert.equal(run(clearTree(resumed,f.spot)).ok,true);assert.equal(resumed.queue.treeClearance,undefined);
            for(let d=0;d<4;d++)assert.equal(typeAt(f.spot.x,f.spot.y+d,f.spot.z),"minecraft:air");
        }
    }
});

function boundarySession(region,protectedRects) {
    const queue=jobsModule.createQueue({clear:[{total:1,hash:1}]},{planHash:"tree-boundary-probe"});
    const s=createConstructionSession({token:{kind:"probe",cancelled:false},dimension,queue,
        record:{checksum:"tree-boundary-probe"},plan:{},region,protectedRects,
        say(){},onEnd(){},saveCiv(){throw new Error("a refused boundary proof must not save progress");},
        saveQueue(){throw new Error("a refused boundary proof must not save a journal");}});
    s.cur={element:0,cursor:0};return s;
}

function plantBoundaryTree(branchLength) {
    resetWorld(1,{field:{base:70,relief:0,hills:0,forest:0}});
    mc.placed.set(key(0,70,0),"minecraft:grass_block");
    for(let y=71;y<=74;y++)mc.placed.set(key(0,y,0),"minecraft:jungle_log");
    for(let x=1;x<=branchLength;x++)mc.placed.set(key(x,74,0),"minecraft:jungle_log");
    mc.placed.set(key(0,75,0),"minecraft:jungle_leaves");
    mc.placed.set(key(branchLength,75,0),"minecraft:jungle_leaves");
}

function exactBoundaryFixture(change=()=>{}) {
    const spot={x:0,y:71,z:0},ownOutline=[[-10,-10],[0,-10],[0,10],[-10,10]],neighborOutline=[[0,-10],[10,-10],[10,10],[0,10]];
    const wallOps=Array.from({length:4},(_,i)=>({...spot,y:71+i,id:"minecraft:stone_bricks",kind:"wall"}));
    const makeRecord=(districtIndex,outline)=>({checksum:`boundary-${districtIndex}`,districtIndex,outline,
        clear:[],walls:[{id:"wall"}],gates:[],roads:[],lots:[],dressing:[],__testOps:{walls:[structuredClone(wallOps)]}});
    const record=makeRecord(1,ownOutline),neighbor=makeRecord(2,neighborOutline);
    const area={x0:-4,z0:-14,x1:14,z1:14,polygon:neighborOutline,grow:4,districtIndex:2};
    const fixture={spot,record,neighbor,areas:[area],plan:{},region:{x0:-20,z0:-20,x1:20,z1:20},repair:true};
    change(fixture);
    const protection=run(compileSharedTreeProtectionSteps([fixture.neighbor],fixture.region,()=>false,
        {opsFor:(r,stage,i)=>r.__testOps[stage]?.[i]??[]}));
    const specs={walls:[{total:4,hash:1}],...(record.lots.length?{lots:[{total:record.__testOps.lots[0].length,hash:2}]}:{})};
    const queue=jobsModule.createQueue(specs,{planHash:record.checksum});
    return {...fixture,protection,queue};
}

test("exact shared-boundary walls permit read-only proof and journaled clearance with independently compiled neighbor provenance",()=>{
    plantBoundaryTree(0);const f=exactBoundaryFixture(),s=marginSession(f,{...f});
    const writes=mc.propWrites;
    assert.equal(run(clearTree(s,f.spot,true)).ok,true);assert.equal(mc.writes,0);assert.equal(mc.propWrites,writes);
    assert.equal(run(clearTree(s,f.spot)).ok,true);
    for(let y=71;y<=74;y++)assert.equal(typeAt(0,y,0),"minecraft:air");
    assert.ok(mc.propWrites>writes);
});

for(const variation of ["normal construction","own interior","neighbor interior","unknown provenance","prototype","third interior","different neighbor ID","neighbor later air","neighbor later same ID nonwall","own later same ID nonwall","own later wall-stage footing","unplanned branch","historical planting","foreign chest","persistent leaves"])
test(`shared-boundary clearance preserves the whole component for ${variation}`,()=>{
    plantBoundaryTree(0);
    const f=exactBoundaryFixture(f=>{
        if(variation==="normal construction")f.repair=false;
        if(variation==="own interior")f.record.outline=[[-10,-10],[1,-10],[1,10],[-10,10]];
        if(variation==="neighbor interior")f.areas[0].polygon=[[-1,-10],[10,-10],[10,10],[-1,10]];
        if(variation==="unknown provenance")delete f.areas[0].districtIndex;
        if(variation==="prototype")f.areas.push({x0:0,z0:0,x1:0,z1:0});
        if(variation==="third interior")f.areas.push({x0:-2,z0:-2,x1:2,z1:2,polygon:[[-2,-2],[2,-2],[2,2],[-2,2]],districtIndex:3});
        if(variation==="different neighbor ID")f.neighbor.__testOps.walls[0][1].id="minecraft:mossy_stone_bricks";
        if(variation.startsWith("neighbor later")) {
            f.neighbor.lots=[{id:"later"}];f.neighbor.__testOps.lots=[[{x:0,y:72,z:0,id:variation.endsWith("air")?"minecraft:air":"minecraft:stone_bricks",kind:"structure"}]];
        }
        if(variation==="own later same ID nonwall") {
            f.record.lots=[{id:"later"}];f.record.__testOps.lots=[[{x:0,y:72,z:0,id:"minecraft:stone_bricks",kind:"structure"}]];
        }
        if(variation==="own later wall-stage footing")f.record.__testOps.walls[0].push({...f.spot,y:72,id:"minecraft:stone_bricks",kind:"footing"});
        if(variation==="unplanned branch") {
            mc.placed.set(key(0,75,0),"minecraft:jungle_log");mc.placed.set(key(0,76,0),"minecraft:jungle_leaves");
        }
        if(variation==="historical planting") {
            f.neighbor.clear=[{id:"old planting"}];f.neighbor.__testOps.clear=[[{x:0,y:72,z:0,id:"minecraft:oak_log",kind:"structure"}]];
        }
        if(variation==="foreign chest")mc.placed.set(key(1,72,0),"minecraft:chest");
        if(variation==="persistent leaves")mc.persistent=(x,y,z)=>x===0&&y===75&&z===0;
    });
    const s=marginSession(f,{...f}),before={blocks:new Map(mc.placed),properties:new Map(mc.props),writes:mc.propWrites};
    const result=run(clearTree(s,f.spot));assert.equal(result.ok,false,result.reason);
    assert.equal(mc.writes,0);assert.equal(mc.propWrites,before.writes);
    assert.deepEqual(mc.placed,before.blocks);assert.deepEqual(mc.props,before.properties);
});

test("maintenance restores exact shared-boundary masonry after proven clearance and preserves foreign occupancy",()=>{
    for(const foreign of [false,true]) {
        plantBoundaryTree(0);const f=exactBoundaryFixture(),s=marginSession(f,{...f});
        s.lastStage="walls";s.heldRect={x0:-30,z0:-30,x1:30,z1:30};
        if(foreign)mc.placed.set(key(0,71,0),"minecraft:chest");
        const operation=f.record.__testOps.walls[0][0],before=new Map(mc.placed);
        assert.equal(run(applyOp(s,operation)),"ok");
        if(foreign) {assert.deepEqual(mc.placed,before);assert.equal(mc.writes,0);}
        else {assert.equal(typeAt(0,71,0),"minecraft:stone_bricks");assert.equal(s.counts.placed,1);}
    }
});

test("a third boundary claimant with conflicting final masonry vetoes the whole tree",()=>{
    plantBoundaryTree(0);const f=exactBoundaryFixture();
    const third=structuredClone(f.protection.boundaryPlans[0]);third.districtIndex=3;
    third.finalWalls.set(key(0,72,0),"minecraft:mossy_stone_bricks");
    f.protection.boundaryPlans.push(third);f.areas.push({...f.areas[0],districtIndex:3});
    const s=marginSession(f,{...f}),before=new Map(mc.placed),writes=mc.propWrites;
    assert.equal(run(clearTree(s,f.spot)).ok,false);
    assert.deepEqual(mc.placed,before);assert.equal(mc.writes,0);assert.equal(mc.propWrites,writes);
});

test("pending shared-boundary proof rejects changed neighbor final permission before resumed erasure",()=>{
    plantBoundaryTree(0);const f=exactBoundaryFixture(),s=marginSession(f,{...f});s.meter.writes=399;
    const work=clearTree(s,f.spot);while(!mc.writes)assert.equal(work.next().done,false);
    const queue=JSON.parse(JSON.stringify(s.queue)),writes=mc.writes,before=new Map(mc.placed);
    const changed=exactBoundaryFixture(f=>{f.neighbor.__testOps.walls[0][1].id="minecraft:mossy_stone_bricks";});
    const resumed=marginSession(changed,{...changed,queue});
    assert.throws(()=>run(clearTree(resumed,changed.spot)),/Pending tree clearance crosses protected clearance/);
    assert.equal(mc.writes,writes);assert.deepEqual(mc.placed,before);assert.ok(resumed.queue.treeClearance);
});

test("a restart between completed boundary clearance and masonry placement restores the exact final wall",()=>{
    plantBoundaryTree(0);const f=exactBoundaryFixture(),s=marginSession(f,{...f});
    assert.equal(run(clearTree(s,f.spot)).ok,true);assert.equal(s.queue.treeClearance,undefined);
    const restored=exactBoundaryFixture(),queue=JSON.parse(JSON.stringify(s.queue));
    const resumed=marginSession(restored,{...restored,queue});resumed.lastStage="walls";
    resumed.heldRect={x0:-30,z0:-30,x1:30,z1:30};
    assert.equal(run(applyOp(resumed,restored.record.__testOps.walls[0][0])),"ok");
    assert.equal(typeAt(0,71,0),"minecraft:stone_bricks");assert.equal(resumed.counts.placed,1);
});

for(const fixture of [
    {name:"protected neighbor clearance",branchLength:1,region:{x0:-10,z0:-10,x1:10,z1:10},
        protectedRects:[{x0:1,z0:0,x1:1,z1:0}],expected:"minecraft:jungle_log at 1,74,0: inside protected clearance"},
    {name:"bounded district clearance",branchLength:5,region:{x0:-10,z0:-10,x1:0,z1:10},
        protectedRects:[],expected:"minecraft:jungle_log at 5,74,0: outside bounded district clearance"},
])test(`tree refusal identifies the first log crossing ${fixture.name} and preserves the whole component`,()=>{
    plantBoundaryTree(fixture.branchLength);
    const s=boundarySession(fixture.region,fixture.protectedRects);
    const before={blocks:new Map(mc.placed),states:new Map(mc.blockStates),props:new Map(mc.props),queue:JSON.stringify(s.queue)};
    const writes=mc.writes,propertyWrites=mc.propWrites;
    const inspected=run(clearTree(s,{x:0,y:71,z:0},true));
    const refused=run(clearTree(s,{x:0,y:71,z:0}));
    assert.equal(inspected.ok,false);assert.equal(refused.ok,false);
    assert.equal(inspected.reason,refused.reason,"inspection and normal construction share the same diagnostic");
    assert.ok(refused.reason.includes(fixture.expected),refused.reason);
    assert.match(refused.reason,/the component was kept whole/);
    assert.equal(inspected.logs,4+fixture.branchLength);
    assert.equal(s.treeRefused.size,0,"boundary refusals remain uncached");
    assert.equal(mc.writes,writes);assert.equal(mc.propWrites,propertyWrites);
    assert.deepEqual(mc.placed,before.blocks);assert.deepEqual(mc.blockStates,before.states);assert.deepEqual(mc.props,before.props);
    assert.equal(JSON.stringify(s.queue),before.queue,"no pending proof or construction cursor is changed");
});
