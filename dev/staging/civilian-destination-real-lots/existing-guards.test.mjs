import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {validFullPlan} from '../../lib/civfixture.mjs';
import {makeField} from '../../lib/fakefield.mjs';
import {planDistrictSite,siteOpsFor,isLiveSite} from '../../../CivilizationApocalypse_BP/scripts/civ/districtplan.js';
import {savedDestinationsSteps,parseDestinationsCommand,formatDestinations,DESTINATION_LIMITS} from './scripts/people/destinations.js';
import {createCivilianDestinations} from './scripts/integration/civilianDestinations.js';

// ONE real production generated plan, shared by all bounded tests; no whole suite.
const planned=planDistrictSite(validFullPlan(1),1,makeField(3,{relief:0,forest:0,river:null}));
assert.equal(planned.ok,true,planned.problems.join('; '));
const record=planned.record,expected={index:1,checksum:record.checksum};
const finish=g=>{for(;;){const r=g.next();if(r.done)return r.value;}};
const baseline=finish(savedDestinationsSteps(record,expected));
const home=baseline.candidates.find(c=>c.role==='home'),farm=baseline.candidates.find(c=>c.role==='farm');
assert.ok(home);assert.ok(farm);

test('real site yields exact house/farm provenance and zero native claims',()=>{
 assert.equal(baseline.candidates.length,11);assert.ok(Object.isFrozen(baseline.candidates[0].entrance));
 for(const c of baseline.candidates){const e=record.lots.find(e=>e.id===c.id);assert.equal(c.lotId,e.lot);assert.equal(c.checksum,record.checksum);assert.deepEqual(c.door,{...e.door,y:e.baseY+1});assert.match(c.status,/UNVERIFIED/);assert.equal(c.route,null);}
 assert.equal(baseline.nativeReads,0);assert.equal(baseline.worldWrites,0);assert.equal(baseline.entityChanges,0);
 assert.ok(baseline.work.retainedCells<=baseline.work.maxRetainedCells);assert.ok(baseline.work.scanSlices>1);
 assert.match(formatDestinations(baseline,1).join('\n'),/no route or work credit/);
});
test('parsed clone cannot impersonate live verified source',()=>assert.throws(()=>finish(savedDestinationsSteps(JSON.parse(JSON.stringify(record)),expected)),/no live/));
test('wrong checksum rejects before op scan',()=>assert.throws(()=>finish(savedDestinationsSteps(record,{...expected,checksum:'deadbeef'})),/mismatch/));
test('wrong district rejects before op scan',()=>assert.throws(()=>finish(savedDestinationsSteps(record,{...expected,index:2})),/mismatch/));
test('declared per-element work bound refuses before generator allocation',()=>{const e=record.lots[0],old=e.total;e.total=DESTINATION_LIMITS.elementOps+1;try{assert.throws(()=>finish(savedDestinationsSteps(record,expected)),/op bound/);}finally{e.total=old;}});
test('duplicate element IDs reject',()=>{record.lots.push(record.lots[0]);try{assert.throws(()=>finish(savedDestinationsSteps(record,expected)),/duplicate/);}finally{record.lots.pop();}});
test('distinct lot IDs cannot silently share one entrance',()=>{const e=record.lots.find(e=>e.id===home.id);record.lots.push({...e,id:'extra-house',lot:'extra-house'});try{assert.throws(()=>finish(savedDestinationsSteps(record,expected)),/duplicate saved destination entrance/);}finally{record.lots.pop();}});
test('changed geometry is not accepted as an arbitrary point',()=>{const e=record.lots.find(e=>e.id===home.id),old=e.door;e.door={...old,x:old.x+1};try{assert.throws(()=>finish(savedDestinationsSteps(record,expected)),/geometry/);}finally{e.door=old;}});
test('metadata change during yield rejects entire result',()=>{const g=savedDestinationsSteps(record,expected);assert.equal(g.next().done,false);const e=record.lots.find(e=>e.id===home.id),old=e.facing;e.facing='tampered';try{assert.throws(()=>finish(g),/changed during/);}finally{e.facing=old;}});
test('metadata mutation after candidate review yield still refuses final result',()=>{const g=savedDestinationsSteps(record,expected);for(let n=0;n<=baseline.work.scanSlices;n++)assert.equal(g.next().done,false);const e=record.lots.find(e=>e.id===home.id),old=e.facing;e.facing='late-tampered';try{assert.throws(()=>finish(g),/changed during/);}finally{e.facing=old;}});
test('parser is bounded, rejects duplicates, trailing garbage and excessive pages',()=>{assert.deepEqual(parseDestinationsCommand('district=1 page=2'),{index:1,page:2});for(const text of ['district=0','district=6','district=1 district=1','district=1 page=1000','district=1 junk','district=1 page=0'])assert.ok(parseDestinationsCommand(text).error);assert.match(formatDestinations(baseline,999)[0],/exceeds/);});

// Explicit stream seam for later-stage overwrite cases; production function body
// unchanged. Real source identity/geometry and production blueprint definitions stay.
let stream=[];
globalThis.__destinationTestStream={isLiveSite,slices:()=>stream};
let text=readFileSync(new URL('./scripts/people/destinations.js',import.meta.url),'utf8');
text=text.replace('import {isLiveSite,siteOpSlices,SITE_STAGES} from "../civ/districtplan.js";',`const {isLiveSite,slices:siteOpSlices}=globalThis.__destinationTestStream;const SITE_STAGES=${JSON.stringify(['clear','walls','gates','roads','lots','dressing'])};`);
text=text.replace('"../structures/blueprints2.js"',JSON.stringify(pathToFileURL(resolve('CivilizationApocalypse_BP/scripts/structures/blueprints2.js')).href));
const seam=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const lotStream=c=>({stage:'lots',element:c.id,ops:siteOpsFor(record,'lots',record.lots.findIndex(e=>e.id===c.id))});
const compileStream=extra=>{stream=[lotStream(home),lotStream(farm),...extra];return finish(seam.savedDestinationsSteps(record,expected));};
test('same-ID entrance overwritten by a later foreign element is refused',()=>{const r=compileStream([{stage:'dressing',element:'foreign-decoration',ops:[{...home.entrance}]}]);assert.ok(r.refused.some(r=>r.id===home.id));assert.ok(r.candidates.some(r=>r.id===farm.id));});
test('later AIR at a door invalidates the home',()=>{const r=compileStream([{stage:'dressing',element:'clearance',ops:[{...home.door,id:'minecraft:air'}]}]);assert.ok(r.refused.some(r=>r.id===home.id));});
test('missing upper half refuses home rather than guessing a usable door',()=>{stream=[lotStream(home)];stream[0].ops=stream[0].ops.filter(o=>!(o.x===home.door.x&&o.z===home.door.z&&o.y===home.door.y+1));const r=finish(seam.savedDestinationsSteps(record,expected));assert.ok(r.refused.some(r=>r.id===home.id));});
test('unresolved planned frontage height stays null',()=>{const r=compileStream([]),c=r.candidates.find(c=>c.id===home.id);assert.equal(c.frontageFeet,null);assert.equal(c.frontageSurface,null);});
test('stone support in a road element is not a road-surface destination',()=>{const r=compileStream([{stage:'roads',element:'bridge-support',ops:[{x:home.frontage.x,y:home.door.y-1,z:home.frontage.z,id:'minecraft:stone_bricks',kind:'support'}]}]);assert.equal(r.candidates.find(c=>c.id===home.id).frontageFeet,null);});
test('actual road-kind frontage retains exact final provenance',()=>{const r=compileStream([{stage:'roads',element:'approach-real',ops:[{x:home.frontage.x,y:home.door.y-1,z:home.frontage.z,id:'minecraft:stone_bricks',kind:'road'}]}]);const c=r.candidates.find(c=>c.id===home.id);assert.deepEqual(c.frontageFeet,{x:home.frontage.x,y:home.door.y,z:home.frontage.z});assert.equal(c.frontageSurface.owner,'approach-real');});
test('more than the candidate cap refuses rather than truncating a partial index',()=>{const original=record.lots.slice();const e=record.lots.find(e=>e.id===home.id);for(let n=0;n<=DESTINATION_LIMITS.candidates;n++){const dx=1000+n*32;record.lots.push({...e,id:`extra-${n}`,lot:`extra-${n}`,door:{...e.door,x:e.door.x+dx},exit:{...e.exit,x:e.exit.x+dx},frontage:{...e.frontage,x:e.frontage.x+dx},bbox:{...e.bbox,x0:e.bbox.x0+dx,x1:e.bbox.x1+dx}});}try{assert.throws(()=>finish(savedDestinationsSteps(record,expected)),/candidate bound/);}finally{record.lots.splice(0,record.lots.length,...original);}});

const civ=()=>({status:'complete',stage:'complete',checksum:record.checksum,dimension:'minecraft:overworld',ops:58810,opsTotal:58810});
function runtime(overrides={}){
 const state={civ:civ(),reserved:0,finished:0,tokens:[],runs:0};
 const deps={readKingdom:()=>({districts:[{id:'district-1',civ:state.civ}]}),loadSaved:function*(){return {ok:true,district:1,record,queue:{state:'complete',planHash:record.checksum}};},runJob:async(token,g)=>{state.runs++;return finish(g);},reserveJob:()=>{state.reserved++;const token={cancelled:false};state.tokens.push(token);return token;},finishJob:()=>{state.finished++;},...overrides};
 return {state,driver:createCivilianDestinations(deps),deps};
}
const event=()=>({sourceEntity:{typeId:'minecraft:player',isValid:true,dimension:{id:'minecraft:overworld'}}});
test('runtime preview uses existing exclusive job and always releases it',async()=>{const {state,driver}=runtime();const lines=await driver.command('district=1',event());assert.match(lines[0],/Saved civilian destinations/);assert.equal(state.runs,2);assert.equal(state.reserved,1);assert.equal(state.finished,1);});
test('runtime refuses no player or wrong dimension before reserving',async()=>{const {state,driver}=runtime();assert.match((await driver.command('district=1',{}))[0],/refused/);const e=event();e.sourceEntity.dimension.id='minecraft:nether';assert.match((await driver.command('district=1',e))[0],/refused/);assert.equal(state.reserved,0);});
test('missing explicit saved dimension refuses',async()=>{const {state,driver}=runtime();delete state.civ.dimension;assert.match((await driver.command('district=1',event()))[0],/explicitly dimensioned/);assert.equal(state.reserved,0);});
test('busy job is not stolen',async()=>{const {state,driver}=runtime({reserveJob:()=>undefined});assert.match((await driver.command('district=1',event()))[0],/another/);assert.equal(state.runs,0);assert.equal(state.finished,0);});
test('failed checksum loader produces refusal and releases slot',async()=>{const {state,driver}=runtime({loadSaved:function*(){return {ok:false,reasons:['checksum mismatch']};}});assert.match((await driver.command('district=1',event()))[0],/checksum mismatch/);assert.equal(state.finished,1);});
test('incomplete queue is not a completed saved destination source',async()=>{const {state,driver}=runtime({loadSaved:function*(){return {ok:true,district:1,record,queue:{state:'paused',planHash:record.checksum}};}});assert.match((await driver.command('district=1',event()))[0],/completed queue/);assert.equal(state.finished,1);});
test('cancellation after loader emits no candidates and releases slot',async()=>{const {state,driver}=runtime({runJob:async(token,g)=>{const value=finish(g);token.cancelled=true;return value;}});assert.match((await driver.command('district=1',event()))[0],/cancelled/);assert.equal(state.finished,1);});
test('cancellation during compiler emits no partial candidates and releases slot',async()=>{let runs=0;const {state,driver}=runtime({runJob:async(token,g)=>{if(++runs===2){assert.equal(g.next().done,false);token.cancelled=true;g.return();return undefined;}return finish(g);}});assert.match((await driver.command('district=1',event()))[0],/cancelled/);assert.equal(state.finished,1);});
test('native loader exception is caught and releases slot',async()=>{const {state,driver}=runtime({runJob:async()=>{throw new Error('native unload');}});assert.match((await driver.command('district=1',event()))[0],/native unload/);assert.equal(state.finished,1);});
test('late saved identity change refuses a stale compiled preview',async()=>{let test;test=runtime({runJob:async(token,g)=>{const value=finish(g);if(test.state.runs++===1)test.state.civ={...test.state.civ,checksum:'deadbeef'};return value;}});assert.match((await test.driver.command('district=1',event()))[0],/changed during/);assert.equal(test.state.finished,1);});
test('player dimension change during async load refuses result',async()=>{const e=event();let runs=0;const {state,driver}=runtime({runJob:async(token,g)=>{const value=finish(g);if(++runs===1)e.sourceEntity.dimension.id='minecraft:nether';return value;}});assert.match((await driver.command('district=1',e))[0],/dimension changed/);assert.equal(state.finished,1);});
// Execute the copied router with native imports replaced only by bounded fakes.
let receive,resolvePreview,travelCalls=0;const replies=[];
globalThis.__destinationRouter={system:{afterEvents:{scriptEventReceive:{subscribe:fn=>{receive=fn;}}}},world:{setDynamicProperty:()=>{throw new Error('unexpected property write');}},reply:lines=>{assert.ok(Array.isArray(lines));replies.push(lines);}};
let router=readFileSync(new URL('../../../CivilizationApocalypse_BP/scripts/commands/people.js',import.meta.url),'utf8');
router=router.replace(/^import .*;\r?\n/gm,'');
router='const {system,world,reply}=globalThis.__destinationRouter;const CIV_EVENT_IDS={people:"civ:people"},PEOPLE={gateKey:"civ_people"},SCRIPT_EVENT_NAMESPACE="civ",parsePeopleCommand=()=>"status";\n'+router;
const {registerPeopleCommand}=await import('data:text/javascript;base64,'+Buffer.from(router).toString('base64'));
let rejectPreview;
registerPeopleCommand({statusLines:()=>[],travelCommand:()=>{travelCalls++;return ['travel unchanged'];},destinationsCommand:()=>new Promise((resolve,reject)=>{resolvePreview=resolve;rejectPreview=reject;})});
test('async command router sends arrays only, then resolves preview',async()=>{receive({id:'civ:people',message:'travel destinations district=1'});assert.equal(replies.length,1);assert.match(replies[0][0],/Verifying/);await Promise.resolve();resolvePreview(['actual destination preview']);await new Promise(r=>setImmediate(r));assert.deepEqual(replies.at(-1),['actual destination preview']);assert.equal(travelCalls,0);});
test('async command router catches rejection',async()=>{receive({id:'civ:people',message:'travel destinations district=1'});await Promise.resolve();rejectPreview(new Error('injected rejection'));await new Promise(r=>setImmediate(r));assert.match(replies.at(-1)[0],/injected rejection/);});
test('existing travel remains synchronous and never enters destination service',()=>{const before=replies.length;receive({id:'civ:people',message:'travel status'});assert.equal(travelCalls,1);assert.equal(replies.length,before+1);assert.deepEqual(replies.at(-1),['travel unchanged']);});
test('staged main binds actual loader, executor and one job owner',()=>{const main=readFileSync(new URL('../../../CivilizationApocalypse_BP/scripts/main.js',import.meta.url),'utf8');assert.match(main,/destinationsCommand:civilianDestinations.command/);assert.match(main,/loadSavedRunSteps\(civ,newOps\(\),index\)/);assert.match(main,/runJob:runJobAsync,reserveJob,finishJob/);});
