import { districtById } from "../kingdom/state.js";
import { closeImpact, decideGate, findGate, listGates } from "../sim/gatecontrol.js";
import { evaluateExpansion } from "../sim/expansion.js";
import { assemble, orNone } from "./frames.js";
import { disabledButton, enabledButton, navButton, notImplemented } from "./model.js";
import { whole } from "./text.js";

/**
 * The menus about building and control: Construction, Expansion, Policies, Gates and a gate card.
 * Pure, like menus-kingdom.js: they read the kingdom and the optional live status and never change
 * anything. Every mutating button names the action that the runtime will confirm first.
 *
 * @typedef {import("./model.js").Button} Button
 * @typedef {{ menu: string, params: Record<string, unknown>, page: number }} Frame
 * @typedef {{ civ?: any, gates?: any }} Live
 */

const POLICY_MODE_WORDS = Object.freeze({ balanced: "Balanced", paused: "Paused", rapid: "Rapid" });
const GATE_MODE_WORDS = Object.freeze({ auto: "automatic", forced_open: "held open", forced_closed: "held closed" });

/**
 * @param {Frame} frame
 * @param {any} kingdom
 * @param {Live | undefined} live
 */
export function constructionMenu(frame, kingdom, live) {
    const civ = live?.civ;
    const session = civ?.session;
    /** @type {string[]} */
    const lines = [];
    if (live === undefined) {
        lines.push("Live job status is unavailable in this build.");
    } else if (session !== undefined) {
        lines.push(`Running: district-${String(session.district)}, ${String(session.status)}, stage ${String(session.stage)}`);
        lines.push(`Progress ${String(session.pct)}% (${String(session.done)} of ${String(session.total)} operations)`);
    } else if (civ?.busy !== undefined) {
        lines.push(`A ${String(civ.busy)} job is running (not a civilization build).`);
    } else {
        lines.push("No civilization build is running.");
    }
    lines.push("Districts:");
    for (const district of /** @type {any[]} */ (kingdom.districts)) {
        const generated = district.civ;
        const physical = district.physical;
        lines.push(
            `${String(district.name)}: civilization ${generated === undefined ? "not started" : `${String(generated.status)} stage ${String(generated.stage)}`}`,
        );
        lines.push(
            `  physical ${physical === undefined ? "no record" : `${String(physical.status)} ${String(physical.placed)} of ${String(physical.total)} blocks`}`,
        );
        const origin = physical?.origin;
        const centre = generated?.centre;
        if (origin !== undefined) {
            lines.push(`  centre ${String(origin.x)} ${String(origin.y)} ${String(origin.z)}`);
            lines.push(`  teleport: /tp @s ${String(origin.x)} ${String(origin.y)} ${String(origin.z)}`);
        } else if (centre !== undefined) {
            lines.push(`  centre ${String(centre.x)} ~ ${String(centre.z)}`);
            lines.push(`  teleport: /tp @s ${String(centre.x)} ~ ${String(centre.z)}`);
        }
    }

    const resumable = civ?.resumable;
    const abortButton =
        live === undefined
            ? disabledButton("abort", "Stop the build", "live job status is unavailable")
            : session !== undefined
                ? enabledButton("abort", "Stop the build", { id: "construction.abort" })
                : disabledButton("abort", "Stop the build", "no civilization build is running");
    let resumeButton;
    if (live === undefined) {
        resumeButton = disabledButton("resume", "Resume a build", "live job status is unavailable");
    } else if (civ?.busy !== undefined || session !== undefined) {
        resumeButton = disabledButton("resume", "Resume a build", "a job is already running");
    } else if (resumable?.index === undefined) {
        resumeButton = disabledButton("resume", "Resume a build", String(resumable?.reason ?? "nothing to resume"));
    } else {
        resumeButton = enabledButton(`resume:${String(resumable.index)}`, `Resume district-${String(resumable.index)}`, {
            id: "construction.resume",
            params: { district: Number(resumable.index) },
        });
    }
    return assemble(frame, {
        title: "Construction",
        lines,
        content: [
            abortButton,
            resumeButton,
            notImplemented("other-buildings", "Place other buildings"),
            notImplemented("districts-2-5", "Build districts 2 to 5"),
        ],
    });
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 */
export function expansionMenu(frame, kingdom) {
    /** @type {string[]} */
    const lines = [`Expansion policy: ${String(kingdom.policy.expansion)}`];
    for (const land of /** @type {any[]} */ (kingdom.territory ?? [])) {
        const verdict = evaluateExpansion(kingdom, String(land.id));
        lines.push(`${String(land.name)}: ${String(land.status)}, survey ${String(whole(land.surveyProgress))}%, needs ${String(land.garrisonRequirement)} troops`);
        if (verdict.eligible) {
            lines.push("  Eligible: the next step may claim it.");
        } else {
            lines.push(`  Blocked: ${String(verdict.reasons[0] ?? "no reason recorded")}${verdict.reasons.length > 1 ? ` (+${String(verdict.reasons.length - 1)} more)` : ""}`);
        }
    }
    if ((kingdom.territory ?? []).length === 0) {
        lines.push("No territory is known.");
    }
    return assemble(frame, {
        title: "Expansion",
        lines,
        content: [
            navButton("open-policies", "Change the policy", "policies"),
            notImplemented("claim", "Claim land by hand"),
        ],
    });
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 * @param {Live | undefined} live
 */
export function policiesMenu(frame, kingdom, live) {
    const current = String(kingdom.policy.expansion);
    /** @type {string[]} */
    const lines = [
        `Expansion: ${current}`,
        `Reinforcements keep ${String(whole(Number(kingdom.policy.reinforcementKeepFraction) * 100))}% home (read only)`,
        `Breach: integrity below ${String(kingdom.policy.breachIntegrity)}%; falls after ${String(kingdom.policy.fallAfterSiegeSteps)} unrelieved steps`,
        "Gate modes are set on each gate's card.",
    ];
    /** @type {Button[]} */
    const content = ["balanced", "paused", "rapid"].map((mode) =>
        current === mode
            ? disabledButton(`policy-${mode}`, `${POLICY_MODE_WORDS[/** @type {keyof typeof POLICY_MODE_WORDS} */ (mode)]} (current)`, `already ${mode}`)
            : enabledButton(`policy-${mode}`, `Set ${POLICY_MODE_WORDS[/** @type {keyof typeof POLICY_MODE_WORDS} */ (mode)]}`, { id: "policy.expansion", params: { mode } }),
    );
    for (const { gate } of listGates(kingdom)) {
        content.push(navButton(`gate:${String(gate.id)}`, `Gate ${String(gate.id)}`, "gate", { gateId: String(gate.id) }));
    }
    for (const entry of unmanagedOf(live)) {
        content.push(navButton(`gate:${entry.id}`, `Gate ${entry.id}`, "gate", { gateId: entry.id }));
    }
    return assemble(frame, { title: "Policies", lines, content });
}

/**
 * @param {Live | undefined} live
 * @returns {{ id: string, purpose: string, between: string[], mode?: string, actual: string }[]}
 */
function unmanagedOf(live) {
    return /** @type {any[]} */ (live?.gates?.unmanaged ?? []);
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 * @param {Live | undefined} live
 */
export function gatesMenu(frame, kingdom, live) {
    /** @type {string[]} */
    const lines = [];
    /** @type {Button[]} */
    const content = [];
    for (const { gate, owner } of listGates(kingdom)) {
        const mode = gate.mode === undefined ? "unmanaged" : String(gate.mode);
        lines.push(`${String(gate.id)}: ${String(owner.id)} and ${String(gate.with)}, ${String(gate.state ?? "open")}, ${mode}`);
        content.push(navButton(`gate:${String(gate.id)}`, `Gate ${String(gate.id)}`, "gate", { gateId: String(gate.id) }));
    }
    for (const entry of unmanagedOf(live)) {
        lines.push(`${entry.id}: outside the simulation, ${entry.actual}, ${entry.mode ?? "auto"}`);
        content.push(navButton(`gate:${entry.id}`, `Gate ${entry.id}`, "gate", { gateId: entry.id }));
    }
    if (lines.length === 0) {
        lines.push("No gates in this kingdom.");
    }
    return assemble(frame, { title: "Gates", lines, content });
}

/**
 * The gate card: the simulation's view, the physical blocks and the buttons that change the mode.
 * @param {Frame} frame
 * @param {any} kingdom
 * @param {Live | undefined} live
 */
export function gateMenu(frame, kingdom, live) {
    const gateId = String(frame.params.gateId ?? "");
    const found = findGate(kingdom, gateId);
    if (found !== undefined) {
        return simGateCard(frame, kingdom, live, found);
    }
    const entry = unmanagedOf(live).find((candidate) => candidate.id === gateId);
    if (entry !== undefined) {
        return unmanagedGateCard(frame, entry);
    }
    return assemble(frame, { title: "Gate", lines: [`No gate ${gateId} in this kingdom.`], content: [] });
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 * @param {Live | undefined} live
 * @param {{ gate: any, owner: any }} found
 */
function simGateCard(frame, kingdom, live, found) {
    const { gate, owner } = found;
    const broken = gate.state === "broken";
    const mode = gate.mode === undefined ? "unmanaged" : String(gate.mode);
    const physical = gate.physical && typeof gate.physical === "object" ? gate.physical : undefined;
    const moving = Array.isArray(live?.gates?.moving) && live?.gates?.moving.includes(String(gate.id));
    const decision = decideGate(kingdom, gate);
    const impact = broken ? undefined : closeImpact(kingdom, gate);
    const harmless = impact === undefined || impact.harmless;
    /** @type {string[]} */
    const lines = [
        `Between ${String(owner.name)} and ${nameOf(kingdom, gate.with)}`,
        `Logical state: ${String(gate.state ?? "open")}; mode: ${mode === "unmanaged" ? "not policy-managed" : GATE_MODE_WORDS[/** @type {keyof typeof GATE_MODE_WORDS} */ (mode)] ?? mode}`,
        physical === undefined
            ? "Blocks: logical only (no physical gate)"
            : `Blocks: ${String(physical.state)}${physical.target !== undefined ? `, moving to ${String(physical.target)}` : ""}`,
    ];
    if (physical !== undefined && typeof physical.blocked === "string") {
        lines.push(`Waiting: ${String(physical.blocked)}`);
    }
    lines.push(`Policy says ${String(decision.desired)}: ${String(decision.reasons[0] ?? "no reason recorded")}`);
    if (moving) {
        lines.push("The blocks are moving now.");
    }
    if (impact !== undefined && !harmless) {
        lines.push(`Closing now would ${impactWords(impact)}.`);
    }

    const brokenReason = "the gate is broken: repair it first";
    const holdOpen = broken
        ? disabledButton("hold-open", "Hold open", brokenReason)
        : mode === "forced_open"
            ? disabledButton("hold-open", "Hold open", "already held open")
            : enabledButton("hold-open", "Hold open", { id: "gate.mode", params: { gateId: String(gate.id), mode: "forced_open" } });
    const holdClosed = broken
        ? disabledButton("hold-closed", "Hold closed", brokenReason)
        : mode === "forced_closed"
            ? disabledButton("hold-closed", "Hold closed", "already held closed")
            : harmless
                ? enabledButton("hold-closed", "Hold closed", { id: "gate.mode", params: { gateId: String(gate.id), mode: "forced_closed" } })
                : disabledButton("hold-closed", "Hold closed", `closing would ${impactWords(impact)}; use the forced option`);
    const closeAnyway =
        broken
            ? disabledButton("close-forced", "Close anyway (forced)", brokenReason)
            : harmless
                ? disabledButton("close-forced", "Close anyway (forced)", "closing is harmless: use Hold closed")
                : enabledButton("close-forced", "Close anyway (forced)", { id: "gate.mode", params: { gateId: String(gate.id), mode: "forced_closed", force: true } });
    const automatic = broken
        ? disabledButton("automatic", "Return to automatic", brokenReason)
        : mode === "auto"
            ? disabledButton("automatic", "Return to automatic", "already automatic")
            : enabledButton("automatic", "Return to automatic", { id: "gate.mode", params: { gateId: String(gate.id), mode: "auto" } });
    const selfTest =
        physical === undefined
            ? disabledButton("self-test", "Run a self test", "this gate has no physical blocks")
            : broken
                ? disabledButton("self-test", "Run a self test", "the gate is broken: repair it first")
                : moving
                    ? disabledButton("self-test", "Run a self test", "the gate is moving")
                    : enabledButton("self-test", "Run a self test", { id: "gate.test", params: { gateId: String(gate.id) } });
    return assemble(frame, {
        title: `Gate ${String(gate.id)}`,
        lines,
        content: [holdOpen, holdClosed, closeAnyway, automatic, selfTest],
    });
}

/**
 * A gate the simulation does not know: its mode lives in the physical registry.
 * @param {Frame} frame
 * @param {{ id: string, purpose: string, between: string[], mode?: string, actual: string }} entry
 */
function unmanagedGateCard(frame, entry) {
    const mode = entry.mode ?? "auto";
    const set = (/** @type {string} */ id, /** @type {string} */ text, /** @type {string} */ target) =>
        mode === target
            ? disabledButton(id, text, `already ${GATE_MODE_WORDS[/** @type {keyof typeof GATE_MODE_WORDS} */ (target)] ?? target}`)
            : enabledButton(id, text, { id: "gate.unmanaged", params: { gateId: entry.id, mode: target } });
    return assemble(frame, {
        title: `Gate ${entry.id}`,
        lines: [
            `Outside the simulation (${entry.purpose}).`,
            `Between ${entry.between.join(" and ")}; mode ${mode}`,
            `Blocks: ${entry.actual}`,
        ],
        content: [
            set("hold-open", "Hold open", "forced_open"),
            set("hold-closed", "Hold closed", "forced_closed"),
            set("automatic", "Return to automatic", "auto"),
        ],
    });
}

/**
 * @param {any} kingdom
 * @param {unknown} id
 */
function nameOf(kingdom, id) {
    const district = districtById(kingdom, String(id));
    return district === undefined ? orNone(id, "unknown") : String(district.name);
}

/**
 * @param {any} entry
 * @returns {string}
 */
function impactWords(entry) {
    /** @type {string[]} */
    const parts = [];
    if (entry.isolates.length > 0) {
        parts.push(`isolate ${entry.isolates.join(", ")}`);
    }
    if (entry.severs) {
        parts.push("split the open routes");
    }
    if (entry.strands.length > 0) {
        parts.push(`strand refugees (${entry.strands.join(", ")})`);
    }
    return parts.join(" and ") || "change nothing else";
}
