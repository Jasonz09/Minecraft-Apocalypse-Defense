/**
 * Deterministic, serialisable pseudo-random numbers. Every random decision in the
 * simulation draws from `kingdom.rngState`, so a given seed plus a given number of
 * steps always produces the same kingdom - which is what makes the siege and
 * expansion tests reproducible.
 *
 * Algorithm: mulberry32 (32-bit, no dependencies, stable across JS engines).
 */

/**
 * @param {number} state
 * @returns {{ value: number, next: number }} value in [0, 1)
 */
export function nextFloat(state) {
    const seed = (state + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, next: seed };
}

/**
 * @param {number} state
 * @param {number} min inclusive
 * @param {number} max inclusive
 * @returns {{ value: number, next: number }}
 */
export function nextInt(state, min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new Error(`nextInt: bad range ${String(min)}..${String(max)}`);
    }
    const draw = nextFloat(state);
    return { value: min + Math.floor(draw.value * (max - min + 1)), next: draw.next };
}

/**
 * @param {number} state
 * @param {number} probability 0..1 chance of being true
 * @returns {{ value: boolean, next: number }}
 */
export function nextChance(state, probability) {
    if (!(probability >= 0) || !(probability <= 1)) {
        throw new Error(`nextChance: probability must be 0..1, got ${String(probability)}`);
    }
    const draw = nextFloat(state);
    return { value: draw.value < probability, next: draw.next };
}

/**
 * Derive a stable 32-bit integer from a string, for seeding from world seeds.
 * @param {string} text
 */
export function hashSeed(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
