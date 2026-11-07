import assert from 'node:assert/strict';
import test from 'node:test';
import {makeField} from '../lib/fakefield.mjs';
import {planCivilizationDetailed} from '../../CivilizationApocalypse_BP/scripts/civ/masterplan.js';
import {planDistrictSite,siteOpsFor,siteOptionsOf,rehydrateSite} from '../../CivilizationApocalypse_BP/scripts/civ/districtplan.js';
import {exportSiteGround,siteGroundRegion} from '../../CivilizationApocalypse_BP/scripts/civ/siteprofile.js';

test('school hip roof stays connected above a clear entrance aisle; archived pillar layout still rehydrates',()=>{
    const field=makeField(12,{relief:2,hills:60});
    const master=planCivilizationDetailed(field,{seed:12});assert.ok(master.ok);
    const options={seed:12,lotTerrain:'survey-balanced',lighting:'natural'};
    const legacy=planDistrictSite(master.plan,5,field,options);assert.ok(legacy.ok);
    const current=planDistrictSite(master.plan,5,field,{...options,roofSupport:'joists'});assert.ok(current.ok);
    const school=(r)=>{const i=r.lots.findIndex(e=>e.kind==='building-school');assert.ok(i>=0);return {e:r.lots[i],ops:siteOpsFor(r,'lots',i)};};
    const old=school(legacy.record),now=school(current.record);
    const [dx,dz]=({north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]})[now.e.facing];
    const aisle=(ops)=>ops.filter(op=>op.y>now.e.baseY && op.y<=now.e.baseY+2 && [1,2,3,4].some(n=>op.x===now.e.door.x-dx*n && op.z===now.e.door.z-dz*n));
    assert.ok(aisle(old.ops).some(op=>op.id==='minecraft:stone_bricks'),'reproduce the live entrance blockage');
    assert.deepEqual(aisle(now.ops),[],'a person has two blocks of headroom along the entrance aisle');
    assert.ok(now.ops.filter(op=>op.kind==='support').every(op=>op.y>=now.e.baseY+3),'roof supports stay above people');
    const key=(x,y,z)=>`${x},${y},${z}`,at=new Set(now.ops.filter(o=>o.id!=='minecraft:air').map(o=>key(o.x,o.y,o.z)));
    const seen=new Set(),queue=now.ops.filter(o=>o.y<=now.e.baseY).map(o=>[o.x,o.y,o.z]);
    for(const [x,y,z] of queue)seen.add(key(x,y,z));
    for(let i=0;i<queue.length;i++)for(const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const [x,y,z]=queue[i],n=[x+dx,y+dy,z+dz],k=key(...n);
        if(at.has(k)&&!seen.has(k)){seen.add(k);queue.push(n);}
    }
    assert.equal(seen.size,at.size,'independent face-connected support check, including every roof course');
    const ground=exportSiteGround(field,siteGroundRegion(master.plan,5));
    for(const original of [legacy,current]) {
        const restored=rehydrateSite(master.plan,5,ground,siteOptionsOf(original.record));assert.ok(restored.ok);
        assert.equal(restored.record.checksum,original.record.checksum);
    }
    assert.equal(siteOptionsOf(legacy.record).roofSupport,undefined);
    assert.equal(siteOptionsOf(current.record).roofSupport,'joists');
});
