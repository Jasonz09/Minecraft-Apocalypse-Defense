// Exploratory, pure and nonintegrated. No engine, clock, storage or entity imports.
// IDs are durable births, never the aggregate rank slots used by the active pack.
export const LIMITS=Object.freeze({cohorts:128,covered:32,savedBytes:24000,groupSize:1024});
const MAX=Number.MAX_SAFE_INTEGER;
const fail=message=>{throw new Error(message);};
const count=(value,label)=>{if(!Number.isSafeInteger(value)||value<0)fail(`${label} must be a nonnegative safe integer`);return value;};
const positive=(value,label)=>{count(value,label);if(value===0)fail(`${label} must be positive`);return value;};
const name=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,24}$/.test(value);
const add=(a,b,label)=>count(a+b,label);
const keys=(value,names,label)=>{
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==[...names].sort().join(","))fail(`${label} has invalid fields`);
};
const idFor=(rosterId,generation)=>`${rosterId}:cohort:${generation}`;
const same=(a,b)=>a.id===b.id&&a.generation===b.generation&&a.headcount===b.headcount;
const clone=value=>JSON.parse(JSON.stringify(value));
const order=(a,b)=>a.generation-b.generation;
// All permitted state strings are ASCII, so this is also its UTF-8 byte size.
export const savedBytes=state=>JSON.stringify(state).length;

function cohort(value,state,label){
    keys(value,["id","generation","headcount"],label);
    positive(value.generation,`${label}.generation`);positive(value.headcount,`${label}.headcount`);
    if(value.generation>=state.nextGeneration||value.id!==idFor(state.rosterId,value.generation)||value.headcount>state.groupSize)fail(`${label} birth identity or represented headcount is invalid`);
}
function orderedUnique(list,label){
    if(!Array.isArray(list))fail(`${label} must be an array`);
    for(let i=1;i<list.length;i++)if(list[i-1].generation>=list[i].generation)fail(`${label} must have unique, ascending births`);
}
/** Throws on malformed state; never changes it. */
export function validateRoster(state){
    keys(state,["v","rosterId","groupSize","soldiers","nextGeneration","nextEngagement","closedThrough","cohorts","engagement"],"roster");
    if(state.v!==1||!name(state.rosterId))fail("unsupported roster version or roster identity");
    positive(state.groupSize,"groupSize");if(state.groupSize>LIMITS.groupSize)fail("group size bound exceeded");
    count(state.soldiers,"soldiers");positive(state.nextGeneration,"nextGeneration");positive(state.nextEngagement,"nextEngagement");count(state.closedThrough,"closedThrough");
    orderedUnique(state.cohorts,"cohorts");if(state.cohorts.length>LIMITS.cohorts)fail("cohort capacity exceeded");
    let total=0;
    for(const c of state.cohorts){cohort(c,state,"cohort");total=add(total,c.headcount,"roster sum");}
    if(total!==state.soldiers)fail("aggregate soldiers disagree with the durable roster");
    if(state.engagement===null){if(state.closedThrough!==state.nextEngagement-1)fail("closed engagement watermark is inconsistent");}
    else {
        const e=state.engagement;keys(e,["sequence","covered","consumed"],"engagement");positive(e.sequence,"engagement sequence");
        if(e.sequence!==state.nextEngagement-1||state.closedThrough!==e.sequence-1)fail("active engagement watermark is inconsistent");
        orderedUnique(e.covered,"physical coverage");if(e.covered.length>LIMITS.covered)fail("physical coverage capacity exceeded");
        if(!Array.isArray(e.consumed)||e.consumed.length>LIMITS.covered||new Set(e.consumed).size!==e.consumed.length||e.consumed.some(id=>typeof id!=="string"))fail("consumed receipt set is invalid or over capacity");
        const covered=new Map();
        for(const c of e.covered){cohort(c,state,"coverage snapshot");covered.set(c.id,c);const live=state.cohorts.find(l=>l.id===c.id),consumed=e.consumed.includes(c.id);
            if(consumed&&live)fail("consumed physical death still has a live cohort");
            if(!consumed&&(!live||!same(live,c)))fail("live physical coverage no longer matches its snapshot");
        }
        for(const id of e.consumed)if(!covered.has(id))fail("consumed receipt has no covered birth");
        const sorted=e.covered.filter(c=>e.consumed.includes(c.id)).map(c=>c.id);
        if(sorted.join(",")!==e.consumed.join(","))fail("consumed receipts must use canonical birth order");
    }
    if(savedBytes(state)>LIMITS.savedBytes)fail("saved roster byte bound exceeded");
    return true;
}
const result=(state,effect)=>({ok:true,state,aggregate:state.soldiers,consumedReceipt:effect.receipt??null,effect});
function addRecruitment(state,amount){
    count(amount,"recruits");
    const needed=Math.floor(amount/state.groupSize)+(amount%state.groupSize===0?0:1);
    if(needed>LIMITS.cohorts-state.cohorts.length)fail("recruitment exceeds cohort capacity; no partial enlistment");
    if(needed>MAX-state.nextGeneration)fail("birth generation exhausted");
    let left=amount;
    for(let i=0;i<needed;i++){
        const generation=state.nextGeneration++,headcount=Math.min(left,state.groupSize);
        state.cohorts.push({id:idFor(state.rosterId,generation),generation,headcount});left-=headcount;
    }
    state.soldiers=add(state.soldiers,amount,"recruited aggregate");
}
/** Legacy aggregate migration is explicit and one-way; no inferred existing actor ownership. */
export function migrateLegacy({rosterId,soldiers,groupSize=5}={}){
    try {
        if(!name(rosterId))fail("legacy roster identity is invalid");
        positive(groupSize,"groupSize");if(groupSize>LIMITS.groupSize)fail("group size bound exceeded");count(soldiers,"legacy soldiers");
        const state={v:1,rosterId,groupSize,soldiers:0,nextGeneration:1,nextEngagement:1,closedThrough:0,cohorts:[],engagement:null};
        addRecruitment(state,soldiers);validateRoster(state);return result(state,{kind:"migrated",headcount:soldiers});
    }catch(error){return{ok:false,reason:String(error),state:null,aggregate:null,consumedReceipt:null};}
}
const current=(state,sequence)=>{
    positive(sequence,"engagement sequence");
    if(!state.engagement||state.engagement.sequence!==sequence)fail("engagement is not the explicitly active engagement");
    return state.engagement;
};

/**
 * One logical pure transaction. A caller must persist the returned whole state as
 * one authoritative commit. Rejection returns the original input reference intact.
 */
export function transact(input,command){
    try {
        validateRoster(input);const state=clone(input);let effect;
        if(command?.type==="recruit"){
            keys(command,["type","count"],"recruit command");addRecruitment(state,command.count);effect={kind:"recruited",headcount:command.count};
        }else if(command?.type==="open"){
            keys(command,["type","coveredIds"],"open command");
            if(state.engagement)fail("close and settle existing coverage before changing physical/simulated authority");
            if(!Array.isArray(command.coveredIds)||command.coveredIds.length>LIMITS.covered||new Set(command.coveredIds).size!==command.coveredIds.length)fail("physical coverage must be a bounded unique list");
            if(state.nextEngagement===MAX)fail("engagement sequence exhausted");
            const covered=command.coveredIds.map(id=>{const c=state.cohorts.find(c=>c.id===id);if(!c)fail("physical coverage names an absent cohort");return clone(c);}).sort(order);
            state.engagement={sequence:state.nextEngagement++,covered,consumed:[]};effect={kind:"opened",sequence:state.engagement.sequence};
        }else if(command?.type==="simulatedLoss"){
            keys(command,["type","sequence","scope","count"],"simulated loss command");const e=current(state,command.sequence);count(command.count,"simulated loss");
            if(command.scope!=="uncovered")fail("ambiguous simulated loss scope; physical coverage cannot be charged twice");
            const reserved=new Set(e.covered.map(c=>c.id)),eligible=state.cohorts.filter(c=>!reserved.has(c.id));
            const available=eligible.reduce((n,c)=>add(n,c.headcount,"uncovered sum"),0);
            if(command.count>available)fail("simulated loss exceeds explicitly uncovered soldiers; physical cohorts are preserved");
            let remaining=command.count;
            for(const c of eligible){const lost=Math.min(c.headcount,remaining);c.headcount-=lost;remaining-=lost;if(remaining===0)break;}
            state.cohorts=state.cohorts.filter(c=>c.headcount>0);state.soldiers-=command.count;effect={kind:"simulated-loss",headcount:command.count};
        }else if(command?.type==="physicalDeath"){
            keys(command,["type","receipt"],"physical death command");const r=command.receipt;
            keys(r,["rosterId","sequence","cohortId","generation","representedHeadcount"],"death receipt");
            positive(r.sequence,"receipt sequence");positive(r.generation,"receipt generation");positive(r.representedHeadcount,"receipt headcount");
            if(r.rosterId!==state.rosterId)fail("receipt belongs to a different roster");
            if(r.generation>=state.nextGeneration||r.representedHeadcount>state.groupSize)fail("receipt references an unissued birth or impossible represented headcount");
            if(r.cohortId!==idFor(r.rosterId,r.generation))fail("receipt birth identity mismatch");
            if(r.sequence<=state.closedThrough){effect={kind:"stale-closed-receipt",headcount:0};}
            else {
                const e=current(state,r.sequence),snapshot=e.covered.find(c=>c.id===r.cohortId&&c.generation===r.generation);
                if(!snapshot||snapshot.headcount!==r.representedHeadcount)fail("receipt does not match explicit physical coverage and represented headcount");
                if(e.consumed.includes(snapshot.id))effect={kind:"duplicate-receipt",headcount:0};
                else {
                    const live=state.cohorts.find(c=>c.id===snapshot.id);if(!live||!same(live,snapshot))fail("physical cohort snapshot changed; ambiguous loss refused");
                    state.cohorts=state.cohorts.filter(c=>c.id!==snapshot.id);state.soldiers-=snapshot.headcount;
                    e.consumed.push(snapshot.id);e.consumed=e.covered.filter(c=>e.consumed.includes(c.id)).map(c=>c.id);
                    effect={kind:"physical-loss",headcount:snapshot.headcount,receipt:{rosterId:r.rosterId,sequence:r.sequence,cohortId:r.cohortId,generation:r.generation,representedHeadcount:r.representedHeadcount}};
                }
            }
        }else if(command?.type==="close"){
            keys(command,["type","sequence","quiescent","pendingReceiptCount","alive"],"close command");const e=current(state,command.sequence);
            count(command.pendingReceiptCount,"pending receipt count");
            if(command.quiescent!==true||command.pendingReceiptCount!==0)fail("physical/simulated handoff is not quiescent with an empty receipt inbox");
            if(!Array.isArray(command.alive))fail("handoff needs exact surviving coverage attestations");
            const living=e.covered.filter(c=>!e.consumed.includes(c.id));
            if(command.alive.length!==living.length||new Set(command.alive.map(c=>c?.id)).size!==command.alive.length)fail("handoff omits or duplicates surviving coverage");
            for(const c of command.alive){cohort(c,state,"handoff survivor");if(!living.some(l=>same(l,c)))fail("handoff survivor snapshot is ambiguous");}
            state.closedThrough=e.sequence;state.engagement=null;effect={kind:"closed",sequence:e.sequence};
        }else fail("unknown military cohort transaction");
        validateRoster(state);return result(state,effect);
    }catch(error){return{ok:false,reason:String(error),state:input,aggregate:null,consumedReceipt:null};}
}
