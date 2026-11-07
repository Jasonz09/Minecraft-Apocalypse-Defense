/**
 * Enemy wave compositions, as data.
 *
 * Every attacker is an abstract count of one of three unit types. Strength is measured in
 * raider-equivalents, the same unit as `district.assault` in sim/war.js, so a strike can be
 * landed on a district as one strength number with no new combat arithmetic.
 *
 * Pure data and integer arithmetic. Nothing here reads the world or depends on the script API.
 *
 * @typedef {"raider" | "archer" | "brute"} UnitType
 * @typedef {"raid" | "major"} InvasionKind
 * @typedef {{ id: string, kind: InvasionKind, label: string, strikes: number,
 *   perStrike: Record<UnitType, number[]>, maxTotalStrength: number }} Composition
 *   (perStrike ranges are [min, max]; validateCompositions checks the length and order)
 * @typedef {{ raider: number, archer: number, brute: number }} UnitCounts
 * @typedef {{ counts: UnitCounts, strength: number }} Strike
 */

/** Strength per unit, in raider-equivalents. Integers only, so every total stays integral. */
export const UNIT_TYPES = Object.freeze({
    raider: Object.freeze({ strength: 1, ranged: false }),
    archer: Object.freeze({ strength: 2, ranged: true }),
    brute: Object.freeze({ strength: 3, ranged: false }),
});

/** Delivery order onto a wall: the cheap vanguard first, brutes last. */
export const UNIT_ORDER = Object.freeze(/** @type {UnitType[]} */ (["raider", "archer", "brute"]));

/**
 * Hard caps. Each one is enforced twice: the planner never asks for more than this, and
 * applyDirectives refuses anything over it, so a bad caller cannot exceed them either.
 */
export const INVASION_LIMITS = Object.freeze({
    /** Directives accepted in one tick, all kinds together. */
    maxDirectivesPerStep: 4,
    /** Raider-equivalent strength landed across the whole kingdom in one tick. */
    maxSpawnPerStep: 8,
    /** Raider-equivalent strength landed on one district in one tick. */
    maxSpawnPerDistrictPerStep: 6,
    /** One strike (one landing wave) never exceeds this. Kept below the district cap on purpose. */
    maxWaveStrength: 24,
    /** Units of one type in one strike. */
    maxTypeCount: Object.freeze({ raider: 16, archer: 6, brute: 3 }),
    /** Same value as ASSAULT_CAP in sim/war.js, which is not exported there. dev/test checks it. */
    districtAssaultCap: 32,
    /** Finished invasions kept in the saved record. */
    maxSavedHistory: 12,
});

/** Approach bearings, the sector an invasion is sighted coming from. */
export const BEARINGS = Object.freeze(["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]);

/** Wall sections a district can be attacked on, when the attack does not target a gate. */
export const WALL_SECTIONS = Object.freeze(["north", "east", "south", "west"]);

/**
 * The composition table. `perStrike` gives an inclusive [min, max] range per unit type for
 * each strike. A composition with several strikes is a major invasion: the band lands,
 * is spent, regroups and lands again. `maxTotalStrength` caps the whole invasion.
 *
 * @type {readonly Composition[]}
 */
export const COMPOSITIONS = Object.freeze([
    Object.freeze({
        id: "probe",
        kind: "raid",
        label: "a scouting party",
        strikes: 1,
        perStrike: Object.freeze({ raider: [3, 6], archer: [0, 0], brute: [0, 0] }),
        maxTotalStrength: 6,
    }),
    Object.freeze({
        id: "skirmish",
        kind: "raid",
        label: "a raiding band",
        strikes: 1,
        perStrike: Object.freeze({ raider: [6, 9], archer: [0, 2], brute: [0, 0] }),
        maxTotalStrength: 13,
    }),
    Object.freeze({
        id: "warband",
        kind: "raid",
        label: "a warband",
        strikes: 1,
        perStrike: Object.freeze({ raider: [8, 12], archer: [1, 3], brute: [0, 1] }),
        maxTotalStrength: 21,
    }),
    Object.freeze({
        id: "siege-host",
        kind: "major",
        label: "a siege host",
        strikes: 2,
        perStrike: Object.freeze({ raider: [10, 14], archer: [2, 4], brute: [1, 2] }),
        maxTotalStrength: 40,
    }),
    Object.freeze({
        id: "great-host",
        kind: "major",
        label: "a great host",
        strikes: 3,
        perStrike: Object.freeze({ raider: [8, 12], archer: [2, 3], brute: [1, 2] }),
        maxTotalStrength: 48,
    }),
]);

/**
 * @param {any} counts
 * @returns {number} total raider-equivalent strength of a set of unit counts
 */
export function strengthOf(counts) {
    let total = 0;
    for (const type of UNIT_ORDER) {
        total += Number(counts?.[type] ?? 0) * UNIT_TYPES[type].strength;
    }
    return total;
}

/**
 * @param {any} counts
 * @returns {number}
 */
export function unitsOf(counts) {
    let total = 0;
    for (const type of UNIT_ORDER) {
        total += Number(counts?.[type] ?? 0);
    }
    return total;
}

/**
 * Brings a rolled set of counts under a strength limit, shedding brutes first, then archers,
 * then raiders. Deterministic and bounded: every pass removes one unit.
 *
 * @param {UnitCounts} counts
 * @param {number} limit
 * @returns {UnitCounts}
 */
export function fitCounts(counts, limit) {
    /** @type {UnitCounts} */
    const fitted = { raider: 0, archer: 0, brute: 0 };
    for (const type of UNIT_ORDER) {
        fitted[type] = Math.min(Math.max(0, Math.floor(counts[type])), INVASION_LIMITS.maxTypeCount[type]);
    }
    const shedOrder = /** @type {UnitType[]} */ (["brute", "archer", "raider"]);
    let strength = strengthOf(fitted);
    while (strength > limit) {
        const type = shedOrder.find((candidate) => fitted[candidate] > 0);
        if (type === undefined) {
            break;
        }
        fitted[type] -= 1;
        strength -= UNIT_TYPES[type].strength;
    }
    return fitted;
}

/**
 * Rolls the strikes of one invasion. `drawInt(min, max)` must return an integer in the
 * inclusive range; the caller supplies it so the draws come from the director's seeded stream.
 * Strikes stop early when the composition's total strength cap is used up, and a strike that
 * fits no units is dropped rather than landed empty.
 *
 * @param {Composition} composition
 * @param {(min: number, max: number) => number} drawInt
 * @returns {Strike[]}
 */
export function planStrikes(composition, drawInt) {
    /** @type {Strike[]} */
    const strikes = [];
    let used = 0;
    for (let index = 0; index < composition.strikes; index += 1) {
        const remaining = composition.maxTotalStrength - used;
        if (remaining <= 0) {
            break;
        }
        /** @type {UnitCounts} */
        const rolled = { raider: 0, archer: 0, brute: 0 };
        for (const type of UNIT_ORDER) {
            const [min, max] = composition.perStrike[type];
            rolled[type] = drawInt(min, max);
        }
        const counts = fitCounts(rolled, Math.min(INVASION_LIMITS.maxWaveStrength, remaining));
        const strength = strengthOf(counts);
        if (strength <= 0) {
            break;
        }
        strikes.push({ counts, strength });
        used += strength;
    }
    return strikes;
}

/**
 * Structural check of the composition table, used by the tests and available to tooling.
 *
 * @param {readonly Composition[]} list
 * @returns {string[]} problems; empty when the table is sound
 */
export function validateCompositions(list = COMPOSITIONS) {
    /** @type {string[]} */
    const problems = [];
    const seen = new Set();
    for (const composition of list) {
        const label = `composition ${String(composition.id)}`;
        if (typeof composition.id !== "string" || composition.id.length === 0) {
            problems.push("a composition has no id");
            continue;
        }
        if (seen.has(composition.id)) {
            problems.push(`${label} is repeated`);
        }
        seen.add(composition.id);
        if (composition.kind !== "raid" && composition.kind !== "major") {
            problems.push(`${label} has kind '${String(composition.kind)}'`);
        }
        if (typeof composition.label !== "string" || composition.label.length === 0) {
            problems.push(`${label} has no label`);
        }
        if (!Number.isInteger(composition.strikes) || composition.strikes < 1 || composition.strikes > 3) {
            problems.push(`${label} must have 1 to 3 strikes`);
        }
        let firstStrikeMinimum = 0;
        for (const type of UNIT_ORDER) {
            const range = composition.perStrike?.[type];
            if (!Array.isArray(range) || range.length !== 2) {
                problems.push(`${label} needs a [min, max] range for ${type}`);
                continue;
            }
            const [min, max] = range;
            if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
                problems.push(`${label} ${type} range must be integers with 0 <= min <= max`);
            } else if (max > INVASION_LIMITS.maxTypeCount[type]) {
                problems.push(`${label} ${type} max ${String(max)} exceeds the per-type cap ${String(INVASION_LIMITS.maxTypeCount[type])}`);
            }
            firstStrikeMinimum += Number.isInteger(min) ? min * UNIT_TYPES[type].strength : 0;
        }
        if (!Number.isInteger(composition.maxTotalStrength) || composition.maxTotalStrength < 1) {
            problems.push(`${label} needs an integer maxTotalStrength of at least 1`);
        } else if (firstStrikeMinimum === 0 || composition.maxTotalStrength < firstStrikeMinimum) {
            problems.push(`${label} maxTotalStrength cannot hold even its smallest first strike`);
        }
    }
    return problems;
}
