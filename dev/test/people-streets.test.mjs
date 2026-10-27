// The streets driver: integration/peopleStreets.js run against the fake entity world.
//
// population-sync.test.mjs already proves the adapter's rules (one representative per group, budgets, crashes,
// unloads). What is proven HERE is the wiring the pack was missing: that an accepted simulation hour actually puts
// the kingdom's civilians and garrison into the world, that it does it exactly once per group however many hours run,
// that the garrison arrives as something able to fight, that the streets empty when the kingdom shrinks or the gate
// switches off, and that none of it writes a block.
//
// `@minecraft/server` is types-only on disk, so the same module hook used by population-sync.test.mjs substitutes a
// stub for the runtime import inside popSync.js. The fake world is dev/lib/streetsfixture.mjs: poptharness plus a
// nameTag journal plus block/command traps that fire.
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");

register(
    "data:text/javascript," +
        encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = "export const world = {}; export const system = {};";
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`),
);

const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { createPeopleStreets } = await load("integration", "peopleStreets.js");
const { POP_CURSOR_KEY, POP_ENTITY_TYPES, POP_SYNC_DEFAULTS, POP_TAG_PREFIX } = await load("population", "settings.js");
const { STORAGE_KEYS } = await load("config.js");
const { HOMES, NEAR_D1, createStreetWorld, starterKingdom } = await import(pathToFileURL(join(projectRoot, "dev", "lib", "streetsfixture.mjs")).href);

/** One in-game hour of the simulation loop (config.js SIM.stepTicks), so no two hours share a tick. */
const HOUR = 1000;

/** A gate-on starter world, one player standing in district-1, and every district's ground loaded. */
function scenario(kingdom = starterKingdom()) {
    const world = createStreetWorld();
    world.pop.setKingdom(kingdom);
    world.pop.setPlayers([NEAR_D1]);
    for (const home of Object.values(HOMES)) {
        world.pop.loadArea(home.x - 32, home.z - 32, home.x + 64, home.z + 64);
    }
    world.setGate(true);
    return world;
}

/**
 * The street as a list of facts a player could read: who stands where, what they are, what they are called.
 * Chunk state is left out, so a census taken before an unload still compares to one taken after it.
 * @param {ReturnType<typeof createStreetWorld>} world
 */
function street(world) {
    return world.census().map((row) => ({ id: row.id, typeId: row.typeId, groups: row.groups, nameTag: row.nameTag }));
}

/**
 * Run whole hours until two in a row change nothing, which is a converged street.
 * @param {ReturnType<typeof createStreetWorld>} world
 * @param {any} driver
 * @param {any} kingdom
 * @param {number} tick the tick of the last hour already run
 */
function converge(world, driver, kingdom, tick = 0) {
    /** @type {number[]} */
    const perHour = [];
    for (let hour = 0; hour < 40; hour += 1) {
        const next = tick + HOUR;
        const changed = driver.onHour(world.context(kingdom, next));
        tick = next;
        perHour.push(changed);
        if (perHour.length >= 2 && perHour[perHour.length - 1] === 0 && perHour[perHour.length - 2] === 0) {
            return { perHour, tick, changed };
        }
    }
    assert.fail(`the streets never settled: ${JSON.stringify(perHour)}`);
}

test("one hour with the gate on puts the kingdom's people in the world: tagged, typed, named, and no block written", () => {
    const kingdom = starterKingdom();
    const world = scenario(kingdom);
    const driver = createPeopleStreets();
    const mutationsBefore = world.state.mutations;
    const kingdomBefore = world.state.props.get(STORAGE_KEYS.kingdom);

    const changed = driver.onHour(world.context(kingdom, HOUR));
    assert.equal(changed, POP_SYNC_DEFAULTS.maxSpawnsPerTick, "a first hour spends its whole per-tick spawn budget");
    assert.equal(driver.status().refused, null, "the hour was not refused");

    const rows = world.census();
    assert.equal(rows.length, POP_SYNC_DEFAULTS.maxSpawnsPerTick, "exactly the entities the hour created are standing there");
    for (const row of rows) {
        assert.equal(row.groups.length, 1, "one group per representative");
        assert.ok(row.groups[0].startsWith("district-1:"), `${row.groups[0]} belongs to the district the player is in`);
        const tags = [...world.pop.state.entities.get(row.id).tags];
        assert.ok(tags.includes(`${POP_TAG_PREFIX}${row.groups[0]}`), "the tag is the canonical civpop:v1 one");
        assert.equal(row.typeId, POP_ENTITY_TYPES.civ, "a civilian group is a villager");
        assert.equal(row.nameTag, "Hearthgate folk", "named so a player can tell the district apart");
    }
    assert.equal(driver.status().named, POP_SYNC_DEFAULTS.maxSpawnsPerTick, "both new entities were signed");

    // Nothing here touches the ground, and the only world write is the cursor popSync owns.
    assert.deepEqual(world.journal.blockWrites, [], "not one block written");
    assert.deepEqual(world.journal.commandRuns, [], "no command run");
    assert.ok(world.state.mutations > mutationsBefore, "the hour really did write to the world (the tags and the cursor)");
    assert.ok(world.state.propertyWrites.every((write) => write.key === POP_CURSOR_KEY), `only ${POP_CURSOR_KEY} is written`);
    assert.equal(world.state.props.get(STORAGE_KEYS.kingdom), kingdomBefore, "the kingdom save is byte-for-byte untouched");

    // ...and the trap above is a real trap, so "no block writes" is a measurement and not a missing method.
    assert.throws(() => world.dimension.setBlock({ x: 0, y: 70, z: 0 }, "minecraft:stone"), /never write a block/);
    assert.equal(world.journal.blockWrites.length, 1, "the trap records the write it refused");
});

test("hours obey the caps: never more than the per-tick budget, never two per group, never over the district cap", () => {
    const kingdom = starterKingdom();
    const world = scenario(kingdom);
    const driver = createPeopleStreets();
    let tick = 0;
    for (let hour = 0; hour < 8; hour += 1) {
        tick += HOUR;
        const changed = driver.onHour(world.context(kingdom, tick));
        assert.ok(changed <= POP_SYNC_DEFAULTS.maxSpawnsPerTick, `hour ${String(hour)} spent at most the spawn budget`);
        const rows = world.census();
        assert.ok(rows.length <= POP_SYNC_DEFAULTS.maxPhysicalTotal, "the kingdom-wide cap");
        for (const districtId of Object.keys(HOMES)) {
            const inDistrict = rows.filter((row) => row.groups[0].startsWith(`${districtId}:`));
            assert.ok(inDistrict.length <= POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, `${districtId} holds at most ${String(POP_SYNC_DEFAULTS.maxPhysicalPerDistrict)}`);
        }
        /** @type {Map<string, number>} */
        const perGroup = new Map();
        for (const row of rows) {
            perGroup.set(row.groups[0], (perGroup.get(row.groups[0]) ?? 0) + 1);
        }
        for (const [groupId, count] of perGroup) {
            assert.equal(count, 1, `${groupId} never gets a second representative`);
        }
    }

    const settled = converge(world, driver, kingdom, tick);
    assert.deepEqual(settled.perHour.slice(-2), [0, 0], "and then it stops by itself");
    assert.equal(world.census().length, POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, "district-1 is served exactly to its cap");
    // The starter's 80 civilians / 30 soldiers make eight civilian groups and six garrison groups compete for
    // maxPhysicalPerDistrict places, and the civilian spots sit nearer the player. Without a per-kind floor that
    // leaves a walled town with no visible garrison at all, so `physicalFloorPerKind` holds the levy's slots open.
    const garrison = world.ofKind("sol");
    assert.ok(garrison.length >= POP_SYNC_DEFAULTS.physicalFloorPerKind,
        `the garrison is seen on the street, saw ${String(garrison.length)}`);
    assert.ok(garrison.every((row) => row.typeId === POP_ENTITY_TYPES.sol), "and what is seen is a golem, not a villager");
    assert.ok(world.ofKind("civ").length >= POP_SYNC_DEFAULTS.physicalFloorPerKind, "the folk keep their own floor");
    assert.equal(garrison.length + world.ofKind("civ").length, POP_SYNC_DEFAULTS.maxPhysicalPerDistrict,
        "the floor redistributes the district budget, it does not enlarge it");
});

test("idempotent: a further hour with the same numbers creates nothing, spawns nothing and re-names nothing", () => {
    const kingdom = starterKingdom({ civilians: 20, soldiers: 30 });
    const world = scenario(kingdom);
    const driver = createPeopleStreets();
    const settled = converge(world, driver, kingdom);
    const censusBefore = street(world);
    const spawnedBefore = world.state.spawned.length;
    const nameWritesBefore = world.journal.nameWrites.length;
    assert.ok(censusBefore.length > 0, "the street is populated first");

    const changed = driver.onHour(world.context(kingdom, settled.tick + HOUR));
    assert.equal(changed, 0, "unchanged numbers change nothing");
    assert.equal(world.state.spawned.length, spawnedBefore, "spawnEntity was not even called");
    assert.deepEqual(street(world), censusBefore, "the same entities, the same groups, the same names");
    assert.equal(world.journal.nameWrites.length, nameWritesBefore, "the naming pass is a no-op once the signs are up");
    assert.equal(driver.status().refused, null, "and not because the hour was refused");

    // Again, because the bug this pins is a driver that re-spawns every hour instead of reading the tags.
    assert.equal(driver.onHour(world.context(kingdom, settled.tick + 2 * HOUR)), 0);
    assert.deepEqual(street(world), censusBefore);
});

test("restart: after a reload the tag census finds the units that exist and does not duplicate them", () => {
    const kingdom = starterKingdom({ civilians: 20, soldiers: 30 });
    const world = scenario(kingdom);
    const driver = createPeopleStreets();
    let tick = converge(world, driver, kingdom).tick;
    const censusBefore = street(world);
    const spawnedBefore = world.state.spawned.length;

    // (a) a plain reload: the cursor is intact, so a fresh driver instance adopts what it can see.
    world.pop.restart();
    const reloaded = createPeopleStreets();
    tick += HOUR;
    assert.equal(reloaded.onHour(world.context(kingdom, tick)), 0, "an hour after the reload changes nothing");
    assert.equal(world.state.spawned.length, spawnedBefore, "no entity was created on top of the survivors");
    assert.deepEqual(street(world), censusBefore, "the same representatives, one per group");

    // (b) the hard case: a reload that lost the cursor. Identity is the tag, so the census still finds them.
    world.pop.setRawProperty(POP_CURSOR_KEY, undefined);
    world.pop.restart();
    const blind = createPeopleStreets();
    tick += HOUR;
    assert.equal(blind.onHour(world.context(kingdom, tick)), 0, "a lost cursor costs a re-derivation, not a duplicate");
    assert.equal(world.state.spawned.length, spawnedBefore, "still nothing spawned");
    assert.deepEqual(street(world), censusBefore, "the units that were already there are the units that stay");
    assert.deepEqual(blind.status().created, 0, "the fresh driver never had to make one");
    assert.ok(world.census().every((row) => row.nameTag !== ""), "and every survivor still carries its district name");
});

test("the garrison is iron: a camp district fields golems and leaves its folk as villagers", () => {
    assert.equal(POP_ENTITY_TYPES.civ, "minecraft:villager_v2", "civilians stay villagers");
    assert.equal(POP_ENTITY_TYPES.sol, "minecraft:iron_golem", "the garrison is what vanilla AI will fight with");
    assert.notEqual(POP_ENTITY_TYPES.civ, POP_ENTITY_TYPES.sol, "the mapping that made a garrison harmless is gone");

    // 20 civilians and 30 soldiers: 2 civilian groups plus 6 garrison groups, which fits the district cap.
    const kingdom = starterKingdom({ civilians: 20, soldiers: 30 });
    const world = scenario(kingdom);
    const driver = createPeopleStreets();
    converge(world, driver, kingdom);

    const folk = world.ofKind("civ");
    const levy = world.ofKind("sol");
    assert.equal(folk.length, Math.ceil(20 / POP_SYNC_DEFAULTS.groupSize.civ), "every civilian group is on the street");
    assert.equal(levy.length, Math.ceil(30 / POP_SYNC_DEFAULTS.groupSize.sol), "and every garrison group too");
    for (const row of folk) {
        assert.equal(row.typeId, "minecraft:villager_v2");
        assert.equal(row.nameTag, "Hearthgate folk");
    }
    for (const row of levy) {
        assert.equal(row.typeId, "minecraft:iron_golem", `the representative of ${row.groups[0]} can defend the district`);
        assert.equal(row.nameTag, "Hearthgate levy");
    }
    assert.deepEqual(world.namesInUse(), ["Hearthgate folk", "Hearthgate levy"], "two readable labels, no anonymous crowd");
});

test("surplus goes: when the kingdom's numbers fall the extra representatives are removed, in loaded ground only", () => {
    const world = scenario(starterKingdom({ civilians: 20, soldiers: 30 }));
    const driver = createPeopleStreets();
    const full = starterKingdom({ civilians: 20, soldiers: 30 });
    const settled = converge(world, driver, full);
    assert.equal(street(world).length, 8, "the street starts at the cap: 2 folk + 6 levy");

    // A district that loses people (evacuation, a garrison marched off) must not keep the old crowd.
    const shrunk = starterKingdom({ civilians: 20, soldiers: 30 });
    const district = shrunk.districts.find((item) => item.id === "district-1");
    district.civilians = 10;
    district.soldiers = 5;
    district.garrison = { front: 4, reserve: 1 };
    world.pop.setKingdom(shrunk);
    const afterShrink = converge(world, driver, shrunk, settled.tick);

    const rows = world.census();
    assert.equal(rows.length, 2, "one civilian group and one garrison group, which is all the records now hold");
    assert.deepEqual(rows.map((row) => row.groups[0]).sort(), ["district-1:civ:0", "district-1:sol:0"]);
    assert.ok(afterShrink.perHour.some((count) => count > 0), "the shrink was reported as entity changes");
    assert.ok(driver.status().removed > 0, "and counted by the driver");
    assert.equal(world.state.removeAttemptsUnloaded, 0, "nothing was even attempted in unloaded ground");
    assert.equal(world.state.spawned.length, 8, "shrinking spawned nothing new");

    // To zero: an emptied district keeps nothing.
    const emptied = starterKingdom({ civilians: 20, soldiers: 30 });
    const first = emptied.districts.find((item) => item.id === "district-1");
    first.civilians = 0;
    first.soldiers = 0;
    first.garrison = { front: 0, reserve: 0 };
    converge(world, driver, emptied, afterShrink.tick);
    assert.deepEqual(street(world), [], "no records, no representatives");
});

test("the gate going off empties the streets: the driver creates nothing and removes everything it made", () => {
    const kingdom = starterKingdom({ civilians: 20, soldiers: 30 });
    const world = scenario(kingdom);
    const driver = createPeopleStreets();
    const settled = converge(world, driver, kingdom);
    const ours = new Set(world.census().map((row) => row.id));
    assert.ok(ours.size >= 2, "there is a street to clear");
    const spawnedBefore = world.state.spawned.length;
    // Somebody else's business in the same district: never ours to remove.
    const foreign = world.pop.addEntity({ x: 3, z: 3, tags: ["other-pack:guard"] });
    const stray = world.pop.addEntity({ x: 5, z: 5 });
    const removalsBefore = world.state.removals.length;

    world.setGate(false);
    const cleared = driver.onHour(world.context(kingdom, settled.tick + HOUR));
    assert.equal(cleared, ours.size, "the teardown reports exactly what it took out");
    assert.deepEqual(street(world), [], "every entity the driver created is gone");
    assert.equal(world.state.spawned.length, spawnedBefore, "and it created none on the way");
    assert.ok(world.state.entities.has(foreign) && world.state.entities.has(stray), "foreign and untagged units are untouched");
    assert.deepEqual(world.state.removals.slice(removalsBefore).map((removal) => removal.id).sort(), [...ours].sort(), "only our tagged units were removed");
    assert.deepEqual(world.journal.blockWrites, [], "clearing the streets still writes no block");

    // The next off hour has nothing left to sweep, and switching back on serves the kingdom again.
    assert.equal(driver.onHour(world.context(kingdom, settled.tick + 2 * HOUR)), 0, "an empty street is not swept twice");
    world.setGate(true);
    assert.ok(driver.onHour(world.context(kingdom, settled.tick + 3 * HOUR)) > 0, "the gate coming back on puts people back");
});

test("an entity whose chunk unloaded is handled without throwing, and waits for its ground", () => {
    const kingdom = starterKingdom({ civilians: 20, soldiers: 30 });
    const world = scenario(kingdom);
    const driver = createPeopleStreets();
    let tick = converge(world, driver, kingdom).tick;
    const censusBefore = street(world);
    assert.ok(world.census().every((row) => row.loaded), "the street is on loaded ground first");

    // The player leaves and district-1's chunks unload: its units become invisible to every query.
    world.pop.setPlayers([{ name: "Steve", x: 5000, y: 70, z: 5000 }]);
    world.pop.unloadArea(-32, -32, 96, 96);
    tick += HOUR;
    assert.doesNotThrow(() => driver.onHour(world.context(kingdom, tick)), "an on hour against unloaded ground");
    assert.equal(world.state.removeAttemptsUnloaded, 0, "no removal was attempted where the engine cannot see");
    assert.equal(world.state.removals.length, 0, "and the units are all still standing there");
    assert.deepEqual(street(world), censusBefore, "nothing spawned and nothing duplicated while out of sight");

    // Teardown with the gate off has to survive the same world; it simply cannot reach what it cannot see.
    world.setGate(false);
    tick += HOUR;
    assert.doesNotThrow(() => driver.onHour(world.context(kingdom, tick)), "an off hour against unloaded ground");
    assert.equal(world.state.removeAttemptsUnloaded, 0);
    assert.equal(driver.onHour(world.context(kingdom, tick + HOUR)), 0, "still nothing reachable");
    assert.equal(world.census().length, censusBefore.length, "the invisible units wait for their chunks");

    // The ground comes back: the same representatives go, and no hour needed a crash.
    world.pop.loadArea(-32, -32, 96, 96);
    const swept = driver.onHour(world.context(kingdom, tick + 2 * HOUR));
    assert.equal(swept, censusBefore.length, "one bounded sweep takes them all out");
    assert.deepEqual(street(world), [], "the streets are empty once their ground is visible again");
    assert.equal(world.state.removeAttemptsUnloaded, 0, "never an attempt into an unloaded chunk");
});

test("the driver is a driver: an id, an onHour, and a clear refusal of a dimension it cannot use", () => {
    const driver = createPeopleStreets();
    assert.equal(driver.id, "streets");
    assert.equal(typeof driver.onHour, "function", "peopleRuntime.register takes this shape as it is");

    assert.throws(() => driver.onHour({}), TypeError, "a ctx with no dimension at all");
    assert.throws(() => driver.onHour({ kingdom: starterKingdom(), report: {}, dimension: {}, world: {} }), TypeError, "a dimension without getEntities and spawnEntity");
    assert.throws(() => driver.onHour({ kingdom: starterKingdom(), report: {}, dimension: null, world: {} }), TypeError);

    // A world whose gate cannot be read counts as off, and an off hour must not spawn.
    const world = scenario(starterKingdom({ civilians: 20, soldiers: 30 }));
    const spawnedBefore = world.state.spawned.length;
    const unreadable = { getDynamicProperty() { throw new Error("world not ready"); } };
    const off = createPeopleStreets();
    assert.equal(off.onHour({ kingdom: world.pop.storedKingdom(), report: {}, dimension: world.dimension, world: unreadable, tick: HOUR }), 0, "an unreadable gate is off");
    assert.equal(world.state.spawned.length, spawnedBefore, "so nothing was created");

    // A fractional or missing tick is the caller's mistake, not a reason for the streets to stop working: an unusable
    // tick falls back to the clock, and a budget already spent on that tick makes the hour do nothing, never double.
    const floored = createPeopleStreets();
    assert.doesNotThrow(() => floored.onHour(world.context(world.pop.storedKingdom(), 2.5)), "a fractional tick is floored");
    assert.equal(floored.status().refused, null);
    assert.doesNotThrow(() => createPeopleStreets().onHour(world.context(world.pop.storedKingdom(), undefined)), "no tick at all still runs an hour");
    assert.throws(
        () => createPeopleStreets().onHour({ kingdom: world.pop.storedKingdom(), report: {}, dimension: { getEntities: () => [] }, world: {}, tick: 5 }),
        TypeError,
        "a dimension that cannot spawn is refused before any world is touched",
    );
});

test("a district that has never been built gets no people: no physical origin means nowhere to stand", () => {
    const unbuilt = starterKingdom({ civilians: 20, soldiers: 30, built: [] });
    const world = scenario(unbuilt);
    const driver = createPeopleStreets();
    let changed = 0;
    for (let hour = 0; hour < 6; hour += 1) {
        changed += driver.onHour(world.context(unbuilt, (hour + 1) * HOUR));
    }
    assert.equal(changed, 0, "nothing was created for ground that does not exist");
    assert.equal(world.state.spawned.length, 0);
    assert.deepEqual(world.census(), []);
    assert.deepEqual(world.journal.blockWrites, [], "and no ground was made to stand on");
});

/**
 * The record a real build leaves behind, taken from a live save on 2026-10-26 (world `6gCdkCTx6zk=`,
 * `db/001330.log`): a completed `civ:generate` district stores `civ.anchor/centre/hq` as plan X/Z with no Y at
 * all, and never writes `physical`. The home reader looked only at `physical.origin`, so every built district
 * looked homeless - the driver ran hour after hour, reported no error, and put nobody in the street, while the
 * cursor recorded `{"n":10,"p":[]}`: ten groups seen, none admitted. The starter fixture authored
 * `physical.origin`, which is the shape the code expected rather than the shape the pack writes, and that is how
 * the whole suite stayed green over it.
 * @param {any} kingdom
 */
function asBuiltByCivGenerate(kingdom) {
    for (const district of kingdom.districts) {
        const home = HOMES[district.id];
        delete district.physical;
        district.civ = {
            district: Number(String(district.id).replace("district-", "")),
            status: "complete",
            seed: 20261017,
            anchor: { x: home.x - 5, z: home.z - 6 },
            centre: { x: home.x, z: home.z },
            checksum: "214bbd16",
            stage: "complete",
            startedStep: 738,
            dimension: "minecraft:overworld",
            hq: { x: home.x + 1, z: home.z + 1 },
            ops: 52188,
            opsTotal: 52188,
            placed: 47027,
            skipped: 4902,
            layout: "hearthgate-enlarged",
            gates: true,
        };
    }
    return kingdom;
}

test("a district built by civ:generate is housed: the build record has no Y, so the world supplies it", () => {
    const kingdom = asBuiltByCivGenerate(starterKingdom());
    assert.equal(kingdom.districts[0].physical, undefined, "no `physical` record, exactly as the live save reads");
    const world = scenario(kingdom);
    const driver = createPeopleStreets();

    const changed = driver.onHour(world.context(kingdom, HOUR));
    assert.ok(changed > 0, "the kingdom's people are in the world with only a civ record to find them");
    assert.equal(driver.status().refused, null, "the hour was not refused");

    const rows = world.census();
    assert.ok(rows.length > 0, "the street is not empty");
    for (const row of rows) {
        const record = world.pop.state.entities.get(row.id);
        assert.equal(record.y, HOMES["district-1"].y, "the missing Y came off the ground (surface + 1), not out of a guess");
        assert.ok(row.groups[0].startsWith("district-1:"), `${row.groups[0]} stands in the district the player is in`);
    }
    assert.deepEqual(world.journal.blockWrites, [], "finding the height read the column, it did not build one");
});

test("an unloaded build column yields no home, so nobody is placed in ground the pack cannot see", () => {
    const kingdom = asBuiltByCivGenerate(starterKingdom());
    const world = scenario(kingdom);
    for (const home of Object.values(HOMES)) {
        world.pop.unloadArea(home.x - 32, home.z - 32, home.x + 64, home.z + 64);
    }
    const driver = createPeopleStreets();
    const changed = driver.onHour(world.context(kingdom, HOUR));
    assert.equal(changed, 0, "no surface, no home, no spawn - a guessed Y would put a villager inside a hill");
    assert.deepEqual(world.census(), []);
});
