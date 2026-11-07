// Exact existing civilianTravel footing/AIR predicates; no new flora or unknown fallback.
const FOOTING=/^minecraft:(?:grass_block|grass_path|dirt|coarse_dirt|stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|cobblestone|polished_andesite|andesite|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_planks)$/;
/** @param {unknown} id */
export const isKnownTravelFooting=id=>typeof id==='string'&&FOOTING.test(id);
/** @param {unknown} id */
export const isTravelBodyAir=id=>id==='minecraft:air';
