import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { DISTRICT_DEFAULTS, POLICY_DEFAULTS, STARTING_SIMULATION } = await loadModule("config.js");
const { computeTotals, createInitialKingdom, districtById, findValidationProblems } = await loadModule("kingdom", "state.js");
const war = await loadModule("sim", "war.js");
const { MIN_REPAIR_CREW } = await loadModule("sim", "siegeTuning.js");

/** Fixed seed everywhere: no Math.random, no sleeps, no tolerance fudge in this file. */
const SEED = 20261017;
/** Fixed bound for every long-running loop in this file. */
const LONG_SIEGE_STEPS = 200;

/**
 * @param {number} seed
 * @returns {any}
 */
function kingdomAt(seed) {
    const kingdom = createInitialKingdom();
    kingdom.seed = seed;
    kingdom.rngState = seed >>> 0;
    return kingdom;
}

/**
 * The conservation rules the design promises, checked as numbers rather than as prose.
 * @param {any} kingdom
 */
function assertInvariants(kingdom) {
    const problems = findValidationProblems(kingdom);
    assert.deepEqual(problems, [], `saved state must stay valid: ${problems.join("; ")}`);
    for (const district of kingdom.districts) {
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers, `${district.id} garrison split`);
        assert.ok(Number.isInteger(district.garrison.front) && district.garrison.front >= 0, `${district.id} front`);
        assert.ok(Number.isInteger(district.garrison.reserve) && district.garrison.reserve >= 0, `${district.id} reserve`);
        assert.ok(Number.isInteger(district.soldiers) && district.soldiers >= 0, `${district.id} soldiers`);
        assert.ok(Number.isInteger(district.civilians) && district.civilians >= 0, `${district.id} civilians`);
        assert.ok(Number.isInteger(district.refugees) && district.refugees >= 0, `${district.id} refugees`);
        assert.ok(Number.isInteger(district.assault) && district.assault >= 0, `${district.id} assault`);
        assert.ok(Number.isInteger(district.siegeSteps) && district.siegeSteps >= 0, `${district.id} siegeSteps`);
        assert.ok(
            district.defensiveIntegrity >= 0 && district.defensiveIntegrity <= 100,
            `${district.id} integrity ${String(district.defensiveIntegrity)} outside 0..100`,
        );
        assert.ok(district.reserves.materials >= 0, `${district.id} materials went negative`);
    }
}

/**
 * @param {any} district
 */
function garrisonOf(district) {
    return [district.soldiers, district.garrison.front, district.garrison.reserve];
}

test("war exposes the per-step pipeline sim/tick.js calls, in order", () => {
    for (const name of [
        "spawnThreats",
        "updateAlertState",
        "assignDefenders",
        "requestReinforcements",
        "resolveAssault",
        "counterattack",
        "recoverAfterDefense",
        "runWarStep",
    ]) {
        assert.equal(typeof war[name], "function", `${name} must be exported`);
    }
});

test("spawnThreats is seed-reproducible, advances the cursor and never invents negative raids", () => {
    const first = kingdomAt(SEED);
    const second = kingdomAt(SEED);
    const /** @type {string[]} */ firstEvents = [];
    const /** @type {string[]} */ secondEvents = [];
    for (let step = 0; step < 40; step += 1) {
        first.step = step;
        second.step = step;
        firstEvents.push(...war.spawnThreats(first));
        secondEvents.push(...war.spawnThreats(second));
    }

    assert.deepEqual(
        first.districts.map((district) => district.assault),
        second.districts.map((district) => district.assault),
        "the same seed must replay the same war",
    );
    assert.deepEqual(firstEvents, secondEvents);
    assert.equal(first.rngState, second.rngState);
    assert.ok(Number.isInteger(first.rngState) && first.rngState >= 0, "rngState stays a non-negative integer");
    assert.notEqual(first.rngState, SEED >>> 0, "the cursor must be written back, not left behind");

    for (const district of first.districts) {
        assert.ok(Number.isInteger(district.assault) && district.assault >= 0, `${district.id} assault ${String(district.assault)}`);
    }
    assertInvariants(first);
});

test("a different seed diverges from the starting kingdom", () => {
    const home = kingdomAt(SEED);
    const other = kingdomAt(SEED + 1);
    let diverged = false;
    for (let step = 0; step < 60 && !diverged; step += 1) {
        home.step = step;
        other.step = step;
        war.spawnThreats(home);
        war.spawnThreats(other);
        diverged =
            home.rngState !== other.rngState ||
            home.districts.some((district, index) => district.assault !== other.districts[index].assault);
    }
    assert.equal(diverged, true, "two different seeds must not produce the same threat pattern");
});

test("spawnThreats presses districts in stable id order and writes every event as a string", () => {
    const kingdom = kingdomAt(SEED);
    const events = war.spawnThreats(kingdom);
    for (const event of events) {
        assert.equal(typeof event, "string");
        assert.ok(event.length > 0);
    }
    // The kingdom log is the same text, newest first, and no district was touched out of order.
    const logged = kingdom.log.slice(0, events.length).map((entry) => entry.text);
    assert.deepEqual(logged, events.slice().reverse());
    for (const entry of kingdom.log.slice(0, events.length)) {
        assert.equal(entry.atStep, kingdom.step);
    }
});

test("a district that has already fallen is not raided again, so it can climb back", () => {
    const kingdom = kingdomAt(SEED);
    const fallen = kingdom.districts[0];
    fallen.security = "lost";
    fallen.assault = 0;
    for (let step = 0; step < 60; step += 1) {
        kingdom.step = step;
        war.spawnThreats(kingdom);
    }
    assert.equal(fallen.assault, 0);
    assert.equal(fallen.security, "lost");
    assert.ok(kingdom.districts.some((district) => district.assault > 0), "the rest of the kingdom is still pressed");
});

test("assignDefenders keeps front+reserve exactly equal to soldiers for every count", () => {
    for (let soldiers = 0; soldiers <= 60; soldiers += 1) {
        const district = { id: "d", name: "D", soldiers, garrison: { front: 0, reserve: 0 } };
        const split = war.assignDefenders(district);
        assert.equal(split.front + split.reserve, soldiers);
        assert.equal(split.front, Math.floor(soldiers * DISTRICT_DEFAULTS.frontGarrisonFraction));
        assert.equal(split.reserve, soldiers - split.front);
        assert.ok(Number.isInteger(split.front) && split.front >= 0);
        assert.ok(Number.isInteger(split.reserve) && split.reserve >= 0);
        // Idempotent: running it again cannot drift the split.
        const again = war.assignDefenders(district);
        assert.deepEqual(again, split);
    }
    const empty = { id: "d", name: "D", soldiers: 0 };
    assert.deepEqual(war.assignDefenders(empty), { front: 0, reserve: 0, soldiers: 0 });
    assert.deepEqual(war.assignDefenders(null), { front: 0, reserve: 0, soldiers: 0 });
});

test("updateAlertState escalates on evidence and never calms a district by itself", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.security = "secure";
    district.assault = 4;
    district.defensiveIntegrity = 100;
    war.updateAlertState(kingdom);
    assert.equal(district.security, "alert", "a small raid raises the watch but does not break the wall");

    district.assault = 300;
    war.updateAlertState(kingdom);
    assert.equal(district.security, "contested", "attackers outnumbering the standing wall contests the district");

    district.defensiveIntegrity = POLICY_DEFAULTS.breachIntegrity - 1;
    war.updateAlertState(kingdom);
    assert.equal(district.security, "breached", "integrity below breachIntegrity with a raid on the ground is a breach");

    // Calm conditions, but updateAlertState must not demote anything: recovery owns that.
    district.assault = 0;
    district.defensiveIntegrity = 100;
    war.updateAlertState(kingdom);
    assert.equal(district.security, "breached", "escalation only - demotion belongs to recoverAfterDefense");
    assertInvariants(kingdom);
});

test("updateAlertState leaves isolation and fall to their own owners", () => {
    const kingdom = kingdomAt(SEED);
    const cut = kingdom.districts[1];
    cut.security = "isolated";
    cut.assault = 0;
    war.updateAlertState(kingdom);
    assert.equal(cut.security, "isolated");

    const fallen = kingdom.districts[2];
    fallen.security = "lost";
    fallen.assault = 40;
    war.updateAlertState(kingdom);
    assert.equal(fallen.security, "lost", "war does not quietly un-lost a district");
});

test("resolveAssault costs both sides real people, chips the wall and records the battle", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 30;
    district.civilians = 80;
    district.defensiveIntegrity = 100;
    district.security = "alert";
    district.assault = 20;
    district.siegeSteps = 0;
    war.assignDefenders(district);

    const events = war.resolveAssault(kingdom, district);
    assert.ok(events.length > 0 && typeof events[0] === "string");
    assert.deepEqual(garrisonOf(district), [29, 23, 6], "one soldier lost, garrison re-split in the same step");
    assert.equal(district.defensiveIntegrity, 99, "integrity chipped by exactly one point at these odds");
    assert.equal(district.assault, 16, "the raid band lost 4 of 20");
    assert.equal(district.siegeSteps, 0, "a held district carries no siege counter");

    const battle = kingdom.battles[0];
    assert.equal(battle.districtId, district.id);
    assert.equal(battle.assault, 20);
    assert.equal(battle.standing, 24);
    assert.equal(battle.integrityBefore, 100);
    assert.equal(battle.integrityAfter, 99);
    assert.equal(battle.attackerLosses, 4);
    assert.equal(battle.defenderLosses, 1);
    assert.equal(battle.outcome, "held");
    assertInvariants(kingdom);
});

test("casualties are deducted from real counts and can never go negative", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 1;
    district.defensiveIntegrity = 3;
    district.security = "breached";
    district.assault = 32;
    war.assignDefenders(district);

    for (let step = 0; step < 20; step += 1) {
        kingdom.step = step;
        war.resolveAssault(kingdom, district);
        assertInvariants(kingdom);
        assert.ok(district.soldiers >= 0 && district.civilians >= 0);
    }
    assert.equal(district.defensiveIntegrity, 0, "clamped at the floor, never below");
    assert.ok(district.soldiers >= 0, `soldiers went negative (${String(district.soldiers)})`);
    assert.ok(district.assault >= 0, "a raid band cannot be pushed below zero");
    assert.equal(district.civilians, STARTING_SIMULATION.civilians / STARTING_SIMULATION.districtCount, "civilians were untouched");
});

test("a breached wall is neither abandonment nor capture in a single step", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 0;
    district.defensiveIntegrity = 0;
    district.security = "alert";
    district.assault = 30;
    district.siegeSteps = 0;

    kingdom.step = 1;
    war.updateAlertState(kingdom);
    const events = war.resolveAssault(kingdom, district);

    assert.equal(district.security, "breached", "the wall is breached");
    assert.notEqual(district.security, "lost", "one breached step is not a fall");
    assert.equal(district.siegeSteps, 1, "the siege counter starts, that is all");
    assert.equal(district.civilians, 80, "nobody is driven out or deleted");
    assert.equal(district.name, "Hearthgate");
    assert.equal(district.neighbors.length, 2, "still linked, still owned");
    assert.equal(kingdom.districts.length, 5);
    assert.equal(computeTotals(kingdom).civilians, 400, "no civilian anywhere was moved, killed or deleted");
    assert.ok(events.some((event) => event.includes("breached") || event.includes("assault")));
    assertInvariants(kingdom);
});

test("lost needs every consecutive breached step with no able defenders", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 0;
    district.defensiveIntegrity = 0;
    district.security = "breached";
    district.assault = 30;
    district.siegeSteps = 0;
    const fallAfter = kingdom.policy.fallAfterSiegeSteps;
    assert.equal(fallAfter, POLICY_DEFAULTS.fallAfterSiegeSteps);

    const civiliansBefore = district.civilians;
    for (let step = 1; step <= fallAfter - 1; step += 1) {
        kingdom.step = step;
        war.resolveAssault(kingdom, district);
        assert.equal(district.siegeSteps, step, `step ${String(step)} of the siege`);
        assert.notEqual(district.security, "lost", "the district may not fall before the full siege length");
    }

    kingdom.step = fallAfter;
    const events = war.resolveAssault(kingdom, district);
    assert.equal(district.siegeSteps, fallAfter);
    assert.equal(district.security, "lost", "the siege ran its full length with nobody able to hold the wall");
    assert.equal(kingdom.districts.length, 5, "the district record is never deleted");
    assert.equal(district.civilians, civiliansBefore, "a fallen district keeps its people");
    assert.equal(district.name, "Hearthgate");
    assert.ok(events.some((event) => event.includes("fallen")));
    assertInvariants(kingdom);
});

test("able defenders hold a breached wall open for as long as they stand", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 30;
    district.defensiveIntegrity = 10;
    district.security = "breached";
    district.assault = 12;
    district.siegeSteps = 0;

    for (let step = 1; step <= 40; step += 1) {
        kingdom.step = step;
        war.resolveAssault(kingdom, district);
        if (war.hasAbleDefenders(district)) {
            assert.notEqual(district.security, "lost", "a defended district cannot fall, however low the wall");
        }
        assert.ok(district.siegeSteps === 0 || district.siegeSteps > 0);
    }
    assertInvariants(kingdom);
});

test("the policy siege length is honoured, not hard-coded", () => {
    const kingdom = kingdomAt(SEED);
    kingdom.policy.fallAfterSiegeSteps = 3;
    const district = kingdom.districts[0];
    district.soldiers = 0;
    district.defensiveIntegrity = 0;
    district.security = "breached";
    district.assault = 30;
    district.siegeSteps = 0;

    war.resolveAssault(kingdom, district);
    war.resolveAssault(kingdom, district);
    assert.equal(district.security, "breached");
    war.resolveAssault(kingdom, district);
    assert.equal(district.siegeSteps, 3);
    assert.equal(district.security, "lost");
});

test("reinforcements move soldiers and never let a neighbour go below the policy share", () => {
    const kingdom = kingdomAt(SEED);
    const before = computeTotals(kingdom).soldiers;
    const district = kingdom.districts[0];
    const donorA = kingdom.districts[1];
    const donorB = kingdom.districts[4];
    const keep = kingdom.policy.reinforcementKeepFraction;

    const report = war.requestReinforcements(kingdom, district.id, 20);
    assert.equal(report.requested, 20);
    assert.equal(report.sent, 20);
    assert.equal(report.deficit, 0);
    assert.deepEqual(
        report.contributions.map((entry) => [entry.donor, entry.soldiers]),
        [
            ["district-2", 15],
            ["district-5", 5],
        ],
    );
    assert.equal(district.soldiers, 50);
    assert.equal(donorA.soldiers, 15, `a 30-strong neighbour keeps ceil(30 * ${String(keep)})`);
    assert.equal(donorB.soldiers, 25);
    assert.equal(computeTotals(kingdom).soldiers, before, "soldiers are moved, never created or destroyed");
    for (const entry of [district, donorA, donorB]) {
        assert.equal(entry.garrison.front + entry.garrison.reserve, entry.soldiers);
    }
    assert.deepEqual(
        district.reinforcedBy,
        [
            { from: "district-2", soldiers: 15 },
            { from: "district-5", soldiers: 5 },
        ],
    );
    assertInvariants(kingdom);
});

test("the deficit left over is reported honestly", () => {
    const kingdom = kingdomAt(SEED);
    const before = computeTotals(kingdom).soldiers;
    const district = kingdom.districts[0];

    const report = war.requestReinforcements(kingdom, district.id, 100);
    assert.equal(report.requested, 100);
    assert.equal(report.sent, 30, "two neighbours at their keep cap");
    assert.equal(report.deficit, 70);
    assert.equal(report.sent + report.deficit, report.requested);
    assert.equal(report.contributions.every((entry) => entry.soldiers === entry.limit), true, "both donors hit their limit");
    assert.equal(report.contributions.every((entry) => entry.capped), true);
    assert.ok(report.events.some((event) => event.includes("short by 70 of 100")));
    assert.equal(district.soldiers, 60);
    assert.equal(computeTotals(kingdom).soldiers, before);
    for (const donor of [kingdom.districts[1], kingdom.districts[4]]) {
        assert.equal(donor.soldiers, 15, "a neighbour is never emptied to fill someone else's gap");
    }
    assertInvariants(kingdom);

    const already = war.requestReinforcements(kingdom, district.id, 10);
    assert.equal(already.sent, 0, "a neighbour that already has half its home strength away sends nothing more");
    assert.equal(already.deficit, 10);
    assert.equal(already.declined.length, 2, "the same neighbours have nothing left to spare");
    assert.match(already.declined[0].reason, /already has 15 soldiers away from a home strength of 30/);
    assert.equal(computeTotals(kingdom).soldiers, before);
    assertInvariants(kingdom);
});

test("both readings of the keep fraction are enforced, whatever it is set to", () => {
    for (const keep of [0.3, 0.5, 0.7, 1]) {
        const kingdom = kingdomAt(SEED);
        kingdom.policy.reinforcementKeepFraction = keep;
        const district = kingdom.districts[0];
        const donor = kingdom.districts[1];
        const donorBefore = donor.soldiers;

        const report = war.requestReinforcements(kingdom, district.id, 30);
        const sent = report.contributions.find((entry) => entry.donor === donor.id)?.soldiers ?? 0;
        assert.ok(sent <= Math.floor(donorBefore * keep), `${String(keep)}: sent ${String(sent)} exceeds the share it may send`);
        assert.ok(donor.soldiers >= Math.ceil(donorBefore * keep), `${String(keep)}: donor kept ${String(donor.soldiers)} below the keep floor`);
        assert.ok(donor.garrison.reserve >= 0, "the home reserve is never spent");
        assert.equal(donor.garrison.front + donor.garrison.reserve, donor.soldiers);
        assertInvariants(kingdom);
    }
});

test("a neighbour already fighting holds its own line", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    const busy = kingdom.districts[1];
    busy.assault = 5;
    busy.security = "secure";

    const report = war.requestReinforcements(kingdom, district.id, 20);
    assert.equal(report.sent, 15, "only the quiet neighbour could answer");
    assert.equal(busy.soldiers, 30, "a district under assault sent nothing");
    assert.equal(district.soldiers, 45);
    assert.equal(report.declined.length, 1);
    assert.match(report.declined[0].reason, /holds its own line/);
    assert.ok(report.events.some((event) => event.includes("short by 5 of 20")));
    assertInvariants(kingdom);
});

test("the siege counter itself is what turns a breach into a fall", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 0;
    district.defensiveIntegrity = 0;
    district.security = "breached";
    district.assault = 20;

    district.siegeSteps = kingdom.policy.fallAfterSiegeSteps - 1;
    assert.deepEqual(war.updateAlertState(kingdom), [], "one step short of the full siege is still only a breach");
    assert.equal(district.security, "breached");

    district.siegeSteps = kingdom.policy.fallAfterSiegeSteps;
    const events = war.updateAlertState(kingdom);
    assert.equal(district.security, "lost");
    assert.ok(events.some((event) => event.includes("fallen") && event.includes("stay on the record")));
    assert.equal(district.civilians, 80, "falling changes a status flag, it does not clear a district");
    assert.equal(kingdom.districts.length, 5);

    // Defenders able on the wall hold the fall off no matter how long the siege has run.
    const held = kingdom.districts[1];
    held.soldiers = 20;
    held.defensiveIntegrity = 60;
    held.security = "breached";
    held.assault = 20;
    held.siegeSteps = 99;
    war.assignDefenders(held);
    war.updateAlertState(kingdom);
    assert.equal(held.security, "breached", "able defenders cannot be counted out of their own walls");
    assertInvariants(kingdom);
});

test("a district with no neighbours says so instead of conjuring soldiers", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.neighbors = [];
    const before = computeTotals(kingdom).soldiers;

    const report = war.requestReinforcements(kingdom, district.id, 12);
    assert.equal(report.sent, 0);
    assert.equal(report.deficit, 12);
    assert.ok(report.events.some((event) => event.includes("no neighbouring district exists")));
    assert.equal(computeTotals(kingdom).soldiers, before);
    assert.equal(district.soldiers, 30);

    const ghost = war.requestReinforcements(kingdom, "district-99", 5);
    assert.equal(ghost.sent, 0);
    assert.ok(ghost.events.some((event) => event.includes("no such district")));
});

test("counterattack waits until the defenders plainly outnumber the raid", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 30;
    district.defensiveIntegrity = 100;
    district.security = "contested";
    district.assault = 17;
    war.assignDefenders(district);
    assert.equal(war.defensiveStrength(district), 24);

    assert.deepEqual(war.counterattack(kingdom, district), [], "24 defenders are not clearly more than 17*1.5 attackers");
    assert.equal(district.assault, 17);

    district.assault = 16;
    const events = war.counterattack(kingdom, district);
    assert.equal(district.assault, 2, "the counterattack broke 14 of 16 raiders");
    assert.ok(events.length > 0);
    assert.match(kingdom.battles[0].outcome, /counterattack/);
    assert.equal(district.soldiers, 30, "no soldier died in the pursuit at these odds");
    assertInvariants(kingdom);

    war.counterattack(kingdom, district);
    assert.equal(district.assault, 0, "the second blow finishes the band");
    assert.equal(district.siegeSteps, 0);
    assertInvariants(kingdom);
});

test("reinforcements are demanded in the numbers a counterattack actually needs", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 10;
    district.defensiveIntegrity = 100;
    district.assault = 12;
    assert.equal(war.reinforcementDemand(kingdom, district), 13, "18 front seats need 23 bodies at a 0.8 split");

    const report = war.requestReinforcements(kingdom, district.id, war.reinforcementDemand(kingdom, district));
    assert.equal(report.sent, 13);
    assert.equal(district.soldiers, 23);
    assert.equal(district.garrison.front, 18, "whatever arrives is re-split the same step");
    assert.ok(war.defensiveStrength(district) >= 12 * 1.5, "the district can now go on the offensive");

    war.counterattack(kingdom, district);
    assert.equal(district.assault, 1, "the first blow breaks 11 of the 12 raiders");
    war.counterattack(kingdom, district);
    assert.equal(district.assault, 0, "the second blow clears the raid, and the district holds");
    assert.equal(district.siegeSteps, 0);
    assertInvariants(kingdom);
});

test("recovery repairs the wall for materials and demotes security one rung at a time", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.assault = 0;
    district.security = "breached";
    district.defensiveIntegrity = 20;
    district.siegeSteps = 7;
    district.builders = 0;
    district.reserves.materials = 180;

    const first = war.recoverAfterDefense(kingdom, district);
    // Adapted: the wall crew is one hand per 20 civilians, so 80 civilians are four hands at
    // DISTRICT_DEFAULTS.integrityRepairPerStep each (see the wall crew test below).
    assert.equal(district.defensiveIntegrity, 22.4, `${DISTRICT_DEFAULTS.integrityRepairPerStep} integrity per hand, four hands for 80 civilians`);
    assert.equal(district.reserves.materials, 178.8, "repair is paid for out of reserves.materials");
    assert.equal(district.security, "breached", "the wall is still below breachIntegrity, so the district cannot step up yet");
    assert.equal(district.siegeSteps, 0, "the siege counter clears once the district is not being pressed");
    assert.ok(first.length === 0 || first.every((event) => typeof event === "string"));

    district.defensiveIntegrity = 50;
    assert.deepEqual(war.recoverAfterDefense(kingdom, district).length >= 0, true);
    assert.equal(district.security, "contested");
    war.recoverAfterDefense(kingdom, district);
    assert.equal(district.security, "alert");
    war.recoverAfterDefense(kingdom, district);
    assert.equal(district.security, "secure");
    war.recoverAfterDefense(kingdom, district);
    assert.equal(district.security, "secure", "already calm: nothing left to demote");
    assert.ok(district.defensiveIntegrity > 50);
    assertInvariants(kingdom);
});

test("repair climbs to exactly 100 and then stops spending", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.assault = 0;
    district.security = "secure";
    district.defensiveIntegrity = 98.8;
    district.reserves.materials = 100;
    const events = [];
    for (let step = 0; step < 10; step += 1) {
        events.push(...war.recoverAfterDefense(kingdom, district));
    }
    assert.equal(district.defensiveIntegrity, 100, "clamped at the ceiling, never above");
    assert.equal(district.reserves.materials, 99.4, "no materials are spent on an already perfect wall");
    assert.ok(events.some((event) => event.includes("walls back to full integrity")));
    assertInvariants(kingdom);
});

test("a district with no materials cannot repair and says so", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.assault = 0;
    district.security = "alert";
    district.defensiveIntegrity = 30;
    district.reserves.materials = 0;

    const events = war.recoverAfterDefense(kingdom, district);
    assert.equal(district.defensiveIntegrity, 30);
    assert.ok(events.some((event) => event.includes("no materials to spare")));
    assert.equal(district.security, "secure", "an alert district with no raid on it calms straight to secure");

    const poor = kingdom.districts[1];
    poor.assault = 0;
    poor.security = "secure";
    poor.defensiveIntegrity = 20;
    poor.reserves.materials = 0.2;
    war.recoverAfterDefense(kingdom, poor);
    assert.equal(poor.defensiveIntegrity, 20.4, "a partial repair is bought with what is in the storehouse");
    assert.equal(poor.reserves.materials, 0, "the storehouse is never taken below zero");
    assertInvariants(kingdom);
});

test("recovery marches every borrowed soldier home", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    const donorA = kingdom.districts[1];
    const donorB = kingdom.districts[4];
    const before = [district, donorA, donorB, kingdom.districts[2], kingdom.districts[3]].map((entry) => entry.soldiers);
    const total = computeTotals(kingdom).soldiers;

    war.requestReinforcements(kingdom, district.id, 20);
    assert.notEqual(district.soldiers, 30);
    district.assault = 0;

    const events = war.recoverAfterDefense(kingdom, district);
    assert.deepEqual(
        [district, donorA, donorB, kingdom.districts[2], kingdom.districts[3]].map((entry) => entry.soldiers),
        before,
        "every soldier is back where it started",
    );
    assert.equal(computeTotals(kingdom).soldiers, total);
    assert.deepEqual(district.reinforcedBy, []);
    assert.ok(events.some((event) => event.includes("march home")));
    for (const entry of kingdom.districts) {
        assert.equal(entry.garrison.front + entry.garrison.reserve, entry.soldiers);
    }
    assertInvariants(kingdom);
});

test("reinforcements that die on loan are never conjured back home", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    const donorA = kingdom.districts[1];
    const total = computeTotals(kingdom).soldiers;

    war.requestReinforcements(kingdom, district.id, 20);
    assert.equal(district.soldiers, 50);

    // The 20 borrowed men are then cut down to 5 defending someone else's wall.
    district.soldiers = 5;
    war.assignDefenders(district);
    district.assault = 0;
    const events = war.recoverAfterDefense(kingdom, district);

    assert.equal(donorA.soldiers, 20, "the 5 survivors walk back, the other 15 died on loan");
    assert.equal(district.soldiers, 0);
    assert.deepEqual(district.reinforcedBy, [], "the ledger is cleared once nothing more can come home");
    assert.equal(computeTotals(kingdom).soldiers, total - 45, "45 soldiers died, none were invented");
    assert.ok(events.some((event) => event.includes("did not survive the loan")));
    assertInvariants(kingdom);
});

test("a detachment whose home district left the record stays put instead of vanishing", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    war.requestReinforcements(kingdom, district.id, 10);
    const soldiersBefore = computeTotals(kingdom).soldiers;
    district.reinforcedBy[0].from = "district-9";
    district.assault = 0;

    war.recoverAfterDefense(kingdom, district);
    assert.equal(computeTotals(kingdom).soldiers, soldiersBefore, "nobody is teleported into a district that does not exist");
    assert.equal(district.reinforcedBy.length, 1, "the obligation is still tracked, not silently dropped");
});

test("recovery does not start while raiders are still on the ground", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.assault = 9;
    district.security = "breached";
    district.defensiveIntegrity = 20;
    const materials = district.reserves.materials;

    assert.deepEqual(war.recoverAfterDefense(kingdom, district), []);
    assert.equal(district.defensiveIntegrity, 20, "no free repair under attack");
    assert.equal(district.reserves.materials, materials);
    assert.equal(district.security, "breached");
});

test("a remnant of one or two raiders is worn down by a standing defence, so it cannot outlast the wall", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 30;
    district.defensiveIntegrity = 0;
    district.security = "breached";
    district.assault = 2;
    district.siegeSteps = 0;
    war.assignDefenders(district);
    assert.ok(war.defensiveStrength(district) > 0, "a standing (if feeble) defence still engages the remnant");

    kingdom.step = 1;
    war.resolveAssault(kingdom, district);
    assert.equal(district.assault, 1, "at least one raider is lost a step; round(2 * 0.18) = 0 used to lose none for ever");
    kingdom.step = 2;
    war.resolveAssault(kingdom, district);
    assert.equal(district.assault, 0, "the remnant is gone in two steps");
    assert.ok(kingdom.battles.every((battle) => battle.attackerLosses >= 1), "every engaged battle cost the raiders a man");
    assertInvariants(kingdom);
});

test("the wall crew is one hand per twenty civilians, with the builders and a standing hand as the floor", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    const repairPerHand = Number(DISTRICT_DEFAULTS.integrityRepairPerStep);
    const repairOnce = (civilians, builders) => {
        district.assault = 0;
        district.security = "secure";
        district.defensiveIntegrity = 10;
        district.reserves.materials = 180;
        district.civilians = civilians;
        district.builders = builders;
        war.recoverAfterDefense(kingdom, district);
        return Math.round((district.defensiveIntegrity - 10) * 10) / 10;
    };

    // Adapted: the standing crew is MIN_REPAIR_CREW (siegeTuning.js, raised from 1 to 2). The
    // rule itself is unchanged: the floor applies, and civilians add hands only per 20 of them.
    assert.equal(repairOnce(0, 0), Math.round(repairPerHand * MIN_REPAIR_CREW * 10) / 10, "an emptied district keeps its standing crew");
    assert.equal(repairOnce(19, 0), Math.round(repairPerHand * MIN_REPAIR_CREW * 10) / 10, "19 civilians add no hand beyond the standing crew");
    assert.equal(repairOnce(80, 0), Math.round(repairPerHand * 4 * 10) / 10, "80 civilians are four hands");
    assert.equal(repairOnce(40, 6), Math.round(repairPerHand * 6 * 10) / 10, "six builders on a project outnumber the two hands 40 civilians give");
    assertInvariants(kingdom);
});

test("a fallen district with no raiders left climbs back to secure from its own people", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 0;
    district.defensiveIntegrity = 0;
    district.security = "lost";
    district.assault = 0;
    district.siegeSteps = 12;
    district.civilians = 80;
    district.builders = 0;
    district.reserves.materials = 180;
    war.assignDefenders(district);

    let breachedAt = -1;
    let secureAt = -1;
    for (let step = 1; step <= 80 && secureAt < 0; step += 1) {
        kingdom.step = step;
        war.recoverAfterDefense(kingdom, district);
        assertInvariants(kingdom);
        if (breachedAt < 0 && district.security !== "lost") {
            breachedAt = step;
            assert.ok(district.defensiveIntegrity >= POLICY_DEFAULTS.breachIntegrity, "a fallen wall is only stepped up once it is back above breachIntegrity");
        }
        if (district.security === "secure") {
            secureAt = step;
        }
    }
    assert.ok(breachedAt > 0, "the district stepped up from lost");
    assert.ok(secureAt > breachedAt && secureAt <= 80, `the district is secure again by step ${String(secureAt)}`);
    assert.equal(district.siegeSteps, 0, "the siege counter is cleared once nobody presses the district");
    assert.equal(computeTotals(kingdom).civilians, 400, "a district that fell and recovered keeps every civilian");
});

test("runWarStep drives one step, keeps a stable order and returns plain strings", () => {
    const kingdom = kingdomAt(SEED);
    kingdom.step = 5;
    const events = war.runWarStep(kingdom);
    assert.equal(kingdom.step, 5, "the step counter belongs to sim/tick.js, not to the war module");
    assert.ok(events.every((event) => typeof event === "string" && event.length > 0));
    assertInvariants(kingdom);
});

test("runWarStep replays identically for a seed and diverges for another", () => {
    const left = kingdomAt(SEED);
    const right = kingdomAt(SEED);
    const other = kingdomAt(SEED * 3);
    const leftEvents = [];
    const rightEvents = [];
    for (let step = 0; step < 60; step += 1) {
        left.step = step;
        right.step = step;
        other.step = step;
        leftEvents.push(...war.runWarStep(left));
        rightEvents.push(...war.runWarStep(right));
    }
    assert.deepEqual(leftEvents, rightEvents);
    assert.deepEqual(left, right, "same seed, same kingdom, byte for byte");

    war.runWarStep(other);
    let diverged = false;
    for (let step = 1; step < 60; step += 1) {
        other.step = step;
        war.runWarStep(other);
        diverged = JSON.stringify(other.districts) !== JSON.stringify(left.districts);
        if (diverged) {
            break;
        }
    }
    assert.equal(diverged, true, "a different seed must not produce the same war");
});

test("a 200-step siege conserves people, holds the garrison invariant and keeps state saveable", () => {
    const kingdom = kingdomAt(SEED);
    const startCivilians = computeTotals(kingdom).civilians;
    const startSoldiers = computeTotals(kingdom).soldiers;
    let lastSoldierTotal = startSoldiers;

    for (let step = 0; step < LONG_SIEGE_STEPS; step += 1) {
        kingdom.step = step;
        const events = war.runWarStep(kingdom);
        assert.ok(events.every((event) => typeof event === "string"));
        assertInvariants(kingdom);

        const totals = computeTotals(kingdom);
        assert.equal(totals.civilians, startCivilians, "war never destroys or invents civilians");
        assert.ok(totals.soldiers <= lastSoldierTotal, "war never invents soldiers; recruits are population.js business");
        lastSoldierTotal = totals.soldiers;
        assert.ok(totals.soldiers >= 0);

        for (const district of kingdom.districts) {
            assert.ok(district.refugees <= district.civilians, `${district.id} refugees over headcount`);
            assert.ok(district.garrison.front <= district.soldiers);
            assert.ok(district.assault <= 64, "assault growth is bounded by the module cap");
        }
    }

    assert.equal(kingdom.districts.length, 5, "no district was deleted during the siege");
    assert.ok(kingdom.log.length <= 24 && kingdom.battles.length <= 12, "log windows stay bounded");
    assert.ok(lastSoldierTotal <= startSoldiers);
    assert.ok(JSON.stringify(kingdom).length > 0);
});

test("even a kingdom that loses every district keeps every district record and every civilian", () => {
    const kingdom = kingdomAt(SEED);
    for (const district of kingdom.districts) {
        district.soldiers = 0;
        district.defensiveIntegrity = 0;
        district.security = "breached";
        district.assault = 32;
        district.siegeSteps = 0;
        war.assignDefenders(district);
    }
    const startCivilians = computeTotals(kingdom).civilians;

    for (let step = 0; step < 30; step += 1) {
        kingdom.step = step;
        war.runWarStep(kingdom);
        assertInvariants(kingdom);
    }

    assert.equal(kingdom.districts.length, 5);
    assert.equal(computeTotals(kingdom).civilians, startCivilians);
    for (const district of kingdom.districts) {
        assert.equal(district.security, "lost");
        assert.equal(district.civilians, 80, "a fallen district still holds its people on the record");
        assert.ok(district.neighbors.length === 2);
    }
});

test("sim/war.js and sim/evacuation.js import nothing from the Minecraft runtime", () => {
    const runtimeImport = /(^|\n)\s*import\s[^;\n]*from\s*["']@minecraft\/server["']|(?:^|\n)\s*import\s*["']@minecraft\/server["']/;
    for (const relativePath of ["sim/war.js", "sim/evacuation.js"]) {
        const source = readFileSync(join(scriptsRoot, ...relativePath.split("/")), "utf8");
        assert.ok(!runtimeImport.test(source), `${relativePath} must not import @minecraft/server at runtime`);
    }
});
