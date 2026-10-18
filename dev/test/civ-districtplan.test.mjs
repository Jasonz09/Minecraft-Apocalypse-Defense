import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Phase C - the enlarged, irregular Hearthgate construction planner.
 *
 * Everything here is checked with INDEPENDENT geometry (own flood fills, own gap maths) so a
 * bug in civ/districtplan.js cannot be confirmed by the same bug in its own test helpers.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const loadDev = (...parts) => import(pathToFileURL(join(projectRoot, "dev", ...parts)).href);

const { makeField } = await loadDev("lib", "fakefield.mjs");
const fixture = await loadDev("lib", "civfixture.mjs");
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");
const { validatePlan } = await load("civ", "validate.js");
const { createQueue, progress } = await load("civ", "jobs.js");
const { CIV_LIMITS } = await load("civ", "budget.js");
const { planDistrict, planHash, MAX_PLAN_BLOCKS } = await load("structures", "planner.js");
const { createInitialKingdom } = await load("kingdom", "state.js");

const SEED = 21;
const field = makeField(SEED, { relief: 18, hills: 60 });
const planned = M.planCivilizationDetailed(field, { seed: SEED });
assert.ok(planned.ok, `the master plan for this terrain must exist first: ${planned.errors.slice(-4).join(" | ")}`);
const PLAN = planned.plan;
const site = D.planDistrictSite(PLAN, 1, field, { seed: SEED });
assert.ok(site.ok, `Hearthgate must plan without problems: ${site.problems.slice(0, 4).join(" | ")}`);
const RECORD = site.record;

/* ------------------------------------------------------------------ independent helpers */

const key = (x, z) => `${String(x)},${String(z)}`;

/** Union of the (x, z) columns an element's ops occupy. */
function elementColumns(stage, index) {
    const set = new Set();
    for (const op of D.siteOpsFor(RECORD, stage, index)) {
        set.add(key(op.x, op.z));
    }
    return set;
}

function allOps(stage) {
    const list = /** @type {any[]} */ (RECORD[stage] ?? []);
    /** @type {any[]} */
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
        out.push(...D.siteOpsFor(RECORD, stage, i));
    }
    return out;
}

/** The rect a gate opens through: along its axis for `width`, across it for the wall thickness. */
function gateRect(gate) {
    const half = Math.max(2, Math.floor(Number(gate.width) / 2));
    const x0 = gate.axis === "x" ? gate.at.x - half : gate.at.x - 2;
    const x1 = gate.axis === "x" ? gate.at.x + half : gate.at.x + 2;
    const z0 = gate.axis === "z" ? gate.at.z - half : gate.at.z - 2;
    const z1 = gate.axis === "z" ? gate.at.z + half : gate.at.z + 2;
    return { x0, z0, x1, z1 };
}
const GATE_RECTS = /** @type {any[]} */ (RECORD.gates).map(gateRect);

const inAny = (rects, x, z) => rects.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);

/**
 * Flood fill on the block grid. Cells carrying a wall op are barriers unless they lie inside a
 * gate rect, so the fill can only escape through an opening that the plan actually provides.
 *
 * @param {Set<string>} wallCells
 * @param {{ x: number, z: number }} start
 * @param {{ x0: number, z0: number, x1: number, z1: number }} window
 */
function escapeFrom(wallCells, start, window) {
    const seen = new Set([key(start.x, start.z)]);
    const queue = [[start.x, start.z]];
    let escaped = null;
    while (queue.length > 0) {
        const [x, z] = /** @type {[number, number]} */ (queue.shift());
        if (x <= window.x0 || x >= window.x1 || z <= window.z0 || z >= window.z1) {
            escaped = { x, z };
            break;
        }
        for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
            const k = key(nx, nz);
            if (seen.has(k)) {
                continue;
            }
            const blocked = wallCells.has(k) && !inAny(GATE_RECTS, nx, nz);
            if (blocked) {
                seen.add(k);
                continue;
            }
            seen.add(k);
            queue.push([nx, nz]);
        }
    }
    return { escaped, seen };
}

/** Independent label read, straight off the plan's own run-length grid. */
function labelAt(x, z) {
    const decoded = decodeCache.labels;
    const gx = Math.floor((x - PLAN.grid.x0) / PLAN.cell);
    const gz = Math.floor((z - PLAN.grid.z0) / PLAN.cell);
    if (gx < 0 || gz < 0 || gx >= PLAN.grid.w || gz >= PLAN.grid.h) {
        return 0;
    }
    return decoded[gz * PLAN.grid.w + gx];
}
const decodeCache = (() => {
    const w = PLAN.grid.w;
    const h = PLAN.grid.h;
    /** @type {number[]} */
    const labels = new Array(w * h).fill(0);
    let cursor = 0;
    for (const [label, run] of /** @type {any[]} */ (PLAN.labels)) {
        for (let i = 0; i < run && cursor < labels.length; i += 1) {
            labels[cursor] = label;
            cursor += 1;
        }
    }
    return { labels };
})();

/* ------------------------------------------------------------------ 1. the plan exists and stayed irregular */

test("Hearthgate is planned from the master plan, enlarged and without problems", () => {
    assert.equal(RECORD.layoutId, "hearthgate-enlarged");
    assert.equal(RECORD.districtIndex, 1);
    assert.equal(RECORD.districtId, "district-1");
    assert.equal(RECORD.name, "Hearthgate");
    assert.equal(RECORD.role, "command");
    assert.equal(RECORD.version, 1);
    assert.deepEqual(site.problems, []);
    const district = /** @type {any[]} */ (PLAN.districts).find((entry) => entry.index === 1);
    assert.ok(district.area >= 30000 && district.area <= 45000, `enlarged area should be 30-45k columns, got ${String(district.area)}`);
    assert.ok(district.area > 49 * 49, "the enlarged district must be far bigger than the 49x49 prototype");
});

test("the boundary stays irregular - no square, no rectangle, no disc", () => {
    const outline = /** @type {any[]} */ (RECORD.outline);
    assert.ok(outline.length >= 12, `outline has only ${String(outline.length)} vertices`);
    // Independent bbox-fill: labelled columns vs the rectangle that contains them.
    let labelled = 0;
    let inside = 0;
    for (let gz = 0; gz < PLAN.grid.h; gz += 1) {
        for (let gx = 0; gx < PLAN.grid.w; gx += 1) {
            if (decodeCache.labels[gz * PLAN.grid.w + gx] === 1) {
                labelled += 1;
            }
        }
    }
    const bbox = RECORD.bbox;
    const cellX0 = Math.floor((bbox.x0 - PLAN.grid.x0) / PLAN.cell);
    const cellX1 = Math.floor((bbox.x1 - PLAN.grid.x0) / PLAN.cell);
    const cellZ0 = Math.floor((bbox.z0 - PLAN.grid.z0) / PLAN.cell);
    const cellZ1 = Math.floor((bbox.z1 - PLAN.grid.z0) / PLAN.cell);
    for (let gz = cellZ0; gz <= cellZ1; gz += 1) {
        for (let gx = cellX0; gx <= cellX1; gx += 1) {
            inside += 1;
        }
    }
    const fill = labelled / inside;
    assert.ok(fill < 0.8, `a ${String(Math.round(fill * 100))}% bbox fill is too close to a rectangle`);
    // Wall columns must not collapse onto four straight sides either.
    const wallCells = new Set();
    for (const op of allOps("walls")) {
        wallCells.add(key(op.x, op.z));
    }
    const xs = [...wallCells].map((k) => Number(k.split(",")[0]));
    const zs = [...wallCells].map((k) => Number(k.split(",")[1]));
    assert.ok(new Set(xs).size > 40 && new Set(zs).size > 40, "the perimeter is degenerate");
});

/* ------------------------------------------------------------------ 2. continuous enclosure */

test("with every gate shut, the perimeter seals Hearthgate completely", async () => {
    /** @type {Set<string>} */
    const wallCells = new Set();
    for (const op of allOps("walls")) {
        wallCells.add(key(op.x, op.z));
    }
    assert.ok(wallCells.size > 1000, `only ${String(wallCells.size)} wall columns`);
    const district = /** @type {any[]} */ (PLAN.districts).find((entry) => entry.index === 1);
    const window = { x0: district.bbox.x0 - 60, z0: district.bbox.z0 - 60, x1: district.bbox.x1 + 60, z1: district.bbox.z1 + 60 };
    // Gates shut. The opening that planWall punches is defined by walls.js' own footprint (wider
    // than width/2), so seal a generous disc around each gate centre: if the wall band were broken
    // anywhere else, the fill would still get out.
    const { gateFootprintBox } = await load("civ", "walls.js");
    const gateCells = new Set();
    for (const gate of /** @type {any[]} */ (RECORD.gates)) {
        const box = gateFootprintBox({ at: gate.at, axis: gate.axis });
        for (let x = box.x0 - 3; x <= box.x1 + 3; x += 1) {
            for (let z = box.z0 - 3; z <= box.z1 + 3; z += 1) {
                gateCells.add(key(x, z));
            }
        }
    }
    const seen = new Set([key(district.centroid.x, district.centroid.z)]);
    const queue = [[district.centroid.x, district.centroid.z]];
    let escaped = null;
    let outsideLabel = null;
    while (queue.length > 0) {
        const [x, z] = /** @type {[number, number]} */ (queue.shift());
        if (x <= window.x0 || x >= window.x1 || z <= window.z0 || z >= window.z1) {
            escaped = { x, z };
            break;
        }
        if (labelAt(x, z) !== 1 && outsideLabel === null) {
            outsideLabel = { x, z, label: labelAt(x, z) };
        }
        for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
            const k = key(nx, nz);
            if (seen.has(k)) continue;
            seen.add(k);
            if (wallCells.has(k) || gateCells.has(k)) continue;
            queue.push([nx, nz]);
        }
    }
    assert.equal(escaped, null, "the sealed perimeter leaks to the edge of the survey window");
    assert.ok(seen.size > 20000, `only ${String(seen.size)} interior cells were explored`);

    // One 3-thick wall serves both neighbours, so a few cells pressed against it can carry the
    // neighbour's coarse label. That slack must stay a boundary effect: a real gap would let the
    // fill reach thousands of foreign cells, far from any wall.
    const wallList = [...wallCells].map((k) => k.split(",").map(Number));
    const foreign = [...seen].map((k) => k.split(",").map(Number)).filter(([x, z]) => labelAt(x, z) !== 1);
    const ratio = foreign.length / seen.size;
    assert.ok(ratio < 0.01, `${String(foreign.length)} of ${String(seen.size)} enclosed cells (${(ratio * 100).toFixed(1)}%) are foreign land - the wall is in the wrong place`);
    const nearestWalls = foreign.slice(0, 400).map(([x, z]) => {
        let best = Infinity;
        for (const [wx, wz] of wallList) {
            const d = Math.abs(wx - x) + Math.abs(wz - z);
            if (d < best) best = d;
            if (best === 0) break;
        }
        return best;
    });
    assert.ok(
        nearestWalls.every((d) => d <= 2),
        `foreign land sits up to ${String(Math.max(...nearestWalls))} blocks from a wall - that is a leak, not boundary slack`,
    );
    const wilderness = foreign.filter(([x, z]) => labelAt(x, z) === 0);
    assert.ok(
        wilderness.length <= 40 && wilderness.every(([x, z]) => nearestIsWall(wallList, x, z) <= 2),
        `${String(wilderness.length)} enclosed cells are outside the civilization's own land`,
    );
});

/** @param {number[][]} wallList @param {number} x @param {number} z */
function nearestIsWall(wallList, x, z) {
    let best = Infinity;
    for (const [wx, wz] of wallList) {
        const d = Math.abs(wx - x) + Math.abs(wz - z);
        if (d < best) best = d;
        if (best === 0) break;
    }
    return best;
}

test("with gates open, Hearthgate reaches its ring neighbours and no others", () => {
    /** @type {Set<string>} */
    const wallCells = new Set();
    for (const op of allOps("walls")) {
        wallCells.add(key(op.x, op.z));
    }
    const district = /** @type {any[]} */ (PLAN.districts).find((entry) => entry.index === 1);
    const limit = 260;
    const window = { x0: district.bbox.x0 - limit, z0: district.bbox.z0 - limit, x1: district.bbox.x1 + limit, z1: district.bbox.z1 + limit };
    const result = escapeFrom(wallCells, district.centroid, window);
    // The fill passes gate rects, so it may leave through an opening - but only into a neighbour.
    const reachable = new Set();
    for (const wallGate of GATE_RECTS) {
        for (let x = wallGate.x0; x <= wallGate.x1; x += 1) {
            for (let z = wallGate.z0; z <= wallGate.z1; z += 1) {
                reachable.add(labelAt(x, z));
            }
        }
    }
    assert.ok(result.seen.size > 20000, `only ${String(result.seen.size)} cells explored`);
    assert.ok([...reachable].includes(2) || [...reachable].includes(5), `the gates face no ring neighbour at all: ${JSON.stringify([...reachable])}`);
    assert.ok(
        ![...reachable].includes(3) && ![...reachable].includes(4),
        `a district-1 gate opens onto a non-neighbour district: ${JSON.stringify([...reachable])}`,
    );
});

test("the ring neighbours are gated, and the outer wall has field access", () => {
    const byWall = new Map();
    for (const gate of /** @type {any[]} */ (RECORD.gates)) {
        byWall.set(gate.wallId, (byWall.get(gate.wallId) ?? 0) + 1);
    }
    // The plan may give district 1 extra adjacencies beyond the 1-2-3-4-5-1 ring; those shared
    // walls are barriers without gates, which the contract allows.
    const RING_NEIGHBOURS = [2, 5];
    let ringWalls = 0;
    for (const wall of /** @type {any[]} */ (RECORD.walls)) {
        const partner = (wall.between ?? []).find((label) => RING_NEIGHBOURS.includes(Number(label)));
        if (partner !== undefined) {
            ringWalls += 1;
            assert.ok(Number(byWall.get(wall.id) ?? 0) >= 1, `ring wall ${wall.id} (shared with district ${String(partner)}) has no gate`);
        }
    }
    assert.ok(ringWalls >= 2, `expected a gate-bearing wall toward districts 2 and 5, found ${String(ringWalls)}`);
    const outer = /** @type {any[]} */ (RECORD.walls).filter((wall) => wall.kind === "outer-wall");
    assert.ok(outer.length >= 1, "no outer wall was planned");
    assert.ok(
        outer.some((wall) => Number(byWall.get(wall.id) ?? 0) >= 1),
        "an entirely gateless outer wall: Hearthgate could not be supplied or evacuated from outside",
    );
});

/* ------------------------------------------------------------------ 3. gates */

test("every gate sits on its own wall and is reachable from a road", () => {
    const gates = /** @type {any[]} */ (RECORD.gates);
    assert.ok(gates.length >= 2, `only ${String(gates.length)} gates for a walled district`);
    const purposes = new Set(gates.map((gate) => gate.purpose));
    assert.ok(purposes.has("evac"), "no evacuation gate");
    assert.ok(purposes.has("reinforce"), "no reinforcement gate");

    const roadCells = new Set();
    for (const op of allOps("roads")) {
        roadCells.add(key(op.x, op.z));
    }
    const wallCellsByWall = new Map();
    for (let i = 0; i < RECORD.walls.length; i += 1) {
        wallCellsByWall.set(RECORD.walls[i].id, elementColumns("walls", i));
    }

    for (const gate of gates) {
        const band = wallCellsByWall.get(gate.wallId);
        assert.ok(band !== undefined && band.size > 0, `gate ${gate.id} names a wall that was not planned`);
        // planWall punches the whole gate footprint out of the wall band (WALL.gateHalfU/V is
        // wider than width/2), so measure the distance to the nearest wall column instead.
        let nearest = Infinity;
        let nearRoad = 0;
        for (const k of band) {
            const [x, z] = k.split(",").map(Number);
            nearest = Math.min(nearest, Math.hypot(x - gate.at.x, z - gate.at.z));
        }
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
            if (roadCells.has(key(gate.at.x + dx, gate.at.z + dz))) nearRoad += 1;
        }
        assert.ok(nearest <= 8, `gate ${gate.id} is ${nearest.toFixed(1)} blocks from its own wall`);
        assert.ok(nearRoad > 0, `gate ${gate.id} has no road leading to it`);
        assert.ok(Number(gate.width) >= 3, `gate ${gate.id} is only ${String(gate.width)} wide - carts cannot pass`);
        assert.ok(gate.total > 100, `gate ${gate.id} has no gatehouse (${String(gate.total)} ops)`);
    }
});

/* ------------------------------------------------------------------ 4. roads, elevation, stairs, bridges */

test("roads follow the terrain instead of lying on one plane", () => {
    const roads = /** @type {any[]} */ (RECORD.roads);
    assert.ok(roads.length >= 10, `only ${String(roads.length)} road elements`);
    const varying = roads.filter((road) => Number(road.surfaceMaxY) > Number(road.surfaceMinY));
    assert.ok(varying.length >= 3, "no road changes level with the ground");
    assert.ok(RECORD.stats.elevationSpan >= 3, `elevation span ${String(RECORD.stats.elevationSpan)} is flat`);
    for (const road of roads) {
        assert.ok(Number(road.surfaceMaxY) - Number(road.surfaceMinY) <= 40, `${road.id} spans ${String(road.surfaceMaxY - road.surfaceMinY)} levels`);
    }
    const stairOps = allOps("roads").filter((op) => op.kind === "stair");
    assert.ok(stairOps.length > 0, "sloped roads must produce stairs");
    assert.equal(RECORD.stats.roadRefusals, 0, `roads were refused: ${RECORD.notes.filter((note) => String(note).includes("no bridge") || String(note).includes("reroute")).join(" | ")}`);
});

test("wall access stairs reach the walkway and never abandon the wall", () => {
    const stairs = /** @type {any[]} */ (RECORD.dressing).filter((element) => element.kind === "wall-stairs");
    assert.ok(stairs.length >= 4, `only ${String(stairs.length)} wall access stairs`);
    for (const stair of stairs) {
        assert.ok(Number(stair.rise) >= 1, `${stair.id} climbs nothing`);
        assert.ok(Number(stair.opCount) >= Number(stair.rise), `${stair.id} has ${String(stair.opCount)} ops for a rise of ${String(stair.rise)}`);
    }
    const ids = new Set(allOps("dressing").map((op) => op.id));
    assert.ok([...ids].some((id) => String(id).includes("stair")), "no stair blocks in the dressing stage");
});

test("a road that meets water gets a bridge, not a fill", () => {
    const plan = fixture.validFullPlan(7);
    const river = makeField(7, { size: plan.grid.w * plan.cell + 80, lakes: [] });
    // Force water straight across the middle of district 1 so a road must bridge it.
    const base = { at: river.at.bind(river) };
    const midZ = Math.round((plan.districts[0].bbox.z0 + plan.districts[0].bbox.z1) / 2);
    const wet = {
        seed: 7,
        bounds: base.at ? river.bounds : river.bounds,
        at(x, z) {
            const cell = river.at(x, z);
            if (Math.abs(z - midZ) <= 2) {
                return { g: cell.g - 3, k: "water", tree: false };
            }
            return cell;
        },
    };
    const result = D.planDistrictSite(plan, 1, wet, { seed: 7 });
    assert.ok(result.ok, `the bridged site plan failed: ${result.problems.slice(0, 3).join(" | ")}`);
    const deck = /** @type {any[]} */ (result.record.roads).filter((element) => element.kind.startsWith("road-"));
    let bridges = 0;
    for (let i = 0; i < deck.length; i += 1) {
        for (const op of D.siteOpsFor(result.record, "roads", i)) {
            if (op.kind === "deck" || op.kind === "pillar" || op.kind === "rail") bridges += 1;
        }
    }
    assert.ok(bridges > 0, "a road crossing water produced no bridge ops");
});

/* ------------------------------------------------------------------ 5. lots, spacing, overlap */

test("buildings are spaced apart and no two structures share a column", () => {
    const buildings = /** @type {any[]} */ (RECORD.lots).filter((element) => String(element.id).startsWith("building-"));
    assert.ok(buildings.length >= 20, `only ${String(buildings.length)} buildings planned`);
    assert.ok(RECORD.stats.residentialLots >= 5, "the residential neighbourhoods are missing");

    /** @type {Map<string, string>} */
    const claimed = new Map();
    const overlaps = [];
    for (let i = 0; i < RECORD.lots.length; i += 1) {
        const element = RECORD.lots[i];
        if (!String(element.id).startsWith("building-")) {
            continue;
        }
        for (const op of D.siteOpsFor(RECORD, "lots", i)) {
            const k = key(op.x, op.z);
            const owner = claimed.get(k);
            if (owner !== undefined && owner !== element.id) {
                overlaps.push(`${owner} and ${element.id} both occupy ${k}`);
            }
            claimed.set(k, element.id);
        }
    }
    assert.equal(overlaps.length, 0, `structures overlap: ${overlaps.slice(0, 3).join(" ; ")}`);

    // Independent nearest-neighbour gap between building footprints.
    const rects = buildings.map((building) => building.bbox);
    let minGap = Infinity;
    for (let a = 0; a < rects.length; a += 1) {
        for (let b = a + 1; b < rects.length; b += 1) {
            const gx = Math.max(rects[b].x0 - rects[a].x1 - 1, rects[a].x0 - rects[b].x1 - 1);
            const gz = Math.max(rects[b].z0 - rects[a].z1 - 1, rects[a].z0 - rects[b].z1 - 1);
            const gap = Math.max(gx, gz);
            if (gap >= 0) minGap = Math.min(minGap, gap);
        }
    }
    assert.ok(minGap >= 1, `buildings are packed with a gap of only ${String(minGap)}`);
    const crowded = rects.filter((rect) => (rect.x1 - rect.x0 + 1) * (rect.z1 - rect.z0 + 1) > 60 * 60);
    assert.equal(crowded.length, 0, "a building footprint is implausibly large");
});

test("structures do not sit on the wall band", () => {
    const wallCells = new Set();
    for (const op of allOps("walls")) {
        wallCells.add(key(op.x, op.z));
    }
    const buildings = /** @type {any[]} */ (RECORD.lots).filter((element) => String(element.id).startsWith("building-"));
    for (let i = 0; i < RECORD.lots.length; i += 1) {
        const element = RECORD.lots[i];
        if (!String(element.id).startsWith("building-")) {
            continue;
        }
        for (const op of D.siteOpsFor(RECORD, "lots", i)) {
            assert.ok(!wallCells.has(key(op.x, op.z)), `${element.id} is built inside the wall at ${key(op.x, op.z)}`);
        }
    }
    assert.ok(buildings.length > 0);
});

test("every planned lot is either pad-ready or explained in the notes", () => {
    const dropped = Number(RECORD.stats.lotsWithoutPad);
    const explained = RECORD.notes.filter((note) => String(note).includes("no buildable pad")).length;
    assert.ok(
        explained >= dropped,
        `${String(dropped)} lots have no pad but only ${String(explained)} carry a reason`,
    );
    for (const element of /** @type {any[]} */ (RECORD.lots)) {
        if (String(element.id).startsWith("pad-")) {
            assert.ok(Number.isInteger(element.baseY), `${element.id} has no level base height`);
            assert.ok(Number(element.total) > 0, `${element.id} pads nothing`);
        }
    }
});

/* ------------------------------------------------------------------ 6. connectivity + routes */

test("roads connect the plaza to every gate and give every door a street", () => {
    /** @type {Set<string>} */
    const roadCells = new Set();
    for (const op of allOps("roads")) {
        if (op.kind === "road" || op.kind === "stair" || op.kind === "deck" || op.kind === "fill") {
            roadCells.add(key(op.x, op.z));
        }
    }
    assert.ok(roadCells.size > 500, `only ${String(roadCells.size)} road cells`);

    // BFS over 8-connected road cells from the HQ plaza.
    const plaza = /** @type {any[]} */ (RECORD.dressing).find((element) => element.kind === "hq-plaza");
    assert.ok(plaza !== undefined, "no HQ plaza was planned");
    const start = plaza.at;
    const seen = new Set([key(start.x, start.z)]);
    const queue = [[start.x, start.z, 0]];
    while (queue.length > 0) {
        const [x, z, d] = /** @type {[number, number, number]} */ (queue.shift());
        if (d > 400) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const k = key(x + dx, z + dz);
            if (seen.has(k) || !roadCells.has(k)) continue;
            seen.add(k);
            queue.push([x + dx, z + dz, d + 1]);
        }
    }
    assert.ok(seen.size > 300, `the road network from the plaza is only ${String(seen.size)} cells`);

    // A door is served when its own cell or its lot's frontage cell (the street/patrol cell the
    // layout connected it to) sits on the surfaced network.
    const onNetwork = (cell) => {
        if (cell === undefined || cell === null) return false;
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
            if (roadCells.has(key(cell.x + dx, cell.z + dz))) return true;
        }
        return false;
    };
    let orphanDoors = 0;
    let unservedFrontage = 0;
    for (const building of /** @type {any[]} */ (RECORD.lots).filter((element) => String(element.id).startsWith("building-"))) {
        const via = String(building.frontage?.via ?? "none");
        assert.ok(via === "road" || via === "patrol", `${building.id} fronts ${via}, which is not a street`);
        if (!onNetwork(building.door) && !onNetwork(building.frontage)) orphanDoors += 1;
        if (!onNetwork(building.frontage)) unservedFrontage += 1;
    }
    assert.equal(orphanDoors, 0, `${String(orphanDoors)} buildings have no road at their door or frontage`);
    assert.equal(unservedFrontage, 0, `${String(unservedFrontage)} frontage cells are not on the surfaced network`);
    const patrolFronted = /** @type {any[]} */ (RECORD.lots).filter((element) => String(element.id).startsWith("building-") && element.frontage?.via === "patrol");
    if (patrolFronted.length > 0) {
        assert.ok(RECORD.stats.ringRoads >= 1, "buildings front the patrol lane but no ring road was surfaced");
    }
});

test("evacuation and reinforcement routes exist and pass only through planned gates", () => {
    const plannedGateIds = new Set(/** @type {any[]} */ (PLAN.gates).map((gate) => String(gate.id)));
    const districtGateIds = new Set(/** @type {any[]} */ (RECORD.gates).map((gate) => gate.id));
    assert.ok(RECORD.routes.evac.length >= 1, "no evacuation route for the district");
    assert.ok(RECORD.routes.reinforce.length >= 1, "no reinforcement route for the district");
    for (const route of [...RECORD.routes.evac, ...RECORD.routes.reinforce]) {
        assert.notEqual(route.from, route.to, "a route leads nowhere");
        assert.ok(route.gates.length >= 1, `${String(route.from)}->${String(route.to)} uses no gate`);
        for (const id of route.gates) {
            assert.ok(plannedGateIds.has(id), `${String(route.from)}->${String(route.to)} names a gate that does not exist: ${id}`);
        }
        assert.ok(
            route.throughDistrictGates >= 1,
            `${String(route.from)}->${String(route.to)} passes no gate that belongs to district 1`,
        );
        assert.ok(
            route.gates.some((id) => districtGateIds.has(id)),
            `${String(route.from)}->${String(route.to)} has no gate that was physically planned`,
        );
    }
    const targets = new Set(RECORD.routes.evac.map((route) => (Number(route.from) === 1 ? route.to : route.from)));
    assert.ok(targets.size >= 1, "evacuation leads to no neighbouring district");
});

/* ------------------------------------------------------------------ 7. containment + compatibility */

test("everything built belongs to Hearthgate or to an approved gate connection", () => {
    assert.deepEqual(D.siteContainmentProblems(PLAN, 1, RECORD), []);
});

test("link roads leave only toward one paired district and only through a gate", () => {
    const links = /** @type {any[]} */ (RECORD.roads).filter((element) => element.kind === "road-link" || Number(element.district) !== 1);
    for (const link of links) {
        if (Number(link.outsideCells) > 0) {
            assert.equal(link.throughGate, true, `${link.id} leaves the district without passing a gate`);
            const joined = (link.crossesTo ?? []).filter((label) => Number(label) > 0);
            assert.ok(joined.length <= 1, `${link.id} joins ${joined.join(", ")}`);
        }
    }
});

test("the 49x49 prototype planner is untouched and still deterministic", () => {
    const prototype = planDistrict(createInitialKingdom().districts[0], "hearthgate");
    assert.equal(prototype.layoutId, "hearthgate");
    assert.equal(prototype.half, 24);
    assert.ok(prototype.blockCount > 5000 && prototype.blockCount <= MAX_PLAN_BLOCKS);
    const again = planDistrict(createInitialKingdom().districts[0], "hearthgate");
    assert.equal(planHash(prototype), planHash(again));
    assert.notEqual(RECORD.layoutId, "hearthgate", "the enlarged layout must be a new versioned layout");
    assert.ok(RECORD.stats.totalOps > prototype.blockCount, "the enlarged plan should be far bigger than the prototype");
});

test("the parent master plan still validates, so the site plan did not disturb it", () => {
    const result = validatePlan(PLAN, {});
    assert.equal(result.ok, true, (/** @type {any[]} */ (result.errors ?? result.problems ?? [])).slice(0, 3).join(" | "));
});

test("a district plan that would land on a protected footprint refuses instead of building", () => {
    const bbox = RECORD.bbox;
    const blocked = D.planDistrictSite(PLAN, 1, field, {
        seed: SEED,
        excludeFootprints: [{ x0: bbox.x0 + 5, z0: bbox.z0 + 5, x1: bbox.x0 + 80, z1: bbox.z0 + 80 }],
    });
    assert.ok(blocked.record !== null, "planning should still succeed, minus the protected parts");
    const skipped = blocked.notes.filter((note) => String(note).includes("protected record"));
    assert.ok(skipped.length > 0, "nothing was refused despite a protected footprint across the district");
    const full = Number(RECORD.stats.buildings);
    assert.ok(Number(blocked.record.stats.buildings) < full, "the protected area was built in anyway");
});

test("districts 2-5 are refused: Phase C covers Hearthgate only", async () => {
    for (const index of [2, 3, 4, 5]) {
        const result = D.planDistrictSite(PLAN, index, field, { seed: SEED });
        assert.equal(result.ok, false, `district ${String(index)} must not be planned yet`);
        assert.match(result.problems.join(" "), /Phase C plans Hearthgate only/);
    }
});

/* ------------------------------------------------------------------ 8. determinism + bounds */

test("the same seed produces the same plan, a different seed does not", () => {
    const a = D.planDistrictSite(PLAN, 1, field, { seed: SEED });
    const b = D.planDistrictSite(PLAN, 1, field, { seed: SEED });
    assert.equal(a.record.checksum, b.record.checksum);
    assert.equal(a.record.checksum, RECORD.checksum);
    const c = D.planDistrictSite(PLAN, 1, field, { seed: SEED + 1 });
    assert.notEqual(c.record.checksum, RECORD.checksum, "a different seed changed nothing");
});

test("element op hashes match regeneration, so a resumed job can detect drift", () => {
    for (const stage of D.SITE_STAGES) {
        const list = /** @type {any[]} */ (RECORD[stage] ?? []);
        for (let i = 0; i < Math.min(list.length, 6); i += 1) {
            const element = list[i];
            const ops = D.siteOpsFor(RECORD, stage, i);
            assert.equal(ops.length, element.total, `${stage}/${element.id} total drifted`);
            const again = D.siteOpsFor(RECORD, stage, i);
            assert.deepEqual(again, ops, `${stage}/${element.id} regenerated differently`);
        }
    }
});

test("memory stays bounded: ops are generated in slices and never stored in the record", () => {
    const beforeBytes = Number(RECORD.recordBytes);
    assert.ok(beforeBytes <= CIV_LIMITS.maxPlanBytes, `record is ${String(beforeBytes)} bytes`);
    let streamed = 0;
    let biggest = 0;
    for (const slice of D.siteOpSlices(RECORD)) {
        streamed += slice.ops.length;
        biggest = Math.max(biggest, slice.ops.length);
        assert.ok(slice.ops.length <= CIV_LIMITS.maxBlocksPerSlice, `${slice.stage}/${slice.element} emitted ${String(slice.ops.length)} ops in one slice`);
    }
    assert.equal(streamed, D.siteOpCount(RECORD), "streamed ops disagree with the stored totals");
    assert.ok(biggest <= CIV_LIMITS.maxBlocksPerSlice);
    assert.ok(JSON.stringify(RECORD).length < beforeBytes + 4000, "the record grew while ops were being streamed");
    for (const stage of D.SITE_STAGES) {
        for (const element of /** @type {any[]} */ (RECORD[stage] ?? [])) {
            assert.equal(element.ops, undefined, `${stage}/${element.id} keeps its ops in the record`);
        }
    }
    assert.ok(streamed > 50000, `only ${String(streamed)} ops produced for a 40k-column district`);
});

test("the site plan feeds civ/jobs.js as a resumable queue", () => {
    const specs = D.siteJobSpecs(RECORD);
    const queue = createQueue(specs, { planHash: String(RECORD.checksum) });
    const total = Object.values(specs).reduce((sum, list) => sum + (/** @type {any[]} */ (list)).length, 0);
    assert.equal(queue.total.length, total);
    for (const stage of ["clear", "walls", "gates", "roads", "lots", "dressing"]) {
        assert.ok((/** @type {any[]} */ (specs[stage] ?? [])).length > 0, `stage ${stage} produced no work`);
    }
    const report = progress(queue);
    assert.ok(Number(report.remaining ?? total) > 0, "a fresh plan must not look already built");
    assert.equal(D.siteOpCount(RECORD), Object.values(specs).reduce((sum, list) => sum + (/** @type {any[]} */ (list)).reduce((inner, spec) => inner + Number(spec.total), 0), 0));
});
