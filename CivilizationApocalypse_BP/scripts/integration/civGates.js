import { newOps } from "../civ/regions.js";
import { loadSavedRunSteps } from "./civBuilder.js";
import { runJobAsync } from "./civScan.js";
import { finishJob, reserveJob } from "./districtBuilder.js";


import { system } from "@minecraft/server";
import { crossingFromWorld, linkPhysicalGates, proofCells, specOfPlanGate, unitsOfGate, validateGateLinks } from "../civ/gatelink.js";
import { findValidationProblems } from "../kingdom/state.js";
import { validateGateRecords } from "../sim/gatecontrol.js";
import { newGateRecord, readGateRecord, readGateRegistry, updateGateRegistry, writeGateRecord, writeGateRegistry } from "./gateAdapter.js";

/** Restore geometry from checksum-verified build records, oldest district first; never writes blocks.
 * @param {KingdomStore} store @param {any[]} plans
 */
export function restorePlannedGateGeometry(store, plans) {
    const refuse = (/** @type {string} */ reason) => ({ ok: false, reason, changed: 0 });
    const loaded = store.load();
    if (!loaded.kingdom) return refuse("no readable kingdom is available");
    const previous = readGateRegistry();
    const unique = [...new Map([...plans].reverse().map((gate) => [gate.id, gate])).values()];
    const linked = linkPhysicalGates(JSON.parse(JSON.stringify(loaded.kingdom)), unique, { dimension: "minecraft:overworld" });
    if (linked.warnings.length > 0) return refuse(linked.warnings.join("; "));
    if (linked.links.length !== previous.gates.length) return refuse("saved plans do not cover every registered gate");
    const entries = previous.gates.map((old) => {
        const next = linked.links.find((entry) => entry.id === old.id);
        if (!next || next.role !== old.role || next.simGateId !== old.simGateId
            || next.purpose !== old.purpose || JSON.stringify([...next.between].sort()) !== JSON.stringify([...old.between].sort())) return undefined;
        return { ...old, spec: next.spec };
    });
    if (entries.some((entry) => entry === undefined)) return refuse("saved plans conflict with a registered route");
    const replacement = { ...previous, gates: /** @type {import("../civ/gatelink.js").GateRegistry["gates"]} */ (entries) };
    if (!writeGateRegistry(replacement)) return refuse("could not save restored gate geometry");
    const result = relinkRegisteredGates(store);
    if (!result.ok && !writeGateRegistry(previous)) return refuse(`${String(result.reason)}; registry rollback failed`);
    return result;
}

/**
 * Repair the old export bug that retained the registry but dropped kingdom gate links.
 * Uses recorded geometry and positions/destinations; no terrain scan or block writes. Interrupted
 * moves keep their adapter records and resume through the normal collision-checked controller.
 * @param {KingdomStore} store
 * @returns {{ ok: boolean, reason: string | null, changed: number }}
 */
export function relinkRegisteredGates(store) {
    const entries = readGateRegistry().gates;
    const refuse = (/** @type {string} */ reason) => ({ ok: false, reason, changed: 0 });
    if (entries.length === 0) return refuse("no readable registered gate geometry is available");
    if (entries.some((entry) => !entry || typeof entry.id !== "string" || !entry.spec)) return refuse("the gate registry contains invalid geometry");
    const loaded = store.load();
    if (!loaded.kingdom) return refuse("no readable kingdom is available");
    const dimensions = new Set(entries.map((entry) => entry.spec?.dimension ?? "minecraft:overworld"));
    if (dimensions.size !== 1) return refuse("registered gates span different dimensions");
    const kingdom = JSON.parse(JSON.stringify(loaded.kingdom));
    const plans = entries.map((entry) => ({ ...entry.spec, id: entry.id, between: entry.between, purpose: entry.purpose }));
    const linked = linkPhysicalGates(kingdom, plans, { dimension: [...dimensions][0] });
    if (linked.warnings.length > 0) return refuse(linked.warnings.join("; "));
    // A registry mismatch is not permission to reinterpret a gate as a different route.
    for (const entry of entries) {
        const next = linked.links.find((link) => link.id === entry.id);
        if (!next || next.role !== entry.role || next.simGateId !== entry.simGateId) {
            return refuse(`registry route for ${entry.id} does not match the kingdom`);
        }
    }
    for (const district of kingdom.districts) {
        for (const gate of district.gates ?? []) {
            const units = unitsOfGate(gate);
            if (units.length === 0) continue;
            const records = units.map((unit) => readGateRecord(unit.id));
            const unsettled = records.findIndex((record) => !record || !["open", "closed", "partial"].includes(record.actual)
                || (record.to != null && !["open", "closed"].includes(record.to)) || (record.actual === "partial" && record.to == null));
            if (unsettled >= 0) {
                const record = records[unsettled];
                return refuse(`gate ${gate.id}, unit ${units[unsettled].id}: ${record ? `position ${record.actual}, destination ${String(record.to)}` : "position record missing or unreadable"}; inspect the real gateway before repair`);
            }
            const pending = records.map((record) => record?.to).filter((to) => to != null);
            // Units move in sequence: a companion with no destination can still be waiting its
            // turn behind the primary. Pending destinations govern the whole linked group.
            const destinations = new Set(pending.length > 0 ? pending : records.map((record) => record?.actual));
            if (destinations.size !== 1) return refuse(`gate ${gate.id} has companions with conflicting destinations`);
            const allClosed = records.every((record) => record?.actual === "closed");
            // A partly moved group is not a sealed route. The adapter retains every row marker and
            // validates real blocks before resuming; do not clear or recreate those records here.
            gate.physical.state = allClosed ? "closed" : "open";
            if (records.some((record) => record?.to != null)) {
                gate.physical.target = [...destinations][0];
            }
            if (gate.state !== "broken") gate.state = gate.physical.state === "closed" ? "sealed" : "open";
        }
    }
    const problems = [...findValidationProblems(kingdom), ...validateGateRecords(kingdom), ...validateGateLinks(kingdom)];
    if (problems.length > 0) return refuse(problems.slice(0, 3).join("; "));
    try {
        if (JSON.stringify(kingdom) !== JSON.stringify(loaded.kingdom)) store.save(kingdom);
    } catch (error) {
        return refuse(`could not save repaired links: ${String(error)}`);
    }
    return { ok: true, reason: null, changed: linked.changes.length };
}

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
    // A neighboring survey sees the existing gatehouse roof instead of the original terrain.
    // Its plan may therefore suggest a different walking height, while protected construction
    // correctly leaves the old blocks untouched. Keep the first registered geometry and every
    // companion; replacing the controller's coordinates would make a working gate foreign.
    const previous = readGateRegistry().gates;
    const known = new Map(previous.map((entry) => [entry.id, entry]));
    for (const gate of gates) {
        const old = known.get(gate.id);
        if (old === undefined) continue;
        const next = specOfPlanGate(gate, { dimension: dimensionId });
        if (next.link === undefined || JSON.stringify([...old.between].sort()) !== JSON.stringify([...next.link.between].sort())
            || old.purpose !== next.link.purpose || (old.spec.dimension ?? "minecraft:overworld") !== dimensionId) {
            return { ok: false, reason: `registered gate ${String(gate.id)} has a conflicting route or dimension`, changes: [], warnings: [], links: [], created: [] };
        }
    }
    const retained = previous.map((entry) => ({ ...entry.spec, id: entry.id, between: entry.between, purpose: entry.purpose }));
    const result = linkPhysicalGates(kingdom, [...retained, ...gates.filter((gate) => !known.has(gate.id))], { dimension: dimensionId });
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
const SELF_TEST = Object.freeze({ readsPerSlice: 400, moveTimeoutTicks: 6000, heights: [1, 2, 3] });

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
 * @param {boolean} [prepared] internal: the diagnostic already owns its loading lease
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function startGateSelfTest(adapter, store, gateId, done, prepared = false) {
    if (!prepared && adapter.isHeld(gateId)) return { ok: false, reason: "a self test is already running for this gate" };
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
    if (!prepared) {
        const lease = adapter.loadForInspection(gateId);
        if (lease) {
            adapter.hold(gateId);
            system.runJob((function* () {
                try {
                    let state = lease.status();
                    while (state.state === "loading") { yield; state = lease.status(); }
                    if (state.state === "failed") {
                        done({ pass: false, lines: [`RESULT: FAIL (${state.reason})`] });
                        return;
                    }
                    let finished = false;
                    const result = startGateSelfTest(adapter, store, gateId, (report) => { finished = true; done(report); }, true);
                    if (!result.ok) { done({ pass: false, lines: [`Gate self test refused: ${result.reason}`] }); return; }
                    while (!finished) yield;
                } finally { lease.release(); adapter.release(gateId); }
            })());
            return { ok: true, reason: null };
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
        const started = system.currentTick;
        let lastRequestTick = started;
        let outcome = adapter.request(gateId, to, { test: true });
        while (outcome.status === "blocked" && system.currentTick - started < 200) {
            yield;
            if (system.currentTick === lastRequestTick) continue;
            lastRequestTick = system.currentTick;
            outcome = adapter.request(gateId, to, { test: true });
        }
        if (!outcome.ok) {
            return String(outcome.reason);
        }
        // runJob may resume this generator thousands of times within ONE tick.
        // Yields are work slices, not elapsed time; let the independently scheduled
        // gate job and its tick-based row delay actually run before timing out.
        while (adapter.isRunning(gateId) && system.currentTick - started < SELF_TEST.moveTimeoutTicks) {
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
                    const result = crossingFromWorld(unit.spec, ids, { height, squeeze, trace: expect === "sealed" });
                    checks += 1;
                    if (result.unloaded > 0) {
                        failures.push(`${String(unit.id)}: ${String(result.unloaded)} cell(s) not loaded`);
                    } else if (expect === "sealed" && result.crosses) {
                        const through = (result.path ?? []).filter((point) => Math.abs(unit.spec.axis === "x" ? point.z - unit.spec.at.z : point.x - unit.spec.at.x) <= 1).slice(0, 3);
                        const route = through.map((point) => `(${String(point.x)},${String(point.y)},${String(point.z)})`).join(" -> ");
                        failures.push(`${String(unit.id)}: a 1x${String(height)} walker${squeeze ? " (squeezing diagonals)" : ""} gets through${route ? ` via ${route}` : ""}`);
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


/** Rebuild original gate measurements from verified stored inputs; no terrain or block writes.
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} store
 * @param {(lines: string[]) => void} say
 */
export async function restoreSavedGateLinks(store, say) {
    const token = reserveJob("civ-gate-restore");
    if (token === undefined) { say(["Gate recovery refused: another construction or recovery job is running."]); return; }
    try {
        const loaded = store.load();
        if (!loaded.kingdom) { say(["Gate recovery refused: no readable kingdom."]); return; }
        const districts = /** @type {any[]} */ (loaded.kingdom.districts).filter((district) => district.civ?.status === "complete")
            .sort((a, b) => Number(a.seat) - Number(b.seat));
        if (districts.length === 0) { say(["Gate recovery refused: no completed saved district plans."]); return; }
        /** @type {any[]} */
        const gates = [];
        for (const district of districts) {
            say([`Checking ${district.name}'s saved plan and checksum before gate recovery...`]);
            const restored = await runJobAsync(token, loadSavedRunSteps(district.civ, newOps(), Number(district.seat)));
            if (token.cancelled) { say(["Gate recovery stopped. No links were changed."]); return; }
            if (!restored?.ok) { say(["Gate recovery refused. No links were changed.", ...(restored?.reasons ?? ["stored plan unavailable"])]); return; }
            gates.push(...restored.record.gates);
        }
        const result = restorePlannedGateGeometry(store, gates);
        say(result.ok ? [`Saved gate geometry restored: ${String(result.changed)} link change(s). No blocks were rebuilt.`, "Run gate_status and gate_test to verify the real openings."]
            : [`Gate recovery refused: ${String(result.reason)}`]);
    } catch (error) {
        say([`Gate recovery failed: ${String(error)}`]);
    } finally {
        finishJob(token);
    }
}
