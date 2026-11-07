import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
const stage=new URL('./',import.meta.url),root=new URL('../../../',stage);
const json=p=>JSON.parse(readFileSync(p,'utf8')),sourceUrl=new URL('CivilizationApocalypse_BP/entities/swordsman.json',root),variantUrl=new URL('BP/entities/swordsman.json',stage);
const source=json(sourceUrl),variant=json(variantUrl),pin=json(new URL('source-pin.json',stage)),manifest=json(new URL('BP/manifest.json',stage));
const owner=json(new URL('CivilizationApocalypse_BP/manifest.json',root)),rp=json(new URL('CivilizationApocalypse_RP/manifest.json',root));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
function diffs(a,b,path=''){if(Object.is(a,b))return[];if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b))return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>diffs(a[k],b[k],path+'/'+k));if(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length)return a.flatMap((v,i)=>diffs(v,b[i],path+'/'+i));return[{path,before:a,after:b}];}
const melee='minecraft:behavior.melee_attack',S=source['minecraft:entity'],V=variant['minecraft:entity'];
test('C is pinned to current verifiedC0AB source and changes exactly one entity field, with byte-exact inverse',()=>{
    assert.equal(hash(sourceUrl),'C0AB66464976DF1EF0ADE7685C0C5800AB96D4EE0BA8A8AEDAED462098958D82');assert.equal(hash(sourceUrl),pin.sourceEntitySha256);assert.equal(hash(variantUrl),pin.variantEntitySha256);
    assert.deepEqual(diffs(source,variant),[{path:'/minecraft:entity/components/'+melee+'/reach_multiplier',before:1.5,after:2}]);
    const text=readFileSync(variantUrl,'utf8');assert.equal(text.split('"reach_multiplier": 2').length-1,1);assert.deepEqual(Buffer.from(text.replace('"reach_multiplier": 2','"reach_multiplier": 1.5')),readFileSync(sourceUrl));
});
test('complete-pathtrue, cooldown, priority, tracking and speed are preserved; reach is not paired with a second combat change',()=>{
    const m=V.components[melee];assert.equal(m.reach_multiplier,2);assert.equal(m.require_complete_path,true);assert.equal(m.cooldown_time,1);assert.equal(m.priority,3);assert.equal(m.track_target,true);assert.equal(m.speed_multiplier,1);
    assert.deepEqual({...m,reach_multiplier:1.5},S.components[melee]);
});
test('friendly/proactive filters, bounded home, actor class, health, movement and attack damage remain exact',()=>{
    assert.deepEqual(V.description,S.description);assert.equal(V.description.identifier,'civ_trial:swordsman');assert.equal(V.description.is_spawnable,false);
    for(const name of Object.keys(S.components).filter(k=>k!==melee))assert.deepEqual(V.components[name],S.components[name],name);
    assert.deepEqual(V.components['minecraft:health'],{value:30,max:30});assert.deepEqual(V.components['minecraft:attack'],{damage:4});assert.equal(V.components['minecraft:home'].restriction_radius,12);
    for(const name of ['minecraft:behavior.hurt_by_target','minecraft:behavior.nearest_attackable_target']){
        const all=V.components[name].entity_types[0].filters.all_of;assert.ok(all.some(f=>f.test==='is_family'&&f.subject==='other'&&f.value==='zombie'&&!f.operator));
        for(const friend of ['player','villager','irongolem','civ_guard'])assert.ok(all.some(f=>f.test==='is_family'&&f.subject==='other'&&f.operator==='not'&&f.value===friend));
    }
    assert.ok(V.components['minecraft:behavior.nearest_attackable_target'].entity_types[0].filters.all_of.some(f=>f.test==='has_tag'&&f.value==='civbesiege:v1'));
});
test('C is data-only with no functions/scripts/spawn rules/resources, unique identity and exact originalBP/RP dependencies',()=>{
    assert.deepEqual(readdirSync(new URL('BP/',stage)).sort(),['entities','manifest.json']);assert.deepEqual(readdirSync(new URL('BP/entities/',stage)),['swordsman.json']);assert.equal(manifest.format_version,2);assert.deepEqual(manifest.modules.map(m=>m.type),['data']);assert.deepEqual(manifest.header.version,[0,0,1]);assert.deepEqual(manifest.header.min_engine_version,owner.header.min_engine_version);
    assert.deepEqual(manifest.dependencies,[{uuid:owner.header.uuid,version:owner.header.version},{uuid:rp.header.uuid,version:rp.header.version}]);
    const B=json(new URL('dev/prototypes/swordsman/path-override/BP/manifest.json',root)),fixture=json(new URL('dev/staging/swordsman-combat-fixture/BP/manifest.json',root));
    const all=[manifest,owner,rp,B,fixture].flatMap(m=>[m.header.uuid,...m.modules.map(m=>m.uuid)]);assert.equal(new Set(all).size,all.length);for(const id of all)assert.match(id,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
});
test('reviewed primary1.26.0 schema makes2 a numeric nonnegative documented default, not native proof of actual reach',()=>{
    assert.equal(pin.schemaSource,'https://raw.githubusercontent.com/Mojang/bedrock-samples/v1.26.0.2/metadata/json_schemas/server/entity/1.26.0/MeleeAttackDefinition.json');assert.equal(pin.schemaGitBlob,'fa9d7bb2c4b2970d570dcb4ba0ee40fbd30e8a4d');assert.match(pin.schemaFileSha256,/^[A-F0-9]{64}$/);
    assert.equal(pin.reachSchema.default,2);assert.equal(pin.reachSchema.type,'number');assert.equal(pin.reachSchema.minimum,0);assert.equal(typeof V.components[melee].reach_multiplier,'number');assert.ok(V.components[melee].reach_multiplier>=pin.reachSchema.minimum);assert.equal(pin.completePathRemains,true);assert.match(pin.status,/STAGED ONLY/);
});
