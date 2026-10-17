import { world } from "@minecraft/server";
import { formatSummaryLines } from "../ui/report.js";

/**
 * Greets each player the first time they spawn in a session and makes sure the
 * kingdom has been seeded, so the state exists as soon as someone looks at it.
 *
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 */
export function registerWelcomeOnJoin(kingdomStore) {
    world.afterEvents.playerSpawn.subscribe((event) => {
        if (!event.initialSpawn) {
            return;
        }
        const { kingdom, seeded } = kingdomStore.ensureInitial();
        const greeting = seeded
            ? `Welcome to the ruins. ${kingdom.name} has been founded.`
            : `Welcome back, ${event.player.name}.`;
        event.player.sendMessage([greeting, ...formatSummaryLines(kingdom)]);
    });
}
