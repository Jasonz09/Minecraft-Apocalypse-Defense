// Shared fake-Bedrock harness for the civilization runtime tests (civ-runtime.test.mjs, civ-survey.test.mjs).
// Runtime half of the one-command civilization workflow (commands/civ.js, integration/civBuilder.js,
// integration/civScan.js) executed against a fake Bedrock world: natural terrain from dev/lib/fakefield.mjs,
// a block grid with trees and water, a system.runJob driver that runs ONE slice at a time (so budgets can be
// measured and the process can be "killed" between slices), a ticking-area manager and a property store with the
// engine's 32767 limit. It proves the safety/recovery contract - NOT that the real engine accepts the block
// states, that ticking areas load chunks in time, or how long a real server takes.
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;
const { makeField } = await import(pathToFileURL(join(projectRoot, "dev", "lib", "fakefield.mjs")).href);

class Crash extends Error {}

const WORLD_SIZE = 1500;
const BASE_Y = 70;
const WATER_TOP = BASE_Y - 1;
const mc = {
    props: new Map(),
    propWrites: 0,
    crashProps: null,
    dieAtWrites: null,
    dead: false,
    messages: [],
    subscribers: [],
    jobs: [],
    nextJob: 1,
    reads: 0,
    writes: 0,
    written: new Set(),
    placed: new Map(),
    colTop: new Map(),
    firstWrite: undefined,
    areas: new Map(),
    areaLog: [],
    areaViolations: 0,
    areaMaxChunks: 0,
    noCapacity: false,
    maxChunkCount: 100000,
    createCalls: 0,
    createMode: () => undefined,
    tick: 0,
    timers: [],
    nextTimer: 1,
    holdGate: undefined,
    unloaded: () => false,
    rejectStates: () => false,
    persistent: () => false,
    maxReadsPerSlice: 0,
    maxWritesPerSlice: 0,
    slices: 0,
    model: null,
};
globalThis.__mcCiv = mc;

// ---------------------------------------------------------------------------- the world

const key = (x, y, z) => `${x},${y},${z}`;

function makeModel(seed, options = {}) {
    const field = makeField(seed, { size: WORLD_SIZE, base: BASE_Y, relief: 4, hills: 90, forest: 0.3, ...(options.field ?? {}) });
    return { seed, field, lavaEvery: options.lavaEvery ?? 0, options };
}

function groundCell(x, z) {
    const c = mc.model.field.at(x, z);
    if (c.k === "unloaded") return undefined;
    return c;
}

function isLavaColumn(x, z) {
    const e = mc.model.lavaEvery;
    return e > 0 && Math.abs(((x % e) + e) % e) < 3 && Math.abs(((z % e) + e) % e) < 3;
}

/** natural block id, or undefined when the column is outside the world model */
function naturalAt(x, y, z) {
    const c = groundCell(x, z);
    if (c === undefined) return undefined;
    if (y < -64) return "minecraft:bedrock";
    if (y >= 320) return "minecraft:air";
    const g = c.g;
    if (isLavaColumn(x, z) && y <= g && y >= g - 1) return "minecraft:lava";
    if (y <= g) {
        if (c.k === "water" && y === g) return "minecraft:sand";
        if (y === g) return "minecraft:grass_block";
        if (y >= g - 2) return "minecraft:dirt";
        return "minecraft:stone";
    }
    if (c.k === "water") return y <= WATER_TOP ? "minecraft:water" : "minecraft:air";
    // trees: trunk 4 high with a 3x3 canopy; sparse (fakefield sets `tree` per column)
    if (c.tree && y <= g + 4) return "minecraft:oak_log";
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
            const n = groundCell(x + dx, z + dz);
            if (n === undefined || !n.tree) continue;
            if ((y === n.g + 5) || (y === n.g + 4 && (dx !== 0 || dz !== 0))) return "minecraft:oak_leaves";
        }
    }
    return "minecraft:air";
}

function typeAt(x, y, z) {
    const placed = mc.placed.get(key(x, y, z));
    if (placed !== undefined) return placed;
    return naturalAt(x, y, z);
}

function isUnloaded(x, y, z) {
    return mc.unloaded({ x, y, z }) || groundCell(x, z) === undefined;
}

function makeBlock(x, y, z) {
    return {
        isValid: true,
        get typeId() {
            return typeAt(x, y, z);
        },
        location: { x, y, z },
        permutation: { getState: (name) => (name === "persistent_bit" ? mc.persistent(x, y, z) : undefined) },
        setPermutation(permutation) {
            if (mc.dieAtWrites !== null && mc.writes >= mc.dieAtWrites) mc.dead = true;
            if (mc.dead) return;
            if (y < -64 || y > 319) throw new RangeError("y out of range");
            mc.writes += 1;
            if (mc.firstWrite === undefined) {
                const kingdomText = mc.props.get("civ:kingdom");
                let civ = false;
                try {
                    civ = JSON.parse(kingdomText).districts[0].civ !== undefined;
                } catch {}
                mc.firstWrite = { plan: mc.props.has("civ:plan:meta"), jobs: mc.props.has("civ:jobs:meta"), civ };
            }
            const k = key(x, y, z);
            mc.written.add(k);
            mc.placed.set(k, permutation.id);
            if (permutation.id !== "minecraft:air") {
                const ck = `${x},${z}`;
                if ((mc.colTop.get(ck) ?? -999) < y) mc.colTop.set(ck, y);
            }
        },
    };
}

const dimension = {
    id: "minecraft:overworld",
    isChunkLoaded: (location) => !isUnloaded(Math.floor(location.x), 64, Math.floor(location.z)),
    getTopmostBlock({ x, z }) {
        mc.reads += 1;
        if (isUnloaded(x, 64, z)) return undefined;
        let y = Math.max(BASE_Y + 8, mc.colTop.get(`${x},${z}`) ?? 0, (groundCell(x, z)?.g ?? 0) + 7);
        for (; y >= -64; y -= 1) {
            const id = typeAt(x, y, z);
            if (id !== "minecraft:air") return makeBlock(x, y, z);
        }
        return undefined;
    },
    getBlock(position) {
        mc.reads += 1;
        const { x, y, z } = position;
        if (isUnloaded(x, y, z)) return undefined;
        return makeBlock(x, y, z);
    },
};

mc.world = {
    afterEvents: { playerSpawn: { subscribe() {} } },
    getDynamicProperty: (k) => mc.props.get(k),
    setDynamicProperty(k, v) {
        if (mc.dead) throw new Crash("process is dead");
        if (mc.crashProps !== null && mc.propWrites >= mc.crashProps) {
            mc.dead = true;
            throw new Crash("simulated crash during a property write");
        }
        if (typeof v === "string" && v.length > 32767) throw new RangeError("dynamic property value too long");
        mc.propWrites += 1;
        if (v === undefined) mc.props.delete(k);
        else mc.props.set(k, v);
    },
    getDynamicPropertyIds: () => [...mc.props.keys()],
    getDimension: () => dimension,
    sendMessage: (m) => mc.messages.push(...(Array.isArray(m) ? m : [m])),
    tickingAreaManager: {
        get maxChunkCount() {
            return mc.maxChunkCount;
        },
        get chunkCount() {
            let n = 0;
            for (const area of mc.areas.values()) n += area.chunks ?? 0;
            return n;
        },
        hasTickingArea: (id) => mc.areas.has(id),
        getTickingArea: (id) => (mc.areas.has(id) ? { identifier: id, isFullyLoaded: mc.areas.get(id).loaded === true } : undefined),
        removeTickingArea(id) {
            if (!mc.areas.has(id)) throw new TickingAreaError("UnknownIdentifier");
            mc.areas.delete(id);
            mc.areaLog.push(`remove ${id}`);
        },
        hasCapacity(options) {
            return !mc.noCapacity && mc.world.tickingAreaManager.chunkCount + chunksOf(options) <= mc.maxChunkCount;
        },
        async createTickingArea(id, options) {
            if (mc.holdGate) {
                const gate = mc.holdGate;
                mc.holdGate = undefined;
                await gate;
            }
            const chunks = chunksOf(options);
            mc.createCalls += 1;
            if (mc.areas.has(id)) throw new TickingAreaError("IdentifierAlreadyExists");
            if (chunks > mc.maxChunkCount || mc.world.tickingAreaManager.chunkCount + chunks > mc.maxChunkCount) throw new TickingAreaError("OverChunkLimit");
            const mode = mc.createMode(chunks, options, mc.createCalls) ?? "instant";
            if (typeof mode === "object" && mode.reject) throw new TickingAreaError(mode.reject);
            mc.areaMaxChunks = Math.max(mc.areaMaxChunks, chunks);
            if (mc.areas.size > 0) mc.areaViolations += 1;
            const area = { ...options, chunks, loaded: false };
            mc.areas.set(id, area);
            mc.areaLog.push(`create ${id} ${chunks}`);
            if (mode === "never") await new Promise(() => {});
            if (typeof mode === "object" && mode.reject) {
                mc.areas.delete(id);
                throw new TickingAreaError(mode.reject);
            }
            if (typeof mode === "object" && mode.loadedAfter) {
                addTimer(mode.loadedAfter, () => {
                    area.loaded = true;
                });
            }
            if (typeof mode === "object" && mode.delay) {
                await new Promise((resolve) => addTimer(mode.delay, resolve));
                if (mc.areas.get(id) !== area) throw new TickingAreaError("UnknownIdentifier");
            }
            area.loaded = true;
        },
    },
};
function chunksOf(options) {
    return (Math.floor(options.to.x / 16) - Math.floor(options.from.x / 16) + 1) * (Math.floor(options.to.z / 16) - Math.floor(options.from.z / 16) + 1);
}
class TickingAreaError extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
function addTimer(ticks, callback, interval) {
    const id = mc.nextTimer++;
    mc.timers.push({ id, at: mc.tick + Math.max(1, ticks), callback, interval });
    return id;
}
/** Advance the game clock; fire every timer that falls due (intervals repeat). */
function advanceTick(n = 1) {
    for (let i = 0; i < n; i += 1) {
        mc.tick += 1;
        const due = mc.timers.filter((t) => t.at <= mc.tick).sort((a, b) => a.at - b.at || a.id - b.id);
        for (const t of due) {
            if (!mc.timers.includes(t)) continue;
            if (t.interval) t.at = mc.tick + t.interval;
            else mc.timers = mc.timers.filter((x) => x !== t);
            t.callback();
        }
    }
}
mc.system = {
    afterEvents: { scriptEventReceive: { subscribe: (callback, options) => mc.subscribers.push({ callback, options }) } },
    get currentTick() {
        return mc.tick;
    },
    runInterval: (callback, ticks) => addTimer(ticks, callback, ticks),
    clearRun(id) {
        mc.timers = mc.timers.filter((t) => t.id !== id);
    },
    runTimeout: (callback, ticks = 1) => addTimer(ticks, callback),
    runJob(generator) {
        const id = mc.nextJob++;
        mc.jobs.push({ id, generator });
        return id;
    },
    clearJob(id) {
        mc.jobs = mc.jobs.filter((job) => job.id !== id);
    },
};
mc.BlockPermutation = {
    resolve(id, states) {
        if (states !== undefined && mc.rejectStates(id, states)) throw new Error("invalid state");
        return { id, states };
    },
};

const hooks = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = 'export const world = globalThis.__mcCiv.world; export const system = globalThis.__mcCiv.system;' +
            'export const BlockPermutation = globalThis.__mcCiv.BlockPermutation;' +
            'export const ScriptEventSource = { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" };';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));

// ---------------------------------------------------------------------------- imports (nothing may start on import)

const load = (...parts) => import(fileUrl(...parts));
const writesAtImport = mc.writes;
const jobsAtImport = mc.jobs.length;
const { createKingdomStore } = await load("kingdom", "store.js");
const { districtById, findValidationProblems } = await load("kingdom", "state.js");
const civCommands = await load("commands", "civ.js");
const builder = await load("integration", "civBuilder.js");
const scan = await load("integration", "civScan.js");
const districtBuilder = await load("integration", "districtBuilder.js");
const planstore = await load("civ", "planstore.js");
const jobsModule = await load("civ", "jobs.js");
const { CIV, CIV_EVENT_IDS } = await load("config.js");
const { CIV_LIMITS } = await load("civ", "budget.js");
const siteplan = await load("civ", "districtplan.js");

const store = createKingdomStore(mc.world);
civCommands.registerCivCommands(store);
const physicalCommands = await load("commands", "physical.js");
physicalCommands.registerPhysicalCommands(store);
const gateCommands = await load("commands", "gates.js");
gateCommands.registerGateCommands(store);
const handler = mc.subscribers[0];
const defaultValidate = builder.seams.validatePlan;
const jobsAfterRegister = mc.jobs.length;
const writesAfterRegister = mc.writes;

// ---------------------------------------------------------------------------- harness

const flush = () => new Promise((done) => setImmediate(done));

/**
 * Run queued jobs one slice at a time (one slice = one game tick, measuring budgets) until `until()` or idle.
 * When no job is queued but timers are pending the clock keeps running (a stalled load, a heartbeat) up to maxIdleTicks.
 */
async function pump({ until, maxSlices = 2e7, stopOnDead = false, maxIdleTicks = 200000 } = {}) {
    let slices = 0;
    let idleTicks = 0;
    for (;;) {
        await flush();
        if (until?.()) return slices;
        if (mc.jobs.length === 0) {
            for (let turn = 0; turn < 8 && mc.jobs.length === 0; turn += 1) await flush();
            if (mc.jobs.length === 0) {
                if (mc.timers.length === 0) return slices;
                idleTicks += 1;
                if (idleTicks > maxIdleTicks) throw new Error("pump: timers never drained");
                advanceTick(1);
                continue;
            }
        }
        const job = mc.jobs[0];
        const r0 = mc.reads;
        const w0 = mc.writes;
        const result = job.generator.next();
        mc.slices += 1;
        mc.maxReadsPerSlice = Math.max(mc.maxReadsPerSlice, mc.reads - r0);
        mc.maxWritesPerSlice = Math.max(mc.maxWritesPerSlice, mc.writes - w0);
        slices += 1;
        advanceTick(1);
        if (result.done) mc.jobs = mc.jobs.filter((entry) => entry !== job);
        if (stopOnDead && mc.dead) return slices;
        if (until?.()) return slices;
        if (slices > maxSlices) throw new Error("pump: too many slices");
    }
}

function resetWorld(seed = 1, options = {}) {
    districtBuilder.cancelActiveJob();
    builder.resetCivForTests();
    builder.seams.maxPlanBytes = undefined;
    builder.seams.onOutcome = undefined;
    builder.seams.validatePlan = defaultValidate;
    mc.props.clear();
    mc.propWrites = 0;
    mc.crashProps = null;
    mc.dieAtWrites = null;
    mc.dead = false;
    mc.messages.length = 0;
    mc.jobs.length = 0;
    mc.reads = 0;
    mc.writes = 0;
    mc.written = new Set();
    mc.placed = new Map();
    mc.colTop = new Map();
    mc.firstWrite = undefined;
    mc.areas.clear();
    mc.areaLog.length = 0;
    mc.areaViolations = 0;
    mc.areaMaxChunks = 0;
    mc.noCapacity = false;
    mc.maxChunkCount = 100000;
    mc.createCalls = 0;
    mc.createMode = () => undefined;
    mc.tick = 0;
    mc.timers = [];
    mc.holdGate = undefined;
    builder.seams.maxJobBytes = undefined;
    mc.unloaded = () => false;
    mc.rejectStates = () => false;
    mc.persistent = () => false;
    mc.maxReadsPerSlice = 0;
    mc.maxWritesPerSlice = 0;
    mc.slices = 0;
    mc.model = makeModel(seed, options);
    civCommands.setGateLinker(undefined);
    store.ensureInitial();
}


function makePlayer(x = 0, z = 0) {
    const messages = [];
    return {
        typeId: "minecraft:player",
        isValid: true,
        location: { x: x + 0.5, y: BASE_Y + 1, z: z + 0.5 },
        dimension,
        messages,
        sendMessage: (m) => messages.push(...(Array.isArray(m) ? m : [m])),
    };
}

function send(id, message, source) {
    for (const subscriber of mc.subscribers) {
        subscriber.callback({ id, message, sourceType: source ? "Entity" : "Server", sourceEntity: source, initiator: source });
    }
}

const text = (player) => player.messages.join("\n");
const civRecord = () => districtById(store.load().kingdom, "district-1").civ;

/** world modifications relative to untouched nature, as a sorted comparable string */
function worldFingerprint() {
    const lines = [];
    for (const [k, id] of mc.placed) {
        const [x, y, z] = k.split(",").map(Number);
        if (naturalAt(x, y, z) !== id) lines.push(`${k}=${id}`);
    }
    lines.sort();
    return lines;
}

function propsSnapshot() {
    return new Map(mc.props);
}

function restoreProps(snapshot) {
    mc.props.clear();
    for (const [k, v] of snapshot) mc.props.set(k, v);
}

/** Simulate a process restart: all module state forgotten, in-flight jobs dropped, only the property store survives. */
async function restart() {
    await flush();
    await flush();
    districtBuilder.cancelActiveJob();
    builder.resetCivForTests();
    mc.jobs.length = 0;
    mc.dead = false;
    mc.crashProps = null;
    mc.dieAtWrites = null;
    mc.areas.clear();
    mc.timers = [];
}

function addOldHearthgate(ox, oz) {
    const loaded = store.load();
    const d = districtById(loaded.kingdom, "district-1");
    d.physical = { layout: "hearthgate", version: 1, status: "complete", origin: { x: ox, y: BASE_Y + 1, z: oz }, dimension: "minecraft:overworld", placed: 100, total: 100, planHash: "deadbeef" };
    store.save(loaded.kingdom);
    assert.deepEqual(findValidationProblems(store.load().kingdom), []);
    // marker blocks across the 49x49 footprint: a stone-brick ring and a cobble cross
    const markers = [];
    for (let i = -24; i <= 24; i += 1) {
        for (const [x, z] of [[ox + i, oz - 24], [ox + i, oz + 24], [ox - 24, oz + i], [ox + 24, oz + i], [ox + i, oz], [ox, oz + i]]) {
            const y = (groundCell(x, z)?.g ?? BASE_Y) + 1;
            mc.placed.set(key(x, y, z), i % 2 === 0 ? "minecraft:stone_bricks" : "minecraft:cobblestone");
            markers.push(key(x, y, z));
        }
    }
    return markers;
}


export {
    Crash, TickingAreaError, WORLD_SIZE, BASE_Y, mc, key, naturalAt, typeAt, groundCell, dimension, load, writesAtImport, jobsAtImport,
    createKingdomStore, districtById, findValidationProblems, civCommands, builder, scan, districtBuilder, planstore, jobsModule,
    CIV, CIV_EVENT_IDS, CIV_LIMITS, siteplan, store, physicalCommands, gateCommands, handler, defaultValidate, jobsAfterRegister,
    writesAfterRegister, flush, pump, advanceTick, resetWorld, makePlayer, send, text, civRecord, worldFingerprint, propsSnapshot,
    restoreProps, restart, addOldHearthgate, projectRoot, scriptsRoot, fileUrl,
};
