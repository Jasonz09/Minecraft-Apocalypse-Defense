import {protectionStamp,classifyMarginColumn} from "./wallLeafMarginProtection.js";
import { SITE_STAGES, siteOpsFor } from "./districtplan.js";
import { isBenign, isLeaves, isPlant, isTreePart } from "../structures/terrain.js";

// Read-only production preview of the isolated trim policy. There is deliberately
// no block writer, property store, journal, chunk loader or mutation entry point.
export const WALL_LEAF_PREVIEW_POLICY="wall-leaves-margin-v2";
export const WALL_LEAF_PREVIEW_LIMITS=Object.freeze({candidates:64,wallTargets:200000,readsPerSlice:64,opsPerSlice:400,rowsPerPage:24});
const AIR=new Set(["minecraft:air","minecraft:cave_air","minecraft:void_air"]);
const MASONRY=new Set(["minecraft:stone_bricks","minecraft:mossy_stone_bricks","minecraft:cracked_stone_bricks","minecraft:cobblestone","minecraft:mossy_cobblestone","minecraft:stone","minecraft:andesite","minecraft:polished_andesite","minecraft:deepslate_bricks","minecraft:deepslate_tiles"]);
/** @param {any} p */
const key=p=>`${p.x},${p.y},${p.z}`;
/** @param {any} p */
function cube(p){const cells=[];for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++)cells.push({x:p.x+dx,y:p.y+dy,z:p.z+dz});return cells;}
/** @param {any} op @param {string} stage */
const decor=(op,stage)=>isTreePart(op.id)||isPlant(op.id)||((stage==="lots"||stage==="dressing")&&!AIR.has(op.id)&&!MASONRY.has(op.id));

/** All source records must come from checksum-verified completed saved runs in
 * the same master/dimension. This pure reader does not establish those assertions.
 * @param {{record:any,records:any[],read:(p:any)=>any,isProtected:(x:number,z:number)=>boolean,cancelled?:()=>boolean}} input
 * @param {{opsFor?:typeof siteOpsFor}} [deps]
 * @returns {Generator<void,any,void>} */
export function* previewWallLeavesSteps(input,deps={}) {
    const limits=WALL_LEAF_PREVIEW_LIMITS,opsFor=deps.opsFor??siteOpsFor;
    if(!input.record||!Array.isArray(input.records)||input.records.length<1||input.records.length>5||!input.records.includes(input.record))throw new Error("verified leaf-preview sources are missing");
    let reads=0,work=0,maxReads=0,maxOps=0,totalReads=0,totalOps=0;
    function* budget(/** @type {number} */ n=0) {
        if(input.cancelled?.())throw new Error("Leaf preview cancelled");
        if(reads+n>limits.readsPerSlice||work>=limits.opsPerSlice) {
            maxReads=Math.max(maxReads,reads);maxOps=Math.max(maxOps,work);reads=0;work=0;yield;
        }
    }
    /** @param {any} p
     * @returns {{ok:false,reason:string,id?:never,persistent?:never}|{ok:true,id:string,persistent?:unknown,reason?:never}} */
    function read(p) {
        reads++;totalReads++;
        try {
            const b=input.read(p);
            if(!b||b.isValid===false)return {ok:false,reason:b?"invalid block":"no block returned"};
            const id=b.typeId;if(typeof id!=="string")return {ok:false,reason:"no type id returned"};
            let persistent;
            if(isLeaves(id))try{persistent=b.states?.persistent_bit??b.permutation?.getState("persistent_bit");}catch(_error){persistent=undefined;}
            return {ok:true,id,...(isLeaves(id)?{persistent}: {})};
        }catch(error){return {ok:false,reason:String(error)};}
    }
    /** @type {Map<string,{wall:any,last:any,stage:string}>} */
    const walls=new Map();
    for(const stage of SITE_STAGES) {
        if(!Array.isArray(input.record[stage]))throw new Error("verified source is missing a stage");
        for(let i=0;i<input.record[stage].length;i++)for(const op of opsFor(input.record,stage,i)) {
            yield* budget();work++;totalOps++;
            const at=key(op);
            if(stage==="walls"&&!AIR.has(op.id)) {
                if(!walls.has(at)&&walls.size>=limits.wallTargets)throw new Error("leaf-preview wall target budget exceeded");
                walls.set(at,{wall:op,last:op,stage});
            }else {const old=walls.get(at);if(old){old.last=op;old.stage=stage;}}
        }
    }
    /** @type {any[]} */
    const candidates=[],unloadedSamples=[];
    let targets=0,surveyed=0,unloaded=0,tree=0,present=0,other=0;
    for(const value of walls.values()) {
        if(value.last.id!==value.wall.id)continue;
        targets++;yield* budget(1);const observed=read(value.wall);
        if(!observed.ok){unloaded++;if(unloadedSamples.length<4)unloadedSamples.push(`${key(value.wall)}: ${observed.reason}`);continue;}
        surveyed++;
        if(observed.id===value.wall.id){present++;continue;}
        if(!isTreePart(/** @type {string} */(observed.id))){other++;continue;}
        tree++;
        if(candidates.length<limits.candidates)candidates.push({target:value.wall,final:value.last,stage:value.stage,observed});
    }
    const wanted=new Set(candidates.flatMap(c=>cube(c.target)).map(key)),historical=new Set(),neighborTouched=new Set();
    /** @type {Map<string,Set<string>>} */
    const expected=new Map();
    for(const record of input.records)for(const stage of SITE_STAGES) {
        if(!Array.isArray(record[stage]))throw new Error("verified neighboring source is missing a stage");
    }
    for(const record of input.records) {
        /** @type {Map<string,string>} */
        const final=new Map();
        for(const stage of SITE_STAGES)for(let i=0;i<record[stage].length;i++)for(const op of opsFor(record,stage,i)) {
            yield* budget();work++;totalOps++;
            const at=key(op);if(!wanted.has(at))continue;
            if(record!==input.record)neighborTouched.add(at);
            if(decor(op,stage))historical.add(at);
            final.set(at,op.id);
        }
        for(const [at,id] of final)if(MASONRY.has(id)){const ids=expected.get(at)??new Set();ids.add(id);expected.set(at,ids);}
    }
    /** @type {any[]} */
    const rows=[];let contactsUnread=0;
    for(const candidate of candidates) {
        yield* budget(27);
        const authority=input.getProtection();protectionStamp(authority);
        const contacts=[];let reason;let margin=false;
        for(const p of cube(candidate.target)) {
            let protectedCell;
            try{protectedCell=input.isProtected(p.x,p.z);}catch(_error){protectedCell=undefined;}
            const block=read(p);contacts.push({...p,...block,protected:protectedCell,historical:historical.has(key(p))});
            const classification=classifyMarginColumn(authority,p.x,p.z);margin ||= classification==="margin";
            if(classification==="blocked"||typeof protectedCell!=="boolean"||protectedCell!==(classification==="margin"))reason??=`protected/unknown/hard-margin neighboring column ${key(p)}`;
            if(neighborTouched.has(key(p)))reason??=`another district historical operation ${key(p)}`;
            if(historical.has(key(p)))reason??=`historical planned vegetation/decor ${key(p)}`;
            if(!block.ok){contactsUnread++;reason??=`unreadable contact ${key(p)}: ${block.reason}`;}
        }
        if(!margin)reason??="not a grow4-only margin candidate";
        if(protectionStamp(input.getProtection())!==protectionStamp(authority))reason??="margin protection changed during proof";
        const target=contacts.find(p=>key(p)===key(candidate.target));
        if(candidate.stage!=="walls"||candidate.final.kind!=="wall"||!MASONRY.has(candidate.final.id)||Object.keys(candidate.final.states??{}).length)reason??="not the exact final stateless solid masonry wall owner";
        for(const contact of contacts) {
            if(key(contact)===key(candidate.target)||!contact.ok)continue;
            if(isLeaves(contact.id)&&contact.persistent!==false)reason??=`persistent or unknown-state leaf contact ${key(contact)}`;
            if(!isBenign(contact.id)&&!expected.get(key(contact))?.has(contact.id))reason??=`foreign contact ${key(contact)}: ${contact.id}`;
        }
        let state="refused";
        if(!reason&&target?.ok&&target.id===candidate.final.id)state="present";
        else if(!reason&&target?.ok&&isLeaves(target.id)&&target.persistent===false)state="eligible";
        else reason??="target is not a readable nonpersistent natural leaf";
        rows.push({target:{x:candidate.target.x,y:candidate.target.y,z:candidate.target.z},expected:candidate.final.id,
            actual:target?.id??candidate.observed.id,persistent:target?.persistent,state,reason:reason??null,contacts});
    }
    maxReads=Math.max(maxReads,reads);maxOps=Math.max(maxOps,work);
    return {policy:WALL_LEAF_PREVIEW_POLICY,checksum:input.record.checksum,targets,surveyed,unloaded,present,other,tree,
        truncated:tree>limits.candidates,complete:unloaded===0&&contactsUnread===0&&tree<=limits.candidates,rows,unloadedSamples,contactsUnread,
        eligible:rows.filter(r=>r.state==="eligible").length,refused:rows.filter(r=>r.state==="refused").length,
        nowPresent:rows.filter(r=>r.state==="present").length,
        stats:{totalReads,totalOps,maxReads,maxOps}};
}

/** At most 32 chat lines; subsequent pages rerun a fresh read-only survey.
 * @param {any} result @param {number} [page] */
export function formatWallLeafPreview(result,page=1) {
    const size=WALL_LEAF_PREVIEW_LIMITS.rowsPerPage,pages=Math.max(1,Math.ceil(result.rows.length/size));
    const lines=[`=== Wall leaf preview: ${result.complete?"complete":"incomplete"} (${result.checksum}) ===`,
        `Wall targets ${result.targets}; surveyed ${result.surveyed}; unreadable walls ${result.unloaded}, contacts ${result.contactsUnread}; tree occupied ${result.tree}.`,
        `Eligible ${result.eligible}, refused ${result.refused}, now present ${result.nowPresent}; ${result.truncated?"candidate list truncated at 64":"all observed candidates listed (limit 64)"}; page ${page}/${pages}.`];
    if(page<1||page>pages)lines.push(`Requested page is outside 1..${pages}.`);
    else for(const row of result.rows.slice((page-1)*size,page*size))lines.push(`${key(row.target)} ${row.actual}; persistent_bit=${String(row.persistent??"unknown")}; contacts=${row.contacts.length}/27: ${row.state}${row.reason?` - ${row.reason}`:""}; expected ${row.expected}`);
    if(result.unloaded)lines.push(`Unreadable sample: ${result.unloadedSamples.join(" | ")}`);
    lines.push("Read-only, player-loaded chunks only: no blocks/properties/queues/leases changed. Eligibility is a fresh preview, not permission to trim.");
    if(pages>1)lines.push("Use leafpreview district=N page=P for every bounded page; each request surveys again.");
    return lines;
}
