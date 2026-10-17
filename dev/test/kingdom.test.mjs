import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { DISTRICT_NAMES, SCRIPT_EVENT_IDS, SCRIPT_EVENT_NAMESPACE, STARTING_SIMULATION, STORAGE_KEYS, KINGDOM_SCHEMA_VERSION } =
    await loadModule("config.js");
const { computeTotals, createInitialKingdom, findValidationProblems, serializeKingdom, deserializeKingdom, splitEvenly } =
    await loadModule("kingdom", "state.js");
const { createKingdomStore } = await loadModule("kingdom", "store.js");
const { formatMissingKingdomLines, formatStatusLines, formatSummaryLines } = await loadModule("ui", "report.js");

function createMockWorld(initialEntries) {
    const properties = new Map(initialEntries ?? []);
    return {
        properties,
        getDynamicProperty(identifier) {
            return properties.get(identifier);
        },
        setDynamicProperty(identifier, value) {
            if (value === undefined) {
                properties.delete(identifier);
            } else {
                properties.set(identifier, value);
            }
        },
    };
}

test("config carries the requested starting simulation values", () => {
    assert.equal(STARTING_SIMULATION.districtCount, 5);
    assert.equal(STARTING_SIMULATION.civilians, 400);
    assert.equal(STARTING_SIMULATION.soldiers, 150);
    assert.equal(DISTRICT_NAMES.length, STARTING_SIMULATION.districtCount);
    assert.equal(STORAGE_KEYS.kingdom, "civ:kingdom");
    assert.equal(SCRIPT_EVENT_IDS.status, "civ:status");
    assert.equal(SCRIPT_EVENT_NAMESPACE, "civ");
});

test("splitEvenly partitions exactly and front-loads the remainder", () => {
    assert.deepEqual(splitEvenly(400, 5), [80, 80, 80, 80, 80]);
    assert.deepEqual(splitEvenly(150, 5), [30, 30, 30, 30, 30]);
    const uneven = splitEvenly(10, 3);
    assert.deepEqual(uneven, [4, 3, 3]);
    assert.equal(uneven.reduce((sum, value) => sum + value, 0), 10);
    assert.deepEqual(splitEvenly(0, 4), [0, 0, 0, 0]);
});

test("splitEvenly refuses inputs that would silently lose population", () => {
    assert.throws(() => splitEvenly(10.5, 3), /non-negative integer/);
    assert.throws(() => splitEvenly(-1, 3), /non-negative integer/);
    assert.throws(() => splitEvenly(10, 0), /positive integer/);
    assert.throws(() => splitEvenly(10, 2.5), /positive integer/);
});

test("the starting kingdom is 5 districts holding 400 civilians and 150 soldiers", () => {
    const kingdom = createInitialKingdom();
    assert.equal(kingdom.schemaVersion, KINGDOM_SCHEMA_VERSION);
    assert.equal(kingdom.districts.length, 5);
    assert.deepEqual(findValidationProblems(kingdom), []);

    const totals = computeTotals(kingdom);
    assert.equal(totals.civilians, 400);
    assert.equal(totals.soldiers, 150);
    assert.equal(totals.districts, 5);
    assert.deepEqual(
        kingdom.districts.map((district) => [district.civilians, district.soldiers]),
        [
            [80, 30],
            [80, 30],
            [80, 30],
            [80, 30],
            [80, 30],
        ],
    );
    assert.deepEqual(
        kingdom.districts.map((district) => district.name),
        DISTRICT_NAMES,
    );
});

test("totals are derived from districts, never stored separately", () => {
    const kingdom = createInitialKingdom();
    kingdom.districts[0].civilians -= 25;
    kingdom.districts[1].soldiers += 7;
    assert.equal(computeTotals(kingdom).civilians, 375);
    assert.equal(computeTotals(kingdom).soldiers, 157);
});

test("validation rejects malformed kingdom state", () => {
    assert.deepEqual(findValidationProblems(null), ["kingdom is not an object"]);
    assert.deepEqual(findValidationProblems([]), ["kingdom is not an object"]);
    assert.deepEqual(findValidationProblems({ schemaVersion: 99 }), ["kingdom schemaVersion 99, expected 2"]);

    const wrongName = { ...createInitialKingdom(), name: "" };
    assert.deepEqual(findValidationProblems(wrongName), ["kingdom name must be a non-empty string"]);

    const noDistricts = { ...createInitialKingdom(), districts: [] };
    assert.deepEqual(findValidationProblems(noDistricts), ["kingdom must contain at least one district"]);

    const negative = createInitialKingdom();
    negative.districts[2].civilians = -3;
    assert.match(findValidationProblems(negative).join("|"), /district 2\.civilians must be a non-negative integer/);

    const fractional = createInitialKingdom();
    fractional.districts[0].soldiers = 12.5;
    assert.match(findValidationProblems(fractional).join("|"), /non-negative integer/);

    const duplicated = createInitialKingdom();
    duplicated.districts[1].id = duplicated.districts[0].id;
    assert.match(findValidationProblems(duplicated).join("|"), /repeats id/);
});

test("the store seeds once, then reloads the same state from storage", () => {
    const world = createMockWorld();
    const store = createKingdomStore(world);

    assert.equal(store.load().kingdom, undefined);
    assert.match(store.load().reason, /no kingdom has been stored yet/);

    const first = store.ensureInitial();
    assert.equal(first.seeded, true);
    assert.equal(computeTotals(first.kingdom).civilians, 400);

    const second = store.ensureInitial();
    assert.equal(second.seeded, false);
    assert.deepEqual(second.kingdom, first.kingdom);

    assert.equal(world.properties.size, 1);
    assert.ok(world.properties.get(STORAGE_KEYS.kingdom).startsWith("{"));
});

test("state survives a world restart (fresh store, same saved world)", () => {
    const world = createMockWorld();
    const before = createKingdomStore(world).ensureInitial().kingdom;
    before.districts[0].civilians = 118;
    createKingdomStore(world).save(before);

    const after = createKingdomStore(world).load();
    assert.equal(after.reason, undefined);
    assert.equal(after.kingdom.districts[0].civilians, 118);
    assert.equal(computeTotals(after.kingdom).civilians, 438);
});

test("saving over shelter capacity is refused, so an overfilled district cannot persist", () => {
    const world = createMockWorld();
    const store = createKingdomStore(world);
    const kingdom = store.ensureInitial().kingdom;
    const savedBefore = world.properties.get(STORAGE_KEYS.kingdom);

    kingdom.districts[0].civilians = 123;
    assert.throws(() => store.save(kingdom), /over shelter: 123 civilians \+ 0 refugees exceed capacity 120/);
    assert.equal(world.properties.get(STORAGE_KEYS.kingdom), savedBefore);
});

test("corrupt or mistyped storage is reported, then reseeded on the next join", () => {
    const corrupt = createMockWorld([[STORAGE_KEYS.kingdom, "{not json"]]);
    const corruptStore = createKingdomStore(corrupt);
    assert.equal(corruptStore.load().kingdom, undefined);
    assert.match(corruptStore.load().reason, /not valid JSON/);
    assert.equal(corruptStore.ensureInitial().seeded, true);
    assert.equal(computeTotals(corruptStore.load().kingdom).soldiers, 150);

    const mistyped = createMockWorld([[STORAGE_KEYS.kingdom, 42]]);
    const mistypedStore = createKingdomStore(mistyped);
    assert.equal(mistypedStore.load().kingdom, undefined);
    assert.match(mistypedStore.load().reason, /expected a JSON string/);
});

test("saving an invalid kingdom throws and leaves the previous value intact", () => {
    const world = createMockWorld();
    const store = createKingdomStore(world);
    const good = store.ensureInitial().kingdom;
    const savedBefore = world.properties.get(STORAGE_KEYS.kingdom);

    assert.throws(() => store.save({ schemaVersion: 1, name: "broken", districts: [] }), /refusing to save invalid kingdom state/);
    assert.equal(world.properties.get(STORAGE_KEYS.kingdom), savedBefore);
    assert.deepEqual(store.load().kingdom, good);
});

test("serialize/deserialize round-trips without loss", () => {
    const kingdom = createInitialKingdom();
    const parsed = deserializeKingdom(serializeKingdom(kingdom));
    assert.equal(parsed.reason, undefined);
    assert.deepEqual(parsed.kingdom, kingdom);
});

test("the status report lists every district and the saved totals", () => {
    const lines = formatStatusLines(createInitialKingdom());
    assert.ok(lines[0].includes("Civilization Apocalypse"));
    assert.ok(lines.includes("Districts: 5"));
    assert.ok(lines.includes("Civilians: 400"));
    assert.ok(lines.includes("Soldiers:  150"));
    const districtLines = lines.filter((line) => line.includes("civilians,"));
    assert.equal(districtLines.length, 5);
    assert.ok(districtLines[0].includes("Hearthgate: 80 civilians, 30 soldiers"));
});

test("the join summary and the empty-state message stay short and actionable", () => {
    const summary = formatSummaryLines(createInitialKingdom());
    assert.equal(summary.length, 2);
    assert.match(summary[0], /5 districts, 400 civilians, 150 soldiers/);
    assert.match(summary[1], /scriptevent civ:status/);

    const missing = formatMissingKingdomLines("no kingdom has been stored yet");
    assert.match(missing.join("\n"), /No kingdom is saved in this world yet/);
    assert.match(missing.join("\n"), /no kingdom has been stored yet/);
});

test("the modules exercised offline have no runtime import of the Minecraft API", () => {
    // JSDoc `import("@minecraft/server")` type references are erased at runtime and are
    // what lets these files stay loadable in plain Node; only a real `from` import breaks that.
    const runtimeImport = /(^|\n)\s*import\s[^;\n]*from\s*["']@minecraft\/server["']|(?:^|\n)\s*import\s*["']@minecraft\/server["']/;

    // Controls: the pattern must catch a real import and must not catch the type-only form.
    assert.ok(runtimeImport.test('import { world } from "@minecraft/server";\nexport const x = 1;'), "control: runtime import is caught");
    assert.ok(runtimeImport.test('import "@minecraft/server";'), "control: side-effect import is caught");
    assert.ok(!runtimeImport.test('/** @type {import("@minecraft/server").World} */\nconst x = 1;'), "control: JSDoc type reference is not caught");

    for (const relativePath of ["config.js", "kingdom/state.js", "kingdom/store.js", "ui/report.js"]) {
        const source = readFileSync(join(scriptsRoot, ...relativePath.split("/")), "utf8");
        assert.ok(!runtimeImport.test(source), `${relativePath} must not import @minecraft/server at runtime`);
    }
});
