import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
const before=readFileSync(new URL("./frozen-civBuilder.js",import.meta.url),"utf8");
const after=readFileSync(new URL("./proposed-civBuilder.js",import.meta.url),"utf8");
// Execute the actual complete exported function, without importing Minecraft or running builder initialization.
function extract(source){const start=source.indexOf("export function civAbortLines(");assert.notEqual(start,-1);const end=source.indexOf("\nexport { CIV_TICKING_ID",start);assert.notEqual(end,-1);return source.slice(start,end).trim();}
const load=async source=>(await import("data:text/javascript;base64,"+Buffer.from(extract(source)).toString("base64"))).civAbortLines;
const old=await load(before),proposed=await load(after);
test("leaf maintenance without construction session makes no zero-write or positive-write assertion",()=>{
 const lines=proposed({kind:"civ-wall-leaf-repair",stopped:undefined},"civ:generate_resume");
 assert.deepEqual(lines,["Stopped wall-leaf maintenance. Any completed replacements remain in the world. Retained receipts will be rechecked on rerun."]);
 assert.doesNotMatch(lines.join(" "),/no block|not started|were placed|receipt.*clear|generate_resume/);
});
test("ordinary planning abort stays byte-for-byte equivalent",()=>{
 for(const kind of ["civ-plan","civ-generate","civ-district-preview"]){const input={kind,stopped:undefined};assert.deepEqual(proposed(input,"resume"),old(input,"resume"));}
});
test("construction summary and saved/unsaved resume behavior stay unchanged even with leaf kind",()=>{
 for(const kind of ["civ-build","civ-wall-leaf-repair"])for(const saved of [true,false]){const input={kind,stopped:{saved,done:7,total:19,counts:{placed:4}}},original=structuredClone(input);assert.deepEqual(proposed(input,"civ:generate_resume"),old(input,"civ:generate_resume"));assert.deepEqual(input,original);}
});
test("proposal changes only the specific maintenance wording branch",()=>{
 const injected='        if (result.kind === "civ-wall-leaf-repair") {\n            return ["Stopped wall-leaf maintenance. Any completed replacements remain in the world. Retained receipts will be rechecked on rerun."];\n        }\n';
 assert.equal(after.replace(injected,""),before);
 assert.match(old({kind:"civ-wall-leaf-repair",stopped:undefined},"resume")[0],/no block was written/);
});
