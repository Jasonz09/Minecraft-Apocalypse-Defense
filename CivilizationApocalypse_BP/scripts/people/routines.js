import { hourOf } from "../sim/clock.js";
import { ROLES } from "./occupations.js";

/**
 * Daily routines: where a civilian should be at a given game hour.
 *
 * Pure. The clock is `sim/clock.js` - one simulation step is one in-game hour, and `hourOf(step)`
 * is the only notion of time used here. The same step always gives the same answer.
 *
 * Every hour of the day resolves to exactly one location class, decided by a fixed priority:
 *   1. a `lost` district has no routine at all (`location: null`; nothing happens there);
 *   2. guards hold the wall from the barracks at every hour;
 *   3. under threat every other civilian takes shelter, including through the night;
 *   4. night (sleep) at home;
 *   5. meals at fixed hours - children, elders and breakfast/supper at home, the noon meal
 *      for working adults at the market;
 *   6. working hours at the workplace: farmers at the farm, builders, smiths and workers at
 *      `work`, idle adults at the market;
 *   7. otherwise evening rest at home.
 */

/** Location classes a civilian can be assigned to. */
export const LOCATIONS = Object.freeze(["home", "work", "farm", "market", "barracks", "shelter"]);

/** Hours are whole numbers 0..23, inclusive bounds. The sleep window wraps midnight. */
export const ROUTINE_RULES = Object.freeze({
    sleepFromHour: 22,
    sleepUntilHour: 5,
    breakfastHour: 7,
    noonMealHour: 12,
    supperHour: 18,
    workFromHour: 8,
    workUntilHour: 16,
    /** Security levels in which civilians take shelter instead of keeping their routine. */
    threatSecurity: Object.freeze(["contested", "breached", "isolated"]),
});

/**
 * @param {number} hour 0..23
 * @returns {boolean}
 */
export function isSleepHour(hour) {
    return hour >= ROUTINE_RULES.sleepFromHour || hour <= ROUTINE_RULES.sleepUntilHour;
}

/**
 * @param {{ step: number, role: string, security?: string }} input
 * @returns {{ hour: number, location: string | null, activity: string, reason: string }}
 */
export function locationAt(input) {
    if (input === null || typeof input !== "object") {
        throw new Error("locationAt: input must be an object with step, role and security");
    }
    const step = Number(input.step);
    if (!Number.isInteger(step) || step < 0) {
        throw new Error(`locationAt: step must be a non-negative whole number, got ${String(input.step)}`);
    }
    const role = String(input.role);
    if (!ROLES.includes(role)) {
        throw new Error(`locationAt: unknown role '${role}' (valid: ${ROLES.join(", ")})`);
    }
    const security = String(input.security ?? "secure");
    const hour = hourOf(step);
    const at = (/** @type {string | null} */ location, /** @type {string} */ activity, /** @type {string} */ reason) =>
        ({ hour, location, activity, reason });

    if (security === "lost") {
        return at(null, "none", "district lost: no routine");
    }
    if (role === "guard") {
        return at("barracks", "watch", "guards hold the wall from the barracks");
    }
    if (ROUTINE_RULES.threatSecurity.includes(security)) {
        return at("shelter", "shelter", `${security}: civilians take shelter`);
    }
    if (isSleepHour(hour)) {
        return at("home", "sleep", "night: sleep at home");
    }
    const dependant = role === "child" || role === "elder";
    if (hour === ROUTINE_RULES.noonMealHour) {
        return dependant ? at("home", "eat", "noon meal at home") : at("market", "eat", "noon meal at the market");
    }
    if (hour === ROUTINE_RULES.breakfastHour || hour === ROUTINE_RULES.supperHour) {
        return at("home", "eat", "meal at home");
    }
    if (dependant) {
        return at("home", "rest", "children and elders stay home by day");
    }
    if (hour >= ROUTINE_RULES.workFromHour && hour <= ROUTINE_RULES.workUntilHour) {
        if (role === "farmer") {
            return at("farm", "work", "working hours: tending the farm");
        }
        if (role === "none") {
            return at("market", "idle", "working hours: no post, at the market");
        }
        return at("work", "work", "working hours: at the workplace");
    }
    return at("home", "rest", "evening rest at home");
}

/**
 * A full 24-hour schedule for one role in one security state.
 *
 * @param {string} role
 * @param {string} [security]
 * @returns {Array<{ hour: number, location: string | null, activity: string, reason: string }>}
 */
export function dailySchedule(role, security = "secure") {
    const day = [];
    for (let hour = 0; hour < 24; hour += 1) {
        day.push(locationAt({ step: hour, role, security }));
    }
    return day;
}

/**
 * How many hours of the day a role spends in each location class.
 *
 * @param {string} role
 * @param {string} [security]
 * @returns {Record<string, number>}
 */
export function hoursPerLocation(role, security = "secure") {
    /** @type {Record<string, number>} */
    const totals = {};
    for (const location of LOCATIONS) {
        totals[location] = 0;
    }
    for (const entry of dailySchedule(role, security)) {
        if (entry.location !== null) {
            totals[entry.location] += 1;
        }
    }
    return totals;
}
