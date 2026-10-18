import { DEBUG_EVENT_IDS, SIM, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { system, world } from "@minecraft/server";
import { advanceKingdom } from "../sim/tick.js";
import { listScenarios, previewBuildQueue, runScenario } from "../sim/scenarios.js";
import { formatErrorLines } from "../ui/report.js";
import { getDemoAnchor, isDemoEnabled, materialiseNextStage, setDemoAnchor, setDemoEnabled } from "../integration/buildAdapter.js";
import { parseArgs, parseCount } from "./args.js";
import { reply } from "./reply.js";

/**
 * Debug and demonstration commands, all behind the `civ:debug_*` id prefix so they cannot
 * be triggered by ordinary gameplay and every one is a deliberate typed invocation.
 *
 * Scenario runs are isolated by default: they execute against a detached copy of the
 * kingdom and only the report is returned. Changing the save takes the explicit `--apply`
 * argument. Every argument is validated, and anything invalid is rejected with a usage
 * line instead of being clamped silently.
 *
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ScriptEvent
 */

let registered = false;

/**
 * @param {any} kingdom
 */
function detach(kingdom) {
    return JSON.parse(JSON.stringify(kingdom));
}

/**
 * @param {any} kingdom
 */
function districtChoices(kingdom) {
    return /** @type {any[]} */ (kingdom.districts ?? []).map((district) => district.id).join(", ");
}

/**
 * @param {any} kingdom
 */
function territoryChoices(kingdom) {
    return /** @type {any[]} */ (kingdom.territory ?? []).map((land) => land.id).join(", ");
}

function helpLines() {
    return [
        "=== Civilization Apocalypse commands ===",
        "  gameplay: /scriptevent civ:status | civ:district <id> | civ:territory | civ:policy [mode]",
        "  debug:    /scriptevent civ:debug_scenarios",
        "            /scriptevent civ:debug_scenario <id> [target] [--apply]",
        `            /scriptevent civ:debug_tick <1-${String(SIM.maxCatchUpSteps)}>`,
        "            /scriptevent civ:debug_build status|enable|disable|anchor <x y z>|preview|run [limit]",
    ];
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleTick(kingdomStore, args, event) {
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatErrorLines("Tick refused", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }
    const parsed = parseCount(args[0], 1, 1, SIM.maxCatchUpSteps);
    if (parsed.error) {
        reply(formatErrorLines("Tick refused", [`'${args[0] ?? ""}' ${parsed.error}`, `Usage: /scriptevent civ:debug_tick <1-${String(SIM.maxCatchUpSteps)}>`]), event);
        return;
    }
    const report = advanceKingdom(loaded.kingdom, parsed.value);
    if (report.ran > 0) {
        kingdomStore.save(loaded.kingdom);
    }
    reply(
        [
            `Advanced ${String(report.ran)} step(s), ${String(report.skipped)} refused. Now ${report.time}.`,
            ...report.events.slice(0, 10).map((line) => `  ${line}`),
            ...report.rejected.flatMap((rejection) => [`  step ${String(rejection.atStep)} rolled back:`, ...rejection.problems.map((problem) => `    - ${problem}`)]),
        ],
        event,
    );
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleScenario(kingdomStore, args, event) {
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatErrorLines("Scenario refused", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }
    const flag = args.find((arg) => arg.startsWith("--"));
    const [id, target] = args.filter((arg) => !arg.startsWith("--"));
    if (id === undefined) {
        reply(
            formatErrorLines("Scenario refused", [
                "Usage: /scriptevent civ:debug_scenario <id> [target] [--apply]",
                `Known: ${listScenarios().map((scenario) => scenario.id).join(", ")}`,
            ]),
            event,
        );
        return;
    }
    if (flag !== undefined && flag !== "--apply") {
        reply(formatErrorLines("Scenario refused", [`Unknown option '${flag}'. Only --apply is accepted.`]), event);
        return;
    }

    const apply = flag === "--apply";
    const subject = apply ? loaded.kingdom : detach(loaded.kingdom);
    const beforeSaved = apply ? undefined : JSON.stringify(loaded.kingdom);
    try {
        const result = runScenario(subject, id, { target });
        if (apply) {
            kingdomStore.save(loaded.kingdom);
        } else if (JSON.stringify(loaded.kingdom) !== beforeSaved) {
            reply(formatErrorLines("Scenario refused", ["The dry run changed the saved kingdom - it was rolled back and is not reported."]), event);
            return;
        }
        reply(
            [
                `Scenario '${result.id}' - ${result.title}`,
                `Mode: ${apply ? "APPLIED to the saved kingdom" : "dry run against a copy - the save is untouched"}`,
                ...result.lines,
            ],
            event,
        );
    } catch (error) {
        reply(
            formatErrorLines("Scenario refused", [
                String(error),
                `Districts to target: ${districtChoices(loaded.kingdom)}`,
                `Territories to target: ${territoryChoices(loaded.kingdom)}`,
            ]),
            event,
        );
    }
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleBuild(kingdomStore, args, event) {
    const [sub, ...rest] = args;

    if (sub === "enable" || sub === "disable") {
        setDemoEnabled(world, sub === "enable");
        reply(
            [
                `Physical build demo ${sub === "enable" ? "ENABLED" : "disabled"}.`,
                "Nothing is placed until an anchor is set: /scriptevent civ:debug_build anchor <x y z>",
            ],
            event,
        );
        return;
    }

    if (sub === "anchor") {
        const coords = rest.map((part) => Number(part));
        if (coords.length !== 3 || !coords.every((value) => Number.isFinite(value))) {
            reply(formatErrorLines("Anchor refused", ["Usage: /scriptevent civ:debug_build anchor <x y z>"]), event);
            return;
        }
        setDemoAnchor(world, { x: Math.floor(coords[0]), y: Math.floor(coords[1]), z: Math.floor(coords[2]) });
        reply([`Anchor set to ${coords.map((value) => String(Math.floor(value))).join(", ")}.`], event);
        return;
    }

    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatErrorLines("Build refused", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }

    if (sub === "preview") {
        const queue = previewBuildQueue(loaded.kingdom);
        reply([`Build queue (read-only): ${queue.length === 0 ? "nothing is under construction" : ""}`, ...queue], event);
        return;
    }

    if (sub === "run") {
        if (!isDemoEnabled(world)) {
            reply(
                formatErrorLines("Build refused", ["The physical build demo is off.", "Run /scriptevent civ:debug_build enable first - blocks are only placed when you opt in."]),
                event,
            );
            return;
        }
        if (getDemoAnchor(world) === undefined) {
            reply(formatErrorLines("Build refused", ["No demo anchor is set. Use /scriptevent civ:debug_build anchor <x y z>."]), event);
            return;
        }
        const parsed = parseCount(rest[0], SIM.maxBlocksPerStep, 1, SIM.maxBlocksPerStep);
        if (parsed.error) {
            reply(formatErrorLines("Build refused", [`'${rest[0] ?? ""}' ${parsed.error}`, `Limit is 1-${String(SIM.maxBlocksPerStep)} blocks per run.`]), event);
            return;
        }
        let result;
        try {
            result = materialiseNextStage(world.getDimension("overworld"), loaded.kingdom, { limit: parsed.value });
        } catch (error) {
            reply(formatErrorLines("Build failed", [String(error)]), event);
            return;
        }
        kingdomStore.save(loaded.kingdom);
        reply(
            [
                result.placed > 0
                    ? `Placed ${String(result.placed)} block(s) for ${String(result.kind)} project ${String(result.project)}.`
                    : `Placed nothing. ${String(result.blocked ?? result.skipped[0]?.reason ?? "no positions were available")}`,
                ...result.skipped.slice(0, 8).map((entry) => `  skipped (${String(entry.position.x)}, ${String(entry.position.y)}, ${String(entry.position.z)}): ${entry.reason}`),
            ],
            event,
        );
        return;
    }

    reply(
        [
            `Physical build demo: ${isDemoEnabled(world) ? "enabled" : "disabled"}`,
            `Anchor: ${JSON.stringify(getDemoAnchor(world) ?? "not set")}`,
            "Subcommands: status | enable | disable | anchor <x y z> | preview | run [limit]",
        ],
        event,
    );
}

/**
 * @param {KingdomStore} kingdomStore
 */
export function registerDebugCommands(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;

    system.afterEvents.scriptEventReceive.subscribe((event) => {
        const args = parseArgs(event.message);

        if (event.id === DEBUG_EVENT_IDS.help) {
            reply(helpLines(), event);
            return;
        }
        if (event.id === DEBUG_EVENT_IDS.tick) {
            handleTick(kingdomStore, args, event);
            return;
        }
        if (event.id === DEBUG_EVENT_IDS.scenarios) {
            reply(["=== Demonstration scenarios ===", ...listScenarios().map((scenario) => `  ${scenario.id} - ${scenario.title}: ${scenario.summary}`)], event);
            return;
        }
        if (event.id === DEBUG_EVENT_IDS.scenario) {
            handleScenario(kingdomStore, args, event);
            return;
        }
        if (event.id === DEBUG_EVENT_IDS.build) {
            handleBuild(kingdomStore, args, event);
        }
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}
