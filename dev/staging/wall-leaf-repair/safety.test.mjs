import assert from "node:assert/strict";
import test from "node:test";
import "../../lib/civharness.mjs";
import {createWallLeafSourceGuard,wallLeafRepairSteps,WALL_LEAF_REPAIR_LIMITS} from "./wall-leaf-repair.mjs";
function state(){const properties=new Map([["civ:plan:meta","plan bytes"],["civ:jobs:d4:meta","queue bytes"]]);let kingdom={resources:{food:1},districts:[{id:"district-4",civ:{status:"complete",checksum:"12345678",dimension:"minecraft:overworld"},physical:{origin:{x:4,y:64,z:5}}}]};let cancelled=false,writes=0;
const world={getDynamicPropertyIds:()=>[...properties.keys()],getDynamicProperty:k=>properties.get(k),setDynamicProperty(){writes++;throw Error("unexpected write");}};
return{properties,world,get writes(){return writes;},get kingdom(){return kingdom;},set kingdom(k){kingdom=k;},cancel(){cancelled=true;},guard:()=>createWallLeafSourceGuard(world,()=>kingdom,()=>cancelled)};}
test("source guard permits unrelated resource/hour movement but refuses each geometry/source/original queue change",()=>{
    const f=state(),guard=f.guard();f.kingdom.resources.food++;f.kingdom.hour=2;assert.equal(guard.current(),true);
    for(const key of f.properties.keys()){const original=f.properties.get(key);f.properties.set(key,"different");assert.equal(guard.current(),false);f.properties.set(key,original);assert.equal(guard.current(),true);}
    f.kingdom.districts[0].physical.origin.x++;assert.equal(guard.current(),false);f.kingdom.districts[0].physical.origin.x--;assert.equal(guard.current(),true);
    f.kingdom.districts[0].civ.checksum="87654321";assert.equal(guard.current(),false);assert.equal(f.writes,0);
});
test("source guard refuses unknown protection, cancellation, key/byte budgets and source-key insertion without writes",()=>{
    const f=state(),guard=f.guard();f.properties.set("civ:jobs:d3:meta","new neighbor queue");assert.equal(guard.current(),false);f.properties.delete("civ:jobs:d3:meta");assert.equal(guard.current(),true);
    f.cancel();assert.equal(guard.current(),false);assert.throws(()=>guard.assert(),/cancellation/);assert.equal(f.writes,0);
    const ambiguous=state();ambiguous.kingdom.districts.push(ambiguous.kingdom.districts[0]);assert.throws(()=>ambiguous.guard(),/ambiguous/);
    const oversized=state();oversized.properties.set("civ:plan:a:0","x".repeat(WALL_LEAF_REPAIR_LIMITS.sourceBytes+1));assert.throws(()=>oversized.guard(),/byte budget/);
    const keys=state();for(let i=0;i<=WALL_LEAF_REPAIR_LIMITS.sourceKeys;i++)keys.properties.set("civ:plan:a:"+i,"x");assert.throws(()=>keys.guard(),/key budget/);
});
test("versioned policy and source identity fail before property/block access",()=>{
    const world=new Proxy({},{get(){throw Error("world must not be read");}}),ctx=new Proxy({},{get(){throw Error("context must not be read");}});
    assert.throws(()=>wallLeafRepairSteps({},ctx,world,{}).next(),/versioned/);
    assert.throws(()=>wallLeafRepairSteps({index:6},ctx,world,{policy:"wall-leaves-trim-v1"}).next(),/verified source/);
});
