/**
 * The per-player navigation stack. A stack is a plain array of frames; the first frame is always the
 * root (the Kingdom menu) and is never removed.
 *
 * A frame is `{ menu, params, page }`. `menu` names a presenter in menus.js, `params` carries its
 * subject (a district id, a gate id), and `page` selects a page of a long list.
 */

export const ROOT_MENU = "kingdom";
/** Deepest stack kept: the oldest non-root frame is dropped when a deeper one is pushed. */
export const MAX_DEPTH = 16;

/**
 * @typedef {{ menu: string, params: Record<string, unknown>, page: number }} Frame
 */

/**
 * @param {{ menu?: unknown, params?: unknown, page?: unknown }} frame
 * @returns {Frame}
 */
export function normalizeFrame(frame) {
    const params = frame.params !== null && typeof frame.params === "object" ? /** @type {Record<string, unknown>} */ (frame.params) : {};
    const page = Number.isFinite(frame.page) ? Math.max(0, Math.floor(Number(frame.page))) : 0;
    return { menu: String(frame.menu ?? ROOT_MENU), params: { ...params }, page };
}

/** @returns {Frame[]} a fresh stack holding only the root */
export function newStack() {
    return [normalizeFrame({ menu: ROOT_MENU })];
}

/**
 * @param {Frame[]} stack
 * @returns {Frame}
 */
export function currentFrame(stack) {
    return stack[stack.length - 1] ?? normalizeFrame({ menu: ROOT_MENU });
}

/**
 * @param {Frame[]} stack
 * @param {{ menu?: unknown, params?: unknown, page?: unknown }} frame
 * @returns {Frame[]}
 */
export function openFrame(stack, frame) {
    if (stack.length >= MAX_DEPTH) {
        stack.splice(1, 1);
    }
    stack.push(normalizeFrame(frame));
    return stack;
}

/**
 * Replaces the top frame (used by paging and by "same menu, next page").
 * @param {Frame[]} stack
 * @param {{ menu?: unknown, params?: unknown, page?: unknown }} frame
 * @returns {Frame[]}
 */
export function replaceFrame(stack, frame) {
    stack[stack.length - 1] = normalizeFrame(frame);
    return stack;
}

/**
 * Pops one frame; the root is never popped.
 * @param {Frame[]} stack
 * @returns {Frame[]}
 */
export function goBack(stack) {
    if (stack.length > 1) {
        stack.pop();
    }
    return stack;
}

/**
 * Returns to the root frame.
 * @param {Frame[]} stack
 * @returns {Frame[]}
 */
export function goHome(stack) {
    stack.length = 1;
    return stack;
}

/**
 * @param {Frame} frame
 */
export function isRootFrame(frame) {
    return frame.menu === ROOT_MENU;
}

/**
 * @param {Frame[]} stack
 */
export function depthOf(stack) {
    return stack.length;
}
