import { PHYSICAL, PHYSICAL_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { districtById } from "../kingdom/state.js";
import { system, world } from "@minecraft/server";
import { activeKind, cancelActiveJob, finishJob, holdChunks, isBusy, releaseChunks, reserveJob, startBuild, startScan } from "../integration/districtBuilder.js";
import { startScout, startTerrainScan } from "../integration/terrainScan.js";
import { planDistrict, planHash } from "../structures/planner.js";
import { formatErrorLines } from "../ui/report.js";
import { parseArgs, parseCount } from "./args.js";
import { reply } from "./reply.js";

/**
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ScriptEvent
 * @typedef {import("@minecraft/server").Player} Player
 */

let registered = false;

/**
 * Physical district commands.
 *
 *   civ:district_scout   [radius]                     read-only: rank nearby building sites
 *   civ:district_generate [district-id] [at x z] [maxcut=N] [maxfill=N] [confirm] [terrain=code]
 *                                                     read-only survey; with `confirm`, build
 *   civ:district_resume   [district-id]               finish an interrupted build
 *   civ:district_status                               record + job state
 *   civ:district_abort                                stop the running job (blocks stay)
 *
 * Surveys never write. The district is centred on the invoking player (or on `at x z`), the
 * real ground height is read from the world, and natural terrain (grass, flowers, natural trees,
 * moderate slopes) is prepared only after an explicit `confirm` - and, when terrain would change,
 * only with the `terrain=<code>` the survey printed. Player builds are never touched.
 *
 * @param {KingdomStore} kingdomStore
 */
export function registerPhysicalCommands(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;

    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (event.id === PHYSICAL_EVENT_IDS.generate) {
            handleGenerate(kingdomStore, parseArgs(event.message), event, false);
        } else if (event.id === PHYSICAL_EVENT_IDS.resume) {
            handleGenerate(kingdomStore, parseArgs(event.message), event, true);
        } else if (event.id === PHYSICAL_EVENT_IDS.status) {
            handleStatus(kingdomStore, event);
        } else if (event.id === PHYSICAL_EVENT_IDS.abort) {
            handleAbort(event);
        } else if (event.id === PHYSICAL_EVENT_IDS.scout) {
            handleScout(parseArgs(event.message), event);
        }
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}

/**
 * @param {ScriptEvent} event
 * @returns {Player | undefined}
 */
function playerOf(event) {
    const source = event.sourceEntity ?? event.initiator;
    return source !== undefined && source.typeId === "minecraft:player" ? /** @type {Player} */ (source) : undefined;
}

/**
 * @param {Player} player
 * @param {string[]} lines
 */
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

/**
 * Re-load, patch one district's physical record, save. Never holds the kingdom across a yield,
 * so it cannot clobber a simulation step that ran in between.
 *
 * @param {KingdomStore} kingdomStore
 * @param {string} districtId
 * @param {Record<string, any>} patch
 */
function patchPhysical(kingdomStore, districtId, patch) {
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        return false;
    }
    const district = districtById(loaded.kingdom, districtId);
    if (!district) {
        return false;
    }
    district.physical = { ...(district.physical ?? {}), ...patch };
    kingdomStore.save(loaded.kingdom);
    return true;
}

/**
 * Parse `[district-id] [at <x> <z>] [maxcut=N] [maxfill=N] [terrain=<code>] [confirm]`.
 * @param {string[]} args
 */
function parseGenerateArgs(args) {
    /** @type {{ districtId: string | undefined, confirm: boolean, at: { x: number, z: number } | undefined, terrain: string | undefined, maxCut: number, maxFill: number, error: string | undefined }} */
    const out = { districtId: undefined, confirm: false, at: undefined, terrain: undefined, maxCut: PHYSICAL.maxCut, maxFill: PHYSICAL.maxFill, error: undefined };
    for (let index = 0; index < args.length; index += 1) {
        const arg = /** @type {string} */ (args[index]);
        if (arg === "confirm") {
            out.confirm = true;
        } else if (arg === "at") {
            const x = Number(args[index + 1]);
            const z = Number(args[index + 2]);
            if (!Number.isInteger(x) || !Number.isInteger(z)) {
                out.error = "'at' needs two whole numbers: at <x> <z>";
                return out;
            }
            out.at = { x, z };
            index += 2;
        } else if (arg.startsWith("terrain=")) {
            out.terrain = arg.slice("terrain=".length);
        } else if (arg.startsWith("maxcut=") || arg.startsWith("maxfill=")) {
            const [name, raw] = arg.split("=");
            const value = Number(raw);
            const cap = name === "maxcut" ? PHYSICAL.capCut : PHYSICAL.capFill;
            if (!Number.isInteger(value) || value < 0 || value > cap) {
                out.error = `${String(name)} must be a whole number from 0 to ${String(cap)}`;
                return out;
            }
            if (name === "maxcut") {
                out.maxCut = value;
            } else {
                out.maxFill = value;
            }
        } else if (out.districtId === undefined && !arg.includes("=")) {
            out.districtId = arg;
        } else {
            out.error = `unrecognised argument '${arg}'`;
            return out;
        }
    }
    return out;
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 * @param {boolean} resume
 */
function handleGenerate(kingdomStore, args, event, resume) {
    const title = resume ? "Resume refused" : "Generate refused";
    const found = playerOf(event);
    if (found === undefined) {
        reply(formatErrorLines(title, ["Run this as a player: the district is centred on your position."]), event);
        return;
    }
    const player = /** @type {Player} */ (found);
    if (isBusy()) {
        say(player, formatErrorLines(title, [`A physical ${String(activeKind())} job is already running.`, "Wait for it, or run /scriptevent civ:district_abort."]));
        return;
    }
    const parsed = parseGenerateArgs(args);
    if (parsed.error !== undefined) {
        say(player, formatErrorLines(title, [parsed.error, "Usage: /scriptevent civ:district_generate [district-id] [at <x> <z>] [maxcut=N] [maxfill=N] [confirm] [terrain=<code>]"]));
        return;
    }
    const confirm = parsed.confirm;
    const districtId = parsed.districtId ?? PHYSICAL.prototypeDistrict;
    if (districtId !== PHYSICAL.prototypeDistrict) {
        say(player, formatErrorLines(title, [`Only ${PHYSICAL.prototypeDistrict} has a physical layout so far.`]));
        return;
    }
    const loaded = kingdomStore.load();
    const district = loaded.kingdom ? districtById(loaded.kingdom, districtId) : undefined;
    if (!loaded.kingdom || !district) {
        say(player, formatErrorLines(title, [`No readable kingdom or district: ${String(loaded.reason ?? districtId)}`]));
        return;
    }

    const record = district.physical;
    // A resumed build re-plans from the building counts it STARTED with: the simulation keeps
    // changing the live counts, and the half-built structure must not be re-planned around them.
    const planInput = resume && record?.built ? { ...district, buildings: { ...district.buildings, ...record.built } } : district;
    const plan = planDistrict(planInput, PHYSICAL.layoutId);
    const hash = planHash(plan);

    if (resume) {
        if (!record || record.status !== "building") {
            say(player, formatErrorLines(title, ["There is no interrupted physical build to resume."]));
            return;
        }
        if (record.planHash !== hash || record.version !== plan.version) {
            say(player, formatErrorLines(title, ["The blueprint changed since this build started; resuming could corrupt it.", `recorded ${String(record.planHash)}, current ${hash}`]));
            return;
        }
        if (record.dimension !== player.dimension.id) {
            say(player, formatErrorLines(title, [`The build is in ${String(record.dimension)}; you are in ${player.dimension.id}.`]));
            return;
        }
    } else if (record) {
        say(player, formatErrorLines(title, [`${district.name} already has a physical record (${String(record.status)}).`, record.status === "building" ? "Use /scriptevent civ:district_resume." : "Nothing is generated twice."]));
        return;
    }

    const dimension = player.dimension;
    const centre = resume
        ? { x: Number(record.origin.x), z: Number(record.origin.z) }
        : parsed.at ?? { x: Math.floor(player.location.x), z: Math.floor(player.location.z) };
    const resumePhase = resume ? (record.phase === "terrain" && record.terrain ? "terrain" : "structure") : "terrain";
    const limits = resume && record.terrain ? { maxCut: Number(record.terrain.maxCut), maxFill: Number(record.terrain.maxFill) } : { maxCut: parsed.maxCut, maxFill: parsed.maxFill };
    const startCursor = resume && resumePhase === "structure" ? Number(record.placed) : 0;

    say(player, [
        `=== ${district.name}: ${resume ? "resuming" : confirm ? "generating" : "survey (dry run)"} ===`,
        `Centre column ${String(centre.x)}, ${String(centre.z)} in ${dimension.id}; footprint ${String(plan.half * 2 + 1)} x ${String(plan.half * 2 + 1)}; terrain limits: cut ${String(limits.maxCut)}, fill ${String(limits.maxFill)}.`,
        `Plan: ${String(plan.blockCount)} blocks - ${Object.entries(plan.counts.built).map(([kind, count]) => `${String(count)} ${kind}`).join(", ")}, 1 permanent curtain wall, ${String(plan.gates.length)} gates.`,
        ...plan.notes,
        "Surveying the site (nothing is written yet)...",
    ]);

    const reserved = reserveJob("survey");
    if (reserved === undefined) {
        say(player, formatErrorLines(title, ["A physical job is already running."]));
        return;
    }
    const token = reserved;
    /** Release the slot and the chunks, unless an abort already did (and a newer job may own them). */
    const finish = () => {
        if (!token.cancelled) {
            finishJob(token);
            releaseChunks();
        }
    };

    void (async () => {
        const held = await holdChunks(dimension, { x: centre.x, y: Math.floor(player.location.y), z: centre.z }, plan.half + PHYSICAL.readApron);
        if (token.cancelled) {
            if (!isBusy()) {
                releaseChunks();
            }
            return;
        }
        if (held.note) {
            say(player, [`Note: ${held.note}`]);
        }
        if (resume && resumePhase === "structure") {
            const origin = { x: Number(record.origin.x), y: Number(record.origin.y), z: Number(record.origin.z) };
            startScan(token, dimension, origin, plan, (scan) => {
                if (scan.unloaded > 0 || scan.conflicts > 0) {
                    finish();
                    say(player, formatErrorLines("Resume refused - nothing was changed", [`${String(scan.conflicts)} obstructed cell(s), ${String(scan.unloaded)} unloaded cell(s).`, ...scan.samples]));
                    return;
                }
                beginBuild(origin, undefined);
            });
            return;
        }
        startTerrainScan(token, dimension, centre, plan.half, limits, resume ? Number(record.terrain.baseY) : undefined, (scan) => {
            if (!scan.ok) {
                finish();
                say(player, formatErrorLines("Site refused - nothing was changed", [
                    scan.unloaded > 0 ? `${String(scan.unloaded)} footprint column(s) are not loaded - stay near the site.` : `${String(scan.problems.length)} problem(s) in the footprint.`,
                    ...scan.samples,
                    "Nothing was touched. Try /scriptevent civ:district_scout to find a nearby suitable spot.",
                ]));
                return;
            }
            const origin = { x: centre.x, y: scan.baseY + 1, z: centre.z };
            const changes = scan.counts.cut + scan.counts.fill + scan.counts.top + scan.counts.clear;
            say(player, [
                `Ground found at y=${String(scan.groundMin)}..${String(scan.groundMax)}; platform at y=${String(scan.baseY)} (centre ${String(origin.x)}, ${String(origin.y)}, ${String(origin.z)}).`,
                changes === 0
                    ? `Site is clear: ${String(plan.blockCount)} blocks to place.`
                    : `Terrain work: cut ${String(scan.counts.cut)}, fill ${String(scan.counts.fill)}, resurface ${String(scan.counts.top)}, clear ${String(scan.counts.clear)} (${String(scan.counts.plants)} plant blocks, ${String(scan.counts.treeBlocks)} natural tree blocks). Then ${String(plan.blockCount)} blocks to place.`,
            ]);
            if (!resume && !confirm) {
                finish();
                const atArg = ` at ${String(centre.x)} ${String(centre.z)}`;
                const limitArg = ` maxcut=${String(limits.maxCut)} maxfill=${String(limits.maxFill)}`;
                say(player, [
                    "Nothing was changed. Only natural ground, grass, flowers and natural trees inside the footprint would be touched; no player build is ever overwritten.",
                    changes === 0
                        ? `To build here: /scriptevent civ:district_generate ${districtId}${atArg}${limitArg} confirm`
                        : `To prepare the terrain and build: /scriptevent civ:district_generate ${districtId}${atArg}${limitArg} confirm terrain=${scan.fingerprint}`,
                ]);
                return;
            }
            if (resume && record.terrain && (scan.counts.cut > Number(record.terrain.cut) || scan.counts.fill > Number(record.terrain.fill) || scan.counts.top > Number(record.terrain.top) || scan.counts.clear > Number(record.terrain.clear))) {
                finish();
                say(player, formatErrorLines("Resume refused - nothing was changed", [
                    "The terrain now needs more work than the survey you approved (new growth or changes).",
                    `approved: cut ${String(record.terrain.cut)}, fill ${String(record.terrain.fill)}, resurface ${String(record.terrain.top)}, clear ${String(record.terrain.clear)}`,
                ]));
                return;
            }
            if (!resume && changes > 0 && parsed.terrain !== scan.fingerprint) {
                finish();
                say(player, formatErrorLines("Confirm refused - nothing was changed", [
                    parsed.terrain === undefined ? "This site needs terrain changes, which need explicit approval." : "The world no longer matches the survey you approved.",
                    "Run the survey again (without confirm) and use the exact command it prints.",
                ]));
                return;
            }
            beginBuild(origin, scan);
        });
    })().catch((error) => {
        finish();
        say(player, formatErrorLines("Survey failed", [String(error)]));
    });

    /**
     * @param {{ x: number, y: number, z: number }} origin
     * @param {import("../integration/terrainScan.js").TerrainScan | undefined} scan
     */
    function beginBuild(origin, scan) {
        const work = scan !== undefined && scan.ok && scan.counts.cut + scan.counts.fill + scan.counts.top + scan.counts.clear > 0 ? scan : undefined;
        if (!resume) {
            const survey = /** @type {import("../integration/terrainScan.js").TerrainScan} */ (scan);
            const saved = patchPhysical(kingdomStore, districtId, {
                layout: PHYSICAL.layoutId,
                version: plan.version,
                status: "building",
                origin,
                dimension: dimension.id,
                placed: 0,
                total: plan.blockCount,
                planHash: hash,
                built: plan.counts.built,
                phase: work ? "terrain" : "structure",
                terrain: {
                    mode: work ? "terraced" : "flat",
                    baseY: survey.baseY,
                    cut: survey.counts.cut,
                    fill: survey.counts.fill,
                    top: survey.counts.top,
                    clear: survey.counts.clear,
                    maxCut: limits.maxCut,
                    maxFill: limits.maxFill,
                    fp: survey.fingerprint,
                },
            });
            if (!saved) {
                finish();
                say(player, formatErrorLines("Generate refused", ["Could not record the build in the saved kingdom; nothing was placed."]));
                return;
            }
        }
        say(player, [`Building ${String(plan.blockCount - startCursor)} structure blocks${work ? " after terrain preparation" : ""}. Stay within ~40 blocks; progress is reported as it goes.`]);
        let lastSaved = startCursor;
        let lastReported = -1;
        startBuild(token, dimension, origin, plan, startCursor, {
            onSlice(state) {
                if (state.phase === "structure" && state.cursor - lastSaved >= PHYSICAL.saveEvery) {
                    lastSaved = state.cursor;
                    patchPhysical(kingdomStore, districtId, { placed: state.cursor });
                }
                const percent = Math.floor(((state.progress / state.progressTotal) * 100) / 25) * 25;
                if (percent > lastReported && percent < 100) {
                    lastReported = percent;
                    say(player, [`  ${String(percent)}% (${state.phase}: ${String(state.progress)} / ${String(state.progressTotal)})`]);
                }
            },
            onPhase() {
                patchPhysical(kingdomStore, districtId, { phase: "structure" });
            },
            onStopped(reason, state) {
                try {
                    patchPhysical(kingdomStore, districtId, { placed: state.phase === "structure" ? state.cursor : 0, phase: state.phase });
                    say(player, formatErrorLines("Build paused", [reason, `${String(state.progress)} of ${String(state.progressTotal)} steps handled.`, ...state.samples]));
                } finally {
                    releaseChunks();
                }
            },
            onDone(state) {
                try {
                    const clean = state.refused === 0 && state.failed === 0;
                    patchPhysical(kingdomStore, districtId, clean ? { status: "complete", placed: state.total, phase: "structure" } : { status: "building", placed: 0, phase: "structure" });
                    say(player, [
                        clean ? `=== ${district.name} is built ===` : "=== Build finished with problems ===",
                        `Placed ${String(state.placed)}, already present ${String(state.alreadyBuilt)}, refused ${String(state.refused)}, failed ${String(state.failed)}, state fallbacks ${String(state.degraded)}.`,
                        ...(state.degraded > 0 ? ["WARNING: some blocks were placed without their facing/state (doors, stairs or ladders may be wrong). Report the lines below."] : []),
                        ...state.samples,
                        clean ? `Tour it: /tp @s ${String(origin.x)} ${String(origin.y + 1)} ${String(origin.z)}  (gates at +-23 on each axis)` : "Fix the obstructions and run /scriptevent civ:district_resume to retry the skipped cells.",
                    ]);
                } finally {
                    releaseChunks();
                }
            },
        }, work ? { centre, clear: work.clear, ops: work.ops } : resume && resumePhase === "terrain" ? { centre, clear: [], ops: [] } : undefined);
    }
}

/**
 * Read-only: rank nearby sites.
 * @param {string[]} args
 * @param {ScriptEvent} event
 */
function handleScout(args, event) {
    const player = playerOf(event);
    if (player === undefined) {
        reply(formatErrorLines("Scout refused", ["Run this as a player: the search is centred on you."]), event);
        return;
    }
    if (isBusy()) {
        say(player, formatErrorLines("Scout refused", [`A physical ${String(activeKind())} job is already running.`, "Wait for it, or run /scriptevent civ:district_abort."]));
        return;
    }
    const radius = parseCount(args[0], PHYSICAL.scoutDefaultRadius, 8, PHYSICAL.scoutMaxRadius);
    if (radius.error) {
        say(player, formatErrorLines("Scout refused", [`'${String(args[0])}' ${radius.error}`, `Usage: /scriptevent civ:district_scout [radius 8-${String(PHYSICAL.scoutMaxRadius)}]`]));
        return;
    }
    const reserved = reserveJob("scout");
    if (reserved === undefined) {
        say(player, formatErrorLines("Scout refused", ["A physical job is already running."]));
        return;
    }
    const token = reserved;
    const dimension = player.dimension;
    const centre = { x: Math.floor(player.location.x), z: Math.floor(player.location.z) };
    const half = 24;
    const limits = { maxCut: PHYSICAL.maxCut, maxFill: PHYSICAL.maxFill };
    say(player, [`=== Scouting within ${String(radius.value)} blocks (read-only) ===`, "Reading the ground around you..."]);

    const finish = () => {
        if (!token.cancelled) {
            finishJob(token);
            releaseChunks();
        }
    };
    void (async () => {
        const held = await holdChunks(dimension, { x: centre.x, y: Math.floor(player.location.y), z: centre.z }, radius.value + half + PHYSICAL.readApron);
        if (token.cancelled) {
            if (!isBusy()) {
                releaseChunks();
            }
            return;
        }
        if (held.note) {
            say(player, [`Note: ${held.note}`]);
        }
        startScout(token, dimension, centre, radius.value, half, limits, (result) => {
            finish();
            if (result.sites.length === 0) {
                const top = Object.entries(result.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
                say(player, formatErrorLines("No suitable site found", [
                    `${String(result.evaluated)} candidate site(s) checked${result.unloaded > 0 ? `, ${String(result.unloaded)} unloaded column(s)` : ""}.`,
                    ...top.map(([reason, count]) => `  ${String(count)}x ${reason}`),
                    "Move to a grassy, gently sloping area away from water and buildings, or try a larger radius.",
                ]));
                return;
            }
            say(player, [
                `Best ${String(result.sites.length)} site(s) from ${String(result.evaluated)} checked (cut/fill = blocks of earthwork):`,
                ...result.sites.flatMap((site, index) => [
                    `${String(index + 1)}) centre ${String(site.x)}, ${String(site.z)}  ground ~y=${String(site.baseY)}  cut ${String(site.cut)}, fill ${String(site.fill)}, tree blocks ~${String(site.trees)}, ${String(Math.round(site.distance))} blocks away`,
                    `   survey: /scriptevent civ:district_generate district-1 at ${String(site.x)} ${String(site.z)}`,
                ]),
                "A survey is read-only and prints the exact confirm command.",
            ]);
        });
    })().catch((error) => {
        finish();
        say(player, formatErrorLines("Scout failed", [String(error)]));
    });
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handleStatus(kingdomStore, event) {
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatErrorLines("Physical status", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }
    const lines = ["=== Physical districts ==="];
    for (const district of /** @type {any[]} */ (loaded.kingdom.districts)) {
        const record = district.physical;
        if (!record) {
            lines.push(`${String(district.name)}: not generated${district.id === PHYSICAL.prototypeDistrict ? ` (survey first: /scriptevent civ:district_generate ${String(district.id)})` : ""}`);
        } else {
            lines.push(`${String(district.name)}: ${String(record.status)}${record.phase ? ` (${String(record.phase)} phase)` : ""} - ${String(record.placed)}/${String(record.total)} blocks, centre ${String(record.origin.x)}, ${String(record.origin.y)}, ${String(record.origin.z)} (${String(record.dimension)}), layout ${String(record.layout)} v${String(record.version)}`);
            if (record.terrain) {
                lines.push(`  terrain: ${String(record.terrain.mode)}, platform y=${String(record.terrain.baseY)}, cut ${String(record.terrain.cut)}, fill ${String(record.terrain.fill)}, clear ${String(record.terrain.clear)}`);
            }
            if (record.status === "building" && !isBusy()) {
                lines.push("  interrupted - run /scriptevent civ:district_resume");
            }
        }
    }
    lines.push(isBusy() ? `Job running: ${String(activeKind())}` : "No job running.");
    reply(lines, event);
}

/**
 * @param {ScriptEvent} event
 */
function handleAbort(event) {
    if (cancelActiveJob()) {
        releaseChunks();
        reply(["Physical job stopped. Placed blocks stay; run /scriptevent civ:district_resume to continue a build."], event);
    } else {
        reply(["No physical job is running."], event);
    }
}
