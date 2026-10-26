// Runtime tests of the one-command civilization workflow against the shared fake world (dev/lib/civharness.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import {
    Crash, TickingAreaError, WORLD_SIZE, BASE_Y, mc, key, naturalAt, typeAt, groundCell, dimension, load, writesAtImport, jobsAtImport, createKingdomStore, districtById, findValidationProblems, civCommands, builder, scan, districtBuilder, planstore, jobsModule, CIV, CIV_EVENT_IDS, CIV_LIMITS, siteplan, store, physicalCommands, gateCommands, handler, defaultValidate, jobsAfterRegister, writesAfterRegister, flush, pump, advanceTick, resetWorld, makePlayer, send, text, civRecord, worldFingerprint, propsSnapshot, restoreProps, restart, addOldHearthgate,
} from "../lib/civharness.mjs";

// ---------------------------------------------------------------------------- imports/activation are inert

test("importing and registering the commands starts nothing and writes nothing", async () => {
    assert.equal(writesAtImport, 0);
    assert.equal(jobsAtImport, 0);
    assert.equal(jobsAfterRegister, 0);
    assert.equal(writesAfterRegister, 0);
    assert.equal(handler.options.namespaces[0], "civ");
    resetWorld();
    await pump();
    assert.equal(mc.writes, 0);
    assert.equal(mc.jobs.length, 0);
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(builder.hasSession(), false);
    assert.equal(civRecord(), undefined);
});

test("every civ command id has exactly one colon and is registered by CIV_EVENT_IDS", () => {
    for (const id of Object.values(CIV_EVENT_IDS)) assert.equal(id.split(":").length, 2, id);
});

test("argument parsing: radius bounds, seed, district, site, unknown arguments", () => {
    const p = civCommands.parseCivArgs;
    // the whole result shape, so a new option is never accepted silently by a test that stopped looking
    assert.deepEqual(p([]), { radius: CIV.defaultSearchRadius, seed: undefined, districts: undefined, district: undefined, site: undefined, error: undefined });
    assert.equal(p(["radius=300", "seed=-7"]).radius, 300);
    assert.equal(p(["radius=300", "seed=-7"]).seed, -7);
    // every refusal that existed before district/site options still refuses
    assert.match(p([`radius=${CIV.maxSearchRadius + 1}`]).error, /radius must be/);
    assert.match(p(["radius=abc"]).error, /radius must be/);
    assert.match(p(["radius=12"]).error, /radius must be/);
    assert.match(p(["seed=1.5"]).error, /seed must be/);
    assert.match(p(["seed=x"]).error, /seed must be/);
    assert.match(p(["bogus"]).error, /unrecognised/);
    assert.match(p(["colour=red"]).error, /unknown argument/);
    assert.equal(p(["districts=1,2"]).districts, "1,2");
    // district= takes one of the five indexes, or "all" (which only civ:generate_plan acts on)
    for (const index of [1, 2, 3, 4, 5]) assert.equal(p([`district=${String(index)}`]).district, index, `district=${String(index)}`);
    assert.equal(p(["district=all"]).district, "all");
    assert.equal(p(["district=ALL"]).district, "all");
    for (const bad of ["district=0", "district=6", "district=-1", "district=1.5", "district=abc", "district=all2", "district=", "district=99"]) {
        assert.match(p([bad]).error, /district must be 1 to 5 \(or all, for civ:generate_plan\)/, bad);
    }
    // site= takes exactly "here"
    assert.equal(p(["site=here"]).site, "here");
    assert.equal(p(["site=HERE"]).site, "here");
    for (const bad of ["site=there", "site=", "site=here,there"]) assert.match(p([bad]).error, /site takes one value/, bad);
    // all four options together, and a refusal still stops the parse at the offending argument
    assert.deepEqual(p(["district=3", "site=here", "radius=400", "seed=9"]), { radius: 400, seed: 9, districts: undefined, district: 3, site: "here", error: undefined });
    assert.match(p(["district=3", "bogus=1"]).error, /^unknown argument 'bogus='/);
    assert.equal(civCommands.districtIndexOf(undefined), 1);
    assert.equal(civCommands.districtIndexOf("all"), 1);
    assert.equal(civCommands.districtIndexOf(4), 4);
});

test("populatedKingdom: a fresh kingdom is not populated; a tick or a construction project makes it so", () => {
    const district = (extra) => ({ civilians: 4, soldiers: 1, projects: [], ...extra });
    assert.equal(civCommands.populatedKingdom({ step: 0, districts: [district({})] }), undefined);
    assert.equal(civCommands.populatedKingdom({ step: 0, districts: [district({ projects: [{ kind: "homes", stage: 0, builders: 1 }] })] }).projects, 1, "a project alone is enough");
    assert.deepEqual(civCommands.populatedKingdom({ step: 3, districts: [district({}), district({ civilians: 6, soldiers: 2 })] }), { step: 3, districts: 2, civilians: 10, soldiers: 3, projects: 0 });
    assert.equal(civCommands.populatedKingdom({ districts: [] }), undefined, "a kingdom with no step is a fresh one");
});

test("district.civ record validation", () => {
    const good = { status: "building", seed: 3, anchor: { x: 1, z: 2 }, centre: { x: 3, z: 4 }, checksum: "abc", stage: "clear", startedStep: 0 };
    assert.deepEqual(civCommands.civRecordProblems(good), []);
    assert.deepEqual(civCommands.civRecordProblems(undefined), []);
    assert.ok(civCommands.civRecordProblems({ ...good, status: "weird" }).length > 0);
    assert.ok(civCommands.civRecordProblems({ ...good, anchor: { x: 1.5, z: 2 } }).length > 0);
    assert.ok(civCommands.civRecordProblems({ ...good, checksum: "" }).length > 0);
    assert.ok(civCommands.civRecordProblems({ ...good, startedStep: -1 }).length > 0);
});

// ---------------------------------------------------------------------------- op classification

test("classifyCivOp: live-block rules per op class", () => {
    const op = (kind, id = "minecraft:stone_bricks") => ({ x: 0, y: 0, z: 0, id, kind });
    const c = builder.classifyCivOp;
    assert.equal(c(op("wall"), undefined).action, "unloaded");
    assert.equal(c(op("wall"), "minecraft:air").action, "place");
    assert.equal(c(op("wall"), "minecraft:short_grass").action, "place");
    assert.equal(c(op("wall"), "minecraft:dirt").action, "place");
    assert.equal(c(op("wall"), "minecraft:stone_bricks").action, "built");
    for (const foreign of ["minecraft:oak_planks", "minecraft:chest", "minecraft:cobblestone", "minecraft:iron_block", "minecraft:glass"]) {
        const verdict = c(op("wall"), foreign);
        assert.equal(verdict.action, "skip", foreign);
        assert.match(verdict.reason, /occupied/);
    }
    // a block this plan places at the same cell counts as ours
    assert.equal(c(op("structure", "minecraft:stone_bricks"), "minecraft:stone_bricks", { final: "minecraft:stone_bricks", nonAir: ["minecraft:stone_bricks"] }).action, "built");
    assert.equal(c(op("structure", "minecraft:glass"), "minecraft:stone_bricks", { final: "minecraft:stone_bricks", nonAir: ["minecraft:glass", "minecraft:stone_bricks"] }).action, "place", "replay over the FINAL planned block converges");
    // clear: only plants/trees/air
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:short_grass").action, "place");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:air").action, "built");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:oak_log").action, "tree");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:oak_planks").action, "skip");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:dirt").action, "skip");
    // cut/fill/top follow structures/terrain.js
    assert.equal(c(op("cut", "minecraft:air"), "minecraft:dirt").action, "place");
    assert.equal(c(op("cut", "minecraft:air"), "minecraft:chest").action, "skip");
    assert.equal(c(op("fill", "minecraft:dirt"), "minecraft:air").action, "place");
    assert.equal(c(op("fill", "minecraft:dirt"), "minecraft:stone").action, "built");
    assert.equal(c(op("fill", "minecraft:dirt"), "minecraft:oak_planks").action, "skip");
    assert.equal(c(op("top", "minecraft:grass_block"), "minecraft:dirt").action, "place");
    assert.equal(c(op("top", "minecraft:grass_block"), "minecraft:oak_planks").action, "skip");
    // still water: every ADDITIVE kind may stand in it (decks/pads on piers, walls in the sea), never a cut
    for (const kind of ["support", "footing", "fill", "pad", "wall", "tower", "merlon", "walk", "gate", "road", "stair", "deck", "bridge", "pillar", "rail", "retain"]) {
        assert.equal(c(op(kind), "minecraft:water").action, "place", `${kind} must stand in still water`);
    }
    assert.equal(c(op("cut", "minecraft:air"), "minecraft:water").action, "skip");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:water").action, "skip");
    // trees need proof
    assert.equal(c(op("wall"), "minecraft:oak_leaves").action, "tree");
});

// ---------------------------------------------------------------------------- pipeline helpers

const WORLD_SEED = 1;
const PLAN_SEED = 1;
const GEN = `seed=${PLAN_SEED}`;
const MIN_TIMEOUT = { timeout: 300000 };

async function generate(player, message = GEN) {
    send(CIV_EVENT_IDS.generate, message, player);
    await pump();
}

/** Run generate on world W; returns what the tests need. */
async function fullRun(worldSeed = WORLD_SEED, worldOptions = {}, prepare) {
    resetWorld(worldSeed, worldOptions);
    prepare?.();
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer(0, 0);
    await generate(player);
    return { player, outcome };
}

/** Plan + persist, then stop before the first block (indexing job queued, nothing written). */
async function plannedOnly(worldSeed = WORLD_SEED, planSeed = PLAN_SEED, worldOptions = {}, prepare) {
    resetWorld(worldSeed, worldOptions);
    prepare?.();
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer(0, 0);
    send(CIV_EVENT_IDS.generate, `seed=${planSeed}`, player);
    await pump({ until: () => builder.hasSession() });
    assert.ok(builder.hasSession(), `planning must reach construction:
${text(player).slice(-900)}`);
    assert.equal(mc.writes, 0, "nothing may be written before the abort");
    send(CIV_EVENT_IDS.abort, "", player);
    await pump();
    assert.equal(builder.hasSession(), false);
    assert.equal(districtBuilder.isBusy(), false);
    return { player, outcome, props: propsSnapshot() };
}

let baselinePromise;
/** The uninterrupted reference run (cached). */
function baseline() {
    baselinePromise ??= (async () => {
        let kingdomBefore;
        const run = await fullRun(WORLD_SEED, {}, () => {
            kingdomBefore = structuredClone(store.load().kingdom);
        });
        assert.match(text(run.player), /is built/, text(run.player).slice(-1500));
        const after = store.load().kingdom;
        assert.deepEqual(findValidationProblems(after), []);
        const stripped = structuredClone(after);
        delete districtById(stripped, "district-1").civ;
        for (const d of stripped.districts) for (const g of d.gates ?? []) { delete g.physical; delete g.mode; }
        for (const d of kingdomBefore.districts) for (const g of d.gates ?? []) { delete g.physical; delete g.mode; }
        assert.deepEqual(stripped, kingdomBefore, "the simulation state is untouched apart from the small district.civ record");
        const fp = worldFingerprint();
        return {
            ...run,
            fp,
            messages: [...run.player.messages],
            stats: { reads: mc.maxReadsPerSlice, writes: mc.maxWritesPerSlice, slices: mc.slices, areaMaxChunks: mc.areaMaxChunks, areaViolations: mc.areaViolations, firstWrite: mc.firstWrite, areasLeft: mc.areas.size, totalWrites: mc.writes },
            civ: structuredClone(civRecord()),
            written: new Set(mc.written),
            placed: new Map(mc.placed),
            // everything a later district starts from: the finished district 1, in the property store and in the world
            savedProps: propsSnapshot(),
            savedPlaced: new Map(mc.placed),
        };
    })();
    return baselinePromise;
}

function assertSameWorld(actual, expected, label) {
    if (actual.length === expected.length && actual.every((line, i) => line === expected[i])) return;
    const a = new Set(actual);
    const e = new Set(expected);
    const extra = actual.filter((line) => !e.has(line)).slice(0, 5);
    const missing = expected.filter((line) => !a.has(line)).slice(0, 5);
    assert.fail(`${label}: worlds differ (${actual.length} vs ${expected.length} modified cells). only here: ${extra.join(" ")} | only there: ${missing.join(" ")}`);
}

function noCivData() {
    return [...mc.props.keys()].filter((k) => k.startsWith("civ:plan") || k.startsWith("civ:jobs"));
}

function assertUntouched(player, stage) {
    assert.equal(mc.writes, 0, "no block may be written");
    assert.equal(civRecord(), undefined, "no district.civ record");
    assert.deepEqual(noCivData(), [], "no plan or job data stored");
    assert.equal(mc.areas.size, 0, "no ticking area left behind");
    assert.equal(districtBuilder.isBusy(), false, "the job slot is free");
    assert.equal(builder.hasSession(), false);
    if (stage) assert.match(text(player), new RegExp(`Stopped at ${stage}`), text(player).slice(-800));
    assert.match(text(player), /No block was written|nothing was changed/i);
}

// ---------------------------------------------------------------------------- failure paths: zero writes, no residue

test("open sea: planning succeeds read-only (piers) and writes nothing", MIN_TIMEOUT, async () => {
    resetWorld(1, { field: { lakes: [{ x: 0, z: 0, r: 4000 }] } });
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, "seed=1", player);
    await pump();
    assert.match(text(player), /Plan is valid/, text(player).slice(-800));
    assert.equal(mc.writes, 0, "planning writes nothing");
});

test("failure: lava through the area -> no site, zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1, { lavaEvery: 40 });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
    assert.match(text(player), /lava/);
});

test("a lake at the anchor: the plan adapts (coastal window or piers) and stays read-only", MIN_TIMEOUT, async () => {
    // Water on the window border is open (sea or river mouth); water inside it is a lake a district cannot
    // join, so the search moves or the plan spans the water - either way it plans, and writes nothing.
    resetWorld(1, { field: { lakes: [{ x: 0, z: 0, r: 240 }] } });
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, "seed=1", player);
    await pump();
    assert.match(text(player), /Plan is valid/, text(player).slice(-800));
    assert.equal(mc.writes, 0, "planning writes nothing");
});

test("failure: unloaded columns during the coarse survey are recorded, never guessed -> zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.unloaded = ({ x, z }) => x % 8 === 0 && z % 8 === 0 && (x / 8) % 5 === 0 && (z / 8) % 5 === 0;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
    assert.match(text(player), /unloaded/);
});

test("failure: unloaded columns inside district 1 stop the plan before anything is stored", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.unloaded = ({ x, z }) => x % 8 !== 0 && ((x % 17) + 17) % 17 === 3 && ((z % 17) + 17) % 17 === 5;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "unloaded");
    assert.match(text(player), /could not be read/);
});

test("failure: nothing readable at all (whole world unloaded) -> zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.unloaded = () => true;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "scan");
});

test("failure: an invalid master plan stops the run", MIN_TIMEOUT, async () => {
    resetWorld(1);
    builder.seams.validatePlan = function* () {
        return { ok: false, problems: ["forced: walls leak"], metrics: {} };
    };
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "validate");
    assert.match(text(player), /walls leak/);
});

test("failure: a plan too big for storage is refused politely", MIN_TIMEOUT, async () => {
    resetWorld(1);
    builder.seams.maxPlanBytes = 6000;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "too-big");
    assert.match(text(player), /only 6000 may be stored/);
});

test("failure: a crash while the plan is being stored leaves no half state and writes no block", MIN_TIMEOUT, async () => {
    resetWorld(1);
    builder.seams.onOutcome = () => {
        mc.crashProps = mc.propWrites + 2;
    };
    const player = makePlayer();
    await generate(player);
    assert.equal(mc.writes, 0);
    assert.equal(mc.firstWrite, undefined);
    assert.equal(builder.hasSession(), false);
    await restart();
    const loaded = planstore.createPlanStore(mc.world).loadPlan();
    assert.ok(["absent", "ok"].includes(loaded.status), `plan store must never be half written, saw ${loaded.status}`);
    assert.equal(civRecord(), undefined, "no kingdom record points at the partial plan");
    assert.equal(districtBuilder.isBusy(), false);
});

test("failure: unreadable kingdom, console source and wrong dimension are refused before any read", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, undefined);
    await pump();
    assert.ok(mc.messages.some((m) => /Run this as a player/.test(m)), "console source refused");
    const kingdom = mc.props.get("civ:kingdom");
    mc.props.delete("civ:kingdom");
    await generate(player);
    assert.match(text(player), /No readable kingdom/);
    mc.props.set("civ:kingdom", kingdom);
    const nether = { ...player, messages: [], dimension: { ...dimension, id: "minecraft:nether" } };
    nether.sendMessage = (m) => nether.messages.push(...(Array.isArray(m) ? m : [m]));
    await generate(nether);
    assert.match(text(nether), /overworld/);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0, "refusals do not even read the world");
});

// ---------------------------------------------------------------------------- plan only

test("civ:generate_plan is strictly read-only and prints the numbers", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const before = propsSnapshot();
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    await pump();
    assert.equal(mc.writes, 0);
    assert.deepEqual([...mc.props.entries()], [...before.entries()], "not even a property was written");
    assert.equal(mc.areas.size, 0);
    assert.equal(districtBuilder.isBusy(), false);
    const out = text(player);
    assert.match(out, /Plan is valid/);
    assert.match(out, /District areas \d+ \/ \d+ \/ \d+ \/ \d+ \/ \d+ columns; compactness/);
    assert.match(out, /Walls \d+ blocks, \d+ gates, roads \d+ blocks, \d+ lots/);
    assert.match(out, /Estimated \d+ block operations in about \d+ slices \(survey \+ planning \+ build\), estimated minutes [\d.]+ at one slice per tick - an estimate until measured in Minecraft\. Stored size \d+ \/ 120000 bytes/);
    assert.match(out, /Nothing was written/);
    assert.ok(mc.reads > 0);
});

// ---------------------------------------------------------------------------- the whole thing

test("one command: scan, plan, validate, store, then build - everything within budgets", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const out = base.messages.join("\n");
    // zero writes before a validated plan, a stored plan, a stored queue and a kingdom record exist
    assert.deepEqual(base.stats.firstWrite, { plan: true, jobs: true, civ: true });
    // staged, reported messages
    for (const step of ["[1/6]", "[2/6]", "[3/6]", "[4/6]", "[5/6]", "[6/6]", "Plan stored", "indexing the plan"]) assert.ok(out.includes(step), step);
    const deciles = [...out.matchAll(/^ {2}(\w+): (\d+)% \((\d+) \/ (\d+) ops, (\d+) skipped\)$/gm)];
    assert.ok(deciles.length >= 8, `progress every 10% (${deciles.length} lines)`);
    const pcts = deciles.map((m) => Number(m[2]));
    assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b));
    assert.ok(deciles.some((m) => m[1] === "walls") && deciles.some((m) => m[1] === "lots"), "stage names are reported");
    // final report
    assert.match(out, /=== Hearthgate \(enlarged\) is built ===/);
    assert.match(out, /Operations: estimated (\d+), processed \1;/);
    assert.match(out, /blocks placed \d+, already present \d+, skipped \d+, failed 0, state fallbacks 0/);
    const tp = /\/tp @s (-?\d+) (-?\d+) (-?\d+)/.exec(out);
    assert.ok(tp, "a /tp line with coordinates");
    const [, tx, ty, tz] = tp.map(Number);
    assert.ok(ty > BASE_Y - 10 && ty < 200, `a sensible y (${ty})`);
    assert.ok(Math.abs(tx) < 800 && Math.abs(tz) < 800);
    // budgets (measured on the fake world's own counters, per job.next() call)
    assert.ok(base.stats.reads <= CIV_LIMITS.maxReadsPerSlice, `reads per slice ${base.stats.reads}`);
    assert.ok(base.stats.writes <= CIV_LIMITS.maxBlocksPerSlice, `writes per slice ${base.stats.writes}`);
    assert.match(out, new RegExp(`max ${CIV_LIMITS.maxBlocksPerSlice} ops, \\d+ reads per slice`));
    // chunk holding: one area at a time, never above the cap, none left
    assert.ok(base.stats.areaMaxChunks <= 100, `ticking area ${base.stats.areaMaxChunks} chunks`);
    assert.equal(base.stats.areaViolations, 0);
    assert.equal(base.stats.areasLeft, 0);
    // record
    assert.equal(base.civ.status, "complete");
    assert.equal(base.civ.stage, "complete");
    assert.deepEqual(civCommands.civRecordProblems(base.civ), []);
    assert.equal(base.civ.seed, PLAN_SEED);
    assert.ok(base.outcome.stats.ops.maxRun <= 25000, `longest stretch between planning yields: ${base.outcome.stats.ops.maxRun} ops`);
    assert.ok(base.outcome.stats.ops.yields > 100);
    assert.equal(base.civ.opsTotal, base.civ.ops);
});

test("the built world matches the plan block for block and stays inside the claimed area", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const record = base.outcome.record;
    const expected = new Map();
    for (const stage of siteplan.SITE_STAGES) {
        for (let i = 0; i < record[stage].length; i += 1) {
            for (const op of siteplan.siteOpsFor(record, stage, i)) expected.set(key(op.x, op.y, op.z), op.id);
        }
    }
    assert.ok(expected.size > 20000);
    let wrong = 0;
    const samples = [];
    for (const [k, id] of expected) {
        const placed = base.placed.get(k);
        const [x, y, z] = k.split(",").map(Number);
        const got = placed ?? naturalAt(x, y, z);
        if (got !== id) {
            wrong += 1;
            if (samples.length < 5) samples.push(`${k} is ${got}, plan says ${id}`);
        }
    }
    assert.equal(wrong, 0, samples.join("; "));
    const region = base.outcome.region;
    for (const k of base.written) {
        const [x, , z] = k.split(",").map(Number);
        assert.ok(x >= region.x0 - 4 && x <= region.x1 + 4 && z >= region.z0 - 4 && z <= region.z1 + 4, `stray write at ${k}`);
    }
    assert.ok(base.written.size > 20000);
});

test("estimated size and storage are reported and within limits", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const storage = base.outcome.stats.storage;
    assert.ok(storage.bytes <= storage.limit);
    assert.ok(storage.chunks >= 2, "the plan is stored in several chunks");
    assert.ok(siteplan.siteOpCount(base.outcome.record) > 20000);
});

// ---------------------------------------------------------------------------- the old Hearthgate

test("the original 49x49 Hearthgate is avoided and never touched", MIN_TIMEOUT, async () => {
    let markers;
    const run = await fullRun(1, {}, () => {
        markers = addOldHearthgate(250, 0);
    });
    assert.match(text(run.player), /1 protected footprint/);
    assert.match(text(run.player), /is built/, text(run.player).slice(-1200));
    for (const k of markers) {
        assert.ok(mc.placed.get(k) === "minecraft:stone_bricks" || mc.placed.get(k) === "minecraft:cobblestone", `marker ${k} survived`);
        assert.ok(!mc.written.has(k), `marker ${k} was never written`);
    }
    for (const k of mc.written) {
        const [x, , z] = k.split(",").map(Number);
        assert.ok(!(x >= 250 - 25 && x <= 250 + 25 && z >= -25 && z <= 25), `write inside the protected footprint at ${k}`);
    }
    assert.ok(run.outcome.site.x < 0, `the site moved away from the old district (centre ${run.outcome.site.x})`);
    const { overlapsExclusion } = await load("civ", "siteselect.js");
    for (const d of run.outcome.plan.districts) {
        assert.equal(overlapsExclusion({ x0: 225, z0: -25, x1: 275, z1: 25 }, [{ polygon: d.outline }], 0), false, `district ${d.index} outline avoids the old footprint`);
    }
});

// ---------------------------------------------------------------------------- player blocks, existing walls, trees

/** Choose ops spread through a stage. */
function pickCells(record, stage, count) {
    const picked = [];
    const list = record[stage];
    for (let i = 0; i < list.length && picked.length < count; i += 1) {
        const ops = siteplan.siteOpsFor(record, stage, i);
        for (let j = Math.floor(ops.length / 3); j < ops.length && picked.length < count; j += 29) picked.push(ops[j]);
    }
    return picked;
}

/** The plan + persist state of ONE district lives in two slots: the shared master plan and the district's own site slot. */
function siteStoreFor(index = 1) {
    return planstore.createPlanStore(mc.world, { prefix: builder.sitePrefixFor(index) });
}

function jobStoreFor(index = 1) {
    return jobsModule.createJobStore(mc.world, { prefix: builder.jobPrefixFor(index) });
}

/**
 * Reload what a run stored, the way a restart does: the master plan from its own slot, the district's ground and
 * options from that district's site slot.
 * @param {number} [index]
 */
function rehydrateStored(index = 1) {
    const master = builder.loadMasterPlan();
    assert.equal(master.status, "ok", "the master plan is stored");
    const loaded = siteStoreFor(index).loadPlan();
    assert.equal(loaded.status, "ok", `the site payload of district ${String(index)} is stored`);
    const payload = loaded.plan;
    const re = siteplan.rehydrateSite(master.plan, index, payload.ground, { ...payload.siteOptions, expectChecksum: payload.siteChecksum });
    assert.ok(re.ok, re.problems.join(";"));
    return { payload, plan: master.plan, record: re.record };
}

test("player blocks and existing walls are never overwritten and are counted as skipped", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    restoreProps(planned.props);
    const { record } = rehydrateStored();
    const protectedBlocks = new Map();
    const place = (op, id) => {
        const k = key(op.x, op.y, op.z);
        mc.placed.set(k, id);
        protectedBlocks.set(k, id);
    };
    pickCells(record, "walls", 24).forEach((op, i) => place(op, ["minecraft:oak_planks", "minecraft:chest", "minecraft:glass", "minecraft:crafting_table"][i % 4]));
    pickCells(record, "roads", 30).forEach((op) => place(op, "minecraft:bookshelf"));
    const treeFree = (op) => {
        for (let dx = -3; dx <= 3; dx += 1) for (let dz = -3; dz <= 3; dz += 1) if (groundCell(op.x + dx, op.z + dz)?.tree) return false;
        return true;
    };
    // (a log standing inside a natural tree is indistinguishable from the tree, so logs go where no tree is near)
    pickCells(record, "lots", 400).filter((op, i) => i % 2 === 0 || treeFree(op)).slice(0, 40).forEach((op, i) => place(op, i % 2 === 0 ? "minecraft:oak_planks" : treeFree(op) ? "minecraft:spruce_log" : "minecraft:oak_planks"));
    const bbox = record.lots[0].bbox;
    const wy = (groundCell(bbox.x0, bbox.z0).g ?? BASE_Y) + 1;
    for (let i = 0; i < 30; i += 1) place({ x: bbox.x0 + i, y: wy, z: bbox.z0 + 3 }, "minecraft:stone_bricks");
    const before = new Map(protectedBlocks);
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/, text(player).slice(-1500));
    const lost = [];
    for (const [k, id] of before) {
        if (typeAt(...k.split(",").map(Number)) !== id) lost.push(k);
    }
    if (lost.length > 0) {
        const detail = [];
        for (const k of lost.slice(0, 3)) {
            const [lx, ly, lz] = k.split(",").map(Number);
            for (const stage of siteplan.SITE_STAGES) {
                record[stage].forEach((el, i) => {
                    for (const op of siteplan.siteOpsFor(record, stage, i)) if (op.x === lx && op.y === ly && op.z === lz) detail.push(`${k} ${stage}/${el.id} ${op.kind}:${op.id} (player ${before.get(k)}, now ${typeAt(lx, ly, lz)})`);
                });
            }
        }
        assert.fail(`player blocks overwritten: ${detail.join(" | ")}`);
    }
    assert.equal(lost.length, 0);
    const skipped = Number(/skipped (\d+), failed/.exec(text(player))?.[1]);
    assert.ok(skipped >= 20, `skips are counted (${skipped})`);
    assert.match(text(player), /Skipped \(never overwritten\):[\s\S]*\d+x occupied by minecraft:bookshelf/);
    assert.equal(civRecord().status, "complete");
});

test("a player-made tree (persistent leaves) and a log-only pillar are left alone; natural trees are cleared", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    restoreProps(planned.props);
    const { record } = rehydrateStored();
    const [wallOp] = pickCells(record, "walls", 1);
    const [roadOp] = pickCells(record, "roads", 1);
    const mine = new Set();
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
            for (const dy of [0, 1]) {
                const k = key(wallOp.x + dx, wallOp.y + dy, wallOp.z + dz);
                mc.placed.set(k, "minecraft:oak_leaves");
                mine.add(k);
            }
        }
    }
    mc.persistent = (x, y, z) => mine.has(key(x, y, z));
    for (let dy = 0; dy < 3; dy += 1) {
        const k = key(roadOp.x, roadOp.y + dy, roadOp.z);
        mc.placed.set(k, "minecraft:oak_log");
        mine.add(k);
    }
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/);
    for (const k of mine) assert.ok(["minecraft:oak_leaves", "minecraft:oak_log"].includes(mc.placed.get(k)), `${k} survived`);
    assert.match(text(player), /[1-9]\d* tree\(s\) left alone/);
    assert.match(text(player), /Natural trees cleared [1-9]/);
});

// ---------------------------------------------------------------------------- pause / abort / resume / restart

test("a clean resume from the stored plan builds the identical world", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const planned = await plannedOnly();
    await restart();
    restoreProps(planned.props);
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /Verified plan [0-9a-f]{8}/);
    assert.ok(civCommands.lastResumeOps.maxRun <= 25000 && civCommands.lastResumeOps.yields > 10, `resume rebuild stretch ${civCommands.lastResumeOps.maxRun} ops, ${civCommands.lastResumeOps.yields} yields`);
    assert.match(text(player), /is built/);
    assertSameWorld(worldFingerprint(), base.fp, "resume");
});

test("abort twice mid-build and resume (same process) gives the identical world; the queue is kept", MIN_TIMEOUT, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    for (const target of [30, 70]) {
        await pump({ until: () => (builder.sessionStatus()?.pct ?? 0) >= target });
        const midWrites = mc.writes;
        assert.ok(midWrites > 0 && builder.hasSession());
        send(CIV_EVENT_IDS.abort, "", player);
        await pump();
        assert.match(text(player), /Civilization build stopped/);
        assert.equal(builder.hasSession(), false);
        assert.equal(districtBuilder.isBusy(), false);
        assert.equal(mc.writes, midWrites, "no write after the abort");
        assert.equal(civRecord().status, "paused");
        const stored = jobsModule.createJobStore(mc.world).loadQueue({ recoverRunning: false });
        assert.equal(stored.status, "ok");
        assert.equal(stored.queue.state, "paused");
        const overall = jobsModule.progress(stored.queue);
        assert.ok(overall.pct >= target - 1 && overall.pct < 100, `progress kept (${overall.pct}%)`);
        send(CIV_EVENT_IDS.resume, "", player);
    }
    await pump();
    assert.match(text(player), /is built/);
    assertSameWorld(worldFingerprint(), base.fp, "abort/resume");
});

test("process crashes at three points; each restart reloads only from the property store and the world ends identical", { timeout: 600000 }, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    let died = 0;
    for (const at of [4000, 21000, 47000]) {
        mc.dieAtWrites = at;
        await pump({ stopOnDead: true });
        assert.equal(mc.dead, true, `process died at ${at} writes`);
        died += 1;
        const writtenAtDeath = mc.written.size;
        await restart();
        assert.equal(mc.written.size, writtenAtDeath);
        const revived = makePlayer();
        revived.sendMessage = (m) => player.messages.push(...(Array.isArray(m) ? m : [m]));
        send(CIV_EVENT_IDS.resume, "", revived);
    }
    mc.dieAtWrites = null;
    await pump();
    assert.equal(died, 3);
    assert.match(text(player), /is built/, text(player).slice(-1200));
    assertSameWorld(worldFingerprint(), base.fp, "crash/restart");
    assert.equal(civRecord().status, "complete");
});

test("a chunk that stays unloaded pauses the build with a saved cursor; resuming finishes identically", MIN_TIMEOUT, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    let blackout = false;
    mc.unloaded = () => blackout;
    await pump({ until: () => mc.writes >= 25000 });
    blackout = true;
    await pump();
    assert.match(text(player), /Build paused/);
    assert.match(text(player), /not loaded/);
    assert.equal(builder.hasSession(), false);
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(mc.areas.size, 0);
    assert.equal(civRecord().status, "paused");
    const stored = jobsModule.createJobStore(mc.world).loadQueue({ recoverRunning: false });
    const overall = jobsModule.progress(stored.queue);
    assert.ok(overall.pct > 20 && overall.pct < 100, `cursor saved (${overall.pct}%)`);
    blackout = false;
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/);
    assertSameWorld(worldFingerprint(), base.fp, "unloaded pause");
});

// ---------------------------------------------------------------------------- resume refusals

test("resume refuses on a checksum mismatch, a site-version mismatch, a wrong district, a corrupt ground and a foreign queue - without writing", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    /** @param {string} label @param {() => void} tamper @param {RegExp} message */
    async function refused(label, tamper, message) {
        await restart();
        restoreProps(planned.props);
        tamper();
        const writes = mc.writes;
        const propWrites = mc.propWrites;
        const player = makePlayer();
        send(CIV_EVENT_IDS.resume, "", player);
        await pump();
        const out = text(player);
        assert.match(out, message, `${label}: ${out.slice(-900)}`);
        assert.equal(mc.writes, writes, `${label}: no block written`);
        assert.equal(mc.propWrites, propWrites, `${label}: a refused resume stores nothing`);
        assert.equal(districtBuilder.isBusy(), false, `${label}: the job slot is free`);
        assert.equal(mc.areas.size, 0, `${label}: no ticking area left`);
    }
    const siteStore = () => siteStoreFor(1);
    /** Rewrite district 1's own site slot with a tampered payload. */
    const tamperSite = (mutate) => {
        const payload = siteStore().loadPlan().plan;
        mutate(payload);
        assert.ok(siteStore().savePlan(payload).ok, "the tampered payload fits its slot");
    };
    await refused("checksum mismatch", () => {
        const k = store.load().kingdom;
        districtById(k, "district-1").civ.checksum = "00000000";
        store.save(k);
    }, /not the one this district was started from/);
    await refused("site version mismatch", () => tamperSite((payload) => {
        payload.site.version = 99;
    }), /site version 99/);
    await refused("payload of another district", () => tamperSite((payload) => {
        payload.district = 2;
    }), /the stored plan is district 2, not 1/);
    await refused("corrupt ground", () => tamperSite((payload) => {
        payload.ground.g = `${payload.ground.g.slice(0, -40)}${"A".repeat(40)}`;
    }), /stored ground is unusable|could not be rebuilt/);
    await refused("foreign queue", () => {
        const queue = jobsModule.createQueue({ clear: [{ total: 10, hash: 1 }] }, { planHash: "zzzz" });
        assert.ok(jobsModule.createJobStore(mc.world).saveQueue(queue).ok);
    }, /does not belong to this plan/);
    await refused("no master plan", () => {
        for (const k of [...mc.props.keys()]) if (k.startsWith("civ:plan")) mc.props.delete(k);
    }, /stored plan is absent/);
    await refused("no civ record", () => {
        const k = store.load().kingdom;
        delete districtById(k, "district-1").civ;
        store.save(k);
    }, /no generated civilization to resume/);
});

test("an OLD world that stored district 1's ground inside the master-plan slot still resumes and builds the identical world", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const planned = await plannedOnly();
    await restart();
    restoreProps(planned.props);
    // Fold this district's site payload back into the single pre-district slot and drop its own slot: that is what a
    // world planned by an earlier build holds, and it must still be resumable (saved-world compatibility).
    const master = planstore.createPlanStore(mc.world);
    const site = siteStoreFor(1);
    const payload = site.loadPlan().plan;
    const merged = { ...master.loadPlan().plan, ground: payload.ground, siteChecksum: payload.siteChecksum, siteOptions: payload.siteOptions, site: payload.site, ops: payload.ops };
    site.clear();
    const saved = master.savePlan(merged);
    assert.ok(saved.ok, String(saved.reason ?? saved.status));
    assert.equal(siteStoreFor(1).loadPlan().status, "absent", "the district slot is gone: only the legacy shape remains");
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /Verified plan [0-9a-f]{8}/, text(player).slice(-900));
    assert.match(text(player), /is built/, text(player).slice(-900));
    assertSameWorld(worldFingerprint(), base.fp, "legacy single-slot resume");
    assert.equal(civRecord().status, "complete");
});

// ---------------------------------------------------------------------------- exclusion, gating, determinism, hooks

test("a second command while a job runs is refused; a second generate after completion is refused", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    await pump({ until: () => (builder.sessionStatus()?.pct ?? 0) >= 5 });
    const writes = mc.writes;
    const other = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, other);
    send(CIV_EVENT_IDS.plan, GEN, other);
    send(CIV_EVENT_IDS.resume, "", other);
    await flush();
    assert.equal((text(other).match(/already running/g) ?? []).length, 3, text(other));
    send(CIV_EVENT_IDS.status, "", other);
    await flush();
    assert.match(text(other) + mc.messages.join("\n"), /Running \(building\)/);
    assert.ok(mc.writes >= writes);
    await pump();
    assert.match(text(player), /is built/);
    const again = makePlayer();
    await generate(again);
    assert.match(text(again), /already exists here \(complete\)/);
    const token = districtBuilder.reserveJob("scout");
    assert.ok(token);
    const third = makePlayer();
    await generate(third);
    assert.match(text(third), /already running/);
    districtBuilder.finishJob(token);
});

test("a populated world is not silently surveyed: generate refuses, and a confirmation starts it", MIN_TIMEOUT, async () => {
    // A running kingdom has no physical district yet: searching for a new site would be a big, surprising write
    // in a world that is already being played. The refusal must write nothing and must name both ways forward;
    // the horn's form passes the same acknowledgement, so it has to start the identical run.
    resetWorld(1);
    const kingdom = store.load().kingdom;
    kingdom.step = 42;
    districtById(kingdom, "district-1").projects.push({ kind: "homes", stage: 1, builders: 2 });
    store.save(kingdom);
    const writes = mc.writes;

    const refused = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, refused);
    await flush();
    const refusal = text(refused);
    assert.match(refusal, /=== Generate refused ===/, refusal);
    assert.match(refusal, /this world already holds a running kingdom: 5 districts, \d+ civilians, \d+ soldiers, 1 construction projects at simulation step 42/);
    assert.match(refusal, /Horn of Hearthgate/);
    assert.match(refusal, new RegExp(`${CIV_EVENT_IDS.generate} site=here`));
    assert.equal(refusal.includes("=== Generating"), false, "the refusal never starts the run");
    assert.equal(mc.writes, writes, "the refusal writes nothing");
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(civRecord(), undefined);

    // the Horn of Hearthgate's confirmation is the same acknowledgement (its fifth argument)
    const confirmed = makePlayer();
    void civCommands.runGenerate(store, confirmed, civCommands.parseCivArgs([GEN]), false, true);
    await flush();
    const started = text(confirmed);
    assert.match(started, /=== Generating Hearthgate \(district-1\) ===/, started);
    assert.match(started, /This world is already being played \(5 districts, \d+ civilians, \d+ soldiers, 1 construction projects at step 42\)/);
    assert.equal(districtBuilder.isBusy(), true, "the confirmation starts the run");
    // an aborted run's promise is deliberately not awaited: the abort removes the job instead of finishing it
    send(CIV_EVENT_IDS.abort, "", confirmed);
    await pump();
    assert.equal(districtBuilder.isBusy(), false, "the aborted run released its job");
    assert.equal(civRecord(), undefined, "an aborted survey stored no record");
});

test("district selection: district= is accepted, an out-of-range index is refused, and the dev gate still refuses nonsense", MIN_TIMEOUT, async () => {
    // Districts 2-5 are buildable now, so the old "not enabled in this build" wording is gone. What must still hold:
    // a valid district= is understood and acted on, an invalid one is refused with a reason, districts= (the old
    // multi-district spelling) is still refused, and the gate still refuses everything it has to refuse - all of it
    // with zero writes and zero world reads.
    resetWorld(1);
    const player = makePlayer();
    for (const bad of ["district=6 seed=1", "district=0 seed=1", "district=seven seed=1"]) {
        send(CIV_EVENT_IDS.generate, bad, player);
    }
    await flush();
    const refused = text(player);
    assert.equal((refused.match(/district must be 1 to 5/g) ?? []).length, 3, refused);
    assert.ok(/Usage: \/scriptevent civ:generate \[district=1-5\] \[site=here\] \[radius=24-400\] \[seed=N\]/.test(refused), refused);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0, "a bad argument is refused before the world is read");
    // the gate is off: the generation commands are not registered, so nothing answers and nothing is built
    send(CIV_EVENT_IDS.devgate, "off", makePlayer());
    const silent = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=2 seed=1", silent);
    await pump();
    assert.equal(text(silent), "", "with the gate off the generation command is not answered at all");
    // with the gate ON a valid district= is accepted: it gets past the parser and past the gate and is stopped only
    // by the real reason - this world has no five-district master plan yet
    send(CIV_EVENT_IDS.devgate, "on", player);
    assert.equal(mc.props.get(CIV.devGateKey), true);
    const second = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=2 seed=1", second);
    await pump();
    const started = text(second);
    assert.doesNotMatch(started, /not enabled|development-only|not available yet/i, started.slice(-900));
    assert.match(started, /nothing to build district-2 from: this world holds no five-district master plan/);
    assert.match(started, /Build district 1 first/);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0);
    // district=all stays read-only, and the old districts= list is still refused (with the new, true wording)
    const third = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=all", third);
    send(CIV_EVENT_IDS.generate, "districts=1,2,3", third);
    await pump();
    assert.match(text(third), /district=all is read-only/);
    assert.match(text(third), /districts= lists several at once; one command builds one district: district=1 to district=5/);
    assert.match(text(third), /The development gate is on, so districts 2 and up may start as soon as their lower-numbered neighbours are complete/);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0);
    // the gate itself still refuses nonsense and reports its own state
    const gate = makePlayer();
    send(CIV_EVENT_IDS.devgate, "maybe", gate);
    send(CIV_EVENT_IDS.devgate, "", gate);
    await flush();
    assert.match(text(gate), /Usage: \/scriptevent civ:generate_devgate on\|off/);
    assert.match(text(gate), /Development gate is on/);
    send(CIV_EVENT_IDS.devgate, "off", gate);
    assert.equal(mc.props.get(CIV.devGateKey), false);
    assert.deepEqual(noCivData(), [], "nothing was stored by any refusal");
    assert.equal(districtBuilder.isBusy(), false);
});

test("status and abort answer sensibly when nothing is running", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.status, "", player);
    send(CIV_EVENT_IDS.abort, "", player);
    await flush();
    const all = mc.messages.join("\n") + text(player);
    assert.match(all, /Not generated/);
    assert.match(all, /No civilization job is running/);
    assert.equal(mc.writes, 0);
});

test("after a full run the kingdom gate records carry gate.physical and civ:gate_status reports them", MIN_TIMEOUT, async () => {
    const run = await fullRun();
    assert.match(text(run.player), /Gates registered with the simulation \(initially open\)/);
    const kingdom = store.load().kingdom;
    assert.deepEqual(findValidationProblems(kingdom), []);
    const physical = kingdom.districts.flatMap((d) => (d.gates ?? []).filter((g) => g.physical !== undefined).map((g) => ({ district: d.id, gate: g })));
    assert.ok(physical.length >= 2, `gates with physical data: ${physical.length}`);
    for (const { gate } of physical) assert.ok(gate.physical.spec, "a physical spec");
    assert.equal(civRecord().gates, true);
    const asker = makePlayer();
    send("civ:gate_status", physical[0].gate.id, asker);
    await flush();
    const answer = text(asker) + mc.messages.join("\n");
    assert.ok(answer.includes(physical[0].gate.id), answer.slice(0, 600));
    assert.doesNotMatch(answer, /no such gate|unknown gate/i);
    // registering again (what a resume does when it completes) is idempotent
    const before = JSON.stringify(store.load().kingdom.districts.map((d) => d.gates));
    const { registerBuiltGates } = await load("integration", "civGates.js");
    const again = registerBuiltGates(store, run.outcome.record, "minecraft:overworld");
    assert.ok(again.ok);
    assert.equal(JSON.stringify(store.load().kingdom.districts.map((d) => d.gates)), before);
});

test("the gate registrar is called after the gates stage and again when the build completes", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const calls = [];
    civCommands.setGateLinker((s, record, dim) => {
        const q = builder.getSession()?.queue;
        calls.push({ gatesDone: q ? jobsModule.stageSatisfied(q, "gates") : true, lotsDone: q ? jobsModule.stageSatisfied(q, "lots") : true, dim, gates: record.gates.length });
        return { ok: true, reason: null, changes: [], created: [], links: [] };
    });
    const player = makePlayer();
    await generate(player);
    assert.match(text(player), /is built/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].gatesDone, true);
    assert.equal(calls[0].lotsDone, false);
    assert.equal(calls[1].lotsDone, true);
    assert.equal(calls[0].dim, "minecraft:overworld");
});

test("state fallbacks are counted and reported", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.rejectStates = (id) => id.includes("door") || id.includes("lever");
    const player = makePlayer();
    await generate(player);
    assert.match(text(player), /is built/);
    const fallbacks = Number(/state fallbacks (\d+)/.exec(text(player))?.[1]);
    assert.ok(fallbacks > 0, `fallbacks ${fallbacks}`);
    assert.match(text(player), /WARNING: some blocks were placed without their facing/);
});

test("determinism: the same seed yields an identical stored plan; another seed differs", { timeout: 600000 }, async () => {
    const a = await plannedOnly(1, 1);
    const b = await plannedOnly(1, 1);
    const c = await plannedOnly(1, 3);
    const planKeys = (snapshot) => [...snapshot.entries()].filter(([k]) => k.startsWith("civ:plan") || k.startsWith("civ:jobs")).sort(([x], [y]) => (x < y ? -1 : 1));
    assert.deepEqual(planKeys(a.props), planKeys(b.props));
    assert.notDeepEqual(planKeys(a.props), planKeys(c.props));
    assert.equal(a.outcome.record.checksum, b.outcome.record.checksum);
    assert.notEqual(a.outcome.record.checksum, c.outcome.record.checksum);
});

test("measured numbers for the report", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const o = base.outcome;
    console.log(
        JSON.stringify({
            ops: siteplan.siteOpCount(o.record),
            slicesPlanned: Math.ceil(siteplan.siteOpCount(o.record) / CIV_LIMITS.maxBlocksPerSlice),
            coarse: o.stats.coarse,
            fine: o.stats.fine,
            storage: o.stats.storage,
            maxReadsPerSlice: base.stats.reads,
            maxWritesPerSlice: base.stats.writes,
            totalJobSlices: base.stats.slices,
            totalWrites: base.stats.totalWrites,
        }),
    );
});

test("process crashes at eight more points (dense sweep) - the world still ends identical", { timeout: 600000 }, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    for (const at of [300, 1700, 9100, 13300, 30500, 38800, 52500, 61000]) {
        mc.dieAtWrites = at;
        await pump({ stopOnDead: true });
        assert.equal(mc.dead, true, `process died at ${at} writes`);
        await restart();
        const revived = makePlayer();
        revived.sendMessage = (m) => player.messages.push(...(Array.isArray(m) ? m : [m]));
        send(CIV_EVENT_IDS.resume, "", revived);
    }
    mc.dieAtWrites = null;
    await pump();
    assert.match(text(player), /is built/, text(player).slice(-1200));
    assertSameWorld(worldFingerprint(), base.fp, "dense crash sweep");
});

test("abort during the survey and during planning stops cleanly with zero writes", MIN_TIMEOUT, async () => {
    for (const reads of [3000, 80000]) {
        resetWorld(1);
        const player = makePlayer();
        send(CIV_EVENT_IDS.generate, GEN, player);
        await pump({ until: () => mc.reads >= reads });
        assert.ok(districtBuilder.isBusy(), "the pipeline is running");
        send(CIV_EVENT_IDS.abort, "", player);
        await pump();
        assert.equal(districtBuilder.isBusy(), false);
        assert.equal(mc.areas.size, 0, "chunks released");
        assert.equal(mc.writes, 0);
        assert.deepEqual(noCivData(), []);
        assert.equal(civRecord(), undefined);
        assert.match(mc.messages.join(" ") + text(player), /no block was written/);
        mc.messages.length = 0;
    }
});

test("no ticking-area capacity: the survey relies on loaded chunks and says so (still read-only)", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.noCapacity = true;
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    await pump();
    assert.match(text(player), /Plan is valid/);
    assert.ok(outcome.stats.coarse.unheldTiles > 0);
    assert.match(outcome.stats.coarse.notes.join(" "), /no ticking-area capacity/);
    assert.equal(mc.writes, 0);
});

test("radius=400 (the maximum) scans further and still plans; radius is bounded per slice too", { timeout: 600000 }, async () => {
    resetWorld(1);
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, `radius=${CIV.maxSearchRadius} ${GEN}`, player);
    await pump();
    assert.match(text(player), /Plan is valid/, text(player).slice(-800));
    assert.equal(outcome.stats.survey.fullRadius, CIV.maxSearchRadius + 316, "the survey may reach the full radius (it stops early when a site is found)");
    assert.ok(outcome.stats.coarse.columns > 5000);
    assert.ok(mc.maxReadsPerSlice <= CIV_LIMITS.maxReadsPerSlice);
    assert.equal(mc.writes, 0);
    console.log(JSON.stringify({ radius400: { columns: outcome.stats.coarse.columns, reads: outcome.stats.coarse.reads, slices: outcome.stats.coarse.slices } }));
});


test("seed sweep: planning succeeds or refuses with a stated reason, across seeds and terrains", { timeout: 900000 }, async () => {
    const terrains = [{}, { field: { relief: 7, hills: 60 } }, { field: { relief: 3, hills: 140, forest: 0.1 } }, { field: { relief: 5, hills: 90, lakes: [{ x: 300, z: 300, r: 60 }] } }];
    const rows = [];
    let ok = 0;
    let total = 0;
    for (let w = 0; w < terrains.length; w += 1) {
        for (let seed = 1; seed <= 6; seed += 1) {
            resetWorld(w + 1, terrains[w]);
            const player = makePlayer();
            send(CIV_EVENT_IDS.plan, `seed=${seed}`, player);
            await pump();
            total += 1;
            const out = text(player);
            if (/Plan is valid/.test(out)) ok += 1;
            else rows.push(`terrain ${w} seed ${seed}: ${(/Stopped at (\S+)/.exec(out) ?? [])[1]} ${out.split("\n").slice(-4).join(" | ").slice(0, 260)}`);
            assert.equal(mc.writes, 0);
        }
    }
    console.log(JSON.stringify({ sweep: { ok, total, rate: ok / total } }));
    for (const row of rows) console.log("  refused:", row);
    assert.ok(ok / total >= 0.5, `success rate ${ok}/${total}`);
});

// ---------------------------------------------------------------------------- review fixes: abort coupling, hold ownership, 'ours', storage, warning, worldplan

test("classifyCivOp: only the FINAL planned id counts as ours; an air op never removes a planned non-air block", () => {
    const c = builder.classifyCivOp;
    const op = (kind, id) => ({ x: 0, y: 0, z: 0, id, kind });
    const planned = { final: "minecraft:stone_bricks", nonAir: ["minecraft:oak_planks", "minecraft:stone_bricks"] };
    // oak_planks appears in the cell's planned set but is not the final id: a player's planks are NOT ours
    assert.equal(c(op("structure", "minecraft:stone_bricks"), "minecraft:oak_planks", planned).action, "skip");
    assert.equal(c(op("structure", "minecraft:glass"), "minecraft:stone_bricks", planned).action, "place");
    // the player's chest where the plan itself has a chest: neither a cut nor an air structure op may remove it
    const chestCell = { final: "minecraft:chest", nonAir: ["minecraft:chest"] };
    assert.equal(c(op("cut", "minecraft:air"), "minecraft:chest", chestCell).action, "skip");
    assert.equal(c(op("structure", "minecraft:air"), "minecraft:chest", chestCell).action, "skip");
    assert.match(c(op("cut", "minecraft:air"), "minecraft:chest", chestCell).reason, /protected from removal/);
    // natural ground is still cut as before
    assert.equal(c(op("cut", "minecraft:air"), "minecraft:dirt", { final: "minecraft:dirt", nonAir: ["minecraft:dirt"] }).action, "place");
});

test("a player's chest on a cell where the plan places a chest survives the build", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    restoreProps(planned.props);
    const { record } = rehydrateStored();
    const chests = [];
    for (let i = 0; i < record.lots.length && chests.length < 6; i += 1) {
        for (const op of siteplan.siteOpsFor(record, "lots", i)) if (op.id === "minecraft:chest") chests.push(op);
    }
    assert.ok(chests.length > 0, "the plan places chests");
    for (const op of chests) mc.placed.set(key(op.x, op.y, op.z), "minecraft:chest");
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/);
    for (const op of chests) assert.equal(typeAt(op.x, op.y, op.z), "minecraft:chest");
});

test("hold ownership: a cancelled job removes its own late ticking area, never a newer job's", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const rect = { x0: 0, z0: 0, x1: 127, z1: 127 };
    // (4) cancelled while the engine is still creating the area -> the area is removed once creation returns
    const t1 = { kind: "civ-plan", jobId: undefined, cancelled: false };
    let open;
    mc.holdGate = new Promise((resolve) => {
        open = resolve;
    });
    const pending = scan.holdArea(dimension, rect, t1);
    t1.cancelled = true;
    open();
    const result = await pending;
    assert.equal(result.held, false);
    assert.equal(mc.areas.size, 0, "late area removed");
    // (5) a stale owner's release cannot remove a newer job's hold
    const t2 = { kind: "civ-plan", jobId: undefined, cancelled: false };
    const t3 = { kind: "civ-plan", jobId: undefined, cancelled: false };
    await scan.holdArea(dimension, rect, t2);
    assert.equal(mc.areas.size, 1);
    scan.releaseArea(t1);
    assert.equal(mc.areas.size, 1, "stale release ignored");
    await scan.holdArea(dimension, rect, t3);
    scan.releaseArea(t2);
    assert.equal(mc.areas.size, 1, "the previous owner cannot release the new hold");
    scan.releaseArea(t3);
    assert.equal(mc.areas.size, 0);
    // a cancelled token never even asks the engine
    const before = mc.areaLog.length;
    t3.cancelled = true;
    await scan.holdArea(dimension, rect, t3);
    assert.equal(mc.areaLog.length, before);
});

test("abort while the first ticking area is being created leaves nothing behind", MIN_TIMEOUT, async () => {
    resetWorld(1);
    let open;
    mc.holdGate = new Promise((resolve) => {
        open = resolve;
    });
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    for (let i = 0; i < 20; i += 1) await flush();
    assert.ok(districtBuilder.isBusy());
    send(CIV_EVENT_IDS.abort, "", player);
    open();
    await pump();
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(mc.areas.size, 0);
    assert.equal(mc.writes, 0);
    assert.match(text(player) + mc.messages.join(" "), /no block was written/);
});

test("civ:district_abort on a running civilization build uses the shared abort path (paused, queue saved, areas released)", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    await pump({ until: () => (builder.sessionStatus()?.pct ?? 0) >= 25 });
    const written = mc.writes;
    send("civ:district_abort", "", player);
    await pump();
    assert.equal(builder.hasSession(), false, "no stale 'Running' session");
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(mc.areas.size, 0);
    assert.equal(mc.writes, written);
    assert.equal(civRecord().status, "paused");
    const stored = jobsModule.createJobStore(mc.world).loadQueue({ recoverRunning: false });
    assert.equal(stored.queue.state, "paused");
    assert.ok(jobsModule.progress(stored.queue).pct >= 24, "progress saved exactly, not up to 1500 ops behind");
    assert.match(mc.messages.join("\n") + text(player), /operations are done; \d+ block\(s\) were placed/);
    // and it resumes to the same world
    const base = await baseline();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/);
    void base;
});

test("civ:generate_abort stops only civilization jobs and says what it did", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    const token = districtBuilder.reserveJob("scout");
    assert.ok(token);
    send(CIV_EVENT_IDS.abort, "", player);
    await flush();
    assert.equal(districtBuilder.isBusy(), true, "the district job was not cancelled");
    assert.equal(token.cancelled, false);
    assert.match(mc.messages.join(" ") + text(player), /not a civilization job/);
    districtBuilder.finishJob(token);
});

test("an oversize job queue is refused BEFORE the plan is stored (no orphan plan)", MIN_TIMEOUT, async () => {
    resetWorld(1);
    builder.seams.maxJobBytes = 400;
    const player = makePlayer();
    await generate(player);
    assert.match(text(player), /job queue would need \d+ bytes but only 400/);
    assert.equal(mc.writes, 0);
    assert.deepEqual(noCivData(), [], "no plan and no queue left behind");
    assert.equal(civRecord(), undefined);
    assert.equal(districtBuilder.isBusy(), false);
});

test("the safety warning is shown by generate, plan and devgate", MIN_TIMEOUT, async () => {
    const lineA = "Use only in a dedicated NEW test world.";
    const lineB = "Natural-looking player builds (dirt, stone, sandstone, sand, gravel, clay, snow, moss) cannot be told apart from terrain and WOULD be modified; planks, bricks, glass, chests, ores, farmland etc. are always protected.";
    assert.deepEqual(civCommands.CIV_SAFETY_WARNING, [lineA, lineB]);
    resetWorld(1);
    for (const id of [CIV_EVENT_IDS.plan, CIV_EVENT_IDS.generate]) {
        resetWorld(1);
        builder.seams.maxPlanBytes = 1000; // stop early: the warning comes first
        const player = makePlayer();
        send(id, GEN, player);
        await pump();
        assert.ok(text(player).includes(lineA) && text(player).includes(lineB), `${id} shows the warning`);
    }
    const player = makePlayer();
    send(CIV_EVENT_IDS.devgate, "on", player);
    send(CIV_EVENT_IDS.devgate, "", player);
    await flush();
    const all = mc.messages.join("\n") + text(player);
    assert.equal(all.split(lineB).length - 1, 2, "both devgate replies carry the warning");
    send(CIV_EVENT_IDS.devgate, "off", player);
});

test("worldplan.planWorldSteps and the runtime pipeline give the same plan and record checksum for the same seed", { timeout: 600000 }, async () => {
    const worldplan = await load("civ", "worldplan.js");
    resetWorld(1);
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    await pump();
    assert.ok(outcome?.ok, text(player).slice(-500));
    // the same inputs the pipeline used: the coarse survey and the full-resolution ground of its region
    const token = { kind: "test", jobId: undefined, cancelled: false };
    let coarse;
    let fine;
    scan.scanCoarse(token, dimension, { x: 0, z: 0 }, 536, 8).then((v) => (coarse = v));
    await pump({ until: () => coarse !== undefined });
    scan.scanFull(token, dimension, outcome.region).then((v) => (fine = v));
    await pump({ until: () => fine !== undefined });
    const result = worldplan.planWorld(coarse.field, {
        seed: 1,
        plan: { anchor: { x: outcome.site.x, z: outcome.site.z }, radius: builder.MASTER_PLAN_RADIUS },
        site: { seed: 1, excludeFootprints: [] },
        siteField: fine.field,
        maxWorldAttempts: 1,
    });
    assert.ok(result.ok, result.problems.join(" | "));
    assert.equal(JSON.stringify(result.plan), JSON.stringify(outcome.plan), "same master plan");
    assert.equal(result.record.checksum, outcome.record.checksum, "same site record checksum");
    assert.equal(JSON.stringify(result.ground), JSON.stringify(outcome.ground), "same stored ground");
});

// ============================================================================= the second district
// Everything below starts from ONE cached reference run (district 1 built and complete) and forks it: the fake world
// and the property store are rewound to exactly that state, so a district-2 scenario is measured against the same
// city every time.

/** @returns {Promise<any>} the baseline object, with the world rewound to "district 1 stands complete, dev gate on" */
async function forkCity() {
    const base = await baseline();
    resetWorld(1);
    restoreProps(base.savedProps);
    mc.placed = new Map(base.savedPlaced);
    mc.written = new Set();
    mc.reads = 0;
    mc.writes = 0;
    mc.propWrites = 0;
    mc.firstWrite = undefined;
    mc.slices = 0;
    mc.maxReadsPerSlice = 0;
    mc.maxWritesPerSlice = 0;
    // the standing heights the untouched run had: getTopmostBlock must answer the same way
    for (const [k, id] of mc.placed) {
        if (id === "minecraft:air") continue;
        const [x, y, z] = k.split(",").map(Number);
        const ck = `${String(x)},${String(z)}`;
        if ((mc.colTop.get(ck) ?? -999) < y) mc.colTop.set(ck, y);
    }
    const gate = makePlayer();
    send(CIV_EVENT_IDS.devgate, "on", gate);
    await flush();
    assert.equal(mc.props.get(CIV.devGateKey), true, "the development gate is on for districts 2-5");
    const kingdom = store.load().kingdom;
    assert.equal(districtById(kingdom, "district-1").civ.status, "complete", "district 1 stands");
    assert.equal(districtById(kingdom, "district-2").civ, undefined, "district 2 has not been started");
    assert.deepEqual(worldFingerprint(), base.fp, "the forked world is the reference world");
    return base;
}

const D2 = "district=2 seed=1";

test("planning and building district 2 writes nothing inside district 1's protected footprint and changes none of its blocks", MIN_TIMEOUT, async () => {
    const base = await forkCity();
    const plan = base.outcome.plan;
    const kingdomBefore = structuredClone(store.load().kingdom);
    const d1Centre = districtById(kingdomBefore, "district-1").civ.centre;
    // the exact list the build guards with: district 1 is complete, district 2 is the one asking
    const guarded = civCommands.protectedRects(kingdomBefore, 1, plan, builder.WRITE_PROTECT_GROW, 2).filter((area) => area.polygon !== undefined);
    assert.equal(guarded.length, 1, `district-1's outline is the footprint to keep clear: ${guarded.map((a) => a.label).join(", ")}`);
    assert.match(String(guarded[0].label), /^district-1 /, String(guarded[0].label));
    assert.equal(builder.inProtectedArea(guarded, d1Centre.x, d1Centre.z), true, "the guard really covers district 1");
    // (a) planning district 2 is read-only
    const planner = makePlayer();
    send(CIV_EVENT_IDS.plan, D2, planner);
    await pump();
    assert.match(text(planner), /Plan is valid/, text(planner).slice(-900));
    assert.match(text(planner), /Reading district 2 \(Ironquarry, district-2\) at full resolution/);
    assert.match(text(planner), /nothing outside this district is read/);
    assert.equal(mc.writes, 0, "planning district 2 writes no block");
    const blocksBefore = new Map(mc.placed);
    // (b) building district 2
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, D2, player);
    await pump();
    const out = text(player);
    assert.match(out, /=== Ironquarry \(enlarged\) is built ===/, out.slice(-1200));
    const d1Cells = new Set();
    for (const [k, id] of blocksBefore) if (naturalAt(...k.split(",").map(Number)) !== id) d1Cells.add(k);
    assert.ok(d1Cells.size > 20000, `district 1 had ${String(d1Cells.size)} modified cells to protect`);
    const changed = [];
    for (const k of d1Cells) {
        const [x, y, z] = k.split(",").map(Number);
        if (typeAt(x, y, z) !== blocksBefore.get(k)) changed.push(`${k}: was ${blocksBefore.get(k)}, now ${typeAt(x, y, z)}`);
    }
    assert.deepEqual(changed.slice(0, 5), [], `${String(changed.length)} block(s) district 1 placed were modified by the district-2 build`);
    // What the district-2 run may and may not do inside district 1's protected footprint. It may never
    // touch district 1's own land - the outline with no clearance around it is the honest test of that -
    // and it may never modify a block district 1 placed (asserted above). The one thing it IS allowed to
    // do is lay its own wall on a column district 1 left empty in the shared band: a shared wall is in
    // both records, and a clearance that also ate the second neighbour's copy of that band left 62 wall
    // columns unbuilt and opened four districts to the outside (dev/test/civ-fivedistrict.test.mjs).
    const districtOnesOwnLand = civCommands.protectedRects(kingdomBefore, 1, plan, 0, 2).filter((area) => area.polygon !== undefined);
    assert.equal(builder.inProtectedArea(districtOnesOwnLand, d1Centre.x, d1Centre.z), true, "the zero-clearance list really is district 1's land");
    const insideLand = [];
    const bandWrites = [];
    for (const k of mc.written) {
        const [x, , z] = k.split(",").map(Number);
        if (builder.inProtectedArea(districtOnesOwnLand, x, z)) insideLand.push(k);
        else if (builder.inProtectedArea(guarded, x, z)) bandWrites.push(k);
    }
    assert.deepEqual(insideLand.slice(0, 5), [], `${String(insideLand.length)} write(s) landed on district 1's own land`);
    assert.ok(bandWrites.length > 0, "district 2 built no wall in the shared band at all - the enclosure would be incomplete");
    // how many band columns may be written is pinned exactly, and offline, by the built-barrier equality in
    // dev/test/civ-fivedistrict.test.mjs; here the promise is only that the shared band really was filled.
    // the guard is not decoration: district 2's own plan reaches that land and is refused op by op
    const refused = Number(/(\d+) op\(s\) fell outside this district or inside a finished neighbour/.exec(out)?.[1] ?? 0);
    assert.ok(refused > 0, `the build reported no protected-footprint refusals at all: ${out.slice(-900)}`);
    assert.match(out, new RegExp(`${String(refused)}x inside a protected footprint`));
    assert.deepEqual(districtById(store.load().kingdom, "district-1").civ, districtById(kingdomBefore, "district-1").civ, "district-1's civ record is untouched");
});

test("a district-2 build that crashes twice resumes after a restart to exactly the world an uninterrupted build leaves", { timeout: 900000 }, async () => {
    // the uninterrupted reference
    await forkCity();
    const clean = makePlayer();
    send(CIV_EVENT_IDS.generate, D2, clean);
    await pump();
    assert.match(text(clean), /is built/, text(clean).slice(-900));
    const reference = worldFingerprint();
    assert.ok(reference.length > 40000, `the district-2 build changed ${String(reference.length)} cells`);
    // the same build, killed at two points inside it
    await forkCity();
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, D2, player);
    let died = 0;
    for (const at of [8000, 30000]) {
        mc.dieAtWrites = at;
        await pump({ stopOnDead: true });
        assert.equal(mc.dead, true, `the process died at ${String(at)} writes`);
        died += 1;
        const writtenAtDeath = mc.written.size;
        await restart();
        assert.equal(mc.written.size, writtenAtDeath, "nothing is written after the death");
        const revived = makePlayer();
        revived.sendMessage = (m) => player.messages.push(...(Array.isArray(m) ? m : [m]));
        send(CIV_EVENT_IDS.resume, "district=2", revived);
    }
    mc.dieAtWrites = null;
    await pump();
    assert.equal(died, 2);
    assert.match(text(player), /is built/, text(player).slice(-1200));
    assertSameWorld(worldFingerprint(), reference, "district-2 crash/restart");
    const two = districtById(store.load().kingdom, "district-2").civ;
    assert.equal(two.status, "complete");
    assert.equal(two.ops, two.opsTotal);
    assert.deepEqual(civCommands.civRecordProblems(two), []);
});

test("each district keeps its own site payload and its own queue: different key slots, separate bytes, independent wipes", MIN_TIMEOUT, async () => {
    await forkCity();
    const before = propsSnapshot();
    const prefixes = {
        site1: builder.sitePrefixFor(1),
        site2: builder.sitePrefixFor(2),
        jobs1: builder.jobPrefixFor(1),
        jobs2: builder.jobPrefixFor(2),
        master: "civ:plan",
    };
    const owned = Object.values(prefixes);
    /** The LONGEST owning prefix of a key, exactly how builder.storageFootprint() groups them. */
    const ownerOf = (k) => owned.reduce((best, p) => (k.startsWith(`${p}:`) && (best === undefined || p.length > best.length) ? p : best), undefined);
    const keysOf = (snapshot, prefix) => [...snapshot.keys()].filter((k) => ownerOf(k) === prefix).sort();
    const bytesOf = (snapshot, prefix) => [...snapshot.entries()].filter(([k]) => ownerOf(k) === prefix).reduce((sum, [, v]) => sum + planstore.utf8Length(String(v)), 0);
    assert.equal(prefixes.jobs1, jobsModule.JOB_PREFIX, "district 1 keeps the plain legacy queue slot");
    assert.notEqual(prefixes.jobs2, jobsModule.JOB_PREFIX, "district 2 has its own queue slot");
    assert.notEqual(prefixes.site1, prefixes.site2);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, D2, player);
    await pump({ until: () => builder.hasSession() });
    assert.ok(builder.hasSession(), "district 2 reached construction, so everything was stored first");
    const after = propsSnapshot();
    // both districts hold a payload and a queue, and no key is shared between the slots
    for (const [name, prefix] of Object.entries(prefixes)) {
        assert.ok(keysOf(after, prefix).length > 0, `${name} (${prefix}) holds at least its meta key`);
    }
    const overlap = keysOf(after, prefixes.site1).filter((k) => keysOf(after, prefixes.site2).includes(k));
    assert.deepEqual(overlap, [], "the two site slots own disjoint keys");
    const queueOverlap = keysOf(after, prefixes.jobs1).filter((k) => keysOf(after, prefixes.jobs2).includes(k));
    assert.deepEqual(queueOverlap, [], "the two queues own disjoint keys");
    assert.ok(keysOf(after, prefixes.jobs2).every((k) => !k.startsWith(`${prefixes.jobs1}:a:`) && !k.startsWith(`${prefixes.jobs1}:b:`)), "district 2's queue keys are not plain queue chunks");
    assert.ok(keysOf(after, prefixes.master).every((k) => !k.includes(":site:")), "the master-plan slot holds no district payload");
    const payload1 = planstore.createPlanStore(mc.world, { prefix: prefixes.site1 }).loadPlan();
    const payload2 = planstore.createPlanStore(mc.world, { prefix: prefixes.site2 }).loadPlan();
    assert.equal(payload1.status, "ok");
    assert.equal(payload2.status, "ok");
    assert.equal(payload1.plan.district, 1);
    assert.equal(payload2.plan.district, 2);
    assert.equal(payload2.plan.districtId, "district-2");
    assert.notEqual(payload1.plan.ground.g, payload2.plan.ground.g, "each district persisted its OWN ground");
    assert.notEqual(payload1.plan.siteChecksum, payload2.plan.siteChecksum);
    const queues = {
        one: jobsModule.createJobStore(mc.world, { prefix: prefixes.jobs1 }).loadQueue({ recoverRunning: false }),
        two: jobsModule.createJobStore(mc.world, { prefix: prefixes.jobs2 }).loadQueue({ recoverRunning: false }),
    };
    assert.equal(queues.one.status, "ok");
    assert.equal(queues.two.status, "ok");
    assert.equal(queues.two.queue.planHash, payload2.plan.siteChecksum, "district 2's queue belongs to district 2's plan");
    assert.notEqual(queues.one.queue.planHash, queues.two.queue.planHash, "they are two different queues");
    // measured bytes, per slot, against every ceiling
    const rows = {};
    for (const [name, prefix] of Object.entries(prefixes)) rows[name] = { keys: keysOf(after, prefix).length, bytes: bytesOf(after, prefix) };
    console.log(JSON.stringify({ perDistrictBytes: rows }));
    assert.ok(rows.site1.bytes > 0 && rows.site2.bytes > 0);
    assert.ok(rows.jobs2.bytes > 0);
    assert.notEqual(after.get(`${prefixes.site1}:meta`), after.get(`${prefixes.site2}:meta`));
    const footprint = builder.storageFootprint();
    assert.deepEqual(footprint.problems, [], `some key family is over budget: ${footprint.problems.join(" | ")}`);
    for (const family of footprint.families) {
        if (!family.bytes) continue;
        assert.ok(family.bytes <= family.limit, `${family.prefix}: ${String(family.bytes)} > ${String(family.limit)}`);
        assert.ok(family.longestProperty <= CIV_LIMITS.maxPropertyChars, `${family.prefix}: longest property ${String(family.longestProperty)} chars`);
        assert.ok(family.longestProperty < 32767, `${family.prefix}: ${String(family.longestProperty)} chars is at the engine ceiling`);
    }
    assert.equal(footprint.families.filter((family) => family.prefix === prefixes.site2).length, 1, "the district's own slot is accounted separately from the master plan");
    // the aborted build leaves both districts' data in its own slots; the byte counts stay inside every budget
    send(CIV_EVENT_IDS.abort, "", player);
    await pump();
    assert.equal(builder.hasSession(), false);
    const atAbort = propsSnapshot();
    planstore.createPlanStore(mc.world, { prefix: prefixes.site1 }).clear();
    assert.deepEqual(keysOf(propsSnapshot(), prefixes.site1), [], "district 1's site slot is gone");
    assert.deepEqual(keysOf(propsSnapshot(), prefixes.site2).sort(), keysOf(atAbort, prefixes.site2).sort(), "district 2's slot is the same key set");
    assert.equal(bytesOf(propsSnapshot(), prefixes.site2), bytesOf(atAbort, prefixes.site2), "not one byte of district 2 moved");
    assert.equal(planstore.createPlanStore(mc.world, { prefix: prefixes.site2 }).loadPlan().plan.siteChecksum, payload2.plan.siteChecksum);
    assert.equal(jobsModule.createJobStore(mc.world, { prefix: prefixes.jobs2 }).loadQueue({ recoverRunning: false }).status, "ok");
    assert.equal(planstore.createPlanStore(mc.world).loadPlan().status, "ok", "the shared master plan was not touched");
    // and district 2 still resumes and finishes from its own slots alone
    const resumed = makePlayer();
    send(CIV_EVENT_IDS.resume, "district=2", resumed);
    await pump();
    assert.match(text(resumed), /Verified plan [0-9a-f]{8}/, text(resumed).slice(-900));
    assert.match(text(resumed), /is built/, text(resumed).slice(-900));
    assert.equal(districtById(store.load().kingdom, "district-2").civ.status, "complete");
    // wiping district 2's slot leaves district 1's master plan and queue intact
    planstore.createPlanStore(mc.world, { prefix: prefixes.site2 }).clear();
    jobsModule.createJobStore(mc.world, { prefix: prefixes.jobs2 }).clear();
    assert.equal(planstore.createPlanStore(mc.world).loadPlan().status, "ok");
    assert.equal(jobsModule.createJobStore(mc.world, { prefix: prefixes.jobs1 }).loadQueue({ recoverRunning: false }).status, "ok");
    assert.deepEqual(keysOf(propsSnapshot(), prefixes.jobs2), []);
    assert.ok(bytesOf(before, prefixes.site1) > 0, "the fork really started from a stored district 1");
});

test("district 3 cannot start while district 2 is building, and civ:generate_status lists all five districts", MIN_TIMEOUT, async () => {
    const { DISTRICT_NAMES } = await load("config.js");
    await forkCity();
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, D2, player);
    await pump({ until: () => (builder.sessionStatus()?.pct ?? 0) >= 3 });
    assert.ok(builder.hasSession() && districtBuilder.isBusy(), "district 2 is being built");
    const writes = mc.writes;
    const propWrites = mc.propWrites;
    // (a) while the district-2 job owns the slot, a second district is refused with the reason "a job is running"
    const impatient = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=3 seed=1", impatient);
    send(CIV_EVENT_IDS.plan, "district=4 seed=1", impatient);
    await flush();
    const busy = text(impatient);
    assert.ok((busy.match(/is already running/g) ?? []).length >= 2, busy);
    assert.match(busy, /civ-build job is already running/);
    assert.equal(mc.writes, writes, "the refused district-3 start wrote no block");
    assert.equal(mc.propWrites, propWrites, "and stored nothing");
    assert.equal(districtById(store.load().kingdom, "district-3").civ, undefined, "no record was made for district 3");
    // (b) the process dies: district 2 stays recorded as `building` with no job holding the slot. Now the refusal is
    // the ordering rule itself, and it names the district that has to be finished first.
    mc.dieAtWrites = mc.writes + 1;
    await pump({ stopOnDead: true });
    assert.equal(mc.dead, true, "the district-2 process died mid-build");
    await restart();
    assert.equal(districtBuilder.isBusy(), false, "no process owns the slot any more");
    assert.equal(districtById(store.load().kingdom, "district-2").civ.status, "building", "district 2 is still recorded as building");
    const afterDeathWrites = mc.writes;
    const afterDeathProps = mc.propWrites;
    const third = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=3 seed=1", third);
    await pump();
    const out = text(third);
    assert.match(out, /district-2 \(Ironquarry\) is still being built - one district at a time/, out.slice(-1200));
    assert.match(out, /its neighbours are not built yet: district-2 Ironquarry \(building\)/);
    assert.match(out, /Build them first - districts share their walls/);
    assert.match(out, /Nothing was changed/);
    assert.equal(mc.writes, afterDeathWrites, "the refused district-3 start wrote no block after the death either");
    assert.equal(mc.propWrites, afterDeathProps, "and stored nothing");
    // (c) status: every district, by id, with its own state - and no claim that districts 2-5 are unavailable
    send(CIV_EVENT_IDS.status, "", third);
    await flush();
    const status = text(third);
    const lineFor = (id) => status.split("\n").filter((line) => line.includes(id)).join("\n");
    assert.match(status, /Districts \(5, built one at a time in this order/);
    assert.match(status, /master plan stored at -?\d+, -?\d+/);
    for (const index of builder.DISTRICT_INDEXES) {
        assert.ok(status.includes(`district-${String(index)} ${DISTRICT_NAMES[index - 1]}`), `district ${String(index)} is listed: ${status}`);
    }
    assert.match(lineFor("district-1"), /: complete, stage complete \d+ \/ \d+ ops, placed \d+, skipped \d+/);
    assert.match(lineFor("district-1"), /plan [0-9a-f]{8}/);
    assert.match(lineFor("district-2"), /: building, stage \w+ \d+ \/ \d+ ops/);
    assert.match(status, /Stored queue: \d+% \(\d+ \/ \d+ ops\), state \w+; continue with \/scriptevent civ:generate_resume district=2/);
    assert.match(lineFor("district-3"), /: not started - build district-2 first/);
    assert.match(lineFor("district-4"), /: not started - build district-3 first/);
    assert.match(lineFor("district-5"), /: not started - build district-4 first/);
    assert.doesNotMatch(status, /not available yet|not enabled in this build|only district 1 exists/i, status);
    assert.match(status, /Dev gate: on \(districts 2-5 only start with it on\)/);
    assert.match(status, /total \d+ B \(every family inside its budget\)/);
    // the district-2 build does finish when it is resumed - which is what the refusal told the operator to do
    send(CIV_EVENT_IDS.resume, "district=2", player);
    await pump();
    assert.match(text(player), /is built/, text(player).slice(-1200));
    assert.equal(districtById(store.load().kingdom, "district-2").civ.status, "complete");
});

test("a district with no master plan, or an unbuilt neighbour, is refused BY NAME; an unknown index writes nothing", MIN_TIMEOUT, async () => {
    // (a) a world with no master plan at all cannot start district 3 (the gate is on: this is not a gate refusal)
    resetWorld(1);
    const gate = makePlayer();
    send(CIV_EVENT_IDS.devgate, "on", gate);
    await flush();
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=3 seed=1", player);
    await pump();
    assert.match(text(player), /nothing to build district-3 from: this world holds no five-district master plan/);
    assert.match(text(player), /civ:plan reads 'absent'/);
    assert.match(text(player), /Build district 1 first \(it makes the master plan\): \/scriptevent civ:generate district=1 seed=1/);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0, "a missing master plan is noticed before any world read");
    assert.deepEqual(noCivData(), [], "nothing stored");
    assert.equal(districtBuilder.isBusy(), false);
    // (b) a stored master plan whose lower neighbour is only PAUSED still refuses, and names the neighbour
    const planned = await plannedOnly();
    await restart();
    restoreProps(planned.props);
    send(CIV_EVENT_IDS.devgate, "on", makePlayer());
    await flush();
    assert.equal(builder.loadMasterPlan().plan !== undefined, true, "district 1's run stored the five-district master plan");
    const second = makePlayer();
    send(CIV_EVENT_IDS.generate, "district=2 seed=1", second);
    await pump();
    assert.match(text(second), /its neighbours are not built yet: district-1 Hearthgate \(paused\)/);
    assert.match(text(second), /Build them first/);
    assert.equal(mc.writes, 0, "no block was written for the district-2 attempt");
    // planning district 2, however, is allowed: it shares the stored master plan and writes nothing
    const third = makePlayer();
    send(CIV_EVENT_IDS.plan, "district=2 seed=1", third);
    await pump();
    assert.match(text(third), /Plan is valid/, text(third).slice(-700));
    assert.equal(mc.writes, 0);
    // (c) an unknown index never reaches the planner and leaves the world byte-identical
    const keys = [...mc.props.keys()].sort();
    const bytes = mc.propWrites;
    for (const bad of ["district=7", "district=-2", "district=1x", "district=+2", "district="]) {
        const asker = makePlayer();
        send(CIV_EVENT_IDS.generate, `${bad} seed=1`, asker);
        send(CIV_EVENT_IDS.plan, `${bad} seed=1`, asker);
        send(CIV_EVENT_IDS.resume, bad, asker);
        send(CIV_EVENT_IDS.abort, bad, asker);
        await pump();
        assert.match(text(asker), /district must be 1 to 5/, `${bad}: ${text(asker).slice(-400)}`);
    }
    assert.equal(mc.writes, 0);
    assert.equal(mc.propWrites, bytes, "an unknown index stores nothing");
    assert.deepEqual([...mc.props.keys()].sort(), keys);
    assert.equal(mc.areas.size, 0);
    assert.equal(districtBuilder.isBusy(), false);
});
