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

test("argument parsing: radius bounds, seed, unknown arguments", () => {
    assert.deepEqual(civCommands.parseCivArgs([]), { radius: CIV.defaultSearchRadius, seed: undefined, districts: undefined, error: undefined });
    assert.equal(civCommands.parseCivArgs(["radius=300", "seed=-7"]).radius, 300);
    assert.equal(civCommands.parseCivArgs(["radius=300", "seed=-7"]).seed, -7);
    assert.match(civCommands.parseCivArgs([`radius=${CIV.maxSearchRadius + 1}`]).error, /radius must be/);
    assert.match(civCommands.parseCivArgs(["radius=abc"]).error, /radius must be/);
    assert.match(civCommands.parseCivArgs(["seed=1.5"]).error, /seed must be/);
    assert.match(civCommands.parseCivArgs(["bogus"]).error, /unrecognised/);
    assert.match(civCommands.parseCivArgs(["colour=red"]).error, /unknown argument/);
    assert.equal(civCommands.parseCivArgs(["districts=1,2"]).districts, "1,2");
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
    // water only for support kinds
    assert.equal(c(op("support"), "minecraft:water").action, "place");
    assert.equal(c(op("wall"), "minecraft:water").action, "skip");
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

test("failure: water everywhere -> no site, zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1, { field: { lakes: [{ x: 0, z: 0, r: 4000 }] } });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
});

test("failure: lava through the area -> no site, zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1, { lavaEvery: 40 });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
    assert.match(text(player), /lava/);
});

test("failure: terrain too steep -> no site, reasons listed, zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1, { field: { relief: 70, hills: 18 } });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
    assert.match(text(player), /steep|candidates/);
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

function rehydrateStored() {
    const payload = planstore.createPlanStore(mc.world).loadPlan().plan;
    const re = siteplan.rehydrateSite(payload.plan, 1, payload.ground, { ...payload.siteOptions, expectChecksum: payload.siteChecksum });
    assert.ok(re.ok, re.problems.join(";"));
    return { payload, record: re.record };
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

test("resume refuses on a checksum mismatch, a version mismatch, a corrupt ground and a foreign queue - without writing", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    async function refused(tamper, message) {
        await restart();
        restoreProps(planned.props);
        tamper();
        const player = makePlayer();
        send(CIV_EVENT_IDS.resume, "", player);
        await pump();
        assert.match(text(player), message, text(player));
        assert.equal(mc.writes, 0);
        assert.equal(districtBuilder.isBusy(), false);
    }
    const store2 = () => planstore.createPlanStore(mc.world);
    await refused(() => {
        const k = store.load().kingdom;
        districtById(k, "district-1").civ.checksum = "00000000";
        store.save(k);
    }, /not the one this district was started from/);
    await refused(() => {
        const payload = store2().loadPlan().plan;
        payload.site.version = 99;
        assert.ok(store2().savePlan(payload).ok);
    }, /site version 99/);
    await refused(() => {
        const payload = store2().loadPlan().plan;
        payload.ground.g = payload.ground.g.slice(0, -40) + "A".repeat(40);
        assert.ok(store2().savePlan(payload).ok);
    }, /unusable|could not be rebuilt/);
    await refused(() => {
        const queue = jobsModule.createQueue({ clear: [{ total: 10, hash: 1 }] }, { planHash: "zzzz" });
        assert.ok(jobsModule.createJobStore(mc.world).saveQueue(queue).ok);
    }, /does not belong to this plan/);
    await refused(() => {
        for (const k of [...mc.props.keys()]) if (k.startsWith("civ:plan")) mc.props.delete(k);
    }, /stored plan is absent/);
    await refused(() => {
        const k = store.load().kingdom;
        delete districtById(k, "district-1").civ;
        store.save(k);
    }, /no generated civilization to resume/);
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

test("the development gate: districts= is refused, and even with the gate on it says not enabled", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, "districts=1,2,3", player);
    await pump();
    assert.match(text(player), /districts 2-5 is not available yet/i);
    send(CIV_EVENT_IDS.devgate, "on", player);
    assert.equal(mc.props.get(CIV.devGateKey), true);
    const p2 = makePlayer();
    send(CIV_EVENT_IDS.generate, "districts=1,2,3", p2);
    await pump();
    assert.match(text(p2), /not enabled in this build/);
    send(CIV_EVENT_IDS.devgate, "off", player);
    assert.equal(mc.props.get(CIV.devGateKey), false);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0);
    assert.equal(mc.jobs.length, 0);
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
