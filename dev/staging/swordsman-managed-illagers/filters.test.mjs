import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=name=>readFileSync(new URL(name,import.meta.url));
const before=JSON.parse(read("./frozen-swordsman.json")),after=JSON.parse(read("./proposed-swordsman.json")),pin=JSON.parse(read("./source-pin.json"));
const components=entity=>entity["minecraft:entity"].components;
const filter=(entity,goal)=>components(entity)[`minecraft:behavior.${goal}`].entity_types[0].filters;
const sha=bytes=>createHash("sha256").update(bytes).digest("hex").toUpperCase();
// Interpret only the actual JSON filter vocabulary present here, not movement,
// goal priorities, line of sight or any native AI. Unknown forms fail the test.
function accepts(node,actor){
 if(node.all_of){assert.equal(Object.keys(node).length,1);return node.all_of.every(n=>accepts(n,actor));}
 if(node.any_of){assert.equal(Object.keys(node).length,1);return node.any_of.some(n=>accepts(n,actor));}
 assert.equal(node.subject,"other");assert.ok(["is_family","has_tag"].includes(node.test));assert.ok(node.operator===undefined||node.operator==="not");
 const found=(node.test==="is_family"?actor.families:actor.tags).includes(node.value);return node.operator==="not"?!found:found;
}
const actor=(families,tags=[])=>({families,tags});
test("negative control is the exact active production baseline; primary vanilla families are content-pinned",()=>{
 const actual=readFileSync(new URL("../../../CivilizationApocalypse_BP/entities/swordsman.json",import.meta.url));assert.equal(sha(actual),pin.sourceEntitySha256);assert.deepEqual(JSON.parse(actual),before);assert.equal(sha(read("./proposed-swordsman.json")),pin.proposedEntitySha256);
 for(const primary of pin.primaryVanillaClassifications){const bytes=read(primary.file);assert.equal(sha(bytes),primary.sha256);assert.equal(createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest("hex"),primary.gitBlobSha1);
  const match=bytes.toString("utf8").match(/"minecraft:type_family"\s*:\s*\{\s*"family"\s*:\s*(\[[^\]]+\])/);assert.ok(match);assert.deepEqual(JSON.parse(match[1]),primary.families);assert.ok(primary.families.includes("illager"));assert.ok(!primary.families.includes("zombie"));assert.match(primary.url,/^https:\/\/raw\.githubusercontent\.com\/Mojang\/bedrock-samples\/v1\.26\.0\.2\//);
 }
});
test("actual production filter excludes managed default illagers while proposed proactive filter admits them only with managed tag",()=>{
 for(const primary of pin.primaryVanillaClassifications){const tagged=actor(primary.families,["civbesiege:v1"]),unmarked=actor(primary.families);
  assert.equal(accepts(filter(before,"nearest_attackable_target"),tagged),false);assert.equal(accepts(filter(after,"nearest_attackable_target"),tagged),true);assert.equal(accepts(filter(after,"nearest_attackable_target"),unmarked),false);
  assert.equal(accepts(filter(before,"hurt_by_target"),tagged),false);assert.equal(accepts(filter(after,"hurt_by_target"),unmarked),true);
 }
});
test("existing zombie targeting and friendly exclusions remain strict under mixed-family adversarial cases",()=>{
 const zombie=actor(["zombie","monster","mob"]);assert.equal(accepts(filter(after,"nearest_attackable_target"),zombie),false);assert.equal(accepts(filter(after,"hurt_by_target"),zombie),true);zombie.tags.push("civbesiege:v1");assert.equal(accepts(filter(after,"nearest_attackable_target"),zombie),true);
 for(const friendly of ["player","villager","irongolem","civ_guard"])for(const enemy of [["zombie"],["illager","pillager"],["illager","vindicator"]]){
  const mixed=actor([...enemy,friendly,"mob"],["civbesiege:v1"]);for(const goal of ["nearest_attackable_target","hurt_by_target"])assert.equal(accepts(filter(after,goal),mixed),false,`${goal}:${friendly}`);
 }
});
test("unknown monsters/passives stay excluded and generic illager family does not broaden proactive targets",()=>{
 for(const families of [["creeper","monster","mob"],["enderman","monster","mob"],["cow","animal","mob"],["mob"]])for(const goal of ["nearest_attackable_target","hurt_by_target"])assert.equal(accepts(filter(after,goal),actor(families,["civbesiege:v1"])),false);
 const otherIllager=actor(["illager","monster","mob"],["civbesiege:v1"]);assert.equal(accepts(filter(after,"nearest_attackable_target"),otherIllager),false);assert.equal(accepts(filter(after,"hurt_by_target"),otherIllager),true);
});
test("the complete entity differs at exactly the two reviewed family predicates and nowhere else",()=>{
 const restored=structuredClone(after);
 for(const goal of ["nearest_attackable_target","hurt_by_target"])components(restored)[`minecraft:behavior.${goal}`].entity_types[0].filters.all_of[0]=structuredClone(filter(before,goal).all_of[0]);
 assert.deepEqual(restored,before);const c=components(after);assert.deepEqual(c["minecraft:health"],{value:30,max:30});assert.deepEqual(c["minecraft:attack"],{damage:4});assert.equal(c["minecraft:behavior.melee_attack"].require_complete_path,true);assert.equal(c["minecraft:behavior.melee_attack"].reach_multiplier,1.5);assert.equal(c["minecraft:behavior.melee_attack"].cooldown_time,1);
 assert.ok(filter(after,"nearest_attackable_target").all_of.some(n=>n.test==="has_tag"&&n.value==="civbesiege:v1"));
});
