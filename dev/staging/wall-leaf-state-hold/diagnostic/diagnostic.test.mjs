import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("./proposed-wallLeafTrim.js",import.meta.url),"utf8");
const start=source.indexOf("function leafIdentityDifference("),end=source.indexOf("\n/** One already-admitted",start);
const diagnostic=new Function("key",source.slice(start,end)+";return leafIdentityDifference;")(p=>`${p.x},${p.y},${p.z}`);
const snapshot=()=>({typeId:"minecraft:jungle_leaves",persistent:false,states:{persistent_bit:false,update_bit:true}});
test("diagnostic identifies exact coordinate and already-read boolean field difference",()=>{
 const before=snapshot(),current=snapshot();current.states.update_bit=false;
 const freeze=JSON.stringify([before,current]),message=diagnostic({x:-323,y:56,z:-455},before,current);
 assert.match(message,/-323,56,-455/);assert.match(message,/differing fields 1/);assert.match(message,/{"field":"states.update_bit","before":true,"current":false}/);assert.equal(JSON.stringify([before,current]),freeze);
});
test("diagnostic distinguishes type, persistence and state addition without replacing original error prefix",()=>{
 const before=snapshot(),current=snapshot();current.typeId="minecraft:oak_leaves";current.persistent=true;current.states.extra="x";
 const message=diagnostic({x:0,y:1,z:2},before,current);assert.match(message,/^admitted leaf identity\/states changed; preserve target and receipt/);assert.match(message,/"field":"typeId"/);assert.match(message,/"field":"persistent"/);assert.match(message,/"field":"states.extra"/);
});
test("many differences are explicitly bounded without extra world access",()=>{
 const before=snapshot(),current=snapshot();for(let i=0;i<60;i++)current.states["state"+i]=true;
 const message=diagnostic({x:0,y:1,z:2},before,current);assert.match(message,/differing fields 60/);assert.match(message,/56 more omitted/);assert.equal((message.match(/"field":/g)||[]).length,4);
});
