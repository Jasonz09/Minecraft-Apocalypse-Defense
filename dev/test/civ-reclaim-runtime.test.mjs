// The whole one-command workflow on open sea, through the production runtime (fake world): the survey
// accepts water, the master plan settles it, the district plan stands it on piers, and the write guard
// lets masonry stand in water while still refusing to cut it.
import assert from "node:assert/strict";
import test from "node:test";
import { builder, civRecord, districtBuilder, mc, makePlayer, pump, resetWorld, send, text, CIV_EVENT_IDS } from "../lib/civharness.mjs";

const T = { timeout: 900000 };
const SEA = { field: { lakes: [{ x: 0, z: 0, r: 4000 }] } };

test("open sea: the runtime surveys it, plans a five-district civilization and refuses nothing", T, async () => {
    resetWorld(1, SEA);
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, "seed=1", player);
    await pump();
    const out = text(player);
    assert.match(out, /Plan is valid/, out.slice(-1200));
    assert.ok(outcome.site.waterFraction > 0.99, `water fraction ${outcome.site.waterFraction}`);
    assert.match(out, /wet: lots and roads stand on pillars over the water/);
    assert.equal(mc.writes, 0, "planning writes nothing");
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(mc.areas.size, 0);
    assert.equal(civRecord(), undefined);
});

test("open sea: the build runs to completion on decks and piers instead of skipping the water", T, async () => {
    resetWorld(1, SEA);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, "seed=1", player);
    await pump();
    const out = text(player);
    assert.match(out, /Plan stored\. Starting construction now\./, out.slice(-1500));
    assert.match(out, /is built/, out.slice(-1500));
    const record = civRecord();
    assert.equal(record.status, "complete", out.slice(-1200));
    assert.ok(mc.writes > 1000, `writes ${mc.writes}`);
    assert.doesNotMatch(out, /occupied by minecraft:water/, "reclamation must not skip its own water ops");
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(mc.areas.size, 0);
});

test("the write guard stands masonry in water, but never cuts water", () => {
    const water = "minecraft:water";
    const planned = { final: "minecraft:stone_bricks", nonAir: ["minecraft:stone_bricks"] };
    for (const kind of ["fill", "pad", "footing", "wall", "tower", "merlon", "walk", "gate", "road", "stair", "deck", "pillar", "rail", "retain", "support"]) {
        const verdict = builder.classifyCivOp({ x: 0, y: 64, z: 0, id: "minecraft:stone_bricks", kind }, water, planned);
        assert.equal(verdict.action, "place", `${kind} must be placeable into water (got ${verdict.action})`);
    }
    for (const kind of ["cut", "clear"]) {
        const verdict = builder.classifyCivOp({ x: 0, y: 64, z: 0, id: "minecraft:air", kind }, water, planned);
        assert.notEqual(verdict.action, "place", `${kind} must not remove water`);
    }
    // a player's block is still protected
    const planks = builder.classifyCivOp({ x: 0, y: 64, z: 0, id: "minecraft:stone_bricks", kind: "wall" }, "minecraft:oak_planks", planned);
    assert.equal(planks.action, "skip");
});
