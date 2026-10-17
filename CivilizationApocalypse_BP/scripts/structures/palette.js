/**
 * Block vocabulary for generated structures. Pure data - nothing here touches Minecraft.
 *
 * A token is one of:
 *   - a plain block   { id }                       (ids are WITHOUT the "minecraft:" prefix)
 *   - a stated block  { id, states }               (raw Bedrock states)
 *   - a facing block  { id, face: { kind, dir } }  (the planner encodes + rotates the facing)
 *   - a mix           { mix: [[token, weight], ...] } picked by a deterministic coordinate hash
 * `null` is air (used to carve).
 *
 * Every id/state name here is checked against @minecraft/vanilla-data by
 * dev/test/structures.test.mjs, so a typo cannot ship silently.
 */

/** @type {Record<string, any>} */
export const PALETTE = {
    air: null,

    // fortification
    wall: { mix: [[{ id: "stone_bricks" }, 70], [{ id: "mossy_stone_bricks" }, 15], [{ id: "cracked_stone_bricks" }, 15]] },
    wall_plain: { id: "stone_bricks" },
    wall_base: { mix: [[{ id: "cobblestone" }, 60], [{ id: "mossy_cobblestone" }, 40]] },
    wall_floor: { id: "polished_andesite" },
    bars: { id: "iron_bars" },
    slit: { id: "iron_bars" },

    // ground
    road: { mix: [[{ id: "coarse_dirt" }, 45], [{ id: "grass_path" }, 30], [{ id: "cobblestone" }, 25]] },
    road_stone: { id: "stone_bricks" },
    plaza: { mix: [[{ id: "cobblestone" }, 70], [{ id: "stone_bricks" }, 30]] },
    farmland: { id: "farmland" },
    water: { id: "water" },
    dirt: { id: "dirt" },

    // timber / buildings
    plank: { id: "oak_planks" },
    plank_dark: { id: "spruce_planks" },
    log: { id: "oak_log" },
    cobble: { id: "cobblestone" },
    glass: { id: "glass_pane" },
    fence: { id: "oak_fence" },
    hay: { id: "hay_block" },
    barrel_up: { id: "barrel" },
    table: { id: "crafting_table" },
    furnace_block: { id: "furnace" },
    lantern: { id: "lantern" },
    bookshelf: { id: "bookshelf" },
    wheat: { id: "wheat", states: { growth: 7 } },
    slab_roof: { id: "spruce_slab" },

    // facing-aware (kind/dir resolved by planner)
    roof_n: { id: "spruce_stairs", face: { kind: "stairs", dir: "north" } },
    roof_s: { id: "spruce_stairs", face: { kind: "stairs", dir: "south" } },
    stair_e: { id: "stone_brick_stairs", face: { kind: "stairs", dir: "east" } },
    chest_s: { id: "chest", face: { kind: "chest", dir: "south" } },
    chest_n: { id: "chest", face: { kind: "chest", dir: "north" } },
    chest_e: { id: "chest", face: { kind: "chest", dir: "east" } },
    chest_w: { id: "chest", face: { kind: "chest", dir: "west" } },
    ladder_s: { id: "ladder", face: { kind: "ladder", dir: "south" } },
    door_lo_s: { id: "wooden_door", face: { kind: "door", dir: "south", half: "lower" } },
    door_hi_s: { id: "wooden_door", face: { kind: "door", dir: "south", half: "upper" } },
    gate_s: { id: "fence_gate", face: { kind: "fence_gate", dir: "south" } },
};
