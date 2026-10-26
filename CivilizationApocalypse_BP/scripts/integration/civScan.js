import { system, world } from "@minecraft/server";
import { CIV } from "../config.js";
import { CIV_LIMITS } from "../civ/budget.js";
import { makeGridField } from "../civ/field.js";
import { planScan } from "../civ/siteselect.js";
import { isTreePart } from "../structures/terrain.js";
import { nowTick, note, touch } from "./civProgress.js";
import { readColumn } from "./terrainScan.js";

/**
 * Bedrock boundary for the one-command civilization workflow, READ side: chunk holding with
 * ticking areas and bounded, sliced, strictly read-only terrain surveys.
 *
 * Nothing in this file writes a block. Every slice stays inside CIV_LIMITS.maxReadsPerSlice:
 * the dimension handed to terrainScan.readColumn is wrapped in a counter and a column is only
 * started when its worst case still fits the slice. Columns the engine cannot read are left
 * UNSET in the field (the field answers 'unloaded') and are counted - never guessed.
 *
 * Holding chunks can stall (createTickingArea resolves only when every chunk is loaded and ticking, and the
 * engine reports no reason when it does not): every hold races a timeout, is retried, and a tile that never
 * loads is skipped (its columns stay unread) - several stalled tiles abort the run with a clear message.
 *
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {{ kind: string, jobId: number | undefined, cancelled: boolean }} Job
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 * @typedef {import("../civ/field.js").GridField} GridField
 * @typedef {import("./civProgress.js").Progress} Progress
 * @typedef {{
 *   slices: number, maxReadsPerSlice: number, maxColumnsPerSlice: number, columns: number, reads: number,
 *   unloaded: number, tiles: number, unheldTiles: number, notes: string[],
 *   tilesTotal: number, chunksScanned: number, stalledTiles: Rect[], consecutiveStalls: number, attempted: number, ringsDone: number,
 *   retriedTiles: number, recoveredTiles: number, skippedColumns: number,
 *   aborted: string | undefined
 * }} ScanStats
 */

/** Ticking area used for every civilization read/write window (one at a time). */
export const CIV_TICKING_ID = "civ-generate";

/** Default side of one held tile / window in blocks (8 x 8 chunks). */
export const TILE_SIZE = 128;

/** Deepest column walk of terrainScan.readColumn (MAX_WALK) plus the topmost read and one spare. */
const COLUMN_WORST_READS = 98;

/** @returns {ScanStats} */
export function newScanStats() {
    return { slices: 0, maxReadsPerSlice: 0, maxColumnsPerSlice: 0, columns: 0, reads: 0, unloaded: 0, tiles: 0, unheldTiles: 0, notes: [], tilesTotal: 0, chunksScanned: 0, stalledTiles: [], consecutiveStalls: 0, attempted: 0, ringsDone: 0, retriedTiles: 0, recoveredTiles: 0, skippedColumns: 0, aborted: undefined };
}

/**
 * Side (blocks) of the tile to hold: at most 64 chunks and at most 80% of the engine's chunk limit.
 * @returns {number}
 */
export function tileSizeNow() {
    let max;
    try {
        max = world.tickingAreaManager.maxChunkCount;
    } catch (_error) {
        max = undefined;
    }
    const limit = typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.max(1, Math.min(64, Math.floor(max * 0.8))) : 64;
    return Math.max(1, Math.floor(Math.sqrt(limit))) * 16;
}

/** @param {Rect} r */
const chunksOfRect = (r) => (Math.floor(r.x1 / 16) - Math.floor(r.x0 / 16) + 1) * (Math.floor(r.z1 / 16) - Math.floor(r.z0 / 16) + 1);

/**
 * Count the aligned tiles of side `tile` that intersect the square of half-extent `radius` around `anchor`.
 * @param {{ x: number, z: number }} anchor @param {number} radius @param {number} tile
 */
export function countTiles(anchor, radius, tile) {
    const tx = Math.floor((anchor.x + radius) / tile) - Math.floor((anchor.x - radius) / tile) + 1;
    const tz = Math.floor((anchor.z + radius) / tile) - Math.floor((anchor.z - radius) / tile) + 1;
    return tx * tz;
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
 * Run a generator as one system.runJob and resolve with its return value when it finishes. Every yield counts as
 * progress for the session. If the job is cancelled (system.clearJob) the promise never settles; callers check
 * token.cancelled after every await.
 *
 * @template T
 * @param {Job} token
 * @param {Generator<void, T, void>} generator
 * @param {Progress} [progress]
 * @returns {Promise<T | undefined>}
 */
export function runJobAsync(token, generator, progress = undefined) {
    return new Promise((resolve, reject) => {
        if (token.cancelled) {
            resolve(undefined);
            return;
        }
        function* wrapped() {
            try {
                for (;;) {
                    const step = generator.next();
                    if (step.done === true) {
                        resolve(step.value);
                        return;
                    }
                    touch(progress);
                    yield;
                }
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
 * @param {number} [ticks]
 * @returns {Promise<void>}
 */
export function nextTick(ticks = 1) {
    return new Promise((resolve) => {
        try {
            system.runTimeout(() => resolve(), ticks);
        } catch (_error) {
            resolve();
        }
    });
}

/** Which job token owns the current civilization ticking area (a stale job must never remove a newer job's hold). */
/** @type {Job | undefined} */
let holdOwner;
/** Incremented by every hold attempt, so a late engine callback can tell whether a newer hold exists. */
let holdGeneration = 0;

/** @param {Job | undefined} owner */
const cancelledNow = (owner) => owner !== undefined && owner.cancelled;

/** @param {unknown} error @param {string} reason */
const isReason = (error, reason) => {
    const e = /** @type {any} */ (error);
    return String(e?.reason ?? e?.message ?? e ?? "").includes(reason);
};

/**
 * Keep the chunks of `rect` loaded (replaces the previous civilization ticking area). The hold belongs to `owner`.
 * The wait is bounded: the engine resolves createTickingArea only when every chunk is loaded and gives no reason when it
 * does not, so the call races a timeout (CIV.holdTimeoutTicks), polling isFullyLoaded, and is retried CIV.holdRetries times.
 *
 * status: "held" | "nocapacity" (relying on loaded chunks) | "shrink" (over the chunk limit: use a smaller tile) |
 *         "stalled" (never loaded) | "cancelled" | "error".
 *
 * @param {Dimension} dimension
 * @param {Rect} rect
 * @param {Job | undefined} [owner]
 * @param {string} [id]
 * @param {Progress} [progress]
 * @returns {Promise<{ held: boolean, note: string | undefined, status: "held" | "nocapacity" | "shrink" | "stalled" | "cancelled" | "error" }>}
 */
export async function holdArea(dimension, rect, owner = undefined, id = CIV_TICKING_ID, progress = undefined) {
    if (cancelledNow(owner)) {
        return { held: false, note: "cancelled", status: "cancelled" };
    }
    const manager = world.tickingAreaManager;
    const options = { dimension, from: { x: rect.x0, y: 64, z: rect.z0 }, to: { x: rect.x1, y: 64, z: rect.z1 } };
    const chunks = chunksOfRect(rect);
    const attempts = 1 + Math.max(0, CIV.holdRetries);
    let idBackoffs = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (cancelledNow(owner)) {
            return { held: false, note: "cancelled", status: "cancelled" };
        }
        try {
            if (manager.hasTickingArea(id)) {
                manager.removeTickingArea(id);
            }
            if (!manager.hasCapacity(options)) {
                return { held: false, note: "no ticking-area capacity; relying on chunks that are already loaded", status: "nocapacity" };
            }
        } catch (error) {
            return { held: false, note: `ticking area unavailable (${String(error)}); relying on chunks that are already loaded`, status: "error" };
        }
        holdOwner = owner;
        holdGeneration += 1;
        const generation = holdGeneration;
        if (progress !== undefined) progress.chunksPending = chunks;
        const outcome = await raceCreate(manager, id, options, owner, generation, progress, chunks);
        if (progress !== undefined) progress.chunksPending = 0;
        if (outcome === "loaded") {
            touch(progress);
            return { held: true, note: undefined, status: "held" };
        }
        if (outcome === "cancelled") {
            if (holdOwner === owner || holdOwner === undefined) releaseArea(undefined, id);
            return { held: false, note: "cancelled", status: "cancelled" };
        }
        if (outcome === "timeout") {
            if (progress !== undefined) progress.stalls += 1;
            releaseArea(owner, id);
            note(progress, `ticking area at ${String(rect.x0)},${String(rect.z0)} did not finish loading in ${String(Math.round(CIV.holdTimeoutTicks / 20))} s (attempt ${String(attempt + 1)}/${String(attempts)})`);
            continue;
        }
        // an engine error
        const error = outcome.error;
        releaseArea(owner, id);
        if (isReason(error, "OverChunkLimit") || isReason(error, "SideLengthExceeded")) {
            return { held: false, note: `ticking area refused (${String(error)})`, status: "shrink" };
        }
        if (isReason(error, "IdentifierAlreadyExists")) {
            if (idBackoffs < 3) {
                idBackoffs += 1;
                await nextTick(CIV.idBackoffTicks);
                attempt -= 1;
                continue;
            }
            return { held: false, note: "ticking area identifier stayed in use", status: "error" };
        }
        return { held: false, note: `ticking area failed (${String(error)})`, status: "error" };
    }
    return { held: false, note: `ticking area at ${String(rect.x0)},${String(rect.z0)} never finished loading`, status: "stalled" };
}

/**
 * Race createTickingArea against the timeout, polling isFullyLoaded. A late engine resolution after we gave up removes
 * the area again unless a newer hold exists.
 *
 * @param {any} manager @param {string} id @param {any} options @param {Job | undefined} owner @param {number} generation @param {Progress | undefined} progress @param {number} chunks
 * @returns {Promise<"loaded" | "timeout" | "cancelled" | { error: unknown }>}
 */
function raceCreate(manager, id, options, owner, generation, progress, chunks) {
    return new Promise((resolve) => {
        let settled = false;
        /** @type {"loaded" | "timeout" | "cancelled" | "error" | undefined} */
        let outcome;
        const startTick = nowTick();
        /** @param {"loaded" | "timeout" | "cancelled" | { error: unknown }} value */
        const finish = (value) => {
            if (!settled) {
                settled = true;
                outcome = typeof value === "string" ? value : "error";
                resolve(value);
            }
        };
        const poll = () => {
            if (settled) return;
            if (cancelledNow(owner)) {
                finish("cancelled");
                return;
            }
            try {
                if (manager.getTickingArea?.(id)?.isFullyLoaded === true) {
                    finish("loaded");
                    return;
                }
            } catch (_error) {
                // polling is best effort
            }
            if (nowTick() - startTick >= CIV.holdTimeoutTicks) {
                finish("timeout");
                return;
            }
            if (progress !== undefined) progress.chunksPending = chunks;
            system.runTimeout(poll, 20);
        };
        system.runTimeout(poll, 20);
        let created;
        try {
            created = manager.createTickingArea(id, options);
        } catch (error) {
            finish({ error });
            return;
        }
        created.then(
            () => {
                if (settled) {
                    // resolved after we gave up (timeout / cancel): do not leave it behind unless a newer hold exists.
                    // If the poll already saw the area fully loaded, the hold was GRANTED and must stay.
                    if ((outcome === "timeout" || outcome === "cancelled") && generation === holdGeneration) {
                        releaseArea(undefined, id);
                    }
                    return;
                }
                finish(cancelledNow(owner) ? "cancelled" : "loaded");
            },
            (/** @type {unknown} */ error) => {
                finish({ error });
            },
        );
    });
}

/**
 * Remove the civilization ticking area. With an `owner` it only acts if that job still owns the hold;
 * without one it is unconditional (restart / tests / late callbacks).
 * @param {Job | undefined} [owner]
 * @param {string} [id]
 */
export function releaseArea(owner = undefined, id = CIV_TICKING_ID) {
    if (owner !== undefined && holdOwner !== owner) {
        return;
    }
    try {
        const manager = world.tickingAreaManager;
        if (manager.hasTickingArea(id)) {
            manager.removeTickingArea(id);
        }
    } catch (_error) {
        // nothing to release
    }
    holdOwner = undefined;
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
 * @param {Progress} [progress]
 * @returns {Generator<void, void, void>}
 */
function* readColumns(token, dimension, points, field, stats, progress = undefined) {
    const meter = { reads: 0 };
    const metered = meteredDimension(dimension, meter);
    let columns = 0;
    const endSlice = () => {
        stats.slices += 1;
        stats.reads += meter.reads;
        stats.maxReadsPerSlice = Math.max(stats.maxReadsPerSlice, meter.reads);
        stats.maxColumnsPerSlice = Math.max(stats.maxColumnsPerSlice, columns);
        if (progress !== undefined) progress.columnsScanned = stats.columns;
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

/** @param {Rect} r @returns {Rect[]} the four chunk-aligned quadrants of r (or [] if r is a single chunk) */
function quadrants(r) {
    const cx = Math.floor(r.x0 / 16);
    const cx1 = Math.floor(r.x1 / 16);
    const cz = Math.floor(r.z0 / 16);
    const cz1 = Math.floor(r.z1 / 16);
    if (cx === cx1 && cz === cz1) return [];
    const mx = cx === cx1 ? undefined : Math.floor((cx + cx1 + 1) / 2) * 16;
    const mz = cz === cz1 ? undefined : Math.floor((cz + cz1 + 1) / 2) * 16;
    /** @type {Rect[]} */
    const out = [];
    for (const [xa, xb] of mx === undefined ? [[r.x0, r.x1]] : [[r.x0, mx - 1], [mx, r.x1]]) {
        for (const [za, zb] of mz === undefined ? [[r.z0, r.z1]] : [[r.z0, mz - 1], [mz, r.z1]]) {
            out.push({ x0: /** @type {number} */ (xa), z0: /** @type {number} */ (za), x1: /** @type {number} */ (xb), z1: /** @type {number} */ (zb) });
        }
    }
    return out;
}

/** @param {Rect} r @returns {string} */
const rectText = (r) => `${String(r.x0)},${String(r.z0)} to ${String(r.x1)},${String(r.z1)}`;

/**
 * Message for a run abandoned because chunks would not load.
 * @param {ScanStats} stats @param {Rect} rect
 */
export function stallMessage(stats, rect) {
    let limit = "unknown";
    let count = "unknown";
    try {
        limit = String(world.tickingAreaManager.maxChunkCount);
        count = String(world.tickingAreaManager.chunkCount);
    } catch (_error) {
        // not exposed
    }
    return `The chunks around ${rectText(rect)} did not finish loading (${String(stats.stalledTiles.length)} of ${String(stats.attempted)} survey tiles stalled; each waited ${String(Math.round(CIV.holdTimeoutTicks / 20))} s, ${String(1 + CIV.holdRetries)} times). Ticking-area limit ${limit}, in use ${count}. Nothing was written and no column was guessed. Move to an area whose chunks are already generated, or try a smaller radius=, then run the command again; /scriptevent civ:generate_diag shows the engine's limits.`;
}

/**
 * Hold and read one tile (splitting it if the engine refuses its size). Returns "ok", "stalled" (skipped, unread),
 * "cancelled" or "aborted" (too many stalled tiles; stats.aborted says why).
 *
 * @param {Job} token @param {Dimension} dimension @param {Rect} rect
 * @param {(r: Rect) => Iterable<{ x: number, z: number }>} pointsOf
 * @param {GridField} field @param {ScanStats} stats @param {Progress | undefined} progress
 * @returns {Promise<"ok" | "stalled" | "cancelled" | "aborted">}
 */
async function surveyTile(token, dimension, rect, pointsOf, field, stats, progress) {
    /** @type {Rect[]} */
    const work = [rect];
    let result = /** @type {"ok" | "stalled" | "cancelled" | "aborted"} */ ("ok");
    while (work.length > 0) {
        const r = /** @type {Rect} */ (work.shift());
        if (progress !== undefined) progress.tile = r;
        const held = await holdArea(dimension, r, token, CIV_TICKING_ID, progress);
        if (token.cancelled || held.status === "cancelled") {
            return "cancelled";
        }
        stats.tiles += 1;
        if (held.status === "shrink") {
            const parts = quadrants(r);
            if (parts.length === 0) {
                stats.stalledTiles.push(r);
                if (progress !== undefined) progress.skippedTiles += 1;
                result = "stalled";
                continue;
            }
            note(progress, "the engine refused the tile size (chunk limit): using smaller tiles");
            work.unshift(...parts);
            continue;
        }
        stats.attempted += 1;
        if (held.status === "stalled") {
            stats.stalledTiles.push(r);
            stats.consecutiveStalls += 1;
            if (progress !== undefined) progress.skippedTiles += 1;
            result = "stalled";
            const ratio = stats.stalledTiles.length / stats.attempted;
            if (stats.consecutiveStalls >= 3 || (stats.attempted >= 4 && ratio > 0.25)) {
                stats.aborted = stallMessage(stats, r);
                return "aborted";
            }
            continue;
        }
        stats.consecutiveStalls = 0;
        if (held.status !== "held") {
            stats.unheldTiles += 1;
            if (held.note !== undefined && !stats.notes.includes(held.note)) {
                stats.notes.push(held.note);
                note(progress, held.note);
            }
        }
        await runJobAsync(token, readColumns(token, dimension, pointsOf(r), field, stats, progress), progress);
        if (token.cancelled) {
            return "cancelled";
        }
        stats.chunksScanned += chunksOfRect(r);
        if (progress !== undefined) progress.chunksScanned = stats.chunksScanned;
    }
    return result;
}

/**
 * Progressive, nearest-first, read-only coarse survey on a lattice of `step` blocks around `anchor`.
 * The tiles are scanned ring by ring (square half-extents `rings`, the last one being the full radius);
 * after each ring `evaluate(field, ringRadius, isLast)` may declare the survey finished (a site was found whose planning reach
 * is fully scanned), in which case the remaining tiles are not read at all.
 *
 * @param {Job} token
 * @param {Dimension} dimension
 * @param {{ x: number, z: number }} anchor
 * @param {number} radius full radius (square half-extent, blocks)
 * @param {number} step lattice spacing
 * @param {{
 *   rings?: number[], evaluate?: (field: GridField, ringRadius: number, last: boolean) => boolean,
 *   onTile?: (done: number, total: number) => void, tile?: number, progress?: Progress
 * }} [options]
 * @returns {Promise<{ field: GridField, stats: ScanStats, cancelled: boolean, scannedRadius: number, tilesTotal: number, early: boolean }>}
 */
export async function scanProgressive(token, dimension, anchor, radius, step, options = {}) {
    const progress = options.progress;
    const scanPlan = planScan(anchor, radius, step);
    const m = Math.ceil(radius / step);
    const half = Math.floor(step / 2);
    const field = makeGridField({ x0: scanPlan.anchor.x - m * step - half, z0: scanPlan.anchor.z - m * step - half, w: (2 * m + 1) * step, h: (2 * m + 1) * step, step });
    const stats = newScanStats();
    const tileSize = options.tile ?? tileSizeNow();
    const tiles = tilePoints(scanPlan.points, tileSize);
    const rings = options.rings === undefined || options.rings.length === 0 ? [radius] : options.rings;
    stats.tilesTotal = tiles.length;
    if (progress !== undefined) {
        progress.tilesTotal = tiles.length;
        progress.chunksTotal = tiles.reduce((sum, t) => sum + chunksOfRect(t.rect), 0);
    }
    const done = new Set();
    let scannedRadius = 0;
    let early = false;
    /** Lattice points a rect owns, and how many there are (a skipped tile's unread ground). */
    const pointsIn = (/** @type {Rect} */ r) => scanPlan.points.filter((p) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1);
    /** @param {Iterable<{ x: number, z: number }>} points @returns {number} */
    const countPoints = (points) => {
        let count = 0;
        for (const _point of points) {
            count += 1;
        }
        return count;
    };
    try {
        for (let k = 0; k < rings.length; k += 1) {
            const ring = /** @type {number} */ (rings[k]);
            const last = k === rings.length - 1;
            if (progress !== undefined) {
                progress.tilesPlanned = tiles.filter((tl) => !(tl.rect.x1 < anchor.x - ring || tl.rect.x0 > anchor.x + ring || tl.rect.z1 < anchor.z - ring || tl.rect.z0 > anchor.z + ring)).length;
            }
            for (let index = 0; index < tiles.length; index += 1) {
                const tile = /** @type {{ rect: Rect, points: { x: number, z: number }[] }} */ (tiles[index]);
                const r = tile.rect;
                if (done.has(index) || r.x1 < anchor.x - ring || r.x0 > anchor.x + ring || r.z1 < anchor.z - ring || r.z0 > anchor.z + ring) {
                    continue;
                }
                done.add(index);
                const outcome = await surveyTile(token, dimension, r, (sub) => tile.points.filter((p) => p.x >= sub.x0 && p.x <= sub.x1 && p.z >= sub.z0 && p.z <= sub.z1), field, stats, progress);
                if (outcome === "cancelled") {
                    return { field, stats, cancelled: true, scannedRadius, tilesTotal: tiles.length, early };
                }
                if (outcome === "aborted") {
                    return { field, stats, cancelled: false, scannedRadius, tilesTotal: tiles.length, early };
                }
                if (progress !== undefined) progress.tilesDone = done.size;
                options.onTile?.(done.size, tiles.length);
            }
            scannedRadius = ring;
            stats.ringsDone = k + 1;
            if (options.evaluate?.(field, ring, last) === true) {
                early = !last;
                break;
            }
        }

        // A tile the engine could not generate in time is not lost: by the time the rest of the scan has run,
        // its neighbours exist, so ask for it once more. Read-only and bounded - a tile that still refuses
        // stays in stalledTiles, its columns stay unread, and skippedColumns says how many were never read.
        if (stats.stalledTiles.length > 0 && !cancelledNow(token)) {
            const pending = stats.stalledTiles.splice(0);
            stats.retriedTiles = pending.length;
            stats.consecutiveStalls = 0;
            const knownBefore = field.columnsRead;
            // The retry attempts are reported as retriedTiles, not as extra surveyed tiles.
            const attemptedBefore = stats.attempted;
            const tilesBefore = stats.tiles;
            for (const r of pending) {
                const outcome = await surveyTile(token, dimension, r, pointsIn, field, stats, progress);
                if (outcome === "cancelled") {
                    return { field, stats, cancelled: true, scannedRadius, tilesTotal: tiles.length, early };
                }
                if (outcome === "aborted") {
                    return { field, stats, cancelled: false, scannedRadius, tilesTotal: tiles.length, early };
                }
            }
            stats.attempted = attemptedBefore;
            stats.tiles = tilesBefore;
            stats.recoveredTiles = field.columnsRead - knownBefore;
        }
        stats.skippedColumns = stats.stalledTiles.reduce((sum, r) => sum + countPoints(pointsIn(r)), 0);
    } finally {
        releaseArea(token);
    }
    return { field, stats, cancelled: false, scannedRadius, tilesTotal: tiles.length, early };
}

/**
 * Whole-radius coarse survey (one ring, no early exit). Kept for tools and tests.
 * @param {Job} token @param {Dimension} dimension @param {{ x: number, z: number }} anchor @param {number} radius @param {number} step
 * @param {{ onTile?: (done: number, total: number) => void, tile?: number, progress?: Progress }} [options]
 */
export async function scanCoarse(token, dimension, anchor, radius, step, options = {}) {
    return scanProgressive(token, dimension, anchor, radius, step, options);
}

/**
 * Full-resolution (one sample per block column) read-only survey of a rectangle into a
 * step-1 ground field. Tiles are held one at a time; a tile that never loads is skipped and its columns stay unread.
 *
 * @param {Job} token
 * @param {Dimension} dimension
 * @param {Rect} rect inclusive block bounds
 * @param {{ onTile?: (done: number, total: number) => void, tile?: number, progress?: Progress }} [options]
 * @returns {Promise<{ field: GridField, stats: ScanStats, cancelled: boolean }>}
 */
export async function scanFull(token, dimension, rect, options = {}) {
    const progress = options.progress;
    const field = makeGridField({ x0: rect.x0, z0: rect.z0, w: rect.x1 - rect.x0 + 1, h: rect.z1 - rect.z0 + 1, step: 1 });
    const stats = newScanStats();
    const tile = options.tile ?? tileSizeNow();
    /** @type {Rect[]} */
    const tiles = [];
    for (let z = Math.floor(rect.z0 / tile) * tile; z <= rect.z1; z += tile) {
        for (let x = Math.floor(rect.x0 / tile) * tile; x <= rect.x1; x += tile) {
            tiles.push({ x0: Math.max(rect.x0, x), z0: Math.max(rect.z0, z), x1: Math.min(rect.x1, x + tile - 1), z1: Math.min(rect.z1, z + tile - 1) });
        }
    }
    stats.tilesTotal = tiles.length;
    if (progress !== undefined) {
        progress.tilesDone = 0;
        progress.tilesTotal = tiles.length;
        progress.tilesPlanned = tiles.length;
        progress.chunksScanned = 0;
        progress.chunksTotal = tiles.reduce((sum, t) => sum + chunksOfRect(t), 0);
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
            const outcome = await surveyTile(token, dimension, area, rectPoints, field, stats, progress);
            if (outcome === "cancelled") {
                return { field, stats, cancelled: true };
            }
            if (outcome === "aborted") {
                return { field, stats, cancelled: false };
            }
            if (progress !== undefined) progress.tilesDone = index + 1;
            options.onTile?.(index + 1, tiles.length);
        }
    } finally {
        releaseArea(token);
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
