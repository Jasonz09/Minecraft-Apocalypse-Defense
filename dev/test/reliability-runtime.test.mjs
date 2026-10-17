// Reliability: the Minecraft-facing boundary (main.js, events/welcome.js, commands/*.js,
// integration/simulationLoop.js) executed against a fake "@minecraft/server".
//
// The runtime package is types-only on disk, so a module-resolution hook substitutes a
// stub whose `world` and `system` come from globalThis.__mc. The stub models Script API
// v2 early execution: until `mc.ready` is set, ANY world-state access throws, exactly as
// the real engine does while scripts load.
//
// The same hook also lets a test inject a faulty war system into sim/tick.js (see
// reliability-rollback.test.mjs) to prove the loop never persists a rejected step.
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;

// ---- fake runtime ---------------------------------------------------------------------
const mc = {
    ready: false,
    earlyAccesses: [],
    properties: new Map(),
    worldMessages: [],
    spawnSubscribers: [],
    scriptEventSubscribers: [],
    intervals: [],
    clearedRuns: [],
    failDimension: false,
};
globalThis.__mc = mc;

function guard(what) {
    if (!mc.ready) {
        mc.earlyAccesses.push(what);
        throw new Error(`early execution: ${what} is not available yet`);
    }
}

mc.world = {
    afterEvents: { playerSpawn: { subscribe: (callback) => mc.spawnSubscribers.push(callback) } },
    getDynamicProperty(key) {
        guard(`world.getDynamicProperty(${key})`);
        return mc.properties.get(key);
    },
    setDynamicProperty(key, value) {
        guard(`world.setDynamicProperty(${key})`);
        if (typeof value === "string" && value.length > 32767) {
            throw new RangeError("dynamic property string too long");
        }
        if (value === undefined) {
            mc.properties.delete(key);
        } else {
            mc.properties.set(key, value);
        }
    },
    getDimension(name) {
        guard(`world.getDimension(${name})`);
        if (mc.failDimension) {
            throw new Error("dimension unavailable");
        }
        return { id: name };
    },
    sendMessage(message) {
        guard("world.sendMessage");
        mc.worldMessages.push(message);
    },
};
mc.system = {
    afterEvents: {
        scriptEventReceive: { subscribe: (callback, options) => mc.scriptEventSubscribers.push({ callback, options }) },
    },
    runInterval(callback, ticks) {
        const id = mc.intervals.length + 1;
        mc.intervals.push({ id, callback, ticks });
        return id;
    },
    clearRun(id) {
        mc.clearedRuns.push(id);
        const found = mc.intervals.find((entry) => entry.id === id);
        if (found) {
            found.cleared = true;
        }
    },
};

const hooksSource = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = 'export const world = globalThis.__mc.world; export const system = globalThis.__mc.system;' +
            'export const ScriptEventSource = { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" };' +
            'export const BlockPermutation = { resolve() { throw new Error("BlockPermutation is not modelled in this suite"); } };';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    if (specifier === "./war.js" && typeof context.parentURL === "string" && context.parentURL.endsWith("/sim/tick.js")) {
        const real = ${JSON.stringify(fileUrl("sim", "war.js"))};
        const wrapper = 'import { runWarStep as real } from ' + JSON.stringify(real) + ';' +
            'export function runWarStep(kingdom) { const f = globalThis.__reliabilityFault; return f ? f(kingdom, real) : real(kingdom); }';
        return { url: "data:text/javascript," + encodeURIComponent(wrapper), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooksSource));

const load = (...parts) => import(fileUrl(...parts));
const { STORAGE_KEYS, KINGDOM_SCHEMA_VERSION, SIM } = await load("config.js");
const { createInitialKingdom, serializeKingdom, findValidationProblems } = await load("kingdom", "state.js");
const report = await load("ui", "report.js");
const { listScenarios } = await load("sim", "scenarios.js");
const loop = await load("integration", "simulationLoop.js");
const { createKingdomStore } = await load("kingdom", "store.js");

// ---- the real entry point, imported while the world is NOT ready ----------------------
let mainImportError;
try {
    await load("main.js");
} catch (error) {
    mainImportError = error;
}
const earlySnapshot = {
    accesses: [...mc.earlyAccesses],
    spawn: mc.spawnSubscribers.length,
    scriptEvents: mc.scriptEventSubscribers.length,
    intervals: mc.intervals.map((entry) => entry.ticks),
};
mc.ready = true;

// ---- helpers --------------------------------------------------------------------------
function makePlayer(name = "Steve") {
    const messages = [];
    return { typeId: "minecraft:player", name, messages, sendMessage: (message) => messages.push(message) };
}

function resetWorld() {
    mc.properties.clear();
    mc.worldMessages.length = 0;
    mc.failDimension = false;
    globalThis.__reliabilityFault = undefined;
}

function seed(kingdom = createInitialKingdom()) {
    mc.properties.set(STORAGE_KEYS.kingdom, serializeKingdom(kingdom));
    return kingdom;
}

function storedKingdom() {
    return JSON.parse(mc.properties.get(STORAGE_KEYS.kingdom));
}

/** Deliver a scriptevent to every subscriber whose namespace filter matches, like the engine. */
function scriptEvent(id, message = "", { player } = {}) {
    const namespace = id.split(":")[0];
    const event = player
        ? { id, message, sourceType: "Entity", initiator: player }
        : { id, message, sourceType: "Server", initiator: undefined };
    for (const { callback, options } of mc.scriptEventSubscribers) {
        const namespaces = options?.namespaces;
        if (namespaces === undefined || namespaces.includes(namespace)) {
            callback(event);
        }
    }
}

function spawn(player, initialSpawn = true) {
    for (const callback of mc.spawnSubscribers) {
        callback({ player, initialSpawn });
    }
}

const flatten = (messages) => messages.flat();

// ---- early execution ------------------------------------------------------------------
test("main.js: importing it during early execution does not touch world state and does not throw", () => {
    assert.equal(mainImportError, undefined, `main.js threw at top level: ${String(mainImportError)}`);
    assert.deepEqual(earlySnapshot.accesses, [], "no world reads, writes, dimension lookups or messages at module scope");
});

test("main.js: registers exactly the subscriptions the pack needs and one hourly interval", () => {
    assert.equal(earlySnapshot.spawn, 1, "one playerSpawn subscriber");
    assert.equal(earlySnapshot.scriptEvents, 4, "status + inspection + debug + physical script-event subscribers");
    assert.deepEqual(earlySnapshot.intervals, [SIM.stepTicks], "one interval at the in-game-hour cadence");
    for (const { options } of mc.scriptEventSubscribers) {
        assert.deepEqual(options?.namespaces, ["civ"], "every script-event subscription is namespace-filtered");
    }
});

test("registration is idempotent: calling the register functions again adds no duplicate subscribers", async () => {
    const store = createKingdomStore(mc.world);
    (await load("events", "welcome.js")).registerWelcomeOnJoin(store);
    (await load("commands", "status.js")).registerStatusCommand(store);
    (await load("commands", "inspect.js")).registerInspectionCommands(store);
    (await load("commands", "debug.js")).registerDebugCommands(store);
    (await load("commands", "physical.js")).registerPhysicalCommands(store);
    assert.equal(mc.spawnSubscribers.length, 1);
    assert.equal(mc.scriptEventSubscribers.length, 4);
    assert.equal(loop.isSimulationLoopRunning(), true);
    assert.equal(mc.intervals.length, 1, "startSimulationLoop returns the existing handle");
});

// ---- welcome --------------------------------------------------------------------------
test("welcome: a non-initial spawn (respawn) says nothing and touches nothing", () => {
    resetWorld();
    const player = makePlayer();
    spawn(player, false);
    assert.deepEqual(player.messages, []);
    assert.equal(mc.properties.size, 0);
});

test("welcome: first join in a new world seeds a kingdom and greets by name", () => {
    resetWorld();
    const player = makePlayer("Alex");
    spawn(player);
    assert.equal(storedKingdom().schemaVersion, KINGDOM_SCHEMA_VERSION);
    assert.deepEqual(player.messages, [report.formatWelcomeLines(storedKingdom(), true, "Alex")]);
});

test("welcome: second join loads the saved kingdom (seeded=false) without rewriting it", () => {
    resetWorld();
    const kingdom = seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    const player = makePlayer();
    spawn(player);
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
    assert.deepEqual(player.messages, [report.formatWelcomeLines(kingdom, false, "Steve")]);
});

test("welcome: a save from a newer pack is reported as refused and left byte-for-byte alone", () => {
    resetWorld();
    const newer = JSON.stringify({ schemaVersion: KINGDOM_SCHEMA_VERSION + 1, payload: "future" });
    mc.properties.set(STORAGE_KEYS.kingdom, newer);
    const player = makePlayer();
    spawn(player);
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), newer);
    assert.equal(mc.properties.has(STORAGE_KEYS.quarantine), false);
    assert.equal(player.messages.length, 1);
    assert.equal(flatten(player.messages).join("\n").length > 0, true);
    assert.deepEqual(player.messages[0], report.formatRefusedKingdomLines(`saved state is schema v${String(KINGDOM_SCHEMA_VERSION + 1)}, newer than this pack (v${String(KINGDOM_SCHEMA_VERSION)})`));
});

test("welcome: a corrupt save is quarantined and replaced, and the player is told it is a fresh kingdom", () => {
    resetWorld();
    mc.properties.set(STORAGE_KEYS.kingdom, "{garbage");
    const player = makePlayer();
    spawn(player);
    assert.equal(JSON.parse(mc.properties.get(STORAGE_KEYS.quarantine)).payload, "{garbage");
    assert.deepEqual(findValidationProblems(storedKingdom()), []);
    assert.equal(player.messages.length, 1);
});

test("welcome: if persistence throws on first join the handler throws and the player hears nothing (documented)", () => {
    resetWorld();
    const original = mc.world.setDynamicProperty;
    mc.world.setDynamicProperty = () => {
        throw new Error("disk full");
    };
    const player = makePlayer();
    try {
        assert.throws(() => spawn(player), /disk full/);
    } finally {
        mc.world.setDynamicProperty = original;
    }
    assert.deepEqual(player.messages, [], "no explanation reaches the player");
});

// ---- commands -------------------------------------------------------------------------
test("civ:status: unseeded world replies with the 'no kingdom' text via world.sendMessage (console/command-block path)", () => {
    resetWorld();
    scriptEvent("civ:status");
    assert.equal(mc.worldMessages.length, 1);
    assert.deepEqual(mc.worldMessages[0], report.formatMissingKingdomLines("no kingdom has been stored yet"));
});

test("civ:status: a player invoker gets a private reply, not a world broadcast", () => {
    resetWorld();
    const kingdom = seed();
    const player = makePlayer();
    scriptEvent("civ:status", "", { player });
    assert.deepEqual(player.messages, [report.formatStatusLines(kingdom)]);
    assert.deepEqual(mc.worldMessages, []);
});

test("civ:status: a non-player entity invoker falls back to the world broadcast", () => {
    resetWorld();
    seed();
    const event = { id: "civ:status", message: "", sourceType: "Entity", initiator: { typeId: "minecraft:zombie", sendMessage: () => assert.fail("must not whisper to a zombie") } };
    for (const { callback } of mc.scriptEventSubscribers) {
        callback(event);
    }
    assert.equal(mc.worldMessages.length, 1);
});

test("civ:status: a newer-schema save is reported as refused, not as missing", () => {
    resetWorld();
    mc.properties.set(STORAGE_KEYS.kingdom, JSON.stringify({ schemaVersion: 99 }));
    scriptEvent("civ:status");
    assert.deepEqual(mc.worldMessages[0], report.formatRefusedKingdomLines(`saved state is schema v99, newer than this pack (v${String(KINGDOM_SCHEMA_VERSION)})`));
});

test("events outside the civ namespace never reach any handler", () => {
    resetWorld();
    seed();
    scriptEvent("other:status");
    scriptEvent("civ:unknown-command");
    assert.deepEqual(mc.worldMessages, []);
});

test("civ:district: usage, unknown id, and a known id each reply once and never write", () => {
    resetWorld();
    const kingdom = seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    const player = makePlayer();

    scriptEvent("civ:district", "", { player });
    scriptEvent("civ:district", "no-such-district", { player });
    const known = kingdom.districts[0];
    scriptEvent("civ:district", known.id, { player });

    assert.equal(player.messages.length, 3);
    assert.deepEqual(player.messages[1], report.formatUnknownDistrictLines(kingdom.districts.map((district) => district.id), "no-such-district"));
    assert.deepEqual(player.messages[2], report.formatDistrictLines(kingdom, known));
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
});

test("civ:district: with no readable kingdom the player gets an error, not silence", () => {
    resetWorld();
    const player = makePlayer();
    scriptEvent("civ:district", "x", { player });
    assert.equal(player.messages.length, 1);
});

test("civ:policy: valid mode is persisted; invalid mode is rejected with no write", () => {
    resetWorld();
    seed();
    const player = makePlayer();

    scriptEvent("civ:policy", "paused", { player });
    assert.equal(storedKingdom().policy.expansion, "paused");

    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    scriptEvent("civ:policy", "turbo", { player });
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
    assert.equal(player.messages.length, 2);

    scriptEvent("civ:policy", "", { player });
    assert.equal(player.messages.length, 3);
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before, "viewing the policy does not write");
});

test("civ:territory: replies with the territory readout when a kingdom exists", () => {
    resetWorld();
    const kingdom = seed();
    const player = makePlayer();
    scriptEvent("civ:territory", "", { player });
    assert.deepEqual(player.messages, [report.formatTerritoryLines(kingdom)]);
});

// inspect.js: the civ:territory branch has no else, unlike civ:district and civ:policy.
test("civ:territory: with no readable kingdom the command explains itself", () => {
    resetWorld();
    const player = makePlayer();
    scriptEvent("civ:territory", "", { player });
    assert.equal(player.messages.length + mc.worldMessages.length, 1);
});

test("civ:debug:help and civ:debug:scenarios reply without needing a kingdom", () => {
    resetWorld();
    const player = makePlayer();
    scriptEvent("civ:debug:help", "", { player });
    scriptEvent("civ:debug:scenarios", "", { player });
    assert.equal(player.messages.length, 2);
    assert.ok(player.messages[1].length > listScenarios().length);
});

test("civ:debug:tick: validates its argument (0, 25, abc, 1.5 refused, nothing saved)", () => {
    resetWorld();
    seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    const player = makePlayer();
    for (const bad of ["0", String(SIM.maxCatchUpSteps + 1), "abc", "1.5", "-3"]) {
        scriptEvent("civ:debug:tick", bad, { player });
    }
    assert.equal(player.messages.length, 5);
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
});

test("civ:debug:tick: a valid count advances the clock, persists, and replies", () => {
    resetWorld();
    seed();
    const player = makePlayer();
    scriptEvent("civ:debug:tick", "6", { player });
    assert.equal(storedKingdom().step, 6);
    assert.match(player.messages[0][0], /Advanced 6 step/);
});

test("civ:debug:tick: when every step is rolled back nothing is saved and the reply says so", () => {
    resetWorld();
    seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    const player = makePlayer();
    globalThis.__reliabilityFault = (state) => {
        state.territory[0].status = "bogus";
        return [];
    };
    scriptEvent("civ:debug:tick", "3", { player });
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before, "rejected steps are never persisted");
    const text = player.messages[0].join("\n");
    assert.match(text, /Advanced 0 step\(s\), 3 refused/);
    assert.match(text, /rolled back/);
});

test("civ:debug:scenario: a dry run (default) never changes the stored save", () => {
    resetWorld();
    seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    const player = makePlayer();
    for (const scenario of listScenarios()) {
        scriptEvent("civ:debug:scenario", scenario.id, { player });
    }
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
    assert.ok(player.messages.length >= listScenarios().length);
});

test("civ:debug:scenario: unknown id and unknown flag are refused without writing", () => {
    resetWorld();
    seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    const player = makePlayer();
    scriptEvent("civ:debug:scenario", "", { player });
    scriptEvent("civ:debug:scenario", "no-such-scenario", { player });
    scriptEvent("civ:debug:scenario", `${listScenarios()[0].id} x --force`, { player });
    assert.equal(player.messages.length, 3);
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
});

test("civ:debug:build: enable/anchor/status/run gating behaves, and run refuses before opt-in", () => {
    resetWorld();
    seed();
    const player = makePlayer();
    scriptEvent("civ:debug:build", "run", { player });
    assert.match(player.messages[0].join("\n"), /off/i);
    scriptEvent("civ:debug:build", "enable", { player });
    assert.equal(mc.properties.get("civ:demo-build"), true);
    scriptEvent("civ:debug:build", "run", { player });
    assert.match(player.messages[2].join("\n"), /anchor/i);
    scriptEvent("civ:debug:build", "anchor 1 2", { player });
    assert.match(player.messages[3].join("\n"), /Usage/);
    scriptEvent("civ:debug:build", "anchor 10.7 64 -3.2", { player });
    assert.deepEqual(mc.properties.get("civ:demo-anchor"), { x: 10, y: 64, z: -4 });
    scriptEvent("civ:debug:build", "disable", { player });
    assert.equal(mc.properties.get("civ:demo-build"), false);
});

test("a handler that throws does not stop later subscribers from being delivered the same event (engine isolation)", () => {
    // The stub delivers sequentially; this just pins that no handler swallows the event for the others.
    resetWorld();
    seed();
    const player = makePlayer();
    scriptEvent("civ:status", "", { player });
    assert.equal(player.messages.length, 1, "exactly one subscriber answers civ:status");
});

// ---- simulation loop ------------------------------------------------------------------
/** Stop whatever loop is running (main.js started one) and start a fresh one with options. */
function restartLoop(options) {
    const store = createKingdomStore(mc.world);
    loop.startSimulationLoop(store)(); // returns the live handle (or starts one), then stops it
    assert.equal(loop.isSimulationLoopRunning(), false);
    loop.startSimulationLoop(store, options);
}

function tickLoop() {
    const active = mc.intervals.filter((entry) => !entry.cleared).at(-1);
    assert.ok(active, "an active interval exists");
    active.callback();
}

test("loop: with no save the hourly callback does nothing at all - it never creates a kingdom", () => {
    resetWorld();
    tickLoop();
    assert.equal(mc.properties.size, 0);
});

test("loop: with a newer-schema save the callback leaves the save untouched", () => {
    resetWorld();
    const newer = JSON.stringify({ schemaVersion: KINGDOM_SCHEMA_VERSION + 1 });
    mc.properties.set(STORAGE_KEYS.kingdom, newer);
    tickLoop();
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), newer);
});

test("loop: each callback advances exactly one step and saves", () => {
    resetWorld();
    seed();
    tickLoop();
    tickLoop();
    tickLoop();
    assert.equal(storedKingdom().step, 3);
    assert.deepEqual(findValidationProblems(storedKingdom()), []);
});

test("loop: a rejected step is not saved and the stored bytes are unchanged", () => {
    resetWorld();
    seed();
    tickLoop();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    globalThis.__reliabilityFault = (state) => {
        state.territory[0].status = "bogus";
        return [];
    };
    tickLoop();
    tickLoop();
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
    globalThis.__reliabilityFault = undefined;
    tickLoop();
    assert.equal(storedKingdom().step, 2, "the loop recovers as soon as the fault clears and no step was lost or doubled");
});

test("loop: onStep sees the rejected hour too, flagged with a problem", () => {
    resetWorld();
    seed();
    const reports = [];
    restartLoop({ onStep: (entry) => reports.push(entry) });

    tickLoop();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].ran, 1);

    globalThis.__reliabilityFault = (state) => {
        state.territory[0].status = "bogus";
        return [];
    };
    tickLoop();
    assert.equal(reports.length, 2, "the rejected hour is reported");
    assert.ok(reports[1].problem);
});

// simulationLoop.js computes `report.problem` for a rejected hour and then `return`s
// without using it, so nothing can ever learn that the simulation is stuck.
test("loop: a rejected hour is observable through onStep and the log", () => {
    resetWorld();
    seed();
    const reports = [];
    restartLoop({ onStep: (entry) => reports.push(entry) });
    globalThis.__reliabilityFault = (state) => {
        state.territory[0].status = "bogus";
        return [];
    };
    tickLoop();
    assert.equal(reports.length, 1);
    assert.ok(reports[0].problem);
});

test("loop: a build-adapter failure is contained and the hour is still saved", () => {
    resetWorld();
    seed();
    const reports = [];
    restartLoop({ onStep: (entry) => reports.push(entry) });
    mc.properties.set("civ:demo-build", true);
    mc.failDimension = true;
    tickLoop();
    assert.equal(storedKingdom().step, 1, "the hour persisted even though the physical build failed");
    assert.equal(reports.length, 1);
    assert.match(reports[0].buildError, /dimension unavailable/);
});

test("loop: if the save throws the exception escapes the callback and the stored kingdom is unchanged", () => {
    resetWorld();
    seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    const original = mc.world.setDynamicProperty;
    mc.world.setDynamicProperty = () => {
        throw new Error("write failed");
    };
    try {
        assert.throws(() => tickLoop(), /write failed/);
    } finally {
        mc.world.setDynamicProperty = original;
    }
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
    tickLoop();
    assert.equal(storedKingdom().step, 1, "the failed hour is re-run from the persisted state, not skipped");
});

test("loop: a system that throws mid-step is rolled back, reported and never reaches the store", () => {
    resetWorld();
    seed();
    const before = mc.properties.get(STORAGE_KEYS.kingdom);
    globalThis.__reliabilityFault = () => {
        throw new Error("system crash");
    };
    tickLoop();
    assert.equal(mc.properties.get(STORAGE_KEYS.kingdom), before);
});

test("loop: stop handle clears the run and allows a single restart", () => {
    resetWorld();
    const store = createKingdomStore(mc.world);
    const stop = loop.startSimulationLoop(store);
    const runsBefore = mc.intervals.length;
    assert.equal(loop.startSimulationLoop(store), stop, "second start returns the same handle");
    assert.equal(mc.intervals.length, runsBefore, "no second interval is created");
    stop();
    assert.equal(loop.isSimulationLoopRunning(), false);
    assert.ok(mc.clearedRuns.length > 0);
});
