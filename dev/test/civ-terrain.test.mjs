import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (...parts) => import(pathToFileURL(join(root, "CivilizationApocalypse_BP", "scripts", ...parts)).href);
const F = await load("civ", "field.js");
const S = await load("civ", "siteselect.js");
const B = await load("civ", "foundations.js");
const { makeField, valueNoise } = await import(pathToFileURL(join(root, "dev", "lib", "fakefield.mjs")).href);

const ANCHOR = { x: 0, z: 0 };
const STEP = 8;

/** Custom field from a sampler, bounded to +-half. */
function custom(fn, half = 800) {
    return {
        bounds: { x0: -half, z0: -half, x1: half - 1, z1: half - 1 },
        at(x, z) {
            if (x < -half || x >= half || z < -half || z >= half) return { g: 0, k: "unloaded", tree: false };
            return fn(x, z);
        },
    };
}
const land = (g = 70, tree = false) => ({ g, k: "land", tree });
const flat = (half = 800) => custom(() => land(), half);

/** Run the real runtime flow: planScan -> fill a GridField -> rankSites on the grid. */
function scanned(field, options = {}) {
    const radius = S.scanRadiusFor(options);
    const plan = S.planScan(ANCHOR, radius, options.step ?? STEP);
    const m = Math.ceil(radius / (options.step ?? STEP)) * (options.step ?? STEP);
    const grid = F.makeGridField({ x0: -m, z0: -m, w: 2 * m + 1, h: 2 * m + 1, step: options.step ?? STEP });
    for (const p of plan.points) grid.set(p.x, p.z, field.at(p.x, p.z));
    return { grid, plan };
}

const uniqueKinds = (field, cand, step = STEP) => {
    // independent oracle: count cells in the candidate window directly from the source field
    const n = 60;
    let water = 0;
    let lava = 0;
    let unloaded = 0;
    for (let j = -30; j < 30; j += 1) {
        for (let i = -30; i < 30; i += 1) {
            const k = field.at(cand.x + i * step, cand.z + j * step).k;
            if (k === "water") water += 1;
            else if (k === "lava") lava += 1;
            else if (k === "unloaded") unloaded += 1;
        }
    }
    return { water: water / (n * n), lava: lava / (n * n), unloaded };
};

// ------------------------------------------------------------------------------------ field

test("grid field: memory budget for a 700x700 field is under 3 MB and reads back what was written", () => {
    const f = F.makeGridField({ x0: -350, z0: -350, w: 700, h: 700 });
    assert.ok(f.memoryBytes() < 3 * 1024 * 1024, `memory ${String(f.memoryBytes())}`);
    assert.equal(f.at(0, 0).k, "unloaded", "unwritten cells are unloaded");
    assert.equal(f.columnsRead, 0);
    const src = makeField(5, { size: 700, relief: 12, lakes: [{ x: 0, z: 0, r: 40 }], forest: 0.6 });
    for (let z = -350; z < 350; z += 1) for (let x = -350; x < 350; x += 1) f.set(x, z, src.at(x, z));
    assert.equal(f.columnsRead, 700 * 700);
    for (const [x, z] of [[0, 0], [-350, -350], [349, 349], [10, -200], [200, 77]]) assert.deepEqual(f.at(x, z), src.at(x, z));
    assert.equal(f.at(350, 0).k, "unloaded");
    assert.equal(f.at(-351, 0).k, "unloaded");
    f.set(9999, 9999, land()); // outside: ignored
    assert.equal(f.columnsRead, 700 * 700);
});

test("grid field: JSON round trip is exact (with and without relief) and compressed, corruption throws", () => {
    const src = makeField(11, { size: 300, relief: 8, river: { z: 0, width: 20, wiggle: 15 }, forest: 0.5 });
    const f = F.makeGridField({ x0: -150, z0: -150, w: 300, h: 300 });
    for (let z = -150; z < 150; z += 1) for (let x = -150; x < 150; x += 1) if (x < 100) f.set(x, z, src.at(x, z)); // right part never read
    const text = JSON.stringify(f);
    const g = F.fromJSON(text);
    assert.equal(g.columnsRead, f.columnsRead);
    for (let z = -150; z < 150; z += 7) for (let x = -150; x < 150; x += 5) assert.deepEqual(g.at(x, z), f.at(x, z), `${String(x)},${String(z)}`);
    assert.equal(g.at(120, 0).k, "unloaded");
    assert.ok(text.length < 300 * 300 * 4, `serialised ${String(text.length)} chars should beat 4 chars per column`);
    const r = F.resample(src, 8);
    const r2 = F.fromJSON(JSON.parse(JSON.stringify(r)));
    assert.equal(r2.reliefAt(0, 0), r.reliefAt(0, 0));
    assert.deepEqual(r2.at(8, 8), r.at(8, 8));
    const broken = JSON.parse(text);
    broken.ground = broken.ground.slice(0, -2);
    assert.throws(() => F.fromJSON(broken), /corrupt/);
    assert.throws(() => F.fromJSON({ ...JSON.parse(text), v: 99 }), /version/);
});

test("resample is pessimistic: any water/lava/unloaded sample taints the cell, trees and relief are kept", () => {
    const src = custom((x, z) => (x === 3 && z === 3 ? { g: 70, k: "lava", tree: false } : x === 13 && z === 5 ? { g: 70, k: "water", tree: false } : land(70 + (x >= 8 ? 6 : 0), x < 8)), 64);
    const r = F.resample(src, 8);
    assert.equal(r.at(0, 0).k, "lava");
    assert.equal(r.at(8, 0).k, "water");
    assert.equal(r.at(16, 16).k, "land");
    assert.equal(r.at(40, 40).g, 76);
    assert.equal(r.at(-70, 0).k, "unloaded");
    assert.equal(r.step, 8);
});

test("suitabilityCell: flat is usable; lava, water, cliffs and unloaded neighbours are not", () => {
    assert.equal(F.suitabilityCell(flat(), 0, 0, 8).usable, true);
    const lavaNear = custom((x) => (x >= 8 ? { g: 70, k: "lava", tree: false } : land()));
    const a = F.suitabilityCell(lavaNear, 0, 0, 8);
    assert.equal(a.usable, false);
    assert.equal(a.nearLava, true);
    const water = custom(() => ({ g: 60, k: "water", tree: false }));
    assert.equal(F.suitabilityCell(water, 0, 0, 8).code, 3);
    const cliff = custom((x) => land(70 + (x >= 4 ? 30 : 0)));
    assert.equal(F.suitabilityCell(cliff, 0, 0, 8).code, 2);
    assert.equal(F.suitabilityCell(flat(10), 8, 0, 8).usable, false, "edge of the loaded world");
    const shore = custom((x) => (x >= 8 ? { g: 66, k: "water", tree: false } : land()));
    const s = F.suitabilityCell(shore, 0, 0, 8);
    assert.ok(s.usable && s.nearWater);
});

// ------------------------------------------------------------------------------------ scan plan

test("planScan: nearest first, lattice aligned to the anchor, slices cover every point once", () => {
    const plan = S.planScan({ x: 5, z: -3 }, 100, 10);
    assert.equal(plan.count, 21 * 21);
    let last = -1;
    for (const p of plan.points) {
        const d = (p.x - 5) ** 2 + (p.z + 3) ** 2;
        assert.ok(d >= last, "squared distance never decreases");
        last = d;
        assert.equal(Math.abs((p.x - 5) % 10), 0);
        assert.equal(Math.abs((p.z + 3) % 10), 0);
    }
    assert.deepEqual(plan.points[0], { x: 5, z: -3 });
    let cursor = 0;
    const seen = new Set();
    let slices = 0;
    for (;;) {
        const s = S.sliceScan(plan, cursor, 50);
        for (const p of s.points) {
            const key = `${String(p.x)},${String(p.z)}`;
            assert.ok(!seen.has(key));
            seen.add(key);
        }
        cursor = s.next;
        slices += 1;
        if (s.done) break;
    }
    assert.equal(seen.size, plan.count);
    assert.equal(slices, Math.ceil(plan.count / 50));
    assert.throws(() => S.planScan(ANCHOR, 10, 0));
});

test("read counts are bounded: estimate matches the scan plan and rankSites never reads more", () => {
    const est = S.estimateScan();
    const plan = S.planScan(ANCHOR, est.radius, est.step);
    assert.equal(plan.count, est.columns);
    assert.ok(est.columns < 20000, `default scan is ${String(est.columns)} columns`);
    let calls = 0;
    const base = flat();
    const counted = { bounds: base.bounds, at: (x, z) => { calls += 1; return base.at(x, z); } };
    const r = S.rankSites(counted, ANCHOR);
    assert.equal(calls, r.reads);
    assert.ok(r.reads <= est.columns, `${String(r.reads)} <= ${String(est.columns)}`);
    assert.ok(r.evaluated >= 200 && r.evaluated < 600, `candidates ${String(r.evaluated)}`);
    assert.equal(est.candidates, r.evaluated);
});

// ------------------------------------------------------------------------------------ ranking

test("flat terrain: the anchor itself wins, result is deterministic and the runtime path (planScan -> grid) agrees", (t) => {
    const field = flat();
    const t0 = performance.now();
    const a = S.rankSites(field, ANCHOR);
    const ms = performance.now() - t0;
    t.diagnostic(`rankSites flat: ${ms.toFixed(1)} ms, ${String(a.reads)} reads, ${String(a.evaluated)} candidates`);
    const b = S.rankSites(field, ANCHOR);
    assert.deepEqual(a, b);
    assert.ok(a.site);
    assert.equal(a.site.distance, 0);
    assert.deepEqual([a.site.x, a.site.z], [0, 0]);
    assert.ok(a.site.usableColumns >= 190000);
    assert.equal(a.site.prep.total, 0);
    const { grid } = scanned(field);
    assert.deepEqual(S.rankSites(grid, ANCHOR).site, a.site);
    assert.ok(ms < 1500, "ranking is cheap");
});

test("nearest suitable site wins (independent oracle over every candidate, cost ignored)", () => {
    // lake covering the anchor: candidates are suitable only when the 12% water cap and land centre hold
    const field = custom((x, z) => ((x - 30) ** 2 + (z + 10) ** 2 <= 130 ** 2 ? { g: 66, k: "water", tree: false } : land()));
    const opts = { prepWeight: 1e12, maxCandidates: 5000 };
    const r = S.rankSites(field, ANCHOR, opts);
    assert.ok(r.site, r.reasons.join(" | "));
    assert.ok(r.site.distance > 150, "the lake forces the site away from the anchor");
    for (const c of r.candidates) {
        const o = uniqueKinds(field, c);
        const centreKind = field.at(c.x, c.z).k;
        const expect = centreKind === "land" && o.water <= 0.12 && o.lava === 0 && o.unloaded === 0 && 1 - o.water >= 0.8247;
        // lake-edge cells may be classified as shore; water cells are only counted exactly, so allow the oracle to be the stricter side
        if (c.suitable) assert.ok(expect, `candidate (${String(c.x)},${String(c.z)}) marked suitable but oracle disagrees (${JSON.stringify(o)})`);
        else if (expect) assert.fail(`candidate (${String(c.x)},${String(c.z)}) is fine by the oracle but was rejected: ${c.failures.join("; ")}`);
    }
    const suitable = r.candidates.filter((c) => c.suitable);
    const nearest = Math.min(...suitable.map((c) => c.distance));
    assert.equal(r.site.distance, nearest);
    for (const c of r.candidates) if (!c.suitable) assert.ok(c.distance >= nearest || c.failures.length > 0);
});

test("preparation cost can beat a slightly nearer site, and cost weight is honoured", () => {
    // bumpy ground west of the anchor (dev), perfectly flat east. Lake forces the choice between two shifted sites.
    const bumpy = custom((x, z) => {
        if ((x - 0) ** 2 + (z - 0) ** 2 <= 70 ** 2) return { g: 60, k: "water", tree: false };
        return land(x < 0 ? 70 + Math.round(2.5 * Math.sin(x / 9) * Math.cos(z / 7)) : 70);
    });
    const cheap = S.rankSites(bumpy, ANCHOR, { prepWeight: 1e12, maxWaterFraction: 0.05 });
    const heavy = S.rankSites(bumpy, ANCHOR, { prepWeight: 20, maxWaterFraction: 0.05 });
    assert.ok(cheap.site && heavy.site);
    assert.ok(heavy.site.prep.total <= cheap.site.prep.total, "a heavy cost weight never chooses a more expensive site");
    assert.ok(heavy.site.distance >= cheap.site.distance, "and may only pay for it with distance");
    const brute = cheap.candidates.filter((c) => c.suitable);
    for (const c of brute) assert.ok(c.distance >= cheap.site.distance - 1e-9);
});

test("hills, river, cliffs, forest: sites adapt to the terrain and are reproducible", () => {
    const terrains = {
        hills: makeField(3, { size: 1600, relief: 14, hills: 90 }),
        river: makeField(4, { size: 1600, relief: 4, river: { z: 10, width: 70, wiggle: 20 } }),
        cliffs: makeField(5, { size: 1600, relief: 3, cliffs: [{ x: 60, z0: -800, z1: 799, drop: 30 }] }),
        forest: makeField(6, { size: 1600, relief: 4, forest: 1 }),
    };
    for (const [name, field] of Object.entries(terrains)) {
        const a = S.rankSites(field, ANCHOR);
        const b = S.rankSites(field, ANCHOR);
        assert.deepEqual(a, b, name);
        assert.ok(a.site, `${name}: ${a.reasons.join(" | ")}`);
        const o = uniqueKinds(field, a.site);
        assert.ok(o.lava === 0 && o.unloaded === 0, `${name} ${JSON.stringify(o)}`);
        const centre = field.at(a.site.x, a.site.z).k;
        assert.ok(centre === "land" || centre === "water", `${name}: centre is ${centre}, never lava or unknown`);
        assert.ok(a.site.usableColumns >= 190000 * 0.99, `${name}: ${String(a.site.usableColumns)} usable columns`);
        for (const c of a.candidates) if (c.suitable) assert.ok(c.score >= a.site.score - 1e-9, `${name}: winner has the lowest score`);
    }
    // water and steep ground are costed, not vetoed: a river window carries a pier estimate, a cliff
    // window carries terrace work, and the winner still keeps most of its window off the drop.
    const river = S.rankSites(terrains.river, ANCHOR).site;
    assert.ok(river.prep.water > 0 && river.waterFraction > 0.12, "an open river is spanned, its columns costed");
    const cliff = S.rankSites(terrains.cliffs, ANCHOR).site;
    assert.ok(cliff.prep.terrace > 0, "cliff work is estimated rather than refused");
    assert.ok(cliff.steepFraction < 1, "the winner keeps most of its window off the drop");
    const hills = S.rankSites(terrains.hills, ANCHOR).site;
    assert.ok(hills.prep.cut > 0 && hills.prep.fill > 0, "rough ground is cut and filled to a common level");
    // forest: tree clearing shows up in the preparation estimate
    const dense = custom((x, z) => land(70, ((x >> 3) + (z >> 3)) % 3 === 0));
    const clear = S.rankSites(dense, ANCHOR).site;
    assert.ok(clear && clear.prep.clear > 0 && clear.treeFraction > 0.2);
    assert.equal(S.rankSites(flat(), ANCHOR).site.prep.clear, 0);
});

test("exclusions: rectangle, polygon, centre/half form are all honoured, exactly", () => {
    const field = flat();
    const hearth = { x0: -24, z0: -24, x1: 24, z1: 24 };
    const base = S.rankSites(field, ANCHOR).site;
    const wide = { searchRadius: 400 };
    const withRect = S.rankSites(field, ANCHOR, { ...wide, exclusions: [hearth] }).site;
    assert.ok(base && withRect);
    assert.equal(base.distance, 0);
    assert.ok(withRect.distance >= 24 + 16 + 240 - 24, "must move clear of the protected footprint plus margin");
    assert.equal(S.overlapsExclusion(withRect.window, [hearth]), false);
    assert.equal(S.overlapsExclusion(base.window, [hearth]), true, "the oracle can detect overlap");
    const tri = { points: [[-30, -30], [200, -10], [40, 150]] };
    const withTri = S.rankSites(field, ANCHOR, { ...wide, exclusions: [tri] }).site;
    assert.ok(withTri);
    assert.equal(S.overlapsExclusion(withTri.window, [tri]), false);
    assert.equal(S.overlapsExclusion(withTri.window, [tri], 16), false, "margin kept");
    const withHalf = S.rankSites(field, ANCHOR, { ...wide, exclusions: [{ cx: 0, cz: 0, half: 24 }] }).site;
    assert.deepEqual([withHalf.x, withHalf.z], [withRect.x, withRect.z]);
    // an exclusion that blankets the search area leaves no site and says why
    const huge = S.rankSites(field, ANCHOR, { exclusions: [{ x0: -2000, z0: -2000, x1: 2000, z1: 2000 }] });
    assert.equal(huge.site, null);
    assert.ok(huge.reasons.some((r) => /protected/.test(r)), huge.reasons.join(" | "));
    // carve mode allows enclosing the old footprint but never counts it as usable
    const carve = S.rankSites(field, ANCHOR, { exclusions: [hearth], exclusionMode: "carve" }).site;
    assert.ok(carve);
    assert.ok(carve.distance > 0 && carve.distance < 100, "centre may not sit on the protected footprint, but the window can enclose it");
    assert.equal(S.overlapsExclusion(carve.window, [hearth]), true);
    assert.ok(carve.usableColumns <= 230400 - 49 * 49);
});

test("exclusion polygon edge crossing a window without containing any corner is still detected", () => {
    const thin = { points: [[-500, 5], [500, 5], [500, 9], [-500, 9]] };
    assert.equal(S.overlapsExclusion({ x0: -50, z0: -50, x1: 50, z1: 50 }, [thin]), true);
    assert.equal(S.overlapsExclusion({ x0: -50, z0: 20, x1: 50, z1: 80 }, [thin]), false);
    assert.equal(S.overlapsExclusion({ x0: -50, z0: 20, x1: 50, z1: 80 }, [thin], 12), true);
});

test("adaptive sites: open sea and steep ground are accepted; lava, unloaded, enclosed water, empty ground and an unreachable shore are explained", () => {
    // all sea: every column is buildable as a pier, and the centre may stand in water
    const seaField = custom(() => ({ g: 60, k: "water", tree: false }));
    const water = S.rankSites(seaField, ANCHOR);
    assert.ok(water.site, water.reasons.join(" | "));
    assert.equal(water.site.waterFraction, 1);
    assert.equal(seaField.at(water.site.x, water.site.z).k, "water");
    assert.equal(water.site.usableColumns, 230400, "land, water (piers) and steep ground (decks) are all preparable");
    assert.ok(water.site.prep.water > 0, "pier cost is estimated");

    // a 25-block checkerboard: steep ground is estimated as terrace work, not a veto
    const stairs = custom((x, z) => land(70 + (((x >> 4) + (z >> 4)) & 1) * 25));
    const cliff = S.rankSites(stairs, ANCHOR);
    assert.ok(cliff.site, cliff.reasons.join(" | "));
    assert.equal(cliff.site.steepFraction, 1);
    assert.ok(cliff.site.prep.terrace > 0);

    // a lake wholly inside every reachable window cannot form one solid district: refused with a reason
    const lake = custom((x, z) => (x * x + z * z <= 130 ** 2 ? { g: 66, k: "water", tree: false } : land()));
    const enclosed = S.rankSites(lake, ANCHOR, { searchRadius: 0 });
    assert.equal(enclosed.site, null);
    assert.ok(enclosed.reasons.some((r) => /enclosed water/.test(r)), enclosed.reasons.join(" | "));

    const lava = S.rankSites(custom((x, z) => (x * x + z * z <= 100 ** 2 ? { g: 70, k: "lava", tree: false } : land())), ANCHOR);
    assert.equal(lava.site, null);
    assert.ok(lava.reasons.some((r) => /anchor itself is lava/.test(r)), lava.reasons.join(" | "));

    const tiny = S.rankSites(flat(100), ANCHOR);
    assert.equal(tiny.site, null);
    assert.ok(tiny.reasons.some((r) => /unloaded/.test(r)), tiny.reasons.join(" | "));

    const empty = S.rankSites(custom(() => ({ g: 0, k: "unloaded", tree: false })), ANCHOR);
    assert.equal(empty.site, null);
    assert.ok(empty.reasons.some((r) => /no terrain has been scanned/.test(r)));

    // dense forest is cleared, its cost is counted
    const forest = S.rankSites(custom(() => land(70, true)), ANCHOR);
    assert.ok(forest.site, forest.reasons.join(" | "));
    assert.equal(forest.site.treeFraction, 1);
    assert.ok(forest.site.prep.clear > 0, "clearing every tree is costed");

    // an all-sea window is itself a site, so a shore beyond the radius never needs to be reached
    const sea = custom((x, z) => (Math.abs(x) < 400 && Math.abs(z) < 400 ? { g: 60, k: "water", tree: false } : land()), 1600);
    const far = S.rankSites(sea, ANCHOR);
    assert.ok(far.site && far.site.waterFraction === 1, "the sea is built on, not crossed to the far shore");
});

test("never selects lava: a small lava pool pushes the window away from it", () => {
    const pool = custom((x, z) => ((x - 5) ** 2 + (z - 5) ** 2 <= 20 ** 2 ? { g: 70, k: "lava", tree: false } : land()), 1100);
    const r = S.rankSites(pool, ANCHOR, { searchRadius: 400, maxCandidates: 5000 });
    assert.ok(r.site, r.reasons.join(" | "));
    assert.equal(uniqueKinds(pool, r.site).lava, 0);
    assert.ok(r.site.distance > 200);
    for (const c of r.candidates) if (c.suitable) assert.equal(uniqueKinds(pool, c).lava, 0);
});

test("estimateOperations converts prep blocks into write slices", () => {
    const e = S.estimateOperations({ prep: { cut: 1000, fill: 2000, clear: 500 } }, { writesPerSlice: 500 });
    assert.deepEqual([e.total, e.slices], [3500, 7]);
});

// ------------------------------------------------------------------------------------ foundations helpers

/** Apply ops to an implicit world where everything at y <= ground is solid; returns column state. */
function simulate(profile, ops) {
    const cols = new Map();
    const col = (x, z) => {
        const key = `${String(x)},${String(z)}`;
        let c = cols.get(key);
        if (!c) {
            const p = B.profileAt(profile, x, z);
            c = { ground: p ? p.g : NaN, set: new Map() };
            cols.set(key, c);
        }
        return c;
    };
    for (const o of ops) col(o.x, o.z).set.set(o.y, o.id);
    const solid = (x, z, y) => {
        const c = col(x, z);
        const v = c.set.get(y);
        return v !== undefined ? v !== "minecraft:air" : y <= c.ground;
    };
    const top = (x, z) => {
        const c = col(x, z);
        let y = Math.max(c.ground, ...c.set.keys());
        while (!solid(x, z, y)) y -= 1;
        return y;
    };
    return { solid, top, touched: [...cols.keys()] };
}

const slopeProfile = (gx, gz, base = 70, x0 = 0, z0 = 0, w = 24, h = 24) =>
    B.makeProfile(x0, z0, w, h, (x, z) => ({ g: base + Math.round(x * gx + z * gz) }));

// ------------------------------------------------------------------------------------ pads

test("pad on a slope: surface level, limits respected, nothing touched outside rect + 1", () => {
    const profile = slopeProfile(0.3, 0.1);
    const rect = { x0: 6, z0: 6, x1: 11, z1: 11 };
    const limits = { maxCut: 3, maxFill: 3, maxWall: 4 };
    const p = B.planPad(profile, rect, limits);
    assert.ok(p.ok, p.problems.join("; "));
    const sim = simulate(profile, p.ops);
    for (let z = rect.z0; z <= rect.z1; z += 1) {
        for (let x = rect.x0; x <= rect.x1; x += 1) {
            const g = B.profileAt(profile, x, z).g;
            assert.equal(sim.top(x, z), p.baseY, "level surface");
            assert.ok(g - p.baseY <= limits.maxCut && p.baseY - g <= limits.maxFill, "cut/fill within limits");
            for (let y = p.baseY - 1; y >= Math.min(g, p.baseY) - 1; y -= 1) assert.ok(sim.solid(x, z, y), "no hollow under the pad");
        }
    }
    for (const o of p.ops) {
        assert.ok(o.x >= rect.x0 - 1 && o.x <= rect.x1 + 1 && o.z >= rect.z0 - 1 && o.z <= rect.z1 + 1, `op outside apron: ${JSON.stringify(o)}`);
    }
    assert.ok(p.counts.cut > 0 && p.counts.fill > 0);
    assert.equal(p.counts.cut + p.counts.fill + p.counts.top + p.counts.retain + p.counts.stair, p.ops.length);
});

test("pad: property over many noisy spots - ok pads obey every limit, failed pads emit nothing", () => {
    let ok = 0;
    let refused = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
        const profile = B.makeProfile(0, 0, 40, 40, (x, z) => ({ g: 70 + Math.round((valueNoise(x, z, 9, seed) - 0.5) * 2 * (3 + seed * 0.5)) }));
        const rect = { x0: 10 + (seed % 5), z0: 12, x1: 17 + (seed % 5), z1: 18 };
        const limits = { maxCut: 2 + (seed % 3), maxFill: 2 + (seed % 2), maxWall: 3 };
        const p = B.planPad(profile, rect, limits);
        if (!p.ok) {
            refused += 1;
            assert.equal(p.ops.length, 0);
            assert.ok(p.problems.length > 0);
            continue;
        }
        ok += 1;
        const sim = simulate(profile, p.ops);
        for (let z = rect.z0; z <= rect.z1; z += 1) {
            for (let x = rect.x0; x <= rect.x1; x += 1) {
                const g = B.profileAt(profile, x, z).g;
                assert.ok(g - p.baseY <= limits.maxCut && p.baseY - g <= limits.maxFill, `seed ${String(seed)} limits`);
                assert.equal(sim.top(x, z), p.baseY);
            }
        }
        for (const o of p.ops) assert.ok(o.x >= rect.x0 - 1 && o.x <= rect.x1 + 1 && o.z >= rect.z0 - 1 && o.z <= rect.z1 + 1);
        for (const key of sim.touched) {
            const [x, z] = key.split(",").map(Number);
            assert.ok(x >= rect.x0 - 1 && x <= rect.x1 + 1 && z >= rect.z0 - 1 && z <= rect.z1 + 1);
        }
        // apron walls: any column that differs from the pad by >= 2 is walled up to the pad level
        for (let z = rect.z0 - 1; z <= rect.z1 + 1; z += 1) {
            for (let x = rect.x0 - 1; x <= rect.x1 + 1; x += 1) {
                const inside = x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
                if (inside) continue;
                const g = B.profileAt(profile, x, z).g;
                assert.ok(Math.abs(g - p.baseY) <= limits.maxWall || Math.abs(g - p.baseY) < 2);
                if (g - p.baseY >= 2) assert.ok(p.ops.filter((o) => o.x === x && o.z === z && o.kind === "retain").length === g - p.baseY);
                if (p.baseY - g >= 2) assert.ok(p.ops.filter((o) => o.x === x && o.z === z && o.kind === "retain").length === p.baseY - g);
            }
        }
    }
    assert.ok(ok >= 5 && refused >= 3, `both outcomes exercised (ok ${String(ok)}, refused ${String(refused)})`);
});

test("pad refuses: too steep, water, hollow, profile too small, bad rect, tiny limits", () => {
    const cliff = B.makeProfile(0, 0, 20, 20, (x) => ({ g: 70 + (x > 8 ? 12 : 0) }));
    const a = B.planPad(cliff, { x0: 5, z0: 5, x1: 12, z1: 12 }, { maxCut: 4, maxFill: 4 });
    assert.equal(a.ok, false);
    assert.equal(a.ops.length, 0);
    assert.match(a.problems[0], /uneven/);
    const wet = B.makeProfile(0, 0, 20, 20, (x, z) => (x === 7 && z === 7 ? { g: 60, water: 68 } : { g: 70 }));
    assert.match(B.planPad(wet, { x0: 5, z0: 5, x1: 9, z1: 9 }).problems[0], /water/);
    const wetApron = B.planPad(wet, { x0: 8, z0: 8, x1: 12, z1: 12 });
    assert.equal(wetApron.ok, false, "water on the apron also refuses");
    const hollow = B.makeProfile(0, 0, 20, 20, (x, z) => ({ g: 70, hollow: x === 6 && z === 6 }));
    assert.match(B.planPad(hollow, { x0: 5, z0: 5, x1: 9, z1: 9 }).problems[0], /hollow/);
    const edge = B.planPad(slopeProfile(0, 0), { x0: 0, z0: 5, x1: 5, z1: 9 });
    assert.match(edge.problems[0], /does not cover/);
    assert.equal(B.planPad(slopeProfile(0, 0), { x0: 9, z0: 5, x1: 5, z1: 9 }).ok, false);
    const ramp = slopeProfile(1, 0);
    assert.equal(B.planPad(ramp, { x0: 5, z0: 5, x1: 12, z1: 9 }, { maxCut: 2, maxFill: 2 }).ok, false);
    assert.equal(B.planPad(ramp, { x0: 5, z0: 5, x1: 12, z1: 9 }, { maxCut: 4, maxFill: 4, maxWall: 6 }).ok, true);
    // walls too tall beside an otherwise flat pad
    const ledge = B.makeProfile(0, 0, 20, 20, (x) => ({ g: x >= 11 ? 80 : 70 }));
    const tall = B.planPad(ledge, { x0: 5, z0: 5, x1: 9, z1: 9 }, { maxWall: 4 });
    assert.equal(tall.ok, true, "ledge two blocks away from the apron is not touched");
    const near = B.planPad(ledge, { x0: 5, z0: 5, x1: 10, z1: 9 }, { maxWall: 4 });
    assert.equal(near.ok, false, "a 10-block wall on the apron exceeds maxWall");
});

test("pad: stairs only for 1-block neighbours, retaining wall for 2+, flat apron needs neither", () => {
    const flatP = slopeProfile(0, 0);
    const p0 = B.planPad(flatP, { x0: 5, z0: 5, x1: 8, z1: 8 });
    assert.deepEqual(p0.counts, { cut: 0, fill: 0, top: 0, retain: 0, stair: 0 });
    const step = B.makeProfile(0, 0, 20, 20, (x) => ({ g: x >= 9 ? 71 : 70 }));
    const p1 = B.planPad(step, { x0: 5, z0: 5, x1: 8, z1: 8 }, { baseY: 70 });
    assert.ok(p1.counts.stair > 0 && p1.counts.retain === 0);
    assert.ok(p1.ops.filter((o) => o.kind === "stair").every((o) => o.dir === "east" && o.x === 9));
    const wall = B.makeProfile(0, 0, 20, 20, (x) => ({ g: x >= 9 ? 73 : 70 }));
    const p2 = B.planPad(wall, { x0: 5, z0: 5, x1: 8, z1: 8 }, { baseY: 70 });
    assert.equal(p2.ok, true);
    assert.equal(p2.counts.retain, 3 * 6, "3 high x 6 apron cells on the east side (incl. corners)");
});

// ------------------------------------------------------------------------------------ foundation columns

test("foundation columns reach natural ground on slopes, cliffs and shallow water", () => {
    const profile = B.makeProfile(0, 0, 20, 20, (x, z) => {
        if (x >= 12) return { g: 62, water: 68 }; // pond bed 62, surface 68
        return { g: 70 - Math.floor(x / 2) };
    });
    const rect = { x0: 4, z0: 4, x1: 14, z1: 8 };
    const r = B.planFoundationColumns(profile, { rect, floorY: 71 });
    assert.ok(r.ok, r.problems.join("; "));
    assert.equal(r.columns.length, 11 * 5);
    for (const c of r.columns) {
        const ys = r.ops.filter((o) => o.x === c.x && o.z === c.z).map((o) => o.y).sort((a, b) => a - b);
        assert.equal(ys.length, c.depth);
        if (ys.length > 0) {
            assert.equal(ys[0], c.ground + 1, "starts on the ground");
            assert.equal(ys.at(-1), 70, "ends just under the floor");
            for (let i = 1; i < ys.length; i += 1) assert.equal(ys[i], ys[i - 1] + 1, "no gaps");
        } else assert.equal(c.ground, 70);
    }
    assert.ok(r.counts.maxDepth >= 8 && r.counts.maxDepth <= 8 + 1);
    assert.ok(r.columns.some((c) => c.water));
    assert.equal(r.ops.find((o) => o.y === 70).id, "minecraft:stone_bricks");
});

test("foundation columns refuse hollow ground, ground above the floor, depth beyond max, and holes in the profile", () => {
    const base = B.makeProfile(0, 0, 12, 12, (x, z) => ({ g: 70, hollow: x === 5 && z === 5 }));
    const rect = { x0: 3, z0: 3, x1: 8, z1: 8 };
    const hollow = B.planFoundationColumns(base, { rect, floorY: 72 });
    assert.equal(hollow.ok, false);
    assert.equal(hollow.ops.length, 0);
    assert.match(hollow.problems[0], /hollow/);
    const flat70 = B.makeProfile(0, 0, 12, 12, () => ({ g: 70 }));
    assert.match(B.planFoundationColumns(flat70, { rect, floorY: 70 }).problems[0], /cut a pad/);
    const deep = B.planFoundationColumns(flat70, { rect, floorY: 90 }, { maxDepth: 8 });
    assert.equal(deep.ok, false);
    assert.match(deep.problems[0], /deep/);
    assert.equal(B.planFoundationColumns(flat70, { rect, floorY: 79 }, { maxDepth: 8 }).ok, true);
    assert.equal(B.planFoundationColumns(flat70, { rect: { x0: 8, z0: 8, x1: 14, z1: 9 }, floorY: 72 }).ok, false);
    assert.equal(B.planFoundationColumns(flat70, { cells: [], floorY: 72 }).ok, false);
    const cells = B.planFoundationColumns(flat70, { cells: [{ x: 1, z: 1 }, { x: 2, z: 1 }], floorY: 74 });
    assert.equal(cells.ops.length, 6);
});

// ------------------------------------------------------------------------------------ walls

test("wall profile: continuous top line (step <= 1), never below ground + height, no gaps under steps", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
        const ground = Array.from({ length: 80 }, (_, i) => 70 + Math.round((valueNoise(i, 3, 6, seed) - 0.5) * 2 * (2 + seed * 0.4)));
        const w = B.planWallProfile(ground, 5, { maxExtra: 40 });
        assert.ok(w.ok, w.problems.join("; "));
        const cols = w.columns;
        for (let i = 0; i < cols.length; i += 1) {
            assert.ok(cols[i].top >= ground[i] + 5, "wall is at least `height` tall");
            assert.ok(cols[i].base <= ground[i] - 1, "footing below ground");
            if (i > 0) {
                assert.ok(Math.abs(cols[i].top - cols[i - 1].top) <= 1, `top line steps ${String(cols[i].top - cols[i - 1].top)}`);
                // no daylight: vertical ranges of neighbours overlap and the lower column's base is below both grounds
                assert.ok(cols[i].base <= Math.min(ground[i], ground[i - 1]) - 1);
                assert.ok(cols[i].top >= cols[i - 1].base && cols[i - 1].top >= cols[i].base);
            }
            const ys = w.ops.filter((o) => o.x === cols[i].x).map((o) => o.y).sort((a, b) => a - b);
            assert.equal(ys.length, cols[i].top - cols[i].base + 1);
            assert.equal(ys[0], cols[i].base);
            assert.equal(ys.at(-1), cols[i].top);
        }
    }
});

test("wall profile minimality and refusal on cliffs / bad input", () => {
    const w = B.planWallProfile([70, 70, 70, 70], 4);
    assert.deepEqual(w.columns.map((c) => c.top), [74, 74, 74, 74]);
    const ridge = B.planWallProfile([70, 70, 74, 74], 4, { maxExtra: 10 });
    assert.deepEqual(ridge.columns.map((c) => c.top), [76, 77, 78, 78], "rise anticipated one block per block");
    const cliff = B.planWallProfile([70, 70, 70, 100, 100], 4);
    assert.equal(cliff.ok, false);
    assert.match(cliff.problems[0], /drops too sharply/);
    assert.equal(cliff.ops.length, 0);
    assert.equal(B.planWallProfile([], 4).ok, false);
    assert.equal(B.planWallProfile([70, NaN], 4).ok, false);
    assert.equal(B.planWallProfile([70], 0).ok, false);
    const xz = B.planWallProfile([{ x: 5, z: 7, g: 70 }, { x: 6, z: 7, g: 71 }], 3);
    assert.deepEqual(xz.columns.map((c) => [c.x, c.z]), [[5, 7], [6, 7]]);
});

// ------------------------------------------------------------------------------------ stairs

test("stairs: at most 1 rise per block, L-shaped runs, refuse over-steep, support under the run", () => {
    const up = B.planStairs({ x: 0, y: 70, z: 0 }, { x: 6, y: 73, z: 0 });
    assert.ok(up.ok);
    let prev = 70;
    for (const s of up.surface) {
        assert.ok(Math.abs(s.y - prev) <= 1);
        prev = s.y;
    }
    assert.equal(prev, 73);
    assert.equal(up.counts.stair, 3);
    assert.ok(up.ops.filter((o) => o.kind === "stair").every((o) => o.dir === "east"));
    const down = B.planStairs({ x: 0, y: 73, z: 0 }, { x: 0, y: 70, z: -4 });
    assert.ok(down.ok);
    assert.ok(down.ops.filter((o) => o.kind === "stair").every((o) => o.dir === "south"), "stairs face uphill (south, away from the descent)");
    const bend = B.planStairs({ x: 0, y: 70, z: 0 }, { x: 3, y: 72, z: 3 });
    assert.ok(bend.ok && bend.surface.length === 6);
    const steep = B.planStairs({ x: 0, y: 70, z: 0 }, { x: 2, y: 75, z: 0 });
    assert.equal(steep.ok, false);
    assert.match(steep.problems[0], /too steep/);
    assert.equal(B.planStairs({ x: 0, y: 70, z: 0 }, { x: 0, y: 70, z: 0 }).ok, false);
    const profile = B.makeProfile(-2, -2, 12, 6, (x) => ({ g: 70 + x }));
    const supported = B.planStairs({ x: 0, y: 70, z: 0 }, { x: 5, y: 75, z: 0 }, { profile });
    assert.ok(supported.ok);
    const bad = B.planStairs({ x: 0, y: 70, z: 0 }, { x: 5, y: 75, z: 0 }, { profile: B.makeProfile(-2, -2, 12, 6, (x) => ({ g: 70 + x, water: x === 3 ? 80 : undefined })) });
    assert.equal(bad.ok, false);
});

// ------------------------------------------------------------------------------------ bridge

const gap = (n, bed = 60, bank = 70, water) =>
    Array.from({ length: n + 2 }, (_, i) => (i === 0 || i === n + 1 ? { x: 10 + i, z: 4, g: bank } : { x: 10 + i, z: 4, g: bed, water }));

test("bridge: deck flat at the high bank, pillars every N, rails, no long unsupported runs", () => {
    const b = B.planBridge(gap(14, 60, 70, 65), { pillarEvery: 5, width: 3 });
    assert.ok(b.ok, b.problems.join("; "));
    assert.equal(b.deckY, 70);
    assert.deepEqual(b.pillars, [5, 10]);
    assert.equal(b.counts.deck, 16 * 3);
    assert.equal(b.counts.pillar, 2 * 2 * 9, "two outer pillars per support, 9 blocks tall");
    assert.equal(b.counts.rail, 14 * 2);
    for (const o of b.ops.filter((o) => o.kind === "pillar")) assert.ok(o.y >= 61 && o.y <= 69);
    const deckCells = new Set(b.ops.filter((o) => o.kind === "deck").map((o) => `${String(o.x)},${String(o.z)}`));
    assert.equal(deckCells.size, b.counts.deck, "no duplicate deck blocks");
    // unsupported runs: positions without pillars between consecutive supports (and banks) stay < pillarEvery
    const supports = [0, ...b.pillars, 15];
    for (let i = 1; i < supports.length; i += 1) assert.ok(supports[i] - supports[i - 1] <= 5);
    const narrow = B.planBridge(gap(4), { width: 1 });
    assert.ok(narrow.ok && narrow.pillars.length === 0, "short span needs no pillar");
    assert.equal(narrow.counts.deck, 6);
});

test("bridge refuses: long span, deep pillar, flooded deck, mismatched banks, diagonal, bump above deck", () => {
    assert.match(B.planBridge(gap(30)).problems[0], /exceeds the limit/);
    assert.equal(B.planBridge(gap(30), { maxSpan: 40 }).ok, true);
    assert.match(B.planBridge(gap(12, 40, 70)).problems[0], /deep/);
    assert.equal(B.planBridge(gap(12, 40, 70), { maxDepth: 40 }).ok, true);
    assert.match(B.planBridge(gap(8, 60, 70, 71)).problems[0], /under water/);
    const lopsided = gap(8);
    lopsided[9].g = 80;
    assert.match(B.planBridge(lopsided).problems[0], /banks differ/);
    const diag = gap(4).map((c, i) => ({ ...c, z: c.z + i }));
    assert.match(B.planBridge(diag).problems[0], /one axis/);
    const bump = gap(8);
    bump[4].g = 75;
    assert.match(B.planBridge(bump).problems[0], /higher than the deck/);
    const crooked = gap(8);
    crooked[3].z = 5;
    assert.match(B.planBridge(crooked).problems[0], /straight line/);
    assert.equal(B.planBridge(gap(0).slice(0, 2)).ok, false);
    const none = B.planBridge(gap(30));
    assert.equal(none.ops.length, 0);
    // z axis works too and lateral width spreads on x
    const zspan = Array.from({ length: 10 }, (_, i) => ({ x: 3, z: i, g: i === 0 || i === 9 ? 70 : 62 }));
    const z = B.planBridge(zspan, { width: 3, pillarEvery: 4 });
    assert.ok(z.ok);
    assert.deepEqual([...new Set(z.ops.filter((o) => o.kind === "deck").map((o) => o.x))].sort((a, b) => a - b), [2, 3, 4]);
});

// ------------------------------------------------------------------------------------ roads

test("road profile: smoothed, step <= 1, stairs exactly at height changes, deviation capped", () => {
    for (let seed = 1; seed <= 15; seed += 1) {
        const g = Array.from({ length: 60 }, (_, i) => 70 + Math.round((valueNoise(i, 1, 7, seed) - 0.5) * 2 * 4));
        const r = B.planRoadProfile(g, { maxDev: 4 });
        if (!r.ok) continue;
        let changes = 0;
        for (let i = 1; i < g.length; i += 1) {
            const d = Math.abs(r.surface[i] - r.surface[i - 1]);
            assert.ok(d <= 1, `seed ${String(seed)} step ${String(d)}`);
            if (d === 1) changes += 1;
        }
        for (let i = 0; i < g.length; i += 1) assert.ok(Math.abs(r.surface[i] - g[i]) <= 4);
        assert.equal(r.counts.stair, changes);
        assert.equal(r.counts.road + r.counts.stair, g.length);
        // never rougher than the ground it follows
        const rough = (a) => a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0);
        assert.ok(rough(r.surface) <= rough(g));
    }
    const ramp = B.planRoadProfile(Array.from({ length: 12 }, (_, i) => 70 + i * 2), { maxDev: 12 });
    assert.ok(ramp.ok);
    assert.ok(ramp.surface.every((v, i, a) => i === 0 || Math.abs(v - a[i - 1]) <= 1));
    assert.ok(ramp.counts.stair >= 8, "a 2-per-block ground slope becomes a stair run");
    assert.ok(ramp.ops.filter((o) => o.kind === "stair").every((o) => o.dir === "east"));
});

test("road profile refuses water, wall-steep ground and bad numbers", () => {
    assert.match(B.planRoadProfile([{ x: 0, z: 0, g: 70 }, { x: 1, z: 0, g: 66, water: true }]).problems[0], /bridge/);
    const cliff = B.planRoadProfile([70, 70, 70, 70, 90, 90, 90, 90], { maxDev: 3 });
    assert.equal(cliff.ok, false);
    assert.equal(cliff.ops.length, 0);
    assert.match(cliff.problems[0], /too steep/);
    assert.equal(B.planRoadProfile([]).ok, false);
    assert.equal(B.planRoadProfile([70, Infinity]).ok, false);
    const flatRoad = B.planRoadProfile([70, 70, 70, 70]);
    assert.deepEqual(flatRoad.counts, { road: 4, stair: 0, fill: 0, cut: 0 });
    const dip = B.planRoadProfile([70, 70, 66, 70, 70], { maxDev: 6, smooth: 0 });
    assert.ok(dip.ok && dip.counts.fill > 0, "a one-block pothole is filled, not stepped");
});
