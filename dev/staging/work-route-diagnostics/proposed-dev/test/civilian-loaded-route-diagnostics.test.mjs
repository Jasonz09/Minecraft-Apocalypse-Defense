import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const {fixture}=await import('../lib/civilian-route-preview-fixture.mjs');
const after=await import('../../CivilizationApocalypse_BP/scripts/people/workRoutePreview.js');
const golden=JSON.parse(readFileSync(new URL('../fixtures/civilian-loaded-route-diagnostics-before.json',import.meta.url),'utf8'));
function run(module,mode){
 const f=fixture(4),endpoints=module.compileWorkRouteEndpoints(f.compiled(),{index:1,checksum:f.record.checksum,masterHash:'1234abcd',homeBuilding:f.home.id,farmBuilding:f.farm.id});
 const trace=[];let current=true,inSlice=0,maximum=0,slices=0;
 const ctx={current:()=>current,read(p){trace.push([p.x,p.y,p.z]);inSlice++;maximum=Math.max(maximum,inSlice);if(mode==='source')current=false;
  if(mode==='unloaded'&&p.x===2)return undefined;
  let id=p.y<=69?'minecraft:stone_bricks':'minecraft:air';
  if(p.x<0||p.x>4||Math.abs(p.z)>1)id='minecraft:water';
  if(mode==='body'&&p.x===2&&p.y===70)id='minecraft:short_grass';
  if(mode==='body'&&p.x===2&&p.y===71)id='minecraft:fern';
  if(mode==='headroom'&&p.x===1&&p.y===70&&p.z===0)id='minecraft:stone_bricks';
  if(mode==='headroom'&&p.x===0&&p.y===72&&p.z===0)id='minecraft:lantern';
  if(mode==='endpoint'&&p.x===0&&p.y===69&&p.z===0)id='minecraft:dirt';
  return{isValid:true,typeId:id};
 }};
 const generator=module.previewLoadedWorkRouteSteps(endpoints,ctx);let view;
 for(let i=0;i<2000;i++){inSlice=0;const next=generator.next();assert.ok(inSlice<=256);slices++;if(next.done){view=next.value;break;}}
 assert.ok(view,'bounded fixture terminates');return{view,trace,maximum,slices};
}
function withoutAddedDiagnostics(view,baseline){const value=structuredClone(view);delete value.samples;if(baseline.reasons===undefined)delete value.reasons;return value;}
for(const mode of ['safe','body','unloaded','headroom','endpoint','source'])test(`diagnostics preserve exact algorithm result/read order/budgets/guards for ${mode}`,()=>{
 const old=golden.cases[mode],proposal=run(after,mode);assert.deepEqual(withoutAddedDiagnostics(proposal.view,old.view),withoutAddedDiagnostics(old.view,old.view));assert.deepEqual(proposal.trace,old.trace);assert.equal(proposal.slices,old.slices);assert.equal(proposal.maximum,old.maximum);assert.equal(proposal.view.permission,false);assert.equal(proposal.view.verticalPermission,false);assert.deepEqual(after.LOADED_ROUTE_LIMITS,golden.limits);
});
test('unsafe feet and head show exact observed flora and exact required AIR without accepting it',()=>{
 const {view}=run(after,'body');assert.equal(view.state,'BOUNDED_NO_PATH');assert.ok(view.reasons.body>0);const rows=view.samples.filter(s=>s.kind==='body');assert.equal(rows.length,2);assert.equal(rows[0].observedId,'minecraft:short_grass');assert.equal(rows[0].point.y,70);assert.equal(rows[0].expected,'minecraft:air at feet');assert.equal(rows[1].observedId,'minecraft:fern');assert.equal(rows[1].point.y,71);assert.equal(rows[1].expected,'minecraft:air at head');
});
test('unloaded samples remain explicitly unreadable and are not called the whole-path cause',()=>{
 const {view}=run(after,'unloaded');assert.equal(view.state,'PARTIAL_NO_PATH');assert.ok(view.reasons.unloaded>0);const rows=view.samples.filter(s=>s.kind==='unloaded');assert.ok(rows.length>0);assert.ok(rows.every(s=>s.point.x===2&&s.observedId===null&&/loaded block/.test(s.expected)));const text=after.formatLoadedWorkRoutePreview(view).join('\n');assert.match(text,/overlapping observations/);assert.match(text,/not proof of why the entire path/);assert.match(text,/observed unavailable/);
});
test('rise headroom and exact saved endpoint mismatch identify existing-read coordinates and IDs',()=>{
 const head=run(after,'headroom').view,row=head.samples.find(s=>s.kind==='headroom');assert.ok(head.reasons.headroom>0);assert.deepEqual(row.point,{x:0,y:72,z:0});assert.equal(row.observedId,'minecraft:lantern');assert.equal(row.expected,'minecraft:air above rising actor');
 const endpoint=run(after,'endpoint').view;assert.equal(endpoint.state,'REFUSED_ENDPOINT');const mismatch=endpoint.samples.find(s=>s.kind==='endpointMaterial');assert.deepEqual(mismatch.point,{x:0,y:69,z:0});assert.equal(mismatch.observedId,'minecraft:dirt');assert.equal(mismatch.expected,'exact saved footing minecraft:stone_bricks');
});
test('sample storage and chat output remain bounded while every old safety declaration stays present',()=>{
 for(const mode of ['safe','body','unloaded','headroom','endpoint']){const {view}=run(after,mode);assert.ok(view.samples.length<=8);for(const kind of new Set(view.samples.map(s=>s.kind)))assert.ok(view.samples.filter(s=>s.kind===kind).length<=2);const lines=after.formatLoadedWorkRoutePreview(view);assert.ok(lines.length<=24);assert.match(lines.at(-1),/no blocks, properties, entities, impulses/);assert.match(lines.at(-1),/separate native microgate/);}
});
