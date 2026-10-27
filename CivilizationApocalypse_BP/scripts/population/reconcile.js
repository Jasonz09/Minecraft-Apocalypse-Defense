import { findValidationProblems } from "../kingdom/state.js";
import { emptyCursor } from "./cursor.js";
import { buildGroupTable, chunkKeyOf, compareText, districtInFight, nearestDistance, parseGroupId, spotFor } from "./groups.js";
import { classifyTags, isCanonicalFor } from "./identity.js";
import { planLevels } from "./lod.js";
import { POP_ENTITY_TYPES, POP_SYNC_DEFAULTS } from "./settings.js";

/**
 * The pure reducer: reconcile(state, observation, tick, overrides) -> { actions, state, report }.
 *
 * It reads and returns data. It never touches the world, the kingdom records, or the clock, and it never
 * throws on bad world data (bad data is reported). It throws only for programmer errors: a non-integer tick
 * or an invalid override, both reported with the offending value.
 *
 * observation = {
 *   kingdom,            kingdom records (validated here; never mutated)
 *   entities,           [{ id, tags, x, y, z, loaded?, inFight?, valid? }] every entity the caller can see
 *   anchors,            [{ x, z }] players or other points that keep physical population near them
 *   homes,              { [districtId]: { x, y, z } } the physical origin of each district
 *   loadedChunks,       Set or array of "cx,cz" keys known to be loaded around the spots that matter
 * }
 *
 * Actions are data, applied in this order and only within the budgets:
 *   retag    make an entity's own tags exactly its canonical group tag (never a foreign tag)
 *   despawn  duplicates first, then demoted groups; only when the chunk is loaded and no fight is on
 *   spawn    admitted groups without a representative; only in a loaded chunk, never into a fight
 * Anything the reducer will not do is reported under `deferred` with a reason, never silently dropped.
 *
 * Idempotence: after the caller applies the actions and reconciles again at the same tick, the result is empty
 * whenever the budgets were not binding (the per-tick budget is carried in the state, so a repeat within one
 * tick cannot spend it twice).
 */

/**
 * @typedef {import("./settings.js").PopSyncConfig} PopSyncConfig
 * @typedef {import("./cursor.js").CursorState} CursorState
 * @typedef {import("./lod.js").LodInput} LodInput
 * @typedef {{ entityId: string, groupId: string, loaded: boolean, inFight: boolean, canonical: boolean }} Entry
 * @typedef {{ op: "spawn", groupId: string, district: string, kind: "civ" | "sol", index: number, at: { x: number, y: number, z: number }, typeId: string }} SpawnAction
 * @typedef {{ op: "despawn", entityId: string, groupId: string, reason: string }} DespawnAction
 * @typedef {{ op: "retag", entityId: string, groupId: string }} RetagAction
 */

/**
 * Merge overrides onto the defaults and refuse values that would break an invariant.
 * @param {Partial<PopSyncConfig>} [overrides]
 * @returns {PopSyncConfig}
 */
export function resolveConfig(overrides = {}) {
    /** @type {PopSyncConfig} */
    const config = {
        ...POP_SYNC_DEFAULTS,
        ...overrides,
        groupSize: { ...POP_SYNC_DEFAULTS.groupSize, ...(overrides.groupSize ?? {}) },
    };
    for (const key of /** @type {const} */ (["physicalRadius", "holdRadius", "coarseRadius"])) {
        const value = config[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new RangeError(`population config ${key} must be a finite radius of at least 0, got ${String(value)}`);
        }
    }
    if (config.holdRadius < config.physicalRadius || config.coarseRadius < config.holdRadius) {
        throw new RangeError(
            `population config radii must satisfy physicalRadius <= holdRadius <= coarseRadius, got ${String(config.physicalRadius)}, ${String(config.holdRadius)}, ${String(config.coarseRadius)}`,
        );
    }
    for (const key of /** @type {const} */ (["maxPhysicalPerDistrict", "maxPhysicalTotal", "maxSpawnsPerTick", "maxOpsPerTick", "workBudget"])) {
        const value = config[key];
        if (!Number.isInteger(value) || value < 1) {
            throw new RangeError(`population config ${key} must be a whole number of at least 1, got ${String(value)}`);
        }
    }
    if (!Number.isInteger(config.physicalFloorPerKind) || config.physicalFloorPerKind < 0) {
        throw new RangeError(`population config physicalFloorPerKind must be a whole number of at least 0, got ${String(config.physicalFloorPerKind)}`);
    }
    if (config.physicalFloorPerKind > config.maxPhysicalPerDistrict) {
        throw new RangeError(
            `population config physicalFloorPerKind ${String(config.physicalFloorPerKind)} cannot exceed maxPhysicalPerDistrict ${String(config.maxPhysicalPerDistrict)}`,
        );
    }
    for (const kind of /** @type {const} */ (["civ", "sol"])) {
        const value = config.groupSize[kind];
        if (!Number.isInteger(value) || value < 1) {
            throw new RangeError(`population config groupSize.${kind} must be a whole number of at least 1, got ${String(value)}`);
        }
    }
    return config;
}

/**
 * @param {any} state
 * @returns {CursorState}
 */
function normaliseState(state) {
    const base = emptyCursor();
    if (state === null || typeof state !== "object") {
        return base;
    }
    /** @param {unknown} value */
    const count = (value) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);
    return {
        tick: typeof state.tick === "number" && Number.isInteger(state.tick) && state.tick >= 0 ? state.tick : null,
        runs: count(state.runs),
        spawns: count(state.spawns),
        ops: count(state.ops),
        physical: Array.isArray(state.physical) ? state.physical.filter((/** @type {unknown} */ id) => parseGroupId(id) !== null) : [],
    };
}

/**
 * @param {number} tick
 */
function emptyReport(tick) {
    return {
        tick,
        clockReset: false,
        refused: /** @type {string | null} */ (null),
        hold: /** @type {string | null} */ (null),
        groups: { total: 0, physical: 0, coarse: 0, simulated: 0, capped: 0, chunkBlocked: 0 },
        observed: { entities: 0, own: 0, foreign: 0, unmanaged: 0, orphans: 0 },
        actions: { spawn: 0, despawn: 0, retag: 0 },
        pending: { spawn: 0, despawn: 0, retag: 0 },
        deferred: /** @type {Array<{ entityId: string | null, groupId: string, reason: string }>} */ ([]),
        adopted: /** @type {string[]} */ ([]),
        orphans: /** @type {Array<{ entityId: string, groupId: string | null, reason: string }>} */ ([]),
        drift: /** @type {any[]} */ ([]),
        problems: /** @type {string[]} */ ([]),
        budget: { spawnsUsed: 0, spawnLimit: 0, opsUsed: 0, opsLimit: 0 },
        physicalTotal: 0,
        work: 0,
        workBudget: 0,
        overBudget: false,
    };
}

/**
 * Sort with a comparator that is charged to the work meter. Sorting is the only super-linear step, so it is
 * the one that must stay visible in the benchmark.
 * @template T
 * @param {T[]} list
 * @param {(left: T, right: T) => number} compare
 * @param {{ ops: number }} meter
 * @returns {T[]}
 */
function countedSort(list, compare, meter) {
    return list.sort((left, right) => {
        meter.ops += 1;
        return compare(left, right);
    });
}

/**
 * The keeper of a group is the entry we can act on, preferring loaded, then in-fight (never remove a combatant
 * while a quieter twin is available), then the lowest entity id.
 * @param {Entry} left
 * @param {Entry} right
 */
function compareEntries(left, right) {
    if (left.loaded !== right.loaded) {
        return left.loaded ? -1 : 1;
    }
    if (left.inFight !== right.inFight) {
        return left.inFight ? -1 : 1;
    }
    return compareText(left.entityId, right.entityId);
}

/**
 * Group the observed entities by the group they claim. Only our namespace is read; foreign and untagged
 * entities are counted and left alone.
 * @param {any} list
 * @param {Map<string, any>} districts
 * @param {{ ops: number }} meter
 */
function indexEntities(list, districts, meter) {
    /** @type {Map<string, Entry[]>} */
    const byGroup = new Map();
    /** @type {Array<{ entityId: string, groupId: string | null, reason: string }>} */
    const orphans = [];
    let observed = 0;
    let own = 0;
    let foreign = 0;
    let unmanaged = 0;
    if (!Array.isArray(list)) {
        return { byGroup, orphans, observed, own, foreign, unmanaged };
    }
    for (const raw of list) {
        meter.ops += 1;
        if (raw === null || typeof raw !== "object" || typeof raw.id !== "string" || raw.valid === false) {
            continue;
        }
        observed += 1;
        const tags = Array.isArray(raw.tags) ? raw.tags : [];
        meter.ops += tags.length;
        const read = classifyTags(tags);
        foreign += read.foreign;
        if (read.ownTags.length === 0) {
            unmanaged += 1;
            continue;
        }
        own += 1;
        if (read.claims.length === 0) {
            orphans.push({ entityId: raw.id, groupId: null, reason: "unreadable-tag" });
            continue;
        }
        const groupId = read.claims[0];
        const parsed = parseGroupId(groupId);
        if (parsed === null || !districts.has(parsed.district)) {
            orphans.push({ entityId: raw.id, groupId, reason: "unknown-district" });
            continue;
        }
        /** @type {Entry} */
        const entry = {
            entityId: raw.id,
            groupId,
            loaded: raw.loaded !== false,
            inFight: raw.inFight === true,
            canonical: isCanonicalFor(read.ownTags, groupId),
        };
        const bucket = byGroup.get(groupId);
        if (bucket === undefined) {
            byGroup.set(groupId, [entry]);
        } else {
            bucket.push(entry);
        }
    }
    orphans.sort((left, right) => compareText(left.entityId, right.entityId));
    return { byGroup, orphans, observed, own, foreign, unmanaged };
}

/**
 * @param {unknown} list
 * @returns {Array<{ x: number, z: number }>}
 */
function normaliseAnchors(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    /** @type {Array<{ x: number, z: number }>} */
    const anchors = [];
    for (const anchor of list) {
        if (anchor !== null && typeof anchor === "object" && Number.isFinite(anchor.x) && Number.isFinite(anchor.z)) {
            anchors.push({ x: anchor.x, z: anchor.z });
        }
    }
    return anchors;
}

/**
 * @param {unknown} source
 * @returns {Map<string, { x: number, y: number, z: number }>}
 */
function normaliseHomes(source) {
    /** @type {Map<string, { x: number, y: number, z: number }>} */
    const homes = new Map();
    if (source === null || typeof source !== "object") {
        return homes;
    }
    for (const [districtId, point] of Object.entries(source)) {
        const candidate = /** @type {any} */ (point);
        if (candidate !== null && typeof candidate === "object" && Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && Number.isFinite(candidate.z)) {
            homes.set(districtId, { x: candidate.x, y: candidate.y, z: candidate.z });
        }
    }
    return homes;
}

/**
 * Honest drift, per district: what the records say against what is bound in the world. Drift is reported and
 * never corrected here: the records are authoritative.
 * @param {any} records
 * @param {ReturnType<typeof buildGroupTable>} table
 * @param {Map<string, Entry[]>} byGroup
 * @param {PopSyncConfig} config
 */
function driftFor(records, table, byGroup, config) {
    /** @type {Map<string, { bound: number, stale: number }>} */
    const tally = new Map();
    const tableIds = new Set(table.groups.map((group) => group.id));
    for (const group of table.groups) {
        if (byGroup.has(group.id)) {
            const row = tally.get(group.district) ?? { bound: 0, stale: 0 };
            row.bound += 1;
            tally.set(group.district, row);
        }
    }
    for (const [groupId, entries] of byGroup) {
        if (tableIds.has(groupId)) {
            continue;
        }
        const parsed = parseGroupId(groupId);
        if (parsed === null) {
            continue;
        }
        const row = tally.get(parsed.district) ?? { bound: 0, stale: 0 };
        row.stale += entries.length;
        tally.set(parsed.district, row);
    }
    return /** @type {any[]} */ (records.districts)
        .slice()
        .sort((left, right) => compareText(String(left.id), String(right.id)))
        .map((district) => {
            const row = tally.get(String(district.id)) ?? { bound: 0, stale: 0 };
            return {
                district: String(district.id),
                civilians: district.civilians,
                soldiers: district.soldiers,
                recordGroups: {
                    civ: Math.ceil(district.civilians / config.groupSize.civ),
                    sol: Math.ceil(district.soldiers / config.groupSize.sol),
                },
                boundGroups: row.bound,
                staleEntities: row.stale,
                unrepresented: { trainees: district.trainingQueue ?? 0, refugees: district.refugees ?? 0 },
            };
        });
}

/**
 * @param {any} state
 * @param {any} observation
 * @param {number} tick
 * @param {Partial<PopSyncConfig>} [overrides]
 * @returns {{ actions: Array<SpawnAction | DespawnAction | RetagAction>, state: CursorState, report: any }}
 */
export function reconcile(state, observation, tick, overrides = {}) {
    if (!Number.isInteger(tick) || tick < 0) {
        throw new RangeError(`reconcile: tick must be a non-negative integer, got ${String(tick)}`);
    }
    const config = resolveConfig(overrides);
    const prior = normaliseState(state);
    const meter = { ops: 0 };
    const report = emptyReport(tick);
    report.workBudget = config.workBudget;
    report.budget.spawnLimit = config.maxSpawnsPerTick;
    report.budget.opsLimit = config.maxOpsPerTick;

    const records = observation?.kingdom;
    const problems = records === null || typeof records !== "object" ? ["no kingdom records"] : findValidationProblems(records);
    if (problems.length > 0) {
        report.refused = problems.slice(0, 5).join("; ");
        return { actions: [], state: prior, report };
    }

    report.clockReset = prior.tick !== null && tick < prior.tick;
    const sameTick = prior.tick === tick;
    const spawnsSpent = sameTick ? prior.spawns : 0;
    const opsSpent = sameTick ? prior.ops : 0;

    /** @type {Map<string, any>} */
    const districts = new Map(records.districts.map(/** @param {any} district */ (district) => [String(district.id), district]));
    const anchors = normaliseAnchors(observation.anchors);
    const homes = normaliseHomes(observation.homes);
    const loaded = new Set(observation.loadedChunks ?? []);
    const table = buildGroupTable(records, config);
    report.problems = table.problems;

    const scan = indexEntities(observation.entities, districts, meter);
    report.observed = {
        entities: scan.observed,
        own: scan.own,
        foreign: scan.foreign,
        unmanaged: scan.unmanaged,
        orphans: scan.orphans.length,
    };
    report.orphans = scan.orphans;

    // Every table group, plus any group a bound entity claims that the records no longer hold (headcount 0).
    /** @type {Map<string, any>} */
    const groups = new Map();
    for (const group of table.groups) {
        groups.set(group.id, group);
    }
    for (const groupId of scan.byGroup.keys()) {
        const parsed = parseGroupId(groupId);
        if (!groups.has(groupId) && parsed !== null) {
            groups.set(groupId, { id: groupId, district: parsed.district, kind: parsed.kind, index: parsed.index, headcount: 0 });
        }
    }
    const ordered = countedSort([...groups.values()], (left, right) => compareText(left.id, right.id), meter);

    const hold = anchors.length === 0;
    /** @type {Map<string, { spot: { x: number, y: number, z: number } | null, kind: "civ" | "sol", index: number, district: string, fight: boolean }>} */
    const details = new Map();
    /** @type {LodInput[]} */
    const inputs = [];
    for (const group of ordered) {
        meter.ops += 1;
        const home = homes.get(group.district);
        const spot = group.headcount > 0 && home !== undefined ? spotFor(home, group.kind, group.index) : null;
        details.set(group.id, {
            spot,
            kind: group.kind,
            index: group.index,
            district: group.district,
            fight: districtInFight(districts.get(group.district)),
        });
        inputs.push({
            id: group.id,
            district: group.district,
            headcount: group.headcount,
            hasSpot: spot !== null,
            distance: spot !== null ? nearestDistance(spot, anchors) : Infinity,
            spotLoaded: spot !== null && loaded.has(chunkKeyOf(spot.x, spot.z)),
            bound: scan.byGroup.has(group.id),
        });
    }

    const plan = hold ? null : planLevels(inputs, config, meter);
    report.groups.total = table.groups.length;
    if (hold) {
        report.hold = "no anchor is near any player: nothing is spawned or demoted until one is; duplicates and retags are still resolved";
    }

    /** @type {SpawnAction[]} */
    const spawns = [];
    /** @type {DespawnAction[]} */
    const duplicates = [];
    /** @type {DespawnAction[]} */
    const demotions = [];
    /** @type {RetagAction[]} */
    const retags = [];
    /** @type {Array<{ entityId: string | null, groupId: string, reason: string }>} */
    const deferred = [];
    /** @type {string[]} */
    const adopted = [];
    /** @type {string[]} */
    let physicalNext = [];

    /**
     * A bound group keeps its representative. Surplus representatives are removed as duplicates (a duplicate removal
     * never loses a unit, so it is safe with or without a player near), and a non-canonical keeper is retagged.
     * @param {string} groupId
     * @param {{ fight: boolean }} detail
     * @param {Entry[]} entries ranked, keeper first
     */
    const keepRepresentative = (groupId, detail, entries) => {
        const keeper = entries[0];
        if (!prior.physical.includes(groupId)) {
            adopted.push(groupId);
        }
        if (!keeper.canonical && keeper.loaded) {
            retags.push({ op: "retag", entityId: keeper.entityId, groupId });
        }
        for (const surplus of entries.slice(1)) {
            if (!surplus.loaded) {
                deferred.push({ entityId: surplus.entityId, groupId, reason: "chunk-unloaded" });
            } else if (detail.fight || surplus.inFight) {
                deferred.push({ entityId: surplus.entityId, groupId, reason: "in-fight" });
            } else {
                duplicates.push({ op: "despawn", entityId: surplus.entityId, groupId, reason: "duplicate" });
            }
        }
    };

    for (const input of inputs) {
        const groupId = input.id;
        const detail = details.get(groupId);
        if (detail === undefined) {
            continue;
        }
        const entries = countedSort([...(scan.byGroup.get(groupId) ?? [])], compareEntries, meter);

        if (hold) {
            // No player is near: keep what exists, resolve duplicates, change nothing else. Hold admits nothing new,
            // so the intent carried forward is only what was already admitted; deferred representatives are not promoted
            // into it, which keeps the per-district and kingdom caps true of the cursor.
            if (entries.length > 0) {
                if (prior.physical.includes(groupId)) {
                    physicalNext.push(groupId);
                }
                keepRepresentative(groupId, detail, entries);
            }
            continue;
        }

        const decision = plan?.decisions.get(groupId);
        if (decision === undefined) {
            continue;
        }
        if (decision.admitted) {
            physicalNext.push(groupId);
            if (entries.length === 0) {
                if (detail.fight) {
                    deferred.push({ entityId: null, groupId, reason: "spawn-in-fight" });
                } else if (detail.spot !== null) {
                    spawns.push({
                        op: "spawn",
                        groupId,
                        district: detail.district,
                        kind: detail.kind,
                        index: detail.index,
                        at: detail.spot,
                        typeId: POP_ENTITY_TYPES[detail.kind],
                    });
                }
            } else {
                keepRepresentative(groupId, detail, entries);
            }
        } else {
            for (const entry of entries) {
                if (!entry.loaded) {
                    deferred.push({ entityId: entry.entityId, groupId, reason: "chunk-unloaded" });
                } else if (detail.fight || entry.inFight) {
                    deferred.push({ entityId: entry.entityId, groupId, reason: "in-fight" });
                } else {
                    demotions.push({ op: "despawn", entityId: entry.entityId, groupId, reason: decision.reason });
                }
            }
        }
    }
    if (plan !== null) {
        Object.assign(report.groups, plan.counts);
    }

    // Budgets, in priority order: duplicates (the one-representative rule), retags (identity), demotions (capacity), spawns.
    let opsLeft = Math.max(0, config.maxOpsPerTick - opsSpent);
    let spawnsLeft = Math.max(0, config.maxSpawnsPerTick - spawnsSpent);
    /** @type {Array<SpawnAction | DespawnAction | RetagAction>} */
    const actions = [];
    for (const op of duplicates) {
        if (opsLeft > 0) {
            actions.push(op);
            opsLeft -= 1;
        } else {
            report.pending.despawn += 1;
        }
    }
    for (const op of retags) {
        if (opsLeft > 0) {
            actions.push(op);
            opsLeft -= 1;
        } else {
            report.pending.retag += 1;
        }
    }
    for (const op of demotions) {
        if (opsLeft > 0) {
            actions.push(op);
            opsLeft -= 1;
        } else {
            report.pending.despawn += 1;
        }
    }
    let spawned = 0;
    for (const op of spawns) {
        if (opsLeft > 0 && spawnsLeft > 0) {
            actions.push(op);
            opsLeft -= 1;
            spawnsLeft -= 1;
            spawned += 1;
        } else {
            report.pending.spawn += 1;
        }
    }

    report.actions = {
        spawn: actions.filter((action) => action.op === "spawn").length,
        despawn: actions.filter((action) => action.op === "despawn").length,
        retag: actions.filter((action) => action.op === "retag").length,
    };
    report.deferred = deferred;
    report.adopted = adopted;
    report.drift = driftFor(records, table, scan.byGroup, config);
    report.physicalTotal = physicalNext.length;
    report.budget = {
        spawnsUsed: spawnsSpent + spawned,
        spawnLimit: config.maxSpawnsPerTick,
        opsUsed: opsSpent + actions.length,
        opsLimit: config.maxOpsPerTick,
    };
    report.work = meter.ops;
    report.overBudget = meter.ops > config.workBudget;

    /** @type {CursorState} */
    const nextState = {
        tick,
        runs: prior.runs + 1,
        spawns: spawnsSpent + spawned,
        ops: opsSpent + actions.length,
        physical: physicalNext.slice().sort(compareText),
    };
    return { actions, state: nextState, report };
}
