// Undo journal: recording rules, encode/decode round trip, determinism, malformed input, the size budget for
// a realistic district, and persistence through civ/planstore.js (chunking, crash safety, refuse-before-write).
import assert from "node:assert/strict";
import test from "node:test";
import { AIR, createJournal, createUndoStore, decodeJournal, encodeJournal, loadJournal, recordWrite, saveJournal, summarizeJournal, UNDO_MAX_BYTES } from "../../CivilizationApocalypse_BP/scripts/civ/undo.js";
import { buildDistrictJournal, DIM, fakeWorld, liveAfterBuild, rng } from "./undo-fixture.mjs";

const PROPERTY_CHARS = 30000;

/** Entries of a journal as sortable plain objects, for equality checks. */
const plain = (journal) =>
    [...journal.entries.values()]
        .map((e) => ({ x: e.x, y: e.y, z: e.z, kind: e.kind, prior: e.prior, written: e.written }))
        .sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);

/** A journal whose cells are known exactly: several columns, gaps, extreme heights, negative coordinates. */
function edgeJournal() {
    const j = createJournal(DIM);
    const put = (x, y, z, kind, prior, written) => {
        const r = recordWrite(j, { x, y, z, kind, prior, written });
        assert.equal(r.recorded, true, r.reason);
    };
    for (let y = -64; y <= 319; y += 1) put(-5, y, 7, "clear", "minecraft:tall_grass", AIR); // full-height column
    for (let y = 60; y < 66; y += 1) put(-4, y, 7, "cut", y === 65 ? "minecraft:grass_block" : "minecraft:dirt", AIR);
    put(-4, 70, 7, "clear", "minecraft:fern", AIR); // a gap inside one column
    put(40, 61, -9, "fill", AIR, "minecraft:dirt");
    put(40, 62, -9, "top", "minecraft:stone", "minecraft:grass_block");
    put(0, 0, 0, "road", AIR, "minecraft:grass_path"); // a non-terrain kind is journalable too
    return j;
}

test("recordWrite: refuses no-op writes, unknown priors and malformed input", () => {
    const j = createJournal(DIM);
    assert.equal(recordWrite(j, { x: 1, y: 2, z: 3, kind: "cut", prior: "minecraft:stone", written: "minecraft:stone" }).recorded, false);
    assert.equal(recordWrite(j, { x: 1, y: 2, z: 3, kind: "cut", prior: undefined, written: AIR }).recorded, false);
    assert.equal(recordWrite(j, { x: 1.5, y: 2, z: 3, kind: "cut", prior: "minecraft:stone", written: AIR }).recorded, false);
    assert.equal(recordWrite(j, { x: 1, y: 2, z: 3, kind: "Cut!", prior: "minecraft:stone", written: AIR }).recorded, false);
    assert.equal(recordWrite(j, { x: 1, y: 2, z: 3, kind: "cut", prior: "stone", written: AIR }).recorded, false);
    assert.equal(j.entries.size, 0);
});

test("recordWrite: a twice-written cell keeps its first prior, takes the last written id, and vanishes if it returns", () => {
    const j = createJournal(DIM);
    recordWrite(j, { x: 1, y: 2, z: 3, kind: "fill", prior: AIR, written: "minecraft:dirt" });
    recordWrite(j, { x: 1, y: 2, z: 3, kind: "top", prior: "minecraft:dirt", written: "minecraft:grass_block" });
    const e = j.entries.get("1,2,3");
    assert.deepEqual([e.prior, e.written], [AIR, "minecraft:grass_block"]);
    const back = recordWrite(j, { x: 1, y: 2, z: 3, kind: "clear", prior: "minecraft:grass_block", written: AIR });
    assert.equal(back.recorded, true);
    assert.equal(j.entries.has("1,2,3"), false, "the cell is back to its original id, so there is nothing to undo");
});

test("encode/decode round trip is exact for the edge journal and the realistic district", () => {
    const edge = edgeJournal();
    const decodedEdge = decodeJournal(encodeJournal(edge).text);
    assert.equal(decodedEdge.ok, true, decodedEdge.ok ? "" : decodedEdge.reason);
    assert.deepEqual(plain(decodedEdge.journal), plain(edge));
    assert.equal(decodedEdge.journal.dimension, DIM);

    const district = buildDistrictJournal().journal;
    const decoded = decodeJournal(encodeJournal(district).text);
    assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.reason);
    assert.deepEqual(plain(decoded.journal), plain(district));
    // Re-encoding the decoded journal gives the identical text (canonical form).
    assert.equal(encodeJournal(decoded.journal).text, encodeJournal(district).text);
});

test("an empty journal encodes and decodes to an empty journal", () => {
    const empty = createJournal(DIM);
    const text = encodeJournal(empty).text;
    const decoded = decodeJournal(text);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.journal.entries.size, 0);
});

test("encoding is deterministic: insertion order and repeated calls do not change the text", () => {
    const base = [...buildDistrictJournal().journal.entries.values()];
    const forward = createJournal(DIM);
    for (const e of base) recordWrite(forward, { ...e, prior: e.prior });
    const shuffled = createJournal(DIM);
    const r = rng(99);
    const order = [...base];
    for (let i = order.length - 1; i > 0; i -= 1) {
        const k = Math.floor(r() * (i + 1));
        [order[i], order[k]] = [order[k], order[i]];
    }
    for (const e of order) recordWrite(shuffled, { ...e, prior: e.prior });
    const a = encodeJournal(forward).text;
    assert.equal(encodeJournal(forward).text, a);
    assert.equal(encodeJournal(shuffled).text, a);
});

test("decode refuses malformed or tampered payloads without throwing", () => {
    const good = encodeJournal(edgeJournal()).text;
    const newline = good.indexOf("\n");
    const header = JSON.parse(good.slice(0, newline));
    const body = good.slice(newline + 1);
    const withHeader = (h) => `${JSON.stringify(h)}\n${body}`;
    const cases = {
        "no header line": body,
        "wrong format": withHeader({ ...header, f: "civ-plan" }),
        "wrong schema": withHeader({ ...header, s: 2 }),
        "bad dimension": withHeader({ ...header, d: "" }),
        "count mismatch": withHeader({ ...header, n: header.n + 1 }),
        "pair index outside the table": withHeader({ ...header, p: header.p.map((t, i) => (i === 0 ? [t[0], t[1], 99] : t)) }),
        "pair with equal written and prior": withHeader({ ...header, p: [[header.p[0][0], header.p[0][1], header.p[0][1]], ...header.p.slice(1)] }),
        "truncated body": `${good.slice(0, newline + 1)}${body.slice(0, Math.floor(body.length / 2))}`,
        "character outside the alphabet": `${good.slice(0, newline + 1)}#${body}`,
        "trailing junk that breaks the count": `${good}0`,
    };
    for (const [name, text] of Object.entries(cases)) {
        const result = decodeJournal(text);
        assert.equal(result.ok, false, `${name} must be refused`);
        assert.equal(typeof result.reason, "string", name);
    }
});

test("size budget: the realistic district fits one 30000-char property, and the measured numbers are reported", (t) => {
    const f = buildDistrictJournal();
    const s = summarizeJournal(f.journal);
    const cutFill = (s.byKind.cut ?? 0) + (s.byKind.fill ?? 0) + (s.byKind.top ?? 0);
    const enc = encodeJournal(f.journal);
    const naiveJson = JSON.stringify(plain(f.journal)).length;
    const report = {
        cells: s.cells,
        cutFill,
        clear: s.byKind.clear ?? 0,
        runs: enc.runs,
        ids: enc.ids,
        pairs: enc.pairs,
        headerChars: enc.text.indexOf("\n") + 1,
        encodedChars: enc.text.length,
        encodedBytes: enc.bytes,
        charsPerCell: Number((enc.text.length / s.cells).toFixed(2)),
        shareOfPropertyPct: Number(((100 * enc.text.length) / PROPERTY_CHARS).toFixed(1)),
        naiveJsonChars: naiveJson,
        naiveCharsPerCell: Number((naiveJson / s.cells).toFixed(1)),
    };
    t.diagnostic(`undo journal, realistic district (6/6 hard-cap terrain): ${JSON.stringify(report)}`);
    assert.ok(cutFill >= 5000 && cutFill <= 7000, `cut/fill cells ${String(cutFill)} should be about 6000`);
    assert.ok(report.clear >= 300 && report.clear <= 500, `clear cells ${String(report.clear)} should be about 400`);
    assert.ok(enc.text.length <= PROPERTY_CHARS, `journal is ${String(enc.text.length)} chars, over the ${String(PROPERTY_CHARS)}-char property limit`);
    assert.ok(enc.bytes <= UNDO_MAX_BYTES, "within the per-district journal byte budget");
});

test("size budget, 4/4 design-default terrain: also one property", (t) => {
    const f = buildDistrictJournal({ amp: 4, limits: { maxCut: 4, maxFill: 4 }, clearColumnChance: 0.15 });
    const enc = encodeJournal(f.journal);
    t.diagnostic(`undo journal, 4/4 terrain: cells ${String(f.journal.entries.size)}, chars ${String(enc.text.length)}`);
    assert.ok(enc.text.length <= PROPERTY_CHARS);
});

/** A journal that needs chunking: every column of the 49 x 49 footprint alternates prior ids over 6 cells. */
function stressJournal() {
    const j = createJournal(DIM);
    for (let x = 0; x < 49; x += 1) {
        for (let z = 0; z < 49; z += 1) {
            for (let y = 60; y < 66; y += 1) {
                const prior = (x + z + y) % 2 === 0 ? "minecraft:dirt" : "minecraft:stone";
                assert.equal(recordWrite(j, { x: -60 + x, y, z: 300 + z, kind: "cut", prior, written: AIR }).recorded, true);
            }
        }
    }
    return j;
}

test("a journal above one property is chunked by the plan protocol and reloads exactly", () => {
    const j = stressJournal();
    const enc = encodeJournal(j);
    assert.ok(enc.text.length > PROPERTY_CHARS, "stress journal must exceed one property for this test to mean anything");
    const world = fakeWorld();
    const store = createUndoStore(world, { prefix: "civ:undo:d1" });
    const saved = saveJournal(store, j);
    assert.equal(saved.ok, true, saved.reason);
    assert.ok(saved.chunks > 1, `expected several chunks, got ${String(saved.chunks)}`);
    const loaded = loadJournal(store);
    assert.equal(loaded.status, "ok", loaded.reason);
    assert.deepEqual(plain(loaded.journal), plain(j));
});

test("refuse before writing: a journal over the byte budget changes nothing in the world", () => {
    const j = stressJournal();
    const world = fakeWorld();
    const store = createUndoStore(world, { prefix: "civ:undo:d2", maxBytes: 1000 });
    const result = saveJournal(store, j);
    assert.equal(result.ok, false);
    assert.equal(result.status, "too_large");
    assert.equal(world.writes, 0, "no property was written");
    assert.equal(loadJournal(createUndoStore(fakeWorld(), { prefix: "civ:undo:d2" })).status, "absent");
});

test("crash safety: a crash mid-save leaves the previous journal loadable after a restart", () => {
    const first = buildDistrictJournal({ seed: 5 }).journal;
    const second = buildDistrictJournal({ seed: 9 }).journal;
    const props = new Map();
    const world = fakeWorld({ props });
    const store = createUndoStore(world, { prefix: "civ:undo:d3" });
    assert.equal(saveJournal(store, first).ok, true);

    // Writes: one chunk, then the meta flip. Crash on the flip (the first write allowed, the second refused).
    const dying = fakeWorld({ props, crashAfter: 1 });
    const dyingStore = createUndoStore(dying, { prefix: "civ:undo:d3" });
    const failed = saveJournal(dyingStore, second);
    assert.equal(failed.ok, false, "the save must not report success after the crash");

    // Restart: a new world object over the same stored properties.
    const restarted = createUndoStore(fakeWorld({ props }), { prefix: "civ:undo:d3" });
    const loaded = loadJournal(restarted);
    assert.equal(loaded.status, "ok", loaded.reason);
    assert.deepEqual(plain(loaded.journal), plain(first), "the old, complete journal is what survives");
});

test("live-world sanity: the fixture's live map covers every journaled cell", () => {
    const j = buildDistrictJournal().journal;
    assert.equal(liveAfterBuild(j).size, j.entries.size);
});

test("encodeJournal refuses an entry that bypassed recordWrite, so the payload always decodes", () => {
    const j = createJournal(DIM);
    j.entries.set("1,2,3", { x: 1, y: 2, z: 3, kind: "cut", prior: "minecraft:dirt", written: "minecraft:dirt" });
    assert.throws(() => encodeJournal(j), RangeError);
});
