import { GATE_STATES, SECURITY_LEVELS } from "../config.js";
import { districtById, pushEvent } from "../kingdom/state.js";

/**
 * The civilian side of the simulation: when a district's walls fail its people walk to a
 * safe neighbour through an open gate, and walk back once their own district is secure
 * again.
 *
 * Pure saved-state arithmetic - no entity is spawned, no block is placed, no runtime is
 * touched. `civilians` are numbers in a save, so evacuation is a bounded transfer between
 * two counters, and the kingdom total never changes. Soldiers stay on the wall: nothing in
 * this module reads or writes `soldiers`.
 *
 * A district whose gates are all sealed or broken becomes `isolated`. Isolation is a road
 * state, not a conquest: population, ownership, garrison and the district record all stay
 * where they are, and `isolated` is never `lost`.
 *
 * @typedef {any} Kingdom
 * @typedef {any} District
 */

/**
 * @typedef {{ districtId: string, name: string, gateId: string, gateState: string, security: string, headroom: number, reason: string }} BlockedRoute
 * @typedef {{ districtId: string, name: string, security: string, gateId: string, gateState: string, headroom: number, canTake: number, score: number }} EvacuationTarget
 * @typedef {{ from: string, targets: EvacuationTarget[], blocked: BlockedRoute[], reason: string | null }} TargetSearch
 * @typedef {{ from: string, to: string | null, moved: number, blocked: boolean, reason: string | null, events: string[] }} EvacuationResult
 * @typedef {{ changed: boolean, gateId: string, state: string, owner: string, reason: string | null }} GateResult
 */

/* ------------------------------------------------------------------ *
 * Tunables. LOCAL to this module: config.js belongs to another phase and is not edited
 * here, so anything not already in the shipped config is defined below and flagged in the
 * implementation report.
 * ------------------------------------------------------------------ */

/** LOCAL: destination security levels safe enough to take in civilians. */
const SAFE_DESTINATION_SECURITY = ["secure", "alert"];
/** LOCAL: districts pressed this hard start moving people out. */
const EVACUATION_TRIGGER_SECURITY = ["contested", "breached", "isolated", "lost"];
/** LOCAL: default bounded flow rate - civilians per district per step, so a breach does not
 * teleport a whole district at once. */
const MAX_EVACUEES_PER_STEP = 12;
/** LOCAL: ceiling on how many home districts one host can track sheltering. */
const MAX_SHELTER_LEDGER_ENTRIES = 24;
/** LOCAL: a host this much safer than another wins the ranking outright; the tie-break is
 * then raw headroom, then id, so the choice is always deterministic. */
const SECURITY_SCORE_WEIGHT = 1000;
/** LOCAL: rank of each security level for "is this place safer than that place". */
const SECURITY_RANK = SECURITY_LEVELS.reduce((/** @type {Record<string, number>} */ ranks, level, index) => {
    ranks[level] = index;
    return ranks;
}, {});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOf(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Counts stay non-negative integers, because that is what the save validator accepts.
 * @param {unknown} value
 * @returns {number}
 */
function toInt(value) {
    const floored = Math.floor(numberOf(value));
    return floored < 0 ? 0 : floored;
}

/**
 * @param {number} value
 * @param {number} max
 * @returns {number}
 */
function clampTop(value, max) {
    if (value < 0) {
        return 0;
    }
    return value > max ? max : value;
}

/**
 * @param {Kingdom} kingdom
 * @returns {District[]}
 */
function districtList(kingdom) {
    return /** @type {District[]} */ (Array.isArray(kingdom?.districts) ? kingdom.districts : []);
}

/**
 * Stable order for every loop in this module: lexicographic by district id.
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
 * @param {District} district
 * @returns {number}
 */
function capacityOf(district) {
    return toInt(district.civilianCapacity);
}

/**
 * Free space by the state module's own formula, `civilianCapacity - civilians - refugees`.
 * A sheltered household needs lodging on top of the host's own people, so the places a
 * district can actually take in are half of that headroom; that is what keeps
 * `civilians + refugees <= civilianCapacity` after every move.
 *
 * @param {District} district
 * @returns {{ headroom: number, canTake: number, civilians: number, refugees: number, capacity: number }}
 */
function shelterRoom(district) {
    const capacity = capacityOf(district);
    const civilians = toInt(district.civilians);
    const refugees = toInt(district.refugees);
    const headroom = capacity - civilians - refugees;
    return { headroom, canTake: Math.floor(Math.max(0, headroom) / 2), civilians, refugees, capacity };
}

/**
 * @param {string | undefined} security
 * @returns {number}
 */
function safetyScore(security) {
    if (!SAFE_DESTINATION_SECURITY.includes(String(security))) {
        return -1;
    }
    return security === "secure" ? 2 : 1;
}

/**
 * Every route out of a district. A gate is shared ground: the record lives on its owner, so
 * a neighbour's gate pointing here is a route out of *this* district too. Routes are then
 * restricted to the district's own neighbour list, so an unlinked district cannot evacuate
 * to somewhere it is not connected to.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {{ gate: any, partnerId: string, gateOwner: string, shared: boolean }[]}
 */
function routeList(kingdom, district) {
    const /** @type {{ gate: any, partnerId: string, gateOwner: string, shared: boolean }[]} */ routes = [];
    const neighbours = Array.isArray(district.neighbors) ? /** @type {string[]} */ (district.neighbors) : [];
    const ownGates = Array.isArray(district.gates) ? /** @type {any[]} */ (district.gates) : [];

    for (const gate of ownGates) {
        const partner = typeof gate?.with === "string" ? gate.with : "";
        if (partner.length === 0 || partner === district.id || !neighbours.includes(partner)) {
            continue;
        }
        routes.push({ gate, partnerId: partner, gateOwner: String(district.id), shared: false });
    }

    const districts = districtList(kingdom);
    for (const neighbourId of neighbours) {
        if (routes.some((route) => route.partnerId === neighbourId)) {
            continue;
        }
        const neighbour = districts.find((candidate) => candidate && candidate.id === neighbourId);
        if (!neighbour) {
            continue;
        }
        const gates = Array.isArray(neighbour.gates) ? /** @type {any[]} */ (neighbour.gates) : [];
        const gate = gates.find((entry) => entry?.with === district.id && entry?.owner === neighbour.id);
        if (gate) {
            routes.push({ gate, partnerId: neighbourId, gateOwner: String(neighbour.id), shared: true });
        }
    }
    return routes;
}

/**
 * The list of groups this district is sheltering, by home district. An extra district field
 * the save validator ignores, so `returnRefugeesHome` can send each group back to where it
 * came from instead of guessing.
 *
 * @param {District} district
 * @returns {{ home: string, civilians: number }[]}
 */
function shelterLedger(district) {
    if (!Array.isArray(district.sheltering)) {
        district.sheltering = [];
    }
    return /** @type {{ home: string, civilians: number }[]} */ (district.sheltering);
}

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

/**
 * Which neighbours could take this district's people, best first. A neighbour qualifies only
 * if it is connected, reached through a gate in state `open`, safe enough
 * (`secure` or `alert`), and has real headroom. When nothing qualifies, `reason` says exactly
 * why - gate sealed or broken, all neighbours unsafe, or no capacity - so the caller can
 * report honestly instead of inventing a destination.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {TargetSearch}
 */
export function findEvacuationTargets(kingdom, district) {
    /** @type {EvacuationTarget[]} */
    const targets = [];
    /** @type {BlockedRoute[]} */
    const blocked = [];
    const routes = routeList(kingdom, district);
    const result = /** @type {TargetSearch} */ ({ from: String(district?.id ?? ""), targets, blocked, reason: null });

    if (routes.length === 0) {
        result.reason = `${String(district?.name ?? district?.id ?? "district")} has no gate route to any neighbour`;
        return result;
    }

    for (const route of routes) {
        const partner = districtById(kingdom, route.partnerId);
        const gateId = String(route.gate?.id ?? `gate-${route.gateOwner}-${route.partnerId}`);
        if (!partner) {
            blocked.push({
                districtId: route.partnerId,
                name: String(route.partnerId),
                gateId,
                gateState: String(route.gate?.state ?? "open"),
                security: "unknown",
                headroom: 0,
                reason: "the district on the other side of the gate is not part of the kingdom",
            });
            continue;
        }

        const gateState = String(route.gate?.state ?? "open");
        if (gateState !== "open") {
            blocked.push({
                districtId: String(partner.id),
                name: String(partner.name),
                gateId,
                gateState,
                security: String(partner.security ?? "secure"),
                headroom: shelterRoom(partner).headroom,
                reason: `gate ${gateId} is ${gateState}`,
            });
            continue;
        }

        const room = shelterRoom(partner);
        if (!SAFE_DESTINATION_SECURITY.includes(String(partner.security))) {
            blocked.push({
                districtId: String(partner.id),
                name: String(partner.name),
                gateId,
                gateState,
                security: String(partner.security ?? "secure"),
                headroom: room.headroom,
                reason: `${String(partner.name)} is ${String(partner.security)}, not safe enough to shelter civilians`,
            });
            continue;
        }
        if (room.headroom <= 0) {
            blocked.push({
                districtId: String(partner.id),
                name: String(partner.name),
                gateId,
                gateState,
                security: String(partner.security ?? "secure"),
                headroom: room.headroom,
                reason: `${String(partner.name)} is full (${String(room.civilians)} civilians plus ${String(room.refugees)} refugees against ${String(room.capacity)} places)`,
            });
            continue;
        }
        if (room.canTake <= 0) {
            blocked.push({
                districtId: String(partner.id),
                name: String(partner.name),
                gateId,
                gateState,
                security: String(partner.security ?? "secure"),
                headroom: room.headroom,
                reason: `${String(partner.name)} has a single place left, not enough to take in a household`,
            });
            continue;
        }

        targets.push({
            districtId: String(partner.id),
            name: String(partner.name),
            security: String(partner.security ?? "secure"),
            gateId,
            gateState,
            headroom: room.headroom,
            canTake: room.canTake,
            score: safetyScore(partner.security) * SECURITY_SCORE_WEIGHT + room.canTake,
        });
    }

    targets.sort((left, right) => {
        if (left.score !== right.score) {
            return right.score - left.score;
        }
        return left.districtId < right.districtId ? -1 : left.districtId > right.districtId ? 1 : 0;
    });

    if (targets.length === 0) {
        const sealed = blocked.filter((entry) => entry.gateState !== "open");
        const unsafe = blocked.filter((entry) => entry.gateState === "open" && !SAFE_DESTINATION_SECURITY.includes(entry.security));
        const full = blocked.filter(
            (entry) => entry.gateState === "open" && SAFE_DESTINATION_SECURITY.includes(entry.security) && entry.headroom <= 0,
        );
        const /** @type {string[]} */ parts = [];
        if (sealed.length > 0) {
            parts.push(`every gate out is sealed or broken (${sealed.map((entry) => `${String(entry.gateId)}: ${String(entry.gateState)}`).join(", ")})`);
        }
        if (unsafe.length > 0) {
            parts.push(`all connected neighbours are unsafe (${unsafe.map((entry) => `${String(entry.name)}: ${String(entry.security)}`).join(", ")})`);
        }
        if (full.length > 0) {
            parts.push(`every safe neighbour has no capacity (${full.map((entry) => String(entry.name)).join(", ")})`);
        }
        if (parts.length === 0) {
            parts.push(blocked.map((entry) => String(entry.reason)).join("; "));
        }
        result.reason = parts.join("; ");
    }
    return result;
}

/* ------------------------------------------------------------------ *
 * Movement
 * ------------------------------------------------------------------ */

/**
 * Move at most `maxPerStep` civilians out of a district, down the best open route to a safe
 * neighbour with room. People are counted, not teleported: the source loses exactly what the
 * destination gains, the destination tags the same number as `refugees`, and
 * `district.evacuatedTo` records where they went (or is cleared to null when nobody left).
 *
 * When every route is blocked the civilians shelter in place and the event says so.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @param {number} [maxPerStep]
 * @returns {EvacuationResult}
 */
export function evacuateCivilians(kingdom, district, maxPerStep) {
    const rate =
        typeof maxPerStep === "number" && Number.isFinite(maxPerStep) && maxPerStep >= 0 ? Math.floor(maxPerStep) : MAX_EVACUEES_PER_STEP;
    const /** @type {string[]} */ events = [];
    const outcome = /** @type {EvacuationResult} */ ({
        from: String(district?.id ?? ""),
        to: null,
        moved: 0,
        blocked: true,
        reason: null,
        events,
    });

    const civilians = toInt(district.civilians);
    district.civilians = civilians;
    district.refugees = toInt(district.refugees);
    if (civilians === 0) {
        outcome.reason = "no civilians left in the district";
        events.push(logEvent(kingdom, `${String(district.name)}: no civilians left to move.`));
        return outcome;
    }

    const found = findEvacuationTargets(kingdom, district);
    if (rate <= 0) {
        outcome.reason = "the evacuation rate for this step is zero";
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: evacuation is closed for this step - ${String(civilians)} civilians shelter in place.`,
            ),
        );
        return outcome;
    }
    if (found.targets.length === 0) {
        outcome.reason = found.reason;
        district.evacuatedTo = null;
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: every route is blocked (${String(found.reason)}). ${String(civilians)} civilians shelter in place.`,
            ),
        );
        return outcome;
    }

    // Keep using the district the people already fled to while it still qualifies, so one
    // family is not split between two neighbours across consecutive steps.
    const sticky = typeof district.evacuatedTo === "string" ? found.targets.find((entry) => entry.districtId === district.evacuatedTo) : undefined;
    const chosen = sticky ?? found.targets[0];
    const host = districtById(kingdom, chosen.districtId);
    if (!host) {
        outcome.reason = found.reason ?? `${String(chosen.name)} vanished mid-step`;
        district.evacuatedTo = null;
        return outcome;
    }

    const room = shelterRoom(host);
    const move = Math.min(rate, civilians, Math.floor(Math.max(0, room.headroom) / 2));
    if (move <= 0) {
        outcome.reason = `${String(host.name)} filled up before anyone could arrive`;
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: ${String(chosen.name)} has no room left - ${String(civilians)} civilians shelter in place.`,
            ),
        );
        return outcome;
    }

    district.civilians = civilians - move;
    host.civilians = room.civilians + move;
    host.refugees = room.refugees + move;
    district.evacuatedTo = String(host.id);

    const ledger = shelterLedger(host);
    const entry = ledger.find((item) => item.home === district.id);
    if (entry) {
        entry.civilians = toInt(entry.civilians) + move;
    } else if (ledger.length < MAX_SHELTER_LEDGER_ENTRIES) {
        ledger.push({ home: String(district.id), civilians: move });
    } else {
        // The ledger is capped only to keep the loop bounded; the people still move and are
        // recorded against the last tracked home rather than being dropped.
        ledger[ledger.length - 1].civilians = toInt(ledger[ledger.length - 1].civilians) + move;
    }

    outcome.to = String(host.id);
    outcome.moved = move;
    outcome.blocked = false;
    outcome.reason = null;
    events.push(
        logEvent(
            kingdom,
            `${String(district.name)}: ${String(move)} civilians evacuate through gate ${String(chosen.gateId)} to ${String(host.name)} (${String(
                toInt(district.civilians),
            )} still in the district).`,
        ),
    );
    return outcome;
}

/* ------------------------------------------------------------------ *
 * Gates
 * ------------------------------------------------------------------ */

/**
 * Open, seal or break a named gate. Gate ids are unique across the kingdom because they are
 * built as `gate-<owner>-<partner>`, so this finds the one record wherever it is stored and
 * nothing is mirrored.
 *
 * @param {Kingdom} kingdom
 * @param {string} gateId
 * @param {string} state one of GATE_STATES
 * @returns {GateResult}
 */
export function setGateState(kingdom, gateId, state) {
    const result = /** @type {GateResult} */ ({
        changed: false,
        gateId: String(gateId),
        state: String(state),
        owner: "",
        reason: null,
    });
    if (!GATE_STATES.includes(String(state))) {
        result.reason = `'${String(state)}' is not one of ${GATE_STATES.join("/")}`;
        logEvent(kingdom, `Gate ${String(gateId)} left as it was: ${String(result.reason)}.`);
        return result;
    }
    for (const district of sortedDistricts(kingdom)) {
        const gates = Array.isArray(district.gates) ? /** @type {any[]} */ (district.gates) : [];
        const gate = gates.find((entry) => entry?.id === gateId);
        if (!gate) {
            continue;
        }
        const previous = String(gate.state ?? "open");
        gate.state = String(state);
        result.changed = previous !== String(state);
        result.owner = String(district.id);
        result.reason = result.changed ? null : `gate was already ${String(state)}`;
        logEvent(kingdom, `${String(district.name)}: gate ${String(gate.id)} ${previous} -> ${String(state)}.`);
        return result;
    }
    result.reason = `no gate ${String(gateId)} in this kingdom`;
    logEvent(kingdom, `Gate order failed: no gate ${String(gateId)} in this kingdom.`);
    return result;
}

/**
 * Logical isolation. A district that has gate routes but cannot use a single one of them -
 * every gate, its own or a neighbour's that reaches it, sealed or broken - is `isolated`.
 * Isolation is a road state, not a conquest: civilians, soldiers, garrison, wall and the
 * district record all stay exactly where they were, and `isolated` is never `lost`. A district
 * with no gate structure at all is not "shut in by its gates", so it is left alone. Reopening
 * any route lifts the isolation and the war module re-assesses it on its own evidence.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {string[]} event descriptions
 */
export function isolateOnBrokenGates(kingdom, district) {
    const /** @type {string[]} */ events = [];
    const routes = routeList(kingdom, district);
    if (routes.length === 0) {
        return events;
    }

    const open = routes.filter((route) => String(route.gate?.state ?? "open") === "open");
    const usable = open.length > 0;

    if (!usable && district.security !== "isolated" && district.security !== "lost") {
        district.security = "isolated";
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: every gate route is unusable (${routes
                    .map((route) => `${String(route.gate?.id)}=${String(route.gate?.state)}`)
                    .join(", ")}) - the district is isolated, not taken; ${String(toInt(district.civilians))} civilians and ${String(
                    toInt(district.soldiers),
                )} soldiers hold on.`,
            ),
        );
    } else if (usable && district.security === "isolated") {
        district.security = "secure";
        events.push(
            logEvent(
                kingdom,
                `${String(district.name)}: gate ${String(open[0].gate?.id)} is open again - isolation lifted, the watch re-assesses the district.`,
            ),
        );
    }
    return events;
}

/* ------------------------------------------------------------------ *
 * Going home
 * ------------------------------------------------------------------ */

/**
 * A district that is `secure` again with nobody pressing it takes its sheltered people back,
 * at the same bounded walking rate it sent them out. Origin counts are restored from the
 * host's shelter ledger, so each group goes to the district it left, and `evacuatedTo` is
 * cleared once a group is whole again. A home still in danger, or with no room, keeps its
 * people sheltered and is tried again next step.
 *
 * @param {Kingdom} kingdom
 * @returns {string[]} event descriptions
 */
export function returnRefugeesHome(kingdom) {
    const /** @type {string[]} */ events = [];
    for (const host of sortedDistricts(kingdom)) {
        const ledger = shelterLedger(host);
        if (ledger.length === 0) {
            continue;
        }
        const /** @type {typeof ledger} */ remaining = [];

        for (const entry of ledger.slice()) {
            const sheltered = toInt(entry.civilians);
            if (sheltered <= 0) {
                continue;
            }
            const home = districtById(kingdom, entry.home);
            if (!home || home.id === host.id) {
                remaining.push(entry);
                continue;
            }
            const homeSafe = String(home.security ?? "secure") === "secure" && toInt(home.assault) === 0;
            const room = shelterRoom(home);
            // The same occupancy model as an inbound move: a returning resident takes a place,
            // and any refugees the home itself is still sheltering keep theirs, so a home that
            // is full cannot absorb its own people yet and stays on the ledger for next step.
            const headroomAtHome = Math.max(0, room.headroom);
            const walk = Math.min(MAX_EVACUEES_PER_STEP, sheltered, headroomAtHome);
            if (!homeSafe || walk <= 0) {
                remaining.push(entry);
                continue;
            }

            const hostedCivilians = toInt(host.civilians);
            const hostedRefugees = toInt(host.refugees);
            host.civilians = Math.max(0, hostedCivilians - walk);
            host.refugees = Math.max(0, hostedRefugees - walk);
            home.civilians = toInt(home.civilians) + walk;
            if (typeof home.evacuatedTo === "string" && home.evacuatedTo === host.id && sheltered - walk <= 0) {
                home.evacuatedTo = null;
            }
            entry.civilians = sheltered - walk;
            if (toInt(entry.civilians) > 0) {
                remaining.push(entry);
            }
            events.push(
                logEvent(
                    kingdom,
                    `${String(walk)} refugees walk home from ${String(host.name)} to ${String(home.name)} (${String(toInt(home.civilians))} of ${String(
                        room.capacity,
                    )} places used at home).`,
                ),
            );
        }
        host.sheltering = remaining;
    }
    return events;
}

/* ------------------------------------------------------------------ *
 * Step driver
 * ------------------------------------------------------------------ */

/**
 * One evacuation step, districts visited in stable id order:
 *   1. mark every district whose gates are all unusable as isolated (and lift isolation where
 *      a gate is open again)
 *   2. walk home everyone whose own district is secure again
 *   3. press on through the danger levels, moving at most MAX_EVACUEES_PER_STEP people per
 *      district, and reporting shelter-in-place when nothing qualifies
 *
 * Bounded loops only, no recursion, and `soldiers` is never read or written: evacuation does
 * not thin the defensive positions.
 *
 * @param {Kingdom} kingdom
 * @returns {string[]} plain-string event descriptions
 */
export function runEvacuationStep(kingdom) {
    const /** @type {string[]} */ events = [];

    for (const district of sortedDistricts(kingdom)) {
        events.push(...isolateOnBrokenGates(kingdom, district));
    }

    events.push(...returnRefugeesHome(kingdom));

    for (const district of sortedDistricts(kingdom)) {
        if (!EVACUATION_TRIGGER_SECURITY.includes(String(district?.security))) {
            continue;
        }
        const before = toInt(district.civilians);
        const outcome = evacuateCivilians(kingdom, district, MAX_EVACUEES_PER_STEP);
        events.push(...outcome.events);
        if (!outcome.blocked && outcome.moved > 0 && before - outcome.moved === 0) {
            events.push(logEvent(kingdom, `${String(district.name)}: the last civilians are out.`));
        }
    }
    return events;
}
