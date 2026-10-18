import { PHYSICAL, PHYSICAL_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { districtById } from "../kingdom/state.js";
import { system, world } from "@minecraft/server";
import { activeKind, cancelActiveJob, finishJob, holdChunks, isBusy, releaseChunks, reserveJob, startBuild, startScan } from "../integration/districtBuilder.js";
import { planDistrict, planHash } from "../structures/planner.js";
import { formatErrorLines } from "../ui/report.js";
import { parseArgs } from "./args.js";
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
 *   civ:district_generate [district-id] [confirm]   dry-run survey; with `confirm`, build
 *   civ:district_resume   [district-id]              finish an interrupted build
 *   civ:district_status                              record + job state
 *   civ:district_abort                               stop the running job (blocks stay)
 *
 * The district is centred on the invoking player's feet block. Nothing is written without
 * the word `confirm`, and a site with any obstruction or non-natural ground is refused.
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
 * @param {KingdomStore} kingdomStore
 * @param {string[]} args
 * @param {ScriptEvent} event
 * @param {boolean} resume
 */
function handleGenerate(kingdomStore, args, event, resume) {
    const title = resume ? "Resume refused" : "Generate refused";
    const found = playerOf(event);
    if (found === undefined) {
        reply(formatErrorLines(title, ["Run this as a player: the district is centred on your feet."]), event);
        return;
    }
    const player = /** @type {Player} */ (found);
    if (isBusy()) {
        say(player, formatErrorLines(title, [`A physical ${String(activeKind())} job is already running.`, "Wait for it, or run /scriptevent civ:district_abort."]));
        return;
    }
    const confirm = args.includes("confirm");
    const districtId = args.find((arg) => arg !== "confirm") ?? PHYSICAL.prototypeDistrict;
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

    const origin = resume
        ? { x: record.origin.x, y: record.origin.y, z: record.origin.z }
        : { x: Math.floor(player.location.x), y: Math.floor(player.location.y), z: Math.floor(player.location.z) };
    const dimension = player.dimension;
    const startCursor = resume ? Number(record.placed) : 0;

    say(player, [
        `=== ${district.name}: ${resume ? "resuming" : confirm ? "generating" : "survey (dry run)"} ===`,
        `Centre ${String(origin.x)}, ${String(origin.y)}, ${String(origin.z)} in ${dimension.id}; footprint ${String(plan.half * 2 + 1)} x ${String(plan.half * 2 + 1)}.`,
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
        const held = await holdChunks(dimension, origin, plan.half);
        if (token.cancelled) {
            return;
        }
        if (held.note) {
            say(player, [`Note: ${held.note}`]);
        }
        startScan(token, dimension, origin, plan, (scan) => {
            if (scan.unloaded > 0 || scan.conflicts > 0) {
                finish();
                say(player, formatErrorLines("Site refused - nothing was changed", [
                    `${String(scan.conflicts)} obstructed cell(s), ${String(scan.unloaded)} unloaded cell(s) in the footprint.`,
                    ...scan.samples,
                    "Natural terrain (hills, trees, water) is not supported yet - nothing was touched. Stand in a flat, empty clearing and try again.",
                ]));
                return;
            }
            if (!confirm && !resume) {
                finish();
                say(player, [
                    `Site is clear: ${String(scan.toPlace)} blocks to place, ${String(scan.alreadyBuilt)} already present.`,
                    "The ground surface under roads, floors and farms will be REPLACED. Nothing above ground is touched.",
                    `To build here: /scriptevent civ:district_generate ${districtId} confirm`,
                ]);
                return;
            }
            beginBuild();
        });
    })().catch((error) => {
        finish();
        say(player, formatErrorLines("Survey failed", [String(error)]));
    });

    function beginBuild() {
        if (!resume) {
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
            });
            if (!saved) {
                finish();
                say(player, formatErrorLines("Generate refused", ["Could not record the build in the saved kingdom; nothing was placed."]));
                return;
            }
        }
        say(player, [`Building ${String(plan.blockCount - startCursor)} blocks. Stay within ~40 blocks; progress is reported as it goes.`]);
        let lastSaved = startCursor;
        let lastReported = -1;
        startBuild(token, dimension, origin, plan, startCursor, {
            onSlice(state) {
                if (state.cursor - lastSaved >= PHYSICAL.saveEvery) {
                    lastSaved = state.cursor;
                    patchPhysical(kingdomStore, districtId, { placed: state.cursor });
                }
                const percent = Math.floor((state.cursor / state.total) * 100 / 25) * 25;
                if (percent > lastReported && percent < 100) {
                    lastReported = percent;
                    say(player, [`  ${String(percent)}% (${String(state.cursor)} / ${String(state.total)})`]);
                }
            },
            onStopped(reason, state) {
                try {
                    patchPhysical(kingdomStore, districtId, { placed: state.cursor });
                    say(player, formatErrorLines("Build paused", [reason, `${String(state.cursor)} of ${String(state.total)} blocks handled.`, ...state.samples]));
                } finally {
                    releaseChunks();
                }
            },
            onDone(state) {
                try {
                    const clean = state.refused === 0 && state.failed === 0;
                    patchPhysical(kingdomStore, districtId, clean ? { status: "complete", placed: state.total } : { status: "building", placed: 0 });
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
        });
    }
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
            lines.push(`${String(district.name)}: not generated${district.id === PHYSICAL.prototypeDistrict ? ` (/scriptevent civ:district_generate ${String(district.id)})` : ""}`);
        } else {
            lines.push(`${String(district.name)}: ${String(record.status)} - ${String(record.placed)}/${String(record.total)} blocks, centre ${String(record.origin.x)}, ${String(record.origin.y)}, ${String(record.origin.z)} (${String(record.dimension)}), layout ${String(record.layout)} v${String(record.version)}`);
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
