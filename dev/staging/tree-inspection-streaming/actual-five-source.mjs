// One explicitly-run closed-source acceptance process; not a planner or native world read.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mc,resetWorld,builder,civCommands,dimension,districtBuilder,pump,propsSnapshot} from './runtime/dev/lib/civharness.mjs';
import {newOps} from './runtime/CivilizationApocalypse_BP/scripts/civ/regions.js';
import {createWallLeafSourceGuard} from './runtime/CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js';
import {compileSharedTreeProtectionSteps} from './runtime/CivilizationApocalypse_BP/scripts/civ/sharedtree.js';
import {prepareTreeInspectionSourcesSteps,treeInspectionBounds,withinTreeInspection} from './runtime/CivilizationApocalypse_BP/scripts/civ/treeInspectionStreaming.js';
const local=new URL('./',import.meta.url),closedPath=new URL('../chapel-source-provenance/closed-input.json',local),closed=JSON.parse(readFileSync(closedPath,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase(),seed={x:-214,y:69,z:-539};
assert.equal(closed.sequence,383540);
resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);
const before=propsSnapshot(),writes={blocks:mc.writes,properties:mc.propWrites},kingdom=JSON.parse(mc.props.get('civ:kingdom')),sources=kingdom.districts.filter(d=>d.civ!==undefined).map(d=>({index:Number(d.id.slice(9)),civ:d.civ}));assert.equal(sources.length,5);
const nativeWorld={getDynamicPropertyIds:()=>[...mc.props.keys()],getDynamicProperty:k=>mc.props.get(k)},guard=createWallLeafSourceGuard(nativeWorld,()=>JSON.parse(mc.props.get('civ:kingdom'))),bounds=treeInspectionBounds(seed),retention=[],loaderOrder=[],expected={plannedTrees:new Set(),finalBlocks:new Map(),boundaryPlans:[]};
let ownRegion,areas,loadYields=0,guardChecks=0,fullCompileYields=0;
const check=()=>{guardChecks++;return guard.current();},relevant=(x,z)=>builder.inProtectedArea(areas,x,z)&&builder.isSharedWallFill(areas,{x,y:0,z,id:'minecraft:stone_bricks',kind:'wall'}),inside=at=>withinTreeInspection(bounds,Object.fromEntries(at.split(',').map((v,i)=>[['x','y','z'][i],Number(v)])));
function* checked(g){for(;;){assert.equal(check(),true);const n=g.next();assert.equal(check(),true);if(n.done)return n.value;loadYields++;yield;}}
const start=Date.now();
function* load(index,civ){loaderOrder.push(index);const saved=yield* checked(builder.loadSavedRunSteps(civ,newOps(),index));assert.equal(saved.ok,true);assert.equal(saved.queue.state,'complete');assert.equal(saved.record.checksum,civ.checksum);
 if(index===5){ownRegion={...saved.region};areas=civCommands.protectedRects(kingdom,1,saved.plan,builder.WRITE_PROTECT_GROW,5);}
 else{
  const full=compileSharedTreeProtectionSteps([saved.record],ownRegion,relevant);let p;for(;;){assert.equal(check(),true);const n=full.next();assert.equal(check(),true);if(n.done){p=n.value;break;}fullCompileYields++;yield;}
  for(const at of p.plannedTrees)if(inside(at))expected.plannedTrees.add(at);
  for(const[at,ids]of p.finalBlocks)if(inside(at))expected.finalBlocks.set(at,[...new Set([...(expected.finalBlocks.get(at)??[]),...ids])]);
  for(const b of p.boundaryPlans)expected.boundaryPlans.push({districtIndex:b.districtIndex,outline:b.outline.map(p=>[...p]),finalWalls:new Map([...b.finalWalls].filter(([at])=>inside(at)))});
 }
 return saved;
}
const g=prepareTreeInspectionSourcesSteps({index:5,dimension:'minecraft:overworld',seed,sources},{current:check,loadSourceSteps:load,onMaster(){},relevant,onRetention:e=>retention.push(e)});let prepared;for(;;){const n=g.next();if(n.done){prepared=n.value;break;}}
const view=p=>({trees:[...p.plannedTrees].sort(),final:[...p.finalBlocks].map(([at,ids])=>[at,[...ids].sort()]).sort(),boundaries:p.boundaryPlans.map(b=>({index:b.districtIndex,outline:b.outline,walls:[...b.finalWalls].sort()}))});
assert.deepEqual(view(prepared.protection),view(expected));assert.equal(prepared.retention.peakHeavyRecords,2);assert.equal(prepared.retention.verifiedSources,5);assert.deepEqual(loaderOrder,[5,1,2,3,4]);assert.deepEqual(propsSnapshot(),before);assert.equal(mc.writes,writes.blocks);assert.equal(mc.propWrites,writes.properties);
const own=prepared.saved;
// Compare the old full own-index inspector and the new bounded one on the SAME
// verified real D5 record and one explicit OFFLINE native fixture (not the627-cell game tree).
const oldText=JSON.parse(readFileSync(new URL('BEFORE.json',local),'utf8'))['integration/civBuilder.js'].source,actualBuilder=new URL('./runtime/CivilizationApocalypse_BP/scripts/integration/civBuilder.js',local),baseline=await import('data:text/javascript;base64,'+Buffer.from(oldText.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,s)=>`from ${q}${s.startsWith('.')?new URL(s,actualBuilder).href:s}${q}`)).toString('base64'));
async function proof(module,protection){resetWorld(1);const token=districtBuilder.reserveJob('tree-real-parity'),points=[],blocks=new Map();for(let y=69;y<=71;y++)blocks.set(`-214,${y},-539`,'minecraft:jungle_log');for(let x=-215;x<=-213;x++)blocks.set(`${x},72,-539`,'minecraft:oak_leaves');const d={id:'minecraft:overworld',getBlock(p){points.push({...p});const id=blocks.get(`${p.x},${p.y},${p.z}`)??'minecraft:air';return{isValid:true,typeId:id,permutation:{getState:()=>false}};}};
 let result,error,done=false;const blockBefore=mc.writes,propBefore=mc.propWrites,p=module.inspectNaturalTree({token,dimension:d,plan:own.plan,record:own.record,region:own.region,district:5,protectedRects:areas,sharedTreeProtection:protection,current:()=>true},seed).then(r=>{result=r;done=true;},e=>{error=String(e);done=true;});await pump({until:()=>done});await p;districtBuilder.finishJob(token);assert.equal(mc.writes,blockBefore);assert.equal(mc.propWrites,propBefore);assert.equal(mc.areas.size,0);return{result,error,points};}
const oldProof=await proof(baseline,expected),newProof=await proof(builder,prepared.protection);assert.deepEqual(newProof,oldProof);assert.equal(newProof.error,undefined);assert.match(newProof.result.reason,/does not stand on natural ground.*minecraft:air/);
const result={scope:'OFFLINE pinned CLOSEDCRC383540 all5saved-source loader/full-vs-bounded projection and SAME verified D5record+synthetic native fixture. No current world/SST/native627tree/memory or speed claim.',closedInputSha256:sha(readFileSync(closedPath)),sequence:closed.sequence,seed,loaderOrder,loadYields,fullCompileYields,guardChecks,retention,peakVerifiedHeavyRecords:prepared.retention.peakHeavyRecords,verifiedSources:prepared.retention.verifiedSources,projection:{plannedTrees:prepared.protection.plannedTrees.size,finalContacts:prepared.protection.finalBlocks.size,boundaryPlans:prepared.protection.boundaryPlans.length,finalWalls:prepared.protection.boundaryPlans.reduce((n,p)=>n+p.finalWalls.size,0)},sameAsFullRegionCompilationProjected:true,rawPropertiesUnchanged:true,blockWriteDelta:0,propertyWriteDelta:0,selectedProof:{sameResult:true,result:newProof.result,sameNativeReadPoints:true,nativeReads:newProof.points.length,notActualGame627CellTree:true},elapsedMs:Date.now()-start};writeFileSync(new URL('actual-five-source.json',local),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
