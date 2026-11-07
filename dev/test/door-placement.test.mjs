import assert from 'node:assert/strict';
import test from 'node:test';
import {load} from '../lib/civharness.mjs';
const {inspectDoorPair,placeDoorPair}=await load('integration/doorPlacement.js');

const lower={x:10,y:66,z:20,id:'minecraft:birch_door',states:{'minecraft:cardinal_direction':'south',upper_block_bit:false,open_bit:false,door_hinge_bit:false}};
function fixture() {
    const blocks=new Map([[65,{typeId:'minecraft:cobblestone'}]]),commands=[];
    const dimension={getBlock({y}) { return blocks.get(y) ?? {typeId:'minecraft:air'}; },runCommand(command) {
        commands.push(command);
        blocks.set(66,{typeId:lower.id,isSolid:false,permutation:{getState:n=>n==='open_bit' ? true : undefined}});
        blocks.set(67,{typeId:lower.id,isSolid:false});
        return {successCount:1};
    }};
    return {blocks,commands,dimension};
}
test('paired doors: native lower-half placement retains both halves; repeated repair preserves an open door',()=>{
    const f=fixture();
    assert.equal(inspectDoorPair(f.dimension,lower).status,'missing');
    assert.equal(f.commands.length,0);
    const result=placeDoorPair(f.dimension,lower);
    assert.equal(result.status,'placed');
    assert.equal(result.writes,2);
    assert.equal(result.reads,7);
    assert.match(f.commands[0],/^setblock 10 66 20 minecraft:birch_door .* keep$/);
    assert.equal(placeDoorPair(f.dimension,lower).status,'present');
    assert.equal(f.commands.length,1,'complete doors are never reset');
});
test('paired doors: stable API floors need no invented isSolid property; partial and unknown support refuses',()=>{
    for (const typeId of ['minecraft:polished_andesite','minecraft:birch_planks','minecraft:stone_bricks','minecraft:cobblestone']) {
        const f=fixture();f.blocks.set(65,{typeId});
        assert.equal(placeDoorPair(f.dimension,lower).status,'placed',typeId);
    }
    for (const typeId of ['minecraft:air','minecraft:water','minecraft:oak_leaves','minecraft:stone_slab','minecraft:oak_fence','custom:unknown']) {
        const f=fixture();f.blocks.set(65,{typeId,isSolid:true});
        assert.equal(placeDoorPair(f.dimension,lower).status,'blocked',typeId);
        assert.equal(f.commands.length,0);
    }
});
test('paired doors: foreign blocks, missing footing and unread chunks refuse before any write',()=>{
    for (const y of [66,67]) {
        const f=fixture(); f.blocks.set(y,{typeId:'minecraft:diamond_block',isSolid:true});
        assert.equal(placeDoorPair(f.dimension,lower).status,'blocked');
        assert.equal(f.commands.length,0);
    }
    const f=fixture();f.blocks.clear();
    assert.equal(placeDoorPair(f.dimension,lower).status,'blocked');
    assert.equal(f.commands.length,0);
    f.dimension.getBlock=()=>undefined;
    assert.equal(placeDoorPair(f.dimension,lower).status,'unloaded');
    assert.equal(f.commands.length,0);
});
test('paired doors: interrupted pairs keep surviving door settings, failed engine writes do not claim success',()=>{
    const f=fixture();
    f.blocks.set(66,{typeId:lower.id,isSolid:false,permutation:{getState:n=>n==='open_bit' ? true : undefined}});
    assert.equal(placeDoorPair(f.dimension,lower).status,'placed');
    assert.match(f.commands[0],/"open_bit"=true/);
    assert.match(f.commands[0],/ replace$/);
    const g=fixture();g.dimension.runCommand=()=>({successCount:0});
    assert.equal(placeDoorPair(g.dimension,lower).status,'failed');
    const h=fixture();h.dimension.runCommand=()=>({successCount:1});
    assert.equal(placeDoorPair(h.dimension,lower).status,'failed','successCount alone does not prove retained blocks');
});
