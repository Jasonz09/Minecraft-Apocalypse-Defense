// Applies ONLY an in-memory reducer substitution to the real adapter's import.
// Does not write active source, existing tests, native worlds or installed packs.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {register} from "node:module";
import {createHash} from "node:crypto";
const sourceUrl=new URL("../../../CivilizationApocalypse_BP/scripts/population/reconcile.js",import.meta.url);
const bytes=readFileSync(sourceUrl);
export const sourceSha256=createHash("sha256").update(bytes).digest("hex");
const anchor="    let spawned = 0;\n    for (const op of spawns) {";
const replacement=`    let spawned = 0;
    // A failed standing probe still spends an attempt. Rotate the pending queue
    // using the persisted reconcile count so the same early failures cannot
    // indefinitely prevent later admitted groups from reaching the sole owner.
    const spawnOffset = spawns.length === 0 ? 0 : prior.runs % spawns.length;
    for (let index = 0; index < spawns.length; index += 1) {
        const op = spawns[(spawnOffset + index) % spawns.length];`;
const source=bytes.toString("utf8").replace(/\r\n/g,"\n");
// After integration, reconstruct only the old loop in memory for the historical comparison.
const integrated=source.includes(replacement);
assert.ok(integrated||source.split(anchor).length===2,"spawn loop changed; review prototype against source");
const baseline=integrated?source.replace(replacement,anchor):source;
const patched=(integrated?source:source.replace(anchor,replacement)).replace(/from\s+"(\.[^"]+)"/g,(_,specifier)=>"from "+JSON.stringify(new URL(specifier,sourceUrl).href));
const patchedUrl="data:text/javascript,"+encodeURIComponent(patched);
register("data:text/javascript,"+encodeURIComponent(`export async function resolve(s,c,next){
 if(s==="@minecraft/server")return{url:"data:text/javascript,export const world={};export const system={};",shortCircuit:true};
 if(s==="../population/reconcile.js"&&c.parentURL?.endsWith("/integration/popSync.js"))return{url:${JSON.stringify(patchedUrl)},shortCircuit:true};
 return next(s,c);
}`));
export const patchedReducer=await import(patchedUrl);
export const originalReducer=await import("data:text/javascript,"+encodeURIComponent(baseline.replace(/from\s+"(\.[^"]+)"/g,(_,specifier)=>"from "+JSON.stringify(new URL(specifier,sourceUrl).href))));
export const {createPopSync}=await import("../../../CivilizationApocalypse_BP/scripts/integration/popSync.js");
