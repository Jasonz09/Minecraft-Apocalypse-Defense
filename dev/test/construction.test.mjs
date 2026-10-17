import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const { createInitialKingdom, findValidationProblems } = await loadModule("kingdom", "state.js");
const construction = await loadModule("sim", "construction.js");
const population = await loadModule("sim", "population.js");

const { PROJECT_TYPES, DISTRICT_DEFAULTS, SIM } = config;
const VALID_KINDS = Object.keys(PROJECT_TYPES);

/** `spend()` rounds to one decimal, so expectations are stated the same way. */
function dp1(value) {
    return Math.round(value * 10) / 10;
}

/** A district that can pay for a lot of staged work. */
function richKingdom() {
    const kingdom = createInitialKingdom();
    kingdom.districts.forEach((district) => {
        district.reserves = { food: 900, materials: 900, supplies: 900 };
    });
    return kingdom;
}

test("scheduleProject refuses an unknown kind and lists the valid ones", () => {
    const district = createInitialKingdom().districts[0];
    assert.throws(
        () => construction.scheduleProject(district, "cathedral"),
        (error) => /unknown project kind 'cathedral'/.test(error.message)
            && error.message.includes(VALID_KINDS.join(", ")),
    );
    assert.deepEqual(district.projects, [], "a refused schedule must not leave a half-built record");
    assert.throws(() => construction.scheduleProject(null, "homes"), /district must be an object/);
    assert.equal(construction.listProjectKinds(), VALID_KINDS.join(", "));
});

test("a scheduled project is a staged, costed record whose cost is a copy", () => {
    const district = createInitialKingdom().districts[0];
    const project = construction.scheduleProject(district, "walls", { atStep: 5 });

    assert.equal(project.kind, "walls");
    assert.equal(project.districtId, district.id);
    assert.equal(project.stage, 0);
    assert.equal(project.stageCount, PROJECT_TYPES.walls.stages);
    assert.deepEqual(project.costPerStage, PROJECT_TYPES.walls.cost);
    assert.notEqual(project.costPerStage, PROJECT_TYPES.walls.cost, "costPerStage must not alias config.js");
    assert.equal(project.status, "scheduled");
    assert.equal(project.builders, 0, "builders are handed out by assignBuilders, not at schedule time");
    assert.equal(project.createdAtStep, 5);

    project.costPerStage.materials = 9999;
    assert.equal(PROJECT_TYPES.walls.cost.materials, 18, "the shared catalogue can never be edited through a project");

    const catalogue = construction.scheduleProject(district, "road").costPerStage;
    assert.deepEqual(catalogue, PROJECT_TYPES.road.cost);
});

test("a duplicate permanent work is refused on the same district", () => {
    const district = createInitialKingdom().districts[0];
    construction.scheduleProject(district, "walls");
    assert.throws(() => construction.scheduleProject(district, "walls"), /permanent work/);
    construction.scheduleProject(district, "gate");
    assert.throws(() => construction.scheduleProject(district, "gate"), /permanent work/);
    assert.equal(district.projects.length, 2);

    // A non-permanent kind may be re-queued once the earlier record is finished.
    const road = construction.scheduleProject(district, "road");
    assert.throws(() => construction.scheduleProject(district, "road"), /already has an in-flight 'road'/);
    road.status = "complete";
    const second = construction.scheduleProject(district, "road");
    assert.equal(second.id, `${district.id}-road-2`);
    assert.deepEqual(construction.PERMANENT_KINDS, ["walls", "gate"]);
});

test("staged construction pays its real cost out of the district reserves", () => {
    const kingdom = richKingdom();
    const district = kingdom.districts[0];
    const cost = PROJECT_TYPES.homes.cost;
    const before = { ...district.reserves };
    const homesBefore = district.buildings.homes;
    const capacityBefore = district.civilianCapacity;

    construction.scheduleProject(district, "homes");
    const seen = [];
    for (let step = 0; step < PROJECT_TYPES.homes.stages; step += 1) {
        kingdom.step = step;
        construction.assignBuilders(district, kingdom);
        const result = construction.advanceConstruction(district, { kingdom });
        assert.equal(result.stalled, 0, `step ${String(step)} should not stall`);
        assert.equal(result.advanced, 1);
        assert.equal(result.completed, step === PROJECT_TYPES.homes.stages - 1 ? 1 : 0);
        seen.push(district.projects[0].stage);
        assert.equal(district.reserves.materials, dp1(before.materials - cost.materials * (step + 1)));
        assert.equal(district.reserves.supplies, dp1(before.supplies - cost.supplies * (step + 1)));
    }

    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.equal(district.projects[0].status, "complete");
    assert.equal(district.buildings.homes, homesBefore + 1);
    assert.equal(district.civilianCapacity, capacityBefore + DISTRICT_DEFAULTS.capacityPerHome);
    assert.equal(district.builders, 0, "the crew is released when the site finishes");
    assert.equal(district.projects[0].builders, 0);
    assert.equal(district.reserves.materials, dp1(before.materials - cost.materials * 4));
    assert.deepEqual(findValidationProblems(kingdom), []);
    assert.ok(kingdom.log.some((entry) => entry.text.includes("homes COMPLETE")), "completion is reported");
});

test("a stage that cannot be paid stalls loudly instead of being skipped", () => {
    const kingdom = createInitialKingdom();
    const district = kingdom.districts[0];
    district.reserves = { food: 1, materials: 12, supplies: 0 };
    const snapshot = JSON.stringify(district.reserves);

    construction.scheduleProject(district, "homes");
    construction.assignBuilders(district, kingdom);
    const result = construction.advanceConstruction(district, { kingdom });

    assert.equal(result.advanced, 0);
    assert.equal(result.stalled, 1);
    const project = district.projects[0];
    assert.equal(project.status, "stalled");
    assert.equal(project.stage, 0, "an unpaid stage must not be counted as built");
    assert.match(project.stalledReason, /cannot pay stage 1 of 4 for 'homes'/);
    assert.match(project.stalledReason, /food 1 < 2/);
    assert.match(project.stalledReason, /supplies 0 < 1/);
    assert.equal(result.events[0], `${district.name}: STALLED ${project.id} - ${project.stalledReason}`);
    assert.equal(JSON.stringify(district.reserves), snapshot, "a stalled stage must not consume anything");

    // Filling the stores resumes the same project where it stopped.
    district.reserves.materials = 60;
    district.reserves.food = 60;
    district.reserves.supplies = 60;
    construction.assignBuilders(district, kingdom);
    const resumed = construction.advanceConstruction(district, { kingdom });
    assert.equal(resumed.advanced, 1);
    assert.equal(project.status, "active");
    assert.equal(project.stalledReason, null);
    assert.equal(project.stage, 1);
});

test("a project with no crew stalls on builders, not on money", () => {
    const kingdom = richKingdom();
    const district = kingdom.districts[0];
    district.civilians = 0;
    construction.scheduleProject(district, "walls");
    construction.assignBuilders(district, kingdom);
    const result = construction.advanceConstruction(district, { kingdom });
    assert.equal(result.stalled, 1);
    assert.match(district.projects[0].stalledReason, /short of builders: 0 of 6/);
    assert.equal(district.projects[0].stage, 0);
    assert.equal(district.reserves.materials, 900, "no labour means no spend");
});

test("builders come out of the civilian pool and are released when the district is attacked", () => {
    const kingdom = richKingdom();
    const district = kingdom.districts[0];
    district.civilians = 5;

    construction.scheduleProject(district, "walls");
    construction.scheduleProject(district, "gate");
    const assigned = construction.assignBuilders(district, kingdom);

    assert.equal(assigned.needed, PROJECT_TYPES.walls.buildersRequired + PROJECT_TYPES.gate.buildersRequired);
    assert.equal(assigned.assigned, 5, "the pool caps the crew, not the wish list");
    assert.equal(district.builders, 5);
    assert.ok(district.builders <= district.civilians);
    // Insertion order is the queue order, so the walls on the plan's first line are crewed first.
    assert.equal(district.projects[0].kind, "walls");
    assert.equal(district.projects[0].builders, 5);
    assert.equal(district.projects[1].kind, "gate");
    assert.equal(district.projects[1].builders, 0);

    const raided = construction.advanceConstruction(district, {
        kingdom,
        canWork: false,
        reason: "raiders at the gate",
    });
    assert.equal(district.builders, 0, "labour walks off the site during an attack");
    assert.equal(district.projects[0].builders, 0);
    assert.equal(raided.stalled, 2);
    assert.match(district.projects[0].stalledReason, /labour withdrawn: raiders at the gate/);

    const withdrawn = construction.assignBuilders(district, kingdom, { canWork: false, reason: "assault" });
    assert.deepEqual(
        { assigned: withdrawn.assigned, released: withdrawn.released, reason: withdrawn.reason },
        { assigned: 0, released: 0, reason: "assault" },
    );
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("assignBuilders never spends people twice, even with a huge queue", () => {
    const kingdom = richKingdom();
    const district = kingdom.districts[0];
    district.civilians = 10;
    VALID_KINDS.forEach((kind) => construction.scheduleProject(district, kind));

    const assigned = construction.assignBuilders(district, kingdom);
    assert.equal(assigned.assigned, 10, "the whole pool is working and not one person more");
    assert.ok(assigned.needed > 10);
    assert.ok(assigned.released > 0, "the shortfall is reported, not hidden");
    const total = district.projects.reduce((sum, project) => sum + project.builders, 0);
    assert.equal(total, district.builders);
    assert.ok(district.builders <= district.civilians);

    // The earliest planned work is crewed first, so the walls on line one are never starved.
    assert.equal(district.projects[0].kind, "walls");
    assert.equal(district.projects[0].builders, PROJECT_TYPES.walls.buildersRequired);
    district.civilians = 3;
    assert.equal(construction.assignBuilders(district, kingdom).assigned, 3);
    assert.equal(district.projects[0].builders, 3, "a shrinking pool shrinks the crew instead of breaking the invariant");
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("homes raise capacity and farms raise food output", () => {
    const kingdom = richKingdom();
    const district = kingdom.districts[0];
    assert.equal(district.civilianCapacity, DISTRICT_DEFAULTS.homesPerDistrict * DISTRICT_DEFAULTS.capacityPerHome);
    assert.equal(population.farmFoodOutput(district), dp1(DISTRICT_DEFAULTS.farmsPerDistrict * DISTRICT_DEFAULTS.foodPerFarmPerStep));

    const build = (kind) => {
        construction.scheduleProject(district, kind);
        for (let step = 0; step < PROJECT_TYPES[kind].stages; step += 1) {
            kingdom.step += 1;
            construction.assignBuilders(district, kingdom);
            const result = construction.advanceConstruction(district, { kingdom });
            assert.equal(result.stalled, 0);
        }
    };

    build("farms");
    assert.equal(district.buildings.farms, DISTRICT_DEFAULTS.farmsPerDistrict + 1);
    assert.equal(population.farmFoodOutput(district), dp1(5 * DISTRICT_DEFAULTS.foodPerFarmPerStep));
    assert.ok(population.farmFoodOutput(district) > dp1(4 * DISTRICT_DEFAULTS.foodPerFarmPerStep));

    build("homes");
    assert.equal(district.buildings.homes, DISTRICT_DEFAULTS.homesPerDistrict + 1);
    assert.equal(district.civilianCapacity, 7 * DISTRICT_DEFAULTS.capacityPerHome);

    build("walls");
    build("gate");
    build("barracks");
    build("storehouse");
    build("road");
    assert.equal(district.buildings.walls, 2);
    assert.equal(district.buildings.gates, 1);
    assert.equal(district.buildings.roads, 1);
    assert.equal(district.buildings.barracks, DISTRICT_DEFAULTS.barracksPerDistrict + 1);
    assert.equal(district.buildings.storehouses, DISTRICT_DEFAULTS.storehousesPerDistrict + 1);
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("existing walls are never removed across a long bounded run", () => {
    const kingdom = createInitialKingdom();
    const district = kingdom.districts[0];
    district.reserves = { food: 400, materials: 400, supplies: 400 };
    district.defensiveIntegrity = 70;

    construction.scheduleProject(district, "walls");
    construction.scheduleProject(district, "gate");
    construction.scheduleProject(district, "homes");
    construction.scheduleProject(district, "farms");
    construction.scheduleProject(district, "road");

    let wallsSeen = district.buildings.walls;
    let integritySeen = district.defensiveIntegrity;
    let capacitySeen = district.civilianCapacity;

    for (let step = 0; step < 400; step += 1) {
        kingdom.step = step;
        const canWork = step % 7 !== 0;
        district.reserves = { food: 400, materials: 400, supplies: 400 };
        construction.assignBuilders(district, kingdom, { canWork });
        construction.advanceConstruction(district, { kingdom, canWork, reason: "hostiles on the approach" });

        // A commander who tries to take the defences away is refused, every single step.
        assert.throws(
            () => construction.cancelProject(district, `${district.id}-walls-1`),
            /permanent work/,
            `step ${String(step)}: walls project must be uncancellable`,
        );
        assert.throws(() => construction.removeProject(district, `${district.id}-gate-1`), /permanent work/);

        // Ordinary work is cancelled and re-queued over and over; the permanent record never moves.
        if (step % 5 === 4) {
            const live = district.projects.find(
                (project) => project.kind === "road" && !["complete", "cancelled"].includes(project.status),
            );
            if (live !== undefined) {
                construction.cancelProject(district, live.id, { reason: "re-planned", kingdom });
            } else {
                construction.scheduleProject(district, "road", { atStep: step });
            }
        }

        for (const project of district.projects) {
            if (project.permanent !== true) {
                continue;
            }
            assert.notEqual(
                project.status,
                "cancelled",
                `step ${String(step)}: ${String(project.kind)} defence was removed`,
            );
            assert.ok(project.kind !== "walls" || project.stage >= 0);
        }

        assert.ok(
            district.buildings.walls >= wallsSeen,
            `step ${String(step)}: buildings.walls fell from ${String(wallsSeen)} to ${String(district.buildings.walls)}`,
        );
        assert.ok(
            district.defensiveIntegrity >= integritySeen - 1e-9,
            `step ${String(step)}: defensiveIntegrity fell from ${String(integritySeen)} to ${String(district.defensiveIntegrity)}`,
        );
        assert.ok(district.civilianCapacity >= capacitySeen);
        assert.ok(district.builders <= district.civilians);
        assert.ok(district.civilians >= 0);

        wallsSeen = district.buildings.walls;
        integritySeen = district.defensiveIntegrity;
        capacitySeen = district.civilianCapacity;
        if (step % 25 === 0) {
            assert.deepEqual(findValidationProblems(kingdom), [], `state must validate at step ${String(step)}`);
        }
    }

    assert.equal(district.buildings.walls, 2, "the standing wall plus the one that was built");
    assert.equal(district.defensiveIntegrity, 100, "repair is allowed, decay is not");
    assert.ok(district.civilianCapacity > 120, "homes kept being added");
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("cancelProject refuses permanent kinds and built structures, and releases the crew", () => {
    const kingdom = createInitialKingdom();
    const district = kingdom.districts[0];
    const walls = construction.scheduleProject(district, "walls");
    const road = construction.scheduleProject(district, "road");
    construction.assignBuilders(district, kingdom);
    assert.ok(district.builders > 0);

    assert.throws(
        () => construction.cancelProject(district, walls.id, { reason: "scrap the wall", kingdom }),
        (error) => /refused to cancel 'walls'/.test(error.message) && /permanent work/.test(error.message)
            && /never removed automatically/.test(error.message),
    );
    assert.throws(() => construction.removeProject(district, walls.id), /refused to cancel/);
    assert.equal(district.buildings.walls, DISTRICT_DEFAULTS.wallsPerDistrict);

    construction.cancelProject(district, road.id, { reason: "the road was moved", kingdom });
    assert.equal(road.status, "cancelled");
    assert.equal(road.builders, 0);
    assert.equal(district.builders, PROJECT_TYPES.walls.buildersRequired, "only the wall crew is left on site");
    assert.ok(kingdom.log.some((entry) => entry.text.includes("cancelled - the road was moved")));

    // A finished structure is part of the record and cannot be removed either.
    const homes = construction.scheduleProject(district, "homes");
    homes.status = "complete";
    const homesBefore = district.buildings.homes;
    assert.throws(() => construction.cancelProject(district, homes.id), /already built/);
    assert.equal(district.buildings.homes, homesBefore);
    assert.throws(() => construction.cancelProject(district, "no-such-project"), /has no project/);
});

test("collectBuildQueue is bounded, read-only and free of any world access", () => {
    const kingdom = createInitialKingdom();
    kingdom.districts.forEach((district) => {
        construction.scheduleProject(district, "walls");
        construction.scheduleProject(district, "homes");
    });

    const full = construction.collectBuildQueue(kingdom);
    assert.equal(full.length, 10, "well under SIM.maxBlocksPerStep, so everything in flight is visible");
    assert.deepEqual(
        full.map((entry) => `${String(entry.districtId)}/${String(entry.projectId)}`).slice(0, 2),
        ["district-1/district-1-walls-1", "district-1/district-1-homes-1"],
        "stable district then plan order",
    );
    assert.deepEqual(
        Object.keys(full[0]).sort(),
        ["blocksPlanned", "districtId", "kind", "projectId", "remainingStages", "stage"],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(full)), full, "the view is plain serialisable data, no live records");
    assert.equal(typeof full[0].blocksPlanned, "number");

    // The documented geometry: walls lay a square ring of 8 * radius blocks per stage,
    // radius = ringMinRadius + (seat - 1) + bandIndex, and district-1 has seat 1.
    const radius = construction.FOOTPRINT_RULES.ringMinRadius + 0;
    assert.equal(full[0].blocksPlanned, 8 * radius * PROJECT_TYPES.walls.stages);
    assert.equal(full[0].remainingStages, PROJECT_TYPES.walls.stages);
    assert.equal(full[1].blocksPlanned, 9 * PROJECT_TYPES.homes.stages, "homes are a fixed 3x3 cottage per stage");

    assert.equal(construction.collectBuildQueue(kingdom, 3).length, 3);
    assert.equal(construction.collectBuildQueue(kingdom, 1)[0].districtId, "district-1");
    assert.equal(construction.collectBuildQueue(kingdom, 0).length, 0);
    assert.equal(construction.collectBuildQueue(kingdom, -7).length, 0);
    assert.equal(construction.collectBuildQueue(kingdom, undefined).length, 10);
    assert.equal(
        construction.collectBuildQueue(kingdom, 4096).length,
        10,
        "a huge limit cannot make the view unbounded - only real work is listed",
    );
    assert.equal(construction.FOOTPRINT_RULES.maxEntries >= SIM.maxBlocksPerStep, true);
    assert.equal(construction.footprintBlocksPerStage("walls", 4), 32);
    assert.equal(construction.footprintBlocksPerStage("mystery", 4), 0);

    const snapshot = JSON.stringify(kingdom);
    construction.collectBuildQueue(kingdom, 10);
    construction.collectBuildQueue(kingdom);
    assert.equal(JSON.stringify(kingdom), snapshot, "collectBuildQueue must not mutate the saved state");

    // Completed work leaves the queue and its planned blocks drop with every paid stage.
    const district = kingdom.districts[0];
    district.reserves = { food: 900, materials: 900, supplies: 900 };
    const before = construction.collectBuildQueue(kingdom, 2);
    construction.assignBuilders(district, kingdom);
    construction.advanceConstruction(district, { kingdom });
    const after = construction.collectBuildQueue(kingdom, 2);
    assert.equal(after[0].blocksPlanned < before[0].blocksPlanned, true, "paid stages plan fewer blocks");
});

test("the construction, expansion and population modules never import the Minecraft API", () => {
    // JSDoc `import("@minecraft/server")` type references are erased at runtime; only a
    // real `from` import would break loading these modules in plain Node.
    const runtimeImport = /(^|\n)\s*import\s[^;\n]*from\s*["']@minecraft\/server["']|(?:^|\n)\s*import\s*["']@minecraft\/server["']/;

    for (const relativePath of ["sim/construction.js", "sim/expansion.js", "sim/population.js"]) {
        const source = readFileSync(join(scriptsRoot, ...relativePath.split("/")), "utf8");
        assert.ok(!runtimeImport.test(source), `${relativePath} must not import @minecraft/server at runtime`);
        assert.doesNotMatch(source, /system\.run|world\.getBlock|blockType\.setState|spawnEntity/,
            `${relativePath} must not attempt any world access`);
    }
});
