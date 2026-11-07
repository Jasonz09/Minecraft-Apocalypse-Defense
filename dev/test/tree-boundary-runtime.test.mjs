import assert from 'node:assert/strict';
import test from 'node:test';
import {mc,key,groundCell,typeAt,resetWorld,builder,districtBuilder,planstore,siteplan,CIV_EVENT_IDS,makePlayer,send,pump,text} from '../lib/civharness.mjs';

async function plantedBranch(length) {
    resetWorld(1);
    const player=makePlayer(0,0);
    send(CIV_EVENT_IDS.generate,'seed=1',player);
    await pump({until:()=>builder.hasSession()});assert.ok(builder.hasSession(),text(player));
    send(CIV_EVENT_IDS.abort,'',player);await pump();assert.equal(districtBuilder.isBusy(),false);
    const master=builder.loadMasterPlan(),stored=planstore.createPlanStore(mc.world,{prefix:builder.sitePrefixFor(1)}).loadPlan();
    const restored=siteplan.rehydrateSite(master.plan,1,stored.plan.ground,{...stored.plan.siteOptions,expectChecksum:stored.plan.siteChecksum});assert.ok(restored.ok);
    let spot;
    for(let i=0;i<restored.record.clear.length&&!spot;i++)for(const op of siteplan.siteOpsFor(restored.record,'clear',i)){
        const cell=groundCell(op.x,op.z);if(cell?.tree){spot={x:op.x,z:op.z,g:cell.g};break;}
    }
    assert.ok(spot);const {x,z,g}=spot,cells=[];
    const add=(a,b,c,id)=>{mc.placed.set(key(a,b,c),id);cells.push({x:a,y:b,z:c,id});};
    for(let y=g+1;y<=g+20;y++)add(x,y,z,'minecraft:oak_log');
    for(let dx=1;dx<=length;dx++)add(x+dx,g+20,z,'minecraft:oak_log');
    for(let dx=-1;dx<=1;dx++)add(x+dx,g+21,z,'minecraft:oak_leaves');
    for(let dx=length-1;dx<=length+1;dx++)add(x+dx,g+21,z,'minecraft:oak_leaves');
    send(CIV_EVENT_IDS.resume,'',player);await pump();
    assert.match(text(player),/is built/,text(player).slice(-1500));
    return {player,cells,spot};
}

test('branch beyond the old eight-block limit is cleared completely instead of leaving a floating tip', {timeout:300000}, async()=>{
    const {cells,spot}=await plantedBranch(14);
    for(const cell of cells.filter(c=>c.y>=spot.g+20))assert.equal(typeAt(cell.x,cell.y,cell.z),'minecraft:air',`${key(cell.x,cell.y,cell.z)} branch/crown removed`);
});

test('a branch exceeding the bounded survey is preserved whole instead of severed at the limit', {timeout:300000}, async()=>{
    const {player,cells}=await plantedBranch(24);
    assert.match(text(player),/branch continues beyond the bounded tree survey/);
    for(const cell of cells)assert.equal(typeAt(cell.x,cell.y,cell.z),cell.id,`${key(cell.x,cell.y,cell.z)} retained`);
});
