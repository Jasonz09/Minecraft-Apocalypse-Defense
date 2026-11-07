import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {retainedRoofColumnsSteps,roofEntranceColumn,roofFixtureAlternates} from '../../CivilizationApocalypse_BP/scripts/civ/roofcolumns.js';
import {anchoredInteriorLights} from '../../CivilizationApocalypse_BP/scripts/civ/interiorlights.js';
import {normalizeOps} from '../../CivilizationApocalypse_BP/scripts/civ/opnorm.js';
import {newOps} from '../../CivilizationApocalypse_BP/scripts/civ/regions.js';
import {BLUEPRINTS2} from '../../CivilizationApocalypse_BP/scripts/structures/blueprints2.js';

// Actual verified D1 hall metadata (checksum07515fcb, lots[9], hash9351d40b).
// Reconstruct its production blueprint/support operations; no dist/live-save dependency.
const url=new URL('../../CivilizationApocalypse_BP/scripts/civ/districtplan.js',import.meta.url);
const source=readFileSync(url,'utf8').replace(/from\s+"(\.[^"]+)"/g,(_all,spec)=>`from ${JSON.stringify(new URL(spec,url).href)}`)
    .replace('export function siteOpsFor(', 'function actualSiteOpsFor(')
    +'\nfunction siteOpsFor(r,s,i){return r.__fixtureOriginal&&s==="lots"?r.__fixtureOriginal:actualSiteOpsFor(r,s,i);}\nexport {buildingOpsSteps};';
const production=await import('data:text/javascript,'+encodeURIComponent(source));
const run=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
const key=p=>`${p.x},${p.y},${p.z}`;
const element={id:'building-d1-command_hall-1',kind:'building-command_hall',blueprint:'command_hall_v2',rot:3,
    bbox:{x0:18,z0:-555,x1:31,z1:-533},baseY:67,door:{x:28,z:-544},exit:{x:31,z:-544},facing:'east'};
const original=normalizeOps(run(production.buildingOpsSteps({kind:'command_hall'},BLUEPRINTS2[element.blueprint],element.rot,
    element.bbox.x0,element.bbox.z0,element.baseY,{rect:element.bbox,door:element.door,facing:element.facing},newOps(),false)));
const record={lots:[element],__fixtureOriginal:original};
const group=run(production.buildingRoofRevisionSteps(record,newOps(),undefined,true))[0];
const extra={x:26,y:72,z:-552};
function snapshot() {
    const live=new Map(original.map(op=>[key(op),op.id]));
    for(const op of group.changes)if(!live.has(key(op)))live.set(key(op),'minecraft:air');
    for(let y=67;y<=73;y++)for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
        const k=key({x:extra.x+dx,y,z:extra.z+dz});if(!live.has(k))live.set(k,'minecraft:air');
    }
    live.set(key(extra),'minecraft:birch_log');return live;
}
test('actual D1 hall retains birch and four existing stones while revised roof stays independently connected and entrance clears',()=>{
    assert.equal(original.length,2322);assert.equal(group.changes.length,1372);
    const live=snapshot(),result=run(retainedRoofColumnsSteps(group,live));
    assert.equal(result.ok,true,result.reason);assert.equal(result.columns,1);
    assert.deepEqual([...result.keep].sort(),[68,69,70,71,72].map(y=>`26,${y},-552`).sort());
    const final=new Map(original.map(op=>[key(op),op]));
    for(const op of group.changes)if(!result.keep.has(key(op))){if(op.id==='minecraft:air')final.delete(key(op));else final.set(key(op),op);}
    final.set(key(extra),{...extra,id:'minecraft:birch_log'});
    assert.equal(final.get('26,72,-552').id,'minecraft:birch_log');
    assert.equal(final.has('27,69,-544'),false);assert.equal(final.has('27,70,-544'),false);
    assert.equal(final.get('27,68,-544').id,'minecraft:red_carpet');
    const seen=new Set(),queue=[...final.values()].filter(op=>op.y<=67);queue.forEach(op=>seen.add(key(op)));
    for(let i=0;i<queue.length;i++)for(const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
        const p=queue[i],k=key({x:p.x+dx,y:p.y+dy,z:p.z+dz});if(final.has(k)&&!seen.has(k)){seen.add(k);queue.push(final.get(k));}
    }
    assert.equal(final.size,960);assert.equal(seen.size,final.size,'independent connectivity includes the retained extra');
});
for(const id of ['minecraft:sand','minecraft:torch','minecraft:chest','minecraft:diamond_block'])
test(`retained-column exception refuses ${id}`,()=>{
    const live=snapshot();live.set(key(extra),id);assert.equal(run(retainedRoofColumnsSteps(group,live)).ok,false);
});
test('missing column, altered floor, foreign needed joist, attached contact and entrance column fail closed',()=>{
    const addition=group.changes.find(op=>op.id!=='minecraft:air');assert.ok(addition);
    for(const edit of [live=>live.set('26,70,-552','minecraft:air'),live=>live.set('26,67,-552','minecraft:chest'),
        live=>live.set(key(addition),'minecraft:chest'),live=>live.set('25,72,-552','minecraft:torch'),
        live=>{live.set(key(extra),'minecraft:stone_bricks');live.set('27,72,-544','minecraft:birch_log');}]) {
        const live=snapshot();edit(live);assert.equal(run(retainedRoofColumnsSteps(group,live)).ok,false);
    }
    assert.equal(roofEntranceColumn(element,27,-544),true);assert.equal(roofEntranceColumn(element,31,-544),true);
    assert.equal(roofEntranceColumn(element,26,-552),false);
});

test('actual hall keep-mode accepts only a fully supported migrated lantern alternate and guards its source/target/state/anchor',()=>{
 const fixtures=anchoredInteriorLights(group.revised,67,{rect:element.bbox,door:element.door,facing:element.facing}).fixtures;
 const f=fixtures.find(f=>key(f.before)!==key(f.after));assert.ok(f);
 const live=snapshot(),kept=run(retainedRoofColumnsSteps(group,live));assert.equal(kept.ok,true);
 for(const op of group.changes)if(!kept.keep.has(key(op)))live.set(key(op),op.id);
 live.set(key(f.before),'minecraft:air');live.set(key(f.after),'minecraft:lantern');
 const states=new Map([[key(f.after),f.after.states.hanging]]);
 const alternate=roofFixtureAlternates(group,fixtures,live,states),proof=run(retainedRoofColumnsSteps(alternate.group,live));
 assert.equal(proof.ok,true,proof.reason);assert.equal(proof.columns,1);
 assert.equal(alternate.guards.get(key(f.before)),'minecraft:air');assert.equal(alternate.guards.get(key(f.after)),'minecraft:lantern');assert.equal(alternate.guards.get(key(f.anchor)),f.anchor.id);
 assert.equal(alternate.group.changes.some(op=>key(op)===key(f.after)),false,'roof repair cannot remove the new fixture');
 states.set(key(f.after),!f.after.states.hanging);
 assert.equal(run(retainedRoofColumnsSteps(roofFixtureAlternates(group,fixtures,live,states).group,live)).ok,false,'wrong migrated attachment state refuses');
 states.set(key(f.after),f.after.states.hanging);live.set(key(f.anchor),'minecraft:chest');
 assert.equal(run(retainedRoofColumnsSteps(roofFixtureAlternates(group,fixtures,live,states).group,live)).ok,false,'foreign anchor refuses');
});
