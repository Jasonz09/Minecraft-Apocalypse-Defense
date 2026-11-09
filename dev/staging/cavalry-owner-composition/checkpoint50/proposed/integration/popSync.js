import {createRoleBudget} from "../population/roleBudget.js";
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
 * and applies the result. Streets constructs it as the sole owner; this module registers no timer.
 * The optional staged creationBindings protocol records issued instances separately from the advisory cursor.
 *
 * Safety rules enforced here, on top of the reducer's:
 *  - the cursor is written only AFTER the actions are applied. A crash in between leaves the cursor behind the
 *    world. Loaded tagged actors can be adopted. Legacy tag-only ownership cannot exclude an UNLOADED
 *    surviving actor; the isolated reproduction disproves the earlier unconditional no-duplicate claim.
 *    Opt-in creation bindings hold an issued-but-unobserved generation instead of inferring death;
 *  - every spawn is re-checked against a dimension-wide tag query first, so a representative that wandered
 *    outside the observation window is adopted when LOADED. Unloaded absence is not death or removal;
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
    const creationBindings=deps.creationBindings;
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
        const compoundActive=compoundRows().length>0;
        const snapshot=militaryPolicy(kingdom);
        const policy=snapshot?.selection?snapshot:null;
        const session = observe(kingdom, anchors, posts,policy!==null||!!creationBindings);
        if(policy?.selection){const found=findTagged(tagFor(policy.selection.groupId),true);diagnose("observe",policy.selection.groupId,found);for(const handle of found)session.admit(handle);}
        let result = reconcile(prior, session.observation, tick, config,policy?.typeForGroup??(creationBindings?(group=>POP_ENTITY_TYPES[group.kind]):undefined),policy?.physicalCostForGroup??deps.physicalCostForGroup);
        if(policy!==null||compoundActive)chargeMilitaryWork(result.report.work??0);
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
            result = reconcile(prior, session.observation, tick, config,policy?.typeForGroup??(creationBindings?(group=>POP_ENTITY_TYPES[group.kind]):undefined),policy?.physicalCostForGroup??deps.physicalCostForGroup);
            if(policy!==null||compoundActive)chargeMilitaryWork(result.report.work??0);
        }
        attachCompoundMaintenance(result,prior,tick);
        lastPlan={tick,posts:Object.fromEntries(Object.entries(posts).map(([id,list])=>[id,{count:list.length,points:list.slice(0,9).map((/** @type {any} */p)=>({...p}))}])),
            counts:new Map(kingdom.districts.map((/** @type {any} */d)=>[d.id,{civ:d.civilians,sol:d.soldiers}])),policy:snapshot,
            admitted:[...result.state.physical],actions:result.actions,refused:result.report.refused??null,deferred:result.report.deferred??[],outcomes:[],
            bound:new Set(session.observation.entities.flatMap((/** @type {any} */e)=>classifyTags(e.tags).claims))};
        return { result, handles: session.handles,policy:snapshot };
    };

    /**
     * @param {number} tick
     * @returns {{ refused: string | null, plan: any, cursor: string,cursorRaw?:unknown }}
     */
    const planFromStore = (tick) => {
        militaryWork=0;
        const cursorRaw=world.getDynamicProperty(POP_CURSOR_KEY);
        const loaded = decodeCursor(cursorRaw);
        if (loaded.status === "newer") {
            return { refused: `cursor refused: ${String(loaded.reason)}`, plan: null, cursor: loaded.status };
        }
        const kingdom = readKingdom();
        if (kingdom === undefined || kingdom === null) {
            return { refused: "no kingdom records are stored yet", plan: null, cursor: loaded.status };
        }
        try {
            const rows=compoundRows();if(rows.some(r=>[r.rider,r.mount].some(m=>!["never","cancelled"].includes(m.phase)))&&loaded.status!=="ok")throw Error("issued compound quota cursor missing/corrupt; no budget reset from absence");
            const planned = plan(loaded.state, kingdom, tick);
            return { refused: planned.result.report.refused ?? null, plan: planned, cursor: loaded.status,cursorRaw };
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
        if(creationBindings){try{creationBindings.recoverIssuance();}catch(error){return{refused:"creation issuance recovery held: "+String(error),actions:[],report:null,applied:[],skipped:[],failed:[],saved:false};}}
        const planned = planFromStore(tick);
        if (planned.plan === null || planned.refused !== null) {
            return { refused: planned.refused, actions: [], report: planned.plan?.result.report ?? null, applied: [], skipped: [], failed: [], saved: false };
        }
        if(creationBindings){
            try{const rows=[];for(const handle of planned.plan.handles.values()){const d=describe(handle);if(!d)throw Error("creation observation unreadable");const read=classifyTags(d.tags);if(read.claims.length===1&&isCanonicalFor(read.ownTags,read.claims[0]))rows.push({groupId:read.claims[0],id:d.id,typeId:d.typeId,tags:d.tags});}creationBindings.observeLoaded(rows);}
            catch(error){return{refused:"creation binding observation held: "+String(error),actions:[],report:planned.plan.result.report,applied:[],skipped:[],failed:[],saved:false};}
        }
        const jobs=planned.plan.result.compoundMaintenance??[];
        if(jobs.length){try{publishCompoundBudget(planned.cursorRaw,planned.plan.result.state);planned.plan.result.report.compound.quotaPrepaid=true;}catch(error){return{refused:String(error),actions:[],report:planned.plan.result.report,applied:[],skipped:[],failed:[],saved:false};}}
        const maintenance=applyCompoundMaintenance(jobs,planned.plan.policy);
        const outcome = maintenance.held?{applied:[],skipped:[],failed:[],militaryRefused:maintenance.held}:applyActions(planned.plan.result.actions, planned.plan.handles,planned.plan.policy);
        outcome.applied.unshift(...maintenance.applied);
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

    /** @returns {any[]} */
    function compoundRows(){const rows=creationBindings?.listCompounds?.()??[];if(!Array.isArray(rows)||rows.length>config.maxPhysicalTotal)throw Error("compound maintenance record cap");return rows;}
    /** Plans one charged role operation at a time; native compound birth remains disabled.
     * @param {any[]} rows @param {string[]} admitted */
    function cleanupJobs(rows,admitted){const jobs=[],held=[];for(const r of rows){const cleanup=!admitted.includes(r.group)||[r.rider,r.mount].some(m=>["terminal","cancelled","removing"].includes(m.phase));if([r.rider,r.mount].some(m=>m.phase==="pending")){held.push(r.group+": pending role outcome unknown");continue;}if(!cleanup){if([r.rider,r.mount].some(m=>m.phase==="never"))held.push(r.group+": compound birth disabled; incomplete role remains tracked");continue;}for(const role of ["rider","mount"]){const m=r[role];if(m.phase==="never"||["alive","removing"].includes(m.phase))jobs.push({groupId:r.group,role,kind:m.phase==="never"?"cancel":"remove",epoch:r.epoch,generation:r.generation,id:m.actor,type:m.type});}}return{jobs,held};}
    /** @param {any} result @param {any} prior @param {number} tick */
    function attachCompoundMaintenance(result,prior,tick){const rows=compoundRows();if(!rows.length)return;const scheduled=cleanupJobs(rows,result.state.physical),groups=new Set(rows.map(r=>r.group));const budget=createRoleBudget({tick:prior?.tick??null,ops:prior?.ops??0,spawns:prior?.spawns??0},tick,config),jobs=[];for(const job of scheduled.jobs){if(budget.reserve(job.kind==="cancel"?"cancel":"remove"))jobs.push(job);else scheduled.held.push(job.groupId+": role budget pending");}
        const ordinary=[];for(const action of result.actions){if(groups.has(action.groupId))continue;if(action.op==="spawn"&&(scheduled.jobs.length||scheduled.held.length)){result.report.pending.spawn++;continue;}if(budget.reserve(action.op==="spawn"?"spawn":"remove"))ordinary.push(action);else result.report.pending[action.op]++;}
        result.actions=ordinary;result.compoundMaintenance=jobs;const used=budget.status();result.state.ops=used.ops;result.state.spawns=used.spawns;Object.assign(result.report.budget,{opsUsed:used.ops,spawnsUsed:used.spawns});result.report.compound={scheduledRoleOps:jobs.length,roleJobs:jobs.map(j=>({...j})),held:scheduled.held,birthEnabled:false,quotaPrepaid:false};if(scheduled.held.length)result.report.hold="Mounted guard is waiting: "+scheduled.held[0];result.report.actions={spawn:ordinary.filter(a=>a.op==="spawn").length,despawn:ordinary.filter(a=>a.op==="despawn").length+jobs.filter(j=>j.kind==="remove").length,retag:ordinary.filter(a=>a.op==="retag").length};
    }
    /** @param {unknown} expected @param {import("../population/cursor.js").CursorState} state */
    function publishCompoundBudget(expected,state){const raw=encodeCursor(state);if(cursorBytes(state)>POP_CURSOR_MAX_BYTES||world.getDynamicProperty(POP_CURSOR_KEY)!==expected)throw Error("compound budget cursor changed; no native work");world.setDynamicProperty(POP_CURSOR_KEY,raw);if(world.getDynamicProperty(POP_CURSOR_KEY)!==raw)throw Error("compound budget publication unverified; no native work");}
    /** @param {any} policy */
    function compoundPolicyCurrent(policy){if(policy!==null&&militaryPolicy(readKingdom())?.stamp!==policy.stamp)throw Error("military selection changed before compound work");}
    /** @param {any} h */
    function compoundFrame(h){chargeMilitaryWork(1);const at=h.location,tags=h.getTags();if(!Array.isArray(tags)||tags.length>64||tags.some(t=>typeof t!=="string"||t.length>256))throw Error("compound native tags unreadable");chargeMilitaryWork(tags.length+1);return{id:String(h.id),typeId:String(h.typeId),valid:h.isValid,location:{x:at.x,y:at.y,z:at.z},tags:[...tags].sort()};}
    /** Strictly bounded global-tag query; absent loaded actor is NEVER a terminal receipt.
     * @param {string} tag */
    function compoundQuery(tag){chargeMilitaryWork(1);const rows=dimension.getEntities({tags:[tag],location:{x:0,y:64,z:0},closest:2});if(!Array.isArray(rows)||rows.length>1)throw Error("compound query failed or duplicate; preserve pair");return rows;}
    /** All metadata checks precede repeated final native role/relationship proof.
     * @param {any} job @param {any} policy */
    function compoundPreflight(job,policy){const core=creationBindings.compound(),r=core.inspect(job.groupId);if(!r||r.kind!=="compound"||r.epoch!==job.epoch||r.generation!==job.generation||r[job.role].actor!==job.id||r[job.role].type!==job.type)throw Error("compound job identity changed");if(dimension.id!=="minecraft:overworld")throw Error("compound dimension mismatch");const handles=new Map(),frames=new Map();
        for(const role of ["rider","mount"]){const m=r[role],tag=`civcavalry:v1:${r.epoch}:${r.group}:${r.generation}:${role}`,matches=compoundQuery(tag);if(["never","terminal","cancelled"].includes(m.phase)){if(matches.length)throw Error("unissued/terminal compound actor reappeared; preserve pair");continue;}if(m.phase==="pending")throw Error("compound pending outcome unknown; preserve pair");if(matches.length!==1)throw Error("compound role unloaded/absent; preserve pair");const h=matches[0],frame=compoundFrame(h);core.assertOwned({groupId:r.group,role,id:frame.id,typeId:frame.typeId,tags:frame.tags});handles.set(role,h);frames.set(role,frame);}
        compoundPolicyCurrent(policy);
        const rider=handles.get("rider"),mount=handles.get("mount");let riding=null,riders=[];
        if(mount){chargeMilitaryWork(1);const rideable=mount.getComponent("minecraft:rideable");if(!rideable||typeof rideable.getRiders!=="function")throw Error("compound rideable proof unavailable");chargeMilitaryWork(1);riders=rideable.getRiders();if(!Array.isArray(riders)||riders.length>1)throw Error("ambiguous compound riders");if(riders.length&&(!rider||String(riders[0].id)!==String(rider.id)))throw Error("foreign rider attached; preserve pair");}
        if(rider){chargeMilitaryWork(1);const relation=rider.getComponent("minecraft:riding");if(relation){riding=relation.entityRidingOn;if(!mount||!riding||String(riding.id)!==String(mount.id))throw Error("rider on foreign mount; preserve pair");}}
        if(Boolean(riding)!==Boolean(riders.length))throw Error("compound riding directions disagree");
        for(const[role,h]of handles){const a=compoundFrame(h);if(!chunkLoadedAt(a.location))throw Error("compound final chunk unloaded");chargeMilitaryWork(1);const loadedBlock=dimension.getBlock(a.location);if(!loadedBlock||loadedBlock.isValid!==true)throw Error("compound final loaded block unreadable");const b=compoundFrame(h),c=compoundFrame(h),m=r[role],tag=`civcavalry:v1:${r.epoch}:${r.group}:${r.generation}:${role}`;
            if(a.id!==m.actor||a.typeId!==m.type||a.valid!==true||![a.location.x,a.location.y,a.location.z].every(Number.isFinite)||a.tags.filter(t=>t.startsWith("civcavalry:")).length!==1||!a.tags.includes(tag)||JSON.stringify(a)!==JSON.stringify(b)||JSON.stringify(b)!==JSON.stringify(c)||JSON.stringify(frames.get(role))!==JSON.stringify(a))throw Error("compound native identity/location changed after metadata");
            const own=a.tags.filter(t=>t.startsWith("civpop:"));if(role==="rider"?(own.length!==1||own[0]!==tagFor(r.group)):own.length!==0)throw Error("compound canonical role changed");}
        return{core,record:r,handles,frames};
    }
    /** @param {any[]} jobs @param {any} policy */
    function applyCompoundMaintenance(jobs,policy){const applied=[];let held=null;for(const job of jobs){try{let proof=compoundPreflight(job,policy),member=proof.record[job.role];if(job.kind==="cancel"){if(member.phase!=="never")throw Error("role no longer never-created");proof.core.cancelNeverCreated(job.groupId,job.role);applied.push({action:{op:"cancel-role",...job},reason:null,entityId:null});continue;}
            if(!["alive","removing"].includes(member.phase))throw Error("compound role terminal changed");const frame=proof.frames.get(job.role),ticket=proof.core.beginRemove({groupId:job.groupId,role:job.role,id:frame.id,typeId:frame.typeId,tags:frame.tags});proof=compoundPreflight(job,policy);const h=proof.handles.get(job.role);if(!h)throw Error("compound removal actor unavailable");h.remove();if(h.isValid!==false)throw Error("compound owner removal not positively observed");proof.core.commitRemoved(ticket);applied.push({action:{op:"despawn",groupId:job.groupId,entityId:job.id,role:job.role,reason:"compound tracked owner cleanup"},reason:null,entityId:job.id});
        }catch(error){held=String(error);break;}}return{applied,held};}

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
                if(creationBindings||policy?.selection||error instanceof MilitaryOwnerRefusal){militaryRefused=String(error);break;}
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
        const removal=creationBindings?.beginRemove({groupId:action.groupId,id:String(handle.id),typeId:handle.typeId,tags:[...handle.getTags()]});
        beforeWrite?.();
        if(removal){const live=findTagged(tagFor(action.groupId),true);if(live.length!==1||String(live[0].id)!==removal.actor)throw Error("owner removal uniqueness changed; all preserved");creationBindings.assertOwned({groupId:action.groupId,id:String(live[0].id),typeId:live[0].typeId,tags:[...live[0].getTags()]});}
        // Binding metadata callbacks may change selection; check its existing live policy
        // once more before the final native-only actor proof, never after removal.
        beforeWrite?.();
        // Metadata getters above may execute native/user code. Never reuse their earlier
        // copied tags as permission to remove the handle. Finish all metadata work first,
        // then prove the live actor twice around the final loaded-column probe.
        if(removal){
            const frame=()=>{const at=handle.location;return{id:String(handle.id),type:String(handle.typeId),valid:handle.isValid,
                location:{x:at.x,y:at.y,z:at.z},tags:[...handle.getTags()].sort()};};
            const first=frame();
            if(!chunkLoadedAt(first.location))throw Error("owner removal final chunk unloaded; preserved");
            const second=frame(),third=frame();
            const valid=(/** @type {any} */f)=>f.id===removal.actor&&f.type===removal.type&&f.valid===true&&
                Number.isFinite(f.location.x)&&Number.isFinite(f.location.y)&&Number.isFinite(f.location.z)&&
                f.tags.length<=64&&f.tags.every((/** @type {any} */t)=>typeof t==="string"&&t.length<=256)&&
                isCanonicalFor(classifyTags(f.tags).ownTags,action.groupId)&&
                f.tags.filter((/** @type {string} */t)=>t.startsWith("civbirth:")).length===1&&
                f.tags.includes(removal.tag??`civbirth:v2:${removal.epoch}:${removal.group}:${removal.generation}`);
            if(!valid(first)||!valid(second)||!valid(third)||JSON.stringify(first)!==JSON.stringify(second)||JSON.stringify(second)!==JSON.stringify(third))throw Error("owner removal final live identity/location changed; preserved");
        }
        const removalId=removal?removal.actor:String(handle.id);handle.remove();
        if(removal){if(handle.isValid!==false||removal.actor!==removalId)throw Error("owner removal not positively observed; binding held");creationBindings.commitRemoved(removal);}
        return { ok: true, reason: null };
    }

    /**
     * @param {any} action
     * @param {Map<string, any>} handles
     * @param {()=>void} [beforeWrite]
     */
    function retagOne(action, handles,beforeWrite) {
        if(creationBindings)return{ok:false,reason:"creation binding retag requires explicit protocol; representative preserved"};
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
        if(action.typeId==="civ_trial:cavalry")return{ok:false,reason:"compound native birth disabled; maintenance only"};
        const tag = tagFor(action.groupId);
        if (findTagged(tag,!!creationBindings).length > 0) {
            return { ok: false, reason: "representative-exists" };
        }
        if(creationBindings){const permission=creationBindings.canBirth(action.groupId,action.typeId);if(!permission.allowed)return{ok:false,reason:permission.reason};}
        const at = settleSpot(action.at);
        if (at === undefined) {
            return { ok: false, reason: "no-safe-standing-spot" };
        }
        if (!chunkLoadedAt(at)) {
            return { ok: false, reason: "chunk-unloaded",settled:at };
        }
        beforeWrite?.();
        const ticket=creationBindings?.prepare(action.groupId,action.typeId);
        beforeWrite?.();
        if(creationBindings&&findTagged(tag,true).length>0)throw Error("representative appeared after birth prepare; pending binding held");
        const entity = dimension.spawnEntity(action.typeId, at),spawnedId=String(entity.id);
        const rollbackNewborn=()=>{if(String(entity.id)!==spawnedId)throw Error("newborn identity changed; preserved");entity.remove();if(entity.isValid!==false)throw Error("newborn removal not positively observed");if(ticket)creationBindings.rollbackRemoved(ticket,spawnedId);};
        if(ticket){try{creationBindings.recordSpawned(ticket,spawnedId);}catch(error){try{rollbackNewborn();}catch(_rollback){}throw error;}}
        let tagged = false;
        try {
            tagged = entity.addTag(tag) === true;
            if(tagged&&ticket)tagged=entity.addTag(ticket.tag)===true;
        } catch (_error) {
            tagged = false;
        }
        if (!tagged) {
            // We created this unit a moment ago, so removing it is a rollback, not a removal of population.
            try {
                if(ticket)rollbackNewborn();else entity.remove();
                return { ok: false, reason: "tag-failed-rolled-back" };
            } catch (_error) {
                return { ok: false, reason: ticket?"tag-failed-rollback-unverified; pending binding held":"tag-failed-stray-untagged" };
            }
        }
        if(ticket){const live=findTagged(tag,true);if(live.length!==1||String(live[0].id)!==spawnedId)throw Error("newborn canonical census changed; binding pending");creationBindings.confirmBorn(ticket,{groupId:action.groupId,id:String(live[0].id),typeId:live[0].typeId,tags:[...live[0].getTags()]});}
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
    /** Same callback, same persisted tick quotas; never a namespace-only remove-all.
     * @param {any[]} found @param {number|undefined} tick @param {any} policy @param {any[]} pairs */
    function teardownCompounds(found,tick,policy,pairs){if(!Number.isSafeInteger(tick)||/** @type {number} */(tick)<0)throw Error("compound teardown requires explicit owner tick");const at=/** @type {number} */(tick),raw=world.getDynamicProperty(POP_CURSOR_KEY),cursor=decodeCursor(raw);if(cursor.status==="newer"||pairs.some(r=>[r.rider,r.mount].some(m=>!["never","cancelled"].includes(m.phase)))&&cursor.status!=="ok")throw Error("compound teardown quota cursor missing/corrupt/newer; preserve pair");const result=/** @type {any} */({actions:[],state:{...cursor.state,tick:at,runs:cursor.state.runs+1,physical:[]},report:{pending:{spawn:0,despawn:0,retag:0},budget:{}}});
        const pairIds=new Set(pairs.map(r=>r.group)),handles=new Map(),seen=new Set();for(const h of found){const tags=h.getTags();if(!Array.isArray(tags)||tags.length>64)throw Error("compound teardown tag cap");chargeMilitaryWork(tags.length+1);const read=classifyTags(tags),g=read.claims[0];if(!isCanonicalFor(read.ownTags,g)||seen.has(g))throw Error("compound teardown canonical ambiguity");seen.add(g);if(pairIds.has(g))continue;const id=String(h.id);creationBindings.assertOwned({groupId:g,id,typeId:h.typeId,tags:[...tags]});handles.set(id,h);result.actions.push({op:"despawn",groupId:g,entityId:id,reason:"people gate-off owner cleanup"});}
        attachCompoundMaintenance(result,cursor.state,at);const jobs=result.compoundMaintenance??[];if(!jobs.length&&!result.actions.length)return{removed:0,held:result.report.compound?.held?.[0]??"compound role budget pending"};publishCompoundBudget(raw,result.state);const maintenance=applyCompoundMaintenance(jobs,policy);const ordinary=maintenance.held?{applied:[],militaryRefused:maintenance.held,failed:[],skipped:[]}:applyActions(result.actions,handles,policy);return{removed:maintenance.applied.filter(e=>e.action.op==="despawn").length+ordinary.applied.length,held:maintenance.held??ordinary.militaryRefused??ordinary.failed[0]?.error??ordinary.skipped[0]?.reason??result.report.compound?.held?.[0]??null};}
    /** Gate-off removes only already-issued loaded actors through removeOne, never a new owner.
     * No planning, birth, retag, cursor reset, or absent-instance terminal inference.
     * @param {any[]} found @param {number} [tick] */
    function teardownBound(found,tick=undefined){
        if(!creationBindings)throw Error("durable teardown requires creation bindings");
        if(!Array.isArray(found)||found.length>config.maxPhysicalTotal)throw Error("bound teardown census cap");
        militaryWork=0;creationBindings.recoverIssuance();
        const policy=militaryPolicy(readKingdom()),seen=new Set(),handles=new Map(),actions=[];
        const pairs=compoundRows();if(pairs.length)return teardownCompounds(found,tick,policy,pairs);
        // Full preflight before the first removal: unknown/legacy/duplicate identities hold all.
        for(const h of found){const tags=h.getTags();if(!Array.isArray(tags)||tags.length>64)throw Error("bound teardown tags cap");
            const read=classifyTags(tags),groupId=read.claims[0],id=String(h.id);
            if(!parseGroupId(groupId)||!isCanonicalFor(read.ownTags,groupId)||seen.has(groupId)||handles.has(id)||h.isValid!==true)throw Error("bound teardown identity/duplicate conflict; preserved");
            seen.add(groupId);handles.set(id,h);
            const matches=findTagged(tagFor(groupId),true);if(matches.length!==1||String(matches[0].id)!==id)throw Error("bound teardown uniqueness conflict; preserved");
            creationBindings.assertOwned({groupId,id,typeId:h.typeId,tags:[...tags]});
            actions.push({op:"despawn",groupId,entityId:id,reason:"people gate-off exact owner removal"});
        }
        const result=applyActions(actions,handles,policy);
        return{removed:result.applied.length,held:result.militaryRefused??result.failed[0]?.error??result.skipped[0]?.reason??null};
    }
    return { dryRun, reconcileOnce, status, config, enabled,inspectGroup,teardownBound };
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
