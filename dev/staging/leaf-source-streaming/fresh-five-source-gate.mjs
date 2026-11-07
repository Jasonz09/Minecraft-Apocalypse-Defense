import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {performance} from "node:perf_hooks";
import {mc,resetWorld,builder,civCommands,propsSnapshot} from "../../lib/civharness.mjs";
import {newOps} from "../../../CivilizationApocalypse_BP/scripts/civ/regions.js";
import {compileFreshLeafSourcesSteps} from "../../../CivilizationApocalypse_BP/scripts/civ/leafSourceStreaming.js";
import {createWallLeafSourceGuard} from "../../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js";
const original=new URL("../../../CivilizationApocalypse_BP/scripts/civ/",import.meta.url);
async function frozen(name){let source=readFileSync(new URL("frozen-"+name,import.meta.url),"utf8");source=source.replace(/from "([^"\n]+)"/g,(_,s)=>`from "${new URL(s,new URL(name,original)).href}"`);return import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));}
const oldPreview=await frozen("wallleafpreview.js"),oldCore=await frozen("wallLeafTrim.js");
const closed=JSON.parse(readFileSync(new URL("../../../dev/fixtures/wall-leaf-closed-source-20261106.json",import.meta.url),"utf8"));
const evidence=JSON.parse(readFileSync(new URL("../../../dev/fixtures/wall-leaf-preview-20261106.json",import.meta.url),"utf8"));
const heldRaw=JSON.parse(readFileSync(new URL("../../../dev/fixtures/wall-leaf-held1-receipt-20261106.json",import.meta.url),"utf8"));
const key=p=>`${p.x},${p.y},${p.z}`,leaves=new Map([...evidence.eligible,...evidence.refused].map(row=>[key(row.position),{isValid:true,typeId:row.actualId,states:{old_leaf_type:row.actualId.slice(10,-7),persistent_bit:false,update_bit:false}}]));
const near=new Set();for(const row of [...evidence.eligible,...evidence.refused])for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)near.add(key({x:row.position.x+x,y:row.position.y+y,z:row.position.z+z}));
function read(p){const b=leaves.get(key(p));if(b)return structuredClone(b);if(!near.has(key(p))&&Math.abs(p.x*31+p.y*7+p.z*13)%29===0)return undefined;return{isValid:true,typeId:"minecraft:air",states:{}};}
resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);
const before=propsSnapshot(),kingdom=JSON.parse(mc.props.get("civ:kingdom")),masterHash=JSON.parse(mc.props.get("civ:plan:meta")).hash;
const sources=kingdom.districts.filter(d=>d.civ).map(d=>({index:Number(d.id.slice(9)),checksum:d.civ.checksum,status:d.civ.status,dimension:d.civ.dimension}));
const guard=createWallLeafSourceGuard({getDynamicPropertyIds:()=>[...mc.props.keys()],getDynamicProperty:k=>mc.props.get(k)},()=>JSON.parse(mc.props.get("civ:kingdom")));
let areas,loads=0,active=0,maximum=0,yields=0;
const context={read,isProtected:(x,z)=>{assert.ok(areas,"verified protection exists before live read");return builder.inProtectedArea(areas,x,z);},sourcesCurrent:()=>guard.current(),journalsCurrent:()=>true,
 onVerifiedMaster(plan){if(!areas)areas=civCommands.protectedRects(kingdom,1,plan,builder.WRITE_PROTECT_GROW,4);},
 *loadSourceSteps(index,civ){active++;loads++;maximum=Math.max(maximum,active);try{return yield* builder.loadSavedRunSteps(civ,newOps(),index);}finally{active--;}}};
function run(g){for(;;){const n=g.next();if(n.done)return n.value;yields++;}}
const start=performance.now();console.log("Fresh sequential five-source gate START; deterministic injected block fixture, not native.");
const streamed=run(compileFreshLeafSourcesSteps({policy:oldCore.POLICY,index:4,checksum:"35635162",masterHash,dimension:"minecraft:overworld",sources},context));
const streamMs=performance.now()-start;assert.equal(loads,5);assert.equal(maximum,1);assert.deepEqual(propsSnapshot(),before);console.log("Streaming complete:",streamMs.toFixed(1),"ms; now frozen batch baseline.");
const batchSources=sources.map(s=>{const civ={status:s.status,checksum:s.checksum,dimension:s.dimension},saved=run(builder.loadSavedRunSteps(civ,newOps(),s.index));assert.equal(saved.ok,true);assert.equal(saved.queue.state,"complete");return{record:saved.record,civ,masterHash};});
const baseline=run(oldPreview.previewWallLeavesSteps({record:batchSources.find(s=>s.record.districtIndex===4).record,records:batchSources.map(s=>s.record),read,isProtected:context.isProtected}));
assert.deepEqual(streamed.survey,baseline,"EXACT frozen detailed rows/contacts/reasons/stats/wall counts and incomplete globals");
const candidates=baseline.rows.filter(r=>r.state==="eligible").map(r=>r.target),batch=oldCore.compileLeafTrim({index:4,checksum:"35635162",masterHash,dimension:"minecraft:overworld",candidates,sources:batchSources});
assert.deepEqual(streamed.plan,batch);assert.equal(candidates.length,14);assert.equal(baseline.refused,3);assert.equal(baseline.tree,17);assert.ok(baseline.unloaded>0);assert.equal(baseline.complete,false);assert.equal(batch.planId,"c835b06e");assert.deepEqual(oldCore.readLeafTrimReceiptForPlan?oldCore.readLeafTrimReceiptForPlan(heldRaw,batch):oldCore.readLeafTrimReceipt(heldRaw),oldCore.readLeafTrimReceipt(heldRaw));assert.deepEqual(propsSnapshot(),before);
for(const row of evidence.refused)assert.equal(baseline.rows.find(r=>key(r.target)===key(row.position)).state,"refused");
const result={utc:new Date().toISOString(),scope:"OFFLINE exact fresh5source/frozen-production parity with deterministic injected native block API; NOT native block/memory/stability proof",pass:true,streamMs,totalMs:performance.now()-start,yields,streamLoads:loads,maxConcurrentLoaders:maximum,sourceAndQueuePropertiesUnchanged:true,planId:batch.planId,eligible:candidates.length,refused:baseline.refused,tree:baseline.tree,targets:baseline.targets,surveyed:baseline.surveyed,unloaded:baseline.unloaded,complete:baseline.complete,exactSurveyRowsContactsReasonsStatsAndGlobals:true,exactFrozenBatchPlan:true,sourceWrites:0,blockWrites:0,survey:baseline,plan:batch};
writeFileSync(new URL("fresh-five-source-result.json",import.meta.url),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({...result,survey:undefined,plan:undefined},null,2));
