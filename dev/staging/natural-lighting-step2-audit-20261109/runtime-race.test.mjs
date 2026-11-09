// Actual production lighting revision with synthetic ports; no native world/DB mutation.
import test from 'node:test';import assert from 'node:assert/strict';import {register} from 'node:module';
const helpers=`
const f=()=>globalThis.__lightAudit;
export const world={getDynamicProperty:k=>f().props.get(k),setDynamicProperty:(k,v)=>f().props.set(k,v)};
export const system={run:cb=>queueMicrotask(cb)};export const BlockPermutation={resolve:(id,states)=>({typeId:id,states})};
export function* loadSavedRunSteps(){return{ok:true,plan:{},record:f().old,payload:{ground:{},siteOptions:{}}};}
export function* rehydrateSiteSteps(){return{ok:true,record:f().next};}
export function siteOpsFor(record,stage,index){return record._ops[stage]?.[index]??[];}
export function createChunkLoader(){return{recover(){},acquire(){return{status:()=>({state:'ready'}),release(){}}}};}
export async function runJobAsync(token,gen){for(;;){const n=gen.next();if(n.done)return n.value;}}
export const activeKind=()=>f().token?.kind,activeToken=()=>f().token,isBusy=()=>!!f().token;
export function reserveJob(kind){return f().token={kind,cancelled:false};}export function finishJob(t){if(f().token===t)f().token=null;}export function cancelActiveJob(){f().token=null;}
`;
const helperUrl='data:text/javascript,'+encodeURIComponent(helpers);
const route=`export async function resolve(s,c,next){let u;try{u=new URL(s,c.parentURL).href}catch{};if(s==='@minecraft/server'||['/integration/civBuilder.js','/integration/chunkLeases.js','/integration/civScan.js','/integration/districtBuilder.js','/civ/districtplan.js'].some(p=>u?.endsWith(p)))return{url:${JSON.stringify(helperUrl)},shortCircuit:true};return next(s,c)}`;
register('data:text/javascript,'+encodeURIComponent(route));
const {startLightingRevision}=await import('../../../CivilizationApocalypse_BP/scripts/integration/lightingRevision.js');
const {removalReadiness}=await import('../../../CivilizationApocalypse_BP/scripts/civ/lightingRevision.js');
function fixture(mode){const op={x:1,y:70,z:1,id:'minecraft:lantern',states:{hanging:false}},old={checksum:'old',walls:[{}],dressing:[],_ops:{walls:[[op]]}},next={checksum:'new',walls:[],dressing:[],_ops:{walls:[]}},f={old,next,props:new Map(),token:null,reads:0,writes:[],messages:[]};globalThis.__lightAudit=f;f.dimension={getBlock(){f.reads++;const id=mode==='changed-id'&&f.reads>=2?'minecraft:bookshelf':'minecraft:lantern';return {typeId:id,permutation:{getState:()=>true},setPermutation(p){f.writes.push({before:id,after:p.typeId})}}}};return f;}
async function run(f){assert.equal(startLightingRevision({index:1,civ:{status:'complete'},dimension:f.dimension,say:lines=>f.messages.push(...lines)}).ok,true);for(let i=0;i<30&&f.token;i++)await new Promise(setImmediate);assert.equal(f.token,null);assert.ok(f.messages.some(s=>s.includes('Natural lighting complete')))}
test('OBSERVED BUG: same-ID changed hanging state is considered removable, not preserved',()=>{const op={id:'minecraft:lantern',states:{hanging:false}};assert.equal(removalReadiness([op],()=>({typeId:'minecraft:lantern',permutation:{getState:()=>true}})),'ready')});
test('OBSERVED BUG: actual outdoor runtime deletes changed-ID final reread after earlier readiness',async()=>{const f=fixture('changed-id');await run(f);assert.deepEqual(f.writes,[{before:'minecraft:bookshelf',after:'minecraft:air'}]);assert.equal(f.reads,2)});
test('OBSERVED BUG: actual outdoor runtime deletes same-ID lantern despite changed hanging state',async()=>{const f=fixture('changed-state');await run(f);assert.deepEqual(f.writes,[{before:'minecraft:lantern',after:'minecraft:air'}])});
