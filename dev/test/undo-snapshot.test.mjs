// Snapshot-tile planner (the alternative to the journal, see docs/UNDO_DESIGN.md): tiles cover the region exactly,
// never overlap, never exceed 64 chunks, and are deterministic.
import assert from "node:assert/strict";
import test from "node:test";
import { planSnapshotTiles } from "../../CivilizationApocalypse_BP/scripts/civ/undo.js";

/** Every block column of a region, as a key, for exact coverage checks. */
function columnsOf(region) {
    const out = new Set();
    for (let x = region.x0; x <= region.x1; x += 1) for (let z = region.z0; z <= region.z1; z += 1) out.add(`${x},${z}`);
    return out;
}

test("a 49 x 49 district footprint is one snapshot tile of 16 chunks", () => {
    const plan = planSnapshotTiles({ x0: 0, z0: 0, x1: 48, z1: 48 });
    assert.equal(plan.ok, true);
    assert.equal(plan.tiles.length, 1);
    assert.equal(plan.tiles[0].chunks, 16);
    assert.deepEqual(plan.tiles[0], { x0: 0, z0: 0, x1: 48, z1: 48, chunks: 16 });
});

test("default tiles are 8 x 8 chunks (64 chunks, 128 blocks) and cover a large region exactly once", () => {
    const region = { x0: -137, z0: 20, x1: 301, z1: 290 };
    const plan = planSnapshotTiles(region);
    assert.equal(plan.ok, true);
    assert.equal(plan.edgeChunks, 8);
    assert.ok(plan.tiles.every((t) => t.chunks <= 64), "no tile exceeds 64 chunks");

    const seen = new Set();
    let blocks = 0;
    for (const t of plan.tiles) {
        assert.ok(t.x0 >= region.x0 && t.x1 <= region.x1 && t.z0 >= region.z0 && t.z1 <= region.z1, "tile lies inside the region");
        for (let x = t.x0; x <= t.x1; x += 1) {
            for (let z = t.z0; z <= t.z1; z += 1) {
                const k = `${x},${z}`;
                assert.equal(seen.has(k), false, `column ${k} is covered twice`);
                seen.add(k);
                blocks += 1;
            }
        }
    }
    assert.equal(blocks, (region.x1 - region.x0 + 1) * (region.z1 - region.z0 + 1));
    assert.deepEqual(seen, columnsOf(region));
});

test("maxChunks bounds the tile size for any budget", () => {
    for (const maxChunks of [1, 4, 9, 16, 50, 64, 100]) {
        const plan = planSnapshotTiles({ x0: 3, z0: -40, x1: 250, z1: 77 }, { maxChunks });
        assert.equal(plan.ok, true, `maxChunks ${String(maxChunks)}`);
        assert.ok(plan.tiles.every((t) => t.chunks <= maxChunks), `maxChunks ${String(maxChunks)} is respected`);
        assert.ok(plan.edgeChunks * plan.edgeChunks <= maxChunks);
    }
});

test("negative coordinates use chunk boundaries correctly (floor, not truncation)", () => {
    const plan = planSnapshotTiles({ x0: -1, z0: -17, x1: 0, z1: -16 });
    assert.equal(plan.ok, true);
    assert.equal(plan.tiles.length, 1);
    // x -1 is chunk -1, x 0 is chunk 0; z -17 is chunk -2, z -16 is chunk -1: four chunks in all.
    assert.equal(plan.tiles[0].chunks, 4);
    assert.deepEqual(plan.tiles[0], { x0: -1, z0: -17, x1: 0, z1: -16, chunks: 4 });
});

test("deterministic: the same region gives the same tiles in the same order", () => {
    const a = planSnapshotTiles({ x0: 0, z0: 0, x1: 500, z1: 300 });
    const b = planSnapshotTiles({ x0: 0, z0: 0, x1: 500, z1: 300 });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("invalid input is refused with reasons and no tiles", () => {
    assert.equal(planSnapshotTiles({ x0: 5, z0: 0, x1: 4, z1: 9 }).ok, false);
    assert.equal(planSnapshotTiles({ x0: 0, z0: 0, x1: 9, z1: 9 }, { maxChunks: 0 }).ok, false);
    assert.equal(planSnapshotTiles({ x0: 0, z0: 0, x1: 9, z1: 9 }, { maxChunks: 5000 }).ok, false);
    assert.equal(planSnapshotTiles({ x0: 0.5, z0: 0, x1: 9, z1: 9 }).ok, false);
    const bad = planSnapshotTiles({ x0: 5, z0: 0, x1: 4, z1: 9 });
    assert.equal(bad.tiles.length, 0);
    assert.ok(bad.problems.length > 0);
});
