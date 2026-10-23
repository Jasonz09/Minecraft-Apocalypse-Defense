import { farmFoodOutput, foodDemand } from "../sim/population.js";
import { stockpileCeiling } from "../sim/policies.js";

/**
 * Haul jobs: the visible carrying work behind food, planned from real records.
 *
 * Pure. A haul job is a PLAN. It says which carrier moves how much food from where to where.
 * It never creates food: the amounts it moves are taken from farm output that the simulation
 * already produces, and from food already in the district's reserves. The simulation's own
 * accounting (population.js `runPopulationStep`) is unchanged by anything here.
 *
 * Ledger, per district, for one step (all food):
 *   field      nominal farm output this step (population.farmFoodOutput, before the yield jitter)
 *   store      district.reserves.food (the storehouses' stock)
 *   delivered  food carried from the store to the district's consumers
 * Each job moves food between these pools and nowhere else, so `field + store + delivered` is
 * the same before and after the plan. Food the carriers do not reach stays in the field, where
 * the simulation absorbs it exactly as it does today.
 *
 * Caps: at most `maxJobsPerDistrictPerStep` jobs per district per step, each carrying at most
 * `carryPerJob` food. The plan can never move more than `maxJobs * carryPerJob` food.
 */

/** Tunables local to this module. */
export const TRANSPORT_RULES = Object.freeze({
    /** Haul jobs one district may plan in a single step. */
    maxJobsPerDistrictPerStep: 8,
    /** Food one carrier moves in one job (one cart load). */
    carryPerJob: 2,
});

/**
 * @param {any} value
 * @returns {number}
 */
function num(value) {
    const out = Number(value);
    return Number.isFinite(out) && out > 0 ? out : 0;
}

/**
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
    return Math.round(value * 100) / 100;
}

/**
 * @typedef {{ id: string, kind: "farm-to-storehouse" | "storehouse-to-consumer", resource: "food", amount: number, from: string, to: string }} HaulJob
 */

/**
 * Plan the haul jobs for one district for one step. Reads the record, changes nothing.
 *
 * @param {any} district a PeopleDistrict (see occupations.js for the shape)
 * @param {{ maxJobs?: number, carry?: number }} [options]
 * @returns {{
 *   districtId: string, lost: boolean, reason: string | null,
 *   nominal: { farmOutput: number, demand: number, storeCeiling: number },
 *   ledger: { before: { field: number, store: number, delivered: number }, after: { field: number, store: number, delivered: number } },
 *   jobs: HaulJob[], capped: boolean, cap: { maxJobs: number, carryPerJob: number, maxFoodMoved: number }
 * }}
 */
export function planHaulJobs(district, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("planHaulJobs: district must be an object");
    }
    const districtId = String(district.id);
    const maxJobs = Math.max(0, Math.min(TRANSPORT_RULES.maxJobsPerDistrictPerStep, Math.floor(Number(options.maxJobs ?? TRANSPORT_RULES.maxJobsPerDistrictPerStep))));
    const carry = Math.max(0.01, Math.min(TRANSPORT_RULES.carryPerJob, Number(options.carry ?? TRANSPORT_RULES.carryPerJob)));
    const cap = { maxJobs, carryPerJob: carry, maxFoodMoved: round2(maxJobs * carry) };

    const farmOutput = round2(farmFoodOutput(district));
    const demand = round2(foodDemand(district));
    const storeCeiling = stockpileCeiling(district);
    const storeBefore = round2(num(district.reserves?.food));
    const storehouses = num(district.buildings?.storehouses);

    if (String(district.security) === "lost") {
        const empty = { field: 0, store: 0, delivered: 0 };
        return {
            districtId, lost: true, reason: "district lost: no haul jobs",
            nominal: { farmOutput: 0, demand: 0, storeCeiling: 0 },
            ledger: { before: empty, after: empty }, jobs: [], capped: false, cap,
        };
    }

    /** @type {HaulJob[]} */
    const jobs = [];
    let field = farmOutput;
    let store = storeBefore;
    let room = Math.max(0, storeCeiling - store);
    let need = demand;
    let capped = false;

    /** @returns {string} */
    const nextId = () => `${districtId}:haul-${String(jobs.length + 1)}`;

    // Stage 1: farm -> storehouse. Only with a storehouse; otherwise the produce is eaten where it grows.
    if (storehouses > 0) {
        while (field > 0.005 && room > 0.005) {
            if (jobs.length >= maxJobs) {
                capped = true;
                break;
            }
            const amount = round2(Math.min(carry, field, room));
            jobs.push({ id: nextId(), kind: "farm-to-storehouse", resource: "food", amount, from: `farms:${districtId}`, to: `storehouse:${districtId}` });
            field = round2(field - amount);
            store = round2(store + amount);
            room = round2(room - amount);
        }
    }

    // Stage 2: storehouse -> consumers, from whatever is now in store, up to what people need today.
    while (need > 0.005 && store > 0.005) {
        if (jobs.length >= maxJobs) {
            capped = true;
            break;
        }
        const amount = round2(Math.min(carry, store, need));
        jobs.push({ id: nextId(), kind: "storehouse-to-consumer", resource: "food", amount, from: `storehouse:${districtId}`, to: `consumers:${districtId}` });
        store = round2(store - amount);
        need = round2(need - amount);
    }

    const after = applyHaulPlan({ field: farmOutput, store: storeBefore, delivered: 0 }, jobs);
    return {
        districtId,
        lost: false,
        reason: storehouses > 0 ? null : "no storehouse: produce is used where it grows",
        nominal: { farmOutput, demand, storeCeiling },
        ledger: { before: { field: farmOutput, store: storeBefore, delivered: 0 }, after },
        jobs,
        capped,
        cap,
    };
}

/**
 * Apply a plan's jobs to a ledger in order. Pure: returns a new ledger.
 * Throws if any pool would go negative, so an impossible plan is reported rather than hidden.
 *
 * @param {{ field: number, store: number, delivered: number }} ledger
 * @param {HaulJob[]} jobs
 * @returns {{ field: number, store: number, delivered: number }}
 */
export function applyHaulPlan(ledger, jobs) {
    let field = round2(Number(ledger.field));
    let store = round2(Number(ledger.store));
    let delivered = round2(Number(ledger.delivered));
    for (const job of jobs) {
        const amount = round2(Number(job.amount));
        if (!(amount > 0)) {
            throw new Error(`applyHaulPlan: job ${String(job.id)} carries ${String(job.amount)}`);
        }
        if (job.kind === "farm-to-storehouse") {
            field = round2(field - amount);
            store = round2(store + amount);
        } else if (job.kind === "storehouse-to-consumer") {
            store = round2(store - amount);
            delivered = round2(delivered + amount);
        } else {
            throw new Error(`applyHaulPlan: unknown job kind '${String(job.kind)}'`);
        }
        if (field < 0 || store < 0) {
            throw new Error(`applyHaulPlan: job ${String(job.id)} would take a pool negative (field ${String(field)}, store ${String(store)})`);
        }
    }
    return { field, store, delivered };
}

/**
 * The conservation check the tests rely on: the ledger total must not change.
 *
 * @param {ReturnType<typeof planHaulJobs>} plan
 * @returns {{ before: number, after: number, delta: number }}
 */
export function haulConservation(plan) {
    const before = round2(plan.ledger.before.field + plan.ledger.before.store + plan.ledger.before.delivered);
    const after = round2(plan.ledger.after.field + plan.ledger.after.store + plan.ledger.after.delivered);
    return { before, after, delta: round2(after - before) };
}
