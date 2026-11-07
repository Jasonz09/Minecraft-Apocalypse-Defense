import assert from "node:assert/strict";
import test from "node:test";
import { CIV, PEOPLE } from "../../CivilizationApocalypse_BP/scripts/config.js";
import { createInitialKingdom } from "../../CivilizationApocalypse_BP/scripts/kingdom/state.js";
import { createMilitaryCommand, MILITARY_FIXTURE_ID } from "../../CivilizationApocalypse_BP/scripts/commands/military.js";
import { MILITARY_SELECTION_KEY } from "../../CivilizationApocalypse_BP/scripts/population/militarySelection.js";

const select=`select district=1 group=0 fixture=${MILITARY_FIXTURE_ID} confirm`;
function fixture() {
    const kingdom=createInitialKingdom();
    kingdom.districts[0].civ={status:"complete",stage:"complete",seed:1,startedStep:0,anchor:{x:-187,z:-621},checksum:"07515fcb",centre:{x:-69,z:-599}};
    const props=new Map([[CIV.devGateKey,true]]),writes=[],entities=[];
    const dimension={id:"minecraft:overworld",getEntities(){return entities;}};
    const world={getDynamicProperty:k=>props.get(k),getDynamicPropertyIds:()=>[...props.keys()],
        setDynamicProperty(k,v){writes.push([k,v]);props.set(k,v);},getDimension:()=>dimension};
    const event={sourceEntity:{typeId:"minecraft:player",isValid:true,dimension}};
    let busy=false;
    const controller=createMilitaryCommand({world,kingdomStore:{load:()=>({kingdom})},isBusy:()=>busy});
    return {kingdom,props,writes,entities,dimension,world,event,controller,busy(v){busy=v;}};
}

test("military selection factory and preview are inert; confirmation persists one selection without spawning",()=>{
    const f=fixture();assert.deepEqual(f.writes,[]);
    assert.match(f.controller.command(select.replace(" confirm",""),f.event).join("\n"),/preview only/);
    assert.deepEqual(f.writes,[]);
    const before=JSON.stringify(f.kingdom),result=f.controller.command(select,f.event).join("\n");
    assert.match(result,/Selection saved and read back/);
    assert.equal(f.writes.length,1);assert.equal(f.writes[0][0],MILITARY_SELECTION_KEY);
    assert.equal(f.controller.store.load().selection.groupId,"district-1:sol:0");
    assert.equal(f.controller.store.load().selection.fixtureId,MILITARY_FIXTURE_ID);
    assert.equal(JSON.stringify(f.kingdom),before);assert.deepEqual(f.entities,[]);
    assert.match(f.controller.command(select,f.event).join("\n"),/state already exists/);
    assert.equal(f.writes.length,1);
});

test("military confirmation refuses gate/source/job/history/fixture mismatches before writes",()=>{
    const cases=[
        f=>f.props.set(CIV.devGateKey,false),
        f=>delete f.event.sourceEntity,
        f=>f.event.sourceEntity.typeId="minecraft:zombie",
        f=>f.event.sourceEntity.isValid=false,
        f=>f.event.sourceEntity.dimension={id:"minecraft:nether"},
        f=>f.busy(true),
        f=>f.props.set(PEOPLE.gateKey,false),
        f=>f.props.set(PEOPLE.gateKey,true),
        f=>f.props.set("civ_pop","{}"),
        f=>f.props.set("civ:military_future","preserved"),
        f=>f.kingdom.districts[0].civ.checksum="other",
        f=>f.kingdom.districts[0].civ.centre.x=-68,
        f=>f.kingdom.districts[1].civ={status:"building"},
        f=>f.kingdom.districts[2].physical={status:"complete"},
        f=>f.kingdom.starter={templateId:"release"},
        f=>f.world.getDynamicPropertyIds=()=>{throw new Error("keys unavailable");},
    ];
    for(const change of cases){const f=fixture();change(f);assert.match(f.controller.command(select,f.event).join("\n"),/refused/i);assert.deepEqual(f.writes,[]);}
    const f=fixture();assert.match(f.controller.command(select.replace(MILITARY_FIXTURE_ID,"unknown"),f.event).join("\n"),/unknown fixture/);assert.deepEqual(f.writes,[]);
});

test("fresh loaded census errors, existing actors and ambiguous claims cannot activate a guard",()=>{
    const cases=[
        f=>f.dimension.getEntities=()=>{throw new Error("query unavailable");},
        f=>f.entities.push({isValid:false}),
        f=>f.entities.push({getTags(){throw new Error("invalid handle");}}),
        f=>f.entities.push({getTags:()=>["civpop:v1:district-1:sol:0"]}),
        f=>f.entities.push({getTags:()=>["civpop:v1:district-1:civ:1"]}),
        f=>f.entities.push({typeId:"civ_trial:swordsman",getTags:()=>[]}),
        f=>f.entities.push({getTags:()=>["civpop:v99:district-1:sol:0"]}),
        f=>f.entities.push({getTags:()=>["civpop:v1:district-1:sol:0","civpop:v1:district-1:sol:1"]}),
        f=>f.entities.push(...Array.from({length:513},()=>({getTags:()=>[]}))),
    ];
    for(const change of cases){const f=fixture();change(f);assert.match(f.controller.command(select,f.event).join("\n"),/refused/i);assert.deepEqual(f.writes,[]);}
    const f=fixture();f.entities.push({getTags:()=>["another_mod:resident"]});
    assert.match(f.controller.command(select,f.event).join("\n"),/Selection saved/);
});

test("selection rejects nonexistent soldier groups and unverified property writes",()=>{
    const f=fixture();assert.match(f.controller.command(select.replace("group=0","group=9999"),f.event).join("\n"),/existing canonical soldier group/);assert.deepEqual(f.writes,[]);
    const failed=fixture();failed.world.setDynamicProperty=()=>{};
    assert.match(failed.controller.command(select,failed.event).join("\n"),/write could not be verified/);
    assert.equal(failed.controller.store.load().status,"absent");
});

test("existing people subscription routes the military message and original invoker without switching people",async()=>{
    const h=await import("../lib/civharness.mjs"),module=await h.load("commands","people.js");
    h.resetWorld(1);const player=h.makePlayer(),calls=[];
    assert.equal(module.registerPeopleCommand({statusLines:()=>["ordinary status"],militaryCommand:(message,event)=>{calls.push({message,event});return ["military routed"];}}),true);
    const before=h.mc.propWrites;h.send(h.CIV_EVENT_IDS.people,`military ${select}`,player);
    assert.equal(calls.length,1);assert.equal(calls[0].message,select);assert.equal(calls[0].event.sourceEntity,player);
    assert.match(h.text(player),/military routed/);assert.equal(h.mc.propWrites,before);assert.equal(h.mc.props.get(PEOPLE.gateKey),undefined);
});
