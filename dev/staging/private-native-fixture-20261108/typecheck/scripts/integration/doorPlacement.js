import { BlockPermutation } from "@minecraft/server";

// Stable Block has no isSolid property. Only known full-block floor materials used by
// our plans qualify; unknown blocks, partial blocks and fluids refuse without edits.
const DOOR_FOOTING = new Set([
    "stone", "smooth_stone", "polished_andesite", "cobblestone", "mossy_cobblestone",
    "stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "brick_block",
    "mud_bricks", "packed_mud", "sandstone", "smooth_sandstone", "gravel",
    "dirt", "coarse_dirt", "grass_block", "oak_planks", "spruce_planks",
    "birch_planks", "dark_oak_planks",
].map(id=>`minecraft:${id}`));

/** A door is a paired engine object, not two independent block writes.
 * The native lower-half placement creates both halves together. Only an exact planned pair
 * over solid footing may use this path; foreign blocks and unreadable cells always refuse.
 */

/** @param {any} op */
export function isDoorOp(op) {
    return /^minecraft:[a-z_]+_door$/.test(String(op?.id)) && typeof op?.states?.upper_block_bit === "boolean";
}

/** @param {any} op */
export function lowerDoorOp(op) {
    return { ...op, y: op.y - (op.states.upper_block_bit ? 1 : 0), states: { ...op.states, upper_block_bit:false } };
}

/** @param {any} dimension @param {any} lower
 * @returns {{ status:string, reason?:string, reads:number, writes:number }}
 */
export function inspectDoorPair(dimension, lower) {
    let reads = 0;
    try {
        const bottom = dimension.getBlock({x:lower.x,y:lower.y,z:lower.z}); reads++;
        const top = dimension.getBlock({x:lower.x,y:lower.y+1,z:lower.z}); reads++;
        const floor = dimension.getBlock({x:lower.x,y:lower.y-1,z:lower.z}); reads++;
        if (!bottom || !top || !floor || [bottom,top,floor].some(b=>b.isValid===false)) return {status:"unloaded",reads,writes:0};
        if ([bottom,top].some(b=>b.typeId!=="minecraft:air" && b.typeId!==lower.id)) return {status:"blocked",reason:"a foreign block occupies the doorway",reads,writes:0};
        if (bottom.typeId===lower.id && top.typeId===lower.id) return {status:"present",reads,writes:0};
        if (!DOOR_FOOTING.has(floor.typeId)) return {status:"blocked",reason:`unsupported doorway footing (${floor.typeId})`,reads,writes:0};
        return {status:"missing",reads,writes:0};
    } catch (_error) { return {status:"unloaded",reads,writes:0}; }
}

/** Native placement may create two blocks, so callers reserve two writes and seven reads.
 * @param {any} dimension @param {any} lower
 * @returns {{status:string, reason?:string, reads:number, writes:number}}
 */
export function placeDoorPair(dimension, lower) {
    if (!isDoorOp(lower) || lower.states.upper_block_bit!==false || ![lower.x,lower.y,lower.z].every(Number.isInteger)
        || lower.y < -63 || lower.y > 318 || !["north","south","east","west"].includes(lower.states["minecraft:cardinal_direction"])) {
        return {status:"blocked",reason:"invalid planned door pair",reads:0,writes:0};
    }
    const before = inspectDoorPair(dimension,lower);
    if (before.status!=="missing") return before;
    let reads=before.reads;
    try {
        const bottom=dimension.getBlock({x:lower.x,y:lower.y,z:lower.z}); reads++;
        if (!bottom) return {status:"unloaded",reads,writes:0};
        // Keep an existing surviving half's orientation and open/hinge settings.
        const states = {...lower.states,upper_block_bit:false};
        if (bottom.typeId===lower.id) for (const name of ["minecraft:cardinal_direction","open_bit","door_hinge_bit"]) {
            const value=bottom.permutation?.getState(name);
            if (value!==undefined) states[name]=value;
        }
        else if (bottom.typeId!=="minecraft:air") return {status:"blocked",reason:"the doorway changed before placement",reads,writes:0};
        BlockPermutation.resolve(lower.id,states); // validate against the engine before constructing a command
        const encoded=Object.entries(states).filter(([name])=>["minecraft:cardinal_direction","upper_block_bit","open_bit","door_hinge_bit"].includes(name))
            .map(([name,value])=>`${JSON.stringify(name)}=${JSON.stringify(value)}`).join(",");
        const mode=bottom.typeId==="minecraft:air" ? "keep" : "replace";
        const result=dimension.runCommand(`setblock ${lower.x} ${lower.y} ${lower.z} ${lower.id} [${encoded}] ${mode}`);
        if (result.successCount<1) return {status:"failed",reason:"the engine refused the complete door",reads,writes:0};
        const after=inspectDoorPair(dimension,lower); reads+=after.reads;
        return {status:after.status==="present" ? "placed" : "failed",reason:after.status==="present" ? undefined : "the complete door did not remain in place",reads,writes:2};
    } catch (error) { return {status:"failed",reason:String(error),reads,writes:2}; }
}
