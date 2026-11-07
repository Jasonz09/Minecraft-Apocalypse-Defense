import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=name=>readFileSync(new URL(name,import.meta.url));
const beforeBytes=read("../fixtures/swordsman-before-managed-illagers.json"),before=JSON.parse(beforeBytes),actual=JSON.parse(read("../../CivilizationApocalypse_BP/entities/swordsman.json")),facts=JSON.parse(read("../fixtures/swordsman-managed-illager-families.json"));
const components=entity=>entity["minecraft:entity"].components;
const filter=(entity,goal)=>components(entity)[`minecraft:behavior.${goal}`].entity_types[0].filters;
// Logical JSON-filter contract only. This does not simulate native target/goal/path AI.
function accepts(node,actor){
 if(node.all_of){assert.equal(Object.keys(node).length,1);return node.all_of.every(n=>accepts(n,actor));}
 if(node.any_of){assert.equal(Object.keys(node).length,1);return node.any_of.some(n=>accepts(n,actor));}
 assert.equal(node.subject,"other");assert.ok(["is_family","has_tag"].includes(node.test));assert.ok(node.operator===undefined||node.operator==="not");
 const found=(node.test==="is_family"?actor.families:actor.tags).includes(node.value);return node.operator==="not"?!found:found;
}
const actor=(families,tags=[])=>({families,tags});
test("frozen actual C0AB production baseline and reviewed primary illager facts remain pinned",()=>{
 const oldSha=createHash("sha256").update(beforeBytes).digest("hex").toUpperCase();assert.equal(oldSha,"C0AB66464976DF1EF0ADE7685C0C5800AB96D4EE0BA8A8AEDAED462098958D82");assert.equal(oldSha,facts.sourceEntitySha256);
 assert.deepEqual(facts.primaryVanillaClassifications.map(s=>s.typeId),["minecraft:pillager","minecraft:vindicator"]);
 for(const sample of facts.primaryVanillaClassifications){assert.deepEqual(sample.families,[sample.typeId.slice(10),"monster","illager","mob"]);assert.match(sample.url,/^https:\/\/raw\.githubusercontent\.com\/Mojang\/bedrock-samples\/v1\.26\.0\.2\/behavior_pack\/entities\/(pillager|vindicator)\.json$/);assert.match(sample.sha256,/^[A-F0-9]{64}$/);assert.match(sample.gitBlobSha1,/^[a-f0-9]{40}$/);}
});
test("actual production filter fixes pinned managed pillager/vindicator refusal without allowing unmarked proactive targets",()=>{
 for(const sample of facts.primaryVanillaClassifications){const marked=actor(sample.families,["civbesiege:v1"]),unmarked=actor(sample.families);
  assert.equal(accepts(filter(before,"nearest_attackable_target"),marked),false);assert.equal(accepts(filter(before,"hurt_by_target"),marked),false);
  assert.equal(accepts(filter(actual,"nearest_attackable_target"),marked),true);assert.equal(accepts(filter(actual,"nearest_attackable_target"),unmarked),false);assert.equal(accepts(filter(actual,"hurt_by_target"),unmarked),true);
 }
});
test("actual friendly-family exclusions override every hostile family even with managed tag",()=>{
 for(const friendly of ["player","villager","irongolem","civ_guard"])for(const hostile of [["zombie"],["illager","pillager"],["illager","vindicator"]])for(const goal of ["nearest_attackable_target","hurt_by_target"])assert.equal(accepts(filter(actual,goal),actor([...hostile,friendly,"mob"],["civbesiege:v1"])),false);
});
test("zombie behavior stays unchanged; unrelated monsters and generic illager proactive targets stay excluded",()=>{
 for(const tags of [[],["civbesiege:v1"]])for(const goal of ["nearest_attackable_target","hurt_by_target"]){const zombie=actor(["zombie","monster","mob"],tags);assert.equal(accepts(filter(actual,goal),zombie),accepts(filter(before,goal),zombie));}
 for(const families of [["creeper","monster","mob"],["enderman","monster","mob"],["cow","animal","mob"],["mob"]])for(const goal of ["nearest_attackable_target","hurt_by_target"])assert.equal(accepts(filter(actual,goal),actor(families,["civbesiege:v1"])),false);
 assert.equal(accepts(filter(actual,"nearest_attackable_target"),actor(["illager","monster","mob"],["civbesiege:v1"])),false);
});
test("actual entire entity differs only at the two reviewed family predicates; tuning/home/priority/path remain unchanged",()=>{
 const restored=structuredClone(actual);for(const goal of ["nearest_attackable_target","hurt_by_target"])components(restored)[`minecraft:behavior.${goal}`].entity_types[0].filters.all_of[0]=structuredClone(filter(before,goal).all_of[0]);assert.deepEqual(restored,before);
 const c=components(actual);assert.deepEqual(c["minecraft:health"],{value:30,max:30});assert.deepEqual(c["minecraft:attack"],{damage:4});assert.equal(c["minecraft:behavior.melee_attack"].require_complete_path,true);assert.equal(c["minecraft:behavior.melee_attack"].reach_multiplier,1.5);assert.equal(c["minecraft:behavior.melee_attack"].cooldown_time,1);assert.ok(filter(actual,"nearest_attackable_target").all_of.some(n=>n.test==="has_tag"&&n.value==="civbesiege:v1"));
});
