/**
 * Command argument parsing. Pure, so it can be unit-tested without the Minecraft runtime
 * (which is types-only on disk and cannot be imported from Node).
 */

/**
 * @param {string|undefined} message
 * @returns {string[]}
 */
export function parseArgs(message) {
    const trimmed = typeof message === "string" ? message.trim() : "";
    return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/**
 * @param {string|undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {{ value: number, error: string | undefined }}
 */
export function parseCount(value, fallback, min, max) {
    if (value === undefined) {
        return { value: fallback, error: undefined };
    }
    if (!/^\d+$/.test(value)) {
        return { value: fallback, error: `'${value}' is not a whole number` };
    }
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
        return { value: fallback, error: `must be between ${String(min)} and ${String(max)}` };
    }
    return { value: parsed, error: undefined };
}
