import { SCRIPT_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { formatMissingKingdomLines, formatStatusLines } from "../ui/report.js";
import { reply } from "./reply.js";
import { system } from "@minecraft/server";

let registered = false;

/**
 * `/scriptevent civ:status` - the kingdom's saved statistics. This is the original
 * command from the first release and its output format is covered by the offline tests.
 *
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 */
export function registerStatusCommand(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;

    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (event.id !== SCRIPT_EVENT_IDS.status) {
            return;
        }
        const { kingdom, reason } = kingdomStore.load();
        reply(kingdom ? formatStatusLines(kingdom) : formatMissingKingdomLines(reason), event);
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}
