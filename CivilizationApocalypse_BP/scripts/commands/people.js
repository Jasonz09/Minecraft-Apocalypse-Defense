import { CIV_EVENT_IDS, PEOPLE, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { system, world } from "@minecraft/server";
import { parsePeopleCommand } from "../people/gate.js";
import { reply } from "./reply.js";

/**
 * `civ:people on|off|status` - the switch for the entity layer, and the only way to see what the people
 * runtime has actually done this session.
 *
 * The command owns the chat surface; `integration/peopleRuntime.js` owns the world work. Keeping them apart
 * is the pack's convention (every `CIV_EVENT_IDS` id is handled under commands/) and it is what lets the
 * runtime be replaced in a test without a chat stub.
 *
 * Off is the default and the safe state: a world that never ran this command has no people entities.
 */

/**
 * @param {{ statusLines: () => string[] }} runtime the runtime created in main.js, so the counters the
 *   command prints are the ones the engine keeps.
 * @returns {boolean} true the first time it is called
 */
export function registerPeopleCommand(runtime) {
    if (subscribed) {
        return false;
    }
    subscribed = true;
    system.afterEvents.scriptEventReceive.subscribe(
        (event) => {
            if (event.id !== CIV_EVENT_IDS.people) {
                return;
            }
            try {
                const want = parsePeopleCommand(event.message);
                if (want === "on" || want === "off") {
                    try {
                        world.setDynamicProperty(PEOPLE.gateKey, want === "on");
                    } catch (error) {
                        reply([`The people gate could not be changed: ${String(error)}`], event);
                        return;
                    }
                }
                reply(runtime.statusLines(), event);
            } catch (_error) {
                // a failed switch must never break the event loop
            }
        },
        { namespaces: [SCRIPT_EVENT_NAMESPACE] },
    );
    return true;
}

/** @type {boolean} */
let subscribed = false;
