import { SIM } from "../config.js";
import { findValidationProblems } from "../kingdom/state.js";
import { formatGameTime } from "./clock.js";
import { advanceConstruction, assignBuilders } from "./construction.js";
import { runEvacuationStep } from "./evacuation.js";
import { runGateControlStep, validateGateRecords } from "./gatecontrol.js";
import { runInvasionDirectorStep } from "./invasion/director.js";
import { runExpansionStep } from "./expansion.js";
import { advanceTraining, runPopulationStep } from "./population.js";
import { runPolicyStep } from "./policies.js";
import { runWarStep } from "./war.js";

/**
 * The simulation step, in one place. Order matters and is fixed:
 *   war -> evacuation -> construction -> expansion -> policies -> population -> training
 * Each system is pure JavaScript over the kingdom object, so this whole loop runs in
 * Node exactly as it runs in Minecraft.
 */

/** Builders work while the district is standing; under active assault they man the walls instead. */
const CONSTRUCTION_CAN_WORK_SECURITY = ["secure", "alert", "isolated"];

/** How many finished projects a district keeps in the save as history. */
const COMPLETED_PROJECT_HISTORY = 2;

/**
 * Systems return either a string list or a report object; normalise both.
 * @param {any} result
 * @returns {string[]}
 */
function toEvents(result) {
    if (Array.isArray(result)) {
        return result.map((entry) => String(entry));
    }
    if (result && Array.isArray(result.events)) {
        return /** @type {any[]} */ (result.events).map((entry) => String(entry));
    }
    return [];
}

/**
 * @param {{ id?: string }} left
 * @param {{ id?: string }} right
 */
function byId(left, right) {
    return String(left.id).localeCompare(String(right.id));
}

/**
 * A finished project has already been applied to `district.buildings`, so keeping every
 * completed record forever would grow the saved kingdom without limit. The last few are
 * kept as history; the rest are dropped. Walls are never removed by this - the building
 * count and the district's integrity are untouched.
 *
 * @param {any} kingdom
 */
function pruneCompletedProjects(kingdom) {
    for (const district of kingdom.districts) {
        const projects = /** @type {any[]} */ (district.projects ?? []);
        const open = projects.filter((project) => project.status !== "complete");
        const done = projects.filter((project) => project.status === "complete");
        // Keep the newest records; permanent defences (walls, gate) are never forgotten.
        const permanent = done.filter((project) => project.kind === "walls" || project.kind === "gate");
        const others = done.filter((project) => project.kind !== "walls" && project.kind !== "gate");
        const recent = others.slice(-COMPLETED_PROJECT_HISTORY);
        district.projects = [...open, ...done.filter((project) => permanent.includes(project) || recent.includes(project))];
    }
}

/**
 * @param {any} kingdom
 * @returns {string[]}
 */
export function runConstructionStep(kingdom) {
    const /** @type {string[]} */ events = [];
    for (const district of [...kingdom.districts].sort(byId)) {
        const canWork = CONSTRUCTION_CAN_WORK_SECURITY.includes(String(district.security));
        events.push(...toEvents(assignBuilders(district, kingdom, { canWork })));
        events.push(...toEvents(advanceConstruction(district, { canWork, kingdom })));
    }
    pruneCompletedProjects(kingdom);
    return events;
}

/**
 * @param {any} kingdom
 * @returns {string[]}
 */
export function runTrainingStep(kingdom) {
    const /** @type {string[]} */ events = [];
    for (const district of [...kingdom.districts].sort(byId)) {
        if (Number(district.trainingQueue ?? 0) > 0) {
            events.push(...toEvents(advanceTraining(kingdom, district)));
        }
    }
    return events;
}

/**
 * @param {any} kingdom
 */
function snapshot(kingdom) {
    return JSON.stringify(kingdom);
}

/**
 * Put a rejected step's state back wholesale, keeping the object identity callers hold.
 * @param {any} kingdom
 * @param {string} previous
 */
function restore(kingdom, previous) {
    for (const key of Object.keys(kingdom)) {
        delete kingdom[key];
    }
    Object.assign(kingdom, JSON.parse(previous));
}

/**
 * One hour of kingdom life. A step that produces a state the save validator would
 * refuse is rolled back and reported instead of being persisted or half-applied.
 *
 * @param {any} kingdom
 * @returns {{ step: number, gameTime: string, events: string[], problems: string[] }}
 */
export function advanceKingdomStep(kingdom) {
    const before = snapshot(kingdom);
    kingdom.step = Number(kingdom.step) + 1;

    const /** @type {string[]} */ events = [];
    /** @type {string[]} */
    let problems;
    try {
        // Invasion director: a no-op unless kingdom.invasion exists (disabled by default; see docs/INVASION_DIRECTOR.md).
        events.push(...runInvasionDirectorStep(kingdom));
        events.push(...toEvents(runWarStep(kingdom)));
        events.push(...toEvents(runGateControlStep(kingdom)));
        events.push(...toEvents(runEvacuationStep(kingdom)));
        events.push(...runConstructionStep(kingdom));
        events.push(...toEvents(runExpansionStep(kingdom)));
        events.push(...runPolicyStep(kingdom));
        events.push(...toEvents(runPopulationStep(kingdom)));
        events.push(...runTrainingStep(kingdom));
        problems = [...findValidationProblems(kingdom), ...validateGateRecords(kingdom)];
    } catch (error) {
        problems = [`a simulation system threw: ${String(error)}`];
    }
    if (problems.length > 0) {
        restore(kingdom, before);
        return { step: Number(kingdom.step), gameTime: formatGameTime(Number(kingdom.step)), events: [], problems };
    }

    return { step: Number(kingdom.step), gameTime: formatGameTime(Number(kingdom.step)), events, problems };
}

/**
 * Bounded catch-up. `steps` is clamped, so no caller can ask for an unbounded loop.
 *
 * @param {any} kingdom
 * @param {number} steps
 * @param {{ stopOnProblem?: boolean }} options
 * @returns {{ ran: number, skipped: number, events: string[], rejected: { atStep: number, problems: string[] }[], time: string }}
 */
export function advanceKingdom(kingdom, steps, options = {}) {
    const requested = Number.isInteger(steps) ? steps : 0;
    if (steps !== undefined && !Number.isInteger(steps)) {
        throw new Error(`advanceKingdom: steps must be an integer, got ${String(steps)}`);
    }
    const limit = Math.max(0, Math.min(Number(SIM.maxCatchUpSteps), requested));

    const /** @type {string[]} */ events = [];
    const /** @type {{ atStep: number, problems: string[] }[]} */ rejected = [];
    let ran = 0;
    let skipped = 0;

    for (let index = 0; index < limit; index += 1) {
        const result = advanceKingdomStep(kingdom);
        if (result.problems.length > 0) {
            rejected.push({ atStep: result.step, problems: result.problems });
            skipped += 1;
            if (options.stopOnProblem === true) {
                break;
            }
            continue;
        }
        ran += 1;
        events.push(...result.events);
    }

    return {
        ran,
        skipped,
        events,
        rejected,
        time: formatGameTime(Number(kingdom.step)),
    };
}
