import assert from "node:assert/strict";
import test from "node:test";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {createMilitaryLifecycleDiagnostics,militaryActorSnapshot,registerMilitaryLifecycleSignals} from "../../../CivilizationApocalypse_BP/scripts/integration/militaryLifecycleDiagnostics.js";
import {decodeMilitarySelection,SWORDSMAN_TYPE,ARCHER_TYPE} from "../../../CivilizationApocalypse_BP/scripts/population/militarySelection.js";
import {tagFor} from "../../../CivilizationApocalypse_BP/scripts/population/identity.js";
import {createPopWorld} from "../../lib/poptharness.mjs";
import {createInitialKingdom} from "../../../CivilizationApocalypse_BP/scripts/kingdom/state.js";
register("data:text/javascript,"+encodeURIComponent(`export async function resolve(s,c,next){if(s==="@minecraft/server")return{url:"data:text/javascript,export const world={};export const system={};",shortCircuit:true};return next(s,c);}`));
const {createPopSync}=await import("../../../CivilizationApocalypse_BP/scripts/integration/popSync.js");
const {createPeopleStreets}=await import("../../../CivilizationApocalypse_BP/scripts/integration/peopleStreets.js");
const GROUP="district-1:sol:0";
const selection=decodeMilitarySelection(JSON.stringify({v:1,trialId:"diag-one",fixtureId:"fixture-one",groupId:GROUP,class:"swordsman",typeId:SWORDSMAN_TYPE,dimension:"minecraft:overworld"}));
const actor=(id="actor-1",extra={})=>({id,typeId:SWORDSMAN_TYPE,isValid:true,location:{x:1,y:70,z:2},getComponent:()=>({currentValue:27}),getTags:()=>[tagFor(GROUP)],...extra});
function tracker(){let read=selection,reads=0,now=123;const d=createMilitaryLifecycleDiagnostics({readSelection:()=>{reads++;return read;},tick:()=>now});return{d,change(v){read=v;},at(v){now=v;},reads:()=>reads,lines:()=>d.statusLines().join("\n")};}

test("default-off diagnostics read no selection or event identity and register no work",()=>{
    const t=tracker(),poison=new Proxy({},{get(){throw Error("must not read while off");}});
    t.d.observe(GROUP,[poison]);t.d.onDie(poison);t.d.onRemove(poison);t.d.onHurt(poison);t.d.ownerOutcome(poison,poison);
    assert.equal(t.reads(),0);assert.match(t.lines(),/off/);assert.equal(t.d.statusLines().length,1);
});
test("only one exact canonical selected actor binds; duplicates, wrong types and ambiguous identities refuse",()=>{
    const t=tracker();t.d.command("diagnostics on");
    for(const handles of [[actor(),actor("other")],[actor("wrong",{typeId:"minecraft:iron_golem"})],[actor("ambiguous",{getTags:()=>[tagFor(GROUP),tagFor("district-1:sol:1")]})],[actor("unreadable",{getTags(){throw Error("unreadable");}})]])t.d.observe(GROUP,handles);
    assert.doesNotMatch(t.lines(),/verified canonical binding/);
    t.d.observe(GROUP,[actor()]);assert.match(t.lines(),/verified canonical binding actor actor-1/);
    assert.deepEqual(militaryActorSnapshot(actor()),{location:{x:1,y:70,z:2},health:27});
});
test("matched death identity, prior-only binding, owner removal and unknown unloading stay distinct",()=>{
    const t=tracker();t.d.command("diagnostics on");t.d.observe(GROUP,[actor()]);
    t.d.onDie({deadEntity:actor(),damageSource:{cause:"entityAttack",damagingEntity:{typeId:"minecraft:zombie"}}});
    t.d.onRemove({removedEntityId:"actor-1",typeId:SWORDSMAN_TYPE});
    t.d.ownerOutcome({op:"despawn",groupId:GROUP,entityId:"actor-1",reason:"out-of-range"},{ok:true});
    t.d.onDie({deadEntity:actor("actor-1",{getTags(){throw Error("dead handle inaccessible");}}),get damageSource(){throw Error("unreadable");}});
    assert.match(t.lines(),/fresh canonical death identity verified; cause=entityAttack; damager=minecraft:zombie/);
    assert.match(t.lines(),/prior verified canonical binding; death identity unreadable; cause=unknown; damager=unknown/);
    assert.match(t.lines(),/entityRemove event.*removed\/unloaded; cause unknown \(not a casualty verdict\)/);
    assert.match(t.lines(),/owner despawn applied.*out-of-range/);
    const before=t.lines();t.d.onDie({deadEntity:actor("other")});t.d.onDie({deadEntity:actor("actor-1",{getTags:()=>[]})});assert.equal(t.lines(),before);
    t.change({...selection,stamp:"different-session-selection"});t.d.onDie({deadEntity:actor()});assert.equal(t.lines(),before);
});
test("event history and bindings are bounded; read failures are unknown; switching off clears session evidence",()=>{
    const t=tracker();t.d.command("diagnostics on");for(let i=0;i<30;i++)t.d.observe(GROUP,[actor(`actor-${i}`)]);
    assert.equal(t.d.statusLines().length,17);let before=t.lines();t.d.onDie({deadEntity:actor("actor-0")});assert.equal(t.lines(),before);
    t.d.onDie({deadEntity:actor("actor-29")});assert.notEqual(t.lines(),before);
    assert.deepEqual(militaryActorSnapshot({get location(){throw Error();},getComponent(){throw Error();}}),{location:null,health:null});
    t.d.command("diagnostics off");t.d.command("diagnostics on");assert.equal(t.d.statusLines().length,1);
});
test("actual 2.7 death/remove are type-filtered and hurt subscription supports either damage direction without early reads",()=>{
    const subscriptions=[],t=tracker();
    const signal=name=>({subscribe(callback,options){subscriptions.push({name,callback,options});}});
    const world={afterEvents:{entityDie:signal("die"),entityRemove:signal("remove"),entityHurt:signal("hurt")},getDynamicProperty(){throw Error("early read");}};
    registerMilitaryLifecycleSignals(world,t.d);assert.equal(t.reads(),0);
    assert.deepEqual(subscriptions.map(s=>s.options),[{entityTypes:[SWORDSMAN_TYPE,ARCHER_TYPE]},{entityTypes:[SWORDSMAN_TYPE,ARCHER_TYPE]},undefined]);
    const types=readFileSync(new URL("../../../node_modules/@minecraft/server/index.d.ts",import.meta.url),"utf8");
    for(const name of ["EntityDieAfterEventSignal","EntityRemoveAfterEventSignal","EntityHurtAfterEventSignal"]){const section=types.slice(types.indexOf(`export class ${name}`));assert.match(section.slice(0,section.indexOf("unsubscribe(")),/can be called in early-execution mode/);}
});

function ownerFixture(diagnostics){
    const homes={"district-1":{x:0,y:64,z:0}},pop=createPopWorld({homes}),kingdom=createInitialKingdom();
    for(const d of kingdom.districts){d.civilians=0;d.soldiers=d.id==="district-1"?10:0;d.garrison={front:d.soldiers,reserve:0};}
    pop.setKingdom(kingdom);pop.setPlayers([{name:"test",x:0,y:64,z:0}]);pop.loadArea(-64,-64,96,96);
    return{pop,owner:createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>homes,enabled:true,readMilitarySelection:()=>selection,militaryDiagnostics:diagnostics})};
}
test("normal sole-owner birth binds and records outcome; throwing diagnostics cannot change actions or writes",()=>{
    const t=tracker();t.d.command("diagnostics on");const a=ownerFixture(t.d),b=ownerFixture(new Proxy({},{get(){return()=>{throw Error("diagnostic failure");};}}));
    const ar=a.owner.reconcileOnce(0),br=b.owner.reconcileOnce(0);assert.deepEqual(ar,br);
    assert.deepEqual(a.pop.state.spawned,b.pop.state.spawned);assert.deepEqual(a.pop.state.propertyWrites,b.pop.state.propertyWrites);
    assert.match(t.lines(),/verified canonical binding/);assert.match(t.lines(),/owner spawn applied/);
    assert.equal(a.pop.storedKingdom().districts[0].soldiers,10);
});
test("inspection reads live movement and health using its existing single query without owner mutations",()=>{
    const t=tracker();t.d.command("diagnostics on");const{pop,owner}=ownerFixture(t.d);owner.reconcileOnce(0);
    const current=[...pop.state.entities.values()].find(e=>e.tags.has(tagFor(GROUP)));current.x=11;current.y=65;current.z=29;
    let queries=0;const get=pop.dimension.getEntities;pop.dimension.getEntities=function(q){queries++;return get.call(this,q).map(h=>Object.assign(Object.create(h),{getComponent:()=>({currentValue:18})}));};
    const before=JSON.stringify({props:pop.state.propertyWrites,spawns:pop.state.spawned,removes:pop.state.removals,tags:pop.state.tagWrites});
    const info=owner.inspectGroup(GROUP,1000);assert.equal(queries,1);assert.deepEqual(info.live.entities[0].location,{x:11,y:65,z:29});assert.equal(info.live.entities[0].health,18);
    assert.notDeepEqual(info.live.entities[0].location,info.lastAttempt.settled);
    assert.equal(JSON.stringify({props:pop.state.propertyWrites,spawns:pop.state.spawned,removes:pop.state.removals,tags:pop.state.tagWrites}),before);
});
test("gate-off owner teardown records only the selected guard, not ordinary levies or fabricated deaths",()=>{
    const t=tracker();t.d.command("diagnostics on");const{pop}=ownerFixture();let on=true;
    const streets=createPeopleStreets({isGateOn:()=>on,homes:()=>({"district-1":{x:0,y:64,z:0}}),readMilitarySelection:()=>selection,militaryDiagnostics:t.d});
    const context=tick=>({world:pop.world,dimension:pop.dimension,kingdom:pop.storedKingdom(),tick});
    streets.onHour(context(1000));const selected=[...pop.state.entities.values()].find(e=>e.tags.has(tagFor(GROUP)));
    assert.ok(selected);on=false;streets.onHour(context(2000));
    const removals=t.d.statusLines().filter(line=>line.includes("owner despawn applied"));assert.equal(removals.length,1);
    assert.match(removals[0],new RegExp(`actor ${selected.id}; people gate-off teardown`));assert.doesNotMatch(t.lines(),/entityDie event/);
    assert.equal(pop.storedKingdom().districts[0].soldiers,10);
});
const zombie=(extra={})=>({id:"zombie-1",typeId:"minecraft:zombie",getTags:()=>[],...extra});
const hurt=(victim,damager,damage=3)=>({hurtEntity:victim,damage,damageSource:{damagingEntity:damager,cause:"entityAttack"}});
test("hurt after-events attribute incoming and outgoing damage only to freshly verified selected bindings, without writes",()=>{
    const t=tracker(),guard=actor();t.d.command("diagnostics on");t.d.observe(GROUP,[guard]);
    const before=JSON.stringify(guard);
    t.d.onHurt(hurt(guard,zombie(),3));t.d.onHurt(hurt(zombie({getTags:()=>["civbesiege:v1"]}),guard,4));
    assert.match(t.lines(),/hurt incoming actor actor-1; fresh canonical; damage=3; cause=entityAttack; other=minecraft:zombie \(zombie-1\); siege-tag=no; health=27; position=1,70,2/);
    assert.match(t.lines(),/hurt outgoing actor actor-1; fresh canonical; damage=4; cause=entityAttack; other=minecraft:zombie \(zombie-1\); siege-tag=yes/);
    assert.match(t.lines(),/incoming 1, outgoing 1, held 0/);assert.equal(JSON.stringify(guard),before);
    assert.doesNotMatch(t.lines(),/entityDie event/);
});
test("hurt evidence ignores unbound IDs and stale selections, holds changed/ambiguous canonical actors, and never binds implicitly",()=>{
    const t=tracker();t.d.command("diagnostics on");t.d.onHurt(hurt(actor(),zombie()));assert.equal(t.d.statusLines().length,1,"no implicit actor binding");
    t.d.observe(GROUP,[actor()]);t.d.onHurt(hurt(actor("unbound"),zombie()));assert.doesNotMatch(t.lines(),/hurt incoming/);
    t.change({...selection,stamp:"other"});t.d.onHurt(hurt(actor(),zombie()));assert.doesNotMatch(t.lines(),/hurt incoming/);
    t.change(selection);
    t.d.onHurt(hurt(actor("actor-1",{getTags:()=>[tagFor("district-2:sol:0")]}),zombie()));
    t.d.observe(GROUP,[actor(),actor("duplicate")]);t.d.onHurt(hurt(actor(),zombie()));
    assert.match(t.lines(),/incoming 0, outgoing 0, held 2/);assert.doesNotMatch(t.lines(),/hurt incoming actor/);
});
test("hurt field failures remain unknown and environment damage cannot fabricate an outgoing actor",()=>{
    const t=tracker();t.d.command("diagnostics on");const guard=actor("actor-1",{getComponent(){throw Error();}});Object.defineProperty(guard,"location",{get(){throw Error();}});t.d.observe(GROUP,[guard]);
    t.d.onHurt({hurtEntity:guard,get damage(){throw Error();},get damageSource(){throw Error();}});
    assert.match(t.lines(),/hurt incoming.*damage=unknown; cause=unknown; other=unknown \(unknown\); siege-tag=unknown; health=unknown; position=unknown/);
    assert.match(t.lines(),/incoming 1, outgoing 0/);
    t.d.onHurt(hurt(actor("actor-1",{getTags(){throw Error();}}),zombie()));assert.match(t.lines(),/held 1/);
});
test("hurt bursts cap before entity reads, retain a separate bounded ring, and preserve lifecycle evidence",()=>{
    const t=tracker();t.d.command("diagnostics on");const guard=actor();t.d.observe(GROUP,[guard]);t.d.onDie({deadEntity:guard,damageSource:{cause:"entityAttack"}});
    for(let i=0;i<32;i++)t.d.onHurt(hurt(guard,zombie()));
    const reads=t.reads();t.d.onHurt(new Proxy({},{get(){throw Error("capped callback touched entity fields");}}));assert.equal(t.reads(),reads);
    assert.match(t.lines(),/incoming 32, outgoing 0, held 0, budget-dropped 1/);
    assert.equal(t.d.statusLines().filter(s=>/hurt incoming actor/.test(s)).length,16);assert.match(t.lines(),/entityDie event/);assert.match(t.lines(),/verified canonical binding/);
    t.at(124);t.d.onHurt(hurt(zombie(),guard,4));assert.match(t.lines(),/incoming 32, outgoing 1/);
    t.d.command("diagnostics off");t.d.command("diagnostics on");assert.equal(t.d.statusLines().length,1);
});
test("global unrelated event workload is session-capped and never becomes outgoing-damage evidence",()=>{
    const t=tracker();t.d.command("diagnostics on");t.d.observe(GROUP,[actor()]);
    const unrelated=hurt(zombie(),zombie({id:"other-zombie"}));
    for(let i=0;i<1000000;i++){if(i%32===0)t.at(i);t.d.onHurt(unrelated);}
    const reads=t.reads();t.at(1000001);t.d.onHurt(hurt(zombie(),actor(),4));assert.equal(t.reads(),reads);
    assert.match(t.lines(),/incoming 0, outgoing 0, held 0, budget-dropped 1/);assert.doesNotMatch(t.lines(),/hurt outgoing actor/);
});

test('sameboundeddiagnosticsbindsselectedarcher andrecordsphysicaldeath withoutcasualtydebit',()=>{const t=tracker(),archer=decodeMilitarySelection(JSON.stringify({...selection.selection,v:2,class:'archer',typeId:ARCHER_TYPE}));t.change(archer);t.d.command('diagnostics on');const h=actor('archer-one',{typeId:ARCHER_TYPE});t.d.observe(GROUP,[h]);assert.match(t.lines(),/verified canonical binding actor archer-one/);t.d.onDie({deadEntity:h,damageSource:{cause:'entityAttack',damagingEntity:{typeId:'minecraft:zombie'}}});assert.match(t.lines(),/fresh canonical death identity verified/);assert.match(t.lines(),/no casualty accounting/);});
