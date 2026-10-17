import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const { createInitialKingdom, computeTotals, findValidationProblems } = await loadModule("kingdom", "state.js");
const { migrateKingdom, readSchemaVersion } = await loadModule("kingdom", "migrations.js");
const { createKingdomStore } = await loadModule("kingdom", "store.js");
const rng = await loadModule("sim", "rng.js");
const clock = await loadModule("sim", "clock.js");

function createMockWorld(entries) {
    const properties = new Map(entries ?? []);
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

/** A save exactly as the previous (v1) release wrote it. */
function makeV1Save() {
    return JSON.stringify({
        schemaVersion: 1,
        name: "Civilization Apocalypse",
        districts: [
            { id: "district-1", name: "Hearthgate", civilians: 80, soldiers: 30 },
            { id: "district-2", name: "Ironquarry", civilians: 80, soldiers: 30 },
            { id: "district-3", name: "Whitethorn", civilians: 80, soldiers: 30 },
            { id: "district-4", name: "Saltmere", civilians: 80, soldiers: 30 },
            { id: "district-5", name: "Ashfall", civilians: 80, soldiers: 30 },
        ],
    });
}

test("v2 districts start fully established, not empty", () => {
    const kingdom = createInitialKingdom();
    assert.equal(kingdom.schemaVersion, 2);
    for (const district of kingdom.districts) {
        assert.equal(district.defensiveIntegrity, 100);
        assert.equal(district.security, "secure");
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
        assert.ok(district.civilianCapacity >= district.civilians, `${district.name} is over its own capacity on day one`);
        assert.equal(district.buildings.walls, config.DISTRICT_DEFAULTS.wallsPerDistrict);
        assert.ok(district.reserves.food > 0 && district.reserves.materials > 0 && district.reserves.supplies > 0);
        assert.equal(district.neighbors.length, 2, "every district is ring-connected to two neighbours");
        assert.equal(district.gates.length, 1);
        assert.equal(district.gates[0].state, "open");
    }
    assert.equal(kingdom.territory.length, config.TERRITORY_NAMES.length);
    assert.equal(kingdom.territory.every((land) => land.status === "wild"), true);
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("rng is deterministic for a seed and bounded to its range", () => {
    const sequence = (state, count) => {
        let cursor = state;
        const draws = [];
        for (let index = 0; index < count; index += 1) {
            const draw = rng.nextInt(cursor, 1, 6);
            draws.push(draw.value);
            cursor = draw.next;
        }
        return draws;
    };
    assert.deepEqual(sequence(20261017, 12), sequence(20261017, 12));
    assert.notDeepEqual(sequence(20261017, 12), sequence(111, 12));
    for (const value of sequence(7, 200)) {
        assert.ok(value >= 1 && value <= 6, `draw ${String(value)} escaped 1..6`);
    }
    assert.equal(rng.hashSeed("Civilization Apocalypse"), rng.hashSeed("Civilization Apocalypse"));
    assert.throws(() => rng.nextChance(1, 1.5), /probability must be 0\.\.1/);
});

test("game time is one step per hour with a bounded catch-up", () => {
    assert.equal(clock.STEPS_PER_DAY, 24);
    assert.equal(clock.dayOf(25), 1);
    assert.equal(clock.hourOf(25), 1);
    assert.equal(clock.formatGameTime(0), "Day 1, 00:00");
    assert.equal(clock.toTicks(3), 3 * config.SIM.stepTicks);
    assert.equal(clock.stepsFromTicks(config.SIM.stepTicks * 5000), config.SIM.maxCatchUpSteps);
    assert.equal(clock.stepsFromTicks(config.SIM.stepTicks * 5), 5);
    assert.equal(clock.stepsFromTicks(-10), 0);
});

test("a v1 save migrates without losing people, walls or names", () => {
    const result = migrateKingdom(JSON.parse(makeV1Save()));
    assert.equal(result.problems, undefined);
    assert.equal(result.fromVersion, 1);
    assert.equal(result.toVersion, 2);
    const migrated = result.kingdom;
    assert.deepEqual(findValidationProblems(migrated), []);
    assert.equal(computeTotals(migrated).civilians, 400);
    assert.equal(computeTotals(migrated).soldiers, 150);
    assert.deepEqual(
        migrated.districts.map((district) => [district.id, district.name, district.civilians, district.soldiers]),
        [
            ["district-1", "Hearthgate", 80, 30],
            ["district-2", "Ironquarry", 80, 30],
            ["district-3", "Whitethorn", 80, 30],
            ["district-4", "Saltmere", 80, 30],
            ["district-5", "Ashfall", 80, 30],
        ],
    );
});

test("migration refuses newer, older-than-supported and unreadable saves instead of guessing", () => {
    assert.match(migrateKingdom({ schemaVersion: 3 }).problems.join(" "), /newer than this pack/);
    assert.match(migrateKingdom({ schemaVersion: 0 }).problems.join(" "), /no migration path registered from schema v0/);
    assert.match(migrateKingdom({ name: "no version" }).problems.join(" "), /no schemaVersion/);
    assert.equal(readSchemaVersion({ schemaVersion: "1" }), undefined);

    const emptyDistricts = migrateKingdom({ schemaVersion: 1, name: "Ghost", districts: [] });
    assert.match(emptyDistricts.problems.join(" "), /migrated state failed validation/);
});

test("loading a v1 save migrates, quarantines the original and never re-seeds", () => {
    const world = createMockWorld([[config.STORAGE_KEYS.kingdom, makeV1Save()]]);
    const store = createKingdomStore(world);
    const result = store.ensureInitial();

    assert.equal(result.seeded, false, "existing progress must not be replaced by a fresh kingdom");
    assert.equal(result.migrated, true);
    assert.equal(result.fromVersion, 1);
    assert.equal(computeTotals(result.kingdom).civilians, 400);

    const storedNow = JSON.parse(world.properties.get(config.STORAGE_KEYS.kingdom));
    assert.equal(storedNow.schemaVersion, 2);

    const kept = JSON.parse(world.properties.get(config.STORAGE_KEYS.quarantine));
    assert.equal(kept.schemaVersion, 1);
    assert.match(kept.note, /pre-migration copy/);
    assert.match(kept.payload, /"schemaVersion":1/);
});

test("a save from a newer pack is refused and left byte-for-byte untouched", () => {
    const future = JSON.stringify({ schemaVersion: 9, name: "From tomorrow", districts: [] });
    const world = createMockWorld([[config.STORAGE_KEYS.kingdom, future]]);
    const store = createKingdomStore(world);
    const result = store.ensureInitial();

    assert.equal(result.refused, true);
    assert.equal(result.seeded, false);
    assert.equal(result.kingdom, undefined);
    assert.match(result.reason, /newer than this pack/);
    assert.equal(world.properties.get(config.STORAGE_KEYS.kingdom), future);
    assert.equal(world.properties.get(config.STORAGE_KEYS.quarantine), undefined);

    assert.throws(() => store.save(createInitialKingdom()), /refusing to overwrite a v9 save/);
});

test("an unreadable save is copied to quarantine before a fresh kingdom is seeded", () => {
    const world = createMockWorld([[config.STORAGE_KEYS.kingdom, "{truncated"]]);
    const store = createKingdomStore(world);
    const result = store.ensureInitial();

    assert.equal(result.seeded, true);
    assert.equal(computeTotals(result.kingdom).soldiers, 150);
    const kept = JSON.parse(world.properties.get(config.STORAGE_KEYS.quarantine));
    assert.equal(kept.payload, "{truncated");
    assert.match(kept.note, /corrupt/);
});

test("a save older than the supported range is refused, not silently rebuilt", () => {
    const ancient = JSON.stringify({ schemaVersion: 0, name: "Antiquity", districts: [] });
    const world = createMockWorld([[config.STORAGE_KEYS.kingdom, ancient]]);
    const result = createKingdomStore(world).ensureInitial();
    assert.equal(result.refused, true);
    assert.match(result.reason, /oldest readable version is v1/);
    assert.equal(world.properties.get(config.STORAGE_KEYS.kingdom), ancient);
});

test("validation guards the v2 invariants the simulation depends on", () => {
    const brokenGarrison = createInitialKingdom();
    brokenGarrison.districts[0].garrison.front = 5;
    assert.match(findValidationProblems(brokenGarrison).join("|"), /front\+reserve \(5\+6\) must equal soldiers \(30\)/);

    const badIntegrity = createInitialKingdom();
    badIntegrity.districts[1].defensiveIntegrity = 140;
    assert.match(findValidationProblems(badIntegrity).join("|"), /defensiveIntegrity must be 0\.\.100/);

    const badSecurity = createInitialKingdom();
    badSecurity.districts[2].security = "destroyed";
    assert.match(findValidationProblems(badSecurity).join("|"), /security 'destroyed' is not one of/);

    const ghostNeighbor = createInitialKingdom();
    ghostNeighbor.districts[3].neighbors = ["district-9"];
    assert.match(findValidationProblems(ghostNeighbor).join("|"), /links to unknown neighbor district-9/);

    const stolenGate = createInitialKingdom();
    stolenGate.districts[0].gates[0].owner = "district-4";
    assert.match(findValidationProblems(stolenGate).join("|"), /is owned by district-4 but listed under district-1/);

    const orphanLand = createInitialKingdom();
    orphanLand.territory[0].adjacentDistrictId = "district-42";
    assert.match(findValidationProblems(orphanLand).join("|"), /adjacent to unknown district district-42/);

    const badProject = createInitialKingdom();
    badProject.districts[0].projects = [{ id: "p1", kind: "cathedral", stage: 1, builders: 2 }];
    assert.match(findValidationProblems(badProject).join("|"), /unknown kind 'cathedral'/);

    const overStage = createInitialKingdom();
    overStage.districts[0].projects = [{ id: "p1", kind: "walls", stage: 99, builders: 2 }];
    assert.match(findValidationProblems(overStage).join("|"), /stage must be 0\.\.6/);
});
