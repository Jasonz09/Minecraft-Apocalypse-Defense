import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
import {createCreationBindings,registerCreationDeaths,PREFIX,META,MAX_RECORDS,MAX_BYTES} from './proposed/integration/creationBindings.js';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const root=new URL('../../../',import.meta.url),actual=new URL('CivilizationApocalypse_BP/scripts/integration/popSync.js',root);
let source=readFileSync(new URL('./proposed/integration/popSync.js',import.meta.url),'utf8').replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${(s.startsWith('.')?new URL(s,actual).href:s)}${q}`);
const {createPopSync}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {createPopWorld}=await import(new URL('dev/lib/poptharness.mjs',root)),{createInitialKingdom}=await import(new URL('CivilizationApocalypse_BP/scripts/kingdom/state.js',root));
const {decodeMilitarySelection}=await import(new URL('CivilizationApocalypse_BP/scripts/population/militarySelection.js',root));
const GROUP='district-1:civ:0',TAG='civpop:v1:'+GROUP;
function fixture(mode='fresh',military=false,epoch='epoch-one'){
 const pop=createPopWorld(),k=createInitialKingdom();pop.world.getDynamicPropertyIds=()=>[...pop.state.props.keys()];for(const d of k.districts){d.civilians=d.id==='district-1'?10:0;d.soldiers=military&&d.id==='district-1'?5:0;d.garrison={front:d.soldiers,reserve:0};}pop.setKingdom(k);pop.loadArea(-64,-64,96,96);pop.setPlayers([{name:'player',x:0,y:70,z:0}]);
 const makeStore=()=>createCreationBindings(pop.world,{verifyFreshWorld:()=>({verified:true,fixtureId:'known-empty-fixture',dimension:'minecraft:overworld',ownerHistory:'never-started'})});let store=makeStore();store.initialize({mode,epoch,fixture:'known-empty-fixture'});
 const sync=()=>createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>({'district-1':{x:0,y:70,z:0}}),enabled:true,creationBindings:store,...(military?{readMilitarySelection:()=>globalThis.creationReviewSelectionAbsent?decodeMilitarySelection(undefined):decodeMilitarySelection(JSON.stringify({v:1,trialId:'birth-probe',fixtureId:'known-empty-fixture',groupId:'district-1:sol:0',class:'swordsman',typeId:'civ_trial:swordsman',dimension:'minecraft:overworld'}))}:{})});
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
 for(let boundary=0;boundary<=12;boundary++){const f=fixture();f.pop.crashAfterMutations(boundary);try{f.run(0);}catch(_error){}f.rejoin();for(let n=1;n<=3;n++){try{f.run(n*1000);}catch(_error){}}assert.ok(f.alive().length<=1,'boundary'+boundary);assert.ok(f.pop.state.spawned.length<=1,'no duplicate after boundary'+boundary);}
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

test('missing issued record cannot masquerade as neverissued, even with unrelated valid samecount substitution',()=>{for(const substitute of[false,true]){const f=fixture(),old=f.spawn();old.x=80;old.z=0;f.pop.unloadArea(80,0,95,15);const issued=f.pop.world.getDynamicProperty(PREFIX+GROUP);f.pop.setRawProperty(PREFIX+GROUP,undefined);if(substitute){const r=JSON.parse(issued);r.group='district-1:civ:9';f.pop.setRawProperty(PREFIX+r.group,JSON.stringify(r));}f.rejoin();assert.ok(f.run(1000).refused);assert.equal(f.alive().length,1);assert.equal(f.pop.state.spawned.length,1);assert.throws(()=>f.store.canBirth(GROUP,'minecraft:villager_v2'));}});
test('every before/after issuance publication fault holds reservedgroup but stillpermits distinct genuinelyneverissuedgroup',()=>{for(const when of['before','after'])for(let n=1;n<=4;n++){const f=fixture(),set=f.pop.world.setDynamicProperty;let writes=0;f.pop.world.setDynamicProperty=(k,v)=>{if(k.startsWith(PREFIX)){writes++;if(writes===n&&when==='before'){f.pop.state.dead=true;throw Error('crash beforewrite');}}set(k,v);if(k.startsWith(PREFIX)&&writes===n&&when==='after'){f.pop.state.dead=true;throw Error('crash afterwrite');}};try{f.store.prepare(GROUP,'minecraft:villager_v2');}catch(_error){}f.pop.world.setDynamicProperty=set;f.rejoin();const k=f.pop.storedKingdom();k.districts[0].civilians=20;f.pop.setKingdom(k);assert.equal(f.run(1000).refused,null,when+n);const at=f.store.inspect(GROUP);if(!(when==='before'&&n===1)){assert.equal(at.phase,'pending',when+n);assert.equal(at.actor,null);assert.equal(f.born().length,0);}assert.ok(f.alive().some(e=>e.tags.has('civpop:v1:district-1:civ:1')),'othercleanintent materializes '+when+n);}});
test('private removal ticket binds exact epoch/type/rawphase and is oneuse acrossconsistent epoch rewrite',()=>{const a=fixture(),old=a.spawn(),ticket=a.store.beginRemove(a.snapshot(old));const b=fixture('fresh',false,'epoch-two'),other=b.spawn();b.store.beginRemove(b.snapshot(other));for(const k of [...a.pop.state.props.keys()])if(k.startsWith(PREFIX))a.pop.state.props.delete(k);for(const[k,v]of b.pop.state.props)if(k.startsWith(PREFIX))a.pop.state.props.set(k,v);assert.throws(()=>a.store.commitRemoved(ticket),/raw\/epoch\/type/);assert.throws(()=>a.store.commitRemoved(ticket),/consumed/);assert.equal(a.store.inspect(GROUP).phase,'removing');
 const c=fixture(),born=c.spawn(),once=c.store.beginRemove(c.snapshot(born));assert.throws(()=>c.store.commitRemoved({...once}),/unissued/);born.alive=false;c.store.commitRemoved(once);assert.throws(()=>c.store.commitRemoved(once),/consumed/);});
test('unknown future namespace holds existing retired generation and never silentlyinitializes another schema',()=>{const f=fixture();f.spawn();f.pop.setPlayers([{name:'far',x:2000,y:70,z:2000}]);assert.equal(f.run(1000).refused,null);assert.equal(f.store.inspect(GROUP).phase,'retired');f.pop.setRawProperty('civ:pop_bind:v3:meta','future');assert.throws(()=>f.store.canBirth(GROUP,'minecraft:villager_v2'),/unknown\/future/);f.pop.setPlayers([{name:'near',x:0,y:70,z:0}]);assert.ok(f.run(2000).refused);assert.equal(f.alive().length,0);});

test('recovery neveroverwrites foreign/corruptstandby or unexpectedpendingrecord; before/afterraws preserved',()=>{for(const kind of['foreign-chunk','foreign-record']){const f=fixture(),set=f.pop.world.setDynamicProperty;f.pop.world.setDynamicProperty=(k,v)=>{set(k,v);if(k===META&&JSON.parse(v).pending){f.pop.state.dead=true;throw Error('crash afterintent');}};try{f.store.prepare(GROUP,'minecraft:villager_v2');}catch(_error){}f.pop.world.setDynamicProperty=set;f.rejoin();const k=kind==='foreign-chunk'?PREFIX+'index:0':PREFIX+GROUP;f.pop.setRawProperty(k,kind==='foreign-chunk'?JSON.stringify({v:2,epoch:'foreign',index:0,groups:['district-1:civ:9']}):'foreign-standby');const before=new Map(f.pop.state.props);assert.throws(()=>f.store.recoverIssuance());assert.deepEqual(f.pop.state.props,before);}});
test('changedrawphase or type cannot consume stale removal authority evenwithsameepoch/actor/generation',()=>{for(const kind of['type','phase']){const f=fixture(),old=f.spawn(),ticket=f.store.beginRemove(f.snapshot(old)),r=JSON.parse(f.pop.world.getDynamicProperty(PREFIX+GROUP));if(kind==='type')r.type='minecraft:iron_golem';else r.phase='alive';f.pop.setRawProperty(PREFIX+GROUP,JSON.stringify(r));assert.throws(()=>f.store.commitRemoved(ticket),/raw\/epoch\/type/);assert.equal(JSON.parse(f.pop.world.getDynamicProperty(PREFIX+GROUP)).phase,kind==='phase'?'alive':'removing');}});

test('REPRO: metadata getter retag after final canonical query must preserve nowforeign actor before owner removal',()=>{
 const f=fixture(),old=f.spawn(),get=f.pop.world.getDynamicProperty,query=f.pop.dimension.getEntities;let armed=false,mutated=false;
 f.pop.dimension.getEntities=args=>{const rows=query(args);const raw=f.pop.state.props.get(PREFIX+GROUP);if(args.tags?.includes(TAG)&&raw&&JSON.parse(raw).phase==='removing')armed=true;return rows;};
 f.pop.world.getDynamicProperty=k=>{const raw=get(k);if(armed&&!mutated&&k===META){mutated=true;old.tags.delete(TAG);}return raw;};
 f.pop.setPlayers([{name:'far',x:2000,y:70,z:2000}]);const result=f.run(1000);
 assert.equal(mutated,true);assert.equal(old.tags.has(TAG),false);assert.equal(old.alive,true,'retagged foreign handle must not be removed');
});

test('final live proof catches one-shot location/tag getter mutation without metadata reads after proof',()=>{
 for(const mutate of['tag-getter','location-getter','type-getter']){
  const f=fixture(),old=f.spawn(),query=f.pop.dimension.getEntities;let armed=false,changed=false;
  f.pop.dimension.getEntities=args=>{const rows=query(args),raw=f.pop.state.props.get(PREFIX+GROUP);if(args.tags?.includes(TAG)&&raw&&JSON.parse(raw).phase==='removing')armed=true;
   return rows.map(h=>new Proxy(h,{get(target,key){const value=Reflect.get(target,key);if(String(target.id)!==old.id)return value;
    if(key==='getTags')return()=>{const tags=value.call(target);if(armed&&!changed&&mutate==='tag-getter'){changed=true;old.tags.delete(TAG);}return tags;};
    if(armed&&!changed&&key===(mutate==='location-getter'?'location':mutate==='type-getter'?'typeId':'__unused')){changed=true;if(mutate==='type-getter')old.typeId='minecraft:pig';else old.tags.delete(TAG);}return value;
   }}));};
  f.pop.setPlayers([{name:'far',x:2000,y:70,z:2000}]);f.run(1000);assert.equal(changed,true,mutate);assert.equal(old.alive,true,mutate+' must preserve');
 }
});

test('PRESERVATION: selected military policy changing during removal metadata proof must refuse before entity mutation',()=>{
 globalThis.creationReviewSelectionAbsent=false;try{const f=fixture('fresh',true);f.run(0);const selected=f.alive().find(e=>e.typeId==='civ_trial:swordsman'),g='district-1:sol:0',tag='civpop:v1:'+g;assert.ok(selected);
 const get=f.pop.world.getDynamicProperty,query=f.pop.dimension.getEntities;let armed=false,changed=false;
 f.pop.dimension.getEntities=args=>{const rows=query(args);const raw=f.pop.state.props.get(PREFIX+g);if(args.tags?.includes(tag)&&raw&&JSON.parse(raw).phase==='removing')armed=true;return rows;};
 f.pop.world.getDynamicProperty=k=>{const raw=get(k);if(armed&&!changed&&k===META){changed=true;globalThis.creationReviewSelectionAbsent=true;}return raw;};
 f.pop.setPlayers([{name:'far',x:2000,y:70,z:2000}]);f.run(1000);assert.equal(changed,true);assert.equal(selected.alive,true,'policy changed after earlier beforeWrite; selected actor must be preserved');}finally{delete globalThis.creationReviewSelectionAbsent;}
});
