import { CIV_LIMITS } from "./budget.js";
import { createChunkedStore, fnv1a } from "./planstore.js";

// Resumable job-queue model for the staged construction pipeline. Pure JS, deterministic.
//
// Model: ordered STAGES (clear, walls, gates, roads, lots, dressing), each holding ELEMENTS
// (a wall segment, a road, a lot...). An element is `total` idempotent operations (usually block
// writes) with a `cursor` (operations [0, cursor) are known complete and persisted), a status, an
// attempt count and a hash of the inputs it was derived from.
//
// REPLAY SEMANTICS (the contract the builder must honour):
//   * Work items are half-open op ranges [from, to) of one element. Executing a range must be
//     idempotent: it sets blocks to the target state and treats "already target" as success.
//   * The cursor only advances AFTER the range was executed and the queue marked via markProgress.
//     If the process dies between executing and persisting, the range simply runs again from the
//     last persisted cursor. Result: every operation runs AT LEAST once, none is ever skipped.
//   * recover() (call it right after loading) turns 'running' back into 'pending' keeping the cursor.
//   * Stage barriers: a stage's work is only issued once every stage in its `requires` list has all
//     elements done or skipped. Default: each stage requires ALL earlier stages (so no lots before
//     walls and gates exist). A 'failed' element blocks its barrier until it is reset or skipped.
//   * States: running | paused | aborted | complete. nextWork issues nothing unless 'running'.
//     abort is terminal. markProgress is still accepted while paused so an in-flight slice can land.

export const JOB_STAGES = Object.freeze(["clear", "walls", "gates", "roads", "lots", "dressing"]);
export const JOB_FORMAT = "civ-jobs";
export const JOB_VERSION = 1;
export const JOB_PREFIX = "civ:jobs";
export const MAX_ATTEMPTS_DEFAULT = 5;
const HASH_MOD = 36 ** 6;

/** @typedef {"pending"|"running"|"done"|"failed"|"skipped"} ElementStatus */
/** @typedef {"running"|"paused"|"aborted"|"complete"} QueueState */
/**
 * @typedef {{ name: string, start: number, count: number }} StageInfo
 * @typedef {{
 *   planHash: string, state: QueueState, maxAttempts: number, stages: StageInfo[],
 *   requires: Record<string, string[]>|null,
 *   total: number[], cursor: number[], status: ElementStatus[], attempts: number[], hash: number[],
 * }} JobQueue
 * @typedef {{ stage: string, element: number, index: number, from: number, to: number, ops: number }} WorkItem
 * @typedef {{ total: number, hash?: number, inputs?: any }} ElementSpec
 */

/**
 * Hash of an element's inputs, folded to 6 base-36 digits (31 bits) for compact storage.
 * @param {any} inputs
 */
export function hashInputs(inputs) {
    return parseInt(fnv1a(JSON.stringify(inputs)), 16) % HASH_MOD;
}

/**
 * Build a queue. `specs[stage]` is the ordered element list of that stage.
 * @param {Record<string, ElementSpec[]>} specs
 * @param {{ planHash?: string, stages?: readonly string[], requires?: Record<string, string[]>, maxAttempts?: number }} [options]
 * @returns {JobQueue}
 */
export function createQueue(specs, options = {}) {
    const names = options.stages ?? JOB_STAGES;
    /** @type {JobQueue} */
    const queue = {
        planHash: options.planHash ?? "",
        state: "running",
        maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS_DEFAULT,
        stages: [],
        requires: options.requires ?? null,
        total: [],
        cursor: [],
        status: [],
        attempts: [],
        hash: [],
    };
    for (const name of names) {
        const list = specs[name] ?? [];
        queue.stages.push({ name, start: queue.total.length, count: list.length });
        for (const spec of list) {
            if (!Number.isInteger(spec.total) || spec.total < 0) throw new RangeError(`element total must be a non-negative integer (stage ${name})`);
            queue.total.push(spec.total);
            queue.cursor.push(0);
            queue.status.push(spec.total === 0 ? "done" : "pending");
            queue.attempts.push(0);
            queue.hash.push(spec.hash !== undefined ? spec.hash % HASH_MOD : hashInputs(spec.inputs ?? null));
        }
    }
    refreshState(queue);
    return queue;
}

/** @param {JobQueue} queue @param {string} stage */
function stageInfo(queue, stage) {
    return queue.stages.find((s) => s.name === stage);
}

/**
 * Stages that must be fully done/skipped before `stage` may start.
 * @param {JobQueue} queue @param {string} stage
 */
export function requiredStages(queue, stage) {
    if (queue.requires !== null && queue.requires[stage] !== undefined) return queue.requires[stage];
    const idx = queue.stages.findIndex((s) => s.name === stage);
    return queue.stages.slice(0, Math.max(0, idx)).map((s) => s.name);
}

/** @param {JobQueue} queue @param {string} stage */
export function stageSatisfied(queue, stage) {
    const info = stageInfo(queue, stage);
    if (info === undefined) return true;
    for (let i = info.start; i < info.start + info.count; i += 1) {
        if (queue.status[i] !== "done" && queue.status[i] !== "skipped") return false;
    }
    return true;
}

/** @param {JobQueue} queue @param {string} stage */
function barrierOpen(queue, stage) {
    return requiredStages(queue, stage).every((s) => stageSatisfied(queue, s));
}

/** Move to 'complete' when every element is done/skipped. @param {JobQueue} queue */
export function refreshState(queue) {
    if (queue.state === "aborted") return queue.state;
    const finished = queue.status.every((s) => s === "done" || s === "skipped");
    if (finished) queue.state = "complete";
    else if (queue.state === "complete") queue.state = "running";
    return queue.state;
}

/**
 * Issue the next bounded slice of work: ordered by stage then element, at most `budget.maxOps`
 * operations in total (default CIV_LIMITS.maxBlocksPerSlice, never above it) and at most
 * `budget.maxElements` elements. Issued elements become 'running'. Calling again without
 * markProgress re-issues the same ranges (idempotent by design).
 * @param {JobQueue} queue
 * @param {{ maxOps?: number, maxElements?: number }} [budget]
 * @returns {{ items: WorkItem[], ops: number, blocked: string|undefined, state: QueueState }}
 */
export function nextWork(queue, budget = {}) {
    const maxOps = Math.max(1, Math.min(budget.maxOps ?? CIV_LIMITS.maxBlocksPerSlice, CIV_LIMITS.maxBlocksPerSlice));
    const maxElements = budget.maxElements ?? Infinity;
    /** @type {WorkItem[]} */
    const items = [];
    let ops = 0;
    if (queue.state !== "running") return { items, ops, blocked: queue.state, state: queue.state };
    /** @type {string|undefined} */
    let blocked;
    for (const stage of queue.stages) {
        if (items.length > 0) break; // a slice never spans a barrier: later stages need these items marked done first
        let any = false;
        for (let i = stage.start; i < stage.start + stage.count; i += 1) {
            const st = queue.status[i];
            if (st === "pending" || st === "running") any = true;
        }
        if (!any) {
            if (!stageSatisfied(queue, stage.name) && blocked === undefined) blocked = `stage ${stage.name} has failed elements`;
            continue;
        }
        if (!barrierOpen(queue, stage.name)) {
            blocked ??= `stage ${stage.name} waits for ${requiredStages(queue, stage.name).filter((s) => !stageSatisfied(queue, s)).join(", ")}`;
            continue;
        }
        for (let i = stage.start; i < stage.start + stage.count && ops < maxOps && items.length < maxElements; i += 1) {
            const st = queue.status[i];
            if (st !== "pending" && st !== "running") continue;
            const from = queue.cursor[i];
            const to = Math.min(queue.total[i], from + (maxOps - ops));
            if (to <= from) continue;
            items.push({ stage: stage.name, element: i, index: i - stage.start, from, to, ops: to - from });
            ops += to - from;
            queue.status[i] = "running";
        }
    }
    if (items.length > 0) blocked = undefined;
    return { items, ops, blocked, state: queue.state };
}

/**
 * Record that operations [0, cursor) of an element are complete. Never moves backwards.
 * @param {JobQueue} queue @param {number} element @param {number} cursor
 */
export function markProgress(queue, element, cursor) {
    if (!Number.isInteger(element) || element < 0 || element >= queue.total.length) throw new RangeError(`no element ${String(element)}`);
    if (cursor > queue.total[element]) throw new RangeError(`cursor ${String(cursor)} beyond element total ${String(queue.total[element])}`);
    if (queue.status[element] === "skipped" || queue.status[element] === "failed") return queue.status[element];
    if (cursor > queue.cursor[element]) queue.cursor[element] = cursor;
    queue.status[element] = queue.cursor[element] >= queue.total[element] ? "done" : "running";
    refreshState(queue);
    return queue.status[element];
}

/**
 * An execution attempt failed (unloaded chunk, obstruction...). Back to pending with the cursor kept,
 * or 'failed' once attempts reach maxAttempts.
 * @param {JobQueue} queue @param {number} element
 */
export function markFailure(queue, element) {
    queue.attempts[element] += 1;
    queue.status[element] = queue.attempts[element] >= queue.maxAttempts ? "failed" : "pending";
    return queue.status[element];
}

/** @param {JobQueue} queue @param {number} element */
export function markSkipped(queue, element) {
    queue.status[element] = "skipped";
    refreshState(queue);
}

/**
 * Forget all progress of one element (cursor 0, attempts 0, pending).
 * @param {JobQueue} queue @param {number} element
 */
export function resetElement(queue, element) {
    queue.cursor[element] = 0;
    queue.attempts[element] = 0;
    queue.status[element] = queue.total[element] === 0 ? "done" : "pending";
    refreshState(queue);
}

/** @param {JobQueue} queue @param {string} stage */
export function resetStage(queue, stage) {
    const info = stageInfo(queue, stage);
    if (info === undefined) return 0;
    for (let i = info.start; i < info.start + info.count; i += 1) resetElement(queue, i);
    return info.count;
}

/**
 * Restart recovery: every 'running' element goes back to 'pending' keeping its cursor, and the
 * interrupted attempt is counted (so an element that keeps killing the server eventually fails).
 * @param {JobQueue} queue
 * @returns {number} how many elements were recovered
 */
export function recover(queue) {
    let n = 0;
    for (let i = 0; i < queue.status.length; i += 1) {
        if (queue.status[i] === "running") {
            queue.attempts[i] += 1;
            queue.status[i] = queue.attempts[i] >= queue.maxAttempts ? "failed" : "pending";
            n += 1;
        }
    }
    return n;
}

/** @param {JobQueue} queue */
export function pause(queue) {
    if (queue.state === "running") queue.state = "paused";
    return queue.state;
}

/** @param {JobQueue} queue */
export function resume(queue) {
    if (queue.state === "paused") queue.state = "running";
    return refreshState(queue);
}

/** Terminal: nothing more is ever issued. @param {JobQueue} queue */
export function abort(queue) {
    queue.state = "aborted";
    return queue.state;
}

/**
 * Re-align a queue with freshly derived specs: elements whose input hash and total are
 * unchanged keep their progress; changed (or new) elements restart from scratch. Stage/element
 * layout differences reset the affected stage only.
 * @param {JobQueue} queue
 * @param {Record<string, ElementSpec[]>} specs
 * @returns {{ queue: JobQueue, kept: number, reset: number }}
 */
export function reconcile(queue, specs) {
    const next = createQueue(specs, {
        planHash: queue.planHash,
        stages: queue.stages.map((s) => s.name),
        requires: queue.requires ?? undefined,
        maxAttempts: queue.maxAttempts,
    });
    next.state = queue.state === "complete" ? "running" : queue.state;
    let kept = 0;
    let reset = 0;
    for (const stage of next.stages) {
        const old = stageInfo(queue, stage.name);
        for (let k = 0; k < stage.count; k += 1) {
            const i = stage.start + k;
            if (old !== undefined && k < old.count) {
                const j = old.start + k;
                if (queue.hash[j] === next.hash[i] && queue.total[j] === next.total[i]) {
                    next.cursor[i] = queue.cursor[j];
                    next.status[i] = queue.status[j];
                    next.attempts[i] = queue.attempts[j];
                    kept += 1;
                    continue;
                }
            }
            reset += 1;
        }
    }
    refreshState(next);
    return { queue: next, kept, reset };
}

/**
 * Progress report: percentage by stage (operation-weighted), overall, and ETA in slices.
 * @param {JobQueue} queue
 * @param {{ sliceOps?: number }} [options]
 */
export function progress(queue, options = {}) {
    const sliceOps = Math.max(1, Math.min(options.sliceOps ?? CIV_LIMITS.maxBlocksPerSlice, CIV_LIMITS.maxBlocksPerSlice));
    let allTotal = 0;
    let allDone = 0;
    const byStage = queue.stages.map((stage) => {
        let total = 0;
        let done = 0;
        const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
        for (let i = stage.start; i < stage.start + stage.count; i += 1) {
            const s = queue.status[i];
            counts[s] += 1;
            if (s === "skipped") continue;
            total += queue.total[i];
            done += s === "done" ? queue.total[i] : queue.cursor[i];
        }
        allTotal += total;
        allDone += done;
        return { name: stage.name, elements: stage.count, ops: total, doneOps: done, pct: total === 0 ? 100 : Math.floor((done * 1000) / total) / 10, counts };
    });
    const remainingOps = allTotal - allDone;
    return {
        state: queue.state,
        pct: allTotal === 0 ? 100 : Math.floor((allDone * 1000) / allTotal) / 10,
        remainingOps,
        totalOps: allTotal,
        etaSlices: Math.ceil(remainingOps / sliceOps),
        byStage,
        failed: queue.status.filter((s) => s === "failed").length,
    };
}

// ---------------------------------------------------------------------------------------------
// Compact serialisation. Per element: total (base-36, comma separated), a fixed 6-char base-36
// input hash, and run-length encoded status. Cursors and attempts are stored sparsely (only for
// elements that are neither pending-at-zero nor done). ~6 bytes per element: 600 elements < 8 KB.
// ---------------------------------------------------------------------------------------------

const STATUS_CHAR = /** @type {Record<ElementStatus, string>} */ ({ pending: "p", running: "r", done: "d", failed: "f", skipped: "s" });
const CHAR_STATUS = /** @type {Record<string, ElementStatus>} */ ({ p: "pending", r: "running", d: "done", f: "failed", s: "skipped" });

/** @param {JobQueue} queue */
export function serializeQueue(queue) {
    let statusRuns = "";
    for (let i = 0; i < queue.status.length; ) {
        let j = i;
        while (j < queue.status.length && queue.status[j] === queue.status[i]) j += 1;
        statusRuns += `${STATUS_CHAR[queue.status[i]]}${String(j - i)}`;
        i = j;
    }
    /** @type {string[]} */
    const cursors = [];
    /** @type {string[]} */
    const attempts = [];
    for (let i = 0; i < queue.status.length; i += 1) {
        if (queue.status[i] !== "done" && queue.cursor[i] > 0) cursors.push(`${i.toString(36)}:${queue.cursor[i].toString(36)}`);
        if (queue.attempts[i] > 0) attempts.push(`${i.toString(36)}:${queue.attempts[i].toString(36)}`);
    }
    /** @type {any} */
    const out = {
        f: JOB_FORMAT,
        v: JOB_VERSION,
        ph: queue.planHash,
        st: queue.state,
        ma: queue.maxAttempts,
        sg: queue.stages.map((s) => [s.name, s.count]),
        t: queue.total.map((n) => n.toString(36)).join(","),
        h: queue.hash.map((n) => n.toString(36).padStart(6, "0")).join(""),
        s: statusRuns,
        c: cursors.join(","),
        a: attempts.join(","),
    };
    if (queue.requires !== null) out.rq = queue.requires;
    return JSON.stringify(out);
}

/**
 * Parse and validate a serialised queue.
 * @param {string} text
 * @returns {{ ok: true, queue: JobQueue } | { ok: false, reason: string }}
 */
export function parseQueue(text) {
    let o;
    try {
        o = JSON.parse(text);
    } catch (error) {
        return { ok: false, reason: `not JSON (${String(error)})` };
    }
    if (o === null || typeof o !== "object" || o.f !== JOB_FORMAT) return { ok: false, reason: "not a job queue" };
    if (o.v !== JOB_VERSION) return { ok: false, reason: `job queue v${String(o.v)} unsupported` };
    if (!Array.isArray(o.sg) || typeof o.t !== "string" || typeof o.h !== "string" || typeof o.s !== "string") return { ok: false, reason: "malformed fields" };
    if (!["running", "paused", "aborted", "complete"].includes(o.st)) return { ok: false, reason: "bad state" };
    const totals = o.t === "" ? [] : o.t.split(",").map((/** @type {string} */ x) => parseInt(x, 36));
    const n = totals.length;
    if (totals.some((/** @type {number} */ x) => !Number.isInteger(x) || x < 0)) return { ok: false, reason: "bad totals" };
    if (o.h.length !== n * 6) return { ok: false, reason: "hash length mismatch" };
    /** @type {StageInfo[]} */
    const stages = [];
    let start = 0;
    for (const entry of o.sg) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Number.isInteger(entry[1]) || entry[1] < 0) return { ok: false, reason: "bad stage list" };
        stages.push({ name: entry[0], start, count: entry[1] });
        start += entry[1];
    }
    if (start !== n) return { ok: false, reason: "stage counts do not match element count" };
    /** @type {ElementStatus[]} */
    const status = [];
    const re = /([prdfs])(\d+)/gy;
    let m;
    let consumed = 0;
    while ((m = re.exec(o.s)) !== null) {
        consumed = re.lastIndex;
        for (let k = 0; k < Number(m[2]); k += 1) status.push(CHAR_STATUS[m[1]]);
        if (status.length > n) return { ok: false, reason: "status runs overflow" };
    }
    if (consumed !== o.s.length || status.length !== n) return { ok: false, reason: "status runs do not cover all elements" };
    const cursor = totals.map((/** @type {number} */ t, /** @type {number} */ i) => (status[i] === "done" ? t : 0));
    const attempts = totals.map(() => 0);
    /** @param {string} field @param {number[]} target @param {boolean} cursorField */
    const sparse = (field, target, cursorField) => {
        if (typeof field !== "string") return false;
        if (field === "") return true;
        for (const pair of field.split(",")) {
            const [a, b] = pair.split(":");
            const idx = parseInt(a, 36);
            const val = parseInt(b, 36);
            if (!Number.isInteger(idx) || !Number.isInteger(val) || idx < 0 || idx >= n || val < 0) return false;
            if (cursorField && val > totals[idx]) return false;
            target[idx] = val;
        }
        return true;
    };
    if (!sparse(o.c, cursor, true) || !sparse(o.a, attempts, false)) return { ok: false, reason: "bad sparse fields" };
    const hash = [];
    for (let i = 0; i < n; i += 1) hash.push(parseInt(o.h.slice(i * 6, i * 6 + 6), 36));
    return {
        ok: true,
        queue: {
            planHash: typeof o.ph === "string" ? o.ph : "",
            state: o.st,
            maxAttempts: Number.isInteger(o.ma) ? o.ma : MAX_ATTEMPTS_DEFAULT,
            stages,
            requires: o.rq !== undefined && o.rq !== null && typeof o.rq === "object" ? o.rq : null,
            total: totals,
            cursor,
            status,
            attempts,
            hash,
        },
    };
}

/**
 * Persistent job store (keys civ:jobs:*), same atomic protocol as the plan store.
 * @param {import("./planstore.js").WorldLike} world
 * @param {{ maxBytes?: number, chunkChars?: number, prefix?: string }} [options]
 */
export function createJobStore(world, options = {}) {
    const base = createChunkedStore(world, {
        prefix: options.prefix ?? JOB_PREFIX,
        format: JOB_FORMAT,
        version: JOB_VERSION,
        maxBytes: options.maxBytes ?? CIV_LIMITS.maxJobBytes,
        chunkChars: options.chunkChars,
    });

    /** @param {JobQueue} queue */
    function saveQueue(queue) {
        return base.saveText(serializeQueue(queue));
    }

    /**
     * Load, verify and (when `recoverRunning` is not false) apply restart recovery.
     * @param {{ recoverRunning?: boolean, quarantine?: boolean }} [loadOptions]
     * @returns {{ status: string, queue?: JobQueue, recovered?: number, reason: string|undefined }}
     */
    function loadQueue(loadOptions = {}) {
        const loaded = base.loadText();
        if (loaded.status !== "ok" || loaded.text === undefined) {
            if (loaded.status === "corrupt" && loadOptions.quarantine === true) base.quarantine(loaded.reason ?? "corrupt");
            return { status: loaded.status, reason: loaded.reason };
        }
        const parsed = parseQueue(loaded.text);
        if (!parsed.ok) {
            if (loadOptions.quarantine === true) base.quarantine(parsed.reason);
            return { status: "corrupt", reason: parsed.reason };
        }
        const recovered = loadOptions.recoverRunning === false ? 0 : recover(parsed.queue);
        return { status: "ok", queue: parsed.queue, recovered, reason: undefined };
    }

    return { ...base, saveQueue, loadQueue };
}
