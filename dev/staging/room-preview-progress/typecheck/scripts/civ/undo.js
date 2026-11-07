// Undo journal for terrain writes (clear / cut / fill / resurface / foundation ops). Pure JS: no
// @minecraft/server imports. The world is only ever read through a callback supplied by the caller.
//
// Model. The builder records, for every terrain cell it actually writes, the id it found there
// (`prior`) and the id it wrote (`written`), plus the op `kind`. Undo restores `prior` ONLY where the
// live cell still holds `written`. Anything else (a player placed or removed a block, the chunk is not
// loaded, the cell belongs to a wall or gate) is reported and never touched.
//
// Persistence reuses civ/planstore.js (createChunkedStore): the payload is one text, chunked and
// checksummed by the same protocol as the plan. The text is a one-line JSON header followed by a
// column-wise run-length body in a 64-symbol varint alphabet (see encodeJournal).
//
// Design rationale and measurements: docs/UNDO_DESIGN.md.

import { CIV_LIMITS } from "./budget.js";
import { createChunkedStore, utf8Length } from "./planstore.js";

export const UNDO_FORMAT = "civ-undo";
export const UNDO_VERSION = 1;
export const UNDO_SCHEMA = 1;
export const UNDO_PREFIX = "civ:undo";
/** Largest persisted journal per district (UTF-8 bytes, all chunks together). Design target is ~20 KB. */
export const UNDO_MAX_BYTES = 60000;
export const AIR = "minecraft:air";

/** Every outcome of the safety predicate, in report order. */
export const DECISIONS = Object.freeze(["restore", "already-restored", "skipped-changed", "skipped-unloaded", "skipped-protected", "skipped-outside"]);

/**
 * @typedef {"restore" | "already-restored" | "skipped-changed" | "skipped-unloaded" | "skipped-protected" | "skipped-outside"} Decision
 * @typedef {{ x: number, y: number, z: number, kind: string, prior: string, written: string }} JournalEntry
 * @typedef {{ dimension: string, entries: Map<string, JournalEntry> }} Journal
 * @typedef {{ x: number, y: number, z: number, id: string, kind: string }} RestoreOp
 * @typedef {{ restored: number, alreadyRestored: number, skippedChanged: number, skippedUnloaded: number, skippedProtected: number, skippedOutside: number, total: number }} UndoCounts
 * @typedef {{ x: number, y: number, z: number, kind: string, prior: string, written: string, found: string | undefined, decision: Decision }} UndoSample
 * @typedef {{ ops: RestoreOp[], reads: number, cursor: number, total: number, counts: UndoCounts }} UndoSlice
 * @typedef {{ complete: true, slices: number, counts: UndoCounts, samples: UndoSample[], total: number }} UndoSummary
 * @typedef {{ minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number }} Bounds
 */

// 64 symbols: values 0..31 end a number, values 32..63 carry 5 bits and continue it. All JSON-safe.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
/** @type {Int8Array} */
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) DIGIT[ALPHABET.charCodeAt(i)] = i;

const ID_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const KIND_PATTERN = /^[a-z_]{1,16}$/;
const MAX_ID_LENGTH = 80;
const MAX_RUN_LENGTH = 400;

/** @param {unknown} value */
const isId = (value) => typeof value === "string" && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);

/** @param {number} x @param {number} y @param {number} z */
export const cellKey = (x, y, z) => `${String(x)},${String(y)},${String(z)}`;

/** @param {string} dimension */
export function createJournal(dimension) {
    if (typeof dimension !== "string" || dimension.length === 0 || dimension.length > 64) {
        throw new RangeError("journal dimension must be a non-empty string of at most 64 characters");
    }
    /** @type {Journal} */
    const journal = { dimension, entries: new Map() };
    return journal;
}

/**
 * Record one terrain write. Call it with the id read from the live cell IMMEDIATELY before the write, and
 * journal BEFORE writing (write-ahead): a journaled cell that was never written is harmless (its live id
 * equals `prior`, so undo treats it as already restored), while a written cell that is not journaled would
 * be lost.
 *
 * A cell written twice keeps its first `prior` and takes the latest `written`. If the cell returns to its
 * original id the entry is removed (nothing to undo there).
 *
 * @param {Journal} journal
 * @param {{ x: number, y: number, z: number, kind: string, prior: string | undefined, written: string }} write
 * @returns {{ recorded: boolean, reason?: string }}
 */
export function recordWrite(journal, write) {
    const { x, y, z, kind, prior, written } = write;
    if (![x, y, z].every((v) => Number.isInteger(v))) return { recorded: false, reason: "coordinates must be integers" };
    if (!KIND_PATTERN.test(kind)) return { recorded: false, reason: `kind "${kind}" is not a short lower-case word` };
    if (prior === undefined) return { recorded: false, reason: "prior id unknown (an unloaded cell must not be written)" };
    if (!isId(prior) || !isId(written)) return { recorded: false, reason: "block ids must be namespaced lower-case ids" };
    const key = cellKey(x, y, z);
    const existing = journal.entries.get(key);
    if (existing === undefined) {
        if (prior === written) return { recorded: false, reason: "no-op write" };
        journal.entries.set(key, { x, y, z, kind, prior, written });
        return { recorded: true };
    }
    if (existing.prior === written) {
        journal.entries.delete(key);
        return { recorded: true, reason: "cell returned to its original id" };
    }
    journal.entries.set(key, { ...existing, written });
    return { recorded: true };
}

/** @param {JournalEntry} e @returns {string | undefined} */
function entryProblem(e) {
    if (![e.x, e.y, e.z].every((v) => Number.isInteger(v))) return "coordinates must be integers";
    if (!KIND_PATTERN.test(e.kind)) return `kind "${e.kind}" is not a short lower-case word`;
    if (!isId(e.prior) || !isId(e.written)) return "block ids must be namespaced lower-case ids";
    if (e.prior === e.written) return "prior equals written (a no-op is never journaled)";
    return undefined;
}

/** @param {Journal} journal @returns {JournalEntry[]} */
function sortedEntries(journal) {
    return [...journal.entries.values()].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
}

/** @param {number} n */
const zigzag = (n) => (n >= 0 ? 2 * n : -2 * n - 1);
/** @param {number} u */
const unzigzag = (u) => (u % 2 === 0 ? u / 2 : -(u + 1) / 2);

/** @param {string[]} out @param {number} value non-negative integer */
function pushVarint(out, value) {
    let v = value;
    while (v >= 32) {
        out.push(ALPHABET.charAt(32 + (v % 32)));
        v = Math.floor(v / 32);
    }
    out.push(ALPHABET.charAt(v));
}

/** @param {string} text @param {{ pos: number }} state */
function readVarint(text, state) {
    let value = 0;
    let scale = 1;
    for (;;) {
        if (state.pos >= text.length) throw new Error("body ends in the middle of a number");
        const code = text.charCodeAt(state.pos);
        state.pos += 1;
        const digit = code < 128 ? DIGIT[code] : -1;
        if (digit < 0) throw new Error(`character code ${String(code)} is not in the journal alphabet`);
        if (digit >= 32) {
            value += (digit - 32) * scale;
            scale *= 32;
            if (scale > 2 ** 40) throw new Error("number too large");
        } else {
            return value + digit * scale;
        }
    }
}

/**
 * Serialise a journal. Deterministic: the same set of entries gives the same text whatever the insertion order.
 *
 * Layout: `<header JSON>\n<body>`. Header: `f` format, `s` schema, `d` dimension, `n` cell count,
 * `b` = [x0, z0, x1, z1, yRef] (bounding box of the columns and the reference height), `i` id dictionary
 * (sorted), `p` pair table `[kind, writtenIndex, priorIndex]` (sorted). Body, column by column in row-major
 * order over the bounding box, only columns that hold entries:
 *   skip      empty columns since the previous listed column (varint)
 *   runCount  number of runs in this column (varint)
 *   per run:  first run: zigzag(yStart - yRef); later runs: yStart - previousEnd - 1   (varint)
 *             length - 1 (varint)   pair index (varint)
 * A run is a vertical stretch of consecutive cells sharing one (kind, written, prior) pair.
 *
 * @param {Journal} journal
 * @returns {{ text: string, cells: number, runs: number, ids: number, pairs: number, bytes: number }}
 */
export function encodeJournal(journal) {
    const entries = sortedEntries(journal);
    for (const e of entries) {
        const problem = entryProblem(e);
        if (problem !== undefined) throw new RangeError(`cannot encode cell ${cellKey(e.x, e.y, e.z)}: ${problem}`);
    }
    const ids = [...new Set(entries.flatMap((e) => [e.prior, e.written]))].sort();
    const idIndex = new Map(ids.map((id, i) => [id, i]));
    const idOf = (/** @type {string} */ id) => /** @type {number} */ (idIndex.get(id));

    /** @type {Map<string, [string, number, number]>} */
    const tuples = new Map();
    for (const e of entries) {
        /** @type {[string, number, number]} */
        const tuple = [e.kind, idOf(e.written), idOf(e.prior)];
        tuples.set(tuple.join("|"), tuple);
    }
    const pairs = [...tuples.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || a[2] - b[2]));
    const pairIndex = new Map(pairs.map((t, i) => [t.join("|"), i]));
    const pairOf = (/** @type {JournalEntry} */ e) => /** @type {number} */ (pairIndex.get([e.kind, idOf(e.written), idOf(e.prior)].join("|")));

    /** @type {[number, number, number, number, number]} */
    const box = entries.length === 0 ? [0, 0, -1, -1, 0] : [
        Math.min(...entries.map((e) => e.x)),
        Math.min(...entries.map((e) => e.z)),
        Math.max(...entries.map((e) => e.x)),
        Math.max(...entries.map((e) => e.z)),
        Math.min(...entries.map((e) => e.y)),
    ];
    const [bx0, bz0, bx1, , yRef] = box;
    const width = bx1 - bx0 + 1;

    /** @type {string[]} */
    const body = [];
    let runs = 0;
    let previousColumn = -1;
    let k = 0;
    while (k < entries.length) {
        const head = entries[k];
        let end = k + 1;
        while (end < entries.length && entries[end].x === head.x && entries[end].z === head.z) end += 1;
        const column = (head.z - bz0) * width + (head.x - bx0);
        pushVarint(body, column - previousColumn - 1);
        previousColumn = column;

        /** @type {{ y: number, length: number, pair: number }[]} */
        const columnRuns = [];
        let j = k;
        while (j < end) {
            const pair = pairOf(entries[j]);
            let m = j + 1;
            while (m < end && entries[m].y === entries[m - 1].y + 1 && pairOf(entries[m]) === pair) m += 1;
            columnRuns.push({ y: entries[j].y, length: m - j, pair });
            j = m;
        }
        pushVarint(body, columnRuns.length);
        let previousEnd = 0;
        columnRuns.forEach((run, index) => {
            if (index === 0) pushVarint(body, zigzag(run.y - yRef));
            else pushVarint(body, run.y - previousEnd - 1);
            pushVarint(body, run.length - 1);
            pushVarint(body, run.pair);
            previousEnd = run.y + run.length - 1;
            runs += 1;
        });
        k = end;
    }

    const header = JSON.stringify({ f: UNDO_FORMAT, s: UNDO_SCHEMA, d: journal.dimension, n: entries.length, b: box, i: ids, p: pairs });
    const text = `${header}\n${body.join("")}`;
    return { text, cells: entries.length, runs, ids: ids.length, pairs: pairs.length, bytes: utf8Length(text) };
}

/**
 * Parse a journal text. Never trusts the input: every index, count and bound is checked.
 * @param {string} text
 * @returns {{ ok: true, journal: Journal } | { ok: false, reason: string }}
 */
export function decodeJournal(text) {
    try {
        return { ok: true, journal: decodeOrThrow(text) };
    } catch (error) {
        return { ok: false, reason: String(error) };
    }
}

/** @param {string} text @returns {Journal} */
function decodeOrThrow(text) {
    const newline = text.indexOf("\n");
    if (newline < 0) throw new Error("no header line");
    /** @type {any} */
    const header = JSON.parse(text.slice(0, newline));
    if (header === null || typeof header !== "object" || header.f !== UNDO_FORMAT || header.s !== UNDO_SCHEMA) {
        throw new Error("not a schema-1 undo journal");
    }
    if (typeof header.d !== "string" || header.d.length === 0 || header.d.length > 64) throw new Error("bad dimension");
    if (!Number.isInteger(header.n) || header.n < 0) throw new Error("bad cell count");
    const box = header.b;
    if (!Array.isArray(box) || box.length !== 5 || !box.every((/** @type {unknown} */ v) => Number.isInteger(v))) throw new Error("bad bounds");
    const ids = header.i;
    if (!Array.isArray(ids) || !ids.every((/** @type {unknown} */ v) => isId(v))) throw new Error("bad id dictionary");
    if (!Array.isArray(header.p)) throw new Error("bad pair table");
    /** @type {{ kind: string, written: string, prior: string }[]} */
    const pairs = header.p.map((/** @type {any} */ t) => {
        const ok =
            Array.isArray(t) &&
            t.length === 3 &&
            typeof t[0] === "string" &&
            KIND_PATTERN.test(t[0]) &&
            Number.isInteger(t[1]) &&
            Number.isInteger(t[2]) &&
            t[1] >= 0 &&
            t[1] < ids.length &&
            t[2] >= 0 &&
            t[2] < ids.length &&
            t[1] !== t[2];
        if (!ok) throw new Error("bad pair in the pair table");
        return { kind: String(t[0]), written: String(ids[t[1]]), prior: String(ids[t[2]]) };
    });

    const [x0, z0, x1, z1, yRef] = box;
    const width = x1 - x0 + 1;
    const height = z1 - z0 + 1;
    if (header.n > 0 && (width < 1 || height < 1)) throw new Error("empty bounds but cells are listed");
    const journal = createJournal(header.d);
    const body = text.slice(newline + 1);
    const state = { pos: 0 };
    let previousColumn = -1;
    while (state.pos < body.length) {
        const column = previousColumn + 1 + readVarint(body, state);
        if (column >= width * height) throw new Error("column outside the bounds");
        previousColumn = column;
        const x = x0 + (column % width);
        const z = z0 + Math.floor(column / width);
        const runCount = readVarint(body, state);
        if (runCount < 1) throw new Error("a listed column has no runs");
        let previousEnd = 0;
        for (let r = 0; r < runCount; r += 1) {
            const gap = readVarint(body, state);
            const y0 = r === 0 ? yRef + unzigzag(gap) : previousEnd + 1 + gap;
            const length = readVarint(body, state) + 1;
            if (length > MAX_RUN_LENGTH) throw new Error("run longer than the world height");
            const pair = pairs[readVarint(body, state)];
            if (pair === undefined) throw new Error("pair index outside the table");
            for (let t = 0; t < length; t += 1) {
                const y = y0 + t;
                const key = cellKey(x, y, z);
                if (journal.entries.has(key)) throw new Error(`cell ${key} listed twice`);
                journal.entries.set(key, { x, y, z, kind: pair.kind, prior: pair.prior, written: pair.written });
            }
            previousEnd = y0 + length - 1;
        }
    }
    if (journal.entries.size !== header.n) throw new Error(`header lists ${String(header.n)} cells, body holds ${String(journal.entries.size)}`);
    return journal;
}

/**
 * The store for one district's journal. Same protocol as the plan store (chunks, checksum, one meta flip).
 * Use one prefix per district: UNDO_PREFIX plus the district id, with the separator the store uses.
 * @param {Parameters<typeof createChunkedStore>[0]} world
 * @param {{ prefix?: string, maxBytes?: number, chunkChars?: number }} [options]
 */
export function createUndoStore(world, options = {}) {
    return createChunkedStore(world, {
        prefix: options.prefix ?? UNDO_PREFIX,
        format: UNDO_FORMAT,
        version: UNDO_VERSION,
        maxBytes: options.maxBytes ?? UNDO_MAX_BYTES,
        chunkChars: options.chunkChars ?? CIV_LIMITS.maxPropertyChars,
    });
}

/**
 * Save a journal. Returns the store result; on any status other than "ok" nothing has been flipped, so the
 * caller must not start the terrain writes that this journal is meant to cover.
 * @param {ReturnType<typeof createUndoStore>} store
 * @param {Journal} journal
 */
export function saveJournal(store, journal) {
    return store.saveText(encodeJournal(journal).text);
}

/**
 * Load a journal. Status "absent" means nothing was journaled for this store.
 * @param {ReturnType<typeof createUndoStore>} store
 * @returns {{ status: "ok", journal: Journal, reason?: undefined } | { status: "absent" | "corrupt" | "newer" | "unsupported", journal?: undefined, reason?: string }}
 */
export function loadJournal(store) {
    const loaded = store.loadText();
    if (loaded.status !== "ok" || loaded.text === undefined) {
        const status = loaded.status === "ok" ? "corrupt" : loaded.status;
        return { status, reason: loaded.reason ?? "payload missing" };
    }
    const decoded = decodeJournal(loaded.text);
    if (!decoded.ok) return { status: "corrupt", reason: decoded.reason };
    return { status: "ok", journal: decoded.journal, reason: undefined };
}

/** @param {Journal} journal */
export function summarizeJournal(journal) {
    /** @type {Record<string, number>} */
    const byKind = {};
    for (const e of journal.entries.values()) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return { cells: journal.entries.size, byKind };
}

/**
 * The safety predicate for ONE cell. Pure; every restore decision goes through here.
 *
 *   current undefined                              -> skipped-unloaded   (never guess)
 *   current === prior                              -> already-restored   (no write; also makes undo idempotent)
 *   planned is a wall/gate id that is not prior    -> skipped-protected  (never leave the plan's cell in another state)
 *   current === written                            -> restore to prior
 *   anything else (player placed or removed it)    -> skipped-changed    (reported, never touched)
 *
 * @param {JournalEntry} entry
 * @param {string | undefined} current live block id, undefined when the chunk is not loaded
 * @param {string | null | undefined} planned the district plan's own id at this cell; null = conflicting plan ids; undefined = not a plan wall/gate cell
 * @returns {{ decision: Decision, id?: string }}
 */
export function decideRestore(entry, current, planned) {
    if (current === undefined) return { decision: "skipped-unloaded" };
    if (current === entry.prior) return { decision: "already-restored" };
    if (planned !== undefined && (planned === null || planned !== entry.prior)) return { decision: "skipped-protected" };
    if (current === entry.written) return { decision: "restore", id: entry.prior };
    return { decision: "skipped-changed" };
}

/**
 * Protection map for the undo planner, from the wall and gate cells of every district.
 * A cell claimed with two different ids becomes null (no restore is ever allowed there).
 * @param {Iterable<{ x: number, y: number, z: number, id: string }>} cells
 * @returns {Map<string, string | null>}
 */
export function protectedFromPlan(cells) {
    /** @type {Map<string, string | null>} */
    const out = new Map();
    for (const c of cells) {
        const key = cellKey(c.x, c.y, c.z);
        const had = out.get(key);
        out.set(key, had === undefined || had === c.id ? c.id : null);
    }
    return out;
}

/** Canonical undo order: remove what we placed over air first (top-down), restore ground bottom-up, then plants. */
/** @param {Journal} journal @returns {JournalEntry[]} */
export function undoOrder(journal) {
    /** @param {JournalEntry} e */
    const rank = (e) => (e.prior === AIR ? 0 : e.kind === "clear" ? 2 : 1);
    return [...journal.entries.values()].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 0) return b.y - a.y || a.x - b.x || a.z - b.z;
        return a.y - b.y || a.x - b.x || a.z - b.z;
    });
}

/** @param {UndoCounts} counts @param {Decision} decision */
function tally(counts, decision) {
    if (decision === "restore") counts.restored += 1;
    else if (decision === "already-restored") counts.alreadyRestored += 1;
    else if (decision === "skipped-changed") counts.skippedChanged += 1;
    else if (decision === "skipped-unloaded") counts.skippedUnloaded += 1;
    else if (decision === "skipped-protected") counts.skippedProtected += 1;
    else counts.skippedOutside += 1;
}

/** @param {JournalEntry} e @param {Bounds} b */
const insideBounds = (e, b) => e.x >= b.minX && e.x <= b.maxX && e.y >= b.minY && e.y <= b.maxY && e.z >= b.minZ && e.z <= b.maxZ;

/** @param {number | undefined} value @param {number} cap */
const clampPerSlice = (value, cap) => Math.max(1, Math.min(cap, Number.isInteger(value) ? /** @type {number} */ (value) : cap));

/**
 * Cooperative undo planner. Yields one slice at a time; each slice holds at most `maxOpsPerSlice` restore
 * ops (default and hard cap CIV_LIMITS.maxBlocksPerSlice = 400) and at most `maxReadsPerSlice` reads
 * (default and cap CIV_LIMITS.maxReadsPerSlice). The caller applies `slice.ops` before resuming; the
 * cells are disjoint, so a later read never depends on an earlier write of the same run.
 * The generator's return value is the summary (counts over the whole journal).
 *
 * @param {Journal} journal
 * @param {(x: number, y: number, z: number) => string | undefined} read live block id, undefined when the chunk is not loaded
 * @param {{ protect?: ReadonlyMap<string, string | null>, bounds?: Bounds, maxOpsPerSlice?: number, maxReadsPerSlice?: number, sampleLimit?: number }} [options]
 * @returns {Generator<UndoSlice, UndoSummary, undefined>}
 */
export function* planUndo(journal, read, options = {}) {
    const maxOps = clampPerSlice(options.maxOpsPerSlice, CIV_LIMITS.maxBlocksPerSlice);
    const maxReads = clampPerSlice(options.maxReadsPerSlice, CIV_LIMITS.maxReadsPerSlice);
    const sampleLimit = options.sampleLimit ?? 20;
    const order = undoOrder(journal);
    /** @type {UndoCounts} */
    const counts = { restored: 0, alreadyRestored: 0, skippedChanged: 0, skippedUnloaded: 0, skippedProtected: 0, skippedOutside: 0, total: order.length };
    /** @type {UndoSample[]} */
    const samples = [];
    /** @type {RestoreOp[]} */
    let ops = [];
    let reads = 0;
    let slices = 0;
    for (let cursor = 0; cursor < order.length; cursor += 1) {
        const entry = order[cursor];
        if (options.bounds !== undefined && !insideBounds(entry, options.bounds)) {
            tally(counts, "skipped-outside");
        } else {
            const found = read(entry.x, entry.y, entry.z);
            reads += 1;
            const planned = options.protect?.get(cellKey(entry.x, entry.y, entry.z));
            const verdict = decideRestore(entry, found, planned);
            tally(counts, verdict.decision);
            if (verdict.decision === "restore") {
                ops.push({ x: entry.x, y: entry.y, z: entry.z, id: entry.prior, kind: entry.kind });
            } else if ((verdict.decision === "skipped-changed" || verdict.decision === "skipped-protected") && samples.length < sampleLimit) {
                samples.push({ x: entry.x, y: entry.y, z: entry.z, kind: entry.kind, prior: entry.prior, written: entry.written, found, decision: verdict.decision });
            }
        }
        if (ops.length >= maxOps || reads >= maxReads) {
            slices += 1;
            yield { ops, reads, cursor: cursor + 1, total: order.length, counts: { ...counts } };
            ops = [];
            reads = 0;
        }
    }
    if (ops.length > 0) {
        slices += 1;
        yield { ops, reads, cursor: order.length, total: order.length, counts: { ...counts } };
    }
    return { complete: true, slices, counts, samples, total: order.length };
}

/**
 * Tile a block-column region into snapshot tiles of at most `maxChunks` chunks each (a chunk is 16 x 16
 * columns). Tiles are chunk-aligned squares of edge floor(sqrt(maxChunks)), clipped to the region, in
 * row-major order. Used only by the snapshot alternative (docs/UNDO_DESIGN.md); not by the journal.
 * The y range is not tiled here.
 *
 * @param {{ x0: number, z0: number, x1: number, z1: number }} region inclusive block columns
 * @param {{ maxChunks?: number }} [options]
 * @returns {{ ok: boolean, problems: string[], edgeChunks: number, tiles: { x0: number, z0: number, x1: number, z1: number, chunks: number }[], chunks: number }}
 */
export function planSnapshotTiles(region, options = {}) {
    const maxChunks = options.maxChunks ?? 64;
    /** @type {string[]} */
    const problems = [];
    if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 1024) problems.push("maxChunks must be an integer from 1 to 1024");
    if (![region.x0, region.z0, region.x1, region.z1].every((v) => Number.isInteger(v))) problems.push("region bounds must be integers");
    if (region.x1 < region.x0 || region.z1 < region.z0) problems.push("region is empty (x1 < x0 or z1 < z0)");
    if (problems.length > 0) return { ok: false, problems, edgeChunks: 0, tiles: [], chunks: 0 };

    const edge = Math.floor(Math.sqrt(maxChunks));
    const cx0 = Math.floor(region.x0 / 16);
    const cz0 = Math.floor(region.z0 / 16);
    const cx1 = Math.floor(region.x1 / 16);
    const cz1 = Math.floor(region.z1 / 16);
    /** @type {{ x0: number, z0: number, x1: number, z1: number, chunks: number }[]} */
    const tiles = [];
    for (let cz = cz0; cz <= cz1; cz += edge) {
        for (let cx = cx0; cx <= cx1; cx += edge) {
            const tx1 = Math.min(cx + edge - 1, cx1);
            const tz1 = Math.min(cz + edge - 1, cz1);
            tiles.push({
                x0: Math.max(region.x0, cx * 16),
                z0: Math.max(region.z0, cz * 16),
                x1: Math.min(region.x1, tx1 * 16 + 15),
                z1: Math.min(region.z1, tz1 * 16 + 15),
                chunks: (tx1 - cx + 1) * (tz1 - cz + 1),
            });
        }
    }
    return { ok: true, problems, edgeChunks: edge, tiles, chunks: (cx1 - cx0 + 1) * (cz1 - cz0 + 1) };
}
