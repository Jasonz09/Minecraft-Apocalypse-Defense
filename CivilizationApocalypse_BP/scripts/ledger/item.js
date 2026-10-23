/**
 * The Commander's Ledger item: a VANILLA book, renamed and given lore, identified by a marker
 * dynamic property. A custom item would need a resource pack for its texture and name, so the
 * Ledger avoids one (see docs/LEDGER_PLAN.md).
 *
 * This module takes the ItemStack class and the lock-mode enum as arguments, so it never imports
 * `@minecraft/server` and runs offline. The runtime passes the real classes in.
 */

import { LEDGER_TEXT, sanitize } from "./text.js";

export const LEDGER_ITEM = Object.freeze({
    typeId: "minecraft:book",
    /** Dynamic property that marks a stack as the Ledger. Identity is typeId plus this marker. */
    marker: "ca:ledger",
    nameTag: "Commander's Ledger",
    lore: Object.freeze([
        "Use it to open the Commander's Ledger.",
        "Kingdom, military, districts, construction,",
        "expansion, policies and gates, in one place.",
    ]),
});

/**
 * @typedef {{ typeId?: string, getDynamicProperty?: (identifier: string) => unknown }} StackLike
 * @typedef {{ size: number, getItem: (slot: number) => unknown }} ContainerLike
 */

/**
 * True for the Ledger item and nothing else.
 * @param {unknown} stack
 * @returns {boolean}
 */
export function isLedgerStack(stack) {
    if (stack === null || typeof stack !== "object") {
        return false;
    }
    const candidate = /** @type {StackLike} */ (stack);
    return candidate.typeId === LEDGER_ITEM.typeId && typeof candidate.getDynamicProperty === "function" && candidate.getDynamicProperty(LEDGER_ITEM.marker) === true;
}

/**
 * The first inventory slot that holds a Ledger, or undefined.
 * @param {ContainerLike} container
 * @returns {number | undefined}
 */
export function findLedgerSlot(container) {
    for (let slot = 0; slot < container.size; slot += 1) {
        if (isLedgerStack(container.getItem(slot))) {
            return slot;
        }
    }
    return undefined;
}

/**
 * A new Ledger stack: one book, named, with lore, the marker, locked to the inventory and kept on death.
 *
 * @param {new (typeId: string, amount?: number) => any} ItemStackClass
 * @param {{ inventory: string }} lockMode the ItemLockMode enum
 * @returns {any}
 */
export function makeLedgerStack(ItemStackClass, lockMode) {
    const stack = new ItemStackClass(LEDGER_ITEM.typeId, 1);
    stack.nameTag = sanitize(LEDGER_ITEM.nameTag);
    stack.setLore(LEDGER_ITEM.lore.map((text) => sanitize(text).slice(0, LEDGER_TEXT.lineWidth)));
    stack.setDynamicProperty(LEDGER_ITEM.marker, true);
    stack.lockMode = lockMode.inventory;
    stack.keepOnDeath = true;
    return stack;
}
