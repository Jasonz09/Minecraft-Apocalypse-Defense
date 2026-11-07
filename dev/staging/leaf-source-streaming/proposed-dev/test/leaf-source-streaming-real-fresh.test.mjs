import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {mc,resetWorld,builder,civCommands,propsSnapshot} from "../lib/civharness.mjs";
import {newOps} from "../../CivilizationApocalypse_BP/scripts/civ/regions.js";
import {compileFreshLeafSourcesSteps} from "../../CivilizationApocalypse_BP/scripts/civ/leafSourceStreaming.js";
import {createWallLeafSourceGuard} from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js";
const readJson=name=>JSON.parse(readFileSync(new URL(`../fixtures/${name}`,import.meta.url),"utf8"));
const closed=readJson("wall-leaf-closed-source-20261106.json"),evidence=readJson("wall-leaf-preview-20261106.json"),golden=readJson("leaf-source-streaming-real-fresh-golden.json");
const key=p=>`${p.x},${p.y},${p.z}`;
const run=g=>{for(;;){const next=g.next();if(next.done)return next.value;}};

test("real fresh five-source streaming exactly matches frozen batch survey and c835b06e under the deterministic offline block fixture",()=>{
 // This block fixture is deliberately offline. Its34673/1238 counts are NOT native6758/29153.
 const rows=[...evidence.eligible,...evidence.refused],leaves=new Map(rows.map(row=>[key(row.position),{isValid:true,typeId:row.actualId,states:{old_leaf_type:row.actualId.slice(10,-7),persistent_bit:false,update_bit:false}}]));
 const near=new Set();for(const row of rows)for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)near.add(key({x:row.position.x+x,y:row.position.y+y,z:row.position.z+z}));
 const read=p=>{const leaf=leaves.get(key(p));if(leaf)return structuredClone(leaf);if(!near.has(key(p))&&Math.abs(p.x*31+p.y*7+p.z*13)%29===0)return undefined;return{isValid:true,typeId:"minecraft:air",states:{}};};
 resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);
 const before=propsSnapshot(),blockWrites=mc.writes,propertyWrites=mc.propWrites,kingdom=JSON.parse(mc.props.get("civ:kingdom")),masterHash=JSON.parse(mc.props.get("civ:plan:meta")).hash;
 const sources=kingdom.districts.filter(d=>d.civ).map(d=>({index:Number(d.id.slice(9)),checksum:d.civ.checksum,status:d.civ.status,dimension:d.civ.dimension}));
 const guard=createWallLeafSourceGuard({getDynamicPropertyIds:()=>[...mc.props.keys()],getDynamicProperty:k=>mc.props.get(k)},()=>JSON.parse(mc.props.get("civ:kingdom")));
 let areas,loads=0,active=0,maximum=0;
 const context={read,isProtected:(x,z)=>{assert.ok(areas,"verified protection must precede live census");return builder.inProtectedArea(areas,x,z);},sourcesCurrent:()=>guard.current(),journalsCurrent:()=>true,
  onVerifiedMaster(plan){if(!areas)areas=civCommands.protectedRects(kingdom,1,plan,builder.WRITE_PROTECT_GROW,4);},
  *loadSourceSteps(index,civ){active++;loads++;maximum=Math.max(maximum,active);try{return yield* builder.loadSavedRunSteps(civ,newOps(),index);}finally{active--;}}};
 const streamed=run(compileFreshLeafSourcesSteps({policy:"wall-leaves-trim-v1",index:4,checksum:"35635162",masterHash,dimension:"minecraft:overworld",sources},context));
 assert.deepEqual(streamed.survey,golden.survey,"all frozen detailed rows/contacts/reasons/statistics and global unreadable/refused counts");
 assert.deepEqual(streamed.plan,golden.plan,"exact frozen strict-compiler operation/contact provenance and ordered eligible subset");
 assert.equal(streamed.plan.planId,"c835b06e");assert.equal(streamed.survey.targets,35911);assert.equal(streamed.survey.surveyed,34673);assert.equal(streamed.survey.unloaded,1238);assert.equal(streamed.survey.tree,17);assert.equal(streamed.survey.eligible,14);assert.equal(streamed.survey.refused,3);assert.equal(streamed.survey.complete,false);
 assert.equal(loads,5);assert.equal(maximum,1);assert.deepEqual(propsSnapshot(),before);assert.equal(mc.writes,blockWrites);assert.equal(mc.propWrites,propertyWrites);
});
