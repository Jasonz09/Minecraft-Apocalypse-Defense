import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {core,controller} from "./variants.mjs";
import {readLeafTrimReceipt as originalParse} from "../../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js";
const raw=JSON.parse(readFileSync(new URL("./held1-receipt.json",import.meta.url),"utf8")),receipt=originalParse(raw),{key,POLICY}=core;
const air=()=>({isValid:true,typeId:"minecraft:air",states:{}});
// Receipt replay exercises actual immutable entry/digest/source identities and commit/scheduler contracts.
// Geometry compilation is independently covered centrally; this small replay supplies explicit27-cell contacts.
function fixture(){
 let journal=raw,tick=0,cancelled=false,sourceCurrent=true,reads=0,maxReads=0,saves=0,failSave=false;
 const blocks=new Map(),writes=[];
 const proposals=receipt.requested.map((p,i)=>({target:{...p,id:receipt.entries[i].desired.id},contacts:[]}));
 for(const [i,p]of receipt.requested.entries()){const e=receipt.entries[i];blocks.set(key(p),e.done?{isValid:true,typeId:e.desired.id,states:{}}:{isValid:true,typeId:e.before.typeId,states:structuredClone(e.before.states)});}
 for(const proposal of proposals)for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
  const point={x:proposal.target.x+x,y:proposal.target.y+y,z:proposal.target.z+z};
  proposal.contacts.push({point,historical:false,expected:proposals.filter(p=>key(p.target)===key(point)).map(p=>p.target.id)});
 }
 const plan={...receipt,v:1,proposals,refused:[],compileScannedOps:0},io={load:()=>journal,save(value){saves++;if(failSave)throw Error("save fault");journal=value;}};
 const ctx={read(p){reads++;return structuredClone(blocks.get(key(p))??air());},isProtected:()=>false,sourcesCurrent:()=>sourceCurrent,cancelled:()=>cancelled,write(op){writes.push(structuredClone(op));blocks.set(key(op),{isValid:true,typeId:op.id,states:{}});f.afterWrite?.(op);}};
 const f={plan,io,ctx,blocks,writes,afterWrite:null,get raw(){return journal;},set raw(v){journal=v;},get saves(){return saves;},get tick(){return tick;},set tick(v){tick=v;},set cancel(v){cancelled=v;},set current(v){sourceCurrent=v;},set failSave(v){failSave=v;},get maxReads(){return maxReads;},
 steps:()=>controller.commitLeafTrimBatchSteps(plan,ctx,io,{policy:POLICY,readTick:()=>tick}),
 run(g=f.steps(),advance=()=>{tick++;}){for(let i=0;i<70000;i++){reads=0;const n=g.next();maxReads=Math.max(maxReads,reads);assert.ok(reads<=56);if(n.done)return n.value;advance(f);}throw Error("test scheduler unbounded");}};
 return f;
}
function leaf(f,i=1){return f.blocks.get(key(receipt.requested[i]));}
test("actual CRC-extracted held1 receipt passes original and staged parser unchanged",()=>{
 assert.deepEqual(core.readLeafTrimReceipt(raw),receipt);assert.equal(receipt.planId,"c835b06e");assert.equal(receipt.entries.filter(e=>e.done).length,1);assert.equal(receipt.entries.length,14);assert.ok(receipt.entries.every(e=>e.before.states.update_bit===false));
});
test("temporary native-event simulation after every write completes only after exact snapshots return",()=>{
 const f=fixture();let resetAt=0;
 f.afterWrite=()=>{for(const b of f.blocks.values())if(b.typeId.endsWith("_leaves"))b.states.update_bit=true;resetAt=f.tick+80;};
 assert.equal(f.run(f.steps(),()=>{f.tick++;if(f.tick>=resetAt)for(const b of f.blocks.values())if(b.typeId.endsWith("_leaves"))b.states.update_bit=false;}),13);
 assert.equal(f.writes.length,13);assert.equal(core.readLeafTrimReceipt(f.raw).complete,true);assert.ok(f.maxReads<=56);assert.ok(f.tick>200);
 assert.equal(f.run(),0);assert.equal(f.writes.length,13);
});
test("round robin commits independent exact targets instead of blocking behind transient target",()=>{
 const f=fixture();leaf(f).states.update_bit=true;const g=f.steps();g.next();g.next();assert.equal(f.writes.length,0);g.next();assert.equal(f.writes.length,1);assert.notEqual(key(f.writes[0]),receipt.entries[1].target);
 leaf(f).states.update_bit=false;f.tick++;f.run(g);assert.equal(f.writes.length,13);
});
test("forever changed known boolean stops at bounded attempts and retains original identity",()=>{
 const f=fixture();leaf(f).states.update_bit=true;
 assert.throws(()=>f.run(),/deadline/);assert.equal(f.writes.length,12);const held=core.readLeafTrimReceipt(f.raw);assert.equal(held.complete,false);assert.deepEqual(held.entries.map(e=>e.before),receipt.entries.map(e=>e.before));assert.ok(f.tick<=6001);
});
test("stopped clock and tick deadline are bounded even when no target is ready",()=>{
 for(const mode of ["stopped","jump"]){const f=fixture();for(let i=1;i<14;i++)leaf(f,i).states.update_bit=true;
 assert.throws(()=>f.run(f.steps(),()=>{if(mode==="jump")f.tick+=6001;}),/deadline/);assert.equal(f.writes.length,0);assert.equal(f.raw,raw);}
});
test("type, persistent, unknown and extra state changes fail immediately without retry permission",()=>{
 for(const mutate of [b=>b.typeId="minecraft:oak_leaves",b=>b.states.persistent_bit=true,b=>b.states.update_bit=1,b=>delete b.states.update_bit,b=>b.states.extra=true,b=>b.states.old_leaf_type="oak"]){const f=fixture();mutate(leaf(f));assert.throws(()=>f.run());assert.equal(f.writes.length,0);assert.equal(f.raw,raw);}
});
test("foreign contacts, unreadability, source/cancel and changed completed wall refuse",()=>{
 for(const mode of ["foreign","unread","source","cancel","done"]){const f=fixture();if(mode==="foreign")f.blocks.set("-323,56,-454",{isValid:true,typeId:"minecraft:copper_ore",states:{}});if(mode==="unread")f.ctx.read=()=>undefined;if(mode==="source")f.current=false;if(mode==="cancel")f.cancel=true;if(mode==="done")f.blocks.set(key(receipt.requested[0]),air());assert.throws(()=>f.run());assert.equal(f.writes.length,0);assert.equal(f.raw,raw);}
});
test("cancellation during deferred wait preserves receipt; exact rejoin resumes13 safely",()=>{
 const f=fixture();leaf(f).states.update_bit=true;const g=f.steps();g.next();g.next();f.cancel=true;assert.throws(()=>g.next(),/cancellation/);assert.equal(f.raw,raw);f.cancel=false;leaf(f).states.update_bit=false;assert.equal(f.run(),13);
});
test("checkpoint failure after actual write resumes same receipt idempotently",()=>{
 const f=fixture();f.failSave=true;assert.throws(()=>f.run(),/save fault/);assert.equal(f.writes.length,1);assert.equal(f.raw,raw);f.failSave=false;assert.equal(f.run(),12);assert.equal(f.writes.length,13);assert.equal(core.readLeafTrimReceipt(f.raw).complete,true);
});
test("no clock cannot convert a transient hint into permission",()=>{
 const f=fixture();leaf(f).states.update_bit=true;assert.throws(()=>f.run(controller.commitLeafTrimBatchSteps(f.plan,f.ctx,f.io,{policy:POLICY})),/readable clock/);assert.equal(f.writes.length,0);assert.equal(f.raw,raw);
});

test("within-commit update-bit flips remain hard refusals at second proof and final read",()=>{
 for(const flipAt of [2,3]){const f=fixture(),originalRead=f.ctx.read,target=receipt.requested[1];let targetReads=0;
 f.ctx.read=p=>{if(key(p)===key(target)&&++targetReads===flipAt)leaf(f).states.update_bit=true;return originalRead(p);};
 assert.throws(()=>core.commitOneLeafTrim(f.plan,key(target),f.ctx,f.io,{policy:POLICY}),/changed/);assert.equal(f.writes.length,0);assert.equal(f.raw,raw);
 }
});
test("transient classification checks fresh source and journal before emitting retry hint",()=>{
 for(const mode of ["source","journal"]){const f=fixture(),originalRead=f.ctx.read,target=receipt.requested[1];leaf(f).states.update_bit=true;
 f.ctx.read=p=>{const b=originalRead(p);if(key(p)===key(target)){if(mode==="source")f.current=false;else f.raw=raw+" ";}return b;};
 assert.throws(()=>core.commitOneLeafTrim(f.plan,key(target),f.ctx,f.io,{policy:POLICY}),error=>!(error instanceof core.LeafUpdatePendingError));assert.equal(f.writes.length,0);
 }
});
test("retry rechecks newly introduced copper and neighboring protection",()=>{
 for(const mode of ["copper","protected"]){const f=fixture();leaf(f).states.update_bit=true;const g=f.steps();g.next();g.next();
 leaf(f).states.update_bit=false;if(mode==="copper")f.blocks.set("-323,56,-454",{isValid:true,typeId:"minecraft:copper_ore",states:{}});else f.ctx.isProtected=()=>true;
 assert.throws(()=>f.run(g));assert.ok(f.writes.every(w=>key(w)!==receipt.entries[1].target));assert.deepEqual(core.readLeafTrimReceipt(f.raw).entries.map(e=>e.before),receipt.entries.map(e=>e.before));assert.equal(core.readLeafTrimReceipt(f.raw).complete,false);
 if(mode==="protected")assert.equal(f.writes.length,0);
 }
});
