import { BlockPermutation, system, world } from "@minecraft/server";
import { CIV, CIV_EVENT_IDS, DISTRICT_NAMES, PHYSICAL, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { markYield, newOps } from "../civ/regions.js";
import { LAMP_RETROFIT } from "../civ/lamps.js";
import { auditRecord, shortfallOf } from "../civ/facilities.js";
import { compileSharedTreeProtectionSteps } from "../civ/sharedtree.js";
import {roomVegetationPreviewSteps,formatRoomVegetationPreview} from "../civ/roomVegetationPreview.js";
import { formatWallLeafPreview, previewWallLeavesSteps } from "../civ/wallleafpreview.js";
import { POLICY as LEAF_TRIM_POLICY, LEAF_TRIM_MASONRY_IDS } from "../civ/wallLeafTrim.js";
import { createWallLeafSourceGuard, wallLeafRepairSteps, createWallLeafBlockAdapter } from "../civ/wallLeafRepair.js";
import {prepareLeafSourceBatchSteps} from "../civ/leafSourceStreaming.js";
import { retainedRoofColumnsSteps, roofFixtureAlternates } from "../civ/roofcolumns.js";
import { buildingInteriorLightRevisionSteps, buildingRoofRevisionSteps, rehydrateSiteSteps, schoolRoofRevisionSteps, siteOptionsOf, siteOpsFor } from "../civ/districtplan.js";
import { isDoorOp, inspectDoorPair, placeDoorPair } from "../integration/doorPlacement.js";
import { inProtectedArea, isSharedWallFill, inspectNaturalTree, auditCityWalls, prepareCityRepair, startCityRepair } from "../integration/civBuilder.js";
import { createChunkLoader } from "../integration/chunkLeases.js";
import { siteGroundRegion } from "../civ/siteprofile.js";
import { abortCivJob, civAbortLines, civilizationOverview, describePlan, discardRun, districtIdFor, loadMasterPlan, loadSavedRunSteps, persistRun, planWorld, recoverConstructionHolds, sessionStatus, startConstruction, storedQueueStatus, storageFootprint, PROTECT_MARGIN, WRITE_PROTECT_GROW, DISTRICT_INDEXES } from "../integration/civBuilder.js";
import { registerBuiltGates } from "../integration/civGates.js";
import { abortLampRetrofit, activeLampIndex, readLampState, startLampRetrofit } from "../integration/lampRetrofit.js";
import { abortLightingRevision, lightingRevisionStatus, recoverLightingRevision, startLightingRevision } from "../integration/lightingRevision.js";
import { abortFarmLightingRevision, farmLightingRevisionStatus, formatFarmLightingStatus, recoverFarmLightingRevision, startFarmLightingRevision } from "../integration/farmLightingRevision.js";
import { describeProgress, describeRunning, finishProgress, formatTicks, getLastRun, getProgress, nowTick, setPhase, startMonitor, startProgress } from "../integration/civProgress.js";
import { CIV_TICKING_ID, recoverSurveyHolds, releaseArea, runJobAsync, tileSizeNow } from "../integration/civScan.js";
import { activeKind, activeToken, finishJob, isBusy, releaseChunks, reserveJob } from "../integration/districtBuilder.js";
import { readColumn } from "../integration/terrainScan.js";
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
const doorChunks=createChunkLoader(undefined,undefined,{prefix:"civ-door-load-",maxGroups:1,maxChunks:1,maxUnits:1,padding:0,timeoutTicks:200});
const schoolChunks=createChunkLoader(undefined,undefined,{prefix:"civ-school-roof-",maxGroups:1,maxChunks:16,maxUnits:1,padding:0,timeoutTicks:200});

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
 * The ids the generation listener answers. `civ:people` is deliberately absent: it belongs to commands/people.js,
 * and a gate-off answer must never speak for a command this module does not own.
 * @type {string[]}
 */
const GENERATION_EVENT_IDS = [
    CIV_EVENT_IDS.generate,
    CIV_EVENT_IDS.plan,
    CIV_EVENT_IDS.status,
    CIV_EVENT_IDS.abort,
    CIV_EVENT_IDS.resume,
    CIV_EVENT_IDS.diag,
    CIV_EVENT_IDS.doors,
    CIV_EVENT_IDS.schoolRoof,
    CIV_EVENT_IDS.roofSupport,
    CIV_EVENT_IDS.interiorLights,
    CIV_EVENT_IDS.farmLights,
    CIV_EVENT_IDS.farmLightsStatus,
    CIV_EVENT_IDS.farmLightsAbort,
];

/**
 * Lighting the districts that are already built. These are NOT generation commands and are deliberately NOT
 * behind the development gate: the gate exists to stop a released world from GENERATING a district, while the
 * retrofit only adds lanterns to districts a world already holds (and a shipped world has the gate off).
 * @type {string[]}
 */
const LAMP_EVENT_IDS = [CIV_EVENT_IDS.lights, CIV_EVENT_IDS.lightsNatural, CIV_EVENT_IDS.lightsStatus, CIV_EVENT_IDS.lightsAbort];

/**
 * Registers the one script-event listener for this module: the development gate switch and the generation commands.
 * It is subscribed once, for the whole session: the development gate decides whether a command runs its work or
 * gets ONE refusal line saying why - it never decides whether the id is heard at all. Subscribing the generation
 * commands only while the gate was on made a shipped world (the gate is off, and arming a starter world wipes it)
 * answer nothing to `/scriptevent civ:generate_plan` and `/scriptevent civ:generate_status`: the engine echoed
 * "has been sent" and no pack line ever followed, which reads exactly like a dead script VM.
 * @param {KingdomStore} kingdomStore
 */
export function registerCivCommands(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;
    system.run(() => sweepAbandonedHolds(() => {}));
    system.run(() => recoverLightingRevision());
    system.run(() => recoverFarmLightingRevision());
    system.run(() => recoverSurveyHolds());
    system.run(() => doorChunks.recover());
    system.run(() => schoolChunks.recover());
    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (event.id === CIV_EVENT_IDS.devgate) {
            handleDevgate(parseArgs(event.message), event);
            return;
        }
        dispatchGeneration(kingdomStore, event);
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}

/**
 * Routes one script event to its generation handler, or refuses it loudly while the development gate is off.
 * The gate is read live from the world property, so switching it never leaves a stale listener behind.
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function dispatchGeneration(kingdomStore, event) {
    const id = event.id;
    if (LAMP_EVENT_IDS.includes(id)) {
        // Before the generation gate: a released world (gate off) still gets its built districts lit.
        if (id === CIV_EVENT_IDS.lights || id === CIV_EVENT_IDS.lightsNatural) {
            handleNaturalLights(kingdomStore, parseCivArgs(parseArgs(event.message)), event);
        } else if (id === CIV_EVENT_IDS.lightsStatus) {
            handleLampStatus(event);
        } else {
            handleLampAbort(event);
        }
        return;
    }
    if (!GENERATION_EVENT_IDS.includes(id)) {
        return;
    }
    if (!devGateOn()) {
        reply(formatErrorLines("Generation commands are off", [
            `the development gate is off in this world, so ${id} does nothing (a released world ships with the gate off, and arming a starter world wipes it).`,
            `Turn it on with /scriptevent ${CIV_EVENT_IDS.devgate} on, then run the command again.`,
        ]), event);
        return;
    }
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
        handleDiag(kingdomStore, event);
    } else if (id === CIV_EVENT_IDS.doors) {
        void handleDoors(kingdomStore,event);
    } else if (id === CIV_EVENT_IDS.schoolRoof) {
        void handleSchoolRoof(kingdomStore,event);
    } else if (id === CIV_EVENT_IDS.roofSupport) {
        void handleSchoolRoof(kingdomStore,event,true);
    } else if (id === CIV_EVENT_IDS.interiorLights) {
        void handleInteriorLights(kingdomStore,event);
    } else if (id === CIV_EVENT_IDS.farmLights) {
        void handleFarmLights(kingdomStore,event);
    } else if (id === CIV_EVENT_IDS.farmLightsStatus) {
        const match=/^district=([1-5])$/.exec(String(event.message??"").trim());
        reply(match ? formatFarmLightingStatus(farmLightingRevisionStatus(Number(match[1]))) : ["Usage: civ:farm_lights_status district=N."],event);
    } else if (id === CIV_EVENT_IDS.farmLightsAbort) {
        reply([abortFarmLightingRevision() ? "Farm lighting stopped; its recovery journal is retained." : "No farm-lighting job is running."],event);
    }
}

/** Explicit fixture maintenance on a verified, completed authoring district.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event */
async function handleFarmLights(kingdomStore,event) {
    const match=/^district=([1-5])(?: farm=([a-z0-9_-]+))?(?: (confirm))?$/.exec(String(event.message??"").trim());
    if(!match){reply(["Usage: civ:farm_lights district=N [farm=ID] [confirm]. Without confirm this only inspects."],event);return;}
    const index=Number(match[1]),loaded=kingdomStore.load();
    const civ=loaded.kingdom&&districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if(civ?.status!=="complete"){reply(["Farm lighting needs a completed district and its saved plan. Nothing changed."],event);return;}
    const dimension=playerOf(event)?.dimension??world.getDimension("overworld");
    if(civ.dimension!==dimension.id){reply(["Farm lighting needs the saved district's dimension. Nothing changed."],event);return;}
    try {
        const protection=()=>{
            const current=kingdomStore.load(),master=loadMasterPlan();
            if(!current.kingdom||master.status!=="ok"||!master.plan)throw new Error("current kingdom or master-plan protection cannot be verified");
            return protectedRects(current.kingdom,1,master.plan,WRITE_PROTECT_GROW,index);
        };
        const result=startFarmLightingRevision({index,civ,dimension,protectedRects:protection(),getProtection:protection,
            confirm:!!match[3],onlyFarm:match[2],say:(/** @type {string[]} */ lines)=>reply(lines,event)});
        if(!result.ok){reply([`Farm lighting refused: ${String(result.reason)}.`],event);return;}
        if(result.completion)reply(formatFarmLightingStatus(await result.completion),event);
    }catch(error){reply(formatErrorLines("Farm lighting stopped",[String(error)]),event);}
}

// ---------------------------------------------------------------------------------------------
// civ:lights / civ:lights_status / civ:lights_abort - additive lighting for built districts

/** @param {KingdomStore} kingdomStore @param {ReturnType<typeof parseCivArgs>} options @param {ScriptEvent} event */
function handleNaturalLights(kingdomStore, options, event) {
    if (options.error) { reply([options.error], event); return; }
    const player = playerOf(event);
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) { reply(["No saved kingdom can be read. Nothing changed."], event); return; }
    const indices = options.district === "all" ? DISTRICT_INDEXES.slice() : [options.district ?? 1];
    const step = () => {
        const index = indices.shift();
        if (index === undefined) return;
        const district = districtById(loaded.kingdom, districtIdFor(index));
        if (district?.civ?.status !== "complete") { reply([`${districtTitle(index)} is unfinished; its lights were left alone.`], event); step(); return; }
        const result = startLightingRevision({ index, civ: district.civ, dimension: player?.dimension ?? world.getDimension("overworld"),
            say: (lines) => reply(lines, event), onEnd: (complete) => { if (complete) step(); } });
        if (!result.ok) reply([`Lighting was not started: ${String(result.reason)}.`], event);
    };
    step();
}

/**
 * Light one or more built districts. No argument means every district the kingdom records as complete.
 * @param {KingdomStore} kingdomStore
 * @param {{ district?: number | "all", error?: string }} options
 * @param {ScriptEvent} event
 */
function handleLights(kingdomStore, options, event) {
    const player = playerOf(event);
    /** @param {string[]} lines */
    const sayHere = (lines) => {
        if (player === undefined) {
            reply(lines, event);
        } else {
            say(player, lines);
        }
    };
    if (options.error !== undefined) {
        sayHere(formatErrorLines("Lighting was not started", [options.error, `Usage: /scriptevent ${CIV_EVENT_IDS.lights} [district=1-${String(DISTRICT_INDEXES.length)}]`]));
        return;
    }
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        sayHere(formatErrorLines("Lighting was not started", [`No readable kingdom in this world: ${String(loaded.reason)}`]));
        return;
    }
    const requested = options.district === undefined || options.district === "all" ? DISTRICT_INDEXES.slice() : [options.district];
    /** @type {number[]} */
    const runnable = [];
    /** @type {string[]} */
    const notes = [];
    for (const index of requested) {
        const district = districtById(loaded.kingdom, districtIdFor(index));
        const status = district?.civ?.status;
        if (status !== "complete") {
            notes.push(`${districtTitle(index)}: not built (${String(status ?? "no build record")}) - skipped`);
            continue;
        }
        runnable.push(index);
    }
    if (runnable.length === 0) {
        sayHere(formatErrorLines("Nothing to light", [...notes, "Nothing was changed."]));
        return;
    }
    const dimension = player?.dimension ?? world.getDimension("overworld");
    sayHere([...notes, `=== Lighting ${runnable.map((index) => districtTitle(index)).join(", ")} ===`, `Grid ${String(LAMP_RETROFIT.spacing)} (relocate ${String(LAMP_RETROFIT.relocate)}); one district at a time, progress in chat. Nothing that already stands is replaced.`]);
    const queue = runnable.slice();
    const step = () => {
        const index = queue.shift();
        if (index === undefined) {
            return;
        }
        const started = startLampRetrofit({
            index,
            dimension,
            say: sayHere,
            onEnd: (state) => {
                // A paused/failed district stops the chain: the next command resumes from its saved cursor.
                if (state.state === "done") {
                    step();
                }
            },
        });
        if (!started.ok) {
            sayHere(formatErrorLines(`Could not light ${districtTitle(index)}`, [String(started.reason), "Nothing was changed."]));
            queue.length = 0;
        }
    };
    step();
}

/** @param {ScriptEvent} event */
function handleLampStatus(event) {
    const running = activeLampIndex();
    const lines = ["=== District lighting ==="];
    for (const index of DISTRICT_INDEXES) {
        const revised = lightingRevisionStatus(index);
        if (revised !== undefined) {
            lines.push(`${districtTitle(index)}: natural lighting ${String(revised.state)} - ${String(revised.cursor)}${revised.total === undefined ? "" : `/${String(revised.total)}`} fixtures${revised.phase ? `, ${String(revised.phase)}` : ""}.`);
            continue;
        }
        const state = readLampState(index);
        if (state === undefined) {
            lines.push(`${districtTitle(index)}: never run`);
            continue;
        }
        const now = running === index ? " (running now)" : "";
        const reason = state.reason === undefined ? "" : `; ${String(state.reason)}`;
        lines.push(`${districtTitle(index)}: ${String(state.state)}${now} - tiles ${String(state.done)}/${String(state.tiles)}, placed ${String(state.placed)} (${String(state.walls ?? 0)} on walls, ${String(state.fills ?? 0)} on raised surfaces), already lit ${String(state.already)}, skipped ${String(state.skipped)}, unloaded ${String(state.unloaded)}${reason}`);
    }
    lines.push(`/scriptevent ${CIV_EVENT_IDS.lights} [district=N] runs or resumes; ${CIV_EVENT_IDS.lightsAbort} stops the run.`);
    reply(lines, event);
}

/** @param {ScriptEvent} event */
function handleLampAbort(event) {
    if (abortLightingRevision()) { reply(["Lighting revision stopped. Its saved progress is retained."], event); return; }
    const result = abortLampRetrofit();
    if (!result.ok || result.state === undefined) {
        reply(formatErrorLines("No lamp run is active", [String(result.reason ?? "nothing to stop")]), event);
        return;
    }
    const state = result.state;
    reply([
        "Lamp run stopped.",
        `Placed ${String(state.placed)} lantern(s); the cursor is saved at tile ${String(state.done)} of ${String(state.tiles)}.`,
        `Continue with /scriptevent ${CIV_EVENT_IDS.lights} district=${String(state.index ?? "")}.`,
    ], event);
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
            rects.push({ x0: x0 - grow, z0: z0 - grow, x1: x1 + grow, z1: z1 + grow, polygon, grow, districtIndex:index, label: `${String(district.id)} ${String(entry.name ?? "")} (${String(status)})` });
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
            player.sendMessage(lines.join("\n"));
            return;
        }
    } catch (_error) {
        // fall through to a broadcast
    }
    world.sendMessage(lines.join("\n"));
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
        recoverConstructionHolds();
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
        const previousBuilds = loaded.kingdom.districts.filter((/** @type {any} */ district) => district.civ?.status === "complete")
            .map((/** @type {any} */ district) => ({ index: Number(district.id.replace(/^district-/, "")), checksum: district.civ.checksum, startedStep: district.civ.startedStep }));
        outcome = await planWorld({ token, dimension, anchor, radius: options.radius, seed, exclusions, plannerFootprints, previousBuilds, say: sayHere, progress: prog, district: index, siteMode: options.site === "here" ? "here" : undefined });
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
    reply(civAbortLines(result, live?.repair === "city" ? `${CIV_EVENT_IDS.diag} repair district=${live.district} confirm`
        : live !== undefined ? `${CIV_EVENT_IDS.resume} district=${String(live.district)}` : CIV_EVENT_IDS.resume), event);
}

/** Readonly complete chapel room snapshot. No lease, native writes or property writes.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event @param {number} index @param {string} building @param {number} page */
async function inspectSavedRoom(kingdomStore,event,index,building,page){
 const player=playerOf(event),loaded=kingdomStore.load(),civ=loaded.kingdom&&districtById(loaded.kingdom,districtIdFor(index))?.civ;
 if(!player||player.dimension.id!=="minecraft:overworld"||civ?.status!=="complete"||civ.dimension!==player.dimension.id||!building.startsWith(`building-d${index}-`)){reply(["Room census requires a completed matching Overworld chapel and player. Nothing changed."],event);return;}
 const selectedStamp=JSON.stringify(civ),identity=player.id,dimension=player.dimension,dimensionId=dimension.id;
 if(dimensionId!=="minecraft:overworld"||dimensionId!==civ.dimension||typeof identity!=="string"){reply(["Room player/source identity is unreadable. Nothing changed."],event);return;}
 const token=reserveJob("civ-room-preview");if(!token){reply([runningPhrase()],event);return;}
 try{
  /** @type {any} */let latestKingdom;
  const guard=createWallLeafSourceGuard(world,()=>{latestKingdom=kingdomStore.load().kingdom;return latestKingdom;});
  const selectedCurrent=()=>{const districts=latestKingdom?.districts?.filter((/** @type {any} */d)=>d.id===districtIdFor(index));return districts?.length===1&&JSON.stringify(districts[0].civ)===selectedStamp;};
  const fastCurrent=()=>!token.cancelled&&activeToken()===token&&devGateOn()&&player.isValid&&player.id===identity&&player.dimension.id===dimensionId&&!token.cancelled&&activeToken()===token;
  const current=()=>{try{return fastCurrent()&&guard.current()&&selectedCurrent()&&fastCurrent()&&guard.current()&&selectedCurrent()&&fastCurrent();}catch(_error){return false;}};
  /** @template T @param {Generator<any,T,any>} generator @returns {Generator<any,T,any>} */
  function* checked(generator){for(;;){if(!current())throw Error("Room census source/player/cancellation guard refused");const n=generator.next();if(!current())throw Error("Room census source changed during verification");if(n.done)return n.value;yield;}}
  reply(["Verifying the completed saved chapel source for a read-only room census; player-loaded cells only, no holds or changes."],event);
  const saved=await runJobAsync(token,checked(loadSavedRunSteps(civ,newOps(),index)));if(token.cancelled||!saved)return;
  if(!saved.ok||saved.queue.state!=="complete"){reply(formatErrorLines("Room census refused",saved.ok?["Original queue is not complete"]:saved.reasons),event);return;}
  if(!current()||saved.record.checksum!==civ.checksum)throw Error("Room source identity changed");
  const result=await runJobAsync(token,roomVegetationPreviewSteps(saved.record,building,{current,cancelled:()=>token.cancelled,getBlock:p=>dimension.getBlock(p)}));
  if(!result||token.cancelled)return;if(!current())throw Error("Room source changed after census");
  const lines=formatRoomVegetationPreview(result,page);if(!current())throw Error("Room source changed before reporting");reply(lines,event);
 }catch(error){if(!token.cancelled)reply(formatErrorLines("Room census refused",[String(error),"Nothing changed; no cleanup permission inferred."]),event);}
 finally{finishJob(token);}
}

/**
 * Cheap diagnostics for real-game problems: the engine's chunk limits, whether a tile would fit, what we own.
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handleDiag(kingdomStore, event) {
    if (event.message.trim().length > 0) {
        const room=/^roompreview district=([1-5]) building=(building-d[1-5]-chapel-[1-9]\d{0,2})(?: page=([1-9]\d{0,2}))?$/.exec(event.message.trim());
        if(room){void inspectSavedRoom(kingdomStore,event,Number(room[1]),room[2],Number(room[3]??1));return;}
        const leafRepair=/^leafrepair district=([1-5]) policy=wall-leaves-trim-v1(?: (confirm))?$/.exec(event.message.trim());
        if(leafRepair){void repairSavedWallLeaves(kingdomStore,event,Number(leafRepair[1]),!!leafRepair[2]);return;}
        const leaves=/^leafpreview district=([1-5])(?: page=([1-9]\d{0,2}))?$/.exec(event.message.trim());
        if(leaves){void inspectSavedWallLeaves(kingdomStore,event,Number(leaves[1]),Number(leaves[2]??1));return;}
        const walls = /^walls district=([1-5])$/.exec(event.message.trim());
        if (walls) {
            void inspectSavedWalls(kingdomStore,event,Number(walls[1]));
            return;
        }
        const repair = /^repair district=([1-5])(?: (confirm))?$/.exec(event.message.trim());
        if (repair) {
            void repairSavedCity(kingdomStore, event, Number(repair[1]), repair[2] !== undefined);
            return;
        }
        const tree = /^tree district=([1-5]) x=(-?\d+) y=(-?\d+) z=(-?\d+)$/.exec(event.message.trim());
        if (tree) {
            void inspectSavedTree(kingdomStore, event, Number(tree[1]), { x:Number(tree[2]), y:Number(tree[3]), z:Number(tree[4]) });
            return;
        }
        const match = /^lots district=([1-5])(?: preview=balanced)?$/.exec(event.message.trim());
        if (!match) {
            reply([`Usage: /scriptevent ${CIV_EVENT_IDS.diag} [roompreview district=N building=ID [page=P] | walls district=N | leafpreview district=N [page=P] | leafrepair district=N policy=wall-leaves-trim-v1 [confirm] | lots district=N [preview=balanced] | tree district=N x=X y=Y z=Z | repair district=N [confirm]]`], event);
            return;
        }
        void inspectSavedLots(kingdomStore, Number(match[1]), event, event.message.includes("preview=balanced"));
        return;
    }
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
    const player = event.sourceEntity;
    if (player?.typeId === "minecraft:player") {
        try {
            const x = Math.floor(player.location.x), z = Math.floor(player.location.z);
            const top = player.dimension.getTopmostBlock({ x, z });
            lines.push(`Terrain probe (${x},${z}): engine top ${String(top?.typeId)} at ${String(top?.location.y)}.`);
            lines.push(`Column reader: ${JSON.stringify(readColumn(player.dimension, x, z, { bed: true }))}.`);
            if (top) for (const y of [...new Set([top.location.y + 1, top.location.y + 2, top.location.y + 4, 62, 63])]) {
                let id;
                try { id = player.dimension.getBlock({ x, y, z })?.typeId; } catch (_error) { id = undefined; }
                lines.push(`  block y=${y}: ${String(id ?? "unreadable")}`);
            }
        } catch (error) { lines.push(`Terrain probe unavailable: ${String(error)}`); }
    }
    reply(lines, event);
}

/** Read-only exact final-wall mismatch audit of a completed district.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event @param {number} index */
async function inspectSavedWalls(kingdomStore,event,index) {
    const player=playerOf(event), loaded=kingdomStore.load();
    const civ=loaded.kingdom && districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if(!player||civ?.status!=="complete"||(civ.dimension!==undefined&&civ.dimension!==player.dimension.id)) {
        reply(["Wall audit needs a completed district in your current dimension. Nothing changed."],event);return;
    }
    const token=reserveJob("civ-wall-audit");
    if(!token) { reply([runningPhrase()],event);return; }
    reply([`Verifying ${districtTitle(index)}'s original plan before a read-only wall audit...`],event);
    try {
        const saved=await runJobAsync(token,loadSavedRunSteps(civ,newOps(),index));
        if(token.cancelled||!saved)return;
        if(!saved.ok) { reply(formatErrorLines("Wall audit refused",saved.reasons),event);return; }
        const result=await auditCityWalls({token,dimension:player.dimension,plan:saved.plan,record:saved.record,
            region:saved.region,district:index,protectedRects:protectedRects(loaded.kingdom,1,saved.plan,WRITE_PROTECT_GROW,index)});
        if(token.cancelled)return;
        reply([`=== ${districtTitle(index)} wall audit: ${result.complete ? "complete" : "incomplete"} ===`,
            `${result.total} unique final wall targets; ${result.surveyed} surveyed.`,
            Object.entries(result.counts).map(([key,n])=>`${key} ${n}`).join(", "),
            ...["tree","missing","other","unloaded"].flatMap(category=>(result.samples[category]??[]).map(row=>`${category}: ${row}`)),
            "Read-only block-id audit: no blocks, saved plans or construction progress changed. Protected targets were not read. Temporary chunk holds were released.",
            "Block states, walking clearance and foundation support require separate checks."],event);
    } catch(error) { reply(formatErrorLines("Wall audit failed",[String(error)]),event); }
    finally { finishJob(token); }
}

/** Explicit completed-wall leaf-only policy. No old repair permission is reused.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event @param {number} index @param {boolean} confirm */
async function repairSavedWallLeaves(kingdomStore,event,index,confirm){
    const player=playerOf(event),loaded=kingdomStore.load(),civ=loaded.kingdom&&districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if(!player||player.dimension.id!=="minecraft:overworld"||civ?.status!=="complete"||civ.dimension!==player.dimension.id){reply(["Leaf-only wall repair needs a completed Overworld source and an Overworld player. Nothing changed."],event);return;}
    const token=reserveJob("civ-wall-leaf-repair");if(!token){reply([runningPhrase()],event);return;}
    try{
        const cancelled=()=>token.cancelled||activeToken()!==token||player.isValid===false||player.dimension.id!=="minecraft:overworld";
        const guard=createWallLeafSourceGuard(world,()=>kingdomStore.load().kingdom,cancelled);
        /** @param {Generator<void,any,void>} generator @returns {Generator<void,any,void>} */
        function* checked(generator){for(;;){guard.assert();const step=generator.next();guard.assert();if(step.done)return step.value;yield;}}
        const sources=[];
        const districts=/** @type {any[]} */(loaded.kingdom.districts).filter(d=>d.civ!==undefined);
        if(districts.length<1||districts.length>5)throw new Error("Unsupported source set; every existing civilization must be verified.");
        for(const n of DISTRICT_INDEXES){
            const metaKey=n===1?"civ:jobs:meta":`civ:jobs:d${n}:meta`;
            if(world.getDynamicProperty(metaKey)!==undefined&&!districts.some(d=>d.id===districtIdFor(n)))throw new Error("An original saved queue has no completed kingdom source; preserve it.");
        }
        for(const district of districts){
            const n=Number(String(district.id).replace(/^district-/,""));
            if(!DISTRICT_INDEXES.includes(n)||district.id!==districtIdFor(n)||district.civ?.status!=="complete"||district.civ.dimension!==player.dimension.id)throw new Error("All existing neighboring city sources must be completed in this dimension.");
            sources.push({record:{districtIndex:n,checksum:district.civ.checksum},civ:district.civ});
        }
        guard.assert();if(!sources.some(s=>s.record.districtIndex===index))throw new Error("Selected verified source is absent.");
        const meta=JSON.parse(String(world.getDynamicProperty("civ:plan:meta")));
        if(!/^[a-f0-9]{8}$/.test(String(meta.hash)))throw new Error("Verified master envelope hash is absent.");
        /** @type {ReturnType<typeof protectedRects>|undefined} */let areas;
        const permutations=new Map(LEAF_TRIM_MASONRY_IDS.map(id=>[id,BlockPermutation.resolve(id)]));
        const native=createWallLeafBlockAdapter(player.dimension,permutations);
        const input={candidates:[],index,checksum:civ.checksum,masterHash:meta.hash,dimension:player.dimension.id,sources:sources.map(s=>({...s,masterHash:meta.hash}))};
        const context={...native,isProtected:(/** @type {number} */x,/** @type {number} */z)=>{if(areas===undefined)throw new Error("Verified source protection is not initialized.");return inProtectedArea(areas,x,z);},sourcesCurrent:()=>guard.current(),cancelled};
        /** @param {{input:import("../civ/wallLeafTrim.js").LeafInput,context:import("../civ/wallLeafTrim.js").LeafContext,receiptStore?:import("../civ/wallLeafTrim.js").LeafStore}} options */
        const streamSourcesSteps=({input:batchInput,context:batchContext,receiptStore})=>prepareLeafSourceBatchSteps({index:batchInput.index,checksum:batchInput.checksum,masterHash:batchInput.masterHash,dimension:batchInput.dimension,policy:LEAF_TRIM_POLICY,sources:batchInput.sources.map(s=>({index:s.record.districtIndex,checksum:s.record.checksum,status:s.civ.status,dimension:s.civ.dimension}))},{
            sourcesCurrent:batchContext.sourcesCurrent,journalsCurrent:batchContext.sourcesCurrent,cancelled,receiptStore,read:native.read,isProtected:batchContext.isProtected,
            onVerifiedMaster:(/** @type {any} */plan)=>{if(areas===undefined)areas=protectedRects(kingdomStore.load().kingdom,1,plan,WRITE_PROTECT_GROW,index);},
            loadSourceSteps:(/** @type {number} */n,/** @type {any} */civ)=>{reply([`Verifying ${districtTitle(n)}'s original source for leaf-only wall repair (read-only)...`],event);return loadSavedRunSteps(civ,newOps(),n);},
        });
        const result=await runJobAsync(token,wallLeafRepairSteps(input,context,world,{confirm,policy:LEAF_TRIM_POLICY,readTick:()=>system.currentTick,streamSourcesSteps}));
        if(!result)return;
        reply([`Leaf-only wall batch: ${result.state}; verified replacements ${result.verifiedChanges}, write attempts ${result.writeAttempts}.`,
            `Admitted/inspected batch targets ${result.rows.length}; batch receipt key ${result.journalKey??"none"}. Source city completion and ordinary queues are unchanged.`,
            ...(result.globalSurvey?[`Loaded survey only: ${result.globalSurvey.surveyed}/${result.globalSurvey.targets}; unreadable walls ${result.globalSurvey.unloaded}; refused observed tree targets ${result.globalSurvey.refused}. This is not a complete wall audit.`]:[]),
            ...result.rows.slice(0,24).map((/** @type {any} */r)=>`${r.target.x},${r.target.y},${r.target.z}: ${r.state}${r.reason?" - "+r.reason:""}`),
            ...(result.rows.length>24?[`Showing24/${result.rows.length} batch rows; use read-only leafpreview pages for the observed candidate list.`]:[]),
            confirm?"Only exact proven leaf-to-wall replacements were attempted; refused/unreadable cells and unknown receipts remain untouched.":"Read-only preview: no block, property or chunk-hold changes. Append confirm to recheck and repair a fresh safe batch."] ,event);
    }catch(error){if(!token.cancelled)reply(formatErrorLines("Leaf-only wall repair held",[String(error)]),event);}
    finally{finishJob(token);}
}

/** Read every loaded final-wall target and classify the complete bounded tree list.
 * No chunk lease is acquired/recovered/retargeted and no property/block is written.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event @param {number} index @param {number} page */
async function inspectSavedWallLeaves(kingdomStore,event,index,page) {
    const player=playerOf(event),loaded=kingdomStore.load();
    const civ=loaded.kingdom&&districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if(!player||player.dimension.id!=="minecraft:overworld"||civ?.status!=="complete"||civ.dimension!==player.dimension.id) {
        reply(["Wall leaf preview needs a completed Overworld district and an Overworld player. Nothing changed."],event);return;
    }
    const token=reserveJob("civ-wall-leaf-preview");
    if(!token){reply([runningPhrase()],event);return;}
    reply([`Verifying ${districtTitle(index)} and completed neighboring plans before a read-only leaf preview. Only player-loaded chunks will be read; no chunk holds are changed.`],event);
    try {
        const saved=await runJobAsync(token,loadSavedRunSteps(civ,newOps(),index));
        if(token.cancelled||!saved)return;
        if(!saved.ok||saved.queue.state!=="complete"){reply(formatErrorLines("Wall leaf preview refused",saved.ok?["The original source queue is not complete."]:saved.reasons),event);return;}
        const records=[saved.record],proofs=[{id:districtIdFor(index),checksum:civ.checksum,dimension:civ.dimension}];
        const master=JSON.stringify(saved.plan);
        for(const district of /** @type {any[]} */(loaded.kingdom.districts)) {
            if(district.id===districtIdFor(index)||district.civ===undefined)continue;
            const otherIndex=Number(String(district.id).replace(/^district-/,""));
            if(!DISTRICT_INDEXES.includes(otherIndex)||district.civ?.status!=="complete"||district.civ.dimension!==player.dimension.id)throw new Error("Every existing neighboring civilization source must be completed in this dimension.");
            reply([`Verifying ${districtTitle(otherIndex)}'s source for historical decoration protection (read-only)...`],event);
            const other=await runJobAsync(token,loadSavedRunSteps(district.civ,newOps(),otherIndex));
            if(token.cancelled||!other)return;
            if(!other.ok||other.queue.state!=="complete"||JSON.stringify(other.plan)!==master)throw new Error(`Cannot verify ${district.id}'s completed same-city source.`);
            records.push(other.record);proofs.push({id:district.id,checksum:district.civ.checksum,dimension:district.civ.dimension});
        }
        const current=kingdomStore.load().kingdom;
        if(!current||current.districts.filter((/** @type {any} */d)=>d.civ!==undefined).length!==proofs.length||proofs.some(proof=>{
            const matches=/** @type {any[]} */(current.districts??[]).filter(d=>d.id===proof.id);
            return matches.length!==1||matches[0].civ?.status!=="complete"||matches[0].civ.checksum!==proof.checksum||matches[0].civ.dimension!==proof.dimension;
        }))throw new Error("Saved source identities changed during verification; repeat the read-only preview.");
        const areas=protectedRects(current,1,saved.plan,WRITE_PROTECT_GROW,index);
        const result=await runJobAsync(token,previewWallLeavesSteps({record:saved.record,records,
            read:p=>player.dimension.getBlock(p),isProtected:(x,z)=>inProtectedArea(areas,x,z),cancelled:()=>token.cancelled}));
        if(token.cancelled||!result)return;
        reply(formatWallLeafPreview(result,page),event);
    } catch(error){if(!token.cancelled)reply(formatErrorLines("Wall leaf preview failed",[String(error)]),event);}
    finally{finishJob(token);}
}

/** Verify every protecting neighboring city before compiling any margin permission.
 * @param {any} kingdom @param {any} saved @param {number} index
 * @param {import("../integration/districtBuilder.js").Job} token @param {ProtectedArea[]} areas @param {string} dimensionId
 * @param {(lines:string[])=>void} tell
 */
async function sharedTreeProtectionFor(kingdom,saved,index,token,areas,dimensionId,tell) {
    const records=[];
    const master=JSON.stringify(saved.plan);
    for(const district of /** @type {any[]} */ (kingdom.districts ?? [])) {
        if(district.id===districtIdFor(index))continue;
        const civ=district.civ;
        if(civ?.status!=="building"&&civ?.status!=="complete")continue;
        if(civ.status!=="complete")return {ok:false,reasons:[`${district.id} is still building; shared tree protection needs its completed saved plan. Nothing changed.`]};
        const otherIndex=Number(String(district.id).replace(/^district-/,""));
        if(!DISTRICT_INDEXES.includes(otherIndex))return {ok:false,reasons:[`${district.id} has no supported saved-plan slot for shared tree protection. Nothing changed.`]};
        if(civ.dimension!==dimensionId)return {ok:false,reasons:[`${district.id}'s dimension is missing or differs from this city; shared tree protection cannot be verified. Nothing changed.`]};
        tell([`Verifying ${districtTitle(otherIndex)}'s original neighboring plan (read-only)...`]);
        const other=await runJobAsync(token,loadSavedRunSteps(civ,newOps(),otherIndex));
        if(token.cancelled||!other)return {ok:false,reasons:["Shared tree verification was cancelled."]};
        if(!other.ok)return {ok:false,reasons:[`Cannot verify ${district.id}'s shared tree protection.`,...other.reasons]};
        if(other.queue.state!=="complete"||JSON.stringify(other.plan)!==master) {
            return {ok:false,reasons:[`${district.id}'s saved plan is not a completed neighbor in this city. Nothing changed.`]};
        }
        records.push(other.record);
        tell([`${districtTitle(otherIndex)} neighboring plan verified; no blocks changed.`]);
    }
    tell([`Compiling shared-wall tree safeguards from ${records.length} verified neighboring plans (read-only)...`]);
    const protection=await runJobAsync(token,compileSharedTreeProtectionSteps(records,saved.region,
        (x,z)=>inProtectedArea(areas,x,z)&&isSharedWallFill(areas,{x,y:0,z,id:"minecraft:stone_bricks",kind:"wall"})));
    if(token.cancelled||!protection)return {ok:false,reasons:["Shared tree verification was cancelled."]};
    return {ok:true,protection};
}

/** Verify saved walls and doors; explicit confirm resumes a separate guarded maintenance journal.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event @param {number} index @param {boolean} confirm */
async function repairSavedCity(kingdomStore, event, index, confirm) {
    const player = playerOf(event), loaded = kingdomStore.load();
    const civ = loaded.kingdom && districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if (!player || civ?.status !== "complete" || (civ.dimension !== undefined && civ.dimension !== player.dimension.id)) {
        reply(["City maintenance needs a completed district in your current dimension. Nothing changed."], event); return;
    }
    const token = reserveJob("civ-city-repair");
    if (!token) { reply([runningPhrase()], event); return; }
    let handedOver = false;
    reply([`Verifying ${districtTitle(index)}'s original wall and door plan${confirm ? " before guarded maintenance" : " (read-only)"}...`], event);
    try {
        const saved = await runJobAsync(token,loadSavedRunSteps(civ,newOps(),index));
        if (token.cancelled || !saved) return;
        if (!saved.ok) { reply(formatErrorLines("City maintenance refused",saved.reasons),event); return; }
        const prepared = prepareCityRepair(saved.record,index);
        if (!confirm) {
            reply([`Verified the original wall and lot stages (${prepared.stageOps} operations). Only final non-air walls and paired doorways are eligible for maintenance.`,
                "Live obstructions have not been surveyed. The original completion record, plan and queue are unchanged.",
                `Run /scriptevent ${CIV_EVENT_IDS.diag} repair district=${index} confirm for guarded maintenance; foreign blocks and protected neighbors are preserved.`], event);
            return;
        }
        const areas=protectedRects(loaded.kingdom,1,saved.plan,WRITE_PROTECT_GROW,index);
        const shared=await sharedTreeProtectionFor(loaded.kingdom,saved,index,token,areas,player.dimension.id,lines=>reply(lines,event));
        if(token.cancelled)return;
        if(!shared.ok) {reply(formatErrorLines("City maintenance refused",shared.reasons ?? []),event);return;}
        startCityRepair({
            token, dimension:player.dimension, plan:saved.plan, record:saved.record, region:saved.region, district:index,
            protectedRects:areas,sharedTreeProtection:shared.protection,
            say:lines => reply(lines,event),
            onEnd(result) {
                reply([`=== ${districtTitle(index)} wall and doorway maintenance: ${result.status} ===`,
                    `${result.counts.placed} blocks restored, ${result.counts.built} already present, ${result.counts.skipped} preserved/skipped, ${result.counts.failed} failed writes.`,
                    ...topReasons(result.counts.byReason),
                    ...(result.reason ? [result.reason] : []),
                    "The original city completion record, saved plan and construction queue were kept. Maintenance has its own journal.",
                    ...(result.status === "complete" ? [] : [`Continue with /scriptevent ${CIV_EVENT_IDS.diag} repair district=${index} confirm.`]),
                ],event);
            },
        });
        handedOver = true;
    } catch (error) { reply(formatErrorLines("City maintenance failed",[String(error)]),event); }
    finally { if (!handedOver) finishJob(token); }
}

/** Inspect a completed district's remaining tree without changing blocks, plans or queues.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event @param {number} index
 * @param {{x:number,y:number,z:number}} seed */
async function inspectSavedTree(kingdomStore, event, index, seed) {
    if (!devGateOn()) { reply(["Tree inspection needs the developer gate enabled."], event); return; }
    const player = playerOf(event), loaded = kingdomStore.load();
    const civ = loaded.kingdom && districtById(loaded.kingdom, districtIdFor(index))?.civ;
    if (!player || civ?.status !== "complete" || (civ.dimension !== undefined && civ.dimension !== player.dimension.id)) {
        reply(["Tree inspection needs a completed district in your current dimension. Nothing changed."], event); return;
    }
    const token = reserveJob("civ-tree-inspection");
    if (!token) { reply([runningPhrase()], event); return; }
    reply([`Verifying ${districtTitle(index)}'s saved plan before read-only tree inspection at ${seed.x},${seed.y},${seed.z}...`], event);
    try {
        const saved = await runJobAsync(token, loadSavedRunSteps(civ, newOps(), index));
        if (token.cancelled || !saved) return;
        if (!saved.ok) { reply(formatErrorLines("Tree inspection refused", saved.reasons), event); return; }
        const areas=protectedRects(loaded.kingdom,1,saved.plan,WRITE_PROTECT_GROW,index);
        const shared=await sharedTreeProtectionFor(loaded.kingdom,saved,index,token,areas,player.dimension.id,lines=>reply(lines,event));
        if(token.cancelled)return;
        if(!shared.ok) {reply(formatErrorLines("Tree inspection refused",shared.reasons ?? []),event);return;}
        const result = await inspectNaturalTree({
            token, dimension:player.dimension, plan:saved.plan, record:saved.record,
            region:saved.region, district:index,protectedRects:areas,sharedTreeProtection:shared.protection,
        }, seed);
        if (!token.cancelled) reply([
            `Tree inspection at ${seed.x},${seed.y},${seed.z}: ${result.ok ? "natural proof passes" : result.reason}.`,
            ...(result.cells === undefined ? [] : [`Surveyed ${result.cells} tree cells: ${result.logs} logs, ${result.leaves} leaves.`]),
            "Read-only: no blocks, construction progress or saved plans changed. Temporary chunk holds released.",
        ], event);
    } catch (error) { reply(formatErrorLines("Tree inspection failed", [String(error)]), event); }
    finally { finishJob(token); }
}

/** Inspect exact saved door pairs; explicit confirm repairs only empty/matching door cells.
 * No replanning, terrain edits or saved-state changes. Repairs lease at most one remote chunk.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event
 */
async function handleDoors(kingdomStore,event) {
    const match=/^district=([1-5])(?: (confirm))?$/.exec(String(event.message ?? "").trim());
    if (!match) { reply([`Usage: /scriptevent ${CIV_EVENT_IDS.doors} district=N [confirm]. Without confirm this only inspects.`],event); return; }
    const index=Number(match[1]), repair=match[2]!==undefined;
    const loaded=kingdomStore.load();
    const civ=loaded.kingdom && districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if (civ?.status!=="complete") { reply(["Door inspection needs a completed district with a saved plan. Nothing changed."],event); return; }
    const token=reserveJob("civ-door-repair");
    if (!token) { reply([runningPhrase()],event); return; }
    reply([`Verifying ${districtTitle(index)}'s original door plan${repair ? " before restoring missing pairs" : " (read-only)"}...`],event);
    try {
        const saved=await runJobAsync(token,loadSavedRunSteps(civ,newOps(),index));
        if (token.cancelled || !saved) return;
        if (!saved.ok) { reply(formatErrorLines("Door inspection refused",saved.reasons),event); return; }
        const dimension=playerOf(event)?.dimension ?? world.getDimension("overworld");
        if (dimension.id!==civ.dimension && civ.dimension!==undefined) { reply(["The saved district belongs to another dimension. Nothing changed."],event); return; }
        const protectedAreas=protectedRects(loaded.kingdom,1,saved.plan,WRITE_PROTECT_GROW,index);
        const record=saved.record, heldToken=token;
        /** @type {Record<string,number>} */
        const counts={present:0,missing:0,placed:0,blocked:0,unloaded:0,failed:0};
        /** @type {string[]} */
        const notes=[];
        function* inspect() {
            for (let i=0;i<(record.lots ?? []).length;i++) {
                if (heldToken.cancelled) return;
                const ops=siteOpsFor(record,"lots",i);
                for (const op of ops) {
                    if (!isDoorOp(op) || op.states?.upper_block_bit!==false) continue;
                    const upper=ops.find(other=>other.x===op.x && other.y===op.y+1 && other.z===op.z && other.id===op.id && other.states?.upper_block_bit===true);
                    const guarded=inProtectedArea(protectedAreas,op.x,op.z);
                    let result=!upper || guarded ? {status:"blocked",reason:guarded ? "protected neighbor footprint" : "missing planned upper half"}
                        : inspectDoorPair(dimension,op);
                    if (repair && result.status==="unloaded") {
                        const lease=doorChunks.acquire([{dimension,cells:[{x:op.x,y:op.y,z:op.z}]}]);
                        try {
                            let state=lease.status();
                            while (state.state==="loading" && !heldToken.cancelled) { yield; state=lease.status(); }
                            if (heldToken.cancelled) return;
                            result=state.state==="ready" ? placeDoorPair(dimension,op) : {status:"unloaded",reason:state.reason ?? "door chunk did not load"};
                        } finally { lease.release(); }
                    } else if (repair && result.status==="missing") result=placeDoorPair(dimension,op);
                    counts[result.status]=(counts[result.status] ?? 0)+1;
                    if (!["present","placed"].includes(result.status) && notes.length<6) notes.push(`${op.x},${op.y},${op.z}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
                    yield;
                }
                yield;
            }
        }
        await runJobAsync(token,inspect());
        if (token.cancelled) return;
        reply([`=== ${districtTitle(index)} doors ===`,Object.entries(counts).map(([key,value])=>`${key} ${value}`).join(", "),...notes,
            repair ? "Only missing planned door pairs were restored; foreign blocks, existing complete doors and saved plans were kept. Temporary chunk holds were released." : "Read-only inspection. Add confirm to restore missing pairs with one temporary chunk hold at a time."],event);
    } catch (error) { reply(formatErrorLines("Door inspection failed",[String(error)]),event); }
    finally { finishJob(token); }
}

/** Support-only maintenance for an already built school. No saved-plan or terrain edits.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event @param {boolean} [all] */
async function handleSchoolRoof(kingdomStore,event,all=false) {
    const match=/^district=([1-5])(?: (keep_columns))?(?: (confirm))?$/.exec(String(event.message ?? "").trim());
    if (!match||(!all&&match[2])) { reply([`Usage: /scriptevent ${all ? CIV_EVENT_IDS.roofSupport : CIV_EVENT_IDS.schoolRoof} district=N${all ? " [keep_columns]" : ""} [confirm]. Without confirm this only inspects.`],event); return; }
    const index=Number(match[1]),keepColumns=match[2]!==undefined,repair=match[3]!==undefined,loaded=kingdomStore.load();
    const civ=loaded.kingdom && districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if (civ?.status!=="complete") { reply(["School roof maintenance needs a completed district with its saved plan."],event); return; }
    const token=reserveJob("school-roof-revision");
    if (!token) { reply([runningPhrase()],event); return; }
    reply([`Verifying ${districtTitle(index)}'s saved ${all ? "buildings" : "school"} before ${repair ? "replacing obsolete interior pillars with overhead joists" : "read-only roof inspection"}...`],event);
    try {
        const saved=await runJobAsync(token,loadSavedRunSteps(civ,newOps(),index));
        if (token.cancelled || !saved) return;
        if (!saved.ok) { reply(formatErrorLines("School roof refused",saved.reasons),event); return; }
        const dimension=playerOf(event)?.dimension ?? world.getDimension("overworld");
        if (civ.dimension!==undefined && dimension.id!==civ.dimension) { reply(["The school belongs to another dimension. Nothing changed."],event); return; }
        const groups=await runJobAsync(token,all ? buildingRoofRevisionSteps(saved.record,newOps(),undefined,keepColumns) : schoolRoofRevisionSteps(saved.record));
        if (token.cancelled || !groups) return;
        const fixtureGroups=keepColumns?await runJobAsync(token,buildingInteriorLightRevisionSteps(saved.record)):[];
        if(token.cancelled||!fixtureGroups)return;
        const protectedAreas=protectedRects(loaded.kingdom,1,saved.plan,WRITE_PROTECT_GROW,index);
        const counts={...(all ? {buildings:groups.length} : {schools:groups.length}),ready:0,changed:0,preserved:0,unloaded:0,...(keepColumns?{retained_columns:0}:{})};
        /** @type {string[]} */
        const notes=[];
        const schoolGroups=groups,heldToken=token,fixturePlans=fixtureGroups;
        const read=(/** @type {any} */ op)=>{try{return dimension.getBlock(op);}catch(_error){return undefined;}};
        const note=(/** @type {string} */ message)=>{if(notes.length<3)notes.push(message);};
        /** @param {any} group */
        function* reviseKeptColumns(group) {
            const key=(/** @type {any} */ p)=>`${p.x},${p.y},${p.z}`;
            /** @type {Map<string,string>} */ const live=new Map();
            /** @type {Map<string,boolean>} */ const lampStates=new Map();
            /** @type {Map<string,any>} */ const points=new Map();
            const label=group.element.id;
            const fixturePlan=fixturePlans.find(g=>g.element.id===label)?.fixtures??[];
            const stop=(/** @type {string} */ reason,unloaded=false)=>{counts[unloaded?"unloaded":"preserved"]++;note(`${label}: ${reason}; remaining supports kept.`);};
            for(const op of [...group.original,...group.changes])points.set(key(op),op);
            for(const f of fixturePlan)for(const p of [f.before,f.after,f.anchor])points.set(key(p),p);
            for(const [at,op] of points) {
                if(heldToken.cancelled)return;
                const b=read(op);if(!b||b.isValid===false){stop(`unreadable structure at ${at}`,true);return;}
                live.set(at,b.typeId);if(b.typeId==="minecraft:lantern")lampStates.set(at,b.permutation.getState("hanging")===true);yield;
            }
            // Only changed removal cells can seed retained columns. Capture contacts
            // through their floor now; the pure validator decides whether any qualify.
            for(const op of group.changes)if(op.id==="minecraft:air"&&live.get(key(op))!==op.before&&live.get(key(op))!==op.id) {
                for(let y=group.element.baseY;y<=op.y+1;y++)for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++) {
                    const p={x:op.x+dx,y,z:op.z+dz},at=key(p);if(live.has(at))continue;
                    if(heldToken.cancelled)return;
                    const b=read(p);if(!b||b.isValid===false){stop(`unreadable retained-column contact at ${at}`,true);return;}
                    live.set(at,b.typeId);yield;
                }
            }
            const alternate=roofFixtureAlternates(group,fixturePlan,live,lampStates);
            group=alternate.group;
            const planned=yield* retainedRoofColumnsSteps(group,live);
            if(!planned.ok){stop(planned.reason??"retained column proof refused");return;}
            counts.ready++;counts.retained_columns=(counts.retained_columns??0)+planned.columns;
            if(planned.columns)note(`${label}: retaining ${planned.columns} anchored log column(s); unknown logs and existing stone supports stay.`);
            if(!repair)return;
            const additions=group.changes.filter((/** @type {any} */ op)=>op.id!=="minecraft:air");
            /** @type {Map<string,string>} */ const guards=new Map([...planned.expected,...alternate.guards]);
            for(const op of additions)guards.set(key(op),op.id);
            for(const at of planned.keep) {
                const [x,,z]=at.split(",").map(Number),floor={x,y:group.element.baseY,z};
                guards.set(key(floor),live.get(key(floor))??"");
            }
            /** @param {ReadonlyMap<string,string>} expected */
            function* check(expected) {
                for(const [at,id] of expected) {
                    if(heldToken.cancelled)return false;
                    const [x,y,z]=at.split(",").map(Number),b=read({x,y,z});
                    if(!b||b.isValid===false){stop(`guard became unreadable at ${at}`,true);return false;}
                    if(b.typeId!==id){stop(`guard changed at ${at}`);return false;}
                    yield;
                }
                for(const op of alternate.stateGuards) {
                    const b=read(op);
                    if(!b||b.typeId!=="minecraft:lantern"||(b.permutation.getState("hanging")===true)!==(op.states?.hanging===true)){
                        stop(`migrated fixture state changed at ${key(op)}`);return false;
                    }
                }
                return true;
            }
            // Complete every addition before a single removal. A blocked new joist
            // can never be silently bypassed because another column was retained.
            for(const op of additions) {
                if(heldToken.cancelled)return;
                const b=read(op);if(!b||b.isValid===false){stop(`joist unreadable at ${key(op)}`,true);return;}
                if(b.typeId!==op.before&&b.typeId!==op.id){stop(`foreign needed joist at ${key(op)}`);return;}
                if(b.typeId!==op.id){b.setPermutation(BlockPermutation.resolve(op.id));counts.changed++;}
                yield;
            }
            if(!(yield* check(guards)))return;
            for(const op of group.changes) {
                if(op.id!=="minecraft:air"||planned.keep.has(key(op)))continue;
                // Freshly retain the joist/anchor barrier across interruptions and
                // player edits, in addition to the immediate target reread.
                if(!(yield* check(guards)))return;
                if(heldToken.cancelled)return;
                const b=read(op);if(!b||b.isValid===false){stop(`support unreadable at ${key(op)}`,true);return;}
                if(b.typeId===op.id)continue;
                if(b.typeId!==op.before){stop(`support changed at ${key(op)}`);return;}
                b.setPermutation(BlockPermutation.resolve(op.id));counts.changed++;yield;
            }
        }
        function* revise() {
            for (const group of schoolGroups) {
                if (heldToken.cancelled) return;
                if (!group.changes.length) continue;
                const label=`${group.element.kind} ${group.element.id}`;
                const protectedOp=group.changes.find(op=>inProtectedArea(protectedAreas,op.x,op.z));
                if (protectedOp) {counts.preserved++;note(`${label}: neighbor protection at ${protectedOp.x},${protectedOp.y},${protectedOp.z}; whole building kept.`);continue;}
                let lease;
                try {
                    if (repair) {
                        const r=group.element.bbox;
                        lease=schoolChunks.acquire([{dimension,cells:[{x:r.x0,y:group.element.baseY,z:r.z0},{x:r.x1,y:group.element.baseY,z:r.z1}]}]);
                        let state=lease.status();
                        while (state.state==="loading" && !heldToken.cancelled) {yield;state=lease.status();}
                        if (heldToken.cancelled) return;
                        if (state.state!=="ready") {counts.unloaded++;note(`${label}: ${state.reason ?? "chunks did not load"}`);continue;}
                    }
                    if(keepColumns){yield* reviseKeptColumns(group);continue;}
                    let foreign=false,unloaded=false;
                    for (const op of group.changes) {
                        const block=read(op);
                        if (!block || block.isValid===false) {if(!unloaded)note(`${label}: unreadable support at ${op.x},${op.y},${op.z}`);unloaded=true;}
                        else if (block.typeId!==op.before && block.typeId!==op.id) {
                            if(!foreign)note(`${label}: changed block ${block.typeId} at ${op.x},${op.y},${op.z}; expected ${op.before} or ${op.id}; whole building kept.`);
                            foreign=true;
                        }
                        yield;
                        if (heldToken.cancelled) return;
                    }
                    if (unloaded) {counts.unloaded++;continue;}
                    if (foreign) {counts.preserved++;continue;}
                    counts.ready++;
                    if (!repair) continue;
                    for (const op of group.changes) {
                        if (heldToken.cancelled) return;
                        const block=read(op);
                        if (!block || block.isValid===false) {counts.unloaded++;note(`${label}: support became unreadable at ${op.x},${op.y},${op.z}`);break;}
                        if (block.typeId===op.id) continue;
                        if (block.typeId!==op.before) {counts.preserved++;note(`${label}: block changed during repair at ${op.x},${op.y},${op.z}; remaining supports kept.`);break;}
                        block.setPermutation(BlockPermutation.resolve(op.id));counts.changed++;
                        yield;
                    }
                } finally {lease?.release();}
            }
        }
        await runJobAsync(token,revise());
        if (!token.cancelled) reply([`=== ${districtTitle(index)} ${all ? "building roof supports" : "school roof"} ===`,Object.entries(counts).map(([k,v])=>`${k} ${v}`).join(", "),...notes.slice(0,3),
            repair ? "Only exact obsolete planned supports changed. Walls, doors, furniture, ground and saved plans were kept; temporary holds were released." : "Read-only: no blocks, saved properties or chunk holds changed. Add confirm to repair the planned supports."],event);
    } catch(error) {reply(formatErrorLines("School roof maintenance stopped",[String(error)]),event);}
    finally {finishJob(token);}
}

/** Fixture-only migration. No blocks supporting furniture or buildings are changed.
 * @param {KingdomStore} kingdomStore @param {ScriptEvent} event */
async function handleInteriorLights(kingdomStore,event) {
    const match=/^district=([1-5])(?: building=([a-z0-9_-]+))?(?: (confirm))?$/.exec(String(event.message??"").trim());
    if(!match){reply(["Usage: /scriptevent civ:interior_lights district=N [building=ID] [confirm]. Without confirm this only inspects."],event);return;}
    const index=Number(match[1]),repair=!!match[3],loaded=kingdomStore.load();
    const civ=loaded.kingdom&&districtById(loaded.kingdom,districtIdFor(index))?.civ;
    if(civ?.status!=="complete"){reply(["Interior lighting needs a completed district. Nothing changed."],event);return;}
    const token=reserveJob("civ-audit");if(!token){reply([runningPhrase()],event);return;}
    reply(["Verifying saved buildings before "+(repair?"repairing supported interior fixtures":"read-only interior-light inspection")+"..."],event);
    try {
        const saved=await runJobAsync(token,loadSavedRunSteps(civ,newOps(),index));
        if(token.cancelled||!saved)return;
        if(!saved.ok){reply(formatErrorLines("Interior lighting refused",saved.reasons),event);return;}
        const dimension=playerOf(event)?.dimension??world.getDimension("overworld");
        if(civ.dimension!==dimension.id){reply(["Interior lighting needs the saved district's verified dimension. Nothing changed."],event);return;}
        const groups=await runJobAsync(token,buildingInteriorLightRevisionSteps(saved.record));
        if(token.cancelled||!groups)return;
        const protection=protectedRects(loaded.kingdom,1,saved.plan,WRITE_PROTECT_GROW,index);
        const lightGroups=match[2]?groups.filter(g=>g.element.id===match[2]):groups,heldToken=token;
        if(!lightGroups.length){reply(["No matching saved enclosed building. Nothing changed."],event);return;}
        const counts={buildings:lightGroups.length,fixtures:0,ready:0,changed:0,preserved:0,unloaded:0,unstable:0};
        /** @type {string[]} */const notes=[];
        const note=(/** @type {string} */ message)=>{if(notes.length<4)notes.push(message);};
        const key=(/** @type {any} */ p)=>[p.x,p.y,p.z].join(",");
        const read=(/** @type {any} */ p)=>{try{const b=dimension.getBlock(p);return b?.isValid===false?undefined:b;}catch(_error){return undefined;}};
        const hanging=(/** @type {any} */ b)=>b?.permutation?.getState("hanging")===true;
        const lampMatches=(/** @type {any} */ b,/** @type {any} */ op)=>b?.typeId==="minecraft:lantern"&&hanging(b)===(op.states?.hanging===true);
        function* revise() {
            for(const group of lightGroups) {
                if(heldToken.cancelled)return;
                const original=new Map(group.original.map(op=>[key(op),op])),revised=new Map(group.revised.map(op=>[key(op),op]));
                let lease;
                try {
                    if(repair) {
                        const r=group.element.bbox;
                        lease=schoolChunks.acquire([{dimension,cells:[{x:r.x0,y:group.element.baseY,z:r.z0},{x:r.x1,y:group.element.baseY,z:r.z1}]}]);
                        let state=lease.status();while(state.state==="loading"&&!heldToken.cancelled){yield;state=lease.status();}
                        if(heldToken.cancelled)return;
                        if(state.state!=="ready"){counts.unloaded+=group.fixtures.length;note(group.element.id+": chunks unavailable");continue;}
                    }
                    for(const fixture of group.fixtures) {
                        yield;if(heldToken.cancelled)return;counts.fixtures++;
                        const {before,after,anchor}=fixture,same=key(before)===key(after);
                        const fail=(/** @type {string} */ reason,unloaded=false)=>{counts[unloaded?"unloaded":"preserved"]++;note(group.element.id+": "+reason);};
                        if([before,after,anchor].some(p=>inProtectedArea(protection,p.x,p.z))){fail("neighbor protection; fixture kept");continue;}
                        // Only local contacts are relevant to moving a fixture. Unknown
                        // retained columns elsewhere in the hall are left untouched.
                        const contacts=new Map();
                        for(const p of [before,after])for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++) {
                            const q={x:p.x+dx,y:p.y+dy,z:p.z+dz};contacts.set(key(q),q);
                        }
                        // At most 54 contacts; no yields in this final atomic proof.
                        const freshContacts=()=>{
                            for(const [at,p] of contacts) {
                                if(at===key(before)||at===key(after))continue;
                                const b=read(p);if(!b){fail("unreadable contact at "+at,true);return false;}
                                if(b.typeId!=="minecraft:air"&&b.typeId!==original.get(at)?.id&&b.typeId!==revised.get(at)?.id){fail("foreign contact at "+at);return false;}
                            }
                            return true;
                        };
                        /** Fresh all-prerequisite proof, reused immediately before writes.
                         * @returns {Generator<void,boolean,void>} */
                        function* check() {
                            if(heldToken.cancelled)return false;
                            const support=read(anchor),old=read(before),target=read(after);
                            if(!support||!old||!target){fail("unreadable fixture/anchor",true);return false;}
                            if(support.typeId!==anchor.id){fail("changed anchor at "+key(anchor));return false;}
                            if(old.typeId!=="minecraft:air"&&!lampMatches(old,before)&&!(same&&lampMatches(old,after))){fail("changed source at "+key(before));return false;}
                            if(target.typeId!=="minecraft:air"&&!lampMatches(target,after)&&!(same&&lampMatches(target,before))){fail("changed target at "+key(after));return false;}
                            for(const [at,p] of contacts) {
                                if(heldToken.cancelled)return false;
                                if(at===key(before)||at===key(after))continue;
                                const b=read(p);if(!b){fail("unreadable contact at "+at,true);return false;}
                                if(b.typeId!=="minecraft:air"&&b.typeId!==original.get(at)?.id&&b.typeId!==revised.get(at)?.id){fail("foreign contact at "+at);return false;}
                                yield;
                            }
                            return true;
                        }
                        if(!(yield* check()))continue;counts.ready++;
                        if(!repair)continue;
                        if(!(yield* check()))continue;
                        if(!freshContacts())continue;
                        const target=read(after);
                        if(!target){fail("target unloaded before placement",true);continue;}
                        const source=read(before);
                        if(!source){fail("source unloaded before placement",true);continue;}
                        if(source.typeId!=="minecraft:air"&&!lampMatches(source,before)&&!(same&&lampMatches(source,after))){fail("source changed immediately before placement");continue;}
                        if(read(anchor)?.typeId!==anchor.id||(target.typeId!=="minecraft:air"&&!lampMatches(target,after)&&!(same&&lampMatches(target,before)))){fail("anchor/target changed immediately before placement");continue;}
                        if(!lampMatches(target,after)) {
                            target.setPermutation(BlockPermutation.resolve(after.id,after.states));counts.changed++;
                        }
                        // Give native neighbour/attachment updates real game ticks.
                        const placedAt=system.currentTick;while(system.currentTick-placedAt<2){if(heldToken.cancelled)return;yield;}
                        if(!(yield* check()))continue;
                        if(!lampMatches(read(after),after)){counts.unstable++;note(group.element.id+": new fixture did not remain attached; old fixture kept");continue;}
                        if(!same) {
                            if(!freshContacts())continue;
                            const old=read(before);
                            // No yield between final target/anchor/source reads and removal.
                            if(!lampMatches(read(after),after)||read(anchor)?.typeId!==anchor.id){fail("fixture/anchor changed before old-light removal");continue;}
                            if(old?.typeId==="minecraft:air")continue;
                            if(!old||!lampMatches(old,before)){fail("source changed before removal");continue;}
                            old.setPermutation(BlockPermutation.resolve("minecraft:air"));counts.changed++;
                        }
                    }
                } finally {lease?.release();}
            }
        }
        await runJobAsync(token,revise());if(heldToken.cancelled)return;
        reply(["=== "+districtTitle(index)+" supported interior lights ===",Object.entries(counts).map(([k,v])=>k+" "+v).join(", "),...notes,
            repair?"Only verified lantern fixtures changed; supports, furniture, saved plans and unrelated blocks kept. Temporary holds released.":"Read-only: no blocks, saved properties or chunk holds changed. Add confirm to repair fixtures."],event);
    }catch(error){reply(formatErrorLines("Interior lighting failed",[String(error instanceof Error?error.message:error)]),event);}
    finally{finishJob(token);}
}

/** Read the original plan's placement reasons without surveying or changing the world.
 * @param {KingdomStore} kingdomStore @param {number} index @param {ScriptEvent} event @param {boolean} [preview]
 */
async function inspectSavedLots(kingdomStore, index, event, preview = false) {
    const loaded = kingdomStore.load();
    const civ = loaded.kingdom && districtById(loaded.kingdom, districtIdFor(index))?.civ;
    if (civ?.status !== "complete") {
        reply(["Lot inspection needs a completed district with a saved plan. Nothing changed."], event);
        return;
    }
    const token = reserveJob("civ-audit");
    if (!token) { reply([runningPhrase()], event); return; }
    reply([`Reading ${districtTitle(index)}'s saved placement reasons...`], event);
    try {
        const saved = await runJobAsync(token, loadSavedRunSteps(civ, newOps(), index));
        if (token.cancelled || !saved) return;
        if (!saved.ok) { reply(formatErrorLines("Lot inspection refused", saved.reasons), event); return; }
        let record = saved.record;
        if (preview) {
            reply(["Previewing balanced essential services on the original saved ground; this cannot replace the stored layout or write blocks."], event);
            const candidate = await runJobAsync(token, rehydrateSiteSteps(saved.plan, index, saved.payload.ground, { ...siteOptionsOf(record), lotTerrain: "survey-balanced", ops:newOps() }));
            if (token.cancelled || !candidate) return;
            if (!candidate.ok) { reply(formatErrorLines("Lot preview refused", candidate.problems), event); return; }
            record = candidate.record;
        }
        const missing = shortfallOf(record);
        const zero = new Set(missing.filter((item) => item.placed === 0).map((item) => item.kind));
        const notes = (/** @type {string[]} */ (record.notes ?? [])).filter((note) =>
            [...zero].some((kind) => note.includes(` x ${kind}`) || note.includes(`-${kind}-`)));
        reply([
            `=== ${districtTitle(index)} ${preview ? "balanced preview" : "saved lot audit"} ===`,
            missing.length ? `Shortfalls: ${missing.map((item) => `${item.kind} ${item.placed}/${item.wanted}`).join(", ")}` : "All requested facilities were planned.",
            auditRecord(record).length ? `Facility audit: ${auditRecord(record).slice(0,4).join("; ")}` : "Facility audit: passed.",
            ...(/** @type {any[]} */ (record.lots ?? [])).filter((e) => ["building-chapel","building-school","building-hospital","building-garden"].includes(e.kind)).slice(0,12).map((e) => `${String(e.kind).replace("building-","")}: door ${e.door.x}, ${e.baseY+1}, ${e.door.z}${preview ? " (preview only)" : ""}`),
            ...notes.slice(0, 16),
            ...(notes.length > 16 ? [`${notes.length - 16} more placement notes omitted.`] : []),
            "Read-only inspection; no blocks, saved plans or kingdom records changed.",
        ], event);
    } catch (error) {
        reply(formatErrorLines("Lot inspection failed", [String(error)]), event);
    } finally {
        finishJob(token);
    }
}

/**
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleDevgate(args, event) {
    const value = args[0]?.toLowerCase();
    if (value === "on" || value === "off") {
        world.setDynamicProperty(CIV.devGateKey, value === "on");
        reply([
            `Development gate ${value}: districts 2-${String(DISTRICT_INDEXES.length)} ${value === "on" ? "may be generated in this world, one at a time and only after their lower-numbered neighbours are complete" : "cannot be generated in this world any more (district 1 is unaffected)"}.`,
            `One command per district: /scriptevent ${CIV_EVENT_IDS.generate} district=2. Arming a starter world wipes the gate.`,
            ...CIV_SAFETY_WARNING,
        ], event);
        return;
    }
    reply([`Development gate is ${devGateOn() ? "on" : "off"}. Usage: /scriptevent ${CIV_EVENT_IDS.devgate} on|off`, ...CIV_SAFETY_WARNING], event);
}
