import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {mc,resetWorld,key,dimension,jobsModule} from "../../lib/civharness.mjs";
import {CIV_LIMITS} from "../../../CivilizationApocalypse_BP/scripts/civ/budget.js";
import {rememberRootRefusal,invalidateAfterActualWrite,LIMITS} from "./root-refusal-deps.mjs";
const url=new URL("../../../CivilizationApocalypse_BP/scripts/integration/civBuilder.js",import.meta.url);
// Reconstruct the historical untracked-root cache explicitly now that production
// uses a generation cache. The active helper is exercised by the core regression.
const historical=readFileSync(url,"utf8")
    .replace(/    const cachedRoot=s\.treeRootRefused\.get\([^\n]+\n    if\(cachedRoot!==undefined\)return \{ok:false,reason:cachedRoot\};\r?\n/,"")
    .replace(/    \/\*\* @type \{string\|undefined\} \*\/let rootDependency;\r?\n/,"")
    .replace(/                if\(base===undefined\)cacheRefusal=false;\r?\n                else rootDependency=key\(lowest.x,lowest.y-1,lowest.z\);\r?\n/,"")
    .replace(/if\(cacheRefusal&&rootDependency!==undefined\)\{\s*s\.treeRootRefused\.remember\([^\n]+\n        \} else if \(cacheRefusal\) \{/,"if (cacheRefusal) {")
    .replace('if(isBuiltPlanCell(s,op.x,op.y,op.z,op.id))s.treeRootRefused.invalidate(`${op.x},${op.y},${op.z}`);',"");
const source=historical.replace(/from\s+"(\.[^"]+)"/g,(_all,p)=>`from ${JSON.stringify(new URL(p,url).href)}`)
    .replace("siteOpsFor,","siteOpsFor as actualSiteOpsFor,")
    +'\nfunction siteOpsFor(r,s,i){return r.__testOps[s][i];}\nexport {createConstructionSession,indexOwnBlocks,clearTree,applyOp};\n';
const api=await import("data:text/javascript,"+encodeURIComponent(source));
const helperUrl=new URL("./root-refusal-deps.mjs",import.meta.url).href;
const fixedSource=`import {rememberRootRefusal,invalidateAfterActualWrite,forgetRootDependencies} from ${JSON.stringify(helperUrl)};\n`+source
    .replace("let cacheRefusal = true;","let cacheRefusal = true; let rootDependency;")
    .replace('reason = `a tree trunk does not stand on natural ground', 'rootDependency={x:lowest.x,y:lowest.y-1,z:lowest.z};\n                reason = `a tree trunk does not stand on natural ground')
    .replace("if (cacheRefusal) {","if (cacheRefusal && rootDependency) { rememberRootRefusal(s,rootDependency,component,seed,reason); } else if (cacheRefusal) {")
    .replace("target.setPermutation(permutationFor(s, op));","target.setPermutation(permutationFor(s, op));\n        invalidateAfterActualWrite(s,op);")
    .replace("s.treeRefused.clear();","s.treeRefused.clear(); forgetRootDependencies(s);");
const fixed=await import("data:text/javascript,"+encodeURIComponent(fixedSource));
function run(g){for(;;){const r=g.next();if(r.done)return r.value;}}
const seed={x:0,y:71,z:0},base={x:0,y:70,z:0,id:"minecraft:stone_bricks",kind:"wall"};
function plant(){resetWorld(1,{field:{base:70,relief:0,hills:0,forest:0}});
    mc.placed.set(key(0,70,0),"minecraft:air");
    for(let y=71;y<=74;y++)mc.placed.set(key(0,y,0),"minecraft:oak_log");
    mc.placed.set(key(0,75,0),"minecraft:oak_leaves");}
function session(protectedRects=[],engine=api){
    const q=jobsModule.createQueue({walls:[{total:1,hash:1}]},{planHash:"root-proof"});
    const s=engine.createConstructionSession({token:{cancelled:false},dimension,queue:q,
        record:{walls:[{}],__testOps:{walls:[[base]]},checksum:"root-proof"},plan:{},
        region:{x0:-40,z0:-40,x1:40,z1:40},protectedRects,say(){},onEnd(){},saveCiv(){},saveQueue(){return {ok:true};}});
    s.lastStage="walls";s.cur={element:0,cursor:0};s.heldRect={x0:-32,z0:-32,x1:31,z1:31};run(engine.indexOwnBlocks(s));return s;
}
test("actual-source same-session root refusal stays stale after actual exact planned foundation write; fresh full proof passes",()=>{
    plant();const s=session();const initial=run(api.clearTree(s,seed,true));
    assert.match(initial.reason,/does not stand on natural ground.*air at 0,70,0/);
    // Inspect-only deliberately never caches. Ordinary refusal does cache.
    assert.equal(run(api.clearTree(s,seed)).ok,false);assert.ok(s.treeRefused.size>0);
    assert.equal(run(api.applyOp(s,base)),"ok");assert.equal(mc.writes,1);
    const before=mc.propWrites;
    assert.match(run(api.clearTree(s,seed,true)).reason,/does not stand on natural ground.*air/);
    const fresh=run(api.clearTree(session(),seed,true));assert.equal(fresh.ok,true);assert.equal(fresh.logs,4);assert.equal(fresh.leaves,1);
    assert.equal(mc.writes,1);assert.equal(mc.propWrites,before);
    assert.ok(s.slice.maxReads<=CIV_LIMITS.maxReadsPerSlice);
});
test("isolated dependency fix invalidates only after actual base write, then reruns whole proof",()=>{
    plant();const s=session([],fixed);assert.equal(run(fixed.clearTree(s,seed)).ok,false);
    const cached=[...s.treeRefused];assert.ok(cached.length>0);
    assert.equal(invalidateAfterActualWrite(s,{x:20,y:70,z:20}),0);assert.deepEqual([...s.treeRefused],cached);
    assert.equal(run(fixed.applyOp(s,base)),"ok");assert.equal(s.treeRefused.size,0);
    mc.placed.set(key(1,73,0),"minecraft:copper_ore");
    assert.match(run(fixed.clearTree(s,seed,true)).reason,/copper_ore/,"base permission does not bypass new foreign contact");
    mc.placed.delete(key(1,73,0));assert.equal(run(fixed.clearTree(s,seed,true)).ok,true);
    assert.equal(mc.writes,1);assert.ok(s.slice.maxReads<=CIV_LIMITS.maxReadsPerSlice);
});
test("failed actual write cannot invalidate the cached root dependency",()=>{
    plant();const s=session([],fixed);assert.equal(run(fixed.clearTree(s,seed)).ok,false);
    const cached=[...s.treeRefused],originalRead=dimension.getBlock;
    dimension.getBlock=function(p){const block=originalRead.call(this,p);if(p.x===0&&p.y===70&&p.z===0)block.setPermutation=()=>{throw new Error("injected write failure");};return block;};
    try{assert.equal(run(fixed.applyOp(s,base)),"ok");assert.equal(s.counts.failed,1);assert.deepEqual([...s.treeRefused],cached);assert.equal(mc.writes,0);}
    finally{dimension.getBlock=originalRead;}
});
test("dependency metadata is capped; unrelated and newer refusals are preserved",()=>{
    const s={treeRefused:new Map()};
    for(let x=0;x<LIMITS.bases;x++)assert.equal(rememberRootRefusal(s,{x,y:0,z:0},[{x,y:1,z:0}],{x,y:1,z:0},`base${x}`),true);
    assert.equal(rememberRootRefusal(s,{x:100,y:0,z:0},[{x:100,y:1,z:0}],{x:100,y:1,z:0},"overflow"),false);
    s.treeRefused.set("0,1,0","new protected verdict");assert.equal(invalidateAfterActualWrite(s,{x:0,y:0,z:0}),0);
    assert.equal(s.treeRefused.get("0,1,0"),"new protected verdict");assert.equal(s.treeRefused.get("1,1,0"),"base1");
    assert.equal(rememberRootRefusal(s,{x:200,y:0,z:0},Array.from({length:LIMITS.cells+1},(_,x)=>({x,y:2,z:0})),seed,"too large"),false);
});
test("fresh full proof preserves ore, foreign contact, protected and unknown hall columns",()=>{
    for(const engine of [api,fixed])for(const [name,setup,areas,pattern] of [
        ["ore",()=>mc.placed.set(key(1,73,0),"minecraft:copper_ore"),[],/copper_ore/],
        ["foreign",()=>mc.placed.set(key(1,73,0),"minecraft:chest"),[],/chest/],
        ["protected",()=>{},[{x0:-1,z0:-1,x1:1,z1:1}],/protected clearance/],
        ["unknown hall",()=>{},[{x0:0,z0:0,x1:0,z1:0,grow:3}],/protected clearance/],
    ]){plant();mc.placed.set(key(0,70,0),base.id);setup();const s=session(areas,engine);
        const result=run(engine.clearTree(s,seed,true));assert.equal(result.ok,false,name);assert.match(result.reason,pattern,name);
        assert.equal(mc.writes,0,name);assert.ok(s.slice.maxReads<=CIV_LIMITS.maxReadsPerSlice,name);
    }
});
