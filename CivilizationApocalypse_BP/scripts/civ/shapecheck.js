/**
 * Cooperative (yielding) replica of the shape rules of civ/validate.js, so the planner's own check and the
 * authoritative validator cannot disagree. Thresholds come straight from VALIDATE_DEFAULTS; the arithmetic mirrors the
 * validator's cell-based shape section (orientedFillOf, congruence, symmetryScore, descriptors). A test compares these
 * numbers with the validator's exported functions on real plans. Owner: planner agent (A).
 */

import { VALIDATE_DEFAULTS } from "./validate.js";
import { WORK_LIMIT, markYield } from "./regions.js";
import { rasterizePath } from "./geom.js";

/** @typedef {[number, number]} Pt */
/** @typedef {import("./regions.js").Ops} Ops */

/** @param {Ops} ops */
function due(ops) {
    return ops.work - ops.lastYield >= WORK_LIMIT;
}

/**
 * Account for `n` operations in slices of at most 4000, yielding when due.
 * @param {Ops} ops @param {number} n @returns {Generator<void, void, void>}
 */
function* spend(ops, n) {
    let left = n;
    while (left > 0) {
        const c = Math.min(left, 4000);
        ops.work += c;
        left -= c;
        if (due(ops)) { markYield(ops); yield; }
    }
}

/**
 * Smallest oriented-rectangle fill over 1 degree rotations (same arithmetic as validate.orientedFillOf).
 * @param {number[][]} cells @param {Ops} ops
 * @returns {Generator<void, number, void>}
 */
export function* orientedFillSteps(cells, ops) {
    if (cells.length === 0) return 0;
    let best = Infinity;
    for (let deg = 0; deg < 90; deg += 1) {
        const c = Math.cos((deg * Math.PI) / 180);
        const s = Math.sin((deg * Math.PI) / 180);
        let u0 = Infinity;
        let u1 = -Infinity;
        let v0 = Infinity;
        let v1 = -Infinity;
        for (let k = 0; k < cells.length; k += 1) {
            if ((k & 2047) === 2047) {
                ops.work += 4096;
                if (due(ops)) { markYield(ops); yield; }
            }
            const i = cells[k][0];
            const j = cells[k][1];
            const u = i * c + j * s;
            const v = -i * s + j * c;
            if (u < u0) u0 = u;
            if (u > u1) u1 = u;
            if (v < v0) v0 = v;
            if (v > v1) v1 = v;
        }
        const area = (u1 - u0 + 1) * (v1 - v0 + 1);
        if (area < best) best = area;
        ops.work += 8;
    }
    return Math.min(1, cells.length / best);
}

/**
 * Eight dihedral variants of a cell list (validate.dihedralVariants).
 * @param {number[][]} cells @param {Ops} ops
 * @returns {Generator<void, Set<number>[], void>}
 */
function* variantsSteps(cells, ops) {
    /** @type {((i: number, j: number) => number[])[]} */
    const fns = [
        (i, j) => [i, j], (i, j) => [-i, j], (i, j) => [i, -j], (i, j) => [-i, -j],
        (i, j) => [j, i], (i, j) => [-j, i], (i, j) => [j, -i], (i, j) => [-j, -i],
    ];
    /** @type {Set<number>[]} */
    const out = [];
    for (const fn of fns) {
        yield* spend(ops, cells.length * 3);
        const t = cells.map(([i, j]) => fn(i, j));
        let mi = Infinity;
        let mj = Infinity;
        for (const [i, j] of t) { if (i < mi) mi = i; if (j < mj) mj = j; }
        out.push(new Set(t.map(([i, j]) => (i - mi) * 65536 + (j - mj))));
    }
    return out;
}

/**
 * Best IoU between two cell sets over the 8 dihedral transforms (validate.congruence) from precomputed variants.
 * @param {Set<number>[]} va @param {Set<number>[]} vb @param {Ops} ops
 * @returns {Generator<void, { iou: number, exact: boolean }, void>}
 */
function* congruenceSteps(va, vb, ops) {
    const base = va[0];
    if (base.size === 0 || vb[0].size === 0) return { iou: 0, exact: false };
    let best = 0;
    let exact = false;
    for (const v of vb) {
        yield* spend(ops, base.size * 2);
        let inter = 0;
        for (const key of base) if (v.has(key)) inter += 1;
        const union = base.size + v.size - inter;
        const iou = inter / union;
        if (iou > best) best = iou;
        if (inter === base.size && inter === v.size) exact = true;
    }
    return { iou: best, exact };
}

/**
 * Highest symmetry score of a labelled grid (validate.symmetryScore), row-chunked.
 * @param {Uint8Array} cells @param {number} w @param {number} h @param {boolean} labelAware @param {Ops} ops
 * @returns {Generator<void, { score: number, transform: string }, void>}
 */
export function* symmetrySteps(cells, w, h, labelAware, ops) {
    let n = 0;
    let si = 0;
    let sj = 0;
    for (let j = 0; j < h; j += 1) {
        ops.work += w;
        if (due(ops)) { markYield(ops); yield; }
        for (let i = 0; i < w; i += 1) if (cells[j * w + i] !== 0) { n += 1; si += i; sj += j; }
    }
    if (n === 0) return { score: 0, transform: "none" };
    const names = ["mirror-x", "mirror-z", "rot180", "rot90", "diagonal", "antidiagonal"];
    let best = 0;
    let bestName = "none";
    const ci = Math.round((2 * si) / n);
    const cj = Math.round((2 * sj) / n);
    for (let t = 0; t < 6; t += 1) {
        for (let di = -1; di <= 1; di += 1) {
            for (let dj = -1; dj <= 1; dj += 1) {
                const sI = ci + di;
                const sJ = cj + dj;
                let match = 0;
                for (let j = 0; j < h; j += 1) {
                    ops.work += w;
                    if (due(ops)) { markYield(ops); yield; }
                    for (let i = 0; i < w; i += 1) {
                        const label = cells[j * w + i];
                        if (label === 0) continue;
                        const u = 2 * i - sI;
                        const v = 2 * j - sJ;
                        let tu = u;
                        let tv = v;
                        if (t === 0) tu = -u;
                        else if (t === 1) tv = -v;
                        else if (t === 2) { tu = -u; tv = -v; }
                        else if (t === 3) { tu = -v; tv = u; }
                        else if (t === 4) { tu = v; tv = u; }
                        else { tu = -v; tv = -u; }
                        const ti2 = tu + sI;
                        const tj2 = tv + sJ;
                        if ((ti2 & 1) !== 0 || (tj2 & 1) !== 0) continue;
                        const ti = ti2 / 2;
                        const tj = tj2 / 2;
                        if (ti < 0 || tj < 0 || ti >= w || tj >= h) continue;
                        const other = cells[tj * w + ti];
                        if (labelAware ? other === label : other !== 0) match += 1;
                    }
                }
                const score = match / (2 * n - match);
                if (score > best) { best = score; bestName = names[t]; }
            }
        }
    }
    return { score: best, transform: bestName };
}

/** @param {Pt[]} poly */
function areaOf(poly) {
    let s = 0;
    for (let i = 0, n = poly.length; i < n; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
}

/** @param {Pt[]} poly */
function perimeterOf(poly) {
    let s = 0;
    for (let i = 0, n = poly.length; i < n; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return s;
}

/**
 * @typedef {object} ShapeInput
 * @property {Uint8Array} labels plan-grid labels (cw*ch)
 * @property {number} cw @property {number} ch @property {number} cell @property {number} gx0 @property {number} gz0
 * @property {Pt[][]} outlines index d-1
 * @property {number} totalArea
 * @property {Array<{ path: Pt[] }>} outerWalls
 * @property {{ x: number, z: number }} cmdHq
 */

/**
 * Shape problems under the validator's rules (empty when the validator's shape section would pass).
 * @param {ShapeInput} inp @param {Ops} ops
 * @returns {Generator<void, { problems: string[], metrics: any }, void>}
 */
export function* shapeProblemsSteps(inp, ops) {
    const opt = VALIDATE_DEFAULTS;
    const { labels, cw, ch, cell } = inp;
    /** @type {string[]} */
    const problems = [];
    const n = 5;
    /** @type {number[][][]} */
    const lists = Array.from({ length: n + 1 }, () => []);
    const minI = new Array(n + 1).fill(Infinity);
    const maxI = new Array(n + 1).fill(-Infinity);
    const minJ = new Array(n + 1).fill(Infinity);
    const maxJ = new Array(n + 1).fill(-Infinity);
    const sumI = new Array(n + 1).fill(0);
    const sumJ = new Array(n + 1).fill(0);
    /** @type {number[][]} */
    const all = [];
    for (let j = 0; j < ch; j += 1) {
        ops.work += cw;
        if (due(ops)) { markYield(ops); yield; }
        for (let i = 0; i < cw; i += 1) {
            const l = labels[j * cw + i];
            if (l === 0) continue;
            lists[l].push([i, j]);
            all.push([i, j]);
            if (i < minI[l]) minI[l] = i;
            if (i > maxI[l]) maxI[l] = i;
            if (j < minJ[l]) minJ[l] = j;
            if (j > maxJ[l]) maxJ[l] = j;
            sumI[l] += i;
            sumJ[l] += j;
        }
    }
    // ---- union
    let ui0 = Infinity; let ui1 = -Infinity; let uj0 = Infinity; let uj1 = -Infinity;
    let sui = 0; let suj = 0;
    for (const [i, j] of all) { if (i < ui0) ui0 = i; if (i > ui1) ui1 = i; if (j < uj0) uj0 = j; if (j > uj1) uj1 = j; sui += i; suj += j; }
    yield* spend(ops, all.length);
    const bboxFill = all.length / ((ui1 - ui0 + 1) * (uj1 - uj0 + 1));
    const oriented = yield* orientedFillSteps(all, ops);
    let outerPerimeter = 0;
    /** @type {Pt[]} */
    const outerPixels = [];
    let vertexCount = 0;
    for (const wall of inp.outerWalls) {
        outerPerimeter += perimeterOf(wall.path) - Math.hypot(wall.path[0][0] - wall.path[wall.path.length - 1][0], wall.path[0][1] - wall.path[wall.path.length - 1][1]);
        vertexCount += wall.path.length;
        const px = rasterizePath(wall.path, false);
        yield* spend(ops, px.length);
        for (const p of px) outerPixels.push(p);
    }
    const compactness = outerPerimeter > 0 ? (4 * Math.PI * inp.totalArea) / (outerPerimeter * outerPerimeter) : 0;
    /** @type {any} */
    const metrics = { union: { bboxFill, orientedFill: oriented, compactness } };
    if (bboxFill >= opt.bboxFillMax) problems.push(`civilization bbox fill ${bboxFill.toFixed(3)} >= ${String(opt.bboxFillMax)} (rectangular outline)`);
    if (oriented >= opt.orientedFillMaxUnion) problems.push(`civilization oriented-rectangle fill ${oriented.toFixed(3)} >= ${String(opt.orientedFillMaxUnion)}`);
    if (outerPerimeter > 0) {
        if (compactness > opt.compactnessMax) problems.push(`civilization compactness ${compactness.toFixed(3)} > ${String(opt.compactnessMax)} (circular outline)`);
        if (compactness < opt.compactnessMin) problems.push(`civilization compactness ${compactness.toFixed(3)} < ${String(opt.compactnessMin)} (stringy outline)`);
    }
    const cxw = inp.gx0 + (sui / all.length) * cell + cell / 2;
    const czw = inp.gz0 + (suj / all.length) * cell + cell / 2;
    if (outerPixels.length > 0) {
        let s1 = 0; let s2 = 0;
        for (const p of outerPixels) {
            const r = Math.hypot(p[0] - cxw, p[1] - czw);
            s1 += r; s2 += r * r;
        }
        yield* spend(ops, outerPixels.length);
        const mean = s1 / outerPixels.length;
        const variance = Math.max(0, s2 / outerPixels.length - mean * mean);
        const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
        metrics.union.radialCv = cv;
        if (cv < opt.radialCvMin) problems.push(`outer wall radial variation ${cv.toFixed(3)} < ${String(opt.radialCvMin)}`);
    }
    if (vertexCount < 12) problems.push(`outer wall has only ${String(vertexCount)} vertices`);
    const sym = yield* symmetrySteps(labels, cw, ch, false, ops);
    const symL = yield* symmetrySteps(labels, cw, ch, true, ops);
    metrics.union.symmetry = sym;
    metrics.union.labelSymmetry = symL;
    if (sym.score > opt.symmetryMax) problems.push(`civilization outline is ${(sym.score * 100).toFixed(0)}% ${sym.transform}-symmetric`);
    if (symL.score > opt.symmetryMax) problems.push(`district layout is ${(symL.score * 100).toFixed(0)}% ${symL.transform}-symmetric`);
    const dc = Math.hypot(inp.cmdHq.x - cxw, inp.cmdHq.z - czw);
    const bcx = inp.gx0 + ((ui0 + ui1 + 1) / 2) * cell;
    const bcz = inp.gz0 + ((uj0 + uj1 + 1) / 2) * cell;
    const db = Math.hypot(inp.cmdHq.x - bcx, inp.cmdHq.z - bcz);
    metrics.hqOffset = { centroid: Math.round(dc), bboxCentre: Math.round(db) };
    if (dc < opt.hqMinOffset) problems.push(`command HQ only ${dc.toFixed(0)} blocks from the civilization centroid`);
    if (db < opt.hqMinOffset) problems.push(`command HQ only ${db.toFixed(0)} blocks from the civilization bbox centre`);
    // ---- districts
    /** @type {Array<Record<"compactness" | "bboxFill" | "orientedFill" | "aspect" | "ecc", number>>} */
    const desc = [];
    for (let d = 1; d <= n; d += 1) {
        const bw = maxI[d] - minI[d] + 1;
        const bh = maxJ[d] - minJ[d] + 1;
        const cnt = lists[d].length;
        const fill = cnt / (bw * bh);
        const orientedD = yield* orientedFillSteps(lists[d], ops);
        const poly = inp.outlines[d - 1];
        const comp = poly.length >= 3 ? (() => { const p = perimeterOf(poly); return p > 0 ? (4 * Math.PI * areaOf(poly)) / (p * p) : 0; })() : 0;
        const mi = sumI[d] / cnt;
        const mj = sumJ[d] / cnt;
        let sxx = 0; let szz = 0; let sxz = 0;
        for (const [i, j] of lists[d]) { sxx += (i - mi) ** 2; szz += (j - mj) ** 2; sxz += (i - mi) * (j - mj); }
        yield* spend(ops, cnt * 2);
        sxx /= cnt; szz /= cnt; sxz /= cnt;
        const tr = sxx + szz;
        const det = sxx * szz - sxz * sxz;
        const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
        const l1 = tr / 2 + disc;
        const l2 = Math.max(1e-9, tr / 2 - disc);
        const ecc = Math.sqrt(1 - l2 / l1);
        const aspect = Math.min(bw, bh) / Math.max(bw, bh);
        desc.push({ compactness: comp, bboxFill: fill, orientedFill: orientedD, aspect, ecc });
        const tag = `district-${String(d)}`;
        if (fill >= opt.bboxFillMax) problems.push(`${tag} bbox fill ${fill.toFixed(3)} >= ${String(opt.bboxFillMax)}`);
        if (orientedD >= opt.orientedFillMaxDistrict) problems.push(`${tag} oriented-rectangle fill ${orientedD.toFixed(3)} >= ${String(opt.orientedFillMaxDistrict)}`);
        if (comp > 0 && comp > opt.compactnessMax) problems.push(`${tag} compactness ${comp.toFixed(3)} > ${String(opt.compactnessMax)}`);
        if (comp > 0 && comp < opt.compactnessMin) problems.push(`${tag} compactness ${comp.toFixed(3)} < ${String(opt.compactnessMin)}`);
    }
    metrics.districts = desc;
    /** @type {Set<number>[][]} */
    const vars = [[]];
    for (let d = 1; d <= n; d += 1) vars.push(yield* variantsSteps(lists[d], ops));
    for (let a = 1; a <= n; a += 1) {
        for (let b = a + 1; b <= n; b += 1) {
            const cg = yield* congruenceSteps(vars[a], vars[b], ops);
            if (cg.exact || cg.iou >= opt.congruenceIou) problems.push(`district-${String(a)} and district-${String(b)} outlines are congruent (best IoU ${cg.iou.toFixed(3)})`);
            const da = desc[a - 1];
            const dbb = desc[b - 1];
            let maxDiff = 0;
            for (const key of /** @type {const} */ (["compactness", "bboxFill", "orientedFill", "aspect", "ecc"])) {
                const x = da[key];
                const y = dbb[key];
                const diff = Math.abs(x - y) / Math.max(x, y, 1e-9);
                if (diff > maxDiff) maxDiff = diff;
            }
            if (maxDiff < opt.descriptorMinDiff) problems.push(`district-${String(a)} and district-${String(b)} have indistinguishable shape descriptors (${maxDiff.toFixed(4)})`);
        }
    }
    return { problems, metrics };
}
