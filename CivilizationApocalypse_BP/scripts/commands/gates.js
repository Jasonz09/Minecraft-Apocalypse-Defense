import { PHYSICAL_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { getGateAdapter } from "../integration/gateAdapter.js";
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
 *
 * `<id>` is the exact gate id, or any part of it that identifies exactly one gate.
 */
const IDS = /** @type {Record<string, string | undefined>} */ (PHYSICAL_EVENT_IDS);
const GATE_LIST = IDS.gateList ?? "civ:gate_list";
const GATE_OPEN = IDS.gateOpen ?? "civ:gate_open";
const GATE_CLOSE = IDS.gateClose ?? "civ:gate_close";
const GATE_AUTO = IDS.gateAuto ?? "civ:gate_auto";

/** @type {Record<string, string>} */
const MODE_OF = { [GATE_OPEN]: "forced_open", [GATE_CLOSE]: "forced_closed", [GATE_AUTO]: "auto" };

/**
 * Pure: resolve a user-typed reference to one gate id.
 * @param {any} kingdom
 * @param {string | undefined} reference
 * @returns {{ id: string | undefined, error: string | undefined }}
 */
export function resolveGateReference(kingdom, reference) {
    const gates = listGates(kingdom);
    const ids = gates.map((entry) => String(entry.gate.id));
    if (reference === undefined || reference.length === 0) {
        return { id: undefined, error: ids.length === 0 ? "this kingdom has no gates" : `name a gate: ${ids.join(", ")}` };
    }
    if (ids.includes(reference)) {
        return { id: reference, error: undefined };
    }
    const needle = reference.toLowerCase();
    const matches = ids.filter((id) => id.toLowerCase().includes(needle));
    if (matches.length === 1) {
        return { id: /** @type {string} */ (matches[0]), error: undefined };
    }
    if (matches.length > 1) {
        return { id: undefined, error: `'${reference}' matches several gates: ${matches.join(", ")}` };
    }
    return { id: undefined, error: `no gate matches '${reference}'. Gates: ${ids.join(", ") || "none"}` };
}

/**
 * Pure: the lines civ:gate_list prints.
 * @param {any} kingdom
 * @returns {string[]}
 */
export function formatGateLines(kingdom) {
    const gates = listGates(kingdom);
    if (gates.length === 0) {
        return ["=== Gates ===", "No gates in this kingdom."];
    }
    const lines = ["=== Gates ==="];
    for (const { gate, owner } of gates) {
        const partner = String(gate.with);
        const mode = gate.mode === undefined ? "unmanaged" : String(gate.mode);
        const physical = gate.physical && typeof gate.physical === "object" ? ` | blocks: ${String(gate.physical.state)}${gate.physical.target !== undefined ? ` -> ${String(gate.physical.target)}` : ""}` : "";
        lines.push(`${String(gate.id)}  ${String(owner.id)} <-> ${partner}  state ${String(gate.state ?? "open")}  mode ${mode}${physical}`);
        if (gate.physical && typeof gate.physical.blocked === "string") {
            lines.push(`    waiting: ${gate.physical.blocked}`);
        }
        if (gate.mode !== undefined || gate.physical) {
            const decision = decideGate(kingdom, gate);
            lines.push(`    policy says ${decision.desired}: ${decision.reasons[0] ?? "no reason recorded"}`);
        }
    }
    lines.push("Change one with: /scriptevent civ:gate_open <id>, civ:gate_close <id>, civ:gate_auto <id>");
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
    reply(formatGateLines(kingdom), event);
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
    const resolved = resolveGateReference(kingdom, reference);
    if (resolved.id === undefined) {
        reply(formatErrorLines(title, [String(resolved.error), `Usage: /scriptevent ${event.id} <gate-id>${mode === "forced_closed" ? " [force]" : ""}`]), event);
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
