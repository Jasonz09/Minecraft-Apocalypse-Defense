import { CIV_EVENT_IDS, POLICY_MODES, POPULATION_DEFAULTS } from "../config.js";
import { canAfford, districtById } from "../kingdom/state.js";
import { closeImpact, findGate, setGateMode } from "../sim/gatecontrol.js";
import { eligibleRecruits, openRecruitment } from "../sim/population.js";
import { POLICY_DECISION_RULES } from "../sim/policies.js";
import { sanitize } from "./text.js";

/**
 * Every action a Ledger button can name. An action id maps to exactly one spec here, and every spec
 * either navigates (`nav.*`, pure) or changes the world (`kind: "mutate"`).
 *
 * Mutating specs:
 *  - have `describe(kingdom, params, live)` that names the exact effect for the confirm menu;
 *  - have `run(ctx, params)` that calls the EXISTING game function the matching command calls. Direct
 *    imports are listed in `calls`; functions that live in server-bound modules are reached through
 *    `services` (the binding passes them in). Nothing here re-implements a rule of the simulation;
 *  - are reached only through a confirm menu (see menus.js buildConfirmModel and the runtime);
 *  - list the adapter/command services they need in `services`. The binding that imports the
 *    server-bound modules passes them in as `ctx.services` (contract: SERVICE_CONTRACT below).
 *
 * `ctx` for a run is `{ kingdom, services, player, tell }`. `kingdom` is a private copy: the runtime
 * saves it only when the outcome is ok and `touchesKingdom` is set. `afterSave` runs after that save,
 * so physical gate work sees the saved state, the same order the gate commands use.
 *
 * This module imports only pure modules (config, kingdom/state, sim/*): it can be loaded offline.
 */

/**
 * The services a binding must provide. Each function is a thin wrapper over an existing export:
 *   gates.retryNow(gateId)                 integration/gateAdapter.js  adapter.retryNow
 *   gates.pump()                           integration/gateAdapter.js  adapter.pump
 *   gates.setUnmanagedMode(gateId, mode)   integration/gateAdapter.js  setUnmanagedMode
 *   gates.startSelfTest(gateId, done)      integration/civGates.js     startGateSelfTest(adapter, store, id, done)
 *   civ.abort()                            integration/civBuilder.js   abortCivJob
 *   civ.abortLines(result, resumeId)       integration/civBuilder.js   civAbortLines
 *   civ.resume(player, districtIndex)      runs `civ:generate_resume district=N` as the player (commands/civ.js)
 */
export const SERVICE_CONTRACT = Object.freeze({
    gates: ["retryNow", "pump", "setUnmanagedMode", "startSelfTest"],
    civ: ["abort", "abortLines", "resume"],
});

const EXPANSION_EFFECT = Object.freeze({
    balanced: "Balanced: full surplus margins; new land needs stores for its first stage.",
    paused: "Paused: no land is occupied or claimed; existing walls and districts stay.",
    rapid: "Rapid: resource margins are relaxed; security checks still apply.",
});

const MODE_WORDS = Object.freeze({
    auto: "automatic",
    forced_open: "held open",
    forced_closed: "held closed",
});

/**
 * @typedef {{ kingdom: any, services?: any, player?: any, tell?: (lines: string[]) => void }} ActionContext
 * @typedef {{ ok: boolean, title: string, lines: string[], reason?: string, afterSave?: () => void }} ActionOutcome
 * @typedef {{ title: string, lines: string[], confirmLabel: string, blocked?: string }} ActionPreview
 * @typedef {{ id: string, kind: "navigate" | "mutate", touchesKingdom: boolean, services: string[], calls: { module: string, name: string }[], describe?: (kingdom: any, params: any, live: any) => ActionPreview, run?: (ctx: ActionContext, params: any) => ActionOutcome }} ActionSpec
 */

/**
 * @param {any} kingdom
 * @param {unknown} districtId
 */
function districtFor(kingdom, districtId) {
    const district = districtById(kingdom, String(districtId));
    if (district === undefined) {
        throw new Error(`no district ${sanitize(districtId)} in this kingdom`);
    }
    return district;
}

/**
 * @param {any} kingdom
 * @param {unknown} gateId
 */
function gateFor(kingdom, gateId) {
    const found = findGate(kingdom, String(gateId));
    if (found === undefined) {
        throw new Error(`no gate ${sanitize(gateId)} in this kingdom`);
    }
    return found;
}

/**
 * Cost of enlisting `count` people (the population rules' per-recruit food and supply cost).
 * @param {number} count
 */
export function recruitCost(count) {
    return {
        food: Math.round(count * Number(POPULATION_DEFAULTS.trainingFoodCostPerRecruit) * 10) / 10,
        supplies: Math.round(count * Number(POPULATION_DEFAULTS.trainingSupplyCostPerRecruit) * 10) / 10,
    };
}

/**
 * The bounded default recruitment: the policy's per-step batch, limited by free civilians, the
 * training queue room and what the stores can equip. Zero means "nothing can be enlisted now".
 * @param {any} district
 * @returns {number}
 */
export function defaultRecruitCount(district) {
    const room = Math.max(0, Number(POPULATION_DEFAULTS.trainingQueueCapacity) - Number(district.trainingQueue ?? 0));
    let count = Math.min(Number(POLICY_DECISION_RULES.recruitBatchPerStep), eligibleRecruits(district), room);
    while (count > 0 && !canAfford(district.reserves, recruitCost(count))) {
        count -= 1;
    }
    return Math.max(0, count);
}

/**
 * The expansion policy setter. The command in commands/inspect.js sets `policy.expansion` inline and
 * does not export that code, so this mirrors it exactly: the same POLICY_MODES check, the same field.
 * @param {any} kingdom
 * @param {unknown} mode
 * @returns {{ ok: boolean, reason?: string }}
 */
export function setExpansionMode(kingdom, mode) {
    if (typeof mode !== "string" || !POLICY_MODES.includes(mode)) {
        return { ok: false, reason: `'${sanitize(mode)}' is not a policy mode (${POLICY_MODES.join(", ")})` };
    }
    if (kingdom.policy === null || typeof kingdom.policy !== "object") {
        return { ok: false, reason: "the kingdom has no policy record" };
    }
    kingdom.policy.expansion = mode;
    return { ok: true };
}

/**
 * The words for what closing a gate would do, in the same terms as the gate command's refusal.
 * @param {{ isolates: string[], severs: boolean, strands: string[] }} impact
 */
function impactWords(impact) {
    /** @type {string[]} */
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
    return parts.join(" and ");
}

/**
 * @param {string} message
 */
function strip(message) {
    return message.replace(/^[a-zA-Z]+: /, "");
}

/** @param {any} ctx @param {"gates" | "civ"} group @param {string} name */
function serviceOf(ctx, group, name) {
    const service = ctx.services?.[group];
    if (service === undefined || typeof service[name] !== "function") {
        throw new Error(`the ${group}.${name} service is not wired in this build`);
    }
    return service;
}

/** @type {Record<string, ActionSpec>} */
const SPECS = {
    "military.recruit": {
        id: "military.recruit",
        kind: "mutate",
        touchesKingdom: true,
        services: [],
        calls: [
            { module: "sim/population.js", name: "openRecruitment" },
            { module: "sim/population.js", name: "eligibleRecruits" },
            { module: "sim/policies.js", name: "POLICY_DECISION_RULES" },
        ],
        describe(kingdom, params) {
            const district = districtFor(kingdom, params.districtId);
            const count = defaultRecruitCount(district);
            const cost = recruitCost(count);
            return {
                title: `Recruit in ${String(district.name)}`,
                lines: [
                    count > 0 ? `${String(count)} civilian(s) enter training in ${String(district.name)}.` : "Nobody can be enlisted right now.",
                    `Equipping them costs food ${String(cost.food)} and supplies ${String(cost.supplies)}.`,
                    `Training queue: ${String(district.trainingQueue)} now, ${String(Number(district.trainingQueue) + count)} after.`,
                    "Soldiers join the garrison when a barracks finishes training.",
                ],
                confirmLabel: "Recruit",
                blocked: count > 0 ? undefined : "nobody can be enlisted right now",
            };
        },
        run(ctx, params) {
            const district = districtFor(ctx.kingdom, params.districtId);
            const count = defaultRecruitCount(district);
            if (count < 1) {
                return { ok: false, title: "Recruitment refused", lines: [], reason: `nothing can be enlisted in ${String(district.name)} right now` };
            }
            try {
                const result = openRecruitment(district, count, { kingdom: ctx.kingdom });
                return {
                    ok: true,
                    title: `Recruited in ${String(district.name)}`,
                    lines: [`${String(result.recruits)} recruit(s) entered training in ${String(district.name)}.`, `Training queue: ${String(result.trainingQueue)}.`],
                };
            } catch (error) {
                return { ok: false, title: "Recruitment refused", lines: [], reason: strip(String(error instanceof Error ? error.message : error)) };
            }
        },
    },

    "policy.expansion": {
        id: "policy.expansion",
        kind: "mutate",
        touchesKingdom: true,
        services: [],
        calls: [{ module: "config.js", name: "POLICY_MODES" }],
        describe(_kingdom, params) {
            const mode = String(params.mode);
            return {
                title: `Expansion policy: ${mode}`,
                lines: [`Expansion becomes ${mode}.`, EXPANSION_EFFECT[/** @type {keyof typeof EXPANSION_EFFECT} */ (mode)] ?? "Unknown mode."],
                confirmLabel: "Set mode",
            };
        },
        run(ctx, params) {
            const outcome = setExpansionMode(ctx.kingdom, params.mode);
            if (!outcome.ok) {
                return { ok: false, title: "Policy refused", lines: [], reason: outcome.reason };
            }
            return { ok: true, title: "Policy changed", lines: [`Expansion is now ${String(params.mode)}.`, EXPANSION_EFFECT[/** @type {keyof typeof EXPANSION_EFFECT} */ (params.mode)]] };
        },
    },

    "gate.mode": {
        id: "gate.mode",
        kind: "mutate",
        touchesKingdom: true,
        services: ["gates.retryNow", "gates.pump"],
        calls: [
            { module: "sim/gatecontrol.js", name: "setGateMode" },
            { module: "sim/gatecontrol.js", name: "closeImpact" },
        ],
        describe(kingdom, params) {
            const { gate, owner } = gateFor(kingdom, params.gateId);
            const mode = String(params.mode);
            /** @type {string[]} */
            const lines = [`Gate ${String(gate.id)} between ${String(owner.id)} and ${String(gate.with)}.`, `Mode becomes ${MODE_WORDS[/** @type {keyof typeof MODE_WORDS} */ (mode)] ?? mode}.`];
            if (mode === "forced_closed") {
                const impact = closeImpact(kingdom, gate);
                if (!impact.harmless) {
                    lines.push(`Closing would ${impactWords(impact)}.`);
                    lines.push(params.force === true ? "Forced: it closes even so." : "Refused unless forced.");
                }
            }
            lines.push(gate.physical ? "The blocks move; anyone standing in the gateway holds it open." : "Logical only: no blocks move.");
            return { title: `Gate ${String(gate.id)}`, lines, confirmLabel: mode === "forced_closed" ? "Close" : "Apply" };
        },
        run(ctx, params) {
            const outcome = setGateMode(ctx.kingdom, String(params.gateId), String(params.mode), { force: params.force === true });
            if (!outcome.ok) {
                return { ok: false, title: "Gate refused", lines: [], reason: outcome.reason ?? "the gate did not change" };
            }
            const moved = outcome.physical.length > 0;
            const found = findGate(ctx.kingdom, String(params.gateId));
            /** @type {string[]} */
            const lines = [`Gate ${String(params.gateId)} is now ${MODE_WORDS[/** @type {keyof typeof MODE_WORDS} */ (params.mode)] ?? String(params.mode)}.`];
            if (found !== undefined && found.gate.physical) {
                lines.push(moved ? "The portcullis is moving; it waits if anyone stands in the gateway." : "The blocks already match that mode.");
            } else if (found !== undefined) {
                lines.push(`Logical state: ${String(found.gate.state)}.`);
            }
            const because = outcome.decision?.reasons[0];
            if (because !== undefined) {
                lines.push(`Because: ${because}`);
            }
            const afterSave = moved
                ? () => {
                    const gates = serviceOf(ctx, "gates", "retryNow");
                    gates.retryNow(String(params.gateId));
                    serviceOf(ctx, "gates", "pump").pump();
                }
                : undefined;
            return { ok: true, title: "Gate changed", lines, afterSave };
        },
    },

    "gate.unmanaged": {
        id: "gate.unmanaged",
        kind: "mutate",
        touchesKingdom: false,
        services: ["gates.setUnmanagedMode", "gates.retryNow", "gates.pump"],
        calls: [],
        describe(_kingdom, params) {
            const mode = String(params.mode);
            return {
                title: `Gate ${String(params.gateId)}`,
                lines: [`This gate is outside the simulation.`, `Mode becomes ${MODE_WORDS[/** @type {keyof typeof MODE_WORDS} */ (mode)] ?? mode}.`, "The portcullis moves; anyone standing in the gateway holds it open."],
                confirmLabel: "Apply",
            };
        },
        run(ctx, params) {
            const gateId = String(params.gateId);
            if (!serviceOf(ctx, "gates", "setUnmanagedMode").setUnmanagedMode(gateId, String(params.mode))) {
                return { ok: false, title: "Gate refused", lines: [], reason: `could not record the mode of ${sanitize(gateId)}` };
            }
            return {
                ok: true,
                title: "Gate changed",
                lines: [`Gate ${gateId} is now ${MODE_WORDS[/** @type {keyof typeof MODE_WORDS} */ (params.mode)] ?? String(params.mode)}.`],
                afterSave: () => {
                    serviceOf(ctx, "gates", "retryNow").retryNow(gateId);
                    serviceOf(ctx, "gates", "pump").pump();
                },
            };
        },
    },

    "gate.test": {
        id: "gate.test",
        kind: "mutate",
        touchesKingdom: false,
        services: ["gates.startSelfTest"],
        calls: [],
        describe(_kingdom, params) {
            return {
                title: `Self test: ${String(params.gateId)}`,
                lines: ["Closes the gate, checks that it is sealed, reopens it and checks that it is passable.", "The gate is restored when the test ends; the report goes to chat."],
                confirmLabel: "Start test",
            };
        },
        run(ctx, params) {
            const gateId = String(params.gateId);
            const tell = ctx.tell ?? (() => undefined);
            const started = serviceOf(ctx, "gates", "startSelfTest").startSelfTest(gateId, (/** @type {{ lines?: string[] }} */ report) => tell(report.lines ?? []));
            if (!started.ok) {
                return { ok: false, title: "Self test refused", lines: [], reason: started.reason ?? "the test did not start" };
            }
            return { ok: true, title: "Self test started", lines: [`Self test of ${gateId} started. The report follows in chat.`] };
        },
    },

    "construction.abort": {
        id: "construction.abort",
        kind: "mutate",
        touchesKingdom: false,
        services: ["civ.abort", "civ.abortLines"],
        calls: [{ module: "config.js", name: "CIV_EVENT_IDS" }],
        describe() {
            return {
                title: "Stop the civilization build",
                lines: ["Stops the running build now.", "Blocks already placed stay in the world.", "Progress is saved; the build can be resumed."],
                confirmLabel: "Stop build",
            };
        },
        run(ctx) {
            const result = serviceOf(ctx, "civ", "abort").abort();
            if (result === undefined) {
                return { ok: false, title: "Nothing to stop", lines: [], reason: "no civilization build is running" };
            }
            return { ok: true, title: "Build stopped", lines: serviceOf(ctx, "civ", "abortLines").abortLines(result, CIV_EVENT_IDS.resume) };
        },
    },

    "construction.resume": {
        id: "construction.resume",
        kind: "mutate",
        touchesKingdom: false,
        services: ["civ.resume"],
        calls: [],
        describe(_kingdom, params) {
            const index = Number(params.district);
            return {
                title: `Resume district-${String(index)}`,
                lines: ["Reloads the saved plan and job queue, checks the checksum, then continues.", "Progress is reported in chat."],
                confirmLabel: "Resume",
            };
        },
        run(ctx, params) {
            const outcome = serviceOf(ctx, "civ", "resume").resume(ctx.player, Number(params.district));
            if (!outcome.ok) {
                return { ok: false, title: "Resume refused", lines: [], reason: outcome.reason ?? "the build could not resume" };
            }
            return { ok: true, title: "Resume requested", lines: ["Resume requested. Progress is reported in chat."] };
        },
    },

    "nav.open": navSpec("nav.open"),
    "nav.page": navSpec("nav.page"),
    "nav.back": navSpec("nav.back"),
    "nav.home": navSpec("nav.home"),
    "nav.refresh": navSpec("nav.refresh"),
    "nav.close": navSpec("nav.close"),
};

/**
 * @param {string} id
 * @returns {ActionSpec}
 */
function navSpec(id) {
    return { id, kind: "navigate", touchesKingdom: false, services: [], calls: [] };
}

/**
 * The registry, frozen. Ids are exactly the keys of SPECS.
 */
export const LEDGER_ACTIONS = Object.freeze(SPECS);

/**
 * @param {unknown} id
 * @returns {ActionSpec | undefined}
 */
export function actionSpec(id) {
    if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(SPECS, id)) {
        return undefined;
    }
    return SPECS[id];
}

/** @returns {string[]} */
export function actionIds() {
    return Object.keys(SPECS);
}

/**
 * Pure navigation: what a `nav.*` action does to the stack.
 * @param {string} id
 * @param {Record<string, unknown>} params
 * @returns {{ op: "open" | "replace" | "back" | "home" | "refresh" | "close", frame?: { menu: string, params: Record<string, unknown>, page: number } }}
 */
export function navigateAction(id, params = {}) {
    if (id === "nav.open" || id === "nav.page") {
        const menu = String(params.menu ?? "kingdom");
        const inner = params.params !== null && typeof params.params === "object" ? /** @type {Record<string, unknown>} */ (params.params) : {};
        const page = Number.isFinite(params.page) ? Math.max(0, Math.floor(Number(params.page))) : 0;
        return { op: id === "nav.open" ? "open" : "replace", frame: { menu, params: { ...inner }, page } };
    }
    if (id === "nav.back") {
        return { op: "back" };
    }
    if (id === "nav.home") {
        return { op: "home" };
    }
    if (id === "nav.refresh") {
        return { op: "refresh" };
    }
    if (id === "nav.close") {
        return { op: "close" };
    }
    throw new Error(`navigateAction: '${sanitize(id)}' is not a navigation action`);
}

/**
 * Runs a mutating action against a private kingdom copy. Never throws: a failure is a refusal.
 *
 * @param {string} id
 * @param {ActionContext} ctx
 * @param {Record<string, unknown>} [params]
 * @returns {ActionOutcome}
 */
export function runAction(id, ctx, params = {}) {
    const spec = actionSpec(id);
    if (spec === undefined || spec.kind !== "mutate" || spec.run === undefined) {
        return { ok: false, title: "Refused", lines: [], reason: `'${sanitize(id)}' is not an action that changes the world` };
    }
    try {
        const outcome = spec.run(ctx, params);
        return { ...outcome, lines: outcome.lines ?? [] };
    } catch (error) {
        return { ok: false, title: "Refused", lines: [], reason: strip(String(error instanceof Error ? error.message : error)) };
    }
}

/**
 * The confirm text for a mutating action. Never throws: an impossible request comes back `blocked`.
 *
 * @param {string} id
 * @param {any} kingdom
 * @param {Record<string, unknown>} params
 * @param {unknown} live
 * @returns {ActionPreview}
 */
export function previewAction(id, kingdom, params, live) {
    const spec = actionSpec(id);
    if (spec === undefined || spec.kind !== "mutate" || spec.describe === undefined) {
        return { title: "Unknown action", lines: [`'${sanitize(id)}' cannot be confirmed.`], confirmLabel: "Confirm", blocked: "no such action" };
    }
    try {
        return spec.describe(kingdom, params, live);
    } catch (error) {
        const message = strip(String(error instanceof Error ? error.message : error));
        return { title: "Cannot confirm", lines: [message], confirmLabel: "Confirm", blocked: message };
    }
}
