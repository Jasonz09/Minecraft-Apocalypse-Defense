import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, findValidationProblems, serializeKingdom } = await load("kingdom", "state.js");
const { planDistrict, planHash, reachableRoadCells, MAX_PLAN_BLOCKS } = await load("structures", "planner.js");
const { rotateDir, rotateXZ, encodeFacing } = await load("structures", "facing.js");
const { classifyCell, NATURAL_GROUND } = await load("structures", "siteRules.js");
const { PALETTE } = await load("structures", "palette.js");
const { BLUEPRINTS } = await load("structures", "blueprints.js");
const { DISTRICT_DEFAULTS } = await load("config.js");
const vanilla = await import(pathToFileURL(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "index.js")).href);
const blockStatesSource = readFileSync(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "mojang-block.d.ts"), "utf8");

const kingdom = createInitialKingdom();
const district = kingdom.districts[0];
const plan = planDistrict(district);
const at = (x, y, z) => plan.blocks.find((block) => block.x === x && block.y === y && block.z === z);
const idsAt = (predicate) => plan.blocks.filter(predicate);

test("the plan is deterministic and fingerprinted", () => {
    const again = planDistrict(createInitialKingdom().districts[0]);
    assert.equal(planHash(plan), planHash(again));
    assert.deepEqual(plan.blocks, again.blocks);
    assert.match(planHash(plan), /^[0-9a-f]{8}$/);
});

test("the plan is bounded: inside the 49x49 footprint, y -1..12, under the block cap", () => {
    assert.ok(plan.blockCount > 5000 && plan.blockCount <= MAX_PLAN_BLOCKS, `blocks: ${String(plan.blockCount)}`);
    for (const block of plan.blocks) {
        assert.ok(Math.abs(block.x) <= 24 && Math.abs(block.z) <= 24, `outside footprint: ${JSON.stringify(block)}`);
        assert.ok(block.y >= -1 && block.y <= 12, `bad height: ${JSON.stringify(block)}`);
    }
    const keys = new Set(plan.blocks.map((block) => `${block.x},${block.y},${block.z}`));
    assert.equal(keys.size, plan.blocks.length, "no cell is planned twice");
});

test("the physical district mirrors the simulated record", () => {
    assert.deepEqual(plan.counts.built, {
        homes: DISTRICT_DEFAULTS.homesPerDistrict,
        storehouses: DISTRICT_DEFAULTS.storehousesPerDistrict,
        barracks: DISTRICT_DEFAULTS.barracksPerDistrict,
        farms: DISTRICT_DEFAULTS.farmsPerDistrict,
    });
    assert.deepEqual(plan.notes, []);
    const entranceKinds = (kind) => plan.entrances.filter((entrance) => entrance.kind === kind).length;
    assert.equal(entranceKinds("homes"), district.buildings.homes);
    assert.equal(entranceKinds("storehouses"), district.buildings.storehouses);
    assert.equal(entranceKinds("barracks"), district.buildings.barracks);
    assert.equal(entranceKinds("farms"), district.buildings.farms);
    assert.equal(entranceKinds("gate_tower"), 8);
    assert.equal(entranceKinds("corner_tower"), 4);
    assert.equal(plan.gates.length, 4);
});

test("gates link to the neighbours recorded in the simulation", () => {
    const east = plan.gates.find((gate) => gate.side === "east");
    const west = plan.gates.find((gate) => gate.side === "west");
    assert.equal(east.links, district.gates[0].with);
    assert.ok(district.neighbors.includes(west.links));
    assert.notEqual(east.links, west.links);
});

test("fewer buildings in the record means fewer built; too many is reported, not ignored", () => {
    const small = structuredClone(district);
    small.buildings.homes = 2;
    small.buildings.farms = 1;
    const smallPlan = planDistrict(small);
    assert.equal(smallPlan.entrances.filter((entrance) => entrance.kind === "homes").length, 2);
    assert.equal(smallPlan.entrances.filter((entrance) => entrance.kind === "farms").length, 1);
    assert.ok(smallPlan.blockCount < plan.blockCount);

    const big = structuredClone(district);
    big.buildings.homes = 9;
    const bigPlan = planDistrict(big);
    assert.equal(bigPlan.counts.built.homes, 6);
    assert.match(bigPlan.notes.join(" "), /9 homes but the layout has only 6/);
});

test("the curtain wall is complete and permanent: every perimeter cell y0-6 is solid except the four gate passages", () => {
    const stoneFamily = ["stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "cobblestone", "mossy_cobblestone", "polished_andesite"];
    let checked = 0;
    let stone = 0;
    for (let c = -24; c <= 24; c += 1) {
        for (const [x, z] of [[c, -24], [c, 24], [-24, c], [24, c]]) {
            const gatePassage = Math.abs(c) <= 2;
            for (let y = 0; y <= 6; y += 1) {
                const block = at(x, y, z);
                if (gatePassage && y <= 4) {
                    assert.equal(block, undefined, `gate passage must stay open at ${x},${y},${z}`);
                    continue;
                }
                assert.ok(block, `hole in the wall at ${x},${y},${z}`);
                checked += 1;
                if (stoneFamily.includes(block.id.replace("minecraft:", ""))) stone += 1;
            }
        }
    }
    assert.ok(stone / checked > 0.9, `wall should be stone, was ${String(stone / checked)}`);
    // parapet and merlons
    for (let c = -24; c <= 24; c += 1) {
        assert.ok(at(c, 7, -24), `parapet missing at ${c}`);
    }
    assert.ok(idsAt((b) => b.y === 8 && Math.abs(b.x) === 24 || b.y === 8 && Math.abs(b.z) === 24).length > 40, "merlons on top");
});

test("nothing in the plan removes wall: carve-outs are limited to the gates, towers and interior", () => {
    // The only cells inside the 3-thick ring that are empty at y0-5 belong to gate passages or tower rooms.
    for (let y = 0; y <= 5; y += 1) {
        for (let c = -24; c <= 24; c += 1) {
            for (const [x, z] of [[c, -23], [c, 23], [-23, c], [23, c]]) {
                const block = at(x, y, z);
                if (block) continue;
                const inGate = Math.abs(c) <= 2;
                const inTower = Math.abs(Math.abs(c) - 6) <= 2 || Math.abs(c) >= 21;
                assert.ok(inGate || inTower, `unexpected empty wall cell ${x},${y},${z}`);
            }
        }
    }
});

test("every gate has a passage 5 wide and 5 high with the portcullis raised, and a road through it", () => {
    for (const gate of plan.gates) {
        assert.ok(plan.roadCells.includes(`${gate.inner.x},${gate.inner.z}`), `${gate.id} passage must be on the road network`);
    }
    // north gate, portcullis row at y=4 on the middle wall layer
    for (let x = -2; x <= 2; x += 1) {
        assert.equal(at(x, 4, -23)?.id, "minecraft:iron_bars");
        for (let y = 0; y <= 3; y += 1) assert.equal(at(x, y, -23), undefined);
    }
});

test("functional routes: every door opens onto a road reachable from every gate and the wall stairs", () => {
    const starts = plan.gates.map((gate) => `${gate.inner.x},${gate.inner.z}`);
    const reaches = starts.map((start) => reachableRoadCells(plan, start));
    for (const reached of reaches) assert.ok(reached.size > 300, "road network is connected");
    for (const entrance of plan.entrances) {
        const front = `${entrance.front.x},${entrance.front.z}`;
        for (const reached of reaches) assert.ok(reached.has(front), `${entrance.id} front ${front} is cut off from a gate`);
    }
    for (const base of plan.wallStairs) {
        for (const reached of reaches) assert.ok(reached.has(`${base.x},${base.z}`), `wall stair at ${base.x},${base.z} unreachable`);
    }
});

test("reinforcement path: barracks to every wall stair and every gate over roads", () => {
    const barracks = plan.entrances.find((entrance) => entrance.kind === "barracks");
    const reached = reachableRoadCells(plan, `${barracks.front.x},${barracks.front.z}`);
    for (const gate of plan.gates) assert.ok(reached.has(`${gate.inner.x},${gate.inner.z}`), `${gate.id} unreachable from barracks`);
    for (const base of plan.wallStairs) assert.ok(reached.has(`${base.x},${base.z}`));
});

test("wall stairs climb seven steps to the walkway on all four sides", () => {
    const stairs = plan.blocks.filter((block) => block.id === "minecraft:stone_brick_stairs");
    assert.equal(stairs.length, 28);
    const solidUnder = (x, y, z) => at(x, y - 1, z) !== undefined;
    for (const stair of stairs) {
        if (stair.y > 0) assert.ok(solidUnder(stair.x, stair.y, stair.z), `stair floats at ${stair.x},${stair.y},${stair.z}`);
    }
    assert.equal(Math.max(...stairs.map((stair) => stair.y)), 6);
    // the north staircase hugs the wall and its top touches the walkway row
    assert.ok(at(16, 6, -21)?.id === "minecraft:stone_brick_stairs" && at(16, 6, -22), "north stair top meets the walkway");
});

test("towers are hollow, ladder-served and open onto the walkway", () => {
    // north-east corner tower: world x 20..24, z -24..-20
    assert.equal(at(22, 3, -22), undefined, "ground room is hollow");
    assert.equal(at(22, 9, -22), undefined, "upper room is hollow");
    const ladders = plan.blocks.filter((block) => block.id === "minecraft:ladder");
    assert.equal(ladders.length, 12 * 12);
    assert.equal(at(20, 7, -23), undefined, "doorway from the upper room onto the north walkway");
    assert.ok(at(22, 6, -22), "upper floor is flush with the walkway");
});

test("doors always come as a matched pair, lower then upper", () => {
    const doors = plan.blocks.filter((block) => block.id === "minecraft:wooden_door");
    const lower = doors.filter((block) => block.states.upper_block_bit === false);
    const upper = doors.filter((block) => block.states.upper_block_bit === true);
    assert.equal(lower.length, upper.length);
    for (const door of lower) {
        const top = at(door.x, door.y + 1, door.z);
        assert.equal(top?.id, "minecraft:wooden_door");
        assert.equal(top.states.upper_block_bit, true);
        assert.equal(top.states["minecraft:cardinal_direction"], door.states["minecraft:cardinal_direction"]);
    }
});

test("farms have water, farmland and wheat; barracks have an armoury", () => {
    assert.equal(plan.blocks.filter((block) => block.id === "minecraft:farmland").length, 4 * 20);
    assert.equal(plan.blocks.filter((block) => block.id === "minecraft:wheat").length, 4 * 20);
    assert.ok(plan.blocks.filter((block) => block.id === "minecraft:water").length >= 4 * 5);
    assert.ok(plan.blocks.filter((block) => block.id === "minecraft:chest").length >= 6);
});

test("build order puts supports before attachments and liquids last", () => {
    const attached = new Set(["minecraft:ladder", "minecraft:lantern", "minecraft:wooden_door", "minecraft:fence_gate", "minecraft:wheat", "minecraft:glass_pane", "minecraft:iron_bars"]);
    let lastStructural = -1;
    let firstAttached = Infinity;
    let firstWater = Infinity;
    let lastAttached = -1;
    plan.blocks.forEach((block, index) => {
        if (block.id === "minecraft:water") firstWater = Math.min(firstWater, index);
        else if (attached.has(block.id)) {
            firstAttached = Math.min(firstAttached, index);
            lastAttached = index;
        } else lastStructural = index;
    });
    assert.ok(lastStructural < firstAttached, "structure placed before attachments");
    assert.ok(lastAttached < firstWater, "water placed last");
});

test("every block id exists in the installed game data and every state name is valid for that block", () => {
    const known = new Set(Object.values(vanilla.MinecraftBlockTypes));
    const statesFor = (id) => {
        const typeName = `${id.replace("minecraft:", "").split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}States`;
        const match = blockStatesSource.match(new RegExp(`export type ${typeName} = ([^;]+);`));
        if (!match) return undefined;
        if (match[1].startsWith("Record<string, never>")) return [];
        return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).filter((name) => name !== "BlockStateSuperset");
    };
    const seen = new Map();
    for (const block of plan.blocks) {
        assert.ok(known.has(block.id), `${block.id} is not a block in this game version`);
        const names = Object.keys(block.states ?? {});
        if (names.length > 0) seen.set(block.id, new Set([...(seen.get(block.id) ?? []), ...names]));
    }
    for (const [id, names] of seen) {
        const allowed = statesFor(id);
        assert.ok(allowed, `could not find the state list for ${id}`);
        for (const name of names) assert.ok(allowed.includes(name), `${id} has no state '${name}' (valid: ${allowed.join(", ")})`);
    }
});

test("the palette and blueprints only reference known tokens", () => {
    const check = (token, where) => {
        if (typeof token === "string") assert.ok(Object.hasOwn(PALETTE, token), `${where}: unknown token ${token}`);
    };
    for (const [name, blueprint] of Object.entries(BLUEPRINTS)) {
        assert.ok(blueprint.ops.length > 0, name);
        for (const op of blueprint.ops) check(op.block, name);
    }
});

test("facing helpers: four quarter turns are the identity and stairs rotate with the building", () => {
    assert.equal(rotateDir("north", 1), "east");
    assert.equal(rotateDir("west", 1), "north");
    assert.equal(rotateDir("east", 4), "east");
    assert.deepEqual(rotateXZ(3, -5, 4), [3, -5]);
    assert.deepEqual(rotateXZ(1, 0, 1), [0, 1], "east -> south");
    assert.deepEqual(encodeFacing({ kind: "stairs", dir: "east" }), { weirdo_direction: 0, upside_down_bit: false });
    assert.deepEqual(encodeFacing({ kind: "stairs", dir: rotateDir("east", 1) }), { weirdo_direction: 2, upside_down_bit: false });
    assert.throws(() => encodeFacing({ kind: "banana", dir: "north" }));
    assert.throws(() => rotateDir("up", 1));
});

test("site rules: ground may be natural terrain, everything above must be empty, built cells are accepted", () => {
    assert.equal(classifyCell({ y: 0, existingId: "minecraft:air" }).ok, true);
    assert.equal(classifyCell({ y: 3, existingId: "minecraft:short_grass" }).ok, true);
    assert.match(classifyCell({ y: 2, existingId: "minecraft:oak_log" }).reason, /occupied by minecraft:oak_log/);
    assert.match(classifyCell({ y: 0, existingId: "minecraft:chest" }).reason, /occupied/);
    assert.equal(classifyCell({ y: -1, existingId: "minecraft:grass_block" }).ok, true);
    assert.match(classifyCell({ y: -1, existingId: "minecraft:oak_planks" }).reason, /not natural terrain/);
    assert.match(classifyCell({ y: -1, existingId: "minecraft:air" }).reason, /not natural terrain/);
    assert.match(classifyCell({ y: -1, existingId: "minecraft:water" }).reason, /not natural terrain/);
    assert.deepEqual(classifyCell({ plannedId: "minecraft:stone_bricks", y: 4, existingId: "minecraft:stone_bricks" }), { ok: true, built: true });
    assert.equal(classifyCell({ y: 0, existingId: undefined }).reason, "unloaded");
    assert.ok(!NATURAL_GROUND.includes("minecraft:air"));
});

test("saved record: a physical block validates, bad ones are rejected, and it stays tiny", () => {
    const base = createInitialKingdom();
    const target = base.districts[0];
    target.physical = { layout: "hearthgate", version: 1, status: "building", origin: { x: 10, y: 4, z: -3 }, dimension: "minecraft:overworld", placed: 100, total: plan.blockCount, planHash: planHash(plan) };
    assert.deepEqual(findValidationProblems(base), []);
    const withoutPhysical = serializeKingdom(createInitialKingdom()).length;
    assert.ok(serializeKingdom(base).length - withoutPhysical < 300, "record is small");

    const bad = structuredClone(base);
    bad.districts[0].physical.status = "half";
    bad.districts[0].physical.origin = { x: 1.5, y: 0, z: 0 };
    bad.districts[0].physical.placed = -1;
    const problems = findValidationProblems(bad).join(" | ");
    assert.match(problems, /physical\.status/);
    assert.match(problems, /physical\.origin/);
    assert.match(problems, /physical\.placed/);
});
