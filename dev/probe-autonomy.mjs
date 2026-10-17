import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, serializeKingdom } = await loadModule("kingdom", "state.js");
const policies = await loadModule("sim", "policies.js");
const { advanceKingdomStep } = await loadModule("sim", "tick.js");

const kingdom = createInitialKingdom();
const securityTally = {};
const levyReasons = {};
let acceptedLevies = 0;
let refusedLevies = 0;
let largestBlob = 0;

for (let step = 0; step < 400; step += 1) {
    advanceKingdomStep(kingdom);
    for (const district of kingdom.districts) {
        securityTally[district.security] = (securityTally[district.security] ?? 0) + 1;
    }
    // Sample what the policy layer would decide right now, without applying it twice.
    for (const district of kingdom.districts) {
        const shortfall = policies.garrisonShortfall(district);
        if (shortfall <= 0) {
            levyReasons["no shortfall"] = (levyReasons["no shortfall"] ?? 0) + 1;
            continue;
        }
        if (!policies.POLICY_DECISION_RULES.recruitmentSecurity.includes(district.security)) {
            levyReasons[`security=${district.security}`] = (levyReasons[`security=${district.security}`] ?? 0) + 1;
            continue;
        }
        if (!policies.hasFoodSurplus(district)) {
            levyReasons["no food surplus"] = (levyReasons["no food surplus"] ?? 0) + 1;
            continue;
        }
        if (district.reserves.supplies < policies.POLICY_DECISION_RULES.minSuppliesPerLevy) {
            levyReasons["no supplies"] = (levyReasons["no supplies"] ?? 0) + 1;
            continue;
        }
        acceptedLevies += 1;
    }
    refusedLevies += Object.entries(levyReasons).filter(([key]) => key !== "no shortfall" && !key.startsWith("security=secure")).length;
    largestBlob = Math.max(largestBlob, serializeKingdom(kingdom).length);
}

console.log(JSON.stringify({
    step: kingdom.step,
    districts: kingdom.districts.length,
    civilians: kingdom.districts.reduce((sum, d) => sum + d.civilians, 0),
    soldiers: kingdom.districts.reduce((sum, d) => sum + d.soldiers, 0),
    training: kingdom.districts.reduce((sum, d) => sum + d.trainingQueue, 0),
    target: kingdom.districts.reduce((sum, d) => sum + policies.desiredGarrison(d), 0),
    totalAssault: Math.round(kingdom.districts.reduce((sum, d) => sum + Number(d.assault), 0)),
    projectsOpen: kingdom.districts.reduce((sum, d) => sum + d.projects.filter((p) => p.status !== "complete").length, 0),
    projectsRecorded: kingdom.districts.reduce((sum, d) => sum + d.projects.length, 0),
    securityTally,
    blockedBy: levyReasons,
    districtsStepsEligibleForLevy: acceptedLevies,
    largestBlob,
    claimed: kingdom.territory.filter((land) => land.status === "kingdom").length,
    military: kingdom.territory.filter((land) => land.status === "military").length,
}, null, 1));
