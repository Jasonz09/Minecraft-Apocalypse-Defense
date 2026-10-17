import { DISTRICT_DEFAULTS, POLICY_DEFAULTS, SECURITY_LEVELS } from "../config.js";
import { canAfford, districtById, pushBattle, pushEvent, spend } from "../kingdom/state.js";
import { nextChance, nextInt } from "./rng.js";

/**
 * The military side of the simulation: raiders press a district, the wall chips, the
 * garrison holds, neighbours reinforce without being stripped bare, and a district that
 * holds its ground recovers rung by rung.
 *
 * Pure saved-state arithmetic. Nothing here spawns an entity, reads the world, or imports
 * `@minecraft/server`: a district is "breached" only as recorded state, which is exactly
 * what makes the whole siege unit-testable offline.
 *
 * Per-step pipeline (sim/tick.js may call runWarStep, or these in this order):
 *   spawnThreats -> updateAlertState -> assignDefenders -> requestReinforcements
 *     -> resolveAssault -> counterattack -> recoverAfterDefense
 *
 * Two invariants hold after every exported function that touches a district:
 *   - `garrison.front + garrison.reserve === soldiers`, both non-negative integers
 *   - `defensiveIntegrity` stays inside 0..100
 * `kingdom.step` is owned by sim/tick.js; this module never advances it.
 *
 * @typedef {any} Kingdom
 * @typedef {any} District
 */

/* ------------------------------------------------------------------ *
 * Tunables. Every one of these is LOCAL to this module: config.js is owned by another
 * phase and may not be edited here, so anything the shipped config does not already
 * provide is defined below and called out in the implementation report.
 * ------------------------------------------------------------------ */

/** LOCAL: chance in one step that raiders press a given district. */
const ASSAULT_CHANCE = 0.08;
/** LOCAL: strength of a freshly landed raid band. */
const ASSAULT_MIN = 6;
const ASSAULT_MAX = 24;
/** LOCAL: no district faces more than this many raiders at one time - a hard bound that
 * keeps one district's assault from growing without limit across a long siege. */
const ASSAULT_CAP = 32;
/** LOCAL: integrity lost per unit of odds pressure, and the hardest a single step can hit. */
const INTEGRITY_PER_PRESSURE = 1.2;
const INTEGRITY_LOSS_CAP = 4;
/** LOCAL: share of the attacking band killed per battle step. */
const ATTACKER_LOSS_RATE = 0.18;
/** LOCAL: raiders barely bleed when nobody stands on the wall, but a party looting an
 * undefended district still loses at least one man a step, so an unopposed raid eventually
 * drifts off instead of parking there for a hundred steps. */
const RAIDERS_UNOPPOSED_FACTOR = 0.25;
const RAIDERS_UNOPPOSED_MINIMUM_LOSS = 1;
/** LOCAL: share of the front garrison lost per battle step, scaled by how badly outnumbered. */
const DEFENDER_LOSS_RATE = 0.04;
/** LOCAL: worst odds multiplier casualties are scaled by, so a hopeless fight is still finite. */
const MAX_PRESSURE_FOR_CASUALTIES = 4;
/** LOCAL: an integrity this low still counts as a wall worth defending, so a 0-integrity
 * district is never divided by zero, but never fights at full strength either. */
const MIN_EFFECTIVE_INTEGRITY = 5;
/** LOCAL: "defenders clearly exceed attackers" - the effective garrison must reach this
 * multiple of the assault before a district goes on the offensive. */
const COUNTERATTACK_RATIO = 1.5;
/** LOCAL: share of the defender strength the counterattack hurls at the raid band. */
const COUNTERATTACK_BROKEN_FRACTION = 0.6;
/** LOCAL: the wall is never credited below this when judging how many reinforcements a
 * district should ask for. Without it a level-zero wall would demand thirty times its own
 * assault from the neighbours, which is noise rather than a request. */
const MIN_DEMAND_INTEGRITY = 25;
/** LOCAL: attackers must outnumber the standing wall by this much for a district to be
 * merely `contested` rather than `alert`. */
const CONTESTED_RATIO = 1;
/** LOCAL: materials spent to restore one point of defensive integrity. */
const MATERIALS_PER_INTEGRITY = 0.5;
/** LOCAL: a wall crew always exists, even before sim/population.js assigns builders, so a
 * held district cannot deadlock at low integrity with zero builders. */
const MIN_REPAIR_CREW = 1;
/** LOCAL: fallback if a saved policy is missing the reinforcement keep fraction. */
const FALLBACK_KEEP_FRACTION = typeof POLICY_DEFAULTS.reinforcementKeepFraction === "number" ? POLICY_DEFAULTS.reinforcementKeepFraction : 0.5;
/** LOCAL: security levels that make a district call for help from its neighbours. */
const NEEDS_HELP_SECURITY = ["contested", "breached", "lost"];
/** LOCAL: the ladder a recovering district climbs, one rung per step, toward `secure`. */
const RECOVERY_LADDER = ["lost", "breached", "contested", "alert", "secure"];
/** LOCAL: hard ceiling on how many aid detachments one district can track. */
const MAX_AID_LEDGER_ENTRIES = 16;
/** LOCAL: marker for borrowed soldiers that arrived after the aid ledger filled up. They are
 * no district's property any more, so they stay where they are instead of being mislabelled. */
const UNTRACKED_AID_ID = "";

/** Danger order, taken straight from config so the two modules can never disagree. */
const SECURITY_RANK = SECURITY_LEVELS.reduce((/** @type {Record<string, number>} */ ranks, level, index) => {
    ranks[level] = index;
    return ranks;
}, {});

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOf(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Population and soldier counts must stay non-negative integers, because the save
 * validator refuses anything else. Fractions are floored, never rounded up, so this
 * module can only ever lose a soldier it actually had.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toInt(value) {
    const raw = numberOf(value, 0);
    const floored = Math.floor(raw);
    return floored < 0 ? 0 : floored;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
    if (!(value > min)) {
        return min;
    }
    return value > max ? max : value;
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundTo1(value) {
    return Math.round(value * 10) / 10;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCursor(value) {
    return toInt(value) >>> 0;
}

/**
 * @param {Kingdom} kingdom
 * @returns {District[]}
 */
function districtList(kingdom) {
    return /** @type {District[]} */ (Array.isArray(kingdom?.districts) ? kingdom.districts : []);
}

/**
 * Stable iteration order: lexicographic by id, so a seed replays identically no matter how
 * the districts array happened to be stored.
 *
 * @param {Kingdom} kingdom
 * @returns {District[]}
 */
function sortedDistricts(kingdom) {
    return districtList(kingdom)
        .slice()
        .sort((left, right) => {
            const a = String(left?.id ?? "");
            const b = String(right?.id ?? "");
            return a < b ? -1 : a > b ? 1 : 0;
        });
}

/**
 * @param {Kingdom} kingdom
 * @param {string} text
 * @returns {string}
 */
function logEvent(kingdom, text) {
    if (!Array.isArray(kingdom.log)) {
        kingdom.log = [];
    }
    pushEvent(kingdom, text);
    return text;
}

/**
 * @param {Kingdom} kingdom
 * @param {any} battle
 */
function recordBattle(kingdom, battle) {
    if (!Array.isArray(kingdom.battles)) {
        kingdom.battles = [];
    }
    pushBattle(kingdom, battle);
}

/**
 * @param {District} district
 * @returns {number}
 */
function integrityOf(district) {
    return clamp(numberOf(district.defensiveIntegrity, 100), 0, 100);
}

/**
 * @param {Kingdom} kingdom
 * @returns {number}
 */
function keepFraction(kingdom) {
    const value = numberOf(kingdom?.policy?.reinforcementKeepFraction, FALLBACK_KEEP_FRACTION);
    return clamp(value, 0, 1);
}

/* ------------------------------------------------------------------ *
 * Garrison
 * ------------------------------------------------------------------ */

/**
 * Gradual fallback. When the line is actually collapsing, troops give ground *inside* the
 * district - they come off the wall and hold a fallback position - and they walk back to it
 * once the attack is beaten. This is deliberately not abandonment: at least one soldier
 * stays on the wall while the district has any, the population does not move (that is
 * evacuation's job), and the district record is untouched.
 */
export const FALLBACK_RULES = {
    /** Attackers must at least match the defenders before ground is given up. */
    overwhelmedRatio: 1,
    withdrawStep: 0.2,
    recoverStep: 0.1,
    maxPullback: 0.6,
    minWallKeep: 1,
};

/**
 * @param {any} district
 * @returns {number} 0..maxPullback share of the front line held back
 */
export function fallbackPullback(district) {
    return clamp(numberOf(district?.fallback?.pullback, 0), 0, Number(FALLBACK_RULES.maxPullback));
}

/**
 * Advances one district's fallback state. Called once per district per step from
 * runWarStep, before assignDefenders rebuilds the split from it.
 *
 * @param {any} kingdom
 * @param {any} district
 * @returns {string[]}
 */
export function updateFallback(kingdom, district) {
    if (!district || typeof district !== "object" || toInt(district.soldiers) <= 0) {
        return [];
    }
    const assault = Math.max(0, numberOf(district.assault, 0));
    const strength = defensiveStrength(district);
    const pullback = fallbackPullback(district);
    const overwhelmed = assault >= strength * Number(FALLBACK_RULES.overwhelmedRatio) && strength > 0;
    const next = overwhelmed
        ? clamp(pullback + Number(FALLBACK_RULES.withdrawStep), 0, Number(FALLBACK_RULES.maxPullback))
        : clamp(pullback - Number(FALLBACK_RULES.recoverStep), 0, Number(FALLBACK_RULES.maxPullback));

    if (next === pullback) {
        return [];
    }

    district.fallback = {
        pullback: Math.round(next * 100) / 100,
        position: next <= 0 ? "holding the wall" : next >= Number(FALLBACK_RULES.maxPullback) ? "contracted to the last fallback" : "in fallback positions",
        sinceStep: numberOf(kingdom?.step, 0),
    };
    return [
        overwhelmed
            ? `${String(district.name)}: the line is breaking - ${String(Math.round(next * 100))}% of the garrison falls back off the wall (the district is not abandoned).`
            : `${String(district.name)}: the attack has spent itself - the garrison closes back toward the wall (${String(Math.round(next * 100))}% held in depth).`,
    ];
}

/**
 * Automatic defensive assignment. Everything except a standing reserve holds the wall,
 * less whatever the fallback state is holding back. Re-runs cheaply and idempotently, and
 * is the single place that rebuilds the split, so every function that changes `soldiers`
 * calls it in the same step and the save validator can never see `front + reserve !== soldiers`.
 *
 * @param {District} district
 * @returns {{ front: number, reserve: number, soldiers: number }}
 */
export function assignDefenders(district) {
    if (!district || typeof district !== "object") {
        return { front: 0, reserve: 0, soldiers: 0 };
    }
    const fraction = clamp(numberOf(DISTRICT_DEFAULTS.frontGarrisonFraction, 0.8), 0, 1);
    const soldiers = toInt(district.soldiers);
    district.soldiers = soldiers;
    let front = Math.floor(soldiers * fraction * (1 - fallbackPullback(district)));
    if (fallbackPullback(district) > 0 && soldiers > 0 && front < Number(FALLBACK_RULES.minWallKeep)) {
        // Only a district that is actually giving ground keeps a man on the wall; the
        // ordinary split is left exactly as it was.
        front = Number(FALLBACK_RULES.minWallKeep);
    }
    const reserve = soldiers - front;
    if (!district.garrison || typeof district.garrison !== "object") {
        district.garrison = { front: 0, reserve: 0 };
    }
    district.garrison.front = front;
    district.garrison.reserve = reserve;
    return { front, reserve, soldiers };
}

/**
 * How hard a district actually hits: the front garrison, scaled by whatever is left of the
 * wall it is standing on.
 *
 * @param {District} district
 * @returns {number}
 */
export function defensiveStrength(district) {
    const garrison = assignDefenders(district);
    const factor = clamp(integrityOf(district), MIN_EFFECTIVE_INTEGRITY, 100) / 100;
    return garrison.front * factor;
}

/**
 * A district with nobody standing and no wall left cannot hold itself.
 * @param {District} district
 */
export function hasAbleDefenders(district) {
    const garrison = assignDefenders(district);
    return garrison.front > 0 && integrityOf(district) > 0;
}

/* ------------------------------------------------------------------ *
 * Threats and alert state
 * ------------------------------------------------------------------ */

/**
 * Decide, from `kingdom.rngState`, whether raiders press each district this step. Draws are
 * made in stable id order and the advanced cursor is always written back, so the same seed
 * replays the same war. Assault is a strength number and stacks with a band already on the
 * ground, up to ASSAULT_CAP; nothing is spawned. A district already recorded `lost` is not
 * raided again - there is nothing left to press - which is what lets it climb back.
 *
 * @param {Kingdom} kingdom
 * @returns {string[]} event descriptions
 */
export function spawnThreats(kingdom) {
    const /** @type {string[]} */ events = [];
    const districts = sortedDistricts(kingdom);
    let cursor = toCursor(kingdom.rngState);

    for (const district of districts) {
        if (district.security === "lost") {
            continue;
        }
        const press = nextChance(cursor, ASSAULT_CHANCE);
        cursor = press.next;
        if (!press.value) {
            continue;
        }
        const band = nextInt(cursor, ASSAULT_MIN, ASSAULT_MAX);
        cursor = band.next;
        const before = toInt(district.assault);
        district.assault = Math.min(ASSAULT_CAP, before + band.value);
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: ${String(band.value)} raiders press the district (assault ${String(district.assault)}).`,
            ),
        );
    }

    kingdom.rngState = cursor >>> 0;
    return events;
}

/**
 * The level the evidence on the district right now argues for. Escalation only - this never
 * calms a district down, that is recoverAfterDefense's job.
 *
 * @param {District} district
 * @param {number} breachIntegrity
 * @returns {string}
 */
function assessSecurity(district, breachIntegrity) {
    const assault = toInt(district.assault);
    const integrity = integrityOf(district);
    const able = hasAbleDefenders(district);

    if (assault <= 0) {
        return integrity < breachIntegrity ? "alert" : "secure";
    }
    if (integrity < breachIntegrity || !able) {
        return "breached";
    }
    const standing = defensiveStrength(district);
    if (assault >= standing * CONTESTED_RATIO) {
        return "contested";
    }
    return "alert";
}

/**
 * Derive `security` for every district from assault size, `defensiveIntegrity` versus
 * `POLICY_DEFAULTS.breachIntegrity`, and the siege counter: a district that has sat breached
 * with nobody able to hold the wall for `POLICY_DEFAULTS.fallAfterSiegeSteps` steps is
 * recorded `lost`. `isolated` belongs to the evacuation module and `lost` is terminal for this
 * pass, so neither is overwritten here.
 *
 * @param {Kingdom} kingdom
 * @returns {string[]} event descriptions
 */
export function updateAlertState(kingdom) {
    const /** @type {string[]} */ events = [];
    const breachIntegrity = clamp(numberOf(kingdom?.policy?.breachIntegrity, POLICY_DEFAULTS.breachIntegrity), 0, 100);
    const fallAfter = Math.max(1, toInt(kingdom?.policy?.fallAfterSiegeSteps ?? POLICY_DEFAULTS.fallAfterSiegeSteps));

    for (const district of sortedDistricts(kingdom)) {
        district.defensiveIntegrity = integrityOf(district);
        if (district.security === "isolated" || district.security === "lost") {
            continue;
        }
        let assessed = assessSecurity(district, breachIntegrity);
        // The siege counter is what turns a breach into a fall, and it takes the whole
        // consecutive length with nobody able to defend - never a single bad step.
        if (assessed === "breached" && !hasAbleDefenders(district) && toInt(district.siegeSteps) >= fallAfter) {
            assessed = "lost";
        }
        const currentRank = numberOf(SECURITY_RANK[ /** @type {string} */ (district.security)], 0);
        const assessedRank = numberOf(SECURITY_RANK[assessed], 0);
        if (assessedRank > currentRank) {
            district.security = assessed;
            events.push(
                logEvent(
                    kingdom,
                    assessed === "lost"
                        ? `${String(district.name)}: ${String(toInt(district.siegeSteps))} breached steps with no able defenders - the district has fallen. Its ${String(
                            toInt(district.civilians),
                        )} civilians and ${String(toInt(district.soldiers))} soldiers stay on the record.`
                        : `${String(district.name)}: watch raised ${String(SECURITY_LEVELS[currentRank] ?? "secure")} -> ${assessed} (assault ${String(
                            toInt(district.assault),
                        )}, integrity ${String(Math.round(district.defensiveIntegrity))}).`,
                ),
            );
        }
    }
    return events;
}

/* ------------------------------------------------------------------ *
 * Reinforcements
 * ------------------------------------------------------------------ */

/**
 * How many extra front-rank soldiers a district needs to be decisively stronger than the
 * band attacking it. Same arithmetic counterattack() judges, so a district only asks for
 * help it can actually turn into an offensive.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {number}
 */
export function reinforcementDemand(kingdom, district) {
    const assault = toInt(district.assault);
    if (assault <= 0) {
        return 0;
    }
    const factor = clamp(integrityOf(district), MIN_DEMAND_INTEGRITY, 100) / 100;
    const neededFront = Math.ceil((assault * COUNTERATTACK_RATIO) / factor);
    const fraction = clamp(numberOf(DISTRICT_DEFAULTS.frontGarrisonFraction, 0.8), 0.05, 1);
    const garrison = assignDefenders(district);
    // Ask for whole soldiers, not front seats: whatever arrives is re-split, so the district
    // needs enough bodies that its *new* front rank reaches neededFront.
    const neededSoldiers = Math.ceil(neededFront / fraction);
    return Math.max(0, neededSoldiers - garrison.soldiers);
}

/**
 * How many of a district's own soldiers are currently standing somewhere else. Read back
 * from the aid ledgers of the whole kingdom - bounded by districts x ledger entries, no
 * recursion - so a neighbour's strength is judged as if its detachments were home. Without
 * this, two requests in a row could each take "half of what is left" and empty the district.
 *
 * @param {Kingdom} kingdom
 * @param {string} donorId
 * @returns {number}
 */
function soldiersAwayFrom(kingdom, donorId) {
    let away = 0;
    for (const other of districtList(kingdom)) {
        const ledger = Array.isArray(other?.reinforcedBy) ? /** @type {any[]} */ (other.reinforcedBy) : [];
        for (const entry of ledger) {
            if (entry?.from === donorId) {
                away += toInt(entry.soldiers);
            }
        }
    }
    return away;
}

/**
 * The most a donor may march out. Both readings of `reinforcementKeepFraction` are enforced
 * against the donor's *home strength* (what it would hold if every detachment came back):
 * it may not send more than that share of its soldiers and may not keep less than that share.
 * On top of that, only the front rank marches, so the home reserve is never spent.
 *
 * @param {Kingdom} kingdom
 * @param {District} donor
 * @param {number} fraction
 * @returns {{ cap: number, soldiers: number, homeStrength: number, away: number, reserveFloor: number }}
 */
function maxSendableFrom(kingdom, donor, fraction) {
    const garrison = assignDefenders(donor);
    const away = soldiersAwayFrom(kingdom, donor.id);
    const homeStrength = garrison.soldiers + away;
    const sendCeiling = Math.floor(homeStrength * fraction);
    const keepFloor = homeStrength - Math.ceil(homeStrength * fraction);
    const cap = Math.max(0, Math.min(sendCeiling, keepFloor, garrison.front) - away);
    return { cap, soldiers: garrison.soldiers, homeStrength, away, reserveFloor: garrison.reserve };
}

/**
 * Neighbours march soldiers to a district in trouble. Soldiers are *moved*: every soldier
 * subtracted from a donor is added to the recipient, the garrison split of both districts is
 * rebuilt in the same step, and no donor is ever taken below the policy keep fraction or
 * stripped of its reserve. A donor already fighting its own battle sends nothing.
 *
 * The result says exactly what moved and, when less than `needed` arrived, why.
 *
 * @param {Kingdom} kingdom
 * @param {string} districtId
 * @param {number} needed
 * @returns {{ districtId: string, requested: number, sent: number, deficit: number,
 *   contributions: { donor: string, recipient: string, soldiers: number, limit: number, capped: boolean, reason: string }[],
 *   declined: { donor: string, reason: string }[], events: string[] }}
 */
export function requestReinforcements(kingdom, districtId, needed) {
    const district = districtById(kingdom, districtId);
    /** @type {ReturnType<typeof requestReinforcements>["contributions"]} */
    const contributions = [];
    /** @type {ReturnType<typeof requestReinforcements>["declined"]} */
    const declined = [];
    const /** @type {string[]} */ events = [];
    const want = Math.max(0, toInt(needed));
    const report = {
        districtId: String(districtId),
        requested: want,
        sent: 0,
        deficit: want,
        contributions,
        declined,
        events,
    };

    if (!district) {
        events.push(logEvent(kingdom, `Reinforcements for ${String(districtId)}: no such district, nothing moved.`));
        return report;
    }
    if (want === 0) {
        return report;
    }

    const fraction = keepFraction(kingdom);
    const neighbours = Array.isArray(district.neighbors) ? /** @type {string[]} */ (district.neighbors) : [];
    if (neighbours.length === 0) {
        report.deficit = want;
        events.push(logEvent(kingdom, `${String(district.name)}: no neighbouring district exists to send reinforcements.`));
        return report;
    }

    let remaining = want;
    const donorIds = districtList(kingdom)
        .filter((candidate) => candidate && neighbours.includes(candidate.id) && candidate.id !== district.id)
        .map((candidate) => String(candidate.id))
        .sort();

    for (const donorId of donorIds) {
        if (remaining <= 0) {
            break;
        }
        const donor = districtById(kingdom, donorId);
        if (!donor) {
            declined.push({ donor: donorId, reason: "not part of the kingdom" });
            continue;
        }
        if (toInt(donor.assault) > 0 || donor.security === "breached" || donor.security === "contested") {
            donor.soldiers = toInt(donor.soldiers);
            assignDefenders(donor);
            declined.push({ donor: donorId, reason: `holds its own line (assault ${String(toInt(donor.assault))}, ${String(donor.security)})` });
            continue;
        }

        const limit = maxSendableFrom(kingdom, donor, fraction);
        const gift = Math.min(remaining, limit.cap);
        if (gift <= 0) {
            donor.soldiers = toInt(donor.soldiers);
            assignDefenders(donor);
            declined.push({
                donor: donorId,
                reason:
                    limit.away > 0
                        ? `already has ${String(limit.away)} soldiers away from a home strength of ${String(limit.homeStrength)}`
                        : `can spare nothing from ${String(limit.soldiers)} soldiers at the ${String(Math.round(fraction * 100))}% keep fraction`,
            });
            continue;
        }

        donor.soldiers = toInt(donor.soldiers) - gift;
        assignDefenders(donor);
        district.soldiers = toInt(district.soldiers) + gift;
        assignDefenders(district);

        const ledger = aidLedger(district);
        const existing = ledger.find((entry) => entry.from === donor.id);
        if (existing) {
            existing.soldiers = toInt(existing.soldiers) + gift;
        } else if (ledger.length < MAX_AID_LEDGER_ENTRIES) {
            ledger.push({ from: String(donor.id), soldiers: gift });
        } else {
            // The ledger is capped only to keep the release loop bounded. Men beyond the cap
            // are parked in an unattributed bucket instead of being written onto some other
            // donor's entry: they stay with the district that holds them and are never
            // marched to a home we cannot name.
            const untracked = ledger.find((entry) => entry.from === UNTRACKED_AID_ID);
            if (untracked) {
                untracked.soldiers = toInt(untracked.soldiers) + gift;
            } else {
                ledger.push({ from: UNTRACKED_AID_ID, soldiers: gift });
            }
        }

        remaining -= gift;
        report.sent += gift;
        contributions.push({
            donor: String(donor.id),
            recipient: String(district.id),
            soldiers: gift,
            limit: limit.cap,
            capped: gift >= limit.cap,
            reason:
                gift >= limit.cap
                    ? `${String(donor.name)} sent everything it may: ${String(limit.homeStrength - gift - limit.away)} stay home out of a home strength of ${String(limit.homeStrength)}`
                    : `${String(donor.name)} sent the whole request`,
        });
        events.push(
            logEvent(
                kingdom,
                `${String(donor.name)} sends ${String(gift)} soldiers to ${String(district.name)} (${String(limit.soldiers - gift)} kept home).`,
            ),
        );
    }

    report.deficit = Math.max(0, remaining);
    if (report.deficit > 0) {
        const why = declined.map((entry) => `${String(entry.donor)}: ${String(entry.reason)}`).join("; ");
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: reinforcements short by ${String(report.deficit)} of ${String(want)} requested${why ? ` (${why})` : " (no neighbour could spare more)"}.`,
            ),
        );
    }
    return report;
}

/**
 * The list of detachments standing on this district that belong somewhere else. An extra
 * district field, never validated by the save validator and never read by other modules, so
 * borrowed soldiers can always be marched home.
 *
 * @param {District} district
 * @returns {{ from: string, soldiers: number }[]}
 */
function aidLedger(district) {
    if (!Array.isArray(district.reinforcedBy)) {
        district.reinforcedBy = [];
    }
    return /** @type {{ from: string, soldiers: number }[]} */ (district.reinforcedBy);
}

/**
 * March every borrowed soldier back to its own district. Used when a district holds, so a
 * neighbour is never left garrisoned by an absent host. A detachment that took casualties
 * defending someone else's walls comes home with the men it still has - never more, which
 * would invent soldiers, and never less than the district can actually spare.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {string[]} event descriptions
 */
function releaseReinforcements(kingdom, district) {
    const /** @type {string[]} */ events = [];
    const ledger = aidLedger(district);
    if (ledger.length === 0) {
        return events;
    }

    const /** @type {typeof ledger} */ keep = [];
    for (const entry of ledger.slice()) {
        const owed = toInt(entry.soldiers);
        const home = districtById(kingdom, entry.from);
        if (owed <= 0) {
            continue;
        }
        if (!home) {
            // The donor district is gone from the record; the men stay where they are and the
            // entry is kept so nothing is silently conjured or dropped.
            keep.push(entry);
            continue;
        }

        const returning = Math.min(owed, toInt(district.soldiers));
        if (returning > 0) {
            district.soldiers = toInt(district.soldiers) - returning;
            assignDefenders(district);
            home.soldiers = toInt(home.soldiers) + returning;
            assignDefenders(home);
            events.push(
                logEvent(
                    kingdom,
                    `${String(returning)} reinforcements march home from ${String(district.name)} to ${String(home.name)}${
                        returning < owed ? ` (${String(owed - returning)} did not survive the loan)` : ""
                    }.`,
                ),
            );
        }
    }
    district.reinforcedBy = keep;
    return events;
}

/* ------------------------------------------------------------------ *
 * Combat
 * ------------------------------------------------------------------ */

/**
 * One battle step at one district. Effective defending strength (front garrison scaled by
 * whatever wall is left) is weighed against the assault: the wall chips, both sides lose
 * people, and the fight is written to the battle log.
 *
 * A breached wall is not a defeat. The district keeps its population, its owner and its
 * record; `security` may read `breached`, and `lost` only arrives after
 * `POLICY_DEFAULTS.fallAfterSiegeSteps` consecutive breached steps with no able defenders.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {string[]} event descriptions
 */
export function resolveAssault(kingdom, district) {
    const /** @type {string[]} */ events = [];
    const assault = toInt(district.assault);
    if (assault <= 0) {
        return events;
    }

    const garrison = assignDefenders(district);
    const integrityBefore = integrityOf(district);
    district.defensiveIntegrity = integrityBefore;
    const standing = defensiveStrength(district);
    const odds = assault / Math.max(1, standing);
    const breachIntegrity = clamp(numberOf(kingdom?.policy?.breachIntegrity, POLICY_DEFAULTS.breachIntegrity), 0, 100);

    const integrityLoss = roundTo1(Math.min(INTEGRITY_LOSS_CAP, Math.max(standing > 0 ? 0.5 : 1, odds * INTEGRITY_PER_PRESSURE)));
    const unopposed = standing <= 0;
    const rawAttackerLosses = assault * ATTACKER_LOSS_RATE * (unopposed ? RAIDERS_UNOPPOSED_FACTOR : 1);
    const attackerLosses = clamp(
        unopposed ? Math.max(RAIDERS_UNOPPOSED_MINIMUM_LOSS, Math.round(rawAttackerLosses)) : Math.round(rawAttackerLosses),
        0,
        assault,
    );
    const defenderLosses =
        standing > 0
            ? clamp(Math.round(garrison.front * DEFENDER_LOSS_RATE * Math.min(MAX_PRESSURE_FOR_CASUALTIES, Math.max(0.5, odds))), 0, garrison.soldiers)
            : 0;

    district.assault = assault - attackerLosses;
    district.soldiers = garrison.soldiers - defenderLosses;
    assignDefenders(district);
    district.defensiveIntegrity = clamp(roundTo1(integrityBefore - integrityLoss), 0, 100);

    const able = hasAbleDefenders(district);
    const assessed = assessSecurity(district, breachIntegrity);
    if (district.security === "lost") {
        // The siege is already over: hold the counter where it is so recovery can start
        // from a known number once the raid band moves on.
        district.siegeSteps = toInt(district.siegeSteps);
    } else if (assessed === "breached" && !able) {
        district.siegeSteps = toInt(district.siegeSteps) + 1;
    } else if (assessed !== "breached") {
        district.siegeSteps = 0;
    }

    if (district.security !== "isolated" && district.security !== "lost") {
        const currentRank = numberOf(SECURITY_RANK[/** @type {string} */ (district.security)], 0);
        const assessedRank = numberOf(SECURITY_RANK[assessed], 0);
        if (assessedRank > currentRank) {
            district.security = assessed;
        }
    }

    recordBattle(kingdom, {
        atStep: toInt(kingdom.step),
        districtId: String(district.id),
        districtName: String(district.name),
        assault,
        standing: roundTo1(standing),
        integrityBefore: integrityBefore,
        integrityAfter: district.defensiveIntegrity,
        integrityLoss,
        attackerLosses,
        defenderLosses,
        outcome: district.security === "breached" ? "wall breached" : standing > 0 ? "held" : "undefended",
    });

    events.push(
        logEvent(
            kingdom,
            `${String(district.name)}: assault ${String(assault)} against ${String(Math.round(standing))} effective defenders - wall ${String(
                Math.round(integrityBefore),
            )} -> ${String(Math.round(district.defensiveIntegrity))}, ${String(attackerLosses)} raiders and ${String(defenderLosses)} of our soldiers lost.`,
        ),
    );

    const fallAfter = Math.max(1, toInt(kingdom?.policy?.fallAfterSiegeSteps ?? POLICY_DEFAULTS.fallAfterSiegeSteps));
    if (
        district.security !== "lost" &&
        !hasAbleDefenders(district) &&
        district.defensiveIntegrity < breachIntegrity &&
        toInt(district.siegeSteps) >= fallAfter
    ) {
        district.security = "lost";
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: ${String(toInt(district.siegeSteps))} breached steps with no able defenders - the district has fallen. Its ${String(
                    toInt(district.civilians),
                )} civilians and ${String(toInt(district.soldiers))} soldiers stay on the record.`,
            ),
        );
    }

    return events;
}

/**
 * A district whose defenders plainly outnumber the raid band goes on the offensive: the
 * band is broken up and, once the assault is gone, recovery can start. Counterattacking
 * costs soldiers too, and never more than the district has.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {string[]} event descriptions
 */
export function counterattack(kingdom, district) {
    const /** @type {string[]} */ events = [];
    const assault = toInt(district.assault);
    if (assault <= 0) {
        return events;
    }
    const standing = defensiveStrength(district);
    if (standing < assault * COUNTERATTACK_RATIO) {
        return events;
    }

    const garrison = assignDefenders(district);
    const broken = clamp(Math.round(standing * COUNTERATTACK_BROKEN_FRACTION), 1, assault);
    const losses = clamp(Math.round(garrison.front * DEFENDER_LOSS_RATE * 0.5), 0, garrison.soldiers);

    district.assault = assault - broken;
    district.soldiers = garrison.soldiers - losses;
    assignDefenders(district);
    if (toInt(district.assault) === 0) {
        district.siegeSteps = 0;
    }

    recordBattle(kingdom, {
        atStep: toInt(kingdom.step),
        districtId: String(district.id),
        districtName: String(district.name),
        assault,
        standing: roundTo1(standing),
        integrityBefore: integrityOf(district),
        integrityAfter: integrityOf(district),
        integrityLoss: 0,
        attackerLosses: broken,
        defenderLosses: losses,
        outcome: district.assault === 0 ? "counterattack: raid broken" : "counterattack: raid pushed back",
    });

    events.push(
        logEvent(
            kingdom,
            `${String(district.name)}: ${String(Math.round(standing))} defenders counterattack ${String(assault)} raiders, breaking ${String(
                broken,
            )} of them (${String(toInt(district.assault))} remain, ${String(losses)} lost) - the district goes on the offensive.`,
        ),
    );
    return events;
}

/**
 * What happens once a district is no longer being pressed:
 *   - borrowed soldiers march home to their own districts
 *   - the wall is repaired at `DISTRICT_DEFAULTS.integrityRepairPerStep`, paid for out of
 *     `reserves.materials` through canAfford()/spend(); a district with no materials repairs
 *     nothing and says so
 *   - the siege counter is cleared
 *   - `security` steps one rung down the ladder toward `secure`, and only leaves `breached`
 *     once the wall is back above `POLICY_DEFAULTS.breachIntegrity`
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {string[]} event descriptions
 */
export function recoverAfterDefense(kingdom, district) {
    const /** @type {string[]} */ events = [];
    if (toInt(district.assault) > 0) {
        return events;
    }

    events.push(...releaseReinforcements(kingdom, district));

    assignDefenders(district);
    const integrity = integrityOf(district);
    district.defensiveIntegrity = integrity;
    if (!district.reserves || typeof district.reserves !== "object") {
        district.reserves = { food: 0, materials: 0, supplies: 0 };
    }

    if (integrity < 100) {
        const crew = Math.max(MIN_REPAIR_CREW, toInt(district.builders));
        const wanted = roundTo1(Math.min(100 - integrity, numberOf(DISTRICT_DEFAULTS.integrityRepairPerStep, 0) * crew));
        const stocked = numberOf(district.reserves.materials, 0);
        let applied = wanted;
        let cost = roundTo1(wanted * MATERIALS_PER_INTEGRITY);
        if (!canAfford(district.reserves, { materials: cost })) {
            applied = roundTo1(Math.min(wanted, Math.max(0, Math.floor((Math.max(0, stocked) / MATERIALS_PER_INTEGRITY) * 10) / 10)));
            cost = roundTo1(applied * MATERIALS_PER_INTEGRITY);
        }
        if (applied > 0 && (cost <= 0 || spend(district.reserves, { materials: cost }))) {
            district.defensiveIntegrity = clamp(roundTo1(integrity + applied), 0, 100);
            if (district.defensiveIntegrity >= 100 && integrity < 100) {
                events.push(
                    logEvent(
                        kingdom,
                        `${String(district.name)}: walls back to full integrity (${String(cost)} materials spent this step).`,
                    ),
                );
            }
        } else if (wanted > 0) {
            events.push(
                logEvent(kingdom, `${String(district.name)}: no materials to spare - the wall stays at ${String(Math.round(integrity))} integrity.`),
            );
        }
    }

    if (toInt(district.siegeSteps) !== 0 && toInt(district.assault) === 0) {
        district.siegeSteps = 0;
    }

    events.push(...demoteSecurity(kingdom, district));
    return events;
}

/**
 * One rung down the danger ladder per step. `isolated` is the evacuation module's business
 * and is left alone here.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {string[]}
 */
function demoteSecurity(kingdom, district) {
    const /** @type {string[]} */ events = [];
    const current = String(district.security ?? "secure");
    if (current === "secure" || current === "isolated") {
        return events;
    }
    const breachIntegrity = clamp(numberOf(kingdom?.policy?.breachIntegrity, POLICY_DEFAULTS.breachIntegrity), 0, 100);
    if (current === "breached" || current === "lost") {
        if (integrityOf(district) < breachIntegrity) {
            return events;
        }
    }
    const index = RECOVERY_LADDER.indexOf(current);
    if (index < 0 || index >= RECOVERY_LADDER.length - 1) {
        return events;
    }
    const next = RECOVERY_LADDER[index + 1];
    district.security = next;
    events.push(logEvent(kingdom, `${String(district.name)}: the district settles ${current} -> ${next}.`));
    return events;
}

/* ------------------------------------------------------------------ *
 * Step driver
 * ------------------------------------------------------------------ */

/**
 * One full war step. Districts are visited in stable id order and every loop is bounded by
 * the district count or the aid-ledger size; there is no while (true) and no recursion.
 *
 * @param {Kingdom} kingdom
 * @returns {string[]} plain-string event descriptions, in the order they were produced
 */
export function runWarStep(kingdom) {
    const /** @type {string[]} */ events = [];
    events.push(...spawnThreats(kingdom));
    events.push(...updateAlertState(kingdom));

    for (const district of sortedDistricts(kingdom)) {
        events.push(...updateFallback(kingdom, district));
        assignDefenders(district);
        district.defensiveIntegrity = integrityOf(district);
        if (typeof district.siegeSteps !== "number" || !Number.isFinite(district.siegeSteps)) {
            district.siegeSteps = 0;
        }

        const demand = reinforcementDemand(kingdom, district);
        if (demand > 0 && NEEDS_HELP_SECURITY.includes(String(district.security))) {
            const report = requestReinforcements(kingdom, String(district.id), demand);
            events.push(...report.events);
        }

        events.push(...resolveAssault(kingdom, district));
        events.push(...counterattack(kingdom, district));
        events.push(...recoverAfterDefense(kingdom, district));
    }

    return events;
}
