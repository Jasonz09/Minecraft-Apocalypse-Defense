/**
 * Pure natural-terrain logic for district generation: what counts as natural ground, plants
 * and trees; how a world column is read; how one terraced platform is planned over uneven
 * ground; how a natural tree is told from a player build; and how candidate sites are scored.
 * Nothing here touches Minecraft - the Bedrock boundary feeds block ids in and gets decisions out.
 *
 * Safety philosophy: reject on doubt. Only blocks that are unambiguously natural by id are ever
 * cut, cleared or replaced; an unknown block anywhere in the footprint refuses the whole site.
 */

/** Surface and sub-surface blocks that terrain preparation may cut, fill over or build on. */
export const NATURAL_GROUND = [
    "minecraft:grass_block",
    "minecraft:dirt",
    "minecraft:coarse_dirt",
    "minecraft:podzol",
    "minecraft:dirt_with_roots",
    "minecraft:mud",
    "minecraft:clay",
    "minecraft:sand",
    "minecraft:red_sand",
    "minecraft:gravel",
    "minecraft:stone",
    "minecraft:andesite",
    "minecraft:diorite",
    "minecraft:granite",
    "minecraft:tuff",
    "minecraft:sandstone",
    "minecraft:red_sandstone",
    "minecraft:mycelium",
    "minecraft:moss_block",
    "minecraft:snow",
    "minecraft:grass_path",
];

/** Loose vegetation and surface cover: cleared without ceremony. */
export const PLANTS = [
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
    "minecraft:snow_layer",
    "minecraft:vine",
    "minecraft:brown_mushroom",
    "minecraft:red_mushroom",
    "minecraft:sweet_berry_bush",
];

const LOG = /^minecraft:(?:oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_log$/;
const LEAVES = /^minecraft:[a-z_]+_leaves(?:_flowered)?$/;
const LIQUID = ["minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava"];

/** @param {string} id */
export const isNaturalGround = (id) => NATURAL_GROUND.includes(id);
/** @param {string} id */
export const isPlant = (id) => PLANTS.includes(id);
/** @param {string} id */
export const isLog = (id) => LOG.test(id);
/** @param {string} id */
export const isLeaves = (id) => LEAVES.test(id);
/** @param {string} id */
export const isTreePart = (id) => isLog(id) || isLeaves(id) || id === "minecraft:vine";
/** @param {string} id */
export const isLiquid = (id) => LIQUID.includes(id);
/** Blocks that may legitimately sit next to a tree without hinting at a player build. */
/** @param {string} id */
export const isBenign = (id) => id === "minecraft:air" || isPlant(id) || isTreePart(id) || isNaturalGround(id) || isLiquid(id);

/**
 * Read one world column, given as cells from the top down to (and including) the block under
 * the ground. Walks past air and loose vegetation / trees, stops at the first natural ground.
 *
 * @param {{ y: number, id: string }[]} cells top-down
 * @returns {{ ground?: number, topId?: string, belowId?: string, above: { y: number, id: string }[], problem?: string }}
 */
export function classifyColumn(cells) {
    /** @type {{ y: number, id: string }[]} */
    const above = [];
    let ground;
    let topId;
    for (let index = 0; index < cells.length; index += 1) {
        const cell = /** @type {{ y: number, id: string }} */ (cells[index]);
        if (cell.id === "minecraft:air") {
            continue;
        }
        if (isLiquid(cell.id)) {
            return { above, problem: `${cell.id.includes("lava") ? "lava" : "water"} at y=${String(cell.y)}` };
        }
        if (isPlant(cell.id) || isTreePart(cell.id)) {
            above.push(cell);
            continue;
        }
        if (isNaturalGround(cell.id)) {
            ground = cell.y;
            topId = cell.id;
            const below = cells[index + 1];
            if (below === undefined || !isNaturalGround(below.id)) {
                return { ground, topId, above, problem: `hollow or non-natural ground under y=${String(cell.y)} (${String(below?.id)})` };
            }
            return { ground, topId, belowId: below.id, above };
        }
        return { above, problem: `${cell.id} at y=${String(cell.y)} is not natural terrain` };
    }
    return { above, problem: "no natural ground found in this column" };
}

/**
 * @typedef {{ ground: number, topId: string }} ColumnSummary
 * @typedef {{ maxCut: number, maxFill: number }} TerrainLimits
 * @typedef {{ x: number, y: number, z: number, id: string, kind: "cut" | "fill" | "top" }} TerrainOp
 */

/**
 * Plan ONE terraced platform over the footprint. Columns are indexed
 * `(x + half) * (2 * half + 1) + (z + half)`; x/z in the result are footprint-local.
 *
 * The platform height `baseY` is the world y of the ground plane (the structure's local y = -1).
 * It defaults to the median ground height (which minimises total earthworks), and may be forced
 * (used when a build is resumed). Cut removes natural ground above baseY; fill adds dirt up to
 * baseY - 1 and a grass top at baseY. Columns outside [baseY - maxFill, baseY + maxCut] refuse.
 *
 * @param {(ColumnSummary | undefined)[]} columns
 * @param {number} half
 * @param {TerrainLimits} limits
 * @param {number} [forcedBaseY]
 * @returns {{ ok: boolean, baseY: number, ops: TerrainOp[], counts: { cut: number, fill: number, top: number }, problems: string[] }}
 */
export function planTerrain(columns, half, limits, forcedBaseY) {
    const size = half * 2 + 1;
    /** @type {string[]} */
    const problems = [];
    const heights = [];
    for (const column of columns) {
        if (column === undefined) {
            problems.push("a footprint column could not be read");
            return { ok: false, baseY: 0, ops: [], counts: { cut: 0, fill: 0, top: 0 }, problems };
        }
        heights.push(column.ground);
    }
    const sorted = [...heights].sort((a, b) => a - b);
    const baseY = forcedBaseY ?? /** @type {number} */ (sorted[Math.floor(sorted.length / 2)]);

    let tooHigh = 0;
    let tooLow = 0;
    let highest = -Infinity;
    let lowest = Infinity;
    columns.forEach((column) => {
        const ground = /** @type {ColumnSummary} */ (column).ground;
        highest = Math.max(highest, ground);
        lowest = Math.min(lowest, ground);
        if (ground - baseY > limits.maxCut) tooHigh += 1;
        if (baseY - ground > limits.maxFill) tooLow += 1;
    });
    if (tooHigh > 0 || tooLow > 0) {
        problems.push(
            `terrain is too uneven: ground ranges y=${String(lowest)}..${String(highest)} around a platform at y=${String(baseY)}; ` +
                `${String(tooHigh)} column(s) need more than ${String(limits.maxCut)} cut and ${String(tooLow)} need more than ${String(limits.maxFill)} fill`,
        );
        return { ok: false, baseY, ops: [], counts: { cut: 0, fill: 0, top: 0 }, problems };
    }

    /** @type {TerrainOp[]} */
    const cuts = [];
    /** @type {TerrainOp[]} */
    const fills = [];
    /** @type {TerrainOp[]} */
    const tops = [];
    for (let i = 0; i < size; i += 1) {
        for (let j = 0; j < size; j += 1) {
            const column = /** @type {ColumnSummary} */ (columns[i * size + j]);
            const x = i - half;
            const z = j - half;
            if (column.ground > baseY) {
                for (let y = column.ground; y > baseY; y -= 1) {
                    cuts.push({ x, y, z, id: "minecraft:air", kind: "cut" });
                }
                if (column.topId === "minecraft:grass_block") {
                    tops.push({ x, y: baseY, z, id: "minecraft:grass_block", kind: "top" });
                }
            } else if (column.ground < baseY) {
                for (let y = column.ground + 1; y < baseY; y += 1) {
                    fills.push({ x, y, z, id: "minecraft:dirt", kind: "fill" });
                }
                fills.push({ x, y: baseY, z, id: column.topId === "minecraft:sand" ? "minecraft:sand" : "minecraft:grass_block", kind: "fill" });
            }
        }
    }
    cuts.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
    fills.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    tops.sort((a, b) => a.x - b.x || a.z - b.z);
    return { ok: true, baseY, ops: [...cuts, ...fills, ...tops], counts: { cut: cuts.length, fill: fills.length, top: tops.length }, problems };
}

/**
 * Decide whether one terrain write is allowed against what is actually in the world right now.
 * @param {{ kind: "clear" | "cut" | "fill" | "top", existingId: string | undefined, targetId: string }} cell
 * @returns {{ ok: boolean, built: boolean, reason?: string }}
 */
export function classifyTerrainCell(cell) {
    const { kind, existingId, targetId } = cell;
    if (existingId === undefined) {
        return { ok: false, built: false, reason: "unloaded" };
    }
    if (existingId === targetId) {
        return { ok: true, built: true };
    }
    const plantLike = existingId === "minecraft:air" || isPlant(existingId) || isTreePart(existingId);
    if (kind === "clear") {
        return plantLike ? { ok: true, built: existingId === "minecraft:air" } : { ok: false, built: false, reason: `would clear ${existingId}, which is not vegetation` };
    }
    if (kind === "cut") {
        return plantLike || isNaturalGround(existingId) ? { ok: true, built: false } : { ok: false, built: false, reason: `would cut ${existingId}, which is not natural ground` };
    }
    if (kind === "fill") {
        if (plantLike) return { ok: true, built: false };
        // already solid natural ground at that height: fine, nothing to add
        return isNaturalGround(existingId) ? { ok: true, built: true } : { ok: false, built: false, reason: `would fill over ${existingId}` };
    }
    return isNaturalGround(existingId) ? { ok: true, built: false } : { ok: false, built: false, reason: `would resurface ${existingId}` };
}

/**
 * Classify the tree components reachable from the tree-part cells found in the footprint.
 *
 * @param {{ x: number, y: number, z: number }[]} seeds tree/vine cells inside the footprint
 * @param {(x: number, y: number, z: number) => { id: string, persistent?: boolean } | undefined} read undefined = unloaded
 * @param {{ cap?: number, inside: (x: number, z: number) => boolean }} options
 * @returns {{ clear: { x: number, y: number, z: number }[], problems: string[] }}
 */
export function classifyTrees(seeds, read, options) {
    const cap = options.cap ?? 600;
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {{ x: number, y: number, z: number }[]} */
    const clear = [];
    /** @type {string[]} */
    const problems = [];
    const key = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => `${String(x)},${String(y)},${String(z)}`;

    for (const seed of seeds) {
        if (visited.has(key(seed.x, seed.y, seed.z))) {
            continue;
        }
        /** @type {{ x: number, y: number, z: number, id: string }[]} */
        const component = [];
        const queue = [seed];
        visited.add(key(seed.x, seed.y, seed.z));
        let reason;
        while (queue.length > 0 && reason === undefined) {
            const cell = /** @type {{ x: number, y: number, z: number }} */ (queue.pop());
            const here = read(cell.x, cell.y, cell.z);
            if (here === undefined) {
                reason = "a chunk next to the tree is not loaded";
                break;
            }
            component.push({ ...cell, id: here.id });
            if (isLeaves(here.id) && here.persistent === true) {
                reason = `${here.id} at (${String(cell.x)}, ${String(cell.y)}, ${String(cell.z)}) is player-placed (persistent leaves)`;
                break;
            }
            if (component.length > cap) {
                reason = `a tree-like structure larger than ${String(cap)} blocks at (${String(seed.x)}, ${String(seed.y)}, ${String(seed.z)})`;
                break;
            }
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dy = -1; dy <= 1; dy += 1) {
                    for (let dz = -1; dz <= 1; dz += 1) {
                        if (dx === 0 && dy === 0 && dz === 0) continue;
                        const nx = cell.x + dx;
                        const ny = cell.y + dy;
                        const nz = cell.z + dz;
                        const neighbour = read(nx, ny, nz);
                        if (neighbour === undefined) {
                            reason = "a chunk next to the tree is not loaded";
                            break;
                        }
                        if (!isBenign(neighbour.id)) {
                            reason = `${neighbour.id} touches a tree at (${String(nx)}, ${String(ny)}, ${String(nz)}) - may be a player build`;
                            break;
                        }
                        if (isTreePart(neighbour.id) && !visited.has(key(nx, ny, nz))) {
                            visited.add(key(nx, ny, nz));
                            queue.push({ x: nx, y: ny, z: nz });
                        }
                    }
                    if (reason) break;
                }
                if (reason) break;
            }
        }
        if (reason === undefined) {
            const logs = component.filter((cell) => isLog(cell.id));
            if (logs.length === 0) {
                // leaves and vines with no trunk at all (e.g. canopy of a tree outside the footprint): natural, clear the part inside
            } else if (!component.some((cell) => isLeaves(cell.id))) {
                reason = `a log-only structure at (${String(logs[0]?.x)}, ${String(logs[0]?.y)}, ${String(logs[0]?.z)}) has no leaves - may be a player build`;
            } else {
                const lowest = logs.reduce((best, cell) => (cell.y < best.y ? cell : best), /** @type {{ x: number, y: number, z: number, id: string }} */ (logs[0]));
                const base = read(lowest.x, lowest.y - 1, lowest.z);
                if (base === undefined || !(isNaturalGround(base.id) || isLog(base.id))) {
                    reason = `a tree trunk at (${String(lowest.x)}, ${String(lowest.y)}, ${String(lowest.z)}) does not stand on natural ground (${String(base?.id)})`;
                }
            }
        }
        if (reason !== undefined) {
            problems.push(reason);
            continue;
        }
        for (const cell of component) {
            if (options.inside(cell.x, cell.z)) {
                clear.push({ x: cell.x, y: cell.y, z: cell.z });
            }
        }
    }
    return { clear, problems };
}

/**
 * FNV-1a fingerprint of the terrain work a survey found, so `confirm` can prove the world is
 * still exactly as surveyed.
 *
 * @param {{ x: number, y: number, z: number }} origin footprint centre (x, z) and platform plane y
 * @param {number} baseY
 * @param {TerrainOp[]} ops
 * @param {{ x: number, y: number, z: number }[]} clear
 */
export function terrainFingerprint(origin, baseY, ops, clear) {
    let h = 0x811c9dc5;
    /** @param {string} text */
    const feed = (text) => {
        for (let i = 0; i < text.length; i += 1) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
    };
    feed(`${String(origin.x)},${String(origin.z)},${String(baseY)};`);
    for (const op of ops) feed(`${op.kind}${String(op.x)},${String(op.y)},${String(op.z)}${op.id};`);
    for (const cell of [...clear].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)) feed(`c${String(cell.x)},${String(cell.y)},${String(cell.z)};`);
    return h.toString(16).padStart(8, "0");
}

/**
 * Score a candidate footprint from cached column summaries (lower is better). Hard rejects
 * come first. Tree counts are an estimate from the columns; the full survey does the
 * authoritative classification.
 *
 * @param {(x: number, z: number) => { ground?: number, topId?: string, above: { y: number, id: string }[], problem?: string } | undefined} column
 * @param {{ x: number, z: number }} centre
 * @param {number} half
 * @param {TerrainLimits} limits
 * @returns {{ ok: boolean, reason?: string, score: number, baseY: number, cut: number, fill: number, trees: number }}
 */
export function scoreCandidate(column, centre, half, limits) {
    const size = half * 2 + 1;
    /** @type {(ColumnSummary | undefined)[]} */
    const summaries = [];
    let trees = 0;
    for (let i = 0; i < size; i += 1) {
        for (let j = 0; j < size; j += 1) {
            const info = column(centre.x - half + i, centre.z - half + j);
            if (info === undefined) {
                return { ok: false, reason: "unloaded", score: Infinity, baseY: 0, cut: 0, fill: 0, trees: 0 };
            }
            if (info.problem !== undefined || info.ground === undefined || info.topId === undefined) {
                return { ok: false, reason: info.problem ?? "unreadable", score: Infinity, baseY: 0, cut: 0, fill: 0, trees: 0 };
            }
            trees += info.above.filter((cell) => isTreePart(cell.id)).length;
            summaries.push({ ground: info.ground, topId: info.topId });
        }
    }
    const plan = planTerrain(summaries, half, limits);
    if (!plan.ok) {
        return { ok: false, reason: plan.problems[0], score: Infinity, baseY: plan.baseY, cut: 0, fill: 0, trees };
    }
    const cut = plan.counts.cut;
    const fill = plan.counts.fill;
    return { ok: true, score: 3 * cut + 2 * fill + trees, baseY: plan.baseY, cut, fill, trees };
}

/**
 * @template T
 * @param {(T & { score: number, distance: number })[]} candidates
 * @param {number} count
 */
export function bestCandidates(candidates, count) {
    return [...candidates].sort((a, b) => a.score + a.distance * 0.5 - (b.score + b.distance * 0.5) || a.distance - b.distance).slice(0, count);
}
