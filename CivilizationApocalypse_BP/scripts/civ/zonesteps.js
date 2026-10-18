import { BLUEPRINTS2, BLUEPRINT_VARIANTS } from "../structures/blueprints2.js";
import { newOps } from "./regions.js";
import { pace as paceUnits } from "./siteprofile.js";
import { CELL, KIND_GROUP, MIN_COMPOSITION, ROLE_ZONES, ZONING_VERSION, densify, hash2, makeRng, stampCells, stampRoads, valueNoise } from "./zoning.js";

/**
 * Cooperative (generator) form of civ/zoning.js zoneDistrict: the same maths, the same random
 * stream, the same output (a test compares them field by field), with the heavy loops charged to
 * `ops` (civ/regions.js convention) so the generator yields at least every ~20,000 elementary
 * operations. Produced from zoning.js by mechanical, asserted text transformations; if zoning.js
 * changes, regenerate it (the test compares both forms on several seeds and fails on drift).
 *
 * @typedef {import("./regions.js").Ops} Ops
 * @typedef {import("./zoning.js").Grids} Grids
 * @typedef {import("./zoning.js").DistrictRegion} DistrictRegion
 * @typedef {import("./zoning.js").Pt} Pt
 * @typedef {import("./zoning.js").BBox} BBox
 * @typedef {import("./zoning.js").Zone} Zone
 * @typedef {import("./zoning.js").Street} Street
 * @typedef {import("./zoning.js").ZoneDef} ZoneDef
 * @typedef {import("./zoning.js").Program} Program
 */

/**
 * The charges below were written per inner-loop iteration. One unit of civ/regions.js work is about 16 ns
 * of offline time, so the charges are scaled down to keep ops.work comparable across the planners.
 */
const UNIT_SCALE = 16;

/** @param {Ops} ops @param {number} n @returns {Generator<void, void, void>} */
function* pace(ops, n) {
    yield* paceUnits(ops, Math.max(1, Math.ceil(n / UNIT_SCALE)));
}

const DEFAULTS = { seed: 1, setback: 6, reserveFraction: 0.17, gateClear: 8, streetWidth: 3, perimeterGuardEvery: 80, perimeterTowerEvery: 190 };

/** Binary min-heap keyed by number, carrying an int payload. */
class MinHeap {
    constructor() {
        /** @type {number[]} */
        this.keys = [];
        /** @type {number[]} */
        this.vals = [];
    }

    get size() {
        return this.keys.length;
    }

    /** @param {number} key @param {number} val */
    push(key, val) {
        const keys = this.keys;
        const vals = this.vals;
        let i = keys.length;
        keys.push(key);
        vals.push(val);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (/** @type {number} */ (keys[p]) <= key) {
                break;
            }
            keys[i] = /** @type {number} */ (keys[p]);
            vals[i] = /** @type {number} */ (vals[p]);
            i = p;
        }
        keys[i] = key;
        vals[i] = val;
    }

    /** @returns {{ key: number, val: number }} */
    pop() {
        const keys = this.keys;
        const vals = this.vals;
        const top = { key: /** @type {number} */ (keys[0]), val: /** @type {number} */ (vals[0]) };
        const lk = /** @type {number} */ (keys.pop());
        const lv = /** @type {number} */ (vals.pop());
        const n = keys.length;
        if (n > 0) {
            let i = 0;
            for (;;) {
                let c = 2 * i + 1;
                if (c >= n) {
                    break;
                }
                if (c + 1 < n && /** @type {number} */ (keys[c + 1]) < /** @type {number} */ (keys[c])) {
                    c += 1;
                }
                if (/** @type {number} */ (keys[c]) >= lk) {
                    break;
                }
                keys[i] = /** @type {number} */ (keys[c]);
                vals[i] = /** @type {number} */ (vals[c]);
                i = c;
            }
            keys[i] = lk;
            vals[i] = lv;
        }
        return top;
    }
}

// ---------------------------------------------------------------- region helpers

/**
 * Point-in-polygon fallback (even-odd).
 * @param {number} x
 * @param {number} z
 * @param {number[][]} poly
 */
function pointInPoly(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
        const [xi, zi] = /** @type {number[]} */ (poly[i]);
        const [xj, zj] = /** @type {number[]} */ (poly[j]);
        if ((zi ?? 0) > z !== (zj ?? 0) > z && x < (((xj ?? 0) - (xi ?? 0)) * (z - (zi ?? 0))) / ((zj ?? 0) - (zi ?? 0)) + (xi ?? 0)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * @param {DistrictRegion} region
 * @returns {(x: number, z: number) => number}
 */
function labelFn(region) {
    if (typeof region.labelAt === "function") {
        return region.labelAt;
    }
    if (typeof region.cells === "function") {
        return region.cells;
    }
    const outline = region.outline ?? [];
    return (x, z) => (outline.length >= 3 && pointInPoly(x + 0.5, z + 0.5, outline) ? region.index : 0);
}

/**
 * Exact euclidean distance (blocks) to the nearest set cell of `source`.
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} source 1 = distance-zero cell
 * @param {Ops} ops
 * @returns {Generator<void, Float32Array, void>}
 */
export function* distanceTransformSteps(w, h, source, ops) {
    const INF = 1e9;
    const f = new Float64Array(w * h);
    for (let i = 0; i < f.length; i += 1) {
        if ((i & 4095) === 4095) yield* pace(ops, 4096);
        f[i] = source[i] === 1 ? 0 : INF;
    }
    const n = Math.max(w, h);
    const col = new Float64Array(n);
    const out = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    /** @param {number} len */
    const pass1d = (len) => {
        let k = 0;
        v[0] = 0;
        z[0] = -Infinity;
        z[1] = Infinity;
        for (let q = 1; q < len; q += 1) {
            let s = 0;
            for (;;) {
                const p = /** @type {number} */ (v[k]);
                s = (col[q] + q * q - (col[p] + p * p)) / (2 * q - 2 * p);
                if (s <= /** @type {number} */ (z[k])) {
                    k -= 1;
                } else {
                    break;
                }
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = Infinity;
        }
        k = 0;
        for (let q = 0; q < len; q += 1) {
            while (/** @type {number} */ (z[k + 1]) < q) {
                k += 1;
            }
            const p = /** @type {number} */ (v[k]);
            out[q] = (q - p) * (q - p) + col[p];
        }
    };
    for (let x = 0; x < w; x += 1) {
        yield* pace(ops, h * 12);
        for (let y = 0; y < h; y += 1) {
            col[y] = /** @type {number} */ (f[y * w + x]);
        }
        pass1d(h);
        for (let y = 0; y < h; y += 1) {
            f[y * w + x] = /** @type {number} */ (out[y]);
        }
    }
    for (let y = 0; y < h; y += 1) {
        yield* pace(ops, w * 12);
        for (let x = 0; x < w; x += 1) {
            col[x] = /** @type {number} */ (f[y * w + x]);
        }
        pass1d(w);
        for (let x = 0; x < w; x += 1) {
            f[y * w + x] = /** @type {number} */ (out[x]);
        }
    }
    const result = new Float32Array(w * h);
    for (let i = 0; i < result.length; i += 1) {
        if ((i & 4095) === 4095) yield* pace(ops, 4096);
        result[i] = Math.sqrt(/** @type {number} */ (f[i]));
    }
    return result;
}

/** @param {any} road */
function roadHalfWidth(road) {
    const width = Number.isFinite(road?.width) ? road.width : road?.kind === "arterial" ? 5 : 3;
    return Math.max(0, (Math.max(1, Math.floor(width)) - 1) / 2);
}

/**
 * Build the block-resolution rasters of one region.
 * @param {DistrictRegion} region
 * @param {any[]} roads
 * @param {{ walls?: any[] }} options
 * @param {Ops} ops
 * @returns {Generator<void, Grids, void>}
 */
export function* buildGridsSteps(region, roads, options, ops) {
    const label = labelFn(region);
    const pad = 2;
    const bb = region.bbox;
    const x0 = Math.floor(bb.x0) - pad;
    const z0 = Math.floor(bb.z0) - pad;
    const w = Math.max(1, Math.floor(bb.x1) - Math.floor(bb.x0) + 1 + 2 * pad);
    const h = Math.max(1, Math.floor(bb.z1) - Math.floor(bb.z0) + 1 + 2 * pad);
    const ins = new Uint8Array(w * h);
    let area = 0;
    for (let z = 0; z < h; z += 1) {
        yield* pace(ops, w * 14);
        for (let x = 0; x < w; x += 1) {
            if (label(x0 + x, z0 + z) === region.index) {
                ins[z * w + x] = 1;
                area += 1;
            }
        }
    }
    /** @type {Grids} */
    const G = { x0, z0, w, h, index: region.index, ins, wall: new Uint8Array(w * h), road: new Uint8Array(w * h), dist: new Float32Array(0), area };
    for (const wall of options.walls ?? []) {
        if (!Array.isArray(wall?.path) || wall.path.length === 0) {
            continue;
        }
        const t = Number.isFinite(wall.thickness) ? wall.thickness : 3;
        const dense = densify(wall.path, wall.closed === true);
        yield* pace(ops, Math.min(23000, dense.length * 40 + 100));
        stampCells(G, G.wall, dense, Math.max(0, (Math.floor(t) - 1) / 2), 0.5);
    }
    for (const road of roads) {
        yield* pace(ops, Math.min(23000, (Array.isArray(road?.path) ? road.path.length : 0) * 150 + 100));
        stampRoads(G, G.road, [road]);
    }
    const barrier = new Uint8Array(w * h);
    for (let i = 0; i < barrier.length; i += 1) {
        if ((i & 4095) === 4095) yield* pace(ops, 4096);
        barrier[i] = ins[i] === 0 || G.wall[i] === 1 ? 1 : 0;
    }
    G.dist = yield* distanceTransformSteps(w, h, barrier, ops);
    return G;
}

/**
 * Reusable Dijkstra over the block grid with early termination at the first target cell.
 */
export class RouterSteps {
    /** @param {Grids} G @param {number} seed */
    constructor(G, seed) {
        this.G = G;
        this.seed = seed;
        this.dist = new Float32Array(G.w * G.h);
        this.prev = new Int32Array(G.w * G.h);
        this.gen = new Uint32Array(G.w * G.h);
        this.cur = 0;
    }

    /**
     * @param {number[]} sources cell indices
     * @param {(i: number) => boolean} isTarget
     * @param {(i: number) => number} cost per-cell entry cost (Infinity blocks)
     * @param {number} [maxPops]
     * @param {Ops} [ops]
     * @returns {Generator<void, number[] | null, void>} cell indices source..target
     */
    *routeSteps(sources, isTarget, cost, maxPops = 60000, ops = newOps()) {
        const G = this.G;
        this.cur += 1;
        const gen = this.cur;
        const heap = new MinHeap();
        for (const s of sources) {
            this.dist[s] = 0;
            this.prev[s] = -1;
            this.gen[s] = gen;
            heap.push(0, s);
        }
        let pops = 0;
        while (heap.size > 0 && pops < maxPops) {
            const { key, val } = heap.pop();
            if (key > /** @type {number} */ (this.dist[val]) + 1e-6) {
                continue;
            }
            pops += 1;
            if ((pops & 3) === 3) yield* pace(ops, 4 * 1200);
            if (isTarget(val) && !sources.includes(val)) {
                /** @type {number[]} */
                const path = [];
                for (let c = val; c !== -1; c = /** @type {number} */ (this.prev[c])) {
                    path.push(c);
                }
                return path.reverse();
            }
            const cx = val % G.w;
            const cz = (val - cx) / G.w;
            for (let dz = -1; dz <= 1; dz += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (dx === 0 && dz === 0) {
                        continue;
                    }
                    const nx = cx + dx;
                    const nz = cz + dz;
                    if (nx < 0 || nz < 0 || nx >= G.w || nz >= G.h) {
                        continue;
                    }
                    const ni = nz * G.w + nx;
                    const c = isTarget(ni) ? 1 : cost(ni);
                    if (!Number.isFinite(c)) {
                        continue;
                    }
                    // diagonal moves need both orthogonal neighbours passable so streets stay 4-connected-walkable
                    if (dx !== 0 && dz !== 0 && (!Number.isFinite(cost(cz * G.w + nx)) && !isTarget(cz * G.w + nx) || !Number.isFinite(cost(nz * G.w + cx)) && !isTarget(nz * G.w + cx))) {
                        continue;
                    }
                    const nd = key + c * (dx !== 0 && dz !== 0 ? 1.414 : 1) * (0.75 + 0.9 * valueNoise(G.x0 + nx, G.z0 + nz, 11, this.seed));
                    if (this.gen[ni] !== gen || nd < /** @type {number} */ (this.dist[ni])) {
                        this.gen[ni] = gen;
                        this.dist[ni] = nd;
                        this.prev[ni] = val;
                        heap.push(nd, ni);
                    }
                }
            }
        }
        return null;
    }
}

// ---------------------------------------------------------------- zoning

/** @param {string} kind @returns {number} footprint+gap area of one lot of this kind */
function lotFootprint(kind) {
    const ids = BLUEPRINT_VARIANTS[kind];
    const bp = ids === undefined ? undefined : BLUEPRINTS2[/** @type {string} */ (ids[0])];
    if (bp === undefined) {
        throw new Error(`zoning: no blueprint for lot kind '${kind}'`);
    }
    const group = KIND_GROUP[kind];
    const gap = group === "homes" ? 8 : group === "farm" ? 4 : 6;
    return (bp.size[0] + gap) * (bp.size[2] + gap);
}


/**
 * @param {DistrictRegion} region
 * @param {any[]} roads
 * @param {{ seed?: number, setback?: number, reserveFraction?: number, walls?: any[], gates?: any[], gateClear?: number,
 *   streetWidth?: number, perimeterGuardEvery?: number, perimeterTowerEvery?: number }} [options]
 * @param {Ops} [ops]
 */
export function* zoneDistrictSteps(region, roads, options = {}, ops = newOps()) {
    const opts = { ...DEFAULTS, ...options };
    if (!Object.hasOwn(ROLE_ZONES, region.role)) {
        throw new Error(`zoneDistrict: unknown role '${String(region.role)}'`);
    }
    const setback = Math.max(6, Math.floor(opts.setback));
    const seed = (Math.imul(opts.seed | 0, 2654435761) ^ Math.imul(region.index, 40503)) >>> 0;
    const rand = makeRng(seed);
    const notes = /** @type {string[]} */ ([]);
    const G = yield* buildGridsSteps(region, roads, { walls: opts.walls }, ops);
    const N = G.w * G.h;

    // gate clear discs (keep the gate throat free for the roads and queues)
    const gateMask = new Uint8Array(N);
    const gatePts = /** @type {Pt[]} */ ([]);
    for (const gate of opts.gates ?? []) {
        const at = gate?.at;
        if (at === undefined || !Number.isFinite(at.x) || !Number.isFinite(at.z)) {
            continue;
        }
        gatePts.push({ x: at.x, z: at.z });
        stampCells(G, gateMask, [[at.x, at.z]], opts.gateClear, 0.5);
    }

    // eligible-for-building base mask
    const elig = new Uint8Array(N);
    let eligCount = 0;
    for (let i = 0; i < N; i += 1) {
        if ((i & 4095) === 4095) yield* pace(ops, 4096 * 2);
        if (G.ins[i] === 1 && G.wall[i] === 0 && gateMask[i] === 0 && /** @type {number} */ (G.dist[i]) >= setback + 1) {
            elig[i] = 1;
            eligCount += 1;
        }
    }

    // coarse zoning grid
    const cx0 = Math.floor(G.x0 / CELL);
    const cz0 = Math.floor(G.z0 / CELL);
    const cw = Math.floor((G.x0 + G.w - 1) / CELL) - cx0 + 1;
    const ch = Math.floor((G.z0 + G.h - 1) / CELL) - cz0 + 1;
    const zgrid = new Uint16Array(cw * ch);
    const cand = new Uint8Array(cw * ch);
    /** @param {number} ci @param {number} cj @returns {Pt} */
    const cellCentre = (ci, cj) => ({ x: (cx0 + ci) * CELL + 2, z: (cz0 + cj) * CELL + 2 });
    let candCount = 0;
    for (let cj = 0; cj < ch; cj += 1) {
        yield* pace(ops, cw * CELL * CELL * 6);
        for (let ci = 0; ci < cw; ci += 1) {
            let hit = 0;
            for (let dz = 0; dz < CELL; dz += 1) {
                for (let dx = 0; dx < CELL; dx += 1) {
                    const x = (cx0 + ci) * CELL + dx - G.x0;
                    const z = (cz0 + cj) * CELL + dz - G.z0;
                    if (x >= 0 && z >= 0 && x < G.w && z < G.h && elig[z * G.w + x] === 1) {
                        hit += 1;
                    }
                }
            }
            if (hit >= 12) {
                cand[cj * cw + ci] = 1;
                candCount += 1;
            }
        }
    }

    const roadMask = new Uint8Array(N);
    for (let i = 0; i < N; i += 1) {
        if ((i & 4095) === 4095) yield* pace(ops, 4096 * 2);
        roadMask[i] = G.road[i] === 1 && G.ins[i] === 1 ? 1 : 0;
    }
    const roadDist = yield* distanceTransformSteps(G.w, G.h, roadMask, ops);

    /** @param {number} x @param {number} z @returns {number} zone id (0 = none) */
    const zoneAt = (x, z) => {
        const ci = Math.floor(x / CELL) - cx0;
        const cj = Math.floor(z / CELL) - cz0;
        return ci < 0 || cj < 0 || ci >= cw || cj >= ch ? 0 : /** @type {number} */ (zgrid[cj * cw + ci]);
    };

    /** @type {Zone[]} */
    const zones = [];
    const zoneOfId = /** @type {Map<number, Zone>} */ (new Map());
    /** @param {string} type @param {string} name @param {string} style @param {number[]} cells @param {Program[]} programs @param {boolean} buildable @returns {Zone} */
    const addZone = (type, name, style, cells, programs, buildable) => {
        const id = zones.length + 1;
        /** @type {Zone} */
        const zone = { id, type, name, style, cells, area: cells.length * CELL * CELL, buildable, centroid: { x: 0, z: 0 }, anchors: [], programs, bbox: { x0: 0, z0: 0, x1: 0, z1: 0 } };
        for (const c of cells) {
            zgrid[c] = id;
        }
        zones.push(zone);
        zoneOfId.set(id, zone);
        return zone;
    };

    const hq = region.hq ?? { x: (region.bbox.x0 + region.bbox.x1) / 2, z: (region.bbox.z0 + region.bbox.z1) / 2 };
    // centroid of candidate cells
    let sumX = 0;
    let sumZ = 0;
    for (let c = 0; c < cand.length; c += 1) {
        if (cand[c] === 1) {
            const p = cellCentre(c % cw, Math.floor(c / cw));
            sumX += p.x;
            sumZ += p.z;
        }
    }
    const centroid = candCount > 0 ? { x: sumX / candCount, z: sumZ / candCount } : { x: hq.x, z: hq.z };

    const degenerate = candCount < 60;
    /** @type {Street[]} */
    const streets = [];
    /** @type {number} */
    let reserveCellsTotal = 0;

    if (!degenerate) {
        /** @param {number} c @returns {number} score helper values */
        const blockIdx = (c) => {
            const p = cellCentre(c % cw, Math.floor(c / cw));
            const x = p.x - G.x0;
            const z = p.z - G.z0;
            return Math.min(N - 1, Math.max(0, z * G.w + x));
        };
        /** @param {number} c @param {string} anchor @param {Pt[]} seeds */
        const scoreCell = (c, anchor, seeds) => {
            const p = cellCentre(c % cw, Math.floor(c / cw));
            const bi = blockIdx(c);
            const dHq = Math.hypot(p.x - hq.x, p.z - hq.z);
            const dEdge = /** @type {number} */ (G.dist[bi]);
            const dRoad = /** @type {number} */ (roadDist[bi]);
            const dCentre = Math.hypot(p.x - centroid.x, p.z - centroid.z);
            let s = 0;
            const [mode, arg] = anchor.split(":");
            if (mode === "hq") {
                s = -dHq;
            } else if (mode === "near_hq") {
                s = -Math.abs(dHq - Number(arg ?? 50));
            } else if (mode === "far_hq") {
                s = dHq * 0.7 - dEdge * 0.2;
            } else if (mode === "edge") {
                s = -dEdge * 1.5 + dHq * 0.25;
            } else if (mode === "center") {
                s = -dCentre;
            } else if (mode === "road") {
                s = -dRoad * 1.2 - dCentre * 0.15;
            } else if (mode === "gate") {
                const dGate = gatePts.length > 0 ? Math.min(...gatePts.map((g) => Math.hypot(p.x - g.x, p.z - g.z))) : dEdge * 2;
                s = -dGate;
            } else if (mode === "inner") {
                s = Math.min(dRoad, 40) * 0.6 + Math.min(dEdge, 45) * 0.9;
            } else if (mode === "spread") {
                s = -dCentre * 0.2;
            }
            let near = 80;
            for (const sd of seeds) {
                near = Math.min(near, Math.hypot(p.x - sd.x, p.z - sd.z));
            }
            const minSep = mode === "hq" ? 0 : 26;
            if (near < minSep) {
                s -= (minSep - near) * 3;
            }
            s += Math.min(near, 80) * (mode === "spread" ? 1.1 : 0.15);
            return s + (rand() - 0.5) * 24;
        };
        /**
         * Noisy Dijkstra growth over free candidate coarse cells.
         * @param {number} seedCell
         * @param {number} target
         * @param {number} [compact] extra distance cost keeping blobs rounder
         * @returns {Generator<void, number[], void>}
         */
        const grow = function* (/** @type {number} */ seedCell, /** @type {number} */ target, compact = 0.04) {
            /** @type {number[]} */
            const taken = [];
            const best = new Map([[seedCell, 0]]);
            const heap = new MinHeap();
            heap.push(0, seedCell);
            const sp = cellCentre(seedCell % cw, Math.floor(seedCell / cw));
            const done = new Set();
            while (heap.size > 0 && taken.length < target) {
                const { key, val } = heap.pop();
                if (done.has(val)) {
                    continue;
                }
                done.add(val);
                taken.push(val);
                if ((taken.length & 31) === 0) yield* pace(ops, 32 * 200);
                const ci = val % cw;
                const cj = Math.floor(val / cw);
                for (const [dx, dz] of /** @type {[number, number][]} */ ([[1, 0], [-1, 0], [0, 1], [0, -1]])) {
                    const ni = ci + dx;
                    const nj = cj + dz;
                    if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) {
                        continue;
                    }
                    const n = nj * cw + ni;
                    if (cand[n] !== 1 || zgrid[n] !== 0 || done.has(n)) {
                        continue;
                    }
                    const p = cellCentre(ni, nj);
                    const nd = key + 1 + 1.1 * valueNoise(p.x, p.z, 17, seed) + compact * Math.hypot(p.x - sp.x, p.z - sp.z);
                    if (nd < (best.get(n) ?? Infinity)) {
                        best.set(n, nd);
                        heap.push(nd, n);
                    }
                }
            }
            return taken;
        };
        /** @param {number} c free candidate cells within 3 cells */
        const roomAt = (c) => {
            const ci = c % cw;
            const cj = Math.floor(c / cw);
            let n = 0;
            for (let dj = -3; dj <= 3; dj += 1) {
                for (let di = -3; di <= 3; di += 1) {
                    const a = ci + di;
                    const b = cj + dj;
                    if (a >= 0 && b >= 0 && a < cw && b < ch && cand[b * cw + a] === 1 && zgrid[b * cw + a] === 0) {
                        n += 1;
                    }
                }
            }
            return n;
        };
        /** @param {string} anchor @param {Pt[]} seeds @param {Set<number>} [bad] @returns {Generator<void, number, void>} */
        const pickSeed = function* (/** @type {string} */ anchor, /** @type {Pt[]} */ seeds, /** @type {Set<number> | undefined} */ bad = undefined) {
            let bestCell = -1;
            let bestScore = -Infinity;
            for (let c = 0; c < cand.length; c += 1) {
                if ((c & 7) === 7) yield* pace(ops, 8 * 600);
                if (cand[c] !== 1 || zgrid[c] !== 0 || bad?.has(c) === true) {
                    continue;
                }
                const room = roomAt(c);
                if (room < 20) {
                    continue;
                }
                const s = scoreCell(c, anchor, seeds) + room * 0.6;
                if (s > bestScore) {
                    bestScore = s;
                    bestCell = c;
                }
            }
            return bestCell;
        };

        // zone targets
        const reserveCells = Math.ceil((Math.max(0.15, opts.reserveFraction) * G.area) / (CELL * CELL));
        reserveCellsTotal = reserveCells;
        /** @type {{ def: ZoneDef, n: number, cells: number }[]} */
        const plan = [];
        let requested = 0;
        for (const def of /** @type {ZoneDef[]} */ (ROLE_ZONES[region.role])) {
            const repeat = def.repeat ?? 1;
            for (let n = 0; n < repeat; n += 1) {
                let area = 0;
                for (const program of def.programs) {
                    if (program.fill !== true) {
                        area += (program.count ?? 0) * lotFootprint(program.kind);
                    }
                }
                // big buildings need proportionally more land (road frontage, forecourts, clearance)
                let biggest = 0;
                for (const program of def.programs) {
                    const variantId = BLUEPRINT_VARIANTS[program.kind]?.[0];
                    const bpq = variantId === undefined ? undefined : BLUEPRINTS2[variantId];
                    if (bpq !== undefined && KIND_GROUP[program.kind] !== "farm") {
                        biggest = Math.max(biggest, bpq.size[0], bpq.size[2]);
                    }
                }
                const factor = def.style === "compound" ? 2.6 : biggest >= 15 ? 2.7 : biggest >= 11 ? 2.3 : 1.5;
                let cells = Math.ceil((area * factor) / (CELL * CELL));
                if (def.style === "neighbourhood") {
                    cells += 14;
                }
                if (def.style === "market") {
                    cells += 60;
                }
                if (def.style !== "field") {
                    cells = Math.max(def.minCells ?? 44, cells);
                    requested += cells;
                }
                plan.push({ def, n, cells });
            }
        }
        const fieldDef = plan.find((p) => p.def.style === "field");
        const commonsMin = Math.ceil(candCount * 0.02);
        const avail = candCount - reserveCells - commonsMin - (fieldDef !== undefined ? Math.ceil(candCount * (fieldDef.def.share ?? 0.4)) : 0);
        const scale = requested > avail ? Math.max(0.45, avail / requested) : 1;
        if (scale < 1) {
            notes.push(`zones scaled to ${scale.toFixed(2)} of requested area (requested ${String(requested)}, available ${String(avail)} cells)`);
        }

        /** @type {Pt[]} */
        const seeds = [];
        /** @param {{ def: ZoneDef, n: number, cells: number }} item @param {number} target */
        const place = function* (/** @type {{ def: ZoneDef, n: number, cells: number }} */ item, /** @type {number} */ target) {
            const bad = new Set();
            let seedCell = -1;
            /** @type {number[]} */
            let cells = [];
            for (let attempt = 0; attempt < 4; attempt += 1) {
                seedCell = yield* pickSeed(item.def.anchor, seeds, bad);
                if (seedCell < 0) {
                    return null;
                }
                cells = yield* grow(seedCell, target);
                if (cells.length >= Math.min(target * 0.6, 24)) {
                    break;
                }
                bad.add(seedCell);
                cells = [];
            }
            if (cells.length === 0) {
                return null;
            }
            seeds.push(cellCentre(seedCell % cw, Math.floor(seedCell / cw)));
            const name = (item.def.repeat ?? 1) > 1 ? `${item.def.name} ${["I", "II", "III", "IV", "V", "VI"][item.n] ?? String(item.n + 1)}` : item.def.name;
            return addZone(item.def.type, name, item.def.style, cells, item.def.programs.map((p) => ({ ...p })), true);
        };
        if (fieldDef !== undefined) {
            // the field zone is the biggest and must stay compact: grow it first from the flattest, most open place
            const target = Math.max(30, Math.floor(candCount * (fieldDef.def.share ?? 0.4)));
            const seedCell = yield* pickSeed("flat", seeds);
            if (seedCell >= 0) {
                const cells = yield* grow(seedCell, target, 0.03);
                if (cells.length >= 30) {
                    seeds.push(cellCentre(seedCell % cw, Math.floor(seedCell / cw)));
                    addZone("fields", fieldDef.def.name, "field", cells, fieldDef.def.programs.map((p) => ({ ...p })), true);
                }
            }
        }
        for (const item of plan) {
            if (item.def.style === "field") {
                continue;
            }
            const zone = yield* place(item, Math.max(18, Math.floor(item.cells * scale)));
            if (zone === null) {
                notes.push(`zone '${item.def.type}' could not be placed`);
            }
        }
        // reserve patches (accessible: near roads), then fields, then commons
        const patches = 4;
        for (let k = 0; k < patches; k += 1) {
            const seedCell = yield* pickSeed("inner", seeds);
            if (seedCell < 0) {
                break;
            }
            const cells = yield* grow(seedCell, Math.ceil(reserveCells / patches), 0.1);
            if (cells.length > 0) {
                seeds.push(cellCentre(seedCell % cw, Math.floor(seedCell / cw)));
                addZone("reserve", `Reserve land ${String(k + 1)}`, "reserve", cells, [], false);
            }
        }
        let reserveGot = zones.filter((z) => z.type === "reserve").reduce((s, z) => s + z.cells.length, 0);
        for (let guard = 0; reserveGot < reserveCells && guard < 6; guard += 1) {
            const seedCell = yield* pickSeed("inner", seeds);
            if (seedCell < 0) {
                break;
            }
            const cells = yield* grow(seedCell, reserveCells - reserveGot, 0.1);
            if (cells.length === 0) {
                break;
            }
            seeds.push(cellCentre(seedCell % cw, Math.floor(seedCell / cw)));
            addZone("reserve", `Reserve land ${String(zones.length)}`, "reserve", cells, [], false);
            reserveGot += cells.length;
        }
        if (fieldDef !== undefined) {
            const free = cand.reduce((s, v, i) => s + (v === 1 && zgrid[i] === 0 ? 1 : 0), 0);
            const target = Math.max(30, Math.floor((free - commonsMin) * 0.97));
            // fields may consist of several disconnected blobs: keep growing from fresh seeds until the target is met
            let got = 0;
            for (let guard = 0; guard < 5 && got < target * 0.9; guard += 1) {
                const seedCell = yield* pickSeed("flat", seeds);
                if (seedCell < 0) {
                    break;
                }
                const cells = yield* grow(seedCell, target - got, 0.01);
                if (cells.length < 12) {
                    for (const c of cells) {
                        zgrid[c] = 0;
                    }
                    break;
                }
                seeds.push(cellCentre(seedCell % cw, Math.floor(seedCell / cw)));
                addZone("fields", `${fieldDef.def.name} ${guard === 0 ? "" : String(guard + 1)}`.trim(), "field", cells, fieldDef.def.programs.map((p) => ({ ...p })), true);
                got += cells.length;
            }
        }
        const left = [];
        for (let c = 0; c < cand.length; c += 1) {
            if (cand[c] === 1 && zgrid[c] === 0) {
                left.push(c);
            }
        }
        if (left.length > 0) {
            addZone("commons", "Commons and meadow", "commons", left, [], false);
        }

        // last resort: the reserve must reach its target even in a fragmented district (lakes, rivers):
        // convert commons first, then the outermost cells of the lowest-priority zones
        {
            const reserveZones = zones.filter((z) => z.type === "reserve");
            let got = reserveZones.reduce((n, z) => n + z.cells.length, 0);
            let sink = reserveZones[0];
            if (got < reserveCells && sink === undefined) {
                sink = addZone("reserve", "Reserve land 1", "reserve", [], [], false);
            }
            /** @param {Zone} from @param {boolean} edgeFirst */
            const steal = (from, edgeFirst) => {
                if (sink === undefined) {
                    return;
                }
                const order = [...from.cells];
                if (edgeFirst && from.cells.length > 0) {
                    let sx = 0;
                    let sz = 0;
                    for (const c of from.cells) {
                        const p = cellCentre(c % cw, Math.floor(c / cw));
                        sx += p.x;
                        sz += p.z;
                    }
                    sx /= from.cells.length;
                    sz /= from.cells.length;
                    order.sort((a1, b1) => {
                        const pa = cellCentre(a1 % cw, Math.floor(a1 / cw));
                        const pb = cellCentre(b1 % cw, Math.floor(b1 / cw));
                        return Math.hypot(pb.x - sx, pb.z - sz) - Math.hypot(pa.x - sx, pa.z - sz);
                    });
                }
                const take = new Set(order.slice(0, Math.max(0, Math.min(order.length, reserveCells - got))));
                for (const c of take) {
                    zgrid[c] = sink.id;
                    sink.cells.push(c);
                }
                from.cells = from.cells.filter((c) => !take.has(c));
                from.area = from.cells.length * CELL * CELL;
                got += take.size;
            };
            const commonsZone = zones.find((z) => z.type === "commons");
            if (got < reserveCells && commonsZone !== undefined) {
                steal(commonsZone, false);
            }
            const donors = ["trade", "allotments", "depot", "militia", "yards", "pastures", "orchards"];
            for (const t of donors) {
                for (const z of zones.filter((q) => q.type === t)) {
                    if (got < reserveCells && z.cells.length > 30) {
                        steal(z, true);
                    }
                }
            }
            if (sink !== undefined) {
                sink.area = sink.cells.length * CELL * CELL;
            }
        }

        // squares: carve a public square in neighbourhood/market zones
        for (const zone of [...zones]) {
            const def = /** @type {ZoneDef[]} */ (ROLE_ZONES[region.role]).find((d) => d.type === zone.type);
            const r = def?.squareR ?? 0;
            if (r <= 0 || zone.cells.length < 20) {
                continue;
            }
            let sx = 0;
            let sz = 0;
            for (const c of zone.cells) {
                const p = cellCentre(c % cw, Math.floor(c / cw));
                sx += p.x;
                sz += p.z;
            }
            sx /= zone.cells.length;
            sz /= zone.cells.length;
            // centre cell: the zone cell closest to the centroid whose square holds no existing road
            const roadFreeAround = (/** @type {number} */ ci, /** @type {number} */ cj) => {
                const bx0 = (cx0 + ci - r) * CELL - G.x0 - 3;
                const bx1 = (cx0 + ci + r + 1) * CELL - G.x0 + 2;
                const bz0 = (cz0 + cj - r) * CELL - G.z0 - 3;
                const bz1 = (cz0 + cj + r + 1) * CELL - G.z0 + 2;
                for (let z = Math.max(0, bz0); z <= Math.min(G.h - 1, bz1); z += 1) {
                    for (let x = Math.max(0, bx0); x <= Math.min(G.w - 1, bx1); x += 1) {
                        if (G.road[z * G.w + x] === 1) {
                            return false;
                        }
                    }
                }
                return true;
            };
            /** @param {number} ci @param {number} cj */
            const fits = (ci, cj) => {
                for (let dj = -r; dj <= r; dj += 1) {
                    for (let di = -r; di <= r; di += 1) {
                        const a = ci + di;
                        const b = cj + dj;
                        if (a < 0 || b < 0 || a >= cw || b >= ch || zgrid[b * cw + a] !== zone.id) {
                            return false;
                        }
                    }
                }
                return true;
            };
            const ranked = [...zone.cells].sort((a1, b1) => {
                const pa = cellCentre(a1 % cw, Math.floor(a1 / cw));
                const pb = cellCentre(b1 % cw, Math.floor(b1 / cw));
                return Math.hypot(pa.x - sx, pa.z - sz) - Math.hypot(pb.x - sx, pb.z - sz);
            });
            let centreCell = ranked[0] ?? 0;
            for (const c of ranked) {
                if (fits(c % cw, Math.floor(c / cw)) && roadFreeAround(c % cw, Math.floor(c / cw))) {
                    centreCell = c;
                    break;
                }
            }
            const ci0 = centreCell % cw;
            const cj0 = Math.floor(centreCell / cw);
            /** @type {number[]} */
            const carve = [];
            for (let dj = -r; dj <= r; dj += 1) {
                for (let di = -r; di <= r; di += 1) {
                    const c = (cj0 + dj) * cw + (ci0 + di);
                    if (ci0 + di >= 0 && ci0 + di < cw && cj0 + dj >= 0 && cj0 + dj < ch && zgrid[c] === zone.id) {
                        carve.push(c);
                    }
                }
            }
            if (carve.length >= (2 * r + 1) * (2 * r + 1) * 0.7) {
                zone.cells = zone.cells.filter((c) => !carve.includes(c));
                zone.area = zone.cells.length * CELL * CELL;
                const sq = addZone("square", `${zone.name} square`, "square", carve, [], false);
                sq.parent = zone.id;
                sq.squareCenter = cellCentre(ci0, cj0);
                zone.squareCenter = sq.squareCenter;
            }
        }

        // ---------- streets
        const router = new RouterSteps(G, seed);
        const mask = G.road; // grows with new streets
        const baseNet = (/** @type {number} */ i) => mask[i] === 1 && G.ins[i] === 1;
        /** @param {number} i */
        const passCost = (i) => {
            if (elig[i] !== 1) {
                return Infinity;
            }
            const x = (i % G.w) + G.x0;
            const z = Math.floor(i / G.w) + G.z0;
            const zid = zgrid[(Math.floor(z / CELL) - cz0) * cw + (Math.floor(x / CELL) - cx0)] ?? 0;
            const t = zid === 0 ? "none" : /** @type {Zone} */ (zoneOfId.get(zid)).type;
            if (t === "square") {
                return Infinity;
            }
            return t === "reserve" ? 4 : t === "fields" ? 6 : t === "commons" ? 1.6 : 1;
        };
        let netCells = 0;
        for (let i = 0; i < N; i += 1) {
            if (baseNet(i)) {
                netCells += 1;
            }
        }
        if (netCells < 25) {
            // no usable roads inside this district: lay a spine from the HQ to the far side
            /** @type {{ c: number, d: number }[]} */
            const okCells = [];
            for (let c = 0; c < cand.length; c += 1) {
                if (cand[c] === 1 && elig[blockIdx(c)] === 1) {
                    const p = cellCentre(c % cw, Math.floor(c / cw));
                    okCells.push({ c, d: Math.hypot(p.x - hq.x, p.z - hq.z) });
                }
            }
            okCells.sort((a, b) => a.d - b.d);
            const startCell = okCells[0]?.c ?? -1;
            const ends = okCells.slice(-8).reverse();
            for (const end of ends) {
                if (startCell < 0 || startCell === end.c) {
                    continue;
                }
                const si = blockIdx(startCell);
                const ei = blockIdx(end.c);
                const path = yield* router.routeSteps([si], (i) => i === ei, (i) => (elig[i] === 1 ? 1 : Infinity), 160000, ops);
                if (path !== null) {
                    const cells = path.map((i) => /** @type {[number, number]} */ ([(i % G.w) + G.x0, Math.floor(i / G.w) + G.z0]));
                    stampCells(G, mask, cells, 2);
                    streets.push({ id: `d${String(region.index)}-spine`, kind: "spine", width: 5, zone: 0, path: cells });
                    notes.push("no roads inside the district: laid a spine street");
                    break;
                }
            }
        }
        /**
         * Connect a set of source cells to the network and record the street.
         * @param {number[]} sources
         * @param {Zone} zone
         * @param {string} kind
         * @param {number} width
         */
        const connect = function* (/** @type {number[]} */ sources, /** @type {Zone} */ zone, /** @type {string} */ kind, /** @type {number} */ width) {
            if (sources.some((i) => baseNet(i))) {
                return true;
            }
            const path = yield* router.routeSteps(sources, baseNet, passCost, 60000, ops);
            if (path === null) {
                return false;
            }
            const cells = path.map((i) => /** @type {[number, number]} */ ([(i % G.w) + G.x0, Math.floor(i / G.w) + G.z0]));
            stampCells(G, mask, cells, (width - 1) / 2);
            streets.push({ id: `d${String(region.index)}-s${String(streets.length + 1)}`, kind, width, zone: zone.id, path: cells });
            return true;
        };
        /** @param {Zone} zone @returns {Generator<void, number[], void>} elig block cells of the zone */
        const zoneBlocks = function* (/** @type {Zone} */ zone) {
            /** @type {number[]} */
            const out = [];
            let seenCells = 0;
            for (const c of zone.cells) {
                seenCells += 1;
                if ((seenCells & 15) === 0) yield* pace(ops, 16 * CELL * CELL * 6);
                const ox = (cx0 + (c % cw)) * CELL - G.x0;
                const oz = (cz0 + Math.floor(c / cw)) * CELL - G.z0;
                for (let dz = 0; dz < CELL; dz += 1) {
                    for (let dx = 0; dx < CELL; dx += 1) {
                        const x = ox + dx;
                        const z = oz + dz;
                        if (x >= 0 && z >= 0 && x < G.w && z < G.h && elig[z * G.w + x] === 1) {
                            out.push(z * G.w + x);
                        }
                    }
                }
            }
            return out;
        };
        for (const zone of zones) {
            if (zone.type === "reserve" || zone.type === "commons" || zone.type === "square") {
                continue;
            }
            let sx = 0;
            let sz = 0;
            let minX = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxZ = -Infinity;
            for (const c of zone.cells) {
                const p = cellCentre(c % cw, Math.floor(c / cw));
                sx += p.x;
                sz += p.z;
                minX = Math.min(minX, p.x - 2);
                minZ = Math.min(minZ, p.z - 2);
                maxX = Math.max(maxX, p.x + 1);
                maxZ = Math.max(maxZ, p.z + 1);
            }
            zone.centroid = { x: Math.round(sx / Math.max(1, zone.cells.length)), z: Math.round(sz / Math.max(1, zone.cells.length)) };
            zone.bbox = { x0: minX, z0: minZ, x1: maxX, z1: maxZ };
            const blocks = yield* zoneBlocks(zone);
            if (blocks.length === 0) {
                continue;
            }
            if (zone.style === "field") {
                // straight parallel farm tracks, added wherever field land is farther than plot reach from every road
                const alongX = hash2(zone.id, region.index, seed) < 0.5;
                const inZone = new Set(blocks);
                const skip = new Set();
                // 1) a regular lattice of tracks: two rows of plots (<= 25 deep) per track with a gap between pairs
                {
                    const pitch = 56;
                    const lo = alongX ? zone.bbox.z0 : zone.bbox.x0;
                    const hi = alongX ? zone.bbox.z1 : zone.bbox.x1;
                    const from = alongX ? zone.bbox.x0 : zone.bbox.z0;
                    const to = alongX ? zone.bbox.x1 : zone.bbox.z1;
                    const first = lo + 20 + Math.floor(rand() * 20);
                    for (let c = first; c <= hi; c += pitch) {
                        /** @type {number[]} */
                        let run = [];
                        const flush = function* () {
                            if (run.length >= 28) {
                                const cells = run.map((i) => /** @type {[number, number]} */ ([(i % G.w) + G.x0, Math.floor(i / G.w) + G.z0]));
                                const ends = [/** @type {number} */ (run[0]), /** @type {number} */ (run[run.length - 1])];
                                if (run.some((i) => baseNet(i)) || (yield* connect(ends, zone, "link", 3))) {
                                    stampCells(G, mask, cells, 1);
                                    streets.push({ id: `d${String(region.index)}-t${String(streets.length + 1)}`, kind: "track", width: 3, zone: zone.id, path: cells });
                                }
                            }
                            run = [];
                        };
                        for (let t = from; t <= to; t += 1) {
                            if ((t & 255) === 255) yield* pace(ops, 256 * 30);
                            const x = alongX ? t : c;
                            const z = alongX ? c : t;
                            const bx = x - G.x0;
                            const bz = z - G.z0;
                            const i = bz * G.w + bx;
                            if (bx >= 0 && bz >= 0 && bx < G.w && bz < G.h && inZone.has(i) && mask[i] === 0) {
                                run.push(i);
                            } else {
                                yield* flush();
                            }
                        }
                        yield* flush();
                    }
                }
                // 2) fill-in tracks wherever field land is still far from every road
                for (let round = 0; round < 60; round += 1) {
                    const net = new Uint8Array(N);
                    for (let i = 0; i < N; i += 1) {
                        if ((i & 4095) === 4095) yield* pace(ops, 4096 * 2);
                        net[i] = mask[i] === 1 && G.ins[i] === 1 ? 1 : 0;
                    }
                    const dn = yield* distanceTransformSteps(G.w, G.h, net, ops);
                    let bi = -1;
                    let bd = 40;
                    let scanned = 0;
                    for (const b of blocks) {
                        scanned += 1;
                        if ((scanned & 255) === 0) yield* pace(ops, 256 * 24);
                        if (skip.has(b)) {
                            continue;
                        }
                        const v = /** @type {number} */ (dn[b]) + hash2(b, round, seed) * 3;
                        if (v > bd) {
                            bd = v;
                            bi = b;
                        }
                    }
                    if (bi < 0) {
                        break;
                    }
                    /** @type {number[]} */
                    const run = [bi];
                    for (const dir of [-1, 1]) {
                        let cur = bi;
                        for (let k = 0; k < 400; k += 1) {
                            if ((k & 127) === 127) yield* pace(ops, 128 * 30);
                            const nx = (cur % G.w) + (alongX ? dir : 0);
                            const nz = Math.floor(cur / G.w) + (alongX ? 0 : dir);
                            if (nx < 0 || nz < 0 || nx >= G.w || nz >= G.h) {
                                break;
                            }
                            const ni = nz * G.w + nx;
                            if (!inZone.has(ni)) {
                                break;
                            }
                            run.push(ni);
                            cur = ni;
                            if (mask[ni] === 1) {
                                break;
                            }
                        }
                    }
                    for (const b of blocks.length > 0 ? [bi] : []) {
                        skip.add(b);
                    }
                    if (run.length < 20) {
                        continue;
                    }
                    const cells = run.map((i) => /** @type {[number, number]} */ ([(i % G.w) + G.x0, Math.floor(i / G.w) + G.z0]));
                    cells.sort((p, q) => (alongX ? p[0] - q[0] : p[1] - q[1]));
                    const sorted = cells.map(([x, z]) => (z - G.z0) * G.w + (x - G.x0));
                    // connect from the track's ends (a headland road), never from its middle, so links do not cut the field
                    const ends = [/** @type {number} */ (sorted[0]), /** @type {number} */ (sorted[sorted.length - 1])];
                    if (sorted.some((i) => baseNet(i)) || (yield* connect(ends, zone, "link", 3))) {
                        stampCells(G, mask, cells, 1);
                        streets.push({ id: `d${String(region.index)}-t${String(streets.length + 1)}`, kind: "track", width: 3, zone: zone.id, path: cells });
                    }
                }
                continue;
            }
            // anchors by farthest-point sampling over the zone cells
            const sep = zone.style === "compound" ? 9999 : zone.style === "market" ? 34 : 30;
            const wantAnchors = zone.style === "compound" ? 1 : Math.max(1, Math.min(14, Math.round((zone.cells.length * CELL * CELL) / (sep * sep * 0.85))));
            /** @type {number[]} */
            const anchorCells = [];
            let first = zone.cells[0] ?? 0;
            if (zone.squareCenter !== undefined) {
                let bd = Infinity;
                for (const c of zone.cells) {
                    const p = cellCentre(c % cw, Math.floor(c / cw));
                    const d = Math.hypot(p.x - zone.squareCenter.x, p.z - zone.squareCenter.z);
                    if (d < bd) {
                        bd = d;
                        first = c;
                    }
                }
            } else {
                let bd = Infinity;
                for (const c of zone.cells) {
                    const p = cellCentre(c % cw, Math.floor(c / cw));
                    // compounds are served from their edge nearest the road network so the street does not cut them in two
                    const d = zone.style === "compound" ? /** @type {number} */ (roadDist[blockIdx(c)]) : Math.hypot(p.x - zone.centroid.x, p.z - zone.centroid.z);
                    if (d < bd) {
                        bd = d;
                        first = c;
                    }
                }
            }
            anchorCells.push(first);
            while (anchorCells.length < wantAnchors) {
                let bc = -1;
                let bs = -1;
                for (const c of zone.cells) {
                    if ((c & 15) === 0) yield* pace(ops, 16 * (anchorCells.length + 1) * 40);
                    const p = cellCentre(c % cw, Math.floor(c / cw));
                    let near = Infinity;
                    for (const a of anchorCells) {
                        const q = cellCentre(a % cw, Math.floor(a / cw));
                        near = Math.min(near, Math.hypot(p.x - q.x, p.z - q.z));
                    }
                    const s = near + rand() * 6;
                    if (s > bs) {
                        bs = s;
                        bc = c;
                    }
                }
                if (bc < 0 || bs < sep * 0.7) {
                    break;
                }
                anchorCells.push(bc);
            }
            for (const a of anchorCells) {
                const p = cellCentre(a % cw, Math.floor(a / cw));
                zone.anchors.push(p);
                // pick an eligible block of that coarse cell nearest its centre
                let bi = -1;
                let bd = Infinity;
                let scannedBlocks = 0;
                for (const b of blocks) {
                    scannedBlocks += 1;
                    if ((scannedBlocks & 255) === 0) yield* pace(ops, 256 * 24);
                    const bx = (b % G.w) + G.x0;
                    const bz = Math.floor(b / G.w) + G.z0;
                    if ((Math.floor(bx / CELL) - cx0) + (Math.floor(bz / CELL) - cz0) * cw !== a) {
                        continue;
                    }
                    const d = Math.hypot(bx - p.x, bz - p.z);
                    if (d < bd) {
                        bd = d;
                        bi = b;
                    }
                }
                if (bi < 0) {
                    continue;
                }
                if (!(yield* connect([bi], zone, "street", opts.streetWidth))) {
                    notes.push(`zone ${zone.name}: an anchor could not reach the street network`);
                }
            }
            // add streets until the zone has enough frontage for its programs (lateral width + gap per lot, two sides)
            if (zone.style !== "compound") {
                let need = 0;
                for (const program of zone.programs) {
                    const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[/** @type {string} */ (BLUEPRINT_VARIANTS[program.kind]?.[0])]);
                    need += ((program.count ?? 0) * (Math.max(bp.size[0], bp.size[2]) + 8)) / 2;
                }
                for (let round = 0; round < 10; round += 1) {
                    let have = 0;
                    yield* pace(ops, Math.min(23000, blocks.length * 3));
                    for (const b of blocks) {
                        if (mask[b] === 1) {
                            have += 1;
                        }
                    }
                    if (have / 3.5 >= need * 1.7) {
                        break;
                    }
                    const net = new Uint8Array(N);
                    for (let i = 0; i < N; i += 1) {
                        if ((i & 4095) === 4095) yield* pace(ops, 4096 * 2);
                        net[i] = mask[i] === 1 && G.ins[i] === 1 ? 1 : 0;
                    }
                    const dn = yield* distanceTransformSteps(G.w, G.h, net, ops);
                    let bi = -1;
                    let bd = 13;
                    let scannedRound = 0;
                    for (const b of blocks) {
                        scannedRound += 1;
                        if ((scannedRound & 255) === 0) yield* pace(ops, 256 * 24);
                        const v = /** @type {number} */ (dn[b]) + hash2(b, round, seed) * 2;
                        const x = (b % G.w) + G.x0;
                        const z = Math.floor(b / G.w) + G.z0;
                        if (v > bd && zoneAt(x, z) === zone.id) {
                            bd = v;
                            bi = b;
                        }
                    }
                    if (bi < 0 || !(yield* connect([bi], zone, "street", opts.streetWidth))) {
                        break;
                    }
                }
            }
        }
        for (const zone of zones) {
            if (zone.type === "reserve" || zone.type === "commons" || zone.type === "square") {
                let sx = 0;
                let sz = 0;
                let minX = Infinity;
                let minZ = Infinity;
                let maxX = -Infinity;
                let maxZ = -Infinity;
                for (const c of zone.cells) {
                    const p = cellCentre(c % cw, Math.floor(c / cw));
                    sx += p.x;
                    sz += p.z;
                    minX = Math.min(minX, p.x - 2);
                    minZ = Math.min(minZ, p.z - 2);
                    maxX = Math.max(maxX, p.x + 1);
                    maxZ = Math.max(maxZ, p.z + 1);
                }
                zone.centroid = { x: Math.round(sx / Math.max(1, zone.cells.length)), z: Math.round(sz / Math.max(1, zone.cells.length)) };
                zone.bbox = { x0: minX, z0: minZ, x1: maxX, z1: maxZ };
            }
        }
    }

    // patrol lane: 2 blocks wide, 3..5 blocks inside the wall
    /** @type {[number, number][]} */
    const patrol = [];
    for (let z = 0; z < G.h; z += 1) {
        yield* pace(ops, G.w * 6);
        for (let x = 0; x < G.w; x += 1) {
            const i = z * G.w + x;
            const d = /** @type {number} */ (G.dist[i]);
            if (G.ins[i] === 1 && G.wall[i] === 0 && d >= 3 && d < 5) {
                patrol.push([G.x0 + x, G.z0 + z]);
            }
        }
    }

    const reserveArea = zones.filter((z) => z.type === "reserve").reduce((s, z) => s + z.area, 0);
    const typeCount = /** @type {Record<string, number>} */ ({});
    for (const z of zones) {
        typeCount[z.type] = (typeCount[z.type] ?? 0) + 1;
    }
    let perimeterCount = 0;
    for (let i = 0; i < N; i += 1) {
        if ((i & 4095) === 4095) yield* pace(ops, 4096 * 3);
        const d = /** @type {number} */ (G.dist[i]);
        if (G.ins[i] === 1 && G.wall[i] === 0 && d >= setback + 1 && d < setback + 2) {
            perimeterCount += 1;
        }
    }
    const perimeter = perimeterCount;
    const role = region.role;
    const guardPosts = Math.max(4, Math.min(12, Math.round((perimeter / opts.perimeterGuardEvery) * (role === "command" ? 1.4 : 1))));
    const towers = Math.max(2, Math.min(6, Math.round(perimeter / opts.perimeterTowerEvery)));

    return {
        version: ZONING_VERSION,
        index: region.index,
        role,
        seed,
        setback,
        cell: CELL,
        bbox: { x0: G.x0, z0: G.z0, x1: G.x0 + G.w - 1, z1: G.z0 + G.h - 1 },
        area: G.area,
        degenerate,
        zones,
        zoneAt,
        zoneById: (/** @type {number} */ id) => zoneOfId.get(id),
        streets,
        patrol: { width: 2, offset: 3, cells: patrol },
        reserve: { area: reserveArea, fraction: G.area > 0 ? reserveArea / G.area : 0, target: reserveCellsTotal * CELL * CELL, patches: typeCount["reserve"] ?? 0 },
        defence: { guardPosts, towers, perimeter, minDist: setback + 1, maxDist: setback + 9 },
        minComposition: MIN_COMPOSITION,
        notes,
        grids: G,
        elig,
        gateMask,
        gates: gatePts,
        hq,
    };
}

