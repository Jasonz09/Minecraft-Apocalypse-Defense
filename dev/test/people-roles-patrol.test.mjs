import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom } = await loadModule("kingdom", "state.js");
const { PATROL_RULES, coverageOverCycle, defaultWallSections, planPatrols, wallCircuit } = await loadModule("people", "patrols.js");

/**
 * A district record with the garrison and gates set by the test.
 * @param {{ front?: number, reserve?: number, gates?: number, security?: string }} [options]
 */
function districtWith({ front = 24, reserve = 6, gates = 2, security = "secure" } = {}) {
    const base = createInitialKingdom().districts[0];
    const gateList = Array.from({ length: gates }, (_unused, index) => ({ id: `gate-${String(index + 1)}`, with: `other-${String(index + 1)}`, owner: base.id, state: "open" }));
    return { ...base, security, soldiers: front + reserve, garrison: { front, reserve }, gates: gateList };
}

test("the starting district has six patrol groups covering all eight wall sections", () => {
    const plan = planPatrols(districtWith());
    assert.equal(plan.groupCount, 6, "24 front soldiers in groups of 4");
    assert.equal(plan.sections.length, PATROL_RULES.sectionsPerDistrict);
    assert.deepEqual(plan.uncovered, []);
    assert.deepEqual(plan.covered, plan.sections);
    assert.equal(plan.cycleSteps, 6 * PATROL_RULES.rotationSteps);
    assert.equal(plan.groups.reduce((sum, group) => sum + group.soldiers, 0), 24, "every front soldier is on a patrol");
});

test("every wall section is watched at every step, for a range of garrisons, gate counts and section counts", () => {
    for (const front of [1, 3, 4, 7, 8, 13, 24, 40, 100]) {
        for (const gates of [0, 1, 2, 4, 5]) {
            for (const sections of [3, 5, 8, 12]) {
                const district = districtWith({ front, reserve: 2, gates });
                for (let step = 0; step < 30; step += 1) {
                    const plan = planPatrols(district, { step, sectionCount: sections });
                    assert.deepEqual(plan.uncovered, [], `front ${String(front)} gates ${String(gates)} sections ${String(sections)} step ${String(step)}`);
                    assert.equal(plan.groups.reduce((sum, group) => sum + group.soldiers, 0), front, "soldiers on patrol equal the front");
                    assert.ok(plan.groups.every((group) => group.soldiers >= 1), "no empty patrol group");
                }
            }
        }
    }
});

test("over one rotation cycle every group walks every sector and every section is watched", () => {
    const district = districtWith({ front: 24 });
    const cover = coverageOverCycle(district, { startStep: 0 });
    assert.equal(cover.cycleSteps, 24);
    assert.equal(cover.uncoveredSteps, 0);
    for (const [group, sectors] of Object.entries(cover.sectorsVisited)) {
        assert.equal(sectors, 6, `${group} visits every sector once per cycle`);
    }
    for (const [section, watches] of Object.entries(cover.watches)) {
        assert.ok(watches >= 1, `${section} is watched during the cycle`);
    }
});

test("the cycle is still complete when it starts mid-rotation", () => {
    const district = districtWith({ front: 16 });
    for (const startStep of [1, 2, 3, 5, 11, 23]) {
        const cover = coverageOverCycle(district, { startStep });
        assert.equal(cover.uncoveredSteps, 0, `start ${String(startStep)}`);
        for (const [section, watches] of Object.entries(cover.watches)) {
            assert.ok(watches >= 1, `${section} watched from start ${String(startStep)}`);
        }
    }
});

test("groups rotate: the same group is on a different sector after a rotation step", () => {
    const district = districtWith({ front: 24 });
    const first = planPatrols(district, { step: 0 });
    const later = planPatrols(district, { step: PATROL_RULES.rotationSteps });
    assert.equal(first.groups[0].sector, 0);
    assert.equal(later.groups[0].sector, 1, "group 1 moves to the next sector after one rotation");
    assert.equal(later.groups[0].sector === first.groups[0].sector, false);
    const sectorsAtStep = new Set(later.groups.map((group) => group.sector));
    assert.equal(sectorsAtStep.size, later.groupCount, "one group per sector at any step");
});

test("a route is an ordered list of gate and wall-section ids, with each gate just before its section", () => {
    const district = districtWith({ front: 24, gates: 2 });
    const circuit = wallCircuit(district);
    const ids = circuit.map((item) => item.id);
    assert.equal(ids.length, PATROL_RULES.sectionsPerDistrict + 2, "eight sections and two gates");
    assert.ok(ids.indexOf("gate-1") < ids.indexOf(defaultWallSections(district.id)[0]), "gate 1 sits on section 1");
    assert.ok(ids.indexOf("gate-2") < ids.indexOf(defaultWallSections(district.id)[4]), "gate 2 sits halfway round");
    const plan = planPatrols(district, { step: 0 });
    for (const group of plan.groups) {
        for (const id of group.route) {
            assert.ok(ids.includes(id), `${id} is a real circuit stop`);
        }
    }
});

test("supplied section ids are used as given, in the order given", () => {
    const sections = ["north-wall", "north-gate-tower", "east-wall", "south-wall"];
    const plan = planPatrols(districtWith({ front: 8, gates: 1 }), { step: 0, wallSections: sections });
    assert.deepEqual(plan.sections, sections);
    assert.deepEqual(plan.uncovered, []);
    assert.throws(() => planPatrols(districtWith({ front: 8 }), { wallSections: ["a", "a"] }), /more than once/);
});

test("no front garrison means nobody walks the wall and every section is reported uncovered", () => {
    const plan = planPatrols(districtWith({ front: 0, reserve: 30 }));
    assert.equal(plan.groupCount, 0);
    assert.deepEqual(plan.groups, []);
    assert.deepEqual(plan.uncovered, plan.sections);
    assert.match(plan.reason, /no front garrison/);
});

test("patrols are deterministic and never mutate the district", () => {
    const district = districtWith({ front: 13, gates: 3 });
    const before = JSON.stringify(district);
    const first = JSON.stringify(planPatrols(district, { step: 42 }));
    assert.equal(JSON.stringify(district), before);
    assert.equal(JSON.stringify(planPatrols(district, { step: 42 })), first);
});
