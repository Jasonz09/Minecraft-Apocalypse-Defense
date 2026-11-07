import { BLUEPRINTS2 } from "../structures/blueprints2.js";
import { farmFrontageFixturesSteps, siteOpsFor, SITE_STAGES } from "./districtplan.js";
import { lanternAnchor } from "./interiorlights.js";
import { fnv1a, utf8Length } from "./planstore.js";
import { newOps } from "./regions.js";
import { pace } from "./siteprofile.js";

export const FARM_LIGHT_STATE_PREFIX="civ:farm_lights:";
export const FARM_LIGHT_MAX_BYTES=30000;
export const FARM_LIGHT_MAX_FARMS=128;
/** @typedef {{farmId:string,planId:string,phase:"placing"|"settling"|"removing"|"done",seenTick:number|null}} FarmLightingEntry */
/** @typedef {{v:1,index:number,checksum:string,dimension:string,complete:boolean,entries:FarmLightingEntry[]}} FarmLightingJournal */
const farmBlueprints=new Set(["farm_allot_v2","farm_kitchen_v2","farm_veg_v2","farm_wheat_v2","farm_irrigated_v2"]);
/** @param {any} p */
export const farmFixtureKey=p=>`${p.x},${p.y},${p.z}`;
/** @param {string} reason @returns {never} */
const refuse=reason=>{throw new Error(reason);};
/** @param {any} value @param {string[]} names */
const exactKeys=(value,names)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===[...names].sort().join(",");
/** @param {any} value */
const hash=value=>typeof value==="string"&&/^[a-f0-9]{8}$/.test(value);
/** @param {any} value */
const farmId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,96}$/.test(value);
/** @param {any} entry */
const validEntry=entry=>exactKeys(entry,["farmId","planId","phase","seenTick"])&&farmId(entry.farmId)&&hash(entry.planId)&&["placing","settling","removing","done"].includes(entry.phase)&&(entry.phase==="settling"?(Number.isSafeInteger(entry.seenTick)&&entry.seenTick>=0):entry.seenTick===null);
/** @param {any} op */
const lamp=op=>op.id==="minecraft:lantern"?{...op,states:{hanging:false,...op.states}}:op;
// Runtime-only evidence, deliberately outside the canonical proposal fingerprint so saved
// migration receipts remain reproducible. A cloned/untrusted proposal receives no allowance.
/** @type {WeakMap<object,Map<string,{op:any,owner:string}|null>>} */
const contactProvenance=new WeakMap();
/** @type {WeakMap<object,Map<string,string>>} */
const contactSnapshots=new WeakMap();
const preservedGroundPlants=new Set(["minecraft:short_grass","minecraft:fern"]);
// Exact Bedrock crop IDs used by palette/palette2; no farmland or other plant states.
const growingCropIds=new Set(["minecraft:wheat","minecraft:carrots","minecraft:potatoes","minecraft:beetroot"]);
/** Preserve every non-growth state and reject extra/missing keys; growth alone may vary.
 * @param {any} block @param {any} expected */
function growingCropContactMatches(block,expected){
    const states=block.states,planned=expected.states;
    if(block.typeId!==expected.id||!growingCropIds.has(expected.id)||!states||!planned
        ||typeof states!=="object"||Array.isArray(states)||typeof planned!=="object"||Array.isArray(planned)
        ||!Number.isInteger(states.growth)||states.growth<0||states.growth>7
        ||!Number.isInteger(planned.growth)||planned.growth<0||planned.growth>7)return false;
    const keys=Object.keys(planned);
    return keys.length===Object.keys(states).length&&keys.every(k=>Object.hasOwn(states,k)&&(k==="growth"||states[k]===planned[k]));
}
/** @param {any} value */
function freeze(value){if(value&&typeof value==="object"){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
/** Expected planned states only; native unrelated connection states are not invented.
 * @param {any} block @param {any} op */
export const farmBlockMatches=(block,op)=>block?.typeId===op.id&&Object.entries(op.states??{}).every(([k,v])=>block.states?.[k]===v);

/** @param {unknown} raw @returns {{status:"absent"|"ok"|"refused",journal:FarmLightingJournal|null,reason:string|null}} */
export function decodeFarmLightingJournal(raw){
    if(raw===undefined)return{status:"absent",journal:null,reason:null};
    try {
        if(typeof raw!=="string"||utf8Length(raw)>FARM_LIGHT_MAX_BYTES)refuse("farm lighting journal is not a bounded JSON string");
        const value=JSON.parse(/** @type {string} */(raw));
        if(!exactKeys(value,["v","index","checksum","dimension","complete","entries"])||value.v!==1||!Number.isInteger(value.index)||value.index<1||value.index>5||!hash(value.checksum)||value.dimension!=="minecraft:overworld"||typeof value.complete!=="boolean"||!Array.isArray(value.entries)||value.entries.length>FARM_LIGHT_MAX_FARMS)refuse("farm lighting journal version, source, dimension or fields are invalid");
        const seen=new Set();
        for(const entry of value.entries){
            if(!validEntry(entry)||seen.has(entry.farmId))refuse("farm lighting journal contains an invalid or duplicate farm");
            if(entry.phase==="settling"?(!Number.isSafeInteger(entry.seenTick)||entry.seenTick<0):entry.seenTick!==null)refuse("farm lighting stability checkpoint is invalid");
            seen.add(entry.farmId);
        }
        if(value.complete&&value.entries.some((/** @type {FarmLightingEntry} */e)=>e.phase!=="done"))refuse("completed farm lighting journal still has pending fixtures");
        return{status:"ok",journal:value,reason:null};
    }catch(error){return{status:"refused",journal:null,reason:String(error)};}
}
/** @param {FarmLightingJournal} journal */
export function encodeFarmLightingJournal(journal){const raw=JSON.stringify(journal),checked=decodeFarmLightingJournal(raw);if(checked.status!=="ok")refuse(checked.reason??"invalid farm lighting journal");return raw;}
/** @param {unknown} raw */
export function farmLightingReleaseReadiness(raw){const read=decodeFarmLightingJournal(raw);if(read.status==="absent")return{ready:true,reason:null};if(read.status!=="ok")return{ready:false,reason:read.reason};return read.journal?.complete&&read.journal.entries.every(e=>e.phase==="done")?{ready:true,reason:null}:{ready:false,reason:"farm lighting migration is unfinished; preserve its journal and resume it before release"};}

/**
 * Caller must supply the checksum-verified live record from loadSavedRunSteps.
 * Only candidate/contact coordinates are indexed, across EVERY own stage including AIR.
 * The optional reader is a focused-test seam; runtime always uses siteOpsFor.
 * @param {any} record @param {import("./regions.js").Ops} [ops] @param {string|ReadonlySet<string>} [onlyFarm]
 * @param {(record:any,stage:string,index:number)=>any[]} [reader]
 * @returns {Generator<void,{proposals:any[],refused:{farmId:string,reason:string}[],total:number},void>}
 */
export function* farmFixtureProposalsSteps(record,ops=newOps(),onlyFarm=undefined,reader=siteOpsFor){
    if(!hash(record?.checksum)||!Array.isArray(record.lots))refuse("verified farm source record is missing");
    const candidates=[],refused=[],wanted=new Set();
    for(let index=0;index<record.lots.length;index++){
        const element=record.lots[index];
        if(!String(element.kind).startsWith("building-farm_")||!farmBlueprints.has(element.blueprint)||(onlyFarm!==undefined&&(typeof onlyFarm==="string"?element.id!==onlyFarm:!onlyFarm.has(element.id))))continue;
        if(candidates.length+refused.length>=FARM_LIGHT_MAX_FARMS)refuse("farm migration exceeds its bounded journal capacity; inspect a specific farm");
        try {
            if(record.options?.farmLighting==="frontage-v1")refuse("farm already uses versioned frontage lighting; no legacy migration needed");
            if(!farmId(element.id)||!element.bbox||!Number.isSafeInteger(element.baseY)||!Number.isInteger(element.rot))refuse("saved farm geometry is invalid");
            const original=reader(record,"lots",index),draft=yield* farmFrontageFixturesSteps(BLUEPRINTS2[element.blueprint],element.rot,element.bbox.x0,element.bbox.z0,element.baseY,original,ops);
            const before=new Map(original.map(op=>[farmFixtureKey(op),op])),guards=new Map();
            for(const old of draft.remove){const anchor=before.get(farmFixtureKey({...old,y:old.y-1}));if(!anchor||!lanternAnchor(anchor))refuse("original farm corner lacks its planned fence anchor");guards.set(farmFixtureKey(anchor),anchor);}
            for(const anchor of draft.anchors)guards.set(farmFixtureKey(anchor),anchor);
            guards.set(farmFixtureKey(draft.gate),draft.gate);
            const contacts=new Map();
            for(const p of [...draft.remove,...draft.add])for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++){const q={x:p.x+dx,y:p.y+dy,z:p.z+dz};contacts.set(farmFixtureKey(q),q);}
            for(const p of [...draft.remove,...draft.add,...guards.values(),...contacts.values()])wanted.add(farmFixtureKey(p));
            candidates.push({element,index,draft,guards:[...guards.values()],contacts:[...contacts.values()]});
        }catch(error){refused.push({farmId:String(element.id),reason:String(error)});}
        yield* pace(ops,100);
    }
    const final=new Map();
    for(const stage of SITE_STAGES)for(let index=0;index<(record[stage]?.length??0);index++)for(const op of reader(record,stage,index)){
        const at=farmFixtureKey(op);if(wanted.has(at))final.set(at,{op,stage,index});yield* pace(ops,8);
    }
    const proposals=[];
    for(const c of candidates){
        try {
            const owns=(/** @type {any} */op)=>{const last=final.get(farmFixtureKey(op));if(last?.stage!=="lots"||last.index!==c.index||!farmBlockMatches({typeId:last.op.id,states:lamp(last.op).states??{}},lamp(op)))refuse("fixture/anchor final ownership was superseded at "+farmFixtureKey(op));};
            for(const source of c.draft.remove)owns(source);for(const guard of c.guards)owns(guard);
            for(const target of c.draft.add){const last=final.get(farmFixtureKey(target));if(last&&(last.stage!=="lots"||last.index!==c.index||last.op.id!=="minecraft:air"))refuse("frontage target has another final owner or non-air op at "+farmFixtureKey(target));}
            const fixtureKeys=new Set([...c.draft.remove,...c.draft.add].map(farmFixtureKey));
            const contacts=c.contacts.filter(p=>!fixtureKeys.has(farmFixtureKey(p))).map(p=>({...p,expectedId:final.get(farmFixtureKey(p))?.op.id??"minecraft:air"}));
            const body={v:1,checksum:record.checksum,farmId:c.element.id,remove:c.draft.remove.map(lamp),add:c.draft.add.map(lamp),guards:c.guards,contacts};
            const proposal=freeze(JSON.parse(JSON.stringify({...body,planId:fnv1a(JSON.stringify(body))})));
            const provenance=new Map();
            for(const contact of contacts){const last=final.get(farmFixtureKey(contact));provenance.set(farmFixtureKey(contact),last?freeze({op:JSON.parse(JSON.stringify(lamp(last.op))),owner:`${last.stage}/${last.index}`}) : null);}
            contactProvenance.set(proposal,provenance);
            proposals.push(proposal);
        }catch(error){refused.push({farmId:c.element.id,reason:String(error)});}
        yield* pace(ops,100);
    }
    return{proposals,refused,total:proposals.length+refused.length};
}

/** @param {any} proposal @param {(op:any)=>any} read @param {FarmLightingEntry|null} entry */
export function farmFixtureReadiness(proposal,read,entry=null){
    const get=(/** @type {any} */p)=>{const block=read(p);if(!block)refuse("unloaded farm fixture/contact at "+farmFixtureKey(p));return block;};
    for(const guard of proposal.guards)if(!farmBlockMatches(get(guard),guard))refuse("changed farm anchor or entrance at "+farmFixtureKey(guard));
    const provenance=contactProvenance.get(proposal),roles=new Set([...proposal.remove,...proposal.add,...proposal.guards].map(farmFixtureKey));
    let snapshots=contactSnapshots.get(proposal);if(!snapshots){snapshots=new Map();contactSnapshots.set(proposal,snapshots);}
    for(const p of proposal.contacts){
        const block=get(p),at=farmFixtureKey(p),known=provenance?.get(at);
        const detail=` at ${at}: actual ${block.typeId}, expected ${p.expectedId}, provenance ${known?`planned ${known.owner}`:provenance?.has(at)?"unplanned":"unknown"}`;
        const unplanned=provenance?.has(at)&&known===null&&p.expectedId==="minecraft:air"&&!roles.has(at);
        if(unplanned){
            const before=snapshots.get(at);
            const wasPreservedPlant=before?.startsWith("minecraft:short_grass ")||before?.startsWith("minecraft:fern ");
            const plantLabel=block.typeId==="minecraft:fern"||before?.startsWith("minecraft:fern ")?"fern":"short-grass";
            let observed=String(block.typeId);
            if(preservedGroundPlants.has(block.typeId)){
                // Short grass/fern are ground plants; unlike vines they cannot hang from a lantern.
                // Preserve it exactly and never make it a source, target or support.
                const states=block.states;
                if(!states||typeof states!=="object"||Array.isArray(states)||Object.keys(states).length>64
                    ||Object.entries(states).some(([k,v])=>k.length>128||!(typeof v==="boolean"||typeof v==="string"&&v.length<=256||typeof v==="number"&&Number.isFinite(v))))
                    refuse(`unreadable ${plantLabel} state`+detail);
                observed+=" "+JSON.stringify(Object.entries(states).sort(([a],[b])=>a.localeCompare(b)));
            }
            if(before===undefined)snapshots.set(at,observed);
            if((preservedGroundPlants.has(block.typeId)||wasPreservedPlant)&&before!==undefined&&before!==observed)
                refuse(`changed ${plantLabel} contact`+detail);
            if(preservedGroundPlants.has(block.typeId))continue;
        }
        if(block.typeId!=="minecraft:air"){
            if(block.typeId!==p.expectedId)refuse("foreign farm fixture contact"+detail);
            if(!roles.has(at)&&growingCropIds.has(block.typeId)){
                if(!known)refuse("unverified planned crop contact"+detail);
                if(!growingCropContactMatches(block,known.op))refuse("invalid planned crop contact state"+detail);
            }else if(known&&!farmBlockMatches(block,known.op))refuse("foreign farm fixture contact"+detail);
        }
    }
    const removedAllowed=entry?.phase==="removing"||entry?.phase==="done";
    for(const source of proposal.remove){const block=get(source);if(!farmBlockMatches(block,source)&&!(removedAllowed&&block.typeId==="minecraft:air"))refuse("changed original farm lantern or missing removal checkpoint at "+farmFixtureKey(source));}
    for(const target of proposal.add){const block=get(target);if(block.typeId!=="minecraft:air"&&!(entry!==null&&farmBlockMatches(block,target)))refuse("occupied farm frontage target without a matching journal at "+farmFixtureKey(target));}
}
/** @param {any} proposal @param {(op:any)=>any} read @returns {FarmLightingEntry} */
export function prepareFarmFixtureEntry(proposal,read){farmFixtureReadiness(proposal,read);return{farmId:proposal.farmId,planId:proposal.planId,phase:"placing",seenTick:null};}
/** One bounded pure decision; returns no world mutation itself.
 * @param {any} proposal @param {FarmLightingEntry} entry @param {(op:any)=>any} read @param {number} tick */
export function farmFixtureStep(proposal,entry,read,tick){
    if(!validEntry(entry)||entry.farmId!==proposal.farmId||entry.planId!==proposal.planId||!Number.isSafeInteger(tick)||tick<0)refuse("farm migration checkpoint/source mismatch");
    farmFixtureReadiness(proposal,read,entry);
    const missing=proposal.add.find((/** @type {any} */op)=>read(op)?.typeId==="minecraft:air");
    if(entry.phase==="placing"){
        if(missing)return{entry,action:{before:{...missing,id:"minecraft:air",states:{}},after:missing},done:false};
        return{entry:{...entry,phase:/** @type {const} */("settling"),seenTick:tick},action:null,done:false};
    }
    if(missing)refuse("new farm lantern is unstable or missing; original corners preserved");
    if(entry.phase==="settling"){
        if(entry.seenTick===null)refuse("farm stability tick missing");
        if(tick<entry.seenTick)return{entry:{...entry,seenTick:tick},action:null,done:false};
        if(tick-entry.seenTick<2)return{entry,action:null,done:false};
        return{entry:{...entry,phase:/** @type {const} */("removing"),seenTick:null},action:null,done:false};
    }
    const old=proposal.remove.find((/** @type {any} */op)=>read(op)?.typeId!=="minecraft:air");
    if(entry.phase==="done"&&old)refuse("completed farm journal disagrees with corner removal");
    if(old)return{entry,action:{before:old,after:{...old,id:"minecraft:air",states:{}}},done:false};
    return{entry:{...entry,phase:/** @type {const} */("done"),seenTick:null},action:null,done:true};
}

/** @param {any} status @returns {string[]} */
export function formatFarmLightingStatus(status){if(!status||status.state==="absent")return["No farm-light migration journal is saved for this district."];return[`Farm lighting: ${status.state} (district ${status.index}).`,`Farms ${status.farms??0}, ready ${status.ready??0}, changed ${status.changed??0} (${status.placed??0} placed, ${status.removed??0} removed), preserved ${status.preserved??0}, unloaded ${status.unloaded??0}, pending ${status.pending??0}.`,...(status.reason?[String(status.reason)]:[]),...(status.notes??[]).slice(0,3)];}
