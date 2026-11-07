// Validates known component schemas from official versioned Mojang metadata.
// Dynamic-value components and client/model/Molang still require engine validation.
import Ajv from "ajv";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root=dirname(fileURLToPath(import.meta.url)),cache=join(root,"validation");
mkdirSync(cache,{recursive:true});
const lockFile=join(cache,"official-source.json");
let source;
if(existsSync(lockFile))source=JSON.parse(readFileSync(lockFile,"utf8"));
else {
    const response=await fetch("https://api.github.com/repos/Mojang/bedrock-samples/commits/main");
    if(!response.ok)throw new Error(`Cannot pin official metadata: ${response.status}`);
    const commit=await response.json();
    source={repository:"https://github.com/Mojang/bedrock-samples",commit:commit.sha,format:"1.26.20",retrieved:new Date().toISOString()};
    writeFileSync(lockFile,JSON.stringify(source,null,2)+"\n");
}
const base="https://civ-trial.invalid/";
async function official(path,closeFilterMap=false) {
    if(!/^(server|client|client_server)\//.test(path)||path.includes(".."))throw new Error(`Unexpected schema path ${path}`);
    const file=join(cache,"schemas",...path.split("/"));
    let schema;
    if(existsSync(file))schema=JSON.parse(readFileSync(file,"utf8"));
    else {
        const response=await fetch(`https://raw.githubusercontent.com/Mojang/bedrock-samples/${source.commit}/metadata/json_schemas/${path.split("/").map(encodeURIComponent).join("/")}`);
        if(!response.ok)throw new Error(`Official schema ${path}: ${response.status}`);
        schema=await response.json();mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(schema,null,2)+"\n");
    }
    const result={...schema,$id:new URL(path,base).href};
    // Published Filter Group uses oneOf(Test, Array, Map), but Map permits every
    // unknown key, so even a simple valid Test also matches Map and is rejected.
    // Close only that Map in memory; cached official bytes remain unchanged.
    if(closeFilterMap&&path==="client_server/common/1.21.20/Filter Group Map.json")result.additionalProperties=false;
    return result;
}
const behavior=JSON.parse(readFileSync(join(root,"BP/entities/swordsman.json"),"utf8"))["minecraft:entity"];
const definitions=await official("server/entity/1.26.20/Entity component definitions.json");
// Compile only used components. Importing every unused component compiles unrelated
// engine definitions; this scope is explicit and never presented as full engine parsing.
const used=Object.fromEntries(Object.keys(behavior.components).map(key=>{
    if(!Object.hasOwn(definitions.properties,key))throw new Error(`Unknown official component ${key}`);
    return[key,definitions.properties[key]];
}));
const schema={...definitions,properties:used,patternProperties:{},additionalProperties:false};
const makeAjv=closeFilterMap=>new Ajv({strict:false,allErrors:true,loadSchema:async uri=>{
    const url=new URL(uri);if(url.origin!==new URL(base).origin)throw new Error(`Unexpected schema origin ${uri}`);
    return official(decodeURIComponent(url.pathname.slice(1)),closeFilterMap);
}});
const raw=await makeAjv(false).compileAsync(schema);
const rawPassed=raw(behavior.components),rawErrors=raw.errors??[];
if(!rawPassed&&rawErrors.some(error=>!error.instancePath.startsWith("/minecraft:behavior.nearest_attackable_target/entity_types")))throw new Error(JSON.stringify(rawErrors,null,2));
const validate=await makeAjv(true).compileAsync(schema);
if(!validate(behavior.components))throw new Error(JSON.stringify(validate.errors,null,2));
// Negative control: this must reject a broken melee cooldown, not just recognize names.
const broken=structuredClone(behavior.components);broken["minecraft:behavior.melee_attack"].cooldown_time="one";
if(validate(broken))throw new Error("Official melee schema failed its negative control.");
const dynamic=Object.entries(used).filter(([,s])=>s.description==="Dynamic value"&&!s.type&&!s.$ref).map(([k])=>k);
const report={source,componentCount:Object.keys(used).length,structuredComponents:Object.keys(used).filter(k=>!dynamic.includes(k)),dynamicComponents:dynamic,unmodifiedMetadataPassed:rawPassed,
    filterSchemaWorkaround:rawPassed?null:"Published Filter Group Map has no additionalProperties restriction and overlaps Filter Test in oneOf. Validation closes only this map in memory to its documented operators; original cached schemas remain unchanged. This is not an unmodified full-schema pass.",
    unmodifiedMetadataErrors:rawErrors,
    limitation:"Official metadata leaves dynamic components unconstrained. RP geometry, Molang, persistence and gameplay are checked separately/offline where possible and remain native acceptance work."};
writeFileSync(join(cache,"schema-report.json"),JSON.stringify(report,null,2)+"\n");
console.log(`Official ${source.format} component metadata: ${report.componentCount} recognized; ${report.structuredComponents.length} structured checks passed with documented Filter Group Map correction; ${dynamic.length} dynamic/unconstrained. Unmodified metadata passed: ${rawPassed}. Negative cooldown control rejected. Commit ${source.commit}.`);
