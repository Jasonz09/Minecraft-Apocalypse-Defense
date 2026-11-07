import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {register} from 'node:module';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};return n(s,c);}`));
const {fixture}=await import('../lib/civilian-travel-identity-fixture.mjs');
const original=new URL('../../CivilizationApocalypse_BP/scripts/integration/civilianTravel.js',import.meta.url);
const frozen=JSON.parse(readFileSync(new URL('../fixtures/civilian-travel-before-trace.json',import.meta.url),'utf8'));
async function variant(){let source=frozen.source;source=source.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${(s.startsWith('.')?new URL(s,original).href:s)}${q}`);return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));}
const before=await variant(),after=await import(original.href);
function instrument(module){
 const f=fixture(),calls=[];
 const block=f.dimension.getBlock;f.dimension.getBlock=p=>{calls.push(['getBlock',p.x,p.y,p.z]);return block(p);};
 const query=f.dimension.getEntities;f.dimension.getEntities=q=>{calls.push(['getEntities',JSON.stringify(q)]);return query(q).map(entity=>{
  const handle={};for(const field of ['id','typeId','dimension','location','isValid'])Object.defineProperty(handle,field,{enumerable:true,get(){calls.push(['entityGetter',field]);return entity[field];}});
  handle.getTags=()=>{calls.push(['getTags']);return entity.getTags();};
  Object.defineProperty(handle,'getVelocity',{get(){calls.push(['methodGetter','getVelocity']);return()=>{calls.push(['getVelocity']);const value=entity.getVelocity(),result={};for(const axis of ['x','y','z'])Object.defineProperty(result,axis,{get(){calls.push(['velocityGetter',axis]);return value[axis];}});return result;};}});
  Object.defineProperty(handle,'applyImpulse',{get(){calls.push(['methodGetter','applyImpulse']);return impulse=>{calls.push(['applyImpulse',impulse.x,impulse.y,impulse.z]);return entity.applyImpulse(impulse);};}});return handle;
 });};
 const driver=module.createCivilianTravel({world:f.world,readKingdom:()=>{calls.push(['readKingdom']);return f.kingdom;},admittedGroups:()=>{calls.push(['admittedGroups']);return f.world.getDynamicProperty('civ_pop')===undefined?[]:[f.groupId];},isGateOn:()=>{calls.push(['gate']);return f.state.gate;},isBusy:()=>{calls.push(['busy']);return f.state.busy;}});
 return{f,calls,driver};
}
function scenario(module,mode){const c=instrument(module),{f,driver}=c;
 if(mode==='home')f.kingdom.step=17;
 driver.command(f.command);driver.onTick(0);f.advance();
 if(mode==='outside')f.pop.state.entities.get(f.entity.id).z+=1;
 if(mode==='obstruction')f.state.obstacles.set(`${f.home.x+3},70,${f.home.z}`,'minecraft:stone_bricks');
 if(mode==='replacement'){const record=f.pop.state.entities.get(f.entity.id);record.alive=false;f.pop.addEntity({id:'replacement',typeId:'minecraft:villager_v2',x:record.x,y:record.y,z:record.z,tags:['civpop:v1:'+f.groupId]});}
 if(mode==='gate')f.state.gate=false;
 for(let tick=4;tick<=24;tick+=4){driver.onTick(tick);f.advance();}
 driver.stop();return c;
}
for(const mode of ['working','home','outside','obstruction','replacement','gate'])test(`passive trace preserves EXACT native API/getter/impulse/control sequence for ${mode}`,()=>{
 const a=scenario(before,mode),b=scenario(after,mode);assert.deepEqual(b.calls,a.calls);assert.deepEqual(b.f.state.impulses,a.f.state.impulses);assert.deepEqual(b.f.ownership(),a.f.ownership());assert.deepEqual(b.driver.statusLines(),a.driver.statusLines());assert.equal(b.calls.filter(row=>row[0]==='velocityGetter'&&row[1]==='y').length,0,'no vertical velocity getter added');
});
test('trace formatter performs no queries/getters/physics and retains observations after stop',()=>{
 const c=scenario(after,'working'),beforeCalls=structuredClone(c.calls),beforeWorld=c.f.ownership(),impulses=c.f.state.impulses.length,lines=c.driver.command('trace');assert.match(lines[0],/stopped yes/);assert.match(lines.join('\n'),/routine farm/);assert.match(lines.join('\n'),/velocity unavailable \(not separately sampled\)/);assert.deepEqual(c.calls,beforeCalls);assert.deepEqual(c.f.ownership(),beforeWorld);assert.equal(c.f.state.impulses.length,impulses);
});
test('HOME trial records HOME intent/correction instead of implying farmward motion',()=>{
 const c=scenario(after,'home'),text=c.driver.command('trace').join('\n');assert.match(text,/routine home/);assert.doesNotMatch(text,/routine farm/);assert.match(text,/Observed control intent\/corrections only/);
});
test('rolling15 plus first-outside and one stop stays16 and preserves first escape',()=>{
 const c=instrument(after),{f,driver}=c;driver.command(f.command);for(let tick=0;tick<80;tick+=4){driver.onTick(tick);f.advance();}
 f.pop.state.entities.get(f.entity.id).z+=4;driver.onTick(80);const first=driver.command('trace');assert.match(first[0],/16\/16; first-outside latched/);assert.ok(first.some(s=>s.includes('tick 80')&&s.includes('outside flat corridor')));
 for(let tick=84;tick<200;tick+=4)driver.onTick(tick);assert.deepEqual(driver.command('trace'),first,'latched first outside is not overwritten by later idle hours');
 driver.stop();const stopped=driver.command('trace');assert.match(stopped[0],/16\/16.*stopped yes/);assert.ok(stopped.some(s=>s.includes('tick 80')&&s.includes('outside flat corridor')));assert.ok(stopped.some(s=>s.startsWith('stop tick')));driver.stop();assert.deepEqual(driver.command('trace'),stopped);assert.ok(stopped.length<=19);
});
test('only successful explicit setup resets trace; failed setup and status preserve it',()=>{
 const c=instrument(after);c.driver.command(c.f.command);c.driver.onTick(0);const prior=c.driver.command('trace');c.f.state.busy=true;c.driver.command(c.f.command);assert.deepEqual(c.driver.command('trace'),prior);c.f.state.busy=false;c.driver.command('status');assert.deepEqual(c.driver.command('trace'),prior);c.driver.command(c.f.command);assert.match(c.driver.command('trace')[0],/0\/16/);
});
test('the exact original velocity expression and one existing timer authority remain untouched',()=>{
 const baseline=frozen.source,proposal=readFileSync(original,'utf8');assert.ok(proposal.includes('travelImpulse(a.entity.getVelocity(),desired)'));assert.equal(proposal.match(/getVelocity\(/g).length,baseline.match(/getVelocity\(/g).length);for(const forbidden of ['runInterval(','runTimeout(','spawnEntity(','setDynamicProperty(','teleport('])assert.equal(proposal.includes(forbidden),false,forbidden);
});
