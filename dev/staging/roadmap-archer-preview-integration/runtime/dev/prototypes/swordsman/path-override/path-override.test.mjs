import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
const root=new URL("./",import.meta.url),project=new URL("../../../../",root);
const json=url=>JSON.parse(readFileSync(url,"utf8"));
const sourceUrl=new URL("CivilizationApocalypse_BP/entities/swordsman.json",project),source=json(sourceUrl),variant=json(new URL("BP/entities/swordsman.json",root));
const manifest=json(new URL("BP/manifest.json",root)),bp=json(new URL("CivilizationApocalypse_BP/manifest.json",project)),rp=json(new URL("CivilizationApocalypse_RP/manifest.json",project));
test("probe is pinned to verified source and changes exactly complete-path requirement",()=>{
    assert.equal(createHash("sha256").update(readFileSync(sourceUrl)).digest("hex").toUpperCase(),"C0AB66464976DF1EF0ADE7685C0C5800AB96D4EE0BA8A8AEDAED462098958D82");
    assert.equal(source["minecraft:entity"].components["minecraft:behavior.melee_attack"].require_complete_path,true);
    assert.equal(variant["minecraft:entity"].components["minecraft:behavior.melee_attack"].require_complete_path,false);
    const restored=structuredClone(variant);restored["minecraft:entity"].components["minecraft:behavior.melee_attack"].require_complete_path=true;
    assert.deepEqual(restored,source);
});
test("probe is data-only with distinct valid UUIDs and retains exact owner plus resource dependencies",()=>{
    assert.deepEqual(readdirSync(new URL("BP/",root)).sort(),["entities","manifest.json"]);
    assert.deepEqual(readdirSync(new URL("BP/entities/",root)),["swordsman.json"]);
    assert.equal(manifest.format_version,2);assert.deepEqual(manifest.modules.map(m=>m.type),["data"]);
    assert.deepEqual(manifest.header.version,[0,0,1]);assert.deepEqual(manifest.header.min_engine_version,bp.header.min_engine_version);
    const ids=[manifest.header.uuid,...manifest.modules.map(m=>m.uuid),bp.header.uuid,...bp.modules.map(m=>m.uuid),rp.header.uuid,...rp.modules.map(m=>m.uuid)];
    assert.equal(new Set(ids).size,ids.length);for(const id of ids)assert.match(id,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.deepEqual(manifest.dependencies,[{uuid:bp.header.uuid,version:bp.header.version},{uuid:rp.header.uuid,version:rp.header.version}]);
});
test("probe preserves canonical class, unspawnable policy, filtered retaliation, home and damage limits",()=>{
    const entity=variant["minecraft:entity"],c=entity.components;
    assert.equal(entity.description.identifier,"civ_trial:swordsman");assert.equal(entity.description.is_spawnable,false);
    for(const name of ["minecraft:home","minecraft:behavior.move_towards_home_restriction","minecraft:behavior.hurt_by_target","minecraft:behavior.nearest_attackable_target","minecraft:attack","minecraft:navigation.walk"])
        assert.deepEqual(c[name],source["minecraft:entity"].components[name]);
    assert.equal(c["minecraft:behavior.melee_attack"].cooldown_time,1);assert.equal(c["minecraft:attack"].damage,4);
});
