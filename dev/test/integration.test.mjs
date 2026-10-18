import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const { createInitialKingdom, computeTotals, findValidationProblems, districtById, districtHeadroom, districtOccupancy, serializeKingdom } = await loadModule("kingdom", "state.js");
const { createKingdomStore } = await loadModule("kingdom", "store.js");
const { advanceKingdom, advanceKingdomStep } = await loadModule("sim", "tick.js");
const { runEvacuationStep, evacuateCivilians, findEvacuationTargets, setGateState } = await loadModule("sim", "evacuation.js");
const { runPopulationStep } = await loadModule("sim", "population.js");
const { assignBuilders } = await loadModule("sim", "construction.js");
const { recordExternalVictory, establishMilitaryControl, evaluateExpansion } = await loadModule("sim", "expansion.js");
const scenarios = await loadModule("sim", "scenarios.js");
const report = await loadModule("ui", "report.js");
const { parseArgs, parseCount } = await loadModule("commands", "args.js");

function createMockWorld(entries) {
    const properties = new Map(entries ?? []);
    return {
        properties,
        getDynamicProperty(identifier) {
            return properties.get(identifier);
        },
        setDynamicProperty(identifier, value) {
            if (value === undefined) {
                properties.delete(identifier);
            } else {
                properties.set(identifier, value);
            }
        },
    };
}

/**
 * Assert the invariants every system shares. Called after every step of the long runs, so
 * a violation is pinned to the step that caused it rather than found in a final dump.
 * @param {any} kingdom
 * @param {number} index
 */
function assertKingdomIsSound(kingdom, index) {
    const problems = findValidationProblems(kingdom);
    assert.deepEqual(problems, [], `step ${String(index)} produced an unsavable kingdom: ${problems.join("; ")}`);
    for (const district of kingdom.districts) {
        assert.ok(
            district.civilians + district.refugees <= district.civilianCapacity,
            `step ${String(index)}: ${district.name} holds ${String(district.civilians)} civilians + ${String(district.refugees)} refugees over capacity ${String(district.civilianCapacity)}`,
        );
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers, `step ${String(index)}: garrison drifted in ${district.name}`);
        for (const field of ["civilians", "soldiers", "refugees", "trainingQueue"]) {
            assert.ok(district[field] >= 0, `step ${String(index)}: ${district.name}.${field} went negative`);
        }
        assert.ok(district.defensiveIntegrity >= 0 && district.defensiveIntegrity <= 100, `step ${String(index)}: integrity out of range`);
        for (const kind of ["food", "materials", "supplies"]) {
            assert.ok(district.reserves[kind] >= 0, `step ${String(index)}: ${district.name} reserves went negative`);
        }
        for (const neighbor of district.neighbors) {
            assert.ok(districtById(kingdom, neighbor), `step ${String(index)}: ${district.name} points at a district that does not exist`);
        }
    }
}

test("shelter is shared: growth cannot fill capacity that refugees already occupy", () => {
    const kingdom = createInitialKingdom();
    const host = districtById(kingdom, "district-2");
    const origin = districtById(kingdom, "district-1");

    host.civilians = 100;
    host.refugees = 0;
    origin.civilians = 40;
    origin.security = "breached";
    origin.defensiveIntegrity = 20;
    origin.assault = 20;

    const moved = evacuateCivilians(kingdom, origin, 40);
    assert.ok(moved.moved > 0, "the evacuation should have taken in someone");
    assert.equal(districtOccupancy(host), host.civilians + host.refugees);
    assert.ok(districtHeadroom(host) >= 0);

    // Growth now has to respect the room the guests are using.
    host.security = "secure";
    host.reserves.food = 500;
    for (let step = 0; step < 40; step += 1) {
        runPopulationStep(kingdom);
    }
    assert.ok(
        host.civilians + host.refugees <= host.civilianCapacity,
        `host over shelter after growth: ${String(host.civilians)} + ${String(host.refugees)} > ${String(host.civilianCapacity)}`,
    );
    assertKingdomIsSound(kingdom, 0);
});

test("evacuation into a full district is refused with a stated reason, not silently dropped", () => {
    const kingdom = createInitialKingdom();
    const origin = districtById(kingdom, "district-1");
    // district-1 is ring-connected to district-5 and district-2; both have to be full
    // before there is genuinely nowhere to send people.
    for (const neighborId of origin.neighbors) {
        const host = districtById(kingdom, neighborId);
        host.civilians = host.civilianCapacity;
    }
    origin.security = "breached";
    const civiliansBefore = origin.civilians;

    const search = findEvacuationTargets(kingdom, origin);
    assert.ok(Array.isArray(search.targets), "findEvacuationTargets must report a target list");
    assert.equal(search.targets.filter((target) => target.canTake > 0).length, 0, `no full host may be offered: ${JSON.stringify(search.targets)}`);
    assert.match(JSON.stringify(search.blocked) + String(search.reason ?? ""), /capacity|headroom|full|no room/i);

    const result = evacuateCivilians(kingdom, origin, 20);
    assert.equal(result.moved, 0);
    assert.equal(result.blocked, true);
    assert.equal(origin.civilians, civiliansBefore, "people who cannot move are not deleted");
    for (const district of kingdom.districts) {
        assert.ok(district.civilians + district.refugees <= district.civilianCapacity, `${district.name} went over shelter`);
    }
});

test("sealed and broken gates cut evacuation routes", () => {
    const kingdom = createInitialKingdom();
    const origin = districtById(kingdom, "district-1");
    origin.security = "breached";

    const before = findEvacuationTargets(kingdom, origin);
    assert.ok(before.targets.some((target) => target.canTake > 0), `the neighbours should be reachable before the gates go: ${JSON.stringify(before)}`);

    for (const district of kingdom.districts) {
        for (const gate of district.gates) {
            setGateState(kingdom, gate.id, "sealed");
        }
    }
    origin.gates.forEach((gate) => setGateState(kingdom, gate.id, "broken"));

    const after = findEvacuationTargets(kingdom, origin);
    assert.equal(after.targets.filter((target) => target.canTake > 0 && target.gateState === "open").length, 0, "no open gate should remain");
    const moved = evacuateCivilians(kingdom, origin, 30);
    assert.equal(moved.moved, 0, "people cannot walk through a sealed or broken gate");
});

test("300 mixed steps keep every invariant and always stay savable", () => {
    const kingdom = createInitialKingdom();
    let saved = 0;
    for (let step = 0; step < 300; step += 1) {
        if (step === 40) {
            districtById(kingdom, "district-3").defensiveIntegrity = 30;
            districtById(kingdom, "district-3").assault = 28;
        }
        if (step === 120) {
            recordExternalVictory(kingdom, "land-2", {});
            establishMilitaryControl(kingdom, "land-2", {});
        }
        const result = advanceKingdomStep(kingdom);
        assert.deepEqual(result.problems, [], `step ${String(step)} was rejected: ${result.problems.join("; ")}`);
        assertKingdomIsSound(kingdom, step);
        saved += result.events.length;
    }
    assert.ok(saved > 0, "the simulation logged nothing across 300 steps");
    assert.equal(typeof serializeKingdom(kingdom), "string");
});

test("the same seed replays identically; a different seed diverges", () => {
    const replay = (seed) => {
        const kingdom = createInitialKingdom();
        kingdom.seed = seed;
        kingdom.rngState = seed >>> 0;
        advanceKingdom(kingdom, 20);
        return JSON.stringify(kingdom);
    };
    assert.equal(replay(424242), replay(424242), "a fixed seed must be reproducible");
    assert.notEqual(replay(424242), replay(991111), "different seeds must diverge");
});

test("advanceKingdom is bounded and rejects nonsense step counts", () => {
    const kingdom = createInitialKingdom();
    const clamped = advanceKingdom(kingdom, config.SIM.maxCatchUpSteps * 10);
    assert.equal(clamped.ran + clamped.skipped, config.SIM.maxCatchUpSteps, "a catch-up request must be clamped, not run away");
    assert.throws(() => advanceKingdom(createInitialKingdom(), 3.5), /must be an integer/);
    assert.equal(advanceKingdom(createInitialKingdom(), -5).ran, 0);
});

test("every scenario runs dry against a copy and leaves the saved kingdom untouched", () => {
    const world = createMockWorld();
    const store = createKingdomStore(world);
    store.ensureInitial();
    const beforeSave = world.properties.get(config.STORAGE_KEYS.kingdom);

    for (const scenario of scenarios.listScenarios()) {
        const loaded = store.load();
        const copy = JSON.parse(JSON.stringify(loaded.kingdom));
        const result = scenarios.runScenario(copy, scenario.id, {});
        assert.ok(result.lines.length > 0, `${scenario.id} produced no report`);
        assertKingdomIsSound(copy, 0);
    }

    assert.equal(world.properties.get(config.STORAGE_KEYS.kingdom), beforeSave, "dry runs must not write the save");
    assert.throws(() => scenarios.runScenario(createInitialKingdom(), "not-a-scenario", {}), /unknown scenario/);
    assert.throws(() => scenarios.runScenario(createInitialKingdom(), "attack", { steps: 0 }), /steps must be an integer/);
    assert.throws(() => scenarios.runScenario(createInitialKingdom(), "attack", { target: "district-99" }), /unknown district/);
});

test("the scenario that must expand either claims land or refuses with reasons", () => {
    const grower = createInitialKingdom();
    const expansion = scenarios.runScenario(grower, "expansion", {});
    const text = expansion.lines.join("\n");
    const grew = /Districts: 5 -> 6/.test(text);
    const refused = /refused - /.test(text);
    assert.notEqual(grew, refused, `the report must show exactly one outcome:\n${text}`);
    assert.equal(grower.districts.length, grew ? 6 : 5, "the report and the state must agree");
    if (refused) {
        assert.match(text, /- /, "a refusal has to list at least one reason");
    }

    const starving = createInitialKingdom();
    const refusal = scenarios.runScenario(starving, "shortage", {});
    assert.match(refusal.lines.join("\n"), /refused, as expected/);
    assert.equal(starving.districts.length, 5, "a refused expansion must not create a district");
});

test("status output still starts with the original five lines and adds the situation below", () => {
    const lines = report.formatStatusLines(createInitialKingdom());
    assert.equal(lines[0], "=== Civilization Apocalypse ===");
    assert.equal(lines[1], "Districts: 5");
    assert.equal(lines[2], "Civilians: 400");
    assert.equal(lines[3], "Soldiers:  150");
    assert.equal(lines[4], "-- districts --");
    assert.equal(lines[5], "Hearthgate: 80 civilians, 30 soldiers");
    assert.ok(lines.includes("-- situation --"), "the report should now also carry the situation block");
    assert.ok(lines.some((line) => /^Time: Day /.test(line)));
});

test("district, territory and policy readouts render from saved state", () => {
    const kingdom = createInitialKingdom();
    const districtLines = report.formatDistrictLines(kingdom, kingdom.districts[0]);
    assert.ok(districtLines.some((line) => line.startsWith("Security: secure")));
    assert.ok(districtLines.some((line) => line.includes("Garrison: 30 troops - 24 on the wall, 6 in reserve")));
    assert.ok(districtLines.some((line) => line.includes("Defensive integrity: 100%")));

    const territoryLines = report.formatTerritoryLines(kingdom);
    assert.equal(territoryLines.length, 1 + config.TERRITORY_NAMES.length);

    const policyLines = report.formatPolicyLines(kingdom);
    assert.match(policyLines[0], /Expansion policy: balanced/);

    const unknown = report.formatUnknownDistrictLines(["district-1"], "district-77");
    assert.ok(unknown[0].includes("district-77") && unknown[1].includes("district-1"));

    const refused = report.formatRefusedKingdomLines("saved state is schema v9, newer than this pack (v2)");
    assert.ok(refused.join(" ").includes("Nothing was overwritten"));
});

test("command argument parsing rejects invalid input instead of guessing", () => {
    assert.deepEqual(parseArgs("  district-2  --apply "), ["district-2", "--apply"]);
    assert.deepEqual(parseArgs(""), []);
    assert.deepEqual(parseCount(undefined, 1, 1, 24), { value: 1, error: undefined });
    assert.equal(parseCount("6", 1, 1, 24).value, 6);
    assert.match(String(parseCount("abc", 1, 1, 24).error), /not a whole number/);
    assert.match(String(parseCount("99", 1, 1, 24).error), /between 1 and 24/);
    assert.match(String(parseCount("0", 1, 1, 24).error), /between 1 and 24/);
});

test("the offline core stays free of the Minecraft runtime, and the adapters are the only things that use it", () => {
    const runtimeImport = /(^|\n)\s*import\s[^;\n]*from\s*["']@minecraft\/server["']/;
    const pureDirs = ["sim", "kingdom", "ui", "structures", "civ"];
    const runtimeDirs = ["integration", "commands", "events"];

    let pureChecked = 0;
    for (const dir of pureDirs) {
        for (const file of readdirSync(join(scriptsRoot, dir))) {
            if (!file.endsWith(".js")) continue;
            pureChecked += 1;
            assert.ok(!runtimeImport.test(readFileSync(join(scriptsRoot, dir, file), "utf8")), `${dir}/${file} must not import @minecraft/server at runtime`);
        }
    }
    assert.ok(pureChecked >= 30, `expected the whole pure core to be scanned, only saw ${String(pureChecked)} files`);

    // commands/args.js is pure by design; everything else under the runtime dirs must
    // genuinely be a runtime file, otherwise it has been mis-placed out of the core.
    let runtimeChecked = 0;
    for (const dir of runtimeDirs) {
        for (const file of readdirSync(join(scriptsRoot, dir))) {
            if (!file.endsWith(".js")) continue;
            runtimeChecked += 1;
            if (file === "args.js") {
                assert.ok(!runtimeImport.test(readFileSync(join(scriptsRoot, dir, file), "utf8")), "args.js must stay runnable without the runtime");
            } else {
                assert.ok(runtimeImport.test(readFileSync(join(scriptsRoot, dir, file), "utf8")), `${dir}/${file} should be the boundary that touches @minecraft/server`);
            }
        }
    }
    assert.ok(runtimeChecked >= 10, `expected at least 10 runtime-side files, saw ${String(runtimeChecked)}`);
});

test("assignBuilders never puts more builders to work than there are people", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    district.civilians = 4;
    assignBuilders(district, kingdom, { canWork: true });
    assert.ok(district.builders <= district.civilians, `${String(district.builders)} builders with only ${String(district.civilians)} civilians`);
    assertKingdomIsSound(kingdom, 0);
});
