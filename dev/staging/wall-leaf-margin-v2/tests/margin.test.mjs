import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SITE_STAGES} from '../runtime/CivilizationApocalypse_BP/scripts/civ/districtplan.js';
import * as v2 from '../runtime/CivilizationApocalypse_BP/scripts/civ/wallLeafMarginTrim.js';
import * as v1 from '../runtime/CivilizationApocalypse_BP/scripts/civ/wallLeafTrim.js';
import {createMarginProtection,classifyMarginColumn} from '../runtime/CivilizationApocalypse_BP/scripts/civ/wallLeafMarginProtection.js';
import {wallLeafMarginRepairSteps} from '../runtime/CivilizationApocalypse_BP/scripts/civ/wallLeafMarginRepair.js';
const run=g=>{for(;;){const n=g.next();if(n.done)return n.value;}};
const cell=(typeId,states={})=>({isValid:true,typeId,states});
const leaf=()=>cell('minecraft:jungle_leaves',{persistent_bit:false});
const pos=(x=0,y=70,z=0)=>({x,y,z});
const op=(p,id='minecraft:stone_bricks',kind='wall',states={})=>({...p,id,kind,states});
const deps={opsFor:(record,stage,i)=>record[stage][i].ops};
const rect=(x0,z0,x1,z1)=>[[x0,z0],[x1,z0],[x1,z1],[x0,z1]];
function fixture(count=1,change=()=>{}){
 const sources=[1,2,3,4,5].map(n=>{const record={districtIndex:n,checksum:`0000000${n}`,outline:n===5?rect(4,-30,14,30):n===4?rect(-20,-30,3,30):rect(n*100,-30,n*100+10,30),...Object.fromEntries(SITE_STAGES.map(stage=>[stage,[]]))};return{record,civ:{status:'complete',checksum:record.checksum,dimension:'minecraft:overworld'},masterHash:'1234abcd'};});
 const record=sources[3].record,candidates=Array.from({length:count},(_,i)=>pos(0,70,i*4));
 record.walls=candidates.map(p=>({ops:[op(p),op({...p,y:69},'minecraft:cobblestone','footing')]}));
 const areas=sources.filter(s=>s.record!==record).map(s=>{const polygon=s.record.outline,xs=polygon.map(p=>p[0]),zs=polygon.map(p=>p[1]);return {districtIndex:s.record.districtIndex,polygon,grow:4,x0:Math.min(...xs)-4,x1:Math.max(...xs)+4,z0:Math.min(...zs)-4,z1:Math.max(...zs)+4};});
 const input={index:4,checksum:record.checksum,masterHash:'1234abcd',dimension:'minecraft:overworld',sources,candidates};
 const blocks=new Map(candidates.flatMap(p=>[[v2.key(p),leaf()],[v2.key({...p,y:69}),cell('minecraft:cobblestone')]])),writes=[],props=new Map(),propertyWrites=[];
 let raw,reads=0,current=true,cancelled=false,protection;
 const ctx={read(p){reads++;return structuredClone(blocks.get(v2.key(p))??cell('minecraft:air'));},isProtected(x,z){return classifyMarginColumn(protection,x,z)!=='plain';},getProtection:()=>protection,sourcesCurrent:()=>current,cancelled:()=>cancelled,write(p){writes.push({...p});blocks.set(v2.key(p),cell(p.id,p.states));}};
 const io={load:()=>raw,save:v=>{raw=v;}};
 const world={getDynamicPropertyIds:()=>[...props.keys()],getDynamicProperty:k=>props.get(k),setDynamicProperty(k,v){propertyWrites.push([k,v]);props.set(k,v);}};
 const f={input,record,sources,areas,candidates,blocks,writes,props,world,ctx,io,propertyWrites,get raw(){return raw;},set raw(v){raw=v;},get reads(){return reads;},set current(v){current=v;},set cancelled(v){cancelled=v;},set protection(v){protection=v;},refresh(){protection=createMarginProtection(areas,sources,4);input.protection=protection;}};
 change(f);f.refresh();f.compile=()=>v2.compileLeafTrim(input,deps);f.prepare=plan=>v2.prepareLeafTrim(plan,ctx,io,{policy:v2.POLICY});f.commit=(plan,i=0)=>v2.commitOneLeafTrim(plan,v2.key(candidates[i]),ctx,io,{policy:v2.POLICY});
 f.controller=(confirm=false)=>run(wallLeafMarginRepairSteps(input,ctx,world,{confirm,policy:v2.POLICY},deps));
 return f;
}
function v1Receipt(f,target,complete=true){
 const p=v1.compileLeafTrim({...f.input,candidates:[target]},deps);let raw;
 const local={...f.ctx,isProtected:()=>false};
 v1.prepareLeafTrim(p,local,{load:()=>raw,save:v=>raw=v},{policy:v1.POLICY});
 if(complete)v1.commitOneLeafTrim(p,v1.key(target),local,{load:()=>raw,save:v=>raw=v},{policy:v1.POLICY});
 return {key:`civ:wall_leaf_trim:v1:d4:${p.planId}`,raw};
}

test('v1 implementation files are byte-identical to captured baseline',()=>{
 const base=JSON.parse(readFileSync(new URL('../base-hashes.json',import.meta.url),'utf8'));
 for(const suffix of ['civ/wallLeafTrim.js','civ/wallLeafRepair.js','civ/wallleafpreview.js']){
  const row=base.find(r=>r.path.replaceAll('\\','/').endsWith(suffix));
  const bytes=readFileSync(new URL('../runtime/CivilizationApocalypse_BP/scripts/'+suffix,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex').toUpperCase(),row.sha256);
 }
});
test('same synthetic margin fixture: v1 refuses while v2 proves exact56-read leaf replacement',()=>{
 const f=fixture(),p=f.compile(),old=v1.compileLeafTrim(f.input,deps);
 assert.equal(v1.previewLeafTrim(old,f.ctx).eligible,0);assert.equal(v2.previewLeafTrim(p,f.ctx).eligible,1);assert.equal(p.v,2);
 f.prepare(p);const before=f.reads,r=f.commit(p);assert.equal(r.reads,56);assert.equal(f.reads-before,56);assert.equal(r.changed,1);assert.equal(f.writes.length,1);
 assert.equal(JSON.parse(f.raw).v,3);assert.equal(JSON.parse(f.raw).policy,'wall-leaves-margin-v2');assert.equal(f.commit(p).changed,0);
});
test('ordinary unprotected targets remain v1 territory, not implicit v2 permission',()=>{
 const f=fixture(1,f=>{f.candidates[0].x=-10;f.record.walls[0].ops=f.record.walls[0].ops.map(o=>({...o,x:-10}));});assert.equal(f.compile().proposals.length,0);
});
for(const x of [2,3,4,5])test(`neighbor hard-margin/outline/interior contact at target x=${x} refuses`,()=>{
 const f=fixture(1,f=>{f.candidates[0].x=x;f.record.walls[0].ops=f.record.walls[0].ops.map(o=>({...o,x}));});assert.equal(f.compile().proposals.length,0);assert.equal(f.writes.length,0);
});
test('prototype rectangle vetoes even benign-contact columns',()=>{const f=fixture(1,f=>f.areas.push({x0:-1,x1:-1,z0:0,z1:0}));assert.equal(f.compile().proposals.length,0);});
for(const id of ['minecraft:air','minecraft:stone_bricks','minecraft:oak_log'])test(`any neighboring historical ${id} operation vetoes even after overwrite`,()=>{
 const f=fixture(1,f=>{f.sources[4].record.clear.push({ops:[op(pos(-1,69,0),id,'clear')]});f.sources[4].record.dressing.push({ops:[op(pos(-1,69,0),'minecraft:air','dressing')]});});assert.equal(f.compile().proposals.length,0);
});
for(const stage of ['gates','lots','dressing'])test(`later own ${stage} overwrite removes exact-wall authority`,()=>{const f=fixture(1,f=>f.record[stage].push({ops:[op(pos(),'minecraft:air','dressing')]}));assert.equal(f.compile().proposals.length,0);});
for(const bad of ['grow','outline','missing','duplicate','unknown','self-crossing'])test(`unverifiable protection ${bad} refuses`,()=>{
 assert.throws(()=>fixture(1,f=>{if(bad==='grow')f.areas.at(-1).grow=3;if(bad==='outline')f.areas.at(-1).polygon=rect(5,-30,14,30);if(bad==='missing')f.areas.pop();if(bad==='duplicate')f.areas.push(f.areas[0]);if(bad==='unknown')f.areas.at(-1).districtIndex=99;if(bad==='self-crossing')f.sources[4].record.outline=f.areas.at(-1).polygon=[[4,-30],[14,30],[4,30],[14,-30]];}));
});
test('cloned protection token and missing completed source cannot authorize compiler',()=>{const f=fixture();f.input.protection=structuredClone(f.input.protection);assert.throws(()=>f.compile(),/token/);const g=fixture();g.input.sources.pop();assert.throws(()=>g.compile(),/five|source/);});
for(const id of ['minecraft:chest','minecraft:oak_log','minecraft:water','minecraft:vine'])test(`foreign ${id} contact keeps entire target`,()=>{const f=fixture(),p=f.compile();f.blocks.set(v2.key(pos(-1)),cell(id));assert.equal(v2.previewLeafTrim(p,f.ctx).eligible,0);assert.throws(()=>f.prepare(p));assert.equal(f.writes.length,0);});
test('persistent or unreadable target leaves refuse',()=>{for(const state of [true,undefined]){const f=fixture(),p=f.compile();f.blocks.set(v2.key(pos()),cell('minecraft:jungle_leaves',state===undefined?{}:{persistent_bit:state}));assert.throws(()=>f.prepare(p));assert.equal(f.writes.length,0);}});
test('last-read source change refuses before cached writer',()=>{
 const f=fixture(),p=f.compile();f.prepare(p);let n=0;const read=f.ctx.read;f.ctx.read=q=>{const b=read(q);if(++n===55)f.current=false;return b;};assert.throws(()=>f.commit(p),/source/);assert.equal(f.writes.length,0);
});
test('last-read protection change refuses before write',()=>{
 const f=fixture(),p=f.compile();f.prepare(p);let n=0;const read=f.ctx.read;f.ctx.read=q=>{const b=read(q);if(++n===55){f.areas.push({x0:0,x1:0,z0:0,z1:0});f.refresh();}return b;};assert.throws(()=>f.commit(p),/provenance|margin|protected/);assert.equal(f.writes.length,0);
});
test('late contact/leaf edit refuses and retains checkpoint',()=>{const f=fixture(),p=f.compile();f.prepare(p);const original=f.raw;let n=0;const read=f.ctx.read;f.ctx.read=q=>{if(++n===28)f.blocks.set(v2.key(pos()),leafWithChange());return read(q);};function leafWithChange(){return cell('minecraft:oak_leaves',{persistent_bit:false});}assert.throws(()=>f.commit(p),/changed/);assert.equal(f.raw,original);assert.equal(f.writes.length,0);});
test('v2 receipt cannot be interpreted under v1 or vice versa',()=>{const f=fixture(),p=f.compile();f.prepare(p);assert.throws(()=>v1.readLeafTrimReceipt(f.raw));const old=v1Receipt(f,pos(),false);assert.throws(()=>v2.readLeafTrimReceipt(old.raw));});
test('controller preview writes neither world nor property',()=>{const f=fixture(),r=f.controller();assert.equal(r.rows.length,1);assert.equal(r.writeAttempts,0);assert.equal(f.propertyWrites.length,0);assert.equal(f.writes.length,0);});
test('completed v1 write targets block v2 but adjacent completed v1 masonry does not',()=>{
 const f=fixture();const old=v1Receipt(f,pos(),true);f.blocks.set(v2.key(pos()),leaf());f.props.set(old.key,old.raw);const r=f.controller(true);assert.match(r.state,/v1 receipt/);assert.equal(f.propertyWrites.length,0);assert.equal(f.writes.length,1,'only test setup v1 write');
 const g=fixture();const adjacent=pos(-1);g.record.walls.push({ops:[op(adjacent)]});g.blocks.set(v2.key(adjacent),leaf());const other=v1Receipt(g,adjacent,true);g.props.set(other.key,other.raw);const before=g.writes.length;const result=g.controller(true);assert.equal(result.state,'batch complete');assert.equal(g.writes.length-before,1);assert.equal(g.props.get(other.key),other.raw);
});
test('ANY unfinished v1 receipt refuses v2 before property or block writes',()=>{const f=fixture();const old=v1Receipt(f,pos(),false);f.props.set(old.key,old.raw);const r=f.controller(true);assert.match(r.state,/unfinished v1/);assert.equal(f.propertyWrites.length,0);assert.equal(f.writes.length,0);});
test('both-namespace receipt change across yield holds batch',()=>{const f=fixture(),g=wallLeafMarginRepairSteps(f.input,f.ctx,f.world,{confirm:true,policy:v2.POLICY},deps);g.next();f.props.set('civ:wall_leaf_trim:future','unknown');const r=run(g);assert.match(r.state,/held/);assert.equal(f.writes.length,0);});
test('interrupted receipt resumes original targets without new admission',()=>{const f=fixture(2),p=f.compile();f.prepare(p);f.commit(p,0);const original=f.raw;const resumed=run(v2.resumeLeafTrimSteps({...f.input,candidates:[]},f.ctx,f.io,deps,{policy:v2.POLICY}));assert.deepEqual(resumed.requested,p.requested);assert.equal(f.raw,original);assert.equal(f.commit(resumed,0).changed,0);assert.equal(f.commit(resumed,1).changed,1);assert.equal(JSON.parse(f.raw).complete,true);});
test('changed protection after interruption cannot resume old authority',()=>{const f=fixture(2),p=f.compile();f.prepare(p);f.commit(p,0);const original=f.raw;f.areas.push({x0:0,x1:0,z0:4,z1:4});f.refresh();assert.throws(()=>run(v2.resumeLeafTrimSteps(f.input,f.ctx,f.io,deps,{policy:v2.POLICY})));assert.equal(f.raw,original);assert.equal(f.writes.length,1);});
test('journal CAS and dropped checkpoint never grant further writes',()=>{const f=fixture(),p=f.compile();f.prepare(p);f.raw=f.raw+' ';assert.throws(()=>f.commit(p),/journal|source/);assert.equal(f.writes.length,0);const g=fixture(),q=g.compile();g.io.save=()=>{};assert.throws(()=>g.prepare(q),/read back/);assert.equal(g.writes.length,0);});
