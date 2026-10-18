/**
 * Terrain analysis, seed placement and region growing for the civilization master plan (pure, deterministic).
 * Everything works on a coarse grid of 4x4-block cells (see CivPlan.cell). Owner: planner agent (A).
 *
 * Operation budget (documented, bounded): analysis reads 5 field samples per cell (<= 5 * (2R/4)^2 = 112k reads
 * for R = 300); region growing is a multi-source Dijkstra over <= 22.5k cells with 8 neighbours and 5 regions
 * (<= ~900k heap pushes worst case, ~12k claims per attempt); every later pass is linear in the cell count.
 */

import { nextFloat } from "../sim/rng.js";
import { MinHeap, hash2, valueNoise2 } from "./geom.js";

export const CELL = 4;

/**
 * Operation counters. `work` is the cooperative-scheduling meter: every planner loop adds the elementary
 * operations it performs (field reads, Dijkstra claims, A* pops, smoothing points, raster cells) and the planning
 * generator yields whenever `work - lastYield` reaches WORK_LIMIT. `maxRun` is the longest stretch between yields.
 * @typedef {{ fieldReads: number, dijkstraPops: number, dijkstraPushes: number, astarPops: number, attempts: number, cleanupPasses: number, work: number, lastYield: number, maxRun: number, yields: number }} Ops
 */

/** Yield to the scheduler at least this often (elementary operations). Every loop chunk between checks is < 5000. */
export const WORK_LIMIT = 20000;

/** @returns {Ops} */
export function newOps() {
    return { fieldReads: 0, dijkstraPops: 0, dijkstraPushes: 0, astarPops: 0, attempts: 0, cleanupPasses: 0, work: 0, lastYield: 0, maxRun: 0, yields: 0 };
}

/** Record a yield point (call right before `yield`). @param {Ops} ops */
export function markYield(ops) {
    const run = ops.work - ops.lastYield;
    if (run > ops.maxRun) ops.maxRun = run;
    ops.lastYield = ops.work;
    ops.yields += 1;
}

/**
 * Drive a planning generator to completion (used by the synchronous wrappers).
 * @template T @param {Generator<void, T, void>} gen @returns {T}
 */
export function runSync(gen) {
    for (;;) {
        const r = gen.next();
        if (r.done) return r.value;
    }
}

/**
 * Tiny seeded generator over sim/rng.js (mulberry32 state threading).
 * @param {number} seed
 * @returns {() => number} floats in [0,1)
 */
export function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        const draw = nextFloat(state);
        state = draw.next;
        return draw.value;
    };
}

/**
 * @typedef {object} Terrain
 * @property {number} x0 world x of cell column 0
 * @property {number} z0 world z of cell row 0
 * @property {number} w
 * @property {number} h
 * @property {Uint8Array} passable 1 = may be settled
 * @property {Uint8Array} water cells with any water sample (0/1)
 * @property {Uint8Array} crossable 1 = region growth may enter (passable land, or narrow water within 3 cells of land: rivers)
 * @property {Float32Array} gcost growth cost used by region growing (crossable water is expensive)
 * @property {Float32Array} relief max-min ground height inside the cell
 * @property {Float32Array} elev mean ground height
 * @property {Float32Array} tree tree fraction 0..1
 * @property {Float32Array} cost growth cost per cell (>= 1)
 * @property {Float32Array} rough 5x5 mean relief
 * @property {Float32Array} elevPct 0..1 percentile of elev among passable cells
 * @property {Uint8Array} distBlocked cells to nearest impassable cell (capped 12)
 * @property {Uint8Array} waterDist cells to nearest water cell (capped 40)
 * @property {Float32Array} shelter -1..1, positive when ringed by higher ground
 * @property {boolean} hasWater
 */

/**
 * @param {Float32Array | Uint8Array} src @param {number} w @param {number} h @param {number} r @param {Ops} ops
 * @returns {Generator<void, Float32Array, void>}
 */
function* boxMean(src, w, h, r, ops) {
    const out = new Float32Array(w * h);
    for (let j = 0; j < h; j += 1) {
        ops.work += w * (2 * r + 1) * (2 * r + 1);
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 0; i < w; i += 1) {
            let s = 0;
            let c = 0;
            for (let dj = -r; dj <= r; dj += 1) {
                const jj = j + dj;
                if (jj < 0 || jj >= h) continue;
                for (let di = -r; di <= r; di += 1) {
                    const ii = i + di;
                    if (ii < 0 || ii >= w) continue;
                    s += src[jj * w + ii];
                    c += 1;
                }
            }
            out[j * w + i] = s / c;
        }
    }
    return out;
}

/**
 * Multi-source 4-neighbour BFS distance in cells (cooperative generator).
 * @param {number} w @param {number} h @param {(idx: number) => boolean} isSource @param {number} cap @param {Ops} ops
 * @returns {Generator<void, Uint8Array, void>}
 */
export function* bfsSteps(w, h, isSource, cap, ops) {
    const n = w * h;
    const dist = new Uint8Array(n).fill(cap);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let idx = 0; idx < n; idx += 1) {
        if (isSource(idx)) { dist[idx] = 0; queue[tail] = idx; tail += 1; }
        if ((idx & 255) === 255) {
            ops.work += 256;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
    }
    while (head < tail) {
        const idx = queue[head];
        head += 1;
        ops.work += 4;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        const d = dist[idx];
        if (d + 1 >= cap) continue;
        const i = idx % w;
        const j = (idx - i) / w;
        if (i > 0 && dist[idx - 1] > d + 1) { dist[idx - 1] = d + 1; queue[tail] = idx - 1; tail += 1; }
        if (i < w - 1 && dist[idx + 1] > d + 1) { dist[idx + 1] = d + 1; queue[tail] = idx + 1; tail += 1; }
        if (j > 0 && dist[idx - w] > d + 1) { dist[idx - w] = d + 1; queue[tail] = idx - w; tail += 1; }
        if (j < h - 1 && dist[idx + w] > d + 1) { dist[idx + w] = d + 1; queue[tail] = idx + w; tail += 1; }
    }
    return dist;
}

/**
 * Synchronous BFS distance (drives bfsSteps to completion).
 * @param {number} w @param {number} h @param {(idx: number) => boolean} isSource @param {number} cap
 */
export function bfsDistance(w, h, isSource, cap) {
    return runSync(bfsSteps(w, h, isSource, cap, newOps()));
}

/**
 * @typedef {{ at: (x: number, z: number) => { g: number, k: string, tree: boolean }, bounds: { x0: number, z0: number, x1: number, z1: number } }} HeightField
 */

/**
 * Coarse suitability analysis around the anchor. Water, lava, blocked, unloaded and steep (> 8 relief per
 * 4 blocks) cells are impassable for settlement; slope, trees and shore proximity add cost.
 * @param {HeightField} field @param {{ x: number, z: number }} anchor @param {number} radius @param {Ops} ops
 * @returns {Generator<void, Terrain, void>}
 */
export function* analyzeTerrainSteps(field, anchor, radius, ops) {
    const x0 = Math.floor((anchor.x - radius) / CELL) * CELL - 8 * CELL;
    const z0 = Math.floor((anchor.z - radius) / CELL) * CELL - 8 * CELL;
    const w = Math.ceil((2 * radius) / CELL) + 16;
    const h = w;
    const n = w * h;
    const passable = new Uint8Array(n);
    const blockedKind = new Uint8Array(n);
    const water = new Uint8Array(n);
    const relief = new Float32Array(n);
    const elev = new Float32Array(n);
    const tree = new Float32Array(n);
    const gsums = new Int32Array(n);
    const offs = [[0, 0], [3, 0], [0, 3], [3, 3], [2, 1]];
    for (let j = 0; j < h; j += 1) {
        ops.work += w * 6;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 0; i < w; i += 1) {
            const idx = j * w + i;
            const cx = x0 + i * CELL + 2 - anchor.x;
            const cz = z0 + j * CELL + 2 - anchor.z;
            if (cx * cx + cz * cz > radius * radius) continue;
            let gmin = Infinity;
            let gmax = -Infinity;
            let gsum = 0;
            let bad = false;
            let wet = false;
            let trees = 0;
            for (const [ox, oz] of offs) {
                const s = field.at(x0 + i * CELL + ox, z0 + j * CELL + oz);
                ops.fieldReads += 1;
                if (s.k === "water") wet = true;
                else if (s.k !== "land") { bad = true; blockedKind[i + j * w] = 1; }
                if (s.g < gmin) gmin = s.g;
                if (s.g > gmax) gmax = s.g;
                gsum += s.g;
                if (s.tree) trees += 1;
            }
            relief[idx] = gmax - gmin;
            elev[idx] = gsum / offs.length;
            gsums[idx] = gsum;
            tree[idx] = trees / offs.length;
            if (wet) water[idx] = 1;
            if (!bad && !wet && relief[idx] <= 8) passable[idx] = 1;
        }
    }
    const cost = new Float32Array(n).fill(50);
    const distWater = yield* bfsSteps(w, h, (idx) => water[idx] === 1, 40, ops);
    for (let idx = 0; idx < n; idx += 1) {
        if ((idx & 1023) === 1023) {
            ops.work += 1024;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
        if (!passable[idx]) continue;
        cost[idx] = 1 + 0.22 * relief[idx] + (relief[idx] > 4 ? 2.5 : 0) + 0.35 * tree[idx] + (distWater[idx] <= 1 ? 0.35 : 0);
    }
    const crossable = new Uint8Array(n);
    const gcost = new Float32Array(n).fill(50);
    const landDist = yield* bfsSteps(w, h, (idx) => water[idx] === 0, 8, ops);
    for (let idx = 0; idx < n; idx += 1) {
        if ((idx & 1023) === 1023) {
            ops.work += 1024;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
        if (passable[idx]) { crossable[idx] = 1; gcost[idx] = cost[idx]; }
        else if (water[idx] && landDist[idx] <= 3 && relief[idx] <= 8) { crossable[idx] = 1; gcost[idx] = 4; }
        else if (!water[idx] && !blockedKind[idx] && relief[idx] > 8 && relief[idx] <= 22) { crossable[idx] = 1; gcost[idx] = 14; }
    }
    const rough = yield* boxMean(relief, w, h, 2, ops);
    // percentiles by counting: ground heights are integers, so the sum of the 5 samples is a small integer
    let gLo = Infinity;
    let gHi = -Infinity;
    let passCount = 0;
    for (let idx = 0; idx < n; idx += 1) {
        if (!passable[idx]) continue;
        passCount += 1;
        if (gsums[idx] < gLo) gLo = gsums[idx];
        if (gsums[idx] > gHi) gHi = gsums[idx];
    }
    ops.work += 0;
    const counts = new Int32Array(passCount > 0 ? gHi - gLo + 1 : 1);
    for (let idx = 0; idx < n; idx += 1) if (passable[idx]) counts[gsums[idx] - gLo] += 1;
    /** @param {number} rank */
    const kth = (rank) => {
        let acc = 0;
        for (let v = 0; v < counts.length; v += 1) {
            acc += counts[v];
            if (acc > rank) return Math.fround((v + gLo) / offs.length);
        }
        return 0;
    };
    const lo = passCount ? kth(Math.floor(passCount * 0.05)) : 0;
    const hi = passCount ? kth(Math.floor(passCount * 0.95)) : 1;
    const elevPct = new Float32Array(n);
    for (let idx = 0; idx < n; idx += 1) {
        if ((idx & 1023) === 1023) {
            ops.work += 1024;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
        elevPct[idx] = hi > lo ? Math.max(0, Math.min(1, (elev[idx] - lo) / (hi - lo))) : 0.5;
    }
    const distBlocked = yield* bfsSteps(w, h, (idx) => passable[idx] === 0, 12, ops);
    const shelter = new Float32Array(n);
    const ring = [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, 4], [4, -4], [-4, -4]];
    for (let j = 0; j < h; j += 1) {
        ops.work += w * 9;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 0; i < w; i += 1) {
            const idx = j * w + i;
            if (!passable[idx]) continue;
            let s = 0;
            let c = 0;
            for (const [di, dj] of ring) {
                const ii = i + di;
                const jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
                s += elev[jj * w + ii];
                c += 1;
            }
            shelter[idx] = c ? Math.max(-1, Math.min(1, (s / c - elev[idx]) / 6)) : 0;
        }
    }
    let hasWater = false;
    for (let idx = 0; idx < n; idx += 1) if (water[idx]) { hasWater = true; break; }
    return { x0, z0, w, h, passable, water, crossable, gcost, relief, elev, tree, cost, rough, elevPct, distBlocked, waterDist: distWater, shelter, hasWater };
}

/**
 * Synchronous wrapper around analyzeTerrainSteps.
 * @param {HeightField} field @param {{ x: number, z: number }} anchor @param {number} radius @param {Ops} ops
 */
export function analyzeTerrain(field, anchor, radius, ops) {
    return runSync(analyzeTerrainSteps(field, anchor, radius, ops));
}

/**
 * @param {Terrain} t @param {number} i @param {number} j
 * @returns {{ x: number, z: number }} world block coordinate of the cell centre
 */
export function cellCentre(t, i, j) {
    return { x: t.x0 + i * CELL + 2, z: t.z0 + j * CELL + 2 };
}

/**
 * Pick the settlement centre: the spot near the anchor with the most passable land within a 260 block window.
 * @param {Terrain} t @param {{ x: number, z: number }} anchor @param {number} seed @param {Ops} ops
 * @returns {Generator<void, { i: number, j: number }, void>}
 */
export function* chooseCentreSteps(t, anchor, seed, ops) {
    const { w, h } = t;
    const ii = new Int32Array((w + 1) * (h + 1));
    for (let j = 0; j < h; j += 1) {
        ops.work += w;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        let row = 0;
        for (let i = 0; i < w; i += 1) {
            row += t.passable[j * w + i];
            ii[(j + 1) * (w + 1) + i + 1] = ii[j * (w + 1) + i + 1] + row;
        }
    }
    const half = 32;
    let best = -Infinity;
    let bi = Math.floor(w / 2);
    let bj = Math.floor(h / 2);
    for (let j = 8; j < h - 8; j += 3) {
        ops.work += w * 2;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 8; i < w - 8; i += 3) {
            const a0 = Math.max(0, i - half);
            const b0 = Math.max(0, j - half);
            const a1 = Math.min(w, i + half + 1);
            const b1 = Math.min(h, j + half + 1);
            const sum = ii[b1 * (w + 1) + a1] - ii[b0 * (w + 1) + a1] - ii[b1 * (w + 1) + a0] + ii[b0 * (w + 1) + a0];
            const frac = sum / ((2 * half + 1) * (2 * half + 1));
            const c = cellCentre(t, i, j);
            const d = Math.hypot(c.x - anchor.x, c.z - anchor.z);
            const score = frac - 0.0016 * d + 0.05 * hash2(i, j, seed ^ 0x51ed);
            if (t.passable[j * w + i] && score > best) { best = score; bi = i; bj = j; }
        }
    }
    return { i: bi, j: bj };
}

export const ROLES = ["command", "industrial", "agricultural", "commercial", "residential"];

/**
 * Terrain preference score of a cell for a role, roughly 0..1.
 * @param {Terrain} t @param {string} role @param {number} idx @param {number} rNorm radius from centre / expected radius
 * @param {number} noise 0..1
 */
export function roleScore(t, role, idx, rNorm, noise) {
    const rough = t.rough[idx];
    const flat = 1 - Math.min(1, rough / 4);
    const hilly = Math.min(1, rough / 4);
    const open = Math.min(1, t.distBlocked[idx] / 10);
    const hi = t.elevPct[idx];
    const wd = t.waterDist[idx];
    const waterNear = t.hasWater ? Math.max(0, 1 - Math.abs(wd - 4) / 12) : 0;
    const shelter = (t.shelter[idx] + 1) / 2;
    const edge = Math.min(1, rNorm);
    let s = 0;
    switch (role) {
        case "command": s = 0.5 * hi + 0.2 * (1 - Math.min(1, rough / 6)) + 0.15 * open + 0.15 * (1 - edge); break;
        case "industrial": s = 0.42 * hilly + 0.2 * edge + 0.2 * (1 - Math.abs(hi - 0.6)) + 0.18 * open; break;
        case "agricultural": s = 0.6 * flat + 0.25 * open + 0.15 * (1 - hi); break;
        case "commercial": s = (t.hasWater ? 0.45 : 0.1) * waterNear + (t.hasWater ? 0.25 : 0.55) * edge + 0.15 * flat + 0.15 * open; break;
        default: s = 0.4 * shelter + 0.3 * (1 - Math.min(1, rough / 5)) + 0.15 * open + 0.15 * (1 - edge); break;
    }
    return s + 0.14 * noise;
}

/**
 * @typedef {object} Seed
 * @property {number} i @property {number} j @property {number} score @property {string} role
 */

/**
 * Place five role-biased seeds around the centre in ring order 1..5. The ring rotation / direction is the
 * best terrain-scoring one among 24 candidates; `attempt` walks down that ranking so retries differ.
 * @param {Terrain} t @param {{ i: number, j: number }} centre @param {number} seed @param {number} attempt
 * @param {number} rs expected settlement radius in blocks @param {Ops} ops
 * @returns {Generator<void, { seeds: Seed[], theta0: number, dir: number } | null, void>}
 */
export function* placeSeedsSteps(t, centre, seed, attempt, rs, ops) {
    const rng = makeRng((seed ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0);
    const base = rng() * Math.PI * 2;
    const jitter = [0, 1, 2, 3, 4].map(() => (rng() - 0.5) * 0.5);
    /** @type {Array<{ total: number, seeds: Seed[], theta0: number, dir: number }>} */
    const configs = [];
    const cc = cellCentre(t, centre.i, centre.j);
    const rMin = 0.4 * rs;
    const rMax = 0.64 * rs;
    // candidate cells (settleable, away from obstacles, in the radial band) are the same for every ring configuration
    /** @type {Array<{ i: number, j: number, idx: number, x: number, z: number, r: number, ang: number }>} */
    const cand = [];
    for (let j = 0; j < t.h; j += 1) {
        ops.work += t.w * 3;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 0; i < t.w; i += 1) {
            const idx = j * t.w + i;
            if (!t.passable[idx] || t.distBlocked[idx] < 4) continue;
            const c = cellCentre(t, i, j);
            const dx = c.x - cc.x;
            const dz = c.z - cc.z;
            const r = Math.hypot(dx, dz);
            if (r < rMin || r > rMax) continue;
            cand.push({ i, j, idx, x: c.x, z: c.z, r, ang: Math.atan2(dz, dx) });
        }
    }
    for (let m = 0; m < 12; m += 1) {
        for (const dir of [1, -1]) {
            const theta0 = base + (m * Math.PI * 2) / 12;
            /** @type {Seed[]} */
            const seeds = [];
            let total = 0;
            let ok = true;
            for (let k = 0; k < 5 && ok; k += 1) {
                const a = theta0 + dir * (k * 2 * Math.PI) / 5 + jitter[k];
                let bestScore = -Infinity;
                /** @type {Seed | null} */
                let bestSeed = null;
                for (let ci = 0; ci < cand.length; ci += 1) {
                    if ((ci & 127) === 127) {
                        ops.work += 1024;
                        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
                    }
                    const cd = cand[ci];
                    let da = cd.ang - a;
                    da = Math.atan2(Math.sin(da), Math.cos(da));
                    if (Math.abs(da) > 0.5) continue;
                    let tooClose = false;
                    for (const sd of seeds) {
                        const o = cellCentre(t, sd.i, sd.j);
                        if (Math.hypot(o.x - cd.x, o.z - cd.z) < 80) { tooClose = true; break; }
                    }
                    if (tooClose) continue;
                    const noise = valueNoise2(cd.x, cd.z, 60, seed + k * 13);
                    const sc = roleScore(t, ROLES[k], cd.idx, cd.r / rs, noise) - 0.25 * Math.abs(da);
                    if (sc > bestScore) { bestScore = sc; bestSeed = { i: cd.i, j: cd.j, score: sc, role: ROLES[k] }; }
                }
                if (!bestSeed) ok = false;
                else { seeds.push(bestSeed); total += bestScore; }
            }
            if (ok) configs.push({ total, seeds, theta0, dir });
        }
    }
    if (configs.length === 0) return null;
    configs.sort((p, q) => q.total - p.total);
    const pick = configs[Math.min(configs.length - 1, attempt % Math.max(1, Math.min(6, configs.length)))];
    return { seeds: pick.seeds, theta0: pick.theta0, dir: pick.dir };
}

/**
 * @typedef {object} GrowParams
 * @property {number[]} capCells target cell count per region
 * @property {number[]} aspect elongation (>= 1) of each region's cost metric
 * @property {number[]} angle orientation (radians) of the elongation axis
 * @property {number[]} noiseSeed
 * @property {Array<{ dx: number, dz: number, len: number } | null>} corridor optional cheap corridor (unit direction, length blocks)
 */

/**
 * Terrain-cost-weighted multi-source Dijkstra region growing with per-region anisotropy and seeded noise.
 * @param {Terrain} t @param {Seed[]} seeds @param {GrowParams} params @param {Ops} ops
 * @returns {Generator<void, { labels: Uint8Array, counts: number[] }, void>}
 */
export function* growRegionsSteps(t, seeds, params, ops) {
    const { w, h } = t;
    const n = w * h;
    const R = seeds.length;
    const labels = new Uint8Array(n);
    const counts = new Array(R + 1).fill(0);
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
    /** @type {Float32Array[]} */
    const mult = [];
    /** @type {Float64Array[]} */
    const best = [];
    const stepLen = [];
    for (let r = 0; r < R; r += 1) {
        const ns = params.noiseSeed[r];
        const m = new Float32Array(n);
        const sc = cellCentre(t, seeds[r].i, seeds[r].j);
        const corr = params.corridor[r];
        for (let j = 0; j < h; j += 1) {
            ops.work += w * 8;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            for (let i = 0; i < w; i += 1) {
                const c = cellCentre(t, i, j);
                const q = 0.5 * valueNoise2(c.x, c.z, 150, ns) + 0.3 * valueNoise2(c.x, c.z, 62, ns + 1) + 0.2 * valueNoise2(c.x, c.z, 26, ns + 2);
                const qs = Math.max(0, Math.min(1, 0.5 + (q - 0.5) * 2.4));
                let v = 0.35 + 1.5 * qs;
                if (corr) {
                    const px = c.x - sc.x;
                    const pz = c.z - sc.z;
                    const along = px * corr.dx + pz * corr.dz;
                    const across = Math.abs(-px * corr.dz + pz * corr.dx);
                    if (along > 0 && along < corr.len && across < 9) v *= 0.42;
                }
                m[j * w + i] = v;
            }
        }
        mult.push(m);
        best.push(new Float64Array(n).fill(Infinity));
        const ca = Math.cos(params.angle[r]);
        const sa = Math.sin(params.angle[r]);
        const a = params.aspect[r];
        stepLen.push(DX.map((dx, d) => {
            const u = dx * ca + DZ[d] * sa;
            const v = -dx * sa + DZ[d] * ca;
            return Math.sqrt((u * u) / (a * a) + v * v);
        }));
    }
    const heaps = seeds.map(() => new MinHeap());
    for (let r = 0; r < R; r += 1) {
        const idx = seeds[r].j * w + seeds[r].i;
        best[r][idx] = 0;
        heaps[r].push(0, idx);
        ops.dijkstraPushes += 1;
    }
    for (;;) {
        // proportional growth: the region with the smallest filled fraction claims next
        let r = -1;
        let frac = Infinity;
        for (let q = 0; q < R; q += 1) {
            if (heaps[q].size === 0 || counts[q + 1] >= params.capCells[q]) continue;
            const f = counts[q + 1] / params.capCells[q];
            if (f < frac) { frac = f; r = q; }
        }
        if (r < 0) break;
        const [d, idx] = heaps[r].pop();
        ops.work += 1;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        if (labels[idx] !== 0 || d > best[r][idx]) continue;
        ops.dijkstraPops += 1;
        ops.work += 10;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        labels[idx] = r + 1;
        counts[r + 1] += 1;
        const i = idx % w;
        const j = (idx - i) / w;
        for (let k = 0; k < 8; k += 1) {
            const ni = i + DX[k];
            const nj = j + DZ[k];
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            const nidx = nj * w + ni;
            if (!t.crossable[nidx] || labels[nidx] !== 0) continue;
            if (k >= 4 && !t.crossable[j * w + ni] && !t.crossable[nj * w + i]) continue;
            const nd = d + stepLen[r][k] * t.gcost[nidx] * mult[r][nidx];
            if (nd < best[r][nidx]) {
                best[r][nidx] = nd;
                heaps[r].push(nd, nidx);
                ops.dijkstraPushes += 1;
            }
        }
    }
    return { labels, counts };
}

/**
 * 4-connected components of equal non-zero labels; keeps only the largest per label, zeroing the rest.
 * @param {Uint8Array} labels @param {number} w @param {number} h @param {Ops} ops
 * @returns {Generator<void, number, void>} cells dropped
 */
export function* keepLargestComponents(labels, w, h, ops) {
    const n = w * h;
    const comp = new Int32Array(n).fill(-1);
    /** @type {Array<{ label: number, cells: number[] }>} */
    const comps = [];
    const stack = [];
    for (let s = 0; s < n; s += 1) {
        if ((s & 255) === 255) {
            ops.work += 256;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
        if (labels[s] === 0 || comp[s] >= 0) continue;
        const cid = comps.length;
        /** @type {number[]} */
        const cells = [];
        stack.push(s);
        comp[s] = cid;
        while (stack.length) {
            const idx = /** @type {number} */ (stack.pop());
            ops.work += 3;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            cells.push(idx);
            const i = idx % w;
            const j = (idx - i) / w;
            if (i > 0 && labels[idx - 1] === labels[s] && comp[idx - 1] < 0) { comp[idx - 1] = cid; stack.push(idx - 1); }
            if (i < w - 1 && labels[idx + 1] === labels[s] && comp[idx + 1] < 0) { comp[idx + 1] = cid; stack.push(idx + 1); }
            if (j > 0 && labels[idx - w] === labels[s] && comp[idx - w] < 0) { comp[idx - w] = cid; stack.push(idx - w); }
            if (j < h - 1 && labels[idx + w] === labels[s] && comp[idx + w] < 0) { comp[idx + w] = cid; stack.push(idx + w); }
        }
        comps.push({ label: labels[s], cells });
    }
    /** @type {Map<number, number>} */
    const bestOf = new Map();
    comps.forEach((c, cid) => {
        const cur = bestOf.get(c.label);
        if (cur === undefined || comps[cur].cells.length < c.cells.length) bestOf.set(c.label, cid);
    });
    let dropped = 0;
    comps.forEach((c, cid) => {
        if (bestOf.get(c.label) !== cid) for (const idx of c.cells) { labels[idx] = 0; dropped += 1; }
    });
    return dropped;
}

/**
 * Assign every enclosed pocket of label-0 cells (not 4-reachable from the grid border) to the adjacent
 * district sharing the longest border. Returns the size of the largest pocket filled.
 * @param {Uint8Array} labels @param {number} w @param {number} h @param {Ops} ops
 * @returns {Generator<void, number, void>}
 */
export function* fillHoles(labels, w, h, ops) {
    const n = w * h;
    const outside = new Uint8Array(n);
    const stack = [];
    for (let i = 0; i < w; i += 1) { stack.push(i, (h - 1) * w + i); }
    for (let j = 0; j < h; j += 1) { stack.push(j * w, j * w + w - 1); }
    while (stack.length) {
        const idx = /** @type {number} */ (stack.pop());
        ops.work += 3;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        if (outside[idx] || labels[idx] !== 0) continue;
        outside[idx] = 1;
        const i = idx % w;
        const j = (idx - i) / w;
        if (i > 0) stack.push(idx - 1);
        if (i < w - 1) stack.push(idx + 1);
        if (j > 0) stack.push(idx - w);
        if (j < h - 1) stack.push(idx + w);
    }
    let largest = 0;
    const seen = new Uint8Array(n);
    for (let s = 0; s < n; s += 1) {
        if ((s & 255) === 255) {
            ops.work += 256;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
        if (labels[s] !== 0 || outside[s] || seen[s]) continue;
        /** @type {number[]} */
        const cells = [];
        const votes = [0, 0, 0, 0, 0, 0, 0, 0];
        stack.push(s);
        seen[s] = 1;
        while (stack.length) {
            const idx = /** @type {number} */ (stack.pop());
            ops.work += 3;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            cells.push(idx);
            const i = idx % w;
            const j = (idx - i) / w;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ni = i + di;
                const nj = j + dj;
                if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
                const nidx = nj * w + ni;
                if (labels[nidx] === 0) { if (!seen[nidx]) { seen[nidx] = 1; stack.push(nidx); } } else votes[labels[nidx]] += 1;
            }
        }
        let bl = 1;
        for (let l = 1; l <= 5; l += 1) if (votes[l] > votes[bl]) bl = l;
        for (const idx of cells) labels[idx] = bl;
        if (cells.length > largest) largest = cells.length;
    }
    return largest;
}

/**
 * Smooth district boundaries: a district cell with >= 5 of 8 neighbours in one other district flips to it;
 * lone outer spikes (>= 7 of 8 neighbours empty) are removed. Never creates new settled land.
 * @param {Uint8Array} labels @param {number} w @param {number} h @param {number} passes @param {Ops} ops
 * @returns {Generator<void, void, void>}
 */
export function* smoothLabels(labels, w, h, passes, ops) {
    for (let p = 0; p < passes; p += 1) {
        const prev = labels.slice();
        for (let j = 1; j < h - 1; j += 1) {
            ops.work += w * 9;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            for (let i = 1; i < w - 1; i += 1) {
                const idx = j * w + i;
                const l = prev[idx];
                if (l === 0) continue;
                const cnt = [0, 0, 0, 0, 0, 0];
                for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) if (di || dj) cnt[prev[idx + dj * w + di]] += 1;
                if (cnt[0] >= 7) { labels[idx] = 0; continue; }
                let bl = 0;
                for (let q = 1; q <= 5; q += 1) if (q !== l && cnt[q] >= 5 && (bl === 0 || cnt[q] > cnt[bl])) bl = q;
                if (bl) labels[idx] = bl;
            }
        }
    }
}

/**
 * Remove 1-cell-wide structures that would collapse when chains are smoothed: any labelled cell whose
 * same-label 4-neighbour count is <= 1 and which is not the only cell of its district is released.
 * @param {Uint8Array} labels @param {number} w @param {number} h @param {Ops} ops
 * @returns {Generator<void, void, void>}
 */
export function* pruneSlivers(labels, w, h, ops) {
    for (let j = 1; j < h - 1; j += 1) {
        ops.work += w * 5;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 1; i < w - 1; i += 1) {
            const idx = j * w + i;
            const l = labels[idx];
            if (l === 0) continue;
            const same = (labels[idx - 1] === l ? 1 : 0) + (labels[idx + 1] === l ? 1 : 0) + (labels[idx - w] === l ? 1 : 0) + (labels[idx + w] === l ? 1 : 0);
            if (same <= 1) labels[idx] = 0;
        }
    }
}

/**
 * Close narrow slits and notches: an empty crossable cell with >= 6 of 8 neighbours settled joins the majority neighbour.
 * @param {Uint8Array} labels @param {Uint8Array} crossable @param {number} w @param {number} h @param {number} passes @param {Ops} ops
 * @returns {Generator<void, void, void>}
 */
export function* closeSlits(labels, crossable, w, h, passes, ops) {
    for (let p = 0; p < passes; p += 1) {
        const prev = labels.slice();
        for (let j = 1; j < h - 1; j += 1) {
            ops.work += w * 9;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            for (let i = 1; i < w - 1; i += 1) {
                const idx = j * w + i;
                if (prev[idx] !== 0 || !crossable[idx]) continue;
                const cnt = [0, 0, 0, 0, 0, 0];
                for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) if (di || dj) cnt[prev[idx + dj * w + di]] += 1;
                if (cnt[0] > 2) continue;
                let bl = 1;
                for (let q = 2; q <= 5; q += 1) if (cnt[q] > cnt[bl]) bl = q;
                labels[idx] = bl;
            }
        }
    }
}
