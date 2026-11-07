import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contentPackProblems, packBindingProblems, packBindings } from "../lib/content-packs.mjs";
import { archivePackProblems } from "../lib/pack-parity.mjs";
import { writeZip } from "../lib/zip.mjs";

const project=resolve(import.meta.dirname,"../..");
function fixture(t) {
    const root=mkdtempSync(join(tmpdir(),"civ-content-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const bp=join(root,"BP"),rp=join(root,"RP");mkdirSync(bp);
    cpSync(join(project,"CivilizationApocalypse_BP/manifest.json"),join(bp,"manifest.json"));
    cpSync(join(project,"CivilizationApocalypse_BP/entities"),join(bp,"entities"),{recursive:true});
    cpSync(join(project,"CivilizationApocalypse_RP"),rp,{recursive:true});
    return {root,bp,rp,packs:[{root:bp,kind:"behavior_packs"},{root:rp,kind:"resource_packs"}]};
}
function mutate(file,change) {const j=JSON.parse(readFileSync(file,"utf8"));change(j);writeFileSync(file,JSON.stringify(j));}

test("active swordsman content preserves scripts, remains opt-in, and resolves its original rendering assets",t=>{
    const f=fixture(t);assert.deepEqual(contentPackProblems(f.packs),[]);
    const bp=JSON.parse(readFileSync(join(f.bp,"manifest.json")));
    assert.equal(bp.header.uuid,"fd04cb50-dddc-4ebe-83fc-5b5375819bcb");
    assert.equal(bp.modules.find(m=>m.type==="script").uuid,"eeb1f41d-2811-4f68-9d0b-7303188f3867");
    assert.equal(bp.modules.find(m=>m.type==="script").entry,"scripts/main.js");
    assert.equal(bp.dependencies.find(d=>d.module_name==="@minecraft/server").version,"2.7.0");
    const entity=JSON.parse(readFileSync(join(f.bp,"entities/swordsman.json")))["minecraft:entity"];
    assert.equal(entity.description.is_spawnable,false);assert.equal(entity.description.is_summonable,true);
    const activeDefinition=JSON.parse(readFileSync(join(f.bp,"entities/swordsman.json")));
    assert.ok(activeDefinition["minecraft:entity"].components["minecraft:behavior.hurt_by_target"],"active guard adds reviewed filtered self-defense");
    delete activeDefinition["minecraft:entity"].components["minecraft:behavior.hurt_by_target"];
    const historicalDefinition=JSON.parse(readFileSync(join(project,"dev/prototypes/swordsman/BP/entities/swordsman.json")));
    activeDefinition["minecraft:entity"].components["minecraft:behavior.nearest_attackable_target"].entity_types[0].filters.all_of[0]=structuredClone(historicalDefinition["minecraft:entity"].components["minecraft:behavior.nearest_attackable_target"].entity_types[0].filters.all_of[0]);
    assert.deepEqual(activeDefinition,historicalDefinition,"every other entity field preserves the historical prototype; exactly reviewed self-defense and proactive family predicates have dedicated tests");
    assert.notEqual(JSON.parse(readFileSync(join(f.rp,"manifest.json"))).header.uuid,JSON.parse(readFileSync(join(project,"dev/prototypes/swordsman/RP/manifest.json"))).header.uuid);
    for(const [path,corrections]of [["entity/swordsman.entity.json",1],["animations/swordsman.animation.json",2]]){
        const historical=readFileSync(join(project,"dev/prototypes/swordsman/RP",path),"utf8");
        assert.equal(historical.match(/query\.attack_time/g).length,corrections);
        assert.deepEqual(JSON.parse(readFileSync(join(f.rp,path),"utf8")),JSON.parse(historical.replaceAll("query.attack_time","variable.attack_time")),"RP differs from historical assets only by the reviewed native attack-progress correction: "+path);
    }
});

test("pack graph rejects a missing RP, mismatched dependency version and missing BP data module",t=>{
    const f=fixture(t);
    assert.match(contentPackProblems([f.packs[0]]).join("\n"),/missing or ambiguous content dependency/);
    mutate(join(f.rp,"manifest.json"),m=>m.header.version=[1,0,1]);
    assert.match(contentPackProblems(f.packs).join("\n"),/dependency version mismatch/);
    mutate(join(f.bp,"manifest.json"),m=>m.modules=m.modules.filter(x=>x.type!=="data"));
    assert.match(contentPackProblems(f.packs).join("\n"),/requires a data module/);
    mutate(join(f.bp,"manifest.json"),m=>m.dependencies=m.dependencies.filter(x=>!x.uuid));
    assert.match(contentPackProblems(f.packs).join("\n"),/requires an explicit resource-pack dependency/);
});

test("missing entity, texture, geometry and animation references fail before packaging",t=>{
    const f=fixture(t);
    rmSync(join(f.bp,"entities/swordsman.json"));
    assert.match(contentPackProblems(f.packs).join("\n"),/required entity pair is missing/);
    rmSync(join(f.rp,"textures/entity/civ_trial/swordsman.png"));
    mutate(join(f.rp,"entity/swordsman.entity.json"),m=>{
        const d=m["minecraft:client_entity"].description;d.geometry.default="geometry.missing";d.animations.walk="animation.missing";
    });
    const problems=contentPackProblems(f.packs).join("\n");
    assert.match(problems,/missing texture/);assert.match(problems,/missing geometry geometry.missing/);assert.match(problems,/missing animation animation.missing/);
});

test("bindings require exactly one current-version pack of each kind",t=>{
    const f=fixture(t),rp=packBindings(f.packs,"resource_packs");
    assert.deepEqual(packBindingProblems(rp,rp,"world_resource_packs.json"),[]);
    assert.match(packBindingProblems([],rp,"RP").join("\n"),/exactly once/);
    assert.match(packBindingProblems([...rp,...rp],rp,"RP").join("\n"),/exactly once/);
    assert.match(packBindingProblems([{...rp[0],version:[0,1,0]}],rp,"RP").join("\n"),/version mismatch/);
    assert.match(packBindingProblems([{pack_id:"foreign",version:[1,0,0]}],rp,"RP").join("\n"),/not shipped/);
});

test("archive parity detects omitted and stale military resource assets",t=>{
    const f=fixture(t),staged=join(f.root,"staged"),archive=join(f.root,"pack.mctemplate");
    const packs=[{source:"BP",kind:"behavior_packs",packageDir:"CivApocBP"},{source:"RP",kind:"resource_packs",packageDir:"CivApocRP"}];
    for(const p of packs)cpSync(join(f.root,p.source),join(staged,p.kind,p.packageDir),{recursive:true});
    writeZip(staged,archive);assert.deepEqual(archivePackProblems(archive,{packs},f.root),[]);
    assert.match(archivePackProblems(archive,{packs},f.root,{requireBindings:true}).join("\n"),/archive must contain world_resource_packs.json exactly once/);
    for(const kind of ["behavior_packs","resource_packs"])writeFileSync(join(staged,kind==="behavior_packs"?"world_behavior_packs.json":"world_resource_packs.json"),JSON.stringify(packBindings(f.packs,kind)));
    writeZip(staged,archive);assert.deepEqual(archivePackProblems(archive,{packs},f.root,{requireBindings:true}),[]);
    writeFileSync(join(staged,"world_resource_packs.json"),"[]");writeZip(staged,archive);
    assert.match(archivePackProblems(archive,{packs},f.root,{requireBindings:true}).join("\n"),/world_resource_packs.json must bind shipped pack/);
    const texture="resource_packs/CivApocRP/textures/entity/civ_trial/swordsman.png";
    writeFileSync(join(staged,texture),"stale texture");writeZip(staged,archive);
    assert.match(archivePackProblems(archive,{packs},f.root).join("\n"),/stale packaged file: .*swordsman.png/);
    rmSync(join(staged,texture));writeZip(staged,archive);
    assert.match(archivePackProblems(archive,{packs},f.root).join("\n"),/missing packaged file: .*swordsman.png/);
});
