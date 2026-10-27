// The physical siege, offline: when the simulation says a district is under attack, real attacker entities stand
// outside its wall; when it says the attack is spent, they go away. Driven through the committed hook
// (integration/peopleRuntime.js calls the `siege` driver once per accepted hour) against an entity-capable fake
// world (dev/lib/siegefixture.mjs, which extends civharness's block world with entities, tags and a reload).
//
// Every assertion is about the mechanism: what is standing in the world, where, tagged how, of which type, how
// many, and what happened to the blocks. Nothing here asserts that code ran.
import assert from "node:assert/strict";
import test from "node:test";
import {
    blockState, builder, civCommands, clearTrees, dimension, entityList, fileUrl, freshImport, load, mc, reloadWorld,
    resetSiegeWorld, savedKingdom, setSurface, siege, siteDistrict, square, store, storeMasterPlan, threaten, withTag,
} from "../lib/siegefixture.mjs";

const siegeMobs = await load("integration", "siegeMobs.js");
const peopleRuntime = await load("integration", "peopleRuntime.js");
const director = await load("sim", "invasion", "director.js");
const tick = await load("sim", "tick.js");
const kingdomState = await load("kingdom", "state.js");
const districtBuilder = await load("integration", "districtBuilder.js");

const { createSiegeDriver, SIEGE_TAG, SIEGE_DEFAULTS, SIEGE_REFUSED_TYPES, siegeTagFor, bandFor, spawnableType, attackerTypeFor, physicalCentreOf, columnAt } = siegeMobs;
const { armInvasionDirector, createInvasionState, invasionThreatOf, isInvasionEnabled } = director;

const HALF = 24;
const DISTRICT_IDS = ["district-1", "district-2", "district-3", "district-4", "district-5"];

/* ------------------------------------------------------------------ *
 * world setup
 * ------------------------------------------------------------------ */

/**
 * A world with a civilization the pack has physically built: the master plan in `civ:plan`, one build record and
 * wall ring per site, vegetation off the approach ground, `civ:people` on, no build job running.
 *
 * @param {{ sites?: Array<{ x: number, z: number }>, field?: any, seed?: number }} [options]
 */
function builtWorld(options = {}) {
    const sites = options.sites ?? [{ x: 0, z: 0 }];
    resetSiegeWorld(options.seed ?? 1, { field: options.field ?? {} });
    storeMasterPlan(sites.map((site, index) => ({ index: index + 1, name: DISTRICT_IDS[index], outline: square(site.x, site.z, HALF) })));
    return sites.map((site, index) => {
        clearTrees(site.x - 90, site.z - 90, site.x + 90, site.z + 90);
        return siteDistrict(DISTRICT_IDS[index], { x: site.x, z: site.z, half: HALF });
    });
}

/** The production protection list for the saved kingdom and the stored plan. */
function protectedAreas() {
    return civCommands.protectedRects(savedKingdom(), builder.PROTECT_MARGIN, builder.loadMasterPlan().plan, builder.WRITE_PROTECT_GROW, 0);
}

/** A driver, registered on a real people runtime: the one line the integrator adds to main.js. */
function runtimeWith(...drivers) {
    const runtime = peopleRuntime.createPeopleRuntime(store);
    for (const driver of drivers) {
        assert.equal(runtime.register(driver), true, "the siege driver is a valid people driver");
    }
    return runtime;
}

/** One accepted simulation hour, asked of the runtime rather than of the driver directly. */
function hour(runtime, report = { ran: 1 }) {
    runtime.onStep(report);
}

/** The ctx shape peopleRuntime.js builds, for a caller that is not the runtime. */
function context() {
    return { kingdom: savedKingdom(), report: {}, dimension, world: mc.world, tick: mc.tick };
}

/**
 * One attacker, checked against the world rather than against the driver's own word.
 * @param {any} mob
 * @param {any} areas
 * @param {{ x: number, z: number }} centre
 * @param {any} config
 */
function assertBesieger(mob, areas, centre, config = SIEGE_DEFAULTS) {
    assert.ok(mob.tags.includes(SIEGE_TAG), `${mob.id} carries the namespace tag`);
    assert.equal(mob.persistent, true, `${mob.id} was spawned persistent, so a reload does not erase it`);
    assert.equal(SIEGE_REFUSED_TYPES.includes(mob.typeId), false, `${mob.typeId} is on the refusal list and must never stand here`);
    assert.equal(builder.inProtectedArea(areas, Math.floor(mob.x), Math.floor(mob.z)), false, `${mob.id} stands inside a district's protected footprint`);
    const offWall = Math.max(Math.abs(mob.x - centre.x), Math.abs(mob.z - centre.z)) - HALF;
    assert.ok(offWall > 0, `${mob.id} is ${String(offWall)} blocks from the wall line: it must be outside it`);
    assert.ok(offWall <= config.maxOffWall, `${mob.id} is ${String(offWall)} blocks out - a siege forms up at the wall, not on the horizon`);
    // and the block it stands on is real standable ground (or water, for a drowned)
    const column = columnAt(dimension, Math.floor(mob.x), Math.floor(mob.z), config);
    assert.notEqual(column, null, `${mob.id} was placed on a column that reads as unstandable`);
    if (mob.typeId === "minecraft:drowned") {
        assert.equal(column.water, true, "a drowned is posted where the approach is water");
    } else {
        assert.equal(column.water, false, `${mob.typeId} was not posted in open water`);
    }
}

/* ------------------------------------------------------------------ *
 * the hook, and what it does to the world
 * ------------------------------------------------------------------ */

test("a contested district gets attackers outside its wall, tagged and typed, and not one block is written", () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const areas = protectedAreas();

    const driver = createSiegeDriver();
    const runtime = runtimeWith(driver);
    const before = blockState();
    hour(runtime);

    const band = withTag(SIEGE_TAG);
    assert.equal(band.length, 3, "assault 9 at 4 raider-equivalents an attacker is three attackers");
    assert.equal(bandFor(savedKingdom().districts[0], null, driver.config).desired, 3, "the order the hour asked for is the band that appeared");
    assert.deepEqual(blockState(), before, "not one block was written or removed: the wall the pack built is untouched");
    assert.equal(siege.spawns.length, 3, "every attacker arrived through Dimension.spawnEntity");
    assert.match(runtime.statusLines().join("\n"), /siege: 1 hour\(s\), 3 entity change\(s\)/, "the runtime counted exactly what the world gained");

    for (const mob of band) {
        assert.equal(mob.typeId, "minecraft:pillager", "grass ground takes the default attacker");
        assert.ok(mob.tags.includes(siegeTagFor("district-1")), `${mob.id} is tagged for the district the simulation named`);
        assert.equal(mob.tags.length, 2, "and for nothing else: no other district claims it");
        assert.match(String(mob.nameTag), /Besieger of Hearthgate/);
        assertBesieger(mob, areas, { x: 0, z: 0 }, driver.config);
    }
    const columns = new Set(band.map((mob) => `${String(mob.x)},${String(mob.z)}`));
    assert.equal(columns.size, band.length, "no two attackers share a column");
    assert.equal(band.some((mob) => mob.typeId === "minecraft:vindicator"), false, "nine assault is not a large force");
    assert.equal(band.every((mob) => mob.rotation !== undefined), true, "each one was turned to face the district it is attacking");

    // the simulation now owns its own director, with no command involved
    assert.equal(savedKingdom().invasion.enabled, true, "the hour's threat armed the invasion director in the save");
    assert.equal(driver.status().created, 3);
    assert.equal(driver.status().removed, 0);
});

test("a breached district and a huge force: the caps hold and the brute joins the band", () => {
    const sites = [{ x: 0, z: 0 }, { x: 200, z: 0 }, { x: -200, z: 0 }];
    builtWorld({ sites });
    const kingdom = savedKingdom();
    for (const district of kingdom.districts) {
        // an assault no honest number in war.js produces: the caps must not care
        district.assault = 9999;
        district.security = "breached";
    }
    store.save(kingdom);

    const driver = createSiegeDriver();
    const areas = protectedAreas();
    const changes = driver.onHour(context());

    const band = withTag(SIEGE_TAG);
    assert.equal(changes, band.length, "the hour reports exactly what it changed");
    assert.equal(band.length, driver.config.maxTotal, "the hard kingdom-wide cap, exactly, and never past it");
    for (const site of sites) {
        const at = band.filter((mob) => mob.tags.includes(siegeTagFor(DISTRICT_IDS[sites.indexOf(site)])));
        assert.ok(at.length <= driver.config.maxPerDistrict, "no district is over its per-district cap");
        for (const mob of at) {
            assertBesieger(mob, areas, site, driver.config);
        }
    }
    const byDistrict = (/** @type {string} */ id) => band.filter((mob) => mob.tags.includes(siegeTagFor(id))).length;
    assert.equal(byDistrict("district-1"), driver.config.maxPerDistrict, "district-1 is filled first, in id order");
    assert.equal(byDistrict("district-2"), driver.config.maxPerDistrict, "district-2 is filled to the cap");
    assert.equal(byDistrict("district-3"), 0, "district-3 finds the kingdom budget spent and waits");
    assert.equal(band.filter((mob) => mob.typeId === "minecraft:vindicator").length, 2, "one brute per filled district: a huge force is what earns a vindicator");
    for (const id of ["district-1", "district-2"]) {
        const at = band.filter((mob) => mob.tags.includes(siegeTagFor(id)));
        assert.equal(at.filter((mob) => mob.typeId === "minecraft:vindicator").length, 1, `${id} puts exactly one vindicator in front`);
        assert.ok(at.filter((mob) => mob.typeId === "minecraft:vindicator").length <= driver.config.maxVindicators, `${id} is inside its brute cap`);
    }
    assert.deepEqual([...new Set(band.map((mob) => mob.typeId))].sort(), ["minecraft:pillager", "minecraft:vindicator"], "the roster only");

    // a second hour must not creep past the cap, and must not double anyone
    driver.onHour(context());
    assert.equal(withTag(SIEGE_TAG).length, driver.config.maxTotal, "an hour of topping up stays inside the cap");
    assert.equal(siege.spawns.length, driver.config.maxTotal, "and spawns nothing it did not need");
});

test("the same number of attackers goes away when the attack is repelled, and the watch stands down", () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver();
    runtimeWith(driver);
    driver.onHour(context());
    const standing = withTag(SIEGE_TAG);
    assert.equal(standing.length, 3);
    const ids = standing.map((mob) => mob.id).sort();
    const before = blockState();

    // the war's own verdict: the raid band is broken and the garrison holds the wall
    threaten("district-1", { assault: 0, security: "alert" });
    const changes = driver.onHour(context());

    assert.equal(changes, 3, "entity for entity: as many went away as were standing");
    assert.equal(withTag(SIEGE_TAG).length, 0, "nothing of ours is left in the world");
    assert.equal(entityList().length, 0, "and no attacker was left orphaned under a different name");
    assert.deepEqual(siege.removals.map((entry) => entry.id).sort(), ids, "the very same entities left, by id");
    assert.equal(siege.removals.every((entry) => entry.how === "remove"), true, "they were sent away, not killed in the world");
    assert.deepEqual(blockState(), before, "leaving writes no block either");
    assert.equal(savedKingdom().invasion.enabled, false, "with no threat in the field the director stands itself down again");
    assert.match(driver.status().notes.join("\n"), /sent away: no district is under attack/);
});

test("a withdrawal mid-wave sends the band away and leaves the director armed", () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver();
    driver.onHour(context());
    assert.ok(withTag(SIEGE_TAG).length > 0);

    // a wave in progress: the threat on the ground is gone, but the plan is not finished
    const kingdom = savedKingdom();
    kingdom.invasion.phase = "assault";
    kingdom.invasion.wave = { id: "W0001", kind: "raid", districtId: "district-1" };
    kingdom.districts[0].assault = 0;
    kingdom.districts[0].security = "alert";
    store.save(kingdom);

    driver.onHour(context());
    assert.equal(withTag(SIEGE_TAG).length, 0, "no raiders on the ground means no attackers standing at the wall");
    assert.equal(savedKingdom().invasion.enabled, true, "a half-delivered wave is not cancelled by a lull");
});

test("an attacker tagged for a district the kingdom no longer has is sent away", () => {
    const sites = [{ x: 0, z: 0 }, { x: 200, z: 0 }];
    builtWorld({ sites });
    threaten("district-1", { assault: 9, security: "contested" });
    threaten("district-2", { assault: 9, security: "breached" });
    const driver = createSiegeDriver();
    driver.onHour(context());
    assert.equal(withTag(siegeTagFor("district-2")).length, 3);

    // a band left over from a district that has gone out of the kingdom's records - which is exactly what a
    // reload hands a driver: tags in our namespace, no district to match them
    const ghost = dimension.spawnEntity("minecraft:pillager", { x: 240, y: 71, z: 40 });
    ghost.addTag(SIEGE_TAG);
    ghost.addTag(siegeTagFor("district-9"));
    const orphans = dimension.spawnEntity("minecraft:pillager", { x: 241, y: 71, z: 41 });
    orphans.addTag(SIEGE_TAG);

    const changes = driver.onHour(context());

    assert.equal(withTag(siegeTagFor("district-9")).length, 0, "no record, no district, no siege");
    assert.equal(withTag(SIEGE_TAG).filter((mob) => mob.tags.length === 1).length, 0, "an attacker with no district on its tag is an orphan, and goes");
    assert.equal(withTag(siegeTagFor("district-1")).length, 3, "the districts that are still pressed keep their bands");
    assert.equal(withTag(siegeTagFor("district-2")).length, 3, "both of them");
    assert.equal(changes, 2, "only the two stale entities changed the world");
    assert.match(driver.status().notes.join("\n"), /district record has gone/);
    assert.match(driver.status().notes.join("\n"), /without a district/);
});

test("a world reload finds the band it left behind instead of doubling it", async () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver();
    const runtime = runtimeWith(driver);
    hour(runtime);
    const before = withTag(SIEGE_TAG);
    assert.equal(before.length, 3, "a band is on the ground before the reload");
    assert.equal(before.every((mob) => mob.persistent), true, "it was spawned with initialPersistence");
    const spawnsAtReload = siege.spawns.length;

    const reloaded = await reloadWorld();
    assert.equal(reloaded.standing, 3, "the reload kept every persisted attacker");
    assert.equal(reloaded.dropped, 0, "and dropped nothing that was ours");

    const again = await freshImport(["integration", "siegeMobs.js"]);
    assert.notEqual(again.createSiegeDriver, createSiegeDriver, "the driver is a new module instance: nothing was remembered");
    const second = again.createSiegeDriver();
    const changes = second.onHour(context());

    const after = withTag(SIEGE_TAG);
    assert.equal(changes, 0, "the reload found the band by census, so the hour changed nothing");
    assert.equal(after.length, before.length, "the war band was not doubled");
    assert.deepEqual(after.map((mob) => mob.id).sort(), before.map((mob) => mob.id).sort(), "the same entities, not new ones");
    assert.equal(siege.spawns.length, spawnsAtReload, "no second spawn of any kind");
    assert.equal(second.status().created, 0);
});

test("an attacker the world did not persist is gone, and the next hour brings the band back to its order", async () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver();
    driver.onHour(context());
    assert.equal(withTag(SIEGE_TAG).length, 3);

    // one mob that never asked for persistence: the engine culls it, and the census must not count a ghost
    siege.records.get(withTag(SIEGE_TAG)[0].id).persistent = false;
    const reloaded = await reloadWorld();
    assert.equal(reloaded.dropped, 1, "the non-persistent attacker was dropped at the reload");
    assert.equal(reloaded.standing, 2);

    const again = await freshImport(["integration", "siegeMobs.js"]);
    const changes = again.createSiegeDriver().onHour(context());

    assert.equal(changes, 1, "exactly the one that was culled came back");
    assert.equal(withTag(SIEGE_TAG).length, 3, "the band is whole again, still inside its cap");
    assert.equal(new Set(withTag(SIEGE_TAG).map((mob) => `${String(mob.x)},${String(mob.z)}`)).size, 3, "and not on top of a survivor");
});

test("a mob that lost our tag is left alone, and a foreign unit is never ours to remove", () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver();
    driver.onHour(context());
    const ours = withTag(SIEGE_TAG);
    assert.equal(ours.length, 3);
    const ids = ours.map((mob) => mob.id);
    // the world retags one of them (another system claimed it), and a player's own pet stands by the wall
    siege.records.get(ids[0]).tags.delete(SIEGE_TAG);
    const foreign = dimension.spawnEntity("minecraft:wolf", { x: 5, y: 71, z: 5 });
    const untagged = dimension.spawnEntity("minecraft:pillager", { x: 6, y: 71, z: 6 });

    threaten("district-1", { assault: 0, security: "secure" });
    const changes = driver.onHour(context());

    assert.equal(changes, 2, "the two still carrying our namespace went; the retagged one was not ours");
    assert.equal(withTag(SIEGE_TAG).length, 0, "nothing of ours is left");
    assert.equal(siege.records.has(ids[0]), true, "a mob that lost our tag stays in the world under whoever took it");
    assert.equal(siege.records.has(foreign.id), true, "a wolf was never touched");
    assert.equal(siege.records.has(untagged.id), true, "an untagged pillager of someone else's was never touched");
    assert.equal(entityList().length, 3, "exactly those three survive, and no attacker of ours");
});

/* ------------------------------------------------------------------ *
 * the roster, and what can never be in it
 * ------------------------------------------------------------------ */

test("the ground the attack comes across decides the attacker: husks on sand, drowned in the shallows", () => {
    // desert approach: the whole ring around the wall is sand
    builtWorld();
    setSurface(-90, -90, 90, 90, "minecraft:sand");
    threaten("district-1", { assault: 12, security: "contested" });
    const areas = protectedAreas();
    const desert = createSiegeDriver();
    desert.onHour(context());
    const onSand = withTag(SIEGE_TAG);
    assert.equal(onSand.length, 3, "twelve assault is three attackers at four equivalents each");
    assert.deepEqual([...new Set(onSand.map((mob) => mob.typeId))].sort(), ["minecraft:husk", "minecraft:vindicator"], "sand takes husks, and a large force puts a brute in front");
    for (const mob of onSand) {
        assertBesieger(mob, areas, { x: 0, z: 0 }, desert.config);
    }

    // the same district, this time the approach is a lake
    builtWorld({ field: { lakes: [{ x: 0, z: 0, r: 120 }] } });
    threaten("district-1", { assault: 8, security: "breached" });
    const drowned = createSiegeDriver();
    drowned.onHour(context());
    const inWater = withTag(SIEGE_TAG);
    assert.ok(inWater.length > 0, "a flooded approach does not cancel the siege");
    assert.deepEqual([...new Set(inWater.map((mob) => mob.typeId))], ["minecraft:drowned"], "water takes drowned");
    assert.equal(inWater.every((mob) => mob.y <= 69), true, "they stand in the water, not on dry ground that is not there");
});

test("creeper, enderman and vex can never be selected, whatever a config or a threat asks for", () => {
    assert.deepEqual([...SIEGE_REFUSED_TYPES].sort(), ["minecraft:creeper", "minecraft:enderman", "minecraft:vex"], "the refusal list is in the code, not only in the prose");
    const hostile = createSiegeDriver({
        config: { types: { raider: "minecraft:creeper", desert: "minecraft:creeper", water: "minecraft:enderman", large: "minecraft:vex" } },
    });
    // asked directly, on every branch the roster can take
    assert.equal(spawnableType("minecraft:creeper", hostile.config), "minecraft:pillager", "a creeper proposal falls back");
    assert.equal(spawnableType("minecraft:enderman", hostile.config), "minecraft:pillager");
    assert.equal(spawnableType("minecraft:vex", hostile.config), "minecraft:pillager");
    assert.equal(attackerTypeFor({ water: true, class: "water", surface: "minecraft:water" }, false, hostile.config), "minecraft:pillager", "a lake cannot be given an enderman");
    assert.equal(attackerTypeFor({ water: false, class: "desert", surface: "minecraft:sand" }, false, hostile.config), "minecraft:pillager", "nor sand a creeper");
    assert.equal(attackerTypeFor({ water: false, class: "bare", surface: "minecraft:stone" }, true, hostile.config), "minecraft:pillager", "nor a large force a vex");

    builtWorld();
    threaten("district-1", { assault: 32, security: "breached" });
    const changes = hostile.onHour(context());
    const band = withTag(SIEGE_TAG);
    assert.ok(band.length > 0, "a refused roster costs the band its flavour, not its existence");
    assert.equal(changes, band.length);
    assert.deepEqual([...new Set(band.map((mob) => mob.typeId))], ["minecraft:pillager"], "every attacker is the vanilla fallback");
    assert.equal(entityList().filter((one) => SIEGE_REFUSED_TYPES.includes(one.typeId)).length, 0, "nothing refused is anywhere in the world");

    // and a threat that asks for a big force still cannot reach the refusal list through the default config
    const plain = createSiegeDriver();
    assert.equal(spawnableType(plain.config.types.large, plain.config), "minecraft:vindicator", "the default brute is allowed");
    assert.equal(SIEGE_REFUSED_TYPES.includes("minecraft:ravager"), false, "ravager is a real type but is not on the roster this module may pick");
    assert.equal(
        Object.values(plain.config.types).every((id) => !SIEGE_REFUSED_TYPES.includes(id) && id !== "minecraft:ravager"),
        true,
        "the whole roster is off the refusal list and block-breaking giants are not on it",
    );
});

/* ------------------------------------------------------------------ *
 * a district with no physical record
 * ------------------------------------------------------------------ */

test("a district the pack has never physically built spawns nothing at all", () => {
    builtWorld([{ x: 0, z: 0 }]);
    // district-4 is in the kingdom's records, pressed and breached, but has no build record and no origin
    const kingdom = savedKingdom();
    const unbuilt = kingdomState.districtById(kingdom, "district-4");
    unbuilt.assault = 20;
    unbuilt.security = "breached";
    store.save(kingdom);

    assert.equal(physicalCentreOf(unbuilt), null, "nothing in the world says where this district is");
    const driver = createSiegeDriver();
    const changes = driver.onHour(context());

    assert.equal(withTag(siegeTagFor("district-4")).length, 0, "no wall, no footprint, no attackers");
    assert.equal(withTag(SIEGE_TAG).length, 0, "and nothing else was spawned either");
    assert.equal(changes, 0, "the hour reports that it changed nothing");
    const row = driver.status().districts.find((one) => one.districtId === "district-4");
    assert.equal(row.desired, 0, "the order for it asked for nobody");
    assert.match(row.reason, /never been built/);

    // a district under attack that WAS built still gets its band in the same world
    builtWorld([{ x: 0, z: 0 }]);
    const both = savedKingdom();
    kingdomState.districtById(both, "district-1").assault = 8;
    kingdomState.districtById(both, "district-1").security = "contested";
    kingdomState.districtById(both, "district-4").assault = 20;
    kingdomState.districtById(both, "district-4").security = "breached";
    store.save(both);
    const second = createSiegeDriver();
    second.onHour(context());
    assert.equal(withTag(siegeTagFor("district-1")).length, 2, "the built district is besieged (assault 8 -> 2 attackers)");
    assert.equal(withTag(siegeTagFor("district-4")).length, 0, "the unbuilt one stays empty beside it");
    assert.equal(withTag(SIEGE_TAG).length, 2, "and the census holds exactly the built district's band");
    assert.deepEqual(
        [...new Set(withTag(SIEGE_TAG).flatMap((mob) => mob.tags.filter((tag) => tag.startsWith("civbesiege:v1:"))))],
        [siegeTagFor("district-1")],
    );
});

/* ------------------------------------------------------------------ *
 * the gate: what the drivers are allowed to do at all
 * ------------------------------------------------------------------ */

test("an unreadable master plan still cannot put an attacker inside a district's land", () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver({
        readPlan: () => {
            throw new Error("the plan slot is unreadable");
        },
    });
    const changes = driver.onHour(context());

    assert.ok(changes > 0, "the siege still happens with no master plan to read: the recorded centre decides");
    // the fallback protection list - what production computes when there is no plan - must still hold
    const areas = civCommands.protectedRects(savedKingdom(), builder.PROTECT_MARGIN, undefined, builder.WRITE_PROTECT_GROW, 0);
    assert.ok(areas.length > 0, "the fallback footprint list is not empty");
    for (const mob of withTag(SIEGE_TAG)) {
        assert.equal(
            builder.inProtectedArea(areas, Math.floor(mob.x), Math.floor(mob.z)),
            false,
            `${mob.id} was placed inside district land with no plan to read`,
        );
    }
    assert.match(driver.status().notes.join("\n"), /the master plan could not be read/);
});

test("no player and no command are involved: a build holding the world keeps the siege out, the hour after does not", () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver();
    const runtime = runtimeWith(driver);

    const token = districtBuilder.reserveJob("civ-build");
    assert.ok(token, "the build job slot is taken");
    const before = blockState();
    hour(runtime);
    assert.equal(withTag(SIEGE_TAG).length, 0, "a district build holds the world, so nobody is placed in it");
    assert.equal(runtime.stats.refusedBusy, 1, "and the refusal is counted, not silent");
    assert.deepEqual(blockState(), before);

    districtBuilder.finishJob(token);
    hour(runtime);
    assert.equal(withTag(SIEGE_TAG).length, 3, "the hour after the build runs the siege");
});

test("the people gate off is a teardown hour the runtime hands the driver, and nothing spawns behind it", () => {
    builtWorld();
    threaten("district-1", { assault: 9, security: "contested" });
    const driver = createSiegeDriver();
    const runtime = runtimeWith(driver);
    hour(runtime);
    const standing = withTag(SIEGE_TAG).length;
    assert.ok(standing > 0);

    // `civ:people off` is not "stop asking": with no removal event in 2.7.0 the runtime still calls the driver,
    // with gateOn false, and its own teardown pass is what empties the world.
    mc.props.set("civ_people", false);
    hour(runtime);
    assert.equal(runtime.stats.teardownHours, 1, "the hour ran as a teardown, not as a spawn");
    assert.equal(withTag(SIEGE_TAG).length, 0, "the gate off sent the whole band away");
    assert.equal(entityList().length, 0, "nothing of ours survives the switch");
    assert.equal(driver.status().reason, "civ:people is off");
    assert.match(driver.status().notes.join("\n"), new RegExp(`${String(standing)} attacker\\(s\\) sent away`), "the teardown says how many left");

    // and a bigger threat cannot be smuggled in through a closed gate
    threaten("district-1", { assault: 24, security: "breached" });
    const changes = driver.onHour({ ...context(), gateOn: false });
    assert.equal(changes, 0, "a closed gate adds no attacker, however large the force");
    assert.equal(withTag(SIEGE_TAG).length, 0);

    mc.props.set("civ_people", true);
    hour(runtime);
    assert.ok(withTag(SIEGE_TAG).length > 0, "the hour after the gate is on brings the siege back");
});

/* ------------------------------------------------------------------ *
 * decision: the invasion director is reachable from the simulation alone
 * ------------------------------------------------------------------ */

test("peace keeps the director off, byte for byte; one pressed district arms it", () => {
    const kingdom = kingdomState.createInitialKingdom();
    const pristine = JSON.stringify(kingdom);
    const threat = invasionThreatOf(kingdom);
    assert.equal(threat.threatened, false, "a kingdom with nothing on the ground is at peace");

    const verdict = armInvasionDirector(kingdom, threat);
    assert.equal(verdict.armed, false);
    assert.equal(verdict.changed, false, "there was nothing to change");
    assert.equal("invasion" in kingdom, false, "no record was created for a peaceful realm");
    assert.equal(JSON.stringify(kingdom), pristine, "byte for byte the same kingdom: the gate really is off unless a threat exists");

    const pressed = kingdomState.createInitialKingdom();
    pressed.districts[2].assault = 6;
    pressed.districts[2].security = "contested";
    const hot = invasionThreatOf(pressed);
    assert.equal(hot.threatened, true, "one pressed district is a real threat");
    assert.deepEqual(hot.districtIds, ["district-3"]);
    const armed = armInvasionDirector(pressed, hot);
    assert.equal(armed.armed, true, "the simulation armed its own director");
    assert.equal(armed.changed, true);
    assert.equal(isInvasionEnabled(pressed.invasion), true);
    assert.equal(pressed.invasion.seed, pressed.seed, "seeded from the kingdom, as enableInvasion does");
    assert.match(pressed.log[0].text, /watch on the borders is raised/);

    // a record that already exists is switched on, never reset
    const keeping = kingdomState.createInitialKingdom();
    keeping.invasion = createInvasionState(7);
    keeping.invasion.sequence = 4;
    armInvasionDirector(keeping, { threatened: true, assault: 5, districtIds: ["district-1"] });
    assert.equal(keeping.invasion.enabled, true);
    assert.equal(keeping.invasion.sequence, 4, "the history of a record survives being armed");
});

test("a lull in a wave in progress does not stand the director down; an ending does", () => {
    const kingdom = kingdomState.createInitialKingdom();
    armInvasionDirector(kingdom, { threatened: true, assault: 6, districtIds: ["district-1"] });
    assert.equal(kingdom.invasion.enabled, true);

    kingdom.invasion.phase = "assault";
    kingdom.invasion.wave = { id: "W0001", districtId: "district-1" };
    const lull = armInvasionDirector(kingdom, { threatened: false, assault: 0, districtIds: [] });
    assert.equal(lull.armed, true, "a band still in the field survives the quiet hour");
    assert.equal(lull.changed, false);
    assert.equal(kingdom.invasion.enabled, true);

    kingdom.invasion.phase = "quiet";
    kingdom.invasion.wave = null;
    const down = armInvasionDirector(kingdom, { threatened: false, assault: 0, districtIds: [] });
    assert.equal(down.armed, false, "no threat and no wave: the watch stands down");
    assert.equal(down.changed, true);
    assert.equal(kingdom.invasion.enabled, false);
    assert.equal(kingdom.invasion.phase, "quiet", "the record is kept, not wiped, so it can be armed again");
});

test("hours of the real tick arm the director by themselves and it starts planning waves", () => {
    builtWorld({
        sites: [
            { x: 0, z: 0 },
            { x: 200, z: 0 },
            { x: -200, z: 0 },
            { x: 400, z: 0 },
            { x: -400, z: 0 },
        ],
    });
    const driver = createSiegeDriver();
    const runtime = runtimeWith(driver);

    let armedAt = -1;
    let sawWave = false;
    let sawPlan = false;
    let sawEntities = 0;
    let overCap = 0;
    let hours = 0;
    for (; hours < 420; hours += 1) {
        const loaded = store.load();
        const advanced = tick.advanceKingdomStep(loaded.kingdom);
        assert.deepEqual(advanced.problems, [], `hour ${String(hours)}: the simulation step stays save-valid`);
        store.save(loaded.kingdom);
        hour(runtime, advanced);

        const kingdom = savedKingdom();
        const record = kingdom.invasion;
        const band = withTag(SIEGE_TAG);
        overCap += band.length > driver.config.maxTotal ? 1 : 0;
        sawEntities = Math.max(sawEntities, band.length);
        if (record !== undefined && isInvasionEnabled(record)) {
            if (armedAt < 0) {
                armedAt = hours;
            }
            if (record.phase !== "quiet" || record.wave !== null) {
                sawWave = true;
            }
            if (record.history.length > 0) {
                sawPlan = true;
            }
        } else {
            assert.equal(band.length, 0, `hour ${String(hours)}: a director that is not armed means no attackers in the world`);
        }
    }

    assert.ok(armedAt >= 0, "the simulation armed its own director by itself, with no command, in 420 hours");
    assert.ok(sawWave, "and the director left quiet and ran a wave: it is reachable from the tick alone");
    assert.ok(sawPlan, "a wave finished and was written to the record's history");
    assert.ok(sawEntities > 0, "real attackers stood outside a wall while it did");
    assert.equal(overCap, 0, "the kingdom-wide cap held in every one of those hours");
    assert.equal(entityList().every((one) => one.tags.includes(SIEGE_TAG)), true, "every entity in the world is one we tagged");
    assert.equal(blockState().writes, 0, "and 420 hours of siege wrote not one block");
});
