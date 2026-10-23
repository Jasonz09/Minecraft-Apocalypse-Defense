import { backButton, enabledButton, homeButton, menuModel } from "./model.js";
import { paginateButtons } from "./pagination.js";
import { ROOT_MENU } from "./navigation.js";

/**
 * The shared shell every menu is built in: body lines, content buttons (paged) and the chrome.
 * Chrome is Back and Home on every non-root menu; the root has none (the form's own close does that).
 *
 * @param {{ menu: string, params: Record<string, unknown>, page: number }} frame
 * @param {{ title: string, lines: string[], content: import("./model.js").Button[] }} spec
 * @returns {import("./model.js").MenuModel}
 */
export function assemble(frame, spec) {
    const isRoot = frame.menu === ROOT_MENU;
    const chrome = isRoot ? [] : [backButton(), homeButton()];
    const paged = paginateButtons({
        content: spec.content,
        chrome,
        page: frame.page,
        makeNav: (target, direction) =>
            enabledButton(`page-${direction}`, direction === "previous" ? "Previous page" : "Next page", {
                id: "nav.page",
                params: { menu: frame.menu, params: frame.params, page: target },
            }),
    });
    return menuModel({
        id: frame.menu,
        title: spec.title,
        lines: spec.lines,
        buttons: paged.buttons,
        back: !isRoot,
        pages: paged.pages > 1 ? { page: paged.page, pages: paged.pages } : undefined,
    });
}

/**
 * Renders a value that may be missing as text the player can read.
 * @param {unknown} value
 * @param {string} fallback
 */
export function orNone(value, fallback = "none") {
    if (value === undefined || value === null) {
        return fallback;
    }
    const text = String(value);
    return text.length > 0 ? text : fallback;
}
