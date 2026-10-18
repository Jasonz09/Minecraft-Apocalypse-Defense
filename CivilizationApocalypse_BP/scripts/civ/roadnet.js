/**
 * Terrain-adaptive road network for the civilization master plan (pure). Roads are found with Dijkstra
 * (A* with a zero heuristic, so the cheapest route is exact) on the coarse 4-block cost grid, confined to the
 * district they serve and kept clear of walls except through gate links, then smoothed and simplified.
 * Owner: planner agent (A).
 *
 * Operation budget: one search per terminal (HQ + each gate approach), each bounded by the district's cells
 * (<= ~2.5k cells * 8 neighbours); about 25-30 searches per plan.
 */

import { CELL, WORK_LIMIT, markYield } from "./regions.js";
import { MinHeap, simplifyPath, smoothPath, valueNoise2, hash2, pathLength } from "./geom.js";

/** @typedef {[number, number]} Pt */
/** @typedef {import("./regions.js").Terrain} Terrain */
/** @typedef {import("./regions.js").Ops} Ops */
/** @typedef {{ id: string, kind: "arterial" | "street" | "link", district: number, width: number, path: Pt[] }} Road */

/**
 * Mark coarse cells whose centre lies within `margin` blocks of a wall pixel.
 * @param {Terrain} t @param {ReadonlyArray<Pt>} wallPixels @param {number} margin @param {Ops} ops
 * @returns {Generator<void, Uint8Array, void>}
 */
export function* wallClearanceSteps(t, wallPixels, margin, ops) {
    const mask = new Uint8Array(t.w * t.h);
    const reach = Math.ceil(margin / CELL) + 1;
    for (const [x, z] of wallPixels) {
        ops.work += (2 * reach + 1) * (2 * reach + 1);
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        const i0 = Math.floor((x - t.x0) / CELL);
        const j0 = Math.floor((z - t.z0) / CELL);
        for (let dj = -reach; dj <= reach; dj += 1) {
            for (let di = -reach; di <= reach; di += 1) {
                const i = i0 + di;
                const j = j0 + dj;
                if (i < 0 || j < 0 || i >= t.w || j >= t.h) continue;
                if (Math.hypot(t.x0 + i * CELL + 2 - x, t.z0 + j * CELL + 2 - z) <= margin) mask[j * t.w + i] = 1;
            }
        }
    }
    return mask;
}

/**
 * @param {Terrain} t @param {number} x @param {number} z
 */
function cellOf(t, x, z) {
    const i = Math.floor((x - t.x0) / CELL);
    const j = Math.floor((z - t.z0) / CELL);
    if (i < 0 || j < 0 || i >= t.w || j >= t.h) return -1;
    return j * t.w + i;
}

/**
 * @typedef {object} RoadInput
 * @property {Terrain} terrain
 * @property {Uint8Array} labels final cell labels (same grid as terrain)
 * @property {Array<{ d: number, x: number, z: number }>} hqs
 * @property {Array<{ id: string, at: { x: number, z: number }, axis: "x" | "z", between: [number, number] }>} gates
 * @property {Uint8Array} wallMask coarse cells too close to a wall
 * @property {number} seed
 * @property {Ops} ops
 */

/**
 * Side point of a gate inside district d (wall runs along `axis`, so the passage is perpendicular to it).
 * @param {RoadInput} inp @param {{ at: { x: number, z: number }, axis: "x" | "z" }} gate @param {number} d @param {number} dist
 * @returns {Pt}
 */
export function gateSide(inp, gate, d, dist) {
    const t = inp.terrain;
    /** @type {Pt[]} */
    const cands = gate.axis === "x"
        ? [[gate.at.x, gate.at.z - dist], [gate.at.x, gate.at.z + dist]]
        : [[gate.at.x - dist, gate.at.z], [gate.at.x + dist, gate.at.z]];
    for (const c of cands) {
        const idx = cellOf(t, c[0], c[1]);
        const lab = idx < 0 ? 0 : inp.labels[idx];
        if (lab === d) return c;
    }
    return cands[0];
}

/**
 * Cheapest route (in the district, away from walls) from `from` to the nearest point of `network`
 * (map cell index -> block point) or, when the network is empty, to `to`.
 * @param {RoadInput} inp @param {number} d @param {Pt} from @param {Map<number, Pt>} network @param {number} salt
 * @param {{ dist: Float64Array, prev: Int32Array }} scratch reusable arrays (all Infinity / -1 between searches)
 * @returns {Generator<void, Pt[] | null, void>} block-coordinate polyline from `from` to a network point
 */
function* route(inp, d, from, network, salt, scratch) {
    const ops = inp.ops;
    const t = inp.terrain;
    const { w, h } = t;
    const n = w * h;
    const src = cellOf(t, from[0], from[1]);
    if (src < 0) return null;
    if (network.has(src)) {
        const hit0 = /** @type {Pt} */ (network.get(src));
        return [[from[0], from[1]], [hit0[0], hit0[1]]];
    }
    const dist = scratch.dist;
    const prev = scratch.prev;
    /** @type {number[]} */
    const touched = [src];
    const reset = () => { for (const q of touched) { dist[q] = Infinity; prev[q] = -1; } };
    void n;
    const heap = new MinHeap();
    dist[src] = 0;
    heap.push(0, src);
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
    while (heap.size > 0) {
        const [dd, idx] = heap.pop();
        ops.work += 9;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        if (dd > dist[idx]) continue;
        inp.ops.astarPops += 1;
        if (network.has(idx) && idx !== src) {
            /** @type {number[]} */
            const cells = [];
            for (let c = idx; c !== -1; c = prev[c]) cells.push(c);
            cells.reverse();
            /** @type {Pt[]} */
            const pts = [[from[0], from[1]]];
            for (let k = 1; k < cells.length - 1; k += 1) pts.push([t.x0 + (cells[k] % w) * CELL + 2, t.z0 + Math.floor(cells[k] / w) * CELL + 2]);
            const hit = /** @type {Pt} */ (network.get(idx));
            pts.push([hit[0], hit[1]]);
            reset();
            return pts;
        }
        const i = idx % w;
        const j = (idx - i) / w;
        for (let k = 0; k < 8; k += 1) {
            const ni = i + DX[k];
            const nj = j + DZ[k];
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            const nidx = nj * w + ni;
            if (inp.labels[nidx] !== d) continue;
            if (inp.wallMask[nidx] && !network.has(nidx)) continue;
            const base = t.passable[nidx] ? 1 + 0.5 * t.relief[nidx] + 0.3 * t.tree[nidx] : t.water[nidx] ? 14 : 40;
            const wob = 1 + 0.5 * (valueNoise2(ni * CELL, nj * CELL, 44, inp.seed + salt) - 0.5);
            const nd = dd + (k < 4 ? 1 : 1.4142) * base * wob;
            if (nd < dist[nidx]) {
                if (dist[nidx] === Infinity) touched.push(nidx);
                dist[nidx] = nd;
                prev[nidx] = idx;
                heap.push(nd, nidx);
            }
        }
    }
    reset();
    return null;
}

/**
 * Smooth and simplify a road polyline; endpoints fixed. Returns integer points.
 * @param {Pt[]} pts
 * @returns {Pt[]}
 */
function finishRoad(pts) {
    const sm = smoothPath(pts, 4, false);
    const simple = simplifyPath(sm, 2.4);
    /** @type {Pt[]} */
    const out = [];
    for (const p of simple) {
        const q = /** @type {Pt} */ ([Math.round(p[0]), Math.round(p[1])]);
        const last = out[out.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
    }
    return out;
}

/**
 * Densify a road path into the network map (one entry per coarse cell).
 * @param {Terrain} t @param {Pt[]} pts @param {Map<number, Pt>} network
 */
function addToNetwork(t, pts, network) {
    for (let k = 0; k + 1 < pts.length; k += 1) {
        const a = pts[k];
        const b = pts[k + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
        for (let s = 0; s <= steps; s += 1) {
            const x = Math.round(a[0] + ((b[0] - a[0]) * s) / steps);
            const z = Math.round(a[1] + ((b[1] - a[1]) * s) / steps);
            const idx = cellOf(t, x, z);
            if (idx >= 0 && !network.has(idx)) network.set(idx, [x, z]);
        }
    }
}

/**
 * Build arterials (HQ <-> gate approaches), gate links and street skeletons for all districts.
 * @param {RoadInput} inp
 * @returns {Generator<void, { roads: Road[], fallbacks: number }, void>}
 */
export function* planRoadsSteps(inp) {
    const t = inp.terrain;
    const ops = inp.ops;
    const scratch = { dist: new Float64Array(t.w * t.h).fill(Infinity), prev: new Int32Array(t.w * t.h).fill(-1) };
    ops.work += (t.w * t.h) >> 3;
    if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
    /** @type {Road[]} */
    const roads = [];
    let fallbacks = 0;
    let counter = 0;
    /** @param {Road["kind"]} kind @param {number} district @param {number} width @param {Pt[]} path */
    const add = (kind, district, width, path) => {
        counter += 1;
        roads.push({ id: `road-${String(counter)}`, kind, district, width, path });
    };
    for (let d = 1; d <= 5; d += 1) {
        const hq = inp.hqs.find((q) => q.d === d);
        if (!hq) continue;
        /** @type {Map<number, Pt>} */
        const network = new Map();
        const hqPt = /** @type {Pt} */ ([hq.x, hq.z]);
        const hqCell = cellOf(t, hq.x, hq.z);
        if (hqCell >= 0) network.set(hqCell, hqPt);
        /** @type {Pt[]} */
        const terminals = [];
        for (const g of inp.gates) {
            if (g.between[0] === d || g.between[1] === d) terminals.push(gateSide(inp, g, d, 10));
        }
        terminals.sort((p, q) => Math.hypot(p[0] - hq.x, p[1] - hq.z) - Math.hypot(q[0] - hq.x, q[1] - hq.z));
        /** @type {Road[]} */
        const mine = [];
        for (let ti = 0; ti < terminals.length; ti += 1) {
            const term = terminals[ti];
            let pts = yield* route(inp, d, term, network, ti * 7 + d, scratch);
            if (!pts) {
                fallbacks += 1;
                pts = [term, hqPt];
            }
            ops.work += pts.length * 12;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            const fin = finishRoad(pts);
            if (fin.length < 2) continue;
            add("arterial", d, 5, fin);
            mine.push(roads[roads.length - 1]);
            addToNetwork(t, fin, network);
        }
        // street skeleton: perpendicular spurs off the arterials
        let streets = 0;
        for (const road of mine) {
            let carried = 14;
            for (let k = 0; k + 1 < road.path.length && streets < 12; k += 1) {
                ops.work += 60;
                if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
                const a = road.path[k];
                const b = road.path[k + 1];
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                if (len < 1) continue;
                const ux = (b[0] - a[0]) / len;
                const uz = (b[1] - a[1]) / len;
                for (let s = carried; s < len && streets < 12; s += 30) {
                    const px = a[0] + ux * s;
                    const pz = a[1] + uz * s;
                    for (const side of [1, -1]) {
                        if (streets >= 12) break;
                        if (hash2(Math.round(px), Math.round(pz), inp.seed + side) < 0.18) continue;
                        let reach = 0;
                        for (let step = 4; step <= 36; step += 4) {
                            const qx = px - uz * side * step;
                            const qz = pz + ux * side * step;
                            const ci = cellOf(t, qx, qz);
                            if (ci < 0 || inp.labels[ci] !== d || inp.wallMask[ci] || !t.passable[ci]) break;
                            reach = step;
                        }
                        if (reach >= 12) {
                            const mx = px - uz * side * (reach / 2) + ux * (valueNoise2(px, pz, 17, inp.seed) - 0.5) * 6;
                            const mz = pz + ux * side * (reach / 2) + uz * (valueNoise2(px, pz, 17, inp.seed) - 0.5) * 6;
                            add("street", d, 3, [
                                [Math.round(px), Math.round(pz)],
                                [Math.round(mx), Math.round(mz)],
                                [Math.round(px - uz * side * reach), Math.round(pz + ux * side * reach)],
                            ]);
                            streets += 1;
                        }
                    }
                    carried = 14;
                }
                carried = Math.max(8, carried - len);
            }
        }
    }
    // gate links straight through each gate
    for (const g of inp.gates) {
        const [a, b] = g.between;
        const first = a > 0 ? a : b;
        const sa = gateSide(inp, g, first, 10);
        const other = first === a ? b : a;
        /** @type {Pt} */
        const sb = other > 0 ? gateSide(inp, g, other, 10) : (g.axis === "x"
            ? [g.at.x, g.at.z + (sa[1] < g.at.z ? 10 : -10)]
            : [g.at.x + (sa[0] < g.at.x ? 10 : -10), g.at.z]);
        add("link", first, 5, [sa, [g.at.x, g.at.z], sb]);
    }
    return { roads, fallbacks };
}

/**
 * Total road length in blocks.
 * @param {Road[]} roads
 */
export function totalRoadLength(roads) {
    return roads.reduce((s, r) => s + pathLength(r.path, false), 0);
}
