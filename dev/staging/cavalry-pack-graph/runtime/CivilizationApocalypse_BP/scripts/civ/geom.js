/**
 * Shared pure geometry helpers for the civilization planner and everything that reads a CivPlan.
 * No @minecraft/server import. All coordinates are world block coordinates unless stated.
 * Owner: planner agent (A). Contract: docs/CIVILIZATION_PLAN_DESIGN.md.
 */

/** @typedef {[number, number]} Pt  [x, z] */
/** @typedef {{ x0: number, z0: number, x1: number, z1: number }} BBox  inclusive */
/** @typedef {{ grid: { x0: number, z0: number, w: number, h: number }, labels: number[][], cell?: number }} LabelPlan */

/**
 * Deterministic integer hash to [0,1).
 * @param {number} x @param {number} z @param {number} seed
 */
export function hash2(x, z, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth value noise in [0,1) with wavelength `scale` (same units as x/z).
 * @param {number} x @param {number} z @param {number} scale @param {number} seed
 */
export function valueNoise2(x, z, scale, seed) {
    const fx = x / scale;
    const fz = z / scale;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const a = hash2(ix, iz, seed);
    const b = hash2(ix + 1, iz, seed);
    const c = hash2(ix, iz + 1, seed);
    const d = hash2(ix + 1, iz + 1, seed);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * Bresenham rasterisation of a polyline. Result is 8-connected, consecutive duplicates removed.
 * Input points are rounded to integers. With `closed` the last point connects back to the first.
 * @param {ReadonlyArray<readonly [number, number]>} path
 * @param {boolean} [closed]
 * @returns {Pt[]}
 */
export function rasterizePath(path, closed = false) {
    /** @type {Pt[]} */
    const out = [];
    if (path.length === 0) return out;
    const n = path.length;
    /** @param {number} x @param {number} z */
    const push = (x, z) => {
        const last = out[out.length - 1];
        if (!last || last[0] !== x || last[1] !== z) out.push([x, z]);
    };
    const first = path[0];
    push(Math.round(first[0]), Math.round(first[1]));
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i += 1) {
        const a = path[i];
        const b = path[(i + 1) % n];
        let x = Math.round(a[0]);
        let z = Math.round(a[1]);
        const x1 = Math.round(b[0]);
        const z1 = Math.round(b[1]);
        const dx = Math.abs(x1 - x);
        const dz = Math.abs(z1 - z);
        const sx = x < x1 ? 1 : -1;
        const sz = z < z1 ? 1 : -1;
        let err = dx - dz;
        while (x !== x1 || z !== z1) {
            const e2 = 2 * err;
            if (e2 > -dz) { err -= dz; x += sx; }
            if (e2 < dx) { err += dx; z += sz; }
            push(x, z);
        }
    }
    return out;
}

/**
 * Dilate cells by a square structuring element of the given thickness (3 => 3x3). A dilated 8-connected
 * line is a 4-connected barrier. Returns unique cells (deterministic order of first discovery).
 * @param {ReadonlyArray<readonly [number, number]>} cells
 * @param {number} [thickness]
 * @returns {Pt[]}
 */
export function stamp(cells, thickness = 3) {
    const t = Math.max(1, Math.floor(thickness));
    const lo = -Math.floor((t - 1) / 2);
    const hi = Math.floor(t / 2);
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {Pt[]} */
    const out = [];
    for (const [cx, cz] of cells) {
        for (let dz = lo; dz <= hi; dz += 1) {
            for (let dx = lo; dx <= hi; dx += 1) {
                const x = cx + dx;
                const z = cz + dz;
                const key = `${x},${z}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push([x, z]);
            }
        }
    }
    return out;
}

const decodedCache = new WeakMap();

/**
 * Decode the run-length labels into a w*h Uint8Array (row-major, j outer). Cached per plan object.
 * @param {LabelPlan} plan
 * @returns {Uint8Array}
 */
export function decodeLabels(plan) {
    const cached = decodedCache.get(plan);
    if (cached) return cached;
    const { w, h } = plan.grid;
    const out = new Uint8Array(w * h);
    let at = 0;
    for (const [label, run] of plan.labels) {
        out.fill(label, at, Math.min(w * h, at + run));
        at += run;
    }
    decodedCache.set(plan, out);
    return out;
}

/**
 * Run-length encode a label grid.
 * @param {Uint8Array} labels
 * @returns {number[][]}
 */
export function encodeLabels(labels) {
    /** @type {number[][]} */
    const runs = [];
    for (let i = 0; i < labels.length; i += 1) {
        const last = runs[runs.length - 1];
        if (last && last[0] === labels[i]) last[1] += 1;
        else runs.push([labels[i], 1]);
    }
    return runs;
}

/**
 * District index (1..5) at world block (x, z); 0 = outside the grid or outside the civilization.
 * @param {LabelPlan} plan @param {number} x @param {number} z
 */
export function labelAt(plan, x, z) {
    const cell = plan.cell ?? 4;
    const i = Math.floor((x - plan.grid.x0) / cell);
    const j = Math.floor((z - plan.grid.z0) / cell);
    if (i < 0 || j < 0 || i >= plan.grid.w || j >= plan.grid.h) return 0;
    return decodeLabels(plan)[j * plan.grid.w + i];
}

/**
 * Signed shoelace area (positive when counter-clockwise in a y-up frame).
 * @param {ReadonlyArray<readonly [number, number]>} poly
 */
export function signedArea(poly) {
    let s = 0;
    for (let i = 0, n = poly.length; i < n; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
}

/**
 * Absolute polygon area (implicitly closed).
 * @param {ReadonlyArray<readonly [number, number]>} poly
 */
export function polygonArea(poly) {
    return Math.abs(signedArea(poly));
}

/**
 * Even-odd point in polygon test (implicitly closed polygon).
 * @param {number} x @param {number} z @param {ReadonlyArray<readonly [number, number]>} poly
 */
export function pointInPolygon(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
        const xi = poly[i][0];
        const zi = poly[i][1];
        const xj = poly[j][0];
        const zj = poly[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/**
 * Inclusive bounding box of points; null for an empty list.
 * @param {ReadonlyArray<readonly [number, number]>} points
 * @returns {BBox | null}
 */
export function bboxOf(points) {
    if (points.length === 0) return null;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of points) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
    }
    return { x0, z0, x1, z1 };
}

/**
 * Path length (closed adds the closing edge).
 * @param {ReadonlyArray<readonly [number, number]>} path @param {boolean} [closed]
 */
export function pathLength(path, closed = false) {
    let s = 0;
    const n = path.length;
    for (let i = 0; i + 1 < n; i += 1) s += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    if (closed && n > 2) s += Math.hypot(path[0][0] - path[n - 1][0], path[0][1] - path[n - 1][1]);
    return s;
}

/**
 * Isoperimetric compactness 4*pi*A/P^2 (1 = circle, 0.785 = square).
 * @param {number} area @param {number} perimeter
 */
export function compactness(area, perimeter) {
    return perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
}

/**
 * Distance from a point to a segment.
 * @param {number} px @param {number} pz @param {number} ax @param {number} az @param {number} bx @param {number} bz
 */
export function distToSegment(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Douglas-Peucker simplification. Indices in `keep` (and both endpoints) always survive.
 * @param {ReadonlyArray<Pt>} path @param {number} eps @param {ReadonlySet<number>} [keep]
 * @returns {Pt[]}
 */
export function simplifyPath(path, eps, keep) {
    return simplifyIndices(path, eps, keep).map((i) => /** @type {Pt} */ ([path[i][0], path[i][1]]));
}

/**
 * Douglas-Peucker returning the surviving indices (ascending).
 * @param {ReadonlyArray<Pt>} path @param {number} eps @param {ReadonlySet<number>} [keep]
 * @returns {number[]}
 */
export function simplifyIndices(path, eps, keep) {
    const n = path.length;
    if (n <= 2) return path.map((_, i) => i);
    const marked = new Uint8Array(n);
    marked[0] = 1;
    marked[n - 1] = 1;
    if (keep) for (const k of keep) if (k >= 0 && k < n) marked[k] = 1;
    /** @type {Array<[number, number]>} */
    const stack = [];
    let prev = 0;
    for (let i = 1; i < n; i += 1) {
        if (marked[i]) { stack.push([prev, i]); prev = i; }
    }
    while (stack.length > 0) {
        const [a, b] = /** @type {[number, number]} */ (stack.pop());
        let worst = -1;
        let best = eps;
        for (let i = a + 1; i < b; i += 1) {
            const d = distToSegment(path[i][0], path[i][1], path[a][0], path[a][1], path[b][0], path[b][1]);
            if (d > best) { best = d; worst = i; }
        }
        if (worst >= 0) {
            marked[worst] = 1;
            stack.push([a, worst], [worst, b]);
        }
    }
    /** @type {number[]} */
    const out = [];
    for (let i = 0; i < n; i += 1) if (marked[i]) out.push(i);
    return out;
}

/**
 * Binomial (1-2-1) smoothing. Endpoints stay fixed for open paths; `pinned` indices never move.
 * @param {ReadonlyArray<Pt>} path @param {number} iterations @param {boolean} [closed] @param {ReadonlySet<number>} [pinned]
 * @returns {Pt[]}
 */
export function smoothPath(path, iterations, closed = false, pinned) {
    const n = path.length;
    /** @type {Pt[]} */
    let cur = path.map((p) => [p[0], p[1]]);
    if (n < 3) return cur;
    for (let it = 0; it < iterations; it += 1) {
        /** @type {Pt[]} */
        const next = cur.map((p) => [p[0], p[1]]);
        for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i += 1) {
            if (pinned && pinned.has(i)) continue;
            const a = cur[(i - 1 + n) % n];
            const b = cur[i];
            const c = cur[(i + 1) % n];
            next[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4];
        }
        cur = next;
    }
    return cur;
}

/**
 * Proper crossing of segments ab and cd (shared endpoints and collinear touching do not count).
 * @param {readonly [number, number]} a @param {readonly [number, number]} b
 * @param {readonly [number, number]} c @param {readonly [number, number]} d
 */
export function segmentsCross(a, b, c, d) {
    /** @param {readonly [number, number]} p @param {readonly [number, number]} q @param {readonly [number, number]} r */
    const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * True when a closed polygon has any pair of properly crossing non-adjacent edges.
 * @param {ReadonlyArray<readonly [number, number]>} poly
 */
export function polygonSelfIntersects(poly) {
    const n = poly.length;
    for (let i = 0; i < n; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        for (let j = i + 2; j < n; j += 1) {
            if (i === 0 && j === n - 1) continue;
            if (segmentsCross(a, b, poly[j], poly[(j + 1) % n])) return true;
        }
    }
    return false;
}

/**
 * Convex hull (Andrew monotone chain), counter-clockwise in x-right/z-up frame.
 * @param {ReadonlyArray<readonly [number, number]>} points
 * @returns {Pt[]}
 */
export function convexHull(points) {
    const pts = points.map((p) => /** @type {Pt} */ ([p[0], p[1]])).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    if (pts.length < 3) return pts;
    /** @param {Pt} o @param {Pt} a @param {Pt} b */
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    /** @type {Pt[]} */
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    /** @type {Pt[]} */
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

/**
 * Resample a closed polygon at n equally spaced arclength points.
 * @param {ReadonlyArray<readonly [number, number]>} poly @param {number} n
 * @returns {Pt[]}
 */
export function resampleClosed(poly, n) {
    const m = poly.length;
    const total = pathLength(poly, true);
    /** @type {Pt[]} */
    const out = [];
    if (m < 2 || total === 0) return out;
    const step = total / n;
    let edge = 0;
    let edgeStart = 0;
    let edgeLen = Math.hypot(poly[1 % m][0] - poly[0][0], poly[1 % m][1] - poly[0][1]);
    for (let k = 0; k < n; k += 1) {
        const target = k * step;
        while (edgeStart + edgeLen < target && edge < m - 1) {
            edgeStart += edgeLen;
            edge += 1;
            edgeLen = Math.hypot(poly[(edge + 1) % m][0] - poly[edge][0], poly[(edge + 1) % m][1] - poly[edge][1]);
        }
        const t = edgeLen === 0 ? 0 : (target - edgeStart) / edgeLen;
        const a = poly[edge];
        const b = poly[(edge + 1) % m];
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
}

/**
 * Area centroid of a closed polygon (falls back to vertex mean for degenerate input).
 * @param {ReadonlyArray<readonly [number, number]>} poly
 * @returns {{ x: number, z: number }}
 */
export function polygonCentroid(poly) {
    let a = 0;
    let cx = 0;
    let cz = 0;
    for (let i = 0, n = poly.length; i < n; i += 1) {
        const p = poly[i];
        const q = poly[(i + 1) % n];
        const f = p[0] * q[1] - q[0] * p[1];
        a += f;
        cx += (p[0] + q[0]) * f;
        cz += (p[1] + q[1]) * f;
    }
    if (Math.abs(a) < 1e-9) {
        const n = Math.max(1, poly.length);
        return { x: poly.reduce((s, p) => s + p[0], 0) / n, z: poly.reduce((s, p) => s + p[1], 0) / n };
    }
    return { x: cx / (3 * a), z: cz / (3 * a) };
}

/**
 * Minimum over rotations (10 degree steps) of polygon area / oriented bounding box area. 1 = rectangle.
 * @param {ReadonlyArray<readonly [number, number]>} poly
 */
export function orientedBboxFill(poly) {
    const area = polygonArea(poly);
    let best = Infinity;
    for (let deg = 0; deg < 90; deg += 5) {
        const c = Math.cos((deg * Math.PI) / 180);
        const s = Math.sin((deg * Math.PI) / 180);
        let x0 = Infinity;
        let x1 = -Infinity;
        let z0 = Infinity;
        let z1 = -Infinity;
        for (const [x, z] of poly) {
            const u = x * c + z * s;
            const v = -x * s + z * c;
            if (u < x0) x0 = u;
            if (u > x1) x1 = u;
            if (v < z0) z0 = v;
            if (v > z1) z1 = v;
        }
        best = Math.min(best, (x1 - x0) * (z1 - z0));
    }
    return best > 0 ? area / best : 0;
}

/**
 * Rotation/reflection/scale-invariant shape descriptor of a closed polygon.
 * `harmonics` are the magnitudes of DFT harmonics 1..8 of the radial signature (normalised by mean radius),
 * so rotating, mirroring, or starting the outline elsewhere leaves them unchanged.
 * @param {ReadonlyArray<readonly [number, number]>} poly
 * @returns {{ harmonics: number[], compactness: number, solidity: number, elongation: number, bboxFill: number, orientedFill: number }}
 */
export function shapeDescriptor(poly) {
    const area = polygonArea(poly);
    const perim = pathLength(poly, true);
    const hull = convexHull(poly);
    const solidity = hull.length >= 3 ? area / Math.max(1e-9, polygonArea(hull)) : 1;
    const c = polygonCentroid(poly);
    const samples = resampleClosed(poly, 96);
    const radii = samples.map((p) => Math.hypot(p[0] - c.x, p[1] - c.z));
    const mean = radii.reduce((s, r) => s + r, 0) / Math.max(1, radii.length) || 1;
    const harmonics = [];
    for (let k = 1; k <= 8; k += 1) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < radii.length; i += 1) {
            const ang = (2 * Math.PI * k * i) / radii.length;
            re += (radii[i] / mean) * Math.cos(ang);
            im += (radii[i] / mean) * Math.sin(ang);
        }
        harmonics.push(Math.hypot(re, im) / radii.length);
    }
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (const p of samples) {
        const dx = p[0] - c.x;
        const dz = p[1] - c.z;
        sxx += dx * dx;
        szz += dz * dz;
        sxz += dx * dz;
    }
    const tr = sxx + szz;
    const det = sxx * szz - sxz * sxz;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = Math.max(1e-9, tr / 2 - disc);
    const box = bboxOf(poly);
    const boxArea = box ? Math.max(1, (box.x1 - box.x0) * (box.z1 - box.z0)) : 1;
    return {
        harmonics,
        compactness: compactness(area, perim),
        solidity,
        elongation: Math.sqrt(l1 / l2),
        bboxFill: area / boxArea,
        orientedFill: orientedBboxFill(poly),
    };
}

/**
 * Distance between two shape descriptors; 0 means congruent up to rotation/reflection/scale.
 * Typical: unrelated irregular shapes > 0.2, near duplicates < 0.05.
 * @param {ReturnType<typeof shapeDescriptor>} a @param {ReturnType<typeof shapeDescriptor>} b
 */
export function shapeDistance(a, b) {
    let s = 0;
    for (let k = 0; k < 8; k += 1) s += ((a.harmonics[k] - b.harmonics[k]) * 4) ** 2;
    s += ((a.compactness - b.compactness) * 2) ** 2;
    s += ((a.solidity - b.solidity) * 2) ** 2;
    s += ((a.elongation - b.elongation) * 0.6) ** 2;
    s += ((a.orientedFill - b.orientedFill) * 1.5) ** 2;
    return Math.sqrt(s);
}

/** Binary min-heap keyed by number carrying a number payload (deterministic for equal keys by insertion path). */
export class MinHeap {
    constructor() {
        /** @type {number[]} */ this.k = [];
        /** @type {number[]} */ this.v = [];
    }

    get size() { return this.k.length; }

    /** @param {number} key @param {number} val */
    push(key, val) {
        let i = this.k.length;
        this.k.push(key);
        this.v.push(val);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.k[p] <= key) break;
            this.k[i] = this.k[p];
            this.v[i] = this.v[p];
            i = p;
        }
        this.k[i] = key;
        this.v[i] = val;
    }

    pop() {
        const key = this.k[0];
        const val = this.v[0];
        const lk = /** @type {number} */ (this.k.pop());
        const lv = /** @type {number} */ (this.v.pop());
        const size = this.k.length;
        if (size > 0) {
            let i = 0;
            for (;;) {
                let c = 2 * i + 1;
                if (c >= size) break;
                if (c + 1 < size && this.k[c + 1] < this.k[c]) c += 1;
                if (this.k[c] >= lk) break;
                this.k[i] = this.k[c];
                this.v[i] = this.v[c];
                i = c;
            }
            this.k[i] = lk;
            this.v[i] = lv;
        }
        return [key, val];
    }
}
