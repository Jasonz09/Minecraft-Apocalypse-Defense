import { system } from "@minecraft/server";
import { CIV } from "../config.js";

/**
 * Observable progress of the one-command workflow. One registry object per session (plan | build | resume), so
 * `civ:generate_status`, the chat heartbeats, the stall detector and the diagnostic command all read the same facts.
 * Pure bookkeeping: nothing here touches the world; the only engine call is the optional monitor interval.
 *
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 * @typedef {"running" | "stalled" | "failed" | "cancelled" | "done"} ProgressState
 * @typedef {{
 *   id: number, kind: "plan" | "build" | "resume", token: { kind: string, cancelled: boolean } | undefined,
 *   phaseIndex: number, phaseName: string, phases: number,
 *   tilesDone: number, tilesTotal: number, tilesPlanned: number, tile: Rect | undefined, chunksPending: number, chunksScanned: number, chunksTotal: number,
 *   columnsScanned: number, startedTick: number, lastHeartbeatTick: number, lastProgressTick: number, endedTick: number | undefined,
 *   stalls: number, skippedTiles: number, notes: string[], lastError: string | undefined, state: ProgressState,
 *   percent: number | undefined, say: (lines: string[]) => void, monitor: number | undefined,
 * }} Progress
 */

let nextId = 1;
/** @type {Progress | undefined} */
let current;
/** @type {Progress | undefined} */
let lastRun;

/** Current game tick (0 when the engine does not expose a clock). */
export function nowTick() {
    try {
        const tick = system.currentTick;
        return typeof tick === "number" && Number.isFinite(tick) ? tick : 0;
    } catch (_error) {
        return 0;
    }
}

/**
 * @param {"plan" | "build" | "resume"} kind
 * @param {{ kind: string, cancelled: boolean } | undefined} token
 * @param {(lines: string[]) => void} say
 * @returns {Progress}
 */
export function startProgress(kind, token, say) {
    const now = nowTick();
    /** @type {Progress} */
    const p = {
        id: nextId++, kind, token, phaseIndex: 0, phaseName: "starting", phases: 6,
        tilesDone: 0, tilesTotal: 0, tilesPlanned: 0, tile: undefined, chunksPending: 0, chunksScanned: 0, chunksTotal: 0, columnsScanned: 0,
        startedTick: now, lastHeartbeatTick: now, lastProgressTick: now, endedTick: undefined,
        stalls: 0, skippedTiles: 0, notes: [], lastError: undefined, state: "running", percent: undefined, say, monitor: undefined,
    };
    current = p;
    return p;
}

export function getProgress() {
    return current;
}

export function getLastRun() {
    return lastRun;
}

/** @param {Progress | undefined} p @param {number} index @param {string} name */
export function setPhase(p, index, name) {
    if (p === undefined) return;
    p.phaseIndex = index;
    p.phaseName = name;
    touch(p);
}

/** Record that something moved (a slice ran, a tile finished, a plan step yielded). @param {Progress | undefined} p */
export function touch(p) {
    if (p !== undefined) {
        p.lastProgressTick = nowTick();
        if (p.state === "stalled") p.state = "running";
    }
}

/** @param {Progress | undefined} p @param {string} text */
export function note(p, text) {
    if (p !== undefined && !p.notes.includes(text) && p.notes.length < 8) p.notes.push(text);
}

/**
 * Close a session: stop its monitor, remember it as the last run, forget it as the current one.
 * @param {Progress | undefined} p @param {ProgressState} state @param {string} [error]
 */
export function finishProgress(p, state, error) {
    if (p === undefined) return;
    if (p.monitor !== undefined) {
        try {
            system.clearRun(p.monitor);
        } catch (_error) {
            // already cleared
        }
        p.monitor = undefined;
    }
    if (p.endedTick === undefined) {
        p.endedTick = nowTick();
        p.state = state;
        if (error !== undefined) p.lastError = error;
    }
    if (current === p) current = undefined;
    lastRun = p;
}

export function resetProgressForTests() {
    if (current?.monitor !== undefined) {
        try {
            system.clearRun(current.monitor);
        } catch (_error) {
            // ignore
        }
    }
    current = undefined;
    lastRun = undefined;
}

/** @param {Progress | undefined} p */
export function stopMonitor(p) {
    if (p?.monitor !== undefined) {
        try {
            system.clearRun(p.monitor);
        } catch (_error) {
            // already cleared
        }
        p.monitor = undefined;
    }
}

/** @param {number} ticks */
export function formatTicks(ticks) {
    const seconds = Math.floor(Math.max(0, ticks) / 20);
    return seconds >= 120 ? `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s` : `${String(seconds)} s`;
}

/**
 * Percent where it can be measured: the build (set by the builder) and the survey (tiles done of the tiles planned for the
 * CURRENT ring plan - it can grow when the survey widens). Planning steps have no honest total, so no percent.
 * @param {Progress} p
 * @returns {number | undefined}
 */
export function progressPercent(p) {
    if (p.percent !== undefined) return p.percent;
    if (p.kind !== "build" && p.phaseIndex === 1 && p.tilesPlanned > 0) {
        return Math.min(100, Math.floor((p.tilesDone * 100) / p.tilesPlanned));
    }
    return undefined;
}

/** One-line description of a running session (used in refusals). @param {Progress | undefined} [p] */
export function describeRunning(p = current) {
    if (p === undefined) return "no session";
    const age = formatTicks(nowTick() - p.startedTick);
    const tiles = p.tilesTotal > 0 ? `, tile ${String(p.tilesDone)}/${String(p.tilesTotal)}` : "";
    return `${p.kind}: phase ${String(p.phaseIndex)}/${String(p.phases)} ${p.phaseName}${tiles}, running for ${age}`;
}

/** Multi-line status of a session. @param {Progress} p */
export function describeProgress(p) {
    const now = nowTick();
    const end = p.endedTick ?? now;
    const quiet = now - p.lastProgressTick;
    /** @type {string[]} */
    const lines = [];
    lines.push(`Session ${String(p.id)} (${p.kind}): ${p.state}, phase ${String(p.phaseIndex)}/${String(p.phases)} ${p.phaseName}, elapsed ${formatTicks(end - p.startedTick)}${progressPercent(p) !== undefined ? `, ${String(progressPercent(p))}%${p.kind !== "build" && p.phaseIndex === 1 ? " of the current ring plan (grows if the survey widens)" : ""}` : ""}.`);
    if (p.tilesTotal > 0) {
        lines.push(`  survey: tile ${String(p.tilesDone)}/${String(p.tilesTotal)}${p.tile ? ` (now ${String(p.tile.x0)},${String(p.tile.z0)} to ${String(p.tile.x1)},${String(p.tile.z1)})` : ""}; ${String(p.chunksScanned)} of ${String(p.chunksTotal)} chunks scanned (${String(p.chunksScanned * 256)} blocks), ${String(p.columnsScanned)} columns read, ${String(p.chunksPending)} chunk(s) still loading.`);
    }
    if (p.endedTick === undefined) {
        lines.push(`  last progress ${formatTicks(quiet)} ago${quiet >= CIV.heartbeatTicks * 3 ? " - STALLED? (a chunk may not be loading; see /scriptevent civ:generate_diag, or stop it with /scriptevent civ:generate_abort)" : ""}.`);
    }
    if (p.stalls > 0 || p.skippedTiles > 0) {
        lines.push(`  tile stalls ${String(p.stalls)}, tiles skipped ${String(p.skippedTiles)} (their columns stay unread - nothing is guessed).`);
    }
    for (const text of p.notes) lines.push(`  note: ${text}`);
    if (p.lastError !== undefined) lines.push(`  error: ${p.lastError}`);
    return lines;
}

/** Chat heartbeat. @param {Progress} p @param {boolean} [force] */
export function heartbeat(p, force = false) {
    const now = nowTick();
    if (!force && now - p.lastHeartbeatTick < CIV.heartbeatTicks) return;
    p.lastHeartbeatTick = now;
    const tiles = p.tilesTotal > 0 && p.kind !== "build" ? ` tile ${String(p.tilesDone)}/${String(p.tilesTotal)},` : "";
    const pct = progressPercent(p);
    p.say([`  ... ${p.phaseName} (phase ${String(p.phaseIndex)}/${String(p.phases)}):${tiles}${pct !== undefined ? ` ${String(pct)}%,` : ""} ${String(p.chunksPending)} chunk(s) loading, ${formatTicks(now - p.startedTick)} elapsed${now - p.lastProgressTick >= CIV.heartbeatTicks * 2 ? `, no progress for ${formatTicks(now - p.lastProgressTick)}` : ""}.`]);
}

/**
 * Start the once-a-second monitor: chat heartbeats, stall detection and (planning only) the overall deadline.
 * `onTrouble` is told "stalled" or "deadline". For planning it must cancel the run; for a build it only reports (the
 * build may recover, so it is never auto-cancelled). A stalled session returns to "running" the moment it moves again.
 *
 * @param {Progress} p
 * @param {(reason: "stalled" | "deadline", p: Progress) => void} onTrouble
 */
export function startMonitor(p, onTrouble) {
    let deadlineFired = false;
    p.monitor = system.runInterval(() => {
        if (p.endedTick !== undefined || p.token?.cancelled === true) return;
        const now = nowTick();
        heartbeat(p);
        if (p.kind !== "build" && !deadlineFired && now - p.startedTick >= CIV.planDeadlineTicks) {
            deadlineFired = true;
            onTrouble("deadline", p);
        } else if (p.state !== "stalled" && now - p.lastProgressTick >= CIV.stallTicks) {
            p.state = "stalled";
            onTrouble("stalled", p);
        }
    }, 20);
}
