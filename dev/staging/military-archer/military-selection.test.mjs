import assert from "node:assert/strict";
import {register} from "node:module";
import test from "node:test";
import {createPopWorld} from "../../lib/poptharness.mjs";
import * as ordersFixture from "../../lib/ordersfixture.mjs";
register("data:text/javascript,"+encodeURIComponent(`export async function resolve(s,c,next){if(s==="@minecraft/server")return{url:"data:text/javascript,"+encodeURIComponent('export const world={};export const system={currentTick:0,run(){},runInterval(){},clearRun(){},afterEvents:{scriptEventReceive:{subscribe(){}}}};export const ScriptEventSource={Server:"Server",Entity:"Entity"};export class ItemStack{};export const BlockPermutation={resolve(){throw Error("not modelled")}};'),shortCircuit:true};if(s==="@minecraft/server-ui")return{url:"data:text/javascript,export class ActionFormData{};export class MessageFormData{};",shortCircuit:true};return next(s,c);}`));
const base="../../../CivilizationApocalypse_BP/scripts/";
const {createInitialKingdom}=await import(base+"kingdom/state.js");
const {createMilitarySelectionStore}=await import(base+"integration/militarySelectionStore.js");
const {decodeMilitarySelection,encodeMilitarySelection,militarySelectionPolicy,MILITARY_SELECTION_KEY,SWORDSMAN_TYPE}=await import(base+"population/militarySelection.js");
const {createPopSync}=await import(base+"integration/popSync.js");
const {createPeopleStreets}=await import(base+"integration/peopleStreets.js");
const {createOrdersDriver}=await import(base+"integration/peopleOrders.js");
const {columnAt}=await import(base+"integration/siegeMobs.js");
const {reconcile}=await import(base+"population/reconcile.js");
const {buildGroupTable}=await import(base+"population/groups.js");
const {POP_SYNC_DEFAULTS,POP_CURSOR_KEY}=await import(base+"population/settings.js");
const {emptyCursor}=await import(base+"population/cursor.js");
const {tagFor}=await import(base+"population/identity.js");
const GROUP="district-1:sol:0",HOMES={"district-1":{x:0,y:64,z:0}};
const request={groupId:GROUP,trialId:"trial-one",dimension:"minecraft:overworld"};
const selected={v:1,trialId:"trial-one",fixtureId:"nov3-d1-672745b7",groupId:GROUP,class:"swordsman",typeId:SWORDSMAN_TYPE,dimension:"minecraft:overworld"};
function kingdom(){const k=createInitialKingdom();for(const d of k.districts){d.civilians=0;d.soldiers=d.id==="district-1"?10:0;d.garrison={front:d.soldiers,reserve:0};}return k;}
function fixture({activate=true,storeDeps={},config={}}={}){
    const pop=createPopWorld({homes:HOMES});pop.setKingdom(kingdom());pop.setPlayers([{name:"test",x:0,y:64,z:0}]);pop.loadArea(-64,-64,96,96);
    const deps={readKingdom:()=>pop.storedKingdom(),isPeopleOn:()=>false,isBusy:()=>false,readCanonicalCensus:()=>({complete:true,groupIds:[]}),verifyFreshTrial:()=>({verified:true,fixtureId:selected.fixtureId,dimension:selected.dimension}),...storeDeps};
    const store=createMilitarySelectionStore(pop.world,deps);if(activate)store.activate(request);
    const sync=(extra={})=>createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>HOMES,enabled:true,readMilitarySelection:store.load,config,...extra});
    return{pop,store,sync,deps};
}
const writes=pop=>({spawns:pop.state.spawned.length,removals:pop.state.removals.length,tags:pop.state.tagWrites.length,props:pop.state.propertyWrites.length});
test("military selection codec is bounded, versioned, immutable and strictly dimensioned",()=>{
    assert.equal(decodeMilitarySelection(undefined).status,"absent");
    const good=decodeMilitarySelection(encodeMilitarySelection(selected));assert.equal(good.status,"ok");assert.ok(Object.isFrozen(good.selection));
    for(const value of [{...selected,v:2},{...selected,dimension:"overworld"},{...selected,groupId:"district-1:civ:0"},{...selected,extra:true},{...selected,trialId:"x".repeat(65)}])assert.equal(decodeMilitarySelection(JSON.stringify(value)).status,"refused");
    for(const raw of [null,4,"{","x".repeat(1025)])assert.equal(decodeMilitarySelection(raw).status,"refused");
    const table=buildGroupTable(kingdom(),POP_SYNC_DEFAULTS).groups,policy=militarySelectionPolicy(good,table,"minecraft:overworld");
    assert.equal(policy.typeForGroup(table[0]),SWORDSMAN_TYPE);assert.equal(policy.typeForGroup(table[1]),"minecraft:iron_golem");
    assert.throws(()=>militarySelectionPolicy(good,table,"minecraft:nether"),/dimension/);
    assert.throws(()=>militarySelectionPolicy(good,[],"minecraft:overworld"),/no longer exists/);
});
test("activation persists one verified selection; clear waits for sole owner teardown",()=>{
    const{pop,store,deps}=fixture({activate:false});const kingdomBefore=pop.world.getDynamicProperty("civ:kingdom");
    const result=store.activate(request);assert.equal(result.selection.groupId,GROUP);assert.equal(pop.world.getDynamicProperty("civ:kingdom"),kingdomBefore);
    assert.equal(pop.state.spawned.length,0);assert.throws(()=>store.activate(request),/already exists/);
    assert.equal(createMilitarySelectionStore(pop.world).load().stamp,result.stamp,"rejoin retains exact selection without activation");
    deps.readCanonicalCensus=()=>({complete:true,groupIds:[GROUP]});assert.throws(()=>store.clear(),/still exists/);
    deps.readCanonicalCensus=()=>({complete:true,groupIds:[]});assert.equal(store.clear().status,"absent");
});
test("activation refuses unverifiable provenance/census/busy/gate and never writes",()=>{
    for(const storeDeps of [{verifyFreshTrial:undefined},{verifyFreshTrial:()=>({verified:false})},{verifyFreshTrial:()=>({verified:true,fixtureId:"ok",dimension:"overworld"})},{isPeopleOn:()=>true},{isBusy:()=>true},{readCanonicalCensus:()=>({complete:false,groupIds:[]})},{readCanonicalCensus:()=>({complete:true,groupIds:[GROUP]})},{readCanonicalCensus:()=>{throw Error("unreadable census");}}]){
        const{pop,store}=fixture({activate:false,storeDeps});const before=writes(pop);assert.throws(()=>store.activate(request));assert.deepEqual(writes(pop),before);assert.equal(store.load().status,"absent");
    }
});
test("storage corruption, newer versions and silent write failures fail closed",()=>{
    const{pop,store}=fixture({activate:false});pop.setRawProperty(MILITARY_SELECTION_KEY,JSON.stringify({...selected,v:2}));assert.equal(store.load().status,"refused");assert.throws(()=>store.clear());
    pop.setRawProperty(MILITARY_SELECTION_KEY,undefined);const set=pop.world.setDynamicProperty;pop.world.setDynamicProperty=()=>{};assert.throws(()=>store.activate(request),/write could not be verified/);pop.world.setDynamicProperty=set;
    const get=pop.world.getDynamicProperty;pop.world.getDynamicProperty=()=>{throw Error("read failed");};assert.equal(store.load().status,"refused");assert.throws(()=>store.activate(request));pop.world.getDynamicProperty=get;
});
test("clear preserves a newer selection written during its verification callbacks",()=>{
    const{pop,store,deps}=fixture();const changed=encodeMilitarySelection({...selected,groupId:"district-1:sol:1",trialId:"new-trial"});
    deps.readCanonicalCensus=()=>{pop.setRawProperty(MILITARY_SELECTION_KEY,changed);return{complete:true,groupIds:[]};};
    assert.throws(()=>store.clear(),/changed before clear/);assert.equal(pop.world.getDynamicProperty(MILITARY_SELECTION_KEY),changed);
});
test("normal owner spawns one selected swordsman, preserves headcounts and adopts after restart",()=>{
    const{pop,store,sync}=fixture();const before=JSON.stringify(pop.storedKingdom());const first=sync().reconcileOnce(0);assert.equal(first.refused,null);assert.equal(first.saved,true);
    assert.deepEqual(pop.state.spawned.map(id=>pop.state.entities.get(id).typeId).sort(),[SWORDSMAN_TYPE,"minecraft:iron_golem"].sort());
    assert.equal(pop.groupCounts().get(GROUP).total,1);const id=[...pop.state.entities.values()].find(e=>e.tags.has(tagFor(GROUP))).id;
    pop.setRawProperty(POP_CURSOR_KEY,undefined);pop.restart();const joined=createMilitarySelectionStore(pop.world);const again=sync({readMilitarySelection:joined.load}).reconcileOnce(4);
    assert.equal(again.refused,null);assert.equal(pop.groupCounts().get(GROUP).total,1);assert.equal(pop.state.spawned.length,2);assert.ok(pop.state.entities.get(id).alive);
    assert.equal(JSON.stringify(pop.storedKingdom()),before);assert.equal(joined.load().stamp,store.load().stamp);
});
test("selected birth survives cursor-save interruption without a duplicate on restart",()=>{
    const{pop,sync,store}=fixture({config:{maxSpawnsPerTick:1}});pop.crashAfterMutations(2);
    const first=sync().reconcileOnce(0);assert.equal(first.saved,false);assert.equal(pop.groupCounts().get(GROUP).total,1);
    pop.restart();const stamp=store.load().stamp;sync().reconcileOnce(4);assert.equal(pop.groupCounts().get(GROUP).total,1);assert.equal(store.load().stamp,stamp);
    assert.equal([...pop.state.entities.values()].filter(e=>e.alive&&e.typeId===SWORDSMAN_TYPE).length,1);
});
test("spawn-before-tag interruption never adopts or deletes an untagged swordsman",()=>{
    const{pop,sync}=fixture({config:{maxSpawnsPerTick:1}});pop.crashAfterMutations(1);sync().reconcileOnce(0);pop.restart();
    const stray=[...pop.state.entities.values()].find(e=>e.alive&&e.tags.size===0);assert.ok(stray);sync().reconcileOnce(4);
    assert.equal(stray.tags.size,0);assert.equal(stray.alive,true);assert.equal(pop.groupCounts().get(GROUP).total,1,"one canonical owner actor; untagged stray remains a documented crash limitation");
});
test("pure owner refuses wrong type, duplicates and ambiguous tags before destructive cleanup",()=>{
    const k=kingdom(),table=buildGroupTable(k,POP_SYNC_DEFAULTS).groups,policy=militarySelectionPolicy(decodeMilitarySelection(JSON.stringify(selected)),table,selected.dimension);
    for(const entities of [[{id:"old",typeId:"minecraft:iron_golem",tags:[tagFor(GROUP)]}],[{id:"a",typeId:SWORDSMAN_TYPE,tags:[tagFor(GROUP)]},{id:"b",typeId:SWORDSMAN_TYPE,tags:[tagFor(GROUP)]}],[{id:"a",typeId:SWORDSMAN_TYPE,tags:[tagFor(GROUP),tagFor("district-1:sol:1")]}]]){
        const result=reconcile(emptyCursor(),{kingdom:k,entities,anchors:[],homes:HOMES,loadedChunks:[]},0,{},policy.typeForGroup);
        assert.match(result.report.refused,/conflict/);assert.deepEqual(result.actions,[]);assert.deepEqual(result.state,emptyCursor());
    }
});
test("runtime owner preserves wrong types/duplicates even outside observation windows",()=>{
    for(const kind of ["wrong","duplicate","ambiguous"]){const{pop,sync}=fixture();pop.loadArea(700,700,720,720);
        pop.addEntity({x:704,z:704,typeId:kind==="wrong"?"minecraft:iron_golem":SWORDSMAN_TYPE,tags:kind==="ambiguous"?[tagFor(GROUP),tagFor("district-1:sol:1")]:[tagFor(GROUP)]});
        if(kind==="duplicate")pop.addEntity({x:705,z:704,typeId:SWORDSMAN_TYPE,tags:[tagFor(GROUP)]});
        const before=writes(pop),run=sync().reconcileOnce(0);assert.ok(run.refused);assert.equal(run.saved,false);assert.deepEqual(writes(pop),before);
    }
});
test("observation and tag-query errors refuse enabled trial without cursor/world writes",()=>{
    for(const tagsOnly of [false,true]){const{pop,sync}=fixture(),get=pop.dimension.getEntities;pop.dimension.getEntities=q=>{if(!tagsOnly||q?.tags)throw Error("query unloaded");return get(q);};
        const before=writes(pop),run=sync().reconcileOnce(0);assert.match(run.refused,/query|census/);assert.deepEqual(writes(pop),before);
    }
});
test("fresh prewrite guards catch selection changes, new representative and late query failure",()=>{
    for(const change of ["selection","actor","query"]){const{pop,sync}=fixture(),top=pop.dimension.getTopmostBlock;let changed=false;
        pop.dimension.getTopmostBlock=(...args)=>{if(!changed){changed=true;if(change==="selection")pop.setRawProperty(MILITARY_SELECTION_KEY,JSON.stringify({...selected,trialId:"changed"}));if(change==="actor")pop.addEntity({x:3,z:22,typeId:SWORDSMAN_TYPE,tags:[tagFor(GROUP)]});if(change==="query")pop.dimension.getEntities=()=>{throw Error("late query failed");};}return top(...args);};
        const before=writes(pop),run=sync().reconcileOnce(0);assert.ok(changed);assert.ok(run.refused,change);assert.equal(run.saved,false);assert.equal(pop.state.spawned.length,before.spawns);assert.equal(pop.state.removals.length,before.removals);assert.equal(pop.state.tagWrites.length,before.tags);
    }
});
test("unloaded selected actor is not a casualty and selection remains through unload/rejoin",()=>{
    const{pop,store,sync}=fixture();sync().reconcileOnce(0);const before=JSON.stringify(pop.storedKingdom()),stamp=store.load().stamp;
    pop.unloadArea(-64,-64,96,96);pop.setPlayers([]);const run=sync().reconcileOnce(100);assert.equal(run.actions.length,0);assert.equal(store.load().stamp,stamp);assert.equal(JSON.stringify(pop.storedKingdom()),before);
    pop.loadArea(-64,-64,96,96);pop.setPlayers([{name:"test",x:0,y:64,z:0}]);sync().reconcileOnce(104);assert.equal(pop.groupCounts().get(GROUP).total,1);
});
test("off/default adapter behavior remains ordinary golems and no new selection writes",()=>{
    const{pop}=fixture({activate:false});const run=createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>HOMES,enabled:true}).reconcileOnce(0);
    assert.equal(run.refused,null);assert.ok(pop.state.spawned.every(id=>pop.state.entities.get(id).typeId==="minecraft:iron_golem"));assert.equal(pop.world.getDynamicProperty(MILITARY_SELECTION_KEY),undefined);
});
test("main-style absent selection callback retains ordinary duplicate recovery and default behavior",()=>{
    function run(withReader){const{pop,store}=fixture({activate:false});pop.addEntity({id:"a",x:3,z:22,typeId:"minecraft:iron_golem",tags:[tagFor(GROUP)]});pop.addEntity({id:"b",x:4,z:22,typeId:"minecraft:iron_golem",tags:[tagFor(GROUP)]});
        const adapter=createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>HOMES,enabled:true,...(withReader?{readMilitarySelection:store.load}:{})});
        const result=adapter.reconcileOnce(0);return{refused:result.refused,applied:result.applied,counts:[...pop.groupCounts()],removals:pop.state.removals,cursor:pop.world.getDynamicProperty(POP_CURSOR_KEY)};
    }
    const base=run(false),injected=run(true);assert.equal(base.refused,null);assert.equal(base.removals.length,1);assert.deepEqual(injected,base);
});
test("absent-to-active change during observation cannot spawn a stale default golem",()=>{
    const{pop,sync}=fixture({activate:false}),get=pop.dimension.getBlock;let changed=false;
    pop.dimension.getBlock=point=>{if(!changed){changed=true;pop.setRawProperty(MILITARY_SELECTION_KEY,JSON.stringify(selected));}return get(point);};
    const before=writes(pop),run=sync().reconcileOnce(0);assert.ok(changed);assert.match(run.refused,/selection changed/);assert.equal(run.saved,false);assert.deepEqual(writes(pop),before);
});
test("enabled trial consumes one combined bounded runtime and reducer work budget",()=>{
    const{pop,sync}=fixture({config:{workBudget:1}}),before=writes(pop);const result=sync().reconcileOnce(0);
    assert.match(result.refused,/work budget/);assert.deepEqual(writes(pop),before);
});
test("streets passes selection through its sole owner and gate-off teardown removes it",()=>{
    const{pop,store}=fixture();let gate=true;const streets=createPeopleStreets({homes:()=>HOMES,readMilitarySelection:store.load,isGateOn:()=>gate});
    const ctx={world:pop.world,dimension:pop.dimension,kingdom:pop.storedKingdom(),tick:0,report:{}};streets.onHour(ctx);assert.ok(pop.state.spawned.some(id=>pop.state.entities.get(id).typeId===SWORDSMAN_TYPE));
    gate=false;streets.onHour({...ctx,tick:4});assert.equal(pop.liveCount({ours:true}),0);assert.equal(store.load().status,"ok","people off retains class selection");
});
test("active trial gate-off teardown preserves conflicting types, duplicates and unreadable census",()=>{
    for(const conflict of ["type","duplicate","query","late-type"]){const{pop,store}=fixture();pop.addEntity({x:3,z:22,typeId:conflict==="type"?"minecraft:pig":SWORDSMAN_TYPE,tags:[tagFor(GROUP)]});
        if(conflict==="duplicate")pop.addEntity({x:4,z:22,typeId:SWORDSMAN_TYPE,tags:[tagFor(GROUP)]});
        if(conflict==="query")pop.dimension.getEntities=()=>{throw Error("unreadable teardown census");};
        let reads=0;const streets=createPeopleStreets({homes:()=>HOMES,isGateOn:()=>false,readMilitarySelection:()=>{if(conflict==="late-type"&&++reads===2)[...pop.state.entities.values()][0].typeId="minecraft:pig";return store.load();}});
        const before=writes(pop);streets.onHour({world:pop.world,dimension:pop.dimension,kingdom:pop.storedKingdom(),tick:0,report:{}});
        assert.ok(streets.status().refused,conflict);assert.deepEqual(writes(pop),before,conflict);assert.equal(store.load().status,"ok");
    }
});
test("Orders reports selected guard as stationary while ordinary admitted golems retain posts",()=>{
    const f=ordersFixture;f.resetOrdersWorld();const k=f.kingdomFixture(),actors=f.putLevy(k,"district-1",3);f.records.get(actors[0].id).typeId=SWORDSMAN_TYPE;
    const read=()=>decodeMilitarySelection(JSON.stringify(selected));const ids=[0,1,2].map(i=>`district-1:sol:${i}`);
    const driver=createOrdersDriver({readMilitarySelection:read,admittedGroups:()=>ids,readPlan:()=>null});const before=f.entityList().find(e=>e.id===actors[0].id);
    driver.onHour(f.context(k,0));assert.equal(driver.status().refused,null);assert.deepEqual(driver.status().stationaryTrial,[GROUP]);
    assert.equal(f.journal.teleports.some(t=>t.id===actors[0].id),false);assert.equal(f.journal.nameWrites.some(t=>t.id===actors[0].id),false);
    assert.ok(f.journal.teleports.some(t=>t.id!==actors[0].id));assert.deepEqual(f.entityList().find(e=>e.id===actors[0].id),before);
    const blocked=createOrdersDriver({readMilitarySelection:read,readPlan:()=>null});const writesBefore=f.journal.teleports.length+f.journal.nameWrites.length;blocked.onHour(f.context(k,1));assert.match(blocked.status().refused,/admitted census/);assert.equal(f.journal.teleports.length+f.journal.nameWrites.length,writesBefore);
});
test("Orders absent selection callback preserves ordinary posting without a new admission dependency",()=>{
    function run(withReader){const f=ordersFixture;f.resetOrdersWorld();const k=f.kingdomFixture();f.putLevy(k,"district-1",3);const driver=createOrdersDriver({readPlan:()=>null,...(withReader?{readMilitarySelection:()=>decodeMilitarySelection(undefined)}:{})});driver.onHour(f.context(k,0));return{status:driver.status(),teleports:structuredClone(f.journal.teleports),names:structuredClone(f.journal.nameWrites)};}
    assert.deepEqual(run(true),run(false));
});
test("Orders fresh guards block late selection, admission and canonical identity changes after probes",()=>{
    for(const change of ["selection","admission","identity"]){const f=ordersFixture;f.resetOrdersWorld();const k=f.kingdomFixture(),actors=f.putLevy(k,"district-1",3);f.records.get(actors[0].id).typeId=SWORDSMAN_TYPE;
        let current=selected,admitted=[0,1,2].map(i=>`district-1:sol:${i}`),changed=false;
        const driver=createOrdersDriver({readPlan:()=>null,readMilitarySelection:()=>decodeMilitarySelection(JSON.stringify(current)),admittedGroups:()=>admitted,probe:(dim,x,z,config)=>{if(!changed){changed=true;if(change==="selection")current={...selected,trialId:"new-trial",groupId:"district-1:sol:1"};if(change==="admission")admitted=[];if(change==="identity")f.records.get(actors[1].id).tags=new Set([tagFor("district-1:civ:0")]);}return columnAt(dim,x,z,config);}});
        driver.onHour(f.context(k,0));assert.ok(changed);assert.equal(f.journal.teleports.some(t=>t.id===actors[0].id||t.id===actors[1].id),false,change);assert.equal(f.journal.nameWrites.some(t=>t.id===actors[0].id||t.id===actors[1].id),false,change);
        if(change!=="identity"){assert.equal(f.journal.teleports.length,0);assert.equal(f.journal.nameWrites.length,0);}
    }
});
test("Orders absent-to-active change during ground probes cannot post a newly selected actor",()=>{
    const f=ordersFixture;f.resetOrdersWorld();const k=f.kingdomFixture();f.putLevy(k,"district-1",3);let raw,changed=false;
    const driver=createOrdersDriver({readPlan:()=>null,readMilitarySelection:()=>decodeMilitarySelection(raw),probe:(dim,x,z,config)=>{if(!changed){changed=true;raw=JSON.stringify(selected);}return columnAt(dim,x,z,config);}});
    driver.onHour(f.context(k,0));assert.ok(changed);assert.equal(f.journal.teleports.length,0);assert.equal(f.journal.nameWrites.length,0);
});
test("active Orders refuses duplicate/type conflicts and invalid query shapes before posting",()=>{
    for(const conflict of ["duplicate","type","shape"]){const f=ordersFixture;f.resetOrdersWorld();const k=f.kingdomFixture(),actors=f.putLevy(k,"district-1",3);f.records.get(actors[0].id).typeId=SWORDSMAN_TYPE;
        if(conflict==="duplicate")f.dimension.spawnEntity("minecraft:iron_golem",{x:4,y:64,z:22},{tags:[tagFor("district-1:sol:1")]});
        if(conflict==="type")f.records.get(actors[1].id).typeId="minecraft:pig";
        const dimension=conflict==="shape"?{...f.dimension,getEntities:()=>undefined}:f.dimension;
        const driver=createOrdersDriver({readPlan:()=>null,readMilitarySelection:()=>decodeMilitarySelection(JSON.stringify(selected)),admittedGroups:()=>[0,1,2].map(i=>`district-1:sol:${i}`)});
        driver.onHour({...f.context(k,0),dimension});assert.ok(driver.status().refused,conflict);assert.equal(f.journal.teleports.length,0);assert.equal(f.journal.nameWrites.length,0);
    }
});

test('schema2 archer uses existingowner resolver and oldschema1swordsman staysbytecompatible',()=>{const f=fixture({activate:false}),before=f.pop.world.getDynamicProperty('civ:kingdom');f.store.activate({...request,class:'archer'});const saved=f.store.load();assert.equal(saved.selection.v,2);assert.equal(saved.selection.typeId,'civ_trial:archer');assert.equal(f.pop.state.spawned.length,0);const r=f.sync().reconcileOnce(0);assert.equal(r.refused,null);assert.equal(f.pop.groupCounts().get(GROUP).total,1);const archer=[...f.pop.state.entities.values()].find(e=>e.typeId==='civ_trial:archer');assert.ok(archer);assert.ok(archer.tags.has(tagFor(GROUP)));assert.equal([...f.pop.state.entities.values()].filter(e=>e.alive&&e.typeId==='minecraft:iron_golem').length,1);assert.equal(f.pop.world.getDynamicProperty('civ:kingdom'),before);assert.equal(encodeMilitarySelection(selected),JSON.stringify(selected));});
test('archer class/type/schema crosscombinations and unknown classes refusewithoutchangingselection',()=>{for(const value of[{...selected,class:'archer'},{...selected,v:2,typeId:'civ_trial:archer'},{...selected,v:2,class:'archer'},{...selected,v:3,class:'archer',typeId:'civ_trial:archer'},{...selected,v:2,class:'cavalry',typeId:'civ_trial:archer'}])assert.equal(decodeMilitarySelection(JSON.stringify(value)).status,'refused');const f=fixture({activate:false});assert.throws(()=>f.store.activate({...request,class:'cavalry'}),/unsupported/);assert.equal(f.store.load().status,'absent');});
test('selected archer is excluded from Orders posting throughsamegroup policy',()=>{const f=ordersFixture;f.resetOrdersWorld();const k=f.kingdomFixture(),actors=f.putLevy(k,'district-1',3);f.records.get(actors[0].id).typeId='civ_trial:archer';const raw={...selected,v:2,class:'archer',typeId:'civ_trial:archer'},driver=createOrdersDriver({readPlan:()=>null,readMilitarySelection:()=>decodeMilitarySelection(JSON.stringify(raw)),admittedGroups:()=>[0,1,2].map(i=>`district-1:sol:${i}`)});const before=f.entityList().find(e=>e.id===actors[0].id);driver.onHour(f.context(k,0));assert.equal(driver.status().refused,null);assert.deepEqual(driver.status().stationaryTrial,[GROUP]);assert.equal(f.journal.teleports.some(e=>e.id===actors[0].id),false);assert.ok(f.journal.teleports.some(e=>e.id!==actors[0].id));assert.deepEqual(f.entityList().find(e=>e.id===actors[0].id),before);});
