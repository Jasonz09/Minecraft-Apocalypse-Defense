import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCreationRuntime} from './proposed/integration/creationRuntime.js?synthetic';
import {createCreationRuntime as unconfigured} from './proposed/integration/creationRuntime.js';
import {ACTIVATION_KEY,ACTIVATION_FAMILY,OBJECTIVE} from './proposed/integration/privateFreshFixture.js';
import {META} from './proposed/integration/creationBindings.js';
import {classifyStarterKeys,starterArmProblems} from './proposed/sim/starter.js';
import {REVIEWED_FRESH_FIXTURE as d} from './synthetic-trust.mjs';
import {createInitialKingdom,serializeKingdom} from '../../../CivilizationApocalypse_BP/scripts/kingdom/state.js';
import {createPopWorld} from '../../../dev/lib/poptharness.mjs';
import {createPeopleStreets} from './proposed/integration/peopleStreets.js';

function fixture(factory=createCreationRuntime){
 const props=new Map([['civ:kingdom',serializeKingdom(createInitialKingdom())],['civ_devgate',true]]),writes=[];
 let on=false,busy=false,dev=true,death;const dims=Object.fromEntries(['overworld','nether','the_end'].map(name=>[name,{id:'minecraft:'+name,getEntities:()=>[]}]));
 const player={id:'caller',isValid:true,dimension:dims.overworld};
 const participant={id:17,type:'FakePlayer',isValid:true,displayName:d.participant};
 const objective={id:OBJECTIVE,isValid:true,displayName:d.nonce,getScores:()=>[{participant,score:0}]};
 const world={getDynamicPropertyIds:()=>[...props.keys()],getDynamicProperty:k=>props.get(k),setDynamicProperty(k,v){writes.push([k,v]);props.set(k,v);},getAllPlayers:()=>[player],getDimension:n=>dims[n],scoreboard:{getObjective:()=>objective,getObjectives:()=>[objective]},afterEvents:{entityDie:{subscribe(fn){death=fn;}}}};
 const deps={world,isPeopleOn:()=>on,isBusy:()=>busy,isDeveloper:()=>dev,readKingdom:()=>JSON.parse(props.get('civ:kingdom'))};
 const runtime=factory(deps);return{runtime,world,props,writes,player,objective,deps,setOn:v=>on=v,setBusy:v=>busy=v,setDev:v=>dev=v,fire:e=>death(e),rejoin:()=>factory(deps)};
}
test('construction/registration are early safe; unconfigured private hook is zero-read and does not set gates',()=>{
 const f=fixture(unconfigured);let reads=0;f.world.getDynamicPropertyIds=()=>{reads++;throw Error('early');};
 assert.equal(f.runtime.registerDeaths(),true);assert.equal(f.runtime.registerDeaths(),false);assert.equal(f.runtime.onInitialSpawn(f.player),false);assert.equal(reads,0);assert.equal(f.writes.length,0);
});
test('default null descriptor refuses fresh public arguments and real caller without changes',()=>{
 const f=fixture(unconfigured);for(const request of ['fresh confirm','fresh confirm epoch=fake receipt=fake','fresh=true'])assert.throws(()=>f.runtime.command(request,f.player));assert.equal(f.writes.length,0);assert.equal(f.runtime.activeStore(),undefined);
});
test('configured activation remains held after missed/failed first-spawn and cannot default birth',()=>{const f=fixture();f.setDev(false);assert.equal(f.runtime.onInitialSpawn(f.player),false);assert.throws(()=>f.runtime.activeStore(),/activation pending/);assert.equal(f.writes.length,0);});
test('real caller reaches private adapter; no caller/wrong dimension never authorizes activation',()=>{
 for(const change of [f=>undefined,f=>({id:'fake',isValid:true,dimension:{id:'minecraft:nether'}})]){
  const f=fixture();assert.throws(()=>f.runtime.command('fresh confirm',change(f)));assert.equal(f.writes.length,0);
 }
 const f=fixture();assert.match(f.runtime.command('fresh confirm',f.player)[0],/fresh/);assert.equal(f.writes.length,3);assert.ok(f.runtime.activeStore());assert.ok(f.rejoin().activeStore());
});
test('private initial-spawn hook accepts only configured exact initial proof, with preexisting developer flag',()=>{
 const f=fixture();assert.equal(f.runtime.onInitialSpawn(f.player),true);assert.equal(f.runtime.onInitialSpawn(f.player),false);assert.equal(f.writes.length,3);
 for(const change of [f=>f.setDev(false),f=>f.setBusy(true),f=>f.setOn(true),f=>f.props.delete('civ_devgate'),f=>{const k=JSON.parse(f.props.get('civ:kingdom'));k.step=1;f.props.set('civ:kingdom',JSON.stringify(k));},f=>f.objective.displayName='wrong']){
  const x=fixture();change(x);const before=[...x.props];assert.equal(x.runtime.onInitialSpawn(x.player),false);assert.deepEqual([...x.props],before);assert.equal(x.writes.length,0);
 }
});
for(const key of [ACTIVATION_KEY,ACTIVATION_FAMILY+'future'])test('activation-family '+key+' holds before every fallback, legacy command and death signal',()=>{
 const f=fixture(unconfigured);f.props.set(key,'unknown');const before=[...f.props];assert.throws(()=>f.runtime.activeStore(),/activation/);assert.match(f.runtime.statusLines()[0],/held/);assert.throws(()=>f.runtime.command('legacy confirm epoch=legacy',f.player));
 f.runtime.registerDeaths();f.fire({deadEntity:{id:'old',typeId:'minecraft:villager_v2',getTags:()=>['civpop:v1:district-1:civ:0']}});assert.deepEqual([...f.props],before);assert.equal(f.writes.length,0);
});
test('fresh core header without completed receipt holds; explicit legacy mode remains its preservation path',()=>{
 const f=fixture();f.runtime.command('fresh confirm',f.player);f.props.delete(ACTIVATION_KEY);assert.throws(()=>f.rejoin().activeStore(),/activation/);
 const legacy=fixture(unconfigured);legacy.runtime.command('legacy confirm epoch=legacy',legacy.player);assert.equal(legacy.runtime.activeStore().canBirth('district-1:civ:0','minecraft:villager_v2').allowed,false);
});
test('activation introduced by legacy eligibility getter holds before core initialization',()=>{
 const f=fixture(unconfigured);f.deps.readKingdom=()=>{f.props.set(ACTIVATION_KEY,'new-intent');return {};};
 assert.throws(()=>f.runtime.command('legacy confirm epoch=legacy',f.player),/activation/);assert.equal(f.props.has(META),false);assert.equal(f.writes.length,0);
});
for(const side of ['before','after'])for(const boundary of [1,2,3])test('composed restart '+side+' activation write '+boundary+' never silently falls back',()=>{
 const f=fixture(),put=f.world.setDynamicProperty;let count=0;f.world.setDynamicProperty=(k,v)=>{if(++count===boundary&&side==='before')throw Error('crash');put(k,v);if(count===boundary&&side==='after')throw Error('crash');};
 assert.throws(()=>f.runtime.command('fresh confirm',f.player));const next=f.rejoin();
 if(side==='before'&&boundary===1){assert.throws(()=>next.activeStore(),/activation pending/);}
 else if(side==='after'&&boundary===3){assert.ok(next.activeStore());}
 else{assert.throws(()=>next.activeStore(),/activation/);assert.throws(()=>next.command('legacy confirm epoch=other',f.player));}
});
test('durable completed receipt survives ordinary later play, marker edits and caller departure; core corruption holds',()=>{
 const f=fixture();f.runtime.command('fresh confirm',f.player);f.setOn(true);f.setDev(false);f.player.isValid=false;f.objective.displayName='later-edited';assert.ok(f.runtime.activeStore());
 f.props.set(META,'corrupt');assert.throws(()=>f.runtime.activeStore(),/activation/);
});
test('starter/export preserve every activation/core sibling even against wipe-prefix rules and refuse readiness',()=>{
 const keys=[ACTIVATION_KEY,ACTIVATION_FAMILY+'future','civ:pop_bind:v2:meta','civ:pop_bind:future'];
 const result=classifyStarterKeys(keys,{wipeKeyPrefixes:['civ:']});assert.deepEqual(result.keep,[...keys].sort());assert.equal(result.wipe.length,0);
 assert.ok(starterArmProblems({kingdom:createInitialKingdom(),keys}).some(x=>/creation history/.test(x)));
});
test('current main hook reuses welcome subscription after seeding and passes native command caller',()=>{
 const main=readFileSync(new URL('./proposed/main.js',import.meta.url),'utf8'),welcome=readFileSync(new URL('./proposed/events/welcome.js',import.meta.url),'utf8'),command=readFileSync(new URL('./proposed/commands/people.js',import.meta.url),'utf8');
 assert.match(main,/registerWelcomeOnJoin\(kingdomStore,player=>\{creation.onInitialSpawn\(player\);\}\)/);
 assert.ok(welcome.indexOf('kingdomStore.ensureInitial()')<welcome.indexOf('onInitialSpawn?.(player)'));assert.equal((welcome.match(/playerSpawn.subscribe/g)||[]).length,1);
 assert.match(command,/creationCommand\?\.\(event.message.trim\(\).slice\(8\).trim\(\),event.sourceEntity\)/);
 assert.equal((main.match(/creation.registerDeaths\(\)/g)||[]).length,1);
});
test('actual welcome callback seeds before private hook and actual command callback passes native sourceEntity',async()=>{
 const {world,system}=await import('./native-stub.mjs');let spawned,received;const order=[];
 world.afterEvents={playerSpawn:{subscribe(fn){spawned=fn;}}};world.sendMessage=()=>{};
 system.afterEvents={scriptEventReceive:{subscribe(fn){received=fn;}}};
 const {registerWelcomeOnJoin}=await import('./proposed/events/welcome.js');
 const k=createInitialKingdom(),player={name:'caller',sendMessage(){order.push('welcome');}};
 registerWelcomeOnJoin({ensureInitial(){order.push('seed');return{kingdom:k,seeded:true};}},p=>{assert.equal(p,player);order.push('activation');});
 spawned({initialSpawn:false,player});assert.deepEqual(order,[]);spawned({initialSpawn:true,player});assert.deepEqual(order,['seed','activation','welcome']);
 const {registerPeopleCommand}=await import('./proposed/commands/people.js');let actual;
 registerPeopleCommand({statusLines:()=>[],creationCommand(message,caller){actual={message,caller};return[];}});
 received({id:'civ:people',message:'creation fresh confirm',sourceEntity:player});assert.deepEqual(actual,{message:'fresh confirm',caller:player});
});

function streetFixture(factory=createCreationRuntime){
 const f=fixture(factory),pop=createPopWorld();pop.loadArea(-64,-64,96,96);
 f.player.dimension=pop.dimension;f.player.location={x:0,y:70,z:0};f.player.name='caller';
 const dimension=f.world.getDimension;f.world.getDimension=n=>n==='overworld'?pop.dimension:dimension(n);
 let on=true;const k=createInitialKingdom();for(const d of k.districts){d.civilians=d.id==='district-1'?10:0;d.soldiers=0;d.garrison={front:0,reserve:0};}
 const driver=createPeopleStreets({isGateOn:()=>on,homes:()=>({'district-1':{x:0,y:70,z:0}}),getCreationBindings:f.runtime.activeStore});
 const run=tick=>driver.onHour({world:f.world,dimension:pop.dimension,kingdom:k,report:{},tick});
 return{...f,pop,driver,k,run,off:()=>on=false,alive:()=>[...pop.state.entities.values()].filter(e=>e.alive)};
}
test('configured no-devflag first-spawn refusal followed by people-on holds actual streets with zero births/writes',()=>{
 const f=streetFixture();f.setDev(false);f.props.delete('civ_devgate');assert.equal(f.runtime.onInitialSpawn(f.player),false);f.setOn(true);
 const before=[...f.props];assert.equal(f.run(1000),0);assert.equal(f.alive().length,0);assert.match(String(f.driver.status().refused),/activation pending/);assert.deepEqual([...f.props],before);assert.equal(f.writes.length,0);
 f.setOn(false);f.setDev(true);f.props.set('civ_devgate',true);const k=JSON.parse(f.props.get('civ:kingdom'));k.step=1;f.props.set('civ:kingdom',JSON.stringify(k));assert.throws(()=>f.runtime.command('fresh confirm',f.player),/fresh initial property changed/);assert.equal(f.writes.length,0);
});
for(const shape of ['intent-only','unknown','unconfigured-complete','fresh-header-only'])test('actual streets hour and gate-off HOLD '+shape+' before owner/fallback mutation',()=>{
 const f=streetFixture(shape==='unconfigured-complete'?unconfigured:createCreationRuntime);
 if(shape==='intent-only')f.props.set(ACTIVATION_KEY,JSON.stringify({phase:'intent'}));
 if(shape==='unknown')f.props.set(ACTIVATION_FAMILY+'future','foreign');
 if(shape==='unconfigured-complete')f.props.set(ACTIVATION_KEY,JSON.stringify({phase:'complete'}));
 if(shape==='fresh-header-only')f.props.set(META,JSON.stringify({mode:'fresh'}));
 f.pop.addEntity({id:'legacy',typeId:'minecraft:villager_v2',x:0,y:70,z:0,tags:['civpop:v1:district-1:civ:0']});
 const before=[...f.props];assert.equal(f.run(0),0);assert.match(String(f.driver.status().refused),/activation/);f.off();assert.equal(f.run(1000),0);assert.equal(f.alive().length,1);assert.deepEqual([...f.props],before);assert.equal(f.writes.length,0);
});
test('composed private activation supplies same owner for birth, unload preservation, death registration and gate-off terminal receipt',()=>{
 const f=streetFixture();f.runtime.command('fresh confirm',f.player);f.runtime.registerDeaths();
 assert.equal(f.run(0),1,String(f.driver.status().refused));assert.equal(f.alive().length,1);const actor=f.alive()[0],group='district-1:civ:0';
 f.pop.unloadArea(-64,-64,96,96);assert.equal(f.run(1000),0);assert.equal(f.alive().length,1);assert.equal(f.runtime.activeStore().canBirth(group,'minecraft:villager_v2').allowed,false);
 f.pop.loadArea(-64,-64,96,96);f.off();assert.equal(f.run(2000),1,String(f.driver.status().refused));assert.equal(f.alive().length,0);assert.equal(f.runtime.activeStore().inspect(group).terminal,'owner-remove');assert.equal(f.k.districts[0].civilians,10);
 f.fire({deadEntity:{id:actor.id,typeId:actor.typeId,getTags:()=>[...actor.tags]}});assert.equal(f.runtime.activeStore().inspect(group).terminal,'owner-remove');
});
