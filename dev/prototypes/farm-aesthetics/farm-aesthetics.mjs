// Isolated pure prototype. Imports current pure planners read-only; no world writes.
import {BLUEPRINTS2,expandBlueprint,rotateInBox,rotatedSize} from "../../../CivilizationApocalypse_BP/scripts/structures/blueprints2.js";
import {normalizeOps,opSignature} from "../../../CivilizationApocalypse_BP/scripts/civ/opnorm.js";
import {planDeck,profileAt,IDS} from "../../../CivilizationApocalypse_BP/scripts/civ/foundations.js";
import {lanternAnchor} from "../../../CivilizationApocalypse_BP/scripts/civ/interiorlights.js";
import {fnv1a} from "../../../CivilizationApocalypse_BP/scripts/civ/planstore.js";

const FARMS=new Set(["farm_allot_v2","farm_kitchen_v2","farm_veg_v2","farm_wheat_v2","farm_irrigated_v2"]);
const key=p=>`${p.x},${p.y},${p.z}`;
const column=p=>`${p.x},${p.z}`;
const fail=message=>{throw new Error(message);};
const integer=(n,label)=>{if(!Number.isSafeInteger(n))fail(`${label} must be a safe integer`);return n;};
const same=(a,b)=>a?.id===b.id&&Object.entries(b.states??{}).every(([k,v])=>a.states?.[k]===v);
const actualFixture=op=>op.id==="minecraft:lantern"?{...op,states:{hanging:false,...op.states}}:op;
const frozen=value=>{if(value&&typeof value==="object"){Object.freeze(value);for(const child of Object.values(value))frozen(child);}return value;};
function validProposal(proposal){const{planId,...body}=proposal;if(proposal.version!==1||planId!==fnv1a(JSON.stringify(body)))fail("migration proposal checksum is invalid");}

/** Absence is the exact original canonical op stream, including its checksum input. */
export function farmFrontageDraft({blueprintId,rotation=0,x=0,z=0,baseY=0},options={}){
    if(!FARMS.has(blueprintId))fail("unreviewed farm blueprint");
    for(const [label,n] of Object.entries({rotation,x,z,baseY}))integer(n,label);
    if(Math.abs(x)>29999000||Math.abs(z)>29999000||baseY< -60||baseY>310)fail("farm origin is outside the reviewed world bounds");
    if(rotation<0||rotation>3)fail("rotation must be a quarter turn from zero through three");
    const bp=BLUEPRINTS2[blueprintId],size=rotatedSize(bp,rotation);
    const original=normalizeOps(expandBlueprint(bp,rotation).map(op=>({...op,x:x+op.x,y:baseY+op.y,z:z+op.z,kind:"building"})));
    const rect={x0:x,z0:z,x1:x+size.w-1,z1:z+size.d-1};
    if(options.farmLighting===undefined)return{version:"legacy",ops:original,original,rect,remove:[],add:[],anchors:[],gate:null};
    if(options.farmLighting!=="frontage-v1")fail("unknown farm lighting version");
    const at=new Map(original.map(op=>[key(op),op])),remove=original.filter(op=>op.id==="minecraft:lantern").map(actualFixture);
    if(remove.length!==4)fail("reviewed original farm must have exactly four lanterns");
    const middle=Math.floor(bp.size[0]/2),entrance=bp.entrances[0];
    const [gx,gz]=rotateInBox(...[entrance.at[0],entrance.at[2]],bp.size[0],bp.size[2],rotation);
    const gate=at.get(key({x:x+gx,y:baseY+1,z:z+gz}));
    if(!gate||!gate.id.endsWith("fence_gate"))fail("original entrance gate is missing");
    const count=bp.size[0]<=13?1:2,offsets=count===1?[-1]:[-1,1],add=[],anchors=[];
    for(const offset of offsets){
        const [rx,rz]=rotateInBox(middle+offset,bp.size[2]-1,bp.size[0],bp.size[2],rotation);
        const target={x:x+rx,y:baseY+2,z:z+rz,id:"minecraft:lantern",kind:"building",name:"lantern",states:{hanging:false}};
        const anchor=at.get(key({...target,y:target.y-1}));
        if(!anchor||!lanternAnchor(anchor)||at.has(key(target)))fail("frontage target is not empty above an existing supported fence");
        anchors.push(anchor);add.push(target);
    }
    const removed=new Set(remove.map(key));
    const ops=[...original.filter(op=>!removed.has(key(op))),...add];
    return{version:"frontage-v1",ops,original,rect,remove,add,anchors,gate};
}

/** New-generation alternative only. Existing-world pile removal is NOT implemented. */
export function spacedWaterDeck(profile,rect,limits={},options={}){
    if(options.waterPiles!==undefined&&options.waterPiles!=="spaced-v1")fail("unknown water-pile version");
    if(options.waterPiles!==undefined&&(![rect.x0,rect.x1,rect.z0,rect.z1].every(Number.isSafeInteger)||rect.x1<rect.x0||rect.z1<rect.z0||rect.x1-rect.x0>24||rect.z1-rect.z0>24))fail("spaced farm footprint exceeds the reviewed bound");
    if(options.waterPiles!==undefined){
        if([rect.x0,rect.x1,rect.z0,rect.z1].some(n=>Math.abs(n)>29999000))fail("spaced farm footprint is outside reviewed world bounds");
        for(const [label,n] of Object.entries({baseY:limits.baseY??63,maxDepth:limits.maxDepth??64,maxCut:limits.maxCut??2}))integer(n,label);
        if((limits.baseY??63)< -60||(limits.baseY??63)>310||(limits.maxDepth??64)<0||(limits.maxDepth??64)>64||(limits.maxCut??2)<0||(limits.maxCut??2)>16)fail("spaced farm depth/cut/height exceeds reviewed bounds");
    }
    const legacy=planDeck(profile,rect,limits);
    if(options.waterPiles===undefined||legacy.ok!==true)return legacy;
    if(options.waterPiles!=="spaced-v1")fail("unknown water-pile version");
    const every=limits.pillarEvery??3;if(every!==3)fail("spaced-v1 supports only the reviewed three-block grid");
    const keep=p=>{
        if(p.kind!=="pillar"||profileAt(profile,p.x,p.z)?.water===undefined)return true;
        const xEdge=p.x===rect.x0||p.x===rect.x1,zEdge=p.z===rect.z0||p.z===rect.z1;
        if(!xEdge&&!zEdge)return true;
        return (xEdge&&((p.z-rect.z0)%every===0||p.z===rect.z1))||(zEdge&&((p.x-rect.x0)%every===0||p.x===rect.x1));
    };
    const ops=legacy.ops.filter(keep),proof=proveDeckSupport(profile,rect,{...legacy,ops},every);
    if(!proof.ok)fail(proof.reason);
    return{...legacy,ops,counts:{...legacy.counts,pillar:ops.filter(o=>o.kind==="pillar").length},proof};
}

/** Independent conservative reach/vertical-column check; not a native physics proof. */
export function proveDeckSupport(profile,rect,deck,every=3){
    try {
        if(deck.ok!==true||every!==3)fail("unsupported deck proof input");
        const tops=new Map(deck.ops.filter(o=>o.kind==="deck").map(o=>[column(o),o]));
        const pillars=new Map();for(const op of deck.ops.filter(o=>o.kind==="pillar")){if(!pillars.has(column(op)))pillars.set(column(op),[]);pillars.get(column(op)).push(op);}
        const supported=[];
        for(let z=rect.z0;z<=rect.z1;z++)for(let x=rect.x0;x<=rect.x1;x++){
            const p=profileAt(profile,x,z),top=tops.get(`${x},${z}`);
            if(!p||p.hollow||!top||top.y!==deck.baseY)fail("deck surface or natural bearing is missing");
            if(p.g>=deck.baseY-1){supported.push({x,z});continue;}
            const cells=pillars.get(`${x},${z}`)??[];
            if(cells.length===0)continue;
            const ys=new Map(cells.map(c=>[c.y,c]));
            for(let y=p.g+1;y<deck.baseY;y++){
                const cell=ys.get(y),wanted=p.water!==undefined?IDS.pile:(y===deck.baseY-1?IDS.footTop:IDS.footDeep);
                if(!cell||cell.id!==wanted)fail("retained support column is interrupted or has changed material");
            }
            supported.push({x,z});
        }
        let maxReach=0;
        for(const top of tops.values()){
            const distance=Math.min(...supported.map(p=>Math.abs(p.x-top.x)+Math.abs(p.z-top.z)));
            if(distance>2)fail("a deck cell is farther than the reviewed two-cell support reach");maxReach=Math.max(maxReach,distance);
        }
        for(const [x,z] of [[rect.x0,rect.z0],[rect.x1,rect.z0],[rect.x0,rect.z1],[rect.x1,rect.z1]])if(!supported.some(p=>p.x===x&&p.z===z))fail("a deck corner is unsupported");
        return{ok:true,columns:pillars.size,maxReach};
    }catch(error){return{ok:false,reason:String(error)};}
}

/**
 * ownershipAt is supplied by a complete, checksum-verified, all-stage final-write
 * index. A checksum-looking string alone is NOT verification of a saved plan.
 * This pure draft grants no authority to mutate a world.
 */
export function fixtureMigrationProposal(draft,{checksum,owner,ownershipAt}){
    if(draft.version!=="frontage-v1"||!/^[a-f0-9]{8}$/.test(checksum)||typeof owner!=="string"||!owner)fail("verified source receipt is required");
    const guards=new Map(),putGuard=op=>guards.set(key(op),op);
    const own=op=>{
        const known=ownershipAt(op);
        if(known?.status!=="known"||known.owner!==owner||!same(actualFixture(known.op),actualFixture(op)))fail("original fixture/anchor has different final ownership or was overwritten");
    };
    for(const old of draft.remove){own(old);const anchor=draft.original.find(op=>key(op)===key({...old,y:old.y-1}));if(!anchor||!lanternAnchor(anchor))fail("original corner anchor is not proven");own(anchor);putGuard(anchor);}
    for(const anchor of draft.anchors){own(anchor);putGuard(anchor);}
    own(draft.gate);putGuard(draft.gate);
    for(const target of draft.add){const known=ownershipAt(target);if(known?.status!=="unplanned"&&!(known?.status==="known"&&known.owner===owner&&known.op.id==="minecraft:air"))fail("new fixture target has unknown, foreign or non-air final ownership");}
    const proposal={version:1,checksum,owner,remove:draft.remove,add:draft.add,guards:[...guards.values()]};
    return frozen(JSON.parse(JSON.stringify({...proposal,planId:fnv1a(JSON.stringify(proposal))})));
}

function readiness(proposal,read,{allowRemoved=false,allowPlaced=false}={}){
    const get=p=>{const block=read(p);if(!block)fail("fixture area is unloaded or unreadable");return block;};
    for(const guard of proposal.guards)if(!same(get(guard),guard))fail("fixture anchor/entrance changed; whole migration held");
    for(const old of proposal.remove){const block=get(old);if(!same(block,old)&&!(allowRemoved&&block.id==="minecraft:air"))fail("original fixture changed or lacks a trusted removal journal");}
    for(const target of proposal.add){const block=get(target);if(block.id!=="minecraft:air"&&!(allowPlaced&&same(block,target)))fail("new fixture target is obstructed or lacks a trusted placement journal");}
}
/** Must be durably saved by a future runtime BEFORE the first proposed placement. */
export function prepareFixtureMigration(proposal,read){
    validProposal(proposal);
    readiness(proposal,read);return{v:1,planId:proposal.planId,phase:"placing",seenTick:null};
}
/** Returns at most one proposed block action. It performs no mutation itself. */
export function fixtureMigrationStep(proposal,journal,read,{tick,cancelled=false}={}){
    try {
        validProposal(proposal);
        integer(tick,"tick");if(tick<0||journal?.v!==1||journal.planId!==proposal.planId||!["placing","settling","removing","done"].includes(journal.phase))fail("migration journal or tick is invalid");
        if(Object.keys(journal).sort().join(",")!=="phase,planId,seenTick,v"||(journal.phase!=="settling"&&journal.seenTick!==null))fail("migration journal fields are invalid");
        if(cancelled)return{kind:"cancelled",journal,action:null};
        readiness(proposal,read,{allowRemoved:["removing","done"].includes(journal.phase),allowPlaced:true});
        const missing=proposal.add.find(op=>read(op).id==="minecraft:air");
        if(journal.phase==="placing"){
            if(missing)return{kind:"action",journal,action:{type:"place",before:{...missing,id:"minecraft:air",states:{}},after:missing}};
            return{kind:"wait",journal:{...journal,phase:"settling",seenTick:tick},action:null};
        }
        if(missing)fail("new fixture did not remain present; no old fixture may be removed");
        if(journal.phase==="settling"){
            if(!Number.isSafeInteger(journal.seenTick)||journal.seenTick<0)fail("stability journal is invalid");
            if(tick<journal.seenTick)return{kind:"wait",journal:{...journal,seenTick:tick},action:null};
            if(tick-journal.seenTick<2)return{kind:"wait",journal,action:null};
            return{kind:"checkpoint",journal:{...journal,phase:"removing",seenTick:null},action:null};
        }
        const old=proposal.remove.find(op=>read(op).id!=="minecraft:air");
        if(journal.phase==="done"&&old)fail("finished journal disagrees with original fixture removal");
        if(old)return{kind:"action",journal,action:{type:"remove",before:old,after:{...old,id:"minecraft:air",states:{}}}};
        return{kind:"done",journal:{...journal,phase:"done",seenTick:null},action:null};
    }catch(error){return{kind:"held",reason:String(error),journal,action:null};}
}
/** A future runtime calls this again immediately before a native block mutation. */
export function migrationActionReady(proposal,journal,action,read,options){
    const fresh=fixtureMigrationStep(proposal,journal,read,options);
    return fresh.kind==="action"&&JSON.stringify(fresh.action)===JSON.stringify(action);
}
export const checksumInput=ops=>fnv1a(ops.map(opSignature).join("\n"));
