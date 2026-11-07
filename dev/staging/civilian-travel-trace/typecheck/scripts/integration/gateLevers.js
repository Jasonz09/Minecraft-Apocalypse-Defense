import { world } from "@minecraft/server";
import { leverDecision, leverGateIndex } from "../civ/leverbindings.js";
import { getGateAdapter } from "./gateAdapter.js";
import { findGate, setGateMode } from "../sim/gatecontrol.js";

/**
 * The lever beside a gate, finally wired.
 *
 * Every gatehouse already carries four levers - one on each corner face of its two towers - and until now the
 * pack listened to none of them: a player pulled one and the portcullis never moved. The press is a plain block
 * interaction, so this module turns it into the same decision the gate commands make: the gate's logical state
 * picks the mode (`forced_closed` when open, `forced_open` when sealed), the record is saved, and the existing
 * adapter pump performs the move row by row. The pump writes levers last, so the lever the player pulled ends in
 * the state the gate actually reached.
 *
 * Rules kept on purpose:
 *  - only a lever that belongs to a registered gate does anything; every other lever in the world is left alone;
 *  - an empty hand only. With a block in hand the game places the block instead of flipping the lever, and the
 *    after-event still fires, so acting on that press would close a gate the player never meant to touch;
 *  - `isFirstEvent` only: holding the button must not toggle the gate again every few ticks;
 *  - no new state is invented. The lever positions come from the same `cellsToToggle(spec)` the builder and the
 *    adapter use, and the gate record is the one the simulation already writes.
 */

/** The one block id a press is allowed to be about. */
const LEVER_ID = "minecraft:lever";

/** The listener is process-wide, so a second registration is refused rather than doubled. */
let listening = false;

/**
 * Subscribe the one listener. Nothing runs at import, and this is safe in early execution: it only subscribes.
 *
 * @param {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} kingdomStore
 * @returns {boolean} whether this call subscribed (false when it was already listening)
 */
export function registerGateLevers(kingdomStore) {
    if (listening) {
        return false;
    }
    listening = true;
    world.afterEvents.playerInteractWithBlock.subscribe((event) => {
        const block = event?.block;
        if (block === undefined || block?.typeId !== LEVER_ID) {
            return;
        }
        if (event.isFirstEvent !== true) {
            return; // holding the button is not another pull
        }
        if (event.beforeItemStack !== undefined) {
            return; // a block in hand places the block; the lever itself never flipped
        }
        const loaded = kingdomStore.load();
        const kingdom = loaded.kingdom;
        if (kingdom === undefined) {
            return;
        }
        const position = block.location;
        const key = `${String(Math.floor(position.x))},${String(Math.floor(position.y))},${String(Math.floor(position.z))}`;
        const gateId = leverGateIndex(kingdom).get(key);
        if (gateId === undefined) {
            return;
        }
        const found = findGate(kingdom, gateId);
        if (found === undefined) {
            return;
        }
        const { mode, opening } = leverDecision(found.gate);
        const outcome = setGateMode(kingdom, gateId, mode, { force: true });
        const tell = (/** @type {string} */ line) => {
            try {
                event.player?.sendMessage?.(line);
            } catch (_error) {
                // a message is never worth failing the gate for
            }
        };
        if (!outcome.ok) {
            tell(`Gate ${gateId}: ${String(outcome.reason)}`);
            return;
        }
        try {
            kingdomStore.save(kingdom);
        } catch (error) {
            tell(`Gate ${gateId}: could not save the kingdom: ${String(error)}`);
            return;
        }
        const adapter = getGateAdapter(kingdomStore);
        adapter.retryNow(gateId);
        adapter.pump();
        tell(`Gate ${gateId}: ${opening ? "opening" : "closing"} (it waits if anyone stands in the gateway).`);
    });
    return true;
}
