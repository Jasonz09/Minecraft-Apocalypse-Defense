import {compileWorkRouteEndpoints,collectWorkRoadHintsSteps,previewLoadedWorkRouteSteps,formatLoadedWorkRoutePreview} from "../people/workRoutePreview.js";
import {world as runtimeWorld} from "@minecraft/server";
import {createWallLeafSourceGuard} from "../civ/wallLeafRepair.js";
import {compileRepresentativeWorkAssignment,representativeAssignmentIsCurrent} from "../people/workAssignment.js";
import {parseFrontageCommand,inspectSavedFrontage,formatFrontageInspection} from "../people/frontage.js";
import {savedDestinationsSteps,parseDestinationsCommand,formatDestinations} from "../people/destinations.js";

/** Existing formatted destination preview stays read-only and unchanged.
 * Separate opt-in work verification compiles a private source-bound assignment
 * and hands it to the SAME movement driver; no timers, births or property writes.
 * The inspect branch samples at most3 cells; ordinary preview stays block-free.
 * @param {{readKingdom:()=>any,loadSaved:(civ:any,index:number)=>Generator<any,any,any>,runJob:(token:any,steps:Generator<any,any,any>)=>Promise<any>,reserveJob:(kind:string)=>any,finishJob:(token:any)=>void,world?:any,bindWorkAssignment?:(assignment:any)=>string[],canStartWork?:()=>boolean,canPreviewRoute?:()=>boolean}} deps */
/** @param {{current:()=>boolean}} guard @param {any} player @param {string} dimension */
function detachedWorkLease(guard,player,dimension){return()=>player.isValid!==false&&player.dimension?.id===dimension&&guard.current()===true;}
/** @param {{readKingdom:()=>any,loadSaved:(civ:any,index:number)=>Generator<any,any,any>,runJob:(token:any,steps:Generator<any,any,any>)=>Promise<any>,reserveJob:(kind:string)=>any,finishJob:(token:any)=>void,world?:any,bindWorkAssignment?:(assignment:any)=>string[],canStartWork?:()=>boolean,canPreviewRoute?:()=>boolean}} deps */
export function createCivilianDestinations(deps){
    const workLeases=new WeakMap();
    const find=(/** @type {number} */ index)=>{
        const k=deps.readKingdom();
        if(!k||!Array.isArray(k.districts)||k.districts.length>32)throw new Error("saved kingdom unavailable or district bound exceeded");
        const rows=k.districts.filter((/** @type {any} */ d)=>d.id===`district-${index}`);
        if(rows.length!==1)throw new Error("saved district identity missing or duplicated");
        return rows[0].civ;
    };
    const signature=(/** @type {any} */ civ)=>JSON.stringify([civ?.status,civ?.stage,civ?.checksum,civ?.dimension,civ?.ops,civ?.opsTotal]);
    /** @param {string} text @param {any} event @returns {Promise<string[]>} */
    async function command(text,event){
        const inspecting=/^inspect(?:\s|$)/.test(text.trim());
        const parsed=inspecting?parseFrontageCommand(text):parseDestinationsCommand(text);if(parsed.error)return [parsed.error];
        /** @type {any} */ let token;
        try{
            const index=/** @type {number} */(parsed.index),player=event?.sourceEntity??event?.initiator;
            if(player?.typeId!=="minecraft:player"||player.isValid===false)throw new Error("destination preview needs a player in the saved district's dimension");
            const dimension=player.dimension?.id,civ=find(index);
            if(civ?.status!=="complete"||civ.stage!=="complete"||civ.dimension!==dimension||typeof dimension!=="string")throw new Error("destination preview needs an explicitly dimensioned, completed saved district");
            const sourceStamp=signature(civ);
            token=deps.reserveJob("civilian-destinations-preview");if(!token)throw new Error("another construction/maintenance/preview job is running");
            const saved=await deps.runJob(token,deps.loadSaved({...civ},index));
            if(token.cancelled||!saved)return ["Destination preview cancelled; nothing changed."];
            if(!saved.ok)throw new Error((saved.reasons??["saved plan could not be verified"]).slice(0,3).join("; "));
            if(saved.district!==index||saved.queue?.state!=="complete"||saved.queue?.planHash!==civ.checksum)throw new Error("destination preview requires verified completed queue provenance");
            const result=await deps.runJob(token,savedDestinationsSteps(saved.record,{index,checksum:civ.checksum}));
            if(token.cancelled||!result)return ["Destination preview cancelled; nothing changed."];
            if(player.isValid===false||player.dimension?.id!==dimension||signature(find(index))!==sourceStamp)throw new Error("destination source/player dimension changed during verification");
            if(inspecting){
                const fresh=()=>!token.cancelled&&player.isValid!==false&&player.dimension?.id===dimension&&signature(find(index))===sourceStamp;
                const view=inspectSavedFrontage(result,/** @type {{building:string}} */(parsed).building,
                    {fresh,read:point=>player.dimension.getBlock(point)});
                return formatFrontageInspection(view);
            }
            return formatDestinations(result,/** @type {{page:number}} */(parsed).page);
        }catch(error){return [`Destination preview refused: ${String(error)}. Nothing changed.`];}
        finally{if(token)deps.finishJob(token);}
    }
    /** Source capabilities are module-private and tied to an exact compiler token.
     * A parsed/copied candidate, caller boolean or checksum alone grants nothing.
     * @param {any} assignment */
    function workAssignmentCurrent(assignment){
        try{const lease=workLeases.get(assignment);return typeof lease==="function"&&lease()===true;}
        catch{return false;}
    }
    /** @param {string} text @param {any} event @returns {Promise<string[]>} */
    async function workCommand(text,event){
        if(/^route-preview(?:\s|$)/.test(text.trim()))return routePreviewCommand(text.trim().slice("route-preview".length).trim(),event);
        const parsed=/^district=([1-5]) group=(0|[1-9]\d{0,4}) home=(building-[A-Za-z0-9_-]{1,87}) farm=(building-[A-Za-z0-9_-]{1,87})$/.exec(text.trim());
        if(!parsed)return ["Use travel work district=N group=G home=BUILDING_ID farm=BUILDING_ID; explicit saved visual assignment only."];
        /** @type {any} */ let token;
        try{
            if(typeof deps.bindWorkAssignment!=="function"||typeof deps.canStartWork!=="function"||deps.canStartWork()!==true)throw new Error("people gate must be on with no active construction/maintenance/travel");
            const index=Number(parsed[1]),groupId=`district-${index}:civ:${parsed[2]}`,player=event?.sourceEntity??event?.initiator;
            const dimension=player?.dimension?.id,civ=find(index);
            if(player?.typeId!=="minecraft:player"||player.isValid===false||dimension!=="minecraft:overworld"||civ?.dimension!==dimension||civ.status!=="complete"||civ.stage!=="complete")throw new Error("completed Overworld district and player required");
            token=deps.reserveJob("civilian-saved-work-binding");if(!token)throw new Error("another construction/maintenance/preview job is running");
            const guard=createWallLeafSourceGuard(deps.world??runtimeWorld,deps.readKingdom);
            const playerCurrent=()=>player.isValid!==false&&player.dimension?.id===dimension;
            const verify=()=>{if(token?.cancelled||!playerCurrent())throw new Error("work verification cancelled/player changed");guard.assert();};
            /** Guard BEFORE/AFTER every generator step and both sides of EVERY yield.
             * @param {Generator<any,any,any>} generator */
            function* checked(generator){for(;;){verify();const next=generator.next();verify();if(next.done)return next.value;yield;verify();}}
            const saved=await deps.runJob(token,checked(deps.loadSaved({...civ},index)));verify();
            if(!saved?.ok)throw new Error((saved?.reasons??["completed source verification unavailable"]).slice(0,3).join("; "));
            if(saved.district!==index||saved.queue?.state!=="complete"||saved.queue?.planHash!==civ.checksum||saved.record?.checksum!==civ.checksum)throw new Error("completed saved queue/site provenance differs");
            const compiled=await deps.runJob(token,checked(savedDestinationsSteps(saved.record,{index,checksum:civ.checksum})));verify();
            const districts=deps.readKingdom()?.districts?.filter((/** @type {any} */ d)=>d.id===`district-${index}`);
            if(!Array.isArray(districts)||districts.length!==1)throw new Error("current district identity ambiguous");
            const assignment=compileRepresentativeWorkAssignment(compiled,{district:districts[0],groupId,homeBuilding:parsed[3],farmBuilding:parsed[4]});
            verify();if(!representativeAssignmentIsCurrent(assignment,districts[0]))throw new Error("assignment occupation changed");
            workLeases.set(assignment,detachedWorkLease(guard,player,dimension));
            // Our reservation is released before the SAME existing driver checks isBusy.
            // No await/yield occurs between release, fresh lease check and bind.
            deps.finishJob(token);token=undefined;
            if(!workAssignmentCurrent(assignment))throw new Error("raw source/player changed before driver handoff");
            return deps.bindWorkAssignment(assignment);
        }catch(error){return [`Saved visual work assignment refused: ${String(error)}. No new population or production was created.`];}
        finally{if(token)deps.finishJob(token);}
    }
    /** Reachable READ-ONLY native route preview; no actor or movement entry.
     * @param {string} text @param {any} event @returns {Promise<string[]>} */
    async function routePreviewCommand(text,event){
        const parsed=/^district=([1-5]) home=(building-[A-Za-z0-9_-]{1,87}) farm=(building-[A-Za-z0-9_-]{1,87})$/.exec(text.trim());
        if(!parsed)return ["Use travel work route-preview district=N home=BUILDING_ID farm=BUILDING_ID; no coordinates or parsed waypoints accepted."];
        /** @type {any} */ let token;
        try{
            if(typeof deps.canPreviewRoute!=="function"||deps.canPreviewRoute()!==true)throw new Error("stop the current travel trial and wait for other jobs before read-only route preview");
            const index=Number(parsed[1]),player=event?.sourceEntity??event?.initiator,dimension=player?.dimension?.id,civ=find(index);
            if(player?.typeId!=="minecraft:player"||player.isValid===false||dimension!=="minecraft:overworld"||civ?.status!=="complete"||civ.stage!=="complete"||civ.dimension!==dimension)throw new Error("completed saved Overworld district/player required");
            token=deps.reserveJob("civilian-loaded-route-preview");if(!token)throw new Error("another construction/maintenance/preview job is running");
            const guard=createWallLeafSourceGuard(deps.world??runtimeWorld,deps.readKingdom);
            const safeDistrict=()=>{const rows=deps.readKingdom()?.districts?.filter((/** @type {any} */ d)=>d.id===`district-${index}`);return Array.isArray(rows)&&rows.length===1&&rows[0].security==="secure"&&Number(rows[0].assault??0)===0;};
            const current=()=>!token?.cancelled&&player.isValid!==false&&player.dimension?.id===dimension&&safeDistrict()&&guard.current()===true;
            function verify(){if(!current())throw new Error("raw source/player/dimension/cancellation changed");}
            /** @param {Generator<any,any,any>} generator */
            function* checked(generator){for(;;){verify();const next=generator.next();verify();if(next.done)return next.value;yield;verify();}}
            let saved=await deps.runJob(token,checked(deps.loadSaved({...civ},index)));verify();
            if(!saved?.ok||saved.district!==index||saved.queue?.state!=="complete"||saved.queue?.planHash!==civ.checksum||saved.record?.checksum!==civ.checksum)throw new Error("actual selected source/queue verification failed");
            let compiled=await deps.runJob(token,checked(savedDestinationsSteps(saved.record,{index,checksum:civ.checksum})));verify();
            const masterMeta=JSON.parse(String((deps.world??runtimeWorld).getDynamicProperty("civ:plan:meta")));verify();
            const endpoints=compileWorkRouteEndpoints(compiled,{index,checksum:civ.checksum,masterHash:masterMeta.hash,homeBuilding:parsed[2],farmBuilding:parsed[3]});verify();
            const roadHints=await deps.runJob(token,checked(collectWorkRoadHintsSteps(saved.record,endpoints)));verify();
            saved=undefined;compiled=undefined; // Release heavy live record before native search/preview slices.
            const result=await deps.runJob(token,checked(previewLoadedWorkRouteSteps(endpoints,{read:p=>player.dimension.getBlock(p),current,cancelled:()=>token?.cancelled===true,roadHints})));verify();
            return formatLoadedWorkRoutePreview(result);
        }catch(error){return [`Read-only loaded route preview refused: ${String(error)}. Planner made no edits or entity changes.`];}
        finally{if(token)deps.finishJob(token);}
    }
    return {command,workCommand,workAssignmentCurrent};
}
