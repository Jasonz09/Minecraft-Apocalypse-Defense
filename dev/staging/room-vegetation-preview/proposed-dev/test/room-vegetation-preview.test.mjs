import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {roomPreviewGeometry,roomVegetationPreviewSteps,formatRoomVegetationPreview,ROOM_PREVIEW_LIMITS} from '../../CivilizationApocalypse_BP/scripts/civ/roomVegetationPreview.js';
import {SITE_STAGES} from '../../CivilizationApocalypse_BP/scripts/civ/districtplan.js';
function fixture(){
 const element={id:'building-d5-chapel-1',kind:'building-chapel',stage:'lots',blueprint:'chapel_v2',rot:3,baseY:67,bbox:{x0:-220,x1:-206,z0:-540,z1:-532}},record={checksum:'23a6aeca',...Object.fromEntries(SITE_STAGES.map(s=>[s,[]])),lots:[element]},state={current:true,cancelled:false,reads:0,slice:0,maxSlice:0,writes:0,points:[],hooks:{}};
 const ops=[{x:-219,y:68,z:-536,id:'minecraft:lectern'},{x:-216,y:69,z:-537,id:'minecraft:lantern',states:{hanging:false}},{x:-216,y:68,z:-537,id:'minecraft:birch_planks'},...[-220,-206].flatMap(x=>[-540,-532].flatMap(z=>Array.from({length:5},(_,n)=>({x,y:n+68,z,id:'minecraft:birch_log'}))))];
 const defaults=new Map(ops.map(op=>[[op.x,op.y,op.z].join(','),{id:op.id,states:op.states??{}}]));defaults.set('-217,69,-536',{id:'minecraft:oak_leaves',states:{old_leaf_type:'oak',persistent_bit:false,update_bit:false}});
 const ctx={current:()=>state.current,cancelled:()=>state.cancelled,opsFor:()=>ops,getBlock(p){state.reads++;state.slice++;state.maxSlice=Math.max(state.maxSlice,state.slice);state.points.push({...p});state.hooks.getBlock?.();const cell=defaults.get([p.x,p.y,p.z].join(','))??{id:'minecraft:air',states:{}};if(state.hooks.unloaded?.(p))return undefined;
  return{get isValid(){state.hooks.valid?.();return true;},get typeId(){state.hooks.id?.();return cell.id;},get permutation(){state.hooks.permutation?.();return{get getAllStates(){state.hooks.method?.();return()=>{state.hooks.states?.();return state.hooks.raw?.(cell.states)??cell.states;};}};},setType(){state.writes++;throw Error('write forbidden');},setPermutation(){state.writes++;throw Error('write forbidden');}};
 }};
 return{element,record,state,ctx,defaults};
}
function run(f){const g=roomVegetationPreviewSteps(f.record,f.element.id,f.ctx);for(;;){const n=g.next();if(n.done){assert.equal(f.state.writes,0);return n.value;}f.state.slice=0;}}
test('exact supported chapel enumerates455room+20corners with primitive fullstates and typed furnishing/fixture samples',()=>{
 const f=fixture(),r=run(f);assert.equal(r.totalCells,475);assert.equal(r.roomCells,455);assert.equal(r.reads,475);assert.equal(f.state.reads,475);assert.equal(f.state.maxSlice<=256,true);assert.equal(new Set(f.state.points.map(p=>JSON.stringify(p))).size,475);assert.equal(r.rows.filter(r=>r.tags.includes('corner-post')).length,20);
 const leaf=r.rows.find(r=>r.x===-217&&r.y===69&&r.z===-536);assert.deepEqual(leaf.observed.states,{old_leaf_type:'oak',persistent_bit:false,update_bit:false});assert.equal(leaf.classification,'source-discrepancy');assert.equal(leaf.expected,null,'no district op never becomes savedAIR');assert.ok(r.rows.some(r=>r.tags.includes('lectern')));assert.ok(r.rows.some(r=>r.tags.includes('fixture-lamp')));assert.ok(r.rows.some(r=>r.tags.includes('fixture-anchor')));assert.ok(JSON.stringify(r).includes('no cross-district ownership or AIR/cleanup permission'));
});
for(const rot of[0,1,2,3])test('supported rotation'+rot+' preserves exhaustive room/corner bounds',()=>{
 const f=fixture();f.element.rot=rot;f.element.bbox=rot%2?{x0:0,x1:14,z0:0,z1:8}:{x0:0,x1:8,z0:0,z1:14};const g=roomPreviewGeometry(f.record,f.element.id);assert.equal(g.points.length,475);assert.equal(g.roomCells,455);assert.ok(g.points.every(p=>p.y>=68&&p.y<=72));
});
for(const field of['getBlock','valid','id','permutation','method','states'])test('source change inside native '+field+' getter refuses snapshot result',()=>{const f=fixture();f.state.hooks[field]=()=>{f.state.current=false;};assert.throws(()=>run(f),/source\/player\/dimension changed/);assert.equal(f.state.reads,1);assert.equal(f.state.writes,0);});
test('state value getter source-race and cancellation cannot escape final validation',()=>{
 for(const cancel of[false,true]){const f=fixture();f.state.hooks.raw=()=>Object.defineProperty({},'persistent_bit',{enumerable:true,get(){if(cancel)f.state.cancelled=true;else f.state.current=false;return false;}});assert.throws(()=>run(f),/source\/player\/dimension changed/);assert.equal(f.state.writes,0);}
});
test('player dimension/current guard and cancellation across compilation/native yield refuse without later reads',()=>{
 const f=fixture();f.ctx.opsFor=()=>Array.from({length:401},()=>({x:0,y:0,z:0,id:'minecraft:air'}));const g=roomVegetationPreviewSteps(f.record,f.element.id,f.ctx);assert.equal(g.next().done,false);f.state.current=false;assert.throws(()=>g.next(),/source\/player\/dimension changed/);assert.equal(f.state.reads,0);
 const a=fixture(),it=roomVegetationPreviewSteps(a.record,a.element.id,a.ctx);assert.equal(it.next().done,false);assert.equal(a.state.reads,1);a.state.cancelled=true;assert.throws(()=>it.next(),/cancelled/);assert.equal(a.state.reads,1);
});
test('unloaded and unreadable fullstates are exhaustive incomplete rows rather than AIR or vanished obstructions',()=>{
 const f=fixture();f.state.hooks.unloaded=p=>p.x===-217&&p.y===69&&p.z===-536;const r=run(f);assert.equal(r.complete,false);assert.equal(r.unloaded,1);assert.equal(r.rows.length,475);assert.equal(r.rows.find(p=>p.x===-217&&p.y===69&&p.z===-536).observed.id,null);
 const a=fixture();a.state.hooks.raw=()=>({bad:NaN});const u=run(a);assert.equal(u.unreadable,475);assert.equal(u.complete,false);
});
test('missing/duplicate/unsupported/oversized/invalid source geometry refuses before any native read',()=>{
 for(const mutate of[f=>f.record.lots.push(f.element),f=>f.element.blueprint='house_s_v2',f=>f.element.bbox.x1+=10000,f=>f.element.baseY=319,f=>f.element.rot=4]){const f=fixture();mutate(f);assert.throws(()=>run(f));assert.equal(f.state.reads,0);assert.equal(f.state.writes,0);}assert.equal(ROOM_PREVIEW_LIMITS.cells,1024);
});
test('full state primitive copies do not retain handles or follow later mutated engine state objects',()=>{
 const f=fixture(),states={persistent_bit:false,update_bit:false};f.state.hooks.raw=()=>states;const r=run(f),text=JSON.stringify(r);states.update_bit=true;assert.equal(JSON.stringify(r),text);assert.equal(r.rows[0].observed.states.update_bit,false);
});
test('formatter never queries and paginates atmost32 observation rows without suppressing incomplete totals',()=>{
 const f=fixture();f.state.hooks.raw=()=>({persistent_bit:false});for(const p of roomPreviewGeometry(f.record,f.element.id).points)f.defaults.set([p.x,p.y,p.z].join(','),{id:'minecraft:oak_leaves',states:{persistent_bit:false}});const r=run(f),reads=f.state.reads;const lines=formatRoomVegetationPreview(r,2);assert.equal(lines.length,36);assert.equal(lines.filter(x=>/^-?\d+,/.test(x)).length,32);assert.equal(f.state.reads,reads);assert.equal(f.state.writes,0);assert.match(lines.join('\n'),/page 2\/15/);assert.ok(lines.every(l=>typeof l==='string'));
});
test('production command adapter brackets loader/getters with actualsource/player/job guards and offers no confirm/write/hold path',()=>{
 const source=readFileSync(new URL('../../CivilizationApocalypse_BP/scripts/commands/civ.js',import.meta.url),'utf8').replace(/\r\n/g,'\n'),a=source.indexOf('async function inspectSavedRoom('),b=source.indexOf('\n}\n',a),body=source.slice(a,b);assert.ok(a>0&&b>a);for(const required of['createWallLeafSourceGuard(world','activeToken()===token','player.dimension.id===dimensionId','checked(loadSavedRunSteps(civ,newOps(),index))','saved.queue.state!=="complete"','getBlock:p=>dimension.getBlock(p)','finally{finishJob(token);}','formatRoomVegetationPreview(result,page)'])assert.ok(body.includes(required),required);
 for(const forbidden of['setDynamicProperty','setPermutation','setType(','startConstruction','holdConstruction','createChunkLoader','setInterval','runInterval','runTimeout','confirm'])assert.equal(body.includes(forbidden),false,forbidden);assert.ok(source.includes('roompreview district=([1-5])'));
});

const adapterSource=readFileSync(new URL('../../CivilizationApocalypse_BP/scripts/commands/civ.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const adapterStart=adapterSource.indexOf('async function inspectSavedRoom('),adapterEnd=adapterSource.indexOf('\n}\n',adapterStart)+2;
function adapter(f){
 const token={cancelled:false},events=[],civ={status:'complete',checksum:f.record.checksum,dimension:'minecraft:overworld'},dimension={id:'minecraft:overworld',getBlock:p=>f.ctx.getBlock(p)},player={id:'p1',isValid:true,dimension},kingdom={districts:[{id:'district-5',civ}]};let active=token,finished=0,rawCurrent=true,rawAudits=0,loaderCalls=0;
 const names=['playerOf','districtById','districtIdFor','reserveJob','runningPhrase','reply','createWallLeafSourceGuard','world','activeToken','devGateOn','runJobAsync','loadSavedRunSteps','newOps','roomVegetationPreviewSteps','formatRoomVegetationPreview','finishJob','formatErrorLines'];
 const values=[()=>player,(k,id)=>k.districts.find(d=>d.id===id),n=>'district-'+n,()=>{f.state.onReserve?.(civ,kingdom);return token;},()=>'(busy)',lines=>events.push(lines),(_w,readKingdom)=>{readKingdom();return{current(){readKingdom();rawAudits++;f.state.onRaw?.(rawAudits);return rawCurrent;}};},{},()=>active,()=>true,async(_t,g)=>{for(;;){const n=g.next();if(n.done)return n.value;}},function*(){loaderCalls++;return{ok:true,queue:{state:'complete'},record:f.record};},()=>({}),function*(r,b,c){return yield* roomVegetationPreviewSteps(r,b,{...c,opsFor:f.ctx.opsFor});},formatRoomVegetationPreview,t=>{if(active===t){active=undefined;finished++;}},(title,lines)=>[title,...lines]];
 const invoke=Function(...names,adapterSource.slice(adapterStart,adapterEnd)+';return inspectSavedRoom;')(...values);
 return{run:()=>invoke({load:()=>({kingdom})},{},5,f.element.id,1),events,player,token,get finished(){return finished;},get rawAudits(){return rawAudits;},get loaderCalls(){return loaderCalls;},setRaw(v){rawCurrent=v;}};
}
for(const mode of['player-dimension','player-identity','raw-source','cancel'])test('ACTUAL existing-command adapter refuses '+mode+' native state-getter race and releases only its job',async()=>{
 const f=fixture(),a=adapter(f);f.state.hooks.states=()=>{if(mode==='player-dimension')a.player.dimension={id:'minecraft:nether'};if(mode==='player-identity')a.player.id='replacement';if(mode==='raw-source')a.setRaw(false);if(mode==='cancel')a.token.cancelled=true;};await a.run();assert.equal(a.finished,1);assert.equal(f.state.reads,1);assert.equal(f.state.writes,0);assert.equal(a.events.some(lines=>lines.some(l=>l.startsWith('Room census building-'))),false);
});
test('ACTUAL command adapter reports only guarded primitive census, with honest across-ticks/no timestamp/no paging cache scope',async()=>{
 const f=fixture(),a=adapter(f);await a.run();assert.equal(a.finished,1);assert.equal(f.state.reads,475);assert.equal(f.state.writes,0);assert.ok(a.events.some(lines=>lines.some(l=>l.includes('No engine timestamp sampled or persistent paging cache'))));
});

test('first page pure-prioritizes actual unplannedlogs thenleaves thenotherunknowns before labeled plannedcorner timber',()=>{
 const f=fixture();f.defaults.set('-218,72,-538',{id:'minecraft:jungle_log',states:{pillar_axis:'y'}});f.defaults.set('-218,71,-538',{id:'minecraft:copper_ore',states:{}});const r=run(f),before=f.state.reads,lines=formatRoomVegetationPreview(r,1),rows=lines.filter(l=>/^-?\d+,/.test(l));assert.match(rows[0],/^-218,72,-538.*minecraft:jungle_log/);assert.match(rows[1],/^-217,69,-536.*minecraft:oak_leaves/);assert.match(rows[2],/^-218,71,-538.*minecraft:copper_ore/);assert.ok(rows.slice(3).some(l=>l.includes('[corner-post] planned-ID/explicit-state-match')));assert.equal(f.state.reads,before);assert.match(lines.join('\n'),/separate commands\/pages are NOT the same snapshot/);
});

test('one completed cell per cooperative slice including finalcell; final-yield source/cancel cannot publish stale result',()=>{
 for(const cancel of[false,true]){const f=fixture(),g=roomVegetationPreviewSteps(f.record,f.element.id,f.ctx);let count=0,previous=0;for(;;){const n=g.next();assert.equal(n.done,false);assert.ok(f.state.reads-previous<=1);previous=f.state.reads;count++;if(f.state.reads===475)break;assert.ok(count<=500);}if(cancel)f.state.cancelled=true;else f.state.current=false;assert.throws(()=>g.next(),/cancelled or source\/player\/dimension changed/);assert.equal(f.state.reads,475);assert.equal(f.state.writes,0);}
 const f=fixture();run(f);assert.equal(f.state.maxSlice,1);
});
test('falsy native validity throws are UNREADABLE, never silently loaded',()=>{
 for(const value of[undefined,0,false,null,'']){const f=fixture();f.state.hooks.valid=()=>{throw value;};const r=run(f);assert.equal(r.loaded,0);assert.equal(r.unreadable,475);assert.equal(r.complete,false);assert.equal(f.state.writes,0);}
});
for(const mode of['checksum','status','duplicate'])test('ACTUAL reservation '+mode+' mutation cannot rebind selected source or reach loader',async()=>{
 const f=fixture();f.state.onReserve=(civ,kingdom)=>{if(mode==='checksum')civ.checksum='ffffffff';if(mode==='status')civ.status='building';if(mode==='duplicate')kingdom.districts.push({...kingdom.districts[0]});};const a=adapter(f);await a.run();assert.equal(a.loaderCalls,0);assert.equal(f.state.reads,0);assert.equal(a.finished,1);assert.equal(a.events.some(ls=>ls.some(l=>l.startsWith('Room census building-'))),false);
});
for(const mode of['player','cancel'])test('ACTUAL final rawguard '+mode+' getter mutation cannot publish stale snapshot',async()=>{
 const reference=adapter(fixture());await reference.run();const last=reference.rawAudits;assert.ok(last>0);const f=fixture(),a=adapter(f);f.state.onRaw=n=>{if(n===last){if(mode==='player')a.player.dimension={id:'minecraft:nether'};else a.token.cancelled=true;}};await a.run();assert.equal(f.state.reads,475);assert.equal(a.finished,1);assert.equal(a.events.some(ls=>ls.some(l=>l.startsWith('Room census building-'))),false);
});

for(const mode of['playerID','dimension'])test('ACTUAL reservation '+mode+' change cannot become a new accepted player baseline',async()=>{
 const f=fixture(),a=adapter(f);f.state.onReserve=()=>{if(mode==='playerID')a.player.id='new-player';else a.player.dimension={id:'minecraft:nether'};};await a.run();assert.equal(a.loaderCalls,0);assert.equal(f.state.reads,0);assert.equal(a.finished,1);assert.equal(a.events.some(ls=>ls.some(l=>l.startsWith('Room census building-'))),false);
});

test('missing plannedcorner/lectern/anchor AIR remains counted/displayed discrepancy; actualsavedAIR and no-op AIR remain ordinaryair',()=>{
 const f=fixture(),missing=['-220,68,-540','-219,68,-536','-216,68,-537'];for(const at of missing)f.defaults.set(at,{id:'minecraft:air',states:{}});
 f.ctx.opsFor().push({x:-218,y:68,z:-538,id:'minecraft:air'});const r=run(f);assert.equal(r.obstructions,4);for(const at of missing){const row=r.rows.find(p=>[p.x,p.y,p.z].join(',')===at);assert.equal(row.classification,'source-discrepancy');assert.equal(row.observed.id,'minecraft:air');assert.notEqual(row.expected.id,'minecraft:air');}const savedAIR=r.rows.find(p=>p.x===-218&&p.y===68&&p.z===-538);assert.equal(savedAIR.classification,'air');assert.equal(savedAIR.expected.id,'minecraft:air');const absent=r.rows.find(p=>p.expected===null&&p.observed.id==='minecraft:air');assert.equal(absent.classification,'air');const lines=formatRoomVegetationPreview(r);for(const at of missing)assert.ok(lines.some(l=>l.startsWith(at+' ')&&l.includes('source-discrepancy')&&l.includes('live=minecraft:air')));assert.equal(f.state.reads,475);assert.equal(f.state.maxSlice,1);assert.equal(f.state.writes,0);
});
