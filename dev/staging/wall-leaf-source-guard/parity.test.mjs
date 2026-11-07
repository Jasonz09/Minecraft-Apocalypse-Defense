import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {frozen,optimized,state} from './variants.mjs';
const create=[frozen.createWallLeafSourceGuard,optimized.createWallLeafSourceGuard];
function compare(change,expected){const outcomes=[];for(const factory of create){const f=state(),g=factory(f.world,f.readKingdom,f.cancel);f.reset();change(f);const result=g.current();outcomes.push({result,calls:[...f.calls]});assert.equal(result,expected);}assert.equal(outcomes[1].result,outcomes[0].result);assert.ok(outcomes[1].calls.length<=outcomes[0].calls.length,'no increased API calls');if(expected)assert.deepEqual(outcomes[1].calls,outcomes[0].calls);}
test('unchanged raw/key/protection snapshots and ignored resource/hour/unrelated-key changes retain exact API parity',()=>{
 for(const change of [()=>{},f=>{f.kingdom.hour++;f.kingdom.resources.food++;},f=>f.props.set('unrelated:metadata','changed'),f=>{f.flags.idsOverride=[...f.props.keys()].reverse();},f=>{f.kingdom.districts=[...f.kingdom.districts].reverse();}])compare(change,true);
});
test('raw mutation, replacementtype, key addition/deletion/rename and changed oversize text all refuse identically',()=>{
 for(const change of [f=>f.props.set('civ:plan:meta','different'),f=>f.props.set('civ:plan:meta',42),f=>f.props.set('civ:plan:meta',undefined),f=>f.props.set('civ:plan:meta',{x:1,y:2,z:3}),f=>f.props.set('civ:plan:meta',new String('plan bytes')),f=>f.props.set('civ:plan:new','new'),f=>f.props.delete('civ:plan:meta'),f=>{f.props.delete('civ:plan:meta');f.props.set('civ:plan:other','plan bytes');},f=>f.props.set('civ:plan:meta','x'.repeat(1500001))])compare(change,false);
});
test('fresh protection identity/unknown records, census errors/types/quotas and read failures remain failclosed',()=>{
 for(const change of [f=>f.kingdom.districts[0].physical.origin.x++,f=>f.kingdom.districts[0].civ.checksum='87654321',f=>f.kingdom.districts[0].civ.status='building',f=>{f.kingdom=null;},f=>f.kingdom.districts.push(f.kingdom.districts[0]),f=>{f.flags.idsError=true;},f=>{f.flags.idsOverride=['civ:plan:meta',1];},f=>{f.flags.idsOverride=Array(4097).fill('unrelated:key');},f=>{f.flags.propertyError='civ:plan:meta';},f=>{f.flags.kingdomError=true;}])compare(change,false);
});
test('cancellation checks execute before every current call and make no API query after cancellation',()=>{
 for(const change of [f=>{f.cancelled=true;},f=>{f.flags.cancelError=true;}]){for(const factory of create){const f=state(),g=factory(f.world,f.readKingdom,f.cancel);f.reset();change(f);assert.equal(g.current(),false);assert.deepEqual(f.calls,[]);assert.throws(()=>g.assert(),/source\/master\/queue\/protection changed or cancellation/);assert.deepEqual(f.calls,[]);}}
});
test('initial sourcebytes/sourcekey/allkey quotas, UTF8 boundaries and unknown protection preserve constructor refusals',()=>{
 const cases=[f=>{f.props.clear();f.props.set('civ:plan:one','x'.repeat(1500001));},f=>{f.props.clear();f.props.set('civ:plan:one','😀'.repeat(375001));},f=>{for(let i=0;i<129;i++)f.props.set('civ:plan:'+i,'x');},f=>{f.flags.idsOverride=Array(4097).fill('unrelated:key');},f=>{f.kingdom=null;}];
 for(const change of cases){const errors=[];for(const factory of create){const f=state();change(f);try{factory(f.world,f.readKingdom,f.cancel);assert.fail('must refuse initial snapshot');}catch(e){errors.push(String(e));}}assert.equal(errors[1],errors[0]);}
 for(const factory of create){const f=state();f.props.clear();f.props.set('civ:plan:one','😀'.repeat(375000));const g=factory(f.world,f.readKingdom,f.cancel);assert.equal(g.current(),true);f.props.set('civ:plan:one','😀'.repeat(374999)+'xxxx');assert.equal(g.current(),false,'same UTF8 size does not authorize changed raw');}
});
test('first/last source read faults cannot turn any changed snapshot into permission and all initial API calls match',()=>{
 const initial=[];for(const factory of create){const f=state();factory(f.world,f.readKingdom,f.cancel);initial.push(f.calls);}assert.deepEqual(initial[1],initial[0]);
 for(const change of [f=>{f.flags.idsOverride=[];},f=>{f.flags.idsOverride={not:'array'};},f=>{f.kingdom.districts[0].physical.origin.y++;},f=>{f.kingdom.districts[0].civ={dimension:'minecraft:overworld',checksum:'12345678',status:'complete'};}])compare(change,false);
});
test('only intended source guard function body changed; every controller/write/last-read barrier byte remains unchanged',()=>{
 const old=readFileSync(new URL('./frozen-wallLeafRepair.js',import.meta.url),'utf8'),next=readFileSync(new URL('./proposed/CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js',import.meta.url),'utf8');const start='export function createWallLeafSourceGuard(',end='/** @template T';
 const without=s=>s.slice(0,s.indexOf(start))+s.slice(s.indexOf(end,s.indexOf(start)));assert.equal(without(next),without(old));assert.equal((next.match(/utf8Length\(v\)/g)??[]).length,1,'initialquota computation remains once');
 const pin=JSON.parse(readFileSync(new URL('./source-pin.json',import.meta.url),'utf8'));assert.equal(createHash('sha256').update(readFileSync(new URL('./frozen-wallLeafRepair.js',import.meta.url))).digest('hex').toUpperCase(),pin.sha256);
});
