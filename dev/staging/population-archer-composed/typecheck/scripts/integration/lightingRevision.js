import { BlockPermutation, system, world } from "@minecraft/server";
import { rehydrateSiteSteps } from "../civ/districtplan.js";
import { outdoorLightGroups, removalReadiness } from "../civ/lightingRevision.js";
import { newOps } from "../civ/regions.js";
import { loadSavedRunSteps } from "./civBuilder.js";
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

/** @param {{ index: number, civ: any, dimension: any, say: (lines: string[]) => void, onEnd?: (complete: boolean) => void }} options */
export function startLightingRevision(options) {
    if (isBusy()) return { ok: false, reason: `another job (${String(activeKind())}) is running` };
    if (options.civ?.status !== "complete") return { ok: false, reason: "finish the district before revising its lights" };
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
        loader.recover();
        options.say(["Preparing a quieter lighting layout from this district's saved plan. Buildings and interiors stay in place."]);
        const saved = await runJobAsync(token, loadSavedRunSteps(options.civ, newOps(), options.index));
        if (token.cancelled) return;
        if (!saved?.ok) throw new Error(saved?.reasons.join("; ") ?? "the saved plan could not be read");
        const natural = await runJobAsync(token, rehydrateSiteSteps(saved.plan, options.index, saved.payload.ground, { ...saved.payload.siteOptions, lighting: "natural" }));
        if (token.cancelled) return;
        if (!natural?.ok) throw new Error(natural?.problems.join("; ") ?? "the new layout could not be planned");
        const signature = `${saved.record.checksum}:${natural.record.checksum}`;
        let progress = { signature, cursor: 0 };
        const raw = world.getDynamicProperty(key);
        if (typeof raw === "string") { const old = JSON.parse(raw); if (old.signature === signature && Number.isInteger(old.cursor) && old.cursor >= 0) progress = old; }
        const remove = outdoorLightGroups(saved.record);
        const add = outdoorLightGroups(natural.record);
        const desired = new Map(add.flat().map((op) => [`${op.x},${op.y},${op.z}`, op.id]));
        // Identical fixtures (including hanging tower lanterns) stay untouched.
        const obsolete = remove.filter((group) => !group.every((op) => desired.get(`${op.x},${op.y},${op.z}`) === op.id));
        /** @param {any[][]} groups */
        const byChunk = (groups) => groups.sort((a, b) => Math.floor(a[0].z / 16) - Math.floor(b[0].z / 16) || Math.floor(a[0].x / 16) - Math.floor(b[0].x / 16));
        const work = [...byChunk(obsolete).map((group) => ({ group, remove: true })), ...byChunk(add).map((group) => ({ group, remove: false }))];
        if (progress.cursor > work.length) throw new Error("saved lighting cursor is outside this plan");
        /** @param {number} cursor @param {boolean} [done] */
        const save = (cursor, done = false) => {
            const view = { signature, cursor, total: work.length, complete: done, removed, placed, preserved };
            world.setDynamicProperty(key, JSON.stringify(view));
            state.view = view;
        };
        save(progress.cursor);
        // Save after every fixture, never a guessed or unreadable cell. Unique chunk ids make late callbacks safe.
        let heldChunk = "";
        for (; progress.cursor < work.length && !token.cancelled; progress.cursor += 1) {
            const item = work[progress.cursor], first = item.group[0];
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
            if (item.remove) {
                const verdict = removalReadiness(item.group, read);
                if (verdict === "unloaded") throw new Error(`fixture at ${first.x},${first.z} is unreadable`);
                if (verdict === "foreign") preserved += 1;
                else for (const op of item.group) {
                    const block = read(op);
                    if (block.typeId !== "minecraft:air") { block.setPermutation(BlockPermutation.resolve("minecraft:air")); removed += 1; }
                }
            } else {
                // Whole fixtures are all-or-nothing when obstructed; never place through plants, water or a player's build.
                const cells = item.group.map(read);
                if (cells.some((block) => !block)) throw new Error(`new fixture at ${first.x},${first.z} is unreadable`);
                if (cells.every((block, at) => block.typeId === item.group[at].id)) {
                    save(progress.cursor + 1);
                    continue;
                }
                if (cells.some((block, at) => block.typeId !== "minecraft:air" && block.typeId !== item.group[at].id)) preserved += 1;
                else {
                    const bottom = item.group.reduce((a, b) => a.y < b.y ? a : b);
                    const support = read({ x: bottom.x, y: bottom.y - 1, z: bottom.z });
                    if (!support) throw new Error("light support is unreadable");
                    if (["minecraft:air", "minecraft:water", "minecraft:flowing_water", "minecraft:lava"].includes(support.typeId)) preserved += 1;
                    else for (let at = item.group.length - 1; at >= 0; at -= 1) {
                        const op = item.group[at], block = cells[at];
                        if (block.typeId !== op.id) { block.setPermutation(BlockPermutation.resolve(op.id, op.states ?? {})); placed += 1; }
                    }
                }
            }
            save(progress.cursor + 1);
            if (progress.cursor % 40 === 0) { options.say([`Lighting: ${progress.cursor + 1}/${work.length} fixtures; ${removed} old blocks removed, ${placed} new blocks placed.`]); await nextTick(); }
        }
        if (!token.cancelled) {
            complete = true;
            save(work.length, true);
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
