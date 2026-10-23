/**
 * Turns invasion directives into changes on the kingdom, and nothing else.
 *
 * The director (director.js) decides; this module does. Each directive is validated on its
 * own. A directive that fails validation is refused with an event and changes nothing, and
 * a valid one is applied even when others in the same batch were refused. The caps in
 * composition.js INVASION_LIMITS are enforced here as well, so a bad caller cannot exceed them.
 *
 * Writes go through the war module wherever it offers a function for the job:
 *   - a landing adds raider-equivalent strength to `district.assault`, then
 *     `updateAlertState` from sim/war.js escalates the security level
 *   - the strength of the defenders is read through `defensiveStrength`, so the event text
 *     reports the same number the war will use
 * sim/war.js exports no function that lands a directed band, so the single `assault` increment
 * lives here. Its cap is the mirrored `districtAssaultCap`, which dev/test checks against the
 * behaviour of spawnThreats.
 *
 * Refusals are written to `kingdom.log` as well as returned, so a rejected directive is
 * visible to whoever reads the event log. The kingdom's state is not otherwise touched.
 *
 * @typedef {any} Kingdom
 * @typedef {{ index: number, kind: string, accepted: boolean, reason: string, waveId: string | null }} DirectiveResult
 */

import { districtById, pushEvent } from "../../kingdom/state.js";
import { defensiveStrength, updateAlertState } from "../war.js";
import { BEARINGS, INVASION_LIMITS, UNIT_ORDER, WALL_SECTIONS, strengthOf, unitsOf } from "./composition.js";

/** Directive kinds this module understands. */
export const DIRECTIVE_KINDS = Object.freeze(["scout", "spawn", "alarm"]);

/** Reasons an alarm may be raised for. Only a breach or a fall calls the sirens. */
export const ALARM_REASONS = Object.freeze(["breached", "fallen"]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toInt(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * @param {Kingdom} kingdom
 * @param {string[]} events
 * @param {string} text
 */
function emit(kingdom, events, text) {
    if (!Array.isArray(kingdom.log)) {
        kingdom.log = [];
    }
    pushEvent(kingdom, text);
    events.push(text);
}

/**
 * @param {Record<string, any>} counts
 * @returns {string}
 */
function describeCounts(counts) {
    const parts = [];
    for (const type of UNIT_ORDER) {
        const count = toInt(counts[type]);
        if (count > 0) {
            parts.push(`${String(count)} ${count === 1 ? type : `${type}s`}`);
        }
    }
    return parts.length > 0 ? parts.join(", ") : "no one";
}

/**
 * @typedef {{ accepted: true, reason: string, events: string[], landed: boolean }
 *   | { accepted: false, reason: string, events: string[], landed: false }} Verdict
 */

/**
 * @param {string} reason
 * @returns {Verdict}
 */
function refuse(reason) {
    return { accepted: false, reason, events: [], landed: false };
}

/**
 * @param {Kingdom} kingdom
 * @param {Record<string, any>} directive
 * @returns {{ district: Record<string, any> } | { refusal: string }}
 */
function districtFor(kingdom, directive) {
    if (typeof directive.districtId !== "string") {
        return { refusal: "a directive must name its district as text" };
    }
    const district = districtById(kingdom, directive.districtId);
    if (!district) {
        return { refusal: `unknown district '${directive.districtId}'` };
    }
    return { district };
}

/**
 * A scout sighting: a warning in a direction, with no change to the kingdom's numbers.
 *
 * @param {Kingdom} kingdom
 * @param {Record<string, any>} directive
 * @returns {Verdict}
 */
function applyScout(kingdom, directive) {
    const found = districtFor(kingdom, directive);
    if ("refusal" in found) {
        return refuse(found.refusal);
    }
    const { district } = found;
    if (!BEARINGS.includes(directive.bearing)) {
        return refuse(`bearing '${String(directive.bearing)}' is not a known direction`);
    }
    if (typeof directive.label !== "string" || directive.label.length === 0 || directive.label.length > 64) {
        return refuse("a sighting needs a short label for the host");
    }
    const target = directive.target;
    let targetText = "";
    if (isPlainObject(target) && target.kind === "wall" && WALL_SECTIONS.includes(target.section)) {
        targetText = `the ${String(target.section)} wall`;
    } else if (isPlainObject(target) && target.kind === "gate" && typeof target.gateId === "string" && target.gateId.length > 0) {
        targetText = `gate ${target.gateId}`;
    } else {
        return refuse("a sighting must name a wall section or a gate");
    }
    const events = [`Scouts report ${directive.label} massing to the ${String(directive.bearing)} of ${String(district.name)}, aiming at ${targetText}.`];
    return { accepted: true, reason: "sighting recorded", events, landed: false };
}

/**
 * A landing: raider-equivalent strength pressed onto a district's assault.
 *
 * @param {Kingdom} kingdom
 * @param {Record<string, any>} directive
 * @param {{ total: number, perDistrict: Record<string, number> }} ledger the running totals for this tick
 * @returns {Verdict}
 */
function applySpawn(kingdom, directive, ledger) {
    const found = districtFor(kingdom, directive);
    if ("refusal" in found) {
        return refuse(found.refusal);
    }
    const { district } = found;
    const counts = directive.counts;
    if (!isPlainObject(counts)) {
        return refuse("a landing needs a counts object");
    }
    for (const key of Object.keys(counts)) {
        if (!UNIT_ORDER.includes(/** @type {any} */ (key))) {
            return refuse(`unknown unit type '${key}'`);
        }
    }
    for (const type of UNIT_ORDER) {
        const count = counts[type] ?? 0;
        if (!Number.isInteger(count) || count < 0) {
            return refuse(`${type} count must be a non-negative integer, got ${String(count)}`);
        }
    }
    const strength = strengthOf(counts);
    if (!Number.isInteger(directive.strength) || directive.strength !== strength) {
        return refuse(`strength ${String(directive.strength)} does not match its units (${String(strength)})`);
    }
    if (strength <= 0 || unitsOf(counts) <= 0) {
        return refuse("an empty landing is not a directive");
    }
    if (district.security === "lost") {
        return refuse(`${String(district.name)} has already fallen and cannot be pressed`);
    }
    const alreadyThisTick = ledger.perDistrict[district.id] ?? 0;
    if (alreadyThisTick + strength > INVASION_LIMITS.maxSpawnPerDistrictPerStep) {
        return refuse(
            `${String(district.name)} would take ${String(alreadyThisTick + strength)} in one tick (cap ${String(INVASION_LIMITS.maxSpawnPerDistrictPerStep)})`,
        );
    }
    if (ledger.total + strength > INVASION_LIMITS.maxSpawnPerStep) {
        return refuse(`the kingdom would take ${String(ledger.total + strength)} in one tick (cap ${String(INVASION_LIMITS.maxSpawnPerStep)})`);
    }
    const before = toInt(district.assault);
    if (before + strength > INVASION_LIMITS.districtAssaultCap) {
        return refuse(
            `${String(district.name)} would reach assault ${String(before + strength)} (cap ${String(INVASION_LIMITS.districtAssaultCap)})`,
        );
    }

    const standing = defensiveStrength(district);
    district.assault = before + strength;
    ledger.total += strength;
    ledger.perDistrict[district.id] = alreadyThisTick + strength;
    const events = [
        `${String(district.name)}: ${describeCounts(counts)} press the district (assault ${String(before)} -> ${String(district.assault)}, ${String(Math.round(standing))} effective defenders).`,
    ];
    return { accepted: true, reason: "landed", events, landed: true };
}

/**
 * An alarm for a breach or a fall. Civilians are moved by the evacuation module from the
 * security state; this only announces the emergency.
 *
 * @param {Kingdom} kingdom
 * @param {Record<string, any>} directive
 * @returns {Verdict}
 */
function applyAlarm(kingdom, directive) {
    const found = districtFor(kingdom, directive);
    if ("refusal" in found) {
        return refuse(found.refusal);
    }
    const { district } = found;
    if (!ALARM_REASONS.includes(directive.reason)) {
        return refuse(`alarm reason '${String(directive.reason)}' is not one of ${ALARM_REASONS.join("/")}`);
    }
    const detail = directive.reason === "fallen" ? "the district has fallen" : "the wall is breached";
    return {
        accepted: true,
        reason: "alarm raised",
        events: [`${String(district.name)}: sirens sound - ${detail}; the civilians of ${String(district.name)} are on alert.`],
        landed: false,
    };
}

/**
 * Applies a batch of directives and reports each one. Directives beyond the per-tick directive
 * cap are refused in order, without being looked at.
 *
 * @param {Kingdom} kingdom
 * @param {unknown} directives
 * @returns {{ events: string[], results: DirectiveResult[] }}
 */
export function applyDirectivesDetailed(kingdom, directives) {
    /** @type {string[]} */
    const events = [];
    /** @type {DirectiveResult[]} */
    const results = [];

    if (!Array.isArray(directives)) {
        emit(kingdom, events, "Invasion directives refused: the batch is not a list.");
        results.push({ index: -1, kind: "batch", accepted: false, reason: "the batch is not a list", waveId: null });
        return { events, results };
    }

    const ledger = { total: 0, perDistrict: /** @type {Record<string, number>} */ ({}) };
    /** @type {Set<string>} */
    const landedOn = new Set();
    let examined = 0;

    directives.forEach((raw, index) => {
        const directive = isPlainObject(raw) ? raw : undefined;
        const kind = directive && typeof directive.kind === "string" ? directive.kind : "unknown";
        const waveId = directive && typeof directive.waveId === "string" ? directive.waveId : null;

        /** @type {Verdict} */
        let verdict;
        if (examined >= INVASION_LIMITS.maxDirectivesPerStep) {
            verdict = refuse(`over the per-tick directive cap of ${String(INVASION_LIMITS.maxDirectivesPerStep)}`);
        } else {
            examined += 1;
            if (!directive) {
                verdict = refuse("a directive must be an object");
            } else if (kind === "scout") {
                verdict = applyScout(kingdom, directive);
            } else if (kind === "spawn") {
                verdict = applySpawn(kingdom, directive, ledger);
            } else if (kind === "alarm") {
                verdict = applyAlarm(kingdom, directive);
            } else {
                verdict = refuse(`unknown directive kind '${kind}'`);
            }
        }

        for (const text of verdict.events) {
            emit(kingdom, events, text);
        }
        if (!verdict.accepted) {
            emit(kingdom, events, `Invasion directive ${String(index)} (${kind}) refused: ${verdict.reason}.`);
        } else if (verdict.landed && directive) {
            landedOn.add(String(directive.districtId));
        }
        results.push({ index, kind, accepted: verdict.accepted, reason: verdict.reason, waveId });
    });

    if (landedOn.size > 0) {
        // Escalation only, and it logs its own changes. Running it here means the landing shows
        // in the security state at once, not one step later.
        events.push(...updateAlertState(kingdom));
    }
    return { events, results };
}

/**
 * The list form of applyDirectivesDetailed.
 *
 * @param {Kingdom} kingdom
 * @param {unknown} directives
 * @returns {string[]} events, in the order they happened
 */
export function applyDirectives(kingdom, directives) {
    return applyDirectivesDetailed(kingdom, directives).events;
}
