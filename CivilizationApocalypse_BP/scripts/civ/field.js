/**
 * Compact height field for civilization planning. Pure (no Minecraft imports).
 *
 * Contract (shared with dev/lib/fakefield.mjs): `field.at(x, z) -> { g, k, tree }` and
 * `field.bounds -> { x0, z0, x1, z1 }` (inclusive). Everything outside the bounds, and every
 * cell nobody has written yet, answers `k: "unloaded"`.
 *
 * Storage: one Int16 ground height + one flag byte per grid cell (kind in the low 3 bits,
 * tree bit, "known" bit), so a 700 x 700 block field at step 1 costs ~1.5 MB. With `step > 1`
 * one cell stands for a step x step block square (one sample per square).
 */

/** @typedef {"land" | "water" | "lava" | "blocked" | "unloaded"} FieldKind */
/** @typedef {{ g: number, k: FieldKind, tree: boolean }} FieldCell */
/** @typedef {{ x0: number, z0: number, x1: number, z1: number }} Bounds */
/** @typedef {{ bounds: Bounds, at: (x: number, z: number) => FieldCell }} HeightField */

/** Numeric kind codes used in the flag byte (0 = unloaded / never read). */
export const KIND_CODES = /** @type {const} */ ({ unloaded: 0, land: 1, water: 2, lava: 3, blocked: 4 });
/** @type {FieldKind[]} */
const KIND_NAMES = ["unloaded", "land", "water", "lava", "blocked"];
const KIND_MASK = 7;
const TREE_BIT = 8;
const KNOWN_BIT = 16;
const SERIAL_VERSION = 1;

/** @param {string} kind */
export function kindCode(kind) {
    const code = /** @type {Record<string, number>} */ (KIND_CODES)[kind];
    return code === undefined ? 0 : code;
}

/**
 * @typedef {HeightField & {
 *   step: number, cols: number, rows: number,
 *   set: (x: number, z: number, cell: { g: number, k: FieldKind, tree?: boolean, rel?: number }) => void,
 *   has: (x: number, z: number) => boolean,
 *   columnsRead: number,
 *   reliefAt: (x: number, z: number) => number,
 *   memoryBytes: () => number,
 *   toJSON: () => SerialField,
 * }} GridField
 * @typedef {{ v: number, x0: number, z0: number, w: number, h: number, step: number, flags: number[], ground: number[], rel?: number[] }} SerialField
 */

/** @type {Readonly<FieldCell>} */
const UNLOADED = Object.freeze({ g: 0, k: /** @type {FieldKind} */ ("unloaded"), tree: false });

/**
 * @param {{ x0: number, z0: number, w: number, h: number, step?: number, relief?: boolean }} spec
 *   w and h are block extents; the grid holds ceil(w / step) x ceil(h / step) cells.
 * @returns {GridField}
 */
export function makeGridField(spec) {
    const step = spec.step ?? 1;
    if (!Number.isInteger(step) || step < 1) throw new Error("step must be a positive integer");
    if (!Number.isInteger(spec.w) || !Number.isInteger(spec.h) || spec.w < 1 || spec.h < 1) throw new Error("w and h must be positive integers");
    const { x0, z0 } = spec;
    const cols = Math.ceil(spec.w / step);
    const rows = Math.ceil(spec.h / step);
    const count = cols * rows;
    const ground = new Int16Array(count);
    const flags = new Uint8Array(count);
    const rel = spec.relief === true ? new Uint8Array(count) : null;
    const bounds = { x0, z0, x1: x0 + spec.w - 1, z1: z0 + spec.h - 1 };
    let known = 0;

    /** @param {number} x @param {number} z */
    const indexOf = (x, z) => {
        if (x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1) return -1;
        return Math.floor((z - z0) / step) * cols + Math.floor((x - x0) / step);
    };

    return {
        bounds,
        step,
        cols,
        rows,
        get columnsRead() {
            return known;
        },
        at(x, z) {
            const index = indexOf(x, z);
            if (index < 0) return UNLOADED;
            const flag = /** @type {number} */ (flags[index]);
            if ((flag & KNOWN_BIT) === 0) return UNLOADED;
            return { g: /** @type {number} */ (ground[index]), k: /** @type {FieldKind} */ (KIND_NAMES[flag & KIND_MASK]), tree: (flag & TREE_BIT) !== 0 };
        },
        has(x, z) {
            const index = indexOf(x, z);
            return index >= 0 && ((/** @type {number} */ (flags[index])) & KNOWN_BIT) !== 0;
        },
        set(x, z, cell) {
            const index = indexOf(x, z);
            if (index < 0) return;
            if (!Number.isFinite(cell.g) || cell.g < -32768 || cell.g > 32767) throw new Error("ground height out of Int16 range");
            if ((/** @type {number} */ (flags[index]) & KNOWN_BIT) === 0) known += 1;
            ground[index] = Math.round(cell.g);
            flags[index] = kindCode(cell.k) | (cell.tree === true ? TREE_BIT : 0) | KNOWN_BIT;
            if (rel !== null) rel[index] = Math.max(0, Math.min(255, Math.round(cell.rel ?? 0)));
        },
        reliefAt(x, z) {
            const index = indexOf(x, z);
            return rel === null || index < 0 ? 0 : /** @type {number} */ (rel[index]);
        },
        memoryBytes() {
            return ground.byteLength + flags.byteLength + (rel === null ? 0 : rel.byteLength);
        },
        toJSON() {
            /** @type {SerialField} */
            const out = {
                v: SERIAL_VERSION,
                x0,
                z0,
                w: spec.w,
                h: spec.h,
                step,
                flags: rleEncode(flags, false),
                ground: rleEncode(ground, true),
            };
            if (rel !== null) out.rel = rleEncode(rel, false);
            return out;
        },
    };
}

/**
 * Flat run-length encoding `[value, run, value, run, ...]`; with `delta` the values are
 * differences from the previous cell (terrain is smooth, so runs get long).
 * @param {ArrayLike<number>} data @param {boolean} delta
 */
function rleEncode(data, delta) {
    /** @type {number[]} */
    const out = [];
    let previous = 0;
    let value = 0;
    let run = 0;
    for (let index = 0; index < data.length; index += 1) {
        const raw = /** @type {number} */ (data[index]);
        const symbol = delta ? raw - previous : raw;
        previous = raw;
        if (run > 0 && symbol === value) {
            run += 1;
        } else {
            if (run > 0) out.push(value, run);
            value = symbol;
            run = 1;
        }
    }
    if (run > 0) out.push(value, run);
    return out;
}

/**
 * @param {number[]} pairs @param {boolean} delta @param {{ length: number, [index: number]: number }} target
 */
function rleDecode(pairs, delta, target) {
    if (!Array.isArray(pairs) || pairs.length % 2 !== 0) throw new Error("corrupt field: bad run list");
    let position = 0;
    let previous = 0;
    for (let index = 0; index < pairs.length; index += 2) {
        const symbol = /** @type {number} */ (pairs[index]);
        const run = /** @type {number} */ (pairs[index + 1]);
        if (!Number.isInteger(symbol) || !Number.isInteger(run) || run < 1 || position + run > target.length) throw new Error("corrupt field: run out of range");
        for (let k = 0; k < run; k += 1) {
            previous = delta ? previous + symbol : symbol;
            target[position] = previous;
            position += 1;
        }
    }
    if (position !== target.length) throw new Error("corrupt field: run lengths do not cover the grid");
}

/**
 * Rebuild a grid field from `toJSON()` output (also accepts a JSON string). Throws on corruption.
 * @param {SerialField | string} json
 * @returns {GridField}
 */
export function fromJSON(json) {
    const data = /** @type {SerialField} */ (typeof json === "string" ? JSON.parse(json) : json);
    if (data === null || typeof data !== "object" || data.v !== SERIAL_VERSION) throw new Error("unsupported field version");
    const field = makeGridField({ x0: data.x0, z0: data.z0, w: data.w, h: data.h, step: data.step, relief: data.rel !== undefined });
    const count = field.cols * field.rows;
    const flags = new Uint8Array(count);
    const ground = new Int16Array(count);
    rleDecode(data.flags, false, flags);
    rleDecode(data.ground, true, ground);
    const rel = data.rel === undefined ? null : new Uint8Array(count);
    if (rel !== null && data.rel !== undefined) rleDecode(data.rel, false, rel);
    for (let index = 0; index < count; index += 1) {
        const flag = /** @type {number} */ (flags[index]);
        if ((flag & KNOWN_BIT) === 0) continue;
        const x = data.x0 + (index % field.cols) * field.step;
        const z = data.z0 + Math.floor(index / field.cols) * field.step;
        field.set(x, z, {
            g: /** @type {number} */ (ground[index]),
            k: /** @type {FieldKind} */ (KIND_NAMES[flag & KIND_MASK] ?? "unloaded"),
            tree: (flag & TREE_BIT) !== 0,
            rel: rel === null ? 0 : /** @type {number} */ (rel[index]),
        });
    }
    return field;
}

/**
 * Collapse any height field to a coarser grid (`step` blocks per cell). Each cell samples up to
 * 4 x 4 columns. Kind is pessimistic: any unloaded sample -> unloaded, else lava > water >
 * blocked > land. Ground is the rounded mean of land samples, `tree` is set when a quarter of
 * the land samples have trees, and the within-cell relief (max - min) is kept for the planner.
 *
 * @param {HeightField} field @param {number} step
 * @returns {GridField}
 */
export function resample(field, step) {
    const b = field.bounds;
    const out = makeGridField({ x0: b.x0, z0: b.z0, w: b.x1 - b.x0 + 1, h: b.z1 - b.z0 + 1, step, relief: true });
    const sub = Math.min(step, 4);
    for (let cz = 0; cz < out.rows; cz += 1) {
        for (let cx = 0; cx < out.cols; cx += 1) {
            const bx = b.x0 + cx * step;
            const bz = b.z0 + cz * step;
            let land = 0;
            let sum = 0;
            let trees = 0;
            let lo = Infinity;
            let hi = -Infinity;
            let unloaded = false;
            let water = false;
            let lava = false;
            let blocked = false;
            for (let j = 0; j < sub; j += 1) {
                for (let i = 0; i < sub; i += 1) {
                    const s = field.at(Math.min(b.x1, bx + Math.floor(((i + 0.5) * step) / sub)), Math.min(b.z1, bz + Math.floor(((j + 0.5) * step) / sub)));
                    if (s.k === "unloaded") unloaded = true;
                    else if (s.k === "lava") lava = true;
                    else if (s.k === "water") water = true;
                    else if (s.k === "blocked") blocked = true;
                    else {
                        land += 1;
                        sum += s.g;
                        if (s.tree) trees += 1;
                        lo = Math.min(lo, s.g);
                        hi = Math.max(hi, s.g);
                    }
                }
            }
            /** @type {FieldKind} */
            const kind = unloaded ? "unloaded" : lava ? "lava" : water ? "water" : blocked ? "blocked" : "land";
            out.set(bx, bz, { g: land > 0 ? Math.round(sum / land) : 0, k: kind, tree: land > 0 && trees * 4 >= land, rel: land > 0 ? hi - lo : 0 });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Suitability

/**
 * @typedef {{ maxSlope?: number }} SuitabilityOptions
 * @typedef {{
 *   code: 0 | 1 | 2 | 3 | 4 | 5, usable: boolean, reason: string, g: number, slope: number, relief: number, dev: number,
 *   tree: boolean, nearWater: boolean, nearLava: boolean, quality: number,
 * }} CellAssessment
 */

/** Cell codes: 0 unloaded/unknown, 1 buildable, 2 too steep, 3 water, 4 lava or lava-adjacent, 5 blocked. */
export const DEFAULT_MAX_SLOPE = 0.6;

/**
 * Judge one sample from its 3 x 3 neighbourhood (row-major, dz -1..1 then dx -1..1, index 4 is the
 * centre; samples are `step` blocks apart). Slope is the largest height change per block towards
 * a land neighbour, measured over at least 4 blocks so unit-step noise at step 1 is not "steep".
 *
 * @param {readonly FieldCell[]} nine @param {number} step @param {SuitabilityOptions} [options]
 * @returns {CellAssessment}
 */
export function assessCell(nine, step, options = {}) {
    const maxSlope = options.maxSlope ?? DEFAULT_MAX_SLOPE;
    const centre = /** @type {FieldCell} */ (nine[4]);
    /** @type {CellAssessment} */
    const base = { code: 0, usable: false, reason: "", g: centre.g, slope: 0, relief: 0, dev: 0, tree: centre.tree, nearWater: false, nearLava: false, quality: 0 };
    if (centre.k === "unloaded") return { ...base, reason: "unloaded" };
    if (centre.k === "water") return { ...base, code: 3, reason: "water", nearWater: true };
    if (centre.k === "lava") return { ...base, code: 4, reason: "lava", nearLava: true };
    if (centre.k === "blocked") return { ...base, code: 5, reason: "blocked" };

    let nearWater = false;
    let nearLava = false;
    let unknown = false;
    let lo = centre.g;
    let hi = centre.g;
    let slope = 0;
    let sum = 0;
    let n = 0;
    const baseDistance = Math.max(step, 4);
    for (let index = 0; index < 9; index += 1) {
        const cell = /** @type {FieldCell} */ (nine[index]);
        if (cell.k === "lava") nearLava = true;
        else if (cell.k === "water") nearWater = true;
        else if (cell.k === "unloaded") unknown = true;
        if (cell.k !== "land") continue;
        sum += cell.g;
        n += 1;
        lo = Math.min(lo, cell.g);
        hi = Math.max(hi, cell.g);
        if (index !== 4) {
            const diagonal = index % 2 === 0;
            slope = Math.max(slope, Math.abs(cell.g - centre.g) / (diagonal ? baseDistance * Math.SQRT2 : baseDistance));
        }
    }
    const mean = sum / n;
    let dev = 0;
    for (let index = 0; index < 9; index += 1) {
        const cell = /** @type {FieldCell} */ (nine[index]);
        if (cell.k === "land") dev += Math.abs(cell.g - mean);
    }
    dev /= n;
    const filled = { ...base, g: centre.g, slope, relief: hi - lo, dev, nearWater, nearLava };
    if (nearLava) return { ...filled, code: 4, reason: "lava next to this cell" };
    if (unknown) return { ...filled, code: 0, reason: "a neighbouring cell is unloaded" };
    if (slope > maxSlope) return { ...filled, code: 2, reason: `too steep (${slope.toFixed(2)} per block)` };
    const quality = Math.max(0, Math.min(1, 1 - 0.6 * (slope / maxSlope) - (centre.tree ? 0.2 : 0) - (nearWater ? 0.1 : 0)));
    return { ...filled, code: 1, usable: true, reason: "ok", quality };
}

/**
 * Suitability of the cell whose sample point is (x, z), neighbours `step` blocks away.
 * @param {HeightField} field @param {number} x @param {number} z @param {number} step @param {SuitabilityOptions} [options]
 */
export function suitabilityCell(field, x, z, step, options = {}) {
    /** @type {FieldCell[]} */
    const nine = [];
    for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) nine.push(field.at(x + dx * step, z + dz * step));
    return assessCell(nine, step, options);
}
