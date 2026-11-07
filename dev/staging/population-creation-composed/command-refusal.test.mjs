import test from 'node:test';
import assert from 'node:assert/strict';
import {world,system} from './native-stub.mjs';
import {registerPeopleCommand} from './proposed/commands/people.js';
import {createCreationRuntime as unconfigured} from './proposed/integration/creationRuntime.js';
import {createCreationRuntime as configured} from './proposed/integration/creationRuntime.js?synthetic';
import {createInitialKingdom,serializeKingdom} from '../../../CivilizationApocalypse_BP/scripts/kingdom/state.js';

test('actual creation callback replies to unconfigured, busy, evolved and partial real-runtime refusals without mutations',()=>{
 const lines=[];let receive,active;
 world.sendMessage=s=>lines.push(s);system.afterEvents={scriptEventReceive:{subscribe(fn){receive=fn;}}};
 registerPeopleCommand({statusLines:()=>[],creationCommand:(text,player)=>active.command(text,player)});
 for(const kind of ['unconfigured','busy','evolved','partial']){
  const k=createInitialKingdom();if(kind==='evolved')k.step=1;
  const props=new Map([['civ:kingdom',serializeKingdom(k)],['civ_devgate',true]]);
  if(kind==='partial')props.set('civ:creation_activation:v1','intent');
  const player={id:'caller',isValid:true,dimension:{id:'minecraft:overworld'}},writes=[];
  const native={getDynamicPropertyIds:()=>[...props.keys()],getDynamicProperty:key=>props.get(key),setDynamicProperty:(...args)=>writes.push(args)};
  active=(kind==='evolved'?configured:unconfigured)({world:native,isDeveloper:()=>true,isPeopleOn:()=>false,isBusy:()=>kind==='busy',readKingdom:()=>k});
  const before=[...props],count=lines.length;
  receive({id:'civ:people',message:kind==='partial'?'creation legacy confirm epoch=legacy':'creation fresh confirm',sourceEntity:player});
  assert.equal(lines.length,count+1,kind);assert.match(lines.at(-1),/^Creation history refused:/,kind);
  assert.match(lines.at(-1),kind==='unconfigured'?/receipt configured/:kind==='busy'?/no active job/:kind==='evolved'?/fresh initial property changed/:/legacy fallback prohibited/,kind);
  assert.deepEqual([...props],before,kind);assert.equal(writes.length,0,kind);
 }
});
