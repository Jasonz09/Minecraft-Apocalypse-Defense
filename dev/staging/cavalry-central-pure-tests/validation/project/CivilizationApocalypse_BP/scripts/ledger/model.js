import { label, line, sanitize, wrap } from "./text.js";

/**
 * Plain menu models. Every presenter returns these shapes, and the runtime renders them without
 * knowing anything about the game:
 *
 *   Menu    { id, kind: "menu", title, lines: string[], buttons: Button[], back: boolean, pages?: {page, pages} }
 *   Confirm { id, kind: "confirm", title, lines, buttons: [confirm, cancel] }   (a two-button form)
 *   Result  { id, kind: "result", title, lines, buttons: [back], back: true }
 *
 *   Button  { id, label, enabled, reason?, action? }
 *     - an enabled button always carries an action; a disabled button always carries a reason;
 *     - action = { id, params?, confirmed? }; `id` names a handler in actions.js (`nav.*` for navigation);
 *     - a world-changing action is never reachable from a menu with `confirmed` set: only the confirm
 *       model's first button carries it.
 */

/**
 * @typedef {{ id: string, params?: Record<string, unknown>, confirmed?: boolean }} ButtonAction
 * @typedef {{ id: string, label: string, enabled: boolean, reason?: string, action?: ButtonAction }} Button
 * @typedef {{ id: string, kind: "menu" | "confirm" | "result", title: string, lines: string[], buttons: Button[], back: boolean, pages?: { page: number, pages: number } }} MenuModel
 */

/**
 * @param {string} id
 * @param {unknown} text
 * @param {ButtonAction} action
 * @returns {Button}
 */
export function enabledButton(id, text, action) {
    return { id, label: label(text), enabled: true, action };
}

/**
 * @param {string} id
 * @param {unknown} text
 * @param {unknown} reason
 * @returns {Button}
 */
export function disabledButton(id, text, reason) {
    const why = sanitize(reason ?? "");
    return { id, label: label(text), enabled: false, reason: line(why.length > 0 ? why : "not available") };
}

/**
 * A button that is shown but cannot be used because the feature is not built yet.
 * @param {string} id
 * @param {unknown} text
 */
export function notImplemented(id, text) {
    return disabledButton(id, text, "not implemented");
}

/**
 * @param {string} id
 * @param {unknown} text
 * @param {string} menu
 * @param {Record<string, unknown>} [params]
 */
export function navButton(id, text, menu, params = {}) {
    return enabledButton(id, text, { id: "nav.open", params: { menu, params } });
}

/** @returns {Button} */
export function backButton() {
    return enabledButton("back", "Back", { id: "nav.back" });
}

/** @returns {Button} */
export function homeButton() {
    return enabledButton("home", "Home", { id: "nav.home" });
}

/**
 * @param {{ id: string, kind?: "menu" | "confirm" | "result", title: unknown, lines: unknown[], buttons: Button[], back: boolean, pages?: { page: number, pages: number } }} input
 * @returns {MenuModel}
 */
export function menuModel(input) {
    /** @type {MenuModel} */
    const model = {
        id: input.id,
        kind: input.kind ?? "menu",
        title: label(input.title),
        lines: input.lines.flatMap((text) => wrap(text)),
        buttons: input.buttons,
        back: input.back,
    };
    if (input.pages !== undefined) {
        model.pages = input.pages;
    }
    return model;
}

/**
 * Lines for a menu that could not be built (unknown menu, missing subject).
 * @param {string} id
 * @param {string} title
 * @param {string} message
 * @returns {MenuModel}
 */
export function missingModel(id, title, message) {
    return menuModel({
        id,
        title,
        lines: [message],
        buttons: [backButton(), homeButton()],
        back: true,
    });
}
