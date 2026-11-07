import { POLICY_MODES, SIM } from "../config.js";
import { computeTotals, districtById } from "../kingdom/state.js";
import { formatGameTime } from "./clock.js";
import { collectBuildQueue } from "./construction.js";
import { establishMilitaryControl, evaluateExpansion, recordExternalVictory } from "./expansion.js";
import { advanceKingdom } from "./tick.js";

/**
 * Deterministic demonstration scenarios. Each one drives the real systems - nothing is
 * staged with fake numbers - and each returns report lines. They run against whatever
 * kingdom object is handed in, so the command layer can hand them a throwaway copy and
 * leave saved gameplay state untouched.
 */

const /** @type {Record<string, { title: string, summary: string, mutates: boolean, run: (kingdom: any, options: any) => string[] }>} */
SCENARIO_LIST = {
    attack: {
        title: "District under attack",
        summary: "Raiders press a gate; shows alert escalation, integrity loss and that a breach is not a capture.",
        mutates: true,
        run: (kingdom, options) => {
            const target = options.target ?? "district-3";
            const district = requireDistrict(kingdom, target);
            district.assault = 26;
            const before = describe(district);
            const result = advanceKingdom(kingdom, 6);
            return [
                `Scenario: raiders assault ${district.name} (assault 26).`,
                `Before: ${before}`,
                ...result.events.slice(0, 6).map((line) => `  ${line}`),
                `After ${String(result.ran)} steps: ${describe(district)}`,
                `Captured? ${district.security === "lost" ? "yes" : "no - a breached wall does not abandon a district"}`,
            ];
        },
    },
    evacuation: {
        title: "Civilian evacuation and reinforcements",
        summary: "A walled district falls to breached, civilians move to a safe connected neighbour, neighbours send troops.",
        mutates: true,
        run: (kingdom, options) => {
            const target = options.target ?? "district-2";
            const district = requireDistrict(kingdom, target);
            district.assault = 30;
            district.defensiveIntegrity = 35;
            const originTotals = computeTotals(kingdom);
            const result = advanceKingdom(kingdom, 8);
            const moved = result.events.filter((line) => /evacuat|refugee|reinforce|march/i.test(line));
            const afterTotals = computeTotals(kingdom);
            return [
                `Scenario: ${district.name} is under heavy assault at integrity 35.`,
                `Now: ${describe(district)}`,
                ...(moved.length > 0 ? moved.slice(0, 8).map((line) => `  ${line}`) : ["  (no movement this run)"]),
                `Population check: ${String(originTotals.civilians)} civilians before, ${String(afterTotals.civilians)} after (evacuation moves people, it never creates them).`,
                `Shelter check: ${shelterReport(kingdom)}`,
            ];
        },
    },
    counterattack: {
        title: "Counterattack after reinforcements",
        summary: "Neighbours reinforce a hard-pressed district, which then clears the raiders and recovers.",
        mutates: true,
        run: (kingdom, options) => {
            const target = options.target ?? "district-4";
            const district = requireDistrict(kingdom, target);
            district.assault = 18;
            district.defensiveIntegrity = 70;
            const result = advanceKingdom(kingdom, 10);
            const fighting = result.events.filter((line) => /counterattack|raiders|repel|recover|reinforc/i.test(line));
            return [
                `Scenario: ${district.name} holds at integrity 70 against assault 18.`,
                ...(fighting.length > 0 ? fighting.slice(0, 8).map((line) => `  ${line}`) : ["  (no engagement logged)"]),
                `After ${String(result.ran)} steps: ${describe(district)}`,
            ];
        },
    },
    expansion: {
        title: "Victory outside the border, then expansion",
        summary: "A won battle opens adjacent land: military control, claim, new district, staged construction plan.",
        mutates: true,
        run: (kingdom, options) => {
            const lands = /** @type {any[]} */ (kingdom.territory ?? []);
            const districts = /** @type {any[]} */ (kingdom.districts ?? []);
            const land = options.target ?? lands[0]?.id ?? "land-1";
            const before = districts.length;
            recordExternalVictory(kingdom, land, {});
            establishMilitaryControl(kingdom, land, {});
            const verdict = evaluateExpansion(kingdom, land);
            const result = advanceKingdom(kingdom, 6);
            const territory = lands.find((entry) => entry.id === land);
            const after = kingdom.districts.length;
            const newest = /** @type {any[]} */ (kingdom.districts)[after - 1];
            const lines = [
                `Scenario: victory recorded at ${territory ? territory.name : land}.`,
                `Expansion verdict: ${verdict.eligible ? "eligible" : `refused - ${verdict.reasons.join("; ")}`}`,
                ...result.events.slice(0, 6).map((line) => `  ${line}`),
                `Districts: ${String(before)} -> ${String(after)}, territory status now '${String(territory?.status)}'.`,
            ];
            if (newest) {
                lines.push(`New district ${newest.name}: ${describe(newest)}`);
                const projects = /** @type {any[]} */ (newest.projects ?? []);
                lines.push(`Scheduled: ${projects.map((project) => `${String(project.kind)} (${String(project.stage)}/${String(project.stageCount)})`).join(", ") || "nothing"}`);
            }
            return lines;
        },
    },
    shortage: {
        title: "Resource shortage prevents expansion",
        summary: "The same victory is refused when the adjacent district cannot feed or supply the effort.",
        mutates: true,
        run: (kingdom, options) => {
            const lands = /** @type {any[]} */ (kingdom.territory ?? []);
            const land = options.target ?? lands[0]?.id ?? "land-1";
            const territory = lands.find((entry) => entry.id === land);
            const anchor = territory ? districtById(kingdom, territory.adjacentDistrictId) : undefined;
            if (anchor) {
                anchor.reserves.food = 0;
                anchor.reserves.materials = 0;
                anchor.reserves.supplies = 0;
            }
            recordExternalVictory(kingdom, land, {});
            const verdict = evaluateExpansion(kingdom, land);
            const result = advanceKingdom(kingdom, 4);
            const after = lands.find((entry) => entry.id === land);
            return [
                `Scenario: ${anchor ? anchor.name : "the adjacent district"} has spent all its stores.`,
                `Expansion verdict: ${verdict.eligible ? "ELIGIBLE - this scenario expected a refusal" : "refused, as expected"}`,
                ...verdict.reasons.map((reason) => `  - ${reason}`),
                ...result.events.slice(0, 4).map((line) => `  ${line}`),
                `Territory '${String(after ? after.name : land)}' status after ${String(result.ran)} steps: ${String(after?.status)}.`,
                `Districts remain ${String(kingdom.districts.length)}.`,
            ];
        },
    },
    growth: {
        title: "Population growth and recruitment",
        summary: "A safe, fed district grows toward shelter capacity and sends recruits through the training queue.",
        mutates: true,
        run: (kingdom, options) => {
            const target = options.target ?? "district-1";
            const district = requireDistrict(kingdom, target);
            district.security = "secure";
            district.reserves.food = 400;
            district.reserves.supplies = 200;
            const before = { civilians: district.civilians, soldiers: district.soldiers, queue: district.trainingQueue };
            const result = advanceKingdom(kingdom, 12);
            return [
                `Scenario: ${district.name} is fed and secure.`,
                ...result.events.filter((line) => /train|recruit|grow|settler|birth|shortage/i.test(line)).slice(0, 6).map((line) => `  ${line}`),
                `Civilians ${String(before.civilians)} -> ${String(district.civilians)} of capacity ${String(district.civilianCapacity)}.`,
                `Soldiers ${String(before.soldiers)} -> ${String(district.soldiers)} (training queue ${String(before.queue)} -> ${String(district.trainingQueue)}).`,
            ];
        },
    },
};

/**
 * @param {any} kingdom
 * @param {string} id
 */
function requireDistrict(kingdom, id) {
    const district = districtById(kingdom, id);
    if (!district) {
        throw new Error(`unknown district '${String(id)}'; try one of ${/** @type {any[]} */ (kingdom.districts ?? []).map((entry) => entry.id).join(", ")}`);
    }
    return district;
}

/**
 * @param {any} district
 */
function describe(district) {
    return `security ${String(district.security)}, integrity ${String(Math.round(Number(district.defensiveIntegrity)))}, assault ${String(Math.round(Number(district.assault)))}, ${String(district.civilians)} civilians (${String(district.refugees)} refugees), ${String(district.soldiers)} soldiers`;
}

/**
 * @param {any} kingdom
 */
function shelterReport(kingdom) {
    const districts = /** @type {any[]} */ (kingdom.districts ?? []);
    const over = districts.filter((district) => Number(district.civilians) + Number(district.refugees) > Number(district.civilianCapacity));
    return over.length === 0 ? "no district is over shelter" : `${String(over.length)} district(s) over shelter`;
}

/**
 * @returns {{ id: string, title: string, summary: string, mutates: boolean }[]}
 */
export function listScenarios() {
    return Object.entries(SCENARIO_LIST).map(([id, entry]) => ({ id, title: entry.title, summary: entry.summary, mutates: entry.mutates }));
}

/**
 * @param {string} id
 */
export function scenarioExists(id) {
    return Object.prototype.hasOwnProperty.call(SCENARIO_LIST, id);
}

/**
 * @param {any} kingdom
 * @param {string} id
 * @param {{ target?: string, steps?: number }} options
 * @returns {{ id: string, title: string, lines: string[] }}
 */
export function runScenario(kingdom, id, options = {}) {
    const scenario = SCENARIO_LIST[id];
    if (scenario === undefined) {
        throw new Error(`unknown scenario '${String(id)}'; known: ${Object.keys(SCENARIO_LIST).join(", ")}`);
    }
    const steps = options.steps;
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 1 || steps > SIM.maxCatchUpSteps)) {
        throw new Error(`steps must be an integer between 1 and ${String(SIM.maxCatchUpSteps)}, got ${String(steps)}`);
    }
    return { id, title: scenario.title, lines: scenario.run(kingdom, { target: options.target, steps }) };
}

/**
 * A read-only preview of what the build adapter would place, for the debug command.
 * @param {any} kingdom
 */
export function previewBuildQueue(kingdom) {
    const queue = collectBuildQueue(kingdom, 8);
    return queue.map((entry) => `${String(entry.kind)} ${String(entry.districtId)} at stage ${String(entry.stage)}, ${String(entry.remainingStages)} stage(s) left -> ${String(entry.blocksPlanned)} blocks to place`);
}

export const SCENARIO_IDS = Object.keys(SCENARIO_LIST);
export const POLICY_MODE_LIST = POLICY_MODES;
