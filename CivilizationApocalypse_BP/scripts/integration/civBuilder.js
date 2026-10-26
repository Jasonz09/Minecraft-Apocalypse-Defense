import { BlockPermutation, world } from "@minecraft/server";
import { CIV, PHYSICAL } from "../config.js";
import { CIV_LIMITS } from "../civ/budget.js";
import { SITE_PLAN_VERSION, planDistrictSiteSteps, rehydrateSiteSteps, siteContainmentProblemsSteps, siteJobSpecs, siteOpCount, siteOpsFor, siteOptionsOf } from "../civ/districtplan.js";
import { auditRecord, shortfallOf } from "../civ/facilities.js";
import * as jobs from "../civ/jobs.js";
import { planCivilizationDetailedSteps } from "../civ/masterplan.js";
import { markYield, newOps } from "../civ/regions.js";
import { normalizeOp } from "../civ/opnorm.js";
import { PLAN_PREFIX, PLAN_VERSION, createPlanStore, utf8Length } from "../civ/planstore.js";
import { clipField, exportSiteGroundSteps, siteGroundBytes, siteGroundRegion } from "../civ/siteprofile.js";
import { SITE_DEFAULTS, TERRAIN_POLICY_DEFAULT, overlapsExclusion, rankSites, scanRadiusFor, siteTerrainPolicy } from "../civ/siteselect.js";
import { validatePlanSteps } from "../civ/validatesteps.js";
import { classifyTerrainCell, isBenign, isLeaves, isLog, isNaturalGround, isPlant, isTreePart } from "../structures/terrain.js";
import { activeToken, cancelActiveJob, finishJob } from "./districtBuilder.js";
import { CIV_TICKING_ID, countTiles, holdArea, nextTick, releaseArea, runJobAsync, scanFull, scanProgressive, tileSizeNow } from "./civScan.js";
import { finishProgress, getProgress, heartbeat, nowTick, resetProgressForTests, setPhase, touch } from "./civProgress.js";

/**
 * Bedrock boundary for the one-command civilization workflow, WRITE side, plus the planning
 * pipeline that precedes it.
 *
 * The workflow is DISTRICT-GENERIC: every entry point takes a district index (1..5), derives its `district-N`
 * id, its own site-payload slot and its own job queue from it. The five-district MASTER PLAN is stored once
 * (`civ:plan`) and shared: the districts lie in one coordinate system and share walls and gates, so a district must
 * never be planned against a master plan other than the one its neighbours were placed by.
 *
 * Contract (nothing below ever happens at import or activation):
 *  - planWorld(): either (a) survey -> rank -> master plan -> validate -> full-resolution ground -> district site
 *    plan, or (b) when a master plan is already stored, read it and survey ONLY the district's own region.
 *    Both are READ-ONLY. Every failure returns a report; no failure path has written a block.
 *  - persistRun(): master plan + the district's ground + that district's job queue are saved BEFORE the first block.
 *  - startConstruction(): the only code that writes blocks. Every op is classified against the LIVE
 *    block immediately before it is written; anything that is not air, loose vegetation, natural
 *    ground (or, for explicit support kinds, still water) or a block this very plan placed at that
 *    cell is skipped and counted - never overwritten. Ops inside a district that is already being built or is
 *    complete (see `inProtectedArea`) are skipped before they are even read, except the district's own wall
 *    closing out a shared band (`isSharedWallFill`) - see the two functions for exactly what may and may not
 *    enter a finished neighbour's land. Natural trees are cleared only after the whole
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
 * (an invalid master plan, an over-sized plan, a district whose construction plan is not composed yet) without a
 * contrived world.
 */
export const seams = {
    /** @type {(plan: any, ops: import("../civ/regions.js").Ops) => Generator<void, { ok: boolean, problems: string[], metrics?: any }, void>} */
    validatePlan: (plan, ops) => validatePlanSteps(plan, { ops }),
    /**
     * One district's construction plan. The default is the real planner (civ/districtplan.js), which refuses a
     * district that has no enlarged layout; a test may substitute a generator to exercise the runtime around a
     * district whose layout is still being composed.
     * @type {(plan: any, index: number, field: any, options: any) => Generator<void, { ok: boolean, problems: string[], notes: string[], record: any }, void>}
     */
    planSite: (plan, index, field, options) => planDistrictSiteSteps(plan, index, field, options),
    /** @type {number | undefined} */
    maxPlanBytes: undefined,
    /** @type {number | undefined} */
    maxJobBytes: undefined,
    /** @type {((outcome: any) => void) | undefined} */
    onOutcome: undefined,
};

/** Plan area radius handed to the master planner (its own default). */
export const MASTER_PLAN_RADIUS = 300;
/** How far the master plan reaches from its anchor, plus a margin: an explicit-site survey never reads beyond this. */
export const MASTER_REACH = MASTER_PLAN_RADIUS + 16;
/** Re-seeded planning attempts (master plan -> ground -> site plan) before giving up. */
const WORLD_ATTEMPTS = 3;
/** Extra clearance (blocks) around every protected footprint for the site search. */
export const PROTECT_MARGIN = 12;
/**
 * Clearance (blocks) the write side keeps around a built district's outline; the wall band is shared land.
 * A finished district does not stop at its outline: measured on all five districts over rough and flat
 * ground, its masonry reaches exactly 3 blocks past the outline it was planned with, so anything narrower
 * than 4 lets a later district work that band. Wider buys nothing and costs the district being built: at
 * 10 the clearance suppresses 1,581 of its own building operations and 3,133 road operations, all of them
 * on land the neighbour never built on, and it still leaves the wall incomplete (see `isSharedWallFill`).
 */
export const WRITE_PROTECT_GROW = 4;
/** Sanity ceiling for the op count of one district. */
export const MAX_SANE_OPS = 400000;
/** The districts a civilization has, in the order they may be built. */
export const DISTRICT_INDEXES = Object.freeze([1, 2, 3, 4, 5]);
/** Largest bounding box (blocks per side) of one construction window; the held tile is 128. */
/** Largest span (blocks) of one construction window; the held tile must also fit 8 blocks of apron on every side. */
const windowMaxSpan = () => Math.max(4, Math.min(100, tileSizeNow() - 28));
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 319;

// ---------------------------------------------------------------------------------------------
// Per-district storage keys
//
// The chunked store keeps one meta key plus `<prefix>:<fam>:<i>` chunk keys per payload, where fam is always "a" or
// "b" and i a plain integer. Every district prefix here adds its OWN extra segment before the store appends those
// suffixes (the site prefix adds a "site" segment plus the district number, the job prefix adds the district number),
// so a district key can never be one the master-plan store or the plain queue owns: the two key sets are disjoint by
// construction. Both families still start with the prefixes the starter-world rules in config.js classify: the plan
// prefix is KEPT when a world is armed, the job prefix is WIPED.

/** @param {number} index @returns {string} the plan-prefix slot holding ONE district's site payload (ground + options + checksum) */
export function sitePrefixFor(index) {
    return `${PLAN_PREFIX}:site:d${String(index)}`;
}

/** @param {number} index @returns {string} the job-prefix slot holding ONE district's queue (district 1 keeps the plain `civ:jobs`) */
export function jobPrefixFor(index) {
    return index === 1 ? jobs.JOB_PREFIX : `${jobs.JOB_PREFIX}:d${String(index)}`;
}

/** @param {number} index @returns {string} the kingdom district id this index is recorded under */
export function districtIdFor(index) {
    return `district-${String(index)}`;
}

/** @param {number} index */
function assertIndex(index) {
    if (!Number.isInteger(index) || index < 1 || index > DISTRICT_INDEXES.length) {
        throw new RangeError(`district index ${String(index)} is not one of 1..${String(DISTRICT_INDEXES.length)}`);
    }
}

/**
 * @param {number} index @param {{ maxBytes?: number }} [options]
 * @returns {ReturnType<typeof createPlanStore>}
 */
function siteStoreFor(index, options = {}) {
    return createPlanStore(world, { prefix: sitePrefixFor(index), ...options });
}

/** @param {number} index @param {{ maxBytes?: number }} [options] */
function jobStoreFor(index, options = {}) {
    return jobs.createJobStore(world, { prefix: jobPrefixFor(index), ...options });
}

/** Largest tree-like component the clearer will examine (a giant 2x2 spruce is ~800 cells; a few merged crowns fit). */
const CIV_TREE_CAP = 4000;
/** Horizontal Chebyshev reach around the blocked cell: covers a giant spruce's crown (radius <= 8). */
const CIV_TREE_REACH_H = 8;
/** Vertical reach above/below the seed: a giant spruce stands ~30 blocks tall, so the old 8 left its crown behind. */
const CIV_TREE_REACH_V = 40;

/**
 * Kinds that may stand in / replace still water. A pier site genuinely builds over the sea: decks stand
 * on pillars down to the bed and walls/decks rise through the water. Every kind here only ADDS a block -
 * a cut is never in this set - and player blocks are still protected by the checks before this test.
 * Kinds not listed (clear, note, ...) still refuse to overwrite water.
 */
const WATER_KINDS = new Set([
    "support", "footing", "fill", "pad",
    "wall", "tower", "merlon", "walk", "rubble", "gate",
    "road", "stair", "deck", "bridge", "pillar", "rail", "retain",
]);
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
 * Anything a civ build may legitimately stand on: open air, a plant, unworked ground or still water. Not
 * "a block that happens to have an id we also use" - that is how a finished neighbour's wall face would
 * pass for raw terrain (see the shared-band rule in the construction loop).
 * @param {string} id
 */
const isRawTerrain = (id) => isAir(id) || isPlant(id) || isNaturalGround(id) || isWater(id);

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

/**
 * A footprint nothing may be written in: a rectangle, optionally narrowed to the exact polygon of the land it
 * claims (a district outline) and grown by `grow` blocks so the shared wall band stays a single owner's work.
 * @typedef {{ x0: number, z0: number, x1: number, z1: number, polygon?: [number, number][], grow?: number, label?: string }} ProtectedArea
 */

/** @param {[number, number][]} poly @param {number} x @param {number} z */
function insidePolygon(poly, x, z) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
        const [xi, zi] = /** @type {[number, number]} */ (poly[i]);
        const [xj, zj] = /** @type {[number, number]} */ (poly[j]);
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** Chebyshev distance from (x, z) to the segment a-b. @param {number} x @param {number} z @param {[number, number]} a @param {[number, number]} b */
function distanceToSegment(x, z, a, b) {
    const [ax, az] = a;
    const [bx, bz] = b;
    const dx = bx - ax;
    const dz = bz - az;
    const length = dx * dx + dz * dz;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length));
    return Math.max(Math.abs(x - (ax + t * dx)), Math.abs(z - (az + t * dz)));
}

/**
 * Kinds whose only effect is to ADD masonry: the wall, its towers, walkway, footing and dressing, and gate
 * hardware. Nothing in this set removes a block - an operation that writes air is never treated as a fill.
 */
export const WALL_FILL_KINDS = Object.freeze(["wall", "tower", "merlon", "walk", "rubble", "footing", "gate"]);

/**
 * May this operation go into the outward clearance of a district that is already built? Only its own wall:
 * a shared wall is planned by BOTH neighbours (so that neither district's enclosure depends on build order),
 * and a finished district's masonry reaches 3 blocks past its outline, so the clearance also covers columns
 * the second neighbour still has to lay. Without the exemption the clearance at WRITE_PROTECT_GROW ate 62 of
 * the 11,418 planned barrier columns - all of them in district 2's wall - and every district raised after the
 * capital lost its enclosure: their deep interiors became walkable from outside, and from each other.
 *
 * What stays forbidden, in order: a rectangle-protected footprint (a prototype) is never entered, an operation
 * that writes air never passes, only the wall kinds above pass, and nothing passes on land inside a finished
 * neighbour's own outline. In that band a wall may then only stand on raw terrain (see the construction loop),
 * because two districts' walls are made of the same stone and an identical id would otherwise read as "a block
 * of ours" and be replaced. So this can fill the line in, but cannot break it or build on land a finished
 * district owns.
 * @param {readonly ProtectedArea[]} areas @param {CanonicalOp} op
 */
export function isSharedWallFill(areas, op) {
    if (!WALL_FILL_KINDS.includes(String(op.kind)) || isAir(String(op.id))) return false;
    for (const area of areas) {
        const polygon = area.polygon;
        if (polygon === undefined) return false;
        if (inRect(area, op.x, op.z) && insidePolygon(polygon, op.x, op.z)) return false;
    }
    return true;
}

/**
 * Is this cell inside a protected footprint? A polygon entry is decided by its outline (grown by `grow`), not by
 * its bounding box: districts interlock, so their boxes overlap while the land itself does not.
 * @param {readonly ProtectedArea[]} areas @param {number} x @param {number} z
 */
export function inProtectedArea(areas, x, z) {
    for (const area of areas) {
        const polygon = area.polygon;
        if (polygon === undefined) {
            if (inRect(area, x, z)) return true;
            continue;
        }
        if (!inRect(area, x, z)) continue;
        if (insidePolygon(polygon, x, z)) return true;
        const grow = area.grow ?? 0;
        if (grow > 0 && polygon.length > 2) {
            for (let i = 0; i < polygon.length; i += 1) {
                const a = /** @type {[number, number]} */ (polygon[i]);
                const b = /** @type {[number, number]} */ (polygon[(i + 1) % polygon.length]);
                if (distanceToSegment(x, z, a, b) <= grow) return true;
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------------------------
// Planning (read-only)

/**
 * @typedef {{
 *   token: Job, dimension: Dimension, anchor: { x: number, z: number }, radius: number, seed: number,
 *   exclusions: ProtectedArea[], plannerFootprints?: ProtectedArea[],
 *   say: (lines: string[]) => void, maxPlanBytes?: number,
 *   progress?: import("./civProgress.js").Progress,
 *   district?: number, siteMode?: "search" | "here", planSeed?: number,
 *   policy?: import("../civ/siteselect.js").TerrainPolicy
 * }} PlanContext
 * @typedef {{
 *   ok: boolean, cancelled?: boolean, fatal?: boolean, stage: string, reasons: string[],
 *   district: number, name: string, masterIsNew: boolean, layoutId?: string,
 *   site?: any, plan?: any, record?: any, ground?: any, groundField?: any, region?: Rect, payload?: any, master?: any,
 *   stats: Record<string, any>
 * }} PlanOutcome
 */

/**
 * "district 3 (Saltmere, district-3)" - every runtime line names the district it is working on.
 * @param {number} index @param {any} [plan]
 */
function districtLabel(index, plan = undefined) {
    const entry = /** @type {any[]} */ (plan?.districts ?? []).find((district) => district?.index === index);
    return entry !== undefined ? `district ${String(index)} (${String(entry.name)}, ${districtIdFor(index)})` : `district ${String(index)} (${districtIdFor(index)})`;
}

/** @param {number} index @param {string} [stage] @returns {PlanOutcome} */
function newOutcome(index, stage = "scan") {
    return { ok: false, stage, reasons: [], district: index, name: districtIdFor(index), masterIsNew: false, stats: { blocksWritten: 0 } };
}

/**
 * The five-district master plan of this world, if one is stored (it lives once, in `civ:plan`, and every district
 * is planned from it). Older worlds stored the plan and district 1's ground together in that slot; their `plan`
 * member is read the same way.
 *
 * @returns {{ status: string, plan: any, payload: any, planSeed: number | undefined, anchor: { x: number, z: number } | undefined, reason: string | undefined }}
 */
export function loadMasterPlan() {
    const loaded = createPlanStore(world).loadPlan();
    const payload = loaded.plan;
    return {
        status: loaded.status,
        plan: payload?.plan,
        payload,
        planSeed: typeof payload?.planSeed === "number" ? payload.planSeed : typeof payload?.siteChecksum === "string" ? payload.seed : undefined,
        anchor: payload?.anchor,
        reason: loaded.reason,
    };
}

/**
 * Why a survey with unread ground cannot be read as a terrain verdict. Tiles the engine never generated leave
 * their lattice points `unloaded`, and rankSites disqualifies any window containing one - so a terrain figure
 * beside an incomplete survey describes only the ground that WAS read. Undefined when nothing was skipped.
 *
 * @param {{ stalledTiles?: unknown[], skippedColumns?: number, retriedTiles?: number, recoveredTiles?: number }} stats
 * @returns {string | undefined}
 */
export function coverageProblem(stats) {
    const stalled = Array.isArray(stats.stalledTiles) ? stats.stalledTiles.length : 0;
    if (stalled === 0) {
        return undefined;
    }
    const retriedCount = typeof stats.retriedTiles === "number" ? stats.retriedTiles : 0;
    const skipped = typeof stats.skippedColumns === "number" ? stats.skippedColumns : 0;
    const recovered = typeof stats.recoveredTiles === "number" ? stats.recoveredTiles : 0;
    const retried = retriedCount > 0 ? ` (asked for again ${String(retriedCount)} time(s); ${String(recovered)} column(s) recovered)` : "";
    const columns = skipped > 0 ? `${String(skipped)} column(s) of ground` : "some of the ground";
    return `${String(stalled)} survey tile(s) never finished loading${retried}, so ${columns} were never read; every candidate window over them is disqualified. Retry once the area is generated, or use a smaller radius=.`;
}

/**
 * Plan ONE district, read-only. If the world already holds a master plan, only that district's own region is
 * surveyed (no site search, no distant chunks); otherwise the civilization's master plan is made first, either by
 * searching nearest-first (`siteMode` unset - the behaviour of every run so far) or on the spot the developer is
 * standing (`siteMode: "here"`).
 *
 * @param {PlanContext} ctx
 * @returns {Promise<PlanOutcome>}
 */
export async function planWorld(ctx) {
    const index = ctx.district ?? 1;
    assertIndex(index);
    const stored = loadMasterPlan();
    if (stored.plan !== undefined && stored.plan !== null) {
        // The terrain policy rides with the stored master plan: every district of one civilization is
        // built under the policy its own site was chosen by (old plans have none and keep the old rules).
        ctx.policy = policyOf(stored.payload?.policy);
        return planOnStoredMaster(ctx, stored.plan, index, stored.planSeed);
    }
    return planNewMaster(ctx, index);
}

/** @param {any} policy @returns {import("../civ/siteselect.js").TerrainPolicy} */
function policyOf(policy) {
    if (policy === null || typeof policy !== "object") return /** @type {any} */ (TERRAIN_POLICY_DEFAULT);
    return {
        allowWater: policy.allowWater === true,
        adaptive: policy.adaptive === true,
        maxRelief: Number.isFinite(policy.maxRelief) ? Math.trunc(policy.maxRelief) : 8,
    };
}

/**
 * One district of an already stored master plan. The site search is skipped entirely: the civilization's anchor is
 * fixed, so the only ground that matters is the district's own region.
 *
 * @param {PlanContext} ctx @param {any} plan @param {number} index @param {number | undefined} storedSeed
 * @returns {Promise<PlanOutcome>}
 */
async function planOnStoredMaster(ctx, plan, index, storedSeed) {
    const out = newOutcome(index, "survey");
    out.plan = plan;
    const ops = newOps();
    out.stats.ops = ops;
    out.stats.history = [];
    out.stats.planAttempts = 1;
    const planSeed = storedSeed ?? ctx.planSeed ?? ctx.seed;
    const read = await readRegion(ctx, plan, index);
    if (ctx.token.cancelled) {
        out.cancelled = true;
        return finishFail(out, "cancelled", ["cancelled"]);
    }
    if (!read.ok) {
        return finishFail(out, read.stage, read.problems);
    }
    out.region = read.region;
    out.groundField = read.fine.field;
    out.stats.fine = read.fine.stats;
    out.stats.survey = { tilesScanned: read.fine.stats.attempted, tilesTotal: read.fine.stats.tilesTotal, chunksScanned: read.fine.stats.chunksScanned, columns: read.columns, mode: "stored-plan" };
    return planDistrictTail(ctx, plan, index, planSeed, out, false);
}

/** @param {PlanOutcome} out @param {string} stage @param {string[]} reasons */
function finishFail(out, stage, reasons) {
    out.stage = stage;
    out.reasons = reasons;
    out.fatal = true;
    out.ok = false;
    return out;
}

// ---------------------------------------------------------------------------------------------
// One district: region survey -> construction plan -> ground export -> storage check. READ-ONLY.

/**
 * The inputs of one district's site payload: everything a restart needs to rebuild the same record (the master plan
 * itself stays in its own slot, so no district's ground is ever stored twice).
 * @param {PlanContext} ctx @param {any} plan @param {number} index @param {number} planSeed @param {any} ground @param {any} record
 */
function sitePayloadOf(ctx, plan, index, planSeed, ground, record) {
    return {
        version: PLAN_VERSION,
        district: index,
        districtId: districtIdFor(index),
        ground,
        siteChecksum: record.checksum,
        siteOptions: siteOptionsOf(record),
        seed: ctx.seed,
        planSeed,
        anchor: { x: plan.anchor.x, z: plan.anchor.z },
        site: { layoutId: record.layoutId, version: SITE_PLAN_VERSION },
        ops: siteOpCount(record),
    };
}

/**
 * Full-resolution survey of ONE district's own region: nothing outside it is read, so no distant chunk is ever
 * generated for a district that shares a master plan with its neighbours.
 *
 * @param {PlanContext} ctx @param {any} plan @param {number} index @param {boolean} [numbered]
 * @returns {Promise<{ ok: true, fine: any, region: Rect, columns: number } | { ok: false, stage: string, problems: string[] }>}
 */
async function readRegion(ctx, plan, index, numbered = false) {
    const region = siteGroundRegion(plan, index);
    const columns = (region.x1 - region.x0 + 1) * (region.z1 - region.z0 + 1);
    const tile = tileSizeNow();
    const tiles = Math.ceil((region.x1 - region.x0 + 1) / tile) * Math.ceil((region.z1 - region.z0 + 1) / tile);
    setPhase(ctx.progress, 4, "ground survey");
    ctx.say([`${numbered ? "[4/6] " : ""}Reading ${districtLabel(index, plan)} at full resolution (read-only, one sample per column): ${String(columns)} columns in ${String(tiles)} ${String(tile)}-block tiles; up to ${String(tiles * (tile / 16) ** 2)} chunks may have to be generated and loaded, nothing outside this district is read.`]);
    let lastTile = 0;
    const fine = await scanFull(ctx.token, ctx.dimension, region, {
        progress: ctx.progress,
        onTile(done, total) {
            if (done - lastTile >= Math.max(1, Math.floor(total / 4)) && done < total) {
                lastTile = done;
                ctx.say([`      ground ${String(Math.floor((done * 100) / total))}%`]);
            }
        },
    });
    if (fine.cancelled) {
        return { ok: false, stage: "cancelled", problems: ["cancelled"] };
    }
    if (fine.stats.aborted !== undefined) {
        return { ok: false, stage: "stalled", problems: [fine.stats.aborted] };
    }
    if (fine.stats.unloaded > 0) {
        return { ok: false, stage: "unloaded", problems: [`${String(fine.stats.unloaded)} column(s) of ${districtLabel(index, plan)} could not be read (chunks not loaded); nothing was guessed and nothing was changed`] };
    }
    return { ok: true, fine, region, columns };
}

/**
 * The district's construction plan, its containment check, the frozen ground and the storage measurement.
 * Everything after the region has been read; nothing here writes a block.
 *
 * @param {PlanContext} ctx @param {any} plan @param {number} index @param {number} planSeed @param {PlanOutcome} out
 * @param {boolean} numbered print the [5-6/6] pipeline lines (a civilization whose master plan was just made)
 * @returns {Promise<PlanOutcome>}
 */
async function planDistrictTail(ctx, plan, index, planSeed, out, numbered) {
    /** @type {(stage: string, reasons: string[], fatal?: boolean) => PlanOutcome} */
    const fail = (stage, reasons, fatal = true) => {
        out.stage = stage;
        out.reasons = reasons;
        out.fatal = fatal;
        out.record = undefined;
        out.ground = undefined;
        out.payload = undefined;
        out.ok = false;
        return out;
    };
    const label = districtLabel(index, plan);
    if (out.region === undefined || out.groundField === undefined) {
        return fail("survey", [`${label} was never surveyed`]);
    }
    const region = out.region;
    const ops = /** @type {import("../civ/regions.js").Ops} */ (out.stats.ops);
    setPhase(ctx.progress, 5, "district plan");
    ctx.say(numbered ? ["[5/6] Planning walls, gates, roads and buildings..."] : [`Planning ${label}'s walls, gates, roads and buildings...`]);
    const clipped = clipField(out.groundField, region);
    const done = await runJobAsync(ctx.token, planSiteSteps(plan, index, clipped, region, out.groundField, { seed: planSeed, excludeFootprints: ctx.plannerFootprints ?? ctx.exclusions, ops, policy: ctx.policy }), ctx.progress);
    if (ctx.token.cancelled || done === undefined) {
        out.cancelled = true;
        return fail("cancelled", ["cancelled"]);
    }
    if (!done.ok) {
        return fail(done.stage, done.problems, done.retry === true ? false : true);
    }
    const record = done.record;
    const opCount = siteOpCount(record);
    if (!Number.isInteger(opCount) || opCount <= 0 || opCount > MAX_SANE_OPS) {
        return fail("site-plan", [`implausible operation count ${String(opCount)}`]);
    }
    out.record = record;
    out.ground = done.ground;
    out.layoutId = record.layoutId;
    out.stats.notes = done.notes;

    setPhase(ctx.progress, 6, "storage check");
    ctx.say(numbered ? ["[6/6] Checking the plan fits the world's storage..."] : ["Checking the plan fits the world's storage..."]);
    const payload = sitePayloadOf(ctx, plan, index, planSeed, done.ground, record);
    const maxBytes = ctx.maxPlanBytes ?? seams.maxPlanBytes;
    const options = maxBytes === undefined ? {} : { maxBytes };
    const measure = siteStoreFor(index, options).measurePlan(payload);
    // A non-default terrain policy is part of what later districts must reproduce; a normal land plan
    // stores exactly the old payload (no new key, no size change).
    const storedPolicy = ctx.policy !== undefined && (ctx.policy.allowWater || ctx.policy.adaptive || ctx.policy.maxRelief !== 8) ? ctx.policy : undefined;
    const masterPayload = out.masterIsNew ? { version: PLAN_VERSION, plan, seed: ctx.seed, planSeed, anchor: { x: plan.anchor.x, z: plan.anchor.z }, ...(storedPolicy === undefined ? {} : { policy: storedPolicy }) } : undefined;
    const masterMeasure = masterPayload === undefined ? undefined : createPlanStore(world, options).measurePlan(masterPayload);
    const masterBytes = masterMeasure?.bytes ?? 0;
    const masterChunks = masterMeasure?.chunks ?? 0;
    out.payload = payload;
    out.master = masterPayload;
    out.stats.storage = {
        // Both plan families this run writes: the one master plan (`civ:plan`) and this district's site slot.
        bytes: measure.bytes + masterBytes,
        chunks: measure.chunks + masterChunks,
        limit: measure.limit,
        ground: siteGroundBytes(done.ground),
        site: { bytes: measure.bytes, chunks: measure.chunks, limit: measure.limit, fits: measure.fits, prefix: sitePrefixFor(index) },
        master: { bytes: masterBytes, chunks: masterChunks, limit: measure.limit, fits: masterMeasure?.fits !== false, prefix: PLAN_PREFIX, stored: masterPayload !== undefined },
    };
    if (!measure.fits) {
        return fail("too-big", [`${label}'s construction plan needs ${String(measure.bytes)} bytes but only ${String(measure.limit)} may be stored; nothing was changed. Try another seed= or a different place.`]);
    }
    if (masterMeasure !== undefined && !masterMeasure.fits) {
        return fail("too-big", [`the master plan needs ${String(masterMeasure.bytes)} bytes but only ${String(masterMeasure.limit)} may be stored; nothing was changed. Try another seed= or a different place.`]);
    }
    out.stats.opsMaxRun = ops.maxRun;
    seams.onOutcome?.(out);
    out.ok = true;
    out.stage = "planned";
    out.reasons = [];
    return out;
}

/**
 * A brand-new civilization: survey the terrain, rank sites, make and validate the master plan, then plan the
 * requested district on top of it.
 * @param {PlanContext} ctx @param {number} index
 * @returns {Promise<PlanOutcome>}
 */
async function planNewMaster(ctx, index) {
    /** @type {PlanOutcome} */
    const out = newOutcome(index, "scan");
    out.masterIsNew = true;
    const { token } = ctx;
    /** @param {string} stage @param {string[]} reasons */
    const fail = (stage, reasons) => {
        out.stage = stage;
        out.reasons = reasons;
        return out;
    };
    const explicit = ctx.siteMode === "here";

    // (a) progressive nearest-first survey, ring by ring, stopping as soon as a site is found - or, with
    // `site=here`, exactly as far as the master plan reaches (MASTER_REACH) and no further: the spot is chosen, only
    // its terrain has to be proven.
    // The master plan reaches MASTER_PLAN_RADIUS from the site centre, beyond the 480-block analysis window: keep that much clear.
    const progress = ctx.progress;
    const clearance = Math.max(SITE_DEFAULTS.exclusionMargin, PROTECT_MARGIN, MASTER_PLAN_RADIUS - SITE_DEFAULTS.windowSize / 2 + 24);
    const rankOptions = { searchRadius: explicit ? 0 : ctx.radius, exclusions: /** @type {any[]} */ (ctx.exclusions), exclusionMargin: clearance };
    const reach = MASTER_REACH;
    const scanRadius = explicit ? reach : Math.max(scanRadiusFor(rankOptions), ctx.radius + reach);
    /** @type {number[]} */
    const rings = [];
    if (!explicit) {
        for (let ring = reach + 24; ring < scanRadius; ring += 64) {
            rings.push(ring);
        }
    }
    rings.push(scanRadius);
    const tileSide = tileSizeNow();
    const chunksPerTile = (tileSide / 16) ** 2;
    const firstTiles = countTiles(ctx.anchor, /** @type {number} */ (rings[0]), tileSide);
    const allTiles = countTiles(ctx.anchor, scanRadius, tileSide);
    setPhase(progress, 1, "survey");
    ctx.say([
        explicit
            ? `[1/6] Using where you stand as the civilization anchor: surveying the ${String(scanRadius)}-block radius the master plan reaches (read-only, every ${String(SITE_DEFAULTS.step)}th column). No site is searched for.`
            : `[1/6] Surveying the terrain around you (read-only, every ${String(SITE_DEFAULTS.step)}th column), nearest first, ring by ring, stopping as soon as a suitable site is found.`,
        `      Up to ${String(allTiles * chunksPerTile)} chunks (first ring ${String(firstTiles * chunksPerTile)}, in ${String(tileSide)}-block tiles) may have to be generated and loaded; in a fresh world that can take minutes (an estimate until measured in Minecraft). Progress is reported at least every ${String(Math.round(CIV.heartbeatTicks / 20))} s.`,
    ]);
    /** @type {ReturnType<typeof rankSites> | undefined} */
    let ranking;
    let lastTileTick = nowTick();
    let lastSiteTick = 0;
    let lastSiteDistance = -1;
    const windowHalf = Math.ceil(SITE_DEFAULTS.windowSize / (2 * SITE_DEFAULTS.step)) * SITE_DEFAULTS.step;
    const coarse = await scanProgressive(token, ctx.dimension, ctx.anchor, scanRadius, SITE_DEFAULTS.step, {
        rings,
        progress,
        onTile() {
            const now = nowTick();
            if (progress !== undefined && now - lastTileTick > 100) {
                heartbeat(progress, true);
            }
            lastTileTick = now;
        },
        evaluate(field, ring, last, info) {
            if (explicit) {
                return false;
            }
            // Every tile is evaluated: a window is only certifiable once the read ground provably covers it
            // (`knownHalf`), and a caller can stop the survey many tiles before the end of a ring. Never guess:
            // the square is computed from the tile rectangles that actually loaded.
            const knownHalf = info !== undefined && Number.isFinite(info.knownHalf) ? info.knownHalf : ring;
            const searchRadius = last ? ctx.radius : Math.min(ctx.radius, Math.max(0, knownHalf - windowHalf - 2 * SITE_DEFAULTS.step));
            if (!last && searchRadius < 24) {
                return false;
            }
            const ranked = rankSites(field, ctx.anchor, { ...rankOptions, searchRadius });
            ranking = ranked;
            // A site closer than the part of the radius that is fully scanned cannot be beaten by anything unscanned
            // (score = distance + prep), so the answer equals the full-radius answer.
            const settled = last || (ranked.site !== null && ranked.site.score <= searchRadius);
            const atRingEnd = info === undefined || info.atRingEnd === true;
            if (settled) {
                if (atRingEnd) {
                    ctx.say([`      ring ${String(Math.round(ring))} scanned (${String(field.columnsRead)} columns): ${ranked.site !== null ? "suitable site found" : "no suitable site"}.`]);
                }
                return true;
            }
            if (atRingEnd) {
                ctx.say([`      ring ${String(Math.round(ring))} scanned (${String(field.columnsRead)} columns): ${ranked.site !== null ? "a site exists but a closer one could still be hiding, scanning on" : "no suitable site yet"}.`]);
            } else if (ranked.site !== null) {
                const distance = Math.round(ranked.site.distance);
                const now = nowTick();
                if (Math.abs(distance - lastSiteDistance) >= 32 || now - lastSiteTick >= 20 * 60) {
                    lastSiteDistance = distance;
                    lastSiteTick = now;
                    ctx.say([`      ${String(info?.tilesDone ?? 0)} of ${String(info?.tilesTotal ?? 0)} tiles read (${String(field.columnsRead)} columns): suitable terrain ${String(distance)} blocks away; confirming the rest of its window before stopping.`]);
                }
            }
            return false;
        },
    });
    out.stats.coarse = coarse.stats;
    out.stats.survey = { tilesScanned: coarse.stats.attempted, tilesTotal: coarse.tilesTotal, chunksScanned: coarse.stats.chunksScanned, scannedRadius: coarse.scannedRadius, fullRadius: scanRadius, early: coarse.early, rings: coarse.stats.ringsDone, mode: explicit ? "here" : "search" };
    if (coarse.cancelled) {
        out.cancelled = true;
        return fail("cancelled", ["cancelled"]);
    }
    if (coarse.stats.aborted !== undefined) {
        return fail("stalled", [coarse.stats.aborted]);
    }
    if (coarse.field.columnsRead === 0) {
        return fail("scan", ["no terrain could be read around you (every column was unloaded)"]);
    }

    // (b) the ranking of the last evaluated ring decides - or, with `site=here`, the one window centred on you
    setPhase(progress, 2, "ranking sites");
    ctx.say([`[2/6] Surveyed ${String(coarse.stats.attempted)} of ${String(coarse.tilesTotal)} tiles (${String(coarse.stats.chunksScanned)} chunks, ${String(coarse.field.columnsRead)} columns read, ${String(coarse.stats.unloaded)} unloaded${coarse.early ? ", stopped early" : ""}).`]);
    const coverage = coverageProblem(coarse.stats);
    if (coverage !== undefined) {
        ctx.say([`      ${coverage}`]);
    }
    // The last ring's ranking ran before the retry pass filled the tiles that stalled, so a field that has
    // just been completed would otherwise be judged on its holes.
    if (!explicit && coarse.stats.recoveredTiles > 0) {
        ranking = rankSites(coarse.field, ctx.anchor, { ...rankOptions, searchRadius: ctx.radius });
    }
    if (explicit) {
        ranking = rankSites(coarse.field, ctx.anchor, { ...rankOptions, searchRadius: 0 });
    }
    if (ranking === undefined) {
        return fail("site", ["no ring could be evaluated"]);
    }
    const found = /** @type {ReturnType<typeof rankSites>} */ (ranking);
    out.stats.ranking = { evaluated: found.evaluated, reads: found.reads, mode: explicit ? "here" : "search" };
    if (found.site === null) {
        const reasons = explicit ? [`where you stand is not suitable: ${found.reasons.slice(0, 6).join("; ")}`] : found.reasons.slice(0, 8);
        if (coverage !== undefined) {
            reasons.push(coverage);
        }
        return fail("site", reasons);
    }
    const siteFound = found.site;
    out.site = siteFound;
    ctx.policy = siteTerrainPolicy(siteFound);
    if (ctx.policy.allowWater || ctx.policy.maxRelief > 8) {
        const terrain = ctx.policy.allowWater ? "wet: lots and roads stand on pillars over the water" : "rough: houses stand on decks on pillars and climb by stairs";
        ctx.say([`      Terrain: ${String(Math.round(siteFound.waterFraction * 100))}% water, ${String(Math.round(siteFound.steepFraction * 100))}% steep; ${terrain} (estimated ${String(siteFound.prep.total)} preparation blocks).`]);
    }

    // (c)-(f) master plan, validation, full-resolution ground, district plan: every heavy step is a budgeted generator
    // charged to ONE operation meter (no stretch between yields may exceed ~25,000 elementary operations).
    const ops = newOps();
    out.stats.ops = ops;
    /** @type {string[]} */
    const history = [];
    out.stats.history = history;
    for (let attempt = 0; attempt < WORLD_ATTEMPTS; attempt += 1) {
        const planSeed = (ctx.seed + 7919 * attempt) | 0;
        setPhase(progress, 3, "master plan");
        ctx.say([`[3/6] ${explicit ? "Anchor accepted" : `Site found ${String(Math.round(siteFound.distance))} blocks away`}; planning five districts${attempt > 0 ? ` (retry ${String(attempt)}, seed ${String(planSeed)})` : ""}...`]);
        const made = await runJobAsync(token, planMasterSteps(coarse.field, { seed: planSeed, anchor: { x: siteFound.x, z: siteFound.z }, radius: MASTER_PLAN_RADIUS, ops, policy: ctx.policy }), progress);
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
        const read = await readRegion(ctx, plan, index, true);
        if (token.cancelled) {
            out.cancelled = true;
            return fail("cancelled", ["cancelled"]);
        }
        if (!read.ok) {
            history.push(`attempt ${String(attempt)}: ${read.stage}: ${read.problems.slice(0, 3).join(" | ")}`);
            out.stage = read.stage;
            out.reasons = read.problems;
            if (read.stage !== "site-plan" && read.stage !== "containment") {
                return out;
            }
            continue;
        }
        out.region = read.region;
        out.groundField = read.fine.field;
        out.stats.fine = read.fine.stats;
        const planned = await planDistrictTail(ctx, plan, index, planSeed, out, true);
        if (planned.ok) {
            planned.stats.planAttempts = attempt + 1;
            return planned;
        }
        if (planned.cancelled || planned.fatal !== false) {
            return planned;
        }
        history.push(`attempt ${String(attempt)}: ${planned.stage}: ${planned.reasons.slice(0, 3).join(" | ")}`);
        out.groundField = undefined;
        out.region = undefined;
    }
    out.stats.opsMaxRun = ops.maxRun;
    out.stats.planAttempts = WORLD_ATTEMPTS;
    out.plan = undefined;
    out.reasons = [...out.reasons, `(all ${String(WORLD_ATTEMPTS)} planning attempts failed: ${history.join(" || ").slice(0, 400)})`];
    return out;
}

/**
 * Master plan + independent validation as one generator.
 * @param {any} field @param {{ seed: number, anchor: { x: number, z: number }, radius: number, ops: import("../civ/regions.js").Ops, policy?: any }} options
 * @returns {Generator<void, { ok: true, plan: any } | { ok: false, stage: string, problems: string[] }, void>}
 */
function* planMasterSteps(field, options) {
    const made = yield* planCivilizationDetailedSteps(field, { seed: options.seed, anchor: options.anchor, radius: options.radius, ops: options.ops, policy: options.policy });
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
 * ONE district's construction plan, its containment check and its ground export as one generator.
 * A district the composer has no layout for is refused here and the refusal reason is what the caller reports.
 *
 * @param {any} plan @param {number} index @param {any} clipped @param {Rect} region @param {any} rawField
 * @param {{ seed: number, excludeFootprints: ProtectedArea[], ops: import("../civ/regions.js").Ops, policy?: any }} options
 * @returns {Generator<void, { ok: true, record: any, ground: any, notes: string[] } | { ok: false, stage: string, problems: string[], retry?: boolean }, void>}
 */
function* planSiteSteps(plan, index, clipped, region, rawField, options) {
    if (!planHasDistrict(plan, index)) {
        return { ok: false, stage: "site-plan", problems: [`the stored master plan has no district ${String(index)}`], retry: false };
    }
    const site = yield* seams.planSite(plan, index, clipped, { seed: options.seed, excludeFootprints: options.excludeFootprints, ops: options.ops, policy: options.policy });
    if (!site.ok || site.record === null || site.problems.length > 0) {
        return { ok: false, stage: "site-plan", problems: [`district ${String(index)} has no construction plan yet: ${site.problems.slice(0, 8).join(" | ")}`], retry: true };
    }
    if (clipped.outsideReads() > 0) {
        const first = clipped.firstOutside();
        return { ok: false, stage: "site-plan", problems: [`the planner read ground outside the stored region at ${String(first?.x)},${String(first?.z)}`], retry: true };
    }
    const contained = yield* siteContainmentProblemsSteps(plan, index, site.record, options.ops);
    if (contained.length > 0) {
        return { ok: false, stage: "containment", problems: ["a structure would leave its district", ...contained.slice(0, 6)], retry: true };
    }
    const ground = yield* exportSiteGroundSteps(rawField, region, options.ops);
    markYield(options.ops);
    return { ok: true, record: site.record, ground, notes: site.notes };
}

/**
 * Does this master plan hold the district at all (1..5 and a bbox the region can be derived from)?
 * @param {any} plan @param {number} index
 */
export function planHasDistrict(plan, index) {
    const entry = /** @type {any[]} */ (plan?.districts ?? []).find((district) => district?.index === index);
    if (entry === undefined) {
        return false;
    }
    try {
        siteGroundRegion(plan, index);
    } catch (_error) {
        return false;
    }
    return true;
}

/**
 * Human numbers for a successful planning outcome (plan-only report and the pre-build summary), for the district
 * the outcome planned.
 * @param {PlanOutcome} outcome
 */
export function describePlan(outcome) {
    const plan = outcome.plan;
    const record = outcome.record;
    const index = outcome.district ?? 1;
    const entry = /** @type {any[]} */ (plan?.districts ?? []).find((district) => district?.index === index) ?? plan?.districts?.[0];
    const ops = siteOpCount(record);
    // Slices measured offline: build windows run about 3x the ideal ops/400 (stage ends, holds, trees); survey and planning
    // slices are the measured ones. One slice per tick is assumed (an ESTIMATE until measured in Minecraft).
    const buildSlices = Math.ceil((ops / CIV_LIMITS.maxBlocksPerSlice) * 3);
    const surveySlices = (outcome.stats.coarse?.slices ?? 0) + (outcome.stats.fine?.slices ?? 0) * (outcome.stats.planAttempts ?? 1);
    const planSlices = outcome.stats.ops?.yields ?? 0;
    const slices = buildSlices + surveySlices + planSlices;
    const ticks = Math.ceil(slices / CIV_LIMITS.slicesPerTick);
    /** @type {(list: any) => number} */
    const sizeOf = (list) => (Array.isArray(list) ? list.length : 0);
    return {
        district: index,
        districtId: districtIdFor(index),
        name: entry?.name ?? `district ${String(index)}`,
        layoutId: record?.layoutId ?? outcome.layoutId,
        centre: { x: Math.round(entry?.centroid?.x ?? 0), z: Math.round(entry?.centroid?.z ?? 0) },
        hq: entry?.hq,
        areas: /** @type {number[]} */ (plan.stats.perDistrictArea),
        compactness: /** @type {number[]} */ (plan.stats.compactness),
        bboxFill: /** @type {number[]} */ (plan.stats.bboxFill),
        wallLength: plan.stats.wallLength,
        gateCount: plan.stats.gateCount,
        roadLength: plan.stats.roadLength,
        lots: sizeOf(record?.lots),
        elements: SITE_STAGE_NAMES.reduce((sum, stage) => sum + sizeOf(record?.[stage]), 0),
        ops,
        // Reported, never silently ignored: `ok:true` only means the geometry is sound, not that the
        // district got the facility mix its role promises. A shortcoming is not a reason to refuse an
        // in-game build, so this is loud output here and a hard assertion in the offline audit tests.
        // Only the single-district half of the audit runs: the city-wide rules compare the five roles
        // against each other and would call a flawless lone district "jammed" for having no neighbours yet.
        facilityProblems: auditRecord(record),
        shortfalls: shortfallOf(record),
        slices,
        minutes: Math.round((ticks / CIV_LIMITS.ticksPerSecond / 60) * 10) / 10,
        stored: outcome.stats.storage,
    };
}

/**
 * A whole-civilization read-out from the stored master plan alone: what each district claims and what is known of
 * its construction. NO terrain is read and nothing is written, so `civ:generate_plan district=all` is cheap.
 *
 * @param {any} plan the five-district master plan
 * @param {any} kingdom the loaded kingdom (its per-district `civ` records carry the measured op counts)
 * @returns {{ rows: Array<{ index: number, id: string, name: string, status: string, area: number, columns: number, ops: number, opsTotal: number, measured: boolean, estimated: number }>, totals: { columns: number, ops: number, measuredOps: number, measured: number, complete: number, building: number, paused: number, unbuilt: number }, problems: string[] }}
 */
export function civilizationOverview(plan, kingdom) {
    const districts = /** @type {any[]} */ (plan?.districts ?? []);
    /** @type {Array<{ index: number, id: string, name: string, status: string, area: number, columns: number, ops: number, opsTotal: number, measured: boolean, estimated: number }>} */
    const rows = [];
    const totals = { columns: 0, ops: 0, measuredOps: 0, measured: 0, complete: 0, building: 0, paused: 0, unbuilt: 0 };
    if (districts.length === 0) {
        return { rows, totals, problems: ["no master plan is stored: there is nothing to total up (run civ:generate_plan first)"] };
    }
    for (const entry of districts) {
        const index = Number(entry?.index);
        if (!Number.isInteger(index)) {
            continue;
        }
        let columns = 0;
        try {
            const region = siteGroundRegion(plan, index);
            columns = (region.x1 - region.x0 + 1) * (region.z1 - region.z0 + 1);
        } catch (_error) {
            columns = 0;
        }
        const civ = /** @type {any[]} */ (kingdom?.districts ?? []).find((district) => district.id === districtIdFor(index))?.civ;
        const measured = civ !== undefined && Number.isInteger(civ.opsTotal);
        rows.push({
            index,
            id: districtIdFor(index),
            name: String(entry?.name ?? ""),
            status: String(civ?.status ?? "not built"),
            area: Number(plan?.stats?.perDistrictArea?.[index - 1] ?? 0),
            columns,
            ops: measured ? Number(civ.opsTotal) : 0,
            opsTotal: measured ? Number(civ.opsTotal) : 0,
            measured,
            estimated: 0,
        });
        totals.columns += columns;
        if (civ?.status === "complete") totals.complete += 1;
        else if (civ?.status === "building") totals.building += 1;
        else if (civ?.status === "paused") totals.paused += 1;
        else totals.unbuilt += 1;
        if (measured) {
            totals.measured += 1;
            totals.measuredOps += Number(civ.opsTotal);
        }
    }
    // Districts nobody has surveyed yet: scale the measured work of the ones that have, per claimed column.
    const perColumn = totals.measuredOps > 0 && rows.some((row) => row.measured && row.ops > 0)
        ? totals.measuredOps / rows.filter((row) => row.measured).reduce((sum, row) => sum + row.columns, 0)
        : 0;
    for (const row of rows) {
        row.estimated = row.measured ? 0 : Math.round(row.columns * perColumn);
        totals.ops += row.measured ? row.ops : row.estimated;
    }
    return { rows, totals, problems: [] };
}

/**
 * Take back what `persistRun` stored when the run cannot be authorised after all (an unwritable kingdom record):
 * this district's queue and site payload, and the master plan too when this world made it in this same run.
 * Never touches another district's slots.
 *
 * @param {PlanOutcome} outcome
 * @returns {string[]} what could not be cleared
 */
export function discardRun(outcome) {
    const index = outcome.district ?? 1;
    const { planStore, siteStore, jobStore } = stores(index);
    /** @type {string[]} */
    const failed = [];
    try {
        jobStore.clear();
    } catch (error) {
        failed.push(`queue: ${String(error)}`);
    }
    try {
        siteStore.clear();
    } catch (error) {
        failed.push(`site plan: ${String(error)}`);
    }
    if (outcome.masterIsNew === true) {
        try {
            planStore.clear();
        } catch (error) {
            failed.push(`master plan: ${String(error)}`);
        }
    }
    return failed;
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

/** @param {number} [index] @returns {{ planStore: PlanStore, siteStore: PlanStore, jobStore: ReturnType<typeof jobs.createJobStore> }} */
function stores(index = 1) {
    return { planStore: createPlanStore(world), siteStore: siteStoreFor(index), jobStore: jobStoreFor(index) };
}

/**
 * Store what this run planned: the civilization's ONE master plan (only when this run made it), this district's OWN
 * site payload and this district's OWN job queue.
 * The ordering discipline is unchanged and is what makes a crash harmless: every size is measured BEFORE the first
 * property write, and a queue write that fails takes the payloads it would have orphaned back down with it.
 *
 * @param {PlanOutcome} outcome
 * @returns {{ ok: boolean, reason?: string, queue?: JobQueue, saved?: any, savedMaster?: any, bytes?: Record<string, number> }}
 */
export function persistRun(outcome) {
    const index = outcome.district ?? 1;
    assertIndex(index);
    const { planStore, siteStore, jobStore } = stores(index);
    try {
        // Check the queue BEFORE any plan is stored, so an oversize queue can never leave an orphan plan behind.
        const queue = jobs.createQueue(jobSpecsOf(outcome.record), { planHash: outcome.record.checksum, maxAttempts: 8 });
        const queueBytes = utf8Length(jobs.serializeQueue(queue));
        const queueLimit = seams.maxJobBytes ?? CIV_LIMITS.maxJobBytes;
        if (queueBytes > queueLimit) {
            return { ok: false, reason: `the ${districtIdFor(index)} job queue would need ${String(queueBytes)} bytes but only ${String(queueLimit)} may be stored; nothing was stored` };
        }
        const siteBytes = utf8Length(JSON.stringify(outcome.payload));
        const planLimit = seams.maxPlanBytes ?? CIV_LIMITS.maxPlanBytes;
        if (siteBytes > planLimit) {
            return { ok: false, reason: `the ${districtIdFor(index)} site plan would need ${String(siteBytes)} bytes but only ${String(planLimit)} may be stored; nothing was stored` };
        }
        const fresh = outcome.masterIsNew === true && outcome.master !== undefined;
        if (fresh && !planStore.measurePlan(outcome.master).fits) {
            return { ok: false, reason: `the master plan would need ${String(utf8Length(JSON.stringify(outcome.master)))} bytes but only ${String(planLimit)} may be stored; nothing was stored` };
        }
        const savedMaster = fresh ? planStore.savePlan(outcome.master) : undefined;
        if (savedMaster !== undefined && !savedMaster.ok) {
            return { ok: false, reason: `could not store the master plan (${String(savedMaster.reason ?? savedMaster.status)})` };
        }
        const saved = siteStore.savePlan(outcome.payload);
        if (!saved.ok) {
            if (savedMaster !== undefined && savedMaster.ok) {
                try {
                    planStore.clear();
                } catch (_error) {
                    // best effort: a master plan without a record is harmless
                }
            }
            return { ok: false, reason: `could not store the district plan (${String(saved.reason ?? saved.status)})` };
        }
        const queued = jobStore.saveQueue(queue);
        if (!queued.ok) {
            try {
                siteStore.clear();
                if (savedMaster !== undefined && savedMaster.ok) {
                    planStore.clear();
                }
            } catch (_error) {
                // best effort: the plan without a record is harmless
            }
            return { ok: false, reason: `could not store the job queue (${String(queued.reason ?? queued.status)})` };
        }
        return { ok: true, queue, saved, savedMaster, bytes: { queue: queueBytes, site: siteBytes, master: savedMaster !== undefined ? savedMaster.bytes : 0 } };
    } catch (error) {
        return { ok: false, reason: `storage failed: ${String(error)}` };
    }
}

/**
 * What a restart needs for ONE district: its master plan (shared, the single plan slot) plus its own site payload
 * slot (sitePrefixFor) and its own queue slot (jobPrefixFor). Nothing here touches another district's data, and the
 * checksum of the district's own `civ` record is still the gate: a payload that does not match is refused.
 *
 * Heavy work (rebuilding the plan from the stored ground) runs as budgeted steps charged to `ops`.
 *
 * @param {{ checksum?: string, seed?: number }} civ the district.civ record
 * @param {import("../civ/regions.js").Ops} ops
 * @param {number} [index]
 * @returns {Generator<void, { ok: true, plan: any, record: any, queue: JobQueue, region: Rect, payload: any, district: number, recovered: number } | { ok: false, reasons: string[] }, void>}
 */
export function* loadSavedRunSteps(civ, ops, index = 1) {
    assertIndex(index);
    const { planStore, siteStore, jobStore } = stores(index);
    const loadedMaster = planStore.loadPlan();
    if (loadedMaster.status !== "ok" || loadedMaster.plan === undefined) {
        return { ok: false, reasons: [`the stored plan is ${loadedMaster.status}${loadedMaster.reason ? ` (${loadedMaster.reason})` : ""}; refusing to continue`] };
    }
    const master = loadedMaster.plan;
    const loadedSite = siteStore.loadPlan();
    // A world planned before districts had their own slots keeps district 1's ground in the master-plan slot.
    const legacy = loadedSite.status !== "ok" && index === 1 && master?.ground !== undefined ? master : undefined;
    const payload = loadedSite.status === "ok" && loadedSite.plan !== undefined ? loadedSite.plan : legacy;
    if (payload === undefined) {
        const reason = loadedSite.status === "ok" ? "it holds no ground" : loadedSite.reason;
        return { ok: false, reasons: [`the stored plan of ${districtIdFor(index)} is ${loadedSite.status}${reason ? ` (${reason})` : ""}; refusing to continue`] };
    }
    if (payload.site?.version !== SITE_PLAN_VERSION) {
        return { ok: false, reasons: [`the stored plan is site version ${String(payload.site?.version)}, this build understands ${String(SITE_PLAN_VERSION)}; refusing to continue`] };
    }
    if (Number.isInteger(payload.district) && payload.district !== index) {
        return { ok: false, reasons: [`the stored plan is district ${String(payload.district)}, not ${String(index)}; refusing to continue`] };
    }
    if (typeof civ.checksum !== "string" || payload.siteChecksum !== civ.checksum) {
        return { ok: false, reasons: [`the stored plan (${String(payload.siteChecksum)}) is not the one this district was started from (${String(civ.checksum)}); refusing to continue`] };
    }
    const plan = payload.plan ?? master.plan;
    if (plan === undefined || !planHasDistrict(plan, index)) {
        return { ok: false, reasons: [`the stored master plan holds no district ${String(index)}; refusing to continue`] };
    }
    /** @type {any} */
    let record;
    try {
        const result = yield* rehydrateSiteSteps(plan, index, payload.ground, { ...(payload.siteOptions ?? {}), expectChecksum: civ.checksum, ops });
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
    const same = fresh.total.length === queue.total.length && fresh.total.every((total, at) => total === queue.total[at] && fresh.hash[at] === queue.hash[at]);
    if (!same || queue.planHash !== record.checksum) {
        return { ok: false, reasons: ["the stored job queue does not belong to this plan; refusing to continue"] };
    }
    if (queue.state === "aborted") {
        return { ok: false, reasons: ["the stored job queue was aborted for good"] };
    }
    if (queue.state === "paused") {
        jobs.resume(queue);
    }
    return { ok: true, plan, record, queue, region: siteGroundRegion(plan, index), payload, district: index, recovered: loadedQueue.recovered ?? 0 };
}

/**
 * What ONE district's stored queue says, without a running session (restart / status read-out).
 * @param {number} index @param {{ recoverRunning?: boolean }} [options]
 * @returns {{ status: string, reason: string | undefined, state: string | undefined, pct: number | undefined, done: number | undefined, total: number | undefined }}
 */
export function storedQueueStatus(index, options = {}) {
    const { jobStore } = stores(index);
    const loaded = jobStore.loadQueue({ recoverRunning: options.recoverRunning });
    if (loaded.status !== "ok" || loaded.queue === undefined) {
        return { status: loaded.status, reason: loaded.reason, state: undefined, pct: undefined, done: undefined, total: undefined };
    }
    const overall = jobs.progress(loaded.queue);
    return { status: "ok", reason: undefined, state: loaded.queue.state, pct: overall.pct, done: overall.totalOps - overall.remainingOps, total: overall.totalOps };
}

/**
 * Measured save-size discipline: every key this pack's civilization stores, grouped by the store that owns it.
 * A key belongs to the LONGEST matching prefix, so a district's own site or queue slot is never counted as the
 * shared master-plan slot or as the plain district-1 queue.
 *
 * @returns {{ families: Array<{ prefix: string, keys: number, bytes: number, longestProperty: number, limit: number, overBudget: boolean, overProperty: boolean }>, totalBytes: number, problems: string[] }}
 */
export function storageFootprint() {
    /** @type {string[]} */
    let ids = [];
    try {
        ids = typeof world.getDynamicPropertyIds === "function" ? world.getDynamicPropertyIds() : [];
    } catch (_error) {
        ids = [];
    }
    /** @type {Array<{ prefix: string, limit: number, kind: string }>} */
    const stores = [
        { prefix: PLAN_PREFIX, limit: CIV_LIMITS.maxPlanBytes, kind: "plan" },
        ...DISTRICT_INDEXES.map((index) => ({ prefix: sitePrefixFor(index), limit: CIV_LIMITS.maxPlanBytes, kind: "plan" })),
        { prefix: jobs.JOB_PREFIX, limit: CIV_LIMITS.maxJobBytes, kind: "jobs" },
        ...DISTRICT_INDEXES.map((index) => ({ prefix: jobPrefixFor(index), limit: CIV_LIMITS.maxJobBytes, kind: "jobs" })),
    ];
    /** @type {Record<string, { keys: number, bytes: number, longest: number, limit: number, kind: string }>} */
    const found = {};
    for (const key of ids) {
        let match;
        for (const store of stores) {
            if (!key.startsWith(`${store.prefix}:`)) {
                continue;
            }
            if (match === undefined || store.prefix.length > match.prefix.length) {
                match = store;
            }
        }
        if (match === undefined) {
            continue;
        }
        let value;
        try {
            value = world.getDynamicProperty(key);
        } catch (_error) {
            continue;
        }
        if (typeof value !== "string") {
            continue;
        }
        const entry = found[match.prefix] ?? { keys: 0, bytes: 0, longest: 0, limit: match.limit, kind: match.kind };
        entry.keys += 1;
        entry.bytes += utf8Length(value);
        entry.longest = Math.max(entry.longest, value.length);
        found[match.prefix] = entry;
    }
    const families = Object.entries(found).map(([prefix, entry]) => ({
        prefix,
        kind: entry.kind,
        keys: entry.keys,
        bytes: entry.bytes,
        longestProperty: entry.longest,
        limit: entry.limit,
        overBudget: entry.bytes > entry.limit,
        overProperty: entry.longest > CIV_LIMITS.maxPropertyChars,
    }));
    const problems = families
        .filter((family) => family.overBudget || family.overProperty)
        .map((family) => `${family.prefix}: ${String(family.bytes)} bytes / ${String(family.limit)} budget, longest property ${String(family.longestProperty)} chars / ${String(CIV_LIMITS.maxPropertyChars)}`);
    return { families, totalBytes: families.reduce((sum, family) => sum + family.bytes, 0), problems };
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
 *   token: Job, dimension: Dimension, plan: any, record: any, queue: JobQueue, region: Rect,
 *   protectedRects: ProtectedArea[], district: number,
 *   say: (lines: string[]) => void,
 *   saveCiv: (patch: Record<string, any>) => boolean,
 *   onStageComplete?: (stage: string) => void,
 *   onEnd: (result: EndResult) => void,
 *   saveEveryOps?: number, progress?: import("./civProgress.js").Progress,
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
    resetProgressForTests();
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
                    const benign = isBenign(neighbour.id) || plannedAt(s, nx, ny, nz).nonAir.includes(neighbour.id);
                    if (!benign) {
                        reason = `${neighbour.id} touches a tree - may be a player build`;
                        break;
                    }
                    if (isTreePart(neighbour.id) && !visited.has(key(nx, ny, nz)) && Math.abs(nx - seed.x) <= CIV_TREE_REACH_H && Math.abs(ny - seed.y) <= CIV_TREE_REACH_V && Math.abs(nz - seed.z) <= CIV_TREE_REACH_H) {
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
        if (!inRect(wide, cell.x, cell.z) || inProtectedArea(s.opts.protectedRects, cell.x, cell.z)) {
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
    const insideNeighbourLand = inProtectedArea(s.opts.protectedRects, op.x, op.z);
    const fillsSharedBand = insideNeighbourLand && isSharedWallFill(s.opts.protectedRects, op);
    if (insideNeighbourLand && !fillsSharedBand) {
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
    // A wall filling in the shared band may stand on raw terrain and on nothing else. classifyCivOp decides
    // a block is "ours" when its id is one this plan targets at that cell, and two districts' walls are made
    // of the same stone: without this rule district 2's footing replaced 9 finished blocks of district 1's
    // wall face. The cost is that a SECOND operation on the same band cell is refused once the first one
    // stands there - at most a dressing block, because the column itself is already solid masonry.
    if (fillsSharedBand && verdict.action === "place" && !isRawTerrain(String(target.typeId))) {
        skip(`occupied by ${String(target.typeId)} in a finished neighbour's band`);
        return "ok";
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
        if (box.x1 - box.x0 + 1 <= windowMaxSpan() && box.z1 - box.z0 + 1 <= windowMaxSpan()) {
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
    const half = tileSizeNow() / 2;
    return { x0: cx - half, z0: cz - half, x1: cx + half - 1, z1: cz + half - 1 };
}

/** Persist the job queue and the small kingdom record. @param {Session} s @param {Record<string, any>} [extra] */
function persistProgress(s, extra = {}) {
    const { jobStore } = stores(s.opts.district ?? 1);
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
        if (s.opts.progress !== undefined) {
            touch(s.opts.progress);
            s.opts.progress.percent = overall.pct;
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
        s.opts.say([`Preparing the build of ${districtLabel(s.opts.district ?? 1, s.plan)}: indexing the plan...`]);
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
                const held = await holdArea(s.dimension, rect, s.token, CIV_TICKING_ID, s.opts.progress);
                if (!s.token.cancelled && (held.status === "stalled" || held.status === "shrink" || held.status === "error")) {
                    return await end("paused", `the chunks around ${String(rect.x0)},${String(rect.z0)} would not load (${String(held.note)}); nothing is lost - run /scriptevent civ:generate_resume district=${String(s.opts.district ?? 1)} when the area loads`);
                }
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
    const index = s.opts.district ?? 1;
    const entry = /** @type {any[]} */ (s.plan?.districts ?? []).find((district) => district?.index === index) ?? s.plan?.districts?.[0];
    const hq = entry?.hq ?? entry?.centroid;
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
    return { district: s.opts.district ?? 1, status: s.status, stage: s.lastStage, pct: overall.pct, done: overall.totalOps - overall.remainingOps, total: overall.totalOps, counts: s.counts, slice: s.slice };
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
 * @param {"cancelled" | "failed" | "stalled"} [finalState] how the session is recorded
 * @param {string} [error]
 * @returns {{ kind: string, stopped: ReturnType<typeof abortConstruction> } | undefined} undefined when no civilization job owns the slot
 */
export function abortCivJob(finalState = "cancelled", error = undefined) {
    const token = activeToken();
    if (token === undefined || !token.kind.startsWith("civ-")) {
        return undefined;
    }
    const stopped = abortConstruction();
    cancelActiveJob();
    releaseArea(token);
    finishProgress(getProgress(), finalState, error);
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
