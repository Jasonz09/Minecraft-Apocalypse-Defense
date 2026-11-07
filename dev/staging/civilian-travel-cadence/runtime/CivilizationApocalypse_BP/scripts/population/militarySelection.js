import { parseGroupId } from "./groups.js";
import { POP_ENTITY_TYPES } from "./settings.js";
import { utf8Length } from "../civ/planstore.js";

export const MILITARY_SELECTION_KEY = "civ:military_trial";
export const MILITARY_SELECTION_MAX_BYTES = 1024;
export const SWORDSMAN_TYPE = "civ_trial:swordsman";
/** @typedef {{v:1,trialId:string,fixtureId:string,groupId:string,class:"swordsman",typeId:typeof SWORDSMAN_TYPE,dimension:"minecraft:overworld"}} MilitarySelection */
/** @typedef {{status:"absent"|"ok"|"refused",selection:MilitarySelection|null,stamp:string,reason:string|null}} MilitarySelectionRead */
/** @param {unknown} value */
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
/** @param {unknown} raw @returns {MilitarySelectionRead} */
export function decodeMilitarySelection(raw) {
    if (raw === undefined) return {status:"absent",selection:null,stamp:"absent",reason:null};
    const refused = (/** @type {string} */ reason) => ({status:/** @type {const} */("refused"),selection:null,stamp:"refused",reason});
    if (typeof raw !== "string" || utf8Length(raw)>MILITARY_SELECTION_MAX_BYTES) return refused("military selection is not a bounded JSON string");
    try {
        const value=JSON.parse(raw),keys=["class","dimension","fixtureId","groupId","trialId","typeId","v"];
        if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).sort().join(",")!==keys.join(",")) return refused("military selection fields are invalid");
        if(value.v!==1 || value.class!=="swordsman" || value.typeId!==SWORDSMAN_TYPE || value.dimension!=="minecraft:overworld" || !identifier(value.trialId) || !identifier(value.fixtureId) || parseGroupId(value.groupId)?.kind!=="sol") return refused("military selection version, identity, class or dimension is unsupported");
        const selection=Object.freeze(/** @type {MilitarySelection} */({v:1,trialId:value.trialId,fixtureId:value.fixtureId,groupId:value.groupId,class:"swordsman",typeId:SWORDSMAN_TYPE,dimension:"minecraft:overworld"}));
        return {status:"ok",selection,stamp:JSON.stringify(selection),reason:null};
    } catch (_error) {return refused("military selection JSON is unreadable");}
}
/** @param {MilitarySelection} selection */
export function encodeMilitarySelection(selection) {
    const result=decodeMilitarySelection(JSON.stringify(selection));
    if(result.status!=="ok") throw new Error(result.reason??"invalid military selection");
    return result.stamp;
}
/**
 * One immutable policy snapshot shared by planning, census and Orders. It never spawns or writes.
 * @param {MilitarySelectionRead} read
 * @param {Array<import("./groups.js").GroupRecord>} groups
 * @param {string} dimension
 */
export function militarySelectionPolicy(read, groups, dimension) {
    if(!read || read.status==="refused") throw new Error(read?.reason??"military selection could not be read");
    const validated=read.status==="absent"?decodeMilitarySelection(undefined):read.status==="ok"?decodeMilitarySelection(JSON.stringify(read.selection)):null;
    if(!validated || validated.status==="refused" || read.stamp!==validated.stamp) throw new Error("military selection snapshot is invalid");
    const selection=validated.selection;
    if(selection) {
        if(dimension!==selection.dimension) throw new Error("military selection dimension mismatch");
        if(groups.filter(g=>g.id===selection.groupId&&g.kind==="sol"&&g.headcount>0).length!==1) throw new Error("selected military group no longer exists uniquely; selection is held");
    }
    /** @param {import("./groups.js").GroupRecord} group */
    const typeForGroup=group=>{
        const parsed=parseGroupId(group.id);
        if(!parsed||group.kind!==parsed.kind||group.district!==parsed.district||group.index!==parsed.index) throw new Error("military group identity mismatch");
        return selection?.groupId===group.id?SWORDSMAN_TYPE:POP_ENTITY_TYPES[parsed.kind];
    };
    return {selection,stamp:validated.stamp,typeForGroup};
}
