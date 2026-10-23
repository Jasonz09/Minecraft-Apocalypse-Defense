import { LEDGER_DEV_GATE_KEY, LEDGER_EVENT_IDS, LEDGER_NAMESPACE } from "./ids.js";

/**
 * The development gate of the Commander's Ledger and its switch, `civ:ledger_devgate on|off`.
 *
 * Off by default: a world without the property has no working Ledger. The switch is the one script-event
 * listener that exists while the gate is off, because it is the only way to turn the gate on. It is
 * registered unconditionally by main.js (through integration/ledgerBindings.js). Turning the gate on also
 * registers the Ledger's own handlers at once, so no reload is needed.
 *
 * Nothing here imports `@minecraft/server`: the binding passes in the world, the system and the reply helper.
 *
 * @typedef {{
 *   getDynamicProperty: (identifier: string) => unknown,
 *   setDynamicProperty: (identifier: string, value?: boolean | number | string) => void,
 * }} WorldLike
 * @typedef {{
 *   world: WorldLike,
 *   system: { afterEvents: { scriptEventReceive: { subscribe: (callback: (event: any) => void, options: { namespaces: string[] }) => unknown } } },
 *   reply: (lines: string[], event: any) => void,
 *   enable: () => unknown,
 * }} DevGateDeps
 */

/**
 * @param {WorldLike} world
 * @returns {boolean} true only when the development gate is explicitly on; an unreadable world counts as off
 */
export function ledgerGateOn(world) {
    try {
        return world.getDynamicProperty(LEDGER_DEV_GATE_KEY) === true;
    } catch (_error) {
        return false;
    }
}

/**
 * The first word of a command message when it is `on` or `off`.
 * @param {unknown} message
 * @returns {"on" | "off" | undefined}
 */
export function parseGateValue(message) {
    const first = String(message ?? "").trim().split(/\s+/)[0]?.toLowerCase();
    return first === "on" || first === "off" ? first : undefined;
}

/**
 * @param {DevGateDeps} deps
 */
export function createLedgerDevGate(deps) {
    let registered = false;

    /** @param {any} event */
    function handle(event) {
        try {
            const value = parseGateValue(event?.message);
            if (value === undefined) {
                const state = ledgerGateOn(deps.world) ? "on" : "off";
                deps.reply([`Commander's Ledger development gate is ${state}. Usage: scriptevent ${LEDGER_EVENT_IDS.devgate} on|off`], event);
                return;
            }
            try {
                deps.world.setDynamicProperty(LEDGER_DEV_GATE_KEY, value === "on");
            } catch (error) {
                deps.reply([`The Commander's Ledger development gate could not be changed: ${String(error)}`], event);
                return;
            }
            if (value === "off") {
                deps.reply(["Commander's Ledger development gate is off: the item and the recovery command refuse until it is switched on."], event);
                return;
            }
            try {
                deps.enable();
            } catch (error) {
                deps.reply([`The development gate is on, but the Ledger could not start: ${String(error)}`], event);
                return;
            }
            deps.reply([`Commander's Ledger development gate is on. Recover the item with: scriptevent ${LEDGER_EVENT_IDS.recover}`], event);
        } catch (_error) {
            // a failed switch must never break the event loop
        }
    }

    return {
        handle,
        /**
         * Subscribes the switch. Idempotent.
         * @returns {boolean} true the first time
         */
        register() {
            if (registered) {
                return false;
            }
            registered = true;
            deps.system.afterEvents.scriptEventReceive.subscribe(
                (event) => {
                    if (event.id === LEDGER_EVENT_IDS.devgate) {
                        handle(event);
                    }
                },
                { namespaces: [LEDGER_NAMESPACE] },
            );
            return true;
        },
    };
}
