import { world as runtimeWorld } from "@minecraft/server";
import { createKingdomStore } from "../kingdom/store.js";
import { buildGroupTable, chunkKeyOf, nearestDistance, spotFor } from "../population/groups.js";
import { classifyTags, tagFor } from "../population/identity.js";
import { cursorBytes, decodeCursor, encodeCursor } from "../population/cursor.js";
import { reconcile, resolveConfig } from "../population/reconcile.js";
import { CHUNK_SIZE, POP_CURSOR_KEY, POP_CURSOR_MAX_BYTES, POP_DISTRICT_OBSERVE_RADIUS, POP_TAG_NAMESPACE } from "../population/settings.js";

/**
 * Runtime boundary for the population representation layer (population/reconcile.js is the pure part).
 *
 * This file is thin on purpose. It reads the world into the reducer's observation, asks the reducer what to do,
 * and applies the result. It holds no rules of its own, and it is NOT wired into main.js: nothing here runs
 * until an integrator constructs it and calls reconcileOnce() on purpose. The pack default is off.
 *
 * Safety rules enforced here, on top of the reducer's:
 *  - the cursor is written only AFTER the actions are applied. A crash in between leaves the cursor behind the
 *    world, and the next run adopts the representatives it finds (identity is the tag, not the cursor);
 *  - every spawn is re-checked against a dimension-wide tag query first, so a representative that wandered
 *    outside the observation window is adopted, not duplicated;
 *  - every despawn and retag re-reads the entity's tags and requires the group it was planned for to still be
 *    claimed, and requires its chunk to be loaded at apply time;
 *  - only tags in the civpop: namespace are ever added or removed. Foreign tags and untagged units are never read
 *    for identity, retagged or removed;
 *  - a newer cursor version is never overwritten, and reconciliation refuses to run against it.
 *
 * Dependency injection (every field optional except dimension):
 *   world            dynamic property store for the cursor; defaults to the runtime world
 *   dimension        the Dimension to read and spawn in (getEntities, spawnEntity, getBlock)
 *   readKingdom      () => kingdom records, read only; defaults to kingdom/store.js load()
 *   anchors          () => [{ x, y, z }]; defaults to the players in this dimension
 *   homes            (kingdom) => { [districtId]: { x, y, z } }; defaults to each district's physical origin
 *   isChunkLoaded    ({ x, y, z }) => boolean; defaults to a block probe
 *   enabled          false by default; reconcileOnce refuses unless this is true
 *   config           overrides for population/settings.js POP_SYNC_DEFAULTS
 *
 * @param {any} deps
 */
export function createPopSync(deps = {}) {
    const world = deps.world ?? runtimeWorld;
    const dimension = deps.dimension;
    if (dimension === null || typeof dimension !== "object" || typeof dimension.getEntities !== "function" || typeof dimension.spawnEntity !== "function") {
        throw new TypeError("createPopSync: a dimension with getEntities and spawnEntity is required");
    }
    const config = resolveConfig(deps.config ?? {});
    const enabled = deps.enabled === true;
    const readKingdom = deps.readKingdom ?? (() => createKingdomStore(world).load().kingdom);
    const anchorsOf = deps.anchors ?? (() => playersIn(world, dimension));
    const homesOf = deps.homes ?? homesFromPhysical;

    /** @param {{ x: number, y: number, z: number }} point */
    const chunkLoadedAt = (point) => {
        try {
            if (typeof deps.isChunkLoaded === "function") {
                return deps.isChunkLoaded(point) === true;
            }
            return dimension.getBlock(point) !== undefined;
        } catch (_error) {
            return false;
        }
    };

    /** @param {string} tag */
    const findTagged = (tag) => {
        try {
            return /** @type {any[]} */ (dimension.getEntities({ tags: [tag] })).filter((handle) => handle.isValid !== false);
        } catch (_error) {
            return [];
        }
    };

    /**
     * Read one entity into the reducer's shape. Returns null when the handle is no longer usable.
     * @param {any} handle
     */
    const describe = (handle) => {
        try {
            if (handle.isValid === false) {
                return null;
            }
            const location = handle.location;
            return {
                id: String(handle.id),
                typeId: String(handle.typeId),
                tags: [...handle.getTags()],
                x: location.x,
                y: location.y,
                z: location.z,
                loaded: true,
                inFight: false,
            };
        } catch (_error) {
            return null;
        }
    };

    /**
     * Build the observation for one pass. Entities come from a radius around each district's home (so units are seen
     * whether or not a player is near) and around each anchor. The loaded-chunk set covers the spot of every group
     * within physicalRadius of an anchor (the only spots the reducer can use for a promotion).
     * Entities outside both windows are not observable here; the spawn guard covers representatives that wandered
     * that far.
     * @param {any} kingdom
     * @param {Array<{ x: number, y: number, z: number }>} anchors
     * @param {Record<string, { x: number, y: number, z: number }>} homes
     */
    const observe = (kingdom, anchors, homes) => {
        /** @type {Map<string, any>} */
        const handles = new Map();
        /** @type {any[]} */
        const entities = [];
        /** @param {any} handle */
        const admit = (handle) => {
            if (handles.has(handle.id)) {
                return;
            }
            const entity = describe(handle);
            if (entity !== null) {
                handles.set(entity.id, handle);
                entities.push(entity);
            }
        };
        const windows = [
            ...Object.values(homes).map((home) => ({ centre: home, radius: POP_DISTRICT_OBSERVE_RADIUS })),
            ...anchors.map((anchor) => ({ centre: anchor, radius: config.coarseRadius + CHUNK_SIZE })),
        ];
        for (const window of windows) {
            let found = [];
            try {
                found = dimension.getEntities({ location: window.centre, maxDistance: window.radius });
            } catch (_error) {
                found = [];
            }
            for (const handle of found) {
                admit(handle);
            }
        }

        /** @type {Set<string>} */
        const loadedChunks = new Set();
        /** @type {Set<string>} */
        const probed = new Set();
        for (const group of buildGroupTable(kingdom, config).groups) {
            const home = homes[group.district];
            if (home === undefined) {
                continue;
            }
            const spot = spotFor(home, group.kind, group.index);
            if (nearestDistance(spot, anchors) > config.physicalRadius) {
                continue;
            }
            const key = chunkKeyOf(spot.x, spot.z);
            if (probed.has(key)) {
                continue;
            }
            probed.add(key);
            if (chunkLoadedAt(spot)) {
                loadedChunks.add(key);
            }
        }
        for (const entity of entities) {
            loadedChunks.add(chunkKeyOf(entity.x, entity.z));
        }
        return { observation: { kingdom, entities, anchors, homes, loadedChunks }, handles, admit };
    };

    /**
     * One planning pass. If a planned spawn finds a representative outside the observation window, that
     * representative is added to the observation and the pass is repeated, so it is adopted rather than duplicated.
     * @param {any} prior
     * @param {any} kingdom
     * @param {number} tick
     */
    const plan = (prior, kingdom, tick) => {
        const anchors = normaliseAnchors(anchorsOf());
        const homes = homesOf(kingdom);
        const session = observe(kingdom, anchors, homes);
        let result = reconcile(prior, session.observation, tick, config);
        for (let pass = 0; pass < 2; pass += 1) {
            let discovered = 0;
            for (const action of result.actions) {
                if (action.op !== "spawn") {
                    continue;
                }
                for (const handle of findTagged(tagFor(action.groupId))) {
                    if (!session.handles.has(handle.id)) {
                        const before = session.observation.entities.length;
                        session.admit(handle);
                        discovered += session.observation.entities.length - before;
                    }
                }
            }
            if (discovered === 0) {
                break;
            }
            result = reconcile(prior, session.observation, tick, config);
        }
        return { result, handles: session.handles };
    };

    /**
     * @param {number} tick
     * @returns {{ refused: string | null, plan: any, cursor: string }}
     */
    const planFromStore = (tick) => {
        const loaded = decodeCursor(world.getDynamicProperty(POP_CURSOR_KEY));
        if (loaded.status === "newer") {
            return { refused: `cursor refused: ${String(loaded.reason)}`, plan: null, cursor: loaded.status };
        }
        const kingdom = readKingdom();
        if (kingdom === undefined || kingdom === null) {
            return { refused: "no kingdom records are stored yet", plan: null, cursor: loaded.status };
        }
        const planned = plan(loaded.state, kingdom, tick);
        return { refused: planned.result.report.refused ?? null, plan: planned, cursor: loaded.status };
    };

    /**
     * Compute what would happen. Reads the world; writes nothing.
     * @param {number} tick
     */
    function dryRun(tick) {
        const planned = planFromStore(tick);
        if (planned.plan === null) {
            return { refused: planned.refused, actions: [], report: null, nextState: null, cursor: planned.cursor, applied: false };
        }
        return {
            refused: planned.refused,
            actions: planned.plan.result.actions,
            report: planned.plan.result.report,
            nextState: planned.plan.result.state,
            cursor: planned.cursor,
            applied: false,
        };
    }

    /**
     * Apply the plan to the world, then save the cursor. Refused unless the caller enabled sync.
     * @param {number} tick
     */
    function reconcileOnce(tick) {
        if (!enabled) {
            return { refused: "population sync is disabled (the pack default); pass enabled: true to apply", actions: [], report: null, applied: [], skipped: [], failed: [], saved: false };
        }
        const planned = planFromStore(tick);
        if (planned.plan === null || planned.refused !== null) {
            return { refused: planned.refused, actions: [], report: planned.plan?.result.report ?? null, applied: [], skipped: [], failed: [], saved: false };
        }
        const outcome = applyActions(planned.plan.result.actions, planned.plan.handles);
        const saved = saveCursor(planned.plan.result.state);
        return {
            refused: null,
            actions: planned.plan.result.actions,
            report: planned.plan.result.report,
            applied: outcome.applied,
            skipped: outcome.skipped,
            failed: outcome.failed,
            saved: saved.saved,
            saveReason: saved.reason,
        };
    }

    /**
     * @param {any[]} actions
     * @param {Map<string, any>} handles
     */
    function applyActions(actions, handles) {
        /** @type {any[]} */
        const applied = [];
        /** @type {any[]} */
        const skipped = [];
        /** @type {any[]} */
        const failed = [];
        for (const action of actions) {
            try {
                /** @type {{ ok: boolean, reason: string | null, entityId?: string }} */
                const outcome = action.op === "spawn" ? spawnOne(action) : action.op === "despawn" ? removeOne(action, handles) : retagOne(action, handles);
                (outcome.ok ? applied : skipped).push({ action, reason: outcome.reason ?? null, entityId: outcome.entityId ?? action.entityId ?? null });
            } catch (error) {
                failed.push({ action, error: String(error) });
            }
        }
        return { applied, skipped, failed };
    }

    /**
     * @param {any} handle
     */
    const isLive = (handle) => {
        try {
            return handle.isValid !== false;
        } catch (_error) {
            return false;
        }
    };

    /**
     * @param {any} action
     * @param {Map<string, any>} handles
     */
    function removeOne(action, handles) {
        const handle = handles.get(action.entityId);
        if (handle === undefined || !isLive(handle)) {
            return { ok: false, reason: "gone" };
        }
        if (!classifyTags(handle.getTags()).claims.includes(action.groupId)) {
            return { ok: false, reason: "identity-changed" };
        }
        if (!chunkLoadedAt(handle.location)) {
            return { ok: false, reason: "chunk-unloaded" };
        }
        handle.remove();
        return { ok: true, reason: null };
    }

    /**
     * @param {any} action
     * @param {Map<string, any>} handles
     */
    function retagOne(action, handles) {
        const handle = handles.get(action.entityId);
        if (handle === undefined || !isLive(handle)) {
            return { ok: false, reason: "gone" };
        }
        const tags = [...handle.getTags()];
        const read = classifyTags(tags);
        if (!read.claims.includes(action.groupId)) {
            return { ok: false, reason: "identity-changed" };
        }
        const canonical = tagFor(action.groupId);
        for (const tag of read.ownTags) {
            if (tag !== canonical) {
                handle.removeTag(tag);
            }
        }
        if (!tags.includes(canonical)) {
            handle.addTag(canonical);
        }
        return { ok: true, reason: null };
    }

    /**
     * @param {any} action
     * @returns {{ ok: boolean, reason: string | null, entityId?: string }}
     */
    function spawnOne(action) {
        const tag = tagFor(action.groupId);
        if (findTagged(tag).length > 0) {
            return { ok: false, reason: "representative-exists" };
        }
        if (!chunkLoadedAt(action.at)) {
            return { ok: false, reason: "chunk-unloaded" };
        }
        const entity = dimension.spawnEntity(action.typeId, action.at);
        let tagged = false;
        try {
            tagged = entity.addTag(tag) === true;
        } catch (_error) {
            tagged = false;
        }
        if (!tagged) {
            // We created this unit a moment ago, so removing it is a rollback, not a removal of population.
            try {
                entity.remove();
                return { ok: false, reason: "tag-failed-rolled-back" };
            } catch (_error) {
                return { ok: false, reason: "tag-failed-stray-untagged" };
            }
        }
        return { ok: true, reason: null, entityId: String(entity.id) };
    }

    /**
     * @param {import("../population/cursor.js").CursorState} state
     * @returns {{ saved: boolean, reason: string | null }}
     */
    function saveCursor(state) {
        if (cursorBytes(state) > POP_CURSOR_MAX_BYTES) {
            return { saved: false, reason: `cursor exceeds ${String(POP_CURSOR_MAX_BYTES)} bytes` };
        }
        try {
            world.setDynamicProperty(POP_CURSOR_KEY, encodeCursor(state));
            return { saved: true, reason: null };
        } catch (error) {
            return { saved: false, reason: String(error) };
        }
    }

    /** Read-only summary of the stored cursor. */
    function status() {
        const loaded = decodeCursor(world.getDynamicProperty(POP_CURSOR_KEY));
        return {
            enabled,
            cursor: loaded.status,
            reason: loaded.reason ?? null,
            state: loaded.state,
            bytesIfSaved: cursorBytes(loaded.state),
            maxBytes: POP_CURSOR_MAX_BYTES,
            namespace: POP_TAG_NAMESPACE,
        };
    }

    return { dryRun, reconcileOnce, status, config, enabled };
}

/**
 * @param {any} value
 * @returns {Array<{ x: number, y: number, z: number }>}
 */
function normaliseAnchors(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((point) => point !== null && typeof point === "object" && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
}

/**
 * Players standing in this dimension, as anchors.
 * @param {any} world
 * @param {any} dimension
 */
function playersIn(world, dimension) {
    return world
        .getAllPlayers()
        .filter((/** @type {any} */ player) => player.dimension?.id === dimension.id)
        .map((/** @type {any} */ player) => ({ x: player.location.x, y: player.location.y, z: player.location.z }));
}

/**
 * The physical origin of each district, when the district has a physical footprint.
 * @param {any} kingdom
 * @returns {Record<string, { x: number, y: number, z: number }>}
 */
function homesFromPhysical(kingdom) {
    /** @type {Record<string, { x: number, y: number, z: number }>} */
    const homes = {};
    for (const district of kingdom.districts) {
        const origin = district.physical?.origin;
        if (origin !== undefined && origin !== null && Number.isInteger(origin.x) && Number.isInteger(origin.y) && Number.isInteger(origin.z)) {
            homes[district.id] = { x: origin.x, y: origin.y, z: origin.z };
        }
    }
    return homes;
}
