import { SIM } from "../config.js";
import { advanceKingdom } from "../sim/tick.js";
import { isDemoEnabled, materialiseNextStage } from "./buildAdapter.js";
import { system, world } from "@minecraft/server";

/**
 * The heartbeat: one kingdom step per in-game hour, not per game tick, so a step never
 * runs on the 20-ticks-per-second path.
 *
 * Only event subscriptions and one scheduled run are created at module scope, because
 * Script API v2 executes scripts in early execution where world state is unavailable.
 * The loop never creates a kingdom: with no readable save - or a save from a newer pack -
 * it does nothing at all.
 */

/** @type {(() => void) | undefined} */
let stopHandle = undefined;

/**
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 * @param {{ stepTicks?: number, dimensionName?: string, onStep?: (report: any) => void }} options
 */
export function startSimulationLoop(kingdomStore, options = {}) {
    if (stopHandle !== undefined) {
        return stopHandle;
    }

    const tickInterval = Number(options.stepTicks ?? SIM.stepTicks);
    const dimensionName = String(options.dimensionName ?? "overworld");

    const runId = system.runInterval(() => {
        const loaded = kingdomStore.load();
        if (loaded.kingdom === undefined) {
            return;
        }

        const advanced = advanceKingdom(loaded.kingdom, 1);
        const report = /** @type {any} */ ({ ...advanced, problem: undefined, build: undefined, buildError: undefined });
        if (report.skipped > 0) {
            // advanceKingdomStep already rolled the state back, so there is nothing to
            // persist - just surface why the hour was refused.
            report.problem = advanced.rejected.map((rejection) => rejection.problems.join("; ")).join(" | ");
            /** @type {any} */ (globalThis).console?.warn?.(`[civ] simulation hour rejected and rolled back: ${String(report.problem)}`);
            if (typeof options.onStep === "function") {
                options.onStep(report);
            }
            return;
        }
        if (report.ran === 0) {
            return;
        }

        if (isDemoEnabled(world)) {
            try {
                report.build = materialiseNextStage(world.getDimension(dimensionName), loaded.kingdom);
            } catch (error) {
                report.buildError = String(error);
            }
        }

        kingdomStore.save(loaded.kingdom);
        if (typeof options.onStep === "function") {
            options.onStep(report);
        }
    }, tickInterval);

    stopHandle = () => {
        system.clearRun(runId);
        stopHandle = undefined;
    };
    return stopHandle;
}

/**
 * Exactly one loop can exist at a time; this reports whether it is running.
 */
export function isSimulationLoopRunning() {
    return stopHandle !== undefined;
}
