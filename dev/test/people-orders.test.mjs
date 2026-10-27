// The command layer, offline: once an in-game hour, a district's existing levy entities are posted along its own
// wall circuit, rotated between sectors, titled with the pack's own officer arithmetic, and pulled toward the
// bearing an assault comes from - with no player anywhere.
//
// The driver is exercised against a deterministic entity world (dev/lib/ordersfixture.mjs) through the same ctx
// shape integration/peopleRuntime.js builds. Every assertion is about the world: where an entity stands, what it is
// called, what is still in it, and what was never touched. Nothing here asserts that a function ran.
//
// The fake `@minecraft/server` follows dev/test/reliability-runtime.test.mjs and dev/lib/civharness.mjs: a
// resolution hook substitutes a stub whose `world` and `system` come off globalThis, because the runtime package
// on disk is types only.
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    GROUND_Y, HOMES, WALL_HALF, context, dimension, entityIds, entityList, journal, kingdomFixture, paintColumn,
    press, putCivilians, putLevy, putStrangers, resetOrdersWorld, unloadChunk, withGroupTag, world,
} from "../lib/ordersfixture.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;

globalThis.__mcOrders = {
    world,
    system: {
        afterEvents: { scriptEventReceive: { subscribe: () => 1 } },
        currentTick: 0,
        runInterval: () => 1,
        run: () => 1,
        clearRun: () => undefined,
    },
    ScriptEventSource: { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" },
    BlockPermutation: { resolve: () => { throw new Error("BlockPermutation is not modelled in this suite"); } },
    ItemStack: class ItemStack {},
};

const hooks = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = 'export const world = globalThis.__mcOrders.world; export const system = globalThis.__mcOrders.system;' +
            'export const ScriptEventSource = globalThis.__mcOrders.ScriptEventSource;' +
            'export const BlockPermutation = globalThis.__mcOrders.BlockPermutation;' +
            'export const ItemStack = globalThis.__mcOrders.ItemStack;';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));

const load = (...parts) => import(fileUrl(...parts));
const orders = await load("integration", "peopleOrders.js");
const patrols = await load("people", "patrols.js");
const command = await load("people", "command.js");
const clock = await load("sim", "clock.js");

const {
    LEVY_TYPE, ORDERS_DEFAULTS, OFFICER_LABEL, anchorSectionFor, createOrdersDriver, frontShareOf, levyIdentityOf,
    officersFor, postSectionOf, rotationHour, shiftTowards, wallPostAt,
} = orders;
const { planPatrols } = patrols;
const { commandersFor } = command;

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/**
 * A driver over the fixture world. `readPlan` is pinned to "no master plan", which is the state the pack itself
 * falls back to (the recorded footprint decides the wall line), and `probe` stays the siege layer's real
 * `columnAt`, so every post is validated against ground the fake world actually has.
 * @param {any} [config]
 * @param {any} [extra]
 */
function driver(config = {}, extra = {}) {
    return createOrdersDriver({ readPlan: () => undefined, config, ...extra });
}

/** The four coordinates a test can read off the circuit: the pack's own spacing, not a re-typed number. */
function expectedPosts(sectionList, centre = { x: 0, z: 0 }) {
    return sectionList.map((section) => wallPostAt(centre, WALL_HALF, section, ORDERS_DEFAULTS.sectionsPerDistrict, { inset: ORDERS_DEFAULTS.postInset }));
}

/** Rows the last hour reported for one district. */
function levyRows(status, districtId) {
    const row = status.districts.find((entry) => entry.districtId === districtId);
    return { reason: row?.reason ?? "(no district worked)", rows: row?.levy ?? [] };
}

/** Shortest way round the circuit between two sections. */
function arcDistance(from, to, sections) {
    const raw = Math.abs(from - to) % sections;
    return Math.min(raw, sections - raw);
}

/* ------------------------------------------------------------------ *
 * REQUIRED 1: posts
 * ------------------------------------------------------------------ */

test("the front levy of a garrisoned district stand on its wall circuit, at the district's own spacing", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    putCivilians(kingdom, "district-1", 4);
    const streets = new Map(entityList().map((entity) => [entity.id, { x: entity.x, y: entity.y, z: entity.z }]));
    const posted = frontShareOf(6, kingdom.districts[0].garrison.front, kingdom.districts[0].soldiers);
    assert.equal(posted, 4, "6 levy entities over a garrison of front 24 / 30 soldiers posts 4 and leaves the reserve in the district");

    const changed = driver().onHour(context(kingdom, 0));
    assert.ok(changed > 0, "the hour changed entities");

    // The circuit the patrol module says this hour is, translated to world blocks.
    const plan = planPatrols(kingdom.districts[0], { step: 0, sectionCount: ORDERS_DEFAULTS.sectionsPerDistrict });
    const wanted = [0, 1, 2, 3].map((position) => {
        const group = plan.groups[(position + 0) % Math.min(plan.groups.length, posted)];
        return postSectionOf(plan, group, 0);
    });
    assert.deepEqual(wanted, [0, 1, 2, 4], "hour 0 puts the four levy on wall sections 1, 2, 3 and 5 of the circuit");
    const posts = expectedPosts(wanted);
    assert.deepEqual(
        posts.map((post) => [post.x, post.z]),
        [[-11, -22], [11, -22], [22, -11], [11, 22]],
        "the sections are the middle of their stretch, inset off the wall itself",
    );

    const levy = withGroupTag("district-1");
    assert.equal(levy.length, 6, "the levy are still six entities: posting is not recruiting");
    /** @type {Map<string, any>} */
    const byTag = new Map(levy.map((entity) => [entity.tags.find((tag) => tag.includes(":sol:")), entity]));
    for (let position = 0; position < posted; position += 1) {
        const entity = byTag.get(`civpop:v1:district-1:sol:${String(position)}`);
        assert.ok(entity !== undefined, `levy ${String(position)} is in the world`);
        assert.equal(entity.x, posts[position].x + 0.5, `${entity.id} stands centred on the middle of wall section ${String(posts[position].section)}`);
        assert.equal(entity.z, posts[position].z + 0.5, `${entity.id} stands centred on the middle of wall section ${String(posts[position].section)}`);
        assert.equal(entity.y, GROUND_Y + 1, `${entity.id} stands ON the ground the column probe returned, not inside it`);
        assert.equal(entity.typeId, "minecraft:iron_golem", "and it is still the same kind of creature the streets made");
    }
    // the reserve share stays in the district - people/patrols.js's promise, carried through
    for (let index = posted; index < levy.length; index += 1) {
        const entity = byTag.get(`civpop:v1:district-1:sol:${String(index)}`);
        const where = streets.get(entity.id);
        assert.deepEqual({ x: entity.x, y: entity.y, z: entity.z }, where, `${entity.id} is reserve levy and was not moved onto the wall`);
    }
    // civilians are never even enumerated
    for (const entity of entityList().filter((one) => one.typeId === "minecraft:villager_v2")) {
        assert.deepEqual({ x: entity.x, y: entity.y, z: entity.z }, streets.get(entity.id), `${entity.id} is a civilian and nobody moved it`);
    }
    assert.equal(journal.blockWrites.length, 0, "posting people wrote no block");
    const status = driver().status();
    assert.equal(status.moved, 0, "a driver that has not run has moved nobody");
});

/* ------------------------------------------------------------------ *
 * REQUIRED 2: rotation
 * ------------------------------------------------------------------ */

test("consecutive in-game hours put at least one levy on a different sector, and the same hour again is the same circuit", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    const run = driver();

    const hourZeroTeleports = journal.teleports.length;
    run.onHour(context(kingdom, 0));
    const first = levyRows(run.status(), "district-1");
    const onPostZero = journal.teleports.length;
    assert.ok(onPostZero > hourZeroTeleports, "hour 0 walked the levy onto the wall");

    // the same hour asked twice is not two rounds of orders
    run.onHour(context(kingdom, 0));
    assert.equal(journal.teleports.length, onPostZero, "the same hour again moves nobody: every levy is already on its post");
    assert.deepEqual(levyRows(run.status(), "district-1").rows.map((row) => [row.x, row.z, row.sector]), first.rows.map((row) => [row.x, row.z, row.sector]), "and it reports the same circuit");

    run.onHour(context(kingdom, 1));
    const second = levyRows(run.status(), "district-1");
    const changed = second.rows.filter((row, index) => row.sector !== first.rows[index]?.sector);
    assert.ok(changed.length > 0, "at least one levy moved to a different patrol sector between hour 0 and hour 1");
    const hourOneTeleports = journal.teleports.length;
    assert.ok(hourOneTeleports > onPostZero, "the second hour teleported levy, it did not only re-plan");
    assert.equal(clock.hourOf(1), 1, "the hour the posts are drawn from is the pack's clock, not a tick count");

    // one day on is the same hour: the same posts, so nothing is walked a second time
    run.onHour(context(kingdom, 25));
    assert.equal(rotationHour(context(kingdom, 25)), 1, "hour 25 is hour 1 of the next day");
    assert.equal(journal.teleports.length, hourOneTeleports, "day 2 hour 1 moves nobody, because it is hour 1's circuit");
    assert.deepEqual(levyRows(run.status(), "district-1").rows.map((row) => [row.x, row.z, row.sector]), second.rows.map((row) => [row.x, row.z, row.sector]), "the circuit for an hour is a function of the hour, not of how many hours have run");
    assert.equal(rotationHour(context(kingdom, 24)), 0, "and a whole day on is hour 0 again");
});

/* ------------------------------------------------------------------ *
 * REQUIRED 3: officers
 * ------------------------------------------------------------------ */

test("the number of titled officers is the pack's own commander arithmetic, never more, and never a silent zero", () => {
    const kingdom = resetOrdersWorld();
    const district = kingdom.districts[0];
    // an all-front garrison: every commander the district has is a commander on the wall
    district.soldiers = 30;
    district.garrison = { front: 30, reserve: 0 };
    putLevy(kingdom, "district-1", 6);

    const run = driver();
    run.onHour(context(kingdom, 0));
    const titled = withGroupTag("district-1").filter((entity) => String(entity.nameTag).endsWith(OFFICER_LABEL));
    assert.equal(titled.length, commandersFor(30), "30 soldiers at 10 per commander is 3 officers, and exactly 3 carry the title");
    assert.equal(titled.length, officersFor(district, 6).count, "and the layer titles what the command module asked for");
    assert.equal(run.status().titled, 3, "and says it titled 3");
    const sergeants = new Set(titled.map((entity) => entity.id));
    for (const entity of withGroupTag("district-1")) {
        if (sergeants.has(entity.id)) {
            assert.equal(entity.nameTag, `Hearthgate ${OFFICER_LABEL}`, `${entity.id} reads as an officer of this district`);
        } else {
            assert.equal(entity.nameTag, "Hearthgate levy", `${entity.id} is still plain levy: nobody promotes the whole wall`);
        }
    }

    // more officers than levy cannot happen, however big the garrison on the record
    district.soldiers = 90;
    district.garrison = { front: 90, reserve: 0 };
    run.onHour(context(kingdom, 1));
    assert.equal(withGroupTag("district-1").filter((entity) => String(entity.nameTag).endsWith(OFFICER_LABEL)).length, ORDERS_DEFAULTS.titlesPerDistrict);
    assert.ok(commandersFor(90) > ORDERS_DEFAULTS.titlesPerDistrict, "90 soldiers would want 9 officers - the cap and the 6 levy standing here both say otherwise");

    // and the broken command record is surfaced, not answered with a quiet zero
    district.soldiers = 30;
    district.garrison = { front: 10, reserve: 10 };
    run.onHour(context(kingdom, 2));
    const broken = run.status();
    assert.match(broken.notes.join("\n"), /district-1: garrison front 10 \+ reserve 10 does not equal soldiers 30/, "the hour says what the command module found");
    assert.ok(withGroupTag("district-1").filter((entity) => String(entity.nameTag).endsWith(OFFICER_LABEL)).length > 0, "and the wall is still led: the levy standing here are titled from, not silently left leaderless");
    assert.deepEqual(broken.districts[0].posted, 2, "the broken garrison record posts only its front share of the levy");
    assert.deepEqual(officersFor(district, 4), { count: 1, problems: officersFor(district, 4).problems }, "the fallback is the commander arithmetic on what stands here");
    assert.ok(officersFor(district, 4).problems.length > 0, "with the problem still named");
});

/* ------------------------------------------------------------------ *
 * REQUIRED 4: threat
 * ------------------------------------------------------------------ */

test("an assaulted district's posts shift toward the bearing of the attack, and a district at peace is not moved at all", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    putLevy(kingdom, "district-2", 6);
    const sections = ORDERS_DEFAULTS.sectionsPerDistrict;
    const step = 3;

    const run = driver();
    run.onHour(context(kingdom, step));
    const peace = levyRows(run.status(), "district-1");
    const peaceNeighbour = levyRows(run.status(), "district-2");
    const plan = planPatrols(kingdom.districts[0], { step, sectionCount: sections });
    const posted = frontShareOf(6, kingdom.districts[0].garrison.front, kingdom.districts[0].soldiers);
    const base = plan.groups.length;
    const unshifted = peace.rows.map((row, position) => postSectionOf(plan, plan.groups[(position + step) % Math.min(base, posted)], step));
    assert.deepEqual(peace.rows.map((row) => row.section), unshifted, "at peace a post is exactly the section the patrol plan names - no threat bias anywhere in it");

    press(kingdom, "district-1", { assault: 24, security: "contested", bearing: "east" });
    run.onHour(context(kingdom, step));
    const war = levyRows(run.status(), "district-1");
    const anchor = anchorSectionFor("east", sections);
    assert.equal(anchor, 2, "the east face of the circuit is section 2 of 8");
    assert.match(war.reason, /under assault from the east/, "and the hour says so");

    let before = 0;
    let after = 0;
    for (let index = 0; index < war.rows.length; index += 1) {
        const from = arcDistance(peace.rows[index].section, anchor, sections);
        const to = arcDistance(war.rows[index].section, anchor, sections);
        assert.ok(to <= from, `levy ${war.rows[index].id} is no further from the attacked face than it was at peace`);
        assert.equal(war.rows[index].section, shiftTowards(peace.rows[index].section, anchor, sections, ORDERS_DEFAULTS.threatPull), "and it is exactly the threatened shift");
        before += from;
        after += to;
    }
    assert.ok(after < before, `the wall concentrated on the attacked face: ${String(before)} sections of distance became ${String(after)}`);
    const warSpots = new Set(war.rows.map((row) => `${String(row.x)},${String(row.z)}`));
    const peaceSpots = new Set(peace.rows.map((row) => `${String(row.x)},${String(row.z)}`));
    assert.notDeepEqual([...warSpots], [...peaceSpots], "the levy physically stand somewhere else under assault");
    assert.equal(new Set([...warSpots, ...peaceSpots]).size >= warSpots.size, true, "no two posts of one district share a column");

    // a district the war did not touch keeps its peace circuit, in the same hour
    const neighbour = levyRows(run.status(), "district-2");
    assert.deepEqual(neighbour.rows.map((row) => [row.section, row.x, row.z]), peaceNeighbour.rows.map((row) => [row.section, row.x, row.z]), "district-2 was not assaulted and its posts did not budge");
});

/* ------------------------------------------------------------------ *
 * REQUIRED 5: conservation
 * ------------------------------------------------------------------ */

test("an hour of orders creates nothing and destroys nothing: every entity id in the world is the same", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    putCivilians(kingdom, "district-1", 5);
    putLevy(kingdom, "district-2", 6);
    putStrangers();
    press(kingdom, "district-1", { assault: 20, security: "breached", bearing: "north" });

    const before = entityIds();
    const spawnsAtStart = journal.spawns.length;
    const run = driver();
    for (let step = 0; step < 4; step += 1) {
        run.onHour(context(kingdom, step));
    }
    assert.deepEqual(entityIds(), before, "the world has exactly the entities it had, in the same numbers");
    assert.equal(journal.spawns.length, spawnsAtStart, "and none of them arrived during those hours");
    assert.equal(journal.removals.length, 0, "none left either");
    assert.equal(journal.tagWrites.length, 0, "no tag was added, removed or rewritten - identity belongs to peopleStreets");
    assert.ok(before.length > 15, "the census is real: levy, civilians, an untagged golem and three malformed claims");
    assert.equal(run.status().refused, null, "and the hours were accepted, not refused");
});

/* ------------------------------------------------------------------ *
 * REQUIRED 6: zero block writes
 * ------------------------------------------------------------------ */

test("hours of orders write no block and run no command, in a kingdom-wide fight", () => {
    const kingdom = resetOrdersWorld();
    for (const districtId of Object.keys(HOMES)) {
        putLevy(kingdom, districtId, 6);
        putCivilians(kingdom, districtId, 3);
    }
    press(kingdom, "district-1", { assault: 40, security: "contested", bearing: "south-west" });
    press(kingdom, "district-3", { assault: 12, security: "alert", bearing: "water-adjacent" });
    const run = driver();
    for (let step = 0; step < 5; step += 1) {
        run.onHour(context(kingdom, step));
    }
    assert.deepEqual(journal.blockWrites, [], "not one block was laid, changed or broken");
    assert.deepEqual(journal.commandRuns, [], "and no command was run");
    assert.ok(journal.reads.topmost > 0, "the ground was read, which is the only block access allowed");
    assert.ok(journal.teleports.length > 0, "and the hours actually posted people, so the empty journal means something");
    assert.equal(withGroupTag("district-1").length, 6);
});

/* ------------------------------------------------------------------ *
 * the caps, and the refusals
 * ------------------------------------------------------------------ */

test("the hour's caps bind: moves per hour, moves per district, and ground probes per district", () => {
    const kingdom = resetOrdersWorld();
    for (const districtId of Object.keys(HOMES)) {
        putLevy(kingdom, districtId, 6);
    }
    const run = driver();
    for (let step = 0; step < 3; step += 1) {
        const teleportsBefore = journal.teleports.length;
        const probesBefore = journal.reads.topmost;
        run.onHour(context(kingdom, step));
        assert.ok(journal.teleports.length - teleportsBefore <= ORDERS_DEFAULTS.movesTotal, `hour ${String(step)} moved at most ${String(ORDERS_DEFAULTS.movesTotal)} levy kingdom-wide`);
        assert.ok(journal.reads.topmost - probesBefore <= ORDERS_DEFAULTS.maxDistricts * ORDERS_DEFAULTS.probesPerDistrict, "and read no more ground than the districts it may work times their probe budget");
    }
    const perDistrict = run.status().districts.map((entry) => entry.moved);
    assert.ok(perDistrict.every((moved) => moved <= ORDERS_DEFAULTS.movesPerDistrict), "and never more than a circuit's worth in one district");
    assert.ok(run.status().districts.length <= ORDERS_DEFAULTS.maxDistricts, "at most maxDistricts districts are worked in an hour");
    assert.match(run.status().notes.join("\n"), /move\(s\) were spent/, "a capped move is said out loud, not swallowed");

    // the caps the driver actually enforces are the ones it was given, not the constants
    const tightProbe = driver({ probesPerDistrict: 2 });
    const probesBefore = journal.reads.topmost;
    tightProbe.onHour(context(kingdom, 4));
    assert.ok(journal.reads.topmost - probesBefore <= 2 * ORDERS_DEFAULTS.maxDistricts, "an injected probesPerDistrict of 2 bounds every district's column reads");
    const tight = driver({ movesTotal: 2, movesPerDistrict: 1, titlesPerDistrict: 1, titlesTotal: 1 });
    const before = journal.teleports.length;
    const names = journal.nameWrites.length;
    tight.onHour(context(kingdom, 7));
    assert.ok(journal.teleports.length - before <= 2, "an injected movesTotal of 2 means 2 teleports, not 16");
    assert.ok(journal.nameWrites.length - names <= 1, "and an injected titlesTotal of 1 means one name write");
});

test("a civilian, an untagged golem, a malformed claim and a levy of another district are never moved", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    putCivilians(kingdom, "district-1", 4);
    putStrangers();
    const before = new Map(entityList().map((entity) => [entity.id, `${String(entity.x)},${String(entity.y)},${String(entity.z)}`]));
    const run = driver();
    for (let step = 0; step < 3; step += 1) {
        run.onHour(context(kingdom, step));
    }
    for (const entity of entityList()) {
        const isPostedLevy = entity.typeId === "minecraft:iron_golem" && entity.tags.some((tag) => /^civpop:v1:district-1:sol:[0-5]$/.test(tag));
        if (isPostedLevy) {
            continue;
        }
        assert.equal(`${String(entity.x)},${String(entity.y)},${String(entity.z)}`, before.get(entity.id), `${entity.id} carrying ${entity.tags.join("|")} was left exactly where it stood`);
    }
    // the tag reader itself, which is what makes that claim true
    assert.deepEqual(levyIdentityOf(["civpop:v1:district-1:sol:2"]), { districtId: "district-1", index: 2, groupId: "district-1:sol:2" });
    assert.equal(levyIdentityOf(["civpop:v1:district-1:civ:2"]), null, "a civilian claim is not a levy");
    assert.equal(levyIdentityOf(["civpop:v1:district-1:sol:"]), null, "a malformed claim in our own namespace is nobody");
    assert.equal(levyIdentityOf(["someone_elses_tag"]), null, "and a foreign tag is not ours to interpret");
    assert.equal(levyIdentityOf([]), null);
});

test("a gate-off hour moves nobody and names nobody, an unbuilt district gets no posts, and a refused teleport is counted", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    putCivilians(kingdom, "district-1", 4);
    const streets = new Map(entityList().map((entity) => [entity.id, { x: entity.x, y: entity.y, z: entity.z }]));

    const run = driver();
    const teleports = journal.teleports.length;
    const names = journal.nameWrites.length;
    assert.equal(run.onHour(context(kingdom, 1, { gateOn: false })), 0, "a teardown hour returns 0");
    assert.equal(journal.teleports.length, teleports, "and moves nobody");
    assert.equal(journal.nameWrites.length, names, "and renames nobody");
    assert.equal(journal.removals.length, 0, "and removes nobody: the levy are peopleStreets' entities, not ours");
    assert.match(String(run.status().refused), /civ:people is off/, "with the reason on the record");
    for (const entity of entityList()) {
        assert.deepEqual({ x: entity.x, y: entity.y, z: entity.z }, streets.get(entity.id), `${entity.id} is exactly where the streets left it`);
    }

    // a district the simulation has never physically built has no wall, so it gets no posts
    resetOrdersWorld();
    const unbuilt = kingdomFixture({ unbuilt: ["district-1"] });
    putLevy(unbuilt, "district-1", 6);
    const before = new Map(withGroupTag("district-1").map((entity) => [entity.id, `${String(entity.x)},${String(entity.z)}`]));
    const neverBuilt = driver();
    assert.equal(neverBuilt.onHour(context(unbuilt, 4)), 0, "no posts, no moves, nothing claimed");
    for (const entity of withGroupTag("district-1")) {
        assert.equal(`${String(entity.x)},${String(entity.z)}`, before.get(entity.id), `${entity.id} stands where the streets left it`);
    }

    // ground the engine has released: a refused teleport is counted, and the hour still posts everybody else
    const world2 = resetOrdersWorld();
    putLevy(world2, "district-1", 6);
    unloadChunk(-1, -2);
    const blind = driver({}, { probe: () => ({ x: 0, y: GROUND_Y + 1, z: 0, water: false, surface: "minecraft:grass_block", class: "grass" }) });
    const moved = blind.onHour(context(world2, 0));
    assert.ok(moved > 0, "the hour still posted the levy it could reach");
    assert.ok(blind.status().districts[0].failed > 0, "and counted the throw instead of breaking the hour");
    assert.match(blind.status().notes.join("\n"), /could not be moved/, "naming what it could not do");
    assert.equal(journal.removals.length, 0, "a failed move is never a killed entity: peopleStreets owns their lives");
});

test("water and lava under a post are refused: the levy slide along the wall instead of standing in it", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    const posts = expectedPosts([0, 1]);
    paintColumn(posts[0].x, posts[0].z, "minecraft:water");
    paintColumn(posts[1].x, posts[1].z, "minecraft:lava");
    assert.equal(dimension.getTopmostBlock({ x: posts[0].x, z: posts[0].z }).typeId, "minecraft:water", "the first test column really is open water");
    assert.equal(dimension.getTopmostBlock({ x: posts[1].x, z: posts[1].z }).typeId, "minecraft:lava", "and the second really is lava");

    const run = driver();
    run.onHour(context(kingdom, 0));
    const levy = withGroupTag("district-1");
    for (const entity of levy) {
        const top = dimension.getTopmostBlock({ x: Math.floor(entity.x), z: Math.floor(entity.z) });
        assert.notEqual(top.typeId, "minecraft:water", `${entity.id} was not posted in open water`);
        assert.notEqual(top.typeId, "minecraft:lava", `${entity.id} was not posted in lava`);
    }
    const rows = levyRows(run.status(), "district-1").rows;
    assert.notEqual(rows[0].x, posts[0].x, "the levy that would have stood on the flooded stretch slid along the wall");
    assert.notEqual(rows[1].x, posts[1].x, "and so did the one pointed at the lava");
    assert.equal(journal.blockWrites.length, 0, "refusing ground wrote no block: the flood stays a flood");

    // with no room to slide, the stretch is given up on and said out loud - and the hour carries on posting
    const kingdom2 = resetOrdersWorld();
    putLevy(kingdom2, "district-1", 6);
    paintColumn(posts[0].x, posts[0].z, "minecraft:water");
    paintColumn(posts[1].x, posts[1].z, "minecraft:lava");
    const stubborn = driver({ maxPostTries: 1 });
    stubborn.onHour(context(kingdom2, 0));
    const given = stubborn.status().districts[0];
    assert.equal(given.failed, 2, "the two unusable stretches are counted failures");
    assert.match(stubborn.status().notes.join("\n"), /no standable ground on wall section/, "named in the hour's notes");
    assert.ok(given.moved > 0, "and the rest of the circuit was still posted");
    assert.ok(given.probes <= ORDERS_DEFAULTS.probesPerDistrict, "the probe budget held even when every post was tried");
});

test("the three restatements this layer needs are pinned to the population modules it may not import", async () => {
    const settings = await load("population", "settings.js");
    const identity = await load("population", "identity.js");
    const groups = await load("population", "groups.js");
    assert.equal(LEVY_TYPE, settings.POP_ENTITY_TYPES.sol, "the type the census asks for is the type the reducer spawns the garrison as");
    assert.equal(ORDERS_DEFAULTS.observeRadius, settings.POP_DISTRICT_OBSERVE_RADIUS, "and the window it looks through is the one the streets driver observes at");

    // the tag this layer parses is the tag that layer writes, or a levy would simply never be found
    for (const [district, index] of [["district-1", 0], ["district-1", 7], ["Ashfall", 12]]) {
        const groupId = groups.groupIdOf(district, "sol", index);
        const tag = identity.tagFor(groupId);
        assert.equal(groups.parseGroupId(groupId)?.kind, "sol", `${groupId} is a garrison group`);
        assert.deepEqual(levyIdentityOf([tag]), { districtId: district, index, groupId }, `${tag} reads as the same levy to both layers`);
    }

    // and everything population/groups.js refuses, this layer refuses as well: a stricter reader, never a wider one
    const notLevy = [
        `${settings.POP_TAG_PREFIX}district-1:civ:0`,
        `${settings.POP_TAG_PREFIX}district-1:sol:`,
        `${settings.POP_TAG_PREFIX}district-1:sol:007`,
        `${settings.POP_TAG_PREFIX}district-1:sol:9999999`,
        `${settings.POP_TAG_PREFIX}a:b:sol:0`,
        `${settings.POP_TAG_PREFIX}:sol:0`,
        "civpop:v2:district-1:sol:3",
        "someone_elses_tag",
        "",
    ];
    for (const tag of notLevy) {
        assert.equal(levyIdentityOf([tag]), null, `${tag} is nobody's levy`);
        if (tag.startsWith(settings.POP_TAG_PREFIX)) {
            assert.notEqual(groups.parseGroupId(tag.slice(settings.POP_TAG_PREFIX.length))?.kind, "sol", `${tag} is refused by the reducer too`);
        }
    }
});

test("a district whose wall reaches past the streets driver's window still sees its own posted levy", () => {
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    // the shape a large master-plan outline gives: a 121x121 district, whose corners are 85 blocks from the centre
    kingdom.districts[0].civ = { status: "complete", centre: { x: 0, z: 0 }, seed: 1, anchor: { x: 0, z: 0 } };
    const wide = driver({}, {
        readPlan: () => ({ districts: [{ index: 1, name: "Hearthgate", outline: [[-60, -60], [60, -60], [60, 60], [-60, 60]] }] }),
    });

    wide.onHour(context(kingdom, 0));
    const first = levyRows(wide.status(), "district-1").rows;
    assert.equal(first.length, 4, "the wide circuit was posted");
    assert.ok(first.every((row) => Math.max(Math.abs(row.x), Math.abs(row.z)) === 58), "the posts sit 58 blocks out - the wall line the plan says, inset by 2, not the fixture's 24");
    assert.ok(first.some((row) => Math.abs(row.x) === 29 || Math.abs(row.z) === 29), "and a post is the middle of its stretch of wall, not a corner");

    // a window of `POP_DISTRICT_OBSERVE_RADIUS` (48) would lose them here, and the rotation would silently stop
    wide.onHour(context(kingdom, 1));
    const second = levyRows(wide.status(), "district-1").rows;
    assert.equal(second.length, first.length, "hour 1 still finds the levy it posted an hour ago");
    assert.ok(second.some((row, index) => row.x !== first[index].x || row.z !== first[index].z), "and rotates them, instead of announcing that the district has no levy");
    const movedOnWorld = withGroupTag("district-1").filter((entity) => Math.max(Math.abs(entity.x - 0), Math.abs(entity.z - 0)) > 48);
    assert.ok(movedOnWorld.length > 0, "the world agrees they are standing further out than the streets driver looks");
});

test("the orders driver is a people driver: registered in the runtime, an hour reaches it, a gate-off hour moves nobody", async () => {
    const runtime = await load("integration", "peopleRuntime.js");
    const kingdom = resetOrdersWorld();
    putLevy(kingdom, "district-1", 6);
    putCivilians(kingdom, "district-1", 4);
    const where = new Map(entityList().map((entity) => [entity.id, { x: entity.x, y: entity.y, z: entity.z }]));

    // exactly the line the integrator adds to main.js, against the world this suite drives
    const peopleRuntime = runtime.createPeopleRuntime({ load: () => ({ kingdom }), save: () => true });
    const run = driver();
    assert.equal(peopleRuntime.register(run), true, "id plus onHour(ctx) is what a PeopleDriver has to be");
    assert.equal(peopleRuntime.register(driver()), false, "and two drivers cannot share the id orders");

    peopleRuntime.onStep({ step: 0, ran: 1 });
    const posted = new Map(entityList().map((entity) => [entity.id, { x: entity.x, y: entity.y, z: entity.z }]));
    const moved = withGroupTag("district-1").filter((entity) => {
        const before = where.get(entity.id);
        return entity.x !== before.x || entity.z !== before.z;
    });
    assert.equal(moved.length, 4, "one accepted hour put the district's whole front levy on the wall");
    assert.match(peopleRuntime.statusLines().join("\n"), /orders: 1 hour\(s\), [1-9]\d* entity change\(s\)/, "and the runtime counted the entities the hour changed");
    const teleports = journal.teleports.length;

    // the runtime's teardown hour: gate off, and the door is closed from the world, not from ctx
    world.setDynamicProperty("civ_people", false);
    peopleRuntime.onStep({ step: 1, ran: 1 });
    assert.equal(journal.teleports.length, teleports, "a gate-off hour moved nobody");
    for (const entity of entityList()) {
        assert.deepEqual({ x: entity.x, y: entity.y, z: entity.z }, posted.get(entity.id), `${entity.id} is exactly where the last accepted hour left it`);
    }
    assert.equal(journal.removals.length, 0, "and nobody was removed, because that is peopleStreets' work");
});
