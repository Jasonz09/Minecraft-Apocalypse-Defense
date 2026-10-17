import { SIM } from "../config.js";

/**
 * Game time. One simulation step is exactly one in-game hour: Minecraft counts
 * 24000 ticks per day and 24 hours per day, so 1000 ticks per step divides evenly.
 * Keeping this in one place means no system invents its own notion of a "day".
 */

export const STEPS_PER_DAY = SIM.stepsPerDay;

/**
 * @param {number} step
 */
export function dayOf(step) {
    return Math.floor(step / STEPS_PER_DAY);
}

/**
 * @param {number} step
 */
export function hourOf(step) {
    return ((step % STEPS_PER_DAY) + STEPS_PER_DAY) % STEPS_PER_DAY;
}

/**
 * @param {number} step
 */
export function toTicks(step) {
    return step * SIM.stepTicks;
}

/**
 * Ticks elapsed since a reference step, clamped so a long offline gap can never turn
 * into an unbounded catch-up loop.
 *
 * @param {number} elapsedTicks
 * @param {number} limit maximum steps to hand back
 */
export function stepsFromTicks(elapsedTicks, limit = SIM.maxCatchUpSteps) {
    if (!Number.isFinite(elapsedTicks) || elapsedTicks <= 0) {
        return 0;
    }
    return Math.min(limit, Math.floor(elapsedTicks / SIM.stepTicks));
}

/**
 * @param {number} step
 */
export function formatGameTime(step) {
    const hours = String(hourOf(step)).padStart(2, "0");
    return `Day ${String(dayOf(step) + 1)}, ${hours}:00`;
}
