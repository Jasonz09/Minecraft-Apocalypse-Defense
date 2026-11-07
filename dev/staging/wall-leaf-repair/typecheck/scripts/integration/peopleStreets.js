import { system } from "@minecraft/server";
import { peopleGateOn } from "../people/gate.js";
import { decodeCursor } from "../population/cursor.js";
import { buildGroupTable, parseGroupId } from "../population/groups.js";
import { classifyTags, isCanonicalFor, tagFor } from "../population/identity.js";
import { militarySelectionPolicy } from "../population/militarySelection.js";
import { POP_CURSOR_KEY, POP_DISTRICT_OBSERVE_RADIUS } from "../population/settings.js";
import { resolveConfig } from "../population/reconcile.js";
import { createPopSync, postsFromRecords } from "./popSync.js";
import { standableNear, surfaceAtOf } from "../people/columns.js";

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
//  - this ownership driver does not move, steer or teleport anybody. Villagers and golems retain vanilla AI;
//    the separate opt-in civilian travel trial uses 2.7.0 velocity/impulse methods on already-admitted villagers;
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
 *   posts?: (kingdom: any) => Record<string, Array<{ x: number, y: number, z: number }>>,
 *   anchors?: () => Array<{ x: number, y: number, z: number }>,
 *   readMilitarySelection?:()=>import("../population/militarySelection.js").MilitarySelectionRead,
 *   militaryDiagnostics?:ReturnType<typeof import("./militaryLifecycleDiagnostics.js").createMilitaryLifecycleDiagnostics>,
 * }} [deps]
 * @returns {{ id: "streets", onHour: (ctx: PeopleContext) => number, status: () => Record<string, unknown>, admittedGroups:(world:any)=>string[],inspectCommand:(message:string)=>string[] }}
 */
export function createPeopleStreets(deps = {}) {
    const config = resolveConfig(deps.config ?? {});
    const gateOn = deps.isGateOn ?? peopleGateOn;
    /**
     * Where a district's people stand: its plaza, then the quarter posts of a lattice around it.
     * `popSync.postsFromRecords` owns that rule - it is the same record the adapter spawns against - so the driver
     * reads through it instead of keeping a second copy that can drift out of step with what a real build writes.
     * @param {any} kingdom
     * @param {any} dimension
     * @returns {Record<string, Array<{ x: number, y: number, z: number }>> | null} null when the caller injected
     *   its own `homes`, which the adapter reads as one post per district
     */
    // Posts are world-read: a build record stores only X/Z, and the top of the plan column is usually a roof or a
    // tree crown. `standableNear` samples the ground around it and takes the lowest open surface, so the folk stand
    // in a street a player can walk into instead of on a rooftop. It runs through this driver - the one gated door
    // into the population layer - rather than from main.js, so the single-door guarantee still holds.
    const postsAt = (kingdom, dimension) => {
        if (typeof deps.posts === "function") {
            return deps.posts(kingdom);
        }
        if (deps.homes !== undefined) {
            return null;
        }
        // Both probes, always. Open ground is preferred, but a district under a jungle canopy has no column with
        // sky above it - the headroom test rejects every sample - and a home that depends on it alone disappeared
        // for whole hours, taking the population with it. The topmost column is what the plaza always fell back to.
        return postsFromRecords(
            kingdom,
            surfaceAtOf(dimension),
            (x, z, radius) => standableNear(dimension, x, z, radius === undefined ? undefined : { radius }),
        );
    };
    /**
     * What the last hour did, for `civ:people status`. A driver that is silently refused (a kingdom that will not
     * validate, a cursor written by a newer pack) would otherwise report 0 changes forever with no reason anywhere.
     */
    // Field order is the order `civ:people` prints them (the runtime shows at most six scalars per driver), so the
    // admission counts, the reducer's admission report and actual birth outcomes come first.
    // These counts are admission INTENT, not standing/live entities. Birth outcomes
    // retain the skipped/failed reasons that a successful cursor save cannot show.
    const done = { admittedCiv: 0, admittedSol: 0, lod: "", births: "no owner birth attempts this session",hold: /** @type {string | null} */ (null), refused: /** @type {string | null} */ (null), named: 0, hours: 0, created: 0, removed: 0, cleared: 0 };
    /** @type {ReturnType<typeof createPopSync>|undefined} */let lastSync;

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
            let removed=0;
            try {removed=clearStreets(ctx);}
            catch(error){done.refused=String(error);return 0;}
            done.cleared += removed;
            done.removed += removed;
            done.refused = null;
            // The street is empty by design on a teardown hour, so the last census is not this hour's either.
            done.admittedCiv = 0;
            done.admittedSol = 0;
            done.lod = "the gate is off";
            done.births="gate-off teardown; cached birth inspection may predate this hour";
            done.hold = null;
            return removed;
        }

        // popSync captures `enabled` at construction, so the adapter is built fresh for this hour. The posts are
        // read once here and handed to both the adapter and the census, so a naming or teardown pass can never look
        // somewhere other than where this hour's reconcile put people.
        const posts = postsAt(ctx.kingdom, dimension);
        const sync = createPopSync({
            world,
            dimension,
            readKingdom: () => ctx.kingdom,
            homes: deps.homes,
            posts: posts === null ? undefined : () => posts,
            anchors: deps.anchors,
            enabled: true,
            config: deps.config ?? {},
            readMilitarySelection:deps.readMilitarySelection,
            militaryDiagnostics:deps.militaryDiagnostics,
        });
        lastSync=sync;
        const run = sync.reconcileOnce(tickOf(ctx.tick, liveTick()));
        const birthActions=run.actions.filter((/** @type {any} */a)=>a.op==="spawn");
        done.births=`owner tick ${tickOf(ctx.tick,liveTick())}: `+(birthActions.length?birthActions.slice(0,2).map((/** @type {any} */action)=>{
            const applied=run.applied.some((/** @type {any} */e)=>e.action===action),skipped=run.skipped.find((/** @type {any} */e)=>e.action===action),failed=run.failed.find((/** @type {any} */e)=>e.action===action);
            return `${action.groupId} ${applied?"born":skipped?`deferred ${skipped.reason}`:failed?`failed ${String(failed.error).slice(0,120)}`:"not executed"}`;
        }).join("; "):"no birth actions queued");
        if (typeof run.refused === "string" && run.refused.length > 0) {
            // A refused hour reads nothing, so the last hour's census must not be printed as if it were this one's.
            done.refused = run.refused;
            done.admittedCiv = 0;
            done.admittedSol = 0;
            done.lod = "not read this hour";
            done.hold = null;
            return 0;
        }
        done.refused = null;
        // The reducer's own census, so "civ=8 sol=0" can be read instead of guessed at: how many groups it
        // admitted, how many it capped, and how many it could not promote because the ground was not loaded.
        const counts = run.report?.groups ?? {};
        done.lod = `admitted=${String(counts.physical ?? "?")} coarse=${String(counts.coarse ?? "?")} simulated=${String(counts.simulated ?? "?")} capped=${String(counts.capped ?? 0)} unloaded=${String(counts.chunkBlocked ?? 0)}`;
        done.hold = typeof run.report?.hold === "string" ? run.report.hold : null;

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
        // The cursor admits intent before standing probes succeed. These are admitted group counts,
        // not a census of living actors; inspectCommand performs that separate loaded-only check.
        done.admittedCiv = 0;
        done.admittedSol = 0;
        for (const groupId of onStreet) {
            const parsed = parseGroupId(groupId);
            if (parsed !== null && (parsed.kind === "civ" || parsed.kind === "sol")) {
                if(parsed.kind==="civ")done.admittedCiv++;else done.admittedSol++;
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
        const snapshot=typeof deps.readMilitarySelection==="function"?militarySelectionPolicy(deps.readMilitarySelection(),buildGroupTable(ctx.kingdom,config).groups,String(ctx.dimension.id)):null;
        const strict=snapshot!==null&&snapshot.selection!==null;
        const handles=censusOurs(ctx,strict);
        if(strict&&snapshot?.selection) {
            const selected=read(dimension(ctx),{tags:[tagFor(snapshot.selection.groupId)]},true);
            if(selected.length>1)throw new Error("military teardown duplicate conflict; all preserved");
            for(const handle of selected)if(!handles.some(h=>String(h.id)===String(handle.id)))handles.push(handle);
            if(handles.length>config.maxPhysicalTotal)throw new Error("military teardown exceeds physical owner cap; preserved");
            const seen=new Set();
            for(const handle of handles) {
                const group=verifiedMilitaryHandle(handle,snapshot);
                if(seen.has(group))throw new Error("military teardown duplicate conflict; all preserved");
                seen.add(group);
            }
        }
        for (const handle of handles) {
            if (removed >= config.maxPhysicalTotal) {
                return removed;
            }
            let diagnosticGroup;
            const beforeRemove=snapshot===null?undefined:()=>{
                const fresh=militarySelectionPolicy(/** @type {NonNullable<typeof deps.readMilitarySelection>} */(deps.readMilitarySelection)(),buildGroupTable(ctx.kingdom,config).groups,String(ctx.dimension.id));
                if(fresh.stamp!==snapshot.stamp)throw new Error("military selection changed before teardown");
                if(strict) {
                    const group=verifiedMilitaryHandle(handle,fresh),matches=read(dimension(ctx),{tags:[tagFor(group)]},true);
                    if(matches.length!==1||String(matches[0].id)!==String(handle.id))throw new Error("military teardown uniqueness changed; preserved");
                    verifiedMilitaryHandle(handle,fresh);
                    diagnosticGroup=group;
                }
            };
            let diagnosticId;
            try{diagnosticId=String(handle.id);}catch(_error){}
            if (tryRemove(handle,beforeRemove)) {
                try{if(snapshot?.selection?.groupId===diagnosticGroup&&diagnosticId)deps.militaryDiagnostics?.ownerOutcome({op:"despawn",groupId:diagnosticGroup,entityId:diagnosticId,reason:"people gate-off teardown"},{ok:true});}catch(_error){}
                removed += 1;
            }
        }
        return removed;
    }
    /** @param {any} handle @param {ReturnType<typeof militarySelectionPolicy>} policy */
    function verifiedMilitaryHandle(handle,policy) {
        const read=classifyTags(handle.getTags()),groupId=read.claims[0],parsed=parseGroupId(groupId);
        if(parsed===null||!isCanonicalFor(read.ownTags,groupId)||handle.isValid===false)throw new Error("military teardown canonical identity conflict");
        if(String(handle.typeId)!==policy.typeForGroup({id:groupId,...parsed,headcount:0}))throw new Error("military teardown type conflict; preserved");
        return groupId;
    }

    /**
     * Every visible entity carrying a tag in our namespace. Two views, because either alone can miss one:
     *  - the groups the cursor names, asked by tag wherever they stand (a unit that wandered a long way is still ours);
     *  - the district observation windows popSync itself reads, which still find an ours when the cursor was lost or
     *    never saved. A unit in an unloaded chunk is invisible to both, and is left alone rather than guessed at.
     * @param {PeopleContext} ctx
     * @returns {any[]} handles, de-duplicated and ordered by entity id so a teardown is deterministic
     * @param {boolean} [strict]
     */
    function censusOurs(ctx,strict=false) {
        let work=0;
        /** @type {Map<string, any>} */
        const found = new Map();
        /** @param {any} handle */
        const admit = (handle) => {
            try {
                if(strict&&++work>config.workBudget)throw new Error("military teardown work budget exhausted");
                if (handle.isValid === false) {
                    return;
                }
                const tags=[...handle.getTags()];
                if(strict&&(work+=tags.length)>config.workBudget)throw new Error("military teardown work budget exhausted");
                if (classifyTags(tags).claims.length === 0) {
                    return;
                }
                const id = String(handle.id);
                if (!found.has(id)) {
                    found.set(id, handle);
                    if(strict&&found.size>config.maxPhysicalTotal)throw new Error("military teardown exceeds physical owner cap; preserved");
                }
            } catch (_error) {
                if(strict)throw _error;
                // Unreadable (its chunk unloaded, or it died): not in view this hour.
            }
        };
        for (const groupId of physicalGroups(ctx.world)) {
            for (const handle of read(dimension(ctx), { tags: [tagFor(groupId)] },strict)) {
                admit(handle);
            }
        }
        for (const home of Object.values(safeHomes(ctx,strict))) {
            for (const handle of read(dimension(ctx), { location: home, maxDistance: POP_DISTRICT_OBSERVE_RADIUS },strict)) {
                admit(handle);
            }
        }
        return sortedEntries(found);
    }

    /**
     * The districts the census may look inside. An injected `homes` that throws is not allowed to take the teardown
     * down with it: no windows simply means the cursor's own tag queries do the work.
     * @param {any} ctx the hour's context, whose kingdom supplies the districts and whose dimension reads the ground
     * @param {boolean} [strict]
     * @returns {Array<{ x: number, y: number, z: number }>}
     */
    function safeHomes(ctx,strict=false) {
        try {
            const kingdom = ctx?.kingdom ?? {};
            const posts = postsAt(kingdom, dimension(ctx));
            if (posts !== null) {
                // Every post: a teardown that only swept the plaza would leave the quarters standing.
                return Object.values(posts).flat();
            }
            return Object.values(deps.homes === undefined ? {} : deps.homes(kingdom));
        } catch (_error) {
            if(strict)throw _error;
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
     * @param {()=>void} [beforeRemove]
     */
    function tryRemove(handle,beforeRemove) {
        try {
            if (handle.isValid === false) {
                return false;
            }
            if (classifyTags([...handle.getTags()]).claims.length === 0) {
                return false;
            }
        } catch (_error) {
            return false;
        }
        beforeRemove?.();
        try {handle.remove();return true;}catch(_error){return false;}
    }

    function status() {
        return { ...done };
    }
    /** @param {string} message @returns {string[]} */
    function inspectCommand(message){
        const match=/^group=([^\s]+)$/.exec(message.trim());
        if(!match||parseGroupId(match[1])===null)return["Usage: /scriptevent civ:people inspect group=district-1:sol:0"];
        if(!lastSync)return["Read-only population inspection: no owner plan has run in this session; wait for its normal hour."];
        const info=lastSync.inspectGroup(match[1],tickOf(undefined,liveTick()));
        if(info.state!=="ok")return["Read-only population inspection: "+info.reason];
        /** @param {any} p */const point=p=>p?`${p.x},${p.y},${p.z}`:"unavailable";
        const age=info.ageTicks===null?"new/unknown tick epoch":`${info.ageTicks} ticks old`;
        return[`=== Read-only population ${info.groupId} ===`,`Cached owner tick ${info.ownerTick}; now ${info.currentTick} (${age}).`,
            `Admitted intent: ${info.admitted?"yes":"no"}; fresh loaded canonical: ${info.live.canonicalLoaded??"unknown"}; expected-type matches: ${info.live.expectedTypeLoaded??"unknown"}; tag matches: ${info.live.queryMatches??"unknown"}.`,
            `Cached expected type: ${info.expectedType}.`,`Cached post ${info.postIndex??"?"}/${info.postCount}: ${point(info.post)}; requested spot ${point(info.requested)}.`,
            `Last owner birth: ${info.lastAttempt.status}${info.lastAttempt.reason?" — "+info.lastAttempt.reason:""}; actual settled spot ${point(info.lastAttempt.settled)}.`,
            `Fresh settle: ${info.settle.reason}; ${point(info.settle.point)}.`,`Native block reads: ${info.settle.nativeBlockReads}/${info.settle.maxBlockReads}; one loaded tag query, at most two entity identities inspected.`,
            ...(info.live.reason?[`Census held: ${info.live.reason}`]:[]),...info.live.entities.map((/** @type {any} */e)=>`Loaded actor ${e.id}: ${e.typeId}; canonical ${e.canonical?"yes":"no"}; live position ${point(e.location)}; health ${e.health??"unknown"}.`),
            ...(deps.militaryDiagnostics?.statusLines()??[]),
            "No entity, block, gate, population or cursor was changed. Loaded census is not proof about unloaded entities."];
    }

    return { id: /** @type {"streets"} */ ("streets"), onHour, status, admittedGroups:physicalGroups,inspectCommand };
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
 * @param {boolean} [strict]
 * @returns {any[]}
 */
function read(dimensionLike, query,strict=false) {
    if (dimensionLike === null || typeof dimensionLike !== "object") {
        return [];
    }
    try {
        const found = dimensionLike.getEntities(query);
        if(strict&&!Array.isArray(found))throw new Error("military teardown query is unreadable");
        return Array.isArray(found) ? found : [...(found ?? [])];
    } catch (_error) {
        if(strict)throw _error;
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
