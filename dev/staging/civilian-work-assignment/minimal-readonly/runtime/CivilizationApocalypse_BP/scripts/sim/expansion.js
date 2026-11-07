import { DISTRICT_DEFAULTS, EXPANSION_PROJECT_PLAN, POLICY_DEFAULTS, POLICY_MODES, PROJECT_TYPES, TERRITORY_STATES } from "../config.js";
import {
    districtById,
    findValidationProblems,
    makeDistrict,
    pushEvent,
    spend,
} from "../kingdom/state.js";
import { assignBuilders, scheduleProject } from "./construction.js";
import { syncGarrison } from "./population.js";
import { nextFloat } from "./rng.js";

/**
 * Balanced Automatic Expansion.
 *
 * Saved state only: no entity is spawned, no `@minecraft/server` import, no terrain is
 * touched. Claiming land creates a *district record* and hands the build queue to
 * `sim/construction.js`; whoever renders it in the world reads that queue.
 *
 * The pipeline a piece of land walks is exactly the territory schema:
 *   wild --(a victory outside our borders)--> raided --(military control, upkeep paid)--> military
 *        --(requirements met, settlers transferred)--> kingdom
 *
 * Nothing here duplicates people: settlers and soldiers are *moved* out of the adjacent
 * district into the new one, and reserves are moved too. Every mutation is checked with
 * `findValidationProblems()` and rolled back if the result would not validate.
 *
 * Step order owned by the tick: `runExpansionStep(kingdom)` once per simulation step
 * (it also drains outpost upkeep). The command layer calls `recordExternalVictory`,
 * `establishMilitaryControl` and `claimTerritory` directly; `evaluateExpansion` is the
 * pure read the UI shows before any of them commit.
 */

/** Tunables this module owns. config.js has no expansion section, so they live here. */
export const EXPANSION_RULES = {
    /** Security levels allowed to open new land. Never relaxed - not even under "rapid". */
    safeSecurity: ["secure"],
    /** Floor for the seeding district's defensiveIntegrity. Also never relaxed. */
    minDefensiveIntegrity: 60,
    /** Multiple of the first-stage plan cost that must still be in reserve. "rapid" relaxes only this. */
    surplusMargin: /** @type {Record<string, number>} */ ({ balanced: 1.25, rapid: 1 }),
    /** Upkeep per step for held military land, drained from the adjacent district's reserves. */
    upkeepPerStep: /** @type {Record<string, number>} */ ({ food: 2, materials: 1, supplies: 1 }),
    /** Consecutive steps of unpaid upkeep before control collapses and the land reverts to wild. */
    maxMissedUpkeep: 3,
    /** Survey gain per step, plus a seed-driven 0..surveyJitter bonus. */
    surveyPerStep: 1,
    surveyJitter: 6,
    /** Survey level a victory implies on top of the status change. */
    surveyPerVictory: 20,
    /** Bounded orchestration: entries touched per call, and claims per step. */
    maxTerritoriesPerStep: 4,
    maxClaimsPerStep: 1,
    /** Shares *transferred* (never duplicated) into the new district. */
    settlerFraction: 0.25,
    reserveFraction: 0.2,
    /** The new district must be able to start its own first stage; capacity is what makeDistrict gives (120). */
    minSettlers: 8,
    minCapacityHeadroom: 20,
};

/** The progress half of the path: only these states advance on a victory. */
const PROGRESSION = ["wild", "raided", "military"];

/**
 * @param {any} kingdom
 * @param {string} territoryId
 * @returns {any}
 */
function territoryById(kingdom, territoryId) {
    const lands = /** @type {any[]} */ (kingdom?.territory ?? []);
    return lands.find((land) => land && land.id === territoryId);
}

/**
 * @param {any} left
 * @param {any} right
 */
function byId(left, right) {
    const a = String(left?.id ?? "");
    const b = String(right?.id ?? "");
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}

/**
 * @param {number} value
 * @returns {number}
 */
function intOr0(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundTo1(value) {
    return Math.round(value * 10) / 10;
}

/**
 * @param {string[]} plan
 * @returns {Record<string, number>} the sum of stage 1 of every planned project
 */
function firstStagePlanCost(plan) {
    const catalogue = /** @type {Record<string, any>} */ (PROJECT_TYPES);
    /** @type {Record<string, number>} */
    const total = { food: 0, materials: 0, supplies: 0 };
    plan.forEach((kind) => {
        const definition = Object.prototype.hasOwnProperty.call(catalogue, kind) ? catalogue[kind] : undefined;
        if (definition === undefined) {
            return;
        }
        for (const [field, amount] of Object.entries(definition.cost)) {
            total[field] = roundTo1(Number(total[field] ?? 0) + Number(amount));
        }
    });
    return total;
}

/**
 * How many soldiers a district can post onto new land: the **front** element of its
 * garrison, i.e. the troops in the field. The reserve element stays home to hold the
 * district, which is why a district that has already given up a garrison cannot simply
 * feed a second outpost. (`POLICY_DEFAULTS.reinforcementKeepFraction` is the *war* rule
 * for moving troops between existing districts; expansion measures the field army above.)
 * @param {any} district
 * @returns {number}
 */
export function fieldArmy(district) {
    const front = Number(district?.garrison?.front);
    if (Number.isFinite(front)) {
        return Math.max(0, Math.floor(front));
    }
    return Math.floor(Number(district?.soldiers ?? 0) * Number(DISTRICT_DEFAULTS.frontGarrisonFraction));
}

/**
 * Pure verdict on whether a piece of land could be taken. Mutates nothing at all
 * (asserted in dev/test/expansion.test.mjs), so the command layer can show it safely.
 *
 * @param {any} kingdom
 * @param {string} territoryId
 * @returns {{ eligible: boolean, reasons: string[], required: Record<string, any>, available: Record<string, any> }}
 */
export function evaluateExpansion(kingdom, territoryId) {
    const policy = String(kingdom?.policy?.expansion ?? POLICY_DEFAULTS.expansion);
    const margin = Number(EXPANSION_RULES.surplusMargin[policy] ?? EXPANSION_RULES.surplusMargin.balanced);
    const planCost = firstStagePlanCost(/** @type {string[]} */ (EXPANSION_PROJECT_PLAN));
    /** @type {Record<string, any>} */
    const required = {
        policy,
        allowedPolicies: POLICY_MODES,
        security: [...EXPANSION_RULES.safeSecurity],
        minDefensiveIntegrity: EXPANSION_RULES.minDefensiveIntegrity,
        status: "military",
        garrison: 0,
        surplusMargin: margin,
        planCost,
        reserves: Object.fromEntries(
            Object.entries(planCost).map(([field, amount]) => [field, roundTo1(Number(amount) * margin)]),
        ),
    };
    /** @type {Record<string, any>} */
    const available = {
        policy,
        territoryId: String(territoryId),
        status: undefined,
        security: undefined,
        defensiveIntegrity: undefined,
        surplusSoldiers: 0,
        reserves: {},
        surveyProgress: 0,
    };
    /** @type {string[]} */
    const reasons = [];

    if (!POLICY_MODES.includes(policy)) {
        reasons.push(`unknown expansion policy '${policy}' - expected one of ${POLICY_MODES.join("/")}, refusing to act`);
    }

    const land = territoryById(kingdom, territoryId);
    if (land === undefined) {
        reasons.push(`territory '${String(territoryId)}' does not exist in this kingdom`);
        return { eligible: false, reasons, required, available };
    }
    available.status = land.status;
    available.surveyProgress = Number(land.surveyProgress ?? 0);
    required.garrison = intOr0(land.garrisonRequirement);

    if (policy === "paused") {
        reasons.push("expansion policy is 'paused' - no new land is taken until it is set back to balanced or rapid");
    }
    if (land.status === "kingdom") {
        reasons.push(`${String(land.name)} is already kingdom land`);
        return { eligible: false, reasons, required, available };
    }
    if (land.status !== "military") {
        reasons.push(
            `${String(land.name)} is '${String(land.status)}': it must be under military control first ` +
                `(wild -> raided needs a victory beyond the border, raided -> military needs establishMilitaryControl)`,
        );
    }

    const district = districtById(kingdom, String(land.adjacentDistrictId));
    if (district === undefined) {
        reasons.push(`territory ${String(land.name)} is adjacent to no known district`);
        return { eligible: false, reasons, required, available };
    }
    available.districtId = district.id;
    available.security = district.security;
    available.defensiveIntegrity = Number(district.defensiveIntegrity ?? 0);
    available.surplusSoldiers = fieldArmy(district);
    available.reserves = { ...district.reserves };

    // Defence-side checks: never relaxed, in any policy mode.
    if (!EXPANSION_RULES.safeSecurity.includes(String(district.security))) {
        reasons.push(
            `security of ${String(district.name)} is '${String(district.security)}'; only ` +
                `${EXPANSION_RULES.safeSecurity.join("/")} may seed new land (this check is never relaxed)`,
        );
    }
    if (!(Number(district.defensiveIntegrity ?? 0) >= Number(EXPANSION_RULES.minDefensiveIntegrity))) {
        reasons.push(
            `defensive integrity ${String(roundTo1(Number(district.defensiveIntegrity ?? 0)))} is below the floor ` +
                `of ${String(EXPANSION_RULES.minDefensiveIntegrity)} (this check is never relaxed)`,
        );
    }
    if (Number(available.surplusSoldiers) < Number(required.garrison)) {
        reasons.push(
            `garrison surplus ${String(available.surplusSoldiers)} is below the ${required.garrison} soldiers ` +
                `${String(land.name)} requires`,
        );
    }

    // Resource-side checks: "rapid" trades the margin, and only the margin, for speed.
    for (const [field, amount] of Object.entries(required.reserves)) {
        const have = Number(district.reserves?.[field] ?? 0);
        if (!(have >= Number(amount))) {
            reasons.push(
                `${String(district.name)} cannot cover the first stage of the plan: ${field} ${roundTo1(have)} < ` +
                    `${String(amount)} (${String(planCost[field])} x ${String(margin)} margin under '${policy}')`,
            );
        }
    }

    // Settlers must actually exist, and the new district must not open over capacity.
    const settlers = settlerCount(district);
    if (settlers < Number(EXPANSION_RULES.minSettlers)) {
        reasons.push(
            `only ${String(settlers)} settlers could be transferred out of ${String(district.name)}; ` +
                `at least ${String(EXPANSION_RULES.minSettlers)} are needed to staff new land`,
        );
    }
    if (EXPANSION_RULES.minCapacityHeadroom > 0) {
        const capacity = intOr0(district.civilianCapacity) - intOr0(district.civilians);
        if (capacity < Number(EXPANSION_RULES.minCapacityHeadroom)) {
            reasons.push(
                `${String(district.name)} is within ${String(capacity)} of its own capacity; new land needs ` +
                    `${String(EXPANSION_RULES.minCapacityHeadroom)} headroom`,
            );
        }
    }

    return { eligible: reasons.length === 0, reasons, required, available };
}

/**
 * @param {any} district
 * @returns {number} civilians that can be spared for a new settlement
 */
function settlerCount(district) {
    const pool = intOr0(district?.civilians) - intOr0(district?.builders);
    return Math.floor(Math.max(0, pool) * Number(EXPANSION_RULES.settlerFraction));
}

/**
 * A victory won outside our borders pushes a piece of land one stage along the
 * wild -> raided -> military path and stamps when it first opened.
 *
 * Policy does not gate history: the battle happened whether or not we intend to act on
 * it. `evaluateExpansion()` is where "paused" refuses to go any further.
 *
 * @param {any} kingdom
 * @param {string} territoryId
 * @param {{ atStep?: number }} [options]
 * @returns {{ ok: boolean, reason?: string, territory?: any, from?: string, to?: string }}
 */
export function recordExternalVictory(kingdom, territoryId, options = {}) {
    const land = territoryById(kingdom, territoryId);
    if (land === undefined) {
        return { ok: false, reason: `recordExternalVictory: territory '${String(territoryId)}' does not exist` };
    }
    if (String(land.status) === "kingdom") {
        return { ok: false, reason: `recordExternalVictory: ${String(land.name)} is already kingdom land` };
    }
    const from = String(land.status);
    const stage = PROGRESSION.indexOf(from);
    const to = PROGRESSION[Math.min(stage + 1, PROGRESSION.length - 1)];

    const atStep = options.atStep === undefined ? intOr0(kingdom?.step) : intOr0(options.atStep);
    const lands = /** @type {any[]} */ (kingdom.territory);
    const cursor = Number(kingdom?.rngState ?? 0) >>> 0;
    const draw = nextFloat(cursor);
    kingdom.rngState = draw.next;

    land.status = to;
    if (land.unlockedAtStep === null || land.unlockedAtStep === undefined) {
        land.unlockedAtStep = atStep;
    }
    const gain = Number(EXPANSION_RULES.surveyPerVictory) + Math.round(draw.value * Number(EXPANSION_RULES.surveyJitter));
    land.surveyProgress = clampProgress(Number(land.surveyProgress ?? 0) + gain);
    // The whole frontage learns from the fight: the other lands beside the same district
    // get half the survey credit, which is what makes the next target legible.
    lands.forEach((neighbour) => {
        if (neighbour === land || neighbour?.adjacentDistrictId !== land.adjacentDistrictId) {
            return;
        }
        neighbour.surveyProgress = clampProgress(Number(neighbour.surveyProgress ?? 0) + Math.round(gain / 2));
    });

    pushEvent(kingdom, `Victory beyond ${String(land.name)}: ${from} -> ${to} (survey ${String(land.surveyProgress)}%)`);
    return { ok: true, territory: land, from, to };
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampProgress(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return 0;
    }
    return Math.max(0, Math.min(100, Math.round(num)));
}

/**
 * Put a district's reserves under the standing cost of an occupied outpost.
 * @param {any} kingdom
 * @param {any} land
 * @param {any} district
 * @returns {{ paid: boolean, upkeep: Record<string, number>, missed: number }}
 */
function chargeUpkeep(kingdom, land, district) {
    const upkeep = /** @type {Record<string, number>} */ ({ ...EXPANSION_RULES.upkeepPerStep });
    const paid = spend(district?.reserves, upkeep);
    land.militarySteps = intOr0(land.militarySteps) + 1;
    land.upkeepMissedSteps = paid ? 0 : intOr0(land.upkeepMissedSteps) + 1;
    return { paid, upkeep, missed: intOr0(land.upkeepMissedSteps) };
}

/**
 * Take temporary military control of opened land and start paying for the garrison.
 *
 * @param {any} kingdom
 * @param {string} territoryId
 * @param {{ skipChecks?: boolean }} [options]
 * @returns {{ ok: boolean, reason?: string, territory?: any, paid?: boolean, upkeep?: Record<string, number> }}
 */
export function establishMilitaryControl(kingdom, territoryId, options = {}) {
    const land = territoryById(kingdom, territoryId);
    if (land === undefined) {
        return { ok: false, reason: `establishMilitaryControl: territory '${String(territoryId)}' does not exist` };
    }
    if (String(land.status) === "kingdom") {
        return { ok: false, reason: `establishMilitaryControl: ${String(land.name)} is already kingdom land` };
    }
    if (String(land.status) === "wild") {
        return {
            ok: false,
            reason:
                `establishMilitaryControl: ${String(land.name)} is still wild - a victory beyond the border ` +
                `must open it first (recordExternalVictory)`,
        };
    }
    const district = districtById(kingdom, String(land.adjacentDistrictId));
    if (district === undefined) {
        return {
            ok: false,
            reason: `establishMilitaryControl: ${String(land.name)} is adjacent to no known district`,
        };
    }
    if (options.skipChecks !== true && !EXPANSION_RULES.safeSecurity.includes(String(district.security))) {
        return {
            ok: false,
            reason:
                `establishMilitaryControl: ${String(district.name)} security is '${String(district.security)}'; ` +
                `only ${EXPANSION_RULES.safeSecurity.join("/")} can hold outposts`,
        };
    }

    const before = land.status;
    land.status = "military";
    land.militarySinceStep = intOr0(kingdom?.step);
    land.militarySteps = 0;
    land.upkeepMissedSteps = 0;
    if (land.unlockedAtStep === null || land.unlockedAtStep === undefined) {
        land.unlockedAtStep = intOr0(kingdom?.step);
    }
    const charge = chargeUpkeep(kingdom, land, district);
    pushEvent(
        kingdom,
        `Military control established over ${String(land.name)} (was ${String(before)}), upkeep ` +
            `${JSON.stringify(charge.upkeep)} per step from ${String(district.name)}` +
            `${charge.paid ? "" : " - first upkeep already short"}`,
    );
    return { ok: true, territory: land, paid: charge.paid, upkeep: charge.upkeep };
}

/**
 * Drain the upkeep of every held outpost. Control is temporary by design: after
 * `EXPANSION_RULES.maxMissedUpkeep` consecutive steps that the adjacent district cannot
 * pay, the garrison withdraws and the land is wild again (the failed-expansion path).
 *
 * @param {any} kingdom
 * @returns {string[]} event strings
 */
export function advanceMilitaryUpkeep(kingdom) {
    /** @type {string[]} */
    const events = [];
    const lands = /** @type {any[]} */ (kingdom?.territory ?? [])
        .filter((land) => String(land?.status) === "military")
        .sort(byId);

    for (const land of lands) {
        const district = districtById(kingdom, String(land.adjacentDistrictId));
        if (district === undefined) {
            events.push(`${String(land.name)} has no adjacent district to feed it - control lapses, the land is wild again`);
            revertToWild(land);
            continue;
        }
        const charge = chargeUpkeep(kingdom, land, district);
        if (charge.paid) {
            continue;
        }
        if (charge.missed >= Number(EXPANSION_RULES.maxMissedUpkeep)) {
            events.push(
                `Military control of ${String(land.name)} collapsed after ${String(charge.missed)} unpaid steps ` +
                    `of upkeep (${JSON.stringify(charge.upkeep)} per step from ${String(district.name)}) - ` +
                    `the land is wild again`,
            );
            revertToWild(land);
        } else {
            events.push(
                `${String(district.name)} cannot pay the outpost upkeep for ${String(land.name)} ` +
                    `(${String(charge.missed)}/${String(EXPANSION_RULES.maxMissedUpkeep)} unpaid steps)`,
            );
        }
    }
    events.forEach((event) => pushEvent(kingdom, event));
    return events;
}

/**
 * @param {any} land
 */
function revertToWild(land) {
    land.status = "wild";
    land.militarySinceStep = null;
    land.militarySteps = 0;
    land.upkeepMissedSteps = 0;
}

/**
 * @param {any} kingdom
 * @returns {string} an unused `district-N` id
 */
function nextDistrictId(kingdom) {
    const districts = /** @type {any[]} */ (kingdom?.districts ?? []);
    let highest = 0;
    districts.forEach((district) => {
        const match = /^district-(\d+)$/.exec(String(district?.id ?? ""));
        if (match !== null) {
            highest = Math.max(highest, Number(match[1]));
        }
    });
    let candidate = `district-${String(highest + 1)}`;
    const ids = new Set(districts.map((district) => String(district?.id)));
    let guard = 1;
    while (ids.has(candidate)) {
        candidate = `district-${String(highest + guard)}`;
        guard += 1;
    }
    return candidate;
}

/**
 * @param {any} district
 * @param {string} otherId
 */
function linkNeighbor(district, otherId) {
    if (!Array.isArray(district.neighbors)) {
        district.neighbors = [];
    }
    const neighbors = /** @type {string[]} */ (district.neighbors);
    if (otherId !== district.id && !neighbors.includes(otherId)) {
        neighbors.push(otherId);
    }
}

/**
 * @param {any} district
 * @param {string} otherId
 */
function linkGate(district, otherId) {
    if (!Array.isArray(district.gates)) {
        district.gates = [];
    }
    const gates = /** @type {any[]} */ (district.gates);
    if (!gates.some((gate) => gate?.with === otherId)) {
        gates.push({
            id: `gate-${String(district.id)}-${String(otherId)}`,
            with: otherId,
            owner: String(district.id),
            state: "open",
        });
    }
}

/**
 * Replace the whole kingdom content with a snapshot, keeping the object identity so any
 * caller holding `kingdom` sees the rollback. Only used when a mutation would not validate.
 * @param {any} kingdom
 * @param {string} snapshot
 */
function restoreKingdom(kingdom, snapshot) {
    /** @type {any} */
    const parsed = JSON.parse(snapshot);
    Object.keys(kingdom).forEach((key) => {
        delete kingdom[key];
    });
    for (const [key, value] of Object.entries(parsed)) {
        kingdom[key] = value;
    }
}

/**
 * Claim opened land for the kingdom once every requirement is met.
 *
 * The people are transferred, never duplicated: civilians and soldiers leave the adjacent
 * district and arrive in the new one, and so does a share of its stores. The new district
 * is linked into the neighbour graph on both sides, gets matching gate records whose
 * `owner` is correct on each side, and the standard `EXPANSION_PROJECT_PLAN` is scheduled
 * for `sim/construction.js` to build against real costs.
 *
 * Purity note for the adapter: this function touches the passed `kingdom` object and
 * nothing else - no world, no block, no entity.
 *
 * @param {any} kingdom
 * @param {string} territoryId
 * @param {{ plan?: string[], verdict?: { eligible: boolean, reasons: string[] } }} [options]
 * @returns {{ ok: boolean, reasons: string[], events: string[], district?: any, transferred?: Record<string, any> }}
 */
export function claimTerritory(kingdom, territoryId, options = {}) {
    /** @type {string[]} */
    const events = [];
    const verdict = options.verdict ?? evaluateExpansion(kingdom, territoryId);
    if (verdict.eligible !== true) {
        return {
            ok: false,
            reasons: [...verdict.reasons],
            events: [`Claim of '${String(territoryId)}' refused: ${verdict.reasons.join("; ")}`],
        };
    }
    const land = territoryById(kingdom, territoryId);
    const adjacent = districtById(kingdom, String(land?.adjacentDistrictId));
    if (land === undefined || adjacent === undefined) {
        return { ok: false, reasons: ["territory or its adjacent district disappeared"], events };
    }

    const plan = /** @type {string[]} */ (Array.isArray(options.plan) ? options.plan : EXPANSION_PROJECT_PLAN);
    const snapshot = JSON.stringify(kingdom);

    const settlers = Math.min(settlerCount(adjacent), intOr0(adjacent.civilians));
    const stationed = Math.min(intOr0(land.garrisonRequirement), fieldArmy(adjacent));
    if (settlers <= 0 || stationed <= 0) {
        return {
            ok: false,
            reasons: [`${String(adjacent.name)} has no people or soldiers left to transfer`],
            events,
        };
    }

    const id = nextDistrictId(kingdom);
    const index = /** @type {any[]} */ (kingdom.districts).length;
    // makeDistrict() builds the seat, capacity, buildings, reserves and garrison split
    // from the same defaults as every other district, and the gate back to the neighbour.
    const district = makeDistrict(id, String(land.name), settlers, stationed, [String(adjacent.id)], [String(adjacent.id)], index);

    /** @type {Record<string, number>} */
    const movedReserves = {};
    /** @type {Record<string, number>} */
    const newReserves = district.reserves;
    for (const [field, amount] of Object.entries(adjacent.reserves)) {
        const moved = roundTo1(Number(amount) * Number(EXPANSION_RULES.reserveFraction));
        movedReserves[field] = moved;
        adjacent.reserves[field] = roundTo1(Number(amount) - moved);
        newReserves[field] = moved;
    }

    adjacent.civilians = intOr0(adjacent.civilians) - settlers;
    adjacent.soldiers = intOr0(adjacent.soldiers) - stationed;
    syncGarrison(adjacent);

    linkNeighbor(adjacent, id);
    linkGate(adjacent, id);
    /** @type {any[]} */ (kingdom.districts).push(district);

    plan.forEach((kind) => {
        try {
            scheduleProject(district, kind, { atStep: intOr0(kingdom.step) });
        } catch (error) {
            throw new Error(`claimTerritory: cannot schedule '${kind}' on ${String(id)}: ${String(error)}`);
        }
    });
    const crew = assignBuilders(district, kingdom, { canWork: true });

    land.status = "kingdom";
    land.claimedAtStep = intOr0(kingdom.step);
    land.militarySinceStep = null;
    land.upkeepMissedSteps = 0;

    const problems = findValidationProblems(kingdom);
    if (problems.length > 0) {
        restoreKingdom(kingdom, snapshot);
        return {
            ok: false,
            reasons: [`claim rolled back, the result would not validate: ${problems.join("; ")}`],
            events,
        };
    }

    events.push(
        `Claimed ${String(land.name)} as ${String(id)}: ${String(settlers)} civilians and ${String(stationed)} ` +
        `soldiers transferred from ${String(adjacent.name)}, ${String(plan.length)} projects scheduled, ` +
        `${String(crew.assigned)} builders on site`,
    );
    events.forEach((event) => pushEvent(kingdom, event));
    return {
        ok: true,
        reasons: [],
        events,
        district,
        transferred: { civilians: settlers, soldiers: stationed, builders: crew.assigned, reserves: movedReserves },
    };
}

/**
 * One bounded expansion step.
 *
 * Order is stable and documented: outpost upkeep first (an existing commitment outranks
 * a new ambition), then survey the frontage with seeded draws, then at most
 * `maxClaimsPerStep` automatic claim of the first land that fully qualifies. Under
 * `policy.expansion === "paused"` nothing new is claimed; upkeep still drains, because a
 * paused kingdom does not get a free occupation.
 *
 * @param {any} kingdom
 * @param {{ plan?: string[] }} [options]
 * @returns {string[]} event strings
 */
export function runExpansionStep(kingdom, options = {}) {
    /** @type {string[]} every line this step produced, in order */
    const events = [];
    /** @type {string[]} only the lines this function owns; upkeep and claims log themselves */
    const own = [];

    events.push(...advanceMilitaryUpkeep(kingdom));

    const lands = /** @type {any[]} */ (kingdom?.territory ?? []).slice().sort(byId);
    const policy = String(kingdom?.policy?.expansion ?? POLICY_DEFAULTS.expansion);

    let cursor = Number(kingdom?.rngState ?? 0) >>> 0;
    let surveyed = 0;
    for (const land of lands) {
        if (surveyed >= Number(EXPANSION_RULES.maxTerritoriesPerStep)) {
            const line = `expansion survey reached its bound of ${String(EXPANSION_RULES.maxTerritoriesPerStep)} lands this step`;
            events.push(line);
            own.push(line);
            break;
        }
        if (String(land.status) === "kingdom") {
            // Already ours: it needs no survey, and it must not eat a survey slot forever.
            continue;
        }
        surveyed += 1;
        const draw = nextFloat(cursor);
        cursor = draw.next;
        const before = clampProgress(Number(land.surveyProgress ?? 0));
        const after = clampProgress(before + Number(EXPANSION_RULES.surveyPerStep)
            + Math.round(draw.value * Number(EXPANSION_RULES.surveyJitter)));
        land.surveyProgress = after;
        if (before < 100 && after >= 100) {
            const line = `Survey of ${String(land.name)} is complete - the way is open for a strike there`;
            events.push(line);
            own.push(line);
        }
    }
    kingdom.rngState = cursor;

    if (policy === "paused") {
        own.forEach((event) => pushEvent(kingdom, event));
        return events;
    }

    let claims = 0;
    for (const land of lands) {
        if (claims >= Number(EXPANSION_RULES.maxClaimsPerStep)) {
            break;
        }
        if (String(land.status) !== "military") {
            continue;
        }
        const verdict = evaluateExpansion(kingdom, String(land.id));
        if (verdict.eligible !== true) {
            continue;
        }
        claims += 1;
        const result = claimTerritory(kingdom, String(land.id), { plan: options.plan, verdict });
        events.push(...result.events);
        if (result.ok !== true) {
            // a refused/rolled-back claim is not logged by claimTerritory
            own.push(...result.events);
        }
    }

    own.forEach((event) => pushEvent(kingdom, event));
    return events;
}

/**
 * Read-only summary used by the report layer.
 * @param {any} kingdom
 * @returns {Array<Record<string, any>>}
 */
export function describeTerritories(kingdom) {
    const lands = /** @type {any[]} */ (kingdom?.territory ?? []).slice().sort(byId);
    return lands.map((land) => ({
        id: String(land.id),
        name: String(land.name),
        status: String(land.status),
        knownStatuses: TERRITORY_STATES,
        adjacentDistrictId: String(land.adjacentDistrictId ?? ""),
        surveyProgress: clampProgress(Number(land.surveyProgress ?? 0)),
        garrisonRequirement: intOr0(land.garrisonRequirement),
        unlockedAtStep: land.unlockedAtStep ?? null,
        claimedAtStep: land.claimedAtStep ?? null,
        upkeepMissedSteps: intOr0(land.upkeepMissedSteps),
    }));
}
