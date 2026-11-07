import {savedDestinationsSteps,parseDestinationsCommand,formatDestinations} from "../people/destinations.js";

/** Read-only, on-demand compilation. No timer, cached admission, actor queries,
 * steering, property writes, block reads or chunk holds are created here.
 * @param {{readKingdom:()=>any,loadSaved:(civ:any,index:number)=>Generator<any,any,any>,runJob:(token:any,steps:Generator<any,any,any>)=>Promise<any>,reserveJob:(kind:string)=>any,finishJob:(token:any)=>void}} deps */
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
        const parsed=parseDestinationsCommand(text);if(parsed.error)return [parsed.error];
        let token;
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
            return formatDestinations(result,/** @type {number} */(parsed.page));
        }catch(error){return [`Destination preview refused: ${String(error)}. Nothing changed.`];}
        finally{if(token)deps.finishJob(token);}
    }
    return {command};
}
