/**
 * Automatic civilization site selection over a BOUNDED search. Pure (no Minecraft imports).
 *
 * Flow for the runtime: `planScan` lists the sample columns to read (nearest first, so the
 * scan can be time-sliced with `sliceScan`), the scanner writes them into a `makeGridField`, and
 * `rankSites` evaluates candidate settlement windows from that field. Everything is
 * deterministic: no randomness, ties break on distance, then z, then x.
 *
 * Geometry: the analysis lattice has one sample every `step` blocks, anchored on the search
 * anchor. A window is `windowSize` blocks square (n x n cells); candidate window centres sit on
 * a coarser lattice of `candidateStep` blocks. Per-window sums come from 2-D prefix sums, so
 * evaluating hundreds of candidates costs nothing beyond the single field read.
 */

import { assessCell } from "./field.js";

/** @typedef {import("./field.js").HeightField} HeightField */
/** @typedef {import("./field.js").FieldCell} FieldCell */

/**
 * How a chosen window must be built on. Persisted with the plan so a resume replans identically.
 * `allowWater` lets a district bridge and pier over open water; `adaptive` makes lots stand on
 * decks and pillars (instead of being levelled) wherever the ground falls away or is wet.
 * @typedef {{ allowWater: boolean, adaptive: boolean, maxRelief: number }} TerrainPolicy
 */

/** A window the old flat/dry-land rules would have accepted keeps exactly these numbers. */
export const TERRAIN_POLICY_DEFAULT = Object.freeze({ allowWater: false, adaptive: false, maxRelief: 8 });

/**
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 * @typedef {Rect | { type?: "rect" } & Rect | { type?: "poly", points: [number, number][] } | { polygon: [number, number][] } | { cx: number, cz: number, half: number }} Exclusion
 * @typedef {{
 *   windowSize?: number, requiredColumns?: number, minUsableFraction?: number, searchRadius?: number, step?: number,
 *   candidateStep?: number, maxWaterFraction?: number, maxLavaFraction?: number, maxSteepFraction?: number,
 *   maxTreeFraction?: number, maxPrepBlocks?: number, prepWeight?: number, maxSlope?: number,
 *   exclusions?: Exclusion[], exclusionMode?: "avoid" | "carve", exclusionMargin?: number, maxCandidates?: number,
 * }} SiteOptions
 */

export const SITE_DEFAULTS = Object.freeze({
    /** Square analysis window in blocks. 480 x 480 = 230k columns, so ~190k preparable needs ~82%. */
    windowSize: 480,
    /** Columns the settlement can be BUILT on, counting land, water (piers) and steep ground (decks on pillars). */
    requiredColumns: 190000,
    /** Search radius (blocks) for the window CENTRE around the anchor. */
    searchRadius: 220,
    /** Sample spacing of the analysis lattice, in blocks. */
    step: 8,
    /** Spacing of candidate window centres, in blocks (multiple of step). */
    candidateStep: 24,
    /**
     * Terrain is not a land-use veto any more: water is crossed on piers, steep ground carries decks on
     * pillars and trees are cleared, so these caps only bound the ESTIMATE. Lava stays a hard refusal
     * (nothing is built on it).
     */
    maxWaterFraction: 1,
    maxLavaFraction: 0,
    /**
     * Water that is ENCLOSED by a window (a lake or inland bay) cannot join a district without breaking
     * the plan's solid-region and area contract, so such windows are refused with a reason; the survey
     * then picks a nearby dry, coastal or all-sea window. Water is "open" when a fair share of the
     * window BORDER is water too (a sea coast, a wide river mouth, an all-sea window).
     */
    mixedWaterMin: 0.12,
    mixedWaterEdgeMin: 0.2,
    maxSteepFraction: 1,
    maxTreeFraction: 1,
    /** Hard cap on estimated cut + fill + clear blocks. Water costs one cap block per column. */
    maxPrepBlocks: 2_500_000,
    /** Prep blocks that cost the same as one block of extra distance from the anchor. */
    prepWeight: 1500,
    maxSlope: 0.6,
    exclusionMode: "avoid",
    exclusionMargin: 16,
    maxCandidates: 60,
});

/**
 * @param {SiteOptions} [options]
 */
function resolve(options = {}) {
    const merged = { ...SITE_DEFAULTS, ...options };
    const step = merged.step;
    if (!Number.isInteger(step) || step < 1) throw new Error("step must be a positive integer");
    const windowCells = Math.max(1, Math.round(merged.windowSize / step));
    const windowBlocks = windowCells * step;
    const minUsableFraction = options.minUsableFraction ?? Math.min(1, merged.requiredColumns / (windowBlocks * windowBlocks));
    const candStride = Math.max(1, Math.round(merged.candidateStep / step));
    return { ...merged, step, windowCells, windowBlocks, minUsableFraction, candStride, exclusions: merged.exclusions ?? [] };
}

/**
 * Radius around the anchor the runtime must scan so every candidate window is fully known.
 * @param {SiteOptions} [options]
 */
export function scanRadiusFor(options = {}) {
    const r = resolve(options);
    return r.searchRadius + Math.ceil(r.windowCells / 2) * r.step + 2 * r.step;
}

/**
 * Sample points to read, nearest first (squared distance, then i, then j). Lattice-aligned to the anchor.
 * @param {{ x: number, z: number }} anchor @param {number} radius blocks (square half-extent) @param {number} step
 * @returns {{ anchor: { x: number, z: number }, radius: number, step: number, count: number, points: { x: number, z: number }[] }}
 */
export function planScan(anchor, radius, step) {
    if (!Number.isInteger(step) || step < 1) throw new Error("step must be a positive integer");
    const ax = Math.round(anchor.x);
    const az = Math.round(anchor.z);
    const m = Math.ceil(radius / step);
    /** @type {{ x: number, z: number, d: number, i: number, j: number }[]} */
    const all = [];
    for (let j = -m; j <= m; j += 1) for (let i = -m; i <= m; i += 1) all.push({ x: ax + i * step, z: az + j * step, d: i * i + j * j, i, j });
    all.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);
    const points = all.map((p) => ({ x: p.x, z: p.z }));
    return { anchor: { x: ax, z: az }, radius, step, count: points.length, points };
}

/**
 * One time-slice of a scan plan.
 * @param {{ points: { x: number, z: number }[] }} plan @param {number} cursor @param {number} budget
 */
export function sliceScan(plan, cursor, budget) {
    const points = plan.points.slice(cursor, cursor + budget);
    const next = cursor + points.length;
    return { points, next, done: next >= plan.points.length };
}

/**
 * Cost/size estimate of the scan and the preparation work.
 * @param {SiteOptions} [options] @param {{ columnsPerSlice?: number, blocksPerColumnRead?: number }} [budget]
 */
export function estimateScan(options = {}, budget = {}) {
    const r = resolve(options);
    const radius = scanRadiusFor(options);
    const m = Math.ceil(radius / r.step);
    const columns = (2 * m + 1) ** 2;
    const perSlice = budget.columnsPerSlice ?? 200;
    const blocksPerColumn = budget.blocksPerColumnRead ?? 6;
    return { radius, step: r.step, columns, blockReads: columns * blocksPerColumn, slices: Math.ceil(columns / perSlice), windowCells: r.windowCells, candidates: countCandidates(r) };
}

/**
 * Estimate world-write operations for a ranked site's preparation.
 * @param {{ prep: { cut: number, fill: number, clear: number, terrace?: number } }} site @param {{ writesPerSlice?: number }} [budget]
 */
export function estimateOperations(site, budget = {}) {
    const total = site.prep.cut + site.prep.fill + site.prep.clear + (site.prep.terrace ?? 0);
    return { cut: site.prep.cut, fill: site.prep.fill, clear: site.prep.clear, terrace: site.prep.terrace ?? 0, total, slices: Math.ceil(total / (budget.writesPerSlice ?? 4000)) };
}

// ---------------------------------------------------------------------------------------------
// Exclusions

/**
 * @param {Exclusion} e
 * @returns {{ rect: Rect, poly: [number, number][] | null }}
 */
function normaliseExclusion(e) {
    const any = /** @type {any} */ (e);
    if (Array.isArray(any.points) || Array.isArray(any.polygon)) {
        /** @type {[number, number][]} */
        const poly = any.points ?? any.polygon;
        if (poly.length < 3) throw new Error("polygon exclusion needs at least 3 points");
        let x0 = Infinity;
        let z0 = Infinity;
        let x1 = -Infinity;
        let z1 = -Infinity;
        for (const [x, z] of poly) {
            x0 = Math.min(x0, x);
            z0 = Math.min(z0, z);
            x1 = Math.max(x1, x);
            z1 = Math.max(z1, z);
        }
        return { rect: { x0, z0, x1, z1 }, poly };
    }
    if (typeof any.half === "number") return { rect: { x0: any.cx - any.half, z0: any.cz - any.half, x1: any.cx + any.half, z1: any.cz + any.half }, poly: null };
    return { rect: { x0: any.x0, z0: any.z0, x1: any.x1, z1: any.z1 }, poly: null };
}

/**
 * @param {number} px @param {number} pz @param {[number, number][]} poly
 */
function pointInPoly(px, pz, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
        const [xi, zi] = /** @type {[number, number]} */ (poly[i]);
        const [xj, zj] = /** @type {[number, number]} */ (poly[j]);
        if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/**
 * @param {number} ax @param {number} az @param {number} bx @param {number} bz @param {number} cx @param {number} cz @param {number} dx @param {number} dz
 */
function segmentsCross(ax, az, bx, bz, cx, cz, dx, dz) {
    const o = (/** @type {number} */ px, /** @type {number} */ pz, /** @type {number} */ qx, /** @type {number} */ qz, /** @type {number} */ rx, /** @type {number} */ rz) => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
    const o1 = o(ax, az, bx, bz, cx, cz);
    const o2 = o(ax, az, bx, bz, dx, dz);
    const o3 = o(cx, cz, dx, dz, ax, az);
    const o4 = o(cx, cz, dx, dz, bx, bz);
    return o1 !== o2 && o3 !== o4;
}

/**
 * Exact test: does the rectangle (inclusive blocks) touch any exclusion, grown by `margin` blocks?
 * @param {Rect} rect @param {Exclusion[]} exclusions @param {number} [margin]
 */
export function overlapsExclusion(rect, exclusions, margin = 0) {
    const r = { x0: rect.x0 - margin, z0: rect.z0 - margin, x1: rect.x1 + margin, z1: rect.z1 + margin };
    for (const e of exclusions) {
        const { rect: er, poly } = normaliseExclusion(e);
        if (er.x1 < r.x0 || er.x0 > r.x1 || er.z1 < r.z0 || er.z0 > r.z1) continue;
        if (poly === null) return true;
        // polygon vs rectangle: vertex inside, rect corner inside, or any edge crossing
        if (poly.some(([x, z]) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)) return true;
        const corners = /** @type {[number, number][]} */ ([[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]]);
        if (corners.some(([x, z]) => pointInPoly(x, z, poly))) return true;
        for (let i = 0; i < poly.length; i += 1) {
            const [ax, az] = /** @type {[number, number]} */ (poly[i]);
            const [bx, bz] = /** @type {[number, number]} */ (poly[(i + 1) % poly.length]);
            for (let c = 0; c < 4; c += 1) {
                const [cx, cz] = /** @type {[number, number]} */ (corners[c]);
                const [dx, dz] = /** @type {[number, number]} */ (corners[(c + 1) % 4]);
                if (segmentsCross(ax, az, bx, bz, cx, cz, dx, dz)) return true;
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------------------------
// Ranking

/** @param {ReturnType<typeof resolve>} r */
function candidateOffsets(r) {
    const mCand = Math.floor(r.searchRadius / (r.candStride * r.step));
    /** @type {{ i: number, j: number }[]} */
    const list = [];
    for (let j = -mCand; j <= mCand; j += 1) {
        for (let i = -mCand; i <= mCand; i += 1) {
            const dx = i * r.candStride * r.step;
            const dz = j * r.candStride * r.step;
            if (dx * dx + dz * dz <= r.searchRadius * r.searchRadius) list.push({ i: i * r.candStride, j: j * r.candStride });
        }
    }
    return list;
}

/** @param {ReturnType<typeof resolve>} r */
function countCandidates(r) {
    return candidateOffsets(r).length;
}

/**
 * Evaluate civilization sites around `anchor` and pick the nearest suitable one.
 *
 * Suitable means: window fully loaded, centre cell not lava/unloaded/blocked/protected, no
 * exclusion overlap, lava under its cap, enough PREPARABLE land (land + water + steep ground:
 * water is crossed on piers and steep ground carries decks on pillars), and estimated preparation
 * under `maxPrepBlocks`. Among suitable candidates the winner minimises
 * `distance + prepBlocks / prepWeight` (distance = window centre to anchor, in blocks). Water and
 * steep work is charged per column, so flat dry land still wins when it is equally close - but it
 * is a price, not a veto.
 *
 * @param {HeightField} field @param {{ x: number, z: number }} anchor @param {SiteOptions} [options]
 */
export function rankSites(field, anchor, options = {}) {
    const r = resolve(options);
    const s = r.step;
    const ax = Math.round(anchor.x);
    const az = Math.round(anchor.z);
    const offsets = candidateOffsets(r);
    const reach = offsets.reduce((m, o) => Math.max(m, Math.abs(o.i), Math.abs(o.j)), 0);
    const M = reach + Math.ceil(r.windowCells / 2) + 1; // interior cells span -M..M
    const D = 2 * M + 1;
    const S = D + 2; // sample lattice incl. one-cell border for neighbour reads
    const cellX0 = (/** @type {number} */ i) => ax + i * s - Math.floor(s / 2);
    const cellZ0 = (/** @type {number} */ j) => az + j * s - Math.floor(s / 2);

    // 1. read each lattice point exactly once
    /** @type {FieldCell[]} */
    const samples = new Array(S * S);
    for (let sj = 0; sj < S; sj += 1) for (let si = 0; si < S; si += 1) samples[sj * S + si] = field.at(ax + (si - M - 1) * s, az + (sj - M - 1) * s);
    const reads = S * S;

    // 2. exclusion mask on interior cells
    const excl = new Uint8Array(D * D);
    for (const e of r.exclusions) {
        const { rect, poly } = normaliseExclusion(e);
        const raw = (/** @type {number} */ v, /** @type {number} */ a) => Math.floor((v - a + Math.floor(s / 2)) / s) + M;
        const i0 = Math.max(0, raw(rect.x0, ax));
        const i1 = Math.min(D - 1, raw(rect.x1, ax));
        const j0 = Math.max(0, raw(rect.z0, az));
        const j1 = Math.min(D - 1, raw(rect.z1, az));
        for (let j = j0; j <= j1; j += 1) {
            for (let i = i0; i <= i1; i += 1) {
                if (poly === null) {
                    excl[j * D + i] = 1;
                } else {
                    const cx0 = cellX0(i - M);
                    const cz0 = cellZ0(j - M);
                    if (overlapsExclusion({ x0: cx0, z0: cz0, x1: cx0 + s - 1, z1: cz0 + s - 1 }, [e])) excl[j * D + i] = 1;
                }
            }
        }
    }
    const dm = Math.ceil(r.exclusionMargin / s);
    const dilated = new Uint8Array(D * D);
    for (let j = 0; j < D; j += 1) {
        for (let i = 0; i < D; i += 1) {
            if (excl[j * D + i] === 0) continue;
            for (let dj = Math.max(0, j - dm); dj <= Math.min(D - 1, j + dm); dj += 1) for (let di = Math.max(0, i - dm); di <= Math.min(D - 1, i + dm); di += 1) dilated[dj * D + di] = 1;
        }
    }

    // 3. classify cells, build prefix sums
    const P = D + 1;
    const mk = () => new Float64Array(P * P);
    const sums = { build: mk(), water: mk(), lava: mk(), steep: mk(), unknown: mk(), tree: mk(), dev: mk(), excl: mk() };
    /** @type {Uint8Array} */
    const codes = new Uint8Array(D * D);
    for (let j = 0; j < D; j += 1) {
        for (let i = 0; i < D; i += 1) {
            const nine = [];
            for (let dz = 0; dz < 3; dz += 1) for (let dx = 0; dx < 3; dx += 1) nine.push(/** @type {FieldCell} */ (samples[(j + dz) * S + (i + dx)]));
            const a = assessCell(nine, s, { maxSlope: r.maxSlope });
            const isExcluded = dilated[j * D + i] === 1;
            let code = /** @type {number} */ (a.code);
            if (isExcluded && r.exclusionMode === "carve" && code === 1) code = 6; // 6 = carved out by an exclusion
            codes[j * D + i] = code;
            const idx = (j + 1) * P + (i + 1);
            const put = (/** @type {Float64Array} */ arr, /** @type {number} */ v) => {
                arr[idx] = v + /** @type {number} */ (arr[idx - 1]) + /** @type {number} */ (arr[idx - P]) - /** @type {number} */ (arr[idx - P - 1]);
            };
            put(sums.build, code === 1 ? 1 : 0);
            put(sums.water, code === 3 ? 1 : 0);
            put(sums.lava, code === 4 ? 1 : 0);
            put(sums.steep, code === 2 ? 1 : 0);
            put(sums.unknown, code === 0 ? 1 : 0);
            put(sums.tree, code === 1 && a.tree ? 1 : 0);
            put(sums.dev, code === 1 ? a.dev : 0);
            put(sums.excl, isExcluded ? 1 : 0);
        }
    }
    /** window sum over interior cells i0..i1, j0..j1 inclusive (interior index space 0..D-1) */
    const box = (/** @type {Float64Array} */ arr, /** @type {number} */ i0, /** @type {number} */ j0, /** @type {number} */ i1, /** @type {number} */ j1) =>
        /** @type {number} */ (arr[(j1 + 1) * P + (i1 + 1)]) - /** @type {number} */ (arr[j0 * P + (i1 + 1)]) - /** @type {number} */ (arr[(j1 + 1) * P + i0]) + /** @type {number} */ (arr[j0 * P + i0]);

    // 4. evaluate candidates
    const n = r.windowCells;
    const area = n * n * s * s;
    /** @typedef {ReturnType<typeof evaluate>} Candidate */
    const evaluate = (/** @type {{ i: number, j: number }} */ o) => {
        const i0 = o.i - Math.floor(n / 2) + M;
        const j0 = o.j - Math.floor(n / 2) + M;
        const i1 = i0 + n - 1;
        const j1 = j0 + n - 1;
        const cx = ax + o.i * s;
        const cz = az + o.j * s;
        const window = { x0: cellX0(o.i - Math.floor(n / 2)), z0: cellZ0(o.j - Math.floor(n / 2)), x1: 0, z1: 0 };
        window.x1 = window.x0 + n * s - 1;
        window.z1 = window.z0 + n * s - 1;
        const cells = n * n;
        const build = box(sums.build, i0, j0, i1, j1);
        const water = box(sums.water, i0, j0, i1, j1);
        const lava = box(sums.lava, i0, j0, i1, j1);
        const steep = box(sums.steep, i0, j0, i1, j1);
        const unknown = box(sums.unknown, i0, j0, i1, j1);
        const trees = box(sums.tree, i0, j0, i1, j1);
        const devSum = box(sums.dev, i0, j0, i1, j1);
        const exclCells = box(sums.excl, i0, j0, i1, j1);
        const cutFill = Math.round(devSum * s * s);
        // Water costs a deck block per column (a pier lot/road, never a fill); steep ground costs an
        // estimated two support blocks per column (a deck on pillars). Both are prices that push a
        // window down the ranking, never vetoes.
        const waterFill = Math.round(water * s * s);
        const terrace = Math.round(steep * s * s * 2);
        const prep = { cut: Math.round(cutFill / 2), fill: cutFill - Math.round(cutFill / 2) + waterFill, clear: Math.round(trees * s * s * 0.6), water: waterFill, terrace, total: 0 };
        prep.total = prep.cut + prep.fill + prep.clear + prep.terrace;
        const distance = Math.hypot(o.i * s, o.j * s);
        const preparable = build + water + steep;
        const usableColumns = preparable * s * s;
        const usableFraction = preparable / cells;
        const solidFraction = build / cells;
        const waterFraction = water / cells;
        // Water the window ENCLOSES (a lake / inland bay) would have to be claimed by a district, which
        // the plan's solid-region and area contract cannot hold. Open water (a coast, an all-sea window)
        // has water on the window BORDER as well, so it is fine.
        const borderCells = n > 2 ? cells - (n - 2) * (n - 2) : cells;
        const borderWater = n > 2 ? water - box(sums.water, i0 + 1, j0 + 1, i1 - 1, j1 - 1) : water;
        const borderWaterShare = borderCells > 0 ? borderWater / borderCells : 0;
        const lavaFraction = lava / cells;
        const steepFraction = steep / cells;
        const treeFraction = build > 0 ? trees / build : 0;
        const centreCode = /** @type {number} */ (codes[(o.j + M) * D + (o.i + M)]);
        /** @type {string[]} */
        const failures = [];
        if (unknown > 0) failures.push(`unloaded: ${String(unknown)} unread cell(s) in the window`);
        if (r.exclusionMode === "avoid" && (exclCells > 0 || overlapsExclusion(window, r.exclusions, r.exclusionMargin))) failures.push("overlaps a protected district");
        // 1 = land, 2 = steep, 3 = water. All three can be built on (steep carries decks on pillars, water
        // carries piers); lava, blocked (caves/foreign blocks), unloaded and protected cells cannot.
        if (centreCode < 1 || centreCode > 3) failures.push(`centre is ${["unloaded", "buildable", "steep", "water", "lava", "blocked", "protected"][centreCode] ?? "unusable"}`);
        if (lavaFraction > r.maxLavaFraction) failures.push(`lava exposure ${(lavaFraction * 100).toFixed(2)}% > ${(r.maxLavaFraction * 100).toFixed(2)}%`);
        if (waterFraction > r.maxWaterFraction) failures.push(`water ${(waterFraction * 100).toFixed(1)}% > ${(r.maxWaterFraction * 100).toFixed(1)}%`);
        if (waterFraction > r.mixedWaterMin && borderWaterShare < r.mixedWaterEdgeMin) failures.push(`enclosed water (${(waterFraction * 100).toFixed(1)}% of the window, ${(borderWaterShare * 100).toFixed(0)}% of its border): a lake or inland bay cannot form one solid district - a dry, coastal or open-sea window is needed`);
        if (steepFraction > r.maxSteepFraction) failures.push(`steep ground ${(steepFraction * 100).toFixed(1)}% > ${(r.maxSteepFraction * 100).toFixed(1)}%`);
        if (usableFraction < r.minUsableFraction) failures.push(`preparable terrain ${(usableFraction * 100).toFixed(1)}% < ${(r.minUsableFraction * 100).toFixed(1)}%`);
        if (treeFraction > r.maxTreeFraction) failures.push(`trees on ${(treeFraction * 100).toFixed(0)}% of land > ${(r.maxTreeFraction * 100).toFixed(0)}%`);
        if (prep.total > r.maxPrepBlocks) failures.push(`preparation ~${String(prep.total)} blocks > ${String(r.maxPrepBlocks)}`);
        const score = distance + prep.total / r.prepWeight;
        return {
            x: cx,
            z: cz,
            window,
            distance: Math.round(distance * 10) / 10,
            suitable: failures.length === 0,
            failures,
            usableColumns,
            usableFraction: Math.round(usableFraction * 1000) / 1000,
            solidFraction: Math.round(solidFraction * 1000) / 1000,
            waterFraction: Math.round(waterFraction * 1000) / 1000,
            lavaFraction: Math.round(lavaFraction * 10000) / 10000,
            steepFraction: Math.round(steepFraction * 1000) / 1000,
            treeFraction: Math.round(treeFraction * 1000) / 1000,
            flatness: Math.round((build > 0 ? devSum / build : 0) * 100) / 100,
            prep,
            score: Math.round(score * 100) / 100,
            windowArea: area,
        };
    };
    const all = offsets.map(evaluate);
    const suitable = all.filter((c) => c.suitable).sort((a, b) => a.score - b.score || a.distance - b.distance || a.z - b.z || a.x - b.x);
    const rejected = all.filter((c) => !c.suitable).sort((a, b) => a.distance - b.distance || a.z - b.z || a.x - b.x);
    const candidates = [...suitable, ...rejected].slice(0, r.maxCandidates);

    /** @type {string[]} */
    const reasons = [];
    const anchorCode = /** @type {number} */ (codes[M * D + M]);
    const winner = suitable[0] ?? null;
    if (winner === null) {
        if (all.length === 0) reasons.push("no candidate windows fit inside the search radius");
        const known = samples.filter((c) => c.k !== "unloaded").length;
        if (known === 0) reasons.push("no terrain has been scanned around the anchor");
        if (anchorCode < 1 || anchorCode > 3) reasons.push(`the anchor itself is ${["unloaded", "buildable", "steep", "water", "lava or next to lava", "blocked", "protected"][anchorCode] ?? "unusable"}`);
        /** @type {Map<string, number>} */
        const tally = new Map();
        for (const c of all) {
            const head = (c.failures[0] ?? "").replace(/[\d.]+/g, "#");
            tally.set(head, (tally.get(head) ?? 0) + 1);
        }
        for (const [head, count] of [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) reasons.push(`${String(count)} of ${String(all.length)} candidates: ${head}`);
        const near = [...all].sort((a, b) => a.failures.length - b.failures.length || a.distance - b.distance)[0];
        if (near) reasons.push(`closest miss at (${String(near.x)}, ${String(near.z)}): ${near.failures.join("; ")}`);
    }
    const site = winner === null ? null : { ...winner, anchor: { x: ax, z: az } };
    return { site, reasons, candidates, reads, evaluated: all.length, cells: D * D, anchorCode, windowCells: n, step: s };
}

/**
 * How the chosen window's terrain must be built on. A pure function of the ranked site, so the same
 * site always yields the same policy (it is persisted with the master plan and with each district's
 * site payload):
 *  - `allowWater`: the window holds open water, so roads may bridge / stand on piers over it;
 *  - `adaptive`: wet or rough ground - lots stand on a deck carried by pillars down to the ground or
 *    the sea bed, and only the uphill side is cut (no levelling of a mountain, no draining of a sea);
 *  - `maxRelief`: the master plan may settle ground the default analysis calls impassable.
 * Each threshold is the OLD rejection boundary, so a window that was buildable before keeps the old
 * numbers and its saved plans rehydrate byte-identically.
 *
 * @param {{ waterFraction?: number, steepFraction?: number, flatness?: number } | null | undefined} site
 * @returns {TerrainPolicy}
 */
export function siteTerrainPolicy(site) {
    const water = Number(site?.waterFraction ?? 0);
    const steep = Number(site?.steepFraction ?? 0);
    const flatness = Number(site?.flatness ?? 0);
    const rough = steep > 0.04 || flatness > 3;
    return {
        allowWater: water > 0,
        adaptive: water > 0 || rough,
        maxRelief: rough ? 16 : 8,
    };
}
