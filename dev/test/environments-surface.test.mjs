import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const env = await load("civ", "environments.js");
const terrain = await load("structures", "terrain.js");
const vanilla = await import(pathToFileURL(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "index.js")).href);
const known = new Set(Object.values(vanilla.MinecraftBlockTypes));
const source = readFileSync(join(scriptsRoot, "civ", "environments.js"), "utf8");

const { classifyBlock, readStack, requiredFootingDepth, NATURAL_SURFACES, COVER_IDS, FROZEN_IDS } = env;

test("every block id written in environments.js exists in the installed game data", () => {
    const literals = [...new Set([...source.matchAll(/"(minecraft:[a-z_]+)"/g)].map((m) => m[1]))];
    assert.ok(literals.length > 40, `expected many literals, found ${String(literals.length)}`);
    for (const id of literals) assert.ok(known.has(id), `${id} is not a block in this game version`);
});

test("the pure module imports nothing from the Minecraft runtime", () => {
    assert.doesNotMatch(source, /from\s+["']@minecraft\//);
    assert.doesNotMatch(source, /import\s*\(\s*["']@minecraft\//);
});

test("every natural, cover and frozen id exists in the installed game data", () => {
    for (const id of [...Object.keys(NATURAL_SURFACES), ...COVER_IDS, ...FROZEN_IDS]) {
        assert.ok(known.has(id), `${id} is not a block in this game version`);
    }
});

test("surface classes: temperate, desert, snow, wet and stony ids map to their class", () => {
    const expected = {
        temperate: ["minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol", "minecraft:dirt_with_roots", "minecraft:mycelium"],
        desert: ["minecraft:sand", "minecraft:red_sand", "minecraft:sandstone", "minecraft:red_sandstone"],
        snow: ["minecraft:snow"],
        wet: ["minecraft:mud", "minecraft:clay", "minecraft:gravel"],
        stony: ["minecraft:stone", "minecraft:andesite", "minecraft:diorite", "minecraft:granite", "minecraft:tuff", "minecraft:deepslate"],
    };
    for (const [cls, ids] of Object.entries(expected)) {
        for (const id of ids) {
            const info = classifyBlock(id);
            assert.equal(info.kind, "natural", id);
            assert.equal(info.class, cls, id);
        }
    }
});

test("footing anchors: gravity sand and gravel need 2, mud, clay and snow need 1, the rest 0", () => {
    assert.deepEqual(NATURAL_SURFACES["minecraft:sand"], { class: "desert", gravity: true, extra: 2, ambiguousTop: false });
    assert.deepEqual(NATURAL_SURFACES["minecraft:red_sand"], { class: "desert", gravity: true, extra: 2, ambiguousTop: false });
    assert.deepEqual(NATURAL_SURFACES["minecraft:gravel"], { class: "wet", gravity: true, extra: 2, ambiguousTop: false });
    assert.equal(NATURAL_SURFACES["minecraft:mud"].extra, 1);
    assert.equal(NATURAL_SURFACES["minecraft:clay"].extra, 1);
    assert.equal(NATURAL_SURFACES["minecraft:snow"].extra, 1);
    for (const id of ["minecraft:grass_block", "minecraft:dirt", "minecraft:stone", "minecraft:sandstone", "minecraft:deepslate"]) {
        assert.equal(NATURAL_SURFACES[id].gravity, id === "minecraft:gravel", id);
    }
    assert.equal(NATURAL_SURFACES["minecraft:sandstone"].extra, 0);
});

test("craftable tops are ambiguous: snow block, clay and sandstone refuse as a surface", () => {
    for (const id of ["minecraft:snow", "minecraft:clay", "minecraft:sandstone", "minecraft:red_sandstone"]) {
        assert.equal(NATURAL_SURFACES[id].ambiguousTop, true, id);
    }
    for (const id of ["minecraft:grass_block", "minecraft:sand", "minecraft:stone", "minecraft:mud", "minecraft:gravel"]) {
        assert.equal(NATURAL_SURFACES[id].ambiguousTop, false, id);
    }
});

test("snow layers, cactus, ice and powder snow: clearable cover, a cactus rule, and frozen refusals", () => {
    assert.equal(classifyBlock("minecraft:snow_layer").kind, "cover");
    assert.equal(classifyBlock("minecraft:cactus").kind, "cactus");
    for (const id of ["minecraft:ice", "minecraft:packed_ice", "minecraft:blue_ice", "minecraft:frosted_ice", "minecraft:powder_snow"]) {
        assert.equal(classifyBlock(id).kind, "frozen", id);
    }
});

test("cover matches terrain.js PLANTS (vines are tree parts here) and the design's auto-clear list", () => {
    for (const id of terrain.PLANTS) {
        if (id === "minecraft:vine") {
            assert.equal(classifyBlock(id).kind, "tree");
        } else {
            assert.equal(classifyBlock(id).kind, "cover", id);
        }
    }
    for (const id of ["minecraft:reeds", "minecraft:bamboo", "minecraft:waterlily", "minecraft:kelp", "minecraft:seagrass", "minecraft:hanging_roots"]) {
        assert.equal(classifyBlock(id).kind, "cover", id);
    }
});

test("tree parts agree with terrain.js isTreePart for logs, leaves, vines and stripped logs", () => {
    const ids = ["minecraft:oak_log", "minecraft:mangrove_log", "minecraft:cherry_leaves", "minecraft:azalea_leaves_flowered", "minecraft:vine", "minecraft:stripped_oak_log", "minecraft:oak_planks"];
    for (const id of ids) {
        assert.equal(classifyBlock(id).kind === "tree", terrain.isTreePart(id), id);
    }
    assert.equal(classifyBlock("minecraft:mangrove_roots").kind, "tree");
    assert.equal(classifyBlock("minecraft:muddy_mangrove_roots").kind, "tree");
});

test("water, lava and air", () => {
    assert.equal(classifyBlock("minecraft:air").kind, "air");
    assert.equal(classifyBlock("minecraft:water").kind, "water");
    assert.equal(classifyBlock("minecraft:flowing_water").kind, "water");
    assert.equal(classifyBlock("minecraft:lava").kind, "lava");
    assert.equal(classifyBlock("minecraft:flowing_lava").kind, "lava");
});

test("village signals and their weights: beds, bells, doors, composters, workstations, lanterns, chests, planks, bricks, glass, torches, paths", () => {
    const expected = {
        "minecraft:bell": ["bell", 5],
        "minecraft:red_bed": ["bed", 3],
        "minecraft:composter": ["composter", 3],
        "minecraft:smithing_table": ["workstation", 3],
        "minecraft:barrel": ["workstation", 3],
        "minecraft:oak_door": ["door", 2],
        "minecraft:lantern": ["lantern", 2],
        "minecraft:soul_lantern": ["lantern", 2],
        "minecraft:chest": ["chest", 2],
        "minecraft:trapped_chest": ["chest", 2],
        "minecraft:spruce_planks": ["planks", 1],
        "minecraft:stone_bricks": ["brick", 1],
        "minecraft:brick_block": ["brick", 1],
        "minecraft:glass": ["glass", 1],
        "minecraft:white_stained_glass_pane": ["glass", 1],
        "minecraft:torch": ["torch", 1],
        "minecraft:grass_path": ["path", 1],
    };
    for (const [id, [kind, weight]] of Object.entries(expected)) {
        const info = classifyBlock(id);
        assert.equal(info.kind, "signal", id);
        assert.deepEqual(info.signal, { kind, weight }, id);
    }
});

test("player-used families are never natural: terracotta in every colour, planks, polished and cut stone, bricks, packed mud", () => {
    const player = /terracotta|planks|brick|polished_|cut_|chiseled_|stairs|_slab$|_wall$|glass|_wool$|concrete|carpet|_door$|_fence|packed_mud|hardened_clay|stripped_|smooth_stone|cobblestone/;
    // pale_moss_carpet is deliberately natural cover (pale garden), not a player carpet.
    const ids = [...known].filter((id) => player.test(id) && id !== "minecraft:pale_moss_carpet");
    assert.ok(ids.length > 150, `expected many player-used ids, found ${String(ids.length)}`);
    for (const id of ids) {
        const kind = classifyBlock(id).kind;
        assert.ok(kind === "protected" || kind === "signal", `${id} classified as ${kind}`);
    }
});

test("every colour of terracotta, glazed terracotta and hardened clay is protected, never natural", () => {
    const terracotta = [...known].filter((id) => /terracotta|hardened_clay/.test(id));
    assert.ok(terracotta.length >= 17, `terracotta ids: ${String(terracotta.length)}`);
    for (const id of terracotta) assert.equal(classifyBlock(id).kind, "protected", id);
    assert.equal(classifyBlock("minecraft:hardened_clay").kind, "protected");
});

test("cut, chiseled and smooth sandstone are protected while natural sandstone is ambiguous natural", () => {
    for (const id of ["minecraft:cut_sandstone", "minecraft:smooth_sandstone", "minecraft:chiseled_sandstone", "minecraft:smooth_red_sandstone", "minecraft:sandstone_stairs"]) {
        assert.equal(classifyBlock(id).kind, "protected", id);
    }
    assert.equal(classifyBlock("minecraft:sandstone").kind, "natural");
});

test("every block the module calls natural is on the explicit list (nothing natural by accident)", () => {
    const natural = [...known].filter((id) => classifyBlock(id).kind === "natural");
    assert.deepEqual(natural.sort(), Object.keys(NATURAL_SURFACES).sort());
});

test("unknown ids refuse: farmland, crops, cobwebs, pointed dripstone, unrecognised names", () => {
    for (const id of ["minecraft:farmland", "minecraft:wheat", "minecraft:web", "minecraft:pointed_dripstone", "minecraft:not_a_block"]) {
        assert.equal(classifyBlock(id).kind, "unknown", id);
    }
});

test("ores are stony substrate: fine below ground, refused as an exposed surface", () => {
    assert.equal(classifyBlock("minecraft:coal_ore").kind, "ore");
    const stack = readStack([{ y: 64, id: "minecraft:coal_ore" }, { y: 63, id: "minecraft:stone" }]);
    assert.equal(stack.ok, false);
    assert.match(stack.problems.join(" "), /exposed ore minecraft:coal_ore/);
});

test("readStack finds the surface through cover and reports water above the bed", () => {
    const stack = readStack([
        { y: 66, id: "minecraft:air" },
        { y: 65, id: "minecraft:short_grass" },
        { y: 64, id: "minecraft:grass_block" },
        { y: 63, id: "minecraft:dirt" },
        { y: 62, id: "minecraft:stone" },
    ]);
    assert.equal(stack.ok, true);
    assert.equal(stack.surface.id, "minecraft:grass_block");
    assert.equal(stack.surface.y, 64);
    assert.equal(stack.cover.plants, 1);
    assert.equal(stack.waterTop, undefined);

    const wet = readStack([
        { y: 64, id: "minecraft:water" },
        { y: 63, id: "minecraft:water" },
        { y: 62, id: "minecraft:clay" },
        { y: 61, id: "minecraft:stone" },
    ]);
    assert.equal(wet.surface.id, "minecraft:clay");
    assert.equal(wet.waterTop, 64);
});

test("readStack is independent of input order (sorted top-down internally)", () => {
    const cells = [
        { y: 60, id: "minecraft:stone" },
        { y: 64, id: "minecraft:grass_block" },
        { y: 66, id: "minecraft:air" },
        { y: 62, id: "minecraft:dirt" },
    ];
    assert.deepEqual(readStack(cells), readStack([...cells].reverse()));
});

test("readStack: cactus is natural only as 1 to 3 blocks on sand, and refuses on grass or in a tall stack", () => {
    const sand = (n) => [{ y: 67, id: "minecraft:air" }, ...Array.from({ length: n }, (_, i) => ({ y: 65 + i, id: "minecraft:cactus" })), { y: 64, id: "minecraft:sand" }, { y: 63, id: "minecraft:sandstone" }];
    assert.equal(readStack(sand(3)).ok, true);
    assert.equal(readStack(sand(3)).cover.cactus, 3);
    assert.match(readStack(sand(4)).problems.join(" "), /cactus block\(s\) on minecraft:sand/);
    const grass = [{ y: 65, id: "minecraft:cactus" }, { y: 64, id: "minecraft:grass_block" }];
    assert.match(readStack(grass).problems.join(" "), /cactus block\(s\) on minecraft:grass_block/);
});

test("readStack: a village block above the ground is an obstruction, and reading continues to the ground", () => {
    const stack = readStack([
        { y: 66, id: "minecraft:air" },
        { y: 65, id: "minecraft:oak_door" },
        { y: 64, id: "minecraft:grass_block" },
    ]);
    assert.equal(stack.ok, false);
    assert.equal(stack.surface.id, "minecraft:grass_block");
    assert.match(stack.problems.join(" "), /minecraft:oak_door at y=65 is a player or village block/);
    assert.equal(stack.signals.length, 1);
});

test("readStack: lava anywhere refuses; a column with no natural ground refuses", () => {
    assert.match(readStack([{ y: 65, id: "minecraft:lava" }, { y: 64, id: "minecraft:grass_block" }]).problems.join(" "), /lava at y=65/);
    const none = readStack([{ y: 65, id: "minecraft:air" }, { y: 64, id: "minecraft:air" }]);
    assert.equal(none.ok, false);
    assert.equal(none.surface, undefined);
    assert.match(none.problems.join(" "), /no natural ground/);
});

test("readStack: a player block inside the ground within the cave depth refuses, a deep one is ignored", () => {
    const near = readStack([{ y: 64, id: "minecraft:grass_block" }, { y: 62, id: "minecraft:chest" }, { y: 61, id: "minecraft:stone" }], { depth: 8 });
    assert.match(near.problems.join(" "), /minecraft:chest at y=62 is inside the ground/);
    const deep = readStack([{ y: 64, id: "minecraft:grass_block" }, { y: 40, id: "minecraft:chest" }], { depth: 8 });
    assert.equal(deep.ok, true);
});

test("requiredFootingDepth: geometric depth plus anchor, against the depth limit", () => {
    assert.deepEqual(requiredFootingDepth("minecraft:grass_block", 65, 64), { ok: true, class: "temperate", anchor: 0, geometric: 0, required: 0 });
    assert.deepEqual(requiredFootingDepth("minecraft:sand", 65, 60), { ok: true, class: "desert", anchor: 2, geometric: 4, required: 6 });
    assert.equal(requiredFootingDepth("minecraft:grass_block", 65, 57).ok, true, "7 deep is allowed");
    assert.equal(requiredFootingDepth("minecraft:grass_block", 65, 56).ok, true, "8 deep is the limit");
    assert.equal(requiredFootingDepth("minecraft:grass_block", 65, 55).ok, false, "9 deep refuses");
    assert.equal(requiredFootingDepth("minecraft:sand", 65, 58).ok, true, "sand 6 deep plus 2 anchor is 8");
    const sandNine = requiredFootingDepth("minecraft:sand", 65, 57);
    assert.equal(sandNine.ok, false);
    assert.equal(sandNine.required, 9);
    assert.match(sandNine.reason, /needs 9 blocks of footing, max 8/);
    assert.equal(requiredFootingDepth("minecraft:grass_block", 65, 65).ok, false, "ground at the floor needs a cut");
    assert.equal(requiredFootingDepth("minecraft:farmland", 65, 64).ok, false, "not natural");
});

test("terrain.js NATURAL_GROUND differs from this module by exactly the patch the integrator must apply", () => {
    const current = new Set(terrain.NATURAL_GROUND);
    const proposed = new Set(Object.keys(NATURAL_SURFACES));
    const removed = [...current].filter((id) => !proposed.has(id)).sort();
    const added = [...proposed].filter((id) => !current.has(id)).sort();
    assert.deepEqual(removed, ["minecraft:grass_path"]);
    assert.deepEqual(added, ["minecraft:calcite", "minecraft:deepslate", "minecraft:dripstone_block", "minecraft:pale_moss_block"]);
});

test("each surface class declares its district works; stone is never filled, frozen and protected allow nothing", () => {
    const { CLASS_RULES, allowedWorks } = env;
    assert.deepEqual(Object.keys(CLASS_RULES).sort(), ["desert", "frozen", "protected", "snow", "stony", "temperate", "wet"]);
    for (const cls of ["temperate", "desert", "snow", "wet"]) assert.deepEqual([...CLASS_RULES[cls].works], ["cut", "fill", "footing", "road", "pad"], cls);
    assert.deepEqual([...CLASS_RULES.stony.works], ["cut", "footing", "road", "pad"]);
    assert.deepEqual([...CLASS_RULES.frozen.works], []);
    assert.deepEqual([...CLASS_RULES.protected.works], []);
    assert.deepEqual([...allowedWorks("minecraft:sand")], ["cut", "fill", "footing", "road", "pad"]);
    assert.deepEqual([...allowedWorks("minecraft:stone")], ["cut", "footing", "road", "pad"]);
    assert.deepEqual([...allowedWorks("minecraft:white_terracotta")], []);
    assert.deepEqual([...allowedWorks("minecraft:ice")], []);
});
