/**
 * Command ids owned by the Commander's Ledger.
 *
 * `civ:ledger` is the recovery command: it gives the Ledger item to a player who does not already
 * hold one. The runtime (ledger/runtime.js) subscribes to it itself when it registers, so the
 * integrator does not need to add it to config.js. The id follows the scriptevent rule enforced by
 * dev/test/commands.test.mjs: namespace:name with exactly one colon.
 */

export const LEDGER_NAMESPACE = "civ";

/**
 * World dynamic property that turns the Ledger on. Absent or anything but `true` means OFF: nothing is
 * registered at load, the item refuses to open, and the recovery command refuses. Set only by the
 * development command `civ:ledger_devgate on|off`. Starter arming does not wipe it yet (see docs/LEDGER_PLAN.md).
 */
export const LEDGER_DEV_GATE_KEY = "civ_ledger_dev";

export const LEDGER_EVENT_IDS = Object.freeze({
    /** Gives the Ledger item when the player does not already hold one (idempotent). Refused while the gate is off. */
    recover: "civ:ledger",
    /** Development switch for the gate: `civ:ledger_devgate on` or `civ:ledger_devgate off`. Always listening. */
    devgate: "civ:ledger_devgate",
});
