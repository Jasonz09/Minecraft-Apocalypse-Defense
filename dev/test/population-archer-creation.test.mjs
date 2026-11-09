import {register as registerCreationLoader} from 'node:module';
registerCreationLoader('../lib/creation-test-loader.mjs',import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPopWorld} from '../lib/poptharness.mjs';
const {createInitialKingdom,serializeKingdom}=await import('../../CivilizationApocalypse_BP/scripts/kingdom/state.js');
const {createCreationRuntime}=await import('../../CivilizationApocalypse_BP/scripts/integration/creationRuntime.js?synthetic');
const {createCreationRuntime : unconfigured}=await import('../../CivilizationApocalypse_BP/scripts/integration/creationRuntime.js');
const {CREATION_ENTITY_TYPES,CUSTOM_CREATION_ENTITY_TYPES,registerCreationDeaths,PREFIX,META}=await import('../../CivilizationApocalypse_BP/scripts/integration/creationBindings.js');
const {createPeopleStreets}=await import('../../CivilizationApocalypse_BP/scripts/integration/peopleStreets.js');
const {createMilitarySelectionStore}=await import('../../CivilizationApocalypse_BP/scripts/integration/militarySelectionStore.js');
const {MILITARY_TYPES,ARCHER_TYPE,SWORDSMAN_TYPE,CAVALRY_TYPE,decodeMilitarySelection,MILITARY_SELECTION_KEY}=await import('../../CivilizationApocalypse_BP/scripts/population/militarySelection.js');
import {REVIEWED_FRESH_FIXTURE as trust} from '../fixtures/synthetic-creation-trust.mjs';
const GROUP='district-1:sol:0',TAG='civpop:v1:'+GROUP;

function fixture({activate=true,kind='archer',mode='fresh'}={}){
 const pop=createPopWorld(),world=pop.world;let people=false,death,deathOptions;const props=pop.state.props;
 props.set('civ:kingdom',serializeKingdom(createInitialKingdom()));props.set('civ_devgate',true);
 const caller={id:'caller',name:'caller',typeId:'minecraft:player',isValid:true,dimension:pop.dimension,location:{x:0,y:70,z:0}};
 world.getDynamicPropertyIds=()=>[...props.keys()];world.getAllPlayers=()=>[caller];
 world.getDimension=name=>name==='overworld'?pop.dimension:{id:'minecraft:'+name,getEntities:()=>[]};
 const participant={id:17,type:'FakePlayer',isValid:true,displayName:trust.participant};
 const objective={id:'ca_fresh_owner',isValid:true,displayName:trust.nonce,getScores:()=>[{participant,score:0}]};
 world.scoreboard={getObjectives:()=>[objective],getObjective:()=>objective};
 world.afterEvents={entityDie:{subscribe(fn,opts){death=fn;deathOptions=opts;}}};
 const deps={world,isPeopleOn:()=>people,isDeveloper:()=>true,isBusy:()=>false,readKingdom:()=>JSON.parse(props.get('civ:kingdom'))};
 let runtime=createCreationRuntime(deps);
 if(activate){if(mode==='legacy')runtime.command('legacy confirm epoch=legacy',caller);else runtime.command('fresh confirm',caller);}
 const k=createInitialKingdom();for(const d of k.districts){d.civilians=0;d.soldiers=d.id==='district-1'?5:0;d.garrison={front:d.soldiers,reserve:0};}
 // This lower-store test proof is synthetic. The public military adapter retains
 // its separate Nov3 source requirement and is not blessed by creation activation.
 function select(){const store=createMilitarySelectionStore(world,{readKingdom:()=>k,isPeopleOn:()=>false,isBusy:()=>false,readCanonicalCensus:()=>({complete:true,groupIds:[]}),verifyFreshTrial:()=>({verified:true,fixtureId:'synthetic-military',dimension:'minecraft:overworld'})});store.activate({groupId:GROUP,trialId:'synthetic-'+kind,dimension:'minecraft:overworld',class:kind});return store;}
 let selection;
 function ready(){props.set('civ:kingdom',serializeKingdom(k));selection=select();pop.loadArea(-64,-64,96,96);return selection;}
 const driver=()=>createPeopleStreets({isGateOn:()=>people,homes:()=>({'district-1':{x:0,y:70,z:0}}),getCreationBindings:()=>runtime.activeStore(),readMilitarySelection:()=>selection.load()});
 const run=(tick,gate=true)=>{people=gate;const d=driver();return{changes:d.onHour({world,dimension:pop.dimension,kingdom:k,report:{},tick}),status:d.status()};};
 const alive=()=>[...pop.state.entities.values()].filter(e=>e.alive&&e.tags.has(TAG));
 const store=()=>runtime.activeStore();
 return{pop,world,props,caller,objective,k,ready,run,alive,store,get runtime(){return runtime;},get selection(){return selection;},get deathOptions(){return deathOptions;},registerDeaths:()=>runtime.registerDeaths(),fire:entity=>death({deadEntity:entity}),rejoin(){pop.restart();runtime=createCreationRuntime(deps);},snapshot:e=>({groupId:GROUP,id:e.id,typeId:e.typeId,tags:[...e.tags]})};
}
test('shared creation allowlists exactly include both selected types; both death entrypoints use that same list',()=>{
 assert.deepEqual(CUSTOM_CREATION_ENTITY_TYPES,[SWORDSMAN_TYPE,ARCHER_TYPE]);assert.deepEqual(MILITARY_TYPES,[SWORDSMAN_TYPE,ARCHER_TYPE,CAVALRY_TYPE]);assert.deepEqual(CREATION_ENTITY_TYPES,['minecraft:villager_v2','minecraft:iron_golem',SWORDSMAN_TYPE,ARCHER_TYPE]);assert.ok(Object.isFrozen(CREATION_ENTITY_TYPES));
 const f=fixture();assert.equal(f.registerDeaths(),true);assert.equal(f.registerDeaths(),false);assert.deepEqual(f.deathOptions.entityTypes,[...CREATION_ENTITY_TYPES]);
 let options;const w={afterEvents:{entityDie:{subscribe(_fn,o){options=o;}}}};registerCreationDeaths(w,{});assert.deepEqual(options.entityTypes,[...CREATION_ENTITY_TYPES]);
});
test('private blank census rejects an untagged archer before any intent/header write; default trust remains null',()=>{
 const f=fixture({activate:false}),before=new Map(f.props),writes=f.pop.state.propertyWrites.length;
 f.pop.loadArea(-64,-64,96,96);f.pop.addEntity({id:'unclaimed-archer',typeId:ARCHER_TYPE,x:0,y:70,z:0,tags:[]});
 assert.throws(()=>f.runtime.command('fresh confirm',f.caller),/loaded population\/siege history/);assert.deepEqual(f.props,before);assert.equal(f.pop.state.propertyWrites.length,writes);
 const a=unconfigured({world:f.world,isPeopleOn:()=>false,isDeveloper:()=>true,isBusy:()=>false,readKingdom:()=>f.k});assert.throws(()=>a.command('fresh confirm',f.caller),/no actual reviewed/);
});
test('same owner creates one bound archer; unload/rejoin preserves ID; gate-off retires exact instance; next birth increments generation',()=>{
 const f=fixture();f.ready();assert.equal(f.run(0).changes,1);const old=f.alive()[0];assert.equal(old.typeId,ARCHER_TYPE);assert.equal(f.store().inspect(GROUP).type,ARCHER_TYPE);assert.equal(f.store().inspect(GROUP).generation,1);
 old.x=80;old.z=0;f.pop.unloadArea(80,0,95,15);f.rejoin();assert.equal(f.run(1000).changes,0);assert.equal(f.alive().length,1);assert.equal(f.alive()[0].id,old.id);assert.equal(f.store().canBirth(GROUP,ARCHER_TYPE).allowed,false);
 f.pop.loadArea(80,0,95,15);const kingdom=f.props.get('civ:kingdom');assert.equal(f.run(2000,false).changes,1);assert.equal(f.alive().length,0);assert.equal(f.store().inspect(GROUP).terminal,'owner-remove');
 assert.equal(f.run(3000).changes,1);assert.equal(f.alive().length,1);assert.notEqual(f.alive()[0].id,old.id);assert.equal(f.store().inspect(GROUP).generation,2);assert.equal(f.props.get('civ:kingdom'),kingdom);
});
test('real runtime archer death filter records only exact physical generation, deduplicates, and leaves aggregate unchanged',()=>{
 const f=fixture();f.ready();f.run(0);f.registerDeaths();const actor=f.alive()[0],before=f.props.get('civ:kingdom');
 f.fire({id:actor.id,typeId:ARCHER_TYPE,getTags:()=>[...actor.tags]});assert.equal(f.store().inspect(GROUP).terminal,'death');const after=[...f.props];f.fire({id:actor.id,typeId:ARCHER_TYPE,getTags:()=>[...actor.tags]});assert.deepEqual([...f.props],after);assert.equal(f.props.get('civ:kingdom'),before);
});
test('wrong-type or foreign-token archer death cannot retire the real bound generation',()=>{
 const f=fixture();f.ready();f.run(0);f.registerDeaths();const actor=f.alive()[0],before=new Map(f.props);
 f.fire({id:actor.id,typeId:SWORDSMAN_TYPE,getTags:()=>[...actor.tags]});assert.deepEqual(f.props,before);
 f.fire({id:actor.id,typeId:ARCHER_TYPE,getTags:()=>[TAG,'civbirth:v2:foreign:1']});assert.deepEqual(f.props,before);assert.equal(f.store().inspect(GROUP).phase,'alive');
});
test('archer tag failure uses same positive rollback protocol and later retry advances generation',()=>{
 const f=fixture();f.ready();f.pop.failNextTag();assert.equal(f.run(0).changes,0);assert.equal(f.alive().length,0);assert.equal(f.store().inspect(GROUP).type,ARCHER_TYPE);assert.equal(f.store().inspect(GROUP).terminal,'tag-rollback');
 assert.equal(f.run(1000).changes,1);assert.equal(f.store().inspect(GROUP).generation,2);assert.equal(f.alive()[0].typeId,ARCHER_TYPE);
});
test('selection changed by archer birth metadata getter prevents native spawn and leaves issuance held',()=>{
 const f=fixture();f.ready();const get=f.world.getDynamicProperty;let changed=false;
 f.world.getDynamicProperty=key=>{const raw=get(key);if(!changed&&key===META&&typeof raw==='string'&&JSON.parse(raw).issued===1){changed=true;f.props.delete(MILITARY_SELECTION_KEY);}return raw;};
 assert.equal(f.run(0).changes,0);assert.equal(changed,true);assert.equal(f.alive().length,0);f.world.getDynamicProperty=get;assert.equal(f.store().canBirth(GROUP,ARCHER_TYPE).allowed,false);assert.equal(f.run(1000).changes,0);
});
for(const kind of ['duplicate','foreign-token','changed-selection'])test('bound archer '+kind+' is preserved before birth/removal',()=>{
 const f=fixture();f.ready();f.run(0);const actor=f.alive()[0];
 if(kind==='duplicate')f.pop.addEntity({id:'other',typeId:ARCHER_TYPE,x:actor.x,y:actor.y,z:actor.z,tags:[...actor.tags]});
 if(kind==='foreign-token')actor.tags.delete([...actor.tags].find(t=>t.startsWith('civbirth:')));
 if(kind==='changed-selection')f.props.delete(MILITARY_SELECTION_KEY);
 const count=f.alive().length,result=f.run(1000);assert.equal(result.changes,0);assert.ok(result.status.refused);assert.equal(f.alive().length,count);assert.equal(actor.alive,true);
});
test('removed selection cannot retype a bound archer: gate-off may retire exact owned actor, then default-type refill holds',()=>{
 const f=fixture();f.ready();f.run(0);f.props.delete(MILITARY_SELECTION_KEY);assert.equal(f.run(1000,false).changes,1);assert.equal(f.store().inspect(GROUP).type,ARCHER_TYPE);assert.equal(f.store().inspect(GROUP).terminal,'owner-remove');assert.equal(f.run(2000).changes,0);assert.equal(f.alive().length,0);assert.equal(f.store().inspect(GROUP).type,ARCHER_TYPE);
});
test('schema1 swordsman bytes and bound lifecycle remain supported, while legacy archer observations never gain absence birth authority',()=>{
 const f=fixture({kind:'swordsman'});f.ready();const raw=f.props.get(MILITARY_SELECTION_KEY);assert.equal(JSON.parse(raw).v,1);assert.equal(decodeMilitarySelection(raw).stamp,raw);assert.equal(f.run(0).changes,1);assert.equal(f.alive()[0].typeId,SWORDSMAN_TYPE);
 const g=fixture({mode:'legacy'});g.ready();g.pop.addEntity({id:'legacy-archer',typeId:ARCHER_TYPE,x:0,y:70,z:0,tags:[TAG]});const result=g.run(0);assert.equal(result.changes,0);assert.equal(g.alive().length,1);assert.equal(g.store().inspect(GROUP).phase,'legacy');assert.equal(g.store().canBirth(GROUP,ARCHER_TYPE).allowed,false);assert.equal(g.run(1000,false).changes,0);assert.equal(g.alive().length,1);
});
test('archer terminal save failure preserves removing phase across rejoin with no absence refill',()=>{
 const f=fixture();f.ready();f.run(0);const put=f.world.setDynamicProperty;f.world.setDynamicProperty=(k,v)=>{if(k===PREFIX+GROUP&&typeof v==='string'&&JSON.parse(v).phase==='retired')throw Error('terminal-save-failure');return put(k,v);};
 assert.equal(f.run(1000,false).changes,0);assert.equal(f.alive().length,0);f.world.setDynamicProperty=put;f.rejoin();assert.equal(f.store().inspect(GROUP).phase,'removing');assert.equal(f.run(2000).changes,0);assert.equal(f.alive().length,0);
});
for(const side of ['before','after'])for(const boundary of [1,2,3,4])test('archer issuance '+side+' durable write '+boundary+' cannot grant fresh authority after restart',()=>{
 const f=fixture();f.ready();const store=f.store(),put=f.world.setDynamicProperty;let calls=0;
 f.world.setDynamicProperty=(k,v)=>{if(++calls===boundary&&side==='before')throw Error('crash');put(k,v);if(calls===boundary&&side==='after')throw Error('crash');};
 assert.throws(()=>store.prepare(GROUP,ARCHER_TYPE));f.world.setDynamicProperty=put;f.rejoin();
 if(side==='before'&&boundary===1){assert.equal(f.store().canBirth(GROUP,ARCHER_TYPE).allowed,true);}
 else{let held=false;try{assert.equal(f.store().canBirth(GROUP,ARCHER_TYPE).allowed,false);}catch(error){assert.match(String(error),/held|HOLD|pending|issuance/i);held=true;}const before=new Map(f.props);assert.equal(f.run(1000).changes,0);assert.equal(f.alive().length,0);if(held)assert.deepEqual(f.props,before);}
});
