import { system } from "@minecraft/server";
import { peopleGateOn } from "../people/gate.js";
import { decodeCursor } from "../population/cursor.js";
import { parseGroupId } from "../population/groups.js";
import { classifyTags, tagFor } from "../population/identity.js";
import { POP_CURSOR_KEY, POP_DISTRICT_OBSERVE_RADIUS } from "../population/settings.js";
import { resolveConfig } from "../population/reconcile.js";
import { createPopSync, homesFromRecords, surfaceAtOf } from "./popSync.js";

// The streets driver: the kingdom's civilians and garrison, standing in the world as entities.
//
// This file is part of the runtime boundary (dev/test/integration.test.mjs keeps that line honest), but it reads the
// engine only through the hour's ctx - the one call it makes for itself is the clock, and only when a caller handed
// it no tick. Everything is injected: nothing here runs at module scope, because Script API v2 executes scripts in
// early execution.
//
// It owns no rules of its own. Every decision about who exists, where and how many belongs to the reducer
// (population/reconcile.js) and the adapter (integration/popSync.js); this file only turns one accepted simulation
// hour into ONE bounded call to `reconcileOnce`, and then labels and - with the gate off - empties what that
// adapter is responsible for.
//
// Why it reads the gate itself even though integration/peopleRuntime.js already refuses to call it while
// `civ:people` is off: the runtime's refusal is what keeps the hourly path cheap, not what makes the gate true.
// A driver that only ever runs on an on gate would leave its own citizens standing in a world whose owner switched
// the gate off, and there is no `entityRemove`-style event in 2.7.0 to clean up after (the removed-event reports an
// id, not a handle). So an hour that arrives with the gate off is a teardown hour: create nothing, and remove every
// entity that carries a tag in our namespace.
//
// What it never does:
//  - it does not move, steer or teleport anybody. @minecraft/server 2.7.0 has no navigation, pathfinding or velocity
//    API, so villagers and iron golems walk their districts on vanilla AI and the pack lets them;
//  - it does not write a block, run a command or touch the kingdom save. The only world write it can cause is the
//    `civ_pop` cursor, which popSync owns;
//  - it does not invent a budget: the caps come from `resolveConfig` (population/settings.js POP_SYNC_DEFAULTS), the
//    same ones the reducer enforces. The naming and teardown passes reuse `maxPhysicalTotal` as their ceiling, and the
//    spawn/despawn budget is exactly one `reconcileOnce` per hour - never several passes dressed up as one.
//  - it does not duplicate: identity is the `civpop:v1:<groupId>` tag, so a representative the cursor forgot is
//    adopted by popSync's own census rather than spawned a second time.

/** The nameTag label per group kind. A player reads the district and the role, nothing else. */
const STREET_LABELS = Object.freeze({ civ: "folk", sol: "levy" });

/**
 * The hour the runtime hands a driver (see integration/peopleRuntime.js): the saved kingdom as of this hour, which
 * the driver must not change, the hour's report, the overworld, the world and the current tick.
 * @typedef {{ kingdom: any, report: any, dimension: any, world: any, tick: number }} PeopleContext
 */

/**
 * Build the driver. Every dependency is optional; `deps.config` is passed straight to popSync after the same
 * `resolveConfig` the reducer uses, so the driver's own bounds and the adapter's caps can never disagree.
 *
 * @param {{
 *   config?: Partial<import("../population/settings.js").PopSyncConfig>,
 *   isGateOn?: (world: any) => boolean,
 *   homes?: (kingdom: any) => Record<string, { x: number, y: number, z: number }>,
 *   anchors?: () => Array<{ x: number, y: number, z: number }>,
 * }} [deps]
 * @returns {{ id: "streets", onHour: (ctx: PeopleContext) => number, status: () => Record<string, unknown> }}
 */
export function createPeopleStreets(deps = {}) {
    const config = resolveConfig(deps.config ?? {});
    const gateOn = deps.isGateOn ?? peopleGateOn;
    /**
     * Where a district's people live. `popSync.homesFromRecords` owns that rule - it is the same record the
     * adapter spawns against - so the driver reads through it instead of keeping a second copy that can drift
     * out of step with what a real build writes.
     * @param {any} kingdom
     * @param {any} dimension
     * @returns {Record<string, { x: number, y: number, z: number }>}
     */
    const homesAt = (kingdom, dimension) => (deps.homes === undefined ? homesFromRecords(kingdom, surfaceAtOf(dimension)) : deps.homes(kingdom));
    /**
     * What the last hour did, for `civ:people status`. A driver that is silently refused (a kingdom that will not
     * validate, a cursor written by a newer pack) would otherwise report 0 changes forever with no reason anywhere.
     */
    const done = { hours: 0, created: 0, removed: 0, named: 0, civ: 0, sol: 0, refused: /** @type {string | null} */ (null), cleared: 0 };

    /**
     * One accepted simulation hour.
     * @param {PeopleContext} ctx
     * @returns {number} entities created or removed by this hour
     */
    function onHour(ctx) {
        const dimension = ctx === null || ctx === undefined ? undefined : ctx.dimension;
        if (dimension === null || typeof dimension !== "object" || typeof dimension.getEntities !== "function" || typeof dimension.spawnEntity !== "function") {
            throw new TypeError("the streets driver needs a ctx whose dimension exposes getEntities and spawnEntity");
        }
        const world = ctx.world;
        done.hours += 1;

        // Gate off: nothing is created, and everything the driver made goes back out of the world.
        if (gateOn(world) !== true) {
            const removed = clearStreets(ctx);
            done.cleared += removed;
            done.removed += removed;
            done.refused = null;
            return removed;
        }

        // popSync captures `enabled` at construction, so the adapter is built fresh for this hour.
        const sync = createPopSync({
            world,
            dimension,
            readKingdom: () => ctx.kingdom,
            homes: deps.homes,
            anchors: deps.anchors,
            enabled: true,
            config: deps.config ?? {},
        });
        const run = sync.reconcileOnce(tickOf(ctx.tick, liveTick()));
        if (typeof run.refused === "string" && run.refused.length > 0) {
            done.refused = run.refused;
            return 0;
        }
        done.refused = null;

        let created = 0;
        let removed = 0;
        for (const entry of run.applied) {
            if (entry.action.op === "spawn") {
                created += 1;
            } else if (entry.action.op === "despawn") {
                removed += 1;
            }
        }
        done.created += created;
        done.removed += removed;
        // Naming is neither a creation nor a removal, so it is not counted as an entity change. It runs over the
        // groups the saved cursor now names, which is how an entity adopted from an earlier session gets its sign too.
        const onStreet = physicalGroups(ctx.world);
        // A per-kind tally, because "8 entity change(s)" cannot tell a player whether their garrison exists yet:
        // civilians queue ahead of soldiers, and the orders driver only has work once a `sol` group is standing.
        done.civ = 0;
        done.sol = 0;
        for (const groupId of onStreet) {
            const parsed = parseGroupId(groupId);
            if (parsed !== null && (parsed.kind === "civ" || parsed.kind === "sol")) {
                done[parsed.kind] += 1;
            }
        }
        done.named += nameStreets(ctx, onStreet);
        return created + removed;
    }

    /**
     * Give every representative of a bound group its district's name, so eight villagers on a corner read as
     * "Hearthgate folk" and not as an anonymous crowd. Writes only where the name is actually missing or stale, so a
     * converged street costs no entity writes in later hours.
     * @param {PeopleContext} ctx
     * @param {string[]} groupIds
     * @returns {number} names written
     */
    function nameStreets(ctx, groupIds) {
        const names = districtNames(ctx.kingdom);
        let written = 0;
        for (const groupId of sorted(groupIds)) {
            const parsed = parseGroupId(groupId);
            if (parsed === null) {
                continue;
            }
            const wanted = `${names.get(parsed.district) ?? parsed.district} ${STREET_LABELS[parsed.kind]}`;
            for (const handle of read(dimension(ctx), { tags: [tagFor(groupId)] })) {
                if (written >= config.maxPhysicalTotal) {
                    return written;
                }
                if (tryName(handle, wanted)) {
                    written += 1;
                }
            }
        }
        return written;
    }

    /**
     * The gate-off teardown: remove every entity we can see that carries a group tag of ours.
     * @param {PeopleContext} ctx
     * @returns {number} entities removed
     */
    function clearStreets(ctx) {
        let removed = 0;
        for (const handle of censusOurs(ctx)) {
            if (removed >= config.maxPhysicalTotal) {
                return removed;
            }
            if (tryRemove(handle)) {
                removed += 1;
            }
        }
        return removed;
    }

    /**
     * Every visible entity carrying a tag in our namespace. Two views, because either alone can miss one:
     *  - the groups the cursor names, asked by tag wherever they stand (a unit that wandered a long way is still ours);
     *  - the district observation windows popSync itself reads, which still find an ours when the cursor was lost or
     *    never saved. A unit in an unloaded chunk is invisible to both, and is left alone rather than guessed at.
     * @param {PeopleContext} ctx
     * @returns {any[]} handles, de-duplicated and ordered by entity id so a teardown is deterministic
     */
    function censusOurs(ctx) {
        /** @type {Map<string, any>} */
        const found = new Map();
        /** @param {any} handle */
        const admit = (handle) => {
            try {
                if (handle.isValid === false) {
                    return;
                }
                if (classifyTags([...handle.getTags()]).claims.length === 0) {
                    return;
                }
                const id = String(handle.id);
                if (!found.has(id)) {
                    found.set(id, handle);
                }
            } catch (_error) {
                // Unreadable (its chunk unloaded, or it died): not in view this hour.
            }
        };
        for (const groupId of physicalGroups(ctx.world)) {
            for (const handle of read(dimension(ctx), { tags: [tagFor(groupId)] })) {
                admit(handle);
            }
        }
        for (const home of Object.values(safeHomes(ctx))) {
            for (const handle of read(dimension(ctx), { location: home, maxDistance: POP_DISTRICT_OBSERVE_RADIUS })) {
                admit(handle);
            }
        }
        return sortedEntries(found);
    }

    /**
     * The districts the census may look inside. An injected `homes` that throws is not allowed to take the teardown
     * down with it: no windows simply means the cursor's own tag queries do the work.
     * @param {any} ctx the hour's context, whose kingdom supplies the districts and whose dimension reads the ground
     * @returns {Array<{ x: number, y: number, z: number }>}
     */
    function safeHomes(ctx) {
        try {
            return Object.values(homesAt(ctx?.kingdom ?? {}, dimension(ctx)));
        } catch (_error) {
            return [];
        }
    }

    /**
     * `nameTag` is a stable, settable string on Entity in 2.7.0 (no @beta marker on it), so a plain property write is
     * all the naming needs. A handle that cannot be read or written - dead, or in ground the engine has released -
     * costs one skipped name, never an hour.
     * @param {any} handle
     * @param {string} wanted
     * @returns {boolean} true when a name was written
     */
    function tryName(handle, wanted) {
        try {
            if (handle.isValid === false || handle.nameTag === wanted) {
                return false;
            }
            handle.nameTag = wanted;
            return true;
        } catch (_error) {
            return false;
        }
    }

    /**
     * Identity is re-read from the entity before it is removed, exactly as popSync's own guards do: an entity that no
     * longer claims one of our groups, or that cannot be reached at all, is left where it is.
     * @param {any} handle
     * @returns {boolean} true when this entity is gone
     */
    function tryRemove(handle) {
        try {
            if (handle.isValid === false) {
                return false;
            }
            if (classifyTags([...handle.getTags()]).claims.length === 0) {
                return false;
            }
            handle.remove();
            return true;
        } catch (_error) {
            return false;
        }
    }

    function status() {
        return { ...done };
    }

    return { id: /** @type {"streets"} */ ("streets"), onHour, status };
}

/**
 * @param {any} ctx
 */
function dimension(ctx) {
    return ctx.dimension;
}

/**
 * A query that never throws: an unreadable dimension or a bad window yields nothing, and the next hour tries again.
 * @param {any} dimensionLike
 * @param {any} query
 * @returns {any[]}
 */
function read(dimensionLike, query) {
    if (dimensionLike === null || typeof dimensionLike !== "object") {
        return [];
    }
    try {
        const found = dimensionLike.getEntities(query);
        return Array.isArray(found) ? found : [...(found ?? [])];
    } catch (_error) {
        return [];
    }
}

/**
 * The group ids the cursor claims are physical. Advisory only: an empty list costs a re-derivation, never a duplicate.
 * @param {any} world
 * @returns {string[]}
 */
function physicalGroups(world) {
    try {
        const raw = world.getDynamicProperty(POP_CURSOR_KEY);
        const loaded = decodeCursor(raw);
        return loaded.status === "newer" ? [] : loaded.state.physical;
    } catch (_error) {
        return [];
    }
}

/**
 * @param {any} kingdom
 * @returns {Map<string, string>} district id -> the name a player knows it by
 */
function districtNames(kingdom) {
    /** @type {Map<string, string>} */
    const names = new Map();
    const districts = kingdom?.districts;
    if (!Array.isArray(districts)) {
        return names;
    }
    for (const district of districts) {
        if (typeof district?.name === "string" && district.name.length > 0) {
            names.set(String(district.id), district.name);
        }
    }
    return names;
}

/**
 * The engine's tick, when it can be read at all. A driver called outside the runtime's hour (a diagnostic, a future
 * command) still gets a real clock instead of pretending to be at tick 0.
 * @returns {number | undefined}
 */
function liveTick() {
    try {
        const value = system.currentTick;
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    } catch (_error) {
        return undefined;
    }
}

/**
 * The reducer insists on a non-negative integer tick, and the per-tick budget is carried in the cursor by that tick.
 * A caller that handed over no usable tick falls back to the clock, and only then to 0: a repeated tick is safe,
 * because a budget already spent on it simply makes the hour do nothing instead of double-spawning.
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function tickOf(value, fallback) {
    const usable = (/** @type {unknown} */ candidate) => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined);
    const number = usable(value) ?? usable(fallback) ?? 0;
    return Math.max(0, Math.floor(number));
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function sorted(list) {
    return [...(Array.isArray(list) ? list : [])].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * @param {Map<string, any>} found
 * @returns {any[]}
 */
function sortedEntries(found) {
    return [...found.entries()]
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([, handle]) => handle);
}
