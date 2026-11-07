// The lamp retrofit's rules: what counts as a stand, how a grid point relocates, and how coverage is measured.
// The Minecraft-side job is proved in dev/test/civ-lights-runtime.test.mjs; this file imports only the pure
// module, so a wrong rule cannot hide behind a fake world.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const L = await import(pathToFileURL(join(scriptsRoot, "civ", "lamps.js")).href);

const cell = (x, z, id, y = 64) => ({ x, y, z, id });
/** A reader over a map keyed "x,z"; a missing key is unloaded ground. */
function readerOf(cells) {
    return (x, z) => cells.get(`${x},${z}`);
}
function mapOf(...cells) {
    return new Map(cells.map((one) => [`${one.x},${one.z}`, one]));
}

test("a lantern stands on solid surfaces, never on water, vegetation, trees or decoration", () => {
    for (const id of [
        "minecraft:grass_block",
        "minecraft:dirt",
        "minecraft:stone",
        "minecraft:sand",
        "minecraft:gravel",
        "minecraft:stone_bricks",
        "minecraft:polished_andesite",
        "minecraft:oak_planks",
        "minecraft:deepslate_bricks",
        "minecraft:oak_slab",
        "minecraft:stone_brick_stairs",
        "minecraft:oak_fence",
        "minecraft:glass",
        "minecraft:bedrock",
    ]) {
        assert.equal(L.isLampStand(id), true, `${id} is a stand`);
    }
    for (const id of [
        "minecraft:air",
        "minecraft:water",
        "minecraft:lava",
        "minecraft:oak_leaves",
        "minecraft:azalea_leaves",
        "minecraft:oak_log",
        "minecraft:stripped_oak_log",
        "minecraft:oak_wood",
        "minecraft:crimson_stem",
        "minecraft:short_grass",
        "minecraft:dandelion",
        "minecraft:wheat",
        "minecraft:snow_layer",
        "minecraft:powder_snow",
        "minecraft:oak_carpet",
        "minecraft:torch",
        "minecraft:oak_button",
        "minecraft:oak_pressure_plate",
        "minecraft:oak_door",
        "minecraft:oak_trapdoor",
        "minecraft:oak_fence_gate",
        "minecraft:rail",
        "minecraft:oak_sign",
        "minecraft:lantern",
        "not-a-block",
    ]) {
        assert.equal(L.isLampStand(id), false, `${id} is not a stand`);
    }
});

test("the grid point itself is used first; a blocked point relocates within the documented ring", () => {
    const flat = mapOf(cell(0, 0, "minecraft:grass_block"));
    assert.deepEqual(L.chooseLampSpot(readerOf(flat), 0, 0), { state: "lamp", x: 0, z: 0, y: 65 });

    // The grid point is water, its neighbour is grass: the lamp moves one block, deterministically.
    const wet = mapOf(cell(0, 0, "minecraft:water"), cell(0, 1, "minecraft:grass_block"));
    assert.deepEqual(L.chooseLampSpot(readerOf(wet), 0, 0), { state: "lamp", x: 0, z: 1, y: 65 });

    // Every cell in the ring is water: no lamp, and it is not an error.
    const lake = mapOf(cell(0, 0, "minecraft:water"), cell(0, 1, "minecraft:water"));
    assert.equal(L.chooseLampSpot(readerOf(lake), 0, 0).state, "skip");

    // A grid point outside the world model (unloaded) is reported, never relocated blindly.
    assert.equal(L.chooseLampSpot(readerOf(new Map()), 0, 0).state, "unloaded");
});

test("a lantern already in the ring makes the point done - even when a stand is nearer this time", () => {
    // The first run would have placed at (1,0); suppose it landed at (2,0) because (1,0) read unloaded then.
    // A rerun must not add a second lamp at (1,0).
    const cells = mapOf(cell(0, 0, "minecraft:water"), cell(2, 0, "minecraft:lantern", 65), cell(1, 0, "minecraft:grass_block"));
    const decision = L.chooseLampSpot(readerOf(cells), 0, 0, { relocate: 2 });
    assert.equal(decision.state, "already");
    assert.equal(decision.x, 2);
    assert.equal(decision.z, 0);
});

test("the grid is anchored at the rectangle's own corner, so tiles never move it", () => {
    const rect = { x0: 3, z0: 5, x1: 19, z1: 21 };
    const points = L.gridPointsOf(rect, 8);
    assert.deepEqual(points.map((p) => `${p.x},${p.z}`), ["3,5", "11,5", "19,5", "3,13", "11,13", "19,13", "3,21", "11,21", "19,21"]);
    assert.equal(L.firstGridAt(9, 3, 8), 11);
    assert.equal(L.firstGridAt(11, 3, 8), 11);
    assert.equal(L.firstGridAt(12, 3, 8), 19);
});

test("planLampSpots counts what it did, and only places lamps on stands", () => {
    const cells = mapOf(
        cell(0, 0, "minecraft:grass_block"),
        cell(8, 0, "minecraft:water"),
        cell(8, 1, "minecraft:stone"),
        cell(16, 0, "minecraft:lantern", 65),
        cell(0, 8, "minecraft:oak_leaves", 70),
        cell(0, 9, "minecraft:dirt"),
        cell(8, 8, "minecraft:short_grass"),
        cell(16, 8, "minecraft:sand"),
    );
    const plan = L.planLampSpots(readerOf(cells), { x0: 0, z0: 0, x1: 16, z1: 8 });
    assert.equal(plan.points, 6, "three columns of grid points, two rows");
    assert.equal(plan.already, 1);
    assert.equal(plan.unloaded, 0);
    assert.deepEqual(plan.spots.map((s) => `${s.x},${s.z}`).sort(), ["0,0", "0,9", "8,1", "16,8"].sort());
    assert.equal(plan.skipped, 6 - plan.spots.length - plan.already);
});

test("coverage measures Manhattan distance from a standing cell to the nearest lantern", () => {
    const lamps = [{ x: 0, y: 65, z: 0 }];
    const surfaces = [
        { x: 0, y: 65, z: 2 }, // 2
        { x: 3, y: 65, z: 4 }, // 7
        { x: 5, y: 66, z: 5 }, // 11
        { x: 8, y: 65, z: 0 }, // 8
    ];
    const report = L.coverageOf(surfaces, lamps, { reach: 10 });
    assert.equal(report.open, 4);
    assert.equal(report.worst, 11);
    assert.deepEqual(report.far.map((f) => `${f.x},${f.z}:${f.distance}`), ["5,5:11"]);
});

test("wall tops get their own samples along the master plan's path, every ten cells plus the end", () => {
    const straight = L.wallLampSamples([[0, 0], [25, 0]]);
    assert.deepEqual(straight.map((s) => s.x), [0, 10, 20, 25]);
    assert.ok(straight.every((s) => s.z === 0));
    // A diagonal path still samples only real rasterised cells (the wall planner's own Bresenham).
    const diagonal = L.wallLampSamples([[0, 0], [12, 12]], { step: 5 });
    assert.deepEqual(diagonal.map((s) => `${s.x},${s.z}`), ["0,0", "5,5", "10,10", "12,12"]);
});

test("the lamp index answers 'is this cell lit' across bucket boundaries, including negative coordinates", () => {
    const index = L.createLampIndex(16);
    index.add({ x: 0, y: 65, z: 0 });
    assert.equal(index.covers({ x: 14, y: 65, z: 0 }), true, "distance 14 still receives light 1");
    assert.equal(index.covers({ x: 15, y: 65, z: 0 }), false, "distance 15 is block light 0");
    assert.equal(index.covers({ x: 5, y: 70, z: 4 }), true, "5 + 5 + 4 = 14");
    assert.equal(index.size(), 1);

    const across = L.createLampIndex(16);
    across.add({ x: 15, y: 65, z: 15 });
    assert.equal(across.covers({ x: 29, y: 65, z: 15 }), true, "a lamp one bucket away is still in reach");
    assert.equal(across.covers({ x: 30, y: 65, z: 15 }), false);

    const negative = L.createLampIndex(16);
    negative.add({ x: -1, y: 65, z: -17 });
    assert.equal(negative.covers({ x: -14, y: 65, z: -17 }), true);
    assert.equal(negative.covers({ x: -16, y: 65, z: -17 }), false);
});

test("the shipped grid numbers are the ones the coverage argument uses", () => {
    assert.deepEqual(L.LAMP_RETROFIT, { spacing: 8, relocate: 2, wallStep: 10 });
    assert.equal(L.LAMP_ID, "minecraft:lantern");
    assert.equal(L.LAMP_REACH, 14);
    // spacing 8 puts every grid column within 4 + 4 of its point; relocation adds at most 2 + 2, so a lamp is
    // at most 12 blocks away and the column still receives light 15 - 12 = 3 (a mob needs block light 0).
    assert.ok(L.LAMP_RETROFIT.spacing / 2 + L.LAMP_RETROFIT.spacing / 2 + L.LAMP_RETROFIT.relocate * 2 <= 12);
});
