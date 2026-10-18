// The Bedrock-facing half of the physical district (commands/physical.js +
// integration/districtBuilder.js) executed against a fake world: a block grid with natural
// ground, a job runner that drives system.runJob generators, a ticking-area manager and a
// player. It proves the safety contract (no write without `confirm`, never over an
// obstruction, never over a player build, resumable, bounded) - NOT that the real engine
// accepts the block states; that needs the game.
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;

const GROUND_Y = 63; // top surface block; the player stands at y = 64
const mc = {
    properties: new Map(),
    worldMessages: [],
    scriptEventSubscribers: [],
    jobs: [],
    nextJob: 1,
    writes: 0,
    tickingAreas: new Set(),
    tickingLog: [],
    blocks: new Map(),
    unloaded: () => false,
    rejectStates: () => false,
};
globalThis.__mc3 = mc;

const key = (x, y, z) => `${x},${y},${z}`;
function typeAt(x, y, z) {
    const placed = mc.blocks.get(key(x, y, z));
    if (placed !== undefined) return placed;
    if (y === GROUND_Y) return "minecraft:grass_block";
    if (y < GROUND_Y) return "minecraft:dirt";
    return "minecraft:air";
}

const dimension = {
    id: "minecraft:overworld",
    getBlock(position) {
        if (mc.unloaded(position)) return undefined;
        const { x, y, z } = position;
        return {
            isValid: true,
            get typeId() {
                return typeAt(x, y, z);
            },
            location: { x, y, z },
            setPermutation(permutation) {
                mc.writes += 1;
                mc.blocks.set(key(x, y, z), permutation.id);
            },
        };
    },
};

mc.world = {
    afterEvents: { playerSpawn: { subscribe() {} } },
    getDynamicProperty: (k) => mc.properties.get(k),
    setDynamicProperty(k, v) {
        if (typeof v === "string" && v.length > 32767) throw new RangeError("too long");
        if (v === undefined) mc.properties.delete(k);
        else mc.properties.set(k, v);
    },
    getDimension: () => dimension,
    sendMessage: (m) => mc.worldMessages.push(m),
    tickingAreaManager: {
        hasTickingArea: (id) => mc.tickingAreas.has(id),
        removeTickingArea(id) {
            mc.tickingAreas.delete(id);
            mc.tickingLog.push(`remove ${id}`);
        },
        hasCapacity: () => true,
        async createTickingArea(id) {
            mc.tickingAreas.add(id);
            mc.tickingLog.push(`create ${id}`);
        },
    },
};
mc.system = {
    afterEvents: { scriptEventReceive: { subscribe: (callback, options) => mc.scriptEventSubscribers.push({ callback, options }) } },
    runInterval: () => 1,
    clearRun() {},
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
        const stub = 'export const world = globalThis.__mc3.world; export const system = globalThis.__mc3.system;' +
            'export const BlockPermutation = globalThis.__mc3.BlockPermutation;' +
            'export const ScriptEventSource = { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" };';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));

const load = (...parts) => import(fileUrl(...parts));
const { createKingdomStore } = await load("kingdom", "store.js");
const { registerPhysicalCommands } = await load("commands", "physical.js");
const { planDistrict } = await load("structures", "planner.js");
const { districtById, findValidationProblems } = await load("kingdom", "state.js");
const { advanceKingdom } = await load("sim", "tick.js");
const { cancelActiveJob, isBusy } = await load("integration", "districtBuilder.js");
const { PHYSICAL } = await load("config.js");

const store = createKingdomStore(mc.world);
registerPhysicalCommands(store);
const handler = mc.scriptEventSubscribers[0];

function makePlayer(x = 100, z = 200) {
    const messages = [];
    return {
        typeId: "minecraft:player",
        isValid: true,
        location: { x: x + 0.5, y: GROUND_Y + 1, z: z + 0.5 },
        dimension,
        messages,
        sendMessage: (m) => messages.push(...(Array.isArray(m) ? m : [m])),
    };
}

function send(id, message, source) {
    handler.callback({ id, message, sourceType: "Entity", sourceEntity: source, initiator: source });
}

/** Run queued jobs to completion (microtasks first, so ticking-area promises settle). */
async function settle(maxSteps = 1e7) {
    let steps = 0;
    for (let round = 0; round < 50; round += 1) {
        await Promise.resolve();
        while (mc.jobs.length > 0 && steps < maxSteps) {
            const job = mc.jobs[0];
            const result = job.generator.next();
            steps += 1;
            if (result.done) mc.jobs = mc.jobs.filter((entry) => entry !== job);
        }
        await new Promise((done) => setImmediate(done));
        if (mc.jobs.length === 0) break;
    }
}

function reset() {
    cancelActiveJob();
    mc.properties.clear();
    mc.worldMessages.length = 0;
    mc.blocks.clear();
    mc.jobs.length = 0;
    mc.writes = 0;
    mc.tickingAreas.clear();
    mc.tickingLog.length = 0;
    mc.unloaded = () => false;
    mc.rejectStates = () => false;
    store.ensureInitial();
}

const text = (player) => player.messages.join("\n");
const record = () => districtById(store.load().kingdom, "district-1").physical;
const plan = planDistrict(districtById((reset(), store.load().kingdom), "district-1"));

test("dry run surveys the site, writes nothing, records nothing, and tells the player how to confirm", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.equal(record(), undefined);
    assert.match(text(player), /survey \(dry run\)/);
    assert.match(text(player), /Site is clear: \d+ blocks to place/);
    assert.match(text(player), /civ:district_generate district-1 confirm/);
    assert.deepEqual(mc.tickingLog, ["create civ-district-build", "remove civ-district-build"], "chunks are held for the survey and released");
    assert.equal(isBusy(), false);
});

test("confirm builds the whole district, records it, and releases the chunks", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "district-1 confirm", player);
    await settle();
    const saved = record();
    assert.equal(saved.status, "complete");
    assert.equal(saved.placed, plan.blockCount);
    assert.deepEqual(saved.origin, { x: 100, y: 64, z: 200 });
    assert.equal(saved.dimension, "minecraft:overworld");
    assert.equal(saved.planHash.length, 8);
    assert.match(text(player), /is built/);
    assert.equal(mc.tickingAreas.size, 0);
    assert.deepEqual(findValidationProblems(store.load().kingdom), []);

    // every planned block really is in the world, at the right place
    for (const block of plan.blocks) {
        assert.equal(typeAt(100 + block.x, 64 + block.y, 200 + block.z), block.id, `${block.id} at ${block.x},${block.y},${block.z}`);
    }
    // nothing outside the footprint was touched
    for (const placedKey of mc.blocks.keys()) {
        const [x, y, z] = placedKey.split(",").map(Number);
        assert.ok(Math.abs(x - 100) <= 24 && Math.abs(z - 200) <= 24 && y >= 63 && y <= 64 + 12, `stray write at ${placedKey}`);
    }
    // placement is bounded: never more writes than planned blocks
    assert.equal(mc.writes, plan.blockCount);

    // a second request does not build twice
    const before = mc.writes;
    send("civ:district_generate", "district-1 confirm", player);
    await settle();
    assert.equal(mc.writes, before);
    assert.match(text(player), /already has a physical record/);
});

test("the simulation is untouched by generation: same state apart from the physical record", async () => {
    reset();
    const before = structuredClone(store.load().kingdom);
    const player = makePlayer();
    send("civ:district_generate", "confirm", player);
    await settle();
    const after = structuredClone(store.load().kingdom);
    delete after.districts[0].physical;
    assert.deepEqual(after, before);
    // and the simulation keeps running over a district that has a physical body
    const live = store.load().kingdom;
    advanceKingdom(live, 12);
    assert.deepEqual(findValidationProblems(live), []);
    assert.equal(live.districts[0].physical.status, "complete", "ticks never drop the record");
    assert.equal(live.districts[0].buildings.walls, before.districts[0].buildings.walls, "sim walls untouched");
});

test("an obstruction anywhere in the footprint refuses the site and changes nothing", async () => {
    reset();
    mc.blocks.set(key(105, 64 + 5, 205), "minecraft:oak_log");
    const player = makePlayer();
    send("civ:district_generate", "district-1 confirm", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.equal(record(), undefined);
    assert.match(text(player), /Site refused - nothing was changed/);
    assert.match(text(player), /occupied by minecraft:oak_log/);
    assert.equal(mc.tickingAreas.size, 0);
});

test("a player build on a planned cell refuses the site", async () => {
    reset();
    const target = plan.blocks.find((block) => block.y === 0);
    mc.blocks.set(key(100 + target.x, 64, 200 + target.z), "minecraft:chest");
    const player = makePlayer();
    send("civ:district_generate", "district-1 confirm", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /Site refused/);
    assert.equal(typeAt(100 + target.x, 64, 200 + target.z), "minecraft:chest");
});

test("ground that is not natural terrain refuses the site (no building on water, floors or voids)", async () => {
    reset();
    mc.blocks.set(key(110, GROUND_Y, 210), "minecraft:water");
    const player = makePlayer();
    send("civ:district_generate", "district-1 confirm", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /not natural terrain/);
});

test("a cell occupied after the survey is refused at placement, never overwritten", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "district-1 confirm", player);
    // run only until the build job is queued (survey finished), then plant a player block
    for (let round = 0; round < 50 && !(mc.jobs.length === 0 && record()?.status === "building"); round += 1) {
        await Promise.resolve();
        const job = mc.jobs[0];
        if (job === undefined) {
            await new Promise((done) => setImmediate(done));
            continue;
        }
        const result = job.generator.next();
        if (result.done) mc.jobs.shift();
        if (record()?.status === "building" && mc.writes === 0 && mc.jobs.length === 1) break;
    }
    const victim = plan.blocks.find((block) => block.y === 3 && block.id === "minecraft:stone_bricks");
    mc.blocks.set(key(100 + victim.x, 64 + victim.y, 200 + victim.z), "minecraft:diamond_block");
    await settle();
    assert.equal(typeAt(100 + victim.x, 64 + victim.y, 200 + victim.z), "minecraft:diamond_block", "player block survives");
    assert.match(text(player), /Build finished with problems/);
    assert.match(text(player), /refused: occupied by minecraft:diamond_block/);
    assert.equal(record().status, "building", "not marked complete while cells were refused");
    assert.equal(record().placed, 0, "a resume will re-check everything");
});

test("unloaded chunks pause the build with a saved cursor, and resume finishes it without redoing work", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "district-1 confirm", player);
    // after the survey passes, the east half of the footprint "unloads"
    let armed = false;
    mc.unloaded = (position) => armed && position.x > 112;
    for (let guard = 0; guard < 2000 && !armed; guard += 1) {
        await Promise.resolve();
        const job = mc.jobs[0];
        if (job) {
            const result = job.generator.next();
            if (result.done) mc.jobs.shift();
        } else await new Promise((done) => setImmediate(done));
        if (record()?.status === "building") armed = true;
    }
    assert.ok(armed, "build started");
    await settle();
    const paused = record();
    assert.equal(paused.status, "building");
    assert.ok(paused.placed > 0 && paused.placed < plan.blockCount, `cursor saved mid-way: ${String(paused.placed)}`);
    assert.match(text(player), /Build paused/);
    assert.match(text(player), /civ:district_resume/);
    assert.equal(mc.tickingAreas.size, 0);

    mc.unloaded = () => false;
    const writesBefore = mc.writes;
    send("civ:district_resume", "", player);
    await settle();
    assert.equal(record().status, "complete");
    assert.ok(mc.writes - writesBefore < plan.blockCount, "resume does not redo finished work");
    for (const block of plan.blocks) {
        assert.equal(typeAt(100 + block.x, 64 + block.y, 200 + block.z), block.id);
    }
});

test("abort stops the job; blocks stay; resume completes", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "confirm", player);
    for (let guard = 0; guard < 2000; guard += 1) {
        await Promise.resolve();
        const job = mc.jobs[0];
        if (job) {
            const result = job.generator.next();
            if (result.done) mc.jobs.shift();
        } else await new Promise((done) => setImmediate(done));
        if (mc.writes > 500) break;
    }
    send("civ:district_abort", "", player);
    assert.equal(isBusy(), false);
    assert.equal(mc.jobs.length, 0);
    const kept = mc.writes;
    await settle();
    assert.equal(mc.writes, kept, "nothing more is placed after abort");
    assert.equal(record().status, "building");
    send("civ:district_resume", "", player);
    await settle();
    assert.equal(record().status, "complete");
});

test("only one physical job at a time, and only for a real player on district-1", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "confirm", player);
    await Promise.resolve();
    send("civ:district_generate", "confirm", player);
    assert.match(text(player), /already running/);
    cancelActiveJob();
    mc.jobs.length = 0;

    reset();
    const other = makePlayer();
    send("civ:district_generate", "district-2 confirm", other);
    assert.match(text(other), /Only district-1 has a physical layout/);

    reset();
    send("civ:district_generate", "confirm", { typeId: "minecraft:cow", location: { x: 0, y: 64, z: 0 }, dimension, sendMessage() {} });
    assert.match(String(mc.worldMessages.flat().join("\n")), /Run this as a player/);
    assert.equal(mc.writes, 0);
});

test("block states the engine rejects fall back to plain blocks instead of aborting the district", async () => {
    reset();
    mc.rejectStates = (id) => id === "minecraft:wooden_door";
    const player = makePlayer();
    send("civ:district_generate", "confirm", player);
    await settle();
    assert.equal(record().status, "complete");
    assert.match(text(player), /state fallbacks [1-9]/);
    assert.match(text(player), /minecraft:wooden_door: states rejected/);
});

test("status reports the record and no job; resume without a build is refused", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_status", "", player);
    assert.match(text(player), /Hearthgate: not generated/);
    send("civ:district_resume", "", player);
    assert.match(text(player), /no interrupted physical build/);
});

test("resume refuses when the blueprint changed since the build started", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "confirm", player);
    await settle();
    const loaded = store.load();
    districtById(loaded.kingdom, "district-1").physical = { ...record(), status: "building", planHash: "deadbeef" };
    store.save(loaded.kingdom);
    send("civ:district_resume", "", player);
    assert.match(text(player), /blueprint changed/);
});

test("abort during the survey then an immediate re-run never starts two builds", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "confirm", player);
    send("civ:district_abort", "", player);
    send("civ:district_generate", "confirm", player);
    await settle();
    assert.equal(record().status, "complete");
    assert.equal(mc.writes, plan.blockCount, "exactly one build ran");
    assert.equal(mc.tickingAreas.size, 0);
});

test("a build resumes even after the simulation changed the live building counts", async () => {
    reset();
    const player = makePlayer();
    send("civ:district_generate", "confirm", player);
    for (let guard = 0; guard < 2000; guard += 1) {
        await Promise.resolve();
        const job = mc.jobs[0];
        if (job) {
            const result = job.generator.next();
            if (result.done) mc.jobs.shift();
        } else await new Promise((done) => setImmediate(done));
        if (mc.writes > 800) break;
    }
    send("civ:district_abort", "", player);
    const loaded = store.load();
    districtById(loaded.kingdom, "district-1").buildings.homes = 2;
    store.save(loaded.kingdom);
    send("civ:district_resume", "", player);
    await settle();
    assert.equal(record().status, "complete");
    for (const block of plan.blocks) {
        assert.equal(typeAt(100 + block.x, 64 + block.y, 200 + block.z), block.id);
    }
});
