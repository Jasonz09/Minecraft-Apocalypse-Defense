import {createWallLeafSourceGuard} from "../civ/wallLeafRepair.js";
import {compileWorkRouteEndpoints,collectWorkRoadHintsSteps,previewLoadedWorkRouteSteps,formatLoadedWorkRoutePreview} from "../people/workRoutePreview.js";
import {parseFrontageCommand,inspectSavedFrontage,formatFrontageInspection} from "../people/frontage.js";
import {savedDestinationsSteps,parseDestinationsCommand,formatDestinations} from "../people/destinations.js";

/** Read-only, on-demand compilation. No timer, cached admission, actor queries,
 * steering, property writes or chunk holds. Only the explicit inspect branch
 * samples at most3 native block cells; ordinary preview remains block-read-free.
 * @param {{readKingdom:()=>any,loadSaved:(civ:any,index:number)=>Generator<any,any,any>,runJob:(token:any,steps:Generator<any,any,any>)=>Promise<any>,reserveJob:(kind:string)=>any,finishJob:(token:any)=>void,world?:any,canPreviewRoute?:()=>boolean}} deps */
export function createCivilianDestinations(deps){
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
    /** @param {string} text @param {any} event @returns {Promise<string[]>} */
    async function routePreviewCommand(text,event){
        const parsed=/^district=([1-5]) home=(building-[A-Za-z0-9_-]{1,87}) farm=(building-[A-Za-z0-9_-]{1,87})$/.exec(text.trim());
        if(!parsed)return ["Use travel route-preview district=N home=BUILDING_ID farm=BUILDING_ID; no coordinates or parsed waypoints accepted."];
        /** @type {any} */ let token;
        try{
            if(typeof deps.canPreviewRoute!=="function"||deps.canPreviewRoute()!==true)throw new Error("stop the current travel trial and wait for other jobs before read-only route preview");
            const index=Number(parsed[1]),player=event?.sourceEntity??event?.initiator,dimension=player?.dimension?.id,civ=find(index);
            if(player?.typeId!=="minecraft:player"||player.isValid===false||dimension!=="minecraft:overworld"||civ?.status!=="complete"||civ.stage!=="complete"||civ.dimension!==dimension)throw new Error("completed saved Overworld district/player required");
            const sourceStamp=signature(civ);
            token=deps.reserveJob("civilian-loaded-route-preview");if(!token)throw new Error("another construction/maintenance/preview job is running");
            const guard=createWallLeafSourceGuard(deps.world,deps.readKingdom);
            const safeDistrict=()=>{const rows=deps.readKingdom()?.districts?.filter((/** @type {any} */ d)=>d.id===`district-${index}`);return Array.isArray(rows)&&rows.length===1&&rows[0].security==="secure"&&Number(rows[0].assault??0)===0;};
            const current=()=>!token?.cancelled&&player.isValid!==false&&player.dimension?.id===dimension&&signature(find(index))===sourceStamp&&safeDistrict()&&guard.current()===true;
            function verify(){if(!current())throw new Error("raw source/player/dimension/cancellation changed");}
            /** @param {Generator<any,any,any>} generator */
            function* checked(generator){for(;;){verify();const next=generator.next();verify();if(next.done)return next.value;yield;verify();}}
            verify(); // Refuse reservation-boundary source changes BEFORE even creating the loader.
            let saved=await deps.runJob(token,checked(deps.loadSaved({...civ},index)));verify();
            if(!saved?.ok||saved.district!==index||saved.queue?.state!=="complete"||saved.queue?.planHash!==civ.checksum||saved.record?.checksum!==civ.checksum)throw new Error("actual selected source/queue verification failed");
            let compiled=await deps.runJob(token,checked(savedDestinationsSteps(saved.record,{index,checksum:civ.checksum})));verify();
            const masterMeta=JSON.parse(String((deps.world).getDynamicProperty("civ:plan:meta")));verify();
            const endpoints=compileWorkRouteEndpoints(compiled,{index,checksum:civ.checksum,masterHash:masterMeta.hash,homeBuilding:parsed[2],farmBuilding:parsed[3]});verify();
            const roadHints=await deps.runJob(token,checked(collectWorkRoadHintsSteps(saved.record,endpoints)));verify();
            saved=undefined;compiled=undefined; // Release heavy live record before native search/preview slices.
            const result=await deps.runJob(token,checked(previewLoadedWorkRouteSteps(endpoints,{read:p=>player.dimension.getBlock(p),current,cancelled:()=>token?.cancelled===true,roadHints})));verify();
            return formatLoadedWorkRoutePreview(result);
        }catch(error){return [`Read-only loaded route preview refused: ${String(error)}. Planner made no edits or entity changes.`];}
        finally{if(token)deps.finishJob(token);}
    }
    return {command,routePreviewCommand};
}
