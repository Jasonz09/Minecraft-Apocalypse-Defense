import { BlockPermutation, system, world } from "@minecraft/server";
import { FARM_LIGHT_STATE_PREFIX, decodeFarmLightingJournal, encodeFarmLightingJournal, farmFixtureProposalsSteps, farmFixtureReadiness, prepareFarmFixtureEntry, farmFixtureStep, farmFixtureKey, farmBlockMatches } from "../civ/farmfixtures.js";
import { newOps } from "../civ/regions.js";
import { loadSavedRunSteps, inProtectedArea, recoverConstructionHolds } from "./civBuilder.js";
import { createChunkLoader } from "./chunkLeases.js";
import { runJobAsync } from "./civScan.js";
import { activeKind, activeToken, cancelActiveJob, finishJob, isBusy, reserveJob } from "./districtBuilder.js";
export { formatFarmLightingStatus } from "../civ/farmfixtures.js";

/** Injected factory keeps fault tests on the real production controller, with no separate scheduler.
 * @param {any} [deps] */
export function createFarmLightingRevision(deps={}){
    const target=deps.world??world,clock=deps.system??system;
    const loader=deps.loader??createChunkLoader(undefined,undefined,{prefix:"civ-farm-light-",padding:0,maxGroups:1,maxUnits:1,maxChunks:9});
    const jobs=deps.jobs??{reserveJob,finishJob,isBusy,activeKind,activeToken,cancelActiveJob};
    const execute=deps.runJob??runJobAsync,loadSaved=deps.loadSavedRunSteps??loadSavedRunSteps,compile=deps.compile??farmFixtureProposalsSteps;
    const recoverHolds=deps.recoverConstructionHolds??recoverConstructionHolds;
    const nextTick=deps.nextTick??(()=>new Promise((resolve)=>clock.runTimeout(()=>resolve(undefined),1)));
    const permutation=deps.resolvePermutation??((/** @type {string} */id,/** @type {any} */states)=>BlockPermutation.resolve(id,states));
    /** @type {any} */let current;
    /** @param {number} index */
    const key=index=>`${FARM_LIGHT_STATE_PREFIX}${index}`;
    /** @param {number} index */
    const initial=index=>({state:"preparing",index,farms:0,ready:0,changed:0,placed:0,removed:0,preserved:0,unloaded:0,pending:0,reason:null,notes:/** @type {string[]} */([])});
    /** @param {number} index */
    function stored(index){try{return{raw:target.getDynamicProperty(key(index)),error:null};}catch(error){return{raw:undefined,error:String(error)};}}
    /** @param {number} index */
    function status(index){
        if(current?.options.index===index)return{...current.view,notes:[...current.view.notes]};
        const value=stored(index),read=decodeFarmLightingJournal(value.raw);
        if(value.error||read.status==="refused")return{...initial(index),state:"refused",reason:value.error??read.reason};
        if(read.status==="absent")return{...initial(index),state:"absent"};
        const journal=/** @type {NonNullable<typeof read.journal>} */(read.journal),pending=journal.entries.filter(e=>e.phase!=="done").length;
        return{...initial(index),state:journal.complete?"complete":"paused",farms:journal.entries.length,ready:journal.entries.length-pending,pending};
    }
    function recover(){if(!current)loader.recover();}
    function abort(){if(!current)return false;current.token.cancelled=true;current.lease?.release();if(jobs.activeToken()===current.token)jobs.cancelActiveJob();return true;}
    /** @param {{index:number,civ:any,dimension:any,protectedRects?:any[],getProtection?:()=>any[],say:(lines:string[])=>void,confirm?:boolean,onlyFarm?:string,onEnd?:(complete:boolean,status:any)=>void}} options */
    function start(options){
        if(current||jobs.isBusy())return{ok:false,reason:`another job (${String(jobs.activeKind())}) is running`};
        if(!Number.isInteger(options.index)||options.index<1||options.index>5||options.civ?.status!=="complete")return{ok:false,reason:"farm lighting needs a completed district from 1 through 5"};
        if(options.dimension?.id!=="minecraft:overworld"||options.civ.dimension!==options.dimension.id)return{ok:false,reason:"farm lighting needs the exact saved Overworld dimension"};
        if(typeof options.getProtection!=="function"&&!Array.isArray(options.protectedRects))return{ok:false,reason:"verified neighboring protection is required before farm lighting inspection"};
        const token=jobs.reserveJob("farm-lighting-revision");if(!token)return{ok:false,reason:"another construction job is running"};
        const state={token,options,view:initial(options.index),lease:/** @type {any} */(undefined)};current=state;
        return{ok:true,completion:run(state)};
    }
    /** @param {any} state */
    async function run(state){
        const{options,token,view}=state,confirm=options.confirm===true;
        let complete=false,lastProgress=-100000;
        /** @param {string} message */
        const say=message=>{try{options.say([message]);}catch(_error){/* chat is not permission to lose a journal */}};
        /** @param {string} message */
        const note=message=>{if(view.notes.length<4)view.notes.push(message);};
        /** @param {Generator<any,any,any>} generator @param {string} label */
        function* progress(generator,label){for(;;){if(token.cancelled)return undefined;const step=generator.next();if(step.done)return step.value;const tick=Number(clock.currentTick);if(tick-lastProgress>=400){lastProgress=tick;say(label);}yield;}}
        /** @param {any} p */
        const read=p=>{try{const block=options.dimension.getBlock(p);if(!block||block.isValid===false)return undefined;const states=block.permutation?.getAllStates?.();if(!states||typeof states!=="object")return undefined;return{typeId:String(block.typeId),states};}catch(_error){return undefined;}};
        const protection=()=>{const areas=typeof options.getProtection==="function"?options.getProtection():options.protectedRects;if(!Array.isArray(areas))throw new Error("neighbor protection became unreadable");return areas;};
        /** @param {any} proposal */
        const checkProtection=proposal=>{const areas=protection();for(const p of [...proposal.remove,...proposal.add,...proposal.guards,...proposal.contacts])if(inProtectedArea(areas,p.x,p.z))throw new Error("protected neighbor clearance at "+farmFixtureKey(p)+"; whole farm preserved");};
        try {
            say("Verifying the saved district and final farm-fixture ownership...");
            const saved=await execute(token,progress(loadSaved(options.civ,newOps(),options.index),"Still verifying the saved farm source; no blocks changed."));
            if(token.cancelled)return view;
            if(!saved?.ok)throw new Error(saved?.reasons?.join("; ")??"saved farm source could not be verified");
            if(saved.record?.checksum!==options.civ.checksum||saved.district!==options.index||saved.queue?.state!=="complete")throw new Error("farm source checksum, district or completed queue proof is missing");
            const existing=stored(options.index);if(existing.error)throw new Error(existing.error);
            const decoded=decodeFarmLightingJournal(existing.raw);if(decoded.status==="refused")throw new Error(decoded.reason??"farm journal refused");
            let journal=decoded.journal??{v:/** @type {const} */(1),index:options.index,checksum:saved.record.checksum,dimension:options.dimension.id,complete:false,entries:[]};
            if(journal.index!==options.index||journal.checksum!==saved.record.checksum||journal.dimension!==options.dimension.id)throw new Error("saved farm journal belongs to a different district/source/dimension");
            let lastRaw=existing.raw;
            const chosen=options.onlyFarm===undefined?undefined:new Set([options.onlyFarm,...journal.entries.map((/** @type {any} */e)=>e.farmId)]);
            const compiled=await execute(token,progress(compile(saved.record,newOps(),chosen),"Still indexing final farm fixtures and contacts; no fixture changes yet."));
            if(token.cancelled)return view;if(!compiled)throw new Error("farm fixture compilation did not complete");
            const byId=new Map(compiled.proposals.map((/** @type {any} */p)=>[p.farmId,p]));
            for(const entry of journal.entries)if(/** @type {any} */(byId.get(entry.farmId))?.planId!==entry.planId)throw new Error("saved farm checkpoint has missing or changed final provenance for "+entry.farmId);
            const proposals=compiled.proposals.filter((/** @type {any} */p)=>options.onlyFarm===undefined||p.farmId===options.onlyFarm);
            const refusals=compiled.refused.filter((/** @type {any} */p)=>options.onlyFarm===undefined||p.farmId===options.onlyFarm);
            view.farms=proposals.length+refusals.length;view.preserved=refusals.length;for(const failure of refusals)note(failure.farmId+": "+failure.reason);
            if(options.onlyFarm!==undefined&&view.farms===0)throw new Error("no saved crop farm matches "+options.onlyFarm);
            /** @param {any} next */
            const save=next=>{
                if(token.cancelled)throw new Error("farm lighting cancelled before journal commit");
                if(target.getDynamicProperty(key(options.index))!==lastRaw)throw new Error("farm lighting journal changed externally; remaining fixtures held");
                const raw=encodeFarmLightingJournal(next);
                if(raw===lastRaw){journal=next;view.pending=journal.entries.filter((/** @type {any} */e)=>e.phase!=="done").length;return;}
                target.setDynamicProperty(key(options.index),raw);
                if(target.getDynamicProperty(key(options.index))!==raw)throw new Error("farm lighting journal write could not be verified; no next mutation allowed");
                lastRaw=raw;journal=next;view.pending=journal.entries.filter((/** @type {any} */e)=>e.phase!=="done").length;
            };
            /** @param {any} entry */
            const update=entry=>save({...journal,complete:false,entries:[...journal.entries.filter((/** @type {any} */e)=>e.farmId!==entry.farmId),entry].sort((a,b)=>a.farmId<b.farmId?-1:a.farmId>b.farmId?1:0)});
            if(confirm){recoverHolds();loader.recover();}
            for(const proposal of proposals){
                if(token.cancelled)break;view.state="running";
                try {
                    checkProtection(proposal);
                    if(confirm){
                        const points=[...proposal.remove,...proposal.add,...proposal.guards,...proposal.contacts];
                        state.lease=loader.acquire([{dimension:options.dimension,cells:points}]);
                        let held=state.lease.status();
                        while(held.state==="loading"&&!token.cancelled){await nextTick();held=state.lease.status();const tick=Number(clock.currentTick);if(tick-lastProgress>=400){lastProgress=tick;say("Loading a bounded farm footprint for "+proposal.farmId+"...");}}
                        if(token.cancelled)break;if(held.state!=="ready")throw new Error("unloaded farm chunks: "+(held.reason??"lease failed"));
                    }
                    let entry=journal.entries.find((/** @type {any} */e)=>e.farmId===proposal.farmId)??null;
                    checkProtection(proposal);
                    farmFixtureReadiness(proposal,read,entry);view.ready++;
                    if(!confirm)continue;
                    if(!entry){entry=prepareFarmFixtureEntry(proposal,read);update(entry);}
                    else if(entry.phase==="settling"){entry={...entry,seenTick:Number(clock.currentTick)};update(entry);}
                    let resumeWait=entry.phase==="removing"?Number(clock.currentTick):null;
                    const attempted=new Set();
                    for(let steps=0;steps<40&&!token.cancelled;steps++){
                        checkProtection(proposal);
                        if(target.getDynamicProperty(key(options.index))!==lastRaw)throw new Error("farm lighting journal changed before mutation");
                        let step=farmFixtureStep(proposal,entry,read,Number(clock.currentTick));
                        if(resumeWait!==null&&Number(clock.currentTick)-resumeWait<2){await nextTick();continue;}
                        resumeWait=null;
                        if(JSON.stringify(step.entry)!==JSON.stringify(entry)){entry=step.entry;update(entry);}
                        if(step.done)break;
                        if(step.action){
                            // The final complete proof is repeated without yielding before ONE write.
                            checkProtection(proposal);
                            const fresh=farmFixtureStep(proposal,entry,read,Number(clock.currentTick));
                            if(token.cancelled)break;
                            if(!fresh.action||JSON.stringify(fresh.action)!==JSON.stringify(step.action))throw new Error("farm fixture changed during final mutation proof");
                            if(target.getDynamicProperty(key(options.index))!==lastRaw)throw new Error("farm lighting journal changed during final mutation proof");
                            const{before,after}=fresh.action,at=farmFixtureKey(after),placing=after.id!=="minecraft:air";
                            if(placing&&attempted.has(at))throw new Error("new farm lantern is unstable; old corners preserved");
                            const block=options.dimension.getBlock(after);const observed=read(before);
                            if(!block||!farmBlockMatches(observed,before))throw new Error("farm target changed immediately before write at "+at);
                            block.setPermutation(permutation(after.id,after.states??{}));view.changed++;if(placing){view.placed++;attempted.add(at);}else view.removed++;
                            if(!farmBlockMatches(read(after),after))throw new Error("farm fixture did not remain in its exact expected state at "+at);
                        }
                        await nextTick();
                    }
                    if(!token.cancelled&&entry.phase!=="done")throw new Error("farm fixture step bound reached; resumable journal preserved");
                }catch(error){const reason=String(error);if(/unload|unreadable/.test(reason))view.unloaded++;else view.preserved++;note(proposal.farmId+": "+reason);}
                finally{state.lease?.release();state.lease=undefined;}
                await nextTick();
            }
            view.pending=journal.entries.filter((/** @type {any} */e)=>e.phase!=="done").length;
            if(token.cancelled){view.state="cancelled";view.reason="Cancellation kept any unfinished farm journal for a guarded retry.";}
            else {
                if(confirm&&journal.entries.length>0)save({...journal,complete:view.pending===0});
                complete=confirm&&view.pending===0&&view.preserved===0&&view.unloaded===0;
                view.state=view.pending>0||view.preserved>0||view.unloaded>0?"paused":"complete";
                view.reason=confirm?"Only proven farm fixtures were considered; source plans, crops, fences and piles were preserved.":"Read-only preview: no blocks, saved properties or chunk holds changed.";
            }
        }catch(error){view.state=token.cancelled?"cancelled":"refused";view.reason=String(error);}
        finally {
            if(token.cancelled){view.state="cancelled";view.reason="Cancellation kept any unfinished farm journal for a guarded retry.";}
            state.lease?.release();jobs.finishJob(token);if(current===state)current=undefined;
            try{options.onEnd?.(complete&&!token.cancelled,view);}catch(_error){/* reporting cannot retain the construction slot */}
        }
        return{...view,notes:[...view.notes]};
    }
    return{start,status,abort,recover};
}
const bound=createFarmLightingRevision();
export const startFarmLightingRevision=bound.start;
export const farmLightingRevisionStatus=bound.status;
export const abortFarmLightingRevision=bound.abort;
export const recoverFarmLightingRevision=bound.recover;
