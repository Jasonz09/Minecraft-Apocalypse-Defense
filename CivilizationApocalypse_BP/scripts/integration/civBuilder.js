import { BlockPermutation, world } from "@minecraft/server";
import { PHYSICAL } from "../config.js";
import { CIV_LIMITS } from "../civ/budget.js";
import { SITE_PLAN_VERSION, planDistrictSiteSteps, rehydrateSiteSteps, siteContainmentProblemsSteps, siteJobSpecs, siteOpCount, siteOpsFor, siteOptionsOf } from "../civ/districtplan.js";
import * as jobs from "../civ/jobs.js";
import { planCivilizationDetailedSteps } from "../civ/masterplan.js";
import { markYield, newOps } from "../civ/regions.js";
import { normalizeOp } from "../civ/opnorm.js";
import { PLAN_VERSION, createPlanStore, utf8Length } from "../civ/planstore.js";
import { clipField, exportSiteGroundSteps, siteGroundBytes, siteGroundRegion } from "../civ/siteprofile.js";
import { SITE_DEFAULTS, overlapsExclusion, rankSites, scanRadiusFor } from "../civ/siteselect.js";
import { validatePlanSteps } from "../civ/validatesteps.js";
import { classifyTerrainCell, isLeaves, isLog, isNaturalGround, isPlant, isTreePart } from "../structures/terrain.js";
import { activeToken, cancelActiveJob, finishJob } from "./districtBuilder.js";
import { CIV_TICKING_ID, holdArea, nextTick, releaseArea, runJobAsync, scanCoarse, scanFull } from "./civScan.js";

/**
 * Bedrock boundary for the one-command civilization workflow, WRITE side, plus the planning
 * pipeline that precedes it.
 *
 * Contract (nothing below ever happens at import or activation):
 *  - planWorld(): scan -> rank -> master plan -> validate -> full-resolution ground -> district
 *    site plan. It is READ-ONLY. Every failure returns a report; no failure path has written a block.
 *  - persistRun(): plan + ground + job queue + district.civ record are saved BEFORE the first block.
 *  - startConstruction(): the only code that writes blocks. Every op is classified against the LIVE
 *    block immediately before it is written; anything that is not air, loose vegetation, natural
 *    ground (or, for explicit support kinds, still water) or a block this very plan placed at that
 *    cell is skipped and counted - never overwritten. Natural trees are cleared only after the whole
 *    tree has been proven natural; a tree with persistent leaves, a log-only stack or a foreign block
 *    touching it is left alone.
 *  - slices: <= CIV_LIMITS.maxBlocksPerSlice ops and <= CIV_LIMITS.maxReadsPerSlice reads between yields.
 */

/**
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {{ kind: string, jobId: number | undefined, cancelled: boolean }} Job
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 * @typedef {import("../civ/opnorm.js").CanonicalOp} CanonicalOp
 * @typedef {import("../civ/jobs.js").JobQueue} JobQueue
 */

/**
 * Replaceable collaborators. Production code never touches this; tests substitute members to force the failure paths
 * (an invalid master plan, an over-sized plan) without a contrived world.
 */
export const seams = {
    /** @type {(plan: any, ops: import("../civ/regions.js").Ops) => Generator<void, { ok: boolean, problems: string[], metrics?: any }, void>} */
    validatePlan: (plan, ops) => validatePlanSteps(plan, { ops }),
    /** @type {number | undefined} */
    maxPlanBytes: undefined,
    /** @type {number | undefined} */
    maxJobBytes: undefined,
    /** @type {((outcome: any) => void) | undefined} */
    onOutcome: undefined,
};

/** Plan area radius handed to the master planner (its own default). */
export const MASTER_PLAN_RADIUS = 300;
/** Re-seeded planning attempts (master plan -> ground -> site plan) before giving up. */
const WORLD_ATTEMPTS = 3;
/** Extra clearance (blocks) around every protected footprint for the site search. */
export const PROTECT_MARGIN = 12;
/** Sanity ceiling for the op count of one district. */
export const MAX_SANE_OPS = 400000;
/** Largest bounding box (blocks per side) of one construction window; the held tile is 128. */
const WINDOW_MAX_SPAN = 100;
const HOLD_SIZE = 128;
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 319;

/** Largest tree-like component the clearer will examine (forests merge canopies; player-made stacks are caught by their own rules). */
const CIV_TREE_CAP = 600;
/** Chebyshev radius around the blocked cell within which a tree is examined and cleared (forests merge canopies; the remainder decays by itself). */
const CIV_TREE_RADIUS = 8;

/** Kinds that may stand in / replace still water (bridge supports and foundations). */
const WATER_KINDS = new Set(["support", "footing", "fill"]);
const AIR_IDS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

// ---------------------------------------------------------------------------------------------
// Pure helpers

/** @param {string} id */
const isAir = (id) => AIR_IDS.has(id);
/** @param {string} id */
const isWater = (id) => id === "minecraft:water" || id === "minecraft:flowing_water";
/** @param {string} id */
const isCanopy = (id) => isLog(id) || isLeaves(id);

/**
 * Decide what to do with one op given the LIVE block and the ids this plan targets at the same cell.
 *
 * @param {CanonicalOp} op
 * @param {string | undefined} existingId live block type (undefined = chunk not loaded)
 * @param {{ final: string | undefined, nonAir: readonly string[], earlier?: readonly string[] }} planned what this plan places at this very cell: the FINAL (last-writer) id, every non-air id, and the ids its own sequence places BEFORE this op
 * @returns {{ action: "place" | "built" | "skip" | "unloaded" | "tree", reason?: string }}
 */
export function classifyCivOp(op, existingId, planned = { final: undefined, nonAir: [], earlier: [] }) {
    if (existingId === undefined) {
        return { action: "unloaded" };
    }
    if (op.kind === "note") {
        return { action: "skip", reason: "note" };
    }
    if (existingId === op.id || (isAir(existingId) && isAir(op.id))) {
        return { action: "built" };
    }
    if (isCanopy(existingId)) {
        return { action: "tree" };
    }
    if (op.kind === "clear") {
        const verdict = classifyTerrainCell({ kind: "clear", existingId, targetId: op.id });
        return verdict.ok ? (verdict.built ? { action: "built" } : { action: "place" }) : { action: "skip", reason: String(verdict.reason) };
    }
    const natural = isNaturalGround(existingId) || isPlant(existingId);
    // A block the plan itself placed earlier in this cell's own sequence is ours (stairs, then a road over them).
    if (planned.earlier?.includes(existingId) === true) {
        return { action: "place" };
    }
    // An air / cut op never removes a block whose id the plan itself places here (a player's chest where the plan has a chest).
    if (isAir(op.id) && !natural && planned.nonAir.includes(existingId)) {
        return { action: "skip", reason: `${existingId} is protected from removal` };
    }
    // A block counts as ours only when it is the FINAL planned id of this cell (replay of an earlier op converges).
    if (planned.final !== undefined && existingId === planned.final) {
        return { action: "place" };
    }
    if (op.kind === "cut" || op.kind === "fill" || op.kind === "top") {
        const verdict = classifyTerrainCell({ kind: op.kind, existingId, targetId: op.id });
        if (verdict.ok) {
            return verdict.built ? { action: "built" } : { action: "place" };
        }
        if (op.kind === "fill" && isWater(existingId)) {
            return { action: "place" };
        }
        return { action: "skip", reason: String(verdict.reason) };
    }
    if (isAir(existingId) || isPlant(existingId) || isNaturalGround(existingId)) {
        return { action: "place" };
    }
    if (isWater(existingId) && WATER_KINDS.has(op.kind)) {
        return { action: "place" };
    }
    return { action: "skip", reason: `occupied by ${existingId}` };
}

/**
 * Group a skip reason so counts stay readable ("occupied by minecraft:oak_planks").
 * @param {string} reason
 */
function reasonKey(reason) {
    return reason.replace(/\(.*?\)/g, "").replace(/-?\d+/g, "#").slice(0, 80);
}

/**
 * @param {Rect} rect @param {number} x @param {number} z
 */
const inRect = (rect, x, z) => x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;

// ---------------------------------------------------------------------------------------------
// Planning (read-only)

/**
 * @typedef {{
 *   token: Job, dimension: Dimension, anchor: { x: number, z: number }, radius: number, seed: number,
 *   exclusions: Rect[], say: (lines: string[]) => void, maxPlanBytes?: number
 * }} PlanContext
 * @typedef {{
 *   ok: boolean, cancelled?: boolean, stage: string, reasons: string[],
 *   site?: any, plan?: any, record?: any, ground?: any, region?: Rect, payload?: any,
 *   stats: Record<string, any>
 * }} PlanOutcome
 */

/**
 * Scan, rank, plan, validate and plan the first district's construction. READ-ONLY.
 * @param {PlanContext} ctx
 * @returns {Promise<PlanOutcome>}
 */
export async function planWorld(ctx) {
    /** @type {PlanOutcome} */
    const out = { ok: false, stage: "scan", reasons: [], stats: { blocksWritten: 0 } };
    const { token } = ctx;
    /** @param {string} stage @param {string[]} reasons */
    const fail = (stage, reasons) => {
        out.stage = stage;
        out.reasons = reasons;
        return out;
    };

    // (a) coarse nearest-first survey
    // The master plan reaches MASTER_PLAN_RADIUS from the site centre, beyond the 480-block analysis window: keep that much clear.
    const clearance = Math.max(SITE_DEFAULTS.exclusionMargin, PROTECT_MARGIN, MASTER_PLAN_RADIUS - SITE_DEFAULTS.windowSize / 2 + 24);
    const rankOptions = { searchRadius: ctx.radius, exclusions: ctx.exclusions, exclusionMargin: clearance };
    const scanRadius = Math.max(scanRadiusFor(rankOptions), ctx.radius + MASTER_PLAN_RADIUS + 16);
    ctx.say([`[1/6] Surveying the terrain within ${String(scanRadius)} blocks of you (read-only, every ${String(SITE_DEFAULTS.step)}th column)...`]);
    let lastTile = 0;
    const coarse = await scanCoarse(token, ctx.dimension, ctx.anchor, scanRadius, SITE_DEFAULTS.step, {
        onTile(done, total) {
            if (done - lastTile >= Math.max(1, Math.floor(total / 4)) && done < total) {
                lastTile = done;
                ctx.say([`      survey ${String(Math.floor((done * 100) / total))}%`]);
            }
        },
    });
    out.stats.coarse = coarse.stats;
    if (coarse.cancelled) {
        out.cancelled = true;
        return fail("cancelled", ["cancelled"]);
    }
    if (coarse.field.columnsRead === 0) {
        return fail("scan", ["no terrain could be read around you (every column was unloaded)"]);
    }

    // (b) rank sites away from every protected footprint
    ctx.say([`[2/6] Ranking sites (${String(coarse.field.columnsRead)} columns read, ${String(coarse.stats.unloaded)} unloaded)...`]);
    const ranking = rankSites(coarse.field, ctx.anchor, rankOptions);
    out.stats.ranking = { evaluated: ranking.evaluated, reads: ranking.reads };
    if (ranking.site === null) {
        return fail("site", ranking.reasons.slice(0, 8));
    }
    out.site = ranking.site;

    // (c)-(f) master plan, validation, full-resolution ground, district plan: every heavy step is a budgeted generator
    // charged to ONE operation meter (no stretch between yields may exceed ~25,000 elementary operations).
    const ops = newOps();
    out.stats.ops = ops;
    /** @type {string[]} */
    const history = [];
    out.stats.history = history;
    for (let attempt = 0; attempt < WORLD_ATTEMPTS; attempt += 1) {
        const planSeed = (ctx.seed + 7919 * attempt) | 0;
        ctx.say([`[3/6] Site found ${String(Math.round(ranking.site.distance))} blocks away; planning five districts${attempt > 0 ? ` (retry ${String(attempt)}, seed ${String(planSeed)})` : ""}...`]);
        const made = await runJobAsync(token, planMasterSteps(coarse.field, { seed: planSeed, anchor: { x: ranking.site.x, z: ranking.site.z }, radius: MASTER_PLAN_RADIUS, ops }));
        if (token.cancelled || made === undefined) {
            out.cancelled = true;
            return fail("cancelled", ["cancelled"]);
        }
        if (!made.ok) {
            history.push(`attempt ${String(attempt)}: ${made.stage}: ${made.problems.slice(0, 3).join(" | ")}`);
            out.stage = made.stage;
            out.reasons = made.problems;
            continue;
        }
        const plan = made.plan;
        let overlap = "";
        for (const district of /** @type {any[]} */ (plan.districts)) {
            const polygon = /** @type {[number, number][]} */ (district.outline);
            if (ctx.exclusions.some((rect) => overlapsExclusion(rect, [{ polygon }], 0))) {
                overlap = `district ${String(district.index)} (${String(district.name)}) would overlap an existing physical district; refusing`;
                break;
            }
        }
        if (overlap !== "") {
            history.push(`attempt ${String(attempt)}: ${overlap}`);
            out.stage = "exclusion";
            out.reasons = [overlap];
            continue;
        }
        out.plan = plan;

        const region = siteGroundRegion(plan, 1);
        out.region = region;
        const columns = (region.x1 - region.x0 + 1) * (region.z1 - region.z0 + 1);
        ctx.say([`[4/6] Reading district 1 at full resolution (${String(columns)} columns)...`]);
        let lastTile = 0;
        const fine = await scanFull(token, ctx.dimension, region, {
            onTile(done, total) {
                if (done - lastTile >= Math.max(1, Math.floor(total / 4)) && done < total) {
                    lastTile = done;
                    ctx.say([`      ground ${String(Math.floor((done * 100) / total))}%`]);
                }
            },
        });
        out.stats.fine = fine.stats;
        if (fine.cancelled) {
            out.cancelled = true;
            return fail("cancelled", ["cancelled"]);
        }
        if (fine.stats.unloaded > 0) {
            return fail("unloaded", [`${String(fine.stats.unloaded)} column(s) of district 1 could not be read (chunks not loaded); nothing was guessed and nothing was changed`]);
        }

        ctx.say(["[5/6] Planning walls, gates, roads and buildings..."]);
        const clipped = clipField(fine.field, region);
        const done = await runJobAsync(token, planSiteSteps(plan, clipped, region, fine.field, { seed: planSeed, excludeFootprints: ctx.exclusions, ops }));
        if (token.cancelled || done === undefined) {
            out.cancelled = true;
            return fail("cancelled", ["cancelled"]);
        }
        if (!done.ok) {
            history.push(`attempt ${String(attempt)}: ${done.stage}: ${done.problems.slice(0, 3).join(" | ")}`);
            out.stage = done.stage;
            out.reasons = done.problems;
            continue;
        }
        const record = done.record;
        const opCount = siteOpCount(record);
        if (!Number.isInteger(opCount) || opCount <= 0 || opCount > MAX_SANE_OPS) {
            return fail("site-plan", [`implausible operation count ${String(opCount)}`]);
        }
        out.record = record;
        const ground = done.ground;

        ctx.say(["[6/6] Checking the plan fits the world's storage..."]);
        const payload = { version: PLAN_VERSION, plan, ground, siteChecksum: record.checksum, siteOptions: siteOptionsOf(record), seed: ctx.seed, planSeed, anchor: { x: plan.anchor.x, z: plan.anchor.z }, site: { layoutId: record.layoutId, version: SITE_PLAN_VERSION } };
        const maxBytes = ctx.maxPlanBytes ?? seams.maxPlanBytes;
        const planStore = createPlanStore(world, maxBytes === undefined ? {} : { maxBytes });
        const measure = planStore.measurePlan(payload);
        out.stats.storage = { bytes: measure.bytes, chunks: measure.chunks, limit: measure.limit, ground: siteGroundBytes(ground) };
        if (!measure.fits) {
            return fail("too-big", [`the plan needs ${String(measure.bytes)} bytes but only ${String(measure.limit)} may be stored; nothing was changed. Try another seed= or a different place.`]);
        }
        out.ground = ground;
        out.payload = payload;
        out.stats.opsMaxRun = ops.maxRun;
        out.stats.planAttempts = attempt + 1;
        seams.onOutcome?.(out);
        out.ok = true;
        out.stage = "planned";
        out.reasons = [];
        return out;
    }
    out.stats.opsMaxRun = ops.maxRun;
    out.stats.planAttempts = WORLD_ATTEMPTS;
    out.plan = undefined;
    out.reasons = [...out.reasons, `(all ${String(WORLD_ATTEMPTS)} planning attempts failed: ${history.join(" || ").slice(0, 400)})`];
    return out;
}

/**
 * Master plan + independent validation as one generator.
 * @param {any} field @param {{ seed: number, anchor: { x: number, z: number }, radius: number, ops: import("../civ/regions.js").Ops }} options
 * @returns {Generator<void, { ok: true, plan: any } | { ok: false, stage: string, problems: string[] }, void>}
 */
function* planMasterSteps(field, options) {
    const made = yield* planCivilizationDetailedSteps(field, { seed: options.seed, anchor: options.anchor, radius: options.radius, ops: options.ops });
    if (!made.ok || made.plan === null) {
        return { ok: false, stage: "plan", problems: ["civilization planning failed", ...made.errors.slice(-4)] };
    }
    const verdict = yield* seams.validatePlan(made.plan, options.ops);
    if (!verdict.ok) {
        return { ok: false, stage: "validate", problems: ["the master plan failed independent validation", ...verdict.problems.slice(0, 8)] };
    }
    markYield(options.ops);
    return { ok: true, plan: made.plan };
}

/**
 * District 1 construction plan, containment check and ground export as one generator.
 * @param {any} plan @param {any} clipped @param {Rect} region @param {any} rawField
 * @param {{ seed: number, excludeFootprints: Rect[], ops: import("../civ/regions.js").Ops }} options
 * @returns {Generator<void, { ok: true, record: any, ground: any } | { ok: false, stage: string, problems: string[] }, void>}
 */
function* planSiteSteps(plan, clipped, region, rawField, options) {
    const site = yield* planDistrictSiteSteps(plan, 1, clipped, { seed: options.seed, excludeFootprints: options.excludeFootprints, ops: options.ops });
    if (!site.ok || site.record === null || site.problems.length > 0) {
        return { ok: false, stage: "site-plan", problems: ["the district construction plan has problems", ...site.problems.slice(0, 8)] };
    }
    if (clipped.outsideReads() > 0) {
        const first = clipped.firstOutside();
        return { ok: false, stage: "site-plan", problems: [`the planner read ground outside the stored region at ${String(first?.x)},${String(first?.z)}`] };
    }
    const contained = yield* siteContainmentProblemsSteps(plan, 1, site.record, options.ops);
    if (contained.length > 0) {
        return { ok: false, stage: "containment", problems: ["a structure would leave its district", ...contained.slice(0, 6)] };
    }
    const ground = yield* exportSiteGroundSteps(rawField, region, options.ops);
    markYield(options.ops);
    return { ok: true, record: site.record, ground };
}

/**
 * Human numbers for a successful planning outcome (plan-only report and the pre-build summary).
 * @param {PlanOutcome} outcome
 */
export function describePlan(outcome) {
    const plan = outcome.plan;
    const record = outcome.record;
    const ops = siteOpCount(record);
    // Slices measured offline: build windows run about 3x the ideal ops/400 (stage ends, holds, trees); survey and planning
    // slices are the measured ones. One slice per tick is assumed (an ESTIMATE until measured in Minecraft).
    const buildSlices = Math.ceil((ops / CIV_LIMITS.maxBlocksPerSlice) * 3);
    const surveySlices = (outcome.stats.coarse?.slices ?? 0) + (outcome.stats.fine?.slices ?? 0) * (outcome.stats.planAttempts ?? 1);
    const planSlices = outcome.stats.ops?.yields ?? 0;
    const slices = buildSlices + surveySlices + planSlices;
    const ticks = Math.ceil(slices / CIV_LIMITS.slicesPerTick);
    return {
        centre: { x: Math.round(plan.districts[0].centroid.x), z: Math.round(plan.districts[0].centroid.z) },
        hq: plan.districts[0].hq,
        areas: /** @type {number[]} */ (plan.stats.perDistrictArea),
        compactness: /** @type {number[]} */ (plan.stats.compactness),
        bboxFill: /** @type {number[]} */ (plan.stats.bboxFill),
        wallLength: plan.stats.wallLength,
        gateCount: plan.stats.gateCount,
        roadLength: plan.stats.roadLength,
        lots: /** @type {any[]} */ (record.lots).length,
        elements: SITE_STAGE_NAMES.reduce((sum, stage) => sum + /** @type {any[]} */ (record[stage] ?? []).length, 0),
        ops,
        slices,
        minutes: Math.round((ticks / CIV_LIMITS.ticksPerSecond / 60) * 10) / 10,
        stored: outcome.stats.storage,
    };
}

const SITE_STAGE_NAMES = jobs.JOB_STAGES;

// ---------------------------------------------------------------------------------------------
// Persistence

/**
 * Element specs for jobs.createQueue. siteJobSpecs() carries each element's op-content hash as a hex STRING while
 * createQueue folds a NUMBER (`hash % 36**6`); a string would silently become NaN, so fold it here.
 * @param {any} record
 */
export function jobSpecsOf(record) {
    const specs = siteJobSpecs(record);
    for (const list of Object.values(specs)) {
        for (const spec of list) {
            if (typeof spec.hash === "string") {
                spec.hash = parseInt(spec.hash, 16) % 36 ** 6;
            }
            if (!Number.isFinite(spec.hash)) {
                throw new Error("a job element has no usable content hash");
            }
        }
    }
    return specs;
}

/**
 * @typedef {ReturnType<typeof createPlanStore>} PlanStore
 */

/** @returns {{ planStore: PlanStore, jobStore: ReturnType<typeof jobs.createJobStore> }} */
function stores() {
    return { planStore: createPlanStore(world), jobStore: jobs.createJobStore(world) };
}

/**
 * Save plan + ground, job queue (nothing is built yet) and let the caller save the kingdom record.
 * Any failure leaves the world untouched.
 *
 * @param {PlanOutcome} outcome
 * @returns {{ ok: boolean, reason?: string, queue?: JobQueue, saved?: any }}
 */
export function persistRun(outcome) {
    const { planStore } = stores();
    const jobStore = jobs.createJobStore(world, seams.maxJobBytes === undefined ? {} : { maxBytes: seams.maxJobBytes });
    try {
        // Check the queue BEFORE the plan is stored, so an oversize queue can never leave an orphan plan behind.
        const queue = jobs.createQueue(jobSpecsOf(outcome.record), { planHash: outcome.record.checksum, maxAttempts: 8 });
        const queueBytes = utf8Length(jobs.serializeQueue(queue));
        const queueLimit = seams.maxJobBytes ?? CIV_LIMITS.maxJobBytes;
        if (queueBytes > queueLimit) {
            return { ok: false, reason: `the job queue would need ${String(queueBytes)} bytes but only ${String(queueLimit)} may be stored; nothing was stored` };
        }
        const saved = planStore.savePlan(outcome.payload);
        if (!saved.ok) {
            return { ok: false, reason: `could not store the plan (${String(saved.reason ?? saved.status)})` };
        }
        const queued = jobStore.saveQueue(queue);
        if (!queued.ok) {
            try {
                planStore.clear();
            } catch (_error) {
                // best effort: the plan without a record is harmless
            }
            return { ok: false, reason: `could not store the job queue (${String(queued.reason ?? queued.status)})` };
        }
        return { ok: true, queue, saved };
    } catch (error) {
        return { ok: false, reason: `storage failed: ${String(error)}` };
    }
}

/**
 * Reload everything from the stores only (restart recovery) and verify it.
 * Heavy work (rebuilding the plan from the stored ground) runs as budgeted steps charged to `ops`.
 * @param {{ checksum?: string, seed?: number }} civ the district.civ record
 * @param {import("../civ/regions.js").Ops} ops
 * @returns {Generator<void, { ok: true, plan: any, record: any, queue: JobQueue, region: Rect, payload: any, recovered: number } | { ok: false, reasons: string[] }, void>}
 */
export function* loadSavedRunSteps(civ, ops) {
    const { planStore, jobStore } = stores();
    const loadedPlan = planStore.loadPlan();
    if (loadedPlan.status !== "ok" || loadedPlan.plan === undefined) {
        return { ok: false, reasons: [`the stored plan is ${loadedPlan.status}${loadedPlan.reason ? ` (${loadedPlan.reason})` : ""}; refusing to continue`] };
    }
    const payload = loadedPlan.plan;
    if (payload?.site?.version !== SITE_PLAN_VERSION) {
        return { ok: false, reasons: [`the stored plan is site version ${String(payload?.site?.version)}, this build understands ${String(SITE_PLAN_VERSION)}; refusing to continue`] };
    }
    if (typeof civ.checksum !== "string" || payload.siteChecksum !== civ.checksum) {
        return { ok: false, reasons: [`the stored plan (${String(payload.siteChecksum)}) is not the one this district was started from (${String(civ.checksum)}); refusing to continue`] };
    }
    /** @type {any} */
    let record;
    try {
        const result = yield* rehydrateSiteSteps(payload.plan, 1, payload.ground, { ...(payload.siteOptions ?? {}), expectChecksum: civ.checksum, ops });
        record = result.record;
        if (!result.ok || record === null || record === undefined) {
            return { ok: false, reasons: ["the district plan could not be rebuilt from storage", ...result.problems.slice(0, 5)] };
        }
    } catch (error) {
        return { ok: false, reasons: [`the stored ground is unusable (${String(error)}); refusing to continue`] };
    }
    if (record.checksum !== civ.checksum) {
        return { ok: false, reasons: [`the rebuilt district plan (${String(record.checksum)}) does not match the recorded checksum (${String(civ.checksum)}); refusing to continue`] };
    }
    const loadedQueue = jobStore.loadQueue();
    if (loadedQueue.status !== "ok" || loadedQueue.queue === undefined) {
        return { ok: false, reasons: [`the stored job queue is ${loadedQueue.status}${loadedQueue.reason ? ` (${loadedQueue.reason})` : ""}; refusing to continue`] };
    }
    const queue = loadedQueue.queue;
    const fresh = jobs.createQueue(jobSpecsOf(record), { planHash: record.checksum });
    const same = fresh.total.length === queue.total.length && fresh.total.every((total, index) => total === queue.total[index] && fresh.hash[index] === queue.hash[index]);
    if (!same || queue.planHash !== record.checksum) {
        return { ok: false, reasons: ["the stored job queue does not belong to this plan; refusing to continue"] };
    }
    if (queue.state === "aborted") {
        return { ok: false, reasons: ["the stored job queue was aborted for good"] };
    }
    if (queue.state === "paused") {
        jobs.resume(queue);
    }
    return { ok: true, plan: payload.plan, record, queue, region: siteGroundRegion(payload.plan, 1), payload, recovered: loadedQueue.recovered ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Construction

/**
 * @typedef {{
 *   placed: number, built: number, skipped: number, failed: number, notes: number, stateFallbacks: number,
 *   treesCleared: number, treeCells: number, skippedTrees: number, unloadedWaits: number, outside: number,
 *   byReason: Record<string, number>, samples: string[]
 * }} Counts
 * @typedef {{
 *   token: Job, dimension: Dimension, plan: any, record: any, queue: JobQueue, region: Rect, protectedRects: Rect[],
 *   say: (lines: string[]) => void,
 *   saveCiv: (patch: Record<string, any>) => boolean,
 *   onStageComplete?: (stage: string) => void,
 *   onEnd: (result: EndResult) => void,
 *   saveEveryOps?: number,
 * }} ConstructionOptions
 * @typedef {{ status: "complete" | "paused" | "failed", reason?: string, counts: Counts, spot?: { x: number, y: number, z: number }, opsPlanned: number, opsDone: number, slices: SliceStats }} EndResult
 * @typedef {{ slices: number, maxOps: number, maxWrites: number, maxReads: number }} SliceStats
 */

/** @returns {Counts} */
function newCounts() {
    return { placed: 0, built: 0, skipped: 0, failed: 0, notes: 0, stateFallbacks: 0, treesCleared: 0, treeCells: 0, skippedTrees: 0, unloadedWaits: 0, outside: 0, byReason: {}, samples: [] };
}

/**
 * @typedef {{
 *   opts: ConstructionOptions, token: Job, dimension: Dimension, queue: JobQueue, record: any, plan: any,
 *   counts: Counts, slice: SliceStats, meter: { reads: number, writes: number, ops: number },
 *   heldRect: Rect | undefined, perms: Map<string, any>, opCache: Map<string, CanonicalOp[]>, own: Map<number, number | { last: number, all: number[], seq: number[] }>, ids: string[], idIndex: Map<string, number>,
 *   treeRefused: Set<string>, cur: { element: number, cursor: number } | undefined, sinceSave: number, lastPct: number, lastStage: string,
 *   stagesDone: Set<string>, lastHoldBox: string | undefined, waiting: number, status: string, done: Promise<EndResult> | undefined, planned: number,
 * }} Session
 */

/** @type {Session | undefined} */
let session;

export function getSession() {
    return session;
}

export function hasSession() {
    return session !== undefined;
}

/** Forget every in-memory trace (tests simulate a restart with this; the stores are untouched). */
export function resetCivForTests() {
    session = undefined;
    releaseArea(undefined);
}

/** @param {Rect} r */
const widthOf = (r) => r.x1 - r.x0 + 1;

/** Key of a cell inside the region, or -1. @param {Session} s @param {number} x @param {number} y @param {number} z */
function cellKey(s, x, y, z) {
    const r = s.opts.region;
    if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1 || y < WORLD_MIN_Y || y > WORLD_MAX_Y) {
        return -1;
    }
    return ((x - r.x0) * (r.z1 - r.z0 + 1) + (z - r.z0)) * 400 + (y - WORLD_MIN_Y);
}

/** @param {Session} s @param {string} id */
function idNumber(s, id) {
    let n = s.idIndex.get(id);
    if (n === undefined) {
        n = s.ids.length;
        s.ids.push(id);
        s.idIndex.set(id, n);
    }
    return n;
}

/**
 * Normalised ops of one element (small LRU).
 * @param {Session} s @param {string} stage @param {number} index
 */
function elementOps(s, stage, index) {
    const key = `${stage}:${String(index)}`;
    let ops = s.opCache.get(key);
    if (ops === undefined) {
        const raw = siteOpsFor(s.record, stage, index);
        ops = new Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
            ops[i] = normalizeOp(raw[i]);
        }
        if (s.opCache.size >= 4) {
            const first = s.opCache.keys().next().value;
            if (first !== undefined) {
                s.opCache.delete(first);
            }
        }
        s.opCache.set(key, ops);
    }
    return ops;
}

/**
 * Index, element by element and in bounded steps, which block ids the plan places at every cell, so a block this very
 * plan placed earlier can be told from a foreign one.
 * @param {Session} s
 */
function* indexOwnBlocks(s) {
    let sinceYield = 0;
    for (const stageInfo of s.queue.stages) {
        const list = /** @type {any[]} */ (s.record[stageInfo.name] ?? []);
        for (let index = 0; index < list.length; index += 1) {
            if (s.token.cancelled) {
                return;
            }
            const ops = elementOps(s, stageInfo.name, index);
            for (const op of ops) {
                const key = cellKey(s, op.x, op.y, op.z);
                if (key < 0) {
                    continue;
                }
                const id = idNumber(s, op.id);
                const have = s.own.get(key);
                if (have === undefined) {
                    s.own.set(key, id);
                } else if (typeof have === "number") {
                    if (have !== id) {
                        s.own.set(key, { last: id, all: [have, id], seq: [have, id] });
                    }
                } else {
                    have.last = id;
                    have.seq.push(id);
                    if (!have.all.includes(id)) {
                        have.all.push(id);
                    }
                }
            }
            s.planned += ops.length;
            sinceYield += ops.length;
            if (sinceYield >= CIV_LIMITS.maxBlocksPerSlice * 5) {
                sinceYield = 0;
                yield;
            }
        }
    }
}

/** @param {Session} s @param {number} x @param {number} y @param {number} z @param {string} [opId] @returns {{ final: string | undefined, nonAir: string[], earlier: string[] }} */
function plannedAt(s, x, y, z, opId) {
    const key = cellKey(s, x, y, z);
    const have = key < 0 ? undefined : s.own.get(key);
    if (have === undefined) {
        return { final: undefined, nonAir: [], earlier: [] };
    }
    const ids = (typeof have === "number" ? [have] : have.all).map((n) => /** @type {string} */ (s.ids[n]));
    const final = /** @type {string} */ (s.ids[typeof have === "number" ? have : have.last]);
    /** @type {string[]} */
    let earlier = [];
    if (typeof have !== "number" && opId !== undefined) {
        const seq = have.seq.map((n) => /** @type {string} */ (s.ids[n]));
        const first = seq.indexOf(opId);
        earlier = first > 0 ? seq.slice(0, first) : [];
    }
    return { final, nonAir: ids.filter((id) => !isAir(id)), earlier };
}

/** End the current slice: record the meter and reset it. @param {Session} s */
function endSlice(s) {
    s.slice.slices += 1;
    s.slice.maxOps = Math.max(s.slice.maxOps, s.meter.ops);
    s.slice.maxWrites = Math.max(s.slice.maxWrites, s.meter.writes);
    s.slice.maxReads = Math.max(s.slice.maxReads, s.meter.reads);
    s.meter.ops = 0;
    s.meter.reads = 0;
    s.meter.writes = 0;
}

/**
 * Yield first if one more action costing (reads, writes) would exceed a slice budget.
 * @param {Session} s @param {number} reads @param {number} writes
 */
function* budgetFor(s, reads, writes) {
    if (s.meter.reads + reads > CIV_LIMITS.maxReadsPerSlice || s.meter.writes + writes > CIV_LIMITS.maxBlocksPerSlice) {
        endSlice(s);
        yield;
    }
}

/** @param {Session} s @param {string} text */
function sample(s, text) {
    if (s.counts.samples.length < 8) {
        s.counts.samples.push(text);
    }
}

/**
 * @param {Session} s @param {CanonicalOp} op
 */
function permutationFor(s, op) {
    const key = `${op.id}|${op.states ? JSON.stringify(op.states) : ""}`;
    let permutation = s.perms.get(key);
    if (permutation === undefined) {
        try {
            permutation = BlockPermutation.resolve(op.id, /** @type {any} */ (op.states));
        } catch (error) {
            if (op.states === undefined) {
                throw error;
            }
            s.counts.stateFallbacks += 1;
            sample(s, `${op.id}: states rejected (${String(error)}); placed without states`);
            permutation = BlockPermutation.resolve(op.id);
        }
        s.perms.set(key, permutation);
    }
    return permutation;
}

/**
 * Live type id (and the persistent-leaves flag) of a cell; undefined when unloaded.
 * @param {Session} s @param {number} x @param {number} y @param {number} z
 * @returns {{ id: string, persistent?: boolean } | undefined}
 */
function readLive(s, x, y, z) {
    s.meter.reads += 1;
    try {
        const block = s.dimension.getBlock({ x, y, z });
        if (block === undefined || block.isValid === false) {
            return undefined;
        }
        const id = block.typeId;
        if (isLeaves(id)) {
            const state = block.permutation?.getState("persistent_bit");
            return { id, persistent: state !== false };
        }
        return { id };
    } catch (_error) {
        return undefined;
    }
}

/**
 * Prove that the canopy/trunk component containing (seed) is a natural tree (same rules as
 * structures/terrain.js classifyTrees) in budgeted steps, then clear the cells inside the claimed region.
 *
 * @param {Session} s @param {{ x: number, y: number, z: number }} seed
 * @returns {Generator<void, { ok: boolean, reason?: string }, void>}
 */
function* clearTree(s, seed) {
    const cap = CIV_TREE_CAP;
    const key = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => `${String(x)},${String(y)},${String(z)}`;
    if (s.treeRefused.has(key(seed.x, seed.y, seed.z))) {
        return { ok: false, reason: "tree already judged not natural" };
    }
    /** @type {Map<string, { id: string, persistent?: boolean } | undefined>} */
    const seen = new Map();
    const read = function* (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) {
        const k = key(x, y, z);
        if (!seen.has(k)) {
            yield* budgetFor(s, 2, 0);
            seen.set(k, readLive(s, x, y, z));
        }
        return seen.get(k);
    };
    /** @type {Set<string>} */
    const visited = new Set([key(seed.x, seed.y, seed.z)]);
    /** @type {{ x: number, y: number, z: number, id: string }[]} */
    const component = [];
    const queue = [seed];
    let reason;
    while (queue.length > 0 && reason === undefined) {
        const cell = /** @type {{ x: number, y: number, z: number }} */ (queue.pop());
        const here = yield* read(cell.x, cell.y, cell.z);
        if (here === undefined) {
            reason = "a chunk next to the tree is not loaded";
            break;
        }
        component.push({ ...cell, id: here.id });
        if (isLeaves(here.id) && here.persistent === true) {
            reason = `${here.id} is player-placed (persistent leaves)`;
            break;
        }
        if (component.length > cap) {
            reason = `a tree-like structure larger than ${String(cap)} blocks`;
            break;
        }
        for (let dx = -1; dx <= 1 && reason === undefined; dx += 1) {
            for (let dy = -1; dy <= 1 && reason === undefined; dy += 1) {
                for (let dz = -1; dz <= 1; dz += 1) {
                    if (dx === 0 && dy === 0 && dz === 0) {
                        continue;
                    }
                    const nx = cell.x + dx;
                    const ny = cell.y + dy;
                    const nz = cell.z + dz;
                    const neighbour = yield* read(nx, ny, nz);
                    if (neighbour === undefined) {
                        reason = "a chunk next to the tree is not loaded";
                        break;
                    }
                    const benign = plannedAt(s, nx, ny, nz).nonAir.includes(neighbour.id) || isAir(neighbour.id) || isPlant(neighbour.id) || isTreePart(neighbour.id) || isNaturalGround(neighbour.id) || isWater(neighbour.id) || neighbour.id === "minecraft:lava" || neighbour.id === "minecraft:flowing_lava";
                    if (!benign) {
                        reason = `${neighbour.id} touches a tree - may be a player build`;
                        break;
                    }
                    if (isTreePart(neighbour.id) && !visited.has(key(nx, ny, nz)) && Math.abs(nx - seed.x) <= CIV_TREE_RADIUS && Math.abs(ny - seed.y) <= CIV_TREE_RADIUS && Math.abs(nz - seed.z) <= CIV_TREE_RADIUS) {
                        visited.add(key(nx, ny, nz));
                        queue.push({ x: nx, y: ny, z: nz });
                    }
                }
            }
        }
    }
    if (reason === undefined) {
        const logs = component.filter((cell) => isLog(cell.id));
        if (logs.length > 0 && !component.some((cell) => isLeaves(cell.id))) {
            reason = "a log-only structure has no leaves - may be a player build";
        } else if (logs.length > 0) {
            const lowest = logs.reduce((best, cell) => (cell.y < best.y ? cell : best), /** @type {{ x: number, y: number, z: number, id: string }} */ (logs[0]));
            const base = yield* read(lowest.x, lowest.y - 1, lowest.z);
            if (base === undefined || !(isNaturalGround(base.id) || isLog(base.id))) {
                reason = "a tree trunk does not stand on natural ground";
            }
        }
    }
    if (reason !== undefined) {
        if (reason.includes("not loaded")) {
            return { ok: false, reason };
        }
        for (const cell of component) {
            s.treeRefused.add(key(cell.x, cell.y, cell.z));
        }
        s.treeRefused.add(key(seed.x, seed.y, seed.z));
        return { ok: false, reason };
    }
    const air = permutationFor(s, { x: 0, y: 0, z: 0, id: "minecraft:air", kind: "clear" });
    const wide = { x0: s.opts.region.x0 - 4, z0: s.opts.region.z0 - 4, x1: s.opts.region.x1 + 4, z1: s.opts.region.z1 + 4 };
    // Clear in reverse discovery order: every parent outlives its children, so a crash half way leaves a connected
    // remainder that still contains the seed - the replay finds it again and finishes the same job.
    for (let ci = component.length - 1; ci >= 0; ci -= 1) {
        const cell = /** @type {{ x: number, y: number, z: number, id: string }} */ (component[ci]);
        if (!inRect(wide, cell.x, cell.z) || s.opts.protectedRects.some((rect) => inRect(rect, cell.x, cell.z))) {
            continue;
        }
        yield* budgetFor(s, 2, 1);
        const live = readLive(s, cell.x, cell.y, cell.z);
        if (live === undefined || !isTreePart(live.id)) {
            continue;
        }
        try {
            const block = s.dimension.getBlock({ x: cell.x, y: cell.y, z: cell.z });
            s.meter.reads += 1;
            if (block === undefined) {
                continue;
            }
            block.setPermutation(air);
            s.meter.writes += 1;
            s.counts.treeCells += 1;
        } catch (error) {
            s.counts.failed += 1;
            sample(s, `tree cell ${String(cell.x)},${String(cell.y)},${String(cell.z)}: ${String(error)}`);
        }
    }
    s.counts.treesCleared += 1;
    return { ok: true };
}

/**
 * Apply one op against the live world. Returns "unloaded" when the chunk is not available (nothing done).
 * @param {Session} s @param {CanonicalOp} op
 * @returns {Generator<void, "ok" | "unloaded", void>}
 */
function* applyOp(s, op) {
    s.meter.ops += 1;
    const counts = s.counts;
    if (op.kind === "note") {
        counts.notes += 1;
        return "ok";
    }
    /** @param {string} reason */
    const skip = (reason) => {
        counts.skipped += 1;
        const key = reasonKey(reason);
        counts.byReason[key] = (counts.byReason[key] ?? 0) + 1;
        sample(s, `(${String(op.x)}, ${String(op.y)}, ${String(op.z)}) ${op.kind} ${op.id}: ${reason}`);
    };
    if (op.y < WORLD_MIN_Y || op.y > WORLD_MAX_Y || !inRect(s.opts.region, op.x, op.z)) {
        counts.outside += 1;
        skip("outside the planned area");
        return "ok";
    }
    if (s.opts.protectedRects.some((rect) => inRect(rect, op.x, op.z))) {
        counts.outside += 1;
        skip("inside a protected footprint");
        return "ok";
    }
    let target;
    try {
        target = s.dimension.getBlock({ x: op.x, y: op.y, z: op.z });
    } catch (_error) {
        target = undefined;
    }
    s.meter.reads += 1;
    if (target === undefined || target.isValid === false) {
        return "unloaded";
    }
    let verdict = classifyCivOp(op, target.typeId, plannedAt(s, op.x, op.y, op.z, op.id));
    if (verdict.action === "tree") {
        const cleared = yield* clearTree(s, { x: op.x, y: op.y, z: op.z });
        if (!cleared.ok) {
            if (cleared.reason?.includes("not loaded")) {
                return "unloaded";
            }
            counts.skippedTrees += 1;
            skip(`tree not cleared: ${String(cleared.reason)}`);
            return "ok";
        }
        try {
            target = s.dimension.getBlock({ x: op.x, y: op.y, z: op.z });
        } catch (_error) {
            target = undefined;
        }
        s.meter.reads += 1;
        if (target === undefined || target.isValid === false) {
            return "unloaded";
        }
        verdict = classifyCivOp(op, target.typeId, plannedAt(s, op.x, op.y, op.z, op.id));
    }
    if (verdict.action === "built") {
        counts.built += 1;
        return "ok";
    }
    if (verdict.action === "skip") {
        skip(verdict.reason ?? "refused");
        return "ok";
    }
    if (verdict.action === "unloaded") {
        return "unloaded";
    }
    if (verdict.action === "tree") {
        skip("tree still in the way");
        return "ok";
    }
    try {
        target.setPermutation(permutationFor(s, op));
        s.meter.writes += 1;
        counts.placed += 1;
    } catch (error) {
        counts.failed += 1;
        sample(s, `(${String(op.x)}, ${String(op.y)}, ${String(op.z)}) ${op.id}: ${String(error)}`);
    }
    return "ok";
}

/**
 * Bounding box of the ops a window will touch, plus the items.
 * @param {Session} s @param {{ stage: string, element: number, index: number, from: number, to: number }[]} items
 * @returns {Rect}
 */
function windowBox(s, items) {
    const box = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
    for (const item of items) {
        const ops = elementOps(s, item.stage, item.index);
        for (let i = item.from; i < item.to; i += 1) {
            const op = /** @type {CanonicalOp} */ (ops[i]);
            box.x0 = Math.min(box.x0, op.x);
            box.x1 = Math.max(box.x1, op.x);
            box.z0 = Math.min(box.z0, op.z);
            box.z1 = Math.max(box.z1, op.z);
        }
    }
    return box;
}

/** @param {Rect} r @param {Rect} inner @param {number} pad */
const contains = (r, inner, pad) => inner.x0 - pad >= r.x0 && inner.x1 + pad <= r.x1 && inner.z0 - pad >= r.z0 && inner.z1 + pad <= r.z1;

/** The next window of work whose touched area fits one held tile (shrinks the window until it does). @param {Session} s */
function chooseWindow(s) {
    for (const maxOps of [400, 200, 100, 50, 25, 12, 6, 3, 1]) {
        const work = jobs.nextWork(s.queue, { maxOps: Math.min(maxOps, CIV_LIMITS.maxBlocksPerSlice) });
        if (work.items.length === 0) {
            return { work, box: undefined };
        }
        const box = windowBox(s, work.items);
        if (box.x1 - box.x0 + 1 <= WINDOW_MAX_SPAN && box.z1 - box.z0 + 1 <= WINDOW_MAX_SPAN) {
            return { work, box };
        }
        if (maxOps === 1) {
            return { work, box };
        }
    }
    return { work: jobs.nextWork(s.queue, { maxOps: 1 }), box: undefined };
}

/** @param {Rect} box @returns {Rect} */
function holdRectFor(box) {
    const cx = Math.floor((box.x0 + box.x1) / 2);
    const cz = Math.floor((box.z0 + box.z1) / 2);
    const half = HOLD_SIZE / 2;
    return { x0: cx - half, z0: cz - half, x1: cx + half - 1, z1: cz + half - 1 };
}

/** Persist the job queue and the small kingdom record. @param {Session} s @param {Record<string, any>} [extra] */
function persistProgress(s, extra = {}) {
    const { jobStore } = stores();
    const result = jobStore.saveQueue(s.queue);
    if (!result.ok) {
        throw new Error(`could not store progress (${String(result.reason ?? result.status)})`);
    }
    s.sinceSave = 0;
    const overall = jobs.progress(s.queue);
    s.opts.saveCiv({ stage: s.lastStage, ops: overall.totalOps - overall.remainingOps, opsTotal: overall.totalOps, placed: s.counts.placed, skipped: s.counts.skipped, ...extra });
}

/**
 * One job: windows of work until a hold is needed, the work ends, or something goes wrong.
 * @param {Session} s
 * @returns {Generator<void, { status: "need-hold", box: Rect } | { status: "complete" | "paused" | "failed" | "cancelled", reason?: string }, void>}
 */
function* constructionJob(s) {
    for (;;) {
        if (s.token.cancelled) {
            return { status: "cancelled" };
        }
        const { work, box } = chooseWindow(s);
        if (work.items.length === 0) {
            if (s.queue.state === "complete") {
                return { status: "complete" };
            }
            return { status: "paused", reason: work.blocked ?? `the job queue is ${s.queue.state}` };
        }
        if (box !== undefined && (s.heldRect === undefined || !contains(s.heldRect, box, 8))) {
            const boxKey = `${String(box.x0)},${String(box.z0)},${String(box.x1)},${String(box.z1)}`;
            if (s.heldRect === undefined || s.lastHoldBox !== boxKey) {
                s.lastHoldBox = boxKey;
                return { status: "need-hold", box };
            }
            // already asked for exactly this area once: work with what the engine granted instead of asking forever
        }
        for (const item of work.items) {
            const ops = elementOps(s, item.stage, item.index);
            s.lastStage = item.stage;
            for (let i = item.from; i < item.to; ) {
                if (s.token.cancelled) {
                    return { status: "cancelled" };
                }
                if (s.meter.ops >= CIV_LIMITS.maxBlocksPerSlice) {
                    endSlice(s);
                    yield;
                    if (s.token.cancelled) {
                        return { status: "cancelled" };
                    }
                }
                yield* budgetFor(s, 2, 1);
                const result = yield* applyOp(s, /** @type {CanonicalOp} */ (ops[i]));
                if (result === "unloaded") {
                    s.waiting += 1;
                    s.counts.unloadedWaits += 1;
                    if (s.waiting > PHYSICAL.unloadedRetrySlices) {
                        jobs.markProgress(s.queue, item.element, i);
                        return { status: "paused", reason: "a chunk in the build area is not loaded" };
                    }
                    endSlice(s);
                    yield;
                    continue;
                }
                s.waiting = 0;
                i += 1;
                s.cur = { element: item.element, cursor: i };
            }
            jobs.markProgress(s.queue, item.element, item.to);
            s.cur = undefined;
            s.sinceSave += item.ops;
        }
        // stages that just finished
        for (const info of s.queue.stages) {
            if (!s.stagesDone.has(info.name) && jobs.stageSatisfied(s.queue, info.name)) {
                s.stagesDone.add(info.name);
                persistProgress(s);
                s.opts.onStageComplete?.(info.name);
            }
        }
        if (s.sinceSave >= (s.opts.saveEveryOps ?? PHYSICAL.saveEvery)) {
            persistProgress(s);
        }
        const overall = jobs.progress(s.queue);
        const decile = Math.floor(overall.pct / 10);
        if (decile > s.lastPct && overall.pct < 100) {
            s.lastPct = decile;
            s.opts.say([`  ${s.lastStage}: ${String(Math.floor(overall.pct))}% (${String(overall.totalOps - overall.remainingOps)} / ${String(overall.totalOps)} ops, ${String(s.counts.skipped)} skipped)`]);
        }
        endSlice(s);
        yield;
    }
}

/**
 * Index, hold and run. Resolves with the final report; every exit path releases the chunks and the job slot
 * (except cancellation, whose cleanup belongs to abortCiv).
 *
 * @param {ConstructionOptions} opts
 * @returns {Session}
 */
export function startConstruction(opts) {
    /** @type {Session} */
    const s = {
        opts,
        token: opts.token,
        dimension: opts.dimension,
        queue: opts.queue,
        record: opts.record,
        plan: opts.plan,
        counts: newCounts(),
        slice: { slices: 0, maxOps: 0, maxWrites: 0, maxReads: 0 },
        meter: { reads: 0, writes: 0, ops: 0 },
        heldRect: undefined,
        perms: new Map(),
        opCache: new Map(),
        own: new Map(),
        ids: [],
        idIndex: new Map(),
        treeRefused: new Set(),
        cur: undefined,
        sinceSave: 0,
        lastPct: Math.floor(jobs.progress(opts.queue).pct / 10),
        lastStage: opts.queue.stages[0]?.name ?? "clear",
        stagesDone: new Set(),
        lastHoldBox: undefined,
        waiting: 0,
        status: "starting",
        done: undefined,
        planned: 0,
    };
    for (const info of s.queue.stages) {
        if (jobs.stageSatisfied(s.queue, info.name)) {
            s.stagesDone.add(info.name);
        }
    }
    session = s;
    opts.token.kind = "civ-build";
    s.done = run(s);
    return s;
}

/** @param {Session} s @returns {Promise<EndResult>} */
async function run(s) {
    /** @param {EndResult["status"]} status @param {string | undefined} reason */
    const end = async (status, reason) => {
        endSlice(s);
        const overall = jobs.progress(s.queue);
        /** @type {EndResult} */
        const result = { status, reason, counts: s.counts, opsPlanned: overall.totalOps, opsDone: overall.totalOps - overall.remainingOps, slices: s.slice };
        try {
            if (status === "complete") {
                result.spot = await safeSpot(s);
            } else {
                for (let i = 0; i < s.queue.status.length; i += 1) {
                    if (s.queue.status[i] === "running") {
                        s.queue.status[i] = "pending";
                    }
                }
                jobs.pause(s.queue);
            }
            persistProgress(s, { status: status === "complete" ? "complete" : "paused", stage: status === "complete" ? "complete" : s.lastStage });
        } catch (error) {
            result.status = "failed";
            result.reason = `${reason ?? ""} (could not save: ${String(error)})`.trim();
        }
        releaseArea(s.token);
        if (session === s) {
            session = undefined;
        }
        finishJob(s.token);
        s.status = result.status;
        s.opts.onEnd(result);
        return result;
    };
    try {
        s.opts.say(["Preparing the build: indexing the plan..."]);
        await runJobAsync(s.token, indexOwnBlocks(s));
        if (s.token.cancelled) {
            return /** @type {EndResult} */ ({ status: "paused", counts: s.counts, opsPlanned: 0, opsDone: 0, slices: s.slice });
        }
        s.status = "building";
        s.opts.say([`Building ${String(s.planned)} planned blocks (${String(jobs.progress(s.queue).remainingOps)} remaining). Chunks are held for you; you do not need to stay close.`]);
        for (;;) {
            const result = await runJobAsync(s.token, constructionJob(s));
            if (s.token.cancelled || result === undefined || result.status === "cancelled") {
                return /** @type {EndResult} */ ({ status: "paused", counts: s.counts, opsPlanned: 0, opsDone: 0, slices: s.slice });
            }
            if (result.status === "need-hold") {
                const rect = holdRectFor(result.box);
                const held = await holdArea(s.dimension, rect, s.token);
                if (s.token.cancelled) {
                    releaseArea(s.token);
                    return /** @type {EndResult} */ ({ status: "paused", counts: s.counts, opsPlanned: 0, opsDone: 0, slices: s.slice });
                }
                if (!held.held && held.note !== undefined) {
                    sample(s, held.note);
                }
                s.heldRect = rect;
                continue;
            }
            return await end(result.status, result.reason);
        }
    } catch (error) {
        if (s.token.cancelled) {
            return /** @type {EndResult} */ ({ status: "paused", counts: s.counts, opsPlanned: 0, opsDone: 0, slices: s.slice });
        }
        return await end("failed", `unexpected error: ${String(error)}`);
    }
}

/**
 * A y a player can stand on at the district's HQ: one above the topmost block there.
 * @param {Session} s
 */
async function safeSpot(s) {
    const hq = s.plan?.districts?.[0]?.hq ?? s.plan?.districts?.[0]?.centroid;
    if (hq === undefined) {
        return undefined;
    }
    const x = Math.round(hq.x);
    const z = Math.round(hq.z);
    try {
        await holdArea(s.dimension, { x0: x - 32, z0: z - 32, x1: x + 31, z1: z + 31 }, s.token);
        const top = s.dimension.getTopmostBlock({ x, z });
        if (top !== undefined) {
            return { x, y: top.location.y + 2, z };
        }
    } catch (_error) {
        // fall through
    }
    return { x, y: 120, z };
}

/** Snapshot for civ:generate_status. */
export function sessionStatus() {
    const s = session;
    if (s === undefined) {
        return undefined;
    }
    const overall = jobs.progress(s.queue);
    return { status: s.status, stage: s.lastStage, pct: overall.pct, done: overall.totalOps - overall.remainingOps, total: overall.totalOps, counts: s.counts, slice: s.slice };
}

/**
 * Stop the running construction. Placed blocks stay; progress and a resumable queue are saved.
 * Returns what was stopped. The caller must also free the job slot (cancelActiveJob).
 */
export function abortConstruction() {
    const s = session;
    if (s === undefined) {
        return undefined;
    }
    s.token.cancelled = true;
    if (s.cur !== undefined) {
        try {
            jobs.markProgress(s.queue, s.cur.element, s.cur.cursor);
        } catch (_error) {
            // cursor beyond the element: ignore
        }
    }
    for (let i = 0; i < s.queue.status.length; i += 1) {
        if (s.queue.status[i] === "running") {
            s.queue.status[i] = "pending";
        }
    }
    jobs.pause(s.queue);
    let saved = true;
    try {
        persistProgress(s, { status: "paused" });
    } catch (_error) {
        saved = false;
    }
    releaseArea(s.token);
    session = undefined;
    const overall = jobs.progress(s.queue);
    return { saved, done: overall.totalOps - overall.remainingOps, total: overall.totalOps, counts: s.counts };
}

/**
 * THE one abort path for civilization jobs (civ:generate_abort and civ:district_abort both come here).
 * Only a job whose token kind starts with "civ-" is touched. A running construction is paused with its queue and
 * district.civ saved; any civilization job releases its own ticking area and the job slot.
 *
 * @returns {{ kind: string, stopped: ReturnType<typeof abortConstruction> } | undefined} undefined when no civilization job owns the slot
 */
export function abortCivJob() {
    const token = activeToken();
    if (token === undefined || !token.kind.startsWith("civ-")) {
        return undefined;
    }
    const stopped = abortConstruction();
    cancelActiveJob();
    releaseArea(token);
    return { kind: token.kind, stopped };
}

/**
 * Truthful report of an abortCivJob() result.
 * @param {NonNullable<ReturnType<typeof abortCivJob>>} result
 * @param {string} resumeId command id to continue with
 */
export function civAbortLines(result, resumeId) {
    const stopped = result.stopped;
    if (stopped === undefined) {
        return [`Stopped the ${result.kind} job. It had not started building: no block was written by it.`];
    }
    return [
        `Civilization build stopped${stopped.saved ? "" : " (progress could not be saved; the last saved point will be used)"}. ${String(stopped.done)} of ${String(stopped.total)} operations are done; ${String(stopped.counts.placed)} block(s) were placed in this run and stay in the world.`,
        `Continue with /scriptevent ${resumeId}.`,
    ];
}

export { CIV_TICKING_ID, widthOf };
