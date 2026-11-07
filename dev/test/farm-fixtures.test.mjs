import assert from "node:assert/strict";
import {register} from "node:module";
import test from "node:test";
register("data:text/javascript,"+encodeURIComponent(`export async function resolve(s,c,next){if(s==="@minecraft/server")return{url:"data:text/javascript,"+encodeURIComponent('export const world={};export const system={currentTick:0};export const ScriptEventSource={Server:"Server",Entity:"Entity"};export class ItemStack{};export const BlockPermutation={resolve(id,states){return{typeId:id,states}}};'),shortCircuit:true};if(s==="@minecraft/server-ui")return{url:"data:text/javascript,export class ActionFormData{};export class MessageFormData{};",shortCircuit:true};return next(s,c);}`));
const root="../../CivilizationApocalypse_BP/scripts/";
const {BLUEPRINTS2,expandBlueprint,rotatedSize}=await import(root+"structures/blueprints2.js");
const {normalizeOps}=await import(root+"civ/opnorm.js");
const {newOps,runSync}=await import(root+"civ/regions.js");
const {SITE_STAGES}=await import(root+"civ/districtplan.js");
const {fnv1a}=await import(root+"civ/planstore.js");
const {FARM_LIGHT_STATE_PREFIX,decodeFarmLightingJournal,encodeFarmLightingJournal,farmLightingReleaseReadiness,farmFixtureProposalsSteps,farmFixtureReadiness,prepareFarmFixtureEntry,farmFixtureStep,farmFixtureKey,formatFarmLightingStatus}=await import(root+"civ/farmfixtures.js");
const {createFarmLightingRevision}=await import(root+"integration/farmLightingRevision.js");
const clone=value=>JSON.parse(JSON.stringify(value));
const key=farmFixtureKey;
const reader=(record,stage,index)=>record._ops[stage]?.[index]??[];
function source({blueprint="farm_allot_v2",rot=0,x=0,z=0,farms=1}={}){
    const record={checksum:"0123abcd",options:{},_ops:{}};for(const stage of SITE_STAGES){record[stage]=[];record._ops[stage]=[];}
    for(let i=0;i<farms;i++){
        const bp=BLUEPRINTS2[blueprint],size=rotatedSize(bp,rot),ox=x+i*40,element={id:`building-farm-${i}`,kind:"building-"+blueprint.replace(/_v2$/,""),blueprint,rot,baseY:63,bbox:{x0:ox,z0:z,x1:ox+size.w-1,z1:z+size.d-1}};
        record.lots.push(element);record._ops.lots.push(normalizeOps(expandBlueprint(bp,rot).map(op=>({...op,x:op.x+ox,y:op.y+63,z:op.z+z,kind:"building"}))));
    }return record;
}
const compile=(record,ops=newOps(),filter)=>farmFixtureProposalsSteps(record,ops,filter,reader);
function compiled(record){return runSync(compile(record));}
function harness(record=source()){
    const blocks=new Map();for(const stage of SITE_STAGES)for(const ops of record._ops[stage])for(const op of ops)blocks.set(key(op),{typeId:op.id,states:op.id==="minecraft:lantern"?{hanging:false,...op.states}:{...op.states}});
    const state={record,blocks,props:new Map(),writes:[],propertyWrites:[],messages:[],acquires:0,releases:0,recovers:0,activeLeases:0,mode:[],unloaded:false,onRead:null,onWrite:null,onTick:null,silentJournal:false,readCounts:new Map(),protection:[]};
    const clock={currentTick:0};let token;
    const jobs={isBusy:()=>!!token,activeKind:()=>token?.kind,activeToken:()=>token,reserveJob:kind=>token?undefined:(token={kind,cancelled:false}),finishJob:t=>{if(token===t)token=undefined;},cancelActiveJob:()=>{if(!token)return false;token.cancelled=true;token=undefined;return true;}};
    const world={getDynamicProperty:k=>state.props.get(k),setDynamicProperty:(k,v)=>{state.propertyWrites.push({k,v});if(!state.silentJournal)state.props.set(k,v);}};
    const dimension={id:"minecraft:overworld",getBlock:p=>{
        state.readCounts.set(clock.currentTick,(state.readCounts.get(clock.currentTick)??0)+1);state.onRead?.(p);
        if(state.unloaded===true||typeof state.unloaded==="function"&&state.unloaded(p))return undefined;
        return{isValid:true,get typeId(){return blocks.get(key(p))?.typeId??"minecraft:air";},permutation:{getAllStates:()=>clone(blocks.get(key(p))?.states??{})},setPermutation:permutation=>{const before=blocks.get(key(p))?.typeId??"minecraft:air";blocks.set(key(p),clone(permutation));state.writes.push({at:key(p),before,after:permutation.typeId,tick:clock.currentTick});state.onWrite?.(p,permutation);}};
    }};
    const loader={recover:()=>state.recovers++,acquire:()=>{state.acquires++;state.activeLeases++;const mode=state.mode.shift()??"ready";let released=false;return{status:()=>{const current=typeof mode==="function"?mode(clock.currentTick):mode;return{state:current,reason:current==="failed"?"unloaded fixture lease failed":undefined};},release:()=>{if(!released){released=true;state.releases++;state.activeLeases--;}}};}};
    const nextTick=async()=>{clock.currentTick++;state.onTick?.(clock.currentTick);await Promise.resolve();};
    const runJob=async(t,g)=>{for(;;){if(t.cancelled){g.return();return undefined;}const step=g.next();if(step.done)return step.value;await Promise.resolve();}};
    const controller=createFarmLightingRevision({world,system:clock,jobs,loader,nextTick,runJob,compile,loadSavedRunSteps:function*(){yield;return{ok:true,district:1,record,queue:{state:"complete"}};},recoverConstructionHolds:()=>{},resolvePermutation:(typeId,states)=>({typeId,states})});
    const options={index:1,civ:{status:"complete",dimension:dimension.id,checksum:record.checksum},dimension,getProtection:()=>state.protection,say:lines=>state.messages.push(...lines)};
    const start=extra=>controller.start({...options,...extra});
    const read=p=>blocks.get(key(p))??{typeId:"minecraft:air",states:{}};
    return{state,controller,start,options,read,clock,jobs,world,dimension,loader};
}
const journalFor=(proposal,phase="placing")=>({v:1,index:1,checksum:proposal.checksum,dimension:"minecraft:overworld",complete:phase==="done",entries:[{farmId:proposal.farmId,planId:proposal.planId,phase,seenTick:phase==="settling"?0:null}]});
test("farm journal strictly versions and bounds pending state; release preserves completed receipts",()=>{
    const p=compiled(source()).proposals[0],journal=journalFor(p);assert.equal(decodeFarmLightingJournal(undefined).status,"absent");assert.equal(decodeFarmLightingJournal(encodeFarmLightingJournal(journal)).status,"ok");
    assert.equal(farmLightingReleaseReadiness(undefined).ready,true);assert.equal(farmLightingReleaseReadiness(encodeFarmLightingJournal(journal)).ready,false);
    assert.equal(farmLightingReleaseReadiness(encodeFarmLightingJournal(journalFor(p,"done"))).ready,true);
    for(const broken of [{...journal,v:2},{...journal,complete:true},{...journal,dimension:"overworld"},{...journal,entries:[journal.entries[0],journal.entries[0]]},{...journal,entries:[{...journal.entries[0],seenTick:42}]},{...journal,extra:true}])assert.equal(farmLightingReleaseReadiness(JSON.stringify(broken)).ready,false);
    assert.equal(decodeFarmLightingJournal("x".repeat(30001)).status,"refused");assert.equal(decodeFarmLightingJournal("{").status,"refused");
});
test("real frontage helper yields supported sparse proposals for every farm blueprint/rotation",()=>{
    for(const blueprint of ["farm_allot_v2","farm_kitchen_v2","farm_veg_v2","farm_wheat_v2","farm_irrigated_v2"])for(let rot=0;rot<4;rot++){
        const record=source({blueprint,rot,x:-100,z:200}),original=JSON.stringify(record._ops),result=compiled(record);assert.equal(result.refused.length,0,JSON.stringify(result.refused));assert.equal(result.proposals.length,1);const p=result.proposals[0];assert.equal(p.remove.length,4);assert.equal(p.add.length,BLUEPRINTS2[blueprint].size[0]<=13?1:2);assert.ok(Object.isFrozen(p));assert.equal(JSON.stringify(record._ops),original);assert.equal(Object.isFrozen(record._ops.lots[0][0]),false,"compiler never freezes or mutates source ops");
    }
});
test("all-stage final ownership rejects later own source/anchor/target overrides including foreign AIR",()=>{
    for(const which of ["source","anchor","target"]){const record=source(),initial=compiled(record).proposals[0],cell=which==="source"?initial.remove[0]:which==="anchor"?initial.guards[0]:initial.add[0];record.dressing.push({id:"later"});record._ops.dressing.push([{...cell,id:"minecraft:air"}]);const result=compiled(record);assert.equal(result.proposals.length,0);assert.match(result.refused[0].reason,/ownership|owner/);}
});
test("foreign live contacts and malformed direct checkpoint refuse before any action",()=>{
    const h=harness(),p=compiled(h.state.record).proposals[0],entry=prepareFarmFixtureEntry(p,h.read),contact=p.contacts.find(c=>c.expectedId==="minecraft:air");h.state.blocks.set(key(contact),{typeId:"minecraft:chest",states:{}});assert.throws(()=>farmFixtureStep(p,entry,h.read,0),/foreign/);h.state.blocks.delete(key(contact));assert.throws(()=>farmFixtureStep(p,{...entry,phase:"future"},h.read,0),/checkpoint/);
});
test("read-only farm preview writes no blocks/properties/leases and releases construction slot",async()=>{
    const h=harness(),before=JSON.stringify([...h.state.blocks]);const run=h.start({confirm:false});assert.equal(run.ok,true);const status=await run.completion;assert.equal(status.ready,1);assert.equal(status.changed,0);assert.match(status.reason,/Read-only/);assert.equal(JSON.stringify([...h.state.blocks]),before);assert.equal(h.state.propertyWrites.length,0);assert.equal(h.state.acquires,0);assert.equal(h.state.recovers,0);assert.equal(h.jobs.isBusy(),false);
});
test("confirmed migration installs all lights and waits actual ticks before exact corner removals",async()=>{
    const h=harness(source({blueprint:"farm_veg_v2"}));const run=h.start({confirm:true});assert.equal(h.start({confirm:true}).ok,false);const status=await run.completion;assert.equal(status.changed,6);assert.equal(status.placed,2);assert.equal(status.removed,4);assert.equal(status.pending,0);assert.deepEqual(h.state.writes.map(w=>w.after),["minecraft:lantern","minecraft:lantern",...Array(4).fill("minecraft:air")]);
    const installed=Math.max(...h.state.writes.filter(w=>w.after==="minecraft:lantern").map(w=>w.tick)),removed=Math.min(...h.state.writes.filter(w=>w.after==="minecraft:air").map(w=>w.tick));assert.ok(removed-installed>=2);
    assert.equal(h.state.activeLeases,0);assert.equal(h.jobs.isBusy(),false);assert.ok(Math.max(...h.state.readCounts.values())<1500);assert.equal(h.controller.status(1).state,"complete");assert.equal(farmLightingReleaseReadiness(h.state.props.get(FARM_LIGHT_STATE_PREFIX+1)).ready,true);
    const writesPerTick=new Map();for(const write of h.state.writes)writesPerTick.set(write.tick,(writesPerTick.get(write.tick)??0)+1);assert.equal(Math.max(...writesPerTick.values()),1,"one native block mutation per actual tick");
});
test("repeating completed migration verifies exact alternate and performs zero block writes",async()=>{
    const h=harness();await h.start({confirm:true}).completion;const count=h.state.writes.length,properties=h.state.propertyWrites.length,status=await h.start({confirm:true}).completion;assert.equal(status.changed,0);assert.equal(h.state.writes.length,count);assert.equal(h.state.propertyWrites.length,properties);assert.equal(status.pending,0);assert.ok(formatFarmLightingStatus(status).some(s=>s.includes("changed 0")));
});
test("largest six-fixture farm stays below the production read ceiling and writes once per real tick",async t=>{
    const h=harness(source({blueprint:"farm_irrigated_v2",x:15,z:15}));let callback;
    const status=await h.start({confirm:true,onEnd:value=>callback=value}).completion;assert.equal(status.placed,2);assert.equal(status.removed,4);assert.equal(callback,true);
    const reads=Math.max(...h.state.readCounts.values()),writes=new Map();for(const w of h.state.writes)writes.set(w.tick,(writes.get(w.tick)??0)+1);
    assert.ok(reads<=750,`initial readiness + prepare + decision + fresh full proof used ${reads} block reads`);assert.ok(reads<1500);assert.equal(Math.max(...writes.values()),1);
    t.diagnostic(`Measured maximum ${reads} block reads per tick; one block write per tick, production read ceiling 1500.`);
});
test("changed source/anchor/state, foreign target and protected neighbor preserve the whole farm",async()=>{
    for(const change of ["source","anchor","target","state","protection"]){const h=harness(),p=compiled(h.state.record).proposals[0];if(change==="protection"){const q=p.add[0];h.state.protection=[{x0:q.x,z0:q.z,x1:q.x,z1:q.z}];}else{const q=change==="anchor"?p.guards[0]:change==="target"?p.add[0]:p.remove[0];h.state.blocks.set(key(q),change==="state"?{typeId:"minecraft:lantern",states:{hanging:true}}:{typeId:"minecraft:chest",states:{}});}const status=await h.start({confirm:true}).completion;assert.equal(status.changed,0,change);assert.equal(h.state.propertyWrites.length,0,change);assert.equal(h.state.activeLeases,0);assert.ok(status.preserved>0);}
});
test("missing provenance, wrong dimension, corrupt journals and silent storage refuse before block writes",async()=>{
    const h=harness();assert.equal(h.start({dimension:{id:"overworld"}}).ok,false);h.state.props.set(FARM_LIGHT_STATE_PREFIX+1,"{");let status=await h.start({confirm:true}).completion;assert.equal(status.state,"refused");assert.equal(h.state.writes.length,0);
    h.state.props.clear();h.state.silentJournal=true;status=await h.start({confirm:true}).completion;assert.equal(h.state.writes.length,0);assert.ok(status.preserved>0);assert.equal(h.state.activeLeases,0);
});
test("loading failure releases its lease and later farms obtain fresh leases",async()=>{
    const h=harness(source({farms:2}));h.state.mode=["failed","ready"];let callback;const status=await h.start({confirm:true,onEnd:value=>callback=value}).completion;assert.equal(status.unloaded,1);assert.equal(status.changed,5);assert.equal(h.state.acquires,2);assert.equal(h.state.releases,2);assert.equal(h.state.activeLeases,0);assert.equal(callback,false,"partial selected migration is never reported complete to the caller");
});
test("protection changed during chunk loading refuses before preparing a journal",async()=>{
    const h=harness(),p=compiled(h.state.record).proposals[0];h.state.mode=[tick=>tick>=1?"ready":"loading"];
    h.state.onTick=()=>{const q=p.add[0];h.state.protection=[{x0:q.x,z0:q.z,x1:q.x,z1:q.z}];};
    const status=await h.start({confirm:true}).completion;assert.equal(status.changed,0);assert.equal(h.state.propertyWrites.length,0);assert.ok(status.preserved>0);assert.equal(h.state.activeLeases,0);
});
test("aborting an old farm session never releases a newer unrelated construction owner",async()=>{
    const h=harness();h.state.onWrite=()=>{h.controller.abort();h.jobs.reserveJob("newer-construction");};
    const status=await h.start({confirm:true}).completion;assert.equal(status.state,"cancelled");assert.equal(h.jobs.activeKind(),"newer-construction");assert.equal(h.state.activeLeases,0);h.jobs.cancelActiveJob();
});
test("cancellation after placement keeps old corners and trusted journal; resumed removal revalidates",async()=>{
    const h=harness(),p=compiled(h.state.record).proposals[0];h.state.onWrite=()=>h.controller.abort();let status=await h.start({confirm:true}).completion;assert.equal(status.state,"cancelled");assert.equal(status.placed,1);assert.equal(status.removed,0);assert.ok(p.remove.every(o=>h.read(o).typeId==="minecraft:lantern"));assert.equal(h.state.activeLeases,0);assert.equal(farmLightingReleaseReadiness(h.state.props.get(FARM_LIGHT_STATE_PREFIX+1)).ready,false);
    h.state.onWrite=null;status=await h.start({confirm:true}).completion;assert.equal(status.removed,4);assert.equal(status.pending,0);
});
test("interrupted partial removal survives new controller/rejoin with a fresh two-tick proof",async()=>{
    const h=harness(),p=compiled(h.state.record).proposals[0];h.state.onWrite=(_p,permutation)=>{if(permutation.typeId==="minecraft:air")h.controller.abort();};let status=await h.start({confirm:true}).completion;assert.equal(status.removed,1);assert.equal(p.remove.filter(o=>h.read(o).typeId==="minecraft:air").length,1);
    h.state.onWrite=null;h.clock.currentTick=0;const before=h.state.writes.length;status=await h.start({confirm:true}).completion;const first=h.state.writes[before];assert.ok(first.tick>=2);assert.equal(status.removed,3);assert.equal(status.pending,0);
});
test("native attachment drop vetoes old corner removal and retains resumable pending state",async()=>{
    const h=harness(),p=compiled(h.state.record).proposals[0];h.state.onTick=()=>{if(h.state.writes.some(w=>w.after==="minecraft:lantern"))h.state.blocks.delete(key(p.add[0]));};const status=await h.start({confirm:true}).completion;assert.equal(status.removed,0);assert.ok(status.preserved>0);assert.equal(status.pending,1);assert.ok(p.remove.every(o=>h.read(o).typeId==="minecraft:lantern"));
});
test("late protected clearance or foreign contact after placement prevents any removal",async()=>{
    for(const change of ["protection","contact"]){const h=harness(),p=compiled(h.state.record).proposals[0];h.state.onWrite=()=>{if(change==="protection"){const q=p.remove[0];h.state.protection=[{x0:q.x,z0:q.z,x1:q.x,z1:q.z}];}else{const q=p.contacts.find(c=>c.expectedId==="minecraft:air");h.state.blocks.set(key(q),{typeId:"minecraft:barrel",states:{}});}};const status=await h.start({confirm:true}).completion;assert.equal(status.removed,0);assert.equal(status.pending,1);assert.ok(p.remove.every(o=>h.read(o).typeId==="minecraft:lantern"));}
});
test("journal changed externally during the live step cannot authorize later corner deletion",async()=>{
    const h=harness(),p=compiled(h.state.record).proposals[0];h.state.onWrite=()=>h.state.props.set(FARM_LIGHT_STATE_PREFIX+1,"foreign journal");const status=await h.start({confirm:true}).completion;assert.equal(status.removed,0);assert.ok(status.preserved>0||status.state==="refused");assert.ok(p.remove.every(o=>h.read(o).typeId==="minecraft:lantern"));assert.equal(h.state.activeLeases,0);
});

test("unplanned nonattaching short grass stays untouched through placement, two-tick stability, removal and fresh-controller rejoin",async()=>{
    const h=harness(),p=compiled(h.state.record).proposals[0],roles=new Set([...p.remove,...p.add,...p.guards].map(key));
    const grass=p.contacts.find(c=>c.expectedId==="minecraft:air"&&!roles.has(key(c)));
    assert.ok(grass);h.state.blocks.set(key(grass),{typeId:"minecraft:short_grass",states:{}});
    const status=await h.start({confirm:true}).completion;
    assert.equal(status.changed,5);assert.equal(status.preserved,0);assert.equal(status.pending,0);
    assert.equal(h.read(grass).typeId,"minecraft:short_grass");assert.deepEqual(h.read(grass).states,{});
    assert.ok(h.state.writes.every(w=>w.at!==key(grass)));
    const installed=h.state.writes.find(w=>w.after==="minecraft:lantern").tick,removed=h.state.writes.find(w=>w.after==="minecraft:air").tick;
    assert.ok(removed-installed>=2);
    const rejoin=harness(h.state.record);rejoin.state.blocks.clear();
    for(const [k,v]of h.state.blocks)rejoin.state.blocks.set(k,clone(v));
    for(const [k,v]of h.state.props)rejoin.state.props.set(k,v);
    const repeat=await rejoin.start({confirm:true}).completion;
    assert.equal(repeat.changed,0);assert.equal(repeat.preserved,0);assert.equal(rejoin.state.writes.length,0);assert.equal(rejoin.state.propertyWrites.length,0);
    assert.equal(rejoin.read(grass).typeId,"minecraft:short_grass");
});

test("short grass never substitutes for a source, target, anchor or gate and remains protected",async()=>{
    for(const role of ["source","target","anchor","gate","protection"]){
        const h=harness(),p=compiled(h.state.record).proposals[0],q=role==="source"?p.remove[0]:role==="target"?p.add[0]:role==="anchor"?p.guards[0]:role==="gate"?p.guards.find(o=>o.id.endsWith("fence_gate")):p.contacts.find(c=>c.expectedId==="minecraft:air");
        h.state.blocks.set(key(q),{typeId:"minecraft:short_grass",states:{}});
        if(role==="protection")h.state.protection=[{x0:q.x,z0:q.z,x1:q.x,z1:q.z}];
        const status=await h.start({confirm:true}).completion;
        assert.equal(status.changed,0,role);assert.ok(status.preserved>0,role);assert.equal(h.state.propertyWrites.length,0,role);
        assert.equal(h.read(q).typeId,"minecraft:short_grass");
    }
});

test("short-grass allowance requires proven unplanned contact; planned AIR, unknown proposal and changed owned states still refuse with provenance",()=>{
    const record=source(),p=compiled(record).proposals[0],roles=new Set([...p.remove,...p.add,...p.guards].map(key)),contact=p.contacts.find(c=>c.expectedId==="minecraft:air"&&!roles.has(key(c)));
    const h=harness(record);h.state.blocks.set(key(contact),{typeId:"minecraft:short_grass",states:{}});
    assert.throws(()=>farmFixtureReadiness(clone(p),h.read),/actual minecraft:short_grass, expected minecraft:air, provenance unknown/);
    const withAir=source();withAir.dressing.push({id:"planned-clearance"});withAir._ops.dressing.push([{...contact,id:"minecraft:air",kind:"dress"}]);
    const planned=compiled(withAir).proposals[0],airHarness=harness(withAir);airHarness.state.blocks.set(key(contact),{typeId:"minecraft:short_grass",states:{}});
    assert.throws(()=>farmFixtureReadiness(planned,airHarness.read),/actual minecraft:short_grass, expected minecraft:air, provenance planned dressing\/0/);
    const withStates=source();withStates.dressing.push({id:"owned-decoration"});withStates._ops.dressing.push([{...contact,id:"minecraft:oak_stairs",kind:"dress",states:{upside_down_bit:false,wood_type:"oak"}}]);
    const owned=compiled(withStates).proposals[0],ownedHarness=harness(withStates);withStates._ops.dressing[0][0].states.upside_down_bit=true;ownedHarness.state.blocks.set(key(contact),{typeId:"minecraft:oak_stairs",states:{upside_down_bit:true,wood_type:"oak"}});
    assert.throws(()=>farmFixtureReadiness(owned,ownedHarness.read),/actual minecraft:oak_stairs, expected minecraft:oak_stairs, provenance planned dressing\/0/);
});

test("new, changed, dropped or unreadable short grass after placement holds every old corner",async()=>{
    for(const change of ["new","dropped","state"]){
        const h=harness(),p=compiled(h.state.record).proposals[0],roles=new Set([...p.remove,...p.add,...p.guards].map(key)),q=p.contacts.find(c=>c.expectedId==="minecraft:air"&&!roles.has(key(c)));
        if(change!=="new")h.state.blocks.set(key(q),{typeId:"minecraft:short_grass",states:{}});
        h.state.onWrite=()=>{if(change==="dropped")h.state.blocks.delete(key(q));else h.state.blocks.set(key(q),{typeId:"minecraft:short_grass",states:change==="state"?{changed:true}:{}});};
        const status=await h.start({confirm:true}).completion;
        assert.equal(status.placed,1,change);assert.equal(status.removed,0,change);assert.ok(status.preserved>0,change);assert.ok(status.notes.some(n=>n.includes("changed short-grass contact")),change);
        assert.ok(p.remove.every(o=>h.read(o).typeId==="minecraft:lantern"));assert.ok(h.state.writes.every(w=>w.at!==key(q)));
    }
    const h=harness(),p=compiled(h.state.record).proposals[0],q=p.contacts.find(c=>c.expectedId==="minecraft:air"),read=op=>key(op)===key(q)?{typeId:"minecraft:short_grass"}:h.read(op);
    assert.throws(()=>farmFixtureReadiness(p,read),/unreadable short-grass state/);
});

test("vines, attaching plants and foreign/player blocks are never adopted as harmless grass",async()=>{
    for(const id of ["minecraft:vine","minecraft:glow_lichen","minecraft:chest","minecraft:barrel","minecraft:torch"]){
        const h=harness(),p=compiled(h.state.record).proposals[0],q=p.contacts.find(c=>c.expectedId==="minecraft:air");h.state.blocks.set(key(q),{typeId:id,states:{}});
        const status=await h.start({confirm:true}).completion;assert.equal(status.changed,0,id);assert.ok(status.preserved>0,id);assert.equal(h.state.propertyWrites.length,0,id);
        assert.ok(status.notes.some(n=>n.includes(`actual ${id}, expected minecraft:air, provenance unplanned`)),id);
    }
});


test("runtime-only grass provenance preserves canonical proposal fingerprints and saved journal identity",()=>{
    const record=source(),first=compiled(record).proposals[0],again=compiled(record).proposals[0];
    const {planId,...body}=first;
    assert.equal(planId,fnv1a(JSON.stringify(body)));assert.equal(again.planId,planId);
    assert.deepEqual(Object.keys(first).sort(),["v","checksum","farmId","remove","add","guards","contacts","planId"].sort());
    const h=harness(record),q=first.contacts.find(c=>c.expectedId==="minecraft:air");h.state.blocks.set(key(q),{typeId:"minecraft:short_grass",states:{}});
    farmFixtureReadiness(first,h.read);assert.equal(first.planId,planId);assert.equal(JSON.stringify(first),JSON.stringify(again));
});

const actualCropIds=["minecraft:wheat","minecraft:carrots","minecraft:potatoes","minecraft:beetroot"];
function cropContactFixture(id="minecraft:carrots",plannedStates={growth:7}){
    const record=source(),first=compiled(record).proposals[0],roles=new Set([...first.remove,...first.add,...first.guards].map(key));
    const op=record._ops.lots[0].find(op=>actualCropIds.includes(op.id)&&first.contacts.some(c=>key(c)===key(op))&&!roles.has(key(op)));
    assert.ok(op,"fixture needs a planned non-role crop contact");op.id=id;op.states={...plannedStates};
    const h=harness(record),proposal=compiled(record).proposals[0];return{...h,proposal,crop:op};
}

test("actual D4 farm blueprint geometry tolerates legitimate same-carrot growth0..7 outside every fixture role",()=>{
    const fixtures=[{id:"building-d4-farm_allot-1",blueprint:"farm_allot_v2",rot:3,x:-447,z:-580,baseY:65,crop:"-446,66,-573"},
        {id:"building-d4-farm_allot-2",blueprint:"farm_allot_v2",rot:2,x:-371,z:-603,baseY:63,crop:"-364,64,-596"},
        {id:"building-d4-farm_kitchen-1",blueprint:"farm_kitchen_v2",rot:2,x:-413,z:-565,baseY:63,crop:"-402,64,-554"}];
    for(const f of fixtures){
        const record=source(f),delta=f.baseY-63;record.lots[0].id=f.id;record.lots[0].baseY=f.baseY;
        for(const op of record._ops.lots[0])op.y+=delta;
        const h=harness(record),p=compiled(record).proposals[0],roles=new Set([...p.remove,...p.add,...p.guards].map(key));
        assert.ok(p.contacts.some(c=>key(c)===f.crop));assert.equal(roles.has(f.crop),false);
        assert.equal(h.state.blocks.get(f.crop).typeId,"minecraft:carrots");
        for(let growth=0;growth<=7;growth++){h.state.blocks.get(f.crop).states.growth=growth;farmFixtureReadiness(p,h.read);}
        assert.equal(h.state.writes.length,0);assert.equal(h.state.propertyWrites.length,0);
    }
});

test("all four actual Bedrock crop IDs tolerate only bounded integer growth changes",async()=>{
    const {PALETTE2}=await import(root+"structures/palette2.js");const {PALETTE}=await import(root+"structures/palette.js");
    assert.deepEqual([PALETTE.wheat.id,PALETTE2.carrot_crop.id,PALETTE2.potato_crop.id,PALETTE2.beet_crop.id],actualCropIds.map(id=>id.slice(10)));
    for(const id of actualCropIds){const h=cropContactFixture(id);for(let growth=0;growth<=7;growth++){h.state.blocks.set(key(h.crop),{typeId:id,states:{growth}});farmFixtureReadiness(h.proposal,h.read);}assert.equal(h.state.writes.length,0);}
});

test("invalid or missing crop growth and extra unknown state keys refuse without preparing any fixture write",async()=>{
    for(const growth of [-1,8,0.5,NaN,Infinity,"2",null,undefined]){
        const h=cropContactFixture();h.state.blocks.set(key(h.crop),{typeId:h.crop.id,states:{growth}});
        const status=await h.start({confirm:true}).completion;assert.equal(status.changed,0,String(growth));assert.ok(status.preserved>0);assert.equal(h.state.propertyWrites.length,0);
    }
    for(const states of [{growth:0,extra:true},{growth:7,unplanned_state:1},{}]){const h=cropContactFixture();h.state.blocks.set(key(h.crop),{typeId:h.crop.id,states});assert.throws(()=>farmFixtureReadiness(h.proposal,h.read),/invalid planned crop contact state/);}
    const badPlan=cropContactFixture("minecraft:wheat",{growth:8});assert.throws(()=>farmFixtureReadiness(badPlan.proposal,badPlan.read),/invalid planned crop contact state/);
});

test("every non-growth planned crop state stays exact and unknown/cloned crop provenance never gains the exception",()=>{
    const h=cropContactFixture("minecraft:carrots",{growth:7,test_planned_state:false});
    h.state.blocks.set(key(h.crop),{typeId:h.crop.id,states:{growth:2,test_planned_state:false}});farmFixtureReadiness(h.proposal,h.read);
    for(const states of [{growth:2,test_planned_state:true},{growth:2},{growth:2,test_planned_state:false,extra:1}]){h.state.blocks.set(key(h.crop),{typeId:h.crop.id,states});assert.throws(()=>farmFixtureReadiness(h.proposal,h.read),/invalid planned crop contact state/);}
    h.state.blocks.set(key(h.crop),{typeId:h.crop.id,states:{growth:0,test_planned_state:false}});
    assert.throws(()=>farmFixtureReadiness(clone(h.proposal),h.read),/unverified planned crop contact.*provenance unknown/);
});

test("crop exception never changes block identity, other plants, farmland moisture, fixture roles or protected clearance",async()=>{
    for(const id of ["minecraft:wheat","minecraft:chest","minecraft:vine"]){const h=cropContactFixture("minecraft:carrots");h.state.blocks.set(key(h.crop),{typeId:id,states:{growth:0}});assert.throws(()=>farmFixtureReadiness(h.proposal,h.read),/foreign farm fixture contact/);}
    for(const [id,planned,actual]of [["minecraft:sweet_berry_bush",{growth:3},{growth:2}],["minecraft:beetroots",{growth:7},{growth:0}],["minecraft:farmland",{moisturized_amount:7},{moisturized_amount:0}]]){
        const h=cropContactFixture(id,planned);h.state.blocks.set(key(h.crop),{typeId:id,states:actual});assert.throws(()=>farmFixtureReadiness(h.proposal,h.read),/foreign farm fixture contact/);
    }
    for(const role of ["source","target","anchor","gate"]){const h=cropContactFixture(),p=h.proposal,q=role==="source"?p.remove[0]:role==="target"?p.add[0]:role==="anchor"?p.guards[0]:p.guards.find(g=>g.id.endsWith("fence_gate"));h.state.blocks.set(key(q),{typeId:"minecraft:wheat",states:{growth:0}});const status=await h.start({confirm:true}).completion;assert.equal(status.changed,0,role);assert.ok(status.preserved>0,role);assert.equal(h.state.propertyWrites.length,0);}
    const protectedCrop=cropContactFixture();protectedCrop.state.blocks.set(key(protectedCrop.crop),{typeId:protectedCrop.crop.id,states:{growth:0}});protectedCrop.state.protection=[{x0:protectedCrop.crop.x,z0:protectedCrop.crop.z,x1:protectedCrop.crop.x,z1:protectedCrop.crop.z}];const status=await protectedCrop.start({confirm:true}).completion;assert.equal(status.changed,0);assert.ok(status.notes.some(n=>n.includes("protected neighbor clearance")));assert.equal(protectedCrop.state.propertyWrites.length,0);
});

test("legitimate crop growth during real stability ticks/removals and after rejoin never causes crop writes or repeat fixture changes",async()=>{
    const h=cropContactFixture(),at=key(h.crop),cropCells=new Set([at]);h.state.blocks.get(at).states.growth=0;
    h.state.onTick=tick=>{h.state.blocks.get(at).states.growth=tick%8;};
    const status=await h.start({confirm:true}).completion;
    assert.equal(status.changed,5);assert.equal(status.preserved,0);assert.equal(status.pending,0);assert.ok(h.state.writes.every(w=>!cropCells.has(w.at)));
    const placed=h.state.writes.find(w=>w.after==="minecraft:lantern").tick,removed=h.state.writes.find(w=>w.after==="minecraft:air").tick;assert.ok(removed-placed>=2);
    const rejoin=harness(h.state.record);rejoin.state.blocks.clear();for(const [k,v]of h.state.blocks)rejoin.state.blocks.set(k,clone(v));for(const [k,v]of h.state.props)rejoin.state.props.set(k,v);
    rejoin.state.blocks.get(at).states.growth=1;
    const repeated=await rejoin.start({confirm:true}).completion;
    assert.equal(repeated.changed,0);assert.equal(repeated.preserved,0);assert.equal(repeated.pending,0);assert.equal(rejoin.state.writes.length,0);assert.equal(rejoin.state.propertyWrites.length,0);assert.equal(rejoin.state.blocks.get(at).states.growth,1);
});

test("exact unplanned fern and short grass stay untouched together through migration and fresh-controller zero-write rejoin",async()=>{
    const h=cropContactFixture(),p=h.proposal,roles=new Set([...p.remove,...p.add,...p.guards].map(key)),contacts=p.contacts.filter(c=>c.expectedId==="minecraft:air"&&!roles.has(key(c))),fern=contacts[0],grass=contacts[1];
    h.state.blocks.set(key(fern),{typeId:"minecraft:fern",states:{}});h.state.blocks.set(key(grass),{typeId:"minecraft:short_grass",states:{}});h.state.blocks.get(key(h.crop)).states.growth=0;
    const before=JSON.stringify([h.read(fern),h.read(grass)]),status=await h.start({confirm:true}).completion;
    assert.equal(status.changed,5);assert.equal(status.preserved,0);assert.equal(status.pending,0);assert.equal(JSON.stringify([h.read(fern),h.read(grass)]),before);
    assert.ok(h.state.writes.every(w=>w.at!==key(fern)&&w.at!==key(grass)&&w.at!==key(h.crop)));
    const installed=h.state.writes.find(w=>w.after==="minecraft:lantern").tick,removed=h.state.writes.find(w=>w.after==="minecraft:air").tick;assert.ok(removed-installed>=2);
    const rejoin=harness(h.state.record);rejoin.state.blocks.clear();for(const [k,v]of h.state.blocks)rejoin.state.blocks.set(k,clone(v));for(const [k,v]of h.state.props)rejoin.state.props.set(k,v);
    const repeated=await rejoin.start({confirm:true}).completion;assert.equal(repeated.changed,0);assert.equal(repeated.preserved,0);assert.equal(rejoin.state.writes.length,0);assert.equal(rejoin.state.propertyWrites.length,0);assert.equal(JSON.stringify([rejoin.read(fern),rejoin.read(grass)]),before);
});

test("fern never replaces a fixture role, planned AIR, unknown provenance or protected contact",async()=>{
    for(const role of ["source","target","anchor","gate","protection"]){const h=harness(),p=compiled(h.state.record).proposals[0],q=role==="source"?p.remove[0]:role==="target"?p.add[0]:role==="anchor"?p.guards[0]:role==="gate"?p.guards.find(g=>g.id.endsWith("fence_gate")):p.contacts.find(c=>c.expectedId==="minecraft:air");h.state.blocks.set(key(q),{typeId:"minecraft:fern",states:{}});if(role==="protection")h.state.protection=[{x0:q.x,z0:q.z,x1:q.x,z1:q.z}];const status=await h.start({confirm:true}).completion;assert.equal(status.changed,0,role);assert.ok(status.preserved>0,role);assert.equal(h.state.propertyWrites.length,0);assert.equal(h.read(q).typeId,"minecraft:fern");}
    const record=source(),p=compiled(record).proposals[0],q=p.contacts.find(c=>c.expectedId==="minecraft:air"),h=harness(record);h.state.blocks.set(key(q),{typeId:"minecraft:fern",states:{}});assert.throws(()=>farmFixtureReadiness(clone(p),h.read),/actual minecraft:fern, expected minecraft:air, provenance unknown/);
    record.dressing.push({id:"planned-clearance"});record._ops.dressing.push([{...q,id:"minecraft:air",kind:"dress"}]);const planned=compiled(record).proposals[0];assert.throws(()=>farmFixtureReadiness(planned,h.read),/actual minecraft:fern, expected minecraft:air, provenance planned dressing\/0/);
});

test("new, dropped, changed-state or unreadable fern holds old corners; large fern is not included",async()=>{
    for(const change of ["new","drop","state"]){const h=harness(),p=compiled(h.state.record).proposals[0],q=p.contacts.find(c=>c.expectedId==="minecraft:air");if(change!=="new")h.state.blocks.set(key(q),{typeId:"minecraft:fern",states:{}});h.state.onWrite=()=>{if(change==="drop")h.state.blocks.delete(key(q));else h.state.blocks.set(key(q),{typeId:"minecraft:fern",states:change==="state"?{changed:true}:{}});};const status=await h.start({confirm:true}).completion;assert.equal(status.placed,1,change);assert.equal(status.removed,0,change);assert.ok(status.preserved>0);assert.ok(status.notes.some(n=>n.includes("changed fern contact")));assert.ok(p.remove.every(o=>h.read(o).typeId==="minecraft:lantern"));assert.ok(h.state.writes.every(w=>w.at!==key(q)));}
    const h=harness(),p=compiled(h.state.record).proposals[0],q=p.contacts.find(c=>c.expectedId==="minecraft:air");assert.throws(()=>farmFixtureReadiness(p,op=>key(op)===key(q)?{typeId:"minecraft:fern"}:h.read(op)),/unreadable fern state/);
    h.state.blocks.set(key(q),{typeId:"minecraft:large_fern",states:{}});assert.throws(()=>farmFixtureReadiness(p,h.read),/foreign farm fixture contact/);
});

test("actual D4 allot1 fern coordinate is unplanned non-role and retains its canonical migration identity",()=>{
    const record=source({blueprint:"farm_allot_v2",rot:3,x:-447,z:-580});record.lots[0].baseY=65;record.lots[0].id="building-d4-farm_allot-1";for(const op of record._ops.lots[0])op.y+=2;
    const h=harness(record),p=compiled(record).proposals[0],q={x:-448,y:66,z:-571};assert.ok(p.contacts.some(c=>key(c)===key(q)&&c.expectedId==="minecraft:air"));assert.equal(record._ops.lots[0].some(op=>key(op)===key(q)),false);assert.equal([...p.remove,...p.add,...p.guards].some(op=>key(op)===key(q)),false);
    const identity=p.planId;h.state.blocks.set(key(q),{typeId:"minecraft:fern",states:{}});farmFixtureReadiness(p,h.read);assert.equal(compiled(record).proposals[0].planId,identity);assert.equal(h.state.writes.length,0);
});
