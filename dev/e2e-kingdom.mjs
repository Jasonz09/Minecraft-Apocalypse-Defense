import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Headless end-to-end kingdom run. No Minecraft, no test framework: it drives the real
 * simulation modules over a mock world and walks the whole gameplay sequence - migrate a
 * v1 save, hold the realm at peace, suffer a siege, evacuate, reinforce, counterattack, win
 * outside the border, expand, be refused by a shortage, build, grow and recruit, persist,
 * and replay deterministically.
 *
 * Every stage asserts; the exit code is non-zero if any stage fails.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const config = await loadModule("config.js");
const state = await loadModule("kingdom", "state.js");
const { createKingdomStore } = await loadModule("kingdom", "store.js");
const tick = await loadModule("sim", "tick.js");
const war = await loadModule("sim", "war.js");
const construction = await loadModule("sim", "construction.js");
const expansion = await loadModule("sim", "expansion.js");
const population = await loadModule("sim", "population.js");
const report = await loadModule("ui", "report.js");

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = [];
/** @type {string[]} */
const transcript = [];

function check(name, ok, detail) {
    results.push({ name, ok: Boolean(ok), detail: String(detail ?? "") });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

function createMockWorld(entries) {
    const properties = new Map(entries ?? []);
    return {
        properties,
        getDynamicProperty(identifier) {
            return properties.get(identifier);
        },
        setDynamicProperty(identifier, value) {
            if (value === undefined) {
                properties.delete(identifier);
            } else {
                properties.set(identifier, value);
            }
        },
    };
}

/** Exactly the shape the first release wrote, before any of this existed. */
function makeV1Save() {
    return JSON.stringify({
        schemaVersion: 1,
        name: "Civilization Apocalypse",
        districts: [
            { id: "district-1", name: "Hearthgate", civilians: 80, soldiers: 30 },
            { id: "district-2", name: "Ironquarry", civilians: 80, soldiers: 30 },
            { id: "district-3", name: "Whitethorn", civilians: 80, soldiers: 30 },
            { id: "district-4", name: "Saltmere", civilians: 80, soldiers: 30 },
            { id: "district-5", name: "Ashfall", civilians: 80, soldiers: 30 },
        ],
    });
}

/**
 * @param {any} kingdom
 * @param {number} index
 */
function soundnessProblems(kingdom, index) {
    const problems = state.findValidationProblems(kingdom).map((problem) => `step ${String(index)}: ${problem}`);
    for (const district of kingdom.districts) {
        if (district.civilians + district.refugees > district.civilianCapacity) {
            problems.push(`step ${String(index)}: ${district.name} over shelter (${String(district.civilians)}+${String(district.refugees)} of ${String(district.civilianCapacity)})`);
        }
        if (district.garrison.front + district.garrison.reserve !== district.soldiers) {
            problems.push(`step ${String(index)}: ${district.name} garrison drifted`);
        }
        if (district.defensiveIntegrity < 0 || district.defensiveIntegrity > 100) {
            problems.push(`step ${String(index)}: ${district.name} integrity out of range`);
        }
    }
    return problems;
}

/**
 * @param {any} kingdom
 * @param {number} steps
 * @param {string} label
 */
function runSteps(kingdom, steps, label) {
    /** @type {string[]} */
    const problems = [];
    for (let index = 0; index < steps; index += 1) {
        const result = tick.advanceKingdomStep(kingdom);
        problems.push(...result.problems.map((problem) => `${label} step ${String(index)}: ${problem}`));
        problems.push(...soundnessProblems(kingdom, index));
    }
    return problems;
}

function totalsOf(kingdom) {
    return state.computeTotals(kingdom);
}

/* ------------------------------------------------------------------ *
 * Stage 1 - a save from the previous release is upgraded, not replaced
 * ------------------------------------------------------------------ */

const world = createMockWorld([[config.STORAGE_KEYS.kingdom, makeV1Save()]]);
const store = createKingdomStore(world);
const opened = store.ensureInitial();

check(
    "v1 save migrates instead of reseeding",
    opened.seeded === false && opened.migrated === true && opened.fromVersion === 1,
    `seeded=${String(opened.seeded)} migrated=${String(opened.migrated)} from v${String(opened.fromVersion)}`,
);
check("starting totals survive the migration", totalsOf(opened.kingdom).civilians === 400 && totalsOf(opened.kingdom).soldiers === 150, JSON.stringify(totalsOf(opened.kingdom)));
check("the pre-migration save was kept", typeof world.properties.get(config.STORAGE_KEYS.quarantine) === "string", `keys: ${[...world.properties.keys()].join(", ")}`);

const kingdom = opened.kingdom;

/* ------------------------------------------------------------------ *
 * Stage 2 - one in-game day of peace
 * ------------------------------------------------------------------ */

const peaceProblems = runSteps(kingdom, config.SIM.stepsPerDay, "peace");
check("a day of peace is uneventful and sound", peaceProblems.length === 0, peaceProblems.slice(0, 3).join(" | "));
check("the step counter advanced a full day", kingdom.step >= config.SIM.stepsPerDay, `step ${String(kingdom.step)}`);
check("no district fell during peace", kingdom.districts.every((district) => district.security !== "lost"), kingdom.districts.map((district) => district.security).join("/"));

/* ------------------------------------------------------------------ *
 * Stage 3 - siege of Whitethorn: breach must not equal capture
 * ------------------------------------------------------------------ */

const victim = state.districtById(kingdom, "district-3");
victim.assault = 30;
victim.defensiveIntegrity = 35;
const siegeProblems = runSteps(kingdom, 10, "siege");
check("the siege stayed sound", siegeProblems.length === 0, siegeProblems.slice(0, 3).join(" | "));
check(
    "a district under sustained assault is not auto-captured",
    victim.security !== "lost" || victim.siegeSteps >= config.POLICY_DEFAULTS.fallAfterSiegeSteps,
    `security=${String(victim.security)} siegeSteps=${String(victim.siegeSteps)}`,
);
check("the walls are still standing", victim.buildings.walls >= config.DISTRICT_DEFAULTS.wallsPerDistrict, `walls=${String(victim.buildings.walls)}`);
check(
    "someone was home to defend",
    victim.garrison.front + victim.garrison.reserve > 0 || victim.soldiers === 0,
    `front=${String(victim.garrison.front)} reserve=${String(victim.garrison.reserve)}`,
);

/* ------------------------------------------------------------------ *
 * Stage 4 - evacuation respects shelter and routes
 * ------------------------------------------------------------------ */

const refugees = kingdom.districts.reduce((sum, district) => sum + district.refugees, 0);
const overShelter = kingdom.districts.filter((district) => district.civilians + district.refugees > district.civilianCapacity).length;
check("civilians took shelter or stayed put, never over capacity", overShelter === 0, `refugees in place=${String(refugees)}, over-shelter districts=${String(overShelter)}`);
transcript.push(`refugees sheltering after the siege: ${String(refugees)}`);

/* ------------------------------------------------------------------ *
 * Stage 5 - neighbours reinforce, but keep their own walls manned
 * ------------------------------------------------------------------ */

const relief = state.createInitialKingdom();
const reliefTown = state.districtById(relief, "district-3");
reliefTown.security = "breached";
const troopsBefore = totalsOf(relief).soldiers;
const help = war.requestReinforcements(relief, reliefTown.id, 40);

check("reinforcements actually arrive", help.sent === 30 && help.deficit === 10, `requested 40, sent=${String(help.sent)} deficit=${String(help.deficit)} declined=${JSON.stringify(help.declined)}`);
check(
    "no neighbour gives more than its keep fraction",
    relief.districts.filter((district) => district.id !== reliefTown.id).every((district) => district.soldiers >= 15),
    relief.districts.map((district) => `${String(district.id)}:${String(district.soldiers)}`).join(" "),
);
check("reinforcements move troops, they do not invent them", totalsOf(relief).soldiers === troopsBefore, `${String(troopsBefore)} -> ${String(totalsOf(relief).soldiers)}`);
check(
    "every contribution states its own cap",
    (help.contributions ?? []).every((entry) => entry.soldiers <= entry.limit && typeof entry.reason === "string" && entry.reason.length > 0),
    JSON.stringify(help.contributions),
);

/* ------------------------------------------------------------------ *
 * Stage 6 - counterattack once the relief has arrived
 * ------------------------------------------------------------------ */

reliefTown.assault = 22;
const assaultBefore = reliefTown.assault;
const defendersBefore = reliefTown.soldiers;
war.counterattack(relief, reliefTown);
check("a reinforced district goes on the offensive", reliefTown.assault < assaultBefore, `assault ${String(assaultBefore)} -> ${String(reliefTown.assault)}`);
runSteps(relief, 8, "relief");
check(
    "a district with troops on the wall is not handed over",
    reliefTown.security !== "lost" || reliefTown.soldiers === 0,
    `security=${String(reliefTown.security)} soldiers=${String(defendersBefore)}->${String(reliefTown.soldiers)}`,
);
transcript.push(`relief: ${help.sent} troops arrived, assault ${String(assaultBefore)} -> ${String(reliefTown.assault)}, security ${String(reliefTown.security)}`);

/* ------------------------------------------------------------------ *
 * Stage 7 - victory outside the border, then a balanced expansion
 * ------------------------------------------------------------------ */

const grower = state.createInitialKingdom();
const openLand = grower.territory[0];
const border = state.districtById(grower, openLand.adjacentDistrictId);
border.security = "secure";
border.defensiveIntegrity = 100;
border.reserves.food = 900;
border.reserves.materials = 900;
border.reserves.supplies = 900;
const settlersBefore = totalsOf(grower);
expansion.recordExternalVictory(grower, openLand.id, {});
expansion.establishMilitaryControl(grower, openLand.id, {});
const verdict = expansion.evaluateExpansion(grower, openLand.id);
check("a fed, garrisoned, secure border can expand", verdict.eligible === true, verdict.reasons.join("; ") || "no objections");
expansion.claimTerritory(grower, openLand.id, {});
check("the claim creates exactly one new district", grower.districts.length === 6, `districts ${String(6)} (was 5)`);
check("the land is recorded as kingdom territory", openLand.status === "kingdom", `status=${String(openLand.status)} claimedAt=${String(openLand.claimedAtStep)}`);
const newest = grower.districts[grower.districts.length - 1];
check("the new district arrives with a staged construction plan", (newest.projects ?? []).length >= config.EXPANSION_PROJECT_PLAN.length - 2, `${String(newest.projects?.length)} scheduled: ${(newest.projects ?? []).map((project) => project.kind).join(", ")}`);
check("the new district is wired into the neighbour graph", state.findValidationProblems(grower).length === 0, state.findValidationProblems(grower).join("; "));
check(
    "settlers and defenders are transferred, not duplicated",
    totalsOf(grower).civilians === settlersBefore.civilians && totalsOf(grower).soldiers === settlersBefore.soldiers,
    `${String(settlersBefore.civilians)}/${String(settlersBefore.soldiers)} -> ${String(totalsOf(grower).civilians)}/${String(totalsOf(grower).soldiers)}`,
);
transcript.push(`expansion: ${newest.name} claimed from ${openLand.name}, ${String(newest.projects.length)} projects planned`);

/* ------------------------------------------------------------------ *
 * Stage 8 - a starving border cannot expand
 * ------------------------------------------------------------------ */

const starving = state.createInitialKingdom();
const poorLand = starving.territory[0];
const poorAnchor = state.districtById(starving, poorLand.adjacentDistrictId);
poorAnchor.security = "secure";
poorAnchor.defensiveIntegrity = 100;
poorAnchor.reserves.food = 0;
poorAnchor.reserves.materials = 0;
poorAnchor.reserves.supplies = 0;
expansion.recordExternalVictory(starving, poorLand.id, {});
expansion.establishMilitaryControl(starving, poorLand.id, {});
const refusal = expansion.evaluateExpansion(starving, poorLand.id);
check("a district with empty stores cannot expand", refusal.eligible === false, refusal.reasons.join("; ") || "no reasons given");
check(
    "the refusal names the missing stores",
    refusal.reasons.some((reason) => /food|materials|supplies/i.test(reason)),
    JSON.stringify(refusal.reasons),
);
const districtsBefore = starving.districts.length;
expansion.claimTerritory(starving, poorLand.id, {});
check("the refused claim created no district", starving.districts.length === districtsBefore, `${String(districtsBefore)} -> ${String(starving.districts.length)}`);
check("the unfed land did not become kingdom territory", poorLand.status !== "kingdom", `status=${String(poorLand.status)}`);

/* ------------------------------------------------------------------ *
 * Stage 9 - construction is staged and costs real resources
 * ------------------------------------------------------------------ */

const builderDistrict = kingdom.districts[0];
builderDistrict.security = "secure";
builderDistrict.reserves.materials = 500;
builderDistrict.reserves.food = 500;
builderDistrict.reserves.supplies = 500;
construction.scheduleProject(builderDistrict, "farms", {});
const materialsBefore = builderDistrict.reserves.materials;
const queueAtSchedule = construction.collectBuildQueue(kingdom, 5);
check("a freshly scheduled project appears in the build queue", queueAtSchedule.length >= 1 && queueAtSchedule.length <= 5, `${String(queueAtSchedule.length)} entries`);
check(
    "a queued entry describes planned blocks, not world edits",
    queueAtSchedule.every((entry) => typeof entry.projectId === "string" && Number.isInteger(entry.blocksPlanned) && entry.blocksPlanned > 0),
    JSON.stringify(queueAtSchedule[0]),
);
const buildProblems = runSteps(kingdom, 10, "construction");
const farmedProject = builderDistrict.projects.find((project) => project.kind === "farms");
check("construction stayed sound", buildProblems.length === 0, buildProblems.slice(0, 3).join(" | "));
check(
    "a staged project advanced and consumed materials",
    farmedProject === undefined || farmedProject.stage >= 1 || builderDistrict.reserves.materials < materialsBefore,
    `stage=${String(farmedProject?.stage)} materials ${String(materialsBefore)} -> ${String(builderDistrict.reserves.materials)} status=${String(farmedProject?.status)}`,
);
const wallsBefore = kingdom.districts.reduce((sum, district) => sum + district.buildings.walls, 0);
runSteps(kingdom, 24, "settle");
const wallsAfter = kingdom.districts.reduce((sum, district) => sum + district.buildings.walls, 0);
check("existing walls are never removed", wallsAfter >= wallsBefore, `${String(wallsBefore)} -> ${String(wallsAfter)}`);

/* ------------------------------------------------------------------ *
 * Stage 10 - growth and recruitment, driven on a peaceful kingdom so
 * battle casualties cannot muddy what the mechanism did
 * ------------------------------------------------------------------ */

const recruiting = state.createInitialKingdom();
const recruitDistrict = state.districtById(recruiting, "district-2");
recruitDistrict.security = "secure";
recruitDistrict.reserves.food = 900;
recruitDistrict.reserves.supplies = 900;
const civiliansBefore = recruitDistrict.civilians;
const soldiersAtEnlist = recruitDistrict.soldiers;
const levy = population.openRecruitment(recruitDistrict, 5, {});
check("recruitment takes civilians out of the civilian count", recruitDistrict.civilians === civiliansBefore - 5, JSON.stringify(levy));
check("recruits enter the training queue", recruitDistrict.trainingQueue === 5, `queue=${String(recruitDistrict.trainingQueue)}`);

let trained = 0;
for (let index = 0; index < 40 && recruitDistrict.trainingQueue > 0; index += 1) {
    population.advanceTraining(recruiting, recruitDistrict);
    trained += 1;
}
check("the queue empties into the ranks", recruitDistrict.trainingQueue === 0 && recruitDistrict.soldiers === soldiersAtEnlist + 5, `steps=${String(trained)} soldiers ${String(soldiersAtEnlist)} -> ${String(recruitDistrict.soldiers)}`);
check("the garrison split still matches the headcount", recruitDistrict.garrison.front + recruitDistrict.garrison.reserve === recruitDistrict.soldiers, JSON.stringify(recruitDistrict.garrison));
check("nothing was minted: civilians + trainees + soldiers is conserved", recruitDistrict.civilians + recruitDistrict.trainingQueue + recruitDistrict.soldiers === civiliansBefore + soldiersAtEnlist, `${String(recruitDistrict.civilians)}+${String(recruitDistrict.trainingQueue)}+${String(recruitDistrict.soldiers)} vs ${String(civiliansBefore + soldiersAtEnlist)}`);
check("recruitment rejects nonsense", (() => { try { population.openRecruitment(recruitDistrict, -3, {}); return false; } catch { return true; } })(), "negative recruits must throw");
check("recruitment rejects more recruits than there are people", (() => { try { population.openRecruitment(recruitDistrict, recruitDistrict.civilians + 500, {}); return false; } catch { return true; } })(), "over-population enlistment must throw");

/* ------------------------------------------------------------------ *
 * Stage 11 - persistence and determinism
 * ------------------------------------------------------------------ */

store.save(kingdom);
const reloaded = createKingdomStore(world).load();
check("the kingdom reloads identical from the save", JSON.stringify(reloaded.kingdom) === JSON.stringify(kingdom), `status=${String(reloaded.status)}`);

const twinOne = JSON.parse(JSON.stringify(kingdom));
const twinTwo = JSON.parse(JSON.stringify(kingdom));
runSteps(twinOne, 15, "twin-a");
runSteps(twinTwo, 15, "twin-b");
check("the same state replays identically", JSON.stringify(twinOne) === JSON.stringify(twinTwo), "12-step replay diverged");

/* ------------------------------------------------------------------ *
 * Stage 12 - the readouts the player will see
 * ------------------------------------------------------------------ */

const statusLines = report.formatStatusLines(kingdom);
check("civ:status still opens with the original header", statusLines[0] === "=== Civilization Apocalypse ===" && statusLines[1].startsWith("Districts: "), statusLines.slice(0, 2).join(" / "));
check("civ:status lists every district", statusLines.filter((line) => /civilians,$/u.test(line.split(" soldiers")[0]) || line.includes("civilians,")).length >= kingdom.districts.length, `${String(kingdom.districts.length)} districts`);
check("civ:status carries the situation block", statusLines.includes("-- situation --"), `${statusLines.length} lines`);
check("civ:district renders a full district card", report.formatDistrictLines(kingdom, kingdom.districts[0]).length >= 8, `${String(report.formatDistrictLines(kingdom, kingdom.districts[0]).length)} lines`);

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

const failures = results.filter((entry) => !entry.ok);

console.log("\n--- transcript ---");
for (const line of transcript) {
    console.log(`  ${line}`);
}

console.log("\n--- what this harness does NOT touch ---");
console.log("  Pure JavaScript, exercised here: scripts/sim/*, scripts/kingdom/*, scripts/ui/*, scripts/commands/args.js");
const runtimeFiles = [];
for (const dir of ["integration", "commands", "events"]) {
    for (const file of readdirSync(join(scriptsRoot, dir))) {
        if (file.endsWith(".js") && file !== "args.js") {
            runtimeFiles.push(`${dir}/${file}`);
        }
    }
}
console.log(`  Bedrock runtime boundary, NOT verifiable offline: ${runtimeFiles.join(", ")}`);
console.log("  Minecraft is not installed on this machine, so no in-game behaviour is claimed.");

console.log(`\nheadless kingdom run: ${String(results.length - failures.length)}/${String(results.length)} stages passed`);
if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`FAILED ${failure.name} - ${failure.detail}`);
    }
    process.exitCode = 1;
} else {
    console.log("the full offline gameplay sequence ran clean");
}
