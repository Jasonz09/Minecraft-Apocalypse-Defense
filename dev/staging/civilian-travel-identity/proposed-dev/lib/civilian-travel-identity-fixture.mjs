import assert from 'node:assert/strict';
import {createPopWorld} from './poptharness.mjs';
import {starterKingdom,HOMES,NEAR_D1} from './streetsfixture.mjs';
import {createCivilianTravel,TRAVEL_IDENTITY} from '../../CivilizationApocalypse_BP/scripts/integration/civilianTravel.js';
import {createPeopleStreets} from '../../CivilizationApocalypse_BP/scripts/integration/peopleStreets.js';
export function fixture() {
    const pop=createPopWorld({homes:HOMES}),kingdom=starterKingdom({built:['district-1']});kingdom.step=8;
    kingdom.districts[0].civ={status:'complete',stage:'complete',seed:1,checksum:'travel-fixture',anchor:{x:0,z:0},centre:{x:0,z:0},startedStep:0,dimension:'minecraft:overworld'};
    pop.setKingdom(kingdom);pop.setPlayers([NEAR_D1]);pop.loadArea(-32,-32,64,64);
    const state={gate:true,busy:false,reads:0,unloaded:false,unloadedAt:()=>false,obstacles:new Map(),impulses:[],physics:new Map()};
    const dimension={...pop.dimension};
    dimension.getBlock=p=>{state.reads++;if(state.unloaded||state.unloadedAt(p))return undefined;const id=state.obstacles.get(`${p.x},${p.y},${p.z}`);return id?{typeId:id,isValid:true}:pop.dimension.getBlock(p);};
    dimension.getEntities=query=>pop.dimension.getEntities(query).filter(h=>!query.type||h.typeId===query.type).map(h=>{
        const physics=state.physics.get(h.id)??{x:0,y:0.125,z:0};state.physics.set(h.id,physics);
        return {...h,dimension,getVelocity:()=>({...physics}),applyImpulse:v=>{assert.equal(v.y,0);state.impulses.push({id:h.id,...v});physics.x+=v.x;physics.z+=v.z;},
            teleport(){throw Error('travel may not teleport');},kill(){throw Error('travel may not kill');}};
    });
    const world={...pop.world,getDimension:()=>dimension};
    let streets=createPeopleStreets({homes:()=>HOMES,isGateOn:()=>state.gate});
    const reconcile=()=>streets.onHour({world,dimension,kingdom,report:{},tick:1000+pop.state.propertyWrites.length});
    for(let i=0;i<8;i++)reconcile();
    const groupId=streets.admittedGroups(world).find(id=>id==='district-1:civ:0');assert.ok(groupId);
    const tag=TRAVEL_IDENTITY.prefix+groupId,entity=dimension.getEntities({type:TRAVEL_IDENTITY.type,tags:[tag]})[0];assert.ok(entity);
    const home={x:Math.floor(entity.location.x),y:70,z:Math.floor(entity.location.z)},farm={...home,x:home.x+6};
    const command=`start district=1 group=0 home=${home.x},70,${home.z} farm=${farm.x},70,${farm.z}`;
    const make=()=>createCivilianTravel({world,readKingdom:()=>kingdom,admittedGroups:()=>streets.admittedGroups(world),isGateOn:()=>state.gate,isBusy:()=>state.busy});
    const travel=make();
    const advance=()=>{for(const [id,v] of state.physics){const r=pop.state.entities.get(id);if(r){r.x+=v.x*4;r.z+=v.z*4;}}};
    const ownership=()=>({spawns:[...pop.state.spawned],removals:[...pop.state.removals],tags:[...pop.state.tagWrites],props:new Map(pop.state.props),kingdom:JSON.stringify(kingdom)});
    return {pop,world,dimension,kingdom,state,entity,groupId,home,farm,command,travel,make,advance,ownership,reconcile,
        newStreets(){streets=createPeopleStreets({homes:()=>HOMES,isGateOn:()=>state.gate});}};
}
