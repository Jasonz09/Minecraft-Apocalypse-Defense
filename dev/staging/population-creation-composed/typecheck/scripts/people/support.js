import { nextChance } from "../sim/rng.js";

/**
 * Support units: iron golems and trained wolves that fight alongside a district's garrison.
 *
 * Pure. This module produces numbers only: caps, a spawn budget, what the support engages and
 * what it loses. It spawns nothing, edits no record and reads no world. The caller applies the
 * budget with `spendSupport` and carries the new `support` record forward itself.
 *
 * Capacity comes from buildings that already exist. No new building is needed:
 *   golem cap per district = barracks * golemCapPerBarracks   (default 1 per barracks)
 *   wolf cap per district  = barracks * wolfCapPerBarracks    (default 2 per barracks)
 * With the starting five districts (one barracks each) the kingdom can hold at most 5 golems
 * and 10 wolves. A lost district has a cap of zero.
 *
 * Production: at most one unit of each kind per district per step, with a cooldown between
 * units (a golem every `golemCooldownSteps`, a wolf every `wolfCooldownSteps`). A unit costs
 * stores when it is made, so replacing a dead one costs the same again - death frees a cap slot,
 * never a free replacement.
 *
 * Threat response: support engages an assault only when the district has a front garrison. With no
 * garrison the golems and wolves hold nothing and nothing is reported as fighting. Losses are drawn
 * from `rngState`, so the same seed gives the same losses; the advanced cursor is returned.
 *
 * Wolves eat. `wolfFoodPerStep` is what each wolf adds to a district's food demand. The simulation's
 * population.js does not count it yet (see docs/PEOPLE_ROLES.md), so the integrator must add it there.
 */

/** Tunables local to this module. */
export const SUPPORT_RULES = Object.freeze({
    golemCapPerBarracks: 1,
    wolfCapPerBarracks: 2,
    golemCost: Object.freeze({ materials: 30, supplies: 6 }),
    wolfCost: Object.freeze({ supplies: 4, food: 2 }),
    golemCooldownSteps: 24,
    wolfCooldownSteps: 12,
    /** Raiders one golem holds back in a step (ceil of assault / this). */
    golemEngagesAssault: 8,
    /** Raiders one wolf holds back in a step. */
    wolfEngagesAssault: 12,
    /** Garrison-equivalents a golem adds while it stands (a front soldier counts as 1). */
    golemStrength: 4,
    /** Garrison-equivalents a wolf adds while it stands. */
    wolfStrength: 1,
    /** Chance an engaged golem is destroyed in a step. */
    golemLossChance: 0.15,
    /** Chance an engaged wolf is destroyed in a step. */
    wolfLossChance: 0.1,
    /** Food a wolf eats per step. */
    wolfFoodPerStep: 0.03,
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
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
    return Math.round(value * 100) / 100;
}

/**
 * Caps for one district. A lost district holds none.
 * @param {any} district
 * @returns {{ golems: number, wolves: number }}
 */
export function supportCaps(district) {
    if (String(district?.security) === "lost") {
        return { golems: 0, wolves: 0 };
    }
    const barracks = count(district?.buildings?.barracks);
    return {
        golems: barracks * SUPPORT_RULES.golemCapPerBarracks,
        wolves: barracks * SUPPORT_RULES.wolfCapPerBarracks,
    };
}

/**
 * @typedef {{ golems: number, wolves: number, lastGolemStep?: number | null, lastWolfStep?: number | null }} SupportRecord
 */

/**
 * How many units this district may make at this step. Pure: the caller spends the cost.
 *
 * @param {any} district a PeopleDistrict
 * @param {SupportRecord} support the district's current support units and last production steps
 * @param {number} step the simulation step (the game hour)
 * @returns {{
 *   districtId: string, lost: boolean, caps: { golems: number, wolves: number },
 *   golems: number, wolves: number, cost: Record<string, number>,
 *   reasons: string[]
 * }}
 */
export function spawnBudget(district, support, step) {
    if (district === null || typeof district !== "object") {
        throw new Error("spawnBudget: district must be an object");
    }
    const districtId = String(district.id);
    const caps = supportCaps(district);
    const lost = String(district.security) === "lost";
    const have = { golems: count(support?.golems), wolves: count(support?.wolves) };
    /** @type {string[]} */
    const reasons = [];
    /** @type {Record<string, number>} */
    const cost = {};
    if (lost) {
        return { districtId, lost, caps, golems: 0, wolves: 0, cost, reasons: ["district lost: no production"] };
    }

    // Work on a copy of the stores so golems and wolves cannot both spend the same supplies.
    const stock = {
        materials: Math.max(0, Number(district.reserves?.materials ?? 0)),
        supplies: Math.max(0, Number(district.reserves?.supplies ?? 0)),
        food: Math.max(0, Number(district.reserves?.food ?? 0)),
    };
    const afford = (/** @type {Record<string, number>} */ price) =>
        Object.entries(price).every(([key, amount]) => (stock[/** @type {"materials" | "supplies" | "food"} */ (key)] ?? 0) >= amount);
    const pay = (/** @type {Record<string, number>} */ price) => {
        for (const [key, amount] of Object.entries(price)) {
            const field = /** @type {"materials" | "supplies" | "food"} */ (key);
            stock[field] = round2(stock[field] - amount);
            cost[key] = round2((cost[key] ?? 0) + amount);
        }
    };
    const cooled = (/** @type {number | null | undefined} */ last, /** @type {number} */ cooldown) =>
        last === null || last === undefined || step - Number(last) >= cooldown;

    let golems = 0;
    if (have.golems >= caps.golems) {
        reasons.push(`golems at cap (${String(caps.golems)})`);
    } else if (!cooled(support?.lastGolemStep, SUPPORT_RULES.golemCooldownSteps)) {
        reasons.push("golem production cooling down");
    } else if (!afford(SUPPORT_RULES.golemCost)) {
        reasons.push(`golem needs materials ${String(SUPPORT_RULES.golemCost.materials)} and supplies ${String(SUPPORT_RULES.golemCost.supplies)}`);
    } else {
        pay(SUPPORT_RULES.golemCost);
        golems = 1;
    }

    let wolves = 0;
    if (have.wolves >= caps.wolves) {
        reasons.push(`wolves at cap (${String(caps.wolves)})`);
    } else if (!cooled(support?.lastWolfStep, SUPPORT_RULES.wolfCooldownSteps)) {
        reasons.push("wolf training cooling down");
    } else if (!afford(SUPPORT_RULES.wolfCost)) {
        reasons.push(`wolf needs supplies ${String(SUPPORT_RULES.wolfCost.supplies)} and food ${String(SUPPORT_RULES.wolfCost.food)}`);
    } else {
        pay(SUPPORT_RULES.wolfCost);
        wolves = 1;
    }

    return { districtId, lost, caps, golems, wolves, cost, reasons };
}

/**
 * Apply a spend to a store record. Pure: returns new stores and throws rather than go negative.
 *
 * @param {{ materials: number, supplies: number, food: number }} reserves
 * @param {Record<string, number>} cost
 * @returns {{ materials: number, supplies: number, food: number }}
 */
export function spendSupport(reserves, cost) {
    /** @type {Record<string, number>} */
    const next = { materials: Number(reserves.materials), supplies: Number(reserves.supplies), food: Number(reserves.food) };
    for (const [key, amount] of Object.entries(cost)) {
        next[key] = round2(next[key] - amount);
        if (next[key] < 0) {
            throw new Error(`spendSupport: ${key} would go negative (${String(next[key])})`);
        }
    }
    return /** @type {{ materials: number, supplies: number, food: number }} */ (next);
}

/**
 * Support engaging an assault. Pure apart from the explicit cursor.
 *
 * @param {any} district a PeopleDistrict (uses garrison.front, security, assault unless overridden)
 * @param {SupportRecord} support
 * @param {{ assault?: number, rngState: number }} options
 * @returns {{
 *   districtId: string, engaged: { golems: number, wolves: number }, supportStrength: number,
 *   losses: { golems: number, wolves: number }, after: { golems: number, wolves: number },
 *   rngState: number, reason: string | null
 * }}
 */
export function engageSupport(district, support, options) {
    if (district === null || typeof district !== "object") {
        throw new Error("engageSupport: district must be an object");
    }
    const districtId = String(district.id);
    const golems = count(support?.golems);
    const wolves = count(support?.wolves);
    let cursor = Number(options.rngState) >>> 0;
    const assault = count(options.assault ?? district.assault);
    const base = { districtId, engaged: { golems: 0, wolves: 0 }, supportStrength: 0, losses: { golems: 0, wolves: 0 }, after: { golems, wolves } };

    if (String(district.security) === "lost") {
        return { ...base, rngState: cursor, reason: "district lost: support does not fight" };
    }
    if (assault <= 0) {
        return { ...base, rngState: cursor, reason: "no assault" };
    }
    if (count(district.garrison?.front) <= 0) {
        return { ...base, rngState: cursor, reason: "no garrison: golems and wolves do not hold a wall alone" };
    }

    const engagedGolems = Math.min(golems, Math.ceil(assault / SUPPORT_RULES.golemEngagesAssault));
    const engagedWolves = Math.min(wolves, Math.ceil(assault / SUPPORT_RULES.wolfEngagesAssault));
    let golemLosses = 0;
    for (let index = 0; index < engagedGolems; index += 1) {
        const draw = nextChance(cursor, SUPPORT_RULES.golemLossChance);
        cursor = draw.next;
        if (draw.value) {
            golemLosses += 1;
        }
    }
    let wolfLosses = 0;
    for (let index = 0; index < engagedWolves; index += 1) {
        const draw = nextChance(cursor, SUPPORT_RULES.wolfLossChance);
        cursor = draw.next;
        if (draw.value) {
            wolfLosses += 1;
        }
    }
    // Strength counts the units that stood their ground; the ones destroyed this step still fought.
    const supportStrength = engagedGolems * SUPPORT_RULES.golemStrength + engagedWolves * SUPPORT_RULES.wolfStrength;
    return {
        districtId,
        engaged: { golems: engagedGolems, wolves: engagedWolves },
        supportStrength,
        losses: { golems: golemLosses, wolves: wolfLosses },
        after: { golems: golems - golemLosses, wolves: wolves - wolfLosses },
        rngState: cursor >>> 0,
        reason: null,
    };
}

/**
 * Food the district's wolves add to its demand this step.
 * @param {SupportRecord} support
 * @returns {number}
 */
export function wolfFoodDemand(support) {
    return round2(count(support?.wolves) * SUPPORT_RULES.wolfFoodPerStep);
}
