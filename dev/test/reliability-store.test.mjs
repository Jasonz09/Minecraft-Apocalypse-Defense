// Reliability: kingdom/store.js against a fake `world` that behaves like Bedrock dynamic
// properties: a string value longer than 32767 characters is refused (throws), and any
// write can be made to throw on demand.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { KINGDOM_SCHEMA_VERSION, STORAGE_KEYS } = await load("config.js");
const { createInitialKingdom, serializeKingdom, findValidationProblems } = await load("kingdom", "state.js");
const { createKingdomStore } = await load("kingdom", "store.js");
const { advanceKingdom } = await load("sim", "tick.js");

const MAX_PROPERTY_STRING = 32767;

function createLimitedWorld(entries = []) {
    const properties = new Map(entries);
    const world = {
        properties,
        writes: 0,
        failNextWrites: 0,
        failOnKey: undefined,
        getDynamicProperty(key) {
            return properties.get(key);
        },
        setDynamicProperty(key, value) {
            if (world.failNextWrites > 0) {
                world.failNextWrites -= 1;
                throw new Error("injected setDynamicProperty failure");
            }
            if (world.failOnKey === key) {
                throw new Error(`injected failure for ${key}`);
            }
            if (typeof value === "string" && value.length > MAX_PROPERTY_STRING) {
                throw new RangeError(`dynamic property string exceeds ${String(MAX_PROPERTY_STRING)} characters (${String(value.length)})`);
            }
            world.writes += 1;
            if (value === undefined) {
                properties.delete(key);
            } else {
                properties.set(key, value);
            }
        },
    };
    return world;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("fake world self-check: oversize strings throw like the real API", () => {
    const world = createLimitedWorld();
    assert.throws(() => world.setDynamicProperty("k", "x".repeat(MAX_PROPERTY_STRING + 1)), RangeError);
    world.setDynamicProperty("k", "x".repeat(MAX_PROPERTY_STRING));
    assert.equal(world.getDynamicProperty("k").length, MAX_PROPERTY_STRING);
});

test("size budget: a kingdom stays under the 32767 limit across 200 in-game days, with headroom", () => {
    const kingdom = createInitialKingdom();
    const sizes = [];
    for (let day = 1; day <= 200; day += 1) {
        advanceKingdom(kingdom, 24);
        sizes.push(serializeKingdom(kingdom).length);
    }
    const peak = Math.max(...sizes);
    assert.ok(peak < MAX_PROPERTY_STRING, `peak ${String(peak)} must fit in one dynamic property`);
    assert.ok(peak < MAX_PROPERTY_STRING * 0.75, `peak ${String(peak)} should leave >25% headroom`);
    // growth must plateau: the last 100 days may not be far above day 100
    assert.ok(sizes[199] <= sizes[99] * 1.25, `size still growing: day100=${String(sizes[99])} day200=${String(sizes[199])}`);
});

test("size budget: the quarantine copy of a realistic late-game save fits the limit even after JSON escaping", () => {
    const kingdom = createInitialKingdom();
    advanceKingdom(kingdom, 24);
    for (let day = 0; day < 60; day += 1) {
        advanceKingdom(kingdom, 24);
    }
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, serializeKingdom(kingdom)]]);
    // Force the "invalid" path: schema ok, content refused by the validator.
    const broken = clone(kingdom);
    broken.territory[0].status = "bogus";
    world.properties.set(STORAGE_KEYS.kingdom, JSON.stringify(broken));
    const store = createKingdomStore(world);
    const result = store.ensureInitial();
    assert.equal(result.seeded, true);
    const quarantined = JSON.parse(world.properties.get(STORAGE_KEYS.quarantine));
    assert.equal(quarantined.note, "invalid");
    assert.ok(world.properties.get(STORAGE_KEYS.quarantine).length <= MAX_PROPERTY_STRING);
});

test("load/save round trip through the limited world", () => {
    const world = createLimitedWorld();
    const store = createKingdomStore(world);
    const kingdom = createInitialKingdom();
    advanceKingdom(kingdom, 10);
    store.save(kingdom);
    const loaded = store.load();
    assert.equal(loaded.status, "ok");
    assert.deepEqual(loaded.kingdom, kingdom);
});

test("save: a throwing setDynamicProperty propagates and leaves the previously stored kingdom intact", () => {
    const world = createLimitedWorld();
    const store = createKingdomStore(world);
    const first = createInitialKingdom();
    store.save(first);
    const stored = world.properties.get(STORAGE_KEYS.kingdom);

    const next = clone(first);
    advanceKingdom(next, 5);
    world.failNextWrites = 1;
    assert.throws(() => store.save(next), /injected setDynamicProperty failure/);
    assert.equal(world.properties.get(STORAGE_KEYS.kingdom), stored, "failed write must not corrupt the old payload");
    assert.deepEqual(store.load().kingdom, first);

    store.save(next); // and recovers on the next attempt
    assert.deepEqual(store.load().kingdom, next);
});

test("save: an invalid kingdom is refused before any write is attempted", () => {
    const world = createLimitedWorld();
    const store = createKingdomStore(world);
    const kingdom = createInitialKingdom();
    kingdom.districts[0].defensiveIntegrity = 250;
    assert.throws(() => store.save(kingdom), /refusing to save invalid kingdom state/);
    assert.equal(world.writes, 0);
    assert.equal(world.properties.has(STORAGE_KEYS.kingdom), false);
});

test("save: an oversize kingdom is rejected by the platform and the old payload survives", () => {
    const world = createLimitedWorld();
    const store = createKingdomStore(world);
    const good = createInitialKingdom();
    store.save(good);
    const oversize = clone(good);
    oversize.name = "N".repeat(MAX_PROPERTY_STRING); // valid per findValidationProblems, but too big to store
    assert.deepEqual(findValidationProblems(oversize), [], "validator has no size check (documented gap)");
    assert.throws(() => store.save(oversize), RangeError);
    assert.deepEqual(store.load().kingdom, good);
});

test("save: refuses to overwrite a newer-schema save, and does not write", () => {
    const newer = JSON.stringify({ schemaVersion: KINGDOM_SCHEMA_VERSION + 1, from: "future pack" });
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, newer]]);
    const store = createKingdomStore(world);
    assert.throws(() => store.save(createInitialKingdom()), /refusing to overwrite/);
    assert.equal(world.properties.get(STORAGE_KEYS.kingdom), newer);
    assert.equal(world.writes, 0);
});

test("ensureInitial: absent save seeds once and is idempotent afterwards", () => {
    const world = createLimitedWorld();
    const store = createKingdomStore(world);
    const first = store.ensureInitial();
    assert.equal(first.seeded, true);
    const writesAfterSeed = world.writes;
    const second = store.ensureInitial();
    assert.equal(second.seeded, false);
    assert.equal(second.migrated, false);
    assert.equal(world.writes, writesAfterSeed, "reading a healthy save writes nothing");
    assert.equal(world.properties.has(STORAGE_KEYS.quarantine), false);
});

test("ensureInitial: corrupt JSON is quarantined verbatim, then reseeded", () => {
    const garbage = "{not json at all";
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, garbage]]);
    const store = createKingdomStore(world);
    const result = store.ensureInitial();
    assert.equal(result.seeded, true);
    const quarantined = JSON.parse(world.properties.get(STORAGE_KEYS.quarantine));
    assert.equal(quarantined.payload, garbage);
    assert.equal(quarantined.note, "corrupt");
    assert.equal(store.load().status, "ok");
});

test("ensureInitial: a non-string property is reported corrupt, reseeded, and nothing is quarantined", () => {
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, 42]]);
    const store = createKingdomStore(world);
    assert.equal(store.load().status, "corrupt");
    const result = store.ensureInitial();
    assert.equal(result.seeded, true);
    assert.equal(world.properties.has(STORAGE_KEYS.quarantine), false, "the non-string value is lost without a copy");
});

test("ensureInitial: newer and unsupported saves are refused untouched, with no quarantine write", () => {
    for (const version of [KINGDOM_SCHEMA_VERSION + 3, 0]) {
        const raw = JSON.stringify({ schemaVersion: version, keep: "me" });
        const world = createLimitedWorld([[STORAGE_KEYS.kingdom, raw]]);
        const store = createKingdomStore(world);
        const result = store.ensureInitial();
        assert.equal(result.kingdom, undefined);
        assert.equal(result.refused, true);
        assert.equal(world.properties.get(STORAGE_KEYS.kingdom), raw);
        assert.equal(world.writes, 0);
    }
});

test("ensureInitial: a v1 save is migrated, quarantined first, and the stored copy becomes v2", () => {
    const v1 = JSON.stringify({ schemaVersion: 1, name: "Old Realm", districts: [{ id: "a", name: "A", civilians: 100, soldiers: 20 }, { id: "b", name: "B", civilians: 80, soldiers: 10 }] });
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, v1]]);
    const store = createKingdomStore(world);
    const result = store.ensureInitial();
    assert.equal(result.migrated, true);
    assert.equal(result.fromVersion, 1);
    assert.equal(JSON.parse(world.properties.get(STORAGE_KEYS.quarantine)).payload, v1);
    assert.equal(JSON.parse(world.properties.get(STORAGE_KEYS.kingdom)).schemaVersion, KINGDOM_SCHEMA_VERSION);
    assert.deepEqual(findValidationProblems(result.kingdom), []);
});

test("ensureInitial: if the quarantine write throws, the original save is NOT overwritten", () => {
    const garbage = "{broken";
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, garbage]]);
    world.failOnKey = STORAGE_KEYS.quarantine;
    const store = createKingdomStore(world);
    assert.throws(() => store.ensureInitial(), /injected failure/);
    assert.equal(world.properties.get(STORAGE_KEYS.kingdom), garbage, "data is preserved when its backup cannot be made");
});

test("ensureInitial: if the seeding write throws, the exception reaches the caller and nothing half-written remains", () => {
    const world = createLimitedWorld();
    world.failNextWrites = 1;
    const store = createKingdomStore(world);
    assert.throws(() => store.ensureInitial(), /injected setDynamicProperty failure/);
    assert.equal(world.properties.has(STORAGE_KEYS.kingdom), false);
    assert.equal(store.ensureInitial().seeded, true, "the next join seeds normally");
});

test("quarantine: only one slot - a second incident replaces the first copy (documented behaviour)", () => {
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, "{first"]]);
    const store = createKingdomStore(world);
    store.ensureInitial();
    assert.equal(JSON.parse(world.properties.get(STORAGE_KEYS.quarantine)).payload, "{first");
    world.properties.set(STORAGE_KEYS.kingdom, "{second");
    store.ensureInitial();
    assert.equal(JSON.parse(world.properties.get(STORAGE_KEYS.quarantine)).payload, "{second", "the first corrupt payload is gone");
});

test("quarantine: payloads over 20000 chars are truncated, so an invalid large save is only partly recoverable", () => {
    const kingdom = createInitialKingdom();
    kingdom.log = Array.from({ length: 3 }, (_, index) => `entry ${String(index)}`);
    const huge = JSON.stringify({ ...kingdom, schemaVersion: KINGDOM_SCHEMA_VERSION, name: "" , pad: "p".repeat(25000) });
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, huge]]);
    createKingdomStore(world).ensureInitial();
    const quarantined = JSON.parse(world.properties.get(STORAGE_KEYS.quarantine));
    assert.equal(quarantined.payload.length, 20000);
    assert.ok(huge.startsWith(quarantined.payload));
});

// ---- Real bug candidate -------------------------------------------------------------
// store.js quarantine(): `raw.slice(0, 20000)` is JSON-escaped when wrapped in
// JSON.stringify({ note, schemaVersion, payload }). Every `"` and `\` in the payload
// doubles in size, so a 20000-char slice of a quote/escape-dense (i.e. ordinary JSON)
// payload can serialise past 32767 and make setDynamicProperty throw. When that happens
// inside ensureInitial the player's save is not replaced (good) but the join handler
// throws and the player gets no message and no kingdom.
test("quarantine: worst-case escaping stays under the property limit", () => {
    const dense = `{"schemaVersion":${String(KINGDOM_SCHEMA_VERSION)},"x":"` + '\\"'.repeat(20000);
    const world = createLimitedWorld([[STORAGE_KEYS.kingdom, dense]]);
    const store = createKingdomStore(world);
    assert.doesNotThrow(() => store.ensureInitial());
    assert.ok(world.properties.get(STORAGE_KEYS.quarantine).length <= MAX_PROPERTY_STRING);
});

