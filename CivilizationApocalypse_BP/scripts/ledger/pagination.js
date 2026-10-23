import { LEDGER_TEXT } from "./text.js";

/**
 * Splits a menu's content buttons across pages.
 *
 * Chrome buttons (Back, Home) sit on every page. When the content does not fit, a page keeps room for
 * a "previous" and a "next" button, so no page ever holds more than `maxButtons`.
 *
 * Invariants (tested exhaustively): concatenating every page's content buttons yields the original
 * list exactly once and in order; no page exceeds `maxButtons`; a page number outside the range is
 * clamped rather than producing an empty or wrapped page.
 *
 * @template T
 * @param {{
 *   content: T[],
 *   chrome?: T[],
 *   page?: number,
 *   maxButtons?: number,
 *   makeNav: (targetPage: number, direction: "previous" | "next") => T,
 * }} options
 * @returns {{ buttons: T[], page: number, pages: number, perPage: number, contentShown: T[] }}
 */
export function paginateButtons(options) {
    const content = options.content;
    const chrome = options.chrome ?? [];
    const maxButtons = options.maxButtons ?? LEDGER_TEXT.maxButtons;
    const room = maxButtons - chrome.length;
    if (room < 3) {
        throw new Error(`paginateButtons: ${String(maxButtons)} buttons cannot hold ${String(chrome.length)} chrome buttons and paging`);
    }

    let perPage = room;
    let pages = 1;
    if (content.length > room) {
        perPage = room - 2;
        pages = Math.ceil(content.length / perPage);
    }

    const requested = Number.isFinite(options.page) ? Math.floor(Number(options.page)) : 0;
    const page = Math.min(Math.max(0, requested), pages - 1);
    const contentShown = content.slice(page * perPage, (page + 1) * perPage);

    /** @type {T[]} */
    const buttons = [...contentShown];
    if (pages > 1) {
        if (page > 0) {
            buttons.push(options.makeNav(page - 1, "previous"));
        }
        if (page < pages - 1) {
            buttons.push(options.makeNav(page + 1, "next"));
        }
    }
    buttons.push(...chrome);
    return { buttons, page, pages, perPage, contentShown };
}

/**
 * Most content buttons one page can hold for a given chrome count (used by callers that size lists).
 * @param {number} chromeCount
 * @param {number} [maxButtons]
 */
export function contentRoom(chromeCount, maxButtons = LEDGER_TEXT.maxButtons) {
    return maxButtons - chromeCount;
}
