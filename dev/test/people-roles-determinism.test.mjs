import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const peopleRoot = join(scriptsRoot, "people");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

/** The modules this agent owns. Anything else under scripts/people belongs to another part of the people layer. */
const OWNED = ["occupations", "routines", "transport", "patrols", "training", "command", "equipment", "support"];

/** Files another part of the people layer is writing right now. These modules must never import them. */
const NOT_OURS = ["contract.js", "lod.js", "reconcile.js", "roster.js"];

const { createInitialKingdom } = await loadModule("kingdom", "state.js");
const occupations = await loadModule("people", "occupations.js");
const routines = await loadModule("people", "routines.js");
const transport = await loadModule("people", "transport.js");
const patrols = await loadModule("people", "patrols.js");
const training = await loadModule("people", "training.js");
const command = await loadModule("people", "command.js");
const equipment = await loadModule("people", "equipment.js");
const support = await loadModule("people", "support.js");

/**
 * Every model applied to every district of a fresh starting kingdom, as one JSON string.
 * @param {number} step
 */
function everyModelOnStartingKingdom(step) {
    const kingdom = createInitialKingdom();
    kingdom.step = step;
    const rows = kingdom.districts.map((district) => ({
        occupations: occupations.assignOccupations(district),
        routine: routines.locationAt({ step, role: "farmer", security: district.security }),
        haul: transport.planHaulJobs(district),
        patrols: patrols.planPatrols(district, { step }),
        training: training.projectTraining(district),
        commanders: command.assignCommanders(district),
        equipment: equipment.planEquipment(district, null),
        support: support.spawnBudget(district, { golems: 0, wolves: 0 }, step),
    }));
    return JSON.stringify(rows);
}

test("every model gives identical output for identical input, across fresh kingdoms and repeated calls", () => {
    for (const step of [0, 7, 23, 24, 500]) {
        const first = everyModelOnStartingKingdom(step);
        assert.equal(everyModelOnStartingKingdom(step), first, `step ${String(step)} repeats`);
    }
});

test("no model changes the district record it is given", () => {
    const kingdom = createInitialKingdom();
    const district = kingdom.districts[0];
    district.trainingQueue = 4;
    district.trainingBuffer = 0.5;
    district.assault = 14;
    const before = JSON.stringify(district);
    occupations.assignOccupations(district);
    routines.dailySchedule("worker", "alert");
    transport.planHaulJobs(district);
    patrols.planPatrols(district, { step: 9 });
    training.projectTraining(district);
    command.assignCommanders(district);
    equipment.planEquipment(district, null);
    support.spawnBudget(district, { golems: 0, wolves: 0 }, 3);
    support.engageSupport(district, { golems: 2, wolves: 2 }, { rngState: 4 });
    assert.equal(JSON.stringify(district), before);
});

test("no model holds state between calls: the answer depends only on the arguments", () => {
    const kingdom = createInitialKingdom();
    const district = kingdom.districts[2];
    const first = JSON.stringify(support.engageSupport(district, { golems: 3, wolves: 3 }, { rngState: 1234 }));
    support.engageSupport(district, { golems: 3, wolves: 3 }, { rngState: 999 });
    assert.equal(JSON.stringify(support.engageSupport(district, { golems: 3, wolves: 3 }, { rngState: 1234 })), first);
});

test("the people modules import only the simulation's pure modules and config, never the Minecraft runtime or another agent's files", () => {
    const importPattern = /(?:^|\n)\s*(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']/g;
    for (const name of readdirSync(peopleRoot).filter((file) => file.endsWith(".js"))) {
        const source = readFileSync(join(peopleRoot, name), "utf8");
        for (const match of source.matchAll(importPattern)) {
            const specifier = match[1];
            assert.ok(!specifier.startsWith("@minecraft/"), `${name} imports ${specifier}`);
            if (OWNED.some((owned) => name === `${owned}.js`)) {
                assert.ok(!NOT_OURS.some((other) => specifier.endsWith(`/${other}`) || specifier === `./${other}`), `${name} imports ${specifier}, which is not ours`);
                assert.ok(specifier.startsWith("../") || specifier.startsWith("./"), `${name} imports a bare module ${specifier}`);
            }
        }
        if (OWNED.some((owned) => name === `${owned}.js`)) {
            assert.ok(!/Math\.random|Date\.now|new Date\(/.test(source), `${name} must be deterministic`);
        }
    }
    for (const owned of OWNED) {
        const source = readFileSync(join(peopleRoot, `${owned}.js`), "utf8");
        assert.ok(source.length > 0, `${owned}.js exists`);
    }
});
