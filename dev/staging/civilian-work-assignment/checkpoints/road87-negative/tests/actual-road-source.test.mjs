import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {mc,resetWorld,builder,propsSnapshot} from '../runtime/dev/lib/civharness.mjs';
import {newOps} from '../runtime/CivilizationApocalypse_BP/scripts/civ/regions.js';
import {savedDestinationsSteps} from '../runtime/CivilizationApocalypse_BP/scripts/people/destinations.js';
import {beginSavedRoadRouteSteps,finishSavedRoadRouteSteps,abortSavedRoadRoute} from '../runtime/CivilizationApocalypse_BP/scripts/people/workRoadRoute.js';
const run=g=>{let yields=0;for(;;){const n=g.next();if(n.done)return{value:n.value,yields};yields++;}};
test('ACTUAL pinned D1 home/farm road graph must provide bounded saved-source path, otherwise this positive gate FAILS',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../runtime/dev/fixtures/wall-leaf-closed-source-20261106.json',import.meta.url),'utf8'));
 resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(fixture.properties))mc.props.set(k,v);
 const before=propsSnapshot(),kingdom=JSON.parse(fixture.properties['civ:kingdom']),masterHash=JSON.parse(fixture.properties['civ:plan:meta']).hash;
 const sources=[{index:1,checksum:kingdom.districts.find(d=>d.id==='district-1').civ.checksum}];
 const selected=kingdom.districts.find(d=>d.id==='district-1');let saved=run(builder.loadSavedRunSteps(selected.civ,newOps(),1)).value;
 assert.equal(saved.ok,true);assert.equal(saved.queue.state,'complete');let compiled=run(savedDestinationsSteps(saved.record,{index:1,checksum:selected.civ.checksum})).value;
 const home=compiled.candidates.find(c=>c.role==='home'&&c.frontageFeet?.x===-60&&c.frontageFeet?.z===-631);
 const farm=compiled.candidates.find(c=>c.role==='farm'&&c.frontageFeet?.x===-176&&c.frontageFeet?.z===-605);
 assert.ok(home,'exact requested saved home frontage exists');assert.ok(farm,'exact requested saved farm frontage exists');
 const endpoints={home:home.frontageFeet,farm:farm.frontageFeet};
 let token;const evidence={scope:'OFFLINE planned road connectivity against actual verified pinned selected source; NOT native loading/body collision/movement/physics/work proof',selectedChecksum:selected.civ.checksum,masterHash,endpoints,sources,sourceOrder:[1],retention:'Only selected completed source loaded; no neighbor rehydration. Compact selected graph summary only; no site record stored in result'};
 const artifact=new URL('../../../../dist/civilian-work-road-actual-D1-20261106.json',import.meta.url);
 try{
  token=run(beginSavedRoadRouteSteps(saved.record,compiled,{masterHash,sources,proof:{civ:selected.civ,queue:saved.queue,masterHash},homeBuilding:home.id,farmBuilding:farm.id})).value;
  saved=null;compiled=null;
  const {value:route,yields}=run(finishSavedRoadRouteSteps(token));token=undefined;
  evidence.state='PLANNED_CONNECTIVITY_PASS';evidence.stats=route.stats;evidence.finishYields=yields;evidence.waypoints=route.waypoints;evidence.edges=route.edges;
  assert.ok(route.stats.pathEdges>24&&route.stats.pathEdges<=256);assert.equal(route.waypoints[0].x,home.frontageFeet.x+0.5);assert.equal(route.waypoints.at(-1).x,farm.frontageFeet.x+0.5);assert.equal(route.verticalMovementPermission,false);assert.equal(route.movementPermission,false);
 }catch(error){evidence.state='PLANNED_CONNECTIVITY_FAIL';evidence.reason=String(error);evidence.diagnostics=error.routeDiagnostics;throw error;}
 finally{if(token)abortSavedRoadRoute(token);assert.deepEqual(propsSnapshot(),before,'all original properties/queues remain byte-identical');evidence.propertiesUnchanged=true;writeFileSync(artifact,JSON.stringify(evidence,null,2)+'\n');}
});
