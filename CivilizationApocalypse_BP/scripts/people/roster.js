import { CIV_LIMITS } from "../civ/budget.js";
import { createChunkedStore, splitChunks, utf8Length } from "../civ/planstore.js";
import { CIVILIAN_ROLES, CIVILIAN_STATES, makeRecordId, SOLDIER_ROLES, SOLDIER_STATES, sortRecords, validateRoster } from "./contract.js";

/**
 * Roster persistence: the whole person roster in its own chunked dynamic properties.
 *
 * Keys (prefix "civ:people", the chunked-store layout from civ/planstore.js):
 *   civ:people_meta         envelope; the only pointer to live data (one write flips it)
 *   civ:people_a_0..n       chunks of generation family a
 *   civ:people_b_0..n       chunks of generation family b
 *   civ:people_quarantine   bounded copy of data found corrupt
 * The kingdom blob (civ:kingdom) is not touched. Keys checked against config.js and civ/planstore.js:
 * no existing prefix matches "civ:people". config.js STARTER.wipeKeyPrefixes should add "civ:people"
 * so arming a shipped world starts from a fresh roster (see the report).
 *
 * Encoding (version 1), one JSON document, RLE per district and kind:
 *   { "f": "civ-people", "v": 1, "slots": [slot names],
 *     "d": [ { "id": "district-1",
 *              "c": [[len, roleIdx, stateIdx, homeIdx, workIdx, revision], ...],   civilians, sequence 1..N
 *              "s": [[len, roleIdx, stateIdx, homeIdx, workIdx, revision], ...],   soldiers, sequence 1..N
 *              "g": [[civilianN, soldierN], ...] } ] }                              graduates only
 * Consecutive people with the same role, state, slots and revision form one run; sequence numbers are
 * implicit because nothing is ever deleted or reused. `workIdx` is -1 for no workplace. Index tables are the
 * CIVILIAN_ROLES / SOLDIER_ROLES / *_STATES arrays in contract.js: changing them requires a new version.
 */

export const ROSTER_PREFIX = "civ:people";
export const ROSTER_FORMAT = "civ-people";
export const ROSTER_VERSION = 1;
/** Budget for the whole roster (all chunks). 550 records encode to a few KB; this is a ceiling, not a target. */
export const ROSTER_MAX_BYTES = 60000;

/**
 * @typedef {import("./contract.js").PersonRecord} PersonRecord
 * @typedef {{ status: "ok" | "absent" | "corrupt" | "newer" | "unsupported", records: PersonRecord[], reason?: string, bytes?: number }} RosterLoad
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function isIndex(value, max) {
    return Number.isInteger(value) && /** @type {number} */ (value) >= 0 && /** @type {number} */ (value) < max;
}

/**
 * Encode a roster. Refuses (throws) when the roster does not validate, so nothing invalid is ever stored.
 * @param {PersonRecord[]} records
 * @returns {string}
 */
export function encodeRoster(records) {
    const check = validateRoster(records);
    if (!check.ok) throw new Error(`roster does not validate: ${check.problems.slice(0, 3).join("; ")}`);
    const sorted = sortRecords(records);
    /** @type {string[]} */
    const slots = [];
    /** @type {Map<string, number>} */
    const slotIndex = new Map();
    /** @param {string | null} name */
    const slotOf = (name) => {
        if (name === null) return -1;
        let index = slotIndex.get(name);
        if (index === undefined) {
            index = slots.length;
            slots.push(name);
            slotIndex.set(name, index);
        }
        return index;
    };
    /** @type {string[]} */
    const districts = [];
    for (const record of sorted) {
        if (!districts.includes(record.district)) districts.push(record.district);
    }

    /**
     * @param {PersonRecord[]} group
     * @param {"civilian" | "soldier"} kind
     */
    const runsOf = (group, kind) => {
        const roles = kind === "soldier" ? SOLDIER_ROLES : CIVILIAN_ROLES;
        const states = kind === "soldier" ? SOLDIER_STATES : CIVILIAN_STATES;
        /** @type {number[][]} */
        const runs = [];
        /** @type {number[] | null} */
        let current = null;
        /** @type {string} */
        let currentKey = "";
        for (const record of group.filter((item) => item.kind === kind)) {
            const row = [roles.indexOf(record.role), states.indexOf(record.state), slotOf(record.home), slotOf(record.workplace), record.revision];
            const key = row.join(",");
            if (current !== null && key === currentKey) {
                current[0] += 1;
            } else {
                current = [1, ...row];
                currentKey = key;
                runs.push(current);
            }
        }
        return runs;
    };

    const doc = {
        f: ROSTER_FORMAT,
        v: ROSTER_VERSION,
        slots: /** @type {string[]} */ ([]),
        d: /** @type {{ id: string, c: number[][], s: number[][], g?: number[][] }[]} */ ([]),
    };
    for (const district of districts) {
        const group = sorted.filter((record) => record.district === district);
        /** @type {{ id: string, c: number[][], s: number[][], g?: number[][] }} */
        const entry = { id: district, c: runsOf(group, "civilian"), s: runsOf(group, "soldier") };
        const graduates = group
            .filter((record) => record.state === "graduated")
            .map((record) => [parseSequence(record.id), parseSequence(record.successor)]);
        if (graduates.length > 0) entry.g = graduates;
        doc.d.push(entry);
    }
    doc.slots = slots;
    return JSON.stringify(doc);
}

/**
 * @param {unknown} id
 * @returns {number}
 */
function parseSequence(id) {
    const digits = /-(\d+)$/.exec(String(id));
    return digits === null ? 0 : Number(digits[1]);
}

/**
 * Decode and fully validate a roster document. Never returns a partial roster.
 * @param {string} text
 * @returns {{ ok: true, records: PersonRecord[] } | { ok: false, problems: string[] }}
 */
export function decodeRoster(text) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (error) {
        return { ok: false, problems: [`not JSON (${String(error)})`] };
    }
    if (!isObject(doc) || doc.f !== ROSTER_FORMAT) return { ok: false, problems: ["not a people roster document"] };
    if (doc.v !== ROSTER_VERSION) return { ok: false, problems: [`roster version ${String(doc.v)} is not ${String(ROSTER_VERSION)}`] };
    if (!Array.isArray(doc.slots) || !doc.slots.every((slot) => typeof slot === "string")) return { ok: false, problems: ["slot table is malformed"] };
    if (!Array.isArray(doc.d)) return { ok: false, problems: ["district list is malformed"] };
    const slots = /** @type {string[]} */ (doc.slots);
    /** @type {PersonRecord[]} */
    const records = [];
    /** @type {string[]} */
    const problems = [];

    for (const entry of doc.d) {
        if (!isObject(entry) || typeof entry.id !== "string" || !Array.isArray(entry.c) || !Array.isArray(entry.s)) {
            return { ok: false, problems: ["district entry is malformed"] };
        }
        const district = entry.id;
        for (const kind of /** @type {("civilian" | "soldier")[]} */ (["civilian", "soldier"])) {
            const runs = kind === "civilian" ? entry.c : entry.s;
            const roles = kind === "soldier" ? SOLDIER_ROLES : CIVILIAN_ROLES;
            const states = kind === "soldier" ? SOLDIER_STATES : CIVILIAN_STATES;
            let n = 0;
            for (const run of /** @type {unknown[]} */ (runs)) {
                if (!Array.isArray(run) || run.length !== 6 || !run.every((value) => Number.isInteger(value))) {
                    return { ok: false, problems: [`${district} ${kind} run is malformed`] };
                }
                const [len, roleIdx, stateIdx, homeIdx, workIdx, revision] = /** @type {number[]} */ (run);
                if (len < 1 || !isIndex(roleIdx, roles.length) || !isIndex(stateIdx, states.length)
                    || !isIndex(homeIdx, slots.length) || !(workIdx === -1 || isIndex(workIdx, slots.length)) || revision < 0) {
                    return { ok: false, problems: [`${district} ${kind} run has an out-of-range value`] };
                }
                for (let i = 0; i < len; i += 1) {
                    n += 1;
                    records.push({
                        id: makeRecordId(district, kind, n),
                        kind,
                        district,
                        role: roles[roleIdx],
                        home: slots[homeIdx],
                        workplace: workIdx === -1 ? null : slots[workIdx],
                        state: states[stateIdx],
                        revision,
                        successor: null,
                    });
                }
            }
        }
        if (entry.g !== undefined) {
            if (!Array.isArray(entry.g)) return { ok: false, problems: [`${district} graduates are malformed`] };
            for (const pair of entry.g) {
                if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((value) => Number.isInteger(value))) {
                    return { ok: false, problems: [`${district} graduate pair is malformed`] };
                }
                const [civilianN, soldierN] = /** @type {number[]} */ (pair);
                const target = records.find((record) => record.district === district && record.kind === "civilian" && parseSequence(record.id) === civilianN);
                if (target === undefined) {
                    problems.push(`${district} graduate ${String(civilianN)} has no civilian record`);
                    continue;
                }
                target.successor = makeRecordId(district, "soldier", soldierN);
            }
        }
    }
    if (problems.length > 0) return { ok: false, problems };
    const check = validateRoster(records);
    if (!check.ok) return { ok: false, problems: check.problems.slice(0, 5) };
    return { ok: true, records: sortRecords(records) };
}

/**
 * Size report for a roster: what it costs in dynamic properties.
 * @param {PersonRecord[]} records
 */
export function rosterSizeReport(records) {
    const text = encodeRoster(records);
    const bytes = utf8Length(text);
    const chunks = splitChunks(text, CIV_LIMITS.maxPropertyChars);
    const doc = /** @type {{ d: { c: unknown[], s: unknown[] }[] }} */ (JSON.parse(text));
    const runs = doc.d.reduce((sum, entry) => sum + entry.c.length + entry.s.length, 0);
    const civilians = records.filter((record) => record.kind === "civilian").length;
    const soldiers = records.filter((record) => record.kind === "soldier").length;
    return {
        records: records.length,
        civilians,
        soldiers,
        districts: doc.d.length,
        runs,
        bytes,
        bytesPerRecord: Math.round((bytes / Math.max(1, records.length)) * 10) / 10,
        chunks: chunks.length,
        chunkChars: CIV_LIMITS.maxPropertyChars,
        maxBytes: ROSTER_MAX_BYTES,
        fits: bytes <= ROSTER_MAX_BYTES && chunks.every((chunk) => chunk.length <= CIV_LIMITS.maxPropertyChars),
    };
}

/**
 * Chunked, verified, restart-safe roster storage on the world's dynamic properties.
 * @param {{ getDynamicProperty(key: string): any, setDynamicProperty(key: string, value?: any): void, getDynamicPropertyIds?: () => string[] }} world
 */
export function createRosterStore(world) {
    const base = createChunkedStore(world, {
        prefix: ROSTER_PREFIX,
        format: ROSTER_FORMAT,
        version: ROSTER_VERSION,
        maxBytes: ROSTER_MAX_BYTES,
        chunkChars: CIV_LIMITS.maxPropertyChars,
    });

    /**
     * Save the roster. Refuses an invalid roster before any write; a failed write leaves the previous roster live.
     * @param {PersonRecord[]} records
     * @returns {{ ok: boolean, status?: string, reason?: string, bytes?: number }}
     */
    function save(records) {
        let text;
        try {
            text = encodeRoster(records);
        } catch (error) {
            return { ok: false, status: "invalid", reason: String(/** @type {Error} */ (error).message) };
        }
        return base.saveText(text, { version: ROSTER_VERSION });
    }

    /**
     * Load and verify. Corrupt data is reported, never returned partially; `quarantine` copies it aside.
     * @param {{ quarantine?: boolean }} [options]
     * @returns {RosterLoad}
     */
    function load(options = {}) {
        const loaded = base.loadText();
        if (loaded.status === "absent") return { status: "absent", records: [], reason: loaded.reason };
        if (loaded.status !== "ok" || loaded.text === undefined) {
            if (loaded.status === "corrupt" && options.quarantine === true) base.quarantine(loaded.reason ?? "corrupt");
            return { status: /** @type {RosterLoad["status"]} */ (loaded.status), records: [], reason: loaded.reason };
        }
        const decoded = decodeRoster(loaded.text);
        if (!decoded.ok) {
            if (options.quarantine === true) base.quarantine(decoded.problems[0] ?? "roster failed validation");
            return { status: "corrupt", records: [], reason: decoded.problems.slice(0, 3).join("; ") };
        }
        return { status: "ok", records: decoded.records, bytes: utf8Length(loaded.text) };
    }

    /** Remove the roster (development reset only). */
    function clear() {
        base.clear();
    }

    return { store: base, save, load, clear, prefix: ROSTER_PREFIX, metaKey: base.metaKey, quarantineKey: base.quarantineKey, chunkKey: base.chunkKey, maxChunks: base.maxChunks };
}

