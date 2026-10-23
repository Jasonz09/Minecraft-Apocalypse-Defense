import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { analyseCaves, readStack, assessSite, CAVE_DEFAULTS, CAVE_WEIGHTS } = await load("civ", "environments.js");

const AIR = "minecraft:air";
const GRASS = "minecraft:grass_block";
const STONE = "minecraft:stone";
const DIRT = "minecraft:dirt";

/**
 * A column from the sky down to y = bottom. `overrides` maps y to an id (e.g. a void or sand).
 * The surface is grass at surfaceY; dirt for three blocks below, stone to the bottom.
 */
function column(surfaceY, overrides = {}, bottom = surfaceY - 16, surfaceId = GRASS) {
    const cells = [];
    for (let y = surfaceY + 3; y >= bottom; y -= 1) {
        if (y in overrides) cells.push({ y, id: overrides[y] });
        else if (y > surfaceY) cells.push({ y, id: AIR });
        else if (y === surfaceY) cells.push({ y, id: surfaceId });
        else cells.push({ y, id: y >= surfaceY - 3 ? DIRT : STONE });
    }
    return cells;
}

const stackOf = (cells) => readStack(cells, { depth: CAVE_DEFAULTS.depth });

test("a solid column has no cave flags and no score", () => {
    const result = analyseCaves(stackOf(column(64)), { platformY: 64 });
    assert.deepEqual(result.flags, []);
    assert.equal(result.score, 0);
    assert.equal(result.hard, false);
    assert.equal(result.roof, undefined);
});

test("the weights are the documented ones", () => {
    assert.deepEqual(CAVE_WEIGHTS, { hollow: 3, breach: 6, mouth: 4, "thin-roof": 1, "gravity-roof": 2 });
    assert.deepEqual(CAVE_DEFAULTS, { depth: 8, roofWindow: 12, roofMax: 3, pitDepth: 2, scoreLimit: 10 });
});

test("a void 3 below a level platform is hollow: hard, score 3, with the void's height", () => {
    const result = analyseCaves(stackOf(column(64, { 61: AIR })), { platformY: 64 });
    assert.ok(result.flags.includes("hollow"));
    assert.equal(result.hard, true);
    assert.ok(result.score >= 3);
    assert.match(result.reasons.join(" "), /minecraft:air void at y=61, within 8 blocks below the platform at y=64/);
});

test("a void 9 below the platform is outside the hollow band (8), so it is not hollow", () => {
    const result = analyseCaves(stackOf(column(64, { 55: AIR })), { platformY: 64 });
    assert.equal(result.flags.includes("hollow"), false);
    assert.equal(result.hard, false);
});

test("a void 8 below the platform is still inside the band", () => {
    const result = analyseCaves(stackOf(column(64, { 56: AIR })), { platformY: 64 });
    assert.ok(result.flags.includes("hollow"));
});

test("water in a flooded cave under the platform is a hollow void too", () => {
    const result = analyseCaves(stackOf(column(64, { 60: "minecraft:water" })), { platformY: 64 });
    assert.ok(result.flags.includes("hollow"));
    assert.equal(result.hard, true);
});

test("cutting from the surface down to the platform opens a breach when a void sits in the cut", () => {
    const result = analyseCaves(stackOf(column(70, { 68: AIR })), { platformY: 66 });
    assert.ok(result.flags.includes("breach"));
    assert.equal(result.hard, true);
    assert.match(result.reasons.join(" "), /cutting from y=70 down to y=66 would open a void at y=68/);
});

test("a cut that stays above the void is not a breach", () => {
    const result = analyseCaves(stackOf(column(70, { 60: AIR })), { platformY: 66 });
    assert.equal(result.flags.includes("breach"), false);
    assert.ok(result.flags.includes("hollow"), "the void is 6 below the platform, so it is hollow");
});

test("a pit whose surface is 2 below the median and opens onto a void is a mouth (hard)", () => {
    const result = analyseCaves(stackOf(column(62, { 61: AIR })), { platformY: 64, medianSurface: 64, pitDepth: 2 });
    assert.ok(result.flags.includes("mouth"));
    assert.ok(result.flags.includes("hollow"));
    assert.equal(result.hard, true);
    // the void is directly under the surface, so the roof is 0 and the thin roof adds 1 as well
    assert.ok(result.flags.includes("thin-roof"));
    assert.equal(result.score, CAVE_WEIGHTS.hollow + CAVE_WEIGHTS.mouth + CAVE_WEIGHTS["thin-roof"]);
});

test("a shallow dip (1 below the median) is not a mouth", () => {
    const result = analyseCaves(stackOf(column(63, { 62: AIR })), { platformY: 64, medianSurface: 64, pitDepth: 2 });
    assert.equal(result.flags.includes("mouth"), false);
});

test("the roof detector: a void 10 below a sand surface is a gravity roof (score 2), not hard", () => {
    const cells = column(64, { 54: AIR }, 40, "minecraft:sand");
    const result = analyseCaves(stackOf(cells), { platformY: 64 });
    assert.deepEqual(result.flags, ["gravity-roof"]);
    assert.equal(result.roof, 9);
    assert.equal(result.score, 2);
    assert.equal(result.hard, false);
});

test("the roof detector: gravel inside a roof 9 thick is a gravity roof, the same void in grass is not", () => {
    const withGravel = column(64, { 54: AIR }, 40, GRASS).map((c) => (c.y === 62 ? { y: 62, id: "minecraft:gravel" } : c));
    assert.deepEqual(analyseCaves(stackOf(withGravel), { platformY: 64 }).flags, ["gravity-roof"]);
    assert.deepEqual(analyseCaves(stackOf(column(64, { 54: AIR }, 40, GRASS)), { platformY: 64 }).flags, []);
});

test("the roof detector: a thin roof (3 or less) over a void adds 1 and is reported with its thickness", () => {
    const cells = column(64, { 60: AIR }, 40, GRASS);
    const result = analyseCaves(stackOf(cells), { platformY: 64 });
    assert.ok(result.flags.includes("thin-roof"));
    assert.equal(result.roof, 3);
    assert.match(result.reasons.join(" "), /roof of 3 solid block\(s\) over a void at y=60/);
});

test("a sand surface over a void within the roof window is a gravity roof even with no sand in between", () => {
    const cells = column(64, { 58: AIR }, 40, "minecraft:sand");
    const result = analyseCaves(stackOf(cells), { platformY: 64 });
    assert.ok(result.flags.includes("gravity-roof"));
});

test("sand or gravel above a void counts as a gravity roof only when the void is in the roof window", () => {
    const cells = column(64, { 54: AIR }, 40, GRASS);
    cells[cells.findIndex((c) => c.y === 62)] = { y: 62, id: "minecraft:gravel" };
    const result = analyseCaves(stackOf(cells), { platformY: 64 });
    assert.ok(result.flags.includes("gravity-roof"), "gravel at y=62 is inside the roof of the void at y=54");
    const far = analyseCaves(stackOf(column(64, { 40: AIR }, 30, GRASS)), { platformY: 64 });
    assert.equal(far.flags.length, 0, "a void 24 below is outside the roof window");
    assert.equal(far.voidCells, 0);
});

test("a column with no natural ground is hard and says why", () => {
    const result = analyseCaves(stackOf([{ y: 65, id: AIR }, { y: 64, id: AIR }]), { platformY: 64 });
    assert.equal(result.hard, true);
    assert.deepEqual(result.flags, ["no-surface"]);
});

test("voids above the surface are sky, not caves", () => {
    const result = analyseCaves(stackOf(column(64)), { platformY: 60 });
    assert.deepEqual(result.flags, []);
});

/** Columns for the footprint plus a 12-block margin (the village radius), built by make(x, z). */
function grid(area, make, margin = 12) {
    const columns = [];
    for (let z = area.z0 - margin; z <= area.z1 + margin; z += 1) {
        for (let x = area.x0 - margin; x <= area.x1 + margin; x += 1) columns.push({ x, z, cells: make(x, z) });
    }
    return columns;
}

test("assessSite: a void under the footprint refuses with the column and the void height", () => {
    const area = { x0: 0, z0: 0, x1: 4, z1: 4 };
    const columns = grid(area, (x, z) => column(64, x === 2 && z === 2 ? { 61: AIR } : {}));
    const result = assessSite(columns, area);
    assert.equal(result.decision, "refuse");
    assert.equal(result.caves.hollow, 1);
    assert.match(result.reasons.join(" "), /cave: 1 footprint column\(s\) are hollow, breach or a pit/);
    assert.match(result.reasons.join(" "), /\(2, 2\): minecraft:air void at y=61/);
});

test("assessSite: a cave only in the margin, outside the footprint, does not refuse the footprint", () => {
    const area = { x0: 0, z0: 0, x1: 4, z1: 4 };
    const columns = grid(area, (x, z) => column(64, x === -2 && z === 2 ? { 61: AIR } : {}));
    const result = assessSite(columns, area);
    assert.equal(result.decision, "allow");
    assert.equal(result.caves.hollow, 0);
});

test("assessSite: the cave risk score refuses above the limit even when no column is hard", () => {
    const area = { x0: 0, z0: 0, x1: 4, z1: 4 };
    // a gravity roof over a void 10 below, in each of the 25 footprint columns: score 2 each = 50
    const columns = grid(area, (x, z) => {
        const inside = x >= 0 && x <= 4 && z >= 0 && z <= 4;
        return inside ? column(64, { 54: AIR }, 40, "minecraft:sand") : column(64);
    });
    const result = assessSite(columns, area, { maxAmbiguousTop: 25 });
    assert.equal(result.caves.hollow + result.caves.breach + result.caves.mouth, 0);
    assert.equal(result.caves.score, 50);
    assert.match(result.reasons.join(" "), /cave risk score 50 exceeds 10 \(thin roofs 0, gravity roofs 25\)/);
});
