/**
 * Text rules for every line and button the Ledger shows.
 *
 * Rules (documented and tested in dev/test/ledger-presenters.test.mjs):
 *  - no Minecraft section sign (U+00A7, the colour and format code prefix) is ever emitted: the Ledger
 *    prints plain text only, so a colour code in a saved name can never recolour or swallow a line;
 *  - C0 control characters and DEL are replaced by spaces (a newline is never a line break inside a
 *    line - the body is joined from separate lines by the runtime);
 *  - every body line is at most LEDGER_TEXT.lineWidth characters, and every button label at most
 *    LEDGER_TEXT.buttonWidth characters; longer text is cut and ends with "...";
 *  - ASCII punctuation only in labels the Ledger writes itself (no emoji, no pictographs), because
 *    button icons need a resource pack and are not used.
 */

export const LEDGER_TEXT = Object.freeze({
    /** Longest body line, in characters. */
    lineWidth: 56,
    /** Longest button label, in characters. */
    buttonWidth: 34,
    /** Most buttons on one form page, navigation and chrome buttons included. */
    maxButtons: 12,
});

/** Text a form must never contain: section signs and control characters. */
export const FORBIDDEN_TEXT = /[§\u0000-\u001f\u007f]/;

/**
 * Makes any value safe to print: control characters become spaces, section signs are removed and
 * runs of whitespace collapse to one space.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitize(value) {
    return String(value)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/§/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function fit(text, width) {
    if (text.length <= width) {
        return text;
    }
    return `${text.slice(0, Math.max(0, width - 3)).trimEnd()}...`;
}

/**
 * A single body line: sanitised and cut to the line width. Use wrap() for text that must not lose words.
 * @param {unknown} value
 * @returns {string}
 */
export function line(value) {
    return fit(sanitize(value), LEDGER_TEXT.lineWidth);
}

/**
 * Body text split into lines that each fit the width. Words are kept whole where they can be; a word
 * longer than a line is split. Continuation lines are indented by two spaces. Nothing is dropped.
 *
 * @param {unknown} value
 * @param {number} [width]
 * @returns {string[]}
 */
export function wrap(value, width = LEDGER_TEXT.lineWidth) {
    const text = sanitize(value);
    if (text.length <= width) {
        return [text];
    }
    /** @type {string[]} */
    const out = [];
    let current = "";
    const limit = () => (out.length === 0 ? width : width - 2);
    const start = () => (out.length === 0 ? "" : "  ");
    for (const word of text.split(" ")) {
        let rest = word;
        for (;;) {
            const candidate = current.length === 0 ? `${start()}${rest}` : `${current} ${rest}`;
            if (candidate.length <= limit()) {
                current = candidate;
                break;
            }
            if (current.length > 0) {
                out.push(current);
                current = "";
                continue;
            }
            const room = limit() - start().length;
            out.push(`${start()}${rest.slice(0, room)}`);
            rest = rest.slice(room);
            if (rest.length === 0) {
                break;
            }
        }
    }
    if (current.length > 0) {
        out.push(current);
    }
    return out;
}

/**
 * A button label: sanitised and fitted to the button width.
 * @param {unknown} value
 * @returns {string}
 */
export function label(value) {
    return fit(sanitize(value), LEDGER_TEXT.buttonWidth);
}

/**
 * Whether a finished line obeys every rule above. Used by the tests.
 * @param {string} text
 */
export function isPlainLine(text) {
    return typeof text === "string" && text.length <= LEDGER_TEXT.lineWidth && !FORBIDDEN_TEXT.test(text);
}

/**
 * Whole-number display for a value that may be fractional or missing.
 * @param {unknown} value
 * @returns {number}
 */
export function whole(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : 0;
}

/**
 * One decimal place, as the stores and reserves are shown.
 * @param {unknown} value
 * @returns {number}
 */
export function tenths(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 10) / 10 : 0;
}
