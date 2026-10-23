import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, computeTotals } = await loadModule("kingdom", "state.js");
const { advanceKingdom } = await loadModule("sim", "tick.js");
const occupations = await loadModule("people", "occupations.js");
const routines = await loadModule("people", "routines.js");
const transport = await loadModule("people", "transport.js");
const patrols = await loadModule("people", "patrols.js");
const training = await loadModule("people", "training.js");
const command = await loadModule("people", "command.js");
const equipment = await loadModule("people", "equipment.js");
const support = await loadModule("people", "support.js");

/**
 * A kingdom where district-2 has fallen, with everything that would otherwise make work present:
 * a training queue, a stocked store, a barracks, soldiers, an open assault and a support record.
 */
function kingdomWithLostDistrict() {
    const kingdom = createInitialKingdom();
    const fallen = kingdom.districts[1];
    fallen.security = "lost";
    fallen.assault = 20;
    fallen.trainingQueue = 6;
    fallen.trainingBuffer = 0.5;
    fallen.reserves = { food: 400, materials: 400, supplies: 400 };
    return { kingdom, fallen };
}

test("a lost district produces no visible behaviour from any module", () => {
    const { fallen } = kingdomWithLostDistrict();
    const supportRecord = { golems: 2, wolves: 3, lastGolemStep: 0, lastWolfStep: 0 };
    assert.equal(occupations.assignOccupations(fallen).total, 0);
    assert.deepEqual(occupations.assignOccupations(fallen).roster, []);
    for (const role of occupations.ROLES) {
        assert.equal(routines.locationAt({ step: 9, role, security: fallen.security }).location, null, `${role} has no routine`);
    }
    assert.equal(transport.planHaulJobs(fallen).jobs.length, 0);
    assert.equal(patrols.planPatrols(fallen).groups.length, 0);
    assert.equal(training.projectTraining(fallen).graduated, 0);
    assert.equal(command.assignCommanders(fallen).total, 0);
    assert.equal(equipment.planEquipment(fallen).upgrades.length, 0);
    assert.equal(support.spawnBudget(fallen, supportRecord, 40).golems, 0);
    assert.equal(support.spawnBudget(fallen, supportRecord, 40).wolves, 0);
    assert.deepEqual(support.supportCaps(fallen), { golems: 0, wolves: 0 });
    const engaged = support.engageSupport(fallen, supportRecord, { rngState: 5 });
    assert.equal(engaged.engaged.golems + engaged.engaged.wolves, 0);
    assert.equal(engaged.supportStrength, 0);
});

test("none of the planners change a lost district's record", () => {
    const { fallen } = kingdomWithLostDistrict();
    const before = JSON.stringify(fallen);
    occupations.assignOccupations(fallen);
    routines.dailySchedule("farmer", fallen.security);
    transport.planHaulJobs(fallen);
    patrols.planPatrols(fallen, { step: 3 });
    training.projectTraining(fallen);
    command.assignCommanders(fallen, { existing: [{ id: "district-2:cmd-1", districtId: "district-2", post: "front" }] });
    equipment.planEquipment(fallen, { 1: 30 });
    support.spawnBudget(fallen, { golems: 0, wolves: 0 }, 1);
    support.engageSupport(fallen, { golems: 1, wolves: 1 }, { rngState: 1 });
    assert.equal(JSON.stringify(fallen), before, "the lost district is untouched by every planner");
});

test("inside a real simulation run, a district that is lost before a step keeps every planner silent", () => {
    const { kingdom } = kingdomWithLostDistrict();
    const fallen = kingdom.districts[1];
    let checkedSteps = 0;
    for (let step = 0; step < 24; step += 1) {
        // The war model restores a raided district within a step or two, so the lost state is set again before
        // each step; the planners are then checked on exactly the state the step starts from.
        fallen.security = "lost";
        assert.equal(occupations.assignOccupations(fallen).total, 0, `step ${String(step)}: no people`);
        assert.equal(transport.planHaulJobs(fallen).jobs.length, 0, `step ${String(step)}: no haul`);
        assert.equal(patrols.planPatrols(fallen).groups.length, 0, `step ${String(step)}: no patrol`);
        assert.equal(training.projectTraining(fallen).graduated, 0, `step ${String(step)}: no graduates`);
        assert.equal(command.assignCommanders(fallen).total, 0, `step ${String(step)}: no commanders`);
        assert.equal(equipment.planEquipment(fallen, null).upgrades.length, 0, `step ${String(step)}: no equipment`);
        const report = advanceKingdom(kingdom, 1);
        assert.equal(report.rejected.length, 0, "the simulation accepts the state");
        checkedSteps += 1;
    }
    assert.equal(checkedSteps, 24);
    const neighbour = kingdom.districts[0];
    assert.ok(occupations.assignOccupations(neighbour).total > 0, "a standing district still has people");
    assert.equal(computeTotals(kingdom).districts, 5);
});
