import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {representativeOccupation,compileRepresentativeWorkAssignment,representativeAssignmentIsCurrent} from '../runtime/CivilizationApocalypse_BP/scripts/people/workAssignment.js';
import {assignOccupations} from '../runtime/CivilizationApocalypse_BP/scripts/people/occupations.js';
function district(overrides={}){return{id:'district-1',security:'secure',civilians:100,builders:0,soldiers:30,buildings:{farms:10,storehouses:2,barracks:1,walls:2},civ:{status:'complete',stage:'complete',dimension:'minecraft:overworld',checksum:'1234abcd'},...overrides};}
for(const population of [1,2,3,10,17,30,63,100,200])test(`bounded group intervals match ACTUAL occupation slots for population${population}`,()=>{
 const d=district({civilians:population}),actual=assignOccupations(d).roster;
 for(let index=0;index<Math.ceil(population/10);index++){
  const roles=actual.slice(index*10,(index+1)*10).map(r=>r.role),group=`district-1:civ:${index}`;
  if(roles.length&&roles.every(r=>r==='farmer')){const result=representativeOccupation(d,group);assert.equal(result.firstSlot,index*10);assert.equal(result.lastSlotExclusive,Math.min(population,(index+1)*10));assert.equal(result.representedHeadcount,roles.length);}
  else assert.throws(()=>representativeOccupation(d,group),/mixed-role|not farmer/);
 }
});
test('partial homogeneous group preserves exact count3 instead of allocating10 workers',()=>{const r=representativeOccupation(district({civilians:3}),'district-1:civ:0');assert.equal(r.representedHeadcount,3);assert.equal(r.groupSize,10);});
for(const group of ['district-1:sol:0','district-1:civ:01','district-2:civ:0','district-1:civ:99','district-1:civ:9007199254740992'])test(`foreign/stale/unsafe group${group} refuses`,()=>assert.throws(()=>representativeOccupation(district(),group)));
for(const count of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])test(`invalid civilian count${String(count)} refuses without mutation`,()=>{const d=district({civilians:count}),before=structuredClone(d);assert.throws(()=>representativeOccupation(d,'district-1:civ:0'));assert.deepEqual(d,before);});
for(const security of ['contested','breached','isolated','lost','unknown'])test(`security${security} holds assignment`,()=>assert.throws(()=>representativeOccupation(district({security}),'district-1:civ:0')));
test('builder interval and mixed farmer boundary never promote entire group',()=>{const d=district({builders:3});assert.throws(()=>representativeOccupation(d,'district-1:civ:0'),/mixed/);assert.equal(representativeOccupation(d,'district-1:civ:1').role,'farmer');assert.throws(()=>representativeOccupation(d,'district-1:civ:3'),/mixed/);});
test('actual positive numeric assault prevents work independently of nominal security',()=>{for(const assault of [1,25])assert.throws(()=>representativeOccupation(district({assault}),'district-1:civ:0'),/threat/);});
test('forged/copied destination candidates never gain saved-source provenance',()=>{const fake={index:1,checksum:'1234abcd',candidates:[{id:'building-home',role:'home'},{id:'building-farm',role:'farm'}]};const before=structuredClone(fake);assert.throws(()=>compileRepresentativeWorkAssignment(fake,{district:district(),groupId:'district-1:civ:0',homeBuilding:'building-home',farmBuilding:'building-farm'}),/provenance/);assert.deepEqual(fake,before);});
test('plain assignment clone cannot gain a current token',()=>assert.equal(representativeAssignmentIsCurrent({groupId:'district-1:civ:0',checksum:'1234abcd'},district()),false));
test('staged driver has one existing timer contract and no new population/property authority',()=>{
 const source=readFileSync(new URL('../proposed/CivilizationApocalypse_BP/scripts/integration/civilianTravel.js',import.meta.url),'utf8');
 for(const banned of ['spawnEntity(','teleport(','setDynamicProperty(','runInterval(','runTimeout('])assert.equal(source.includes(banned),false,banned);
 assert.match(source,/typeof deps\.workAssignmentCurrent===\"function\"/);assert.match(source,/No unique admitted civilian actor/);assert.match(source,/Actor must already stand at verified saved home frontage/);assert.match(source,/reads>=TRAVEL_LIMITS\.maxReads/);
});
