import assert from "node:assert/strict";
import test from "node:test";
import {SITE_STAGES} from "../../../CivilizationApocalypse_BP/scripts/civ/districtplan.js";
import {POLICY,key,compileLeafTrim,prepareLeafTrim,commitOneLeafTrim} from "../../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js";
const pos=(x,y=70,z=0)=>({x,y,z});
const cell=(typeId,states={})=>({isValid:true,typeId,states});
const op=(p,id="minecraft:stone_bricks",kind="wall")=>({...p,id,kind});
const leaf=()=>cell("minecraft:oak_leaves",{persistent_bit:false});
function fixture(count=1,change=()=>{}) {
    const candidates=Array.from({length:count},(_,i)=>pos(i*5));
    const record={districtIndex:4,checksum:"35635162",...Object.fromEntries(SITE_STAGES.map(stage=>[stage,[]]))};
    record.walls=candidates.map((p,i)=>({id:`wall-${i}`,ops:[op(p),op({...p,y:p.y-1},"minecraft:cobblestone")]}));
    const source={record,civ:{status:"complete",checksum:record.checksum,dimension:"minecraft:overworld"},masterHash:"9e5e307e"};
    const input={index:4,checksum:record.checksum,masterHash:source.masterHash,dimension:source.civ.dimension,candidates,sources:[source]};
    const blocks=new Map(candidates.flatMap(p=>[[key(p),leaf()],[key({...p,y:p.y-1}),cell("minecraft:cobblestone")]]));
    const protectedColumns=new Set(),writes=[];
    let raw,reads=0,saves=0;
    const io={load:()=>raw,save(value){raw=value;saves++;}};
    const ctx={sourcesCurrent:()=>true,read(p){reads++;return structuredClone(blocks.get(key(p))??cell("minecraft:air"));},
        isProtected:(x,z)=>protectedColumns.has(`${x},${z}`),write(value){writes.push(structuredClone(value));blocks.set(key(value),cell(value.id,value.states));}};
    const f={input,record,source,candidates,blocks,protectedColumns,writes,io,ctx,
        get raw(){return raw;},set raw(value){raw=value;},get reads(){return reads;},get saves(){return saves;}};
    change(f);
    f.compile=()=>compileLeafTrim(input,{opsFor:(r,stage,index)=>r[stage][index].ops});
    f.plan=f.compile();f.prepare=()=>prepareLeafTrim(f.plan,ctx,io,{policy:POLICY});f.commit=(index=0)=>{if(f.raw===undefined)f.prepare();return commitOneLeafTrim(f.plan,key(candidates[index]),ctx,io,{policy:POLICY});};
    return f;
}

test("synthetic adjacent update-bit change after first masonry write reproduces exact native hold without granting second write",()=>{
 const f=fixture(2);for(const p of f.candidates)f.blocks.get(key(p)).states.update_bit=false;
 f.prepare();assert.equal(f.commit(0).changed,1);
 f.blocks.get(key(f.candidates[1])).states.update_bit=true;
 const receipt=f.raw;assert.throws(()=>f.commit(1),/admitted leaf identity\/states changed; preserve target and receipt/);
 assert.equal(f.writes.length,1);assert.equal(f.raw,receipt);assert.equal(JSON.parse(f.raw).complete,false);
 assert.equal(JSON.parse(f.raw).entries[0].done,true);assert.equal(JSON.parse(f.raw).entries[1].done,false);
 // Rejoining/recompiling cannot silently readmit changed states under v1.
 f.plan=f.compile();assert.throws(()=>f.commit(1),/admitted leaf identity\/states changed/);assert.equal(f.writes.length,1);
});
test("same exact hold also follows other eligible leaf identity changes; message alone cannot identify update_bit",()=>{
 for(const change of [b=>b.typeId="minecraft:birch_leaves",b=>b.states.other_state=true,b=>delete b.states.update_bit]){
 const f=fixture();f.blocks.get(key(f.candidates[0])).states.update_bit=false;f.prepare();change(f.blocks.get(key(f.candidates[0])));
 const receipt=f.raw;assert.throws(()=>f.commit(),/admitted leaf identity\/states changed/);assert.equal(f.writes.length,0);assert.equal(f.raw,receipt);
 }
});
test("persistent leaves and unsafe contacts refuse before any eligibility-relaxation opportunity",()=>{
 for(const change of [f=>f.blocks.get(key(f.candidates[0])).states.persistent_bit=true,f=>f.blocks.set(key(pos(1)),cell("minecraft:copper_ore")),f=>f.protectedColumns.add("0,0")]){
 const f=fixture();f.prepare();change(f);const receipt=f.raw;assert.throws(()=>f.commit());assert.equal(f.writes.length,0);assert.equal(f.raw,receipt);
 }
});
