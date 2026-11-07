import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const {fixture}=await import('../lib/civilian-travel-identity-fixture.mjs');
const original=new URL('../../CivilizationApocalypse_BP/scripts/integration/civilianTravel.js',import.meta.url),frozen=JSON.parse(readFileSync(new URL('../fixtures/civilian-travel-before-velocity-trace.json',import.meta.url),'utf8'));
const previous=frozen.source.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${s.startsWith('.')?new URL(s,original).href:s}${q}`),before=await import('data:text/javascript;base64,'+Buffer.from(previous).toString('base64')),after=await import(original.href);
function instrument(module=after){
 const f=fixture(),calls=[],vectors=[],hooks={};
 const getBlock=f.dimension.getBlock;f.dimension.getBlock=p=>{calls.push(['getBlock',p.x,p.y,p.z]);return getBlock(p);};
 const query=f.dimension.getEntities;f.dimension.getEntities=q=>{calls.push(['query',JSON.stringify(q)]);return query(q).map(entity=>{
  const h={};for(const name of['id','typeId','isValid','dimension','location'])Object.defineProperty(h,name,{get(){calls.push(['actor',name]);return entity[name];}});h.getTags=()=>{calls.push(['tags']);return entity.getTags();};
  Object.defineProperty(h,'applyImpulse',{get(){calls.push(['method','applyImpulse']);return impulse=>{calls.push(['impulse',impulse.x,impulse.y,impulse.z]);return entity.applyImpulse(impulse);};}});
  Object.defineProperty(h,'getVelocity',{get(){calls.push(['method','getVelocity']);return()=>{calls.push(['getVelocity']);if(hooks.returnRaw)return hooks.returnRaw();const raw=entity.getVelocity();vectors.push(raw);hooks.read?.(raw);const result={};for(const axis of['x','y','z'])Object.defineProperty(result,axis,{get(){calls.push(['velocityAxis',axis]);hooks[axis]?.(raw);return raw[axis];}});return result;};}});return h;
 });};
 const d=module.createCivilianTravel({world:f.world,readKingdom:()=>{calls.push(['kingdom']);return f.kingdom;},admittedGroups:()=>{calls.push(['admit']);return[f.groupId];},isGateOn:()=>{calls.push(['gate']);return f.state.gate;},isBusy:()=>{calls.push(['busy']);return f.state.busy;}});return{f,d,calls,vectors,hooks};
}
function scenario(module,mode){const c=instrument(module),{f,d}=c;if(mode==='home')f.kingdom.step=17;d.command(f.command);d.onTick(0);f.advance();if(mode==='outside')f.pop.state.entities.get(f.entity.id).z+=4;if(mode==='gate')f.state.gate=false;if(mode==='obstacle')f.state.obstacles.set(`${Math.floor(f.entity.location.x)},70,${Math.floor(f.entity.location.z)}`,'minecraft:stone_bricks');if(mode==='replacement'){const r=f.pop.state.entities.get(f.entity.id);r.alive=false;f.pop.addEntity({id:'replacement',typeId:'minecraft:villager_v2',x:r.x,y:r.y,z:r.z,tags:['civpop:v1:'+f.groupId]});}for(let t=4;t<=16;t+=4){d.onTick(t);f.advance();}d.stop();return c;}
for(const mode of['work','home','outside','gate','obstacle','replacement'])test('SAME nativeAPI/axisgetter/control sequence and actualimpulses: '+mode,()=>{const a=scenario(before,mode),b=scenario(after,mode);assert.deepEqual(b.calls,a.calls);assert.deepEqual(b.f.state.impulses,a.f.state.impulses);assert.deepEqual(b.f.ownership(),a.f.ownership());assert.deepEqual(b.d.statusLines(),a.d.statusLines());assert.equal(b.calls.filter(r=>r[0]==='velocityAxis'&&r[1]==='y').length,0);});
test('exact SAME-read x/z primitive snapshot, unambiguous pre-impulse label and zeroquery formatter',()=>{
 const c=instrument();c.d.command(c.f.command);c.f.state.physics.set(c.f.entity.id,{x:.18,y:.125,z:-.03});c.d.onTick(0);const calls=structuredClone(c.calls),lines=c.d.command('trace');assert.deepEqual(c.calls,calls);assert.match(lines.join('\n'),/pre-impulse horizontal velocity from existing read x=0\.18, z=-0\.03; y=not sampled/);assert.equal(c.calls.filter(r=>r[0]==='getVelocity').length,1);assert.deepEqual(c.calls.filter(r=>r[0]==='velocityAxis').map(r=>r[1]),['x','z']);
 const frozen=JSON.stringify(lines);for(const raw of c.vectors){raw.x=900;raw.z=900;}assert.equal(JSON.stringify(c.d.command('trace')),frozen,'raw nativevector changes cannot alter retained primitives');
});
for(const axis of['x','z'])test(axis+' velocity getter race preserves final identity/gate refusal and noapply',()=>{
 const c=instrument();c.d.command(c.f.command);c.hooks[axis]=()=>{c.f.state.gate=false;};c.d.onTick(0);assert.equal(c.f.state.impulses.length,0);assert.match(c.d.statusLines().join('\n'),/paused/);assert.equal(c.calls.filter(r=>r[0]==='getVelocity').length,1);
});
test('blocked beforeexistingread remains unavailable; partial/throwingvector never claims a complete sample',()=>{
 const c=instrument();c.d.command(c.f.command);c.f.pop.state.entities.get(c.f.entity.id).z+=4;c.d.onTick(0);assert.equal(c.calls.filter(r=>r[0]==='getVelocity').length,0);assert.match(c.d.command('trace').join('\n'),/velocity unavailable \(not separately sampled\)/);
 const a=instrument();a.d.command(a.f.command);a.hooks.z=()=>{throw Error('unreadableZ');};a.d.onTick(0);assert.equal(a.f.state.impulses.length,0);assert.match(a.d.command('trace').join('\n'),/velocity unavailable \(not separately sampled\)/);assert.doesNotMatch(a.d.command('trace').join('\n'),/pre-impulse horizontal velocity/);
});
test('invalidexistingvelocity is not logged as verified primitives or applied; bufferstop bounds remain',()=>{
 const c=instrument();c.d.command(c.f.command);c.hooks.x=raw=>{raw.x=NaN;};c.d.onTick(0);assert.equal(c.f.state.impulses.length,0);assert.match(c.d.command('trace').join('\n'),/velocity unavailable/);assert.doesNotMatch(c.d.command('trace').join('\n'),/x=NaN/);c.d.stop();assert.match(c.d.command('trace')[0],/stopped yes/);assert.ok(c.d.command('trace').length<=20);
});
test('no force/AI/height/tolerance/timer/property/actorauthority added by diagnostic',()=>{
 const source=readFileSync(original,'utf8');assert.equal((source.match(/\.getVelocity\(/g)||[]).length,1);assert.ok(source.includes('travelImpulse(velocity,desired)'));assert.ok(source.includes('get x(){return velocityX=observedVelocity.x;}'));assert.ok(source.includes('get z(){return velocityZ=observedVelocity.z;}'));assert.equal(source.includes('observedVelocity.y'),false);for(const bad of['clearVelocity(','setCurrentValue(','runInterval(','runTimeout(','teleport(','spawnEntity(','setDynamicProperty('])assert.equal(source.includes(bad),false,bad);
});

for(const mode of['null','undefined','false','empty','missingZ','strings','coercionChangesZ','coercionThrows'])test('invalidraw arithmetic/control parity and unavailable honestyscope: '+mode,()=>{
 function run(module){const c=instrument(module),reads=[];c.d.command(c.f.command);c.hooks.returnRaw=()=>{if(mode==='null')return null;if(mode==='undefined')return undefined;if(mode==='false')return false;if(mode==='empty')return{};if(mode==='missingZ')return{x:0};if(mode==='strings')return{x:'0.1',z:'-0.03'};let z=0;const value={valueOf(){reads.push('coerceX');if(mode==='coercionThrows')throw 0;z=.2;return .1;}};return{get x(){reads.push('nativeX');return value;},get z(){reads.push('nativeZ');return z;}};};c.d.onTick(0);return{c,reads};}
 const a=run(before),b=run(after);assert.deepEqual(b.c.calls,a.c.calls);assert.deepEqual(b.reads,a.reads);assert.deepEqual(b.c.f.state.impulses,a.c.f.state.impulses);assert.deepEqual(b.c.d.statusLines(),a.c.d.statusLines());assert.match(b.c.d.command('trace').join('\n'),/velocity unavailable/);assert.doesNotMatch(b.c.d.command('trace').join('\n'),/pre-impulse horizontal velocity/);
});
