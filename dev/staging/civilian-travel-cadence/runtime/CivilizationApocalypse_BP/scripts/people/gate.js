import { CIV_EVENT_IDS, PEOPLE } from "../config.js";
import { parseGateValue } from "../ledger/devgate.js";

/**
 * The people gate: the one switch that decides whether the kingdom's civilians, garrison and attackers
 * exist as entities in the world at all.
 *
 * Off by default. A world without the property spawns nothing, which is the state every release of this
 * pack has shipped in, and the switch is the only listener that exists while the gate is off because it
 * is the only way to turn it on. Turning it on does not need a reload: the runtime checks the gate once
 * per hour.
 *
 * Nothing here imports `@minecraft/server` - the binding passes the world, the system and the reply
 * helper in, so this stays runnable in Node against a fake.
 *
 * @typedef {{
 *   getDynamicProperty: (identifier: string) => unknown,
 *   setDynamicProperty: (identifier: string, value?: boolean | number | string) => void,
 * }} WorldLike
 */

/**
 * @param {WorldLike | undefined} world
 * @returns {boolean} true only when the gate is explicitly on; an unreadable world counts as off
 */
export function peopleGateOn(world) {
    if (world === undefined || world === null) {
        return false;
    }
    try {
        return world.getDynamicProperty(PEOPLE.gateKey) === true;
    } catch (_error) {
        return false;
    }
}

/**
 * What `civ:people` says back: the gate, and the reason it is refused while a district is being built.
 * @param {WorldLike} world
 * @param {boolean} busy true while a civilization job holds the world
 */
export function peopleStatusLines(world, busy) {
    const state = peopleGateOn(world) ? "on" : "off";
    return [
        `People entities are ${state}.`,
        busy
            ? "A district build holds the world right now: nobody walks the streets until it finishes or is aborted."
            : `Switch it with /scriptevent ${CIV_EVENT_IDS.people} on|off.`,
    ];
}

/**
 * Parse `on` / `off` / `status` from a command message.
 * @param {unknown} message
 * @returns {"on" | "off" | "status" | undefined}
 */
export function parsePeopleCommand(message) {
    const first = String(message ?? "").trim().split(/\s+/)[0]?.toLowerCase();
    if (first === "" || first === "status") {
        return "status";
    }
    const gate = parseGateValue(first);
    return gate ?? undefined;
}
