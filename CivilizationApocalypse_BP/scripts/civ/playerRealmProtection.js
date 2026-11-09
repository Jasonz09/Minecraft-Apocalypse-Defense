// @ts-check
import {createRealmClaimRegistry,REALM_SOURCE_FAMILY,REALM_CLAIM_FAMILY,realmSourceKeys} from './realmSources.js';
import {createPlanStore,utf8Length} from './planstore.js';
import {createJobStore,serializeQueue} from './jobs.js';
import {deserializeKingdom} from '../kingdom/state.js';
import {siteGroundRegion} from './siteprofile.js';
const CAP=2*1024*1024;
const STRICT_PLAYER_REALM_CLAIMS=new WeakSet();
/** @param {any} area */
export function isStrictPlayerRealmClaim(area){return !!area&&typeof area==='object'&&STRICT_PLAYER_REALM_CLAIMS.has(area);}
/** @param {any} world */
function census(world){const keys=world.getDynamicPropertyIds();if(!Array.isArray(keys)||keys.length>4096||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!k||k.length>256))throw Error('realm protection source census unreadable');return [...keys].sort();}
/** @param {string} key */
const relevant=key=>key==='civ:kingdom'||(key==='civ:plan'||key.startsWith('civ:plan:'))||(key==='civ:jobs'||key.startsWith('civ:jobs:'))||key.startsWith(REALM_SOURCE_FAMILY)||key.startsWith(REALM_CLAIM_FAMILY);
/** @param {any} world */
function snapshot(world){let bytes=0;return census(world).filter(relevant).map(key=>{
 if(key!=='civ:kingdom'&&key!=='civ:realm_claims:v1'&&!/^civ:(?:realm:realm-[123]:)?(?:plan(?::site:d[1-5])?|jobs(?::d[2-5]|:repair:d[1-5])?):(?:meta|[ab]:\d+)$/.test(key))throw Error('unknown source family or version; preserved');const value=world.getDynamicProperty(key);if(!['string','boolean','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Error('realm protection raw source unreadable');bytes+=typeof value==='string'?utf8Length(value):8;if(bytes>CAP)throw Error('realm protection source byte cap');return [key,value];});}
/** @param {any[]} rows */
const text=rows=>JSON.stringify(rows);
/** @param {any} value */
function rect(value){if(!value||![value.x0,value.z0,value.x1,value.z1].every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=29000000)||value.x1<value.x0||value.z1<value.z0||value.x1-value.x0>2048||value.z1-value.z0>2048)throw Error('saved source footprint invalid');return {x0:value.x0,z0:value.z0,x1:value.x1,z1:value.z1};}
/** Actual bounded saved codecs and metadata provenance, not a terrain/operation proof.
 * Every saved player district and prototype is included, never except-self/shared-wall.
 * @param {any} world @param {string[]} keys */
function capturePlayer(world,keys){
 const raw=world.getDynamicProperty('civ:kingdom');if(typeof raw!=='string')throw Error('saved player kingdom required');const parsed=deserializeKingdom(raw);if(!parsed.kingdom)throw Error('saved player kingdom invalid: '+parsed.reason);const kingdom=parsed.kingdom,areas=[];
 const master=createPlanStore(world).loadPlan();const any=keys.some(k=>k.startsWith('civ:plan:')||k.startsWith('civ:jobs:'));
 if(master.status!=='ok'&&!(master.status==='absent'&&!any))throw Error('saved player master is '+master.status);
 const plan=master.plan?.plan;if(master.status==='ok'&&(master.plan?.version!==1||!Array.isArray(plan?.districts)||plan.districts.length!==5||new Set(plan.districts.map((/** @type {any} */d)=>d.index)).size!==5))throw Error('saved player master district inventory invalid');
 for(let index=1;index<=5;index++){
  const d=kingdom.districts.find((/** @type {any} */d)=>d.id==='district-'+index);if(!d)throw Error('saved player district identity missing');
  if(d.physical?.origin){const o=d.physical.origin;if(!Number.isSafeInteger(o.x)||!Number.isSafeInteger(o.z))throw Error('saved prototype origin invalid');areas.push(rect({x0:o.x-25,z0:o.z-25,x1:o.x+25,z1:o.z+25}));}
  if(master.status==='ok')areas.push(rect(siteGroundRegion(plan,index)));
  const k=realmSourceKeys('player',index),site=createPlanStore(world,{prefix:k.site}).loadPlan(),queue=createJobStore(world,{prefix:k.jobs}).loadQueue({recoverRunning:false});
  const has=keys.some(key=>key.startsWith(k.repair+':')||key.startsWith(k.site+':')||key.startsWith(k.jobs+':')&&!(index===1&&/^civ:jobs:(d[2-5]|repair):/.test(key)));
  if(site.status==='absent'&&queue.status==='absent'&&!has){if(d.civ)throw Error('saved player district has no exact site/queue provenance');continue;}
  if(master.status!=='ok'||site.status!=='ok'||queue.status!=='ok'||!queue.queue||site.plan?.version!==1||site.plan?.site?.version!==2||site.plan.district!==index||typeof site.plan.siteChecksum!=='string'||queue.queue.planHash!==site.plan.siteChecksum||d.civ?.checksum!==site.plan.siteChecksum)throw Error('saved player site/queue identity incomplete or differs');
  if(keys.some(key=>key.startsWith(k.repair+':'))){const repair=createJobStore(world,{prefix:k.repair}).loadQueue({recoverRunning:false});if(repair.status!=='ok'||repair.queue?.planHash!==site.plan.siteChecksum)throw Error('saved repair queue identity invalid');}
 }
 if(areas.length>32)throw Error('saved player protection area cap');return {complete:/** @type {true} */(true),areas,kingdom};
}
/** One deliberate entry census. Without realm families no per-property/terrain reads.
 * Missing/unreadable IDs HOLD, never fabricate an empty registry.
 * @param {any} world @returns {any} */
export function capturePlayerRealmProtection(world){
 const entryIds=census(world);if(!entryIds.some(k=>k.startsWith(REALM_SOURCE_FAMILY)||k.startsWith(REALM_CLAIM_FAMILY)))return undefined;
 let rows=snapshot(world);const current=()=>{const next=snapshot(world);if(next.length!==rows.length||next.some((r,i)=>r[0]!==rows[i][0]||!Object.is(r[1],rows[i][1])))throw Error('realm/player source changed; native work held');};
 const captured=capturePlayer(world,entryIds);current();
 const registry=createRealmClaimRegistry(world,{capturePlayerProtection:()=>captured});const loaded=registry.load();if(loaded.status!=='ok'||!loaded.claims)throw Error('foreign registry held: '+loaded.reason);
 const claims=Object.freeze(registry.exclusions([]).map(area=>{const claim=Object.freeze({...area});STRICT_PLAYER_REALM_CLAIMS.add(claim);return claim;}));current();if(claims.some(c=>captured.areas.some(a=>a.x0<=c.x1&&a.x1>=c.x0&&a.z0<=c.z1&&a.z1>=c.z0)))throw Error('foreign claim overlaps saved player source footprint; held');
 // A reservation alone is allowed. Any published foreign source must be a complete
 // metadata triplet; partial/corrupt/future records retain their exclusion but HOLD.
 for(const claim of loaded.claims){const id=claim.realm,has=entryIds.some(k=>k.startsWith(REALM_SOURCE_FAMILY+id+':'));if(!has)continue;const scopes=registry.stores(id,1);const fm=scopes.master.loadPlan();if(fm.status!=='ok'||fm.plan?.version!==1||!Array.isArray(fm.plan?.plan?.districts)||fm.plan.plan.districts.length!==5)throw Error('foreign source master incomplete');for(let d=1;d<=5;d++)rect(siteGroundRegion(fm.plan.plan,d));let sites=0;for(let n=1;n<=5;n++){const st=registry.stores(id,n),site=st.site.loadPlan(),queue=st.jobs.loadQueue();if(site.status==='absent'&&queue.status==='absent')continue;if(site.status!=='ok'||queue.status!=='ok'||site.plan?.district!==n||site.plan?.version!==1||site.plan?.site?.version!==2||queue.queue?.planHash!==site.plan.siteChecksum)throw Error('foreign source triplet incomplete/differs');sites++;}if(!sites)throw Error('foreign source has no complete district');}
 current();
 /** Only existing owner's exact queue + kingdom patch publication may refresh a fence.
  * @param {string} prefix @param {any} queue @param {number} index @param {any} patch @param {()=>any} write */
 function progress(prefix,queue,index,patch,write){
  current();if(Object.keys(patch).some(k=>!['stage','ops','opsTotal','placed','skipped','status'].includes(k)))throw Error('owner progress patch may not change source identity');
  const priorQueue=createJobStore(world,{prefix}).loadQueue({recoverRunning:false});const identity=(/** @type {any} */q)=>JSON.stringify([q.planHash,q.total,q.hash,q.stages,q.requires,q.maxAttempts]);if(priorQueue.status!=='ok'||!priorQueue.queue||identity(priorQueue.queue)!==identity(queue))throw Error('owner progress queue identity changed');
  if(prefix!==realmSourceKeys('player',index).jobs&&prefix!==realmSourceKeys('player',index).repair)throw Error('owner progress prefix invalid');
  const oldKingdom=rows.find(r=>r[0]==='civ:kingdom')?.[1];const expected=JSON.parse(oldKingdom),district=expected.districts.find((/** @type {any} */d)=>d.id==='district-'+index);district.civ={...district.civ,...patch};
  const owns=(/** @type {any[]} */r)=>r[0]===prefix+':meta'||r[0].startsWith(prefix+':a:')||r[0].startsWith(prefix+':b:');
  const before=rows.filter(r=>r[0]!=='civ:kingdom'&&!owns(r));const result=write();const after=snapshot(world);
  if(text(after.filter(r=>r[0]!=='civ:kingdom'&&!owns(r)))!==text(before))throw Error('other source changed during owner progress');
  const nextKingdom=after.find(r=>r[0]==='civ:kingdom')?.[1];if(typeof nextKingdom!=='string'||JSON.stringify(JSON.parse(nextKingdom))!==JSON.stringify(expected))throw Error('kingdom changed outside exact owner progress patch');
  const saved=createJobStore(world,{prefix}).loadQueue({recoverRunning:false});if(saved.status!=='ok'||!saved.queue||serializeQueue(saved.queue)!==serializeQueue(queue))throw Error('owner progress queue readback differs');
  rows=after;current();return result;
 }
 /** @param {number} index @param {any} plan @param {any} record @param {any} queue */
 function source(index,plan,record,queue){current();const d=captured.kingdom.districts.find((/** @type {any} */d)=>d.id==='district-'+index),master=createPlanStore(world).loadPlan();if(!d?.civ||record?.checksum!==d.civ.checksum||queue&&queue.planHash!==record.checksum||master.status!=='ok'||JSON.stringify(master.plan.plan)!==JSON.stringify(plan))throw Error('player execution source identity differs from saved provenance');current();}
 return Object.freeze({claims,current,progress,source,playerAreas:Object.freeze(captured.areas.map(a=>Object.freeze({...a})))});
}
/** Native object getter/method barriers retain the same Dimension/Block receivers.
 * Only wraps this existing builder's native port; no independent writer.
 * @param {any} dimension @param {any} guard @returns {any} */
export function guardPlayerRealmDimension(dimension,guard){
 const protectedColumn=(/** @type {any} */p)=>guard.claims.some((/** @type {any} */r)=>p.x>=r.x0&&p.x<=r.x1&&p.z>=r.z0&&p.z<=r.z1);
 const block=(/** @type {any} */target,/** @type {any} */point)=>target?new Proxy(target,{get(t,key){guard.current();const v=Reflect.get(t,key,t);guard.current();if(typeof v!=='function')return v;return(/** @type {any[]} */...args)=>{guard.current();if((key==='setPermutation'||key==='setType')&&protectedColumn(point))throw Error('foreign claim forbids native block write');const result=Reflect.apply(v,t,args);guard.current();return result;};}}):target;
 return new Proxy(dimension,{get(t,key){guard.current();const v=Reflect.get(t,key,t);guard.current();if(typeof v!=='function')return v;return(/** @type {any[]} */...args)=>{guard.current();if(key==='runCommand'&&typeof args[0]==='string'&&/^setblock\s/.test(args[0])){const m=/^setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s/.exec(args[0]);if(!m||protectedColumn({x:Number(m[1]),z:Number(m[3])}))throw Error('foreign claim forbids native door write');}let requested;
 if(key==='getBlock'){const input=args[0];requested=Object.freeze({x:input?.x,y:input?.y,z:input?.z});guard.current();if(![requested.x,requested.y,requested.z].every(Number.isSafeInteger))throw Error('native block point invalid');args=[{...requested},...args.slice(1)];}
 const result=Reflect.apply(v,t,args);guard.current();
 if(key==='getBlock'&&result){if(!requested)throw Error('native requested point missing');const location=result.location;guard.current();if(location!==undefined){const actual={x:location.x,y:location.y,z:location.z};guard.current();if(actual.x!==requested.x||actual.y!==requested.y||actual.z!==requested.z)throw Error('native block location differs from requested point');}return block(result,requested);}
 return result;};}});
}
