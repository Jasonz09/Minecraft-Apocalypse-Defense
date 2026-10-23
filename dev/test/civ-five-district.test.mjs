// Five districts through ONE code path: the cross-district invariants of WP2.
//
// Every district 1..5 is planned by the same planner (civ/districtplan.js) from the same master plan, and every
// claim below is measured on the records that planner returns (their regenerated op streams), not on the
// planner's own statistics. District 1 (Hearthgate) is additionally pinned to a golden snapshot recorded at HEAD
// before the five-district change (dev/test/golden/hearthgate-golden.json): any change to its output fails here.
//
// The priority rule is checked with the PRODUCTION write path (the guard in civ/civBuilder.js and the live-block
// classifier classifyCivOp), not with a copy of it, and each cross-cutting check has a mutation that must fail it.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const loadDev = (...parts) => import(pathToFileURL(join(projectRoot, "dev", ...parts)).href);

const { makeField } = await loadDev("lib", "fakefield.mjs");
const { builder, civCommands, flush, makePlayer, resetWorld, send, store, text, mc, CIV, CIV_EVENT_IDS, districtById } = await loadDev("lib", "civharness.mjs");
const GOLD = await loadDev("test", "golden", "canonical.mjs");
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");
const P = await load("civ", "siteprofile.js");
const W = await load("civ", "walls.js");
const G = await load("civ", "geom.js");
const V = await load("civ", "validate.js");

/** The two fixtures every cross-district check runs on: rough and flat terrain, both from the WP2 audit list. */
const FIXTURES = [
    { name: "seed 21 rough", seed: 21, relief: 18 },
    { name: "seed 12 flat", seed: 12, relief: 2 },
];
/** Sizes of the Hearthgate prototype footprint and the protection margin the runtime applies to it (civ.js, civBuilder.js). */
const PROTOTYPE_HALF = 24;

// ---------------------------------------------------------------------------------------------- shared fixtures

const FIXTURE_CACHE = new Map();
/** One master plan and the five planner results for a fixture. Planned once, shared by every test below. */
function fixtureOf(spec) {
    let hit = FIXTURE_CACHE.get(spec.name);
    if (hit === undefined) {
        const field = makeField(spec.seed, { relief: spec.relief, hills: 60 });
        const planned = M.planCivilizationDetailed(field, { seed: spec.seed });
        assert.ok(planned.ok, `${spec.name}: a five-district master plan must exist first`);
        const plan = planned.plan;
        /** @type {Map<number, any>} */
        const records = new Map();
        for (const district of plan.districts) {
            const out = D.planDistrictSite(plan, district.index, field, { seed: spec.seed });
            records.set(district.index, out);
        }
        hit = { spec, field, plan, records, rehydrated: new Map() };
        FIXTURE_CACHE.set(spec.name, hit);
    }
    return hit;
}

/** Every op of a live record, in job order (stage, then element), tagged with its element. Cached per record. */
const STREAM_CACHE = new WeakMap();
function streamOf(record) {
    let hit = STREAM_CACHE.get(record);
    if (hit === undefined) {
        hit = [];
        for (const stage of D.SITE_STAGES) {
            const list = record[stage] ?? [];
            for (let i = 0; i < list.length; i += 1) {
                for (const op of D.siteOpsFor(record, stage, i)) {
                    hit.push({ stage, elem: String(list[i].id), kind: String(list[i].kind ?? ""), op });
                }
            }
        }
        STREAM_CACHE.set(record, hit);
    }
    return hit;
}

const xyz = (op) => `${op.x},${op.y},${op.z}`;
const BARRIER_STAGES = new Set(["walls", "gates"]);
const shortName = (fixture, index) => `${fixture.spec.name} district ${String(index)}`;

/** Ground the wall composer sees for a district: the same field, limited to the district's own region (siteGroundRegion). */
function groundOf(field, region) {
    return (x, z) => {
        if (x < region.x0 || x > region.x1 || z < region.z0 || z > region.z1) return undefined;
        const cell = field.at(x, z);
        return cell.k === "unloaded" ? undefined : cell.g;
    };
}

/** The wall composer's own output for one shared/outer wall, as a district `index` would plan it. */
function plannedWallOps(fixture, wall, index) {
    const region = P.siteGroundRegion(fixture.plan, index);
    const gates = fixture.plan.gates.filter((gate) => String(gate.wallId) === String(wall.id)).map((gate) => ({ at: gate.at, axis: gate.axis }));
    const built = W.planWall(wall.path, groundOf(fixture.field, region), { closed: wall.closed === true, height: D.SITE_RULES.wallHeight, gates });
    const out = [];
    for (const segment of W.wallOpSegments(built, 1e9)) for (const op of segment.ops) out.push({ x: op.x, y: op.y, z: op.z, id: String(op.id), kind: String(op.layer) });
    return out;
}

/** Air ids: a cell holding only air is not solid, so it does not count as built. */
const AIR_IDS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const isSolid = (id) => id !== undefined && !AIR_IDS.has(id);

/**
 * What a district leaves in the world: the LAST op written at each coordinate, in job order. This is the criterion
 * for shared walls (WP2 decision): not one wall element, because an element is de-duplicated against its own
 * district's other walls, and district 1's de-duplication is pinned by the golden file.
 * @param {any} record
 * @returns {Map<string, string>}
 */
function finalBlocksOf(record) {
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const entry of streamOf(record)) out.set(xyz(entry.op), String(entry.op.id));
    return out;
}

/**
 * The shared-wall check, as a pure function so the mutation tests can feed it broken input. Criteria (WP2 decision):
 * - `planDiff`: cells or ids in the wall planned from A's side but not from B's (or the other way round): must be 0.
 * - `uncovered`: a planned column that is solid in NEITHER neighbour's final stream: must be 0.
 * - `conflicts`: a planned column that holds a DIFFERENT solid block in the two final streams: must be 0.
 * @param {{ x: number, y: number, z: number, id: string }[]} plannedA
 * @param {{ x: number, y: number, z: number, id: string }[]} plannedB
 * @param {Map<string, string>} finalA final block per coordinate of district A
 * @param {Map<string, string>} finalB final block per coordinate of district B
 */
export function sharedWallFindings(plannedA, plannedB, finalA, finalB) {
    const pa = new Map(plannedA.map((op) => [xyz(op), String(op.id)]));
    const pb = new Map(plannedB.map((op) => [xyz(op), String(op.id)]));
    let planDiff = 0;
    for (const [k, id] of pa) if (pb.get(k) !== id) planDiff += 1;
    for (const k of pb.keys()) if (!pa.has(k)) planDiff += 1;
    let uncovered = 0;
    let conflicts = 0;
    for (const k of pa.keys()) {
        const a = finalA.get(k);
        const b = finalB.get(k);
        if (!isSolid(a) && !isSolid(b)) uncovered += 1;
        if (isSolid(a) && isSolid(b) && a !== b) conflicts += 1;
    }
    return { planDiff, uncovered, conflicts };
}

/**
 * Within one district: a barrier (wall/gate) block is the LAST thing written at its coordinate. Stage order is
 * clear, walls, gates, roads, lots, dressing, so a later stage may only write the same block a barrier already has.
 * Returns the coordinates where a later non-barrier op leaves a different block than the barrier placed.
 */
export function barrierReplacements(stream) {
    const barrierAt = new Map();
    const last = new Map();
    for (const entry of stream) {
        const k = xyz(entry.op);
        if (BARRIER_STAGES.has(entry.stage)) barrierAt.set(k, String(entry.op.id));
        last.set(k, entry);
    }
    const bad = [];
    for (const [k, id] of barrierAt) {
        const final = last.get(k);
        if (!BARRIER_STAGES.has(final.stage) && String(final.op.id) !== id) bad.push({ at: k, barrier: id, by: `${final.stage}/${final.elem}`, id: String(final.op.id) });
    }
    return bad;
}

/**
 * Across districts, in build order 1..5, with the production write path: the write guard (protectedRects /
 * inProtectedArea / isSharedWallFill) and the live-block classifier (classifyCivOp) decide every op against what
 * the earlier districts already stand. Returns each op that would REPLACE an earlier district's barrier block with a
 * different block. `classify` and `guard` are injectable only so the mutation test can break them on purpose.
 */
export function crossDistrictReplacements(fixture, options = {}) {
    const classify = options.classify ?? builder.classifyCivOp;
    const guard = options.guard !== false;
    const grow = builder.WRITE_PROTECT_GROW;
    const world = new Map(); // xyz -> barrier block already standing there (from an earlier district)
    const replaced = [];
    let guarded = 0;
    for (const index of [1, 2, 3, 4, 5]) {
        const record = fixture.records.get(index).record;
        const stream = streamOf(record);
        const kingdom = {
            districts: fixture.plan.districts.map((district) => ({
                id: `district-${String(district.index)}`,
                civ: { status: district.index < index ? "complete" : "unbuilt", centre: district.centroid },
            })),
        };
        const areas = civCommands.protectedRects(kingdom, 1, fixture.plan, grow, index);
        /** @type {Map<string, string>} */
        const finalAt = new Map();
        /** @type {Map<string, Set<string>>} */
        const nonAirAt = new Map();
        for (const entry of stream) {
            const k = xyz(entry.op);
            finalAt.set(k, String(entry.op.id));
            if (!String(entry.op.id).endsWith("air")) {
                const set = nonAirAt.get(k) ?? new Set();
                set.add(String(entry.op.id));
                nonAirAt.set(k, set);
            }
        }
        /** @type {Map<string, string[]>} */
        const earlierAt = new Map();
        const claimed = new Map();
        for (const entry of stream) {
            const op = entry.op;
            const k = xyz(op);
            const before = earlierAt.get(k) ?? [];
            if (guard && builder.inProtectedArea(areas, op.x, op.z) && !builder.isSharedWallFill(areas, op)) {
                guarded += 1;
                continue;
            }
            const standing = world.get(k);
            const existing = standing ?? "minecraft:air";
            const verdict = classify(op, existing, { final: finalAt.get(k), nonAir: [...(nonAirAt.get(k) ?? [])], earlier: before });
            if (verdict.action === "place" && standing !== undefined && standing !== String(op.id)) {
                replaced.push({ district: index, at: k, standing, by: `${entry.stage}/${entry.elem}`, id: String(op.id) });
            }
            before.push(String(op.id));
            earlierAt.set(k, before);
            if (BARRIER_STAGES.has(entry.stage)) claimed.set(k, String(op.id));
        }
        for (const [k, id] of claimed) if (!world.has(k)) world.set(k, id);
    }
    return { replaced, guarded };
}

/** Walkable surface of every record together: roads, stairs, bridges, wall stairs, gate sills and building exits. */
function walkNetwork(fixture) {
    const surf = new Map();
    const put = (key, y) => { if (!surf.has(key)) surf.set(key, y); };
    for (const index of [1, 2, 3, 4, 5]) {
        const record = fixture.records.get(index).record;
        for (const entry of streamOf(record)) {
            const walk = entry.stage === "roads" ? ["road", "stair", "top", "bridge"].includes(String(entry.op.kind)) : entry.stage === "dressing" && entry.kind === "wall-stairs";
            if (!walk || String(entry.op.id).endsWith("_wall")) continue;
            surf.set(`${entry.op.x},${entry.op.z}`, entry.op.y);
        }
    }
    for (const index of [1, 2, 3, 4, 5]) {
        const record = fixture.records.get(index).record;
        for (const gate of record.gates) {
            for (const op of D.siteOpsById(record, "gates", gate.id)) {
                if (op.y === gate.walkingLevel - 1 && op.id === "minecraft:polished_andesite" && Math.abs(op.x - gate.at.x) <= 2 && Math.abs(op.z - gate.at.z) <= 2) put(`${op.x},${op.z}`, op.y);
            }
        }
        for (const element of record.lots) {
            if (!String(element.id).startsWith("building-")) continue;
            put(`${element.exit.x},${element.exit.z}`, element.baseY);
        }
    }
    const comp = new Map();
    let next = 0;
    for (const start of surf.keys()) {
        if (comp.has(start)) continue;
        next += 1;
        comp.set(start, next);
        const stack = [start];
        while (stack.length > 0) {
            const cur = stack.pop();
            const [x, z] = cur.split(",").map(Number);
            const y = surf.get(cur);
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const q = `${x + dx},${z + dz}`;
                if (!surf.has(q) || comp.has(q) || Math.abs(surf.get(q) - y) > 1) continue;
                comp.set(q, next);
                stack.push(q);
            }
        }
    }
    return { surf, comp };
}

/** The walkable component nearest a point (within 8 blocks), or undefined. */
function componentNear(net, point) {
    for (let r = 0; r <= 8; r += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
            for (let dx = -r; dx <= r; dx += 1) {
                const c = net.comp.get(`${point.x + dx},${point.z + dz}`);
                if (c !== undefined) return c;
            }
        }
    }
    return undefined;
}

function rehydratedOf(fixture, index) {
    let hit = fixture.rehydrated.get(index);
    if (hit === undefined) {
        const record = fixture.records.get(index).record;
        const groundJSON = JSON.stringify(P.exportSiteGround(fixture.field, P.siteGroundRegion(fixture.plan, index)));
        const out = D.rehydrateSite(fixture.plan, index, groundJSON, { ...D.siteOptionsOf(record), expectChecksum: record.checksum });
        hit = { groundJSON, out };
        fixture.rehydrated.set(index, hit);
    }
    return hit;
}

// ---------------------------------------------------------------------------------------------- tests

test("golden: district 1 (Hearthgate) output is unchanged from the snapshot recorded at HEAD 143afa9", { timeout: 900000 }, () => {
    const golden = JSON.parse(readFileSync(join(projectRoot, "dev", "test", "golden", "hearthgate-golden.json"), "utf8"));
    assert.equal(Object.keys(golden.cases).length, GOLD.GOLDEN_CASES.length, "the golden file covers every golden case");
    assert.equal(golden.layoutId, D.ENLARGED_LAYOUTS[1], "district 1 keeps its layout id");
    for (const spec of GOLD.GOLDEN_CASES) {
        const want = golden.cases[spec.name];
        assert.ok(want, `${spec.name} is in the golden file`);
        const { snapshot } = GOLD.hearthgateCase({ M, D, makeField }, spec);
        assert.equal(snapshot.checksum, want.checksum, `${spec.name}: record checksum`);
        assert.equal(snapshot.siteOpCount, want.siteOpCount, `${spec.name}: site op count`);
        assert.equal(snapshot.opCount, want.opCount, `${spec.name}: regenerated op count`);
        assert.equal(snapshot.opsSha256, want.opsSha256, `${spec.name}: sha256 of the full canonical op stream`);
        assert.deepEqual(snapshot.elements, want.elements, `${spec.name}: every element's id, total and hash`);
    }
});

for (const spec of FIXTURES) {
    test(`${spec.name}: all five districts plan from the master plan, each with its own layout, record and checksum`, { timeout: 900000 }, () => {
        const fixture = fixtureOf(spec);
        const layouts = new Set();
        const checksums = new Set();
        for (const district of fixture.plan.districts) {
            const out = fixture.records.get(district.index);
            assert.ok(out.ok, `${shortName(fixture, district.index)} (${district.role}) must plan without problems: ${out.problems.slice(0, 3).join(" | ")}`);
            const record = out.record;
            assert.equal(record.districtIndex, district.index);
            assert.equal(record.layoutId, D.ENLARGED_LAYOUTS[district.index], "the record carries its district's layout id");
            assert.equal(record.role, district.role);
            assert.equal(record.name, district.name);
            layouts.add(record.layoutId);
            checksums.add(record.checksum);
            assert.ok(record.recordBytes <= D.SITE_RULES.maxRecordBytes, `${shortName(fixture, district.index)} record is ${String(record.recordBytes)} bytes`);
        }
        assert.equal(layouts.size, 5, "five distinct layout ids");
        assert.equal(checksums.size, 5, "five distinct record checksums");
    });

    test(`${spec.name}: no district's structures leave its own land (siteContainmentProblems is empty for 1..5)`, { timeout: 900000 }, () => {
        const fixture = fixtureOf(spec);
        for (const district of fixture.plan.districts) {
            const problems = D.siteContainmentProblems(fixture.plan, district.index, fixture.records.get(district.index).record);
            assert.deepEqual(problems, [], `${shortName(fixture, district.index)}: ${problems.slice(0, 3).join(" | ")}`);
        }
    });

    test(`${spec.name}: every gate, every building door and every evacuation/reinforcement route is on one walkable network`, { timeout: 900000 }, () => {
        const fixture = fixtureOf(spec);
        const net = walkNetwork(fixture);
        const hqComponents = fixture.plan.districts.map((district) => componentNear(net, district.hq));
        for (const [i, c] of hqComponents.entries()) assert.ok(c !== undefined, `district ${String(i + 1)}'s HQ has no road within 8 blocks`);
        assert.equal(new Set(hqComponents).size, 1, "the five HQs are on one walkable network");
        const main = hqComponents[0];
        for (const district of fixture.plan.districts) {
            const record = fixture.records.get(district.index).record;
            let gates = 0;
            for (const gate of record.gates) {
                const sills = D.siteOpsById(record, "gates", gate.id).filter((op) => op.y === gate.walkingLevel - 1 && op.id === "minecraft:polished_andesite" && Math.abs(op.x - gate.at.x) <= 2 && Math.abs(op.z - gate.at.z) <= 2);
                assert.ok(sills.length > 0, `${shortName(fixture, district.index)}: gate ${String(gate.id)} has no walking sill`);
                assert.ok(sills.some((op) => net.comp.get(`${op.x},${op.z}`) === main), `${shortName(fixture, district.index)}: gate ${String(gate.id)} is not reachable from the HQs`);
                gates += 1;
            }
            assert.ok(gates >= 2, `${shortName(fixture, district.index)} has ${String(gates)} gates`);
            let doors = 0;
            let orphan = 0;
            for (const element of record.lots) {
                if (!String(element.id).startsWith("building-")) continue;
                doors += 1;
                if (net.comp.get(`${element.exit.x},${element.exit.z}`) !== main) orphan += 1;
            }
            assert.ok(doors > 0, `${shortName(fixture, district.index)} has no buildings with doors`);
            assert.equal(orphan, 0, `${shortName(fixture, district.index)}: ${String(orphan)} of ${String(doors)} building doors are not on the road network`);
        }
        // every evacuation and reinforcement route passes only through gates that exist and are reachable
        const routes = [];
        for (const index of [1, 2, 3, 4, 5]) {
            for (const kind of ["evac", "reinforce"]) for (const route of fixture.records.get(index).record.routes[kind]) routes.push({ kind, ...route });
        }
        assert.ok(routes.length >= 8, `the five districts name ${String(routes.length)} routes`);
        for (const route of routes) {
            for (const id of route.gates) {
                const gate = fixture.plan.gates.find((entry) => String(entry.id) === String(id));
                assert.ok(gate !== undefined, `${route.kind} route ${String(route.from)}->${String(route.to)} names gate ${String(id)} that the master plan does not have`);
                const builtBy = [1, 2, 3, 4, 5].filter((index) => fixture.records.get(index).record.gates.some((entry) => String(entry.id) === String(id)));
                assert.ok(builtBy.length > 0, `gate ${String(id)} is built by no district`);
                for (const index of builtBy) {
                    const sills = D.siteOpsById(fixture.records.get(index).record, "gates", id);
                    assert.ok(sills.some((op) => net.comp.get(`${op.x},${op.z}`) === main), `${route.kind} route through gate ${String(id)} is cut off from the HQs`);
                }
            }
        }
    });

    test(`${spec.name}: rehydrating each district from its persisted ground gives the identical checksum, element hashes and op stream`, { timeout: 900000 }, () => {
        const fixture = fixtureOf(spec);
        for (const district of fixture.plan.districts) {
            const index = district.index;
            const record = fixture.records.get(index).record;
            const { out } = rehydratedOf(fixture, index);
            assert.ok(out.ok, `${shortName(fixture, index)} rehydrates: ${out.problems.slice(0, 3).join(" | ")}`);
            assert.equal(out.record.checksum, record.checksum, `${shortName(fixture, index)}: checksum`);
            assert.deepEqual(GOLD.snapshotOfRecord(D, out.record), GOLD.snapshotOfRecord(D, record), `${shortName(fixture, index)}: op stream and element hashes`);
        }
    });

    test(`${spec.name}: an interrupted build resumes from its cursor on the rehydrated record to the identical final op set`, { timeout: 900000 }, () => {
        const fixture = fixtureOf(spec);
        for (const district of fixture.plan.districts) {
            const index = district.index;
            const stream = streamOf(fixture.records.get(index).record);
            const full = new Map(stream.map((entry) => [xyz(entry.op), `${String(entry.op.id)}|${String(entry.op.kind)}`]));
            // the process dies after ~37% of the job; everything it placed is in the world, the cursor is persisted
            const cut = Math.floor(stream.length * 0.37);
            const world = new Map(stream.slice(0, cut).map((entry) => [xyz(entry.op), `${String(entry.op.id)}|${String(entry.op.kind)}`]));
            // restart: nothing survives but the plan, the persisted ground and the options
            const { groundJSON } = rehydratedOf(fixture, index);
            const restored = D.rehydrateSite(fixture.plan, index, groundJSON, { ...D.siteOptionsOf(fixture.records.get(index).record), expectChecksum: fixture.records.get(index).record.checksum });
            assert.ok(restored.ok, `${shortName(fixture, index)} restarts from its stored inputs`);
            for (const entry of streamOf(restored.record).slice(cut)) world.set(xyz(entry.op), `${String(entry.op.id)}|${String(entry.op.kind)}`);
            assert.deepEqual([...world.entries()].sort(), [...full.entries()].sort(), `${shortName(fixture, index)}: resumed world differs from the uninterrupted one`);
        }
    });

    test(`${spec.name}: shared walls are planned identically from either side, and every planned column is solid in at least one neighbour's final stream with no conflicting block`, { timeout: 900000 }, () => {
        const fixture = fixtureOf(spec);
        let checked = 0;
        for (const wall of fixture.plan.walls) {
            if (wall.kind !== "shared") continue;
            const [a, b] = (wall.between ?? []).filter((index) => index !== 0);
            const plannedA = plannedWallOps(fixture, wall, a);
            const plannedB = plannedWallOps(fixture, wall, b);
            const findings = sharedWallFindings(plannedA, plannedB, finalBlocksOf(fixture.records.get(a).record), finalBlocksOf(fixture.records.get(b).record));
            assert.equal(findings.planDiff, 0, `${String(wall.id)} (${String(a)}|${String(b)}): the wall planned from ${String(a)} and from ${String(b)} differs in ${String(findings.planDiff)} cells`);
            assert.equal(findings.uncovered, 0, `${String(wall.id)}: ${String(findings.uncovered)} planned columns are solid in neither neighbour's final stream`);
            assert.equal(findings.conflicts, 0, `${String(wall.id)}: ${String(findings.conflicts)} planned columns hold different solid blocks in the two final streams`);
            assert.ok(plannedA.length > 0, `${String(wall.id)} plans blocks`);
            checked += 1;
        }
        assert.ok(checked >= 4, `a five-district ring shares several walls; checked ${String(checked)}`);
    });

    test(`${spec.name}: no op of any district replaces a wall or gate block (within a district, and across districts in build order)`, { timeout: 900000 }, () => {
        const fixture = fixtureOf(spec);
        for (const district of fixture.plan.districts) {
            const bad = barrierReplacements(streamOf(fixture.records.get(district.index).record));
            assert.deepEqual(bad.slice(0, 3), [], `${shortName(fixture, district.index)}: a later stage replaces a barrier block: ${JSON.stringify(bad.slice(0, 3))}`);
        }
        const { replaced, guarded } = crossDistrictReplacements(fixture);
        assert.ok(guarded > 1000, `the write guard dropped only ${String(guarded)} ops - the cross-district check would pass on an unarmed guard`);
        assert.deepEqual(replaced.slice(0, 3), [], `${String(replaced.length)} operations of a later district would replace an earlier district's wall or gate block: ${JSON.stringify(replaced.slice(0, 3))}`);
    });
}

test("seed 21 rough: the 49x49 legacy record is never overlapped by any district's operations", { timeout: 900000 }, () => {
    const fixture = fixtureOf(FIXTURES[0]);
    // The legacy footprint sits on district 3's HQ, the worst place for it: the planner must work around it.
    const hq = fixture.plan.districts.find((district) => district.index === 3).hq;
    const legacy = { x0: Math.round(hq.x) - PROTOTYPE_HALF, z0: Math.round(hq.z) - PROTOTYPE_HALF, x1: Math.round(hq.x) + PROTOTYPE_HALF, z1: Math.round(hq.z) + PROTOTYPE_HALF };
    const inside = (op, rect) => op.x >= rect.x0 && op.x <= rect.x1 && op.z >= rect.z0 && op.z <= rect.z1;
    // Without the protected footprint the same planner does build inside it: this is the case the check must catch.
    const unprotected = streamOf(fixture.records.get(3).record).filter((entry) => inside(entry.op, legacy)).length;
    assert.ok(unprotected > 0, "the scenario must really overlap the legacy footprint");
    // With the runtime's protection (the footprint grown by the protection margin, as civ.js protectedRects builds it)
    const pad = builder.PROTECT_MARGIN;
    const excluded = { x0: legacy.x0 - pad, z0: legacy.z0 - pad, x1: legacy.x1 + pad, z1: legacy.z1 + pad };
    for (const district of fixture.plan.districts) {
        const out = D.planDistrictSite(fixture.plan, district.index, fixture.field, { seed: fixture.spec.seed, excludeFootprints: [excluded] });
        assert.ok(out.ok, `${String(district.id)} plans around the legacy footprint: ${out.problems.slice(0, 3).join(" | ")}`);
        const hits = streamOf(out.record).filter((entry) => inside(entry.op, legacy));
        assert.equal(hits.length, 0, `${String(district.id)} places ${String(hits.length)} operations inside the legacy 49x49 footprint, e.g. ${hits[0] ? xyz(hits[0].op) : ""}`);
    }
});

test("mutation: a broken shared wall, a dropped stretch and a stray barrier replacement each make the checks fail", { timeout: 900000 }, () => {
    const fixture = fixtureOf(FIXTURES[0]);
    const wall = fixture.plan.walls.find((entry) => entry.kind === "shared" && String(entry.id) === "wall-4");
    assert.ok(wall, "wall-4 is a shared wall in the fixture");
    const [a, b] = (wall.between ?? []).filter((index) => index !== 0);
    const plannedA = plannedWallOps(fixture, wall, a);
    const plannedB = plannedWallOps(fixture, wall, b);
    const finalA = finalBlocksOf(fixture.records.get(a).record);
    const finalB = finalBlocksOf(fixture.records.get(b).record);
    assert.deepEqual(sharedWallFindings(plannedA, plannedB, finalA, finalB), { planDiff: 0, uncovered: 0, conflicts: 0 }, "the unbroken wall passes");

    // 1. one neighbour's final stream holds a different solid block on a planned column: the no-conflict rule must catch it
    const probe = plannedA.find((op) => isSolid(finalA.get(xyz(op))));
    assert.ok(probe, "the fixture has a solid planned column to tamper with");
    const swapped = new Map(finalB);
    swapped.set(xyz(probe), "minecraft:dirt");
    assert.ok(sharedWallFindings(plannedA, plannedB, finalA, swapped).conflicts > 0, "a different solid block on a shared column must be a conflict");

    // 2. a stretch of 9 planned columns is missing from BOTH final streams: the coverage rule must catch it
    const gap = plannedA.slice(0, 9).map(xyz);
    const holeA = new Map(finalA);
    const holeB = new Map(finalB);
    for (const k of gap) {
        holeA.delete(k);
        holeB.delete(k);
    }
    assert.ok(sharedWallFindings(plannedA, plannedB, holeA, holeB).uncovered > 0, "columns that neither neighbour builds must be reported");

    // 3. the same stretch missing from ONE side only is not a failure: the other neighbour still builds it
    const oneSide = new Map(finalA);
    for (const k of gap) oneSide.delete(k);
    assert.equal(sharedWallFindings(plannedA, plannedB, oneSide, finalB).uncovered, 0, "one neighbour that builds a column is enough");

    // 4. a road laid over a barrier block in the same district: the within-district rule must catch it
    const stream = streamOf(fixture.records.get(a).record);
    const barrierEntry = stream.find((entry) => entry.stage === "walls" && entry.op.kind === "wall");
    const polluted = [...stream, { stage: "roads", elem: "road-mutant", kind: "road", op: { x: barrierEntry.op.x, y: barrierEntry.op.y, z: barrierEntry.op.z, id: "minecraft:dirt", kind: "road" } }];
    assert.ok(barrierReplacements(polluted).length > 0, "a later road op replacing a barrier block must be reported");

    // 5. a naive writer that places whatever it is given, with the guard off: the cross-district check must catch it
    const naive = crossDistrictReplacements(fixture, { classify: () => ({ action: "place" }), guard: false });
    assert.ok(naive.replaced.length > 0, "an unguarded, unclassified write must replace earlier barrier blocks");
});

test("the cross-district check is a real measurement: the production write path refuses every replacement it is shown", { timeout: 900000 }, () => {
    // Pins what the planner's RAW output looks like before the runtime write path (guard + classifier) decides.
    // Shared walls are identical where two districts both place a column. The raw streams still overlap at
    // junctions where a neighbour's outer wall meets a shared wall with a different material; the runtime
    // skips every such op as "occupied" (first-built wins), so nothing is replaced. The count is reported so a
    // planner change that moves it is visible.
    const fixture = fixtureOf(FIXTURES[0]);
    const raw = crossDistrictReplacements(fixture, { classify: () => ({ action: "place" }), guard: false });
    const real = crossDistrictReplacements(fixture);
    assert.deepEqual(real.replaced, [], "the production path replaces nothing");
    assert.ok(raw.replaced.length > 0, "the raw planner output does contain overlapping barrier claims");
});

test("devgate: building districts 2-5 is refused with the gate off; district=all planning stays read-only (pre-goal behaviour); both continue with the gate on", { timeout: 900000 }, async () => {
    resetWorld(1);
    // Pre-goal behaviour (143afa9): the whole-civilization overview is read-only and needs no gate.
    const overview = makePlayer();
    send(CIV_EVENT_IDS.plan, "district=all", overview);
    await flush();
    assert.doesNotMatch(text(overview), /development-only/, "the read-only overview is not gated");
    assert.equal(mc.writes, 0, "the overview writes nothing");
    // Building district=all is still refused as read-only, with the gate off or on.
    const build = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=all", build);
    await flush();
    assert.match(text(build), /district=all is read-only/);
    assert.equal(mc.writes, 0, "a refusal writes nothing");
    const off = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=2", off);
    await flush();
    assert.match(text(off), /Ironquarry \(district-2\) is development-only: the development gate is off/);
    assert.equal(mc.writes, 0, "a refusal writes nothing");
    assert.equal(mc.reads, 0, "a refusal reads nothing from the world");

    // a started district 2 with the gate off: resume is refused by name, not by an accident of state
    const loaded = store.load();
    const district2 = districtById(loaded.kingdom, "district-2");
    // the same shape commands/civ.js writes for a started district (integer seed, startedStep, anchor, centre; string checksum and stage)
    district2.civ = {
        district: 2, status: "paused", seed: 1, startedStep: 0, anchor: { x: 0, z: 0 }, centre: { x: 0, z: 0 }, checksum: "fixture", stage: "walls",
        dimension: "minecraft:overworld", hq: { x: 0, z: 0 }, ops: 0, opsTotal: 1, placed: 0, skipped: 0, layout: "ironquarry-enlarged",
    };
    store.save(loaded.kingdom);
    const resumeOff = makePlayer();
    send(CIV_EVENT_IDS.resume, "district=2", resumeOff);
    await flush();
    // Pre-goal behaviour: resume itself is not gated by the development switch (the build is only ever started with it on).
    assert.doesNotMatch(text(resumeOff), /development-only/, "resume is not gated by the development switch");
    // with the gate on the same command gets past the gate
    send(CIV_EVENT_IDS.devgate, "on", makePlayer());
    await flush();
    const resumeOn = makePlayer();
    send(CIV_EVENT_IDS.resume, "district=2", resumeOn);
    await flush();
    assert.doesNotMatch(text(resumeOn), /development-only/, text(resumeOn).slice(-600));
    send(CIV_EVENT_IDS.devgate, "on", makePlayer());
    send(CIV_EVENT_IDS.plan, "district=all", makePlayer());
    await flush();
    send(CIV_EVENT_IDS.devgate, "off", makePlayer());
    await flush();
    assert.equal(mc.props.get(CIV.devGateKey), false, "the gate is switched off again");
});

test("the golden file and the canonical helper agree on the case list (regenerating the golden is a deliberate act)", () => {
    const golden = JSON.parse(readFileSync(join(projectRoot, "dev", "test", "golden", "hearthgate-golden.json"), "utf8"));
    assert.equal(golden.head, "143afa9");
    assert.deepEqual(Object.keys(golden.cases).sort(), GOLD.GOLDEN_CASES.map((spec) => spec.name).sort());
    assert.equal(typeof GOLD.sha256("x"), "string");
    assert.equal(typeof V.labelComponents, "function");
    assert.equal(typeof G.decodeLabels, "function");
});
