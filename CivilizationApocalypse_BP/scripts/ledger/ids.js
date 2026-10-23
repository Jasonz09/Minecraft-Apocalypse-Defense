/**
 * Command ids owned by the Commander's Ledger.
 *
 * `civ:ledger` is the recovery command: it gives the Ledger item to a player who does not already
 * hold one. The runtime (ledger/runtime.js) subscribes to it itself when it registers, so the
 * integrator does not need to add it to config.js. The id follows the scriptevent rule enforced by
 * dev/test/commands.test.mjs: namespace:name with exactly one colon.
 */

export const LEDGER_NAMESPACE = "civ";

export const LEDGER_EVENT_IDS = Object.freeze({
    /** Gives the Ledger item when the player does not already hold one (idempotent). */
    recover: "civ:ledger",
});
