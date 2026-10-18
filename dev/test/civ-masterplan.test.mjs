// Master civilization planner tests (pure; synthetic terrain from dev/lib/fakefield.mjs).
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeField } from "../lib/fakefield.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (...parts) => import(pathToFileURL(join(root, "CivilizationApocalypse_BP", "scripts", ...parts)).href);
const G = await load("civ", "geom.js");
const M = await load("civ", "masterplan.js");

/** name -> [seed, field factory]. Seeds are fixed so the suite is reproducible. */
const VARIANTS = {
    plain: [11, (s) => makeField(s, { relief: 3 })],
    hills: [21, (s) => makeField(s, { relief: 18, hills: 60 })],
    river: [11, (s) => makeField(s, { river: { z: 20, width: 12, wiggle: 25 } })],
    lake: [22, (s) => makeField(s, { lakes: [{ x: 20, z: 10, r: 45 }] })],
    cliffs: [14, (s) => makeField(s, { cliffs: [{ x: 60, z0: -150, z1: 130, drop: 14 }] })],
    forest: [21, (s) => makeField(s, { forest: 0.8 })],
    rugged: [35, (s) => makeField(s, { relief: 14, hills: 70, river: { z: -60, width: 10, wiggle: 30 }, lakes: [{ x: 90, z: 70, r: 30 }], forest: 0.5 })],
};

/** @type {Record<string, { plan: any, ms: number, ops: any, attempts: number }>} */
const RESULTS = {};
for (const [name, [seed, make]] of Object.entries(VARIANTS)) {
    const t0 = performance.now();
    const res = M.planCivilizationDetailed(make(seed), { seed });
    const ms = performance.now() - t0;
    assert.ok(res.ok, `${name}: planning failed: ${res.errors.slice(-3).join(" | ")}`);
    RESULTS[name] = { plan: res.plan, ms, ops: res.ops, attempts: res.attempts };
}
const names = Object.keys(RESULTS);

/** Block-resolution barrier + flood fill helpers. */
function barrierOf(plan, openGates) {
    const pixels = [];
    for (const wall of plan.walls) pixels.push(...G.rasterizePath(wall.path, false));
    const barrier = new Set(G.stamp(pixels, 3).map(([x, z]) => `${x},${z}`));
    if (openGates) {
        for (const gate of plan.gates) {
            if (openGates === "inner" && gate.between.includes(0)) continue;
            for (let dz = -2; dz <= 2; dz += 1) for (let dx = -2; dx <= 2; dx += 1) barrier.delete(`${gate.at.x + dx},${gate.at.z + dz}`);
        }
    }
    return barrier;
}

function flood(plan, barrier, start, limit) {
    const seen = new Set([`${start.x},${start.z}`]);
    const queue = [[start.x, start.z]];
    for (let head = 0; head < queue.length && seen.size <= limit; head += 1) {
        const [x, z] = queue[head];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const key = `${x + dx},${z + dz}`;
            if (seen.has(key) || barrier.has(key)) continue;
            seen.add(key);
            queue.push([x + dx, z + dz]);
        }
    }
    return seen;
}

test("geometry helpers: rasterize is 8-connected, stamp gives a 4-connected barrier, areas and containment are right", () => {
    const line = G.rasterizePath([[0, 0], [10, 4], [3, 9]], false);
    for (let i = 1; i < line.length; i += 1) {
        assert.ok(Math.abs(line[i][0] - line[i - 1][0]) <= 1 && Math.abs(line[i][1] - line[i - 1][1]) <= 1 && (line[i][0] !== line[i - 1][0] || line[i][1] !== line[i - 1][1]));
    }
    assert.deepEqual(G.rasterizePath([[0, 0], [3, 0]], false), [[0, 0], [1, 0], [2, 0], [3, 0]]);
    // a diagonal 8-connected line is NOT a 4-connected barrier until stamped
    const diag = G.rasterizePath([[-200, -200], [200, 200]], false);
    const walls = new Set(G.stamp(diag, 3).map(([x, z]) => `${x},${z}`));
    const leak = flood(null, walls, { x: 10, z: 14 }, 3000); // one side of the diagonal
    assert.ok(![...leak].some((key) => { const [x, z] = key.split(",").map(Number); return z < x - 3; }), "flood crossed the stamped diagonal");
    assert.equal(G.polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
    assert.ok(G.pointInPolygon(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]));
    assert.ok(!G.pointInPolygon(15, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]));
    assert.deepEqual(G.bboxOf([[3, 4], [-1, 9]]), { x0: -1, z0: 4, x1: 3, z1: 9 });
    const runs = G.encodeLabels(Uint8Array.from([0, 0, 1, 1, 1, 2]));
    assert.deepEqual(runs, [[0, 2], [1, 3], [2, 1]]);
    const fake = { grid: { x0: 100, z0: 200, w: 3, h: 2 }, labels: runs, cell: 4 };
    assert.equal(G.labelAt(fake, 100, 200), 0);
    assert.equal(G.labelAt(fake, 108, 200), 1);
    assert.equal(G.labelAt(fake, 111, 203), 1);
    assert.equal(G.labelAt(fake, 108, 204), 2);
    assert.equal(G.labelAt(fake, 5000, 5000), 0);
});

test("reproducible: same seed gives byte-identical JSON, different seeds give different plans", () => {
    const [seed, make] = VARIANTS.hills;
    const again = M.planCivilization(make(seed), { seed });
    assert.equal(JSON.stringify(again), JSON.stringify(RESULTS.hills.plan));
    const other = M.planCivilization(make(seed + 1), { seed: seed + 1 });
    assert.notEqual(JSON.stringify(other), JSON.stringify(RESULTS.hills.plan));
    const sameTerrainOtherSeed = M.planCivilization(make(seed), { seed: seed + 1000 });
    assert.notEqual(JSON.stringify(sameTerrainOtherSeed.districts.map((d) => d.outline)), JSON.stringify(RESULTS.hills.plan.districts.map((d) => d.outline)));
    for (const a of names) for (const b of names) if (a < b) assert.notEqual(JSON.stringify(RESULTS[a].plan), JSON.stringify(RESULTS[b].plan));
});

test("areas: five districts of 30k-45k (aim 35-40k), civilization 175k-200k, label grid agrees with the polygons", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        assert.equal(plan.districts.length, 5);
        for (const d of plan.districts) {
            assert.ok(d.area >= 30000 && d.area <= 45000, `${name} ${d.id} area ${d.area}`);
            assert.ok(Math.abs(d.cells * 16 - d.area) / d.area < 0.06, `${name} ${d.id} label cells ${d.cells * 16} vs polygon ${d.area}`);
        }
        assert.ok(plan.stats.totalArea >= 175000 && plan.stats.totalArea <= 200000, `${name} total ${plan.stats.totalArea}`);
        assert.equal(plan.stats.totalArea, plan.stats.perDistrictArea.reduce((a, b) => a + b, 0));
        const labels = G.decodeLabels(plan);
        assert.equal(labels.length, plan.grid.w * plan.grid.h);
        const counts = [0, 0, 0, 0, 0, 0];
        for (const l of labels) counts[l] += 1;
        plan.districts.forEach((d) => assert.equal(counts[d.index], d.cells));
    }
});

test("shapes: five meaningfully different irregular districts (pairwise distance under rotation/reflection)", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        const m = M.planShapeMetrics(plan);
        assert.ok(m.minPairDistance >= 0.05, `${name} min pair distance ${m.minPairDistance}`);
        plan.stats.bboxFill.forEach((f, k) => assert.ok(f < 0.8, `${name} district ${k + 1} bboxFill ${f}`));
        plan.stats.compactness.forEach((c, k) => assert.ok(c >= 0.25 && c <= 0.92, `${name} district ${k + 1} compactness ${c} (validator band)`));
        for (const d of m.descriptors) assert.ok(d.orientedFill < 0.85, `${name} oriented bbox fill ${d.orientedFill}`);
        // not five copies of the same elongation either
        const elong = m.descriptors.map((d) => d.elongation);
        assert.ok(Math.max(...elong) - Math.min(...elong) > 0.15, `${name} elongations ${elong.map((e) => e.toFixed(2))}`);
    }
});

test("outer boundary is irregular: not rectangular, not circular, not a grid of tiles", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        const m = M.planShapeMetrics(plan);
        assert.ok(m.outerBboxFill < 0.75, `${name} outer bbox fill ${m.outerBboxFill}`);
        assert.ok(m.outerCompactness < 0.82, `${name} outer compactness ${m.outerCompactness}`);
        assert.ok(m.outerSolidity < 0.97, `${name} outer solidity ${m.outerSolidity} (a convex blob)`);
        // arrangement is not a grid: district centroids are not collinear / do not share rows or columns
        const cs = plan.districts.map((d) => d.centroid);
        const xs = new Set(cs.map((c) => Math.round(c.x / 20)));
        const zs = new Set(cs.map((c) => Math.round(c.z / 20)));
        assert.ok(xs.size >= 4 && zs.size >= 4, `${name} centroid rows/cols collapse`);
    }
});

test("the command HQ is not forced to the civilization centre and no HQ sits on its district centroid", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        const cx = plan.districts.reduce((s, d) => s + d.centroid.x * d.area, 0) / plan.stats.totalArea;
        const cz = plan.districts.reduce((s, d) => s + d.centroid.z * d.area, 0) / plan.stats.totalArea;
        const hq = plan.districts[0].hq;
        assert.ok(Math.hypot(hq.x - cx, hq.z - cz) >= 30, `${name} command HQ ${Math.hypot(hq.x - cx, hq.z - cz)} from centroid`);
        for (const d of plan.districts) {
            assert.ok(Math.hypot(d.hq.x - d.centroid.x, d.hq.z - d.centroid.z) > 5, `${name} ${d.id} HQ on its centroid`);
            assert.equal(G.labelAt(plan, d.hq.x, d.hq.z), d.index, `${name} ${d.id} HQ is inside its own district`);
        }
    }
});

test("roles follow the contract table and are terrain-biased", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        assert.deepEqual(plan.districts.map((d) => d.role), ["command", "industrial", "agricultural", "commercial", "residential"]);
        assert.deepEqual(plan.districts.map((d) => d.name), ["Hearthgate", "Ironquarry", "Whitethorn", "Saltmere", "Ashfall"]);
        assert.deepEqual(plan.districts.map((d) => d.id), ["district-1", "district-2", "district-3", "district-4", "district-5"]);
    }
    // agricultural land is no hillier than the industrial centroid on the hilly map (flat -> agri, rocky -> industrial)
    const field = VARIANTS.hills[1](VARIANTS.hills[0]);
    const roughness = (d) => {
        let sum = 0;
        let n = 0;
        for (let dx = -40; dx <= 40; dx += 8) for (let dz = -40; dz <= 40; dz += 8) {
            const a = field.at(d.hq.x + dx, d.hq.z + dz).g;
            const b = field.at(d.hq.x + dx + 4, d.hq.z + dz).g;
            sum += Math.abs(a - b);
            n += 1;
        }
        return sum / n;
    };
    const d = RESULTS.hills.plan.districts;
    assert.ok(roughness(d[2]) <= roughness(d[1]) + 0.35, "agricultural HQ ground should not be rougher than industrial");
});

test("walls: shared chains are identical for both neighbours, every wall is sealed, every junction has >= 3 chains", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        const outlineKeys = plan.districts.map((d) => new Set(d.outline.map((p) => p.join(","))));
        for (const wall of plan.walls) {
            assert.equal(typeof wall.closed, "boolean");
            const loop = wall.path[0].join() === wall.path[wall.path.length - 1].join();
            assert.equal(wall.closed, loop, `${name} ${wall.id} closed flag must mean a repeated first point`);
            assert.equal(wall.thickness, 3);
            assert.ok(wall.path.length >= 2);
            const ends = wall.kind === "shared" ? wall.between : [wall.between[0]];
            for (const d of ends) for (const p of wall.path) assert.ok(outlineKeys[d - 1].has(p.join(",")), `${name} ${wall.id} point ${p} missing from district ${d} outline`);
        }
        const ends = new Map();
        for (const wall of plan.walls) {
            const [a, b] = [wall.path[0], wall.path[wall.path.length - 1]];
            if (a.join() === b.join()) continue;
            for (const p of [a, b]) ends.set(p.join(","), (ends.get(p.join(",")) ?? 0) + 1);
        }
        for (const [k, c] of ends) assert.ok(c >= 3, `${name} dangling wall end at ${k}`);
        assert.ok(plan.walls.some((w) => w.kind === "outer") && plan.walls.some((w) => w.kind === "shared"));
    }
});

test("block-level seal: with every gate closed no district floods into another or outside; with gates open all five HQs connect", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        const sealed = barrierOf(plan, false);
        for (const d of plan.districts) {
            const got = flood(plan, sealed, d.hq, 70000);
            assert.ok(got.size < 50000, `${name} ${d.id} leaked (${got.size} columns reached)`);
            assert.ok(got.size > d.area * 0.9 && got.size < d.area * 1.05, `${name} ${d.id} flood ${got.size} vs polygon area ${d.area}`);
        }
        const open = barrierOf(plan, "inner");
        const reach = flood(plan, open, plan.districts[0].hq, 400000);
        for (const d of plan.districts) assert.ok(reach.has(`${d.hq.x},${d.hq.z}`), `${name} ${d.id} unreachable through gates`);
    }
});

test("gates: every ring pair has a gate on its shared wall, each sits on a straight axis-aligned run of >= 11 wall blocks", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 5], [1, 5]]) {
            const gs = plan.gates.filter((g) => g.between.includes(a) && g.between.includes(b));
            assert.ok(gs.length >= 1, `${name} no gate ${a}-${b}`);
            for (const g of gs) {
                const wall = plan.walls.find((w) => w.id === g.wallId);
                assert.equal(wall.kind, "shared");
                assert.deepEqual([...wall.between].sort(), [a, b]);
            }
        }
        const pixels = new Set();
        for (const wall of plan.walls) for (const p of G.rasterizePath(wall.path, false)) pixels.add(p.join(","));
        for (const g of plan.gates) {
            const wall = plan.walls.find((w) => w.id === g.wallId);
            assert.ok(wall, `${name} ${g.id} wall`);
            assert.equal(g.width, 5);
            for (let k = -5; k <= 5; k += 1) {
                const key = g.axis === "x" ? `${g.at.x + k},${g.at.z}` : `${g.at.x},${g.at.z + k}`;
                assert.ok(pixels.has(key), `${name} ${g.id} straight run broken at offset ${k}`);
            }
            const sides = g.between.filter((d) => d > 0);
            assert.ok(sides.length >= 1);
        }
        for (const d of plan.districts) {
            const outer = plan.gates.filter((g) => g.between.includes(0) && g.between.includes(d.index));
            assert.ok(outer.length >= 1, `${name} ${d.id} has no outer gate`);
        }
        assert.ok(plan.gates.some((g) => g.purpose === "field"), `${name} agricultural field gate`);
        assert.equal(new Set(plan.gates.map((g) => g.id)).size, plan.gates.length);
    }
});

test("roads reach every gate and every HQ, avoid crossing walls outside gates; routes use real gates", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        const near = (p, q, r) => Math.hypot(p[0] - q.x, p[1] - q.z) <= r;
        for (const g of plan.gates) {
            assert.ok(plan.roads.some((r) => r.kind === "link" && r.path.some((p) => p[0] === g.at.x && p[1] === g.at.z)), `${name} ${g.id} has no link road`);
        }
        for (const d of plan.districts) {
            assert.ok(plan.roads.some((r) => r.kind === "arterial" && r.district === d.index && r.path.some((p) => near(p, d.hq, 1))), `${name} ${d.id} HQ not on an arterial`);
        }
        const wall = barrierOf(plan, true);
        for (const r of plan.roads) {
            if (r.kind === "link") continue;
            let hits = 0;
            for (const p of G.rasterizePath(r.path, false)) if (wall.has(p.join(","))) hits += 1;
            assert.ok(hits <= 2, `${name} ${r.id} runs through a wall (${hits} cells)`);
        }
        const gateIds = new Set(plan.gates.map((g) => g.id));
        const ring = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 1]];
        for (const [a, b] of ring) {
            assert.ok(plan.routes.reinforce.some((r) => r.from === a && r.to === b));
            assert.ok(plan.routes.reinforce.some((r) => r.from === b && r.to === a));
        }
        for (const d of plan.districts) assert.ok(plan.routes.evac.some((r) => r.from === d.index), `${name} evac ${d.id}`);
        for (const r of [...plan.routes.evac, ...plan.routes.reinforce]) for (const id of r.gates) assert.ok(gateIds.has(id));
        assert.ok(plan.stats.roadLength > 1500 && plan.stats.wallLength > 2000);
    }
});

test("plan is JSON-safe, integer coordinates, versioned, and under 40 KB", () => {
    const sizes = {};
    for (const name of names) {
        const { plan } = RESULTS[name];
        const text = JSON.stringify(plan);
        sizes[name] = text.length;
        assert.deepEqual(JSON.parse(text), plan);
        assert.ok(text.length < 40000, `${name} plan is ${text.length} bytes`);
        assert.equal(plan.version, 1);
        assert.equal(plan.cell, 4);
        for (const wall of plan.walls) for (const p of wall.path) assert.ok(Number.isInteger(p[0]) && Number.isInteger(p[1]));
        for (const r of plan.roads) for (const p of r.path) assert.ok(Number.isInteger(p[0]) && Number.isInteger(p[1]));
        for (const d of plan.districts) for (const p of d.outline) assert.ok(Number.isInteger(p[0]) && Number.isInteger(p[1]));
    }
    console.log("plan JSON bytes:", JSON.stringify(sizes));
});

test("planning is bounded: wall-clock, attempts and operation counts are reported and capped", () => {
    const rows = [];
    for (const name of names) {
        const { plan, ms, ops, attempts } = RESULTS[name];
        assert.ok(ms < 8000, `${name} took ${ms} ms`);
        assert.ok(ops.fieldReads <= 5 * 150 * 150, "field reads bounded by 5 per coarse cell");
        assert.ok(ops.dijkstraPops <= attempts * 150 * 150);
        assert.ok(attempts <= 16);
        rows.push(`${name}: ${Math.round(ms)}ms attempts=${attempts} reads=${ops.fieldReads} pops=${ops.dijkstraPops} astar=${ops.astarPops} areas=${plan.stats.perDistrictArea.join("/")} compact=${plan.stats.compactness.join("/")} bboxFill=${plan.stats.bboxFill.join("/")} gates=${plan.gates.length} walls=${plan.walls.length} roads=${plan.roads.length}`);
    }
    console.log(rows.join("\n"));
});

test("shape descriptor is invariant to rotation, reflection and start vertex, but separates different shapes", () => {
    const outline = RESULTS.plain.plan.districts[1].outline;
    const base = G.shapeDescriptor(outline);
    const rot = outline.map(([x, z]) => [x * Math.cos(1.1) - z * Math.sin(1.1), x * Math.sin(1.1) + z * Math.cos(1.1)]);
    const mirrored = outline.map(([x, z]) => [-x, z]).reverse();
    const shifted = outline.slice(7).concat(outline.slice(0, 7));
    assert.ok(G.shapeDistance(base, G.shapeDescriptor(rot)) < 0.03);
    assert.ok(G.shapeDistance(base, G.shapeDescriptor(mirrored)) < 0.03);
    assert.ok(G.shapeDistance(base, G.shapeDescriptor(shifted)) < 0.03);
    assert.ok(G.shapeDistance(base, G.shapeDescriptor(RESULTS.plain.plan.districts[3].outline)) > 0.1);
});

// ---------------------------------------------------------------- negative tests: the checks must be able to fail

function syntheticPlan(outlines, outerPath, extra = {}) {
    const areas = outlines.map((o) => Math.round(G.polygonArea(o)));
    return {
        districts: outlines.map((outline, k) => ({ index: k + 1, id: `district-${k + 1}`, area: areas[k], outline, hq: { x: 0, z: 0 }, centroid: { x: 0, z: 0 } })),
        walls: [{ id: "w", kind: "outer", between: [1, 0], closed: true, path: outerPath, thickness: 3 }],
        gates: [],
        stats: {
            totalArea: areas.reduce((a, b) => a + b, 0),
            bboxFill: outlines.map((o) => { const b = G.bboxOf(o); return G.polygonArea(o) / ((b.x1 - b.x0) * (b.z1 - b.z0)); }),
            compactness: outlines.map((o) => G.compactness(G.polygonArea(o), G.pathLength(o, true))),
        },
        ...extra,
    };
}

test("negative: a gridded plan of five equal rectangles is flagged by the shape metrics", () => {
    const rect = (x0, z0, w, h) => [[x0, z0], [x0 + w, z0], [x0 + w, z0 + h], [x0, z0 + h]];
    // 3 + 2 grid of 200x190 tiles
    const tiles = [rect(0, 0, 200, 190), rect(200, 0, 200, 190), rect(400, 0, 200, 190), rect(0, 190, 200, 190), rect(200, 190, 200, 190)];
    const plan = syntheticPlan(tiles, rect(0, 0, 600, 380).concat([[0, 0]]));
    const errors = M.selfCheck(plan);
    assert.ok(errors.some((e) => /bboxFill/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /similar/.test(e)), errors.join("; "));
    const m = M.planShapeMetrics(plan);
    assert.ok(m.minPairDistance < 0.03, `congruent tiles must be distance ~0, got ${m.minPairDistance}`);
    assert.ok(m.descriptors.every((d) => d.bboxFill > 0.99 && d.orientedFill > 0.99));
});

test("negative: circles and a single rotated square are flagged as geometric", () => {
    const circle = (cx, cz, r, n = 64) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cz + r * Math.sin((2 * Math.PI * i) / n)]);
    const discs = [circle(0, 0, 109), circle(300, 0, 109), circle(600, 0, 109), circle(150, 250, 109), circle(450, 250, 109)];
    const plan = syntheticPlan(discs, circle(300, 100, 400));
    const errors = M.selfCheck(plan);
    assert.ok(errors.some((e) => /compactness/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /similar/.test(e)), errors.join("; "));
    const d = G.shapeDescriptor(discs[0]);
    assert.ok(d.compactness > 0.97 && d.solidity > 0.99);
});

test("negative: removing a ring gate, dangling a wall end, or parking the command HQ at the centroid is caught", () => {
    const good = structuredClone(RESULTS.plain.plan);
    assert.deepEqual(M.selfCheck(good), []);
    const noGate = structuredClone(good);
    noGate.gates = noGate.gates.filter((g) => !(g.between.includes(2) && g.between.includes(3)));
    assert.ok(M.selfCheck(noGate).some((e) => /no gate 2-3/.test(e)));
    const open = structuredClone(good);
    open.walls[0].path[open.walls[0].path.length - 1][0] += 3;
    assert.ok(M.selfCheck(open).some((e) => /dangling/.test(e)));
    const centred = structuredClone(good);
    const cx = centred.districts.reduce((s, d) => s + d.centroid.x * d.area, 0) / centred.stats.totalArea;
    const cz = centred.districts.reduce((s, d) => s + d.centroid.z * d.area, 0) / centred.stats.totalArea;
    centred.districts[0].hq = { x: Math.round(cx), z: Math.round(cz) };
    assert.ok(M.selfCheck(centred).some((e) => /HQ|centroid/.test(e)));
    const small = structuredClone(good);
    small.districts[2].area = 21000;
    assert.ok(M.selfCheck(small).some((e) => /area/.test(e)));
});

test("negative: the seal test itself detects a missing wall segment", () => {
    const plan = structuredClone(RESULTS.plain.plan);
    const shared = plan.walls.findIndex((w) => w.kind === "shared");
    plan.walls.splice(shared, 1);
    const leak = flood(plan, barrierOf(plan, false), plan.districts[0].hq, 70000);
    const intact = flood(RESULTS.plain.plan, barrierOf(RESULTS.plain.plan, false), RESULTS.plain.plan.districts[0].hq, 70000);
    assert.ok(leak.size > intact.size * 1.5, `a wall removed should merge districts (${leak.size} vs ${intact.size})`);
});

test("impossible terrain: all water throws a CivPlanError instead of returning a bogus plan; maxAttempts is honoured", () => {
    const sea = makeField(5, { lakes: [{ x: 0, z: 0, r: 2000 }] });
    assert.throws(() => M.planCivilization(sea, { seed: 5, maxAttempts: 3 }), (err) => err instanceof M.CivPlanError && err.errors.length > 0);
    const res = M.planCivilizationDetailed(sea, { seed: 5, maxAttempts: 2 });
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 2);
});

test("external validator rejections trigger deterministic re-seeding; async entry point works without or with validate.js", async () => {
    const [seed, make] = VARIANTS.plain;
    let calls = 0;
    const res = M.planCivilizationDetailed(make(seed), { seed, validate: () => (++calls < 3 ? ["synthetic rejection"] : []) });
    assert.ok(res.ok);
    assert.equal(calls, 3);
    assert.ok(res.attempts >= 3);
    const asyncRes = await M.planCivilizationAsync(make(seed), { seed });
    assert.ok(asyncRes.ok);
});

test("the independent validator (civ/validate.js) accepts planner output when that module exists", async () => {
    let V = null;
    try { V = await load("civ", "validate.js"); } catch { V = null; }
    if (!V || typeof V.validatePlan !== "function") return;
    const report = [];
    for (const [name, [seed, make]] of Object.entries(VARIANTS)) {
        const res = await M.planCivilizationAsync(make(seed), { seed });
        assert.ok(res.ok, `${name}: ${res.errors.slice(-2).join(" | ")}`);
        const verdict = V.validatePlan(res.plan);
        assert.ok(verdict.ok, `${name}: ${verdict.problems.slice(0, 4).join(" | ")}`);
        report.push(`${name}:${res.attempts}`);
    }
    console.log("validator-approved attempts per variant", report.join(" "));
});

// ---------------------------------------------------------------- cooperative (yielding) planner

const R = await load("civ", "regions.js");
const V = await load("civ", "validate.js");
const SC = await load("civ", "shapecheck.js");

/** Drive a generator, recording the independent op-counter delta at every yield. */
function driveMeasured(gen, ops) {
    let last = ops.work;
    let maxDelta = 0;
    let yields = 0;
    for (;;) {
        const r = gen.next();
        maxDelta = Math.max(maxDelta, ops.work - last);
        last = ops.work;
        if (r.done) return { value: r.value, maxDelta, yields, totalWork: ops.work };
        yields += 1;
    }
}

test("planCivilizationSteps: same JSON as the synchronous driver for all 7 variants, also when two generators are interleaved", () => {
    for (const [name, [seed, make]] of Object.entries(VARIANTS)) {
        const ops = R.newOps();
        const run = driveMeasured(M.planCivilizationSteps(make(seed), { seed, ops }), ops);
        assert.equal(JSON.stringify(run.value), JSON.stringify(RESULTS[name].plan), `${name}: stepped plan differs from the synchronous plan`);
    }
    const a = M.planCivilizationSteps(VARIANTS.plain[1](VARIANTS.plain[0]), { seed: VARIANTS.plain[0] });
    const b = M.planCivilizationSteps(VARIANTS.lake[1](VARIANTS.lake[0]), { seed: VARIANTS.lake[0] });
    let ra;
    let rb;
    while (!ra || !rb) {
        if (!ra) { const s = a.next(); if (s.done) ra = s.value; }
        if (!rb) { const s = b.next(); if (s.done) rb = s.value; }
    }
    assert.equal(JSON.stringify(ra), JSON.stringify(RESULTS.plain.plan));
    assert.equal(JSON.stringify(rb), JSON.stringify(RESULTS.lake.plan));
});

test("planCivilizationSteps: no stretch between yields above 25,000 counted operations (including the multi-attempt river case)", () => {
    const rows = [];
    for (const [name, [seed, make]] of Object.entries(VARIANTS)) {
        const ops = R.newOps();
        const run = driveMeasured(M.planCivilizationSteps(make(seed), { seed, ops }), ops);
        rows.push(`${name}: attempts=${ops.attempts} yields=${run.yields} maxBetweenYields=${run.maxDelta} totalWork=${Math.round(run.totalWork)}`);
        assert.ok(run.maxDelta <= 25000, `${name}: ${run.maxDelta} ops between two yields`);
        assert.ok(ops.maxRun <= 25000, `${name}: meter says ${ops.maxRun}`);
        assert.ok(run.yields >= run.totalWork / 25000 - 1, `${name}: too few yields for the work done`);
    }
    assert.ok(RESULTS.river.attempts > 1, "the river variant must exercise several attempts");
    console.log(rows.join("\n"));
    // negative: the measurement flags a generator that works for 30k ops without yielding
    const ops = R.newOps();
    const bad = (function* () { ops.work += 30000; yield; ops.work += 100; })();
    assert.ok(driveMeasured(bad, ops).maxDelta > 25000);
});

test("planCivilizationSteps: abandoning the generator midway has no side effects", () => {
    const [seed, make] = VARIANTS.river;
    const field = make(seed);
    for (const stopAfter of [1, 7, 120, 900]) {
        const ops = R.newOps();
        const gen = M.planCivilizationSteps(field, { seed, ops });
        for (let i = 0; i < stopAfter; i += 1) if (gen.next().done) break;
        gen.return(undefined);
    }
    assert.equal(JSON.stringify(M.planCivilization(field, { seed })), JSON.stringify(RESULTS.river.plan));
    assert.equal(JSON.stringify(M.planCivilization(VARIANTS.cliffs[1](VARIANTS.cliffs[0]), { seed: VARIANTS.cliffs[0] })), JSON.stringify(RESULTS.cliffs.plan));
});

test("planCivilizationSteps: failure surfaces as a CivPlanError from the generator, with a reason summary", () => {
    const sea = makeField(5, { lakes: [{ x: 0, z: 0, r: 2000 }] });
    const gen = M.planCivilizationSteps(sea, { seed: 5, maxAttempts: 2 });
    let err = null;
    try { for (;;) if (gen.next().done) break; } catch (e) { err = e; }
    assert.ok(err instanceof M.CivPlanError);
    assert.ok(err.errors.length > 0 && /x\d/.test(err.message), err.message);
});

// ---------------------------------------------------------------- planner self-check == validator shape rules

test("selfCheck shape rules equal the validator: replica numbers match civ/validate.js exports on real plans", () => {
    for (const name of names) {
        const { plan } = RESULTS[name];
        const labels = G.decodeLabels(plan);
        const cells = [];
        for (let j = 0; j < plan.grid.h; j += 1) for (let i = 0; i < plan.grid.w; i += 1) if (labels[j * plan.grid.w + i] === 2) cells.push([i, j]);
        const ops = R.newOps();
        assert.equal(R.runSync(SC.orientedFillSteps(cells, ops)), V.orientedFillOf(cells), `${name} oriented fill`);
        assert.deepEqual(R.runSync(SC.symmetrySteps(labels, plan.grid.w, plan.grid.h, true, ops)), V.symmetryScore(labels, plan.grid.w, plan.grid.h, true), `${name} symmetry`);
        assert.deepEqual(M.selfCheck(plan), [], `${name} selfCheck clean`);
        const shapeProblems = V.validatePlan(plan).problems.filter((p) => p.startsWith("[shape]"));
        assert.deepEqual(shapeProblems, [], `${name} validator shape problems`);
    }
});

test("selfCheck flags validator shape violations on a real plan whose label grid is replaced by rectangles", () => {
    const plan = structuredClone(RESULTS.plain.plan);
    const { w, h } = plan.grid;
    const grid = new Uint8Array(w * h);
    const x0 = Math.floor(w * 0.1);
    const stripe = Math.floor((w * 0.8) / 5);
    for (let j = Math.floor(h * 0.2); j < Math.floor(h * 0.8); j += 1) for (let i = x0; i < x0 + stripe * 5; i += 1) grid[j * w + i] = 1 + Math.floor((i - x0) / stripe);
    plan.labels = G.encodeLabels(grid);
    const errors = M.selfCheck(plan);
    assert.ok(errors.some((e) => /^\[shape\]/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /congruent|indistinguishable|bbox fill|symmetric/.test(e)), errors.join("; "));
});

// ---------------------------------------------------------------- pass-rate sweep (the validator is authoritative)

test("sweep: >= 95% of 6 terrain types x 16 seeds give a plan accepted by civ/validate.js within 16 attempts; failures explain themselves", async () => {
    const types = {
        plain: (s) => makeField(s, { relief: 3 }),
        hills: (s) => makeField(s, { relief: 18, hills: 60 }),
        river: (s) => makeField(s, { river: { z: 20, width: 12, wiggle: 25 } }),
        lake: (s) => makeField(s, { lakes: [{ x: 20, z: 10, r: 45 }] }),
        cliffs: (s) => makeField(s, { cliffs: [{ x: 60, z0: -150, z1: 130, drop: 14 }] }),
        forest: (s) => makeField(s, { forest: 0.8 }),
    };
    let ok = 0;
    let total = 0;
    let attempts = 0;
    const failures = [];
    for (const [name, make] of Object.entries(types)) {
        for (let k = 1; k <= 16; k += 1) {
            const seed = k * 37 + 5;
            const res = await M.planCivilizationAsync(make(seed), { seed });
            total += 1;
            attempts += res.attempts;
            if (res.ok) {
                ok += 1;
                const verdict = V.validatePlan(res.plan);
                assert.ok(verdict.ok, `${name}/${seed} accepted by the planner but rejected by the validator: ${verdict.problems.slice(0, 3).join(" | ")}`);
            } else {
                failures.push(`${name}/${seed}`);
                assert.ok(res.errors.length > 0 && res.attempts === 16);
            }
        }
    }
    console.log(`sweep pass rate ${ok}/${total} (${((100 * ok) / total).toFixed(1)}%), mean attempts ${(attempts / total).toFixed(2)}, failures: ${failures.join(" ") || "none"}`);
    assert.ok(ok / total >= 0.95, `pass rate ${ok}/${total} below the stated 95% threshold (failures: ${failures.join(" ")})`);
});
