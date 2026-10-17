/**
 * Pure site-safety rules for generating a district. The Bedrock boundary reads blocks and
 * feeds their type ids here; the decision lives in one testable place.
 *
 * The contract the player confirms: ground-plane cells (the surface, y = -1) of natural
 * terrain are REPLACED by roads, floors and farmland; everything above ground must be empty
 * (air or loose plants). Anything else - a player build, a tree, a chest - blocks generation,
 * and there is deliberately no override.
 */

export const NATURAL_GROUND = [
    "minecraft:grass_block",
    "minecraft:dirt",
    "minecraft:coarse_dirt",
    "minecraft:podzol",
    "minecraft:grass_path",
    "minecraft:sand",
    "minecraft:red_sand",
    "minecraft:gravel",
    "minecraft:stone",
    "minecraft:andesite",
    "minecraft:diorite",
    "minecraft:granite",
    "minecraft:sandstone",
    "minecraft:mycelium",
    "minecraft:snow",
    "minecraft:farmland",
];

export const REPLACEABLE = ["minecraft:air", "minecraft:short_grass", "minecraft:tallgrass", "minecraft:fern", "minecraft:snow_layer"];

/**
 * @param {{ plannedId?: string, y: number, existingId: string | undefined }} cell
 *   plannedId is absent for a footprint cell the plan leaves empty.
 * @returns {{ ok: boolean, built: boolean, reason?: string }}
 */
export function classifyCell(cell) {
    const { plannedId, y, existingId } = cell;
    if (existingId === undefined) {
        return { ok: false, built: false, reason: "unloaded" };
    }
    if (plannedId !== undefined && existingId === plannedId) {
        return { ok: true, built: true };
    }
    if (y >= 0) {
        return REPLACEABLE.includes(existingId) ? { ok: true, built: false } : { ok: false, built: false, reason: `occupied by ${existingId}` };
    }
    return NATURAL_GROUND.includes(existingId)
        ? { ok: true, built: false }
        : { ok: false, built: false, reason: `ground is ${existingId}, not natural terrain` };
}
