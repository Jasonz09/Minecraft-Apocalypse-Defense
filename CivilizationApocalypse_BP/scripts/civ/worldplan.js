import { planDistrictSiteSteps, siteContainmentProblemsSteps } from "./districtplan.js";
import { planCivilizationDetailedSteps } from "./masterplan.js";
import { newOps, runSync } from "./regions.js";
import { exportSiteGroundSteps, siteGroundRegion } from "./siteprofile.js";
import { validatePlanSteps } from "./validatesteps.js";

/**
 * One cooperative pipeline for the whole plan: master plan -> validation -> Hearthgate construction plan ->
 * containment check -> persisted ground. Everything is a generator charged to ONE `ops` meter
 * (civ/regions.js convention), so no stretch between two yields exceeds ~25,000 elementary operations
 * (`ops.maxRun`). Abandoning it midway has no side effects. `planWorld` is the synchronous driver.
 *
 * @typedef {import("./regions.js").Ops} Ops
 * @typedef {{
 *   plan?: import("./masterplan.js").PlanOptions,
 *   site?: { seed?: number, excludeFootprints?: any[], attempts?: number, wallHeight?: number, streetWidth?: number },
 *   siteField?: any | ((plan: any, region: { x0: number, z0: number, x1: number, z1: number }) => any),
 *   seed?: number,
 *   validate?: boolean,
 *   maxWorldAttempts?: number,
 *   ops?: Ops,
 * }} WorldOptions
 */

/**
 * Plan the world.
 *
 * - `field` is the height field the master plan reads (coarse is fine).
 * - `options.siteField` is the full-resolution ground of district 1 (a field, or a function `(plan, region) =>
 *   field` called once the plan exists); by default the same `field` is used.
 * - The master plan is validated by `validatePlanSteps`. A plan that fails validation is replaced by a new one
 *   made with the next derived seed (`seed + 7919 * attempt`, at most `maxWorldAttempts` = 3); the reasons are kept
 *   in `history`.
 *
 * Returns `{ ok, plan, record, ground, problems, notes, history, seed, ops }`. `ok` is true only when the plan
 * validates, the site plan has no problems, nothing leaves its district and the ground was persisted.
 * `problems` always says why when it is false; `plan`/`record`/`ground` are null when their stage never ran.
 *
 * @param {any} field
 * @param {WorldOptions} [options]
 * @returns {Generator<void, { ok: boolean, plan: any, record: any, ground: any, problems: string[], notes: string[], history: string[], seed: number, ops: Ops }, void>}
 */
export function* planWorldSteps(field, options = {}) {
    const ops = options.ops ?? newOps();
    const baseSeed = (options.seed ?? options.plan?.seed ?? field?.seed ?? 1) | 0;
    const attempts = Math.max(1, options.maxWorldAttempts ?? 3);
    /** @type {string[]} */
    const history = [];
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const notes = [];
    let plan = null;
    let seed = baseSeed;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        seed = (baseSeed + 7919 * attempt) | 0;
        const made = yield* planCivilizationDetailedSteps(field, { ...(options.plan ?? {}), seed, ops });
        if (!made.ok || made.plan === null) {
            history.push(`attempt ${String(attempt)} (seed ${String(seed)}): master plan failed: ${made.errors.slice(-2).join(" | ")}`);
            continue;
        }
        if (options.validate === false) {
            plan = made.plan;
            break;
        }
        const verdict = yield* validatePlanSteps(made.plan, { ops });
        if (verdict.ok) {
            plan = made.plan;
            break;
        }
        history.push(`attempt ${String(attempt)} (seed ${String(seed)}): the master plan does not validate: ${verdict.problems.slice(0, 3).join(" | ")}`);
    }
    if (plan === null) {
        problems.push("no valid master plan was found", ...history);
        return { ok: false, plan: null, record: null, ground: null, problems, notes, history, seed, ops };
    }

    const region = siteGroundRegion(plan, 1);
    const groundField = typeof options.siteField === "function" ? options.siteField(plan, region) : (options.siteField ?? field);
    const siteOptions = { ...(options.site ?? {}), seed: options.site?.seed ?? plan.seed, ops };
    const site = yield* planDistrictSiteSteps(plan, 1, groundField, siteOptions);
    for (const note of site.notes) notes.push(note);
    if (!site.ok || site.record === null) {
        problems.push("the Hearthgate construction plan has problems", ...site.problems.slice(0, 8));
        return { ok: false, plan, record: site.record, ground: null, problems, notes, history, seed, ops };
    }
    const contained = yield* siteContainmentProblemsSteps(plan, 1, site.record, ops);
    if (contained.length > 0) {
        problems.push("a structure would leave its district", ...contained.slice(0, 6));
        return { ok: false, plan, record: site.record, ground: null, problems, notes, history, seed, ops };
    }
    const ground = yield* exportSiteGroundSteps(groundField, region, ops);
    return { ok: true, plan, record: site.record, ground, problems, notes, history, seed, ops };
}

/**
 * Synchronous driver of planWorldSteps (one implementation).
 * @param {any} field
 * @param {WorldOptions} [options]
 */
export function planWorld(field, options = {}) {
    return runSync(planWorldSteps(field, options));
}
