// Undo safety predicate and cooperative planner: mutation cases on a realistic district, slice bounds,
// idempotence, determinism, bounds, unloaded chunks, and a restart in the middle of an undo.
import assert from "node:assert/strict";
import test from "node:test";
import { AIR, createJournal, createUndoStore, decideRestore, DECISIONS, loadJournal, planUndo, protectedFromPlan, recordWrite, saveJournal } from "../../CivilizationApocalypse_BP/scripts/civ/undo.js";
import { applyOps, buildDistrictJournal, DIM, fakeWorld, mutateDistrict, rng, runPlan } from "./undo-fixture.mjs";

const key = (e) => `${e.x},${e.y},${e.z}`;
const entry = (over = {}) => ({ x: 0, y: 64, z: 0, kind: "cut", prior: "minecraft:dirt", written: AIR, ...over });

test("decideRestore: every branch of the safety predicate", () => {
    const e = entry();
    assert.deepEqual(decideRestore(e, undefined, undefined), { decision: "skipped-unloaded" }, "unloaded is never guessed");
    assert.deepEqual(decideRestore(e, undefined, "minecraft:stone_bricks"), { decision: "skipped-unloaded" }, "unloaded wins over protection");
    assert.deepEqual(decideRestore(e, "minecraft:dirt", undefined), { decision: "already-restored" }, "already the prior id: nothing to write");
    assert.deepEqual(decideRestore(e, AIR, undefined), { decision: "restore", id: "minecraft:dirt" }, "still our written id: restore");
    assert.equal(decideRestore(e, "minecraft:oak_planks", undefined).decision, "skipped-changed", "a player placed a block");
    assert.equal(decideRestore(e, "minecraft:stone", undefined).decision, "skipped-changed", "a player replaced the ground");
    assert.equal(decideRestore(e, AIR, "minecraft:stone_bricks").decision, "skipped-protected", "wall cell: restoring would leave another state than the plan");
    assert.equal(decideRestore(e, AIR, null).decision, "skipped-protected", "two plan elements disagree on this cell");
    assert.deepEqual(decideRestore(e, AIR, "minecraft:dirt"), { decision: "restore", id: "minecraft:dirt" }, "plan cell already equals the prior id");
    assert.equal(decideRestore(e, "minecraft:dirt", "minecraft:stone_bricks").decision, "already-restored", "no write when nothing differs");
    for (const d of ["restore", "already-restored", "skipped-changed", "skipped-unloaded", "skipped-protected"]) assert.ok(DECISIONS.includes(d));
});

test("protectedFromPlan: one id per cell, conflicting ids become null", () => {
    const p = protectedFromPlan([
        { x: 1, y: 2, z: 3, id: "minecraft:stone_bricks" },
        { x: 1, y: 2, z: 3, id: "minecraft:stone_bricks" },
        { x: 4, y: 2, z: 3, id: "minecraft:stone_bricks" },
        { x: 4, y: 2, z: 3, id: "minecraft:cobblestone" },
    ]);
    assert.equal(p.get("1,2,3"), "minecraft:stone_bricks");
    assert.equal(p.get("4,2,3"), null);
});

test("mutations on a realistic district: every cell lands in exactly the category its history predicts", (t) => {
    const j = buildDistrictJournal().journal;
    const m = mutateDistrict(j, 3);
    const read = (x, y, z) => (m.unloadedKeys.has(`${x},${y},${z}`) ? undefined : m.live.get(`${x},${y},${z}`));
    const run = runPlan(j, read, { protect: m.protect });
    const c = run.summary.counts;
    const total = j.entries.size;
    t.diagnostic(`undo plan, realistic district with mutations: ${JSON.stringify({ total, ...c, opsInSlices: run.slices.length, maxSliceOps: Math.max(...run.slices.map((x) => x.ops)) })}`);
    assert.equal(c.total, total);
    assert.equal(c.skippedChanged, m.expected.changed, "player placed or removed blocks");
    assert.equal(c.alreadyRestored, m.expected.already, "already restored by hand");
    assert.equal(c.skippedUnloaded, m.expected.unloaded, "unloaded chunks");
    assert.equal(c.skippedProtected, m.expected.protected, "wall/gate cells");
    assert.equal(c.skippedOutside, 0);
    assert.equal(c.restored, total - m.expected.changed - m.expected.already - m.expected.unloaded - m.expected.protected);
    assert.equal(run.ops.length, c.restored);
    assert.equal(c.restored + c.alreadyRestored + c.skippedChanged + c.skippedUnloaded + c.skippedProtected + c.skippedOutside, total, "every entry is accounted for once");

    // The cells the test chose for each mutation kind are exactly where the planner put them.
    const opKeys = new Set(run.ops.map(key));
    for (const e of m.touched.placed) assert.equal(opKeys.has(key(e)), false, "a player's block on our cut is never restored");
    for (const e of m.touched.removed) assert.equal(opKeys.has(key(e)), false, "a cell a player broke is never restored");
    for (const e of m.touched.unloaded) assert.equal(opKeys.has(key(e)), false, "an unloaded cell is never guessed");
    for (const e of m.touched.protectedCells) assert.equal(opKeys.has(key(e)), false, "a wall cell is never restored to another state");
    for (const e of m.touched.sameAsPrior) assert.equal(opKeys.has(key(e)), true, "a plan cell already equal to the prior id may be restored");
    for (const op of run.ops) assert.equal(op.id, j.entries.get(key(op)).prior, "a restore writes exactly the prior id");

    // Apply what the builder would apply: the restored cells are back, everything else is untouched.
    const before = new Map(m.live);
    applyOps(m.live, run.ops);
    for (const e of j.entries.values()) {
        const k = key(e);
        if (opKeys.has(k)) assert.equal(m.live.get(k), e.prior, `${k} restored`);
        else assert.equal(m.live.get(k), before.get(k), `${k} untouched`);
    }
});

test("slices stay within the per-slice bounds, and the caps cannot be raised", () => {
    const j = buildDistrictJournal().journal;
    const m = mutateDistrict(j, 3);
    const read = (x, y, z) => (m.unloadedKeys.has(`${x},${y},${z}`) ? undefined : m.live.get(`${x},${y},${z}`));

    const dflt = runPlan(j, read, { protect: m.protect });
    assert.ok(dflt.slices.length >= 4, "a district of this size needs several slices");
    for (const s of dflt.slices) {
        assert.ok(s.ops <= 400, `slice of ${String(s.ops)} ops exceeds 400`);
        assert.ok(s.reads <= 1500, `slice of ${String(s.reads)} reads exceeds 1500`);
    }
    assert.equal(dflt.slices.reduce((n, s) => n + s.ops, 0), dflt.ops.length);

    const raised = runPlan(j, read, { protect: m.protect, maxOpsPerSlice: 100000, maxReadsPerSlice: 100000 });
    assert.ok(raised.slices.every((s) => s.ops <= 400 && s.reads <= 1500), "requested caps above the hard limits are clamped");
    assert.deepEqual(raised.ops, dflt.ops);

    const small = runPlan(j, read, { protect: m.protect, maxOpsPerSlice: 50 });
    assert.ok(small.slices.every((s) => s.ops <= 50));
    assert.ok(small.slices.length >= Math.ceil(small.ops.length / 50));
    assert.deepEqual(small.ops, dflt.ops, "slice size changes the pacing, never the result");

    const readCapped = runPlan(j, read, { protect: m.protect, maxReadsPerSlice: 200 });
    assert.ok(readCapped.slices.every((s) => s.reads <= 200));
    assert.deepEqual(readCapped.ops, dflt.ops);
});

test("undo twice is a no-op: the second plan has no ops and every restorable cell is already restored", () => {
    const j = buildDistrictJournal().journal;
    const m = mutateDistrict(j, 3);
    const read = (x, y, z) => (m.unloadedKeys.has(`${x},${y},${z}`) ? undefined : m.live.get(`${x},${y},${z}`));
    const first = runPlan(j, read, { protect: m.protect });
    applyOps(m.live, first.ops);
    const stateAfterFirst = new Map(m.live);

    const second = runPlan(j, read, { protect: m.protect });
    assert.equal(second.ops.length, 0, "no writes on the second undo");
    assert.ok(second.slices.every((s) => s.ops === 0), "read-only slices for pacing, no writes");
    assert.equal(second.summary.counts.restored, 0);
    assert.equal(second.summary.counts.alreadyRestored, first.summary.counts.restored + m.expected.already);
    assert.equal(second.summary.counts.skippedChanged, first.summary.counts.skippedChanged, "player edits are still reported, still not touched");
    assert.equal(second.summary.counts.skippedProtected, first.summary.counts.skippedProtected);
    assert.equal(second.summary.counts.skippedUnloaded, first.summary.counts.skippedUnloaded);
    assert.deepEqual(new Map(m.live), stateAfterFirst, "the world is byte-for-byte the same after the second undo");

    const third = runPlan(j, read, { protect: m.protect });
    assert.deepEqual(third.summary.counts, second.summary.counts);
});

test("determinism: identical inputs give identical ops, slices and summaries, whatever the insertion order", () => {
    const j = buildDistrictJournal().journal;
    const m = mutateDistrict(j, 3);
    const read = (x, y, z) => (m.unloadedKeys.has(`${x},${y},${z}`) ? undefined : m.live.get(`${x},${y},${z}`));
    const a = runPlan(j, read, { protect: m.protect });
    const b = runPlan(j, read, { protect: m.protect });
    assert.equal(JSON.stringify(a), JSON.stringify(b));

    const reordered = createJournal(DIM);
    const cells = [...j.entries.values()];
    const r = rng(7);
    for (let i = cells.length - 1; i > 0; i -= 1) {
        const k = Math.floor(r() * (i + 1));
        [cells[i], cells[k]] = [cells[k], cells[i]];
    }
    for (const e of cells) recordWrite(reordered, e);
    const c = runPlan(reordered, read, { protect: m.protect });
    assert.equal(JSON.stringify(c.ops), JSON.stringify(a.ops));
    assert.deepEqual(c.summary.counts, a.summary.counts);
});

test("ops are issued in the canonical order: removals top-down, ground bottom-up, then plants", () => {
    const j = buildDistrictJournal().journal;
    const run = runPlan(j, (x, y, z) => j.entries.get(`${x},${y},${z}`)?.written);
    const rank = (op) => (op.id === AIR ? 0 : op.kind === "clear" ? 2 : 1);
    for (let i = 1; i < run.ops.length; i += 1) {
        const a = run.ops[i - 1];
        const b = run.ops[i];
        assert.ok(rank(a) <= rank(b), `op ${String(i)} is out of rank order`);
        if (rank(a) === rank(b) && rank(a) === 0) assert.ok(a.y >= b.y, "removals go top-down");
        if (rank(a) === rank(b) && rank(a) === 1) assert.ok(a.y <= b.y, "ground restores go bottom-up");
    }
});

test("bounds: entries outside the allowed box are skipped without a read", () => {
    const j = buildDistrictJournal().journal;
    let reads = 0;
    const read = (x, y, z) => {
        reads += 1;
        return j.entries.get(`${x},${y},${z}`)?.written;
    };
    const xs = [...j.entries.values()].map((e) => e.x);
    const midX = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
    const bounds = { minX: Math.min(...xs), maxX: midX, minY: -64, maxY: 319, minZ: -Infinity, maxZ: Infinity };
    const run = runPlan(j, read, { bounds });
    const outside = [...j.entries.values()].filter((e) => e.x > midX).length;
    assert.equal(run.summary.counts.skippedOutside, outside);
    assert.equal(reads, j.entries.size - outside, "no read for an outside entry");
    assert.ok(run.ops.every((op) => op.x <= midX));
});

test("unloaded chunks: when nothing can be read, nothing is restored", () => {
    const j = buildDistrictJournal().journal;
    const run = runPlan(j, () => undefined);
    assert.equal(run.ops.length, 0);
    assert.equal(run.summary.counts.skippedUnloaded, j.entries.size);
});

test("restart in the middle of an undo: reload the journal, resume, and reach the same final world", () => {
    const original = buildDistrictJournal().journal;
    const m = mutateDistrict(original, 11);
    const readFrom = (/** @type {Map<string, string>} */ live) => (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
        m.unloadedKeys.has(`${x},${y},${z}`) ? undefined : live.get(`${x},${y},${z}`);

    // Reference: one uninterrupted undo.
    const reference = new Map(m.live);
    applyOps(reference, runPlan(original, readFrom(reference), { protect: m.protect }).ops);

    // Persist the journal, then start undoing and stop after the first slice (simulated crash).
    const props = new Map();
    const store = createUndoStore(fakeWorld({ props }), { prefix: "civ:undo:d7" });
    assert.equal(saveJournal(store, original).ok, true);
    const live = new Map(m.live);
    const planner = planUndo(original, readFrom(live), { protect: m.protect });
    const firstSlice = planner.next();
    assert.equal(firstSlice.done, false);
    applyOps(live, firstSlice.value.ops);

    // Restart: a new process loads the journal from the stored properties and resumes against the live world.
    const restarted = createUndoStore(fakeWorld({ props }), { prefix: "civ:undo:d7" });
    const loaded = loadJournal(restarted);
    assert.equal(loaded.status, "ok", loaded.reason);
    const resumed = runPlan(loaded.journal, readFrom(live), { protect: m.protect });
    applyOps(live, resumed.ops);
    assert.deepEqual(live, reference, "the resumed undo ends in exactly the uninterrupted state");
    assert.equal(resumed.summary.counts.alreadyRestored, firstSlice.value.ops.length + m.expected.already, "cells of the first slice are seen as already restored");
});
