import assert from "node:assert/strict";
import test from "node:test";
import {LIMITS,migrateLegacy,transact,validateRoster,savedBytes} from "./cohorts.mjs";
const copy=value=>JSON.parse(JSON.stringify(value));
function freeze(value){if(value&&typeof value==="object"){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
function accepted(result){assert.equal(result.ok,true,result.reason);assert.equal(result.aggregate,result.state.soldiers);assert.equal(validateRoster(result.state),true);return result.state;}
const migrate=(soldiers=12,extra={})=>accepted(migrateLegacy({rosterId:"lineageA_d1",soldiers,...extra}));
const run=(state,command)=>accepted(transact(state,command));
const open=(state,ids=state.cohorts.map(c=>c.id))=>run(state,{type:"open",coveredIds:ids});
const death=(state,c)=>({type:"physicalDeath",receipt:{rosterId:state.rosterId,sequence:state.engagement.sequence,cohortId:c.id,generation:c.generation,representedHeadcount:c.headcount}});
const close=(state,extra={})=>({type:"close",sequence:state.engagement.sequence,quiescent:true,pendingReceiptCount:0,alive:state.engagement.covered.filter(c=>!state.engagement.consumed.includes(c.id)).map(copy),...extra});
function rejected(state,command,pattern){const frozen=freeze(copy(state)),before=JSON.stringify(frozen),result=transact(frozen,command);assert.equal(result.ok,false);assert.equal(result.state,frozen);assert.equal(JSON.stringify(frozen),before);assert.equal(result.aggregate,null);assert.equal(result.consumedReceipt,null);if(pattern)assert.match(result.reason,pattern);return result;}

test("legacy migration derives exact full/partial cohorts without a class mix or rank-slot identities",()=>{
    const state=migrate(12);assert.deepEqual(state.cohorts.map(c=>c.headcount),[5,5,2]);assert.equal(state.soldiers,12);assert.equal(state.nextGeneration,4);
    assert.deepEqual(migrate(12),state);assert.ok(state.cohorts.every(c=>c.id===`${state.rosterId}:cohort:${c.generation}`));assert.equal(state.engagement,null);
    assert.deepEqual(migrate(0).cohorts,[]);assert.deepEqual(migrate(7,{groupSize:3}).cohorts.map(c=>c.headcount),[3,3,1]);
});
test("physical death of the lowest birth removes that exact cohort without recreating it or retiring the highest",()=>{
    let state=open(migrate(12));const [low,middle,high]=state.cohorts.map(copy),command=death(state,low),before=freeze(copy(state));
    const result=transact(before,command);state=accepted(result);assert.equal(state.soldiers,7);assert.deepEqual(state.cohorts,[middle,high]);assert.equal(state.cohorts.some(c=>c.id===low.id),false);
    assert.equal(result.effect.headcount,5);assert.deepEqual(result.consumedReceipt,command.receipt);assert.deepEqual(state.engagement.consumed,[low.id]);assert.equal(before.soldiers,12);
});
test("reinforcements receive new birth IDs/generations and never refill or replace a survivor",()=>{
    let state=open(migrate(12)),old=copy(state.cohorts),low=old[0];state=run(state,death(state,low));const next=state.nextGeneration;
    state=run(state,{type:"recruit",count:6});assert.equal(state.soldiers,13);assert.deepEqual(state.cohorts.slice(0,2),old.slice(1));assert.deepEqual(state.cohorts.slice(2).map(c=>c.headcount),[5,1]);
    assert.equal(state.cohorts[2].generation,next);assert.ok(state.cohorts[2].generation>low.generation);assert.equal(state.cohorts.some(c=>c.id===low.id),false);
    const replay=transact(state,death({...state,engagement:{...state.engagement}},low));assert.equal(replay.effect.kind,"duplicate-receipt");assert.equal(replay.state.soldiers,13);
});
test("duplicate physical receipts are idempotent even with different later recruitment",()=>{
    let state=open(migrate(10)),command=death(state,state.cohorts[0]);state=run(state,command);state=run(state,{type:"recruit",count:5});const before=copy(state),again=transact(state,command);
    assert.equal(again.ok,true);assert.equal(again.effect.kind,"duplicate-receipt");assert.equal(again.consumedReceipt,null);assert.deepEqual(again.state,before);assert.equal(again.aggregate,10);
});
test("a partial physical cohort debits its exact snapshotted represented headcount",()=>{
    let state=open(migrate(12));const partial=state.cohorts[2];assert.equal(partial.headcount,2);const result=transact(state,death(state,partial));state=accepted(result);assert.equal(state.soldiers,10);assert.equal(result.effect.headcount,2);
    rejected(open(migrate(12)),{type:"physicalDeath",receipt:{...death(open(migrate(12)),partial).receipt,representedHeadcount:5}},/headcount/);
});
test("explicit mixed coverage excludes physical cohorts from deterministic simulated losses",()=>{
    let state=migrate(17);const physical=copy(state.cohorts[0]),last=copy(state.cohorts[3]);state=open(state,[physical.id]);
    state=run(state,{type:"simulatedLoss",sequence:1,scope:"uncovered",count:6});assert.deepEqual(state.cohorts[0],physical);assert.equal(state.cohorts.some(c=>c.generation===2),false);assert.equal(state.cohorts.find(c=>c.generation===3).headcount,4);assert.deepEqual(state.cohorts.at(-1),last);
    state=run(state,death(state,physical));assert.equal(state.soldiers,6);assert.deepEqual(state.cohorts.map(c=>c.headcount),[4,2]);
});
test("physical receipts and uncovered simulation losses commute without double charging",()=>{
    const initial=migrate(20),state=open(initial,[initial.cohorts[0].id,initial.cohorts[2].id]),receipt=death(state,state.cohorts[0]),loss={type:"simulatedLoss",sequence:1,scope:"uncovered",count:6};
    const a=run(run(state,receipt),loss),b=run(run(state,loss),receipt);assert.deepEqual(a,b);assert.equal(a.soldiers,9);
});
test("ambiguous simulation totals, spillover into physical coverage and uncovered deaths are refused",()=>{
    const initial=migrate(10),state=open(initial,[initial.cohorts[0].id]);
    rejected(state,{type:"simulatedLoss",sequence:1,scope:"all",count:1},/ambiguous/);
    rejected(state,{type:"simulatedLoss",sequence:1,count:1},/fields/);
    rejected(state,{type:"simulatedLoss",sequence:1,scope:"uncovered",count:6},/exceeds/);
    rejected(state,death(state,initial.cohorts[1]),/coverage/);
});
test("simulation-only engagements preserve surviving cohort identities and exact partial counts",()=>{
    const initial=migrate(12);let state=open(initial,[]);state=run(state,{type:"simulatedLoss",sequence:1,scope:"uncovered",count:7});
    assert.deepEqual(state.cohorts,[{...initial.cohorts[1],headcount:3},initial.cohorts[2]]);assert.equal(state.soldiers,5);state=run(state,close(state));assert.equal(state.engagement,null);
});
test("handoff refuses missing quiescence, pending receipts and unaccounted surviving coverage",()=>{
    const state=open(migrate(10));rejected(state,{type:"open",coveredIds:[]},/settle/);
    rejected(state,close(state,{quiescent:false}),/quiescent/);rejected(state,close(state,{pendingReceiptCount:1}),/quiescent/);rejected(state,close(state,{alive:[]}),/omits/);
    rejected(state,close(state,{alive:[state.cohorts[0],state.cohorts[0]]}),/duplicates/);
    rejected(state,close(state,{alive:[{...state.cohorts[0],headcount:4},state.cohorts[1]]}),/ambiguous/);
});
test("settled close compacts receipts atomically with a monotonic stale-engagement watermark",()=>{
    let state=open(migrate(12)),old=death(state,state.cohorts[0]);state=run(state,old);assert.equal(state.engagement.consumed.length,1);
    state=run(state,close(state));assert.equal(state.closedThrough,1);assert.equal(state.engagement,null);
    state=open(state,[]);const replay=transact(state,old);assert.equal(replay.ok,true);assert.equal(replay.effect.kind,"stale-closed-receipt");assert.deepEqual(replay.state,state);
    state=run(state,{type:"simulatedLoss",sequence:2,scope:"uncovered",count:1});assert.equal(state.soldiers,6);
});
test("foreign roster, future engagement/generation and forged generation/headcount receipts cannot debit",()=>{
    const state=open(migrate(10)),command=death(state,state.cohorts[0]);
    for(const patch of [{rosterId:"another"},{sequence:2},{generation:2},{generation:state.nextGeneration,cohortId:`${state.rosterId}:cohort:${state.nextGeneration}`},{representedHeadcount:6}])rejected(state,{type:"physicalDeath",receipt:{...command.receipt,...patch}});
});
test("recruitment capacity rejects the entire transition rather than partially enlisting",()=>{
    const full=migrate(LIMITS.cohorts*5);assert.equal(full.cohorts.length,LIMITS.cohorts);rejected(full,{type:"recruit",count:1},/capacity/);
    const tooMany=migrateLegacy({rosterId:"d1",soldiers:LIMITS.cohorts*5+1});assert.equal(tooMany.ok,false);assert.equal(tooMany.state,null);
    const many=migrate(5*(LIMITS.covered+1));rejected(many,{type:"open",coveredIds:many.cohorts.map(c=>c.id)},/bounded/);
});
test("maximum live roster plus full physical receipt ledger stays inside fixed save bounds",()=>{
    let state=migrate(LIMITS.cohorts*LIMITS.groupSize,{rosterId:"abcdefghijklmnopqrstuvwx",groupSize:LIMITS.groupSize});
    const first=Number.MAX_SAFE_INTEGER-1000;
    state.cohorts=state.cohorts.map((c,i)=>({...c,generation:first+i,id:`${state.rosterId}:cohort:${first+i}`}));state.nextGeneration=first+LIMITS.cohorts;
    assert.equal(validateRoster(state),true);const victims=state.cohorts.slice(0,LIMITS.covered).map(copy);state=open(state,victims.map(c=>c.id));
    for(const victim of victims)state=run(state,death(state,victim));state=run(state,{type:"recruit",count:LIMITS.covered*LIMITS.groupSize});
    assert.equal(state.cohorts.length,LIMITS.cohorts);assert.equal(state.engagement.covered.length,LIMITS.covered);assert.equal(state.engagement.consumed.length,LIMITS.covered);
    assert.ok(savedBytes(state)<=LIMITS.savedBytes);assert.equal(Buffer.byteLength(JSON.stringify(state),"utf8"),savedBytes(state));
    rejected(state,{type:"recruit",count:1},/capacity/);state=run(state,close(state));assert.equal(state.engagement,null);assert.ok(savedBytes(state)<LIMITS.savedBytes);
});
test("all counts and monotonic counters require safe integers and overflow fails unchanged",()=>{
    for(const bad of [-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,"5",5n])assert.equal(migrateLegacy({rosterId:"d1",soldiers:bad}).ok,false,String(bad));
    assert.equal(migrateLegacy({rosterId:"d1",soldiers:Number.MAX_SAFE_INTEGER}).ok,false,"safe but unrepresentable counts refuse capacity before allocation");
    const state=migrate(5);for(const bad of [-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])rejected(state,{type:"recruit",count:bad},/safe integer/);
    const exhausted={...state,nextGeneration:Number.MAX_SAFE_INTEGER};assert.equal(validateRoster(exhausted),true);rejected(exhausted,{type:"recruit",count:1},/generation exhausted/);
    const engagementExhausted={...state,nextEngagement:Number.MAX_SAFE_INTEGER,closedThrough:Number.MAX_SAFE_INTEGER-1};assert.equal(validateRoster(engagementExhausted),true);rejected(engagementExhausted,{type:"open",coveredIds:[]},/sequence exhausted/);
});
test("receipt and handoff counters reject fractional, negative and unsafe values without side effects",()=>{
    const state=open(migrate(10)),command=death(state,state.cohorts[0]);
    for(const value of [-1,0,.25,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]){
        rejected(state,{type:"physicalDeath",receipt:{...command.receipt,generation:value}});
        rejected(state,{type:"physicalDeath",receipt:{...command.receipt,sequence:value}});
        rejected(state,{type:"physicalDeath",receipt:{...command.receipt,representedHeadcount:value}});
    }
    for(const value of [-1,.25,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])rejected(state,close(state,{pendingReceiptCount:value}));
});
test("saved-state corruption cannot silently remigrate or mutate aggregate/coverage",()=>{
    const state=open(migrate(10));
    for(const broken of [{...state,v:2},{...state,soldiers:11},{...state,nextGeneration:1},{...state,rosterId:"../unsafe"},{...state,cohorts:[state.cohorts[0],state.cohorts[0]]},{...state,engagement:{...state.engagement,consumed:[state.cohorts[0].id]}}]){
        const before=JSON.stringify(broken),result=transact(broken,{type:"recruit",count:0});assert.equal(result.ok,false);assert.equal(JSON.stringify(broken),before);
    }
});
test("saved state round-trips and receipt replay result contains aggregate and consumption in one value",()=>{
    const original=open(migrate(12)),command=death(original,original.cohorts[1]),result=transact(original,command);assert.equal(result.ok,true);
    const restored=JSON.parse(JSON.stringify(result.state));assert.equal(validateRoster(restored),true);assert.equal(restored.soldiers,7);assert.deepEqual(restored.engagement.consumed,[command.receipt.cohortId]);
    assert.equal(transact(restored,command).effect.headcount,0);assert.ok(savedBytes(restored)<LIMITS.savedBytes);
});
test("deterministic receipt order and bounded compaction survive 300 engagement/reinforcement cycles",()=>{
    let state=migrate(10),firstReceipt;const retired=new Set(),survivor=copy(state.cohorts[1]);let largest=0;
    for(let i=0;i<300;i++){
        const victim=state.cohorts.find(c=>c.id!==survivor.id);state=open(state,[victim.id]);const command=death(state,victim);firstReceipt??=copy(command);
        state=run(state,command);retired.add(victim.id);state=run(state,close(state));state=run(state,{type:"recruit",count:5});largest=Math.max(largest,savedBytes(state));
        assert.deepEqual(state.cohorts.find(c=>c.id===survivor.id),survivor);assert.equal(state.cohorts.some(c=>retired.has(c.id)),false);assert.equal(state.soldiers,10);assert.equal(state.cohorts.length,2);assert.equal(state.engagement,null);
    }
    assert.equal(state.closedThrough,300);assert.ok(state.nextGeneration>300);assert.ok(largest<1200);assert.equal(transact(state,firstReceipt).effect.headcount,0);
});
test("different physical death arrival orders yield the same canonical saved transaction result",()=>{
    const state=open(migrate(17)),a=death(state,state.cohorts[0]),b=death(state,state.cohorts[2]);assert.deepEqual(run(run(state,a),b),run(run(state,b),a));
});
test("success and rejection are pure even with deeply frozen input and command objects",()=>{
    const state=freeze(open(migrate(12))),command=freeze(death(state,state.cohorts[2])),before=JSON.stringify(state),beforeCommand=JSON.stringify(command);
    const result=transact(state,command);assert.equal(result.ok,true);assert.equal(JSON.stringify(state),before);assert.equal(JSON.stringify(command),beforeCommand);
    rejected(state,{type:"unknown"},/unknown/);assert.equal(result.state.cohorts.length,2);
});
