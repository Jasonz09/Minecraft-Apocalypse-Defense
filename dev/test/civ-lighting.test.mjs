// Lighting: a district is planned lit, so hostile mobs (which need block light 0) cannot spawn in it.
//
// The claim is measured from the RECORD's own op stream, not from the planner's statistics: the lamp posts and
// lanterns are regenerated with siteOpsFor, and the distance from every open ground column to the nearest lamp
// column is computed independently. The wall's own lights (merlons, tower passage and roof) are proved in
// dev/test/civ-gates.test.mjs.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const loadDev = (...parts) => import(pathToFileURL(join(projectRoot, "dev", ...parts)).href);

const { makeField } = await loadDev("lib", "fakefield.mjs");
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");
const Gm = await load("civ", "geom.js");

const SEED = 21;
const RELIEF = 18;
const INDEX = 1;
const field = makeField(SEED, { relief: RELIEF, hills: 60 });
const planned = M.planCivilizationDetailed(field, { seed: SEED });
assert.equal(planned.ok, true, planned.errors.join(" | "));
const site = D.planDistrictSite(planned.plan, INDEX, field, { seed: SEED });
assert.equal(site.ok, true, site.problems.join(" | "));
const record = site.record;

test("natural lighting is sparse, varied and beside paths instead of across fields", () => {
    const result = D.planDistrictSite(planned.plan, INDEX, field, { seed: SEED, lighting: "natural" });
    assert.equal(result.ok, true, result.problems.join(" | "));
    const natural = result.record;
    const at = natural.dressing.findIndex((element) => element.kind === "lamps");
    assert.ok(at >= 0);
    const ops = D.siteOpsFor(natural, "dressing", at);
    const sources = ops.filter((op) => ["minecraft:torch", "minecraft:lantern"].includes(op.id));
    const legacyAt = record.dressing.findIndex((element) => element.kind === "lamps");
    assert.ok(sources.length >= 6, `only ${sources.length} useful path lights`);
    assert.ok(sources.length < record.dressing[legacyAt].lamps / 10, "remove at least ninety percent of the blanket outdoor fixtures");
    assert.ok(sources.some((op) => op.id === "minecraft:torch") && sources.some((op) => op.id === "minecraft:lantern"));
    const roads = new Set();
    for (const [index] of natural.roads.entries()) for (const op of D.siteOpsFor(natural, "roads", index)) roads.add(`${op.x},${op.z}`);
    for (const source of sources) {
        assert.ok(!roads.has(`${source.x},${source.z}`), "a fixture never blocks the road itself");
        let near = false;
        for (let dz = -3; dz <= 3; dz += 1) for (let dx = -3; dx <= 3; dx += 1) if (roads.has(`${source.x + dx},${source.z + dz}`)) near = true;
        assert.ok(near, "leave open land away from paths unlit");
        assert.ok(source.y - field.at(source.x, source.z).g <= 3, "short fixtures leave the landscape visible");
    }
    assert.equal(D.siteOptionsOf(natural).lighting, "natural", "the saved plan can reproduce the new style");
});

const elementOf = (kind) => record.dressing.find((el) => el.kind === kind);
const opsOf = (kind) => {
    const el = elementOf(kind);
    return el === undefined ? [] : D.siteOpsFor(record, "dressing", record.dressing.indexOf(el));
};
const lamps = opsOf("lamps");
const lanterns = lamps.filter((op) => op.id === "minecraft:lantern");
const lampColumns = new Set(lanterns.map((op) => `${op.x},${op.z}`));

const stageColumns = (stages) => {
    const keys = new Set();
    for (const stage of stages) {
        for (const [i] of record[stage].entries()) {
            for (const op of D.siteOpsFor(record, stage, i)) keys.add(`${op.x},${op.z}`);
        }
    }
    return keys;
};

test("legacy plans reproduce their outdoor grid for saved-world compatibility", () => {
    const el = elementOf("lamps");
    assert.ok(el, "the district plan has no lamps element");
    assert.equal(el.spacing, 5, "the documented spacing is what the plan used");
    assert.equal(el.relocate, 2, "and the documented relocation");
    assert.equal(el.post, 3, "a three-block post under the lantern");
    assert.ok(el.lamps > 0);
    // The grid covers the district area at one lamp per spacing^2 cells; a healthy fraction of those cells is
    // open ground (the rest is walls, roads and buildings the plan already covers).
    assert.ok(el.lamps >= 0.5 * (record.area / (el.spacing * el.spacing)), `${el.lamps} lamps for a district of ${record.area} cells is too sparse for a ${el.spacing}-block grid`);
    assert.ok(lampColumns.size >= el.lamps * 0.85, `${lampColumns.size} of ${el.lamps} planned lamps survived priority resolution`);
    assert.equal(lanterns.length, lampColumns.size, "one lantern per lamp column");
});

test("a lamp stands on its post: every lantern outside a built pad has three fence blocks below it", () => {
    const padRects = record.lots.filter((el) => String(el.id).startsWith("pad-")).map((el) => el.bbox);
    const onPad = (x, z) => padRects.some((box) => x >= box.x0 - 1 && x <= box.x1 + 1 && z >= box.z0 - 1 && z <= box.z1 + 1);
    const ids = new Map(lamps.map((op) => [`${op.x},${op.y},${op.z}`, op.id]));
    let checked = 0;
    for (const op of lanterns) {
        if (onPad(op.x, op.z)) continue; // a pad, its apron stair or a retaining wall can bury a post; the light survives
        for (let k = 1; k <= 3; k += 1) {
            assert.equal(ids.get(`${op.x},${op.y - k},${op.z}`), "minecraft:oak_fence", `the lamp at ${op.x},${op.y},${op.z} is missing post block ${k}`);
        }
        checked += 1;
    }
    assert.ok(checked > lanterns.length * 0.8, `only ${checked} of ${lanterns.length} lamps stand clear of a pad`);
});

test("legacy blanket lighting reproduces its original coverage for cleanup", () => {
    // A lantern is 4 blocks above its stand surface and light 15 falls by one per block of MANHATTAN distance,
    // so a column up to 8 blocks away still receives light 3 - above the 0 a mob needs to spawn. Chebyshev
    // distance would be wrong here: the diagonal corner of a square reaches the lamp through two axes.
    const covered = stageColumns(["walls", "gates", "roads"]);
    for (const el of record.lots) {
        if (!String(el.id).startsWith("building-")) continue;
        for (const op of D.siteOpsFor(record, "lots", record.lots.indexOf(el))) covered.add(`${op.x},${op.z}`);
    }
    const lampCols = [...lampColumns].map((key) => key.split(",").map(Number));
    const open = [];
    for (let z = record.bbox.z0; z <= record.bbox.z1; z += 1) {
        for (let x = record.bbox.x0; x <= record.bbox.x1; x += 1) {
            if (Gm.labelAt(planned.plan, x, z) !== INDEX) continue;
            const cell = field.at(x, z);
            if (cell.k === "unloaded" || cell.k === "lava" || cell.k === "blocked") continue;
            if (covered.has(`${x},${z}`)) continue;
            open.push([x, z]);
        }
    }
    assert.ok(open.length > 10000, `only ${open.length} open columns is not a real district`);
    let worst = 0;
    const far = [];
    for (const [x, z] of open) {
        let best = Infinity;
        for (const [lx, lz] of lampCols) best = Math.min(best, Math.abs(lx - x) + Math.abs(lz - z));
        worst = Math.max(worst, best);
        if (best > 8) far.push([x, z, best]);
    }
    assert.ok(worst > 0, "the lamp grid covers every cell, which means it is not a grid");
    assert.deepEqual(far.slice(0, 5), [], `${far.length} of ${open.length} open columns are beyond the 8-block Manhattan light reach (worst ${worst}); a mob can spawn there at night`);
});

test("every enclosed building gets an interior light, so a dark room cannot spawn a mob", () => {
    const el = elementOf("room-lights");
    assert.ok(el, "the plan has no room lights");
    const enclosed = record.lots.filter((lot) => String(lot.kind).startsWith("building-") && !D.OPEN_AIR_KINDS.has(String(lot.kind).slice("building-".length)));
    assert.ok(enclosed.length > 10, "the fixture has buildings");
    assert.equal(el.lamps, enclosed.length, "one ceiling lantern is planned per enclosed building");
    assert.ok(el.total > 0);
    const boxes = enclosed.map((lot) => lot.bbox);
    const ops = opsOf("room-lights");
    assert.equal(ops.length, el.total, "the recorded total is what the element regenerates");
    for (const op of ops) {
        assert.equal(op.id, "minecraft:lantern");
        assert.ok(boxes.some((box) => op.x >= box.x0 && op.x <= box.x1 && op.z >= box.z0 && op.z <= box.z1), `room lantern at ${op.x},${op.y},${op.z} is outside every building`);
    }
});
