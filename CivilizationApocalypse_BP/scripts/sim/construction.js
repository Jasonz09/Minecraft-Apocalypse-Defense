import { DISTRICT_DEFAULTS, PROJECT_TYPES, SIM } from "../config.js";
import { canAfford, pushEvent, spend } from "../kingdom/state.js";

/**
 * Staged, data-driven construction.
 *
 * This module only ever edits **saved simulation state**: it imports nothing from
 * `@minecraft/server`, reads no block, spawns no entity and needs no running game.
 * The Bedrock build adapter consumes exactly one thing from here - `collectBuildQueue()` -
 * which is a bounded, read-only description of the placement work in flight.
 *
 * Invariants (each one is asserted in dev/test/construction.test.mjs):
 *  1. A stage advances only when its `costPerStage` has really been paid out of the
 *     district's own reserves with `spend()`. A project that cannot pay is left
 *     `stalled` **with a reason**, never silently skipped.
 *  2. Builders always come out of `district.civilians` and never exceed it; they are
 *     released when a project completes or when the caller says the district cannot work.
 *  3. Existing defences are never removed. No exported function deletes a `walls`
 *     project, lowers `district.buildings.walls`, reduces `civilianCapacity` or lowers
 *     `defensiveIntegrity`. `cancelProject()` / `removeProject()` refuse `permanent: true`
 *     kinds and say why, and they also refuse to undo a completed structure.
 *
 * Step order owned by the tick, per district in stable id order:
 *   `assignBuilders(district, kingdom, { canWork })` then
 *   `advanceConstruction(district, { kingdom, canWork, reason })`,
 * where `canWork` is false while the district is under active attack. Placement is a
 * separate concern: the adapter polls `collectBuildQueue(kingdom)` and never drives state.
 */

/** Lifecycle values a project record can hold. Not in config.js, so it lives here. */
export const PROJECT_STATUS = {
    scheduled: "scheduled",
    active: "active",
    stalled: "stalled",
    complete: "complete",
    cancelled: "cancelled",
};

/** Statuses that still count as in-flight work (a `complete` project keeps its record). */
const OPEN_STATUSES = [PROJECT_STATUS.scheduled, PROJECT_STATUS.active, PROJECT_STATUS.stalled];

/**
 * Which `district.buildings` counter a completed project of a kind raises.
 * `gate`/`road` have no counter in `makeDistrict()`, so they are created on first use -
 * that is why every write goes through `raiseBuildingCount()`.
 * @type {Record<string, string>}
 */
export const BUILDING_KEYS = {
    walls: "walls",
    gate: "gates",
    road: "roads",
    homes: "homes",
    farms: "farms",
    storehouse: "storehouses",
    barracks: "barracks",
};

/** Kinds that may never be cancelled or removed. Derived from the catalogue, not hardcoded twice. */
export const PERMANENT_KINDS = Object.keys(PROJECT_TYPES).filter(
    (kind) => /** @type {Record<string, any>} */ (PROJECT_TYPES)[kind].permanent === true,
);

/**
 * Placement geometry used to describe in-flight work for the build adapter.
 * Pure arithmetic, never a world query.
 *
 * Geometry (documented so the adapter can reproduce it):
 *  - every district is centred on an arithmetic seat point `(seat * seatSpacing, seat * seatSpacing)`,
 *    where `seat` is the 1-based district seat already stored on the district;
 *  - a district's in-flight projects occupy concentric square bands around that point.
 *    The band radius of the project at queue position `bandIndex` is
 *    `ringMinRadius + (seat - 1) + bandIndex`, so no two districts and no two projects
 *    inside one district ever plan the same cells;
 *  - `walls` lay the whole perimeter of their band per stage (`8 * radius`, the cells of a
 *    square ring), `road` lays a straight spur of the band (`2 * radius` per stage),
 *    `gate` is a fixed 3x3 portal frame minus its inner cell (8 blocks), and the rest are
 *    fixed footprints.
 *  - `blocksPlanned = blocksPerStage * remainingStages`, so the number always shrinks as
 *    the project is paid for and reaches 0 when it completes.
 * @type {Record<string, any>}
 */
export const FOOTPRINT_RULES = {
    seatSpacing: 32,
    ringMinRadius: 4,
    /** Hard ceiling on the returned view, whatever the caller asks for. */
    maxEntries: 256,
    /** blocksPerStage for everything that is not ring-derived */
    fixed: { gate: 8, homes: 9, farms: 12, storehouse: 10, barracks: 14 },
};

/** Local tunables the shared config does not carry. */
export const CONSTRUCTION_RULES = {
    /** Integrity per assigned builder per step while at least one wall stands (see DISTRICT_DEFAULTS.integrityRepairPerStep). */
    repairUsesBuilders: true,
    /** defensiveIntegrity can only ever be repaired up to this ceiling. */
    integrityCeiling: 100,
};

/**
 * @param {string} kind
 * @returns {any} the PROJECT_TYPES entry, or undefined for an unknown kind
 */
function definitionOf(kind) {
    const catalogue = /** @type {Record<string, any>} */ (PROJECT_TYPES);
    return Object.prototype.hasOwnProperty.call(catalogue, kind) ? catalogue[kind] : undefined;
}

/** @returns {string} `"walls, gate, road, ..."` */
export function listProjectKinds() {
    return Object.keys(PROJECT_TYPES).join(", ");
}

/**
 * @param {any} value
 * @returns {number}
 */
function intOr0(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundTo2(value) {
    return Math.round(value * 100) / 100;
}

/**
 * In-flight projects in **insertion order**.
 *
 * The project array *is* the work queue: it is built in plan order (`EXPANSION_PROJECT_PLAN`
 * puts `walls` first) and survives a JSON round-trip unchanged, so array order is stable
 * without needing a sort key. Crews and step budget are handed out in that order, which is
 * what keeps the first planned work from being starved by later ones.
 *
 * @param {any} district
 * @returns {any[]}
 */
function openProjects(district) {
    const projects = /** @type {any[]} */ (district?.projects ?? []);
    return projects.filter((project) => project && OPEN_STATUSES.includes(String(project.status)));
}

/**
 * @param {any} left
 * @param {any} right
 */
function compareId(left, right) {
    const a = String(left ?? "");
    const b = String(right ?? "");
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}

/**
 * @param {any} district
 * @param {string} projectId
 * @returns {any}
 */
function findProject(district, projectId) {
    const projects = /** @type {any[]} */ (district?.projects ?? []);
    return projects.find((project) => project && project.id === projectId);
}

/**
 * Cost text for a stall reason, e.g. `materials 12 < 18`.
 * @param {any} reserves
 * @param {any} cost
 * @returns {string}
 */
function missingText(reserves, cost) {
    const short = [];
    for (const [key, amount] of Object.entries(cost ?? {})) {
        const have = Number(reserves?.[key] ?? 0);
        const need = Number(amount);
        if (have < need) {
            short.push(`${key} ${roundTo2(have)} < ${need}`);
        }
    }
    return short.join(", ");
}

/**
 * Mark a project as stalled with a loud, human-readable reason.
 * @param {any} project
 * @param {string} reason
 * @param {number} atStep
 */
function stallProject(project, reason, atStep) {
    project.status = PROJECT_STATUS.stalled;
    project.stalledReason = reason;
    project.stalledAtStep = atStep;
}

/**
 * Keep the labour ledger honest: no project may claim more builders than the district
 * has civilians, and `district.builders` must equal the sum of the in-flight crews.
 * @param {any} district
 * @returns {number} builders actually available to work
 */
function clampBuilders(district) {
    const pool = intOr0(district?.civilians);
    let remaining = pool;
    let total = 0;
    for (const project of openProjects(district)) {
        const wanted = intOr0(project.builders);
        const given = Math.min(wanted, remaining);
        project.builders = given;
        remaining -= given;
        total += given;
    }
    district.builders = total;
    return total;
}

/**
 * Create a staged project record and put it on the district.
 *
 * @param {any} district
 * @param {string} kind a key of PROJECT_TYPES
 * @param {{ id?: string, builders?: number, atStep?: number }} [options]
 * @returns {any} the project record
 */
export function scheduleProject(district, kind, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("scheduleProject: district must be an object");
    }
    if (typeof district.projects !== "object" || district.projects === null) {
        district.projects = [];
    }
    const name = String(kind);
    const definition = definitionOf(name);
    if (definition === undefined) {
        throw new Error(
            `scheduleProject: unknown project kind '${name}' for district ${String(district.id)}. ` +
                `Valid kinds are: ${listProjectKinds()}.`,
        );
    }

    const projects = /** @type {any[]} */ (district.projects);
    const sibling = projects.find((project) => project && project.kind === name);
    if (sibling !== undefined) {
        const siblingStatus = String(sibling.status);
        if (definition.permanent === true && siblingStatus !== PROJECT_STATUS.cancelled) {
            throw new Error(
                `scheduleProject: '${name}' is permanent work and district ${String(district.id)} already holds ` +
                    `${String(sibling.id)} (${siblingStatus}). Permanent defences are built once and are never ` +
                    `replaced, cancelled or removed automatically.`,
            );
        }
        if (!definition.permanent && OPEN_STATUSES.includes(siblingStatus)) {
            throw new Error(
                `scheduleProject: district ${String(district.id)} already has an in-flight '${name}' project ` +
                    `(${String(sibling.id)}, ${siblingStatus}). Wait for it or cancel it first.`,
            );
        }
    }

    const stageCount = intOr0(definition.stages);
    const sequence = projects.filter((project) => project?.kind === name).length + 1;
    const requestedBuilders = options.builders === undefined ? 0 : intOr0(options.builders);
    const project = {
        id: typeof options.id === "string" && options.id.length > 0
            ? options.id
            : `${String(district.id)}-${name}-${String(sequence)}`,
        districtId: String(district.id),
        kind: name,
        stage: 0,
        stageCount,
        /** Copied from PROJECT_TYPES so no caller can ever mutate the shared catalogue. */
        costPerStage: { ...definition.cost },
        buildersRequired: intOr0(definition.buildersRequired),
        builders: Math.min(requestedBuilders, intOr0(definition.buildersRequired), intOr0(district.civilians)),
        permanent: definition.permanent === true,
        status: PROJECT_STATUS.scheduled,
        stalledReason: null,
        stalledAtStep: null,
        workedSteps: 0,
        createdAtStep: intOr0(options.atStep),
        completedAtStep: null,
    };
    projects.push(project);
    clampBuilders(district);
    return project;
}

/**
 * Pull builders out of the district's own civilian pool for the in-flight projects.
 *
 * Crews are handed out in stable project-id order until the pool runs dry, so a district
 * with too few civilians still makes progress on the earliest work instead of spreading
 * itself thin. `district.builders` can never exceed `district.civilians`, and every
 * builder is released (project crews and the district total to 0) when `canWork` is false
 * - that is the "district is under active attack" path.
 *
 * @param {any} district
 * @param {any} kingdom only read, for the `atStep` stamp on the returned record
 * @param {{ canWork?: boolean, reason?: string }} [options]
 * @returns {{ districtId: string, assigned: number, needed: number, released: number, pool: number, atStep: number, reason: string | null }}
 */
export function assignBuilders(district, kingdom, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("assignBuilders: district must be an object");
    }
    const canWork = options.canWork !== false;
    const atStep = intOr0(kingdom?.step);
    const projects = openProjects(district);

    let needed = 0;
    for (const project of projects) {
        const definition = definitionOf(String(project.kind));
        needed += definition === undefined ? 0 : intOr0(definition.buildersRequired);
    }

    if (!canWork) {
        const released = intOr0(district.builders);
        projects.forEach((project) => {
            project.builders = 0;
        });
        district.builders = 0;
        return {
            districtId: String(district.id),
            assigned: 0,
            needed,
            released,
            pool: intOr0(district.civilians),
            atStep,
            reason: String(options.reason ?? "district cannot work"),
        };
    }

    const pool = intOr0(district.civilians);
    let remaining = pool;
    for (const project of projects) {
        const definition = definitionOf(String(project.kind));
        const wanted = definition === undefined ? 0 : intOr0(definition.buildersRequired);
        const given = Math.min(wanted, remaining);
        project.builders = given;
        remaining -= given;
    }
    clampBuilders(district);

    return {
        districtId: String(district.id),
        assigned: intOr0(district.builders),
        needed,
        released: Math.max(0, needed - intOr0(district.builders)),
        pool,
        atStep,
        reason: needed > pool && projects.length > 0 ? "civilian pool smaller than the queue" : null,
    };
}

/**
 * Give a completed structure its counter. Counts only ever rise - there is no
 * decrement path in this module, which is half of the "walls are never removed" guard.
 * @param {any} district
 * @param {string} kind
 * @returns {string} the buildings key that was raised
 */
function raiseBuildingCount(district, kind) {
    const keys = /** @type {Record<string, string>} */ (BUILDING_KEYS);
    const key = Object.prototype.hasOwnProperty.call(keys, kind) ? keys[kind] : kind;
    if (district.buildings === null || typeof district.buildings !== "object") {
        district.buildings = {};
    }
    district.buildings[key] = intOr0(district.buildings[key]) + 1;
    return key;
}

/**
 * Apply the effect of a finished project. Only additive: capacity goes up, building
 * counts go up, integrity may be repaired - nothing here ever takes anything away.
 * @param {any} district
 * @param {any} project
 * @returns {string}
 */
function applyProjectEffect(district, project) {
    const key = raiseBuildingCount(district, String(project.kind));
    switch (String(project.kind)) {
        case "homes":
            district.civilianCapacity = intOr0(district.civilianCapacity) + DISTRICT_DEFAULTS.capacityPerHome;
            return `${key} raised to ${String(district.buildings[key])}, civilian capacity now ` +
                `${String(district.civilianCapacity)} (+${String(DISTRICT_DEFAULTS.capacityPerHome)})`;
        case "farms":
            return `${key} raised to ${String(district.buildings[key])}, food output is now ` +
                `${roundTo2(Number(DISTRICT_DEFAULTS.foodPerFarmPerStep) * Number(district.buildings[key]))} per step`;
        default:
            return `${key} raised to ${String(district.buildings[key])}`;
    }
}

/**
 * Repair while the crew works. Monotonic by construction: it only adds, and it stops at
 * the ceiling, so `defensiveIntegrity` can never be lowered from this module.
 * @param {any} district
 * @param {boolean} canWork
 * @returns {string | null}
 */
function repairDefences(district, canWork) {
    if (!CONSTRUCTION_RULES.repairUsesBuilders || !canWork) {
        return null;
    }
    if (intOr0(district?.buildings?.walls) <= 0 || intOr0(district?.builders) <= 0) {
        return null;
    }
    const ceiling = Number(CONSTRUCTION_RULES.integrityCeiling);
    const integrity = Number(district.defensiveIntegrity ?? 0);
    if (!(integrity < ceiling)) {
        return null;
    }
    const repair = Number(DISTRICT_DEFAULTS.integrityRepairPerStep) * intOr0(district.builders);
    district.defensiveIntegrity = roundTo2(Math.min(ceiling, integrity + repair));
    return `walls repaired by ${roundTo2(repair)}, integrity ${String(district.defensiveIntegrity)}`;
}

/**
 * One construction step for one district.
 *
 * Each in-flight project consumes its crew's labour for the step and, at the stage
 * boundary, pays `costPerStage` from `district.reserves`. Failing to pay leaves the
 * project `stalled` with the exact shortfall in the reason and in the returned events,
 * so a stuck site is always reported instead of being quietly ignored.
 *
 * @param {any} district
 * @param {{ canWork?: boolean, reason?: string, kingdom?: any, atStep?: number }} [options]
 * @returns {{ districtId: string, advanced: number, stalled: number, completed: number, events: string[], atStep: number }}
 */
export function advanceConstruction(district, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("advanceConstruction: district must be an object");
    }
    const canWork = options.canWork !== false;
    const atStep = options.kingdom !== undefined ? intOr0(options.kingdom.step) : intOr0(options.atStep);
    /** @type {string[]} */
    const events = [];
    const result = { districtId: String(district.id), advanced: 0, stalled: 0, completed: 0, events, atStep };

    if (!canWork) {
        // Attack path: the crew walks off the site and back to the civilian pool.
        openProjects(district).forEach((project) => {
            project.builders = 0;
        });
        district.builders = 0;
    }
    clampBuilders(district);

    for (const project of openProjects(district)) {
        const definition = definitionOf(String(project.kind));
        if (definition === undefined) {
            stallProject(
                project,
                `unknown project kind '${String(project.kind)}' - valid kinds are: ${listProjectKinds()}`,
                atStep,
            );
            result.stalled += 1;
            events.push(`${String(district.name)}: STALLED ${String(project.id)} - ${String(project.stalledReason)}`);
            continue;
        }
        if (!canWork) {
            stallProject(
                project,
                `labour withdrawn: ${String(options.reason ?? "district is under active attack")}`,
                atStep,
            );
            result.stalled += 1;
            events.push(`${String(district.name)}: STALLED ${String(project.id)} - ${String(project.stalledReason)}`);
            continue;
        }

        const required = intOr0(definition.buildersRequired);
        if (intOr0(project.builders) < required) {
            stallProject(
                project,
                `short of builders: ${String(intOr0(project.builders))} of ${String(required)} on site`,
                atStep,
            );
            result.stalled += 1;
            events.push(`${String(district.name)}: STALLED ${String(project.id)} - ${String(project.stalledReason)}`);
            continue;
        }

        const cost = project.costPerStage ?? definition.cost;
        if (!canAfford(district.reserves, cost)) {
            stallProject(
                project,
                `cannot pay stage ${String(intOr0(project.stage) + 1)} of ${String(project.stageCount)} for ` +
                    `'${String(project.kind)}': ${missingText(district.reserves, cost)}`,
                atStep,
            );
            result.stalled += 1;
            events.push(`${String(district.name)}: STALLED ${String(project.id)} - ${String(project.stalledReason)}`);
            continue;
        }

        // The stage is bought, so progress and resources can never drift apart.
        spend(district.reserves, cost);
        project.stage = intOr0(project.stage) + 1;
        project.workedSteps = intOr0(project.workedSteps) + 1;
        project.status = PROJECT_STATUS.active;
        project.stalledReason = null;
        result.advanced += 1;

        if (project.stage >= intOr0(project.stageCount)) {
            project.status = PROJECT_STATUS.complete;
            project.stage = project.stageCount;
            project.completedAtStep = atStep;
            project.builders = 0; // released
            const effect = applyProjectEffect(district, project);
            result.completed += 1;
            events.push(`${String(district.name)}: ${String(project.kind)} COMPLETE (${project.id}) - ${effect}`);
        } else {
            events.push(
                `${String(district.name)}: ${String(project.kind)} stage ${String(project.stage)}/` +
                    `${String(project.stageCount)} paid (${JSON.stringify(cost)})`,
            );
        }
    }

    clampBuilders(district);
    const repair = repairDefences(district, canWork);
    if (repair !== null) {
        events.push(`${String(district.name)}: ${repair}`);
    }

    if (options.kingdom !== undefined) {
        events.forEach((event) => pushEvent(options.kingdom, event));
    }
    return result;
}

/**
 * Take a project off the active queue.
 *
 * Guarded by design: `permanent: true` kinds (see PERMANENT_KINDS) are refused with the
 * reason spelled out, and so is any completed project - a built structure is part of the
 * record and construction never demolishes one. That is the "existing district walls are
 * never automatically removed" rule, encoded as a hard error rather than a comment.
 *
 * @param {any} district
 * @param {string} projectId
 * @param {{ reason?: string, kingdom?: any }} [options]
 * @returns {any} the cancelled project record
 */
export function cancelProject(district, projectId, options = {}) {
    const project = findProject(district, projectId);
    if (project === undefined) {
        throw new Error(
            `cancelProject: district ${String(district?.id)} has no project '${String(projectId)}' to cancel`,
        );
    }
    const definition = definitionOf(String(project.kind));
    if (definition?.permanent === true) {
        throw new Error(
            `cancelProject: refused to cancel '${String(project.kind)}' (${String(project.id)}) in district ` +
                `${String(district.id)} - it is permanent work. Defences already raised are never removed ` +
                `automatically${options.reason ? ` (${String(options.reason)})` : ""}.`,
        );
    }
    if (String(project.status) === PROJECT_STATUS.complete) {
        throw new Error(
            `cancelProject: refused to remove ${String(project.id)} - the ${String(project.kind)} is already built, ` +
                `and completed structures stay on the record.`,
        );
    }

    project.status = PROJECT_STATUS.cancelled;
    project.builders = 0;
    project.cancelReason = String(options.reason ?? "cancelled by the commander");
    project.cancelledAtStep = intOr0(options.kingdom?.step);
    clampBuilders(district);
    if (options.kingdom !== undefined) {
        pushEvent(
            options.kingdom,
            `${String(district.name)}: ${String(project.kind)} project ${String(project.id)} cancelled - ` +
                `${String(project.cancelReason)}`,
        );
    }
    return project;
}

/**
 * Same guarded path as `cancelProject`, under the name the command layer prefers.
 * @param {any} district
 * @param {string} projectId
 * @param {{ reason?: string, kingdom?: any }} [options]
 */
export function removeProject(district, projectId, options = {}) {
    return cancelProject(district, projectId, options);
}

/**
 * @param {any} kind
 * @param {number} radius
 * @returns {number} blocks laid per stage at that band radius
 */
export function footprintBlocksPerStage(kind, radius) {
    const edge = Math.max(1, Math.floor(Number(radius) || 1));
    switch (String(kind)) {
        case "walls":
            // square ring: 4 sides, `edge` cells per side, corners shared -> 8 * radius
            return 8 * edge;
        case "road":
            return 2 * edge;
        default: {
            const fixed = /** @type {Record<string, number>} */ (FOOTPRINT_RULES.fixed);
            const value = Object.prototype.hasOwnProperty.call(fixed, String(kind)) ? fixed[String(kind)] : 0;
            return value;
        }
    }
}

/**
 * Read-only, bounded view of the placement work the in-flight projects represent.
 *
 * Deterministic (stable district then project id order), pure (it builds fresh plain
 * objects and mutates nothing), and free of any world access - it takes only the saved
 * kingdom. The Bedrock build adapter polls this and does the actual placement; nothing
 * in this module ever asks for a block.
 *
 * @param {any} kingdom
 * @param {number} [limit] maximum entries, default SIM.maxBlocksPerStep
 * @returns {Array<{ projectId: string, districtId: string, kind: string, stage: number, remainingStages: number, blocksPlanned: number }>}
 */
export function collectBuildQueue(kingdom, limit = SIM.maxBlocksPerStep) {
    const requested = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : SIM.maxBlocksPerStep;
    const budget = Math.max(0, Math.min(Number(FOOTPRINT_RULES.maxEntries), requested));
    /** @type {Array<{ projectId: string, districtId: string, kind: string, stage: number, remainingStages: number, blocksPlanned: number }>} */
    const queue = [];
    if (budget === 0) {
        return queue;
    }

    const districts = /** @type {any[]} */ (kingdom?.districts ?? [])
        .slice()
        .sort((left, right) => compareId(left?.id, right?.id));

    for (const district of districts) {
        if (queue.length >= budget) {
            break;
        }
        const projects = openProjects(district);
        projects.forEach((project, bandIndex) => {
            if (queue.length >= budget) {
                return;
            }
            const remaining = Math.max(0, intOr0(project.stageCount) - intOr0(project.stage));
            const radius = Number(FOOTPRINT_RULES.ringMinRadius)
                + Math.max(0, intOr0(district.seat) - 1)
                + bandIndex;
            queue.push({
                projectId: String(project.id),
                districtId: String(district.id),
                kind: String(project.kind),
                stage: intOr0(project.stage),
                remainingStages: remaining,
                blocksPlanned: footprintBlocksPerStage(project.kind, radius) * remaining,
            });
        });
    }
    return queue;
}
