import { encodeFacing } from "../structures/facing.js";

/**
 * Canonical block-op form for the civilization builder. Pure.
 *
 * The planners that feed `civ/districtplan.js` speak three dialects: `minecraft:`-prefixed ids with a
 * `kind` (foundations.js), bare ids with a `layer` (walls.js) and palette ids plus a `name` token
 * (blueprints). Every op that leaves districtplan.js goes through `normalizeOp`, so the runtime
 * builder never re-normalises:
 *
 *     { x, y, z, id: "minecraft:<name>", states?: {...}, kind: <one of OP_KINDS>, name?: string }
 *
 * Stairs carry real block states (`weirdo_direction`, `upside_down_bit`) instead of a `dir`.
 *
 * Runtime safety classes (what the per-cell classifier must see at the target before it may write):
 *   - "vegetation-clear": the target must be air or a natural plant / tree / leaf (it is removed).
 *   - "natural-ground":   the target may be air, plants, or natural terrain (dirt, grass, stone, sand,
 *                         gravel ...) or a block this plan placed earlier. Never a foreign build.
 *   - "build":            the target must be air (or still water for bridge supports) or a block this
 *                         plan placed earlier. Never natural ground, never a foreign build.
 */

/**
 * @typedef {"vegetation-clear" | "natural-ground" | "build"} SafetyClass
 * @typedef {{ x: number, y: number, z: number, id: string, kind: string, states?: Record<string, string | number | boolean>, name?: string }} CanonicalOp
 */

/** @type {Readonly<Record<string, { safety: SafetyClass, doc: string }>>} */
export const OP_KINDS = Object.freeze({
    clear: { safety: "vegetation-clear", doc: "air written over a tree / plant standing on a claimed column" },
    cut: { safety: "natural-ground", doc: "air written over natural ground that a pad, road or stair removes" },
    fill: { safety: "natural-ground", doc: "terrain raised to a surface (dirt / grass / stone) over air or plants" },
    top: { safety: "natural-ground", doc: "flat surface block of a stair run or ramp" },
    pad: { safety: "natural-ground", doc: "levelled surface block of a lot pad or plaza" },
    wall: { safety: "build", doc: "wall body, walkway, parapet, buttress and tower blocks above ground" },
    gate: { safety: "build", doc: "gatehouse blocks above ground, portcullis slot, levers" },
    road: { safety: "natural-ground", doc: "road surface block (replaces the ground top or sits on a fill)" },
    structure: { safety: "build", doc: "blueprint building blocks" },
    support: { safety: "build", doc: "bridge pillars and other posts under a structure (may stand in still water)" },
    dress: { safety: "build", doc: "decoration (lamps, fences); reserved, currently not emitted" },
    bridge: { safety: "build", doc: "bridge deck and railing over a gap" },
    stair: { safety: "natural-ground", doc: "stair block with facing states (road slope, wall access, pad edge)" },
    footing: { safety: "natural-ground", doc: "wall / gate / building footing replacing ground below the surface" },
    retaining: { safety: "natural-ground", doc: "retaining wall block on a pad apron" },
});

export const OP_KIND_NAMES = Object.freeze(Object.keys(OP_KINDS));

/** Ids that do not exist (or were renamed) in the supported game version. */
const ID_ALIASES = Object.freeze({
    "minecraft:dirt_path": "minecraft:grass_path",
});

/** Source kinds / layers from the sub-planners -> canonical kind. */
const KIND_ALIASES = Object.freeze({
    retain: "retaining",
    deck: "bridge",
    rail: "bridge",
    pillar: "support",
    building: "structure",
    ours: "gate",
    air: "gate",
    body: "wall",
    tower: "wall",
    parapet: "wall",
    walkway: "wall",
    buttress: "wall",
    foundation: "footing",
});

/** @param {string} kind */
export function safetyClassOf(kind) {
    const info = /** @type {Record<string, { safety: SafetyClass }>} */ (OP_KINDS)[kind];
    if (info === undefined) {
        throw new Error(`unknown op kind '${kind}'`);
    }
    return info.safety;
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function canonicalId(raw) {
    if (typeof raw !== "string" || raw.length === 0) {
        throw new Error(`block id must be a non-empty string, got ${String(raw)}`);
    }
    const lower = raw.toLowerCase();
    const full = lower.includes(":") ? lower : `minecraft:${lower}`;
    if (!/^minecraft:[a-z0-9_]+$/.test(full)) {
        throw new Error(`block id '${raw}' is not a minecraft: block id`);
    }
    return /** @type {Record<string, string>} */ (ID_ALIASES)[full] ?? full;
}

/**
 * @param {any} op
 * @param {string | undefined} [defaultKind]
 * @returns {CanonicalOp}
 */
export function normalizeOp(op, defaultKind = undefined) {
    if (op === null || typeof op !== "object") {
        throw new Error("op must be an object");
    }
    if (![op.x, op.y, op.z].every(Number.isInteger)) {
        throw new Error(`op needs integer x/y/z, got ${JSON.stringify([op.x, op.y, op.z])}`);
    }
    const id = canonicalId(op.id);
    let source = op.kind ?? op.layer ?? defaultKind;
    if (typeof source !== "string") {
        throw new Error(`op at ${String(op.x)},${String(op.y)},${String(op.z)} has no kind`);
    }
    if (op.ground === true && (source === "ours" || source === "gate")) {
        source = "footing";
    }
    const kind = /** @type {Record<string, string>} */ (KIND_ALIASES)[source] ?? source;
    if (!Object.hasOwn(OP_KINDS, kind)) {
        throw new Error(`op kind '${String(source)}' is not in the closed list (${OP_KIND_NAMES.join("|")})`);
    }
    /** @type {Record<string, string | number | boolean> | undefined} */
    let states;
    if (op.states !== undefined && op.states !== null) {
        states = {};
        for (const key of Object.keys(op.states).sort()) {
            states[key] = op.states[key];
        }
    }
    if (op.dir !== undefined) {
        const facing = encodeFacing({ kind: "stairs", dir: String(op.dir) });
        if (facing["weirdo_direction"] === undefined) {
            throw new Error(`stair facing '${String(op.dir)}' is not a compass direction`);
        }
        states = { ...(states ?? {}), ...facing };
        states = Object.fromEntries(Object.entries(states).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    /** @type {CanonicalOp} */
    const out = { x: op.x, y: op.y, z: op.z, id, kind };
    if (states !== undefined && Object.keys(states).length > 0) {
        out.states = states;
    }
    if (typeof op.name === "string" && op.name.length > 0) {
        out.name = op.name;
    }
    return out;
}

/**
 * @param {any[]} ops
 * @param {string | undefined} [defaultKind]
 * @returns {CanonicalOp[]}
 */
export function normalizeOps(ops, defaultKind = undefined) {
    const out = new Array(ops.length);
    for (let i = 0; i < ops.length; i += 1) {
        out[i] = normalizeOp(ops[i], defaultKind);
    }
    return out;
}

/**
 * Block identity of an op (id + states), used to tell "same block" from "conflicting block".
 * @param {CanonicalOp} op
 */
export function opSignature(op) {
    return op.states === undefined ? op.id : `${op.id}${JSON.stringify(op.states)}`;
}

/**
 * Problems with an op that is supposed to be canonical already (empty = canonical).
 * @param {any} op
 * @returns {string[]}
 */
export function canonicalProblems(op) {
    /** @type {string[]} */
    const problems = [];
    if (op === null || typeof op !== "object") {
        return ["not an object"];
    }
    if (![op.x, op.y, op.z].every(Number.isInteger)) problems.push("x/y/z must be integers");
    if (typeof op.id !== "string" || !/^minecraft:[a-z0-9_]+$/.test(op.id)) problems.push(`id '${String(op.id)}' is not a minecraft: id`);
    else if (Object.hasOwn(ID_ALIASES, op.id)) problems.push(`id '${op.id}' is a retired alias`);
    if (typeof op.kind !== "string" || !Object.hasOwn(OP_KINDS, op.kind)) problems.push(`kind '${String(op.kind)}' is not in the closed list`);
    if (op.dir !== undefined) problems.push("dir must be folded into states");
    if (op.layer !== undefined || op.role !== undefined || op.ownIds !== undefined) problems.push("source-dialect fields left on the op");
    if (op.states !== undefined && (op.states === null || typeof op.states !== "object")) problems.push("states must be an object");
    return problems;
}
