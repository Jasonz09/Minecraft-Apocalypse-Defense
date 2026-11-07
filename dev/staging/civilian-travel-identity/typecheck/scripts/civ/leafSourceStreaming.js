// Staged read-only compiler orchestration. This is NOT a command or write authorization.
import {POLICY,createLeafTrimAccumulator,accumulateLeafSourceSteps,finishLeafTrimAccumulator,readLeafTrimReceipt,readLeafTrimReceiptForPlan,leafSourceManifest} from "./wallLeafTrim.js";
import {collectWallLeafCensusSteps,wallLeafCensusView,accumulateWallLeafPreviewSourceSteps,finishWallLeafPreviewSteps} from "./wallleafpreview.js";
/** @param {string} reason @returns {never} */
const fail=reason=>{throw new Error(reason);};
/** @param {any} input @param {any} deps @returns {Generator<undefined,import("./wallLeafTrim.js").LeafPlan,unknown>} */
export function* compilePendingLeafSourcesSteps(input,deps){
    if(input?.policy!==POLICY)fail("explicit existing leaf policy required");
    if(typeof deps?.sourcesCurrent!=="function"||typeof deps?.loadSourceSteps!=="function"||typeof deps?.receiptStore?.load!=="function")fail("guarded verified source loader and receipt reader required");
    const raw=deps.receiptStore.load();
    if(raw===undefined)fail("pending receipt required by staged streaming path; retain existing bounded no-pending census path");
    const receipt=readLeafTrimReceipt(raw);
    if(receipt.complete)fail("pending original receipt required; no new admission from completed history");
    if(!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>5)fail("complete expected source manifest required");
    // Detach only scalar metadata. No records or source wrappers can enter this manifest.
    const sources=input.sources.map(/** @param {any} s */s=>({record:{districtIndex:s.index,checksum:s.checksum},civ:{status:s.status,checksum:s.checksum,dimension:s.dimension},masterHash:input.masterHash}));
    const requested={index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:input.dimension,candidates:receipt.requested,sources};
    const token=createLeafTrimAccumulator(requested);
    const manifest=sources.map(/** @param {any} s */s=>({index:s.record.districtIndex,checksum:s.record.checksum})).sort(/** @param {any} a @param {any} b */(a,b)=>a.index-b.index);
    if(receipt.index!==input.index||receipt.checksum!==input.checksum||receipt.masterHash!==input.masterHash||receipt.dimension!==input.dimension||JSON.stringify(receipt.sources)!==JSON.stringify(manifest))fail("pending receipt source manifest differs; preserve it");
    function assert(){if(deps.cancelled?.()||deps.sourcesCurrent()!==true||deps.receiptStore.load()!==raw)fail("streaming source/protection/cancellation/receipt guard refused");}
    /** @template T @param {Generator<any,T,any>} generator @returns {Generator<undefined,T,unknown>} */
    function* guarded(generator){for(;;){assert();const step=generator.next();assert();if(step.done)return step.value;yield;assert();}}
    /** Each completed helper returns ONLY master JSON text. Its heavy wrapper, record,
     * arrays, iterators and generators leave scope BEFORE the next source load starts. */
    /** @param {any} entry @param {string|undefined} masterJSON */
    function* one(entry,masterJSON){
        /** @type {any} */ const loaded=yield* guarded(deps.loadSourceSteps(entry.record.districtIndex,entry.civ));
        if(!loaded?.ok||loaded.queue?.state!=="complete"||!loaded.record||!loaded.plan)fail("verified complete source load refused");
        const text=JSON.stringify(loaded.plan);if(masterJSON!==undefined&&text!==masterJSON)fail("neighbor belongs to a different master plan");
        deps.onVerifiedMaster?.(loaded.plan);assert();
        yield* guarded(accumulateLeafSourceSteps(token,{record:loaded.record,civ:entry.civ,masterHash:entry.masterHash},deps.compilerDependencies??{}));
        assert();return text;
    }
    let masterJSON;
    for(const entry of sources){assert();masterJSON=yield* one(entry,masterJSON);assert();}
    assert();const plan=finishLeafTrimAccumulator(token);readLeafTrimReceiptForPlan(raw,plan);assert();
    return plan;
}

/** Full fresh read-only census/compilation path. All existing sources are verified before a result is returned. */
/** @param {any} input @param {any} deps */
export function* compileFreshLeafSourcesSteps(input,deps){
    if(input?.policy!==POLICY)fail("explicit existing leaf policy required");
    if(typeof deps?.sourcesCurrent!=="function"||typeof deps?.journalsCurrent!=="function"||typeof deps?.loadSourceSteps!=="function"||typeof deps?.read!=="function"||typeof deps?.isProtected!=="function")fail("guarded verified source loader, journals and native readers required");
    if(!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>5)fail("complete expected source manifest required");
    const sources=input.sources.map(/** @param {any} s */s=>({record:{districtIndex:s.index,checksum:s.checksum},civ:{status:s.status,checksum:s.checksum,dimension:s.dimension},masterHash:input.masterHash}));
    const request={index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:input.dimension,candidates:[],sources};leafSourceManifest(request);
    function assert(){if(deps.cancelled?.()||deps.sourcesCurrent()!==true||deps.journalsCurrent()!==true)fail("streaming source/protection/cancellation/journal guard refused");}
    /** @template T @param {Generator<any,T,any>} generator @returns {Generator<undefined,T,unknown>} */
    function* guarded(generator){for(;;){assert();const step=generator.next();assert();if(step.done)return step.value;yield;assert();}}
    /** @type {object|undefined} */let census;
    /** @type {object|undefined} */let accumulator;
    /** @type {string|undefined} */let masterJSON;
    const selected=sources.findIndex(/** @param {any} entry */entry=>entry.record.districtIndex===input.index);
    const order=[selected,...sources.map(/** @param {any} _ @param {number} i */(_,i)=>i).filter(/** @param {number} i */i=>i!==selected)];
    /** Heavy loaded wrappers/records remain inside one helper only. */
    /** @param {number} ordinal */
    function* one(ordinal){
        const entry=sources[ordinal];
        /** @type {any} */const loaded=yield* guarded(deps.loadSourceSteps(entry.record.districtIndex,entry.civ));
        if(!loaded?.ok||loaded.queue?.state!=="complete"||!loaded.record||!loaded.plan)fail("verified complete source load refused");
        if(loaded.record.districtIndex!==entry.record.districtIndex||loaded.record.checksum!==entry.record.checksum)fail("loaded source identity differs");
        const text=JSON.stringify(loaded.plan);if(masterJSON!==undefined&&text!==masterJSON)fail("neighbor belongs to a different master plan");
        deps.onVerifiedMaster?.(loaded.plan);assert();
        if(ordinal===selected){
            census=yield* guarded(collectWallLeafCensusSteps(loaded.record,{read:deps.read,isProtected:deps.isProtected,cancelled:deps.cancelled},{...deps.compilerDependencies,sourceCount:sources.length}));
            const view=wallLeafCensusView(census);
            if(view.candidates.length)accumulator=createLeafTrimAccumulator({...request,candidates:view.candidates});
        }
        if(!census)fail("selected wall census was not initialized");
        yield* guarded(accumulateWallLeafPreviewSourceSteps(census,loaded.record,ordinal,deps.compilerDependencies??{}));
        if(accumulator)yield* guarded(accumulateLeafSourceSteps(accumulator,{record:loaded.record,civ:entry.civ,masterHash:entry.masterHash},deps.compilerDependencies??{}));
        assert();return text;
    }
    for(const ordinal of order){assert();masterJSON=yield* one(ordinal);assert();}
    if(!census)fail("selected wall census was not initialized");
    const survey=yield* guarded(finishWallLeafPreviewSteps(census));assert();
    if(survey.truncated)return{state:"held: more than64 observed tree candidates; no partial capped admission",survey,plan:null};
    const candidates=survey.rows.filter(/** @param {any} row */row=>row.state==="eligible").map(/** @param {any} row */row=>row.target);
    if(!candidates.length)return{state:"no eligible loaded targets",survey,plan:null};
    if(!accumulator)fail("wanted-cell source summary was not initialized");
    const plan=finishLeafTrimAccumulator(accumulator,{candidates});assert();
    if(plan.refused.length)fail("strict compiled source ownership refused candidates; no batch admitted");
    return{state:"preview",survey,plan};
}

// Only this module can brand a finished source compilation. The controller never
// accepts a parsed plan, partial census token or accumulator as write permission.
const PREPARED_BATCHES=new WeakMap();
/** @param {any} input */
function batchIdentity(input){
    const sources=input.sources.map(/** @param {any} s */s=>s.record?{record:{districtIndex:s.record.districtIndex,checksum:s.record.checksum},civ:{status:s.civ?.status,checksum:s.civ?.checksum,dimension:s.civ?.dimension},masterHash:s.masterHash}:{record:{districtIndex:s.index,checksum:s.checksum},civ:{status:s.status,checksum:s.checksum,dimension:s.dimension},masterHash:input.masterHash});
    const manifest=leafSourceManifest({...input,candidates:[],sources});
    return JSON.stringify({index:input.index,checksum:input.checksum,masterHash:input.masterHash,dimension:input.dimension,sources:manifest});
}
/** @param {any} value */
function freezeData(value){if(value&&typeof value==="object"){Object.freeze(value);for(const child of Object.values(value))freezeData(child);}return value;}
/** Producer API: all compilation happens under the same controller-owned fences.
 * Returned token holds small immutable data only, never loaded source objects.
 * @param {any} input @param {any} deps */
export function* prepareLeafSourceBatchSteps(input,deps){
    if(typeof deps?.sourcesCurrent!=="function"||typeof deps?.journalsCurrent!=="function")fail("controller-owned source and journal guards required");
    const identity=batchIdentity(input),raw=deps.receiptStore?.load();
    const assert=()=>{if(deps.cancelled?.()||deps.sourcesCurrent()!==true||deps.journalsCurrent()!==true||batchIdentity(input)!==identity||deps.receiptStore?.load()!==raw)fail("prepared leaf batch source/journal/cancellation binding changed");};
    assert();
    const generator=raw===undefined?compileFreshLeafSourcesSteps(input,deps):compilePendingLeafSourcesSteps(input,deps);
    let result;
    for(;;){assert();const next=generator.next();assert();if(next.done){result=next.value;break;}yield;assert();}
    const payload=raw===undefined?result:{state:"preview",survey:null,plan:result};
    assert();
    const token=Object.freeze({});
    PREPARED_BATCHES.set(token,{identity,raw,sourcesCurrent:deps.sourcesCurrent,payload:freezeData(payload)});
    return token;
}
/** One-use exact consumer. No generic plan input and no partial capability can pass.
 * @param {object} token @param {{input:any,sourcesCurrent:()=>boolean,receiptRaw:unknown}} options */
export function consumePreparedLeafBatch(token,{input,sourcesCurrent,receiptRaw}){
    const state=PREPARED_BATCHES.get(token);PREPARED_BATCHES.delete(token);
    if(!state||state.sourcesCurrent!==sourcesCurrent||state.identity!==batchIdentity(input)||state.raw!==receiptRaw||sourcesCurrent()!==true)fail("foreign/stale/already-consumed prepared leaf batch; no write permission");
    return state.payload;
}
