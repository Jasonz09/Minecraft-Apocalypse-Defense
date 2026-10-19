// Five-district civilization: independent cross-district invariants.
//
// Nothing here uses districtplan's own statistics to prove districtplan's own geometry. The wall
// barrier is rebuilt from the blocks the five site records actually place, and enclosure is proved by
// walking it. That is the property the milestone asks for ("continuous defensive walls", "shared walls
// preserve independent enclosure", "every opening has a functional gate"), and no existing test
// measures it on the BUILT record - civ/validate.js proves the PLAN.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const loadDev = (...parts) => import(pathToFileURL(join(projectRoot, "dev", ...parts)).href);

const { makeField } = await loadDev("lib", "fakefield.mjs");
// The write-side guard lives in the runtime (integration/civBuilder.js, commands/civ.js), so the geometry
// tests apply it through the fake-Bedrock loader rather than re-implementing it here - a mirrored copy of
// a predicate in a test proves nothing about the code that actually decides what gets written.
const { builder, civCommands } = await loadDev("lib", "civharness.mjs");
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");
const G = await load("civ", "geom.js");
const V = await load("civ", "validate.js");
const FAC = await load("civ", "facilities.js");
const J = await load("civ", "jobs.js");
const L = await load("civ", "lots.js");
const { CIV_LIMITS } = await load("civ", "budget.js");

const SEED = 21;
const field = makeField(SEED, { relief: 18, hills: 60 });const planned = M.planCivilizationDetailed(field, { seed: SEED });
assert.ok(planned.ok, `a five-district master plan must exist first: ${String(planned.errors?.slice(-3).join(" | "))}`);
const PLAN = planned.plan;

/** district index -> its site record. Planned once, shared by every test below. */
const RECORDS = new Map();
for (const district of PLAN.districts) {
    const out = D.planDistrictSite(PLAN, district.index, field, { seed: SEED });
    assert.ok(out.ok, `district ${String(district.index)} (${district.role}) must plan without problems: ${out.problems.slice(0, 4).join(" | ")}`);
    RECORDS.set(district.index, out.record);
}

const cellKey = (x, z) => `${Math.floor(x)},${Math.floor(z)}`;
const planLabels = G.decodeLabels(PLAN);
function labelAt(x, z) {
    const i = Math.floor((x - PLAN.grid.x0) / PLAN.cell);
    const j = Math.floor((z - PLAN.grid.z0) / PLAN.cell);
    if (i < 0 || j < 0 || i >= PLAN.grid.w || j >= PLAN.grid.h) return 0;
    return planLabels[j * PLAN.grid.w + i];
}

/** Stream every op a record places (the descriptor keeps them lazy, so this is the only honest way). */
function opsOf(record) {
    const out = [];
    for (const stage of D.SITE_STAGES) {
        const list = record[stage];
        if (!Array.isArray(list)) continue;
        for (let i = 0; i < list.length; i += 1) out.push(...D.siteOpsFor(record, stage, i));
    }
    return out;
}

const ALL_OPS = new Map([...RECORDS.entries()].map(([index, record]) => [index, opsOf(record)]));
// The wall is built as footing plus courses: a column whose only op is `footing` is still solid
// masonry nothing can walk through. Gate hardware is deliberately NOT in this set - it is the
// authorised opening, so it belongs to the sealed barrier only.
const MASONRY_KINDS = new Set(["wall", "tower", "merlon", "walk", "rubble", "footing"]);
const wallColumns = new Set();
const gateColumns = new Set();
for (const ops of ALL_OPS.values()) {
    for (const op of ops) {
        const key = cellKey(op.x, op.z);
        const kind = String(op.kind);
        if (MASONRY_KINDS.has(kind)) wallColumns.add(key);
        if (kind === "gate" || /gate/.test(String(op.id ?? ""))) gateColumns.add(key);
    }
}
// A closed portcullis IS a barrier, so "sealed" means masonry plus gate hardware. One predicate for the
// whole file: the planned line and the line that actually gets built must be compared as the same set.
const isBarrierOp = (op) => MASONRY_KINDS.has(String(op.kind)) || String(op.kind) === "gate" || /gate/.test(String(op.id ?? ""));
const sealedColumns = new Set([...wallColumns, ...gateColumns]);
// Columns that will hold a block you cannot walk through: masonry, gate hardware, and anything the
// build sets deliberately (foundations, retaining walls, structures). Roads, stairs, pads and
// cleared ground are walkable and therefore NOT solid.
const SOLID_KINDS = new Set(["wall", "tower", "merlon", "rubble", "footing", "gate", "seal", "structure", "retaining", "support", "fill"]);
const solidColumns = new Set();
for (const ops of ALL_OPS.values()) {
    for (const op of ops) {
        if (String(op.id) === "minecraft:air") continue;
        if (SOLID_KINDS.has(String(op.kind))) solidColumns.add(cellKey(op.x, op.z));
    }
}

const buildingLots = (record) => (record.lots ?? []).filter((lot) => String(lot.kind ?? "").startsWith("building-"));

/**
 * Raster of the civilization at one block per pixel, sized to the union of the district bounds.
 * `labelComponents` from civ/validate.js is the repo's own connected-component labeller, so the
 * enclosure claim is measured with the same instrument that validates the plan - the test compares
 * the BUILT barrier against the PLANNED barrier instead of inventing its own walk.
 */
const RASTER = (() => {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const district of PLAN.districts) {
        x0 = Math.min(x0, district.bbox.x0);
        z0 = Math.min(z0, district.bbox.z0);
        x1 = Math.max(x1, district.bbox.x1);
        z1 = Math.max(z1, district.bbox.z1);
    }
    const margin = 16;
    return { x0: x0 - margin, z0: z0 - margin, w: x1 - x0 + 1 + margin * 2, h: z1 - z0 + 1 + margin * 2 };
})();

const rasterIndex = (x, z) => {
    const px = Math.floor(x) - RASTER.x0;
    const pz = Math.floor(z) - RASTER.z0;
    if (px < 0 || pz < 0 || px >= RASTER.w || pz >= RASTER.h) return -1;
    return pz * RASTER.w + px;
};

/** barrier raster from a set of cell keys ("x,z") */
function barrierFrom(cells) {
    const blocked = new Uint8Array(RASTER.w * RASTER.h);
    for (const cell of cells) {
        const [x, z] = cell.split(",").map(Number);
        const index = rasterIndex(x, z);
        if (index >= 0) blocked[index] = 1;
    }
    return blocked;
}

// The plan's stamped band is deliberately NOT compared cell-by-cell against the built blocks: the
// terrain-following band and a square stamp of the centreline differ at a handful of corner cells,
// and the safety question is whether anything can walk through - which the sealed separation tests
// below answer directly. A cell-by-cell identity test would assert a promise nobody made.

/** One component per district interior; two districts sharing a component means water flows between them. */
function separation(blocked) {
    const { comp, count } = V.labelComponents(blocked, RASTER.w, RASTER.h, false);
    /** @type {Map<number, Map<number, number>>} */
    const byComponent = new Map();
    for (let p = 0; p < comp.length; p += 1) {
        const id = comp[p];
        if (id < 0) continue;
        const x = (p % RASTER.w) + RASTER.x0;
        const z = Math.floor(p / RASTER.w) + RASTER.z0;
        const label = labelAt(x, z);
        if (label === 0) continue;
        const inner = byComponent.get(id) ?? new Map();
        inner.set(label, (inner.get(label) ?? 0) + 1);
        byComponent.set(id, inner);
    }
    const hqComponent = new Map();
    for (const district of PLAN.districts) {
        const index = rasterIndex(district.hq.x, district.hq.z);
        hqComponent.set(district.index, index >= 0 ? comp[index] : -1);
    }
    return { comp, count, byComponent, hqComponent };
}

/** Cells of a district at least `r` blocks inside its own boundary: the defensible interior. */
function interiorOf(index, r) {
    const mask = new Uint8Array(RASTER.w * RASTER.h);
    for (let pz = 0; pz < RASTER.h; pz += 1) {
        for (let px = 0; px < RASTER.w; px += 1) {
            mask[pz * RASTER.w + px] = labelAt(px + RASTER.x0, pz + RASTER.z0) === index ? 1 : 0;
        }
    }
    const eroded = V.erodeUniform(mask, RASTER.w, RASTER.h, r);
    // erodeUniform marks ANY uniform region, including the featureless exterior, so keep only the
    // cells that actually belong to this district.
    const interior = new Uint8Array(RASTER.w * RASTER.h);
    for (let p = 0; p < interior.length; p += 1) interior[p] = eroded[p] === 1 && mask[p] === 1 ? 1 : 0;
    return interior;
}
const INTERIORS = new Map(PLAN.districts.map((d) => [d.index, interiorOf(d.index, 4)]));

test("sealed, no district's interior is reachable from any other district's interior", () => {
    const sealed = separation(barrierFrom(sealedColumns));
    for (const district of PLAN.districts) {
        const id = sealed.hqComponent.get(district.index);
        assert.notEqual(id, -1, `district ${String(district.index)}'s HQ sits on a block the plan placed - nobody can enter it`);
        const own = INTERIORS.get(district.index);
        let ownCells = 0;
        for (let p = 0; p < own.length; p += 1) if (own[p] === 1) ownCells += 1;
        assert.ok(ownCells > 1000, `district ${String(district.index)} has only ${String(ownCells)} deep-interior cells - nothing to judge`);
        for (const other of PLAN.districts) {
            if (other.index === district.index) continue;
            const mask = INTERIORS.get(other.index);
            let reached = 0;
            for (let p = 0; p < sealed.comp.length; p += 1) if (sealed.comp[p] === id && mask[p] === 1) reached += 1;
            assert.equal(reached, 0, `from district ${String(district.index)}'s sealed interior, ${String(reached)} interior cells of district ${String(other.index)} are walkable`);
        }
    }
});

test("sealed, the exterior cannot reach any district's interior: the outer perimeter is complete", () => {
    const { comp } = V.labelComponents(barrierFrom(sealedColumns), RASTER.w, RASTER.h, false);
    const edge = rasterIndex(RASTER.x0 + 1, RASTER.z0 + 1);
    assert.ok(edge >= 0, "the probe must be inside the raster");
    const outside = comp[edge];
    assert.notEqual(outside, -1, "the probe cell must be walkable ground, not a wall");
    for (const district of PLAN.districts) {
        const mask = INTERIORS.get(district.index);
        let reached = 0;
        for (let p = 0; p < comp.length; p += 1) if (comp[p] === outside && mask[p] === 1) reached += 1;
        assert.equal(reached, 0, `${String(reached)} interior cells of ${district.id} are walkable from outside the walls`);
    }
});

test("the write guard cannot open the wall: what is left standing after the clearance drops its share still encloses every district", () => {
    // Build order 1,2,3,4,5 (docs/FIVE_DISTRICT_BUILD.md). When district N runs, the neighbours already
    // complete own their land: the runtime refuses to write in it (inProtectedArea), except the district's
    // own wall closing a shared band (isSharedWallFill). Both predicates, and the footprint construction
    // itself (protectedRects), are the production ones - this is the promise the geometry tests above make
    // about the PLANNED barrier, re-made about the barrier that actually gets BUILT.
    const grow = builder.WRITE_PROTECT_GROW;
    const kingdomBefore = (index) => ({
        districts: PLAN.districts.map((district) => ({
            id: `district-${String(district.index)}`,
            civ: { status: district.index < index ? "complete" : "unbuilt", centre: district.centroid },
        })),
    });
    const areasFor = (index) => civCommands.protectedRects(kingdomBefore(index), 1, PLAN, grow, index);
    const effective = new Set();
    let dropped = 0;
    let barrierDropsNobodyBehind = 0;
    for (const index of [1, 2, 3, 4, 5]) {
        const areas = areasFor(index);
        assert.ok(areas.length > 0 || index === 1, `district ${String(index)} ran with no protected neighbour at all - the guard was never armed`);
        for (const op of ALL_OPS.get(index)) {
            const key = cellKey(op.x, op.z);
            const barrier = isBarrierOp(op);
            if (builder.inProtectedArea(areas, op.x, op.z) && !builder.isSharedWallFill(areas, op)) {
                dropped += 1;
                if (barrier && !effective.has(key)) barrierDropsNobodyBehind += 1;
                continue;
            }
            if (barrier) effective.add(key);
        }
    }
    assert.ok(dropped > 1000, `the write guard dropped only ${String(dropped)} operations - this test would pass on an unarmed guard`);
    // 1. nothing came off the line: every planned barrier column is still built by somebody.
    const missing = [...sealedColumns].filter((key) => !effective.has(key));
    assert.deepEqual(missing.slice(0, 5), [], `${String(missing.length)} of ${String(sealedColumns.size)} planned barrier columns are never built - a finished neighbour's clearance ate them (first few: ${missing.slice(0, 5).join(" ")})`);
    assert.equal(barrierDropsNobodyBehind, 0, `${String(barrierDropsNobodyBehind)} barrier columns were dropped with no already-built neighbour standing on the same column`);
    // 2. the exemption is still refused on a finished neighbour's own land: a wall op at its HQ may not pass.
    const capital = PLAN.districts[0];
    const wallAtCapitalHQ = { kind: "wall", id: "minecraft:stone_bricks", x: Math.round(capital.hq.x), z: Math.round(capital.hq.z) };
    assert.equal(builder.inProtectedArea(areasFor(2), wallAtCapitalHQ.x, wallAtCapitalHQ.z), true, "district 1's centre must still be protected land");
    assert.equal(builder.isSharedWallFill(areasFor(2), wallAtCapitalHQ), false, "the exemption must not let a later district raise its wall inside a finished district");
    // 3. and the wall that does get built still seals - from the outside and from every other district.
    const sealed = separation(barrierFrom(effective));
    const outside = sealed.comp[1 * RASTER.w + 1];
    for (const district of PLAN.districts) {
        const own = INTERIORS.get(district.index);
        const id = sealed.hqComponent.get(district.index);
        assert.notEqual(id, -1, `district ${String(district.index)}'s HQ sits on a block the built wall covers - nobody can enter it`);
        let leaked = 0;
        for (let p = 0; p < sealed.comp.length; p += 1) if (own[p] === 1 && sealed.comp[p] === outside) leaked += 1;
        assert.equal(leaked, 0, `${String(leaked)} deep interior cells of ${district.id} are walkable from outside the wall that was actually built`);
        for (const other of PLAN.districts) {
            if (other.index === district.index) continue;
            const mask = INTERIORS.get(other.index);
            let crossed = 0;
            for (let p = 0; p < sealed.comp.length; p += 1) if (mask[p] === 1 && sealed.comp[p] === id) crossed += 1;
            assert.equal(crossed, 0, `from ${district.id}'s built interior, ${String(crossed)} deep cells of ${other.id} are walkable`);
        }
    }
});

test("the road network is one connected civilization, and it passes between districts only through gates", () => {
    // Walkable = anything built to be walked on, plus the floor of a gate passage.
    const WALK_KINDS = new Set(["road", "stair", "bridge", "top"]);
    const walkable = new Set();
    for (const ops of ALL_OPS.values()) {
        for (const op of ops) {
            if (WALK_KINDS.has(String(op.kind))) walkable.add(cellKey(op.x, op.z));
        }
    }
    for (const cell of gateColumns) walkable.add(cell);

    /** @type {Map<string, number>} */
    const componentOf = new Map();
    let next = 0;
    for (const seed of walkable) {
        if (componentOf.has(seed)) continue;
        const id = next++;
        const queue = [seed];
        componentOf.set(seed, id);
        for (let head = 0; head < queue.length; head += 1) {
            const [x, z] = queue[head].split(",").map(Number);
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const key = cellKey(x + dx, z + dz);
                if (walkable.has(key) && !componentOf.has(key)) {
                    componentOf.set(key, id);
                    queue.push(key);
                }
            }
        }
    }

    const nearestWalkable = (point) => {
        for (let r = 0; r <= 8; r += 1) {
            for (let dz = -r; dz <= r; dz += 1) {
                for (let dx = -r; dx <= r; dx += 1) {
                    const key = cellKey(point.x + dx, point.z + dz);
                    if (componentOf.has(key)) return componentOf.get(key);
                }
            }
        }
        return undefined;
    };

    const hqComponents = PLAN.districts.map((d) => nearestWalkable(d.hq));
    for (const [index, id] of hqComponents.entries()) {
        assert.ok(id !== undefined, `district ${String(index + 1)}'s HQ has no road within 8 blocks`);
    }
    assert.equal(new Set(hqComponents).size, 1, `the five districts' roads sit in ${String(new Set(hqComponents).size)} disconnected networks - you cannot march from one to another`);

    // A gate between two districts must join BOTH sides' road networks, or the civilization is five
    // cities with a fence between them. `axis` is the axis the wall runs along, so the two sides are
    // the +/- direction on the other axis.
    const roadCells = new Set();
    for (const ops of ALL_OPS.values()) {
        for (const op of ops) if (WALK_KINDS.has(String(op.kind))) roadCells.add(cellKey(op.x, op.z));
    }
    const roadOnSide = (gate, sign) => {
        for (let across = 2; across <= 6; across += 1) {
            for (let along = -3; along <= 3; along += 1) {
                const x = gate.axis === "x" ? gate.at.x + along : gate.at.x + sign * across;
                const z = gate.axis === "x" ? gate.at.z + sign * across : gate.at.z + along;
                if (roadCells.has(cellKey(x, z))) return true;
            }
        }
        return false;
    };
    let sharedGateChecks = 0;
    for (const gate of PLAN.gates) {
        const both = (gate.between ?? []).filter((index) => index !== 0);
        if (both.length !== 2) continue;
        sharedGateChecks += 1;
        assert.ok(roadOnSide(gate, 1) && roadOnSide(gate, -1), `shared gate ${String(gate.id)} has no road reaching one of its two sides`);
    }
    assert.ok(sharedGateChecks >= 4, `expected several gates between districts, checked ${String(sharedGateChecks)}`);
});

test("every facility the programme wanted but could not site is announced, none is hidden", () => {
    // The record's own `lotPlacementRate` compares placed lots to GENERATED lots, so a district that
    // never generated an orchard still reports 1.0. Loudness has to be measured against the role's
    // programme, which is what civ/facilities.js exists to do.
    for (const district of PLAN.districts) {
        const record = RECORDS.get(district.index);
        const silent = FAC.unsitedProblems(record);
        assert.deepEqual(silent, [], `${district.id} has shortfalls with no note saying so: ${silent.join(" | ")}`);
        for (const deficit of FAC.shortfallOf(record)) {
            const announced = (record.notes ?? []).some((note) => note.includes(deficit.kind));
            assert.ok(announced, `${district.id} wanted ${String(deficit.wanted)} x ${deficit.kind} and sited ${String(deficit.placed)} without a note`);
        }
        // Notes must be specific enough to act on: a count and a kind, not a vague warning.
        for (const note of record.notes ?? []) {
            if (!/no site/i.test(note)) continue;
            assert.match(note, /(no site for \d+ x [a-z_]+|lot .* has no buildable pad)/, `${district.id} note does not name a count and a kind: ${note}`);
        }
    }
});

test("the five records together pass the whole-city facility audit", () => {
    const problems = FAC.auditRecords(PLAN.districts.map((d) => RECORDS.get(d.index)));
    assert.deepEqual(problems, [], problems.slice(0, 6).join(" | "));
});

test("every gate on a district's wall is a fortified gate in that district's plan", () => {
    for (const district of PLAN.districts) {
        const record = RECORDS.get(district.index);
        const wallsHere = new Set((record.walls ?? []).map((wall) => String(wall.id)));
        const expected = PLAN.gates.filter((gate) => wallsHere.has(String(gate.wallId)));
        assert.ok(expected.length > 0, `district ${String(district.index)} has no gate-bearing walls at all`);
        for (const gate of expected) {
            const built = (record.gates ?? []).some((entry) => String(entry.wallId) === String(gate.wallId) && String(entry.purpose ?? "").length > 0);
            assert.ok(built, `gate ${String(gate.id)} on ${String(gate.wallId)} is missing from district ${String(district.index)}'s construction plan`);
        }
        for (const entry of record.gates ?? []) {
            assert.ok(Number.isInteger(entry.width) && entry.width >= 3, `gate ${String(entry.id)} passage width ${String(entry.width)} is not a usable opening`);
            assert.ok(Number.isInteger(entry.passageHeight) && entry.passageHeight >= 4, `gate ${String(entry.id)} passage height ${String(entry.passageHeight)}`);
        }
    }
});

test("shared walls are planned by BOTH neighbours, so neither district's enclosure depends on build order", () => {
    let shared = 0;
    for (const wall of PLAN.walls) {
        if (wall.kind !== "shared") continue;
        shared += 1;
        const claimants = (wall.between ?? []).filter((index) => index !== 0);
        assert.equal(claimants.length, 2, `shared wall ${String(wall.id)} separates ${JSON.stringify(wall.between)}`);
        for (const index of claimants) {
            const record = RECORDS.get(index);
            const element = (record.walls ?? []).find((entry) => String(entry.id) === String(wall.id));
            assert.ok(element !== undefined, `district ${String(index)} does not build shared wall ${String(wall.id)} it depends on`);
            assert.ok(Number(element.total) > 0, `district ${String(index)}'s copy of shared wall ${String(wall.id)} places no blocks`);
        }
    }
    assert.ok(shared >= 4, `a five-district ring must share several walls; found ${String(shared)}`);
    for (const district of PLAN.districts) {
        const record = RECORDS.get(district.index);
        assert.ok((record.walls ?? []).length >= 2, `${district.id} has only ${String((record.walls ?? []).length)} wall elements`);
        for (const element of record.walls ?? []) {
            assert.ok(Number(element.total) > 0, `${district.id}'s wall ${String(element.id)} places no blocks`);
        }
    }
});

test("the five districts are one civilization: distinct roles, areas in range, irregular outlines", () => {
    assert.deepEqual(PLAN.districts.map((d) => d.role), ["command", "industrial", "agricultural", "commercial", "residential"]);
    for (const district of PLAN.districts) {
        assert.ok(district.area >= 30000 && district.area <= 45000, `district ${String(district.index)} area ${String(district.area)} outside 30k-45k`);
    }
    assert.ok(PLAN.stats.totalArea >= 175000 && PLAN.stats.totalArea <= 200000, `total ${String(PLAN.stats.totalArea)}`);
    for (const [index, fill] of PLAN.stats.bboxFill.entries()) {
        assert.ok(fill < 0.8, `district ${String(index + 1)} fills ${fill.toFixed(2)} of its bounding box - that reads as a rectangle`);
    }
    const areas = PLAN.districts.map((d) => G.polygonArea(d.outline));
    assert.equal(new Set(areas).size, 5, "outlines must differ in area");
    assert.ok(new Set(PLAN.districts.map((d) => d.outline.length)).size >= 4, "outlines must differ in vertex count too");
    const verdict = V.validatePlan(PLAN);
    assert.equal(verdict.ok, true, verdict.problems.slice(0, 6).join(" | "));
});

test("each district carries its own role's facilities, physically placed", () => {
    const EXPECT = {
        command: ["hq_citadel", "barracks", "drill_ground", "armoury"],
        industrial: ["smithy", "workshop", "kiln", "warehouse", "quarry_yard"],
        agricultural: ["granary", "mill", "pen"],
        commercial: ["market_square", "market_stall", "shop", "inn", "warehouse"],
        residential: ["house_s", "house_m", "house_l", "school", "chapel", "hospital", "garden"],
    };
    for (const district of PLAN.districts) {
        const kinds = new Set(buildingLots(RECORDS.get(district.index)).map((lot) => String(lot.kind).slice("building-".length)));
        const absent = (EXPECT[district.role] ?? []).filter((kind) => !kinds.has(kind));
        assert.deepEqual(absent, [], `the ${district.role} district (${district.id}) placed none of: ${absent.join(", ")}`);
        assert.ok(kinds.size >= 6, `${district.id} has only ${String(kinds.size)} distinct building kinds`);
    }
});

test("buildings are spaced, not stacked", () => {
    for (const district of PLAN.districts) {
        const lots = buildingLots(RECORDS.get(district.index));
        assert.ok(lots.length > 10, `${district.id} has too few buildings to judge spacing`);
        let worst = Number.POSITIVE_INFINITY;
        let pair = "";
        for (let i = 0; i < lots.length; i += 1) {
            for (let j = i + 1; j < lots.length; j += 1) {
                const gap = L.rectGap(lots[i].bbox, lots[j].bbox);
                if (gap >= 0 && gap < worst) {
                    worst = gap;
                    pair = `${String(lots[i].id)} / ${String(lots[j].id)}`;
                }
            }
        }
        assert.ok(Number.isFinite(worst), `${district.id}: no separable building pair to measure`);
        assert.ok(worst >= 1, `${district.id}: buildings overlap (${pair}, gap ${String(worst)})`);
        const columns = lots.reduce((sum, lot) => sum + (lot.bbox.x1 - lot.bbox.x0 + 1) * (lot.bbox.z1 - lot.bbox.z0 + 1), 0);
        const density = columns / district.area;
        assert.ok(density < 0.35, `${district.id} covers ${(density * 100).toFixed(1)}% of its land with buildings - that is the crowded 49x49 pattern again`);
    }
});

test("roads reach each district's HQ and every one of its gates", () => {
    for (const district of PLAN.districts) {
        const record = RECORDS.get(district.index);
        const roadCells = new Set();
        for (const road of record.roads ?? []) {
            for (const op of D.siteOpsFor(record, "roads", (record.roads ?? []).indexOf(road))) {
                if (String(op.kind) === "road" || String(op.kind) === "stair" || String(op.kind) === "bridge" || String(op.kind) === "top") roadCells.add(cellKey(op.x, op.z));
            }
        }
        assert.ok(roadCells.size > 500, `${district.id} only has ${String(roadCells.size)} road cells`);
        const near = (point) => {
            for (let d = 0; d <= 6; d += 1) {
                for (let dz = -d; dz <= d; dz += 1) {
                    for (let dx = -d; dx <= d; dx += 1) if (roadCells.has(cellKey(point.x + dx, point.z + dz))) return true;
                }
            }
            return false;
        };
        assert.ok(near(district.hq), `${district.id} HQ has no road within 6 blocks`);
        for (const gate of record.gates ?? []) assert.ok(near(gate.at), `gate ${String(gate.id)} of ${district.id} has no road within 6 blocks`);
    }
});

test("five districts fit the op and queue budgets", () => {
    let total = 0;
    for (const district of PLAN.districts) {
        const record = RECORDS.get(district.index);
        const ops = D.siteOpCount(record);
        total += ops;
        assert.ok(ops <= 400000, `${district.id} plans ${String(ops)} ops, over the 400k per-district ceiling`);
        const queue = J.createQueue(D.siteJobSpecs(record), { planHash: record.checksum });
        const bytes = Buffer.byteLength(J.serializeQueue(queue), "utf8");
        assert.ok(bytes <= CIV_LIMITS.maxJobBytes, `${district.id} queue is ${String(bytes)} B over ${String(CIV_LIMITS.maxJobBytes)} B`);
    }
    assert.ok(total > 200000, `a five-district civilization must be a substantial build; measured ${String(total)} ops`);
});

test("the same seed reproduces the same five records, and a different seed does not", () => {
    const again = PLAN.districts.map((d) => D.planDistrictSite(PLAN, d.index, field, { seed: SEED }));
    assert.deepEqual(
        again.map((r) => r.record.checksum),
        PLAN.districts.map((d) => RECORDS.get(d.index).checksum),
        "planning must be reproducible for a given seed",
    );
    const otherSeed = PLAN.districts.map((d) => D.planDistrictSite(PLAN, d.index, field, { seed: SEED + 1 }));
    assert.notEqual(otherSeed[4].record.checksum, RECORDS.get(5).checksum, "changing the seed must change the plan");
});
