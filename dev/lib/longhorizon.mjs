import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Long-horizon siege harness (dev only, never shipped).
 *
 * Drives the REAL per-step pipeline - `advanceKingdom` from sim/tick.js, which runs war, gate
 * control, evacuation, construction, expansion, policy, population and training - over a
 * kingdom built by `createInitialKingdom`, and records what the siege did, step by step:
 *   - when each district first breached and first fell, and every lost episode it lived through
 *   - how many districts were lost together, and whether all five ever were
 *   - the lowest and highest integrity, and whether any wall ever went down
 *   - which siege mechanisms were active, counted from the battle log and the district records
 *   - a SHA-256 digest of the whole per-step trace, so a replay can be compared bit for bit
 *
 * The scripts directory is a parameter, so the same measurement runs against the shipped code
 * and against a copy of an older version (for reproducing a baseline). Nothing here reads the
 * clock, Math.random or the world: a seed plus a step count fully determines the result.
 *
 * It proves the offline arithmetic only. It says nothing about in-game feel or pacing.
 */

/** The shipped scripts directory, resolved from this file so it works from any cwd. */
export const DEFAULT_SCRIPTS_ROOT = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "CivilizationApocalypse_BP", "scripts");

/** The seed the shipped kingdom starts from (config.DEFAULT_SEED). */
export const DEFAULT_SEED = 20261017;

/** Named starting conditions. `balanced` is the shipped defence and nothing else. */
export const SCENARIOS = ["balanced", "underGarrisoned", "undefended"];

/** The district an undefended or under-garrisoned scenario weakens (the third of five). */
const CHALLENGE_DISTRICT_INDEX = 2;

/**
 * @param {string} scriptsRoot
 * @returns {Promise<{ scriptsRoot: string, config: any, state: any, tick: any, war: any }>}
 */
export async function loadSimulation(scriptsRoot = DEFAULT_SCRIPTS_ROOT) {
    const load = (/** @type {string[]} */ ...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
    const [config, state, tick, war] = await Promise.all([
        load("config.js"),
        load("kingdom", "state.js"),
        load("sim", "tick.js"),
        load("sim", "war.js"),
    ]);
    return { scriptsRoot, config, state, tick, war };
}

/**
 * A fresh default kingdom driven by its own seed.
 *
 * @param {{ state: any }} sim
 * @param {number} seed
 */
export function seededKingdom(sim, seed) {
    const kingdom = sim.state.createInitialKingdom();
    kingdom.seed = seed;
    kingdom.rngState = seed >>> 0;
    return kingdom;
}

/**
 * @param {{ war: any }} sim
 * @param {any} kingdom
 * @param {string} scenario one of SCENARIOS
 */
export function applyScenario(sim, kingdom, scenario) {
    if (scenario === "balanced") {
        return kingdom;
    }
    const target = kingdom.districts[CHALLENGE_DISTRICT_INDEX];
    if (scenario === "undefended") {
        target.soldiers = 0;
        target.garrison = { front: 0, reserve: 0 };
        return kingdom;
    }
    if (scenario === "underGarrisoned") {
        target.soldiers = 2;
        sim.war.assignDefenders(target);
        return kingdom;
    }
    throw new Error(`applyScenario: unknown scenario '${String(scenario)}'`);
}

/**
 * @typedef {{ from: number, to: number | null, length: number }} LostEpisode
 * @typedef {{
 *   firstBreachStep: number | null,
 *   firstLostStep: number | null,
 *   lostSteps: number,
 *   breaches: number,
 *   lostEpisodes: LostEpisode[],
 *   longestLostRun: number,
 *   longestRaidRun: number,
 *   fellWithResidualBand: number,
 *   fellWithRaidOpen: number,
 *   endSecurity: string,
 *   endIntegrity: number,
 *   endAssault: number,
 *   endSoldiers: number,
 * }} DistrictRecord
 */

/**
 * Runs one kingdom for `steps` pipeline steps, one `advanceKingdom(kingdom, 1)` call each, and
 * returns the measured record.
 *
 * @param {{ war: any, tick: any, state: any, config: any }} sim
 * @param {{ seed?: number, steps?: number, scenario?: string, kingdom?: any }} options
 */
export function runHorizon(sim, options = {}) {
    const seed = Number.isInteger(options.seed) ? /** @type {number} */ (options.seed) : DEFAULT_SEED;
    const steps = Number.isInteger(options.steps) ? /** @type {number} */ (options.steps) : 3000;
    const scenario = options.scenario ?? "balanced";
    const breachIntegrity = Number(sim.config.POLICY_DEFAULTS.breachIntegrity);
    const kingdom = applyScenario(sim, options.kingdom ?? seededKingdom(sim, seed), scenario);

    /** @type {Record<string, DistrictRecord>} */
    const perDistrict = {};
    const previousSecurity = new Map();
    for (const district of kingdom.districts) {
        perDistrict[String(district.id)] = {
            firstBreachStep: null,
            firstLostStep: null,
            lostSteps: 0,
            breaches: 0,
            lostEpisodes: [],
            longestLostRun: 0,
            longestRaidRun: 0,
            fellWithResidualBand: 0,
            fellWithRaidOpen: 0,
            endSecurity: String(district.security),
            endIntegrity: Number(district.defensiveIntegrity),
            endAssault: Number(district.assault),
            endSoldiers: Number(district.soldiers),
        };
        previousSecurity.set(String(district.id), String(district.security));
    }
    const raidRun = new Map(kingdom.districts.map((district) => [String(district.id), 0]));
    const lostRun = new Map(kingdom.districts.map((district) => [String(district.id), 0]));
    const openLost = new Map(/** @type {[string, LostEpisode][]} */ ([]));

    const mechanisms = {
        /** Battles against a standing defence where a band of 1-2 lost nobody. */
        tinyBandNoAttritionBattles: 0,
        /** Battles where a band of 1-2 met a standing defence at all. */
        tinyBandBattles: 0,
        /** Counterattack battles recorded (defenders at least 1.5x the band). */
        counterattacks: 0,
        /** Battles fought (non-counter) against a standing defence. */
        engagedBattles: 0,
        /** Battles with no defender able to stand. */
        unopposedBattles: 0,
        /** District-steps with raiders on the ground and the wall below full integrity. */
        raidedWallBelowFull: 0,
        /** District-steps with raiders on the ground and no able defender. */
        raidedWithNoDefender: 0,
    };

    let rejectedSteps = 0;
    let acceptedSteps = 0;
    let raidsLanded = 0;
    let allLostSteps = 0;
    let firstAllLostStep = /** @type {number | null} */ (null);
    let maxLostTogether = 0;
    let integrityMin = 100;
    let integrityMax = 0;
    let negativeIntegritySteps = 0;
    let wallRemoved = false;
    let soldiersNegative = false;
    const wallsStart = new Map(kingdom.districts.map((district) => [String(district.id), Number(district.buildings?.walls ?? 0)]));
    const wallsSeen = new Map(wallsStart);
    const trace = createHash("sha256");

    for (let index = 0; index < steps; index += 1) {
        const result = sim.tick.advanceKingdom(kingdom, 1);
        if (result.rejected.length > 0) {
            rejectedSteps += result.rejected.length;
            continue;
        }
        acceptedSteps += 1;
        const step = Number(kingdom.step);
        raidsLanded += result.events.filter((event) => /raiders press the district/u.test(event)).length;

        for (const battle of kingdom.battles) {
            if (battle.atStep !== step) {
                continue;
            }
            if (String(battle.outcome).startsWith("counter")) {
                mechanisms.counterattacks += 1;
                continue;
            }
            if (battle.standing <= 0) {
                mechanisms.unopposedBattles += 1;
                continue;
            }
            mechanisms.engagedBattles += 1;
            if (battle.assault <= 2) {
                mechanisms.tinyBandBattles += 1;
                if (battle.attackerLosses === 0) {
                    mechanisms.tinyBandNoAttritionBattles += 1;
                }
            }
        }

        let lostNow = 0;
        for (const district of kingdom.districts) {
            const id = String(district.id);
            const record = perDistrict[id];
            const security = String(district.security);
            const assault = Number(district.assault);
            const integrity = Number(district.defensiveIntegrity);

            if (integrity < 0) {
                negativeIntegritySteps += 1;
            }
            integrityMin = Math.min(integrityMin, integrity);
            integrityMax = Math.max(integrityMax, integrity);
            if (Number(district.soldiers) < 0) {
                soldiersNegative = true;
            }
            const walls = Number(district.buildings?.walls ?? 0);
            if (walls < (wallsSeen.get(id) ?? 0)) {
                wallRemoved = true;
            }
            wallsSeen.set(id, Math.max(walls, wallsSeen.get(id) ?? 0));

            if (assault > 0) {
                raidRun.set(id, (raidRun.get(id) ?? 0) + 1);
                record.longestRaidRun = Math.max(record.longestRaidRun, raidRun.get(id) ?? 0);
                if (integrity < 100) {
                    mechanisms.raidedWallBelowFull += 1;
                }
                if (!sim.war.hasAbleDefenders(district)) {
                    mechanisms.raidedWithNoDefender += 1;
                }
            } else {
                raidRun.set(id, 0);
            }

            const previous = previousSecurity.get(id);
            if (security === "breached" && previous !== "breached" && previous !== "lost" && record.firstBreachStep === null) {
                record.firstBreachStep = step;
            }
            if (security === "breached" && previous !== "breached" && previous !== "lost") {
                record.breaches += 1;
            }
            if (security === "lost") {
                lostNow += 1;
                record.lostSteps += 1;
                lostRun.set(id, (lostRun.get(id) ?? 0) + 1);
                record.longestLostRun = Math.max(record.longestLostRun, lostRun.get(id) ?? 0);
                if (previous !== "lost") {
                    record.firstLostStep = record.firstLostStep ?? step;
                    const episode = { from: step, to: null, length: 1 };
                    record.lostEpisodes.push(episode);
                    openLost.set(id, episode);
                    if (assault === 1 || assault === 2) {
                        record.fellWithResidualBand += 1;
                    }
                    if (assault > 0) {
                        record.fellWithRaidOpen += 1;
                    }
                } else {
                    const episode = openLost.get(id);
                    if (episode) {
                        episode.length += 1;
                    }
                }
            } else {
                lostRun.set(id, 0);
                if (previous === "lost") {
                    const episode = openLost.get(id);
                    if (episode) {
                        episode.to = step;
                        openLost.delete(id);
                    }
                }
            }
            previousSecurity.set(id, security);

            record.endSecurity = security;
            record.endIntegrity = integrity;
            record.endAssault = assault;
            record.endSoldiers = Number(district.soldiers);
        }

        maxLostTogether = Math.max(maxLostTogether, lostNow);
        if (lostNow === kingdom.districts.length) {
            allLostSteps += 1;
            firstAllLostStep = firstAllLostStep ?? step;
        }

        trace.update(
            JSON.stringify([
                step,
                kingdom.districts.map((district) => [
                    String(district.security),
                    Number(district.assault),
                    Math.round(Number(district.defensiveIntegrity) * 10) / 10,
                    Number(district.soldiers),
                    Number(district.civilians),
                ]),
            ]),
        );
    }

    /** @type {Record<string, DistrictRecord>} */
    const finished = perDistrict;
    const firstLost = Object.values(finished)
        .map((record) => record.firstLostStep)
        .filter((value) => value !== null);
    const firstBreach = Object.values(finished)
        .map((record) => record.firstBreachStep)
        .filter((value) => value !== null);

    return {
        seed,
        scenario,
        steps,
        acceptedSteps,
        rejectedSteps,
        raidsLanded,
        firstBreachStep: firstBreach.length > 0 ? Math.min(...firstBreach) : null,
        firstLostStep: firstLost.length > 0 ? Math.min(...firstLost) : null,
        firstAllLostStep,
        allLostSteps,
        maxLostTogether,
        lostAtEnd: kingdom.districts.filter((district) => district.security === "lost").length,
        lostAtEndWithRaid: kingdom.districts.filter((district) => district.security === "lost" && Number(district.assault) > 0).length,
        integrityMin,
        integrityMax,
        negativeIntegritySteps,
        wallRemoved,
        soldiersNegative,
        mechanisms,
        districts: finished,
        lostEpisodeCount: Object.values(finished).reduce((sum, record) => sum + record.lostEpisodes.length, 0),
        recoveredEpisodeCount: Object.values(finished).reduce(
            (sum, record) => sum + record.lostEpisodes.filter((episode) => episode.to !== null).length,
            0,
        ),
        breachCount: Object.values(finished).reduce((sum, record) => sum + record.breaches, 0),
        traceDigest: trace.digest("hex"),
        finalDigest: createHash("sha256").update(JSON.stringify(kingdom)).digest("hex"),
        kingdom,
    };
}
