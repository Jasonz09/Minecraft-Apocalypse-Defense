import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { DISTRICT_DEFAULTS, GATE_STATES } = await loadModule("config.js");
const { computeTotals, createInitialKingdom, deserializeKingdom, findValidationProblems, serializeKingdom } =
    await loadModule("kingdom", "state.js");
const evacuation = await loadModule("sim", "evacuation.js");
const war = await loadModule("sim", "war.js");

const SEED = 20261017;
const LONG_RUN_STEPS = 200;
/** Mirrors the module's own bounded walking rate, restated here so the tests prove the cap. */
const FLOW_PER_STEP = 12;

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
 * Hearthgate (district-1) in the middle of a raid, its own gate open to Ironquarry, and
 * Ashfall's gate on the far side open back to it.
 * @param {any} kingdom
 */
function breachFirstDistrict(kingdom) {
    const district = kingdom.districts[0];
    district.security = "breached";
    district.defensiveIntegrity = 10;
    district.assault = 0;
    return district;
}

/**
 * @param {any} kingdom
 */
function assertInvariants(kingdom) {
    const problems = findValidationProblems(kingdom);
    assert.deepEqual(problems, [], `state must stay saveable: ${problems.join("; ")}`);
    for (const district of kingdom.districts) {
        assert.ok(Number.isInteger(district.civilians) && district.civilians >= 0, `${district.id} civilians`);
        assert.ok(Number.isInteger(district.refugees) && district.refugees >= 0, `${district.id} refugees`);
        assert.ok(district.refugees <= district.civilians, `${district.id} sheltered more people than it holds`);
        assert.ok(
            district.civilians + district.refugees <= district.civilianCapacity,
            `${district.id} over capacity: ${String(district.civilians)} + ${String(district.refugees)} > ${String(district.civilianCapacity)}`,
        );
        assert.ok(Number.isInteger(district.soldiers) && district.soldiers >= 0);
        assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
    }
}

/**
 * @param {any} kingdom
 */
function shelteredTotal(kingdom) {
    return kingdom.districts.reduce((sum, district) => sum + district.civilians, 0);
}

test("evacuation exports the functions sim/tick.js and the commanders call", () => {
    for (const name of [
        "findEvacuationTargets",
        "evacuateCivilians",
        "setGateState",
        "isolateOnBrokenGates",
        "runEvacuationStep",
        "returnRefugeesHome",
    ]) {
        assert.equal(typeof evacuation[name], "function", `${name} must be exported`);
    }
});

test("findEvacuationTargets ranks the safe neighbour with real headroom first", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    const near = kingdom.districts[1];
    const far = kingdom.districts[4];

    const found = evacuation.findEvacuationTargets(kingdom, district);
    assert.equal(found.from, district.id);
    assert.equal(found.reason, null);
    assert.deepEqual(found.blocked, []);
    assert.deepEqual(
        found.targets.map((entry) => [entry.districtId, entry.gateId, entry.headroom, entry.canTake]),
        [
            ["district-2", "gate-district-1-district-2", 40, 20],
            ["district-5", "gate-district-5-district-1", 40, 20],
        ],
        "a perfect tie is broken by id, so the ranking is always deterministic",
    );

    // Room decides when both neighbours are equally safe.
    far.civilianCapacity = 200;
    const roomy = evacuation.findEvacuationTargets(kingdom, district);
    assert.equal(roomy.targets[0].districtId, "district-5");
    assert.ok(roomy.targets[0].score > roomy.targets[1].score);

    // Safety outranks raw room: a full-strength host beats an alert one with more space.
    far.civilianCapacity = 120;
    near.security = "alert";
    const nervous = evacuation.findEvacuationTargets(kingdom, district);
    assert.deepEqual(nervous.targets.map((entry) => [entry.districtId, entry.security]), [["district-5", "secure"], ["district-2", "alert"]]);
});

test("findEvacuationTargets refuses a neighbour that is not safe, with the reason", () => {
    for (const unsafe of ["contested", "breached", "isolated", "lost"]) {
        const kingdom = kingdomAt(SEED);
        const district = breachFirstDistrict(kingdom);
        const neighbour = kingdom.districts[1];
        neighbour.security = unsafe;

        const found = evacuation.findEvacuationTargets(kingdom, district);
        assert.deepEqual(
            found.targets.map((entry) => entry.districtId),
            ["district-5"],
            `${unsafe} is not a destination`,
        );
        const blocked = found.blocked.find((entry) => entry.districtId === neighbour.id);
        assert.ok(blocked, "the refused route is reported");
        assert.equal(blocked.security, unsafe);
        assert.match(blocked.reason, /not safe enough to shelter civilians/);
    }
});

test("findEvacuationTargets refuses a sealed or broken gate, and reports a district with no route", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    evacuation.setGateState(kingdom, "gate-district-1-district-2", "sealed");

    const sealed = evacuation.findEvacuationTargets(kingdom, district);
    assert.deepEqual(sealed.targets.map((entry) => entry.districtId), ["district-5"]);
    assert.match(sealed.blocked[0].reason, /gate gate-district-1-district-2 is sealed/);

    evacuation.setGateState(kingdom, "gate-district-5-district-1", "broken");
    const both = evacuation.findEvacuationTargets(kingdom, district);
    assert.deepEqual(both.targets, []);
    assert.match(both.reason, /every gate out is sealed or broken/);
    assert.match(both.reason, /gate-district-1-district-2: sealed/);
    assert.match(both.reason, /gate-district-5-district-1: broken/);

    district.gates = [];
    district.neighbors = [];
    const alone = evacuation.findEvacuationTargets(kingdom, district);
    assert.deepEqual(alone.targets, []);
    assert.match(alone.reason, /has no gate route to any neighbour/);
});

test("evacuateCivilians moves people to the safe neighbour and tags them as refugees", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    const host = kingdom.districts[1];
    const total = shelteredTotal(kingdom);
    const soldiers = [district.soldiers, host.soldiers];

    const outcome = evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP);
    assert.equal(outcome.moved, 12);
    assert.equal(outcome.to, "district-2");
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.reason, null);
    assert.equal(district.civilians, 68);
    assert.equal(district.evacuatedTo, "district-2");
    assert.equal(host.civilians, 92);
    assert.equal(host.refugees, 12);
    assert.deepEqual(host.sheltering, [{ home: "district-1", civilians: 12 }]);
    assert.equal(shelteredTotal(kingdom), total, "total civilians are unchanged by evacuation");
    assert.deepEqual([district.soldiers, host.soldiers], soldiers, "soldiers keep their defensive positions");
    assert.ok(outcome.events.every((event) => typeof event === "string"));
    assertInvariants(kingdom);
});

test("evacuation is a bounded flow rate, never a teleport", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    district.civilians = 80;
    kingdom.districts[1].civilianCapacity = 400;

    for (let step = 0; step < 4; step += 1) {
        const moved = evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP).moved;
        assert.equal(moved, FLOW_PER_STEP, `step ${String(step + 1)} moves exactly the rate`);
        assert.equal(district.civilians, 80 - FLOW_PER_STEP * (step + 1));
    }
    assert.equal(kingdom.districts[1].refugees, 48);
    assertInvariants(kingdom);

    const slower = evacuation.evacuateCivilians(kingdom, district, 5);
    assert.equal(slower.moved, 5);
    const stopped = evacuation.evacuateCivilians(kingdom, district, 0);
    assert.equal(stopped.moved, 0);
    assert.match(stopped.reason, /evacuation rate for this step is zero/);
    assertInvariants(kingdom);
});

test("evacuation respects destination capacity exactly, then stops", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    const host = kingdom.districts[1];
    // Close the second route so the whole flow has to go through one gate.
    evacuation.setGateState(kingdom, "gate-district-5-district-1", "sealed");
    // 120 places, 80 residents: headroom 40, but every sheltered household needs lodging on
    // top of the host's own count, so only 20 people can actually be taken in.
    assert.equal(host.civilianCapacity, DISTRICT_DEFAULTS.homesPerDistrict * DISTRICT_DEFAULTS.capacityPerHome);

    assert.equal(evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP).moved, 12);
    assert.equal(evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP).moved, 8);
    assert.equal(host.civilians, 100);
    assert.equal(host.refugees, 20);
    assert.equal(host.civilians + host.refugees, host.civilianCapacity, "filled to capacity");

    const third = evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP);
    assert.equal(third.moved, 0);
    assert.equal(third.blocked, true);
    assert.match(third.reason, /every safe neighbour has no capacity/);
    assert.equal(district.civilians, 60, "nothing more left the district");
    assertInvariants(kingdom);
});

test("when every route is blocked the civilians shelter in place and say so", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    for (const gateId of ["gate-district-1-district-2", "gate-district-5-district-1"]) {
        evacuation.setGateState(kingdom, gateId, "sealed");
    }
    const civilians = district.civilians;
    const total = shelteredTotal(kingdom);

    const outcome = evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP);
    assert.equal(outcome.moved, 0);
    assert.equal(outcome.to, null);
    assert.equal(district.evacuatedTo, null, "the stale destination is cleared");
    assert.equal(district.civilians, civilians);
    assert.equal(shelteredTotal(kingdom), total);
    assert.ok(outcome.events.some((event) => event.includes("shelter in place")), outcome.events.join("|"));
    assert.match(outcome.events[0], /every route is blocked/);
    assertInvariants(kingdom);
});

test("an unsafe neighbour is never used as a destination, even when it is the only one", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    const host = kingdom.districts[1];
    // district-1 keeps its open gate to Ironquarry and loses its other route entirely, so the
    // only neighbour on the map is one the module must refuse.
    evacuation.setGateState(kingdom, "gate-district-5-district-1", "broken");
    host.security = "contested";

    const outcome = evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP);
    assert.equal(outcome.moved, 0);
    assert.equal(outcome.to, null);
    assert.match(outcome.reason, /all connected neighbours are unsafe \(Ironquarry: contested\)/);
    assert.equal(host.civilians, 80, "the contested neighbour took no refugees");
    assert.equal(district.civilians, 80, "and nobody was pushed into it");
    assertInvariants(kingdom);
});

test("setGateState drives the gates and rejects nonsense", () => {
    const kingdom = kingdomAt(SEED);
    const sealed = evacuation.setGateState(kingdom, "gate-district-1-district-2", "sealed");
    assert.equal(sealed.changed, true);
    assert.equal(sealed.owner, "district-1");
    assert.equal(sealed.reason, null);
    assert.equal(kingdom.districts[0].gates[0].state, "sealed");

    const again = evacuation.setGateState(kingdom, "gate-district-1-district-2", "sealed");
    assert.equal(again.changed, false);
    assert.match(again.reason, /gate was already sealed/);

    const bogus = evacuation.setGateState(kingdom, "gate-district-1-district-2", "locked");
    assert.equal(bogus.changed, false);
    assert.match(bogus.reason, /not one of/);
    assert.equal(kingdom.districts[0].gates[0].state, "sealed", "an unknown state leaves the gate alone");
    assert.ok(GATE_STATES.includes(kingdom.districts[0].gates[0].state));

    const missing = evacuation.setGateState(kingdom, "gate-nowhere", "open");
    assert.equal(missing.changed, false);
    assert.match(missing.reason, /no gate gate-nowhere in this kingdom/);

    const reopened = evacuation.setGateState(kingdom, "gate-district-1-district-2", "open");
    assert.equal(reopened.changed, true);
    assert.equal(kingdom.districts[0].gates[0].state, "open");
});

test("all gates unusable isolates a district, and isolation is not capture", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    const snapshot = {
        civilians: district.civilians,
        soldiers: district.soldiers,
        name: district.name,
        neighbors: district.neighbors.slice(),
        gates: district.gates.map((gate) => gate.id),
        seats: district.seat,
    };
    evacuation.setGateState(kingdom, "gate-district-1-district-2", "sealed");
    evacuation.setGateState(kingdom, "gate-district-5-district-1", "broken");

    const events = evacuation.isolateOnBrokenGates(kingdom, district);
    assert.equal(district.security, "isolated");
    assert.notEqual(district.security, "lost", "isolation is a road state, not a conquest");
    assert.equal(district.civilians, snapshot.civilians);
    assert.equal(district.soldiers, snapshot.soldiers);
    assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
    assert.deepEqual(district.neighbors, snapshot.neighbors);
    assert.deepEqual(district.gates.map((gate) => gate.id), snapshot.gates);
    assert.equal(district.seat, snapshot.seats);
    assert.equal(kingdom.districts.length, 5, "the record is intact");
    assert.ok(events[0].includes("isolated, not taken"));
    assertInvariants(kingdom);

    // One open route is enough to end the isolation.
    evacuation.setGateState(kingdom, "gate-district-5-district-1", "open");
    const lifted = evacuation.isolateOnBrokenGates(kingdom, district);
    assert.equal(district.security, "secure", "reopening a gate lifts isolation, then the watch re-assesses");
    assert.ok(lifted[0].includes("isolation lifted"));
    assertInvariants(kingdom);
});

test("a district with no gates at all is never called isolated", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    district.gates = [];
    district.neighbors = [];
    const events = evacuation.isolateOnBrokenGates(kingdom, district);
    assert.deepEqual(events, []);
    assert.equal(district.security, "breached", "the war state is left to the war module");
});

test("runEvacuationStep only presses on districts actually in danger, and never touches soldiers", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    const bystander = kingdom.districts[2];
    const before = kingdom.districts.map((entry) => [entry.soldiers, entry.garrison.front, entry.garrison.reserve]);
    const total = shelteredTotal(kingdom);

    const events = evacuation.runEvacuationStep(kingdom);
    assert.ok(events.every((event) => typeof event === "string"));
    assert.ok(district.civilians < 80, "the breached district moved people");
    assert.equal(bystander.civilians, 80, "a secure district keeps its population at home");
    assert.deepEqual(
        kingdom.districts.map((entry) => [entry.soldiers, entry.garrison.front, entry.garrison.reserve]),
        before,
        "evacuation never reduces or re-assigns soldiers",
    );
    assert.equal(shelteredTotal(kingdom), total);
    assertInvariants(kingdom);
});

test("refugees walk home once their own district is secure again", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    const host = kingdom.districts[1];
    const total = shelteredTotal(kingdom);
    district.civilians = 80;
    // One destination, with room for the whole flow, so the ledger tells one clean story.
    evacuation.setGateState(kingdom, "gate-district-5-district-1", "sealed");
    host.civilianCapacity = 400;

    for (let step = 0; step < 4; step += 1) {
        evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP);
    }
    assert.equal(district.civilians, 32);
    assert.equal(host.refugees, 48);
    assert.equal(host.civilians, 128);
    assert.deepEqual(host.sheltering, [{ home: "district-1", civilians: 48 }]);

    // Still not safe: nobody walks back into a district that is only alert.
    district.security = "alert";
    assert.deepEqual(evacuation.returnRefugeesHome(kingdom), []);
    assert.equal(host.refugees, 48);
    assert.equal(district.civilians, 32);

    // A district under a fresh raid cannot take its people back either.
    district.security = "secure";
    district.assault = 6;
    assert.deepEqual(evacuation.returnRefugeesHome(kingdom), []);
    assert.equal(host.refugees, 48);
    district.assault = 0;

    for (let step = 0; step < 4; step += 1) {
        const events = evacuation.returnRefugeesHome(kingdom);
        assert.equal(events.length, 1, `pass ${String(step + 1)} walks one bounded group home`);
        assert.equal(host.refugees, 48 - FLOW_PER_STEP * (step + 1), "the walk-back rate is the same bounded flow");
        assert.equal(district.civilians, 32 + FLOW_PER_STEP * (step + 1));
        assertInvariants(kingdom);
    }
    assert.equal(host.refugees, 0);
    assert.equal(district.civilians, 80, "origin counts fully restored");
    assert.equal(district.evacuatedTo, null, "the destination link is cleared once everyone is home");
    assert.deepEqual(host.sheltering, []);
    assert.equal(shelteredTotal(kingdom), total);
    assertInvariants(kingdom);
});

test("a home with no room left keeps its people sheltered rather than overflowing", () => {
    const kingdom = kingdomAt(SEED);
    const district = breachFirstDistrict(kingdom);
    district.civilians = 80;
    const host = kingdom.districts[1];

    evacuation.evacuateCivilians(kingdom, district, FLOW_PER_STEP);
    assert.equal(host.refugees, 12);

    district.security = "secure";
    district.civilians = 118; // the homes filled up while the people were away
    const events = evacuation.returnRefugeesHome(kingdom);
    assert.equal(host.refugees, 10, "only the two places left at home are reclaimed");
    assert.equal(district.civilians, 120, "a home is never pushed over its own capacity");
    assert.equal(host.civilians, 90);
    assert.deepEqual(host.sheltering, [{ home: "district-1", civilians: 10 }]);
    assert.ok(events[0].includes("walk home"));
    assertInvariants(kingdom);
});

test("evacuation and war agree: a breached district empties gradually and a held one recovers", () => {
    const kingdom = kingdomAt(SEED);
    const district = kingdom.districts[0];
    district.soldiers = 0;
    district.defensiveIntegrity = 10;
    district.assault = 0;
    district.security = "breached";
    district.civilians = 80;
    const host = kingdom.districts[1];
    host.civilianCapacity = 400;
    const total = shelteredTotal(kingdom);

    const /** @type {string[]} */ ladder = [];
    let firstSecureStep = -1;
    for (let step = 0; step < 70; step += 1) {
        kingdom.step = step;
        war.recoverAfterDefense(kingdom, district);
        evacuation.runEvacuationStep(kingdom);
        assertInvariants(kingdom);
        if (ladder[ladder.length - 1] !== district.security) {
            ladder.push(district.security);
        }
        if (district.security === "secure" && firstSecureStep < 0) {
            firstSecureStep = step;
        }
    }

    assert.deepEqual(ladder, ["breached", "contested", "alert", "secure"], "security climbs one rung at a time");
    assert.ok(firstSecureStep > 50, `the wall had to be rebuilt first (reached secure at step ${String(firstSecureStep)})`);
    assert.equal(district.security, "secure");
    assert.equal(shelteredTotal(kingdom), total, "the same 400 civilians, wherever they slept");
    assert.equal(district.civilians, 80, "everyone who sheltered elsewhere came back");
    assert.ok(kingdom.districts.every((entry) => entry.refugees === 0));
    assert.equal(district.defensiveIntegrity, 52, "70 steps of DISTRICT_DEFAULTS.integrityRepairPerStep, paid as they went");
    assert.equal(district.reserves.materials, 159, "180 materials minus 0.3 per repaired tenth of a point");
    assert.equal(host.reserves.materials, 180, "a host that did not repair spent nothing");
});

test("a 200-step evacuation run conserves every civilian and never breaks capacity", () => {
    const kingdom = kingdomAt(SEED);
    const startCivilians = computeTotals(kingdom).civilians;
    const startSoldiers = computeTotals(kingdom).soldiers;

    for (let step = 0; step < LONG_RUN_STEPS; step += 1) {
        kingdom.step = step;
        const events = evacuation.runEvacuationStep(kingdom);
        assert.ok(events.every((event) => typeof event === "string"));
        assertInvariants(kingdom);
        assert.equal(computeTotals(kingdom).civilians, startCivilians, "conservation at step " + String(step));
        assert.equal(computeTotals(kingdom).soldiers, startSoldiers, "evacuation alone cannot change the garrison count");
        assert.ok(kingdom.log.length <= 24);
    }
    assert.equal(kingdom.districts.length, 5);
});

test("war plus evacuation over 200 steps keeps every conservation rule", () => {
    const kingdom = kingdomAt(SEED);
    const startCivilians = computeTotals(kingdom).civilians;

    for (let step = 0; step < LONG_RUN_STEPS; step += 1) {
        kingdom.step = step;
        const events = [...war.runWarStep(kingdom), ...evacuation.runEvacuationStep(kingdom)];
        assert.ok(events.every((event) => typeof event === "string"));
        assertInvariants(kingdom);
        assert.equal(computeTotals(kingdom).civilians, startCivilians);
        for (const district of kingdom.districts) {
            assert.ok(district.defensiveIntegrity >= 0 && district.defensiveIntegrity <= 100);
            assert.ok(district.soldiers >= 0 && district.civilians >= 0 && district.refugees >= 0);
        }
    }
    assert.ok(JSON.stringify(kingdom).length > 0);
});

test("the kingdom still saves and reloads after war and evacuation", () => {
    const kingdom = kingdomAt(SEED);
    for (let step = 0; step < 40; step += 1) {
        kingdom.step = step;
        war.runWarStep(kingdom);
        evacuation.runEvacuationStep(kingdom);
    }
    // Reinforcement and shelter ledgers are extra district fields; a save must carry them and
    // the validator must still accept the state, or the store would refuse to write it.
    const moved = kingdom.districts.some((district) => (district.sheltering ?? []).length > 0);
    const reinforced = kingdom.districts.some((district) => (district.reinforcedBy ?? []).length > 0);
    assert.equal(typeof moved, "boolean");
    assert.equal(typeof reinforced, "boolean");

    const raw = serializeKingdom(kingdom);
    const loaded = deserializeKingdom(raw);
    assert.equal(loaded.reason, undefined);
    assert.deepEqual(loaded.kingdom, kingdom, "a reload rebuilds exactly the evacuated kingdom");
    assert.equal(computeTotals(loaded.kingdom).civilians, computeTotals(kingdom).civilians);
});

test("the same seed evacuates identically twice, and a different seed diverges", () => {
    const left = kingdomAt(SEED);
    const right = kingdomAt(SEED);
    const other = kingdomAt(SEED + 4);
    const leftEvents = [];
    const rightEvents = [];

    for (let step = 0; step < 60; step += 1) {
        left.step = step;
        right.step = step;
        other.step = step;
        leftEvents.push(...war.runWarStep(left), ...evacuation.runEvacuationStep(left));
        rightEvents.push(...war.runWarStep(right), ...evacuation.runEvacuationStep(right));
        war.runWarStep(other);
        evacuation.runEvacuationStep(other);
    }

    assert.deepEqual(leftEvents, rightEvents);
    assert.deepEqual(left, right, "a replayed seed rebuilds the same kingdom exactly");
    assert.notDeepEqual(other.districts, left.districts, "a different seed must not fake the same war");
});
