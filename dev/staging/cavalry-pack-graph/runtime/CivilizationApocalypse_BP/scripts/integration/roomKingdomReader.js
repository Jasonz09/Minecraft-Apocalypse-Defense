import {createKingdomStore} from "../kingdom/store.js";
import {STORAGE_KEYS} from "../config.js";

/** Freeze only JSON-decoded own values; never retains native handles.
 * @param {unknown} value */
function freezeDecoded(value){
 /** @type {unknown[]} */const pending=[value];
 while(pending.length){
  const next=pending.pop();
  if(next&&typeof next==="object"){
   for(const child of Object.values(next))if(child&&typeof child==="object")pending.push(child);
   Object.freeze(next);
  }
 }
}

/** One room command only. Every call performs the original single native raw read.
 * Decode/validate through the existing store on changes; never caches refusal.
 * No global state, source/property writes, protection shortcut or native getter reuse.
 * @param {Pick<import("@minecraft/server").World,"getDynamicProperty">} world */
export function createRoomKingdomReader(world){
 /** @type {unknown} */let observed;
 /** @type {string|undefined} */let cachedRaw;
 /** @type {ReturnType<ReturnType<typeof createKingdomStore>["load"]>|undefined} */let cached;
 // The ordinary store decoder consumes this call's exact raw value, not a second
 // native read. Its write-capable methods remain private and are never called.
 const decoder=createKingdomStore(/** @type {import("@minecraft/server").World} */(/** @type {unknown} */({getDynamicProperty(/** @type {string} */key){
  if(key!==STORAGE_KEYS.kingdom)throw Error("room kingdom decoder requested an unexpected key");
  return observed;
 }})));
 return function read(){
  observed=world.getDynamicProperty(STORAGE_KEYS.kingdom);
  if(typeof observed==="string"&&cached&&observed===cachedRaw)return cached;
  cached=undefined;cachedRaw=undefined;
  const decoded=decoder.load();
  if(decoded.status==="ok"&&decoded.kingdom!==undefined){
   freezeDecoded(decoded);cached=decoded;cachedRaw=/** @type {string} */(observed);
  }
  return decoded;
 };
}
