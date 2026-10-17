import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const { createInitialKingdom, computeTotals, findValidationProblems } = await loadModule("kingdom", "state.js");
const population = await loadModule("sim", "population.js");

const { DISTRICT_DEFAULTS, POPULATION_DEFAULTS, PROJECT_TYPES } = config;
const { advanceTraining, describeRecruitment, eligibleRecruits, farmFoodOutput, foodDemand,
    openRecruitment, runPopulationStep, syncGarrison, POPULATION_RULES } = population;

function dp1(value) {
    return Math.round(value * 10) / 10;
}

/** A district with full larders, so nothing but appetite and safety is being tested. */
function fedKingdom() {
    const kingdom = createInitialKingdom();
    kingdom.districts.forEach((district) => {
        district.reserves = { food: 5000, materials: 500, supplies: 500 };
    });
    return kingdom;
}

/** A district that is going hungry. */
function starvingKingdom() {
    const kingdom = createInitialKingdom();
    kingdom.districts.forEach((district) => {
        district.buildings.farms = 0;
        district.reserves = { food: 2, materials: 100, supplies: 100 };
    });
    return kingdom;
}

function headOf(kingdom) {
    return kingdom.districts[0];
}

function peopleOf(district) {
    return district.civilians + district.trainingQueue + district.soldiers;
}

test("a fed, safe district grows toward its capacity and never past it", () => {
    const kingdom = fedKingdom();
    const district = headOf(kingdom);
    const demand = foodDemand(district);
    assert.equal(demand, dp1(80 * DISTRICT_DEFAULTS.foodDemandPerCivilian + 30 * DISTRICT_DEFAULTS.foodDemandPerSoldier));
    assert.equal(demand, 3.1);
    assert.equal(district.civilianCapacity, DISTRICT_DEFAULTS.homesPerDistrict * DISTRICT_DEFAULTS.capacityPerHome);

    const first = runPopulationStep(kingdom);
    assert.equal(first.districts.length, kingdom.districts.length);
    assert.deepEqual(first.districts.map((report) => report.districtId), ["district-1", "district-2", "district-3", "district-4", "district-5"]);
    assert.equal(first.districts[0].shortage, false);
    assert.equal(first.districts[0].grew, 0, "0.36 people is not a person yet");
    assert.ok(first.districts[0].produced > 0);

    // 6 homes x growthPerStepPerHome = 0.36 per step, so the third step is the first new birth.
    kingdom.step = 2;
    assert.equal(runPopulationStep(kingdom).districts[0].grew, 0, "0.72 people is still nobody");
    assert.equal(district.civilians, 80);

    kingdom.step = 3;
    const third = runPopulationStep(kingdom);
    assert.equal(third.districts[0].grew, 1);
    assert.equal(district.civilians, 81);
    assert.ok(district.growthBuffer < 1);

    let peak = 81;
    for (let step = 4; step <= 600; step += 1) {
        kingdom.step = step;
        const report = runPopulationStep(kingdom);
        assert.ok(district.civilians <= district.civilianCapacity, `step ${String(step)} broke the ceiling`);
        assert.ok(district.civilians >= peak, "a fed, safe district never shrinks");
        peak = district.civilians;
        assert.equal(report.districts[0].shortage, false);
        if (step % 100 === 0) {
            assert.deepEqual(findValidationProblems(kingdom), [], `step ${String(step)}`);
        }
    }

    assert.equal(district.civilians, district.civilianCapacity, "the district fills its houses and then stops");
    const last = runPopulationStep(kingdom);
    assert.equal(last.districts[0].grew, 0);
    assert.match(last.districts[0].reason, /growth stopped at shelter room 120 \(capacity 120 - refugees 0\)/);
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("the growth rate really is homes x growthPerStepPerHome", () => {
    const kingdom = fedKingdom();
    const district = headOf(kingdom);
    district.civilianCapacity = 400;
    const start = district.civilians;
    for (let step = 1; step <= 50; step += 1) {
        kingdom.step = step;
        runPopulationStep(kingdom);
    }
    const perStep = (district.civilians - start) / 50;
    const expected = district.buildings.homes * POPULATION_DEFAULTS.growthPerStepPerHome;
    assert.ok(Math.abs(perStep - expected) < 0.01, `grew ${String(perStep)}/step, expected ${String(expected)}`);

    // One more standing home from sim/construction.js speeds it up.
    const other = fedKingdom();
    const twin = headOf(other);
    twin.civilianCapacity = 400;
    twin.buildings.homes += 1;
    const otherStart = twin.civilians;
    for (let step = 1; step <= 50; step += 1) {
        other.step = step;
        runPopulationStep(other);
    }
    assert.ok(twin.civilians - otherStart > district.civilians - start);
});

test("farms feed the district: more farms means more food", () => {
    const district = headOf(fedKingdom());
    assert.equal(farmFoodOutput(district), dp1(DISTRICT_DEFAULTS.farmsPerDistrict * DISTRICT_DEFAULTS.foodPerFarmPerStep));
    district.buildings.farms += 1;
    assert.equal(farmFoodOutput(district), dp1(5 * DISTRICT_DEFAULTS.foodPerFarmPerStep));
    assert.ok(farmFoodOutput(district) > foodDemand(district), "a four-farm district can eat and still grow");
});

test("a food shortage suspends growth, reports it, and eventually costs lives", () => {
    const kingdom = starvingKingdom();
    const district = headOf(kingdom);
    const before = district.civilians;

    const report = runPopulationStep(kingdom);
    assert.equal(report.districts[0].shortage, true);
    assert.equal(report.districts[0].consumed, 2, "everything it had is eaten");
    assert.equal(report.districts[0].grew, 0);
    assert.match(report.districts[0].reason, /growth suspended: the district is short of food/);
    assert.equal(district.civilians, before, "the first bad step only warns");
    assert.equal(district.foodStress, 1);
    assert.equal(district.reserves.food, 0);
    assert.match(report.events[0], /SHORTAGE - needed 3\.1 food, had 2, ate 2/);
    assert.ok(kingdom.log.some((entry) => entry.text.includes("SHORTAGE")), "the shortage is in the saved log");

    let lost = 0;
    for (let step = 1; step <= 40; step += 1) {
        kingdom.step = step;
        const step1 = runPopulationStep(kingdom);
        lost += step1.districts[0].lost;
        assert.equal(step1.districts[0].grew, 0, "a hungry district cannot grow");
        assert.ok(district.civilians >= 0);
        assert.ok(district.reserves.food >= 0);
    }
    assert.ok(lost > 0, "shortage pressure has to be real, not just reported");
    assert.equal(district.civilians, before - lost);
    assert.equal(district.soldiers, 30, "the garrison does not starve out of the civilian count");
    assert.equal(district.foodStress, 41);
    assert.deepEqual(findValidationProblems(kingdom), []);

    //stores restored -> stress resets and growth resumes
    district.reserves = { food: 5000, materials: 500, supplies: 500 };
    district.buildings.farms = DISTRICT_DEFAULTS.farmsPerDistrict;
    const recovered = runPopulationStep(kingdom);
    assert.equal(recovered.districts[0].shortage, false);
    assert.equal(district.foodStress, 0);
    assert.equal(recovered.districts[0].reason, null);
});

test("growth needs a safe district: alert and worse suspends it with a reason", () => {
    for (const security of ["alert", "contested", "breached", "isolated", "lost"]) {
        const kingdom = fedKingdom();
        const district = headOf(kingdom);
        district.security = security;
        const before = district.civilians;

        const report = runPopulationStep(kingdom);
        assert.equal(report.districts[0].grew, 0, `${security} must not grow`);
        assert.equal(district.civilians, before);
        assert.match(
            report.districts[0].reason,
            new RegExp(`growth suspended: security '${security}' is not one of secure`),
        );
        assert.equal(district.security, security, "the population step never rewrites the front line");
        assert.ok(district.reserves.food < 5000 + DISTRICT_DEFAULTS.foodPerFarmPerStep * 8, "it still eats");
        assert.deepEqual(findValidationProblems(kingdom), []);
    }
    assert.deepEqual(POPULATION_RULES.growthAllowedSecurity, ["secure"]);
});

test("openRecruitment rejects bad input with an error instead of clamping", () => {
    const kingdom = createInitialKingdom();
    const district = headOf(kingdom);
    const snapshot = JSON.stringify(district);

    assert.throws(() => openRecruitment(district, 2.5), /whole number of people/);
    assert.throws(() => openRecruitment(district, NaN), /whole number of people/);
    assert.throws(() => openRecruitment(district, "four"), /whole number of people/);
    assert.throws(() => openRecruitment(district, 0), /must be greater than zero/);
    assert.throws(() => openRecruitment(district, -3), /must be greater than zero/);
    assert.throws(() => openRecruitment(null, 1), /district must be an object/);

    assert.equal(eligibleRecruits(district), 80);
    assert.throws(() => openRecruitment(district, 81), /cannot field 81 recruits - only 80 civilians are free/);
    district.builders = 30;
    assert.throws(() => openRecruitment(district, 51), /50 civilians are free \(80 citizens, 30 building, 0 already in the queue\)/);
    district.builders = 0;

    assert.throws(() => openRecruitment(district, 40), /training queue holds 12 more recruit\(s\) of 12/);
    assert.equal(JSON.stringify(district), snapshot, "a rejected levy spends nothing at all");
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("recruitment moves civilians into the queue and charges the levy up front", () => {
    const kingdom = createInitialKingdom();
    const district = headOf(kingdom);
    const people = peopleOf(district);
    const foodBefore = district.reserves.food;
    const suppliesBefore = district.reserves.supplies;
    const materialsBefore = district.reserves.materials;

    const result = openRecruitment(district, 5, { kingdom });
    assert.equal(result.ok, true);
    assert.equal(district.civilians, 75);
    assert.equal(district.trainingQueue, 5);
    assert.equal(peopleOf(district), people, "the five are in the queue, not conjured and not lost");
    assert.equal(district.reserves.food, dp1(foodBefore - 5 * POPULATION_DEFAULTS.trainingFoodCostPerRecruit));
    assert.equal(district.reserves.supplies, dp1(suppliesBefore - 5 * POPULATION_DEFAULTS.trainingSupplyCostPerRecruit));
    assert.equal(district.reserves.materials, materialsBefore, "training does not eat stone");
    assert.ok(kingdom.log.some((entry) => entry.text.includes("entered training")));

    const fill = openRecruitment(district, 7);
    assert.equal(fill.trainingQueue, POPULATION_DEFAULTS.trainingQueueCapacity);
    assert.throws(() => openRecruitment(district, 1), /training queue holds 0 more recruit/);

    // An unaffordable levy is refused in full.
    const poor = headOf(createInitialKingdom());
    poor.reserves = { food: 5, materials: 100, supplies: 5 };
    assert.throws(
        () => openRecruitment(poor, 12),
        (error) => /cannot equip 12 recruit\(s\)/.test(error.message) && /food 5 < 72/.test(error.message)
            && /supplies 5 < 36/.test(error.message),
    );
    assert.deepEqual(poor.reserves, { food: 5, materials: 100, supplies: 5 });
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("recruitment is suspended while the district is in an emergency", () => {
    for (const security of ["alert", "contested", "breached", "isolated", "lost"]) {
        const kingdom = createInitialKingdom();
        const district = headOf(kingdom);
        district.security = security;
        const snapshot = JSON.stringify(district);
        assert.throws(
            () => openRecruitment(district, 3),
            (error) => /recruitment is suspended in Hearthgate/.test(error.message)
                && new RegExp(`security is '${security}'`).test(error.message),
        );
        assert.equal(JSON.stringify(district), snapshot);
        const view = describeRecruitment(kingdom).find((row) => row.districtId === district.id);
        assert.equal(view.open, false);
        assert.match(view.reason, new RegExp(`security '${security}' may not enlist`));
    }

    const kingdom = createInitialKingdom();
    const district = headOf(kingdom);
    assert.throws(
        () => openRecruitment(district, 2, { emergency: true, reason: "the gate is breached" }),
        /recruitment is suspended in Hearthgate - emergency: the gate is breached/,
    );
    assert.equal(district.trainingQueue, 0);
    assert.deepEqual(POPULATION_DEFAULTS.recruitmentAllowedSecurity, ["secure"]);
});

test("training discharges recruits into the garrison with an exact front/reserve split", () => {
    const kingdom = createInitialKingdom();
    const district = headOf(kingdom);
    openRecruitment(district, 12);
    assert.equal(district.buildings.barracks, DISTRICT_DEFAULTS.barracksPerDistrict);

    const throughput = district.buildings.barracks * POPULATION_DEFAULTS.recruitsPerStepPerBarracks;
    assert.equal(throughput, 0.25, "one barracks turns out a trained soldier every four steps");

    for (let step = 1; step <= 3; step += 1) {
        kingdom.step = step;
        const result = advanceTraining(kingdom, district);
        assert.equal(result.graduated, 0);
        assert.match(result.reason, /% of the way to the next recruit/);
        assert.equal(district.trainingQueue, 12);
        assert.equal(district.soldiers, 30);
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
    }

    kingdom.step = 4;
    const graduated = advanceTraining(kingdom, district);
    assert.equal(graduated.graduated, 1);
    assert.equal(district.trainingQueue, 11);
    assert.equal(district.soldiers, 31);
    assert.deepEqual(district.garrison, { front: Math.floor(31 * DISTRICT_DEFAULTS.frontGarrisonFraction), reserve: 31 - Math.floor(31 * DISTRICT_DEFAULTS.frontGarrisonFraction) });
    assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
    assert.deepEqual(findValidationProblems(kingdom), []);

    for (let step = 5; step <= 12; step += 1) {
        kingdom.step = step;
        advanceTraining(kingdom, district);
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
    }
    assert.equal(district.trainingQueue, 9);
    assert.equal(district.soldiers, 33);

    // An empty queue is a no-op with a reason, not an error.
    district.trainingQueue = 0;
    const idle = advanceTraining(kingdom, district);
    assert.equal(idle.graduated, 0);
    assert.match(idle.reason, /no recruits in the training queue/);
    assert.equal(district.trainingBuffer, 0);

    // No barracks means the recruits wait, and the numbers stay exact.
    district.trainingQueue = 2;
    district.buildings.barracks = 0;
    const blocked = advanceTraining(kingdom, district);
    assert.match(blocked.reason, /no barracks/);
    assert.equal(district.trainingQueue, 2);
    assert.equal(district.soldiers, 33);

    assert.throws(() => advanceTraining(kingdom, { id: "district-99" }), /not part of this kingdom/);
    assert.throws(() => advanceTraining(kingdom, null), /district must be an object/);
});

test("civilians + trainingQueue + soldiers is conserved across 200 bounded steps", () => {
    const kingdom = createInitialKingdom();
    const baseline = new Map(kingdom.districts.map((district) => [district.id, peopleOf(district)]));
    assert.deepEqual([...baseline.values()], [110, 110, 110, 110, 110]);

    let enlisted = 0;
    let graduated = 0;
    for (let step = 0; step < 200; step += 1) {
        kingdom.step = step;
        kingdom.districts.forEach((district) => {
            district.reserves = { food: 900, materials: 900, supplies: 900 };
        });
        for (const district of kingdom.districts) {
            try {
                const levy = openRecruitment(district, 3, { kingdom });
                enlisted += levy.recruits;
            } catch (error) {
                // A full queue or a spent-out district is expected; the error is the contract.
                assert.match(error.message, /training queue holds|civilians are free|cannot equip/);
            }
            graduated += advanceTraining(kingdom, district).graduated;

            assert.equal(peopleOf(district), baseline.get(district.id), `${district.id} lost or invented people at step ${String(step)}`);
            assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
            assert.ok(district.civilians >= 0 && district.trainingQueue >= 0 && district.soldiers >= 0);
            assert.ok(district.trainingQueue <= POPULATION_DEFAULTS.trainingQueueCapacity);
            assert.ok(district.builders <= district.civilians);
            assert.ok(district.reserves.food >= 0);
        }
    }

    assert.ok(enlisted > 0 && graduated > 0, "the loop actually recruited and graduated people");
    const queueTotal = kingdom.districts.reduce((sum, district) => sum + district.trainingQueue, 0);
    const totals = computeTotals(kingdom);
    assert.equal(totals.civilians + queueTotal + totals.soldiers, 550);
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("a mixed 120-step campaign always leaves a valid kingdom", () => {
    const kingdom = createInitialKingdom();
    for (let step = 1; step <= 120; step += 1) {
        kingdom.step = step;
        const fed = step % 9 !== 0;
        kingdom.districts.forEach((district) => {
            if (!fed) {
                district.reserves.food = 0;
                district.buildings.farms = 0;
            } else if (district.reserves.food < 200) {
                district.reserves.food = 200;
                district.buildings.farms = DISTRICT_DEFAULTS.farmsPerDistrict;
            }
        });
        runPopulationStep(kingdom);

        for (const district of kingdom.districts) {
            district.security = step % 17 === 0 ? "alert" : "secure";
            if (step % 5 === 0) {
                try {
                    openRecruitment(district, 2, { kingdom });
                } catch (error) {
                    assert.match(error.message, /recruitment is suspended|civilians are free|training queue holds|cannot equip/);
                }
            }
            advanceTraining(kingdom, district);

            assert.ok(Number.isInteger(district.civilians) && district.civilians >= 0);
            assert.ok(Number.isInteger(district.trainingQueue) && district.trainingQueue >= 0);
            assert.ok(Number.isInteger(district.soldiers) && district.soldiers >= 0);
            assert.ok(Number.isInteger(district.garrison.front) && Number.isInteger(district.garrison.reserve));
            assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
            assert.ok(district.civilians <= district.civilianCapacity, `step ${String(step)} passed the ceiling`);
            for (const field of ["food", "materials", "supplies"]) {
                assert.ok(district.reserves[field] >= 0, `${field} went negative at step ${String(step)}`);
            }
        }
        assert.deepEqual(findValidationProblems(kingdom), [], `step ${String(step)}`);
    }
    assert.ok(kingdom.log.length <= config.SIM.eventLogLimit, "the saved log stays bounded");
});

test("syncGarrison repairs the split without inventing or losing soldiers", () => {
    const district = headOf(createInitialKingdom());
    district.soldiers = 0;
    assert.deepEqual(syncGarrison(district), { front: 0, reserve: 0 });
    district.soldiers = 7;
    const split = syncGarrison(district);
    assert.equal(split.front, Math.floor(7 * DISTRICT_DEFAULTS.frontGarrisonFraction));
    assert.equal(split.front + split.reserve, 7);
    district.soldiers = 30;
    syncGarrison(district);
    assert.deepEqual(district.garrison, { front: 24, reserve: 6 });
});

test("the same seed replays the same kingdom and a different seed diverges", () => {
    const replay = (cursor, steps) => {
        const kingdom = createInitialKingdom();
        kingdom.rngState = cursor;
        for (let step = 1; step <= steps; step += 1) {
            kingdom.step = step;
            runPopulationStep(kingdom);
            kingdom.districts.forEach((district) => advanceTraining(kingdom, district));
        }
        /** @type {any} */
        const snapshot = JSON.parse(JSON.stringify(kingdom));
        delete snapshot.rngState;
        return snapshot;
    };

    assert.deepEqual(replay(4242, 200), replay(4242, 200), "fixed seed, fixed steps, one exact kingdom");
    assert.deepEqual(replay(1, 200), replay(1, 200));
    assert.notDeepEqual(replay(4242, 30), replay(9999, 30), "a different seed must not replay the same history");

    // The advanced cursor is written back, which is what makes the replay exact.
    const kingdom = createInitialKingdom();
    const cursor = kingdom.rngState;
    runPopulationStep(kingdom);
    assert.notEqual(kingdom.rngState, cursor);
    assert.ok(Number.isInteger(kingdom.rngState) && kingdom.rngState >= 0);
});

test("describeRecruitment reports what each district could do right now", () => {
    const kingdom = createInitialKingdom();
    kingdom.districts[0].security = "breached";
    openRecruitment(kingdom.districts[1], 4);
    const rows = describeRecruitment(kingdom);
    assert.deepEqual(rows.map((row) => row.districtId), ["district-1", "district-2", "district-3", "district-4", "district-5"]);
    assert.equal(rows[0].open, false);
    assert.equal(rows[1].trainingQueue, 4);
    assert.equal(rows[1].eligible, 72, "80 people, 4 of them already in the queue");
    assert.equal(rows[1].queueRoom, POPULATION_DEFAULTS.trainingQueueCapacity - 4);
    assert.equal(rows[2].open, true);
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows, "plain serialisable view");

    const snapshot = JSON.stringify(kingdom);
    describeRecruitment(kingdom);
    assert.equal(JSON.stringify(kingdom), snapshot);
});

test("PROJECT_TYPES is never edited by the population or construction rules", () => {
    const catalogue = JSON.stringify(PROJECT_TYPES);
    const kingdom = fedKingdom();
    for (let step = 1; step <= 30; step += 1) {
        kingdom.step = step;
        runPopulationStep(kingdom);
        kingdom.districts.forEach((district) => {
            try {
                openRecruitment(district, 4, { kingdom });
            } catch (error) {
                assert.match(error.message, /queue|cannot equip|suspended/);
            }
            advanceTraining(kingdom, district);
        });
    }
    assert.equal(JSON.stringify(config.PROJECT_TYPES), catalogue);
    assert.equal(JSON.stringify(config.DISTRICT_DEFAULTS), JSON.stringify(DISTRICT_DEFAULTS));
});
