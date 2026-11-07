// Historical pre-fairness queue reproducer (old loop reconstructed in memory) in an isolated fake world. No active files,
// native Minecraft, pack deployment or existing test sources are changed.
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {createPopWorld} from "../lib/poptharness.mjs";
register("data:text/javascript,"+encodeURIComponent(`export async function resolve(s,c,next){if(s==="@minecraft/server")return{url:"data:text/javascript,export const world={};export const system={};",shortCircuit:true};return next(s,c);}`));
const reducerUrl=new URL("../../CivilizationApocalypse_BP/scripts/population/reconcile.js",import.meta.url);
const active=readFileSync(reducerUrl,"utf8").replace(/\r\n/g,"\n");
const begin=active.indexOf("    let spawned = 0;"),end=active.indexOf("        if (opsLeft > 0 && spawnsLeft > 0)",begin);
assert.ok(begin>=0&&end>begin);
const historical=active.slice(0,begin)+"    let spawned = 0;\n    for (const op of spawns) {\n"+active.slice(end);
const historicalUrl="data:text/javascript,"+encodeURIComponent(historical.replace(/from\s+"(\.[^"]+)"/g,(_,specifier)=>"from "+JSON.stringify(new URL(specifier,reducerUrl).href)));
register("data:text/javascript,"+encodeURIComponent(`export async function resolve(s,c,next){if(s==="../population/reconcile.js"&&c.parentURL?.endsWith("/integration/popSync.js"))return{url:${JSON.stringify(historicalUrl)},shortCircuit:true};return next(s,c);}`));
const base="../../CivilizationApocalypse_BP/scripts/";
const {createInitialKingdom}=await import(base+"kingdom/state.js");
const {createPopSync}=await import(base+"integration/popSync.js");
const {standableNear}=await import(base+"people/columns.js");
const {spotFor}=await import(base+"population/groups.js");
const {POP_CURSOR_KEY}=await import(base+"population/settings.js");
const {decodeCursor}=await import(base+"population/cursor.js");
const {decodeMilitarySelection,SWORDSMAN_TYPE}=await import(base+"population/militarySelection.js");
const home={x:0,y:64,z:0},homes={"district-1":home};
const kingdom=createInitialKingdom();
for(const district of kingdom.districts){district.civilians=district.id==="district-1"?40:0;district.soldiers=district.id==="district-1"?20:0;district.garrison={front:district.soldiers,reserve:0};}
const pop=createPopWorld({homes});pop.setKingdom(kingdom);pop.setPlayers([{name:"observer",x:0,y:80,z:0}]);pop.loadArea(-64,-64,96,96);
// Civ:0 can stand, subsequent early civilian slots cannot, while every soldier
// slot is dry. This deliberately distinguishes starvation from a bad levy spot.
const footing=(x,z)=>Math.round(x)===4&&Math.round(z)===4||Math.round(z)>=20?"minecraft:grass_block":"minecraft:water";
pop.dimension.getTopmostBlock=({x,z})=>({typeId:footing(x,z),location:{x,y:63,z}});
pop.dimension.getBlock=({x,y,z})=>({typeId:y>63?"minecraft:air":footing(x,z),isValid:true});
const selection=decodeMilitarySelection(JSON.stringify({v:1,trialId:"isolated-repro",fixtureId:"fake-world-only",groupId:"district-1:sol:0",class:"swordsman",typeId:SWORDSMAN_TYPE,dimension:"minecraft:overworld"}));
const sync=createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>homes,enabled:true,readMilitarySelection:()=>selection});
const soldierSpot=spotFor(home,"sol",0),soldierStanding=standableNear(pop.dimension,soldierSpot.x,soldierSpot.z,{radius:4});
assert.ok(soldierStanding,"selected soldier has safe loaded footing and headroom");
const hours=[];
for(let hour=0;hour<6;hour++){
    const result=sync.reconcileOnce(hour*1000);
    assert.equal(result.refused,null);assert.equal(result.saved,true);
    hours.push({hour,admitted:result.report.groups.physical,actions:result.actions.map(a=>({op:a.op,groupId:a.groupId,typeId:a.typeId})),applied:result.applied.map(a=>a.action.groupId),skipped:result.skipped.map(s=>({groupId:s.action.groupId,reason:s.reason})),failed:result.failed,pendingSpawns:result.report.pending.spawn});
}
const cursor=decodeCursor(pop.world.getDynamicProperty(POP_CURSOR_KEY));
const living=[...pop.state.entities.values()].filter(e=>e.alive);
assert.equal(living.length,1);assert.deepEqual([...living[0].tags],["civpop:v1:district-1:civ:0"]);
assert.equal(cursor.state.physical.length,8,"admission intent survives deferred native births");
assert.equal(living.some(e=>e.typeId===SWORDSMAN_TYPE||e.typeId==="minecraft:iron_golem"),false);
assert.ok(hours.slice(1).every(h=>h.actions.every(a=>a.groupId.includes(":civ:"))),"failed early civilians starve a safe selected soldier across different ticks/hours");
assert.ok(hours.slice(1).every(h=>h.skipped.every(s=>s.reason==="no-safe-standing-spot")));
console.log(JSON.stringify({scope:"isolated fake world; not native causation proof",soldierSpot,soldierStanding,living:living.map(e=>({id:e.id,typeId:e.typeId,tags:[...e.tags]})),admitted:cursor.state.physical,hours},null,2));
