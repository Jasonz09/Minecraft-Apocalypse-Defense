import { system } from "@minecraft/server";
import { PHYSICAL } from "../config.js";
import {
    bestCandidates,
    classifyColumn,
    classifyTerrainCell,
    classifyTrees,
    isBenign,
    isLeaves,
    isNaturalGround,
    isTreePart,
    planTerrain,
    scoreCandidate,
    terrainFingerprint,
} from "../structures/terrain.js";

/**
 * Read-only terrain surveys for district generation: find the real ground height of every
 * footprint column (never assuming the player's own y), classify what stands on it, plan one
 * terraced platform, and score nearby candidate sites. These jobs NEVER write a block.
 *
 * Work is time-sliced with system.runJob; the caller owns the job token (see districtBuilder.js).
 */

/**
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {{ kind: string, jobId: number | undefined, cancelled: boolean }} Job
 * @typedef {{ ground?: number, topId?: string, belowId?: string, above: { y: number, id: string }[], problem?: string }} ColumnInfo
 */

/** Deepest column walk before giving up (trees, mountains). */
const MAX_WALK = 96;

/**
 * Block id (and, for leaves, the persistent flag) at a position; undefined if unloaded.
 * @param {Dimension} dimension
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{ id: string, persistent?: boolean } | undefined}
 */
function readCell(dimension, x, y, z) {
    try {
        const block = dimension.getBlock({ x, y, z });
        if (block === undefined || block.isValid === false) {
            return undefined;
        }
        const id = block.typeId;
        if (isLeaves(id)) {
            const state = block.permutation?.getState("persistent_bit");
            return { id, persistent: state !== false };
        }
        return { id };
    } catch (_error) {
        return undefined;
    }
}

/**
 * Walk one column from the topmost block down to the first natural ground.
 * @param {Dimension} dimension
 * @param {number} x
 * @param {number} z
 * @returns {ColumnInfo | undefined} undefined if the column is not loaded
 */
export function readColumn(dimension, x, z) {
    let top;
    try {
        top = dimension.getTopmostBlock({ x, z });
    } catch (_error) {
        return undefined;
    }
    if (top === undefined) {
        return undefined;
    }
    const startY = top.location.y;
    /** @type {{ y: number, id: string }[]} */
    const cells = [];
    for (let y = startY; cells.length < MAX_WALK; y -= 1) {
        const cell = readCell(dimension, x, y, z);
        if (cell === undefined) {
            return undefined;
        }
        cells.push({ y, id: cell.id });
        const previous = cells.length >= 2 ? /** @type {{ id: string }} */ (cells[cells.length - 2]) : undefined;
        if (previous !== undefined && isNaturalGround(previous.id)) {
            break; // this cell is the block beneath the ground: enough to judge it
        }
        if (!isBenign(cell.id)) {
            break; // an unknown or player-made block: classifyColumn will report it
        }
    }
    return classifyColumn(cells);
}

/**
 * @typedef {{
 *   ok: boolean, problems: string[], samples: string[], unloaded: number,
 *   baseY: number, groundMin: number, groundMax: number, ops: import("../structures/terrain.js").TerrainOp[],
 *   clear: { x: number, y: number, z: number }[],
 *   counts: { cut: number, fill: number, top: number, clear: number, plants: number, treeBlocks: number },
 *   fingerprint: string
 * }} TerrainScan
 */

/**
 * Survey a footprint centred on (centre.x, centre.z): real ground heights, obstruction
 * classification, platform plan, tree classification, cut verification. Writes nothing.
 *
 * @param {Job} token
 * @param {Dimension} dimension
 * @param {{ x: number, z: number }} centre
 * @param {number} half footprint half-extent
 * @param {{ maxCut: number, maxFill: number }} limits
 * @param {number | undefined} forcedBaseY
 * @param {(result: TerrainScan) => void} onDone
 */
export function startTerrainScan(token, dimension, centre, half, limits, forcedBaseY, onDone) {
    if (token.cancelled) {
        return false;
    }
    token.kind = "survey";
    /** @type {TerrainScan} */
    const result = {
        ok: false,
        problems: [],
        samples: [],
        unloaded: 0,
        baseY: 0,
        groundMin: 0,
        groundMax: 0,
        ops: [],
        clear: [],
        counts: { cut: 0, fill: 0, top: 0, clear: 0, plants: 0, treeBlocks: 0 },
        fingerprint: "",
    };
    const size = half * 2 + 1;

    /** @param {string} text */
    const note = (text) => {
        if (result.samples.length < 6) {
            result.samples.push(text);
        }
    };

    function* generator() {
        try {
            /** @type {(ColumnInfo | undefined)[]} */
            const columns = [];
            let reads = 0;
            for (let i = 0; i < size; i += 1) {
                for (let j = 0; j < size; j += 1) {
                    if (token.cancelled) {
                        return;
                    }
                    const x = centre.x - half + i;
                    const z = centre.z - half + j;
                    const info = readColumn(dimension, x, z);
                    columns.push(info);
                    if (info === undefined) {
                        result.unloaded += 1;
                    } else if (info.problem !== undefined) {
                        result.problems.push(info.problem);
                        note(`(${String(x)}, ${String(z)}) ${info.problem}`);
                    }
                    reads += 1;
                    if (reads >= PHYSICAL.columnsPerSlice) {
                        reads = 0;
                        yield;
                    }
                }
            }
            // Water or lava touching the footprint's edge would flow into the cuts: look one ring outside.
            if (result.unloaded === 0 && result.problems.length === 0) {
                for (let k = -half - 1; k <= half + 1 && result.problems.length === 0; k += 1) {
                    for (const [dx, dz] of /** @type {[number, number][]} */ ([[k, -half - 1], [k, half + 1], [-half - 1, k], [half + 1, k]])) {
                        const edge = readColumn(dimension, centre.x + dx, centre.z + dz);
                        if (edge?.problem !== undefined && /^(water|lava)/.test(edge.problem)) {
                            const message = `${edge.problem} right next to the footprint at (${String(centre.x + dx)}, ${String(centre.z + dz)}); it could flow into the site`;
                            result.problems.push(message);
                            note(message);
                            break;
                        }
                    }
                }
            }
            if (result.unloaded > 0 || result.problems.length > 0) {
                return;
            }

            // A lone spike (ground towering over all four neighbours) is more likely a player pillar than terrain.
            for (let i = 1; i < size - 1 && result.problems.length === 0; i += 1) {
                for (let j = 1; j < size - 1; j += 1) {
                    const here = /** @type {number} */ (/** @type {ColumnInfo} */ (columns[i * size + j]).ground);
                    const around = [columns[(i - 1) * size + j], columns[(i + 1) * size + j], columns[i * size + j - 1], columns[i * size + j + 1]].map((info) => /** @type {number} */ (/** @type {ColumnInfo} */ (info).ground));
                    if (around.every((height) => here - height >= 2)) {
                        const message = `isolated spike at (${String(centre.x - half + i)}, ${String(centre.z - half + j)}): ground y=${String(here)} towers over every neighbour - may be a player pillar`;
                        result.problems.push(message);
                        note(message);
                        break;
                    }
                }
            }
            if (result.problems.length > 0) {
                return;
            }

            const plan = planTerrain(
                columns.map((info) => ({ ground: /** @type {number} */ (/** @type {ColumnInfo} */ (info).ground), topId: /** @type {string} */ (/** @type {ColumnInfo} */ (info).topId) })),
                half,
                limits,
                forcedBaseY,
            );
            result.baseY = plan.baseY;
            const grounds = columns.map((info) => /** @type {number} */ (/** @type {ColumnInfo} */ (info).ground));
            result.groundMin = Math.min(...grounds);
            result.groundMax = Math.max(...grounds);
            if (!plan.ok) {
                result.problems.push(...plan.problems);
                note(plan.problems[0] ?? "terrain planning failed");
                return;
            }
            result.ops = plan.ops;
            result.counts.cut = plan.counts.cut;
            result.counts.fill = plan.counts.fill;
            result.counts.top = plan.counts.top;

            // vegetation and trees standing above the ground inside the footprint
            /** @type {{ x: number, y: number, z: number }[]} */
            const plantCells = [];
            /** @type {{ x: number, y: number, z: number }[]} */
            const treeSeeds = [];
            columns.forEach((info, index) => {
                const x = centre.x - half + Math.floor(index / size);
                const z = centre.z - half + (index % size);
                for (const cell of /** @type {ColumnInfo} */ (info).above) {
                    if (isTreePart(cell.id)) {
                        treeSeeds.push({ x, y: cell.y, z });
                    } else {
                        plantCells.push({ x, y: cell.y, z });
                    }
                }
            });

            /** @type {Map<string, { id: string, persistent?: boolean } | undefined>} */
            const cache = new Map();
            let sinceYield = 0;
            const tracked = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => {
                const key = `${String(x)},${String(y)},${String(z)}`;
                if (!cache.has(key)) {
                    cache.set(key, readCell(dimension, x, y, z));
                    sinceYield += 1;
                }
                return cache.get(key);
            };
            const inside = (/** @type {number} */ x, /** @type {number} */ z) => Math.abs(x - centre.x) <= half && Math.abs(z - centre.z) <= half;
            // Tree classification reads many cells; run it in bounded slices by chunking the seeds.
            /** @type {{ x: number, y: number, z: number }[]} */
            const treeClear = [];
            const chunkSize = 10;
            for (let start = 0; start < treeSeeds.length; start += chunkSize) {
                if (token.cancelled) {
                    return;
                }
                const verdict = classifyTrees(treeSeeds.slice(start, start + chunkSize), tracked, { cap: PHYSICAL.treeCap, inside });
                treeClear.push(...verdict.clear);
                for (const problem of verdict.problems) {
                    result.problems.push(problem);
                    note(problem);
                }
                if (sinceYield >= PHYSICAL.scanPerSlice) {
                    sinceYield = 0;
                    yield;
                }
            }
            if (result.problems.length > 0) {
                return;
            }
            const unique = new Map();
            for (const cell of [...plantCells, ...treeClear]) {
                unique.set(`${String(cell.x)},${String(cell.y)},${String(cell.z)}`, cell);
            }
            result.clear = [...unique.values()].sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
            result.counts.plants = plantCells.length;
            result.counts.treeBlocks = treeClear.length;
            result.counts.clear = result.clear.length;

            // every block the cut would remove must be natural ground (no ores, no player tunnels' contents)
            for (const op of result.ops) {
                if (op.kind !== "cut" && op.kind !== "top") {
                    continue;
                }
                const existing = tracked(centre.x + op.x, op.y, centre.z + op.z);
                const verdict = classifyTerrainCell({ kind: op.kind, existingId: existing?.id, targetId: op.id });
                if (!verdict.ok) {
                    result.problems.push(`${String(verdict.reason)} at (${String(centre.x + op.x)}, ${String(op.y)}, ${String(centre.z + op.z)})`);
                    note(String(result.problems[result.problems.length - 1]));
                    break;
                }
                if (sinceYield >= PHYSICAL.scanPerSlice) {
                    sinceYield = 0;
                    yield;
                }
            }
            if (result.problems.length > 0) {
                return;
            }

            result.fingerprint = terrainFingerprint({ x: centre.x, y: plan.baseY, z: centre.z }, plan.baseY, result.ops, result.clear);
            result.ok = true;
        } catch (error) {
            result.problems.push(`survey failed: ${String(error)}`);
        } finally {
            if (!token.cancelled) {
                onDone(result);
            }
        }
    }

    token.jobId = system.runJob(generator());
    return true;
}

/**
 * @typedef {{ x: number, z: number, baseY: number, score: number, distance: number, cut: number, fill: number, trees: number }} Site
 */

/**
 * Scan the area around the player and rank candidate centres. Read-only.
 *
 * @param {Job} token
 * @param {Dimension} dimension
 * @param {{ x: number, z: number }} centre
 * @param {number} radius search radius in blocks
 * @param {number} half footprint half-extent
 * @param {{ maxCut: number, maxFill: number }} limits
 * @param {(result: { sites: Site[], evaluated: number, reasons: Record<string, number>, unloaded: number }) => void} onDone
 */
export function startScout(token, dimension, centre, radius, half, limits, onDone) {
    if (token.cancelled) {
        return false;
    }
    token.kind = "scout";
    function* generator() {
        /** @type {Record<string, number>} */
        const reasons = {};
        /** @type {Site[]} */
        const sites = [];
        let evaluated = 0;
        let unloaded = 0;
        try {
            /** @type {Map<string, ColumnInfo | undefined>} */
            const cache = new Map();
            const reach = radius + half;
            let reads = 0;
            for (let x = centre.x - reach; x <= centre.x + reach; x += 1) {
                for (let z = centre.z - reach; z <= centre.z + reach; z += 1) {
                    if (token.cancelled) {
                        return;
                    }
                    const info = readColumn(dimension, x, z);
                    cache.set(`${String(x)},${String(z)}`, info);
                    if (info === undefined) {
                        unloaded += 1;
                    }
                    reads += 1;
                    if (reads >= PHYSICAL.columnsPerSlice) {
                        reads = 0;
                        yield;
                    }
                }
            }
            const column = (/** @type {number} */ x, /** @type {number} */ z) => cache.get(`${String(x)},${String(z)}`);
            let sinceYield = 0;
            for (let dx = -radius; dx <= radius; dx += PHYSICAL.scoutStep) {
                for (let dz = -radius; dz <= radius; dz += PHYSICAL.scoutStep) {
                    if (token.cancelled) {
                        return;
                    }
                    const candidate = { x: centre.x + dx, z: centre.z + dz };
                    const scored = scoreCandidate(column, candidate, half, limits);
                    evaluated += 1;
                    if (scored.ok) {
                        sites.push({ x: candidate.x, z: candidate.z, baseY: scored.baseY, score: scored.score, distance: Math.hypot(dx, dz), cut: scored.cut, fill: scored.fill, trees: scored.trees });
                    } else {
                        const reason = String(scored.reason).replace(/\(.*?\)|-?\d+/g, "#").slice(0, 70);
                        reasons[reason] = (reasons[reason] ?? 0) + 1;
                    }
                    sinceYield += 1;
                    if (sinceYield >= 6) {
                        sinceYield = 0;
                        yield;
                    }
                }
            }
        } catch (error) {
            reasons[`scout failed: ${String(error)}`] = 1;
        } finally {
            if (!token.cancelled) {
                onDone({ sites: bestCandidates(sites, PHYSICAL.scoutResults), evaluated, reasons, unloaded });
            }
        }
    }
    token.jobId = system.runJob(generator());
    return true;
}
