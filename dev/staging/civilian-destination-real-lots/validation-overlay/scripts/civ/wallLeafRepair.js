import {POLICY,compileLeafTrimSteps,previewLeafTrim,prepareLeafTrimSteps,resumeLeafTrimSteps,commitOneLeafTrim,key,readLeafTrimReceipt} from "./wallLeafTrim.js";
import {previewWallLeavesSteps} from "./wallleafpreview.js";
import {utf8Length} from "./planstore.js";

export const WALL_LEAF_STATE_PREFIX="civ:wall_leaf_trim:";
export const WALL_LEAF_REPAIR_LIMITS=Object.freeze({sourceKeys:128,allKeys:4096,sourceBytes:1500000,journalsPerDistrict:16});
/** @param {string} reason @returns {never} */
const fail=reason=>{throw new Error(reason);};
/** @param {unknown} value */
const hash=value=>typeof value==="string"&&/^[a-f0-9]{8}$/.test(value);
/** @param {string} k */
const scopedKey=k=>k.startsWith("civ:plan:")||/^civ:jobs(?::d[1-5])?:(?:meta|[ab]:\d+)$/.test(k);
/** Source geometry only: simulation counters/resources do not affect permission. */
/** @param {any} kingdom */
function protectionIdentity(kingdom){
    if(!kingdom||!Array.isArray(kingdom.districts)||kingdom.districts.length>64)fail("kingdom protection is unreadable");
    const ids=new Set();return JSON.stringify(kingdom.districts.map(/** @param {any} d */ d=>{
        if(typeof d?.id!=="string"||ids.has(d.id))fail("district source identity is ambiguous");ids.add(d.id);
        return{id:d.id,civ:d.civ??null,origin:d.physical?.origin??null};
    }).sort(/** @param {{id:string}} a @param {{id:string}} b */ (a,b)=>a.id.localeCompare(b.id)));
}
/** Call BEFORE any cooperative source loading; unchanged raw source/queue bytes
 * and protection projection are checked across every yield and last-read barrier.
 * All runtime capabilities are injected. No property is written by this guard. */
/** @param {import("@minecraft/server").World} world @param {()=>any} readKingdom @param {()=>boolean} [cancelled] */
export function createWallLeafSourceGuard(world,readKingdom,cancelled=()=>false){
    function capture(){
        const all=world.getDynamicPropertyIds();if(!Array.isArray(all)||all.length>WALL_LEAF_REPAIR_LIMITS.allKeys||all.some(k=>typeof k!=="string"))fail("source key census unreadable or over budget");
        const keys=all.filter(scopedKey).sort();if(keys.length>WALL_LEAF_REPAIR_LIMITS.sourceKeys)fail("source snapshot key budget exceeded");
        let bytes=0;const values=keys.map(k=>{const v=world.getDynamicProperty(k);if(typeof v!=="string")fail("source property is not text: "+k);bytes+=utf8Length(v);if(bytes>WALL_LEAF_REPAIR_LIMITS.sourceBytes)fail("source snapshot byte budget exceeded");return[k,v];});
        return{values,protection:protectionIdentity(readKingdom())};
    }
    const original=JSON.stringify(capture());
    return{current(){try{return !cancelled()&&JSON.stringify(capture())===original;}catch(_error){return false;}},
        assert(){if(!this.current())fail("source/master/queue/protection changed or cancellation requested; preserve journal and world");}};
}
/** @template T @param {Generator<any,T,any>} generator @param {import("./wallLeafTrim.js").LeafContext} ctx @returns {Generator<undefined,T,any>} */
function* guarded(generator,ctx){for(;;){if(ctx.sourcesCurrent()!==true)fail("fresh source/protection guard refused");const next=generator.next();if(ctx.sourcesCurrent()!==true)fail("source changed during cooperative work");if(next.done)return next.value;yield;}}
/** Pure injected controller. New batches admit only freshly eligible loaded
 * candidates. Interrupted batches recover ORIGINAL coordinates from their receipt.
 * No lease/chunk loader, original queue save, or broad tree clearer exists here. */
/** @param {import("./wallLeafTrim.js").LeafInput} input @param {import("./wallLeafTrim.js").LeafContext} ctx @param {import("@minecraft/server").World} world @param {{confirm?:boolean,policy?:string}} [options] */
export function* wallLeafRepairSteps(input,ctx,world,{confirm=false,policy}={}){
    if(policy!==POLICY)fail("explicit versioned wall-leaf policy required");
    if(!Number.isInteger(input.index)||input.index<1||input.index>5||!hash(input.checksum)||!hash(input.masterHash))fail("verified source identity required");
    /** @type {{state:string,writeAttempts:number,verifiedChanges:number,rows:{target:import("./wallLeafTrim.js").LeafPoint,state:string,reason?:string,reads:number}[],journalKey:string|null,complete:boolean,globalSurvey:null|{targets:number,surveyed:number,unloaded:number,tree:number,refused:number,truncated:boolean,complete:boolean}}} */
    const view={state:"preview",writeAttempts:0,verifiedChanges:0,rows:[],journalKey:null,complete:false,globalSurvey:null};
    try{
        const keys=world.getDynamicPropertyIds();if(!Array.isArray(keys)||keys.length>WALL_LEAF_REPAIR_LIMITS.allKeys)fail("journal key census unreadable or over budget");
        const prefix=`${WALL_LEAF_STATE_PREFIX}v1:d${input.index}:`,journalKeys=keys.filter(k=>k.startsWith(prefix));
        const suspicious=keys.filter(k=>k.startsWith(WALL_LEAF_STATE_PREFIX)&&!/^civ:wall_leaf_trim:v1:d[1-5]:[a-f0-9]{8}$/.test(k));
        if(suspicious.length||journalKeys.length>WALL_LEAF_REPAIR_LIMITS.journalsPerDistrict)fail("unknown or over-budget leaf receipt; preserve every journal");
        const allReceipts=keys.filter(k=>k.startsWith(WALL_LEAF_STATE_PREFIX));
        if(allReceipts.length>80)fail("global retained leaf receipt capacity reached");
        const expectedReceipts=new Map(allReceipts.map(k=>[k,world.getDynamicProperty(k)]));
        const fresh=ctx.sourcesCurrent;
        ctx={...ctx,sourcesCurrent(){try{
            const current=world.getDynamicPropertyIds();if(!Array.isArray(current)||current.length>WALL_LEAF_REPAIR_LIMITS.allKeys)return false;
            const leafKeys=current.filter(k=>k.startsWith(WALL_LEAF_STATE_PREFIX));
            return fresh()===true&&leafKeys.length===expectedReceipts.size&&leafKeys.every(k=>expectedReceipts.has(k)&&world.getDynamicProperty(k)===expectedReceipts.get(k));
        }catch(_error){return false;}}};
        /** @param {string} journalKey @returns {import("./wallLeafTrim.js").LeafStore} */
        const storeFor=journalKey=>({load:()=>world.getDynamicProperty(journalKey),save:raw=>{
            world.setDynamicProperty(journalKey,raw);
            if(world.getDynamicProperty(journalKey)===raw)expectedReceipts.set(journalKey,raw);
        }});
        const expectedSourceIds=JSON.stringify(input.sources.map(s=>({index:s.record.districtIndex,checksum:s.record.checksum})).sort((a,b)=>a.index-b.index));
        const receipts=journalKeys.map(k=>{const receipt=readLeafTrimReceipt(world.getDynamicProperty(k));if(receipt.index!==input.index||receipt.checksum!==input.checksum||receipt.masterHash!==input.masterHash||receipt.dimension!==input.dimension||JSON.stringify(receipt.sources)!==expectedSourceIds||k!==prefix+receipt.planId)fail("leaf receipt source/key differs; preserve it");return{key:k,receipt};});
        const pending=receipts.filter(r=>!r.receipt.complete);if(pending.length>1)fail("multiple unfinished leaf batches; no automatic recovery permission");
        /** @type {import("./wallLeafTrim.js").LeafPlan} */ let plan;
        /** @type {import("./wallLeafTrim.js").LeafStore} */ let io;
        if(pending.length){
            view.journalKey=pending[0].key;io=storeFor(view.journalKey);
            plan=yield* guarded(resumeLeafTrimSteps({...input,candidates:[]},ctx,io,{}, {policy}),ctx);
        }else{
            const record=input.sources.find(s=>s.record.districtIndex===input.index)?.record;
            const survey=yield* guarded(previewWallLeavesSteps({record,records:input.sources.map(s=>s.record),read:ctx.read,isProtected:ctx.isProtected,cancelled:ctx.cancelled}),ctx);
            view.globalSurvey={targets:survey.targets,surveyed:survey.surveyed,unloaded:survey.unloaded,tree:survey.tree,refused:survey.refused,truncated:survey.truncated,complete:survey.complete};
            if(survey.truncated)fail("more than64 observed tree candidates; no partial capped admission");
            const candidates=survey.rows.filter((/** @type {any} */r)=>r.state==="eligible").map((/** @type {any} */r)=>r.target);
            if(!candidates.length){view.state="no eligible loaded targets";return view;}
            yield;
            plan=yield* guarded(compileLeafTrimSteps({...input,candidates}),ctx);
            if(plan.refused.length)fail("strict compiled source ownership refused candidates; no batch admitted");
            view.journalKey=prefix+plan.planId;
            if(!journalKeys.includes(view.journalKey)&&(allReceipts.length>=80||journalKeys.length>=WALL_LEAF_REPAIR_LIMITS.journalsPerDistrict))fail("retained leaf receipt capacity reached; no history discarded");
            io=storeFor(view.journalKey);
        }
        yield;
        for(const proposal of plan.proposals){
            if(ctx.sourcesCurrent()!==true)fail("fresh source guard refused before preview");
            view.rows.push(...previewLeafTrim({...plan,proposals:[proposal],refused:[]},ctx).rows);
            yield;
        }
        if(ctx.sourcesCurrent()!==true)fail("source changed after fresh batch preview");
        if(view.rows.some(r=>r.state==="refused")){view.state="held: unreadable or changed target/contact";return view;}
        if(!confirm)return view;
        yield* guarded(prepareLeafTrimSteps(plan,ctx,io,{policy}),ctx);
        /** @type {import("./wallLeafTrim.js").LeafContext} */ const committedCtx={...ctx,write:op=>{view.writeAttempts++;ctx.write(op);}};
        for(const proposal of plan.proposals){
            if(ctx.sourcesCurrent()!==true)fail("fresh source/cancellation guard refused before commit");
            const result=commitOneLeafTrim(plan,key(proposal.target),committedCtx,io,{policy});
            view.verifiedChanges+=result.changed;yield;
        }
        if(ctx.sourcesCurrent()!==true)fail("fresh source/cancellation guard refused after commit");
        view.complete=readLeafTrimReceipt(io.load()).complete;view.state=view.complete?"batch complete":"pending";return view;
    }catch(error){view.state=ctx.cancelled?.()?"cancelled: receipt retained":"held: "+String(error instanceof Error?error.message:error);return view;}
}

/** Native adapter: keeps the exact Block handle from the final read. The writer
 * performs NO extra getBlock after the core's last-read protection/source barrier.
 * Permutations must be pre-resolved by the command before any commit slice. */
/** @param {import("@minecraft/server").Dimension} dimension @param {Map<string,import("@minecraft/server").BlockPermutation>} permutations */
export function createWallLeafBlockAdapter(dimension,permutations){
    /** @type {Map<string,import("@minecraft/server").Block>} */ const handles=new Map();
    return{/** @param {import("./wallLeafTrim.js").LeafPoint} p */ read(/** @type {import("./wallLeafTrim.js").LeafPoint} */p){const block=dimension.getBlock(p);if(!block)return undefined;
            const states=block.permutation.getAllStates();handles.set(key(p),block);
            if(handles.size>1728){const oldest=handles.keys().next();if(!oldest.done)handles.delete(oldest.value);}
            return{isValid:block.isValid===true,typeId:block.typeId,states};},
        /** @param {import("./wallLeafTrim.js").LeafOp} op */ write(op){const block=handles.get(key(op)),permutation=permutations.get(op.id);if(!block||!permutation)fail("final native handle/permutation unavailable");block.setPermutation(permutation);}};
}
