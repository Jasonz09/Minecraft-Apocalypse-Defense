// The lamp retrofit against the shared fake world: a full district build, its lamps taken back out (the world
// an older pack left behind), then `civ:lights` run over it. The claims measured here are the ones the command
// makes to the player: nothing that stands is replaced, a rerun writes nothing, and every surface column that
// can hold a lantern ends within light range of one.
import assert from "node:assert/strict";
import test from "node:test";
import { CIV_EVENT_IDS, builder, dimension, districtBuilder, load, mc, makePlayer, pump, resetWorld, send, store, text } from "../lib/civharness.mjs";

const L = await load("civ", "lamps.js");
const R = await load("integration", "lampRetrofit.js");
const S = await load("civ", "siteprofile.js");
const MIN_TIMEOUT = { timeout: 900000 };

test("civ:lights refuses a district that was never built, and is not behind the development gate", async () => {
    resetWorld(1);
    send(CIV_EVENT_IDS.devgate, "off", makePlayer());
    const player = makePlayer();
    send(CIV_EVENT_IDS.lights, "district=2", player);
    await pump();
    const out = text(player);
    assert.match(out, /unfinished/, out.slice(-800));
    assert.doesNotMatch(out, /Generation commands are off/, "lighting a built district must not need the dev gate");
    assert.equal(mc.writes, 0, "a refusal writes nothing");
    assert.equal(districtBuilder.isBusy(), false, "the job slot is free");
    assert.equal(R.readLampState(2), undefined, "no state stored by a refusal");
});

test("legacy retrofit helper remains place-only, idempotent and resumable for archived diagnostics", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer(0, 0);
    const originalPlanner = builder.seams.planSite;
    builder.seams.planSite = (plan, index, field, options) => originalPlanner(plan, index, field, { ...options, lighting: undefined });
    send(CIV_EVENT_IDS.generate, "seed=1", player);
    await pump();
    builder.seams.planSite = originalPlanner;
    assert.match(text(player), /is built/, text(player).slice(-1200));
    assert.equal(store.load().kingdom.districts[0].civ.status, "complete");

    // Take the planner's own lamps back out: this is the world an older pack left behind, before lighting.
    let removed = 0;
    for (const [key, id] of [...mc.placed]) {
        if (id !== "minecraft:lantern") continue;
        const [x, y, z] = key.split(",").map(Number);
        mc.placed.delete(key);
        removed += 1;
        for (let down = 1; down <= 3; down += 1) {
            const post = `${x},${y - down},${z}`;
            if (mc.placed.get(post) === "minecraft:oak_fence") mc.placed.delete(post);
        }
    }
    assert.ok(removed > 100, `the build must have placed lamps to strip (${removed})`);

    const master = builder.loadMasterPlan();
    assert.ok(master.plan, "the built world stores its master plan");
    const region = S.siteGroundRegion(master.plan, 1, 0);
    /** @type {{ x: number, y: number, z: number }[]} */
    const surfaces = [];
    for (let z = region.z0; z <= region.z1; z += 1) {
        for (let x = region.x0; x <= region.x1; x += 1) {
            const top = dimension.getTopmostBlock({ x, z });
            if (top === undefined) continue;
            if (L.isLampStand(top.typeId)) surfaces.push({ x, y: top.location.y + 1, z });
        }
    }
    assert.ok(surfaces.length > 20000, `the district must offer real surfaces to light (${surfaces.length})`);

    // A running build owns the one job slot: a lamp run must refuse rather than interleave its holds.
    const writesBeforeRefusal = mc.writes;
    const holder = districtBuilder.reserveJob("test-holder");
    const blocked = makePlayer();
    const refusal = R.startLampRetrofit({ index: 1, dimension, say: (lines) => blocked.sendMessage(lines.join("\n")) });
    if (!refusal.ok) blocked.sendMessage(String(refusal.reason));
    await pump();
    assert.match(text(blocked), /another job/i, text(blocked).slice(-500));
    assert.equal(mc.writes, writesBeforeRefusal, "the refusal wrote nothing");
    districtBuilder.finishJob(holder);

    const placedBefore = new Map(mc.placed);
    R.startLampRetrofit({ index: 1, dimension, say: (lines) => player.sendMessage(lines.join("\n")) });
    await pump({ until: () => R.readLampState(1)?.state === "done" });
    const state = R.readLampState(1);
    assert.ok(state, "the run stored its state");
    assert.equal(state.state, "done", `the run finished (${String(state.reason)})`);
    assert.equal(state.done, state.tiles);
    assert.ok(state.placed > 100, `lanterns were placed (${state.placed})`);
    assert.match(text(player), /is lit/, text(player).slice(-1200));
    assert.equal(mc.areas.size, 0, "the ticking area was released");
    assert.equal(districtBuilder.isBusy(), false, "the job slot was released");

    // Place-only and additive: every reported placement turned an air cell into a lantern, and every block
    // that stood before still stands (the build leaves cleared cells as explicit air in the fake world).
    const added = [...mc.placed.keys()].filter((key) => mc.placed.get(key) === "minecraft:lantern" && placedBefore.get(key) !== "minecraft:lantern");
    assert.equal(added.length, state.placed, "one new lantern per reported placement");
    for (const [key, id] of placedBefore) {
        if (id === "minecraft:air") continue; // a cleared cell the build recorded as explicit air may take a lantern
        assert.equal(mc.placed.get(key), id, `the retrofit changed ${key} from ${id}`);
    }

    // Coverage: every surface column measured before the run is within the documented light reach.
    const lamps = added.map((key) => {
        const [x, y, z] = key.split(",").map(Number);
        return { x, y, z };
    });
    const report = L.coverageOf(surfaces, lamps);
    assert.deepEqual(report.far.slice(0, 5), [], `${report.far.length} of ${report.open} surfaces are beyond light reach (worst ${report.worst})`);
    assert.ok(report.worst <= 14, `worst Manhattan distance ${report.worst} (light ${15 - report.worst})`);

    // A rerun places nothing: every grid point already has a lantern in its ring.
    const writesAfterFirst = mc.writes;
    R.startLampRetrofit({ index: 1, dimension, say: (lines) => player.sendMessage(lines.join("\n")) });
    await pump({ until: () => R.readLampState(1)?.state === "done" });
    const second = R.readLampState(1);
    assert.equal(second.state, "done");
    assert.equal(second.placed, 0, "a rerun must not place a second lantern");
    assert.ok(second.already > 100, `a rerun must find the lamps (${second.already})`);
    assert.equal(mc.writes, writesAfterFirst, "a rerun writes no block");

    // A tile that never loads pauses the run with the cursor saved; the next command finishes it.
    mc.createMode = () => "never";
    R.startLampRetrofit({ index: 1, dimension, say: (lines) => player.sendMessage(lines.join("\n")) });
    await pump({ until: () => R.readLampState(1)?.state === "paused" });
    const paused = R.readLampState(1);
    assert.equal(paused.state, "paused");
    assert.match(String(paused.reason), /would not load/, String(paused.reason));
    assert.equal(mc.areas.size, 0, "a paused run leaves no ticking area");
    assert.equal(districtBuilder.isBusy(), false, "a paused run frees the job slot");
    mc.createMode = () => undefined;
    const writesBeforeResume = mc.writes;
    R.startLampRetrofit({ index: 1, dimension, say: (lines) => player.sendMessage(lines.join("\n")) });
    await pump({ until: () => R.readLampState(1)?.state === "done" });
    assert.equal(R.readLampState(1).state, "done");
    assert.equal(mc.writes, writesBeforeResume, "the district was already lit by the first run");
});
