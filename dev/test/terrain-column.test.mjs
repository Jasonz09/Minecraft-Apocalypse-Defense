import assert from "node:assert/strict";
import test from "node:test";
import { load, scan } from "../lib/civharness.mjs";
import { isNaturalGround } from "../../CivilizationApocalypse_BP/scripts/structures/terrain.js";
const { readColumn } = await load("integration", "terrainScan.js");

function column({ top = 51, cover = () => "minecraft:water", unread = () => false } = {}) {
    let reads = 0;
    const block = (y) => ({ location: { x: -408, y, z: -808 }, isValid: true, typeId: y > 62 ? "minecraft:air" : y > 51 ? cover(y) : y === 51 ? "minecraft:sand" : "minecraft:stone" });
    return {
        get reads() { return reads; },
        dimension: {
            id: "minecraft:overworld", heightRange: { min: -64, max: 320 },
            getTopmostBlock() { reads += 1; return block(top); },
            getBlock({ y }) { reads += 1; return unread(y) ? undefined : block(y); },
        },
    };
}

test("LIVE REPRODUCTION: solid-only topmost sand at 51 still finds water through 62 and the real bed", () => {
    const fixture = column();
    const info = readColumn(fixture.dimension, -408, -808, { bed: true });
    assert.deepEqual(scan.cellFromColumn(info), { g: 51, k: "water", tree: false, surface: 62 });
    assert.ok(fixture.reads <= 194);
    const waterTop = column({ top: 62 });
    assert.deepEqual(readColumn(waterTop.dimension, -408, -808, { bed: true }), info, "both engine heightmap behaviors agree");
});

test("aquatic cover at the water surface cannot hide water or lower its measured surface", () => {
    for (const plant of ["minecraft:kelp", "minecraft:seagrass", "minecraft:bubble_column"]) {
        const fixture = column({ cover: () => plant });
        assert.deepEqual(scan.cellFromColumn(readColumn(fixture.dimension, -408, -808, { bed: true })), { g: 51, k: "water", tree: false, surface: 62 }, plant);
    }
});

test("LIVE REPRODUCTION: exposed smooth basalt supports a pier without becoming replaceable terrain", () => {
    let reads = 0;
    const block = (y) => ({ location: { x: -171, y, z: -797 }, typeId: y > 62 ? "minecraft:air" : y > 25 ? "minecraft:water" : "minecraft:smooth_basalt" });
    const dimension = {
        heightRange: { min: -64, max: 320 },
        getTopmostBlock: () => { reads += 1; return block(25); },
        getBlock: ({ y }) => { reads += 1; return block(y); },
    };
    assert.deepEqual(scan.cellFromColumn(readColumn(dimension, -171, -797, { bed: true })), { g: 25, k: "water", tree: false, surface: 62 });
    assert.ok(reads <= 194);
    assert.equal(isNaturalGround("minecraft:smooth_basalt"), false, "support permission never grants clearing permission");
    const dry = { ...dimension, getBlock: ({ y }) => ({ ...block(y), typeId: y > 25 ? "minecraft:air" : "minecraft:smooth_basalt" }) };
    assert.equal(scan.cellFromColumn(readColumn(dry, -171, -797, { bed: true })).k, "blocked");
});

test("unreadable upward checks and an unverified tall column remain unknown within the read budget", () => {
    const blind = column({ unread: (y) => y === 52 });
    assert.equal(readColumn(blind.dimension, -408, -808, { bed: true }), undefined);
    let reads = 0;
    const endless = {
        getTopmostBlock: () => ({ location: { y: 0 } }),
        getBlock: () => { reads += 1; return { typeId: "minecraft:water" }; },
    };
    assert.equal(readColumn(endless, 0, 0, { bed: true }), undefined);
    assert.equal(reads, 96);
});

test("known underwater structures are protected blocked cells, never invented beds or unread chunks", () => {
    const fixture = column({ cover: (y) => y === 52 ? "minecraft:chest" : "minecraft:water" });
    const info = readColumn(fixture.dimension, -408, -808, { bed: true });
    assert.equal(info.bed, undefined);
    assert.deepEqual(scan.cellFromColumn(info), { g: 52, k: "blocked", tree: false });
    const dry = column({ cover: () => "minecraft:air" });
    assert.equal(scan.cellFromColumn(readColumn(dry.dimension, -408, -808, { bed: true })).k, "land");
});

test("LIVE REPRODUCTION: submerged stone brickwork is measured and protected from construction", () => {
    const block = (y) => ({ location: { x: -139, y, z: -837 }, typeId: y > 62 ? "minecraft:air" : y > 53 ? (y < 60 ? "minecraft:kelp" : "minecraft:water") : "minecraft:chiseled_stone_bricks" });
    const dimension = { getTopmostBlock: () => block(53), getBlock: ({ y }) => block(y) };
    const info = readColumn(dimension, -139, -837, { bed: true });
    assert.equal(info.surface, 62);
    assert.equal(info.bed, undefined);
    assert.deepEqual(scan.cellFromColumn(info), { g: 53, k: "blocked", tree: false });
    assert.match(info.problem, /chiseled_stone_bricks at y=53 is not natural terrain/);
});

test("a known world-height boundary does not probe outside the dimension", () => {
    const dim = {
        heightRange: { min: -64, max: 320 },
        getTopmostBlock: () => ({ location: { y: 319 } }),
        getBlock: ({ y }) => { assert.ok(y < 320); return { typeId: "minecraft:stone" }; },
    };
    assert.equal(readColumn(dim, 0, 0).ground, 319);
});
