import { PHYSICAL_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { unitsOfGate } from "../civ/gatelink.js";
import { describeAgreement, startGateSelfTest } from "../integration/civGates.js";
import { getGateAdapter, readGateRecord, readGateRegistry, setUnmanagedMode } from "../integration/gateAdapter.js";
import { GATE_MODES, decideGate, findGate, listGates, setGateMode } from "../sim/gatecontrol.js";
import { formatErrorLines, formatMissingKingdomLines, formatRefusedKingdomLines } from "../ui/report.js";
import { parseArgs } from "./args.js";
import { reply } from "./reply.js";
import { system } from "@minecraft/server";

/**
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ScriptEvent
 */

let registered = false;

/**
 * Gate commands (ids have exactly ONE colon). The integrator registers them in config.js as
 * PHYSICAL_EVENT_IDS.gateList = "civ:gate_list", PHYSICAL_EVENT_IDS.gateOpen = "civ:gate_open",
 * PHYSICAL_EVENT_IDS.gateClose = "civ:gate_close" and PHYSICAL_EVENT_IDS.gateAuto = "civ:gate_auto";
 * until then the literals below are used, so the module works either way.
 *
 *   civ:gate_list                 every gate: logical state, mode, physical state, why it is waiting
 *   civ:gate_open  <id>           hold the gate open (manual override, persists)
 *   civ:gate_close <id> [force]   hold the gate closed; refused when it would isolate or split districts
 *                                 unless `force` is given
 *   civ:gate_auto  <id>           give the gate back to the automatic policy
 *   civ:gate_status [id]          logical state, physical state, mode, why it waits, position and clearance,
 *                                 and whether the kingdom, the civ_gate_* records and the real blocks agree
 *   civ:gate_test  <id>           safe self test as a job: close, verify sealed, reopen, verify passable
 *                                 (PHYSICAL_EVENT_IDS.gateStatus / PHYSICAL_EVENT_IDS.gateTest)
 *
 * `<id>` is the exact gate id, or any part of it that identifies exactly one gate. A gate the site plan placed
 * (`gate-5`, `gate-7`, ...) is addressed by its plan id: a companion (`gate-6`) moves together with the simulation
 * gate it belongs to; an outer/field gate the simulation does not know stays open unless you close it here.
 */
const IDS = /** @type {Record<string, string | undefined>} */ (PHYSICAL_EVENT_IDS);
const GATE_LIST = IDS.gateList ?? "civ:gate_list";
const GATE_OPEN = IDS.gateOpen ?? "civ:gate_open";
const GATE_CLOSE = IDS.gateClose ?? "civ:gate_close";
const GATE_AUTO = IDS.gateAuto ?? "civ:gate_auto";
const GATE_STATUS = IDS.gateStatus ?? "civ:gate_status";
const GATE_TEST = IDS.gateTest ?? "civ:gate_test";

/** @type {Record<string, string>} */
const MODE_OF = { [GATE_OPEN]: "forced_open", [GATE_CLOSE]: "forced_closed", [GATE_AUTO]: "auto" };

/**
 * Pure: every name a player may type, and what it controls. Simulation gate ids control themselves; the plan id of
 * a physical gate controls the simulation gate it belongs to (a companion moves with its primary); the plan id of
 * a gate the simulation does not know controls that gate alone.
 *
 * @param {any} kingdom
 * @param {import("../civ/gatelink.js").GateRegistry | undefined} registry
 * @returns {Map<string, { id: string, kind: "sim" | "unmanaged", alias: string | undefined }>}
 */
function gateNames(kingdom, registry) {
    /** @type {Map<string, { id: string, kind: "sim" | "unmanaged", alias: string | undefined }>} */
    const names = new Map();
    const gates = listGates(kingdom);
    for (const { gate } of gates) {
        names.set(String(gate.id), { id: String(gate.id), kind: "sim", alias: undefined });
    }
    for (const { gate } of gates) {
        for (const unit of unitsOfGate(gate)) {
            if (unit.planId !== null && !names.has(unit.planId)) {
                names.set(unit.planId, { id: String(gate.id), kind: "sim", alias: unit.planId });
            }
        }
    }
    for (const entry of registry?.gates ?? []) {
        if (names.has(entry.id)) {
            continue;
        }
        if (entry.role === "unmanaged") {
            names.set(entry.id, { id: entry.id, kind: "unmanaged", alias: undefined });
        } else if (entry.simGateId !== null && gates.some(({ gate }) => gate.id === entry.simGateId)) {
            names.set(entry.id, { id: String(entry.simGateId), kind: "sim", alias: entry.id });
        }
    }
    return names;
}

/**
 * Pure: resolve a user-typed reference to one gate id (a simulation gate id, or the plan id of an unmanaged gate).
 * @param {any} kingdom
 * @param {string | undefined} reference
 * @param {import("../civ/gatelink.js").GateRegistry} [registry]
 * @returns {{ id: string | undefined, error: string | undefined, kind?: "sim" | "unmanaged", alias?: string }}
 */
export function resolveGateReference(kingdom, reference, registry) {
    const names = gateNames(kingdom, registry);
    const real = [...names.entries()].filter(([, target]) => target.alias === undefined).map(([name]) => name);
    if (reference === undefined || reference.length === 0) {
        return { id: undefined, error: real.length === 0 ? "this kingdom has no gates" : `name a gate: ${real.join(", ")}` };
    }
    const exact = names.get(reference);
    if (exact !== undefined) {
        return { id: exact.id, error: undefined, kind: exact.kind, ...(exact.alias === undefined ? {} : { alias: exact.alias }) };
    }
    const needle = reference.toLowerCase();
    const matches = [...names.keys()].filter((name) => name.toLowerCase().includes(needle));
    const targets = new Set(matches.map((name) => /** @type {{ id: string }} */ (names.get(name)).id));
    if (targets.size === 1) {
        const hit = /** @type {{ id: string, kind: "sim" | "unmanaged", alias: string | undefined }} */ (names.get(/** @type {string} */ (matches[0])));
        return { id: hit.id, error: undefined, kind: hit.kind, ...(hit.alias === undefined ? {} : { alias: hit.alias }) };
    }
    if (matches.length > 1) {
        return { id: undefined, error: `'${reference}' matches several gates: ${matches.join(", ")}` };
    }
    return { id: undefined, error: `no gate matches '${reference}'. Gates: ${real.join(", ") || "none"}` };
}

/**
 * Pure: the lines civ:gate_list prints.
 * @param {any} kingdom
 * @param {{ registry?: import("../civ/gatelink.js").GateRegistry, recordOf?: (id: string) => { actual: string } | undefined }} [extras]
 * @returns {string[]}
 */
export function formatGateLines(kingdom, extras = {}) {
    const gates = listGates(kingdom);
    const unmanaged = (extras.registry?.gates ?? []).filter((entry) => entry.role === "unmanaged");
    if (gates.length === 0 && unmanaged.length === 0) {
        return ["=== Gates ===", "No gates in this kingdom."];
    }
    const lines = ["=== Gates ==="];
    for (const { gate, owner } of gates) {
        const partner = String(gate.with);
        const mode = gate.mode === undefined ? "unmanaged" : String(gate.mode);
        const physical = gate.physical && typeof gate.physical === "object" ? ` | blocks: ${String(gate.physical.state)}${gate.physical.target !== undefined ? ` -> ${String(gate.physical.target)}` : ""}` : "";
        lines.push(`${String(gate.id)}  ${String(owner.id)} <-> ${partner}  state ${String(gate.state ?? "open")}  mode ${mode}${physical}`);
        const units = unitsOfGate(gate);
        if (units.length > 1) {
            lines.push(`    moves together: ${units.map((unit) => `${unit.planId ?? unit.id} (${unit.purpose})`).join(", ")}`);
        } else if (units.length === 1 && units[0] && units[0].planId !== null) {
            lines.push(`    plan gate: ${units[0].planId} (${units[0].purpose})`);
        }
        if (gate.physical && typeof gate.physical.blocked === "string") {
            lines.push(`    waiting: ${gate.physical.blocked}`);
        }
        if (gate.mode !== undefined || gate.physical) {
            const decision = decideGate(kingdom, gate);
            lines.push(`    policy says ${decision.desired}: ${decision.reasons[0] ?? "no reason recorded"}`);
        }
    }
    if (unmanaged.length > 0) {
        lines.push("Physical-only gates (not part of the simulation; open unless a command closes them):");
        for (const entry of unmanaged) {
            const actual = extras.recordOf?.(entry.id)?.actual ?? "open";
            lines.push(`${entry.id}  ${entry.purpose}  districts ${entry.between.join("-")}  mode ${entry.mode ?? "auto"}  blocks: ${actual}  at ${String(entry.spec.at.x)} ${String(entry.spec.y)} ${String(entry.spec.at.z)}`);
        }
    }
    lines.push("Change one with: /scriptevent civ:gate_open <id>, civ:gate_close <id>, civ:gate_auto <id>; inspect with civ:gate_status <id>, civ:gate_test <id>");
    return lines;
}

/**
 * Pure: the lines civ:gate_status <id> prints, from a read-only inspection (adapter.inspect).
 * @param {any} kingdom
 * @param {string} gateId
 * @param {any} inspection result of adapter.inspect(gateId)
 * @param {import("../civ/gatelink.js").GateRegistry} [registry]
 * @returns {string[]}
 */
export function formatGateStatusLines(kingdom, gateId, inspection, registry) {
    const found = findGate(kingdom, gateId);
    const entry = (registry?.gates ?? []).find((candidate) => candidate.id === gateId && candidate.role === "unmanaged");
    /** @type {string[]} */
    const lines = [`=== Gate status: ${gateId} ===`];
    if (found) {
        const gate = found.gate;
        const physical = gate.physical && typeof gate.physical === "object" ? gate.physical : undefined;
        lines.push(`Logical state: ${String(gate.state ?? "open")}   Mode: ${gate.mode === undefined ? "unmanaged" : String(gate.mode)}   Between: ${String(found.owner.id)} <-> ${String(gate.with)}`);
        if (physical) {
            lines.push(`Physical (kingdom): ${String(physical.state)}${physical.target !== undefined ? ` -> ${String(physical.target)} requested` : ""}`);
            lines.push(`Blocked: ${typeof physical.blocked === "string" ? physical.blocked : "no"}`);
        } else {
            lines.push("Physical: this simulation gate has no physical gate (logical only).");
        }
        const decision = decideGate(kingdom, gate);
        lines.push(`Policy says ${decision.desired}: ${decision.reasons[0] ?? "no reason recorded"}`);
    } else if (entry) {
        lines.push(`Outside the simulation (${entry.purpose} gate, districts ${entry.between.join("-")}). Mode: ${entry.mode ?? "auto"} (open unless closed by command).`);
    }
    if (!inspection.ok) {
        lines.push(`Blocks: cannot inspect (${String(inspection.error)})`);
        return lines;
    }
    for (const unit of /** @type {any[]} */ (inspection.units)) {
        const spec = unit.spec;
        const lattice = unit.lattice;
        lines.push(`Unit ${String(unit.id)} (${String(unit.purpose)}${unit.primary ? "" : ", companion"}): blocks ${lattice === undefined ? "unreadable" : String(lattice.state)}${lattice && lattice.state !== "unloaded" ? ` (${String(lattice.bars)}/${String(lattice.cells)} bars)` : ""}, adapter record ${unit.record === undefined ? "none" : String(unit.record.actual)}${unit.record && unit.record.reason ? ` - ${String(unit.record.reason)}` : ""}`);
        lines.push(`    position x ${String(spec.at.x)} z ${String(spec.at.z)} walking level y ${String(spec.y)}, wall axis ${String(spec.axis)}, ${String(spec.dimension ?? "overworld")}`);
        if (unit.box) {
            lines.push(`    clearance x ${String(unit.box.min.x)}..${String(unit.box.max.x)} y ${String(unit.box.min.y)}..${String(unit.box.max.y)} z ${String(unit.box.min.z)}..${String(unit.box.max.z)}: ${unit.blockers.length === 0 ? "empty" : `${String(unit.blockers.length)} in the way (${unit.blockers.slice(0, 3).map((/** @type {any} */ blocker) => String(blocker.name)).join(", ")})`}`);
        }
        if (lattice && lattice.state === "foreign") {
            lines.push(`    foreign block: ${String(lattice.firstForeign)}`);
        }
    }
    if (found && found.gate.physical && typeof found.gate.physical === "object") {
        const agreement = describeAgreement(found.gate.physical, inspection.units);
        lines.push(agreement.agree ? `Kingdom, adapter records and blocks agree${agreement.moving ? " (a move is in progress)" : ""}.` : `DISAGREEMENT: ${agreement.problems.join("; ")}`);
    }
    return lines;
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {import("../integration/gateAdapter.js").GateAdapter} [adapter]
 */
export function registerGateCommands(kingdomStore, adapter = getGateAdapter(kingdomStore)) {
    if (registered) {
        return;
    }
    registered = true;

    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (event.id === GATE_LIST) {
            handleList(kingdomStore, event);
        } else if (event.id === GATE_OPEN || event.id === GATE_CLOSE || event.id === GATE_AUTO) {
            handleChange(kingdomStore, adapter, event);
        } else if (event.id === GATE_STATUS) {
            handleStatus(kingdomStore, adapter, event);
        } else if (event.id === GATE_TEST) {
            handleTest(kingdomStore, adapter, event);
        }
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
    adapter.start();
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handleList(kingdomStore, event) {
    const { kingdom, reason, status } = kingdomStore.load();
    if (!kingdom) {
        reply(status === "newer" || status === "unsupported" ? formatRefusedKingdomLines(reason) : formatMissingKingdomLines(reason), event);
        return;
    }
    reply(formatGateLines(kingdom, { registry: readGateRegistry(), recordOf: readGateRecord }), event);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {import("../integration/gateAdapter.js").GateAdapter} adapter
 * @param {ScriptEvent} event
 */
function handleStatus(kingdomStore, adapter, event) {
    const title = "Gate status refused";
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatMissingKingdomLines(loaded.reason), event);
        return;
    }
    const registry = readGateRegistry();
    const args = parseArgs(event.message);
    if (args.length === 0) {
        const lines = ["=== Gate status ==="];
        for (const { gate } of listGates(loaded.kingdom)) {
            if (gate.physical && typeof gate.physical === "object") {
                const record = readGateRecord(String(gate.id));
                lines.push(`${String(gate.id)}  logical ${String(gate.state ?? "open")}  blocks ${String(gate.physical.state)}${gate.physical.target !== undefined ? ` -> ${String(gate.physical.target)}` : ""}  mode ${String(gate.mode ?? "unmanaged")}${adapter.isRunning(String(gate.id)) ? "  MOVING" : ""}${record?.actual === "partial" ? "  interrupted" : ""}${typeof gate.physical.blocked === "string" ? `  waiting: ${gate.physical.blocked}` : ""}`);
            }
        }
        for (const entry of registry.gates.filter((candidate) => candidate.role === "unmanaged")) {
            lines.push(`${entry.id}  outside the simulation  blocks ${readGateRecord(entry.id)?.actual ?? "open"}  mode ${entry.mode ?? "auto"}`);
        }
        lines.push(lines.length === 1 ? "No physical gates are registered yet." : "Details: /scriptevent civ:gate_status <id>");
        reply(lines, event);
        return;
    }
    const resolved = resolveGateReference(loaded.kingdom, args[0], registry);
    if (resolved.id === undefined) {
        reply(formatErrorLines(title, [String(resolved.error), `Usage: /scriptevent ${event.id} [gate-id]`]), event);
        return;
    }
    reply(formatGateStatusLines(loaded.kingdom, resolved.id, adapter.inspect(resolved.id), registry), event);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {import("../integration/gateAdapter.js").GateAdapter} adapter
 * @param {ScriptEvent} event
 */
function handleTest(kingdomStore, adapter, event) {
    const title = "Gate self test refused";
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatMissingKingdomLines(loaded.reason), event);
        return;
    }
    const resolved = resolveGateReference(loaded.kingdom, parseArgs(event.message)[0], readGateRegistry());
    if (resolved.id === undefined) {
        reply(formatErrorLines(title, [String(resolved.error), `Usage: /scriptevent ${event.id} <gate-id>`]), event);
        return;
    }
    const started = startGateSelfTest(adapter, kingdomStore, resolved.id, (report) => reply(report.lines, event));
    if (!started.ok) {
        reply(formatErrorLines(title, [String(started.reason)]), event);
        return;
    }
    reply([`=== Gate self test: ${resolved.id} ===`, "Started: close, verify sealed, reopen, verify passable. The gate is restored when it finishes; the result follows in this chat."], event);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {import("../integration/gateAdapter.js").GateAdapter} adapter
 * @param {ScriptEvent} event
 */
function handleChange(kingdomStore, adapter, event) {
    const mode = /** @type {string} */ (MODE_OF[event.id]);
    const verb = mode === "forced_open" ? "open" : mode === "forced_closed" ? "close" : "auto";
    const title = `Gate ${verb} refused`;
    if (!GATE_MODES.includes(mode)) {
        reply(formatErrorLines(title, ["internal error: unknown mode"]), event);
        return;
    }
    const args = parseArgs(event.message);
    const force = args.includes("force");
    const reference = args.find((arg) => arg !== "force");
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatMissingKingdomLines(loaded.reason), event);
        return;
    }
    const kingdom = loaded.kingdom;
    const resolved = resolveGateReference(kingdom, reference, readGateRegistry());
    if (resolved.id === undefined) {
        reply(formatErrorLines(title, [String(resolved.error), `Usage: /scriptevent ${event.id} <gate-id>${mode === "forced_closed" ? " [force]" : ""}`]), event);
        return;
    }
    if (resolved.kind === "unmanaged") {
        // A gate the simulation does not know: its mode lives in the registry; open unless forced closed.
        if (!setUnmanagedMode(resolved.id, mode)) {
            reply(formatErrorLines(title, [`could not record the mode of ${resolved.id}`]), event);
            return;
        }
        adapter.retryNow(resolved.id);
        adapter.pump();
        reply([
            `=== Gate ${resolved.id} ===`,
            `Mode is now ${mode} (this gate is outside the simulation).`,
            mode === "forced_closed" ? "The portcullis is closing (it waits if anyone is standing in the gateway)." : "The portcullis is open or opening; it stays open unless you close it.",
        ], event);
        return;
    }
    const outcome = setGateMode(kingdom, resolved.id, mode, { force });
    if (!outcome.ok) {
        reply(formatErrorLines(title, [String(outcome.reason)]), event);
        return;
    }
    try {
        kingdomStore.save(kingdom);
    } catch (error) {
        reply(formatErrorLines(title, [`could not save the kingdom: ${String(error)}`]), event);
        return;
    }
    const found = findGate(kingdom, resolved.id);
    const lines = [`=== Gate ${resolved.id} ===`, `Mode is now ${mode}.`];
    if (resolved.alias !== undefined && resolved.alias !== resolved.id) {
        lines.push(`${resolved.alias} belongs to ${resolved.id}; they move together.`);
    }
    if (found && found.gate.physical && typeof found.gate.physical === "object") {
        if (outcome.physical.length > 0) {
            const change = /** @type {{ to: string }} */ (outcome.physical[0]);
            lines.push(`The portcullis is ${change.to === "closed" ? "closing" : "opening"} (it waits if anyone is standing in the gateway).`);
            adapter.retryNow(resolved.id);
            adapter.pump();
        } else {
            lines.push("The gate is already where that mode wants it.");
        }
    } else {
        lines.push(`Logical state: ${String(found?.gate.state)}.`);
    }
    if (outcome.decision && outcome.decision.reasons.length > 0) {
        lines.push(`Because: ${String(outcome.decision.reasons[0])}`);
    }
    reply(lines, event);
}
