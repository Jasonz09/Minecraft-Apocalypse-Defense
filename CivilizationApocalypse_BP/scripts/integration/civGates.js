import { system } from "@minecraft/server";
import { crossingFromWorld, linkPhysicalGates, proofCells, validateGateLinks } from "../civ/gatelink.js";
import { findValidationProblems } from "../kingdom/state.js";
import { validateGateRecords } from "../sim/gatecontrol.js";
import { newGateRecord, readGateRecord, updateGateRegistry, writeGateRecord } from "./gateAdapter.js";

/**
 * Runtime glue between the civilization builder and the gate system.
 *
 *   registerBuiltGates(store, siteRecordOrGateList, dimensionId)
 *       Called by the civ builder AFTER its `gates` stage finished (the gatehouses stand, every gateway open).
 *       Maps the plan's physical gates onto the simulation's gate records (civ/gatelink.js), persists the links
 *       through the kingdom store (re-load, patch, save; the kingdom is never held across a yield), writes the gate
 *       registry and creates the adapter's `civ_gate_<id>` record for every unit (state OPEN). Idempotent: calling it
 *       again after a resume changes nothing and never resets a gate that has since moved.
 *
 *   startGateSelfTest(adapter, store, gateId, done)
 *       The `civ:gate_test` engine: close -> verify sealed -> reopen -> verify passable, as a job, with a PASS/FAIL
 *       line per phase. See the function for the safety rules.
 *
 * The world-load resume needs no call from here: `registerGateCommands` (commands/gates.js) starts the adapter,
 * whose first pump finishes any half-moved gate from its persisted records.
 *
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("./gateAdapter.js").GateAdapter} GateAdapter
 */

/**
 * @param {KingdomStore} store
 * @param {any} siteRecordOrGateList a site record ({ gates: [...] }) or the gate list itself
 * @param {string} [dimensionId]
 * @returns {{ ok: boolean, reason: string | null, changes: import("../civ/gatelink.js").LinkChange[], warnings: string[], links: import("../civ/gatelink.js").GateLink[], created: string[] }}
 */
export function registerBuiltGates(store, siteRecordOrGateList, dimensionId = "minecraft:overworld") {
    const gates = Array.isArray(siteRecordOrGateList) ? siteRecordOrGateList : siteRecordOrGateList?.gates;
    if (!Array.isArray(gates)) {
        return { ok: false, reason: "no gate list in the site record", changes: [], warnings: [], links: [], created: [] };
    }
    const loaded = store.load();
    if (!loaded.kingdom) {
        return { ok: false, reason: `no kingdom to link gates to (${String(loaded.reason ?? loaded.status)})`, changes: [], warnings: [], links: [], created: [] };
    }
    const kingdom = loaded.kingdom;
    const before = new Set([...findValidationProblems(kingdom), ...validateGateRecords(kingdom), ...validateGateLinks(kingdom)]);
    const result = linkPhysicalGates(kingdom, gates, { dimension: dimensionId });
    const introduced = [...findValidationProblems(kingdom), ...validateGateRecords(kingdom), ...validateGateLinks(kingdom)].filter((problem) => !before.has(problem));
    if (introduced.length > 0) {
        return { ok: false, reason: `linking would make the kingdom invalid: ${introduced.slice(0, 3).join("; ")}`, changes: [], warnings: result.warnings, links: result.links, created: [] };
    }
    if (result.changes.length > 0) {
        try {
            store.save(kingdom);
        } catch (error) {
            return { ok: false, reason: `could not save the kingdom: ${String(error)}`, changes: [], warnings: result.warnings, links: result.links, created: [] };
        }
    }
    const registry = updateGateRegistry(result.links);
    /** @type {string[]} */
    const created = [];
    for (const link of result.links) {
        const unitId = link.role === "primary" && link.simGateId !== null ? link.simGateId : link.id;
        if (readGateRecord(unitId) === undefined) {
            writeGateRecord(newGateRecord(unitId, "open"));
            created.push(unitId);
        }
    }
    return { ok: registry.ok, reason: registry.ok ? null : "could not save the gate registry", changes: result.changes, warnings: result.warnings, links: result.links, created };
}

/**
 * Pure: do the three copies of a gate's state agree? Used by civ:gate_status and the tests.
 *
 * @param {{ state: string, target?: string }} kingdomPhysical gate.physical from the kingdom
 * @param {{ id: string, record?: { actual: string } | undefined, lattice?: { state: string } | undefined }[]} units
 * @returns {{ agree: boolean, moving: boolean, problems: string[] }}
 */
export function describeAgreement(kingdomPhysical, units) {
    /** @type {string[]} */
    const problems = [];
    const moving = kingdomPhysical.target !== undefined && kingdomPhysical.target !== kingdomPhysical.state;
    for (const unit of units) {
        const recorded = unit.record?.actual;
        const blocks = unit.lattice?.state;
        if (recorded === undefined) {
            problems.push(`${unit.id}: no adapter record (civ_gate_${unit.id})`);
        } else if (recorded === "partial") {
            problems.push(`${unit.id}: the adapter record says a move was interrupted (it resumes by itself)`);
        } else if (!moving && recorded !== kingdomPhysical.state) {
            problems.push(`${unit.id}: kingdom says ${kingdomPhysical.state} but the adapter record says ${recorded}`);
        }
        if (blocks === undefined) {
            problems.push(`${unit.id}: blocks could not be read`);
        } else if (blocks === "unloaded") {
            problems.push(`${unit.id}: the chunk is not loaded, blocks not verified`);
        } else if (blocks === "foreign" || blocks === "partial") {
            problems.push(`${unit.id}: blocks are ${blocks}`);
        } else if (!moving && recorded !== undefined && recorded !== "partial" && blocks !== recorded) {
            problems.push(`${unit.id}: adapter record says ${recorded} but the blocks are ${blocks}`);
        }
    }
    return { agree: problems.length === 0, moving, problems };
}

/** LOCAL tunables of the self test. */
const SELF_TEST = Object.freeze({ readsPerSlice: 400, moveTimeoutSlices: 6000, heights: [1, 2, 3] });

/**
 * Start a gate self test. Synchronous part: every refusal. Then a system.runJob does the work and calls `done` with
 * the report lines (and `pass`).
 *
 * Safety: the test refuses unless the gate is idle (no pending order, not moving, not broken), every unit is
 * cleanly open or cleanly closed in the real blocks and agrees with the others, the chunks are loaded and NO entity
 * stands in any clearance box. It only moves the gate through the normal adapter (own cells only, foreign blocks
 * never overwritten, entities re-checked before every row), keeps the periodic pump away while it runs, tells the
 * simulation nothing, and ALWAYS tries to put the gate back to the state it started in. If that restore cannot
 * finish (a villager wandered in) the failure is reported and the pump finishes the restore as soon as it is clear.
 *
 * @param {GateAdapter} adapter
 * @param {KingdomStore} store
 * @param {string} gateId simulation gate id or unmanaged plan id
 * @param {(report: { pass: boolean, lines: string[] }) => void} done
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function startGateSelfTest(adapter, store, gateId, done) {
    const first = adapter.inspect(gateId);
    if (!first.ok) {
        return { ok: false, reason: String(first.error) };
    }
    if (adapter.isRunning(gateId)) {
        return { ok: false, reason: "the gate is moving right now; wait for it to finish" };
    }
    if (first.managed) {
        const loaded = store.load();
        const found = loaded.kingdom ? findGateRecord(loaded.kingdom, gateId) : undefined;
        if (found === undefined) {
            return { ok: false, reason: "the kingdom could not be read" };
        }
        if (found.state === "broken") {
            return { ok: false, reason: "the gate is broken; repair it first" };
        }
        if (found.physical?.target !== undefined) {
            return { ok: false, reason: `an order to ${String(found.physical.target)} is pending; let it finish (or civ:gate_auto) first` };
        }
    }
    const units = /** @type {any[]} */ (first.units);
    for (const unit of units) {
        const state = unit.lattice?.state;
        if (state === undefined || state === "unloaded") {
            return { ok: false, reason: `the chunk around ${String(unit.id)} is not loaded (stand near the gate)` };
        }
        if (state !== "open" && state !== "closed") {
            return { ok: false, reason: `${String(unit.id)}: the portcullis is ${String(state)}${unit.lattice.firstForeign ? ` (${String(unit.lattice.firstForeign)})` : ""}; the self test only starts from a clean open or closed gate` };
        }
        if (unit.blockers.length > 0) {
            return { ok: false, reason: `${String(unit.blockers.length)} ${unit.blockers.length === 1 ? "entity is" : "entities are"} in the gateway of ${String(unit.id)} (${unit.blockers.slice(0, 3).map((/** @type {any} */ entry) => String(entry.name)).join(", ")}); clear it first` };
        }
    }
    const original = /** @type {"open" | "closed"} */ (units[0].lattice.state);
    if (units.some((unit) => unit.lattice.state !== original)) {
        return { ok: false, reason: `the gates of this record disagree (${units.map((unit) => `${String(unit.id)} ${String(unit.lattice.state)}`).join(", ")}); fix that first` };
    }
    adapter.hold(gateId);
    system.runJob(selfTestJob(adapter, gateId, original, done));
    return { ok: true, reason: null };
}

/**
 * @param {any} kingdom
 * @param {string} gateId
 */
function findGateRecord(kingdom, gateId) {
    for (const district of Array.isArray(kingdom?.districts) ? kingdom.districts : []) {
        for (const gate of Array.isArray(district?.gates) ? district.gates : []) {
            if (gate?.id === gateId) {
                return gate;
            }
        }
    }
    return undefined;
}

/**
 * @param {GateAdapter} adapter
 * @param {string} gateId
 * @param {"open" | "closed"} original
 * @param {(report: { pass: boolean, lines: string[] }) => void} done
 */
function* selfTestJob(adapter, gateId, original, done) {
    /** @type {string[]} */
    const lines = [`=== Gate self test: ${gateId} ===`];
    let pass = true;
    /** @param {string} name @param {boolean} ok @param {string} detail */
    const phase = (name, ok, detail) => {
        lines.push(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
        if (!ok) {
            pass = false;
        }
    };
    const other = original === "open" ? "closed" : "open";

    /**
     * Move to `to` through the adapter and wait for it. Returns an error text, or null on success.
     * @param {"open" | "closed"} to
     */
    function* moveTo(to) {
        let slices = 0;
        let outcome = adapter.request(gateId, to, { test: true });
        while (outcome.status === "blocked" && slices < 200) {
            slices += 1;
            yield;
            outcome = adapter.request(gateId, to, { test: true });
        }
        if (!outcome.ok) {
            return String(outcome.reason);
        }
        while (adapter.isRunning(gateId) && slices < SELF_TEST.moveTimeoutSlices) {
            slices += 1;
            yield;
        }
        if (adapter.isRunning(gateId)) {
            adapter.abort(gateId);
            return "the move did not finish in time";
        }
        const now = adapter.inspect(gateId);
        const bad = /** @type {any[]} */ (now.units).filter((unit) => unit.lattice?.state !== to);
        if (bad.length > 0) {
            const record = adapter.describe(gateId).record;
            return `${bad.map((unit) => `${String(unit.id)} is ${String(unit.lattice?.state)}`).join(", ")}${record?.reason ? ` (${String(record.reason)})` : ""}`;
        }
        return null;
    }

    /**
     * Read-only crossing proof on the REAL blocks of every unit.
     * @param {"sealed" | "passable"} expect
     */
    function* proof(expect) {
        const now = adapter.inspect(gateId);
        /** @type {string[]} */
        const failures = [];
        let checks = 0;
        for (const unit of /** @type {any[]} */ (now.units)) {
            const ids = new Map();
            const cells = proofCells(unit.spec);
            for (let i = 0; i < cells.length; i += 1) {
                const cell = /** @type {{ x: number, y: number, z: number }} */ (cells[i]);
                ids.set(`${String(cell.x)},${String(cell.y)},${String(cell.z)}`, unit.read(cell.x, cell.y, cell.z));
                if ((i + 1) % SELF_TEST.readsPerSlice === 0) {
                    yield;
                }
            }
            for (const height of SELF_TEST.heights) {
                for (const squeeze of [true, false]) {
                    const result = crossingFromWorld(unit.spec, ids, { height, squeeze });
                    checks += 1;
                    if (result.unloaded > 0) {
                        failures.push(`${String(unit.id)}: ${String(result.unloaded)} cell(s) not loaded`);
                    } else if (expect === "sealed" && result.crosses) {
                        failures.push(`${String(unit.id)}: a 1x${String(height)} walker${squeeze ? " (squeezing diagonals)" : ""} gets through`);
                    } else if (expect === "passable" && !result.crosses) {
                        failures.push(`${String(unit.id)}: a 1x${String(height)} walker${squeeze ? "" : " (no corner cutting)"} cannot get through`);
                    }
                }
            }
        }
        return { failures, checks };
    }

    try {
        const names = other === "closed" ? { move: "close", state: "sealed", expect: /** @type {const} */ ("sealed") } : { move: "open", state: "passable", expect: /** @type {const} */ ("passable") };
        const back = original === "closed" ? { move: "re-close", state: "sealed", expect: /** @type {const} */ ("sealed") } : { move: "reopen", state: "passable", expect: /** @type {const} */ ("passable") };

        const firstError = yield* moveTo(other);
        phase(`1 ${names.move}`, firstError === null, firstError ?? `every unit is ${other}`);
        if (firstError === null) {
            const result = yield* proof(names.expect);
            phase(`2 ${names.state} (real blocks, 1x1/1x2/1x3 walkers)`, result.failures.length === 0, result.failures.length === 0 ? `${String(result.checks)} crossing checks as expected` : result.failures.slice(0, 3).join("; "));
        } else {
            lines.push("SKIP  2 verify: the gate did not move");
        }
        const backError = yield* moveTo(original);
        phase(`3 ${back.move}`, backError === null, backError ?? `every unit is ${original} again`);
        if (backError === null) {
            const result = yield* proof(back.expect);
            phase(`4 ${back.state} (real blocks, 1x1/1x2/1x3 walkers)`, result.failures.length === 0, result.failures.length === 0 ? `${String(result.checks)} crossing checks as expected` : result.failures.slice(0, 3).join("; "));
        } else {
            lines.push("SKIP  4 verify: the gate was not restored");
            lines.push(`The gate stays ${original} in the kingdom; the periodic pump finishes the restore as soon as the blockage clears.`);
        }
    } catch (error) {
        pass = false;
        lines.push(`FAIL  unexpected error: ${String(error)}`);
    } finally {
        adapter.retryNow(gateId);
        adapter.release(gateId);
    }
    lines.push(pass ? `RESULT: PASS (the gate is ${original}, as it was)` : "RESULT: FAIL (see the lines above)");
    done({ pass, lines });
}

