import assert from "node:assert/strict";
import test from "node:test";
import {BLUEPRINTS2,expandBlueprint} from "../../../CivilizationApocalypse_BP/scripts/structures/blueprints2.js";
import {normalizeOps} from "../../../CivilizationApocalypse_BP/scripts/civ/opnorm.js";
import {makeProfile,planDeck} from "../../../CivilizationApocalypse_BP/scripts/civ/foundations.js";
import {farmFrontageDraft,spacedWaterDeck,proveDeckSupport,fixtureMigrationProposal,prepareFixtureMigration,fixtureMigrationStep,migrationActionReady,checksumInput} from "./farm-aesthetics.mjs";
const key=p=>`${p.x},${p.y},${p.z}`;
const copy=value=>JSON.parse(JSON.stringify(value));
const farms=["farm_allot_v2","farm_kitchen_v2","farm_veg_v2","farm_wheat_v2","farm_irrigated_v2"];
const lights=ops=>ops.filter(op=>/:(?:lantern|torch)$/.test(op.id));
const columnCount=deck=>new Set(deck.ops.filter(op=>op.kind==="pillar").map(op=>`${op.x},${op.z}`)).size;
function waterFixture(width=9,depth=width){const rect={x0:0,z0:0,x1:width-1,z1:depth-1},profile=makeProfile(-1,-1,width+2,depth+2,()=>({g:46,water:62}));return{rect,profile,limits:{baseY:63,pillarEvery:3,maxDepth:64}};}
function migrationFixture({blueprintId="farm_allot_v2",rotation=0,ownershipPatch}={}){
    const draft=farmFrontageDraft({blueprintId,rotation,x:100,z:-200,baseY:63},{farmLighting:"frontage-v1"});
    const final=new Map(draft.original.map(op=>[key(op),{status:"known",owner:"farm-original",op}]));
    const ownershipAt=p=>ownershipPatch?.(p,final.get(key(p)),draft)??final.get(key(p))??{status:"unplanned"};
    const proposal=fixtureMigrationProposal(draft,{checksum:"0123abcd",owner:"farm-original",ownershipAt});
    const blocks=new Map(draft.original.map(op=>[key(op),copy(op.id==="minecraft:lantern"?{...op,states:{hanging:false}}:op)]));
    const read=p=>blocks.get(key(p))??{id:"minecraft:air",states:{}};
    return{draft,proposal,blocks,read,final};
}
function apply(blocks,action){assert.ok(action);blocks.set(key(action.after),copy(action.after));}
function finish(fixture,journal=prepareFixtureMigration(fixture.proposal,fixture.read),startTick=0){
    const actions=[];for(let i=0;i<30;i++){
        const options={tick:startTick+i},step=fixtureMigrationStep(fixture.proposal,journal,fixture.read,options);assert.notEqual(step.kind,"held",step.reason);journal=step.journal;
        if(step.action){assert.equal(migrationActionReady(fixture.proposal,journal,step.action,fixture.read,options),true);apply(fixture.blocks,step.action);actions.push(step.action);}
        if(step.kind==="done")return{journal,actions};
    }assert.fail("bounded fixture migration did not finish");
}
test("absent farm-light version preserves original canonical op/checksum input for every crop blueprint and rotation",()=>{
    for(const blueprintId of farms)for(let rotation=0;rotation<4;rotation++){
        const legacy=farmFrontageDraft({blueprintId,rotation});const original=normalizeOps(expandBlueprint(BLUEPRINTS2[blueprintId],rotation).map(op=>({...op,kind:"building"})));
        assert.deepEqual(legacy.ops,original);assert.equal(checksumInput(legacy.ops),checksumInput(original));assert.equal(lights(legacy.ops).length,4);
    }
});
test("new farm-frontage version has one/two supported entrance fixtures and preserves all non-light cells",()=>{
    for(const blueprintId of farms)for(let rotation=0;rotation<4;rotation++){
        const draft=farmFrontageDraft({blueprintId,rotation,x:11,z:-31,baseY:63},{farmLighting:"frontage-v1"});
        assert.equal(lights(draft.ops).length,BLUEPRINTS2[blueprintId].size[0]<=13?1:2);assert.equal(draft.remove.length,4);
        assert.deepEqual(draft.ops.filter(o=>o.id!=="minecraft:lantern"),draft.original.filter(o=>o.id!=="minecraft:lantern"));
        for(const op of draft.add){assert.equal(op.states.hanging,false);assert.ok(draft.anchors.some(a=>a.x===op.x&&a.z===op.z&&a.y===op.y-1));assert.equal(Math.abs(op.x-draft.gate.x)+Math.abs(op.z-draft.gate.z),1);assert.notEqual(key(op),key({...draft.gate,y:op.y}));}
        assert.notEqual(checksumInput(draft.ops),checksumInput(draft.original));
    }
});
test("unsupported versions/blueprints and unsafe coordinates refuse rather than silently altering legacy plans",()=>{
    assert.throws(()=>farmFrontageDraft({blueprintId:"orchard_v2"},{farmLighting:"frontage-v1"}),/unreviewed/);
    assert.throws(()=>farmFrontageDraft({blueprintId:farms[0]},{farmLighting:"future"}),/unknown/);
    for(const patch of [{rotation:4},{x:Number.MAX_SAFE_INTEGER},{baseY:Infinity}])assert.throws(()=>farmFrontageDraft({blueprintId:farms[0],...patch},{farmLighting:"frontage-v1"}));
});
test("absent water-pile version returns the unchanged production deck and checksum input",()=>{
    const f=waterFixture(19),legacy=planDeck(f.profile,f.rect,f.limits),draft=spacedWaterDeck(f.profile,f.rect,f.limits);
    assert.deepEqual(draft,legacy);assert.equal(checksumInput(draft.ops),checksumInput(legacy.ops));
});
test("spaced perimeter reduces tall water-pile curtains while keeping every non-pillar op unchanged",()=>{
    for(const[width,oldColumns,newColumns]of [[9,36,16],[19,97,49]]){
        const f=waterFixture(width),legacy=planDeck(f.profile,f.rect,f.limits),draft=spacedWaterDeck(f.profile,f.rect,f.limits,{waterPiles:"spaced-v1"});
        assert.equal(columnCount(legacy),oldColumns);assert.equal(columnCount(draft),newColumns);assert.equal(draft.counts.pillar,newColumns*16);assert.equal(draft.counts.fill,0);assert.equal(draft.proof.maxReach,2);
        assert.deepEqual(draft.ops.filter(o=>o.kind!=="pillar"),legacy.ops.filter(o=>o.kind!=="pillar"));assert.ok(draft.ops.filter(o=>o.kind==="pillar").every(o=>o.id==="minecraft:oak_log"));
    }
});
test("all farm footprints retain bounded deck support, corners and production depth/hollow refusal",()=>{
    for(const blueprintId of farms){const[w,,d]=BLUEPRINTS2[blueprintId].size,f=waterFixture(w,d),deck=spacedWaterDeck(f.profile,f.rect,f.limits,{waterPiles:"spaced-v1"});assert.equal(deck.ok,true);assert.equal(proveDeckSupport(f.profile,f.rect,deck).ok,true);}
    const f=waterFixture(),deep=spacedWaterDeck(f.profile,f.rect,{...f.limits,maxDepth:4},{waterPiles:"spaced-v1"});assert.equal(deep.ok,false);
    const hollow=makeProfile(-1,-1,11,11,()=>({g:46,water:62,hollow:true}));assert.equal(spacedWaterDeck(hollow,f.rect,f.limits,{waterPiles:"spaced-v1"}).ok,false);
    assert.throws(()=>spacedWaterDeck(f.profile,f.rect,{...f.limits,pillarEvery:4},{waterPiles:"spaced-v1"}),/three-block/);
});
test("land-only supports stay unchanged and mixed shores retain every masonry support",()=>{
    const f=waterFixture(),land=makeProfile(-1,-1,11,11,()=>({g:46}));
    assert.deepEqual(spacedWaterDeck(land,f.rect,f.limits,{waterPiles:"spaced-v1"}).ops,planDeck(land,f.rect,f.limits).ops);
    const mixed=makeProfile(-1,-1,11,11,(x)=>x<=3?{g:46}:{g:46,water:62}),before=planDeck(mixed,f.rect,f.limits),after=spacedWaterDeck(mixed,f.rect,f.limits,{waterPiles:"spaced-v1"});
    assert.deepEqual(after.ops.filter(o=>o.kind==="pillar"&&o.x<=3),before.ops.filter(o=>o.kind==="pillar"&&o.x<=3));
});
test("independent proof rejects missing deck/column cells and changed pile materials",()=>{
    const f=waterFixture(),deck=spacedWaterDeck(f.profile,f.rect,f.limits,{waterPiles:"spaced-v1"});
    for(const edit of [ops=>ops.filter(o=>!(o.kind==="deck"&&o.x===4&&o.z===4)),ops=>ops.filter(o=>!(o.kind==="pillar"&&o.x===0&&o.z===0&&o.y===50)),ops=>ops.map(o=>o.kind==="pillar"&&o.x===0&&o.z===0?{...o,id:"minecraft:dirt"}:o)])assert.equal(proveDeckSupport(f.profile,f.rect,{...deck,ops:edit(deck.ops)}).ok,false);
});
test("migration requires verified all-stage final fixture and anchor ownership; later overwrites/unknown targets refuse",()=>{
    for(const mutation of ["source-owner","source-air","source-state","anchor-owner","target-unknown","target-owned","target-foreign-air"]){
        assert.throws(()=>migrationFixture({ownershipPatch:(p,known,draft)=>{
            if(mutation==="source-owner"&&key(p)===key(draft.remove[0]))return{...known,owner:"neighbor"};
            if(mutation==="source-air"&&key(p)===key(draft.remove[0]))return{...known,op:{...known.op,id:"minecraft:air"}};
            if(mutation==="source-state"&&key(p)===key(draft.remove[0]))return{...known,op:{...known.op,states:{hanging:true}}};
            if(mutation==="anchor-owner"&&key(p)===key(draft.anchors[0]))return{...known,owner:"later-building"};
            if(mutation==="target-unknown"&&key(p)===key(draft.add[0]))return{status:"unknown"};
            if(mutation==="target-owned"&&key(p)===key(draft.add[0]))return{status:"known",owner:"later-road",op:{...p,id:"minecraft:stone_bricks"}};
            if(mutation==="target-foreign-air"&&key(p)===key(draft.add[0]))return{status:"known",owner:"neighbor-interior",op:{...p,id:"minecraft:air"}};
        }}));
    }
});
test("preview/journal preparation does not write and never infers an existing new fixture is ours",()=>{
    const f=migrationFixture(),before=JSON.stringify([...f.blocks]),journal=prepareFixtureMigration(f.proposal,f.read);assert.equal(journal.phase,"placing");assert.equal(JSON.stringify([...f.blocks]),before);assert.ok(Object.isFrozen(f.proposal));
    f.blocks.set(key(f.draft.add[0]),copy(f.draft.add[0]));assert.throws(()=>prepareFixtureMigration(f.proposal,f.read),/journal/);
});
test("migration places and verifies all new supported lights before any old corner is removed",()=>{
    const f=migrationFixture({blueprintId:"farm_veg_v2"});const result=finish(f);
    assert.deepEqual(result.actions.map(a=>a.type),["place","place","remove","remove","remove","remove"]);
    assert.equal(lights([...f.blocks.values()]).length,2);assert.equal(result.journal.phase,"done");
    assert.equal(fixtureMigrationStep(f.proposal,result.journal,f.read,{tick:50}).kind,"done");
});
test("foreign original/target/anchor/gate changes and hanging-state mismatches preserve the whole fixture",()=>{
    for(const mutation of ["source","target","anchor","gate","source-state"]){const f=migrationFixture();const p=mutation==="source"||mutation==="source-state"?f.draft.remove[0]:mutation==="target"?f.draft.add[0]:mutation==="anchor"?f.draft.anchors[0]:f.draft.gate;
        f.blocks.set(key(p),mutation==="source-state"?{...p,states:{hanging:true}}:{...p,id:"minecraft:chest"});const before=JSON.stringify([...f.blocks]);assert.throws(()=>prepareFixtureMigration(f.proposal,f.read));assert.equal(JSON.stringify([...f.blocks]),before);
    }
});
test("late target/anchor changes and chunk unloads veto a previously proposed action",()=>{
    for(const change of ["target","anchor","unloaded"]){const f=migrationFixture(),journal=prepareFixtureMigration(f.proposal,f.read),step=fixtureMigrationStep(f.proposal,journal,f.read,{tick:0});assert.equal(step.kind,"action");
        const p=change==="target"?f.draft.add[0]:f.draft.anchors[0];if(change!=="unloaded")f.blocks.set(key(p),{...p,id:"minecraft:barrel"});
        const read=change==="unloaded"?()=>undefined:f.read;assert.equal(migrationActionReady(f.proposal,journal,step.action,read,{tick:0}),false);assert.equal(fixtureMigrationStep(f.proposal,journal,read,{tick:1}).kind,"held");
    }
});
test("a new light that drops or changes during stability wait cannot allow corner removal",()=>{
    const f=migrationFixture();let j=prepareFixtureMigration(f.proposal,f.read);let step=fixtureMigrationStep(f.proposal,j,f.read,{tick:0});apply(f.blocks,step.action);step=fixtureMigrationStep(f.proposal,j,f.read,{tick:1});j=step.journal;assert.equal(j.phase,"settling");
    f.blocks.set(key(f.draft.add[0]),{id:"minecraft:air"});assert.equal(fixtureMigrationStep(f.proposal,j,f.read,{tick:5}).kind,"held");assert.ok(f.draft.remove.every(p=>f.read(p).id==="minecraft:lantern"));
});
test("placement/removal interruption resumes only through the matching persisted journal",()=>{
    const f=migrationFixture();let journal=prepareFixtureMigration(f.proposal,f.read),step=fixtureMigrationStep(f.proposal,journal,f.read,{tick:0});apply(f.blocks,step.action);
    journal=JSON.parse(JSON.stringify(journal));const resumed=finish(f,journal,10);assert.equal(resumed.actions.filter(a=>a.type==="place").length,0);assert.equal(lights([...f.blocks.values()]).length,1);
    const different={...resumed.journal,planId:"wrong"};assert.equal(fixtureMigrationStep(f.proposal,different,f.read,{tick:30}).kind,"held");
});
test("partial removal resumes idempotently while any newly changed support prevents further deletion",()=>{
    const f=migrationFixture();let journal=prepareFixtureMigration(f.proposal,f.read),tick=0;
    for(;tick<10;tick++){const step=fixtureMigrationStep(f.proposal,journal,f.read,{tick});journal=step.journal;if(step.action){apply(f.blocks,step.action);if(step.action.type==="remove")break;}}
    assert.equal(f.draft.remove.filter(p=>f.read(p).id==="minecraft:air").length,1);const anchor=f.draft.anchors[0],original=f.blocks.get(key(anchor));f.blocks.set(key(anchor),{...anchor,id:"minecraft:chest"});
    assert.equal(fixtureMigrationStep(f.proposal,journal,f.read,{tick:tick+1}).kind,"held");assert.equal(f.draft.remove.filter(p=>f.read(p).id==="minecraft:air").length,1);
    f.blocks.set(key(anchor),original);const resumed=finish(f,copy(journal),tick+2);assert.equal(resumed.actions.filter(a=>a.type==="remove").length,3);
});
test("cancellation and tick epoch reset schedule no destructive action",()=>{
    const f=migrationFixture(),journal=prepareFixtureMigration(f.proposal,f.read);assert.equal(fixtureMigrationStep(f.proposal,journal,f.read,{tick:0,cancelled:true}).action,null);
    apply(f.blocks,fixtureMigrationStep(f.proposal,journal,f.read,{tick:0}).action);const wait=fixtureMigrationStep(f.proposal,journal,f.read,{tick:100});const reset=fixtureMigrationStep(f.proposal,wait.journal,f.read,{tick:0});assert.equal(reset.kind,"wait");assert.equal(reset.journal.seenTick,0);
    assert.equal(fixtureMigrationStep(f.proposal,reset.journal,f.read,{tick:1}).action,null);
});
test("tampered proposal and malformed journal cannot authorize writes",()=>{
    const f=migrationFixture(),journal=prepareFixtureMigration(f.proposal,f.read),tampered=copy(f.proposal);tampered.add[0].x++;
    assert.equal(fixtureMigrationStep(tampered,journal,f.read,{tick:0}).kind,"held");assert.equal(fixtureMigrationStep(f.proposal,{...journal,v:2},f.read,{tick:0}).kind,"held");
    assert.equal(fixtureMigrationStep(f.proposal,{...journal,seenTick:42},f.read,{tick:0}).kind,"held");assert.equal(fixtureMigrationStep(f.proposal,{...journal,extra:true},f.read,{tick:0}).kind,"held");
});
test("spaced prototype bounds reject unsafe/deep inputs before entering production planning loops",()=>{
    const f=waterFixture();assert.throws(()=>spacedWaterDeck(f.profile,{x0:Number.MAX_SAFE_INTEGER,z0:0,x1:Number.MAX_SAFE_INTEGER,z1:8},f.limits,{waterPiles:"spaced-v1"}),/world bounds/);
    for(const limits of [{...f.limits,maxDepth:Infinity},{...f.limits,maxDepth:65},{...f.limits,baseY:.5}])assert.throws(()=>spacedWaterDeck(f.profile,f.rect,limits,{waterPiles:"spaced-v1"}));
});
