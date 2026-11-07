import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {mc,resetWorld,dimension,jobsModule} from "../../lib/civharness.mjs";

// Run the actual private window selector/router/queue, replacing only engine
// op execution and operation expansion with small deterministic fixtures.
const url=new URL("../../../CivilizationApocalypse_BP/scripts/integration/civBuilder.js",import.meta.url);
const original=readFileSync(url,"utf8");
async function instrument(fixed=false) {
    let source=original.replace(/from\s+"(\.[^"]+)"/g,(_all,p)=>`from ${JSON.stringify(new URL(p,url).href)}`)
        .replace("siteOpsFor,","siteOpsFor as actualSiteOpsFor,")
        .replace("function* applyOp(s, op)","function* actualApplyOp(s, op)");
    if(fixed)source=source.replace('return {status:"need-hold",box:s.treeHold,apron:17};',
        's.lastHoldBox = undefined;\n                    return {status:"need-hold",box:s.treeHold,apron:17};');
    source+='\nfunction siteOpsFor(record,stage,index) { return record.__testOps[stage][index]; }\nfunction* applyOp(s,op) { return s.__apply(op); }\nexport {createConstructionSession,constructionJob,holdRectFor,contains};\n';
    return import("data:text/javascript,"+encodeURIComponent(source));
}
const legacy=await instrument(),fixed=await instrument(true);
const point=p=>({x0:p.x,z0:p.z,x1:p.x,z1:p.z});
const tree={x:-304,y:63,z:-455,id:"minecraft:air",kind:"clear"};
const target={x:-303,y:63,z:-492,id:"minecraft:air",kind:"clear"};
const ops=[tree,target,{...target,x:-392},{...target,z:-455}];
const A={x0:-392,z0:-492,x1:-303,z1:-455};
const isTarget=r=>r.op.x===target.x&&r.op.y===target.y&&r.op.z===target.z;
function fixture(api) {
    resetWorld(1);
    const queue=jobsModule.createQueue({clear:[{total:ops.length,hash:1}]},{planHash:"hold-repro"});
    jobsModule.resume(queue);
    const s=api.createConstructionSession({token:{cancelled:false},dimension,queue,
        record:{__testOps:{clear:[ops]}},plan:{},region:{x0:-500,z0:-600,x1:0,z1:0},protectedRects:[],
        say(){},onEnd(){},saveCiv(){},saveQueue(){return {ok:true};}});
    s.holdSide=128;
    let first=true;const reads=[];
    s.__apply=op=>{if(first){first=false;return "tree-hold";}
        reads.push({op,covered:api.contains(s.heldRect,point(op),0)});return "ok";};
    const request=()=>{const g=api.constructionJob(s);for(let n=0;n<50;n++){const r=g.next();if(r.done)return r.value;}throw new Error("router did not settle");};
    const grant=r=>{s.heldRect=api.holdRectFor(r.box,128,r.apron??9);s.holdState={status:"held",held:true};};
    return {s,reads,request,grant};
}
test("frozen router reproduces normal A -> tree B -> normal A stale hold and outside read",()=>{
    const f=fixture(legacy);
    const normal=f.request();assert.deepEqual(normal.box,A);f.grant(normal);
    assert.equal(legacy.contains(f.s.heldRect,point(tree),17),false,"tree requires wider apron at X edge");
    const borrowed=f.request();assert.equal(borrowed.apron,17);f.grant(borrowed);
    assert.deepEqual(f.s.heldRect,{x0:-336,z0:-480,x1:-209,z1:-353},"matches native held rectangle exactly");
    assert.equal(legacy.contains(f.s.heldRect,point(target),0),false);
    assert.equal(f.request().status,"complete");
    assert.equal(f.reads.find(isTarget).covered,false,"actual production router reaches target outside granted lease");
    assert.equal(mc.writes,0);
});
test("isolated one-line tree-borrow invalidation repins A before target reads with same 64-chunk rectangles",()=>{
    const f=fixture(fixed);const normal=f.request();f.grant(normal);
    const borrowed=f.request();f.grant(borrowed);
    const repin=f.request();assert.equal(repin.status,"need-hold");assert.deepEqual(repin.box,A);
    assert.equal(f.reads.some(isTarget),false,"no target read before original normal area is repinned");
    f.grant(repin);assert.equal(f.request().status,"complete");
    assert.ok(f.reads.every(r=>r.covered));assert.equal(mc.writes,0);
    for(const r of [normal,borrowed,repin]){const box=fixed.holdRectFor(r.box,128,r.apron??9);assert.equal((box.x1-box.x0+1)*(box.z1-box.z0+1)/256,64);}
});
test("isolated fix leaves ordinary and no-capacity normal-window request fuses unchanged",()=>{
    for(const status of ["held","nocapacity"]){
        const f=fixture(fixed);f.s.__apply=()=>"ok";
        const normal=f.request();assert.equal(normal.status,"need-hold");f.grant(normal);
        f.s.holdState={status,held:status==="held"};
        assert.equal(f.request().status,"complete","normal same-window retry does not request infinitely");
        assert.equal(mc.writes,0);
    }
});
