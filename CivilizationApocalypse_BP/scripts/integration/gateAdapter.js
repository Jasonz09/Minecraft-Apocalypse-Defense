import { BlockPermutation, system, world } from "@minecraft/server";
import { GATE, blockersInClearance, classifyExisting, entityClearanceBox, normalizeSpec, transition } from "../civ/gates.js";
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
 * Persisted state (two small records; neither goes into the 32 KB kingdom blob except the three tiny fields):
 *   kingdom   gate.physical = { state:'open'|'closed', target?:'open'|'closed', blocked?:string, spec? }
 *               state   = last COMPLETED physical state (the logical gate.state follows it)
 *               target  = requested state (sim/gatecontrol.js writes it); cleared on completion
 *               spec    = { at:{x,z}, axis:'x'|'z', y, dimension? } optional; see GateSpec in civ/gates.js
 *   world dynamic property 'civ_gate_<gateId>' (JSON, < 300 bytes)
 *               { v:1, id, actual:'open'|'closed'|'partial', to:'open'|'closed'|null, rows:number,
 *                 attempts:number, retryAt:number, reason:string|null }
 *               actual 'partial' = a transition was interrupted; it is resumed (not restarted blind).
 *
 * @typedef {import("@minecraft/server").Dimension} Dimension
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("../civ/gates.js").GateSpec & { dimension?: string }} RuntimeGateSpec
 * @typedef {{ v: number, id: string, actual: "open" | "closed" | "partial", to: "open" | "closed" | null, rows: number, attempts: number, retryAt: number, reason: string | null }} GateRecord
 * @typedef {{ ok: boolean, status: "done" | "running" | "blocked" | "unchanged" | "refused", reason: string | null }} RequestResult
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
    entityQueryPadding: 4,
});

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
function readRecord(id) {
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
function writeRecord(record) {
    try {
        world.setDynamicProperty(propertyKey(record.id), JSON.stringify(record));
    } catch (_error) {
        // a full property store must not abort a gate move; the kingdom copy still says where we are
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
     * Run (or resume) a transition to `to` for one gate. Returns immediately with the job's state.
     *
     * @param {string} gateId
     * @param {"open" | "closed"} to
     * @returns {RequestResult}
     */
    function request(gateId, to) {
        const loaded = kingdomStore.load();
        const found = loaded.kingdom ? findGate(loaded.kingdom, gateId) : undefined;
        if (!found || found.gate.physical === null || typeof found.gate.physical !== "object") {
            return { ok: false, status: "refused", reason: `no physical gate ${gateId}` };
        }
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
        let gateSpec;
        try {
            const spec = specOf(gateId, found.gate);
            if (spec === undefined) {
                return { ok: false, status: "refused", reason: `gate ${gateId} has no location (gate.physical.spec) in the plan` };
            }
            gateSpec = { spec, normal: normalizeSpec(spec) };
        } catch (error) {
            return { ok: false, status: "refused", reason: `bad gate spec: ${String(error)}` };
        }

        const recorded = readRecord(gateId);
        const kingdomState = found.gate.physical.state === "closed" ? "closed" : "open";
        /** @type {GateRecord} */
        const record = recorded ?? { v: 1, id: gateId, actual: kingdomState, to: null, rows: 0, attempts: 0, retryAt: 0, reason: null };
        if (record.actual === to) {
            patchKingdom((kingdom) => {
                recordPhysicalResult(kingdom, gateId, to);
            });
            return { ok: true, status: "unchanged", reason: null };
        }

        const token = { jobId: /** @type {number | undefined} */ (undefined), to, cancelled: false };
        running.set(gateId, token);
        const spec = gateSpec.spec;
        const dimension = dimensionOf(spec);
        // A partial move is finished from the beginning of the same transition: finished cells are skipped as "built".
        const plan = transition(spec, opposite(to), to);
        const rowsTotal = plan.steps.length;

        /** @param {string | null} reason @param {boolean} permanent */
        const pause = (reason, permanent) => {
            record.attempts += 1;
            record.reason = reason;
            record.to = to;
            record.retryAt = system.currentTick + GATE_RUNTIME.retryTicks * Math.min(8, record.attempts);
            if (permanent || record.attempts >= GATE_RUNTIME.maxAttempts) {
                record.retryAt = Number.MAX_SAFE_INTEGER;
            }
            writeRecord(record);
            lastOutcome.set(gateId, `${to} blocked: ${String(reason)}`);
            patchKingdom((kingdom) => {
                recordPhysicalBlocked(kingdom, gateId, `${String(reason)}${record.retryAt === Number.MAX_SAFE_INTEGER ? " - giving up, re-issue the command" : ""}`);
            });
            running.delete(gateId);
        };

        function* job() {
            try {
                let waiting = 0;
                // 1. Read-only survey of every cell the move needs.
                let foreignAt = "";
                let foreignCount = 0;
                for (let i = 0; i < plan.ops.length; ) {
                    if (token.cancelled) {
                        return;
                    }
                    const op = /** @type {import("../civ/gates.js").GateOp} */ (plan.ops[i]);
                    const block = blockAt(dimension, op);
                    if (block === undefined) {
                        waiting += 1;
                        if (waiting > GATE_RUNTIME.unloadedRetrySlices) {
                            pause("a chunk around the gate is not loaded", false);
                            return;
                        }
                        yield;
                        continue;
                    }
                    waiting = 0;
                    if (op.role !== "lever" && classifyExisting(op, block.typeId) === "foreign") {
                        foreignCount += 1;
                        if (foreignAt === "") {
                            foreignAt = `${block.typeId.replace("minecraft:", "")} at ${String(op.x)} ${String(op.y)} ${String(op.z)}`;
                        }
                    }
                    i += 1;
                    if (i % GATE_RUNTIME.opsPerSlice === 0) {
                        yield;
                    }
                }
                if (to === "closed" && foreignCount > 0) {
                    pause(`${String(foreignCount)} cell(s) of the portcullis are occupied by other blocks (first: ${foreignAt}); remove them`, false);
                    return;
                }

                // 2. Row by row.
                let skipped = 0;
                let written = 0;
                for (let rowIndex = 0; rowIndex < rowsTotal; rowIndex += 1) {
                    const step = /** @type {{ row: number, ops: import("../civ/gates.js").GateOp[] }} */ (plan.steps[rowIndex]);
                    if (to === "closed" && step.row >= 0) {
                        const blockers = entitiesInGateway(dimension, spec);
                        if (blockers.length > 0) {
                            record.actual = "partial";
                            record.rows = rowIndex;
                            pause(`${String(blockers.length)} ${blockers.length === 1 ? "entity is" : "entities are"} in the gateway (${blockers.slice(0, 3).map((entry) => /** @type {any} */ (entry).name).join(", ")})`, false);
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
                            record.actual = "partial";
                            record.rows = rowIndex;
                            pause("a chunk around the gate unloaded mid-move", false);
                            return;
                        }
                        const verdict = classifyExisting(op, block.typeId);
                        if (verdict === "foreign") {
                            if (to === "closed" && op.role !== "lever") {
                                record.actual = "partial";
                                record.rows = rowIndex;
                                pause(`a block appeared in the portcullis at ${String(op.x)} ${String(op.y)} ${String(op.z)} (${block.typeId.replace("minecraft:", "")})`, false);
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
                            record.actual = "partial";
                            record.rows = rowIndex;
                            pause(`write failed at ${String(op.x)} ${String(op.y)} ${String(op.z)}: ${String(error)}`, false);
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
                    writeRecord(record);
                    const wake = system.currentTick + GATE_RUNTIME.rowDelayTicks;
                    let guard = 0;
                    while (system.currentTick < wake && guard < 400) {
                        guard += 1;
                        yield;
                    }
                }

                // 3. Done.
                record.actual = to;
                record.to = null;
                record.rows = 0;
                record.attempts = 0;
                record.retryAt = 0;
                record.reason = null;
                writeRecord(record);
                lastOutcome.set(gateId, `${to}${skipped > 0 ? ` (${String(skipped)} foreign block(s) left in place)` : ""}; ${String(written)} block(s) written`);
                patchKingdom((kingdom) => {
                    recordPhysicalResult(kingdom, gateId, to);
                    if (skipped > 0) {
                        recordPhysicalBlocked(kingdom, gateId, `${String(skipped)} foreign block(s) left in the gateway`);
                    }
                });
                running.delete(gateId);
            } catch (error) {
                pause(`unexpected error: ${String(error)}`, false);
            }
        }

        token.jobId = system.runJob(job());
        return { ok: true, status: "running", reason: null };
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
        if (!loaded.kingdom) {
            return { started, waiting };
        }
        for (const { gate } of listGates(loaded.kingdom)) {
            if (gate.physical === null || typeof gate.physical !== "object") {
                continue;
            }
            const gateId = String(gate.id);
            const record = readRecord(gateId);
            const kingdomState = gate.physical.state === "closed" ? "closed" : "open";
            /** @type {"open" | "closed" | undefined} */
            let wanted = gate.physical.target === "open" || gate.physical.target === "closed" ? gate.physical.target : undefined;
            if (wanted === undefined && record?.actual === "partial") {
                wanted = kingdomState; // an interrupted move that is no longer wanted is walked back
            }
            const current = running.get(gateId);
            if (wanted === undefined) {
                if (current !== undefined) {
                    current.cancelled = true;
                    if (current.jobId !== undefined) {
                        try {
                            system.clearJob(current.jobId);
                        } catch (_error) {
                            // finished
                        }
                    }
                    running.delete(gateId);
                }
                continue;
            }
            if (current !== undefined && current.to === wanted) {
                continue;
            }
            if (record !== undefined && record.retryAt > system.currentTick) {
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
        return { started, waiting };
    }

    /**
     * Begin polling. Idempotent. The interval only schedules pump(); all world work happens in runJob slices.
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
        }
    }

    /**
     * @param {string} gateId
     */
    function abort(gateId) {
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
     * Forget a gate's retry back-off so the next pump() tries again immediately (used by the commands).
     * @param {string} gateId
     */
    function retryNow(gateId) {
        const record = readRecord(gateId);
        if (record !== undefined) {
            record.retryAt = 0;
            record.attempts = 0;
            writeRecord(record);
        }
    }

    /**
     * @param {string} gateId
     */
    function describe(gateId) {
        const record = readRecord(gateId);
        return {
            running: running.has(gateId),
            record,
            outcome: lastOutcome.get(gateId),
        };
    }

    return { request, pump, start, abort, retryNow, describe, isRunning: (/** @type {string} */ id) => running.has(id) };
}

/** @typedef {ReturnType<typeof createGateAdapter>} GateAdapter */

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
