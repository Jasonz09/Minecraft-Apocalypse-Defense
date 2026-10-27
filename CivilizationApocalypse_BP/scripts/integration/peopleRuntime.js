import { system, world } from "@minecraft/server";
import { peopleGateOn, peopleStatusLines } from "../people/gate.js";
import { isBusy } from "./districtBuilder.js";

/**
 * The one door between the hourly kingdom simulation and the living world: it owns the people gate and
 * runs the world's people drivers once per accepted hour. Before it existed, `integration/popSync.js` and
 * the whole `people/` + `population/` island were complete and tested offline but nothing ever constructed
 * them, so the pack spawned no entity of any kind.
 *
 * Contract:
 *  - Off by default, and off means empty streets: with the gate off the drivers are still called once an
 *    hour so they can remove what they own, because 2.7.0 has no removal event to clean up after.
 *  - A driver runs only while the gate is on AND no civilization build holds the world. The build owns the
 *    ticking areas and the per-tick slice budget, and a street being rebuilt under a walker is not a
 *    condition this pack will chase.
 *  - A driver that throws is counted and skipped: the simulation loop must survive it.
 *  - Nothing is read or written at module scope - Script API v2 runs scripts in early execution.
 *
 * @typedef {Object} PeopleContext
 * @property {any} kingdom the saved kingdom as of this hour; drivers must not change it
 * @property {any} report the hour's `advanceKingdom` report
 * @property {any} dimension the overworld `Dimension`
 * @property {any} world
 * @property {number} tick `system.currentTick`
 * @property {boolean} gateOn the people gate as the runtime read it; false means "tear down", never "spawn"
 *
 * @typedef {Object} PeopleDriver
 * @property {string} id names the driver in `civ:people status`
 * @property {(ctx: PeopleContext) => (number | void)} onHour its bounded work for one hour, returning how
 *   many entities it created or removed (nothing or 0 when the hour changed none)
 *
 * @typedef {{ hours: number, changed: number, errors: number, lastError: string | undefined }} DriverStats
 */

/**
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 */
export function createPeopleRuntime(kingdomStore) {
    /** @type {PeopleDriver[]} */
    const drivers = [];
    /** @type {Map<string, DriverStats>} */
    const seen = new Map();
    /**
     * @typedef {{ hours: number, teardownHours: number, refusedBusy: number, errors: number, lastError: string | undefined }} RuntimeStats
     * @type {RuntimeStats}
     */
    const stats = { hours: 0, teardownHours: 0, refusedBusy: 0, errors: 0, lastError: undefined };

    /** @param {string} id @returns {DriverStats} */
    const statsOf = (id) => {
        let entry = seen.get(id);
        if (entry === undefined) {
            entry = { hours: 0, changed: 0, errors: 0, lastError: undefined };
            seen.set(id, entry);
        }
        return entry;
    };

    /**
     * Add a driver. Registration order is run order, and it is explicit at the call site in main.js so
     * that what touches a live world stays visible in one file.
     * @param {PeopleDriver} driver
     * @returns {boolean} false when a driver with that id is already registered
     */
    function register(driver) {
        if (driver === null || typeof driver !== "object" || typeof driver.id !== "string" || typeof driver.onHour !== "function") {
            throw new TypeError("a people driver needs an id and an onHour(ctx) function");
        }
        if (drivers.some((other) => other.id === driver.id)) {
            return false;
        }
        drivers.push(driver);
        statsOf(driver.id);
        return true;
    }

    /**
     * One accepted simulation hour. Called by the loop's `onStep`, so it runs at most once per in-game
     * hour and never on a rejected one.
     *
     * The gate does NOT stop the call. "Off" has to mean "no people entities in this world", and 2.7.0
     * gives no removal event to clean up after (entityRemove reports an id, not a handle), so the only way
     * an off gate can be true is for each driver to get the hour and do its own teardown pass. A driver
     * that ignores its `ctx.gateOn` check and spawns anyway is a bug in that driver, not a licence here.
     * @param {any} report
     */
    function onStep(report) {
        if (drivers.length === 0) {
            // Nothing is wired yet: an unmodified pack does no world work at all, gate or no gate.
            return;
        }
        if (isBusy()) {
            stats.refusedBusy += 1;
            return;
        }
        const gateOn = peopleGateOn(world);
        if (!gateOn) {
            stats.teardownHours += 1;
        }
        const loaded = kingdomStore.load();
        if (loaded.kingdom === undefined) {
            return;
        }
        let dimension;
        try {
            dimension = world.getDimension("overworld");
        } catch (error) {
            stats.errors += 1;
            stats.lastError = `the overworld could not be read: ${String(error)}`;
            return;
        }
        if (dimension === undefined || dimension === null) {
            return;
        }
        const ctx = { kingdom: loaded.kingdom, report, dimension, world, tick: system.currentTick, gateOn };
        stats.hours += 1;
        for (const driver of drivers) {
            const entry = statsOf(driver.id);
            entry.hours += 1;
            try {
                const changed = driver.onHour(ctx);
                if (typeof changed === "number" && Number.isFinite(changed) && changed > 0) {
                    entry.changed += Math.floor(changed);
                }
            } catch (error) {
                entry.errors += 1;
                entry.lastError = String(error);
                stats.errors += 1;
                stats.lastError = `${driver.id}: ${String(error)}`;
            }
        }
    }

    /** What `civ:people` answers with: the gate, and what the drivers have actually done. */
    function statusLines() {
        const lines = peopleStatusLines(world, isBusy());
        lines.push(`Hours run: ${String(stats.hours)} (${String(stats.teardownHours)} with the gate off, cleaning up), ${String(stats.refusedBusy)} skipped during a district build, ${String(stats.errors)} error(s).`);
        if (drivers.length === 0) {
            lines.push("No driver is registered, so an on gate still spawns nothing.");
        }
        for (const driver of drivers) {
            const entry = statsOf(driver.id);
            lines.push(`  ${driver.id}: ${String(entry.hours)} hour(s), ${String(entry.changed)} entity change(s)${entry.lastError === undefined ? "" : `, last error ${entry.lastError}`}`);
        }
        if (stats.lastError !== undefined) {
            lines.push(`Last error: ${stats.lastError}`);
        }
        return lines;
    }

    return { register, onStep, statusLines, stats };
}
