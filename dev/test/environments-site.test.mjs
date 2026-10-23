import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { assessSite, VILLAGE_DEFAULTS, WATER_DEFAULTS } = await load("civ", "environments.js");

const AIR = "minecraft:air";
const GRASS = "minecraft:grass_block";
const AREA = { x0: 0, z0: 0, x1: 6, z1: 6 };
const MARGIN = Math.max(VILLAGE_DEFAULTS.radius, WATER_DEFAULTS.margin);

/** Ground at surfaceY: air above, the surface block, dirt, then stone. */
function ground(surfaceY = 64, surfaceId = GRASS, overrides = {}) {
    const cells = [];
    for (let y = surfaceY + 5; y >= surfaceY - 12; y -= 1) {
        if (y in overrides) cells.push({ y, id: overrides[y] });
        else if (y > surfaceY) cells.push({ y, id: AIR });
        else if (y === surfaceY) cells.push({ y, id: surfaceId });
        else cells.push({ y, id: y >= surfaceY - 3 ? "minecraft:dirt" : "minecraft:stone" });
    }
    return cells;
}

/** The footprint plus the village and water margin. make(x, z) returns the cells. */
function world(make, area = AREA, margin = MARGIN) {
    const columns = [];
    for (let z = area.z0 - margin; z <= area.z1 + margin; z += 1) {
        for (let x = area.x0 - margin; x <= area.x1 + margin; x += 1) columns.push({ x, z, cells: make(x, z) });
    }
    return columns;
}

/** Sand at 64 with solid sandstone below it (the natural desert stratum). */
function sandOverSandstone() {
    const cells = [];
    for (let y = 69; y > 64; y -= 1) cells.push({ y, id: AIR });
    cells.push({ y: 64, id: "minecraft:sand" });
    for (let y = 63; y >= 52; y -= 1) cells.push({ y, id: "minecraft:sandstone" });
    return cells;
}

const inFootprint = (x, z) => x >= AREA.x0 && x <= AREA.x1 && z >= AREA.z0 && z <= AREA.z1;
const wet = (bedY = 62, waterY = 63) => {
    const cells = [];
    for (let y = bedY + 3; y > waterY; y -= 1) cells.push({ y, id: AIR });
    cells.push({ y: waterY, id: "minecraft:water" });
    for (let y = bedY; y >= bedY - 8; y -= 1) cells.push({ y, id: y === bedY || y >= bedY - 3 ? "minecraft:dirt" : "minecraft:stone" });
    return cells;
};

/** Decision table: each row is a site, its expected decision, and a reason pattern when refused. */
const TABLE = [
    { name: "temperate flat grass", make: () => ground(64), decision: "allow" },
    { name: "desert: sand top over sandstone stratum", make: () => sandOverSandstone(), decision: "allow" },
    { name: "snow layer on grass is clearable cover", make: (x, z) => (inFootprint(x, z) ? ground(64, GRASS, { 65: "minecraft:snow_layer" }) : ground(64)), decision: "allow" },
    { name: "a full snow block as the top refuses (craftable)", make: () => ground(64, "minecraft:snow"), decision: "refuse", reason: /craftable top \(snow block, clay, sandstone; allowed 0\), e\.g\. minecraft:snow/ },
    { name: "clay top refuses (craftable)", make: () => ground(64, "minecraft:clay"), decision: "refuse", reason: /craftable top/ },
    { name: "sandstone top refuses (craftable)", make: () => ground(64, "minecraft:sandstone"), decision: "refuse", reason: /craftable top/ },
    { name: "ice above the ground refuses (frozen)", make: (x, z) => (x === 3 && z === 3 ? ground(64, GRASS, { 65: "minecraft:ice" }) : ground(64)), decision: "refuse", reason: /minecraft:ice at y=65 is frozen/ },
    { name: "powder snow refuses (frozen)", make: (x, z) => (x === 3 && z === 3 ? ground(64, GRASS, { 65: "minecraft:powder_snow" }) : ground(64)), decision: "refuse", reason: /is frozen/ },
    { name: "terracotta above ground refuses (player-used)", make: (x, z) => (x === 3 && z === 3 ? ground(64, GRASS, { 65: "minecraft:white_terracotta" }) : ground(64)), decision: "refuse", reason: /minecraft:white_terracotta at y=65 is protected/ },
    { name: "planks in the footprint refuse, with coordinates", make: (x, z) => (x === 3 && z === 3 ? ground(64, GRASS, { 65: "minecraft:spruce_planks" }) : ground(64)), decision: "refuse", reason: /minecraft:spruce_planks \(planks\) at \(3, 65, 3\) is inside the footprint/ },
    { name: "a grass path on the surface refuses (village path)", make: (x, z) => (x === 3 && z === 3 ? ground(64, "minecraft:grass_path") : ground(64)), decision: "refuse", reason: /minecraft:grass_path at y=64 is a player or village block, not natural terrain/ },
    { name: "lava above ground refuses", make: (x, z) => (x === 3 && z === 3 ? ground(64, GRASS, { 65: "minecraft:lava" }) : ground(64)), decision: "refuse", reason: /lava at y=65/ },
    { name: "exposed ore at the surface refuses", make: (x, z) => (x === 3 && z === 3 ? ground(64, "minecraft:coal_ore") : ground(64)), decision: "refuse", reason: /exposed ore minecraft:coal_ore/ },
    { name: "wheat (cultivated) above ground refuses as unknown", make: (x, z) => (x === 3 && z === 3 ? ground(64, GRASS, { 65: "minecraft:wheat" }) : ground(64)), decision: "refuse", reason: /minecraft:wheat at y=65 is unknown/ },
    { name: "cactus on grass refuses", make: (x, z) => (x === 3 && z === 3 ? ground(64, GRASS, { 65: "minecraft:cactus" }) : ground(64)), decision: "refuse", reason: /cactus block\(s\) on minecraft:grass_block/ },
    { name: "a tall cactus stack on sand refuses", make: (x, z) => (x === 3 && z === 3 ? ground(64, "minecraft:sand", { 65: "minecraft:cactus", 66: "minecraft:cactus", 67: "minecraft:cactus", 68: "minecraft:cactus" }) : ground(64, "minecraft:sand")), decision: "refuse", reason: /4 cactus block\(s\) on minecraft:sand/ },
    { name: "two cactus on sand are natural and allowed", make: (x, z) => (x === 3 && z === 3 ? ground(64, "minecraft:sand", { 65: "minecraft:cactus", 66: "minecraft:cactus" }) : ground(64, "minecraft:sand")), decision: "allow" },
    { name: "a void under the footprint (cave) refuses", make: (x, z) => (x === 2 && z === 2 ? ground(64, GRASS, { 61: AIR }) : ground(64)), decision: "refuse", reason: /cave: 1 footprint column\(s\) are hollow, breach or a pit/ },
    { name: "a wide lake next to the footprint refuses", make: (x, z) => (x <= -1 ? wet() : ground(64)), decision: "refuse", reason: /wide water \(lake or river\)/ },
    { name: "a narrow stream across the footprint refuses under the default policy", make: (x, z) => (z === 3 && x >= -2 && x <= 8 ? wet() : ground(64)), decision: "refuse", reason: /narrow water of 9x1 inside the footprint at \(\d+, 3\) \(policy: refuse\)/ },
    { name: "the same stream under the bridge policy is allowed with bridges", make: (x, z) => (z === 3 && x >= -2 && x <= 8 ? wet() : ground(64)), options: { water: { footprintWater: "bridge" } }, decision: "allow_with_bridges" },
    { name: "a deep stream bed does not block bridging (water columns are not earthworked)", make: (x, z) => (z === 3 && x >= -2 && x <= 8 ? wet(50, 51) : ground(64)), options: { water: { footprintWater: "bridge" } }, decision: "allow_with_bridges" },
    { name: "a village cluster outside the footprint refuses", make: (x, z) => (x === 9 && z === 3 ? [{ y: 65, id: "minecraft:red_bed" }, { y: 66, id: "minecraft:oak_door" }, { y: 65, id: "minecraft:composter" }, { y: 65, id: "minecraft:spruce_planks" }, { y: 66, id: "minecraft:spruce_planks" }, ...ground(64)] : ground(64)), decision: "refuse", reason: /village-like: 49 footprint column\(s\) reach 10 weighted/ },
    { name: "a footprint column 5 above the platform is too uneven (cut 4 allowed)", make: (x, z) => (x === 3 && z === 3 ? ground(69) : ground(64)), decision: "refuse", reason: /terrain too uneven for one platform at y=64: 1 column\(s\) beyond cut 4 \/ fill 4, e\.g\. \(3, 3\) needs a cut of 5/ },
    { name: "a footprint column 4 above the platform is within the cut limit", make: (x, z) => (x === 3 && z === 3 ? ground(68) : ground(64)), decision: "allow" },
    { name: "a footprint column 5 below the platform is too uneven (fill 4 allowed)", make: (x, z) => (x === 3 && z === 3 ? ground(59) : ground(64)), decision: "refuse", reason: /needs a fill of 5/ },
    { name: "stone 1 below the platform refuses: no fill is laid over stone", make: (x, z) => (x === 3 && z === 3 ? ground(63, "minecraft:stone") : ground(64)), decision: "refuse", reason: /minecraft:stone below the platform: fill over stony ground is not planned/ },
];

for (const row of TABLE) {
    test(`site: ${row.name} -> ${row.decision}`, () => {
        const columns = world(row.make);
        const result = assessSite(columns, AREA, row.options ?? {});
        assert.equal(result.decision, row.decision, `reasons: ${result.reasons.join(" | ")}`);
        if (row.reason !== undefined) assert.match(result.reasons.join(" | "), row.reason);
        if (row.decision === "refuse") assert.ok(result.reasons.length > 0);
        if (row.decision === "allow") assert.deepEqual(result.reasons, []);
    });
}

test("site: an unscanned margin refuses with the count and a sample coordinate", () => {
    const columns = world(() => ground(64), AREA, 3);
    const result = assessSite(columns, AREA);
    assert.equal(result.decision, "refuse");
    assert.match(result.reasons[0], /column\(s\) were not scanned \(footprint plus 12-block margin is required\), e\.g\. \(-12, -12\)/);
});

test("site: snow blocks are allowed only when the caller raises maxAmbiguousTop to cover them", () => {
    const columns = world(() => ground(64, "minecraft:snow"));
    assert.equal(assessSite(columns, AREA).decision, "refuse");
    const allowed = assessSite(columns, AREA, { maxAmbiguousTop: 49 });
    assert.equal(allowed.decision, "allow");
    assert.deepEqual(allowed.classes, { snow: 49 });
});

test("site: sand over a sandstone stratum counts the sand as desert and the cover as cleared", () => {
    const columns = world((x, z) => (x === 3 && z === 3 ? ground(64, "minecraft:sand", { 65: "minecraft:short_grass" }) : ground(64, "minecraft:sand")));
    const result = assessSite(columns, AREA);
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.classes, { desert: 49 });
    assert.equal(result.cover.plants, 1);
    assert.equal(result.ambiguousTop, 0);
});

test("site: the summary reports the base plane, earthwork and footing counts for an allowed site", () => {
    const result = assessSite(world((x, z) => (x === 3 && z === 3 ? ground(66) : ground(64))), AREA);
    assert.equal(result.decision, "allow");
    assert.equal(result.baseY, 64);
    assert.deepEqual(result.earthwork, { cut: 2, fill: 0, maxCut: 4, maxFill: 4, waterColumns: 0 });
    assert.equal(result.footing.ok, true);
    assert.equal(result.footing.counts.columns, 48, "the raised column is cut, not footed");
    assert.equal(result.footing.counts.cut, 1);
});

test("site: a result is deterministic and the input is not mutated", () => {
    const columns = world((x, z) => (z === 3 && x >= -2 && x <= 8 ? wet() : ground(64)));
    const before = JSON.stringify(columns);
    const opts = { water: { footprintWater: "bridge" } };
    const a = assessSite(columns, AREA, opts);
    const b = assessSite(columns, AREA, opts);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(columns), before);
});
