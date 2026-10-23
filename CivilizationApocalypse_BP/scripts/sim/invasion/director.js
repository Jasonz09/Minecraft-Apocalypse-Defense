/**
 * The invasion director: a staged, seeded planner that drives the existing war simulation.
 *
 * State machine (one invasion at a time; one stage change at most per step):
 *
 *   quiet -> scouting -> approach -> assault -> aftermath -> cooldown -> quiet
 *                           ^          |
 *                           +-regroup--+   (a major invasion has several strikes)
 *
 *   - quiet: a periodic activity is due at `nextEventStep`. The planner rolls for a major
 *     invasion (bounded by a minimum gap and a per-window count) or a raid, then picks a
 *     target district, an approach bearing, a wall section or gate, and a composition.
 *   - scouting: the sighting is announced (a `scout` directive). Nothing lands yet.
 *   - approach: the group marches for `approachSteps`. While it is within `physicalRadius` of a
 *     player it is flagged `physical` for the future entity layer; the numbers still come from war.js.
 *   - assault: each step lands at most one chunk of the current strike as a `spawn` directive,
 *     bounded per district and per tick. When the strike is in and the wall has worked the
 *     assault down to zero, the next strike regroups, or the wave moves to aftermath.
 *   - aftermath: the war's own counterattack and recovery run. A breach or a fall raises an alarm.
 *   - cooldown: a fixed rest, then the field is quiet again and the next activity is scheduled.
 *
 * Purity: `nextDirectorState` reads the kingdom and returns a new state; it never writes to the
 * kingdom or to its input. `stepInvasion` is the one place that writes: it applies the directives
 * through apply.js and stores the new state at `kingdom.invasion`.
 *
 * Gate: `kingdom.invasion` absent, or present with `enabled !== true`, means the director reads
 * nothing it could change and writes nothing at all. A disabled kingdom serialises byte for byte
 * as it would without the director.
 *
 * Randomness: the director has its own cursor (`state.rngCursor`), seeded from the invasion seed.
 * It never draws from `kingdom.rngState`, so turning the director on cannot perturb the war's stream.
 *
 * @typedef {any} Kingdom
 * @typedef {any} InvasionState
 */

import { hashSeed, nextChance, nextInt } from "../rng.js";
import { districtById, pushEvent } from "../../kingdom/state.js";
import { applyDirectivesDetailed } from "./apply.js";
import { BEARINGS, COMPOSITIONS, INVASION_LIMITS, UNIT_ORDER, UNIT_TYPES, WALL_SECTIONS, planStrikes, unitsOf } from "./composition.js";

/**
 * Tunables. Every stage length is in simulation steps (one step is one in-game hour).
 * `enabled` is false: nothing runs until a caller creates or enables an invasion record.
 */
export const INVASION_DEFAULTS = Object.freeze({
    enabled: false,
    /** Gap between periodic hostile activity, in steps (48-96 steps is two to four in-game days). */
    raidGapMin: 48,
    raidGapMax: 96,
    /** Chance that a due activity is a major invasion, before the bounds below are applied. */
    majorChance: 0.25,
    /** Minimum steps between two major invasions (ten in-game days). */
    majorGapMin: 240,
    /** A sliding window: no more than `maxMajorsPerWindow` majors start within it. */
    majorWindowSteps: 720,
    maxMajorsPerWindow: 2,
    /** Steps from sighting to the march. */
    scoutSteps: 2,
    /** Steps of the march to the walls, drawn per invasion. */
    approachMin: 3,
    approachMax: 5,
    /** Steps between strikes of a major invasion. */
    regroupSteps: 2,
    /** Backstop: an assault that has not resolved by now is stood down. Normal waves end well before this. */
    maxAssaultSteps: 40,
    aftermathSteps: 6,
    cooldownSteps: 12,
    /** A group within this many blocks of a player is flagged physical. */
    physicalRadius: 96,
});

/** The stages, in order. */
export const PHASES = Object.freeze(["quiet", "scouting", "approach", "assault", "aftermath", "cooldown"]);

/** The only stage changes the planner ever makes. Tests check every transition against this table. */
export const PHASE_EDGES = Object.freeze({
    quiet: Object.freeze(["scouting"]),
    scouting: Object.freeze(["approach"]),
    approach: Object.freeze(["assault", "aftermath"]),
    assault: Object.freeze(["approach", "aftermath"]),
    aftermath: Object.freeze(["cooldown"]),
    cooldown: Object.freeze(["quiet"]),
});

/** @type {Record<string, string>} */
const VERDICT_TEXT = Object.freeze({
    repelled: "the wall holds and the band is driven off",
    breached: "the wall is breached",
    fallen: "the district has fallen",
    "timed out": "the attack stalls and is stood down",
    aborted: "the attack is called off",
});

/** Stage lengths must be at least one step, or a stage could be skipped without being seen. */
const MINIMUM_ONE_STEP = Object.freeze(["scoutSteps", "approachMin", "approachMax", "regroupSteps", "maxAssaultSteps", "aftermathSteps", "cooldownSteps"]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isUint32(value) {
    return Number.isInteger(value) && /** @type {number} */ (value) >= 0 && /** @type {number} */ (value) <= 0xffffffff;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCount(value) {
    return Number.isInteger(value) && /** @type {number} */ (value) >= 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toInt(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * @param {InvasionState} state
 * @returns {boolean}
 */
export function isInvasionEnabled(state) {
    return isPlainObject(state) && state.enabled === true;
}

/** @returns {Record<string, number>} */
function zeroCounts() {
    return { raider: 0, archer: 0, brute: 0 };
}

/**
 * @param {Record<string, number>} left
 * @param {Record<string, number>} right
 * @returns {Record<string, number>}
 */
function addCounts(left, right) {
    const sum = zeroCounts();
    for (const type of UNIT_ORDER) {
        sum[type] = toInt(left[type]) + toInt(right[type]);
    }
    return sum;
}

/**
 * What is still to land of one strike.
 *
 * @param {Record<string, number>} counts
 * @param {Record<string, number>} delivered
 * @returns {Record<string, number>}
 */
function pendingOf(counts, delivered) {
    const pending = zeroCounts();
    for (const type of UNIT_ORDER) {
        pending[type] = Math.max(0, toInt(counts[type]) - toInt(delivered[type]));
    }
    return pending;
}

/**
 * The largest chunk of pending units that fits the budget, taken vanguard first. Greedy and
 * deterministic: a unit that does not fit is skipped, and smaller units behind it may still fit.
 *
 * @param {Record<string, number>} pending
 * @param {number} budget
 * @returns {{ counts: Record<string, number>, strength: number }}
 */
function takeChunk(pending, budget) {
    const counts = zeroCounts();
    const left = { ...pending };
    let used = 0;
    for (const type of UNIT_ORDER) {
        const unit = UNIT_TYPES[type].strength;
        while (left[type] > 0 && used + unit <= budget) {
            left[type] -= 1;
            counts[type] += 1;
            used += unit;
        }
    }
    return { counts, strength: used };
}

/**
 * A seeded stream over a uint32 cursor. Each draw advances the cursor; the caller reads it back
 * with `cursor()` and stores it, so the stream itself holds no hidden state.
 *
 * @param {number} cursor
 */
function makeStream(cursor) {
    let state = cursor >>> 0;
    /**
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    function int(min, max) {
        const draw = nextInt(state, min, max);
        state = draw.next >>> 0;
        return draw.value;
    }
    /**
     * @param {number} probability
     * @returns {boolean}
     */
    function chance(probability) {
        const draw = nextChance(state, probability);
        state = draw.next >>> 0;
        return draw.value;
    }
    /**
     * @template T
     * @param {readonly T[]} items
     * @returns {T}
     */
    function pick(items) {
        return items[int(0, items.length - 1)];
    }
    return { int, chance, pick, cursor: () => state >>> 0 };
}

/**
 * @param {Kingdom} kingdom
 * @returns {Record<string, any>[]}
 */
function sortedDistricts(kingdom) {
    const list = /** @type {Record<string, any>[]} */ (Array.isArray(kingdom?.districts) ? kingdom.districts : []);
    return list.slice().sort((left, right) => {
        const a = String(left?.id ?? "");
        const b = String(right?.id ?? "");
        return a < b ? -1 : a > b ? 1 : 0;
    });
}

/**
 * @param {Kingdom} kingdom
 * @param {string[]} texts
 */
function logEvents(kingdom, texts) {
    if (!Array.isArray(kingdom.log)) {
        kingdom.log = [];
    }
    for (const text of texts) {
        pushEvent(kingdom, text);
    }
}

/**
 * @param {InvasionState} wave
 * @returns {string}
 */
function targetText(wave) {
    const target = wave.target;
    return target && target.kind === "gate" ? `gate ${String(target.gateId)}` : `${String(target?.section)} wall`;
}

/**
 * The options the planner reads. Anything missing falls back to INVASION_DEFAULTS.
 * Invalid tuning throws: it is a programming error, not a saved-state problem.
 *
 * @param {any} options
 * @returns {Record<string, any>}
 */
function tuningOf(options) {
    /** @type {Record<string, any>} */
    const tuning = { ...INVASION_DEFAULTS, ...(isPlainObject(options?.tuning) ? options.tuning : {}) };
    for (const key of Object.keys(INVASION_DEFAULTS)) {
        if (key === "enabled") {
            continue;
        }
        const value = tuning[key];
        if (key === "majorChance") {
            if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
                throw new Error(`invasion tuning majorChance must be 0..1, got ${String(value)}`);
            }
        } else if (!Number.isInteger(value) || value < 0) {
            throw new Error(`invasion tuning ${key} must be a non-negative integer, got ${String(value)}`);
        }
    }
    for (const key of MINIMUM_ONE_STEP) {
        if (tuning[key] < 1) {
            throw new Error(`invasion tuning ${key} must be at least 1 step`);
        }
    }
    if (tuning.raidGapMin > tuning.raidGapMax || tuning.approachMin > tuning.approachMax) {
        throw new Error("invasion tuning: a minimum is larger than its maximum");
    }
    return tuning;
}

/**
 * Creates a disabled invasion record by default. The seed fixes the director's own stream.
 *
 * @param {number} seed uint32
 * @param {boolean} [enabled]
 * @returns {InvasionState}
 */
export function createInvasionState(seed, enabled = INVASION_DEFAULTS.enabled) {
    if (!isUint32(seed)) {
        throw new Error(`createInvasionState: seed must be a uint32 integer, got ${String(seed)}`);
    }
    return {
        enabled: enabled === true,
        seed,
        rngCursor: hashSeed(`invasion:${String(seed)}`),
        phase: "quiet",
        nextEventStep: null,
        lastMajorStep: null,
        majorSteps: [],
        sequence: 0,
        wave: null,
        history: [],
    };
}

/**
 * Explicit opt-in: creates an enabled invasion record on a kingdom that has none, seeded from
 * the kingdom's seed. An existing record is only switched on, never reset.
 *
 * @param {Kingdom} kingdom
 * @returns {InvasionState}
 */
export function enableInvasion(kingdom) {
    const current = kingdom.invasion;
    if (current === undefined || current === null) {
        const seed = isUint32(kingdom.seed) ? kingdom.seed : 0;
        kingdom.invasion = createInvasionState(seed, true);
    } else if (!isInvasionEnabled(current)) {
        kingdom.invasion = { ...current, enabled: true };
    }
    return kingdom.invasion;
}

/**
 * Structural check of a saved invasion record. Used before planning, so a damaged record is
 * refused instead of driving the war with nonsense.
 *
 * @param {InvasionState} state
 * @returns {string[]}
 */
export function validateInvasionState(state) {
    if (!isPlainObject(state)) {
        return ["state is not an object"];
    }
    /** @type {string[]} */
    const problems = [];
    if (typeof state.enabled !== "boolean") {
        problems.push("enabled must be true or false");
    }
    if (!isUint32(state.seed)) {
        problems.push("seed must be a uint32 integer");
    }
    if (!isUint32(state.rngCursor)) {
        problems.push("rngCursor must be a uint32 integer");
    }
    if (!PHASES.includes(state.phase)) {
        problems.push(`phase '${String(state.phase)}' is not a known stage`);
    }
    if (!(state.nextEventStep === null || isCount(state.nextEventStep))) {
        problems.push("nextEventStep must be null or a step number");
    }
    if (!(state.lastMajorStep === null || isCount(state.lastMajorStep))) {
        problems.push("lastMajorStep must be null or a step number");
    }
    if (!Array.isArray(state.majorSteps) || !state.majorSteps.every(isCount)) {
        problems.push("majorSteps must be a list of step numbers");
    }
    if (!isCount(state.sequence)) {
        problems.push("sequence must be a non-negative integer");
    }
    if (!Array.isArray(state.history) || state.history.length > INVASION_LIMITS.maxSavedHistory) {
        problems.push(`history must be a list of at most ${String(INVASION_LIMITS.maxSavedHistory)} entries`);
    } else if (!state.history.every((entry) => isPlainObject(entry) && typeof entry.id === "string" && typeof entry.outcome === "string")) {
        problems.push("every history entry needs an id and an outcome");
    }
    if (state.phase === "quiet") {
        if (state.wave !== null) {
            problems.push("the quiet stage holds no wave");
        }
    } else if (PHASES.includes(state.phase)) {
        problems.push(...validateWave(state.wave));
    }
    return problems;
}

/**
 * @param {any} wave
 * @returns {string[]}
 */
function validateWave(wave) {
    if (!isPlainObject(wave)) {
        return ["an active stage needs a wave record"];
    }
    /** @type {string[]} */
    const problems = [];
    if (typeof wave.id !== "string" || wave.id.length === 0) {
        problems.push("wave.id must be text");
    }
    if (wave.kind !== "raid" && wave.kind !== "major") {
        problems.push(`wave.kind '${String(wave.kind)}' is not raid or major`);
    }
    if (typeof wave.districtId !== "string" || wave.districtId.length === 0) {
        problems.push("wave.districtId must be text");
    }
    if (!COMPOSITIONS.some((composition) => composition.id === wave.compositionId)) {
        problems.push(`wave.compositionId '${String(wave.compositionId)}' is not in the composition table`);
    }
    if (!Array.isArray(wave.strikes) || wave.strikes.length === 0) {
        problems.push("wave.strikes must list at least one strike");
        return problems;
    }
    const strikesValid = wave.strikes.every(
        (/** @type {any} */ strike) => isPlainObject(strike) && isPlainObject(strike.counts) && UNIT_ORDER.every((type) => isCount(strike.counts[type])),
    );
    if (!strikesValid) {
        problems.push("every strike needs non-negative unit counts");
        return problems;
    }
    if (!isCount(wave.strike) || wave.strike >= wave.strikes.length) {
        problems.push("wave.strike is out of range");
        return problems;
    }
    if (!isPlainObject(wave.delivered) || !UNIT_ORDER.every((type) => isCount(wave.delivered[type]))) {
        problems.push("wave.delivered must count units");
    } else {
        const current = wave.strikes[wave.strike].counts;
        if (!UNIT_ORDER.every((type) => wave.delivered[type] <= current[type])) {
            problems.push("wave.delivered exceeds the current strike");
        }
    }
    for (const field of ["stageSteps", "assaultSteps", "approachSteps", "deliveredStrength", "startedStep"]) {
        if (!isCount(wave[field])) {
            problems.push(`wave.${field} must be a non-negative integer`);
        }
    }
    if (typeof wave.physical !== "boolean" || typeof wave.breached !== "boolean") {
        problems.push("wave.physical and wave.breached must be true or false");
    }
    return problems;
}

/**
 * Lowers the wave's bookkeeping to a history entry and moves the stage to aftermath. The alarm,
 * when there is one, is queued as a directive.
 *
 * @param {InvasionState} next
 * @param {number} step
 * @param {string} outcome
 * @param {Record<string, any> | undefined} district
 * @param {any[]} directives
 * @param {string[]} events
 */
function finishWave(next, step, outcome, district, directives, events) {
    const wave = next.wave;
    let verdict = outcome;
    if (district && district.security === "lost") {
        verdict = "fallen";
    } else if (wave.breached && outcome !== "aborted") {
        verdict = "breached";
    }
    const plannedStrength = wave.strikes.reduce((/** @type {number} */ total, /** @type {any} */ strike) => total + toInt(strike.strength), 0);
    next.history = [
        ...next.history,
        {
            id: wave.id,
            kind: wave.kind,
            compositionId: wave.compositionId,
            districtId: wave.districtId,
            outcome: verdict,
            startedStep: wave.startedStep,
            landedStep: wave.landedStep,
            endedStep: step,
            plannedStrength,
            deliveredStrength: wave.deliveredStrength,
            physicalAtEnd: wave.physical,
        },
    ].slice(-INVASION_LIMITS.maxSavedHistory);
    wave.outcome = verdict;
    wave.endedStep = step;
    next.phase = "aftermath";
    wave.stageSteps = 0;
    const name = district ? String(district.name) : String(wave.districtId);
    events.push(`${String(wave.id)}: the assault on ${name} ends - ${VERDICT_TEXT[verdict] ?? verdict}.`);
    if (verdict === "breached" || verdict === "fallen") {
        directives.push({ kind: "alarm", districtId: wave.districtId, waveId: wave.id, reason: verdict });
    }
}

/**
 * Starts an invasion, if the periodic activity is due. Consumes draws in a fixed order.
 *
 * @param {InvasionState} next
 * @param {Kingdom} kingdom
 * @param {number} step
 * @param {ReturnType<typeof makeStream>} draw
 * @param {Record<string, any>} tuning
 * @param {any[]} directives
 * @param {string[]} events
 */
function startInvasion(next, kingdom, step, draw, tuning, directives, events) {
    next.majorSteps = next.majorSteps.filter((/** @type {number} */ at) => at > step - tuning.majorWindowSteps);
    const majorAllowed =
        (next.lastMajorStep === null || step - next.lastMajorStep >= tuning.majorGapMin) && next.majorSteps.length < tuning.maxMajorsPerWindow;
    const wantMajor = majorAllowed && draw.chance(tuning.majorChance);

    const open = sortedDistricts(kingdom).filter((district) => district.security !== "lost" && district.security !== "isolated");
    if (open.length === 0) {
        next.nextEventStep = step + tuning.raidGapMin;
        events.push(`No district is open to attack at step ${String(step)}; the next activity is put back.`);
        return;
    }

    const kind = wantMajor ? "major" : "raid";
    const composition = draw.pick(COMPOSITIONS.filter((candidate) => candidate.kind === kind));
    const district = draw.pick(open);
    const bearing = draw.pick(BEARINGS);
    const gateIds = (Array.isArray(district.gates) ? district.gates : []).map((/** @type {any} */ gate) => String(gate.id));
    const target =
        gateIds.length > 0 && draw.chance(0.5)
            ? { kind: "gate", gateId: draw.pick(gateIds) }
            : { kind: "wall", section: draw.pick(WALL_SECTIONS) };
    const strikes = planStrikes(composition, (min, max) => draw.int(min, max));
    const approachSteps = draw.int(tuning.approachMin, tuning.approachMax);

    next.sequence += 1;
    const id = `W${String(next.sequence).padStart(4, "0")}`;
    const districtId = String(district.id);
    next.wave = {
        id,
        kind,
        compositionId: composition.id,
        label: composition.label,
        districtId,
        bearing,
        target,
        strikes,
        strike: 0,
        delivered: zeroCounts(),
        deliveredStrength: 0,
        approachSteps,
        stageSteps: 0,
        assaultSteps: 0,
        physical: false,
        distance: null,
        breached: false,
        startedStep: step,
        landedStep: null,
        outcome: null,
        endedStep: null,
    };
    next.phase = "scouting";
    next.nextEventStep = null;
    if (kind === "major") {
        next.lastMajorStep = step;
        next.majorSteps = [...next.majorSteps, step];
    }
    directives.push({ kind: "scout", districtId, waveId: id, bearing, label: composition.label, target: { ...target } });
}

/**
 * Flags the group as physical while a player is near its target. Records the change as an event.
 *
 * @param {InvasionState} wave
 * @param {Record<string, number | null> | undefined} proximity
 * @param {Record<string, any>} tuning
 * @param {string[]} events
 */
function refreshPhysical(wave, proximity, tuning, events) {
    const raw = proximity ? proximity[wave.districtId] : undefined;
    const distance = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
    const near = distance !== null && distance <= tuning.physicalRadius;
    wave.distance = distance;
    if (near !== wave.physical) {
        wave.physical = near;
        events.push(
            near
                ? `${String(wave.id)}: the group is ${String(distance)} blocks from a player and is flagged for physical representation.`
                : `${String(wave.id)}: no player is close enough; the group is numbers again.`,
        );
    }
}

/**
 * One step of the assault stage: deliver, or resolve the strike, or time out.
 *
 * @param {InvasionState} next
 * @param {Record<string, any>} district
 * @param {number} step
 * @param {Record<string, any>} tuning
 * @param {Record<string, number | null> | undefined} proximity
 * @param {any[]} directives
 * @param {string[]} events
 */
function runAssault(next, district, step, tuning, proximity, directives, events) {
    const wave = next.wave;
    wave.assaultSteps += 1;
    refreshPhysical(wave, proximity, tuning, events);

    if (district.security === "lost") {
        finishWave(next, step, "fallen", district, directives, events);
        return;
    }
    if (district.security === "breached") {
        wave.breached = true;
    }
    if (wave.assaultSteps > tuning.maxAssaultSteps) {
        finishWave(next, step, "timed out", district, directives, events);
        return;
    }

    const strike = wave.strikes[wave.strike];
    const pending = pendingOf(strike.counts, wave.delivered);
    const pendingUnits = unitsOf(pending);
    if (pendingUnits === 0) {
        if (toInt(district.assault) > 0) {
            return;
        }
        if (wave.strike + 1 < wave.strikes.length) {
            const spent = wave.strike + 1;
            wave.strike += 1;
            wave.delivered = zeroCounts();
            wave.approachSteps = tuning.regroupSteps;
            wave.stageSteps = 0;
            next.phase = "approach";
            events.push(
                `${String(wave.id)}: strike ${String(spent)} of ${String(wave.strikes.length)} is spent; the band regroups for strike ${String(wave.strike + 1)}.`,
            );
            return;
        }
        finishWave(next, step, "repelled", district, directives, events);
        return;
    }

    // Bounded landing: the per-district cap, the per-tick cap and the room left under the assault
    // cap all limit how much can land in one step. Whatever does not fit waits for a later step.
    const room = Math.max(0, INVASION_LIMITS.districtAssaultCap - toInt(district.assault));
    const budget = Math.min(INVASION_LIMITS.maxSpawnPerDistrictPerStep, INVASION_LIMITS.maxSpawnPerStep, room);
    const chunk = takeChunk(pending, budget);
    if (chunk.strength <= 0) {
        return;
    }
    directives.push({
        kind: "spawn",
        districtId: wave.districtId,
        waveId: wave.id,
        strikeIndex: wave.strike,
        counts: chunk.counts,
        strength: chunk.strength,
    });
    wave.delivered = addCounts(wave.delivered, chunk.counts);
    wave.deliveredStrength += chunk.strength;
    if (wave.landedStep === null) {
        wave.landedStep = step;
        events.push(`${String(wave.id)}: ${String(wave.label)} reaches the ${targetText(wave)} of ${String(district.name)}.`);
    }
}

/**
 * Advances the invasion already in progress by one stage step.
 *
 * @param {InvasionState} next
 * @param {Kingdom} kingdom
 * @param {number} step
 * @param {ReturnType<typeof makeStream>} draw
 * @param {Record<string, any>} tuning
 * @param {Record<string, number | null> | undefined} proximity
 * @param {any[]} directives
 * @param {string[]} events
 */
function advanceWave(next, kingdom, step, draw, tuning, proximity, directives, events) {
    const wave = next.wave;
    const district = districtById(kingdom, wave.districtId);
    const underway = next.phase === "scouting" || next.phase === "approach" || next.phase === "assault";
    if (underway && !district) {
        finishWave(next, step, "aborted", undefined, directives, events);
        return;
    }

    if (next.phase === "scouting") {
        wave.stageSteps += 1;
        if (wave.stageSteps >= tuning.scoutSteps) {
            next.phase = "approach";
            wave.stageSteps = 0;
            events.push(`${String(wave.id)}: the sighted host marches on ${String(district.name)} (${String(wave.approachSteps)} steps out).`);
        }
        return;
    }

    if (next.phase === "approach") {
        wave.stageSteps += 1;
        refreshPhysical(wave, proximity, tuning, events);
        if (wave.stageSteps < wave.approachSteps) {
            return;
        }
        next.phase = "assault";
        wave.stageSteps = 0;
        wave.assaultSteps = 0;
    }

    if (next.phase === "assault") {
        runAssault(next, district, step, tuning, proximity, directives, events);
        return;
    }

    if (next.phase === "aftermath") {
        wave.stageSteps += 1;
        if (wave.stageSteps >= tuning.aftermathSteps) {
            next.phase = "cooldown";
            wave.stageSteps = 0;
        }
        return;
    }

    if (next.phase === "cooldown") {
        wave.stageSteps += 1;
        if (wave.stageSteps >= tuning.cooldownSteps) {
            next.phase = "quiet";
            next.wave = null;
            next.nextEventStep = step + draw.int(tuning.raidGapMin, tuning.raidGapMax);
            events.push(`The field is quiet; the next activity is due at step ${String(next.nextEventStep)}.`);
        }
    }
}

/**
 * The planner. Pure: reads `kingdom`, reads and never writes `state` or `options`, and returns a
 * new state together with the directives to apply and the events to log.
 *
 * - A disabled record, or one that fails validation, is returned as the same object with no
 *   directives. A refused record says why in one event.
 * - `rng` is the uint32 cursor to draw from (normally `state.rngCursor`). The advanced cursor is
 *   returned in `state.rngCursor`.
 * - `options.proximity` maps a district id to the distance in blocks from the nearest player, or
 *   null when no player is within the loaded area. Missing entries count as far away.
 * - `options.tuning` overrides INVASION_DEFAULTS.
 *
 * @param {InvasionState} state
 * @param {Kingdom} kingdom
 * @param {number} rng
 * @param {{ proximity?: Record<string, number | null>, tuning?: Record<string, number> }} [options]
 * @returns {{ state: InvasionState, directives: any[], events: string[] }}
 */
export function nextDirectorState(state, kingdom, rng, options = {}) {
    if (!isInvasionEnabled(state)) {
        return { state, directives: [], events: [] };
    }
    const problems = validateInvasionState(state);
    if (problems.length > 0) {
        return { state, directives: [], events: [`Invasion director refused its saved state: ${String(problems[0])}.`] };
    }
    if (!isUint32(rng)) {
        throw new Error(`nextDirectorState: rng must be a uint32 cursor, got ${String(rng)}`);
    }

    const tuning = tuningOf(options);
    const proximity = options?.proximity ?? {};
    const step = toInt(kingdom.step);
    /** @type {InvasionState} */
    const next = JSON.parse(JSON.stringify(state));
    const draw = makeStream(rng);
    /** @type {any[]} */
    const directives = [];
    /** @type {string[]} */
    const events = [];

    if (next.phase === "quiet") {
        if (next.nextEventStep === null) {
            next.nextEventStep = step + draw.int(tuning.raidGapMin, tuning.raidGapMax);
        }
        if (step >= next.nextEventStep) {
            startInvasion(next, kingdom, step, draw, tuning, directives, events);
        }
    } else {
        advanceWave(next, kingdom, step, draw, tuning, proximity, directives, events);
    }

    next.rngCursor = draw.cursor();
    return { state: next, directives, events };
}

/**
 * Plans one step, applies it, and stores the new record. This is the one function the tick calls.
 * Returns everything it did, for tests and tooling.
 *
 * @param {Kingdom} kingdom
 * @param {{ proximity?: Record<string, number | null>, tuning?: Record<string, number> }} [options]
 * @returns {{ events: string[], directives: any[], results: any[] }}
 */
export function stepInvasion(kingdom, options = {}) {
    const state = kingdom?.invasion;
    if (!isInvasionEnabled(state)) {
        return { events: [], directives: [], results: [] };
    }
    const planned = nextDirectorState(state, kingdom, state.rngCursor, options);
    if (planned.state === state) {
        logEvents(kingdom, planned.events);
        return { events: planned.events, directives: [], results: [] };
    }

    const directorEvents = [...planned.events];
    const applied = applyDirectivesDetailed(kingdom, planned.directives);
    const next = planned.state;
    const refused = applied.results.find(
        (result) => !result.accepted && result.kind === "spawn" && next.wave !== null && result.waveId === next.wave.id,
    );
    if (refused) {
        // A landing the war cannot take must not leave the wave believing it landed.
        directorEvents.push(`${String(next.wave.id)}: the landing was refused (${refused.reason}).`);
        finishWave(next, toInt(kingdom.step), "aborted", districtById(kingdom, next.wave.districtId), [], directorEvents);
    }
    kingdom.invasion = next;
    logEvents(kingdom, directorEvents);
    return { events: [...directorEvents, ...applied.events], directives: planned.directives, results: applied.results };
}

/**
 * The single call the tick needs. Returns the events it produced, for the log.
 * Does nothing at all when `kingdom.invasion` is absent or disabled.
 *
 * @param {Kingdom} kingdom
 * @param {{ proximity?: Record<string, number | null>, tuning?: Record<string, number> }} [options]
 * @returns {string[]}
 */
export function runInvasionDirectorStep(kingdom, options = {}) {
    return stepInvasion(kingdom, options).events;
}
