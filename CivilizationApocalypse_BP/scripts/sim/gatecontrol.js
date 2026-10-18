import { GATE_STATES } from "../config.js";
import { districtById, pushEvent } from "../kingdom/state.js";
import { reinforcementDemand } from "./war.js";

/**
 * Gate control policy for the simulation. PURE saved-state arithmetic: nothing here reads the world, imports
 * `@minecraft/server`, or places a block. It decides what each gate SHOULD be; civ/gates.js says how a gate
 * looks, and integration/gateAdapter.js makes the blocks follow.
 *
 * State model (all optional, so a kingdom with none of it behaves exactly as before):
 *   gate.state     'open' | 'sealed' | 'broken'    existing logical state (GATE_STATES), what evacuation reads
 *   gate.mode      'auto' | 'forced_open' | 'forced_closed'     NEW: who decides. Absent = unmanaged.
 *   gate.physical  { state:'open'|'closed', target?:'open'|'closed', blocked?:string, spec?:{...} }
 *                  NEW: present only when a physical gate exists in the world. `state` is the last COMPLETED
 *                  physical state, `target` the requested one, `blocked` why it has not happened yet.
 *
 * A gate is MANAGED when it has a `mode` or a `physical` record. Unmanaged gates are never touched, so the
 * five-district simulation without physical gates is unchanged by this module.
 *
 * Physical gates change their logical state only when the blocks have actually moved (recordPhysicalResult):
 * a gate held up by a villager in the doorway stays logically open, so civilians and soldiers can still use it.
 * Logical-only managed gates flip immediately.
 *
 * Policy (mode 'auto'):
 *   - nothing threatens either side (assault, contested, breached) -> open
 *   - otherwise KEEP OPEN while any of these holds, and say which:
 *       evacuation        a side is evacuating civilians to the other, or this is its only route with people in it
 *       reinforcement     a side under assault needs soldiers the other side can send
 *       traffic           refugees or detachments (the shelter and aid ledgers) are on the other side
 *   - otherwise close, UNLESS closing would isolate a district, sever the open-route graph into more pieces than
 *     before, or strand sheltered refugees away from their home. Then it stays open and the veto is the reason.
 *   - 'broken' gates are never moved: they cannot close and are not "opened" either.
 * Forced modes override the policy; forcing a gate closed that would isolate someone needs `force`.
 *
 * Gates are processed in id order and each decision sees the earlier ones, so a ring never loses more than the
 * one cut it can afford, and running the policy twice changes nothing the second time.
 *
 * @typedef {any} Kingdom
 * @typedef {any} District
 * @typedef {any} Gate
 * @typedef {"open" | "sealed" | "broken"} LogicalState
 * @typedef {{
 *   gateId: string, owner: string, partner: string, mode: string, current: string, desired: LogicalState,
 *   reasons: string[], vetoes: string[]
 * }} GateDecision
 * @typedef {{ gateId: string, owner: string, from: "open" | "closed", to: "open" | "closed", reason: string }} PhysicalChange
 */

export const GATE_MODES = Object.freeze(["auto", "forced_open", "forced_closed"]);
export const PHYSICAL_GATE_STATES = Object.freeze(["open", "closed"]);

/** LOCAL: a side in one of these (or with assault > 0) is under threat. */
const THREAT_SECURITY = ["contested", "breached"];
/** LOCAL: mirrors sim/evacuation.js - districts in these states move civilians out. */
const EVACUATION_SECURITY = ["contested", "breached", "isolated", "lost"];
/** LOCAL: mirrors sim/evacuation.js - a destination must be one of these. */
const SAFE_SECURITY = ["secure", "alert"];
const MAX_REASON_LENGTH = 160;

/** @param {unknown} value */
function toInt(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** @param {Kingdom} kingdom @returns {District[]} */
function districtList(kingdom) {
    return Array.isArray(kingdom?.districts) ? kingdom.districts : [];
}

/**
 * Every gate in the kingdom with its owner, ordered by gate id (then owner id) so all loops are stable.
 * @param {Kingdom} kingdom
 * @returns {{ gate: Gate, owner: District }[]}
 */
export function listGates(kingdom) {
    /** @type {{ gate: Gate, owner: District }[]} */
    const list = [];
    for (const district of districtList(kingdom)) {
        if (!district || !Array.isArray(district.gates)) {
            continue;
        }
        for (const gate of district.gates) {
            if (gate && typeof gate.id === "string") {
                list.push({ gate, owner: district });
            }
        }
    }
    return list.sort((a, b) => (a.gate.id < b.gate.id ? -1 : a.gate.id > b.gate.id ? 1 : String(a.owner.id) < String(b.owner.id) ? -1 : 1));
}

/**
 * @param {Kingdom} kingdom
 * @param {string} gateId
 */
export function findGate(kingdom, gateId) {
    return listGates(kingdom).find((entry) => entry.gate.id === gateId);
}

/**
 * Managed = under this module's control (has a mode or a physical record).
 * @param {Gate} gate
 */
export function isManagedGate(gate) {
    return gate !== null && typeof gate === "object" && (gate.mode !== undefined || (gate.physical !== null && typeof gate.physical === "object"));
}

/**
 * The state a gate is heading for: a pending physical target wins over the last logical state, so two decisions
 * made in one pass see each other.
 * @param {Gate} gate
 * @returns {string}
 */
export function plannedState(gate) {
    if (gate?.state === "broken") {
        return "broken";
    }
    const target = gate?.physical?.target;
    if (target === "closed") {
        return "sealed";
    }
    if (target === "open") {
        return "open";
    }
    return String(gate?.state ?? "open");
}

/**
 * Routes out of a district, the same rule sim/evacuation.js uses: its own gates to listed neighbours plus a
 * neighbour's gate that points here. One entry per gate.
 *
 * @param {Kingdom} kingdom
 * @param {District} district
 * @returns {{ gate: Gate, partnerId: string }[]}
 */
function routesOf(kingdom, district) {
    /** @type {{ gate: Gate, partnerId: string }[]} */
    const routes = [];
    const neighbours = Array.isArray(district.neighbors) ? /** @type {string[]} */ (district.neighbors) : [];
    for (const gate of Array.isArray(district.gates) ? district.gates : []) {
        const partner = typeof gate?.with === "string" ? gate.with : "";
        if (partner.length > 0 && partner !== district.id && neighbours.includes(partner)) {
            routes.push({ gate, partnerId: partner });
        }
    }
    for (const neighbourId of neighbours) {
        const neighbour = districtById(kingdom, neighbourId);
        for (const gate of Array.isArray(neighbour?.gates) ? neighbour.gates : []) {
            if (gate?.with === district.id && !routes.some((route) => route.gate === gate)) {
                routes.push({ gate, partnerId: neighbourId });
            }
        }
    }
    return routes;
}

/**
 * Open-route graph. `stateOf` lets a caller ask "what if this gate were ...". Lost districts are not part of it.
 *
 * @param {Kingdom} kingdom
 * @param {(gate: Gate) => string} stateOf
 */
function routeGraph(kingdom, stateOf) {
    /** @type {Map<string, string>} */
    const parent = new Map();
    /** @type {Map<string, number>} */
    const open = new Map();
    /** @type {Map<string, number>} */
    const total = new Map();
    /** @param {string} id @returns {string} */
    const find = (id) => {
        let root = id;
        while (parent.get(root) !== root) {
            root = /** @type {string} */ (parent.get(root));
        }
        return root;
    };
    const alive = districtList(kingdom).filter((district) => district && district.security !== "lost");
    for (const district of alive) {
        parent.set(String(district.id), String(district.id));
        open.set(String(district.id), 0);
        total.set(String(district.id), 0);
    }
    for (const district of alive) {
        for (const route of routesOf(kingdom, district)) {
            if (!parent.has(route.partnerId)) {
                continue;
            }
            const id = String(district.id);
            total.set(id, (total.get(id) ?? 0) + 1);
            if (stateOf(route.gate) === "open") {
                open.set(id, (open.get(id) ?? 0) + 1);
                const a = find(id);
                const b = find(route.partnerId);
                if (a !== b) {
                    parent.set(a < b ? b : a, a < b ? a : b);
                }
            }
        }
    }
    const roots = new Set([...parent.keys()].map(find));
    return { count: roots.size, open, total, find, has: (/** @type {string} */ id) => parent.has(id) };
}

/**
 * What closing `gate` (all other gates as planned) would do to the rest of the kingdom.
 *
 * @param {Kingdom} kingdom
 * @param {Gate} gate
 * @returns {{ isolates: string[], severs: boolean, strands: string[], components: { before: number, after: number }, harmless: boolean }}
 */
export function closeImpact(kingdom, gate) {
    const before = routeGraph(kingdom, (other) => (other === gate ? "open" : plannedState(other)));
    const after = routeGraph(kingdom, (other) => (other === gate ? "sealed" : plannedState(other)));
    /** @type {string[]} */
    const isolates = [];
    for (const district of districtList(kingdom)) {
        const id = String(district?.id);
        if (before.has(id) && (before.total.get(id) ?? 0) > 0 && (before.open.get(id) ?? 0) > 0 && (after.open.get(id) ?? 0) === 0) {
            isolates.push(id);
        }
    }
    /** @type {string[]} */
    const strands = [];
    for (const host of districtList(kingdom)) {
        for (const entry of Array.isArray(host?.sheltering) ? /** @type {any[]} */ (host.sheltering) : []) {
            const home = String(entry?.home);
            if (toInt(entry?.civilians) > 0 && before.has(String(host.id)) && before.has(home) && before.find(String(host.id)) === before.find(home) && after.find(String(host.id)) !== after.find(home)) {
                strands.push(`${home}->${String(host.id)}`);
            }
        }
    }
    const severs = after.count > before.count;
    return {
        isolates: isolates.sort(),
        severs,
        strands: strands.sort(),
        components: { before: before.count, after: after.count },
        harmless: isolates.length === 0 && !severs && strands.length === 0,
    };
}

/**
 * @param {District} district
 */
function isThreatened(district) {
    return toInt(district?.assault) > 0 || THREAT_SECURITY.includes(String(district?.security));
}

/**
 * Room to take in a household (mirrors the evacuation module's rule closely enough to predict it).
 * @param {District} district
 */
function hasShelterRoom(district) {
    return toInt(district?.civilianCapacity) - toInt(district?.civilians) - toInt(district?.refugees) >= 2;
}

/**
 * Soldiers a side under assault is asking for, computed on a copy so deciding never edits a garrison.
 * @param {Kingdom} kingdom
 * @param {District} district
 */
function demandOf(kingdom, district) {
    if (toInt(district?.assault) <= 0) {
        return 0;
    }
    try {
        return reinforcementDemand(kingdom, JSON.parse(JSON.stringify(district)));
    } catch (_error) {
        return 0;
    }
}

/**
 * @param {District} donor
 */
function canDonate(donor) {
    return toInt(donor?.assault) <= 0 && !THREAT_SECURITY.includes(String(donor?.security)) && donor?.security !== "lost" && toInt(donor?.soldiers) > 0;
}

/**
 * @param {string} text
 */
function clip(text) {
    return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 3)}...` : text;
}

/**
 * Decide what a gate should be. Pure: reads the kingdom, changes nothing.
 *
 * @param {Kingdom} kingdom
 * @param {Gate} gate
 * @returns {GateDecision}
 */
export function decideGate(kingdom, gate) {
    const ownerId = String(gate?.owner ?? "");
    const partnerId = String(gate?.with ?? "");
    const owner = districtById(kingdom, ownerId);
    const partner = districtById(kingdom, partnerId);
    const mode = GATE_MODES.includes(gate?.mode) ? String(gate.mode) : "auto";
    const current = String(gate?.state ?? "open");
    /** @type {GateDecision} */
    const decision = { gateId: String(gate?.id), owner: ownerId, partner: partnerId, mode, current, desired: "open", reasons: [], vetoes: [] };

    if (current === "broken") {
        decision.desired = "broken";
        decision.reasons.push("the gate is broken: it can neither close nor be opened until it is repaired");
        return decision;
    }
    if (mode === "forced_open") {
        decision.reasons.push("manual override: held open");
        return decision;
    }
    if (mode === "forced_closed") {
        decision.desired = "sealed";
        decision.reasons.push("manual override: held closed");
        return decision;
    }

    const sides = [owner, partner].filter((district) => district !== undefined);
    const threatened = sides.filter(isThreatened);
    if (threatened.length === 0) {
        decision.reasons.push("no assault or breach on either side");
        return decision;
    }

    /** @type {string[]} */
    const keepOpen = [];
    for (const side of sides) {
        const other = side === owner ? partner : owner;
        if (other === undefined) {
            continue;
        }
        const people = toInt(side.civilians) > 0 || toInt(side.refugees) > 0;
        if (toInt(side.civilians) > 0 && EVACUATION_SECURITY.includes(String(side.security)) && SAFE_SECURITY.includes(String(other.security)) && hasShelterRoom(other)) {
            keepOpen.push(`evacuation: ${String(side.name)} moves civilians to ${String(other.name)} through this gate`);
        }
        if (people) {
            const graph = routeGraph(kingdom, (candidate) => (candidate === gate ? "open" : plannedState(candidate)));
            if ((graph.open.get(String(side.id)) ?? 0) === 1 && graph.total.has(String(side.id))) {
                keepOpen.push(`last route: this is the only open route out of ${String(side.name)}, which still holds people`);
            }
        }
        if (demandOf(kingdom, side) > 0 && canDonate(other)) {
            keepOpen.push(`reinforcement: ${String(side.name)} needs soldiers ${String(other.name)} can send`);
        }
        for (const entry of Array.isArray(side.sheltering) ? /** @type {any[]} */ (side.sheltering) : []) {
            if (entry?.home === other.id && toInt(entry?.civilians) > 0) {
                keepOpen.push(`traffic: ${String(toInt(entry.civilians))} refugees from ${String(other.name)} shelter in ${String(side.name)}`);
            }
        }
        for (const entry of Array.isArray(side.reinforcedBy) ? /** @type {any[]} */ (side.reinforcedBy) : []) {
            if (entry?.from === other.id && toInt(entry?.soldiers) > 0) {
                keepOpen.push(`traffic: ${String(toInt(entry.soldiers))} soldiers from ${String(other.name)} are stationed in ${String(side.name)}`);
            }
        }
    }
    if (keepOpen.length > 0) {
        decision.reasons.push(...keepOpen);
        return decision;
    }

    const impact = closeImpact(kingdom, gate);
    if (!impact.harmless) {
        if (impact.isolates.length > 0) {
            decision.vetoes.push(`closing would isolate ${impact.isolates.join(", ")}`);
        }
        if (impact.severs) {
            decision.vetoes.push(`closing would split the open routes into ${String(impact.components.after)} groups (now ${String(impact.components.before)})`);
        }
        if (impact.strands.length > 0) {
            decision.vetoes.push(`closing would strand refugees (${impact.strands.join(", ")}) away from home`);
        }
        decision.reasons.push(...decision.vetoes);
        return decision;
    }
    decision.desired = "sealed";
    decision.reasons.push(`${threatened.map((district) => String(district.name)).join(" and ")} under threat, no friendly traffic uses this gate, and every district keeps a route`);
    return decision;
}

/**
 * @param {Kingdom} kingdom
 * @param {string} text
 */
function logEvent(kingdom, text) {
    if (!Array.isArray(kingdom.log)) {
        kingdom.log = [];
    }
    pushEvent(kingdom, text);
    return text;
}

/**
 * Apply one gate's decision.
 * @param {Kingdom} kingdom
 * @param {Gate} gate
 * @param {District} owner
 * @param {string[]} events
 * @param {PhysicalChange[]} physical
 * @returns {GateDecision}
 */
function applyOne(kingdom, gate, owner, events, physical) {
    const decision = decideGate(kingdom, gate);
    const why = decision.reasons.length > 0 ? ` (${decision.reasons[0]})` : "";
    if (gate.physical !== null && typeof gate.physical === "object") {
        const record = gate.physical;
        const want = decision.desired === "sealed" ? "closed" : "open";
        const state = PHYSICAL_GATE_STATES.includes(record.state) ? record.state : "open";
        const heading = record.target === undefined ? state : record.target;
        if (heading !== want) {
            if (want === state) {
                delete record.target;
            } else {
                record.target = want;
            }
            physical.push({ gateId: gate.id, owner: String(owner.id), from: state, to: want, reason: decision.reasons[0] ?? "" });
            events.push(logEvent(kingdom, clip(`${String(owner.name)}: gate ${String(gate.id)} ordered ${want}${why}.`)));
        }
        return decision;
    }
    if (decision.desired !== "broken" && decision.desired !== gate.state && GATE_STATES.includes(decision.desired)) {
        const previous = String(gate.state);
        gate.state = decision.desired;
        events.push(logEvent(kingdom, clip(`${String(owner.name)}: gate ${String(gate.id)} ${previous} -> ${decision.desired}${why}.`)));
    }
    return decision;
}

/**
 * Run the policy over every managed gate. Returns the events (also written to the kingdom log), the decisions,
 * and the gates whose PHYSICAL state must change (the adapter's work list).
 *
 * @param {Kingdom} kingdom
 * @returns {{ events: string[], physical: PhysicalChange[], decisions: GateDecision[] }}
 */
export function applyGateDecisions(kingdom) {
    /** @type {string[]} */
    const events = [];
    /** @type {PhysicalChange[]} */
    const physical = [];
    /** @type {GateDecision[]} */
    const decisions = [];
    for (const { gate, owner } of listGates(kingdom)) {
        if (isManagedGate(gate)) {
            decisions.push(applyOne(kingdom, gate, owner, events, physical));
        }
    }
    return { events, physical, decisions };
}

/**
 * The hook for sim/tick.js: returns plain event strings, and does nothing at all (no read of district state,
 * no write) when no gate is managed.
 *
 * @param {Kingdom} kingdom
 * @returns {string[]}
 */
export function runGateControlStep(kingdom) {
    return applyGateDecisions(kingdom).events;
}

/**
 * Manual override with persistence. `forced_closed` that would isolate or sever is refused unless `force`.
 *
 * @param {Kingdom} kingdom
 * @param {string} gateId
 * @param {string} mode one of GATE_MODES
 * @param {{ force?: boolean }} [options]
 * @returns {{ ok: boolean, reason: string | null, events: string[], physical: PhysicalChange[], decision: GateDecision | undefined }}
 */
export function setGateMode(kingdom, gateId, mode, options = {}) {
    /** @type {string[]} */
    const events = [];
    /** @type {PhysicalChange[]} */
    const physical = [];
    const found = findGate(kingdom, gateId);
    if (!found) {
        return { ok: false, reason: `no gate ${String(gateId)} in this kingdom`, events, physical, decision: undefined };
    }
    if (!GATE_MODES.includes(mode)) {
        return { ok: false, reason: `mode must be one of ${GATE_MODES.join("/")}`, events, physical, decision: undefined };
    }
    const { gate, owner } = found;
    if (gate.state === "broken" && mode !== "auto") {
        return { ok: false, reason: "the gate is broken; repair it before forcing it", events, physical, decision: undefined };
    }
    if (mode === "forced_closed" && options.force !== true && plannedState(gate) !== "sealed") {
        const impact = closeImpact(kingdom, gate);
        if (!impact.harmless) {
            const parts = [];
            if (impact.isolates.length > 0) {
                parts.push(`isolate ${impact.isolates.join(", ")}`);
            }
            if (impact.severs) {
                parts.push("split the open routes");
            }
            if (impact.strands.length > 0) {
                parts.push(`strand refugees (${impact.strands.join(", ")})`);
            }
            return { ok: false, reason: `closing it would ${parts.join(" and ")}; add 'force' to do it anyway`, events, physical, decision: undefined };
        }
    }
    gate.mode = mode;
    const decision = applyOne(kingdom, gate, owner, events, physical);
    return { ok: true, reason: null, events, physical, decision };
}

/**
 * The physical gates whose last completed state differs from the requested one, plus those that report a
 * reason for waiting. This is what the adapter polls.
 *
 * @param {Kingdom} kingdom
 * @returns {{ gateId: string, owner: string, from: string, to: string, blocked: string | undefined }[]}
 */
export function pendingPhysicalChanges(kingdom) {
    /** @type {{ gateId: string, owner: string, from: string, to: string, blocked: string | undefined }[]} */
    const list = [];
    for (const { gate, owner } of listGates(kingdom)) {
        const record = gate.physical;
        if (record !== null && typeof record === "object" && record.target !== undefined && record.target !== record.state) {
            list.push({ gateId: gate.id, owner: String(owner.id), from: String(record.state), to: String(record.target), blocked: typeof record.blocked === "string" ? record.blocked : undefined });
        }
    }
    return list;
}

/**
 * Called by the adapter when the blocks have really reached `visual`: records it, clears the request, and
 * brings the logical state in line (a broken gate stays broken).
 *
 * @param {Kingdom} kingdom
 * @param {string} gateId
 * @param {"open" | "closed"} visual
 * @returns {{ ok: boolean, logicalChanged: boolean, reason: string | null }}
 */
export function recordPhysicalResult(kingdom, gateId, visual) {
    const found = findGate(kingdom, gateId);
    if (!found || found.gate.physical === null || typeof found.gate.physical !== "object") {
        return { ok: false, logicalChanged: false, reason: `no physical gate ${String(gateId)}` };
    }
    if (!PHYSICAL_GATE_STATES.includes(visual)) {
        return { ok: false, logicalChanged: false, reason: `'${String(visual)}' is not a physical gate state` };
    }
    const { gate, owner } = found;
    gate.physical.state = visual;
    if (gate.physical.target === visual) {
        delete gate.physical.target;
    }
    delete gate.physical.blocked;
    let logicalChanged = false;
    if (gate.state !== "broken") {
        const logical = visual === "closed" ? "sealed" : "open";
        if (gate.state !== logical) {
            logEvent(kingdom, `${String(owner.name)}: gate ${String(gate.id)} ${String(gate.state)} -> ${logical} (the gate has ${visual === "closed" ? "closed" : "opened"}).`);
            gate.state = logical;
            logicalChanged = true;
        }
    }
    return { ok: true, logicalChanged, reason: null };
}

/**
 * Remember why a requested change has not happened yet (shown by civ:gate_list). Empty text clears it.
 *
 * @param {Kingdom} kingdom
 * @param {string} gateId
 * @param {string} text
 */
export function recordPhysicalBlocked(kingdom, gateId, text) {
    const found = findGate(kingdom, gateId);
    if (!found || found.gate.physical === null || typeof found.gate.physical !== "object") {
        return false;
    }
    if (text.length === 0) {
        delete found.gate.physical.blocked;
    } else {
        found.gate.physical.blocked = clip(text);
    }
    return true;
}

/**
 * Validation for the integrator to call from findValidationProblems: the optional fields only.
 *
 * @param {Kingdom} kingdom
 * @returns {string[]}
 */
export function validateGateRecords(kingdom) {
    /** @type {string[]} */
    const problems = [];
    for (const { gate, owner } of listGates(kingdom)) {
        const label = `${String(owner.id)}.gate ${String(gate.id)}`;
        if (gate.mode !== undefined && !GATE_MODES.includes(gate.mode)) {
            problems.push(`${label}.mode '${String(gate.mode)}' is not one of ${GATE_MODES.join("/")}`);
        }
        if (gate.physical !== undefined) {
            const record = gate.physical;
            if (record === null || typeof record !== "object" || Array.isArray(record)) {
                problems.push(`${label}.physical must be an object`);
                continue;
            }
            if (!PHYSICAL_GATE_STATES.includes(record.state)) {
                problems.push(`${label}.physical.state '${String(record.state)}' is not one of ${PHYSICAL_GATE_STATES.join("/")}`);
            }
            if (record.target !== undefined && !PHYSICAL_GATE_STATES.includes(record.target)) {
                problems.push(`${label}.physical.target '${String(record.target)}' is not one of ${PHYSICAL_GATE_STATES.join("/")}`);
            }
            if (record.blocked !== undefined && (typeof record.blocked !== "string" || record.blocked.length > 400)) {
                problems.push(`${label}.physical.blocked must be a string of at most 400 characters`);
            }
        }
    }
    return problems;
}
