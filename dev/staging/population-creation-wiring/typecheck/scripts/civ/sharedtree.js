import { CIV_LIMITS } from "./budget.js";
import { SITE_STAGES, siteOpsFor } from "./districtplan.js";
import { isTreePart } from "../structures/terrain.js";

/** @typedef {{districtIndex:number,outline:ReadonlyArray<readonly [number,number]>,finalWalls:ReadonlyMap<string,string>}} BoundaryPlan */
/** @typedef {{plannedTrees:ReadonlySet<string>,finalBlocks:ReadonlyMap<string,readonly string[]>,boundaryPlans?:readonly BoundaryPlan[]}} SharedTreeProtection */

/** Exact integer boundary membership. Unsupported coordinates/arithmetic fail closed.
 * @param {ReadonlyArray<readonly [number,number]>} outline @param {number} x @param {number} z */
export function onExactOutline(outline,x,z) {
    if(!Array.isArray(outline)||outline.length<3||![x,z].every(Number.isSafeInteger)
        ||!outline.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isSafeInteger)))return false;
    for(let i=0;i<outline.length;i++) {
        const a=outline[i],b=outline[(i+1)%outline.length];
        if(a[0]===b[0]&&a[1]===b[1])continue;
        if(x<Math.min(a[0],b[0])||x>Math.max(a[0],b[0])||z<Math.min(a[1],b[1])||z>Math.max(a[1],b[1]))continue;
        const factors=[b[0]-a[0],z-a[1],b[1]-a[1],x-a[0]];
        const lhs=factors[0]*factors[1],rhs=factors[2]*factors[3];
        if(factors.every(Number.isSafeInteger)&&Number.isSafeInteger(lhs)&&Number.isSafeInteger(rhs)&&lhs===rhs)return true;
    }
    return false;
}

/** Compile conservative contact protection from checksum-verified neighboring records.
 * No world access or ownership inference: historical tree coordinates are a veto;
 * final non-tree ids may only explain a neighboring contact, never authorize its removal.
 * Historical trees include the whole bounded region; only final contacts use the
 * caller's exact protected outer-margin predicate, avoiding a runtime import.
 * @param {readonly any[]} records
 * @param {{x0:number,z0:number,x1:number,z1:number}} region active district's bounded region
 * @param {(x:number,z:number)=>boolean} relevant protected shared margin, excluding interiors/prototypes
 * @param {{opsFor?:typeof siteOpsFor}} [dependencies] pure test seam; production uses siteOpsFor
 * @returns {Generator<void,SharedTreeProtection,void>}
 */
export function* compileSharedTreeProtectionSteps(records,region,relevant,dependencies={}) {
    const opsFor=dependencies.opsFor ?? siteOpsFor;
    const plannedTrees=new Set();
    /** @type {Map<string,string[]>} */
    const finalBlocks=new Map();
    /** @type {BoundaryPlan[]} */
    const boundaryPlans=[];
    const margin=17;
    let work=0;
    for(const record of records) {
        /** @type {Map<string,string>} */
        const final=new Map();
        /** @type {Map<string,{id:string,stage:string,kind:string}>} */
        const boundaryFinal=new Map();
        /** @type {Map<string,boolean>} */
        const boundaryColumns=new Map();
        for(const stage of SITE_STAGES) {
            const elements=record[stage];
            if(!Array.isArray(elements))throw new Error(`Verified neighbor record has no ${stage} stage.`);
            for(let i=0;i<elements.length;i++)for(const op of opsFor(record,stage,i)) {
                if(++work>=CIV_LIMITS.maxBlocksPerSlice) {work=0;yield;}
                if(op.x<region.x0-margin||op.x>region.x1+margin||op.z<region.z0-margin||op.z>region.z1+margin)continue;
                const key=`${op.x},${op.y},${op.z}`;
                if(isTreePart(op.id))plannedTrees.add(key);
                const column=`${op.x},${op.z}`;
                let boundary=boundaryColumns.get(column);
                if(boundary===undefined) {boundary=onExactOutline(record.outline,op.x,op.z);boundaryColumns.set(column,boundary);}
                if(boundary)boundaryFinal.set(key,{id:op.id,stage,kind:String(op.kind)});
                if(!relevant(op.x,op.z))continue;
                // Air and later trees must replace earlier masonry here, too.
                final.set(key,op.id);
            }
        }
        for(const [key,id] of final) {
            if(++work>=CIV_LIMITS.maxBlocksPerSlice) {work=0;yield;}
            if(isTreePart(id)||["minecraft:air","minecraft:cave_air","minecraft:void_air"].includes(id))continue;
            const ids=finalBlocks.get(key) ?? [];
            if(!ids.includes(id))ids.push(id);
            finalBlocks.set(key,ids);
        }
        /** @type {Map<string,string>} */
        const finalWalls=new Map();
        for(const [key,op] of boundaryFinal) {
            if(++work>=CIV_LIMITS.maxBlocksPerSlice) {work=0;yield;}
            if(op.stage==="walls"&&op.kind==="wall"&&!isTreePart(op.id)
                &&!["minecraft:air","minecraft:cave_air","minecraft:void_air"].includes(op.id))finalWalls.set(key,op.id);
        }
        if(Number.isSafeInteger(record.districtIndex)&&record.districtIndex>0&&Array.isArray(record.outline))
            boundaryPlans.push({districtIndex:record.districtIndex,outline:record.outline,finalWalls});
    }
    return {plannedTrees,finalBlocks,boundaryPlans};
}
