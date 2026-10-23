import assert from "node:assert/strict";
import test from "node:test";
import { contract, createFakeWorld, createKingdom, population, roster } from "../lib/peopleharness.mjs";

const startingRoster = (kingdom = createKingdom()) =>
    contract.createRoster(kingdom.districts.map((district) => ({ id: district.id, civilians: district.civilians, soldiers: district.soldiers, garrison: district.garrison })));

/** A roster that has been through every kind of change: trainees, graduates, tombstones and growth. */
function churnedRoster() {
    let records = startingRoster();
    records = contract.enlistRecruits(records, "district-1", 6).records;
    records = contract.graduateTrainees(records, "district-1", 4).records;
    records = contract.enlistRecruits(records, "district-4", 3).records;
    records = contract.recordDeaths(records, "district-2", "civilian", 5).records;
    records = contract.recordDeaths(records, "district-3", "soldier", 2).records;
    records = contract.recordBirths(records, "district-5", "civilian", 7).records;
    return records;
}

test("a roster encodes and decodes back to exactly the same records", () => {
    const records = startingRoster();
    const text = roster.encodeRoster(records);
    const decoded = roster.decodeRoster(text);
    assert.equal(decoded.ok, true);
    assert.deepStrictEqual(decoded.records, contract.sortRecords(records));
});

test("a churned roster (trainees, graduates, tombstones, growth) also round-trips exactly", () => {
    const records = churnedRoster();
    const decoded = roster.decodeRoster(roster.encodeRoster(records));
    assert.equal(decoded.ok, true, decoded.problems?.join("; "));
    assert.deepStrictEqual(decoded.records, contract.sortRecords(records));
});

test("the 400 + 150 roster is compact: one chunk, far under the budget, and the numbers are reported", (t) => {
    const records = startingRoster();
    const report = roster.rosterSizeReport(records);
    t.diagnostic(`starting roster: ${JSON.stringify(report)}`);
    assert.equal(report.records, 550);
    assert.equal(report.civilians, 400);
    assert.equal(report.soldiers, 150);
    assert.equal(report.chunks, 1);
    assert.equal(report.fits, true);
    assert.ok(report.bytes < 15000, `bytes ${String(report.bytes)}`);
    assert.ok(report.bytesPerRecord < 30);
    const churned = roster.rosterSizeReport(churnedRoster());
    t.diagnostic(`churned roster: ${JSON.stringify(churned)}`);
    assert.equal(churned.fits, true);
    assert.ok(churned.bytes < 20000);
});

test("corrupt documents are rejected, never returned partially", () => {
    const good = roster.encodeRoster(startingRoster());
    const doc = JSON.parse(good);
    const cases = [
        ["truncated", good.slice(0, good.length - 40)],
        ["not a roster", JSON.stringify({ f: "civ-plan", v: 1, slots: [], d: [] })],
        ["future version", JSON.stringify({ ...doc, v: 2 })],
        ["slot out of range", JSON.stringify({ ...doc, d: [{ ...doc.d[0], c: [[1, 0, 0, 999, -1, 0]] }, ...doc.d.slice(1)] })],
        ["run of zero length", JSON.stringify({ ...doc, d: [{ ...doc.d[0], c: [[0, 0, 0, 0, -1, 0]] }, ...doc.d.slice(1)] })],
        ["graduate with no civilian", JSON.stringify({ ...doc, d: [{ ...doc.d[0], g: [[999, 1]] }, ...doc.d.slice(1)] })],
        ["graduated without a successor", JSON.stringify({ ...doc, d: [{ ...doc.d[0], c: [[1, 0, 4, 0, -1, 0], ...doc.d[0].c.slice(1)] }, ...doc.d.slice(1)] })],
        ["not JSON", "{\"f\":"],
    ];
    for (const [label, text] of cases) {
        const decoded = roster.decodeRoster(text);
        assert.equal(decoded.ok, false, label);
        assert.ok(decoded.problems.length > 0, `${label} has a reason`);
    }
});

test("encoding refuses a roster that does not validate", () => {
    const records = startingRoster();
    const broken = records.filter((record) => record.id !== "civ-district-1-civilian-001");
    assert.throws(() => roster.encodeRoster(broken), /does not validate/);
});

test("store round trip: save then load gives back the same roster", () => {
    const world = createFakeWorld();
    const store = roster.createRosterStore(world);
    const records = churnedRoster();
    const saved = store.save(records);
    assert.equal(saved.ok, true, saved.reason);
    const loaded = store.load();
    assert.equal(loaded.status, "ok");
    assert.deepStrictEqual(loaded.records, contract.sortRecords(records));
});

test("an invalid roster is refused before anything is written", () => {
    const world = createFakeWorld();
    const store = roster.createRosterStore(world);
    store.save(startingRoster());
    const writesBefore = world.counters.propertyWrites;
    const result = store.save(startingRoster().slice(1));
    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(world.counters.propertyWrites, writesBefore, "no property was written");
    assert.equal(store.load().records.length, 550, "the previous roster is still live");
});

test("a crash at any point during a save leaves exactly the old roster or exactly the new one", () => {
    const before = startingRoster();
    const after = churnedRoster();
    const outcomes = new Set();
    for (let writes = 0; writes <= 8; writes += 1) {
        const world = createFakeWorld();
        const store = roster.createRosterStore(world);
        assert.equal(store.save(before).ok, true);
        world.armCrashAfterWrites(writes);
        store.save(after);
        world.disarmCrash();
        const loaded = store.load({ quarantine: true });
        assert.equal(loaded.status, "ok", `crash after ${String(writes)} writes: ${String(loaded.reason)}`);
        const matchesBefore = JSON.stringify(loaded.records) === JSON.stringify(contract.sortRecords(before));
        const matchesAfter = JSON.stringify(loaded.records) === JSON.stringify(contract.sortRecords(after));
        assert.ok(matchesBefore || matchesAfter, `crash after ${String(writes)} writes left a partial roster`);
        outcomes.add(matchesAfter ? "new" : "old");
    }
    assert.deepEqual([...outcomes].sort(), ["new", "old"], "both outcomes really occur");
});

test("a tampered chunk is caught by the checksum and reported as corrupt", () => {
    const world = createFakeWorld();
    const store = roster.createRosterStore(world);
    store.save(startingRoster());
    const meta = JSON.parse(world.getDynamicProperty(store.metaKey));
    const key = store.chunkKey(meta.fam, 0);
    const chunk = world.getDynamicProperty(key);
    world.setDynamicProperty(key, chunk.replace("\"c\":[[", "\"c\":[[1,0,0,0,-1,0],["));
    const loaded = store.load();
    assert.equal(loaded.status, "corrupt");
    assert.match(loaded.reason, /checksum|bytes|missing/);
    assert.deepEqual(loaded.records, []);
});

test("a corrupt envelope is quarantined on request, and the live key is left alone", () => {
    const world = createFakeWorld();
    const store = roster.createRosterStore(world);
    store.save(startingRoster());
    world.setDynamicProperty(store.metaKey, "{not json");
    const loaded = store.load({ quarantine: true });
    assert.equal(loaded.status, "corrupt");
    assert.ok(world.getDynamicProperty(store.quarantineKey) !== undefined, "copied aside");
    assert.equal(world.getDynamicProperty(store.metaKey), "{not json", "not overwritten");
});

test("an absent roster loads as absent, not as an empty population", () => {
    const store = roster.createRosterStore(createFakeWorld());
    const loaded = store.load();
    assert.equal(loaded.status, "absent");
    assert.deepEqual(loaded.records, []);
});

test("an oversize roster is refused with too_large before any write", () => {
    const world = createFakeWorld();
    const store = roster.createRosterStore(world);
    const huge = contract.createRoster([{ id: "district-1", civilians: 6000, soldiers: 0 }]);
    const result = store.save(huge);
    assert.equal(result.ok, false);
    assert.equal(result.status, "too_large");
    assert.equal(world.counters.propertyWrites, 0);
});

test("every key the roster owns lives under civ:people, clear of the plan, job and kingdom prefixes", () => {
    const world = createFakeWorld();
    const store = roster.createRosterStore(world);
    store.save(churnedRoster());
    store.save(startingRoster());
    const keys = world.getDynamicPropertyIds();
    assert.ok(keys.length >= 2);
    for (const key of keys) {
        assert.ok(key.startsWith("civ:people:"), key);
        assert.ok(!key.startsWith("civ:plan") && !key.startsWith("civ:jobs") && !key.startsWith("civ:kingdom"), key);
    }
    assert.equal(roster.ROSTER_PREFIX, "civ:people");
});

test("population totals survive a save and a restart: the economy keeps its 550", () => {
    const kingdom = createKingdom();
    const world = createFakeWorld();
    const store = roster.createRosterStore(world);
    let records = startingRoster(kingdom);
    store.save(records);
    for (let step = 0; step < 6; step += 1) {
        const events = [];
        const enlisted = population.openRecruitment(kingdom.districts[step % 5], 2, { kingdom });
        events.push({ op: "recruit", district: kingdom.districts[step % 5].id, count: enlisted.recruits });
        for (const district of kingdom.districts) {
            const trained = population.advanceTraining(kingdom, district);
            if (trained.graduated > 0) events.push({ op: "graduate", district: district.id, count: trained.graduated });
        }
        records = contract.syncPopulation(records, kingdom.districts, events).records;
        store.save(records);
        // Restart: the in-memory roster is dropped and reloaded from the world.
        records = store.load().records;
        assert.equal(contract.populationTotals(records).total, 550, `step ${String(step)}`);
    }
    assert.equal(contract.checkPopulation(records, kingdom.districts).ok, true);
});
