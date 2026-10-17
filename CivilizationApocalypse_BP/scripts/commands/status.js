import { ScriptEventSource, system, world } from "@minecraft/server";
import { SCRIPT_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { formatMissingKingdomLines, formatStatusLines } from "../ui/report.js";

/**
 * @typedef {import("@minecraft/server").Player} Player
 */

/**
 * @param {string[]} lines
 * @param {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} event
 */
function reply(lines, event) {
    const initiator = event.initiator;
    if (event.sourceType === ScriptEventSource.Entity && initiator !== undefined && initiator.typeId === "minecraft:player") {
        const player = /** @type {Player} */ (initiator);
        player.sendMessage(lines);
        return;
    }
    world.sendMessage(lines);
}

/**
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 */
export function registerStatusCommand(kingdomStore) {
    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (event.id !== SCRIPT_EVENT_IDS.status) {
            return;
        }
        const { kingdom, reason } = kingdomStore.load();
        reply(kingdom ? formatStatusLines(kingdom) : formatMissingKingdomLines(reason), event);
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}
