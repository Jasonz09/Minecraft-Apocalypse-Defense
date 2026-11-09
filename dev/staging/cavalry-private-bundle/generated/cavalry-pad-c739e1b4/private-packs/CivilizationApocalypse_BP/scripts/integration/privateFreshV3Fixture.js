// @ts-check
import {REVIEWED_CAVALRY_FIXTURE as REVIEWED_FRESH_FIXTURE} from './cavalryFreshTrust.js';
import {createUnifiedStore} from './creationUnifiedStore.js';
import {META} from './creationUnifiedV3.js';
import {FAMILY,CUSTOM_CREATION_ENTITY_TYPES} from './creationBindings.js';
import {createInitialKingdom,serializeKingdom} from '../kingdom/state.js';
export const ACTIVATION_FAMILY='civ:creation_activation:',ACTIVATION_KEY=ACTIVATION_FAMILY+'v3',OBJECTIVE='ca_fresh_owner';
const LIMITS=Object.freeze({allKeys:4096,entities:64,tags:64,tagChars:256,markerBytes:16384});
/** @param {string} reason @returns {never} */const fail=reason=>{throw Error(reason);};
/** @param {unknown} text */const ascii=text=>typeof text==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(text);
/** @param {any} d */function trusted(d){return d&&d.v===1&&ascii(d.fixtureId)&&ascii(d.epoch)&&ascii(d.nonce)&&ascii(d.participant)&&Number.isSafeInteger(d.participantId)&&d.participantId>=0&&/^[A-F0-9]{64}$/.test(d.receiptSha256)&&/^[A-F0-9]{64}$/.test(d.levelSha256)&&d.operatorKnownNewVanilla===true;}
/** Private compiled fixture adapter only. Construction is early-safe, no reads.
 * No descriptor, receipt, epoch or fresh boolean comes from a command/request.
 * @param {{world:any,isDeveloper:()=>boolean,isPeopleOn:()=>boolean,isBusy:()=>boolean}} deps */
export function createPrivateFreshV3Fixture(deps){
 const d=REVIEWED_FRESH_FIXTURE,world=deps.world;
 /** @type {string|null} */let authorizing=null;
 const initial=serializeKingdom(createInitialKingdom());
 /** @type {Map<string,unknown>} */const expected=new Map(/** @type {[string,unknown][]} */([['civ:kingdom',initial],['civ_devgate',true]]));
 /** @type {any} */let caller;
 let callerId='';
 function fast(){if(!caller||deps.isDeveloper()!==true||deps.isPeopleOn()!==false||deps.isBusy()!==false||caller.isValid!==true||caller.id!==callerId||caller.dimension.id!=='minecraft:overworld')fail('fresh activation player/gate/job changed');}
 /** @template T @param {()=>T} read @returns {T} */function native(read){fast();let failed=false;/** @type {unknown} */let error;/** @type {T} */let value;try{value=read();}catch(e){failed=true;error=e;}fast();if(failed)throw error;return /** @type {T} */(value);}
 /** Current-main namespace only: exact initial save/dev key, no history or other keys.
  * @param {string|null} intent @param {string|null} header */
 function properties(intent,header){
  const ids=native(()=>world.getDynamicPropertyIds());if(!Array.isArray(ids)||ids.length>LIMITS.allKeys||ids.some(k=>typeof k!=='string')||new Set(ids).size!==ids.length)fail('fresh property census unreadable');
  const allow=new Map(expected);if(intent!==null)allow.set(ACTIVATION_KEY,intent);if(header!==null)allow.set(META,header);
  if(ids.length!==allow.size||ids.some(k=>!allow.has(k)))fail('fresh source/property history is not the exact initial snapshot');
  for(const k of [...allow.keys()].sort())if(native(()=>world.getDynamicProperty(k))!==allow.get(k))fail('fresh initial property changed: '+k);
 }
 function marker(){
  const objectives=native(()=>world.scoreboard.getObjectives());if(!Array.isArray(objectives)||objectives.length!==1)fail('fixture scoreboard objective census differs');
  const objective=native(()=>world.scoreboard.getObjective(OBJECTIVE));if(!objective)fail('fixture objective absent');
  const id=native(()=>objective.id),valid=native(()=>objective.isValid),name=native(()=>objective.displayName);
  if(id!==OBJECTIVE||valid!==true||name!==d?.nonce||native(()=>objectives[0].id)!==OBJECTIVE)fail('fixture scoreboard identity differs');
  const scores=native(()=>objective.getScores());if(!Array.isArray(scores)||scores.length!==1)fail('fixture score census differs');
  const score=native(()=>scores[0].score),participant=native(()=>scores[0].participant);
  if(!participant||native(()=>participant.isValid)!==true||native(()=>participant.type)!=='FakePlayer'||native(()=>participant.id)!==d?.participantId||native(()=>participant.displayName)!==d?.participant||score!==0)fail('fixture fake participant/score differs');
  return JSON.stringify({id,name,participant:d?.participant,participantId:d?.participantId,score});
 }
 function emptyCensus(){
  const players=native(()=>world.getAllPlayers());if(!Array.isArray(players)||players.length!==1||native(()=>players[0].id)!==callerId)fail('fresh activation requires exactly the caller');
  for(const name of ['overworld','nether','the_end']){
   const dimension=native(()=>world.getDimension(name));
   if(native(()=>dimension.id)!=='minecraft:'+name)fail('unexpected dimension identity');
   const rows=native(()=>dimension.getEntities({location:{x:0,y:64,z:0},closest:LIMITS.entities+1}));
   if(!Array.isArray(rows)||rows.length>LIMITS.entities)fail('loaded entity census exceeds bound');
   const seen=new Set();for(const entity of rows){
    const id=native(()=>entity.id),type=native(()=>entity.typeId),valid=native(()=>entity.isValid),tags=native(()=>entity.getTags());
    if(typeof id!=='string'||!id||id.length>128||seen.has(id)||typeof type!=='string'||valid!==true||!Array.isArray(tags)||tags.length>LIMITS.tags||tags.some(t=>typeof t!=='string'||t.length>LIMITS.tagChars))fail('loaded census identity/tags unreadable');seen.add(id);
    if([...CUSTOM_CREATION_ENTITY_TYPES,"civ_trial:cavalry","civ_trial:cavalry_mount"].includes(type)||tags.some(t=>/^(?:civpop:|civbirth:|civbesiege:|civcavalry:)/.test(t)))fail('loaded population/siege history exists');
   }
  }
 }
 /** @param {string|null} intent @param {string|null} header */
 function verify(intent,header){
  if(!trusted(d))fail('no actual reviewed compiled blank-world receipt configured');
  properties(intent,header);const mark=marker();emptyCensus();properties(intent,header);if(marker()!==mark)fail('fixture marker changed during verification');properties(intent,header);fast();
 }
 const store=createUnifiedStore(world,{format:3,verifyFreshWorld:()=>{
  if(authorizing===null)fail('private initialization capability absent');verify(authorizing,null);
  return {verified:true,fixtureId:/** @type {NonNullable<typeof d>} */(d).fixtureId,dimension:'minecraft:overworld',ownerHistory:'never-started'};
 }});
 /** @param {any} player */
 function activate(player){
  if(!trusted(d))fail('no actual reviewed compiled blank-world receipt configured');
  if(caller)fail('fresh activation reentered');caller=player;
  try{callerId=String(player?.id??'');
   verify(null,null);
   const descriptor=/** @type {NonNullable<typeof d>} */(d),base={v:3,bindingVersion:3,fixture:descriptor.fixtureId,epoch:descriptor.epoch,receiptSha256:descriptor.receiptSha256,levelSha256:descriptor.levelSha256,objective:OBJECTIVE,nonce:descriptor.nonce,participant:descriptor.participant,participantId:descriptor.participantId};
   const intent=JSON.stringify({...base,phase:'intent'});if(intent.length>LIMITS.markerBytes)fail('activation intent byte bound');
   // Positive intent publication before core initialize; no clear/recovery fallback.
   properties(null,null);native(()=>world.setDynamicProperty(ACTIVATION_KEY,intent));if(native(()=>world.getDynamicProperty(ACTIVATION_KEY))!==intent)fail('activation intent readback failed');
   verify(intent,null);authorizing=intent;
   try{store.initialize({mode:'fresh',epoch:descriptor.epoch,fixture:descriptor.fixtureId});}finally{authorizing=null;}
   const header=native(()=>world.getDynamicProperty(META));if(typeof header!=='string')fail('fresh binding header missing');
   const exact=JSON.stringify({v:3,epoch:descriptor.epoch,mode:'fresh',fixture:descriptor.fixtureId,dimension:'minecraft:overworld',chunks:[],issued:0,pending:null});if(header!==exact)fail('fresh binding initial header differs');
   verify(intent,header);
   const complete=JSON.stringify({...base,phase:'complete'});properties(intent,header);native(()=>world.setDynamicProperty(ACTIVATION_KEY,complete));if(native(()=>world.getDynamicProperty(ACTIVATION_KEY))!==complete)fail('activation completion readback failed');properties(complete,header);return{state:'complete',fixture:descriptor.fixtureId};
  }finally{authorizing=null;caller=undefined;callerId='';}
 }
 // Wiring must call this BEFORE legacy fallback. Any partial/unknown marker holds.
 function status(){try{
  const ids=world.getDynamicPropertyIds();if(!Array.isArray(ids)||ids.length>LIMITS.allKeys||ids.some((/** @type {any} */k)=>typeof k!=='string'))fail('activation state census unreadable');
  if(ids.some(k=>k.startsWith(FAMILY)&&!k.startsWith(FAMILY+'v3:')))fail('v2/unknown binding history cannot become fresh-v3');
  const active=ids.filter((/** @type {string} */k)=>k.startsWith(ACTIVATION_FAMILY));
  if(!active.length){const raw=world.getDynamicProperty(META);if(typeof raw==='string'&&JSON.parse(raw).mode==='fresh')fail('fresh binding lacks completed activation');return{state:'absent'};}
  if(!trusted(d)||active.length!==1||active[0]!==ACTIVATION_KEY)fail('unknown/unconfigured activation receipt');
  const raw=world.getDynamicProperty(ACTIVATION_KEY);if(typeof raw!=='string'||raw.length>LIMITS.markerBytes)fail('activation receipt unreadable');const value=JSON.parse(raw),descriptor=/** @type {NonNullable<typeof d>} */(d);
  const exact=JSON.stringify({v:3,bindingVersion:3,fixture:descriptor.fixtureId,epoch:descriptor.epoch,receiptSha256:descriptor.receiptSha256,levelSha256:descriptor.levelSha256,objective:OBJECTIVE,nonce:descriptor.nonce,participant:descriptor.participant,participantId:descriptor.participantId,phase:'complete'});
  if(raw!==exact||value.phase!=='complete')fail('activation incomplete/mismatched; preserve intent and header');
  store.inspect('district-1:civ:0');const header=JSON.parse(world.getDynamicProperty(META));if(header.epoch!==descriptor.epoch||header.fixture!==descriptor.fixtureId||header.mode!=='fresh')fail('activation/binding epoch differs');
  if(world.getDynamicProperty(ACTIVATION_KEY)!==raw)fail('activation changed during final binding read');
  return{state:'complete'};
 }catch(error){return{state:'held',reason:String(error)};}}
 return{store,activate,status};
}
