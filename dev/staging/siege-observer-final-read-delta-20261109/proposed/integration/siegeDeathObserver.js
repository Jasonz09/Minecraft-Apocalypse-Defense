// @ts-check
// READ ONLY: no event subscription, actor lifecycle or journal writer here.
export const SIEGE_OBSERVER_TYPES=Object.freeze(['minecraft:pillager','minecraft:vindicator','minecraft:husk','minecraft:drowned']);
const ascii=(/** @type {any} */v)=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,128}$/.test(v);
/** @param {any} h */function frame(h){
 const id=h.id,type=h.typeId,valid=h.isValid,dimension=h.dimension.id,tags=h.getTags();
 if(!ascii(id)||!SIEGE_OBSERVER_TYPES.includes(type)||typeof valid!=='boolean'||dimension!=='minecraft:overworld'||!Array.isArray(tags)||tags.length>64||tags.some(t=>typeof t!=='string'||t.length>256)||new Set(tags).size!==tags.length)throw Error('native death frame unreadable');
 const districts=tags.filter(t=>t.startsWith('civbesiege:v1:'));
 if(!tags.includes('civbesiege:v1')||districts.length!==1||!/^civbesiege:v1:district-[1-5]$/.test(districts[0]))throw Error('siege death tags ambiguous');
 return{id,type,valid,dimension,district:districts[0].slice('civbesiege:v1:'.length),tags:[...tags].sort()};
}
/** Only a candidate observer. Lookup must come from the validated journal, not
 * loaded entity census; native birth registration remains unimplemented.
 * No candidate is published to the journal by this module.
 * @param {{enabled?:boolean,lookupActor:(id:string)=>any,readStep:()=>number}} deps */
export function createSiegeDeathObserver(deps){
 if(deps.enabled!==true)return null;
 /** @type {any} */let last=Object.freeze({state:'not-observed'});
 function observeDeath(/** @type {any} */event){
  try{
   const h=event.deadEntity,first=frame(h),a=deps.lookupActor(first.id);
   if(!a?.record){last=Object.freeze({state:'ignored',reason:'untracked actor; never adopt historical tags'});return last;}
   const r=a.record;
   if(r.phase!=='alive'){last=Object.freeze({state:'ignored',reason:'already terminal'});return last;}
   if(r.id!==first.id||r.type!==first.type||r.district!==first.district)throw Error('journal/native identity differs');
   const step=deps.readStep();if(!Number.isSafeInteger(step)||step<r.bornStep)throw Error('current step differs/stale');
   const second=frame(h);if(JSON.stringify(first)!==JSON.stringify(second))throw Error('native frame changed');
   const b=deps.lookupActor(first.id);
   if(!b||b.sourceRaw!==a.sourceRaw||JSON.stringify(b.record)!==JSON.stringify(r))throw Error('journal changed during native read');
   const finalFrame=frame(h);if(JSON.stringify(first)!==JSON.stringify(finalFrame))throw Error('native frame changed after metadata callbacks');
   // Retain original issued wave, NEVER substitute a new current-wave label.
   const proof=Object.freeze({id:r.id,type:r.type,district:r.district,wave:r.wave,step});
   last=Object.freeze({state:'tracked-event-candidate',proof,aggregateDelta:0,humanCasualtyDebit:0});return last;
  }catch{last=Object.freeze({state:'held',reason:'unreadable or changed event/journal; no terminal publication'});return last;}
 }
 return Object.freeze({observeDeath,status:()=>last});
}
/** Wrap the callback passed to the ONE existing entityDie subscription.
 * Wrapper executes before unrelated creation-store early returns. No subscribe.
 * Default NULL preserves callback identity and zero extra native/API reads.
 * @param {(event:any)=>any} existing @param {{observeDeath:(event:any)=>unknown}|null} observer */
export function wrapExistingDeathCallback(existing,observer){
 if(observer===null)return existing;
 return(/** @type {any} */event)=>{try{observer.observeDeath(event);}catch{/* Observer cannot skip ordinary population handling. */}return existing(event);};
}
/** @param {{entityTypes:string[]}} existing @param {unknown} observer */
export function existingDeathFilter(existing,observer){
 if(observer===null)return existing;
 return{...existing,entityTypes:[...new Set([...existing.entityTypes,...SIEGE_OBSERVER_TYPES])]};
}
