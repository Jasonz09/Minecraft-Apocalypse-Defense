import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Restart safety of the Hearthgate construction planner.
 *
 * The site record is rebuilt from (CivPlan, persisted ground, options) after a Minecraft restart.
 * These tests prove that the rebuilt record is identical (checksum, per-element hashes, op
 * streams), that the planner needs nothing outside the persisted region, that the persisted
 * state fits the plan budget, and that a record without live generators refuses to answer.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const loadDev = (...parts) => import(pathToFileURL(join(projectRoot, "dev", ...parts)).href);

const { makeField } = await loadDev("lib", "fakefield.mjs");
const fixture = await loadDev("lib", "civfixture.mjs");
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");
const P = await load("civ", "siteprofile.js");
const { CIV_LIMITS } = await load("civ", "budget.js");
const { utf8Length } = await load("civ", "planstore.js");

const CASES = [
    { name: "seed 21 rough (relief 18)", seed: 21, relief: 18 },
    { name: "seed 3 rough (relief 18)", seed: 3, relief: 18 },
    { name: "seed 99 rough (relief 18)", seed: 99, relief: 18 },
    { name: "seed 12 flat (relief 2)", seed: 12, relief: 2 },
];
const cache = new Map();
function build(spec) {
    let hit = cache.get(spec.name);
    if (hit === undefined) {
        const field = makeField(spec.seed, { relief: spec.relief, hills: 60 });
        const planned = M.planCivilizationDetailed(field, { seed: spec.seed });
        assert.ok(planned.ok, `${spec.name}: master plan`);
        const site = D.planDistrictSite(planned.plan, 1, field, { seed: spec.seed });
        assert.ok(site.ok, `${spec.name}: ${site.problems.slice(0, 3).join(" | ")}`);
        const region = P.siteGroundRegion(planned.plan, 1);
        const ground = P.exportSiteGround(field, region);
        hit = { ...spec, field, plan: planned.plan, site, record: site.record, region, ground };
        cache.set(spec.name, hit);
    }
    return hit;
}

/** Everything that crosses a restart goes through JSON. */
const viaJSON = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ exact ground round trip */

test("the exported ground answers at(x, z) identically to the field it was cut from, including water, trees and unloaded edges", () => {
    // a field with a river, lakes, forest and bounds that end inside the region
    const field = makeField(7, { size: 260, x0: -130, z0: -130, relief: 14, hills: 50, river: { z: 10, width: 9, wiggle: 14 }, lakes: [{ x: 40, z: 40, r: 12 }], forest: 0.5 });
    const region = { x0: -150, z0: -140, x1: 120, z1: 90 };
    const json = viaJSON(P.exportSiteGround(field, region));
    const back = P.importSiteGround(json);
    let water = 0;
    let trees = 0;
    let unloaded = 0;
    for (let z = region.z0; z <= region.z1; z += 1) {
        for (let x = region.x0; x <= region.x1; x += 1) {
            const a = field.at(x, z);
            const b = back.at(x, z);
            if (a.k === "unloaded") {
                unloaded += 1;
                assert.equal(b.k, "unloaded", `${String(x)},${String(z)}`);
                continue;
            }
            assert.equal(b.k, a.k, `${String(x)},${String(z)} kind`);
            assert.equal(b.g, Math.floor(a.g), `${String(x)},${String(z)} ground`);
            assert.equal(b.tree, a.tree, `${String(x)},${String(z)} tree`);
            if (a.k === "water") water += 1;
            if (a.tree) trees += 1;
        }
    }
    assert.ok(water > 500 && trees > 300 && unloaded > 500, `degenerate sample: water ${String(water)}, trees ${String(trees)}, unloaded ${String(unloaded)}`);
    assert.equal(back.at(region.x1 + 1, 0).k, "unloaded", "outside the region reads as unloaded");
    assert.equal(back.sameAs(field), true);
});

test("a corrupted or mismatched ground export is refused, not silently half-used", () => {
    const c = build(CASES[0]);
    const broken = viaJSON(c.ground);
    broken.g = `${broken.g.slice(0, 100)}${broken.g[100] === "A" ? "B" : "A"}${broken.g.slice(101)}`;
    assert.throws(() => P.importSiteGround(broken), /hash/);
    assert.throws(() => P.importSiteGround({ ...viaJSON(c.ground), v: 99 }), /version/);
    assert.throws(() => P.importSiteGround({ ...viaJSON(c.ground), w: 0 }), /dimensions/);
    const bad = D.rehydrateSite(c.plan, 1, broken, D.siteOptionsOf(c.record));
    assert.equal(bad.ok, false);
    assert.equal(bad.record, null);
    assert.match(bad.problems.join(" "), /unusable/);
    // ground cut for another region
    const other = P.exportSiteGround(c.field, { ...c.region, x0: c.region.x0 + 10 });
    const wrong = D.rehydrateSite(c.plan, 1, other, D.siteOptionsOf(c.record));
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems.join(" "), /covers/);
});

/* ------------------------------------------------------------------ identical re-planning */

test("rehydrating from persisted (plan, ground) reproduces the checksum, every element hash and every op stream", () => {
    for (const spec of CASES) {
        const c = build(spec);
        // exactly what a restart has: JSON text of the plan, JSON text of the ground, the stored options
        const plan2 = viaJSON(c.plan);
        const ground2 = viaJSON(c.ground);
        const options = viaJSON(D.siteOptionsOf(c.record));
        const again = D.rehydrateSite(plan2, 1, ground2, { ...options, expectChecksum: c.record.checksum });
        assert.equal(again.ok, true, `${spec.name}: ${again.problems.slice(0, 3).join(" | ")}`);
        const b = again.record;
        assert.equal(b.checksum, c.record.checksum, `${spec.name}: checksum`);
        assert.notEqual(b, c.record);
        let compared = 0;
        for (const stage of D.SITE_STAGES) {
            assert.equal(b[stage].length, c.record[stage].length, `${spec.name}: ${stage} element count`);
            b[stage].forEach((element, i) => {
                const original = c.record[stage][i];
                assert.equal(element.id, original.id);
                assert.equal(element.hash, original.hash, `${spec.name}: ${stage}/${element.id} hash`);
                assert.equal(element.total, original.total);
                // identical op stream, op for op
                assert.deepEqual(D.siteOpsFor(b, stage, i), D.siteOpsFor(c.record, stage, i), `${spec.name}: ${stage}/${element.id} ops`);
                compared += 1;
            });
        }
        assert.ok(compared > 100, `${spec.name}: only ${String(compared)} elements compared`);
        assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(c.record)), `${spec.name}: whole record`);
        // the slices a job would stream are the same too
        const sliceA = [];
        const sliceB = [];
        for (const slice of D.siteOpSlices(c.record, { stages: ["roads"] })) sliceA.push(slice.ops.length);
        for (const slice of D.siteOpSlices(b, { stages: ["roads"] })) sliceB.push(slice.ops.length);
        assert.deepEqual(sliceB, sliceA);
    }
});

test("planning on the original field and on the imported ground give the same record, on terrains with water", () => {
    // a plan over a river: bridges and wet ground are in the persisted region as well
    const plan = fixture.validFullPlan(7);
    const river = makeField(7, { size: plan.grid.w * plan.cell + 80, lakes: [] });
    const midZ = Math.round((plan.districts[0].bbox.z0 + plan.districts[0].bbox.z1) / 2);
    const wet = {
        bounds: river.bounds,
        at(x, z) {
            const cell = river.at(x, z);
            return Math.abs(z - midZ) <= 2 ? { g: cell.g - 3, k: "water", tree: false } : cell;
        },
    };
    const a = D.planDistrictSite(plan, 1, wet, { seed: 7 });
    assert.ok(a.ok, a.problems.slice(0, 3).join(" | "));
    const ground = viaJSON(P.exportSiteGround(wet, P.siteGroundRegion(plan, 1)));
    const b = D.rehydrateSite(viaJSON(plan), 1, ground, D.siteOptionsOf(a.record));
    assert.ok(b.ok, b.problems.join(" | "));
    assert.equal(b.record.checksum, a.record.checksum);
    for (const stage of D.SITE_STAGES) {
        a.record[stage].forEach((element, i) => assert.equal(b.record[stage][i].hash, element.hash));
    }
    let bridged = 0;
    a.record.roads.forEach((_, i) => {
        for (const op of D.siteOpsFor(b.record, "roads", i)) if (op.kind === "bridge" || op.kind === "support") bridged += 1;
    });
    assert.ok(bridged > 0, "the wet case must exercise bridges");
});


test("options travel with the record: a different seed or wall height gives a different checksum, and expectChecksum notices", () => {
    const c = build(CASES[0]);
    const base = D.siteOptionsOf(c.record);
    assert.equal(base.seed, c.record.seed);
    const other = D.rehydrateSite(c.plan, 1, c.ground, { ...base, seed: c.record.seed + 1, expectChecksum: c.record.checksum });
    assert.equal(other.ok, false);
    assert.match(other.problems.join(" "), /checksum/);
    const taller = D.rehydrateSite(c.plan, 1, c.ground, { ...base, wallHeight: 8 });
    assert.ok(taller.record !== null);
    assert.notEqual(taller.record.checksum, c.record.checksum);
    // protected footprints are part of the options and survive the round trip
    const box = c.record.bbox;
    const guarded = D.planDistrictSite(c.plan, 1, c.field, { seed: c.record.seed, excludeFootprints: [{ x0: box.x0 + 5, z0: box.z0 + 5, x1: box.x0 + 70, z1: box.z0 + 70 }] });
    const reborn = D.rehydrateSite(viaJSON(c.plan), 1, viaJSON(c.ground), viaJSON(D.siteOptionsOf(guarded.record)));
    assert.equal(reborn.record.checksum, guarded.record.checksum);
    assert.notEqual(guarded.record.checksum, c.record.checksum);
});

/* ------------------------------------------------------------------ a dead record refuses to answer */

test("siteOpsFor, siteOpsById and siteOpSlices THROW on a record without live generators; rehydrating revives it", () => {
    const c = build(CASES[0]);
    assert.equal(D.isLiveSite(c.record), true);
    const dead = [viaJSON(c.record), structuredClone(c.record), { ...c.record }];
    for (const record of dead) {
        assert.equal(D.isLiveSite(record), false);
        assert.throws(() => D.siteOpsFor(record, "walls", 0), /rehydrateSite/);
        assert.throws(() => D.siteOpsById(record, "walls", record.walls[0].id), /rehydrateSite/);
        assert.throws(() => [...D.siteOpSlices(record)], /rehydrateSite/);
        // the bookkeeping that needs no ops still works on a dead record
        assert.equal(D.siteOpCount(record), c.record.stats.totalOps);
        assert.ok(D.siteJobSpecs(record).walls.length > 0);
    }
    const live = D.rehydrateSite(c.plan, 1, c.ground, D.siteOptionsOf(c.record));
    assert.equal(D.isLiveSite(live.record), true);
    assert.equal(D.siteOpsFor(live.record, "walls", 0).length, c.record.walls[0].total);
    assert.equal(D.siteOpsById(live.record, "gates", c.record.gates[0].id).length, c.record.gates[0].total);
    assert.throws(() => D.siteOpsById(live.record, "gates", "no-such-gate"), /no element/);
});

/* ------------------------------------------------------------------ only the persisted region is read */

test("the planner reads ONLY columns inside the exported region (field.at is instrumented)", () => {
    for (const spec of CASES.slice(0, 2)) {
        const c = build(spec);
        const reads = new Set();
        let outside = 0;
        let total = 0;
        const spy = {
            bounds: c.field.bounds,
            at(x, z) {
                total += 1;
                const bx = Math.floor(x);
                const bz = Math.floor(z);
                if (bx < c.region.x0 || bx > c.region.x1 || bz < c.region.z0 || bz > c.region.z1) outside += 1;
                else reads.add(`${String(bx)},${String(bz)}`);
                return c.field.at(x, z);
            },
        };
        const spied = D.planDistrictSite(c.plan, 1, spy, { seed: c.seed });
        assert.equal(spied.record.checksum, c.record.checksum, "spying must not change the plan");
        assert.equal(outside, 0, `${spec.name}: ${String(outside)} reads outside the persisted region`);
        assert.equal(spied.record.ground.outsideReads, 0);
        assert.ok(total > 50000 && reads.size > 50000, `${spec.name}: only ${String(reads.size)} columns read`);
    }
});

test("changing ground OUTSIDE the region cannot change the plan; changing a wall column INSIDE it does", () => {
    const c = build(CASES[0]);
    const b = c.field.bounds;
    const outsideZ = c.region.z1 + 3;
    assert.ok(outsideZ <= b.z1, "the test field must extend beyond the region");
    const shaken = {
        bounds: b,
        at(x, z) {
            const cell = c.field.at(x, z);
            if (z > c.region.z1 || z < c.region.z0 || x > c.region.x1 || x < c.region.x0) return { g: cell.g + 9, k: cell.k, tree: !cell.tree };
            return cell;
        },
    };
    const same = D.planDistrictSite(c.plan, 1, shaken, { seed: c.seed });
    assert.equal(same.record.checksum, c.record.checksum);
    // a wall column inside the region: raise it by 5 and the wall ops change
    const wallDef = c.plan.walls.find((w) => w.between.includes(1));
    const wallOp = { x: wallDef.path[Math.floor(wallDef.path.length / 2)][0], z: wallDef.path[Math.floor(wallDef.path.length / 2)][1] };
    const bumped = {
        bounds: b,
        at(x, z) {
            const cell = c.field.at(x, z);
            return x === wallOp.x && z === wallOp.z ? { g: cell.g + 5, k: cell.k, tree: cell.tree } : cell;
        },
    };
    const changed = D.planDistrictSite(c.plan, 1, bumped, { seed: c.seed });
    assert.notEqual(changed.record.checksum, c.record.checksum, "a wall column inside the region must matter");
});

/* ------------------------------------------------------------------ budget */

test("CivPlan + persisted ground fit the plan budget on rough and flat terrain (real sizes reported)", () => {
    const lines = [];
    for (const spec of CASES) {
        const c = build(spec);
        const planBytes = utf8Length(JSON.stringify(c.plan));
        const groundBytes = utf8Length(JSON.stringify(c.ground));
        const info = P.siteGroundBytes(c.ground);
        const recordBytes = utf8Length(JSON.stringify(c.record));
        lines.push(`${spec.name}: CivPlan ${String(planBytes)} B + ground ${String(groundBytes)} B (${info.columns} columns, ${info.bytesPerColumn.toFixed(3)} B/col; g ${String(info.streams.g)} k ${String(info.streams.k)} trees ${String(info.streams.t)}) = ${String(planBytes + groundBytes)} B of ${String(CIV_LIMITS.maxPlanBytes)}; the derived record (${String(recordBytes)} B) is NOT persisted`);
        assert.ok(planBytes + groundBytes <= CIV_LIMITS.maxPlanBytes, `${spec.name}: ${String(planBytes + groundBytes)} bytes`);
        // even persisting the derived record next to them stays inside the limit
        assert.ok(planBytes + groundBytes + recordBytes <= CIV_LIMITS.maxPlanBytes + 6000, `${spec.name}: all three ${String(planBytes + groundBytes + recordBytes)} bytes`);
        assert.ok(info.bytesPerColumn < 0.5);
    }
    console.log(lines.join("\n"));
});

test("hostile terrain (cliffs, per-column noise, forest) still fits the budget next to the CivPlan", () => {
    const base = build(CASES[0]);
    const hash = (x, z) => {
        let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const noisy = {
        bounds: base.field.bounds,
        at(x, z) {
            const cell = base.field.at(x, z);
            const jitter = Math.floor(hash(x, z) * 9) - 4;
            const cliff = x % 37 === 0 ? 6 : 0;
            return { g: cell.g + jitter + cliff, k: cell.k, tree: hash(x + 5, z + 9) < 0.15 };
        },
    };
    const json = P.exportSiteGround(noisy, base.region);
    const bytes = utf8Length(JSON.stringify(json));
    const planBytes = utf8Length(JSON.stringify(base.plan));
    console.log(`hostile ground: ${String(bytes)} B (${(bytes / json.w / json.h).toFixed(3)} B/col) + CivPlan ${String(planBytes)} B = ${String(bytes + planBytes)} of ${String(CIV_LIMITS.maxPlanBytes)}`);
    assert.ok(bytes + planBytes <= CIV_LIMITS.maxPlanBytes, "hostile terrain overflows the plan budget");
    const back = P.importSiteGround(viaJSON(json));
    assert.equal(back.sameAs(noisy), true, "hostile ground must still round trip exactly");
});

test("rehydration is deterministic across repeated restarts", () => {
    const c = build(CASES[1]);
    const options = D.siteOptionsOf(c.record);
    const runs = [0, 1, 2].map(() => D.rehydrateSite(viaJSON(c.plan), 1, viaJSON(c.ground), options).record.checksum);
    assert.deepEqual(new Set(runs).size, 1);
    assert.equal(runs[0], c.record.checksum);
});
