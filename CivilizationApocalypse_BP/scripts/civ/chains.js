/**
 * Planar boundary chains for the civilization master plan (pure). A label grid (0 = outside, 1..5 districts)
 * is turned into chains of lattice vertices between junctions. Every neighbour pair shares ONE chain object, so
 * shared walls are identical by construction. Chains are then smoothed (endpoints fixed), straight axis-aligned
 * runs (>= 12 blocks, where gates go) are pinned or forced, and the result is simplified.
 * Owner: planner agent (A).
 */

import { CELL, WORK_LIMIT, markYield } from "./regions.js";
import { pointInPolygon, polygonArea, simplifyIndices, smoothPath, segmentsCross, pathLength, bboxOf } from "./geom.js";

/** @typedef {[number, number]} Pt */
/** @typedef {{ i0: number, i1: number, axis: "x" | "z", len: number }} Run */
/**
 * @typedef {object} Chain
 * @property {number} id
 * @property {number} left district on the left of the traversal direction (0 = outside)
 * @property {number} right
 * @property {boolean} closed pure loop with no junction (first point == last point)
 * @property {Pt[]} pts integer vertices, endpoints are junction lattice points (identical for neighbouring chains)
 * @property {Run[]} runs straight axis-aligned runs: indices into `pts`, first/last point of each run are consecutive vertices
 * @property {number} length
 */

/**
 * @param {Uint8Array} labels @param {number} w @param {number} h @param {number} gx0 @param {number} gz0
 * @param {import("./regions.js").Ops} ops
 * @returns {Generator<void, Chain[], void>} raw (lattice-level, dense) chains
 */
export function* extractChainsSteps(labels, w, h, gx0, gz0, ops) {
    const W = w + 1;
    /** @param {number} i @param {number} j */
    const L = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : labels[j * w + i]);
    const nv = W * (h + 1);
    /** @type {Array<Array<{ to: number, left: number, right: number }>>} */
    const out = Array.from({ length: nv }, () => []);
    for (let vz = 0; vz <= h; vz += 1) {
        ops.work += W * 4;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let vx = 0; vx <= w; vx += 1) {
            const v = vz * W + vx;
            if (vx < w) {
                const north = L(vx, vz - 1);
                const south = L(vx, vz);
                if (north !== south) {
                    out[v].push({ to: v + 1, left: south, right: north });
                    out[v + 1].push({ to: v, left: north, right: south });
                }
            }
            if (vz < h) {
                const west = L(vx - 1, vz);
                const east = L(vx, vz);
                if (west !== east) {
                    out[v].push({ to: v + W, left: west, right: east });
                    out[v + W].push({ to: v, left: east, right: west });
                }
            }
        }
    }
    /** @type {Set<number>} */
    const used = new Set();
    /** @param {number} a @param {number} b */
    const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
    /** @param {number} v @returns {Pt} */
    const world = (v) => [gx0 + (v % W) * CELL, gz0 + Math.floor(v / W) * CELL];
    /** @type {Chain[]} */
    const chains = [];
    /** @param {number} start @param {{ to: number, left: number, right: number }} first @param {boolean} loopStart */
    const trace = (start, first, loopStart) => {
        let steps = 0;
        /** @type {Pt[]} */
        const pts = [world(start)];
        used.add(key(start, first.to));
        let prev = start;
        let cur = first.to;
        pts.push(world(cur));
        while (cur !== start && out[cur].length === 2) {
            const nxt = out[cur].find((e) => e.to !== prev) ?? out[cur][0];
            used.add(key(cur, nxt.to));
            prev = cur;
            cur = nxt.to;
            pts.push(world(cur));
            steps += 1;
        }
        ops.work += steps + 2;
        chains.push({ id: chains.length, left: first.left, right: first.right, closed: loopStart && cur === start, pts, runs: [], length: 0 });
    };
    for (let v = 0; v < nv; v += 1) {
        if ((v & 255) === 255) {
            ops.work += 256;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
        if (out[v].length < 3) continue;
        for (const e of out[v]) if (!used.has(key(v, e.to))) trace(v, e, false);
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
    }
    for (let v = 0; v < nv; v += 1) {
        if ((v & 255) === 255) {
            ops.work += 256;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        }
        for (const e of out[v]) if (out[v].length === 2 && !used.has(key(v, e.to))) trace(v, e, true);
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
    }
    return chains;
}

/**
 * Find natural straight lattice runs (>= minLen blocks) in a dense lattice chain.
 * @param {Pt[]} pts @param {number} minLen
 * @returns {Run[]}
 */
function naturalRuns(pts, minLen) {
    /** @type {Run[]} */
    const runs = [];
    let s = 0;
    const n = pts.length;
    while (s < n - 1) {
        const axis = pts[s + 1][1] === pts[s][1] ? "x" : "z";
        let e = s + 1;
        while (e + 1 < n && (axis === "x" ? pts[e + 1][1] === pts[s][1] : pts[e + 1][0] === pts[s][0])) e += 1;
        const len = Math.abs(axis === "x" ? pts[e][0] - pts[s][0] : pts[e][1] - pts[s][1]);
        if (len >= minLen) runs.push({ i0: s, i1: e, axis, len });
        s = e;
    }
    return runs;
}

/**
 * Smooth, straighten and simplify one raw chain in place. Endpoints never move. Returns the chain with integer
 * `pts`, `runs` indexing the simplified points, and `length`.
 * @param {Chain} chain @param {import("./regions.js").Ops} ops @param {{ smoothIterations?: number, eps?: number, minRun?: number, maxRuns?: number }} [opts]
 * @returns {Generator<void, Chain, void>}
 */
export function* refineChainSteps(chain, ops, opts = {}) {
    const iterations = opts.smoothIterations ?? 5;
    const eps = opts.eps ?? 1.6;
    const minRun = opts.minRun ?? 12;
    const maxRuns = opts.maxRuns ?? 2;
    let dense = chain.pts;
    const closed = chain.closed;
    let runs = closed ? [] : naturalRuns(dense, minRun).sort((a, b) => b.len - a.len).slice(0, maxRuns);
    const pinned = new Set();
    for (const r of runs) for (let i = r.i0; i <= r.i1; i += 1) pinned.add(i);
    ops.work += dense.length * (iterations + 3);
    if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
    let sm = smoothPath(dense, iterations, closed, pinned);
    /** @type {Set<number>} */
    const keep = new Set();
    for (const r of runs) { keep.add(r.i0); keep.add(r.i1); }
    if (runs.length === 0 && !closed && dense.length >= 10) {
        // force a straight run in the smoothed dense polyline: the flattest window of >= minRun+2 blocks
        let bestDev = Infinity;
        let best = null;
        for (let s = 2; s < sm.length - 4; s += 1) {
            ops.work += 8;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            for (let e = s + 3; e < sm.length - 2; e += 1) {
                const dx = sm[e][0] - sm[s][0];
                const dz = sm[e][1] - sm[s][1];
                const horiz = Math.abs(dx) >= Math.abs(dz);
                const span = horiz ? Math.abs(dx) : Math.abs(dz);
                if (span < minRun + 2) continue;
                let lo = Infinity;
                let hi = -Infinity;
                ops.work += e - s + 1;
                for (let k = s; k <= e; k += 1) {
                    const p = horiz ? sm[k][1] : sm[k][0];
                    if (p < lo) lo = p;
                    if (p > hi) hi = p;
                }
                const dev = hi - lo;
                if (dev < bestDev) { bestDev = dev; best = { s, e, horiz, mean: (lo + hi) / 2 }; }
                break;
            }
        }
        if (best && bestDev <= 2.5) {
            const a = sm[best.s];
            const b = sm[best.e];
            /** @type {Pt} */
            const pa = best.horiz ? [Math.round(a[0]), Math.round(best.mean)] : [Math.round(best.mean), Math.round(a[1])];
            /** @type {Pt} */
            const pb = best.horiz ? [Math.round(b[0]), Math.round(best.mean)] : [Math.round(best.mean), Math.round(b[1])];
            const head = sm.slice(0, best.s);
            const tail = sm.slice(best.e + 1);
            sm = head.concat([pa, pb], tail);
            keep.clear();
            keep.add(head.length);
            keep.add(head.length + 1);
            runs = [{ i0: head.length, i1: head.length + 1, axis: best.horiz ? "x" : "z", len: Math.abs((best.horiz ? pb[0] - pa[0] : pb[1] - pa[1])) }];
        }
    }
    dense = sm;
    ops.work += dense.length * 3;
    if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
    const idxs = simplifyIndices(dense, eps, keep);
    /** @type {Pt[]} */
    const pts = [];
    /** @type {Map<number, number>} */
    const denseToOut = new Map();
    for (const di of idxs) {
        const p = /** @type {Pt} */ ([Math.round(dense[di][0]), Math.round(dense[di][1])]);
        const last = pts[pts.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
        denseToOut.set(di, pts.length - 1);
    }
    /** @type {Run[]} */
    const finalRuns = [];
    for (const r of runs) {
        const a = denseToOut.get(r.i0);
        const b = denseToOut.get(r.i1);
        if (a === undefined || b === undefined || b !== a + 1) continue;
        const len = Math.abs(r.axis === "x" ? pts[b][0] - pts[a][0] : pts[b][1] - pts[a][1]);
        const flat = r.axis === "x" ? pts[b][1] === pts[a][1] : pts[b][0] === pts[a][0];
        if (flat && len >= minRun) finalRuns.push({ i0: a, i1: b, axis: r.axis, len });
    }
    chain.pts = pts;
    chain.runs = finalRuns;
    chain.length = pathLength(pts, false);
    return chain;
}

/**
 * Do any two segments of different (or the same) chains properly cross? Chains meeting at junctions are fine.
 * @param {Chain[]} chains @param {import("./regions.js").Ops} ops
 * @returns {Generator<void, boolean, void>}
 */
export function* chainsCross(chains, ops) {
    /** @type {Array<{ a: Pt, b: Pt, c: number, x0: number, x1: number, z0: number, z1: number }>} */
    const segs = [];
    chains.forEach((c, ci) => {
        for (let i = 0; i + 1 < c.pts.length; i += 1) {
            const a = c.pts[i];
            const b = c.pts[i + 1];
            segs.push({ a, b, c: ci, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), z0: Math.min(a[1], b[1]), z1: Math.max(a[1], b[1]) });
        }
    });
    for (let i = 0; i < segs.length; i += 1) {
        ops.work += segs.length - i;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let j = i + 1; j < segs.length; j += 1) {
            const s = segs[i];
            const t = segs[j];
            if (s.x1 < t.x0 || t.x1 < s.x0 || s.z1 < t.z0 || t.z1 < s.z0) continue;
            if (segmentsCross(s.a, s.b, t.a, t.b)) return true;
        }
    }
    return false;
}

/**
 * Assemble the closed boundary rings of district d from refined chains (d on the left of every traversal).
 * @param {Chain[]} chains @param {number} d
 * @returns {Pt[][]} rings (first point is not repeated at the end)
 */
export function districtRings(chains, d) {
    /** @type {Array<{ ci: number, rev: boolean, pts: Pt[] }>} */
    const oriented = [];
    chains.forEach((c, ci) => {
        if (c.left === d && c.right !== d) oriented.push({ ci, rev: false, pts: c.pts });
        else if (c.right === d && c.left !== d) oriented.push({ ci, rev: true, pts: c.pts.slice().reverse() });
    });
    const usedAt = new Set();
    /** @type {Pt[][]} */
    const rings = [];
    for (let s = 0; s < oriented.length; s += 1) {
        if (usedAt.has(s)) continue;
        /** @type {Pt[]} */
        const ring = [];
        let cur = s;
        const startKey = `${oriented[s].pts[0][0]},${oriented[s].pts[0][1]}`;
        for (let guard = 0; guard < oriented.length + 1; guard += 1) {
            usedAt.add(cur);
            const pts = oriented[cur].pts;
            for (let k = 0; k < pts.length - 1; k += 1) ring.push(pts[k]);
            const end = pts[pts.length - 1];
            const endKey = `${end[0]},${end[1]}`;
            if (endKey === startKey) break;
            const nextIdx = oriented.findIndex((o, oi) => !usedAt.has(oi) && `${o.pts[0][0]},${o.pts[0][1]}` === endKey);
            if (nextIdx < 0) { ring.push(end); break; }
            cur = nextIdx;
        }
        rings.push(ring);
    }
    return rings;
}

/**
 * Re-derive the cell label grid from closed rings: a cell belongs to the district whose ring contains its
 * centre. Keeps labels exactly consistent with the (smoothed) walls.
 * @param {Pt[][]} ringByDistrict index d-1 => ring of district d
 * @param {number} w @param {number} h @param {number} gx0 @param {number} gz0 @param {import("./regions.js").Ops} ops
 * @returns {Generator<void, Uint8Array, void>}
 */
export function* labelsFromRings(ringByDistrict, w, h, gx0, gz0, ops) {
    const labels = new Uint8Array(w * h);
    for (let di = 0; di < ringByDistrict.length; di += 1) {
        const ring = ringByDistrict[di];
        const bb = bboxOf(ring);
        if (!bb) continue;
        const i0 = Math.max(0, Math.floor((bb.x0 - gx0) / CELL) - 1);
        const i1 = Math.min(w - 1, Math.ceil((bb.x1 - gx0) / CELL) + 1);
        const j0 = Math.max(0, Math.floor((bb.z0 - gz0) / CELL) - 1);
        const j1 = Math.min(h - 1, Math.ceil((bb.z1 - gz0) / CELL) + 1);
        for (let j = j0; j <= j1; j += 1) {
            for (let i = i0; i <= i1; i += 1) {
                ops.work += ring.length;
                if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
                if (pointInPolygon(gx0 + i * CELL + 1.37, gz0 + j * CELL + 1.61, ring)) labels[j * w + i] = di + 1;
            }
        }
    }
    return labels;
}

/** Area of a ring (re-exported convenience). @param {Pt[]} ring */
export function ringArea(ring) {
    return polygonArea(ring);
}
