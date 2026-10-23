import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom } = await loadModule("kingdom", "state.js");
const transport = await loadModule("people", "transport.js");
const command = await loadModule("people", "command.js");
const support = await loadModule("people", "support.js");
const equipment = await loadModule("people", "equipment.js");
const patrols = await loadModule("people", "patrols.js");

/**
 * @param {Record<string, any>} [overrides]
 */
function districtWith(overrides = {}) {
    const base = createInitialKingdom().districts[0];
    return { ...base, buildings: { ...base.buildings }, reserves: { ...base.reserves }, ...overrides };
}

test("haul jobs are bounded per district per step, however large the farms and stores", () => {
    const district = districtWith({ reserves: { food: 0, materials: 1, supplies: 1 }, buildings: { ...districtWith().buildings, farms: 50, storehouses: 50 }, civilians: 400 });
    const plan = transport.planHaulJobs(district);
    assert.equal(plan.jobs.length, transport.TRANSPORT_RULES.maxJobsPerDistrictPerStep);
    assert.equal(plan.capped, true, "the plan says it stopped because of the cap");
    assert.ok(plan.jobs.every((job) => job.amount <= transport.TRANSPORT_RULES.carryPerJob + 1e-9), "each job carries at most one load");
    const moved = plan.jobs.reduce((sum, job) => sum + job.amount, 0);
    assert.ok(moved <= plan.cap.maxFoodMoved + 1e-9, `moved ${String(moved)} is over the cap ${String(plan.cap.maxFoodMoved)}`);
});

test("a smaller request for jobs is honoured and never exceeds the global cap", () => {
    const district = districtWith({ buildings: { ...districtWith().buildings, farms: 40, storehouses: 4 } });
    assert.equal(transport.planHaulJobs(district, { maxJobs: 3 }).jobs.length, 3);
    assert.equal(transport.planHaulJobs(district, { maxJobs: 99 }).jobs.length, transport.TRANSPORT_RULES.maxJobsPerDistrictPerStep);
});

test("with no storehouse no farm haul is planned, and the store ceiling is respected", () => {
    const noStore = transport.planHaulJobs(districtWith({ buildings: { ...districtWith().buildings, storehouses: 0 } }));
    assert.equal(noStore.jobs.filter((job) => job.kind === "farm-to-storehouse").length, 0);
    assert.match(noStore.reason, /no storehouse/);

    const full = transport.planHaulJobs(districtWith({ reserves: { food: 750, materials: 0, supplies: 0 } }));
    assert.equal(full.jobs.filter((job) => job.kind === "farm-to-storehouse").length, 0, "a full store takes no more food");
    assert.ok(full.ledger.after.store <= full.nominal.storeCeiling + 1e-9);
});

test("the starting kingdom has one commander block per 10 soldiers, with the count invariant holding for every district", () => {
    const kingdom = createInitialKingdom();
    for (const district of kingdom.districts) {
        const result = command.assignCommanders(district);
        assert.equal(result.state, "ok");
        assert.equal(result.total, 3, "30 soldiers need 3 commanders");
        assert.deepEqual(command.commandProblems(district, result), []);
    }
});

test("commanders equal max(1, floor(soldiers / 10)) for every garrison split from 0 to 80 soldiers", () => {
    for (let soldiers = 0; soldiers <= 80; soldiers += 1) {
        for (const frontShare of [0, 0.5, 0.8, 1]) {
            const front = Math.floor(soldiers * frontShare);
            const reserve = soldiers - front;
            const district = districtWith({ soldiers, garrison: { front, reserve } });
            const result = command.assignCommanders(district);
            const expected = soldiers === 0 ? 0 : Math.max(1, Math.floor(soldiers / command.COMMAND_RULES.soldiersPerCommander));
            assert.equal(result.total, expected, `soldiers ${String(soldiers)} front ${String(front)}`);
            assert.equal(command.commandersFor(soldiers), expected);
            assert.deepEqual(command.commandProblems(district, result), [], `soldiers ${String(soldiers)} front ${String(front)}`);
            assert.equal(result.front + result.reserve, result.total, "every commander has a post");
            if (result.unledReserve > 0) {
                assert.equal(result.total, 1, "an unled reserve only happens with a single commander");
            }
        }
    }
});

test("a commander with no soldiers is an error state, never a silent zero", () => {
    const empty = districtWith({ soldiers: 0, garrison: { front: 0, reserve: 0 } });
    const orphaned = command.assignCommanders(empty, { existing: [{ id: "district-1:cmd-1", districtId: "district-1", post: "front" }] });
    assert.equal(orphaned.state, "error");
    assert.equal(orphaned.commanders[0].error, "commander-without-soldiers");
    assert.match(orphaned.errors[0], /no soldiers/);

    const healthy = command.assignCommanders(districtWith());
    assert.equal(healthy.state, "ok");
    assert.deepEqual(healthy.errors, []);
});

test("a commander filed under another district is an error, not moved silently", () => {
    const result = command.assignCommanders(districtWith(), { existing: [{ id: "district-9:cmd-1", districtId: "district-9", post: "reserve", soldiers: 4 }] });
    assert.equal(result.state, "error");
    assert.equal(result.commanders.find((commander) => commander.id === "district-9:cmd-1").error, "commander-from-another-district");
});

test("a lost district has no command structure and raises no commander errors", () => {
    const result = command.assignCommanders(districtWith({ security: "lost" }), { existing: [{ id: "district-1:cmd-1", districtId: "district-1", post: "front" }] });
    assert.equal(result.total, 0);
    assert.equal(result.state, "ok");
    assert.deepEqual(result.commanders, []);
});

test("support caps come from existing barracks: one golem and two wolves per barracks, and the kingdom holds five golems and ten wolves", () => {
    const kingdom = createInitialKingdom();
    const totals = kingdom.districts.reduce((sum, district) => {
        const caps = support.supportCaps(district);
        return { golems: sum.golems + caps.golems, wolves: sum.wolves + caps.wolves };
    }, { golems: 0, wolves: 0 });
    assert.deepEqual(totals, { golems: 5, wolves: 10 });
    assert.deepEqual(support.supportCaps(districtWith({ buildings: { ...districtWith().buildings, barracks: 0 } })), { golems: 0, wolves: 0 }, "no barracks, no support");
});

test("production never exceeds the cap, is paced by the cooldown, and a lost district makes nothing", () => {
    const district = districtWith({ reserves: { food: 500, materials: 5000, supplies: 5000 } });
    let record = { golems: 0, wolves: 0, lastGolemStep: null, lastWolfStep: null };
    const golemSteps = [];
    const wolfSteps = [];
    for (let step = 0; step < 200; step += 1) {
        const budget = support.spawnBudget(district, record, step);
        if (budget.golems > 0) {
            record = { ...record, golems: record.golems + budget.golems, lastGolemStep: step };
            golemSteps.push(step);
        }
        if (budget.wolves > 0) {
            record = { ...record, wolves: record.wolves + budget.wolves, lastWolfStep: step };
            wolfSteps.push(step);
        }
        assert.ok(record.golems <= support.supportCaps(district).golems, `golems ${String(record.golems)} at step ${String(step)}`);
        assert.ok(record.wolves <= support.supportCaps(district).wolves, `wolves ${String(record.wolves)} at step ${String(step)}`);
    }
    assert.equal(record.golems, 1, "one barracks, so one golem stands");
    assert.equal(record.wolves, 2, "one barracks, so two wolves stand");
    assert.deepEqual(golemSteps, [0], "the cap stops a second golem");
    const lost = support.spawnBudget(districtWith({ security: "lost", reserves: { food: 500, materials: 5000, supplies: 5000 } }), { golems: 0, wolves: 0 }, 0);
    assert.equal(lost.golems + lost.wolves, 0);
    assert.deepEqual(wolfSteps, [0, 12], "wolves are paced by their own cooldown");
});

test("the cooldown holds even with room under the cap, and a dead golem is replaced only after it and only with fresh stores", () => {
    const rich = districtWith({ reserves: { food: 500, materials: 5000, supplies: 5000 }, buildings: { ...districtWith().buildings, barracks: 3 } });
    const cooling = support.spawnBudget(rich, { golems: 1, wolves: 0, lastGolemStep: 10, lastWolfStep: null }, 20);
    assert.equal(cooling.golems, 0, "a golem made 10 steps ago is still cooling down");
    const ready = support.spawnBudget(rich, { golems: 1, wolves: 0, lastGolemStep: 10, lastWolfStep: null }, 34);
    assert.equal(ready.golems, 1, "after 24 steps a replacement is allowed");
    const broke = support.spawnBudget(districtWith({ reserves: { food: 0, materials: 29, supplies: 1000 } }), { golems: 0, wolves: 0 }, 0);
    assert.equal(broke.golems, 0, "not enough materials for a golem");
    assert.ok(broke.reasons.some((reason) => /golem needs materials/.test(reason)));
});

test("engagement needs a garrison, can never lose more units than it engaged, and advances the cursor only when it draws", () => {
    const withGarrison = districtWith({ assault: 30, garrison: { front: 24, reserve: 6 } });
    const engaged = support.engageSupport(withGarrison, { golems: 3, wolves: 4 }, { rngState: 99 });
    assert.equal(engaged.engaged.golems, 3, "ceil(30/8)=4 capped at the 3 golems");
    assert.equal(engaged.engaged.wolves, 3, "ceil(30/12)=3 wolves");
    assert.ok(engaged.losses.golems <= engaged.engaged.golems && engaged.losses.wolves <= engaged.engaged.wolves);
    assert.ok(engaged.after.golems >= 0 && engaged.after.wolves >= 0);
    assert.equal(engaged.supportStrength, 3 * support.SUPPORT_RULES.golemStrength + 3 * support.SUPPORT_RULES.wolfStrength);
    assert.notEqual(engaged.rngState, 99, "the cursor moved because losses were drawn");

    const noGarrison = support.engageSupport(districtWith({ assault: 30, garrison: { front: 0, reserve: 30 } }), { golems: 3, wolves: 4 }, { rngState: 99 });
    assert.equal(noGarrison.engaged.golems + noGarrison.engaged.wolves, 0, "no garrison, no support in the fight");
    assert.match(noGarrison.reason, /no garrison/);
    assert.equal(noGarrison.rngState, 99, "nothing was drawn");

    const quiet = support.engageSupport(districtWith({ assault: 0 }), { golems: 3, wolves: 4 }, { rngState: 7 });
    assert.equal(quiet.supportStrength, 0);
});

test("equipment never upgrades more soldiers than its barracks allow and never exceeds the tier the barracks can equip", () => {
    for (const barracks of [0, 1, 2, 3]) {
        const district = districtWith({ soldiers: 30, buildings: { ...districtWith().buildings, barracks }, reserves: { food: 0, materials: 900, supplies: 900 } });
        const plan = equipment.planEquipment(district, { 0: 10, 1: 20, 2: 0, 3: 0 });
        const maxTier = barracks >= 2 ? 3 : barracks >= 1 ? 2 : 1;
        assert.equal(plan.maxTier, maxTier, `barracks ${String(barracks)}`);
        const moved = plan.upgrades.reduce((sum, step) => sum + step.count, 0);
        assert.ok(moved <= barracks * equipment.EQUIPMENT_RULES.upgradesPerBarrackPerStep, `moved ${String(moved)} with ${String(barracks)} barracks`);
        for (const [tier, count] of Object.entries(plan.after)) {
            if (count > 0) {
                assert.ok(Number(tier) <= maxTier, `tier ${tier} with ${String(barracks)} barracks`);
            }
        }
        assert.equal(Object.values(plan.after).reduce((sum, value) => sum + value, 0), 30);
    }
});

test("patrol groups never outnumber wall sections and every group has at least one soldier", () => {
    for (const front of [1, 2, 5, 8, 16, 24, 60, 150]) {
        for (const sectionCount of [1, 2, 3, 8]) {
            const plan = patrols.planPatrols({ ...districtWith(), garrison: { front, reserve: 0 } }, { sectionCount });
            assert.ok(plan.groupCount <= sectionCount, `${String(front)} soldiers, ${String(sectionCount)} sections`);
            assert.ok(plan.groups.every((group) => group.soldiers >= 1), "no empty group");
            assert.equal(plan.groups.reduce((sum, group) => sum + group.soldiers, 0), front);
        }
    }
});
