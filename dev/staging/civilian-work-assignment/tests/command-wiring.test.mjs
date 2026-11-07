import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
const state={handler:null,messages:[],calls:[],gateWrites:[]};globalThis.__workCommandState=state;
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const ScriptEventSource={Entity:"Entity"};export const world={sendMessage:m=>globalThis.__workCommandState.messages.push(m),setDynamicProperty:(k,v)=>globalThis.__workCommandState.gateWrites.push([k,v])};export const system={afterEvents:{scriptEventReceive:{subscribe:(h,options)=>{globalThis.__workCommandState.handler=h;}}}};',shortCircuit:true};return n(s,c);}`));
const {registerPeopleCommand}=await import('../runtime/CivilizationApocalypse_BP/scripts/commands/people.js');
let finishWork;
const runtime={statusLines:()=>['status'],travelCommand:message=>{state.calls.push(['travel',message]);return['travel-sync'];},destinationsCommand:async text=>{state.calls.push(['preview',text]);return['preview-done'];},workCommand:(text,event)=>{state.calls.push(['work',text]);return new Promise(resolve=>finishWork=resolve);}};
assert.equal(registerPeopleCommand(runtime),true);
const send=message=>state.handler({id:'civ:people',message,sourceType:'Server'});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('actual command wrapper awaits work lines; never hands Promise to reply or falls through to manual travel',async()=>{
 state.messages.length=0;state.calls.length=0;send('travel work district=1 group=0 home=building-home farm=building-farm');await flush();
 assert.equal(state.calls.length,1);assert.equal(state.calls[0][0],'work');assert.equal(state.messages.length,1);assert.match(state.messages[0],/Verifying/);
 finishWork(['explicit-result','no-production']);await flush();assert.equal(state.messages.at(-1),'explicit-result\nno-production');assert.ok(state.messages.every(m=>typeof m==='string'&&!m.includes('[object Promise]')));assert.equal(state.gateWrites.length,0);
});
test('existing manual and destination branches keep their own formatting/dispatch',async()=>{state.calls.length=0;send('travel status');assert.deepEqual(state.calls.shift(),['travel','status']);send('travel destinations district=1 page=1');await flush();assert.deepEqual(state.calls.shift(),['preview','district=1 page=1']);assert.equal(state.messages.at(-1),'preview-done');});
test('main proposal wires completed loader, SAME timer/driver and private source freshness',()=>{
 const main=readFileSync(new URL('../proposed/CivilizationApocalypse_BP/scripts/main.js',import.meta.url),'utf8');
 assert.match(main,/workAssignmentCurrent:assignment=>civilianDestinations\.workAssignmentCurrent\(assignment\)/);
 assert.match(main,/bindWorkAssignment:civilianTravel\.bindWorkAssignment/);assert.match(main,/workCommand:civilianDestinations\.workCommand/);
 assert.match(main,/loadSaved:\(civ,index\)=>loadSavedRunSteps\(civ,newOps\(\),index\)/);
 assert.equal((main.match(/system\.runInterval\(\(\)=>civilianTravel\.onTick/g)??[]).length,1);
});
