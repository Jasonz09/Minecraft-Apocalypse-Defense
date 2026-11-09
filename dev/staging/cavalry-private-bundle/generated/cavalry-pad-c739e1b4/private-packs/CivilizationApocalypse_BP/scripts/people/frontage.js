import {destinationProofIsCurrent} from "./destinations.js";

export const FRONTAGE_LIMITS=Object.freeze({blockReads:3});
// Same conservative full-block footing family as the installed travel trial.
// This slice does not admit the separate staged flora proposal or stairs/slabs.
const FOOTING=/^minecraft:(?:grass_block|grass_path|dirt|coarse_dirt|stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|cobblestone|polished_andesite|andesite|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_planks)$/;

/** @param {string} text */
export function parseFrontageCommand(text){
    const m=/^inspect district=([1-5]) building=([A-Za-z0-9_-]{1,96})$/.exec(text.trim());
    return m?{index:Number(m[1]),building:m[2]}:{error:"Use travel destinations inspect district=1 building=BUILDING_ID from the saved destination preview."};
}
/** One synchronous loaded-point snapshot. No Block is retained across a yield,
 * and this proof authorizes no route, movement, resource credit or later write.
 * @param {any} compiled @param {string} building
 * @param {{fresh:()=>boolean,read:(point:{x:number,y:number,z:number})=>any}} ctx */
export function inspectSavedFrontage(compiled,building,ctx){
    let reads=0;
    const current=()=>{try{return destinationProofIsCurrent(compiled)&&ctx.fresh()===true&&destinationProofIsCurrent(compiled);}catch{return false;}};
    /** @param {string} state @param {string} reason @param {any} [candidate] */
    const result=(state,reason,candidate)=>Object.freeze({state,reason,building,checksum:compiled?.checksum,index:compiled?.index,
        lotId:candidate?.lotId,role:candidate?.role,point:candidate?.frontageFeet?Object.freeze({...candidate.frontageFeet}):null,
        reads,maxReads:FRONTAGE_LIMITS.blockReads,scope:"One saved frontage cell NOW; route, doorway access and future clearance unverified.",readOnly:true,worldWrites:0,entityChanges:0});
    if(!current())return result("refused","saved destination provenance is absent or stale");
    if(typeof building!=="string"||!(/^[A-Za-z0-9_-]{1,96}$/).test(building))return result("refused","invalid building identity");
    const matches=compiled.candidates.filter((/** @type {any} */ c)=>c.id===building);
    if(matches.length!==1)return result("refused","building candidate is missing or ambiguous");
    const c=matches[0],floor=c.frontageSurface,feet=c.frontageFeet;
    if(!floor||!feet||floor.kind!=="road"||!FOOTING.test(floor.id)||!Number.isSafeInteger(floor.y)||floor.y< -64||floor.y>317
        ||feet.x!==floor.x||feet.z!==floor.z||feet.y!==floor.y+1||c.checksum!==compiled.checksum||c.districtId!==`district-${compiled.index}`)
        return result("refused","exact safe planned frontage height/provenance is unresolved",c);
    const cells=[{x:floor.x,y:floor.y,z:floor.z},{...feet},{...feet,y:feet.y+1}];
    for(let i=0;i<cells.length;i++){
        if(!current())return result("refused","source, player or job changed before native read",c);
        let block,id,valid;reads++;
        try{block=ctx.read(cells[i]);valid=block?.isValid;id=block?.typeId;}catch{block=undefined;}
        // A native getter itself may invalidate metadata or the calling context.
        if(!current())return result("refused","source, player or job changed during native read",c);
        if(!block||valid!==true||typeof id!=="string")return result("unloaded",`unreadable ${i===0?"floor":i===1?"feet":"head"} at ${cells[i].x},${cells[i].y},${cells[i].z}`,c);
        if(i===0?id!==floor.id||!FOOTING.test(id):id!=="minecraft:air")
            return result("blocked",`${i===0?"floor changed or unsafe":i===1?"feet obstructed":"head obstructed"}: ${id} at ${cells[i].x},${cells[i].y},${cells[i].z}`,c);
    }
    if(!current())return result("refused","source changed before reporting point clearance",c);
    return result("verified","exact planned floor plus two readable AIR body cells",c);
}
/** @param {any} view */
export function formatFrontageInspection(view){
    return [`Saved frontage ${view.building}: ${view.state.toUpperCase()} — ${view.reason}.`,
        `District${view.index}; checksum${view.checksum}; lot${view.lotId??"unresolved"}; ${view.point?`${view.point.x},${view.point.y},${view.point.z}`:"no verified planned point"}.`,
        `${view.reads}/${view.maxReads} native block reads; 0 writes/entity changes. ${view.scope}`];
}
