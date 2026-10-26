import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (...parts) => import(pathToFileURL(join(root, "CivilizationApocalypse_BP", "scripts", ...parts)).href);
const T = await load("structures", "terrain.js");
const vanilla = await import(pathToFileURL(join(root, "node_modules", "@minecraft", "vanilla-data", "lib", "index.js")).href);

const HALF = 2;
const flat = (h) => Array.from({ length: (HALF * 2 + 1) ** 2 }, () => ({ ground: h, topId: "minecraft:grass_block" }));
const limits = { maxCut: 4, maxFill: 4 };

test("every id in the terrain lists is a real block, so a typo cannot silently disable a rule", () => {
    const known = new Set(Object.values(vanilla.MinecraftBlockTypes));
    for (const id of [...T.NATURAL_GROUND, ...T.PLANTS, ...T.TREE_COMPANIONS]) assert.ok(known.has(id), `${id} is not a block in this game version`);
});

test("what grows on a tree no longer vetoes the tree, and is still never removed by a clear", () => {
    // Live refusal that left jungle trees standing inside finished lots:
    // "tree not cleared: minecraft:melon_block touches a tree - may be a player build".
    for (const id of T.TREE_COMPANIONS) {
        assert.equal(T.isBenign(id), true, `${id} must not veto a natural tree`);
        assert.equal(T.isPlant(id), false, `${id} is benign for the judgement only`);
        assert.equal(T.isTreePart(id), false, `${id} is not cleared away as a tree part`);
        assert.equal(T.classifyTerrainCell({ kind: "clear", existingId: id, targetId: "minecraft:air" }).ok, false, `${id} is never cleared`);
    }
    // the rule the companions must not swallow: a real player block still vetoes
    assert.equal(T.isBenign("minecraft:oak_planks"), false);
    assert.equal(T.isBenign("minecraft:chest"), false);
    assert.equal(T.isBenign("minecraft:stone_bricks"), false);
});

test("column reading finds the real ground under grass, flowers and trees, never the player's height", () => {
    const col = T.classifyColumn([
        { y: 80, id: "minecraft:oak_leaves" }, { y: 79, id: "minecraft:oak_log" }, { y: 78, id: "minecraft:air" },
        { y: 77, id: "minecraft:poppy" }, { y: 76, id: "minecraft:grass_block" }, { y: 75, id: "minecraft:dirt" },
    ]);
    assert.equal(col.ground, 76);
    assert.equal(col.topId, "minecraft:grass_block");
    assert.deepEqual(col.above.map((c) => c.id), ["minecraft:oak_leaves", "minecraft:oak_log", "minecraft:poppy"]);
    assert.equal(col.problem, undefined);
});

test("columns with player blocks, water, lava or hollow ground are problems", () => {
    assert.match(T.classifyColumn([{ y: 70, id: "minecraft:chest" }, { y: 69, id: "minecraft:grass_block" }]).problem, /chest.*not natural/);
    assert.match(T.classifyColumn([{ y: 70, id: "minecraft:oak_planks" }]).problem, /oak_planks/);
    assert.match(T.classifyColumn([{ y: 70, id: "minecraft:water" }]).problem, /water/);
    assert.match(T.classifyColumn([{ y: 70, id: "minecraft:lava" }]).problem, /lava/);
    assert.match(T.classifyColumn([{ y: 70, id: "minecraft:grass_block" }, { y: 69, id: "minecraft:air" }]).problem, /hollow/);
    assert.match(T.classifyColumn([{ y: 70, id: "minecraft:air" }]).problem, /no natural ground/);
    assert.match(T.classifyColumn([{ y: 70, id: "minecraft:farmland" }, { y: 69, id: "minecraft:dirt" }]).problem, /farmland/);
});

test("a flat site needs no earthwork", () => {
    const plan = T.planTerrain(flat(70), HALF, limits);
    assert.equal(plan.ok, true);
    assert.equal(plan.baseY, 70);
    assert.deepEqual(plan.counts, { cut: 0, fill: 0, top: 0 });
});

test("a gentle slope is cut and filled around the median platform, within the footprint only", () => {
    const columns = flat(70);
    columns.forEach((_, i) => { columns[i] = { ground: 70 + (Math.floor(i / 5) - 2), topId: "minecraft:grass_block" }; });
    const plan = T.planTerrain(columns, HALF, limits);
    assert.equal(plan.ok, true);
    assert.equal(plan.baseY, 70);
    assert.ok(plan.counts.cut > 0 && plan.counts.fill > 0);
    for (const op of plan.ops) {
        assert.ok(Math.abs(op.x) <= HALF && Math.abs(op.z) <= HALF, "op inside the footprint");
        if (op.kind === "cut") assert.equal(op.id, "minecraft:air");
        if (op.kind === "fill") assert.ok(op.y <= 70 && ["minecraft:dirt", "minecraft:grass_block", "minecraft:sand"].includes(op.id));
    }
    const cut = plan.ops.filter((op) => op.kind === "cut");
    assert.ok(cut.every((op) => op.y > 70), "cuts only remove blocks above the platform");
    assert.ok(cut.every((op, i) => i === 0 || /** @type {any} */ (cut[i - 1]).y >= op.y), "cuts run top-down");
    // idempotent: replanning the result of the earthwork finds nothing left to do
    const after = flat(70);
    assert.deepEqual(T.planTerrain(after, HALF, limits).ops, []);
});

test("a cliff beyond the limits refuses the site and says why", () => {
    const columns = flat(70);
    columns[0] = { ground: 90, topId: "minecraft:stone" };
    const plan = T.planTerrain(columns, HALF, limits);
    assert.equal(plan.ok, false);
    assert.match(plan.problems[0], /too uneven/);
    assert.equal(plan.ops.length, 0);
    assert.equal(T.planTerrain(columns, HALF, { maxCut: 30, maxFill: 4 }).ok, true, "raising the cap is explicit");
});

test("forced platform height (resume) is honoured", () => {
    const plan = T.planTerrain(flat(72), HALF, limits, 70);
    assert.equal(plan.baseY, 70);
    assert.ok(plan.counts.cut > 0);
});

test("terrain writes only touch natural ground and vegetation", () => {
    const c = T.classifyTerrainCell;
    assert.equal(c({ kind: "clear", existingId: "minecraft:short_grass", targetId: "minecraft:air" }).ok, true);
    assert.equal(c({ kind: "clear", existingId: "minecraft:oak_leaves", targetId: "minecraft:air" }).ok, true);
    assert.match(c({ kind: "clear", existingId: "minecraft:chest", targetId: "minecraft:air" }).reason, /not vegetation/);
    assert.equal(c({ kind: "cut", existingId: "minecraft:stone", targetId: "minecraft:air" }).ok, true);
    assert.match(c({ kind: "cut", existingId: "minecraft:iron_ore", targetId: "minecraft:air" }).reason, /not natural ground/);
    assert.match(c({ kind: "cut", existingId: "minecraft:oak_planks", targetId: "minecraft:air" }).reason, /not natural/);
    assert.equal(c({ kind: "cut", existingId: "minecraft:air", targetId: "minecraft:air" }).built, true);
    assert.equal(c({ kind: "fill", existingId: "minecraft:air", targetId: "minecraft:dirt" }).ok, true);
    assert.match(c({ kind: "fill", existingId: "minecraft:glass", targetId: "minecraft:dirt" }).reason, /would fill over/);
    assert.equal(c({ kind: "top", existingId: "minecraft:dirt", targetId: "minecraft:grass_block" }).ok, true);
    assert.match(c({ kind: "top", existingId: "minecraft:bricks", targetId: "minecraft:grass_block" }).reason, /resurface/);
    assert.equal(c({ kind: "cut", existingId: undefined, targetId: "minecraft:air" }).reason, "unloaded");
});

function treeWorld(extra = {}) {
    const cells = new Map();
    const put = (x, y, z, id, persistent) => cells.set(`${x},${y},${z}`, { id, persistent });
    for (let y = 70; y <= 73; y += 1) put(0, y, 0, "minecraft:oak_log");
    for (let x = -1; x <= 1; x += 1) for (let z = -1; z <= 1; z += 1) for (let y = 73; y <= 75; y += 1) if (!cells.has(`${x},${y},${z}`)) put(x, y, z, "minecraft:oak_leaves", false);
    put(0, 69, 0, "minecraft:grass_block");
    for (const [key, value] of Object.entries(extra)) cells.set(key, value);
    const read = (x, y, z) => cells.get(`${x},${y},${z}`) ?? { id: "minecraft:air" };
    const seeds = [...cells.entries()].filter(([, v]) => T.isTreePart(v.id)).map(([k]) => { const [x, y, z] = k.split(",").map(Number); return { x, y, z }; });
    return { read, seeds, cells };
}

test("a natural tree is cleared, but only inside the footprint", () => {
    const { read, seeds } = treeWorld();
    const all = T.classifyTrees(seeds, read, { inside: () => true });
    assert.deepEqual(all.problems, []);
    assert.equal(all.clear.length, seeds.length);
    const partial = T.classifyTrees(seeds, read, { inside: (x) => x <= 0 });
    assert.ok(partial.clear.length > 0 && partial.clear.length < seeds.length);
    assert.ok(partial.clear.every((cell) => cell.x <= 0));
});

test("tree-like structures that may be player builds refuse", () => {
    const planks = treeWorld({ "1,71,0": { id: "minecraft:oak_planks" } });
    assert.match(T.classifyTrees(planks.seeds, planks.read, { inside: () => true }).problems[0], /may be a player build/);
    const hedge = treeWorld({ "1,73,1": { id: "minecraft:oak_leaves", persistent: true } });
    assert.match(T.classifyTrees(hedge.seeds, hedge.read, { inside: () => true }).problems[0], /persistent leaves/);
    const floating = treeWorld({ "0,69,0": { id: "minecraft:air" } });
    assert.match(T.classifyTrees(floating.seeds, floating.read, { inside: () => true }).problems[0], /natural ground/);
    const huge = treeWorld();
    assert.match(T.classifyTrees(huge.seeds, huge.read, { inside: () => true, cap: 5 }).problems[0], /larger than 5/);
    const unloaded = treeWorld();
    assert.match(T.classifyTrees(unloaded.seeds, () => undefined, { inside: () => true }).problems[0], /not loaded/);
});

test("the survey fingerprint changes when any planned change changes", () => {
    const plan = T.planTerrain(flat(72), HALF, limits, 70);
    const a = T.terrainFingerprint({ x: 0, y: 70, z: 0 }, 70, plan.ops, []);
    assert.match(a, /^[0-9a-f]{8}$/);
    assert.equal(a, T.terrainFingerprint({ x: 0, y: 70, z: 0 }, 70, plan.ops, []));
    assert.notEqual(a, T.terrainFingerprint({ x: 0, y: 70, z: 0 }, 70, plan.ops, [{ x: 1, y: 71, z: 1 }]));
    assert.notEqual(a, T.terrainFingerprint({ x: 1, y: 70, z: 0 }, 70, plan.ops, []));
    assert.notEqual(a, T.terrainFingerprint({ x: 0, y: 70, z: 0 }, 70, plan.ops.slice(1), []));
});

test("site scoring prefers flatter, less wooded ground and rejects bad columns", () => {
    const col = (ground, trees = 0, problem) => ({ ground, topId: "minecraft:grass_block", above: Array.from({ length: trees }, (_, i) => ({ y: ground + 1 + i, id: "minecraft:oak_log" })), problem });
    const flatScore = T.scoreCandidate(() => col(70), { x: 0, z: 0 }, HALF, limits);
    const hillScore = T.scoreCandidate((x, z) => col(70 + Math.floor((x + 2) / 2)), { x: 0, z: 0 }, HALF, limits);
    const wooded = T.scoreCandidate(() => col(70, 2), { x: 0, z: 0 }, HALF, limits);
    assert.ok(flatScore.ok && hillScore.ok && wooded.ok);
    assert.ok(flatScore.score < hillScore.score && flatScore.score < wooded.score);
    assert.equal(T.scoreCandidate((x) => (x === 0 ? col(70, 0, "water at y=70") : col(70)), { x: 0, z: 0 }, HALF, limits).ok, false);
    assert.equal(T.scoreCandidate(() => undefined, { x: 0, z: 0 }, HALF, limits).reason, "unloaded");
    const ranked = T.bestCandidates([{ score: 5, distance: 10 }, { score: 5, distance: 2 }, { score: 40, distance: 0 }], 2);
    assert.deepEqual(ranked.map((c) => c.distance), [2, 10]);
});
