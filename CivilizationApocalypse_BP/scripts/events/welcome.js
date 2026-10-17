import { world } from "@minecraft/server";
import { formatMissingKingdomLines, formatRefusedKingdomLines, formatWelcomeLines } from "../ui/report.js";

let registered = false;

/**
 * Greets a player on the first spawn of their session. This is also the moment the
 * kingdom is seeded for a brand new world - an existing save is loaded, a v1 save is
 * migrated, and a save this pack cannot read is reported rather than replaced.
 *
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 */
export function registerWelcomeOnJoin(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;

    world.afterEvents.playerSpawn.subscribe((event) => {
        if (!event.initialSpawn) {
            return;
        }
        const result = kingdomStore.ensureInitial();
        const player = event.player;

        if (result.kingdom === undefined) {
            player.sendMessage(result.refused ? formatRefusedKingdomLines(result.reason) : formatMissingKingdomLines(result.reason));
            return;
        }

        player.sendMessage(formatWelcomeLines(result.kingdom, result.seeded, player.name));
    });
}
