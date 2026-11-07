import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const destinationURL=new URL('../../CivilizationApocalypse_BP/scripts/people/destinations.js',import.meta.url).href;
// Explicit synthetic op-stream seam ONLY for controller/driver fault isolation.
// All production destination compiler/provenance logic and private WeakMaps remain.
// A separate actual-source test uses its DEFAULT imports and no seam.
register('data:text/javascript,'+encodeURIComponent(`import{readFile}from'node:fs/promises';export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}export async function load(u,c,n){if(u===${JSON.stringify(destinationURL)}){let source=await readFile(new URL(u),'utf8');const from='import {isLiveSite,siteOpSlices,SITE_STAGES} from "../civ/districtplan.js";';if(!source.includes(from))throw Error('stream seam drift');source=source.replace(from,'import {isLiveSite,SITE_STAGES} from "../civ/districtplan.js";const siteOpSlices=(...args)=>globalThis.__workDestinationStream(...args);');return{format:'module',source,shortCircuit:true};}return n(u,c);}`));
const {validFullPlan}=await import('./civfixture.mjs');
const {makeField}=await import('./fakefield.mjs');
const {planDistrictSite,SITE_STAGES}=await import('../../CivilizationApocalypse_BP/scripts/civ/districtplan.js');
const {BLUEPRINTS2,rotateInBox,rotatedSize}=await import('../../CivilizationApocalypse_BP/scripts/structures/blueprints2.js');
const {createCivilianDestinations}=await import('../../CivilizationApocalypse_BP/scripts/integration/civilianDestinations.js');
const {createCivilianTravel}=await import('../../CivilizationApocalypse_BP/scripts/integration/civilianTravel.js');
const {savedDestinationsSteps}=await import('../../CivilizationApocalypse_BP/scripts/people/destinations.js');
const finish=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
const site=planDistrictSite(validFullPlan(1),1,makeField(3,{relief:0,forest:0,river:null}));assert.equal(site.ok,true);
const record=site.record,original=structuredClone(record);
const homeTemplate=original.lots.find(e=>/^building-(house_s|house_m|house_l|longhouse)$/.test(e.kind));
const farmTemplate=original.lots.find(e=>/^building-/.test(e.kind)&&/^farm_/.test(e.blueprint));assert.ok(homeTemplate&&farmTemplate);
function descriptor(template,id,x,z,frontage){const e=structuredClone(template),bp=BLUEPRINTS2[e.blueprint];e.id=id;e.lot=id+'-lot';e.rot=0;e.baseY=69;const size=rotatedSize(bp,0),entrance=bp.entrances[0];e.bbox={x0:x,z0:z,x1:x+size.w-1,z1:z+size.d-1};e.door={x:x+entrance.at[0],z:z+entrance.at[2]};e.exit={x:x+entrance.at[0],z:z+bp.size[2]-1};e.frontage={...frontage,via:'road-main'};e.total=2;return e;}
let stream=[];
globalThis.__workDestinationStream=function*(){for(const slice of stream)yield structuredClone(slice);};
export function fixture(length=4){
 for(const stage of SITE_STAGES)record[stage]=[];
 const home=descriptor(homeTemplate,'building-home-fixture',-20,-20,{x:0,z:0}),farm=descriptor(farmTemplate,'building-farm-fixture',20,-20,{x:length,z:0});record.lots=[home,farm];record.roads=[{id:'road-main',total:2}];
 stream=[{stage:'roads',element:'road-main',ops:[{x:0,y:69,z:0,id:'minecraft:stone_bricks',kind:'road'},{x:length,y:69,z:0,id:'minecraft:stone_bricks',kind:'road'}]},
 {stage:'lots',element:home.id,ops:[{...home.door,y:70,id:'minecraft:wooden_door',kind:'building',states:{upper_block_bit:false}},{...home.door,y:71,id:'minecraft:wooden_door',kind:'building',states:{upper_block_bit:true}}]},
 {stage:'lots',element:farm.id,ops:[{...farm.door,y:70,id:'minecraft:birch_fence_gate',kind:'building'}]}];
 const district={id:'district-1',security:'secure',assault:0,civilians:100,builders:0,soldiers:30,buildings:{farms:10,storehouses:2,barracks:1,walls:2},civ:{status:'complete',stage:'complete',dimension:'minecraft:overworld',checksum:record.checksum,opsTotal:10,ops:10}};
 const kingdom={step:8,districts:[district]};
 const state={gate:true,busy:false,reads:0,maxReads:0,impulses:[],entities:[],writes:0,sourceReads:0,hook:()=>{},velocityHook:()=>{},finishHook:()=>{},sliceHook:()=>{},onBind:()=>{},controller:undefined};
 const props=new Map([['civ:plan:meta','verified-master-envelope'],['civ:plan:a:0','saved-source-bytes'],['civ:jobs:meta','completed-queue-envelope']]);
 const world={getDynamicPropertyIds:()=>[...props.keys()],getDynamicProperty:k=>{state.sourceReads++;return props.get(k);},setDynamicProperty(){state.writes++;throw Error('no property writes');},getDimension:()=>dimension};
 let position={x:0.5,y:70,z:0.5},velocity={x:0,y:0.125,z:0};
 const entity={id:'existing-owner-actor',isValid:true,typeId:'minecraft:villager_v2',get location(){return {...position};},getTags:()=>['civpop:v1:district-1:civ:0'],getVelocity(){state.velocityHook();return {...velocity};},applyImpulse(value){assert.equal(value.y,0);state.impulses.push(value);velocity.x+=value.x;velocity.z+=value.z;},teleport(){throw Error('no teleport');},remove(){throw Error('no removal');}};
 const dimension={id:'minecraft:overworld',getEntities(){return state.entities;},getBlock(p){state.reads++;state.hook(p);return{isValid:true,typeId:p.y===69?'minecraft:stone_bricks':'minecraft:air'};}};
 entity.dimension=dimension;state.entities=[entity];
 const driver=createCivilianTravel({world,readKingdom:()=>kingdom,admittedGroups:()=>['district-1:civ:0'],isGateOn:()=>state.gate,isBusy:()=>state.busy,});
 const player={typeId:'minecraft:player',isValid:true,dimension};
 const saved={ok:true,district:1,record,queue:{state:'complete',planHash:record.checksum}};
 const deps={world,readKingdom:()=>kingdom,loadSaved:function*(){yield;yield;return saved;},runJob:async(token,g)=>{for(;;){const n=g.next();if(n.done)return n.value;state.sliceHook(token);}},reserveJob:()=>{if(state.busy)return;state.busy=true;return{cancelled:false};},finishJob(){state.busy=false;state.finishHook();},canPreviewRoute:()=>!state.busy&&!driver.isActive()};
 const controller=createCivilianDestinations(deps);state.controller=controller;
 const command=async()=>driver.command(`start district=1 group=0 home=0,70,0 farm=${length},70,0`);
 return{record,get slices(){return structuredClone(stream);},compiled:()=>finish(savedDestinationsSteps(record,{index:1,checksum:record.checksum})),state,props,kingdom,district,entity,dimension,world,driver,controller,player,deps,saved,command,home,farm,set position(v){position=v;},get position(){return position;},advance(){position={...position,x:position.x+velocity.x*4,z:position.z+velocity.z*4};},tick(n){const before=state.reads;driver.onTick(n);const reads=state.reads-before;state.maxReads=Math.max(state.maxReads,reads);assert.ok(reads<=256,'all corridor, exact floor and braking reads share256');}};
}
