import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPopWorld} from '../lib/poptharness.mjs';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,next){if(s==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={currentTick:208682};',shortCircuit:true};return next(s,c);}`));
const source=new URL('../../CivilizationApocalypse_BP/scripts/',import.meta.url);
// Default always exercises PRODUCTION. The explicit test-only override allows
// focused validation before the frozen production integration is authorized.
const overlay=process.env.CIV_OWNER_CONFLICT_TEST_ROOT?pathToFileURL(resolve(process.env.CIV_OWNER_CONFLICT_TEST_ROOT)+sep):source;
const reference=JSON.parse(readFileSync(new URL('./fixtures/military-owner-conflict-pre-diagnostic.json',import.meta.url),'utf8'));
assert.equal(reference.schemaVersion,1);
const {createInitialKingdom}=await import(new URL('kingdom/state.js',source));
const {tagFor}=await import(new URL('population/identity.js',source));
const {encodeCursor,emptyCursor}=await import(new URL('population/cursor.js',source));
const {POP_CURSOR_KEY}=await import(new URL('population/settings.js',source));
const {decodeMilitarySelection,encodeMilitarySelection}=await import(new URL('population/militarySelection.js',source));
const {createPopSync}=await import(new URL('integration/popSync.js',overlay));
const {createPeopleStreets}=await import(new URL('integration/peopleStreets.js',overlay));
const GROUP='district-1:sol:1',CIV='district-1:civ:0',HOMES={'district-1':{x:0,y:70,z:0}};
function fixture({duplicate='civilian',ids=['civilianA','civilianB']}={}){
 const pop=createPopWorld({homes:HOMES}),k=createInitialKingdom();for(const d of k.districts){d.civilians=d.id==='district-1'?10:0;d.soldiers=d.id==='district-1'?20:0;d.garrison={front:d.soldiers,reserve:0};}
 pop.setKingdom(k);pop.setPlayers([{name:'operator',x:0,y:70,z:0}]);pop.loadArea(-64,-64,96,96);
 const read=()=>decodeMilitarySelection(encodeMilitarySelection({v:1,trialId:'diagnostic-trial',fixtureId:'nov3-d1-672745b7',groupId:GROUP,class:'swordsman',typeId:'civ_trial:swordsman',dimension:'minecraft:overworld'}));
 pop.addEntity({id:'guard142',x:3,z:22,typeId:'civ_trial:swordsman',tags:[tagFor(GROUP)]});pop.addEntity({id:ids[0],x:3,z:2,typeId:'minecraft:villager_v2',tags:[tagFor(CIV)]});
 if(duplicate==='civilian')for(const id of ids.slice(1))pop.addEntity({id,x:4,z:2,typeId:'minecraft:villager_v2',tags:[tagFor(CIV)]});
 if(duplicate==='guard')pop.addEntity({id:'guardTwin',x:4,z:22,typeId:'civ_trial:swordsman',tags:[tagFor(GROUP)]});
 pop.setRawProperty(POP_CURSOR_KEY,encodeCursor({...emptyCursor(),physical:[CIV,GROUP]}));
 const deps={world:pop.world,dimension:pop.dimension,homes:()=>HOMES,readKingdom:()=>pop.storedKingdom(),enabled:true,readMilitarySelection:read};
 return{pop,k,read,deps,sync:()=>createPopSync(deps)};
}
const writes=p=>({spawn:p.state.spawned.length,remove:p.state.removals.length,tags:p.state.tagWrites.length,props:p.state.propertyWrites.length});
const normalize=result=>JSON.parse(JSON.stringify(result));
test('unrelatedcivilian duplicate names realgroup/2IDs while selectedguard stays1; zeroactions/cursor/entitywrites',()=>{
 const f=fixture(),before=writes(f.pop),cursor=f.pop.world.getDynamicProperty(POP_CURSOR_KEY),kingdom=f.pop.world.getDynamicProperty('civ:kingdom'),sync=f.sync(),result=sync.reconcileOnce(208669);
 assert.match(result.refused,/^Error: military owner duplicate conflict; representatives preserved; group=district-1:civ:0 observed=2 sampleIds=civilianA,civilianB$/);assert.deepEqual(result.actions,[]);assert.equal(result.saved,false);assert.deepEqual(writes(f.pop),before);assert.equal(f.pop.world.getDynamicProperty(POP_CURSOR_KEY),cursor);assert.equal(f.pop.world.getDynamicProperty('civ:kingdom'),kingdom);
 const inspection=sync.inspectGroup(GROUP,208682);assert.equal(inspection.live.canonicalLoaded,1);assert.equal(inspection.live.expectedTypeLoaded,1);assert.equal(inspection.live.queryMatches,1);assert.equal(inspection.lastAttempt.status,'already observed');assert.equal(inspection.ownerRefused,result.refused);assert.equal(inspection.ageTicks,13);assert.deepEqual(writes(f.pop),before);
});
test('selectedduplicate reportsselectedgroupandactual2guardIDs and preservesboth withoutcleanup',()=>{
 const f=fixture({duplicate:'guard'}),before=writes(f.pop),result=f.sync().reconcileOnce(1);assert.match(result.refused,/group=district-1:sol:1 observed=2 sampleIds=guard142,guardTwin/);assert.deepEqual(writes(f.pop),before);assert.equal(f.pop.state.entities.get('guard142').alive,true);assert.equal(f.pop.state.entities.get('guardTwin').alive,true);
});
test('diagnostic reports fullobservedcount but only2bounded ID samples, without control/newline injection',()=>{
 const a='A'.repeat(70)+'\nBAD',b='B'.repeat(70)+'\rBAD',f=fixture({ids:[a,b,'thirdActor']}),r=f.sync().reconcileOnce(1);assert.match(r.refused,/observed=3/);assert.equal(r.refused.includes('thirdActor'),false);assert.equal(r.refused.includes('\n'),false);assert.equal(r.refused.includes('\r'),false);assert.ok(r.refused.length<320);assert.ok(r.refused.includes('A'.repeat(64)+','+'B'.repeat(64)));assert.deepEqual(r.actions,[]);
});
test('production adapter matches frozen pre-diagnostic decisions/reports/state/writes masking ONLY refusedmessage',()=>{
 for(const duplicate of ['civilian','guard','none']){const a=fixture({duplicate}),r=normalize(a.sync().reconcileOnce(10)),original=reference.cases[duplicate];
  if(r.refused){r.refused='MASK';r.report.refused='MASK';}assert.deepEqual(r,original.result,duplicate);assert.deepEqual(writes(a.pop),original.writes,duplicate);assert.equal(a.pop.world.getDynamicProperty(POP_CURSOR_KEY),original.cursor);}
});
test('actualstreets inspect labels globalownerrefusal separately, never invents a birth; noqueryextra/orwrites added',()=>{
 const f=fixture(),before=writes(f.pop),streets=createPeopleStreets({homes:()=>HOMES,isGateOn:()=>true,readMilitarySelection:f.read});streets.onHour({world:f.pop.world,dimension:f.pop.dimension,kingdom:f.pop.storedKingdom(),tick:208669,report:{}});
 const lines=streets.inspectCommand('group='+GROUP),text=lines.join('\n');assert.match(text,/Cached owner result: already observed/);assert.equal(text.includes('Last owner birth'),false);assert.match(text,/Owner plan refusal \(all observed groups\):.*group=district-1:civ:0 observed=2 sampleIds=civilianA,civilianB/);assert.equal((text.match(/military owner duplicate conflict/g)??[]).length,1);assert.match(text,/fresh loaded canonical: 1/);assert.deepEqual(writes(f.pop),before);
});
