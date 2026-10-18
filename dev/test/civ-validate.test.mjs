// Unit tests for civ/validate.js: reusable helpers and plans that MUST validate.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TINY_OPTIONS, validFullPlan, validTinyPlan } from "../lib/civfixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V = await import(pathToFileURL(join(root, "CivilizationApocalypse_BP", "scripts", "civ", "validate.js")).href);
const { validatePlan } = V;

/** @param {{ problems: string[] }} r */
const show = (r) => r.problems.join("\n");

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

test("bresenham is 8-connected and includes both ends", () => {
    for (const [x1, z1] of [[10, 3], [-7, 9], [0, 12], [12, 0], [-5, -5], [3, 11]]) {
        const pts = [];
        V.bresenham(0, 0, x1, z1, (/** @type {number} */ x, /** @type {number} */ z) => pts.push([x, z]));
        assert.deepEqual(pts[0], [0, 0]);
        assert.deepEqual(pts[pts.length - 1], [x1, z1]);
        for (let i = 1; i < pts.length; i++) assert.ok(Math.max(Math.abs(pts[i][0] - pts[i - 1][0]), Math.abs(pts[i][1] - pts[i - 1][1])) === 1, "consecutive pixels touch");
        assert.equal(pts.length, Math.max(Math.abs(x1), Math.abs(z1)) + 1);
    }
});

test("rasterizePolyline closes loops and removes consecutive duplicates", () => {
    const pts = V.rasterizePolyline([[0, 0], [4, 0], [4, 4], [0, 4]], true);
    assert.equal(pts.length, 16);
    assert.deepEqual(V.rasterizePolyline([[2, 2]], false), [[2, 2]]);
    assert.equal(V.rasterizePolyline([[0, 0], [0, 0], [3, 0]], false).length, 4);
});

/** Can a walker cutting corners (8-connected) cross a corner-to-corner wall stamped with radius r? */
function diagonalLeaks(r, eight = true) {
    const size = 41;
    const barrier = new Uint8Array(size * size);
    const line = V.rasterizePolyline([[0, 0], [40, 40]], false);
    V.stampSquare(barrier, size, size, line, r);
    const cc = V.labelComponents(barrier, size, size, eight);
    return cc.comp[30 * size + 5] === cc.comp[5 * size + 30];
}

test("a thickness-1 diagonal wall leaks, a thickness-3 stamp seals", () => {
    assert.equal(diagonalLeaks(0), true, "radius 0 (thickness 1) diagonal leaks a corner-cutting walker");
    assert.equal(diagonalLeaks(0, false), false, "a 4-connected walker would be stopped, which is why the validator floods 8-connected");
    assert.equal(diagonalLeaks(1), false, "radius 1 (thickness 3) diagonal seals even against corner cutting");
});

test("labelComponents separates regions and honours 8-connectivity", () => {
    const w = 6;
    const h = 6;
    const blocked = new Uint8Array(w * h);
    for (let k = 0; k < 6; k++) blocked[k * w + k] = 1; // diagonal barrier
    assert.equal(V.labelComponents(blocked, w, h, false).count, 2, "4-connected flood is stopped by a diagonal line");
    const eight = V.labelComponents(blocked, w, h, true);
    assert.equal(eight.count, 1, "8-connected flood slips through the diagonal");
    assert.equal(eight.comp[0], -1);
});

test("erodeUniform marks only pixels far from a label change", () => {
    const w = 20;
    const h = 20;
    const labels = new Uint8Array(w * h);
    for (let z = 0; z < h; z++) for (let x = 10; x < w; x++) labels[z * w + x] = 1;
    const out = V.erodeUniform(labels, w, h, 3);
    assert.equal(out[10 * w + 2], 1);
    assert.equal(out[10 * w + 6], 1);
    assert.equal(out[10 * w + 7], 0);
    assert.equal(out[10 * w + 9], 0);
    assert.equal(out[10 * w + 10], 0);
    assert.equal(out[10 * w + 16], 1);
});

test("polygon helpers", () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(V.polygonAreaOf(square), 100);
    assert.equal(V.polygonPerimeterOf(square), 40);
    assert.ok(Math.abs(V.compactnessOf(100, 40) - Math.PI / 4) < 1e-9);
    assert.equal(V.compactnessOf(5, 0), 0);
});

test("orientedFillOf sees through rotation", () => {
    /** @type {number[][]} */
    const rect = [];
    for (let i = 0; i < 30; i++) for (let j = 0; j < 12; j++) rect.push([i, j]);
    assert.ok(V.orientedFillOf(rect) > 0.95);
    // 45 degree rotated rectangle (a diamond band)
    /** @type {number[][]} */
    const rot = [];
    for (let i = -40; i <= 40; i++) for (let j = -40; j <= 40; j++) {
        const u = (i + j) / Math.SQRT2;
        const v = (j - i) / Math.SQRT2;
        if (u >= 0 && u < 30 && v >= 0 && v < 12) rot.push([i, j]);
    }
    assert.ok(V.orientedFillOf(rot) > 0.9, `rotated rectangle still looks rectangular (${String(V.orientedFillOf(rot))})`);
    // an L shape is far from a rectangle
    /** @type {number[][]} */
    const ell = [];
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) if (i < 8 || j < 8) ell.push([i, j]);
    assert.ok(V.orientedFillOf(ell) < 0.6);
});

test("congruence detects exact copies under rotation and reflection, not different shapes", () => {
    /** @type {number[][]} */
    const l1 = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 4; j++) l1.push([i, j]);
    for (let i = 0; i < 4; i++) for (let j = 4; j < 9; j++) l1.push([i, j]);
    const rotated = l1.map(([i, j]) => [-j + 50, i + 3]);
    const mirrored = l1.map(([i, j]) => [i + 7, -j + 11]);
    assert.equal(V.congruence(l1, rotated).exact, true);
    assert.equal(V.congruence(l1, mirrored).exact, true);
    /** @type {number[][]} */
    const other = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 4; j++) other.push([i, j]);
    for (let i = 6; i < 10; i++) for (let j = 4; j < 12; j++) other.push([i, j]);
    for (let i = 0; i < 3; i++) for (let j = 4; j < 6; j++) other.push([i, j]);
    const cg = V.congruence(l1, other);
    assert.equal(cg.exact, false);
    assert.ok(cg.iou < 0.9);
});

test("symmetryScore: mirror-symmetric masks score high, asymmetric ones low", () => {
    const w = 40;
    const h = 40;
    const sym = new Uint8Array(w * h);
    for (let j = 5; j < 35; j++) for (let i = 5; i < 35; i++) if (Math.abs(i - 19.5) + Math.abs(j - 19.5) < 14 + (j % 3)) sym[j * w + i] = 1;
    for (let j = 0; j < h; j++) for (let i = 0; i < 20; i++) sym[j * w + (39 - i)] = sym[j * w + i];
    assert.ok(V.symmetryScore(sym, w, h, false).score > 0.95);
    const asym = new Uint8Array(w * h);
    for (let j = 4; j < 36; j++) for (let i = 4; i < 36; i++) if ((i - 4) + (j - 4) * 0.4 < 22 && (i * 7 + j * 13) % 11 > 1) asym[j * w + i] = 1;
    for (let j = 4; j < 20; j++) for (let i = 4; i < 12; i++) asym[j * w + i] = 1;
    assert.ok(V.symmetryScore(asym, w, h, false).score < 0.9, `asymmetric score ${String(V.symmetryScore(asym, w, h, false).score)}`);
});

test("decodeLabelsIndependent rejects malformed runs and length mismatches", () => {
    const base = { grid: { x0: 0, z0: 0, w: 4, h: 2 }, labels: [[0, 4], [1, 4]] };
    assert.equal(V.decodeLabelsIndependent(base).ok, true);
    assert.equal(V.decodeLabelsIndependent({ ...base, labels: [[0, 4], [1, 3]] }).ok, false);
    assert.equal(V.decodeLabelsIndependent({ ...base, labels: [[0, 4], [1, 5]] }).ok, false);
    assert.equal(V.decodeLabelsIndependent({ ...base, labels: [[0, 0], [1, 8]] }).ok, false);
    assert.equal(V.decodeLabelsIndependent({ ...base, labels: [[0, 4], [1.5, 4]] }).ok, false);
    assert.equal(V.decodeLabelsIndependent({ ...base, labels: [[0, 4], [-1, 4]] }).ok, false);
    assert.equal(V.decodeLabelsIndependent({ grid: { w: 0, h: 2 }, labels: [] }).ok, false);
});

// ---------------------------------------------------------------------------------------------------------
// valid plans pass
// ---------------------------------------------------------------------------------------------------------

test("hand-built tiny 3-district plans (60x60 cells) validate", () => {
    for (const seed of [3, 4, 5, 6]) {
        const plan = validTinyPlan(seed);
        assert.equal(plan.grid.w, 60);
        const r = validatePlan(plan, TINY_OPTIONS);
        assert.equal(r.ok, true, `seed ${String(seed)}:\n${show(r)}`);
        assert.deepEqual(r.problems, []);
    }
});

test("full-size 5-district fixtures validate and report metrics", () => {
    for (const seed of [1, 3, 7]) {
        const plan = validFullPlan(seed);
        const total = plan.districts.reduce((/** @type {number} */ a, /** @type {any} */ d) => a + d.area, 0);
        assert.ok(total >= 175000 && total <= 205000, `fixture total ${String(total)}`);
        const r = validatePlan(plan);
        assert.equal(r.ok, true, `seed ${String(seed)}:\n${show(r)}`);
        assert.equal(r.metrics.gateCount, plan.gates.length);
        assert.equal(r.metrics.totalArea, total);
        assert.ok(r.metrics.union.bboxFill < 0.8 && r.metrics.union.compactness > 0.25 && r.metrics.union.compactness < 0.92);
        assert.deepEqual(r.errors, r.problems, "errors aliases problems for the planner hook");
    }
});

test("validation is deterministic, pure and fast enough on a ~190k-column plan", () => {
    const plan = validFullPlan(1);
    const before = JSON.stringify(plan);
    const t0 = process.hrtime.bigint();
    const a = validatePlan(plan);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const b = validatePlan(plan);
    assert.equal(JSON.stringify(plan), before, "validatePlan must not mutate its input");
    assert.deepEqual(a, b);
    assert.ok(ms < 5000, `validation took ${ms.toFixed(0)} ms`);
    assert.ok(a.metrics.raster.w * a.metrics.raster.h > 300000, "validation really ran at block resolution");
});

test("the validator is strict about the plan skeleton", () => {
    assert.equal(validatePlan(null).ok, false);
    assert.equal(validatePlan({}).ok, false);
    assert.equal(validatePlan(undefined).ok, false);
    assert.equal(validatePlan("plan").ok, false);
    const plan = validFullPlan(1);
    for (const mutate of [
        (/** @type {any} */ p) => { p.version = 2; },
        (/** @type {any} */ p) => { p.cell = 8; },
        (/** @type {any} */ p) => { delete p.routes; },
        (/** @type {any} */ p) => { delete p.stats; },
        (/** @type {any} */ p) => { p.seed = 1.5; },
    ]) {
        const copy = structuredClone(plan);
        mutate(copy);
        assert.equal(validatePlan(copy).ok, false);
    }
});

test("options relax area limits for small plans but never the geometry", () => {
    const tiny = validTinyPlan(3);
    const strict = validatePlan(tiny, { districtCount: 3 });
    assert.equal(strict.ok, false);
    assert.ok(strict.problems.some((p) => /\[area\]/.test(p)), "default limits reject a tiny plan on area");
    const relaxed = validatePlan(tiny, TINY_OPTIONS);
    assert.equal(relaxed.ok, true, show(relaxed));
    const broken = structuredClone(tiny);
    broken.walls[1].path = broken.walls[1].path.slice(0, -1);
    assert.equal(validatePlan(broken, TINY_OPTIONS).ok, false);
});

test("problem output is capped per category but never silent", () => {
    const plan = validFullPlan(1);
    for (const g of plan.gates) g.at.z += 1; // shifts every gate off its wall
    const r = validatePlan(plan);
    assert.equal(r.ok, false);
    const gateLines = r.problems.filter((p) => /^\[gate\]/.test(p));
    assert.ok(gateLines.length <= 7, `gate lines are capped (${String(gateLines.length)})`);
    assert.ok(gateLines.some((p) => /more/.test(p)) || plan.gates.length <= 6);
});
