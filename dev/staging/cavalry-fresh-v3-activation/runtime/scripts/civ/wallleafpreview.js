import { SITE_STAGES, siteOpsFor } from "./districtplan.js";
import { isBenign, isLeaves, isPlant, isTreePart } from "../structures/terrain.js";

// Read-only production preview of the isolated trim policy. There is deliberately
// no block writer, property store, journal, chunk loader or mutation entry point.
export const WALL_LEAF_PREVIEW_POLICY="wall-leaves-trim-v1";
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
const WALL_CENSUS=new WeakMap();
/** @param {any} checksum @param {any} context @param {number} sourceCount */
function previewState(checksum,context,sourceCount){
    const limits=WALL_LEAF_PREVIEW_LIMITS;
    let reads=0,work=0,maxReads=0,maxOps=0,totalReads=0,totalOps=0;
    function* budget(/** @type {number} */ n=0) {
        if(context.cancelled?.())throw new Error("Leaf preview cancelled");
        if(reads+n>limits.readsPerSlice||work>=limits.opsPerSlice) {
            maxReads=Math.max(maxReads,reads);maxOps=Math.max(maxOps,work);reads=0;work=0;yield;
        }
    }
    /** @param {any} p
     * @returns {{ok:false,reason:string,id?:never,persistent?:never}|{ok:true,id:string,persistent?:unknown,reason?:never}} */
    function read(p) {
        reads++;totalReads++;
        try {
            const b=context.read(p);
            if(!b||b.isValid===false)return {ok:false,reason:b?"invalid block":"no block returned"};
            const id=b.typeId;if(typeof id!=="string")return {ok:false,reason:"no type id returned"};
            let persistent;
            if(isLeaves(id))try{persistent=b.states?.persistent_bit??b.permutation?.getState("persistent_bit");}catch(_error){persistent=undefined;}
            return {ok:true,id,...(isLeaves(id)?{persistent}: {})};
        }catch(error){return {ok:false,reason:String(error)};}
    }
    return{checksum,context,sourceCount,processed:new Set(),budget,read,
        stats:()=>({totalReads,totalOps,maxReads:Math.max(maxReads,reads),maxOps:Math.max(maxOps,work)}),op(){work++;totalOps++;}};
}
/** Read ALL selected final wall cells. No eligibility filtering or source permission. */
/** @param {any} record @param {any} context @param {{sourceCount:number,opsFor?:typeof siteOpsFor}} deps */
export function* collectWallLeafCensusSteps(record,context,deps){
    const limits=WALL_LEAF_PREVIEW_LIMITS,opsFor=deps.opsFor??siteOpsFor;
    if(!record||!Number.isInteger(deps.sourceCount)||deps.sourceCount<1||deps.sourceCount>5)throw new Error("verified leaf-preview sources are missing");
    // Detached callbacks ensure the long-lived session does not close over a source record.
    const s=previewState(record.checksum,{read:context.read,isProtected:context.isProtected,cancelled:context.cancelled},deps.sourceCount);
    const budget=s.budget,read=s.read;
    /** @type {Map<string,{wall:any,last:any,stage:string}>} */
    const walls=new Map();
    for(const stage of SITE_STAGES) {
        if(!Array.isArray(record[stage]))throw new Error("verified source is missing a stage");
        for(let i=0;i<record[stage].length;i++)for(const op of opsFor(record,stage,i)) {
            yield* budget();s.op();
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
    const token=Object.freeze({});
    Object.assign(s,{candidates,unloadedSamples,targets,surveyed,unloaded,tree,present,other,wanted:new Set(candidates.flatMap(c=>cube(c.target)).map(key)),historical:new Set(),expected:new Map()});
    WALL_CENSUS.set(token,s);return token;
}
/** Read-only coordinates/statistics, never eligibility or a compiled batch. */
/** @param {object} token */
export function wallLeafCensusView(token){const s=WALL_CENSUS.get(token);if(!s)throw new Error("foreign wall census capability");return{candidates:s.candidates.map(/** @param {any} c */c=>({x:c.target.x,y:c.target.y,z:c.target.z})),targets:s.targets,surveyed:s.surveyed,unloaded:s.unloaded,tree:s.tree,truncated:s.tree>WALL_LEAF_PREVIEW_LIMITS.candidates};}
/** @param {object} token @param {any} record @param {number} ordinal @param {{opsFor?:typeof siteOpsFor}} [deps] */
export function* accumulateWallLeafPreviewSourceSteps(token,record,ordinal,deps={}){
    const s=WALL_CENSUS.get(token),opsFor=deps.opsFor??siteOpsFor;
    if(!s||!Number.isInteger(ordinal)||ordinal<0||ordinal>=s.sourceCount||s.processed.has(ordinal))throw new Error("missing/duplicate wall census source");
    let complete=false;
    try{
        const final=new Map();
        for(const stage of SITE_STAGES){
            if(!Array.isArray(record[stage]))throw new Error("verified neighboring source is missing a stage");
            for(let i=0;i<record[stage].length;i++)for(const op of opsFor(record,stage,i)){
                yield* s.budget();s.op();const at=key(op);if(!s.wanted.has(at))continue;
                if(decor(op,stage))s.historical.add(at);final.set(at,op.id);
            }
        }
        for(const[at,id]of final)if(MASONRY.has(id)){const ids=s.expected.get(at)??new Set();ids.add(id);s.expected.set(at,ids);}
        s.processed.add(ordinal);complete=true;
    }finally{if(!complete)WALL_CENSUS.delete(token);}
}
/** Fresh27-cell classification only after every source contribution. */
/** @param {object} token */
export function* finishWallLeafPreviewSteps(token){
    const s=WALL_CENSUS.get(token);if(!s||s.processed.size!==s.sourceCount)throw new Error("incomplete or foreign wall census summary");
    const {candidates,historical,expected}=s;
    /** @type {any[]} */
    const rows=[];let contactsUnread=0;
    for(const candidate of candidates) {
        yield* s.budget(27);
        const contacts=[];let reason;
        for(const p of cube(candidate.target)) {
            let protectedCell;
            try{protectedCell=s.context.isProtected(p.x,p.z);}catch(_error){protectedCell=undefined;}
            const block=s.read(p);contacts.push({...p,...block,protected:protectedCell,historical:historical.has(key(p))});
            if(protectedCell!==false)reason??=`protected or unknown neighboring column ${key(p)}`;
            if(historical.has(key(p)))reason??=`historical planned vegetation/decor ${key(p)}`;
            if(!block.ok){contactsUnread++;reason??=`unreadable contact ${key(p)}: ${block.reason}`;}
        }
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
    const result={policy:WALL_LEAF_PREVIEW_POLICY,checksum:s.checksum,targets:s.targets,surveyed:s.surveyed,unloaded:s.unloaded,present:s.present,other:s.other,tree:s.tree,
        truncated:s.tree>WALL_LEAF_PREVIEW_LIMITS.candidates,complete:s.unloaded===0&&contactsUnread===0&&s.tree<=WALL_LEAF_PREVIEW_LIMITS.candidates,rows,unloadedSamples:s.unloadedSamples,contactsUnread,
        eligible:rows.filter(r=>r.state==="eligible").length,refused:rows.filter(r=>r.state==="refused").length,nowPresent:rows.filter(r=>r.state==="present").length,stats:s.stats()};
    WALL_CENSUS.delete(token);return result;
}
/** Same public batch preview API, using the exact shared census/classifier. */
/** @param {{record:any,records:any[],read:(p:any)=>any,isProtected:(x:number,z:number)=>boolean,cancelled?:()=>boolean}} input @param {{opsFor?:typeof siteOpsFor}} [deps] */
export function* previewWallLeavesSteps(input,deps={}){
    if(!input.record||!Array.isArray(input.records)||input.records.length<1||input.records.length>5||!input.records.includes(input.record))throw new Error("verified leaf-preview sources are missing");
    const token=yield* collectWallLeafCensusSteps(input.record,input,{...deps,sourceCount:input.records.length});
    // Preserve current all-source stage validation before any contribution.
    for(const record of input.records)for(const stage of SITE_STAGES)if(!Array.isArray(record[stage]))throw new Error("verified neighboring source is missing a stage");
    for(let i=0;i<input.records.length;i++)yield* accumulateWallLeafPreviewSourceSteps(token,input.records[i],i,deps);
    return yield* finishWallLeafPreviewSteps(token);
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
