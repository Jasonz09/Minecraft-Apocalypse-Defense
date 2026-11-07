import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import * as core from "../../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js";
import {SITE_STAGES} from "../../../CivilizationApocalypse_BP/scripts/civ/districtplan.js";
const source=readFileSync(new URL("proposed-dev/test/leaf-source-streaming.test.mjs",import.meta.url),"utf8");
const fixture=new Function("core","SITE_STAGES","assert",source.slice(source.indexOf("function fixture(){"),source.indexOf("\ntest("))+";return fixture;")(core,SITE_STAGES,assert);
const cases={};
for(const name of ["normal","candidate-metadata-refusal","historical"]){const f=fixture();
 if(name==="candidate-metadata-refusal"){f.input.candidates[0]={...f.input.candidates[0],id:"minecraft:stone_bricks",label:"original-refusal-metadata"};f.sources[0].record.dressing=[{id:"late",ops:[{x:0,y:70,z:0,id:"minecraft:air"}]}];}
 if(name==="historical")f.sources[1].record.lots=[{id:"decor",ops:[{x:0,y:70,z:0,id:"minecraft:oak_leaves"},{x:0,y:70,z:0,id:"minecraft:stone_bricks",kind:"wall"}]}];
 cases[name]=core.compileLeafTrim(f.input,f.compilerDependencies);
}
const rootSource=readFileSync(new URL("../../../CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js",import.meta.url));
writeFileSync(new URL("proposed-dev/fixtures/leaf-source-streaming-compiler-golden.json",import.meta.url),JSON.stringify({sourceSha256:createHash("sha256").update(rootSource).digest("hex").toUpperCase(),cases},null,2)+"\n");
console.log("Captured three lightweight frozen-production batch compiler golden plans.");
