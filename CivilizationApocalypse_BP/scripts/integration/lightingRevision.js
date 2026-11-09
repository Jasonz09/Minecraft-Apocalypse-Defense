import {createWallLeafSourceGuard} from "../civ/wallLeafRepair.js";
import {isPlant,isTreePart} from "../structures/terrain.js";
import { BlockPermutation, system, world } from "@minecraft/server";
import { rehydrateSiteSteps } from "../civ/districtplan.js";
import { outdoorLightGroups, removalReadiness, lightingFixtureMatches } from "../civ/lightingRevision.js";
import { newOps } from "../civ/regions.js";
import { loadSavedRunSteps,inProtectedArea } from "./civBuilder.js";
import { createChunkLoader } from "./chunkLeases.js";
import { runJobAsync } from "./civScan.js";
import { activeKind, activeToken, cancelActiveJob, finishJob, isBusy, reserveJob } from "./districtBuilder.js";

const loader = createChunkLoader(undefined, undefined, { prefix: "civ-light-edit-", padding: 0, maxGroups: 1, maxChunks: 1 });
const nextTick = () => new Promise((resolve) => system.run(() => resolve(undefined)));
const STATE_PREFIX = "civ:lamps:";
/** @typedef {{ token: any, index: number, view: any, lease?: ReturnType<typeof loader.acquire> }} RevisionSession */
/** @type {RevisionSession | undefined} */
let current;

export function recoverLightingRevision() {
    if (!current) loader.recover();
}

/** @param {number} index @returns {any | undefined} */
export function lightingRevisionStatus(index) {
    if (current?.index === index) return { ...current.view, state: "running" };
    try {
        const raw = world.getDynamicProperty(`${STATE_PREFIX}natural-${index}`);
        if (typeof raw !== "string") return undefined;
        const saved = JSON.parse(raw);
        if (!Number.isInteger(saved.cursor) || saved.cursor < 0) return undefined;
        return { ...saved, state: saved.complete === true ? "complete" : "paused" };
    } catch (_error) { return undefined; }
}

/** @param {{ index: number, civ: any, dimension: any, say: (lines: string[]) => void, preview?:boolean, protectedRects:any[], onEnd?: (complete: boolean) => void }} options */
export function startLightingRevision(options) {
    if (isBusy()) return { ok: false, reason: `another job (${String(activeKind())}) is running` };
    if (options.civ?.status !== "complete") return { ok: false, reason: "finish the district before revising its lights" };
    if(options.dimension?.id!=="minecraft:overworld"||options.civ.dimension!==options.dimension.id)return{ok:false,reason:"lighting needs its verified saved Overworld dimension"};
    const token = reserveJob("lighting-revision");
    if (!token) return { ok: false, reason: "another job is running" };
    const state = { token, index: options.index, view: { cursor: 0, phase: "preparing" }, lease: /** @type {ReturnType<typeof loader.acquire> | undefined} */ (undefined) };
    current = state;
    void revise(options, state);
    return { ok: true };
}

export function abortLightingRevision() {
    if (!current) return false;
    current.token.cancelled = true;
    current.lease?.release();
    if (activeToken() === current.token) cancelActiveJob();
    current = undefined;
    return true;
}

/** @param {Parameters<typeof startLightingRevision>[0]} options @param {RevisionSession} state */
async function revise(options, state) {
    const { token } = state;
    const key = `${STATE_PREFIX}natural-${options.index}`;
    let removed = 0, placed = 0, preserved = 0;
    let complete = false;
    const read = (/** @type {any} */ op) => {
        try { return options.dimension.getBlock(op); } catch (_error) { return undefined; }
    };
    try {
        if(!Array.isArray(options.protectedRects)||options.protectedRects.length>32)throw Error("verified player/neighbor protection is required");
        const protection=options.protectedRects.map(a=>{if(!a||![a.x0,a.z0,a.x1,a.z1].every(Number.isSafeInteger)||a.x0>a.x1||a.z0>a.z1)throw Error("player/neighbor protection invalid");if(a.polygon!==undefined&&(!Array.isArray(a.polygon)||a.polygon.length<3||a.polygon.length>512||a.polygon.some((/** @type {any} */p)=>!Array.isArray(p)||p.length!==2||!p.every(Number.isSafeInteger))))throw Error("protected polygon invalid");return Object.freeze({...a,...(a.polygon?{polygon:Object.freeze(a.polygon.map((/** @type {number[]} */p)=>Object.freeze([...p])))}:{})});});
        const blocked=(/** @type {any[]} */group)=>group.some(op=>inProtectedArea(protection,op.x,op.z));
        const readKingdom=()=>JSON.parse(String(world.getDynamicProperty("civ:kingdom")));
        const sources=createWallLeafSourceGuard(world,readKingdom,()=>token.cancelled);
        const owner=readKingdom().districts.find((/** @type {any} */d)=>d.id==="district-"+options.index)?.civ;
        if(owner?.status!=="complete"||owner?.checksum!==options.civ.checksum||owner?.dimension!==options.dimension.id)throw Error("current completed district source identity differs");
        function* checked(/** @type {Generator<any,any,any>} */generator){for(;;){sources.assert();const n=generator.next();sources.assert();if(n.done)return n.value;yield;}}
        options.say(["Preparing a quieter lighting layout from this district's saved plan. Buildings and interiors stay in place."]);
        const saved = await runJobAsync(token, checked(loadSavedRunSteps(options.civ, newOps(), options.index)));
        if (token.cancelled) return;
        if (!saved?.ok) throw new Error(saved?.reasons.join("; ") ?? "the saved plan could not be read");
        if(saved.district!==options.index||saved.record?.checksum!==options.civ.checksum||saved.queue?.state!=="complete")throw Error("completed saved fixture source proof differs");
        const natural = await runJobAsync(token, checked(rehydrateSiteSteps(saved.plan, options.index, saved.payload.ground, { ...saved.payload.siteOptions, lighting: "natural" })));
        if (token.cancelled) return;
        if (!natural?.ok) throw new Error(natural?.problems.join("; ") ?? "the new layout could not be planned");
        const signature = `${saved.record.checksum}:${natural.record.checksum}`;
        let progress = { signature, cursor: 0 };
        const raw = world.getDynamicProperty(key);
        if (typeof raw === "string") { const old = JSON.parse(raw); if (old.signature === signature && Number.isInteger(old.cursor) && old.cursor >= 0) progress = old; }
        const bound=saved.region;if(!bound||![bound.x0,bound.z0,bound.x1,bound.z1].every(Number.isSafeInteger))throw Error("saved fixture bounds unavailable");
        const detach=(/** @type {any[][]} */groups)=>groups.map(group=>group.map(op=>{if(![op.x,op.y,op.z].every(Number.isSafeInteger)||op.x<bound.x0||op.x>bound.x1||op.z<bound.z0||op.z>bound.z1||op.y< -64||op.y>319)throw Error("generated fixture outside verified saved region");return Object.freeze({...op,states:Object.freeze({...op.states})});}));
        const remove = detach(outdoorLightGroups(saved.record));
        const add = detach(outdoorLightGroups(natural.record));
        const permutations=new Map();const expectedStates=(/** @type {any} */op)=>{const id=JSON.stringify([op.id,op.states]);let p=permutations.get(id);if(!p){p=BlockPermutation.resolve(op.id,op.states??{});permutations.set(id,p);}return p.getAllStates();};
        const matches=(/** @type {any} */block,/** @type {any} */op)=>lightingFixtureMatches(block,op,expectedStates(op));
        const air=BlockPermutation.resolve("minecraft:air");sources.assert();
        const desired = new Map(add.flat().map((op) => [`${op.x},${op.y},${op.z}`, op.id]));
        // Identical fixtures (including hanging tower lanterns) stay untouched.
        const obsolete = remove.filter((group) => !group.every((op) => desired.get(`${op.x},${op.y},${op.z}`) === op.id));
        /** @param {any[][]} groups */
        const byChunk = (groups) => groups.sort((a, b) => Math.floor(a[0].z / 16) - Math.floor(b[0].z / 16) || Math.floor(a[0].x / 16) - Math.floor(b[0].x / 16));
        const work = [...byChunk(obsolete).map((group) => ({ group, remove: true })), ...byChunk(add).map((group) => ({ group, remove: false }))];
        if (progress.cursor > work.length) throw new Error("saved lighting cursor is outside this plan");
        if(options.preview){const counts={obsoleteFixtures:obsolete.length,desiredFixtures:add.length,ready:0,preserved:0,unloaded:0,lanterns:add.flat().filter(op=>op.id==="minecraft:lantern").length,torches:add.flat().filter(op=>op.id==="minecraft:torch").length};
            function* inspect(){for(let i=0;i<obsolete.length;i++){const verdict=blocked(obsolete[i])?"foreign":removalReadiness(obsolete[i],read,expectedStates);counts[verdict==="foreign"?"preserved":verdict]++;if(i%40===39)yield;}}
            await runJobAsync(token,checked(inspect()));sources.assert();state.view={phase:"preview",...counts};options.say(["Natural lighting READ-ONLY preview: "+Object.entries(counts).map(([k,v])=>k+" "+v).join(", "),"Known generated fixture proposal only; loaded snapshot, not a whole-map light-level census. No blocks, journal properties or chunk holds changed."]);complete=true;return;
        }
        loader.recover();sources.assert();
        /** @param {number} cursor @param {boolean} [done] */
        const save = (cursor, done = false) => {
            const view = { signature, cursor, total: work.length, complete: done, removed, placed, preserved };
            sources.assert();world.setDynamicProperty(key, JSON.stringify(view));sources.assert();
            state.view = view;
        };
        save(progress.cursor);
        // Save after every fixture, never a guessed or unreadable cell. Unique chunk ids make late callbacks safe.
        let heldChunk = "";
        for (; progress.cursor < work.length && !token.cancelled; progress.cursor += 1) {
            sources.assert();const item = work[progress.cursor], first = item.group[0];
            const cx = Math.floor(first.x / 16) * 16, cz = Math.floor(first.z / 16) * 16;
            const chunk = `${cx},${cz}`;
            if (chunk !== heldChunk) {
                state.lease?.release();
                state.view = { ...state.view, phase: `loading chunk ${chunk}` };
                state.lease = loader.acquire([{ dimension: options.dimension, cells: [{ x: cx, y: 64, z: cz }, { x: cx + 15, y: 64, z: cz + 15 }] }]);
                let loaded = state.lease.status();
                while (loaded.state === "loading" && !token.cancelled) { await nextTick(); loaded = state.lease.status(); }
                if (token.cancelled) return;
                if (loaded.state !== "ready") throw new Error(`chunk ${chunk}, fixture (${first.x}, ${first.y}, ${first.z}): ${loaded.reason ?? "did not load"}`);
                heldChunk = chunk;
            }
            if(blocked(item.group)){preserved++;sources.assert();save(progress.cursor+1);continue;}
            if (item.remove) {
                const verdict = removalReadiness(item.group, read,expectedStates);sources.assert();
                if (verdict === "unloaded") throw new Error(`fixture at ${first.x},${first.z} is unreadable`);
                if (verdict === "foreign") preserved += 1;
                else for (const op of item.group) {
                    const block = read(op);if(!block)throw Error("fixture final read is unavailable");
                    const setter=block.setPermutation;sources.assert();
                    if(block.typeId==="minecraft:air")continue;
                    if(!matches(block,op)){preserved+=1;break;}
                    sources.assert();if(!matches(block,op)){preserved+=1;break;}
                    sources.assert();
                    setter.call(block,air);removed+=1;sources.assert();
                }
            } else {
                // Whole fixtures are all-or-nothing when obstructed; never place through plants, water or a player's build.
                const cells = item.group.map(read);
                if (cells.some((block) => !block)) throw new Error(`new fixture at ${first.x},${first.z} is unreadable`);
                if (cells.every((block, at) => matches(block,item.group[at]))) {
                    save(progress.cursor + 1);
                    continue;
                }
                if (cells.some((block, at) => block.typeId !== "minecraft:air" && !matches(block,item.group[at]))) preserved += 1;
                else {
                    const bottom = item.group.reduce((a, b) => a.y < b.y ? a : b);
                    const support = read({ x: bottom.x, y: bottom.y - 1, z: bottom.z });
                    if (!support) throw new Error("light support is unreadable");
                const supportId=support.typeId;
                    if (["minecraft:air", "minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava"].includes(support.typeId)||isPlant(support.typeId)||isTreePart(support.typeId)) preserved += 1;
                    else for (let at = item.group.length - 1; at >= 0; at -= 1) {
                        const op=item.group[at],permutation=BlockPermutation.resolve(op.id,op.states??{}),block=read(op);if(!block)throw Error("new fixture final read unavailable");const setter=block.setPermutation;sources.assert();if(matches(block,op))continue;
                        if(block.typeId!=="minecraft:air"){preserved++;break;}
                        sources.assert();if(block.typeId!=="minecraft:air"){preserved++;break;}
                        const finalSupport=read({x:bottom.x,y:bottom.y-1,z:bottom.z});if(!finalSupport)throw Error("light support final read is unavailable");
                        sources.assert();
                        // Existing writes are per-cell, never atomic for a whole post.
                        // Recheck footing after target and metadata callbacks. A late
                        // footing HOLD retains verified cells/cursor for explicit resume.
                        if(block.typeId!=="minecraft:air"){preserved++;break;}
                        if(finalSupport.isValid===false||finalSupport.typeId!==supportId)throw Error("light footing changed during fixture; verified partial cells retained");
                        setter.call(block,permutation);placed++;sources.assert();
                    }
                }
            }
            sources.assert();save(progress.cursor + 1);
            if (progress.cursor % 40 === 0) { options.say([`Lighting: ${progress.cursor + 1}/${work.length} fixtures; ${removed} old blocks removed, ${placed} new blocks placed.`]); await nextTick(); }
        }
        if (!token.cancelled) {
            save(work.length, true);
            complete = true;
            options.say([`Natural lighting complete: ${removed} old lighting blocks removed, ${placed} new blocks placed; ${preserved} obstructed fixtures preserved. Open land is intentionally darker.`]);
        }
    } catch (error) {
        options.say([`Lighting paused: ${String(error)}. Saved progress is retained; run civ:lights_natural district=${options.index} again.`]);
    } finally {
        state.lease?.release();
        finishJob(token);
        if (current === state) current = undefined;
        options.onEnd?.(complete);
    }
}
