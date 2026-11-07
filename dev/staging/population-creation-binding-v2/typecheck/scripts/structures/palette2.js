/**
 * Extra palette tokens for the v2 (civilization-scale) blueprints. Pure data.
 *
 * Same token grammar as palette.js ({ id } | { id, states } | { id, face } | { mix } | null). The
 * names here MUST NOT collide with palette.js: a planner/expander resolves tokens against
 * `{ ...PALETTE, ...PALETTE2 }` (see PALETTE_V2 in blueprints2.js). Every id/state is verified
 * against @minecraft/vanilla-data by dev/test/civ-layout.test.mjs (ids differ in 1.26: stone_stairs
 * is the cobblestone stair, brick_block the brick, grass_path the path, wooden_door the oak door).
 */

/** Stair families: key -> stair block id. */
const STAIR_FAMILIES = /** @type {Record<string, string>} */ ({
    oak: "oak_stairs",
    spruce: "spruce_stairs",
    dkoak: "dark_oak_stairs",
    birch: "birch_stairs",
    brick: "brick_stairs",
    stone: "stone_brick_stairs",
    cobble: "stone_stairs",
    mud: "mud_brick_stairs",
    sand: "sandstone_stairs",
});

/** Slab families: key -> slab block id. */
const SLAB_FAMILIES = /** @type {Record<string, string>} */ ({
    oak: "oak_slab",
    spruce: "spruce_slab",
    dkoak: "dark_oak_slab",
    birch: "birch_slab",
    brick: "brick_slab",
    stone: "stone_brick_slab",
    cobble: "cobblestone_slab",
    mud: "mud_brick_slab",
    sand: "sandstone_slab",
});

/** Door families: key -> door block id. */
const DOOR_FAMILIES = /** @type {Record<string, string>} */ ({
    oak: "wooden_door",
    spruce: "spruce_door",
    dkoak: "dark_oak_door",
    birch: "birch_door",
});

/** Direction a stair ASCENDS toward (matches palette.js: roof_s on the north slope rises toward +z). */
const ASCENT = ["north", "east", "south", "west"];

/** @type {Record<string, any>} */
export const PALETTE2 = {
    // solids
    pl_oak: { id: "oak_planks" },
    pl_spruce: { id: "spruce_planks" },
    pl_dkoak: { id: "dark_oak_planks" },
    pl_birch: { id: "birch_planks" },
    lg_oak: { id: "oak_log" },
    lg_spruce: { id: "spruce_log" },
    lg_dkoak: { id: "dark_oak_log" },
    lg_birch: { id: "birch_log" },
    brick: { id: "brick_block" },
    mudbrick: { id: "mud_bricks" },
    clay_white: { id: "white_terracotta" },
    sandstone: { id: "smooth_sandstone" },
    stone_raw: { id: "stone" },
    stone_smooth: { id: "smooth_stone" },
    coal_blk: { id: "coal_block" },
    wall_cobble: { id: "cobblestone_wall" },
    wall_sbrick: { id: "stone_brick_wall" },
    wall_mud: { mix: [[{ id: "mud_bricks" }, 80], [{ id: "packed_mud" }, 20]] },
    wall_rubble: { mix: [[{ id: "cobblestone" }, 55], [{ id: "mossy_cobblestone" }, 20], [{ id: "stone" }, 25]] },
    glass_blk: { id: "glass" },

    // fences and gates
    fence_spruce: { id: "spruce_fence" },
    fence_dkoak: { id: "dark_oak_fence" },
    fence_birch: { id: "birch_fence" },
    gate_oak_s: { id: "fence_gate", face: { kind: "fence_gate", dir: "south" } },
    gate_spruce_s: { id: "spruce_fence_gate", face: { kind: "fence_gate", dir: "south" } },

    // wool awnings and cloth
    wool_red: { id: "red_wool" },
    wool_white: { id: "white_wool" },
    wool_blue: { id: "blue_wool" },
    wool_yellow: { id: "yellow_wool" },
    wool_green: { id: "green_wool" },
    wool_orange: { id: "orange_wool" },
    carpet_red: { id: "red_carpet" },
    carpet_white: { id: "white_carpet" },

    // crops and plants
    carrot_crop: { id: "carrots", states: { growth: 7 } },
    potato_crop: { id: "potatoes", states: { growth: 7 } },
    beet_crop: { id: "beetroot", states: { growth: 7 } },
    berry_bush: { id: "sweet_berry_bush", states: { growth: 3 } },
    melon_blk: { id: "melon_block" },
    pumpkin_blk: { id: "pumpkin" },
    leaves_oak: { id: "oak_leaves", states: { persistent_bit: true } },
    leaves_birch: { id: "birch_leaves", states: { persistent_bit: true } },
    sapling_oak: { id: "oak_sapling" },
    poppy: { id: "poppy" },
    dandelion: { id: "dandelion" },
    cornflower: { id: "cornflower" },

    // ground cover
    grass_blk: { id: "grass_block" },
    podzol: { id: "podzol" },
    dirt_coarse: { id: "coarse_dirt" },
    gravel: { id: "gravel" },
    path_dirt: { mix: [[{ id: "grass_path" }, 55], [{ id: "coarse_dirt" }, 30], [{ id: "gravel" }, 15]] },
    yard_gravel: { mix: [[{ id: "gravel" }, 60], [{ id: "coarse_dirt" }, 25], [{ id: "cobblestone" }, 15]] },
    pave: { mix: [[{ id: "stone_bricks" }, 50], [{ id: "cobblestone" }, 35], [{ id: "polished_andesite" }, 15]] },
    pave_light: { mix: [[{ id: "smooth_stone" }, 40], [{ id: "polished_andesite" }, 40], [{ id: "stone_bricks" }, 20]] },

    // workstations and furniture (no facing needed, default orientation)
    anvil_b: { id: "anvil" },
    blast_b: { id: "blast_furnace" },
    smoker_b: { id: "smoker" },
    grindstone_b: { id: "grindstone" },
    loom_b: { id: "loom" },
    lectern_b: { id: "lectern" },
    bell_b: { id: "bell" },
    composter_b: { id: "composter" },
    cauldron_b: { id: "cauldron" },
    campfire_b: { id: "campfire" },
    smithing_b: { id: "smithing_table" },
    fletching_b: { id: "fletching_table" },
    cartography_b: { id: "cartography_table" },
    barrel_b: { id: "barrel" },
    torch_b: { id: "torch" },
    flower_pot_b: { id: "flower_pot" },
};

for (const [key, id] of Object.entries(STAIR_FAMILIES)) {
    for (const dir of ASCENT) {
        PALETTE2[`rf_${key}_${dir[0]}`] = { id, face: { kind: "stairs", dir } };
    }
}
for (const [key, id] of Object.entries(SLAB_FAMILIES)) {
    PALETTE2[`sl_${key}`] = { id };
}
for (const [key, id] of Object.entries(DOOR_FAMILIES)) {
    PALETTE2[`dr_${key}_lo`] = { id, face: { kind: "door", dir: "south", half: "lower" } };
    PALETTE2[`dr_${key}_hi`] = { id, face: { kind: "door", dir: "south", half: "upper" } };
}

export const ROOF_FAMILY_KEYS = Object.keys(STAIR_FAMILIES);
export const DOOR_FAMILY_KEYS = Object.keys(DOOR_FAMILIES);
