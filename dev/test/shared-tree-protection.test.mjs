import assert from "node:assert/strict";
import test from "node:test";
import { compileSharedTreeProtectionSteps,onExactOutline } from "../../CivilizationApocalypse_BP/scripts/civ/sharedtree.js";
import { SITE_STAGES } from "../../CivilizationApocalypse_BP/scripts/civ/districtplan.js";
import { isTreePart } from "../../CivilizationApocalypse_BP/scripts/structures/terrain.js";
import { mc,resetWorld,makePlayer,send,pump,text,builder,store,planstore,siteplan,CIV_EVENT_IDS,districtBuilder,findValidationProblems } from "../lib/civharness.mjs";

const region={x0:0,z0:0,x1:10,z1:10};
const op=(x,y,z,id)=>({x,y,z,id,kind:"structure"});
const opsFor=(record,stage,index)=>record[stage][index].ops;
function record(stages={}) {return Object.fromEntries(SITE_STAGES.map(stage=>[stage,stages[stage] ? [{ops:stages[stage]}] : []]));}
function compile(records,relevant=()=>true) {
    const generator=compileSharedTreeProtectionSteps(records,region,relevant,{opsFor});
    for(;;){const next=generator.next();if(next.done)return next.value;}
}

test("shared tree protection retains historical wood/leaves/vines and unions only each neighbor's final non-tree contacts",()=>{
    const first=record({walls:[op(1,71,1,"minecraft:oak_log"),op(2,71,1,"minecraft:stone_bricks"),op(3,71,1,"minecraft:stone_bricks")],
        lots:[op(1,71,1,"minecraft:air"),op(2,71,1,"minecraft:air"),op(4,71,1,"minecraft:oak_leaves"),op(5,71,1,"minecraft:vine")],
        dressing:[op(4,71,1,"minecraft:stone_bricks"),op(6,71,1,"minecraft:birch_log")]});
    const second=record({walls:[op(3,71,1,"minecraft:polished_andesite")],lots:[op(7,71,1,"minecraft:stone_bricks")],
        dressing:[op(7,71,1,"minecraft:oak_leaves")]});
    const before=JSON.stringify([first,second]);
    const result=compile([first,second]);
    assert.deepEqual([...result.plannedTrees].sort(),["1,71,1","4,71,1","5,71,1","6,71,1","7,71,1"]);
    assert.equal(result.finalBlocks.has("1,71,1"),false,"later air removes a contact, never its historical wood veto");
    assert.equal(result.finalBlocks.has("2,71,1"),false,"an old wall replaced by air is not a final contact");
    assert.deepEqual(result.finalBlocks.get("3,71,1"),["minecraft:stone_bricks","minecraft:polished_andesite"]);
    assert.deepEqual(result.finalBlocks.get("4,71,1"),["minecraft:stone_bricks"]);
    assert.equal(result.finalBlocks.has("5,71,1"),false);assert.equal(result.finalBlocks.has("6,71,1"),false);
    assert.equal(result.finalBlocks.has("7,71,1"),false,"a later planted leaf removes an earlier masonry contact");
    assert.equal(JSON.stringify([first,second]),before);
});

test("shared tree compilation bounds all historical trees but limits final contacts to the protected outer margin",()=>{
    const source=record({walls:[op(-17,71,1,"minecraft:oak_log"),op(-18,71,1,"minecraft:oak_log"),
        op(27,71,1,"minecraft:stone_bricks"),op(28,71,1,"minecraft:stone_bricks"),
        op(1,71,-17,"minecraft:vine"),op(1,71,-18,"minecraft:vine"),
        op(1,71,27,"minecraft:oak_leaves"),op(1,71,28,"minecraft:oak_leaves"),
        op(3,71,3,"minecraft:oak_log"),op(4,71,4,"minecraft:stone_bricks")]});
    const result=compile([source],(x,z)=>!(x===3&&z===3)&&!(x===4&&z===4));
    assert.deepEqual([...result.plannedTrees].sort(),["-17,71,1","1,71,-17","1,71,27","3,71,3"]);
    assert.deepEqual([...result.finalBlocks.keys()],["27,71,1"]);
});

test("shared tree compilation yields while scanning irrelevant operations and refuses incomplete source stages",()=>{
    const source=record({walls:Array.from({length:2001},(_,n)=>op(100+n,71,100,"minecraft:oak_log"))});
    const generator=compileSharedTreeProtectionSteps([source],region,()=>true,{opsFor});
    let yields=0,result;
    for(;;){const next=generator.next();if(next.done){result=next.value;break;}yields++;}
    assert.ok(yields>=5,"work is bounded even when no cells are retained");
    assert.equal(result.plannedTrees.size,0);assert.equal(result.finalBlocks.size,0);
    const broken=record();delete broken.dressing;
    assert.throws(()=>compile([broken]),/no dressing stage/);
});

let fixturePromise;
function savedCommandFixture() {
    fixturePromise ??= (async()=>{
        resetWorld(1);
        let outcome;
        builder.seams.onOutcome=value=>{outcome=value;};
        const player=makePlayer();
        send(CIV_EVENT_IDS.generate,"seed=1",player);
        await pump({until:()=>builder.hasSession()});
        assert.equal(builder.hasSession(),true,text(player).slice(-1000));
        send(CIV_EVENT_IDS.abort,"",player);await pump();
        const kingdom=store.load().kingdom;
        kingdom.districts[0].civ.status="complete";
        assert.deepEqual(findValidationProblems(kingdom),[]);store.save(kingdom);
        return {props:new Map(mc.props),own:structuredClone(kingdom.districts[0].civ),plan:outcome.plan,region:outcome.region};
    })();
    return fixturePromise;
}

test("maintenance and tree inspection refuse building or unverifiable neighbors before any world or journal writes",{timeout:300000},async()=>{
    const fixture=await savedCommandFixture();
    for(const status of ["building","complete"])for(const command of ["repair district=1 confirm","tree district=1 x=0 y=71 z=0"]) {
        mc.props=new Map(fixture.props);
        const kingdom=store.load().kingdom;
        kingdom.districts[1].civ={...structuredClone(fixture.own),status,checksum:"no-neighbor-saved-plan"};
        assert.deepEqual(findValidationProblems(kingdom),[]);store.save(kingdom);
        const before={props:new Map(mc.props),blocks:new Map(mc.placed),writes:mc.writes,propWrites:mc.propWrites};
        const player=makePlayer();send(CIV_EVENT_IDS.diag,command,player);await pump();
        assert.match(text(player),/refused/i,text(player));
        assert.match(text(player),status==="building" ? /still building/ : /Cannot verify district-2/);
        assert.deepEqual(mc.props,before.props);assert.deepEqual(mc.placed,before.blocks);
        assert.equal(mc.writes,before.writes);assert.equal(mc.propWrites,before.propWrites);
        assert.equal(builder.hasSession(),false);assert.equal(districtBuilder.isBusy(),false);assert.equal(mc.areas.size,0);
    }
});

test("shared tree verification refuses missing and mismatched neighboring dimensions before writes",{timeout:300000},async()=>{
    const fixture=await savedCommandFixture();
    for(const neighborDimension of [undefined,"minecraft:nether"])for(const command of ["repair district=1 confirm","tree district=1 x=0 y=71 z=0"]) {
        mc.props=new Map(fixture.props);const kingdom=store.load().kingdom;
        kingdom.districts[1].civ={...structuredClone(fixture.own),status:"complete"};
        if(neighborDimension===undefined)delete kingdom.districts[1].civ.dimension;
        else kingdom.districts[1].civ.dimension=neighborDimension;
        assert.deepEqual(findValidationProblems(kingdom),[]);store.save(kingdom);
        const before={props:new Map(mc.props),blocks:new Map(mc.placed),writes:mc.writes,propWrites:mc.propWrites};
        const player=makePlayer();send(CIV_EVENT_IDS.diag,command,player);await pump();
        assert.match(text(player),/dimension is missing or differs/);
        assert.deepEqual(mc.props,before.props);assert.deepEqual(mc.placed,before.blocks);
        assert.equal(mc.writes,before.writes);assert.equal(mc.propWrites,before.propWrites);
        assert.equal(builder.hasSession(),false);assert.equal(districtBuilder.isBusy(),false);assert.equal(mc.areas.size,0);
    }
});

test("shared tree compilation reads a real checksum-rehydrated site through the production operation reader",{timeout:300000},async()=>{
    const fixture=await savedCommandFixture();mc.props=new Map(fixture.props);
    const stored=planstore.createPlanStore(mc.world,{prefix:builder.sitePrefixFor(1)}).loadPlan();
    assert.equal(stored.status,"ok");
    const rebuilt=siteplan.rehydrateSite(fixture.plan,1,stored.plan.ground,{...stored.plan.siteOptions,expectChecksum:fixture.own.checksum});
    assert.equal(rebuilt.ok,true,rebuilt.problems.join("; "));
    let tree;
    const final=new Map(),finalOps=new Map();
    for(const stage of SITE_STAGES)for(let i=0;i<rebuilt.record[stage].length;i++)for(const operation of siteplan.siteOpsFor(rebuilt.record,stage,i)) {
        const key=`${operation.x},${operation.y},${operation.z}`;
        if(isTreePart(operation.id)&&!tree)tree=key;
        final.set(key,operation.id);
        finalOps.set(key,{stage,...operation});
    }
    assert.ok(tree,"the real city plans wooden frames or planted leaves");
    const masonry=[...final].find(([_key,id])=>id==="minecraft:stone_bricks");assert.ok(masonry);
    const before={props:new Map(mc.props),blocks:new Map(mc.placed),writes:mc.writes,propWrites:mc.propWrites};
    const generator=compileSharedTreeProtectionSteps([rebuilt.record],fixture.region,()=>true);
    let result;
    for(;;){const next=generator.next();if(next.done){result=next.value;break;}}
    assert.equal(result.plannedTrees.has(tree),true);
    assert.deepEqual(result.finalBlocks.get(masonry[0]),[masonry[1]]);
    const boundary=result.boundaryPlans.find(plan=>plan.districtIndex===1);assert.ok(boundary);
    assert.ok(boundary.finalWalls.size>0,"real plan supplies exact boundary wall provenance");
    assert.deepEqual(boundary.outline,rebuilt.record.outline);
    for(const [key,id] of boundary.finalWalls) {
        const op=finalOps.get(key);assert.equal(op.stage,"walls");assert.equal(op.kind,"wall");assert.equal(op.id,id);
        assert.equal(onExactOutline(boundary.outline,op.x,op.z),true);
    }
    assert.deepEqual(mc.props,before.props);assert.deepEqual(mc.placed,before.blocks);
    assert.equal(mc.writes,before.writes);assert.equal(mc.propWrites,before.propWrites);
});

test("exact outline membership rejects near edges, unsupported arithmetic and degenerate or fractional geometry",()=>{
    const outline=[[-220,-584],[-220,-600],[-230,-600],[-230,-584]];
    assert.equal(onExactOutline(outline,-220,-595),true);
    assert.equal(onExactOutline(outline,-220,-600),true,"endpoints are exact boundary too");
    for(const [x,z] of [[-219,-595],[-221,-595],[-220,-601],[-220.00001,-595]])assert.equal(onExactOutline(outline,x,z),false);
    assert.equal(onExactOutline([[0,0],[0,0],[0,0]],0,0),false);
    assert.equal(onExactOutline([[0,0],[1.5,1],[0,2]],0,0),false);
    const n=Number.MAX_SAFE_INTEGER;
    assert.equal(onExactOutline([[-n,-n],[n,n],[n,-n]],0,0),false);
});

test("boundary provenance retains only exact final wall-stage wall-kind IDs independently of contact filtering",()=>{
    const outline=[[0,-5],[5,-5],[5,5],[0,5]];
    const neighbor=record({walls:[op(0,71,0,"minecraft:stone_bricks"),op(0,72,0,"minecraft:stone_bricks"),op(0,73,0,"minecraft:stone_bricks"),op(0,74,0,"minecraft:stone_bricks")],
        lots:[op(0,72,0,"minecraft:air"),op(0,73,0,"minecraft:stone_bricks"),op(0,74,0,"minecraft:oak_log")]});
    neighbor.walls[0].ops.forEach(o=>o.kind="wall");neighbor.districtIndex=2;neighbor.outline=outline;
    const result=compile([neighbor],()=>false);
    assert.equal(result.finalBlocks.size,0,"boundary authorization does not come from the contact union");
    assert.deepEqual([...result.boundaryPlans[0].finalWalls],[["0,71,0","minecraft:stone_bricks"]]);
    assert.equal(result.boundaryPlans[0].districtIndex,2);assert.deepEqual(result.boundaryPlans[0].outline,outline);
    assert.equal(result.plannedTrees.has("0,74,0"),true);
});
