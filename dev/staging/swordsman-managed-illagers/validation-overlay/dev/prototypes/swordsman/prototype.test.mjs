import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { prepareTrialSelection,createGroupTypeResolver,SWORDSMAN_TYPE } from "./group-type-resolver.mjs";
import { buildGroupTable } from "../../../CivilizationApocalypse_BP/scripts/population/groups.js";
import { createInitialKingdom } from "../../../CivilizationApocalypse_BP/scripts/kingdom/state.js";
import { POP_SYNC_DEFAULTS } from "../../../CivilizationApocalypse_BP/scripts/population/settings.js";
const root=dirname(fileURLToPath(import.meta.url)),json=p=>JSON.parse(readFileSync(join(root,p),"utf8"));
const entity=json("BP/entities/swordsman.json")["minecraft:entity"],c=entity.components;
const client=json("RP/entity/swordsman.entity.json")["minecraft:client_entity"].description;
const geometry=json("RP/models/entity/swordsman.geo.json")["minecraft:geometry"][0];
const groupTable=()=>buildGroupTable(createInitialKingdom(),POP_SYNC_DEFAULTS).groups;
const selection=()=>prepareTrialSelection({enabled:true,freshTrial:true,groupId:"district-1:sol:0",physicalGroupIds:[]},groupTable());
function matches(filter,{families=[],tags=[]}) {
    if(filter.all_of)return filter.all_of.every(f=>matches(f,{families,tags}));
    if(filter.any_of)return filter.any_of.some(f=>matches(f,{families,tags}));
    assert.equal(filter.subject,"other");
    const value=filter.test==="is_family"?families.includes(filter.value):filter.test==="has_tag"?tags.includes(filter.value):assert.fail(`Unmodelled filter ${filter.test}`);
    return filter.operator==="not"?!value:value;
}
test("BP/RP dependency and identifiers agree, assets are isolated data only",()=>{
    const bp=json("BP/manifest.json"),rp=json("RP/manifest.json");
    assert.equal(bp.format_version,2);assert.equal(rp.format_version,2);
    assert.deepEqual(bp.header.min_engine_version,[1,26,20]);assert.deepEqual(bp.dependencies,[{uuid:rp.header.uuid,version:rp.header.version}]);
    const uuids=[bp.header.uuid,rp.header.uuid,...bp.modules.map(m=>m.uuid),...rp.modules.map(m=>m.uuid)];assert.equal(new Set(uuids).size,4);
    assert.ok(uuids.every(id=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)));
    assert.deepEqual(bp.modules.map(m=>m.type),["data"]);assert.deepEqual(rp.modules.map(m=>m.type),["resources"]);
    assert.equal(entity.description.identifier,SWORDSMAN_TYPE);assert.equal(client.identifier,SWORDSMAN_TYPE);assert.equal(entity.description.is_spawnable,false);
    assert.deepEqual(readdirSync(join(root,"BP")).sort(),["entities","manifest.json"]);
});
test("target eligibility requires exact managed siege tag and rejects all friendly families",()=>{
    const target=c["minecraft:behavior.nearest_attackable_target"].entity_types[0].filters;
    assert.equal(matches(target,{families:["zombie","monster"],tags:["civbesiege:v1"]}),true);
    assert.equal(matches(target,{families:["zombie"],tags:["civbesiege:v1:district-1"]}),false,"per-district tag is not a wildcard match for common marker");
    assert.equal(matches(target,{families:["zombie"],tags:[]}),false);
    for(const friend of ["player","villager","irongolem","civ_guard"]){
        assert.equal(matches(target,{families:[friend],tags:["civbesiege:v1"]}),false);
        assert.equal(matches(target,{families:[friend,"zombie"],tags:["civbesiege:v1"]}),false,"friendly exclusion takes priority even on mixed-family entities");
    }
    assert.equal(matches(target,{families:["monster","skeleton"],tags:["civbesiege:v1"]}),false,"first slice is managed zombies only");
    assert.equal(c["minecraft:behavior.hurt_by_target"],undefined,"no unrestricted retaliation can override friendliness");
    const siege=readFileSync(join(root,"../../../CivilizationApocalypse_BP/scripts/integration/siegeMobs.js"),"utf8");
    assert.match(siege,/export const SIEGE_TAG = "civbesiege:v1"/);
});
test("cooldown, path and home settings bound intended combat and disable destructive navigation",()=>{
    const target=c["minecraft:behavior.nearest_attackable_target"],attack=c["minecraft:behavior.melee_attack"];
    assert.deepEqual(c["minecraft:home"],{restriction_radius:12,restriction_type:"all_movement"});
    assert.equal(c["minecraft:follow_range"],undefined,"within_radius must not be shadowed by a wider follow range");
    assert.equal(target.within_radius,12);assert.equal(target.entity_types[0].max_dist,10);assert.equal(target.persist_time,0);assert.equal(target.must_reach,true);assert.equal(target.must_see,true);
    assert.equal(attack.cooldown_time,1);assert.equal(attack.require_complete_path,true);assert.equal(c["minecraft:attack"].damage,4);
    assert.ok(c["minecraft:behavior.move_towards_home_restriction"].priority<attack.priority);
    assert.equal(c["minecraft:navigation.walk"].can_break_doors,false);assert.equal(c["minecraft:navigation.walk"].can_open_doors,false);
    assert.equal(c["minecraft:behavior.random_stroll"],undefined);assert.ok(c["minecraft:persistent"]);
});
test("client references resolve to custom geometry, texture, controller and every animation",()=>{
    assert.equal(client.geometry.default,geometry.description.identifier);
    const controllers=json("RP/render_controllers/swordsman.render_controllers.json").render_controllers;
    assert.ok(controllers[client.render_controllers[0]]);assert.equal(controllers[client.render_controllers[0]].geometry,"Geometry.default");
    const animations=json("RP/animations/swordsman.animation.json").animations;
    for(const id of Object.values(client.animations))assert.ok(animations[id]);
    for(const entry of client.scripts.animate){const key=typeof entry==="string"?entry:Object.keys(entry)[0];assert.ok(client.animations[key]);}
    const boneNames=new Set(geometry.bones.map(b=>b.name));
    for(const anim of Object.values(animations))for(const bone of Object.keys(anim.bones))assert.ok(boneNames.has(bone));
    assert.ok(readFileSync(join(root,"RP",client.textures.default+".png")).length>200);
});
test("original human geometry has complete bounded UVs and visible sword parented to hand",()=>{
    const {texture_width:w,texture_height:h}=geometry.description;
    const names=new Set(geometry.bones.map(b=>b.name));assert.equal(names.size,geometry.bones.length);
    for(const bone of geometry.bones){
        if(bone.parent)assert.ok(names.has(bone.parent));
        let cursor=bone;const seen=new Set();while(cursor){assert.equal(seen.has(cursor.name),false,"acyclic bone hierarchy");seen.add(cursor.name);cursor=geometry.bones.find(b=>b.name===cursor.parent);}
        for(const cube of bone.cubes){assert.ok(cube.size.every(n=>n>0&&Number.isFinite(n)));assert.deepEqual(Object.keys(cube.uv).sort(),["down","east","north","south","up","west"]);
            for(const face of Object.values(cube.uv)){assert.ok(face.uv[0]>=0&&face.uv[1]>=0&&face.uv[0]+face.uv_size[0]<=w&&face.uv[1]+face.uv_size[1]<=h);}
        }
    }
    const sword=geometry.bones.find(b=>b.name==="sword");assert.equal(sword.parent,"right_arm");assert.equal(sword.cubes.length,4);assert.ok(sword.cubes.some(cube=>cube.size[1]>=10));
    const blade=sword.cubes.find(cube=>cube.size[1]>=10);
    assert.ok(blade.origin[2]+blade.size[2]<-2,"rest-pose blade projects in front of the arm rather than being hidden inside it");
    assert.equal(entity.components["minecraft:equipment"],undefined,"modeled sword is not an inventory/equipment implementation");
});
test("original PNG decodes to expected opaque atlas and distinct face pixels",()=>{
    const png=readFileSync(join(root,"RP/textures/entity/civ_trial/swordsman.png"));assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    const idat=[];let w,h;for(let p=8;p<png.length;){const n=png.readUInt32BE(p),type=png.toString("ascii",p+4,p+8),data=png.subarray(p+8,p+8+n);if(type==="IHDR"){w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[9],6);}if(type==="IDAT")idat.push(data);p+=n+12;}
    assert.equal(w,64);assert.equal(h,32);const raw=inflateSync(Buffer.concat(idat));assert.equal(raw.length,32*257);
    for(let y=0;y<h;y++){assert.equal(raw[y*257],0);for(let x=0;x<w;x++)assert.equal(raw[y*257+1+x*4+3],255);}
    const pixel=(x,y)=>[...raw.subarray(y*257+1+x*4,y*257+1+x*4+3)];
    assert.notDeepEqual(pixel(2,11),pixel(3,11),"eye whites distinct from skin");assert.notDeepEqual(pixel(17,1),pixel(49,1),"tabard and sword have different color regions");
});
test("resolver is off by default and changes exactly one explicitly selected real group",()=>{
    assert.equal(prepareTrialSelection(),null);
    const table=groupTable(),base=createGroupTypeResolver(),trial=createGroupTypeResolver(selection());
    assert.ok(table.length>1);let changed=0;
    for(const group of table){const result=trial(group);if(result!==base(group)){changed++;assert.equal(group.id,"district-1:sol:0");assert.equal(result,SWORDSMAN_TYPE);}else assert.equal(result,group.kind==="civ"?"minecraft:villager_v2":"minecraft:iron_golem");}
    assert.equal(changed,1);assert.equal(Object.isFrozen(selection()),true);
});
test("activation refuses missing census, live conversion, absent/duplicate/noncanonical/civilian groups",()=>{
    const table=groupTable(),opts={enabled:true,freshTrial:true,groupId:"district-1:sol:0",physicalGroupIds:[]};
    assert.throws(()=>prepareTrialSelection({...opts,physicalGroupIds:undefined},table),/census/);
    assert.throws(()=>prepareTrialSelection({...opts,freshTrial:false},table),/Fresh trial/);
    assert.throws(()=>prepareTrialSelection({...opts,physicalGroupIds:[opts.groupId]},table),/live replacement/);
    assert.throws(()=>prepareTrialSelection(opts,[]),/exactly once/);assert.throws(()=>prepareTrialSelection(opts,[...table,table.find(g=>g.id===opts.groupId)]),/exactly once/);
    for(const groupId of ["district-1:civ:0","district-1:sol:00","district-1:sol:-1"]){assert.throws(()=>prepareTrialSelection({...opts,groupId},table),/canonical soldier/);}
});
test("rehydrated selection retains group identity and rejects unknown policy versions/types",()=>{
    const saved=JSON.parse(JSON.stringify(selection())),resolve=createGroupTypeResolver(saved),group=groupTable().find(g=>g.id===saved.groupId);
    assert.equal(resolve(group),SWORDSMAN_TYPE);assert.equal(group.id,"district-1:sol:0");assert.equal(group.headcount,5,"headcount remains derived; no casualty debit implied");
    assert.throws(()=>createGroupTypeResolver({...saved,version:2}),/unsupported/);assert.throws(()=>createGroupTypeResolver({...saved,typeId:"minecraft:zombie"}),/unsupported/);
    assert.throws(()=>resolve({...group,kind:"civ"}),/identity mismatch/);
    saved.groupId="district-2:sol:0";
    assert.equal(resolve(group),SWORDSMAN_TYPE,"a caller cannot mutate the resolver's selected ID after creation");
});
