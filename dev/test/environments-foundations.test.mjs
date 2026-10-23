import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { planSurfaceFooting, requiredFootingDepth, FOOTING_DEFAULTS } = await load("civ", "environments.js");
const { IDS, makeProfile, planFoundationColumns } = await load("civ", "foundations.js");

const AIR = "minecraft:air";
const AREA = { x0: 0, z0: 0, x1: 6, z1: 6 };

/** A column: air above the surface, the surface block, then subsoil (dirt) and stone. */
function column(surfaceY, surfaceId = "minecraft:grass_block", overrides = {}) {
    const cells = [];
    for (let y = surfaceY + 3; y >= surfaceY - 12; y -= 1) {
        if (y in overrides) cells.push({ y, id: overrides[y] });
        else if (y > surfaceY) cells.push({ y, id: AIR });
        else if (y === surfaceY) cells.push({ y, id: surfaceId });
        else cells.push({ y, id: y >= surfaceY - 3 ? "minecraft:dirt" : "minecraft:stone" });
    }
    return cells;
}

/** Footprint columns only (footing reads the footprint). make(x, z) returns the cells. */
function footprint(make, area = AREA) {
    const columns = [];
    for (let z = area.z0; z <= area.z1; z += 1) for (let x = area.x0; x <= area.x1; x += 1) columns.push({ x, z, cells: make(x, z) });
    return columns;
}

test("the footing limit is the foundations.js maximum (8)", () => {
    assert.equal(FOOTING_DEFAULTS.maxDepth, 8);
});

test("flat grass under a raised floor: footing from ground+1 up to the floor, using foundations.js blocks", () => {
    const columns = footprint(() => column(64));
    const plan = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    assert.equal(plan.ok, true);
    assert.equal(plan.counts.columns, 49);
    assert.equal(plan.counts.anchors, 0);
    assert.equal(plan.counts.maxRequired, 2);
    assert.equal(plan.ops.length, 98);
    assert.ok(plan.ops.every((op) => (op.y === 65 ? op.id === IDS.footDeep : op.y === 66 ? op.id === IDS.footTop : false)));
    assert.deepEqual(plan.byClass, { temperate: 49 });
});

test("the footing ops are exactly planFoundationColumns over the same ground (reuse, not a copy)", () => {
    const columns = footprint(() => column(64));
    const plan = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    const profile = makeProfile(0, 0, 7, 7, () => ({ g: 64 }));
    const direct = planFoundationColumns(profile, { cells: AREA_CELLS(), floorY: 67 }, { maxDepth: 8 });
    assert.equal(direct.ok, true);
    assert.deepEqual(plan.ops, [...direct.ops].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z));
});

function AREA_CELLS() {
    const cells = [];
    for (let z = 0; z <= 6; z += 1) for (let x = 0; x <= 6; x += 1) cells.push({ x, z });
    return cells;
}

test("sand needs two anchor blocks: the top two sand blocks become cobblestone under the footing", () => {
    const columns = footprint(() => column(64, "minecraft:sand"));
    const plan = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    assert.equal(plan.ok, true);
    assert.equal(plan.counts.anchors, 98);
    assert.equal(plan.counts.maxRequired, 4, "2 geometric + 2 anchor");
    assert.deepEqual(plan.byClass, { desert: 49 });
    const anchorsAt = (y) => plan.ops.filter((op) => op.x === 3 && op.z === 3 && op.y === y).map((op) => op.id);
    assert.deepEqual(anchorsAt(63), [IDS.footDeep]);
    assert.deepEqual(anchorsAt(64), [IDS.footDeep]);
    assert.deepEqual(anchorsAt(65), [IDS.footDeep]);
    assert.deepEqual(anchorsAt(66), [IDS.footTop]);
});

test("sand deeper than the limit refuses: 6 deep plus 2 anchor is 8 (allowed), 7 deep plus 2 is 9 (refused)", () => {
    const ok = planSurfaceFooting(footprint(() => column(58, "minecraft:sand")), AREA, { baseY: 58, floorY: 65 });
    assert.equal(ok.ok, true, "geometric 6 + anchor 2 = 8");
    assert.equal(ok.counts.maxRequired, 8);

    const refused = planSurfaceFooting(footprint(() => column(57, "minecraft:sand")), AREA, { baseY: 57, floorY: 65 });
    assert.equal(refused.ok, false);
    assert.match(refused.problems[0], /footing at \(0, 0\) on minecraft:sand needs 9 blocks \(max 8, including 2 anchor\)/);
});

test("grass at 8 below the floor is the limit; 9 refuses", () => {
    assert.equal(planSurfaceFooting(footprint(() => column(56)), AREA, { baseY: 56, floorY: 65 }).ok, true);
    const refused = planSurfaceFooting(footprint(() => column(55)), AREA, { baseY: 55, floorY: 65 });
    assert.equal(refused.ok, false);
    assert.match(refused.problems[0], /needs 9 blocks/);
});

test("a void within the hollow band under the footing refuses, reported by foundations.js", () => {
    const columns = footprint((x, z) => column(64, "minecraft:grass_block", x === 2 && z === 2 ? { 61: AIR } : {}));
    const plan = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    assert.equal(plan.ok, false);
    assert.match(plan.problems.join(" "), /hollow ground under \(2, 2\): nothing solid to found on/);
});

test("cells at or above the floor are cut down by the terrain layer and get no footing", () => {
    const columns = footprint((x) => column(x === 6 ? 67 : 64));
    const plan = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 66 });
    assert.equal(plan.ok, true);
    assert.equal(plan.counts.cut, 7, "the x=6 column (7 cells) is at the floor or above");
    assert.equal(plan.counts.columns, 42);
    assert.ok(plan.ops.every((op) => op.x !== 6));
});

test("water columns are crossed by bridges and never footed: counted as water, no ops over the water", () => {
    const wet = (x, z) => (x === 3 && z === 3 ? [{ y: 63, id: "minecraft:water" }, { y: 62, id: "minecraft:dirt" }, { y: 61, id: "minecraft:stone" }] : column(64));
    const plan = planSurfaceFooting(footprint(wet), AREA, { baseY: 64, floorY: 67 });
    assert.equal(plan.ok, true);
    assert.equal(plan.counts.water, 1);
    assert.equal(plan.counts.columns, 48);
    assert.ok(plan.ops.every((op) => !(op.x === 3 && op.z === 3)));
});

test("a deep water bed does not refuse the footing, because water columns are not footed", () => {
    const deep = (x, z) => (x === 3 && z === 3 ? [{ y: 51, id: "minecraft:water" }, { y: 50, id: "minecraft:dirt" }, { y: 49, id: "minecraft:stone" }] : column(64));
    const plan = planSurfaceFooting(footprint(deep), AREA, { baseY: 64, floorY: 67 });
    assert.equal(plan.ok, true);
});

test("snow blocks and clay are footed like any natural class; craftable tops are refused at site level, not here", () => {
    const snow = planSurfaceFooting(footprint(() => column(64, "minecraft:snow")), AREA, { baseY: 64, floorY: 67 });
    assert.equal(snow.ok, true);
    assert.deepEqual(snow.byClass, { snow: 49 });
    assert.equal(snow.counts.anchors, 49, "snow has one anchor block");
    assert.deepEqual(snow.byClass, { snow: 49 });
});

test("a player block inside the ground within the cave depth refuses footing before any ops are planned", () => {
    const columns = footprint((x, z) => column(64, "minecraft:grass_block", x === 1 && z === 1 ? { 62: "minecraft:chest" } : {}));
    const plan = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    assert.equal(plan.ok, false);
    assert.equal(plan.ops.length, 0);
    assert.match(plan.problems.join(" "), /minecraft:chest at y=62 is inside the ground/);
});

test("no readable ground in the footprint: planning fails and says so", () => {
    const plan = planSurfaceFooting(footprint(() => [{ y: 64, id: AIR }]), AREA, { floorY: 67 });
    assert.equal(plan.ok, false);
    assert.match(plan.problems.join(" "), /no natural ground/);
});

test("a footprint cell that was never scanned refuses", () => {
    const columns = footprint(() => column(64)).filter((c) => !(c.x === 0 && c.z === 0));
    const plan = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    assert.equal(plan.ok, false);
    assert.match(plan.problems.join(" "), /\(0, 0\) was not scanned/);
});

test("requiredFootingDepth agrees with the plan's required depth for every natural class", () => {
    const cases = [
        ["minecraft:grass_block", 64, 0],
        ["minecraft:sand", 64, 2],
        ["minecraft:mud", 64, 1],
        ["minecraft:gravel", 64, 2],
        ["minecraft:stone", 64, 0],
    ];
    for (const [id, ground, anchor] of cases) {
        const need = requiredFootingDepth(id, 67, ground);
        const plan = planSurfaceFooting(footprint(() => column(ground, id)), AREA, { baseY: ground, floorY: 67 });
        assert.equal(plan.ok, true, id);
        assert.equal(need.anchor, anchor, id);
        assert.equal(plan.counts.maxRequired, need.required, id);
    }
});

test("planning is deterministic and does not mutate its input", () => {
    const columns = footprint((x, z) => column(64 + (x % 2), "minecraft:sand"));
    const before = JSON.stringify(columns);
    const a = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    const b = planSurfaceFooting(columns, AREA, { baseY: 64, floorY: 67 });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(columns), before);
});
