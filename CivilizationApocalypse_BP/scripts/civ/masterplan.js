/**
 * Master civilization planner (Phases A + planner side of B). Pure, deterministic from (seed, anchor, field).
 *
 *   planCivilization(field, options) -> CivPlan          (throws CivPlanError when every attempt fails)
 *   planCivilizationDetailed(field, options) -> { ok, plan, errors, attempts, ops }
 *   planCivilizationAsync(field, options)   -> same, but also runs civ/validate.js when that module exists
 *   selfCheck(plan) / planShapeMetrics(plan) -> cheap checks / shape metrics reusable by tests
 *
 * Pipeline per attempt (attempt k re-seeds deterministically):
 *   terrain analysis (4-block cells) -> centre -> role-biased ring seeds -> anisotropic, noisy, terrain-cost
 *   multi-source Dijkstra with per-district area caps -> cleanup (components, holes, boundary smoothing) ->
 *   planar chains between junctions (shared by neighbours) -> smooth / straighten / simplify -> district rings ->
 *   labels re-derived from the rings -> walls, gates on straight runs, HQs, roads, routes, stats -> self-check.
 *
 * Operation count (R = search radius, default 300): <= 5*(R/2)^2 field reads (~112k), one Dijkstra of ~12k claims
 * per attempt, linear cleanup passes, ~30 road searches bounded by district size. Typical total < 1 s.
 *
 * Wall `closed` semantics (matches civ/validate.js): a wall is one chain between two junction vertices. `closed` is true only
 * for a pure ring (path repeats its first point); ordinary chains are open polylines whose both ends meet at junctions where
 * >= 3 walls share the identical end point, so together the walls form one sealed network.
 * Gate `axis` is the axis the WALL RUN extends along ("x": wall runs east-west, passage is along z).
 */

import { CELL, WORK_LIMIT, analyzeTerrainSteps, bfsSteps, chooseCentreSteps, closeSlits, fillHoles, growRegionsSteps, keepLargestComponents, makeRng, markYield, newOps, placeSeedsSteps, pruneSlivers, runSync, smoothLabels, ROLES } from "./regions.js";
import { chainsCross, districtRings, extractChainsSteps, labelsFromRings, refineChainSteps } from "./chains.js";
import { shapeProblemsSteps } from "./shapecheck.js";
import { planRoadsSteps, totalRoadLength, wallClearanceSteps } from "./roadnet.js";
import { bboxOf, compactness, convexHull, decodeLabels, encodeLabels, pathLength, polygonArea, polygonCentroid, rasterizePath, shapeDescriptor, shapeDistance, stamp, hash2 } from "./geom.js";

/** @typedef {[number, number]} Pt */
/** @typedef {import("./regions.js").HeightField} HeightField */
/** @typedef {import("./regions.js").Ops} Ops */
/** @typedef {import("./chains.js").Chain} Chain */

export const DISTRICT_NAMES = ["Hearthgate", "Ironquarry", "Whitethorn", "Saltmere", "Ashfall"];
export const RING_PAIRS = /** @type {const} */ ([[1, 2], [2, 3], [3, 4], [4, 5], [1, 5]]);

export const PLAN_LIMITS = {
    minDistrictArea: 30000,
    maxDistrictArea: 45000,
    minTotal: 175000,
    maxTotal: 200000,
    maxBboxFill: 0.8,
    maxOuterBboxFill: 0.75,
    minCompactness: 0.3,
    maxCompactness: 0.82,
    maxOuterCompactness: 0.82,
    minShapeDistance: 0.1,
    minHqCentroidDistance: 30,
    maxJsonBytes: 40000,
};

export class CivPlanError extends Error {
    /** @param {string} message @param {string[]} errors */
    constructor(message, errors) {
        super(message);
        this.name = "CivPlanError";
        this.errors = errors;
    }
}

/**
 * @typedef {object} PlanOptions
 * @property {number} [seed] default field.seed or 1
 * @property {{ x: number, z: number }} [anchor] default centre of the field bounds
 * @property {number} [radius] search radius in blocks (default 300; ~190k columns do not fit in 220)
 * @property {number} [maxAttempts] re-seeding attempts (default 16)
 * @property {Ops} [ops] caller-owned operation counters (read ops.maxRun / ops.work after planning)
 * @property {(plan: any) => { ok: boolean, errors: string[] } | string[] | null | undefined} [validate] optional external validator
 */

/** @param {number} a @param {number} lo @param {number} hi */
const clamp = (a, lo, hi) => Math.max(lo, Math.min(hi, a));

/**
 * @param {Chain[]} chains @param {number} a @param {number} b
 */
function sharedChains(chains, a, b) {
    return chains.filter((c) => (c.left === a && c.right === b) || (c.left === b && c.right === a));
}

/**
 * @param {Chain} chain
 * @returns {Array<{ mid: Pt, axis: "x" | "z", len: number, chain: Chain }>}
 */
function runSites(chain) {
    return chain.runs.map((r) => {
        const p = chain.pts[r.i0];
        const q = chain.pts[r.i1];
        /** @type {Pt} */
        const mid = r.axis === "x" ? [Math.round((p[0] + q[0]) / 2), p[1]] : [p[0], Math.round((p[1] + q[1]) / 2)];
        return { mid, axis: r.axis, len: r.len, chain };
    });
}

/**
 * One planning attempt. Returns { plan, errors } (plan null when the attempt failed structurally).
 * @param {HeightField} field @param {import("./regions.js").Terrain} t @param {number} seed
 * @param {{ x: number, z: number }} anchor @param {number} attempt @param {Ops} ops
 * @returns {Generator<void, { plan: any | null, errors: string[] }, void>}
 */
function* attemptPlan(field, t, seed, anchor, attempt, ops) {
    void field;
    const salt = (seed ^ Math.imul(attempt + 7, 0x85ebca6b)) >>> 0;
    const rng = makeRng(salt);
    const { w, h } = t;
    const centre = yield* chooseCentreSteps(t, anchor, salt, ops);
    const rs = 235;
    const placed = yield* placeSeedsSteps(t, centre, seed, attempt, rs, ops);
    if (!placed) return { plan: null, errors: ["no seed placement"] };
    const cc = { x: t.x0 + centre.i * CELL + 2, z: t.z0 + centre.j * CELL + 2 };

    // area targets (block columns) and growth parameters
    const totalTarget = 182000 + rng() * 14000;
    const weights = [0, 1, 2, 3, 4].map(() => 0.9 + rng() * 0.2);
    const wsum = weights.reduce((s, v) => s + v, 0);
    const capCells = weights.map((v) => Math.round(clamp((totalTarget * v) / wsum, 34500, 40500) / (CELL * CELL)));
    const aspects = [1.0, 1.4, 1.75, 2.1, 1.2].sort(() => rng() - 0.5).map((a) => a * (0.92 + rng() * 0.16));
    const angles = [0, 1, 2, 3, 4].map(() => rng() * Math.PI);
    const noiseSeed = [0, 1, 2, 3, 4].map((k) => (salt + k * 977) | 0);
    const corridor = placed.seeds.map((s, k) => {
        if (rng() < 0.15) return null;
        const sx = t.x0 + s.i * CELL + 2;
        const sz = t.z0 + s.j * CELL + 2;
        const out = Math.atan2(sz - cc.z, sx - cc.x) + (rng() - 0.5) * 1.2;
        void k;
        return { dx: Math.cos(out), dz: Math.sin(out), len: 70 + rng() * 60 };
    });

    const grown = yield* growRegionsSteps(t, placed.seeds, { capCells, aspect: aspects, angle: angles, noiseSeed, corridor }, ops);
    const labels = grown.labels;
    for (let r = 0; r < 5; r += 1) {
        if (grown.counts[r + 1] < capCells[r] * 0.93) return { plan: null, errors: [`district ${String(r + 1)} starved (${String(grown.counts[r + 1])}/${String(capCells[r])} cells)`] };
    }
    for (let pass = 0; pass < 2; pass += 1) {
        ops.cleanupPasses += 1;
        yield* keepLargestComponents(labels, w, h, ops);
        if ((yield* fillHoles(labels, w, h, ops)) > 700) return { plan: null, errors: ["large enclosed hole"] };
        yield* smoothLabels(labels, w, h, 2, ops);
        yield* closeSlits(labels, t.crossable, w, h, 2, ops);
        yield* pruneSlivers(labels, w, h, ops);
    }
    yield* keepLargestComponents(labels, w, h, ops);
    yield* fillHoles(labels, w, h, ops);

    // chains
    const raw = yield* extractChainsSteps(labels, w, h, t.x0, t.z0, ops);
    for (const c of raw) yield* refineChainSteps(c, ops);
    const chains = raw;
    if (yield* chainsCross(chains, ops)) return { plan: null, errors: ["chains cross after smoothing"] };

    // endpoints must be junctions (>= 3 chain ends) for a sealed network
    /** @type {Map<string, number>} */
    const endCount = new Map();
    for (const c of chains) {
        if (c.closed) continue;
        for (const p of [c.pts[0], c.pts[c.pts.length - 1]]) {
            const k = `${String(p[0])},${String(p[1])}`;
            endCount.set(k, (endCount.get(k) ?? 0) + 1);
        }
    }
    for (const c of chains) {
        if (c.closed) continue;
        for (const p of [c.pts[0], c.pts[c.pts.length - 1]]) {
            if ((endCount.get(`${String(p[0])},${String(p[1])}`) ?? 0) < 3) return { plan: null, errors: ["wall end is not a junction"] };
        }
    }

    /** @type {Pt[][]} */
    const rings = [];
    for (let d = 1; d <= 5; d += 1) {
        const rs2 = districtRings(chains, d);
        if (rs2.length !== 1 || rs2[0].length < 8) return { plan: null, errors: [`district ${String(d)} has ${String(rs2.length)} rings`] };
        rings.push(rs2[0]);
    }
    const finalLabels = yield* labelsFromRings(rings, w, h, t.x0, t.z0, ops);
    {
        const probe = finalLabels.slice();
        if ((yield* keepLargestComponents(probe, w, h, ops)) > 0) return { plan: null, errors: ["a district is disconnected after smoothing"] };
        if ((yield* fillHoles(probe, w, h, ops)) > 0) return { plan: null, errors: ["enclosed unlabelled hole after smoothing"] };
    }

    // ring adjacency + straight runs
    for (const [a, b] of RING_PAIRS) {
        const sc = sharedChains(chains, a, b);
        const len = sc.reduce((s, c) => s + c.length, 0);
        if (len < 36) return { plan: null, errors: [`ring pair ${String(a)}-${String(b)} not adjacent (${String(Math.round(len))} blocks)`] };
        if (!sc.some((c) => c.runs.length > 0)) return { plan: null, errors: [`ring pair ${String(a)}-${String(b)} has no straight run`] };
    }

    // district records
    let csx = 0;
    let csz = 0;
    let csn = 0;
    let a0 = w; let a1 = -1; let b0 = h; let b1 = -1;
    const areaCells = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < h; j += 1) {
        ops.work += w * 2;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 0; i < w; i += 1) {
            const l = finalLabels[j * w + i];
            if (!l) continue;
            csx += t.x0 + i * CELL + 2; csz += t.z0 + j * CELL + 2; csn += 1;
            if (i < a0) a0 = i; if (i > a1) a1 = i; if (j < b0) b0 = j; if (j > b1) b1 = j;
            areaCells[l] += 1;
        }
    }
    const civCentroid = { x: csx / Math.max(1, csn), z: csz / Math.max(1, csn) };
    const civBox = { x: t.x0 + ((a0 + a1 + 1) / 2) * CELL, z: t.z0 + ((b0 + b1 + 1) / 2) * CELL };
    const distOut = yield* bfsSteps(w, h, (idx) => finalLabels[idx] === 0, 60, ops);
    /** @type {Array<any>} */
    const districts = [];
    for (let d = 1; d <= 5; d += 1) {
        const ring = rings[d - 1];
        const area = areaCells[d] * CELL * CELL;
        const cen = polygonCentroid(ring);
        const inner = yield* bfsSteps(w, h, (idx) => finalLabels[idx] !== d, 12, ops);
        let cells = 0;
        let dMinI = Infinity; let dMaxI = -Infinity; let dMinJ = Infinity; let dMaxJ = -Infinity; let dSumI = 0; let dSumJ = 0;
        let depthSum = 0;
        let bestScore = -Infinity;
        /** @type {Pt} */
        let hq = [Math.round(cen.x), Math.round(cen.z)];
        const role = ROLES[d - 1];
        for (let j = 0; j < h; j += 1) {
            ops.work += w * 4;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            for (let i = 0; i < w; i += 1) {
                const idx = j * w + i;
                if (finalLabels[idx] !== d) continue;
                cells += 1;
                if (i < dMinI) dMinI = i;
                if (i > dMaxI) dMaxI = i;
                if (j < dMinJ) dMinJ = j;
                if (j > dMaxJ) dMaxJ = j;
                dSumI += i;
                dSumJ += j;
                depthSum += distOut[idx];
                if (inner[idx] < 4 || !t.passable[idx]) continue;
                const x = t.x0 + i * CELL + 2;
                const z = t.z0 + j * CELL + 2;
                const flat = 1 - Math.min(1, t.rough[idx] / 4);
                const interior = Math.min(inner[idx], 8) / 8;
                let s = 0.3 * flat + 0.2 * interior;
                if (role === "command") s += 0.4 * t.elevPct[idx] + 0.1 * Math.min(1, t.distBlocked[idx] / 6);
                else if (role === "industrial") s += 0.3 * Math.min(1, t.rough[idx] / 3) + 0.1 * (1 - interior);
                else if (role === "agricultural") s += 0.3 * flat;
                else if (role === "commercial") s += 0.3 * (t.hasWater ? Math.max(0, 1 - t.waterDist[idx] / 16) : 1 - interior);
                else s += 0.3 * (t.shelter[idx] + 1) / 2;
                s += 0.12 * hash2(i, j, seed + d * 31);
                if (Math.hypot(x - cen.x, z - cen.z) < 14) s -= 0.35;
                if (Math.hypot(x - civCentroid.x, z - civCentroid.z) < 45 || Math.hypot(x - civBox.x, z - civBox.z) < 45) s -= 0.5;
                if (s > bestScore) { bestScore = s; hq = [x, z]; }
            }
        }
        if (bestScore === -Infinity) return { plan: null, errors: [`district ${String(d)} has no HQ site`] };
        districts.push({
            index: d, id: `district-${String(d)}`, name: DISTRICT_NAMES[d - 1], role, area, cells,
            centroid: { x: Math.round(t.x0 + (dSumI / Math.max(1, cells)) * CELL + CELL / 2), z: Math.round(t.z0 + (dSumJ / Math.max(1, cells)) * CELL + CELL / 2) }, hq: { x: hq[0], z: hq[1] },
            bbox: { x0: t.x0 + dMinI * CELL, z0: t.z0 + dMinJ * CELL, x1: t.x0 + (dMaxI + 1) * CELL - 1, z1: t.z0 + (dMaxJ + 1) * CELL - 1 },
            outline: ring.map((p) => [p[0], p[1]]),
            _depth: depthSum / Math.max(1, cells),
        });
    }

    // walls
    /** @type {Map<number, string>} */
    const wallIdOf = new Map();
    const walls = chains.map((c, ci) => {
        const outer = c.left === 0 || c.right === 0;
        const between = outer ? [Math.max(c.left, c.right), 0] : [Math.min(c.left, c.right), Math.max(c.left, c.right)];
        const id = `wall-${String(ci + 1)}`;
        wallIdOf.set(c.id, id);
        return { id, kind: outer ? "outer" : "shared", between, closed: c.closed, path: c.pts.map((p) => [p[0], p[1]]), thickness: 3 };
    });
    /** @type {Pt[]} */
    const wallPixels = [];
    for (const c of chains) {
        ops.work += c.length * 1.5 + 10;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (const p of rasterizePath(c.pts, c.closed)) wallPixels.push(p);
    }

    // gates
    /** @param {number} x @param {number} z */
    const labelBlock = (x, z) => {
        const i = Math.floor((x - t.x0) / CELL);
        const j = Math.floor((z - t.z0) / CELL);
        return i < 0 || j < 0 || i >= w || j >= h ? 0 : finalLabels[j * w + i];
    };
    /** both sides of a gate site (6, 12 and 16 blocks across the wall) must be exactly districts a and b @param {{ mid: Pt, axis: "x"|"z" }} site @param {number} a @param {number} b */
    const sidesOk = (site, a, b) => [6, 12, 16].every((s) => {
        const p = site.axis === "x" ? [labelBlock(site.mid[0], site.mid[1] - s), labelBlock(site.mid[0], site.mid[1] + s)] : [labelBlock(site.mid[0] - s, site.mid[1]), labelBlock(site.mid[0] + s, site.mid[1])];
        return (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a);
    });
    /** @type {any[]} */
    const gates = [];
    /** @type {Pt[]} */
    const gateSpots = [];
    /** @param {Pt} p @param {number} minDist */
    const farFromGates = (p, minDist) => gateSpots.every((g) => Math.hypot(g[0] - p[0], g[1] - p[1]) >= minDist);
    /** @param {Chain} chain @param {{ mid: Pt, axis: "x"|"z" }} site @param {number} a @param {number} b @param {string} purpose */
    const addGate = (chain, site, a, b, purpose) => {
        gates.push({ id: `gate-${String(gates.length + 1)}`, wallId: /** @type {string} */ (wallIdOf.get(chain.id)), at: { x: site.mid[0], z: site.mid[1] }, axis: site.axis, width: 5, between: [a, b], purpose });
        gateSpots.push(site.mid);
    };
    for (const [a, b] of RING_PAIRS) {
        const sites = sharedChains(chains, a, b).flatMap(runSites).filter((s) => sidesOk(s, a, b));
        if (sites.length === 0) return { plan: null, errors: [`ring pair ${String(a)}-${String(b)} has no wide-enough straight run`] };
        const ha = districts[a - 1].hq;
        const hb = districts[b - 1].hq;
        const target = { x: (ha.x + hb.x) / 2, z: (ha.z + hb.z) / 2 };
        sites.sort((p, q) => (Math.hypot(p.mid[0] - target.x, p.mid[1] - target.z) - p.len) - (Math.hypot(q.mid[0] - target.x, q.mid[1] - target.z) - q.len));
        const first = sites[0];
        addGate(first.chain, first, a, b, "main");
        const second = sites.find((s) => Math.hypot(s.mid[0] - first.mid[0], s.mid[1] - first.mid[1]) >= 60 && farFromGates(s.mid, 40));
        if (second && sharedChains(chains, a, b).reduce((s, c) => s + c.length, 0) >= 160) addGate(second.chain, second, a, b, "reinforce");
    }
    for (let d = 1; d <= 5; d += 1) {
        const sites = chains.filter((c) => (c.left === d && c.right === 0) || (c.right === d && c.left === 0)).flatMap(runSites).filter((s) => sidesOk(s, d, 0));
        sites.sort((p, q) => q.len - p.len);
        const first = sites.find((s) => farFromGates(s.mid, 30));
        if (!first) {
            if (sites.length === 0 && chains.some((c) => (c.left === d && c.right === 0) || (c.right === d && c.left === 0))) return { plan: null, errors: [`district ${String(d)} has no wide outer gate site (outer chains ${chains.filter((c) => (c.left === d && c.right === 0) || (c.right === d && c.left === 0)).map((c) => `${String(Math.round(c.length))}/${String(c.runs.length)}`).join(",")})`] };
            continue;
        }
        addGate(first.chain, first, d, 0, d === 3 ? "field" : "evac");
        const second = sites.find((s) => farFromGates(s.mid, 30) && Math.hypot(s.mid[0] - first.mid[0], s.mid[1] - first.mid[1]) >= 45);
        if (second) addGate(second.chain, second, d, 0, d === 3 ? "field" : d === 5 ? "evac" : "main");
    }

    // roads
    const wallMask = yield* wallClearanceSteps(t, wallPixels, 6, ops);
    const roadResult = yield* planRoadsSteps({
        terrain: t, labels: finalLabels,
        hqs: districts.map((q) => ({ d: q.index, x: q.hq.x, z: q.hq.z })),
        gates: gates.map((g) => ({ id: g.id, at: g.at, axis: g.axis, between: g.between })),
        wallMask, seed: salt, ops,
    });
    if (roadResult.fallbacks > 0) return { plan: null, errors: [`${String(roadResult.fallbacks)} road searches failed`] };

    // routes
    /** @param {number} a @param {number} b */
    const gateBetween = (a, b) => gates.find((g) => (g.between[0] === a && g.between[1] === b) || (g.between[0] === b && g.between[1] === a));
    const evac = [];
    for (let d = 1; d <= 5; d += 1) {
        const mine = districts[d - 1]._depth;
        const neigh = [];
        for (let o = 1; o <= 5; o += 1) if (o !== d && gateBetween(d, o)) neigh.push(o);
        neigh.sort((p, q) => districts[q - 1]._depth - districts[p - 1]._depth);
        const safer = neigh.filter((o) => districts[o - 1]._depth > mine);
        const targets = safer.length > 0 ? safer : neigh.slice(0, 1);
        for (const o of targets) evac.push({ from: d, to: o, gates: [/** @type {any} */ (gateBetween(d, o)).id] });
    }
    const reinforce = [];
    for (const [a, b] of RING_PAIRS) {
        const g = /** @type {any} */ (gateBetween(a, b));
        reinforce.push({ from: a, to: b, gates: [g.id] }, { from: b, to: a, gates: [g.id] });
    }

    // grid trim + labels
    let i0 = w; let i1 = -1; let j0 = h; let j1 = -1;
    for (let j = 0; j < h; j += 1) {
        ops.work += w;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 0; i < w; i += 1) if (finalLabels[j * w + i]) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    }
    i0 = Math.max(0, i0 - 2); j0 = Math.max(0, j0 - 2); i1 = Math.min(w - 1, i1 + 2); j1 = Math.min(h - 1, j1 + 2);
    const gw = i1 - i0 + 1;
    const gh = j1 - j0 + 1;
    const trimmed = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j += 1) {
        ops.work += gw;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        for (let i = 0; i < gw; i += 1) trimmed[j * gw + i] = finalLabels[(j + j0) * w + i + i0];
    }

    const perimeters = rings.map((r) => pathLength(r, true));
    const stats = {
        totalArea: districts.reduce((s, q) => s + q.area, 0),
        perDistrictArea: districts.map((q) => q.area),
        compactness: districts.map((q, k) => Math.round(compactness(q.area, perimeters[k]) * 1000) / 1000),
        bboxFill: districts.map((q) => Math.round((q.area / Math.max(1, (q.bbox.x1 - q.bbox.x0 + 1) * (q.bbox.z1 - q.bbox.z0 + 1))) * 1000) / 1000),
        wallLength: Math.round(chains.reduce((s, c) => s + c.length, 0)),
        gateCount: gates.length,
        roadLength: Math.round(totalRoadLength(roadResult.roads)),
    };
    for (const q of districts) delete q._depth;
    ops.work += 4000;
    if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
    const plan = JSON.parse(JSON.stringify({
        version: 1, seed, anchor: { x: Math.round(anchor.x), z: Math.round(anchor.z) }, cell: CELL,
        grid: { x0: t.x0 + i0 * CELL, z0: t.z0 + j0 * CELL, w: gw, h: gh },
        labels: encodeLabels(trimmed), districts, walls, gates,
        roads: roadResult.roads, routes: { evac, reinforce }, stats,
    }));
    const errors = yield* selfCheckSteps(plan, ops);
    return { plan, errors };
}

/**
 * Shape metrics of a plan (districts and the union outline), used by the planner self-check and the tests.
 * @param {any} plan @param {Ops} ops
 * @returns {Generator<void, any, void>}
 */
export function* planShapeMetricsSteps(plan, ops) {
    /** @type {any[]} */
    const descs = [];
    for (const d of plan.districts) {
        ops.work += 4000;
        if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
        descs.push(shapeDescriptor(d.outline));
    }
    /** @type {number[][]} */
    const dist = descs.map((/** @type {any} */ a) => descs.map((/** @type {any} */ b) => shapeDistance(a, b)));
    let minPair = Infinity;
    for (let a = 0; a < descs.length; a += 1) for (let b = a + 1; b < descs.length; b += 1) minPair = Math.min(minPair, dist[a][b]);
    // outer outline from the label grid: all cells with a non-zero label, convex-hull-free polygon via outer walls
    const outerPts = plan.walls.filter((/** @type {any} */ wall) => wall.kind === "outer").flatMap((/** @type {any} */ wall) => wall.path);
    ops.work += outerPts.length * 12;
    if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
    const hull = convexHull(outerPts);
    const total = plan.stats.totalArea;
    const bb = /** @type {import("./geom.js").BBox} */ (bboxOf(outerPts));
    const outerPerimeter = plan.walls.filter((/** @type {any} */ wall) => wall.kind === "outer").reduce((/** @type {number} */ s, /** @type {any} */ wall) => s + pathLength(wall.path, false), 0);
    return {
        descriptors: descs,
        distances: dist,
        minPairDistance: minPair,
        outerBboxFill: total / Math.max(1, (bb.x1 - bb.x0) * (bb.z1 - bb.z0)),
        outerCompactness: compactness(total, outerPerimeter),
        outerSolidity: total / Math.max(1, polygonArea(hull)),
    };
}

/**
 * Synchronous shape metrics. @param {any} plan
 */
export function planShapeMetrics(plan) {
    return runSync(planShapeMetricsSteps(plan, newOps()));
}

/**
 * Cheap structural + shape self-check. Returns a list of problems (empty when fine).
 * @param {any} plan @param {Ops} ops
 * @returns {Generator<void, string[], void>}
 */
export function* selfCheckSteps(plan, ops) {
    /** @type {string[]} */
    const errors = [];
    const L = PLAN_LIMITS;
    if (plan.districts.length !== 5) errors.push("district count");
    for (const d of plan.districts) {
        if (d.area < L.minDistrictArea || d.area > L.maxDistrictArea) errors.push(`${d.id} area ${String(d.area)}`);
    }
    const total = plan.stats.totalArea;
    if (total < L.minTotal || total > L.maxTotal) errors.push(`total area ${String(total)}`);
    const hasLabels = Array.isArray(plan.labels) && plan.grid && plan.grid.w > 0;
    if (hasLabels) {
        // the validator's shape rules (cooperative replica, see shapecheck.js) decide shape quality
        const shape = yield* shapeProblemsSteps({
            labels: decodeLabels(plan), cw: plan.grid.w, ch: plan.grid.h, cell: plan.cell ?? CELL, gx0: plan.grid.x0, gz0: plan.grid.z0,
            outlines: plan.districts.map((/** @type {any} */ d) => d.outline), totalArea: total,
            outerWalls: plan.walls.filter((/** @type {any} */ wall) => wall.kind === "outer"), cmdHq: plan.districts[0].hq,
        }, ops);
        for (const p of shape.problems) errors.push(`[shape] ${p}`);
    } else {
        plan.stats.bboxFill.forEach((/** @type {number} */ f, /** @type {number} */ k) => { if (f >= L.maxBboxFill) errors.push(`district ${String(k + 1)} bboxFill ${String(f)}`); });
        plan.stats.compactness.forEach((/** @type {number} */ f, /** @type {number} */ k) => { if (f < L.minCompactness || f > L.maxCompactness) errors.push(`district ${String(k + 1)} compactness ${String(f)}`); });
        const m = yield* planShapeMetricsSteps(plan, ops);
        if (m.outerBboxFill >= L.maxOuterBboxFill) errors.push(`outer bboxFill ${m.outerBboxFill.toFixed(2)}`);
        if (m.outerCompactness > L.maxOuterCompactness) errors.push(`outer compactness ${m.outerCompactness.toFixed(2)}`);
        if (m.minPairDistance < L.minShapeDistance) errors.push(`shapes too similar ${m.minPairDistance.toFixed(3)}`);
    }
    /** @type {Map<string, number>} */
    const ends = new Map();
    for (const wall of plan.walls) {
        if (typeof wall.closed !== "boolean") errors.push(`${wall.id} closed flag`);
        const a = wall.path[0];
        const b = wall.path[wall.path.length - 1];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        for (const p of [a, b]) ends.set(p.join(","), (ends.get(p.join(",")) ?? 0) + 1);
    }
    for (const [k, c] of ends) if (c < 3) errors.push(`wall end ${k} is dangling`);
    for (const [a, b] of RING_PAIRS) {
        if (!plan.gates.some((/** @type {any} */ g) => g.between.includes(a) && g.between.includes(b))) errors.push(`no gate ${String(a)}-${String(b)}`);
    }
    if (hasLabels) return errors;
    const cmd = plan.districts[0];
    const cx = plan.districts.reduce((/** @type {number} */ s, /** @type {any} */ d) => s + d.centroid.x * d.area, 0) / Math.max(1, total);
    const cz = plan.districts.reduce((/** @type {number} */ s, /** @type {any} */ d) => s + d.centroid.z * d.area, 0) / Math.max(1, total);
    if (Math.hypot(cmd.hq.x - cx, cmd.hq.z - cz) < L.minHqCentroidDistance) errors.push("command HQ at civilization centroid");
    const allPts = plan.walls.flatMap((/** @type {any} */ wall) => wall.path);
    const bb = bboxOf(allPts);
    if (bb && Math.hypot(cmd.hq.x - (bb.x0 + bb.x1) / 2, cmd.hq.z - (bb.z0 + bb.z1) / 2) < 30) errors.push("command HQ at civilization bbox centre");
    return errors;
}

/**
 * Synchronous self-check (drives selfCheckSteps). @param {any} plan @returns {string[]}
 */
export function selfCheck(plan) {
    return runSync(selfCheckSteps(plan, newOps()));
}

/**
 * THE planning implementation: a cooperative generator that yields at least every WORK_LIMIT (20,000) elementary
 * operations and returns the detailed result (no throw). Everything else (planCivilization, ...Detailed, ...Async)
 * drives this. Abandoning the generator midway has no side effects (it only mutates local arrays and `options.ops`).
 * The optional `options.validate` hook is called synchronously once per otherwise-successful attempt.
 * @param {HeightField & { seed?: number }} field @param {PlanOptions} [options]
 * @returns {Generator<void, { ok: boolean, plan: any | null, errors: string[], history: string[], attempts: number, ops: Ops }, void>}
 */
export function* planCivilizationDetailedSteps(field, options = {}) {
    const seed = (options.seed ?? field.seed ?? 1) | 0;
    const b = field.bounds;
    const anchor = options.anchor ?? { x: Math.round((b.x0 + b.x1) / 2), z: Math.round((b.z0 + b.z1) / 2) };
    const radius = Math.min(options.radius ?? 300, 340);
    const maxAttempts = options.maxAttempts ?? 16;
    const ops = options.ops ?? newOps();
    const t = yield* analyzeTerrainSteps(field, anchor, radius, ops);
    /** @type {string[]} */
    let lastErrors = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        ops.attempts = attempt + 1;
        const res = yield* attemptPlan(field, t, seed, anchor, attempt, ops);
        let errors = res.errors;
        if (res.plan && errors.length === 0) {
            ops.work += 3000;
            if (ops.work - ops.lastYield >= WORK_LIMIT) { markYield(ops); yield; }
            const json = JSON.stringify(res.plan);
            if (json.length > PLAN_LIMITS.maxJsonBytes) errors = [`plan too large (${String(json.length)} bytes)`];
            else if (options.validate) {
                const v = options.validate(res.plan);
                if (Array.isArray(v)) errors = v;
                else if (v && !v.ok) errors = v.errors;
            }
        }
        if (res.plan && errors.length === 0) {
            markYield(ops);
            return { ok: true, plan: res.plan, errors: [], history: lastErrors, attempts: attempt + 1, ops };
        }
        lastErrors = lastErrors.concat(errors.map((e) => `attempt ${String(attempt)}: ${e}`));
    }
    markYield(ops);
    return { ok: false, plan: null, errors: lastErrors, history: lastErrors, attempts: maxAttempts, ops };
}

/**
 * Cooperative planner for in-game use: `for (const _ of planCivilizationSteps(field, opts)) { ... }` or
 * `system.runJob(planCivilizationSteps(...))`. The generator return value is the CivPlan; on failure it throws CivPlanError.
 * @param {HeightField & { seed?: number }} field @param {PlanOptions} [options]
 * @returns {Generator<void, any, void>}
 */
export function* planCivilizationSteps(field, options = {}) {
    const res = yield* planCivilizationDetailedSteps(field, options);
    if (!res.ok || !res.plan) throw new CivPlanError(`civilization planning failed: ${summariseFailures(res.errors)}`, res.errors);
    return res.plan;
}

/**
 * Compact reason summary of failed attempts: "reason xN" sorted by frequency.
 * @param {string[]} errors
 */
function summariseFailures(errors) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const e of errors) {
        const key = e.replace(/^attempt \d+: /, "").replace(/\d+(\.\d+)?/g, "#");
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((p, q) => q[1] - p[1]).map(([k, c]) => `${k} x${String(c)}`).join("; ");
}

/**
 * Plan and return details (no throw). Synchronous driver of planCivilizationDetailedSteps.
 * @param {HeightField & { seed?: number }} field @param {PlanOptions} [options]
 */
export function planCivilizationDetailed(field, options = {}) {
    return runSync(planCivilizationDetailedSteps(field, options));
}

/**
 * Synchronous driver of planCivilizationSteps. Throws CivPlanError when every attempt fails.
 * @param {HeightField & { seed?: number }} field @param {PlanOptions} [options]
 * @returns {any} CivPlan
 */
export function planCivilization(field, options = {}) {
    return runSync(planCivilizationSteps(field, options));
}

/**
 * Like planCivilizationDetailed but also consults civ/validate.js (authoritative) on every candidate plan. The validator
 * call itself is one synchronous step (about 0.2 s offline); in game run planCivilizationSteps and validate separately.
 * @param {HeightField & { seed?: number }} field @param {PlanOptions} [options]
 */
export async function planCivilizationAsync(field, options = {}) {
    /** @type {((plan: any) => any) | null} */
    let external = options.validate ?? null;
    if (!external) {
        try {
            const spec = "./validate.js";
            const mod = await import(spec);
            const fn = mod.validatePlan ?? mod.validate ?? mod.default;
            if (typeof fn === "function") {
                external = (/** @type {any} */ plan) => {
                    try {
                        const r = fn(plan);
                        if (Array.isArray(r)) return r.map(String);
                        if (r && typeof r === "object" && "ok" in r) return { ok: !!r.ok, errors: Array.isArray(r.errors) ? r.errors.map(String) : [] };
                    } catch {
                        return null;
                    }
                    return null;
                };
            }
        } catch {
            external = null;
        }
    }
    return planCivilizationDetailed(field, { ...options, validate: external ?? undefined });
}

export { decodeLabels, stamp };
