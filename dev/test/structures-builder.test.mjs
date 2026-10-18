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
    persistent: () => false,
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
    getTopmostBlock({ x, z }) {
        if (mc.unloaded({ x, y: 64, z })) return undefined;
        for (let y = 200; y >= 0; y -= 1) {
            if (typeAt(x, y, z) !== "minecraft:air") return this.getBlock({ x, y, z });
        }
        return undefined;
    },
    getBlock(position) {
        if (mc.unloaded(position)) return undefined;
        const { x, y, z } = position;
        return {
            isValid: true,
            get typeId() {
                return typeAt(x, y, z);
            },
            location: { x, y, z },
            permutation: { getState: (name) => (name === "persistent_bit" ? mc.persistent(x, y, z) : undefined) },
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
    mc.persistent = () => false;
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
    assert.match(text(player), /civ:district_generate district-1 at 100 200 maxcut=4 maxfill=4 confirm/);
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
    assert.match(text(player), /log-only structure/);
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
    assert.match(text(player), /water at y=63/);
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

// ---- natural terrain ---------------------------------------------------------------------
const grass = "minecraft:grass_block";
function setGround(x, z, height) {
    for (let y = GROUND_Y + 1; y <= height; y += 1) mc.blocks.set(key(x, y, z), y === height ? grass : "minecraft:dirt");
    for (let y = height + 1; y <= GROUND_Y; y += 1) mc.blocks.set(key(x, y, z), "minecraft:air");
    if (height < GROUND_Y) mc.blocks.set(key(x, height, z), grass);
}
function plantTree(x, z, base = GROUND_Y + 1) {
    for (let y = base; y < base + 4; y += 1) mc.blocks.set(key(x, y, z), "minecraft:oak_log");
    for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) for (let y = base + 3; y <= base + 4; y += 1) if (!mc.blocks.has(key(x + dx, y, z + dz))) mc.blocks.set(key(x + dx, y, z + dz), "minecraft:oak_leaves");
}
function naturalSite() {
    for (let x = 100 - 24; x <= 100 + 24; x += 1) for (let z = 200 - 24; z <= 200 + 24; z += 1) {
        if (x >= 105 && x <= 112 && z >= 205 && z <= 212) setGround(x, z, GROUND_Y + 2);
        else if ((x + z) % 7 === 0) mc.blocks.set(key(x, GROUND_Y + 1, z), "minecraft:poppy");
        else if ((x * 3 + z) % 5 === 0) mc.blocks.set(key(x, GROUND_Y + 1, z), "minecraft:short_grass");
    }
    plantTree(90, 190);
    plantTree(125, 200); // canopy reaches x=124, the footprint's last column
}
const fpOf = (player) => /terrain=([0-9a-f]{8})/.exec(text(player))?.[1];

test("ground height comes from the world, not from the player's y (player floating high above)", async () => {
    reset();
    const player = makePlayer();
    player.location.y = 120;
    send("civ:district_generate", "district-1 confirm", player);
    await settle();
    assert.equal(record().status, "complete");
    assert.deepEqual(record().origin, { x: 100, y: 64, z: 200 }, "platform sits on the real surface");
});

test("hills, flowers, grass and trees: survey is read-only, confirm needs the survey's code, then the terrain is prepared", async () => {
    reset();
    naturalSite();
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0, "survey wrote nothing");
    assert.equal(record(), undefined);
    assert.match(text(player), /Terrain work: cut \d+, fill \d+, resurface \d+, clear \d+/);
    const code = fpOf(player);
    assert.ok(code, "survey prints the approval code");

    player.messages.length = 0;
    send("civ:district_generate", "district-1 confirm", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /needs terrain changes, which need explicit approval/);

    player.messages.length = 0;
    send("civ:district_generate", `district-1 maxcut=4 maxfill=4 confirm terrain=${code}`, player);
    await settle();
    const saved = record();
    assert.equal(saved.status, "complete", text(player));
    assert.equal(saved.terrain.mode, "terraced");
    assert.ok(saved.terrain.cut > 0 && saved.terrain.clear > 0);
    const origin = saved.origin;
    for (const block of plan.blocks) assert.equal(typeAt(origin.x + block.x, origin.y + block.y, origin.z + block.z), block.id);
    for (let x = 76; x <= 124; x += 1) {
        for (let z = 176; z <= 224; z += 1) {
            for (let y = origin.y + 13; y < 120; y += 1) assert.equal(typeAt(x, y, z), "minecraft:air", `leftover above the district at ${x},${y},${z}`);
            assert.notEqual(typeAt(x, origin.y - 1, z), "minecraft:air", "platform has solid ground under it");
        }
    }
    assert.equal(typeAt(90, GROUND_Y + 1, 190), "minecraft:air", "the natural tree inside the footprint was cleared");
    assert.equal(typeAt(125, GROUND_Y + 1, 200), "minecraft:oak_log", "trunk outside the footprint untouched");
    assert.equal(typeAt(126, GROUND_Y + 4, 200), "minecraft:oak_leaves", "canopy outside the footprint untouched");
    assert.deepEqual(findValidationProblems(store.load().kingdom), []);
});

test("a stale survey code is refused: the world changed after it was approved", async () => {
    reset();
    naturalSite();
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    const code = fpOf(player);
    mc.blocks.set(key(97, GROUND_Y + 1, 203), "minecraft:dandelion");
    mc.blocks.set(key(98, GROUND_Y + 1, 203), "minecraft:dandelion");
    player.messages.length = 0;
    send("civ:district_generate", `district-1 confirm terrain=${code}`, player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /no longer matches the survey/);
});

test("a player build inside the footprint refuses the whole site, terrain untouched", async () => {
    reset();
    naturalSite();
    mc.blocks.set(key(110, GROUND_Y + 1, 190), "minecraft:oak_planks");
    mc.blocks.set(key(110, GROUND_Y + 2, 190), "minecraft:oak_planks");
    const player = makePlayer();
    send("civ:district_generate", "district-1 confirm terrain=00000000", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /oak_planks.*not natural terrain/);
    assert.equal(record(), undefined);
});

test("a tree touching a player build is not treated as natural", async () => {
    reset();
    plantTree(90, 190);
    mc.blocks.set(key(92, GROUND_Y + 4, 190), "minecraft:oak_planks");
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /Site refused/);
});

test("persistent (player-placed) leaves refuse the site", async () => {
    reset();
    plantTree(90, 190);
    mc.persistent = () => true;
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /persistent leaves/);
});

test("cliffs are refused with a reason; raising the cut limit is explicit and capped", async () => {
    reset();
    for (let x = 95; x <= 100; x += 1) for (let z = 195; z <= 205; z += 1) setGround(x, z, GROUND_Y + 12);
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.match(text(player), /too uneven/);
    assert.equal(mc.writes, 0);
    player.messages.length = 0;
    send("civ:district_generate", "district-1 maxcut=6", player);
    assert.match(text(player), /terrain limits: cut 6/);
    await settle();
    player.messages.length = 0;
    send("civ:district_generate", "district-1 maxcut=99", player);
    assert.match(text(player), /maxcut must be a whole number from 0 to 6/);
});

test("scout is read-only and proposes survey commands that work", async () => {
    reset();
    for (let x = 60; x <= 104; x += 1) for (let z = 150; z <= 250; z += 1) mc.blocks.set(key(x, GROUND_Y, z), "minecraft:water");
    const player = makePlayer();
    send("civ:district_scout", "48", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.equal(record(), undefined);
    assert.match(text(player), /Best \d site\(s\)/);
    const command = /survey: \/scriptevent civ:district_generate district-1 at (-?\d+) (-?\d+)/.exec(text(player));
    assert.ok(command, text(player));
    player.messages.length = 0;
    send("civ:district_generate", `district-1 at ${command[1]} ${command[2]}`, player);
    await settle();
    assert.match(text(player), /Site is clear|Terrain work/);
    assert.equal(mc.writes, 0);
    assert.equal(mc.tickingAreas.size, 0);
});

test("scout reports why nothing fits", async () => {
    reset();
    for (let x = 40; x <= 160; x += 1) for (let z = 120; z <= 280; z += 1) mc.blocks.set(key(x, GROUND_Y, z), "minecraft:water");
    const player = makePlayer();
    send("civ:district_scout", "", player);
    await settle();
    assert.match(text(player), /No suitable site found/);
    assert.match(text(player), /water/);
    player.messages.length = 0;
    send("civ:district_scout", "3", player);
    assert.match(text(player), /between 8 and 48/);
});

test("an interrupted terrain phase resumes from the saved platform height and completes", async () => {
    reset();
    naturalSite();
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    const code = fpOf(player);
    send("civ:district_generate", `district-1 confirm terrain=${code}`, player);
    for (let guard = 0; guard < 4000; guard += 1) {
        await Promise.resolve();
        const job = mc.jobs[0];
        if (job) {
            const result = job.generator.next();
            if (result.done) mc.jobs.shift();
        } else await new Promise((done) => setImmediate(done));
        if (mc.writes > 600) break;
    }
    assert.equal(record().phase, "terrain");
    send("civ:district_abort", "", player);
    send("civ:district_resume", "", player);
    await settle();
    const saved = record();
    assert.equal(saved.status, "complete", text(player));
    for (const block of plan.blocks) assert.equal(typeAt(saved.origin.x + block.x, saved.origin.y + block.y, saved.origin.z + block.z), block.id);
});

// ---- regression tests for review findings -------------------------------------------------
test("a log-only cabin (stripped logs) is not mistaken for a natural tree", async () => {
    reset();
    for (let y = GROUND_Y + 1; y <= GROUND_Y + 4; y += 1) mc.blocks.set(key(90, y, 190), "minecraft:stripped_oak_log");
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /stripped_oak_log.*not natural terrain/);
});

test("leaves whose persistence cannot be read are refused, not cleared", async () => {
    reset();
    plantTree(90, 190);
    mc.persistent = () => undefined;
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /persistent leaves/);
});

test("an isolated pillar of natural-looking blocks is refused as a possible player build", async () => {
    reset();
    for (let y = GROUND_Y + 1; y <= GROUND_Y + 3; y += 1) mc.blocks.set(key(97, y, 203), y === GROUND_Y + 3 ? grass : "minecraft:dirt");
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /isolated spike/);
});

test("a terrain cell that changes during preparation stops the build before any structure is placed, and resume recovers", async () => {
    reset();
    naturalSite();
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    const code = fpOf(player);
    send("civ:district_generate", `district-1 confirm terrain=${code}`, player);
    for (let guard = 0; guard < 4000; guard += 1) {
        await Promise.resolve();
        const job = mc.jobs[0];
        if (job) {
            const result = job.generator.next();
            if (result.done) mc.jobs.shift();
        } else await new Promise((done) => setImmediate(done));
        if (mc.writes > 50) break;
    }
    // a player puts a chest where the terrain work will cut
    const victim = [...Array(60).keys()].map((i) => key(105 + (i % 8), GROUND_Y + 2, 205 + Math.floor(i / 8))).find((k) => typeAt(...k.split(",").map(Number)) === grass);
    assert.ok(victim, "found a bump cell still waiting to be cut");
    mc.blocks.set(victim, "minecraft:chest");
    await settle();
    assert.match(text(player), /terrain cell\(s\) changed or failed/);
    assert.equal(record().phase, "terrain");
    assert.equal(record().status, "building");
    assert.equal(mc.blocks.get(victim), "minecraft:chest", "player chest survives");
    const structureWrites = [...mc.blocks.keys()].filter((k) => k.split(",")[1] > 64 + 5 && typeAt(...k.split(",").map(Number)) === "minecraft:stone_bricks");
    assert.equal(structureWrites.length, 0, "no structure was started");
    send("civ:district_resume", "", player);
    await settle();
    assert.match(text(player), /Resume refused|terrain/);
    assert.equal(mc.blocks.get(victim), "minecraft:chest");
});

test("resume refuses when the terrain now needs more work than the approved survey", async () => {
    reset();
    naturalSite();
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    const code = fpOf(player);
    send("civ:district_generate", `district-1 confirm terrain=${code}`, player);
    for (let guard = 0; guard < 4000; guard += 1) {
        await Promise.resolve();
        const job = mc.jobs[0];
        if (job) {
            const result = job.generator.next();
            if (result.done) mc.jobs.shift();
        } else await new Promise((done) => setImmediate(done));
        if (mc.writes > 100) break;
    }
    send("civ:district_abort", "", player);
    for (let x = 78; x <= 99; x += 1) for (let z = 178; z <= 199; z += 1) mc.blocks.set(key(x, GROUND_Y + 1, z), "minecraft:poppy");
    player.messages.length = 0;
    send("civ:district_resume", "", player);
    await settle();
    assert.match(text(player), /more work than the survey you approved/);
});

test("the printed confirm command always names the centre", async () => {
    reset();
    naturalSite();
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.match(text(player), /civ:district_generate district-1 at 100 200 maxcut=4 maxfill=4 confirm terrain=[0-9a-f]{8}/);
});

test("a log cabin built from plain logs is refused, not cleared as a tree", async () => {
    reset();
    for (let x = 90; x <= 93; x += 1) for (let z = 190; z <= 193; z += 1) for (let y = GROUND_Y + 1; y <= GROUND_Y + 3; y += 1) {
        const wall = x === 90 || x === 93 || z === 190 || z === 193;
        if (wall || y === GROUND_Y + 3) mc.blocks.set(key(x, y, z), "minecraft:oak_log");
    }
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /log-only structure/);
});

test("water or lava touching the footprint's edge refuses the site", async () => {
    reset();
    for (let z = 170; z <= 230; z += 1) mc.blocks.set(key(125, GROUND_Y, z), "minecraft:water");
    const player = makePlayer();
    send("civ:district_generate", "district-1", player);
    await settle();
    assert.equal(mc.writes, 0);
    assert.match(text(player), /water at y=63 right next to the footprint/);
    reset();
    mc.blocks.set(key(100, GROUND_Y, 175), "minecraft:lava");
    const other = makePlayer();
    send("civ:district_generate", "district-1", other);
    await settle();
    assert.match(text(other), /lava at y=63 right next to the footprint/);
});
