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
    assert.equal(RECORD.version, 2, "record format 2: canonical ops, priority resolution, rehydration inputs");
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
            if (op.kind === "bridge" || op.kind === "support") bridges += 1;
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

/* =================================================================================================
 * Round 2: canonical ops, priorities, one walkable network, doors, supports, wall-7, lots.
 * Every check below runs on SEVERAL seeds and terrains, not only seed 21, with independent
 * geometry (own flood fills, own priority table, own support search).
 * ================================================================================================= */

const O = await load("civ", "opnorm.js");
const GT = await load("civ", "gates.js");
const GEOM = await load("civ", "geom.js");
const PROFILE = await load("civ", "siteprofile.js");
const vanilla = await import(pathToFileURL(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "index.js")).href);
const { readFileSync } = await import("node:fs");
const blockStatesSource = readFileSync(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "mojang-block.d.ts"), "utf8");

/** Terrains and seeds the invariants are proven on: rough (relief 18) and flat. */
const CASES = [
    { name: "seed 21 rough", seed: 21, relief: 18 },
    { name: "seed 3 rough", seed: 3, relief: 18 },
    { name: "seed 7 rough", seed: 7, relief: 18 },
    { name: "seed 42 rough", seed: 42, relief: 18 },
    { name: "seed 99 rough", seed: 99, relief: 18 },
    { name: "seed 12 flat", seed: 12, relief: 2 },
    { name: "seed 8 flat", seed: 8, relief: 2 },
];
const caseCache = new Map();
function buildCase(spec) {
    if (spec.seed === SEED && spec.relief === 18) {
        return { ...spec, field, plan: PLAN, site, record: RECORD };
    }
    let hit = caseCache.get(spec.name);
    if (hit === undefined) {
        const f = makeField(spec.seed, { relief: spec.relief, hills: 60 });
        const planned2 = M.planCivilizationDetailed(f, { seed: spec.seed });
        assert.ok(planned2.ok, `${spec.name}: master plan failed`);
        const s = D.planDistrictSite(planned2.plan, 1, f, { seed: spec.seed });
        assert.ok(s.ok, `${spec.name}: ${s.problems.slice(0, 3).join(" | ")}`);
        hit = { ...spec, field: f, plan: planned2.plan, site: s, record: s.record };
        caseCache.set(spec.name, hit);
    }
    return hit;
}

const STAGE_ORDER = ["clear", "walls", "gates", "roads", "lots", "dressing"];
/** Independent priority table (smaller wins): walls > gates > buildings > pads > roads > dressing. */
function priorityOf(stage, element) {
    if (stage === "walls") return 0;
    if (stage === "gates") return 1;
    if (stage === "lots") return String(element.id).startsWith("building-") ? 2 : 3;
    if (stage === "roads") return 4;
    if (stage === "dressing") return 5;
    return 9;
}

const streamCache = new WeakMap();
function streamsOf(c) {
    let hit = streamCache.get(c.record);
    if (hit === undefined) {
        hit = [];
        for (const stage of STAGE_ORDER) {
            c.record[stage].forEach((element, i) => hit.push({ stage, element, ops: D.siteOpsFor(c.record, stage, i) }));
        }
        streamCache.set(c.record, hit);
    }
    return hit;
}

const sigOf = (op) => op.id + (op.states === undefined ? "" : JSON.stringify(op.states));

/** Surfaced walking cells (4/8-connected, |dy| <= 1) from the final op streams. */
function walkNetwork(c) {
    const streams = streamsOf(c);
    const surf = new Map();
    const owner = new Map();
    for (const { stage, element, ops } of streams) {
        if (stage !== "roads" && !(stage === "dressing" && element.kind === "wall-stairs")) continue;
        for (const op of ops) {
            if (!["road", "stair", "top", "bridge"].includes(op.kind) || op.id.endsWith("_wall")) continue;
            const k = key(op.x, op.z);
            surf.set(k, op.y);
            owner.set(k, element.id);
        }
    }
    // The gate passage floor (polished andesite at the walking level - 1) is walkable too.
    const sills = new Map();
    for (const gate of c.record.gates) {
        const cells = [];
        for (const op of D.siteOpsById(c.record, "gates", gate.id)) {
            if (op.y === gate.walkingLevel - 1 && op.id === "minecraft:polished_andesite" && Math.abs(op.x - gate.at.x) <= 2 && Math.abs(op.z - gate.at.z) <= 2) cells.push(op);
        }
        sills.set(gate.id, cells);
        for (const op of cells) {
            const k = key(op.x, op.z);
            if (!surf.has(k)) {
                surf.set(k, op.y);
                owner.set(k, `sill-${gate.id}`);
            }
        }
    }
    // Building exits are the door-side nodes.
    for (const element of c.record.lots) {
        if (!String(element.id).startsWith("building-")) continue;
        const k = key(element.exit.x, element.exit.z);
        if (!surf.has(k)) {
            surf.set(k, element.baseY);
            owner.set(k, `exit-${element.lot}`);
        }
    }
    const comp = new Map();
    const sizes = [0];
    let n = 0;
    for (const start of surf.keys()) {
        if (comp.has(start)) continue;
        n += 1;
        let size = 0;
        const stack = [start];
        comp.set(start, n);
        while (stack.length > 0) {
            const cur = stack.pop();
            size += 1;
            const [x, z] = cur.split(",").map(Number);
            const y = surf.get(cur);
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const q = key(x + dx, z + dz);
                if (!surf.has(q) || comp.has(q) || Math.abs(surf.get(q) - y) > 1) continue;
                comp.set(q, n);
                stack.push(q);
            }
        }
        sizes.push(size);
    }
    let main = 1;
    for (let i = 2; i < sizes.length; i += 1) if (sizes[i] > sizes[main]) main = i;
    return { surf, owner, comp, sizes, main, sills };
}

/* ------------------------------------------------------------------ canonical ops */

test("opnorm: ids collapse to the prefixed form, dir becomes states, retired ids and unknown kinds are handled", () => {
    const a = O.normalizeOp({ x: 1, y: 2, z: 3, id: "stone_bricks", kind: "wall" });
    const b = O.normalizeOp({ x: 1, y: 2, z: 3, id: "minecraft:stone_bricks", kind: "wall" });
    assert.deepEqual(a, b);
    assert.equal(a.id, "minecraft:stone_bricks");
    assert.equal(O.normalizeOp({ x: 0, y: 0, z: 0, id: "minecraft:dirt_path", kind: "road" }).id, "minecraft:grass_path", "dirt_path does not exist in this game version");
    assert.equal(O.normalizeOp({ x: 0, y: 0, z: 0, id: "stone_bricks", layer: "body" }).kind, "wall", "walls.js layers fold into the wall kind");
    assert.equal(O.normalizeOp({ x: 0, y: 0, z: 0, id: "cobblestone", layer: "footing" }).kind, "footing");
    assert.equal(O.normalizeOp({ x: 0, y: 0, z: 0, id: "stone", kind: "ours", ground: true }).kind, "footing", "ground-replacing gate blocks are footings");
    assert.equal(O.normalizeOp({ x: 0, y: 0, z: 0, id: "stone", kind: "retain" }).kind, "retaining");
    assert.equal(O.normalizeOp({ x: 0, y: 0, z: 0, id: "stone", kind: "pillar" }).kind, "support");
    assert.equal(O.normalizeOp({ x: 0, y: 0, z: 0, id: "stone", kind: "building" }).kind, "structure");
    const stair = O.normalizeOp({ x: 0, y: 0, z: 0, id: "minecraft:stone_brick_stairs", kind: "stair", dir: "south" });
    assert.equal(stair.dir, undefined);
    assert.deepEqual(stair.states, { upside_down_bit: false, weirdo_direction: 2 });
    assert.throws(() => O.normalizeOp({ x: 0, y: 0, z: 0, id: "stone", kind: "bananas" }), /closed list/);
    assert.throws(() => O.normalizeOp({ x: 0.5, y: 0, z: 0, id: "stone", kind: "wall" }), /integer/);
    assert.throws(() => O.normalizeOp({ x: 0, y: 0, z: 0, id: "mod:stone", kind: "wall" }), /minecraft/);
    assert.deepEqual(O.OP_KIND_NAMES.slice().sort(), ["bridge", "clear", "cut", "dress", "fill", "footing", "gate", "pad", "retaining", "road", "stair", "structure", "support", "top", "wall"]);
    for (const kind of O.OP_KIND_NAMES) {
        assert.ok(["vegetation-clear", "natural-ground", "build"].includes(O.safetyClassOf(kind)), `${kind} has no valid safety class`);
    }
    assert.equal(O.safetyClassOf("clear"), "vegetation-clear");
    assert.equal(O.safetyClassOf("structure"), "build");
    assert.equal(O.safetyClassOf("cut"), "natural-ground");
});

test("every op of every planned stage is canonical, a real block with valid states, and of a listed kind", () => {
    const known = new Set(Object.values(vanilla.MinecraftBlockTypes));
    const statesFor = (id) => {
        const typeName = `${id.replace("minecraft:", "").split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}States`;
        const match = blockStatesSource.match(new RegExp(`export type ${typeName} = ([^;]+);`));
        if (!match) return undefined;
        if (match[1].startsWith("Record<string, never>")) return [];
        return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).filter((name) => name !== "BlockStateSuperset");
    };
    for (const spec of CASES) {
        const c = buildCase(spec);
        const kindsSeen = new Set();
        const stateNames = new Map();
        let ops = 0;
        for (const { stage, element, ops: list } of streamsOf(c)) {
            for (const op of list) {
                ops += 1;
                assert.deepEqual(O.canonicalProblems(op), [], `${spec.name} ${stage}/${element.id}: ${JSON.stringify(op)}`);
                assert.ok(known.has(op.id), `${spec.name} ${stage}/${element.id}: ${op.id} is not a block in this game version`);
                assert.ok(Object.hasOwn(O.OP_KINDS, op.kind), `${spec.name}: kind ${op.kind} is not in the closed list`);
                assert.ok(op.y >= -64 && op.y <= 320, `${spec.name}: y ${String(op.y)} outside the world`);
                kindsSeen.add(op.kind);
                if (op.states !== undefined) stateNames.set(op.id, new Set([...(stateNames.get(op.id) ?? []), ...Object.keys(op.states)]));
            }
        }
        assert.ok(ops > 40000, `${spec.name}: only ${String(ops)} ops`);
        for (const [id, names] of stateNames) {
            const allowed = statesFor(id);
            assert.ok(allowed, `${spec.name}: no state list for ${id}`);
            for (const name of names) assert.ok(allowed.includes(name), `${spec.name}: ${id} has no state '${name}'`);
        }
        assert.ok(!kindsSeen.has("dir"), "dir leaked");
        for (const must of ["clear", "wall", "gate", "road", "stair", "cut", "fill", "structure", "pad", "footing", ...(spec.relief >= 10 ? ["retaining"] : [])]) {
            assert.ok(kindsSeen.has(must), `${spec.name}: no '${must}' ops at all`);
        }
    }
});

test("stairs carry real facing states, and no retired block id is ever emitted", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        let stairs = 0;
        for (const { ops } of streamsOf(c)) {
            for (const op of ops) {
                assert.notEqual(op.id, "minecraft:dirt_path");
                if (op.kind === "stair") {
                    stairs += 1;
                    assert.ok(Number.isInteger(op.states?.weirdo_direction) && op.states.weirdo_direction >= 0 && op.states.weirdo_direction <= 3, `${spec.name}: stair without weirdo_direction ${JSON.stringify(op)}`);
                    assert.equal(op.states.upside_down_bit, false);
                }
            }
        }
        assert.ok(stairs > 200, `${spec.name}: only ${String(stairs)} stairs`);
    }
});

/* ------------------------------------------------------------------ priorities and conflicts */

test("no coordinate is written two different blocks unless the later writer is the stronger one (walls > gates > buildings > pads > roads > dress)", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        const at = new Map();
        for (const { stage, element, ops } of streamsOf(c)) {
            const pr = priorityOf(stage, element);
            for (const op of ops) {
                const k = `${String(op.x)},${String(op.y)},${String(op.z)}`;
                const list = at.get(k);
                const entry = { pr, sig: sigOf(op), who: `${stage}/${element.id}(${op.kind})` };
                if (list === undefined) at.set(k, [entry]);
                else list.push(entry);
            }
        }
        let conflicting = 0;
        const bad = [];
        for (const [k, list] of at) {
            if (list.length < 2 || list.every((entry) => entry.sig === list[0].sig)) continue;
            conflicting += 1;
            const strongest = Math.min(...list.map((entry) => entry.pr));
            if (list[list.length - 1].pr !== strongest) bad.push(`${k}: ${list.map((entry) => entry.who).join(" > ")}`);
        }
        assert.deepEqual(bad.slice(0, 5), [], `${spec.name}: the last writer is not the strongest at ${String(bad.length)} coordinates`);
        // The documented overrides are preparation layers (clear / cut / pad under a building, a building over a road).
        assert.ok(conflicting < 9000, `${spec.name}: ${String(conflicting)} layered coordinates is suspicious`);
    }
});

test("no road, patrol, stair or dressing op ever replaces or removes a wall or gate block", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        const owners = new Map();
        for (const { stage, element, ops } of streamsOf(c)) {
            if (stage !== "walls" && stage !== "gates") continue;
            for (const op of ops) owners.set(`${String(op.x)},${String(op.y)},${String(op.z)}`, `${stage}/${element.id}`);
        }
        assert.ok(owners.size > 20000);
        const offenders = [];
        for (const { stage, element, ops } of streamsOf(c)) {
            if (stage === "walls" || stage === "gates" || stage === "clear") continue;
            for (const op of ops) {
                const k = `${String(op.x)},${String(op.y)},${String(op.z)}`;
                if (owners.has(k)) offenders.push(`${stage}/${element.id}(${op.kind}) over ${owners.get(k)} at ${k}`);
            }
        }
        assert.deepEqual(offenders.slice(0, 5), [], `${spec.name}: ${String(offenders.length)} ops overwrite a wall or gate block`);
        // the cells the gate adapter writes when it closes a gate must be free of every other element
        const taken = new Map();
        for (const { stage, element, ops } of streamsOf(c)) {
            for (const op of ops) taken.set(`${String(op.x)},${String(op.y)},${String(op.z)}`, `${stage}/${element.id}`);
        }
        for (const gate of c.record.gates) {
            const gateSpec = { id: gate.id, axis: gate.axis, at: gate.at, y: gate.walkingLevel, width: gate.width, wallTop: gate.wallTopHeight, passageHeight: gate.passageHeight };
            for (const cell of GT.cellsToToggle(gateSpec)) {
                const owner = taken.get(`${String(cell.x)},${String(cell.y)},${String(cell.z)}`);
                assert.ok(owner === undefined || owner.startsWith("gates/"), `${spec.name}: closing ${gate.id} would hit ${owner} at ${cell.x},${cell.y},${cell.z}`);
                // ...and stays inside the gate element footprint, so closing needs no ops outside it
                assert.ok(cell.x >= gate.bbox.x0 - 1 && cell.x <= gate.bbox.x1 + 1 && cell.z >= gate.bbox.z0 - 1 && cell.z <= gate.bbox.z1 + 1, `${spec.name}: ${gate.id} toggle cell outside its footprint`);
            }
        }
    }
});

test("gatehouses are walled-gate sized, not 70-block towers, and keep what the adapter needs", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        for (const gate of c.record.gates) {
            assert.equal(gate.wallTopHeight, 7);
            const ops = D.siteOpsById(c.record, "gates", gate.id);
            const top = Math.max(...ops.map((op) => op.y));
            assert.ok(top - gate.walkingLevel <= 7 + 4 + 3, `${spec.name}: ${gate.id} stands ${String(top - gate.walkingLevel)} above the walking level`);
            assert.ok(gate.total > 150 && gate.total < 1200, `${spec.name}: ${gate.id} has ${String(gate.total)} ops`);
            assert.ok(ops.some((op) => op.id === "minecraft:iron_bars"), `${spec.name}: ${gate.id} lacks the raised portcullis slot`);
            assert.ok(ops.some((op) => op.id === "minecraft:lever"), `${spec.name}: ${gate.id} lacks levers`);
        }
    }
});

/* ------------------------------------------------------------------ one walkable network */

test("the patrol ring, every gate throat, every wall stair and every door form ONE walkable network", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        const net = walkNetwork(c);
        const stray = new Map();
        for (const [k, id] of net.owner) {
            if (net.comp.get(k) !== net.main) stray.set(id, (stray.get(id) ?? 0) + 1);
        }
        assert.deepEqual([...stray.entries()].slice(0, 5), [], `${spec.name}: walkable cells outside the main network`);
        assert.ok(net.sizes[net.main] > 3000, `${spec.name}: main network is only ${String(net.sizes[net.main])} cells`);
        // the ring reaches the arterials
        const ring = [...net.owner].filter(([, id]) => id === "patrol-lane");
        assert.ok(ring.length > 300, `${spec.name}: patrol ring is only ${String(ring.length)} cells`);
        assert.ok(ring.every(([k]) => net.comp.get(k) === net.main));
        const arterials = new Set(c.record.roads.filter((r) => r.kind === "road-arterial").map((r) => r.id));
        assert.ok(arterials.size >= 1, `${spec.name}: no arterial`);
        for (const id of arterials) {
            const cells = [...net.owner].filter(([, owner]) => owner === id);
            assert.ok(cells.length > 0 && cells.every(([k]) => net.comp.get(k) === net.main), `${spec.name}: arterial ${id} is cut off`);
        }
        // gate throats (both the sill and the inside apron)
        for (const gate of c.record.gates) {
            const sill = net.sills.get(gate.id);
            assert.ok(sill.length >= 10, `${spec.name}: ${gate.id} has no walkable throat`);
            assert.ok(sill.every((op) => net.comp.get(key(op.x, op.z)) === net.main), `${spec.name}: ${gate.id} throat is cut off`);
            if (gate.insideSide !== 0) {
                // the five cells just inside the throat are surfaced and part of the network
                const dir = gate.axis === "x" ? [0, gate.insideSide] : [gate.insideSide, 0];
                const edge = Math.max(...sill.map((op) => op.x * dir[0] + op.z * dir[1]));
                const beyond = sill.filter((op) => op.x * dir[0] + op.z * dir[1] === edge).map((op) => key(op.x + dir[0], op.z + dir[1]));
                const linked = beyond.filter((k) => net.comp.get(k) === net.main);
                assert.ok(linked.length >= 3, `${spec.name}: ${gate.id} opens onto ${String(linked.length)} walkable cells inside the district`);
            }
        }
        // wall stairs (bottoms and tops)
        const stairs = c.record.dressing.filter((e) => e.kind === "wall-stairs");
        assert.ok(stairs.length >= 4, `${spec.name}: ${String(stairs.length)} wall stairs`);
        for (const stair of stairs) {
            assert.equal(net.comp.get(key(stair.bottom.x, stair.bottom.z)), net.main, `${spec.name}: ${stair.id} bottom is cut off from the network`);
        }
        // every door
        const buildings = c.record.lots.filter((e) => String(e.id).startsWith("building-"));
        for (const b of buildings) {
            const exit = net.comp.get(key(b.exit.x, b.exit.z));
            assert.equal(exit, net.main, `${spec.name}: ${b.id} exit cannot reach the network`);
            assert.ok(net.surf.has(key(b.frontage.x, b.frontage.z)), `${spec.name}: ${b.id} frontage ${b.frontage.x},${b.frontage.z} is not a surfaced cell`);
        }
    }
});

test("military positions are reachable from every gate", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        const net = walkNetwork(c);
        const military = c.record.lots.filter((e) => String(e.id).startsWith("building-") && /barracks|guard_post|watchtower|hq_citadel|armoury|command_hall/.test(e.kind));
        assert.ok(military.length >= 5, `${spec.name}: only ${String(military.length)} military buildings`);
        assert.ok(c.record.gates.length >= 3);
        const gateComps = new Set();
        for (const [id, cells] of net.sills) for (const op of cells) gateComps.add(net.comp.get(key(op.x, op.z)));
        assert.equal(gateComps.size, 1, `${spec.name}: gates sit in different networks`);
        for (const b of military) {
            assert.ok(gateComps.has(net.comp.get(key(b.exit.x, b.exit.z))), `${spec.name}: ${b.id} cannot be reached from the gates`);
        }
        // tower access: a wall stair is reachable from the gates too
        for (const stair of c.record.dressing.filter((e) => e.kind === "wall-stairs")) {
            assert.ok(gateComps.has(net.comp.get(key(stair.bottom.x, stair.bottom.z))), `${spec.name}: ${stair.id} unreachable from the gates`);
        }
    }
});

test("every door has an explicit path laid to its street, and the path is made of road cells", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        const approachCells = new Map();
        for (const element of c.record.roads.filter((e) => String(e.id).startsWith("approach-"))) {
            const set = new Set();
            for (const op of D.siteOpsById(c.record, "roads", element.id)) if (op.kind === "road" || op.kind === "stair") set.add(key(op.x, op.z));
            approachCells.set(element.lot, set);
        }
        const net = walkNetwork(c);
        let direct = 0;
        for (const b of c.record.lots.filter((e) => String(e.id).startsWith("building-"))) {
            const cells = approachCells.get(b.lot);
            const next = (p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => key(p.x + dx, p.z + dz));
            if (cells === undefined) {
                // frontage right at the exit
                direct += 1;
                assert.ok(next(b.exit).includes(key(b.frontage.x, b.frontage.z)) || key(b.exit.x, b.exit.z) === key(b.frontage.x, b.frontage.z), `${spec.name}: ${b.id} has no path and its frontage is not at its exit`);
            } else {
                assert.ok(next(b.exit).some((q) => cells.has(q)), `${spec.name}: ${b.id} path does not start at the exit`);
                assert.ok([...cells].some((q) => next({ x: Number(q.split(",")[0]), z: Number(q.split(",")[1]) }).includes(key(b.frontage.x, b.frontage.z))), `${spec.name}: ${b.id} path does not reach the frontage`);
            }
            assert.ok(net.surf.has(key(b.frontage.x, b.frontage.z)));
        }
        assert.ok(direct < 20);
    }
});

test("every enterable building has a door block; only open-air kinds are allowed without one", () => {
    const OPEN_AIR = new Set(["well", "pen", "garden", "market_stall", "market_square", "drill_ground", "customs_yard", "quarry_yard", "orchard", "farm_wheat", "farm_veg", "farm_irrigated", "farm_kitchen", "farm_allot"]);
    for (const spec of CASES) {
        const c = buildCase(spec);
        for (const stage of [c.record.lots]) {
            stage.forEach((element, i) => {
                if (!String(element.id).startsWith("building-")) return;
                const kind = element.kind.replace("building-", "");
                const ops = D.siteOpsFor(c.record, "lots", c.record.lots.indexOf(element));
                const doors = ops.filter((op) => op.id.endsWith("_door") || op.id === "minecraft:wooden_door");
                if (OPEN_AIR.has(kind)) return;
                assert.ok(doors.length >= 2, `${spec.name}: ${element.id} (${kind}) has no door (lower + upper)`);
            });
        }
    }
});

/* ------------------------------------------------------------------ lots */

test("lot placement rates: >= 90% on rough terrain and >= 98% on flat, and every drop is explained", () => {
    const report = [];
    for (const spec of CASES) {
        const c = buildCase(spec);
        const st = c.record.stats;
        const rate = st.lotsPlaced / st.lots;
        report.push(`${spec.name}: ${String(st.lotsPlaced)}/${String(st.lots)} placed (${(rate * 100).toFixed(1)}%), ${String(st.lotsRelocated)} moved, ${String(st.lotsRotated)} rotated`);
        assert.ok(rate >= (spec.relief >= 10 ? 0.9 : 0.98), `${spec.name}: only ${(rate * 100).toFixed(1)}% of the lots were placed`);
        const dropNotes = c.record.notes.filter((n) => String(n).includes("no buildable pad"));
        assert.equal(dropNotes.length, st.lots - st.lotsPlaced, `${spec.name}: dropped lots without a note`);
        assert.equal(st.buildings, st.lotsPlaced);
        for (const note of dropNotes) assert.match(note, /^lot d1-[a-z_]+-\d+ has no buildable pad: .+/);
    }
    console.log(report.join("\n"));
});

test("every placed building is supported by the pad, stays inside its district and keeps its distance", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        assert.deepEqual(D.siteContainmentProblems(c.plan, 1, c.record), [], `${spec.name}: containment`);
        // solid blocks of the final world: natural ground up to g, then every non-air op
        const solid = new Map();
        for (const { stage, element, ops } of streamsOf(c)) {
            for (const op of ops) {
                const k = `${String(op.x)},${String(op.y)},${String(op.z)}`;
                if (op.id === "minecraft:air") solid.delete(k);
                else solid.set(k, `${stage}/${element.id}`);
            }
        }
        const seen = new Set();
        const stack = [];
        for (const k of solid.keys()) {
            const [x, y, z] = k.split(",").map(Number);
            if (y - 1 <= c.field.at(x, z).g) {
                seen.add(k);
                stack.push([x, y, z]);
            }
        }
        while (stack.length > 0) {
            const [x, y, z] = stack.pop();
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const k = `${String(x + dx)},${String(y + dy)},${String(z + dz)}`;
                if (solid.has(k) && !seen.has(k)) {
                    seen.add(k);
                    stack.push([x + dx, y + dy, z + dz]);
                }
            }
        }
        const floating = [...solid.entries()].filter(([k]) => !seen.has(k)).map(([k, who]) => `${who}@${k}`);
        assert.deepEqual(floating.slice(0, 5), [], `${spec.name}: ${String(floating.length)} blocks float free of the ground`);

        // spacing: the proper required gap between building rects, and no building on the road network
        const buildings = c.record.lots.filter((e) => String(e.id).startsWith("building-"));
        for (let a = 0; a < buildings.length; a += 1) {
            for (let b = a + 1; b < buildings.length; b += 1) {
                const ra = buildings[a].bbox;
                const rb = buildings[b].bbox;
                const gap = Math.max(Math.max(rb.x0 - ra.x1 - 1, ra.x0 - rb.x1 - 1), Math.max(rb.z0 - ra.z1 - 1, ra.z0 - rb.z1 - 1));
                assert.ok(gap >= 4, `${spec.name}: ${buildings[a].id} and ${buildings[b].id} are only ${String(gap)} apart`);
            }
        }
        const net = walkNetwork(c);
        for (const b of buildings) {
            if (/hq_citadel/.test(b.id)) continue;
            for (let x = b.bbox.x0; x <= b.bbox.x1; x += 1) {
                for (let z = b.bbox.z0; z <= b.bbox.z1; z += 1) {
                    const owner = net.owner.get(key(x, z));
                    assert.ok(owner === undefined || owner.startsWith("exit-"), `${spec.name}: ${b.id} stands on ${String(owner)}`);
                }
            }
        }
    }
});

/* ------------------------------------------------------------------ wall access stairs */

test("wall stairs stand on the INTERIOR face, are not duplicated, and end flush with the walkway", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        const wallCells = new Set();
        const wallTop = new Map();
        for (const { stage, ops } of streamsOf(c)) {
            if (stage !== "walls") continue;
            for (const op of ops) {
                wallCells.add(key(op.x, op.z));
                wallTop.set(key(op.x, op.z), Math.max(wallTop.get(key(op.x, op.z)) ?? -999, op.y));
            }
        }
        const stairs = c.record.dressing.filter((e) => e.kind === "wall-stairs");
        const used = new Map();
        stairs.forEach((stair, index) => {
            const ops = D.siteOpsById(c.record, "dressing", stair.id).filter((op) => op.kind === "stair");
            assert.equal(ops.length, stair.rise, `${spec.name}: ${stair.id} stair blocks`);
            for (const op of ops) {
                const k = key(op.x, op.z);
                assert.ok(!wallCells.has(k), `${spec.name}: ${stair.id} sits inside the wall band`);
                assert.equal(used.get(k), undefined, `${spec.name}: ${stair.id} duplicates ${String(used.get(k))}`);
                used.set(k, stair.id);
            }
            // the top step touches the wall band and its level equals that column top
            const topOp = ops[ops.length - 1];
            const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => key(topOp.x + dx, topOp.z + dz)).filter((k) => wallCells.has(k));
            assert.ok(near.length > 0, `${spec.name}: ${stair.id} top step does not touch the wall`);
            assert.ok(near.some((k) => wallTop.get(k) === topOp.y), `${spec.name}: ${stair.id} top step y=${String(topOp.y)} is not flush with the walkway`);
            // interior: a few blocks further from the wall than the top step is still this district
            const wallSide = near[0].split(",").map(Number);
            const nx = topOp.x - wallSide[0];
            const nz = topOp.z - wallSide[1];
            for (const reach of [3, 4]) {
                assert.equal(GEOM.labelAt(c.plan, topOp.x + nx * reach, topOp.z + nz * reach), 1, `${spec.name}: ${stair.id} climbs from the OUTSIDE of the wall`);
            }
            // a ramp: one level per step
            for (let i = 1; i < ops.length; i += 1) assert.equal(ops[i].y - ops[i - 1].y, 1, `${spec.name}: ${stair.id} step ${String(i)} is not one level`);
            // supported below: solid fill or ground under every stair block
            for (const op of ops) {
                const g = c.field.at(op.x, op.z).g;
                if (op.y - 1 > g) {
                    const below = D.siteOpsById(c.record, "dressing", stair.id).some((o) => o.x === op.x && o.z === op.z && o.y === op.y - 1 && o.kind === "fill");
                    assert.ok(below, `${spec.name}: ${stair.id} stair at y=${String(op.y)} hangs over air`);
                }
            }
            assert.ok(index < 20);
        });
    }
});

/* ------------------------------------------------------------------ wall 7 and the ring */

test("shared walls without a ring pair stay sealed, towered and gateless; ring pairs carry a closable gate with road access", () => {
    const ring = (a, b) => [1, 4].includes(Math.abs(a - b));
    for (const spec of CASES) {
        const c = buildCase(spec);
        const net = walkNetwork(c);
        const gatesByWall = new Map();
        for (const gate of c.record.gates) gatesByWall.set(gate.wallId, (gatesByWall.get(gate.wallId) ?? 0) + 1);
        let sealed = 0;
        let ringWalls = 0;
        for (const wall of c.record.walls) {
            if (wall.kind !== "shared-wall") continue;
            const partner = wall.between.find((label) => label !== 1);
            if (ring(1, partner)) {
                ringWalls += 1;
                assert.ok((gatesByWall.get(wall.id) ?? 0) >= 1, `${spec.name}: ring wall ${wall.id} (1|${String(partner)}) has no gate`);
                for (const gate of c.record.gates.filter((g) => g.wallId === wall.id)) {
                    assert.ok(gate.total > 150, "a closable gate needs a gatehouse");
                    assert.ok(net.sills.get(gate.id).every((op) => net.comp.get(key(op.x, op.z)) === net.main), `${spec.name}: ${gate.id} has no road access`);
                }
            } else {
                sealed += 1;
                assert.equal(gatesByWall.get(wall.id) ?? 0, 0, `${spec.name}: ${wall.id} (1|${String(partner)}) must not carry a gate`);
                assert.ok(c.record.sealedWalls.includes(wall.id), `${spec.name}: ${wall.id} is not recorded as sealed`);
                assert.equal(wall.sealed, true);
                assert.ok(wall.towers >= 2, `${spec.name}: ${wall.id} has no towers`);
                // fully sealed: every centreline cell of the path carries wall blocks
                const planWallDef = c.plan.walls.find((w) => w.id === wall.id);
                const cells = new Set();
                for (const { stage, ops } of streamsOf(c)) if (stage === "walls") for (const op of ops) cells.add(key(op.x, op.z));
                const missing = GEOM.rasterizePath(planWallDef.path, planWallDef.closed).filter(([x, z]) => !cells.has(key(x, z)));
                assert.equal(missing.length, 0, `${spec.name}: ${wall.id} has ${String(missing.length)} gaps along its centreline`);
                assert.ok(c.record.notes.some((n) => String(n).includes(wall.id) && String(n).includes("NO gate by decision")), `${spec.name}: the plan does not say ${wall.id} is gateless by decision`);
            }
        }
        assert.ok(ringWalls >= 2, `${spec.name}: ring walls ${String(ringWalls)}`);
        if (spec.seed === 21) assert.ok(sealed >= 1, "seed 21 has the wall-7 situation (1|3)");
    }
});

test("both ring-pair gates (1-2 and 5-1) are closable: they have a gatehouse, a portcullis slot and an inside apron", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        const toward = (label) => c.record.gates.filter((g) => g.between.includes(label) && g.between.includes(1));
        for (const label of [2, 5]) {
            const gates = toward(label);
            assert.ok(gates.length >= 1, `${spec.name}: no gate toward ${String(label)}`);
            assert.ok(gates.some((g) => g.insideSide !== 0), `${spec.name}: no gate toward ${String(label)} knows its inside`);
        }
    }
});

/* ------------------------------------------------------------------ regeneration + sizes */

test("every element regenerates to exactly its stored total and hash, on every case", () => {
    for (const spec of CASES) {
        const c = buildCase(spec);
        for (const stage of D.SITE_STAGES) {
            c.record[stage].forEach((element, i) => {
                const ops = D.siteOpsFor(c.record, stage, i);
                assert.equal(ops.length, element.total, `${spec.name}: ${stage}/${element.id} total`);
                assert.deepEqual(D.siteOpsFor(c.record, stage, i), ops, `${spec.name}: ${stage}/${element.id} regenerated differently`);
                assert.ok(element.total > 0, `${spec.name}: empty element ${stage}/${element.id}`);
            });
        }
        assert.equal(D.siteOpCount(c.record), streamsOf(c).reduce((sum, s) => sum + s.ops.length, 0));
        assert.ok(c.record.recordBytes <= CIV_LIMITS.maxPlanBytes);
    }
});

test("op totals per stage on the reference terrain (documented before/after of the round-2 fixes)", () => {
    const st = RECORD.stats;
    console.log(`seed 21 ops by stage: ${JSON.stringify(st.byStage)} total ${String(st.totalOps)} (before: clear 43, walls 40877, gates 26966, roads 9412, lots 18613, dressing 122 = 96033)`);
    assert.ok(st.byStage.gates < 4 * 1200, "gatehouses are no longer 70-block towers");
    assert.ok(st.byStage.gates > 4 * 150);
    assert.ok(st.totalOps < 96033);
});
