import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { detectVillage, VILLAGE_DEFAULTS, assessSite } = await load("civ", "environments.js");

const AIR = "minecraft:air";
const GRASS = "minecraft:grass_block";
const ONE = { x0: 0, z0: 0, x1: 0, z1: 0 };

/** Ground at y=64 under air, with subsoil below. */
function ground(surfaceY = 64) {
    const cells = [];
    for (let y = surfaceY + 3; y > surfaceY; y -= 1) cells.push({ y, id: AIR });
    cells.push({ y: surfaceY, id: GRASS });
    for (let y = surfaceY - 1; y >= surfaceY - 8; y -= 1) cells.push({ y, id: y >= surfaceY - 3 ? "minecraft:dirt" : "minecraft:stone" });
    return cells;
}

/** Footprint cell (0,0) on ground, plus extra cells in a column at (x, z). */
function scene(extra, x = 3, z = 0) {
    return [
        { x: 0, z: 0, cells: ground(64) },
        { x, z, cells: extra },
    ];
}

const house = [
    { y: 65, id: "minecraft:red_bed" },
    { y: 66, id: "minecraft:oak_door" },
    { y: 65, id: "minecraft:composter" },
    { y: 65, id: "minecraft:spruce_planks" },
    { y: 66, id: "minecraft:spruce_planks" },
];

test("the defaults are the documented thresholds", () => {
    assert.deepEqual(
        { radius: VILLAGE_DEFAULTS.radius, verticalRange: VILLAGE_DEFAULTS.verticalRange, threshold: VILLAGE_DEFAULTS.threshold, minKinds: VILLAGE_DEFAULTS.minKinds, denseLimit: VILLAGE_DEFAULTS.denseLimit },
        { radius: 12, verticalRange: 10, threshold: 10, minKinds: 2, denseLimit: 2000 },
    );
});

test("a small house (bed, door, composter, planks: weight 10 over 4 kinds) is village-like, with coordinates", () => {
    const result = detectVillage(scene(house), ONE);
    assert.equal(result.villageLike, true);
    assert.equal(result.flagged, 1);
    assert.deepEqual(result.centre, { x: 0, z: 0 });
    assert.match(result.reasons.join(" "), /village-like: 1 footprint column\(s\) reach 10 weighted/);
    assert.match(result.reasons.join(" "), /strongest minecraft:composter at \(3, 65, 0\)/);
    // bed and composter both weigh 3: ties sort by id, so the composter is first
    assert.deepEqual(result.strongest[0], { x: 3, y: 65, z: 0, id: "minecraft:composter", kind: "composter" });
});

test("a lone bed and a torch (weight 4) is not village-like", () => {
    const result = detectVillage(scene([{ y: 65, id: "minecraft:red_bed" }, { y: 65, id: "minecraft:torch" }]), ONE);
    assert.equal(result.villageLike, false);
    assert.equal(result.flagged, 0);
    assert.equal(result.inside.length, 0);
});

test("five chests reach the weight but only one kind, so they are not village-like", () => {
    const chests = Array.from({ length: 5 }, (_, i) => ({ y: 64 + i - 2, id: "minecraft:chest" }));
    const result = detectVillage(scene(chests), ONE);
    assert.equal(result.flagged, 0);
    assert.equal(result.villageLike, false);
});

test("the threshold is exact: weight 9 over three kinds is not enough, weight 10 is", () => {
    const nine = [
        { y: 65, id: "minecraft:bell" },
        { y: 65, id: "minecraft:oak_door" },
        { y: 66, id: "minecraft:chest" },
    ];
    assert.equal(detectVillage(scene(nine), ONE).flagged, 0, "5 + 2 + 2 = 9");
    const ten = [...nine, { y: 66, id: "minecraft:torch" }];
    assert.equal(detectVillage(scene(ten), ONE).flagged, 1, "5 + 2 + 2 + 1 = 10 over 4 kinds");
});

test("the radius is Chebyshev 12 horizontally: a cluster at 12 counts, at 13 does not", () => {
    const cluster = [
        { y: 65, id: "minecraft:bell" },
        { y: 65, id: "minecraft:oak_door" },
        { y: 66, id: "minecraft:chest" },
        { y: 66, id: "minecraft:torch" },
    ];
    assert.equal(detectVillage(scene(cluster, 12, 0), ONE).flagged, 1, "dx = 12");
    assert.equal(detectVillage(scene(cluster, 13, 0), ONE).flagged, 0, "dx = 13");
    assert.equal(detectVillage(scene(cluster, 0, -12), ONE).flagged, 1, "dz = -12");
});

test("the vertical window is 10 above or below the ground: 10 counts, 11 does not", () => {
    const at = (dy) => [
        { y: 64 + dy, id: "minecraft:bell" },
        { y: 64 + dy, id: "minecraft:oak_door" },
        { y: 64 + dy, id: "minecraft:chest" },
        { y: 64 + dy, id: "minecraft:torch" },
    ];
    assert.equal(detectVillage(scene(at(10)), ONE).flagged, 1, "dy = +10");
    assert.equal(detectVillage(scene(at(11)), ONE).flagged, 0, "dy = +11");
    assert.equal(detectVillage(scene(at(-10)), ONE).flagged, 1, "dy = -10");
    assert.equal(detectVillage(scene(at(-11)), ONE).flagged, 0, "dy = -11");
});

test("a player or village block inside the footprint refuses on its own, with its coordinates", () => {
    const columns = [{ x: 0, z: 0, cells: [{ y: 65, id: "minecraft:spruce_planks" }, ...ground(64)] }];
    const result = detectVillage(columns, ONE);
    assert.equal(result.inside.length, 1);
    assert.equal(result.villageLike, true);
    assert.match(result.reasons.join(" "), /minecraft:spruce_planks \(planks\) at \(0, 65, 0\) is inside the footprint/);
});

test("signals far below the ground in the footprint are ignored (only the window below the surface counts)", () => {
    const columns = [{ x: 0, z: 0, cells: [...ground(64), { y: 40, id: "minecraft:spruce_planks" }] }];
    const result = detectVillage(columns, ONE);
    assert.equal(result.inside.length, 0);
    assert.equal(result.villageLike, false);
});

test("above the dense limit the settlement is refused as dense, with the count", () => {
    const result = detectVillage(scene([{ y: 65, id: "minecraft:spruce_planks" }, { y: 66, id: "minecraft:spruce_planks" }, { y: 67, id: "minecraft:spruce_planks" }]), ONE, { denseLimit: 2 });
    assert.equal(result.villageLike, true);
    assert.equal(result.flagged, 0);
    assert.match(result.reasons.join(" "), /3 player or village blocks in the scanned area \(limit 2\): dense settlement/);
});

test("the result is deterministic and the input is not mutated", () => {
    const columns = scene(house);
    const before = JSON.stringify(columns);
    const a = detectVillage(columns, ONE);
    const b = detectVillage(columns, ONE);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(columns), before);
});

test("assessSite: a village cluster within reach of the footprint refuses the site and names the coordinates", () => {
    const columns = [];
    for (let z = -12; z <= 18; z += 1) {
        for (let x = -12; x <= 18; x += 1) {
            const inFootprint = x >= 0 && x <= 6 && z >= 0 && z <= 6;
            const cells = ground(64);
            if (!inFootprint && x === 9 && z === 3) cells.push(...house.map((c) => ({ ...c })));
            columns.push({ x, z, cells });
        }
    }
    const result = assessSite(columns, { x0: 0, z0: 0, x1: 6, z1: 6 });
    assert.equal(result.decision, "refuse");
    assert.ok(result.village.villageLike);
    assert.match(result.reasons.join(" "), /cluster near \(\d+, \d+\), strongest minecraft:composter at \(9, 65, 3\)/);
});

test("assessSite: a lone bed beside the footprint is allowed and only noted", () => {
    const columns = [];
    for (let z = -12; z <= 18; z += 1) {
        for (let x = -12; x <= 18; x += 1) {
            const cells = ground(64);
            if (x === 9 && z === 3) cells.push({ y: 65, id: "minecraft:red_bed" });
            columns.push({ x, z, cells });
        }
    }
    const result = assessSite(columns, { x0: 0, z0: 0, x1: 6, z1: 6 });
    assert.equal(result.decision, "allow");
    assert.match(result.notes.join(" "), /1 player or village block\(s\) nearby, below the village threshold/);
});
