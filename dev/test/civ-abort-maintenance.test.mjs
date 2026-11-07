import assert from "node:assert/strict";
import test from "node:test";
import {builder,mc,propsSnapshot} from "../lib/civharness.mjs";
const {civAbortLines}=builder;
test("leaf maintenance abort with no construction session reports retained work without a write-count claim",()=>{
 assert.deepEqual(civAbortLines({kind:"civ-wall-leaf-repair",stopped:undefined},"civ:generate_resume"),["Stopped wall-leaf maintenance. Any completed replacements remain in the world. Retained receipts will be rechecked on rerun."]);
});
test("ordinary planning abort keeps the existing no-construction report",()=>{
 for(const kind of ["civ-plan","civ-generate","civ-district-preview"])assert.deepEqual(civAbortLines({kind,stopped:undefined},"unused"),[`Stopped the ${kind} job. It had not started building: no block was written by it.`]);
});
test("saved and unsaved construction summaries remain exact for any construction-bearing result",()=>{
 for(const kind of ["civ-build","civ-wall-leaf-repair"])for(const saved of [true,false])assert.deepEqual(civAbortLines({kind,stopped:{saved,done:7,total:19,counts:{placed:4}}},"civ:generate_resume"),[
 `Civilization build stopped${saved?"":" (progress could not be saved; the last saved point will be used)"}. 7 of 19 operations are done; 4 block(s) were placed in this run and stay in the world.`,
 "Continue with /scriptevent civ:generate_resume."]);
});
test("abort presentation does not alter result, block state or retained receipts",()=>{
 const input={kind:"civ-wall-leaf-repair",stopped:undefined},snapshot=structuredClone(input),before=propsSnapshot(),writes=mc.writes,propWrites=mc.propWrites;
 civAbortLines(input,"unused");assert.deepEqual(input,snapshot);assert.deepEqual(propsSnapshot(),before);assert.equal(mc.writes,writes);assert.equal(mc.propWrites,propWrites);
});
