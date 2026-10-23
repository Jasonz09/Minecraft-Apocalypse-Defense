import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { classifyWater, WATER_DEFAULTS } = await load("civ", "environments.js");
const { planBridge } = await load("civ", "foundations.js");

const AIR = "minecraft:air";
const GRASS = "minecraft:grass_block";
const DIRT = "minecraft:dirt";
const WATER = "minecraft:water";
const AREA = { x0: 0, z0: 0, x1: 6, z1: 6 };

/** Dry bank: grass at surfaceY, air above, dirt and stone below. */
function dry(surfaceY = 64) {
    const cells = [];
    for (let y = surfaceY + 3; y > surfaceY; y -= 1) cells.push({ y, id: AIR });
    cells.push({ y: surfaceY, id: GRASS });
    for (let y = surfaceY - 1; y >= surfaceY - 8; y -= 1) cells.push({ y, id: y >= surfaceY - 3 ? DIRT : "minecraft:stone" });
    return cells;
}

/** Water: surface at waterY over a bed (dirt) at bedY. */
function wet(bedY = 62, waterY = 63) {
    const cells = [];
    for (let y = bedY + 3; y > waterY; y -= 1) cells.push({ y, id: AIR });
    cells.push({ y: waterY, id: WATER });
    for (let y = bedY; y >= bedY - 8; y -= 1) cells.push({ y, id: y === bedY ? DIRT : y >= bedY - 3 ? DIRT : "minecraft:stone" });
    return cells;
}

/** Columns for the footprint plus a 3-block water margin; make(x, z) returns the cells. */
function grid(make, margin = WATER_DEFAULTS.margin, area = AREA) {
    const columns = [];
    for (let z = area.z0 - margin; z <= area.z1 + margin; z += 1) {
        for (let x = area.x0 - margin; x <= area.x1 + margin; x += 1) columns.push({ x, z, cells: make(x, z) });
    }
    return columns;
}

/** A 1-wide (or wider) stream along x on the rows listed, from x0 to x1, with dry banks. */
const streamAlongX = (rows, x0 = -2, x1 = 8, bed = 62, water = 63) => (x, z) => (rows.includes(z) && x >= x0 && x <= x1 ? wet(bed, water) : dry(64));
/** A stream along z on the columns listed (x fixed), from z0 to z1. */
const streamAlongZ = (cols, z0 = -2, z1 = 8, bed = 62, water = 63) => (x, z) => (cols.includes(x) && z >= z0 && z <= z1 ? wet(bed, water) : dry(64));

test("the default policy refuses narrow water inside the footprint", () => {
    const result = classifyWater(grid(streamAlongX([3])), AREA);
    assert.equal(result.decision, "refuse");
    assert.match(result.reasons.join(" "), /narrow water of 9x1 inside the footprint at \(\d+, 3\) \(policy: refuse\)/);
    assert.deepEqual(result.bridges, []);
    assert.equal(result.bodies.length, 1);
    assert.equal(result.bodies[0].kind, "narrow");
});

test("a 1-wide stream under the bridge policy gets a straight crossing for every footprint cell, planned by planBridge", () => {
    const result = classifyWater(grid(streamAlongX([3])), AREA, { footprintWater: "bridge" });
    assert.equal(result.decision, "bridge");
    assert.equal(result.reasons.length, 0);
    assert.equal(result.bridges.length, 7, "one crossing per footprint column along the stream");
    for (const bridge of result.bridges) {
        assert.equal(bridge.axis, "z");
        assert.equal(bridge.width, 1);
        assert.equal(bridge.from.z, 2);
        assert.equal(bridge.to.z, 4);
        assert.equal(bridge.deckY, 64);
        assert.ok(bridge.ops.some((op) => op.kind === "deck"));
        assert.deepEqual(bridge.ops, planBridge([{ x: bridge.from.x, z: 2, g: 64 }, { x: bridge.from.x, z: 3, g: 62, water: 63 }, { x: bridge.from.x, z: 4, g: 64 }]).ops);
    }
});

test("a 2-wide stream is bridged across its width; a 3-wide one is still narrow", () => {
    const two = classifyWater(grid(streamAlongX([3, 4])), AREA, { footprintWater: "bridge" });
    assert.equal(two.decision, "bridge");
    assert.ok(two.bridges.every((b) => b.axis === "z" && b.width === 2));
    const three = classifyWater(grid(streamAlongX([2, 3, 4])), AREA, { footprintWater: "bridge" });
    assert.equal(three.decision, "bridge");
    assert.ok(three.bridges.every((b) => b.width === 3));
});

test("a 4-wide stream is not narrow: it is wide water and refuses under any policy", () => {
    for (const footprintWater of ["refuse", "bridge"]) {
        const result = classifyWater(grid(streamAlongX([2, 3, 4, 5])), AREA, { footprintWater });
        assert.equal(result.decision, "refuse", footprintWater);
        assert.match(result.reasons.join(" "), /wide water \(lake or river\) of \d+x\d+ inside the footprint/);
    }
});

test("a lake whose edge touches the footprint's ring refuses, even though the footprint itself is dry", () => {
    const lake = (x, z) => (x <= -1 ? wet(62, 63) : dry(64));
    const result = classifyWater(grid(lake), AREA, { footprintWater: "bridge" });
    assert.equal(result.decision, "refuse");
    assert.match(result.reasons.join(" "), /wide water \(lake or river\) of \d+x\d+ touches the footprint at \(-1, -?\d+\)/);
});

test("a narrow pond in the ring only is allowed and noted, not bridged", () => {
    const pond = (x, z) => (x === 7 && z >= 1 && z <= 3 ? wet(62, 63) : dry(64));
    const result = classifyWater(grid(pond), AREA);
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.bridges, []);
    assert.match(result.notes.join(" "), /narrow water of 1x3 beside the footprint at \(7, 1\)/);
});

test("water well outside the footprint's one-block ring is ignored", () => {
    const far = (x, z) => (x >= 10 && x <= 13 && z >= 0 && z <= 6 ? wet(62, 63) : dry(64));
    const result = classifyWater(grid(far, 6), AREA, { margin: 6 });
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.bodies, []);
});

test("a crossing whose banks differ by more than the bridge limit (3) has no candidate, so bridging refuses", () => {
    const cliff = (x, z) => (z === 3 && x >= -2 && x <= 8 ? wet(62, 63) : z === 4 ? dry(70) : dry(64));
    const result = classifyWater(grid(cliff), AREA, { footprintWater: "bridge" });
    assert.equal(result.decision, "refuse");
    assert.match(result.reasons.join(" "), /narrow water at \(\d+, 3\) has no straight crossing of 3 blocks or less that planBridge accepts/);
});

test("a bank 3 higher than the other side is within the bridge limit; the deck sits at the higher bank", () => {
    const step = (x, z) => (z === 3 && x >= -2 && x <= 8 ? wet(62, 63) : z === 4 ? dry(67) : dry(64));
    const result = classifyWater(grid(step), AREA, { footprintWater: "bridge" });
    assert.equal(result.decision, "bridge");
    assert.ok(result.bridges.every((b) => b.deckY === 67));
});

test("a stream along z is crossed along x", () => {
    const result = classifyWater(grid(streamAlongZ([3])), AREA, { footprintWater: "bridge" });
    assert.equal(result.decision, "bridge");
    assert.ok(result.bridges.length > 0);
    assert.ok(result.bridges.every((b) => b.axis === "x" && b.from.x === 2 && b.to.x === 4));
});

test("a stream that runs past the margin is judged by its width where it meets the site", () => {
    const longStream = (x, z) => (z === 3 ? wet(62, 63) : dry(64));
    const result = classifyWater(grid(longStream), AREA, { footprintWater: "bridge", margin: 3 });
    assert.equal(result.decision, "bridge");
    assert.ok(result.bridges.length > 0);
});

test("the deep narrow channel still gets a crossing: a 1-wide run needs no pillar", () => {
    const deep = (x, z) => (z === 3 && x >= -2 && x <= 8 ? wet(50, 51) : dry(64));
    const result = classifyWater(grid(deep), AREA, { footprintWater: "bridge" });
    assert.equal(result.decision, "bridge");
    assert.ok(result.bridges.every((b) => b.pillars.length === 0));
});

test("without water in the footprint nothing is bridged and the decision is allow", () => {
    const result = classifyWater(grid(() => dry(64)), AREA, { footprintWater: "bridge" });
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.bridges, []);
    assert.deepEqual(result.bodies, []);
});

test("water with no bed (open water to the bottom of the scan) refuses when it touches the footprint", () => {
    const ocean = (x, z) => (x <= 0 ? [{ y: 63, id: WATER }, { y: 62, id: WATER }] : dry(64));
    const result = classifyWater(grid(ocean), AREA);
    assert.equal(result.decision, "refuse");
    assert.match(result.reasons.join(" "), /wide water/);
});

test("classification is deterministic and does not mutate its input", () => {
    const columns = grid(streamAlongX([3]));
    const before = JSON.stringify(columns);
    const a = classifyWater(columns, AREA, { footprintWater: "bridge" });
    const b = classifyWater(columns, AREA, { footprintWater: "bridge" });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(columns), before);
});
