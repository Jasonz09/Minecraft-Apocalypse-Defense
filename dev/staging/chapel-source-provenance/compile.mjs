import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mc,resetWorld,builder,civCommands,siteplan,propsSnapshot} from '../../lib/civharness.mjs';
import {newOps} from '../../../CivilizationApocalypse_BP/scripts/civ/regions.js';
import {createWallLeafSourceGuard} from '../../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js';
const local=new URL('./',import.meta.url),read=p=>JSON.parse(readFileSync(new URL(p,local),'utf8')),closed=read('closed-input.json'),observations=read('targets-input.json'),sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase(),key=p=>`${p.x},${p.y},${p.z}`;
assert.equal(closed.sequence,383540);assert.equal(observations.rows.length,39);
const wanted=new Map();for(const r of observations.rows)for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){const p={x:r.position.x+x,y:r.position.y+y,z:r.position.z+z};wanted.set(key(p),p);}assert.ok(wanted.size<=39*27);
resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);
const before=propsSnapshot(),writes={blocks:mc.writes,properties:mc.propWrites},kingdom=JSON.parse(mc.props.get('civ:kingdom')),masterHash=JSON.parse(mc.props.get('civ:plan:meta')).hash,world={getDynamicPropertyIds:()=>[...mc.props.keys()],getDynamicProperty:k=>mc.props.get(k)};
const guard=createWallLeafSourceGuard(world,()=>JSON.parse(mc.props.get('civ:kingdom')));let guardChecks=0,totalYields=0,totalOperations=0;const begun=Date.now(),sources=[];let areas,outlineProjection;
const tree=id=>/_(?:log|wood|leaves|sapling)$|:log2?$|:leaves2?$|:vine$|_vines$|:azalea_leaves_flowered$/.test(id);
const clone=op=>({x:op.x,y:op.y,z:op.z,id:op.id,kind:op.kind??null,states:op.states===undefined?null:JSON.parse(JSON.stringify(op.states))});
const check=()=>{assert.equal(guard.current(),true);guardChecks++;};
function drain(generator){let yields=0;for(;;){check();const n=generator.next();check();if(n.done)return{value:n.value,yields};yields++;totalYields++;}}
for(let index=1;index<=5;index++){
 const district=kingdom.districts.find(d=>d.id===`district-${index}`),civ=district?.civ;assert.equal(civ?.status,'complete');assert.equal(civ.dimension,'minecraft:overworld');
 let saved=drain(builder.loadSavedRunSteps(civ,newOps(),index));assert.equal(saved.value.ok,true,JSON.stringify(saved.value.reasons));assert.equal(saved.value.queue.state,'complete');assert.equal(saved.value.record.checksum,civ.checksum);assert.equal(saved.value.recovered,0);
 let record=saved.value.record,plan=saved.value.plan;const projected=JSON.stringify(plan.districts.map(d=>({index:d.index,outline:d.outline})));if(outlineProjection)assert.equal(projected,outlineProjection);else outlineProjection=projected;
 if(!areas)areas=JSON.parse(JSON.stringify(civCommands.protectedRects(kingdom,1,plan,builder.WRITE_PROTECT_GROW,5)));
 const final=new Map(),historicalTree=new Map(),targetHistory=new Map();let operations=0,slices=0;const targetSet=new Set(observations.rows.map(r=>key(r.position)));
 for(const stage of siteplan.SITE_STAGES)for(let i=0;i<record[stage].length;i++){
  check();const e=record[stage][i];for(const op of siteplan.siteOpsFor(record,stage,i)){
   operations++;totalOperations++;assert.ok(operations<=2000000);const at=key(op);if(wanted.has(at)){
    const row={stage,element:e.id,elementHash:e.hash??null,op:clone(op)};final.set(at,row);
    if(tree(op.id)){const list=historicalTree.get(at)??[];if(!list.some(r=>r.stage===row.stage&&r.element===row.element&&JSON.stringify(r.op)===JSON.stringify(row.op)))list.push(row);historicalTree.set(at,list);}
    if(targetSet.has(at)){const list=targetHistory.get(at)??[];if(!list.some(r=>r.stage===row.stage&&r.element===row.element&&JSON.stringify(r.op)===JSON.stringify(row.op)))list.push(row);targetHistory.set(at,list);}
   }
   if(operations%400===0){check();slices++;}
  }check();
 }
 sources.push({index,checksum:civ.checksum,civStatus:civ.status,dimension:civ.dimension,queueState:saved.value.queue.state,queuePlanHash:saved.value.queue.planHash,recovered:saved.value.recovered,loadYields:saved.yields,operations,operationCheckpoints:slices,final:[...final].map(([at,row])=>({at,...row})),historicalTree:[...historicalTree].map(([at,rows])=>({at,rows})),targetHistory:[...targetHistory].map(([at,rows])=>({at,rows}))});
 console.log(JSON.stringify({verifiedDistrict:index,checksum:civ.checksum,loadYields:saved.yields,operations,relevantFinal:final.size,historicalTreeCells:historicalTree.size,elapsedMs:Date.now()-begun}));
 record=null;plan=null;saved=null; // No heavy saved record/lazy-op closure is retained into the next load.
}
check();assert.deepEqual(propsSnapshot(),before);assert.equal(mc.propWrites,writes.properties);assert.equal(mc.writes,writes.blocks);
const targets=observations.rows.map(observed=>{const at=key(observed.position),claims=sources.map(s=>({district:s.index,checksum:s.checksum,final:s.final.find(r=>r.at===at)??null,historicalTree:s.historicalTree.find(r=>r.at===at)?.rows??[],allTargetHistory:s.targetHistory.find(r=>r.at===at)?.rows??[]}));const matches=claims.flatMap(c=>c.allTargetHistory.filter(r=>r.op.id===observed.observedId).map(r=>({district:c.district,stage:r.stage,element:r.element,states:r.op.states})));return{...observed,claims,matchingObservedIdPlannedHistory:matches,classification:matches.length?'EXACT ID PLANNED HISTORY EXISTS; not proof actually built or ownership':'NO SOURCE MATCH TO OBSERVED ID at exact coordinate; NOT natural-origin proof',protectedForActiveD5:areas.filter(a=>builder.inProtectedArea([a],observed.position.x,observed.position.z)).map(a=>({label:a.label,districtIndex:a.districtIndex??null,polygon:!!a.polygon,grow:a.grow??0,actualPolygon:!!a.polygon&&builder.inProtectedArea([{...a,grow:0}],observed.position.x,observed.position.z)}))};});
const output={scope:'OFFLINE all5checksum/master/completequeue verification and exact6stage historical/final claim compilation from CLOSEDCRC383540. No current native state, block write, cleanup eligibility or origin proof.',closedInput:{...closed,properties:undefined},closedInputSha256:sha(readFileSync(new URL('closed-input.json',local))),targetInputSha256:sha(readFileSync(new URL('targets-input.json',local))),masterHash,targets:targets.length,logTargets:targets.filter(r=>r.observedId.endsWith('_log')).length,leafTargets:targets.filter(r=>r.observedId.endsWith('_leaves')).length,uniqueRelevant27Cells:wanted.size,totalOperations,totalYields,guardChecks,elapsedMs:Date.now()-begun,blockWriteDelta:mc.writes-writes.blocks,propertyWriteDelta:mc.propWrites-writes.properties,rawPropertiesUnchanged:true,all5SavedOutlinesEqual:true,protectionAreasForActive5:areas,targetRows:targets,sources,limits:['Two separate native census pages were combined as historical coordinates only, not one snapshot.','Saved operation history includes planned placements that might have been skipped by protection/nativebuild conditions. A sameID claim does not establish ownership.','No matching planned ID is not proof of natural origin, player origin or original tree topology.','Final claims are per-record emission last writes, not an asserted cross-district actual build order.','Protection projection is exact closed kingdom/master state, not current game state.','No active files/world/progress/casualty/birth metadata changed.']};
writeFileSync(new URL('provenance.json',local),JSON.stringify(output,null,2));console.log(JSON.stringify({done:true,targets:39,logs:output.logTargets,leaves:output.leafTargets,matches:targets.filter(r=>r.matchingObservedIdPlannedHistory.length).length,totalOperations,totalYields,elapsedMs:output.elapsedMs}));
