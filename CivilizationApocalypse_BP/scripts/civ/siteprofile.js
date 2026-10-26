import { fnv1a, utf8Length } from "./planstore.js";
import { WORK_LIMIT, markYield, newOps, runSync } from "./regions.js";

/** @typedef {import("./regions.js").Ops} Ops */

/** Hard cap of one stretch between yields (elementary operations). */
export const MAX_RUN = 24000;

/**
 * Charge `n` elementary operations to `ops` and yield when the tick budget is used up. The check is made
 * BEFORE the work, so no stretch between two yields exceeds MAX_RUN when one charge is below it.
 *
 * @param {Ops} ops @param {number} n
 * @returns {Generator<void, void, void>}
 */
export function* pace(ops, n) {
    if (ops.work - ops.lastYield + n > MAX_RUN) {
        markYield(ops);
        yield;
    }
    ops.work += n;
    if (ops.work - ops.lastYield >= WORK_LIMIT) {
        markYield(ops);
        yield;
    }
}

/** FNV-1a step over a string, continuing from hash state `h` (same maths as planstore.fnv1a). @param {number} h @param {string} text */
export function fnvFeed(h, text) {
    let x = h;
    for (let i = 0; i < text.length; i += 1) {
        x ^= text.charCodeAt(i);
        x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
}

/**
 * fnv1a(parts.join("")) without building the joined string, in bounded chunks.
 * @param {string[]} parts @param {Ops} ops
 * @returns {Generator<void, string, void>}
 */
export function* fnvPartsSteps(parts, ops) {
    let h = 0x811c9dc5;
    for (const part of parts) {
        for (let at = 0; at < part.length; at += 1024) {
            h = fnvFeed(h, part.slice(at, at + 1024));
            yield* pace(ops, Math.min(1024, part.length - at) * 3);
        }
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Persisted ground for the construction planner. Pure (no Minecraft imports).
 *
 * Why this exists: `civ/districtplan.js` is a pure function of `(CivPlan, ground)`. The world
 * ground under the district is CHANGED by the build itself (cuts, fills, pads, walls), so after a
 * restart a re-scan can no longer tell natural ground from our own blocks. The planning scan is
 * therefore stored: `exportSiteGround(field, region)` freezes every column of the district's
 * region (bounding box + margin) at full resolution, and `importSiteGround(json)` rebuilds a
 * field that answers `at(x, z)` identically. `rehydrateSite` (districtplan.js) then re-plans from
 * `(plan, ground)` and gets the same checksum and the same op streams as the original run.
 *
 * Compact encoding (the whole point is to fit `CIV_LIMITS.maxPlanBytes` beside the CivPlan):
 *   - ground height `g`: LOCO-I median predictor (W, N, W+N-NW), residual zig-zagged and written
 *     with an adaptive Golomb-Rice code into a bit stream, 6 bits per URL-safe character;
 *   - kind: run-length pairs (kind code, run) as base-32 varints (water / lava / unloaded are rare);
 *   - tree flag: gap-coded positions of the columns that carry a natural tree, base-32 varints;
 *   - water surface `s` (only present when the region holds water): one rice-coded residual per
 *     WATER column (the others cost nothing), the depth from the bed (`g`) to the surface. A water
 *     column's `g` is the BED and `s` records the surface, which piers and decks need. A region
 *     without water omits the stream entirely, so every land plan's stored ground is byte-identical
 *     to before.
 * Unloaded columns carry the predicted height (residual 0) and kind 0, so they cost nothing.
 *
 * What the planner may read is exactly the region: `clipField` answers "unloaded" outside it and
 * counts such reads, so the planner is proven to need nothing the export does not hold.
 */

export const SITE_GROUND_VERSION = 1;

/** Blocks added around the district bounding box. Roads may run <= 14 blocks past a gate (contract). */
export const SITE_GROUND_MARGIN = 20;

const KIND_NAMES = /** @type {const} */ (["unloaded", "land", "water", "lava", "blocked"]);
/** @type {Record<string, number>} */
const KIND_CODE = { unloaded: 0, land: 1, water: 2, lava: 3, blocked: 4 };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** @type {Record<string, number>} */
const ALPHABET_INDEX = {};
for (let i = 0; i < ALPHABET.length; i += 1) {
    ALPHABET_INDEX[/** @type {string} */ (ALPHABET[i])] = i;
}

/**
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} SiteRegion
 * @typedef {{ v: number, x0: number, z0: number, w: number, h: number, g: string, k: string, t: string, s?: string, hash: string }} SiteGroundJSON
 * @typedef {{ bounds: SiteRegion, at: (x: number, z: number) => { g: number, k: string, tree: boolean, surface?: number }, outsideReads: () => number, firstOutside: () => ({ x: number, z: number } | null), readCount: () => number }} ClippedField
 */

// ---------------------------------------------------------------------------------------------
// Region

/**
 * The block rectangle the planner is allowed to look at, derived from the CivPlan alone (so a
 * restart can compute it before any ground is loaded).
 *
 * @param {any} plan
 * @param {number} index
 * @param {number} [margin]
 * @returns {SiteRegion}
 */
export function siteGroundRegion(plan, index, margin = SITE_GROUND_MARGIN) {
    const district = /** @type {any[]} */ (plan?.districts ?? []).find((entry) => entry?.index === index);
    if (district === undefined || district.bbox === undefined) {
        throw new Error(`siteGroundRegion: the plan has no district ${String(index)}`);
    }
    const box = district.bbox;
    let { x0, z0, x1, z1 } = box;
    for (const wall of /** @type {any[]} */ (plan.walls ?? [])) {
        if (!(/** @type {any[]} */ (wall?.between ?? [])).includes(index)) {
            continue;
        }
        for (const point of /** @type {number[][]} */ (wall.path ?? [])) {
            x0 = Math.min(x0, /** @type {number} */ (point[0]));
            x1 = Math.max(x1, /** @type {number} */ (point[0]));
            z0 = Math.min(z0, /** @type {number} */ (point[1]));
            z1 = Math.max(z1, /** @type {number} */ (point[1]));
        }
    }
    return { x0: x0 - margin, z0: z0 - margin, x1: x1 + margin, z1: z1 + margin };
}

/**
 * Wrap any height field so the planner sees only `region`, with values normalised exactly the way
 * the export stores them (integer ground, one of five kinds, boolean tree). Outside the region
 * (and for malformed samples) the answer is `unloaded`, and outside reads are counted.
 *
 * @param {{ at: (x: number, z: number) => any }} field
 * @param {SiteRegion} region
 * @returns {ClippedField}
 */
export function clipField(field, region) {
    if (field === null || typeof field !== "object" || typeof field.at !== "function") {
        throw new Error("clipField: field must expose at(x, z) -> { g, k, tree }");
    }
    let outside = 0;
    let reads = 0;
    /** @type {{ x: number, z: number } | null} */
    let first = null;
    const unloaded = Object.freeze({ g: 0, k: "unloaded", tree: false });
    return {
        bounds: { x0: region.x0, z0: region.z0, x1: region.x1, z1: region.z1 },
        at(x, z) {
            const bx = Math.floor(x);
            const bz = Math.floor(z);
            reads += 1;
            if (bx < region.x0 || bx > region.x1 || bz < region.z0 || bz > region.z1) {
                outside += 1;
                first ??= { x: bx, z: bz };
                return unloaded;
            }
            const cell = field.at(bx, bz);
            if (cell === null || cell === undefined || !Number.isFinite(cell.g)) {
                return unloaded;
            }
            const code = KIND_CODE[String(cell.k)];
            if (code === undefined || code === 0) {
                return unloaded;
            }
            return {
                g: Math.floor(cell.g),
                k: /** @type {string} */ (KIND_NAMES[code]),
                tree: cell.tree === true,
                ...(Number.isFinite(cell.surface) ? { surface: Math.floor(/** @type {number} */ (cell.surface)) } : {}),
            };
        },
        outsideReads: () => outside,
        firstOutside: () => first,
        readCount: () => reads,
    };
}

// ---------------------------------------------------------------------------------------------
// Bit and varint streams

class BitWriter {
    constructor() {
        /** @type {string[]} */
        this.chars = [];
        this.acc = 0;
        this.nbits = 0;
    }

    /** @param {number} bit */
    bit(bit) {
        this.acc = (this.acc << 1) | (bit & 1);
        this.nbits += 1;
        if (this.nbits === 6) {
            this.chars.push(/** @type {string} */ (ALPHABET[this.acc]));
            this.acc = 0;
            this.nbits = 0;
        }
    }

    /** @param {number} value @param {number} count */
    bits(value, count) {
        for (let i = count - 1; i >= 0; i -= 1) {
            this.bit((value >> i) & 1);
        }
    }

    finish() {
        while (this.nbits !== 0) {
            this.bit(0);
        }
        return this.chars.join("");
    }
}

class BitReader {
    /** @param {string} text */
    constructor(text) {
        this.text = text;
        this.pos = 0;
        this.cur = 0;
        this.left = 0;
    }

    bit() {
        if (this.left === 0) {
            if (this.pos >= this.text.length) {
                throw new Error("corrupt site ground: bit stream ended early");
            }
            const value = ALPHABET_INDEX[/** @type {string} */ (this.text[this.pos])];
            if (value === undefined) {
                throw new Error("corrupt site ground: bad character in bit stream");
            }
            this.cur = value;
            this.pos += 1;
            this.left = 6;
        }
        this.left -= 1;
        return (this.cur >> this.left) & 1;
    }

    /** @param {number} count */
    bits(count) {
        let out = 0;
        for (let i = 0; i < count; i += 1) {
            out = (out << 1) | this.bit();
        }
        return out;
    }
}

/**
 * Base-32 varint: 5 payload bits per character, bit 5 = "more follows".
 * @param {string[]} out @param {number} value
 */
function pushVar(out, value) {
    let v = value;
    while (v >= 32) {
        out.push(/** @type {string} */ (ALPHABET[32 + (v & 31)]));
        v = Math.floor(v / 32);
    }
    out.push(/** @type {string} */ (ALPHABET[v]));
}

/**
 * @param {string} text
 * @returns {number[]}
 */
function readVars(text) {
    /** @type {number[]} */
    const out = [];
    let value = 0;
    let scale = 1;
    for (let i = 0; i < text.length; i += 1) {
        const c = ALPHABET_INDEX[/** @type {string} */ (text[i])];
        if (c === undefined) {
            throw new Error("corrupt site ground: bad character in varint stream");
        }
        value += (c & 31) * scale;
        if (c >= 32) {
            scale *= 32;
        } else {
            out.push(value);
            value = 0;
            scale = 1;
        }
    }
    if (scale !== 1 || value !== 0) {
        throw new Error("corrupt site ground: truncated varint stream");
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Ground residual coder

const ESCAPE_Q = 20;

/** Rice parameter from running statistics (JPEG-LS style, with periodic halving). */
class RiceState {
    constructor() {
        this.a = 4;
        this.n = 1;
    }

    k() {
        let k = 0;
        while (this.n << k < this.a) {
            k += 1;
        }
        return k;
    }

    /** @param {number} z */
    update(z) {
        this.a += z;
        this.n += 1;
        if (this.n >= 32) {
            this.a = (this.a + 1) >> 1;
            this.n = (this.n + 1) >> 1;
        }
    }
}

/** @param {number} a @param {number} b @param {number} c */
function median(a, b, c) {
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * LOCO-I prediction from already coded neighbours.
 * @param {Int32Array} g @param {number} w @param {number} x @param {number} z
 */
function predict(g, w, x, z) {
    const i = z * w + x;
    if (z === 0 && x === 0) {
        return 0;
    }
    if (z === 0) {
        return /** @type {number} */ (g[i - 1]);
    }
    if (x === 0) {
        return /** @type {number} */ (g[i - w]);
    }
    return median(/** @type {number} */ (g[i - 1]), /** @type {number} */ (g[i - w]), /** @type {number} */ (g[i - 1]) + /** @type {number} */ (g[i - w]) - /** @type {number} */ (g[i - w - 1]));
}

/** @param {number} n */
const zig = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
/** @param {number} z */
const unzig = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

// ---------------------------------------------------------------------------------------------
// Export / import

/**
 * Freeze the ground of `region` at full resolution.
 *
 * @param {{ at: (x: number, z: number) => any }} field
 * @param {SiteRegion} region
 * @returns {SiteGroundJSON}
 */
export function exportSiteGround(field, region) {
    return runSync(exportSiteGroundSteps(field, region, newOps()));
}

/**
 * Cooperative form of exportSiteGround (one implementation): yields at least every ~20,000 operations.
 *
 * @param {{ at: (x: number, z: number) => any }} field
 * @param {SiteRegion} region
 * @param {Ops} ops
 * @returns {Generator<void, SiteGroundJSON, void>}
 */
export function* exportSiteGroundSteps(field, region, ops) {
    const w = region.x1 - region.x0 + 1;
    const h = region.z1 - region.z0 + 1;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > 4_000_000) {
        throw new Error(`exportSiteGround: region ${JSON.stringify(region)} is not a sane rectangle`);
    }
    const clipped = clipField(field, region);
    const g = new Int32Array(w * h);
    const writer = new BitWriter();
    const rice = new RiceState();
    /** @type {string[]} */
    const kinds = [];
    /** @type {string[]} */
    const trees = [];
    const swriter = new BitWriter();
    const srice = new RiceState();
    let waterCols = 0;
    let lastDepth = 0;
    let runKind = -1;
    let run = 0;
    let lastTree = -1;
    for (let z = 0; z < h; z += 1) {
        yield* pace(ops, w * 14);
        for (let x = 0; x < w; x += 1) {
            const i = z * w + x;
            const cell = clipped.at(region.x0 + x, region.z0 + z);
            const code = /** @type {number} */ (KIND_CODE[cell.k]);
            const guess = predict(g, w, x, z);
            const value = code === 0 ? guess : cell.g;
            if (value < -32768 || value > 32767) {
                throw new Error("exportSiteGround: ground height out of range");
            }
            g[i] = value;
            // residual
            const zz = zig(value - guess);
            const k = rice.k();
            const q = zz >> k;
            if (q >= ESCAPE_Q) {
                for (let n = 0; n < ESCAPE_Q; n += 1) {
                    writer.bit(1);
                }
                writer.bits(zz, 17);
            } else {
                for (let n = 0; n < q; n += 1) {
                    writer.bit(1);
                }
                writer.bit(0);
                writer.bits(zz & ((1 << k) - 1), k);
            }
            rice.update(zz);
            // kind runs
            if (code === runKind) {
                run += 1;
            } else {
                if (run > 0) {
                    pushVar(kinds, runKind);
                    pushVar(kinds, run - 1);
                }
                runKind = code;
                run = 1;
            }
            // trees
            if (cell.tree) {
                pushVar(trees, i - lastTree - 1);
                lastTree = i;
            }
            // water surface: the water cell's `g` is the bed; the depth to the surface is rice-coded
            // (one short residual per WATER column, nothing for land) so a sea district's ground
            // stays compact enough for the plan budget
            if (code === /** @type {number} */ (KIND_CODE["water"])) {
                waterCols += 1;
                const depth = Number.isFinite(cell.surface) ? Math.max(0, Math.floor(/** @type {number} */ (cell.surface)) - value - 1) : 0;
                const szz = zig(depth - lastDepth);
                const sk = srice.k();
                const sq = szz >> sk;
                if (sq >= ESCAPE_Q) {
                    for (let n = 0; n < ESCAPE_Q; n += 1) swriter.bit(1);
                    swriter.bits(szz, 17);
                } else {
                    for (let n = 0; n < sq; n += 1) swriter.bit(1);
                    swriter.bit(0);
                    swriter.bits(szz & ((1 << sk) - 1), sk);
                }
                srice.update(szz);
                lastDepth = depth;
            }
        }
    }
    if (run > 0) {
        pushVar(kinds, runKind);
        pushVar(kinds, run - 1);
    }
    const gText = writer.finish();
    const kText = kinds.join("");
    const tText = trees.join("");
    const sText = waterCols > 0 ? swriter.finish() : "";
    const hash = yield* fnvPartsSteps([`${String(region.x0)},${String(region.z0)},${String(w)},${String(h)}|`, gText, "|", kText, "|", tText, ...(sText === "" ? [] : ["|", sText])], ops);
    return { v: SITE_GROUND_VERSION, x0: region.x0, z0: region.z0, w, h, g: gText, k: kText, t: tText, ...(sText === "" ? {} : { s: sText }), hash };
}

/**
 * Rebuild a field from `exportSiteGround` output (also accepts the JSON string). Throws on any
 * corruption: bad version, hash mismatch, truncated or inconsistent streams.
 *
 * @param {SiteGroundJSON | string} json
 * @returns {ClippedField & { region: SiteRegion, sameAs: (other: { at: (x: number, z: number) => any }) => boolean }}
 */
export function importSiteGround(json) {
    return runSync(importSiteGroundSteps(json, newOps()));
}

/**
 * Cooperative form of importSiteGround (one implementation): yields at least every ~20,000 operations.
 *
 * @param {SiteGroundJSON | string} json
 * @param {Ops} ops
 * @returns {Generator<void, ClippedField & { region: SiteRegion, sameAs: (other: { at: (x: number, z: number) => any }) => boolean }, void>}
 */
export function* importSiteGroundSteps(json, ops) {
    const data = /** @type {SiteGroundJSON} */ (typeof json === "string" ? JSON.parse(json) : json);
    if (data === null || typeof data !== "object" || data.v !== SITE_GROUND_VERSION) {
        throw new Error("unsupported site ground version");
    }
    const { x0, z0, w, h } = data;
    if (![x0, z0, w, h].every(Number.isInteger) || w < 1 || h < 1 || w * h > 4_000_000) {
        throw new Error("corrupt site ground: bad dimensions");
    }
    if (typeof data.g !== "string" || typeof data.k !== "string" || typeof data.t !== "string") {
        throw new Error("corrupt site ground: missing streams");
    }
    const sText = typeof data.s === "string" ? data.s : "";
    const expect = yield* fnvPartsSteps([`${String(x0)},${String(z0)},${String(w)},${String(h)}|`, data.g, "|", data.k, "|", data.t, ...(sText === "" ? [] : ["|", sText])], ops);
    if (expect !== data.hash) {
        throw new Error(`corrupt site ground: hash ${expect} does not match ${String(data.hash)}`);
    }
    const count = w * h;
    const g = new Int32Array(count);
    const reader = new BitReader(data.g);
    const rice = new RiceState();
    for (let z = 0; z < h; z += 1) {
        yield* pace(ops, w * 14);
        for (let x = 0; x < w; x += 1) {
            const k = rice.k();
            let q = 0;
            while (q < ESCAPE_Q && reader.bit() === 1) {
                q += 1;
            }
            let zz;
            if (q >= ESCAPE_Q) {
                zz = reader.bits(17);
            } else {
                zz = (q << k) | reader.bits(k);
            }
            rice.update(zz);
            g[z * w + x] = predict(g, w, x, z) + unzig(zz);
        }
    }
    const kinds = new Uint8Array(count);
    yield* pace(ops, Math.min(23000, (data.k.length + data.t.length) * 4 + (count >> 4)));
    const kv = readVars(data.k);
    let pos = 0;
    for (let i = 0; i < kv.length; i += 2) {
        const code = /** @type {number} */ (kv[i]);
        const run = /** @type {number} */ (kv[i + 1]) + 1;
        if (code > 4 || pos + run > count) {
            throw new Error("corrupt site ground: kind runs out of range");
        }
        kinds.fill(code, pos, pos + run);
        pos += run;
    }
    if (pos !== count) {
        throw new Error("corrupt site ground: kind runs do not cover the region");
    }
    const treeBits = new Uint8Array(count);
    let at = -1;
    for (const gap of readVars(data.t)) {
        at += gap + 1;
        if (at >= count) {
            throw new Error("corrupt site ground: tree position out of range");
        }
        treeBits[at] = 1;
    }
    /** Surface y per water column; 0 when the export had no surface stream. */
    const surfaces = new Uint16Array(count);
    if (sText !== "") {
        const sreader = new BitReader(sText);
        const srice = new RiceState();
        let prevDepth = 0;
        for (let i = 0; i < count; i += 1) {
            if (kinds[i] !== /** @type {number} */ (KIND_CODE["water"])) continue;
            const sk = srice.k();
            let sq = 0;
            while (sq < ESCAPE_Q && sreader.bit() === 1) sq += 1;
            const szz = sq >= ESCAPE_Q ? sreader.bits(17) : (sq << sk) | sreader.bits(sk);
            srice.update(szz);
            const depth = prevDepth + unzig(szz);
            if (depth < 0 || depth > 4096) {
                throw new Error("corrupt site ground: water depth out of range");
            }
            prevDepth = depth;
            surfaces[i] = /** @type {number} */ (g[i]) + 1 + depth;
        }
    }
    const region = { x0, z0, x1: x0 + w - 1, z1: z0 + h - 1 };
    const unloaded = Object.freeze({ g: 0, k: "unloaded", tree: false });
    let outside = 0;
    let reads = 0;
    /** @type {{ x: number, z: number } | null} */
    let first = null;
    /** @param {number} x @param {number} z */
    const raw = (x, z) => {
        const bx = Math.floor(x);
        const bz = Math.floor(z);
        if (bx < region.x0 || bx > region.x1 || bz < region.z0 || bz > region.z1) {
            return null;
        }
        const i = (bz - z0) * w + (bx - x0);
        const code = /** @type {number} */ (kinds[i]);
        if (code === 0) {
            return unloaded;
        }
        /** @type {{ g: number, k: string, tree: boolean, surface?: number }} */
        const cell = { g: /** @type {number} */ (g[i]), k: /** @type {string} */ (KIND_NAMES[code]), tree: treeBits[i] === 1 };
        if (code === /** @type {number} */ (KIND_CODE["water"]) && surfaces[i] > 0) cell.surface = surfaces[i];
        return cell;
    };
    return {
        region,
        bounds: { ...region },
        at(x, z) {
            reads += 1;
            const cell = raw(x, z);
            if (cell === null) {
                outside += 1;
                first ??= { x: Math.floor(x), z: Math.floor(z) };
                return unloaded;
            }
            return cell;
        },
        outsideReads: () => outside,
        firstOutside: () => first,
        readCount: () => reads,
        sameAs(other) {
            for (let bz = region.z0; bz <= region.z1; bz += 1) {
                for (let bx = region.x0; bx <= region.x1; bx += 1) {
                    const a = raw(bx, bz);
                    const b = clipField(other, region).at(bx, bz);
                    if (a === null || a.k !== b.k || (a.k !== "unloaded" && (a.g !== b.g || a.tree !== b.tree))) {
                        return false;
                    }
                }
            }
            return true;
        },
    };
}

/**
 * Serialised size report for a ground export.
 * @param {SiteGroundJSON} json
 */
export function siteGroundBytes(json) {
    const text = JSON.stringify(json);
    return { bytes: utf8Length(text), columns: json.w * json.h, bytesPerColumn: utf8Length(text) / (json.w * json.h), streams: { g: json.g.length, k: json.k.length, t: json.t.length, ...(json.s === undefined ? {} : { s: json.s.length }) } };
}
