import {isLiveSite,siteOpSlices,SITE_STAGES} from "../civ/districtplan.js";
import {BLUEPRINTS2,rotateInBox,rotatedSize} from "../structures/blueprints2.js";

// Saved-plan entrance candidates only. This module has no world/entity surface.
export const DESTINATION_LIMITS=Object.freeze({elements:4096,candidates:128,scanOps:2000000,elementOps:100000,slice:256,pageSize:8,columnsPerCandidate:3});
/** Compiler-owned, session-only provenance; clones never become native-read permission.
 * @type {WeakMap<object,{record:any,stamp:string}>} */
const destinationProofs=new WeakMap();
const homes=new Set(["house_s","house_m","house_l","longhouse"]);
const farms=new Set(["farm_allot_v2","farm_kitchen_v2","farm_veg_v2","farm_wheat_v2","farm_irrigated_v2"]);
/** @param {{x:number,y:number,z:number}} p */
const key=p=>`${p.x},${p.y},${p.z}`;
/** @param {{x:number,z:number}} p */
const column=p=>`${p.x},${p.z}`;
/** @param {any} n */
const integer=n=>Number.isSafeInteger(n)&&Math.abs(n)<=30000000;
/** @param {any} p */
const point=p=>p&&integer(p.x)&&integer(p.z);
/** @param {any} value */
const clean=value=>JSON.parse(JSON.stringify(value));
/** @param {any} value */
const freeze=value=>{if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
/** @param {string} reason */
const refuse=reason=>{throw new Error(reason);};
/** @param {any} record */
const metadata=record=>JSON.stringify([record.districtIndex,record.districtId,record.checksum,...SITE_STAGES.map(s=>record[s])]);
/** @param {any} op */
const solidRoad=op=>op&&op.stage==="roads"&&op.kind==="road"&&/^minecraft:(?:dirt_path|grass_path|stone|cobblestone|mossy_cobblestone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|andesite|polished_andesite|(?:oak|spruce|birch|jungle|acacia|dark_oak)_planks)$/.test(op.id);

/** Compile exact saved entrances. Trust boundary: caller obtains record from
 * loadSavedRunSteps, whose checksum/master/site/queue proof remains mandatory.
 * Native block existence, loading and clearance are deliberately not inferred.
 * @param {any} record @param {{index:number,checksum:string}} expected
 * @returns {Generator<void,any,void>} */
export function* savedDestinationsSteps(record,expected){
    if(!isLiveSite(record))refuse("destination source has no live saved-plan generators");
    if(!Number.isInteger(expected.index)||expected.index<1||expected.index>5||!(/^[a-f0-9]{8}$/).test(expected.checksum))refuse("invalid destination source identity");
    if(record.districtIndex!==expected.index||record.districtId!==`district-${expected.index}`||record.checksum!==expected.checksum)refuse("destination source district/checksum mismatch");
    let count=0,declaredOps=0;const seen=new Set();
    for(const stage of SITE_STAGES){
        if(!Array.isArray(record[stage]))refuse("destination source stage is missing");
        for(const e of record[stage]){
            if(++count>DESTINATION_LIMITS.elements)refuse("destination element bound exceeded");
            if(typeof e.id!=="string"||e.id.length>96||seen.has(e.id))refuse("duplicate or invalid destination element identity");
            if(!Number.isSafeInteger(e.total)||e.total<0||e.total>DESTINATION_LIMITS.elementOps||declaredOps+e.total>DESTINATION_LIMITS.scanOps)refuse("destination declared op bound exceeded");
            declaredOps+=e.total;seen.add(e.id);
        }
    }
    const stamp=metadata(record),candidates=[],columns=new Set(),lotIds=new Set(),entrances=new Set();
    if(stamp.length>512000)refuse("destination source metadata bound exceeded");
    for(const e of record.lots){
        // Lots also contain foundation pads sharing the same farm blueprint/lot.
        // Only actual building descriptors own entrances and destination identity.
        if(!String(e.kind).startsWith("building-"))continue;
        const kind=String(e.kind).replace(/^building-/,""),role=homes.has(kind)?"home":farms.has(e.blueprint)?"farm":undefined;
        if(!role)continue;
        if(candidates.length>=DESTINATION_LIMITS.candidates)refuse("destination candidate bound exceeded");
        const bp=BLUEPRINTS2[e.blueprint];
        if(!bp||!/^building-/.test(e.kind)||!point(e.door)||!point(e.exit)||!point(e.frontage)||!integer(e.baseY)||e.baseY< -64||e.baseY>317
            ||!Number.isInteger(e.rot)||e.rot<0||e.rot>3||typeof e.lot!=="string"||e.lot.length>96||lotIds.has(e.lot))refuse("invalid or duplicate saved destination lot metadata");
        lotIds.add(e.lot);
        const entrance=bp.entrances[0],bbox=e.bbox;
        if(!entrance||!bbox||!point({x:bbox.x0,z:bbox.z0})||!point({x:bbox.x1,z:bbox.z1}))refuse("destination has no exact saved entrance geometry");
        const {w,d}=rotatedSize(bp,e.rot),[dx,dz]=rotateInBox(entrance.at[0],entrance.at[2],bp.size[0],bp.size[2],e.rot);
        const [ex,ez]=rotateInBox(entrance.at[0],bp.size[2]-1,bp.size[0],bp.size[2],e.rot);
        if(bbox.x1-bbox.x0+1!==w||bbox.z1-bbox.z0+1!==d||e.door.x!==bbox.x0+dx||e.door.z!==bbox.z0+dz||e.exit.x!==bbox.x0+ex||e.exit.z!==bbox.z0+ez)refuse("saved destination geometry disagrees with its blueprint entrance");
        const p={id:e.id,lotId:e.lot,role,blueprint:e.blueprint,kind,checksum:expected.checksum,districtId:record.districtId,
            door:{x:e.door.x,y:e.baseY+1,z:e.door.z},exit:{x:e.exit.x,y:e.baseY+1,z:e.exit.z},frontage:{x:e.frontage.x,z:e.frontage.z,via:e.frontage.via},facing:e.facing};
        if(entrances.has(key(p.door)))refuse("duplicate saved destination entrance");
        entrances.add(key(p.door));candidates.push(p);for(const col of [p.door,p.exit,p.frontage])columns.add(column(col));
    }
    // Only relevant columns are retained, with at most384cells per column.
    // Every stage is scanned so later AIR and same-ID foreign overwrites count.
    const final=new Map();let scanned=0,slices=0;
    for(const slice of siteOpSlices(record,{maxOps:DESTINATION_LIMITS.slice})){
        for(const op of slice.ops){
            if(++scanned>DESTINATION_LIMITS.scanOps)refuse("destination op-scan bound exceeded");
            if(!integer(op.x)||!integer(op.z)||!Number.isInteger(op.y)||op.y< -64||op.y>319)refuse("destination source contains invalid world coordinates");
            if(columns.has(column(op)))final.set(key(op),{x:op.x,y:op.y,z:op.z,id:op.id,kind:op.kind,states:clean(op.states??{}),stage:slice.stage,element:slice.element});
        }
        slices++;yield;
    }
    if(metadata(record)!==stamp)refuse("destination source changed during indexing");
    const accepted=[],refused=[];
    for(const c of candidates){
        const lower=final.get(key(c.door)),upper=final.get(key({...c.door,y:c.door.y+1}));
        const owned=(/** @type {any} */ op)=>op?.stage==="lots"&&op.element===c.id;
        const entranceOk=c.role==="home"?owned(lower)&&owned(upper)&&/^minecraft:(?:wooden_door|[a-z_]+_door)$/.test(lower.id)&&upper.id===lower.id
            &&lower.states.upper_block_bit===false&&upper.states.upper_block_bit===true
            :owned(lower)&&/^minecraft:(?:fence_gate|[a-z_]+_fence_gate)$/.test(lower.id);
        if(!entranceOk){refused.push({id:c.id,lotId:c.lotId,reason:"saved entrance is absent, overwritten or has inconsistent door halves"});continue;}
        let road;
        for(let y=-64;y<=317;y++){
            const floor=final.get(key({x:c.frontage.x,y,z:c.frontage.z}));
            if(!solidRoad(floor))continue;
            const body=final.get(key({x:c.frontage.x,y:y+1,z:c.frontage.z})),head=final.get(key({x:c.frontage.x,y:y+2,z:c.frontage.z}));
            if((body&&body.id!=="minecraft:air")||(head&&head.id!=="minecraft:air"))continue;
            if(road){road=undefined;break;}road=floor;
        }
        accepted.push({...c,entrance:clean(lower),frontageSurface:road?{x:road.x,y:road.y,z:road.z,id:road.id,kind:road.kind,owner:road.element}:null,
            frontageFeet:road?{x:road.x,y:road.y+1,z:road.z}:null,
            status:"saved-plan candidate; native loading and clearance UNVERIFIED",route:null});
        // Candidate review and per-column bounded elevation search are separate slices.
        yield;
    }
    if(metadata(record)!==stamp)refuse("destination source changed during candidate review");
    const result=freeze({version:1,index:expected.index,checksum:expected.checksum,candidates:accepted,refused,
        work:{elements:count,declaredOps,scannedOps:scanned,scanSlices:slices,retainedCells:final.size,maxRetainedCells:columns.size*384},
        readOnly:true,nativeReads:0,worldWrites:0,entityChanges:0});
    destinationProofs.set(result,{record,stamp});return result;
}
/** @param {any} result */
export function destinationProofIsCurrent(result){
    try{const proof=destinationProofs.get(result);return proof!==undefined&&isLiveSite(proof.record)
        &&proof.record.checksum===result.checksum&&proof.record.districtIndex===result.index&&metadata(proof.record)===proof.stamp;}
    catch{return false;}
}

/** @param {string} text */
export function parseDestinationsCommand(text){
    const m=/^district=([1-5])(?: page=([1-9][0-9]{0,2}))?$/.exec(text.trim());
    return m?{index:Number(m[1]),page:Number(m[2]??1)}:{error:"Use travel destinations district=1 page=1 (district1–5)."};
}
/** @param {any} result @param {number} page */
export function formatDestinations(result,page){
    const pages=Math.max(1,Math.ceil(result.candidates.length/DESTINATION_LIMITS.pageSize));
    if(page>pages)return [`Destination page ${page} exceeds ${pages}; nothing changed.`];
    return [`Saved civilian destinations: district${result.index}; checksum${result.checksum}; page${page}/${pages}.`,
        `${result.candidates.length} candidates; ${result.refused.length} refused. Native loading/clearance UNVERIFIED; no route or work credit.`,
        ...result.candidates.slice((page-1)*DESTINATION_LIMITS.pageSize,page*DESTINATION_LIMITS.pageSize).map((/** @type {any} */ c)=>`${c.role} ${c.id}; lot ${c.lotId}; blueprint ${c.blueprint}; door ${key(c.door)}; exit ${key(c.exit)}; frontage ${c.frontageFeet?key(c.frontageFeet):`${c.frontage.x},?,${c.frontage.z} (planned height unresolved)`}.`),
        ...result.refused.slice(0,3).map((/** @type {any} */r)=>`Refused ${r.id}: ${r.reason}.`),
        `Read-only saved-plan index: ${result.work.scannedOps} op visits; ${result.nativeReads} native block reads, 0 writes/entity changes.`];
}
