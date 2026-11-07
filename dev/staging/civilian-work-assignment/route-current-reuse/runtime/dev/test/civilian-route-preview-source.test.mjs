import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {mc,resetWorld,builder,propsSnapshot} from '../lib/civharness.mjs';
import {newOps} from '../../CivilizationApocalypse_BP/scripts/civ/regions.js';
import {savedDestinationsSteps} from '../../CivilizationApocalypse_BP/scripts/people/destinations.js';
import {compileWorkRouteEndpoints,collectWorkRoadHintsSteps,previewLoadedWorkRouteSteps} from '../../CivilizationApocalypse_BP/scripts/people/workRoutePreview.js';
const run=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
test('actual pinned selected D1 source verifies both exact saved endpoints/hints without neighboring rehydration or native route claim',()=>{
 const closed=JSON.parse(readFileSync(new URL('../fixtures/wall-leaf-closed-source-20261106.json',import.meta.url),'utf8'));
 resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);const before=propsSnapshot();
 const kingdom=JSON.parse(closed.properties['civ:kingdom']),civ=kingdom.districts.find(d=>d.id==='district-1').civ,masterHash=JSON.parse(closed.properties['civ:plan:meta']).hash;
 const saved=run(builder.loadSavedRunSteps(civ,newOps(),1));assert.equal(saved.ok,true);assert.equal(saved.queue.state,'complete');assert.equal(saved.record.checksum,'07515fcb');
 const compiled=run(savedDestinationsSteps(saved.record,{index:1,checksum:civ.checksum}));
 const home=compiled.candidates.find(c=>c.role==='home'&&c.frontageFeet?.x===-60&&c.frontageFeet?.z===-631),farm=compiled.candidates.find(c=>c.role==='farm'&&c.frontageFeet?.x===-176&&c.frontageFeet?.z===-605);assert.ok(home&&farm);
 const token=compileWorkRouteEndpoints(compiled,{index:1,checksum:civ.checksum,masterHash,homeBuilding:home.id,farmBuilding:farm.id});
 assert.deepEqual(token.home.feet,{x:-60,y:67,z:-631});assert.deepEqual(token.farm.feet,{x:-176,y:76,z:-605});assert.equal(token.masterHash,'9e5e307e');
 const hints=run(collectWorkRoadHintsSteps(saved.record,token));assert.ok(hints.includes('-60,-631')&&hints.includes('-176,-605'));assert.ok(hints.length<=8192);
 assert.deepEqual(propsSnapshot(),before);let reads=0;assert.throws(()=>previewLoadedWorkRouteSteps(structuredClone(token),{read(){reads++;},current:()=>true}).next(),/private/);assert.equal(reads,0);
 // This verifies saved provenance/hints only. Actual loaded D1 path is a later
 // native gate; the separately retained saved-road disconnection is not changed.
});
