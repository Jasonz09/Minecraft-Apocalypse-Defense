import assert from "node:assert/strict";
import test from "node:test";
import { CIV_EVENT_IDS, builder, dimension, districtBuilder, load, mc, makePlayer, pump, resetWorld, send, store, text, key } from "../lib/civharness.mjs";
const { outdoorLightGroups, removalReadiness } = await load("civ", "lightingRevision.js");

test("a modified post preserves the entire fixture; missing cells pause rather than guessing", () => {
    const group = [{ x: 1, y: 5, z: 1, id: "minecraft:lantern" }, { x: 1, y: 4, z: 1, id: "minecraft:oak_fence" }];
    assert.equal(removalReadiness(group, (op) => ({ typeId: op.y === 4 ? "minecraft:bookshelf" : op.id })), "foreign");
    assert.equal(removalReadiness(group, () => undefined), "unloaded");
    assert.equal(removalReadiness(group, () => ({ typeId: "minecraft:air" })), "ready", "an interrupted removal is repeatable");
});

test("the production lighting command removes the legacy grid, preserves builds and resumes idempotently", { timeout: 300000 }, async () => {
    resetWorld(1);
    const player = makePlayer();
    const original = builder.seams.planSite;
    let record;
    builder.seams.onOutcome = (outcome) => { record = outcome.record; };
    builder.seams.planSite = (plan, index, field, options) => original(plan, index, field, { ...options, lighting: undefined });
    try { send(CIV_EVENT_IDS.generate, "seed=1", player); await pump(); }
    finally { builder.seams.planSite = original; }
    assert.equal(store.load().kingdom.districts[0].civ.status, "complete");
    const old = outdoorLightGroups(record);
    const post = old.find((group) => group.length > 1);
    assert.ok(post);
    const changed = post[post.length - 1];
    mc.placed.set(key(changed.x, changed.y, changed.z), "minecraft:bookshelf");
    const before = new Map(mc.placed);
    const managed = new Set(old.flat().map((op) => key(op.x, op.y, op.z)));
    const beforeCancel = mc.writes;
    mc.createMode = () => "never";
    send(CIV_EVENT_IDS.lights, "district=1", player);
    await pump({ until: () => mc.areas.size > 0 });
    send(CIV_EVENT_IDS.lightsAbort, "", player);
    await pump();
    assert.equal(mc.areas.size, 0);
    assert.equal(mc.writes, beforeCancel, "cancelling a pending load changes no blocks");
    assert.equal(districtBuilder.isBusy(), false);
    mc.createMode = () => "instant";
    send(CIV_EVENT_IDS.lights, "district=1", player);
    await pump();
    assert.match(text(player), /Natural lighting complete/, text(player).slice(-1200));
    send(CIV_EVENT_IDS.lightsStatus, "", player);
    assert.match(text(player), /natural lighting complete - \d+\/\d+ fixtures/);
    for (const op of post) assert.equal(mc.placed.get(key(op.x, op.y, op.z)), before.get(key(op.x, op.y, op.z)), "a changed fixture stays intact");
    for (const [cell, id] of before) if (!managed.has(cell) && id !== "minecraft:air") assert.equal(mc.placed.get(cell), id, `preserve building/terrain ${cell}`);
    const oldSources = old.flat().filter((op) => op.id === "minecraft:lantern");
    const gone = oldSources.filter((op) => mc.placed.get(key(op.x, op.y, op.z)) !== op.id);
    assert.ok(gone.length > oldSources.length * 0.8, "the old blanket lighting is actually removed");
    assert.equal(mc.areas.size, 0);
    assert.equal(districtBuilder.isBusy(), false);
    const writes = mc.writes;
    send(CIV_EVENT_IDS.lights, "district=1", player);
    await pump();
    assert.equal(mc.writes, writes, "a finished revision never duplicates or removes its new lights");
});
