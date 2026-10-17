import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const { createInitialKingdom, districtById, findValidationProblems, serializeKingdom, computeTotals } = await loadModule("kingdom", "state.js");
const policies = await loadModule("sim", "policies.js");
const { advanceKingdomStep } = await loadModule("sim", "tick.js");

test("the garrison target is derived from the people actually living there", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    assert.equal(policies.desiredGarrison(district), Math.round(80 * policies.POLICY_DECISION_RULES.garrisonTargetFraction));
    assert.equal(policies.garrisonShortfall(district), Math.max(0, policies.desiredGarrison(district) - district.soldiers - district.trainingQueue));

    district.civilians = 200;
    district.soldiers = 20;
    district.trainingQueue = 5;
    assert.equal(policies.desiredGarrison(district), 40);
    assert.equal(policies.garrisonShortfall(district), 15);
});

test("secure land with stores to spare fills its ranks on its own", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    district.soldiers = 4;
    district.garrison = { front: 3, reserve: 1 };
    district.security = "secure";
    district.reserves.food = 300;
    district.reserves.supplies = 200;
    const civiliansBefore = district.civilians;

    const events = policies.runPolicyStep(kingdom);
    assert.ok(district.trainingQueue > 0, `no recruit was queued; events: ${events.join(" | ")}`);
    assert.equal(district.civilians, civiliansBefore - district.trainingQueue, "recruits must come out of the civilian count");
    assert.ok(events.some((line) => /training queue/i.test(line)), events.join(" | "));
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("recruitment suspends during an emergency", () => {
    for (const security of ["breached", "contested", "alert", "isolated", "lost"]) {
        const kingdom = createInitialKingdom();
        const district = districtById(kingdom, "district-1");
        district.soldiers = 2;
        district.garrison = { front: 2, reserve: 0 };
        district.security = security;
        district.reserves.food = 400;
        district.reserves.supplies = 400;
        policies.runPolicyStep(kingdom);
        assert.equal(district.trainingQueue, 0, `${security} land must not be drafting`);
    }
});

test("recruitment suspends when the district cannot feed its people", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    district.soldiers = 2;
    district.garrison = { front: 2, reserve: 0 };
    district.security = "secure";
    district.reserves.food = 0;
    district.reserves.supplies = 400;
    policies.runPolicyStep(kingdom);
    assert.equal(district.trainingQueue, 0, "a starving district must not take on more mouths");
});

test("secured land feeds and houses itself, and says so when it cannot pay", () => {
    const starving = createInitialKingdom();
    const farmDistrict = districtById(starving, "district-1");
    farmDistrict.buildings.farms = 0;
    farmDistrict.security = "secure";
    const farmEvents = policies.runPolicyStep(starving);
    assert.ok(farmDistrict.projects.some((project) => project.kind === "farms"), farmEvents.join(" | "));

    const crowded = createInitialKingdom();
    const houseDistrict = districtById(crowded, "district-2");
    houseDistrict.civilians = houseDistrict.civilianCapacity;
    houseDistrict.reserves.food = 500;
    houseDistrict.reserves.materials = 500;
    const houseEvents = policies.runPolicyStep(crowded);
    assert.ok(houseDistrict.projects.some((project) => project.kind === "homes"), houseEvents.join(" | "));

    const broke = createInitialKingdom();
    const poorDistrict = districtById(broke, "district-3");
    poorDistrict.buildings.farms = 0;
    poorDistrict.security = "secure";
    for (const field of ["food", "materials", "supplies"]) {
        poorDistrict.reserves[field] = 0;
    }
    const poorEvents = policies.runPolicyStep(broke);
    assert.equal(poorDistrict.projects.length, 0, "nothing may be scheduled without the first stage paid for");
    assert.ok(poorEvents.some((line) => /cannot pay/i.test(line)), poorEvents.join(" | "));
});

test("a district never runs more projects than the policy allows", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    district.security = "secure";
    district.reserves.food = 9000;
    district.reserves.materials = 9000;
    district.reserves.supplies = 9000;
    district.civilians = district.civilianCapacity;
    district.buildings.farms = 0;
    district.buildings.storehouses = 0;
    district.buildings.barracks = 0;
    district.soldiers = 10;
    district.garrison = { front: 8, reserve: 2 };

    for (let step = 0; step < 20; step += 1) {
        policies.runPolicyStep(kingdom);
    }
    const open = district.projects.filter((project) => project.status !== "complete");
    assert.ok(open.length <= policies.POLICY_DECISION_RULES.maxOpenProjectsPerDistrict, `${String(open.length)} open projects, cap is ${String(policies.POLICY_DECISION_RULES.maxOpenProjectsPerDistrict)}`);
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("policies are deterministic and use no randomness", () => {
    const build = () => {
        const kingdom = createInitialKingdom();
        const district = districtById(kingdom, "district-2");
        district.soldiers = 6;
        district.garrison = { front: 5, reserve: 1 };
        district.reserves.food = 600;
        return policies.runPolicyStep(kingdom).join(" | ") + " || " + JSON.stringify(kingdom);
    };
    assert.equal(build(), build());
});

test("the realm produces materials and supplies rather than only spending them", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    district.reserves.materials = 1;
    district.reserves.supplies = 1;
    policies.runEconomyStep(kingdom);
    assert.ok(district.reserves.materials > 1, "work gangs must produce materials");
    assert.ok(district.reserves.supplies > 1, "storehouses must produce supplies");

    const capped = createInitialKingdom();
    for (const entry of capped.districts) {
        entry.reserves.materials = 0;
        entry.buildings.storehouses = 1;
    }
    for (let step = 0; step < 2000; step += 1) {
        policies.runEconomyStep(capped);
    }
    const ceiling = policies.stockpileCeiling(capped.districts[0]);
    assert.ok(capped.districts[0].reserves.materials <= ceiling + 0.001, `${String(capped.districts[0].reserves.materials)} broke the ${String(ceiling)} stockpile ceiling`);
});

test("an opened border is occupied automatically, and never while paused", async () => {
    const expansionModule = await loadModule("sim", "expansion.js");
    const kingdom = createInitialKingdom();
    const land = kingdom.territory[0];
    expansionModule.recordExternalVictory(kingdom, land.id, {});
    assert.equal(land.status, "raided");
    const events = policies.runExpansionPolicy(kingdom);
    assert.equal(land.status, "military", events.join(" | "));
    assert.ok(events.some((line) => /military control/i.test(line)), events.join(" | "));

    const paused = createInitialKingdom();
    paused.policy.expansion = "paused";
    const pausedLand = paused.territory[0];
    expansionModule.recordExternalVictory(paused, pausedLand.id, {});
    assert.deepEqual(policies.runExpansionPolicy(paused), []);
    assert.equal(pausedLand.status, "raided", "a paused policy must not commit troops");
});

test("400 autonomous steps sustain the army, keep developing and stay bounded", () => {
    const kingdom = createInitialKingdom();
    let scheduled = 0;
    let largest = 0;
    for (let step = 0; step < 400; step += 1) {
        const before = kingdom.districts.reduce((sum, district) => sum + district.projects.length, 0);
        const result = advanceKingdomStep(kingdom);
        assert.deepEqual(result.problems, [], `step ${String(step)} rejected: ${result.problems.join("; ")}`);
        const after = kingdom.districts.reduce((sum, district) => sum + district.projects.length, 0);
        scheduled += Math.max(0, after - before);
        largest = Math.max(largest, serializeKingdom(kingdom).length);
        for (const district of kingdom.districts) {
            assert.ok(district.civilians + district.refugees <= district.civilianCapacity, `step ${String(step)}: ${district.name} over shelter`);
            assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers, `step ${String(step)}: garrison drifted in ${district.name}`);
        }
    }

    const totals = computeTotals(kingdom);
    assert.ok(scheduled > 0, "the kingdom never scheduled a single project in 400 steps");
    assert.ok(totals.soldiers > 100, `the autonomous kingdom withered to ${String(totals.soldiers)} soldiers`);
    assert.ok(totals.civilians >= 400, `population fell to ${String(totals.civilians)}`);
    assert.ok(largest < 24000, `saved blob grew to ${String(largest)} bytes`);
    const recorded = kingdom.districts.reduce((sum, district) => sum + district.projects.length, 0);
    assert.ok(recorded <= 5 * (policies.POLICY_DECISION_RULES.maxOpenProjectsPerDistrict + 2), `${String(recorded)} project records kept - the history is not bounded`);
});

test("the policy readout agrees with the state it describes", () => {
    const kingdom = createInitialKingdom();
    const view = policies.describePolicies(kingdom);
    assert.equal(view.districtCount, kingdom.districts.length);
    assert.equal(view.underArms, computeTotals(kingdom).soldiers);
    assert.equal(view.training, 0);
    assert.equal(view.openProjects, 0);
    assert.equal(typeof config.STARTING_SIMULATION.soldiers, "number");
});
