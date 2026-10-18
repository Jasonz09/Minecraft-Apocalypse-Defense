import { newOps } from "./regions.js";
import { pace as paceUnits } from "./siteprofile.js";
import {
    PAD,
    VALIDATE_DEFAULTS,
    compactnessOf,
    decodeLabelsIndependent,
    dihedralVariants,
    polygonAreaOf,
    polygonPerimeterOf,
    rasterizePolyline,
} from "./validate.js";

/**
 * Cooperative (generator) form of civ/validate.js validatePlan: the same checks in the same order with the same
 * messages and metrics (a test compares them on seven plan variants, valid and broken), with every heavy loop
 * and flood fill charged to `ops` (civ/regions.js convention) so the generator yields at least every ~20,000
 * elementary operations. validate.js stays the authority and is untouched; this file is produced from it by
 * mechanical, asserted text transformations. If validate.js changes, regenerate it: the test fails on drift.
 *
 * @typedef {import("./regions.js").Ops} Ops
 * @typedef {{ [key: string]: any }} Obj
 * @typedef {typeof VALIDATE_DEFAULTS} ValidateOptions
 */

/**
 * Charges below are per inner-loop iteration; one unit of civ/regions.js work is about 16 ns offline, so they are scaled down.
 */
const UNIT_SCALE = 10;

/** @param {Ops} ops @param {number} n @returns {Generator<void, void, void>} */
function* pace(ops, n) {
    yield* paceUnits(ops, Math.max(1, Math.ceil(n / UNIT_SCALE)));
}

const ROLES = ["command", "industrial", "agricultural", "commercial", "residential"];
const NAMES = ["Hearthgate", "Ironquarry", "Whitethorn", "Saltmere", "Ashfall"];
const PURPOSES = ["main", "evac", "reinforce", "field"];

class Report {
    /** @param {number} cap */
    constructor(cap) {
        this.cap = cap;
        /** @type {string[]} */
        this.items = [];
        /** @type {Map<string, number>} */
        this.counts = new Map();
    }

    /** @param {string} cat @param {string} message */
    add(cat, message) {
        const seen = this.counts.get(cat) ?? 0;
        this.counts.set(cat, seen + 1);
        if (seen < this.cap) this.items.push(`[${cat}] ${message}`);
    }

    /** @returns {string[]} */
    finish() {
        const out = [...this.items];
        for (const [cat, seen] of this.counts) if (seen > this.cap) out.push(`[${cat}] ... and ${String(seen - this.cap)} more`);
        return out;
    }

    /** @returns {number} */
    get total() {
        let t = 0;
        for (const v of this.counts.values()) t += v;
        return t;
    }
}

/** @param {any} v */
function isInt(v) {
    return typeof v === "number" && Number.isInteger(v);
}

/** @param {any} p */
function isPoint(p) {
    return Array.isArray(p) && p.length === 2 && isInt(p[0]) && isInt(p[1]);
}


/**
 * labelComponents (civ/validate.js) as a cooperative generator.
 * @param {Uint8Array} blocked @param {number} w @param {number} h @param {boolean} [eight] @param {Ops} [ops]
 * @returns {Generator<void, { comp: Int32Array, count: number }, void>}
 */
function* labelComponentsSteps(blocked, w, h, eight = false, ops = newOps()) {
    const n = w * h;
    const comp = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let count = 0;
    yield* pace(ops, n >> 5);
    for (let s = 0; s < n; s++) {
        if ((s & 4095) === 4095) yield* pace(ops, 4096);
        if (blocked[s] !== 0 || comp[s] !== -1) continue;
        let head = 0;
        let tail = 0;
        queue[tail++] = s;
        comp[s] = count;
        while (head < tail) {
            if ((head & 255) === 255) yield* pace(ops, 256 * (eight ? 28 : 16));
            const p = queue[head++];
            const x = p % w;
            const z = (p - x) / w;
            for (let dz = -1; dz <= 1; dz++) {
                const nz = z + dz;
                if (nz < 0 || nz >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if ((dx === 0 && dz === 0) || (!eight && dx !== 0 && dz !== 0)) continue;
                    const nx = x + dx;
                    if (nx < 0 || nx >= w) continue;
                    const q = nz * w + nx;
                    if (blocked[q] !== 0 || comp[q] !== -1) continue;
                    comp[q] = count;
                    queue[tail++] = q;
                }
            }
        }
        count++;
    }
    return { comp, count };
}

/**
 * erodeUniform (civ/validate.js) as a cooperative generator.
 * @param {Uint8Array} labels @param {number} w @param {number} h @param {number} r @param {Ops} ops
 * @returns {Generator<void, Uint8Array, void>}
 */
function* erodeUniformSteps(labels, w, h, r, ops) {
    const n = w * h;
    const mnH = new Uint8Array(n);
    const mxH = new Uint8Array(n);
    for (let z = 0; z < h; z++) {
        yield* pace(ops, w * (2 * r + 3) * 3);
        const row = z * w;
        for (let x = 0; x < w; x++) {
            const lo = Math.max(0, x - r);
            const hi = Math.min(w - 1, x + r);
            let mn = 255;
            let mx = 0;
            for (let k = lo; k <= hi; k++) {
                const v = labels[row + k];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            mnH[row + x] = mn;
            mxH[row + x] = mx;
        }
    }
    const out = new Uint8Array(n);
    for (let z = 0; z < h; z++) {
        yield* pace(ops, w * (2 * r + 3) * 3);
        const lo = Math.max(0, z - r);
        const hi = Math.min(h - 1, z + r);
        for (let x = 0; x < w; x++) {
            let mn = 255;
            let mx = 0;
            for (let k = lo; k <= hi; k++) {
                const a = mnH[k * w + x];
                const b = mxH[k * w + x];
                if (a < mn) mn = a;
                if (b > mx) mx = b;
            }
            out[z * w + x] = mn === mx ? 1 : 0;
        }
    }
    return out;
}

/**
 * stampSquare (civ/validate.js) as a cooperative generator.
 * @param {Uint8Array} mask @param {number} w @param {number} h @param {number[][]} pixels @param {number} r @param {Ops} ops
 * @returns {Generator<void, void, void>}
 */
function* stampSquareSteps(mask, w, h, pixels, r, ops) {
    let done = 0;
    for (const [px, pz] of pixels) {
        done += 1;
        if ((done & 63) === 0) yield* pace(ops, 64 * (2 * r + 1) * (2 * r + 1) * 4);
        for (let dz = -r; dz <= r; dz++) {
            const z = pz + dz;
            if (z < 0 || z >= h) continue;
            for (let dx = -r; dx <= r; dx++) {
                const x = px + dx;
                if (x < 0 || x >= w) continue;
                mask[z * w + x] = 1;
            }
        }
    }
}

/**
 * orientedFillOf (civ/validate.js) as a cooperative generator.
 * @param {number[][]} cells @param {Ops} ops
 * @returns {Generator<void, number, void>}
 */
function* orientedFillSteps(cells, ops) {
    if (cells.length === 0) return 0;
    let best = Infinity;
    for (let deg = 0; deg < 90; deg++) {
        yield* pace(ops, Math.min(23000, cells.length * 12 + 40));
        const c = Math.cos((deg * Math.PI) / 180);
        const s = Math.sin((deg * Math.PI) / 180);
        let u0 = Infinity;
        let u1 = -Infinity;
        let v0 = Infinity;
        let v1 = -Infinity;
        for (const [i, j] of cells) {
            const u = i * c + j * s;
            const v = -i * s + j * c;
            if (u < u0) u0 = u;
            if (u > u1) u1 = u;
            if (v < v0) v0 = v;
            if (v > v1) v1 = v;
        }
        const area = (u1 - u0 + 1) * (v1 - v0 + 1);
        if (area < best) best = area;
    }
    return Math.min(1, cells.length / best);
}

/**
 * congruence (civ/validate.js) as a cooperative generator.
 * @param {number[][]} a @param {number[][]} b @param {Ops} ops
 * @returns {Generator<void, { iou: number, exact: boolean }, void>}
 */
function* congruenceSteps(a, b, ops) {
    if (a.length === 0 || b.length === 0) return { iou: 0, exact: false };
    yield* pace(ops, Math.min(23000, a.length * 80 + 100));
    const base = /** @type {Set<number>} */ (dihedralVariants(a)[0]);
    let best = 0;
    let exact = false;
    yield* pace(ops, Math.min(23000, b.length * 80 + 100));
    for (const v of dihedralVariants(b)) {
        yield* pace(ops, Math.min(23000, base.size * 12 + 100));
        let inter = 0;
        for (const key of base) if (v.has(key)) inter++;
        const union = base.size + v.size - inter;
        const iou = inter / union;
        if (iou > best) best = iou;
        if (inter === base.size && inter === v.size) exact = true;
    }
    return { iou: best, exact };
}

/**
 * symmetryScore (civ/validate.js) as a cooperative generator.
 * @param {Uint8Array} cells @param {number} w @param {number} h @param {boolean} labelAware @param {Ops} ops
 * @returns {Generator<void, { score: number, transform: string }, void>}
 */
function* symmetrySteps(cells, w, h, labelAware, ops) {
    let n = 0;
    let si = 0;
    let sj = 0;
    for (let j = 0; j < h; j++) {
        yield* pace(ops, w * 5);
        for (let i = 0; i < w; i++) if (cells[j * w + i] !== 0) { n++; si += i; sj += j; }
    }
    if (n === 0) return { score: 0, transform: "none" };
    const names = ["mirror-x", "mirror-z", "rot180", "rot90", "diagonal", "antidiagonal"];
    let best = 0;
    let bestName = "none";
    const ci = Math.round((2 * si) / n);
    const cj = Math.round((2 * sj) / n);
    for (let t = 0; t < 6; t++) {
        for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
                const sI = ci + di;
                const sJ = cj + dj;
                let match = 0;
                for (let j = 0; j < h; j++) {
                    yield* pace(ops, w * 22);
                    for (let i = 0; i < w; i++) {
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
                        if (labelAware ? other === label : other !== 0) match++;
                    }
                }
                // IoU of the mask with its transform: matched / (n + n - matched)
                const score = match / (2 * n - match);
                if (score > best) { best = score; bestName = names[t]; }
            }
        }
    }
    return { score: best, transform: bestName };
}

/**
 * Scan the plan for values that do not survive JSON (cooperative).
 * @param {any} root @param {Report} rep @param {number} maxNodes @param {Ops} ops
 * @returns {Generator<void, void, void>}
 */
function* checkJsonSafeSteps(root, rep, maxNodes, ops) {
    /** @type {{ v: any, path: string }[]} */
    const stack = [{ v: root, path: "plan" }];
    let nodes = 0;
    while (stack.length > 0) {
        if ((nodes & 255) === 255) yield* pace(ops, 256 * 40);
        const { v, path } = /** @type {{ v: any, path: string }} */ (stack.pop());
        if (++nodes > maxNodes) { rep.add("json", `more than ${String(maxNodes)} JSON nodes; plan too large to scan`); return; }
        const t = typeof v;
        if (v === null || t === "string" || t === "boolean") continue;
        if (t === "number") { if (!Number.isFinite(v)) rep.add("json", `${path} is ${String(v)} (not JSON-safe)`); continue; }
        if (t === "undefined" || t === "function" || t === "bigint" || t === "symbol") { rep.add("json", `${path} is ${t} (not JSON-safe)`); continue; }
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) stack.push({ v: v[i], path: `${path}[${String(i)}]` }); continue; }
        if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) { rep.add("json", `${path} is a ${String(v?.constructor?.name)} instance (not a plain object)`); continue; }
        for (const key of Object.keys(v)) stack.push({ v: v[key], path: `${path}.${key}` });
    }
}

/**
 * Reports districts whose cells are not one 4-connected piece (cooperative).
 * @param {Uint8Array} cells @param {number} w @param {number} h @param {number} n @param {Report} rep @param {Ops} ops
 * @returns {Generator<void, void, void>}
 */
function* checkDistrictPiecesSteps(cells, w, h, n, rep, ops) {
    for (let d = 1; d <= n; d++) {
        const blocked = new Uint8Array(cells.length);
        for (let k = 0; k < cells.length; k++) {
            if ((k & 4095) === 4095) yield* pace(ops, 4096 * 2);
            blocked[k] = cells[k] === d ? 0 : 1;
        }
        const cc = yield* labelComponentsSteps(blocked, w, h, false, ops);
        if (cc.count > 1) rep.add("districts", `district-${String(d)} is split into ${String(cc.count)} disconnected pieces`);
    }
}

/**
 * IoU between the cells whose centres fall inside the polygon and the cells labelled d (cooperative).
 * @param {number[][]} poly @param {Uint8Array} cells @param {number} w @param {number} h @param {number} d
 * @param {number} x0 @param {number} z0 @param {number} cell @param {Ops} ops
 * @returns {Generator<void, number, void>}
 */
function* outlineIouSteps(poly, cells, w, h, d, x0, z0, cell, ops) {
    let inter = 0;
    let inside = 0;
    let labelled = 0;
    yield* pace(ops, Math.min(23000, cells.length * 2));
    for (let k = 0; k < cells.length; k++) if (cells[k] === d) labelled++;
    for (let j = 0; j < h; j++) {
        yield* pace(ops, poly.length * 12 + w * 6 + 40);
        const zc = z0 + j * cell + cell / 2;
        /** @type {number[]} */
        const xs = [];
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            if ((a[1] <= zc) !== (b[1] <= zc)) xs.push(a[0] + ((zc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
        xs.sort((p, q) => p - q);
        for (let m = 0; m + 1 < xs.length; m += 2) {
            const iStart = Math.max(0, Math.ceil((xs[m] - x0 - cell / 2) / cell));
            const iEnd = Math.min(w - 1, Math.ceil((xs[m + 1] - x0 - cell / 2) / cell) - 1);
            for (let i = iStart; i <= iEnd; i++) {
                inside++;
                if (cells[j * w + i] === d) inter++;
            }
        }
    }
    const union = inside + labelled - inter;
    return union === 0 ? 0 : inter / union;
}

/** Cost estimate of rasterising a polyline (cells touched). @param {number[][]} path */
function rasterCost(path) {
    let cost = 0;
    for (let i = 0; i + 1 < path.length; i++) cost += Math.max(Math.abs(path[i][0] - path[i + 1][0]), Math.abs(path[i][1] - path[i + 1][1]));
    return cost;
}

/** @param {any} plan @param {ValidateOptions} opt @param {Report} rep @param {Obj} metrics @param {Ops} ops @returns {Generator<void, void, void>} */
function* runChecksSteps(plan, opt, rep, metrics, ops) {
    const n = opt.districtCount;
    const cell = opt.cell;
    if (plan === null || typeof plan !== "object") { rep.add("structure", "plan is not an object"); return; }

    // ---- structure + JSON ------------------------------------------------------------------------------
    if (plan.version !== 1) rep.add("structure", `version must be 1, saw ${String(plan.version)}`);
    if (!isInt(plan.seed)) rep.add("structure", `seed must be an integer, saw ${String(plan.seed)}`);
    if (!plan.anchor || !isInt(plan.anchor.x) || !isInt(plan.anchor.z)) rep.add("structure", "anchor must be {x, z} integers");
    if (plan.cell !== cell) rep.add("structure", `cell must be ${String(cell)}, saw ${String(plan.cell)}`);
    for (const key of ["districts", "walls", "gates", "roads", "labels"]) if (!Array.isArray(plan[key])) rep.add("structure", `${key} must be an array`);
    if (!plan.routes || !Array.isArray(plan.routes.evac) || !Array.isArray(plan.routes.reinforce)) rep.add("structure", "routes.evac / routes.reinforce must be arrays");
    if (!plan.stats || typeof plan.stats !== "object") rep.add("stats", "stats object missing");
    yield* checkJsonSafeSteps(plan, rep, opt.maxItems * 40, ops);
    let jsonBytes = 0;
    try {
        const text = JSON.stringify(plan);
        jsonBytes = text.length;
        yield* pace(ops, Math.min(23000, text.length >> 1));
        const again = JSON.parse(text);
        if (JSON.stringify(again) !== text) rep.add("json", "plan does not survive a JSON round trip unchanged");
    } catch (error) {
        rep.add("json", `plan cannot be serialised: ${error instanceof Error ? error.message : String(error)}`);
    }
    metrics.jsonBytes = jsonBytes;
    if (jsonBytes > opt.maxJsonBytes) rep.add("json", `plan JSON is ${String(jsonBytes)} bytes, over the ${String(opt.maxJsonBytes)} budget`);
    if (!Array.isArray(plan.labels) || !plan.grid || !Array.isArray(plan.districts)) return;
    if (plan.walls.length > 400 || plan.gates.length > 400 || plan.roads.length > 4000) { rep.add("structure", "too many walls/gates/roads for a bounded validation"); return; }

    // ---- labels ------------------------------------------------------------------------------------------
    const g = plan.grid;
    if (!isInt(g.x0) || !isInt(g.z0)) { rep.add("structure", "grid.x0/z0 must be integers"); return; }
    yield* pace(ops, Math.min(23000, (Array.isArray(plan.labels) ? plan.labels.length * 8 : 0) + ((g.w * g.h) >> 3) + 100));
    const dec = decodeLabelsIndependent(plan);
    if (!dec.ok) { rep.add("labels", dec.error); return; }
    if (g.w > opt.maxGridCells * 4 || g.h > opt.maxGridCells * 4 || g.w * cell > 800 || g.h * cell > 800) { rep.add("structure", `grid ${String(g.w)}x${String(g.h)} cells exceeds the supported ~700x700 block raster`); return; }
    const cw = g.w;
    const ch = g.h;
    const cells = dec.data;
    /** @type {number[]} */
    const cellCount = new Array(n + 1).fill(0);
    let bad = 0;
    for (let k = 0; k < cells.length; k++) {
        if ((k & 4095) === 4095) yield* pace(ops, 4096 * 2);
        if (cells[k] > n) bad++;
        else cellCount[cells[k]]++;
    }
    if (bad > 0) { rep.add("labels", `${String(bad)} cells carry a label above ${String(n)}`); return; }
    const labelledCells = cells.length - cellCount[0];
    metrics.cellCount = cellCount;
    metrics.labelledCells = labelledCells;
    metrics.totalArea = labelledCells * cell * cell;

    /** per-label cell statistics */
    const minI = new Array(n + 1).fill(Infinity);
    const maxI = new Array(n + 1).fill(-Infinity);
    const minJ = new Array(n + 1).fill(Infinity);
    const maxJ = new Array(n + 1).fill(-Infinity);
    const sumI = new Array(n + 1).fill(0);
    const sumJ = new Array(n + 1).fill(0);
    /** @type {number[][][]} */
    const cellLists = Array.from({ length: n + 1 }, () => []);
    for (let j = 0; j < ch; j++) {
        yield* pace(ops, cw * 10);
        for (let i = 0; i < cw; i++) {
            const l = cells[j * cw + i];
            if (l === 0) continue;
            if (i < minI[l]) minI[l] = i;
            if (i > maxI[l]) maxI[l] = i;
            if (j < minJ[l]) minJ[l] = j;
            if (j > maxJ[l]) maxJ[l] = j;
            sumI[l] += i;
            sumJ[l] += j;
            cellLists[l].push([i, j]);
        }
    }
    for (let d = 1; d <= n; d++) if (cellCount[d] === 0) rep.add("districts", `district-${String(d)} owns no cells`);
    if (cellCount.slice(1).some((c) => c === 0)) return;

    // cell-level connectivity per district, hole detection and adjacency
    {
        yield* checkDistrictPiecesSteps(cells, cw, ch, n, rep, ops);
        // outside connectivity: label 0 cells must all connect to the grid edge or the pad
        const zeroMask = new Uint8Array(cells.length);
        for (let k = 0; k < cells.length; k++) {
            if ((k & 4095) === 4095) yield* pace(ops, 4096 * 2);
            zeroMask[k] = cells[k] === 0 ? 0 : 1;
        }
        const cc = yield* labelComponentsSteps(zeroMask, cw, ch, false, ops);
        /** @type {Set<number>} */
        const touchesEdge = new Set();
        for (let i = 0; i < cw; i++) { touchesEdge.add(cc.comp[i]); touchesEdge.add(cc.comp[(ch - 1) * cw + i]); }
        for (let j = 0; j < ch; j++) { touchesEdge.add(cc.comp[j * cw]); touchesEdge.add(cc.comp[j * cw + cw - 1]); }
        for (let k = 0; k < cells.length; k++) {
            if ((k & 4095) === 4095) yield* pace(ops, 4096 * 6);
            if (cells[k] === 0 && cc.comp[k] >= 0 && !touchesEdge.has(cc.comp[k])) {
                rep.add("districts", `enclosed hole of unlabelled cells near cell (${String(k % cw)}, ${String(Math.floor(k / cw))}); the civilization must be one solid region`);
                break;
            }
        }
    }

    // ---- districts block ---------------------------------------------------------------------------------
    /** @type {(Obj | null)[]} */
    const distBy = new Array(n + 1).fill(null);
    if (plan.districts.length !== n) rep.add("districts", `expected ${String(n)} districts, saw ${String(plan.districts.length)}`);
    for (const d of plan.districts) {
        if (!d || !isInt(d.index) || d.index < 1 || d.index > n) { rep.add("districts", `district entry with bad index ${String(d?.index)}`); continue; }
        if (distBy[d.index]) { rep.add("districts", `duplicate district index ${String(d.index)}`); continue; }
        distBy[d.index] = d;
    }
    const x0g = g.x0;
    const z0g = g.z0;
    /** @type {number[]} */
    const areas = [];
    for (let d = 1; d <= n; d++) {
        const entry = distBy[d];
        const tag = `district-${String(d)}`;
        const area = cellCount[d] * cell * cell;
        areas.push(area);
        if (area < opt.areaMin || area > opt.areaMax) rep.add("area", `${tag} labelled area ${String(area)} outside [${String(opt.areaMin)}, ${String(opt.areaMax)}]`);
        if (!entry) { rep.add("districts", `${tag} missing`); continue; }
        if (entry.id !== tag) rep.add("districts", `district index ${String(d)} has id ${String(entry.id)}, expected ${tag}`);
        if (n === 5 && entry.role !== ROLES[d - 1]) rep.add("districts", `${tag} role ${String(entry.role)} != ${ROLES[d - 1]}`);
        if (n === 5 && entry.name !== NAMES[d - 1]) rep.add("districts", `${tag} name ${String(entry.name)} != ${NAMES[d - 1]}`);
        if (Math.abs(entry.area - area) > opt.areaTolerance) rep.add("area", `${tag} area ${String(entry.area)} != labelled cells*${String(cell * cell)} = ${String(area)}`);
        if (entry.cells !== cellCount[d]) rep.add("area", `${tag} cells ${String(entry.cells)} != labelled ${String(cellCount[d])}`);
        const bx0 = x0g + minI[d] * cell;
        const bz0 = z0g + minJ[d] * cell;
        const bx1 = x0g + (maxI[d] + 1) * cell - 1;
        const bz1 = z0g + (maxJ[d] + 1) * cell - 1;
        const bb = entry.bbox;
        const bt = opt.bboxTolerance;
        if (!bb || Math.abs(bb.x0 - bx0) > bt || Math.abs(bb.z0 - bz0) > bt || Math.abs(bb.x1 - bx1) > bt || Math.abs(bb.z1 - bz1) > bt) rep.add("districts", `${tag} bbox ${JSON.stringify(bb)} != labelled ${JSON.stringify({ x0: bx0, z0: bz0, x1: bx1, z1: bz1 })}`);
        const cx = x0g + (sumI[d] / cellCount[d]) * cell + cell / 2;
        const cz = z0g + (sumJ[d] / cellCount[d]) * cell + cell / 2;
        if (!entry.centroid || Math.abs(entry.centroid.x - cx) > 2.5 || Math.abs(entry.centroid.z - cz) > 2.5) rep.add("districts", `${tag} centroid ${JSON.stringify(entry.centroid)} != labelled (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
        if (!entry.hq || !isInt(entry.hq.x) || !isInt(entry.hq.z)) rep.add("hq", `${tag} hq must be integer {x, z}`);
    }
    metrics.areas = areas;
    const totalArea = labelledCells * cell * cell;
    const tMin = opt.totalMin * (1 - opt.totalTolerance);
    const tMax = opt.totalMax * (1 + opt.totalTolerance);
    if (totalArea < tMin || totalArea > tMax) rep.add("area", `total area ${String(totalArea)} outside [${tMin.toFixed(0)}, ${tMax.toFixed(0)}]`);

    // stats
    if (plan.stats && typeof plan.stats === "object") {
        const s = plan.stats;
        if (Math.abs(s.totalArea - totalArea) > opt.areaTolerance * n) rep.add("stats", `stats.totalArea ${String(s.totalArea)} != ${String(totalArea)}`);
        if (!Array.isArray(s.perDistrictArea) || s.perDistrictArea.length !== n || s.perDistrictArea.some((/** @type {number} */ v, /** @type {number} */ k) => Math.abs(v - areas[k]) > opt.areaTolerance)) rep.add("stats", `stats.perDistrictArea ${JSON.stringify(s.perDistrictArea)} != ${JSON.stringify(areas)}`);
        if (s.gateCount !== plan.gates.length) rep.add("stats", `stats.gateCount ${String(s.gateCount)} != ${String(plan.gates.length)}`);
        if (Array.isArray(s.bboxFill)) {
            for (let d = 1; d <= n; d++) {
                const bw = (maxI[d] - minI[d] + 1) * cell;
                const bh = (maxJ[d] - minJ[d] + 1) * cell;
                const fill = (cellCount[d] * cell * cell) / (bw * bh);
                if (typeof s.bboxFill[d - 1] !== "number" || Math.abs(s.bboxFill[d - 1] - fill) > 0.02) rep.add("stats", `stats.bboxFill[${String(d - 1)}] ${String(s.bboxFill[d - 1])} != computed ${fill.toFixed(3)}`);
            }
        } else rep.add("stats", "stats.bboxFill missing");
    }

    // ---- block raster ------------------------------------------------------------------------------------
    const RW = cw * cell + 2 * PAD;
    const RH = ch * cell + 2 * PAD;
    const rx0 = x0g - PAD;
    const rz0 = z0g - PAD;
    const N = RW * RH;
    metrics.raster = { w: RW, h: RH };
    /** @param {number} x @param {number} z */
    const inRaster = (x, z) => x >= rx0 && z >= rz0 && x < rx0 + RW && z < rz0 + RH;
    /** @param {number} x @param {number} z */
    const pidx = (x, z) => (z - rz0) * RW + (x - rx0);
    /** @param {number} p */
    const px = (p) => (p % RW) + rx0;
    /** @param {number} p */
    const pz = (p) => Math.floor(p / RW) + rz0;
    const labelB = new Uint8Array(N);
    for (let j = 0; j < ch; j++) {
        yield* pace(ops, cw * (cell * 4 + 6));
        for (let i = 0; i < cw; i++) {
            const l = cells[j * cw + i];
            if (l === 0) continue;
            for (let dz = 0; dz < cell; dz++) {
                const row = (j * cell + dz + PAD) * RW + PAD + i * cell;
                labelB.fill(l, row, row + cell);
            }
        }
    }
    const slack = opt.slack;
    const interiorLeak = yield* erodeUniformSteps(labelB, RW, RH, slack + 1, ops);
    const interiorWall = yield* erodeUniformSteps(labelB, RW, RH, slack, ops);

    // hq checks needing the raster
    for (let d = 1; d <= n; d++) {
        const entry = distBy[d];
        if (!entry?.hq || !isInt(entry.hq.x) || !isInt(entry.hq.z)) continue;
        const { x, z } = entry.hq;
        if (!inRaster(x, z) || labelB[pidx(x, z)] !== d) rep.add("hq", `district-${String(d)} hq (${String(x)}, ${String(z)}) is not inside its own district`);
        else if (interiorWall[pidx(x, z)] === 0) rep.add("hq", `district-${String(d)} hq (${String(x)}, ${String(z)}) is within ${String(slack)} blocks of a district boundary`);
    }

    // outlines vs labels
    for (let d = 1; d <= n; d++) {
        const entry = distBy[d];
        if (!entry) continue;
        const o = entry.outline;
        if (!Array.isArray(o) || o.length < 3 || o.some((/** @type {any} */ p) => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { rep.add("districts", `district-${String(d)} outline must be >= 3 [x, z] points`); continue; }
        const poly = o.length > 3 && o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1] ? o.slice(0, -1) : o;
        const pa = polygonAreaOf(poly);
        const area = cellCount[d] * cell * cell;
        if (Math.abs(pa - area) > opt.outlineAreaTolerance * area) rep.add("districts", `district-${String(d)} outline polygon area ${pa.toFixed(0)} deviates from labelled area ${String(area)} by more than ${String(opt.outlineAreaTolerance * 100)}%`);
        const iou = yield* outlineIouSteps(poly, cells, cw, ch, d, x0g, z0g, cell, ops);
        if (iou < opt.outlineIouMin) rep.add("districts", `district-${String(d)} outline overlaps its labelled cells with IoU ${iou.toFixed(2)} < ${String(opt.outlineIouMin)} (outline does not describe this district)`);
    }

    // ---- walls -------------------------------------------------------------------------------------------
    const W = new Uint8Array(N);
    const owner = new Int16Array(N);
    const cl1 = new Int16Array(N);
    const cl2 = new Int16Array(N);
    const mark = new Int16Array(N);
    const seen = new Int16Array(N);
    /** @type {{ wall: Obj, k: number, pix: number[], set: Set<number>, ok: boolean, r: number }[]} */
    const wallInfo = [];
    /** @type {Map<string, number>} */
    const wallIndexById = new Map();
    let wallLength = 0;
    let outerPerimeter = 0;
    /** @type {number[]} */
    const outerPixels = [];
    for (let k = 0; k < plan.walls.length; k++) {
        const wall = plan.walls[k];
        yield* pace(ops, 200);
        const tag = `wall ${String(wall?.id)}`;
        if (!wall || typeof wall.id !== "string") { rep.add("wall", `walls[${String(k)}] has no string id`); wallInfo.push({ wall: wall ?? {}, k, pix: [], set: new Set(), ok: false, r: 1 }); continue; }
        if (wallIndexById.has(wall.id)) rep.add("wall", `duplicate wall id ${wall.id}`);
        wallIndexById.set(wall.id, k);
        let ok = true;
        if (wall.kind !== "outer" && wall.kind !== "shared") { rep.add("wall", `${tag} kind ${String(wall.kind)} must be outer or shared`); ok = false; }
        if (!Array.isArray(wall.path) || wall.path.length < 2 || !wall.path.every(isPoint)) { rep.add("wall", `${tag} path must be >= 2 integer [x, z] points`); wallInfo.push({ wall, k, pix: [], set: new Set(), ok: false, r: 1 }); continue; }
        if (!Array.isArray(wall.between) || wall.between.length !== 2 || !wall.between.every((/** @type {any} */ v) => isInt(v) && v >= 0 && v <= n)) { rep.add("wall", `${tag} between must be two district indices 0..${String(n)}`); ok = false; }
        else if (wall.kind === "shared" && (wall.between[0] === 0 || wall.between[1] === 0 || wall.between[0] === wall.between[1])) { rep.add("wall", `${tag} is shared but between = ${JSON.stringify(wall.between)}`); ok = false; }
        else if (wall.kind === "outer" && wall.between[0] !== 0 && wall.between[1] !== 0) { rep.add("wall", `${tag} is outer but between = ${JSON.stringify(wall.between)} has no 0 (outside)`); ok = false; }
        if (wall.thickness !== opt.wallThickness) rep.add("thickness", `${tag} thickness ${String(wall.thickness)} must be ${String(opt.wallThickness)} (thinner walls leak diagonally)`);
        const t = isInt(wall.thickness) && wall.thickness >= 1 && wall.thickness <= 9 ? wall.thickness : opt.wallThickness;
        const r = Math.max(0, Math.floor((t - 1) / 2));
        const path = wall.path;
        if (typeof wall.closed !== "boolean") { rep.add("wall", `${tag} closed must be boolean`); ok = false; }
        if (wall.closed === true) {
            const a = path[0];
            const b = path[path.length - 1];
            if (path.length < 4 || Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) > 1) rep.add("closed", `${tag} is flagged closed but its path starts (${String(a[0])}, ${String(a[1])}) and ends (${String(b[0])}, ${String(b[1])}) are not the same point; a closed wall must repeat its first point`);
        }
        let big = false;
        for (let i = 0; i + 1 < path.length; i++) if (Math.abs(path[i][0] - path[i + 1][0]) + Math.abs(path[i][1] - path[i + 1][1]) > 5000) big = true;
        if (big) { rep.add("wall", `${tag} has a segment longer than 5000 blocks`); wallInfo.push({ wall, k, pix: [], set: new Set(), ok: false, r }); continue; }
        yield* pace(ops, Math.min(23000, rasterCost(path) * 14 + 100));
        const raster = rasterizePolyline(path, wall.closed === true);
        /** @type {number[]} */
        const pix = [];
        let outside = 0;
        let rasterDone = 0;
        for (const [x, z] of raster) {
            rasterDone += 1;
            if ((rasterDone & 255) === 0) yield* pace(ops, 256 * 10);
            if (!inRaster(x, z)) { if (outside++ === 0) rep.add("wall", `${tag} pixel (${String(x)}, ${String(z)}) is outside the plan raster`); continue; }
            pix.push(pidx(x, z));
        }
        const set = new Set(pix);
        for (const p of pix) {
            if (cl1[p] === 0) cl1[p] = k + 1;
            else if (cl1[p] !== k + 1 && cl2[p] === 0) cl2[p] = k + 1;
        }
        // stamp + connectivity of this wall alone
        const stampList = [];
        let stamped = 0;
        for (const p of pix) {
            stamped += 1;
            if ((stamped & 31) === 0) yield* pace(ops, 32 * (2 * r + 1) * (2 * r + 1) * 12);
            const x = p % RW;
            const z = (p - x) / RW;
            for (let dz = -r; dz <= r; dz++) {
                for (let dx = -r; dx <= r; dx++) {
                    const sx = x + dx;
                    const sz = z + dz;
                    if (sx < 0 || sz < 0 || sx >= RW || sz >= RH) continue;
                    const q = sz * RW + sx;
                    if (mark[q] !== k + 1) { mark[q] = k + 1; stampList.push(q); }
                    W[q] = 1;
                    if (owner[q] === 0) owner[q] = k + 1;
                    else if (owner[q] !== k + 1) owner[q] = -1;
                }
            }
        }
        // 4-connectivity of the stamped barrier of this wall
        let parts = 0;
        let walked = 0;
        for (const q of stampList) {
            if (seen[q] === k + 1) continue;
            parts++;
            /** @type {number[]} */
            const stack = [q];
            seen[q] = k + 1;
            while (stack.length > 0) {
                walked += 1;
                if ((walked & 255) === 0) yield* pace(ops, 256 * 24);
                const c = /** @type {number} */ (stack.pop());
                const cx = c % RW;
                const cz = (c - cx) / RW;
                const nb = [cx > 0 ? c - 1 : -1, cx < RW - 1 ? c + 1 : -1, cz > 0 ? c - RW : -1, cz < RH - 1 ? c + RW : -1];
                for (const m of nb) if (m >= 0 && mark[m] === k + 1 && seen[m] !== k + 1) { seen[m] = k + 1; stack.push(m); }
            }
        }
        if (parts > 1) rep.add("wall", `${tag} stamped barrier splits into ${String(parts)} 4-connected pieces (diagonal-only links leak)`);
        let len = 0;
        for (let i = 0; i + 1 < path.length; i++) len += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
        wallLength += len;
        if (wall.kind === "outer") { outerPerimeter += len; for (const p of pix) outerPixels.push(p); }
        wallInfo.push({ wall, k, pix, set, ok, r });
    }
    metrics.wallLength = Math.round(wallLength);
    metrics.outerPerimeter = Math.round(outerPerimeter);
    if (!wallInfo.some((w) => w.wall.kind === "outer")) rep.add("wall", "no outer wall");

    // dangling endpoints / isolated segments
    for (const info of wallInfo) {
        const wall = info.wall;
        if (!info.ok && info.pix.length === 0) continue;
        if (wall.closed === true) continue;
        const path = wall.path;
        const ends = [path[0], path[path.length - 1]];
        for (const e of ends) {
            if (!inRaster(e[0], e[1])) continue;
            const c = pidx(e[0], e[1]);
            const ex = c % RW;
            const ez = (c - ex) / RW;
            let touches = false;
            for (let dz = -1; dz <= 1 && !touches; dz++) {
                for (let dx = -1; dx <= 1 && !touches; dx++) {
                    const sx = ex + dx;
                    const sz = ez + dz;
                    if (sx < 0 || sz < 0 || sx >= RW || sz >= RH) continue;
                    const q = sz * RW + sx;
                    if ((cl1[q] !== 0 && cl1[q] !== info.k + 1) || (cl2[q] !== 0 && cl2[q] !== info.k + 1)) touches = true;
                }
            }
            if (!touches) rep.add("dangling", `${String(wall.id)} open end (${String(e[0])}, ${String(e[1])}) does not meet another wall (dangling or isolated segment)`);
        }
    }

    // wall pixels must lie near a label boundary; wall between must agree with the labels beside it
    for (const info of wallInfo) {
        const wall = info.wall;
        if (info.pix.length === 0) continue;
        let far = 0;
        /** @type {Map<number, number>} */
        const side = new Map();
        let samples = 0;
        let sampled = 0;
        for (const p of info.pix) {
            sampled += 1;
            if ((sampled & 63) === 0) yield* pace(ops, 64 * 150);
            if (interiorWall[p] === 1 && far++ === 0) rep.add("wall", `${String(wall.id)} pixel (${String(px(p))}, ${String(pz(p))}) is more than ${String(slack)} blocks from any district boundary`);
            const x = p % RW;
            const z = (p - x) / RW;
            for (const [ox, oz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, -3], [3, -3], [-3, 3]]) {
                const sx = x + ox;
                const sz = z + oz;
                if (sx < 0 || sz < 0 || sx >= RW || sz >= RH) continue;
                const q = sz * RW + sx;
                if (W[q] === 1) continue;
                const l = labelB[q];
                side.set(l, (side.get(l) ?? 0) + 1);
                samples++;
            }
        }
        if (!Array.isArray(wall.between) || wall.between.length !== 2 || samples < 80) continue; // short stubs next to junctions are dominated by the third district
        const [a, b] = wall.between;
        const allowed = new Set([a, b]);
        const anyPositive = wall.kind === "outer" && a === 0 && b === 0;
        for (const [l, count] of side) {
            if (anyPositive && l >= 0) continue;
            if (!allowed.has(l) && count > 0.12 * samples) rep.add("wall", `${String(wall.id)} declares between ${JSON.stringify(wall.between)} but district ${String(l)} lies beside ${String(count)} of ${String(samples)} samples`);
        }
        for (const need of allowed) if (!anyPositive && (side.get(need) ?? 0) < 0.2 * samples) rep.add("wall", `${String(wall.id)} declares between ${JSON.stringify(wall.between)} but district ${String(need)} is hardly beside it (${String(side.get(need) ?? 0)} of ${String(samples)} samples)`);
    }

    // every district boundary edge is walled
    {
        let missing = 0;
        let firstShown = 0;
        /** @param {number} i @param {number} j @param {number} a @param {number} b @param {number} mx @param {number} mz */
        const checkEdge = (i, j, a, b, mx, mz) => {
            const c = pidx(mx, mz);
            const cx = c % RW;
            const cz = (c - cx) / RW;
            for (let dz = -slack; dz <= slack; dz++) {
                for (let dx = -slack; dx <= slack; dx++) {
                    const sx = cx + dx;
                    const sz = cz + dz;
                    if (sx < 0 || sz < 0 || sx >= RW || sz >= RH) continue;
                    if (W[sz * RW + sx] === 1) return;
                }
            }
            missing++;
            if (firstShown++ < opt.problemCap) rep.add("unwalled", `boundary between district ${String(a)} and ${String(b)} at (${String(mx)}, ${String(mz)}) has no wall within ${String(slack)} blocks`);
        };
        for (let j = 0; j < ch; j++) {
            yield* pace(ops, cw * 30 + 600);
            for (let i = 0; i < cw; i++) {
                const a = cells[j * cw + i];
                const right = i + 1 < cw ? cells[j * cw + i + 1] : 0;
                const down = j + 1 < ch ? cells[(j + 1) * cw + i] : 0;
                if (a !== right) checkEdge(i, j, a, right, x0g + (i + 1) * cell, z0g + j * cell + cell / 2);
                if (a !== down) checkEdge(i, j, a, down, x0g + i * cell + cell / 2, z0g + (j + 1) * cell);
                if (i === 0 && a !== 0) checkEdge(i, j, 0, a, x0g, z0g + j * cell + cell / 2);
                if (j === 0 && a !== 0) checkEdge(i, j, 0, a, x0g + i * cell + cell / 2, z0g);
            }
        }
        metrics.unwalledEdges = missing;
    }

    // ---- gates -------------------------------------------------------------------------------------------
    const G = new Uint8Array(N);
    /** @type {Map<string, Obj>} */
    const gateById = new Map();
    /** @type {{ gate: Obj, ok: boolean, sa: number, sb: number, fa: number, fb: number, at: number }[]} */
    const gateInfo = [];
    const half = (opt.gateWidth - 1) / 2;
    const thickHalf = Math.floor((opt.wallThickness - 1) / 2);
    for (const gate of plan.gates) {
        const gtag = `gate ${String(gate?.id)}`;
        let ok = true;
        if (!gate || typeof gate.id !== "string") { rep.add("gate", "gate without string id"); continue; }
        if (gateById.has(gate.id)) { rep.add("gate", `duplicate gate id ${gate.id}`); ok = false; }
        gateById.set(gate.id, gate);
        const wi = wallIndexById.get(gate.wallId);
        if (wi === undefined) { rep.add("gate", `${gtag} references unknown wall ${String(gate.wallId)}`); gateInfo.push({ gate, ok: false, sa: -1, sb: -1, fa: -1, fb: -1, at: -1 }); continue; }
        const info = wallInfo[wi];
        if (!gate.at || !isInt(gate.at.x) || !isInt(gate.at.z) || !inRaster(gate.at.x, gate.at.z)) { rep.add("gate", `${gtag} at must be integer {x, z} inside the plan`); gateInfo.push({ gate, ok: false, sa: -1, sb: -1, fa: -1, fb: -1, at: -1 }); continue; }
        if (gate.axis !== "x" && gate.axis !== "z") { rep.add("gate", `${gtag} axis ${String(gate.axis)} must be x or z`); ok = false; }
        if (gate.width !== opt.gateWidth) { rep.add("gate", `${gtag} width ${String(gate.width)} must be ${String(opt.gateWidth)}`); ok = false; }
        if (!PURPOSES.includes(gate.purpose)) { rep.add("gate", `${gtag} purpose ${String(gate.purpose)} invalid`); ok = false; }
        if (!Array.isArray(gate.between) || gate.between.length !== 2 || !gate.between.every((/** @type {any} */ v) => isInt(v) && v >= 0 && v <= n) || gate.between[0] === gate.between[1]) { rep.add("gate", `${gtag} between ${JSON.stringify(gate.between)} must be two distinct indices 0..${String(n)}`); ok = false; }
        if (!ok) { gateInfo.push({ gate, ok: false, sa: -1, sb: -1, fa: -1, fb: -1, at: -1 }); continue; }
        const { x, z } = gate.at;
        const at = pidx(x, z);
        if (!info.set.has(at)) { rep.add("gate", `${gtag} at (${String(x)}, ${String(z)}) is not on the centreline of wall ${String(gate.wallId)}`); gateInfo.push({ gate, ok: false, sa: -1, sb: -1, fa: -1, fb: -1, at }); continue; }
        const spanX = opt.gateAxisIsTravel ? gate.axis === "z" : gate.axis === "x";
        // straight run of >= 11 centreline blocks
        let straight = true;
        for (let k = -half - 3; k <= half + 3; k++) {
            const qx = spanX ? x + k : x;
            const qz = spanX ? z : z + k;
            if (!inRaster(qx, qz) || !info.set.has(pidx(qx, qz))) { straight = false; break; }
        }
        if (!straight) { rep.add("gate", `${gtag} at (${String(x)}, ${String(z)}) axis ${String(gate.axis)} is not on a straight axis-aligned run of ${String(opt.gateWidth + 6)} wall blocks`); ok = false; }
        // opening cells
        const opening = [];
        for (let a = -half; a <= half; a++) {
            for (let b = -thickHalf; b <= thickHalf; b++) {
                const ox = spanX ? x + a : x + b;
                const oz = spanX ? z + b : z + a;
                if (!inRaster(ox, oz)) continue;
                opening.push(pidx(ox, oz));
            }
        }
        for (const q of opening) {
            if (owner[q] !== 0 && owner[q] !== wi + 1) { rep.add("gate", `${gtag} opening at (${String(px(q))}, ${String(pz(q))}) overlaps another wall (junction)`); ok = false; break; }
        }
        // sides: just beyond the wall thickness, perpendicular to the span
        const off = thickHalf + 1;
        const ax = spanX ? x : x - off;
        const az = spanX ? z - off : z;
        const bx = spanX ? x : x + off;
        const bz = spanX ? z + off : z;
        const sa = pidx(ax, az);
        const sb = pidx(bx, bz);
        if (W[sa] === 1 || W[sb] === 1) { rep.add("gate", `${gtag} approach cells (${String(ax)}, ${String(az)}) / (${String(bx)}, ${String(bz)}) are walled; the opening is not through the wall`); ok = false; }
        // far labels
        const fo = slack + 2;
        const fax = spanX ? x : x - fo;
        const faz = spanX ? z - fo : z;
        const fbx = spanX ? x : x + fo;
        const fbz = spanX ? z + fo : z;
        const fa = inRaster(fax, faz) ? labelB[pidx(fax, faz)] : 0;
        const fb = inRaster(fbx, fbz) ? labelB[pidx(fbx, fbz)] : 0;
        if (ok && Array.isArray(gate.between)) {
            const want = [...gate.between].sort();
            const got = [fa, fb].sort();
            if (want[0] !== got[0] || want[1] !== got[1]) {
                rep.add("gate", `${gtag} at (${String(x)}, ${String(z)}) declares between ${JSON.stringify(gate.between)} but the labels on its two sides are ${String(fa)} and ${String(fb)}`);
                ok = false;
            }
            const wallKind = info.wall.kind;
            const outer = gate.between[0] === 0 || gate.between[1] === 0;
            if (wallKind === "outer" && !outer) { rep.add("gate", `${gtag} is on outer wall ${String(gate.wallId)} but between ${JSON.stringify(gate.between)} has no 0`); ok = false; }
            if (wallKind === "shared" && outer) { rep.add("gate", `${gtag} is on shared wall ${String(gate.wallId)} but between ${JSON.stringify(gate.between)} includes 0`); ok = false; }
        }
        if (ok) for (const q of opening) G[q] = 1;
        gateInfo.push({ gate, ok, sa, sb, fa, fb, at });
    }
    // spacing
    for (let i = 0; i < gateInfo.length; i++) {
        for (let j = i + 1; j < gateInfo.length; j++) {
            const a = gateInfo[i].gate.at;
            const b = gateInfo[j].gate.at;
            if (a && b && Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) < opt.gateMinSpacing) rep.add("gate", `gates ${String(gateInfo[i].gate.id)} and ${String(gateInfo[j].gate.id)} are closer than ${String(opt.gateMinSpacing)} blocks`);
        }
    }
    metrics.gateCount = plan.gates.length;

    // ---- flood fill: closed state ----------------------------------------------------------------------
    // movement is assumed 8-connected (corner cutting), so a barrier must be 4-connected to hold
    const cc = yield* labelComponentsSteps(W, RW, RH, true, ops);
    metrics.componentCount = cc.count;
    /** @type {Map<number, Map<number, number>>} comp -> label -> first pixel */
    const compLabels = new Map();
    /** @type {Map<number, Map<number, number>>} label -> comp -> pixel count */
    const labelComps = new Map();
    /** @type {Map<number, Map<number, number>>} label -> comp -> first pixel */
    const labelCompFirst = new Map();
    for (let p = 0; p < N; p++) {
        if ((p & 4095) === 4095) yield* pace(ops, 4096 * 6);
        if (interiorLeak[p] === 0) continue;
        const c = cc.comp[p];
        if (c < 0) continue;
        const l = labelB[p];
        let m = compLabels.get(c);
        if (!m) { m = new Map(); compLabels.set(c, m); }
        if (!m.has(l)) m.set(l, p);
        let lc = labelComps.get(l);
        if (!lc) { lc = new Map(); labelComps.set(l, lc); labelCompFirst.set(l, new Map()); }
        lc.set(c, (lc.get(c) ?? 0) + 1);
        const first = /** @type {Map<number, number>} */ (labelCompFirst.get(l));
        if (!first.has(c)) first.set(c, p);
    }
    for (const [c, m] of compLabels) {
        if (m.size > 1) {
            const parts = [...m.entries()].map(([l, p]) => `${l === 0 ? "outside" : `district ${String(l)}`} (${String(px(p))}, ${String(pz(p))})`);
            rep.add("leak", `with every gate closed, region ${String(c)} reaches ${parts.join(" and ")}: the walls leak`);
        }
    }
    /** main component per district (largest) */
    /** @type {number[]} */
    const mainComp = new Array(n + 1).fill(-1);
    for (let l = 0; l <= n; l++) {
        const lc = labelComps.get(l);
        if (!lc || lc.size === 0) { if (l > 0) rep.add("split", `district ${String(l)} has no interior region at all (too thin to measure)`); continue; }
        let best = -1;
        let bestCount = -1;
        for (const [c, count] of lc) if (count > bestCount) { best = c; bestCount = count; }
        mainComp[l] = best;
        if (lc.size > 1) {
            const first = /** @type {Map<number, number>} */ (labelCompFirst.get(l));
            const other = [...lc.keys()].find((c) => c !== best);
            const p = other === undefined ? 0 : /** @type {number} */ (first.get(other));
            rep.add("split", `${l === 0 ? "outside" : `district ${String(l)}`} interior is cut into ${String(lc.size)} sealed regions by walls (one starts near (${String(px(p))}, ${String(pz(p))}))`);
        }
    }

    // ---- gates connect exactly `between`, graph connectivity -------------------------------------------
    /** @type {Map<number, number>} */
    const uf = new Map();
    /** @param {number} a @returns {number} */
    const find = (a) => {
        let r = a;
        while ((uf.get(r) ?? r) !== r) r = /** @type {number} */ (uf.get(r));
        uf.set(a, r);
        return r;
    };
    /** @param {number} a @param {number} b */
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) uf.set(ra, rb); };
    /** @type {Set<string>} */
    const gatePairs = new Set();
    let outerGates = 0;
    /** @type {number[]} */
    const outerPerDistrict = new Array(n + 1).fill(0);
    for (const gi of gateInfo) {
        if (!gi.ok) continue;
        const g2 = gi.gate;
        const ca = cc.comp[gi.sa];
        const cb = cc.comp[gi.sb];
        const ma = mainComp[gi.fa];
        const mb = mainComp[gi.fb];
        if (ca < 0 || cb < 0) { rep.add("gate", `gate ${String(g2.id)} approach cells are walled`); continue; }
        if (ca !== ma || cb !== mb) {
            rep.add("gate", `gate ${String(g2.id)} at (${String(g2.at.x)}, ${String(g2.at.z)}) does not connect the interiors of district ${String(gi.fa)} and ${String(gi.fb)}: its approach cells lie in sealed pockets`);
            continue;
        }
        if (ma === mb) { rep.add("gate", `gate ${String(g2.id)} joins a region to itself`); continue; }
        union(ma, mb);
        const lo = Math.min(g2.between[0], g2.between[1]);
        const hi = Math.max(g2.between[0], g2.between[1]);
        gatePairs.add(`${String(lo)}-${String(hi)}`);
        if (lo === 0) { outerGates++; outerPerDistrict[hi]++; }
    }
    {
        const root = find(mainComp[1]);
        for (let d = 2; d <= n; d++) if (mainComp[d] >= 0 && find(mainComp[d]) !== root) rep.add("ring", `district ${String(d)} is not connected to district 1 through gates`);
    }
    // adjacency and ring
    const adjacency = /** @type {Set<string>} */ (new Set());
    for (let j = 0; j < ch; j++) {
        yield* pace(ops, cw * 14);
        for (let i = 0; i < cw; i++) {
            const a = cells[j * cw + i];
            if (a === 0) continue;
            const r2 = i + 1 < cw ? cells[j * cw + i + 1] : 0;
            const d2 = j + 1 < ch ? cells[(j + 1) * cw + i] : 0;
            for (const b of [r2, d2]) if (b !== 0 && b !== a) adjacency.add(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`);
        }
    }
    metrics.adjacency = [...adjacency].sort();
    /** @type {string[]} */
    const ringPairs = [];
    if (n >= 3) for (let d = 1; d <= n; d++) { const e = (d % n) + 1; ringPairs.push(`${String(Math.min(d, e))}-${String(Math.max(d, e))}`); }
    for (const pair of ringPairs) {
        if (!adjacency.has(pair)) rep.add("ring", `ring districts ${pair} are not physically adjacent`);
        else if (!gatePairs.has(pair)) rep.add("ring", `ring districts ${pair} share a wall but no valid gate connects them`);
    }
    if (outerGates < opt.minOuterGates) rep.add("ring", `only ${String(outerGates)} valid outer gates, need >= ${String(opt.minOuterGates)}`);
    for (let d = 1; d <= n; d++) {
        let touchesOutside = false;
        for (let k = 0; k < cells.length && !touchesOutside; k++) {
            if ((k & 4095) === 4095) yield* pace(ops, 4096 * 3);
            if (cells[k] !== d) continue;
            const i = k % cw;
            const j = (k - i) / cw;
            if (i === 0 || j === 0 || i === cw - 1 || j === ch - 1 || cells[k - 1] === 0 || cells[k + 1] === 0 || cells[k - cw] === 0 || cells[k + cw] === 0) touchesOutside = true;
        }
        if (touchesOutside && outerPerDistrict[d] < opt.minOuterGatesPerDistrict) rep.add("ring", `district ${String(d)} faces outside but has ${String(outerPerDistrict[d])} outer gates, need >= ${String(opt.minOuterGatesPerDistrict)}`);
    }

    // ---- shape -------------------------------------------------------------------------------------------
    const totalCellsList = [];
    for (let d = 1; d <= n; d++) for (const c of cellLists[d]) totalCellsList.push(c);
    {
        let ui0 = Infinity; let ui1 = -Infinity; let uj0 = Infinity; let uj1 = -Infinity;
        let sui = 0; let suj = 0;
        yield* pace(ops, Math.min(23000, totalCellsList.length * 8));
        for (const [i, j] of totalCellsList) { if (i < ui0) ui0 = i; if (i > ui1) ui1 = i; if (j < uj0) uj0 = j; if (j > uj1) uj1 = j; sui += i; suj += j; }
        const bboxFill = totalCellsList.length / ((ui1 - ui0 + 1) * (uj1 - uj0 + 1));
        const oriented = yield* orientedFillSteps(totalCellsList, ops);
        const compactness = compactnessOf(totalArea, outerPerimeter);
        metrics.union = { bboxFill, orientedFill: oriented, compactness };
        if (bboxFill >= opt.bboxFillMax) rep.add("shape", `civilization bbox fill ${bboxFill.toFixed(3)} >= ${String(opt.bboxFillMax)} (rectangular outline)`);
        if (oriented >= opt.orientedFillMaxUnion) rep.add("shape", `civilization oriented-rectangle fill ${oriented.toFixed(3)} >= ${String(opt.orientedFillMaxUnion)} (a rotated rectangle)`);
        if (outerPerimeter > 0) {
            if (compactness > opt.compactnessMax) rep.add("shape", `civilization compactness ${compactness.toFixed(3)} > ${String(opt.compactnessMax)} (circular outline)`);
            if (compactness < opt.compactnessMin) rep.add("shape", `civilization compactness ${compactness.toFixed(3)} < ${String(opt.compactnessMin)} (stringy outline)`);
        }
        // radial variation of the outer wall about the centroid
        const cxp = x0g + (sui / totalCellsList.length) * cell + cell / 2 - rx0;
        const czp = z0g + (suj / totalCellsList.length) * cell + cell / 2 - rz0;
        if (outerPixels.length > 0) {
            let s1 = 0; let s2 = 0;
            yield* pace(ops, Math.min(23000, outerPixels.length * 10));
            for (const p of outerPixels) {
                const x = p % RW;
                const z = (p - x) / RW;
                const r = Math.hypot(x - cxp, z - czp);
                s1 += r; s2 += r * r;
            }
            const mean = s1 / outerPixels.length;
            const variance = Math.max(0, s2 / outerPixels.length - mean * mean);
            const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
            metrics.union.radialCv = cv;
            if (cv < opt.radialCvMin) rep.add("shape", `outer wall radial variation ${cv.toFixed(3)} < ${String(opt.radialCvMin)} (circular / near-regular outline)`);
        }
        const vertexCount = plan.walls.filter((/** @type {any} */ w) => w?.kind === "outer").reduce((/** @type {number} */ sum, /** @type {any} */ w) => sum + (Array.isArray(w.path) ? w.path.length : 0), 0);
        if (vertexCount < 12) rep.add("shape", `outer wall has only ${String(vertexCount)} vertices; too regular to be an irregular outline`);
        const sym = yield* symmetrySteps(cells, cw, ch, false, ops);
        const symL = yield* symmetrySteps(cells, cw, ch, true, ops);
        metrics.union.symmetry = sym;
        metrics.union.labelSymmetry = symL;
        if (sym.score > opt.symmetryMax) rep.add("shape", `civilization outline is ${(sym.score * 100).toFixed(0)}% ${sym.transform}-symmetric (> ${String(opt.symmetryMax * 100)}%)`);
        if (symL.score > opt.symmetryMax) rep.add("shape", `district layout is ${(symL.score * 100).toFixed(0)}% ${symL.transform}-symmetric (> ${String(opt.symmetryMax * 100)}%)`);
        // command HQ not at the centre
        const cmd = distBy[1];
        if (cmd?.hq && isInt(cmd.hq.x) && isInt(cmd.hq.z)) {
            const ccx = x0g + (sui / totalCellsList.length) * cell + cell / 2;
            const ccz = z0g + (suj / totalCellsList.length) * cell + cell / 2;
            const bcx = x0g + ((ui0 + ui1 + 1) / 2) * cell;
            const bcz = z0g + ((uj0 + uj1 + 1) / 2) * cell;
            const dc = Math.hypot(cmd.hq.x - ccx, cmd.hq.z - ccz);
            const db = Math.hypot(cmd.hq.x - bcx, cmd.hq.z - bcz);
            metrics.hqOffset = { centroid: Math.round(dc), bboxCentre: Math.round(db) };
            if (dc < opt.hqMinOffset) rep.add("hq", `command HQ (${String(cmd.hq.x)}, ${String(cmd.hq.z)}) is only ${dc.toFixed(0)} blocks from the civilization centroid (${ccx.toFixed(0)}, ${ccz.toFixed(0)}), need >= ${String(opt.hqMinOffset)}`);
            if (db < opt.hqMinOffset) rep.add("hq", `command HQ is only ${db.toFixed(0)} blocks from the civilization bbox centre, need >= ${String(opt.hqMinOffset)}`);
        }
    }
    /** @type {{ compactness: number, bboxFill: number, orientedFill: number, aspect: number, ecc: number }[]} */
    const desc = [];
    for (let d = 1; d <= n; d++) {
        const bw = (maxI[d] - minI[d] + 1);
        const bh = (maxJ[d] - minJ[d] + 1);
        const fill = cellCount[d] / (bw * bh);
        const oriented = yield* orientedFillSteps(cellLists[d], ops);
        const entry = distBy[d];
        let comp = 0;
        if (entry && Array.isArray(entry.outline) && entry.outline.length >= 3) {
            const o = entry.outline;
            const closedRepeat = o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1];
            const poly = closedRepeat ? o.slice(0, -1) : o;
            comp = compactnessOf(polygonAreaOf(poly), polygonPerimeterOf(poly));
        }
        // second moments for eccentricity
        const mi = sumI[d] / cellCount[d];
        const mj = sumJ[d] / cellCount[d];
        let sxx = 0; let szz = 0; let sxz = 0;
        yield* pace(ops, Math.min(23000, cellLists[d].length * 14));
        for (const [i, j] of cellLists[d]) { sxx += (i - mi) ** 2; szz += (j - mj) ** 2; sxz += (i - mi) * (j - mj); }
        sxx /= cellCount[d]; szz /= cellCount[d]; sxz /= cellCount[d];
        const tr = sxx + szz;
        const det = sxx * szz - sxz * sxz;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l1 = tr / 2 + disc;
        const l2 = Math.max(1e-9, tr / 2 - disc);
        const ecc = Math.sqrt(1 - l2 / l1);
        const aspect = Math.min(bw, bh) / Math.max(bw, bh);
        desc.push({ compactness: comp, bboxFill: fill, orientedFill: oriented, aspect, ecc });
        const tag = `district-${String(d)}`;
        if (fill >= opt.bboxFillMax) rep.add("shape", `${tag} bbox fill ${fill.toFixed(3)} >= ${String(opt.bboxFillMax)} (rectangular)`);
        if (oriented >= opt.orientedFillMaxDistrict) rep.add("shape", `${tag} oriented-rectangle fill ${oriented.toFixed(3)} >= ${String(opt.orientedFillMaxDistrict)} (a rotated rectangle)`);
        if (comp > 0 && comp > opt.compactnessMax) rep.add("shape", `${tag} compactness ${comp.toFixed(3)} > ${String(opt.compactnessMax)} (circular)`);
        if (comp > 0 && comp < opt.compactnessMin) rep.add("shape", `${tag} compactness ${comp.toFixed(3)} < ${String(opt.compactnessMin)} (stringy)`);
    }
    metrics.districts = desc;
    for (let a = 1; a <= n; a++) {
        for (let b = a + 1; b <= n; b++) {
            const cg = yield* congruenceSteps(cellLists[a], cellLists[b], ops);
            if (cg.exact || cg.iou >= opt.congruenceIou) rep.add("shape", `district-${String(a)} and district-${String(b)} outlines are congruent under rotation/reflection (best IoU ${cg.iou.toFixed(3)}${cg.exact ? ", exact" : ""})`);
            const da = desc[a - 1];
            const db = desc[b - 1];
            let maxDiff = 0;
            for (const key of /** @type {const} */ (["compactness", "bboxFill", "orientedFill", "aspect", "ecc"])) {
                const x = da[key];
                const y = db[key];
                const diff = Math.abs(x - y) / Math.max(x, y, 1e-9);
                if (diff > maxDiff) maxDiff = diff;
            }
            if (maxDiff < opt.descriptorMinDiff) rep.add("shape", `district-${String(a)} and district-${String(b)} have indistinguishable shape descriptors (max relative difference ${maxDiff.toFixed(4)})`);
        }
    }

    // ---- roads -------------------------------------------------------------------------------------------
    const roadAll = new Uint8Array(N);
    let roadLength = 0;
    /** @type {Set<string>} */
    const roadIds = new Set();
    /** @type {number[]} gate centres as raster indices for outside tolerance */
    const gateCentres = gateInfo.filter((gi) => gi.at >= 0).map((gi) => gi.at);
    for (const road of plan.roads) {
        yield* pace(ops, 200);
        const tag = `road ${String(road?.id)}`;
        if (!road || typeof road.id !== "string") { rep.add("road", "road without string id"); continue; }
        if (roadIds.has(road.id)) rep.add("road", `duplicate road id ${road.id}`);
        roadIds.add(road.id);
        if (!isInt(road.district) || road.district < 1 || road.district > n) { rep.add("road", `${tag} district ${String(road.district)} invalid`); continue; }
        if (!isInt(road.width) || road.width < 1 || road.width > 9) { rep.add("road", `${tag} width ${String(road.width)} must be 1..9`); continue; }
        if (!Array.isArray(road.path) || road.path.length < 2 || !road.path.every(isPoint)) { rep.add("road", `${tag} path must be >= 2 integer points`); continue; }
        if (!["arterial", "street", "link"].includes(road.kind)) rep.add("road", `${tag} kind ${String(road.kind)} invalid`);
        yield* pace(ops, Math.min(23000, rasterCost(road.path) * 14 + 100));
        const raster = rasterizePolyline(road.path, false);
        roadLength += raster.length;
        yield* pace(ops, Math.min(23000, raster.length * 40));
        /** @type {number[][]} */
        const local = [];
        let crossings = 0;
        let strays = 0;
        for (const [x, z] of raster) {
            if (!inRaster(x, z)) { rep.add("road", `${tag} pixel (${String(x)}, ${String(z)}) is outside the plan raster`); break; }
            const p = pidx(x, z);
            local.push([p % RW, Math.floor(p / RW)]);
            if (W[p] === 1 && G[p] === 0 && crossings++ === 0) rep.add("road", `${tag} crosses or lies in a wall at (${String(x)}, ${String(z)}) without a gate`);
            const l = labelB[p];
            if (interiorLeak[p] === 1 && l !== road.district && G[p] === 0) {
                let nearGate = false;
                for (const c of gateCentres) if (Math.max(Math.abs(px(c) - x), Math.abs(pz(c) - z)) <= 14) { nearGate = true; break; }
                if (!nearGate && strays++ === 0) rep.add("road", `${tag} (district ${String(road.district)}) runs into ${l === 0 ? "the outside" : `district ${String(l)}`} at (${String(x)}, ${String(z)})`);
            }
        }
        yield* stampSquareSteps(roadAll, RW, RH, local, Math.floor(road.width / 2), ops);
    }
    metrics.roadLength = roadLength;
    // reachability per district: HQ and every gate touching the district must share a road component
    for (let d = 1; d <= n; d++) {
        const entry = distBy[d];
        if (!entry?.hq || !isInt(entry.hq.x) || !isInt(entry.hq.z) || !inRaster(entry.hq.x, entry.hq.z)) continue;
        const open = new Uint8Array(N);
        for (let p = 0; p < N; p++) {
            if ((p & 4095) === 4095) yield* pace(ops, 4096 * 6);
            if (roadAll[p] === 1 && W[p] === 0 && (labelB[p] === d || interiorLeak[p] === 0)) open[p] = 1;
        }
        // gate openings of this district count as road
        for (const gi of gateInfo) {
            if (!gi.ok || !Array.isArray(gi.gate.between) || !gi.gate.between.includes(d)) continue;
            const { x, z } = gi.gate.at;
            const spanX = opt.gateAxisIsTravel ? gi.gate.axis === "z" : gi.gate.axis === "x";
            for (let a = -half; a <= half; a++) for (let b = -thickHalf; b <= thickHalf; b++) {
                const ox = spanX ? x + a : x + b;
                const oz = spanX ? z + b : z + a;
                if (inRaster(ox, oz)) open[pidx(ox, oz)] = 1;
            }
        }
        const blocked = new Uint8Array(N);
        for (let p = 0; p < N; p++) {
            if ((p & 4095) === 4095) yield* pace(ops, 4096 * 2);
            blocked[p] = open[p] === 1 ? 0 : 1;
        }
        const rc = yield* labelComponentsSteps(blocked, RW, RH, true, ops);
        const hqp = pidx(entry.hq.x, entry.hq.z);
        /** @type {Set<number>} */
        const hqComps = new Set();
        const hx = hqp % RW;
        const hz = (hqp - hx) / RW;
        for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
            const sx = hx + dx;
            const sz = hz + dz;
            if (sx < 0 || sz < 0 || sx >= RW || sz >= RH) continue;
            const c = rc.comp[sz * RW + sx];
            if (c >= 0) hqComps.add(c);
        }
        if (hqComps.size === 0) { rep.add("road", `district-${String(d)} HQ (${String(entry.hq.x)}, ${String(entry.hq.z)}) has no road within 4 blocks`); continue; }
        for (const gi of gateInfo) {
            if (!gi.ok || !Array.isArray(gi.gate.between) || !gi.gate.between.includes(d)) continue;
            const c = rc.comp[gi.at];
            if (c < 0 || !hqComps.has(c)) rep.add("road", `gate ${String(gi.gate.id)} at (${String(gi.gate.at.x)}, ${String(gi.gate.at.z)}) is not reachable by road from district-${String(d)} HQ`);
        }
    }

    // ---- routes ------------------------------------------------------------------------------------------
    /** @param {any} v @returns {number} */
    const districtRef = (v) => {
        if (isInt(v)) return v;
        if (typeof v === "string") { const m = /^district-(\d+)$/.exec(v); if (m) return Number(m[1]); }
        return -1;
    };
    /** @param {string} kind @param {any[]} list @returns {Set<string>} */
    const checkRoutes = (kind, list) => {
        /** @type {Set<string>} */
        const have = new Set();
        for (const route of list) {
            const from = districtRef(route?.from);
            const to = districtRef(route?.to);
            if (from < 1 || from > n || to < 1 || to > n || from === to) { rep.add("route", `${kind} route ${JSON.stringify(route)} has bad from/to`); continue; }
            if (!Array.isArray(route.gates) || route.gates.length === 0) { rep.add("route", `${kind} route ${String(from)}->${String(to)} lists no gates`); continue; }
            let cur = from;
            let good = true;
            for (const id of route.gates) {
                const gate = gateById.get(id);
                if (!gate || !Array.isArray(gate.between)) { rep.add("route", `${kind} route ${String(from)}->${String(to)} uses ${String(id)}, which is not a gate id`); good = false; break; }
                const gi = gateInfo.find((q) => q.gate === gate);
                if (!gi?.ok) { rep.add("route", `${kind} route ${String(from)}->${String(to)} uses invalid gate ${String(id)}`); good = false; break; }
                if (gate.between[0] === 0 || gate.between[1] === 0) {
                    if (kind === "reinforce") { rep.add("route", `reinforce route ${String(from)}->${String(to)} leaves the civilization through outer gate ${String(id)}`); good = false; break; }
                    rep.add("route", `evac route ${String(from)}->${String(to)} passes outer gate ${String(id)}; evac routes link districts`);
                    good = false;
                    break;
                }
                if (gate.between[0] === cur) cur = gate.between[1];
                else if (gate.between[1] === cur) cur = gate.between[0];
                else { rep.add("route", `${kind} route ${String(from)}->${String(to)} is discontinuous: gate ${String(id)} ${JSON.stringify(gate.between)} does not touch district ${String(cur)}`); good = false; break; }
            }
            if (good && cur !== to) rep.add("route", `${kind} route ${String(from)}->${String(to)} ends in district ${String(cur)}`);
            if (good) have.add(`${String(from)}>${String(to)}`);
        }
        return have;
    };
    if (plan.routes && Array.isArray(plan.routes.evac) && Array.isArray(plan.routes.reinforce)) {
        const evac = checkRoutes("evac", plan.routes.evac);
        const reinforce = checkRoutes("reinforce", plan.routes.reinforce);
        for (let d = 1; d <= n; d++) {
            let any = false;
            for (const key of evac) if (key.startsWith(`${String(d)}>`)) any = true;
            if (!any) rep.add("route", `no evac route leaves district ${String(d)}`);
        }
        for (const pair of ringPairs) {
            const [a, b] = pair.split("-").map(Number);
            if (!reinforce.has(`${String(a)}>${String(b)}`)) rep.add("route", `missing reinforce route ${String(a)}->${String(b)}`);
            if (!reinforce.has(`${String(b)}>${String(a)}`)) rep.add("route", `missing reinforce route ${String(b)}->${String(a)}`);
        }
    }
}


/**
 * Validate a CivPlan cooperatively. Returns the same object as validatePlan. Abandoning the generator midway has
 * no side effects.
 *
 * @param {any} plan a CivPlan
 * @param {Partial<ValidateOptions> & { ops?: Ops }} [options]
 * @returns {Generator<void, { ok: boolean, problems: string[], errors: string[], metrics: Obj }, void>}
 */
export function* validatePlanSteps(plan, options = {}) {
    const { ops: given, ...rest } = options;
    const ops = given ?? newOps();
    const opt = { ...VALIDATE_DEFAULTS, ...rest };
    const rep = new Report(opt.problemCap);
    /** @type {Obj} */
    const metrics = {};
    try {
        yield* runChecksSteps(plan, opt, rep, metrics, ops);
    } catch (error) {
        rep.add("internal", `validator crashed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const problems = rep.finish();
    return { ok: problems.length === 0, problems, errors: problems, metrics };
}

