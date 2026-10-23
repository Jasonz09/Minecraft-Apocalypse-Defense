import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Long-horizon siege probe (dev only, never shipped).
 *
 * Drives the REAL per-step pipeline (sim/tick.js advanceKingdomStep, i.e. war, gate control,
 * evacuation, construction, expansion, policy, population, training) over many seeds with the
 * default policy and no player intervention, then reports what the siege did:
 *   - whether and when a district first fell, and how many are lost at the end
 *   - how often raids landed, how often districts were under assault, and how often walls breached
 *   - the lowest integrity any district reached
 *   - whether any district recovered (lost -> standing, or breached -> calmer)
 *   - which of the six documented siege mechanisms were active, counted from the simulation
 *     state and the battle log rather than from prose
 *
 *   node dev/probe-siege.mjs                     16 seeds, 3000 steps, default defence
 *   node dev/probe-siege.mjs --steps=1000 --json
 *   node dev/probe-siege.mjs --scenario=undefended
 *
 * The module exports runSiegeRun() so dev/test/siege-longrun.test.mjs measures the same thing.
 * It proves the offline arithmetic only; it says nothing about in-game feel or pacing.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, computeTotals, findValidationProblems } = await loadModule("kingdom", "state.js");
const { advanceKingdomStep } = await loadModule("sim", "tick.js");
const war = await loadModule("sim", "war.js");

/** Sixteen fixed seeds: the shipped default plus fifteen small ones. Never Math.random. */
export const PROBE_SEEDS = [20261017, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
export const PROBE_STEPS = 3000;
/** The counterattack ratio the probe judges "defenders plainly outnumber the raid" against. */
const JUDGED_COUNTER_RATIO = 1.5;

/**
 * A fresh default kingdom driven by its own seed. Mirrors what sim/state does for a new
 * world, except for the seed, so a probe run and a unit test can name the same stream.
 *
 * @param {number} seed
 */
export function seededKingdom(seed) {
    const kingdom = createInitialKingdom();
    kingdom.seed = seed;
    kingdom.rngState = seed >>> 0;
    return kingdom;
}

/**
 * Named starting conditions. "default" is the shipped defence and nothing else.
 * "undefended" and "underGarrisoned" are the challenge cases: a district must still be able to
 * fall when it is left without the men to hold its wall.
 *
 * @param {string} scenario
 */
export function applyScenario(kingdom, scenario) {
    if (scenario === "default") {
        return kingdom;
    }
    const target = kingdom.districts[2];
    if (scenario === "undefended") {
        target.soldiers = 0;
        target.garrison = { front: 0, reserve: 0 };
        return kingdom;
    }
    if (scenario === "underGarrisoned") {
        target.soldiers = 2;
        war.assignDefenders(target);
        return kingdom;
    }
    throw new Error(`applyScenario: unknown scenario '${String(scenario)}'`);
}

const LOST = "lost";
const BREACHED = "breached";

/**
 * Runs one kingdom for `steps` full pipeline steps and returns the measured summary.
 *
 * @param {{ seed: number, steps?: number, scenario?: string, onStep?: (kingdom: any, result: any) => void }} options
 */
export function runSiegeRun(options) {
    const seed = options.seed;
    const steps = Number.isInteger(options.steps) ? /** @type {number} */ (options.steps) : PROBE_STEPS;
    const kingdom = applyScenario(seededKingdom(seed), options.scenario ?? "default");

    const previous = new Map(kingdom.districts.map((district) => [String(district.id), district.security]));
    const siegeRun = new Map(kingdom.districts.map((district) => [String(district.id), 0]));

    const summary = {
        seed,
        scenario: options.scenario ?? "default",
        steps,
        acceptedSteps: 0,
        rejectedSteps: 0,
        firstLostStep: /** @type {number | null} */ (null),
        firstBreachStep: /** @type {number | null} */ (null),
        lostAtEnd: 0,
        lostAtEndIds: /** @type {string[]} */ ([]),
        lostAtEndWithAssault: 0,
        raids: 0,
        stepsWithAssault: 0,
        districtStepsWithAssault: 0,
        longestSiegeRun: 0,
        breaches: 0,
        /** District-steps spent in the `breached` state: how much of the time a wall is down. */
        breachedDistrictSteps: 0,
        lostTransitions: 0,
        lostRecoveries: 0,
        breachRecoveries: 0,
        counterattacks: 0,
        resolveBattles: 0,
        integrityMin: 100,
        endSoldiers: 0,
        endCivilians: 0,
        endAssault: 0,
        endSecurity: /** @type {Record<string, string>} */ ({}),
        mechanisms: {
            /** (a) resolveAssault: a band of 1-2 that lost nobody to a defended wall. */
            a_tinyBandNoAttackerLoss: 0,
            /** (b) district-steps still standing below 1.5x the raid band, so no counterattack. */
            b_counterattackBlockedSteps: 0,
            /** (b) the same, but only for remnants of 1-2 raiders. */
            b_counterattackBlockedRemnantSteps: 0,
            /** (c) district-steps with the wall under 100 while a band is still on the ground. */
            c_repairBlockedSteps: 0,
            /** (c) the same, but only for remnants of 1-2 raiders. */
            c_repairBlockedRemnantSteps: 0,
            /** (d) district-steps lost while a construction project is still open there. */
            d_lostWithOpenProjectSteps: 0,
            /** (e) district-steps lost, which spawnThreats skips entirely. */
            e_lostDistrictSteps: 0,
            /** (f) resolveAssault battles where a band of 1-2 still chipped the wall. */
            f_tinyBandWallErosion: 0,
            /** Unopposed battles: a band hitting a district with no defender able to stand. */
            unopposedBattles: 0,
        },
    };

    for (let index = 0; index < steps; index += 1) {
        const result = advanceKingdomStep(kingdom);
        if (result.problems.length > 0) {
            summary.rejectedSteps += 1;
            continue;
        }
        summary.acceptedSteps += 1;
        if (typeof options.onStep === "function") {
            options.onStep(kingdom, result);
        }

        const step = Number(kingdom.step);
        let assaultThisStep = false;

        for (const entry of result.events) {
            if (/raiders press the district/u.test(entry)) {
                summary.raids += 1;
            }
        }

        for (const battle of kingdom.battles) {
            if (battle.atStep !== step) {
                continue;
            }
            if (String(battle.outcome).startsWith("counterattack")) {
                summary.counterattacks += 1;
                continue;
            }
            summary.resolveBattles += 1;
            const assault = Number(battle.assault);
            const standing = Number(battle.standing);
            if (standing <= 0) {
                summary.mechanisms.unopposedBattles += 1;
            }
            if (assault >= 1 && assault <= 2 && standing > 0 && Number(battle.attackerLosses) === 0) {
                summary.mechanisms.a_tinyBandNoAttackerLoss += 1;
            }
            if (assault >= 1 && assault <= 2 && Number(battle.integrityLoss) > 0) {
                summary.mechanisms.f_tinyBandWallErosion += 1;
            }
        }

        for (const district of kingdom.districts) {
            const id = String(district.id);
            const assault = Number(district.assault);
            const integrity = Number(district.defensiveIntegrity);
            const standing = war.defensiveStrength(district);
            const before = previous.get(id);
            const now = String(district.security);

            summary.integrityMin = Math.min(summary.integrityMin, integrity);

            if (assault > 0) {
                assaultThisStep = true;
                summary.districtStepsWithAssault += 1;
                siegeRun.set(id, (siegeRun.get(id) ?? 0) + 1);
                summary.longestSiegeRun = Math.max(summary.longestSiegeRun, siegeRun.get(id) ?? 0);
                if (standing < JUDGED_COUNTER_RATIO * assault) {
                    summary.mechanisms.b_counterattackBlockedSteps += 1;
                    if (assault <= 2) {
                        summary.mechanisms.b_counterattackBlockedRemnantSteps += 1;
                    }
                }
                if (integrity < 100) {
                    summary.mechanisms.c_repairBlockedSteps += 1;
                    if (assault <= 2) {
                        summary.mechanisms.c_repairBlockedRemnantSteps += 1;
                    }
                }
            } else {
                siegeRun.set(id, 0);
            }

            if (now === LOST) {
                summary.mechanisms.e_lostDistrictSteps += 1;
                if ((district.projects ?? []).some((project) => project.status !== "complete")) {
                    summary.mechanisms.d_lostWithOpenProjectSteps += 1;
                }
                if (summary.firstLostStep === null) {
                    summary.firstLostStep = step;
                }
            }
            if (now === BREACHED && summary.firstBreachStep === null) {
                summary.firstBreachStep = step;
            }
            if (now === BREACHED) {
                summary.breachedDistrictSteps += 1;
            }
            if (before !== BREACHED && now === BREACHED) {
                summary.breaches += 1;
            }
            if (before !== LOST && now === LOST) {
                summary.lostTransitions += 1;
            }
            if (before === LOST && now !== LOST) {
                summary.lostRecoveries += 1;
            }
            if (before === BREACHED && now !== BREACHED && now !== LOST) {
                summary.breachRecoveries += 1;
            }
            previous.set(id, now);
        }

        if (assaultThisStep) {
            summary.stepsWithAssault += 1;
        }
    }

    const finalTotals = computeTotals(kingdom);
    summary.endSoldiers = finalTotals.soldiers;
    summary.endCivilians = finalTotals.civilians;
    summary.endAssault = kingdom.districts.reduce((sum, district) => sum + Number(district.assault), 0);
    for (const district of kingdom.districts) {
        summary.endSecurity[String(district.id)] = String(district.security);
        if (district.security === LOST) {
            summary.lostAtEnd += 1;
            summary.lostAtEndIds.push(String(district.id));
            if (Number(district.assault) > 0) {
                summary.lostAtEndWithAssault += 1;
            }
        }
    }
    summary.validationProblemsAtEnd = findValidationProblems(kingdom).length;
    return summary;
}

/**
 * Human table over a set of runs.
 * @param {ReturnType<typeof runSiegeRun>[]} runs
 */
export function formatTable(runs) {
    const header = [
        "seed", "firstBreach", "firstLost", "lostEnd", "lostWithAssault", "stepsWithAssault", "raids", "breaches",
        "lostRecov", "breachRecov", "integrityMin", "longestSiege", "rejected", "endSoldiers",
        "a", "b", "b_rem", "c", "c_rem", "d", "e", "f",
    ];
    const lines = [header.join("\t")];
    for (const run of runs) {
        lines.push(
            [
                run.seed,
                run.firstBreachStep === null ? "never" : run.firstBreachStep,
                run.firstLostStep === null ? "never" : run.firstLostStep,
                run.lostAtEnd,
                run.lostAtEndWithAssault,
                run.stepsWithAssault,
                run.raids,
                run.breaches,
                run.lostRecoveries,
                run.breachRecoveries,
                Math.round(run.integrityMin * 10) / 10,
                run.longestSiegeRun,
                run.rejectedSteps,
                run.endSoldiers,
                run.mechanisms.a_tinyBandNoAttackerLoss,
                run.mechanisms.b_counterattackBlockedSteps,
                run.mechanisms.b_counterattackBlockedRemnantSteps,
                run.mechanisms.c_repairBlockedSteps,
                run.mechanisms.c_repairBlockedRemnantSteps,
                run.mechanisms.d_lostWithOpenProjectSteps,
                run.mechanisms.e_lostDistrictSteps,
                run.mechanisms.f_tinyBandWallErosion,
            ].join("\t"),
        );
    }
    return lines.join("\n");
}

function parseArguments(argv) {
    const args = { steps: PROBE_STEPS, scenario: "default", json: false, seeds: PROBE_SEEDS };
    for (const raw of argv) {
        if (raw === "--json") {
            args.json = true;
        } else if (raw.startsWith("--steps=")) {
            args.steps = Number(raw.slice("--steps=".length));
        } else if (raw.startsWith("--scenario=")) {
            args.scenario = raw.slice("--scenario=".length);
        } else if (raw.startsWith("--seeds=")) {
            args.seeds = raw.slice("--seeds=".length).split(",").map((value) => Number(value));
        } else {
            throw new Error(`probe-siege: unknown argument '${raw}'`);
        }
    }
    if (!Number.isInteger(args.steps) || args.steps < 1) {
        throw new Error("probe-siege: --steps must be a positive integer");
    }
    return args;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    const args = parseArguments(process.argv.slice(2));
    const runs = args.seeds.map((seed) => runSiegeRun({ seed, steps: args.steps, scenario: args.scenario }));
    if (args.json) {
        console.log(JSON.stringify(runs, null, 1));
    } else {
        console.log(`scenario=${args.scenario} steps=${String(args.steps)} seeds=${String(args.seeds.length)}`);
        console.log(formatTable(runs));
        const lostAll = runs.filter((run) => run.lostAtEnd === 5).length;
        const lostNone = runs.filter((run) => run.lostAtEnd === 0).length;
        console.log(`runs ending with all five districts lost: ${String(lostAll)}/${String(runs.length)}; with none lost: ${String(lostNone)}/${String(runs.length)}`);
    }
}
