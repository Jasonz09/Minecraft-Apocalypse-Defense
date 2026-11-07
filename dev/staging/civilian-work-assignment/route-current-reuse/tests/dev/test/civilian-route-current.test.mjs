import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
// Test-only forwarding wrapper captures the ACTUAL production planner callback.
// Full controller/guard/planner bodies are otherwise unchanged.
register('data:text/javascript,'+encodeURIComponent(`import{readFile}from'node:fs/promises';export async function load(u,c,n){const result=await n(u,c);if(u.endsWith('/integration/civilianDestinations.js')){let source=await readFile(new URL(u),'utf8');const from='import {compileWorkRouteEndpoints,collectWorkRoadHintsSteps,previewLoadedWorkRouteSteps,formatLoadedWorkRoutePreview} from "../people/workRoutePreview.js";';if(!source.includes(from))throw Error('controller forwarding seam drift');source=source.replace(from,'import {compileWorkRouteEndpoints,collectWorkRoadHintsSteps,previewLoadedWorkRouteSteps as productionPreview,formatLoadedWorkRoutePreview} from "../people/workRoutePreview.js";const previewLoadedWorkRouteSteps=(...args)=>{globalThis.__routeReuseCurrent=args[1].current;return productionPreview(...args);};');return{...result,source};}return result;}`));
register('data:text/javascript,'+encodeURIComponent(`import{readFile}from'node:fs/promises';export async function load(u,c,n){const result=await n(u,c);if(u.endsWith('/people/workRoutePreview.js')){let source=await readFile(new URL(u),'utf8');const from="import {isLiveSite,siteOpSlices} from '../civ/districtplan.js';";if(!source.includes(from))throw Error('hint stream seam drift');source=source.replace(from,"import {isLiveSite} from '../civ/districtplan.js';const siteOpSlices=(...args)=>globalThis.__workDestinationStream(...args);");return{...result,source};}return result;}`));
const {fixture}=await import('../lib/civilian-route-preview-fixture.mjs');
function setup(){const f=fixture();f.props.set('civ:plan:meta',JSON.stringify({hash:'1234abcd'}));f.deps.canPreviewRoute=()=>!f.state.busy&&!f.driver.isActive();globalThis.__routeReuseCurrent=undefined;let phase=0;const run=f.deps.runJob;f.deps.runJob=(token,g)=>{phase++;return run(token,g);};return{f,get nativePhase(){return phase===4;},command:()=>f.controller.routePreviewCommand(`district=1 home=${f.home.id} farm=${f.farm.id}`,{sourceEntity:f.player})};}
test('positive command uses exactly ONE validated kingdom load per full source audit, retaining every raw audit',async()=>{
 const c=setup(),f=c.f;let kingdoms=0,audits=0,sourceValues=0;const read=f.deps.readKingdom,ids=f.world.getDynamicPropertyIds,value=f.world.getDynamicProperty;
 f.deps.readKingdom=()=>{kingdoms++;return read();};f.world.getDynamicPropertyIds=()=>{audits++;return ids();};f.world.getDynamicProperty=k=>{if(k==='civ:plan:a:0')sourceValues++;return value(k);};
 const lines=await c.command();assert.match(lines.join('\n'),/OBSERVED_LOADED_PATH/);assert.equal(kingdoms,audits+1,'one initial source selection, then one fresh load for EVERY full audit including constructor');assert.equal(sourceValues,audits,'every audit still rereads existing source chunk');assert.ok(audits>=f.state.reads*2,'full source audits remain before/after native reads plus checkpoints');assert.equal(f.state.busy,false);
});
test('raw property getter replacing kingdom during audit is checked from the SAME fresh snapshot before native read',async()=>{
 const c=setup(),f=c.f;let live=f.kingdom,armed=true;f.deps.readKingdom=()=>structuredClone(live);const get=f.world.getDynamicProperty;
 f.world.getDynamicProperty=k=>{if(c.nativePhase&&armed&&k==='civ:plan:a:0'){armed=false;live={...live,districts:[{...f.district,security:'contested'}]};}return get(k);};
 assert.match((await c.command()).join('\n'),/refused/);assert.equal(f.state.reads,0);assert.equal(f.state.busy,false);
});
test('fresh civ replacement after constructor cannot reuse original selected/constructor snapshot',async()=>{
 const c=setup(),f=c.f;let live=f.kingdom,armed=true;f.deps.readKingdom=()=>structuredClone(live);const get=f.world.getDynamicProperty;
 f.world.getDynamicProperty=k=>{if(c.nativePhase&&armed&&k==='civ:plan:a:0'){armed=false;live={...live,districts:[{...f.district,civ:{...f.district.civ,checksum:'deadbeef'}}]};}return get(k);};
 assert.match((await c.command()).join('\n'),/refused/);assert.equal(f.state.reads,0);assert.equal(f.state.busy,false);
});
test('threat from a native getter is refused on immediate post-getter FULL audit',async()=>{
 const c=setup(),f=c.f;const old=f.dimension.getBlock;f.dimension.getBlock=p=>{const block=old(p);f.district.security='contested';return block;};
 assert.match((await c.command()).join('\n'),/refused/);assert.equal(f.state.reads,1);assert.equal(f.state.busy,false);
});
test('raw source changed by native getter is refused on immediate post-getter FULL audit',async()=>{
 const c=setup(),f=c.f;const old=f.dimension.getBlock;f.dimension.getBlock=p=>{const block=old(p);f.props.set('civ:plan:a:0','changed');return block;};
 assert.match((await c.command()).join('\n'),/refused/);assert.equal(f.state.reads,1);assert.equal(f.state.busy,false);
});
test('property getter altering a later-audited raw key refuses before native calls',async()=>{
 const c=setup(),f=c.f;const get=f.world.getDynamicProperty;let armed=true;f.world.getDynamicProperty=k=>{const value=get(k);if(c.nativePhase&&armed&&k==='civ:jobs:meta'){armed=false;f.props.set('civ:plan:a:0','changed');}return value;};
 assert.match((await c.command()).join('\n'),/refused/);assert.equal(f.state.reads,0);assert.equal(f.state.busy,false);
});
test('reentrant current cannot overwrite outer capture and capture clears for next command',async()=>{
 const c=setup(),f=c.f,get=f.world.getDynamicProperty;let armed=true,inner;
 f.world.getDynamicProperty=k=>{if(c.nativePhase&&armed&&k==='civ:plan:a:0'){armed=false;inner=globalThis.__routeReuseCurrent();}return get(k);};
 assert.match((await c.command()).join('\n'),/refused/);assert.equal(inner,false);assert.equal(f.state.reads,0);assert.equal(f.state.busy,false);
 f.world.getDynamicProperty=get;assert.match((await c.command()).join('\n'),/OBSERVED_LOADED_PATH/);assert.equal(f.state.busy,false);
});

for(const change of ['cancel','invalid-player','dimension'])test(`raw getter ${change} is refused on SAME current before native reads`,async()=>{
 const c=setup(),f=c.f,get=f.world.getDynamicProperty;let armed=true,activeToken;
 const reserve=f.deps.reserveJob;f.deps.reserveJob=()=>{activeToken=reserve();return activeToken;};
 f.world.getDynamicProperty=k=>{const value=get(k);if(c.nativePhase&&armed&&k==='civ:plan:a:0'){
  armed=false;if(change==='cancel')activeToken.cancelled=true;
  else if(change==='invalid-player')f.player.isValid=false;
  else f.player.dimension={...f.dimension,id:'minecraft:the_nether'};
 }return value;};
 assert.match((await c.command()).join('\n'),/refused/);assert.equal(armed,false);assert.equal(f.state.reads,0);assert.equal(f.state.busy,false);
 assert.equal(f.state.writes,0);assert.equal(f.state.impulses.length,0);
});
