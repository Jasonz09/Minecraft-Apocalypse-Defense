import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, findValidationProblems } = await loadModule("kingdom", "state.js");
const { advanceKingdomStep } = await loadModule("sim", "tick.js");
const { advanceTraining, openRecruitment } = await loadModule("sim", "population.js");
const { hashSeed } = await loadModule("sim", "rng.js");
const occupations = await loadModule("people", "occupations.js");
const routines = await loadModule("people", "routines.js");
const transport = await loadModule("people", "transport.js");
const patrols = await loadModule("people", "patrols.js");
const training = await loadModule("people", "training.js");
const command = await loadModule("people", "command.js");
const equipment = await loadModule("people", "equipment.js");
const support = await loadModule("people", "support.js");
const { LOCATIONS } = routines;

/** Long enough to see several sieges, a golem loss and a replacement. Bounded: one loop, no waiting. */
const STEPS = 500;
/** Every this many steps a secure district enlists three civilians through the real sim rule, so training runs. */
const RECRUIT_EVERY = 40;
const EPS = 1e-9;

/**
 * The model-side state the long run carries between steps. Nothing here is written into the kingdom:
 * support units, equipped tiers and the support random cursor live in this harness only.
 * @param {any} kingdom
 */
function harnessFor(kingdom) {
    /** @type {Record<string, any>} */
    const supportRecords = {};
    /** @type {Record<string, number>} */
    const cursor = {};
    /** @type {Record<string, Record<string, number> | null>} */
    const tiers = {};
    for (const district of kingdom.districts) {
        supportRecords[district.id] = { golems: 0, wolves: 0, lastGolemStep: null, lastWolfStep: null };
        cursor[district.id] = hashSeed(`${String(kingdom.seed)}:${district.id}:support`);
        tiers[district.id] = null;
    }
    const soldiers = {};
    for (const district of kingdom.districts) {
        soldiers[district.id] = district.soldiers;
    }
    return { support: supportRecords, cursor, tiers, soldiers, stats: { assaults: 0, golemEngagements: 0, golemLosses: 0, wolfLosses: 0, haulJobs: 0, soldierGains: 0, upgrades: 0, spawnedGolems: 0, spawnedWolves: 0, lostSteps: 0, recruits: 0 } };
}

/**
 * Make the equipped tiers agree with the soldier count. The harness rule for a change in strength:
 * new soldiers are issued tier 1, and losses are taken from tier 1 first, then 0, 2, 3.
 * @param {Record<string, number> | null} record
 * @param {number} soldiers
 */
function reconcileTiers(record, soldiers) {
    /** @type {Record<string, number>} */
    const counts = record === null ? { 0: 0, 1: soldiers, 2: 0, 3: 0 } : { ...record };
    let total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    if (total < soldiers) {
        counts[1] += soldiers - total;
    }
    for (const tier of [1, 0, 2, 3]) {
        while (total > soldiers && counts[tier] > 0) {
            counts[tier] -= 1;
            total -= 1;
        }
    }
    return counts;
}

/**
 * Every model, checked against one district's live record at one step. Returns a compact row for the digest.
 * @param {any} kingdom
 * @param {any} district
 * @param {ReturnType<typeof harnessFor>} harness
 */
function checkDistrict(kingdom, district, harness) {
    const id = district.id;
    const lost = district.security === "lost";
    const label = `${id} at step ${String(kingdom.step)} (${district.security})`;

    // Occupations: every person has one role, farmers within capacity.
    const people = occupations.assignOccupations(district);
    assert.deepEqual(occupations.occupationProblems(people), [], label);

    // Routines: one location class per role at this hour (none for a lost district).
    const locations = occupations.ROLES.map((role) => routines.locationAt({ step: kingdom.step, role, security: district.security }).location);
    for (const location of locations) {
        if (lost) {
            assert.equal(location, null, label);
        } else {
            assert.ok(LOCATIONS.includes(location), label);
        }
    }

    // Haul jobs: conservative, bounded, and never more food from the fields than the farms yield.
    const haul = transport.planHaulJobs(district);
    assert.ok(Math.abs(transport.haulConservation(haul).delta) < EPS, `${label}: haul conserves food`);
    assert.ok(haul.jobs.length <= transport.TRANSPORT_RULES.maxJobsPerDistrictPerStep, label);
    assert.ok(haul.jobs.every((job) => job.amount <= transport.TRANSPORT_RULES.carryPerJob + EPS), label);
    const toStore = haul.jobs.filter((job) => job.kind === "farm-to-storehouse").reduce((sum, job) => sum + job.amount, 0);
    assert.ok(toStore <= haul.nominal.farmOutput + EPS, `${label}: food hauled from fields is produced food`);
    assert.ok(haul.ledger.after.store >= -EPS, label);
    harness.stats.haulJobs += haul.jobs.length;

    // Patrols: every section watched, every front soldier on a patrol.
    const patrol = patrols.planPatrols(district, { step: kingdom.step });
    if (patrol.groupCount > 0) {
        assert.deepEqual(patrol.uncovered, [], label);
        assert.equal(patrol.groups.reduce((sum, group) => sum + group.soldiers, 0), district.garrison.front, label);
    } else {
        assert.equal(patrol.groups.length, 0, label);
    }

    // Commanders: the count invariant holds against the live garrison.
    const commanders = command.assignCommanders(district);
    assert.equal(commanders.state, "ok", label);
    assert.deepEqual(command.commandProblems(district, commanders), [], label);

    // Training: the projection must equal the simulation's own advanceTraining on a copy.
    const projected = training.projectTraining(district);
    const copy = structuredClone(district);
    const real = advanceTraining(undefined, copy);
    if (lost) {
        assert.equal(projected.graduated, 0, label);
    } else {
        assert.equal(projected.graduated, real.graduated, `${label}: graduates`);
        assert.equal(projected.bufferAfter, copy.trainingBuffer, `${label}: buffer`);
        assert.ok(projected.graduated <= district.trainingQueue, `${label}: a soldier only comes from the queue`);
    }
    const gained = district.soldiers - harness.soldiers[id];
    if (gained > 0) {
        harness.stats.soldierGains += gained;
    }
    harness.soldiers[id] = district.soldiers;

    // Equipment: tiers add up to the soldiers, the spend is within the declared share and affordable.
    const tiers = reconcileTiers(harness.tiers[id], district.soldiers);
    const plan = equipment.planEquipment(district, tiers);
    assert.equal(Object.values(plan.after).reduce((sum, value) => sum + value, 0), district.soldiers, label);
    assert.ok(plan.reserves.after.materials >= 0 && plan.reserves.after.supplies >= 0, label);
    assert.ok((plan.spent.materials ?? 0) <= district.reserves.materials * equipment.EQUIPMENT_RULES.maxStockShare + EPS, label);
    assert.ok((plan.spent.supplies ?? 0) <= district.reserves.supplies * equipment.EQUIPMENT_RULES.maxStockShare + EPS, label);
    harness.tiers[id] = plan.after;
    harness.stats.upgrades += plan.upgrades.reduce((sum, step) => sum + step.count, 0);

    // Support: spawn budget within caps, spent from the live stores; engagement only with a garrison.
    const record = harness.support[id];
    const caps = support.supportCaps(district);
    const budget = support.spawnBudget(district, record, kingdom.step);
    const frozen = { ...record };
    if (lost) {
        // A fallen district's units stay on the record, frozen: nothing is made, engaged or lost there.
        assert.equal(budget.golems + budget.wolves, 0, label);
    }
    support.spendSupport(district.reserves, budget.cost);
    if (budget.golems > 0) {
        record.golems += budget.golems;
        record.lastGolemStep = kingdom.step;
        harness.stats.spawnedGolems += budget.golems;
    }
    if (budget.wolves > 0) {
        record.wolves += budget.wolves;
        record.lastWolfStep = kingdom.step;
        harness.stats.spawnedWolves += budget.wolves;
    }
    if (!lost) {
        assert.ok(record.golems <= caps.golems, `${label}: golems ${String(record.golems)} over cap ${String(caps.golems)}`);
        assert.ok(record.wolves <= caps.wolves, `${label}: wolves ${String(record.wolves)} over cap ${String(caps.wolves)}`);
    }
    const engaged = support.engageSupport(district, record, { rngState: harness.cursor[id] });
    harness.cursor[id] = engaged.rngState;
    assert.ok(engaged.engaged.golems <= record.golems && engaged.engaged.wolves <= record.wolves, label);
    if (district.garrison.front === 0 || lost) {
        assert.equal(engaged.engaged.golems + engaged.engaged.wolves, 0, label);
    }
    if (engaged.engaged.golems > 0) {
        harness.stats.golemEngagements += 1;
    }
    harness.stats.golemLosses += engaged.losses.golems;
    harness.stats.wolfLosses += engaged.losses.wolves;
    if (lost) {
        assert.deepEqual(record, frozen, `${label}: support is frozen in a lost district`);
    }
    record.golems = engaged.after.golems;
    record.wolves = engaged.after.wolves;

    if (lost) {
        harness.stats.lostSteps += 1;
    }
    if (district.assault > 0) {
        harness.stats.assaults += 1;
    }

    return {
        step: kingdom.step,
        id,
        security: district.security,
        roles: people.roles,
        haul: [haul.jobs.length, toStore, haul.ledger.after.store],
        patrol: [patrol.groupCount, patrol.uncovered.length],
        commanders: [commanders.front, commanders.reserve],
        tiers: plan.after,
        support: [record.golems, record.wolves, engaged.engaged.golems, engaged.losses.golems],
        training: [district.trainingQueue, projected.graduated],
    };
}

/**
 * One long, deterministic run of the real simulation, with every people model checked each step.
 * @param {number} steps
 */
function longRun(steps) {
    const kingdom = createInitialKingdom();
    const harness = harnessFor(kingdom);
    /** @type {unknown[]} */
    const digest = [];
    for (let index = 0; index < steps; index += 1) {
        const result = advanceKingdomStep(kingdom);
        assert.deepEqual(result.problems, [], `the simulation accepted step ${String(result.step)}`);
        if (index % RECRUIT_EVERY === RECRUIT_EVERY - 1) {
            for (const district of kingdom.districts) {
                try {
                    openRecruitment(district, 3, { kingdom });
                    harness.stats.recruits += 3;
                } catch {
                    // Refused by the sim's own rules (not secure, queue full, not enough food or supplies). That is the point.
                }
            }
        }
        for (const district of kingdom.districts) {
            digest.push(checkDistrict(kingdom, district, harness));
        }
        assert.deepEqual(findValidationProblems(kingdom), [], `the saved kingdom stays valid at step ${String(kingdom.step)}`);
    }
    return { kingdom, digest, stats: harness.stats };
}

test("500 real steps: every model holds its invariants against the live records at every step", () => {
    const { kingdom, stats } = longRun(STEPS);
    assert.equal(kingdom.step, STEPS);
    assert.ok(stats.assaults > 0, "the run includes raids");
    assert.ok(stats.haulJobs > 0, "food was hauled");
    assert.ok(stats.golemEngagements > 0, "golems fought in an assault with a garrison behind them");
    assert.ok(stats.upgrades > 0, "equipment was upgraded");
    assert.ok(stats.recruits > 0 && stats.soldierGains > 0, "recruits entered training and soldiers were made through the sim's own rules");
});

test("500 real steps are reproducible: the same seed gives the same digest and the same kingdom", () => {
    const first = longRun(STEPS);
    const second = longRun(STEPS);
    assert.equal(JSON.stringify(second.digest), JSON.stringify(first.digest), "model outputs match step for step");
    assert.equal(JSON.stringify(second.kingdom), JSON.stringify(first.kingdom), "the simulation itself matches");
    assert.deepEqual(second.stats, first.stats);
});
