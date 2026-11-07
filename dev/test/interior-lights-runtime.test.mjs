import assert from 'node:assert/strict';
import test from 'node:test';
import {makeField} from '../lib/fakefield.mjs';
import {mc,key,typeAt,load,resetWorld,store,builder,siteplan,makePlayer,send,pump,text,propsSnapshot,worldFingerprint,districtBuilder,CIV_EVENT_IDS} from '../lib/civharness.mjs';
const {planCivilizationDetailed}=await load('civ/masterplan.js');
const {exportSiteGround,siteGroundRegion}=await load('civ/siteprofile.js');
const {createInitialKingdom}=await load('kingdom/state.js');
const {runSync}=await load('civ/regions.js');
const k=p=>key(p.x,p.y,p.z);

test('supported-fixture maintenance is read-only first, guards foreign source/target/anchor, waits for stability and resumes safely',{timeout:300000},async()=>{
 resetWorld(12);
 const field=makeField(12,{relief:2,hills:60}),master=planCivilizationDetailed(field,{seed:12});assert.ok(master.ok);
 const result=siteplan.planDistrictSite(master.plan,5,field,{seed:12,lotTerrain:'survey-balanced',lighting:'natural'});assert.ok(result.ok);
 const r=result.record,ground=exportSiteGround(field,siteGroundRegion(master.plan,5));
 assert.ok(builder.persistRun({district:5,record:r,masterIsNew:true,master:{version:1,plan:master.plan,seed:12,planSeed:12,anchor:master.plan.anchor},payload:{version:1,district:5,ground,siteChecksum:r.checksum,siteOptions:siteplan.siteOptionsOf(r),site:{version:siteplan.SITE_PLAN_VERSION}}}).ok);
 const kingdom=createInitialKingdom();kingdom.districts[4].civ={status:'complete',stage:'complete',seed:12,checksum:r.checksum,anchor:master.plan.anchor,centre:master.plan.anchor,startedStep:0,dimension:'minecraft:overworld'};store.save(kingdom);
 const roofs=runSync(siteplan.buildingRoofRevisionSteps(r));
 const groups=runSync(siteplan.buildingInteriorLightRevisionSteps(r)),g=groups.find(g=>g.fixtures.some(f=>k(f.before)!==k(f.after))&&roofs.find(r=>r.element.id===g.element.id)?.changes.length);assert.ok(g);
 const fixture=g.fixtures.find(f=>k(f.before)!==k(f.after));assert.ok(fixture);
 const maxY=Math.max(...g.original.map(o=>o.y));
 for(let x=g.element.bbox.x0-1;x<=g.element.bbox.x1+1;x++)for(let z=g.element.bbox.z0-1;z<=g.element.bbox.z1+1;z++)for(let y=g.element.baseY;y<=maxY+2;y++)mc.placed.set(key(x,y,z),'minecraft:air');
 for(const op of g.revised){mc.placed.set(k(op),op.id);if(op.states)mc.blockStates.set(k(op),{id:op.id,states:op.states});}
 // Start with the old unsupported fixture present, its proposed supported place empty.
 mc.placed.set(k(fixture.before),'minecraft:lantern');mc.placed.set(k(fixture.after),'minecraft:air');
 const snapshot=propsSnapshot(),before=worldFingerprint(),writes=mc.writes;
 const audit=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5',audit);await pump();
 assert.match(text(audit),/supported interior lights/);assert.match(text(audit),/Read-only/);assert.equal(mc.writes,writes);assert.deepEqual(worldFingerprint(),before);assert.equal(mc.areas.size,0);
 for(const p of [fixture.before,fixture.after,fixture.anchor]){
  const previous=typeAt(p.x,p.y,p.z);mc.placed.set(k(p),'minecraft:chest');
  const denied=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 confirm',denied);await pump();
  assert.equal(typeAt(p.x,p.y,p.z),'minecraft:chest');assert.equal(mc.writes,writes,'a changed fixture prerequisite refuses before writes');mc.placed.set(k(p),previous);
 }
 const near={x:fixture.after.x+1,y:fixture.after.y,z:fixture.after.z};
 const nearPrevious=typeAt(near.x,near.y,near.z);mc.placed.set(k(near),'minecraft:diamond_block');
 const attached=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 confirm',attached);await pump();assert.equal(mc.writes,writes);mc.placed.set(k(near),nearPrevious);
 // A source edit AFTER the yielding preflight must veto even the new placement.
 let anchorReads=0,lateEdit=false;
 mc.unloaded=p=>{if(k(p)===k(fixture.anchor)&&++anchorReads===5){mc.placed.set(k(fixture.before),'minecraft:chest');lateEdit=true;}return false;};
 const changedDuringProof=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 building='+g.element.id+' confirm',changedDuringProof);await pump();
 assert.equal(lateEdit,true,'regression edits the source after the yielding proof');assert.equal(mc.writes,writes);
 assert.equal(typeAt(fixture.before.x,fixture.before.y,fixture.before.z),'minecraft:chest');
 mc.unloaded=()=>false;mc.placed.set(k(fixture.before),'minecraft:lantern');
 mc.noCapacity=true;const unavailable=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 confirm',unavailable);await pump();assert.match(text(unavailable),/unloaded/);assert.equal(mc.writes,writes);mc.noCapacity=false;
 // Interruption after the new light is installed cannot erase the old one.
 const first=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 confirm',first);await pump({until:()=>mc.writes>writes});
 assert.equal(typeAt(fixture.after.x,fixture.after.y,fixture.after.z),'minecraft:lantern');assert.equal(typeAt(fixture.before.x,fixture.before.y,fixture.before.z),'minecraft:lantern');
 districtBuilder.cancelActiveJob();await pump();assert.equal(mc.areas.size,0);
 // Simulate a native attachment failure on retry: source remains, no unsafe cleanup.
 mc.placed.set(k(fixture.after),'minecraft:air');
 const unstable=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 confirm',unstable);const prior=mc.writes;await pump({until:()=>mc.writes>prior});
 mc.placed.set(k(fixture.after),'minecraft:air');await pump();assert.equal(typeAt(fixture.before.x,fixture.before.y,fixture.before.z),'minecraft:lantern');assert.match(text(unstable),/unstable 1/);
 const finish=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 confirm',finish);await pump();
 assert.equal(typeAt(fixture.before.x,fixture.before.y,fixture.before.z),'minecraft:air');assert.equal(typeAt(fixture.after.x,fixture.after.y,fixture.after.z),'minecraft:lantern');assert.equal(typeAt(fixture.anchor.x,fixture.anchor.y,fixture.anchor.z),fixture.anchor.id);
 const done=mc.writes,repeat=makePlayer();send(CIV_EVENT_IDS.interiorLights,'district=5 confirm',repeat);await pump();assert.equal(mc.writes,done);assert.match(text(repeat),/changed 0/);assert.deepEqual(propsSnapshot(),snapshot);assert.equal(mc.areas.size,0);assert.equal(districtBuilder.isBusy(),false);
 const roofRepeat=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',roofRepeat);await pump();

 assert.match(text(roofRepeat),/ready 1,/,'the migrated building '+g.element.id+' remains accepted by full roof comparison');assert.equal(mc.writes,done,'a later roof pass never erases the migrated light');
 const savedState=mc.blockStates.get(k(fixture.after));
 mc.blockStates.set(k(fixture.after),{id:'minecraft:lantern',states:{hanging:!fixture.after.states.hanging}});
 const wrongState=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',wrongState);await pump();
 assert.match(text(wrongState),/ready 0,/);assert.equal(mc.writes,done);mc.blockStates.set(k(fixture.after),savedState);
});

