// @ts-check
import {createCreationBindings,FAMILY,META} from "./creationBindings.js";
/** Lazy optional integration proposal. Construction does not read native world state.
 * Fresh activation is intentionally unavailable until an actual known-blank receipt is pinned.
 * @param {{world:any,isPeopleOn:()=>boolean,isBusy:()=>boolean,isDeveloper:()=>boolean,readKingdom:()=>any}} deps */
export function createCreationRuntime(deps){
 const store=createCreationBindings(deps.world);let registered=false,last="not observed";
 function keys(){const k=deps.world.getDynamicPropertyIds();if(!Array.isArray(k)||k.length>4096||k.some(x=>typeof x!=="string"))throw Error("creation state census unreadable");return k;}
 function activeStore(){return keys().some(k=>k.startsWith(FAMILY))?store:undefined;}
 function statusLines(){try{const s=activeStore();if(!s)return["Creation history: off (legacy population behavior).",`Last creation signal: ${last}`];s.inspect("district-1:civ:0");const m=JSON.parse(deps.world.getDynamicProperty(META));return[`Creation history: ${m.mode}; ${m.issued} groups; pending issuance ${m.pending?"held":"none"}.`,`Last creation signal: ${last}`];}catch(e){return[`Creation history held: ${String(e)}`];}}
 /** @param {string} message */
 function command(message){const text=message.trim();if(text==="status")return statusLines();
  if(!deps.isDeveloper()||deps.isBusy()||deps.isPeopleOn())throw Error("creation activation requires development mode, people off and no active job");
  if(text==="fresh confirm")throw Error("no reviewed never-started fixture receipt is configured; existing actors/cursor absence cannot prove freshness");
  const m=/^legacy confirm epoch=([A-Za-z0-9_-]{1,64})$/.exec(text);if(!m)throw Error("use creation status or creation legacy confirm epoch=<unique-id>");
  if(deps.readKingdom()?.starter!==undefined)throw Error("armed template/play state cannot become a development migration fixture");
  store.initialize({mode:"legacy",epoch:m[1],fixture:"legacy-preserve"});last="legacy history selected; unknown groups cannot be recreated";return statusLines();
 }
 // Subscription is early-safe: the first world read is inside the native event callback.
 // No entityRemove fallback, no aggregate casualty authority and no replacement on absence.
 function registerDeaths(){if(registered)return false;deps.world.afterEvents.entityDie.subscribe((/** @type {any} */e)=>{try{const s=activeStore();if(!s)return;const h=e.deadEntity,tags=h.getTags();if(!Array.isArray(tags)||tags.length>64)throw Error("death identity unreadable");const claims=tags.filter(t=>typeof t==="string"&&t.startsWith("civpop:v1:"));if(claims.length!==1)return;const accepted=s.confirmDeath({groupId:claims[0].slice(10),id:String(h.id),typeId:h.typeId,tags:[...tags]});last=accepted?"exact physical death recorded; aggregate unchanged":"duplicate/untracked death ignored";}catch(e){last=`death held: ${String(e).slice(0,180)}`;}},{entityTypes:["minecraft:villager_v2","minecraft:iron_golem","civ_trial:swordsman"]});registered=true;return true;}
 return{activeStore,statusLines,command,registerDeaths};
}
