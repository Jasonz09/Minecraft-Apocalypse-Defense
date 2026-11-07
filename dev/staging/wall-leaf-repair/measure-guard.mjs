import {readFileSync,writeFileSync} from "node:fs";
import {performance} from "node:perf_hooks";
const here=new URL("./",import.meta.url),base=new URL("./repair.test.mjs",here);
const raw=readFileSync(base,"utf8").split('test("closed authoritative')[0];
const rebased=raw.replaceAll("import.meta.url",JSON.stringify(base.href)).replace(/from\s+"(\.[^"]+)"/g,(_,p)=>"from "+JSON.stringify(new URL(p,base).href));
const {fixture}=await import("data:text/javascript;base64,"+Buffer.from(rebased+"\nexport {fixture};").toString("base64"));
const f=fixture(),scoped=k=>k.startsWith("civ:plan:")||/^civ:jobs(?::d[1-5])?:(?:meta|[ab]:\d+)$/.test(k);
const keys=[...f.props.keys()].filter(scoped).sort(),values=keys.map(k=>[k,f.props.get(k)]);
const kingdom=JSON.parse(f.props.get("civ:kingdom")),protection=JSON.stringify(kingdom.districts.map(d=>({id:d.id,civ:d.civ??null,origin:d.physical?.origin??null})).sort((a,b)=>a.id.localeCompare(b.id)));
let calls=0,sum=0,max=0;const durations=[];const current=f.ctx.sourcesCurrent;
f.ctx.sourcesCurrent=()=>{const a=performance.now(),result=current(),elapsed=performance.now()-a;calls++;sum+=elapsed;max=Math.max(max,elapsed);durations.push(elapsed);return result;};
for(let i=0;i<100;i++)f.ctx.sourcesCurrent();const baseline={calls,sumMs:sum,meanMs:sum/calls,maxMs:max};
calls=0;sum=0;max=0;durations.length=0;
const g=f.steps(false),slices=[],start=performance.now();let result;
for(;;){const a=performance.now(),step=g.next();slices.push(performance.now()-a);if(step.done){result=step.value;break;}}
const sorted=[...durations].sort((a,b)=>a-b),ordered=[...slices].sort((a,b)=>a-b);
const receipt={scope:"Standalone source-fence CPU only; fake Bedrock property/block calls. Not native watchdog or chunk proof.",sourceKeys:keys.length,rawSourceBytes:values.reduce((n,[,v])=>n+Buffer.byteLength(v),0),serializedFenceBytes:Buffer.byteLength(JSON.stringify({values,protection})),baseline,
preview:{state:result.state,rows:result.rows.length,refused:result.globalSurvey?.refused,unloaded:result.globalSurvey?.unloaded,totalMs:performance.now()-start,generatorNextCalls:slices.length,yields:slices.length-1,sourceGuardCalls:calls,guardTotalMs:sum,guardMeanMs:sum/calls,guardP95Ms:sorted[Math.floor(sorted.length*.95)],guardMaxMs:max,maxSliceMs:ordered.at(-1),p95SliceMs:ordered[Math.floor(ordered.length*.95)]}};
const {previewWallLeavesSteps}=await import(new URL("../../../CivilizationApocalypse_BP/scripts/civ/wallleafpreview.js",here));
const {compileLeafTrimSteps}=await import(new URL("./leaf-trim.mjs",here));
function measured(generator){let nextCalls=0,value;const start=performance.now();for(;;){nextCalls++;const n=generator.next();if(n.done){value=n.value;break;}}return{nextCalls,yields:nextCalls-1,cpuMs:performance.now()-start,value};}
const surveyed=measured(previewWallLeavesSteps({record:f.input.sources.find(s=>s.record.districtIndex===4).record,records:f.input.sources.map(s=>s.record),read:f.ctx.read,isProtected:f.ctx.isProtected,cancelled:f.ctx.cancelled}));
const compiled=measured(compileLeafTrimSteps({...f.input,candidates:surveyed.value.rows.filter(r=>r.state==="eligible").map(r=>r.target)}));
receipt.breakdown={survey:{yields:surveyed.yields,cpuMs:surveyed.cpuMs,totalOps:surveyed.value.totalOps,totalReads:surveyed.value.totalReads},strictCompile:{yields:compiled.yields,cpuMs:compiled.cpuMs,scannedOps:compiled.value.compileScannedOps},previewTargetYields:14,betweenPhaseYields:2};
const {createWallLeafSourceGuard,WALL_LEAF_REPAIR_LIMITS}=await import(new URL("./wall-leaf-repair.mjs",here));
f.props.set("civ:plan:benchmark_padding","x".repeat(WALL_LEAF_REPAIR_LIMITS.sourceBytes-receipt.rawSourceBytes));
const padded=createWallLeafSourceGuard(f.world,()=>JSON.parse(f.props.get("civ:kingdom"))),stress=[];
for(let i=0;i<100;i++){const start=performance.now();if(!padded.current())throw Error("synthetic bounded guard unexpectedly refused");stress.push(performance.now()-start);}
receipt.syntheticMaxBudget={scope:"Synthetic fake-property padding to sourceBytes limit; no native I/O or compile",rawSourceBytes:WALL_LEAF_REPAIR_LIMITS.sourceBytes,calls:stress.length,meanMs:stress.reduce((a,b)=>a+b)/stress.length,maxMs:Math.max(...stress)};
writeFileSync(new URL("guard-benchmark.json",here),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
