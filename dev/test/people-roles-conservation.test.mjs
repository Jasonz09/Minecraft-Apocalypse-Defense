import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, districtById } = await loadModule("kingdom", "state.js");
const population = await loadModule("sim", "population.js");
const transport = await loadModule("people", "transport.js");
const equipment = await loadModule("people", "equipment.js");
const support = await loadModule("people", "support.js");
const training = await loadModule("people", "training.js");

const EPS = 1e-9;

/**
 * @param {Record<string, any>} [reserves]
 * @param {Record<string, any>} [overrides]
 */
function districtWith(reserves = {}, overrides = {}) {
    const base = createInitialKingdom().districts[0];
    return {
        ...base,
        buildings: { ...base.buildings },
        reserves: { ...base.reserves, ...reserves },
        ...overrides,
    };
}

test("hauling food never creates food: the field, store and delivered pools keep their total", () => {
    for (const food of [0, 0.5, 3, 20, 240, 700]) {
        for (const farms of [0, 1, 4, 9]) {
            for (const storehouses of [0, 1, 3]) {
                for (const civilians of [0, 40, 120]) {
                    const district = districtWith({ food }, { civilians, buildings: { ...createInitialKingdom().districts[0].buildings, farms, storehouses } });
                    const plan = transport.planHaulJobs(district);
                    const conservation = transport.haulConservation(plan);
                    assert.ok(Math.abs(conservation.delta) < EPS, `food ${String(food)} farms ${String(farms)} stores ${String(storehouses)}: delta ${String(conservation.delta)}`);
                    const farmToStore = plan.jobs.filter((job) => job.kind === "farm-to-storehouse").reduce((sum, job) => sum + job.amount, 0);
                    assert.ok(farmToStore <= plan.nominal.farmOutput + EPS, "no more food is hauled from the fields than the farms yield this step");
                    const delivered = plan.jobs.filter((job) => job.kind === "storehouse-to-consumer").reduce((sum, job) => sum + job.amount, 0);
                    assert.ok(delivered <= plan.nominal.demand + EPS, "consumers are not delivered more than they need");
                    assert.ok(delivered <= food + farmToStore + EPS, "consumers are not delivered food that does not exist");
                    assert.ok(plan.ledger.after.store >= -EPS && plan.ledger.after.field >= -EPS, "no pool goes negative");
                }
            }
        }
    }
});

test("a haul plan leaves the simulation's food accounting exactly where it would have been", () => {
    const planned = createInitialKingdom();
    const unplanned = createInitialKingdom();
    for (const district of planned.districts) {
        transport.planHaulJobs(district);
    }
    const withPlan = population.runPopulationStep(planned, { pushEvents: false });
    const withoutPlan = population.runPopulationStep(unplanned, { pushEvents: false });
    assert.deepEqual(withPlan, withoutPlan, "population report");
    assert.deepEqual(planned.districts, unplanned.districts, "district records after the step");
});

test("applying a plan conserves food and refuses an impossible job instead of hiding it", () => {
    const district = districtWith({ food: 10 });
    const plan = transport.planHaulJobs(district);
    const replayed = transport.applyHaulPlan(plan.ledger.before, plan.jobs);
    assert.deepEqual(replayed, plan.ledger.after);
    assert.throws(
        () => transport.applyHaulPlan({ field: 0, store: 0, delivered: 0 }, [{ id: "bad", kind: "storehouse-to-consumer", resource: "food", amount: 1, from: "a", to: "b" }]),
        /would take a pool negative/,
    );
    assert.throws(() => transport.applyHaulPlan({ field: 5, store: 5, delivered: 0 }, [{ id: "zero", kind: "farm-to-storehouse", resource: "food", amount: 0, from: "a", to: "b" }]), /carries 0/);
});

test("equipment consumes materials and supplies exactly as declared and never drives a store negative", () => {
    for (const materials of [0, 3, 12, 60, 180, 900]) {
        for (const supplies of [0, 2, 9, 120]) {
            for (const barracks of [0, 1, 2, 3]) {
                const base = createInitialKingdom().districts[0];
                const district = districtWith({ materials, supplies }, { soldiers: 30, buildings: { ...base.buildings, barracks } });
                const plan = equipment.planEquipment(district);
                const spentMaterials = Math.round((materials - plan.reserves.after.materials) * 100) / 100;
                const spentSupplies = Math.round((supplies - plan.reserves.after.supplies) * 100) / 100;
                assert.equal(spentMaterials, plan.spent.materials ?? 0, `materials spend, stock ${String(materials)}`);
                assert.equal(spentSupplies, plan.spent.supplies ?? 0, `supplies spend, stock ${String(supplies)}`);
                assert.ok(plan.reserves.after.materials >= 0 && plan.reserves.after.supplies >= 0, "stores never negative");
                assert.ok(spentMaterials <= materials * equipment.EQUIPMENT_RULES.maxStockShare + EPS, "at most the declared share of materials per step");
                assert.ok(spentSupplies <= supplies * equipment.EQUIPMENT_RULES.maxStockShare + EPS, "at most the declared share of supplies per step");
                const soldiersAfter = Object.values(plan.after).reduce((sum, value) => sum + value, 0);
                assert.equal(soldiersAfter, 30, "equipment never creates or loses a soldier");
            }
        }
    }
});

test("equipment upgrades cost what the tier table says, one soldier at a time, lowest tier first", () => {
    const base = createInitialKingdom().districts[0];
    const district = districtWith({ materials: 180, supplies: 120 }, { soldiers: 30, buildings: { ...base.buildings, barracks: 2 } });
    const recorded = { 0: 4, 1: 26, 2: 0, 3: 0 };
    const plan = equipment.planEquipment(district, recorded);
    assert.equal(plan.throughput, 2, "two barracks equip two soldiers a step");
    assert.deepEqual(plan.upgrades.map((step) => [step.from, step.to, step.count]), [[0, 1, 2]], "militia are issued the kit first");
    assert.deepEqual(plan.spent, { supplies: 4 }, "two issues at two supplies each");
});

test("equipment tier records must add up to the soldiers they describe", () => {
    const district = districtWith({}, { soldiers: 30 });
    assert.throws(() => equipment.tierCounts(district, { 1: 29 }), /records 29 equipped soldier\(s\) but has 30/);
    assert.throws(() => equipment.tierCounts(district, { 1: -1, 2: 31 }), /non-negative whole number/);
    assert.throws(() => equipment.tierCounts(district, { 9: 30 }), /unknown tier/);
});

test("support units spend stores when they are made, and the spend never goes negative", () => {
    const district = districtWith({ materials: 31, supplies: 9, food: 5 });
    const budget = support.spawnBudget(district, { golems: 0, wolves: 0 }, 0);
    assert.equal(budget.golems, 1);
    assert.equal(budget.wolves, 0, "supplies left after the golem cannot pay for a wolf");
    const after = support.spendSupport(district.reserves, budget.cost);
    assert.deepEqual(after, { materials: 1, supplies: 3, food: 5 });
    assert.throws(() => support.spendSupport({ materials: 1, supplies: 0, food: 0 }, { materials: 2 }), /would go negative/);
});

test("wolves add their food demand only as a declared per-wolf figure", () => {
    assert.equal(support.wolfFoodDemand({ wolves: 0 }), 0);
    assert.equal(support.wolfFoodDemand({ wolves: 2 }), 0.06);
});

test("the training projection matches population.advanceTraining exactly over a grid of states", () => {
    const base = createInitialKingdom().districts[0];
    for (const queue of [0, 1, 2, 5, 12]) {
        for (const barracks of [0, 1, 2, 3]) {
            for (const buffer of [0, 0.1, 0.5, 0.99, 1, 1.2, 2.7]) {
                for (const security of ["secure", "lost"]) {
                    const district = { ...base, buildings: { ...base.buildings, barracks }, trainingQueue: queue, trainingBuffer: buffer, security, garrison: { ...base.garrison } };
                    const projected = training.projectTraining(district);
                    const real = structuredClone(district);
                    const result = population.advanceTraining(undefined, real);
                    const label = `queue ${String(queue)} barracks ${String(barracks)} buffer ${String(buffer)} ${security}`;
                    if (security === "lost") {
                        assert.equal(projected.graduated, 0, label);
                        continue;
                    }
                    assert.equal(projected.graduated, result.graduated, `graduates: ${label}`);
                    assert.equal(projected.soldiersAfter, real.soldiers, `soldiers: ${label}`);
                    assert.equal(projected.queueAfter, real.trainingQueue, `queue: ${label}`);
                    assert.equal(projected.bufferAfter, real.trainingBuffer, `buffer: ${label}`);
                    assert.ok(projected.graduated <= queue, "a soldier only comes from the queue");
                }
            }
        }
    }
});

test("training never mutates the district it projects", () => {
    const district = districtWith({}, { trainingQueue: 4, trainingBuffer: 0.5 });
    const before = JSON.stringify(district);
    training.projectTraining(district);
    assert.equal(JSON.stringify(district), before);
    assert.equal(districtById({ districts: [district] }, district.id), district);
});
