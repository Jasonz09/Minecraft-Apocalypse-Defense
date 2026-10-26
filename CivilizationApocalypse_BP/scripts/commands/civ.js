import { system, world } from "@minecraft/server";
import { CIV, CIV_EVENT_IDS, DISTRICT_NAMES, PHYSICAL, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { markYield, newOps } from "../civ/regions.js";
import { siteGroundRegion } from "../civ/siteprofile.js";
import { abortCivJob, civAbortLines, civilizationOverview, describePlan, discardRun, districtIdFor, loadMasterPlan, loadSavedRunSteps, persistRun, planWorld, sessionStatus, startConstruction, storedQueueStatus, storageFootprint, PROTECT_MARGIN, WRITE_PROTECT_GROW, DISTRICT_INDEXES } from "../integration/civBuilder.js";
import { registerBuiltGates } from "../integration/civGates.js";
import { describeProgress, describeRunning, finishProgress, formatTicks, getLastRun, getProgress, nowTick, setPhase, startMonitor, startProgress } from "../integration/civProgress.js";
import { CIV_TICKING_ID, releaseArea, runJobAsync, tileSizeNow } from "../integration/civScan.js";
import { activeKind, activeToken, finishJob, isBusy, releaseChunks, reserveJob } from "../integration/districtBuilder.js";
import { computeTotals, districtById, findValidationProblems } from "../kingdom/state.js";
import { formatErrorLines } from "../ui/report.js";
import { parseArgs } from "./args.js";
import { reply } from "./reply.js";

/**
 * One-command civilization generation for a dedicated NEW Creative test world, district by district.
 *
 *   civ:generate [district=N] [site=here] [radius=N] [seed=N]
 *                              survey, plan, validate, store, then build district N (default 1) - ONE invocation authorises it all
 *   civ:generate_plan [district=N|all] ...
 *                              the same planning, strictly read-only: one district's numbers, or the whole civilization's totals
 *   civ:generate_status        every district: status, stage, placed/skipped, ops, centre
 *   civ:generate_abort [district=N]  stop; placed blocks stay and the queue is kept
 *   civ:generate_resume [district=N] continue that district from its own stored plan and queue (also after a restart)
 *   civ:generate_devgate on|off      development gate: districts 2-5 may only be started with it on
 *   civ:generate_diag          engine limits, holds, session, stored bytes per key family
 *
 * Districts are built one at a time, in index order: they share one master plan, one wall network and one gate
 * registry, so a district needs its lower-numbered neighbours physically finished before it may start. Nothing here
 * runs at import or activation, and nothing starts without one of these typed commands.
 *
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ScriptEvent
 * @typedef {import("@minecraft/server").Player} Player
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 * @typedef {import("../integration/civBuilder.js").ProtectedArea} ProtectedArea
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
 * Registers the development gate switch, which always listens because it is the only way to turn the gate on.
 * The generation commands register only when the gate is on: at load (checked on the first tick, because early
 * execution cannot read world properties) or when the switch turns it on. Ledger pattern (ledger/devgate.js).
 * @param {KingdomStore} kingdomStore
 */
export function registerCivCommands(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;
    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (event.id === CIV_EVENT_IDS.devgate) {
            handleDevgate(kingdomStore, parseArgs(event.message), event);
        }
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
    system.run(() => {
        if (devGateOn()) {
            enableCivGeneration(kingdomStore);
        }
    });
}

/** Whether the generation listener is subscribed (once, ever, in this session). */
let generationSubscribed = false;
/** Whether generation commands are currently answered; turning the gate off clears it. */
let generationOn = false;

/**
 * Subscribes the generation commands the first time the gate is on, and answers them only while it stays on.
 * @param {KingdomStore} kingdomStore
 */
function enableCivGeneration(kingdomStore) {
    generationOn = true;
    if (generationSubscribed) {
        return;
    }
    generationSubscribed = true;
    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (!generationOn) {
            return;
        }
        const id = event.id;
        if (id === CIV_EVENT_IDS.generate) {
            void handleGenerate(kingdomStore, parseArgs(event.message), event, false);
        } else if (id === CIV_EVENT_IDS.plan) {
            void handleGenerate(kingdomStore, parseArgs(event.message), event, true);
        } else if (id === CIV_EVENT_IDS.status) {
            handleStatus(kingdomStore, event);
        } else if (id === CIV_EVENT_IDS.abort) {
            handleAbort(kingdomStore, parseArgs(event.message), event);
        } else if (id === CIV_EVENT_IDS.resume) {
            void handleResume(kingdomStore, parseArgs(event.message), event);
        } else if (id === CIV_EVENT_IDS.diag) {
            handleDiag(event);
        }
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/**
 * @param {string[]} args
 * @returns {{ radius: number, seed: number | undefined, districts: string | undefined, district: number | "all" | undefined, site: string | undefined, error: string | undefined }}
 */
export function parseCivArgs(args) {
    /** @type {{ radius: number, seed: number | undefined, districts: string | undefined, district: number | "all" | undefined, site: string | undefined, error: string | undefined }} */
    const out = { radius: CIV.defaultSearchRadius, seed: undefined, districts: undefined, district: undefined, site: undefined, error: undefined };
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
        } else if (name === "district") {
            if (raw.toLowerCase() === "all") {
                out.district = "all";
                continue;
            }
            const value = Number(raw);
            if (!/^\d+$/.test(raw) || !DISTRICT_INDEXES.includes(value)) {
                out.error = `district must be 1 to ${String(DISTRICT_INDEXES.length)} (or all, for civ:generate_plan)`;
                return out;
            }
            out.district = value;
        } else if (name === "site") {
            const value = raw.toLowerCase();
            if (value !== "here") {
                out.error = "site takes one value: here (plan on the spot you are standing)";
                return out;
            }
            out.site = value;
        } else if (name === "districts") {
            out.districts = raw;
        } else {
            out.error = `unknown argument '${name}='`;
            return out;
        }
    }
    return out;
}

/** @param {number | "all" | undefined} district @returns {number} */
export function districtIndexOf(district) {
    return district === undefined || district === "all" ? 1 : district;
}

/**
 * Rectangles / polygons nothing may be written in: the 49 x 49 prototype of every district that has one
 * (`district.physical.origin`), plus the land claimed by every district whose civilization build is `building` or
 * `complete` - a later district must never re-place or clear what a neighbour already placed.
 *
 * A built district's footprint is its outline polygon (its bounding box alone would overlap the interlocking
 * neighbours), grown by `grow` blocks so the shared wall band keeps a single owner. The district being worked on is
 * never in its own list: `exceptIndex` names it.
 *
 * @param {any} kingdom
 * @param {number} pad
 * @param {any} [plan] the stored master plan (without it only the prototypes are known)
 * @param {number} [grow] outline clearance in blocks
 * @param {number} [exceptIndex] the district that is asking
 * @returns {ProtectedArea[]}
 */
export function protectedRects(kingdom, pad, plan = undefined, grow = pad, exceptIndex = 0) {
    /** @type {ProtectedArea[]} */
    const rects = [];
    for (const district of /** @type {any[]} */ (kingdom?.districts ?? [])) {
        const origin = district?.physical?.origin;
        if (origin !== undefined && Number.isInteger(origin.x) && Number.isInteger(origin.z)) {
            const half = PROTOTYPE_HALF + pad;
            rects.push({ x0: origin.x - half, z0: origin.z - half, x1: origin.x + half, z1: origin.z + half, label: `${String(district.id)} prototype` });
        }
        const status = district?.civ?.status;
        if (status !== "building" && status !== "complete") {
            continue;
        }
        const index = Number(String(district.id).replace(/^district-/, ""));
        if (index === exceptIndex) {
            continue;
        }
        const entry = /** @type {any[]} */ (plan?.districts ?? []).find((one) => one?.index === index);
        if (entry !== undefined && Array.isArray(entry.outline)) {
            const polygon = /** @type {[number, number][]} */ (entry.outline);
            let x0 = Infinity;
            let z0 = Infinity;
            let x1 = -Infinity;
            let z1 = -Infinity;
            for (const point of polygon) {
                x0 = Math.min(x0, point[0]);
                z0 = Math.min(z0, point[1]);
                x1 = Math.max(x1, point[0]);
                z1 = Math.max(z1, point[1]);
            }
            rects.push({ x0: x0 - grow, z0: z0 - grow, x1: x1 + grow, z1: z1 + grow, polygon, grow, label: `${String(district.id)} ${String(entry.name ?? "")} (${String(status)})` });
        } else if (Number.isInteger(district?.civ?.centre?.x)) {
            // no master plan to take the outline from: guard a square around the recorded centre
            const half = PROTOTYPE_HALF + pad;
            rects.push({ x0: district.civ.centre.x - half, z0: district.civ.centre.z - half, x1: district.civ.centre.x + half, z1: district.civ.centre.z + half, label: `${String(district.id)} recorded centre` });
        }
    }
    return rects;
}

/**
 * What a world that is already being played holds, or undefined for one the simulation has never ticked.
 * A fresh site search in a running kingdom is a deliberate choice, not a default: runGenerate refuses it
 * unless the player made that choice (`site=here`, or the Horn of Hearthgate's confirmation).
 *
 * @param {any} kingdom
 * @returns {{ step: number, districts: number, civilians: number, soldiers: number, projects: number } | undefined}
 */
export function populatedKingdom(kingdom) {
    const districts = /** @type {any[]} */ (kingdom?.districts ?? []);
    const step = Number.isInteger(kingdom?.step) ? /** @type {number} */ (kingdom.step) : 0;
    const projects = districts.reduce((sum, district) => sum + (Array.isArray(district?.projects) ? district.projects.length : 0), 0);
    if (step <= 0 && projects === 0) {
        return undefined;
    }
    const totals = computeTotals({ districts });
    return { step, districts: totals.districts, civilians: totals.civilians, soldiers: totals.soldiers, projects };
}

/**
 * Which district may be worked on right now, and why not.
 * @param {any} kingdom
 * @param {number} index
 * @param {boolean} planOnly
 * @returns {string[]} empty when the district may start
 */
export function startProblems(kingdom, index, planOnly = false) {
    /** @type {string[]} */
    const problems = [];
    const districts = /** @type {any[]} */ (kingdom?.districts ?? []);
    const byId = (/** @type {string} */ id) => districts.find((district) => district.id === id);
    const wanted = byId(districtIdFor(index));
    if (wanted === undefined) {
        return [`the kingdom holds no ${districtIdFor(index)}: nothing to build`];
    }
    const busy = districts.filter((district) => district.civ?.status === "building" && district.id !== wanted.id);
    if (busy.length > 0 && !planOnly) {
        for (const other of busy) {
            const otherIndex = Number(String(other.id).replace(/^district-/, ""));
            problems.push(`${String(other.id)} (${String(other.name ?? DISTRICT_NAMES[otherIndex - 1] ?? "")}) is still being built - one district at a time: finish it with /scriptevent ${CIV_EVENT_IDS.resume} district=${String(otherIndex)}, or stop it with /scriptevent ${CIV_EVENT_IDS.abort}`);
        }
    }
    if (!planOnly) {
        const missing = DISTRICT_INDEXES.filter((lower) => lower < index).filter((lower) => byId(districtIdFor(lower))?.civ?.status !== "complete");
        if (missing.length > 0) {
            problems.push(`its neighbours are not built yet: ${missing.map((lower) => `${districtIdFor(lower)} ${String(byId(districtIdFor(lower))?.name ?? DISTRICT_NAMES[lower - 1] ?? "")} (${String(byId(districtIdFor(lower))?.civ?.status ?? "not built")})`).join(", ")}. Build them first - districts share their walls, so each one needs the lower-numbered ones standing.`);
        }
    }
    return problems;
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

/** @param {KingdomStore} store @param {string} districtId @param {Record<string, any>} patch */
function patchCiv(store, districtId, patch) {
    const loaded = store.load();
    if (!loaded.kingdom) {
        return false;
    }
    const district = districtById(loaded.kingdom, districtId);
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

/** @param {number} index */
function districtTitle(index) {
    const name = DISTRICT_NAMES[index - 1] ?? `district ${String(index)}`;
    return `${name} (${districtIdFor(index)})`;
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
 * The scriptevent entry point. The generation itself lives in runGenerate(), so the Horn of
 * Hearthgate can start the same build through the same refusals and the same stored queue.
 *
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 * @param {boolean} planOnly
 */
async function handleGenerate(kingdomStore, args, event, planOnly) {
    const player = playerOf(event);
    if (player === undefined) {
        reply(formatErrorLines(planOnly ? "Plan refused" : "Generate refused", ["Run this as a player: the search is centred on you."]), event);
        return;
    }
    return runGenerate(kingdomStore, player, parseCivArgs(args), planOnly);
}

/**
 * Survey, plan, store and build one district, as a player.
 *
 * @param {KingdomStore} kingdomStore
 * @param {Player} player
 * @param {ReturnType<typeof parseCivArgs>} options
 * @param {boolean} planOnly
 * @param {boolean} [confirmed] true when the player already answered a build confirmation (the Horn of
 *   Hearthgate's form). It only lets a populated world's fresh site search through; it never changes what is built.
 */
export async function runGenerate(kingdomStore, player, options, planOnly, confirmed = false) {
    const title = planOnly ? "Plan refused" : "Generate refused";
    if (options.error !== undefined) {
        say(player, formatErrorLines(title, [options.error, `Usage: /scriptevent ${planOnly ? CIV_EVENT_IDS.plan : CIV_EVENT_IDS.generate} [district=1-${String(DISTRICT_INDEXES.length)}${planOnly ? "|all" : ""}] [site=here] [radius=24-${String(CIV.maxSearchRadius)}] [seed=N]`]));
        return;
    }
    if (options.districts !== undefined) {
        say(player, formatErrorLines(title, [
            `districts= lists several at once; one command builds one district: district=1 to district=${String(DISTRICT_INDEXES.length)}${planOnly ? ", or district=all for the whole civilization's totals" : ""}.`,
            devGateOn() ? "The development gate is on, so districts 2 and up may start as soon as their lower-numbered neighbours are complete." : `Districts 2-${String(DISTRICT_INDEXES.length)} are development-only: /scriptevent ${CIV_EVENT_IDS.devgate} on.`,
        ]));
        return;
    }
    if (options.district === "all" && !planOnly) {
        say(player, formatErrorLines(title, [`district=all is read-only: it prints the totals of all ${String(DISTRICT_INDEXES.length)} districts. Name the one district to build (district=1 to district=${String(DISTRICT_INDEXES.length)}), or use /scriptevent ${CIV_EVENT_IDS.plan} district=all.`]));
        return;
    }
    const index = districtIndexOf(options.district);
    const districtId = districtIdFor(index);
    const kingdomLoaded = kingdomStore.load();
    const kingdom = kingdomLoaded.kingdom;
    if (options.district === "all") {
        handlePlanAll(player, kingdom);
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
    const loaded = kingdomLoaded;
    const district = loaded.kingdom ? districtById(loaded.kingdom, districtId) : undefined;
    if (!loaded.kingdom || !district) {
        say(player, formatErrorLines(title, [`No readable kingdom in this world: ${String(loaded.reason)}`]));
        return;
    }
    if (!planOnly && district.civ !== undefined) {
        say(player, formatErrorLines(title, [`${districtTitle(index)} already exists here (${String(district.civ.status)}).`, `Use /scriptevent ${CIV_EVENT_IDS.status}, or ${CIV_EVENT_IDS.resume} district=${String(index)} to continue an interrupted build. Nothing is generated twice.`]));
        return;
    }
    if (index > 1 && !devGateOn()) {
        say(player, formatErrorLines(title, [`${districtTitle(index)} is development-only: the development gate is off.`, `/scriptevent ${CIV_EVENT_IDS.devgate} on (a released world ships with it off and wiped).`]));
        return;
    }
    const master = loadMasterPlan();
    const populated = planOnly ? undefined : populatedKingdom(kingdom);
    if (master.plan === undefined || master.plan === null) {
        if (index > 1) {
            say(player, formatErrorLines(title, [`nothing to build ${districtId} from: this world holds no five-district master plan (civ:plan reads '${String(master.status)}').`, `Build district 1 first (it makes the master plan): /scriptevent ${CIV_EVENT_IDS.generate} district=1${options.site === "here" ? " site=here" : ""} seed=${String(options.seed ?? 1)}`]));
            return;
        }
        if (populated !== undefined && options.site !== "here" && !confirmed) {
            say(player, formatErrorLines(title, [
                `this world already holds a running kingdom: ${String(populated.districts)} districts, ${String(populated.civilians)} civilians, ${String(populated.soldiers)} soldiers, ${String(populated.projects)} construction projects at simulation step ${String(populated.step)} - and no physical district is planned in it.`,
                `A build would survey a NEW site around you and add the physical ${districtTitle(index)} there; the kingdom's population, projects and territory are left as they are.`,
                `That is a deliberate choice in a populated world: use the Horn of Hearthgate (it asks first), or run /scriptevent ${CIV_EVENT_IDS.generate} site=here to build exactly where you stand. Nothing was changed.`,
            ]));
            return;
        }
    } else if (options.site === "here") {
        say(player, formatErrorLines(title, [`a master plan is already stored here (anchor ${String(master.anchor?.x)}, ${String(master.anchor?.z)}): site=here only chooses a NEW place, and the districts would no longer share one layout.`, `Build from the stored plan: /scriptevent ${planOnly ? CIV_EVENT_IDS.plan : CIV_EVENT_IDS.generate} district=${String(index)}`]));
        return;
    }
    const blocked = startProblems(loaded.kingdom, index, planOnly);
    if (blocked.length > 0) {
        say(player, formatErrorLines(title, [...blocked, "Nothing was changed."]));
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
    // Two protection lists, deliberately different:
    //  - `exclusions` is what a NEW master plan and a site search must keep clear (built neighbours' outlines included);
    //  - `plannerFootprints` is what the district's own construction planner drops elements for. That test compares
    //    bounding boxes, and district boxes interlock, so feeding it a neighbour's land would delete this district's
    //    walls and half its lots. The neighbours are instead protected op by op while building (see beginConstruction).
    const exclusions = protectedRects(loaded.kingdom, PROTECT_MARGIN, master.plan, PROTECT_MARGIN, index);
    const plannerFootprints = protectedRects(loaded.kingdom, PROTECT_MARGIN, undefined, PROTECT_MARGIN, index);
    const reusing = master.plan !== undefined && master.plan !== null;
    say(player, [
        `=== ${planOnly ? `Civilization plan (read-only): ${districtTitle(index)}` : `Generating ${districtTitle(index)}`} ===`,
        reusing
            ? `Master plan stored here since anchor ${String(master.anchor?.x)}, ${String(master.anchor?.z)} (seed ${String(seed)}); only ${districtId}'s own ground is surveyed; ${String(exclusions.length)} protected footprint(s).`
            : `Centre ${String(anchor.x)}, ${String(anchor.z)}; ${options.site === "here" ? "site: exactly where you stand (no search)" : `search radius ${String(options.radius)}`}; seed ${String(seed)}; ${String(exclusions.length)} protected footprint(s).`,
        ...CIV_SAFETY_WARNING,
        ...(populated !== undefined ? [`This world is already being played (${String(populated.districts)} districts, ${String(populated.civilians)} civilians, ${String(populated.soldiers)} soldiers, ${String(populated.projects)} construction projects at step ${String(populated.step)}): the physical district is added and those records are kept.`] : []),
        planOnly ? "Nothing will be written." : "This one command authorises this district's whole build; progress is reported as it goes. Use civ:generate_abort to stop.",
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
        outcome = await planWorld({ token, dimension, anchor, radius: options.radius, seed, exclusions, plannerFootprints, say: sayHere, progress: prog, district: index, siteMode: options.site === "here" ? "here" : undefined });
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
    const region = /** @type {{ x0: number, z0: number, x1: number, z1: number }} */ (outcome.region ?? { x0: 0, z0: 0, x1: 0, z1: 0 });
    const site = /** @type {any} */ (outcome.site);
    const planLines = [
        outcome.masterIsNew
            ? `Site: window ${String(site.window.x0)},${String(site.window.z0)} to ${String(site.window.x1)},${String(site.window.z1)}, ${String(Math.round(site.distance))} blocks from you; ${districtId} centre ${String(summary.centre.x)}, ${String(summary.centre.z)}.`
            : `${districtId} lies on the stored master plan: region ${String(region.x0)},${String(region.z0)} to ${String(region.x1)},${String(region.z1)}, centre ${String(summary.centre.x)}, ${String(summary.centre.z)}.`,
        `District areas ${summary.areas.join(" / ")} columns; compactness ${summary.compactness.map((c) => c.toFixed(2)).join(" / ")}; bbox fill ${summary.bboxFill.map((c) => c.toFixed(2)).join(" / ")}.`,
        `Walls ${String(summary.wallLength)} blocks, ${String(summary.gateCount)} gates, roads ${String(summary.roadLength)} blocks, ${String(summary.lots)} lots in ${districtId}.`,
        summary.shortfalls.length === 0
            ? `Facilities: every kind the ${String(summary.name).toLowerCase()} programme asked for is sited.`
            : `Facilities NOT sited: ${summary.shortfalls.map((s) => `${s.kind} ${String(s.placed)}/${String(s.wanted)}`).join(", ")} - each one is in the plan notes, none is silently dropped.`,
        ...(summary.facilityProblems.length > 0 ? [`Facility audit: ${summary.facilityProblems.slice(0, 3).join(" | ")}`] : []),
        `Estimated ${String(summary.ops)} block operations in about ${String(summary.slices)} slices (survey + planning + build), estimated minutes ${String(summary.minutes)} at one slice per tick - an estimate until measured in Minecraft. Stored size ${String(summary.stored.bytes)} / ${String(summary.stored.limit)} bytes (master plan ${String(summary.stored.master.bytes)}, ${districtId} site ${String(summary.stored.site.bytes)}).`,
    ];
    if (planOnly) {
        releaseArea(token);
        finishJob(token);
        const rest = [...(options.radius === CIV.defaultSearchRadius ? [] : [` radius=${String(options.radius)}`]), ` seed=${String(seed)}`, ...(options.site === "here" ? [" site=here"] : []), ...(index === 1 ? [] : [` district=${String(index)}`])].join("");
        say(player, ["=== Plan is valid ===", ...planLines, `To build it: /scriptevent ${CIV_EVENT_IDS.generate}${rest}`, "Nothing was written."]);
        return;
    }

    // (f) persist everything BEFORE the first block
    const fresh = kingdomStore.load();
    if (!fresh.kingdom || !districtById(fresh.kingdom, districtId)) {
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
        district: index,
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
        layout: summary.layoutId,
    };
    const problems = civRecordProblems(civ);
    if (problems.length > 0 || !patchCiv(kingdomStore, districtId, civ)) {
        releaseArea(token);
        finishJob(token);
        try {
            // nothing was authorised: take this district's plan and queue back down again
            const leftovers = discardRun(outcome);
            if (leftovers.length > 0) {
                say(player, [`could not clear what was stored for this run: ${leftovers.join("; ")}`]);
            }
        } catch (_error) {
            // best effort: an orphan plan nobody recorded is never built
        }
        say(player, formatErrorLines("Stopped - nothing was changed", problems.length > 0 ? problems : ["Could not record the build in the saved kingdom."]));
        return;
    }
    say(player, [...planLines, "Plan stored. Starting construction now."]);
    handedOver = true;
    prog.kind = "build";
    setPhase(prog, 6, "building");
    beginConstruction(kingdomStore, player, token, dimension, outcome.plan, record, persisted.queue, loaded.kingdom, index, prog);
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
 * @param {number} index the district this build owns (1..5)
 * @param {import("../integration/civProgress.js").Progress} [prog]
 */
function beginConstruction(kingdomStore, player, token, dimension, plan, record, queue, kingdomForRects, index, prog = undefined) {
    const districtId = districtIdFor(index);
    const region = siteGroundRegion(plan, index);
    // The land the already-built neighbours claim, outlines included: nothing of theirs is re-placed or cleared.
    const protectedAreas = protectedRects(kingdomForRects, 1, plan, WRITE_PROTECT_GROW, index);
    let announced = false;
    const registerGates = () => {
        try {
            const result = gateRegistrar(kingdomStore, record, dimension.id);
            if (!result.ok) {
                say(player, formatErrorLines("Gate registration failed", [String(result.reason)]));
                return;
            }
            patchCiv(kingdomStore, districtId, { gates: true });
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
        district: index,
        protectedRects: protectedAreas,
        say: (lines) => say(player, lines),
        saveCiv: (patch) => patchCiv(kingdomStore, districtId, patch),
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
                const guarded = protectedAreas.filter((area) => area.polygon !== undefined).length;
                say(player, [
                    `=== ${DISTRICT_NAMES[index - 1] ?? districtId} (enlarged) is built ===`,
                    `Operations: estimated ${String(result.opsPlanned)}, processed ${String(result.opsDone)}; blocks placed ${String(result.counts.placed)}, already present ${String(result.counts.built)}, skipped ${String(result.counts.skipped)}, failed ${String(result.counts.failed)}, state fallbacks ${String(result.counts.stateFallbacks)}.`,
                    ...(result.counts.outside > 0 ? [`${String(result.counts.outside)} op(s) fell outside this district or inside a finished neighbour's footprint and were not written.`] : []),
                    ...(result.counts.skipped > 0 ? ["Skipped (never overwritten):", ...topReasons(result.counts.byReason)] : []),
                    `Natural trees cleared ${String(result.counts.treesCleared)} (${String(result.counts.treeCells)} blocks); ${String(result.counts.skippedTrees)} tree(s) left alone.`,
                    ...(result.counts.stateFallbacks > 0 ? ["WARNING: some blocks were placed without their facing/state. Report the lines below."] : []),
                    ...result.counts.samples.slice(0, 4),
                    spot === undefined ? "" : `Centre: ${String(spot.x)}, ${String(spot.z)}.  Tour it: /tp @s ${String(spot.x)} ${String(spot.y)} ${String(spot.z)}`,
                    `Slices: ${String(result.slices.slices)} (max ${String(result.slices.maxOps)} ops, ${String(result.slices.maxReads)} reads per slice).`,
                    guarded > 0 ? `Neighbour footprints kept clear: ${String(guarded)}.` : "",
                    index < DISTRICT_INDEXES.length ? `Next: /scriptevent ${CIV_EVENT_IDS.generate} district=${String(index + 1)}` : "All five districts are built.",
                ].filter((line) => line.length > 0));
            } else {
                say(player, formatErrorLines("Build paused", [String(result.reason), `${String(result.opsDone)} of ${String(result.opsPlanned)} operations are done and saved.`, `Continue with /scriptevent ${CIV_EVENT_IDS.resume} district=${String(index)}.`, ...result.counts.samples.slice(0, 3)]));
            }
        },
    });
}

// ---------------------------------------------------------------------------------------------
// civ:generate_resume

/**
 * Which district `civ:generate_resume` means when the operator did not say: the one that is `building`, else the only
 * unfinished one. `undefined` plus a reason when nothing or several fit.
 * @param {any} kingdom
 * @returns {{ index: number | undefined, reason: string | undefined, candidates: number[] }}
 */
export function resumableDistrict(kingdom) {
    /** @type {(id: any) => number} */
    const indexOf = (id) => Number(String(id).replace(/^district-/, ""));
    const districts = /** @type {any[]} */ (kingdom?.districts ?? []);
    const withCiv = districts.filter((district) => district.civ !== undefined);
    if (withCiv.length === 0) {
        return { index: undefined, reason: "There is no generated civilization to resume.", candidates: [] };
    }
    const building = withCiv.filter((district) => district.civ.status === "building");
    if (building.length > 0) {
        return { index: indexOf(building[0].id), reason: undefined, candidates: building.map((district) => indexOf(district.id)) };
    }
    const unfinished = withCiv.filter((district) => district.civ.status !== "complete");
    if (unfinished.length === 1) {
        return { index: indexOf(unfinished[0].id), reason: undefined, candidates: [] };
    }
    if (unfinished.length === 0) {
        return { index: undefined, reason: "Every district that was started is already complete.", candidates: [] };
    }
    return {
        index: undefined,
        reason: `several districts are unfinished (${unfinished.map((district) => `${String(district.id)}: ${String(district.civ.status)}`).join(", ")}); say which one: district=N`,
        candidates: unfinished.map((district) => indexOf(district.id)),
    };
}

/**
 * The scriptevent entry point for a resume; the work lives in runResume().
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
async function handleResume(kingdomStore, args, event) {
    const player = playerOf(event);
    if (player === undefined) {
        reply(formatErrorLines("Resume refused", ["Run this as a player."]), event);
        return;
    }
    return runResume(kingdomStore, player, parseCivArgs(args));
}

/**
 * Continue an interrupted district from its own stored plan and queue, as a player.
 * @param {KingdomStore} kingdomStore
 * @param {Player} player
 * @param {ReturnType<typeof parseCivArgs>} options
 */
export async function runResume(kingdomStore, player, options) {
    const title = "Resume refused";
    if (options.error !== undefined) {
        say(player, formatErrorLines(title, [options.error, `Usage: /scriptevent ${CIV_EVENT_IDS.resume} [district=1-${String(DISTRICT_INDEXES.length)}]`]));
        return;
    }
    if (isBusy()) {
        say(player, formatErrorLines(title, [runningPhrase()]));
        return;
    }
    sweepAbandonedHolds((lines) => say(player, lines));
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        say(player, formatErrorLines(title, [`No readable kingdom in this world: ${String(loaded.reason)}`]));
        return;
    }
    const asked = options.district !== undefined && options.district !== "all" ? { index: options.district, reason: undefined, candidates: [] } : resumableDistrict(loaded.kingdom);
    const index = asked.index;
    if (index === undefined) {
        say(player, formatErrorLines(title, [String(asked.reason)]));
        return;
    }
    const districtId = districtIdFor(index);
    const district = districtById(loaded.kingdom, districtId);
    const civ = district?.civ;
    if (!district || civ === undefined) {
        say(player, formatErrorLines(title, [`${districtId} was never started: there is nothing to resume${options.district === undefined ? " (say which district you mean: district=N)" : ""}.`]));
        return;
    }
    if (civ.status === "complete") {
        say(player, formatErrorLines(title, [`${districtTitle(index)} is already complete.`]));
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
    say(player, [`=== Resuming the ${districtTitle(index)} build ===`, `Reloading ${districtId}'s stored plan and job queue; verifying the checksum...`]);
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
        const restored = await runJobAsync(token, loadSavedRunSteps(civ, resumeOps, index), prog);
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
        patchCiv(kingdomStore, districtId, { status: "building" });
        say(player, [`Verified plan ${String(civ.checksum)}; ${String(restored.recovered)} interrupted element(s) recovered. Continuing.`]);
        handedOver = true;
        prog.kind = "build";
        setPhase(prog, 6, "building");
        beginConstruction(kingdomStore, player, token, player.dimension, restored.plan, restored.record, restored.queue, loaded.kingdom, index, prog);
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
// civ:generate_plan district=all - the whole civilization in one read-only answer

/**
 * No survey, no hold, no write: the totals come from the stored master plan (which district claims which land) plus
 * the small `district.civ` records (which districts were built and how many operations they measured). A district
 * nobody has planned yet has its operations estimated from the measured districts per surveyed column, and is
 * labelled as an estimate.
 *
 * @param {Player} player @param {any} kingdom
 */
function handlePlanAll(player, kingdom) {
    const title = "Plan refused";
    const master = loadMasterPlan();
    if (master.plan === undefined || master.plan === null) {
        say(player, formatErrorLines(title, [`this world holds no five-district master plan (civ:plan reads '${String(master.status)}'), so there is nothing to total up.`, `/scriptevent ${CIV_EVENT_IDS.plan} makes one without writing anything.`]));
        return;
    }
    const overview = civilizationOverview(master.plan, kingdom);
    if (overview.problems.length > 0) {
        say(player, formatErrorLines(title, overview.problems));
        return;
    }
    const lines = [
        "=== The whole civilization in one look (read-only, no survey) ===",
        `Anchor ${String(master.anchor?.x)}, ${String(master.anchor?.z)}; ${String(overview.rows.length)} districts; ${String(protectedRects(kingdom, PROTECT_MARGIN, master.plan).length)} protected footprint(s); dev gate ${devGateOn() ? "on" : "off"}.`,
    ];
    for (const row of overview.rows) {
        lines.push(`  ${districtIdFor(row.index)} ${row.name}: ${row.status}; ${String(row.area)} claimed columns, ${String(row.columns)} to survey; ${row.measured ? `${String(row.ops)} ops measured` : row.estimated > 0 ? `~${String(row.estimated)} ops estimated from the measured districts` : "not estimated yet (no district measured)"}.`);
    }
    const totals = overview.totals;
    lines.push(`Totals: ${String(totals.complete)} complete, ${String(totals.building)} building, ${String(totals.paused)} paused, ${String(totals.unbuilt)} not started; ${String(totals.columns)} columns of ground in view, ~${String(totals.ops)} block operations (${String(totals.measured)} district(s) measured, the rest estimated - an estimate until measured in Minecraft).`);
    const stored = storageFootprint().families.filter((family) => family.bytes > 0);
    if (stored.length > 0) {
        lines.push(`Stored: ${stored.map((family) => `${family.prefix} ${String(family.bytes)} B / ${String(family.limit)}`).join(", ")}.`);
    }
    lines.push(`One district's real numbers, surveyed: /scriptevent ${CIV_EVENT_IDS.plan} district=N. Build one: /scriptevent ${CIV_EVENT_IDS.generate} district=N. Nothing was written.`);
    say(player, lines);
}

// ---------------------------------------------------------------------------------------------
// status / abort / devgate

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handleStatus(kingdomStore, event) {
    const loaded = kingdomStore.load();
    const districts = /** @type {any[]} */ (loaded.kingdom?.districts ?? []);
    if (!loaded.kingdom || districts.length === 0) {
        reply(formatErrorLines("Civilization status", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }
    const master = loadMasterPlan();
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
    const started = districts.filter((district) => district.civ !== undefined);
    if (started.length === 0) {
        if (running !== undefined) {
            lines.push(`Nothing is stored yet: a ${running.kind} session is running (see above).`);
        } else if (finished !== undefined) {
            lines.push(`Nothing is stored: the last run did not produce a civilization (see above). /scriptevent ${CIV_EVENT_IDS.plan} (read-only) or ${CIV_EVENT_IDS.generate} to try again.`);
        } else {
            lines.push(`Not generated. /scriptevent ${CIV_EVENT_IDS.plan} (read-only) or ${CIV_EVENT_IDS.generate} in a NEW Creative world.`);
        }
    }
    const live = sessionStatus();
    lines.push(`Districts (${String(DISTRICT_INDEXES.length)}, built one at a time in this order; master plan ${master.plan !== undefined && master.plan !== null ? `stored at ${String(master.anchor?.x)}, ${String(master.anchor?.z)}` : `not stored (${String(master.status)})`}):`);
    for (const index of DISTRICT_INDEXES) {
        const district = districtById(loaded.kingdom, districtIdFor(index));
        const civ = district?.civ;
        const label = `  ${districtIdFor(index)} ${String(district?.name ?? DISTRICT_NAMES[index - 1])}`;
        if (civ === undefined) {
            const need = index > 1 && districtById(loaded.kingdom, districtIdFor(index - 1))?.civ?.status !== "complete" ? ` - build ${districtIdFor(index - 1)} first` : "";
            lines.push(`${label}: not started${need}.`);
            continue;
        }
        const runningHere = live !== undefined && live.district === index;
        const stored = runningHere ? undefined : storedQueueStatus(index, { recoverRunning: false });
        const ops = runningHere ? `${String(live.done)} / ${String(live.total)}` : stored?.total !== undefined ? `${String(stored.done)} / ${String(stored.total)}` : `${String(civ.ops)} / ${String(civ.opsTotal)}`;
        lines.push(`${label}: ${String(civ.status)}, stage ${String(civ.stage)} ${ops} ops, placed ${String(civ.placed ?? 0)}, skipped ${String(civ.skipped ?? 0)}, centre ${String(civ.centre?.x)}, ${String(civ.centre?.z)}, plan ${String(civ.checksum)}.`);
        if (runningHere) {
            lines.push(`    Running (${String(live.status)}): ${String(live.stage)} ${String(live.pct)}%; placed ${String(live.counts.placed)}, skipped ${String(live.counts.skipped)}, failed ${String(live.counts.failed)}.`);
        } else if (stored !== undefined && stored.status !== "ok") {
            lines.push(`    Stored queue: ${String(stored.status)}${stored.reason ? ` (${String(stored.reason)})` : ""}.`);
        } else if (stored !== undefined) {
            lines.push(`    Stored queue: ${String(stored.pct)}% (${String(stored.done)} / ${String(stored.total)} ops), state ${String(stored.state)}${civ.status !== "complete" ? `; continue with /scriptevent ${CIV_EVENT_IDS.resume} district=${String(index)}` : ""}.`);
        }
    }
    const footprint = storageFootprint();
    lines.push(`Storage: ${footprint.families.filter((family) => family.bytes > 0).map((family) => `${family.prefix} ${String(family.bytes)} B`).join(", ") || "nothing stored"}; total ${String(footprint.totalBytes)} B${footprint.problems.length > 0 ? ` - OVER BUDGET: ${footprint.problems.join(" | ")}` : " (every family inside its budget)"}.`);
    lines.push(isBusy() ? `Job slot: ${String(activeKind())}${running !== undefined ? " (" + describeRunning(running) + ")" : ""}` : "No job running.", `Dev gate: ${devGateOn() ? "on" : "off"} (districts 2-${String(DISTRICT_INDEXES.length)} only start with it on).`);
    reply(lines, event);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleAbort(kingdomStore, args, event) {
    void kingdomStore;
    const options = parseCivArgs(args);
    if (options.error !== undefined) {
        reply(formatErrorLines("Abort refused", [options.error, `Usage: /scriptevent ${CIV_EVENT_IDS.abort} [district=1-${String(DISTRICT_INDEXES.length)}]`]), event);
        return;
    }
    if (!isBusy()) {
        const swept = /** @type {string[]} */ ([]);
        sweepAbandonedHolds((lines) => swept.push(...lines));
        reply(["No civilization job is running.", ...swept], event);
        return;
    }
    const live = sessionStatus();
    if (options.district !== undefined && options.district !== "all" && live !== undefined && live.district !== options.district) {
        reply(formatErrorLines("Abort refused", [`district=${String(options.district)} is not the build that is running (that is ${districtIdFor(live.district)}).`, `Stop it with /scriptevent ${CIV_EVENT_IDS.abort} district=${String(live.district)}, or leave it running.`]), event);
        return;
    }
    const result = abortCivJob();
    if (result === undefined) {
        reply([`A ${String(activeKind())} job (not a civilization job) is running; civ:generate_abort only stops civilization jobs. Use /scriptevent civ:district_abort for that one.`], event);
        return;
    }
    reply(civAbortLines(result, live !== undefined ? `${CIV_EVENT_IDS.resume} district=${String(live.district)}` : CIV_EVENT_IDS.resume), event);
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
    // save-size discipline: what every key family this pack writes actually holds, against its budget and the 32,767-char property ceiling
    const footprint = storageFootprint();
    lines.push(`Stored bytes by key family (budget, keys, longest property in chars):`);
    for (const family of footprint.families) {
        lines.push(`  ${family.prefix}: ${String(family.bytes)} / ${String(family.limit)} B in ${String(family.keys)} key(s), longest ${String(family.longestProperty)} chars${family.overBudget ? " - OVER BUDGET" : ""}${family.longestProperty > 32767 ? " - OVER the 32767 char property ceiling" : ""}.`);
    }
    lines.push(`  total ${String(footprint.totalBytes)} B${footprint.problems.length === 0 ? ", nothing over budget" : `, ${String(footprint.problems.length)} family(ies) over budget`}.`);
    const master = loadMasterPlan();
    lines.push(`Master plan: ${master.plan !== undefined && master.plan !== null ? `stored at ${String(master.anchor?.x)}, ${String(master.anchor?.z)} (v${String(master.payload?.version)}, ${String(master.payload?.plan?.districts?.length ?? "?")} districts)` : `not stored (${String(master.status)}${master.reason ? `: ${String(master.reason)}` : ""})`}.`);
    reply(lines, event);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleDevgate(kingdomStore, args, event) {
    const value = args[0]?.toLowerCase();
    if (value === "on" || value === "off") {
        world.setDynamicProperty(CIV.devGateKey, value === "on");
        if (value === "on") {
            enableCivGeneration(kingdomStore);
        } else {
            generationOn = false;
        }
        reply([
            `Development gate ${value}: districts 2-${String(DISTRICT_INDEXES.length)} ${value === "on" ? "may be generated in this world, one at a time and only after their lower-numbered neighbours are complete" : "cannot be generated in this world any more (district 1 is unaffected)"}.`,
            `One command per district: /scriptevent ${CIV_EVENT_IDS.generate} district=2. Arming a starter world wipes the gate.`,
            ...CIV_SAFETY_WARNING,
        ], event);
        return;
    }
    reply([`Development gate is ${devGateOn() ? "on" : "off"}. Usage: /scriptevent ${CIV_EVENT_IDS.devgate} on|off`, ...CIV_SAFETY_WARNING], event);
}
