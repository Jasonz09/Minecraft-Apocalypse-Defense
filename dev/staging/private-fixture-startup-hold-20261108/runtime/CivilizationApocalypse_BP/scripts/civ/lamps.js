/**
 * Retrofit lighting for districts that were built before the planner placed lamps. PURE: no Minecraft import.
 *
 * The planner's own lighting (`districtplan.js`) needs the plan it is building: its road columns, its lot
 * aprons and its wall flags. A district built by an older pack has none of that any more - the stored record
 * is pinned to a planner that no longer exists, so re-planning it would refuse the checksum. What the world
 * still has is its SURFACES: every column's topmost block. This module turns those surfaces into lamp spots
 * with one rule that needs nothing else:
 *
 *     a lantern stands on whatever solid surface is already there (one block above it), on a grid.
 *
 * Because each walkable level (street, roof, wall top, field) gets its own grid, the vertical distance between
 * a lantern and the column it lights stays small even where levels differ, and a lantern never replaces a
 * block: placement is one lantern into an air cell, and a cell that is no longer air is skipped. That makes a
 * rerun idempotent - a spot that already holds a lantern reports "already" and is left alone.
 *
 * Light maths: a lantern emits 15 and light falls by one per block of MANHATTAN distance. With `spacing` 8 the
 * farthest a grid column can sit from its own grid point is 4 + 4 = 8; relocating up to 2 blocks per axis adds
 * at most 4, so a lamp is at most 12 blocks from the column it was planned for, leaving light >= 3 before any
 * small height step. `dev/test/civ-lamps.test.mjs` measures the real figure on a built district.
 */
import { isLeaves, isLiquid, isLog, isPlant, isTreePart } from "../structures/terrain.js";
import { rasterizePath } from "./walls.js";

/** Grid constant of the retrofit. Exported so a test can assert the plan used the documented numbers. */
export const LAMP_RETROFIT = Object.freeze({
    spacing: 8,
    relocate: 2,
    /** Along a wall the same rule is applied on the centreline; the wall top is 3 wide and ~8 above the street. */
    wallStep: 10,
});

export const LAMP_ID = "minecraft:lantern";
export const AIR_ID = "minecraft:air";

/**
 * Exact ids that are not a stand: they are decoration or non-blocks, so a lantern placed "on" them would sit
 * in the air next to them or read as clutter. Absence from this list means "a full block or a slab/stair/fence
 * top" - the fail-closed rule for a *look*, not for safety: placement itself is guarded by the air check.
 */
const WEAK_IDS = new Set([
    "minecraft:cobweb",
    "minecraft:fire",
    "minecraft:soul_fire",
    "minecraft:scaffolding",
    "minecraft:ladder",
    "minecraft:barrier",
    "minecraft:structure_void",
    "minecraft:bubble_column",
    "minecraft:end_portal",
    "minecraft:end_gateway",
    "minecraft:nether_portal",
    "minecraft:snow_layer",
    "minecraft:cocoa",
    "minecraft:azalea",
    "minecraft:flowering_azalea",
    // A crop or a cover block is not a full block: a lantern one above it would float over the plant.
    "minecraft:wheat",
    "minecraft:carrots",
    "minecraft:potatoes",
    "minecraft:beetroots",
    "minecraft:nether_wart",
    "minecraft:pumpkin_stem",
    "minecraft:melon_stem",
    "minecraft:attached_pumpkin_stem",
    "minecraft:attached_melon_stem",
    "minecraft:lily_pad",
    "minecraft:big_dripleaf",
    "minecraft:small_dripleaf",
    "minecraft:glow_lichen",
    "minecraft:sculk_vein",
    "minecraft:cave_vines",
    "minecraft:cave_vines_plant",
    // A torch is not a stand either (the suffix rule misses the bare id).
    "minecraft:torch",
    "minecraft:soul_torch",
    "minecraft:redstone_torch",
    "minecraft:copper_torch",
    "minecraft:rail",
]);

/** Suffixes of blocks with no stable top to stand a lantern on (or decor that a lamp on top would misread). */
const WEAK_SUFFIXES = Object.freeze([
    "_button",
    "_pressure_plate",
    "_sign",
    "_banner",
    "_bed",
    "_door",
    "_trapdoor",
    "_fence_gate",
    "_carpet",
    "_snow",
    "_torch",
    "_vine",
    "_roots",
    "_candle",
    "_rail",
    "_sapling",
    "_petals",
    "_bud",
    "_log",
    "_wood",
    "_stem",
    "_hyphae",
    "_leaves",
]);

/** @param {string} id */
export function isLantern(id) {
    return id === LAMP_ID;
}

/**
 * Whether a lantern may stand on this block: any solid surface except liquid, vegetation, a tree, and the
 * decoration in `WEAK_IDS` / `WEAK_SUFFIXES`. Air is not a stand (there is nothing to support the lantern).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isLampStand(id) {
    if (typeof id !== "string" || !id.startsWith("minecraft:") || id === AIR_ID) {
        return false;
    }
    if (isLantern(id) || isLiquid(id) || isPlant(id) || isTreePart(id)) {
        return false;
    }
    if (WEAK_IDS.has(id)) {
        return false;
    }
    for (const suffix of WEAK_SUFFIXES) {
        if (id.endsWith(suffix)) {
            return false;
        }
    }
    return true;
}

/**
 * @typedef {{ x: number, y: number, z: number, id: string }} TopCell
 * @typedef {(x: number, z: number) => TopCell | undefined} TopReader `undefined` = unloaded or no block
 * @typedef {{ state: "lamp" | "already" | "skip" | "unloaded", x?: number, z?: number, y?: number }} LampDecision
 */

/**
 * Decide what one grid point becomes. The grid point itself is tried first; when it cannot hold a lamp the
 * search widens to a Chebyshev ring of `relocate` blocks (deterministic order, so a rerun makes the same
 * choice). A lantern anywhere in that ring means the point is DONE - relocating past it on a rerun would place
 * a second lamp beside the first.
 *
 * @param {TopReader} readTop
 * @param {number} gx
 * @param {number} gz
 * @param {{ relocate?: number, maxY?: number }} [options]
 * @returns {LampDecision}
 */
export function chooseLampSpot(readTop, gx, gz, options = {}) {
    const relocate = Number.isInteger(options.relocate) ? Number(options.relocate) : LAMP_RETROFIT.relocate;
    const maxY = options.maxY ?? 319;
    const base = readTop(gx, gz);
    if (base === undefined) {
        return { state: "unloaded" };
    }
    // Pass 1: a lantern ANYWHERE in the ring means this grid point is already done. Checking this before
    // choosing a stand is what keeps a rerun from adding a second lantern beside the first when the cell the
    // first run would have used reads differently now (a chunk that loaded late, a plant that grew).
    for (let radius = 0; radius <= relocate; radius += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
                    continue;
                }
                const cell = radius === 0 ? base : readTop(gx + dx, gz + dz);
                if (cell !== undefined && isLantern(cell.id)) {
                    return { state: "already", x: cell.x, z: cell.z, y: cell.y };
                }
            }
        }
    }
    // Pass 2: the first stand in the same deterministic ring order. Grid lamps stay at the level they were
    // planned for (the street); a raised level (a roof, a ledge, a wall top) that no grid point lands on is
    // caught by the runtime's coverage pass, which gives every unlit standing surface its own lantern.
    for (let radius = 0; radius <= relocate; radius += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
                    continue;
                }
                const cell = radius === 0 ? base : readTop(gx + dx, gz + dz);
                if (cell !== undefined && isLampStand(cell.id) && cell.y + 1 <= maxY) {
                    return { state: "lamp", x: cell.x, z: cell.z, y: cell.y + 1 };
                }
            }
        }
    }
    return { state: "skip" };
}

/**
 * The grid points one rectangle is swept over, anchored at its own corner so a tile split never moves the grid.
 *
 * @param {{ x0: number, z0: number, x1: number, z1: number }} rect
 * @param {number} [spacing]
 */
export function gridPointsOf(rect, spacing = LAMP_RETROFIT.spacing) {
    /** @type {{ x: number, z: number }[]} */
    const points = [];
    for (let z = rect.z0; z <= rect.z1; z += spacing) {
        for (let x = rect.x0; x <= rect.x1; x += spacing) {
            points.push({ x, z });
        }
    }
    return points;
}

/**
 * Lamp samples along a wall centreline. A wall top is a level of its own - 3 wide, about 8 blocks above the
 * street - so the street grid can leave it dark however fine the grid becomes; the master plan's own wall path
 * is the one thing about an old district that is still exact, so the retrofit lights the wall along it.
 *
 * Samples are taken from the path start every `step` cells plus the last cell, using the wall planner's own
 * rasteriser, so the sample is always a column the wall was built on. Two districts that share a wall walk the
 * same path in the same order and therefore choose the same samples - the second run finds the lamp and stops.
 *
 * @param {number[][]} path
 * @param {{ step?: number, closed?: boolean }} [options]
 * @returns {{ x: number, z: number }[]}
 */
export function wallLampSamples(path, options = {}) {
    const step = Number.isInteger(options.step) && Number(options.step) > 0 ? Number(options.step) : LAMP_RETROFIT.wallStep;
    const { cells } = rasterizePath(path, options.closed === true);
    /** @type {{ x: number, z: number }[]} */
    const samples = [];
    for (let i = 0; i < cells.length; i += step) {
        samples.push({ x: cells[i][0], z: cells[i][1] });
    }
    const last = cells[cells.length - 1];
    const tail = samples[samples.length - 1];
    if (tail === undefined || tail.x !== last[0] || tail.z !== last[1]) {
        samples.push({ x: last[0], z: last[1] });
    }
    return samples;
}

/**
 * The first grid point at or after `from` on a grid anchored at `origin`. Used by the runtime so a tile starts
 * on the same lattice the whole district uses.
 *
 * @param {number} from @param {number} origin @param {number} spacing
 */
export function firstGridAt(from, origin, spacing) {
    return origin + Math.ceil((from - origin) / spacing) * spacing;
}

/**
 * Plan one rectangle's lamps from a surface reader. Pure and deterministic; the runtime runs the same decision
 * per tile, this form exists for tests and for measuring coverage.
 *
 * @param {TopReader} readTop
 * @param {{ x0: number, z0: number, x1: number, z1: number }} rect
 * @param {{ spacing?: number, relocate?: number, maxY?: number }} [options]
 * @returns {{ spots: { x: number, y: number, z: number }[], already: number, skipped: number, unloaded: number, points: number }}
 */
export function planLampSpots(readTop, rect, options = {}) {
    const spacing = options.spacing ?? LAMP_RETROFIT.spacing;
    const relocate = options.relocate ?? LAMP_RETROFIT.relocate;
    const maxY = options.maxY;
    /** @type {{ x: number, y: number, z: number }[]} */
    const spots = [];
    let already = 0;
    let skipped = 0;
    let unloaded = 0;
    let points = 0;
    for (let z = rect.z0; z <= rect.z1; z += spacing) {
        for (let x = rect.x0; x <= rect.x1; x += spacing) {
            points += 1;
            const decision = chooseLampSpot(readTop, x, z, { relocate, maxY });
            if (decision.state === "lamp") {
                spots.push({ x: Number(decision.x), y: Number(decision.y), z: Number(decision.z) });
            } else if (decision.state === "already") {
                already += 1;
            } else if (decision.state === "unloaded") {
                unloaded += 1;
            } else {
                skipped += 1;
            }
        }
    }
    return { spots, already, skipped, unloaded, points };
}

/**
 * The Manhattan distance at which a lantern still lights a cell above block light 0: a lantern emits 15 and
 * light falls by one per block, so distance 14 still answers 1. This is the reach the retrofit measures itself
 * against; a hostile mob needs block light 0 to spawn.
 */
export const LAMP_REACH = 14;

/**
 * A coarse spatial index of lamp positions, so "is this cell lit" is a handful of distance checks rather than
 * one per lamp. Buckets are 16 blocks wide and a lamp within `reach` (14) is at most one bucket away.
 *
 * @param {number} [bucketSize]
 * @returns {{ add: (lamp: { x: number, y: number, z: number }) => void, covers: (cell: { x: number, y: number, z: number }, reach?: number) => boolean, size: () => number }}
 */
export function createLampIndex(bucketSize = 16) {
    const size = Number.isInteger(bucketSize) && bucketSize > 0 ? bucketSize : 16;
    /** @type {Map<string, { x: number, y: number, z: number }[]>} */
    const buckets = new Map();
    let count = 0;
    /** @param {number} x @param {number} z */
    const keyOf = (x, z) => `${String(Math.floor(x / size))},${String(Math.floor(z / size))}`;
    return {
        /** @param {{ x: number, y: number, z: number }} lamp */
        add(lamp) {
            const key = keyOf(lamp.x, lamp.z);
            const list = buckets.get(key);
            if (list === undefined) {
                buckets.set(key, [lamp]);
            } else {
                list.push(lamp);
            }
            count += 1;
        },
        /**
         * @param {{ x: number, y: number, z: number }} cell
         * @param {number} [reach]
         */
        covers(cell, reach = LAMP_REACH) {
            const bx = Math.floor(cell.x / size);
            const bz = Math.floor(cell.z / size);
            for (let dz = -1; dz <= 1; dz += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    const list = buckets.get(`${String(bx + dx)},${String(bz + dz)}`);
                    if (list === undefined) {
                        continue;
                    }
                    for (const lamp of list) {
                        if (Math.abs(lamp.x - cell.x) + Math.abs(lamp.y - cell.y) + Math.abs(lamp.z - cell.z) <= reach) {
                            return true;
                        }
                    }
                }
            }
            return false;
        },
        size() {
            return count;
        },
    };
}

/**
 * How far a column's standing cell is from the nearest lamp, and what light it therefore gets. Only used to
 * measure a plan (tests and the run's own report); a hostile mob needs block light 0 to spawn.
 *
 * @param {{ x: number, y: number, z: number }[]} surfaceCells standing cells (the block above a solid surface)
 * @param {{ x: number, y: number, z: number }[]} lamps
 * @param {{ reach?: number }} [options] reach: key the report by distance (default 14 = light 1)
 * @returns {{ open: number, worst: number, far: { x: number, y: number, z: number, distance: number }[], reach: number }}
 */
export function coverageOf(surfaceCells, lamps, options = {}) {
    const reach = options.reach ?? LAMP_REACH;
    let worst = 0;
    /** @type {{ x: number, y: number, z: number, distance: number }[]} */
    const far = [];
    for (const cell of surfaceCells) {
        let best = Infinity;
        for (const lamp of lamps) {
            const distance = Math.abs(lamp.x - cell.x) + Math.abs(lamp.y - cell.y) + Math.abs(lamp.z - cell.z);
            if (distance < best) {
                best = distance;
            }
        }
        if (best > worst) {
            worst = best;
        }
        if (best > reach) {
            far.push({ x: cell.x, y: cell.y, z: cell.z, distance: best });
        }
    }
    return { open: surfaceCells.length, worst, far, reach };
}
