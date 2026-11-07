import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
import {createCreationBindings,registerCreationDeaths,PREFIX,META,MAX_RECORDS,MAX_BYTES} from '../bindings.mjs';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const root=new URL('../../../../',import.meta.url),actual=new URL('CivilizationApocalypse_BP/scripts/integration/popSync.js',root);
let source=readFileSync(new URL('../proposed-popSync.js',import.meta.url),'utf8').replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${(s.startsWith('.')?new URL(s,actual).href:s)}${q}`);
const {createPopSync}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {createPopWorld}=await import(new URL('dev/lib/poptharness.mjs',root)),{createInitialKingdom}=await import(new URL('CivilizationApocalypse_BP/scripts/kingdom/state.js',root));
const {decodeMilitarySelection}=await import(new URL('CivilizationApocalypse_BP/scripts/population/militarySelection.js',root));
const GROUP='district-1:civ:0',TAG='civpop:v1:'+GROUP;
function fixture(mode='fresh',military=false,epoch='epoch-one'){
 const pop=createPopWorld(),k=createInitialKingdom();pop.world.getDynamicPropertyIds=()=>[...pop.state.props.keys()];for(const d of k.districts){d.civilians=d.id==='district-1'?10:0;d.soldiers=military&&d.id==='district-1'?5:0;d.garrison={front:d.soldiers,reserve:0};}pop.setKingdom(k);pop.loadArea(-64,-64,96,96);pop.setPlayers([{name:'player',x:0,y:70,z:0}]);
 const makeStore=()=>createCreationBindings(pop.world,{verifyFreshWorld:()=>({verified:true,fixtureId:'known-empty-fixture',dimension:'minecraft:overworld',ownerHistory:'never-started'})});let store=makeStore();store.initialize({mode,epoch,fixture:'known-empty-fixture'});
 const sync=()=>createPopSync({world:pop.world,dimension:pop.dimension,homes:()=>({'district-1':{x:0,y:70,z:0}}),enabled:true,creationBindings:store,...(military?{readMilitarySelection:()=>decodeMilitarySelection(JSON.stringify({v:1,trialId:'birth-probe',fixtureId:'known-empty-fixture',groupId:'district-1:sol:0',class:'swordsman',typeId:'civ_trial:swordsman',dimension:'minecraft:overworld'}))}:{})});
 const run=t=>sync().reconcileOnce(t);const alive=()=>[...pop.state.entities.values()].filter(e=>e.alive);const born=()=>alive().filter(e=>e.tags.has(TAG));
 const snapshot=e=>({groupId:GROUP,id:e.id,typeId:e.typeId,tags:[...e.tags]});return{pop,k,run,alive,born,snapshot,get store(){return store;},rejoin(){pop.restart();store=makeStore();},spawn(){const result=run(0);assert.equal(result.refused,null);assert.equal(born().length,1);return born()[0];}};
}

test('REPRO: metadata getter retag after final canonical query must preserve nowforeign actor before owner removal',()=>{
 const f=fixture(),old=f.spawn(),get=f.pop.world.getDynamicProperty,query=f.pop.dimension.getEntities;let armed=false,mutated=false;
 f.pop.dimension.getEntities=args=>{const rows=query(args);const raw=f.pop.state.props.get(PREFIX+GROUP);if(args.tags?.includes(TAG)&&raw&&JSON.parse(raw).phase==='removing')armed=true;return rows;};
 f.pop.world.getDynamicProperty=k=>{const raw=get(k);if(armed&&!mutated&&k===META){mutated=true;old.tags.delete(TAG);}return raw;};
 f.pop.setPlayers([{name:'far',x:2000,y:70,z:2000}]);const result=f.run(1000);
 assert.equal(mutated,true);assert.equal(old.tags.has(TAG),false);assert.equal(old.alive,true,'retagged foreign handle must not be removed');
});
