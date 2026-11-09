import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createInitialKingdom,serializeKingdom} from './runtime/CivilizationApocalypse_BP/scripts/kingdom/state.js';
import {createKingdomStore} from './runtime/CivilizationApocalypse_BP/scripts/kingdom/store.js';
import {createCreationRuntime as configured} from './runtime/CivilizationApocalypse_BP/scripts/integration/creationRuntime.js?private';
import {createCreationRuntime as ordinary} from './runtime/CivilizationApocalypse_BP/scripts/integration/creationRuntime.js';
import {startSimulationLoop} from './runtime/CivilizationApocalypse_BP/scripts/integration/simulationLoop.js';
import {REVIEWED_FRESH_FIXTURE as d} from './native-variant/proposed/freshFixtureTrust.js';
const before=JSON.parse(readFileSync(new URL('./BEFORE.json',import.meta.url),'utf8'));
const active=new URL('../../../CivilizationApocalypse_BP/scripts/integration/simulationLoop.js',import.meta.url);
const oldSource=before['integration/simulationLoop.js'].source.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${s.startsWith('.')?new URL(s,active).href:s}${q}`);
const {startSimulationLoop:oldLoop}=await import('data:text/javascript;base64,'+Buffer.from(oldSource).toString('base64'));
const ACT='civ:creation_activation:v1',META='civ:pop_bind:v2:meta';
function fixture(factory=configured){
 const props=new Map([['civ:kingdom',serializeKingdom(createInitialKingdom())]]),reads=[],writes=[],callbacks=[],cleared=[],reports=[];
 const dims=Object.fromEntries(['overworld','nether','the_end'].map(n=>[n,{id:'minecraft:'+n,getEntities:()=>[]}]));
 const player={id:'EXPLICIT_FAKE_NATIVE_CALLER',isValid:true,dimension:dims.overworld,location:{x:0,y:64,z:0}};
 const participant={id:1,type:'FakePlayer',isValid:true,displayName:d.participant};
 const objective={id:'ca_fresh_owner',isValid:true,displayName:d.nonce,getScores:()=>[{participant,score:0}]};
 const world={getDynamicPropertyIds(){reads.push('ids');return[...props.keys()];},getDynamicProperty(k){reads.push(k);return props.get(k);},setDynamicProperty(k,v){writes.push([k,v]);props.set(k,v);},getDimension(n){reads.push('dimension:'+n);return dims[n];},getAllPlayers(){reads.push('players');return[player];},scoreboard:{getObjectives:()=>[objective],getObjective:()=>objective}};
 let tick=0;const system={runInterval(callback,ticks){callbacks.push({callback,ticks});return callbacks.length;},clearRun(id){cleared.push(id);},get currentTick(){return tick;}};
 const deps={world,isPeopleOn:()=>props.get('civ_people')===true,isBusy:()=>false,isDeveloper:()=>props.get('civ_devgate')===true,readKingdom:()=>JSON.parse(props.get('civ:kingdom'))};
 let runtime=factory(deps);const set=()=>globalThis.holdNative={world,system};
 return{props,reads,writes,callbacks,cleared,reports,world,system,player,get runtime(){return runtime;},set,
  gate(){world.setDynamicProperty('civ_devgate',true);},rejoin(){runtime=factory(deps);},
  start(t,loop=startSimulationLoop,guard=runtime.beforeSimulationStep){set();const stop=loop(createKingdomStore(world),{beforeStep:guard,onStep:r=>reports.push(r)});t.after(()=>{set();stop();});return stop;},
  hour(){set();tick+=callbacks.at(-1).ticks;callbacks.at(-1).callback();},get tick(){return tick;}};
}
test('private configured pending holds actual hour callback well beyond1000ticks; explicit activation resumes same timer without reset/catchup',t=>{
 const f=fixture(),initial=f.props.get('civ:kingdom');assert.equal(f.reads.length,0);f.start(t);assert.equal(f.callbacks.length,1);assert.equal(f.callbacks[0].ticks,1000);
 for(let i=0;i<5;i++)f.hour();assert.equal(f.tick,5000);assert.equal(f.props.get('civ:kingdom'),initial);assert.equal(f.writes.length,0);assert.equal(f.reports.length,0);assert.equal(f.props.has('civ_devgate'),false);
 f.gate();assert.match(f.runtime.command('fresh confirm',f.player)[0],/fresh/);const afterActivation=f.writes.length;assert.equal(JSON.parse(f.props.get('civ:kingdom')).step,0);
 f.hour();assert.equal(f.tick,6000);assert.equal(JSON.parse(f.props.get('civ:kingdom')).step,1);assert.equal(f.writes.length,afterActivation+1);assert.equal(f.reports.length,1);assert.equal(f.callbacks.length,1);assert.equal(f.cleared.length,0);
});
test('NULL profile exposes no guard and adds zero native reads; actual default callback bytes/read sequence equal previous loop',t=>{
 const run=loop=>{const f=fixture(ordinary);assert.equal(f.runtime.beforeSimulationStep,undefined);assert.equal(f.reads.length,0);const stop=f.start(t,loop);for(let i=0;i<16;i++)f.hour();f.set();stop();return{raw:f.props.get('civ:kingdom'),reads:f.reads,writes:f.writes,reports:f.reports};};
 const old=run(oldLoop),now=run(startSimulationLoop);assert.deepEqual(now,old);assert.equal(JSON.parse(now.raw).step,16);
});
test('optional guard is strict boolean and exceptions/false cannot load, transact, write or publish an hour',t=>{
 for(const value of [false,undefined,1,'yes',new Error('late invalid')]){const f=fixture();let loaded=0;f.set();const stop=startSimulationLoop({load(){loaded++;throw Error('should never load');}}, {beforeStep:()=>{if(value instanceof Error)throw value;return value;},onStep:()=>assert.fail('published')});for(let i=0;i<3;i++)f.hour();stop();assert.equal(loaded,0);assert.equal(f.writes.length,0);assert.equal(f.callbacks.length,1);}
});
test('valid explicit legacy mode permits ordinary hours; unknown/partial namespace never resumes or clears metadata',t=>{
 const f=fixture();f.gate();f.runtime.command('legacy confirm epoch=explicit-preserve',f.player);f.start(t);f.hour();assert.equal(JSON.parse(f.props.get('civ:kingdom')).step,1);
 f.props.set('civ:creation_activation:future','unknown');const before=new Map(f.props),writes=f.writes.length;f.hour();assert.deepEqual(f.props,before);assert.equal(f.writes.length,writes);
});
test('completed durable receipt resumes; later invalid status stops the very next hour and preserves evolved save',t=>{
 const f=fixture();f.gate();f.runtime.command('fresh confirm',f.player);f.start(t);f.hour();const good=f.props.get(ACT);f.props.set(ACT,'pending-or-corrupt');const raw=f.props.get('civ:kingdom'),writes=f.writes.length;f.hour();assert.equal(f.props.get('civ:kingdom'),raw);assert.equal(f.writes.length,writes);assert.equal(f.reports.length,1);f.props.set(ACT,good);f.hour();assert.equal(JSON.parse(f.props.get('civ:kingdom')).step,2);
});
test('metadata getter invalidation inside private readiness refuses before actual transaction',t=>{
 const f=fixture();f.gate();f.runtime.command('fresh confirm',f.player);const get=f.world.getDynamicProperty;let changed=false;f.world.getDynamicProperty=k=>{const value=get(k);if(!changed&&k===META){changed=true;f.props.set(ACT,'late intent');}return value;};f.start(t);const raw=f.props.get('civ:kingdom'),writes=f.writes.length;f.hour();assert.equal(changed,true);assert.equal(f.props.get('civ:kingdom'),raw);assert.equal(f.writes.length,writes);assert.equal(f.reports.length,0);
});
test('existing save/anchor getters that invalidate readiness are caught immediately before transaction',t=>{
 for(const phase of ['save','anchors']){const f=fixture();f.gate();f.runtime.command('fresh confirm',f.player);let changed=false;const get=f.world.getDynamicProperty,players=f.world.getAllPlayers;
  if(phase==='save')f.world.getDynamicProperty=k=>{const value=get(k);if(!changed&&k==='civ:kingdom'){changed=true;f.props.set(ACT,'invalid during load');}return value;};
  else f.world.getAllPlayers=()=>{changed=true;f.props.set(ACT,'invalid during anchor read');return players();};
  const stop=f.start(t),raw=f.props.get('civ:kingdom'),writes=f.writes.length;f.hour();assert.equal(changed,true);assert.equal(f.props.get('civ:kingdom'),raw);assert.equal(f.writes.length,writes);assert.equal(f.reports.length,0);f.set();stop();
 }
});
for(const side of ['before','after'])for(const boundary of [1,2,3])test('activation crash '+side+' write'+boundary+' remains held across new runtime unless durable completion is exact',t=>{
 const f=fixture();f.gate();const put=f.world.setDynamicProperty;let n=0;f.world.setDynamicProperty=(k,v)=>{if(++n===boundary&&side==='before')throw Error('test crash');put(k,v);if(n===boundary&&side==='after')throw Error('test crash');};assert.throws(()=>f.runtime.command('fresh confirm',f.player));f.world.setDynamicProperty=put;f.rejoin();f.start(t);const writes=f.writes.length;f.hour();assert.equal(JSON.parse(f.props.get('civ:kingdom')).step,side==='after'&&boundary===3?1:0);assert.equal(f.writes.length,writes+(side==='after'&&boundary===3?1:0));
});
test('guard never makes an evolved/played save fresh or enables developer flag implicitly',t=>{
 const f=fixture(),k=JSON.parse(f.props.get('civ:kingdom'));k.step=1;f.props.set('civ:kingdom',JSON.stringify(k));f.start(t);f.hour();assert.equal(f.props.has('civ_devgate'),false);assert.equal(f.writes.length,0);f.gate();assert.throws(()=>f.runtime.command('fresh confirm',f.player),/fresh initial property changed/);assert.equal(f.props.has(ACT),false);assert.equal(f.props.has(META),false);assert.equal(JSON.parse(f.props.get('civ:kingdom')).step,1);
});
