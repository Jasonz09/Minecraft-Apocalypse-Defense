// Synthetic CivPlan builder for validator tests (dev only, never shipped).
//
// Deliberately independent of the planner: it takes a coarse district label grid (4-block cells, 0 = outside)
// and derives walls along cell edges, gates on straight runs, roads along cell centres, routes, outlines and
// stats exactly as docs/CIVILIZATION_PLAN_DESIGN.md describes. If the label grid is sane the result is a
// plan the validator must accept; tests then mutate it to prove the validator rejects broken variants.

const CELL = 4;
const NAMES = ["Hearthgate", "Ironquarry", "Whitethorn", "Saltmere", "Ashfall"];
const ROLES = ["command", "industrial", "agricultural", "commercial", "residential"];

/** @param {number} x @param {number} z @param {number} seed */
function hash(x, z, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** @param {number} x @param {number} z @param {number} scale @param {number} seed */
function noise(x, z, scale, seed) {
    const fx = x / scale;
    const fz = z / scale;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const a = hash(ix, iz, seed);
    const b = hash(ix + 1, iz, seed);
    const c = hash(ix, iz + 1, seed);
    const d = hash(ix + 1, iz + 1, seed);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Encode labels as [[label, run], ...]. @param {Uint8Array} cells */
export function encodeRuns(cells) {
    /** @type {number[][]} */
    const out = [];
    let i = 0;
    while (i < cells.length) {
        let j = i;
        while (j < cells.length && cells[j] === cells[i]) j++;
        out.push([cells[i], j - i]);
        i = j;
    }
    return out;
}

/** Remove diagonal pinches (a b / b a) and stray fragments so walls become simple chains.
 * @param {Uint8Array} cells @param {number} w @param {number} h @param {number} n */
export function cleanLabels(cells, w, h, n) {
    for (let pass = 0; pass < 40; pass++) {
        let changed = 0;
        for (let j = 0; j + 1 < h; j++) {
            for (let i = 0; i + 1 < w; i++) {
                const a = cells[j * w + i];
                const b = cells[j * w + i + 1];
                const c = cells[(j + 1) * w + i];
                const d = cells[(j + 1) * w + i + 1];
                if (a === d && b === c && a !== b) {
                    // keep the non-zero label dominant
                    const keep = a !== 0 ? a : b;
                    cells[j * w + i + 1] = keep;
                    cells[(j + 1) * w + i] = keep;
                    changed++;
                }
            }
        }
        // keep only the largest 4-connected piece of every label (stragglers join the majority neighbour)
        for (let label = 1; label <= n; label++) {
            const comp = new Int32Array(w * h).fill(-1);
            /** @type {number[]} */
            const sizes = [];
            for (let s = 0; s < cells.length; s++) {
                if (cells[s] !== label || comp[s] !== -1) continue;
                const id = sizes.length;
                let size = 0;
                const stack = [s];
                comp[s] = id;
                while (stack.length > 0) {
                    const p = /** @type {number} */ (stack.pop());
                    size++;
                    const x = p % w;
                    const z = (p - x) / w;
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const nx = x + dx;
                        const nz = z + dz;
                        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                        const q = nz * w + nx;
                        if (cells[q] === label && comp[q] === -1) { comp[q] = id; stack.push(q); }
                    }
                }
                sizes.push(size);
            }
            if (sizes.length <= 1) continue;
            const best = sizes.indexOf(Math.max(...sizes));
            for (let s = 0; s < cells.length; s++) {
                if (cells[s] === label && comp[s] !== best) {
                    const x = s % w;
                    const z = (s - x) / w;
                    /** @type {Map<number, number>} */
                    const votes = new Map();
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const nx = x + dx;
                        const nz = z + dz;
                        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                        const v = cells[nz * w + nx];
                        if (v !== label) votes.set(v, (votes.get(v) ?? 0) + 1);
                    }
                    let pick = 0;
                    let top = -1;
                    for (const [v, c] of votes) if (c > top) { top = c; pick = v; }
                    cells[s] = pick;
                    changed++;
                }
            }
        }
        if (changed === 0) break;
    }
}

/**
 * Irregular blob split into n weighted-Voronoi districts with wavy borders.
 * @param {{ n?: number, w?: number, h?: number, targetCells?: number, seed?: number, wobble?: number, spread?: number, symmetric?: boolean }} [o]
 * @returns {{ cells: Uint8Array, w: number, h: number, n: number }}
 */
export function generateLabelGrid(o = {}) {
    const n = o.n ?? 5;
    const w = o.w ?? 150;
    const h = o.h ?? 150;
    const targetCells = o.targetCells ?? 11800;
    const seed = o.seed ?? 1;
    const wobble = o.wobble ?? 0.2;
    const sym = o.symmetric === true;
    const cx = sym ? w / 2 : w / 2 + (hash(1, 2, seed) - 0.5) * 4;
    const cz = sym ? h / 2 : h / 2 + (hash(3, 4, seed) - 0.5) * 4;
    const phase = [0, 1, 2, 3].map((k) => (sym ? 0 : hash(k, 9, seed) * Math.PI * 2));
    const amp = sym ? [0, 0.2, 0, 0.1] : [0.13, 0.15, 0.1, 0.05];
    const mult = [1, 2, 3, 5];
    /** @param {number} theta */
    const shape = (theta) => {
        let v = 1;
        for (let k = 0; k < 4; k++) v += amp[k] * Math.cos(mult[k] * theta + phase[k]);
        return v;
    };
    /** @param {number} radius */
    const maskFor = (radius) => {
        const m = new Uint8Array(w * h);
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const dx = i + 0.5 - cx;
                const dz = j + 0.5 - cz;
                const r = Math.hypot(dx, dz);
                if (r <= radius * shape(Math.atan2(dz, dx))) m[j * w + i] = 1;
            }
        }
        return m;
    };
    let lo = 5;
    let hi = Math.min(w, h) / 2;
    let mask = maskFor(hi);
    for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        mask = maskFor(mid);
        let count = 0;
        for (const v of mask) count += v;
        if (count < targetCells) lo = mid; else hi = mid;
    }
    mask = maskFor((lo + hi) / 2);
    let total = 0;
    for (const v of mask) total += v;
    const radius = (lo + hi) / 2;
    // seeds around the centre
    const seeds = [];
    for (let k = 0; k < n; k++) {
        const ang = ((k + (hash(k, 11, seed) - 0.5) * 0.35) / n) * Math.PI * 2 + phase[0];
        const rad = radius * (o.spread ?? 0.5) * shape(ang) * (0.85 + hash(k, 13, seed) * 0.3);
        seeds.push({ x: cx + Math.cos(ang) * rad, z: cz + Math.sin(ang) * rad });
    }
    const targets = [];
    let tsum = 0;
    for (let k = 0; k < n; k++) { const t = 0.9 + hash(k, 17, seed) * 0.2; targets.push(t); tsum += t; }
    for (let k = 0; k < n; k++) targets[k] = (targets[k] / tsum) * total;
    const weight = new Array(n).fill(0);
    const cells = new Uint8Array(w * h);
    const scale = radius * radius;
    /** @param {number[]} wt @returns {number[]} counts */
    const assign = (wt) => {
        const counts = new Array(n).fill(0);
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                if (mask[j * w + i] === 0) { cells[j * w + i] = 0; continue; }
                let best = 0;
                let bestCost = Infinity;
                for (let k = 0; k < n; k++) {
                    const dx = i + 0.5 - seeds[k].x;
                    const dz = j + 0.5 - seeds[k].z;
                    const m = Math.max(Math.abs(dx), Math.abs(dz), (Math.abs(dx) + Math.abs(dz)) * 0.8);
                    const cost = m * m - wt[k] + wobble * scale * 0.18 * (noise(i, j, 14 + k * 3, seed + 31 * k) - 0.5);
                    if (cost < bestCost) { bestCost = cost; best = k; }
                }
                cells[j * w + i] = best + 1;
                counts[best]++;
            }
        }
        return counts;
    };
    let bestWorst = Infinity;
    let bestWeight = weight.slice();
    for (let it = 0; it < 120; it++) {
        if (process.env.DBG) console.log(it);
        const counts = assign(weight);
        let worst = 0;
        for (let k = 0; k < n; k++) worst = Math.max(worst, Math.abs(targets[k] - counts[k]));
        if (process.env.DBG) console.log(it, worst, counts.join(","));
        if (worst < bestWorst) { bestWorst = worst; bestWeight = weight.slice(); }
        if (worst < 30) break;
        for (let k = 0; k < n; k++) weight[k] += (targets[k] - counts[k]) * 0.2;
    }
    assign(bestWeight);
    cleanLabels(cells, w, h, n);
    return { cells, w, h, n };
}

/** Rectangular partitions for adversarial shapes. @param {"stripes"|"grid5"} kind */
export function rectangleGrid(kind) {
    const w = 130;
    const h = 110;
    const n = 5;
    const cells = new Uint8Array(w * h);
    const m = 5;
    for (let j = 0; j < h - 2 * m; j++) {
        for (let i = 0; i < w - 2 * m; i++) {
            let label;
            if (kind === "stripes") label = Math.floor(j / ((h - 2 * m) / 5)) + 1;
            else if (j < 60) label = Math.floor(i / 40) + 1;
            else label = i < 60 ? 5 : 4;
            cells[(j + m) * w + i + m] = Math.min(5, label);
        }
    }
    return { cells, w, h, n };
}

/** Disc split into equal sectors. @param {number} n */
export function discGrid(n = 5, radius = 62) {
    const w = 150;
    const h = 150;
    const cells = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const dx = i + 0.5 - w / 2;
            const dz = j + 0.5 - h / 2;
            if (Math.hypot(dx, dz) > radius) continue;
            const ang = (Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI);
            cells[j * w + i] = Math.min(n, Math.floor(ang * n) + 1);
        }
    }
    cleanLabels(cells, w, h, n);
    return { cells, w, h, n };
}

// ---------------------------------------------------------------------------------------------------------
// plan construction
// ---------------------------------------------------------------------------------------------------------

/** @param {number[][]} pts keep only direction changes (closed loops keep the repeated end) */
function simplifyCollinear(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
        const a = out[out.length - 1];
        const b = pts[i];
        const c = pts[i + 1];
        if ((b[0] - a[0]) * (c[1] - b[1]) === (b[1] - a[1]) * (c[0] - b[0])) continue;
        out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
}

/**
 * @param {{ cells: Uint8Array, w: number, h: number, n: number }} grid
 * @param {{ x0?: number, z0?: number, seed?: number, name?: string, gatesPerOuter?: number }} [opts]
 */
export function buildPlanFromLabelGrid(grid, opts = {}) {
    const { cells, w, h, n } = grid;
    const x0 = opts.x0 ?? -300;
    const z0 = opts.z0 ?? -300;
    /** @param {number} i @param {number} j */
    const lab = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : cells[j * w + i]);
    /** @param {number} i @param {number} j */
    const vk = (i, j) => j * (w + 1) + i;
    /** @param {number} i @param {number} j */
    const world = (i, j) => [x0 + CELL * i, z0 + CELL * j];

    // ---- boundary edges -------------------------------------------------------------------------------
    /** @type {{ a: number[], b: number[], lo: number, hi: number, inside: number, dir: string }[]} */
    const edges = [];
    for (let j = 0; j <= h; j++) {
        for (let i = 0; i <= w; i++) {
            const here = lab(i, j);
            const up = lab(i, j - 1);
            const left = lab(i - 1, j);
            if (here !== up && i < w) edges.push({ a: [i, j], b: [i + 1, j], lo: Math.min(here, up), hi: Math.max(here, up), inside: here !== 0 ? here : up, dir: "x" });
            if (here !== left && j < h) edges.push({ a: [i, j], b: [i, j + 1], lo: Math.min(here, left), hi: Math.max(here, left), inside: here !== 0 ? here : left, dir: "z" });
        }
    }
    /** @type {Map<number, number[]>} */
    const incident = new Map();
    edges.forEach((e, idx) => {
        for (const v of [e.a, e.b]) {
            const k = vk(v[0], v[1]);
            const list = incident.get(k);
            if (list) list.push(idx); else incident.set(k, [idx]);
        }
    });
    /** @param {number} idx @param {number[]} v @returns {number[]} */
    const other = (idx, v) => (edges[idx].a[0] === v[0] && edges[idx].a[1] === v[1] ? edges[idx].b : edges[idx].a);
    const isJunction = (/** @type {number[]} */ v) => {
        const list = incident.get(vk(v[0], v[1])) ?? [];
        const shared = list.filter((q) => edges[q].lo > 0);
        const outer = list.filter((q) => edges[q].lo === 0);
        if (outer.length > 0) return true;
        if (shared.length !== 2) return true;
        return edges[shared[0]].lo !== edges[shared[1]].lo || edges[shared[0]].hi !== edges[shared[1]].hi;
    };

    // ---- outer loop ------------------------------------------------------------------------------------
    const outerEdges = edges.map((e, idx) => (e.lo === 0 ? idx : -1)).filter((q) => q >= 0);
    if (outerEdges.length === 0) throw new Error("no outer boundary");
    const used = new Set();
    /** @type {number[]} edge order around the loop */
    const loop = [outerEdges[0]];
    used.add(outerEdges[0]);
    let cur = edges[outerEdges[0]].b;
    for (;;) {
        const list = (incident.get(vk(cur[0], cur[1])) ?? []).filter((q) => edges[q].lo === 0 && !used.has(q));
        if (list.length === 0) break;
        if (list.length > 1) throw new Error(`outer boundary pinch at ${String(cur)}`);
        const q = list[0];
        used.add(q);
        loop.push(q);
        cur = other(q, cur);
    }
    if (used.size !== outerEdges.length) throw new Error("outer boundary has more than one loop (hole or island)");
    // orient edges along the loop
    /** @type {{ from: number[], to: number[], inside: number, dir: string }[]} */
    const oriented = [];
    let at = edges[loop[0]].a;
    for (const q of loop) {
        const to = other(q, at);
        oriented.push({ from: at, to, inside: edges[q].inside, dir: edges[q].dir });
        at = to;
    }
    // runs: consecutive collinear edges with the same inside label
    /** @type {{ from: number[], to: number[], inside: number, dir: string, len: number }[]} */
    const runs = [];
    for (const e of oriented) {
        const last = runs[runs.length - 1];
        const sameDir = last && last.dir === e.dir && last.inside === e.inside && ((last.to[0] - last.from[0]) * (e.to[0] - e.from[0]) + (last.to[1] - last.from[1]) * (e.to[1] - e.from[1]) > 0);
        if (sameDir) { last.to = e.to; last.len += 1; } else runs.push({ from: e.from, to: e.to, inside: e.inside, dir: e.dir, len: 1 });
    }
    // merge wrap-around
    {
        const a = runs[0];
        const b = runs[runs.length - 1];
        if (runs.length > 1 && a.dir === b.dir && a.inside === b.inside && ((b.to[0] - b.from[0]) * (a.to[0] - a.from[0]) + (b.to[1] - b.from[1]) * (a.to[1] - a.from[1]) > 0)) {
            b.to = a.to;
            b.len += a.len;
            runs.shift();
        }
    }
    const outerPath = runs.map((r) => world(r.from[0], r.from[1]));
    outerPath.push(outerPath[0]);

    // ---- shared chains -----------------------------------------------------------------------------------
    /** @type {{ id: string, lo: number, hi: number, path: number[][], runs: { from: number[], to: number[], len: number }[] }[]} */
    const chains = [];
    const sharedUsed = new Set();
    let chainSerial = 0;
    for (let q = 0; q < edges.length; q++) {
        if (edges[q].lo === 0 || sharedUsed.has(q)) continue;
        // walk backwards to the chain start (a junction)
        let start = edges[q].a;
        let firstEdge = q;
        let guard = 0;
        while (!isJunction(start) && guard++ < 100000) {
            const prevEdge = firstEdge;
            const next = (incident.get(vk(start[0], start[1])) ?? []).find((e) => e !== prevEdge && edges[e].lo > 0);
            if (next === undefined || next === q) break;
            firstEdge = next;
            start = other(next, start);
        }
        const pts = [start];
        let curV = start;
        let e = firstEdge;
        if (sharedUsed.has(e)) continue;
        /** @type {{ from: number[], to: number[], len: number }[]} */
        const cruns = [];
        for (;;) {
            sharedUsed.add(e);
            const nxt = other(e, curV);
            const last = cruns[cruns.length - 1];
            const dx = nxt[0] - curV[0];
            const dz = nxt[1] - curV[1];
            if (last && (last.to[0] - last.from[0]) * dz === (last.to[1] - last.from[1]) * dx && (last.to[0] - last.from[0]) * dx + (last.to[1] - last.from[1]) * dz > 0) { last.to = nxt; last.len++; } else cruns.push({ from: curV, to: nxt, len: 1 });
            pts.push(nxt);
            curV = nxt;
            if (isJunction(curV)) break;
            const nextE = (incident.get(vk(curV[0], curV[1])) ?? []).find((c) => c !== e && edges[c].lo > 0);
            if (nextE === undefined) break;
            e = nextE;
        }
        chainSerial++;
        chains.push({ id: `wall-s-${String(edges[q].lo)}-${String(edges[q].hi)}-${String(chainSerial)}`, lo: edges[q].lo, hi: edges[q].hi, path: simplifyCollinear(pts.map((p) => world(p[0], p[1]))), runs: cruns });
    }

    // ---- walls ------------------------------------------------------------------------------------------
    /** @type {any[]} */
    const walls = [{ id: "wall-outer", kind: "outer", between: [0, 0], closed: true, path: outerPath, thickness: 3 }];
    for (const c of chains) walls.push({ id: c.id, kind: "shared", between: [c.lo, c.hi], closed: false, path: c.path, thickness: 3 });

    // ---- gates --------------------------------------------------------------------------------------------
    /** @type {any[]} */
    const gates = [];
    /** @param {number} px @param {number} pz */
    const labelAtBlock = (px, pz) => lab(Math.floor((px - x0) / CELL), Math.floor((pz - z0) / CELL));
    /** candidate gate on a run, returns null if the side labels are not as expected
     * @param {number[]} from @param {number[]} to @param {number} len @param {number} want1 @param {number} want2 */
    const gateOnRun = (from, to, len, want1, want2) => {
        if (len < 3) return null;
        const horizontal = from[1] === to[1];
        const k = Math.floor(len / 2);
        const [wx0, wz0] = world(from[0], from[1]);
        const step = horizontal ? Math.sign(to[0] - from[0]) : Math.sign(to[1] - from[1]);
        const gx = horizontal ? wx0 + step * (CELL * k + 2) : wx0;
        const gz = horizontal ? wz0 : wz0 + step * (CELL * k + 2);
        const sideA = horizontal ? labelAtBlock(gx, gz - 6) : labelAtBlock(gx - 6, gz);
        const sideB = horizontal ? labelAtBlock(gx, gz + 6) : labelAtBlock(gx + 6, gz);
        const ok = (sideA === want1 && sideB === want2) || (sideA === want2 && sideB === want1);
        if (!ok) return null;
        return { x: gx, z: gz, axis: horizontal ? "x" : "z", sideA, sideB };
    };
    let gateSerial = 0;
    /** @type {Map<string, string[]>} */
    const gatesByPair = new Map();
    for (const c of chains) {
        const pairKey = `${String(c.lo)}-${String(c.hi)}`;
        if ((gatesByPair.get(pairKey) ?? []).length > 0) continue;
        const candidates = [...c.runs].sort((p, q) => q.len - p.len);
        for (const r of candidates) {
            const g = gateOnRun(r.from, r.to, r.len, c.lo, c.hi);
            if (!g) continue;
            const id = `gate-${String(++gateSerial)}`;
            gates.push({ id, wallId: c.id, at: { x: g.x, z: g.z }, axis: g.axis, width: 5, between: [c.lo, c.hi], purpose: "main" });
            gatesByPair.set(pairKey, [id]);
            break;
        }
    }
    /** @type {Map<number, string[]>} */
    const outerByDistrict = new Map();
    const wantOuter = opts.gatesPerOuter ?? 2;
    const sortedRuns = [...runs].sort((a, b) => b.len - a.len);
    for (const r of sortedRuns) {
        const have = outerByDistrict.get(r.inside) ?? [];
        if (have.length >= wantOuter) continue;
        const g = gateOnRun(r.from, r.to, r.len, r.inside, 0);
        if (!g) continue;
        // keep outer gates of one district apart
        const tooClose = gates.some((q) => Math.max(Math.abs(q.at.x - g.x), Math.abs(q.at.z - g.z)) < 40);
        if (tooClose) continue;
        const id = `gate-${String(++gateSerial)}`;
        gates.push({ id, wallId: "wall-outer", at: { x: g.x, z: g.z }, axis: g.axis, width: 5, between: [r.inside, 0], purpose: have.length === 0 ? "main" : "evac" });
        have.push(id);
        outerByDistrict.set(r.inside, have);
    }

    // ---- per-district data ----------------------------------------------------------------------------------
    const counts = new Array(n + 1).fill(0);
    const sI = new Array(n + 1).fill(0);
    const sJ = new Array(n + 1).fill(0);
    const bb = Array.from({ length: n + 1 }, () => ({ i0: Infinity, j0: Infinity, i1: -1, j1: -1 }));
    let allI = 0;
    let allJ = 0;
    let allN = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const l = cells[j * w + i];
        if (l === 0) continue;
        counts[l]++; sI[l] += i; sJ[l] += j; allI += i; allJ += j; allN++;
        const b = bb[l];
        b.i0 = Math.min(b.i0, i); b.j0 = Math.min(b.j0, j); b.i1 = Math.max(b.i1, i); b.j1 = Math.max(b.j1, j);
    }
    const civCx = allI / allN;
    const civCz = allJ / allN;
    // depth (4-neighbour distance to a foreign cell)
    const depth = new Int32Array(w * h).fill(-1);
    {
        /** @type {number[]} */
        let frontier = [];
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            const l = cells[j * w + i];
            if (l === 0) continue;
            if (lab(i + 1, j) !== l || lab(i - 1, j) !== l || lab(i, j + 1) !== l || lab(i, j - 1) !== l) { depth[j * w + i] = 0; frontier.push(j * w + i); }
        }
        while (frontier.length > 0) {
            /** @type {number[]} */
            const next = [];
            for (const p of frontier) {
                const x = p % w;
                const z = (p - x) / w;
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = x + dx;
                    const nz = z + dz;
                    if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                    const q = nz * w + nx;
                    if (cells[q] === cells[p] && depth[q] === -1) { depth[q] = depth[p] + 1; next.push(q); }
                }
            }
            frontier = next;
        }
    }
    /** @type {{ i: number, j: number }[]} */
    const hqCell = [];
    for (let d = 1; d <= n; d++) {
        let best = -1;
        let bestScore = -1;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            if (cells[j * w + i] !== d) continue;
            const dep = depth[j * w + i];
            let score = dep;
            if (d === 1) {
                const away = Math.hypot(i - civCx, j - civCz);
                if (away < 14) continue; // >= 56 blocks from the civilization centroid
                score = dep * 1000 + away;
            }
            if (score > bestScore) { bestScore = score; best = j * w + i; }
        }
        if (best < 0) throw new Error(`no HQ cell for district ${String(d)}`);
        hqCell[d] = { i: best % w, j: Math.floor(best / w) };
    }

    // outlines: boundary of the district's cells
    /** @param {number} d */
    const outlineOf = (d) => {
        /** @type {Map<number, number[][]>} */
        const outgoing = new Map();
        /** @param {number[]} a @param {number[]} b */
        const addEdge = (a, b) => {
            const k = vk(a[0], a[1]);
            const list = outgoing.get(k);
            if (list) list.push([a[0], a[1], b[0], b[1]]); else outgoing.set(k, [[a[0], a[1], b[0], b[1]]]);
        };
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            if (cells[j * w + i] !== d) continue;
            if (lab(i, j - 1) !== d) addEdge([i, j], [i + 1, j]);
            if (lab(i + 1, j) !== d) addEdge([i + 1, j], [i + 1, j + 1]);
            if (lab(i, j + 1) !== d) addEdge([i + 1, j + 1], [i, j + 1]);
            if (lab(i - 1, j) !== d) addEdge([i, j + 1], [i, j]);
        }
        const firstKey = outgoing.keys().next().value;
        if (firstKey === undefined) throw new Error("empty district");
        const startEdge = /** @type {number[][]} */ (outgoing.get(firstKey))[0];
        let total = 0;
        for (const list of outgoing.values()) total += list.length;
        /** @type {number[][]} */
        const pts = [];
        let edge = startEdge;
        let count = 0;
        do {
            pts.push([edge[0], edge[1]]);
            const list = /** @type {number[][]} */ (outgoing.get(vk(edge[2], edge[3])));
            const dx = edge[2] - edge[0];
            const dz = edge[3] - edge[1];
            let pick = list[0];
            let bestTurn = -2;
            for (const cand of list) {
                const cross = dx * (cand[3] - cand[1]) - dz * (cand[2] - cand[0]);
                if (cross > bestTurn) { bestTurn = cross; pick = cand; }
            }
            edge = pick;
            count++;
        } while (edge !== startEdge && count <= total);
        if (count !== total) throw new Error(`district ${String(d)} boundary has more than one loop`);
        const world2 = pts.map((p) => world(p[0], p[1]));
        const simple = simplifyCollinear([...world2, world2[0]]);
        simple.pop();
        return simple;
    };

    // ---- roads (along cell centres: always 2 blocks away from the wall stamp) ------------------------------
    /** @type {any[]} */
    const roads = [];
    let roadSerial = 0;
    /** @param {number} d @param {{ i: number, j: number }} from @param {{ i: number, j: number }} to */
    const cellPath = (d, from, to) => {
        const prev = new Int32Array(w * h).fill(-2);
        const start = from.j * w + from.i;
        const goal = to.j * w + to.i;
        prev[start] = -1;
        const queue = [start];
        for (let head = 0; head < queue.length; head++) {
            const p = queue[head];
            if (p === goal) break;
            const x = p % w;
            const z = (p - x) / w;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx;
                const nz = z + dz;
                if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                const q = nz * w + nx;
                if (cells[q] !== d || prev[q] !== -2) continue;
                prev[q] = p;
                queue.push(q);
            }
        }
        if (prev[goal] === -2) return null;
        /** @type {number[][]} */
        const out = [];
        for (let p = goal; p !== -1; p = prev[p]) out.push(world(p % w, Math.floor(p / w)).map((v) => v + 2));
        return out.reverse();
    };
    for (let d = 1; d <= n; d++) {
        const hq = hqCell[d];
        for (const g of gates) {
            if (!g.between.includes(d)) continue;
            // the district cell next to the gate on d's side
            const gi = Math.floor((g.at.x - x0) / CELL);
            const gj = Math.floor((g.at.z - z0) / CELL);
            let target = null;
            for (const [dx, dz] of g.axis === "x" ? [[0, -1], [0, 0], [0, 1]] : [[-1, 0], [0, 0], [1, 0]]) {
                if (lab(gi + dx, gj + dz) === d) { target = { i: gi + dx, j: gj + dz }; break; }
            }
            if (!target) throw new Error(`gate ${String(g.id)} has no ${String(d)} cell beside it`);
            const route = cellPath(d, hq, target);
            if (!route) throw new Error(`no road path from HQ ${String(d)} to ${String(g.id)}`);
            // end with a straight stretch through the gate opening
            route.push([g.at.x, g.at.z]);
            if (route.length < 2) route.unshift([route[0][0] - 1, route[0][1]]);
            roads.push({ id: `road-${String(++roadSerial)}`, kind: "arterial", district: d, width: 3, path: simplifyCollinear(route) });
        }
    }

    // ---- districts block ------------------------------------------------------------------------------------
    const districts = [];
    for (let d = 1; d <= n; d++) {
        const b = bb[d];
        districts.push({
            index: d,
            id: `district-${String(d)}`,
            name: n === 5 ? NAMES[d - 1] : `District ${String(d)}`,
            role: n === 5 ? ROLES[d - 1] : "residential",
            area: counts[d] * CELL * CELL,
            cells: counts[d],
            centroid: { x: Math.round(x0 + (sI[d] / counts[d]) * CELL + CELL / 2), z: Math.round(z0 + (sJ[d] / counts[d]) * CELL + CELL / 2) },
            hq: { x: x0 + hqCell[d].i * CELL + 2, z: z0 + hqCell[d].j * CELL + 2 },
            bbox: { x0: x0 + b.i0 * CELL, z0: z0 + b.j0 * CELL, x1: x0 + (b.i1 + 1) * CELL - 1, z1: z0 + (b.j1 + 1) * CELL - 1 },
            outline: outlineOf(d),
        });
    }

    // ---- routes -----------------------------------------------------------------------------------------------
    /** @type {{ evac: any[], reinforce: any[] }} */
    const routes = { evac: [], reinforce: [] };
    /** @param {number} a @param {number} b */
    const gateFor = (a, b) => gatesByPair.get(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)?.[0];
    if (n >= 3) {
        for (let d = 1; d <= n; d++) {
            const e = (d % n) + 1;
            const gid = gateFor(d, e);
            if (gid) {
                routes.reinforce.push({ from: d, to: e, gates: [gid] });
                routes.reinforce.push({ from: e, to: d, gates: [gid] });
                routes.evac.push({ from: d, to: e, gates: [gid] });
            }
        }
    }

    // ---- stats ----------------------------------------------------------------------------------------------
    const perDistrictArea = districts.map((q) => q.area);
    let roadLength = 0;
    for (const r of roads) for (let i = 0; i + 1 < r.path.length; i++) roadLength += Math.abs(r.path[i + 1][0] - r.path[i][0]) + Math.abs(r.path[i + 1][1] - r.path[i][1]);
    let wallLength = 0;
    for (const wl of walls) for (let i = 0; i + 1 < wl.path.length; i++) wallLength += Math.hypot(wl.path[i + 1][0] - wl.path[i][0], wl.path[i + 1][1] - wl.path[i][1]);
    return {
        version: 1,
        seed: opts.seed ?? 1,
        anchor: { x: x0 + Math.floor((w * CELL) / 2), z: z0 + Math.floor((h * CELL) / 2) },
        cell: CELL,
        grid: { x0, z0, w, h },
        labels: encodeRuns(cells),
        districts,
        walls,
        gates,
        roads,
        routes,
        stats: {
            totalArea: perDistrictArea.reduce((a, b) => a + b, 0),
            perDistrictArea,
            compactness: districts.map(() => 0),
            bboxFill: districts.map((q, k) => {
                const b = bb[k + 1];
                return q.area / ((b.i1 - b.i0 + 1) * (b.j1 - b.j0 + 1) * CELL * CELL);
            }),
            wallLength: Math.round(wallLength),
            gateCount: gates.length,
            roadLength,
        },
    };
}

/** Full-size valid plan (5 districts, about 190k columns). @param {number} [seed] */
export function validFullPlan(seed = 1) {
    for (let s = seed; s < seed + 40; s++) {
        try {
            const grid = generateLabelGrid({ seed: s });
            return buildPlanFromLabelGrid(grid, { seed: s });
        } catch {
            // try the next seed
        }
    }
    throw new Error("could not build a full-size fixture plan");
}

/** Options that let the validator accept the small three-district fixtures. */
export const TINY_OPTIONS = { districtCount: 3, areaMin: 1500, areaMax: 20000, totalMin: 9000, totalMax: 40000, hqMinOffset: 8 };

/** Small valid plan (3 districts on a 60x60 cell grid). @param {number} [seed] */
export function validTinyPlan(seed = 3) {
    for (let s = seed; s < seed + 60; s++) {
        try {
            const grid = generateLabelGrid({ n: 3, w: 60, h: 60, targetCells: 1500, seed: s, spread: 0.45 });
            return buildPlanFromLabelGrid(grid, { x0: 40, z0: -80, seed: s });
        } catch {
            // next seed
        }
    }
    throw new Error("could not build a tiny fixture plan");
}
