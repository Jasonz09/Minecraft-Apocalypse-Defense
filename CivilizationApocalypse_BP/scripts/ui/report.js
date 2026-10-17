import { SIM } from "../config.js";
import { PACK_NAME } from "../config.js";
import { computeTotals, districtHeadroom } from "../kingdom/state.js";
import { formatGameTime } from "../sim/clock.js";

/**
 * All player-facing text. Every function here is pure: it turns saved state into lines of
 * chat, and the offline tests assert on those lines without a Minecraft runtime.
 */

/**
 * @param {any} kingdom
 * @returns {string[]}
 */
export function formatStatusLines(kingdom) {
    const totals = computeTotals(kingdom);
    const lines = [
        `=== ${kingdom.name} ===`,
        `Districts: ${String(totals.districts)}`,
        `Civilians: ${String(totals.civilians)}`,
        `Soldiers:  ${String(totals.soldiers)}`,
        "-- districts --",
    ];
    for (const district of kingdom.districts) {
        lines.push(`${district.name}: ${String(district.civilians)} civilians, ${String(district.soldiers)} soldiers`);
    }
    lines.push(...formatSituationLines(kingdom));
    return lines;
}

/**
 * @param {any} kingdom
 * @returns {string[]}
 */
export function formatSituationLines(kingdom) {
    const totals = computeTotals(kingdom);
    const districts = /** @type {any[]} */ (kingdom.districts ?? []);
    const lands = /** @type {any[]} */ (kingdom.territory ?? []);
    const threatened = districts.filter((district) => Number(district.assault) > 0);
    const building = districts.reduce((sum, district) => sum + (district.projects?.length ?? 0), 0);
    const claimed = lands.filter((land) => land.status === "kingdom").length;
    const military = lands.filter((land) => land.status === "military").length;
    const lines = [
        "-- situation --",
        `Time: ${formatGameTime(Number(kingdom.step))} (step ${String(kingdom.step)}), seed ${String(kingdom.seed)}`,
        `Policy: expansion ${String(kingdom.policy.expansion)}, reinforcements keep ${String(Math.round(Number(kingdom.policy.reinforcementKeepFraction) * 100))}% at home`,
        `Sheltered refugees: ${String(totals.refugees)}`,
        `Districts under attack: ${threatened.length === 0 ? "none" : threatened.map((district) => `${String(district.name)} (assault ${String(Math.round(Number(district.assault)))})`).join(", ")}`,
        `Territory: ${String(claimed)} claimed, ${String(military)} under military control, ${String(lands.length - claimed - military)} unclaimed`,
        `Active construction projects: ${String(building)}`,
    ];
    for (const entry of kingdom.log.slice(0, 4)) {
        lines.push(`  step ${String(entry.atStep)}: ${String(entry.text)}`);
    }
    return lines;
}

/**
 * @param {any} kingdom
 * @param {any} district
 * @returns {string[]}
 */
export function formatDistrictLines(kingdom, district) {
    const districts = /** @type {any[]} */ (kingdom.districts ?? []);
    const neighborNames = (district.neighbors ?? []).map((
        /** @type {string} */ id,
    ) => districts.find((entry) => entry.id === id)?.name ?? id).join(", ");
    const lines = [
        `=== ${district.name} (${district.id}) ===`,
        `Security: ${String(district.security)} | Assault: ${String(Math.round(Number(district.assault)))} | Siege steps: ${String(district.siegeSteps)}`,
        `Defensive integrity: ${String(Math.round(Number(district.defensiveIntegrity)))}% (walls standing: ${String(district.buildings.walls)})`,
        `Population: ${String(district.civilians)} of ${String(district.civilianCapacity)} shelter (${String(district.refugees)} refugees, ${String(districtHeadroom(district))} free)`,
        `Garrison: ${String(district.soldiers)} troops - ${String(district.garrison.front)} on the wall, ${String(district.garrison.reserve)} in reserve; training queue ${String(district.trainingQueue)}`,
        `Position: ${String(district.fallback?.position ?? "holding the wall")}`,
        `Stores: food ${String(round(district.reserves.food))}, materials ${String(round(district.reserves.materials))}, supplies ${String(round(district.reserves.supplies))}`,
        `Buildings: homes ${String(district.buildings.homes)}, farms ${String(district.buildings.farms)}, storehouses ${String(district.buildings.storehouses)}, barracks ${String(district.buildings.barracks)}`,
        `Neighbors: ${neighborNames || "none"} | Evacuated to: ${String(district.evacuatedTo ?? "nobody")}`,
    ];
    if (district.physical) {
        const where = district.physical.origin;
        lines.push(`Physical: ${String(district.physical.status)} at ${String(where.x)}, ${String(where.y)}, ${String(where.z)} (${String(district.physical.placed)}/${String(district.physical.total)} blocks)`);
    }
    const projects = district.projects ?? [];
    if (projects.length === 0) {
        lines.push("Projects: none scheduled");
    } else {
        lines.push("Projects:");
        for (const project of projects) {
            lines.push(
                `  ${String(project.kind)} stage ${String(project.stage)}/${String(project.stageCount)} (${String(project.status)}, ${String(project.builders)} builders)`,
            );
        }
    }
    return lines;
}

/**
 * @param {any} kingdom
 * @returns {string[]}
 */
export function formatTerritoryLines(kingdom) {
    const districts = /** @type {any[]} */ (kingdom.districts ?? []);
    const lines = ["=== Territory ==="];
    for (const land of /** @type {any[]} */ (kingdom.territory ?? [])) {
        const anchor = districts.find((district) => district.id === land.adjacentDistrictId);
        lines.push(
            `${String(land.name)} (${land.id}): ${String(land.status)}${anchor ? ` via ${String(anchor.name)}` : ""}, needs ${String(land.garrisonRequirement)} troops, survey ${String(Math.round(Number(land.surveyProgress)))}%`,
        );
    }
    return lines;
}

/**
 * @param {any} kingdom
 * @returns {string[]}
 */
export function formatPolicyLines(kingdom) {
    return [
        `Expansion policy: ${String(kingdom.policy.expansion)}`,
        `Reinforcement keep: ${String(Math.round(Number(kingdom.policy.reinforcementKeepFraction) * 100))}% of a district's troops stay home`,
        `Breach threshold: integrity below ${String(kingdom.policy.breachIntegrity)}% | Falls after ${String(kingdom.policy.fallAfterSiegeSteps)} unrelieved breached steps`,
    ];
}

/**
 * @param {string[]} names
 * @param {string} requested
 * @returns {string[]}
 */
export function formatUnknownDistrictLines(names, requested) {
    return [`Unknown district '${String(requested)}'.`, `Known districts: ${names.join(", ")}`];
}

/**
 * @param {string} title
 * @param {string[]} details
 * @returns {string[]}
 */
export function formatErrorLines(title, details) {
    return [`=== ${title} ===`, ...details];
}

/**
 * @param {any} kingdom
 * @param {boolean} seeded
 * @param {string} playerName
 * @returns {string[]}
 */
export function formatWelcomeLines(kingdom, seeded, playerName) {
    const greeting = seeded
        ? `Welcome to the ruins. ${kingdom.name} has been founded.`
        : `Welcome back, ${String(playerName)}.`;
    return [greeting, ...formatSummaryLines(kingdom)];
}

/**
 * @param {any} kingdom
 * @returns {string[]}
 */
export function formatSummaryLines(kingdom) {
    const totals = computeTotals(kingdom);
    return [
        `${kingdom.name}: ${String(totals.districts)} districts, ${String(totals.civilians)} civilians, ${String(totals.soldiers)} soldiers.`,
        "Run /scriptevent civ:status for the full report.",
    ];
}

/**
 * @param {string | undefined} reason
 * @returns {string[]}
 */
export function formatMissingKingdomLines(reason) {
    return [
        `=== ${PACK_NAME} ===`,
        "No kingdom is saved in this world yet.",
        `Reason: ${reason ?? "unknown"}`,
        "Join the world as a player once to seed the starting kingdom.",
    ];
}

/**
 * @param {string | undefined} reason
 * @returns {string[]}
 */
export function formatRefusedKingdomLines(reason) {
    return [
        `=== ${PACK_NAME} ===`,
        "Saved kingdom state was left untouched because this pack cannot safely read it.",
        `Reason: ${reason ?? "unknown"}`,
        "Nothing was overwritten. Install a pack version that matches the saved schema to continue.",
    ];
}

/**
 * @param {number} value
 */
function round(value) {
    return Math.round(Number(value) * 10) / 10;
}
