/**
 * Which lever belongs to which gate, and what pulling one should do. PURE: no Minecraft import.
 *
 * The listener in integration/gateLevers.js can only be tested in game, but the two rules worth testing - the
 * cell-to-gate index and the direction a press flips a gate - are plain data. They live here so an offline test
 * can exercise them without a world.
 */
import { cellsToToggle } from "./gates.js";

/**
 * Every lever cell of every registered gate, as "x,y,z" -> gate id.
 *
 * The point is derived from the stored physical spec, not from memory: a lever that was moved, or a gate whose
 * record has gone, simply has no entry, and an unregistered lever cannot toggle anything.
 *
 * @param {any} kingdom
 * @returns {Map<string, string>}
 */
export function leverGateIndex(kingdom) {
    /** @type {Map<string, string>} */
    const index = new Map();
    for (const district of /** @type {any[]} */ (Array.isArray(kingdom?.districts) ? kingdom.districts : [])) {
        for (const gate of /** @type {any[]} */ (Array.isArray(district?.gates) ? district.gates : [])) {
            const spec = gate?.physical?.spec;
            if (spec === undefined || spec === null || typeof gate?.id !== "string") {
                continue;
            }
            let cells;
            try {
                cells = cellsToToggle(spec);
            } catch (_error) {
                continue; // a damaged spec is not a lever we can resolve
            }
            for (const cell of cells) {
                if (cell.role !== "lever") {
                    continue;
                }
                index.set(`${String(cell.x)},${String(cell.y)},${String(cell.z)}`, String(gate.id));
            }
        }
    }
    return index;
}

/**
 * What a press should do, given where the gate is heading.
 *
 * @param {any} gate
 * @returns {{ mode: "forced_open" | "forced_closed", opening: boolean }}
 */
export function leverDecision(gate) {
    const current = String(gate?.physical?.target ?? gate?.state ?? "open");
    const opening = current !== "open";
    return { mode: opening ? "forced_open" : "forced_closed", opening };
}
