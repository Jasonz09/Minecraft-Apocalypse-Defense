import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {mc,resetWorld,builder} from '../runtime/dev/lib/civharness.mjs';
import {newOps} from '../runtime/CivilizationApocalypse_BP/scripts/civ/regions.js';
import {savedDestinationsSteps} from '../runtime/CivilizationApocalypse_BP/scripts/people/destinations.js';
import {compileRepresentativeWorkAssignment,representativeAssignmentIsCurrent} from '../runtime/CivilizationApocalypse_BP/scripts/people/workAssignment.js';
const finish=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
// One actual pinned D1 rehydration, not a duplicate full planner suite.
const fixture=JSON.parse(readFileSync(new URL('../runtime/dev/fixtures/wall-leaf-closed-source-20261106.json',import.meta.url),'utf8'));
resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(fixture.properties))mc.props.set(k,v);
const kingdom=JSON.parse(fixture.properties['civ:kingdom']),actual=kingdom.districts.find(d=>d.id==='district-1');
const saved=finish(builder.loadSavedRunSteps(actual.civ,newOps(),1));assert.equal(saved.ok,true);assert.equal(saved.queue.state,'complete');
const compiled=finish(savedDestinationsSteps(saved.record,{index:1,checksum:actual.civ.checksum}));
const district={...actual,security:'secure',assault:0,civilians:100,builders:0,buildings:{...actual.buildings,farms:10,storehouses:2,barracks:1,walls:2}};
const homes=compiled.candidates.filter(c=>c.role==='home'),farms=compiled.candidates.filter(c=>c.role==='farm');
assert.ok(homes.length&&farms.length);
let supported;
for(const home of homes)for(const farm of farms){const a=home.frontageFeet,b=farm.frontageFeet;if(!a||!b)continue;const length=Math.abs(a.x-b.x)+Math.abs(a.z-b.z);if(a.y===b.y&&(a.x===b.x||a.z===b.z)&&length>=1&&length<=24)supported??={home,farm};}
test('actual saved building candidates either bind supported geometry or explicitly refuse it, never guess frontage',t=>{
 const pairs=supported?[supported]:[{home:homes[0],farm:farms[0]}];
 for(const {home,farm}of pairs){const request={district,groupId:'district-1:civ:0',homeBuilding:home.id,farmBuilding:farm.id};
  if(supported){const result=compileRepresentativeWorkAssignment(compiled,request);assert.equal(result.home.lotId,home.lotId);assert.equal(result.farm.lotId,farm.lotId);assert.deepEqual(result.home.feet,home.frontageFeet);assert.equal(result.checksum,'07515fcb');assert.equal(representativeAssignmentIsCurrent(result,district),true);assert.ok(Object.isFrozen(result.route.home));assert.equal(representativeAssignmentIsCurrent(structuredClone(result),district),false);assert.equal(representativeAssignmentIsCurrent(result,{...district,civilians:101}),false);assert.equal(representativeAssignmentIsCurrent(result,{...district,civ:{...district.civ,checksum:'deadbeef'}}),false);}
  else{assert.throws(()=>compileRepresentativeWorkAssignment(compiled,request),/frontage|corridor/);t.diagnostic('Pinned D1 has no supported home/farm pair for this primitive; no positive runtime-binding/route claim.');}
 }
});
test('actual saved roles cannot be swapped or replaced with legacy symbolic IDs',()=>{for(const [homeBuilding,farmBuilding]of [[farms[0].id,homes[0].id],['district-1/home-01','district-1/farm-01']])assert.throws(()=>compileRepresentativeWorkAssignment(compiled,{district,groupId:'district-1:civ:0',homeBuilding,farmBuilding}));});
test('actual compiler token becomes stale when original saved building metadata changes',()=>{const e=saved.record.lots.find(e=>e.id===homes[0].id),old=e.facing;e.facing='changed';try{assert.throws(()=>compileRepresentativeWorkAssignment(compiled,{district,groupId:'district-1:civ:0',homeBuilding:homes[0].id,farmBuilding:farms[0].id}),/provenance/);}finally{e.facing=old;}});
