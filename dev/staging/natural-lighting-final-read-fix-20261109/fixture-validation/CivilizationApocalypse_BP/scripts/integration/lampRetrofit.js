import { BlockPermutation, world } from "@minecraft/server";
import { DISTRICT_NAMES } from "../config.js";
import { LAMP_ID, LAMP_RETROFIT, chooseLampSpot, createLampIndex, firstGridAt, isLampStand, isLantern, wallLampSamples } from "../civ/lamps.js";
import { siteGroundRegion } from "../civ/siteprofile.js";
import { loadMasterPlan } from "./civBuilder.js";
import { activeKind, activeToken, cancelActiveJob, finishJob, isBusy, reserveJob } from "./districtBuilder.js";
import { CIV_TICKING_ID, holdArea, releaseArea, runJobAsync, tileSizeNow } from "./civScan.js";
import { nowTick } from "./civProgress.js";

/**
 * The lamp retrofit: light the districts that were built before `civ/districtplan.js` placed lamps.
 *
 * Read-only planning is impossible here - the stored site record is pinned to the planner that built the
 * district, and re-planning it after the lighting change refuses the checksum. So the retrofit works from the
 * world itself: for every grid point in a district's region, the topmost block is the surface, and a lantern
 * goes one block above it if that cell is air. `civ/lamps.js` owns the rules (what is a stand, how far a grid
 * point may relocate); this file owns the Minecraft side:
 *
 *  - one district at a time, through the SAME single job slot the builder uses (a build and a lamp run can
 *    never interleave), holding one 128-block tile at a time;
 *  - place-only: every target is re-read immediately before the write and skipped unless it is still air, so
 *    nothing a player or the build placed is ever replaced;
 *  - sliced: a tile yields every few hundred grid points, so a district costs many short ticks, not one long
 *    one;
 *  - resumable: `civ:lamps:<district>` stores the tile cursor and counters, and a paused or stopped run
 *    continues from that tile on the next `civ:lights`. A rerun over a finished tile places nothing, because a
 *    grid point that already has a lantern in its ring reports "already".
 *
 * What it does not reach: covered spaces. A room or alley whose ceiling is above it has that ceiling as its
 * topmost block, so the lantern lands on the roof, not under it; and a tree canopy hides the ground beneath
 * it the same way. Both are stated in the run's report rather than papered over.
 */

/** Dynamic property per district: { state, tile, tiles, done, placed, already, skipped, unloaded, ... }. */
export const LAMP_STATE_PREFIX = "civ:lamps:";
const AIR_ID = "minecraft:air";
/**
 * Work one slice may do, in block operations (a read, or a read plus a write). `CIV_LIMITS.maxReadsPerSlice`
 * is 1500; a grid point costs at most two 25-cell rings, so this stays under it even in the worst case.
 */
const OPS_PER_SLICE = 1200;
const MAX_Y = 319;

/** @typedef {{ index: number, state: "running" | "paused" | "cancelled" | "done" | "failed", tile: number, tiles: number, done: number, placed: number, walls: number, fills: number, already: number, skipped: number, unloaded: number, reason?: string, updatedTick: number, spacing: number, relocate: number }} LampRunState */

/** @type {{ index: number, token: any, state: LampRunState, dimension: any, say: (lines: string[]) => void, tiles: any[], wallTiles: { x: number, z: number }[][], region: any, lamps: ReturnType<typeof createLampIndex>, onEnd?: (state: LampRunState) => void } | undefined} */
let current;

/** @param {number} index */
export function lampStateKey(index) {
    return `${LAMP_STATE_PREFIX}${String(index)}`;
}

/**
 * @param {number} index
 * @returns {LampRunState | undefined}
 */
export function readLampState(index) {
    let raw;
    try {
        raw = world.getDynamicProperty(lampStateKey(index));
    } catch (_error) {
        return undefined;
    }
    if (typeof raw !== "string") {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") {
            return undefined;
        }
        return /** @type {LampRunState} */ (parsed);
    } catch (_error) {
        return undefined;
    }
}

/** @param {number} index @param {LampRunState} state */
function writeLampState(index, state) {
    try {
        world.setDynamicProperty(lampStateKey(index), JSON.stringify(state));
    } catch (_error) {
        // a status write is never worth failing the run for; the counters in memory stay correct
    }
}

/** The district a lamp run is working on, if any. */
export function activeLampIndex() {
    return current?.index;
}

/**
 * Start (or resume) the retrofit for one district. Refuses while any other job owns the slot, because both
 * jobs use the one civilization ticking area.
 *
 * @param {{ index: number, dimension: any, say: (lines: string[]) => void, onEnd?: (state: LampRunState) => void, restart?: boolean }} options
 * @returns {{ ok: boolean, reason?: string, state?: LampRunState, tiles?: number }}
 */
export function startLampRetrofit(options) {
    const { index, dimension, say } = options;
    if (current !== undefined) {
        return { ok: false, reason: "a lamp run is already going; wait for it or stop it with /scriptevent civ:lights_abort" };
    }
    if (isBusy()) {
        return { ok: false, reason: `another job (${String(activeKind())}) is running - wait for it to finish or stop it first` };
    }
    const master = loadMasterPlan();
    if (master.plan === undefined) {
        return { ok: false, reason: `this world holds no five-district master plan (civ:plan reads '${String(master.status)}')` };
    }
    const entry = /** @type {any[]} */ (master.plan.districts ?? []).find((district) => district?.index === index);
    if (entry === undefined) {
        return { ok: false, reason: `the stored master plan holds no district ${String(index)}` };
    }
    /** @type {{ x0: number, z0: number, x1: number, z1: number }} */
    let region;
    try {
        region = siteGroundRegion(master.plan, index, 0);
    } catch (error) {
        return { ok: false, reason: `district ${String(index)} has no region in the master plan (${String(error)})` };
    }
    const token = reserveJob("civ-lamps");
    if (token === undefined) {
        return { ok: false, reason: "another job is already running" };
    }
    const tiles = tilesOf(region, tileSizeNow());
    // The master plan's wall paths are the one exact piece of an old district left, so the wall tops are lit
    // from them rather than from a grid that mostly misses a 3-wide line ~8 blocks above the street.
    /** @type {{ x: number, z: number }[][]} */
    const wallTiles = tiles.map(() => []);
    let wallSamples = 0;
    for (const wall of /** @type {any[]} */ (master.plan.walls ?? [])) {
        if (!(/** @type {any[]} */ (Array.isArray(wall?.between) ? wall.between : [])).includes(index)) {
            continue;
        }
        for (const sample of wallLampSamples(wall.path, { closed: wall.closed === true })) {
            wallSamples += 1;
            const at = tiles.findIndex((tile) => sample.x >= tile.x0 && sample.x <= tile.x1 && sample.z >= tile.z0 && sample.z <= tile.z1);
            if (at >= 0) {
                wallTiles[at].push(sample);
            }
        }
    }
    const previous = options.restart === true ? undefined : readLampState(index);
    const resumable =
        previous !== undefined &&
        previous.state !== "done" &&
        previous.spacing === LAMP_RETROFIT.spacing &&
        previous.relocate === LAMP_RETROFIT.relocate &&
        Number.isInteger(previous.tiles) &&
        previous.tiles === tiles.length &&
        Number.isInteger(previous.done) &&
        previous.done > 0 &&
        previous.done <= tiles.length;
    /** @type {LampRunState} */
    const state = {
        index,
        state: "running",
        tile: 0,
        tiles: tiles.length,
        done: resumable ? Number(previous.done) : 0,
        placed: resumable ? Number(previous.placed) || 0 : 0,
        walls: resumable ? Number(previous.walls) || 0 : 0,
        fills: resumable ? Number(previous.fills) || 0 : 0,
        already: resumable ? Number(previous.already) || 0 : 0,
        skipped: resumable ? Number(previous.skipped) || 0 : 0,
        unloaded: resumable ? Number(previous.unloaded) || 0 : 0,
        spacing: LAMP_RETROFIT.spacing,
        relocate: LAMP_RETROFIT.relocate,
        updatedTick: nowTick(),
    };
    writeLampState(index, state);
    const name = DISTRICT_NAMES[index - 1] ?? `district-${String(index)}`;
    say([
        `${resumable ? "Resuming" : "Lighting"} ${name}: ${String(tiles.length)} tile(s), grid ${String(state.spacing)} (relocate ${String(state.relocate)}) plus ${String(wallSamples)} wall sample(s), ${String(state.done)} already done.`,
        "Lanterns are placed only into air cells; no block that already stands is replaced. Rerun the command any time - a lit spot is left alone.",
    ]);
    current = { index, token, state, dimension, say, tiles, wallTiles, region, lamps: createLampIndex(), onEnd: options.onEnd };
    void run();
    return { ok: true, state, tiles: tiles.length };
}

/**
 * Stop the run. The blocks already placed stay (this is additive); the saved cursor lets a later command
 * continue from the tile that was in progress.
 * @returns {{ ok: boolean, reason?: string, state?: LampRunState }}
 */
export function abortLampRetrofit() {
    const run = current;
    if (run === undefined || activeToken() !== run.token) {
        return { ok: false, reason: "no lamp run is active" };
    }
    run.state.state = "cancelled";
    run.state.reason = "stopped by the operator";
    run.state.updatedTick = nowTick();
    writeLampState(run.index, run.state);
    run.token.cancelled = true;
    if (activeKind() === "civ-lamps") {
        cancelActiveJob();
    }
    releaseArea(run.token);
    finishJob(run.token);
    current = undefined;
    return { ok: true, state: run.state };
}

/**
 * @param {{ x0: number, z0: number, x1: number, z1: number }} region
 * @param {number} side
 */
export function tilesOf(region, side) {
    const x0 = Math.floor(region.x0 / side) * side;
    const z0 = Math.floor(region.z0 / side) * side;
    /** @type {{ x0: number, z0: number, x1: number, z1: number }[]} */
    const tiles = [];
    for (let z = z0; z <= region.z1; z += side) {
        for (let x = x0; x <= region.x1; x += side) {
            tiles.push({ x0: Math.max(x, region.x0), z0: Math.max(z, region.z0), x1: Math.min(x + side - 1, region.x1), z1: Math.min(z + side - 1, region.z1) });
        }
    }
    return tiles;
}

/** @param {any} dimension @param {number} x @param {number} z */
function topAt(dimension, x, z) {
    let top;
    try {
        top = dimension.getTopmostBlock({ x, z });
    } catch (_error) {
        return undefined;
    }
    if (top === undefined || top.isValid === false) {
        return undefined;
    }
    let id;
    try {
        id = top.typeId;
    } catch (_error) {
        return undefined;
    }
    return { x, y: top.location.y, z, id };
}

/**
 * @param {any} dimension @param {{ x: number, y: number, z: number }} spot @param {any} lantern
 * @returns {"placed" | "occupied" | "unloaded" | "failed"}
 */
function placeLantern(dimension, spot, lantern) {
    if (spot.y > MAX_Y) {
        return "occupied";
    }
    let block;
    try {
        block = dimension.getBlock({ x: spot.x, y: spot.y, z: spot.z });
    } catch (_error) {
        return "unloaded";
    }
    if (block === undefined || block.isValid === false) {
        return "unloaded";
    }
    let id;
    try {
        id = block.typeId;
    } catch (_error) {
        return "unloaded";
    }
    // Place-only: a cell that stopped being air since the surface read is left exactly as it is.
    if (id !== AIR_ID) {
        return "occupied";
    }
    try {
        block.setPermutation(lantern);
    } catch (_error) {
        return "failed";
    }
    return "placed";
}

/**
 * One tile's grid points. Synchronous and sliced - the caller runs it as one `system.runJob`.
 *
 * @param {any} dimension
 * @param {{ x0: number, z0: number, x1: number, z1: number }} region
 * @param {{ x0: number, z0: number, x1: number, z1: number }} tile
 * @param {any} lantern
 * @param {{ x: number, z: number }[]} wallSamples
 * @param {ReturnType<typeof createLampIndex>} lamps every light this run has placed or found
 */
function* tileJob(dimension, region, tile, lantern, wallSamples, lamps) {
    const spacing = LAMP_RETROFIT.spacing;
    const counts = { placed: 0, walls: 0, fills: 0, already: 0, skipped: 0, unloaded: 0 };
    let work = 0;
    const read = (/** @type {number} */ x, /** @type {number} */ z) => {
        work += 1;
        return topAt(dimension, x, z);
    };
    const z1 = Math.min(tile.z1, region.z1);
    const x1 = Math.min(tile.x1, region.x1);
    for (let gz = firstGridAt(Math.max(tile.z0, region.z0), region.z0, spacing); gz <= z1; gz += spacing) {
        for (let gx = firstGridAt(Math.max(tile.x0, region.x0), region.x0, spacing); gx <= x1; gx += spacing) {
            const decision = chooseLampSpot(read, gx, gz, { relocate: LAMP_RETROFIT.relocate, maxY: MAX_Y });
            if (decision.state === "lamp") {
                work += 2; // the placement's own read + write
                const outcome = placeLantern(dimension, { x: Number(decision.x), y: Number(decision.y), z: Number(decision.z) }, lantern);
                if (outcome === "placed") {
                    counts.placed += 1;
                    lamps.add({ x: Number(decision.x), y: Number(decision.y), z: Number(decision.z) });
                } else if (outcome === "unloaded") {
                    counts.unloaded += 1;
                } else {
                    counts.skipped += 1;
                }
            } else if (decision.state === "already") {
                counts.already += 1;
                lamps.add({ x: Number(decision.x), y: Number(decision.y), z: Number(decision.z) });
            } else if (decision.state === "unloaded") {
                counts.unloaded += 1;
            } else {
                counts.skipped += 1;
            }
            if (work >= OPS_PER_SLICE) {
                work = 0;
                yield;
            }
        }
    }
    // The wall tops, along the master plan's own path. No relocation here: a lamp that slid off the wall
    // would light the street it already lights and leave the wall dark.
    for (const sample of wallSamples) {
        work += 1;
        const decision = chooseLampSpot(read, sample.x, sample.z, { relocate: 0, maxY: MAX_Y });
        if (decision.state === "lamp") {
            work += 2;
            const outcome = placeLantern(dimension, { x: Number(decision.x), y: Number(decision.y), z: Number(decision.z) }, lantern);
            if (outcome === "placed") {
                counts.placed += 1;
                counts.walls += 1;
                lamps.add({ x: Number(decision.x), y: Number(decision.y), z: Number(decision.z) });
            } else if (outcome === "unloaded") {
                counts.unloaded += 1;
            } else {
                counts.skipped += 1;
            }
        } else if (decision.state === "already") {
            counts.already += 1;
            lamps.add({ x: Number(decision.x), y: Number(decision.y), z: Number(decision.z) });
        } else if (decision.state === "unloaded") {
            counts.unloaded += 1;
        } else {
            counts.skipped += 1;
        }
        if (work >= OPS_PER_SLICE) {
            work = 0;
            yield;
        }
    }
    // The coverage pass. A grid point only lights the level it was planned for: an isolated ledge, a roof
    // smaller than the grid or a raised wall cell can sit more than a lamp's reach above the street and stay
    // dark. Every standing surface in the tile is therefore measured against every light this run knows about
    // (grid lamps, wall lamps, lanterns already in the world) and gets its own lantern when nothing reaches it.
    // A column that already carries a lantern is added to that set, which is what makes a rerun a no-op.
    for (let z = tile.z0; z <= tile.z1; z += 1) {
        for (let x = tile.x0; x <= tile.x1; x += 1) {
            work += 1;
            const top = topAt(dimension, x, z);
            if (top === undefined) {
                counts.unloaded += 1;
            } else if (isLantern(top.id)) {
                lamps.add({ x: top.x, y: top.y, z: top.z });
            } else if (isLampStand(top.id)) {
                const cell = { x, y: top.y + 1, z };
                work += 1; // the coverage check
                if (cell.y > MAX_Y) {
                    counts.skipped += 1;
                } else if (!lamps.covers(cell)) {
                    work += 2;
                    const outcome = placeLantern(dimension, cell, lantern);
                    if (outcome === "placed") {
                        counts.placed += 1;
                        counts.fills += 1;
                        lamps.add(cell);
                    } else if (outcome === "unloaded") {
                        counts.unloaded += 1;
                    } else {
                        counts.skipped += 1;
                    }
                }
            }
            if (work >= OPS_PER_SLICE) {
                work = 0;
                yield;
            }
        }
    }
    return counts;
}

/** The async driver: one held tile at a time, saving the cursor after each. */
async function run() {
    const session = current;
    if (session === undefined) {
        return;
    }
    const { index, token, state, dimension, say, tiles, wallTiles, region, lamps } = session;
    const name = DISTRICT_NAMES[index - 1] ?? `district-${String(index)}`;
    /** @type {any} */
    let lantern;
    try {
        lantern = BlockPermutation.resolve(LAMP_ID);
    } catch (_error) {
        lantern = undefined;
    }
    try {
        for (let ti = state.done; ti < tiles.length; ti += 1) {
            if (token.cancelled) {
                state.state = "cancelled";
                break;
            }
            const tile = tiles[ti];
            const held = await holdArea(dimension, tile, token, CIV_TICKING_ID);
            if (token.cancelled) {
                state.state = "cancelled";
                break;
            }
            if (held.status === "stalled" || held.status === "shrink") {
                state.state = "paused";
                state.reason = `the chunks around ${String(tile.x0)},${String(tile.z0)} would not load (${String(held.note)})`;
                say([`Lighting paused: ${state.reason}.`, `${String(state.done)} of ${String(tiles.length)} tiles are done and saved; run /scriptevent civ:lights district=${String(index)} again when the area loads.`]);
                break;
            }
            if (held.note !== undefined) {
                say([`  ${held.note}`]);
            }
            state.tile = ti;
            if (lantern === undefined) {
                state.state = "failed";
                state.reason = "the game refused minecraft:lantern as a block permutation";
                break;
            }
            const counts = await runJobAsync(token, tileJob(dimension, region, tile, lantern, wallTiles[ti] ?? [], lamps));
            if (token.cancelled) {
                state.state = "cancelled";
                break;
            }
            if (counts === undefined) {
                state.state = "paused";
                state.reason = "the run was interrupted";
                break;
            }
            state.placed += counts.placed;
            state.walls += counts.walls;
            state.fills += counts.fills;
            state.already += counts.already;
            state.skipped += counts.skipped;
            state.unloaded += counts.unloaded;
            state.done = ti + 1;
            state.updatedTick = nowTick();
            writeLampState(index, state);
            say([
                `  ${name} tile ${String(ti + 1)}/${String(tiles.length)}: ${String(counts.placed)} lantern(s) placed, ${String(counts.already)} already lit, ${String(counts.skipped)} skipped, ${String(counts.unloaded)} unloaded.`,
            ]);
        }
        if (state.state === "running" && state.done >= tiles.length) {
            state.state = "done";
        }
    } catch (error) {
        state.state = "failed";
        state.reason = String(error);
    } finally {
        // A cancelled run is cleaned up by abortLampRetrofit (its promise never settles); this is the normal path.
        if (current === session) {
            releaseArea(token);
            finishJob(token);
            state.updatedTick = nowTick();
            writeLampState(index, state);
            if (state.state === "done") {
                say([
                    `=== ${name} is lit ===`,
                    `Lanterns placed: ${String(state.placed)} (${String(state.walls)} on wall tops, ${String(state.fills)} on raised surfaces the grid could not reach); already lit: ${String(state.already)}; skipped (no stand, or the cell was no longer air): ${String(state.skipped)}; unloaded: ${String(state.unloaded)}.`,
                    "Covered spaces (a room or an alley under a roof, ground under a tree canopy) are not reached by this pass: their top block is the roof or the leaves.",
                ]);
            } else if (state.state === "paused" || state.state === "failed") {
                say([`Lighting ${name} stopped: ${String(state.reason ?? state.state)}.`, `${String(state.placed)} lantern(s) were placed; the cursor is saved at tile ${String(state.done)} of ${String(tiles.length)}.`]);
            }
            const end = session.onEnd;
            current = undefined;
            end?.(state);
        }
    }
}
