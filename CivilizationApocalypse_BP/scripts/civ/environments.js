/**
 * Environment rules for district sites: what the natural surface, cover, water, caves and
 * village evidence mean, and how one footprint is judged. PURE: no Minecraft imports.
 *
 * The Bedrock boundary reads a column of block ids for every footprint cell plus a margin ring and
 * passes `{ x, z, cells: [{ y, id }] }` in (cells in any order; air is `minecraft:air`). Every answer
 * is a decision, a finding or a plan. Nothing here writes to the world.
 *
 * Safety: reject on doubt. Only ids on the explicit natural lists are natural. Unknown, player-used,
 * frozen, lava, exposed-ore and village-like evidence refuses the site. Thresholds and the decision
 * table are documented in docs/ENVIRONMENTS.md. Foundation maths reuses civ/foundations.js
 * (makeProfile, planFoundationColumns, planBridge); that file is read, never changed.
 */

import { IDS, makeProfile, planBridge, planFoundationColumns } from "./foundations.js";

/**
 * @typedef {{ y: number, id: string }} Cell
 * @typedef {{ x: number, z: number, cells: Cell[] }} Column
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Area
 * @typedef {import("./foundations.js").Op} Op
 * @typedef {"air" | "water" | "lava" | "natural" | "ore" | "cover" | "cactus" | "tree" | "signal" | "frozen" | "protected" | "unknown"} BlockKind
 * @typedef {"temperate" | "desert" | "snow" | "wet" | "stony"} SurfaceClass
 * @typedef {{ class: SurfaceClass, gravity: boolean, extra: number, ambiguousTop: boolean }} SurfaceRule
 * @typedef {{ kind: string, weight: number }} SignalInfo
 * @typedef {{ x: number, y: number, z: number, id: string, kind: string, weight: number }} Signal
 * @typedef {{ id: string, kind: BlockKind, class?: SurfaceClass, rule?: SurfaceRule, signal?: SignalInfo, reason?: string }} BlockInfo
 * @typedef {{ y: number, id: string, kind: BlockKind }} BelowCell
 * @typedef {{ y: number, id: string, class: SurfaceClass, gravity: boolean, extra: number, ambiguousTop: boolean }} Surface
 * @typedef {{ ok: boolean, surface: Surface | undefined, waterTop: number | undefined, cover: { plants: number, cactus: number, trees: number }, signals: { y: number, id: string, kind: string, weight: number }[], below: BelowCell[], problems: string[] }} Stack
 */

// ---------------------------------------------------------------------------------------------
// Tuning (documented in docs/ENVIRONMENTS.md; tests pin every number)

export const CAVE_DEFAULTS = Object.freeze({ depth: 8, roofWindow: 12, roofMax: 3, pitDepth: 2, scoreLimit: 10 });
export const CAVE_WEIGHTS = Object.freeze({ hollow: 3, breach: 6, mouth: 4, "thin-roof": 1, "gravity-roof": 2 });
export const VILLAGE_DEFAULTS = Object.freeze({ radius: 12, verticalRange: 10, threshold: 10, minKinds: 2, denseLimit: 2000 });
export const WATER_DEFAULTS = Object.freeze(
    /** @type {{ margin: number, narrowWidth: number, narrowLength: number, footprintWater: "refuse" | "bridge" }} */ ({
        margin: 3,
        narrowWidth: 3,
        narrowLength: 8,
        footprintWater: "refuse",
    }),
);
export const FOOTING_DEFAULTS = Object.freeze({ maxDepth: 8 });
/** Same limits terrain.js and the design doc use for one terraced platform. */
export const EARTHWORK_DEFAULTS = Object.freeze({ maxCut: 4, maxFill: 4 });
/** Cactus is only natural on sand, and never in a stack taller than this. */
export const CACTUS_MAX = 3;

// ---------------------------------------------------------------------------------------------
// Block tables

/**
 * @param {SurfaceClass} cls @param {boolean} gravity @param {number} extra @param {boolean} ambiguousTop
 * @returns {SurfaceRule}
 */
const naturalRule = (cls, gravity, extra, ambiguousTop) => Object.freeze({ class: cls, gravity, extra, ambiguousTop });

/**
 * Natural ground, by id. `extra` = how many top blocks are replaced by footing material (the
 * anchor) so the foundation stands on solid, non-gravity blocks. `gravity` blocks fall when
 * undercut. `ambiguousTop` blocks are also player-craftable, so they are natural as a layer under
 * the surface but refuse when they are the surface itself.
 * @type {Readonly<Record<string, SurfaceRule>>}
 */
export const NATURAL_SURFACES = Object.freeze({
    "minecraft:grass_block": naturalRule("temperate", false, 0, false),
    "minecraft:dirt": naturalRule("temperate", false, 0, false),
    "minecraft:coarse_dirt": naturalRule("temperate", false, 0, false),
    "minecraft:podzol": naturalRule("temperate", false, 0, false),
    "minecraft:dirt_with_roots": naturalRule("temperate", false, 0, false),
    "minecraft:mycelium": naturalRule("temperate", false, 0, false),
    "minecraft:moss_block": naturalRule("temperate", false, 0, false),
    "minecraft:pale_moss_block": naturalRule("temperate", false, 0, false),
    "minecraft:sand": naturalRule("desert", true, 2, false),
    "minecraft:red_sand": naturalRule("desert", true, 2, false),
    "minecraft:sandstone": naturalRule("desert", false, 0, true),
    "minecraft:red_sandstone": naturalRule("desert", false, 0, true),
    "minecraft:snow": naturalRule("snow", false, 1, true),
    "minecraft:mud": naturalRule("wet", false, 1, false),
    "minecraft:clay": naturalRule("wet", false, 1, true),
    "minecraft:gravel": naturalRule("wet", true, 2, false),
    "minecraft:stone": naturalRule("stony", false, 0, false),
    "minecraft:andesite": naturalRule("stony", false, 0, false),
    "minecraft:diorite": naturalRule("stony", false, 0, false),
    "minecraft:granite": naturalRule("stony", false, 0, false),
    "minecraft:tuff": naturalRule("stony", false, 0, false),
    "minecraft:calcite": naturalRule("stony", false, 0, false),
    "minecraft:dripstone_block": naturalRule("stony", false, 0, false),
    "minecraft:deepslate": naturalRule("stony", false, 0, false),
});

/**
 * District works each surface class allows. "cut" lowers the natural top, "fill" raises the
 * platform over it, "footing" stands a raised floor on it, "road" and "pad" are the route and lot
 * uses. Stone is never filled (no dirt is laid over stone; the site refuses instead). Frozen and
 * protected surfaces allow nothing.
 * @type {Readonly<Record<SurfaceClass | "frozen" | "protected", { works: readonly string[], note: string }>>}
 */
export const CLASS_RULES = Object.freeze({
    temperate: { works: ["cut", "fill", "footing", "road", "pad"], note: "grass, dirt, podzol, mycelium: full earthworks; cover (grass, flowers, mushrooms) is cleared first" },
    desert: { works: ["cut", "fill", "footing", "road", "pad"], note: "sand and red sand are gravity blocks: footing gets 2 cobblestone anchors; sandstone is ambiguous as a top; cactus is cleared only as 1 to 3 blocks on sand" },
    snow: { works: ["cut", "fill", "footing", "road", "pad"], note: "snow layers are clearable cover; a full snow block is ambiguous as a top (refuses) and gets 1 anchor" },
    wet: { works: ["cut", "fill", "footing", "road", "pad"], note: "mud is soft (1 anchor); clay is ambiguous as a top; gravel is a gravity block (2 anchors); mangrove roots are tree parts" },
    stony: { works: ["cut", "footing", "road", "pad"], note: "stone family is solid and slow to cut; no fill is laid over stone; exposed ore refuses" },
    frozen: { works: [], note: "ice, packed ice, blue ice, frosted ice and powder snow: refused by default" },
    protected: { works: [], note: "player-used families: never natural, never cut, cleared or footed" },
});

/**
 * District works allowed on a block id as the ground (empty for anything not natural).
 * @param {string} id
 * @returns {readonly string[]}
 */
export function allowedWorks(id) {
    return Object.hasOwn(NATURAL_SURFACES, id) ? CLASS_RULES[NATURAL_SURFACES[id].class].works : [];
}

/** Loose cover that is cleared without ceremony (terrain.js PLANTS, plus water and cave cover). */
export const COVER_IDS = Object.freeze([
    "minecraft:short_grass",
    "minecraft:tall_grass",
    "minecraft:fern",
    "minecraft:large_fern",
    "minecraft:deadbush",
    "minecraft:short_dry_grass",
    "minecraft:tall_dry_grass",
    "minecraft:leaf_litter",
    "minecraft:wildflowers",
    "minecraft:pink_petals",
    "minecraft:bush",
    "minecraft:firefly_bush",
    "minecraft:dandelion",
    "minecraft:poppy",
    "minecraft:blue_orchid",
    "minecraft:allium",
    "minecraft:azure_bluet",
    "minecraft:red_tulip",
    "minecraft:orange_tulip",
    "minecraft:white_tulip",
    "minecraft:pink_tulip",
    "minecraft:oxeye_daisy",
    "minecraft:cornflower",
    "minecraft:lily_of_the_valley",
    "minecraft:sunflower",
    "minecraft:lilac",
    "minecraft:rose_bush",
    "minecraft:peony",
    "minecraft:torchflower",
    "minecraft:pitcher_plant",
    "minecraft:brown_mushroom",
    "minecraft:red_mushroom",
    "minecraft:sweet_berry_bush",
    "minecraft:snow_layer",
    "minecraft:reeds",
    "minecraft:bamboo",
    "minecraft:flowering_azalea",
    "minecraft:pale_moss_carpet",
    "minecraft:waterlily",
    "minecraft:kelp",
    "minecraft:seagrass",
    "minecraft:hanging_roots",
]);

/** Frozen water and unstable snow: refused by default. */
export const FROZEN_IDS = Object.freeze(["minecraft:ice", "minecraft:packed_ice", "minecraft:blue_ice", "minecraft:frosted_ice", "minecraft:powder_snow"]);

const AIR = "minecraft:air";
const CACTUS = "minecraft:cactus";
const WATER_IDS = Object.freeze(["minecraft:water", "minecraft:flowing_water"]);
const LAVA_IDS = Object.freeze(["minecraft:lava", "minecraft:flowing_lava"]);
const WORKSTATIONS = Object.freeze([
    "minecraft:blast_furnace",
    "minecraft:smoker",
    "minecraft:lectern",
    "minecraft:loom",
    "minecraft:cartography_table",
    "minecraft:fletching_table",
    "minecraft:smithing_table",
    "minecraft:brewing_stand",
    "minecraft:barrel",
    "minecraft:stonecutter_block",
    "minecraft:grindstone",
    "minecraft:cauldron",
    "minecraft:crafting_table",
]);

/** Village and player evidence. Weight is what one block adds to a cluster score. */
/** @type {{ kind: string, weight: number, test: (id: string) => boolean }[]} */
const SIGNAL_RULES = [
    { kind: "bell", weight: 5, test: (id) => id === "minecraft:bell" },
    { kind: "bed", weight: 3, test: (id) => id === "minecraft:bed" || /_bed$/.test(id) },
    { kind: "composter", weight: 3, test: (id) => id === "minecraft:composter" },
    { kind: "workstation", weight: 3, test: (id) => WORKSTATIONS.includes(id) },
    { kind: "door", weight: 2, test: (id) => /_door$/.test(id) },
    { kind: "lantern", weight: 2, test: (id) => /(?:^minecraft:|_)lantern$/.test(id) },
    { kind: "chest", weight: 2, test: (id) => id === "minecraft:chest" || id === "minecraft:trapped_chest" },
    { kind: "planks", weight: 1, test: (id) => /_planks$/.test(id) },
    { kind: "brick", weight: 1, test: (id) => /(?:^minecraft:|_)bricks?$/.test(id) || id === "minecraft:brick_block" },
    { kind: "glass", weight: 1, test: (id) => id.includes("glass") },
    { kind: "torch", weight: 1, test: (id) => id === "minecraft:torch" || id === "minecraft:soul_torch" },
    { kind: "path", weight: 1, test: (id) => id === "minecraft:grass_path" },
];

const TREE_RE = /^minecraft:(?:(?:oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_log|[a-z_]+_leaves(?:_flowered)?|vine|mangrove_roots|muddy_mangrove_roots)$/;
const ORE_RE = /_ore$/;

/** Player-used families. Label only: anything not natural refuses anyway. */
const PROTECTED_RE = [
    /_planks$/, /_stairs$/, /_slab$/, /_wall$/, /_fence(?:_gate)?$/, /_door$/, /_trapdoor$/, /_button$/,
    /_pressure_plate$/, /_sign$/, /terracotta/, /hardened_clay/, /glazed/, /glass/, /_wool$/, /concrete/, /carpet/,
    /brick/, /polished_/, /cut_/, /chiseled_/, /smooth_/, /stripped_/, /_log$/, /_wood$/, /lantern/, /_bed$/, /bell/,
    /chest/, /barrel/, /furnace/, /_table$/, /lectern/, /loom/, /grindstone/, /stonecutter/, /cauldron/, /brewing_stand/,
    /campfire/, /torch/, /rail/, /redstone/, /piston/, /ladder/, /scaffolding/, /hay_block/, /shelf/, /anvil/,
    /hopper/, /dispenser/, /dropper/, /observer/, /repeater/, /comparator/, /lever/, /tnt/, /banner/, /head$/,
    /skull/, /candle/, /cake/, /jukebox/, /beacon/, /_rod$/, /chain/, /iron_bars/, /noteblock/, /flower_pot/,
    /cobblestone/, /packed_mud/, /mud_brick/, /copper/, /amethyst/, /purpur/, /prismarine/, /quartz/, /sea_lantern/,
];

/**
 * Classify one block id. Order matters: liquids, natural ground, frozen, cactus, trees, cover,
 * ores, village signals, then player families, then unknown (which refuses).
 * @param {string} id
 * @returns {BlockInfo}
 */
export function classifyBlock(id) {
    if (id === AIR) return { id, kind: "air" };
    if (WATER_IDS.includes(id)) return { id, kind: "water" };
    if (LAVA_IDS.includes(id)) return { id, kind: "lava" };
    if (Object.hasOwn(NATURAL_SURFACES, id)) {
        const rule = NATURAL_SURFACES[id];
        return { id, kind: "natural", class: rule.class, rule };
    }
    if (FROZEN_IDS.includes(id)) return { id, kind: "frozen", reason: "frozen water or powder snow: refused by default" };
    if (id === CACTUS) return { id, kind: "cactus" };
    if (TREE_RE.test(id)) return { id, kind: "tree" };
    if (COVER_IDS.includes(id)) return { id, kind: "cover" };
    if (ORE_RE.test(id)) return { id, kind: "ore", class: "stony" };
    const signal = signalOf(id);
    if (signal !== undefined) return { id, kind: "signal", signal };
    if (PROTECTED_RE.some((re) => re.test(id))) return { id, kind: "protected", reason: "player-used block family: never natural" };
    return { id, kind: "unknown", reason: "not on the natural list: refused by default" };
}

/** @param {string} id @returns {SignalInfo | undefined} */
export function signalOf(id) {
    for (const rule of SIGNAL_RULES) {
        if (rule.test(id)) return { kind: rule.kind, weight: rule.weight };
    }
    return undefined;
}

/** @param {string} id */
export function isGravity(id) {
    return Object.hasOwn(NATURAL_SURFACES, id) && NATURAL_SURFACES[id].gravity;
}

// ---------------------------------------------------------------------------------------------
// Column reading

/**
 * Read one column top-down. Air, water and cover above the ground are skipped (water sets
 * `waterTop`); the first natural block is the surface. Anything else above the ground is an
 * obstruction (refuses) and reading continues down. Below the surface, player or unknown blocks
 * within `depth` refuse, and voids are kept for cave analysis.
 *
 * @param {Cell[]} cells
 * @param {{ depth?: number }} [options]
 * @returns {Stack}
 */
export function readStack(cells, options = {}) {
    const depth = options.depth ?? CAVE_DEFAULTS.depth;
    const sorted = [...cells].sort((a, b) => b.y - a.y);
    /** @type {string[]} */
    const problems = [];
    /** @type {Stack["signals"]} */
    const signals = [];
    /** @type {BelowCell[]} */
    const below = [];
    const cover = { plants: 0, cactus: 0, trees: 0 };
    /** @type {Surface | undefined} */
    let surface;
    /** @type {number | undefined} */
    let waterTop;
    for (const cell of sorted) {
        const info = classifyBlock(cell.id);
        if (info.signal !== undefined) signals.push({ y: cell.y, id: cell.id, kind: info.signal.kind, weight: info.signal.weight });
        if (info.kind === "lava") {
            problems.push(`lava at y=${String(cell.y)}`);
            continue;
        }
        if (surface !== undefined) {
            below.push({ y: cell.y, id: cell.id, kind: info.kind });
            if (cell.y >= surface.y - depth && (info.kind === "signal" || info.kind === "protected" || info.kind === "unknown" || info.kind === "frozen")) {
                problems.push(`${cell.id} at y=${String(cell.y)} is inside the ground (${info.kind})`);
            }
            continue;
        }
        if (info.kind === "air") continue;
        if (info.kind === "water") {
            if (waterTop === undefined) waterTop = cell.y;
            continue;
        }
        if (info.kind === "cover") {
            cover.plants += 1;
            continue;
        }
        if (info.kind === "cactus") {
            cover.cactus += 1;
            continue;
        }
        if (info.kind === "tree") {
            cover.trees += 1;
            continue;
        }
        if (info.kind === "natural" || info.kind === "ore") {
            const rule = info.rule ?? naturalRule("stony", false, 0, false);
            surface = { y: cell.y, id: cell.id, class: rule.class, gravity: rule.gravity, extra: rule.extra, ambiguousTop: rule.ambiguousTop };
            if (info.kind === "ore") problems.push(`exposed ore ${cell.id} at y=${String(cell.y)}`);
            continue;
        }
        const what = info.kind === "signal" ? "a player or village block" : info.kind;
        problems.push(`${cell.id} at y=${String(cell.y)} is ${what}, not natural terrain`);
    }
    if (surface === undefined) {
        problems.push("no natural ground in this column");
    } else if (cover.cactus > 0 && (cover.cactus > CACTUS_MAX || (surface.id !== "minecraft:sand" && surface.id !== "minecraft:red_sand"))) {
        problems.push(`${String(cover.cactus)} cactus block(s) on ${surface.id} (cactus is natural only as 1-${String(CACTUS_MAX)} blocks on sand)`);
    }
    return { ok: problems.length === 0, surface, waterTop, cover, signals, below, problems };
}

// ---------------------------------------------------------------------------------------------
// Caves

/**
 * Cave risk for one column, judged against the platform plane `platformY` (default: the surface).
 *   hollow       a void (air or water) within `depth` below the platform plane: nothing solid to found on
 *   breach       the cut from the surface down to platformY would open a void
 *   mouth        a pit (surface at least pitDepth below the median) that opens onto a void
 *   thin-roof    a void within roofWindow whose roof is at most roofMax solid blocks thick
 *   gravity-roof sand or gravel sits in the roof above that void
 * hollow, breach and mouth are hard refusals. The column score is the sum of CAVE_WEIGHTS.
 *
 * @param {Stack} stack
 * @param {{ platformY?: number, medianSurface?: number, depth?: number, roofWindow?: number, roofMax?: number, pitDepth?: number }} [options]
 */
export function analyseCaves(stack, options = {}) {
    const depth = options.depth ?? CAVE_DEFAULTS.depth;
    const roofWindow = options.roofWindow ?? CAVE_DEFAULTS.roofWindow;
    const roofMax = options.roofMax ?? CAVE_DEFAULTS.roofMax;
    const pitDepth = options.pitDepth ?? CAVE_DEFAULTS.pitDepth;
    if (stack.surface === undefined) {
        return { flags: ["no-surface"], reasons: ["no natural ground to judge the cave risk against"], score: 0, hard: true, roof: undefined, voidCells: 0, surfaceY: undefined, platformY: undefined };
    }
    const s = stack.surface.y;
    const base = options.platformY ?? s;
    const ref = Math.min(s, base);
    const voids = stack.below.filter((cell) => cell.kind === "air" || cell.kind === "water");
    /** @type {string[]} */
    const flags = [];
    /** @type {string[]} */
    const reasons = [];

    const under = voids.filter((v) => v.y >= ref - depth && v.y <= ref - 1);
    if (under.length > 0) {
        const top = Math.max(...under.map((v) => v.y));
        const hit = /** @type {BelowCell} */ (under.find((v) => v.y === top));
        flags.push("hollow");
        reasons.push(`${hit.id} void at y=${String(top)}, within ${String(depth)} blocks below the platform at y=${String(ref)}`);
    }
    if (base < s) {
        const cut = voids.filter((v) => v.y >= base && v.y <= s - 1);
        if (cut.length > 0) {
            flags.push("breach");
            reasons.push(`cutting from y=${String(s)} down to y=${String(base)} would open a void at y=${String(Math.max(...cut.map((v) => v.y)))}`);
        }
    }
    if (options.medianSurface !== undefined && s <= options.medianSurface - pitDepth && voids.some((v) => v.y === s - 1)) {
        flags.push("mouth");
        reasons.push(`pit: surface y=${String(s)} is ${String(options.medianSurface - s)} below the median and opens onto a void`);
    }
    const near = voids.filter((v) => v.y >= s - roofWindow && v.y <= s - 1);
    /** @type {number | undefined} */
    let roof;
    if (near.length > 0) {
        const top = Math.max(...near.map((v) => v.y));
        roof = s - top - 1;
        if (roof <= roofMax) {
            flags.push("thin-roof");
            reasons.push(`roof of ${String(roof)} solid block(s) over a void at y=${String(top)}`);
        }
        if (stack.surface.gravity || stack.below.some((cell) => cell.y > top && cell.y < s && isGravity(cell.id))) {
            flags.push("gravity-roof");
            reasons.push(`sand or gravel in the roof above the void at y=${String(top)}`);
        }
    }
    const score = flags.reduce((sum, flag) => sum + (CAVE_WEIGHTS[/** @type {keyof typeof CAVE_WEIGHTS} */ (flag)] ?? 0), 0);
    const hard = flags.some((flag) => flag === "hollow" || flag === "breach" || flag === "mouth");
    return { flags, reasons, score, hard, roof, voidCells: near.length, surfaceY: s, platformY: base };
}

// ---------------------------------------------------------------------------------------------
// Village and player evidence

/**
 * Village-like when, for a footprint column, the weighted player or village blocks within `radius`
 * (Chebyshev, horizontal) and `verticalRange` of the ground reach `threshold` across at least
 * `minKinds` different kinds. Any signal block inside the footprint refuses on its own (natural
 * ground has none). Above `denseLimit` signals in the scanned area the site is refused as dense.
 *
 * @param {Column[]} columns
 * @param {Area} area
 * @param {Partial<typeof VILLAGE_DEFAULTS> & { depth?: number }} [options]
 */
export function detectVillage(columns, area, options = {}) {
    const cfg = { ...VILLAGE_DEFAULTS, depth: CAVE_DEFAULTS.depth, ...options };
    const index = indexColumns(columns);
    const signals = collectSignals(columns);
    const strongest = [...signals]
        .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.x - b.x || a.z - b.z || a.y - b.y)
        .slice(0, 5)
        .map((s) => ({ x: s.x, y: s.y, z: s.z, id: s.id, kind: s.kind }));
    if (signals.length > cfg.denseLimit) {
        return {
            villageLike: true,
            flagged: 0,
            inside: [],
            strongest,
            centre: undefined,
            reasons: [`${String(signals.length)} player or village blocks in the scanned area (limit ${String(cfg.denseLimit)}): dense settlement`],
        };
    }
    /** @type {Map<string, number>} */
    const surfaces = new Map();
    for (const cell of cellsOf(area)) {
        const column = index.get(keyOf(cell.x, cell.z));
        if (column === undefined) continue;
        const stack = readStack(column.cells, { depth: cfg.depth });
        if (stack.surface !== undefined) surfaces.set(keyOf(cell.x, cell.z), stack.surface.y);
    }
    /** @type {{ x: number, y: number, z: number, id: string, kind: string }[]} */
    const inside = [];
    for (const sig of signals) {
        const s = surfaces.get(keyOf(sig.x, sig.z));
        if (s === undefined || !inArea(sig.x, sig.z, area)) continue;
        if (sig.y >= s - cfg.depth && sig.y <= s + cfg.verticalRange) {
            inside.push({ x: sig.x, y: sig.y, z: sig.z, id: sig.id, kind: sig.kind });
        }
    }
    let flagged = 0;
    let sumX = 0;
    let sumZ = 0;
    for (const cell of cellsOf(area)) {
        const s = surfaces.get(keyOf(cell.x, cell.z));
        if (s === undefined) continue;
        /** @type {Set<string>} */
        const kinds = new Set();
        let score = 0;
        for (const sig of signals) {
            if (Math.abs(sig.x - cell.x) <= cfg.radius && Math.abs(sig.z - cell.z) <= cfg.radius && Math.abs(sig.y - s) <= cfg.verticalRange) {
                score += sig.weight;
                kinds.add(sig.kind);
            }
        }
        if (score >= cfg.threshold && kinds.size >= cfg.minKinds) {
            flagged += 1;
            sumX += cell.x;
            sumZ += cell.z;
        }
    }
    /** @type {string[]} */
    const reasons = [];
    for (const hit of inside.slice(0, 3)) {
        reasons.push(`${hit.id} (${hit.kind}) at (${String(hit.x)}, ${String(hit.y)}, ${String(hit.z)}) is inside the footprint`);
    }
    if (inside.length > 3) reasons.push(`+${String(inside.length - 3)} more player or village block(s) inside the footprint`);
    if (flagged > 0) {
        const centre = { x: Math.round(sumX / flagged), z: Math.round(sumZ / flagged) };
        const top = strongest[0];
        reasons.push(
            `village-like: ${String(flagged)} footprint column(s) reach ${String(cfg.threshold)} weighted player or village blocks across ${String(cfg.minKinds)}+ kinds within ${String(cfg.radius)} blocks; ` +
                `cluster near (${String(centre.x)}, ${String(centre.z)})` +
                (top !== undefined ? `, strongest ${top.id} at (${String(top.x)}, ${String(top.y)}, ${String(top.z)})` : ""),
        );
        return { villageLike: true, flagged, inside, strongest, centre, reasons };
    }
    return { villageLike: inside.length > 0, flagged, inside, strongest, centre: undefined, reasons };
}

// ---------------------------------------------------------------------------------------------
// Water

/**
 * Water next to and inside the footprint, judged locally. A water cell is NARROW when a straight
 * run of at most `narrowWidth` water cells passes through it along x or z, bounded on both ends by
 * dry, readable banks inside the scanned margin. Any other water cell in the footprint or its
 * one-block ring is WIDE (a lake or river, whatever its full extent) and refuses. Wide water is
 * never proven narrow from a clipped bounding box, so a stream that runs past the margin is judged
 * only by its width where it meets the site.
 *
 * Narrow water inside the footprint refuses under the `refuse` policy. Under `bridge` every such
 * cell must lie on at least one straight crossing that planBridge accepts (limits from
 * civ/foundations.js); the candidates are returned. Narrow water only in the ring is a note.
 *
 * @param {Column[]} columns
 * @param {Area} area
 * @param {Partial<typeof WATER_DEFAULTS>} [options]
 */
export function classifyWater(columns, area, options = {}) {
    const cfg = { ...WATER_DEFAULTS, ...options };
    const index = indexColumns(columns);
    const ext = expandArea(area, Math.max(1, cfg.margin));
    /** @type {Map<string, Stack>} */
    const stacks = new Map();
    for (const cell of cellsOf(ext)) {
        const column = index.get(keyOf(cell.x, cell.z));
        if (column !== undefined) stacks.set(keyOf(cell.x, cell.z), readStack(column.cells));
    }
    const isWater = (/** @type {number} */ x, /** @type {number} */ z) => stacks.get(keyOf(x, z))?.waterTop !== undefined;
    const isBank = (/** @type {number} */ x, /** @type {number} */ z) => {
        const st = stacks.get(keyOf(x, z));
        return st !== undefined && st.surface !== undefined && st.waterTop === undefined;
    };
    const zone = expandArea(area, 1);
    const zoneWater = cellsOf(zone).filter((c) => inArea(c.x, c.z, ext) && isWater(c.x, c.z));
    const zoneSet = new Set(zoneWater.map((c) => keyOf(c.x, c.z)));

    /** @type {Map<string, Bridge>} */
    const candidates = new Map();
    /** @type {Map<string, boolean>} */
    const narrowAt = new Map();
    for (const c of zoneWater) {
        let narrow = false;
        for (const axis of /** @type {("x" | "z")[]} */ (["x", "z"])) {
            const run = narrowRun(c.x, c.z, axis, cfg.narrowWidth, { isWater, isBank, inside: (x, z) => inArea(x, z, ext) });
            if (run === undefined) continue;
            narrow = true;
            const plan = planCrossing(run, stacks);
            if (plan !== undefined && inArea(c.x, c.z, area)) {
                candidates.set(`${axis}:${keyOf(run.from.x, run.from.z)}:${keyOf(run.to.x, run.to.z)}`, plan);
            }
        }
        narrowAt.set(keyOf(c.x, c.z), narrow);
    }

    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {{ kind: "narrow" | "wide", cells: number, bbox: Area, inFootprint: number, inRing: number }[]} */
    const bodies = [];
    /** @type {string[]} */
    const reasons = [];
    /** @type {string[]} */
    const notes = [];
    for (const start of zoneWater) {
        const startKey = keyOf(start.x, start.z);
        if (seen.has(startKey)) continue;
        seen.add(startKey);
        /** @type {{ x: number, z: number }[]} */
        const members = [];
        /** @type {{ x: number, z: number }[]} */
        const queue = [start];
        while (queue.length > 0) {
            const cur = /** @type {{ x: number, z: number }} */ (queue.pop());
            members.push(cur);
            for (const [dx, dz] of NEIGHBOURS) {
                const nk = keyOf(cur.x + dx, cur.z + dz);
                if (zoneSet.has(nk) && !seen.has(nk)) {
                    seen.add(nk);
                    queue.push({ x: cur.x + dx, z: cur.z + dz });
                }
            }
        }
        const xs = members.map((c) => c.x);
        const zs = members.map((c) => c.z);
        const bbox = { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
        const dims = `${String(bbox.x1 - bbox.x0 + 1)}x${String(bbox.z1 - bbox.z0 + 1)}`;
        const inside = members.filter((c) => inArea(c.x, c.z, area));
        const wide = members.filter((c) => narrowAt.get(keyOf(c.x, c.z)) !== true);
        const kind = wide.length > 0 ? "wide" : "narrow";
        bodies.push({ kind, cells: members.length, bbox, inFootprint: inside.length, inRing: members.length - inside.length });
        const anchor = inside[0] ?? members[0];
        const where = `(${String(anchor.x)}, ${String(anchor.z)})`;
        if (wide.length > 0) {
            const wideIn = wide.filter((c) => inArea(c.x, c.z, area));
            reasons.push(
                wideIn.length > 0
                    ? `wide water (lake or river) of ${dims} inside the footprint at (${String(wideIn[0].x)}, ${String(wideIn[0].z)})`
                    : `wide water (lake or river) of ${dims} touches the footprint at (${String(wide[0].x)}, ${String(wide[0].z)})`,
            );
            continue;
        }
        if (inside.length === 0) {
            notes.push(`narrow water of ${dims} beside the footprint at ${where}`);
            continue;
        }
        if (cfg.footprintWater === "refuse") {
            reasons.push(`narrow water of ${dims} inside the footprint at ${where} (policy: refuse)`);
            continue;
        }
        for (const c of inside) {
            const covered = [...candidates.values()].some((b) => coversCell(b, c.x, c.z));
            if (!covered) {
                reasons.push(`narrow water at (${String(c.x)}, ${String(c.z)}) has no straight crossing of ${String(cfg.narrowWidth)} blocks or less that planBridge accepts`);
                break;
            }
        }
    }
    const bridges = [...candidates.values()].sort((a, b) => (a.axis < b.axis ? -1 : a.axis > b.axis ? 1 : a.from.x - b.from.x || a.from.z - b.from.z));
    const uniqueReasons = [...new Set(reasons)];
    const usesBridges = cfg.footprintWater === "bridge" && bodies.some((b) => b.kind === "narrow" && b.inFootprint > 0);
    const decision = uniqueReasons.length > 0 ? "refuse" : usesBridges ? "bridge" : "allow";
    return { decision, reasons: uniqueReasons, notes, bridges: decision === "refuse" ? [] : bridges, bodies };
}

/**
 * A straight water run through (x, z) along one axis, at most `narrowWidth` long, bounded on both
 * ends by dry readable banks. Returns the span cells (bank, run, bank) in order.
 * @param {number} x @param {number} z @param {"x" | "z"} axis @param {number} narrowWidth
 * @param {{ isWater: (x: number, z: number) => boolean, isBank: (x: number, z: number) => boolean, inside: (x: number, z: number) => boolean }} read
 * @returns {{ from: { x: number, z: number }, to: { x: number, z: number }, cells: { x: number, z: number }[] } | undefined}
 */
function narrowRun(x, z, axis, narrowWidth, read) {
    const dx = axis === "x" ? 1 : 0;
    const dz = axis === "z" ? 1 : 0;
    /** @param {number} o */
    const at = (o) => ({ x: x + dx * o, z: z + dz * o });
    let lo = 0;
    while (lo > -(narrowWidth + 1) && read.isWater(at(lo - 1).x, at(lo - 1).z)) lo -= 1;
    let hi = 0;
    while (hi < narrowWidth + 1 && read.isWater(at(hi + 1).x, at(hi + 1).z)) hi += 1;
    const length = hi - lo + 1;
    if (length > narrowWidth) return undefined;
    const a = at(lo - 1);
    const b = at(hi + 1);
    if (!read.inside(a.x, a.z) || !read.inside(b.x, b.z) || !read.isBank(a.x, a.z) || !read.isBank(b.x, b.z)) return undefined;
    /** @type {{ x: number, z: number }[]} */
    const cells = [];
    for (let o = lo - 1; o <= hi + 1; o += 1) cells.push(at(o));
    return { from: a, to: b, cells };
}

/**
 * Bridge candidate from a narrow run: planBridge decides, with its own limits.
 * @param {{ from: { x: number, z: number }, to: { x: number, z: number }, cells: { x: number, z: number }[] }} run
 * @param {Map<string, Stack>} stacks
 * @returns {Bridge | undefined}
 */
function planCrossing(run, stacks) {
    /** @type {{ x: number, z: number, g: number, water?: number }[]} */
    const span = [];
    for (let i = 0; i < run.cells.length; i += 1) {
        const p = /** @type {{ x: number, z: number }} */ (run.cells[i]);
        const st = stacks.get(keyOf(p.x, p.z));
        if (st === undefined || st.surface === undefined) return undefined;
        const bank = i === 0 || i === run.cells.length - 1;
        span.push(bank ? { x: p.x, z: p.z, g: st.surface.y } : { x: p.x, z: p.z, g: st.surface.y, water: st.waterTop });
    }
    const plan = planBridge(span);
    if (!plan.ok) return undefined;
    const axis = run.from.x !== run.to.x ? "x" : "z";
    return { axis, from: run.from, to: run.to, width: run.cells.length - 2, deckY: plan.deckY, pillars: plan.pillars, ops: plan.ops };
}

/** @param {Bridge} bridge @param {number} x @param {number} z */
function coversCell(bridge, x, z) {
    if (bridge.axis === "x") return z === bridge.from.z && x >= Math.min(bridge.from.x, bridge.to.x) && x <= Math.max(bridge.from.x, bridge.to.x);
    return x === bridge.from.x && z >= Math.min(bridge.from.z, bridge.to.z) && z <= Math.max(bridge.from.z, bridge.to.z);
}

/**
 * @typedef {{ axis: "x" | "z", from: { x: number, z: number }, to: { x: number, z: number }, width: number, deckY: number, pillars: number[], ops: Op[] }} Bridge
 */

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Footing (surface classes)

/**
 * Footing a surface class needs. The geometric depth is floorY - 1 - ground (as foundations.js
 * counts it); the anchor is the number of top blocks replaced by footing material; the required
 * depth is their sum and must stay within maxDepth.
 *
 * @param {string} surfaceId
 * @param {number} floorY
 * @param {number} groundY
 * @param {number} [maxDepth]
 * @returns {{ ok: boolean, class?: SurfaceClass, anchor: number, geometric: number, required: number, reason?: string }}
 */
export function requiredFootingDepth(surfaceId, floorY, groundY, maxDepth = FOOTING_DEFAULTS.maxDepth) {
    if (!Object.hasOwn(NATURAL_SURFACES, surfaceId)) {
        return { ok: false, anchor: 0, geometric: 0, required: 0, reason: `${surfaceId} is not natural ground` };
    }
    const rule = NATURAL_SURFACES[surfaceId];
    const geometric = floorY - 1 - groundY;
    if (geometric < 0) {
        return { ok: false, class: rule.class, anchor: rule.extra, geometric, required: geometric + rule.extra, reason: "ground is at or above the floor: cut it down first" };
    }
    const required = geometric + rule.extra;
    return required <= maxDepth
        ? { ok: true, class: rule.class, anchor: rule.extra, geometric, required }
        : { ok: false, class: rule.class, anchor: rule.extra, geometric, required, reason: `needs ${String(required)} blocks of footing, max ${String(maxDepth)}` };
}

/**
 * Footing for a raised floor over the footprint, reusing foundations.js (makeProfile,
 * planFoundationColumns) for the footing blocks and the hollow refusal. Cells at or above the floor
 * are cut down by the terrain layer and get no footing; water cells are crossed by bridges and are
 * never built on, so they get none either. Gravity and soft tops get anchor blocks: their top
 * `extra` blocks become cobblestone so the footing stands on solid, non-gravity blocks. A column
 * whose required depth exceeds maxDepth refuses.
 *
 * @param {Column[]} columns
 * @param {Area} area
 * @param {{ baseY?: number, floorY?: number, maxDepth?: number, depth?: number }} [options]
 */
export function planSurfaceFooting(columns, area, options = {}) {
    const maxDepth = options.maxDepth ?? FOOTING_DEFAULTS.maxDepth;
    const depth = options.depth ?? CAVE_DEFAULTS.depth;
    const index = indexColumns(columns);
    const scan = footprintStacks(index, area, depth);
    /** @type {string[]} */
    const problems = [...scan.problems];
    const baseY = options.baseY ?? medianOf(surfacesIn(scan.stacks, area));
    if (baseY === undefined) return failedFooting([...problems, "no readable ground in the footprint"], undefined);
    if (problems.length > 0) return failedFooting(problems, baseY);
    const floorY = options.floorY ?? baseY + 1;

    /** @type {Map<string, { g: number, hollow: boolean, surface: Surface }>} */
    const info = new Map();
    let cut = 0;
    let water = 0;
    for (const cell of cellsOf(area)) {
        const k = keyOf(cell.x, cell.z);
        const stack = scan.stacks.get(k);
        if (stack === undefined || stack.surface === undefined) continue;
        if (stack.waterTop !== undefined) {
            water += 1;
            continue;
        }
        if (stack.surface.y >= floorY) {
            cut += 1;
            continue;
        }
        const cave = analyseCaves(stack, { platformY: baseY, depth });
        info.set(k, { g: stack.surface.y, hollow: cave.flags.includes("hollow"), surface: stack.surface });
        const need = requiredFootingDepth(stack.surface.id, floorY, stack.surface.y, maxDepth);
        if (!need.ok) {
            problems.push(`footing at (${String(cell.x)}, ${String(cell.z)}) on ${stack.surface.id} needs ${String(need.required)} blocks (max ${String(maxDepth)}, including ${String(need.anchor)} anchor)`);
        }
    }
    if (problems.length > 0) return failedFooting(problems, baseY);
    const footCells = cellsOf(area).filter((c) => info.has(keyOf(c.x, c.z)));
    const w = area.x1 - area.x0 + 1;
    const h = area.z1 - area.z0 + 1;
    const profile = makeProfile(area.x0, area.z0, w, h, (x, z) => {
        const v = info.get(keyOf(x, z));
        return v === undefined ? { g: 0, hollow: true } : { g: v.g, hollow: v.hollow };
    });
    const found = footCells.length === 0 ? { ok: true, ops: /** @type {Op[]} */ ([]), columns: [], problems: /** @type {string[]} */ ([]) } : planFoundationColumns(profile, { cells: footCells, floorY }, { maxDepth: 1000 });
    if (!found.ok) return failedFooting(found.problems, baseY);

    /** @type {Op[]} */
    const anchors = [];
    /** @type {FootingColumn[]} */
    const cols = [];
    for (const col of found.columns) {
        const v = info.get(keyOf(col.x, col.z));
        if (v === undefined) continue;
        const extra = v.surface.extra;
        for (let y = v.g - extra + 1; y <= v.g; y += 1) {
            anchors.push({ x: col.x, y, z: col.z, id: IDS.footDeep, kind: "footing" });
        }
        cols.push({ x: col.x, z: col.z, class: v.surface.class, surface: v.surface.id, ground: v.g, extra, depth: col.depth, required: col.depth + extra });
    }
    const ops = [...found.ops, ...anchors].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    /** @type {Record<string, number>} */
    const byClass = {};
    for (const col of cols) byClass[col.class] = (byClass[col.class] ?? 0) + 1;
    return {
        ok: true,
        baseY,
        floorY,
        ops,
        columns: cols,
        byClass,
        counts: { columns: cols.length, blocks: ops.length, anchors: anchors.length, maxRequired: cols.reduce((m, c) => Math.max(m, c.required), 0), cut, water },
        problems: /** @type {string[]} */ ([]),
    };
}

/** @typedef {{ x: number, z: number, class: SurfaceClass, surface: string, ground: number, extra: number, depth: number, required: number }} FootingColumn */

/**
 * @param {string[]} problems
 * @param {number | undefined} baseY
 */
function failedFooting(problems, baseY) {
    return {
        ok: false,
        baseY,
        floorY: /** @type {number | undefined} */ (undefined),
        ops: /** @type {Op[]} */ ([]),
        columns: /** @type {FootingColumn[]} */ ([]),
        byClass: /** @type {Record<string, number>} */ ({}),
        counts: { columns: 0, blocks: 0, anchors: 0, maxRequired: 0, cut: 0, water: 0 },
        problems,
    };
}

// ---------------------------------------------------------------------------------------------
// Whole-site assessment

/**
 * Judge one footprint: scan problems, surface classes, caves, earthwork, village, water and footing.
 * Decision is "refuse" when any reason exists, "allow_with_bridges" when the only water is narrow
 * water crossed by planned bridges, otherwise "allow". Water columns are judged for caves but not
 * for earthwork or craftable tops (they are crossed, not built on). `maxAmbiguousTop` (default 0)
 * bounds footprint columns whose top is craftable (snow block, clay, sandstone). Columns must be
 * scanned for the footprint plus max(village radius, water margin).
 *
 * @param {Column[]} columns
 * @param {Area} area
 * @param {{ baseY?: number, maxAmbiguousTop?: number, earthwork?: Partial<typeof EARTHWORK_DEFAULTS>, caves?: Partial<typeof CAVE_DEFAULTS>, village?: Partial<typeof VILLAGE_DEFAULTS>, water?: Partial<typeof WATER_DEFAULTS>, footing?: Partial<typeof FOOTING_DEFAULTS> }} [options]
 */
export function assessSite(columns, area, options = {}) {
    const caveCfg = { ...CAVE_DEFAULTS, ...(options.caves ?? {}) };
    const villageCfg = { ...VILLAGE_DEFAULTS, ...(options.village ?? {}) };
    const waterCfg = { ...WATER_DEFAULTS, ...(options.water ?? {}) };
    const earthCfg = { ...EARTHWORK_DEFAULTS, ...(options.earthwork ?? {}) };
    const maxDepth = options.footing?.maxDepth ?? FOOTING_DEFAULTS.maxDepth;
    const maxAmbiguous = options.maxAmbiguousTop ?? 0;
    const margin = Math.max(villageCfg.radius, waterCfg.margin);
    const index = indexColumns(columns);
    const unscanned = cellsOf(expandArea(area, margin)).filter((c) => !index.has(keyOf(c.x, c.z)));
    if (unscanned.length > 0) {
        return refusedSite([`${String(unscanned.length)} column(s) were not scanned (footprint plus ${String(margin)}-block margin is required), e.g. (${String(unscanned[0].x)}, ${String(unscanned[0].z)})`]);
    }

    const scan = footprintStacks(index, area, caveCfg.depth);
    /** @type {string[]} */
    const reasons = [];
    /** @type {string[]} */
    const notes = [];
    for (const problem of scan.problems.slice(0, 5)) reasons.push(problem);
    if (scan.problems.length > 5) reasons.push(`+${String(scan.problems.length - 5)} more footprint problem(s)`);

    const baseY = options.baseY ?? medianOf(surfacesIn(scan.stacks, area));
    if (baseY === undefined) return refusedSite([...reasons, "no readable ground in the footprint"]);

    /** @type {Record<string, number>} */
    const classes = {};
    const cover = { plants: 0, cactus: 0, trees: 0 };
    let ambiguous = 0;
    /** @type {{ x: number, y: number, z: number, id: string }[]} */
    const ambiguousAt = [];
    let waterColumns = 0;
    let cut = 0;
    let fill = 0;
    /** @type {string[]} */
    const earthProblems = [];
    let caveScore = 0;
    /** @type {string[]} */
    const caveHits = [];
    let hollow = 0;
    let breach = 0;
    let mouth = 0;
    let thinRoof = 0;
    let gravityRoof = 0;
    let caveColumns = 0;
    for (const cell of cellsOf(area)) {
        const stack = scan.stacks.get(keyOf(cell.x, cell.z));
        if (stack === undefined) continue;
        cover.plants += stack.cover.plants;
        cover.cactus += stack.cover.cactus;
        cover.trees += stack.cover.trees;
        if (stack.surface === undefined) continue;
        classes[stack.surface.class] = (classes[stack.surface.class] ?? 0) + 1;
        const cave = analyseCaves(stack, { platformY: baseY, medianSurface: baseY, depth: caveCfg.depth, roofWindow: caveCfg.roofWindow, roofMax: caveCfg.roofMax, pitDepth: caveCfg.pitDepth });
        caveScore += cave.score;
        if (cave.flags.length > 0) caveColumns += 1;
        if (cave.flags.includes("hollow")) hollow += 1;
        if (cave.flags.includes("breach")) breach += 1;
        if (cave.flags.includes("mouth")) mouth += 1;
        if (cave.flags.includes("thin-roof")) thinRoof += 1;
        if (cave.flags.includes("gravity-roof")) gravityRoof += 1;
        if (cave.hard && caveHits.length < 3) caveHits.push(`(${String(cell.x)}, ${String(cell.z)}): ${cave.reasons.join("; ")}`);
        if (stack.waterTop !== undefined) {
            waterColumns += 1;
            continue;
        }
        if (stack.surface.ambiguousTop) {
            ambiguous += 1;
            ambiguousAt.push({ x: cell.x, z: cell.z, y: stack.surface.y, id: stack.surface.id });
        }
        const d = stack.surface.y - baseY;
        if (d > 0) {
            cut += d;
            if (d > earthCfg.maxCut) earthProblems.push(`(${String(cell.x)}, ${String(cell.z)}) needs a cut of ${String(d)}`);
        } else if (d < 0) {
            fill += -d;
            if (!allowedWorks(stack.surface.id).includes("fill")) {
                earthProblems.push(`(${String(cell.x)}, ${String(cell.z)}) is ${stack.surface.id} below the platform: fill over stony ground is not planned`);
            } else if (-d > earthCfg.maxFill) {
                earthProblems.push(`(${String(cell.x)}, ${String(cell.z)}) needs a fill of ${String(-d)}`);
            }
        }
    }
    if (ambiguous > maxAmbiguous) {
        const first = ambiguousAt[0];
        reasons.push(
            `${String(ambiguous)} footprint column(s) have a craftable top (snow block, clay, sandstone; allowed ${String(maxAmbiguous)}), e.g. ${first.id} at (${String(first.x)}, ${String(first.y)}, ${String(first.z)})`,
        );
    }
    if (earthProblems.length > 0) {
        reasons.push(`terrain too uneven for one platform at y=${String(baseY)}: ${String(earthProblems.length)} column(s) beyond cut ${String(earthCfg.maxCut)} / fill ${String(earthCfg.maxFill)}, e.g. ${earthProblems[0]}`);
    }
    const hardCaves = hollow + breach + mouth;
    if (hardCaves > 0) {
        reasons.push(`cave: ${String(hardCaves)} footprint column(s) are hollow, breach or a pit (hollow ${String(hollow)}, breach ${String(breach)}, pit ${String(mouth)})`);
        for (const hit of caveHits) reasons.push(`cave: ${hit}`);
    }
    if (caveScore > caveCfg.scoreLimit) {
        reasons.push(`cave risk score ${String(caveScore)} exceeds ${String(caveCfg.scoreLimit)} (thin roofs ${String(thinRoof)}, gravity roofs ${String(gravityRoof)})`);
    }
    if (caveColumns > 0 && reasons.length === 0) notes.push(`cave evidence in ${String(caveColumns)} column(s), score ${String(caveScore)}`);

    const village = detectVillage(columns, area, { ...villageCfg, depth: caveCfg.depth });
    if (village.villageLike) reasons.push(...village.reasons);
    else if (village.strongest.length > 0) notes.push(`${String(village.strongest.length)} player or village block(s) nearby, below the village threshold`);

    const water = classifyWater(columns, area, waterCfg);
    if (water.decision === "refuse") reasons.push(...water.reasons);
    notes.push(...water.notes);

    const footing = planSurfaceFooting(columns, area, { baseY, maxDepth, depth: caveCfg.depth });
    if (!footing.ok) reasons.push(...footing.problems.slice(0, 5));

    const unique = [...new Set(reasons)];
    const decision = unique.length > 0 ? "refuse" : water.decision === "bridge" ? "allow_with_bridges" : "allow";
    return {
        decision,
        reasons: unique,
        notes,
        baseY,
        classes,
        ambiguousTop: ambiguous,
        cover,
        earthwork: { cut, fill, maxCut: earthCfg.maxCut, maxFill: earthCfg.maxFill, waterColumns },
        caves: { score: caveScore, hollow, breach, mouth, thinRoof, gravityRoof, columns: caveColumns },
        village,
        water,
        footing,
    };
}

/** @param {string[]} reasons */
function refusedSite(reasons) {
    return {
        decision: /** @type {"refuse"} */ ("refuse"),
        reasons,
        notes: /** @type {string[]} */ ([]),
        baseY: /** @type {number | undefined} */ (undefined),
        classes: /** @type {Record<string, number>} */ ({}),
        ambiguousTop: 0,
        cover: { plants: 0, cactus: 0, trees: 0 },
        earthwork: /** @type {{ cut: number, fill: number, maxCut: number, maxFill: number, waterColumns: number } | undefined} */ (undefined),
        caves: /** @type {{ score: number, hollow: number, breach: number, mouth: number, thinRoof: number, gravityRoof: number, columns: number } | undefined} */ (undefined),
        village: /** @type {ReturnType<typeof detectVillage> | undefined} */ (undefined),
        water: /** @type {ReturnType<typeof classifyWater> | undefined} */ (undefined),
        footing: /** @type {ReturnType<typeof planSurfaceFooting> | undefined} */ (undefined),
    };
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** @type {[number, number][]} */
const NEIGHBOURS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

/** @param {number} x @param {number} z */
export function keyOf(x, z) {
    return `${String(x)},${String(z)}`;
}

/** @param {Column[]} columns */
function indexColumns(columns) {
    /** @type {Map<string, Column>} */
    const map = new Map();
    for (const column of columns) {
        const k = keyOf(column.x, column.z);
        if (!map.has(k)) map.set(k, column);
    }
    return map;
}

/** @param {Area} area */
function cellsOf(area) {
    /** @type {{ x: number, z: number }[]} */
    const out = [];
    for (let z = area.z0; z <= area.z1; z += 1) {
        for (let x = area.x0; x <= area.x1; x += 1) out.push({ x, z });
    }
    return out;
}

/** @param {Area} area @param {number} m @returns {Area} */
function expandArea(area, m) {
    return { x0: area.x0 - m, z0: area.z0 - m, x1: area.x1 + m, z1: area.z1 + m };
}

/** @param {number} x @param {number} z @param {Area} area */
function inArea(x, z, area) {
    return x >= area.x0 && x <= area.x1 && z >= area.z0 && z <= area.z1;
}

/** @param {number[]} values */
function medianOf(values) {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/** @param {Map<string, Stack>} stacks @param {Area} area */
function surfacesIn(stacks, area) {
    /** @type {number[]} */
    const out = [];
    for (const cell of cellsOf(area)) {
        const s = stacks.get(keyOf(cell.x, cell.z))?.surface;
        if (s !== undefined) out.push(s.y);
    }
    return out;
}

/** @param {Map<string, Column>} index @param {Area} area @param {number} depth */
function footprintStacks(index, area, depth) {
    /** @type {Map<string, Stack>} */
    const stacks = new Map();
    /** @type {string[]} */
    const problems = [];
    for (const cell of cellsOf(area)) {
        const k = keyOf(cell.x, cell.z);
        const column = index.get(k);
        if (column === undefined) {
            problems.push(`(${String(cell.x)}, ${String(cell.z)}) was not scanned`);
            continue;
        }
        const stack = readStack(column.cells, { depth });
        stacks.set(k, stack);
        for (const p of stack.problems) problems.push(`(${String(cell.x)}, ${String(cell.z)}): ${p}`);
    }
    return { stacks, problems };
}

/** @param {Column[]} columns */
function collectSignals(columns) {
    /** @type {Signal[]} */
    const out = [];
    for (const column of columns) {
        for (const cell of column.cells) {
            const info = classifyBlock(cell.id);
            if (info.signal !== undefined) {
                out.push({ x: column.x, y: cell.y, z: column.z, id: cell.id, kind: info.signal.kind, weight: info.signal.weight });
            }
        }
    }
    return out.sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
