import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {REVIEWED_FRESH_FIXTURE as d} from './proposed/freshFixtureTrust.js';
import {createPrivateFreshFixture,ACTIVATION_KEY} from './typecheck/scripts/integration/privateFreshFixture.js';
import {createInitialKingdom,serializeKingdom} from './typecheck/scripts/kingdom/state.js';
import {META} from './typecheck/scripts/integration/creationBindings.js';
const root=new URL('../../../',import.meta.url),stage=new URL('./',import.meta.url);
const read=url=>JSON.parse(readFileSync(url,'utf8').replace(/^\uFEFF/,''));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
const receiptURL=new URL('dist/vanilla-never-owner-backup-20261108.json',root),receipt=read(receiptURL);

function fixture(){
 const props=new Map([['civ:kingdom',serializeKingdom(createInitialKingdom())],['civ_devgate',true]]),writes=[];let dev=true,on=false,busy=false;
 const dimensions=Object.fromEntries(['overworld','nether','the_end'].map(n=>[n,{id:'minecraft:'+n,getEntities:()=>[]}]));
 const player={id:'FAKE_TEST_CALLER_ONLY',isValid:true,dimension:dimensions.overworld};
 const identity={id:d.participantId,type:'FakePlayer',isValid:true,displayName:d.participant};
 const objective={id:'ca_fresh_owner',isValid:true,displayName:d.nonce,getScores:()=>[{participant:identity,score:0}]};
 const world={getDynamicPropertyIds:()=>[...props.keys()],getDynamicProperty:k=>props.get(k),setDynamicProperty(k,v){writes.push([k,v]);props.set(k,v);},getAllPlayers:()=>[player],getDimension:n=>dimensions[n],scoreboard:{getObjectives:()=>[objective],getObjective:()=>objective}};
 const deps={world,isDeveloper:()=>dev,isPeopleOn:()=>on,isBusy:()=>busy};
 return{adapter:createPrivateFreshFixture(deps),deps,world,props,writes,player,identity,objective,setDev:v=>dev=v,setOn:v=>on=v,setBusy:v=>busy=v};
}
test('proposal descriptor is byte-bound only to actual witnessed receipt/level/marker and stored participant1',()=>{
 assert.deepEqual(Object.keys(d).sort(),['v','fixtureId','epoch','receiptSha256','levelSha256','nonce','participant','participantId','operatorKnownNewVanilla'].sort());
 assert.equal(d.v,1);assert.match(d.fixtureId,/^[A-Za-z0-9_-]{1,64}$/);assert.match(d.epoch,/^[A-Za-z0-9_-]{1,64}$/);assert.equal(d.receiptSha256,hash(receiptURL));assert.equal(d.levelSha256,receipt.files.find(f=>f.path==='level.dat').sha256);
 assert.equal(d.nonce,receipt.marker.displayName);assert.equal(d.participant,receipt.marker.participant);assert.equal(d.participantId,1);assert.equal(d.operatorKnownNewVanilla,true);
 const actual=read(new URL('../population-archer-readiness/native-evidence/exact-scoreboard-identity-audit-20261108.json',stage));assert.equal(actual.exactScoreboard.participantIdFromClosedNBT,d.participantId);assert.equal(actual.compiledTrust,null);
});
test('all9 pristine source hashes remain exact; staged derivative changes only two explicit binding lists',()=>{
 for(const f of receipt.files){assert.equal(hash(join(receipt.backup,f.path)),f.sha256);const derivative=new URL('derivative-world/'+f.path,stage);if(!f.path.startsWith('world_')||!f.path.endsWith('_packs.json'))assert.equal(hash(derivative),f.sha256);}
 const plan=read(new URL('./DERIVATIVE-PLAN.json',stage));assert.deepEqual(plan.derivativeOnlyChangedPaths.sort(),['world_behavior_packs.json','world_resource_packs.json']);assert.equal(plan.compiledIntoActive,false);assert.equal(plan.nativeAcceptance,false);
 assert.match(readFileSync(new URL('CivilizationApocalypse_BP/scripts/integration/freshFixtureTrust.js',root),'utf8'),/REVIEWED_FRESH_FIXTURE=null;/);
});
test('proposed descriptor is accepted by actual adapter only in an explicit fake exact-world test; no native acceptance implied',()=>{
 const f=fixture();assert.equal(f.adapter.activate(f.player).state,'complete');assert.deepEqual(f.writes.map(([key])=>key),[ACTIVATION_KEY,META,ACTIVATION_KEY]);assert.equal(JSON.parse(f.props.get(META)).fixture,d.fixtureId);assert.equal(JSON.parse(f.props.get(META)).epoch,d.epoch);assert.equal(f.adapter.status().state,'complete');
});
test('actual native identity/type/score/objective mismatch refuses before durable intent',()=>{
 for(const change of [f=>f.identity.id=2,f=>f.identity.type='Player',f=>f.identity.displayName='other',f=>f.objective.displayName='wrong',f=>f.objective.getScores=()=>[{participant:f.identity,score:1}]]){
  const f=fixture();change(f);assert.throws(()=>f.adapter.activate(f.player));assert.equal(f.writes.length,0);
 }
});
test('proposal cannot bypass player/dev/people/job gates or evolved exact-initial state',()=>{
 for(const change of [f=>f.setDev(false),f=>f.setOn(true),f=>f.setBusy(true),f=>f.player.isValid=false,f=>{const k=JSON.parse(f.props.get('civ:kingdom'));k.step=1;f.props.set('civ:kingdom',JSON.stringify(k));}]){
  const f=fixture();change(f);const before=[...f.props];assert.throws(()=>f.adapter.activate(f.player));assert.deepEqual([...f.props],before);assert.equal(f.writes.length,0);
 }
});
for(const side of ['before','after'])for(const boundary of [1,2,3])test('real proposal descriptor fake-world crash '+side+' write'+boundary+' preserves exact durable hold/complete state',()=>{
 const f=fixture(),set=f.world.setDynamicProperty;let count=0;f.world.setDynamicProperty=(k,v)=>{if(++count===boundary&&side==='before')throw Error('test-crash');set(k,v);if(count===boundary&&side==='after')throw Error('test-crash');};assert.throws(()=>f.adapter.activate(f.player));const next=createPrivateFreshFixture(f.deps);
 assert.equal(next.status().state,side==='before'&&boundary===1?'absent':side==='after'&&boundary===3?'complete':'held');
});
