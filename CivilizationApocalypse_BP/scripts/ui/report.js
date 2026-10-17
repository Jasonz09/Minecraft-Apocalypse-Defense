import { computeTotals } from "../kingdom/state.js";
import { PACK_NAME } from "../config.js";

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
    return lines;
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
