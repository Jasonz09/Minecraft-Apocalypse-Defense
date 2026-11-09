import { utf8Length } from "../civ/planstore.js";
import { parseGroupId } from "./groups.js";
import { POP_CURSOR_MAX_BYTES, POP_CURSOR_MAX_PHYSICAL, POP_CURSOR_VERSION } from "./settings.js";

// The persisted cursor. It is ADVISORY: the tags on the entities and the kingdom records are the truth, and
// everything in the cursor can be rebuilt from them. Losing or corrupting the cursor therefore costs at most a
// re-derivation (and any adoption it reports), never a duplicate or a lost unit. A newer version is refused
// rather than overwritten, the same rule kingdom/store.js follows for the kingdom save.
//
// Fields (short keys keep the value tiny):
//   v  format version
//   t  last reconciled game tick (null before the first run; a smaller tick after a restart starts a new epoch)
//   n  reconcile runs in total
//   s  spawns already spent on tick t (so repeated calls within one tick cannot exceed the per-tick budget)
//   o  operations already spent on tick t
//   p  physical group ids the last reconcile admitted, sorted

/**
 * @typedef {{ tick: number | null, runs: number, spawns: number, ops: number, physical: string[] }} CursorState
 */

/** @returns {CursorState} */
export function emptyCursor() {
    return { tick: null, runs: 0, spawns: 0, ops: 0, physical: [] };
}

/**
 * @param {CursorState} state
 * @returns {string}
 */
export function encodeCursor(state) {
    return JSON.stringify({
        v: POP_CURSOR_VERSION,
        t: state.tick,
        n: state.runs,
        s: state.spawns,
        o: state.ops,
        p: state.physical,
    });
}

/**
 * @param {CursorState} state
 * @returns {number} UTF-8 bytes of the encoded cursor
 */
export function cursorBytes(state) {
    return utf8Length(encodeCursor(state));
}

/**
 * @param {unknown} value
 */
function isCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parse a stored cursor. Never throws.
 *  - absent: nothing stored yet;
 *  - ok: a valid cursor of this version;
 *  - corrupt: unreadable or malformed, so the caller starts from empty (safe: see the header);
 *  - newer: written by a later pack version, so the caller must not reconcile or overwrite it.
 * @param {unknown} raw
 * @returns {{ status: "absent" | "ok" | "corrupt" | "newer", state: CursorState, reason: string | undefined }}
 */
export function decodeCursor(raw) {
    if (raw === undefined) {
        return { status: "absent", state: emptyCursor(), reason: undefined };
    }
    /**
     * @param {string} reason
     */
    const corrupt = (reason) => ({ status: /** @type {const} */ ("corrupt"), state: emptyCursor(), reason });
    if (typeof raw !== "string") {
        return corrupt(`stored cursor is a ${typeof raw}, expected a JSON string`);
    }
    if (utf8Length(raw) > POP_CURSOR_MAX_BYTES) {
        return corrupt(`stored cursor is ${String(utf8Length(raw))} bytes, above the ${String(POP_CURSOR_MAX_BYTES)}-byte ceiling`);
    }
    /** @type {any} */
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return corrupt(`stored cursor is not valid JSON (${String(error)})`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return corrupt("stored cursor is not an object");
    }
    if (typeof parsed.v !== "number") {
        return corrupt("stored cursor has no version");
    }
    if (parsed.v > POP_CURSOR_VERSION) {
        return {
            status: "newer",
            state: emptyCursor(),
            reason: `stored cursor is version ${String(parsed.v)}, newer than this pack (version ${String(POP_CURSOR_VERSION)})`,
        };
    }
    if (parsed.v !== POP_CURSOR_VERSION) {
        return corrupt(`stored cursor version ${String(parsed.v)} is not readable`);
    }
    if (!(parsed.t === null || isCount(parsed.t)) || !isCount(parsed.n) || !isCount(parsed.s) || !isCount(parsed.o)) {
        return corrupt("stored cursor counters must be non-negative integers (or a null tick)");
    }
    if (!Array.isArray(parsed.p) || parsed.p.length > POP_CURSOR_MAX_PHYSICAL) {
        return corrupt("stored cursor physical list is missing or too long");
    }
    /** @type {Set<string>} */
    const seen = new Set();
    for (const id of parsed.p) {
        if (typeof id !== "string" || parseGroupId(id) === null || seen.has(id)) {
            return corrupt(`stored cursor names an invalid or repeated group '${String(id)}'`);
        }
        seen.add(id);
    }
    return {
        status: "ok",
        state: {
            tick: parsed.t,
            runs: parsed.n,
            spawns: parsed.s,
            ops: parsed.o,
            physical: [...parsed.p],
        },
        reason: undefined,
    };
}
