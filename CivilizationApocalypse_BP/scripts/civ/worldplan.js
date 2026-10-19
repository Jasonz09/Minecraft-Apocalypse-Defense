import { planDistrictSiteSteps, siteContainmentProblemsSteps } from "./districtplan.js";
import { planCivilizationDetailedSteps } from "./masterplan.js";
import { newOps, runSync } from "./regions.js";
import { exportSiteGroundSteps, siteGroundRegion } from "./siteprofile.js";
import { validatePlanSteps } from "./validatesteps.js";

/**
 * One cooperative pipeline for the whole plan: master plan -> validation -> ONE district's construction plan ->
 * containment check -> persisted ground. Everything is a generator charged to ONE `ops` meter
 * (civ/regions.js convention), so no stretch between two yields exceeds ~25,000 elementary operations
 * (`ops.maxRun`). Abandoning it midway has no side effects. `planWorld` is the synchronous driver.
 *
 * `options.district` (1..5, default 1) picks which district of the master plan gets a construction plan. The
 * master plan itself is always the whole five-district civilization: districts share one coordinate system, one
 * wall network and one gate registry, so a district must never be planned against a different anchor.
 *
 * @typedef {import("./regions.js").Ops} Ops
 * @typedef {{
 *   plan?: import("./masterplan.js").PlanOptions,
 *   district?: number,
 *   site?: { seed?: number, excludeFootprints?: any[], attempts?: number, wallHeight?: number, streetWidth?: number },
 *   siteField?: any | ((plan: any, region: { x0: number, z0: number, x1: number, z1: number }) => any),
 *   seed?: number,
 *   validate?: boolean,
 *   maxWorldAttempts?: number,
 *   ops?: Ops,
 * }} WorldOptions
 */

/** The civilization's districts are numbered 1..5; anything else is a caller bug, not a retryable failure. */
const DISTRICT_INDEXES = [1, 2, 3, 4, 5];

/**
 * Plan the world.
 *
 * - `field` is the height field the master plan reads (coarse is fine).
 * - `options.siteField` is the full-resolution ground of the district being planned (a field, or a function
 *   `(plan, region) => field` called once the plan exists); by default the same `field` is used.
 * - The master plan is validated by `validatePlanSteps`. A plan that fails validation is replaced by a new one
 *   made with the next derived seed (`seed + 7919 * attempt`, at most `maxWorldAttempts` = 3); the reasons are kept
 *   in `history`.
 *
 * Returns `{ ok, plan, record, ground, problems, notes, history, seed, ops, district }`. `ok` is true only when the
 * plan validates, the site plan has no problems, nothing leaves its district and the ground was persisted.
 * `problems` always says why when it is false; `plan`/`record`/`ground` are null when their stage never ran.
 *
 * @param {any} field
 * @param {WorldOptions} [options]
 * @returns {Generator<void, { ok: boolean, plan: any, record: any, ground: any, problems: string[], notes: string[], history: string[], seed: number, ops: Ops, district: number }, void>}
 */
export function* planWorldSteps(field, options = {}) {
    const ops = options.ops ?? newOps();
    const district = options.district ?? 1;
    if (!DISTRICT_INDEXES.includes(district)) {
        return {
            ok: false,
            plan: null,
            record: null,
            ground: null,
            problems: [`planWorldSteps: district must be 1..5, got ${String(district)}`],
            notes: [],
            history: [],
            seed: (options.seed ?? 1) | 0,
            ops,
            district,
        };
    }
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
        return { ok: false, plan: null, record: null, ground: null, problems, notes, history, seed, ops, district };
    }

    const label = /** @type {any[]} */ (plan.districts ?? []).find((entry) => entry.index === district)?.id ?? `district ${String(district)}`;
    const region = siteGroundRegion(plan, district);
    const groundField = typeof options.siteField === "function" ? options.siteField(plan, region) : (options.siteField ?? field);
    const siteOptions = { ...(options.site ?? {}), seed: options.site?.seed ?? plan.seed, ops };
    const site = yield* planDistrictSiteSteps(plan, district, groundField, siteOptions);
    for (const note of site.notes) notes.push(note);
    if (!site.ok || site.record === null) {
        problems.push(`the ${label} construction plan has problems`, ...site.problems.slice(0, 8));
        return { ok: false, plan, record: site.record, ground: null, problems, notes, history, seed, ops, district };
    }
    const contained = yield* siteContainmentProblemsSteps(plan, district, site.record, ops);
    if (contained.length > 0) {
        problems.push("a structure would leave its district", ...contained.slice(0, 6));
        return { ok: false, plan, record: site.record, ground: null, problems, notes, history, seed, ops, district };
    }
    const ground = yield* exportSiteGroundSteps(groundField, region, ops);
    return { ok: true, plan, record: site.record, ground, problems, notes, history, seed, ops, district };
}

/**
 * Synchronous driver of planWorldSteps (one implementation).
 * @param {any} field
 * @param {WorldOptions} [options]
 */
export function planWorld(field, options = {}) {
    return runSync(planWorldSteps(field, options));
}
