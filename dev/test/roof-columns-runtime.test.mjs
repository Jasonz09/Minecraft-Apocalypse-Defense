import assert from 'node:assert/strict';
import test from 'node:test';
import {retainedRoofColumnsSteps} from '../../CivilizationApocalypse_BP/scripts/civ/roofcolumns.js';
import {makeField} from '../lib/fakefield.mjs';
import {mc,key,typeAt,load,resetWorld,store,builder,siteplan,makePlayer,send,pump,text,propsSnapshot,worldFingerprint,districtBuilder,CIV_EVENT_IDS} from '../lib/civharness.mjs';
const {planCivilizationDetailed}=await load('civ/masterplan.js');
const {exportSiteGround,siteGroundRegion}=await load('civ/siteprofile.js');
const {createInitialKingdom}=await load('kingdom/state.js');
const {newOps}=await load('civ/regions.js');
const run=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
const k=op=>key(op.x,op.y,op.z);

test('opt-in anchored-column repair preflights, keeps defaults, completes joists before removals and safely resumes without saved-plan changes',{timeout:300000},async()=>{
    resetWorld(12);
    const field=makeField(12,{relief:2,hills:60}),master=planCivilizationDetailed(field,{seed:12});assert.ok(master.ok);
    const planned=siteplan.planDistrictSite(master.plan,5,field,{seed:12,lotTerrain:'survey-balanced',lighting:'natural'});assert.ok(planned.ok);
    const r=planned.record,ground=exportSiteGround(field,siteGroundRegion(master.plan,5));
    const persisted=builder.persistRun({district:5,record:r,masterIsNew:true,master:{version:1,plan:master.plan,seed:12,planSeed:12,anchor:master.plan.anchor},
        payload:{version:1,district:5,ground,siteChecksum:r.checksum,siteOptions:siteplan.siteOptionsOf(r),site:{version:siteplan.SITE_PLAN_VERSION}}});assert.ok(persisted.ok);
    const kingdom=createInitialKingdom();kingdom.districts[4].civ={status:'complete',stage:'complete',seed:12,checksum:r.checksum,anchor:master.plan.anchor,centre:master.plan.anchor,startedStep:0,dimension:'minecraft:overworld'};store.save(kingdom);
    const groups=run(siteplan.buildingRoofRevisionSteps(r,newOps(),undefined,true));
    let group,extra,proof;
    for(const g of groups) {
        if(!g.changes.some(op=>op.id!=='minecraft:air'))continue;
        const maxY=Math.max(...g.original.map(op=>op.y));
        const base=new Map();
        for(let x=g.element.bbox.x0-1;x<=g.element.bbox.x1+1;x++)for(let z=g.element.bbox.z0-1;z<=g.element.bbox.z1+1;z++)for(let y=g.element.baseY;y<=maxY+1;y++)base.set(key(x,y,z),'minecraft:air');
        for(const op of g.original)base.set(k(op),op.id);
        for(const op of g.changes)if(op.id==='minecraft:air'&&op.y>g.element.baseY+2) {
            const live=new Map(base);live.set(k(op),'minecraft:birch_log');
            const candidate=run(retainedRoofColumnsSteps(g,live));
            if(candidate.ok){group=g;extra=op;proof=candidate;for(const [at,id] of live)mc.placed.set(at,id);break;}
        }
        if(group)break;
    }
    assert.ok(group&&extra&&proof,'production layout supplies an anchored log-column fixture');
    const additions=group.changes.filter(op=>op.id!=='minecraft:air');
    const removals=group.changes.filter(op=>op.id==='minecraft:air'&&!proof.keep.has(k(op)));
    assert.ok(additions.length>1);assert.ok(removals.length>10);
    const snapshot=propsSnapshot(),before=worldFingerprint(),writes=mc.writes;
    const audit=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns',audit);await pump();
    assert.match(text(audit),/retained_columns 1/);assert.equal(mc.writes,writes);assert.deepEqual(worldFingerprint(),before);
    const normal=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 confirm',normal);await pump();
    assert.equal(mc.writes,writes,'default whole-building guard still refuses the unknown log');
    mc.placed.set(k(additions[0]),'minecraft:chest');
    const obstructed=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',obstructed);await pump();
    assert.equal(mc.writes,writes,'foreign needed joist prevents every removal');
    mc.placed.set(k(additions[0]),additions[0].before);
    const repair=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',repair);
    await pump({until:()=>mc.writes>writes});
    for(const op of removals)assert.equal(typeAt(op.x,op.y,op.z),op.before,'initial additions remove no old support');
    // A foreign obstruction appears AFTER this live run's initial preflight.
    // The ongoing addition phase must stop before any removal, without needing a restart.
    const pendingAddition=additions.find(op=>typeAt(op.x,op.y,op.z)!==op.id);assert.ok(pendingAddition);
    mc.placed.set(k(pendingAddition),'minecraft:chest');const partialWrites=mc.writes;
    await pump();assert.equal(mc.writes,partialWrites);
    for(const op of removals)assert.equal(typeAt(op.x,op.y,op.z),op.before);
    // Restart also refuses that obstruction rather than inferring the joist exists.
    const blockedResume=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',blockedResume);await pump();
    assert.equal(mc.writes,partialWrites);for(const op of removals)assert.equal(typeAt(op.x,op.y,op.z),op.before);
    mc.placed.set(k(pendingAddition),pendingAddition.before);
    const interrupted=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',interrupted);
    await pump({until:()=>mc.writes>partialWrites});districtBuilder.cancelActiveJob();await pump();
    const pausedWrites=mc.writes;
    // Both the existing retained stone chain and its floor are live prerequisites,
    // not permissions remembered from the interrupted run.
    for(const at of [extra.y-1,group.element.baseY]) {
        const position={x:extra.x,y:at,z:extra.z},previous=typeAt(position.x,position.y,position.z);
        mc.placed.set(k(position),'minecraft:chest');
        const changedAnchor=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',changedAnchor);await pump();
        assert.equal(mc.writes,pausedWrites);for(const op of removals)assert.equal(typeAt(op.x,op.y,op.z),op.before);
        assert.equal(typeAt(position.x,position.y,position.z),'minecraft:chest');mc.placed.set(k(position),previous);
    }
    const resume=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',resume);
    await pump({until:()=>removals.some(op=>typeAt(op.x,op.y,op.z)==='minecraft:air')});
    for(const op of additions)assert.equal(typeAt(op.x,op.y,op.z),op.id,'ALL new joists precede the first removal');
    districtBuilder.cancelActiveJob();await pump();
    const finish=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',finish);await pump();
    for(const op of group.changes)assert.equal(typeAt(op.x,op.y,op.z),proof.keep.has(k(op))?(k(op)===k(extra)?'minecraft:birch_log':'minecraft:stone_bricks'):op.id);
    const done=mc.writes,repeat=makePlayer();send(CIV_EVENT_IDS.roofSupport,'district=5 keep_columns confirm',repeat);await pump();
    assert.equal(mc.writes,done);assert.match(text(repeat),/changed 0/);assert.match(text(repeat),/retained_columns 1/);
    assert.deepEqual(propsSnapshot(),snapshot);assert.equal(mc.areas.size,0);assert.equal(districtBuilder.isBusy(),false);assert.ok(mc.areaMaxChunks<=16);
});
