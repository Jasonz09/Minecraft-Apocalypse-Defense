// Population representation, runtime boundary: integration/popSync.js run against the fake Bedrock world in
// dev/lib/poptharness.mjs. The reducer's rules are proven in population-lod.test.mjs; this file proves that the
// adapter applies only what the reducer planned, re-checks every action against the live world, survives crashes,
// restarts, corrupt cursors and duplicates, and is not wired into the pack.
//
// `@minecraft/server` is types-only on disk, so a module hook (the same technique as reliability-runtime.test.mjs)
// substitutes a stub for the runtime import in popSync.js. The stub's `world` is never used: every test passes its
// own fake world explicitly.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
const { createInitialKingdom } = await load("kingdom", "state.js");
const { createPopSync } = await load("integration", "popSync.js");
const { POP_CURSOR_KEY, POP_SYNC_DEFAULTS, POP_CURSOR_MAX_BYTES } = await load("population", "settings.js");
const { tagFor, classifyTags } = await load("population", "identity.js");
const { groupIdOf, spotFor, parseGroupId } = await load("population", "groups.js");
const poptharness = await import(pathToFileURL(join(projectRoot, "dev", "lib", "poptharness.mjs")).href);
const { createPopWorld, chunkKeyOf } = poptharness;

const HOMES = {
    "district-1": { x: 0, y: 70, z: 0 },
    "district-2": { x: 200, y: 70, z: 0 },
    "district-3": { x: 400, y: 70, z: 0 },
    "district-4": { x: 0, y: 70, z: 200 },
    "district-5": { x: 200, y: 70, z: 200 },
};
const NEAR_D1 = { name: "Steve", x: 6, y: 70, z: 6 };

/** Deterministic seeded generator for the long runs. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A world with the kingdom stored the way the pack stores it, a player in district-1, and its areas loaded. */
function scenario({ kingdom = createInitialKingdom(), players = [NEAR_D1] } = {}) {
    const pop = createPopWorld({ homes: HOMES });
    pop.setKingdom(kingdom);
    pop.setPlayers(players);
    for (const home of Object.values(HOMES)) {
        pop.loadArea(home.x - 32, home.z - 32, home.x + 64, home.z + 64);
    }
    return pop;
}

/** A sync adapter as an integrator would build it: default players, default kingdom store, injected homes. */
function syncFor(pop, extra = {}) {
    return createPopSync({ world: pop.world, dimension: pop.dimension, homes: () => HOMES, enabled: true, ...extra });
}

/** Only district-1 has people, so the world is small and every number is checkable by hand. */
function onlyDistrictOne(civilians, soldiers) {
    const kingdom = createInitialKingdom();
    for (const district of kingdom.districts) {
        const people = district.id === "district-1" ? { civilians, soldiers } : { civilians: 0, soldiers: 0 };
        district.civilians = people.civilians;
        district.soldiers = people.soldiers;
        const front = Math.floor(people.soldiers * 0.8);
        district.garrison = { front, reserve: people.soldiers - front };
    }
    return kingdom;
}

function spawnsIn(run) {
    return run.applied.filter((entry) => entry.action.op === "spawn");
}

function cursorText(pop) {
    return pop.state.props.get(POP_CURSOR_KEY);
}

function ourTaggedIds(pop, groupId) {
    return [...pop.state.entities.values()].filter((record) => record.alive && record.tags.has(tagFor(groupId))).map((record) => record.id);
}

// ---- default configuration ----------------------------------------------------------------------------------------

test("default: the pack's configuration is off, reconcileOnce refuses and writes nothing, dryRun only reads", () => {
    const pop = scenario();
    const sync = createPopSync({ world: pop.world, dimension: pop.dimension, homes: () => HOMES });
    assert.equal(sync.enabled, false);
    assert.equal(POP_SYNC_DEFAULTS.enabled, false, "the shared defaults say off as well");

    const before = pop.snapshot();
    const mutations = pop.state.mutations;
    const refused = sync.reconcileOnce(10);
    assert.match(refused.refused, /disabled/);
    assert.equal(refused.applied.length, 0);
    assert.equal(pop.state.mutations, mutations, "nothing was written");

    const plan = sync.dryRun(10);
    assert.ok(plan.actions.length > 0, "a player next to district-1 would be served");
    assert.equal(pop.state.mutations, mutations, "dryRun wrote nothing either");
    assert.deepEqual(pop.snapshot(), before);
    assert.equal(pop.liveCount({ ours: true }), 0);
});

/** A real import of the sync or the population modules, not a comment that names them. */
const IMPORTS_SYNC = /import[^;]*from\s+"[^"]*(?:popSync|population\/)[^"]*"/;

test("default: only the gated people driver may reach the population sync", () => {
    const runtimeFiles = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (full.endsWith(".js")) {
                runtimeFiles.push(full);
            }
        }
    };
    walk(scriptsRoot);
    const offenders = [];
    for (const file of runtimeFiles) {
        const rel = file.slice(scriptsRoot.length + 1).split("\\").join("/");
        if (rel === "integration/popSync.js" || rel.startsWith("population/")) {
            continue;
        }
        const source = readFileSync(file, "utf8");
        // An import, not a mention: config.js and the runtime both *describe* the sync in a comment, and a
        // guarantee that turns on prose breaks the first time anyone documents it.
        if (IMPORTS_SYNC.test(source)) {
            offenders.push(rel);
        }
    }
    // The old guarantee was "nothing imports it, so nothing runs". The sync is reachable now, so the guarantee has
    // to come from elsewhere: exactly one door, and that door checks the people gate, which is off in a world that
    // never ran `civ:people on`. A second door, or one that forgot to ask, fails here.
    assert.deepEqual(offenders, ["integration/peopleStreets.js"], "the gated people driver is the only way in");
    for (const rel of offenders) {
        const source = readFileSync(join(scriptsRoot, ...rel.split("/")), "utf8");
        assert.match(source, /peopleGateOn/, `${rel} reaches the population sync without checking the people gate`);
    }

    const adapter = readFileSync(join(scriptsRoot, "integration", "popSync.js"), "utf8");
    assert.ok(!/runInterval|runJob|afterEvents|subscribe\(/.test(adapter), "the adapter never schedules or subscribes by itself");
    assert.ok(!/\bconsole\b/.test(adapter), "no console identifier in pack code");
});

// ---- dry run and apply ----------------------------------------------------------------------------------------------

test("dryRun and reconcileOnce agree: the applied actions are exactly the planned ones, and the cursor follows", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    const plan = sync.dryRun(10);
    const run = sync.reconcileOnce(10);
    assert.deepEqual(run.actions, plan.actions);
    assert.equal(run.applied.length, plan.actions.length);
    assert.equal(run.failed.length, 0);
    assert.equal(run.saved, true);
    assert.equal(spawnsIn(run).length, POP_SYNC_DEFAULTS.maxSpawnsPerTick, "the per-tick spawn budget");
    assert.equal(pop.liveCount({ ours: true }), POP_SYNC_DEFAULTS.maxSpawnsPerTick);
    for (const entry of spawnsIn(run)) {
        const record = pop.state.entities.get(entry.entityId);
        assert.ok(record.tags.has(tagFor(entry.action.groupId)), "every spawn carries its canonical tag");
    }
    assert.match(cursorText(pop), /"v":1/);
});

test("convergence: spawns stay within budget every call, and the world settles on one representative per admitted group", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    let tick = 10;
    let quiet = 0;
    for (let call = 0; call < 40 && quiet < 2; call += 1) {
        tick += 1;
        const run = sync.reconcileOnce(tick);
        assert.ok(spawnsIn(run).length <= POP_SYNC_DEFAULTS.maxSpawnsPerTick, "spawns per tick");
        assert.ok(run.applied.length <= POP_SYNC_DEFAULTS.maxOpsPerTick, "operations per tick");
        quiet = run.actions.length === 0 ? quiet + 1 : 0;
    }
    assert.ok(quiet >= 2, "the world settles");
    assert.equal(pop.liveCount({ ours: true }), POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, "district-1 is served up to its cap");
    for (const [groupId, row] of pop.groupCounts()) {
        assert.equal(row.total, 1, `${groupId} has exactly one representative`);
    }
});

test("restart: a fresh adapter on the same world adopts what exists and spawns nothing it does not need", () => {
    const pop = scenario();
    let tick = 10;
    let quiet = 0;
    const first = syncFor(pop);
    while (quiet < 2) {
        tick += 1;
        quiet = first.reconcileOnce(tick).actions.length === 0 ? quiet + 1 : 0;
    }
    const before = pop.liveCount({ ours: true });
    pop.restart();
    const fresh = syncFor(pop);
    const run = fresh.reconcileOnce(tick + 1);
    assert.equal(run.actions.length, 0, "the representatives already exist, so there is nothing to do");
    assert.equal(run.report.adopted.length, 0, "the cursor already knew them; nothing needed adopting");
    assert.equal(pop.liveCount({ ours: true }), before);
});

test("restart with a lost cursor: every existing representative is adopted from the world, none is duplicated", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    let tick = 10;
    for (let i = 0; i < 6; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    const before = pop.liveCount({ ours: true });
    pop.setRawProperty(POP_CURSOR_KEY, undefined);
    const fresh = syncFor(pop);
    const run = fresh.reconcileOnce(tick + 1);
    assert.equal(run.report.adopted.length, before, "all survivors are adopted from their tags");
    assert.equal(run.actions.length, 0, "and nothing is spawned on top of them");
    assert.equal(pop.liveCount({ ours: true }), before);
});

// ---- crashes ----------------------------------------------------------------------------------------------------------

test("crash after spawns land but before the cursor is saved: the restart adopts them and spawns only the rest", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    // Two spawns, each a spawnEntity plus an addTag, land; the cursor save is the next write and never happens.
    pop.crashAfterMutations(4);
    const crashed = sync.reconcileOnce(10);
    assert.equal(crashed.saved, false, "the cursor was not saved");
    assert.equal(pop.liveCount({ ours: true }), 2, "the two spawns that landed are tagged");

    pop.restart();
    const fresh = syncFor(pop);
    const run = fresh.reconcileOnce(11);
    assert.equal(run.report.adopted.length, 2, "both survivors are adopted, not respawned");
    assert.equal(spawnsIn(run).length, 2, "the next two groups are spawned");
    assert.equal(pop.liveCount({ ours: true }), 4);
    for (const [groupId, row] of pop.groupCounts()) {
        assert.equal(row.total, 1, `${groupId} still has exactly one representative`);
    }
});

test("crash between spawnEntity and addTag: the untagged stray is never retagged or removed, and no group gets two tagged units", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    pop.crashAfterMutations(1); // the spawn lands, its tag write dies
    sync.reconcileOnce(10);
    pop.restart();
    const strays = [...pop.state.entities.values()].filter((record) => record.alive && record.tags.size === 0);
    assert.equal(strays.length, 1, "one untagged unit survives the crash");
    const stray = strays[0].id;

    const fresh = syncFor(pop);
    const run = fresh.reconcileOnce(11);
    assert.equal(run.failed.length, 0);
    assert.ok(pop.state.entities.has(stray), "the stray is still there");
    assert.equal(pop.state.entities.get(stray).tags.size, 0, "and still untagged");
    assert.ok(!pop.state.removals.some((removal) => removal.id === stray), "it was never removed");
    assert.ok(!pop.state.tagWrites.some((write) => write.id === stray), "and never retagged");
    for (const [groupId, row] of pop.groupCounts()) {
        assert.equal(row.total, 1, `${groupId}: one tagged representative`);
    }
});

test("a tag write refused by the engine rolls the just-created unit back, so no stray is left behind", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    pop.failNextTag();
    const run = sync.reconcileOnce(10);
    const rolledBack = run.skipped.filter((entry) => entry.reason === "tag-failed-rolled-back");
    assert.equal(rolledBack.length, 1);
    assert.equal(pop.state.removals.length, 1, "the unit we created was removed again");
    assert.equal(pop.liveCount({ ours: true }), 1, "the other spawn in this call succeeded");
    assert.equal(pop.liveCount(), 1, "no untagged unit is left behind");
});

// ---- identity and the observation window -----------------------------------------------------------------------------

test("spawn guard: a representative that wandered outside the observation window is adopted, not duplicated", () => {
    const pop = scenario();
    const spot = spotFor(HOMES["district-1"], "civ", 0);
    // Far outside the 144-block observation window, in a loaded chunk, still claiming district-1:civ:0.
    pop.loadArea(4990, 4990, 5010, 5010);
    const walker = pop.addEntity({ x: 5000, z: 5000, tags: [tagFor("district-1:civ:0")] });
    assert.ok(spot.x < 100, "the group's own spot is near the player");

    const run = syncFor(pop).reconcileOnce(10);
    assert.ok(
        !run.applied.some((entry) => entry.action.op === "spawn" && entry.action.groupId === "district-1:civ:0"),
        "no second representative is spawned for the group",
    );
    assert.ok(pop.state.entities.has(walker), "the walker is left in place");
    assert.equal(ourTaggedIds(pop, "district-1:civ:0").length, 1);
});

test("orphans and foreign units: a foreign tag and a player's villager are never touched; an unknown-district tag is reported", () => {
    const pop = scenario();
    const foreign = pop.addEntity({ x: 4, z: 4, tags: ["other-pack:guard"] });
    const player = pop.addEntity({ x: 5, z: 5, tags: [] });
    const orphan = pop.addEntity({ x: 6, z: 6, tags: ["civpop:v1:district-9:civ:0"] });
    const before = new Map([foreign, player, orphan].map((id) => [id, [...pop.state.entities.get(id).tags]]));
    const sync = syncFor(pop);
    let report = null;
    for (let tick = 10; tick < 26; tick += 1) {
        report = sync.reconcileOnce(tick).report;
    }
    for (const [id, tags] of before) {
        assert.ok(pop.state.entities.has(id), `${id} still exists`);
        assert.deepEqual([...pop.state.entities.get(id).tags], tags, `${id} keeps its tags`);
    }
    assert.ok(!pop.state.removals.some((removal) => before.has(removal.id)));
    assert.ok(!pop.state.tagWrites.some((write) => before.has(write.id)));
    assert.deepEqual(report.orphans.map((o) => [o.entityId, o.reason]), [[orphan, "unknown-district"]]);
});

test("duplicate injection: the surplus is removed, the kept representative is the lowest id, and nothing else moves", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    sync.reconcileOnce(10);
    const groupId = "district-1:civ:0";
    const original = ourTaggedIds(pop, groupId)[0];
    const twin = pop.addEntity({ x: spotFor(HOMES["district-1"], "civ", 0).x, z: spotFor(HOMES["district-1"], "civ", 0).z, tags: [tagFor(groupId)] });
    const run = sync.reconcileOnce(11);
    assert.deepEqual(ourTaggedIds(pop, groupId), [original], "one representative remains");
    assert.ok(run.actions.some((a) => a.op === "despawn" && a.entityId === twin && a.reason === "duplicate"));
});

// ---- chunks, unloads and deferred removal ------------------------------------------------------------------------------

test("unloads defer, never remove: a player walks away and the chunks unload, nothing is removed; they reload and the units are adopted", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    let tick = 10;
    for (let i = 0; i < 6; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    const served = pop.liveCount({ ours: true });
    assert.equal(served, POP_SYNC_DEFAULTS.maxPhysicalPerDistrict);

    // The player leaves and the district's chunks unload. The units are invisible; nothing may be removed.
    pop.setPlayers([{ name: "Steve", x: 5000, y: 70, z: 5000 }]);
    pop.unloadArea(-32, -32, 96, 96);
    for (let i = 0; i < 4; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    assert.equal(pop.state.removeAttemptsUnloaded, 0, "no removal was even attempted in an unloaded chunk");
    assert.equal(pop.state.removals.length, 0);

    // The chunks come back while the player is still far away: the units are visible and due, so they go.
    pop.loadArea(-32, -32, 96, 96);
    for (let i = 0; i < 3; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    assert.equal(pop.state.removeAttemptsUnloaded, 0);
    assert.equal(pop.liveCount({ ours: true }), 0, "due units are removed once their chunks are loaded");
});

test("unloads do not respawn: units that were out of sight come back as the same representatives", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    let tick = 10;
    for (let i = 0; i < 6; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    const spawnedBefore = pop.state.spawned.length;
    const idsBefore = ourTaggedIds(pop, "district-1:civ:0");
    pop.unloadArea(-32, -32, 96, 96);
    tick += 1;
    const quietRun = sync.reconcileOnce(tick);
    assert.equal(spawnedBefore, pop.state.spawned.length, "no spawn while the area is invisible");
    assert.equal(quietRun.applied.length, 0);
    pop.loadArea(-32, -32, 96, 96);
    tick += 1;
    const back = sync.reconcileOnce(tick);
    assert.equal(spawnsIn(back).length, 0, "the representatives are seen again, not replaced");
    assert.deepEqual(ourTaggedIds(pop, "district-1:civ:0"), idsBefore);
});

// ---- cursor -----------------------------------------------------------------------------------------------------------

test("cursor: a corrupt cursor is survivable and is rewritten; a newer cursor is refused and never overwritten", () => {
    const pop = scenario();
    const sync = syncFor(pop);
    sync.reconcileOnce(10);

    pop.setRawProperty(POP_CURSOR_KEY, "{garbage");
    const survived = sync.reconcileOnce(11);
    assert.equal(survived.refused, null, "a corrupt cursor does not stop the sync");
    assert.ok(pop.liveCount({ ours: true }) >= 2, "the representatives from the first run are kept");
    for (const [groupId, row] of pop.groupCounts()) {
        assert.equal(row.total, 1, `${groupId} is not duplicated after a corrupt cursor`);
    }
    assert.match(cursorText(pop), /"v":1/, "the cursor is rewritten in a valid form");

    const newer = JSON.stringify({ v: 2, t: 1, n: 1, s: 0, o: 0, p: [] });
    pop.setRawProperty(POP_CURSOR_KEY, newer);
    const mutations = pop.state.mutations;
    const refused = sync.reconcileOnce(12);
    assert.match(refused.refused, /newer than this pack/);
    assert.equal(pop.state.mutations, mutations, "nothing is written when the cursor is newer");
    assert.equal(cursorText(pop), newer, "the newer cursor is left exactly as it was");
});

test("cursor: only its own key is ever written, and the kingdom record is never changed by the sync", () => {
    const pop = scenario();
    const kingdomBefore = pop.state.props.get("civ:kingdom");
    const sync = syncFor(pop);
    for (let tick = 10; tick < 30; tick += 1) {
        sync.reconcileOnce(tick);
    }
    assert.ok(pop.state.propertyWrites.every((write) => write.key === POP_CURSOR_KEY), "only civ_pop is written");
    assert.equal(pop.state.props.get("civ:kingdom"), kingdomBefore, "the kingdom record is byte-for-byte unchanged");
    assert.ok(cursorText(pop).length <= POP_CURSOR_MAX_BYTES);
});

// ---- records: growth and shrinkage flow into the world -----------------------------------------------------------------

test("records: a shrinking district has its representatives removed once their chunks are loaded (never while unloaded)", () => {
    const pop = scenario({ kingdom: onlyDistrictOne(80, 0) });
    const sync = syncFor(pop);
    let tick = 10;
    for (let i = 0; i < 6; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    assert.equal(pop.liveCount({ ours: true }), POP_SYNC_DEFAULTS.maxPhysicalPerDistrict);

    pop.setKingdom(onlyDistrictOne(0, 0));
    for (let i = 0; i < 4; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    assert.equal(pop.liveCount({ ours: true }), 0, "an emptied district has no representatives left");
    assert.equal(pop.state.removeAttemptsUnloaded, 0);
});

test("records: a growing district admits its new partial group only as the cap allows", () => {
    const pop = scenario({ kingdom: onlyDistrictOne(80, 0) });
    const sync = syncFor(pop);
    let tick = 10;
    for (let i = 0; i < 6; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    pop.setKingdom(onlyDistrictOne(85, 0));
    for (let i = 0; i < 3; i += 1) {
        tick += 1;
        sync.reconcileOnce(tick);
    }
    assert.equal(pop.liveCount({ ours: true }), POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, "the cap holds while the district grows");
    assert.equal(ourTaggedIds(pop, "district-1:civ:8").length, 0, "the new group waits its turn behind the cap");
});

// ---- long seeded run through the adapter ---------------------------------------------------------------------------------

/**
 * A long run against the adapter: player movement, chunk unloads and loads, crashes at random write counts, restarts,
 * lost and corrupt cursors, duplicate and foreign injection, kingdom growth and shrinkage. Invariants are checked after
 * every completed reconcile (one that saved its cursor). Returns a snapshot for the determinism check.
 */
function longRun(seed, steps) {
    const random = rng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const pop = scenario();
    let sync = syncFor(pop);
    let tick = 10;
    const protectedIds = new Set();
    const stats = { completed: 0, crashed: 0, restarted: 0, spawns: 0, despawns: 0, duplicates: 0 };

    const groupIds = () => {
        const kingdom = pop.storedKingdom();
        return kingdom.districts.flatMap((district) => {
            const civ = Math.ceil(district.civilians / 10);
            const sol = Math.ceil(district.soldiers / 5);
            return [
                ...Array.from({ length: civ }, (_u, i) => `${district.id}:civ:${String(i)}`),
                ...Array.from({ length: sol }, (_u, i) => `${district.id}:sol:${String(i)}`),
            ];
        });
    };

    for (let step = 0; step < steps; step += 1) {
        tick += 1;
        const roll = random();
        const ids = groupIds();
        if (roll < 0.15) {
            const home = pick(Object.values(HOMES));
            pop.setPlayers(random() < 0.1 ? [{ name: "Steve", x: 5000, y: 70, z: 5000 }] : [{ name: "Steve", x: home.x + 6, y: 70, z: home.z + 6 }]);
        } else if (roll < 0.25 && ids.length > 0) {
            const spot = spotFor(HOMES[parseGroupId(pick(ids)).district], "civ", 0);
            const key = chunkKeyOf(spot.x, spot.z);
            if (pop.state.loaded.has(key)) {
                pop.state.loaded.delete(key);
            } else {
                pop.state.loaded.add(key);
            }
        } else if (roll < 0.3 && ids.length > 0) {
            const groupId = pick(ids);
            const holders = ourTaggedIds(pop, groupId).filter((id) => pop.state.loaded.has(chunkKeyOf(pop.state.entities.get(id).x, pop.state.entities.get(id).z)));
            if (holders.length > 0) {
                const source = pop.state.entities.get(pick(holders));
                pop.addEntity({ x: source.x, z: source.z, tags: [...source.tags] });
            }
        } else if (roll < 0.34 && ids.length > 0) {
            const parsed = parseGroupId(pick(ids));
            const spot = spotFor(HOMES[parsed.district], parsed.kind, parsed.index);
            if (pop.state.loaded.has(chunkKeyOf(spot.x, spot.z))) {
                protectedIds.add(pop.addEntity({ x: spot.x, z: spot.z, tags: ["other-pack:guard"] }));
            }
            protectedIds.add(pop.addEntity({ x: spot.x + 1, z: spot.z, tags: [] }));
        } else if (roll < 0.37) {
            const kingdom = pop.storedKingdom();
            const district = pick(kingdom.districts);
            const civilians = Math.floor(random() * 121);
            const soldiers = Math.floor(random() * 41);
            district.civilians = civilians;
            district.soldiers = soldiers;
            const front = Math.floor(soldiers * 0.8);
            district.garrison = { front, reserve: soldiers - front };
            pop.setKingdom(kingdom);
        } else if (roll < 0.4) {
            sync = syncFor(pop); // restart: a new adapter on the same world
            stats.restarted += 1;
        } else if (roll < 0.42) {
            pop.setRawProperty(POP_CURSOR_KEY, random() < 0.5 ? undefined : "{broken");
        }

        // Some runs crash partway through. The crash point is a write count from now.
        const crashing = random() < 0.12;
        if (crashing) {
            pop.crashAfterMutations(Math.floor(random() * 7));
        }
        let run;
        try {
            run = sync.reconcileOnce(tick);
        } catch (error) {
            // Only a dead process can throw out of reconcileOnce (a read after the crash point); anything else is a bug.
            if (!crashing || !(error instanceof poptharness.Crash)) {
                throw error;
            }
            run = { saved: false, refused: null, applied: [], failed: [], actions: [] };
        }
        if (crashing) {
            pop.restart();
            sync = syncFor(pop);
            stats.crashed += 1;
            continue;
        }
        if (run.refused !== null) {
            // refused by a newer cursor, or by an invalid kingdom: nothing may have been written
            continue;
        }
        if (!run.saved) {
            continue;
        }
        stats.completed += 1;
        stats.spawns += spawnsIn(run).length;
        stats.despawns += run.applied.filter((entry) => entry.action.op === "despawn").length;
        stats.duplicates += run.applied.filter((entry) => entry.action.reason === "duplicate").length;

        assert.ok(spawnsIn(run).length <= POP_SYNC_DEFAULTS.maxSpawnsPerTick, `step ${String(step)}: spawns per tick`);
        assert.ok(run.applied.length <= POP_SYNC_DEFAULTS.maxOpsPerTick, `step ${String(step)}: operations per tick`);
        assert.equal(run.failed.length, 0, `step ${String(step)}: no action failed`);
        assert.equal(pop.state.removeAttemptsUnloaded, 0, `step ${String(step)}: no removal in an unloaded chunk`);
        for (const [groupId, row] of pop.groupCounts()) {
            assert.ok(row.total <= 1, `step ${String(step)}: ${String(row.total)} representatives for ${groupId}`);
        }
        for (const id of protectedIds) {
            const record = pop.state.entities.get(id);
            assert.ok(record !== undefined, `step ${String(step)}: protected unit ${id} vanished`);
        }
        assert.ok(pop.state.removals.every((removal) => !protectedIds.has(removal.id)), `step ${String(step)}: a protected unit was removed`);
        assert.ok(pop.state.tagWrites.every((write) => !protectedIds.has(write.id)), `step ${String(step)}: a protected unit was retagged`);
        assert.ok(pop.state.propertyWrites.every((write) => write.key === POP_CURSOR_KEY), "only the cursor is written");
    }

    // Convergence: everything loaded, one player fixed next to district-1, run until quiet.
    for (const home of Object.values(HOMES)) {
        pop.loadArea(home.x - 32, home.z - 32, home.x + 64, home.z + 64);
    }
    pop.setPlayers([NEAR_D1]);
    let quiet = 0;
    for (let i = 0; i < 80 && quiet < 2; i += 1) {
        tick += 1;
        const run = sync.reconcileOnce(tick);
        quiet = run.saved && run.applied.length === 0 ? quiet + 1 : 0;
    }
    assert.ok(quiet >= 2, `seed ${String(seed)} did not settle`);
    for (const [groupId, row] of pop.groupCounts()) {
        assert.equal(row.total, 1, `seed ${String(seed)}: ${groupId} settled with ${String(row.total)} representatives`);
    }
    for (const id of protectedIds) {
        assert.ok(pop.state.entities.has(id), "protected units survive to the end");
    }
    return { stats, snapshot: JSON.stringify(pop.snapshot()) };
}

test("long run through the adapter: crashes, restarts, lost cursors, duplicates, movement and growth never break an invariant (5 seeds x 160 steps)", () => {
    const totals = { completed: 0, crashed: 0, restarted: 0, spawns: 0, despawns: 0, duplicates: 0 };
    for (let seed = 1; seed <= 5; seed += 1) {
        const { stats } = longRun(seed, 160);
        for (const key of Object.keys(totals)) {
            totals[key] += stats[key];
        }
    }
    for (const key of ["completed", "crashed", "restarted", "spawns", "despawns", "duplicates"]) {
        assert.ok(totals[key] > 0, `coverage: ${key} never happened`);
    }
    process.stdout.write(`  population adapter run coverage over 5 seeds: ${JSON.stringify(totals)}\n`);
});

test("long run through the adapter is deterministic: the same seed leaves the same world, byte for byte", () => {
    assert.equal(longRun(7, 90).snapshot, longRun(7, 90).snapshot);
});

test("the adapter is the runtime boundary: it imports @minecraft/server, and the pack never imports the fake world", () => {
    const adapter = readFileSync(join(scriptsRoot, "integration", "popSync.js"), "utf8");
    assert.match(adapter, /from "@minecraft\/server"/, "integration files are the runtime boundary");
    assert.ok(!/poptharness/.test(adapter), "the pack never imports the fake world");
    assert.equal(tagFor(groupIdOf("district-1", "civ", 0)), "civpop:v1:district-1:civ:0");
    assert.deepEqual(classifyTags([tagFor("district-1:civ:0")]).claims, ["district-1:civ:0"]);
});
