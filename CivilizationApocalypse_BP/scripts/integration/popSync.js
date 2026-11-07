import { world as runtimeWorld } from "@minecraft/server";
import { createKingdomStore } from "../kingdom/store.js";
import { buildGroupTable, chunkKeyOf, nearestDistance, nearestPostDistance, parseGroupId, postOf, spotFor } from "../population/groups.js";
import { classifyTags, tagFor } from "../population/identity.js";
import { cursorBytes, decodeCursor, encodeCursor } from "../population/cursor.js";
import { reconcile, resolveConfig } from "../population/reconcile.js";
import { CHUNK_SIZE, POP_CURSOR_KEY, POP_CURSOR_MAX_BYTES, POP_DISTRICT_OBSERVE_RADIUS, POP_POSTS, POP_TAG_NAMESPACE, POP_ENTITY_TYPES } from "../population/settings.js";
import { standableNear, surfaceAtOf } from "../people/columns.js";
import { militarySelectionPolicy } from "../population/militarySelection.js";
import { isCanonicalFor } from "../population/identity.js";
import { militaryActorSnapshot } from "./militaryLifecycleDiagnostics.js";

/**
 * Blocks searched around a planned spawn spot for the ground it should stand on. Small on purpose: the spot is
 * the group's post (an offset from its home), so the fix is for the Y to be read where the unit will stand, not
 * for the unit to be moved somewhere better.
 */
const SPAWN_SETTLE_RADIUS = 4;
class MilitaryOwnerRefusal extends Error {}

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
 *   posts            (kingdom) => { [districtId]: [{ x, y, z }, ...] }; defaults to the plaza plus the quarter
 *                    posts `postsFromRecords` can probe. Injecting `homes` instead gives every district one post
 *   standable        (x, z, radius?) => { x, y, z } | undefined, open ground near a point; used for quarter posts
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
    /** Last owner plan only: diagnostic reads never reconcile or advance its cursor. @type {any} */
    let lastPlan;
    /** Diagnostic failures cannot change owner guards/actions/cursor decisions. @param {string} method @param {any[]} args */
    const diagnose=(method,...args)=>{try{deps.militaryDiagnostics?.[method]?.(...args);}catch(_error){}};
    const readKingdom = deps.readKingdom ?? (() => createKingdomStore(world).load().kingdom);
    let militaryWork=0;
    /** @param {number} count */
    const chargeMilitaryWork=count=>{militaryWork+=count;if(militaryWork>config.workBudget)throw new Error("military owner runtime work budget exhausted");};
    /** @param {any} kingdom */
    const militaryPolicy = kingdom => {
        if(typeof deps.readMilitarySelection!=="function")return null;
        const read=deps.readMilitarySelection();
        if(read?.status==="absent")return militarySelectionPolicy(read,[],String(dimension.id));
        const groups=buildGroupTable(kingdom,config).groups;
        chargeMilitaryWork(groups.length+1);
        return militarySelectionPolicy(read,groups,String(dimension.id));
    };
    const anchorsOf = deps.anchors ?? (() => playersIn(world, dimension));
    const surfaceAt = surfaceAtOf(dimension);
    /**
     * Every district's posts, plaza first. An injected `homes` map is read as one post per district, which is what
     * every caller before posts had and is still what a caller with its own geometry means.
     * @type {(kingdom: any) => Record<string, Array<{ x: number, y: number, z: number }>>}
     */
    const postsOf = deps.posts ?? (deps.homes === undefined
        ? (/** @type {any} */ kingdom) => postsFromRecords(kingdom, surfaceAt, deps.standable)
        : (/** @type {any} */ kingdom) => singlePosts(deps.homes(kingdom)));

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

    /** @param {string} tag @param {boolean} [strict] */
    const findTagged = (tag,strict=false) => {
        try {
            const found=dimension.getEntities({ tags: [tag] });
            if(strict&&!Array.isArray(found))throw new Error("military tag query returned unreadable results");
            if(strict)chargeMilitaryWork(found.length+1);
            return /** @type {any[]} */ (found).filter((handle) => handle.isValid !== false);
        } catch (_error) {
            if(strict)throw new Error("military tag census is unreadable");
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
     * @param {Record<string, Array<{ x: number, y: number, z: number }>>} posts
     */
    const observe = (kingdom, anchors, posts, strict=false) => {
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
            if(strict&&entity===null)throw new Error("military observation became unreadable");
            if(strict&&entity!==null)chargeMilitaryWork(1+entity.tags.length);
            if (entity !== null) {
                handles.set(entity.id, handle);
                entities.push(entity);
            }
        };
        const windows = [
            ...Object.values(posts).flat().map((post) => ({ centre: post, radius: POP_DISTRICT_OBSERVE_RADIUS })),
            ...anchors.map((anchor) => ({ centre: anchor, radius: config.coarseRadius + CHUNK_SIZE })),
        ];
        for (const window of windows) {
            let found = [];
            try {
                found = dimension.getEntities({ location: window.centre, maxDistance: window.radius });
                if(strict&&!Array.isArray(found))throw new Error("military observation returned unreadable results");
                if(strict)chargeMilitaryWork(found.length+1);
            } catch (_error) {
                if(strict)throw new Error("military observation query failed");
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
            const list = posts[group.district];
            const post = postOf(list, group.index);
            if (post === null) {
                continue;
            }
            const spot = spotFor(post, group.kind, group.index);
            // The same reach the reducer uses: a post is worth probing when its district is near, not only when
            // the post itself is. The soldier band sits further out than the civilian grid, so a spot-only test
            // left every levy post unprobed - and an unprobed spot can never be marked loaded.
            const reach = Math.min(nearestDistance(spot, anchors), nearestPostDistance(list, anchors));
            if (reach > config.physicalRadius) {
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
        return { observation: { kingdom, entities, anchors, homes: plazasOf(posts), posts, loadedChunks }, handles, admit };
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
        const posts = postsOf(kingdom);
        const snapshot=militaryPolicy(kingdom);
        const policy=snapshot?.selection?snapshot:null;
        const session = observe(kingdom, anchors, posts,policy!==null);
        if(policy?.selection){const found=findTagged(tagFor(policy.selection.groupId),true);diagnose("observe",policy.selection.groupId,found);for(const handle of found)session.admit(handle);}
        let result = reconcile(prior, session.observation, tick, config,policy?.typeForGroup);
        if(policy!==null)chargeMilitaryWork(result.report.work??0);
        for (let pass = 0; pass < 2; pass += 1) {
            let discovered = 0;
            for (const action of result.actions) {
                if (action.op !== "spawn") {
                    continue;
                }
                for (const handle of findTagged(tagFor(action.groupId),policy!==null)) {
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
            result = reconcile(prior, session.observation, tick, config,policy?.typeForGroup);
            if(policy!==null)chargeMilitaryWork(result.report.work??0);
        }
        lastPlan={tick,posts:Object.fromEntries(Object.entries(posts).map(([id,list])=>[id,{count:list.length,points:list.slice(0,9).map((/** @type {any} */p)=>({...p}))}])),
            counts:new Map(kingdom.districts.map((/** @type {any} */d)=>[d.id,{civ:d.civilians,sol:d.soldiers}])),policy:snapshot,
            admitted:[...result.state.physical],actions:result.actions,refused:result.report.refused??null,deferred:result.report.deferred??[],outcomes:[],
            bound:new Set(session.observation.entities.flatMap((/** @type {any} */e)=>classifyTags(e.tags).claims))};
        return { result, handles: session.handles,policy:snapshot };
    };

    /**
     * @param {number} tick
     * @returns {{ refused: string | null, plan: any, cursor: string }}
     */
    const planFromStore = (tick) => {
        militaryWork=0;
        const loaded = decodeCursor(world.getDynamicProperty(POP_CURSOR_KEY));
        if (loaded.status === "newer") {
            return { refused: `cursor refused: ${String(loaded.reason)}`, plan: null, cursor: loaded.status };
        }
        const kingdom = readKingdom();
        if (kingdom === undefined || kingdom === null) {
            return { refused: "no kingdom records are stored yet", plan: null, cursor: loaded.status };
        }
        try {
            const planned = plan(loaded.state, kingdom, tick);
            return { refused: planned.result.report.refused ?? null, plan: planned, cursor: loaded.status };
        } catch(error) {
            if(typeof deps.readMilitarySelection!=="function")throw error;
            return {refused:String(error),plan:null,cursor:loaded.status};
        }
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
        const outcome = applyActions(planned.plan.result.actions, planned.plan.handles,planned.plan.policy);
        const saved = outcome.militaryRefused===null?saveCursor(planned.plan.result.state):{saved:false,reason:outcome.militaryRefused};
        return {
            refused: outcome.militaryRefused,
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
     * @param {ReturnType<typeof militarySelectionPolicy>|null} policy
     */
    function applyActions(actions, handles,policy) {
        /** @type {any[]} */
        const applied = [];
        /** @type {any[]} */
        const skipped = [];
        /** @type {any[]} */
        const failed = [];
        /** @type {string|null} */
        let militaryRefused=null;
        for (const action of actions) {
            try {
                if(policy!==null) {
                    guardMilitaryAction(action,policy);
                }
                const beforeWrite=policy===null?undefined:()=>guardMilitaryAction(action,policy);
                /** @type {{ ok: boolean, reason: string | null, entityId?: string,settled?:{x:number,y:number,z:number} }} */
                const outcome = action.op === "spawn" ? spawnOne(action,beforeWrite) : action.op === "despawn" ? removeOne(action, handles,beforeWrite) : retagOne(action, handles,beforeWrite);
                if(policy?.selection?.groupId===action.groupId)diagnose("ownerOutcome",action,outcome);
                if(action.op==="spawn"&&lastPlan)lastPlan.outcomes.push({groupId:action.groupId,status:outcome.ok?"applied":"skipped",reason:outcome.reason,settled:outcome.settled??null,entityId:outcome.entityId??null});
                (outcome.ok ? applied : skipped).push({ action, reason: outcome.reason ?? null, entityId: outcome.entityId ?? action.entityId ?? null });
            } catch (error) {
                if(policy?.selection?.groupId===action.groupId)diagnose("ownerOutcome",action,{ok:false,reason:String(error).slice(0,180)});
                failed.push({ action, error: String(error) });
                if(action.op==="spawn"&&lastPlan)lastPlan.outcomes.push({groupId:action.groupId,status:"failed",reason:String(error).slice(0,180),settled:null,entityId:null});
                if(policy?.selection||error instanceof MilitaryOwnerRefusal){militaryRefused=String(error);break;}
            }
        }
        if(policy!==null&&militaryRefused===null) {
            try {if(militaryPolicy(readKingdom())?.stamp!==policy.stamp)throw new Error("military selection changed before cursor save");}
            catch(error){militaryRefused=String(error);}
        }
        return { applied, skipped, failed,militaryRefused };
    }

    /** @param {any} action @param {ReturnType<typeof militarySelectionPolicy>} policy */
    function guardMilitaryAction(action,policy) {
        try {
        const fresh=militaryPolicy(readKingdom());
        if(fresh===null||fresh.stamp!==policy.stamp)throw new Error("military selection changed before apply");
        if(policy.selection===null)return;
        const parsed=parseGroupId(action.groupId);
        if(parsed===null)throw new Error("military action identity is invalid");
        const expected=fresh.typeForGroup({id:action.groupId,...parsed,headcount:0});
        if(action.op==="spawn"&&action.typeId!==expected)throw new Error("military spawn type changed");
        const groups=policy.selection&&policy.selection.groupId!==action.groupId?[action.groupId,policy.selection.groupId]:[action.groupId];
        for(const groupId of groups) {
            const wanted=groupId===action.groupId?expected:policy.selection?.typeId;
            const live=findTagged(tagFor(groupId),true);
            if(live.length>1)throw new Error("military duplicate appeared before apply; all preserved");
            if(groupId===action.groupId&&action.op==="spawn"&&live.length>0)throw new Error("military representative appeared before spawn; preserved");
            for(const handle of live) {
                const tags=handle.getTags();chargeMilitaryWork(tags.length+1);
                const read=classifyTags(tags);
                if(!isCanonicalFor(read.ownTags,groupId)||String(handle.typeId)!==wanted)throw new Error("military identity/type changed before apply");
            }
            if(groupId===action.groupId&&action.op!=="spawn"&&!live.some(handle=>String(handle.id)===action.entityId))throw new Error("military action target is no longer verified");
        }
        }catch(error){throw new MilitaryOwnerRefusal(String(error));}
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
     * @param {()=>void} [beforeWrite]
     */
    function removeOne(action, handles,beforeWrite) {
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
        beforeWrite?.();
        handle.remove();
        return { ok: true, reason: null };
    }

    /**
     * @param {any} action
     * @param {Map<string, any>} handles
     * @param {()=>void} [beforeWrite]
     */
    function retagOne(action, handles,beforeWrite) {
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
        beforeWrite?.();
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
     * Where a group actually stands. The reducer's spot is an offset from a home (the soldier band sits twenty
     * blocks along z), and it carries the post's Y with it, so the spawn lands at a height that belongs to a
     * different column - inside a wall downhill, floating over a drop uphill. The standing height is read again
     * at the column about to be used, within four blocks, so the unit cannot be moved off its post.
     *
     * A probe that cannot measure safe headroom defers the spawn. The stale planned height is not evidence
     * of dry, empty space; the next reconciliation can retry without changing the population record.
     *
     * @param {{ x: number, y: number, z: number }} point
     * @returns {{ x: number, y: number, z: number } | undefined}
     */
    function settleSpot(point) {
        try {
            return standableNear(dimension, point.x, point.z, { radius: SPAWN_SETTLE_RADIUS });
        } catch (_error) {
            return undefined;
        }
    }

    /**
     * @param {any} action
     * @param {()=>void} [beforeWrite]
     * @returns {{ ok: boolean, reason: string | null, entityId?: string,settled?:{x:number,y:number,z:number} }}
     */
    function spawnOne(action,beforeWrite) {
        const tag = tagFor(action.groupId);
        if (findTagged(tag).length > 0) {
            return { ok: false, reason: "representative-exists" };
        }
        const at = settleSpot(action.at);
        if (at === undefined) {
            return { ok: false, reason: "no-safe-standing-spot" };
        }
        if (!chunkLoadedAt(at)) {
            return { ok: false, reason: "chunk-unloaded",settled:at };
        }
        beforeWrite?.();
        const entity = dimension.spawnEntity(action.typeId, at);
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
        diagnose("observe",action.groupId,[entity]);
        return { ok: true, reason: null, entityId: String(entity.id),settled:at };
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

    /** A single-group read-only probe of the cached last owner plan, never a new planning/spawn path.
     * @param {string} groupId @param {number} tick */
    function inspectGroup(groupId,tick){
        const parsed=parseGroupId(groupId);
        if(!parsed)return{state:/** @type {const} */("unavailable"),reason:"inspect requires one canonical population group ID"};
        if(!lastPlan)return{state:/** @type {const} */("unavailable"),reason:"no owner plan has run in this session; wait for its normal hour"};
        const people=lastPlan.counts.get(parsed.district)?.[parsed.kind],headcount=Math.min(config.groupSize[parsed.kind],Number(people)-parsed.index*config.groupSize[parsed.kind]);
        if(!Number.isInteger(headcount)||headcount<=0)return{state:/** @type {const} */("unavailable"),reason:"group does not exist in the cached owner population"};
        const list=lastPlan.posts[parsed.district],postIndex=list?.count?parsed.index%list.count:null,post=postIndex===null?null:list?.points[postIndex]??null;
        const requested=post?spotFor(post,parsed.kind,parsed.index):null;
        const group={id:groupId,district:parsed.district,kind:parsed.kind,index:parsed.index,headcount};
        const expectedType=lastPlan.policy?.typeForGroup(group)??POP_ENTITY_TYPES[parsed.kind];
        let reads=0,limited=false,unreadable=0;
        /** @param {string} method @param {any} point */
        const probe=(method,point)=>{
            if(reads>=240){limited=true;throw new Error("inspection block-read budget exhausted");}
            reads++;
            try{const value=dimension[method](point);if(value===undefined||value===null)unreadable++;return value;}catch(error){unreadable++;throw error;}
        };
        let settled=null,settleReason=requested?"no-safe-standing-spot":"no cached post";
        if(requested){try{settled=standableNear({getTopmostBlock:(/** @type {any} */p)=>probe("getTopmostBlock",p),getBlock:(/** @type {any} */p)=>probe("getBlock",p)},requested.x,requested.z,{radius:SPAWN_SETTLE_RADIUS})??null;}
            catch(error){settleReason=String(error).slice(0,180);}
            if(settled)settleReason="safe loaded column measured";else if(limited)settleReason="block-read budget exhausted";else if(unreadable>0)settleReason="no safe column measured; some samples unreadable/unloaded";
        }
        /** @type {any} */let live={queryMatches:null,canonicalLoaded:null,expectedTypeLoaded:null,entities:[],reason:null};
        try {
            const found=dimension.getEntities({tags:[tagFor(groupId)]});
            if(!Array.isArray(found))throw new Error("tag census did not return an array");
            live.queryMatches=found.length;
            if(found.length>2)live.reason="more than two loaded tag matches; identity census held within its bound";
            else {
                let canonical=0,expected=0;
                for(const handle of found){const tags=handle.getTags();if(!Array.isArray(tags)||tags.length>64)throw new Error("entity tag identity exceeds inspection bound");const identity=classifyTags(tags),matches=isCanonicalFor(identity.ownTags,groupId),typeId=String(handle.typeId);if(matches)canonical++;if(matches&&typeId===expectedType)expected++;live.entities.push({id:String(handle.id),typeId,canonical:matches,...militaryActorSnapshot(handle)});}
                live.canonicalLoaded=canonical;live.expectedTypeLoaded=expected;
                diagnose("observe",groupId,found);
            }
        }catch(error){live.reason=String(error).slice(0,180);}
        const action=lastPlan.actions.find((/** @type {any} */a)=>a.groupId===groupId&&a.op==="spawn"),outcome=lastPlan.outcomes.find((/** @type {any} */o)=>o.groupId===groupId);
        const deferred=lastPlan.deferred.find((/** @type {any} */d)=>d.groupId===groupId)?.reason;
        const lastAttempt=outcome??{status:action?"queued but not executed":lastPlan.bound.has(groupId)?"already observed":deferred??(lastPlan.admitted.includes(groupId)?"not queued within last attempt budget":"not admitted"),reason:lastPlan.refused,settled:null,entityId:null};
        return{state:/** @type {const} */("ok"),groupId,ownerTick:lastPlan.tick,currentTick:tick,ageTicks:Number.isSafeInteger(tick)&&tick>=lastPlan.tick?tick-lastPlan.tick:null,
            ownerRefused:lastPlan.refused,admitted:lastPlan.admitted.includes(groupId),expectedType,postIndex,postCount:list?.count??0,post,requested,lastAttempt,
            settle:{point:settled,reason:settleReason,nativeBlockReads:reads,maxBlockReads:240,limited,unreadable},live};
    }
    return { dryRun, reconcileOnce, status, config, enabled,inspectGroup };
}

/**
 * Where a district's people may stand: the plaza `homesFromRecords` finds, then the quarter posts of a lattice
 * around it.
 *
 * One post per district is why a 238-block district read as empty a few dozen blocks from its square: every group
 * of both kinds was pinned to the same spot, so the population only ever existed where the player arrived. The
 * groups are dealt round these posts instead.
 *
 * Every ring post is probed for open ground with `standable` - a point 40 blocks out is as likely to be a roof, a
 * wall top or a tree crown as a street - and a post whose ground cannot be read is left out rather than invented.
 * The plaza is never dropped: a district with a home always keeps at least the one post it had before.
 *
 * @param {any} kingdom
 * @param {(x: number, z: number) => (number | undefined)} [surfaceAt]
 * @param {(x: number, z: number, radius?: number) => ({ x: number, y: number, z: number } | undefined)} [standable]
 * @returns {Record<string, Array<{ x: number, y: number, z: number }>>}
 */
export function postsFromRecords(kingdom, surfaceAt = undefined, standable = undefined) {
    const homes = homesFromRecords(kingdom, surfaceAt, standable);
    /** @type {Record<string, Array<{ x: number, y: number, z: number }>>} */
    const posts = {};
    for (const [districtId, home] of Object.entries(homes)) {
        /** @type {Array<{ x: number, y: number, z: number }>} */
        const list = [{ x: home.x, y: home.y, z: home.z }];
        for (const dx of [-POP_POSTS.spacing, 0, POP_POSTS.spacing]) {
            for (const dz of [-POP_POSTS.spacing, 0, POP_POSTS.spacing]) {
                if (dx === 0 && dz === 0) {
                    continue;
                }
                const x = home.x + dx;
                const z = home.z + dz;
                // Open ground first, then the same topmost-column answer the plaza falls back to. A post is only
                // dropped when neither can be read, which is an unloaded chunk - never a guess.
                let spot;
                try {
                    spot = typeof standable === "function" ? standable(x, z, POP_POSTS.probeRadius) : undefined;
                } catch (_error) {
                    spot = undefined;
                }
                if (spot === undefined || spot === null || !Number.isFinite(spot.y)) {
                    let y;
                    try {
                        y = typeof surfaceAt === "function" ? surfaceAt(x, z) : undefined;
                    } catch (_error) {
                        y = undefined;
                    }
                    spot = Number.isFinite(y) ? { x, y: /** @type {number} */ (y), z } : undefined;
                }
                if (spot !== undefined && spot !== null && Number.isFinite(spot.y)) {
                    list.push({ x: spot.x, y: /** @type {number} */ (spot.y), z: spot.z });
                }
            }
        }
        posts[districtId] = list;
    }
    return posts;
}

/**
 * One post per district, for a caller whose world model knows only a home.
 * @param {Record<string, { x: number, y: number, z: number }>} homes
 * @returns {Record<string, Array<{ x: number, y: number, z: number }>>}
 */
function singlePosts(homes) {
    /** @type {Record<string, Array<{ x: number, y: number, z: number }>>} */
    const posts = {};
    for (const [districtId, home] of Object.entries(homes ?? {})) {
        posts[districtId] = [{ x: home.x, y: home.y, z: home.z }];
    }
    return posts;
}

/**
 * The plaza of each district, read back out of its posts. The reducer wants both: posts decide where groups stand,
 * homes are what a caller that knows nothing of posts still understands.
 * @param {Record<string, Array<{ x: number, y: number, z: number }>>} posts
 * @returns {Record<string, { x: number, y: number, z: number }>}
 */
function plazasOf(posts) {
    /** @type {Record<string, { x: number, y: number, z: number }>} */
    const homes = {};
    for (const [districtId, list] of Object.entries(posts ?? {})) {
        if (Array.isArray(list) && list.length > 0) {
            homes[districtId] = list[0];
        }
    }
    return homes;
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
 * Where each district's people live, from the records the pack actually keeps.
 *
 * A district can carry its footprint two ways, and the second is the one that exists in a real world:
 *  - `physical.origin` is the prototype-layout record, and it already has a height, so it is used as-is;
 *  - `civ` is the civilization build record written by `civ:generate`, and it stores `hq`, `centre` and
 *    `anchor` as plan X/Z with **no Y at all**. Reading only the first shape makes every built district
 *    look homeless, which is how the streets driver came to run for hours, report no error, and spawn
 *    nothing. Of those three, `centre` is read first: `hq` is a building footprint, and the topmost block
 *    over a building is its roof.
 *
 * A district with neither, or whose plan column has no known surface, gets no entry: the reducer then
 * refuses its groups as unhoused instead of the adapter inventing a place to stand.
 *
 * @param {any} kingdom
 * @param {(x: number, z: number) => (number | undefined)} [surfaceAt] the standing Y of a plan column
 * @param {(x: number, z: number) => ({ x: number, y: number, z: number } | undefined)} [standable] open ground near
 *   a plan point; when supplied it decides the whole spot (x, y and z), not only the height
 * @returns {Record<string, { x: number, y: number, z: number }>}
 */
export function homesFromRecords(kingdom, surfaceAt = undefined, standable = undefined) {
    /** @type {Record<string, { x: number, y: number, z: number }>} */
    const homes = {};
    const districts = Array.isArray(kingdom?.districts) ? kingdom.districts : [];
    for (const district of districts) {
        const id = String(district?.id ?? "");
        if (id.length === 0) {
            continue;
        }
        const origin = district?.physical?.origin;
        if (isPlanar(origin, true)) {
            homes[id] = { x: origin.x, y: origin.y, z: origin.z };
            continue;
        }
        // The plaza, not the headquarters: `hq` is a building footprint, so its "topmost block" is a roof and
        // its neighbours are walls. `centre` is the plan's centroid - the open ground a player joins at.
        const plan = [district?.civ?.centre, district?.civ?.hq, district?.civ?.anchor].find((spot) => isPlanar(spot, false));
        if (plan === undefined) {
            continue;
        }
        if (typeof standable === "function") {
            let spot;
            try {
                spot = standable(plan.x, plan.z);
            } catch (_error) {
                spot = undefined;
            }
            if (spot !== undefined && spot !== null && Number.isFinite(spot.y)) {
                homes[id] = { x: spot.x, y: /** @type {number} */ (spot.y), z: spot.z };
                continue;
            }
        }
        if (typeof surfaceAt !== "function") {
            continue;
        }
        const y = surfaceAt(plan.x, plan.z);
        if (!Number.isFinite(y)) {
            continue;
        }
        homes[id] = { x: plan.x, y: /** @type {number} */ (y), z: plan.z };
    }
    return homes;
}

/**
 * @param {any} point
 * @param {boolean} needsY true when the caller cannot supply a height of its own
 * @returns {boolean}
 */
function isPlanar(point, needsY) {
    if (point === undefined || point === null || !Number.isInteger(point.x) || !Number.isInteger(point.z)) {
        return false;
    }
    return needsY ? Number.isInteger(point.y) : true;
}
