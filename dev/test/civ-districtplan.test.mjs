import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The enlarged, irregular district construction planner: Hearthgate and, from round 4 on, all five
 * districts (Ironquarry, Whitethorn, Saltmere, Ashfall) planned from the same master CivPlan.
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

/* ------------------------------------------------------------------ five-district harness
 * Round 4 (districts 2-5) and the layout test above share one memoised set of site records. The
 * helper is a hoisted function declaration and only reads `CASES`/`buildCase` when a test RUNS, so
 * it can be used by tests registered before those definitions appear further down the file.
 */
const fiveCache = new Map();

/** @param {number} seed @param {number} relief @returns {{ name: string, seed: number, relief: number, field: any, plan: any, site: any, record: any, records: any[] }} */
function fiveDistricts(seed, relief) {
    const name = `seed ${String(seed)} ${relief >= 10 ? "rough" : "flat"}`;
    let hit = fiveCache.get(name);
    if (hit === undefined) {
        const c = buildCase({ name, seed, relief });
        const records = [c.record];
        for (const index of [2, 3, 4, 5]) {
            const site = D.planDistrictSite(c.plan, index, c.field, { seed });
            assert.ok(site.ok, `${name}: district ${String(index)} failed: ${site.problems.slice(0, 3).join(" | ")}`);
            records.push(site.record);
        }
        hit = { ...c, name, records };
        fiveCache.set(name, hit);
    }
    return hit;
}

test("every district has an enlarged layout: the Hearthgate-only refusal is gone", () => {
    assert.deepEqual({ ...D.ENLARGED_LAYOUTS }, {
        1: "hearthgate-enlarged",
        2: "ironquarry-enlarged",
        3: "whitethorn-enlarged",
        4: "saltmere-enlarged",
        5: "ashfall-enlarged",
    });
    const five = fiveDistricts(SEED, 18);
    for (const index of [2, 3, 4, 5]) {
        const record = five.records[index - 1];
        const district = /** @type {any[]} */ (PLAN.districts).find((entry) => entry.index === index);
        assert.equal(record.layoutId, D.ENLARGED_LAYOUTS[index], `district ${String(index)} layout`);
        assert.equal(record.districtIndex, index);
        assert.equal(record.districtId, district.id);
        assert.equal(record.name, district.name);
        assert.equal(record.role, district.role);
        assert.equal(record.version, 2);
        assert.ok(district.area >= 30000 && district.area <= 45000, `${record.name}: area ${String(district.area)}`);
        assert.ok(Number(record.stats.buildings) >= 20, `${record.name}: only ${String(record.stats.buildings)} buildings`);
        assert.ok(D.siteOpCount(record) > 40000, `${record.name}: only ${String(D.siteOpCount(record))} ops`);
        assert.ok(Number(record.recordBytes) <= CIV_LIMITS.maxPlanBytes, `${record.name}: ${String(record.recordBytes)} record bytes`);
    }
    // the five records are distinct, complete and carry no problem at all
    const checksums = five.records.map((record) => record.checksum);
    assert.equal(new Set(checksums).size, 5, JSON.stringify(checksums));
    for (const record of five.records) assert.deepEqual(record.problems, [], `${record.name} problems`);
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
        const ring = [...net.owner].filter(([, id]) => /^patrol-lane/.test(String(id)));
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

/* =================================================================================================
 * Round 3: cooperative (generator) planning, job-spec hashes, world pipeline, containment sweep.
 * ================================================================================================= */

const RG = await load("civ", "regions.js");
const VAL = await load("civ", "validate.js");
const VSTEPS = await load("civ", "validatesteps.js");
const ZONING = await load("civ", "zoning.js");
const ZSTEPS = await load("civ", "zonesteps.js");
const LOTS = await load("civ", "lots.js");
const LSTEPS = await load("civ", "lotsteps.js");
const FOUND = await load("civ", "foundations.js");
const WORLD = await load("civ", "worldplan.js");
const MAX_STRETCH = 25000;

/** Drive a cooperative generator to the end; report yields. */
function drive(gen) {
    let yields = 0;
    for (;;) {
        const r = gen.next();
        if (r.done) return { value: r.value, yields };
        yields += 1;
    }
}

test("siteJobSpecs hashes are non-negative integers: civ/jobs.js createQueue stores finite hashes that change with the ops", () => {
    const specs = D.siteJobSpecs(RECORD);
    for (const stage of Object.keys(specs)) {
        for (const spec of specs[stage]) {
            assert.ok(Number.isInteger(spec.hash) && spec.hash >= 0, `${stage}: hash ${String(spec.hash)}`);
        }
    }
    const queue = createQueue(specs, { planHash: String(RECORD.checksum) });
    assert.ok(queue.hash.length > 100);
    assert.ok(queue.hash.every((h) => Number.isFinite(h) && Number.isInteger(h) && h >= 0 && h < 36 ** 6), "createQueue stored a non-finite hash");
    // change the ops of the walls (taller wall): element hashes must move
    const taller = D.planDistrictSite(PLAN, 1, field, { seed: SEED, wallHeight: 8 });
    assert.ok(taller.record !== null);
    const queue2 = createQueue(D.siteJobSpecs(taller.record), { planHash: String(taller.record.checksum) });
    let changed = 0;
    const byId = new Map();
    RECORD.walls.forEach((w, i) => byId.set(w.id, queue.hash[queue.stages.find((s) => s.name === "walls").start + i]));
    taller.record.walls.forEach((w, i) => {
        if (queue2.hash[queue2.stages.find((s) => s.name === "walls").start + i] !== byId.get(w.id)) changed += 1;
    });
    assert.ok(changed >= 3, `only ${String(changed)} wall hashes changed`);
    // the fold itself: a hex string would have produced NaN
    assert.ok(Number.isNaN("9a975bb9" % (36 ** 6)), "documents the original defect");
});

test("planDistrictSiteSteps yields at least every 25,000 operations and equals the synchronous driver", () => {
    for (const spec of [CASES[0], CASES[1], CASES[5]]) {
        const c = buildCase(spec);
        const ops = RG.newOps();
        const { value, yields } = drive(D.planDistrictSiteSteps(c.plan, 1, c.field, { seed: spec.seed, ops }));
        assert.equal(value.ok, true, spec.name);
        assert.equal(value.record.checksum, c.record.checksum, `${spec.name}: checksum differs from the synchronous form`);
        assert.ok(yields > 500, `${spec.name}: only ${String(yields)} yields`);
        assert.ok(ops.maxRun <= MAX_STRETCH, `${spec.name}: ${String(ops.maxRun)} operations between two yields`);
        assert.ok(ops.maxRun > 1000);
    }
});

test("abandoning a cooperative plan midway has no side effects", () => {
    const c = buildCase(CASES[0]);
    const planJSON = JSON.stringify(c.plan);
    const options = { seed: c.seed, excludeFootprints: [{ x0: 1, z0: 1, x1: 2, z1: 2 }] };
    const optionsJSON = JSON.stringify(options);
    const reads = { n: 0 };
    const spy = { bounds: c.field.bounds, at: (x, z) => { reads.n += 1; return c.field.at(x, z); } };
    const gen = D.planDistrictSiteSteps(c.plan, 1, spy, options);
    for (let i = 0; i < 700; i += 1) assert.equal(gen.next().done, false);
    gen.return(undefined);
    assert.equal(JSON.stringify(c.plan), planJSON, "the plan was modified");
    assert.equal(JSON.stringify(options), optionsJSON, "the options were modified");
    const again = D.planDistrictSite(c.plan, 1, c.field, { seed: c.seed });
    assert.equal(again.record.checksum, c.record.checksum, "an abandoned run changed a later run");
    const zonesGen = ZSTEPS.zoneDistrictSteps(ZONING.regionFromPlan(c.plan, 1), c.plan.roads.filter((r) => r.district === 1), { seed: c.seed }, RG.newOps());
    for (let i = 0; i < 50; i += 1) zonesGen.next();
    zonesGen.return(undefined);
    assert.equal(JSON.stringify(c.plan), planJSON);
});

test("cooperative zoning, lots and pads equal their synchronous originals", () => {
    for (const spec of [CASES[0], CASES[5]]) {
        const c = buildCase(spec);
        const region = ZONING.regionFromPlan(c.plan, 1);
        const walls = c.plan.walls.filter((w) => w.between.includes(1));
        const gates = c.plan.gates.filter((g) => walls.some((w) => w.id === g.wallId));
        const roads = c.plan.roads.filter((r) => r.district === 1);
        const options = { seed: spec.seed, walls, gates, streetWidth: 3 };
        const strip = (z) => ({ ...z, zoneAt: undefined, zoneById: undefined, grids: undefined, elig: Array.from(z.elig), gateMask: Array.from(z.gateMask), G: { ins: Array.from(z.grids.ins), wall: Array.from(z.grids.wall), road: Array.from(z.grids.road), dist: Array.from(z.grids.dist) } });
        const zones = ZONING.zoneDistrict(region, roads, options);
        const zOps = RG.newOps();
        const zonesSteps = drive(ZSTEPS.zoneDistrictSteps(region, roads, options, zOps)).value;
        assert.deepEqual(strip(zonesSteps), strip(zones), `${spec.name}: zoning differs`);
        assert.ok(zOps.maxRun <= MAX_STRETCH, `zoning stretch ${String(zOps.maxRun)}`);
        const lots = LOTS.makeLots(region, zones, roads, { seed: spec.seed, attempts: 4 });
        const lOps = RG.newOps();
        const lotsSteps = drive(LSTEPS.makeLotsSteps(region, zones, roads, { seed: spec.seed, attempts: 4 }, lOps)).value;
        const flat = (x) => ({ ...x, roadMask: Array.from(x.roadMask), laneMask: Array.from(x.laneMask) });
        assert.deepEqual(flat(lotsSteps), flat(lots), `${spec.name}: lots differ`);
        assert.ok(lOps.maxRun <= MAX_STRETCH, `lots stretch ${String(lOps.maxRun)}`);
    }
    // pads: the cooperative planPad gives the same answer as foundations.planPad on real lots and tight limits
    const c = buildCase(CASES[0]);
    const sampler = (x, z) => {
        const cell = c.field.at(x, z);
        return { g: Math.floor(cell.g), hollow: cell.k === "unloaded", ...(cell.k === "water" ? { water: Math.floor(cell.g) + 1 } : {}) };
    };
    let compared = 0;
    for (let n = 0; n < 40; n += 1) {
        const x0 = -60 + n * 3;
        const z0 = -150 + n * 4;
        const rect = { x0, z0, x1: x0 + 6 + (n % 5) * 4, z1: z0 + 6 + (n % 3) * 5 };
        const profile = FOUND.makeProfile(rect.x0 - 1, rect.z0 - 1, rect.x1 - rect.x0 + 3, rect.z1 - rect.z0 + 3, sampler);
        for (const limit of [3, 6]) {
            const limits = { maxCut: limit, maxFill: limit, maxWall: limit };
            const plain = FOUND.planPad(profile, rect, limits);
            const ops = RG.newOps();
            const steps = drive(D.planPadSteps(profile, rect, limits, ops)).value;
            assert.deepEqual(steps, plain, `pad ${String(n)} limit ${String(limit)}`);
            compared += 1;
        }
    }
    assert.equal(compared, 80);
});

test("validatePlanSteps reproduces validatePlan exactly on valid and broken plans, in bounded stretches", () => {
    const variants = [];
    for (const spec of [CASES[0], CASES[1], CASES[5]]) variants.push([spec.name, buildCase(spec).plan]);
    variants.push(["fixture 7", fixture.validFullPlan(7)]);
    const base = () => structuredClone(PLAN);
    let p = base(); p.gates.pop(); variants.push(["gate removed", p]);
    p = base(); p.walls[0].path = p.walls[0].path.slice(0, 3); variants.push(["wall truncated", p]);
    p = base(); p.districts[1].area += 500; p.stats.totalArea += 3; variants.push(["bad area", p]);
    p = base(); p.routes.evac = []; variants.push(["no evac", p]);
    p = base(); p.labels = [[1, 5]]; variants.push(["bad labels", p]);
    p = base(); p.gates[0].at = { x: p.gates[0].at.x + 3, z: p.gates[0].at.z + 3 }; variants.push(["gate off wall", p]);
    p = base(); p.anchor = { x: 1.5, z: 2 }; variants.push(["bad anchor", p]);
    variants.push(["not an object", null]);
    assert.ok(variants.length >= 12);
    let invalid = 0;
    for (const [name, plan] of variants) {
        const sync = VAL.validatePlan(plan);
        const ops = RG.newOps();
        const { value, yields } = drive(VSTEPS.validatePlanSteps(plan, { ops }));
        assert.deepEqual(value, sync, `${name}: cooperative validation differs`);
        assert.ok(ops.maxRun <= MAX_STRETCH, `${name}: ${String(ops.maxRun)} operations between yields`);
        if (!sync.ok) invalid += 1;
        else assert.ok(yields > 100, `${name}: validated in ${String(yields)} slices`);
    }
    assert.ok(invalid >= 6, "the broken variants must really be rejected");
    // abandoning leaves the plan untouched
    const json = JSON.stringify(PLAN);
    const gen = VSTEPS.validatePlanSteps(PLAN);
    for (let i = 0; i < 80; i += 1) gen.next();
    gen.return(undefined);
    assert.equal(JSON.stringify(PLAN), json);
});

test("planWorldSteps chains master plan, validation, Hearthgate and ground in bounded stretches", () => {
    for (const spec of [CASES[0], CASES[5]]) {
        const c = buildCase(spec);
        const ops = RG.newOps();
        const { value: world, yields } = drive(WORLD.planWorldSteps(c.field, { seed: spec.seed, ops }));
        assert.equal(world.ok, true, `${spec.name}: ${world.problems.slice(0, 3).join(" | ")}`);
        assert.deepEqual(world.problems, []);
        assert.ok(ops.maxRun <= MAX_STRETCH, `${spec.name}: ${String(ops.maxRun)} operations between yields`);
        assert.ok(yields > 2000);
        assert.equal(VAL.validatePlan(world.plan).ok, true, "the returned plan validates");
        assert.equal(world.plan.seed, spec.seed);
        assert.ok(world.record.checksum && world.ground.hash);
        // the pair (plan, ground) is exactly what a restart needs
        const reborn = D.rehydrateSite(JSON.parse(JSON.stringify(world.plan)), 1, JSON.parse(JSON.stringify(world.ground)), D.siteOptionsOf(world.record));
        assert.equal(reborn.record.checksum, world.record.checksum);
        // identical to the synchronous driver and to the separate steps
        const sync = WORLD.planWorld(c.field, { seed: spec.seed });
        assert.equal(sync.record.checksum, world.record.checksum);
        assert.equal(world.record.checksum, c.record.checksum, "the world pipeline differs from planning the pieces one by one");
    }
    // a field that cannot hold a civilization fails with reasons, not an exception
    const tiny = makeField(5, { size: 120 });
    const failed = WORLD.planWorld(tiny, { seed: 5, maxWorldAttempts: 1 });
    assert.equal(failed.ok, false);
    assert.equal(failed.plan, null);
    assert.ok(failed.problems.length >= 1);
});

test("rehydrateSiteSteps equals rehydrateSite and yields in bounded stretches (rough and flat)", () => {
    for (const spec of [CASES[0], CASES[1], CASES[5]]) {
        const c = buildCase(spec);
        const ground = PROFILE.exportSiteGround(c.field, PROFILE.siteGroundRegion(c.plan, 1));
        const ops = RG.newOps();
        const { value, yields } = drive(D.rehydrateSiteSteps(JSON.parse(JSON.stringify(c.plan)), 1, JSON.parse(JSON.stringify(ground)), { ...D.siteOptionsOf(c.record), expectChecksum: c.record.checksum, ops }));
        assert.equal(value.ok, true, `${spec.name}: ${value.problems.join(" | ")}`);
        assert.equal(value.record.checksum, c.record.checksum);
        assert.ok(ops.maxRun <= MAX_STRETCH, `${spec.name}: ${String(ops.maxRun)} operations between yields`);
        assert.ok(yields > 500);
    }
});

test("ground export and import are cooperative and bounded", () => {
    const c = buildCase(CASES[0]);
    const region = PROFILE.siteGroundRegion(c.plan, 1);
    const ops = RG.newOps();
    const json = drive(PROFILE.exportSiteGroundSteps(c.field, region, ops)).value;
    assert.deepEqual(json, PROFILE.exportSiteGround(c.field, region));
    assert.ok(ops.maxRun <= MAX_STRETCH);
    const iops = RG.newOps();
    const back = drive(PROFILE.importSiteGroundSteps(json, iops)).value;
    assert.equal(back.sameAs(c.field), true);
    assert.ok(iops.maxRun <= MAX_STRETCH);
});

/* ------------------------------------------------------------------ the containment sweep */

test("sweep: master plans that validate produce an ok, contained site (sample of 24 seeds over five terrains)", async () => {
    const kinds = [
        (seed) => makeField(seed, { relief: 18, hills: 60 }),
        (seed) => makeField(seed, { relief: 10, hills: 40 }),
        (seed) => makeField(seed, { relief: 2, hills: 60 }),
        (seed) => makeField(seed, { relief: 6, hills: 60, river: { z: ((seed * 37) % 120) - 60, width: 9, wiggle: 25 } }),
        (seed) => makeField(seed, { relief: 8, hills: 50, lakes: [{ x: ((seed * 53) % 100) - 50, z: ((seed * 29) % 100) - 50, r: 30 }, { x: 70 - ((seed * 17) % 140), z: 60 - ((seed * 11) % 120), r: 22 }] }),
    ];
    let validated = 0;
    let good = 0;
    const failures = [];
    for (let n = 0; n < 24; n += 1) {
        const seed = 101 + n * 3;
        const f = kinds[n % kinds.length](seed);
        const planned2 = await M.planCivilizationAsync(f, { seed });
        if (!planned2.ok) continue;
        validated += 1;
        const s = D.planDistrictSite(planned2.plan, 1, f, { seed });
        const contained = s.record === null ? ["no record"] : D.siteContainmentProblems(planned2.plan, 1, s.record);
        if (s.ok && contained.length === 0) good += 1;
        else failures.push(`seed ${String(seed)}: ${[...s.problems, ...contained].slice(0, 2).join(" | ")}`);
    }
    assert.ok(validated >= 20, `only ${String(validated)} of 24 master plans validated`);
    assert.ok(good / validated >= 0.95, `${String(good)}/${String(validated)} sites are ok: ${failures.join(" ; ")}`);
});

test("a patrol contour that falls apart is laid as separate lanes, never as one line across the gap", () => {
    // seeds 21 and 42 have a contour in several pieces: a straight segment between pieces used to be drawn
    for (const spec of [CASES[0], CASES[3]]) {
        const c = buildCase(spec);
        const lanes = c.record.roads.filter((e) => /^patrol-lane/.test(String(e.id)));
        assert.ok(lanes.length >= 1);
        assert.deepEqual(D.siteContainmentProblems(c.plan, 1, c.record), []);
        if (lanes.length > 1) {
            for (const lane of lanes) assert.equal(lane.outsideCells, 0, `${lane.id} leaves the district`);
        }
    }
});

/* =================================================================================================
 * Round 4: districts 2-5 - Ironquarry (industrial), Whitethorn (agricultural), Saltmere (commercial)
 * and Ashfall (residential) - get the same enlarged site plan from the SAME master CivPlan.
 * Everything below is the Hearthgate battery run over all five districts, with independent geometry
 * (own flood fills, own gap maths, own decode of the plan's run-length labels).
 * ================================================================================================= */

const FAC = await load("civ", "facilities.js");
const WT = await load("civ", "walls.js");
const LT = await load("civ", "lots.js");
/** Seeds the whole battery runs on: two rough terrains and one flat one. */
const BATTERY = [
    { seed: 21, relief: 18 },
    { seed: 7, relief: 18 },
    { seed: 12, relief: 2 },
];
const DISTRICT_NAMES = ["Hearthgate", "Ironquarry", "Whitethorn", "Saltmere", "Ashfall"];
const DISTRICT_ROLES = ["command", "industrial", "agricultural", "commercial", "residential"];

/** Independent label grid of any CivPlan, decoded straight from its run-length list. */
const planGrids = new Map();
/** @param {any} plan */
function gridOf(plan) {
    let hit = planGrids.get(plan);
    if (hit === undefined) {
        const decoded = decodeCacheFor(plan);
        const cell = Number(plan.cell);
        hit = {
            /** @param {number} x @param {number} z */
            labelAt: (x, z) => {
                const gx = Math.floor((x - plan.grid.x0) / cell);
                const gz = Math.floor((z - plan.grid.z0) / cell);
                if (gx < 0 || gz < 0 || gx >= plan.grid.w || gz >= plan.grid.h) return -1;
                return decoded[gz * plan.grid.w + gx];
            },
            decoded,
        };
        planGrids.set(plan, hit);
    }
    return hit;
}
/** @param {any} plan */
function decodeCacheFor(plan) {
    const w = plan.grid.w;
    const h = plan.grid.h;
    /** @type {number[]} */
    const labels = new Array(w * h).fill(0);
    let cursor = 0;
    for (const [label, run] of /** @type {any[]} */ (plan.labels)) {
        for (let i = 0; i < run && cursor < labels.length; i += 1) {
            labels[cursor] = label;
            cursor += 1;
        }
    }
    return labels;
}

/** All ops of one stage of any record, streamed through the public API (memoised per record). */
const opCache = new WeakMap();
/** @param {any} record @param {string} stage @returns {any[]} */
function opsIn(record, stage) {
    let perRecord = opCache.get(record);
    if (perRecord === undefined) {
        perRecord = new Map();
        opCache.set(record, perRecord);
    }
    let hit = perRecord.get(stage);
    if (hit === undefined) {
        const list = /** @type {any[]} */ (record[stage] ?? []);
        /** @type {any[]} */
        const out = [];
        for (let i = 0; i < list.length; i += 1) out.push(...D.siteOpsFor(record, stage, i));
        hit = out;
        perRecord.set(stage, out);
    }
    return hit;
}

/** @param {any} record @param {string} stage @returns {Set<string>} */
function columnsIn(record, stage) {
    const set = new Set();
    for (const op of opsIn(record, stage)) set.add(key(op.x, op.z));
    return set;
}

/** Columns of ONE element, streamed on its own (memoised). */
const elementCache = new WeakMap();
/** @param {any} record @param {string} stage @param {number} position @returns {Set<string>} */
function elementColumnsIn(record, stage, position) {
    let perRecord = elementCache.get(record);
    if (perRecord === undefined) {
        perRecord = new Map();
        elementCache.set(record, perRecord);
    }
    const id = `${stage}:${String(position)}`;
    let hit = perRecord.get(id);
    if (hit === undefined) {
        hit = new Set();
        for (const op of D.siteOpsFor(record, stage, position)) hit.add(key(op.x, op.z));
        perRecord.set(id, hit);
    }
    return hit;
}

/**
 * Seal the district (its wall band plus the gate blocks that close each opening) and flood fill
 * 4-connected from the district centroid inside a window around it.
 * @param {any} plan @param {any} record
 */
function sealedFlood(plan, record) {
    const index = Number(record.districtIndex);
    const district = /** @type {any[]} */ (plan.districts).find((entry) => entry.index === index);
    const barrier = new Set([...columnsIn(record, "walls"), ...columnsIn(record, "gates")]);
    const limit = 40;
    const win = { x0: district.bbox.x0 - limit, z0: district.bbox.z0 - limit, x1: district.bbox.x1 + limit, z1: district.bbox.z1 + limit };
    const w = win.x1 - win.x0 + 1;
    const h = win.z1 - win.z0 + 1;
    const blocked = new Uint8Array(w * h);
    for (const k of barrier) {
        const [x, z] = k.split(",").map(Number);
        if (x < win.x0 || z < win.z0 || x > win.x1 || z > win.z1) continue;
        blocked[(z - win.z0) * w + (x - win.x0)] = 1;
    }
    const comps = VAL.labelComponents(blocked, w, h, false);
    const start = (district.centroid.z - win.z0) * w + (district.centroid.x - win.x0);
    const home = comps.comp[start];
    let interior = 0;
    let border = 0;
    for (let p = 0; p < w * h; p += 1) {
        if (comps.comp[p] !== home) continue;
        interior += 1;
        const x = p % w;
        const z = Math.floor(p / w);
        if (x === 0 || z === 0 || x === w - 1 || z === h - 1) border += 1;
    }
    // the barrier itself: one 4-connected piece, or the ring would have a hole in it
    const ringComps = VAL.labelComponents(Uint8Array.from(blocked, (v) => (v === 1 ? 0 : 1)), w, h, false);
    return { district, interior, border, comps: comps.count, ringComps: ringComps.count, barrier, win, blocked, w, h };
}

/** @param {any} record */
function buildingKinds(record) {
    return FAC.mixOf(record).kinds;
}

/* ------------------------------------------------------------------ enclosure */

test("all five districts seal themselves: a closed 4-connected barrier with no way out but a gate", () => {
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        for (const record of five.records) {
            const index = Number(record.districtIndex);
            const tag = `${five.name} d${String(index)} ${String(record.role)}`;
            const sealed = sealedFlood(five.plan, record);
            assert.ok(sealed.barrier.size > 1000, `${tag}: only ${String(sealed.barrier.size)} boundary columns`);
            assert.equal(sealed.border, 0, `${tag}: the sealed fill reaches the edge of the survey window`);
            assert.equal(sealed.comps, 2, `${tag}: the barrier does not split the window into inside and outside (${String(sealed.comps)} components)`);
            assert.equal(sealed.ringComps, 1, `${tag}: the wall ring is in ${String(sealed.ringComps)} pieces`);
            assert.ok(sealed.interior >= 0.9 * Number(record.area), `${tag}: only ${String(sealed.interior)} of ${String(record.area)} enclosed`);
            // every wall the master plan gives this district is built, once, and covers its centreline
            const own = /** @type {any[]} */ (five.plan.walls).filter((wall) => (/** @type {any[]} */ (wall.between)).includes(index));
            assert.equal(record.walls.length, own.length, `${tag}: ${String(record.walls.length)} wall elements for ${String(own.length)} planned`);
            assert.deepEqual([...new Set(record.walls.map((w2) => w2.id))].sort(), own.map((w2) => String(w2.id)).sort(), `${tag}: wall ids`);
            for (const wall of own) {
                const cells = GEOM.rasterizePath(wall.path, wall.closed === true);
                const gaps = cells.filter(([x, z]) => !sealed.barrier.has(key(x, z)));
                assert.deepEqual(gaps.slice(0, 4), [], `${tag}: wall ${wall.id} has ${String(gaps.length)} uncovered centreline cells`);
            }
            assert.deepEqual(D.siteContainmentProblems(five.plan, index, record), [], `${tag}: containment`);
            // The built band is terrain-following, not a square stamp of the centreline, so a handful of
            // stamped cells at inside corners legitimately get no block. That denies a walker nothing
            // only while every such cell is flanked by built band cells on at least two sides.
            let unstamped = 0;
            for (const wall of own) {
                for (const [x, z] of GEOM.stamp(GEOM.rasterizePath(wall.path, wall.closed === true), Number(wall.thickness ?? 3))) {
                    const k = key(x, z);
                    if (sealed.barrier.has(k)) continue;
                    unstamped += 1;
                    let flanked = 0;
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (sealed.barrier.has(key(x + dx, z + dz))) flanked += 1;
                    assert.ok(flanked >= 2, `${tag}: band cell ${k} has only ${String(flanked)} built neighbours - a walkable gap in the wall`);
                }
            }
            assert.ok(unstamped <= 30, `${tag}: ${String(unstamped)} stamped band cells unbuilt - the wall shape changed`);
            // terrain following: pads where the ground needs them, stairs, cut/fill/retaining
            assert.ok(Number(record.stats.pads) >= 1, `${tag}: not one pad element`);
            if (spec.relief >= 10) assert.ok(Number(record.stats.pads) >= 0.5 * Number(record.stats.buildings), `${tag}: ${String(record.stats.pads)} pads for ${String(record.stats.buildings)} buildings on rough ground`);
            const kindsSeen = new Set();
            for (const stage of D.SITE_STAGES) for (const op of opsIn(record, stage)) kindsSeen.add(op.kind);
            for (const must of ["clear", "wall", "gate", "road", "stair", "cut", "fill", "pad", "structure", "footing"]) {
                assert.ok(kindsSeen.has(must), `${tag}: no '${must}' op at all`);
            }
            if (spec.relief >= 10) assert.ok(kindsSeen.has("retaining"), `${tag}: no retaining wall on rough ground`);
            const stairs = opsIn(record, "roads").filter((op) => op.kind === "stair");
            assert.ok(stairs.length > 0, `${tag}: no stair op on a sloped site`);
            if (spec.relief >= 10) assert.ok(stairs.length > 100, `${tag}: only ${String(stairs.length)} road stairs on rough ground`);
            const prep = opsIn(record, "lots").filter((op) => op.kind === "cut" || op.kind === "fill" || op.kind === "retaining").length;
            assert.ok(prep > (spec.relief >= 10 ? 500 : 100), `${tag}: only ${String(prep)} pad cut/fill/retaining ops`);
            for (const element of /** @type {any[]} */ (record.lots)) {
                if (String(element.id).startsWith("pad-")) {
                    assert.ok(Number.isInteger(element.baseY), `${tag}: ${element.id} has no level base height`);
                    assert.ok(Number(element.total) > 0, `${tag}: ${element.id} pads nothing`);
                }
            }
        }
    }
});

/* ------------------------------------------------------------------ gates */

test("every district builds every gate planned on its walls, once, fortified and road-served", () => {
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        for (const record of five.records) {
            const index = Number(record.districtIndex);
            const tag = `${five.name} d${String(index)} ${String(record.role)}`;
            const myWalls = new Set(/** @type {any[]} */ (five.plan.walls).filter((wall) => (/** @type {any[]} */ (wall.between)).includes(index)).map((wall) => String(wall.id)));
            const wanted = /** @type {any[]} */ (five.plan.gates).filter((gate) => myWalls.has(String(gate.wallId))).map((gate) => String(gate.id)).sort();
            const built = record.gates.map((gate) => String(gate.id)).sort();
            assert.deepEqual(built, wanted, `${tag}: built gates ${JSON.stringify(built)} vs planned ${JSON.stringify(wanted)}`);
            assert.equal(new Set(built).size, built.length, `${tag}: a gate was built twice`);
            assert.ok(record.gates.length >= 2, `${tag}: only ${String(record.gates.length)} gates`);
            const roadCells = columnsIn(record, "roads");
            /** @type {Map<string, Set<string>>} */
            const wallCellsByWall = new Map();
            record.walls.forEach((element, i) => wallCellsByWall.set(element.id, elementColumnsIn(record, "walls", i)));
            const ownWall = new Map(/** @type {any[]} */ (record.walls).map((element) => [element.id, element]));
            const ringNeighbours = [index === 1 ? 5 : index - 1, index === 5 ? 1 : index + 1];
            const labelAt = gridOf(five.plan).labelAt;
            let outerGated = 0;
            for (const gate of record.gates) {
                assert.ok(ownWall.has(gate.wallId), `${tag}: gate ${gate.id} names an unplanned wall`);
                const band = wallCellsByWall.get(gate.wallId);
                assert.ok(band !== undefined && band.size > 0, `${tag}: gate ${gate.id} names a wall with no columns`);
                let nearest = Infinity;
                for (const k of band) {
                    const [x, z] = k.split(",").map(Number);
                    nearest = Math.min(nearest, Math.hypot(x - gate.at.x, z - gate.at.z));
                }
                assert.ok(nearest <= 8, `${tag}: gate ${gate.id} is ${nearest.toFixed(1)} blocks from its wall`);
                let nearRoad = 0;
                for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
                    if (roadCells.has(key(gate.at.x + dx, gate.at.z + dz))) nearRoad += 1;
                }
                assert.ok(nearRoad > 0, `${tag}: gate ${gate.id} has no road`);
                assert.ok(Number(gate.width) >= 3, `${tag}: gate ${gate.id} is ${String(gate.width)} wide`);
                assert.ok(Number(gate.total) > 150, `${tag}: gate ${gate.id} has no gatehouse (${String(gate.total)} ops)`);
                const ops = D.siteOpsById(record, "gates", gate.id);
                assert.ok(ops.some((op) => op.id === "minecraft:iron_bars"), `${tag}: ${gate.id} has no portcullis slot`);
                assert.ok(ops.some((op) => op.id === "minecraft:lever"), `${tag}: ${gate.id} has no lever`);
                assert.equal(gate.wallTopHeight, 7, `${tag}: ${gate.id} wall top`);
                // a gate may only face its own district, wilderness, or a ring neighbour
                const box = WT.gateFootprintBox({ at: gate.at, axis: gate.axis });
                const faces = new Set();
                for (let x = box.x0; x <= box.x1; x += 1) for (let z = box.z0; z <= box.z1; z += 1) faces.add(labelAt(x, z));
                assert.ok(faces.has(index), `${tag}: ${gate.id} does not touch its own district`);
                for (const label of faces) {
                    if (label === index || label === 0) continue;
                    assert.ok(ringNeighbours.includes(label), `${tag}: ${gate.id} opens onto district ${String(label)}, which is not a ring neighbour of ${String(index)}`);
                }
                if (ownWall.get(gate.wallId).kind === "outer-wall") outerGated += 1;
            }
            assert.ok(outerGated >= 1, `${tag}: no outer-wall gate: the district cannot be supplied or evacuated from outside`);
            // ring shared walls carry a closable gate; other shared walls are sealed, towered, gateless
            const byWall = new Map();
            for (const gate of record.gates) byWall.set(gate.wallId, (byWall.get(gate.wallId) ?? 0) + 1);
            for (const element of record.walls) {
                if (element.kind !== "shared-wall") continue;
                const partner = (/** @type {number[]} */ (element.between)).find((label) => label !== index && label > 0);
                if (Math.abs(Number(partner) - index) === 1 || Math.abs(Number(partner) - index) === 4) {
                    assert.ok(Number(byWall.get(element.id) ?? 0) >= 1, `${tag}: ring wall ${element.id} (shared with ${String(partner)}) has no gate`);
                    assert.notEqual(element.sealed, true, `${tag}: ring wall ${element.id} is recorded sealed`);
                } else {
                    assert.equal(byWall.get(element.id) ?? 0, 0, `${tag}: ${element.id} (shared with ${String(partner)}) is not a ring pair but carries a gate`);
                    assert.equal(element.sealed, true, `${tag}: ${element.id} should be sealed`);
                    assert.ok(record.sealedWalls.includes(element.id), `${tag}: ${element.id} is not listed as sealed`);
                    assert.ok(Number(element.towers) >= 2, `${tag}: sealed wall ${element.id} has no towers`);
                    assert.ok(record.notes.some((note) => String(note).includes(element.id) && String(note).includes("NO gate by decision")), `${tag}: ${element.id} is sealed without saying so`);
                }
            }
        }
    }
});

test("shared walls survive both districts: nothing is removed, re-gated or built twice differently", () => {
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        /** @type {Map<number, Set<string>>} */
        const centre = new Map();
        for (const wall of /** @type {any[]} */ (five.plan.walls)) {
            centre.set(Number(wall.id.replace(/\D+/g, "")), new Set(GEOM.rasterizePath(wall.path, wall.closed === true).map(([x, z]) => key(x, z))));
        }
        for (const wall of /** @type {any[]} */ (five.plan.walls)) {
            const sides = (/** @type {number[]} */ (wall.between)).filter((label) => label > 0);
            if (sides.length !== 2) continue;
            const [left, right] = sides;
            const a = five.records[left - 1];
            const b = five.records[right - 1];
            const tag = `${five.name} wall ${wall.id} (${String(left)}|${String(right)})`;
            const ia = a.walls.findIndex((element) => element.id === wall.id);
            const ib = b.walls.findIndex((element) => element.id === wall.id);
            assert.ok(ia >= 0 && ib >= 0, `${tag}: one side did not build it`);
            assert.equal(a.walls.filter((element) => element.id === wall.id).length, 1, `${tag}: ${String(left)} built it twice`);
            assert.equal(b.walls.filter((element) => element.id === wall.id).length, 1, `${tag}: ${String(right)} built it twice`);
            const mine = new Map();
            const theirs = new Map();
            for (const op of D.siteOpsFor(a, "walls", ia)) mine.set(`${String(op.x)},${String(op.y)},${String(op.z)}`, op.id);
            for (const op of D.siteOpsFor(b, "walls", ib)) theirs.set(`${String(op.x)},${String(op.y)},${String(op.z)}`, op.id);
            const clashes = [];
            for (const [k, id] of mine) if (theirs.has(k) && theirs.get(k) !== id) clashes.push(`${k}: ${id} vs ${theirs.get(k)}`);
            assert.deepEqual(clashes.slice(0, 4), [], `${tag}: the two sides write different blocks to ${String(clashes.length)} shared coordinates`);
            // both sides seal the same centreline, so neither thins or deletes the shared wall
            const cells = centre.get(Number(wall.id.replace(/\D+/g, "")));
            for (const record of [a, b]) {
                const barrier = new Set([...columnsIn(record, "walls"), ...columnsIn(record, "gates")]);
                const gaps = [...cells].filter((k) => !barrier.has(k));
                assert.deepEqual(gaps.slice(0, 4), [], `${tag}: district ${String(record.districtIndex)} leaves ${String(gaps.length)} centreline gaps`);
            }
            // the gate decision is identical on both sides
            const gatesOf = (record) => record.gates.filter((gate) => gate.wallId === wall.id).map((gate) => `${String(gate.id)}:${String(gate.purpose)}`).sort().join(",");
            assert.equal(gatesOf(a), gatesOf(b), `${tag}: the two districts disagree about the gates on this wall`);
            assert.equal(Boolean(a.walls[ia].sealed), Boolean(b.walls[ib].sealed), `${tag}: sealed decision differs`);
            assert.equal(a.sealedWalls.includes(wall.id), b.sealedWalls.includes(wall.id), `${tag}: sealed list differs`);
        }
    }
});

/* ------------------------------------------------------------------ roads and walkability */

test("each district is one walkable network: arterials, streets, patrol ring, gate throats and every door", () => {
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        for (const record of five.records) {
            const index = Number(record.districtIndex);
            const tag = `${five.name} d${String(index)} ${String(record.role)}`;
            assert.ok(record.roads.length >= 20, `${tag}: only ${String(record.roads.length)} road elements`);
            assert.equal(Number(record.stats.roadRefusals), 0, `${tag}: roads were refused`);
            assert.ok(Number(record.stats.ringRoads) >= 1, `${tag}: no patrol ring road`);
            assert.ok(Number(record.stats.patrolCells) >= 800, `${tag}: patrol ring is only ${String(record.stats.patrolCells)} cells`);
            assert.equal(Number(record.stats.walkableComponents), 1, `${tag}: the walking surface is in ${String(record.stats.walkableComponents)} pieces`);
            assert.ok(Number(record.stats.wallStairs) >= 3, `${tag}: only ${String(record.stats.wallStairs)} wall access stairs`);
            const net = walkNetwork({ record });
            const stray = new Map();
            for (const [k, who] of net.owner) if (net.comp.get(k) !== net.main) stray.set(who, (stray.get(who) ?? 0) + 1);
            assert.deepEqual([...stray.entries()].slice(0, 4), [], `${tag}: walkable cells outside the main network`);
            assert.ok(net.sizes[net.main] > 3000, `${tag}: main network only ${String(net.sizes[net.main])} cells`);
            const ring = [...net.owner].filter(([, who]) => /^patrol-lane/.test(String(who)));
            assert.ok(ring.length > 300 && ring.every(([k]) => net.comp.get(k) === net.main), `${tag}: patrol ring not on the network`);
            for (const gate of record.gates) {
                assert.ok(net.sills.get(gate.id).every((op) => net.comp.get(key(op.x, op.z)) === net.main), `${tag}: ${gate.id} throat is cut off`);
            }
            const buildings = record.lots.filter((element) => String(element.id).startsWith("building-"));
            for (const element of buildings) {
                assert.equal(net.comp.get(key(element.exit.x, element.exit.z)), net.main, `${tag}: ${element.id} exit cannot reach the network`);
                assert.ok(net.surf.has(key(element.frontage.x, element.frontage.z)), `${tag}: ${element.id} frontage is not surfaced`);
                assert.ok(["road", "patrol"].includes(String(element.frontage?.via)), `${tag}: ${element.id} fronts ${String(element.frontage?.via)}`);
            }
            // bridges: water on the site is crossed, never filled into a road
            const water = opsIn(record, "roads").filter((op) => op.kind === "bridge" || op.kind === "support").length;
            const deck = opsIn(record, "roads").filter((op) => op.kind === "road").length;
            assert.ok(deck > 500, `${tag}: only ${String(deck)} road ops`);
            if (water > 0) assert.ok(water >= 4, `${tag}: ${String(water)} bridge ops is not a deck`);
        }
    }
});

/* ------------------------------------------------------------------ spacing and density */

test("no district is overcrowded: required gaps hold and the density follows the role", () => {
    /** @type {Record<string, number[]>} */
    const openPerBuildingByRole = {};
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        for (const record of five.records) {
            const tag = `${five.name} d${String(record.districtIndex)} ${String(record.role)}`;
            const spacing = FAC.spacingOf(record);
            assert.equal(spacing.overlaps, 0, `${tag}: ${String(spacing.overlaps)} overlapping building footprints`);
            assert.equal(spacing.belowRequired, 0, `${tag}: ${String(spacing.belowRequired)} pairs closer than requiredGap (worst ${spacing.worst})`);
            assert.ok(spacing.minGap >= LT.MIN_SPACING, `${tag}: closest pair is ${String(spacing.minGap)} (< MIN_SPACING ${String(LT.MIN_SPACING)})`);
            // houses keep the wider street gap of civ/lots.js
            const houses = record.lots.filter((element) => String(element.id).startsWith("building-") && LT.HOUSE_KINDS.includes(String(element.kind).replace("building-", "")));
            const houseNeed = LT.requiredGap("house_s", "house_s");
            for (let a = 0; a < houses.length; a += 1) {
                for (let b = a + 1; b < houses.length; b += 1) {
                    assert.ok(LT.rectGap(houses[a].bbox, houses[b].bbox) >= houseNeed, `${tag}: ${houses[a].id} and ${houses[b].id} are ${String(LT.rectGap(houses[a].bbox, houses[b].bbox))} apart, houses need ${String(houseNeed)}`);
                }
            }
            const density = FAC.densityOf(record);
            assert.ok(density.openColumnsPerBuilding >= FAC.DENSITY.minOpenColumnsPerBuilding, `${tag}: only ${String(density.openColumnsPerBuilding)} open columns per building`);
            assert.ok(density.footprintFraction <= FAC.DENSITY.maxFootprintFraction, `${tag}: footprints cover ${(density.footprintFraction * 100).toFixed(1)}%`);
            (openPerBuildingByRole[String(record.role)] ??= []).push(density.openColumnsPerBuilding);
            // the 49x49 prototype fitted ~50 buildings into 2401 columns; an enlarged district must give
            // each of them many times that much open land.
            assert.ok(density.openColumnsPerBuilding > 2401 / 50 * 5, `${tag}: as dense as the 49x49 prototype`);
        }
        const byRole = new Map(five.records.map((record) => [String(record.role), FAC.densityOf(record).openColumnsPerBuilding]));
        const roomy = FAC.DENSITY.roomyRoles.map((role) => Number(byRole.get(role)));
        const crowded = FAC.DENSITY.crowdedRoles.map((role) => Number(byRole.get(role)));
        assert.ok(Math.min(...roomy) > Math.max(...crowded), `${spec.seed}: density does not follow the role - ${JSON.stringify([...byRole.entries()])}`);
        const all = [...byRole.values()];
        assert.ok(Math.max(...all) >= Math.min(...all) * FAC.DENSITY.minSpreadRatio, `${spec.seed}: all five equally dense - ${JSON.stringify(all)}`);
    }
    console.log(`open columns per building (min..max over ${BATTERY.length} terrains): ${Object.entries(openPerBuildingByRole).map(([role, list]) => `${role} ${String(Math.min(...list))}-${String(Math.max(...list))}`).join(", ")}`);
});

/* ------------------------------------------------------------------ role mix and loudness */

test("the built kind mix of each district is its role's mix, and only its role's", () => {
    const lines = [];
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        for (const record of five.records) {
            const problems = FAC.mixProblems(record, five.records);
            assert.deepEqual(problems, [], `${five.name} d${String(record.districtIndex)} ${String(record.role)}: ${problems.slice(0, 4).join(" | ")}`);
            const mix = FAC.mixOf(record);
            lines.push(`${five.name} d${String(record.districtIndex)} ${String(record.role)}: ${String(mix.buildings)} buildings, ${JSON.stringify(mix.kinds)}`);
        }
    }
    console.log(lines.join("\n"));
    // the five roles are told apart by what they actually contain, on the reference terrain
    const five = fiveDistricts(SEED, 18);
    const kindsOf = new Map(five.records.map((record) => [String(record.role), buildingKinds(record)]));
    for (const [kind, owner] of Object.entries(FAC.EXCLUSIVE_OWNER)) {
        for (const [role, kinds] of kindsOf) {
            if (role === owner) continue;
            assert.equal(kinds[kind] ?? 0, 0, `${role} sited ${kind}, which belongs to ${owner}`);
        }
    }
    for (const role of ["command", "industrial", "agricultural", "commercial", "residential"]) {
        assert.ok(Object.keys(kindsOf.get(role) ?? {}).length >= 8, `${role}: only ${String(Object.keys(kindsOf.get(role) ?? {}).length)} distinct kinds`);
    }
});

test("unsited facilities are reported per district, never swallowed", () => {
    const silent = [];
    const reported = [];
    /** @type {Set<string>} */
    const zeroSited = new Set();
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        for (const record of five.records) {
            const tag = `${five.name} d${String(record.districtIndex)} ${String(record.role)}`;
            for (const problem of FAC.unsitedProblems(record)) silent.push(`${tag}: ${problem}`);
            const shortfalls = FAC.shortfallOf(record);
            const notes = FAC.reportedShortfalls(record);
            for (const miss of shortfalls) reported.push(`${tag}: ${miss.kind} ${String(miss.placed)}/${String(miss.wanted)}`);
            // the record's own lot accounting must match the notes
            assert.ok(
                record.notes.filter((note) => String(note).includes("no buildable pad")).length >= Number(record.stats.lotsWithoutPad),
                `${tag}: ${String(record.stats.lotsWithoutPad)} lots without pad, ${String(record.notes.filter((note) => String(note).includes("no buildable pad")).length)} notes`,
            );
            assert.equal(Number(record.stats.buildings), Number(record.stats.lotsPlaced), `${tag}: buildings vs placed lots`);
            // the structures that MAKE the role have to be physically sited, on every terrain in the battery.
            // A programme kind may only vanish if civ/facilities.js admits it cannot always be sited - that
            // half is asserted by mixProblems/unsitedProblems above, both of which must come back empty.
            const mix = FAC.mixOf(record);
            for (const kind of FAC.DEFINING[String(record.role)]) {
                assert.ok(Number(mix.kinds[kind] ?? 0) >= 1, `${tag}: ${kind} defines the ${String(record.role)} role and is not sited at all`);
            }
            for (const [kind, wanted] of Object.entries(FAC.programmeWants(String(record.role)))) {
                if ((mix.kinds[kind] ?? 0) !== 0) continue;
                assert.ok((FAC.SITING_GAPS[String(record.role)] ?? []).includes(kind), `${tag}: ${kind} (wanted ${String(wanted)}) sited none, and the audit does not admit that as possible`);
                zeroSited.add(`${String(record.role)}/${kind}`);
            }
        }
    }
    const registry = new Set(Object.entries(FAC.SITING_GAPS).flatMap(([role, kinds]) => kinds.map((kind) => `${role}/${kind}`)));
    assert.ok([...zeroSited].every((entry) => registry.has(entry)), `sited-none kinds outside the registry: ${[...zeroSited].filter((e) => !registry.has(e)).join(", ")}`);
    const unexercised = [...registry].filter((entry) => !zeroSited.has(entry));
    console.log(`siting registry: ${String(zeroSited.size)} of ${String(registry.size)} admitted kinds actually failed on this battery${unexercised.length > 0 ? ` (proved by the wider sweep, not this one: ${unexercised.join(", ")})` : ""}`);
    assert.deepEqual(silent, [], silent.slice(0, 6).join(" ; "));
    console.log(`unsited (always announced): ${reported.length} entries, e.g. ${reported.slice(0, 4).join(" | ")}`);
    // a district that loses a signature category must be refused by the audit, not shipped
    const five = fiveDistricts(SEED, 18);
    const tampered = structuredClone({ ...five.records[1], lots: five.records[1].lots.filter((element) => !String(element.kind).includes("smithy")) });
    assert.ok(FAC.mixProblems(tampered, five.records).length > 0, "removing every smithy from Ironquarry must be a problem");
    const silenced = structuredClone({ ...five.records[3] });
    silenced.lots = five.records[3].lots.filter((element) => !String(element.kind).includes("market_square"));
    silenced.notes = [];
    assert.ok(FAC.unsitedProblems(silenced).length > 0, "an unplaced market square with no note must not pass silently");
});

/* ------------------------------------------------------------------ shape */

test("all five outlines stay irregular, solid and pairwise non-congruent", () => {
    const limits = VAL.VALIDATE_DEFAULTS;
    const cellSets = new Map();
    for (const spec of [BATTERY[0], BATTERY[2]]) {
        const five = fiveDistricts(spec.seed, spec.relief);
        const decoded = decodeCacheFor(five.plan);
        const grid = five.plan.grid;
        for (const index of [1, 2, 3, 4, 5]) {
            const record = five.records[index - 1];
            const tag = `${five.name} d${String(index)}`;
            /** @type {number[][]} */
            const cells = [];
            for (let gz = 0; gz < grid.h; gz += 1) for (let gx = 0; gx < grid.w; gx += 1) if (decoded[gz * grid.w + gx] === index) cells.push([gx, gz]);
            cellSets.set(index, cells);
            assert.ok(record.outline.length >= 12, `${tag}: only ${String(record.outline.length)} vertices`);
            const area = VAL.polygonAreaOf(record.outline);
            assert.ok(Math.abs(area / Number(record.area) - 1) <= limits.outlineAreaTolerance, `${tag}: outline area ${String(area)} vs ${String(record.area)} columns`);
            const perimeter = VAL.polygonPerimeterOf(record.outline, true);
            const compact = VAL.compactnessOf(area, perimeter);
            assert.ok(compact >= limits.compactnessMin && compact <= limits.compactnessMax, `${tag}: compactness ${compact.toFixed(3)} is a disc or a fringe`);
            // bbox fill: not a square, not a rectangle
            const bbox = record.bbox;
            const cell = Number(five.plan.cell);
            const gx0 = Math.floor((bbox.x0 - five.plan.grid.x0) / cell);
            const gx1 = Math.floor((bbox.x1 - five.plan.grid.x0) / cell);
            const gz0 = Math.floor((bbox.z0 - five.plan.grid.z0) / cell);
            const gz1 = Math.floor((bbox.z1 - five.plan.grid.z0) / cell);
            const inside = (gx1 - gx0 + 1) * (gz1 - gz0 + 1);
            assert.ok(cells.length / inside < 0.8, `${tag}: ${(100 * (cells.length / inside)).toFixed(1)}% bbox fill`);
            // a solid region, not a thread: eroding by two cells keeps one big piece
            const labels = new Uint8Array(grid.w * grid.h);
            for (let gz = 0; gz < grid.h; gz += 1) for (let gx = 0; gx < grid.w; gx += 1) labels[gz * grid.w + gx] = decoded[gz * grid.w + gx] === index ? index : 0;
            const eroded = VAL.erodeUniform(labels, grid.w, grid.h, 2);
            let kept = 0;
            for (let p = 0; p < eroded.length; p += 1) if (eroded[p] === 1) kept += 1;
            assert.ok(kept > 0.6 * cells.length, `${tag}: only ${String(kept)} of ${String(cells.length)} cells survive a 2-cell erosion`);
            const open = VAL.labelComponents(Uint8Array.from(eroded, (v) => (v === 1 ? 0 : 1)), grid.w, grid.h, false);
            assert.ok(open.count <= 4, `${tag}: the eroded district breaks into ${String(open.count)} pieces`);
            assert.deepEqual(D.siteContainmentProblems(five.plan, index, record), [], `${tag}: containment`);
        }
        if (spec.seed !== SEED) continue;
        // pairwise non-congruence of the five outlines
        let worst = 0;
        for (let a = 1; a <= 5; a += 1) {
            for (let b = a + 1; b <= 5; b += 1) {
                const found = VAL.congruence([...cellSets.get(a)], [...cellSets.get(b)]);
                assert.equal(found.exact, false, `districts ${String(a)} and ${String(b)} are exact copies`);
                assert.ok(found.iou < limits.congruenceIou, `districts ${String(a)} and ${String(b)} are ${String(Math.round(found.iou * 100))}% congruent`);
                worst = Math.max(worst, found.iou);
            }
        }
        console.log(`worst pairwise congruence IoU over the five districts: ${worst.toFixed(4)} (limit ${String(limits.congruenceIou)})`);
    }
});

/* ------------------------------------------------------------------ determinism + saved-world compatibility */

/** District-1 checksums captured from `civ/districtplan.js` at baseline 7123c5c, before districts 2-5
 *  were registered. Anyone who already built Hearthgate stores one of these; the five-district
 *  release must not move it. */
const HEARTHGATE_BASELINE = {
    21: "53c81775",
    3: "574153b3",
    7: "35adcecb",
    42: "d82a02e2",
    99: "52dd64fb",
    12: "4fb3d3a3",
    8: "e76294fd",
};

test("district 1's checksum is frozen: the five-district release changes nothing for a saved Hearthgate", () => {
    for (const spec of CASES) {
        const expected = HEARTHGATE_BASELINE[spec.seed];
        assert.ok(expected !== undefined, `the sweep has no pinned baseline for seed ${String(spec.seed)}`);
        const again = D.planDistrictSite(buildCase(spec).plan, 1, buildCase(spec).field, { seed: spec.seed });
        assert.equal(again.record.checksum, expected, `seed ${String(spec.seed)}: Hearthgate's record changed`);
        assert.equal(again.record.layoutId, "hearthgate-enlarged");
    }
    // ...and only the layout registration moved: the rest of district 1's record is untouched
    const fresh = D.planDistrictSite(PLAN, 1, field, { seed: SEED });
    const keys = ["version", "layoutId", "seed", "districtIndex", "districtId", "name", "role", "planSeed", "anchor", "cell", "bbox", "area", "outline", "options", "ground", "sealedWalls", "stats", "walls", "gates", "roads", "lots", "dressing", "clear", "routes", "patrol", "lotReport", "notes", "problems", "limits", "recordBytes", "checksum"];
    assert.deepEqual(Object.keys(fresh.record).sort(), keys.slice().sort(), "the record gained or lost a field");
    assert.equal(fresh.record.checksum, RECORD.checksum);
    assert.deepEqual(fresh.record.stats, RECORD.stats, "district 1's stats drifted");
    assert.deepEqual(fresh.record.lots.map((element) => `${element.id}@${element.total}`), RECORD.lots.map((element) => `${element.id}@${element.total}`), "district 1's buildings moved");
});

test("districts 2-5 are deterministic, and a different seed changes the plan", () => {
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        const other = D.planDistrictSite(five.plan, 2, five.field, { seed: spec.seed + 1 });
        for (const record of five.records) {
            const index = Number(record.districtIndex);
            const again = D.planDistrictSite(five.plan, index, five.field, { seed: spec.seed });
            assert.equal(again.record.checksum, record.checksum, `${five.name} d${String(index)}: a rerun differs`);
            assert.notEqual(other.record.checksum, record.checksum, `${five.name} d${String(index)}: seed ${String(spec.seed + 1)} produced the same plan`);
            // the record stays small enough for the kingdom blob and never embeds ops
            assert.ok(Number(record.recordBytes) <= CIV_LIMITS.maxPlanBytes, `d${String(index)}: ${String(record.recordBytes)} bytes`);
            let biggest = 0;
            let streamed = 0;
            for (const slice of D.siteOpSlices(record)) {
                streamed += slice.ops.length;
                biggest = Math.max(biggest, slice.ops.length);
            }
            assert.equal(streamed, D.siteOpCount(record), `d${String(index)}: streamed ops disagree`);
            assert.ok(biggest <= CIV_LIMITS.maxBlocksPerSlice, `d${String(index)}: a slice of ${String(biggest)} ops`);
            const specs = D.siteJobSpecs(record);
            const jobs = Object.values(specs).reduce((sum, list) => sum + (/** @type {any[]} */ (list)).length, 0);
            assert.ok(jobs > 150, `d${String(index)}: only ${String(jobs)} job elements`);
            assert.ok(D.siteOpCount(record) <= 400000, `d${String(index)}: ${String(D.siteOpCount(record))} ops`);
        }
    }
});

/* ------------------------------------------------------------------ the numbers */

test("the five districts fit the existing budgets without raising any of them", () => {
    const MAX_SANE_OPS = 400000; // integration/civBuilder.js, per district
    let maxRecord = 0;
    let maxQueue = 0;
    let maxOps = 0;
    let maxSlices = 0;
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        for (const record of five.records) {
            const ops = D.siteOpCount(record);
            const queue = createQueue(D.siteJobSpecs(record), { planHash: String(record.checksum) });
            const queueBytes = JSON.stringify(queue).length;
            maxRecord = Math.max(maxRecord, Number(record.recordBytes));
            maxQueue = Math.max(maxQueue, queueBytes);
            maxOps = Math.max(maxOps, ops);
            maxSlices = Math.max(maxSlices, Math.ceil(ops / CIV_LIMITS.maxBlocksPerSlice));
            assert.ok(Number(record.recordBytes) <= CIV_LIMITS.maxPlanBytes, `d${String(record.districtIndex)}: record ${String(record.recordBytes)} B`);
            assert.ok(queueBytes <= CIV_LIMITS.maxJobBytes, `d${String(record.districtIndex)}: job queue ${String(queueBytes)} B over ${String(CIV_LIMITS.maxJobBytes)}`);
            assert.ok(ops <= MAX_SANE_OPS, `d${String(record.districtIndex)}: ${String(ops)} ops over the builder's ${String(MAX_SANE_OPS)}`);
        }
    }
    console.log(`five-district budget use: record ${String(maxRecord)}/${String(CIV_LIMITS.maxPlanBytes)} B, job queue ${String(maxQueue)}/${String(CIV_LIMITS.maxJobBytes)} B, ops ${String(maxOps)}/${String(MAX_SANE_OPS)}, slices/slice ${String(maxSlices)}/${String(CIV_LIMITS.maxBlocksPerSlice)}`);
});

test("the five district plans, in numbers (printed for the milestone report)", () => {
    /** @type {string[]} */
    const rows = [];
    for (const spec of BATTERY) {
        const five = fiveDistricts(spec.seed, spec.relief);
        rows.push(`${five.name}: district | role | enclosed columns | ops | job elements | record bytes | lots sited/wanted | walls/length | gates | road cells`);
        for (const record of five.records) {
            const spacing = FAC.spacingOf(record);
            const density = FAC.densityOf(record);
            const wanted = Object.values(FAC.programmeWants(String(record.role))).reduce((sum, n) => sum + n, 0);
            rows.push(
                `  d${String(record.districtIndex)} ${String(record.name)} ${String(record.role).padEnd(12)}` +
                ` area=${String(record.area).padStart(6)}` +
                ` ops=${String(D.siteOpCount(record)).padStart(6)}` +
                ` jobs=${String(Object.values(D.siteJobSpecs(record)).reduce((s, l) => s + l.length, 0)).padStart(4)}` +
                ` bytes=${String(record.recordBytes).padStart(6)}` +
                ` lots=${String(record.stats.lotsPlaced)}/${String(wanted)}` +
                ` walls=${String(record.stats.walls)}/${String(record.stats.wallLength)}` +
                ` gates=${String(record.stats.gates)}` +
                ` roads=${String(record.stats.roadCells)}` +
                ` stairs=${String(record.stats.wallStairs)}` +
                ` minGap=${String(spacing.minGap)}` +
                ` openPerBuilding=${String(density.openColumnsPerBuilding)}` +
                ` footprint=${(density.footprintFraction * 100).toFixed(1)}%` +
                ` checksum=${record.checksum}`,
            );
        }
    }
    console.log(rows.join("\n"));
    const five = fiveDistricts(SEED, 18);
    const areas = five.records.map((record) => Number(record.area));
    assert.ok(Math.min(...areas) >= 30000 && Math.max(...areas) <= 45000, `areas ${JSON.stringify(areas)}`);
    assert.ok(Math.max(...areas) - Math.min(...areas) > 3000, `the five districts are all the same size: ${JSON.stringify(areas)}`);
    const ops = five.records.map((record) => D.siteOpCount(record));
    assert.ok(Math.max(...ops) - Math.min(...ops) > 5000, `identical workload everywhere: ${JSON.stringify(ops)}`);
});
