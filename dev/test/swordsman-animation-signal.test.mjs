import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync} from "node:fs";
const root=new URL("../../CivilizationApocalypse_RP/",import.meta.url);
const read=path=>JSON.parse(readFileSync(new URL(path,root),"utf8"));
function files(url){return readdirSync(url,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(new URL(e.name+"/",url)):e.name.endsWith(".json")?[new URL(e.name,url)]:[]);}
// Native Nov6 log rejected query.attack_time in all three expressions. The
// supported engine variable is documented in Microsoft Practical Molang and
// Mojang's humanoid attack animation. Static checks do not prove native rendering.
test("all active resource definitions reject the unsupported attack query and use the native variable at all three hooks",()=>{
    const text=files(root).map(p=>readFileSync(p,"utf8")).join("\n");
    assert.doesNotMatch(text,/\b(?:query|q)\.attack_time\b/);
    assert.equal((text.match(/\bvariable\.attack_time\b/g)??[]).length,3);
    const client=read("entity/swordsman.entity.json")["minecraft:client_entity"].description;
    assert.equal(client.scripts.animate.find(a=>typeof a==="object"&&Object.hasOwn(a,"attack")).attack,"variable.attack_time > 0.0");
    const attack=read("animations/swordsman.animation.json").animations[client.animations.attack];
    assert.deepEqual(attack.bones.right_arm.rotation,["-math.sin(variable.attack_time * 180) * 90",0,"-math.sin(variable.attack_time * 180) * 10"]);
});
test("the engine attack variable is never overwritten and attack visuals do not use a fabricated clock or target-presence trigger",()=>{
    const client=read("entity/swordsman.entity.json")["minecraft:client_entity"].description;
    const text=JSON.stringify(client.scripts)+JSON.stringify(read("animations/swordsman.animation.json").animations[client.animations.attack]);
    assert.doesNotMatch(text,/\b(?:variable|v)\.attack_time\s*=(?!=)/);
    assert.doesNotMatch(text,/\b(?:query|q)\.(?:life_time|anim_time|has_target)\b/);
    assert.equal(client.scripts.initialize,undefined);assert.equal(client.scripts.pre_animation,undefined);
});
