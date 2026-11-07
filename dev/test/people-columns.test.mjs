// people/columns.js: where a built district's people can actually stand.
//
// The live finding behind this file: a `civ:generate` record stores only X/Z, `hq` is a building footprint and
// `centre` can be a built-up point too, so "topmost block + 1" put the whole kingdom on roofs and wall tops -
// visible in the save, invisible to a player walking the street. `standableNear` samples the ground around the
// plan point and takes the lowest open surface as street level.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { standableNear, surfaceAtOf } = await import(pathToFileURL(join(projectRoot, "CivilizationApocalypse_BP", "scripts", "people", "columns.js")).href);

/**
 * A dimension whose top surface is `height(x, z)`; a column whose height is `undefined` is unloaded ground.
 * Blocks above the top are air, everything at or below it is solid.
 * @param {(x: number, z: number) => number | undefined} height
 * @param {(x: number, z: number) => string} [topId]
 */
function ground(height, topId = () => "minecraft:grass_block") {
    return {
        getTopmostBlock({ x, z }) {
            const y = height(x, z);
            if (y === undefined) {
                throw new Error("LocationInUnloadedChunkError: not in a chunk currently loaded and ticking");
            }
            return { location: { x, y, z }, typeId: topId(x, z) };
        },
        getBlock({ x, y, z }) {
            const top = height(x, z);
            if (top === undefined) {
                throw new Error("LocationInUnloadedChunkError: not in a chunk currently loaded and ticking");
            }
            return { typeId: y > top ? "minecraft:air" : "minecraft:stone" };
        },
    };
}

/**
 * A jungle column: leaves from `canopy` up to `top`, air down to the forest floor at `ground`, then solid.
 * `top` is what `getTopmostBlock` answers, which is exactly what the live jungle reported.
 * @param {{ ground: number, canopy: number, top: number }} layers
 * @param {(x: number, z: number) => number} [floor] per-column ground, for uneven terrain
 */
function jungle(layers, floor = () => layers.ground) {
    return {
        getTopmostBlock({ x, z }) {
            return { location: { x, y: layers.top, z }, typeId: "minecraft:jungle_leaves" };
        },
        getBlock({ x, y, z }) {
            const ground = floor(x, z);
            if (y > layers.top) return { typeId: "minecraft:air" };
            if (y >= Math.min(layers.canopy, layers.top)) return { typeId: "minecraft:jungle_leaves" };
            if (y > ground) return { typeId: "minecraft:air" };
            return { typeId: "minecraft:grass_block" };
        },
    };
}

test("a roof over the plan point does not become the street: the lowest open ground nearby wins", () => {
    // The centre is a building at 90; eight blocks out the ground is 70.
    const height = (x, z) => (Math.abs(x) <= 4 && Math.abs(z) <= 4 ? 90 : 70);
    const spot = standableNear(ground(height), 0, 0, { radius: 24 });
    assert.ok(spot, "a spot was found");
    assert.equal(spot.y, 71, "the standing Y is ground + 1, not the roof + 1");
    assert.ok(Math.hypot(spot.x, spot.z) >= 4, `the spot is off the building, got ${String(spot.x)},${String(spot.z)}`);
    assert.ok(Math.hypot(spot.x, spot.z) <= 24, "and inside the searched disc");
});

test("a tree crown is never chosen while there is ground to stand on", () => {
    const height = (x, z) => (x === 4 && z === 0 ? 78 : 70);
    const topId = (x, z) => (x === 4 && z === 0 ? "minecraft:jungle_leaves" : "minecraft:grass_block");
    const spot = standableNear(ground(height, topId), 0, 0, { radius: 8 });
    assert.ok(spot, "a spot was found");
    assert.equal(spot.y, 71, "the canopy at 78 was passed over for the ground at 70");
    assert.notDeepEqual([spot.x, spot.z], [4, 0], "the leaves column is not the home");
});

test("a column with no headroom is not standable", () => {
    const dimension = ground(() => 70);
    const original = dimension.getBlock;
    dimension.getBlock = ({ x, y, z }) => (y === 71 ? { typeId: "minecraft:stone" } : original({ x, y, z }));
    // Every column is capped at 71, so nothing has two blocks of air; the search refuses rather than guessing.
    assert.equal(standableNear(dimension, 0, 0, { radius: 8 }), undefined);
});

test("unloaded ground answers undefined, and never a invented height", () => {
    assert.equal(standableNear(ground(() => undefined), 0, 0), undefined);
    assert.equal(surfaceAtOf(ground(() => undefined))(0, 0), undefined);
});

test("a canopy column resolves to the forest floor under it, not the leaves", () => {
    // Leaves at 80, twelve blocks of leaf and air below, forest floor at 68 - the live jungle's shape.
    const spot = standableNear(jungle({ ground: 68, canopy: 77, top: 80 }), 0, 0, { radius: 8 });
    assert.ok(spot, "the column under the crown is standable after all");
    assert.equal(spot.y, 69, "the standing Y is the floor + 1, not the crown + 1");
    assert.deepEqual([spot.x, spot.z], [0, 0], "the plan point itself is the nearest floor");
});

test("a canopy with no ground inside the descent budget is no home, not a guess", () => {
    // Leaves at 200, air all the way down to a floor at 0: far outside MAX_DESCENT.
    assert.equal(standableNear(jungle({ ground: 0, canopy: 200, top: 200 }), 0, 0, { radius: 8 }), undefined);
});

test("a column sealed inside a solid mass has no standable ground", () => {
    const solid = {
        getTopmostBlock({ x, z }) {
            return { location: { x, y: 100, z }, typeId: "minecraft:stone" };
        },
        getBlock({ x, y, z }) {
            return { typeId: "minecraft:stone" };
        },
    };
    assert.equal(standableNear(solid, 0, 0, { radius: 8 }), undefined, "no open headroom anywhere is no street");
});

test("a block probe that throws in an unloaded chunk answers undefined, never an exception", () => {
    const released = {
        getTopmostBlock({ x, z }) {
            return { location: { x, y: 80, z }, typeId: "minecraft:jungle_leaves" };
        },
        getBlock() {
            throw new Error("LocationInUnloadedChunkError: not in a chunk currently loaded and ticking");
        },
    };
    assert.doesNotThrow(() => standableNear(released, 0, 0, { radius: 8 }), "a released chunk must not take the hour down");
    assert.equal(standableNear(released, 0, 0, { radius: 8 }), undefined, "unreadable ground is no home");
});

test("a flat plane answers the plan point itself", () => {
    const spot = standableNear(ground(() => 64), 10, -10);
    assert.deepEqual(spot, { x: 10, y: 65, z: -10 }, "nothing better nearby, so the nearest column is the point");
});
