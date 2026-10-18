import { system, world } from "@minecraft/server";
import { CIV_LIMITS } from "../civ/budget.js";
import { makeGridField } from "../civ/field.js";
import { planScan } from "../civ/siteselect.js";
import { isTreePart } from "../structures/terrain.js";
import { readColumn } from "./terrainScan.js";

/**
 * Bedrock boundary for the one-command civilization workflow, READ side: chunk holding with
 * ticking areas and bounded, sliced, strictly read-only terrain surveys.
 *
 * Nothing in this file writes a block. Every slice stays inside CIV_LIMITS.maxReadsPerSlice:
 * the dimension handed to terrainScan.readColumn is wrapped in a counter and a column is only
 * started when its worst case still fits the slice. Columns the engine cannot read are left
 * UNSET in the field (the field answers 'unloaded') and are counted - never guessed.
 */

/**
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {{ kind: string, jobId: number | undefined, cancelled: boolean }} Job
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 * @typedef {import("../civ/field.js").GridField} GridField
 * @typedef {{
 *   slices: number, maxReadsPerSlice: number, maxColumnsPerSlice: number, columns: number, reads: number,
 *   unloaded: number, tiles: number, unheldTiles: number, notes: string[]
 * }} ScanStats
 */

/** Ticking area used for every civilization read/write window (one at a time). */
export const CIV_TICKING_ID = "civ-generate";

/** Side of one held tile / window in blocks (8 x 8 chunks, far below the engine's per-area chunk cap). */
export const TILE_SIZE = 128;

/** Deepest column walk of terrainScan.readColumn (MAX_WALK) plus the topmost read and one spare. */
const COLUMN_WORST_READS = 98;

/** @returns {ScanStats} */
export function newScanStats() {
    return { slices: 0, maxReadsPerSlice: 0, maxColumnsPerSlice: 0, columns: 0, reads: 0, unloaded: 0, tiles: 0, unheldTiles: 0, notes: [] };
}

/**
 * Count every block read made through the wrapped dimension.
 * @param {Dimension} dimension
 * @param {{ reads: number }} meter
 * @returns {Dimension}
 */
export function meteredDimension(dimension, meter) {
    return /** @type {any} */ ({
        id: dimension.id,
        getTopmostBlock(/** @type {any} */ position) {
            meter.reads += 1;
            return dimension.getTopmostBlock(position);
        },
        getBlock(/** @type {any} */ position) {
            meter.reads += 1;
            return dimension.getBlock(position);
        },
    });
}

/**
 * Run a generator as one system.runJob and resolve with its return value when it finishes.
 * If the job is cancelled (system.clearJob) the promise never settles; callers check
 * token.cancelled after every await.
 *
 * @template T
 * @param {Job} token
 * @param {Generator<void, T, void>} generator
 * @returns {Promise<T | undefined>}
 */
export function runJobAsync(token, generator) {
    return new Promise((resolve, reject) => {
        if (token.cancelled) {
            resolve(undefined);
            return;
        }
        function* wrapped() {
            try {
                const value = yield* generator;
                resolve(value);
            } catch (error) {
                reject(error);
            }
        }
        token.jobId = system.runJob(wrapped());
    });
}

/**
 * Resolve on a later game tick. Used to start each long synchronous planning step at the top of its own tick,
 * so it never stacks on top of other script work (the engine watchdog counts script time per tick).
 * @returns {Promise<void>}
 */
export function nextTick() {
    return new Promise((resolve) => {
        try {
            system.runTimeout(() => resolve(), 1);
        } catch (_error) {
            resolve();
        }
    });
}

/**
 * Keep the chunks of `rect` loaded (replaces the previous civilization ticking area).
 * @param {Dimension} dimension
 * @param {Rect} rect at most a few chunks beyond TILE_SIZE per side
 * @param {string} [id]
 * @returns {Promise<{ held: boolean, note: string | undefined }>}
 */
export async function holdArea(dimension, rect, id = CIV_TICKING_ID) {
    const manager = world.tickingAreaManager;
    const options = { dimension, from: { x: rect.x0, y: 64, z: rect.z0 }, to: { x: rect.x1, y: 64, z: rect.z1 } };
    try {
        if (manager.hasTickingArea(id)) {
            manager.removeTickingArea(id);
        }
        if (!manager.hasCapacity(options)) {
            return { held: false, note: "no ticking-area capacity; relying on chunks that are already loaded" };
        }
        await manager.createTickingArea(id, options);
        return { held: true, note: undefined };
    } catch (error) {
        return { held: false, note: `ticking area unavailable (${String(error)}); relying on chunks that are already loaded` };
    }
}

/** @param {string} [id] */
export function releaseArea(id = CIV_TICKING_ID) {
    try {
        const manager = world.tickingAreaManager;
        if (manager.hasTickingArea(id)) {
            manager.removeTickingArea(id);
        }
    } catch (_error) {
        // nothing to release
    }
}

/**
 * Convert a terrainScan column into a field cell. Unreadable (unloaded) columns return undefined.
 * @param {import("./terrainScan.js").ColumnInfo | undefined} info
 * @returns {{ g: number, k: "land" | "water" | "lava" | "blocked", tree: boolean } | undefined}
 */
export function cellFromColumn(info) {
    if (info === undefined) {
        return undefined;
    }
    const tree = info.above.some((cell) => isTreePart(cell.id));
    if (info.problem === undefined && info.ground !== undefined) {
        return { g: info.ground, k: "land", tree };
    }
    const liquid = /^(water|lava) at y=(-?\d+)/.exec(info.problem ?? "");
    if (liquid !== null) {
        return { g: Number(liquid[2]), k: liquid[1] === "lava" ? "lava" : "water", tree: false };
    }
    if (info.ground !== undefined) {
        // hollow ground (cave / void underneath): known, but not buildable
        return { g: info.ground, k: "blocked", tree };
    }
    const foreign = /at y=(-?\d+) is not natural terrain/.exec(info.problem ?? "");
    return { g: foreign === null ? 0 : Number(foreign[1]), k: "blocked", tree: false };
}

/**
 * Group nearest-first sample points into aligned tiles, tiles ordered by their nearest point
 * (a spiral at tile granularity; nearest-first inside each tile).
 * @param {{ x: number, z: number }[]} points
 * @param {number} [tile]
 * @returns {{ rect: Rect, points: { x: number, z: number }[] }[]}
 */
export function tilePoints(points, tile = TILE_SIZE) {
    /** @type {Map<string, { rect: Rect, points: { x: number, z: number }[] }>} */
    const tiles = new Map();
    for (const point of points) {
        const tx = Math.floor(point.x / tile);
        const tz = Math.floor(point.z / tile);
        const key = `${String(tx)},${String(tz)}`;
        let entry = tiles.get(key);
        if (entry === undefined) {
            entry = { rect: { x0: tx * tile, z0: tz * tile, x1: tx * tile + tile - 1, z1: tz * tile + tile - 1 }, points: [] };
            tiles.set(key, entry);
        }
        entry.points.push(point);
    }
    return [...tiles.values()];
}

/**
 * Read a list of columns in slices. The caller owns the field.
 *
 * @param {Job} token
 * @param {Dimension} dimension
 * @param {Iterable<{ x: number, z: number }>} points
 * @param {GridField} field
 * @param {ScanStats} stats
 * @returns {Generator<void, void, void>}
 */
function* readColumns(token, dimension, points, field, stats) {
    const meter = { reads: 0 };
    const metered = meteredDimension(dimension, meter);
    let columns = 0;
    const endSlice = () => {
        stats.slices += 1;
        stats.reads += meter.reads;
        stats.maxReadsPerSlice = Math.max(stats.maxReadsPerSlice, meter.reads);
        stats.maxColumnsPerSlice = Math.max(stats.maxColumnsPerSlice, columns);
        meter.reads = 0;
        columns = 0;
    };
    for (const point of points) {
        if (token.cancelled) {
            return;
        }
        if (meter.reads + COLUMN_WORST_READS > CIV_LIMITS.maxReadsPerSlice) {
            endSlice();
            yield;
            if (token.cancelled) {
                return;
            }
        }
        const info = readColumn(metered, point.x, point.z);
        const cell = cellFromColumn(info);
        columns += 1;
        stats.columns += 1;
        if (cell === undefined) {
            stats.unloaded += 1;
        } else {
            field.set(point.x, point.z, cell);
        }
    }
    endSlice();
}

/**
 * Coarse, read-only, nearest-first survey on a lattice of `step` blocks around `anchor`.
 * Resolves with the field (cells never read stay 'unloaded') and the budget statistics.
 *
 * @param {Job} token
 * @param {Dimension} dimension
 * @param {{ x: number, z: number }} anchor
 * @param {number} radius blocks (square half-extent)
 * @param {number} step lattice spacing
 * @param {{ onTile?: (done: number, total: number) => void, tile?: number }} [options]
 * @returns {Promise<{ field: GridField, stats: ScanStats, cancelled: boolean }>}
 */
export async function scanCoarse(token, dimension, anchor, radius, step, options = {}) {
    const scanPlan = planScan(anchor, radius, step);
    const m = Math.ceil(radius / step);
    const half = Math.floor(step / 2);
    const field = makeGridField({ x0: scanPlan.anchor.x - m * step - half, z0: scanPlan.anchor.z - m * step - half, w: (2 * m + 1) * step, h: (2 * m + 1) * step, step });
    const stats = newScanStats();
    const tiles = tilePoints(scanPlan.points, options.tile ?? TILE_SIZE);
    try {
        for (let index = 0; index < tiles.length; index += 1) {
            const tile = /** @type {{ rect: Rect, points: { x: number, z: number }[] }} */ (tiles[index]);
            const held = await holdArea(dimension, tile.rect);
            if (token.cancelled) {
                return { field, stats, cancelled: true };
            }
            stats.tiles += 1;
            if (!held.held) {
                stats.unheldTiles += 1;
                if (held.note !== undefined && !stats.notes.includes(held.note)) {
                    stats.notes.push(held.note);
                }
            }
            await runJobAsync(token, readColumns(token, dimension, tile.points, field, stats));
            if (token.cancelled) {
                return { field, stats, cancelled: true };
            }
            options.onTile?.(index + 1, tiles.length);
        }
    } finally {
        if (!token.cancelled) {
            releaseArea();
        }
    }
    return { field, stats, cancelled: false };
}

/**
 * Full-resolution (one sample per block column) read-only survey of a rectangle into a
 * step-1 ground field. Tiles are held one at a time.
 *
 * @param {Job} token
 * @param {Dimension} dimension
 * @param {Rect} rect inclusive block bounds
 * @param {{ onTile?: (done: number, total: number) => void, tile?: number }} [options]
 * @returns {Promise<{ field: GridField, stats: ScanStats, cancelled: boolean }>}
 */
export async function scanFull(token, dimension, rect, options = {}) {
    const field = makeGridField({ x0: rect.x0, z0: rect.z0, w: rect.x1 - rect.x0 + 1, h: rect.z1 - rect.z0 + 1, step: 1 });
    const stats = newScanStats();
    const tile = options.tile ?? TILE_SIZE;
    /** @type {Rect[]} */
    const tiles = [];
    for (let z = Math.floor(rect.z0 / tile) * tile; z <= rect.z1; z += tile) {
        for (let x = Math.floor(rect.x0 / tile) * tile; x <= rect.x1; x += tile) {
            tiles.push({ x0: Math.max(rect.x0, x), z0: Math.max(rect.z0, z), x1: Math.min(rect.x1, x + tile - 1), z1: Math.min(rect.z1, z + tile - 1) });
        }
    }
    /** @param {Rect} r */
    function* rectPoints(r) {
        for (let z = r.z0; z <= r.z1; z += 1) {
            for (let x = r.x0; x <= r.x1; x += 1) {
                yield { x, z };
            }
        }
    }
    try {
        for (let index = 0; index < tiles.length; index += 1) {
            const area = /** @type {Rect} */ (tiles[index]);
            const held = await holdArea(dimension, area);
            if (token.cancelled) {
                return { field, stats, cancelled: true };
            }
            stats.tiles += 1;
            if (!held.held) {
                stats.unheldTiles += 1;
                if (held.note !== undefined && !stats.notes.includes(held.note)) {
                    stats.notes.push(held.note);
                }
            }
            await runJobAsync(token, readColumns(token, dimension, rectPoints(area), field, stats));
            if (token.cancelled) {
                return { field, stats, cancelled: true };
            }
            options.onTile?.(index + 1, tiles.length);
        }
    } finally {
        if (!token.cancelled) {
            releaseArea();
        }
    }
    return { field, stats, cancelled: false };
}

/**
 * Pre-flight estimate of the read work (no world access).
 * @param {number} radius search radius
 * @param {number} step lattice spacing
 * @param {number} fineColumns columns of the full-resolution survey
 */
export function estimateScanWork(radius, step, fineColumns) {
    const m = Math.ceil((radius + 256) / step);
    const coarseColumns = (2 * m + 1) ** 2;
    const readsPerColumn = 5;
    const slices = Math.ceil((coarseColumns * readsPerColumn) / (CIV_LIMITS.maxReadsPerSlice - COLUMN_WORST_READS)) + Math.ceil((fineColumns * readsPerColumn) / (CIV_LIMITS.maxReadsPerSlice - COLUMN_WORST_READS));
    return { coarseColumns, fineColumns, slices };
}
