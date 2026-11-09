import { CIV, PEOPLE } from "../config.js";
import { createMilitarySelectionStore } from "../integration/militarySelectionStore.js";
import { classifyTags } from "../population/identity.js";
import { POP_CURSOR_KEY } from "../population/settings.js";
import { SWORDSMAN_TYPE, MILITARY_TYPES } from "../population/militarySelection.js";

// This is an operator-selected, separately restored fixture, not a universal
// freshness detector. Its reviewed closed-world source has SHA256 prefix672745b7.
// Loaded census cannot prove the absence of arbitrary unloaded-world entities.
export const MILITARY_FIXTURE_ID="nov3-d1-672745b7";
const MAX_CENSUS=512;

/** No world reads occur until a command or owner callback is invoked.
 * @param {{world:any,kingdomStore:{load:()=>any},isBusy:()=>boolean}} deps */
export function createMilitaryCommand(deps) {
    /** @type {any} */ let source;
    function keys() {
        const value=deps.world.getDynamicPropertyIds();
        if(!Array.isArray(value)||value.some(k=>typeof k!=="string"))throw new Error("world state keys are unreadable");
        return value;
    }
    function freshConditions() {
        if(deps.world.getDynamicProperty(CIV.devGateKey)!==true)throw new Error("enable the development gate before selecting a trial");
        if(source?.typeId!=="minecraft:player"||source.isValid!==true||source.dimension?.id!=="minecraft:overworld")throw new Error("an Overworld player must select the trial");
        if(deps.isBusy()!==false)throw new Error("construction or maintenance is busy");
        if(deps.world.getDynamicProperty(PEOPLE.gateKey)!==undefined)throw new Error("this fixture has already switched people on or off; restore a fresh trial copy");
        if(deps.world.getDynamicProperty(POP_CURSOR_KEY)!==undefined)throw new Error("a population cursor already exists; restore a fresh trial copy");
        if(keys().some(k=>k.startsWith("civ:military_")))throw new Error("military state already exists; it is preserved");
        const kingdom=deps.kingdomStore.load().kingdom;
        if(kingdom?.starter!==undefined)throw new Error("released or armed worlds cannot be used as this development fixture");
        const districts=kingdom?.districts;
        if(!Array.isArray(districts)||districts.length!==5)throw new Error("the reviewed five-district fixture record is required");
        const first=districts.filter(d=>d.id==="district-1");
        if(first.length!==1||first[0].civ?.status!=="complete"||first[0].civ?.checksum!=="07515fcb"||first[0].civ?.centre?.x!==-69||first[0].civ?.centre?.z!==-599)throw new Error("Hearthgate does not match the reviewed Nov 3 fixture");
        for(let n=2;n<=5;n++) {
            const matches=districts.filter(d=>d.id===`district-${n}`);
            if(matches.length!==1||matches[0].civ!==undefined||matches[0].physical!==undefined)throw new Error("districts 2â€“5 must be unbuilt in the reviewed fixture");
        }
        if(districts.some(d=>d.physical!==undefined))throw new Error("prototype district state is incompatible with this fixture");
    }
    function census() {
        const dimension=deps.world.getDimension("overworld");
        if(dimension?.id!=="minecraft:overworld")throw new Error("the Overworld census is unavailable");
        const entities=dimension.getEntities({});
        if(!Array.isArray(entities)||entities.length>MAX_CENSUS)throw new Error("the loaded census exceeds its trial budget");
        const groupIds=[];
        for(const entity of entities) {
            if(!entity||entity.isValid===false)throw new Error("a loaded census handle is unreadable");
            if(MILITARY_TYPES.includes(entity.typeId))throw new Error("a trial guard already exists; it is preserved");
            const tags=entity.getTags();
            if(!Array.isArray(tags)||tags.length>256)throw new Error("a loaded census tag list is unreadable");
            const identity=classifyTags(tags);
            if(identity.unreadable.length||identity.ownTags.length>1)throw new Error("ambiguous or unsupported population claims are preserved");
            groupIds.push(...identity.claims);
        }
        if(groupIds.length)throw new Error("population representatives already exist; no conversion or replacement is allowed");
        return {complete:true,groupIds};
    }
    const store=createMilitarySelectionStore(deps.world,{
        readKingdom:()=>deps.kingdomStore.load().kingdom,
        isPeopleOn:()=>deps.world.getDynamicProperty(PEOPLE.gateKey)!==undefined,
        isBusy:deps.isBusy,readCanonicalCensus:census,
        verifyFreshTrial:request=>{
            freshConditions();
            return {verified:request.trialId===`${MILITARY_FIXTURE_ID}-${request.class??"swordsman"}`,fixtureId:MILITARY_FIXTURE_ID,dimension:"minecraft:overworld"};
        },
    });
    const statusLines=()=>{
        const read=store.load();
        if(read.status==="refused")return [`Military trial held: ${read.reason}. No selection changed.`];
        return [read.selection?`Military trial selection: ${read.selection.groupId}, ${read.selection.class}; fixture ${read.selection.fixtureId}.`:"Military trial selection: off.",
            "One opt-in stationary guard trial; native combat acceptance and casualty accounting are unfinished."];
    };
    /** @param {string} message @param {any} event */
    function command(message,event) {
        if(message.trim()==="status"||message.trim()==="")return statusLines();
        const match=/^select district=([1-5]) group=(0|[1-9]\d{0,4}) fixture=([A-Za-z0-9_-]{1,64})(?: class=(archer))?( confirm)?$/.exec(message.trim());
        if(!match)return ["Usage: civ:people military status | select district=N group=G fixture=nov3-d1-672745b7 [class=archer] [confirm]."];
        if(match[3]!==MILITARY_FIXTURE_ID)return ["Military trial refused: unknown fixture provenance; nothing changed."];
        if(!match[5])return ["Selection preview only. Use a separately restored, SHA-verified Nov 3 D1 fixture before ever switching people on.",
            "The fixture label is an operator provenance assertion; runtime checks cannot prove arbitrary unloaded-world absence.",
            "Append confirm to select one existing soldier group. No entity is spawned by selection."];
        source=event?.sourceEntity;
        try {
            freshConditions();
            store.activate({groupId:`district-${match[1]}:sol:${match[2]}`,trialId:`${MILITARY_FIXTURE_ID}-${match[4]??"swordsman"}`,class:match[4]?"archer":"swordsman",dimension:"minecraft:overworld"});
            return [...statusLines(),"Selection saved and read back. The existing people owner alone may later admit the guard."];
        } catch(error) {return [`Military trial refused: ${String(error instanceof Error?error.message:error)}.`];}
        finally {source=undefined;}
    }
    return {store,command,statusLines};
}
