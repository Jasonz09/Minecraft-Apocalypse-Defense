// @ts-check
import {FAMILY,META} from "./creationBindings.js";
import {createPrivateFreshFixture,ACTIVATION_FAMILY} from "./privateFreshFixture.js";
import {REVIEWED_FRESH_FIXTURE} from "./freshFixtureTrust.js";
/** Lazy optional integration proposal. Construction does not read native world state.
 * Fresh activation is private compiled-fixture only; the shipped descriptor is null.
 * @param {{world:any,isPeopleOn:()=>boolean,isBusy:()=>boolean,isDeveloper:()=>boolean,readKingdom:()=>any}} deps */
export function createCreationRuntime(deps){
 const fixture=createPrivateFreshFixture(deps),store=fixture.store;let registered=false,last="not observed";
 function keys(){const k=deps.world.getDynamicPropertyIds();if(!Array.isArray(k)||k.length>4096||k.some(x=>typeof x!=="string")||new Set(k).size!==k.length)throw Error("creation state census unreadable");return k;}
 function activeStore(){
  const before=fixture.status();if(before.state==='held')throw Error('creation activation HOLD: '+before.reason);
  const ids=keys();
  if(before.state==='absent'&&ids.some(k=>k.startsWith(ACTIVATION_FAMILY)))throw Error('creation activation changed during census; HOLD');
  const present=ids.some(k=>k.startsWith(FAMILY));
  if(before.state==='absent'&&!present&&REVIEWED_FRESH_FIXTURE!==null)throw Error('private fixture activation pending; HOLD before legacy birth');
  const after=fixture.status();if(after.state!==before.state||after.state==='held')throw Error('creation activation changed or held');
  return present||after.state==='complete'?store:undefined;
 }
 function statusLines(){try{const s=activeStore();if(!s)return["Creation history: off (legacy population behavior).",`Last creation signal: ${last}`];s.inspect("district-1:civ:0");const m=JSON.parse(deps.world.getDynamicProperty(META));return[`Creation history: ${m.mode}; ${m.issued} groups; pending issuance ${m.pending?"held":"none"}.`,`Last creation signal: ${last}`];}catch(e){return[`Creation history held: ${String(e)}`];}}
 /** @param {string} message @param {any} [player] */
 function command(message,player){const text=message.trim();if(text==="status")return statusLines();
  if(!deps.isDeveloper()||deps.isBusy()||deps.isPeopleOn())throw Error("creation activation requires development mode, people off and no active job");
  if(text==="fresh confirm"){
   fixture.activate(player);last='reviewed private fixture activation complete';return statusLines();
  }
  // A marker of any activation schema must never reach legacy initialization.
  const activation=fixture.status();if(activation.state!=='absent'||keys().some(k=>k.startsWith(ACTIVATION_FAMILY)))throw Error('creation activation present or held; legacy fallback prohibited');
  const m=/^legacy confirm epoch=([A-Za-z0-9_-]{1,64})$/.exec(text);if(!m)throw Error("use creation status or creation legacy confirm epoch=<unique-id>");
  if(deps.readKingdom()?.starter!==undefined)throw Error("armed template/play state cannot become a development migration fixture");
  if(fixture.status().state!=='absent'||keys().some(k=>k.startsWith(ACTIVATION_FAMILY)))throw Error('creation activation changed before legacy initialization; HOLD');
  store.initialize({mode:"legacy",epoch:m[1],fixture:"legacy-preserve"});last="legacy history selected; unknown groups cannot be recreated";return statusLines();
 }
 // Subscription is early-safe: the first world read is inside the native event callback.
 // No entityRemove fallback, no aggregate casualty authority and no replacement on absence.
 /** @param {any} player */
 function onInitialSpawn(player){
  // No world read at all when the compiled descriptor is absent. Never set the developer flag.
  if(REVIEWED_FRESH_FIXTURE===null)return false;
  try{
   const status=fixture.status();if(status.state==='complete')return false;
   if(status.state!=='absent')throw Error('creation activation incomplete; preserve and HOLD');
   if(deps.isDeveloper()!==true||deps.isPeopleOn()!==false||deps.isBusy()!==false)throw Error('private first-spawn activation needs preconfigured developer flag, people off and idle');
   fixture.activate(player);last='private first-spawn fixture activation complete';return true;
  }catch(error){last='private first-spawn activation held: '+String(error).slice(0,180);return false;}
 }
 function registerDeaths(){if(registered)return false;deps.world.afterEvents.entityDie.subscribe((/** @type {any} */e)=>{try{const s=activeStore();if(!s)return;const h=e.deadEntity,tags=h.getTags();if(!Array.isArray(tags)||tags.length>64)throw Error("death identity unreadable");const claims=tags.filter(t=>typeof t==="string"&&t.startsWith("civpop:v1:"));if(claims.length!==1)return;const accepted=s.confirmDeath({groupId:claims[0].slice(10),id:String(h.id),typeId:h.typeId,tags:[...tags]});last=accepted?"exact physical death recorded; aggregate unchanged":"duplicate/untracked death ignored";}catch(e){last=`death held: ${String(e).slice(0,180)}`;}},{entityTypes:["minecraft:villager_v2","minecraft:iron_golem","civ_trial:swordsman"]});registered=true;return true;}
 return{activeStore,statusLines,command,registerDeaths,onInitialSpawn};
}
