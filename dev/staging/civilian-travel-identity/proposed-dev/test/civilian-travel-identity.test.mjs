import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {TRAVEL_LIMITS} from '../../CivilizationApocalypse_BP/scripts/people/travel.js';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const {fixture}=await import('../lib/civilian-travel-identity-fixture.mjs');
function replace(f,id='replacement'){
 const old=f.pop.state.entities.get(f.entity.id);old.alive=false;
 f.pop.addEntity({id,typeId:'minecraft:villager_v2',x:old.x,y:old.y,z:old.z,tags:['civpop:v1:'+f.groupId]});return id;
}
function changed(f,kind){
 const record=f.pop.state.entities.get(f.entity.id);
 if(kind==='replacement')replace(f);
 else if(kind==='feet')record.x+=0.125;
 else if(kind==='duplicate')f.pop.addEntity({id:'late-duplicate',typeId:'minecraft:villager_v2',x:record.x,y:record.y,z:record.z,tags:['civpop:v1:'+f.groupId]});
 else if(kind==='unadmitted')f.world.setDynamicProperty('civ_pop',undefined);
 else if(kind==='gate')f.state.gate=false;
 else if(kind==='busy')f.state.busy=true;
}
test('a replacement after successful setup cannot inherit the pinned session',()=>{
 const f=fixture();assert.match(f.travel.command(f.command).join('\n'),/ready/);const id=f.entity.id;replace(f);
 const count=f.state.impulses.length;f.travel.onTick(0);f.travel.onTick(4);assert.equal(f.state.impulses.length,count);assert.match(f.travel.statusLines().join('\n'),/bound representative changed/);assert.ok(f.travel.statusLines().join('\n').includes(`bound actor ${id}`));
});
test('stop never brakes a replacement, even when that replacement has nonzero velocity',()=>{
 const f=fixture();f.travel.command(f.command);f.travel.onTick(0);const id=replace(f);f.state.physics.set(id,{x:0.08,y:0.125,z:0});const count=f.state.impulses.length;
 f.travel.command('stop');assert.equal(f.state.impulses.length,count);assert.equal(f.state.physics.get(id).x,0.08);assert.equal(f.travel.isActive(),false);assert.match(f.travel.statusLines().join('\n'),/off/);
});
test('only an explicit fresh same-route setup can bind a replacement',()=>{
 const f=fixture();f.travel.command(f.command);const id=replace(f);f.travel.onTick(0);const count=f.state.impulses.length;
 const lines=f.travel.command(f.command).join('\n');assert.match(lines,/ready/);assert.ok(lines.includes(`bound actor ${id}`));assert.match(lines,/explicit start\/start-near/);assert.equal(f.state.impulses.length,count);
 f.travel.onTick(4);assert.equal(f.state.impulses.at(-1).id,id);
});
test('same actor and route remain idempotent after full setup revalidation',()=>{
 const f=fixture();f.travel.command(f.command);f.travel.onTick(0);const count=f.state.impulses.length,reads=f.state.reads;
 assert.match(f.travel.command(f.command).join('\n'),/bound actor/);assert.equal(f.state.impulses.length,count);assert.ok(f.state.reads-reads<=256);
});
for(const kind of ['replacement','feet','duplicate','unadmitted'])test(`last native corridor getter ${kind} mutation cannot steer stale proof`,()=>{
 const f=fixture();f.travel.command(f.command);const original=f.dimension.getBlock;let fired=false;
 f.dimension.getBlock=p=>{const block=original(p);if(!fired){fired=true;changed(f,kind);}return block;};const count=f.state.impulses.length,reads=f.state.reads;
 f.travel.onTick(0);assert.equal(fired,true);assert.equal(f.state.impulses.length,count);assert.match(f.travel.statusLines().join('\n'),/paused/);assert.ok(f.state.reads-reads<=TRAVEL_LIMITS.maxReads);
});
for(const kind of ['replacement','feet','duplicate','unadmitted','gate','busy'])test(`velocity getter ${kind} mutation is checked before any impulse`,()=>{
 const f=fixture();f.travel.command(f.command);const query=f.dimension.getEntities;let fired=false;
 f.dimension.getEntities=q=>query(q).map(entity=>({...entity,getVelocity(){const value=entity.getVelocity();if(!fired){fired=true;changed(f,kind);}return value;}}));const count=f.state.impulses.length,reads=f.state.reads;
 f.travel.onTick(0);assert.equal(fired,true);assert.equal(f.state.impulses.length,count);assert.match(f.travel.statusLines().join('\n'),/paused/);assert.ok(f.state.reads-reads<=256);
});
test('late velocity replacement during stop cannot brake either old or new actor',()=>{
 const f=fixture();f.travel.command(f.command);f.travel.onTick(0);const query=f.dimension.getEntities;let fired=false;
 f.dimension.getEntities=q=>query(q).map(entity=>({...entity,getVelocity(){const v=entity.getVelocity();if(!fired){fired=true;replace(f);f.state.physics.set('replacement',{x:0.1,y:0.125,z:0});}return v;}}));
 const count=f.state.impulses.length;f.travel.stop();assert.equal(fired,true);assert.equal(f.state.impulses.length,count);assert.equal(f.state.physics.get('replacement').x,0.1);assert.equal(f.travel.isActive(),false);
});
test('cancel/rebind from velocity callback invalidates the pending impulse even for the same actor',()=>{
 const f=fixture();f.travel.command(f.command);const query=f.dimension.getEntities;let fired=false;
 f.dimension.getEntities=q=>query(q).map(entity=>({...entity,getVelocity(){const v=entity.getVelocity();if(!fired){fired=true;f.travel.stop();}return v;}}));const count=f.state.impulses.length;
 f.travel.onTick(0);assert.equal(fired,true);assert.equal(f.state.impulses.length,count);assert.equal(f.travel.isActive(),false);
});
test('status calls intent metadata honestly without adding census queries',()=>{
 const f=fixture();let queries=0;const query=f.dimension.getEntities;f.dimension.getEntities=q=>{queries++;return query(q);};
 assert.match(f.travel.command('status').join('\n'),/Admitted group intents \(not a fresh loaded-actor census\)/);assert.equal(queries,0);
 f.travel.command(f.command);queries=0;const lines=f.travel.command('status').join('\n');assert.equal(queries,1,'same one existing active-inspection query');assert.ok(lines.includes(`bound actor ${f.entity.id}`));assert.match(lines,/not a fresh loaded-actor census/);
});
for(const reason of ['gate','busy'])test(`revoked ${reason} releases steering to natural physics rather than bypassing the final gate for braking`,()=>{
 const f=fixture();f.travel.command(f.command);f.travel.onTick(0);const velocity=f.state.physics.get(f.entity.id).x;assert.ok(velocity>0);const count=f.state.impulses.length;
 if(reason==='gate')f.state.gate=false;else f.state.busy=true;
 f.travel.onTick(4);assert.equal(f.state.impulses.length,count);assert.equal(f.state.physics.get(f.entity.id).x,velocity,'no artificial braking after permission is revoked');assert.equal(f.travel.isActive(),false);
});
test('cancellation from the last canonical identity query cannot leave a pending impulse armed',()=>{
 const f=fixture();f.travel.command(f.command);const query=f.dimension.getEntities;let queries=0;
 f.dimension.getEntities=q=>{const result=query(q);if(++queries===2)f.travel.stop();return result;};
 const count=f.state.impulses.length;f.travel.onTick(0);assert.equal(f.state.impulses.length,count);assert.equal(f.travel.isActive(),false);assert.match(f.travel.statusLines().join('\n'),/off/);
});
for(const reason of ['gate','busy'])test(`the final canonical query revoking ${reason} is rechecked immediately before impulse`,()=>{
 const f=fixture();f.travel.command(f.command);const query=f.dimension.getEntities;let queries=0;
 f.dimension.getEntities=q=>{const result=query(q);if(++queries===2){if(reason==='gate')f.state.gate=false;else f.state.busy=true;}return result;};
 const count=f.state.impulses.length,reads=f.state.reads;f.travel.onTick(0);assert.equal(f.state.impulses.length,count);assert.match(f.travel.statusLines().join('\n'),/paused:.*final impulse barrier/);assert.ok(f.state.reads-reads<=TRAVEL_LIMITS.maxReads);
});
