/** Negative evidence only. Invalidating a base permits another full tree proof,
 * never felling. Ordinary non-root tree refusals live in a separate cache. */
export const TREE_ROOT_CACHE_LIMITS=Object.freeze({bases:64,entries:8192,componentKeys:4001});
/** @param {{generationLimit?:number}} [options] */
export function createTreeRootRefusalCache(options={}){
    const limit=Number.isSafeInteger(options.generationLimit)&&Number(options.generationLimit)>0?Number(options.generationLimit):Number.MAX_SAFE_INTEGER;
    /** @typedef {{base:string,generation:number,exhausted:boolean,keys:Set<string>}} Group */
    /** @type {Map<string,Group>} */const groups=new Map();
    /** @type {Map<string,{group:Group,generation:number,reason:string}>} */const entries=new Map();
    const bounded=(/** @type {any} */s)=>typeof s==="string"&&s.length>0&&s.length<=128;
    /** @param {string} at */
    function get(at){const entry=entries.get(at);if(!entry)return undefined;
        if(entry.group.exhausted||entry.generation!==entry.group.generation){entries.delete(at);entry.group.keys.delete(at);if(!entry.group.keys.size)groups.delete(entry.group.base);return undefined;}
        return entry.reason;
    }
    /** Capacity refusal does not alter any cached verdict. Caller still refuses
     * the current tree, but cannot cache that new root verdict elsewhere.
     * @param {string} base @param {string[]} candidates @param {string} reason */
    function remember(base,candidates,reason){
        if(!bounded(base)||!Array.isArray(candidates)||candidates.length>TREE_ROOT_CACHE_LIMITS.componentKeys||!candidates.length||candidates.some(k=>!bounded(k))||typeof reason!=="string"||reason.length>512)return false;
        const keys=new Set(candidates),existing=groups.get(base);
        if(existing?.exhausted||(!existing&&groups.size>=TREE_ROOT_CACHE_LIMITS.bases))return false;
        let added=0;for(const k of keys)if(!entries.has(k))added++;
        if(entries.size+added>TREE_ROOT_CACHE_LIMITS.entries)return false;
        const group=existing??{base,generation:0,exhausted:false,keys:new Set()};groups.set(base,group);
        for(const k of keys){const old=entries.get(k);if(old&&old.group!==group){old.group.keys.delete(k);if(!old.group.keys.size)groups.delete(old.group.base);}
            group.keys.add(k);entries.set(k,{group,generation:group.generation,reason});}
        return true;
    }
    /** Constant work, zero candidate traversal/native reads. Overflow makes all
     * entries in this group ineligible as cached evidence and refuses recaching.
     * @param {string} base */
    function invalidate(base){const group=groups.get(base);if(!group)return false;
        if(group.generation>=limit)group.exhausted=true;else group.generation++;
        return true;
    }
    function clear(){entries.clear();groups.clear();}
    return{get,remember,invalidate,clear,status:()=>({bases:groups.size,entries:entries.size})};
}
