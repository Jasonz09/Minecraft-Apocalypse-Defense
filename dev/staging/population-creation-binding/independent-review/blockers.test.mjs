import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createCreationBindings,PREFIX,META,birthTag} from '../bindings.mjs';
// Reuse the EXACT frozen focusedfixture and actualproposedowner imports; no owner rewrite.
const testURL=new URL('../binding.test.mjs',import.meta.url),raw=readFileSync(testURL,'utf8'),prefix=raw.slice(0,raw.indexOf("test('fresh epoch"));
const source=prefix.replaceAll('import.meta.url',JSON.stringify(testURL.href)).replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${s.startsWith('.')?new URL(s,testURL).href:s}${q}`)+'\nexport {fixture};';
const {fixture}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('BLOCKER actualowner reproducer: missingissuedgrouprecord+unloadedlivingactor authorizes duplicategeneration1',()=>{
 const f=fixture(),old=f.spawn(),before=f.store.inspect('district-1:civ:0');old.x=80;old.z=0;f.pop.unloadArea(80,0,95,15);f.pop.world.setDynamicProperty(PREFIX+'district-1:civ:0',undefined);f.rejoin();assert.equal(f.store.inspect('district-1:civ:0'),null);assert.equal(f.store.canBirth('district-1:civ:0','minecraft:villager_v2').allowed,true);const outcome=f.run(1000);assert.equal(outcome.refused,null);assert.equal(f.alive().length,2,'documents blocker, NOT desiredbehavior');assert.equal(f.store.inspect('district-1:civ:0').generation,before.generation);f.pop.loadArea(80,0,95,15);assert.match(f.run(2000).refused,/duplicate conflict/);assert.equal(f.alive().length,2,'bothsurvivors preserved after duplicate detected');
});
function store(){const props=new Map(),world={getDynamicPropertyIds:()=>[...props.keys()],getDynamicProperty:k=>props.get(k),setDynamicProperty(k,v){if(v===undefined)props.delete(k);else props.set(k,v);}},b=createCreationBindings(world,{verifyFreshWorld:()=>({verified:true,fixtureId:'reviewfixture',dimension:'minecraft:overworld',ownerHistory:'never-started'})});b.initialize({mode:'fresh',epoch:'epoch1',fixture:'reviewfixture'});const g='district-1:civ:0',t=b.prepare(g,'minecraft:villager_v2');b.recordSpawned(t,'actor1');const s={groupId:g,id:'actor1',typeId:'minecraft:villager_v2',tags:['civpop:v1:'+g,t.tag]};b.confirmBorn(t,s);return{props,b,g,s};}
test('journalCAS blocker: old private removal ticket can retire replacementepoch record withsame actor/generation',()=>{
 const f=store(),ticket=f.b.beginRemove(f.s),meta=JSON.parse(f.props.get(META)),record=JSON.parse(f.props.get(PREFIX+f.g));f.props.set(META,JSON.stringify({...meta,epoch:'epoch2'}));f.props.set(PREFIX+f.g,JSON.stringify({...record,epoch:'epoch2'}));f.b.commitRemoved(ticket);assert.equal(f.b.inspect(f.g).epoch,'epoch2');assert.equal(f.b.inspect(f.g).phase,'retired','documents missingticketepoch/rawCAS, NOT intendedauthority');
});
test('integrationgap: unknownbindingnamespace doesnotblock existingretiredgeneration issuance',()=>{
 const f=store(),ticket=f.b.beginRemove(f.s);f.b.commitRemoved(ticket);f.props.set('civ:pop_bind:v2:meta','future');assert.equal(f.b.canBirth(f.g,'minecraft:villager_v2').allowed,true);const t=f.b.prepare(f.g,'minecraft:villager_v2');assert.equal(t.generation,2,'documents missingglobalfuture-namespace guard onexistingrecords');
});
