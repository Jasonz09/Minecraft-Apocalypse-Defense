// Adversarial tests for civ/validate.js: every mutation of a valid plan MUST be rejected with a specific problem,
// and (when the planner exists) real planner output is validated and mutated too.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeField } from "../lib/fakefield.mjs";
import { TINY_OPTIONS, buildPlanFromLabelGrid, discGrid, generateLabelGrid, rectangleGrid, validFullPlan, validTinyPlan } from "../lib/civfixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const civDir = join(root, "CivilizationApocalypse_BP", "scripts", "civ");
const { validatePlan, rasterizePolyline } = await import(pathToFileURL(join(civDir, "validate.js")).href);

const base = validFullPlan(1);
const baseResult = validatePlan(base);
assert.equal(baseResult.ok, true, `the unmutated fixture must be valid:\n${baseResult.problems.join("\n")}`);

/** @returns {any} */
const fresh = () => structuredClone(base);

/**
 * @param {any} plan @param {RegExp[]} patterns @param {string} label @param {object} [opts]
 * @returns {string[]} problems
 */
function mustFail(plan, patterns, label, opts) {
    const r = validatePlan(plan, opts);
    assert.equal(r.ok, false, `${label}: mutated plan was ACCEPTED`);
    for (const pattern of patterns) assert.ok(r.problems.some((p) => pattern.test(p)), `${label}: expected a problem matching ${String(pattern)}, got:\n${r.problems.join("\n")}`);
    return r.problems;
}

/** point-on-polyline test (axis aligned or not, via rasterisation) */
function onPath(path, x, z) {
    return rasterizePolyline(path, false).some((/** @type {number[]} */ p) => p[0] === x && p[1] === z);
}

/** Manhattan length of segment i of a path. */
const segLen = (/** @type {number[][]} */ path, /** @type {number} */ i) => Math.abs(path[i + 1][0] - path[i][0]) + Math.abs(path[i + 1][1] - path[i][1]);

/** Split shared wall `wall` into two open walls removing the centreline between vertices i and i+1 (a 4-block gap). */
function splitWall(/** @type {any} */ plan, /** @type {any} */ wall, /** @type {number} */ i) {
    const a = { ...wall, id: `${wall.id}-a`, path: wall.path.slice(0, i + 1), closed: false };
    const b = { ...wall, id: `${wall.id}-b`, path: wall.path.slice(i + 1), closed: false };
    plan.walls.splice(plan.walls.indexOf(wall), 1, a, b);
    for (const gate of plan.gates) {
        if (gate.wallId !== wall.id) continue;
        gate.wallId = onPath(a.path, gate.at.x, gate.at.z) ? a.id : b.id;
    }
}

/** index of a 4-block segment of `wall` far (>= 12 blocks) from every gate on it, with >= 2 vertices on both sides */
function pickGapSegment(/** @type {any} */ plan, /** @type {any} */ wall) {
    const gates = plan.gates.filter((/** @type {any} */ g) => g.wallId === wall.id);
    for (let i = 1; i + 2 < wall.path.length; i++) {
        if (segLen(wall.path, i) !== 4) continue;
        const mid = [(wall.path[i][0] + wall.path[i + 1][0]) / 2, (wall.path[i][1] + wall.path[i + 1][1]) / 2];
        if (gates.some((/** @type {any} */ g) => Math.max(Math.abs(g.at.x - mid[0]), Math.abs(g.at.z - mid[1])) < 14)) continue;
        return i;
    }
    return -1;
}

const sharedWalls = (/** @type {any} */ plan) => plan.walls.filter((/** @type {any} */ w) => w.kind === "shared");

// ---------------------------------------------------------------------------------------------------------
// wall mutations
// ---------------------------------------------------------------------------------------------------------

test("removing one wall pixel from a shared wall leaves a leak and dangling ends", () => {
    const plan = fresh();
    const wall = sharedWalls(plan).find((/** @type {any} */ w) => pickGapSegment(plan, w) >= 0);
    assert.ok(wall, "fixture has a shared wall with a 4-block segment");
    splitWall(plan, wall, pickGapSegment(plan, wall));
    const problems = mustFail(plan, [/\[dangling\]/, /\[leak\]/], "one-pixel hole in a shared wall");
    assert.ok(problems.some((p) => /\(-?\d+, -?\d+\)/.test(p)), "problems carry coordinates");
});

test("a one-block gap in the outer wall is found as an outside leak", () => {
    const plan = fresh();
    const outer = plan.walls.find((/** @type {any} */ w) => w.kind === "outer");
    const i = pickGapSegment(plan, outer);
    assert.ok(i >= 0);
    const loop = outer.path.slice(0, -1);
    outer.path = [...loop.slice(i + 1), ...loop.slice(0, i + 1)];
    outer.closed = false;
    const problems = mustFail(plan, [/\[leak\].*outside/, /\[dangling\]/], "gap in outer wall");
    assert.ok(problems.some((p) => /\[leak\].*district \d.*outside|outside.*district \d/.test(p)));
});

test("a wall flagged closed whose path is open is rejected", () => {
    const plan = fresh();
    const wall = sharedWalls(plan)[0];
    wall.closed = true;
    mustFail(plan, [/\[closed\]/], "closed flag lie");
});

test("an outer loop that is not really closed (last point moved) is rejected", () => {
    const plan = fresh();
    const outer = plan.walls.find((/** @type {any} */ w) => w.kind === "outer");
    outer.path[outer.path.length - 1] = [outer.path[outer.path.length - 1][0] + 8, outer.path[outer.path.length - 1][1]];
    mustFail(plan, [/\[closed\]/], "unclosed outer loop");
});

test("thickness 1 walls are rejected (diagonal leak)", () => {
    const plan = fresh();
    for (const wall of plan.walls) wall.thickness = 1;
    mustFail(plan, [/\[thickness\]/], "thickness 1");
    const wide = fresh();
    wide.walls[1].thickness = 5;
    mustFail(wide, [/\[thickness\]/], "thickness 5");
});

test("a diagonal chord replacing a staircase wall with thickness 1 leaks", () => {
    const plan = fresh();
    const wall = sharedWalls(plan).find((/** @type {any} */ w) => w.path.length >= 6 && w.path[0][0] !== w.path[w.path.length - 1][0] && w.path[0][1] !== w.path[w.path.length - 1][1]);
    assert.ok(wall, "a diagonal chord exists");
    wall.path = [wall.path[0], wall.path[wall.path.length - 1]];
    wall.thickness = 1;
    plan.gates = plan.gates.filter((/** @type {any} */ g) => g.wallId !== wall.id);
    mustFail(plan, [/\[thickness\]/, /\[leak\]|\[unwalled\]|\[wall\]/], "diagonal thickness-1 chord");
});

test("an isolated wall segment floating inside a district is rejected", () => {
    const plan = fresh();
    const hq = plan.districts[2].hq;
    plan.walls.push({ id: "wall-rogue", kind: "shared", between: [3, 4], closed: false, path: [[hq.x - 20, hq.z + 12], [hq.x + 20, hq.z + 12]], thickness: 3 });
    mustFail(plan, [/\[dangling\]/, /\[wall\].*more than \d+ blocks from any district boundary/], "isolated segment");
});

test("a closed compound wall inside a district seals off part of it", () => {
    const plan = fresh();
    const hq = plan.districts[1].hq;
    const x = hq.x + 12;
    const z = hq.z + 12;
    plan.walls.push({ id: "wall-compound", kind: "shared", between: [2, 3], closed: true, path: [[x, z], [x + 40, z], [x + 40, z + 40], [x, z + 40], [x, z]], thickness: 3 });
    mustFail(plan, [/\[split\]/], "enclosed compound");
});

test("a missing outer wall is rejected", () => {
    const plan = fresh();
    plan.walls = plan.walls.filter((/** @type {any} */ w) => w.kind !== "outer");
    plan.gates = plan.gates.filter((/** @type {any} */ g) => g.between[0] !== 0 && g.between[1] !== 0);
    mustFail(plan, [/no outer wall/, /\[leak\]/], "no outer wall");
});

test("removing a shared wall merges two districts", () => {
    const plan = fresh();
    const wall = sharedWalls(plan)[0];
    plan.walls = plan.walls.filter((/** @type {any} */ w) => w !== wall);
    plan.gates = plan.gates.filter((/** @type {any} */ g) => g.wallId !== wall.id);
    mustFail(plan, [/\[leak\]/, /\[unwalled\]/], "missing shared wall");
});

test("wall between lying about the neighbouring districts is rejected", () => {
    const plan = fresh();
    const wall = sharedWalls(plan).find((/** @type {any} */ w) => w.path.length > 12);
    assert.ok(wall);
    const [a, b] = wall.between;
    wall.between = [a, ((b % 5) + 1 === a ? (b % 5) + 2 : (b % 5) + 1)];
    mustFail(plan, [/\[wall\].*declares between/], "wall between");
});

// ---------------------------------------------------------------------------------------------------------
// gate mutations
// ---------------------------------------------------------------------------------------------------------

test("a gate shifted off its wall is rejected", () => {
    for (const [dx, dz] of [[0, 3], [3, 0], [0, -2]]) {
        const plan = fresh();
        plan.gates[0].at.x += dx;
        plan.gates[0].at.z += dz;
        mustFail(plan, [/\[gate\].*(not on the centreline|straight)/], `gate shifted by ${String(dx)},${String(dz)}`);
    }
});

test("a gate between the wrong districts is rejected", () => {
    const plan = fresh();
    const gate = plan.gates.find((/** @type {any} */ g) => g.between[0] !== 0 && g.between[1] !== 0);
    const other = [1, 2, 3, 4, 5].find((d) => !gate.between.includes(d));
    gate.between = [gate.between[0], other];
    mustFail(plan, [/\[gate\].*(declares between|labels on its two sides)/], "gate between");
});

test("a shared-wall gate claiming to face outside is rejected", () => {
    const plan = fresh();
    const gate = plan.gates.find((/** @type {any} */ g) => g.between[0] !== 0 && g.between[1] !== 0);
    gate.between = [gate.between[0], 0];
    mustFail(plan, [/\[gate\]/], "shared gate between d and 0");
});

test("gate width, axis, id and spacing are enforced", () => {
    const narrow = fresh();
    narrow.gates[1].width = 4;
    mustFail(narrow, [/\[gate\].*width/], "gate width 4");
    const flipped = fresh();
    flipped.gates[2].axis = flipped.gates[2].axis === "x" ? "z" : "x";
    mustFail(flipped, [/\[gate\].*(straight|not on)/], "gate axis flipped");
    const dup = fresh();
    dup.gates[3].id = dup.gates[0].id;
    mustFail(dup, [/\[gate\].*duplicate gate id/], "duplicate gate id");
    const crowded = fresh();
    const copy = structuredClone(crowded.gates[0]);
    copy.id = "gate-crowd";
    if (copy.axis === "x") copy.at.x += 3; else copy.at.z += 3;
    crowded.gates.push(copy);
    mustFail(crowded, [/\[gate\].*closer than/], "crowded gates");
    const ghost = fresh();
    ghost.gates[0].wallId = "wall-missing";
    mustFail(ghost, [/\[gate\].*unknown wall/], "gate on unknown wall");
    const purpose = fresh();
    purpose.gates[0].purpose = "party";
    mustFail(purpose, [/\[gate\].*purpose/], "bad purpose");
});

test("removing every gate of a ring pair breaks the ring", () => {
    const plan = fresh();
    const doomed = plan.gates.filter((/** @type {any} */ g) => g.between.includes(1) && g.between.includes(2)).map((/** @type {any} */ g) => g.id);
    assert.ok(doomed.length >= 1);
    plan.gates = plan.gates.filter((/** @type {any} */ g) => !doomed.includes(g.id));
    for (const kind of ["evac", "reinforce"]) plan.routes[kind] = plan.routes[kind].filter((/** @type {any} */ r) => !r.gates.some((/** @type {string} */ id) => doomed.includes(id)));
    mustFail(plan, [/\[ring\].*1-2 share a wall but no valid gate/], "no 1-2 gate");
});

test("too few outer gates is rejected", () => {
    const plan = fresh();
    const keep = plan.gates.find((/** @type {any} */ g) => g.between[1] === 0 || g.between[0] === 0);
    plan.gates = plan.gates.filter((/** @type {any} */ g) => (g.between[0] !== 0 && g.between[1] !== 0) || g === keep);
    mustFail(plan, [/\[ring\]/], "no outer gates");
});

// ---------------------------------------------------------------------------------------------------------
// roads, routes, hq
// ---------------------------------------------------------------------------------------------------------

test("a road crossing a wall without a gate is rejected", () => {
    const plan = fresh();
    const a = plan.districts[0].hq;
    const b = plan.districts[1].hq;
    plan.roads.push({ id: "road-bad", kind: "link", district: 1, width: 3, path: [[a.x, a.z], [b.x, b.z]] });
    mustFail(plan, [/\[road\].*road-bad.*(wall|runs into)/], "road through wall");
});

test("a district without roads cannot reach its HQ or gates", () => {
    const plan = fresh();
    plan.roads = plan.roads.filter((/** @type {any} */ r) => r.district !== 3);
    mustFail(plan, [/\[road\].*(district-3 HQ|reachable by road)/], "district 3 without roads");
});

test("a road cut in half leaves a gate unreachable", () => {
    const plan = fresh();
    const road = plan.roads.find((/** @type {any} */ r) => r.path.length >= 4);
    assert.ok(road);
    const k = Math.floor(road.path.length / 2);
    road.path = road.path.slice(0, k - 1).length >= 2 ? road.path.slice(0, k - 1) : road.path.slice(0, 2);
    mustFail(plan, [/\[road\].*not reachable by road/], "cut road");
});

test("road field errors are reported", () => {
    const plan = fresh();
    plan.roads[0].width = 0;
    plan.roads[1].district = 9;
    plan.roads[2].path = [[1, 1]];
    mustFail(plan, [/\[road\].*width/, /\[road\].*district/, /\[road\].*path/], "road fields");
});

test("a missing reinforce route is rejected, in both directions", () => {
    const plan = fresh();
    plan.routes.reinforce.shift();
    mustFail(plan, [/missing reinforce route/], "missing reinforce");
    const other = fresh();
    other.routes.reinforce = other.routes.reinforce.filter((/** @type {any} */ r) => !(r.from === 3 && r.to === 4));
    mustFail(other, [/missing reinforce route 3->4/], "missing reinforce 3->4");
});

test("routes may only use real, continuous gates", () => {
    const fake = fresh();
    fake.routes.evac[0].gates = ["gate-999"];
    mustFail(fake, [/\[route\].*not a gate id/], "fake gate id");
    const jump = fresh();
    jump.routes.reinforce[0] = { from: jump.routes.reinforce[0].from, to: jump.routes.reinforce[0].to, gates: [jump.gates.find((/** @type {any} */ g) => !g.between.includes(jump.routes.reinforce[0].from) && g.between[0] !== 0 && g.between[1] !== 0).id] };
    mustFail(jump, [/\[route\].*discontinuous/], "discontinuous route");
    const empty = fresh();
    empty.routes.evac.length = 0;
    mustFail(empty, [/no evac route leaves district/], "no evac");
    const outer = fresh();
    const outerGate = outer.gates.find((/** @type {any} */ g) => g.between[0] === 0 || g.between[1] === 0);
    outer.routes.reinforce[0] = { from: outerGate.between[0] || outerGate.between[1], to: 1, gates: [outerGate.id] };
    mustFail(outer, [/\[route\]/], "reinforce through outer gate");
});

test("a centred command HQ is rejected", () => {
    const plan = fresh();
    let sx = 0;
    let sz = 0;
    let sa = 0;
    for (const d of plan.districts) { sx += d.centroid.x * d.area; sz += d.centroid.z * d.area; sa += d.area; }
    plan.districts[0].hq = { x: Math.round(sx / sa), z: Math.round(sz / sa) };
    mustFail(plan, [/\[hq\].*civilization centroid/], "HQ at centroid");
});

test("an HQ outside its district is rejected", () => {
    const plan = fresh();
    plan.districts[3].hq = { x: plan.districts[0].hq.x, z: plan.districts[0].hq.z };
    mustFail(plan, [/\[hq\].*district-4 hq .*not inside/], "HQ in the wrong district");
});

// ---------------------------------------------------------------------------------------------------------
// labels, areas, bookkeeping
// ---------------------------------------------------------------------------------------------------------

test("labels and areas that disagree are rejected", () => {
    const labels = fresh();
    const k = labels.labels.findIndex((/** @type {number[]} */ r) => r[0] === 3 && r[1] >= 6);
    labels.labels.splice(k, 1, [3, labels.labels[k][1] - 3], [1, 3]);
    mustFail(labels, [/\[area\]/], "relabelled cells");
    const area = fresh();
    area.districts[0].area += 16;
    mustFail(area, [/\[area\].*district-1 area/], "area tampered");
    const cells = fresh();
    cells.districts[2].cells -= 1;
    mustFail(cells, [/\[area\].*cells/], "cells tampered");
    const bbox = fresh();
    bbox.districts[1].bbox.x1 += 40;
    mustFail(bbox, [/\[districts\].*bbox/], "bbox tampered");
    const stats = fresh();
    stats.stats.totalArea += 800;
    mustFail(stats, [/\[stats\]/], "stats tampered");
});

test("malformed label streams are rejected without crashing", () => {
    const short = fresh();
    short.labels.pop();
    mustFail(short, [/\[labels\]/], "short labels");
    const negative = fresh();
    negative.labels[0] = [0, -5];
    mustFail(negative, [/\[labels\]/], "negative run");
    const tooBig = fresh();
    tooBig.labels[1] = [9, tooBig.labels[1][1]];
    mustFail(tooBig, [/\[labels\]|label above/], "label 9");
});

test("duplicate and overlapping districts are rejected", () => {
    const dup = fresh();
    dup.districts.push(structuredClone(dup.districts[1]));
    mustFail(dup, [/\[districts\].*(duplicate district index|expected 5 districts)/], "duplicate district entry");
    const swapped = fresh();
    swapped.districts[3].index = 2;
    mustFail(swapped, [/\[districts\].*duplicate district index 2/], "district index collision");
    const overlap = fresh();
    overlap.districts[2].outline = structuredClone(overlap.districts[1].outline);
    mustFail(overlap, [/\[districts\].*outline/], "overlapping outlines");
    const missing = fresh();
    missing.districts.pop();
    mustFail(missing, [/\[districts\]/], "missing district");
    const role = fresh();
    role.districts[0].role = "industrial";
    mustFail(role, [/\[districts\].*role/], "wrong role");
});

test("JSON-unsafe and non-integer values are rejected", () => {
    const nan = fresh();
    nan.walls[1].path[0][0] = NaN;
    mustFail(nan, [/\[json\]/], "NaN coordinate");
    const inf = fresh();
    inf.stats.wallLength = Infinity;
    mustFail(inf, [/\[json\]/], "Infinity");
    const fn = fresh();
    fn.extra = () => 1;
    mustFail(fn, [/\[json\]/], "function value");
    const frac = fresh();
    frac.gates[0].at.x += 0.5;
    mustFail(frac, [/\[gate\]/], "fractional gate coordinate");
    const wallFrac = fresh();
    wallFrac.walls[1].path[1][1] += 0.25;
    mustFail(wallFrac, [/\[wall\].*integer/], "fractional wall coordinate");
    const huge = fresh();
    huge.junk = "x".repeat(950000);
    mustFail(huge, [/\[json\].*budget/], "oversized plan");
});

// ---------------------------------------------------------------------------------------------------------
// shape mutations: whole plans built on geometric label grids
// ---------------------------------------------------------------------------------------------------------

test("a rectangular civilization with gridded rectangular districts is rejected", () => {
    const plan = buildPlanFromLabelGrid(rectangleGrid("grid5"));
    const problems = mustFail(plan, [/\[shape\].*civilization bbox fill/, /\[shape\].*district-\d bbox fill/], "5 gridded rectangles");
    assert.ok(problems.every((p) => /^\[(shape|hq)\]/.test(p)), `only shape problems expected, got:\n${problems.join("\n")}`);
});

test("rectangular stripes are rejected on shape and ring adjacency", () => {
    const plan = buildPlanFromLabelGrid(rectangleGrid("stripes"));
    mustFail(plan, [/\[shape\].*bbox fill/, /\[ring\].*1-5 are not physically adjacent/], "stripes");
});

test("a circular civilization is rejected", () => {
    const plan = buildPlanFromLabelGrid(discGrid(5), { x0: -300, z0: -300 });
    mustFail(plan, [/\[shape\].*radial variation/], "disc");
});

test("a mirror-symmetric civilization is rejected", () => {
    const plan = buildPlanFromLabelGrid(generateLabelGrid({ symmetric: true, seed: 2 }));
    mustFail(plan, [/\[shape\].*symmetric/], "symmetric blob");
});

test("districts that are the same shape are rejected, the near-twin control is accepted", () => {
    /** @param {boolean} twin */
    function tinyGrid(twin) {
        const w = 48;
        const h = 40;
        const cells = new Uint8Array(w * h);
        const L = [0, 0, 0, 3, 3, 3, 6, 6, 6, 3, 3, 3, 0, 0, 0, 3, 3, 3, 6, 6, 6, 3];
        for (let j = 0; j < 22; j++) {
            const left = 4 + L[j];
            const rightEdge = 47 - left;
            for (let i = left; i <= 23; i++) cells[j * w + i] = 2;
            const extra = twin ? 0 : (j * 3) % 7 + 1;
            for (let i = 24; i <= rightEdge - extra; i++) cells[j * w + i] = 3;
        }
        for (let j = 22; j < 38; j++) {
            for (let i = 7 + ((j * 5) % 7); i <= 40 - ((j * 3) % 5); i++) cells[j * w + i] = 1;
        }
        return { cells, w, h, n: 3 };
    }
    const twin = buildPlanFromLabelGrid(tinyGrid(true), { x0: 0, z0: 0 });
    const opts = { ...TINY_OPTIONS, bboxFillMax: 0.99, orientedFillMaxUnion: 0.99, orientedFillMaxDistrict: 0.99, symmetryMax: 0.999, radialCvMin: 0, compactnessMax: 1 };
    mustFail(twin, [/\[shape\].*district-2 and district-3 outlines are congruent/], "mirror twins", opts);
    const control = buildPlanFromLabelGrid(tinyGrid(false), { x0: 0, z0: 0 });
    const r = validatePlan(control, opts);
    assert.equal(r.problems.some((p) => /congruent|indistinguishable/.test(p)), false, `control must not be flagged as congruent:\n${r.problems.join("\n")}`);
});

test("area limits reject plans that are too small or too large", () => {
    const small = buildPlanFromLabelGrid(generateLabelGrid({ w: 110, h: 110, targetCells: 6000, seed: 5 }));
    mustFail(small, [/\[area\].*outside \[30000, 45000\]/, /\[area\].*total area/], "small plan");
    const large = buildPlanFromLabelGrid(generateLabelGrid({ w: 190, h: 190, targetCells: 17500, seed: 5 }));
    mustFail(large, [/\[area\].*outside \[30000, 45000\]/, /\[area\].*total area/], "large plan");
});

// ---------------------------------------------------------------------------------------------------------
// tiny-plan mutations (different grid, same rules)
// ---------------------------------------------------------------------------------------------------------

test("tiny plan: the same mutations are caught on a different raster", () => {
    const tiny = validTinyPlan(3);
    assert.equal(validatePlan(tiny, TINY_OPTIONS).ok, true);
    const gap = structuredClone(tiny);
    const wall = gap.walls.find((/** @type {any} */ w) => w.kind === "outer");
    const i = pickGapSegment(gap, wall);
    assert.ok(i >= 0);
    const loop = wall.path.slice(0, -1);
    wall.path = [...loop.slice(i + 1), ...loop.slice(0, i + 1)];
    wall.closed = false;
    mustFail(gap, [/\[leak\]/], "tiny outer gap", TINY_OPTIONS);
    const shifted = structuredClone(tiny);
    shifted.gates[0].at.z += 2;
    mustFail(shifted, [/\[gate\]/], "tiny shifted gate", TINY_OPTIONS);
    const noRoutes = structuredClone(tiny);
    noRoutes.routes.reinforce = [];
    mustFail(noRoutes, [/missing reinforce route/], "tiny without reinforce", TINY_OPTIONS);
});

// ---------------------------------------------------------------------------------------------------------
// the real planner (once civ/masterplan.js exists)
// ---------------------------------------------------------------------------------------------------------

const masterplanPath = join(civDir, "masterplan.js");
const havePlanner = existsSync(masterplanPath);
const planner = havePlanner ? await import(pathToFileURL(masterplanPath).href) : null;

const TERRAINS = [
    ["flat hills", () => makeField(5, {})],
    ["river", () => makeField(11, { river: { z: 20, width: 12, wiggle: 30 } })],
    ["lakes and forest", () => makeField(23, { lakes: [{ x: 120, z: -60, r: 40 }, { x: -140, z: 90, r: 30 }], forest: 0.5 })],
    ["rough", () => makeField(31, { relief: 18, hills: 50 })],
];

/** @param {any} field @param {number} seed */
function planFor(field, seed) {
    const res = planner.planCivilizationDetailed(field, { seed });
    assert.ok(res.ok && res.plan, `planner failed on seed ${String(seed)}: ${String(res.errors?.slice(0, 3).join("; "))}`);
    return res.plan;
}

test("planner output passes independent validation on several terrains", { skip: !havePlanner && "civ/masterplan.js not written yet" }, () => {
    const failures = [];
    for (const [name, make] of TERRAINS) {
        for (const seed of [3, 17]) {
            const plan = planFor(/** @type {any} */ (make)(), seed);
            const r = validatePlan(plan);
            if (!r.ok) failures.push(`${String(name)} seed ${String(seed)}:\n  ${r.problems.join("\n  ")}`);
        }
    }
    assert.equal(failures.length, 0, `planner plans rejected by the validator:\n${failures.join("\n")}`);
});

/** Make a planner plan comparable: only used to prove the validator catches holes, not to excuse the planner. */
function geometryOnly(/** @type {any} */ plan) {
    const copy = structuredClone(plan);
    for (const wall of copy.walls) {
        const a = wall.path[0];
        const b = wall.path[wall.path.length - 1];
        if (wall.closed && (a[0] !== b[0] || a[1] !== b[1])) wall.closed = false;
    }
    return copy;
}

const GEOMETRY = /^\[(leak|split|dangling|unwalled|gate|wall|thickness)\]/;

test("deleting one wall pixel of a real planner plan is always detected", { skip: !havePlanner && "civ/masterplan.js not written yet" }, () => {
    let rounds = 0;
    for (const [name, make] of TERRAINS.slice(0, 3)) {
        const plan = geometryOnly(planFor(/** @type {any} */ (make)(), 9));
        const baseline = validatePlan(plan);
        const baselineGeometry = baseline.problems.filter((p) => GEOMETRY.test(p));
        assert.deepEqual(baselineGeometry, [], `${String(name)}: planner geometry has problems before any mutation`);
        // seeded pseudo-random choice of wall, pixel
        for (let trial = 0; trial < 4; trial++) {
            const mutated = structuredClone(plan);
            const pick = (mutated.seed * 7919 + trial * 104729 + 13) >>> 0;
            const candidates = mutated.walls.filter((/** @type {any} */ w) => rasterizePolyline(w.path, false).length > 60);
            const wall = candidates[pick % candidates.length];
            const pixels = rasterizePolyline(wall.path, wall.closed === true);
            const gates = mutated.gates.filter((/** @type {any} */ g) => g.wallId === wall.id);
            let t = 12 + (pick % (pixels.length - 24));
            for (let guard = 0; guard < pixels.length; guard++) {
                const [x, z] = pixels[t];
                if (!gates.some((/** @type {any} */ g) => Math.max(Math.abs(g.at.x - x), Math.abs(g.at.z - z)) < 12)) break;
                t = 12 + ((t + 7) % (pixels.length - 24));
            }
            // cut the centreline so that exactly pixel t is left uncovered by the stamped neighbours
            const left = pixels.slice(0, t - 1);
            const right = pixels.slice(t + 2);
            mutated.walls.splice(mutated.walls.indexOf(wall), 1, { ...wall, id: `${wall.id}-l`, closed: false, path: left }, { ...wall, id: `${wall.id}-r`, closed: false, path: right });
            for (const g of gates) g.wallId = onPath(left, g.at.x, g.at.z) ? `${wall.id}-l` : `${wall.id}-r`;
            const r = validatePlan(mutated);
            assert.ok(r.problems.some((p) => /\[leak\]/.test(p)), `${String(name)} trial ${String(trial)} (wall ${String(wall.id)} pixel ${String(pixels[t])}): hole not seen as a leak:\n${r.problems.slice(0, 10).join("\n")}`);
            assert.ok(r.problems.some((p) => /\[dangling\]/.test(p)), `${String(name)} trial ${String(trial)}: hole not seen as dangling ends`);
            rounds++;
        }
    }
    assert.equal(rounds, 12);
});
