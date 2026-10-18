import { system, world } from "@minecraft/server";
import { CIV, CIV_EVENT_IDS, PHYSICAL, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { createJobStore, progress } from "../civ/jobs.js";
import { markYield, newOps } from "../civ/regions.js";
import { siteGroundRegion } from "../civ/siteprofile.js";
import { abortCivJob, civAbortLines, describePlan, loadSavedRunSteps, persistRun, planWorld, sessionStatus, startConstruction, PROTECT_MARGIN } from "../integration/civBuilder.js";
import { registerBuiltGates } from "../integration/civGates.js";
import { describeProgress, describeRunning, finishProgress, formatTicks, getLastRun, getProgress, nowTick, setPhase, startMonitor, startProgress } from "../integration/civProgress.js";
import { CIV_TICKING_ID, releaseArea, runJobAsync, tileSizeNow } from "../integration/civScan.js";
import { activeKind, activeToken, finishJob, isBusy, releaseChunks, reserveJob } from "../integration/districtBuilder.js";
import { districtById, findValidationProblems } from "../kingdom/state.js";
import { formatErrorLines } from "../ui/report.js";
import { parseArgs } from "./args.js";
import { reply } from "./reply.js";

/**
 * One-command civilization generation for a dedicated NEW Creative test world.
 *
 *   civ:generate [radius=N] [seed=N]   scan, plan, validate, store, then build district 1 - ONE invocation authorises it all
 *   civ:generate_plan [radius=N] [seed=N]   the same scan/plan/validate, strictly read-only, prints the numbers
 *   civ:generate_status                 record, job queue and live counts
 *   civ:generate_abort                  stop; placed blocks stay and the queue is kept
 *   civ:generate_resume                 continue from the stored plan and queue (also after a restart)
 *   civ:generate_devgate on|off         development flag; districts 2-5 are NOT built by this milestone
 *
 * Nothing here runs at import or activation, and nothing starts without one of these typed commands.
 *
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ScriptEvent
 * @typedef {import("@minecraft/server").Player} Player
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 */

let registered = false;

/** Safety notice shown by generate, plan and devgate (exact text is part of the contract). */
export const CIV_SAFETY_WARNING = [
    "Use only in a dedicated NEW test world.",
    "Natural-looking player builds (dirt, stone, sandstone, sand, gravel, clay, snow, moss) cannot be told apart from terrain and WOULD be modified; planks, bricks, glass, chests, ores, farmland etc. are always protected.",
];

/** Half-extent of the 49 x 49 Hearthgate prototype footprint. */
const PROTOTYPE_HALF = 24;

/**
 * Registers the built gates with the simulation and the gate adapter (integration/civGates.js, idempotent).
 * Replaceable in tests only.
 * @type {(store: KingdomStore, record: any, dimensionId: string) => { ok: boolean, reason: string | null, changes: any[], created: string[], links: any[] }}
 */
let gateRegistrar = registerBuiltGates;

/** @param {typeof gateRegistrar | undefined} fn test seam: undefined restores the real registrar */
export function setGateLinker(fn) {
    gateRegistrar = fn ?? registerBuiltGates;
}

/** Operation meter of the most recent resume rebuild (tests assert no stretch exceeds the budget). */
export let lastResumeOps = newOps();

/**
 * @param {KingdomStore} kingdomStore
 */
export function registerCivCommands(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;
    system.afterEvents.scriptEventReceive.subscribe((event) => {
        const id = event.id;
        if (id === CIV_EVENT_IDS.generate) {
            void handleGenerate(kingdomStore, parseArgs(event.message), event, false);
        } else if (id === CIV_EVENT_IDS.plan) {
            void handleGenerate(kingdomStore, parseArgs(event.message), event, true);
        } else if (id === CIV_EVENT_IDS.status) {
            handleStatus(kingdomStore, event);
        } else if (id === CIV_EVENT_IDS.abort) {
            handleAbort(kingdomStore, event);
        } else if (id === CIV_EVENT_IDS.resume) {
            void handleResume(kingdomStore, event);
        } else if (id === CIV_EVENT_IDS.devgate) {
            handleDevgate(parseArgs(event.message), event);
        } else if (id === CIV_EVENT_IDS.diag) {
            handleDiag(event);
        }
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/**
 * @param {string[]} args
 * @returns {{ radius: number, seed: number | undefined, districts: string | undefined, error: string | undefined }}
 */
export function parseCivArgs(args) {
    /** @type {{ radius: number, seed: number | undefined, districts: string | undefined, error: string | undefined }} */
    const out = { radius: CIV.defaultSearchRadius, seed: undefined, districts: undefined, error: undefined };
    for (const arg of args) {
        const match = /^([a-z]+)=(.*)$/i.exec(arg);
        if (match === null) {
            out.error = `unrecognised argument '${arg}'`;
            return out;
        }
        const name = String(match[1]).toLowerCase();
        const raw = String(match[2]);
        if (name === "radius") {
            const value = Number(raw);
            if (!/^\d+$/.test(raw) || value < 24 || value > CIV.maxSearchRadius) {
                out.error = `radius must be a whole number from 24 to ${String(CIV.maxSearchRadius)}`;
                return out;
            }
            out.radius = value;
        } else if (name === "seed") {
            const value = Number(raw);
            if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(value)) {
                out.error = "seed must be a whole number";
                return out;
            }
            out.seed = value | 0;
        } else if (name === "districts") {
            out.districts = raw;
        } else {
            out.error = `unknown argument '${name}='`;
            return out;
        }
    }
    return out;
}

/**
 * Rectangles of every existing physical district footprint (the 49 x 49 prototype and any recorded civilization).
 * @param {any} kingdom
 * @param {number} pad
 * @returns {Rect[]}
 */
export function protectedRects(kingdom, pad) {
    /** @type {Rect[]} */
    const rects = [];
    for (const district of /** @type {any[]} */ (kingdom?.districts ?? [])) {
        const origin = district?.physical?.origin;
        if (origin !== undefined && Number.isInteger(origin.x) && Number.isInteger(origin.z)) {
            const half = PROTOTYPE_HALF + pad;
            rects.push({ x0: origin.x - half, z0: origin.z - half, x1: origin.x + half, z1: origin.z + half });
        }
    }
    return rects;
}

/**
 * Validate the small `district.civ` record (integrator: call from kingdom/state.js findValidationProblems).
 * @param {any} civ
 * @param {string} [label]
 * @returns {string[]}
 */
export function civRecordProblems(civ, label = "district.civ") {
    /** @type {string[]} */
    const problems = [];
    if (civ === undefined) {
        return problems;
    }
    if (civ === null || typeof civ !== "object") {
        return [`${label} must be an object`];
    }
    if (!["building", "paused", "complete"].includes(civ.status)) {
        problems.push(`${label}.status must be building, paused or complete`);
    }
    if (!Number.isInteger(civ.seed)) {
        problems.push(`${label}.seed must be an integer`);
    }
    for (const field of ["anchor", "centre"]) {
        const point = civ[field];
        if (point === null || typeof point !== "object" || !Number.isInteger(point.x) || !Number.isInteger(point.z)) {
            problems.push(`${label}.${field} must hold integer x and z`);
        }
    }
    if (typeof civ.checksum !== "string" || civ.checksum.length === 0) {
        problems.push(`${label}.checksum must be a non-empty string`);
    }
    if (typeof civ.stage !== "string") {
        problems.push(`${label}.stage must be a string`);
    }
    if (!Number.isInteger(civ.startedStep) || civ.startedStep < 0) {
        problems.push(`${label}.startedStep must be a non-negative integer`);
    }
    return problems;
}

// ---------------------------------------------------------------------------------------------
// Plumbing

/** @param {ScriptEvent} event @returns {Player | undefined} */
function playerOf(event) {
    const source = event.sourceEntity ?? event.initiator;
    return source !== undefined && source.typeId === "minecraft:player" ? /** @type {Player} */ (source) : undefined;
}

/** @param {Player} player @param {string[]} lines */
function say(player, lines) {
    try {
        if (player.isValid) {
            player.sendMessage(lines);
            return;
        }
    } catch (_error) {
        // fall through to a broadcast
    }
    world.sendMessage(lines);
}

/** @param {KingdomStore} store @param {Record<string, any>} patch */
function patchCiv(store, patch) {
    const loaded = store.load();
    if (!loaded.kingdom) {
        return false;
    }
    const district = districtById(loaded.kingdom, "district-1");
    if (!district) {
        return false;
    }
    district.civ = { ...(district.civ ?? {}), ...patch };
    store.save(loaded.kingdom);
    return true;
}

function devGateOn() {
    try {
        return world.getDynamicProperty(CIV.devGateKey) === true;
    } catch (_error) {
        return false;
    }
}

/** @param {Record<string, number>} byReason */
function topReasons(byReason) {
    return Object.entries(byReason).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([reason, count]) => `  ${String(count)}x ${reason}`);
}

/**
 * If no job owns the slot, remove ticking areas an earlier (crashed / aborted) run may have left behind.
 * @param {(lines: string[]) => void} tell
 */
function sweepAbandonedHolds(tell) {
    if (isBusy()) {
        return;
    }
    try {
        const manager = world.tickingAreaManager;
        /** @type {string[]} */
        const found = [];
        if (manager.hasTickingArea(CIV_TICKING_ID)) {
            releaseArea(undefined);
            found.push(CIV_TICKING_ID);
        }
        if (manager.hasTickingArea(PHYSICAL.tickingAreaId)) {
            releaseChunks();
            found.push(PHYSICAL.tickingAreaId);
        }
        if (found.length > 0) {
            tell([`Removed abandoned ticking area(s) left by an earlier run: ${found.join(", ")}.`]);
        }
    } catch (_error) {
        // nothing to sweep
    }
}

/** Phrase for a refusal because the slot is taken. */
function runningPhrase() {
    const running = getProgress();
    return `A ${String(activeKind())} job is already running${running !== undefined ? ` (${describeRunning(running)})` : ""}.`;
}

/**
 * The monitor found the session stalled or past its deadline: say why, cancel it safely, release everything.
 * @param {Player} player
 * @param {import("../integration/civProgress.js").Progress} prog
 * @param {"stalled" | "deadline"} reason
 */
function onTrouble(player, prog, reason) {
    const message = reason === "deadline"
        ? `Planning ran past its deadline of ${formatTicks(CIV.planDeadlineTicks)} (phase ${String(prog.phaseIndex)}/${String(prog.phases)} ${prog.phaseName}).`
        : `No progress for ${formatTicks(CIV.stallTicks)} (phase ${String(prog.phaseIndex)}/${String(prog.phases)} ${prog.phaseName}, tile ${String(prog.tilesDone)}/${String(prog.tilesTotal)}).`;
    if (prog.kind === "build") {
        prog.lastError = message + " (not cancelled)";
        say(player, formatErrorLines("Build is not making progress", [message, "The build was NOT cancelled - it may recover once the chunks load. See /scriptevent civ:generate_status, or stop it with /scriptevent civ:generate_abort (progress is kept and can be resumed)."]));
        return;
    }
    prog.lastError = message;
    say(player, formatErrorLines(`Planning ${reason === "deadline" ? "timed out" : "stalled"} - cancelled, nothing was changed`, [message, "A chunk may not be loading in this world. Move to an area whose chunks are already generated or try a smaller radius=, then run the command again. /scriptevent civ:generate_diag shows the engine's limits."]));
    if (activeToken() === prog.token) {
        abortCivJob(reason === "deadline" ? "failed" : "stalled", message);
    } else {
        finishProgress(prog, reason === "deadline" ? "failed" : "stalled", message);
    }
}

// ---------------------------------------------------------------------------------------------
// civ:generate / civ:generate_plan

/**
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 * @param {boolean} planOnly
 */
async function handleGenerate(kingdomStore, args, event, planOnly) {
    const title = planOnly ? "Plan refused" : "Generate refused";
    const player = playerOf(event);
    if (player === undefined) {
        reply(formatErrorLines(title, ["Run this as a player: the search is centred on you."]), event);
        return;
    }
    const options = parseCivArgs(args);
    if (options.error !== undefined) {
        say(player, formatErrorLines(title, [options.error, `Usage: /scriptevent ${planOnly ? CIV_EVENT_IDS.plan : CIV_EVENT_IDS.generate} [radius=24-${String(CIV.maxSearchRadius)}] [seed=N]`]));
        return;
    }
    if (options.districts !== undefined) {
        say(player, formatErrorLines(title, devGateOn()
            ? ["Building districts 2-5 is not enabled in this build (the development gate is on, but only district 1 exists as a construction plan)."]
            : ["Building districts 2-5 is not available yet. Only district 1 (Hearthgate, enlarged) is built by this command."]));
        return;
    }
    if (isBusy()) {
        say(player, formatErrorLines(title, [runningPhrase(), `Wait for it, check /scriptevent ${CIV_EVENT_IDS.status}, or stop it with /scriptevent ${CIV_EVENT_IDS.abort}.`]));
        return;
    }
    sweepAbandonedHolds((lines) => say(player, lines));
    if (player.dimension.id !== "minecraft:overworld") {
        say(player, formatErrorLines(title, [`Run this in the overworld (you are in ${player.dimension.id}).`]));
        return;
    }
    const loaded = kingdomStore.load();
    const district = loaded.kingdom ? districtById(loaded.kingdom, "district-1") : undefined;
    if (!loaded.kingdom || !district) {
        say(player, formatErrorLines(title, [`No readable kingdom in this world: ${String(loaded.reason)}`]));
        return;
    }
    if (!planOnly && district.civ !== undefined) {
        say(player, formatErrorLines(title, [`Hearthgate (enlarged) already exists here (${String(district.civ.status)}).`, `Use /scriptevent ${CIV_EVENT_IDS.status}, or ${CIV_EVENT_IDS.resume} to continue an interrupted build. Nothing is generated twice.`]));
        return;
    }
    const token = reserveJob(planOnly ? "civ-plan" : "civ-scan");
    if (token === undefined) {
        say(player, formatErrorLines(title, ["A job is already running."]));
        return;
    }
    const seed = options.seed ?? ((Number.isInteger(loaded.kingdom.seed) ? loaded.kingdom.seed : 1) | 0);
    const dimension = player.dimension;
    const anchor = { x: Math.floor(player.location.x), z: Math.floor(player.location.z) };
    const exclusions = protectedRects(loaded.kingdom, PROTECT_MARGIN);
    say(player, [
        `=== ${planOnly ? "Civilization plan (read-only)" : "Generating the civilization"} ===`,
        `Centre ${String(anchor.x)}, ${String(anchor.z)}; search radius ${String(options.radius)}; seed ${String(seed)}; ${String(exclusions.length)} protected footprint(s).`,
        ...CIV_SAFETY_WARNING,
        planOnly ? "Nothing will be written." : "This one command authorises the whole build; progress is reported as it goes. Use civ:generate_abort to stop.",
    ]);

    /** @param {string[]} lines */
    const sayHere = (lines) => say(player, lines);
    const prog = startProgress("plan", token, sayHere);
    startMonitor(prog, (reason) => onTrouble(player, prog, reason));
    let handedOver = false;
    try {
    /** @type {import("../integration/civBuilder.js").PlanOutcome} */
    let outcome;
    try {
        outcome = await planWorld({ token, dimension, anchor, radius: options.radius, seed, exclusions, say: sayHere, progress: prog });
    } catch (error) {
        prog.lastError = String(error);
        releaseArea(token);
        finishJob(token);
        say(player, formatErrorLines("Planning failed - nothing was changed", [String(error)]));
        return;
    }
    if (token.cancelled) {
        releaseArea(token);
        return;
    }
    if (!outcome.ok) {
        prog.lastError = `${outcome.stage}: ${String(outcome.reasons[0])}`;
        releaseArea(token);
        finishJob(token);
        say(player, formatErrorLines(`Stopped at ${outcome.stage} - nothing was changed`, [...outcome.reasons, ...(outcome.stage === "site" && exclusions.length > 0 ? ["An existing district blocks the nearby ground: walk a few hundred blocks away or raise radius=."] : []), "No block was written."]));
        return;
    }
    const summary = describePlan(outcome);
    const planLines = [
        `Site: window ${String(outcome.site.window.x0)},${String(outcome.site.window.z0)} to ${String(outcome.site.window.x1)},${String(outcome.site.window.z1)}, ${String(Math.round(outcome.site.distance))} blocks from you; district 1 centre ${String(summary.centre.x)}, ${String(summary.centre.z)}.`,
        `District areas ${summary.areas.join(" / ")} columns; compactness ${summary.compactness.map((c) => c.toFixed(2)).join(" / ")}; bbox fill ${summary.bboxFill.map((c) => c.toFixed(2)).join(" / ")}.`,
        `Walls ${String(summary.wallLength)} blocks, ${String(summary.gateCount)} gates, roads ${String(summary.roadLength)} blocks, ${String(summary.lots)} lots in district 1.`,
        `Estimated ${String(summary.ops)} block operations in about ${String(summary.slices)} slices (survey + planning + build), estimated minutes ${String(summary.minutes)} at one slice per tick - an estimate until measured in Minecraft. Stored size ${String(summary.stored.bytes)} / ${String(summary.stored.limit)} bytes.`,
    ];
    if (planOnly) {
        releaseArea(token);
        finishJob(token);
        say(player, ["=== Plan is valid ===", ...planLines, `To build it: /scriptevent ${CIV_EVENT_IDS.generate}${options.radius === CIV.defaultSearchRadius ? "" : ` radius=${String(options.radius)}`} seed=${String(seed)}`, "Nothing was written."]);
        return;
    }

    // (f) persist everything BEFORE the first block
    const fresh = kingdomStore.load();
    if (!fresh.kingdom || !districtById(fresh.kingdom, "district-1")) {
        releaseArea(token);
        finishJob(token);
        say(player, formatErrorLines("Stopped - nothing was changed", ["The saved kingdom is no longer readable, so progress could not be recorded."]));
        return;
    }
    const persisted = persistRun(outcome);
    if (!persisted.ok || persisted.queue === undefined) {
        releaseArea(token);
        finishJob(token);
        say(player, formatErrorLines("Stopped - nothing was changed", [String(persisted.reason)]));
        return;
    }
    const record = outcome.record;
    const civ = {
        status: "building",
        seed,
        anchor: { x: outcome.plan.anchor.x, z: outcome.plan.anchor.z },
        centre: summary.centre,
        checksum: record.checksum,
        stage: "clear",
        startedStep: Number.isInteger(fresh.kingdom.step) ? fresh.kingdom.step : 0,
        dimension: dimension.id,
        hq: summary.hq,
        ops: 0,
        opsTotal: summary.ops,
        placed: 0,
        skipped: 0,
    };
    const problems = civRecordProblems(civ);
    if (problems.length > 0 || !patchCiv(kingdomStore, civ)) {
        releaseArea(token);
        finishJob(token);
        say(player, formatErrorLines("Stopped - nothing was changed", problems.length > 0 ? problems : ["Could not record the build in the saved kingdom."]));
        return;
    }
    say(player, [...planLines, "Plan stored. Starting construction now."]);
    handedOver = true;
    prog.kind = "build";
    setPhase(prog, 6, "building");
    beginConstruction(kingdomStore, player, token, dimension, outcome.plan, record, persisted.queue, loaded.kingdom, prog);
    } catch (error) {
        prog.lastError = String(error);
        say(player, formatErrorLines("Failed - nothing was changed unless stated", [String(error), "The job slot and the ticking area were released."]));
    } finally {
        if (!handedOver) {
            releaseArea(token);
            finishJob(token);
            finishProgress(prog, token.cancelled ? "cancelled" : prog.lastError !== undefined ? "failed" : prog.state === "stalled" ? "stalled" : "done");
        }
    }
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {Player} player
 * @param {import("../integration/civBuilder.js").Job} token
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {any} plan
 * @param {any} record
 * @param {import("../civ/jobs.js").JobQueue} queue
 * @param {any} kingdomForRects
 * @param {import("../integration/civProgress.js").Progress} [prog]
 */
function beginConstruction(kingdomStore, player, token, dimension, plan, record, queue, kingdomForRects, prog = undefined) {
    const region = siteGroundRegion(plan, 1);
    let announced = false;
    const registerGates = () => {
        try {
            const result = gateRegistrar(kingdomStore, record, dimension.id);
            if (!result.ok) {
                say(player, formatErrorLines("Gate registration failed", [String(result.reason)]));
                return;
            }
            patchCiv(kingdomStore, { gates: true });
            if (!announced) {
                announced = true;
                say(player, [`Gates registered with the simulation (initially open): ${String(result.links.length)} gate(s), ${String(result.created.length)} adapter record(s) created.`]);
            }
        } catch (error) {
            say(player, formatErrorLines("Gate registration failed", [String(error)]));
        }
    };
    startConstruction({
        token,
        dimension,
        plan,
        record,
        queue,
        region,
        protectedRects: protectedRects(kingdomForRects, 1),
        say: (lines) => say(player, lines),
        saveCiv: (patch) => patchCiv(kingdomStore, patch),
        progress: prog,
        onStageComplete(stage) {
            if (stage === "gates") {
                registerGates();
            }
        },
        onEnd(result) {
            finishProgress(prog, result.status === "complete" ? "done" : "failed", result.status === "complete" ? undefined : result.reason);
            if (result.status === "complete") {
                registerGates();
                const spot = result.spot;
                say(player, [
                    "=== Hearthgate (enlarged) is built ===",
                    `Operations: estimated ${String(result.opsPlanned)}, processed ${String(result.opsDone)}; blocks placed ${String(result.counts.placed)}, already present ${String(result.counts.built)}, skipped ${String(result.counts.skipped)}, failed ${String(result.counts.failed)}, state fallbacks ${String(result.counts.stateFallbacks)}.`,
                    ...(result.counts.skipped > 0 ? ["Skipped (never overwritten):", ...topReasons(result.counts.byReason)] : []),
                    `Natural trees cleared ${String(result.counts.treesCleared)} (${String(result.counts.treeCells)} blocks); ${String(result.counts.skippedTrees)} tree(s) left alone.`,
                    ...(result.counts.stateFallbacks > 0 ? ["WARNING: some blocks were placed without their facing/state. Report the lines below."] : []),
                    ...result.counts.samples.slice(0, 4),
                    spot === undefined ? "" : `Centre: ${String(spot.x)}, ${String(spot.z)}.  Tour it: /tp @s ${String(spot.x)} ${String(spot.y)} ${String(spot.z)}`,
                    `Slices: ${String(result.slices.slices)} (max ${String(result.slices.maxOps)} ops, ${String(result.slices.maxReads)} reads per slice).`,
                ].filter((line) => line.length > 0));
            } else {
                say(player, formatErrorLines("Build paused", [String(result.reason), `${String(result.opsDone)} of ${String(result.opsPlanned)} operations are done and saved.`, `Continue with /scriptevent ${CIV_EVENT_IDS.resume}.`, ...result.counts.samples.slice(0, 3)]));
            }
        },
    });
}

// ---------------------------------------------------------------------------------------------
// civ:generate_resume

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
async function handleResume(kingdomStore, event) {
    const title = "Resume refused";
    const player = playerOf(event);
    if (player === undefined) {
        reply(formatErrorLines(title, ["Run this as a player."]), event);
        return;
    }
    if (isBusy()) {
        say(player, formatErrorLines(title, [runningPhrase()]));
        return;
    }
    sweepAbandonedHolds((lines) => say(player, lines));
    const loaded = kingdomStore.load();
    const district = loaded.kingdom ? districtById(loaded.kingdom, "district-1") : undefined;
    const civ = district?.civ;
    if (!loaded.kingdom || !district || civ === undefined) {
        say(player, formatErrorLines(title, ["There is no generated civilization to resume."]));
        return;
    }
    if (civ.status === "complete") {
        say(player, formatErrorLines(title, ["The civilization is already complete."]));
        return;
    }
    if (civ.dimension !== undefined && civ.dimension !== player.dimension.id) {
        say(player, formatErrorLines(title, [`The build is in ${String(civ.dimension)}; you are in ${player.dimension.id}.`]));
        return;
    }
    const token = reserveJob("civ-resume");
    if (token === undefined) {
        say(player, formatErrorLines(title, [runningPhrase()]));
        return;
    }
    say(player, ["=== Resuming the civilization build ===", "Reloading the stored plan and job queue; verifying the checksum..."]);
    const prog = startProgress("resume", token, (lines) => say(player, lines));
    setPhase(prog, 1, "rebuilding the plan from storage");
    startMonitor(prog, (reason) => onTrouble(player, prog, reason));
    let handedOver = false;
    try {
        // yield one tick so the message lands before the heavy rebuild
        await new Promise((resolve) => system.runTimeout(() => resolve(undefined), 1));
        if (token.cancelled) {
            return;
        }
        const resumeOps = newOps();
        lastResumeOps = resumeOps;
        const restored = await runJobAsync(token, loadSavedRunSteps(civ, resumeOps), prog);
        if (token.cancelled || restored === undefined) {
            return;
        }
        markYield(resumeOps);
        if (!restored.ok) {
            prog.lastError = String(restored.reasons[0]);
            finishJob(token);
            say(player, formatErrorLines(title, [...restored.reasons, "Nothing was changed."]));
            return;
        }
        patchCiv(kingdomStore, { status: "building" });
        say(player, [`Verified plan ${String(civ.checksum)}; ${String(restored.recovered)} interrupted element(s) recovered. Continuing.`]);
        handedOver = true;
        prog.kind = "build";
        setPhase(prog, 6, "building");
        beginConstruction(kingdomStore, player, token, player.dimension, restored.plan, restored.record, restored.queue, loaded.kingdom, prog);
    } catch (error) {
        prog.lastError = String(error);
        say(player, formatErrorLines("Resume failed", [String(error), "The job slot and the ticking area were released."]));
    } finally {
        if (!handedOver) {
            releaseArea(token);
            finishJob(token);
            finishProgress(prog, token.cancelled ? "cancelled" : prog.lastError !== undefined ? "failed" : "done");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// status / abort / devgate

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handleStatus(kingdomStore, event) {
    const loaded = kingdomStore.load();
    const district = loaded.kingdom ? districtById(loaded.kingdom, "district-1") : undefined;
    if (!loaded.kingdom || !district) {
        reply(formatErrorLines("Civilization status", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }
    const civ = district.civ;
    const lines = ["=== Civilization generation ==="];
    sweepAbandonedHolds((swept) => lines.push(...swept));
    const running = getProgress();
    const finished = getLastRun();
    if (running !== undefined && running.kind === "build") {
        const live = sessionStatus();
        if (live !== undefined) running.percent = live.pct;
    }
    if (running !== undefined) {
        lines.push("Active session:", ...describeProgress(running).map((line) => "  " + line.trimStart()));
    } else if (finished !== undefined) {
        lines.push("Last run:", ...describeProgress(finished).map((line) => "  " + line.trimStart()));
    }
    if (civ === undefined) {
        if (running !== undefined) {
            lines.push(`Nothing is stored yet: a ${running.kind} session is running (see above).`);
        } else if (finished !== undefined) {
            lines.push(`Nothing is stored: the last run did not produce a civilization (see above). /scriptevent ${CIV_EVENT_IDS.plan} (read-only) or ${CIV_EVENT_IDS.generate} to try again.`);
        } else {
            lines.push(`Not generated. /scriptevent ${CIV_EVENT_IDS.plan} (read-only) or ${CIV_EVENT_IDS.generate} in a NEW Creative world.`);
        }
    } else {
        lines.push(`Hearthgate (enlarged): ${String(civ.status)}, stage ${String(civ.stage)}, plan ${String(civ.checksum)}, seed ${String(civ.seed)}, anchor ${String(civ.anchor?.x)}, ${String(civ.anchor?.z)}, centre ${String(civ.centre?.x)}, ${String(civ.centre?.z)}, started at step ${String(civ.startedStep)}.`);
        const live = sessionStatus();
        if (live !== undefined) {
            lines.push(`Running (${live.status}): ${live.stage} ${String(live.pct)}% (${String(live.done)} / ${String(live.total)} ops); placed ${String(live.counts.placed)}, skipped ${String(live.counts.skipped)}, failed ${String(live.counts.failed)}.`);
        } else {
            const stored = createJobStore(world).loadQueue({ recoverRunning: false });
            if (stored.status === "ok" && stored.queue !== undefined) {
                const overall = progress(stored.queue);
                lines.push(`Stored queue: ${String(overall.pct)}% (${String(overall.totalOps - overall.remainingOps)} / ${String(overall.totalOps)} ops), state ${stored.queue.state}${civ.status !== "complete" ? `; continue with /scriptevent ${CIV_EVENT_IDS.resume}` : ""}.`);
            } else {
                lines.push(`Stored queue: ${stored.status}${stored.reason ? ` (${stored.reason})` : ""}.`);
            }
        }
    }
    lines.push(isBusy() ? `Job slot: ${String(activeKind())}${running !== undefined ? " (" + describeRunning(running) + ")" : ""}` : "No job running.", `Districts 2-5: not enabled in this build (dev gate ${devGateOn() ? "on" : "off"}).`);
    reply(lines, event);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handleAbort(kingdomStore, event) {
    void kingdomStore;
    if (!isBusy()) {
        const swept = /** @type {string[]} */ ([]);
        sweepAbandonedHolds((lines) => swept.push(...lines));
        reply(["No civilization job is running.", ...swept], event);
        return;
    }
    const result = abortCivJob();
    if (result === undefined) {
        reply([`A ${String(activeKind())} job (not a civilization job) is running; civ:generate_abort only stops civilization jobs. Use /scriptevent civ:district_abort for that one.`], event);
        return;
    }
    reply(civAbortLines(result, CIV_EVENT_IDS.resume), event);
}

/**
 * Cheap diagnostics for real-game problems: the engine's chunk limits, whether a tile would fit, what we own.
 * @param {ScriptEvent} event
 */
function handleDiag(event) {
    const lines = ["=== Civilization diagnostics ==="];
    try {
        const manager = world.tickingAreaManager;
        lines.push(`Ticking-area limit (maxChunkCount): ${String(manager.maxChunkCount)}; chunks in use pack-wide (chunkCount): ${String(manager.chunkCount)}; survey tile ${String(tileSizeNow())} x ${String(tileSizeNow())} blocks.`);
        const player = playerOf(event);
        if (player !== undefined) {
            const px = Math.floor(player.location.x / 128) * 128;
            const pz = Math.floor(player.location.z / 128) * 128;
            try {
                lines.push(`hasCapacity for a 64-chunk tile at ${String(px)},${String(pz)}: ${String(manager.hasCapacity({ dimension: player.dimension, from: { x: px, y: 64, z: pz }, to: { x: px + 127, y: 64, z: pz + 127 } }))}.`);
            } catch (error) {
                lines.push(`hasCapacity failed: ${String(error)}`);
            }
            try {
                const loadedHere = /** @type {any} */ (player.dimension).isChunkLoaded?.(player.location);
                lines.push(`Your chunk is loaded: ${String(loadedHere)}.`);
            } catch (error) {
                lines.push(`isChunkLoaded failed: ${String(error)}`);
            }
        }
        for (const id of [CIV_TICKING_ID, PHYSICAL.tickingAreaId]) {
            const present = manager.hasTickingArea(id);
            lines.push(`Ticking area '${id}': ${present ? `present, fully loaded: ${String(manager.getTickingArea(id)?.isFullyLoaded)}` : "none"}.`);
        }
    } catch (error) {
        lines.push(`Ticking-area manager unavailable: ${String(error)}`);
    }
    const running = getProgress();
    const finished = getLastRun();
    lines.push(isBusy() ? `Job slot: ${String(activeKind())}${running !== undefined ? " (" + describeRunning(running) + ")" : ""}` : "No job running.");
    const last = running ?? finished;
    lines.push(last?.lastError !== undefined ? `Last session error: ${last.lastError}` : "Last session error: none.");
    lines.push(`Tick ${String(nowTick())}. Timeouts: hold ${String(CIV.holdTimeoutTicks)} ticks x ${String(1 + CIV.holdRetries)}, stall ${String(CIV.stallTicks)}, deadline ${String(CIV.planDeadlineTicks)}.`);
    reply(lines, event);
}

/**
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleDevgate(args, event) {
    const value = args[0]?.toLowerCase();
    if (value === "on" || value === "off") {
        world.setDynamicProperty(CIV.devGateKey, value === "on");
        reply([`Development gate ${value}. Districts 2-5 are not enabled in this build either way.`, ...CIV_SAFETY_WARNING], event);
        return;
    }
    reply([`Development gate is ${devGateOn() ? "on" : "off"}. Usage: /scriptevent ${CIV_EVENT_IDS.devgate} on|off`, ...CIV_SAFETY_WARNING], event);
}
