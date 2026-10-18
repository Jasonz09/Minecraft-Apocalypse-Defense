import { STARTER, STARTER_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { system, world } from "@minecraft/server";
import { createJobStore, JOB_PREFIX } from "../civ/jobs.js";
import { createPlanStore, PLAN_PREFIX } from "../civ/planstore.js";
import { GATE_RUNTIME, readGateRecord } from "../integration/gateAdapter.js";
import { activeKind, isBusy } from "../integration/districtBuilder.js";
import { getProgress } from "../integration/civProgress.js";
import { buildStarterBaseline, describeStarterState, STARTER_EXPECTED_POPULATION, starterArmProblems } from "../sim/starter.js";
import { parseArgs } from "./args.js";
import { reply } from "./reply.js";

/**
 * Developer commands that turn a finished build world into a shippable starter world.
 *
 * `civ:starter_status`  read-only: what would be kept, reset and wiped, and what still blocks arming.
 * `civ:starter_arm confirm`  writes the published kingdom baseline (starting population + the records
 *                           of what is physically built) and removes development-only state, so an
 *                           exported copy of this world becomes a template new players can start in.
 * `civ:starter_verify`  read-only: is this world armed and internally consistent for release.
 *
 * Nothing here generates or destroys blocks, and nothing runs on player join.
 */

let registered = false;

/**
 * @typedef {{
 *   kingdom: any,
 *   kingdomReason: any,
 *   keys: string[],
 *   gates: { status: string, units: number, overrides: string[], moving: string[] },
 *   job: { present: boolean, pending: number, total: number, state: string, status: string },
 *   planPresent: boolean,
 *   planStoredKeys: boolean,
 *   planStatus: string,
 *   planningRunning: boolean,
 *   planningDescription: string | undefined,
 *   builtRequired: string[],
 * }} StarterState
 */

function allKeys() {
    try {
        return typeof world.getDynamicPropertyIds === "function" ? [...world.getDynamicPropertyIds()] : [];
    } catch (error) {
        return [];
    }
}

/**
 * The gate registry that gatelink owns: `{ v: 1, gates: [{ id, role, mode? }] }`.
 *
 * Parsed here instead of through `readGateRegistry()` because that helper reports a corrupt
 * registry as an empty one - and "no gates" looks exactly like a clean, shippable world. An
 * unreadable registry must be a refusal, not an absence.
 */
function gateReport() {
    const empty = { status: "absent", units: 0, overrides: [], moving: [] };
    let raw;
    try {
        raw = world.getDynamicProperty(GATE_RUNTIME.registryKey);
    } catch (error) {
        return { ...empty, status: "unreadable" };
    }
    if (raw === undefined) {
        return empty;
    }
    if (typeof raw !== "string") {
        return { ...empty, status: "invalid" };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { ...empty, status: "corrupt" };
    }
    if (parsed === null || typeof parsed !== "object" || parsed.v !== 1 || !Array.isArray(parsed.gates)) {
        return { ...empty, status: "invalid shape" };
    }
    const overrides = [];
    const moving = [];
    for (const gate of parsed.gates) {
        const id = String(gate?.id ?? "?");
        if (gate?.mode !== undefined && gate.mode !== "auto") {
            overrides.push(`${id} (mode '${String(gate.mode)}')`);
        }
        // A record with a destination is a portcullis still travelling; the blocks in the world are
        // mid-transition and arming would delete the queue that finishes them.
        const record = readGateRecord(id);
        if (record !== undefined && record.to !== null && record.to !== undefined) {
            moving.push(`${id} -> ${String(record.to)}`);
        }
    }
    return { status: "ok", units: parsed.gates.length, overrides, moving };
}

/** A planning, survey or build session still holds the job slot - or owns the progress display. */
function sessionReport() {
    const progress = getProgress();
    if (progress !== undefined) {
        return { running: true, description: `${String(progress.kind)} session (${String(progress.state)})` };
    }
    return isBusy() ? { running: true, description: `${String(activeKind() ?? "unknown")} job` } : { running: false, description: undefined };
}

function jobSummary() {
    const store = createJobStore(world, { prefix: JOB_PREFIX });
    const loaded = store.loadQueue();
    if (loaded.status !== "ok") {
        return { present: false, pending: 0, total: 0, state: "", status: String(loaded.status) };
    }
    const statuses = Array.isArray(loaded.queue?.status) ? loaded.queue.status : [];
    return {
        present: true,
        pending: statuses.filter((status) => status !== "done" && status !== "skipped").length,
        total: statuses.length,
        state: String(loaded.queue?.state ?? ""),
        status: "ok",
    };
}

/** The plan is only 'present' when it can actually be read: a corrupt blob ships an unplanned city. */
function planSummary() {
    const loaded = createPlanStore(world, { prefix: PLAN_PREFIX }).loadPlan();
    return {
        readable: loaded.status === "ok",
        storedKeys: allKeys().some((key) => key.startsWith(`${PLAN_PREFIX}:`)),
        status: String(loaded.status),
    };
}

/**
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 * @returns {StarterState}
 */
function gather(kingdomStore) {
    const loaded = kingdomStore.load();
    const keys = allKeys();
    const plan = planSummary();
    const session = sessionReport();
    return {
        kingdom: loaded.kingdom,
        kingdomReason: loaded.reason,
        keys,
        gates: gateReport(),
        job: jobSummary(),
        planPresent: plan.readable,
        planStoredKeys: plan.storedKeys,
        planStatus: plan.status,
        planningRunning: session.running,
        planningDescription: session.description,
        builtRequired: STARTER.builtRequired,
    };
}

/** @param {StarterState} state */
function statusLines(state) {
    const described = describeStarterState(state);
    const problems = starterArmProblems(state);
    const lines = [
        "=== Starter world ===",
        `Armed as: ${described.armed === null ? "not armed (development world)" : String(described.armed)}`,
        `Kingdom: ${String(described.districts)} districts, ${String(described.civilians)} civilians, ${String(described.soldiers)} soldiers`,
        `Physically complete: ${described.builtDistricts.length > 0 ? described.builtDistricts.join(", ") : "none"}`,
        `Gate units recorded: ${String(described.gates)} (${String(state.gates.status)}${state.gates.overrides.length > 0 ? `, ${String(state.gates.overrides.length)} overridden` : ""}${state.gates.moving.length > 0 ? `, ${String(state.gates.moving.length)} mid-move` : ""}), job elements pending: ${String(described.jobPending)}`,
        `Generation session: ${state.planningRunning ? `RUNNING - ${String(state.planningDescription ?? "unknown")}` : "idle"}`,
        `State keys kept on arming: ${described.keepKeys.join(", ") || "none"}`,
        `State keys wiped on arming: ${described.wipeKeys.join(", ") || "none"}`,
    ];
    if (described.unknownKeys.length > 0) {
        lines.push(`Untouched (not ours): ${String(described.unknownKeys.length)} other key(s)`);
    }
    lines.push(problems.length === 0 ? "Ready to arm: /scriptevent civ:starter_arm confirm" : `Blocked: ${problems[0]}`);
    return lines;
}

/** @param {StarterState} state */
function verifyLines(state) {
    const described = describeStarterState(state);
    const problems = starterArmProblems(state);
    const expected = STARTER_EXPECTED_POPULATION;
    const fresh = described.civilians === expected.civilians && described.soldiers === expected.soldiers;
    return [
        "=== Starter verify ===",
        described.armed === null
            ? "NOT armed: a player joining would seed a brand new kingdom, and the built city would have no record here."
            : `Armed as '${String(described.armed)}' v${expectedVersionText(described.templateVersion)}`,
        `Population: ${String(described.civilians)} civilians / ${String(described.soldiers)} soldiers over ${String(described.districts)} districts${fresh ? " (published baseline)" : " (not the published baseline)"}`,
        `Built districts: ${described.builtDistricts.join(", ") || "none"}`,
        `Master plan stored: ${state.planPresent ? "yes" : "no"}`,
        `Development keys still present: ${described.wipeKeys.length === 0 ? "none" : described.wipeKeys.join(", ")}`,
        ...(problems.length === 0
            ? ["Ready for export."]
            : problems.slice(0, 6).map((problem) => `  - ${problem}`)),
    ];
}

/** @param {any} version */
function expectedVersionText(version) {
    return Array.isArray(version) ? version.join(".") : "unknown";
}

/**
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 */
export function registerStarterCommands(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;

    system.afterEvents.scriptEventReceive.subscribe((event) => {
        const args = parseArgs(event.message);

        if (event.id === STARTER_EVENT_IDS.status) {
            reply(statusLines(gather(kingdomStore)), event);
            return;
        }

        if (event.id === STARTER_EVENT_IDS.verify) {
            reply(verifyLines(gather(kingdomStore)), event);
            return;
        }

        if (event.id !== STARTER_EVENT_IDS.arm) {
            return;
        }
        if (args[0] !== "confirm") {
            reply(["Arming rewrites this world's saved state for release.", "This is deliberately two steps: /scriptevent civ:starter_arm confirm"], event);
            return;
        }
        const state = gather(kingdomStore);
        const problems = starterArmProblems(state);
        if (problems.length > 0) {
            reply(["Cannot arm this world for release:", ...problems.slice(0, 6).map((problem) => `  - ${problem}`)], event);
            return;
        }

        const notes = /** @type {string[]} */ ([]);
        const baseline = buildStarterBaseline({ current: state.kingdom, armedAtStep: 0, notes });
        kingdomStore.save(baseline);

        let wiped = 0;
        const classified = describeStarterState(state);
        for (const key of classified.wipeKeys) {
            try {
                world.setDynamicProperty(key, undefined);
                wiped += 1;
            } catch (error) {
                notes.push(`could not wipe ${key}: ${String(error)}`);
            }
        }

        reply(
            [
                `Armed for release as '${String(baseline.starter.templateId)}'.`,
                `Kingdom reset to the published baseline: ${String(STARTER_EXPECTED_POPULATION.districts)} districts, ${String(STARTER_EXPECTED_POPULATION.civilians)} civilians, ${String(STARTER_EXPECTED_POPULATION.soldiers)} soldiers.`,
                `Records kept: ${classified.keepKeys.join(", ") || "none"}`,
                `Development keys wiped: ${String(wiped)}`,
                ...notes.slice(0, 6).map((note) => `  - ${note}`),
                "Now export this world (Play > Edit > Export World) and run: node dev/build-template.mjs --world <exported-world>",
            ],
            event,
        );
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}
