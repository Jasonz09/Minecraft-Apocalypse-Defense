import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {anchoredInteriorLights,lanternAnchor} from '../../CivilizationApocalypse_BP/scripts/civ/interiorlights.js';
import {BLUEPRINTS2,BLUEPRINT_VARIANTS,rotatedSize} from '../../CivilizationApocalypse_BP/scripts/structures/blueprints2.js';
import {normalizeOps} from '../../CivilizationApocalypse_BP/scripts/civ/opnorm.js';
import {newOps,runSync} from '../../CivilizationApocalypse_BP/scripts/civ/regions.js';
const url=new URL('../../CivilizationApocalypse_BP/scripts/civ/districtplan.js',import.meta.url);
const source=readFileSync(url,'utf8').replace(/from\s+"(\.[^"]+)"/g,(_,spec)=>'from '+JSON.stringify(new URL(spec,url).href))+'\nexport {buildingOpsSteps,persistedOptions};';
const production=await import('data:text/javascript,'+encodeURIComponent(source));
const key=p=>[p.x,p.y,p.z].join(',');
const hallGeo={rect:{x0:18,z0:-555,x1:31,z1:-533},door:{x:28,z:-544},facing:'east'};
const hall=(anchored=false)=>normalizeOps(runSync(production.buildingOpsSteps({kind:'command_hall'},BLUEPRINTS2.command_hall_v2,3,18,-555,67,hallGeo,newOps(),true,anchored)));

test('actual rotated hall moves its unsupported carpet lantern onto existing council table without adding fixtures or changing furnishings',()=>{
 const old=hall(),planned=anchoredInteriorLights(old,67,hallGeo),after=hall(true);
 assert.equal(planned.fixtures.length,3);assert.equal(after.filter(o=>o.id==='minecraft:lantern').length,3);
 const f=planned.fixtures.find(f=>key(f.before)==='19,69,-544');
 assert.equal(key(f.after),'21,69,-544');assert.equal(key(f.anchor),'21,68,-544');
 assert.equal(f.anchor.id,'minecraft:dark_oak_planks');assert.deepEqual(f.after.states,{hanging:false});
 assert.equal(after.some(o=>key(o)==='19,69,-544'),false);
 const structure=a=>a.filter(o=>o.id!=='minecraft:lantern'&&o.kind!=='support');assert.deepEqual(structure(after),structure(old));
 const oldSupports=new Map(old.filter(o=>o.kind==='support').map(o=>[key(o),o]));
 for(const op of after.filter(o=>o.kind==='support'))assert.deepEqual(op,oldSupports.get(key(op)),'light attachment adds no new support posts');
 for(const f of planned.fixtures){assert.ok(lanternAnchor(f.anchor,f.after.states.hanging));assert.equal(f.anchor.y,f.after.y+(f.after.states.hanging?1:-1));}
});

test('all enclosed blueprint variants and rotations retain sparse counts and give every lantern a real planned vertical anchor',()=>{
 for(const [kind,names]of Object.entries(BLUEPRINT_VARIANTS))for(const name of names)for(let rot=0;rot<4;rot++){
  if(production.OPEN_AIR_KINDS.has(kind))continue;
  const bp=BLUEPRINTS2[name],{w,d}=rotatedSize(bp,rot),geo={rect:{x0:0,z0:0,x1:w-1,z1:d-1},door:{x:0,z:0},facing:'south'};
  const old=normalizeOps(runSync(production.buildingOpsSteps({kind},bp,rot,0,0,67,geo,newOps(),true)));
  const ops=newOps(),after=normalizeOps(runSync(production.buildingOpsSteps({kind},bp,rot,0,0,67,geo,ops,true,true)));
  const lamps=after.filter(o=>o.id==='minecraft:lantern'),at=new Map(after.map(o=>[key(o),o]));
  assert.equal(lamps.length,Math.max(1,old.filter(o=>o.id==='minecraft:lantern').length),name+' '+rot);
  for(const lamp of lamps){assert.equal(typeof lamp.states?.hanging,'boolean');const support=at.get(key({...lamp,y:lamp.y+(lamp.states.hanging?1:-1)}));assert.ok(lanternAnchor(support,lamp.states.hanging),name+' '+rot+' '+key(lamp));}
  assert.ok(ops.maxRun<=25000,'cooperative planner bound');
 }
});

test('carpet/panes/slabs/doors cannot act as lantern anchors; no anchor refuses rather than inventing a support or extra light',()=>{
 for(const id of ['red_carpet','glass_pane','oak_slab','oak_stairs','wooden_door','lantern','air'])assert.equal(lanternAnchor({id}),false,id);
 assert.equal(lanternAnchor({id:'oak_fence'}),true);assert.equal(lanternAnchor({id:'oak_fence'},true),false);
 assert.throws(()=>anchoredInteriorLights([{x:2,y:2,z:2,id:'lantern'},{x:2,y:1,z:2,id:'red_carpet'}],0,{rect:{x0:0,z0:0,x1:5,z1:5},door:{x:0,z:0}}),/No supported/);
});

test('interior fixture version is explicit and old option payloads remain unchanged',()=>{
 const old={seed:1,roofSupport:'joists',lighting:'natural'};
 const a=production.persistedOptions(old);assert.equal(Object.hasOwn(a,'interiorLights'),false);
 assert.equal(Object.hasOwn(production.siteOptionsOf({options:a}),'interiorLights'),false);
 const b=production.persistedOptions({...old,interiorLights:'anchored-v1'});assert.equal(b.interiorLights,'anchored-v1');
 assert.deepEqual(production.siteOptionsOf({options:b}),{seed:1,lighting:'natural',roofSupport:'joists',interiorLights:'anchored-v1'});
 assert.deepEqual(production.persistedOptions({...old,interiorLights:undefined}),a);
});

test('moving a final lantern never revives an earlier overwritten raw block at its source',()=>{
 const source=[{x:2,y:2,z:2,id:'stone_bricks'},{x:2,y:2,z:2,id:'lantern'},
  {x:3,y:1,z:2,id:'crafting_table'}];
 const planned=anchoredInteriorLights(source,0,{rect:{x0:0,z0:0,x1:5,z1:5},door:{x:0,z:0}});
 assert.equal(planned.ops.some(op=>key(op)==='2,2,2'),false);
 assert.equal(planned.fixtures.length,1);
 assert.equal(key(planned.fixtures[0].after),'3,2,2');
});

test('legacy fixture migration requires actual final source ownership and refuses later target/anchor overwrites',async()=>{
 const instrumented=source.replace('export function siteOpsFor(', 'function actualSiteOpsFor(')+
  '\nfunction siteOpsFor(r,s,i){return r.__testOps?.[s]?.[i]??actualSiteOpsFor(r,s,i);}\n';
 const p=await import('data:text/javascript,'+encodeURIComponent(instrumented));
 const original=normalizeOps(runSync(p.buildingOpsSteps({kind:'command_hall'},BLUEPRINTS2.command_hall_v2,3,18,-555,67,hallGeo,newOps(),false)));
 const e={id:'building-d1-command_hall-1',kind:'building-command_hall',blueprint:'command_hall_v2',rot:3,bbox:hallGeo.rect,baseY:67,door:hallGeo.door,facing:hallGeo.facing};
 const record=(lots=original,dress=[])=>({lots:[e],dressing:dress.length?[{id:'later'}]:[],__testOps:{lots:[lots],dressing:[dress]}});
 const baseline=runSync(p.buildingInteriorLightRevisionSteps(record()))[0];
 const f=baseline.fixtures.find(f=>key(f.before)==='19,69,-544');assert.ok(f);
 const omitted=original.filter(o=>key(o)!==key(f.before));
 assert.equal(runSync(p.buildingInteriorLightRevisionSteps(record(omitted)))[0].fixtures.some(g=>key(g.before)===key(f.before)),false,'masked blueprint intent is not a saved fixture');
 for(const point of [f.before,f.after,f.anchor]) {
  const overwrite={...point,id:'minecraft:chest',kind:'dress'};
  const groups=runSync(p.buildingInteriorLightRevisionSteps(record(original,[overwrite])));
  assert.equal(groups[0].fixtures.some(g=>key(g.before)===key(f.before)),false,'later all-stage owner vetoes '+key(point));
 }
});

