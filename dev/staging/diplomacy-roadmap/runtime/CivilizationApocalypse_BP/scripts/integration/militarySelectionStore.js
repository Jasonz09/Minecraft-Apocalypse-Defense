import { buildGroupTable, parseGroupId } from "../population/groups.js";
import { findValidationProblems } from "../kingdom/state.js";
import { resolveConfig } from "../population/reconcile.js";
import { MILITARY_SELECTION_KEY, SWORDSMAN_TYPE, decodeMilitarySelection, encodeMilitarySelection } from "../population/militarySelection.js";

/**
 * Injected storage boundary. Fresh provenance and successful canonical census are
 * supplied by the command's trusted verifier, never inferred from a caller's boolean.
 * No entity operations and no kingdom/headcount writes occur here.
 * @param {any} world
 * @param {{readKingdom?:()=>any,isPeopleOn?:()=>boolean,isBusy?:()=>boolean,readCanonicalCensus?:()=>{complete:boolean,groupIds:string[]},verifyFreshTrial?:(request:any)=>{verified:boolean,fixtureId:string,dimension:string},config?:Partial<import("../population/settings.js").PopSyncConfig>}} [deps]
 */
export function createMilitarySelectionStore(world,deps={}) {
    /** @returns {import("../population/militarySelection.js").MilitarySelectionRead} */
    function load() {
        try {return decodeMilitarySelection(world.getDynamicProperty(MILITARY_SELECTION_KEY));}
        catch(_error){return {status:"refused",selection:null,stamp:"refused",reason:"military selection storage is unreadable"};}
    }
    function context() {
        if(typeof deps.isPeopleOn!=="function"||typeof deps.isBusy!=="function"||typeof deps.readCanonicalCensus!=="function")throw new Error("verified activation/clear callbacks are required");
        if(deps.isPeopleOn()!==false)throw new Error("switch people off before changing the military trial");
        if(deps.isBusy()!==false)throw new Error("construction or maintenance is busy");
        const census=deps.readCanonicalCensus();
        if(census?.complete!==true||!Array.isArray(census.groupIds)||census.groupIds.some(id=>parseGroupId(id)===null)||new Set(census.groupIds).size!==census.groupIds.length)throw new Error("canonical military census is incomplete or ambiguous");
        return census;
    }
    /** @param {{groupId:string,trialId:string,dimension:string}} request */
    function activate(request) {
        const prior=load();if(prior.status!=="absent")throw new Error(prior.reason??"military selection already exists; clear it explicitly before activation");
        const census=context();
        if(typeof deps.readKingdom!=="function"||typeof deps.verifyFreshTrial!=="function")throw new Error("fresh-fixture verification and saved kingdom callbacks are required");
        const proof=deps.verifyFreshTrial(request);
        if(proof?.verified!==true||proof.dimension!=="minecraft:overworld"||request.dimension!==proof.dimension)throw new Error("fresh trial provenance or exact dimension is unverified");
        const kingdom=deps.readKingdom();
        if(findValidationProblems(kingdom).length)throw new Error("saved kingdom is invalid for military activation");
        const config=resolveConfig(deps.config??{}),table=buildGroupTable(kingdom,config);
        if(table.problems.length||table.groups.filter(g=>g.id===request.groupId&&g.kind==="sol"&&g.headcount>0).length!==1)throw new Error("select exactly one existing canonical soldier group");
        if(census.groupIds.includes(request.groupId))throw new Error("selected group already has a representative; live replacement is forbidden");
        const raw=encodeMilitarySelection(/** @type {import("../population/militarySelection.js").MilitarySelection} */({v:1,trialId:request.trialId,fixtureId:proof.fixtureId,groupId:request.groupId,class:"swordsman",typeId:SWORDSMAN_TYPE,dimension:"minecraft:overworld"}));
        // Callbacks must not yield; root owns the fresh-fixture/census proof. Detect
        // a selection changed by an injected read before committing this value.
        if(load().status!=="absent")throw new Error("military selection changed during activation");
        world.setDynamicProperty(MILITARY_SELECTION_KEY,raw);
        const saved=load();if(saved.status!=="ok"||saved.stamp!==raw)throw new Error("military selection write could not be verified; trial held");
        return saved;
    }
    function clear() {
        const prior=load();if(prior.status==="refused")throw new Error(prior.reason??"military selection refused");
        if(prior.status==="absent")return prior;
        const census=context();
        if(census.groupIds.includes(/** @type {NonNullable<typeof prior.selection>} */(prior.selection).groupId))throw new Error("selected representative still exists; selection retained");
        if(load().stamp!==prior.stamp)throw new Error("military selection changed before clear; preserved");
        // This first slice has no binding/receipt store. Any future casualty state
        // must add its own hold before this explicit clear can be permitted.
        world.setDynamicProperty(MILITARY_SELECTION_KEY,undefined);
        const saved=load();if(saved.status!=="absent")throw new Error("military selection clear could not be verified");
        return saved;
    }
    return {load,activate,clear};
}
