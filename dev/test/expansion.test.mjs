import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const { createInitialKingdom, computeTotals, findValidationProblems } = await loadModule("kingdom", "state.js");
const expansion = await loadModule("sim", "expansion.js");
const construction = await loadModule("sim", "construction.js");
const population = await loadModule("sim", "population.js");

const { EXPANSION_RULES, claimTerritory, describeTerritories, establishMilitaryControl,
    evaluateExpansion, fieldArmy, recordExternalVictory, runExpansionStep, advanceMilitaryUpkeep } = expansion;
const { DISTRICT_DEFAULTS, EXPANSION_PROJECT_PLAN, PROJECT_TYPES } = config;

function dp1(value) {
    return Math.round(value * 10) / 10;
}

/**
 * The first stage of every planned project, at the balanced margin. Written out here so a
 * silent retune of the catalogue shows up as a failing test rather than a quiet nerf.
 */
const BALANCED_RESERVES = { food: 15, materials: 83.8, supplies: 13.8 };

function openKingdom() {
    const kingdom = createInitialKingdom();
    return kingdom;
}

/** wild -> raided -> military: the only order the rules allow. */
function occupyLand(kingdom, territoryId = "land-1", atStep = 0) {
    kingdom.step = atStep;
    assert.equal(recordExternalVictory(kingdom, territoryId).ok, true, "first victory opens the land");
    assert.equal(recordExternalVictory(kingdom, territoryId).ok, true, "the follow-up pushes it to military");
    return establishMilitaryControl(kingdom, territoryId);
}

/** A kingdom that is allowed to take `land-1` right now. */
function readyKingdom(policy = "balanced") {
    const kingdom = openKingdom();
    occupyLand(kingdom, "land-1", 0);
    kingdom.policy.expansion = policy;
    return kingdom;
}

function totalReserves(kingdom, field) {
    return dp1(kingdom.districts.reduce((sum, district) => sum + Number(district.reserves[field]), 0));
}

test("a victory beyond the border walks the land along wild -> raided -> military", () => {
    const kingdom = openKingdom();
    const land = kingdom.territory[0];
    kingdom.step = 6;
    assert.equal(land.status, "wild");
    assert.equal(land.unlockedAtStep, null);

    const first = recordExternalVictory(kingdom, "land-1");
    assert.deepEqual({ ok: first.ok, from: first.from, to: first.to }, { ok: true, from: "wild", to: "raided" });
    assert.equal(land.status, "raided");
    assert.equal(land.unlockedAtStep, 6, "the step it first left wild is the step it was unlocked");
    assert.ok(land.surveyProgress > 0);

    const second = recordExternalVictory(kingdom, "land-1");
    assert.deepEqual({ from: second.from, to: second.to }, { from: "raided", to: "military" });
    assert.equal(land.unlockedAtStep, 6, "an existing unlock stamp is never overwritten");

    // Recording is history, not an action: the seed cursor moves and stays a valid integer.
    assert.notEqual(kingdom.rngState, kingdom.seed >>> 0);
    assert.ok(Number.isInteger(kingdom.rngState) && kingdom.rngState >= 0);

    land.status = "kingdom";
    assert.match(recordExternalVictory(kingdom, "land-1").reason, /already kingdom land/);
    assert.equal(recordExternalVictory(kingdom, "land-1").ok, false);
    assert.match(recordExternalVictory(kingdom, "land-42").reason, /territory 'land-42' does not exist/);
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("military control is temporary: unpaid upkeep reverts the land to wild", () => {
    const kingdom = openKingdom();
    const land = kingdom.territory[0];
    const district = kingdom.districts[0];

    assert.match(establishMilitaryControl(kingdom, "land-3").reason, /still wild/);
    assert.equal(land.status, "wild", "a refused control must not change the status");

    occupyLand(kingdom, "land-1", 4);
    assert.equal(land.status, "military");
    const upkeep = EXPANSION_RULES.upkeepPerStep;
    assert.equal(district.reserves.food, dp1(DISTRICT_DEFAULTS.startingFood - upkeep.food));
    assert.equal(district.reserves.materials, dp1(DISTRICT_DEFAULTS.startingMaterials - upkeep.materials));

    // Two steps the stores cannot cover are warned about, not fatal.
    district.reserves = { food: 0, materials: 0, supplies: 0 };
    const warnings = advanceMilitaryUpkeep(kingdom);
    assert.equal(land.status, "military");
    assert.match(warnings.join(" "), /1\/3 unpaid steps/);
    advanceMilitaryUpkeep(kingdom);
    assert.equal(land.upkeepMissedSteps, 2);

    // A payment resets the debt.
    district.reserves = { food: 50, materials: 50, supplies: 50 };
    advanceMilitaryUpkeep(kingdom);
    assert.equal(land.upkeepMissedSteps, 0);

    district.reserves = { food: 0, materials: 0, supplies: 0 };
    const lines = [];
    for (let step = 0; step < EXPANSION_RULES.maxMissedUpkeep; step += 1) {
        kingdom.step += 1;
        lines.push(...advanceMilitaryUpkeep(kingdom));
    }
    assert.equal(land.status, "wild", "the failed expansion path ends back in the wild");
    assert.match(lines.join("\n"), /collapsed after 3 unpaid steps/);
    assert.equal(land.upkeepMissedSteps, 0);
    assert.equal(land.militarySteps, 0);
    assert.deepEqual(findValidationProblems(kingdom), []);
    assert.equal(kingdom.districts.length, 5, "a collapsed outpost never leaves a ghost district");
});

test("evaluateExpansion: the verdict each policy mode gives", () => {
    const balanced = readyKingdom("balanced");
    const verdict = evaluateExpansion(balanced, "land-1");
    assert.equal(verdict.eligible, true, verdict.reasons.join("; "));
    assert.deepEqual(verdict.reasons, []);
    assert.deepEqual(verdict.required.reserves, BALANCED_RESERVES);
    assert.deepEqual(verdict.required.security, ["secure"]);
    assert.equal(verdict.required.surplusMargin, 1.25);
    assert.equal(verdict.required.garrison, balanced.territory[0].garrisonRequirement);
    assert.equal(verdict.available.surplusSoldiers, fieldArmy(balanced.districts[0]));
    assert.equal(verdict.available.security, "secure");
    assert.equal(verdict.available.status, "military");

    const paused = readyKingdom("paused");
    const pausedVerdict = evaluateExpansion(paused, "land-1");
    assert.equal(pausedVerdict.eligible, false);
    assert.match(pausedVerdict.reasons.join(" "), /expansion policy is 'paused'/);

    const rogue = readyKingdom("reckless");
    assert.match(evaluateExpansion(rogue, "land-1").reasons.join(" "), /unknown expansion policy 'reckless'/);

    // "rapid" buys speed with the resource margin and nothing else.
    const tightBalanced = readyKingdom("balanced");
    tightBalanced.districts[0].reserves = { food: 40, materials: 70, supplies: 20 };
    const refused = evaluateExpansion(tightBalanced, "land-1");
    assert.equal(refused.eligible, false);
    assert.match(refused.reasons.join(" "), /materials 70 < 83\.8/);

    const tightRapid = readyKingdom("rapid");
    tightRapid.districts[0].reserves = { food: 40, materials: 70, supplies: 20 };
    const rapid = evaluateExpansion(tightRapid, "land-1");
    assert.equal(rapid.eligible, true, rapid.reasons.join("; "));
    assert.deepEqual(rapid.required.reserves, { food: 12, materials: 67, supplies: 11 });

    // Security and integrity are never traded away, not even by "rapid".
    for (const policy of ["balanced", "rapid"]) {
        const hot = readyKingdom(policy);
        hot.districts[0].security = "alert";
        const hotVerdict = evaluateExpansion(hot, "land-1");
        assert.equal(hotVerdict.eligible, false);
        assert.match(hotVerdict.reasons.join(" "), /security of Hearthgate is 'alert'.*never relaxed/s);

        const rubble = readyKingdom(policy);
        rubble.districts[0].defensiveIntegrity = EXPANSION_RULES.minDefensiveIntegrity - 5;
        assert.match(evaluateExpansion(rubble, "land-1").reasons.join(" "), /below the floor/);
    }

    const thin = readyKingdom("rapid");
    thin.districts[0].soldiers = 6;
    population.syncGarrison(thin.districts[0]);
    const thinVerdict = evaluateExpansion(thin, "land-1");
    assert.equal(thinVerdict.eligible, false);
    assert.match(thinVerdict.reasons.join(" "), /garrison surplus 4 is below the 20 soldiers/);

    const empty = readyKingdom("balanced");
    empty.districts[0].civilians = 4;
    const emptyVerdict = evaluateExpansion(empty, "land-1");
    assert.equal(emptyVerdict.eligible, false);
    assert.match(emptyVerdict.reasons.join(" "), /only 1 settlers could be transferred/);

    const wild = openKingdom();
    assert.match(evaluateExpansion(wild, "land-2").reasons.join(" "), /must be under military control first/);
    assert.match(evaluateExpansion(wild, "land-42").reasons.join(" "), /does not exist/);

    // Pure: a verdict is a read, never a side effect.
    const snapshot = JSON.stringify(wild);
    evaluateExpansion(wild, "land-2");
    evaluateExpansion(wild, "land-1");
    assert.equal(JSON.stringify(wild), snapshot);
});

test("a shortage blocks the claim and changes nothing at all", () => {
    const kingdom = readyKingdom("balanced");
    const district = kingdom.districts[0];
    district.reserves = { food: 3, materials: 5, supplies: 1 };
    const snapshot = JSON.stringify(kingdom);

    const result = claimTerritory(kingdom, "land-1");
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(" "), /materials 5 < 83\.8/);
    assert.match(result.reasons.join(" "), /food 3 < 15/);
    assert.match(result.reasons.join(" "), /supplies 1 < 13\.8/);
    assert.match(result.events[0], /refused/);
    assert.equal(kingdom.districts.length, 5);
    assert.equal(kingdom.territory[0].status, "military", "blocked land stays military, it is not silently lost");
    assert.equal(JSON.stringify(kingdom), snapshot);
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("a successful claim adds one district, transfers people, and validates", () => {
    const kingdom = readyKingdom("balanced");
    kingdom.step = 12;
    const district = kingdom.districts[0];
    const land = kingdom.territory[0];
    const totalsBefore = computeTotals(kingdom);
    const storesBefore = { food: totalReserves(kingdom, "food"), materials: totalReserves(kingdom, "materials"), supplies: totalReserves(kingdom, "supplies") };
    const peopleBefore = district.civilians;
    const soldiersBefore = district.soldiers;
    const parentFoodBefore = district.reserves.food;

    const result = claimTerritory(kingdom, "land-1");
    assert.equal(result.ok, true, result.reasons.join("; "));
    assert.deepEqual(result.reasons, []);
    assert.equal(kingdom.districts.length, 6, "exactly one district");

    const seat = result.district;
    assert.equal(seat.id, "district-6");
    assert.equal(seat.name, land.name, "named from the territory it was claimed from");
    assert.equal(seat.seat, 6);

    // Transferred, never duplicated.
    assert.equal(seat.civilians, Math.floor(peopleBefore * EXPANSION_RULES.settlerFraction));
    assert.equal(district.civilians, peopleBefore - seat.civilians);
    assert.equal(seat.soldiers, land.garrisonRequirement);
    assert.equal(district.soldiers, soldiersBefore - seat.soldiers);
    assert.equal(computeTotals(kingdom).civilians, totalsBefore.civilians);
    assert.equal(computeTotals(kingdom).soldiers, totalsBefore.soldiers);
    assert.equal(computeTotals(kingdom).districts, 6);
    assert.ok(seat.civilians > 0 && seat.soldiers > 0);
    assert.ok(seat.civilians <= seat.civilianCapacity);
    for (const field of ["food", "materials", "supplies"]) {
        assert.equal(totalReserves(kingdom, field), storesBefore[field], `${field} was moved, not minted`);
    }
    assert.equal(seat.reserves.food, dp1(parentFoodBefore * EXPANSION_RULES.reserveFraction));
    assert.equal(district.reserves.food, dp1(parentFoodBefore - seat.reserves.food));

    // The hard garrison invariant holds on both sides after the move.
    assert.equal(district.garrison.front + district.garrison.reserve, district.soldiers);
    assert.equal(seat.garrison.front + seat.garrison.reserve, seat.soldiers);

    // Neighbour graph and gates resolve on each side, with the right owner.
    assert.ok(district.neighbors.includes(seat.id));
    assert.ok(seat.neighbors.includes(district.id));
    assert.equal(seat.neighbors.length, 1);
    const parentGate = district.gates.find((gate) => gate.with === seat.id);
    const childGate = seat.gates.find((gate) => gate.with === district.id);
    assert.ok(parentGate, "the parent district gained a gate to the new land");
    assert.ok(childGate, "the new district gates back to its parent");
    assert.equal(parentGate.owner, district.id);
    assert.equal(childGate.owner, seat.id);
    assert.equal(parentGate.state, "open");

    // The standard plan is scheduled with real staged costs, in plan order.
    assert.deepEqual(seat.projects.map((project) => project.kind), EXPANSION_PROJECT_PLAN);
    assert.deepEqual(
        seat.projects.map((project) => project.costPerStage),
        EXPANSION_PROJECT_PLAN.map((kind) => PROJECT_TYPES[kind].cost),
    );
    seat.projects.forEach((project) => {
        assert.equal(project.status, "scheduled");
        assert.equal(project.stage, 0);
        assert.equal(project.districtId, seat.id);
    });
    assert.ok(seat.builders > 0 && seat.builders <= seat.civilians);

    assert.equal(land.status, "kingdom");
    assert.equal(land.claimedAtStep, 12);
    assert.equal(land.unlockedAtStep, 0);
    assert.deepEqual(findValidationProblems(kingdom), []);

    const again = claimTerritory(kingdom, "land-1");
    assert.equal(again.ok, false);
    assert.match(again.reasons.join(" "), /already kingdom land/);
    assert.equal(kingdom.districts.length, 6);
});

test("the claimed land builds against its own stores and stalls loudly when they run out", () => {
    const kingdom = readyKingdom("balanced");
    const result = claimTerritory(kingdom, "land-1");
    const seat = result.district;
    const wallsBefore = seat.buildings.walls;

    const queue = construction.collectBuildQueue(kingdom, config.SIM.maxBlocksPerStep);
    assert.equal(queue.length, EXPANSION_PROJECT_PLAN.length);
    assert.deepEqual(queue.map((entry) => entry.kind), EXPANSION_PROJECT_PLAN);
    assert.equal(queue[0].districtId, seat.id, "the fresh land is the only thing in flight");
    // Geometry from the documented ring: radius = ringMinRadius + (seat - 1) + bandIndex.
    const radius = construction.FOOTPRINT_RULES.ringMinRadius + seat.seat - 1;
    assert.equal(queue[0].blocksPlanned, 8 * radius * PROJECT_TYPES.walls.stages);

    for (let step = 0; step < 3; step += 1) {
        kingdom.step += 1;
        construction.assignBuilders(seat, kingdom);
        construction.advanceConstruction(seat, { kingdom });
        assert.deepEqual(findValidationProblems(kingdom), []);
        assert.ok(seat.buildings.walls >= wallsBefore);
    }

    const walls = seat.projects[0];
    assert.equal(walls.kind, "walls");
    assert.equal(walls.stage, 1, "the transferred stores only cover the first stage");
    assert.equal(walls.status, "stalled");
    assert.match(walls.stalledReason, /cannot pay stage 2 of 6 for 'walls'/);
    assert.ok(kingdom.log.some((entry) => entry.text.includes("STALLED")), "the stall is in the log, not swallowed");
    assert.equal(seat.buildings.walls, wallsBefore);
});

test("a claim that would not validate is rolled back instead of saved", () => {
    const kingdom = readyKingdom("balanced");
    // Pre-existing corruption the claim would otherwise inherit and amplify.
    kingdom.districts[4].neighbors = ["district-99"];
    const snapshot = JSON.stringify(kingdom);

    const result = claimTerritory(kingdom, "land-1", { verdict: { eligible: true, reasons: [] } });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(" "), /claim rolled back, the result would not validate/);
    assert.match(result.reasons.join(" "), /district-99/);
    assert.equal(kingdom.districts.length, 5, "the half-built district must be gone again");
    assert.equal(kingdom.territory[0].status, "military", "the territory flag must be reverted too");
    assert.equal(JSON.stringify(kingdom), snapshot);
});

test("runExpansionStep is bounded, stable-ordered and honours a paused policy", () => {
    const kingdom = readyKingdom("balanced");
    kingdom.step = 1;
    const events = runExpansionStep(kingdom);
    assert.equal(Array.isArray(events), true);
    assert.ok(events.every((line) => typeof line === "string"));
    assert.ok(events.some((line) => line.startsWith("Claimed Ashford Reach as district-6")), events.join("\n"));
    assert.equal(kingdom.districts.length, 6);
    assert.deepEqual(findValidationProblems(kingdom), []);

    // One claim per step, and no land is taken without a victory opening it first.
    const next = runExpansionStep(kingdom);
    assert.equal(next.filter((line) => line.startsWith("Claimed ")).length, 0);
    assert.equal(kingdom.districts.length, 6);

    const surveying = openKingdom();
    runExpansionStep(surveying);
    assert.equal(
        surveying.territory.slice(0, EXPANSION_RULES.maxTerritoriesPerStep).every((land) => land.surveyProgress > 0),
        true,
    );
    assert.equal(
        surveying.territory[EXPANSION_RULES.maxTerritoriesPerStep].surveyProgress,
        0,
        "the survey stops at its per-step bound instead of walking the whole map",
    );

    const paused = readyKingdom("paused");
    const pausedEvents = runExpansionStep(paused);
    assert.equal(pausedEvents.some((line) => line.startsWith("Claimed ")), false);
    assert.equal(paused.districts.length, 5);
    assert.deepEqual(findValidationProblems(paused), []);

    // Upkeep is still charged while paused: a pause is not a free occupation.
    const held = readyKingdom("paused");
    const district = held.districts[0];
    const food = district.reserves.food;
    runExpansionStep(held);
    assert.ok(district.reserves.food < food);
});

test("describeTerritories is a read-only summary of the frontage", () => {
    const kingdom = readyKingdom("balanced");
    const rows = describeTerritories(kingdom);
    assert.equal(rows.length, kingdom.territory.length);
    assert.deepEqual(rows.map((row) => row.id), ["land-1", "land-2", "land-3", "land-4", "land-5"]);
    assert.deepEqual(
        Object.keys(rows[0]).sort(),
        ["adjacentDistrictId", "claimedAtStep", "garrisonRequirement", "id", "knownStatuses", "name", "status",
            "surveyProgress", "unlockedAtStep", "upkeepMissedSteps"],
    );
    assert.equal(rows[0].status, "military");
    assert.equal(rows[1].status, "wild");
    assert.deepEqual(config.TERRITORY_STATES, rows[0].knownStatuses);

    const snapshot = JSON.stringify(kingdom);
    describeTerritories(kingdom);
    assert.equal(JSON.stringify(kingdom), snapshot);
});

test("the same seed replays identically and a different seed diverges", () => {
    /**
     * `rngState` itself is not evidence of a different history - two seeds start at
     * different numbers by definition - so it is stripped from the snapshot.
     */
    const replay = (cursor, steps) => {
        const kingdom = openKingdom();
        kingdom.rngState = cursor;
        occupyLand(kingdom, "land-1", 0);
        for (let step = 1; step <= steps; step += 1) {
            kingdom.step = step;
            runExpansionStep(kingdom);
            kingdom.districts.forEach((district) => {
                construction.assignBuilders(district, kingdom);
                construction.advanceConstruction(district, { kingdom });
            });
            assert.deepEqual(findValidationProblems(kingdom), [], `state must validate at step ${String(step)}`);
        }
        /** @type {any} */
        const snapshot = JSON.parse(JSON.stringify(kingdom));
        delete snapshot.rngState;
        return snapshot;
    };

    assert.deepEqual(replay(4242, 40), replay(4242, 40), "a fixed seed plus a fixed number of steps is one exact kingdom");
    assert.deepEqual(replay(9999, 40), replay(9999, 40), "and that holds for every seed");
    assert.notDeepEqual(replay(4242, 8), replay(9999, 8), "a different seed must not replay the same history");
    assert.notDeepEqual(replay(4242, 8), replay(4242, 9), "and one more step is a different kingdom again");
});
