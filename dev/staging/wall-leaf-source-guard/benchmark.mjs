import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {frozen,optimized} from './variants.mjs';
import {createKingdomStore} from '../../../CivilizationApocalypse_BP/scripts/kingdom/store.js';
const file=new URL('../../fixtures/wall-leaf-closed-source-20261106.json',import.meta.url),fixture=JSON.parse(readFileSync(file,'utf8')),scope=k=>k.startsWith('civ:plan:')||/^civ:jobs(?::d[1-5])?:(?:meta|[ab]:\d+)$/.test(k);
const N=1000;
function run(factory,maxBudget){const props=new Map(Object.entries(fixture.properties));let sourceBytes=[...props].filter(([k])=>scope(k)).reduce((n,[,v])=>n+Buffer.byteLength(v),0);
 if(maxBudget){props.set('civ:plan:benchmark_padding','x'.repeat(1500000-sourceBytes));sourceBytes=1500000;}
 const stats={census:0,rawReads:0,kingdomLoads:0,cancel:0,writes:0};
 const world={getDynamicPropertyIds(){stats.census++;return[...props.keys()];},getDynamicProperty(k){stats.rawReads++;return props.get(k);},setDynamicProperty(){stats.writes++;throw Error('NO WRITES');}};
 const store=createKingdomStore(world),read=()=>{stats.kingdomLoads++;return store.load().kingdom;},cancel=()=>{stats.cancel++;return false;};
 const before=JSON.stringify([...props]),guard=factory(world,read,cancel);for(let i=0;i<25;i++)assert.equal(guard.current(),true);for(const k in stats)stats[k]=0;
 const samples=[],start=performance.now();for(let i=0;i<N;i++){const t=performance.now();if(!guard.current())throw Error('unchanged snapshot refused');samples.push(performance.now()-t);}const totalMs=performance.now()-start;
 assert.equal(JSON.stringify([...props]),before);assert.equal(stats.writes,0);samples.sort((a,b)=>a-b);
 return{calls:N,rawSourceBytes:sourceBytes,sourceKeys:[...props.keys()].filter(scope).length,totalMs,meanMs:totalMs/N,p95Ms:samples[Math.floor(N*.95)],maxMs:samples.at(-1),apiCounts:stats};}
const results={};for(const [name,maxBudget]of [['actualFixture',false],['syntheticMax1500000Bytes',true]]){const before=run(frozen.createWallLeafSourceGuard,maxBudget),after=run(optimized.createWallLeafSourceGuard,maxBudget);assert.deepEqual(after.apiCounts,before.apiCounts);results[name]={before,after,desktopSpeedup:before.totalMs/after.totalMs};console.log(JSON.stringify({dataset:name,...results[name]}));}
const receipt={scope:'STAGING ONLY guard.current CPU/API benchmark, actual closed fixture + real store.load validation on fake properties, no loader/native execution or acceptance.','fixtureSha256':createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase(),results,limits:['Loader yield counts and scheduler unchanged','No promised native speedup/watchdog/safety/repair acceptance','Identical unchanged-path API counts; changed snapshots still refuse immediately','No production integration, actor/property writes, timers or real world/DB access']};writeFileSync(new URL('./benchmark.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
