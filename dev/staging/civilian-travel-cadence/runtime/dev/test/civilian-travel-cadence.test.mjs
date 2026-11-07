import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const {fixture}=await import('../lib/civilian-travel-identity-fixture.mjs');
const original=new URL('../../CivilizationApocalypse_BP/scripts/integration/civilianTravel.js',import.meta.url);
const baseline=JSON.parse(readFileSync(new URL('../fixtures/civilian-travel-before-cadence.json',import.meta.url),'utf8'));
let source=baseline.source.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${(s.startsWith('.')?new URL(s,original).href:s)}${q}`);
const before=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const after=await import(original.href);
const {TRAVEL_LIMITS,parseTravelNear,travelNearRoutes}=await import('../../CivilizationApocalypse_BP/scripts/people/travel.js');
function instrument(module=after){
 const f=fixture(),calls=[];const b=f.dimension.getBlock,q=f.dimension.getEntities;
 f.dimension.getBlock=p=>{calls.push(['block',p.x,p.y,p.z]);return b(p);};
 f.dimension.getEntities=query=>{calls.push(['query',JSON.stringify(query)]);return q(query).map(e=>{
  const h={};for(const k of ['id','typeId','dimension','location','isValid'])Object.defineProperty(h,k,{enumerable:true,get(){calls.push(['getter',k]);return e[k];}});
  h.getTags=()=>{calls.push(['tags']);return e.getTags();};
  h.getVelocity=()=>{calls.push(['velocity']);return e.getVelocity();};
  h.applyImpulse=v=>{calls.push(['impulse',v.x,v.y,v.z]);return e.applyImpulse(v);};return h;
 });};
 const d=module.createCivilianTravel({world:f.world,readKingdom:()=>{calls.push(['kingdom']);return f.kingdom;},admittedGroups:()=>{calls.push(['admitted']);return [f.groupId];},isGateOn:()=>{calls.push(['gate']);return f.state.gate;},isBusy:()=>{calls.push(['busy']);return f.state.busy;}});
 return{f,d,calls};
}
const near='start-near district=1 group=0 length=1';
function tick(c,n){const reads=c.f.state.reads;c.d.onTick(n);assert.ok(c.f.state.reads-reads<=256,'per callback all probes/braking within256');}
function replace(c){const old=c.f.pop.state.entities.get(c.f.entity.id);old.alive=false;c.f.pop.addEntity({id:'replacement',typeId:'minecraft:villager_v2',x:old.x,y:old.y,z:old.z,tags:['civpop:v1:'+c.f.groupId]});}
test('parse preserves default result shape and only exact trailing start-near cadence1 opts in',()=>{
 assert.deepEqual(parseTravelNear(near),{kind:'start-near',groupId:'district-1:civ:0',length:1});assert.equal(parseTravelNear(near+' cadence=1').cadence,1);assert.equal(parseTravelNear('start-near district=1 group=0 cadence=1').cadence,1);
 for(const text of [near+' cadence=4',near+' cadence=01',near+' cadence=2',near+' cadence=1 cadence=1','inspect district=1 group=0 cadence=1','start-near district=1 group=0 cadence=1 length=1'])assert.ok(parseTravelNear(text).error,text);
 assert.deepEqual(TRAVEL_LIMITS,{interval:4,maxLength:24,maxReads:256,nearMaxLength:8,nearDefaultLength:4,nearFinalReads:64,speed:.04,maxImpulse:.3,arrival:.15,offRoute:.75});
});
for(const mode of ['work','home','outside','obstacle','replacement','gate'])test(`default exact native control and trace parity: ${mode}`,()=>{
 function run(module){const c=instrument(module);if(mode==='home')c.f.kingdom.step=17;c.d.command(near);
  for(let n=0;n<=24;n++){if(n===1){if(mode==='outside')c.f.pop.state.entities.get(c.f.entity.id).z+=2;if(mode==='obstacle')c.f.state.obstacles.set(`${Math.floor(c.f.entity.location.x)},70,${Math.floor(c.f.entity.location.z)}`,'minecraft:stone_bricks');if(mode==='replacement')replace(c);if(mode==='gate')c.f.state.gate=false;}tick(c,n);}
  c.d.stop();return c;}
 const a=run(before),b=run(after);assert.deepEqual(b.calls,a.calls);assert.deepEqual(b.f.state.impulses,a.f.state.impulses);assert.deepEqual(b.d.statusLines(),a.d.statusLines());assert.deepEqual(b.d.command('trace'),a.d.command('trace'));assert.deepEqual(b.f.ownership(),a.f.ownership());
});
test('one-tick option processes every tick while default still skips intermediate callbacks with ZERO native calls',()=>{
 const a=instrument(),b=instrument();a.d.command(near);b.d.command(near+' cadence=1');tick(a,0);tick(b,0);const calls=a.calls.length;
 for(let n=1;n<=3;n++){tick(a,n);tick(b,n);}assert.equal(a.calls.length,calls);assert.match(a.d.command('trace')[0],/1\/16/);assert.match(b.d.command('trace')[0],/4\/16/);assert.match(b.d.statusLines().join('\n'),/cadence 1 tick; braking horizon 4 ticks/);assert.match(b.d.command('trace').join('\n'),/cadence 1 tick; braking horizon 4 ticks/);
});
test('cadence1 preserves exact4-tick braking horizon near arrival, geometry and horizontal bounded correction',()=>{
 const c=instrument(),origin={...c.f.entity.location};const expected=travelNearRoutes(c.f.groupId,origin,1).routes[0];assert.match(c.d.command(near+' cadence=1').join('\n'),/ready/);const r=c.f.pop.state.entities.get(c.f.entity.id);r.x=origin.x+.849;tick(c,0);
 const row=c.d.command('trace').find(s=>s.startsWith('tick ')),desired=Number(/desired ([^,]+),/.exec(row)[1]);assert.ok(Math.abs(desired-.151/4)<1e-8);assert.ok(c.d.command('trace').join('\n').includes(`farm ${expected.farm.x},${expected.farm.y},${expected.farm.z}`));assert.ok(c.f.state.impulses.every(v=>v.y===0&&Math.hypot(v.x,v.z)<=.3));
});
for(const mode of ['gate','busy','unloaded','obstacle','replacement','duplicate'])test(`cadence1 retains ${mode} refusal, readcap and ownership`,()=>{
 const c=instrument();c.d.command(near+' cadence=1');tick(c,0);const count=c.f.state.impulses.length,ownership=c.f.ownership();
 if(mode==='gate')c.f.state.gate=false;if(mode==='busy')c.f.state.busy=true;if(mode==='unloaded')c.f.state.unloaded=true;if(mode==='obstacle'){const p=c.f.entity.location;c.f.state.obstacles.set(`${Math.floor(p.x)},70,${Math.floor(p.z)}`,'minecraft:stone_bricks');}if(mode==='replacement')replace(c);if(mode==='duplicate'){const p=c.f.entity.location;c.f.pop.addEntity({id:'dup',typeId:'minecraft:villager_v2',...p,tags:['civpop:v1:'+c.f.groupId]});}
 tick(c,1);assert.equal(c.f.state.impulses.length,count);assert.match(c.d.statusLines().join('\n'),/off|paused/);assert.deepEqual(c.f.ownership(),ownership);
});
for(const mode of ['replacement','feet','gate','busy'])test(`cadence1 final velocity getter ${mode} cannot bypass last identity/gate barrier`,()=>{
 const c=instrument();c.d.command(near+' cadence=1');const q=c.f.dimension.getEntities;let fired=false;c.f.dimension.getEntities=query=>q(query).map(e=>({...e,getVelocity(){const v=e.getVelocity();if(!fired){fired=true;if(mode==='replacement')replace(c);if(mode==='feet')c.f.pop.state.entities.get(c.f.entity.id).x+=.125;if(mode==='gate')c.f.state.gate=false;if(mode==='busy')c.f.state.busy=true;}return v;}}));
 tick(c,0);assert.equal(fired,true);assert.equal(c.f.state.impulses.length,0);assert.match(c.d.statusLines().join('\n'),/paused/);
});
test('stop preserves labeled bounded trace; rejoin starts off and next default setup restores4 cadence',()=>{
 const c=instrument();c.d.command(near+' cadence=1');for(let n=0;n<24;n++)tick(c,n);c.d.stop();const lines=c.d.command('trace');assert.match(lines[0],/16\/16.*stopped yes/);assert.match(lines.join('\n'),/cadence 1 tick/);assert.match(c.d.statusLines().join('\n'),/^Civilian travel trial: off/);assert.equal(c.f.make().isActive(),false);
 c.d.command(near);tick(c,25);const calls=c.calls.length;tick(c,26);assert.equal(c.calls.length,calls);assert.doesNotMatch(c.d.statusLines().join('\n'),/Opt-in/);assert.doesNotMatch(c.d.command('trace').join('\n'),/Opt-in/);
});
test('failed or malformed setup never changes active cadence; formatter adds no native reads',()=>{
 const c=instrument();c.d.command(near+' cadence=1');const beforeLines=c.d.statusLines();c.f.state.busy=true;c.d.command(near);c.f.state.busy=false;c.d.command(near+' cadence=2');assert.deepEqual(c.d.statusLines(),beforeLines);const count=c.calls.length;c.d.command('trace');assert.equal(c.calls.length,count);
});
test('one same main timer at1 tick; no new owner/timer in driver; existing interval stays horizon4',()=>{
 const main=readFileSync(new URL('../../CivilizationApocalypse_BP/scripts/main.js',import.meta.url),'utf8'),driver=readFileSync(original,'utf8');assert.equal((main.match(/system\.runInterval\(\(\)=>civilianTravel\.onTick\(system\.currentTick\),1\);/g)||[]).length,1);assert.equal((main.match(/civilianTravel\.onTick/g)||[]).length,1);assert.ok(driver.includes('distance/TRAVEL_LIMITS.interval'));assert.ok(driver.includes('tick-lastTick<correctionInterval'));
 for(const forbidden of ['runInterval(','runTimeout(','spawnEntity(','setDynamicProperty(','teleport(','setCurrentValue(','clearVelocity('])assert.equal(driver.includes(forbidden),false,forbidden);
});

test('cadence1 cancellation during velocity getter disarms the pending impulse',()=>{
 const c=instrument();c.d.command(near+' cadence=1');const q=c.f.dimension.getEntities;let fired=false;
 c.f.dimension.getEntities=query=>q(query).map(e=>({...e,getVelocity(){const v=e.getVelocity();if(!fired){fired=true;c.d.stop();}return v;}}));tick(c,0);assert.equal(fired,true);assert.equal(c.f.state.impulses.length,0);assert.equal(c.d.isActive(),false);
});
