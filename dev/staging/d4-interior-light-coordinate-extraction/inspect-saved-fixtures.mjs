// Run ONLY after extract-closed-input.py in a root-authorized CLOSED Minecraft window.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mc,resetWorld,builder,siteplan,propsSnapshot} from '../../lib/civharness.mjs';
import {newOps} from '../../../CivilizationApocalypse_BP/scripts/civ/regions.js';
import {importSiteGroundSteps} from '../../../CivilizationApocalypse_BP/scripts/civ/siteprofile.js';
import {createWallLeafSourceGuard} from '../../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js';
const root=new URL('../../../',import.meta.url),inputURL=new URL('dist/d4-interior-light-closed-input-20261106.json',root),closed=JSON.parse(readFileSync(inputURL,'utf8'));
assert.equal(closed.allBackup15FilesHashVerified,true);assert.equal(closed.inventoryExact,true);assert.ok(closed.backup.endsWith('d1-diagnostics-pinned-20261106'));
resetWorld(1);mc.props.clear();for(const[k,v]of Object.entries(closed.properties))mc.props.set(k,v);
const baselineCounters={propertyWrites:mc.propWrites,blockWrites:mc.writes};
const before=propsSnapshot(),world={getDynamicPropertyIds:()=>[...mc.props.keys()],getDynamicProperty:k=>mc.props.get(k)},kingdom=JSON.parse(mc.props.get('civ:kingdom')),civ=kingdom.districts.find(d=>d.id==='district-4')?.civ;
assert.equal(civ?.status,'complete');assert.equal(civ.dimension,'minecraft:overworld');
const guard=createWallLeafSourceGuard(world,()=>JSON.parse(mc.props.get('civ:kingdom')));let guardCalls=0;
function drain(generator){let yields=0;for(;;){assert.equal(guard.current(),true);guardCalls++;const n=generator.next();assert.equal(guard.current(),true);guardCalls++;if(n.done)return{value:n.value,yields};yields++;}}
const started=Date.now();let saved=drain(builder.loadSavedRunSteps(civ,newOps(),4));assert.equal(saved.value.ok,true,JSON.stringify(saved.value.reasons));assert.equal(saved.value.record.checksum,civ.checksum);
let generated=drain(siteplan.buildingInteriorLightRevisionSteps(saved.value.record,newOps())),wanted=['building-d4-watchtower-3','building-d4-warehouse-4'];
const groups=wanted.map(id=>{const found=generated.value.filter(g=>g.element.id===id);assert.equal(found.length,1,id);const g=found[0];return{building:id,blueprint:g.element.blueprint,bbox:g.element.bbox,baseY:g.element.baseY,sourceElementHash:g.element.hash,fixtures:g.fixtures.map(f=>({before:f.before,after:f.after,anchor:f.anchor}))};});
assert.equal(groups[0].fixtures.length,1);assert.equal(groups[1].fixtures.length,2);assert.deepEqual(propsSnapshot(),before);assert.equal(mc.propWrites,baselineCounters.propertyWrites);assert.equal(mc.writes,baselineCounters.blockWrites);
// Release D4 wrappers before loading D5; retain only small copied fixture records/metrics.
const d4LoadYields=saved.yields,d4FixtureYields=generated.yields;saved=null;generated=null;
const civ5=kingdom.districts.find(d=>d.id==='district-5')?.civ;assert.equal(civ5?.status,'complete');assert.equal(civ5.dimension,'minecraft:overworld');
const loaded5=drain(builder.loadSavedRunSteps(civ5,newOps(),5));assert.equal(loaded5.value.ok,true,JSON.stringify(loaded5.value.reasons));assert.equal(loaded5.value.record.checksum,civ5.checksum);
const record5=loaded5.value.record,chapels=record5.lots.map((element,index)=>({element,index})).filter(e=>e.element.id==='building-d5-chapel-1');assert.equal(chapels.length,1);const chapel=chapels[0],box=chapel.element.bbox;assert.ok(box);
const minY=chapel.element.baseY-2,maxY=chapel.element.baseY+32,inside=p=>p.x>=box.x0-2&&p.x<=box.x1+2&&p.z>=box.z0-2&&p.z<=box.z1+2&&p.y>=minY&&p.y<=maxY,key=p=>`${p.x},${p.y},${p.z}`;
const final=new Map(),history=[],clearColumns=new Map(),contact={x:-217,y:69,z:-536},contactHistory=[];let scanned5=0;
for(const stage of siteplan.SITE_STAGES)for(let i=0;i<(record5[stage]?.length??0);i++){
 assert.equal(guard.current(),true);guardCalls++;
 const element=record5[stage][i];for(const op of siteplan.siteOpsFor(record5,stage,i)){
  scanned5++;if(!inside(op))continue;const row={stage,index:i,element:element.id,op};final.set(key(op),row);
  if(op.x===contact.x&&op.y===contact.y&&op.z===contact.z)contactHistory.push(row);
  if(Math.abs(op.x-contact.x)<=2&&Math.abs(op.z-contact.z)<=2&&op.y<=contact.y+12)history.push(row);
  if(stage==='clear'&&op.id==='minecraft:air'){const k=`${op.x},${op.z}`,old=clearColumns.get(k)??{x:op.x,z:op.z,minY:op.y,maxY:op.y,count:0,ys:new Set(),elements:new Set()};old.minY=Math.min(old.minY,op.y);old.maxY=Math.max(old.maxY,op.y);old.count++;old.ys.add(op.y);old.elements.add(element.id);clearColumns.set(k,old);}
 }
 assert.equal(guard.current(),true);guardCalls++;
}
const ground5=drain(importSiteGroundSteps(loaded5.value.payload.ground,newOps())),groundColumns=[];
for(let xx=box.x0-2;xx<=box.x1+2;xx++)for(let zz=box.z0-2;zz<=box.z1+2;zz++)groundColumns.push({x:xx,z:zz,saved:ground5.value.at(xx,zz)});
const finalOps=[...final.values()],woodOrLeaf=op=>/(?:_log|_wood|_leaves|(?:^|:)log2?|(?:^|:)leaves2?)$/.test(op.id),d5SourceClassification={building:chapel.element,savedChecksum:civ5.checksum,loadYields:loaded5.yields,groundImportYields:ground5.yields,scannedOperationCount:scanned5,region:{...box,margin:2,minY,maxY},contact,contactHistory,contactFinal:final.get(key(contact))??null,finalOps,plannedLecterns:finalOps.filter(r=>r.op.id==='minecraft:lectern'),plannedWoodOrLeaves:finalOps.filter(r=>woodOrLeaf(r.op)),historyNearContact:history,savedClearColumnCoverage:[...clearColumns.values()].map(r=>({...r,ys:[...r.ys].sort((a,b)=>a-b),elements:[...r.elements]})),originalGroundColumns:groundColumns,limitations:['D5 saved original ground records height/kind/tree flags, not original per-block tree topology or current native IDs/states.','Current visible log coordinates/states have not been sampled; planned timber vs retained natural trunk cannot be concluded from camera alone.','D5 stage history is exact within reported region, but other districts have not been compiled for cross-district last-writer proof. This artifact grants NO cleanup permission.','Current oak-leaf native contact and persistent_bit=false plus valid lanterns/supports are parent observations, not produced by this offline script. Preserve vegetation until exact target/current-neighbor/full-source proofs support a separately reviewed selective interior action.']};
assert.equal(guard.current(),true);guardCalls++;assert.deepEqual(propsSnapshot(),before);assert.equal(mc.propWrites,baselineCounters.propertyWrites);assert.equal(mc.writes,baselineCounters.blockWrites);
const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
const walk=(url,prefix='')=>readdirSync(url,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(new URL(d.name+'/',url),prefix+d.name+'/'):[prefix+d.name]);
const scripts=new URL('CivilizationApocalypse_BP/scripts/',root),sourcePins=Object.fromEntries(walk(scripts).filter(p=>p.endsWith('.js')).map(p=>[p,sha(readFileSync(new URL(p,scripts)))]));
const output={scope:'OFFLINE exact saved-source reconstruction only; no native block/state/support/lighting acceptance or writes',closedBackup:{sequence:closed.sequence,backup:closed.backup,levelDatSha256:closed.levelDatSha256,receipt:closed.backupReceipt,receiptSha256:closed.backupReceiptSha256,all15HashesVerified:true,inventoryExact:true,parserSha256:closed.parserSha256,snapshotHelperSha256:closed.snapshotHelperSha256},inputSha256:sha(readFileSync(inputURL)),district:4,savedChecksum:civ.checksum,completedSource:true,loadSavedRunChecks:'Production loader validates master/site/ground/checksum and full original jobs queue; no new plan or source mutation',loadYields:d4LoadYields,fixtureRevisionYields:d4FixtureYields,allRawSourceChecksAcrossYields:guardCalls,rawPropertiesUnchanged:true,harnessInitializationCounters:baselineCounters,propertyWrites:mc.propWrites-baselineCounters.propertyWrites,blockWrites:mc.writes-baselineCounters.blockWrites,elapsedMs:Date.now()-started,groups,d5SourceClassification,sourcePins,sourcePropertyPins:Object.fromEntries(Object.entries(closed.properties).map(([k,v])=>[k,sha(Buffer.from(v))]))};
const target=new URL('dist/d4-interior-light-saved-coordinates-20261106.json',root);writeFileSync(target,JSON.stringify(output,null,2));console.log(JSON.stringify({target:target.href,checksum:civ.checksum,loadYields:d4LoadYields,fixtureRevisionYields:d4FixtureYields,groups},null,2));
