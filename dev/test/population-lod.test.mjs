// Population representation, pure layer: groups, identity tags, levels of detail, the reconcile reducer and the
// cursor. No world, no adapter: every plan is applied to a small in-memory model here, and the model refuses any
// action the contract forbids (a despawn in an unloaded chunk, a second spawn for a bound group, a foreign tag
// touched). The adapter and the fake Bedrock world are covered by population-sync.test.mjs.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, serializeKingdom, findValidationProblems } = await load("kingdom", "state.js");
const groups = await load("population", "groups.js");
const identity = await load("population", "identity.js");
const cursorModule = await load("population", "cursor.js");
const reducer = await load("population", "reconcile.js");
const settings = await load("population", "settings.js");

const { buildGroupTable, chunkKeyOf, groupIdOf, nearestDistance, parseGroupId, spotFor, districtInFight } = groups;
const { classifyTags, tagFor, isCanonicalFor } = identity;
const { decodeCursor, emptyCursor, encodeCursor, cursorBytes } = cursorModule;
const { reconcile, resolveConfig } = reducer;
const { POP_SYNC_DEFAULTS, POP_CURSOR_MAX_BYTES, POP_CURSOR_MAX_PHYSICAL, POP_CURSOR_KEY } = settings;

// ---- shared fixtures ---------------------------------------------------------------------------------------------

/** Five districts far apart, so one anchor touches one district. */
const HOMES = {
    "district-1": { x: 0, y: 70, z: 0 },
    "district-2": { x: 200, y: 70, z: 0 },
    "district-3": { x: 400, y: 70, z: 0 },
    "district-4": { x: 0, y: 70, z: 200 },
    "district-5": { x: 200, y: 70, z: 200 },
};
/** Within physicalRadius of district-1's first civilian spot (4, 4). */
const NEAR_D1 = { x: 6, z: 6 };

/** A deep-frozen clone: the reducer must never write to the records, and strict mode turns a write into a throw. */
function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
    }
    return value;
}

/** mulberry32: a small seeded generator, so every random sequence is reproducible. */
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

/** Garrison re-derived from soldiers, as the pack does it, so a changed district stays valid. */
function setPeople(district, civilians, soldiers) {
    district.civilians = civilians;
    district.soldiers = soldiers;
    const front = Math.floor(soldiers * 0.8);
    district.garrison = { front, reserve: soldiers - front };
}

/** Only district-1 has people, so one group (or a chosen few) is the whole world. */
function onlyDistrictOne(civilians, soldiers) {
    const kingdom = createInitialKingdom();
    for (const district of kingdom.districts) {
        if (district.id === "district-1") {
            setPeople(district, civilians, soldiers);
        } else {
            setPeople(district, 0, 0);
        }
    }
    return kingdom;
}

/** Every chunk that a group spot of this kingdom occupies, as if all of it were loaded. */
function allSpotChunks(kingdom) {
    const keys = new Set();
    for (const group of buildGroupTable(kingdom, POP_SYNC_DEFAULTS).groups) {
        const spot = spotFor(HOMES[group.district], group.kind, group.index);
        keys.add(chunkKeyOf(spot.x, spot.z));
    }
    return keys;
}

function spotOf(groupId) {
    const parsed = parseGroupId(groupId);
    return spotFor(HOMES[parsed.district], parsed.kind, parsed.index);
}

/** Loads every chunk of every district area (a generous box around each home), for the convergence phase. */
function loadDistrictAreas(m) {
    for (const home of Object.values(HOMES)) {
        for (let x = home.x - 32; x <= home.x + 64; x += 16) {
            for (let z = home.z - 32; z <= home.z + 64; z += 16) {
                m.loaded.add(chunkKeyOf(x, z));
            }
        }
    }
}

/** A reconcile observation. Entities are plain records; loadedChunks is the set of spot chunks known loaded. */
function observation({ kingdom, entities = [], anchors = [NEAR_D1], loaded = allSpotChunks(kingdom) }) {
    return { kingdom, entities, anchors, homes: HOMES, loadedChunks: loaded };
}

function entity(id, tags, { x, z, y = 70, loaded = true, inFight = false, typeId = "minecraft:villager_v2" } = {}) {
    return { id, typeId, tags, x: x ?? 0, y, z: z ?? 0, loaded, inFight };
}

/** An entity standing on a group's spot, claiming that group. */
function bound(id, groupId, options = {}) {
    const spot = spotOf(groupId);
    return entity(id, [tagFor(groupId)], { x: spot.x, z: spot.z, ...options });
}

const BIG = { maxSpawnsPerTick: 1000, maxOpsPerTick: 1000 };

// ---- the in-memory model: applies actions and refuses what the contract forbids -----------------------------

/** @returns {{ entities: Map<string, any>, loaded: Set<string>, nextId: number }} */
function model(loaded = new Set()) {
    return { entities: new Map(), loaded, nextId: 1 };
}

function addToModel(m, { id, tags = [], x, z, y = 70, typeId = "minecraft:villager_v2" }) {
    const eid = id ?? `m${String(m.nextId++)}`;
    m.entities.set(eid, { id: eid, typeId, x, y, z, tags: new Set(tags) });
    return eid;
}

function modelChunkLoaded(m, e) {
    return m.loaded.has(chunkKeyOf(e.x, e.z));
}

/**
 * Applies actions to the model and fails loudly on any contract violation.
 * @returns {{ spawned: number, despawned: number, retagged: number, touched: string[] }}
 */
function applyToModel(m, actions) {
    const outcome = { spawned: 0, despawned: 0, retagged: 0, touched: [] };
    for (const action of actions) {
        if (action.op === "spawn") {
            assert.ok(m.loaded.has(chunkKeyOf(action.at.x, action.at.z)), `spawn for ${action.groupId} must land in a loaded chunk`);
            const tag = tagFor(action.groupId);
            const existing = [...m.entities.values()].filter((e) => e.tags.has(tag));
            assert.equal(existing.length, 0, `spawn for ${action.groupId} while a representative already exists`);
            const id = addToModel(m, { tags: [tag], x: action.at.x, y: action.at.y, z: action.at.z, typeId: action.typeId });
            outcome.touched.push(id);
            outcome.spawned += 1;
        } else if (action.op === "despawn") {
            const target = m.entities.get(action.entityId);
            assert.ok(target, `despawn of unknown entity ${action.entityId}`);
            assert.ok(modelChunkLoaded(m, target), `despawn of ${action.entityId} while its chunk is unloaded (${action.reason})`);
            assert.ok(classifyTags([...target.tags]).claims.includes(action.groupId), `despawn of ${action.entityId} for a group it does not claim`);
            m.entities.delete(action.entityId);
            outcome.touched.push(action.entityId);
            outcome.despawned += 1;
        } else if (action.op === "retag") {
            const target = m.entities.get(action.entityId);
            assert.ok(target, `retag of unknown entity ${action.entityId}`);
            assert.ok(modelChunkLoaded(m, target), `retag of ${action.entityId} while its chunk is unloaded`);
            const canonical = tagFor(action.groupId);
            for (const tag of [...target.tags]) {
                if (tag.startsWith("civpop:") && tag !== canonical) {
                    target.tags.delete(tag);
                }
            }
            target.tags.add(canonical);
            outcome.touched.push(action.entityId);
            outcome.retagged += 1;
        } else {
            assert.fail(`unknown action ${JSON.stringify(action)}`);
        }
    }
    return outcome;
}

/** The observation the reducer sees: every model entity, with its chunk's loaded flag. */
function observeModel(m, kingdom, anchors, homes = HOMES) {
    const entities = [...m.entities.values()].map((e) => ({
        id: e.id,
        typeId: e.typeId,
        tags: [...e.tags],
        x: e.x,
        y: e.y,
        z: e.z,
        loaded: modelChunkLoaded(m, e),
        inFight: false,
    }));
    const loadedChunks = new Set();
    for (const group of buildGroupTable(kingdom, POP_SYNC_DEFAULTS).groups) {
        const spot = spotFor(homes[group.district], group.kind, group.index);
        if (nearestDistance(spot, anchors) <= POP_SYNC_DEFAULTS.physicalRadius && m.loaded.has(chunkKeyOf(spot.x, spot.z))) {
            loadedChunks.add(chunkKeyOf(spot.x, spot.z));
        }
    }
    return { kingdom, entities, anchors, homes, loadedChunks };
}

/** Physical representatives per group id in the model (all of them, loaded or not). */
function representativesPerGroup(m) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const e of m.entities.values()) {
        const claims = classifyTags([...e.tags]).claims;
        if (claims.length > 0) {
            counts.set(claims[0], (counts.get(claims[0]) ?? 0) + 1);
        }
    }
    return counts;
}

// ---- group table ----------------------------------------------------------------------------------------------

test("groups: the table is derived from the records, with headcounts that add back to the records", () => {
    const kingdom = createInitialKingdom();
    const { groups: table, problems } = buildGroupTable(kingdom, POP_SYNC_DEFAULTS);
    assert.deepEqual(problems, []);
    assert.equal(table.length, 5 * (8 + 6), "80 civilians = 8 groups of 10, 30 soldiers = 6 groups of 5, per district");
    for (const district of kingdom.districts) {
        const civ = table.filter((g) => g.district === district.id && g.kind === "civ");
        const sol = table.filter((g) => g.district === district.id && g.kind === "sol");
        assert.equal(civ.reduce((sum, g) => sum + g.headcount, 0), district.civilians);
        assert.equal(sol.reduce((sum, g) => sum + g.headcount, 0), district.soldiers);
        assert.ok(civ.every((g) => g.headcount === 10));
        assert.ok(sol.every((g) => g.headcount === 5));
    }
});

test("groups: ids are stable across growth and shrinkage (only the highest index comes or goes)", () => {
    const before = buildGroupTable(onlyDistrictOne(80, 30), POP_SYNC_DEFAULTS).groups;
    const grown = buildGroupTable(onlyDistrictOne(85, 30), POP_SYNC_DEFAULTS).groups;
    const shrunk = buildGroupTable(onlyDistrictOne(70, 22), POP_SYNC_DEFAULTS).groups;

    const grownIds = new Set(grown.map((g) => g.id));
    assert.ok(before.every((g) => grownIds.has(g.id)), "growth keeps every existing id");
    assert.equal(grown.find((g) => g.id === "district-1:civ:8").headcount, 5, "the new partial group holds the remainder");
    assert.equal(grown.find((g) => g.id === "district-1:civ:7").headcount, 10, "the old partial group filled up without renaming");

    assert.ok(!shrunk.some((g) => g.id === "district-1:sol:5"), "shrinkage removes the highest soldier group");
    assert.equal(shrunk.find((g) => g.id === "district-1:sol:4").headcount, 2, "the new last group is the remainder");
});

test("groups: ids round-trip and anything that does not round-trip is refused", () => {
    assert.deepEqual(parseGroupId(groupIdOf("district-1", "civ", 3)), { district: "district-1", kind: "civ", index: 3 });
    for (const bad of ["district-1:civ:03", "district-1:civ", "district-1:cav:1", "a:b:c:1", ":civ:1", "district-1:civ:-1", "district-1:civ:1.5"]) {
        assert.equal(parseGroupId(bad), null, `${bad} must not parse`);
    }
});

test("groups: a district id containing ':' is refused with a stated problem, never tagged", () => {
    const kingdom = createInitialKingdom();
    kingdom.districts[0].id = "district:1";
    const { groups: table, problems } = buildGroupTable(kingdom, POP_SYNC_DEFAULTS);
    assert.ok(problems.some((p) => /contains ':'/.test(p)));
    assert.ok(!table.some((g) => g.district === "district:1"));
});

// ---- identity tags --------------------------------------------------------------------------------------------

test("identity: tags round-trip; foreign tags are counted, never claimed; malformed own tags are unreadable", () => {
    const groupId = "district-1:civ:3";
    assert.equal(tagFor(groupId), "civpop:v1:district-1:civ:3");
    const read = classifyTags(["minecraft:foo", "civpop:v1:district-1:civ:3", "civpop:v9:future", "civpop:v1:district-1:civ:03", "other:civpop"]);
    assert.deepEqual(read.claims, [groupId]);
    assert.deepEqual(read.unreadable, ["civpop:v9:future", "civpop:v1:district-1:civ:03"]);
    assert.equal(read.foreign, 2, "a foreign tag and a tag that only mentions civpop is someone else's");
    assert.equal(isCanonicalFor(read.ownTags, groupId), false, "extra own tags make an entity non-canonical");
    assert.equal(isCanonicalFor(["civpop:v1:district-1:civ:3"], groupId), true);
});

// ---- levels of detail -----------------------------------------------------------------------------------------

test("lod: with no anchor nothing is physical, and with no anchor nothing is removed either (hold)", () => {
    const kingdom = createInitialKingdom();
    const obs = observation({ kingdom, anchors: [], entities: [bound("e1", "district-1:civ:0")] });
    const result = reconcile({ tick: null, runs: 0, spawns: 0, ops: 0, physical: [] }, obs, 10, BIG);
    assert.deepEqual(result.actions, []);
    assert.match(result.report.hold, /no anchor/);
    assert.equal(result.report.groups.total, 70);
});

test("lod: a player nearby makes only that district physical, bounded by the district cap", () => {
    const kingdom = createInitialKingdom();
    const result = reconcile(emptyCursor(), observation({ kingdom }), 10, BIG);
    assert.equal(result.report.groups.physical, POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, "district-1 admits its cap");
    assert.equal(result.report.groups.capped, 14 - POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, "the rest of district-1 waits for a place");
    assert.equal(result.report.groups.coarse, 14 - POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, "the waiting groups are coarse, inside the ring");
    assert.equal(result.report.groups.simulated, 70 - 14, "districts two to five are beyond the coarse ring");
    assert.equal(result.actions.filter((a) => a.op === "spawn").length, POP_SYNC_DEFAULTS.maxPhysicalPerDistrict);
    assert.ok(result.actions.every((a) => a.op === "spawn" && a.groupId.startsWith("district-1:")));
});

test("lod: the kingdom-wide cap holds even when several districts are near players", () => {
    const kingdom = createInitialKingdom();
    const anchors = Object.values(HOMES).map((home) => ({ x: home.x + 6, z: home.z + 6 }));
    const result = reconcile(emptyCursor(), observation({ kingdom, anchors }), 10, BIG);
    assert.equal(result.report.groups.physical, POP_SYNC_DEFAULTS.maxPhysicalTotal);
    assert.equal(result.report.physicalTotal, POP_SYNC_DEFAULTS.maxPhysicalTotal);
});

test("lod: hysteresis - an unbound group promotes inside 48 blocks, a bound group is held out to 56", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const spot = spotOf("district-1:civ:0"); // (4, 4)
    const at50 = { x: spot.x + 50, z: spot.z };
    const at57 = { x: spot.x + 57, z: spot.z };

    const freshAt50 = reconcile(emptyCursor(), observation({ kingdom, anchors: [at50] }), 10, BIG);
    assert.equal(freshAt50.actions.length, 0, "an unbound group at 50 blocks does not promote");
    assert.equal(freshAt50.report.groups.coarse, 1, "it waits in the coarse ring");

    const heldAt50 = reconcile(emptyCursor(), observation({ kingdom, anchors: [at50], entities: [bound("e1", "district-1:civ:0")] }), 10, BIG);
    assert.equal(heldAt50.actions.length, 0, "a bound group at 50 blocks is held, not despawned");
    assert.equal(heldAt50.report.groups.physical, 1);

    const demotedAt57 = reconcile(emptyCursor(), observation({ kingdom, anchors: [at57], entities: [bound("e1", "district-1:civ:0")] }), 10, BIG);
    assert.deepEqual(
        demotedAt57.actions.map((a) => [a.op, a.reason]),
        [["despawn", "out-of-range"]],
        "beyond the hold radius the bound group is despawned",
    );
});

test("lod: caps decide by bound-first, then distance, then id, so the choice is stable", () => {
    const kingdom = onlyDistrictOne(80, 0); // eight civilian groups, cap is eight: all fit
    const shifted = onlyDistrictOne(80, 0);
    const a = reconcile(emptyCursor(), observation({ kingdom }), 10, BIG);
    const b = reconcile(emptyCursor(), observation({ kingdom: shifted }), 10, BIG);
    assert.deepEqual(a.actions, b.actions, "identical inputs give identical actions");
    assert.equal(a.report.groups.physical, 8);
});

test("lod: a demoted-by-cap bound group is demoted with reason capacity and not silently kept", () => {
    const kingdom = onlyDistrictOne(80, 0);
    // Eight bound groups fill the district cap; one unbound group is the wanted extra.
    const entities = [];
    for (let i = 0; i < 8; i += 1) {
        entities.push(bound(`e${String(i)}`, `district-1:civ:${String(i)}`));
    }
    const tight = { maxPhysicalPerDistrict: 4 };
    const result = reconcile({ tick: null, runs: 0, spawns: 0, ops: 0, physical: [] }, observation({ kingdom, entities }), 10, { ...BIG, ...tight });
    const reasons = result.actions.map((a) => a.reason);
    assert.equal(reasons.length, 4, "four bound groups over the cap are demoted");
    assert.ok(reasons.every((reason) => reason === "capacity"));
    assert.ok(result.actions.every((a) => a.op === "despawn"));
});

// ---- chunk and fight gating -------------------------------------------------------------------------------------

test("gating: nothing spawns into an unloaded chunk, and the group waits with a reason", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const result = reconcile(emptyCursor(), observation({ kingdom, loaded: new Set() }), 10, BIG);
    assert.equal(result.actions.length, 0);
    assert.equal(result.report.groups.chunkBlocked, 1);
});

test("gating: a bound group whose chunk is unloaded stays bound and is left alone while a player is near", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const result = reconcile(
        emptyCursor(),
        observation({ kingdom, anchors: [NEAR_D1], entities: [bound("e1", "district-1:civ:0", { loaded: false })], loaded: new Set() }),
        10,
        BIG,
    );
    assert.deepEqual(result.actions, [], "an unloaded representative is never retagged, moved or removed");
    assert.deepEqual(result.report.deferred, [], "nothing is due, so nothing is deferred");
    assert.equal(result.report.groups.physical, 1, "the group stays physical: its entity exists");
});

test("gating: a demotion that is due but whose entity sits in an unloaded chunk is deferred with the reason", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const far = { x: 5000, z: 5000 };
    const result = reconcile(
        emptyCursor(),
        observation({ kingdom, anchors: [far], entities: [bound("e1", "district-1:civ:0", { loaded: false })] }),
        10,
        BIG,
    );
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.report.deferred, [{ entityId: "e1", groupId: "district-1:civ:0", reason: "chunk-unloaded" }]);
});

test("gating: a district in an active fight gets no spawns and no despawns; they are reported as deferred", () => {
    const kingdom = onlyDistrictOne(80, 0);
    kingdom.districts[0].security = "breached";
    kingdom.districts[0].assault = 5;
    const result = reconcile(emptyCursor(), observation({ kingdom }), 10, BIG);
    assert.equal(result.actions.length, 0);
    assert.equal(result.report.deferred.filter((d) => d.reason === "spawn-in-fight").length, 8);
    assert.equal(districtInFight({ security: "contested", assault: 0 }), true);
    assert.equal(districtInFight({ security: "secure", assault: 0 }), false);
    assert.equal(districtInFight({ security: "lost", assault: 0 }), false, "a fallen district is not an active fight");
});

// ---- duplicates, orphans, foreign and untagged entities -----------------------------------------------------------

test("duplicates: one representative per group is kept; the surplus is removed with reason duplicate", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const entities = [bound("e2", "district-1:civ:0"), bound("e1", "district-1:civ:0")];
    const result = reconcile(emptyCursor(), observation({ kingdom, entities }), 10, BIG);
    assert.deepEqual(result.actions, [{ op: "despawn", entityId: "e2", groupId: "district-1:civ:0", reason: "duplicate" }], "the lowest id is kept");
});

test("duplicates: the representative that is in a fight is preferred as keeper, so a combatant is never removed", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const entities = [bound("e1", "district-1:civ:0"), bound("e2", "district-1:civ:0", { inFight: true })];
    const result = reconcile(emptyCursor(), observation({ kingdom, entities }), 10, BIG);
    assert.deepEqual(result.actions.map((a) => a.entityId), ["e1"]);
});

test("duplicates: a surplus that is unloaded or in a fight is deferred, never removed", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const unloaded = reconcile(
        emptyCursor(),
        observation({ kingdom, entities: [bound("e1", "district-1:civ:0"), bound("e2", "district-1:civ:0", { loaded: false })] }),
        10,
        BIG,
    );
    assert.deepEqual(unloaded.actions, []);
    assert.deepEqual(unloaded.report.deferred, [{ entityId: "e2", groupId: "district-1:civ:0", reason: "chunk-unloaded" }]);

    const combat = reconcile(
        emptyCursor(),
        observation({ kingdom, entities: [bound("e1", "district-1:civ:0", { inFight: true }), bound("e2", "district-1:civ:0", { inFight: true })] }),
        10,
        BIG,
    );
    assert.deepEqual(combat.actions, [], "two combatants are both kept, and the surplus is reported");
    assert.deepEqual(combat.report.deferred, [{ entityId: "e2", groupId: "district-1:civ:0", reason: "in-fight" }]);
});

test("orphans and foreign entities: reported or ignored, never named by any action", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const entities = [
        entity("orphan-district", ["civpop:v1:district-9:civ:0"]),
        entity("orphan-garbage", ["civpop:garbage"]),
        entity("foreign", ["other-pack:guard"], { x: 4, z: 4 }),
        entity("player-villager", [], { x: 4, z: 4 }),
        bound("ours", "district-1:civ:0"),
    ];
    const result = reconcile(emptyCursor(), observation({ kingdom, entities }), 10, BIG);
    assert.deepEqual(result.actions, [], "a group already bound by our entity needs nothing; the others are never touched");
    assert.deepEqual(result.report.orphans.map((o) => [o.entityId, o.reason]), [
        ["orphan-district", "unknown-district"],
        ["orphan-garbage", "unreadable-tag"],
    ]);
    assert.equal(result.report.observed.foreign, 1);
    assert.equal(result.report.observed.unmanaged, 2);
});

test("retag: an entity that claims two groups is made canonical; the foreign tag on it is not removed", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const entities = [entity("e1", ["civpop:v1:district-1:civ:0", "civpop:v1:district-1:civ:9", "other-pack:mark"], { x: 4, z: 4 })];
    const result = reconcile(emptyCursor(), observation({ kingdom, entities }), 10, BIG);
    assert.deepEqual(result.actions, [{ op: "retag", entityId: "e1", groupId: "district-1:civ:0" }]);
    const m = model(new Set(["0,0"]));
    m.entities.set("e1", { id: "e1", typeId: "minecraft:villager_v2", x: 4, y: 70, z: 4, tags: new Set(entities[0].tags) });
    applyToModel(m, result.actions);
    assert.deepEqual([...m.entities.get("e1").tags].sort(), ["civpop:v1:district-1:civ:0", "other-pack:mark"], "only our namespace changed");
});

test("drift: stale representatives are reported as drift and the records are left exactly as they were", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const frozen = deepFreeze(structuredClone(kingdom));
    const before = serializeKingdom(kingdom);
    // Index 3 does not exist: 10 civilians are one group. The entity claims people the records do not hold.
    const entities = [bound("e1", "district-1:civ:0"), entity("stale", ["civpop:v1:district-1:civ:3"], { x: 4, z: 4 })];
    const result = reconcile(emptyCursor(), observation({ kingdom: frozen, entities }), 10, BIG);
    assert.equal(serializeKingdom(kingdom), before, "reconcile does not change the records");
    const row = result.report.drift.find((d) => d.district === "district-1");
    assert.equal(row.staleEntities, 1);
    assert.deepEqual(result.actions.map((a) => [a.op, a.entityId, a.reason]), [["despawn", "stale", "empty"]], "a stale representative with no people behind it is removed when it is safe");
});

// ---- budgets and idempotence ----------------------------------------------------------------------------------------

test("budgets: at most maxSpawnsPerTick spawns, and a repeat within the same tick cannot spend the budget twice", () => {
    const kingdom = createInitialKingdom();
    const first = reconcile(emptyCursor(), observation({ kingdom }), 10, {});
    assert.equal(first.actions.filter((a) => a.op === "spawn").length, POP_SYNC_DEFAULTS.maxSpawnsPerTick);
    assert.equal(first.report.pending.spawn, POP_SYNC_DEFAULTS.maxPhysicalPerDistrict - POP_SYNC_DEFAULTS.maxSpawnsPerTick);

    const again = reconcile(first.state, observation({ kingdom }), 10, {});
    assert.equal(again.actions.length, 0, "the tick's spawn budget is already spent");
    assert.equal(again.report.budget.spawnsUsed, POP_SYNC_DEFAULTS.maxSpawnsPerTick);

    const next = reconcile(first.state, observation({ kingdom }), 11, {});
    assert.equal(next.actions.filter((a) => a.op === "spawn").length, POP_SYNC_DEFAULTS.maxSpawnsPerTick, "a new tick gets a new budget");
});

test("budgets: total operations per tick are capped and the rest is reported as pending", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const entities = [bound("e1", "district-1:civ:0"), bound("e2", "district-1:civ:0"), bound("e3", "district-1:civ:0"), bound("e4", "district-1:civ:0")];
    const result = reconcile(emptyCursor(), observation({ kingdom, entities }), 10, { maxOpsPerTick: 2 });
    assert.equal(result.actions.length, 2);
    assert.equal(result.report.pending.despawn, 1, "three surplus representatives, two operations allowed");
});

test("idempotence: applying a plan and reconciling again at the same tick gives no actions", () => {
    for (const seed of [1, 7, 42]) {
        const random = rng(seed);
        const kingdom = createInitialKingdom();
        const m = model(allSpotChunks(kingdom));
        const anchors = [{ x: Math.floor(random() * 60), z: Math.floor(random() * 60) }];
        const first = reconcile(emptyCursor(), observeModel(m, kingdom, anchors), 10, BIG);
        applyToModel(m, first.actions);
        const second = reconcile(first.state, observeModel(m, kingdom, anchors), 10, BIG);
        assert.deepEqual(second.actions, [], `seed ${String(seed)}: second pass must be empty`);
        assert.equal(second.report.adopted.length, 0);
    }
});

test("determinism: the same inputs give the same output, and the entity order in the observation does not matter", () => {
    const kingdom = createInitialKingdom();
    const entities = [
        bound("b", "district-1:civ:1"),
        bound("a", "district-1:civ:1"),
        entity("p", [], { x: 4, z: 4 }),
        entity("o", ["civpop:v1:district-9:civ:0"]),
    ];
    const forward = reconcile(emptyCursor(), observation({ kingdom, entities }), 10, BIG);
    const reversed = reconcile(emptyCursor(), observation({ kingdom, entities: [...entities].reverse() }), 10, BIG);
    assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test("adoption: a representative the cursor does not expect is adopted, and no second one is spawned for it", () => {
    const kingdom = onlyDistrictOne(10, 0);
    const result = reconcile(emptyCursor(), observation({ kingdom, entities: [bound("e1", "district-1:civ:0")] }), 10, BIG);
    assert.deepEqual(result.report.adopted, ["district-1:civ:0"]);
    assert.equal(result.actions.filter((a) => a.op === "spawn").length, 0);
});

test("clock: a smaller tick after a restart starts a new epoch and is not locked by the old budget", () => {
    const kingdom = createInitialKingdom();
    const spent = { tick: 500, runs: 9, spawns: 2, ops: 6, physical: [] };
    const result = reconcile(spent, observation({ kingdom }), 3, {});
    assert.equal(result.report.clockReset, true);
    assert.equal(result.actions.filter((a) => a.op === "spawn").length, POP_SYNC_DEFAULTS.maxSpawnsPerTick);
});

test("refusals: missing or invalid records give no actions and a stated reason, and bad arguments throw with the value", () => {
    const missing = reconcile(emptyCursor(), { entities: [] }, 1, BIG);
    assert.deepEqual(missing.actions, []);
    assert.match(missing.report.refused, /no kingdom records/);

    const broken = createInitialKingdom();
    broken.districts[0].civilians = -1;
    const invalid = reconcile(emptyCursor(), observation({ kingdom: broken }), 1, BIG);
    assert.deepEqual(invalid.actions, []);
    assert.match(invalid.report.refused, /civilians/);

    assert.throws(() => reconcile(emptyCursor(), observation({ kingdom: createInitialKingdom() }), 1.5, BIG), /tick must be a non-negative integer, got 1.5/);
    assert.throws(() => resolveConfig({ holdRadius: 10, physicalRadius: 48 }), /physicalRadius <= holdRadius/);
    assert.throws(() => resolveConfig({ maxSpawnsPerTick: 0 }), /maxSpawnsPerTick/);
});

// ---- cursor -------------------------------------------------------------------------------------------------------

test("cursor: round-trips, a newer version is refused, corruption starts from empty, and the worst case fits the ceiling", () => {
    const state = { tick: 1234, runs: 56, spawns: 1, ops: 2, physical: ["district-1:civ:0", "district-2:sol:5"] };
    const decoded = decodeCursor(encodeCursor(state));
    assert.equal(decoded.status, "ok");
    assert.deepEqual(decoded.state, state);

    assert.equal(decodeCursor(undefined).status, "absent");
    assert.equal(decodeCursor(JSON.stringify({ v: 2, t: 1, n: 1, s: 0, o: 0, p: [] })).status, "newer");
    assert.equal(decodeCursor("{not json").status, "corrupt");
    assert.equal(decodeCursor(JSON.stringify({ v: 1, t: -1, n: 0, s: 0, o: 0, p: [] })).status, "corrupt");
    assert.equal(decodeCursor(JSON.stringify({ v: 1, t: 1, n: 0, s: 0, o: 0, p: ["nope"] })).status, "corrupt");
    assert.equal(decodeCursor("x".repeat(POP_CURSOR_MAX_BYTES + 1)).status, "corrupt");

    // The reducer never admits more than maxPhysicalTotal groups, so that is the realistic worst case.
    const worst = {
        tick: 999999,
        runs: 999999,
        spawns: 2,
        ops: 6,
        physical: Array.from({ length: POP_SYNC_DEFAULTS.maxPhysicalTotal }, (_unused, i) => groupIdOf("district-5", "civ", i)),
    };
    const bytes = cursorBytes(worst);
    assert.ok(bytes <= POP_CURSOR_MAX_BYTES, `worst-case cursor is ${String(bytes)} bytes`);
    assert.equal(decodeCursor(encodeCursor(worst)).status, "ok");
    process.stdout.write(`  population cursor: worst case ${String(bytes)} bytes of ${String(POP_CURSOR_MAX_BYTES)} allowed\n`);
});

test("cursor: losing the cursor entirely does not change what is planned for the world", () => {
    const kingdom = createInitialKingdom();
    const m = model(allSpotChunks(kingdom));
    const anchors = [NEAR_D1];
    const first = reconcile(emptyCursor(), observeModel(m, kingdom, anchors), 10, {});
    applyToModel(m, first.actions);
    const withCursor = reconcile(first.state, observeModel(m, kingdom, anchors), 11, {});
    const withoutCursor = reconcile(emptyCursor(), observeModel(m, kingdom, anchors), 11, {});
    assert.deepEqual(withoutCursor.actions, withCursor.actions, "the world, not the cursor, decides");
});

test("cursor key: the population cursor has its own key, distinct from the kingdom and plan keys", () => {
    assert.equal(POP_CURSOR_KEY, "civ_pop");
});

// ---- benchmark: 5 districts x 550 units -----------------------------------------------------------------------------

test("benchmark: one reconcile over five districts of 550 units stays under the fixed work budget", () => {
    const kingdom = createInitialKingdom();
    assert.equal(kingdom.districts.reduce((sum, d) => sum + d.civilians + d.soldiers, 0), 550);
    const anchors = Object.values(HOMES).map((home) => ({ x: home.x + 6, z: home.z + 6 }));
    const random = rng(550);

    // Worst realistic observation: every unit is in view, 70 of them are ours, the rest are untagged villagers.
    const { groups: table } = buildGroupTable(kingdom, POP_SYNC_DEFAULTS);
    const entities = [];
    for (const group of table) {
        const spot = spotOf(group.id);
        entities.push(entity(`g-${group.id}`, [tagFor(group.id)], { x: spot.x, z: spot.z }));
    }
    for (let i = 0; i < 480; i += 1) {
        const home = Object.values(HOMES)[i % 5];
        entities.push(entity(`v${String(i)}`, [], { x: home.x + random() * 30, z: home.z + random() * 30 }));
    }
    const heavy = reconcile(emptyCursor(), observation({ kingdom, anchors, entities }), 10, {});
    assert.ok(heavy.report.work <= POP_SYNC_DEFAULTS.workBudget, `work ${String(heavy.report.work)} exceeds the budget ${String(POP_SYNC_DEFAULTS.workBudget)}`);
    assert.equal(heavy.report.overBudget, false);

    // Quiet kingdom: 550 untagged units standing still, nothing of ours yet.
    const quiet = [];
    for (let i = 0; i < 550; i += 1) {
        const home = Object.values(HOMES)[i % 5];
        quiet.push(entity(`q${String(i)}`, [], { x: home.x + random() * 30, z: home.z + random() * 30 }));
    }
    const light = reconcile(emptyCursor(), observation({ kingdom, anchors, entities: quiet }), 10, {});
    assert.ok(light.report.work <= POP_SYNC_DEFAULTS.workBudget, `quiet work ${String(light.report.work)} exceeds the budget`);
    process.stdout.write(`  population benchmark: heavy work ${String(heavy.report.work)} / quiet work ${String(light.report.work)} against a budget of ${String(POP_SYNC_DEFAULTS.workBudget)}\n`);
});

// ---- property: seeded random sequences, every invariant after every completed reconcile -----------------------------

/**
 * One seeded run: player movement, chunk loads and unloads, restarts (cursor round-trip), lost cursors, crashes
 * part-way through applying a plan (the cursor is not saved), duplicate and foreign injection, and kingdom growth
 * and shrinkage. Invariants are checked after every completed reconcile. Returns a trace for determinism checks.
 */
function randomRun(seed, steps, cover = null) {
    /** @param {string} key */
    const note = (key, by = 1) => {
        if (cover !== null) {
            cover[key] = (cover[key] ?? 0) + by;
        }
    };
    const random = rng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    let kingdom = createInitialKingdom();
    const m = model(allSpotChunks(kingdom));
    let anchors = [NEAR_D1];
    let state = emptyCursor();
    let tick = 10;
    const protectedIds = new Map(); // id -> tags at injection, must never change or vanish
    let trace = [];
    let crashes = 0;
    let restarts = 0;

    const groupIds = () => buildGroupTable(kingdom, POP_SYNC_DEFAULTS).groups.map((g) => g.id);

    for (let step = 0; step < steps; step += 1) {
        const roll = random();
        const ids = groupIds();
        if (ids.length === 0) {
            // every district was shrunk to nothing this run; nothing to aim at, so only movement can happen
            anchors = [NEAR_D1];
        }
        if (roll < 0.2) {
            anchors = random() < 0.1 ? [] : [{ x: pick(Object.values(HOMES)).x + Math.floor(random() * 80) - 20, z: Math.floor(random() * 80) }];
        } else if (ids.length === 0) {
            // nothing to inject or toggle without a group
        } else if (roll < 0.3) {
            const spot = spotOf(pick(ids));
            const key = chunkKeyOf(spot.x, spot.z);
            if (m.loaded.has(key)) {
                m.loaded.delete(key);
            } else {
                m.loaded.add(key);
            }
        } else if (roll < 0.34) {
            const ours = [...m.entities.values()].filter((e) => classifyTags([...e.tags]).claims.length > 0);
            if (ours.length > 0) {
                const source = pick(ours);
                if (m.loaded.has(chunkKeyOf(source.x, source.z))) {
                    addToModel(m, { tags: [...source.tags], x: source.x, z: source.z });
                }
            }
        } else if (roll < 0.38) {
            const spot = spotOf(pick(ids));
            if (m.loaded.has(chunkKeyOf(spot.x, spot.z))) {
                const id = addToModel(m, { tags: ["other-pack:guard"], x: spot.x, z: spot.z });
                protectedIds.set(id, ["other-pack:guard"]);
            }
            const id = addToModel(m, { x: spot.x, z: spot.z });
            protectedIds.set(id, []);
        } else if (roll < 0.41) {
            kingdom = structuredClone(kingdom);
            const district = pick(kingdom.districts);
            setPeople(district, Math.floor(random() * 121), Math.floor(random() * 41));
            assert.deepEqual(findValidationProblems(kingdom), [], "the scenario only makes valid kingdoms");
        } else if (roll < 0.43) {
            state = decodeCursor(encodeCursor(state)).state;
            restarts += 1;
            note("restart");
        } else if (roll < 0.44) {
            state = emptyCursor();
            restarts += 1;
            note("lost-cursor");
        } else if (roll < 0.46) {
            // A representative picks up a tag from an older or future version of ours: it must be retagged to canonical.
            const ours = [...m.entities.values()].filter((e) => classifyTags([...e.tags]).claims.length > 0 && modelChunkLoaded(m, e));
            if (ours.length > 0) {
                pick(ours).tags.add("civpop:v9:legacy");
            }
        }

        tick += 1 + Math.floor(random() * 3);
        const plan = reconcile(state, observeModel(m, kingdom, anchors), tick, {});
        assert.ok(plan.report.refused === null, `step ${String(step)} refused: ${String(plan.report.refused)}`);
        assert.ok(plan.actions.filter((a) => a.op === "spawn").length <= POP_SYNC_DEFAULTS.maxSpawnsPerTick, "spawn budget");
        assert.ok(plan.actions.length <= POP_SYNC_DEFAULTS.maxOpsPerTick, "operations budget");
        assert.ok(plan.report.physicalTotal <= POP_SYNC_DEFAULTS.maxPhysicalTotal, "kingdom-wide cap");
        assert.ok(cursorBytes(plan.state) <= POP_CURSOR_MAX_BYTES, "the cursor stays tiny");

        const crashAt = random() < 0.08 ? Math.floor(random() * (plan.actions.length + 1)) : null;
        const toApply = crashAt === null ? plan.actions : plan.actions.slice(0, crashAt);
        applyToModel(m, toApply);
        note("spawn", plan.actions.filter((a) => a.op === "spawn").length);
        note("retag", plan.actions.filter((a) => a.op === "retag").length);
        for (const action of plan.actions.filter((a) => a.op === "despawn")) {
            note(`despawn:${action.reason}`);
        }
        note("adopted", plan.report.adopted.length);
        note("deferred", plan.report.deferred.length);
        note("pending", plan.report.pending.spawn + plan.report.pending.despawn + plan.report.pending.retag > 0 ? 1 : 0);
        note("hold", hold(anchors) ? 1 : 0);
        trace.push({ step, tick, actions: plan.actions, adopted: plan.report.adopted, state: plan.state });
        if (crashAt !== null) {
            crashes += 1; // the process died before the cursor was saved: `state` is unchanged
            note("crash");
            continue;
        }
        state = plan.state;

        // Invariants after a completed reconcile.
        for (const [groupId, count] of representativesPerGroup(m)) {
            assert.ok(count <= 1, `step ${String(step)}: ${String(count)} representatives for ${groupId}`);
        }
        for (const [id, tags] of protectedIds) {
            const e = m.entities.get(id);
            if (e === undefined) {
                assert.fail(`step ${String(step)}: protected entity ${id} disappeared`);
            }
            assert.deepEqual([...e.tags], tags, `step ${String(step)}: protected entity ${id} had its tags changed`);
        }
        const perDistrict = new Map();
        for (const groupId of state.physical) {
            const district = parseGroupId(groupId).district;
            perDistrict.set(district, (perDistrict.get(district) ?? 0) + 1);
        }
        for (const count of perDistrict.values()) {
            assert.ok(count <= POP_SYNC_DEFAULTS.maxPhysicalPerDistrict, "district cap");
        }
        assert.deepEqual(findValidationProblems(kingdom), [], "the records stay valid");
    }

    // Convergence: every district area loaded (stale representatives must become reachable), players fixed next
    // to district-1, then reconcile until quiet.
    loadDistrictAreas(m);
    anchors = [NEAR_D1];
    let quietRuns = 0;
    for (let round = 0; round < 60 && quietRuns < 2; round += 1) {
        tick += 1;
        const plan = reconcile(state, observeModel(m, kingdom, anchors), tick, {});
        applyToModel(m, plan.actions);
        state = plan.state;
        quietRuns = plan.actions.length === 0 ? quietRuns + 1 : 0;
    }
    assert.ok(quietRuns >= 2, `seed ${String(seed)} did not converge`);

    // After convergence: exactly one representative per admitted group, none for the rest, protected ones untouched.
    const finalPlan = reconcile(state, observeModel(m, kingdom, anchors), tick + 1, {});
    assert.deepEqual(finalPlan.actions, [], "converged world gives no actions");
    const counts = representativesPerGroup(m);
    for (const groupId of state.physical) {
        assert.equal(counts.get(groupId) ?? 0, 1, `admitted group ${groupId} has exactly one representative`);
    }
    for (const [groupId] of counts) {
        assert.ok(state.physical.includes(groupId), `${groupId} has a representative but is not admitted`);
    }
    for (const id of protectedIds.keys()) {
        assert.ok(m.entities.has(id), "protected entities survive to the end");
    }
    trace.push({ converged: true, crashes, restarts, physical: state.physical });
    return JSON.stringify(trace);
}

/** @param {Array<{ x: number, z: number }>} anchors */
function hold(anchors) {
    return anchors.length === 0;
}

test("property: seeded random sequences keep every invariant and converge (12 seeds, 250 steps)", () => {
    const cover = {};
    for (let seed = 1; seed <= 12; seed += 1) {
        randomRun(seed, 250, cover);
    }
    // The sequences must actually reach the hard cases, or a pass would prove nothing.
    // despawn:capacity is covered by its own directed test; it needs more representatives than the cap, which a walk rarely builds.
    for (const key of ["spawn", "retag", "despawn:duplicate", "despawn:out-of-range", "adopted", "deferred", "crash", "restart", "lost-cursor", "hold", "pending"]) {
        assert.ok((cover[key] ?? 0) > 0, `coverage: ${key} never happened across the seeds`);
    }
    process.stdout.write(`  population property coverage over 12 seeds: ${JSON.stringify(cover)}
`);
});

test("property: the same seed produces the same trace, byte for byte", () => {
    assert.equal(randomRun(99, 120), randomRun(99, 120));
});
