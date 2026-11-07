import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCreationRuntime} from '../proposed/integration/creationRuntime.js?synthetic';
import {createCreationRuntime as unconfigured} from '../proposed/integration/creationRuntime.js';
import {ACTIVATION_KEY,ACTIVATION_FAMILY,OBJECTIVE} from '../proposed/integration/privateFreshFixture.js';
import {META} from '../proposed/integration/creationBindings.js';
import {classifyStarterKeys,starterArmProblems} from '../proposed/sim/starter.js';
import {REVIEWED_FRESH_FIXTURE as d} from '../synthetic-trust.mjs';
import {createInitialKingdom,serializeKingdom} from '../../../../CivilizationApocalypse_BP/scripts/kingdom/state.js';
import {createPopWorld} from '../../../../dev/lib/poptharness.mjs';
import {createPeopleStreets} from '../proposed/integration/peopleStreets.js';

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
function streetFixture(factory=createCreationRuntime){
 const f=fixture(factory),pop=createPopWorld();pop.loadArea(-64,-64,96,96);
 f.player.dimension=pop.dimension;f.player.location={x:0,y:70,z:0};f.player.name='caller';
 const dimension=f.world.getDimension;f.world.getDimension=n=>n==='overworld'?pop.dimension:dimension(n);
 let on=true;const k=createInitialKingdom();for(const d of k.districts){d.civilians=d.id==='district-1'?10:0;d.soldiers=0;d.garrison={front:0,reserve:0};}
 const driver=createPeopleStreets({isGateOn:()=>on,homes:()=>({'district-1':{x:0,y:70,z:0}}),getCreationBindings:f.runtime.activeStore});
 const run=tick=>driver.onHour({world:f.world,dimension:pop.dimension,kingdom:k,report:{},tick});
 return{...f,pop,driver,k,run,off:()=>on=false,alive:()=>[...pop.state.entities.values()].filter(e=>e.alive)};
}

for(const side of ['before','after'])for(const boundary of [1,2,3])test('actual restarted streets onhour+offgate after '+side+' activation write'+boundary,()=>{
 const f=streetFixture(),put=f.world.setDynamicProperty;let count=0;f.world.setDynamicProperty=(key,value)=>{if(++count===boundary&&side==='before')throw Error('crash before');put(key,value);if(count===boundary&&side==='after')throw Error('crash after');};
 assert.throws(()=>f.runtime.command('fresh confirm',f.player));f.world.setDynamicProperty=put;
 const runtime=f.rejoin();let on=true;const driver=createPeopleStreets({isGateOn:()=>on,homes:()=>({'district-1':{x:0,y:70,z:0}}),getCreationBindings:runtime.activeStore});const run=tick=>driver.onHour({world:f.world,dimension:f.pop.dimension,kingdom:f.k,report:{},tick});
 if(side==='before'&&boundary===1){assert.equal(runtime.activeStore(),undefined);assert.equal(f.props.has(META),false);assert.equal(f.props.has(ACTIVATION_KEY),false);assert.equal(run(0),1,'original legacy behavior is unchanged before any activation intent, not fresh issuance');assert.equal(f.alive().length,1);assert.equal([...f.alive()[0].tags].some(t=>t.startsWith('civbirth:')),false);assert.equal(f.props.has(META),false);}
 else if(side==='after'&&boundary===3){assert.ok(runtime.activeStore());assert.equal(run(0),1);assert.equal(f.alive().length,1);assert.equal(runtime.activeStore().inspect('district-1:civ:0').phase,'alive');on=false;assert.equal(run(1000),1);assert.equal(f.alive().length,0);assert.equal(runtime.activeStore().inspect('district-1:civ:0').terminal,'owner-remove');}
 else{const before=[...f.props],writes=f.writes.length;f.pop.addEntity({id:'preserved',typeId:'minecraft:villager_v2',x:0,y:70,z:0,tags:['civpop:v1:district-1:civ:0']});assert.throws(()=>runtime.activeStore(),/activation/);assert.equal(run(0),0);assert.match(String(driver.status().refused),/activation/);on=false;assert.equal(run(1000),0);assert.equal(f.alive().length,1);assert.equal(f.pop.state.spawned.length,0);assert.equal(f.pop.state.removals.length,0);assert.deepEqual([...f.props],before);assert.equal(f.writes.length,writes);}
});
