import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, serializeKingdom, findValidationProblems } = await loadModule("kingdom", "state.js");
const tick = await loadModule("sim", "tick.js");
const expansion = await loadModule("sim", "expansion.js");

const kingdom = createInitialKingdom();
let largest = 0;
let rejections = 0;
for (let step = 0; step < 500; step += 1) {
    const result = tick.advanceKingdomStep(kingdom);
    rejections += result.problems.length;
    const size = serializeKingdom(kingdom).length;
    if (size > largest) {
        largest = size;
    }
}

// Now force every territory to be claimed, which is the worst case for blob size.
for (const land of [...kingdom.territory]) {
    const anchor = kingdom.districts.find((district) => district.id === land.adjacentDistrictId);
    if (!anchor) continue;
    anchor.security = "secure";
    anchor.defensiveIntegrity = 100;
    anchor.reserves.food = 5000;
    anchor.reserves.materials = 5000;
    anchor.reserves.supplies = 5000;
    anchor.civilians = Math.max(0, anchor.civilians - 40);
    expansion.recordExternalVictory(kingdom, land.id, {});
    expansion.establishMilitaryControl(kingdom, land.id, {});
    expansion.claimTerritory(kingdom, land.id, {});
    for (let step = 0; step < 12; step += 1) {
        tick.advanceKingdomStep(kingdom);
    }
    const size = serializeKingdom(kingdom).length;
    if (size > largest) {
        largest = size;
    }
}

console.log(JSON.stringify({
    districts: kingdom.districts.length,
    claimed: kingdom.territory.filter((land) => land.status === "kingdom").length,
    logLength: kingdom.log.length,
    battleLength: kingdom.battles.length,
    projects: kingdom.districts.reduce((sum, district) => sum + district.projects.length, 0),
    step: kingdom.step,
    rejections,
    largestSerializedBytes: largest,
    validationProblems: findValidationProblems(kingdom),
    totals: {
        civilians: kingdom.districts.reduce((sum, d) => sum + d.civilians, 0),
        soldiers: kingdom.districts.reduce((sum, d) => sum + d.soldiers, 0),
    },
}, null, 1));
