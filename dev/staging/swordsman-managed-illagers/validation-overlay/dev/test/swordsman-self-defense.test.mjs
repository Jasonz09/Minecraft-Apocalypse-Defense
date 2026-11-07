import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
const source=JSON.parse(readFileSync(new URL("../../CivilizationApocalypse_BP/entities/swordsman.json",import.meta.url),"utf8"));
const historical=JSON.parse(readFileSync(new URL("../prototypes/swordsman/BP/entities/swordsman.json",import.meta.url),"utf8"));
const c=source["minecraft:entity"].components,reactive=c["minecraft:behavior.hurt_by_target"],proactive=c["minecraft:behavior.nearest_attackable_target"];
// Evaluate the small documented Bedrock filter subset against family/tag facts;
// this does not model native damage events, goal arbitration or navigation.
function matches(filter,families,tags=[]){
    if(filter.all_of)return filter.all_of.every(f=>matches(f,families,tags));
    if(filter.any_of)return filter.any_of.some(f=>matches(f,families,tags));
    assert.equal(filter.subject,"other");assert.ok(["is_family","has_tag"].includes(filter.test));
    const result=(filter.test==="is_family"?families:tags).includes(filter.value);
    assert.ok(filter.operator===undefined||["not","!="].includes(filter.operator));
    return filter.operator===undefined?result:!result;
}
test("active entity changes only reviewed hostile-family predicates and filtered self-defense; home, persistence and spawn policy remain exact",()=>{
    const without=structuredClone(source);delete without["minecraft:entity"].components["minecraft:behavior.hurt_by_target"];
    without["minecraft:entity"].components["minecraft:behavior.nearest_attackable_target"].entity_types[0].filters.all_of[0]=structuredClone(historical["minecraft:entity"].components["minecraft:behavior.nearest_attackable_target"].entity_types[0].filters.all_of[0]);
    assert.deepEqual(without,historical);
    assert.equal(reactive.entity_types.length,1);assert.equal(reactive.alert_same_type,false);assert.equal(reactive.hurt_owner,false);
    assert.ok(reactive.priority<proactive.priority);
    assert.equal(source["minecraft:entity"].description.is_spawnable,false);
});
test("self-defense permits zombie/illager attackers and excludes every friendly family, including mixed-family attackers",()=>{
    const filter=reactive.entity_types[0].filters,friends=["player","villager","irongolem","civ_guard"];
    for(let mask=0;mask<16;mask++)for(const zombie of [false,true]){
        const families=friends.filter((_,i)=>mask&(1<<i));if(zombie)families.push("zombie");
        assert.equal(matches(filter,families),zombie&&mask===0,JSON.stringify(families));
        assert.equal(matches(filter,families,["civbesiege:v1"]),zombie&&mask===0,"siege tag cannot override friendliness");
    }
    for(const hostile of [["illager","pillager"],["illager","vindicator"]])for(let mask=0;mask<16;mask++){
        const families=[...hostile,...friends.filter((_,i)=>mask&(1<<i))];
        assert.equal(matches(filter,families),mask===0,JSON.stringify(families));
        assert.equal(matches(filter,families,["civbesiege:v1"]),mask===0,"siege tag cannot override friendliness");
    }
    for(const family of ["skeleton","spider","pillager","monster"])assert.equal(matches(filter,[family]),false,family);
    const target=proactive.entity_types[0].filters;
    assert.equal(matches(target,["zombie"]),false,"ordinary zombies are not proactively hunted");
    assert.equal(matches(target,["zombie"],["civbesiege:v1:district-1"]),false,"per-district marker is not the shared siege tag");
    assert.equal(matches(target,["zombie"],["civbesiege:v1"]),true);
});
test("retaliation retains short visible targeting and revalidates filters inside the unchanged home/path/cooldown limits",()=>{
    const target=reactive.entity_types[0];assert.equal(target.max_dist,10);assert.equal(target.must_see,true);
    assert.equal(target.must_see_forget_duration,1);assert.equal(target.reevaluate_description,true);
    assert.deepEqual(c["minecraft:home"],{restriction_radius:12,restriction_type:"all_movement"});
    assert.ok(target.max_dist<=c["minecraft:home"].restriction_radius);
    assert.equal(c["minecraft:behavior.melee_attack"].cooldown_time,1);assert.equal(c["minecraft:behavior.melee_attack"].require_complete_path,true);
    assert.equal(c["minecraft:navigation.walk"].can_break_doors,false);assert.equal(c["minecraft:navigation.walk"].can_open_doors,false);
    assert.equal(c["minecraft:attack"].damage,4);
});
