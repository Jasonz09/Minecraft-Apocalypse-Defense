import assert from "node:assert/strict";
import test from "node:test";
import { contract, createKingdom, createLayout, createRng, lod, reconciler } from "../lib/peopleharness.mjs";

const kingdom = createKingdom();
const layout = createLayout(kingdom.districts.map((district) => district.id));
const records = contract.createRoster(kingdom.districts.map((district) => ({ id: district.id, civilians: district.civilians, soldiers: district.soldiers, garrison: district.garrison })));
const byId = new Map(records.map((record) => [record.id, record]));

/** Where a record's entity belongs: its anchor plus the deterministic offset, exactly as the planner computes it. */
function placementOf(record) {
    const anchor = layout.anchors[contract.anchorSlotFor(record)];
    const offset = lod.offsetFor(record.id);
    return { x: anchor.x + offset.dx, y: anchor.y, z: anchor.z + offset.dz };
}

/** A plan that wants exactly these records physical, standing where they belong. */
function planFor(ids) {
    const placements = {};
    for (const id of ids) placements[id] = placementOf(byId.get(id));
    return { desired: ids.slice().sort(), placements };
}

/** An entity as the adapter reports it. */
function entity(handle, typeId, at, tags, district = "district-1") {
    return { handle, typeId, district, x: at.x, y: at.y, z: at.z, tags: tags.slice() };
}

const villager = "minecraft:villager_v2";
const tagsFor = (record) => contract.expectedTags(record);
const nextHandles = (prefix = "n") => {
    let counter = 0;
    return () => `${prefix}${String(counter++).padStart(4, "0")}`;
};
const ids = (list) => list.map((item) => item.id);

test("missing entities are spawned with their tags, and a second reconcile has nothing to do", () => {
    const wanted = ["civ-district-1-civilian-001", "civ-district-1-civilian-002", "civ-district-2-soldier-001"];
    const plan = planFor(wanted);
    const first = reconciler.reconcile({ records, observed: [], plan });
    assert.deepEqual(first.actions.map((action) => action.op), ["spawn", "spawn", "spawn"]);
    assert.deepEqual(first.actions[0].tags, tagsFor(byId.get(first.actions[0].id)));
    const after = reconciler.applyActions([], first.actions, nextHandles());
    assert.equal(after.length, 3);
    const again = reconciler.reconcile({ records, observed: after, plan });
    assert.deepEqual(again.actions, []);
});

test("orphans, tombstoned people and entities outside the plan are despawned, and no record is touched", () => {
    const before = JSON.stringify(records);
    const keep = "civ-district-1-civilian-001";
    const dead = contract.recordDeaths(records, "district-1", "civilian", 1).records.find((record) => record.state === "dead");
    const observed = [
        entity("a1", villager, placementOf(byId.get(keep)), tagsFor(byId.get(keep))),
        entity("a2", villager, { x: 0, y: 64, z: 0 }, [contract.ID_TAG_PREFIX + "civ-district-9-civilian-001", contract.MANAGED_TAG]),
        entity("a3", villager, { x: 10, y: 64, z: 10 }, tagsFor(dead)),
        entity("a4", villager, placementOf(byId.get("civ-district-1-civilian-005")), tagsFor(byId.get("civ-district-1-civilian-005"))),
    ];
    const updated = records.map((record) => (record.id === dead.id ? dead : record));
    const result = reconciler.reconcile({ records: updated, observed, plan: planFor([keep]) });
    const reasons = Object.fromEntries(result.actions.filter((action) => action.op === "despawn").map((action) => [action.handle, action.reason]));
    assert.match(reasons.a2, /orphan/);
    assert.match(reasons.a3, /dead/);
    assert.match(reasons.a4, /outside the plan/);
    assert.equal(reasons.a1, undefined, "the correct entity is kept");
    assert.equal(JSON.stringify(records), before, "reconcile never edits records");
});

test("duplicates: one entity per record survives, the one with exact tags is preferred", () => {
    const id = "civ-district-1-civilian-003";
    const record = byId.get(id);
    const plan = planFor([id]);
    const observed = [
        entity("b1", villager, placementOf(record), [contract.ID_TAG_PREFIX + id]),
        entity("b2", villager, placementOf(record), tagsFor(record)),
        entity("b3", villager, placementOf(record), [contract.ID_TAG_PREFIX + id, contract.MANAGED_TAG]),
    ];
    const result = reconciler.reconcile({ records, observed, plan });
    const despawned = result.actions.filter((action) => action.op === "despawn").map((action) => action.handle).sort();
    assert.deepEqual(despawned, ["b1", "b3"]);
    assert.deepEqual(result.actions.filter((action) => action.op === "tag"), [], "the kept entity already matches");
    const after = reconciler.applyActions(observed, result.actions, nextHandles());
    assert.equal(after.length, 1);
    assert.deepEqual(reconciler.reconcile({ records, observed: after, plan }).actions, []);
});

test("a stale revision tag is updated in place rather than respawned", () => {
    // Enlist one recruit: the record changes state and workplace, its revision goes 0 -> 1, and its entity still carries rev 0.
    const moved = contract.enlistRecruits(records, "district-2", 1).records;
    const trainee = moved.find((item) => item.state === "training");
    const original = byId.get(trainee.id);
    const plan = { desired: [trainee.id], placements: { [trainee.id]: placementOf(trainee) } };
    const stale = entity("c1", villager, placementOf(trainee), tagsFor(original), "district-2");
    const result = reconciler.reconcile({ records: moved, observed: [stale], plan });
    assert.deepEqual(result.actions.map((action) => action.op), ["tag"]);
    assert.deepEqual(result.actions[0].add, [`${contract.REV_TAG_PREFIX}1`]);
    assert.deepEqual(result.actions[0].remove, [`${contract.REV_TAG_PREFIX}0`]);
    const after = reconciler.applyActions([stale], result.actions, nextHandles());
    assert.deepEqual(reconciler.reconcile({ records: moved, observed: after, plan }).actions, []);
});

test("an entity standing outside its leash is moved, not respawned", () => {
    const id = "civ-district-1-civilian-010";
    const record = byId.get(id);
    const far = { x: placementOf(record).x + 30, y: 64, z: placementOf(record).z };
    const plan = planFor([id]);
    const result = reconciler.reconcile({ records, observed: [entity("d1", villager, far, tagsFor(record))], plan });
    assert.deepEqual(result.actions.map((action) => action.op), ["move"]);
    assert.deepEqual(result.actions[0].to, placementOf(record));
});

test("an untagged remnant of a crashed spawn is adopted by the planned record it was made for", () => {
    const id = "civ-district-1-civilian-020";
    const record = byId.get(id);
    const plan = planFor([id]);
    const remnant = entity("r1", villager, placementOf(record), []);
    const result = reconciler.reconcile({ records, observed: [remnant], plan });
    assert.deepEqual(result.actions.map((action) => action.op), ["adopt"]);
    assert.equal(result.actions[0].id, id);
    const after = reconciler.applyActions([remnant], result.actions, nextHandles());
    assert.equal(after.length, 1, "no duplicate was spawned");
    assert.deepEqual(reconciler.reconcile({ records, observed: after, plan }).actions, []);
});

test("an untagged remnant with no planned record in reach is removed, or kept when the policy says so", () => {
    const plan = planFor([]);
    const remnant = entity("r2", villager, { x: 5, y: 64, z: 5 }, []);
    const removed = reconciler.reconcile({ records, observed: [remnant], plan });
    assert.deepEqual(removed.actions.map((action) => action.op), ["despawn"]);
    const kept = reconciler.reconcile({ records, observed: [remnant], plan, unclaimed: "keep" });
    assert.deepEqual(kept.actions, []);
});

test("untagged entities outside every district or of another type are never touched", () => {
    const plan = planFor([]);
    const outside = entity("f1", villager, { x: 900, y: 64, z: 900 }, [], null);
    const foreign = entity("f2", "minecraft:zombie", { x: 5, y: 64, z: 5 }, []);
    const result = reconciler.reconcile({ records, observed: [outside, foreign], plan });
    assert.deepEqual(result.actions, []);
});

test("an entity carrying two record ids is ambiguous and is despawned", () => {
    const plan = planFor([]);
    const twofold = entity("g1", villager, { x: 0, y: 64, z: 0 }, [contract.ID_TAG_PREFIX + "civ-district-1-civilian-001", contract.ID_TAG_PREFIX + "civ-district-1-civilian-002"]);
    const result = reconciler.reconcile({ records, observed: [twofold], plan });
    assert.deepEqual(result.actions.map((action) => action.op), ["despawn"]);
    assert.match(result.actions[0].reason, /2 record ids/);
});

test("spawns obey the per-call budget, and the rest are reported as deferred", () => {
    const wanted = ["civ-district-1-civilian-001", "civ-district-1-civilian-002", "civ-district-1-civilian-003"];
    const result = reconciler.reconcile({ records, observed: [], plan: planFor(wanted), maxSpawns: 2 });
    assert.equal(result.actions.filter((action) => action.op === "spawn").length, 2);
    assert.equal(result.deferred.length, 1);
});

test("a crash between spawn and tag-write cannot duplicate: the orphan is adopted, not spawned again", () => {
    const id = "civ-district-3-civilian-007";
    const record = byId.get(id);
    const plan = planFor([id]);
    const first = reconciler.reconcile({ records, observed: [], plan });
    const spawn = first.actions[0];
    // The crash: the entity exists, its tags never got written.
    const crashed = [entity("h1", spawn.typeId, spawn.at, [], "district-3")];
    const second = reconciler.reconcile({ records, observed: crashed, plan });
    assert.deepEqual(second.actions.map((action) => action.op), ["adopt"]);
    const healed = reconciler.applyActions(crashed, second.actions, nextHandles());
    assert.equal(healed.filter((item) => item.tags.includes(contract.ID_TAG_PREFIX + id)).length, 1);
    assert.deepEqual(reconciler.reconcile({ records, observed: healed, plan }).actions, []);
    assert.ok(record !== undefined);
});

test("physicalIds counts only entities with exactly one record id", () => {
    const observed = [
        entity("p1", villager, { x: 0, y: 0, z: 0 }, [contract.ID_TAG_PREFIX + "civ-district-1-civilian-001"]),
        entity("p2", villager, { x: 0, y: 0, z: 0 }, [contract.ID_TAG_PREFIX + "civ-district-1-civilian-002", contract.ID_TAG_PREFIX + "civ-district-1-civilian-003"]),
        entity("p3", villager, { x: 0, y: 0, z: 0 }, []),
    ];
    assert.deepEqual(reconciler.physicalIds(observed), ["civ-district-1-civilian-001"]);
});

test("random worlds (duplicates, orphans, stale tags, remnants): one reconcile heals them, a second finds nothing, no record is lost", () => {
    const rng = createRng(4242);
    for (let trial = 0; trial < 150; trial += 1) {
        const live = records.filter((record) => contract.isLiveRecord(record));
        const wanted = live.filter(() => rng() < 0.25).map((record) => record.id);
        const plan = planFor(wanted);
        const observed = [];
        let handle = 0;
        const next = () => `t${String(trial)}-${String(handle++).padStart(4, "0")}`;
        for (const id of wanted) {
            const record = byId.get(id);
            const roll = rng();
            if (roll < 0.3) continue;
            const stale = rng() < 0.2 ? tagsFor(record).map((tag) => tag.replace(/rev:\d+$/, "rev:99")) : tagsFor(record);
            observed.push(entity(next(), villager, placementOf(record), stale, record.district));
            if (rng() < 0.15) observed.push(entity(next(), villager, placementOf(record), stale, record.district));
            if (rng() < 0.1) observed.push(entity(next(), villager, placementOf(record), [], record.district));
        }
        for (let orphan = 0; orphan < 3; orphan += 1) {
            if (rng() < 0.4) observed.push(entity(next(), villager, { x: 3, y: 64, z: 3 }, [contract.ID_TAG_PREFIX + `civ-district-4-soldier-${String(900 + orphan)}`]));
        }
        const first = reconciler.reconcile({ records, observed, plan, maxSpawns: 10_000 });
        assert.deepEqual(first.problems, [], `trial ${String(trial)}`);
        const healed = reconciler.applyActions(observed, first.actions, next);
        const perRecord = new Map();
        for (const item of healed) {
            for (const tag of item.tags.filter((value) => value.startsWith(contract.ID_TAG_PREFIX))) {
                const recordId = tag.slice(contract.ID_TAG_PREFIX.length);
                perRecord.set(recordId, (perRecord.get(recordId) ?? 0) + 1);
            }
        }
        for (const [recordId, count] of perRecord) assert.equal(count, 1, `${recordId} in trial ${String(trial)}`);
        for (const id of wanted) assert.equal(perRecord.get(id), 1, `${id} is present in trial ${String(trial)}`);
        assert.equal(healed.filter((item) => item.tags.length === 0).length, 0, "no untagged remnants survive");
        assert.deepEqual(reconciler.reconcile({ records, observed: healed, plan, maxSpawns: 10_000 }).actions, [], `idempotent in trial ${String(trial)}`);
    }
});

test("reconcile only ever acts on entities: its action vocabulary has no record operation", () => {
    const observed = [
        entity("z1", villager, { x: 0, y: 0, z: 0 }, [contract.ID_TAG_PREFIX + "civ-district-1-civilian-001"]),
        entity("z2", villager, placementOf(byId.get("civ-district-1-civilian-002")), []),
    ];
    const plan = planFor(["civ-district-1-civilian-002", "civ-district-1-civilian-003"]);
    const result = reconciler.reconcile({ records, observed, plan });
    const vocabulary = new Set(["spawn", "despawn", "tag", "adopt", "move"]);
    assert.ok(result.actions.every((action) => vocabulary.has(action.op)));
    const despawn = result.actions.find((action) => action.op === "despawn");
    assert.equal(despawn.handle, "z1");
    assert.equal(despawn.reason, "outside the plan");
    assert.deepEqual(ids(result.actions.filter((action) => action.op === "spawn")), ["civ-district-1-civilian-003"]);
});
