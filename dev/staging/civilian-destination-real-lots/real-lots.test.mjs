import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mc,resetWorld,builder,propsSnapshot} from '../../lib/civharness.mjs';
import {newOps} from '../../../CivilizationApocalypse_BP/scripts/civ/regions.js';
import {savedDestinationsSteps as installedCompiler} from '../../../CivilizationApocalypse_BP/scripts/people/destinations.js';
import {savedDestinationsSteps,formatDestinations} from './scripts/people/destinations.js';
import {createCivilianDestinations} from './scripts/integration/civilianDestinations.js';
const finish=g=>{for(;;){const step=g.next();if(step.done)return step.value;}};
const bytes=readFileSync(new URL('../../fixtures/wall-leaf-closed-source-20261106.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex').toUpperCase(),'E08AD7B53DFABA1C6C551BF519471EDB527FF0ED4CB20BDBB523B01D9019B5F4');
const pinned=JSON.parse(bytes);assert.equal(pinned.sequence,274030);assert.equal(pinned.backupLevelSha256,'0109A6B32F47536BFB53261DA771ECE8F62E47BF1ABAF1DAFB55AF43E71C1018');
resetWorld(1);mc.props.clear();for(const [k,v]of Object.entries(pinned.properties))mc.props.set(k,v);
const propertiesBefore=propsSnapshot(),writesBefore=mc.propWrites,kingdom=JSON.parse(mc.props.get('civ:kingdom')),civ=kingdom.districts.find(d=>d.id==='district-1').civ;
const saved=finish(builder.loadSavedRunSteps(civ,newOps(),1));assert.equal(saved.ok,true,JSON.stringify(saved.reasons));assert.equal(saved.queue.state,'complete');assert.equal(saved.record.checksum,'07515fcb');
assert.deepEqual(propsSnapshot(),propertiesBefore);assert.equal(mc.propWrites,writesBefore);
const record=saved.record,expected={index:1,checksum:'07515fcb'},pad=record.lots.find(e=>e.id==='pad-d1-farm_kitchen-1'),farm=record.lots.find(e=>e.id==='building-d1-farm_kitchen-1');
test('real frozen D1 authenticates complete saved source and has farm pad/building sharing one lot',()=>{
 assert.ok(pad);assert.ok(farm);assert.equal(pad.kind,'pad-farm_kitchen');assert.equal(pad.blueprint,farm.blueprint);assert.equal(pad.lot,farm.lot);assert.equal(pad.door,undefined);assert.equal(pad.rot,undefined);
 assert.deepEqual(propsSnapshot(),propertiesBefore);assert.equal(mc.propWrites,writesBefore);
});
test('unchanged installed compiler reproduces exact native refusal on real D1',()=>{
 assert.throws(()=>finish(installedCompiler(record,expected)),/invalid or duplicate saved destination lot metadata/);
});
let corrected;
test('staged compiler indexes actual farm once and never mistakes its foundation for an entrance',()=>{
 corrected=finish(savedDestinationsSteps(record,expected));assert.ok(corrected.candidates.length>0);assert.equal(corrected.candidates.filter(c=>c.lotId===farm.lot).length,1);
 const candidate=corrected.candidates.find(c=>c.id===farm.id);assert.ok(candidate);assert.equal(candidate.role,'farm');assert.equal(candidate.checksum,'07515fcb');assert.deepEqual(candidate.door,{...farm.door,y:farm.baseY+1});
 assert.ok(corrected.candidates.every(c=>c.id.startsWith('building-')));assert.ok(!corrected.candidates.some(c=>c.id===pad.id));assert.match(formatDestinations(corrected,1).join('\n'),/Native loading\/clearance UNVERIFIED/);
 assert.equal(corrected.nativeReads,0);assert.equal(corrected.worldWrites,0);assert.deepEqual(propsSnapshot(),propertiesBefore);
});
test('real actual building missing entrance metadata still refuses rather than being silently skipped',()=>{
 const before=farm.door;delete farm.door;try{assert.throws(()=>finish(savedDestinationsSteps(record,expected)),/invalid or duplicate/);}finally{farm.door=before;}
});
test('duplicated actual farm lot still refuses even though pads no longer enter candidate set',()=>{
 record.lots.push({...farm,id:'building-real-farm-duplicate'});try{assert.throws(()=>finish(savedDestinationsSteps(record,expected)),/invalid or duplicate/);}finally{record.lots.pop();}
});
test('actual async preview controller with staged compiler now returns real saved D1 candidates and releases job',async()=>{
 let finished=0;const player={typeId:'minecraft:player',isValid:true,dimension:{id:'minecraft:overworld',getBlock(){assert.fail('preview cannot read native blocks');}}};
 const driver=createCivilianDestinations({readKingdom:()=>kingdom,loadSaved:function*(){return saved;},runJob:async(token,g)=>finish(g),reserveJob:()=>({cancelled:false}),finishJob:()=>{finished++;}});
 const lines=await driver.command('district=1 page=1',{sourceEntity:player});assert.match(lines[0],/Saved civilian destinations: district1; checksum07515fcb/);assert.equal(finished,1);assert.deepEqual(propsSnapshot(),propertiesBefore);assert.equal(mc.propWrites,writesBefore);
});
