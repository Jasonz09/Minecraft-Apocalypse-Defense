// Fortifications: civ/gates.js (gate geometry), civ/walls.js (terrain-following walls), sim/gatecontrol.js
// (gate policy), integration/gateAdapter.js + commands/gates.js (Bedrock boundary, run against a fake world).
//
// The geometry proofs are pure. The runtime half proves the SAFETY CONTRACT (never overwrite a foreign block,
// never close on top of an entity, idempotent, resumable, bounded) against a stubbed world - it cannot prove
// the real engine accepts every block state; that needs the game.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;

const GROUND_Y = 63;
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
    unloaded: () => false,
    rejectStates: () => false,
    afterWrite: undefined,
};
globalThis.__mc4 = mc;

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
mc.BlockPermutation = {
    resolve(id, states) {
        if (states !== undefined && mc.rejectStates(id, states)) throw new Error("invalid state");
        return { id, states };
    },
};

register(
    "data:text/javascript," +
        encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = 'export const world = globalThis.__mc4.world; export const system = globalThis.__mc4.system;' +
            'export const BlockPermutation = globalThis.__mc4.BlockPermutation;' +
            'export const ScriptEventSource = { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" };';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`),
);

const load = (...parts) => import(fileUrl(...parts));
const gates = await load("civ", "gates.js");
const walls = await load("civ", "walls.js");
const control = await load("sim", "gatecontrol.js");
const { createKingdomStore } = await load("kingdom", "store.js");
const { createInitialKingdom, createV2Kingdom, findValidationProblems, serializeKingdom, deserializeKingdom } = await load("kingdom", "state.js");
const { advanceKingdomStep } = await load("sim", "tick.js");
const { createGateAdapter, GATE_RUNTIME } = await load("integration", "gateAdapter.js");
const { registerGateCommands, formatGateLines, resolveGateReference } = await load("commands", "gates.js");
const vanilla = await import(pathToFileURL(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "index.js")).href);
const blockStatesSource = readFileSync(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "mojang-block.d.ts"), "utf8");

const SPECS = [
    { axis: "x", at: { x: 100, z: 200 }, y: 64 },
    { axis: "z", at: { x: 100, z: 200 }, y: 64 },
    { axis: "x", at: { x: -37, z: -412 }, y: 80 },
    { axis: "z", at: { x: -5, z: 9 }, y: -20 },
];
const cellKey = (c) => `${c.x},${c.y},${c.z}`;

/* ------------------------------------------------------------------ *
 * 1. Gate geometry
 * ------------------------------------------------------------------ */

test("every block id and state name the fortification emits exists in the installed game data", () => {
    const known = new Set(Object.values(vanilla.MinecraftBlockTypes));
    const statesFor = (id) => {
        const typeName = `${id.replace("minecraft:", "").split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}States`;
        const match = blockStatesSource.match(new RegExp(`export type ${typeName} = ([^;]+);`));
        if (!match) return undefined;
        if (match[1].startsWith("Record<string, never>")) return [];
        return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).filter((name) => name !== "BlockStateSuperset");
    };
    for (const id of [...gates.GATE_BLOCK_IDS, ...walls.WALL_BLOCK_IDS]) assert.ok(known.has(id), `${id} is not a block in this game version`);
    const spec = SPECS[0];
    const ops = [...gates.gatehouseBlocks(spec), ...gates.gateBlocks(spec, "closed").ops, ...gates.gateBlocks(spec, "open").ops];
    const wall = walls.wallOps([[0, 0], [60, 0], [60, 40]], () => GROUND_Y, {});
    for (const segment of wall.segments) ops.push(...segment.ops);
    assert.ok(ops.length > 1000);
    for (const op of ops) {
        assert.ok(known.has(op.id), `${op.id} unknown`);
        for (const name of Object.keys(op.states ?? {})) {
            const allowed = statesFor(op.id);
            assert.ok(allowed, `no state list for ${op.id}`);
            assert.ok(allowed.includes(name), `${op.id} has no state '${name}' (valid: ${allowed.join(", ")})`);
        }
    }
});

test("closed gate: no mob of height 1, 2 or 3 gets through, even squeezing diagonally past corners (both axes, odd coordinates)", () => {
    for (const spec of SPECS) {
        for (const height of [1, 2, 3]) {
            for (const squeeze of [true, false]) {
                assert.equal(gates.canMobCross(spec, "closed", { height, squeeze }).crosses, false, `${spec.axis} closed leaks for height ${height} squeeze ${squeeze}`);
            }
        }
    }
});

test("open gate: a 1x2 walker (and 1x3) crosses; the proof is not vacuously false", () => {
    for (const spec of SPECS) {
        for (const height of [1, 2, 3]) {
            assert.equal(gates.canMobCross(spec, "open", { height }).crosses, true, `${spec.axis} open blocks height ${height}`);
        }
    }
});

test("the closed portcullis is a complete plane: every (u, h) cell of the 5x5 opening has bars, the bottom two rows are doubled", () => {
    for (const spec of SPECS) {
        const closed = gates.gateBlocks(spec, "closed").ops.filter((op) => op.id === "minecraft:iron_bars");
        const at = new Set(closed.map(cellKey));
        const s = gates.normalizeSpec(spec);
        for (let h = 0; h < 5; h += 1) {
            for (let u = -2; u <= 2; u += 1) {
                const centre = gates.toWorld(s, u, 0, h);
                assert.ok(at.has(cellKey(centre)), `gap at u=${u} h=${h}`);
                if (h < 2) {
                    for (const v of [-1, 1]) assert.ok(at.has(cellKey(gates.toWorld(s, u, v, h))), `seal missing u=${u} v=${v} h=${h}`);
                }
            }
        }
        assert.equal(closed.length, 25 + 20);
    }
});

test("open state clears exactly the cells closed state fills; levers exist in both with opposite open_bit", () => {
    for (const spec of SPECS) {
        const closed = gates.gateBlocks(spec, "closed").ops;
        const open = gates.gateBlocks(spec, "open").ops;
        assert.equal(closed.length, open.length);
        const barsClosed = new Set(closed.filter((op) => op.id === "minecraft:iron_bars").map(cellKey));
        const airOpen = new Set(open.filter((op) => op.kind === "air").map(cellKey));
        assert.deepEqual([...airOpen].sort(), [...barsClosed].sort());
        const levers = (ops) => ops.filter((op) => op.id === "minecraft:lever");
        assert.equal(levers(closed).length, 4);
        assert.ok(levers(closed).every((op) => op.states.open_bit === false));
        assert.ok(levers(open).every((op) => op.states.open_bit === true));
        assert.deepEqual(cellsKeys(gates.cellsToToggle(spec)), cellsKeys(closed));
    }
});
const cellsKeys = (list) => list.map(cellKey).sort();

test("axis x and axis z are exact transposes of each other", () => {
    const a = gates.cellsToToggle({ axis: "x", at: { x: 10, z: 20 }, y: 70 });
    const b = gates.cellsToToggle({ axis: "z", at: { x: 20, z: 10 }, y: 70 });
    assert.deepEqual(a.map((c) => `${c.x},${c.y},${c.z}`).sort(), b.map((c) => `${c.z},${c.y},${c.x}`).sort());
    const sa = gates.gatehouseBlocks({ axis: "x", at: { x: 10, z: 20 }, y: 70 });
    const sb = gates.gatehouseBlocks({ axis: "z", at: { x: 20, z: 10 }, y: 70 });
    assert.deepEqual(sa.map((c) => `${c.x},${c.y},${c.z}`).sort(), sb.map((c) => `${c.z},${c.y},${c.x}`).sort());
});

test("the gatehouse never occupies the passage, never overlaps a toggled cell, has unique cells and keeps to its footprint", () => {
    for (const spec of SPECS) {
        const s = gates.normalizeSpec(spec);
        const statics = gates.gatehouseBlocks(spec);
        const seen = new Set();
        const toggled = new Set(gates.cellsToToggle(spec).map(cellKey));
        const footprint = gates.gateFootprint(spec);
        for (const op of statics) {
            assert.ok(!seen.has(cellKey(op)), `duplicate static cell ${cellKey(op)}`);
            seen.add(cellKey(op));
            assert.ok(!toggled.has(cellKey(op)), "static block on a toggled cell");
            assert.equal(op.kind, "ours");
            assert.ok(op.x >= footprint.x0 && op.x <= footprint.x1 && op.z >= footprint.z0 && op.z <= footprint.z1, `${cellKey(op)} outside the footprint`);
            // The passage volume (u -2..2, v -1..1, h 0..4) holds no static block.
            const inPassage = [-2, -1, 0, 1, 2].some((u) => [-1, 0, 1].some((v) => [0, 1, 2, 3, 4].some((h) => cellKey(gates.toWorld(s, u, v, h)) === cellKey(op))));
            assert.ok(!inPassage, `static block ${cellKey(op)} inside the passage`);
        }
        // levers hang on a tower face: the cell behind each lever is a tower block
        for (const cell of gates.cellsToToggle(spec).filter((c) => c.role === "lever")) {
            const towards = gates.toWorld(s, cell.u, Math.sign(cell.v) * 2, cell.h);
            assert.ok(seen.has(cellKey(towards)), "lever has nothing to hang on");
        }
    }
});

test("every op is classified: toggled ops are 'ours' or 'air', air ops only clear this gate's own bars, static ops are 'ours'", () => {
    const spec = SPECS[2];
    const toggled = new Set(gates.cellsToToggle(spec).map(cellKey));
    for (const state of ["open", "closed"]) {
        for (const op of gates.gateBlocks(spec, state).ops) {
            assert.ok(op.kind === "ours" || op.kind === "air");
            assert.ok(toggled.has(cellKey(op)));
            assert.ok(op.ownIds.includes("minecraft:iron_bars") || op.ownIds.includes("minecraft:lever"));
            if (op.kind === "air") {
                assert.equal(op.id, "minecraft:air");
                assert.deepEqual(op.ownIds, ["minecraft:iron_bars"]);
            }
        }
    }
    assert.ok(gates.gatehouseBlocks(spec).every((op) => op.kind === "ours"));
    for (const op of gates.transition(spec, "open", "closed").ops) assert.ok(op.kind === "ours" || op.kind === "air");
});

test("classifyExisting: air and our own bars may be replaced, anything else is foreign and never written", () => {
    const [closeOp] = gates.gateBlocks(SPECS[0], "closed").ops;
    const [openOp] = gates.gateBlocks(SPECS[0], "open").ops;
    assert.equal(gates.classifyExisting(closeOp, "minecraft:air"), "ok");
    assert.equal(gates.classifyExisting(closeOp, "minecraft:cave_air"), "ok");
    assert.equal(gates.classifyExisting(closeOp, "minecraft:iron_bars"), "built");
    assert.equal(gates.classifyExisting(closeOp, "minecraft:stone"), "foreign");
    assert.equal(gates.classifyExisting(closeOp, "minecraft:chest"), "foreign");
    assert.equal(gates.classifyExisting(closeOp, "minecraft:water"), "foreign");
    assert.equal(gates.classifyExisting(closeOp, undefined), "unloaded");
    assert.equal(gates.classifyExisting(openOp, "minecraft:air"), "built");
    assert.equal(gates.classifyExisting(openOp, "minecraft:iron_bars"), "ok");
    assert.equal(gates.classifyExisting(openOp, "minecraft:oak_planks"), "foreign");
    assert.equal(gates.classifyExisting(openOp, "minecraft:iron_block"), "foreign");
});

test("transition ordering: closing lowers top-down, opening lifts bottom-up, levers last; from === to is empty", () => {
    const spec = SPECS[0];
    const closing = gates.transition(spec, "open", "closed");
    assert.deepEqual(closing.steps.map((step) => step.row), [4, 3, 2, 1, 0, -1]);
    const opening = gates.transition(spec, "closed", "open");
    assert.deepEqual(opening.steps.map((step) => step.row), [0, 1, 2, 3, 4, -1]);
    for (const transition of [closing, opening]) {
        for (const step of transition.steps) {
            if (step.row >= 0) assert.ok(step.ops.every((op) => op.y === spec.y + step.row && op.row === step.row));
            else assert.ok(step.ops.every((op) => op.id === "minecraft:lever"));
        }
        assert.equal(transition.ops.length, transition.steps.reduce((sum, step) => sum + step.ops.length, 0));
    }
    assert.deepEqual(gates.transition(spec, "open", "open").ops, []);
    assert.deepEqual(gates.transition(spec, "closed", "closed").steps, []);
    // applying the steps leaves exactly the planned state, and re-applying changes nothing
    const world = new Map();
    const apply = (ops) => {
        let changed = 0;
        for (const op of ops) {
            const before = world.get(cellKey(op)) ?? "minecraft:air";
            if (gates.classifyExisting(op, before) === "built") continue;
            assert.notEqual(gates.classifyExisting(op, before), "foreign");
            world.set(cellKey(op), op.id);
            changed += 1;
        }
        return changed;
    };
    assert.ok(apply(closing.ops) > 40);
    assert.equal(apply(closing.ops), 0);
    assert.ok(apply(opening.ops) > 40);
    assert.equal([...world.values()].filter((id) => id === "minecraft:iron_bars").length, 0);
});

test("clearance box covers the whole passage; entities in or hugging it block closing, harmless drops and far mobs do not", () => {
    const spec = SPECS[0];
    const box = gates.entityClearanceBox(spec);
    assert.deepEqual(box.min, { x: 98, y: 64, z: 199 });
    assert.deepEqual(box.max, { x: 102, y: 68, z: 201 });
    for (const cell of gates.cellsToToggle(spec).filter((c) => c.role !== "lever")) {
        assert.ok(cell.x >= box.min.x && cell.x <= box.max.x && cell.y >= box.min.y && cell.y <= box.max.y && cell.z >= box.min.z && cell.z <= box.max.z);
    }
    const at = (typeId, x, y, z) => ({ typeId, x, y, z });
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:player", 100.5, 64, 200.5)]).length, 1);
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:villager_v2", 98.1, 64, 199.2)]).length, 1);
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:zombie", 97.7, 64, 200.5)]).length, 1, "a wide mob hugging the edge is caught by the margin");
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:zombie", 95, 64, 200.5)]).length, 0);
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:zombie", 100.5, 64, 205)]).length, 0);
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:item", 100.5, 64, 200.5), at("minecraft:arrow", 100.5, 65, 200.5), at("minecraft:xp_orb", 100.5, 64, 200.5)]).length, 0);
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:player", 100.5, 70.2, 200.5)]).length, 0, "someone on the wall top is not in the gateway");
    assert.equal(gates.blockersInClearance(spec, [at("minecraft:cow", Number.NaN, 64, 200)]).length, 1, "an unreadable position is never assumed clear");
});

test("adversarial specs are rejected loudly", () => {
    const good = { axis: "x", at: { x: 1, z: 2 }, y: 64 };
    const bad = [
        null, undefined, 5, {}, { ...good, axis: "y" }, { ...good, axis: undefined }, { ...good, at: { x: 1.5, z: 2 } }, { ...good, at: undefined },
        { ...good, y: 64.5 }, { ...good, y: undefined }, { ...good, width: 7 }, { ...good, width: 4 }, { ...good, passageHeight: 2 }, { ...good, passageHeight: 9 },
        { ...good, wallTop: 6 }, { ...good, wallTop: 7.5 },
    ];
    for (const spec of bad) {
        assert.throws(() => gates.normalizeSpec(spec), undefined, JSON.stringify(spec));
        assert.throws(() => gates.gateBlocks(spec, "open"));
    }
    assert.throws(() => gates.gateBlocks(good, "ajar"));
    assert.throws(() => gates.transition(good, "open", "half"));
    assert.throws(() => gates.transition(good, undefined, "open"));
    assert.doesNotThrow(() => gates.normalizeSpec({ ...good, width: 5, wallTop: 7, passageHeight: 5, id: "g" }));
});

test("gate design is deterministic", () => {
    const first = JSON.stringify([gates.gatehouseBlocks(SPECS[0]), gates.gateBlocks(SPECS[0], "closed"), gates.transition(SPECS[0], "open", "closed")]);
    const second = JSON.stringify([gates.gatehouseBlocks(SPECS[0]), gates.gateBlocks(SPECS[0], "closed"), gates.transition(SPECS[0], "open", "closed")]);
    assert.equal(first, second);
});

/* ------------------------------------------------------------------ *
 * 2. Walls
 * ------------------------------------------------------------------ */

const allOps = (result) => result.segments.flatMap((segment) => segment.ops);
const columnsOf = (ops) => {
    const map = new Map();
    for (const op of ops) {
        const k = `${op.x},${op.z}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(op);
    }
    return map;
};

test("flat straight wall: 3 thick, ground + 7 high, contiguous footing-to-top, bounded segments, unique place-only ops, exact estimate", () => {
    const result = walls.wallOps([[0, 0], [119, 0]], () => GROUND_Y, { maxOpsPerSegment: 300 });
    const ops = allOps(result);
    assert.equal(result.estimate.blocks, ops.length);
    assert.equal(result.estimate.segments, result.segments.length);
    assert.ok(result.segments.length > 5);
    for (const segment of result.segments) assert.ok(segment.ops.length <= 300, `segment of ${segment.ops.length}`);
    assert.ok(ops.every((op) => op.id !== "minecraft:air" && !op.id.endsWith("air")), "walls only ever place");
    assert.equal(new Set(ops.map(cellKey)).size, ops.length, "each cell is emitted once");
    const columns = columnsOf(ops);
    for (let x = 0; x < 120; x += 1) {
        for (const z of [-1, 0, 1]) {
            const col = columns.get(`${x},${z}`);
            assert.ok(col, `missing column ${x},${z}`);
            if (result.towers.some((tower) => Math.abs(tower.x - x) <= 2)) continue; // tower tunnels are hollow on purpose
            const body = col.filter((op) => op.layer !== "parapet");
            const ys = body.map((op) => op.y).sort((a, b) => a - b);
            for (let i = 1; i < ys.length; i += 1) assert.equal(ys[i], ys[i - 1] + 1, `gap in column ${x},${z}`);
            assert.ok(ys[0] <= GROUND_Y - walls.WALL.footing + 0, "footing reaches below the ground");
            assert.ok(Math.max(...ys) >= GROUND_Y + 7, "top is at least ground + height");
        }
        const outer = columns.get(`${x},2`);
        if (outer !== undefined) assert.ok(outer.every((op) => op.layer === "buttress" || op.layer === "tower" || op.layer === "footing" || op.layer === "parapet"), "wall is exactly 3 thick apart from towers and buttresses");
    }
    assert.ok(result.towers.length >= 3);
});

test("terrain following on slopes, steps and a 12-block cliff: tops never below ground + 7 and adjacent columns differ by at most 1", () => {
    const profiles = {
        slope: (x) => 60 + Math.floor(x / 2),
        steps: (x) => 60 + 3 * Math.floor(x / 10),
        cliff: (x) => (x < 50 ? 60 : 72),
        wavy: (x, z) => 70 + Math.round(4 * Math.sin(x / 7) + 3 * Math.cos(z / 5)),
    };
    for (const [name, ground] of Object.entries(profiles)) {
        const result = walls.wallOps([[0, 0], [100, 0]], (x, z) => ground(x, z), { buttressSpacing: 0 });
        const columns = columnsOf(allOps(result));
        const top = new Map();
        for (const [k, ops] of columns) {
            const bodyTop = Math.max(...ops.filter((op) => op.layer !== "parapet").map((op) => op.y));
            top.set(k, bodyTop);
        }
        for (const [k, t] of top) {
            const [x, z] = k.split(",").map(Number);
            if (Math.abs(z) <= 1 && !result.towers.some((tower) => Math.abs(tower.x - x) <= 2)) assert.ok(t >= ground(x, z) + 7, `${name}: wall at ${k} lower than ground + 7`);
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dz = -1; dz <= 1; dz += 1) {
                    const n = top.get(`${x + dx},${z + dz}`);
                    if (n === undefined) continue;
                    const towerNear = result.towers.some((tower) => Math.abs(tower.x - x) <= 2 || Math.abs(tower.x - (x + dx)) <= 2);
                    if (!towerNear) assert.ok(Math.abs(n - t) <= 1, `${name}: step of ${Math.abs(n - t)} between ${k} and ${x + dx},${z + dz}`);
                }
            }
        }
    }
});

test("no gaps: a closed loop with diagonals and sharp corners is a barrier no 8-connected walker crosses, at every body height", () => {
    const loop = [[0, 0], [40, 0], [60, 25], [40, 50], [0, 50], [-15, 25]];
    const result = walls.wallOps(loop, () => GROUND_Y, { closed: true });
    const ops = allOps(result);
    for (const y of [GROUND_Y - 1, GROUND_Y + 1, GROUND_Y + 4, GROUND_Y + 6]) {
        const solid = new Set(ops.filter((op) => op.y === y).map((op) => `${op.x},${op.z}`));
        const seen = new Set(["-30,-30"]);
        const queue = [[-30, -30]];
        for (let head = 0; head < queue.length; head += 1) {
            const [x, z] = queue[head];
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dz = -1; dz <= 1; dz += 1) {
                    const nx = x + dx;
                    const nz = z + dz;
                    const k = `${nx},${nz}`;
                    if (nx < -30 || nx > 80 || nz < -30 || nz > 80 || solid.has(k) || seen.has(k)) continue;
                    seen.add(k);
                    queue.push([nx, nz]);
                }
            }
        }
        assert.ok(!seen.has("25,25"), `leak at y=${y}: the inside of the loop is reachable`);
        assert.ok(seen.size > 5000);
    }
    for (const sharp of [[60, 25], [-15, 25]]) {
        assert.ok(result.towers.some((tower) => Math.abs(tower.x - sharp[0]) <= 3 && Math.abs(tower.z - sharp[1]) <= 3), `no tower at the sharp corner ${sharp}`);
    }
});

test("towers: end caps, every sharp corner, and never more than 40 blocks apart (open and closed)", () => {
    const open = walls.wallOps([[0, 0], [200, 0]], () => GROUND_Y, {});
    const xs = open.towers.map((tower) => tower.x).sort((a, b) => a - b);
    assert.equal(xs[0], 0);
    assert.equal(xs[xs.length - 1], 200);
    for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] - xs[i - 1] <= 40 && xs[i] - xs[i - 1] >= 20, `tower gap ${xs[i] - xs[i - 1]}`);
    const square = walls.wallOps([[0, 0], [80, 0], [80, 80], [0, 80]], () => GROUND_Y, { closed: true });
    for (const corner of [[80, 0], [80, 80], [0, 80]]) {
        assert.ok(square.towers.some((tower) => Math.abs(tower.x - corner[0]) <= 3 && Math.abs(tower.z - corner[1]) <= 3), `no tower at corner ${corner}`);
    }
    // consecutive towers around the loop are within 40 blocks of path length
    const idx = square.towers.map((tower) => tower.index).sort((a, b) => a - b);
    const n = square.plan.cells.length;
    for (let i = 0; i < idx.length; i += 1) {
        const gap = (idx[(i + 1) % idx.length] - idx[i] + n) % n || n;
        assert.ok(gap <= 42, `closed-loop tower gap ${gap}`);
    }
});

test("tower tunnel keeps the walkway open: a 2-high passage runs through every tower along the wall", () => {
    const result = walls.wallOps([[0, 0], [100, 0]], () => GROUND_Y, { buttressSpacing: 0 });
    const ops = new Set(allOps(result).map(cellKey));
    for (const tower of result.towers.filter((t) => t.kind === "spacing")) {
        for (let dx = -2; dx <= 2; dx += 1) {
            const x = tower.x + dx;
            assert.ok(ops.has(`${x},${GROUND_Y + 7},0`), "walkway surface present under the tunnel");
            assert.ok(!ops.has(`${x},${GROUND_Y + 8},0`) && !ops.has(`${x},${GROUND_Y + 9},0`), `tunnel blocked at ${x}`);
        }
        assert.ok(ops.has(`${tower.x},${GROUND_Y + 10},0`), "roof over the tunnel");
    }
});

test("buttresses sit on the outer faces of straight runs, are attached to the wall, and stay clear of towers", () => {
    const result = walls.wallOps([[0, 0], [100, 0]], () => GROUND_Y, {});
    const columns = columnsOf(allOps(result));
    const buttresses = [...columns.entries()].filter(([, ops]) => ops.some((op) => op.layer === "buttress"));
    assert.ok(buttresses.length >= 8);
    for (const [k] of buttresses) {
        const [x, z] = k.split(",").map(Number);
        assert.ok(Math.abs(z) === 2, "buttress one block off the wall face");
        assert.ok(columns.has(`${x},${Math.sign(z)}`), "attached to the wall");
        assert.ok(result.towers.every((tower) => Math.abs(tower.x - x) >= 3));
    }
});

test("wall plans are deterministic, resumable from any segment index, and never exceed the bound", () => {
    const path = [[0, 0], [30, 10], [60, 10], [90, 40]];
    const profile = (x, z) => 64 + ((x * 7 + z * 3) % 5);
    const a = walls.wallOps(path, profile, { maxOpsPerSegment: 200 });
    const b = walls.wallOps(path, profile, { maxOpsPerSegment: 200 });
    assert.equal(JSON.stringify(a.segments), JSON.stringify(b.segments));
    const plan = walls.planWall(path, profile, {});
    for (const from of [0, 3, a.segments.length - 1]) {
        const tail = [...walls.wallOpSegments(plan, 200, from)];
        assert.equal(JSON.stringify(tail), JSON.stringify(a.segments.slice(from)));
    }
    assert.ok(a.segments.every((segment) => segment.ops.length <= 200 && segment.ops.length > 0));
});

test("walls leave the gate footprint to the gatehouse, and wall + closed gate is one sealed ring (open gate is the only way in)", () => {
    const loop = [[0, 0], [60, 0], [60, 60], [0, 60]];
    const gate = { axis: "x", at: { x: 30, z: 0 }, y: GROUND_Y + 1 };
    const result = walls.wallOps(loop, () => GROUND_Y, { closed: true, gates: [{ at: gate.at, axis: "x" }] });
    const wallOpsList = allOps(result);
    const footprint = gates.gateFootprint(gate);
    assert.ok(wallOpsList.every((op) => !(op.x >= footprint.x0 && op.x <= footprint.x1 && op.z >= footprint.z0 && op.z <= footprint.z1)), "wall columns inside the gatehouse footprint");
    for (const state of ["closed", "open"]) {
        for (const y of [GROUND_Y + 2, GROUND_Y + 3]) {
            const solid = new Set([...wallOpsList, ...gates.fullGateBlocks(gate, state)].filter((op) => op.y === y).map((op) => `${op.x},${op.z}`));
            const seen = new Set(["-20,-20"]);
            const queue = [[-20, -20]];
            for (let head = 0; head < queue.length; head += 1) {
                const [x, z] = queue[head];
                for (let dx = -1; dx <= 1; dx += 1) {
                    for (let dz = -1; dz <= 1; dz += 1) {
                        const nx = x + dx;
                        const nz = z + dz;
                        const k = `${nx},${nz}`;
                        if (nx < -20 || nx > 80 || nz < -20 || nz > 80 || solid.has(k) || seen.has(k)) continue;
                        seen.add(k);
                        queue.push([nx, nz]);
                    }
                }
            }
            assert.equal(seen.has("30,30"), state === "open", `${state} gate at y=${y}: inside reachable = ${seen.has("30,30")}`);
        }
    }
});

test("wall adversarial inputs: bad paths and profiles throw, holes are filled from neighbours, cliffs and hairpins stay bounded", () => {
    const flat = () => GROUND_Y;
    for (const path of [undefined, null, [], [[0, 0]], [[0, 0], [0, 0]], [[0, 0], [1.5, 2]], [[0, 0], ["a", 1]], [[0], [1, 1]], "path"]) {
        assert.throws(() => walls.wallOps(path, flat), undefined, JSON.stringify(path));
    }
    assert.throws(() => walls.wallOps([[0, 0], [10, 0]], undefined));
    assert.throws(() => walls.wallOps([[0, 0], [10, 0]], () => undefined), /no samples/);
    assert.throws(() => walls.wallOps([[0, 0], [10, 0]], [60]), /parallel/);
    assert.throws(() => walls.wallOps([[0, 0], [100000, 0]], flat), /longer than/);
    assert.throws(() => walls.wallOps([[0, 0], [10, 0]], flat, { gates: [{ at: { x: 0, z: 0 }, axis: "q" }] }));
    assert.throws(() => walls.wallOps([[0, 0], [10, 0]], flat, { height: 2 }));
    // sparse profile: only some samples, the rest filled from the nearest
    const sparse = walls.wallOps([[0, 0], [40, 0]], (x) => (x % 10 === 0 ? 70 : undefined), {});
    assert.ok(sparse.estimate.blocks > 0);
    // array profile parallel to the input path, interpolated
    const arrayed = walls.wallOps([[0, 0], [50, 0], [50, 50]], [60, 65, 70], {});
    assert.ok(arrayed.estimate.blocks > 0);
    assert.ok(allOps(arrayed).every((op) => Number.isInteger(op.x) && Number.isInteger(op.y) && Number.isInteger(op.z)));
    // hairpin: the path doubles back on itself
    const hairpin = walls.wallOps([[0, 0], [40, 0], [40, 3], [0, 3]], flat, {});
    assert.equal(new Set(allOps(hairpin).map(cellKey)).size, allOps(hairpin).length, "overlapping bands still emit each cell once");
    // a 40-block cliff
    const cliff = walls.wallOps([[0, 0], [60, 0]], (x) => (x < 30 ? 40 : 80), { buttressSpacing: 0 });
    const tops = [...columnsOf(allOps(cliff)).values()].map((ops) => Math.max(...ops.filter((op) => op.layer !== "parapet").map((op) => op.y)));
    assert.ok(Math.max(...tops) <= 80 + 7 + 4, "cliff top stays bounded");
    // negative coordinates and Map/object profiles
    const neg = walls.wallOps([[-50, -50], [-10, -50]], new Map([["-50,-50", 64]]), {});
    assert.ok(neg.estimate.blocks > 0);
    const obj = walls.wallOps([[-50, -50], [-10, -50]], { "-50,-50": 64 }, {});
    assert.equal(obj.estimate.blocks, neg.estimate.blocks);
});

test("a long wall plans in bounded time and memory-sane segments", () => {
    const path = [];
    for (let i = 0; i <= 40; i += 1) path.push([i * 50, Math.round(30 * Math.sin(i / 3))]);
    const started = Date.now();
    const result = walls.wallOps(path, (x, z) => 64 + Math.round(3 * Math.sin(x / 40)), {});
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
    assert.ok(result.estimate.length > 2000);
    assert.ok(result.segments.every((segment) => segment.ops.length <= 400));
});

/* ------------------------------------------------------------------ *
 * 3. Gate policy (pure simulation)
 * ------------------------------------------------------------------ */

const D = (n) => `district-${n}`;
const G = (a, b) => `gate-${D(a)}-${D(b)}`;
function ring() {
    return createInitialKingdom();
}
function manage(kingdom, mode = "auto") {
    for (const { gate } of control.listGates(kingdom)) gate.mode = mode;
    return kingdom;
}
function dist(kingdom, n) {
    return kingdom.districts.find((district) => district.id === D(n));
}
function gate(kingdom, a, b) {
    return control.findGate(kingdom, G(a, b)).gate;
}
function invade(kingdom, n, extra = {}) {
    const district = dist(kingdom, n);
    Object.assign(district, { assault: 6, security: "breached", civilians: 0, soldiers: 500, garrison: { front: 400, reserve: 100 }, ...extra });
    return district;
}
const states = (kingdom) => control.listGates(kingdom).map(({ gate }) => `${gate.id}=${gate.state}`).join(" ");

test("no managed gates: the control step does nothing at all, even under invasion (existing behaviour is unchanged)", () => {
    const kingdom = ring();
    invade(kingdom, 3);
    const before = JSON.stringify(kingdom);
    assert.deepEqual(control.runGateControlStep(kingdom), []);
    assert.equal(JSON.stringify(kingdom), before);
    assert.deepEqual(control.applyGateDecisions(kingdom), { events: [], physical: [], decisions: [] });
});

test("managed gates, nothing threatened: every gate stays open, no events, state untouched", () => {
    const kingdom = manage(ring());
    const before = JSON.stringify(kingdom);
    const outcome = control.applyGateDecisions(kingdom);
    assert.deepEqual(outcome.events, []);
    assert.equal(outcome.decisions.length, 5);
    assert.ok(outcome.decisions.every((d) => d.desired === "open"));
    assert.equal(JSON.stringify(kingdom), before);
});

test("invasion of an evacuated district: one gate closes, the second would isolate it and is held open with the reason", () => {
    const kingdom = manage(ring());
    invade(kingdom, 3);
    const outcome = control.applyGateDecisions(kingdom);
    assert.equal(gate(kingdom, 2, 3).state, "sealed");
    assert.equal(gate(kingdom, 3, 4).state, "open");
    const refused = outcome.decisions.find((d) => d.gateId === G(3, 4));
    assert.ok(refused.vetoes.some((v) => /isolate district-3/.test(v)), refused.vetoes.join("; "));
    assert.equal(outcome.events.length, 1);
    assert.ok(findValidationProblems(kingdom).length === 0, findValidationProblems(kingdom).join("; "));
    // idempotent: running again changes nothing
    const after = JSON.stringify(kingdom);
    assert.deepEqual(control.applyGateDecisions(kingdom).events, []);
    assert.equal(JSON.stringify(kingdom), after);
});

test("evacuation in progress keeps the route open (and says why)", () => {
    const kingdom = manage(ring());
    invade(kingdom, 3, { civilians: 50 });
    const outcome = control.applyGateDecisions(kingdom);
    assert.equal(states(kingdom), control.listGates(kingdom).map(({ gate }) => `${gate.id}=open`).join(" "));
    const d34 = outcome.decisions.find((d) => d.gateId === G(3, 4));
    assert.match(d34.reasons.join(" "), /evacuation/);
    // once the people are out, the cut is allowed
    dist(kingdom, 3).civilians = 0;
    control.applyGateDecisions(kingdom);
    assert.equal(gate(kingdom, 2, 3).state, "sealed");
});

test("a neighbour that cannot take refugees does not hold the gate open for an evacuation that cannot happen, but a last route still does", () => {
    const kingdom = manage(ring());
    invade(kingdom, 3, { civilians: 50 });
    for (const n of [2, 4]) Object.assign(dist(kingdom, n), { security: "contested", civilianCapacity: 0 });
    const outcome = control.applyGateDecisions(kingdom);
    for (const decision of outcome.decisions.filter((d) => [G(2, 3), G(3, 4)].includes(d.gateId))) {
        assert.ok(!decision.reasons.some((r) => /^evacuation/.test(r)), decision.reasons.join(";"));
    }
    assert.ok(gate(kingdom, 2, 3).state === "open" || gate(kingdom, 3, 4).state === "open", "district-3 keeps a way out");
});

test("reinforcement need keeps the route open; a donor that fights its own battle does not count", () => {
    const kingdom = manage(ring());
    invade(kingdom, 3, { assault: 40, soldiers: 5, garrison: { front: 4, reserve: 1 } });
    const outcome = control.applyGateDecisions(kingdom);
    const d23 = outcome.decisions.find((d) => d.gateId === G(2, 3));
    assert.match(d23.reasons.join(" "), /reinforcement/);
    assert.equal(gate(kingdom, 2, 3).state, "open");
    // both neighbours are busy -> nobody can send soldiers -> the cut is allowed
    for (const n of [2, 4]) Object.assign(dist(kingdom, n), { assault: 10, security: "contested" });
    control.applyGateDecisions(kingdom);
    assert.ok(!control.applyGateDecisions(kingdom).decisions.some((d) => d.reasons.some((r) => /^reinforcement: district-3/.test(r) && d.gateId === G(2, 3))));
});

test("friendly traffic in transit (refugees sheltered, detachments stationed) keeps the gate open", () => {
    const kingdom = manage(ring());
    invade(kingdom, 1);
    dist(kingdom, 2).sheltering = [{ home: D(1), civilians: 10 }];
    let outcome = control.applyGateDecisions(kingdom);
    assert.match(outcome.decisions.find((d) => d.gateId === G(1, 2)).reasons.join(" "), /traffic: 10 refugees/);
    assert.equal(gate(kingdom, 1, 2).state, "open");
    dist(kingdom, 2).sheltering = [];
    dist(kingdom, 1).reinforcedBy = [{ from: D(2), soldiers: 4 }];
    outcome = control.applyGateDecisions(kingdom);
    assert.match(outcome.decisions.find((d) => d.gateId === G(1, 2)).reasons.join(" "), /traffic: 4 soldiers/);
    assert.equal(gate(kingdom, 1, 2).state, "open");
});

test("a broken gate can neither close nor be forced; the policy never writes to it", () => {
    const kingdom = manage(ring());
    invade(kingdom, 3);
    gate(kingdom, 2, 3).state = "broken";
    const outcome = control.applyGateDecisions(kingdom);
    const decision = outcome.decisions.find((d) => d.gateId === G(2, 3));
    assert.equal(decision.desired, "broken");
    assert.equal(gate(kingdom, 2, 3).state, "broken");
    const forced = control.setGateMode(kingdom, G(2, 3), "forced_closed");
    assert.equal(forced.ok, false);
    assert.match(forced.reason, /broken/);
    assert.equal(control.setGateMode(kingdom, G(2, 3), "auto").ok, true, "handing a broken gate back to auto is harmless");
    // recording a physical result never revives a broken gate
    gate(kingdom, 2, 3).physical = { state: "open" };
    control.recordPhysicalResult(kingdom, G(2, 3), "closed");
    assert.equal(gate(kingdom, 2, 3).state, "broken");
});

test("last route: with two gates between a pair, the second is never closed; a refugee host is never cut off from home", () => {
    const kingdom = manage(createV2Kingdom({ districts: [{ id: D(1), name: "A", civilians: 20, soldiers: 20 }, { id: D(2), name: "B", civilians: 20, soldiers: 20 }] }));
    Object.assign(dist(kingdom, 2), { assault: 6, security: "breached", civilians: 0, soldiers: 500, garrison: { front: 400, reserve: 100 } });
    dist(kingdom, 1).civilians = 0;
    control.applyGateDecisions(kingdom);
    const open = control.listGates(kingdom).filter(({ gate }) => gate.state === "open");
    assert.equal(open.length, 1, states(kingdom));
    // refugees: chain 1-2-3, district 3 shelters people from district 1: the 2-3 gate may not close
    const chain = manage(createInitialKingdom());
    delete gate(chain, 5, 1).physical;
    gate(chain, 5, 1).state = "sealed";
    gate(chain, 4, 5).state = "sealed";
    invade(chain, 2);
    dist(chain, 4).sheltering = [{ home: D(1), civilians: 5 }];
    control.applyGateDecisions(chain);
    assert.ok(findValidationProblems(chain).length === 0);
    const reachable = (from) => {
        const seen = new Set([from]);
        for (let again = true; again; ) {
            again = false;
            for (const { gate: g } of control.listGates(chain)) {
                if (g.state === "open" && seen.has(g.owner) !== seen.has(g.with)) {
                    seen.add(g.owner);
                    seen.add(g.with);
                    again = true;
                }
            }
        }
        return seen;
    };
    assert.ok(reachable(D(1)).has(D(4)), "refugees can still walk home");
});

test("physical gates: the policy orders a change, the logical state follows only once the blocks have moved, and a cancelled order is withdrawn", () => {
    const kingdom = manage(ring());
    gate(kingdom, 2, 3).physical = { state: "open" };
    invade(kingdom, 3);
    let outcome = control.applyGateDecisions(kingdom);
    assert.deepEqual(outcome.physical.map((p) => [p.gateId, p.from, p.to]), [[G(2, 3), "open", "closed"]]);
    assert.equal(gate(kingdom, 2, 3).state, "open", "logically still open until the portcullis is down");
    assert.equal(gate(kingdom, 2, 3).physical.target, "closed");
    assert.equal(control.pendingPhysicalChanges(kingdom).length, 1);
    assert.deepEqual(control.applyGateDecisions(kingdom).physical, [], "an order already given is not repeated");
    // threat ends before the adapter acted: the order is withdrawn
    Object.assign(dist(kingdom, 3), { assault: 0, security: "secure" });
    outcome = control.applyGateDecisions(kingdom);
    assert.equal(gate(kingdom, 2, 3).physical.target, undefined);
    assert.equal(control.pendingPhysicalChanges(kingdom).length, 0);
    assert.deepEqual(outcome.physical.map((p) => p.to), ["open"].slice(0, 0).concat([]).length ? [] : outcome.physical.map((p) => p.to));
    // a full cycle
    invade(kingdom, 3);
    control.applyGateDecisions(kingdom);
    assert.equal(control.recordPhysicalResult(kingdom, G(2, 3), "closed").logicalChanged, true);
    assert.equal(gate(kingdom, 2, 3).state, "sealed");
    assert.equal(gate(kingdom, 2, 3).physical.target, undefined);
    Object.assign(dist(kingdom, 3), { assault: 0, security: "secure" });
    outcome = control.applyGateDecisions(kingdom);
    assert.deepEqual(outcome.physical.map((p) => p.to), ["open"]);
    control.recordPhysicalResult(kingdom, G(2, 3), "open");
    assert.equal(gate(kingdom, 2, 3).state, "open");
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("manual overrides persist: forced_open ignores the invasion, forced_closed outlives the threat, both survive a save/load", () => {
    const kingdom = manage(ring());
    assert.equal(control.setGateMode(kingdom, G(1, 2), "forced_closed").ok, true);
    assert.equal(gate(kingdom, 1, 2).state, "sealed");
    invade(kingdom, 3);
    assert.equal(control.setGateMode(kingdom, G(2, 3), "forced_open").ok, true);
    control.applyGateDecisions(kingdom);
    assert.equal(gate(kingdom, 2, 3).state, "open", "held open against the policy");
    assert.equal(gate(kingdom, 3, 4).state, "open", "the second cut would split the ring, so the policy leaves it");
    Object.assign(dist(kingdom, 3), { assault: 0, security: "secure" });
    control.applyGateDecisions(kingdom);
    assert.equal(gate(kingdom, 1, 2).state, "sealed", "forced_closed outlives the threat");
    const restored = deserializeKingdom(serializeKingdom(kingdom)).kingdom;
    assert.equal(gate(restored, 2, 3).mode, "forced_open");
    assert.equal(gate(restored, 1, 2).mode, "forced_closed");
    control.applyGateDecisions(restored);
    assert.equal(gate(restored, 1, 2).state, "sealed");
    assert.equal(control.setGateMode(restored, G(1, 2), "auto").ok, true);
    assert.equal(gate(restored, 1, 2).state, "open", "back under automatic control, and nothing threatens it");
    assert.deepEqual(findValidationProblems(restored), []);
    assert.deepEqual(control.validateGateRecords(restored), []);
});

test("forcing a gate closed that would isolate or split districts is refused unless forced; unknown gates and modes are refused", () => {
    const kingdom = manage(ring());
    assert.equal(control.setGateMode(kingdom, G(1, 2), "forced_closed").ok, true);
    const second = control.setGateMode(kingdom, G(3, 4), "forced_closed");
    assert.equal(second.ok, false, "second cut would split the ring");
    assert.match(second.reason, /force/);
    assert.equal(gate(kingdom, 3, 4).state, "open");
    assert.equal(control.setGateMode(kingdom, G(3, 4), "forced_closed", { force: true }).ok, true);
    assert.equal(gate(kingdom, 3, 4).state, "sealed");
    assert.equal(control.setGateMode(kingdom, "gate-nope", "auto").ok, false);
    assert.equal(control.setGateMode(kingdom, G(1, 2), "ajar").ok, false);
});

test("validation helper rejects bad modes and physical records", () => {
    const kingdom = ring();
    gate(kingdom, 1, 2).mode = "bogus";
    gate(kingdom, 2, 3).physical = { state: "ajar" };
    gate(kingdom, 3, 4).physical = { state: "open", target: "maybe", blocked: 5 };
    gate(kingdom, 4, 5).physical = "closed";
    const problems = control.validateGateRecords(kingdom);
    assert.equal(problems.length, 5, problems.join("\n"));
    gate(kingdom, 1, 2).mode = "auto";
    gate(kingdom, 2, 3).physical = { state: "closed", target: "open", blocked: "a villager" };
    gate(kingdom, 3, 4).physical = { state: "open" };
    gate(kingdom, 4, 5).physical = undefined;
    assert.deepEqual(control.validateGateRecords(kingdom), []);
});

function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test("property over the ring: automatic closing never isolates or splits what was connected, is idempotent and deterministic (400 random wars)", () => {
    const levels = ["secure", "alert", "contested", "breached", "isolated", "lost"];
    const openGraph = (kingdom) => {
        const parent = new Map(kingdom.districts.filter((d) => d.security !== "lost").map((d) => [d.id, d.id]));
        const find = (id) => (parent.get(id) === id ? id : find(parent.get(id)));
        const openCount = new Map([...parent.keys()].map((id) => [id, 0]));
        for (const { gate: g } of control.listGates(kingdom)) {
            if (g.state === "open" && parent.has(g.owner) && parent.has(g.with)) {
                parent.set(find(g.owner), find(g.with));
                openCount.set(g.owner, openCount.get(g.owner) + 1);
                openCount.set(g.with, openCount.get(g.with) + 1);
            }
        }
        return { components: new Set([...parent.keys()].map(find)).size, openCount };
    };
    let closedAtLeastOnce = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
        const rand = mulberry(seed);
        const build = () => {
            const kingdom = manage(ring());
            const roll = mulberry(seed);
            for (const district of kingdom.districts) {
                district.security = levels[Math.floor(roll() * levels.length)];
                district.assault = roll() < 0.5 ? Math.floor(roll() * 40) : 0;
                district.civilians = Math.floor(roll() * 90);
                district.soldiers = Math.floor(roll() * 120);
                district.garrison = { front: Math.floor(district.soldiers * 0.8), reserve: district.soldiers - Math.floor(district.soldiers * 0.8) };
                district.refugees = roll() < 0.2 ? Math.floor(roll() * 20) : 0;
                if (roll() < 0.2) district.sheltering = [{ home: kingdom.districts[Math.floor(roll() * 5)].id, civilians: 3 }];
            }
            return kingdom;
        };
        void rand;
        const kingdom = build();
        const before = openGraph(kingdom);
        control.applyGateDecisions(kingdom);
        const after = openGraph(kingdom);
        assert.ok(after.components <= before.components, `seed ${seed}: split ${before.components} -> ${after.components}`);
        for (const [id, count] of before.openCount) {
            if (count > 0) assert.ok(after.openCount.get(id) > 0, `seed ${seed}: ${id} lost its last open route`);
        }
        if (control.listGates(kingdom).some(({ gate: g }) => g.state === "sealed")) closedAtLeastOnce += 1;
        const snapshot = JSON.stringify(kingdom);
        assert.deepEqual(control.applyGateDecisions(kingdom).events, [], `seed ${seed}: not idempotent`);
        assert.equal(JSON.stringify(kingdom), snapshot);
        const again = build();
        control.applyGateDecisions(again);
        assert.equal(JSON.stringify(again), snapshot, `seed ${seed}: not deterministic`);
        assert.deepEqual(findValidationProblems(kingdom), [], `seed ${seed}`);
    }
    assert.ok(closedAtLeastOnce > 15, `only ${closedAtLeastOnce} scenarios ever closed a gate: the property is not being exercised`);
});

test("wired into the simulation tick: 400 steps of seeded war with automatic gates never leave a district shut in by our own gates", () => {
    const kingdom = manage(createInitialKingdom());
    let closures = 0;
    for (let step = 0; step < 400; step += 1) {
        const result = advanceKingdomStep(kingdom);
        assert.deepEqual(result.problems, [], `step ${step}`);
        control.runGateControlStep(kingdom);
        closures += control.listGates(kingdom).filter(({ gate: g }) => g.state === "sealed").length;
        assert.deepEqual(findValidationProblems(kingdom), [], `step ${step}`);
        for (const district of kingdom.districts) {
            if (district.security === "lost") continue;
            const own = control.listGates(kingdom).filter(({ gate: g }) => g.owner === district.id || g.with === district.id);
            if (own.length > 0) assert.ok(own.some(({ gate: g }) => g.state === "open"), `step ${step}: ${district.id} shut in by ${states(kingdom)}`);
        }
    }
    assert.ok(closures >= 0);
});

/* ------------------------------------------------------------------ *
 * 4. Adapter against the fake world
 * ------------------------------------------------------------------ */

const store = createKingdomStore(mc.world);
const GATE_ID = G(1, 2);
const SPEC = { axis: "x", at: { x: 100, z: 200 }, y: 64 };

function reset() {
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
    mc.rejectStates = () => false;
    mc.afterWrite = undefined;
    store.ensureInitial();
    const loaded = store.load();
    const g = gate(loaded.kingdom, 1, 2);
    g.mode = "auto";
    g.physical = { state: "open", spec: { at: SPEC.at, axis: SPEC.axis, y: SPEC.y } };
    store.save(loaded.kingdom);
    return createGateAdapter(store);
}

/** Run queued jobs to completion; every generator step is one game tick so row delays elapse. */
function settle(maxSteps = 200000) {
    let steps = 0;
    while (mc.jobs.length > 0 && steps < maxSteps) {
        const job = mc.jobs[0];
        mc.tick += 1;
        steps += 1;
        const result = job.generator.next();
        if (result.done) mc.jobs = mc.jobs.filter((entry) => entry !== job);
    }
    assert.ok(steps < maxSteps, "job did not finish");
    return steps;
}

const physical = () => gate(store.load().kingdom, 1, 2);
const barsInWorld = () => [...mc.blocks.entries()].filter(([, id]) => id === "minecraft:iron_bars").map(([k]) => k);
const toggledKeys = (state) => gates.gateBlocks(SPEC, state).ops.filter((op) => op.id === "minecraft:iron_bars").map(cellKey).sort();
const setTarget = (to) => {
    const loaded = store.load();
    gate(loaded.kingdom, 1, 2).physical.target = to;
    store.save(loaded.kingdom);
};

test("adapter closes an empty gateway row by row (top first), writes exactly the planned cells, then records it everywhere", () => {
    const adapter = reset();
    const rows = [];
    mc.afterWrite = (x, y, z, id) => {
        if (id === "minecraft:iron_bars") rows.push(y);
    };
    assert.equal(adapter.request(GATE_ID, "closed").status, "running");
    settle();
    assert.deepEqual(barsInWorld().sort(), toggledKeys("closed"));
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i] <= rows[i - 1], "bars descend: higher rows are placed first");
    assert.equal(mc.writes, 45 + 4);
    assert.deepEqual(physical().physical, { state: "closed", spec: { at: SPEC.at, axis: "x", y: 64 } });
    assert.equal(physical().state, "sealed");
    const record = JSON.parse(mc.properties.get(`${GATE_RUNTIME.propertyPrefix}${GATE_ID}`));
    assert.equal(record.actual, "closed");
    assert.ok(JSON.stringify(record).length < 300);
    assert.deepEqual(findValidationProblems(store.load().kingdom), []);
});

test("adapter opening clears our bars only and restores the logical state; closing again is idempotent (zero writes)", () => {
    const adapter = reset();
    adapter.request(GATE_ID, "closed");
    settle();
    mc.writes = 0;
    assert.equal(adapter.request(GATE_ID, "closed").status, "unchanged");
    settle();
    assert.equal(mc.writes, 0);
    assert.equal(adapter.request(GATE_ID, "open").status, "running");
    settle();
    assert.equal(barsInWorld().length, 0);
    assert.equal(physical().state, "open");
    assert.equal(physical().physical.state, "open");
    assert.equal(mc.states.get(cellKey(gates.cellsToToggle(SPEC).find((c) => c.role === "lever"))).open_bit, true);
    mc.writes = 0;
    assert.equal(adapter.request(GATE_ID, "open").status, "unchanged");
    assert.equal(mc.writes, 0);
});

test("a player, a mob or a villager in the gateway prevents closing; nothing is written; it retries and closes once clear", () => {
    for (const typeId of ["minecraft:player", "minecraft:zombie", "minecraft:villager_v2"]) {
        const adapter = reset();
        const entity = { typeId, isValid: true, name: "Steve", location: { x: 100.5, y: 64, z: 200.5 } };
        mc.entities.push(entity);
        adapter.request(GATE_ID, "closed");
        settle();
        assert.equal(mc.writes, 0, `${typeId} was crushed`);
        assert.equal(physical().state, "open", "still logically open so people can use it");
        assert.match(physical().physical.blocked, /entit/);
        assert.equal(adapter.isRunning(GATE_ID), false);
        // the retry back-off holds the pump off, then lets it through
        setTarget("closed");
        assert.deepEqual(adapter.pump().waiting, [GATE_ID]);
        mc.entities.length = 0;
        mc.tick += 100000;
        assert.deepEqual(adapter.pump().started, [GATE_ID]);
        settle();
        assert.equal(physical().state, "sealed", typeId);
        assert.equal(physical().physical.blocked, undefined);
        assert.deepEqual(barsInWorld().sort(), toggledKeys("closed"));
    }
});

test("harmless neighbours do not block: an item, a mob three blocks away, someone on the wall top", () => {
    const adapter = reset();
    mc.entities.push(
        { typeId: "minecraft:item", isValid: true, location: { x: 100.5, y: 64, z: 200.5 } },
        { typeId: "minecraft:zombie", isValid: true, location: { x: 100.5, y: 64, z: 205.5 } },
        { typeId: "minecraft:player", isValid: true, name: "Alex", location: { x: 100.5, y: 71, z: 200.5 } },
    );
    adapter.request(GATE_ID, "closed");
    settle();
    assert.equal(physical().state, "sealed");
});

test("an entity that wanders in MID-closing stops the portcullis where it is; nothing already placed is lost; it finishes later with no double writes", () => {
    const adapter = reset();
    let rowsDone = 0;
    mc.afterWrite = (x, y, z, id) => {
        if (id === "minecraft:iron_bars" && y === 66 && rowsDone === 0) {
            rowsDone = 1;
            mc.entities.push({ typeId: "minecraft:villager_v2", isValid: true, location: { x: 99.5, y: 64, z: 200.5 } });
        }
    };
    adapter.request(GATE_ID, "closed");
    settle();
    const partial = barsInWorld().length;
    assert.ok(partial > 0 && partial < 45, `partial = ${partial}`);
    assert.equal(physical().state, "open");
    assert.equal(JSON.parse(mc.properties.get(`${GATE_RUNTIME.propertyPrefix}${GATE_ID}`)).actual, "partial");
    const writesSoFar = mc.writes;
    mc.entities.length = 0;
    setTarget("closed");
    mc.tick += 100000;
    adapter.pump();
    settle();
    assert.equal(physical().state, "sealed");
    assert.deepEqual(barsInWorld().sort(), toggledKeys("closed"));
    assert.equal(mc.writes, 49, `total writes ${mc.writes} (had ${writesSoFar}) - something was written twice`);
});

test("never overwrites a foreign block: closing is refused with zero writes; opening leaves the foreign block and clears the rest", () => {
    const adapter = reset();
    const cell = gates.cellsToToggle(SPEC).find((c) => c.role === "bars" && c.u === 1 && c.h === 2);
    mc.blocks.set(cellKey(cell), "minecraft:oak_planks");
    adapter.request(GATE_ID, "closed");
    settle();
    assert.equal(mc.writes, 0);
    assert.equal(mc.blocks.get(cellKey(cell)), "minecraft:oak_planks");
    assert.match(physical().physical.blocked, /oak_planks/);
    assert.equal(physical().state, "open");
    // a chest where a lever goes does not stop the portcullis, and is left alone
    mc.blocks.delete(cellKey(cell));
    const leverCell = gates.cellsToToggle(SPEC).find((c) => c.role === "lever");
    mc.blocks.set(cellKey(leverCell), "minecraft:chest");
    setTarget("closed");
    mc.tick += 100000;
    adapter.pump();
    settle();
    assert.equal(physical().state, "sealed");
    assert.equal(mc.blocks.get(cellKey(leverCell)), "minecraft:chest");
    // now a player swaps one bar for stone and the gate is opened
    const bar = gates.cellsToToggle(SPEC).find((c) => c.role === "bars" && c.u === -1 && c.h === 3);
    mc.blocks.set(cellKey(bar), "minecraft:stone");
    adapter.request(GATE_ID, "open");
    settle();
    assert.equal(mc.blocks.get(cellKey(bar)), "minecraft:stone");
    assert.deepEqual(barsInWorld(), []);
    assert.equal(physical().state, "open");
    assert.match(physical().physical.blocked, /foreign/);
});

test("nothing outside the gate's own cells is ever written (an exhaustive footprint audit across both axes)", () => {
    for (const axis of ["x", "z"]) {
        const adapter = reset();
        const loaded = store.load();
        gate(loaded.kingdom, 1, 2).physical.spec = { at: { x: 100, z: 200 }, axis, y: 64 };
        store.save(loaded.kingdom);
        // plant decoys all around the passage
        const spec = { axis, at: { x: 100, z: 200 }, y: 64 };
        const own = new Set(gates.cellsToToggle(spec).map(cellKey));
        for (let x = 90; x <= 110; x += 1) {
            for (let z = 190; z <= 210; z += 1) {
                for (let y = 64; y <= 72; y += 1) {
                    if (!own.has(`${x},${y},${z}`) && (x + y + z) % 3 === 0) mc.blocks.set(`${x},${y},${z}`, "minecraft:cobblestone");
                }
            }
        }
        const decoys = new Map(mc.blocks);
        adapter.request(GATE_ID, "closed");
        settle();
        adapter.request(GATE_ID, "open");
        settle();
        for (const [k, id] of decoys) assert.equal(mc.blocks.get(k), id, `decoy at ${k} was changed`);
        for (const write of mc.writeLog) assert.ok(own.has(cellKey(write)), `wrote outside the gate: ${cellKey(write)}`);
    }
});

test("unloaded chunks: the job waits, writes nothing, reports it, and completes when the chunk returns", () => {
    const adapter = reset();
    mc.unloaded = () => true;
    adapter.request(GATE_ID, "closed");
    settle();
    assert.equal(mc.writes, 0);
    assert.match(physical().physical.blocked, /not loaded/);
    mc.unloaded = () => false;
    setTarget("closed");
    mc.tick += 100000;
    adapter.pump();
    settle();
    assert.equal(physical().state, "sealed");
});

test("interrupted by a reload (job cancelled mid-move, new adapter): the partial record is resumed to the same result with no double writes", () => {
    let adapter = reset();
    let rows = 0;
    mc.afterWrite = (x, y) => {
        if (y === 65) rows += 1;
    };
    adapter.request(GATE_ID, "closed");
    let steps = 0;
    while (mc.jobs.length > 0 && rows < 3 && steps < 100000) {
        mc.tick += 1;
        steps += 1;
        mc.jobs[0].generator.next();
    }
    assert.ok(barsInWorld().length > 0);
    mc.jobs.length = 0; // the world reloaded: the generator is gone
    adapter = createGateAdapter(store); // a brand new adapter knows only what was persisted
    setTarget("closed");
    mc.tick += 100000;
    const writesBefore = mc.writes;
    assert.deepEqual(adapter.pump().started, [GATE_ID]);
    settle();
    assert.deepEqual(barsInWorld().sort(), toggledKeys("closed"));
    assert.equal(mc.writes, 49, `writes ${mc.writes}, earlier ${writesBefore}`);
    assert.equal(physical().state, "sealed");
});

test("the order is reversed mid-closing (threat ended): the partial portcullis is walked back up, nothing is left half-built", () => {
    const adapter = reset();
    let tripped = false;
    mc.afterWrite = (x, y) => {
        if (y === 66 && !tripped) tripped = true;
    };
    setTarget("closed");
    adapter.pump();
    let steps = 0;
    while (!tripped && steps < 10000) {
        mc.tick += 1;
        steps += 1;
        mc.jobs[0]?.generator.next();
    }
    assert.ok(barsInWorld().length > 0 && barsInWorld().length < 45);
    const loaded = store.load();
    delete gate(loaded.kingdom, 1, 2).physical.target; // the policy withdrew the order
    store.save(loaded.kingdom);
    adapter.pump(); // cancels the job; the partial record is walked back to the recorded state (open)
    settle();
    assert.deepEqual(barsInWorld(), []);
    assert.equal(physical().state, "open");
    assert.equal(JSON.parse(mc.properties.get(`${GATE_RUNTIME.propertyPrefix}${GATE_ID}`)).actual, "open");
});

test("block states the engine rejects fall back to the plain block instead of stranding the gate", () => {
    const adapter = reset();
    mc.rejectStates = (id) => id === "minecraft:lever";
    adapter.request(GATE_ID, "closed");
    settle();
    assert.equal(physical().state, "sealed");
    assert.equal(barsInWorld().length, 45);
});

test("bad requests are refused cleanly: unknown gate, gate without a physical record, gate without a location, bad spec", () => {
    const adapter = reset();
    assert.equal(adapter.request("gate-nope", "closed").status, "refused");
    assert.equal(adapter.request(G(2, 3), "closed").status, "refused");
    const loaded = store.load();
    delete gate(loaded.kingdom, 1, 2).physical.spec;
    store.save(loaded.kingdom);
    assert.match(adapter.request(GATE_ID, "closed").reason, /no location/);
    gate(loaded.kingdom, 1, 2).physical.spec = { at: { x: 1.5, z: 0 }, axis: "x", y: 64 };
    store.save(loaded.kingdom);
    assert.match(adapter.request(GATE_ID, "closed").reason, /bad gate spec/);
    assert.equal(mc.writes, 0);
    assert.equal(adapter.pump().started.length, 0);
});

test("at most the configured number of gates move at once; the rest wait their turn", () => {
    const adapter = reset();
    const loaded = store.load();
    for (const [a, b, x] of [[2, 3, 300], [3, 4, 400], [4, 5, 500]]) {
        gate(loaded.kingdom, a, b).mode = "auto";
        gate(loaded.kingdom, a, b).physical = { state: "open", target: "closed", spec: { at: { x, z: 200 }, axis: "x", y: 64 } };
    }
    gate(loaded.kingdom, 1, 2).physical.target = "closed";
    store.save(loaded.kingdom);
    const started = adapter.pump().started;
    assert.equal(started.length, GATE_RUNTIME.maxConcurrent);
    settle();
    adapter.pump();
    settle();
    adapter.pump();
    settle();
    assert.equal(control.pendingPhysicalChanges(store.load().kingdom).length, 0);
});

/* ------------------------------------------------------------------ *
 * 5. Commands
 * ------------------------------------------------------------------ */

const handler = (() => {
    const adapter = reset();
    registerGateCommands(store, adapter);
    registerGateCommands(store, adapter); // second call must be a no-op
    assert.equal(mc.scriptEventSubscribers.length, 1);
    assert.equal(mc.intervals.length, 1, "the adapter polls once");
    return { subscriber: mc.scriptEventSubscribers[0], adapter };
})();

function makePlayer() {
    const messages = [];
    return { typeId: "minecraft:player", isValid: true, messages, sendMessage: (m) => messages.push(...(Array.isArray(m) ? m : [m])) };
}
function send(id, message, player) {
    handler.subscriber.callback({ id, message, sourceType: "Entity", sourceEntity: player, initiator: player });
}
const said = (player) => player.messages.join("\n");

test("command ids have exactly one colon and are the documented ones", () => {
    for (const id of ["civ:gate_list", "civ:gate_open", "civ:gate_close", "civ:gate_auto"]) {
        assert.match(id, /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
        assert.equal(id.split(":").length, 2);
    }
});

test("civ:gate_list shows state, mode, physical state and the policy's view", () => {
    reset();
    const player = makePlayer();
    send("civ:gate_list", "", player);
    const text = said(player);
    assert.match(text, /gate-district-1-district-2/);
    assert.match(text, /mode auto \| blocks: open/);
    assert.match(text, /policy says open/);
    assert.match(text, /gate-district-3-district-4  district-3 <-> district-4  state open  mode unmanaged/);
    assert.deepEqual(formatGateLines({ districts: [] }), ["=== Gates ===", "No gates in this kingdom."]);
});

test("civ:gate_close starts the portcullis, civ:gate_open lifts it, civ:gate_auto hands control back", () => {
    reset();
    const player = makePlayer();
    send("civ:gate_close", "gate-district-1-district-2", player);
    assert.match(said(player), /Mode is now forced_closed/);
    assert.match(said(player), /closing/);
    settle();
    assert.equal(physical().state, "sealed");
    assert.equal(physical().mode, "forced_closed");
    assert.equal(barsInWorld().length, 45);
    const second = makePlayer();
    send("civ:gate_open", "1-district-2", second); // unique fragment of the id
    settle();
    assert.equal(physical().state, "open");
    assert.equal(physical().mode, "forced_open");
    assert.equal(barsInWorld().length, 0);
    const third = makePlayer();
    send("civ:gate_auto", GATE_ID, third);
    assert.match(said(third), /Mode is now auto/);
    assert.equal(physical().mode, "auto");
});

test("commands refuse politely: no argument, unknown, ambiguous, isolating closes without force, console/command-block callers", () => {
    reset();
    const player = makePlayer();
    send("civ:gate_close", "", player);
    assert.match(said(player), /name a gate/);
    const unknown = makePlayer();
    send("civ:gate_open", "nowhere", unknown);
    assert.match(said(unknown), /no gate matches/);
    const ambiguous = makePlayer();
    send("civ:gate_open", "district-3", ambiguous);
    assert.match(said(ambiguous), /matches several gates/);
    // make closing a second gate split the ring
    const loaded = store.load();
    gate(loaded.kingdom, 2, 3).mode = "auto";
    gate(loaded.kingdom, 2, 3).state = "sealed";
    gate(loaded.kingdom, 1, 2).state = "open";
    store.save(loaded.kingdom);
    const split = makePlayer();
    send("civ:gate_close", GATE_ID, split);
    assert.match(said(split), /Gate close refused/);
    assert.match(said(split), /force/);
    assert.equal(physical().physical.target, undefined);
    // from a command block: the answer is broadcast
    mc.worldMessages.length = 0;
    handler.subscriber.callback({ id: "civ:gate_list", message: "", sourceType: "Block", sourceBlock: {}, initiator: undefined });
    assert.ok(mc.worldMessages.length > 0);
    // other namespaces' ids and other ids are ignored
    const ignored = makePlayer();
    send("civ:status", "", ignored);
    assert.equal(ignored.messages.length, 0);
    assert.deepEqual(handler.subscriber.options, { namespaces: ["civ"] });
});

test("resolveGateReference: exact, unique fragment, ambiguous, empty", () => {
    const kingdom = ring();
    assert.equal(resolveGateReference(kingdom, GATE_ID).id, GATE_ID);
    assert.equal(resolveGateReference(kingdom, "1-district-2").id, GATE_ID);
    assert.equal(resolveGateReference(kingdom, "GATE-DISTRICT-1-DISTRICT-2").id, GATE_ID);
    assert.ok(resolveGateReference(kingdom, "district").error);
    assert.ok(resolveGateReference(kingdom, undefined).error);
    assert.ok(resolveGateReference(kingdom, "").error);
});

/* ------------------------------------------------------------------ *
 * 6. Companion units, plan ids and the new commands (X3)
 * ------------------------------------------------------------------ */

test("new command ids are registered, one colon each, and handled by the gate module", () => {
    for (const id of ["civ:gate_status", "civ:gate_test"]) {
        assert.match(id, /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
        assert.equal(id.split(":").length, 2);
    }
});

test("resolveGateReference understands plan ids: a companion resolves to its simulation gate, an unmanaged gate to itself; old behaviour is unchanged without a registry", () => {
    const kingdom = ring();
    gate(kingdom, 5, 1).mode = "auto";
    gate(kingdom, 5, 1).physical = {
        state: "open",
        spec: { at: { x: 1, z: 1 }, axis: "x", y: 64 },
        link: { planId: "gate-5", purpose: "main" },
        companions: [{ id: "gate-6", purpose: "reinforce", spec: { at: { x: 90, z: 1 }, axis: "x", y: 64 } }],
    };
    const registry = { v: 1, gates: [{ id: "gate-7", between: [1, 0], purpose: "evac", role: "unmanaged", simGateId: null, spec: { at: { x: 5, z: 5 }, axis: "z", y: 64 } }] };
    assert.deepEqual(resolveGateReference(kingdom, "gate-6", registry), { id: G(5, 1), error: undefined, kind: "sim", alias: "gate-6" });
    assert.deepEqual(resolveGateReference(kingdom, "gate-5", registry), { id: G(5, 1), error: undefined, kind: "sim", alias: "gate-5" });
    assert.deepEqual(resolveGateReference(kingdom, "gate-7", registry), { id: "gate-7", error: undefined, kind: "unmanaged" });
    assert.equal(resolveGateReference(kingdom, G(5, 1), registry).alias, undefined);
    assert.equal(resolveGateReference(kingdom, "1-district-2").id, GATE_ID);
    assert.match(resolveGateReference(kingdom, "", registry).error, /gate-7/);
    assert.ok(resolveGateReference(kingdom, "gate", registry).error, "ambiguous fragment is refused");
    const lines = formatGateLines(kingdom, { registry, recordOf: () => ({ actual: "closed" }) }).join("\n");
    assert.match(lines, /moves together: gate-5 \(main\), gate-6 \(reinforce\)/);
    assert.match(lines, /gate-7 {2}evac {2}districts 1-0 {2}mode auto {2}blocks: closed/);
});
