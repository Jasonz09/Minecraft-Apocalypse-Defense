import assert from "node:assert/strict";
import test from "node:test";
import { applyScenario, loadSimulation, runHorizon, seededKingdom } from "../lib/longhorizon.mjs";

/**
 * Long-horizon siege regression (dev only). Runs the REAL per-step pipeline for thousands of
 * steps over fixed seeds and checks the balance promises in docs/GAME_DESIGN.md (siege section):
 *   a) a balanced default kingdom never has every district lost at once
 *   b) it is still a real challenge: breaches happen early and some lost districts recover
 *   c) integrity stays inside 0..100, no wall is ever removed, the saved state stays valid
 *   d) the same seed replays bit for bit (per-step trace and final state digests)
 *   e) no district stays lost for ever under balanced defence
 *   and the threat is not removed: an undefended district still falls.
 *
 * Before the fix this file failed: every default seed ended with all five districts lost after
 * roughly 40 in-game days (see docs/GAME_DESIGN.md, "Siege balance").
 */

/** Eight fixed seeds: the shipped default plus seven small ones. Never Math.random. */
const SEEDS = [20261017, 1, 2, 3, 4, 5, 6, 7];
/** Three thousand steps is 125 in-game days (24 steps a day), well past the old deadlock at ~40 days. */
const STEPS = 3000;
/** The longest a district may stay lost under balanced defence: five in-game days. */
const LONGEST_LOST_RUN = 120;
/** The earliest breach and loss, across the seeds, must come early enough to matter. */
const EARLY_BREACH_STEP = 300;
const EARLY_LOSS_STEP = 400;
/** The undefended challenge district (third of five; see dev/lib/longhorizon.mjs). */
const CHALLENGE_DISTRICT = "district-3";
/** Seeds for the undefended run: enough to show the threat is real, not one lucky draw. */
const UNDEFENDED_SEEDS = [20261017, 1, 2];

const sim = await loadSimulation();

/** @type {Map<string, any>} */
const memo = new Map();

/**
 * Each run is computed once and shared between the tests in this file.
 * @param {number} seed
 * @param {string} scenario
 */
function horizon(seed, scenario = "balanced") {
    const key = `${scenario}:${String(seed)}`;
    if (!memo.has(key)) {
        memo.set(key, runHorizon(sim, { seed, steps: STEPS, scenario }));
    }
    return memo.get(key);
}

test("a balanced default kingdom never has every district lost at once", () => {
    for (const seed of SEEDS) {
        const run = horizon(seed);
        assert.equal(run.rejectedSteps, 0, `seed ${String(seed)}: the real tick accepted every step`);
        assert.equal(run.firstAllLostStep, null, `seed ${String(seed)}: all five districts were lost together at step ${String(run.firstAllLostStep)}`);
        assert.ok(run.maxLostTogether < run.kingdom.districts.length, `seed ${String(seed)}: ${String(run.maxLostTogether)} lost at once`);
    }
});

test("the challenge is real: breaches happen early, and lost districts come back", () => {
    let earliestBreach = Infinity;
    let earliestLoss = Infinity;
    let recovered = 0;
    for (const seed of SEEDS) {
        const run = horizon(seed);
        assert.ok(run.breachCount >= 1, `seed ${String(seed)}: the defence was breached at least once`);
        // Adapted: the defence is now sustainable (docs/SIEGE_BALANCE.md), so most seeds first breach
        // around step 1000-1400 rather than 800-900. The per-seed bound is the first half of the 3000-step
        // horizon; the earliest breach across seeds is still held to EARLY_BREACH_STEP below.
        assert.ok(run.firstBreachStep !== null && run.firstBreachStep <= 1500, `seed ${String(seed)}: the first breach came by step 1500`);
        earliestBreach = Math.min(earliestBreach, run.firstBreachStep ?? Infinity);
        earliestLoss = Math.min(earliestLoss, run.firstLostStep ?? Infinity);
        recovered += run.recoveredEpisodeCount;
    }
    assert.ok(earliestBreach <= EARLY_BREACH_STEP, `the earliest breach across seeds is step ${String(earliestBreach)}, expected by ${String(EARLY_BREACH_STEP)}`);
    assert.ok(earliestLoss <= EARLY_LOSS_STEP, `the earliest loss across seeds is step ${String(earliestLoss)}, expected by ${String(EARLY_LOSS_STEP)}`);
    assert.ok(recovered >= SEEDS.length, `districts that fell came back ${String(recovered)} times across ${String(SEEDS.length)} runs`);
});

test("integrity stays inside 0..100, no wall is ever removed, and the saved state stays valid", () => {
    for (const seed of SEEDS) {
        const run = horizon(seed);
        assert.equal(run.negativeIntegritySteps, 0, `seed ${String(seed)}: integrity went negative`);
        assert.ok(run.integrityMin >= 0 && run.integrityMax <= 100, `seed ${String(seed)}: integrity ${String(run.integrityMin)}..${String(run.integrityMax)}`);
        assert.equal(run.wallRemoved, false, `seed ${String(seed)}: a wall count went down`);
        for (const district of run.kingdom.districts) {
            assert.ok(district.buildings.walls >= 1, `${String(district.id)} keeps its wall`);
        }
        // Population is not conserved across the full tick (peacetime growth adds people), so the
        // check here is the save validator: garrison split, shelter capacity, integrity range.
        const problems = sim.state.findValidationProblems(run.kingdom);
        assert.deepEqual(problems, [], `seed ${String(seed)}: saved state is valid after ${String(STEPS)} steps`);
    }
});

test("the same seed replays identically, and a different seed diverges", () => {
    const first = horizon(SEEDS[0]);
    const again = runHorizon(sim, { seed: SEEDS[0], steps: STEPS, scenario: "balanced" });
    assert.equal(again.traceDigest, first.traceDigest, "per-step trace digests match");
    assert.equal(again.finalDigest, first.finalDigest, "final state digests match");
    assert.equal(again.breachCount, first.breachCount);
    assert.equal(again.lostEpisodeCount, first.lostEpisodeCount);

    const other = horizon(SEEDS[1]);
    assert.notEqual(other.traceDigest, first.traceDigest, "a different seed takes a different path");
});

test("no district stays lost for ever under balanced defence", () => {
    for (const seed of SEEDS) {
        const run = horizon(seed);
        for (const [id, record] of Object.entries(run.districts)) {
            assert.ok(
                record.longestLostRun <= LONGEST_LOST_RUN,
                `seed ${String(seed)} ${id}: lost for ${String(record.longestLostRun)} steps in a row (limit ${String(LONGEST_LOST_RUN)})`,
            );
            for (const episode of record.lostEpisodes) {
                if (episode.to === null) {
                    assert.ok(
                        run.kingdom.step - episode.from <= LONGEST_LOST_RUN,
                        `seed ${String(seed)} ${id}: still lost since step ${String(episode.from)}`,
                    );
                }
            }
        }
    }
});

test("an undefended district still falls, so the fix did not remove the threat", () => {
    for (const seed of UNDEFENDED_SEEDS) {
        const run = horizon(seed, "undefended");
        assert.equal(run.rejectedSteps, 0, `seed ${String(seed)}: undefended run accepted every step`);
        assert.equal(run.negativeIntegritySteps, 0, `seed ${String(seed)}: integrity stayed non-negative`);
        const record = run.districts[CHALLENGE_DISTRICT];
        assert.ok(record.firstBreachStep !== null, `seed ${String(seed)}: the undefended district was breached`);
        assert.ok(record.lostEpisodes.length >= 1, `seed ${String(seed)}: the undefended district fell at least once`);
        assert.ok(record.lostSteps > 0, `seed ${String(seed)}: and spent steps lost`);
    }
});

/** Eight more seeds, run for a shorter horizon: a wider pool than the long runs, checked on every step. */
const FAST_SEEDS = [100, 101, 102, 103, 104, 105, 106, 107];
/** Four hundred steps is about seventeen in-game days: long enough for a siege to start and resolve. */
const FAST_STEPS = 400;
/** Long runs validate the saved state at this interval; the fast subset validates every step. */
const CHECKPOINT_EVERY = 150;
/** Most districts that may be lost together on any step of a default run. */
const LOST_TOGETHER_BOUND = 3;
/** Share of long-run seeds that must end with at most one district lost. */
const ONE_LOST_SHARE = 0.9;
const STORES = ["food", "materials", "supplies"];

/**
 * Steps a balanced kingdom one step at a time through the real tick, checking what the save
 * validator and the store rules promise: no negative stock, integrity inside 0..100, and the
 * validator itself at every checkpoint. Not memoised: every call replays from the seed.
 *
 * @param {number} seed
 * @param {number} steps
 * @param {number} every validate the saved state every this many steps
 */
function checkedRun(seed, steps, every) {
    const kingdom = applyScenario(sim, seededKingdom(sim, seed), "balanced");
    const problems = [];
    let rejected = 0;
    let maxLostTogether = 0;
    let negativeStockDistrictSteps = 0;
    let minIntegrity = 100;
    let maxIntegrity = 0;
    for (let index = 1; index <= steps; index += 1) {
        const result = sim.tick.advanceKingdomStep(kingdom);
        if (result.problems.length > 0) {
            rejected += 1;
        }
        let lost = 0;
        for (const district of kingdom.districts) {
            if (district.security === "lost") {
                lost += 1;
            }
            if (STORES.some((key) => Number(district.reserves[key]) < 0)) {
                negativeStockDistrictSteps += 1;
            }
            minIntegrity = Math.min(minIntegrity, Number(district.defensiveIntegrity));
            maxIntegrity = Math.max(maxIntegrity, Number(district.defensiveIntegrity));
        }
        maxLostTogether = Math.max(maxLostTogether, lost);
        if (index % every === 0 || index === steps) {
            for (const problem of sim.state.findValidationProblems(kingdom)) {
                problems.push(`step ${String(kingdom.step)}: ${problem}`);
            }
        }
    }
    return { kingdom, rejected, problems, maxLostTogether, negativeStockDistrictSteps, minIntegrity, maxIntegrity };
}

test("the long runs end with at most one district lost on at least 90% of seeds, and never with all five", () => {
    let atMostOne = 0;
    for (const seed of SEEDS) {
        const run = horizon(seed);
        const lostAtEnd = run.kingdom.districts.filter((district) => district.security === "lost").length;
        assert.ok(lostAtEnd < run.kingdom.districts.length, `seed ${String(seed)}: all five districts lost at step ${String(run.kingdom.step)}`);
        if (lostAtEnd <= 1) {
            atMostOne += 1;
        }
    }
    assert.ok(
        atMostOne / SEEDS.length >= ONE_LOST_SHARE,
        `${String(atMostOne)} of ${String(SEEDS.length)} seeds ended with at most one district lost (target ${String(ONE_LOST_SHARE * 100)}%)`,
    );
});

test("the lost count stays bounded: never more than three districts lost together on any long-run seed", () => {
    for (const seed of SEEDS) {
        const run = horizon(seed);
        assert.ok(run.maxLostTogether <= LOST_TOGETHER_BOUND, `seed ${String(seed)}: ${String(run.maxLostTogether)} districts lost together`);
    }
});

test("the saved state validates at every checkpoint, and no store or wall goes out of range on any long-run seed", () => {
    for (const seed of SEEDS) {
        const run = checkedRun(seed, STEPS, CHECKPOINT_EVERY);
        assert.equal(run.rejected, 0, `seed ${String(seed)}: the real tick rejected no step`);
        assert.deepEqual(run.problems, [], `seed ${String(seed)}: the save validator passes at every checkpoint`);
        assert.equal(run.negativeStockDistrictSteps, 0, `seed ${String(seed)}: no food, materials or supplies went negative`);
        assert.ok(run.minIntegrity >= 0 && run.maxIntegrity <= 100, `seed ${String(seed)}: integrity ${String(run.minIntegrity)}..${String(run.maxIntegrity)}`);
    }
});

test("the fast subset: eight more seeds validated on every step, with no all-lost run and no negative store", () => {
    for (const seed of FAST_SEEDS) {
        const run = checkedRun(seed, FAST_STEPS, 1);
        assert.equal(run.rejected, 0, `seed ${String(seed)}: no step was rejected`);
        assert.deepEqual(run.problems, [], `seed ${String(seed)}: the save validator passes on every step`);
        assert.ok(run.maxLostTogether < run.kingdom.districts.length, `seed ${String(seed)}: all five districts lost together`);
        assert.equal(run.negativeStockDistrictSteps, 0, `seed ${String(seed)}: no store went negative`);
        assert.ok(run.minIntegrity >= 0 && run.maxIntegrity <= 100, `seed ${String(seed)}: integrity ${String(run.minIntegrity)}..${String(run.maxIntegrity)}`);
    }
});
