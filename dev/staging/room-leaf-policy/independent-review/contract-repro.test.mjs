import assert from 'node:assert/strict';

import test from 'node:test';

import {POLICY,previewRoomLeaves} from '../policy.mjs';

function fixture(){const p={x:5,y:70,z:7},cube=[];for(let x=4;x<=6;x++)for(let y=69;y<=71;y++)for(let z=6;z<=8;z++)cube.push({x,y,z,status:'loaded',id:'minecraft:air',states:{}});Object.assign(cube.find(c=>c.x===5&&c.y===70&&c.z===7),{id:'minecraft:oak_leaves',states:{persistent_bit:false,update_bit:false,old_leaf_type:'oak'}});return{policy:POLICY,index:5,checksum:'23a6aeca',masterHash:'9e5e307e',dimension:'minecraft:overworld',building:{id:'building-d5-chapel-1',ordinal:1,kind:'building-chapel',stage:'lots',sourceElementHash:'0d14ee16',blueprint:'chapel_v2',rot:0,baseY:67,bbox:{x0:0,x1:8,z0:0,z1:14}},sources:[1,2,3,4,5].map(index=>({index,checksum:index===5?'23a6aeca':'1234abcd',dimension:'minecraft:overworld',queue:'complete',protectedCells:[],ops:[]})),targets:[{...p,neighbors:cube}]};}

const run=f=>{const g=previewRoomLeaves(f,{current:()=>true});for(;;){const n=g.next();if(n.done)return n.value;}};

const op=(id,stage='lots',states={})=>({x:4,y:69,z:6,id,stage,element:'building-d5-chapel-1',states});

test('regression: exact structural matching refuses extra observed state beyond declared empty stateless claim',()=>{

 const f=fixture(),n=f.targets[0].neighbors[0];n.id='minecraft:stone_bricks';n.states={unreviewed:true};f.sources[4].ops=[op('minecraft:stone_bricks')];const r=run(f);assert.equal(r.eligible,0,'extra observed metadata cannot match an exact empty stateless claim');assert.equal(r.writePermission,false);

});

test('regression: historical decorative flower overwritten byAIR is vetoed',()=>{

 const f=fixture();f.sources[0].ops=[op('minecraft:red_tulip','clear'),op('minecraft:air','lots')];const r=run(f);assert.equal(r.eligible,0,'historical flower cannot be waived by laterAIR');assert.equal(r.writePermission,false);

});

test('regression: selected-district other-building interior projection vetoes',()=>{

 const f=fixture();f.sources[4].protectedCells=[{x:4,y:69,z:6,kind:'interior',buildingId:'building-d5-house_s-1'}];const r=run(f);assert.equal(r.eligible,0,'another building in selected district remains protected');assert.equal(r.writePermission,false);

});

