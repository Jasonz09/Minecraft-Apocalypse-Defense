import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
import {createCreationBindings,registerCreationDeaths,PREFIX,META,MAX_RECORDS,MAX_BYTES} from './bindings.mjs';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const root=new URL('../../../',import.meta.url),actual=new URL('CivilizationApocalypse_BP/scripts/integration/popSync.js',root);
let source=readFileSync(new URL('./proposed-popSync.js',import.meta.url),'utf8').replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${(s.startsWith('.')?new URL(s,actual).href:s)}${q}`);
const {createPopSync}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {createPopWorld}=await import(new URL('dev/lib/poptharness.mjs',root)),{createInitialKingdom}=await import(new URL('CivilizationApocalypse_BP/scripts/kingdom/state.js',root));
const {decodeMilitarySelection}=await import(new URL('CivilizationApocalypse_BP/scripts/population/militarySelection.js',root));
const GROUP='district-1:civ:0',TAG='civpop:v1:'+GROUP;
function fixture(mode='fresh',military=false){
 const pop=createPopWorld(),k=createInitialKingdom();pop.world.getDynamicPropertyIds=()=>[...pop.state.props.keys()];for(const d of k.districts){d.civilians=d.id==='district-1'?10:0;d.soldiers=military&&d.id==='district-1'?5:0;d.garrison={front:d.soldiers,reserve:0};}pop.setKingdom(k);pop.loadArea(-64,-64,96,96);pop.setPlayers([{name:'player',x:0,y:70,z:0}]);
 const makeStore=()=>createCreationBindings(pop.world,{verifyFreshWorld:()=>({verified:true,fixtureId:'known-empty-fixture',dimension:'minecraft:overworld',ownerHistory:'never-started'})});let store=makeStore();store.initialize({mode,epoch:'epoch-one',fixture:'known-empty-fixture'});
 const sync=()=>createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>({'district-1':{x:0,y:70,z:0}}),enabled:true,creationBindings:store,...(military?{readMilitarySelection:()=>decodeMilitarySelection(JSON.stringify({v:1,trialId:'birth-probe',fixtureId:'known-empty-fixture',groupId:'district-1:sol:0',class:'swordsman',typeId:'civ_trial:swordsman',dimension:'minecraft:overworld'}))}:{})});
 const run=t=>sync().reconcileOnce(t);const alive=()=>[...pop.state.entities.values()].filter(e=>e.alive);const born=()=>alive().filter(e=>e.tags.has(TAG));
 const snapshot=e=>({groupId:GROUP,id:e.id,typeId:e.typeId,tags:[...e.tags]});return{pop,k,run,alive,born,snapshot,get store(){return store;},rejoin(){pop.restart();store=makeStore();},spawn(){const result=run(0);assert.equal(result.refused,null);assert.equal(born().length,1);return born()[0];}};
}
test('fresh epoch needs verified provenance; corrupt/future epoch/record preserved, records bounded',()=>{
 const f=fixture(),plain=createCreationBindings({getDynamicPropertyIds:()=>[],getDynamicProperty:()=>undefined,setDynamicProperty(){throw Error('write forbidden');}});assert.throws(()=>plain.initialize({mode:'fresh',epoch:'new',fixture:'unverified'}),/provenance/);assert.equal(MAX_BYTES,1024);assert.equal(MAX_RECORDS,2048);
 f.pop.setRawProperty(META,JSON.stringify({v:2}));assert.ok(f.run(1).refused);
});
test('clean deferred never-created intent retries withoutpending record or freezing clean bornpopulation',()=>{
 const f=fixture(),get=f.pop.dimension.getBlock;f.pop.dimension.getBlock=p=>p.y>=70?{typeId:'minecraft:stone',isValid:true}:get(p);const r=f.run(0);assert.equal(r.refused,null);assert.equal(f.alive().length,0);assert.equal(f.store.inspect(GROUP),null);assert.equal(f.store.canBirth(GROUP,'minecraft:villager_v2').allowed,true);f.pop.dimension.getBlock=get;assert.equal(f.run(1000).refused,null);assert.equal(f.born().length,1);
});
test('fix repro: hidden livingactor never getsreplacement; reloaded/rejoined sameID remains soleborn',()=>{
 const f=fixture(),old=f.spawn();old.x=80;old.z=0;f.pop.unloadArea(80,0,95,15);assert.equal(f.pop.dimension.getEntities({tags:[TAG]}).length,0);f.rejoin();const r=f.run(1000);assert.equal(r.refused,null);assert.equal(f.born().length,1);assert.ok(r.skipped.some(x=>x.reason.includes('existing alive binding')));f.pop.loadArea(80,0,95,15);assert.equal(f.run(2000).refused,null);assert.equal(f.born()[0].id,old.id);
});
test('explicit successful ownerLODremove retires binding; laternear promotion usesnewgeneration, notaggregatecasualty',()=>{
 const f=fixture(),old=f.spawn(),kingdom=f.pop.world.getDynamicProperty('civ:kingdom');f.pop.setPlayers([{name:'far',x:2000,y:70,z:2000}]);assert.equal(f.run(1000).refused,null);assert.equal(f.alive().length,0);assert.equal(f.store.inspect(GROUP).terminal,'owner-remove');f.pop.setPlayers([{name:'near',x:0,y:70,z:0}]);assert.equal(f.run(2000).refused,null);assert.equal(f.born().length,1);assert.notEqual(f.born()[0].id,old.id);assert.equal(f.store.inspect(GROUP).generation,2);assert.equal(f.pop.world.getDynamicProperty('civ:kingdom'),kingdom);
});
test('freshstrict entityDie retires exactboundgeneration; stale/duplicatedeath no doubleauthority; unload notsubscribed',()=>{
 const f=fixture(),old=f.spawn(),snap=f.snapshot(old),events=[];f.pop.world.afterEvents={entityDie:{subscribe(fn,filter){events.push({fn,filter});}}};assert.equal(registerCreationDeaths(f.pop.world,f.store),true);assert.equal(registerCreationDeaths(f.pop.world,f.store),false);assert.equal(events.length,1);old.alive=false;const event={deadEntity:{id:old.id,typeId:old.typeId,getTags:()=>snap.tags}};events[0].fn(event);assert.equal(f.store.inspect(GROUP).terminal,'death');events[0].fn(event);assert.equal(f.store.inspect(GROUP).generation,1);assert.equal(f.run(1000).refused,null);assert.equal(f.born().length,1);assert.equal(f.store.inspect(GROUP).generation,2);events[0].fn(event);assert.equal(f.store.inspect(GROUP).phase,'alive');assert.equal(f.born().length,1);
});
test('unreadable/degraded/stale death identity cannot authorize replacement; no missingactor inference',()=>{
 for(const change of[s=>s.tags=[],s=>s.typeId='minecraft:pig',s=>s.id='different']){const f=fixture(),old=f.spawn(),s=f.snapshot(old);change(s);assert.throws(()=>f.store.confirmDeath(s));assert.equal(f.store.inspect(GROUP).phase,'alive');}
});
test('every birth crash boundary preserves atmostONEentity; pendingunknown neverissues asecondone, recoverablependingadopts',()=>{
 for(let boundary=0;boundary<=7;boundary++){const f=fixture();f.pop.crashAfterMutations(boundary);try{f.run(0);}catch(_error){}f.rejoin();for(let n=1;n<=3;n++){try{f.run(n*1000);}catch(_error){}}assert.ok(f.alive().length<=1,'boundary'+boundary);assert.ok(f.pop.state.spawned.length<=1,'no duplicate after boundary'+boundary);}
});
test('tagfailure rollback requires positive exactnewborn removal; successful receipt permits freshretry',()=>{
 const f=fixture();f.pop.failNextTag();const r=f.run(0);assert.equal(f.alive().length,0);assert.equal(f.store.inspect(GROUP).terminal,'tag-rollback');assert.equal(f.run(1000).refused,null);assert.equal(f.born().length,1);assert.equal(f.store.inspect(GROUP).generation,2);
});
test('silent metadata savefailure beforeprepare or afterspawn neverauthorizes duplicate; cursorsavefailure doesnotlosebinding',()=>{
 for(const phase of['prepare','actor','alive','cursor']){const f=fixture(),set=f.pop.world.setDynamicProperty;let once=true;f.pop.world.setDynamicProperty=(k,v)=>{const r=typeof v==='string'&&k===PREFIX+GROUP?JSON.parse(v):null;if(once&&(phase==='prepare'&&r?.phase==='pending'&&r.actor===null||phase==='actor'&&r?.phase==='pending'&&r.actor!==null||phase==='alive'&&r?.phase==='alive'||phase==='cursor'&&k==='civ_pop')){once=false;return;}return set(k,v);};try{f.run(0);}catch(_error){}f.pop.world.setDynamicProperty=set;f.rejoin();for(let n=1;n<4;n++){try{f.run(n*1000);}catch(_error){}}assert.ok(f.alive().length<=1,phase);assert.ok(f.born().length<=1,phase);}
});
test('ownerremove success +terminalpersistfailure keepsremoving receipt; absentactor cannotrespawn',()=>{
 const f=fixture();f.spawn();const set=f.pop.world.setDynamicProperty;f.pop.world.setDynamicProperty=(k,v)=>{if(k===PREFIX+GROUP&&JSON.parse(v).phase==='retired')return;return set(k,v);};f.pop.setPlayers([{name:'far',x:2000,y:70,z:2000}]);f.run(1000);assert.equal(f.alive().length,0);f.pop.world.setDynamicProperty=set;f.rejoin();f.pop.setPlayers([{name:'near',x:0,y:70,z:0}]);f.run(2000);assert.equal(f.alive().length,0);assert.equal(f.store.inspect(GROUP).phase,'removing');
});
test('legacyunknown holds births; survivingduplicate actors notdeleted/retagged; uniquelegacyadoption grantsnorebirth',()=>{
 const f=fixture('legacy');assert.equal(f.run(0).refused,null);assert.equal(f.alive().length,0);f.pop.addEntity({id:'legacy1',typeId:'minecraft:villager_v2',x:4,y:70,z:4,tags:[TAG]});assert.equal(f.run(1000).refused,null);assert.equal(f.store.inspect(GROUP).phase,'legacy');const tags=f.pop.state.tagWrites.length,removes=f.pop.state.removals.length;f.pop.addEntity({id:'legacy2',typeId:'minecraft:villager_v2',x:5,y:70,z:4,tags:[TAG]});assert.match(f.run(2000).refused,/duplicate conflict/);assert.equal(f.pop.state.tagWrites.length,tags);assert.equal(f.pop.state.removals.length,removes);assert.equal(f.alive().length,2);
});
test('freshmode final tagquery failure and canonicalappearingduringprepare refuse birth, neverquietempty',()=>{
 for(const mode of['throw','appeared']){const f=fixture(),set=f.pop.world.setDynamicProperty;f.pop.world.setDynamicProperty=(k,v)=>{const result=set(k,v);if(k===PREFIX+GROUP&&JSON.parse(v).phase==='pending'&&JSON.parse(v).actor===null){if(mode==='throw'){const q=f.pop.dimension.getEntities;f.pop.dimension.getEntities=arg=>{if(arg.tags)throw Error('query failed');return q(arg);};}else f.pop.addEntity({id:'external',typeId:'minecraft:villager_v2',x:4,y:70,z:4,tags:[TAG]});}return result;};const r=f.run(0);assert.ok(r.refused);assert.equal(f.pop.state.spawned.length,0);assert.equal(f.store.inspect(GROUP).phase,'pending');}
});

test('existing selected-swordsman resolver and freshprebirth guard coexist with bindingtags without rejecting ownnewborn',()=>{const f=fixture('fresh',true);const r=f.run(0);assert.equal(r.refused,null);const selected=f.alive().find(e=>e.typeId==='civ_trial:swordsman');assert.ok(selected);assert.equal(f.store.inspect('district-1:sol:0').phase,'alive');assert.equal(f.store.inspect('district-1:sol:0').actor,selected.id);f.rejoin();assert.equal(f.run(1000).refused,null);assert.equal(f.alive().filter(e=>e.typeId==='civ_trial:swordsman').length,1);});
