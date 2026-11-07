import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {mc,resetWorld,key,dimension,jobsModule} from "../lib/civharness.mjs";
import {CIV_LIMITS} from "../../CivilizationApocalypse_BP/scripts/civ/budget.js";
import {createTreeRootRefusalCache,TREE_ROOT_CACHE_LIMITS as LIMITS} from "../../CivilizationApocalypse_BP/scripts/civ/treeRootRefusalCache.js";
const url=new URL("../../CivilizationApocalypse_BP/scripts/integration/civBuilder.js",import.meta.url);
const source=readFileSync(url,"utf8").replace(/from\s+"(\.[^"]+)"/g,(_all,p)=>`from ${JSON.stringify(new URL(p,url).href)}`)
    .replace("siteOpsFor,","siteOpsFor as actualSiteOpsFor,")
    +'\nfunction siteOpsFor(r,s,i){return r.__testOps[s][i];}\nexport {createConstructionSession,indexOwnBlocks,clearTree,applyOp};\n';
const api=await import("data:text/javascript,"+encodeURIComponent(source));
const control=await import("data:text/javascript,"+encodeURIComponent(source.replace('if(isBuiltPlanCell(s,op.x,op.y,op.z,op.id))s.treeRootRefused.invalidate(`${op.x},${op.y},${op.z}`);',"")));
function run(g){for(;;){const r=g.next();if(r.done)return r.value;}}
const seed={x:0,y:71,z:0},base={x:0,y:70,z:0,id:"minecraft:stone_bricks",kind:"wall"};
function plant(){resetWorld(1,{field:{base:70,relief:0,hills:0,forest:0}});mc.placed.set(key(0,70,0),"minecraft:air");
    for(let y=71;y<=74;y++)mc.placed.set(key(0,y,0),"minecraft:oak_log");mc.placed.set(key(0,75,0),"minecraft:oak_leaves");}
function session({engine=api,areas=[],streams={walls:[base]},lastStage="walls"}={}){
    const specs={},record={__testOps:{},checksum:"root-cache-test"};
    for(const [stage,ops]of Object.entries(streams)){specs[stage]=[{total:ops.length,hash:1}];record[stage]=[{}];record.__testOps[stage]=[ops];}
    const s=engine.createConstructionSession({token:{cancelled:false},dimension,queue:jobsModule.createQueue(specs,{planHash:record.checksum}),record,plan:{},
        region:{x0:-40,z0:-40,x1:40,z1:40},protectedRects:areas,say(){},onEnd(){},saveCiv(){},saveQueue(){return{ok:true};}});
    s.lastStage=lastStage;s.cur={element:0,cursor:0};s.heldRect={x0:-32,z0:-32,x1:31,z1:31};run(engine.indexOwnBlocks(s));return s;
}
function refuse(s,engine=api){assert.match(run(engine.clearTree(s,seed)).reason,/does not stand on natural ground/);assert.ok(s.treeRootRefused.status().entries>0);assert.equal(s.treeRefused.size,0);}
test("negative control reproduces stale AIR root; production actual owned-base write reruns complete natural proof",()=>{
    for(const engine of [control,api]){plant();const s=session({engine});refuse(s,engine);assert.equal(run(engine.applyOp(s,base)),"ok");assert.equal(mc.writes,1);
        const result=run(engine.clearTree(s,seed,true)),fresh=run(engine.clearTree(session({engine}),seed,true));
        assert.equal(fresh.ok,true);assert.equal(fresh.logs,4);assert.equal(fresh.leaves,1);
        if(engine===control)assert.match(result.reason,/air at 0,70,0/);else assert.deepEqual(result,fresh);
        assert.equal(mc.writes,1);assert.ok(s.slice.maxReads<=CIV_LIMITS.maxReadsPerSlice);
    }
});
test("invalidated roots fully recheck new copper, chest, persistent leaves, protected and unknown-hall columns",()=>{
    for(const [id,change,pattern]of [["copper",()=>mc.placed.set(key(1,73,0),"minecraft:copper_ore"),/copper_ore/],
        ["chest",()=>mc.placed.set(key(1,73,0),"minecraft:chest"),/chest/],
        ["player leaf",()=>{mc.persistent=()=>true;},/persistent leaves/],
        ["protected",s=>{s.protectedAt=()=>true;},/protected clearance/],
        ["unknown hall",s=>{s.protectedAt=(x,z)=>x===0&&z===0;},/protected clearance/]]){
        plant();const s=session();refuse(s);run(api.applyOp(s,base));change(s);const result=run(api.clearTree(s,seed,true));
        assert.equal(result.ok,false,id);assert.match(result.reason,pattern,id);assert.equal(mc.writes,1,id);
        assert.ok(s.slice.maxReads<=CIV_LIMITS.maxReadsPerSlice,id);
    }
});
test("unrelated, failed, nonfinal and future-stage writes do not invalidate root negative evidence",()=>{
    for(const mode of ["unrelated","failed","nonfinal","future-stage"]){plant();
        const streams={walls:[base,...(mode==="unrelated"?[{...base,x:10}]:[])]};
        if(mode==="nonfinal"||mode==="future-stage")streams.dressing=[{...base,id:mode==="nonfinal"?"minecraft:cobblestone":base.id,kind:"dress"}];
        const s=session({streams});refuse(s);const before=s.treeRootRefused.status(),read=dimension.getBlock;
        if(mode==="failed")dimension.getBlock=function(p){const b=read.call(this,p);if(p.x===0&&p.y===70&&p.z===0)b.setPermutation=()=>{throw Error("write failed");};return b;};
        try{run(api.applyOp(s,mode==="unrelated"?{...base,x:10}:base));}finally{dimension.getBlock=read;}
        assert.match(s.treeRootRefused.get(key(seed.x,seed.y,seed.z)),/does not stand on natural ground/,mode);
        assert.deepEqual(s.treeRootRefused.status(),before,mode);
    }
});
test("silent setter no-op merely permits fresh proof, which refuses AIR again without erasing anything",()=>{
    plant();const s=session();refuse(s);const read=dimension.getBlock;
    dimension.getBlock=function(p){const b=read.call(this,p);if(p.x===0&&p.y===70&&p.z===0)b.setPermutation=()=>{};return b;};
    try{run(api.applyOp(s,base));}finally{dimension.getBlock=read;}
    assert.equal(s.treeRootRefused.get(key(seed.x,seed.y,seed.z)),undefined);
    assert.match(run(api.clearTree(s,seed)).reason,/does not stand on natural ground.*air/);assert.equal(mc.writes,0);
});
test("unreadable base is never cached; a later loaded natural base is fully reconsidered",()=>{
    plant();mc.placed.set(key(0,70,0),"minecraft:grass_block");const s=session();mc.unloaded=p=>p.x===0&&p.y===70&&p.z===0;
    assert.match(run(api.clearTree(s,seed)).reason,/not loaded|unloaded/);assert.equal(s.treeRefused.size,0);assert.equal(s.treeRootRefused.status().entries,0);
    mc.unloaded=()=>false;assert.equal(run(api.clearTree(s,seed,true)).ok,true);assert.equal(mc.writes,0);
});
test("native paired-door hook invalidates both verified placed halves, never present or failed pairs",()=>{
    const lower={x:10,y:71,z:0,id:"minecraft:oak_door",kind:"wall",states:{upper_block_bit:false,"minecraft:cardinal_direction":"north"}},upper={...lower,y:72,states:{...lower.states,upper_block_bit:true}};
    for(const mode of ["placed","present","failed"]){plant();mc.placed.set(key(10,70,0),"minecraft:grass_block");const s=session({streams:{walls:[lower,upper]}});
        s.treeRootRefused.remember(key(10,71,0),["lower-root"],"lower");s.treeRootRefused.remember(key(10,72,0),["upper-root"],"upper");
        if(mode==="present")for(const p of [lower,upper]){mc.placed.set(key(p.x,p.y,p.z),p.id);mc.blockStates.set(key(p.x,p.y,p.z),{id:p.id,states:p.states});}
        const command=dimension.runCommand;if(mode==="failed")dimension.runCommand=()=>({successCount:0});
        try{assert.equal(run(api.applyOp(s,lower)),"ok");}finally{dimension.runCommand=command;}
        assert.equal(s.treeRootRefused.get("lower-root"),mode==="placed"?undefined:"lower",mode+JSON.stringify(s.counts));
        assert.equal(s.treeRootRefused.get("upper-root"),mode==="placed"?undefined:"upper",mode);
    }
});
test("cache caps and generation overflow fail uncached; invalidation has constant work with no key iteration",()=>{
    const cache=createTreeRootRefusalCache({generationLimit:2});assert.equal(cache.remember("base",["a","b"],"root"),true);
    cache.invalidate("base");assert.equal(cache.get("a"),undefined);assert.equal(cache.remember("base",["a"],"new root"),true);
    cache.invalidate("base");cache.invalidate("base");assert.equal(cache.remember("base",["c"],"overflow"),false);assert.equal(cache.get("a"),undefined);assert.equal(cache.get("b"),undefined);
    const bounded=createTreeRootRefusalCache();for(let n=0;n<LIMITS.bases;n++)assert.equal(bounded.remember(`base${n}`,[`cell${n}`],"root"),true);
    assert.equal(bounded.remember("too many",["x"],"root"),false);
    const full=createTreeRootRefusalCache();let count=0;for(let group=0;group<3;group++){const n=Math.min(LIMITS.componentKeys,LIMITS.entries-count);assert.equal(full.remember(`base${group}`,Array.from({length:n},()=>`cell${count++}`),"root"),true);}
    assert.equal(full.status().entries,LIMITS.entries);assert.equal(full.remember("extra",["new"],"root"),false);
    const oldIterator=Set.prototype[Symbol.iterator],oldMapIterator=Map.prototype[Symbol.iterator];
    Set.prototype[Symbol.iterator]=Map.prototype[Symbol.iterator]=function(){throw Error("write invalidation must not enumerate entries");};
    try{assert.equal(full.invalidate("base0"),true);assert.equal(full.invalidate("unrelated"),false);}finally{Set.prototype[Symbol.iterator]=oldIterator;Map.prototype[Symbol.iterator]=oldMapIterator;}
    assert.equal(full.get("cell0"),undefined);assert.equal(full.get("cell8191"),"root");
});
