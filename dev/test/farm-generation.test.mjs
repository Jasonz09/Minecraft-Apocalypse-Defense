import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {BLUEPRINTS2,rotatedSize} from '../../CivilizationApocalypse_BP/scripts/structures/blueprints2.js';
import {normalizeOps} from '../../CivilizationApocalypse_BP/scripts/civ/opnorm.js';
import {newOps,runSync} from '../../CivilizationApocalypse_BP/scripts/civ/regions.js';
import {makeProfile,planDeck,planDeckGenerationSteps} from '../../CivilizationApocalypse_BP/scripts/civ/foundations.js';
import {farmFrontageDraft,spacedWaterDeck,proveDeckSupport} from '../prototypes/farm-aesthetics/farm-aesthetics.mjs';
import {makeField} from '../lib/fakefield.mjs';
import {planCivilizationDetailed} from '../../CivilizationApocalypse_BP/scripts/civ/masterplan.js';
const url=new URL('../../CivilizationApocalypse_BP/scripts/civ/districtplan.js',import.meta.url);
const source=readFileSync(url,'utf8').replace(/from\s+"(\.[^"]+)"/g,(_,spec)=>'from '+JSON.stringify(new URL(spec,url).href))+'\nexport {buildingOpsSteps,persistedOptions};\n//# sourceURL=farm-generation-planner-under-test.js';
const D=await import('data:text/javascript,'+encodeURIComponent(source));
const farms=['farm_allot_v2','farm_kitchen_v2','farm_veg_v2','farm_wheat_v2','farm_irrigated_v2'];
const key=o=>`${o.x},${o.y},${o.z}`;
function building(id,rot,frontage=false){const bp=BLUEPRINTS2[id],{w,d}=rotatedSize(bp,rot),geo={rect:{x0:101,z0:-201,x1:100+w,z1:-202+d},door:{x:101,z:-201},facing:'south'},meter=newOps();return{ops:normalizeOps(runSync(D.buildingOpsSteps({kind:id.startsWith('farm')?'farm_allot':'command_hall'},bp,rot,101,-201,63,geo,meter,true,true,frontage))),meter};}
function fixture(w=9,d=w,sample=()=>({g:46,water:62})){return{rect:{x0:0,z0:0,x1:w-1,z1:d-1},profile:makeProfile(-1,-1,w+2,d+2,sample),limits:{baseY:63,pillarEvery:3,maxDepth:64}};}
test('all five production crop farms at every rotation exactly implement supported frontage draft without changing non-light cells',()=>{
 for(const id of farms)for(let rot=0;rot<4;rot++){
  const old=building(id,rot),after=building(id,rot,true),draft=farmFrontageDraft({blueprintId:id,rotation:rot,x:101,z:-201,baseY:63},{farmLighting:'frontage-v1'});
  assert.deepEqual(after.ops.filter(o=>o.id==='minecraft:lantern'),normalizeOps(draft.add),id+' '+rot);
  assert.deepEqual(after.ops.filter(o=>o.id!=='minecraft:lantern'),old.ops.filter(o=>o.id!=='minecraft:lantern'));
  assert.ok(after.meter.maxRun<=24000);
  const at=new Map(after.ops.map(o=>[key(o),o]));
  for(const lamp of draft.add)assert.ok(at.get(key({...lamp,y:lamp.y-1})).id.endsWith('_fence'));
 }
});
test('farm version persistence is explicit, legacy options have no added keys, and unknown input/saved versions refuse',()=>{
 const baseline=D.persistedOptions({seed:21}),opts={seed:21,farmLighting:'frontage-v1',waterPiles:'spaced-v1'};
 assert.equal(Object.hasOwn(baseline,'farmLighting'),false);assert.equal(Object.hasOwn(baseline,'waterPiles'),false);
 assert.deepEqual(D.persistedOptions({seed:21,farmLighting:undefined,waterPiles:undefined}),baseline);
 assert.deepEqual(D.siteOptionsOf({options:D.persistedOptions(opts)}),opts);
 for(const patch of [{farmLighting:'future'},{waterPiles:'future'},{farmLighting:null},{waterPiles:1}]){
  assert.throws(()=>D.persistedOptions(patch),/unknown/);assert.throws(()=>D.siteOptionsOf({options:patch}),/unknown/);
  assert.equal(runSync(D.planDistrictSiteSteps(null,1,null,patch)).ok,false);
 }
});
test('production water farm columns match independently reviewed prototype and preserve natural bearing/corners at all rotations',()=>{
 for(const id of farms)for(let rot=0;rot<4;rot++){
  const {w,d}=rotatedSize(BLUEPRINTS2[id],rot),f=fixture(w,d),meter=newOps();
  const actual=runSync(planDeckGenerationSteps(f.profile,f.rect,{...f.limits,waterPiles:'spaced-v1'},meter));
  assert.equal(actual.ok,true,actual.problems.join(';'));
  const expected=spacedWaterDeck(f.profile,f.rect,f.limits,{waterPiles:'spaced-v1'});
  assert.deepEqual(actual.ops,expected.ops);assert.deepEqual(actual.counts,expected.counts);
  assert.equal(proveDeckSupport(f.profile,f.rect,actual).ok,true);assert.ok(meter.maxRun<=24000);assert.ok(meter.yields>0);
 }
 for(const [w,count]of [[9,16],[19,49]]){const f=fixture(w),r=planDeck(f.profile,f.rect,{...f.limits,waterPiles:'spaced-v1'});assert.equal(new Set(r.ops.filter(o=>o.kind==='pillar').map(o=>[o.x,o.z].join(','))).size,count);}
});
test('mixed shore and land masonry are unchanged; sparse deck refuses unsafe footprint/depth/hollow/water/cut inputs atomically',()=>{
 for(const sample of [()=>({g:46}),(x)=>x<=3?{g:46}:{g:46,water:62}]){
  const f=fixture(9,9,sample),old=planDeck(f.profile,f.rect,f.limits),actual=planDeck(f.profile,f.rect,{...f.limits,waterPiles:'spaced-v1'});
  assert.equal(actual.ok,true);assert.deepEqual(actual.ops.filter(o=>o.id!=='minecraft:oak_log'),old.ops.filter(o=>o.id!=='minecraft:oak_log'));
 }
 const f=fixture();
 for(const limits of [{waterPiles:'future'},{maxDepth:4},{maxDepth:65},{maxDepth:Infinity},{baseY:61},{baseY:63.5},{pillarEvery:4},{maxCut:17}]){const r=planDeck(f.profile,f.rect,{...f.limits,waterPiles:'spaced-v1',...limits});assert.equal(r.ok,false);assert.deepEqual(r.ops,[]);}
 for(const f of [fixture(26),fixture(9,9,()=>({g:46,water:62,hollow:true})),fixture(9,9,()=>({g:80,water:62}))]){const r=planDeck(f.profile,f.rect,{...f.limits,waterPiles:'spaced-v1'});assert.equal(r.ok,false);assert.deepEqual(r.ops,[]);}
});
test('geometric migration draft refuses overwritten source, occupied frontage and changed support while retaining explicit fixture states',()=>{
 const bp=BLUEPRINTS2.farm_allot_v2,original=building('farm_allot_v2',0).ops;
 const draft=runSync(D.farmFrontageFixturesSteps(bp,0,101,-201,63,original));assert.equal(draft.remove.length,4);
 const old=draft.remove[0];
 assert.throws(()=>runSync(D.farmFrontageFixturesSteps(bp,0,101,-201,63,[...original,{...old,id:'minecraft:air'}])),/overwritten/);
 assert.throws(()=>runSync(D.farmFrontageFixturesSteps(bp,0,101,-201,63,[...original,{...draft.add[0],id:'minecraft:chest'}])),/target/);
 assert.throws(()=>runSync(D.farmFrontageFixturesSteps(bp,0,101,-201,63,[...original,{...draft.anchors[0],id:'minecraft:air'}])),/target/);
 const states=runSync(D.farmFrontageFixturesSteps(bp,0,101,-201,63,original.map(o=>key(o)===key(old)?{...o,states:{hanging:true}}:o)));
 assert.equal(states.remove.find(o=>key(o)===key(old)).states.hanging,true);
});
test('spaced farms reject missing or out-of-world bearing and inconsistent water before producing any operation; legacy remains unchanged',()=>{
 for(const sample of [{g:-80,water:-61},{g:320},{g:undefined,water:62},{g:46,water:NaN},{g:46,water:320},{g:-64,water:-65},{g:46,water:46},{g:46,water:45}]){
  const f=fixture(9,9,()=>sample),r=planDeck(f.profile,f.rect,{...f.limits,waterPiles:'spaced-v1'});
  assert.equal(r.ok,false,JSON.stringify(sample));assert.deepEqual(r.ops,[]);assert.match(r.problems.join(';'),/bearing|height/);
 }
 const f=fixture(9,9,()=>({g:-80,water:-61}));
 const legacy=planDeck(f.profile,f.rect,{...f.limits,baseY:-60});
 assert.equal(legacy.ok,true);assert.equal(Math.min(...legacy.ops.filter(o=>o.kind==='pillar').map(o=>o.y)),-79,'legacy output is deliberately unchanged');
 const edge=fixture(9,9,()=>({g:-64,water:-61}));
 const valid=planDeck(edge.profile,edge.rect,{...edge.limits,baseY:-60,waterPiles:'spaced-v1'});
 assert.equal(valid.ok,true);assert.equal(Math.min(...valid.ops.filter(o=>o.kind==='pillar').map(o=>o.y)),-63);
});
test('full water site persists and rehydrates every stage identically for legacy and both explicit versions; non-farm elements retain original operations',()=>{
 const planned=planCivilizationDetailed(makeField(21,{relief:18,hills:60}),{seed:21});assert.equal(planned.ok,true);
 const plan=planned.plan,field={at:()=>({g:46,k:'water',surface:62,tree:false})},base={seed:21,lighting:'natural',policy:{allowWater:true,adaptive:true,maxRelief:8}};
 const ground=D.exportSiteInputs(plan,3,field);
 let legacy,legacyMax;
 for(const versions of [{},{farmLighting:'frontage-v1',waterPiles:'spaced-v1'}]){
  const meter=newOps(),made=runSync(D.planDistrictSiteSteps(plan,3,field,{...base,...versions,ops:meter}));assert.equal(made.ok,true,made.problems.join(';'));
  const r=made.record;assert.ok(r.lots.some(e=>farms.includes(e.blueprint)),'fixture must contain crop farms');
  const saved=JSON.parse(JSON.stringify({site:r,ground,siteOptions:D.siteOptionsOf(r),siteChecksum:r.checksum}));
  const again=D.rehydrateSite(plan,3,saved.ground,{...saved.siteOptions,expectChecksum:saved.siteChecksum});assert.equal(again.ok,true,again.problems.join(';'));
  assert.deepEqual(again.record,saved.site);
  for(const stage of D.SITE_STAGES)for(let i=0;i<r[stage].length;i++)assert.deepEqual(D.siteOpsFor(again.record,stage,i),D.siteOpsFor(r,stage,i));
  if(!legacy){legacy=r;legacyMax=meter.maxRun;continue;}
  assert.ok(meter.maxRun<=legacyMax,`farm options increase existing site max run ${legacyMax} to ${meter.maxRun}`);
  assert.notEqual(r.checksum,legacy.checksum);
  const farmRects=r.lots.filter(e=>farms.includes(e.blueprint)).map(e=>e.bbox);
  for(let i=0;i<r.dressing.length;i++) {
   const a=new Map(D.siteOpsFor(r,'dressing',i).map(o=>[key(o),o])),b=new Map(D.siteOpsFor(legacy,'dressing',i).map(o=>[key(o),o]));
   for(const k of new Set([...a.keys(),...b.keys()]))if(JSON.stringify(a.get(k))!==JSON.stringify(b.get(k))){const o=a.get(k)??b.get(k);assert.ok(farmRects.some(rect=>o.x>=rect.x0&&o.x<=rect.x1&&o.z>=rect.z0&&o.z<=rect.z1),'dressing masking may change only inside crop farm footprints');}
  }
  for(const stage of D.SITE_STAGES)for(let i=0;i<r[stage].length;i++)if(stage!=='pads'&&stage!=='dressing'&&!(stage==='lots'&&farms.includes(r[stage][i].blueprint)))assert.deepEqual(D.siteOpsFor(r,stage,i),D.siteOpsFor(legacy,stage,i),stage+' '+i);
 }
});
