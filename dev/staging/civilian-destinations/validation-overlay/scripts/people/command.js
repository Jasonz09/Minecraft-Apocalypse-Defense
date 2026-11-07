/**
 * Commanders: one officer per block of soldiers, per district, posted to the front or the reserve.
 *
 * Pure. Commanders are derived from the garrison every time, so they cannot drift from it.
 *
 * Rules:
 *  - `commandersFor(soldiers) = max(1, floor(soldiers / soldiersPerCommander))` when soldiers > 0,
 *    and 0 when the district has none. A 30-soldier district has 3 commanders.
 *  - Commanders belong to one district and never cross a border.
 *  - The split follows the garrison: front soldiers get the front commanders in proportion, and
 *    the reserve always keeps one commander when it has men (unless the district has only one
 *    commander in total, in which case the reserve is reported as unled, not hidden).
 *  - A commander with no soldiers is an ERROR state, never a silent zero. This covers an existing
 *    commander record whose district has no soldiers left, and a commander filed under another district.
 *  - A `lost` district has no command structure and produces nothing.
 */

/** Tunables local to this module. */
export const COMMAND_RULES = Object.freeze({
    /** Soldiers per commander. */
    soldiersPerCommander: 10,
});

/**
 * @param {any} value
 * @returns {number}
 */
function count(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

/**
 * @param {number} soldiers
 * @param {number} [span]
 * @returns {number} commanders the district needs
 */
export function commandersFor(soldiers, span = COMMAND_RULES.soldiersPerCommander) {
    const men = count(soldiers);
    if (men === 0) {
        return 0;
    }
    return Math.max(1, Math.floor(men / Math.max(1, count(span))));
}

/**
 * Split `total` men over `groups` commanders as evenly as possible (first groups take the remainder).
 * @param {number} total
 * @param {number} groups
 * @returns {number[]}
 */
function partition(total, groups) {
    if (groups <= 0) {
        return [];
    }
    const base = Math.floor(total / groups);
    const extra = total - base * groups;
    return Array.from({ length: groups }, (_unused, index) => base + (index < extra ? 1 : 0));
}

/**
 * Commander counts per post for a garrison.
 * @param {number} soldiers
 * @param {number} front
 * @param {number} reserve
 * @returns {{ total: number, front: number, reserve: number, unledReserve: number }}
 */
export function commandSplit(soldiers, front, reserve) {
    const total = commandersFor(soldiers);
    if (total === 0) {
        return { total: 0, front: 0, reserve: 0, unledReserve: 0 };
    }
    if (front === 0) {
        return { total, front: 0, reserve: total, unledReserve: 0 };
    }
    if (reserve === 0) {
        return { total, front: total, reserve: 0, unledReserve: 0 };
    }
    let reserveCommanders = Math.max(1, Math.round((total * reserve) / soldiers));
    let frontCommanders = total - reserveCommanders;
    if (frontCommanders < 1) {
        frontCommanders = 1;
        reserveCommanders = total - 1;
    }
    const unledReserve = reserveCommanders === 0 ? reserve : 0;
    return { total, front: frontCommanders, reserve: reserveCommanders, unledReserve };
}

/**
 * Commanders for one district, from its garrison.
 *
 * @param {any} district a PeopleDistrict
 * @param {{ existing?: Array<{ id: string, districtId: string, post?: string, soldiers?: number }> }} [options]
 *   `existing` are commander records already on the save; they are checked, not trusted.
 * @returns {{
 *   districtId: string, lost: boolean, state: "ok" | "error", total: number, front: number, reserve: number,
 *   unledReserve: number, span: number, reason: string | null,
 *   commanders: Array<{ id: string, districtId: string, post: "front" | "reserve", soldiers: number, state: "ok" | "error", error: string | null }>,
 *   errors: string[]
 * }}
 */
export function assignCommanders(district, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("assignCommanders: district must be an object");
    }
    const districtId = String(district.id);
    const span = COMMAND_RULES.soldiersPerCommander;

    if (String(district.security) === "lost") {
        return {
            districtId, lost: true, state: "ok", total: 0, front: 0, reserve: 0, unledReserve: 0, span,
            reason: "district lost: no command structure", commanders: [], errors: [],
        };
    }

    const soldiers = count(district.soldiers);
    const front = count(district.garrison?.front);
    const reserve = count(district.garrison?.reserve);
    /** @type {string[]} */
    const errors = [];
    if (front + reserve !== soldiers) {
        errors.push(`garrison front ${String(front)} + reserve ${String(reserve)} does not equal soldiers ${String(soldiers)}`);
    }
    const split = commandSplit(soldiers, front, reserve);

    /** @type {Array<{ id: string, districtId: string, post: "front" | "reserve", soldiers: number, state: "ok" | "error", error: string | null }>} */
    const commanders = [];
    const frontShares = partition(front, split.front);
    const reserveShares = partition(reserve, split.reserve);
    for (let index = 0; index < split.total; index += 1) {
        const post = index < split.front ? "front" : "reserve";
        const men = post === "front" ? frontShares[index] : reserveShares[index - split.front];
        const state = men > 0 ? "ok" : "error";
        const error = men > 0 ? null : "commander-without-soldiers";
        if (state === "error") {
            errors.push(`${districtId}:cmd-${String(index + 1)} would command no soldiers`);
        }
        commanders.push({ id: `${districtId}:cmd-${String(index + 1)}`, districtId, post, soldiers: men, state, error });
    }

    for (const record of options.existing ?? []) {
        if (String(record.districtId) !== districtId) {
            errors.push(`${String(record.id)} is filed under ${String(record.districtId)}, not ${districtId}`);
            commanders.push({ id: String(record.id), districtId: String(record.districtId), post: record.post === "reserve" ? "reserve" : "front", soldiers: 0, state: "error", error: "commander-from-another-district" });
        } else if (soldiers === 0 || (record.soldiers !== undefined && count(record.soldiers) === 0)) {
            errors.push(`${String(record.id)} is a commander with no soldiers`);
            commanders.push({ id: String(record.id), districtId, post: record.post === "reserve" ? "reserve" : "front", soldiers: 0, state: "error", error: "commander-without-soldiers" });
        }
    }

    const state = errors.length > 0 ? "error" : "ok";
    return {
        districtId,
        lost: false,
        state,
        total: split.total,
        front: split.front,
        reserve: split.reserve,
        unledReserve: split.unledReserve,
        span,
        reason: split.unledReserve > 0 ? `${String(split.unledReserve)} reserve soldier(s) have no commander of their own` : null,
        commanders,
        errors,
    };
}

/**
 * The count invariant the tests and the long run check: commanders equal `commandersFor(soldiers)`,
 * every commander leads at least one soldier, and every soldier is led except any reported unled reserve.
 *
 * @param {any} district
 * @param {ReturnType<typeof assignCommanders>} result
 * @returns {string[]}
 */
export function commandProblems(district, result) {
    /** @type {string[]} */
    const problems = [];
    const soldiers = count(district.soldiers);
    // A lost district keeps its soldiers on the record but has no command structure (see assignCommanders).
    const expected = String(district.security) === "lost" ? 0 : commandersFor(soldiers);
    if (result.total !== expected) {
        problems.push(`${String(result.total)} commanders for ${String(soldiers)} soldiers (expected ${String(expected)})`);
    }
    if (result.commanders.length !== result.total) {
        problems.push(`${String(result.commanders.length)} commander records for ${String(result.total)} commanders`);
    }
    const led = result.commanders.reduce((sum, commander) => sum + commander.soldiers, 0);
    if (expected !== 0 && led + result.unledReserve !== soldiers) {
        problems.push(`commanders lead ${String(led)} soldiers, unled ${String(result.unledReserve)}, district has ${String(soldiers)}`);
    }
    for (const commander of result.commanders) {
        if (commander.soldiers < 1) {
            problems.push(`${commander.id} leads no soldiers`);
        }
    }
    return problems;
}
