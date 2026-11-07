import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {mc,resetWorld,makePlayer,store,pump,send,text,CIV_EVENT_IDS,flush} from "../../lib/civharness.mjs";
const root=resolve("."),stage=resolve("dev/staging/wall-leaf-repair");
const fixture=JSON.parse(readFileSync(resolve(stage,"closed-source-fixture.json"),"utf8"));
const evidence=JSON.parse(readFileSync(resolve(root,"dist/native-wall-leaf-preview-20261106.json"),"utf8"));
const url=path=>pathToFileURL(path).href;
function moduleSource(file,originalFile,replacements={}){return readFileSync(file,"utf8").replace(/from\s+(["'])([^"']+)\1/g,(all,q,spec)=>{
    if(replacements[spec])return `from ${q}${replacements[spec]}${q}`;
    return spec.startsWith(".")?`from ${q}${new URL(spec,url(originalFile)).href}${q}`:all;
});}
const data=source=>"data:text/javascript;base64,"+Buffer.from(source).toString("base64");
const civSource=moduleSource(resolve(stage,"proposed/CivilizationApocalypse_BP/scripts/commands/civ.js"),resolve(root,"CivilizationApocalypse_BP/scripts/commands/civ.js"),{
    "../civ/wallLeafTrim.js":url(resolve(stage,"leaf-trim.mjs")),"../civ/wallLeafRepair.js":url(resolve(stage,"wall-leaf-repair.mjs"))});
const commands=await import(data(civSource));
const starterSource=moduleSource(resolve(stage,"proposed/CivilizationApocalypse_BP/scripts/sim/starter.js"),resolve(root,"CivilizationApocalypse_BP/scripts/sim/starter.js"));
const stagedStarter=await import(data(starterSource));
const starterCommands=await import(data(moduleSource(resolve(root,"CivilizationApocalypse_BP/scripts/commands/starter.js"),resolve(root,"CivilizationApocalypse_BP/scripts/commands/starter.js"),{"../sim/starter.js":data(starterSource)})));
function setup(){resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(fixture.properties))mc.props.set(k,v);mc.subscribers.length=0;
    commands.registerCivCommands(store);starterCommands.registerStarterCommands(store);return makePlayer();}

test("actual staged command route is developer-gated and previews14 loaded targets without writes or chunk holds",async()=>{
    const player=setup();const before=new Map(mc.props),writes=mc.propWrites,blockWrites=mc.writes;
    send(CIV_EVENT_IDS.diag,"leafrepair district=4 policy=wall-leaves-trim-v1",player);await flush();assert.match(text(player),/development gate is off/);assert.deepEqual(mc.props,before);assert.equal(mc.propWrites,writes);
    mc.props.set("civ_devgate",true);player.messages.length=0;
    const leaves=new Map([...evidence.eligible,...evidence.refused].map(r=>[r.position.x+","+r.position.y+","+r.position.z,r]));
    player.dimension={id:"minecraft:overworld",getBlock(p){mc.reads++;const row=leaves.get(`${p.x},${p.y},${p.z}`);return{isValid:true,typeId:row?.actualId??"minecraft:air",permutation:{getAllStates:()=>row?{persistent_bit:row.persistent_bit}:{}},setPermutation(){assert.fail("preview reached native setter");}};}};
    const pre=new Map(mc.props);const create=mc.createCalls;send(CIV_EVENT_IDS.diag,"leafrepair district=4 policy=wall-leaves-trim-v1",player);await pump();
    assert.match(text(player),/Leaf-only wall batch: preview/);assert.match(text(player),/batch targets 14/);assert.match(text(player),/refused observed tree targets 3/);
    assert.deepEqual(mc.props,pre);assert.equal(mc.propWrites,writes);assert.equal(mc.writes,blockWrites);assert.equal(mc.createCalls,create);assert.equal(mc.maxWritesPerSlice,0);assert.ok(mc.maxReadsPerSlice<=64);
});

test("starter classification cannot wipe pending, complete or unknown maintenance receipts and real arm/verify refuse",async()=>{
    const receipts=["civ:wall_leaf_trim:v1:d4:12345678","civ:wall_leaf_trim:v1:d4:23456789","civ:wall_leaf_trim:future:unknown"];
    const classified=stagedStarter.classifyStarterKeys(receipts,{wipeKeys:receipts,wipeKeyPrefixes:["civ:"],keepKeyPrefixes:[]});assert.deepEqual(classified.keep,[...receipts].sort());assert.deepEqual(classified.wipe,[]);
    // Handlers already registered in the preceding test; retain their real event route.
    resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(fixture.properties))mc.props.set(k,v);
    for(const[k,value]of receipts.map((k,i)=>[k,i===0?'pending bytes':i===1?'completed bytes':'unknown version bytes']))mc.props.set(k,value);
    const player=makePlayer(),before=new Map(mc.props),writes=mc.propWrites;
    send("civ:starter_arm","confirm",player);await flush();assert.match(text(player),/wall-leaf maintenance receipts remain/);assert.deepEqual(mc.props,before);assert.equal(mc.propWrites,writes);
    player.messages.length=0;send("civ:starter_verify","",player);await flush();assert.match(text(player),/wall-leaf maintenance receipts remain/);assert.deepEqual(mc.props,before);assert.equal(mc.propWrites,writes);
});

test("actual repair route refuses orphan neighbor queues before reading blocks or writing state",async()=>{
    resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(fixture.properties))mc.props.set(k,v);mc.props.set("civ_devgate",true);
    const kingdom=JSON.parse(mc.props.get("civ:kingdom"));delete kingdom.districts.find(d=>d.id==="district-3").civ;mc.props.set("civ:kingdom",JSON.stringify(kingdom));
    const player=makePlayer(),before=new Map(mc.props),writes=mc.propWrites,reads=mc.reads;
    send(CIV_EVENT_IDS.diag,"leafrepair district=4 policy=wall-leaves-trim-v1 confirm",player);await pump();
    assert.match(text(player),/saved queue has no completed kingdom source/);assert.deepEqual(mc.props,before);assert.equal(mc.propWrites,writes);assert.equal(mc.reads,reads);assert.equal(mc.writes,0);
});
