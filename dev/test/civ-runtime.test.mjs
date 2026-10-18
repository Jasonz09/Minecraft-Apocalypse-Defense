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
        hasTickingArea: (id) => mc.areas.has(id),
        removeTickingArea(id) {
            mc.areas.delete(id);
            mc.areaLog.push(`remove ${id}`);
        },
        hasCapacity: () => !mc.noCapacity,
        async createTickingArea(id, options) {
            const chunks = (Math.floor(options.to.x / 16) - Math.floor(options.from.x / 16) + 1) * (Math.floor(options.to.z / 16) - Math.floor(options.from.z / 16) + 1);
            mc.areaMaxChunks = Math.max(mc.areaMaxChunks, chunks);
            if (mc.areas.size > 0) mc.areaViolations += 1;
            mc.areas.set(id, options);
            mc.areaLog.push(`create ${id} ${chunks}`);
        },
    },
};
mc.system = {
    afterEvents: { scriptEventReceive: { subscribe: (callback, options) => mc.subscribers.push({ callback, options }) } },
    runInterval: () => 1,
    clearRun() {},
    runTimeout(callback) {
        setImmediate(callback);
        return 1;
    },
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
const handler = mc.subscribers[0];
const jobsAfterRegister = mc.jobs.length;
const writesAfterRegister = mc.writes;

// ---------------------------------------------------------------------------- harness

const flush = () => new Promise((done) => setImmediate(done));

/** Run queued jobs one slice at a time (measuring budgets) until `until()` or idle. */
async function pump({ until, maxSlices = 2e7, stopOnDead = false } = {}) {
    let slices = 0;
    for (;;) {
        await flush();
        if (until?.()) return slices;
        if (mc.jobs.length === 0) {
            // idle only if nothing (a timer, a hold, a tick-delayed step) produces work within a few turns
            for (let turn = 0; turn < 8 && mc.jobs.length === 0; turn += 1) await flush();
            if (mc.jobs.length === 0) return slices;
        }
        const job = mc.jobs[0];
        const r0 = mc.reads;
        const w0 = mc.writes;
        const result = job.generator.next();
        mc.slices += 1;
        mc.maxReadsPerSlice = Math.max(mc.maxReadsPerSlice, mc.reads - r0);
        mc.maxWritesPerSlice = Math.max(mc.maxWritesPerSlice, mc.writes - w0);
        slices += 1;
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
    builder.seams.validatePlan = (plan) => lastValidate(plan);
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

let lastValidate = (plan) => validateReal(plan);
let validateReal;
{
    const { validatePlan } = await load("civ", "validate.js");
    validateReal = (plan) => validatePlan(plan);
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
    handler.callback({ id, message, sourceType: source ? "Entity" : "Server", sourceEntity: source, initiator: source });
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

// ---------------------------------------------------------------------------- imports/activation are inert

test("importing and registering the commands starts nothing and writes nothing", async () => {
    assert.equal(writesAtImport, 0);
    assert.equal(jobsAtImport, 0);
    assert.equal(jobsAfterRegister, 0);
    assert.equal(writesAfterRegister, 0);
    assert.equal(handler.options.namespaces[0], "civ");
    resetWorld();
    await pump();
    assert.equal(mc.writes, 0);
    assert.equal(mc.jobs.length, 0);
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(builder.hasSession(), false);
    assert.equal(civRecord(), undefined);
});

test("every civ command id has exactly one colon and is registered by CIV_EVENT_IDS", () => {
    for (const id of Object.values(CIV_EVENT_IDS)) assert.equal(id.split(":").length, 2, id);
});

test("argument parsing: radius bounds, seed, unknown arguments", () => {
    assert.deepEqual(civCommands.parseCivArgs([]), { radius: CIV.defaultSearchRadius, seed: undefined, districts: undefined, error: undefined });
    assert.equal(civCommands.parseCivArgs(["radius=300", "seed=-7"]).radius, 300);
    assert.equal(civCommands.parseCivArgs(["radius=300", "seed=-7"]).seed, -7);
    assert.match(civCommands.parseCivArgs([`radius=${CIV.maxSearchRadius + 1}`]).error, /radius must be/);
    assert.match(civCommands.parseCivArgs(["radius=abc"]).error, /radius must be/);
    assert.match(civCommands.parseCivArgs(["seed=1.5"]).error, /seed must be/);
    assert.match(civCommands.parseCivArgs(["bogus"]).error, /unrecognised/);
    assert.match(civCommands.parseCivArgs(["colour=red"]).error, /unknown argument/);
    assert.equal(civCommands.parseCivArgs(["districts=1,2"]).districts, "1,2");
});

test("district.civ record validation", () => {
    const good = { status: "building", seed: 3, anchor: { x: 1, z: 2 }, centre: { x: 3, z: 4 }, checksum: "abc", stage: "clear", startedStep: 0 };
    assert.deepEqual(civCommands.civRecordProblems(good), []);
    assert.deepEqual(civCommands.civRecordProblems(undefined), []);
    assert.ok(civCommands.civRecordProblems({ ...good, status: "weird" }).length > 0);
    assert.ok(civCommands.civRecordProblems({ ...good, anchor: { x: 1.5, z: 2 } }).length > 0);
    assert.ok(civCommands.civRecordProblems({ ...good, checksum: "" }).length > 0);
    assert.ok(civCommands.civRecordProblems({ ...good, startedStep: -1 }).length > 0);
});

// ---------------------------------------------------------------------------- op classification

test("classifyCivOp: live-block rules per op class", () => {
    const op = (kind, id = "minecraft:stone_bricks") => ({ x: 0, y: 0, z: 0, id, kind });
    const c = builder.classifyCivOp;
    assert.equal(c(op("wall"), undefined).action, "unloaded");
    assert.equal(c(op("wall"), "minecraft:air").action, "place");
    assert.equal(c(op("wall"), "minecraft:short_grass").action, "place");
    assert.equal(c(op("wall"), "minecraft:dirt").action, "place");
    assert.equal(c(op("wall"), "minecraft:stone_bricks").action, "built");
    for (const foreign of ["minecraft:oak_planks", "minecraft:chest", "minecraft:cobblestone", "minecraft:iron_block", "minecraft:glass"]) {
        const verdict = c(op("wall"), foreign);
        assert.equal(verdict.action, "skip", foreign);
        assert.match(verdict.reason, /occupied/);
    }
    // a block this plan places at the same cell counts as ours
    assert.equal(c(op("structure", "minecraft:stone_bricks"), "minecraft:oak_planks", ["minecraft:oak_planks"]).action, "place");
    // clear: only plants/trees/air
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:short_grass").action, "place");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:air").action, "built");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:oak_log").action, "tree");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:oak_planks").action, "skip");
    assert.equal(c(op("clear", "minecraft:air"), "minecraft:dirt").action, "skip");
    // cut/fill/top follow structures/terrain.js
    assert.equal(c(op("cut", "minecraft:air"), "minecraft:dirt").action, "place");
    assert.equal(c(op("cut", "minecraft:air"), "minecraft:chest").action, "skip");
    assert.equal(c(op("fill", "minecraft:dirt"), "minecraft:air").action, "place");
    assert.equal(c(op("fill", "minecraft:dirt"), "minecraft:stone").action, "built");
    assert.equal(c(op("fill", "minecraft:dirt"), "minecraft:oak_planks").action, "skip");
    assert.equal(c(op("top", "minecraft:grass_block"), "minecraft:dirt").action, "place");
    assert.equal(c(op("top", "minecraft:grass_block"), "minecraft:oak_planks").action, "skip");
    // water only for support kinds
    assert.equal(c(op("support"), "minecraft:water").action, "place");
    assert.equal(c(op("wall"), "minecraft:water").action, "skip");
    // trees need proof
    assert.equal(c(op("wall"), "minecraft:oak_leaves").action, "tree");
});

// ---------------------------------------------------------------------------- pipeline helpers

const WORLD_SEED = 1;
const PLAN_SEED = 1;
const GEN = `seed=${PLAN_SEED}`;
const MIN_TIMEOUT = { timeout: 300000 };

async function generate(player, message = GEN) {
    send(CIV_EVENT_IDS.generate, message, player);
    await pump();
}

/** Run generate on world W; returns what the tests need. */
async function fullRun(worldSeed = WORLD_SEED, worldOptions = {}, prepare) {
    resetWorld(worldSeed, worldOptions);
    prepare?.();
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer(0, 0);
    await generate(player);
    return { player, outcome };
}

/** Plan + persist, then stop before the first block (indexing job queued, nothing written). */
async function plannedOnly(worldSeed = WORLD_SEED, planSeed = PLAN_SEED, worldOptions = {}, prepare) {
    resetWorld(worldSeed, worldOptions);
    prepare?.();
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer(0, 0);
    send(CIV_EVENT_IDS.generate, `seed=${planSeed}`, player);
    await pump({ until: () => builder.hasSession() });
    assert.ok(builder.hasSession(), `planning must reach construction:
${text(player).slice(-900)}`);
    assert.equal(mc.writes, 0, "nothing may be written before the abort");
    send(CIV_EVENT_IDS.abort, "", player);
    await pump();
    assert.equal(builder.hasSession(), false);
    assert.equal(districtBuilder.isBusy(), false);
    return { player, outcome, props: propsSnapshot() };
}

let baselinePromise;
/** The uninterrupted reference run (cached). */
function baseline() {
    baselinePromise ??= (async () => {
        let kingdomBefore;
        const run = await fullRun(WORLD_SEED, {}, () => {
            kingdomBefore = structuredClone(store.load().kingdom);
        });
        assert.match(text(run.player), /is built/, text(run.player).slice(-1500));
        const after = store.load().kingdom;
        assert.deepEqual(findValidationProblems(after), []);
        const stripped = structuredClone(after);
        delete districtById(stripped, "district-1").civ;
        assert.deepEqual(stripped, kingdomBefore, "the simulation state is untouched apart from the small district.civ record");
        const fp = worldFingerprint();
        return {
            ...run,
            fp,
            messages: [...run.player.messages],
            stats: { reads: mc.maxReadsPerSlice, writes: mc.maxWritesPerSlice, slices: mc.slices, areaMaxChunks: mc.areaMaxChunks, areaViolations: mc.areaViolations, firstWrite: mc.firstWrite, areasLeft: mc.areas.size, totalWrites: mc.writes },
            civ: structuredClone(civRecord()),
            written: new Set(mc.written),
            placed: new Map(mc.placed),
        };
    })();
    return baselinePromise;
}

function assertSameWorld(actual, expected, label) {
    if (actual.length === expected.length && actual.every((line, i) => line === expected[i])) return;
    const a = new Set(actual);
    const e = new Set(expected);
    const extra = actual.filter((line) => !e.has(line)).slice(0, 5);
    const missing = expected.filter((line) => !a.has(line)).slice(0, 5);
    assert.fail(`${label}: worlds differ (${actual.length} vs ${expected.length} modified cells). only here: ${extra.join(" ")} | only there: ${missing.join(" ")}`);
}

function noCivData() {
    return [...mc.props.keys()].filter((k) => k.startsWith("civ:plan") || k.startsWith("civ:jobs"));
}

function assertUntouched(player, stage) {
    assert.equal(mc.writes, 0, "no block may be written");
    assert.equal(civRecord(), undefined, "no district.civ record");
    assert.deepEqual(noCivData(), [], "no plan or job data stored");
    assert.equal(mc.areas.size, 0, "no ticking area left behind");
    assert.equal(districtBuilder.isBusy(), false, "the job slot is free");
    assert.equal(builder.hasSession(), false);
    if (stage) assert.match(text(player), new RegExp(`Stopped at ${stage}`), text(player).slice(-800));
    assert.match(text(player), /No block was written|nothing was changed/i);
}

// ---------------------------------------------------------------------------- failure paths: zero writes, no residue

test("failure: water everywhere -> no site, zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1, { field: { lakes: [{ x: 0, z: 0, r: 4000 }] } });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
});

test("failure: lava through the area -> no site, zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1, { lavaEvery: 40 });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
    assert.match(text(player), /lava/);
});

test("failure: terrain too steep -> no site, reasons listed, zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1, { field: { relief: 70, hills: 18 } });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
    assert.match(text(player), /steep|candidates/);
});

test("failure: unloaded columns during the coarse survey are recorded, never guessed -> zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.unloaded = ({ x, z }) => x % 8 === 0 && z % 8 === 0 && (x / 8) % 5 === 0 && (z / 8) % 5 === 0;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "site");
    assert.match(text(player), /unloaded/);
});

test("failure: unloaded columns inside district 1 stop the plan before anything is stored", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.unloaded = ({ x, z }) => x % 8 !== 0 && ((x % 17) + 17) % 17 === 3 && ((z % 17) + 17) % 17 === 5;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "unloaded");
    assert.match(text(player), /could not be read/);
});

test("failure: nothing readable at all (whole world unloaded) -> zero writes", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.unloaded = () => true;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "scan");
});

test("failure: an invalid master plan stops the run", MIN_TIMEOUT, async () => {
    resetWorld(1);
    builder.seams.validatePlan = () => ({ ok: false, problems: ["forced: walls leak"], metrics: {} });
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "validate");
    assert.match(text(player), /walls leak/);
});

test("failure: a plan too big for storage is refused politely", MIN_TIMEOUT, async () => {
    resetWorld(1);
    builder.seams.maxPlanBytes = 6000;
    const player = makePlayer();
    await generate(player);
    assertUntouched(player, "too-big");
    assert.match(text(player), /only 6000 may be stored/);
});

test("failure: a crash while the plan is being stored leaves no half state and writes no block", MIN_TIMEOUT, async () => {
    resetWorld(1);
    builder.seams.onOutcome = () => {
        mc.crashProps = mc.propWrites + 2;
    };
    const player = makePlayer();
    await generate(player);
    assert.equal(mc.writes, 0);
    assert.equal(mc.firstWrite, undefined);
    assert.equal(builder.hasSession(), false);
    await restart();
    const loaded = planstore.createPlanStore(mc.world).loadPlan();
    assert.ok(["absent", "ok"].includes(loaded.status), `plan store must never be half written, saw ${loaded.status}`);
    assert.equal(civRecord(), undefined, "no kingdom record points at the partial plan");
    assert.equal(districtBuilder.isBusy(), false);
});

test("failure: unreadable kingdom, console source and wrong dimension are refused before any read", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, undefined);
    await pump();
    assert.ok(mc.messages.some((m) => /Run this as a player/.test(m)), "console source refused");
    const kingdom = mc.props.get("civ:kingdom");
    mc.props.delete("civ:kingdom");
    await generate(player);
    assert.match(text(player), /No readable kingdom/);
    mc.props.set("civ:kingdom", kingdom);
    const nether = { ...player, messages: [], dimension: { ...dimension, id: "minecraft:nether" } };
    nether.sendMessage = (m) => nether.messages.push(...(Array.isArray(m) ? m : [m]));
    await generate(nether);
    assert.match(text(nether), /overworld/);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0, "refusals do not even read the world");
});

// ---------------------------------------------------------------------------- plan only

test("civ:generate_plan is strictly read-only and prints the numbers", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const before = propsSnapshot();
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    await pump();
    assert.equal(mc.writes, 0);
    assert.deepEqual([...mc.props.entries()], [...before.entries()], "not even a property was written");
    assert.equal(mc.areas.size, 0);
    assert.equal(districtBuilder.isBusy(), false);
    const out = text(player);
    assert.match(out, /Plan is valid/);
    assert.match(out, /District areas \d+ \/ \d+ \/ \d+ \/ \d+ \/ \d+ columns; compactness/);
    assert.match(out, /Walls \d+ blocks, \d+ gates, roads \d+ blocks, \d+ lots/);
    assert.match(out, /Estimated \d+ block operations in \d+ slices, about [\d.]+ minutes\. Stored size \d+ \/ 120000 bytes/);
    assert.match(out, /Nothing was written/);
    assert.ok(mc.reads > 0);
});

// ---------------------------------------------------------------------------- the whole thing

test("one command: scan, plan, validate, store, then build - everything within budgets", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const out = base.messages.join("\n");
    // zero writes before a validated plan, a stored plan, a stored queue and a kingdom record exist
    assert.deepEqual(base.stats.firstWrite, { plan: true, jobs: true, civ: true });
    // staged, reported messages
    for (const step of ["[1/6]", "[2/6]", "[3/6]", "[4/6]", "[5/6]", "[6/6]", "Plan stored", "indexing the plan"]) assert.ok(out.includes(step), step);
    const deciles = [...out.matchAll(/^ {2}(\w+): (\d+)% \((\d+) \/ (\d+) ops, (\d+) skipped\)$/gm)];
    assert.ok(deciles.length >= 8, `progress every 10% (${deciles.length} lines)`);
    const pcts = deciles.map((m) => Number(m[2]));
    assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b));
    assert.ok(deciles.some((m) => m[1] === "walls") && deciles.some((m) => m[1] === "lots"), "stage names are reported");
    // final report
    assert.match(out, /=== Hearthgate \(enlarged\) is built ===/);
    assert.match(out, /Operations: estimated (\d+), processed \1;/);
    assert.match(out, /blocks placed \d+, already present \d+, skipped \d+, failed 0, state fallbacks 0/);
    const tp = /\/tp @s (-?\d+) (-?\d+) (-?\d+)/.exec(out);
    assert.ok(tp, "a /tp line with coordinates");
    const [, tx, ty, tz] = tp.map(Number);
    assert.ok(ty > BASE_Y - 10 && ty < 200, `a sensible y (${ty})`);
    assert.ok(Math.abs(tx) < 800 && Math.abs(tz) < 800);
    // budgets (measured on the fake world's own counters, per job.next() call)
    assert.ok(base.stats.reads <= CIV_LIMITS.maxReadsPerSlice, `reads per slice ${base.stats.reads}`);
    assert.ok(base.stats.writes <= CIV_LIMITS.maxBlocksPerSlice, `writes per slice ${base.stats.writes}`);
    assert.match(out, new RegExp(`max ${CIV_LIMITS.maxBlocksPerSlice} ops, \\d+ reads per slice`));
    // chunk holding: one area at a time, never above the cap, none left
    assert.ok(base.stats.areaMaxChunks <= 100, `ticking area ${base.stats.areaMaxChunks} chunks`);
    assert.equal(base.stats.areaViolations, 0);
    assert.equal(base.stats.areasLeft, 0);
    // record
    assert.equal(base.civ.status, "complete");
    assert.equal(base.civ.stage, "complete");
    assert.deepEqual(civCommands.civRecordProblems(base.civ), []);
    assert.equal(base.civ.seed, PLAN_SEED);
    assert.equal(base.civ.opsTotal, base.civ.ops);
});

test("the built world matches the plan block for block and stays inside the claimed area", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const record = base.outcome.record;
    const expected = new Map();
    for (const stage of siteplan.SITE_STAGES) {
        for (let i = 0; i < record[stage].length; i += 1) {
            for (const op of siteplan.siteOpsFor(record, stage, i)) expected.set(key(op.x, op.y, op.z), op.id);
        }
    }
    assert.ok(expected.size > 20000);
    let wrong = 0;
    const samples = [];
    for (const [k, id] of expected) {
        const placed = base.placed.get(k);
        const [x, y, z] = k.split(",").map(Number);
        const got = placed ?? naturalAt(x, y, z);
        if (got !== id) {
            wrong += 1;
            if (samples.length < 5) samples.push(`${k} is ${got}, plan says ${id}`);
        }
    }
    assert.equal(wrong, 0, samples.join("; "));
    const region = base.outcome.region;
    for (const k of base.written) {
        const [x, , z] = k.split(",").map(Number);
        assert.ok(x >= region.x0 - 4 && x <= region.x1 + 4 && z >= region.z0 - 4 && z <= region.z1 + 4, `stray write at ${k}`);
    }
    assert.ok(base.written.size > 20000);
});

test("estimated size and storage are reported and within limits", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const storage = base.outcome.stats.storage;
    assert.ok(storage.bytes <= storage.limit);
    assert.ok(storage.chunks >= 2, "the plan is stored in several chunks");
    assert.ok(siteplan.siteOpCount(base.outcome.record) > 20000);
});

// ---------------------------------------------------------------------------- the old Hearthgate

test("the original 49x49 Hearthgate is avoided and never touched", MIN_TIMEOUT, async () => {
    let markers;
    const run = await fullRun(1, {}, () => {
        markers = addOldHearthgate(250, 0);
    });
    assert.match(text(run.player), /1 protected footprint/);
    assert.match(text(run.player), /is built/, text(run.player).slice(-1200));
    for (const k of markers) {
        assert.ok(mc.placed.get(k) === "minecraft:stone_bricks" || mc.placed.get(k) === "minecraft:cobblestone", `marker ${k} survived`);
        assert.ok(!mc.written.has(k), `marker ${k} was never written`);
    }
    for (const k of mc.written) {
        const [x, , z] = k.split(",").map(Number);
        assert.ok(!(x >= 250 - 25 && x <= 250 + 25 && z >= -25 && z <= 25), `write inside the protected footprint at ${k}`);
    }
    assert.ok(run.outcome.site.x < 0, `the site moved away from the old district (centre ${run.outcome.site.x})`);
    const { overlapsExclusion } = await load("civ", "siteselect.js");
    for (const d of run.outcome.plan.districts) {
        assert.equal(overlapsExclusion({ x0: 225, z0: -25, x1: 275, z1: 25 }, [{ polygon: d.outline }], 0), false, `district ${d.index} outline avoids the old footprint`);
    }
});

// ---------------------------------------------------------------------------- player blocks, existing walls, trees

/** Choose ops spread through a stage. */
function pickCells(record, stage, count) {
    const picked = [];
    const list = record[stage];
    for (let i = 0; i < list.length && picked.length < count; i += 1) {
        const ops = siteplan.siteOpsFor(record, stage, i);
        for (let j = Math.floor(ops.length / 3); j < ops.length && picked.length < count; j += 29) picked.push(ops[j]);
    }
    return picked;
}

function rehydrateStored() {
    const payload = planstore.createPlanStore(mc.world).loadPlan().plan;
    const re = siteplan.rehydrateSite(payload.plan, 1, payload.ground, { ...payload.siteOptions, expectChecksum: payload.siteChecksum });
    assert.ok(re.ok, re.problems.join(";"));
    return { payload, record: re.record };
}

test("player blocks and existing walls are never overwritten and are counted as skipped", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    restoreProps(planned.props);
    const { record } = rehydrateStored();
    const protectedBlocks = new Map();
    const place = (op, id) => {
        const k = key(op.x, op.y, op.z);
        mc.placed.set(k, id);
        protectedBlocks.set(k, id);
    };
    pickCells(record, "walls", 24).forEach((op, i) => place(op, ["minecraft:oak_planks", "minecraft:chest", "minecraft:glass", "minecraft:crafting_table"][i % 4]));
    pickCells(record, "roads", 30).forEach((op) => place(op, "minecraft:bookshelf"));
    const treeFree = (op) => {
        for (let dx = -3; dx <= 3; dx += 1) for (let dz = -3; dz <= 3; dz += 1) if (groundCell(op.x + dx, op.z + dz)?.tree) return false;
        return true;
    };
    // (a log standing inside a natural tree is indistinguishable from the tree, so logs go where no tree is near)
    pickCells(record, "lots", 400).filter((op, i) => i % 2 === 0 || treeFree(op)).slice(0, 40).forEach((op, i) => place(op, i % 2 === 0 ? "minecraft:oak_planks" : treeFree(op) ? "minecraft:spruce_log" : "minecraft:oak_planks"));
    const bbox = record.lots[0].bbox;
    const wy = (groundCell(bbox.x0, bbox.z0).g ?? BASE_Y) + 1;
    for (let i = 0; i < 30; i += 1) place({ x: bbox.x0 + i, y: wy, z: bbox.z0 + 3 }, "minecraft:stone_bricks");
    const before = new Map(protectedBlocks);
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/, text(player).slice(-1500));
    const lost = [];
    for (const [k, id] of before) {
        if (typeAt(...k.split(",").map(Number)) !== id) lost.push(k);
    }
    if (lost.length > 0) {
        const detail = [];
        for (const k of lost.slice(0, 3)) {
            const [lx, ly, lz] = k.split(",").map(Number);
            for (const stage of siteplan.SITE_STAGES) {
                record[stage].forEach((el, i) => {
                    for (const op of siteplan.siteOpsFor(record, stage, i)) if (op.x === lx && op.y === ly && op.z === lz) detail.push(`${k} ${stage}/${el.id} ${op.kind}:${op.id} (player ${before.get(k)}, now ${typeAt(lx, ly, lz)})`);
                });
            }
        }
        assert.fail(`player blocks overwritten: ${detail.join(" | ")}`);
    }
    assert.equal(lost.length, 0);
    const skipped = Number(/skipped (\d+), failed/.exec(text(player))?.[1]);
    assert.ok(skipped >= 20, `skips are counted (${skipped})`);
    assert.match(text(player), /Skipped \(never overwritten\):[\s\S]*\d+x occupied by minecraft:bookshelf/);
    assert.equal(civRecord().status, "complete");
});

test("a player-made tree (persistent leaves) and a log-only pillar are left alone; natural trees are cleared", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    restoreProps(planned.props);
    const { record } = rehydrateStored();
    const [wallOp] = pickCells(record, "walls", 1);
    const [roadOp] = pickCells(record, "roads", 1);
    const mine = new Set();
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
            for (const dy of [0, 1]) {
                const k = key(wallOp.x + dx, wallOp.y + dy, wallOp.z + dz);
                mc.placed.set(k, "minecraft:oak_leaves");
                mine.add(k);
            }
        }
    }
    mc.persistent = (x, y, z) => mine.has(key(x, y, z));
    for (let dy = 0; dy < 3; dy += 1) {
        const k = key(roadOp.x, roadOp.y + dy, roadOp.z);
        mc.placed.set(k, "minecraft:oak_log");
        mine.add(k);
    }
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/);
    for (const k of mine) assert.ok(["minecraft:oak_leaves", "minecraft:oak_log"].includes(mc.placed.get(k)), `${k} survived`);
    assert.match(text(player), /[1-9]\d* tree\(s\) left alone/);
    assert.match(text(player), /Natural trees cleared [1-9]/);
});

// ---------------------------------------------------------------------------- pause / abort / resume / restart

test("a clean resume from the stored plan builds the identical world", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const planned = await plannedOnly();
    await restart();
    restoreProps(planned.props);
    const player = makePlayer();
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /Verified plan [0-9a-f]{8}/);
    assert.match(text(player), /is built/);
    assertSameWorld(worldFingerprint(), base.fp, "resume");
});

test("abort twice mid-build and resume (same process) gives the identical world; the queue is kept", MIN_TIMEOUT, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    for (const target of [30, 70]) {
        await pump({ until: () => (builder.sessionStatus()?.pct ?? 0) >= target });
        const midWrites = mc.writes;
        assert.ok(midWrites > 0 && builder.hasSession());
        send(CIV_EVENT_IDS.abort, "", player);
        await pump();
        assert.match(text(player), /Civilization build stopped/);
        assert.equal(builder.hasSession(), false);
        assert.equal(districtBuilder.isBusy(), false);
        assert.equal(mc.writes, midWrites, "no write after the abort");
        assert.equal(civRecord().status, "paused");
        const stored = jobsModule.createJobStore(mc.world).loadQueue({ recoverRunning: false });
        assert.equal(stored.status, "ok");
        assert.equal(stored.queue.state, "paused");
        const overall = jobsModule.progress(stored.queue);
        assert.ok(overall.pct >= target - 1 && overall.pct < 100, `progress kept (${overall.pct}%)`);
        send(CIV_EVENT_IDS.resume, "", player);
    }
    await pump();
    assert.match(text(player), /is built/);
    assertSameWorld(worldFingerprint(), base.fp, "abort/resume");
});

test("process crashes at three points; each restart reloads only from the property store and the world ends identical", { timeout: 600000 }, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    let died = 0;
    for (const at of [4000, 21000, 47000]) {
        mc.dieAtWrites = at;
        await pump({ stopOnDead: true });
        assert.equal(mc.dead, true, `process died at ${at} writes`);
        died += 1;
        const writtenAtDeath = mc.written.size;
        await restart();
        assert.equal(mc.written.size, writtenAtDeath);
        const revived = makePlayer();
        revived.sendMessage = (m) => player.messages.push(...(Array.isArray(m) ? m : [m]));
        send(CIV_EVENT_IDS.resume, "", revived);
    }
    mc.dieAtWrites = null;
    await pump();
    assert.equal(died, 3);
    assert.match(text(player), /is built/, text(player).slice(-1200));
    assertSameWorld(worldFingerprint(), base.fp, "crash/restart");
    assert.equal(civRecord().status, "complete");
});

test("a chunk that stays unloaded pauses the build with a saved cursor; resuming finishes identically", MIN_TIMEOUT, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    let blackout = false;
    mc.unloaded = () => blackout;
    await pump({ until: () => mc.writes >= 25000 });
    blackout = true;
    await pump();
    assert.match(text(player), /Build paused/);
    assert.match(text(player), /not loaded/);
    assert.equal(builder.hasSession(), false);
    assert.equal(districtBuilder.isBusy(), false);
    assert.equal(mc.areas.size, 0);
    assert.equal(civRecord().status, "paused");
    const stored = jobsModule.createJobStore(mc.world).loadQueue({ recoverRunning: false });
    const overall = jobsModule.progress(stored.queue);
    assert.ok(overall.pct > 20 && overall.pct < 100, `cursor saved (${overall.pct}%)`);
    blackout = false;
    send(CIV_EVENT_IDS.resume, "", player);
    await pump();
    assert.match(text(player), /is built/);
    assertSameWorld(worldFingerprint(), base.fp, "unloaded pause");
});

// ---------------------------------------------------------------------------- resume refusals

test("resume refuses on a checksum mismatch, a version mismatch, a corrupt ground and a foreign queue - without writing", MIN_TIMEOUT, async () => {
    const planned = await plannedOnly();
    async function refused(tamper, message) {
        await restart();
        restoreProps(planned.props);
        tamper();
        const player = makePlayer();
        send(CIV_EVENT_IDS.resume, "", player);
        await pump();
        assert.match(text(player), message, text(player));
        assert.equal(mc.writes, 0);
        assert.equal(districtBuilder.isBusy(), false);
    }
    const store2 = () => planstore.createPlanStore(mc.world);
    await refused(() => {
        const k = store.load().kingdom;
        districtById(k, "district-1").civ.checksum = "00000000";
        store.save(k);
    }, /not the one this district was started from/);
    await refused(() => {
        const payload = store2().loadPlan().plan;
        payload.site.version = 99;
        assert.ok(store2().savePlan(payload).ok);
    }, /site version 99/);
    await refused(() => {
        const payload = store2().loadPlan().plan;
        payload.ground.g = payload.ground.g.slice(0, -40) + "A".repeat(40);
        assert.ok(store2().savePlan(payload).ok);
    }, /unusable|could not be rebuilt/);
    await refused(() => {
        const queue = jobsModule.createQueue({ clear: [{ total: 10, hash: 1 }] }, { planHash: "zzzz" });
        assert.ok(jobsModule.createJobStore(mc.world).saveQueue(queue).ok);
    }, /does not belong to this plan/);
    await refused(() => {
        for (const k of [...mc.props.keys()]) if (k.startsWith("civ:plan")) mc.props.delete(k);
    }, /stored plan is absent/);
    await refused(() => {
        const k = store.load().kingdom;
        delete districtById(k, "district-1").civ;
        store.save(k);
    }, /no generated civilization to resume/);
});

// ---------------------------------------------------------------------------- exclusion, gating, determinism, hooks

test("a second command while a job runs is refused; a second generate after completion is refused", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    await pump({ until: () => (builder.sessionStatus()?.pct ?? 0) >= 5 });
    const writes = mc.writes;
    const other = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, other);
    send(CIV_EVENT_IDS.plan, GEN, other);
    send(CIV_EVENT_IDS.resume, "", other);
    await flush();
    assert.equal((text(other).match(/already running/g) ?? []).length, 3, text(other));
    send(CIV_EVENT_IDS.status, "", other);
    await flush();
    assert.match(text(other) + mc.messages.join("\n"), /Running \(building\)/);
    assert.ok(mc.writes >= writes);
    await pump();
    assert.match(text(player), /is built/);
    const again = makePlayer();
    await generate(again);
    assert.match(text(again), /already exists here \(complete\)/);
    const token = districtBuilder.reserveJob("scout");
    assert.ok(token);
    const third = makePlayer();
    await generate(third);
    assert.match(text(third), /already running/);
    districtBuilder.finishJob(token);
});

test("the development gate: districts= is refused, and even with the gate on it says not enabled", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, "districts=1,2,3", player);
    await pump();
    assert.match(text(player), /districts 2-5 is not available yet/i);
    send(CIV_EVENT_IDS.devgate, "on", player);
    assert.equal(mc.props.get(CIV.devGateKey), true);
    const p2 = makePlayer();
    send(CIV_EVENT_IDS.generate, "districts=1,2,3", p2);
    await pump();
    assert.match(text(p2), /not enabled in this build/);
    send(CIV_EVENT_IDS.devgate, "off", player);
    assert.equal(mc.props.get(CIV.devGateKey), false);
    assert.equal(mc.writes, 0);
    assert.equal(mc.reads, 0);
    assert.equal(mc.jobs.length, 0);
});

test("status and abort answer sensibly when nothing is running", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.status, "", player);
    send(CIV_EVENT_IDS.abort, "", player);
    await flush();
    const all = mc.messages.join("\n") + text(player);
    assert.match(all, /Not generated/);
    assert.match(all, /No civilization job is running/);
    assert.equal(mc.writes, 0);
});

test("the gate linker runs once, after the gates stage, and its changes are saved", MIN_TIMEOUT, async () => {
    resetWorld(1);
    const calls = [];
    civCommands.setGateLinker((kingdom, record, plan) => {
        const q = builder.getSession().queue;
        calls.push({ gatesDone: jobsModule.stageSatisfied(q, "gates"), lotsDone: jobsModule.stageSatisfied(q, "lots"), gates: record.gates.length, planGates: plan.gates.length });
        districtById(kingdom, "district-2").linkedByTest = true;
        return { linked: record.gates.length };
    });
    const player = makePlayer();
    await generate(player);
    assert.match(text(player), /is built/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].gatesDone, true);
    assert.equal(calls[0].lotsDone, false, "called when the gates stage completed, not at the end");
    assert.ok(calls[0].gates > 0);
    assert.equal(districtById(store.load().kingdom, "district-2").linkedByTest, true);
    assert.equal(civRecord().gates, true);
    assert.match(text(player), /Gates registered with the simulation \(initially open\)/);
});

test("state fallbacks are counted and reported", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.rejectStates = (id) => id.includes("door") || id.includes("lever");
    const player = makePlayer();
    await generate(player);
    assert.match(text(player), /is built/);
    const fallbacks = Number(/state fallbacks (\d+)/.exec(text(player))?.[1]);
    assert.ok(fallbacks > 0, `fallbacks ${fallbacks}`);
    assert.match(text(player), /WARNING: some blocks were placed without their facing/);
});

test("determinism: the same seed yields an identical stored plan; another seed differs", { timeout: 600000 }, async () => {
    const a = await plannedOnly(1, 1);
    const b = await plannedOnly(1, 1);
    const c = await plannedOnly(1, 3);
    const planKeys = (snapshot) => [...snapshot.entries()].filter(([k]) => k.startsWith("civ:plan") || k.startsWith("civ:jobs")).sort(([x], [y]) => (x < y ? -1 : 1));
    assert.deepEqual(planKeys(a.props), planKeys(b.props));
    assert.notDeepEqual(planKeys(a.props), planKeys(c.props));
    assert.equal(a.outcome.record.checksum, b.outcome.record.checksum);
    assert.notEqual(a.outcome.record.checksum, c.outcome.record.checksum);
});

test("measured numbers for the report", MIN_TIMEOUT, async () => {
    const base = await baseline();
    const o = base.outcome;
    console.log(
        JSON.stringify({
            ops: siteplan.siteOpCount(o.record),
            slicesPlanned: Math.ceil(siteplan.siteOpCount(o.record) / CIV_LIMITS.maxBlocksPerSlice),
            coarse: o.stats.coarse,
            fine: o.stats.fine,
            storage: o.stats.storage,
            maxReadsPerSlice: base.stats.reads,
            maxWritesPerSlice: base.stats.writes,
            totalJobSlices: base.stats.slices,
            totalWrites: base.stats.totalWrites,
        }),
    );
});

test("process crashes at eight more points (dense sweep) - the world still ends identical", { timeout: 600000 }, async () => {
    const base = await baseline();
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.generate, GEN, player);
    for (const at of [300, 1700, 9100, 13300, 30500, 38800, 52500, 61000]) {
        mc.dieAtWrites = at;
        await pump({ stopOnDead: true });
        assert.equal(mc.dead, true, `process died at ${at} writes`);
        await restart();
        const revived = makePlayer();
        revived.sendMessage = (m) => player.messages.push(...(Array.isArray(m) ? m : [m]));
        send(CIV_EVENT_IDS.resume, "", revived);
    }
    mc.dieAtWrites = null;
    await pump();
    assert.match(text(player), /is built/, text(player).slice(-1200));
    assertSameWorld(worldFingerprint(), base.fp, "dense crash sweep");
});

test("abort during the survey and during planning stops cleanly with zero writes", MIN_TIMEOUT, async () => {
    for (const reads of [3000, 80000]) {
        resetWorld(1);
        const player = makePlayer();
        send(CIV_EVENT_IDS.generate, GEN, player);
        await pump({ until: () => mc.reads >= reads });
        assert.ok(districtBuilder.isBusy(), "the pipeline is running");
        send(CIV_EVENT_IDS.abort, "", player);
        await pump();
        assert.equal(districtBuilder.isBusy(), false);
        assert.equal(mc.areas.size, 0, "chunks released");
        assert.equal(mc.writes, 0);
        assert.deepEqual(noCivData(), []);
        assert.equal(civRecord(), undefined);
        assert.match(mc.messages.join(" ") + text(player), /Nothing was written/);
        mc.messages.length = 0;
    }
});

test("no ticking-area capacity: the survey relies on loaded chunks and says so (still read-only)", MIN_TIMEOUT, async () => {
    resetWorld(1);
    mc.noCapacity = true;
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, GEN, player);
    await pump();
    assert.match(text(player), /Plan is valid/);
    assert.ok(outcome.stats.coarse.unheldTiles > 0);
    assert.match(outcome.stats.coarse.notes.join(" "), /no ticking-area capacity/);
    assert.equal(mc.writes, 0);
});

test("radius=400 (the maximum) scans further and still plans; radius is bounded per slice too", { timeout: 600000 }, async () => {
    resetWorld(1);
    let outcome;
    builder.seams.onOutcome = (o) => {
        outcome = o;
    };
    const player = makePlayer();
    send(CIV_EVENT_IDS.plan, `radius=${CIV.maxSearchRadius} ${GEN}`, player);
    await pump();
    assert.match(text(player), /Plan is valid/, text(player).slice(-800));
    assert.ok(outcome.stats.coarse.columns > 25000, `coarse columns ${outcome.stats.coarse.columns}`);
    assert.ok(mc.maxReadsPerSlice <= CIV_LIMITS.maxReadsPerSlice);
    assert.equal(mc.writes, 0);
    console.log(JSON.stringify({ radius400: { columns: outcome.stats.coarse.columns, reads: outcome.stats.coarse.reads, slices: outcome.stats.coarse.slices } }));
});

