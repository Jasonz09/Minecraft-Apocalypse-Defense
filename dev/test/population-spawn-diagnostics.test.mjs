import assert from "node:assert/strict";
import test from "node:test";
import {register} from "node:module";
register("data:text/javascript,"+encodeURIComponent(`export async function resolve(s,c,next){if(s==="@minecraft/server")return{url:"data:text/javascript,export const world={};export const system={};",shortCircuit:true};return next(s,c);}`));
const patchedReducer=await import("../../CivilizationApocalypse_BP/scripts/population/reconcile.js");
const {createPopSync}=await import("../../CivilizationApocalypse_BP/scripts/integration/popSync.js");
import {createPopWorld} from "../lib/poptharness.mjs";
import {createInitialKingdom} from "../../CivilizationApocalypse_BP/scripts/kingdom/state.js";
import {decodeCursor,emptyCursor,encodeCursor} from "../../CivilizationApocalypse_BP/scripts/population/cursor.js";
import {POP_CURSOR_KEY,POP_SYNC_DEFAULTS} from "../../CivilizationApocalypse_BP/scripts/population/settings.js";
import {decodeMilitarySelection,SWORDSMAN_TYPE} from "../../CivilizationApocalypse_BP/scripts/population/militarySelection.js";
import {standableNear} from "../../CivilizationApocalypse_BP/scripts/people/columns.js";
import {spotFor} from "../../CivilizationApocalypse_BP/scripts/population/groups.js";
import {tagFor} from "../../CivilizationApocalypse_BP/scripts/population/identity.js";
const GROUP="district-1:sol:0",home={x:0,y:64,z:0},homes={"district-1":home};
const selection=decodeMilitarySelection(JSON.stringify({v:1,trialId:"isolated-repro",fixtureId:"fake-world-only",groupId:GROUP,class:"swordsman",typeId:SWORDSMAN_TYPE,dimension:"minecraft:overworld"}));
function kingdom(){const k=createInitialKingdom();for(const d of k.districts){d.civilians=d.id==="district-1"?40:0;d.soldiers=d.id==="district-1"?20:0;d.garrison={front:d.soldiers,reserve:0};}return k;}
function fixture({allWater=false,allDry=false,military=true}={}){
 const pop=createPopWorld({homes});pop.setKingdom(kingdom());pop.setPlayers([{name:"observer",x:0,y:80,z:0}]);pop.loadArea(-64,-64,96,96);
 const footing=(x,z)=>allDry||!allWater&&(Math.round(x)===4&&Math.round(z)===4||Math.round(z)>=20)?"minecraft:grass_block":"minecraft:water";
 pop.dimension.getTopmostBlock=({x,z})=>({typeId:footing(x,z),location:{x,y:63,z}});
 pop.dimension.getBlock=({x,y,z})=>({typeId:y>63?"minecraft:air":footing(x,z),isValid:true});
 const sync=()=>createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>homes,enabled:true,...(military?{readMilitarySelection:()=>selection}:{})});
 return{pop,sync};
}
const cursor=pop=>decodeCursor(pop.world.getDynamicProperty(POP_CURSOR_KEY)).state;
const living=pop=>[...pop.state.entities.values()].filter(e=>e.alive);
function observation(k=kingdom(),extra={}){return{kingdom:k,entities:[],anchors:[{x:0,z:0}],homes,loadedChunks:["0,0","0,1","1,0","1,1"],...extra};}
test("rotation preserves admission and budgets while changing only pending order",()=>{
 const obs=observation(),state=emptyCursor(),first=patchedReducer.reconcile(state,obs,0);
 assert.equal(first.actions.length,2);assert.equal(first.report.groups.physical,8);
 const a=patchedReducer.reconcile({...state,runs:0},obs,1000),b=patchedReducer.reconcile({...state,runs:3},obs,1000);
 assert.deepEqual(a.state.physical,b.state.physical);assert.deepEqual(a.report.groups,b.report.groups);assert.deepEqual(a.report.budget,b.report.budget);assert.equal(a.report.pending.spawn,b.report.pending.spawn);assert.equal(a.actions.length,b.actions.length);assert.notDeepEqual(a.actions.map(x=>x.groupId),b.actions.map(x=>x.groupId));
});
test("early failed civilians no longer starve a loaded safe selected swordsman",()=>{
 const{pop,sync}=fixture(),births=[],skips=[];const spot=spotFor(home,"sol",0);assert.ok(standableNear(pop.dimension,spot.x,spot.z,{radius:4}));
 for(let hour=0;hour<12;hour++){const run=sync().reconcileOnce(hour*1000);assert.equal(run.refused,null);assert.equal(run.saved,true);assert.ok(run.actions.filter(a=>a.op==="spawn").length<=2);assert.ok(run.actions.length<=6);births.push(...run.applied.filter(a=>a.action.op==="spawn").map(a=>a.action.groupId));skips.push(...run.skipped.map(s=>s.reason));}
 assert.ok(births.includes(GROUP));assert.equal(births.filter(id=>id===GROUP).length,1);assert.ok(skips.includes("no-safe-standing-spot"));
 assert.equal(living(pop).filter(e=>e.typeId===SWORDSMAN_TYPE).length,1);assert.equal(cursor(pop).physical.length,8);assert.equal(pop.storedKingdom().districts[0].soldiers,20);
 for(const[group,counts]of pop.groupCounts())assert.equal(counts.total,1,group);
});
test("persisted cursor n advances even after all attempted births defer, and survives each rejoin",()=>{
 const{pop,sync}=fixture({allWater:true}),attempted=new Set();let prior=0;
 for(let hour=0;hour<8;hour++){
  pop.restart();const fresh=sync(),result=fresh.reconcileOnce(hour*1000);assert.equal(result.refused,null);assert.equal(result.applied.length,0);assert.ok(result.skipped.every(s=>s.reason==="no-safe-standing-spot"));
  for(const action of result.actions)if(action.op==="spawn")attempted.add(action.groupId);
  const raw=JSON.parse(pop.world.getDynamicProperty(POP_CURSOR_KEY));assert.equal(raw.n,prior+1);prior=raw.n;assert.equal(cursor(pop).runs,prior);
 }
 assert.equal(attempted.size,8,"every admitted pending group reaches the existing owner budget across persisted distinct hours");assert.equal(living(pop).length,0);
});
test("same-tick repeats cannot spend more attempts or entity operations",()=>{
 const{pop,sync}=fixture({allWater:true});const first=sync().reconcileOnce(1000);assert.equal(first.report.budget.spawnsUsed,2);
 const originalMutations=pop.state.spawned.length;
 for(let i=0;i<10;i++){const repeat=sync().reconcileOnce(1000);assert.equal(repeat.actions.filter(a=>a.op==="spawn").length,0);assert.equal(repeat.report.budget.spawnsUsed,2);assert.ok(repeat.report.budget.opsUsed<=6);}
 assert.equal(pop.state.spawned.length,originalMutations);
});
test("clock epoch reset preserves run-based fairness and retains same admission",()=>{
 const{pop,sync}=fixture({allWater:true});sync().reconcileOnce(5000);const saved=cursor(pop),roundTrip=decodeCursor(encodeCursor(saved)).state;
 assert.equal(roundTrip.runs,1);pop.restart();const after=sync().reconcileOnce(0);assert.equal(after.report.clockReset,true);assert.equal(cursor(pop).runs,2);assert.deepEqual(after.state?.physical??cursor(pop).physical,saved.physical);
 assert.equal(after.actions[0].groupId,"district-1:civ:1","restart uses saved n, not a reset game tick, to rotate");
});
test("dry-run inspection does not advance fairness or write state",()=>{
 const{pop,sync}=fixture({allWater:true});sync().reconcileOnce(0);const before=pop.world.getDynamicProperty(POP_CURSOR_KEY),writes=pop.state.propertyWrites.length,adapter=sync();
 const a=adapter.dryRun(1000),b=adapter.dryRun(1000);assert.deepEqual(a,b);assert.equal(pop.world.getDynamicProperty(POP_CURSOR_KEY),before);assert.equal(pop.state.propertyWrites.length,writes);
 const real=adapter.reconcileOnce(1000);assert.deepEqual(real.actions,a.actions);assert.equal(cursor(pop).runs,JSON.parse(before).n+1);
});
test("all-dry convergence and repeated fresh adapters never duplicate or change aggregate counts",()=>{
 const{pop,sync}=fixture({allDry:true}),snapshot=JSON.stringify(pop.storedKingdom());
 for(let hour=0;hour<20;hour++){pop.restart();const result=sync().reconcileOnce(hour*1000);assert.equal(result.refused,null);for(const[group,c]of pop.groupCounts())assert.equal(c.total,1,group);}
 assert.equal(living(pop).length,8);assert.equal(pop.state.spawned.length,8);assert.equal(JSON.stringify(pop.storedKingdom()),snapshot);
});
test("lost cursor adopts existing actors instead of recreating a rotated selected birth",()=>{
 const{pop,sync}=fixture({allDry:true});for(let h=0;h<5;h++)sync().reconcileOnce(h*1000);assert.equal(living(pop).length,8);const ids=living(pop).map(e=>e.id).sort();
 pop.setRawProperty(POP_CURSOR_KEY,undefined);pop.restart();const result=sync().reconcileOnce(0);assert.equal(result.applied.filter(x=>x.action.op==="spawn").length,0);assert.deepEqual(living(pop).map(e=>e.id).sort(),ids);assert.equal(cursor(pop).physical.length,8);
});
test("duplicate removals still precede birth attempts under the original operation cap",()=>{
 const obs=observation(kingdom(),{entities:[{id:"a",typeId:"minecraft:villager_v2",tags:[tagFor("district-1:civ:0")],loaded:true},{id:"b",typeId:"minecraft:villager_v2",tags:[tagFor("district-1:civ:0")],loaded:true}]}),state={...emptyCursor(),runs:7};
 const result=patchedReducer.reconcile(state,obs,1000,{maxOpsPerTick:1});assert.equal(result.actions.length,1);assert.equal(result.actions[0].op,"despawn");assert.equal(result.actions[0].reason,"duplicate");assert.equal(result.report.actions.spawn,0);
});
test("fight/unloaded gates and disabled adapter remain authoritative despite rotation",()=>{
 const k=kingdom();k.districts[0].security="contested";
 const fight=patchedReducer.reconcile({...emptyCursor(),runs:7},observation(k),1000);assert.equal(fight.report.actions.spawn,0);assert.ok(fight.report.deferred.some(x=>x.reason==="spawn-in-fight"));
 const unloaded=patchedReducer.reconcile({...emptyCursor(),runs:7},observation(kingdom(),{loadedChunks:[]}),1000);assert.equal(unloaded.report.actions.spawn,0);
 const{pop}=fixture({allDry:true});const disabled=createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>homes});assert.match(disabled.reconcileOnce(0).refused,/disabled/);assert.equal(living(pop).length,0);
});

test("inspection separates admitted intent from actual loaded absence and reports owner age",()=>{
 const {pop,sync}=fixture({allWater:true}),owner=sync();owner.reconcileOnce(1000);
 const prior=pop.world.getDynamicProperty(POP_CURSOR_KEY),writes=pop.state.propertyWrites.length,spawned=pop.state.spawned.length;
 const report=owner.inspectGroup(GROUP,2500);
 assert.equal(report.state,"ok");assert.equal(report.admitted,true);assert.equal(report.live.canonicalLoaded,0);assert.equal(report.live.expectedTypeLoaded,0);
 assert.equal(report.expectedType,SWORDSMAN_TYPE);assert.equal(report.ownerTick,1000);assert.equal(report.ageTicks,1500);
 assert.deepEqual(report.requested,{x:4,y:64,z:24});assert.equal(report.settle.point,null);assert.match(report.settle.reason,/no-safe-standing/);
 assert.equal(report.lastAttempt.status,"not queued within last attempt budget");
 assert.equal(pop.world.getDynamicProperty(POP_CURSOR_KEY),prior);assert.equal(pop.state.propertyWrites.length,writes);assert.equal(pop.state.spawned.length,spawned);
});
test("inspection reports an actual skipped attempt and successful settled birth",()=>{
 const wet=fixture({allWater:true}),a=wet.sync();a.reconcileOnce(1000);const skipped=a.inspectGroup("district-1:civ:0",1100);
 assert.equal(skipped.lastAttempt.status,"skipped");assert.equal(skipped.lastAttempt.reason,"no-safe-standing-spot");
 const dry=fixture({allDry:true}),b=dry.sync();b.reconcileOnce(1000);const born=b.inspectGroup("district-1:civ:0",1100);
 assert.equal(born.lastAttempt.status,"applied");assert.ok(born.lastAttempt.settled);assert.equal(born.live.expectedTypeLoaded,1);assert.equal(typeof born.live.entities[0].id,"string");
});
test("inspection counts native reads and keeps pathological canopy probes within240",()=>{
 const {pop,sync}=fixture({allDry:true}),owner=sync();owner.reconcileOnce(0);let reads=0,queries=0;
 pop.dimension.getTopmostBlock=({x,z})=>{reads++;return{typeId:"minecraft:oak_leaves",location:{x,y:319,z}};};
 pop.dimension.getBlock=({x,y,z})=>{reads++;return{typeId:"minecraft:oak_leaves",location:{x,y,z},isValid:true};};
 const query=pop.dimension.getEntities;pop.dimension.getEntities=q=>{queries++;return query(q);};
 const r=owner.inspectGroup(GROUP,1000);assert.equal(r.settle.nativeBlockReads,reads);assert.ok(reads<=240);assert.ok(reads>0);assert.equal(queries,1);assert.equal(r.settle.point,null);
});
test("unreadable native terrain and failed entity query remain unknown rather than living zero",()=>{
 const {pop,sync}=fixture({allWater:true}),owner=sync();owner.reconcileOnce(0);
 pop.dimension.getTopmostBlock=()=>{throw new Error("unloaded");};pop.dimension.getBlock=()=>{throw new Error("unloaded");};pop.dimension.getEntities=()=>{throw new Error("census unavailable");};
 const r=owner.inspectGroup(GROUP,1000);assert.equal(r.settle.point,null);assert.match(r.settle.reason,/unreadable/);assert.equal(r.live.canonicalLoaded,null);assert.equal(r.live.expectedTypeLoaded,null);assert.match(r.live.reason,/census unavailable/);
});
test("inspection bounds identity reads and preserves duplicate/wrong-type evidence",()=>{
 const {pop,sync}=fixture({allWater:true}),owner=sync();owner.reconcileOnce(0);let tagReads=0;
 const actor=typeId=>({id:"opaque-id",typeId,getTags:()=>{tagReads++;return[tagFor(GROUP)];}});
 pop.dimension.getEntities=()=>[actor("minecraft:pig"),actor(SWORDSMAN_TYPE)];
 let r=owner.inspectGroup(GROUP,1000);assert.equal(r.live.queryMatches,2);assert.equal(r.live.canonicalLoaded,2);assert.equal(r.live.expectedTypeLoaded,1);assert.equal(tagReads,2);
 tagReads=0;pop.dimension.getEntities=()=>Array.from({length:10000},()=>actor(SWORDSMAN_TYPE));
 r=owner.inspectGroup(GROUP,1000);assert.equal(tagReads,0);assert.equal(r.live.queryMatches,10000);assert.equal(r.live.canonicalLoaded,null);assert.match(r.live.reason,/bound/);
});
test("inspection cannot invent a plan or group before normal owner work",()=>{
 const {sync}=fixture(),owner=sync();assert.equal(owner.inspectGroup(GROUP,0).state,"unavailable");owner.reconcileOnce(0);
 assert.equal(owner.inspectGroup("district-1:sol:999",1000).state,"unavailable");assert.equal(owner.inspectGroup("nonsense",1000).state,"unavailable");
});

test("streets labels admission as intent and exposes deferred births without claiming living soldiers",async()=>{
 const {createPeopleStreets}=await import("../../CivilizationApocalypse_BP/scripts/integration/peopleStreets.js");
 const {pop}=fixture({allWater:true});const streets=createPeopleStreets({homes:()=>homes,isGateOn:()=>true,readMilitarySelection:()=>selection});
 assert.match(streets.inspectCommand("group="+GROUP).join("\n"),/no owner plan/);
 streets.onHour({world:pop.world,dimension:pop.dimension,kingdom:pop.storedKingdom(),report:{ran:1},tick:1000});
 const status=streets.status();assert.equal(status.admittedCiv,4);assert.equal(status.admittedSol,4);assert.equal(status.created,0);assert.match(status.births,/no-safe-standing-spot/);assert.equal("civ" in status,false);assert.equal("sol" in status,false);assert.match(status.lod,/admitted=/);
 const before=pop.state.propertyWrites.length,lines=streets.inspectCommand("group="+GROUP).join("\n");
 assert.match(lines,/Cached owner tick 1000/);assert.match(lines,/Admitted intent: yes; fresh loaded canonical: 0/);assert.match(lines,/Native block reads:/);assert.match(lines,/not proof about unloaded/);assert.equal(pop.state.propertyWrites.length,before);assert.equal(pop.state.spawned.length,0);
 assert.match(streets.inspectCommand("group="+GROUP+" extra")[0],/Usage:/);
});

test("inspection refuses an oversized identity tag list without converting it to an empty census",()=>{
 const {pop,sync}=fixture({allWater:true}),owner=sync();owner.reconcileOnce(0);
 pop.dimension.getEntities=()=>[{id:"opaque",typeId:SWORDSMAN_TYPE,getTags:()=>Array(10000).fill(tagFor(GROUP))}];
 const r=owner.inspectGroup(GROUP,1000);assert.equal(r.live.canonicalLoaded,null);assert.equal(r.live.expectedTypeLoaded,null);assert.match(r.live.reason,/inspection bound/);
});
