import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {setPriority,getPriority,constants} from 'node:os';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {mc,resetWorld,builder,propsSnapshot} from '../../lib/civharness.mjs';
import {newOps} from '../../../CivilizationApocalypse_BP/scripts/civ/regions.js';
if(typeof global.gc!=='function')throw new Error('Run with --expose-gc');
let priority;try{setPriority(0,constants.priority.PRIORITY_BELOW_NORMAL);priority={requested:'BELOW_NORMAL',actual:getPriority()};}catch(e){throw new Error('Could not establish low process priority: '+e.message);}
const fixture=JSON.parse(readFileSync(new URL('../../fixtures/wall-leaf-closed-source-20261106.json',import.meta.url),'utf8'));
const sha=v=>createHash('sha256').update(v).digest('hex');
const hashProps=()=>sha(JSON.stringify(propsSnapshot()));
const mem=()=>{const m=process.memoryUsage();return{heapUsed:m.heapUsed,heapTotal:m.heapTotal,rss:m.rss,external:m.external,arrayBuffers:m.arrayBuffers};};
const collect=()=>{global.gc();global.gc();return mem();};
const output=new URL('../../../dist/leaf-source-memory-profile-20261106.json',import.meta.url);
const report={scope:'OFFLINE Node/fake-Bedrock profiling of pinned saved sources only; not native heap, attribution, leak or performance acceptance',date:new Date().toISOString(),node:process.version,priority,method:{processes:1,sampleEveryYields:100,gc:'Two explicit full GCs before baseline, after every released load wrapper, after whole-mode release',modes:['retain-all-five-records','discard-previous-records'],fixture:'dev/fixtures/wall-leaf-closed-source-20261106.json',samplePeakCaveat:'Sampled heap peaks can miss allocations between samples; explicit GC does not model Bedrock GC.'},modes:[]};
const persist=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
for(const mode of report.method.modes){
 resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(fixture.properties))mc.props.set(k,v);
 const originalProps=hashProps(),kingdom=JSON.parse(fixture.properties['civ:kingdom']);
 const expected=['07515fcb','e6d55467','6b9f8114','35635162','23a6aeca'];
 const retained=[];let latestMaster=null,selectedRecord=null;
 const row={mode,baseline:collect(),sources:[],samples:[]};report.modes.push(row);persist();
 function loadOne(civ,index){
  const generator=builder.loadSavedRunSteps(civ,newOps(),index);let yields=0,next;const start=performance.now();let peak=mem();
  function sample(){const m=mem();for(const field of Object.keys(peak))peak[field]=Math.max(peak[field],m[field]);row.samples.push({index,yields,...m});}
  for(;;){next=generator.next();if(next.done)break;yields++;if(yields%100===0)sample();}
  sample();const saved=next.value;
  assert.equal(saved.ok,true,JSON.stringify(saved.reasons));assert.equal(saved.queue.state,'complete');assert.equal(saved.record.checksum,expected[index-1]);assert.equal(saved.record.checksum,civ.checksum);
  latestMaster=saved.plan;
  if(mode==='retain-all-five-records'){retained.push({record:saved.record,civ});if(index===4)selectedRecord=saved.record;}
  return{index,checksum:saved.record.checksum,queue:saved.queue.state,yields,durationMs:performance.now()-start,sampledPeak:peak,groundColumns:saved.record.ground.columns,padDescriptors:saved.record.lots.filter(e=>String(e.id).startsWith('pad-')).length,totalOps:saved.record.totalOps??saved.record.stats.totalOps??null};
 }
 for(const district of kingdom.districts.filter(d=>d.civ)){
  const index=Number(district.id.slice(9)),source=loadOne(district.civ,index);
  // loadOne has returned: generator, next.value, saved local and transient op arrays are out of scope.
  source.postGC=collect();source.postGCRetainedHeapAboveBaseline=source.postGC.heapUsed-row.baseline.heapUsed;
  assert.equal(hashProps(),originalProps,'pinned fake properties unchanged');row.sources.push(source);persist();
  console.log(JSON.stringify({mode,index,checksum:source.checksum,yields:source.yields,postGCHeapMiB:source.postGC.heapUsed/1048576,retainedDeltaMiB:source.postGCRetainedHeapAboveBaseline/1048576,sampledPeakMiB:source.sampledPeak.heapUsed/1048576}));
 }
 row.beforeRelease=mem();row.recordsRetained=retained.length;
 retained.length=0;latestMaster=null;selectedRecord=null;
 row.afterReleaseGC=collect();row.propertiesUnchanged=hashProps()===originalProps;assert.equal(row.propertiesUnchanged,true);persist();
}
report.complete=true;report.completedUtc=new Date().toISOString();persist();console.log('PROFILE COMPLETE '+output.pathname);
