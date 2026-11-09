// Injected authoring-maintenance proof/receipt core for the explicit leafrepair command.
// No engine imports, whole-tree traversal, population ownership or timers here;
// the guarded controller/native adapter owns actual property and block writes.
import { isBenign, isLeaves, isPlant, isTreePart } from "../structures/terrain.js";
import { SITE_STAGES, siteOpsFor } from "./districtplan.js";
import { fnv1a, utf8Length } from "./planstore.js";


/** @typedef {{x:number,y:number,z:number}} LeafPoint */
/** @typedef {LeafPoint & {id:string,kind?:string,states?:Record<string,boolean|string|number>}} LeafOp */
/** @typedef {{typeId:string,states:Record<string,boolean|string|number>,persistent?:boolean|string|number}} LeafCell */
/** @typedef {{point:LeafPoint,historical:boolean,expected:string[]}} LeafContact */
/** @typedef {{target:LeafOp,contacts:LeafContact[]}} LeafProposal */
/** @typedef {{target:LeafPoint,reason:string}} LeafRefusal */
/** @typedef {{index:number,checksum:string}} LeafSourceId */
/** @typedef {{v:number,policy:string,index:number,checksum:string,masterHash:string,dimension:string,sources:LeafSourceId[],requested:LeafPoint[],proposals:LeafProposal[],refused:LeafRefusal[],planId:string,compileScannedOps:number}} LeafPlan */
/** @typedef {{index:number,checksum:string,masterHash:string,dimension:string,candidates:LeafPoint[],sources:{record:any,civ:any,masterHash:string}[]}} LeafInput */
/** @typedef {{state:string,snapshots:(LeafPoint & LeafCell)[],target?:LeafOp}} LeafProof */
/** @typedef {{read:(p:LeafPoint)=>({isValid:boolean,typeId:string,states?:Record<string,boolean|string|number>}|undefined),isProtected:(x:number,z:number)=>boolean,sourcesCurrent:(plan?:any)=>boolean,write:(op:LeafOp)=>void,cancelled?:()=>boolean}} LeafContext */
/** @typedef {{load:()=>unknown,save:(raw:string)=>void}} LeafStore */
/** @typedef {{target:string,desired:{id:string},before:LeafCell|null,done:boolean}} LeafEntry */
/** @typedef {{v:number,policy:string,planId:string,index:number,checksum:string,masterHash:string,dimension:string,sources:LeafSourceId[],requested:LeafPoint[],requestedDigest:string,entries:LeafEntry[],entriesDigest:string,complete:boolean}} LeafReceipt */
/** @typedef {{policy?:string}} LeafOptions */
/** @typedef {{opsFor?:typeof siteOpsFor}} LeafDependencies */

export const POLICY="wall-leaves-trim-v1";
export const LIMITS=Object.freeze({targets:64,readsPerCommit:56,compileOpsPerYield:400,journalBytes:24000,readsPerPrepareSlice:27});
const AIR=new Set(["minecraft:air","minecraft:cave_air","minecraft:void_air"]);
const MASONRY=new Set(["minecraft:stone_bricks","minecraft:mossy_stone_bricks","minecraft:cracked_stone_bricks","minecraft:cobblestone","minecraft:mossy_cobblestone","minecraft:stone","minecraft:andesite","minecraft:polished_andesite","minecraft:deepslate_bricks","minecraft:deepslate_tiles"]);
export const LEAF_TRIM_MASONRY_IDS=Object.freeze([...MASONRY]);
/** @param {any} p @returns {boolean} */
const point=p=>p&&[p.x,p.y,p.z].every(Number.isSafeInteger)&&Math.abs(p.x)<=29999980&&Math.abs(p.z)<=29999980&&p.y>=-63&&p.y<=318;
/** @param {unknown} h @returns {boolean} */
const hash=h=>typeof h==="string"&&/^[a-f0-9]{8}$/.test(h);
/** @param {LeafPoint} p @returns {string} */
export const key=p=>`${p.x},${p.y},${p.z}`;
/** @param {string} reason @returns {never} */
const fail=reason=>{throw new Error(reason);};
/** @template T @param {T} v @returns {T} */
const clone=v=>JSON.parse(JSON.stringify(v));
/** @template T @param {T} v @returns {T} */
function freeze(v){if(v&&typeof v==="object"){Object.freeze(v);for(const child of Object.values(v))freeze(child);}return v;}
/** @param {LeafPoint} p @returns {LeafPoint[]} */
function cube(p){const cells=[];for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++)cells.push({x:p.x+dx,y:p.y+dy,z:p.z+dz});return cells;}
/** @param {unknown} v @returns {string} */
const signature=v=>fnv1a(JSON.stringify(v));
/** @param {LeafOp} op @param {string} stage */
const historicalDecor=(op,stage)=>isTreePart(op.id)||isPlant(op.id)
    ||((stage==="lots"||stage==="dressing")&&!AIR.has(op.id)&&!MASONRY.has(op.id));

/** Compile ONLY supplied audit candidates; all source records must be checksum-
 * verified by loadSavedRunSteps before the maintenance controller calls this function.
 * These caller assertions are not an independent checksum verifier or live survey.
 * Scan all stages, including AIR, for final provenance and historical vetoes.
 * @param {{index:number,checksum:string,masterHash:string,dimension:string,candidates:any[],sources:{record:any,civ:any,masterHash:string}[]}} input
 * @param {{opsFor?:typeof siteOpsFor}} deps
 * @returns {Generator<undefined,LeafPlan,unknown>} */
/** @typedef {{index:number,checksum:string,masterHash:string,dimension:string,requested:LeafPoint[],candidates:LeafPoint[],sources:LeafSourceId[],wanted:Set<string>,historical:Set<string>,finals:Map<string,Map<number,{stage:string,index:number,op:LeafOp}>>,processed:Set<number>,scanned:number,work:number,active:boolean}} LeafAccumulatorState */
/** @type {WeakMap<object,LeafAccumulatorState>} */
const LEAF_ACCUMULATORS=new WeakMap();
/** Scalar manifest validation shared by batch/streaming; it grants no operation permission. */
/** @param {LeafInput} input */
export function leafSourceManifest(input){
    if(!Number.isInteger(input.index)||input.index<1||input.index>5||!hash(input.checksum)||!hash(input.masterHash)||input.dimension!=="minecraft:overworld")fail("invalid leaf-trim source identity");
    if(!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>5)fail("all verified source plans are required");
    const records=new Set(),sources=[];
    for(const {record,civ,masterHash} of input.sources) {
        if(!record||!Number.isInteger(record.districtIndex)||record.districtIndex<1||record.districtIndex>5||records.has(record.districtIndex)||!hash(record.checksum)||civ?.status!=="complete"||civ.checksum!==record.checksum||civ.dimension!==input.dimension||masterHash!==input.masterHash)fail("source plan/completion/dimension/master proof is missing or ambiguous");
        if(record.districtIndex===input.index&&record.checksum!==input.checksum)fail("active source checksum differs");
        records.add(record.districtIndex);sources.push({index:record.districtIndex,checksum:record.checksum});
    }
    if(!records.has(input.index))fail("active district source is missing");
    sources.sort((a,b)=>a.index-b.index);
    return freeze(sources);
}
/** Shared private-state compiler capability. It never retains input records or producer closures. */
/** @param {LeafInput} input */
export function createLeafTrimAccumulator(input){
    if(!Number.isInteger(input.index)||input.index<1||input.index>5||!hash(input.checksum)||!hash(input.masterHash)||input.dimension!=="minecraft:overworld")fail("invalid leaf-trim source identity");
    if(!Array.isArray(input.candidates)||input.candidates.length<1||input.candidates.length>LIMITS.targets||input.candidates.some(p=>!point(p))||new Set(input.candidates.map(key)).size!==input.candidates.length)fail("invalid or oversized leaf-trim candidate list");
    const sources=leafSourceManifest(input);
    const token=Object.freeze({});
    LEAF_ACCUMULATORS.set(token,{index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:input.dimension,
        requested:input.candidates.map(p=>({x:p.x,y:p.y,z:p.z})),candidates:clone(input.candidates),sources,
        wanted:new Set(input.candidates.flatMap(cube).map(key)),historical:new Set(),finals:new Map(),processed:new Set(),scanned:0,work:0,active:false});
    return token;
}
/** @param {object} token */
function accumulatorState(token){const state=LEAF_ACCUMULATORS.get(token);if(!state)fail("incomplete or foreign leaf summary capability");return state;}
/** Accumulate every source operation, retaining only wanted-cell history and final claims. */
/** @param {object} token @param {{record:any,civ:any,masterHash:string}} source @param {LeafDependencies} [deps] */
export function* accumulateLeafSourceSteps(token,{record,civ,masterHash},deps={}){
    const state=accumulatorState(token),expected=state.sources.find(s=>s.index===record?.districtIndex);
    if(!expected||state.processed.has(record.districtIndex)||record.checksum!==expected.checksum||civ?.status!=="complete"||civ.checksum!==record.checksum||civ.dimension!==state.dimension||masterHash!==state.masterHash)fail("source plan/completion/dimension/master proof is missing or ambiguous");
    const {wanted,historical,finals}=state,opsFor=deps.opsFor??siteOpsFor;
    if(state.active){LEAF_ACCUMULATORS.delete(token);fail("concurrent leaf source accumulation refused");}
    state.active=true;let complete=false;
    try{for(const stage of SITE_STAGES){
        if(!Array.isArray(record[stage]))fail("verified source is missing a stage");
        for(let index=0;index<record[stage].length;index++)for(const op of opsFor(record,stage,index)){
            state.scanned++;if(++state.work>=LIMITS.compileOpsPerYield){state.work=0;yield;}
            if(!point(op))fail("source contains invalid coordinates");
            const at=key(op);if(!wanted.has(at))continue;
            if(historicalDecor(op,stage))historical.add(at);
            const byDistrict=finals.get(at)??new Map();
            byDistrict.set(record.districtIndex,{stage,index,op:clone(op)});finals.set(at,byDistrict);
        }
    }
    if(record.checksum!==expected.checksum||record.districtIndex!==expected.index||civ?.status!=="complete"||civ.checksum!==expected.checksum||civ.dimension!==state.dimension||masterHash!==state.masterHash)fail("source identity changed during accumulation");
    state.processed.add(record.districtIndex);complete=true;
    }finally{state.active=false;if(!complete)LEAF_ACCUMULATORS.delete(token);}
}
/** Finalization requires the complete exact source manifest, never a partial summary. */
/** @param {object} token @param {{candidates?:LeafPoint[]}} [options] @returns {LeafPlan} */
export function finishLeafTrimAccumulator(token,{candidates}={}){
    const state=accumulatorState(token);
    if(state.active||state.processed.size!==state.sources.length||state.sources.some(s=>!state.processed.has(s.index)))fail("all verified source plans are required before finalization");
    let selected=state.candidates;
    if(candidates!==undefined){
        if(!Array.isArray(candidates)||!candidates.length||candidates.length>LIMITS.targets||candidates.some(p=>!point(p)))fail("invalid summary candidate subset");
        const keys=new Set(candidates.map(key));if(keys.size!==candidates.length||candidates.some(p=>!state.wanted.has(key(p))||!state.candidates.some(c=>key(c)===key(p))))fail("summary subset contains an unscanned target");
        selected=state.candidates.filter(p=>keys.has(key(p)));
    }
    const {historical,finals,sources}=state,input={index:state.index,checksum:state.checksum,masterHash:state.masterHash,dimension:state.dimension,candidates:selected};
    const proposals=[],refused=[];
    for(const candidate of input.candidates) {
        const own=finals.get(key(candidate))?.get(input.index);
        const reason=!own||own.stage!=="walls"||own.op.kind!=="wall"||!MASONRY.has(own.op.id)||Object.keys(own.op.states??{}).length?"candidate is not the exact final stateless solid masonry wall target":historical.has(key(candidate))?"candidate has historical planned vegetation/decor ownership":null;
        const conflicting=[...(finals.get(key(candidate))??new Map()).entries()].some(([district,last])=>district!==input.index
            &&(last.stage!=="walls"||last.op.kind!=="wall"||last.op.id!==own?.op.id||Object.keys(last.op.states??{}).length));
        if(reason||conflicting){refused.push({target:clone(candidate),reason:reason??"another district has a conflicting final target claim"});continue;}
        if(!own)fail("eligible candidate has no final source claim");
        const contacts=cube(candidate).map(p=>{
            const claims=[...(finals.get(key(p))??new Map()).values()];
            const ids=claims.map(v=>v.op.id);
            const consistent=claims.length>0&&claims.every(v=>MASONRY.has(v.op.id)&&Object.keys(v.op.states??{}).length===0&&v.op.id===ids[0]);
            return{point:p,historical:historical.has(key(p)),expected:consistent?[ids[0]]:[]};
        });
        proposals.push({target:clone(own.op),contacts});
    }
    const body={v:1,policy:POLICY,index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:input.dimension,sources,requested:input.candidates.map(p=>({x:p.x,y:p.y,z:p.z})),proposals,refused};
    const result=freeze({...body,planId:signature(body),compileScannedOps:state.scanned});LEAF_ACCUMULATORS.delete(token);return result;
}
/** Preserve the public batch API through the same summary/assembly implementation. */
/** @param {LeafInput} input @param {LeafDependencies} [deps] @returns {Generator<undefined,LeafPlan,unknown>} */
export function* compileLeafTrimSteps(input,deps={}){
    const token=createLeafTrimAccumulator(input);
    for(const source of input.sources)yield* accumulateLeafSourceSteps(token,source,deps);
    return finishLeafTrimAccumulator(token);
}

/** @param {LeafInput} input @param {LeafDependencies} [deps] @returns {LeafPlan} */
export function compileLeafTrim(input,deps){const g=compileLeafTrimSteps(input,deps);for(;;){const next=g.next();if(next.done)return next.value;}}

/** @param {LeafContext} ctx @param {LeafPoint} p @param {{reads:number}} counter @returns {LeafCell} */
function readCell(ctx,p,counter) {
    if(++counter.reads>LIMITS.readsPerCommit)fail("leaf-trim block-read budget exceeded");
    let b;try{b=ctx.read(p);}catch(_error){fail("unreadable local cell at "+key(p));}
    if(!b||b.isValid!==true||typeof b.typeId!=="string")fail("unloaded or invalid local cell at "+key(p));
    const states=b.states??{};
    if(!states||typeof states!=="object"||Array.isArray(states)||Object.keys(states).length>64
        ||Object.entries(states).some(([k,v])=>k.length>128||!(typeof v==="boolean"||typeof v==="string"&&v.length<=256||typeof v==="number"&&Number.isFinite(v))))fail("unreadable bounded block states at "+key(p));
    const ordered=Object.fromEntries(Object.entries(states).sort(([a],[b])=>a.localeCompare(b)));
    const persistent=isLeaves(b.typeId)?ordered.persistent_bit:undefined;
    return {typeId:b.typeId,states:ordered,...(isLeaves(b.typeId)?{persistent}: {})};
}
/** @param {LeafProposal} proposal @param {LeafContext} ctx @param {{reads:number}} counter @returns {LeafProof} */
function checkProof(proposal,ctx,counter) {
    const snapshots=[];let target;
    for(const contact of proposal.contacts) {
        const p=contact.point;
        let protectedCell;try{protectedCell=ctx.isProtected(p.x,p.z);}catch(_error){fail("current protection is unreadable");}
        if(protectedCell!==false)fail("protected or unknown neighboring column at "+key(p));
        if(contact.historical)fail("historical planned vegetation/decor contact at "+key(p));
        const b=readCell(ctx,p,counter);snapshots.push({...p,...b});
        if(key(p)===key(proposal.target)){target=b;continue;}
        if(isLeaves(b.typeId)&&b.persistent!==false)fail("persistent or unknown-state leaf contact at "+key(p));
        // Exact planned masonry/furnishings can explain a contact only; neither
        // this rule nor isBenign grants removal permission for that neighbor.
        if(!isBenign(b.typeId)&&!contact.expected.includes(b.typeId))fail("foreign local contact at "+key(p)+": "+b.typeId);
    }
    if(!target)fail("target is missing from proof");
    if(target.typeId===proposal.target.id)return {state:"present",snapshots};
    if(!isLeaves(target.typeId)||target.persistent!==false)fail("target is not a readable nonpersistent natural leaf at "+key(proposal.target));
    return {state:"eligible",snapshots};
}

/** Read-only bounded per-candidate classification. No journal or writer exists here. */
/** @param {LeafPlan} plan @param {LeafContext} ctx */
export function previewLeafTrim(plan,ctx) {
    /** @type {{target:LeafPoint,state:string,reads:number,reason?:string}[]} */ const rows=plan.refused.map(r=>({...clone(r),state:"refused",reads:0}));
    for(const proposal of plan.proposals) {
        const counter={reads:0};
        try{rows.push({target:clone(proposal.target),state:checkProof(proposal,ctx,counter).state,reads:counter.reads});}
        catch(error){rows.push({target:clone(proposal.target),state:"refused",reason:String(error instanceof Error?error.message:error),reads:counter.reads});}
    }
    return {policy:POLICY,planId:plan.planId,rows,eligible:rows.filter(r=>r.state==="eligible").length,present:rows.filter(r=>r.state==="present").length,refused:rows.filter(r=>r.state==="refused").length};
}

const JOURNAL_VERSION=2;
const journalKeys=["v","policy","planId","index","checksum","masterHash","dimension","sources","requested","requestedDigest","entries","entriesDigest","complete"];
/** @param {any} value @param {string[]} keys */
const sameKeys=(value,keys)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===keys.slice().sort().join(",");
/** @param {LeafEntry[]} entries */
const entryIdentity=entries=>entries.map(({done,...identity})=>identity);
/** @param {LeafProof} proof */
const targetSnapshot=proof=>{const target=proof.target;if(!target)return null;const p=proof.snapshots.find(p=>key(p)===key(target));return p?{typeId:p.typeId,states:p.states,...(p.persistent===undefined?{}:{persistent:p.persistent})}:null;};
/** @param {unknown} raw @returns {LeafReceipt} */
function parseReceipt(raw){
    if(typeof raw!=="string"||utf8Length(raw)>LIMITS.journalBytes)fail("journal is absent, unreadable or oversized");
    /** @type {LeafReceipt} */ let value;try{value=JSON.parse(raw);}catch(_error){fail("journal JSON is unreadable");}
    if(!sameKeys(value,journalKeys)||value.v!==JOURNAL_VERSION||value.policy!==POLICY||!hash(value.planId)||!hash(value.checksum)||!hash(value.masterHash)
        ||!Number.isInteger(value.index)||value.index<1||value.index>5||value.dimension!=="minecraft:overworld"||typeof value.complete!=="boolean")fail("journal source/policy differs; preserve it");
    if(!Array.isArray(value.sources)||value.sources.length<1||value.sources.length>5||value.sources.some(s=>!sameKeys(s,["index","checksum"])||!Number.isInteger(s.index)||s.index<1||s.index>5||!hash(s.checksum))
        ||new Set(value.sources.map(s=>s.index)).size!==value.sources.length)fail("journal source receipts invalid");
    if(!Array.isArray(value.requested)||value.requested.length<1||value.requested.length>LIMITS.targets||value.requested.some(p=>!sameKeys(p,["x","y","z"])||!point(p))
        ||new Set(value.requested.map(key)).size!==value.requested.length||value.requestedDigest!==signature(value.requested))fail("journal admitted target digest invalid");
    if(!Array.isArray(value.entries)||value.entries.length!==value.requested.length||value.entriesDigest!==signature(entryIdentity(value.entries)))fail("journal entry digest invalid");
    for(let i=0;i<value.entries.length;i++){
        const e=value.entries[i];
        if(!sameKeys(e,["target","desired","before","done"])||e.target!==key(value.requested[i])||!sameKeys(e.desired,["id"])||!MASONRY.has(e.desired.id)||typeof e.done!=="boolean")fail("journal target binding invalid");
        const b=e.before;
        if(!b||typeof b!=="object"||!b.states||typeof b.states!=="object"||Array.isArray(b.states)||Object.keys(b.states).length>64
            ||Object.entries(b.states).some(([k,v])=>k.length>128||!(typeof v==="boolean"||typeof v==="string"&&v.length<=256||typeof v==="number"&&Number.isFinite(v))))fail("journal observed states invalid");
        if(isLeaves(b.typeId)){
            if(!sameKeys(b,["typeId","states","persistent"])||b.persistent!==false||b.states.persistent_bit!==false)fail("journal observed leaf states invalid");
        }else if(!sameKeys(b,["typeId","states"])||b.typeId!==e.desired.id||Object.keys(b.states).length)fail("journal observed target invalid");
    }
    if(value.complete&&value.entries.some(e=>!e.done))fail("completed journal still has unresolved targets");
    return value;
}
// Staged production addition: inspect immutable receipt metadata without granting
// write permission. Compilation, source binding and commit checks remain required.
/** @param {unknown} raw @returns {LeafReceipt} */
export function readLeafTrimReceipt(raw){return freeze(clone(parseReceipt(raw)));}
/** @param {unknown} raw @param {LeafPlan} plan @returns {LeafReceipt} */
function decodeJournal(raw,plan){
    const value=parseReceipt(raw);
    for(const field of /** @type {("policy"|"planId"|"index"|"checksum"|"masterHash"|"dimension")[]} */ (["policy","planId","index","checksum","masterHash","dimension"]))if(value[field]!==plan[field])fail("journal source/policy differs; preserve it");
    if(JSON.stringify(value.sources)!==JSON.stringify(plan.sources)||JSON.stringify(value.requested)!==JSON.stringify(plan.requested)
        ||plan.refused.length||value.entries.length!==plan.proposals.length)fail("journal admitted target/source set differs; preserve it");
    for(let i=0;i<value.entries.length;i++)if(value.entries[i].target!==key(plan.proposals[i].target)||value.entries[i].desired.id!==plan.proposals[i].target.id)fail("journal planned material differs; preserve it");
    return value;
}
/** Exact existing recovery binding for a fully compiled plan; no write authorization. */
/** @param {unknown} raw @param {LeafPlan} plan */
export function readLeafTrimReceiptForPlan(raw,plan){return freeze(clone(decodeJournal(raw,plan)));}
/** @param {LeafStore} io @param {unknown} expected */
function journalCAS(io,expected){if(io.load()!==expected)fail("journal changed externally; preserve both the world and receipt");}
/** @param {LeafContext} ctx @param {any} plan */
function sourceBarrier(ctx,plan){if(typeof ctx.sourcesCurrent!=="function"||ctx.sourcesCurrent(plan)!==true)fail("fresh source/master/protection guard refused");}
/** @param {LeafContext} ctx @param {LeafStore} io @param {unknown} expected @param {any} plan */
function barrier(ctx,io,expected,plan){journalCAS(io,expected);sourceBarrier(ctx,plan);journalCAS(io,expected);}
/** @param {LeafReceipt} journal @param {LeafStore} io @param {LeafPlan} plan @param {unknown} expected @param {LeafContext} ctx */
function save(journal,io,plan,expected,ctx){
    const raw=JSON.stringify(journal);decodeJournal(raw,plan);
    barrier(ctx,io,expected,plan);io.save(raw);if(io.load()!==raw)fail("journal checkpoint could not be read back");return raw;
}

/** Separate cooperative read-only admission: <=27 block reads between yields,
 * then one source/CAS-bound readback checkpoint, before ANY block mutation.
 * Never deletes an unknown/old/orphan receipt. */
/** @param {LeafPlan} plan @param {LeafContext} ctx @param {LeafStore} io @param {LeafOptions} [options] */
export function* prepareLeafTrimSteps(plan,ctx,io,{policy}={}){
    if(policy!==POLICY)fail("explicit versioned leaf-only authoring policy is required");
    const original=io.load();if(original!==undefined){decodeJournal(original,plan);barrier(ctx,io,original,plan);return original;}
    if(plan.refused.length||plan.proposals.length===0||plan.proposals.length!==plan.requested.length)fail("admission requires an exact nonempty approved target list; preserve refused targets outside the batch");
    const entries=[];
    for(const proposal of plan.proposals){
        barrier(ctx,io,original,plan);const proof=checkProof(proposal,ctx,{reads:0});proof.target=proposal.target;
        entries.push({target:key(proposal.target),desired:{id:proposal.target.id},before:targetSnapshot(proof),done:proof.state==="present"});
        barrier(ctx,io,original,plan);yield;barrier(ctx,io,original,plan);
    }
    const journal={v:JOURNAL_VERSION,policy:plan.policy,planId:plan.planId,index:plan.index,checksum:plan.checksum,masterHash:plan.masterHash,dimension:plan.dimension,
        sources:clone(plan.sources),requested:clone(plan.requested),requestedDigest:signature(plan.requested),entries,entriesDigest:signature(entryIdentity(entries)),complete:entries.every(e=>e.done)};
    return save(journal,io,plan,original,ctx);
}
/** OFFLINE-only convenience; a native adapter must drive prepareLeafTrimSteps cooperatively. */
/** @param {LeafPlan} plan @param {LeafContext} ctx @param {LeafStore} io @param {LeafOptions} [options] */
export function prepareLeafTrim(plan,ctx,io,options={}){const g=prepareLeafTrimSteps(plan,ctx,io,options);for(;;){const n=g.next();if(n.done)return n.value;}}

/** A retry hint, NEVER a write permission. Every retry reruns the entire proof. */
export class LeafUpdatePendingError extends Error {}
/** @param {any} before @param {any} current */
function onlyLeafUpdateDiffers(before,current){
    if(!before||!current||!isLeaves(before.typeId)||before.typeId!==current.typeId||before.persistent!==false||current.persistent!==false)return false;
    const a=before.states,b=current.states;
    if(!a||!b||a.persistent_bit!==false||b.persistent_bit!==false||typeof a.update_bit!=="boolean"||typeof b.update_bit!=="boolean"||a.update_bit===b.update_bit)return false;
    const keys=Object.keys(a).sort();
    return JSON.stringify(keys)===JSON.stringify(Object.keys(b).sort())&&keys.every(k=>k==="update_bit"||JSON.stringify(a[k])===JSON.stringify(b[k]));
}

/** Diagnostic only: compare already-read bounded snapshots; no native reads or recovery permission. */
/** @param {LeafPoint} target @param {any} before @param {any} current */
function leafIdentityDifference(target,before,current){
    const changes=[];
    for(const field of ["typeId","persistent"])if(JSON.stringify(before?.[field])!==JSON.stringify(current?.[field]))changes.push({field,before:before?.[field],current:current?.[field]});
    const a=before?.states??{},b=current?.states??{};
    for(const field of [...new Set([...Object.keys(a),...Object.keys(b)])].sort())if(JSON.stringify(a[field])!==JSON.stringify(b[field]))changes.push({field:"states."+field,before:a[field],current:b[field]});
    // Existing receipt/read validators bound state keys and values. First four changes are exact; omitted count is explicit.
    return `admitted leaf identity/states changed; preserve target and receipt at ${key(target)}; differing fields ${changes.length}: ${JSON.stringify(changes.slice(0,4))}${changes.length>4?`; ${changes.length-4} more omitted`:""}`;
}

/** One already-admitted candidate commit. No yield in the <=56-read proof/write
 * section; the native controller drives one such commit per cooperative slice,
 * with loaded read/protection/source proof and no chunk-loading permission. */
/** @param {LeafPlan} plan @param {string} targetKey @param {LeafContext} ctx @param {LeafStore} io @param {LeafOptions} [options] */
export function commitOneLeafTrim(plan,targetKey,ctx,io,{policy}={}){
    if(policy!==POLICY)fail("explicit versioned leaf-only authoring policy is required");
    const proposal=plan.proposals.find(p=>key(p.target)===targetKey);if(!proposal)fail("target is outside this exact trim plan");
    const raw=io.load(),journal=decodeJournal(raw,plan);barrier(ctx,io,raw,plan);
    const counter={reads:0},first=checkProof(proposal,ctx,counter),entry=journal.entries.find(e=>e.target===targetKey);
    if(!entry)fail("journal target entry missing");
    if(entry.done&&first.state!=="present")fail("completed target no longer matches its saved wall; preserve change");
    let changed=0;
    if(first.state==="eligible"){
        first.target=proposal.target;
        const currentTarget=targetSnapshot(first);
        if(JSON.stringify(currentTarget)!==JSON.stringify(entry.before)){
            const message=leafIdentityDifference(proposal.target,entry.before,currentTarget);
            if(onlyLeafUpdateDiffers(entry.before,currentTarget)){
                barrier(ctx,io,raw,plan);
                throw new LeafUpdatePendingError(message);
            }
            fail(message);
        }
        const second=checkProof(proposal,ctx,counter);
        if(second.state!==first.state||JSON.stringify(second.snapshots)!==JSON.stringify(first.snapshots))fail("local contact/leaf changed before commit");
        barrier(ctx,io,raw,plan);
        const last=readCell(ctx,proposal.target,counter);
        if(JSON.stringify(last)!==JSON.stringify(entry.before)||last.persistent!==false)fail("leaf changed at the final write barrier");
        // A final block getter can invalidate a source/protection snapshot too.
        // Recheck every local column without spending another block-read budget.
        for(const contact of proposal.contacts){
            let protectedCell;try{protectedCell=ctx.isProtected(contact.point.x,contact.point.z);}catch(_error){fail("current protection is unreadable");}
            if(protectedCell!==false)fail("protected or unknown neighboring column at final write barrier");
        }
        barrier(ctx,io,raw,plan);
        ctx.write(clone(proposal.target));changed=1;
        if(readCell(ctx,proposal.target,counter).typeId!==proposal.target.id)fail("wall write could not be verified; journal remains pending");
    }
    let receiptRaw=raw;
    if(!entry.done){entry.done=true;journal.complete=journal.entries.every(e=>e.done);receiptRaw=save(journal,io,plan,raw,ctx);}else barrier(ctx,io,raw,plan);
    return{changed,reads:counter.reads,complete:journal.complete,receiptRaw};
}

/** Recompile the ORIGINAL admitted coordinates on restart, not the latest audit's
 * remaining leaves. CAS and fresh-source guards bracket EVERY cooperative yield.
 * A changed policy/source/claim retains its journal and yields no write permission. */
/** @param {LeafInput} input @param {LeafContext} ctx @param {LeafStore} io @param {LeafDependencies} [deps] @param {LeafOptions} [options] @returns {Generator<undefined,LeafPlan,unknown>} */
export function* resumeLeafTrimSteps(input,ctx,io,deps={},{policy}={}){
    if(policy!==POLICY)fail("explicit versioned leaf-only authoring policy is required");
    const initial=io.load(),receipt=initial===undefined?null:parseReceipt(initial);
    const request=receipt?{...input,candidates:clone(receipt.requested)}:input;
    const expectedSources=()=>signature({index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:input.dimension,
        sources:input.sources.map(s=>({index:s.record?.districtIndex,checksum:s.record?.checksum,civChecksum:s.civ?.checksum,status:s.civ?.status,dimension:s.civ?.dimension,masterHash:s.masterHash}))});
    const stamp=expectedSources();
    /** @param {any} plan */ const current=plan=>{if(expectedSources()!==stamp)fail("source receipts changed across yield");barrier(ctx,io,initial,plan);};
    const compiling=compileLeafTrimSteps(request,deps);let plan;
    for(;;){current(receipt??request);const step=compiling.next();if(step.done){plan=step.value;break;}current(receipt??request);yield;current(receipt??request);}
    current(plan);
    if(receipt)decodeJournal(initial,plan);
    return plan;
}

/** Prototype batch driver, at most one admitted target write per yielded slice.
 * Caller-supplied leases/native scheduler are deliberately absent in this isolation. */
/** @param {LeafInput} input @param {LeafContext} ctx @param {LeafStore} io @param {LeafDependencies} [deps] @param {LeafOptions} [options] */
export function* runLeafTrimSteps(input,ctx,io,deps={},{policy}={}){
    if(policy!==POLICY)fail("explicit versioned leaf-only authoring policy is required");
    const sourceStamp=()=>signature({index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:input.dimension,
        sources:input.sources.map(s=>({index:s.record?.districtIndex,checksum:s.record?.checksum,civChecksum:s.civ?.checksum,status:s.civ?.status,dimension:s.civ?.dimension,masterHash:s.masterHash}))});
    const stamp=sourceStamp(),inputGuard=()=>{if(sourceStamp()!==stamp)fail("source receipts changed across yield");};
    const compiling=resumeLeafTrimSteps(input,ctx,io,deps,{policy});let plan;
    for(;;){inputGuard();const n=compiling.next();if(n.done){plan=n.value;break;}yield;inputGuard();}
    const preparing=prepareLeafTrimSteps(plan,ctx,io,{policy});let expected;
    for(;;){inputGuard();const n=preparing.next();if(n.done){expected=n.value;break;}yield;inputGuard();}
    let changed=0;
    for(const proposal of plan.proposals){inputGuard();barrier(ctx,io,expected,plan);const result=commitOneLeafTrim(plan,key(proposal.target),ctx,io,{policy:POLICY});changed+=result.changed;expected=result.receiptRaw;yield;inputGuard();barrier(ctx,io,expected,plan);}
    return{changed,complete:decodeJournal(expected,plan).complete,planId:plan.planId};
}
