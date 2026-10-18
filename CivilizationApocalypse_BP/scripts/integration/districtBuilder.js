import { BlockPermutation, system, world } from "@minecraft/server";
import { PHYSICAL } from "../config.js";
import { classifyCell } from "../structures/siteRules.js";
import { classifyTerrainCell } from "../structures/terrain.js";

/**
 * Bedrock boundary for the physical district: chunk holding, a read-only site scan, and a
 * budgeted, idempotent block placer. Everything else (what to build, where the roads go,
 * whether a cell is safe to touch) is decided by pure code under structures/.
 *
 * Safety rules enforced here:
 *  - nothing is written by the scan;
 *  - the placer re-classifies every cell immediately before writing it, so a cell that
 *    became occupied after the scan is refused, never overwritten;
 *  - cells that already hold the planned block are accepted (so a resume is safe);
 *  - work is time-sliced with system.runJob and bounded by PHYSICAL.blocksPerSlice;
 *  - only one job runs at a time; no Block reference is held across a yield.
 */

/**
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {{ x: number, y: number, z: number }} Vec3
 * @typedef {{ x: number, y: number, z: number, id: string, states?: Record<string, any> }} PlannedBlock
 * @typedef {{ blocks: PlannedBlock[], half: number, bounds: { max: { y: number } } }} Plan
 */

/** @typedef {{ kind: string, jobId: number | undefined, cancelled: boolean }} Job */

/** @type {Job | undefined} */
let active;

/**
 * Claim the single job slot before any asynchronous setup, so two commands in one tick cannot
 * both start. Released by cancelActiveJob() or replaced by the scan/build job that follows.
 * @param {string} kind
 */
export function reserveJob(kind) {
    if (active !== undefined) {
        return undefined;
    }
    active = { kind, jobId: undefined, cancelled: false };
    return active;
}

/**
 * Release the job slot if `token` still owns it (a cancelled/replaced token never frees a newer job).
 * @param {Job} token
 */
export function finishJob(token) {
    if (active === token) {
        active = undefined;
    }
}

export function isBusy() {
    return active !== undefined;
}

export function activeKind() {
    return active?.kind;
}

/** Stop the running job (blocks already placed stay; a build can be resumed). */
export function cancelActiveJob() {
    if (active === undefined) {
        return false;
    }
    active.cancelled = true;
    if (active.jobId !== undefined) {
        try {
            system.clearJob(active.jobId);
        } catch (_error) {
            // the job already finished
        }
    }
    active = undefined;
    return true;
}

/**
 * Ask the engine to keep the footprint's chunks loaded while we work.
 * @param {Dimension} dimension
 * @param {Vec3} origin
 * @param {number} half
 * @returns {Promise<{ held: boolean, note: string | undefined }>}
 */
export async function holdChunks(dimension, origin, half) {
    const manager = world.tickingAreaManager;
    const options = {
        dimension,
        from: { x: origin.x - half - 1, y: origin.y, z: origin.z - half - 1 },
        to: { x: origin.x + half + 1, y: origin.y, z: origin.z + half + 1 },
    };
    try {
        if (manager.hasTickingArea(PHYSICAL.tickingAreaId)) {
            manager.removeTickingArea(PHYSICAL.tickingAreaId);
        }
        if (!manager.hasCapacity(options)) {
            return { held: false, note: "no ticking-area capacity; relying on chunks already loaded around you" };
        }
        await manager.createTickingArea(PHYSICAL.tickingAreaId, options);
        return { held: true, note: undefined };
    } catch (error) {
        return { held: false, note: `ticking area unavailable (${String(error)}); relying on chunks already loaded around you` };
    }
}

export function releaseChunks() {
    try {
        const manager = world.tickingAreaManager;
        if (manager.hasTickingArea(PHYSICAL.tickingAreaId)) {
            manager.removeTickingArea(PHYSICAL.tickingAreaId);
        }
    } catch (_error) {
        // nothing to release
    }
}

/**
 * @param {Dimension} dimension
 * @param {Vec3} position
 * @returns {string | undefined} the block type id, or undefined if the chunk is not loaded
 */
function typeIdAt(dimension, position) {
    try {
        const block = dimension.getBlock(position);
        if (block === undefined || block.isValid === false) {
            return undefined;
        }
        return block.typeId;
    } catch (_error) {
        return undefined;
    }
}

/**
 * @typedef {{
 *   done: boolean, planned: number, toPlace: number, alreadyBuilt: number, unloaded: number,
 *   conflicts: number, samples: string[]
 * }} ScanResult
 */

/**
 * Read-only survey of the site. Every plan cell is classified, and every empty footprint cell
 * up to the tallest planned block must be free of obstructions.
 *
 * @param {Job} token the reservation from reserveJob()
 * @param {Dimension} dimension
 * @param {Vec3} origin
 * @param {Plan} plan
 * @param {(result: ScanResult) => void} onDone
 */
export function startScan(token, dimension, origin, plan, onDone) {
    if (active !== token || token.cancelled) {
        return false;
    }
    const job = token;
    job.kind = "scan";
    /** @type {ScanResult} */
    const result = { done: false, planned: plan.blocks.length, toPlace: 0, alreadyBuilt: 0, unloaded: 0, conflicts: 0, samples: [] };

    /** @param {string} text */
    const note = (text) => {
        if (result.samples.length < 6) {
            result.samples.push(text);
        }
    };

    function* generator() {
        try {
            const planned = new Set();
            let sinceYield = 0;
            for (const block of plan.blocks) {
                if (job.cancelled) {
                    return;
                }
                planned.add(`${String(block.x)},${String(block.y)},${String(block.z)}`);
                const position = { x: origin.x + block.x, y: origin.y + block.y, z: origin.z + block.z };
                const verdict = classifyCell({ plannedId: block.id, y: block.y, existingId: typeIdAt(dimension, position) });
                if (verdict.built) {
                    result.alreadyBuilt += 1;
                } else if (verdict.ok) {
                    result.toPlace += 1;
                } else if (verdict.reason === "unloaded") {
                    result.unloaded += 1;
                } else {
                    result.conflicts += 1;
                    note(`(${String(position.x)}, ${String(position.y)}, ${String(position.z)}) ${String(verdict.reason)}`);
                }
                sinceYield += 1;
                if (sinceYield >= PHYSICAL.scanPerSlice) {
                    sinceYield = 0;
                    yield;
                }
            }
            // Headroom: any footprint cell the plan leaves empty must also be free.
            for (let y = 0; y <= plan.bounds.max.y; y += 1) {
                for (let x = -plan.half; x <= plan.half; x += 1) {
                    for (let z = -plan.half; z <= plan.half; z += 1) {
                        if (job.cancelled) {
                            return;
                        }
                        if (planned.has(`${String(x)},${String(y)},${String(z)}`)) {
                            continue;
                        }
                        const position = { x: origin.x + x, y: origin.y + y, z: origin.z + z };
                        const verdict = classifyCell({ y, existingId: typeIdAt(dimension, position) });
                        if (!verdict.ok) {
                            if (verdict.reason === "unloaded") {
                                result.unloaded += 1;
                            } else {
                                result.conflicts += 1;
                                note(`(${String(position.x)}, ${String(position.y)}, ${String(position.z)}) ${String(verdict.reason)}`);
                            }
                        }
                        sinceYield += 1;
                        if (sinceYield >= PHYSICAL.scanPerSlice) {
                            sinceYield = 0;
                            yield;
                        }
                    }
                }
            }
        } catch (error) {
            result.conflicts += 1;
            note(`scan failed: ${String(error)}`);
        }
        result.done = true;
        if (!job.cancelled) {
            onDone(result);
        }
    }

    job.jobId = system.runJob(generator());
    return true;
}

/**
 * @typedef {{
 *   cursor: number, total: number, placed: number, alreadyBuilt: number, refused: number,
 *   failed: number, degraded: number, samples: string[],
 *   phase: "terrain" | "structure", progress: number, progressTotal: number, terrainTotal: number
 * }} BuildState
 * @typedef {{
 *   centre: { x: number, z: number },
 *   clear: { x: number, y: number, z: number }[],
 *   ops: import("../structures/terrain.js").TerrainOp[]
 * }} TerrainWork
 * @typedef {{
 *   onSlice: (state: BuildState) => void,
 *   onPhase?: (phase: "structure", state: BuildState) => void,
 *   onStopped: (reason: string, state: BuildState) => void,
 *   onDone: (state: BuildState) => void
 * }} BuildHooks
 */

/**
 * Place the plan from `cursor` onward.
 *
 * @param {Job} token the reservation from reserveJob()
 * @param {Dimension} dimension
 * @param {Vec3} origin
 * @param {Plan} plan
 * @param {number} cursor index into plan.blocks to start from
 * @param {BuildHooks} hooks
 * @param {TerrainWork} [terrain] terrain preparation to apply before any structure block
 */
export function startBuild(token, dimension, origin, plan, cursor, hooks, terrain) {
    if (active !== token || token.cancelled) {
        return undefined;
    }
    const job = token;
    job.kind = "build";
    cursor = Math.max(0, Math.min(cursor, plan.blocks.length));
    /** @type {BuildState} */
    const state = { cursor, total: plan.blocks.length, placed: 0, alreadyBuilt: 0, refused: 0, failed: 0, degraded: 0, samples: [], phase: "structure", progress: cursor, progressTotal: plan.blocks.length, terrainTotal: 0 };
    /** @type {{ x: number, y: number, z: number, id: string, kind: "clear" | "cut" | "fill" | "top" }[]} */
    const terrainList = terrain
        ? [
              ...terrain.clear.map((cell) => ({ x: cell.x, y: cell.y, z: cell.z, id: "minecraft:air", kind: /** @type {"clear"} */ ("clear") })),
              ...terrain.ops.map((op) => ({ x: terrain.centre.x + op.x, y: op.y, z: terrain.centre.z + op.z, id: op.id, kind: op.kind })),
          ]
        : [];
    if (terrainList.length > 0) {
        state.phase = "terrain";
        state.terrainTotal = terrainList.length;
        state.progressTotal += terrainList.length;
    }
    /** @type {Map<string, any>} */
    const permutations = new Map();

    /** @param {string} text */
    const note = (text) => {
        if (state.samples.length < 6) {
            state.samples.push(text);
        }
    };

    /** @param {PlannedBlock} block */
    const permutationFor = (block) => {
        const key = `${block.id}|${block.states ? JSON.stringify(block.states) : ""}`;
        let permutation = permutations.get(key);
        if (permutation === undefined) {
            try {
                permutation = BlockPermutation.resolve(block.id, /** @type {any} */ (block.states));
            } catch (error) {
                // A state we got wrong must not abort the district: fall back to the plain block.
                state.degraded += 1;
                note(`${block.id}: states rejected (${String(error)}); placed without states`);
                permutation = BlockPermutation.resolve(block.id);
            }
            permutations.set(key, permutation);
        }
        return permutation;
    };

    function* generator() {
        let sinceYield = 0;
        let waiting = 0;
        try {
            // Phase 1: terrain preparation (clear vegetation/trees, cut, fill, resurface). Every cell is
            // re-classified against the live world right before it is written.
            for (let index = 0; index < terrainList.length; ) {
                if (job.cancelled) {
                    return;
                }
                const op = /** @type {{ x: number, y: number, z: number, id: string, kind: "clear" | "cut" | "fill" | "top" }} */ (terrainList[index]);
                let target;
                try {
                    target = dimension.getBlock({ x: op.x, y: op.y, z: op.z });
                } catch (_error) {
                    target = undefined;
                }
                if (target === undefined || target.isValid === false) {
                    waiting += 1;
                    if (waiting > PHYSICAL.unloadedRetrySlices) {
                        finishJob(job);
                        hooks.onStopped("a chunk in the footprint is not loaded - stay near the district and run /scriptevent civ:district_resume", state);
                        return;
                    }
                    yield;
                    continue;
                }
                waiting = 0;
                const verdict = classifyTerrainCell({ kind: op.kind, existingId: target.typeId, targetId: op.id });
                if (verdict.built) {
                    state.alreadyBuilt += 1;
                } else if (!verdict.ok) {
                    state.refused += 1;
                    note(`(${String(op.x)}, ${String(op.y)}, ${String(op.z)}) terrain ${op.kind} refused: ${String(verdict.reason)}`);
                } else {
                    try {
                        target.setPermutation(permutationFor({ x: op.x, y: op.y, z: op.z, id: op.id }));
                        state.placed += 1;
                    } catch (error) {
                        state.failed += 1;
                        note(`(${String(op.x)}, ${String(op.y)}, ${String(op.z)}) terrain ${op.kind}: ${String(error)}`);
                    }
                }
                index += 1;
                state.progress = index;
                sinceYield += 1;
                if (sinceYield >= PHYSICAL.blocksPerSlice) {
                    sinceYield = 0;
                    hooks.onSlice(state);
                    yield;
                }
            }
            if (state.refused > 0 || state.failed > 0) {
                // The world changed under the survey: do not build a district on an unprepared platform.
                finishJob(job);
                hooks.onStopped(`${String(state.refused + state.failed)} terrain cell(s) changed or failed during preparation, so the structure was not started. Review the lines below, then run /scriptevent civ:district_resume (it re-surveys the remaining work)`, state);
                return;
            }
            if (terrain !== undefined) {
                state.phase = "structure";
                state.progress = terrainList.length + state.cursor;
                hooks.onPhase?.("structure", state);
            }

            while (state.cursor < plan.blocks.length) {
                if (job.cancelled) {
                    return;
                }
                const block = /** @type {PlannedBlock} */ (plan.blocks[state.cursor]);
                const position = { x: origin.x + block.x, y: origin.y + block.y, z: origin.z + block.z };
                let target;
                try {
                    target = dimension.getBlock(position);
                } catch (_error) {
                    target = undefined;
                }
                if (target === undefined || target.isValid === false) {
                    waiting += 1;
                    if (waiting > PHYSICAL.unloadedRetrySlices) {
                        finishJob(job);
                        hooks.onStopped("a chunk in the footprint is not loaded - stay near the district and run /scriptevent civ:district_resume", state);
                        return;
                    }
                    yield;
                    continue;
                }
                waiting = 0;

                const verdict = classifyCell({ plannedId: block.id, y: block.y, existingId: target.typeId });
                if (verdict.built) {
                    state.alreadyBuilt += 1;
                } else if (!verdict.ok) {
                    state.refused += 1;
                    note(`(${String(position.x)}, ${String(position.y)}, ${String(position.z)}) refused: ${String(verdict.reason)}`);
                } else {
                    try {
                        target.setPermutation(permutationFor(block));
                        state.placed += 1;
                    } catch (error) {
                        state.failed += 1;
                        note(`(${String(position.x)}, ${String(position.y)}, ${String(position.z)}) ${block.id}: ${String(error)}`);
                    }
                }
                state.cursor += 1;
                state.progress = state.terrainTotal + state.cursor;

                sinceYield += 1;
                if (sinceYield >= PHYSICAL.blocksPerSlice) {
                    sinceYield = 0;
                    hooks.onSlice(state);
                    yield;
                }
            }
        } catch (error) {
            finishJob(job);
            hooks.onStopped(`unexpected error: ${String(error)}`, state);
            return;
        }
        finishJob(job);
        hooks.onDone(state);
    }

    job.jobId = system.runJob(generator());
    return state;
}
