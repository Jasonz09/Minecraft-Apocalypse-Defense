import assert from 'node:assert/strict';
import {register} from 'node:module';
import test from 'node:test';
import {parseTravelNear,parseTravelRoute,TRAVEL_LIMITS,travelImpulse,travelNearRoutes} from '../../CivilizationApocalypse_BP/scripts/people/travel.js';
import {createPopWorld} from '../lib/poptharness.mjs';
import {starterKingdom,HOMES,NEAR_D1} from '../lib/streetsfixture.mjs';
import {POP_ENTITY_TYPES,POP_TAG_PREFIX} from '../../CivilizationApocalypse_BP/scripts/population/settings.js';

register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return {url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const {createCivilianTravel,TRAVEL_IDENTITY}=await import('../../CivilizationApocalypse_BP/scripts/integration/civilianTravel.js');
const {createPeopleStreets}=await import('../../CivilizationApocalypse_BP/scripts/integration/peopleStreets.js');

function fixture() {
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

test('travel route parsing and identity constants preserve bounded existing population representation',()=>{
    assert.equal(TRAVEL_IDENTITY.type,POP_ENTITY_TYPES.civ);assert.equal(TRAVEL_IDENTITY.prefix,POP_TAG_PREFIX);
    for(const message of ['start district=1 group=0 home=0,70,0 farm=25,70,0','start district=1 group=0 home=0,70,0 farm=4,71,0',
        'start district=1 group=0 home=0,70,0 farm=4,70,4','start district=1 group=0 home=0,70,0 farm=0,70,0'])assert.ok(parseTravelRoute(message).error);
    const route=parseTravelRoute('start district=1 group=0 home=0,70,0 farm=24,70,0').route;assert.ok(route);
    assert.equal(route.farm.x,24.5);
    assert.equal(travelImpulse({x:0.1,z:0.2},{x:0,z:0}).y,0);
    assert.ok(Math.hypot(...Object.values(travelImpulse({x:10,z:-10},{x:0,z:0})))<=TRAVEL_LIMITS.maxImpulse+1e-12);
});

test('off by default does no world work; one streets-owned villager travels continuously farmward then follows its home routine',()=>{
    const f=fixture(),before=f.ownership();f.state.reads=0;
    for(let tick=0;tick<100;tick++)f.travel.onTick(tick);
    assert.equal(f.state.reads,0);assert.equal(f.state.impulses.length,0);
    assert.match(f.travel.command(f.command).join('\n'),/ready/);
    let previous=f.entity.location.x,maxReads=0;
    for(let tick=0;tick<1000;tick+=4){const reads=f.state.reads;f.travel.onTick(tick);maxReads=Math.max(maxReads,f.state.reads-reads);f.advance();const x=f.pop.state.entities.get(f.entity.id).x;assert.ok(Math.abs(x-previous)<=0.17);previous=x;}
    assert.match(f.travel.statusLines().join('\n'),/at farm/);assert.ok(maxReads<=TRAVEL_LIMITS.maxReads);
    assert.equal(f.state.physics.get(f.entity.id).y,0.125,'vertical velocity is untouched');
    assert.deepEqual(f.ownership(),before,'movement changes no tags, entities, properties, population or resources');
    f.kingdom.step=22;
    for(let tick=1000;tick<2000;tick+=4){f.travel.onTick(tick);f.advance();}
    assert.match(f.travel.statusLines().join('\n'),/at home/);
    const startX=f.pop.state.entities.get(f.entity.id).x,impulses=f.state.impulses.length;
    f.travel.onTick(1996);assert.equal(f.state.impulses.length,impulses,'repeat same tick cannot spend work twice');
    assert.ok(Math.abs(startX-(f.home.x+0.5))<=TRAVEL_LIMITS.arrival);
});

for(const kind of ['wall','water','hole','unloaded'])test(`travel stops safely for ${kind} and resumes only when the corridor is readable and safe`,()=>{
    const f=fixture();assert.match(f.travel.command(f.command).join('\n'),/ready/);f.travel.onTick(0);f.advance();
    const at={x:f.home.x+3,y:70,z:f.home.z};
    if(kind==='unloaded')f.state.unloaded=true;
    else if(kind==='wall')f.state.obstacles.set(`${at.x},70,${at.z}`,'minecraft:stone_bricks');
    else f.state.obstacles.set(`${at.x},69,${at.z}`,kind==='water'?'minecraft:water':'minecraft:air');
    const before=f.ownership();f.travel.onTick(4);
    assert.match(f.travel.statusLines().join('\n'),/paused/);assert.deepEqual(f.ownership(),before);
    if(kind!=='unloaded') {
        const blockedY=kind==='wall'?70:69;
        const blockedType=kind==='wall'?'stone_bricks':kind==='water'?'water':'air';
        assert.ok(f.travel.statusLines().join('\n').includes(`at ${at.x},${blockedY},${at.z} (minecraft:${blockedType}; ${kind==='wall'?'body clearance':'footing'})`),'reports the actual blocking cell and material without moving or changing ownership');
    }
    if(kind!=='unloaded')assert.equal(f.state.physics.get(f.entity.id).x,0,'loaded actor brakes before the obstruction');
    f.state.unloaded=false;f.state.obstacles.clear();f.travel.onTick(8);assert.match(f.travel.statusLines().join('\n'),/traveling to farm/);
});

test('cancel/build/people-off, absent admission, duplicates and invalid handles cannot create or seize an entity',()=>{
    for(const kind of ['stop','busy','gate','admission','duplicate','invalid']) {
        const f=fixture();f.travel.command(f.command);const before=f.ownership();
        if(kind==='stop')f.travel.command('stop');
        if(kind==='busy')f.state.busy=true;if(kind==='gate')f.state.gate=false;
        if(kind==='admission')f.world.setDynamicProperty('civ_pop',undefined);
        if(kind==='duplicate')f.pop.addEntity({id:'duplicate',x:f.entity.location.x,y:70,z:f.entity.location.z,tags:[TRAVEL_IDENTITY.prefix+f.groupId]});
        if(kind==='invalid')f.pop.state.entities.get(f.entity.id).alive=false;
        const impulses=f.state.impulses.length;f.travel.onTick(0);f.travel.onTick(4);
        assert.equal(f.state.impulses.length,impulses);
        assert.deepEqual(f.pop.state.spawned,before.spawns);assert.deepEqual(f.pop.state.removals,before.removals);assert.deepEqual(f.pop.state.tagWrites,before.tags);
        assert.equal(JSON.stringify(f.kingdom),before.kingdom);
    }
});

test('unload/rejoin readopts the same reconciled identity and repeated route setup creates no extra representative',()=>{
    const f=fixture();f.travel.command(f.command);
    for(let tick=0;tick<100;tick+=4){f.travel.onTick(tick);f.advance();}
    const id=f.entity.id,spawned=f.pop.state.spawned.length;
    f.pop.unloadArea(-32,-32,64,64);f.travel.onTick(100);
    f.pop.loadArea(-32,-32,64,64);f.newStreets();f.reconcile();
    assert.equal(f.pop.state.spawned.length,spawned);
    const restarted=f.make();const before=f.state.impulses.length;restarted.onTick(0);assert.equal(f.state.impulses.length,before,'rejoin starts off');
    assert.match(restarted.command(f.command).join('\n'),/ready/);
    restarted.onTick(0);f.advance();restarted.command(f.command);
    for(let tick=4;tick<1000;tick+=4){restarted.onTick(tick);f.advance();}
    assert.match(restarted.statusLines().join('\n'),/at farm/);assert.equal(f.pop.state.spawned.length,spawned);
    assert.ok(f.pop.state.entities.has(id));
});

test('a distant unloaded route cell brakes the still-loaded actor within the same bounded work budget',()=>{
    const f=fixture();f.travel.command(f.command);f.travel.onTick(0);f.advance();
    assert.ok(f.state.physics.get(f.entity.id).x>0);
    f.state.unloadedAt=p=>p.x===f.home.x+3;const before=f.state.reads;
    f.travel.onTick(4);assert.match(f.travel.statusLines().join('\n'),/corridor unloaded/);
    assert.equal(f.state.physics.get(f.entity.id).x,0);assert.equal(f.state.physics.get(f.entity.id).z,0);
    assert.ok(f.state.reads-before<=TRAVEL_LIMITS.maxReads);
});

test('routine shelter/meals and unavailable farming pause without production, while repeated setup is idempotent',()=>{
    const f=fixture();f.travel.command(f.command);f.travel.onTick(0);f.advance();
    const impulses=f.state.impulses.length;f.travel.command(f.command);assert.equal(f.state.impulses.length,impulses);
    f.kingdom.step=12;f.travel.onTick(4);assert.match(f.travel.statusLines().join('\n'),/routine market/);
    f.kingdom.step=8;f.kingdom.districts[0].security='breached';f.travel.onTick(8);assert.match(f.travel.statusLines().join('\n'),/routine shelter|no completed farming/);
    f.kingdom.districts[0].security='secure';f.kingdom.districts[0].buildings.farms=0;
    const before=f.ownership();f.travel.onTick(12);assert.match(f.travel.statusLines().join('\n'),/no completed farming/);
    assert.deepEqual(f.ownership(),before);
});

test('nearby route requests are bounded and preserve fractional feet with deterministic short prefixes',()=>{
    assert.deepEqual(parseTravelNear('inspect district=1 group=0'),{kind:'inspect',groupId:'district-1:civ:0',length:4});
    assert.equal(parseTravelNear('start-near district=5 group=12 length=8').length,8);
    for(const text of ['start-near district=1 group=0 length=0','start-near district=1 group=0 length=9','inspect district=1 group=0 length=1','start-near district=6 group=0','start-near district=1 group=00'])assert.ok(parseTravelNear(text).error,text);
    const p={x:4.123,y:70,z:4.456},routes=travelNearRoutes('district-1:civ:0',p,8).routes;
    assert.equal(routes.length,32);assert.deepEqual(routes[0].home,p);assert.deepEqual(routes[0].farm,{...p,x:p.x+1});
    assert.deepEqual(routes[7].farm,{...p,x:p.x+8});assert.deepEqual(routes[8].farm,{...p,x:p.x-1});
    for(const position of [{...p,y:70.5},{...p,x:NaN},{...p,x:29999979}])assert.ok(travelNearRoutes('district-1:civ:0',position,8).error);
});

test('inspect and active status read the unique current actor position without probes, impulses or ownership changes',()=>{
    const f=fixture(),before=f.ownership(),reads=f.state.reads,impulses=f.state.impulses.length;
    const at=f.pop.state.entities.get(f.entity.id);at.x+=0.123;at.z+=0.456;
    const first=f.travel.command('inspect district=1 group=0').join('\n');
    assert.match(first,/Read-only/);assert.ok(first.includes(`actor ${f.entity.id}`));assert.ok(first.includes(Number(at.x.toFixed(3)).toString()));
    assert.equal(f.state.reads,reads);assert.equal(f.state.impulses.length,impulses);assert.deepEqual(f.ownership(),before);
    assert.match(f.travel.command('start-near district=1 group=0').join('\n'),/ready/);
    const after=f.state.reads;at.x+=0.01;
    const status=f.travel.command('status').join('\n');assert.ok(status.includes(Number(at.x.toFixed(3)).toString()));
    assert.match(status,/routine labels only, not physical farming/);assert.equal(f.state.reads,after);assert.equal(f.state.impulses.length,impulses);
    f.pop.addEntity({id:'ambiguous-inspect',x:at.x,y:70,z:at.z,tags:[TRAVEL_IDENTITY.prefix+f.groupId]});
    assert.match(f.travel.command('inspect district=1 group=0').join('\n'),/no unique/);
});

test('start-near captures a naturally displaced representative in one turn and travels without setup teleport or production',()=>{
    const f=fixture(),at=f.pop.state.entities.get(f.entity.id);at.x+=9.23;at.z+=0.17;
    assert.match(f.travel.command(f.command).join('\n'),/outside/,'manual coordinates are now stale');
    const before=f.ownership(),position={x:at.x,y:at.y,z:at.z},reads=f.state.reads,impulses=f.state.impulses.length;
    assert.match(f.travel.command('start-near district=1 group=0 length=8').join('\n'),/ready/);
    assert.deepEqual({x:at.x,y:at.y,z:at.z},position,'setup does not relocate the actor');assert.equal(f.state.impulses.length,impulses);
    assert.ok(f.state.reads-reads<=TRAVEL_LIMITS.maxReads);
    for(let tick=0;tick<1600;tick+=4){f.travel.onTick(tick);f.advance();}
    assert.match(f.travel.statusLines().join('\n'),/at farm/);assert.ok(Math.abs(at.x-position.x-8)<=TRAVEL_LIMITS.arrival);assert.ok(Math.abs(at.z-position.z)<=0.001);
    assert.deepEqual(f.ownership(),before);
    f.kingdom.step=22;const restBefore=f.ownership();for(let tick=1600;tick<3200;tick+=4){f.travel.onTick(tick);f.advance();}
    assert.match(f.travel.statusLines().join('\n'),/at home/);assert.ok(Math.abs(at.x-position.x)<=TRAVEL_LIMITS.arrival);assert.deepEqual(f.ownership(),restBefore);
});

test('nearby discovery selects a safe deterministic alternate direction and uses one shared probe ceiling',()=>{
    const f=fixture(),at=f.entity.location;
    f.state.obstacles.set(`${Math.floor(at.x)+2},70,${Math.floor(at.z)}`,'minecraft:stone_bricks');
    const before=f.ownership(),reads=f.state.reads;
    const lines=f.travel.command('start-near district=1 group=0 length=8').join('\n');assert.match(lines,/ready/);
    assert.ok(lines.includes(`${at.x-8},70,${at.z}`),'blocked east prefix yields the full safe west corridor');
    assert.ok(f.state.reads-reads<=TRAVEL_LIMITS.maxReads);assert.deepEqual(f.ownership(),before);
    f.travel.onTick(0);assert.ok(f.state.physics.get(f.entity.id).x<0);
});

test('nearby search refuses unsafe or unavailable actors and ground without creating or moving anything',()=>{
    for(const kind of ['gate','busy','admission','duplicate','unloaded','unsafe','height']) {
        const f=fixture(),at=f.pop.state.entities.get(f.entity.id),before=f.ownership();
        if(kind==='gate')f.state.gate=false;if(kind==='busy')f.state.busy=true;
        if(kind==='admission')f.world.setDynamicProperty('civ_pop',undefined);
        if(kind==='duplicate')f.pop.addEntity({id:'near-duplicate',x:at.x,y:70,z:at.z,tags:[TRAVEL_IDENTITY.prefix+f.groupId]});
        if(kind==='unloaded')f.state.unloaded=true;
        if(kind==='unsafe')f.state.obstacles.set(`${Math.floor(at.x)},69,${Math.floor(at.z)}`,'minecraft:water');
        if(kind==='height')at.y=70.5;
        const reads=f.state.reads,position={x:at.x,y:at.y,z:at.z};
        assert.doesNotMatch(f.travel.command('start-near district=1 group=0 length=8').join('\n'),/trial: ready/,kind);
        assert.equal(f.state.impulses.length,0);assert.deepEqual({x:at.x,y:at.y,z:at.z},position);assert.ok(f.state.reads-reads<=TRAVEL_LIMITS.maxReads);
        assert.deepEqual(f.pop.state.spawned,before.spawns);assert.deepEqual(f.pop.state.removals,before.removals);assert.deepEqual(f.pop.state.tagWrites,before.tags);assert.equal(JSON.stringify(f.kingdom),before.kingdom);
    }
});

test('search-cache success is re-probed freshly and late obstruction or identity/position changes veto setup',()=>{
    for(const kind of ['block','move','duplicate']) {
        const f=fixture(),at=f.pop.state.entities.get(f.entity.id),floor={x:Math.floor(at.x-0.35),y:69,z:Math.floor(at.z-0.35)};
        let seen=0,edited=false;
        f.state.unloadedAt=p=>{if(p.x===floor.x&&p.y===floor.y&&p.z===floor.z&&++seen===2){
            edited=true;
            if(kind==='block')f.state.obstacles.set(`${floor.x},70,${floor.z}`,'minecraft:stone_bricks');
            if(kind==='move')at.x+=9;
            if(kind==='duplicate')f.pop.addEntity({id:'late-near-duplicate',x:at.x,y:70,z:at.z,tags:[TRAVEL_IDENTITY.prefix+f.groupId]});
        }return false;};
        const before=f.ownership(),reads=f.state.reads;
        const result=f.travel.command('start-near district=1 group=0 length=8').join('\n');
        assert.equal(edited,true,'edit occurs on the uncached final proof');assert.doesNotMatch(result,/trial: ready/,kind);
        assert.equal(f.state.impulses.length,0);assert.ok(f.state.reads-reads<=TRAVEL_LIMITS.maxReads);
        assert.deepEqual(f.pop.state.spawned,before.spawns);assert.deepEqual(f.pop.state.removals,before.removals);assert.deepEqual(f.pop.state.tagWrites,before.tags);
    }
});

test('branch exploration and replacing a running trial keep the total setup probes below the shared cap',()=>{
    const f=fixture(),at=f.entity.location;
    f.travel.command(f.command);f.travel.onTick(0);
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])f.state.obstacles.set(`${Math.floor(at.x)+dx*8},70,${Math.floor(at.z)+dz*8}`,'minecraft:stone_bricks');
    const reads=f.state.reads,before=f.ownership(),position={...f.entity.location};
    const result=f.travel.command('start-near district=1 group=0 length=8').join('\n');
    assert.match(result,/ready/);assert.ok(f.state.reads-reads<=TRAVEL_LIMITS.maxReads);
    assert.deepEqual(f.entity.location,position);assert.deepEqual(f.ownership(),before);
});

test('short grass setup and full swept body admit only exactvanillaID without changingplants orowner',()=>{for(const dy of[0,1]){const f=fixture(),at=f.entity.location,before=f.ownership();for(let x=Math.floor(at.x)-2;x<=Math.floor(at.x)+2;x++)for(let z=Math.floor(at.z)-2;z<=Math.floor(at.z)+2;z++)f.state.obstacles.set(`${x},${70+dy},${z}`,'minecraft:short_grass');const plants=[...f.state.obstacles],reads=f.state.reads;assert.match(f.travel.command('start-near district=1 group=0 length=1 cadence=1').join('\n'),/ready/);assert.ok(f.state.reads-reads<=256);f.travel.onTick(1);assert.ok(f.state.impulses.length>0);assert.deepEqual([...f.state.obstacles],plants);assert.deepEqual(f.ownership(),before);}});
test('short grass neveractsasfooting and no additionalflora/crops/vines/fences/liquid/hazard/unknown bodyfallback',async()=>{const {isTravelBodyAir,isTravelBodyClear,isKnownTravelFooting}=await import('../../CivilizationApocalypse_BP/scripts/people/walkSafety.js');assert.equal(isTravelBodyAir('minecraft:short_grass'),false);assert.equal(isTravelBodyClear('minecraft:short_grass'),true);assert.equal(isKnownTravelFooting('minecraft:short_grass'),false);for(const id of['minecraft:fern','minecraft:tall_grass','minecraft:large_fern','minecraft:short_dry_grass','minecraft:vine','minecraft:oak_fence','minecraft:oak_fence_gate','minecraft:oak_door','minecraft:wheat','minecraft:water','minecraft:lava','minecraft:fire','minecraft:powder_snow','minecraft:sweet_berry_bush','minecraft:short_grass_extra',undefined])assert.equal(isTravelBodyClear(id),false,String(id));});
test('late shortgrass replacement bysolid orhazard pauses beforeforwardmotion withinunchangedreadbudget',()=>{for(const id of['minecraft:oak_fence','minecraft:vine','minecraft:water','minecraft:lava','minecraft:unknown']){const f=fixture();f.state.obstacles.set(`${f.home.x+3},70,${f.home.z}`,'minecraft:short_grass');assert.match(f.travel.command(f.command).join('\n'),/ready/);f.state.obstacles.set(`${f.home.x+3},70,${f.home.z}`,id);const n=f.state.impulses.length,reads=f.state.reads;f.travel.onTick(0);assert.match(f.travel.statusLines().join('\n'),/paused/);assert.ok(f.state.reads-reads<=256);assert.ok(f.state.impulses.slice(n).every(v=>Math.abs(v.x)<1e-12&&Math.abs(v.z)<1e-12));}});
