import { BlockPermutation, system, world } from "@minecraft/server";
import { GATE, blockersInClearance, classifyExisting, entityClearanceBox, normalizeSpec, transition } from "../civ/gates.js";
import { latticeState, mergeRegistry, unitsOfGate, unmanagedWanted } from "../civ/gatelink.js";
import { findGate, listGates, recordPhysicalBlocked, recordPhysicalResult } from "../sim/gatecontrol.js";

/**
 * Bedrock boundary for physical gates: turns "this gate should be closed/open" into a bounded, resumable,
 * idempotent sequence of block writes. All geometry and every "may I write here?" decision lives in civ/gates.js
 * (pure); this file only reads the world, asks classifyExisting(), and writes.
 *
 * Safety contract
 *   - A gate only ever writes its OWN cells: toggled portcullis/seal/lever cells. Every write is preceded by a
 *     fresh read and classifyExisting(): air or our own block is replaced, the planned block is left alone, anything
 *     else ("foreign": a player's block, a chest, a sign) is NEVER overwritten.
 *   - Closing is refused while a foreign block sits in a cell it needs (it would leave a hole), and while any
 *     player, mob or villager is inside the clearance box (nothing is trapped or crushed). It is re-checked before
 *     EVERY row, so a villager who wanders in mid-closing stops the portcullis where it is. The reason is stored
 *     (gate.physical.blocked, shown by civ:gate_list) and the change is retried with back-off.
 *   - Opening never fails on entities. Foreign blocks in its cells are left where they are and counted.
 *   - Idempotent: a cell already holding the planned block is skipped, so re-running or resuming writes nothing twice.
 *   - Work is a system.runJob generator: PER_SLICE ops then yield, one row at a time with a short delay between rows
 *     so the portcullis visibly moves. No Block reference is held across a yield.
 *   - Unloaded chunks are waited for (bounded) and reported, never guessed at.
 *
 * Units. A simulation gate record is moved as one or more UNITS (civ/gatelink.js unitsOfGate): the primary physical
 * gate (keyed by the record id) and any companions (keyed by their plan id) that the site plan placed on the same
 * district pair. All units of a record move together and the kingdom hears about the result only when EVERY unit has
 * arrived. Gates the simulation does not know (outer/field gates) are UNMANAGED units listed in the gate registry
 * (world property 'civ_gatereg'); they stay open unless a command forced them closed.
 *
 * Persisted state (small records; none of it goes into the 32 KB kingdom blob except the tiny gate.physical fields):
 *   kingdom   gate.physical = { state:'open'|'closed', target?:'open'|'closed', blocked?:string, spec?, link?, companions? }
 *               state   = last COMPLETED physical state (the logical gate.state follows it)
 *               target  = requested state (sim/gatecontrol.js writes it); cleared on completion
 *               spec    = { at:{x,z}, axis:'x'|'z', y, dimension? } optional; see GateSpec in civ/gates.js
 *   world dynamic property 'civ_gate_<unitId>' (JSON, < 300 bytes), one per unit
 *               { v:1, id, actual:'open'|'closed'|'partial', to:'open'|'closed'|null, rows:number,
 *                 attempts:number, retryAt:number, reason:string|null }
 *               actual 'partial' = a transition was interrupted; it is resumed (not restarted blind). The marker is
 *               written BEFORE the first block of a move, so a crash between two writes can never lose a half-moved gate.
 *               The back-off fields (attempts, retryAt, reason) of a record live on its primary unit.
 *   world dynamic property 'civ_gatereg'   registry of linked physical gates (civ/gatelink.js mergeRegistry)
 *
 * Restart. Nothing but these records survives a reload; start()/pump() rebuild all work from them. A back-off
 * stamped in a previous session (system.currentTick restarts at 0) is recognised as stale and dropped.
 *
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("../civ/gates.js").GateSpec & { dimension?: string }} RuntimeGateSpec
 * @typedef {{ v: number, id: string, actual: "open" | "closed" | "partial", to: "open" | "closed" | null, rows: number, attempts: number, retryAt: number, reason: string | null }} GateRecord
 * @typedef {{ ok: boolean, status: "done" | "running" | "blocked" | "unchanged" | "refused", reason: string | null }} RequestResult
 * @typedef {{ id: string, spec: RuntimeGateSpec, primary: boolean, purpose: string }} GateUnit
 * @typedef {import("../civ/gatelink.js").GateRegistry} GateRegistry
 */

/** LOCAL tunables (config.js belongs to the integrator). */
export const GATE_RUNTIME = Object.freeze({
    opsPerSlice: 60,
    rowDelayTicks: GATE.rowDelayTicks,
    unloadedRetrySlices: 40,
    retryTicks: 100,
    maxAttempts: 30,
    pumpTicks: 40,
    maxConcurrent: 2,
    propertyPrefix: "civ_gate_",
    registryKey: "civ_gatereg",
    entityQueryPadding: 4,
});

/** Longest back-off a running session can set; anything beyond it was stamped by an earlier session. */
const MAX_BACKOFF_TICKS = GATE_RUNTIME.retryTicks * 8;

/**
 * @param {string} id
 */
function propertyKey(id) {
    return `${GATE_RUNTIME.propertyPrefix}${id}`;
}

/**
 * @param {string} id
 * @returns {GateRecord | undefined}
 */
export function readGateRecord(id) {
    try {
        const raw = world.getDynamicProperty(propertyKey(id));
        if (typeof raw !== "string") {
            return undefined;
        }
        const parsed = JSON.parse(raw);
        return parsed && parsed.v === 1 && parsed.id === id ? parsed : undefined;
    } catch (_error) {
        return undefined;
    }
}

/**
 * @param {GateRecord} record
 */
export function writeGateRecord(record) {
    try {
        world.setDynamicProperty(propertyKey(record.id), JSON.stringify(record));
    } catch (_error) {
        // a full property store must not abort a gate move; the kingdom copy still says where we are
    }
}

/**
 * A fresh adapter record.
 * @param {string} id
 * @param {"open" | "closed" | "partial"} actual
 * @returns {GateRecord}
 */
export function newGateRecord(id, actual) {
    return { v: 1, id, actual, to: null, rows: 0, attempts: 0, retryAt: 0, reason: null };
}

/** @returns {GateRegistry} */
export function readGateRegistry() {
    try {
        const raw = world.getDynamicProperty(GATE_RUNTIME.registryKey);
        if (typeof raw === "string") {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.v === 1 && Array.isArray(parsed.gates)) {
                return parsed;
            }
        }
    } catch (_error) {
        // unreadable registry = empty registry; registerBuiltGates rebuilds it
    }
    return { v: 1, gates: [] };
}

/**
 * @param {GateRegistry} registry
 * @returns {boolean}
 */
export function writeGateRegistry(registry) {
    try {
        world.setDynamicProperty(GATE_RUNTIME.registryKey, JSON.stringify(registry));
        return true;
    } catch (_error) {
        return false;
    }
}

/**
 * @param {"open" | "closed"} state
 * @returns {"open" | "closed"}
 */
function opposite(state) {
    return state === "open" ? "closed" : "open";
}

/**
 * Create the adapter. One per world; commands and the periodic pump share it.
 *
 * @param {KingdomStore} kingdomStore
 * @param {{ specFor?: (gateId: string, gate: any) => RuntimeGateSpec | undefined, dimensionFor?: (spec: RuntimeGateSpec) => Dimension }} [options]
 */
export function createGateAdapter(kingdomStore, options = {}) {
    /** @type {Map<string, { jobId: number | undefined, to: "open" | "closed", cancelled: boolean }>} */
    const running = new Map();
    /** @type {Map<string, string>} last human-readable outcome per gate */
    const lastOutcome = new Map();
    /** @type {Set<string>} gates under a self test: the pump leaves them alone */
    const held = new Set();
    /** @type {Set<string>} gates this session gave up on (a "give up" stamped by an earlier session is forgotten) */
    const gaveUp = new Set();
    /** @type {number | undefined} */
    let intervalId;

    /**
     * @param {string} gateId
     * @param {any} gate
     * @returns {RuntimeGateSpec | undefined}
     */
    function specOf(gateId, gate) {
        const provided = options.specFor?.(gateId, gate);
        if (provided !== undefined) {
            return provided;
        }
        const embedded = gate?.physical?.spec;
        if (embedded && embedded.at && embedded.axis) {
            return { id: gateId, ...embedded };
        }
        return undefined;
    }

    /**
     * @param {RuntimeGateSpec} spec
     * @returns {Dimension}
     */
    function dimensionOf(spec) {
        return options.dimensionFor ? options.dimensionFor(spec) : world.getDimension(spec.dimension ?? "overworld");
    }

    /**
     * Load, patch, save. Never holds the kingdom across a yield, so it cannot clobber a simulation step.
     * @param {(kingdom: any) => void} patch
     */
    function patchKingdom(patch) {
        try {
            const loaded = kingdomStore.load();
            if (!loaded.kingdom) {
                return false;
            }
            patch(loaded.kingdom);
            kingdomStore.save(loaded.kingdom);
            return true;
        } catch (_error) {
            return false;
        }
    }

    /**
     * Everything the adapter needs to move one simulation gate or one unmanaged gate.
     *
     * @param {string} gateId simulation gate id, or the plan id of an unmanaged gate
     * @returns {{ managed: boolean, units: GateUnit[], kingdomState: "open" | "closed", error?: string }}
     */
    function resolveGate(gateId) {
        const loaded = kingdomStore.load();
        const found = loaded.kingdom ? findGate(loaded.kingdom, gateId) : undefined;
        if (found) {
            if (found.gate.physical === null || typeof found.gate.physical !== "object") {
                return { managed: true, units: [], kingdomState: "open", error: `no physical gate ${gateId}` };
            }
            const kingdomState = found.gate.physical.state === "closed" ? "closed" : "open";
            /** @type {GateUnit[]} */
            const units = [];
            for (const unit of unitsOfGate(found.gate)) {
                if (unit.primary) {
                    const spec = specOf(gateId, found.gate);
                    if (spec === undefined) {
                        return { managed: true, units: [], kingdomState, error: `gate ${gateId} has no location (gate.physical.spec) in the plan` };
                    }
                    units.push({ id: gateId, spec, primary: true, purpose: unit.purpose });
                } else {
                    if (!unit.spec || !unit.spec.at || !unit.spec.axis) {
                        return { managed: true, units: [], kingdomState, error: `companion gate ${unit.id} has no location in the plan` };
                    }
                    units.push({ id: unit.id, spec: { id: unit.id, ...unit.spec }, primary: false, purpose: unit.purpose });
                }
            }
            return { managed: true, units, kingdomState };
        }
        const entry = readGateRegistry().gates.find((candidate) => candidate.id === gateId && candidate.role === "unmanaged");
        if (entry !== undefined) {
            return { managed: false, units: [{ id: entry.id, spec: { id: entry.id, ...entry.spec }, primary: true, purpose: entry.purpose }], kingdomState: "open" };
        }
        return { managed: false, units: [], kingdomState: "open", error: `no physical gate ${gateId}` };
    }

    /**
     * Entities inside, or near enough to be caught by, the clearance box.
     * @param {Dimension} dimension
     * @param {import("../civ/gates.js").GateSpec} spec
     * @returns {{ typeId: string, x: number, y: number, z: number, name: string }[]}
     */
    function entitiesInGateway(dimension, spec) {
        const box = entityClearanceBox(spec);
        const centre = { x: (box.min.x + box.max.x + 1) / 2, y: (box.min.y + box.max.y + 1) / 2, z: (box.min.z + box.max.z + 1) / 2 };
        const radius = Math.hypot(box.max.x - box.min.x + 1, box.max.y - box.min.y + 1, box.max.z - box.min.z + 1) / 2 + GATE_RUNTIME.entityQueryPadding;
        /** @type {{ typeId: string, x: number, y: number, z: number, name: string }[]} */
        const found = [];
        let entities;
        try {
            entities = dimension.getEntities({ location: centre, maxDistance: radius });
        } catch (_error) {
            // cannot see the doorway -> assume it is not clear
            return [{ typeId: "unknown", x: centre.x, y: centre.y, z: centre.z, name: "an unreadable area" }];
        }
        for (const entity of entities) {
            try {
                if (entity.isValid === false) {
                    continue;
                }
                const location = entity.location;
                found.push({ typeId: String(entity.typeId), x: location.x, y: location.y, z: location.z, name: String(entity.typeId) === "minecraft:player" ? String(/** @type {any} */ (entity).name ?? "a player") : String(entity.typeId).replace("minecraft:", "") });
            } catch (_error) {
                found.push({ typeId: "unknown", x: centre.x, y: centre.y, z: centre.z, name: "an unreadable entity" });
            }
        }
        return blockersInClearance(spec, found).map((entry) => /** @type {any} */ (entry));
    }

    /**
     * Read one cell's block type (undefined when unloaded).
     * @param {Dimension} dimension
     * @param {{ x: number, y: number, z: number }} position
     */
    function blockAt(dimension, position) {
        try {
            const block = dimension.getBlock(position);
            return block !== undefined && block.isValid !== false ? block : undefined;
        } catch (_error) {
            return undefined;
        }
    }

    /**
     * Does a block already carry the op's states? (Only ops with states need the extra look.)
     * @param {any} block
     * @param {Record<string, any> | undefined} states
     */
    function statesMatch(block, states) {
        if (states === undefined) {
            return true;
        }
        try {
            return Object.entries(states).every(([name, value]) => block.permutation.getState(name) === value);
        } catch (_error) {
            return false;
        }
    }

    /**
     * @param {{ id: string, states?: Record<string, any> }} op
     */
    function permutationFor(op) {
        try {
            return BlockPermutation.resolve(op.id, /** @type {any} */ (op.states));
        } catch (_error) {
            // a state we got wrong must not strand the gate: fall back to the plain block
            return BlockPermutation.resolve(op.id);
        }
    }

    /**
     * @param {GateRecord} record
     * @param {boolean} sessionOwned
     */
    function backoffExpired(record, sessionOwned) {
        if (record.retryAt === 0) {
            return true;
        }
        if (record.retryAt === Number.MAX_SAFE_INTEGER) {
            return !sessionOwned; // "giving up" from an earlier session is forgotten; this session's stays
        }
        return record.retryAt <= system.currentTick || record.retryAt - system.currentTick > MAX_BACKOFF_TICKS;
    }

    /**
     * Run (or resume) a transition to `to` for one gate (all its units). Returns immediately with the job's state.
     *
     * @param {string} gateId simulation gate id, or the plan id of an unmanaged gate
     * @param {"open" | "closed"} to
     * @param {{ test?: boolean }} [flags] test = a self test: no kingdom bookkeeping at all (the simulation never hears of it)
     * @returns {RequestResult}
     */
    function request(gateId, to, flags = {}) {
        const resolved = resolveGate(gateId);
        if (resolved.error !== undefined || resolved.units.length === 0) {
            return { ok: false, status: "refused", reason: resolved.error ?? `no physical gate ${gateId}` };
        }
        const managed = resolved.managed && flags.test !== true;
        const existing = running.get(gateId);
        if (existing !== undefined) {
            if (existing.to === to) {
                return { ok: true, status: "running", reason: null };
            }
            existing.cancelled = true;
            if (existing.jobId !== undefined) {
                try {
                    system.clearJob(existing.jobId);
                } catch (_error) {
                    // already finished
                }
            }
            running.delete(gateId);
        }
        if (running.size >= GATE_RUNTIME.maxConcurrent) {
            return { ok: false, status: "blocked", reason: "other gates are moving; try again in a moment" };
        }
        /** @type {{ unit: GateUnit, normal: ReturnType<typeof normalizeSpec> }[]} */
        const prepared = [];
        for (const unit of resolved.units) {
            try {
                prepared.push({ unit, normal: normalizeSpec(unit.spec) });
            } catch (error) {
                return { ok: false, status: "refused", reason: `bad gate spec: ${String(error)}` };
            }
        }

        const records = prepared.map(({ unit }) => readGateRecord(unit.id) ?? newGateRecord(unit.id, resolved.kingdomState));
        const gateRecord = /** @type {GateRecord} */ (records[0]);
        if (records.every((record) => record.actual === to)) {
            if (managed) {
                patchKingdom((kingdom) => {
                    recordPhysicalResult(kingdom, gateId, to);
                });
            }
            return { ok: true, status: "unchanged", reason: null };
        }

        const token = { jobId: /** @type {number | undefined} */ (undefined), to, cancelled: false };
        running.set(gateId, token);
        const multi = prepared.length > 1;
        const label = (/** @type {number} */ index) => (multi ? `${/** @type {any} */ (prepared[index]).unit.id}: ` : "");
        // A partial move is finished from the beginning of the same transition: finished cells are skipped as "built".
        const plans = prepared.map(({ unit }) => transition(unit.spec, opposite(to), to));
        const dimensions = prepared.map(({ unit }) => dimensionOf(unit.spec));

        /** @param {string | null} reason @param {boolean} permanent */
        const pause = (reason, permanent) => {
            gateRecord.attempts += 1;
            gateRecord.reason = reason;
            gateRecord.to = to;
            gateRecord.retryAt = system.currentTick + GATE_RUNTIME.retryTicks * Math.min(8, gateRecord.attempts);
            if (permanent || gateRecord.attempts >= GATE_RUNTIME.maxAttempts) {
                gateRecord.retryAt = Number.MAX_SAFE_INTEGER;
                gaveUp.add(gateId);
            }
            for (const record of records) {
                writeGateRecord(record);
            }
            lastOutcome.set(gateId, `${to} blocked: ${String(reason)}`);
            if (managed) {
                patchKingdom((kingdom) => {
                    recordPhysicalBlocked(kingdom, gateId, `${String(reason)}${gateRecord.retryAt === Number.MAX_SAFE_INTEGER ? " - giving up, re-issue the command" : ""}`);
                });
            }
            running.delete(gateId);
        };

        function* job() {
            try {
                // 0. Closing a multi-unit gate: nobody may stand in ANY of the gateways before the first one moves.
                if (to === "closed" && multi) {
                    for (let index = 0; index < prepared.length; index += 1) {
                        const blockers = entitiesInGateway(/** @type {Dimension} */ (dimensions[index]), /** @type {any} */ (prepared[index]).unit.spec);
                        if (blockers.length > 0) {
                            pause(`${label(index)}${String(blockers.length)} ${blockers.length === 1 ? "entity is" : "entities are"} in the gateway (${blockers.slice(0, 3).map((entry) => /** @type {any} */ (entry).name).join(", ")})`, false);
                            return;
                        }
                    }
                }
                // 1. Read-only survey of every cell every unit's move needs.
                let waiting = 0;
                let foreignAt = "";
                let foreignCount = 0;
                for (let u = 0; u < prepared.length; u += 1) {
                    const plan = /** @type {ReturnType<typeof transition>} */ (plans[u]);
                    const dimension = /** @type {Dimension} */ (dimensions[u]);
                    for (let i = 0; i < plan.ops.length; ) {
                        if (token.cancelled) {
                            return;
                        }
                        const op = /** @type {import("../civ/gates.js").GateOp} */ (plan.ops[i]);
                        const block = blockAt(dimension, op);
                        if (block === undefined) {
                            waiting += 1;
                            if (waiting > GATE_RUNTIME.unloadedRetrySlices) {
                                pause(`${label(u)}a chunk around the gate is not loaded`, false);
                                return;
                            }
                            yield;
                            continue;
                        }
                        waiting = 0;
                        if (op.role !== "lever" && classifyExisting(op, block.typeId) === "foreign") {
                            foreignCount += 1;
                            if (foreignAt === "") {
                                foreignAt = `${label(u)}${block.typeId.replace("minecraft:", "")} at ${String(op.x)} ${String(op.y)} ${String(op.z)}`;
                            }
                        }
                        i += 1;
                        if (i % GATE_RUNTIME.opsPerSlice === 0) {
                            yield;
                        }
                    }
                }
                if (to === "closed" && foreignCount > 0) {
                    pause(`${String(foreignCount)} cell(s) of the portcullis are occupied by other blocks (first: ${foreignAt}); remove them`, false);
                    return;
                }

                // 2. Unit by unit, row by row.
                let skipped = 0;
                let written = 0;
                for (let u = 0; u < prepared.length; u += 1) {
                    const record = /** @type {GateRecord} */ (records[u]);
                    const plan = /** @type {ReturnType<typeof transition>} */ (plans[u]);
                    const dimension = /** @type {Dimension} */ (dimensions[u]);
                    const spec = /** @type {any} */ (prepared[u]).unit.spec;
                    if (record.actual === to && multi) {
                        continue; // this unit already arrived (an earlier pass of the same move)
                    }
                    // Mark the unit BEFORE its first write: a crash between two writes must leave a resumable record.
                    record.actual = "partial";
                    record.to = to;
                    record.rows = 0;
                    writeGateRecord(record);
                    const rowsTotal = plan.steps.length;
                    for (let rowIndex = 0; rowIndex < rowsTotal; rowIndex += 1) {
                        const step = /** @type {{ row: number, ops: import("../civ/gates.js").GateOp[] }} */ (plan.steps[rowIndex]);
                        if (to === "closed" && step.row >= 0) {
                            const blockers = entitiesInGateway(dimension, spec);
                            if (blockers.length > 0) {
                                record.rows = rowIndex;
                                pause(`${label(u)}${String(blockers.length)} ${blockers.length === 1 ? "entity is" : "entities are"} in the gateway (${blockers.slice(0, 3).map((entry) => /** @type {any} */ (entry).name).join(", ")})`, false);
                                return;
                            }
                        }
                        let sliceOps = 0;
                        for (const op of step.ops) {
                            if (token.cancelled) {
                                return;
                            }
                            const block = blockAt(dimension, op);
                            if (block === undefined) {
                                record.rows = rowIndex;
                                pause(`${label(u)}a chunk around the gate unloaded mid-move`, false);
                                return;
                            }
                            const verdict = classifyExisting(op, block.typeId);
                            if (verdict === "foreign") {
                                if (to === "closed" && op.role !== "lever") {
                                    record.rows = rowIndex;
                                    pause(`${label(u)}a block appeared in the portcullis at ${String(op.x)} ${String(op.y)} ${String(op.z)} (${block.typeId.replace("minecraft:", "")})`, false);
                                    return;
                                }
                                skipped += 1;
                                continue;
                            }
                            if (verdict === "built" && statesMatch(block, op.states)) {
                                continue;
                            }
                            try {
                                block.setPermutation(permutationFor(op));
                                written += 1;
                            } catch (error) {
                                record.rows = rowIndex;
                                pause(`${label(u)}write failed at ${String(op.x)} ${String(op.y)} ${String(op.z)}: ${String(error)}`, false);
                                return;
                            }
                            sliceOps += 1;
                            if (sliceOps % GATE_RUNTIME.opsPerSlice === 0) {
                                yield;
                            }
                        }
                        record.actual = "partial";
                        record.rows = rowIndex + 1;
                        record.to = to;
                        writeGateRecord(record);
                        const wake = system.currentTick + GATE_RUNTIME.rowDelayTicks;
                        let guard = 0;
                        while (system.currentTick < wake && guard < 400) {
                            guard += 1;
                            yield;
                        }
                    }
                    // this unit arrived; the back-off fields live on the primary record, so keep them until the end
                    record.actual = to;
                    record.rows = 0;
                    record.to = null;
                    writeGateRecord(record);
                }

                // 3. Done.
                for (const record of records) {
                    record.actual = to;
                    record.to = null;
                    record.rows = 0;
                }
                gateRecord.attempts = 0;
                gateRecord.retryAt = 0;
                gateRecord.reason = null;
                gaveUp.delete(gateId);
                for (const record of records) {
                    writeGateRecord(record);
                }
                lastOutcome.set(gateId, `${to}${skipped > 0 ? ` (${String(skipped)} foreign block(s) left in place)` : ""}; ${String(written)} block(s) written`);
                if (managed) {
                    patchKingdom((kingdom) => {
                        recordPhysicalResult(kingdom, gateId, to);
                        if (skipped > 0) {
                            recordPhysicalBlocked(kingdom, gateId, `${String(skipped)} foreign block(s) left in the gateway`);
                        }
                    });
                }
                running.delete(gateId);
            } catch (error) {
                pause(`unexpected error: ${String(error)}`, false);
            }
        }

        token.jobId = system.runJob(job());
        return { ok: true, status: "running", reason: null };
    }

    /**
     * Stop whatever is running for `gateId` (if anything).
     * @param {string} gateId
     */
    function cancel(gateId) {
        const current = running.get(gateId);
        if (current === undefined) {
            return false;
        }
        current.cancelled = true;
        if (current.jobId !== undefined) {
            try {
                system.clearJob(current.jobId);
            } catch (_error) {
                // finished
            }
        }
        running.delete(gateId);
        return true;
    }

    /**
     * Look at every physical gate and start whatever the simulation has asked for (and finish interrupted moves).
     * Safe to call as often as you like; it starts at most GATE_RUNTIME.maxConcurrent jobs.
     *
     * @returns {{ started: string[], waiting: string[] }}
     */
    function pump() {
        /** @type {string[]} */
        const started = [];
        /** @type {string[]} */
        const waiting = [];
        const loaded = kingdomStore.load();
        if (loaded.kingdom) {
            for (const { gate } of listGates(loaded.kingdom)) {
                if (gate.physical === null || typeof gate.physical !== "object") {
                    continue;
                }
                const gateId = String(gate.id);
                if (held.has(gateId)) {
                    continue;
                }
                const units = unitsOfGate(gate);
                const records = units.map((unit) => readGateRecord(unit.id));
                const record = records[0];
                const kingdomState = gate.physical.state === "closed" ? "closed" : "open";
                /** @type {"open" | "closed" | undefined} */
                let wanted = gate.physical.target === "open" || gate.physical.target === "closed" ? gate.physical.target : undefined;
                if (wanted === undefined && records.some((entry) => entry !== undefined && (entry.actual === "partial" || entry.actual !== kingdomState))) {
                    wanted = kingdomState; // an interrupted (or diverged) move that is no longer wanted is walked back to the recorded state
                }
                const current = running.get(gateId);
                if (wanted === undefined) {
                    cancel(gateId);
                    continue;
                }
                if (current !== undefined && current.to === wanted) {
                    continue;
                }
                if (record !== undefined && !backoffExpired(record, gaveUp.has(gateId))) {
                    waiting.push(gateId);
                    continue;
                }
                const outcome = request(gateId, wanted);
                if (outcome.status === "running") {
                    started.push(gateId);
                } else if (outcome.status === "blocked") {
                    waiting.push(gateId);
                }
            }
        }
        // Gates the simulation does not know: open unless a command forced them closed.
        for (const entry of readGateRegistry().gates) {
            if (entry.role !== "unmanaged" || held.has(entry.id)) {
                continue;
            }
            const record = readGateRecord(entry.id);
            const wanted = unmanagedWanted(entry);
            const actual = record?.actual ?? "open";
            const current = running.get(entry.id);
            if (actual === wanted && current === undefined) {
                continue;
            }
            if (current !== undefined && current.to === wanted) {
                continue;
            }
            if (record !== undefined && !backoffExpired(record, gaveUp.has(entry.id))) {
                waiting.push(entry.id);
                continue;
            }
            const outcome = request(entry.id, wanted);
            if (outcome.status === "running") {
                started.push(entry.id);
            } else if (outcome.status === "blocked") {
                waiting.push(entry.id);
            }
        }
        return { started, waiting };
    }

    /**
     * Begin polling. Idempotent. The interval only schedules pump(); all world work happens in runJob slices.
     * The first pump runs on the first interval tick (never during early execution).
     */
    function start() {
        if (intervalId === undefined) {
            intervalId = system.runInterval(() => {
                try {
                    pump();
                } catch (_error) {
                    // a failed poll is retried on the next interval
                }
            }, GATE_RUNTIME.pumpTicks);
            // No immediate pump: start() runs during script load (early execution), where world access throws.
            // The first interval tick resumes any half-moved gate.
        }
    }

    /**
     * @param {string} gateId
     */
    function abort(gateId) {
        return cancel(gateId);
    }

    /**
     * Forget a gate's retry back-off so the next pump() tries again immediately (used by the commands).
     * @param {string} gateId
     */
    function retryNow(gateId) {
        const record = readGateRecord(gateId);
        if (record !== undefined) {
            record.retryAt = 0;
            record.attempts = 0;
            writeGateRecord(record);
        }
        gaveUp.delete(gateId);
    }

    /**
     * @param {string} gateId
     */
    function describe(gateId) {
        const record = readGateRecord(gateId);
        return {
            running: running.has(gateId),
            record,
            outcome: lastOutcome.get(gateId),
        };
    }

    /**
     * Keep the periodic pump away from a gate (a self test drives it directly).
     * @param {string} gateId
     */
    function hold(gateId) {
        held.add(gateId);
    }

    /**
     * @param {string} gateId
     */
    function release(gateId) {
        held.delete(gateId);
    }

    /**
     * Read-only look at the real blocks of a gate (every unit): lattice state, entities in the gateway, and a block
     * reader for the crossing proof. Nothing is written.
     *
     * @param {string} gateId simulation gate id, or the plan id of an unmanaged gate
     * @returns {any}
     */
    function inspect(gateId) {
        const resolved = resolveGate(gateId);
        if (resolved.error !== undefined) {
            return { ok: false, error: resolved.error, managed: resolved.managed, units: [] };
        }
        const units = resolved.units.map((unit) => {
            let dimension;
            /** @type {(x: number, y: number, z: number) => string | undefined} */
            let read = () => undefined;
            try {
                dimension = dimensionOf(unit.spec);
                const dim = dimension;
                read = (x, y, z) => blockAt(dim, { x, y, z })?.typeId;
            } catch (_error) {
                dimension = undefined;
            }
            const record = readGateRecord(unit.id);
            let lattice;
            let blockers = /** @type {{ name: string }[]} */ ([]);
            let box;
            try {
                lattice = latticeState(unit.spec, read);
                box = entityClearanceBox(unit.spec);
                blockers = dimension === undefined ? [] : entitiesInGateway(dimension, unit.spec);
            } catch (_error) {
                lattice = undefined;
            }
            return { id: unit.id, primary: unit.primary, purpose: unit.purpose, spec: unit.spec, record, lattice, blockers, box, read };
        });
        return { ok: true, error: undefined, managed: resolved.managed, kingdomState: resolved.kingdomState, units };
    }

    return { request, pump, start, abort, retryNow, describe, hold, release, inspect, isRunning: (/** @type {string} */ id) => running.has(id) };
}

/** @typedef {ReturnType<typeof createGateAdapter>} GateAdapter */

/**
 * Add or update registry entries (keeps the mode of unmanaged gates). Used by registerBuiltGates and the commands.
 * @param {import("../civ/gatelink.js").GateLink[]} links
 */
export function updateGateRegistry(links) {
    const merged = mergeRegistry(readGateRegistry(), links);
    return { ok: writeGateRegistry(merged), registry: merged };
}

/**
 * Set the mode of a gate the simulation does not know ('auto' and 'forced_open' keep it open, 'forced_closed' closes it).
 * @param {string} gateId plan id of an unmanaged gate
 * @param {string} mode
 * @returns {boolean} false when the gate is not an unmanaged registry entry or the registry could not be saved
 */
export function setUnmanagedMode(gateId, mode) {
    const registry = readGateRegistry();
    const entry = registry.gates.find((candidate) => candidate.id === gateId && candidate.role === "unmanaged");
    if (entry === undefined) {
        return false;
    }
    entry.mode = mode;
    return writeGateRegistry(registry);
}

/** @type {GateAdapter | undefined} */
let shared;

/**
 * The world's single adapter (created on first use).
 * @param {KingdomStore} kingdomStore
 * @param {Parameters<typeof createGateAdapter>[1]} [options]
 */
export function getGateAdapter(kingdomStore, options) {
    if (shared === undefined) {
        shared = createGateAdapter(kingdomStore, options);
    }
    return shared;
}

/** Test seam: drop the shared adapter. */
export function resetGateAdapter() {
    shared = undefined;
}
