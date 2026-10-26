// Survey / hold / progress behaviour of the one-command workflow (integration/civScan.js, civProgress.js, commands/civ.js)
// against the fake world of dev/lib/civharness.mjs with a TICK CLOCK: one job slice = one tick, idle time advances the
// clock, ticking areas can resolve after N ticks, never resolve, or reject. It reproduces the in-game hang (a
// createTickingArea that never resolves) and proves it now times out, retries, aborts with a clear message and
// releases everything. It cannot prove how long a real server takes to generate chunks.
import assert from "node:assert/strict";
import test from "node:test";
import {
    CIV, CIV_EVENT_IDS, advanceTick, builder, civCommands, civRecord, dimension, districtBuilder, flush, jobsModule, load, makePlayer, mc,
    pump, resetWorld, scan, send, text, writesAtImport,
} from "../lib/civharness.mjs";

void writesAtImport;
const T = { timeout: 600000 };
const GEN = "seed=1";
const DEFAULTS = { ...CIV };

function restoreConfig() {
    Object.assign(CIV, DEFAULTS);
}

function setup(seed = 1, worldOptions = {}) {
    restoreConfig();
    resetWorld(seed, worldOptions);
}

const noCivData = () => [...mc.props.keys()].filter((k) => k.startsWith("civ:plan") || k.startsWith("civ:jobs"));

function assertClean(label) {
    assert.equal(mc.writes, 0, `${label}: zero block writes`);
    assert.equal(districtBuilder.isBusy(), false, `${label}: the job slot is free`);
    assert.equal(mc.areas.size, 0, `${label}: no ticking area left`);
    assert.deepEqual(noCivData(), [], `${label}: nothing stored`);
    assert.equal(civRecord(), undefined, `${label}: no district.civ`);
}

const asked = (player, id, message = "") => {
    const before = player.messages.length;
    send(id, message, player);
    return player.messages.slice(before).join("\n");
};

async function planOnly(player, message = GEN) {
    send(CIV_EVENT_IDS.plan, message, player);
    await pump();
}

// ---------------------------------------------------------------------------- the reproduced hang

test("REPRODUCTION: a ticking area that never resolves no longer hangs - timeouts, retries, then a clear abort", T, async () => {
    setup();
    mc.createMode = () => "never";
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    // t = 40 ticks: running, the survey line was printed, nothing else yet
    await pump({ until: () => mc.tick >= 40 });
    let status = asked(player, CIV_EVENT_IDS.status);
    assert.match(status, /Active session:/);
    assert.match(status, /\(plan\): running, phase 1\/6 survey/);
    assert.match(status, /Job slot: civ-plan \(plan: phase 1\/6 survey/);
    assert.doesNotMatch(status, /STALLED\?/);
    // heartbeats come at the stated cadence even though nothing loads
    await pump({ until: () => mc.tick >= 700 });
    status = asked(player, CIV_EVENT_IDS.status);
    assert.match(status, /last progress \d+ s ago - STALLED\?/);
    const beats = text(player).match(/^ {2}\.\.\. survey \(phase 1\/6\)/gm) ?? [];
    assert.ok(beats.length >= 3 && beats.length <= 4, `heartbeats in 700 ticks: ${beats.length}`);
    // nothing ever moves: the stall monitor (CIV.stallTicks, hold timeouts do NOT reset it) cancels the run
    await pump();
    assert.ok(mc.tick >= CIV.stallTicks && mc.tick < CIV.stallTicks + 100, `cancelled at tick ${mc.tick}`);
    const out = text(player);
    assert.match(out, /Planning stalled - cancelled, nothing was changed/);
    assert.match(out, /No progress for 3 min 0 s \(phase 1\/6 survey/);
    assert.match(out, /Move to an area whose chunks are already generated or try a smaller radius=/);
    assertClean("never-resolving create");
    const after = asked(player, CIV_EVENT_IDS.status);
    assert.match(after, /Last run:/);
    assert.match(after, /\(plan\): stalled/);
    assert.match(after, /error: No progress for/);
    assert.match(after, /tile stalls [1-9]/);
    assert.match(after, /No job running/);
    assert.doesNotMatch(after, /Not generated/);
    assert.match(after, /Nothing is stored: the last run did not produce a civilization/);
});

test("tile-level abort: with the stall clock out of the way, three stalled tiles (2 attempts x 1200 ticks each) end the run in <= 7,200 ticks with a clear message", T, async () => {
    setup();
    CIV.stallTicks = 1e9;
    mc.createMode = () => "never";
    const player = makePlayer();
    await planOnly(player);
    assert.ok(mc.tick >= 3 * 2 * CIV.holdTimeoutTicks && mc.tick <= 3 * 2 * CIV.holdTimeoutTicks + 400, `aborted at tick ${mc.tick}`);
    const out = text(player);
    assert.match(out, /Stopped at stalled - nothing was changed/);
    assert.match(out, /did not finish loading \(3 of 3 survey tiles stalled; each waited 60 s, 2 times\)/);
    assert.match(out, /Ticking-area limit 100000, in use 0/);
    assertClean("tile-level abort");
    assert.match(asked(player, CIV_EVENT_IDS.status), /error: stalled: The chunks around/);
});

test("REGRESSION: the poll sees isFullyLoaded before the promise resolves - the granted hold is NOT removed by the late resolution", T, async () => {
    setup();
    mc.createMode = () => ({ loadedAfter: 19, delay: 22 });
    const token = { kind: "civ-plan", jobId: undefined, cancelled: false };
    let result;
    scan.holdArea(dimension, { x0: 0, z0: 0, x1: 127, z1: 127 }, token).then((v) => {
        result = v;
    });
    for (let i = 0; i < 40; i += 1) {
        advanceTick(1);
        await flush();
    }
    assert.equal(result.held, true);
    assert.equal(result.status, "held");
    assert.equal(mc.areas.size, 1, "the hold survives the late promise resolution");
    assert.equal(mc.areaLog.filter((l) => l.startsWith("remove")).length, 0);
    scan.releaseArea(token);
    assert.equal(mc.areas.size, 0);
    // a genuinely late resolution after a TIMEOUT is still cleaned up
    CIV.holdTimeoutTicks = 60;
    CIV.holdRetries = 0;
    mc.createMode = () => ({ delay: 100 });
    const t2 = { kind: "civ-plan", jobId: undefined, cancelled: false };
    let r2;
    scan.holdArea(dimension, { x0: 0, z0: 0, x1: 127, z1: 127 }, t2).then((v) => {
        r2 = v;
    });
    for (let i = 0; i < 160; i += 1) {
        advanceTick(1);
        await flush();
    }
    assert.equal(r2.status, "stalled");
    assert.equal(mc.areas.size, 0, "late area after a timeout is removed");
});

test("IdentifierAlreadyExists backs off (5 ticks, at most 3 times) instead of spinning", T, async () => {
    setup();
    mc.createMode = () => ({ reject: "IdentifierAlreadyExists" });
    const token = { kind: "civ-plan", jobId: undefined, cancelled: false };
    let result;
    scan.holdArea(dimension, { x0: 0, z0: 0, x1: 127, z1: 127 }, token).then((v) => {
        result = v;
    });
    for (let i = 0; i < 60; i += 1) {
        advanceTick(1);
        await flush();
    }
    assert.equal(result.status, "error");
    assert.match(result.note, /identifier stayed in use/);
    assert.equal(mc.createCalls, 4, "one try plus three back-offs");
    assert.ok(mc.tick >= 15);
});

test("a lone stalled tile is skipped (its columns stay unread, never guessed); the survey carries on and the plan is still valid", T, async () => {
    setup();
    CIV.holdTimeoutTicks = 100;
    let n = 0;
    mc.createMode = () => (++n === 5 ? "never" : undefined);
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    // the 5th create call never resolves; its 3 attempts are calls 5..7? no: calls are numbered per create, so only attempt 1 hangs
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/, text(player).slice(-500));
    assert.ok(outcome.stats.coarse.unheldTiles === 0);
    assert.equal(mc.writes, 0);
    assertClean("one hung attempt");
});

test("a tile that stalls both attempts is asked for again once the ring is generated, and its columns are recovered", T, async () => {
    setup();
    CIV.holdTimeoutTicks = 60;
    // both attempts of the 4th tile hang: calls 4 and 5; the retry pass asks again and succeeds
    mc.createMode = (chunks, options, n) => (n >= 4 && n <= 5 ? "never" : undefined);
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    await planOnly(player);
    const out = text(player);
    assert.match(out, /Plan is valid/, out.slice(-600));
    assert.equal(outcome.stats.coarse.retriedTiles, 1, "the stalled tile was asked for again");
    assert.ok(outcome.stats.coarse.recoveredTiles > 0, "its columns were read on the second pass");
    assert.equal(outcome.stats.coarse.stalledTiles.length, 0);
    assert.equal(outcome.stats.coarse.skippedColumns, 0);
    assert.doesNotMatch(out, /never finished loading/, "nothing was left unread, so nothing is reported");
    assertClean("recovered tile");
});

test("a tile that never loads on either pass is reported with its unread columns, never guessed", T, async () => {
    setup();
    CIV.holdTimeoutTicks = 60;
    // one specific tile never loads, on both original attempts and on the retry pass; every other tile is instant
    mc.createMode = (chunks, options) => (options.from.x === 0 && options.from.z === 128 ? "never" : undefined);
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    await planOnly(player);
    const out = text(player);
    // either the remaining ground still holds a site, or the refusal is honest - never a guess
    assert.ok(/Plan is valid/.test(out) || /Stopped at site/.test(out), out.slice(-800));
    assert.match(out, /1 survey tile\(s\) never finished loading/, "the summary names the skipped tile");
    assert.match(out, /column\(s\) of ground were never read/, "and counts the unread ground");
    if (outcome) {
        assert.equal(outcome.stats.coarse.retriedTiles, 1);
        assert.equal(outcome.stats.coarse.recoveredTiles, 0);
        assert.equal(outcome.stats.coarse.stalledTiles.length, 1);
        assert.ok(outcome.stats.coarse.skippedColumns > 0, "the unread columns are counted");
    }
    assert.equal(mc.writes, 0);
    assertClean("never-loaded tile");
});

test("coverageProblem names the unread ground, and says nothing when nothing was skipped", () => {
    assert.equal(builder.coverageProblem({ stalledTiles: [] }), undefined);
    assert.equal(builder.coverageProblem({}), undefined);
    const line = builder.coverageProblem({ stalledTiles: [{}, {}], skippedColumns: 512, retriedTiles: 2, recoveredTiles: 0 });
    assert.match(line, /2 survey tile\(s\) never finished loading/);
    assert.match(line, /asked for again 2 time\(s\); 0 column\(s\) recovered/);
    assert.match(line, /512 column\(s\) of ground were never read/);
    assert.match(line, /every candidate window over them is disqualified/);
    assert.match(line, /smaller radius=/);
});

test("slow chunk generation (resolves after 250 ticks per tile) is waited for: heartbeats, no timeout, valid plan", T, async () => {
    setup();
    mc.createMode = () => ({ delay: 250 });
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/, text(player).slice(-600));
    assert.equal(outcome.stats.coarse.stalledTiles.length, 0);
    assert.doesNotMatch(text(player), /did not finish loading/);
    // heartbeat cadence: one per 200 ticks while tiles load (tile messages are added when tiles are slow)
    const beats = text(player).match(/^ {2}\.\.\. /gm) ?? [];
    assert.ok(beats.length >= Math.floor(mc.tick / 200) - 2, `${beats.length} heartbeats in ${mc.tick} ticks`);
    assert.ok(mc.tick > outcome.stats.survey.tilesScanned * 250, "the clock really waited for every tile");
    assert.match(text(player), /chunk\(s\) loading/);
    assertClean("slow generation");
});

test("a first attempt that hangs is retried and succeeds (stalls are counted, notes mention it)", T, async () => {
    setup();
    CIV.holdTimeoutTicks = 80;
    mc.createMode = (chunks, options, n) => (n === 1 ? "never" : undefined);
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    await pump({ until: () => mc.tick >= 300 });
    const status = asked(player, CIV_EVENT_IDS.status);
    assert.match(status, /tile stalls 1/);
    assert.match(status, /did not finish loading in 4 s \(attempt 1\/2\)/);
    await pump();
    assert.match(text(player), /Plan is valid/);
    assertClean("retry");
});

// ---------------------------------------------------------------------------- engine errors, limits

test("OverChunkLimit on a tile shrinks the tile and carries on", T, async () => {
    setup();
    mc.createMode = (chunks) => (chunks > 16 ? { reject: "OverChunkLimit" } : undefined);
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/, text(player).slice(-500));
    assert.ok(mc.areaMaxChunks <= 16, `largest area ${mc.areaMaxChunks} chunks`);
    assert.match(asked(player, CIV_EVENT_IDS.status), /using smaller tiles/);
    assertClean("OverChunkLimit");
});

test("IdentifierAlreadyExists is retried; an unknown engine error means 'rely on loaded chunks' and is reported", T, async () => {
    setup();
    mc.createMode = (chunks, options, n) => (n <= 2 ? { reject: "IdentifierAlreadyExists" } : undefined);
    let player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/);
    assertClean("IdentifierAlreadyExists");
    setup();
    mc.createMode = () => ({ reject: "SomethingNew" });
    player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/);
    assert.match(asked(player, CIV_EVENT_IDS.status), /ticking area failed/);
    assertClean("unknown error");
});

test("a small maxChunkCount shrinks the survey tiles (<= 80% of the limit) and gives the same plan", T, async () => {
    setup();
    let reference;
    builder.seams.onOutcome = (o) => {
        reference = o;
    };
    await planOnly(makePlayer());
    setup();
    mc.maxChunkCount = 20;
    let small;
    builder.seams.onOutcome = (o) => {
        small = o;
    };
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/, text(player).slice(-400));
    assert.ok(mc.areaMaxChunks <= 16, `largest area ${mc.areaMaxChunks} chunks with maxChunkCount 20`);
    assert.equal(small.record.checksum, reference.record.checksum);
    assert.ok(small.stats.survey.tilesTotal > reference.stats.survey.tilesTotal);
    assert.match(text(player), /in 64-block tiles/);
});

test("no ticking-area capacity at all: the survey relies on loaded chunks and says so", T, async () => {
    setup();
    mc.noCapacity = true;
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/);
    assert.match(asked(player, CIV_EVENT_IDS.status), /no ticking-area capacity/);
    assertClean("no capacity");
});

// ---------------------------------------------------------------------------- progressive survey

test("early exit: a site near the anchor stops the survey after a few rings and equals the full-radius answer", T, async () => {
    setup();
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Plan is valid/);
    const survey = outcome.stats.survey;
    assert.equal(survey.early, true);
    assert.ok(survey.tilesScanned < survey.tilesTotal, `scanned ${survey.tilesScanned} of ${survey.tilesTotal} tiles`);
    assert.ok(survey.chunksScanned < survey.tilesTotal * 64);
    assert.match(text(player), /stopped early/);
    // the full-radius ranking over the same world picks the same site
    const token = { kind: "test", jobId: undefined, cancelled: false };
    let full;
    scan.scanCoarse(token, dimension, { x: 0, z: 0 }, survey.fullRadius, 8).then((v) => {
        full = v;
    });
    await pump({ until: () => full !== undefined });
    assert.equal(full.stats.attempted, survey.tilesTotal);
    const { rankSites } = await load("civ", "siteselect.js");
    const ranked = rankSites(full.field, { x: 0, z: 0 }, { searchRadius: CIV.defaultSearchRadius, exclusions: [], exclusionMargin: 84 });
    assert.equal(ranked.site.x, outcome.site.x);
    assert.equal(ranked.site.z, outcome.site.z);
    assert.equal(ranked.site.score, outcome.site.score);
    console.log(JSON.stringify({ earlyExit: { tilesScanned: survey.tilesScanned, tilesTotal: survey.tilesTotal, chunks: survey.chunksScanned, rings: survey.rings, ticks: mc.tick } }));
});

test("expansion: when the ground next to the anchor is unsuitable the survey widens ring by ring", T, async () => {
    setup(1, { field: { lakes: [{ x: 0, z: 0, r: 120 }] } });
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    await planOnly(player, `${GEN} radius=400`);
    assert.match(text(player), /Plan is valid/, text(player).slice(-700));
    assert.ok(outcome.stats.survey.rings >= 2, `rings ${outcome.stats.survey.rings}`);
    assert.ok(outcome.site.distance > 100, `site ${outcome.site.distance} blocks away`);
    assert.match(text(player), /no suitable site yet/);
    assertClean("expansion");
});

test("no site anywhere: every ring is scanned (worst case), the refusal lists reasons, zero writes", T, async () => {
    setup(1, { field: { relief: 70, hills: 18 } });
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Stopped at site/);
    assert.match(text(player), /Surveyed 100 of 100 tiles/);
    assertClean("worst case");
    console.log(JSON.stringify({ worstCase: { tiles: 100, ticks: mc.tick } }));
});

// ---------------------------------------------------------------------------- deadline, stall, cleanup, errors

test("overall deadline: a planning run that takes too long is cancelled safely with a reason", T, async () => {
    setup();
    CIV.planDeadlineTicks = 2000;
    mc.createMode = () => ({ delay: 300 });
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Planning timed out - cancelled, nothing was changed/);
    assert.match(text(player), /ran past its deadline of 100 s/);
    assert.ok(mc.tick >= 2000 && mc.tick < 2400, `cancelled at tick ${mc.tick}`);
    assertClean("deadline");
    const status = asked(player, CIV_EVENT_IDS.status);
    assert.match(status, /\(plan\): failed/);
    assert.match(status, /error: Planning ran past its deadline/);
});

test("stall detection: no progress for stallTicks cancels the session and records state 'stalled'", T, async () => {
    setup();
    CIV.holdTimeoutTicks = 1e9;
    CIV.stallTicks = 500;
    mc.createMode = () => "never";
    const player = makePlayer();
    await planOnly(player);
    assert.match(text(player), /Planning stalled - cancelled, nothing was changed/);
    assert.match(text(player), /No progress for 25 s/);
    assert.ok(mc.tick >= 500 && mc.tick < 700, `cancelled at tick ${mc.tick}`);
    assertClean("stall");
    assert.match(asked(player, CIV_EVENT_IDS.status), /\(plan\): stalled/);
});

test("abandoned ticking areas are removed at the start of civ commands when no job owns the slot", T, async () => {
    setup();
    mc.areas.set("civ-generate", { chunks: 64, loaded: true });
    mc.areas.set("civ-district-build", { chunks: 9, loaded: true });
    const player = makePlayer();
    const status = asked(player, CIV_EVENT_IDS.status);
    assert.match(status, /Removed abandoned ticking area\(s\) left by an earlier run: civ-generate, civ-district-build/);
    assert.equal(mc.areas.size, 0);
    mc.areas.set("civ-generate", { chunks: 64, loaded: true });
    await planOnly(player);
    assert.match(text(player), /Removed abandoned ticking area/);
    assert.match(text(player), /Plan is valid/);
    // never while a job owns the slot
    const token = districtBuilder.reserveJob("scout");
    mc.areas.set("civ-district-build", { chunks: 9, loaded: true });
    asked(player, CIV_EVENT_IDS.status);
    assert.equal(mc.areas.has("civ-district-build"), true, "a running job's area is left alone");
    districtBuilder.finishJob(token);
});

test("an error thrown inside planning, or while reporting the plan, still releases the slot and the area", T, async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(String(reason));
    process.on("unhandledRejection", onRejection);
    try {
        setup();
        builder.seams.validatePlan = function* () {
            throw new Error("boom in validation");
        };
        let player = makePlayer();
        await planOnly(player);
        assert.match(text(player), /boom in validation/);
        assertClean("error inside planning");
        // A plan report that cannot be produced (the measured storage of the run is missing): the outer catch still
        // releases the slot and the chunks and says nothing was changed.
        setup();
        builder.seams.onOutcome = (o) => {
            o.stats.storage = undefined;
        };
        player = makePlayer();
        await planOnly(player);
        assert.match(text(player), /Failed - nothing was changed/);
        assertClean("error while reporting the plan");
        const status = asked(player, CIV_EVENT_IDS.status);
        assert.match(status, /\(plan\): failed/);
        assert.match(status, /error: TypeError/);
        // Reporting is district-generic now: a master plan whose district list is gone must NOT crash the reporter -
        // the numbers of the district that was planned come from its own record. (This is the behaviour that replaced
        // the old crash; asserting it here so the change is recorded, not hidden.)
        setup();
        let captured;
        builder.seams.onOutcome = (o) => {
            captured = o;
        };
        player = makePlayer();
        await planOnly(player);
        assert.match(text(player), /Plan is valid/);
        assert.ok(captured?.ok, "the run reached a valid plan");
        const described = builder.describePlan({ ...captured, plan: { ...captured.plan, districts: [] } });
        assert.equal(described.district, 1);
        assert.equal(described.districtId, "district-1");
        assert.ok(described.ops > 0 && described.lots > 0, "the district's own record still reports its numbers");
        assert.equal(mc.writes, 0);
        // and the very next command works
        setup();
        const again = makePlayer();
        await planOnly(again);
        assert.match(text(again), /Plan is valid/);
        await flush();
    } finally {
        process.off("unhandledRejection", onRejection);
    }
    assert.deepEqual(rejections, [], "no unhandled rejection");
});

test("abort during a hold, then a new run: the old run's stale timers and late resolution never touch the new one", T, async () => {
    setup();
    mc.createMode = (chunks, options, n) => (n === 1 ? "never" : undefined);
    const first = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, first);
    await pump({ until: () => mc.tick >= 30 });
    assert.ok(districtBuilder.isBusy());
    send(CIV_EVENT_IDS.abort, "", first);
    await flush();
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(mc.areas.size, 0, "the aborted run's area is gone");
    const second = makePlayer();
    await planOnly(second);
    assert.match(text(second), /Plan is valid/, text(second).slice(-400));
    advanceTick(5000);
    await flush();
    assertClean("after stale callbacks");
    assert.doesNotMatch(text(second), /did not finish loading/);
});

test("a duplicate command during the survey is refused and shows the running session's phase and age", T, async () => {
    setup();
    mc.createMode = () => ({ delay: 100 });
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    await pump({ until: () => mc.tick >= 450 });
    const other = makePlayer();
    for (const id of [CIV_EVENT_IDS.generate, CIV_EVENT_IDS.plan, CIV_EVENT_IDS.resume]) {
        const answer = asked(other, id, GEN);
        await flush();
        void answer;
    }
    const all = text(other);
    assert.equal((all.match(/already running \(plan: phase 1\/6 survey, tile \d+\/\d+, running for \d+ s\)/g) ?? []).length, 3, all);
    send(CIV_EVENT_IDS.abort, "", player);
    await pump();
    assertClean("duplicate");
});

test("resume after an interrupted planning abort: a fresh generate works and builds from a clean slot", { timeout: 900000 }, async () => {
    setup();
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    await pump({ until: () => mc.tick >= 60 });
    send(CIV_EVENT_IDS.abort, "", player);
    await pump();
    assert.match(text(player), /no block was written by it/);
    assertClean("interrupted");
    send(CIV_EVENT_IDS.generate, GEN, player);
    await pump({ until: () => (builder.sessionStatus()?.pct ?? 0) >= 10 });
    send(CIV_EVENT_IDS.abort, "", player);
    await pump();
    assert.equal(civRecord().status, "paused");
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/);
});

// ---------------------------------------------------------------------------- explicit site: the survey never leaves the master plan's reach

test("site=here surveys only as far as the master plan reaches: no distant chunks, unlike the site search", T, async () => {
    /** Run one plan and report how far from the anchor any column was read, plus the survey's own counts. */
    async function measure(message) {
        setup();
        let outcome;
        builder.seams.onOutcome = (o) => {
            outcome = o;
        };
        const realGetBlock = dimension.getBlock;
        const realTopmost = dimension.getTopmostBlock;
        let farthest = 0;
        let columns = 0;
        dimension.getBlock = (position) => {
            farthest = Math.max(farthest, Math.abs(Math.floor(position.x)), Math.abs(Math.floor(position.z)));
            columns += 1;
            return realGetBlock.call(dimension, position);
        };
        dimension.getTopmostBlock = (position) => {
            farthest = Math.max(farthest, Math.abs(Math.floor(position.x)), Math.abs(Math.floor(position.z)));
            columns += 1;
            return realTopmost.call(dimension, position);
        };
        const player = makePlayer();
        try {
            send(CIV_EVENT_IDS.plan, message, player);
            await pump();
        } finally {
            dimension.getBlock = realGetBlock;
            dimension.getTopmostBlock = realTopmost;
        }
        assert.match(text(player), /Plan is valid/, text(player).slice(-700));
        assert.equal(mc.writes, 0, "planning writes nothing");
        return { outcome, farthest, columns, player };
    }
    const reach = builder.MASTER_REACH;
    assert.equal(reach, builder.MASTER_PLAN_RADIUS + 16, "the reach is the master plan radius plus its margin");
    const searched = await measure(GEN);
    assert.equal(searched.outcome.stats.survey.mode, "search");
    const here = await measure(`${GEN} site=here`);
    const survey = here.outcome.stats.survey;
    assert.equal(survey.mode, "here");
    assert.match(text(here.player), /Using where you stand as the civilization anchor/);
    assert.match(text(here.player), /No site is searched for/);
    assert.doesNotMatch(text(here.player), /ring \d+ scanned/, "no ring-by-ring site search happens");
    // the coarse survey covers exactly the reachable area, and nothing wider
    assert.equal(survey.fullRadius, reach, `the explicit-site survey reached ${String(survey.fullRadius)} blocks`);
    assert.equal(survey.scannedRadius, reach, "and it scanned all of it (one ring, the plan's own reach)");
    const tile = scan.tileSizeNow();
    const tiles = scan.countTiles({ x: 0, z: 0 }, reach, tile);
    assert.equal(here.outcome.stats.coarse.tilesTotal, tiles, `planned ${String(tiles)} tiles for a ${String(reach)}-block reach`);
    assert.equal(survey.tilesScanned, tiles, "every planned tile was read, none more");
    assert.ok(survey.chunksScanned <= tiles * (tile / 16) ** 2, `chunk count ${String(survey.chunksScanned)}`);
    // no column further from the anchor than the reach plus one tile was ever read (tiles are tile-aligned)
    assert.ok(here.farthest <= reach + tile, `the explicit-site survey read out to ${String(here.farthest)} blocks`);
    assert.ok(here.farthest < searched.farthest, `explicit site read ${String(here.farthest)} vs search ${String(searched.farthest)}: the distant search must not come back`);
    assert.ok(searched.farthest > reach, "the search mode really does scan past the reach (that is what site=here avoids)");
    assert.ok(here.columns < searched.columns, `${String(here.columns)} reads vs ${String(searched.columns)}`);
    console.log(JSON.stringify({
        explicitSite: {
            reach: reach,
            tiles: here.outcome.stats.coarse.tilesTotal,
            chunks: survey.chunksScanned,
            columnsRead: here.columns,
            farthestBlock: here.farthest,
            searchColumnsRead: searched.columns,
            searchFarthestBlock: searched.farthest,
        },
    }));
    // and the district's own ground is still read at full resolution inside that reach
    assert.match(text(here.player), /Reading district 1 \(Hearthgate, district-1\) at full resolution/);
    assert.match(text(here.player), /nothing outside this district is read/);
});

// ---------------------------------------------------------------------------- diagnostics

test("civ:generate_diag prints the engine limits, capacity, chunk state, owned areas and the last error", T, async () => {
    setup();
    mc.maxChunkCount = 300;
    const player = makePlayer();
    const out = asked(player, CIV_EVENT_IDS.diag);
    assert.match(out, /Ticking-area limit \(maxChunkCount\): 300; chunks in use pack-wide \(chunkCount\): 0; survey tile 128 x 128 blocks/);
    assert.match(out, /hasCapacity for a 64-chunk tile at 0,0: true/);
    assert.match(out, /Your chunk is loaded: true/);
    assert.match(out, /Ticking area 'civ-generate': none/);
    assert.match(out, /Ticking area 'civ-district-build': none/);
    assert.match(out, /Last session error: none/);
    mc.maxChunkCount = 40;
    assert.match(asked(player, CIV_EVENT_IDS.diag), /hasCapacity for a 64-chunk tile at 0,0: false/);
    assert.match(asked(player, CIV_EVENT_IDS.diag), /survey tile 80 x 80 blocks/);
    // after a failed run the error is shown
    setup();
    builder.seams.maxPlanBytes = 1000;
    const p2 = makePlayer();
    await planOnly(p2);
    assert.match(asked(p2, CIV_EVENT_IDS.diag), /Last session error: too-big/);
});

test("timeline numbers (fake world, one slice per tick) for the report", T, async () => {
    for (const [label, delay] of [["instant chunks", 0], ["40 ticks to load each tile", 40]]) {
        setup();
        if (delay > 0) mc.createMode = () => ({ delay });
        let outcome;
        builder.seams.onOutcome = (o) => {
            outcome = o;
        };
        const player = makePlayer();
        await planOnly(player);
        const s = outcome.stats.survey;
        console.log(JSON.stringify({ timeline: label, ticks: mc.tick, surveyTiles: `${s.tilesScanned}/${s.tilesTotal}`, chunks: s.chunksScanned, rings: s.rings, planningYields: outcome.stats.ops.yields }));
    }
});

void jobsModule;
void civCommands;

test("status never says 'Not generated' while a session runs, and shows a percent only where it is measurable", T, async () => {
    setup();
    mc.mode = undefined;
    mc.createMode = () => ({ delay: 30 });
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    await pump({ until: () => mc.tick >= 300 });
    let status = asked(player, CIV_EVENT_IDS.status);
    assert.doesNotMatch(status, /Not generated/);
    assert.match(status, /Nothing is stored yet: a plan session is running/);
    assert.match(status, /, \d+% of the current ring plan \(grows if the survey widens\)/);
    assert.match(text(player), /\(phase 1\/6\): tile \d+\/\d+, \d+%,/, "heartbeats carry the percent");
    // planning steps have no honest total: no percent
    await pump({ until: () => text(player).includes("[3/6]") });
    status = asked(player, CIV_EVENT_IDS.status);
    assert.match(status, /phase 3\/6 master plan/);
    assert.doesNotMatch(status, /\d+% of the current ring plan/);
    assert.doesNotMatch(status, /elapsed [^.]*, \d+%/);
    await pump();
});

test("build stall: a build that makes no progress is REPORTED (heartbeats, state, hint) but not auto-cancelled", T, async () => {
    setup();
    CIV.holdTimeoutTicks = 1e9;
    CIV.stallTicks = 400;
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    await pump({ until: () => builder.hasSession() });
    mc.createMode = () => "never";
    const start = mc.tick;
    await pump({ until: () => mc.tick >= start + 700 });
    const out = text(player);
    assert.match(out, /Build is not making progress/);
    assert.match(out, /The build was NOT cancelled/);
    assert.ok(districtBuilder.isBusy(), "still owns the slot");
    assert.ok(builder.hasSession());
    assert.equal(mc.writes, 0);
    const beats = out.match(/^ {2}\.\.\. building \(phase 6\/6\)/gm) ?? [];
    assert.ok(beats.length >= 2, `build heartbeats while a hold is pending: ${beats.length}`);
    const status = asked(player, CIV_EVENT_IDS.status);
    assert.match(status, /\(build\): stalled/);
    assert.match(status, /STALLED\?/);
    // the operator decides: abort keeps everything resumable
    send(CIV_EVENT_IDS.abort, "", player);
    await pump();
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(civRecord().status, "paused");
    assert.equal(mc.areas.size, 0);
});

test("a stalled session returns to running the moment it makes progress again", T, async () => {
    const progressModule = await load("integration", "civProgress.js");
    setup();
    const p = progressModule.startProgress("build", undefined, () => {});
    p.state = "stalled";
    progressModule.touch(p);
    assert.equal(p.state, "running");
    progressModule.finishProgress(p, "done");
});
