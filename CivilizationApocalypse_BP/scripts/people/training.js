import { POPULATION_DEFAULTS } from "../config.js";
import { EQUIPMENT_TIERS } from "./equipment.js";

/**
 * Trainee progression: recruits in the queue become soldiers at the barracks' pace.
 *
 * Pure. `projectTraining` reproduces the arithmetic of `sim/population.js advanceTraining` as a
 * projection: it returns what the next training step WOULD do and changes nothing. The tests check
 * the projection against the real `advanceTraining` on a copy, over a grid of states, so the two
 * cannot drift apart silently.
 *
 * Rules carried over from the simulation:
 *  - recruits only come out of `trainingQueue`; nothing creates a soldier;
 *  - graduation needs a barracks (`buildings.barracks`), at
 *    `recruitsPerStepPerBarracks` per barracks per step, banked fractionally in `trainingBuffer`;
 *  - the queue never exceeds `trainingQueueCapacity`, and enlistment (population.openRecruitment)
 *    is what limits who may enter it: secure districts only, and never during an emergency.
 *    A trainee already in the queue keeps training - the simulation does not cancel him on alert.
 *
 * Added here, and not in the save:
 *  - readiness: the banked fraction toward the next graduate (0..1);
 *  - stage: `awaiting-barracks`, `drilling` or `idle`;
 *  - the equipment tier a graduate leaves with (equipment.js tier 1, the kit paid at enlistment).
 */

/** Tunables local to this module. */
export const TRAINING_RULES = Object.freeze({
    /** Tier a graduate leaves with: the basic kit already paid for at enlistment. */
    graduateTier: 1,
    /** Mirrors population.js POPULATION_RULES.trainingBufferCap. */
    bufferCap: 1,
});

/**
 * @param {any} value
 * @returns {number}
 */
function count(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

/**
 * @param {any} value
 * @returns {number}
 */
function fraction(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
    return Math.round(value * 10000) / 10000;
}

/**
 * Project one training step for one district. Pure: `district` is not modified.
 *
 * @param {any} district a PeopleDistrict
 * @returns {{
 *   districtId: string, lost: boolean, queue: number, barracks: number, perStep: number,
 *   bufferBefore: number, bufferAfter: number, graduated: number, queueAfter: number,
 *   soldiersBefore: number, soldiersAfter: number, readiness: number,
 *   stage: "awaiting-barracks" | "drilling" | "idle", tier: number | null, reason: string | null
 * }}
 */
export function projectTraining(district) {
    if (district === null || typeof district !== "object") {
        throw new Error("projectTraining: district must be an object");
    }
    const districtId = String(district.id);
    const queue = count(district.trainingQueue);
    const barracks = count(district.buildings?.barracks);
    const soldiers = count(district.soldiers);
    const bufferBefore = fraction(district.trainingBuffer);
    const base = {
        districtId, queue, barracks, perStep: 0, bufferBefore, soldiersBefore: soldiers,
    };

    if (String(district.security) === "lost") {
        return {
            ...base, lost: true, bufferAfter: 0, graduated: 0, queueAfter: 0, soldiersAfter: soldiers,
            readiness: 0, stage: "idle", tier: null, reason: "district lost: no training",
        };
    }
    if (queue <= 0) {
        return {
            ...base, lost: false, bufferAfter: 0, graduated: 0, queueAfter: 0, soldiersAfter: soldiers,
            readiness: 0, stage: "idle", tier: null, reason: "no recruits in the training queue",
        };
    }
    if (barracks <= 0) {
        return {
            ...base, lost: false, bufferAfter: bufferBefore, graduated: 0, queueAfter: queue, soldiersAfter: soldiers,
            readiness: round4(bufferBefore), stage: "awaiting-barracks", tier: null,
            reason: "no barracks - the recruits cannot be trained until a training hall is built",
        };
    }

    const perStep = round4(barracks * Number(POPULATION_DEFAULTS.recruitsPerStepPerBarracks));
    const buffer = bufferBefore + perStep;
    const graduated = Math.max(0, Math.min(queue, Math.floor(buffer)));
    const bufferAfter = round4(Math.min(buffer - graduated, TRAINING_RULES.bufferCap));
    const reason = graduated > 0 ? null : `training ${String(Math.round(buffer * 1000) / 10)}% of the way to the next recruit`;
    return {
        ...base,
        perStep,
        lost: false,
        bufferAfter,
        graduated,
        queueAfter: queue - graduated,
        soldiersAfter: soldiers + graduated,
        readiness: bufferAfter,
        stage: "drilling",
        tier: graduated > 0 ? TRAINING_RULES.graduateTier : null,
        reason,
    };
}

/**
 * The tier table a graduate is issued against, for reports.
 * @returns {Array<{ tier: number, name: string }>}
 */
export function graduateKit() {
    const tier = EQUIPMENT_TIERS.find((entry) => entry.tier === TRAINING_RULES.graduateTier);
    return tier === undefined ? [] : [{ tier: tier.tier, name: tier.name }];
}
