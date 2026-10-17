import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const { createInitialKingdom, districtById, findValidationProblems } = await loadModule("kingdom", "state.js");
const war = await loadModule("sim", "war.js");

/**
 * @param {any} kingdom
 * @param {any} district
 */
function oneStep(kingdom, district) {
    const events = war.updateFallback(kingdom, district);
    war.assignDefenders(district);
    return events;
}

test("a district that is holding its line keeps the standard split", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    district.assault = 0;
    oneStep(kingdom, district);
    assert.equal(district.fallback, undefined, "no fallback state should exist when nothing is giving ground");
    assert.equal(district.garrison.front, Math.floor(district.soldiers * config.DISTRICT_DEFAULTS.frontGarrisonFraction));
    assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
});

test("an overwhelming attack draws troops back gradually, not all at once", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-4");
    district.assault = 90;

    const fronts = [];
    for (let step = 0; step < 6; step += 1) {
        oneStep(kingdom, district);
        fronts.push(district.garrison.front);
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers, `step ${String(step)} broke the garrison sum`);
        assert.ok(district.garrison.reserve > 0, `step ${String(step)} kept nothing in depth`);
    }

    assert.ok(fronts[1] < fronts[0], `the wall was never thinned: ${JSON.stringify(fronts)}`);
    assert.ok(fronts[5] > 0, `the wall was emptied completely: ${JSON.stringify(fronts)}`);
    assert.ok(
        fronts[0] - fronts[5] < district.soldiers * 0.9,
        `the whole garrison quit the wall in six steps: ${JSON.stringify(fronts)}`,
    );
    assert.ok(district.fallback.pullback > 0 && district.fallback.pullback <= war.FALLBACK_RULES.maxPullback);
});

test("fallback never abandons the wall, however long the siege lasts", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-2");
    district.assault = 200;

    for (let step = 0; step < 40; step += 1) {
        oneStep(kingdom, district);
        assert.ok(district.garrison.front >= 1, `step ${String(step)} left nobody on the wall`);
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
        assert.equal(district.civilians, 80, "fallback must not move population - that is evacuation's job");
        assert.ok(district.buildings.walls >= config.DISTRICT_DEFAULTS.wallsPerDistrict, "fallback must not demolish walls");
    }
    assert.equal(district.fallback.pullback, war.FALLBACK_RULES.maxPullback, "pullback should have clamped at its ceiling");
});

test("when the attack spends itself the garrison closes back gradually", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-3");
    district.assault = 90;
    for (let step = 0; step < 4; step += 1) {
        oneStep(kingdom, district);
    }
    const contracted = district.garrison.front;
    assert.ok(contracted < Math.floor(district.soldiers * config.DISTRICT_DEFAULTS.frontGarrisonFraction));

    district.assault = 0;
    const recovered = [];
    for (let step = 0; step < 12; step += 1) {
        oneStep(kingdom, district);
        recovered.push(district.garrison.front);
    }
    assert.ok(recovered[0] > contracted, "the line should start closing back toward the wall");
    assert.ok(
        recovered.every((value, index) => index === 0 || value >= recovered[index - 1]),
        `the return to the wall should be monotonic: ${JSON.stringify(recovered)}`,
    );
    assert.equal(
        district.garrison.front,
        Math.floor(district.soldiers * config.DISTRICT_DEFAULTS.frontGarrisonFraction),
        "a recovered district should end at the standard split",
    );
});

test("fallback runs inside the war step and stays savable", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-5");
    district.assault = 70;
    district.security = "contested";

    for (let step = 0; step < 25; step += 1) {
        war.runWarStep(kingdom);
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers, `step ${String(step)}`);
        assert.deepEqual(findValidationProblems(kingdom), [], `step ${String(step)} became unsavable`);
    }
});

test("fallback decisions are deterministic", () => {
    const replay = () => {
        const kingdom = createInitialKingdom();
        const district = districtById(kingdom, "district-1");
        district.assault = 55;
        for (let step = 0; step < 8; step += 1) {
            oneStep(kingdom, district);
        }
        return JSON.stringify(district.garrison) + JSON.stringify(district.fallback);
    };
    assert.equal(replay(), replay());
});

test("an empty district cannot fall back", () => {
    const kingdom = createInitialKingdom();
    const district = districtById(kingdom, "district-1");
    district.soldiers = 0;
    district.garrison = { front: 0, reserve: 0 };
    district.assault = 50;
    assert.deepEqual(oneStep(kingdom, district), []);
    assert.equal(district.fallback, undefined);
    assert.equal(district.garrison.front, 0);
});
