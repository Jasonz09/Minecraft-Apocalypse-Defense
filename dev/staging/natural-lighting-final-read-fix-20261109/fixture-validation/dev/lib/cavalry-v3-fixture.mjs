import{createPrivateFreshV3Fixture as createPrivateFreshFixture,OBJECTIVE}from'../../CivilizationApocalypse_BP/scripts/integration/privateFreshV3Fixture.js?synthetic';
import{d}from'../fixtures/cavalry-v3-synthetic-trust.mjs';import{createInitialKingdom,serializeKingdom}from'../../CivilizationApocalypse_BP/scripts/kingdom/state.js';
export function fixture(){
 const props=new Map([['civ:kingdom',serializeKingdom(createInitialKingdom())],['civ_devgate',true]]),writes=[],calls=[];
 const dims=Object.fromEntries(['overworld','nether','the_end'].map(name=>[name,{id:'minecraft:'+name,getEntities(query){calls.push(['census',name,query]);return[];}}]));
 const player={id:'caller',isValid:true,dimension:dims.overworld};let gate=true,people=false,busy=false;
 const participant={id:17,type:'FakePlayer',isValid:true,displayName:d.participant},objective={id:OBJECTIVE,isValid:true,displayName:d.nonce,getScores(){return[{participant,score:0}];}};
 const world={getDynamicPropertyIds(){return[...props.keys()];},getDynamicProperty(key){calls.push(['read',key]);return props.get(key);},setDynamicProperty(key,value){writes.push({key,value});props.set(key,value);},getAllPlayers(){return[player];},getDimension(name){return dims[name];},scoreboard:{getObjective(){return objective;},getObjectives(){return[objective];}}};
 const deps={world,isDeveloper:()=>gate,isPeopleOn:()=>people,isBusy:()=>busy},adapter=createPrivateFreshFixture(deps);return{adapter,world,deps,player,dims,props,writes,calls,participant,objective,setGate:x=>gate=x,setPeople:x=>people=x,setBusy:x=>busy=x};
}