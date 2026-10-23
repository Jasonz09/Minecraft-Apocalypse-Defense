import { expectedTags, ID_TAG_PREFIX, isLiveRecord, isManagedTag } from "./contract.js";
import { distanceSquared, LOD_LIMITS } from "./lod.js";

/**
 * Reconciliation: make the physical world match the records and the plan, with the fewest actions.
 *
 * Pure JS. The caller reads the world into `observed` and applies the returned actions. Nothing here
 * deletes a record; the only effects are on physical entities. Invariants, all tested:
 *   - each live record maps to AT MOST one physical entity (duplicates are despawned, keeper chosen by
 *     exact tag match, then lowest handle);
 *   - an entity whose id has no record, or whose record is dead or graduated, is despawned;
 *   - a live record in the plan with no entity gets a spawn (at most `maxSpawns` per call);
 *   - a kept entity with stale tags is retagged, and one that stands outside its leash is moved;
 *   - an UNTAGGED entity of a managed type inside a district is a remnant of a spawn whose tag-write
 *     never happened (a crash in between). It is adopted by the nearest unclaimed planned record of
 *     that district standing within leash reach of it; otherwise it is removed (unclaimedPolicy "remove");
 *   - idempotent: applying the actions and reconciling again with the same plan returns no actions.
 */

/** Entity type used for every person. Both kinds are villagers; the record decides which one. */
export const DEFAULT_TYPE_IDS = Object.freeze({ civilian: "minecraft:villager_v2", soldier: "minecraft:villager_v2" });

/**
 * @typedef {{ x: number, y: number, z: number }} Point
 * @typedef {{ handle: string, typeId: string, district: string | null, x: number, y: number, z: number, tags: string[] }} Observed
 * @typedef {{ op: "despawn", handle: string, id: string | null, reason: string }
 *   | { op: "tag", handle: string, id: string, add: string[], remove: string[] }
 *   | { op: "adopt", handle: string, id: string, add: string[], remove: string[] }
 *   | { op: "move", handle: string, id: string, to: Point }
 *   | { op: "spawn", id: string, district: string, kind: string, typeId: string, at: Point, tags: string[] }} Action
 * @typedef {{ desired: string[], placements: Record<string, Point>, materialise?: unknown[] }} PlanLike
 */

/**
 * Ids carried by the observed physical entities that have exactly one id tag. Feeds `planLod`.
 * @param {Observed[]} observed
 * @returns {string[]} sorted, unique
 */
export function physicalIds(observed) {
    const ids = new Set();
    for (const entity of observed) {
        const tagged = entity.tags.filter((tag) => tag.startsWith(ID_TAG_PREFIX));
        if (tagged.length === 1) ids.add(tagged[0].slice(ID_TAG_PREFIX.length));
    }
    return [...ids].sort();
}

/**
 * @param {string[]} tags
 * @returns {string[]} the id values carried by these tags
 */
function idsOf(tags) {
    return tags.filter((tag) => tag.startsWith(ID_TAG_PREFIX)).map((tag) => tag.slice(ID_TAG_PREFIX.length));
}

/**
 * @param {Observed} entity
 * @param {string[]} want
 */
function tagScore(entity, want) {
    const have = entity.tags.filter(isManagedTag);
    return have.length === want.length && want.every((tag) => have.includes(tag)) ? 1 : 0;
}

/**
 * @param {{ handle: string }} left
 * @param {{ handle: string }} right
 */
function byHandle(left, right) {
    return left.handle < right.handle ? -1 : left.handle > right.handle ? 1 : 0;
}

/**
 * Compute the minimal actions that bring `observed` in line with `records` and `plan`.
 *
 * @param {{
 *   records: import("./contract.js").PersonRecord[],
 *   observed: Observed[],
 *   plan: PlanLike,
 *   typeIds?: Partial<Record<"civilian" | "soldier", string>>,
 *   unclaimed?: "remove" | "keep",
 *   maxSpawns?: number,
 * }} input
 * @returns {{ actions: Action[], deferred: { id: string, reason: string }[], problems: string[] }}
 */
export function reconcile(input) {
    /** @type {Record<string, string>} */
    const typeIds = { ...DEFAULT_TYPE_IDS, ...(input.typeIds ?? {}) };
    const managedTypes = new Set(Object.values(typeIds));
    const unclaimedPolicy = input.unclaimed ?? "remove";
    const maxSpawns = input.maxSpawns ?? LOD_LIMITS.maxSpawnsPerTick;
    const records = new Map(input.records.map((record) => [record.id, record]));
    const desired = new Set(input.plan.desired);
    const placements = input.plan.placements;
    const leash = LOD_LIMITS.leash;
    const entities = input.observed.slice().sort(byHandle);

    /** @type {Action[]} */
    const despawns = [];
    /** @type {Action[]} */
    const updates = [];
    /** @type {Action[]} */
    const spawns = [];
    /** @type {{ id: string, reason: string }[]} */
    const deferred = [];
    /** @type {string[]} */
    const problems = [];

    /** @type {Map<string, Observed[]>} */
    const groups = new Map();
    /** @type {Observed[]} */
    const untagged = [];
    for (const entity of entities) {
        const ids = idsOf(entity.tags);
        if (ids.length === 0) {
            if (managedTypes.has(entity.typeId) && entity.district !== null) untagged.push(entity);
            continue;
        }
        if (ids.length > 1) {
            despawns.push({ op: "despawn", handle: entity.handle, id: null, reason: `carries ${String(ids.length)} record ids` });
            continue;
        }
        const list = groups.get(ids[0]) ?? [];
        list.push(entity);
        groups.set(ids[0], list);
    }

    /** @type {Map<string, string>} record id -> handle of the entity that will carry it */
    const claimed = new Map();
    for (const id of [...groups.keys()].sort()) {
        const list = /** @type {Observed[]} */ (groups.get(id));
        const record = records.get(id);
        if (record === undefined) {
            for (const entity of list) despawns.push({ op: "despawn", handle: entity.handle, id, reason: "orphan: no record carries this id" });
            continue;
        }
        if (!isLiveRecord(record)) {
            for (const entity of list) despawns.push({ op: "despawn", handle: entity.handle, id, reason: `record is ${record.state}` });
            continue;
        }
        if (!desired.has(id)) {
            for (const entity of list) despawns.push({ op: "despawn", handle: entity.handle, id, reason: "outside the plan" });
            continue;
        }
        const want = expectedTags(record);
        const ranked = list.slice().sort((left, right) => tagScore(right, want) - tagScore(left, want) || byHandle(left, right));
        const keeper = ranked[0];
        for (const extra of ranked.slice(1)) {
            despawns.push({ op: "despawn", handle: extra.handle, id, reason: "duplicate: the record already has an entity" });
        }
        claimed.set(id, keeper.handle);
        const have = keeper.tags.filter(isManagedTag);
        const add = want.filter((tag) => !have.includes(tag));
        const remove = have.filter((tag) => !want.includes(tag));
        if (add.length > 0 || remove.length > 0) updates.push({ op: "tag", handle: keeper.handle, id, add, remove });
        const place = placements[id];
        if (place !== undefined && distanceSquared(keeper, place) > leash * leash) {
            updates.push({ op: "move", handle: keeper.handle, id, to: { ...place } });
        }
    }

    for (const entity of untagged) {
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const id of [...desired].sort()) {
            if (claimed.has(id)) continue;
            const record = records.get(id);
            const place = placements[id];
            if (record === undefined || !isLiveRecord(record) || place === undefined) continue;
            if (record.district !== entity.district || typeIds[record.kind] !== entity.typeId) continue;
            const d2 = distanceSquared(entity, place);
            if (d2 <= leash * leash && d2 < bestDistance) {
                best = id;
                bestDistance = d2;
            }
        }
        if (best !== null) {
            claimed.set(best, entity.handle);
            const record = /** @type {import("./contract.js").PersonRecord} */ (records.get(best));
            updates.push({ op: "adopt", handle: entity.handle, id: best, add: expectedTags(record), remove: [] });
        } else if (unclaimedPolicy === "remove") {
            despawns.push({ op: "despawn", handle: entity.handle, id: null, reason: "untagged remnant with no planned record in reach" });
        }
    }

    let spawned = 0;
    for (const id of [...desired].sort()) {
        if (claimed.has(id)) continue;
        const record = records.get(id);
        const place = placements[id];
        if (record === undefined || !isLiveRecord(record) || place === undefined) {
            problems.push(`${id}: in the plan but has no live record or no placement`);
            continue;
        }
        if (spawned >= maxSpawns) {
            deferred.push({ id, reason: `spawn budget ${String(maxSpawns)} used` });
            continue;
        }
        spawned += 1;
        spawns.push({ op: "spawn", id, district: record.district, kind: record.kind, typeId: typeIds[record.kind] ?? DEFAULT_TYPE_IDS.civilian, at: { ...place }, tags: expectedTags(record) });
    }

    const actions = [...sortActions(despawns), ...sortActions(updates), ...sortActions(spawns)];
    return { actions, deferred, problems };
}

/**
 * @param {Action[]} actions
 * @returns {Action[]}
 */
function sortActions(actions) {
    return actions.slice().sort((left, right) => {
        const a = "handle" in left ? left.handle : left.id;
        const b = "handle" in right ? right.handle : right.id;
        if (a !== b) return a < b ? -1 : 1;
        return left.op < right.op ? -1 : left.op > right.op ? 1 : 0;
    });
}

/**
 * Pure model of applying actions to an observed list. Used by tests and to prove idempotency
 * without a world. `nextHandle` mints handles for spawns.
 * @param {Observed[]} observed
 * @param {Action[]} actions
 * @param {() => string} nextHandle
 * @returns {Observed[]}
 */
export function applyActions(observed, actions, nextHandle) {
    /** @type {Map<string, Observed>} */
    const world = new Map(observed.map((entity) => [entity.handle, { ...entity, tags: entity.tags.slice() }]));
    for (const action of actions) {
        if (action.op === "spawn") {
            const handle = nextHandle();
            world.set(handle, { handle, typeId: action.typeId, district: action.district, x: action.at.x, y: action.at.y, z: action.at.z, tags: action.tags.slice() });
        } else if (action.op === "despawn") {
            world.delete(action.handle);
        } else {
            const entity = world.get(action.handle);
            if (entity === undefined) throw new Error(`applyActions: no entity ${action.handle}`);
            if (action.op === "move") {
                entity.x = action.to.x;
                entity.y = action.to.y;
                entity.z = action.to.z;
            } else {
                entity.tags = entity.tags.filter((tag) => !action.remove.includes(tag)).concat(action.add.filter((tag) => !entity.tags.includes(tag)));
            }
        }
    }
    return [...world.values()].sort(byHandle);
}
