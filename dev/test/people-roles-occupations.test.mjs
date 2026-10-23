import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom } = await loadModule("kingdom", "state.js");
const { ROLES, OCCUPATION_RULES, assignOccupations, occupationNeeds, occupationProblems } = await loadModule("people", "occupations.js");

/**
 * A district record in the shape the simulation saves, with the counts overridden by the test.
 * @param {Record<string, any>} [overrides]
 */
function districtWith(overrides = {}) {
    const district = createInitialKingdom().districts[0];
    return { ...district, buildings: { ...district.buildings }, reserves: { ...district.reserves }, ...overrides };
}

test("the starting district fills every post it can and leaves the rest idle", () => {
    const result = assignOccupations(districtWith());
    assert.deepEqual(occupationProblems(result), []);
    assert.equal(result.total, 80);
    assert.equal(result.roles.child, 20, "a quarter of 80 are children");
    assert.equal(result.roles.elder, 8, "a tenth of 80 are elders");
    assert.equal(result.roles.farmer, 12, "4 farms x 3 crew");
    assert.equal(result.roles.worker, 6, "3 storehouses x 2 workers");
    assert.equal(result.roles.smith, 4, "3 storehouses x 1 smith + 1 barracks armourer");
    assert.equal(result.roles.guard, 3, "1 wall x 2 + 1 barracks x 1");
    assert.equal(result.roles.none, 27, "the adults left over are idle");
    assert.deepEqual(result.unfilled, []);
    assert.equal(result.roster.length, 80);
});

test("farmers never exceed farm capacity, whatever the population", () => {
    for (let farms = 0; farms <= 6; farms += 1) {
        for (const civilians of [0, 1, 9, 40, 80, 200, 400]) {
            const district = districtWith({ civilians, buildings: { ...districtWith().buildings, farms } });
            const result = assignOccupations(district);
            assert.deepEqual(occupationProblems(result), [], `farms ${String(farms)}, civilians ${String(civilians)}`);
            assert.ok(result.roles.farmer <= farms * OCCUPATION_RULES.farmCrewPerFarm, `farmers ${String(result.roles.farmer)} over capacity`);
            assert.equal(result.needs.farmer.capacity, farms * OCCUPATION_RULES.farmCrewPerFarm);
        }
    }
});

test("every person is assigned exactly once: roles add up to the civilian pool", () => {
    for (const civilians of [0, 1, 2, 3, 7, 13, 80, 121, 400]) {
        for (const builders of [0, 3, 50]) {
            const result = assignOccupations(districtWith({ civilians, builders }));
            const total = ROLES.reduce((sum, role) => sum + result.roles[role], 0);
            assert.equal(total, civilians, `civilians ${String(civilians)} builders ${String(builders)}`);
            assert.deepEqual(occupationProblems(result), []);
        }
    }
});

test("builders are reserved first and show up as the builder role, not as idle people", () => {
    const result = assignOccupations(districtWith({ builders: 6 }));
    assert.equal(result.roles.builder, 6);
    assert.equal(result.roles.none, 21, "6 fewer idle adults than the no-builder case");
});

test("under threat guards are filled before farmers, otherwise farmers come first", () => {
    const calm = assignOccupations(districtWith({ civilians: 12, security: "secure" }));
    const threat = assignOccupations(districtWith({ civilians: 12, security: "breached" }));
    assert.deepEqual(calm.priority, ["farmer", "guard", "worker", "smith"]);
    assert.deepEqual(threat.priority, ["guard", "farmer", "worker", "smith"]);
    assert.equal(threat.threat, true);
    assert.ok(threat.roles.guard >= calm.roles.guard, "threat never reduces guards");
});

test("a short district reports each unfilled post with the count it is missing", () => {
    const result = assignOccupations(districtWith({ civilians: 10 }));
    assert.deepEqual(occupationProblems(result), []);
    const missing = result.unfilled.reduce((sum, entry) => sum + entry.count, 0);
    const wanted = result.needs.farmer.need + result.needs.guard.need + result.needs.worker.need + result.needs.smith.need;
    assert.equal(missing + result.roles.farmer + result.roles.guard + result.roles.worker + result.roles.smith, wanted);
    assert.ok(result.unfilled.length > 0, "10 people cannot staff 25 posts");
    assert.equal(result.reason, "some posts are unfilled");
});

test("a district with no buildings needs no one and every adult is idle", () => {
    const buildings = { homes: 0, farms: 0, storehouses: 0, barracks: 0, walls: 0 };
    const result = assignOccupations(districtWith({ buildings }));
    assert.deepEqual(occupationNeeds({ buildings }).farmer, { need: 0, capacity: 0 });
    assert.equal(result.roles.none, 52);
    assert.deepEqual(result.unfilled, []);
});

test("assignments are deterministic and do not mutate the district record", () => {
    const district = districtWith({ civilians: 77, builders: 4, security: "alert" });
    const before = JSON.stringify(district);
    const first = JSON.stringify(assignOccupations(district));
    assert.equal(JSON.stringify(district), before, "input must not change");
    assert.equal(JSON.stringify(assignOccupations(district)), first);
});

test("the roster names one role per person in role order, with stable slot numbers", () => {
    const result = assignOccupations(districtWith({ civilians: 30 }));
    assert.deepEqual(result.roster.map((entry) => entry.slot), Array.from({ length: 30 }, (_unused, index) => index));
    const counted = {};
    for (const entry of result.roster) {
        counted[entry.role] = (counted[entry.role] ?? 0) + 1;
    }
    for (const role of ROLES) {
        assert.equal(counted[role] ?? 0, result.roles[role], `roster count for ${role}`);
    }
});

test("a lost district is not assigned anybody", () => {
    const result = assignOccupations(districtWith({ security: "lost" }));
    assert.equal(result.lost, true);
    assert.equal(result.total, 0);
    assert.deepEqual(result.roster, []);
    for (const role of ROLES) {
        assert.equal(result.roles[role], 0, `${role} in a lost district`);
    }
});
