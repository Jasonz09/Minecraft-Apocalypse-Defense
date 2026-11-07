import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {mc,resetWorld,builder,propsSnapshot} from "../lib/civharness.mjs";
import {newOps} from "../../CivilizationApocalypse_BP/scripts/civ/regions.js";
import {compileLeafTrim,readLeafTrimReceipt,readLeafTrimReceiptForPlan,POLICY} from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js";
import {compilePendingLeafSourcesSteps} from "../../CivilizationApocalypse_BP/scripts/civ/leafSourceStreaming.js";
import {createWallLeafSourceGuard} from "../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js";
const closed=JSON.parse(readFileSync(new URL("../fixtures/wall-leaf-closed-source-20261106.json",import.meta.url),"utf8"));
const raw=JSON.parse(readFileSync(new URL("../fixtures/wall-leaf-held1-receipt-20261106.json",import.meta.url),"utf8"));
const run=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
test("real five saved sources stream the original held1 plan c835b06e and exact schema2 receipt without source writes",()=>{
 resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);
 const receipt=readLeafTrimReceipt(raw),kingdom=JSON.parse(mc.props.get("civ:kingdom")),sourceKey="civ:wall_leaf_trim:v1:d4:c835b06e";mc.props.set(sourceKey,raw);
 const before=propsSnapshot(),guard=createWallLeafSourceGuard({getDynamicPropertyIds:()=>[...mc.props.keys()],getDynamicProperty:k=>mc.props.get(k)},()=>JSON.parse(mc.props.get("civ:kingdom")));
 const sources=kingdom.districts.filter(d=>d.civ).map(d=>({index:Number(d.id.slice(9)),checksum:d.civ.checksum,status:d.civ.status,dimension:d.civ.dimension}));
 const input={index:4,checksum:receipt.checksum,masterHash:receipt.masterHash,dimension:receipt.dimension,policy:POLICY,sources};let active=0,maximum=0,loads=0;
 const deps={sourcesCurrent:()=>guard.current(),receiptStore:{load:()=>mc.props.get(sourceKey)},*loadSourceSteps(index,civ){active++;maximum=Math.max(maximum,active);loads++;try{return yield* builder.loadSavedRunSteps(civ,newOps(),index);}finally{active--;}}};
 const streamed=run(compilePendingLeafSourcesSteps(input,deps));assert.equal(streamed.planId,"c835b06e");assert.deepEqual(readLeafTrimReceiptForPlan(raw,streamed),receipt);assert.equal(loads,5);assert.equal(maximum,1);assert.deepEqual(propsSnapshot(),before);
 // Baseline all-record batch is loaded ONLY AFTER streaming generator has returned.
 const batchSources=sources.map(s=>{const civ={status:s.status,checksum:s.checksum,dimension:s.dimension},saved=run(builder.loadSavedRunSteps(civ,newOps(),s.index));assert.equal(saved.ok,true);return{record:saved.record,civ,masterHash:receipt.masterHash};});
 const batch=compileLeafTrim({...input,candidates:receipt.requested,sources:batchSources});assert.deepEqual(streamed,batch);assert.deepEqual(propsSnapshot(),before);
});
