// Gate integration (X3): civ/gatelink.js (pure linking + read-only proofs), integration/civGates.js
// (registerBuiltGates, self test), the unit/companion/unmanaged handling of integration/gateAdapter.js and the
// gate commands - run against a fake world holding the REAL gatehouse blocks of the planned Hearthgate.
//
// What this proves: the safety contract and the ordering/agreement/restart logic. What it cannot prove: that the
// real engine accepts every block state, how lever/bars behave under redstone, or mob pathing at the pixel level
// (see the final report of the integration work for the list that needs the game).
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;
const devUrl = (...parts) => pathToFileURL(join(projectRoot, "dev", ...parts)).href;

const key = (x, y, z) => `${x},${y},${z}`;
const mc = {
    properties: new Map(),
    worldMessages: [],
    scriptEventSubscribers: [],
    intervals: [],
    jobs: [],
    nextJob: 1,
    tick: 1000,
    writes: 0,
    writeLog: [],
    blocks: new Map(),
    states: new Map(),
    entities: [],
    ground: () => 63,
    unloaded: () => false,
    afterWrite: undefined,
};
globalThis.__mc5 = mc;

function typeAt(x, y, z) {
    const placed = mc.blocks.get(key(x, y, z));
    if (placed !== undefined) return placed;
    const g = mc.ground(x, z);
    if (y === g) return "minecraft:grass_block";
    if (y < g) return "minecraft:dirt";
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
            permutation: { getState: (name) => (mc.states.get(key(x, y, z)) ?? {})[name] },
            setPermutation(permutation) {
                mc.writes += 1;
                mc.writeLog.push({ x, y, z, id: permutation.id });
                mc.blocks.set(key(x, y, z), permutation.id);
                mc.states.set(key(x, y, z), permutation.states ?? {});
                mc.afterWrite?.(x, y, z, permutation.id);
            },
        };
    },
    getEntities({ location, maxDistance }) {
        return mc.entities.filter((entity) => Math.hypot(entity.location.x - location.x, entity.location.y - location.y, entity.location.z - location.z) <= maxDistance);
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
};
mc.system = {
    afterEvents: { scriptEventReceive: { subscribe: (callback, options) => mc.scriptEventSubscribers.push({ callback, options }) } },
    get currentTick() {
        return mc.tick;
    },
    runInterval(callback, ticks) {
        mc.intervals.push({ callback, ticks });
        return mc.intervals.length;
    },
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
mc.BlockPermutation = { resolve: (id, states) => ({ id, states }) };

register(
    "data:text/javascript," +
        encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = 'export const world = globalThis.__mc5.world; export const system = globalThis.__mc5.system;' +
            'export const BlockPermutation = globalThis.__mc5.BlockPermutation;' +
            'export const ScriptEventSource = { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" };';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`),
);

const load = (...parts) => import(fileUrl(...parts));
const gates = await load("civ", "gates.js");
const link = await load("civ", "gatelink.js");
const control = await load("sim", "gatecontrol.js");
const { createKingdomStore } = await load("kingdom", "store.js");
const { createInitialKingdom, findValidationProblems, serializeKingdom } = await load("kingdom", "state.js");
const { advanceKingdomStep } = await load("sim", "tick.js");
const adapterModule = await load("integration", "gateAdapter.js");
const { createGateAdapter, GATE_RUNTIME, readGateRecord, readGateRegistry } = adapterModule;
const civGates = await load("integration", "civGates.js");
const commands = await load("commands", "gates.js");
const { makeField } = await import(devUrl("lib", "fakefield.mjs"));
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");

/* ------------------------------------------------------------------ the REAL Hearthgate site plan */

const SEED = 21;
const field = makeField(SEED, { relief: 18, hills: 60 });
const planned = M.planCivilizationDetailed(field, { seed: SEED });
assert.ok(planned.ok, "the master plan must exist first");
const PLAN = planned.plan;
const site = D.planDistrictSite(PLAN, 1, field, { seed: SEED });
assert.ok(site.ok, `Hearthgate must plan: ${site.problems.slice(0, 3).join(" | ")}`);
const RECORD = site.record;
const SITE_GATES = RECORD.gates;
assert.ok(SITE_GATES.length >= 3, "the enlarged Hearthgate emits several physical gates");
const planGate = (id) => SITE_GATES.find((g) => g.id === id);

const D_ = (n) => `district-${n}`;
const G = (a, b) => `gate-${D_(a)}-${D_(b)}`;
const simGate = (kingdom, a, b) => control.findGate(kingdom, G(a, b)).gate;
const ids = {
    one_two: G(1, 2),
    five_one: G(5, 1),
};
// the plan's gates, by role
const MAIN_12 = SITE_GATES.find((g) => g.between.slice().sort().join() === "1,2");
const PAIR_15 = SITE_GATES.filter((g) => g.between.slice().sort().join() === "1,5");
const OUTER = SITE_GATES.filter((g) => g.between.includes(0));
assert.ok(MAIN_12 && PAIR_15.length >= 2 && OUTER.length >= 1, "fixture: a 1-2 gate, two 1-5 gates and an outer gate are planned");
const PRIMARY_15 = PAIR_15.find((g) => g.purpose === "main");
const COMPANION_15 = PAIR_15.find((g) => g !== PRIMARY_15);
const OUTER_ID = OUTER[0].id;

/* ------------------------------------------------------------------ world helpers */

let store = createKingdomStore(mc.world);
let currentAdapter;
// the command module registers once per process: give it proxies that always point at the current store/adapter
const storeProxy = new Proxy({}, { get: (_t, prop) => store[prop] });
const adapterProxy = new Proxy({}, { get: (_t, prop) => currentAdapter[prop] });

function resetWorld() {
    mc.properties.clear();
    mc.worldMessages.length = 0;
    mc.blocks.clear();
    mc.states.clear();
    mc.entities.length = 0;
    mc.jobs.length = 0;
    mc.writes = 0;
    mc.writeLog.length = 0;
    mc.tick = 1000;
    mc.unloaded = () => false;
    mc.afterWrite = undefined;
    mc.intervals.length = 0;
    // ground follows the nearest planned gate's walking level
    mc.ground = (x, z) => {
        let best = SITE_GATES[0];
        let bestDistance = Infinity;
        for (const g of SITE_GATES) {
            const d = Math.abs(g.at.x - x) + Math.abs(g.at.z - z);
            if (d < bestDistance) {
                bestDistance = d;
                best = g;
            }
        }
        return best.walkingLevel - 1;
    };
    store = createKingdomStore(mc.world);
    store.ensureInitial();
}

/** Put the REAL planned gatehouse blocks (the 'gates' stage of the Hearthgate record) into the world. */
function buildGatehouses(only) {
    RECORD.gates.forEach((g, index) => {
        if (only !== undefined && !only.includes(g.id)) return;
        for (const op of D.siteOpsFor(RECORD, "gates", index)) {
            if (op.kind === "air") continue;
            mc.blocks.set(key(op.x, op.y, op.z), op.id);
        }
    });
}

function freshWorld({ build = true, register = true } = {}) {
    resetWorld();
    if (build) buildGatehouses();
    const result = register ? civGates.registerBuiltGates(store, RECORD, "minecraft:overworld") : undefined;
    if (register) assert.equal(result.ok, true, String(result.reason));
    return createGateAdapter(store);
}

function restart() {
    mc.jobs.length = 0; // generators die with the world
    mc.intervals.length = 0;
    store = createKingdomStore(mc.world);
    return createGateAdapter(store);
}

function settle(maxSteps = 400000) {
    let steps = 0;
    while (mc.jobs.length > 0 && steps < maxSteps) {
        const job = mc.jobs.shift(); // round robin, like the real scheduler: a self test waits on the gate job it started
        mc.tick += 1;
        steps += 1;
        const result = job.generator.next();
        if (!result.done) mc.jobs.push(job);
    }
    assert.ok(steps < maxSteps, "job did not finish");
    return steps;
}

function stepJobs(count) {
    for (let i = 0; i < count && mc.jobs.length > 0; i += 1) {
        mc.tick += 1;
        const result = mc.jobs[0].generator.next();
        if (result.done) mc.jobs.shift();
    }
}

const kingdom = () => store.load().kingdom;
const simPhysical = (a, b) => simGate(kingdom(), a, b);
const use = (adapter) => {
    currentAdapter = adapter;
    return adapter;
};
currentAdapter = createGateAdapter(storeProxy);
commands.registerGateCommands(storeProxy, adapterProxy);
const commandHandler = mc.scriptEventSubscribers[0];
assert.ok(commandHandler, "registerGateCommands subscribes once");

const makePlayer = () => ({ typeId: "minecraft:player", isValid: true, messages: [], sendMessage(m) { this.messages.push(...(Array.isArray(m) ? m : [m])); } });
/** Send a scriptevent and return everything the player was told. */
function command(id, message) {
    const player = makePlayer();
    commandHandler.callback({ id, message, sourceType: "Entity", sourceEntity: player, initiator: player });
    return player.messages.join(String.fromCharCode(10));
}

const latticeOf = (spec) => link.latticeState(spec, (x, y, z) => typeAt(x, y, z)).state;
const specOf = (g) => ({ at: g.at, axis: g.axis, y: g.walkingLevel });
const cellKey = (c) => `${c.x},${c.y},${c.z}`;
const barsKeys = (spec, state) => gates.gateBlocks(spec, state).ops.filter((op) => op.id === "minecraft:iron_bars").map(cellKey).sort();
const barsInWorldFor = (spec) => gates.cellsToToggle(spec).filter((c) => c.role !== "lever" && typeAt(c.x, c.y, c.z) === "minecraft:iron_bars").map(cellKey).sort();
const entityAt = (spec, dx = 0, typeId = "minecraft:villager_v2") => ({ typeId, isValid: true, name: "Steve", location: { x: spec.at.x + 0.5 + dx, y: spec.y, z: spec.at.z + 0.5 } });

/** An INDEPENDENT crossing proof in WORLD axes over the blocks actually in the fake world (no gate-local frame). */
function worldWalkerCrosses(g, mobHeight, squeeze) {
    const along = g.axis; // wall runs along x or z
    const tower = 5; // gatehouse half length along the wall: 2 + 3
    const reach = tower + 4;
    const solidAt = (a, t, h) => {
        // a = offset along the wall, t = offset across it, h above the walking level
        if (h < 0) return true;
        const x = along === "x" ? g.at.x + a : g.at.x + t;
        const z = along === "x" ? g.at.z + t : g.at.z + a;
        if (Math.abs(a) > tower) return Math.abs(t) <= 1 && h < 7; // the plain wall continues
        const id = typeAt(x, g.walkingLevel + h, z);
        return !["minecraft:air", "minecraft:lever", "minecraft:cave_air"].includes(id);
    };
    const T = 6;
    const HH = 24;
    const free = (a, t, lo, hi) => {
        for (let h = lo; h <= hi; h += 1) if (h >= HH || solidAt(a, t, h)) return false;
        return true;
    };
    const seen = new Set();
    const queue = [];
    for (let a = -reach; a <= reach; a += 1) {
        for (let h = 0; h < 4; h += 1) {
            if (free(a, -T, h, h + mobHeight - 1) && solidAt(a, -T, h - 1)) {
                seen.add(`${a},${-T},${h}`);
                queue.push([a, -T, h]);
            }
        }
    }
    for (let head = 0; head < queue.length; head += 1) {
        const [a, t, h] = queue[head];
        if (t === T) return true;
        for (let da = -1; da <= 1; da += 1) {
            for (let dt = -1; dt <= 1; dt += 1) {
                if (da === 0 && dt === 0) continue;
                const na = a + da;
                const nt = t + dt;
                if (Math.abs(na) > reach || Math.abs(nt) > T) continue;
                for (const dh of [0, 1, -1, -2, -3]) {
                    const nh = h + dh;
                    if (nh < 0 || nh > 12) continue;
                    if (!free(na, nt, nh, nh + mobHeight - 1) || !solidAt(na, nt, nh - 1)) continue;
                    if (dh > 0 && !free(a, t, h + mobHeight, h + mobHeight + dh - 1)) continue;
                    if (dh < 0 && !free(na, nt, nh, h + mobHeight - 1)) continue;
                    if (da !== 0 && dt !== 0 && !squeeze) {
                        const lo = Math.min(h, nh);
                        const hi = Math.max(h, nh) + mobHeight - 1;
                        if (!free(na, t, lo, hi) || !free(a, nt, lo, hi)) continue;
                    }
                    const label = `${na},${nt},${nh}`;
                    if (!seen.has(label)) {
                        seen.add(label);
                        queue.push([na, nt, nh]);
                    }
                }
            }
        }
    }
    return false;
}

/* ================================================================== 1. pure linking */

test("the enlarged Hearthgate plan: 1-2 main -> district-1's record; 1-5 main (+ reinforce companion) -> district-5's record; outer gates unmanaged; nothing invented or removed", () => {
    const k = createInitialKingdom();
    const before = JSON.parse(JSON.stringify(k));
    const result = link.linkPhysicalGates(k, SITE_GATES, { dimension: "minecraft:overworld" });
    assert.deepEqual(result.warnings, []);
    // the simulation's gate list is unchanged: same ids, same owners, same partners, same count
    const strip = (kingdomLike) => control.listGates(kingdomLike).map(({ gate, owner }) => [gate.id, owner.id, gate.with]);
    assert.deepEqual(strip(k), strip(before));
    const managed = control.listGates(k).filter(({ gate }) => gate.mode !== undefined || gate.physical !== undefined).map(({ gate }) => gate.id);
    assert.deepEqual(managed.sort(), [G(1, 2), G(5, 1)].sort());
    const g12 = simGate(k, 1, 2);
    assert.equal(g12.mode, "auto");
    assert.equal(g12.state, "open");
    assert.equal(g12.physical.state, "open");
    assert.deepEqual(g12.physical.spec, { at: MAIN_12.at, axis: MAIN_12.axis, y: MAIN_12.walkingLevel, dimension: "minecraft:overworld" });
    assert.equal(g12.physical.link.planId, MAIN_12.id);
    assert.equal(g12.physical.companions, undefined);
    const g51 = simGate(k, 5, 1);
    assert.equal(g51.physical.link.planId, PRIMARY_15.id, "the main gate is the primary");
    assert.deepEqual(g51.physical.companions.map((c) => c.id), PAIR_15.filter((g) => g !== PRIMARY_15).map((g) => g.id));
    assert.equal(g51.physical.companions[0].purpose, COMPANION_15.purpose);
    // everything else in the kingdom is byte-for-byte unchanged
    for (const { gate } of control.listGates(k)) {
        if (![G(1, 2), G(5, 1)].includes(gate.id)) {
            const original = control.listGates(before).find((entry) => entry.gate.id === gate.id).gate;
            assert.deepEqual(gate, original);
        }
    }
    // the outer gate is a physical gate outside the simulation
    const outer = result.links.filter((l) => l.role === "unmanaged");
    assert.deepEqual(outer.map((l) => l.id).sort(), OUTER.map((g) => g.id).sort());
    assert.ok(outer.every((l) => l.simGateId === null));
    assert.deepEqual(findValidationProblems(k), []);
    assert.deepEqual(control.validateGateRecords(k), []);
    assert.deepEqual(link.validateGateLinks(k), []);
});

test("linking is idempotent: a second call reports nothing and changes nothing; a manual override and the physical state survive a re-link", () => {
    const k = createInitialKingdom();
    link.linkPhysicalGates(k, SITE_GATES, {});
    const snapshot = JSON.stringify(k);
    const again = link.linkPhysicalGates(k, SITE_GATES, {});
    assert.deepEqual(again.changes, []);
    assert.equal(JSON.stringify(k), snapshot);
    // a forced mode, a closed gate with a pending order and a blocked note are kept
    const g = simGate(k, 1, 2);
    g.mode = "forced_closed";
    g.physical.state = "closed";
    g.physical.target = "open";
    g.physical.blocked = "someone is standing there";
    g.state = "sealed";
    const kept = JSON.stringify(g);
    assert.deepEqual(link.linkPhysicalGates(k, SITE_GATES, {}).changes, []);
    assert.equal(JSON.stringify(g), kept);
    // a moved gate is re-linked (spec updated), the state is still kept
    const moved = SITE_GATES.map((x) => (x.id === MAIN_12.id ? { ...x, walkingLevel: x.walkingLevel + 2 } : x));
    const changed = link.linkPhysicalGates(k, moved, {});
    assert.deepEqual(changed.changes.map((c) => c.kind), ["relinked"]);
    assert.equal(g.physical.spec.y, MAIN_12.walkingLevel + 2);
    assert.equal(g.physical.state, "closed");
    assert.equal(g.mode, "forced_closed");
});

test("a record that is already logically sealed gets a closing order so the blocks catch up; gate.state itself is never touched", () => {
    const k = createInitialKingdom();
    simGate(k, 1, 2).state = "sealed";
    simGate(k, 5, 1).state = "broken";
    link.linkPhysicalGates(k, SITE_GATES, {});
    assert.equal(simGate(k, 1, 2).state, "sealed");
    assert.equal(simGate(k, 1, 2).physical.state, "open");
    assert.equal(simGate(k, 1, 2).physical.target, "closed");
    assert.equal(simGate(k, 5, 1).state, "broken");
    assert.equal(simGate(k, 5, 1).physical.target, undefined);
});

test("primary choice: main beats reinforce whatever the ids; ties go to the lowest NUMERIC id; companions are listed in a stable order", () => {
    const mk = (id, purpose, x) => ({ id, purpose, between: [1, 5], at: { x, z: 10 }, axis: "x", walkingLevel: 64, width: 5 });
    const k = createInitialKingdom();
    link.linkPhysicalGates(k, [mk("gate-2", "reinforce", 0), mk("gate-10", "main", 50), mk("gate-9", "main", 100), mk("gate-3", "evac", 150)], {});
    const physical = simGate(k, 5, 1).physical;
    assert.equal(physical.link.planId, "gate-9", "numeric order: 9 before 10");
    assert.deepEqual(physical.companions.map((c) => c.id), ["gate-10", "gate-2", "gate-3"].sort((a, b) => {
        const rank = { "gate-10": 0, "gate-2": 2, "gate-3": 3 };
        return rank[a] - rank[b];
    }));
});

test("whole-plan input: all five ring pairs find their EXISTING record, extras are companions, outer gates are unmanaged, no record is invented", () => {
    const k = createInitialKingdom();
    const withLevel = PLAN.gates.map((g) => ({ ...g }));
    const result = link.linkPhysicalGates(k, withLevel, { walkingLevel: () => 70, dimension: "minecraft:overworld" });
    assert.deepEqual(result.warnings, []);
    assert.equal(control.listGates(k).length, 5);
    for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 5], [5, 1]]) {
        assert.ok(simGate(k, a, b).physical, `${a}-${b} is physical`);
    }
    const roles = result.links.reduce((acc, l) => ({ ...acc, [l.role]: (acc[l.role] ?? 0) + 1 }), {});
    assert.equal(roles.primary, 5);
    assert.equal(roles.companion, 1, "the second 1-5 gate");
    assert.equal(roles.unmanaged, PLAN.gates.filter((g) => g.between.includes(0)).length);
    assert.equal(new Set(result.links.map((l) => l.id)).size, PLAN.gates.length, "every plan gate is accounted for exactly once");
});

test("bad input never throws and never half-links: no level, bad axis, duplicate id, non-ring pair, garbage", () => {
    const k = createInitialKingdom();
    const before = JSON.stringify(k);
    const bad = link.linkPhysicalGates(k, [
        { id: "gate-a", between: [1, 2], at: { x: 0, z: 0 }, axis: "x", purpose: "main" }, // no walking level
        { id: "gate-b", between: [1, 2], at: { x: 0, z: 0 }, axis: "q", walkingLevel: 64 }, // bad axis
        { id: "gate-c", between: [1, 2], at: { x: 0.5, z: 0 }, axis: "x", walkingLevel: 64 }, // non-integer
        { between: [1, 2], at: { x: 0, z: 0 }, axis: "x", walkingLevel: 64 }, // no id
        null,
        42,
    ], {});
    assert.equal(bad.links.length, 0);
    assert.ok(bad.warnings.length >= 4, bad.warnings.join("\n"));
    assert.equal(JSON.stringify(k), before, "nothing was linked");
    assert.deepEqual(link.linkPhysicalGates(k, "not a list", {}).warnings, ["no gate list was given"]);
    assert.deepEqual(link.linkPhysicalGates({}, SITE_GATES, {}).links.filter((l) => l.role !== "unmanaged"), [], "no kingdom gates, nothing to attach to");
    const dup = link.linkPhysicalGates(createInitialKingdom(), [
        { id: "gate-x", between: [1, 2], at: { x: 0, z: 0 }, axis: "x", walkingLevel: 64 },
        { id: "gate-x", between: [2, 3], at: { x: 9, z: 9 }, axis: "x", walkingLevel: 64 },
    ], {});
    assert.ok(dup.warnings.some((w) => /twice/.test(w)));
    // 1-3 is not a ring pair: it is physical-only, with a warning, and the ring is untouched
    const k2 = createInitialKingdom();
    const odd = link.linkPhysicalGates(k2, [{ id: "gate-w7", between: [1, 3], at: { x: 5, z: 5 }, axis: "z", walkingLevel: 64, purpose: "main" }], {});
    assert.equal(odd.links[0].role, "unmanaged");
    assert.ok(odd.warnings.some((w) => /no simulation gate/.test(w)));
    assert.equal(control.listGates(k2).filter(({ gate }) => gate.mode !== undefined).length, 0);
});

test("validateGateLinks catches duplicate unit ids and malformed link data", () => {
    const k = createInitialKingdom();
    link.linkPhysicalGates(k, SITE_GATES, {});
    simGate(k, 1, 2).physical.companions = [{ id: simGate(k, 5, 1).physical.link.planId, spec: { at: { x: 1, z: 1 }, axis: "x", y: 64 } }];
    simGate(k, 5, 1).physical.companions = "nope";
    simGate(k, 2, 3).physical = { state: "open", spec: { at: { x: 1.5, z: 1 }, axis: "x", y: 64 }, link: {} };
    const problems = link.validateGateLinks(k);
    assert.ok(problems.length >= 3, problems.join("\n"));
});

/* ================================================================== 2. runtime: registration and persistence */

test("registerBuiltGates persists links through the kingdom store, writes the registry and the civ_gate_<id> records (all OPEN), and is idempotent", () => {
    freshWorld({ register: false });
    const first = civGates.registerBuiltGates(store, RECORD, "minecraft:overworld");
    assert.equal(first.ok, true, String(first.reason));
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(first.changes.map((c) => c.kind).sort(), ["linked", "linked", "mode", "mode"]);
    const expectedUnits = [G(1, 2), G(5, 1), COMPANION_15.id, ...OUTER.map((g) => g.id)].sort();
    assert.deepEqual(first.created.slice().sort(), expectedUnits);
    for (const id of expectedUnits) {
        const record = JSON.parse(mc.properties.get(`${GATE_RUNTIME.propertyPrefix}${id}`));
        assert.equal(record.actual, "open", id);
        assert.ok(JSON.stringify(record).length < 300);
    }
    const reg = readGateRegistry();
    assert.deepEqual(reg.gates.map((g) => g.id).sort(), SITE_GATES.map((g) => g.id).sort());
    assert.ok(JSON.stringify(reg).length < 2500, "the registry stays small");
    assert.deepEqual(findValidationProblems(kingdom()), []);
    assert.deepEqual(control.validateGateRecords(kingdom()), []);
    assert.ok(serializeKingdom(kingdom()).length < 30000, "the kingdom blob stays inside the 32 KB property");
    // idempotent, and a gate that has since closed is NOT reset by a second registration (e.g. the builder resuming)
    const adapter = use(createGateAdapter(store));
    buildGatehouses();
    adapter.request(G(1, 2), "closed");
    settle();
    const snapshot = JSON.stringify(kingdom());
    const second = civGates.registerBuiltGates(store, RECORD, "minecraft:overworld");
    assert.equal(second.ok, true);
    assert.deepEqual(second.changes, []);
    assert.deepEqual(second.created, []);
    assert.equal(JSON.stringify(kingdom()), snapshot);
    assert.equal(readGateRecord(G(1, 2)).actual, "closed");
    // refusals
    assert.equal(civGates.registerBuiltGates(store, {}, "overworld").ok, false);
    mc.properties.clear();
    assert.match(civGates.registerBuiltGates(store, RECORD, "overworld").reason, /no kingdom/);
});

test("a gate list may be passed directly, and every gate stays OPEN after registration (no block is written)", () => {
    freshWorld({ register: false });
    const result = civGates.registerBuiltGates(store, SITE_GATES, "minecraft:overworld");
    assert.equal(result.ok, true);
    assert.equal(mc.writes, 0);
    const adapter = use(createGateAdapter(store));
    assert.deepEqual(adapter.pump().started, []);
    for (const g of SITE_GATES) assert.equal(latticeOf(specOf(g)), "open", g.id);
    for (const { gate } of control.listGates(kingdom())) assert.notEqual(gate.state, "sealed");
});

/* ================================================================== 3. real gatehouses: closing, opening, proofs */

test("REAL planned gatehouse blocks: closed gates stop 1x1/1x2/1x3 walkers incl. diagonal squeezing; open gates pass them (independent world-axis proof AND the library proof)", () => {
    for (const g of SITE_GATES) {
        const adapter = use(freshWorld());
        const id = g.id === MAIN_12.id ? G(1, 2) : g.id === PRIMARY_15.id ? G(5, 1) : g.id === COMPANION_15.id ? G(5, 1) : g.id;
        // before closing: open
        for (const h of [1, 2, 3]) {
            assert.equal(worldWalkerCrosses(g, h, true), true, `${g.id} open must pass a 1x${h} walker`);
        }
        assert.equal(adapter.request(id, "closed").status, "running", g.id);
        settle();
        for (const unit of adapter.inspect(id).units) {
            assert.equal(unit.lattice.state, "closed", unit.id);
        }
        for (const h of [1, 2, 3]) {
            for (const squeeze of [true, false]) {
                assert.equal(worldWalkerCrosses(g, h, squeeze), false, `${g.id} closed leaks for 1x${h} squeeze=${squeeze}`);
            }
        }
        // the library proof on the same real blocks agrees
        const ids = new Map();
        for (const c of link.proofCells(specOf(g))) ids.set(cellKey(c), typeAt(c.x, c.y, c.z));
        for (const h of [1, 2, 3]) {
            assert.equal(link.crossingFromWorld(specOf(g), ids, { height: h, squeeze: true }).crosses, false, `${g.id} library proof 1x${h}`);
        }
        adapter.request(id, "open");
        settle();
        for (const h of [1, 2, 3]) {
            assert.equal(worldWalkerCrosses(g, h, true), true, `${g.id} reopened must pass a 1x${h} walker`);
        }
        assert.deepEqual(barsInWorldFor(specOf(g)), []);
    }
});

test("the independent proof is not vacuous: a hole knocked through a tower of the real gatehouse makes a CLOSED gate leak", () => {
    const g = MAIN_12;
    const adapter = use(freshWorld());
    adapter.request(G(1, 2), "closed");
    settle();
    assert.equal(worldWalkerCrosses(g, 2, true), false);
    const s = gates.normalizeSpec(specOf(g));
    // tunnel through the first tower along the crossing direction (u = 4, v = -2..2, h = 0..2)
    for (let v = -2; v <= 2; v += 1) {
        for (let h = 0; h <= 2; h += 1) {
            const w = gates.toWorld(s, 4, v, h);
            mc.blocks.set(key(w.x, w.y, w.z), "minecraft:air");
        }
    }
    assert.equal(worldWalkerCrosses(g, 2, true), true, "the independent proof sees the hole");
    const ids = new Map();
    for (const c of link.proofCells(specOf(g))) ids.set(cellKey(c), typeAt(c.x, c.y, c.z));
    assert.equal(link.crossingFromWorld(specOf(g), ids, { height: 2 }).crosses, true, "and so does the library proof");
});

test("gates visibly transition in ordered steps: closing lowers the top row first, opening lifts the bottom row first, levers last; a pair moves unit by unit", () => {
    const adapter = use(freshWorld());
    const order = [];
    mc.afterWrite = (x, y, z, id) => order.push({ x, y, z, id });
    adapter.request(G(1, 2), "closed");
    settle();
    const bars = order.filter((w) => w.id === "minecraft:iron_bars");
    assert.ok(bars.length > 40);
    for (let i = 1; i < bars.length; i += 1) assert.ok(bars[i].y <= bars[i - 1].y, "bars descend");
    assert.equal(order[order.length - 1].id, "minecraft:lever", "levers flip last");
    const distinctRows = [...new Set(bars.map((w) => w.y))];
    assert.equal(distinctRows.length, 5, "five rows, one after the other");
    order.length = 0;
    adapter.request(G(1, 2), "open");
    settle();
    const clears = order.filter((w) => w.id === "minecraft:air");
    for (let i = 1; i < clears.length; i += 1) assert.ok(clears[i].y >= clears[i - 1].y, "opening lifts bottom row first");
    assert.equal(order[order.length - 1].id, "minecraft:lever");
    // the pair: primary completes before the companion starts, and the kingdom hears only when both arrived
    order.length = 0;
    const pair = SITE_GATES.filter((g) => [PRIMARY_15.id, COMPANION_15.id].includes(g.id));
    const kingdomWhenPrimaryDone = [];
    mc.afterWrite = (x, y, z, id) => {
        order.push({ x, y, z, id });
        const kg = simGate(kingdom(), 5, 1);
        kingdomWhenPrimaryDone.push(`${kg.state}/${kg.physical.state}`);
    };
    adapter.request(G(5, 1), "closed");
    settle();
    const firstOfSecond = order.findIndex((w) => Math.abs(w.x - COMPANION_15.at.x) <= 6 && Math.abs(w.z - COMPANION_15.at.z) <= 6);
    const lastOfFirst = order.map((w) => Math.abs(w.x - PRIMARY_15.at.x) <= 6 && Math.abs(w.z - PRIMARY_15.at.z) <= 6).lastIndexOf(true);
    assert.ok(lastOfFirst < firstOfSecond, "the primary finishes before the companion starts");
    assert.ok(kingdomWhenPrimaryDone.every((state) => state === "open/open"), "the kingdom still reads open/open until the LAST unit arrived");
    const done = simGate(kingdom(), 5, 1);
    assert.equal(done.state, "sealed");
    assert.equal(done.physical.state, "closed");
    for (const g of pair) assert.equal(latticeOf(specOf(g)), "closed", g.id);
});

/* ================================================================== 4. safety with real gatehouses and companions */

test("an entity in the COMPANION's gateway stops the whole pair before the first block is written; nothing is trapped; it closes once clear", () => {
    const adapter = use(freshWorld());
    const companionSpec = specOf(COMPANION_15);
    mc.entities.push(entityAt(companionSpec, 1, "minecraft:player"));
    const loaded = store.load();
    simGate(loaded.kingdom, 5, 1).physical.target = "closed";
    store.save(loaded.kingdom);
    adapter.pump();
    settle();
    assert.equal(mc.writes, 0, "not even the primary closed");
    assert.match(simPhysical(5, 1).physical.blocked, new RegExp(COMPANION_15.id));
    assert.match(simPhysical(5, 1).physical.blocked, /entit/);
    assert.equal(simPhysical(5, 1).state, "open");
    assert.deepEqual(adapter.pump().waiting, [G(5, 1)]);
    mc.entities.length = 0;
    mc.tick += 100000;
    assert.deepEqual(adapter.pump().started, [G(5, 1)]);
    settle();
    assert.equal(simPhysical(5, 1).state, "sealed");
});

test("an entity that wanders into a gateway mid-closing stops that portcullis: no bars are placed in its body cells, no bar is lost, and the move completes later without double writes", () => {
    const run = (interrupt) => {
        const adapter = use(freshWorld());
        const spec = specOf(MAIN_12);
        let tripped = false;
        const entity = entityAt(spec, 0);
        if (interrupt) {
            mc.afterWrite = (x, y) => {
                if (!tripped && y === spec.y + 3) {
                    tripped = true;
                    mc.entities.push(entity);
                }
            };
        }
        const loaded = store.load();
        simGate(loaded.kingdom, 1, 2).physical.target = "closed";
        store.save(loaded.kingdom);
        adapter.pump();
        settle();
        if (interrupt) {
            const bodyCells = [[0, 0], [0, 1]].map(([dx, dy]) => `${Math.floor(entity.location.x)},${spec.y + dy},${Math.floor(entity.location.z)}`);
            for (const cell of bodyCells) assert.notEqual(mc.blocks.get(cell), "minecraft:iron_bars", `bars were placed on top of the entity at ${cell}`);
            assert.equal(readGateRecord(G(1, 2)).actual, "partial");
            assert.equal(simPhysical(1, 2).state, "open");
            mc.entities.length = 0;
            mc.tick += 100000;
            adapter.pump();
            settle();
        }
        assert.equal(simPhysical(1, 2).state, "sealed");
        assert.deepEqual(barsInWorldFor(spec), barsKeys(spec, "closed"));
        return mc.writes;
    };
    assert.equal(run(true), run(false), "same number of writes with and without the interruption");
});

test("a FOREIGN block in a cell of the companion is never overwritten and blocks the whole pair with zero writes; opening leaves it alone", () => {
    const adapter = use(freshWorld());
    const spec = specOf(COMPANION_15);
    const cell = gates.cellsToToggle(spec).find((c) => c.role === "bars" && c.u === 1 && c.h === 2);
    mc.blocks.set(cellKey(cell), "minecraft:oak_planks");
    const result = adapter.request(G(5, 1), "closed");
    assert.equal(result.status, "running");
    settle();
    assert.equal(mc.writes, 0, "the primary was not closed either");
    assert.equal(typeAt(cell.x, cell.y, cell.z), "minecraft:oak_planks");
    assert.match(simPhysical(5, 1).physical.blocked, /oak_planks/);
    assert.match(simPhysical(5, 1).physical.blocked, new RegExp(COMPANION_15.id));
    assert.equal(simPhysical(5, 1).state, "open");
    // close everything that is legal, then open: still never touches the planks
    mc.blocks.delete(cellKey(cell));
    adapter.retryNow(G(5, 1));
    adapter.request(G(5, 1), "closed");
    settle();
    mc.blocks.set(cellKey(cell), "minecraft:oak_planks");
    adapter.request(G(5, 1), "open");
    settle();
    assert.equal(typeAt(cell.x, cell.y, cell.z), "minecraft:oak_planks");
    assert.match(simPhysical(5, 1).physical.blocked, /foreign/);
    // nothing outside the gates' own toggled cells was ever written
    const own = new Set([PRIMARY_15, COMPANION_15].flatMap((g) => gates.cellsToToggle(specOf(g)).map(cellKey)));
    for (const w of mc.writeLog) assert.ok(own.has(cellKey(w)), `wrote outside the gates: ${cellKey(w)}`);
});

test("an unloaded chunk at the companion makes the whole pair wait without a single write, and it completes when the chunk returns", () => {
    const adapter = use(freshWorld());
    mc.unloaded = (p) => Math.abs(p.x - COMPANION_15.at.x) <= 8 && Math.abs(p.z - COMPANION_15.at.z) <= 8;
    adapter.request(G(5, 1), "closed");
    settle();
    assert.equal(mc.writes, 0);
    assert.match(simPhysical(5, 1).physical.blocked, /not loaded/);
    assert.equal(simPhysical(5, 1).state, "open");
    mc.unloaded = () => false;
    const loaded = store.load();
    simGate(loaded.kingdom, 5, 1).physical.target = "closed";
    store.save(loaded.kingdom);
    mc.tick += 100000;
    adapter.pump();
    settle();
    assert.equal(simPhysical(5, 1).state, "sealed");
    assert.equal(simPhysical(5, 1).physical.blocked, undefined);
});

/* ================================================================== 5. restart: pending transitions and agreement */

function agreementOf(a, b) {
    const physical = simPhysical(a, b).physical;
    const inspected = currentAdapter.inspect(G(a, b));
    return civGates.describeAgreement(physical, inspected.units);
}

test("restart mid-closing of the pair: a brand new adapter/store resumes from civ_gate_* and the kingdom; kingdom blob, records and real blocks agree; same writes as an uninterrupted run", () => {
    // uninterrupted reference
    let adapter = use(freshWorld());
    adapter.request(G(5, 1), "closed");
    const referenceSteps = settle();
    const referenceWrites = mc.writes;
    assert.equal(agreementOf(5, 1).agree, true);

    const cuts = [3, Math.floor(referenceSteps * 0.25), Math.floor(referenceSteps * 0.5), Math.floor(referenceSteps * 0.75), referenceSteps - 2];
    for (const cutAfter of cuts) {
        adapter = use(freshWorld());
        const loaded = store.load();
        simGate(loaded.kingdom, 5, 1).physical.target = "closed"; // what the policy does
        store.save(loaded.kingdom);
        adapter.pump();
        stepJobs(cutAfter);
        // --- the world reloads: generators, adapter and store objects are gone; only properties + blocks remain
        adapter = use(restart());
        mc.tick = 5; // system.currentTick restarts from zero after a reload
        const resumed = adapter.pump();
        assert.ok(resumed.started.length <= 1);
        settle();
        const k = simGate(kingdom(), 5, 1);
        assert.equal(k.state, "sealed", `cut after ${cutAfter}`);
        assert.equal(k.physical.state, "closed");
        assert.equal(k.physical.target, undefined);
        for (const g of [PRIMARY_15, COMPANION_15]) {
            assert.equal(readGateRecord(g.id === PRIMARY_15.id ? G(5, 1) : g.id).actual, "closed");
            assert.equal(latticeOf(specOf(g)), "closed");
        }
        const agreement = agreementOf(5, 1);
        assert.equal(agreement.agree, true, agreement.problems.join("; "));
        assert.equal(mc.writes, referenceWrites, `cut after ${cutAfter}: a resumed move writes exactly what an uninterrupted one does`);
        assert.deepEqual(findValidationProblems(kingdom()), []);
    }
});

test("a half-moved gate is never lost: the partial marker is on disk BEFORE the first block is written, so a crash mid-row is walked back when the order was withdrawn", () => {
    let adapter = use(freshWorld());
    const spec = specOf(MAIN_12);
    const loaded = store.load();
    simGate(loaded.kingdom, 1, 2).physical.target = "closed";
    store.save(loaded.kingdom);
    let markerAtFirstWrite;
    mc.afterWrite = () => {
        if (markerAtFirstWrite === undefined) markerAtFirstWrite = readGateRecord(G(1, 2))?.actual;
    };
    adapter.pump();
    stepJobs(1); // survey + the first row; the job is then killed by the reload
    assert.equal(markerAtFirstWrite, "partial", "the record already said partial when the first bar went in");
    assert.ok(barsInWorldFor(spec).length > 0 && barsInWorldFor(spec).length < 45);
    // the policy withdrew the order before the reload
    const patched = store.load();
    delete simGate(patched.kingdom, 1, 2).physical.target;
    store.save(patched.kingdom);
    mc.afterWrite = undefined;
    adapter = use(restart());
    mc.tick = 3;
    assert.deepEqual(adapter.pump().started, [G(1, 2)], "the interrupted move is walked back");
    settle();
    assert.deepEqual(barsInWorldFor(spec), []);
    assert.equal(readGateRecord(G(1, 2)).actual, "open");
    assert.equal(simPhysical(1, 2).physical.state, "open");
    assert.equal(agreementOf(1, 2).agree, true);
});

test("a back-off stamped by an earlier session (tick counter restarted at 0) does not strand a gate after a reload; a giving-up from that session is forgotten too", () => {
    for (const retryAt of [900000, Number.MAX_SAFE_INTEGER]) {
        let adapter = use(freshWorld());
        const loaded = store.load();
        simGate(loaded.kingdom, 1, 2).physical.target = "closed";
        store.save(loaded.kingdom);
        const record = readGateRecord(G(1, 2));
        Object.assign(record, { retryAt, attempts: 7, reason: "an entity was in the way" });
        mc.properties.set(`${GATE_RUNTIME.propertyPrefix}${G(1, 2)}`, JSON.stringify(record));
        adapter = use(restart());
        mc.tick = 10;
        assert.deepEqual(adapter.pump().started, [G(1, 2)], `retryAt ${retryAt}`);
        settle();
        assert.equal(simPhysical(1, 2).state, "sealed");
    }
    // within ONE session, a gate that gave up stays given up until it is re-issued
    const adapter = use(freshWorld());
    mc.entities.push(entityAt(specOf(MAIN_12)));
    const k = store.load();
    simGate(k.kingdom, 1, 2).physical.target = "closed";
    store.save(k.kingdom);
    for (let i = 0; i < GATE_RUNTIME.maxAttempts + 2; i += 1) {
        mc.tick += 100000;
        adapter.pump();
        settle();
    }
    assert.match(simPhysical(1, 2).physical.blocked, /giving up/);
    mc.entities.length = 0;
    mc.tick += 100000;
    assert.deepEqual(adapter.pump().waiting, [G(1, 2)]);
    adapter.retryNow(G(1, 2));
    assert.deepEqual(adapter.pump().started, [G(1, 2)]);
});

/* ================================================================== 6. policy behaviour with linked gates */

function pumpAndSettle(adapter) {
    adapter.pump();
    settle();
}

function invade(k, n, extra = {}) {
    const district = k.districts.find((d) => d.id === D_(n));
    Object.assign(district, { assault: 6, security: "breached", civilians: 0, soldiers: 500, garrison: { front: 400, reserve: 100 }, ...extra });
    return district;
}

test("evacuation keeps the linked gates OPEN: the policy decides open with the reason and no block moves", () => {
    const adapter = use(freshWorld());
    const k = store.load().kingdom;
    invade(k, 1, { civilians: 60 });
    const outcome = control.applyGateDecisions(k);
    store.save(k);
    const d12 = outcome.decisions.find((d) => d.gateId === G(1, 2));
    const d51 = outcome.decisions.find((d) => d.gateId === G(5, 1));
    assert.equal(d12.desired, "open");
    assert.equal(d51.desired, "open");
    assert.match(d12.reasons.join(" "), /evacuation/);
    pumpAndSettle(adapter);
    assert.equal(mc.writes, 0, "evacuation: no gate moved");
    assert.deepEqual(outcome.physical, []);
});

test("reinforcement keeps the linked gate OPEN while a neighbour can send soldiers; no block moves", () => {
    const adapter = use(freshWorld());
    const k = store.load().kingdom;
    invade(k, 5, { assault: 40, soldiers: 5, garrison: { front: 4, reserve: 1 } });
    const reinforce = control.applyGateDecisions(k).decisions.find((d) => d.gateId === G(5, 1));
    store.save(k);
    assert.equal(reinforce.desired, "open");
    assert.match(reinforce.reasons.join(" "), /reinforcement/);
    pumpAndSettle(adapter);
    assert.equal(mc.writes, 0, "reinforcement: no gate moved");
    for (const g of [PRIMARY_15, COMPANION_15, MAIN_12]) assert.equal(latticeOf(specOf(g)), "open");
});

test("friendly traffic keeps a gate open while the other route closes; once the traffic is gone the 1-2 gate is still vetoed for isolation, and the blocks follow the logical state", () => {
    const adapter = use(freshWorld());
    // refugees from district-1 shelter in district-2: the 1-2 gate stays open, so the policy cuts the OTHER route
    let k = store.load().kingdom;
    invade(k, 1, { civilians: 0 });
    k.districts.find((d) => d.id === D_(2)).sheltering = [{ home: D_(1), civilians: 12 }];
    const first = control.applyGateDecisions(k);
    store.save(k);
    assert.match(first.decisions.find((d) => d.gateId === G(1, 2)).reasons.join(" "), /traffic: 12 refugees/);
    assert.deepEqual(first.physical.map((p) => p.gateId), [G(5, 1)], "exactly one cut, on the pair that nobody uses");
    pumpAndSettle(adapter);
    assert.equal(simPhysical(5, 1).state, "sealed");
    for (const g of [PRIMARY_15, COMPANION_15]) assert.equal(latticeOf(specOf(g)), "closed", "both gates of the pair closed together");
    assert.equal(latticeOf(specOf(MAIN_12)), "open");
    // traffic gone: closing the second route would isolate district-1, so it is vetoed and nothing moves
    k = store.load().kingdom;
    k.districts.find((d) => d.id === D_(2)).sheltering = [];
    const second = control.applyGateDecisions(k);
    store.save(k);
    assert.deepEqual(second.physical, []);
    const vetoed = second.decisions.find((d) => d.gateId === G(1, 2));
    assert.ok(vetoed.vetoes.some((v) => /isolate district-1/.test(v)), vetoed.vetoes.join("; "));
    mc.writes = 0;
    pumpAndSettle(adapter);
    assert.equal(mc.writes, 0);
    const states = [[1, 2], [5, 1]].map(([a, b]) => simGate(kingdom(), a, b).state);
    assert.deepEqual(states.slice().sort(), ["open", "sealed"], "district-1 keeps a way out");
    for (const [a, b] of [[1, 2], [5, 1]]) {
        const g = simGate(kingdom(), a, b);
        for (const unit of currentAdapter.inspect(g.id).units) {
            assert.equal(unit.lattice.state, g.state === "sealed" ? "closed" : "open", unit.id + " blocks follow the logical state");
        }
    }
    assert.deepEqual(findValidationProblems(kingdom()), []);
});

test("400 simulation steps of seeded war with REAL gates: blocks always follow the logical state, no district is shut in, and a restart mid-war changes nothing", () => {
    let adapter = use(freshWorld());
    let seenClosed = 0;
    for (let step = 0; step < 400; step += 1) {
        const k = store.load().kingdom;
        const result = advanceKingdomStep(k);
        assert.deepEqual(result.problems, [], `step ${step}`);
        store.save(k);
        adapter.pump();
        settle();
        if (step === 200) {
            adapter = use(restart()); // a reload in the middle of the war
            mc.tick = 7;
            adapter.pump();
            settle();
        }
        const now = store.load().kingdom;
        for (const [a, b] of [[1, 2], [5, 1]]) {
            const g = simGate(now, a, b);
            const pendingMove = g.physical.target !== undefined;
            for (const unit of currentAdapter.inspect(g.id).units) {
                if (!pendingMove) {
                    assert.equal(unit.lattice.state, g.state === "sealed" ? "closed" : "open", `step ${step}: ${unit.id} blocks vs logical ${g.state}`);
                }
            }
            if (g.state === "sealed") seenClosed += 1;
        }
        for (const district of now.districts) {
            if (district.security === "lost") continue;
            const own = control.listGates(now).filter(({ gate: x }) => x.owner === district.id || x.with === district.id);
            if (own.length > 0) assert.ok(own.some(({ gate: x }) => x.state === "open"), `step ${step}: ${district.id} shut in`);
        }
        assert.deepEqual(findValidationProblems(now), [], `step ${step}`);
    }
    assert.ok(seenClosed >= 0);
});

test("manual forced_closed / forced_open persist across simulation ticks and restarts, in the kingdom, the records AND the blocks", () => {
    let adapter = use(freshWorld());
    assert.match(command("civ:gate_close", G(1, 2)), /Mode is now forced_closed/);
    settle();
    assert.equal(simPhysical(1, 2).state, "sealed");
    assert.equal(latticeOf(specOf(MAIN_12)), "closed");
    // 60 ticks of a calm kingdom: the override outlives the calm
    for (let step = 0; step < 60; step += 1) {
        const k = store.load().kingdom;
        advanceKingdomStep(k);
        for (const district of k.districts) Object.assign(district, { assault: 0, security: "secure" });
        store.save(k);
        adapter.pump();
        settle();
    }
    assert.equal(simPhysical(1, 2).state, "sealed");
    assert.equal(simPhysical(1, 2).mode, "forced_closed");
    // restart: still closed, mode still forced, blocks still closed, nothing rewritten
    adapter = use(restart());
    mc.writes = 0;
    mc.tick = 2;
    adapter.pump();
    settle();
    assert.equal(mc.writes, 0);
    assert.equal(simPhysical(1, 2).mode, "forced_closed");
    assert.equal(latticeOf(specOf(MAIN_12)), "closed");
    // forced_open against an invasion of the neighbour
    const k = store.load().kingdom;
    invade(k, 2, { civilians: 0 });
    store.save(k);
    assert.match(command("civ:gate_open", G(1, 2)), /forced_open/);
    settle();
    assert.equal(latticeOf(specOf(MAIN_12)), "open");
    for (let step = 0; step < 30; step += 1) {
        const k2 = store.load().kingdom;
        advanceKingdomStep(k2);
        store.save(k2);
        adapter.pump();
        settle();
    }
    assert.equal(simPhysical(1, 2).mode, "forced_open");
    assert.equal(simPhysical(1, 2).state, "open");
    assert.equal(latticeOf(specOf(MAIN_12)), "open");
    adapter = use(restart());
    mc.tick = 9;
    adapter.pump();
    settle();
    assert.equal(simPhysical(1, 2).mode, "forced_open");
    assert.equal(latticeOf(specOf(MAIN_12)), "open");
    assert.equal(agreementOf(1, 2).agree, true);
});

/* ================================================================== 7. unmanaged (outer) gates */

test("an outer gate with no simulation counterpart stays open on its own, closes only on command, survives a restart closed, and reopens", () => {
    let adapter = use(freshWorld());
    const spec = specOf(OUTER[0]);
    for (let i = 0; i < 5; i += 1) {
        mc.tick += 1000;
        assert.deepEqual(adapter.pump().started, []);
    }
    settle();
    assert.equal(mc.writes, 0, "an unmanaged gate is never touched by the simulation");
    assert.ok(!JSON.stringify(kingdom()).includes(OUTER_ID), "the kingdom has no record of it");
    assert.equal(adapterModule.setUnmanagedMode(OUTER_ID, "forced_closed"), true);
    assert.deepEqual(adapter.pump().started, [OUTER_ID]);
    settle();
    assert.equal(latticeOf(spec), "closed");
    assert.equal(readGateRecord(OUTER_ID).actual, "closed");
    // restart: stays closed (the mode is persisted in the registry) and the pump does not re-open it
    adapter = use(restart());
    mc.writes = 0;
    mc.tick = 4;
    assert.deepEqual(adapter.pump().started, []);
    assert.equal(mc.writes, 0);
    assert.equal(latticeOf(spec), "closed");
    // auto = open again
    assert.equal(adapterModule.setUnmanagedMode(OUTER_ID, "auto"), true);
    assert.deepEqual(adapter.pump().started, [OUTER_ID]);
    settle();
    assert.equal(latticeOf(spec), "open");
    // an entity in its gateway stops a forced close there, too
    mc.entities.push(entityAt(spec));
    adapterModule.setUnmanagedMode(OUTER_ID, "forced_closed");
    mc.tick += 100000;
    adapter.pump();
    settle();
    assert.equal(latticeOf(spec), "open");
    assert.equal(adapterModule.setUnmanagedMode("gate-nope", "forced_closed"), false);
    assert.equal(adapterModule.setUnmanagedMode(G(1, 2), "forced_closed"), false, "a simulation gate is not an unmanaged gate");
});

/* ================================================================== 8. commands: status, test, list */

test("command wiring: gate_status and gate_test are real ids with one colon, the subscription is namespaced", () => {
    assert.deepEqual(commandHandler.options, { namespaces: ["civ"] });
    for (const id of ["civ:gate_status", "civ:gate_test"]) {
        assert.match(id, /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
        assert.equal(id.split(":").length, 2);
    }
});

test("civ:gate_status prints logical state, physical state, mode, blocked reason, position and clearance, and says whether kingdom/records/blocks agree; companions and plan ids resolve", () => {
    use(freshWorld());
    const text = command("civ:gate_status", G(5, 1));
    assert.match(text, /Gate status: gate-district-5-district-1/);
    assert.match(text, /Logical state: open/);
    assert.match(text, /Mode: auto/);
    assert.match(text, /Physical \(kingdom\): open/);
    assert.match(text, /Blocked: no/);
    assert.match(text, new RegExp(`Unit ${G(5, 1)} \\(main\\): blocks open`));
    assert.match(text, new RegExp(`Unit ${COMPANION_15.id} \\(reinforce, companion\\): blocks open`));
    assert.match(text, new RegExp(`position x ${PRIMARY_15.at.x} z ${PRIMARY_15.at.z} walking level y ${PRIMARY_15.walkingLevel}`));
    assert.match(text, /clearance x -?\d+\.\.-?\d+ y -?\d+\.\.-?\d+ z -?\d+\.\.-?\d+: empty/);
    assert.match(text, /agree/);
    assert.match(text, /Policy says open/);
    // a plan id resolves to its simulation gate
    assert.match(command("civ:gate_status", COMPANION_15.id), /Gate status: gate-district-5-district-1/);
    // an outer gate: no simulation fields, but position and blocks
    const outer = command("civ:gate_status", OUTER_ID);
    assert.match(outer, /Outside the simulation/);
    assert.match(outer, new RegExp(`Unit ${OUTER_ID}`));
    // summary and refusals
    const summary = command("civ:gate_status", "");
    assert.match(summary, new RegExp(`${G(1, 2)}  logical open  blocks open  mode auto`));
    assert.match(summary, new RegExp(`${OUTER_ID}  outside the simulation`));
    assert.match(command("civ:gate_status", "nowhere"), /no gate matches/);
    // it shows an entity in the clearance box
    mc.entities.push(entityAt(specOf(MAIN_12)));
    assert.match(command("civ:gate_status", G(1, 2)), /1 in the way \(villager_v2\)/);
    mc.entities.length = 0;
    // and a disagreement: somebody replaced a bar with stone
    const bar = gates.cellsToToggle(specOf(MAIN_12)).find((c) => c.role === "bars");
    mc.blocks.set(cellKey(bar), "minecraft:stone");
    const foreign = command("civ:gate_status", G(1, 2));
    assert.match(foreign, /blocks foreign/);
    assert.match(foreign, /DISAGREEMENT/);
    assert.match(foreign, /stone at/);
});

test("civ:gate_list shows companions moving together and the physical-only gates; a companion plan id controls its pair; outer gates obey open/close/auto", () => {
    use(freshWorld());
    const list = command("civ:gate_list", "");
    assert.match(list, /moves together: gate-\d+ \(main\), gate-\d+ \(reinforce\)/);
    assert.match(list, /Physical-only gates/);
    assert.match(list, new RegExp(`${OUTER_ID}  `));
    const close = command("civ:gate_close", COMPANION_15.id);
    assert.match(close, new RegExp(`${COMPANION_15.id} belongs to ${G(5, 1)}; they move together`));
    settle();
    assert.equal(simPhysical(5, 1).state, "sealed");
    for (const g of [PRIMARY_15, COMPANION_15]) assert.equal(latticeOf(specOf(g)), "closed");
    command("civ:gate_auto", G(5, 1));
    assert.match(command("civ:gate_close", OUTER_ID), /outside the simulation/);
    settle();
    assert.equal(latticeOf(specOf(OUTER[0])), "closed");
    assert.match(command("civ:gate_list", ""), new RegExp(`${OUTER_ID}.*mode forced_closed.*blocks: closed`));
    assert.match(command("civ:gate_open", OUTER_ID), /forced_open/);
    settle();
    assert.equal(latticeOf(specOf(OUTER[0])), "open");
    assert.match(command("civ:gate_auto", OUTER_ID), /Mode is now auto/);
});

function runSelfTest(gateId) {
    const player = makePlayer();
    commandHandler.callback({ id: "civ:gate_test", message: gateId, sourceType: "Entity", sourceEntity: player, initiator: player });
    settle();
    return player.messages.join("\n");
}

test("civ:gate_test on a real gate: close -> sealed -> reopen -> passable, PASS per phase, the gate ends as it began, the simulation hears nothing, no foreign block is touched", () => {
    use(freshWorld());
    const kingdomBefore = JSON.stringify(kingdom());
    const decoyKey = key(MAIN_12.at.x + 40, MAIN_12.walkingLevel, MAIN_12.at.z + 40);
    mc.blocks.set(decoyKey, "minecraft:chest");
    mc.writeLog.length = 0;
    const text = runSelfTest(G(1, 2));
    assert.match(text, /Started: close, verify sealed, reopen, verify passable/);
    assert.match(text, /PASS {2}1 close: every unit is closed/);
    assert.match(text, /PASS {2}2 sealed \(real blocks, 1x1\/1x2\/1x3 walkers\): 6 crossing checks as expected/);
    assert.match(text, /PASS {2}3 reopen: every unit is open again/);
    assert.match(text, /PASS {2}4 passable \(real blocks, 1x1\/1x2\/1x3 walkers\): 6 crossing checks as expected/);
    assert.match(text, /RESULT: PASS \(the gate is open, as it was\)/);
    assert.equal(latticeOf(specOf(MAIN_12)), "open");
    assert.equal(JSON.stringify(kingdom()), kingdomBefore, "the simulation heard nothing: no state, event or log change");
    assert.equal(mc.blocks.get(decoyKey), "minecraft:chest");
    const own = new Set(gates.cellsToToggle(specOf(MAIN_12)).map(cellKey));
    for (const w of mc.writeLog) assert.ok(own.has(cellKey(w)), `self test wrote outside the gate: ${cellKey(w)}`);
    // pair gates and unmanaged gates test too
    assert.match(runSelfTest(G(5, 1)), /RESULT: PASS/);
    assert.match(runSelfTest(OUTER_ID), /RESULT: PASS/);
    for (const g of SITE_GATES) assert.equal(latticeOf(specOf(g)), "open", g.id);
    assert.equal(JSON.stringify(kingdom()), kingdomBefore);
});

test("civ:gate_test on a gate that starts CLOSED opens it, verifies passable, closes it again and verifies sealed", () => {
    use(freshWorld());
    currentAdapter.request(G(1, 2), "closed");
    settle();
    const text = runSelfTest(G(1, 2));
    assert.match(text, /PASS {2}1 open: every unit is open/);
    assert.match(text, /PASS {2}2 passable/);
    assert.match(text, /PASS {2}3 re-close: every unit is closed again/);
    assert.match(text, /PASS {2}4 sealed/);
    assert.match(text, /RESULT: PASS \(the gate is closed, as it was\)/);
    assert.equal(latticeOf(specOf(MAIN_12)), "closed");
});

test("civ:gate_test refuses (and writes nothing): entity in a gateway, foreign block, unloaded chunk, pending order, moving gate, unknown gate", () => {
    use(freshWorld());
    mc.writes = 0;
    mc.entities.push(entityAt(specOf(COMPANION_15), 1, "minecraft:zombie"));
    assert.match(runSelfTest(G(5, 1)), /Gate self test refused[\s\S]*entit[\s\S]*zombie/);
    mc.entities.length = 0;
    const bar = gates.cellsToToggle(specOf(MAIN_12)).find((c) => c.role === "bars" && c.h === 1);
    mc.blocks.set(cellKey(bar), "minecraft:oak_planks");
    assert.match(runSelfTest(G(1, 2)), /foreign|oak_planks/);
    assert.equal(typeAt(bar.x, bar.y, bar.z), "minecraft:oak_planks");
    mc.blocks.delete(cellKey(bar));
    mc.unloaded = () => true;
    assert.match(runSelfTest(G(1, 2)), /not loaded/);
    mc.unloaded = () => false;
    const loaded = store.load();
    simGate(loaded.kingdom, 1, 2).physical.target = "closed";
    store.save(loaded.kingdom);
    assert.match(runSelfTest(G(1, 2)), /order to closed is pending/);
    const clean = store.load();
    delete simGate(clean.kingdom, 1, 2).physical.target;
    store.save(clean.kingdom);
    assert.equal(mc.writes, 0);
    currentAdapter.request(G(1, 2), "closed");
    const player = makePlayer();
    commandHandler.callback({ id: "civ:gate_test", message: G(1, 2), sourceType: "Entity", sourceEntity: player, initiator: player });
    assert.match(player.messages.join("\n"), /moving right now/);
    settle();
    assert.match(runSelfTest("nowhere"), /no gate matches/);
});

test("civ:gate_test FAILS honestly on a leaking gatehouse (hole through a tower) and still restores the gate", () => {
    use(freshWorld());
    const s = gates.normalizeSpec(specOf(MAIN_12));
    for (let v = -2; v <= 2; v += 1) {
        for (let h = 0; h <= 2; h += 1) {
            const w = gates.toWorld(s, 4, v, h);
            mc.blocks.set(key(w.x, w.y, w.z), "minecraft:air");
        }
    }
    const text = runSelfTest(G(1, 2));
    assert.match(text, /FAIL {2}2 sealed/);
    assert.match(text, /walker.*gets through/);
    assert.match(text, /PASS {2}3 reopen/);
    assert.match(text, /RESULT: FAIL/);
    assert.equal(latticeOf(specOf(MAIN_12)), "open", "restored");
});

test("civ:gate_test when the restore cannot finish (an entity walks in): reports it, leaves the kingdom on the original state, and the periodic pump finishes the restore once clear", () => {
    use(freshWorld());
    currentAdapter.request(G(1, 2), "closed");
    settle();
    const spec = specOf(MAIN_12);
    const player = makePlayer();
    commandHandler.callback({ id: "civ:gate_test", message: G(1, 2), sourceType: "Entity", sourceEntity: player, initiator: player });
    let guard = 0;
    while (mc.jobs.length > 0 && guard < 400000) {
        guard += 1;
        mc.tick += 1;
        const job = mc.jobs.shift();
        const result = job.generator.next();
        if (!result.done) mc.jobs.push(job);
        // once phase 1 finished (the gate stands open) a villager steps into the gateway: phase 3 (re-close) must wait
        if (mc.entities.length === 0 && latticeOf(spec) === "open") mc.entities.push(entityAt(spec, 0));
    }
    const text = player.messages.join("\n");
    assert.match(text, /PASS {2}1 open/);
    assert.match(text, /FAIL {2}3 re-close/);
    assert.match(text, /entit/);
    assert.match(text, /RESULT: FAIL/);
    assert.match(text, /stays closed/);
    assert.equal(simPhysical(1, 2).physical.state, "closed", "the kingdom still says closed");
    // the villager leaves; the pump walks the gate back to what the kingdom says
    mc.entities.length = 0;
    mc.tick += 100000;
    currentAdapter.pump();
    settle();
    assert.equal(latticeOf(spec), "closed");
    assert.equal(agreementOf(1, 2).agree, true);
});
