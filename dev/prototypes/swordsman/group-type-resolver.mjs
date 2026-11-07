// Integration draft only. Pure: no Minecraft imports, spawning, removal or storage writes.
import { parseGroupId } from "../../../CivilizationApocalypse_BP/scripts/population/groups.js";
import { POP_ENTITY_TYPES } from "../../../CivilizationApocalypse_BP/scripts/population/settings.js";
export const SWORDSMAN_TYPE="civ_trial:swordsman";
/** Called ONLY at activation, before normal streets/popSync has admitted the selected group. */
export function prepareTrialSelection({enabled=false,groupId=null,freshTrial=false,physicalGroupIds}={},groupTable=[]) {
    if(enabled!==true)return null;
    const parsed=parseGroupId(groupId);
    if(!parsed||parsed.kind!=="sol")throw new Error("Select exactly one canonical soldier group.");
    if(freshTrial!==true||!Array.isArray(physicalGroupIds))throw new Error("Fresh trial and a verified physical census are required.");
    if(physicalGroupIds.includes(groupId))throw new Error("Selected group is already admitted; live replacement is forbidden.");
    const matches=groupTable.filter(g=>g.id===groupId);
    if(matches.length!==1||matches[0].kind!=="sol"||matches[0].district!==parsed.district||matches[0].index!==parsed.index||!Number.isSafeInteger(matches[0].headcount)||matches[0].headcount<1)throw new Error("Selected group must exist exactly once in the current derived group table.");
    return Object.freeze({version:1,groupId,typeId:SWORDSMAN_TYPE});
}
/** A future verified saved selection must survive rejoin; do not rerun activation on live groups. */
export function createGroupTypeResolver(selection=null) {
    if(selection!==null&&(selection.version!==1||selection.typeId!==SWORDSMAN_TYPE||parseGroupId(selection.groupId)?.kind!=="sol"))throw new Error("Unverified or unsupported trial selection.");
    const selected=selection?.groupId??null;
    return group=>{
        const parsed=parseGroupId(group?.id);
        if(!parsed||group.kind!==parsed.kind||group.district!==parsed.district||group.index!==parsed.index)throw new Error("Group identity mismatch.");
        return group.id===selected?SWORDSMAN_TYPE:POP_ENTITY_TYPES[parsed.kind];
    };
}
