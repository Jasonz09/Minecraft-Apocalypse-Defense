import assert from 'node:assert/strict';
import test from 'node:test';
import {makeField} from '../lib/fakefield.mjs';
import {mc,key,typeAt,load,resetWorld,store,builder,siteplan,makePlayer,send,pump,text,propsSnapshot,worldFingerprint,districtBuilder,CIV_EVENT_IDS} from '../lib/civharness.mjs';
const {planCivilizationDetailed}=await load('civ/masterplan.js');
const {exportSiteGround,siteGroundRegion}=await load('civ/siteprofile.js');
const {createInitialKingdom}=await load('kingdom/state.js');

test('saved school roof repair preserves foreign blocks, is read-only by default, releases bounded remote holds and resumes idempotently', {timeout:180000}, async()=>{
    resetWorld(12);
    const field=makeField(12,{relief:2,hills:60}), master=planCivilizationDetailed(field,{seed:12});assert.ok(master.ok);
    const planned=siteplan.planDistrictSite(master.plan,5,field,{seed:12,lotTerrain:'survey-balanced',lighting:'natural'});assert.ok(planned.ok);
    const r=planned.record, ground=exportSiteGround(field,siteGroundRegion(master.plan,5));
    const saved=builder.persistRun({district:5,record:r,masterIsNew:true,master:{version:1,plan:master.plan,seed:12,planSeed:12,anchor:master.plan.anchor},
        payload:{version:1,district:5,ground,siteChecksum:r.checksum,siteOptions:siteplan.siteOptionsOf(r),site:{version:siteplan.SITE_PLAN_VERSION}}});
    assert.ok(saved.ok,saved.reason);
    const kingdom=createInitialKingdom();
    kingdom.districts.find(d=>d.id==='district-5').civ={status:'complete',stage:'complete',seed:12,checksum:r.checksum,anchor:master.plan.anchor,centre:master.plan.anchor,startedStep:0,dimension:'minecraft:overworld'};
    store.save(kingdom);
    const i=r.lots.findIndex(e=>e.kind==='building-school'),old=siteplan.siteOpsFor(r,'lots',i);
    for(const op of old)mc.placed.set(key(op.x,op.y,op.z),op.id);
    const steps=siteplan.schoolRoofRevisionSteps(r);let next;do{next=steps.next();}while(!next.done);
    const changes=next.value[0].changes;assert.ok(changes.length>20);
    const snapshot=propsSnapshot(),original=worldFingerprint(),writes=mc.writes;
    const audit=makePlayer();send(CIV_EVENT_IDS.schoolRoof,'district=5',audit);await pump();
    assert.match(text(audit),/ready 1/);assert.match(text(audit),/Read-only/);assert.equal(mc.writes,writes);assert.deepEqual(worldFingerprint(),original);assert.equal(mc.areas.size,0);
    const obstruction=changes.find(op=>op.id==='minecraft:air'),obKey=key(obstruction.x,obstruction.y,obstruction.z);
    mc.placed.set(obKey,'minecraft:diamond_block');
    const blocked=makePlayer();send(CIV_EVENT_IDS.schoolRoof,'district=5 confirm',blocked);await pump();
    assert.match(text(blocked),/preserved 1/);assert.equal(mc.writes,writes);assert.equal(typeAt(obstruction.x,obstruction.y,obstruction.z),'minecraft:diamond_block');
    assert.ok(text(blocked).includes(`changed block minecraft:diamond_block at ${obstruction.x},${obstruction.y},${obstruction.z}`),'a preserved building identifies the actual obstruction for inspection');
    mc.placed.set(obKey,obstruction.before);mc.noCapacity=true;
    const refused=makePlayer();send(CIV_EVENT_IDS.schoolRoof,'district=5 confirm',refused);await pump();
    assert.match(text(refused),/unloaded 1/);assert.equal(mc.writes,writes);assert.equal(mc.areas.size,0);mc.noCapacity=false;
    assert.match(text(refused),/building-school/,'a loading refusal identifies the building');
    const remote=(p)=>!Array.from(mc.areas.values()).some(a=>a.loaded&&p.x>=a.from.x&&p.x<=a.to.x&&p.z>=a.from.z&&p.z<=a.to.z);
    mc.unloaded=remote;mc.areaMaxChunks=0;
    const repair=makePlayer();send(CIV_EVENT_IDS.schoolRoof,'district=5 confirm',repair);
    await pump({until:()=>mc.writes>writes+8});
    districtBuilder.cancelActiveJob();await pump();
    const resume=makePlayer();send(CIV_EVENT_IDS.schoolRoof,'district=5 confirm',resume);await pump();
    assert.match(text(resume),/preserved 0, unloaded 0/);
    mc.unloaded=()=>false;
    for(const op of changes)assert.equal(typeAt(op.x,op.y,op.z),op.id);
    const changedKeys=new Set(changes.map(op=>key(op.x,op.y,op.z)));
    for(const op of old)if(!changedKeys.has(key(op.x,op.y,op.z)))assert.equal(typeAt(op.x,op.y,op.z),op.id,'doors, structure and furniture stay unchanged');
    const doneWrites=mc.writes,again=makePlayer();send(CIV_EVENT_IDS.schoolRoof,'district=5 confirm',again);await pump();
    assert.match(text(again),/changed 0/);assert.equal(mc.writes,doneWrites);
    assert.ok(mc.areaMaxChunks<=16);assert.equal(mc.areas.size,0);assert.equal(districtBuilder.isBusy(),false);assert.deepEqual(propsSnapshot(),snapshot);
    // The district-wide entry point uses the same guarded path for other enclosed
    // buildings, while keeping the already repaired school and all non-support ops.
    const allSteps=siteplan.buildingRoofRevisionSteps(r);let all;
    do{all=allSteps.next();}while(!all.done);
    const others=all.value.filter(g=>g.element.kind!=='building-school'&&g.changes.length);
    assert.ok(others.length>0,'the fixture includes another roof needing correction');
    for(const group of others) {
        const at=r.lots.findIndex(e=>e.id===group.element.id);
        for(const op of siteplan.siteOpsFor(r,'lots',at))mc.placed.set(key(op.x,op.y,op.z),op.id);
        for(const op of group.changes)if(op.before==='minecraft:air')mc.placed.set(key(op.x,op.y,op.z),'minecraft:air');
    }
    const beforeAll=mc.writes,allSnapshot=worldFingerprint(),allAudit=makePlayer();
    send(CIV_EVENT_IDS.roofSupport,'district=5',allAudit);await pump();
    assert.match(text(allAudit),/building roof supports/);assert.equal(mc.writes,beforeAll);assert.deepEqual(worldFingerprint(),allSnapshot);
    const allRepair=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 confirm',allRepair);await pump();
    assert.match(text(allRepair),/preserved 0, unloaded 0/);assert.ok(mc.writes>beforeAll);
    for(const group of all.value)for(const op of group.changes)assert.equal(typeAt(op.x,op.y,op.z),op.id);
    const afterAll=mc.writes,repeatAll=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 confirm',repeatAll);await pump();
    assert.match(text(repeatAll),/changed 0/);assert.equal(mc.writes,afterAll);assert.deepEqual(propsSnapshot(),snapshot);assert.equal(mc.areas.size,0);
});
