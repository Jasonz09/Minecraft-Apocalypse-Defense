/**
 * Versioned (v2) blueprints for the civilization-scale layout. Pure data plus op builders.
 *
 * Same op vocabulary and frame as blueprints.js: set | fill | hollow | ring, blueprint-local
 * coordinates (x east, z south, y up, y = 0 is the FLOOR layer that replaces the ground surface),
 * authored facing SOUTH (entrance on the +z side), rotated clockwise in quarter turns when placed.
 * Tokens resolve against PALETTE_V2 = { ...PALETTE, ...PALETTE2 } (palette.js is not edited).
 *
 * Every blueprint: { id, version, category, size:[w,h,d], ops, entrances:[{at,dir,kind}],
 *                    foundation:{ depth, rect:[x0,z0,x1,z1] (inclusive, local), block } }.
 * `foundation.rect` always covers the footprint [0,0,w-1,d-1] plus a 1-block margin; `depth` is how many
 * blocks below y = 0 a foundation pad may fill on sloped ground (cut/fill handled by the terrain agent).
 *
 * `expandBlueprint` is a small self-contained expander (mirrors planner.js semantics) so these
 * blueprints can be previewed/tested without touching the 49x49 planner, whose palette is fixed.
 */

import { encodeFacing, rotateDir } from "./facing.js";
import { PALETTE } from "./palette.js";
import { PALETTE2 } from "./palette2.js";

export const BLUEPRINT_VERSION = 2;

/** Union palette a v2 expander must resolve tokens against. */
export const PALETTE_V2 = /** @type {Record<string, any>} */ ({ ...PALETTE, ...PALETTE2 });

/**
 * @typedef {{ op: string, [key: string]: any }} Op
 * @typedef {{ id: string, version: number, category: string, size: [number, number, number], ops: Op[],
 *   entrances: { at: [number, number, number], dir: string, kind: string }[],
 *   foundation: { depth: number, rect: [number, number, number, number], block: string } }} Blueprint2
 */

// ---------------------------------------------------------------- op helpers

/**
 * @param {number[]} box
 * @param {string | null} block
 * @returns {Op}
 */
const F = (box, block) => ({ op: "fill", box, block });
/**
 * @param {number[]} at
 * @param {string | null} block
 * @returns {Op}
 */
const S = (at, block) => ({ op: "set", at, block });
/**
 * @param {number[]} box [x1,z1,x2,z2]
 * @param {number[]} y [y1,y2]
 * @param {string | null} block
 * @param {number} [t]
 * @param {number} [parity]
 * @returns {Op}
 */
const RING = (box, y, block, t = 1, parity = undefined) => (parity === undefined ? { op: "ring", box, t, y, block } : { op: "ring", box, t, y, block, parity });

/**
 * Translate ops by (dx, dy, dz).
 * @param {Op[]} ops
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @returns {Op[]}
 */
function shift(ops, dx, dy, dz) {
    return ops.map((op) => {
        if (op.op === "set") {
            return { ...op, at: [op.at[0] + dx, op.at[1] + dy, op.at[2] + dz] };
        }
        if (op.op === "ring") {
            return { ...op, box: [op.box[0] + dx, op.box[1] + dz, op.box[2] + dx, op.box[3] + dz], y: [op.y[0] + dy, op.y[1] + dy] };
        }
        return { ...op, box: [op.box[0] + dx, op.box[1] + dy, op.box[2] + dz, op.box[3] + dx, op.box[4] + dy, op.box[5] + dz] };
    });
}

/**
 * Door (lower + upper) on the south wall.
 * @param {number} x
 * @param {number} z
 * @param {string} fam door family: oak | spruce | dkoak | birch
 * @returns {Op[]}
 */
function door(x, z, fam) {
    return [S([x, 1, z], `dr_${fam}_lo`), S([x, 2, z], `dr_${fam}_hi`)];
}

/**
 * Hip roof with origin offset: stairs ring per layer, solid ridge when a dimension collapses.
 * @param {number} x0
 * @param {number} z0
 * @param {number} w
 * @param {number} d
 * @param {number} y0 first roof layer
 * @param {string} fam stair family key
 * @param {string} ridge solid token for the ridge
 * @returns {{ ops: Op[], top: number }}
 */
function hipRoof(x0, z0, w, d, y0, fam, ridge) {
    /** @type {Op[]} */
    const ops = [];
    let top = y0;
    for (let k = 0; ; k += 1) {
        const rw = w - 2 * k;
        const rd = d - 2 * k;
        const y = y0 + k;
        const ax = x0 + k;
        const az = z0 + k;
        const bx = x0 + w - 1 - k;
        const bz = z0 + d - 1 - k;
        if (rw <= 0 || rd <= 0) {
            break;
        }
        top = y;
        if (rw <= 2 || rd <= 2) {
            ops.push(F([ax, y, az, bx, y, bz], ridge));
            break;
        }
        ops.push(F([ax, y, az, ax, y, bz], `rf_${fam}_e`));
        ops.push(F([bx, y, az, bx, y, bz], `rf_${fam}_w`));
        ops.push(F([ax, y, az, bx, y, az], `rf_${fam}_s`));
        ops.push(F([ax, y, bz, bx, y, bz], `rf_${fam}_n`));
    }
    return { ops, top };
}

/**
 * Gable roof, ridge along x, with closed gable ends. Needs odd depth.
 * @param {number} w
 * @param {number} d
 * @param {number} wh wall height (top wall layer)
 * @param {string} fam
 * @param {string} ridge
 * @param {string} gable token that closes the gable ends
 * @returns {{ ops: Op[], top: number }}
 */
function gableRoof(w, d, wh, fam, ridge, gable) {
    /** @type {Op[]} */
    const ops = [];
    const h = (d - 1) / 2;
    for (let k = 0; k < h; k += 1) {
        const y = wh + 1 + k;
        ops.push(F([0, y, k, w - 1, y, k], `rf_${fam}_s`));
        ops.push(F([0, y, d - 1 - k, w - 1, y, d - 1 - k], `rf_${fam}_n`));
        for (const x of [0, w - 1]) {
            if (k + 1 <= d - 2 - k) {
                ops.push(F([x, y, k + 1, x, y, d - 2 - k], gable));
            }
        }
    }
    ops.push(F([0, wh + 1 + h, h, w - 1, wh + 1 + h, h], ridge));
    return { ops, top: wh + 1 + h };
}

/**
 * Window panes along the walls (y), skipping posts and door columns.
 * @param {number} w
 * @param {number} d
 * @param {number} y
 * @param {number[]} skipX
 * @param {number} [pane]
 * @returns {Op[]}
 */
function windows(w, d, y, skipX, pane = 2) {
    /** @type {Op[]} */
    const ops = [];
    for (let x = pane; x <= w - 1 - pane; x += 2) {
        if (skipX.includes(x)) {
            continue;
        }
        ops.push(S([x, y, 0], "glass"));
        ops.push(S([x, y, d - 1], "glass"));
    }
    for (let z = 2; z <= d - 3; z += 2) {
        ops.push(S([0, y, z], "glass"));
        ops.push(S([w - 1, y, z], "glass"));
    }
    return ops;
}

/**
 * @typedef {{
 *   id: string, category: string, kind: string, w: number, d: number, wh?: number,
 *   wall: string, base: string, frame: string, floor: string, roofFam: string, roof?: "gable" | "hip" | "flat",
 *   ridge?: string, gable?: string, doorFam?: string, doorXs?: number[], posts?: number[], porch?: number,
 *   chimney?: number | null, upperWall?: string, upper?: boolean, winY?: number[], pane?: number,
 *   interior?: Op[], carve?: Op[], fd?: number, noDoor?: boolean
 * }} BuildingOptions
 */

/**
 * Standard walled building with a roof, a south door, windows, optional porch/chimney/upper floor.
 * @param {BuildingOptions} o
 * @returns {Blueprint2}
 */
function building(o) {
    const { w, d } = o;
    if (w % 2 === 0 || d % 2 === 0) {
        throw new Error(`${o.id}: shell dimensions must be odd (${String(w)}x${String(d)})`);
    }
    const wh = o.wh ?? 3;
    const porch = o.porch ?? 0;
    const doorXs = o.doorXs ?? [(w - 1) / 2];
    const roofKind = o.roof ?? "gable";
    const ridge = o.ridge ?? o.floor;
    const box = [0, 0, w - 1, d - 1];
    /** @type {Op[]} */
    const ops = [F([0, 0, 0, w - 1, 0, d - 1], o.floor), RING(box, [1, 1], o.base), RING(box, [2, wh], o.wall)];
    if (o.upperWall !== undefined) {
        ops.push(RING(box, [4, 4], o.frame), RING(box, [5, wh], o.upperWall));
    }
    for (const x of [0, ...(o.posts ?? []), w - 1]) {
        for (const z of [0, d - 1]) {
            ops.push(F([x, 1, z, x, wh, z], o.frame));
        }
    }
    if (o.upper === true) {
        ops.push(F([1, 4, 1, w - 2, 4, d - 2], o.floor));
        ops.push(F([w - 2, 1, 1, w - 2, 5, 1], "ladder_s"));
        ops.push(S([2, 6, 1], "lantern"));
    }
    for (const y of o.winY ?? [2]) {
        ops.push(...windows(w, d, y, [...doorXs, ...(o.posts ?? [])], o.pane ?? 2));
    }
    /** @type {{ ops: Op[], top: number }} */
    let roof;
    if (roofKind === "gable") {
        roof = gableRoof(w, d, wh, o.roofFam, ridge, o.gable ?? o.wall);
    } else if (roofKind === "hip") {
        roof = hipRoof(0, 0, w, d, wh + 1, o.roofFam, ridge);
    } else {
        roof = { ops: [F([0, wh + 1, 0, w - 1, wh + 1, d - 1], `sl_${o.roofFam}`)], top: wh + 1 };
    }
    ops.push(...roof.ops);
    for (const x of doorXs) {
        ops.push(...(o.noDoor === true ? [] : door(x, d - 1, o.doorFam ?? "oak")));
    }
    if (porch > 0) {
        const pz = d + porch - 1;
        ops.push(F([0, 0, d, w - 1, 0, pz], "cobble"));
        const px1 = Math.min(...doorXs) - 1;
        const px2 = Math.max(...doorXs) + 1;
        for (const x of [Math.max(1, px1), Math.min(w - 2, px2)]) {
            ops.push(F([x, 1, pz, x, wh - 1, pz], "fence"));
        }
        ops.push(F([Math.max(1, px1), wh, d, Math.min(w - 2, px2), wh, pz], `sl_${o.roofFam}`));
    }
    let top = roof.top;
    if (o.chimney !== undefined && o.chimney !== null) {
        const cz = (d - 1) / 2;
        ops.push(S([o.chimney, 1, cz], "furnace_block"));
        ops.push(F([o.chimney, 2, cz, o.chimney, roof.top + 1, cz], "wall_rubble"));
        top = roof.top + 1;
    }
    if (o.interior !== undefined) {
        ops.push(...o.interior);
    }
    if (o.carve !== undefined) {
        ops.push(...o.carve);
    }
    return finish(o.id, o.category, [w, top + 1, d + porch], ops, [{ at: [doorXs[0] ?? 0, 1, d - 1], dir: "south", kind: o.kind }], o.fd ?? 3);
}

/**
 * @param {string} id
 * @param {string} category
 * @param {[number, number, number]} size
 * @param {Op[]} ops
 * @param {{ at: number[], dir: string, kind: string }[]} entrances
 * @param {number} depth
 * @returns {Blueprint2}
 */
function finish(id, category, size, ops, entrances, depth) {
    return {
        id,
        version: BLUEPRINT_VERSION,
        category,
        size,
        ops,
        entrances: /** @type {any} */ (entrances),
        foundation: { depth, rect: [-1, -1, size[0], size[2]], block: "cobble" },
    };
}

// ---------------------------------------------------------------- interiors

/** @param {number} x @param {number} z @returns {Op[]} */
const bunk = (x, z) => [S([x, 1, z], "hay"), S([x, 1, z + 1], "wool_red")];

/**
 * @param {number} w
 * @param {number} d
 * @returns {Op[]}
 */
function barracksInterior(w, d) {
    /** @type {Op[]} */
    const ops = [];
    for (let x = 2; x <= w - 3; x += 2) {
        ops.push(S([x, 1, 1], "hay"), S([x, 1, d - 3], "hay"));
        if (x % 4 === 2) {
            ops.push(S([x, 1, 2], "wool_red"), S([x, 1, d - 2], "wool_red"));
        }
    }
    for (let x = 3; x <= w - 4; x += 4) {
        ops.push(S([x, 2, 1], "lantern"));
    }
    ops.push(S([(w - 1) / 2 - 2, 1, 3], "chest_s"), S([(w - 1) / 2 + 2, 1, 3], "chest_s"), S([(w - 1) / 2, 1, 3], "table"));
    return ops;
}

// ---------------------------------------------------------------- field-style builders

/**
 * Crop plot: fenced border, irrigation rows (water within 4 blocks of every farmland cell), crops by row.
 * @param {{ id: string, w: number, d: number, crops: string[], canal?: boolean, fence?: string, border?: string }} o
 * @returns {Blueprint2}
 */
function cropField(o) {
    const { w, d } = o;
    const fence = o.fence ?? "fence";
    /** @type {number[]} */
    const waterRows = [];
    for (let z = 5; z <= d - 2; z += 9) {
        waterRows.push(z);
    }
    const canalX = o.canal === true ? Math.floor(w / 2) : -1;
    /** @type {Op[]} */
    const ops = [F([0, 0, 0, w - 1, 0, d - 1], o.border ?? "dirt")];
    for (let z = 1; z <= d - 2; z += 1) {
        const near = Math.min(...waterRows.map((r) => Math.abs(r - z)));
        if (near > 4) {
            ops.push(F([1, 0, z, w - 2, 0, z], "path_dirt"));
            continue;
        }
        const water = near === 0;
        const crop = /** @type {string} */ (o.crops[Math.floor((z - 1) / 4) % o.crops.length]);
        ops.push(F([1, 0, z, w - 2, 0, z], water ? "water" : "farmland"));
        if (!water) {
            ops.push(F([1, 1, z, w - 2, 1, z], crop));
        }
    }
    if (canalX > 0) {
        ops.push(F([canalX, 0, 1, canalX, 0, d - 2], "water"));
        ops.push(F([canalX, 1, 1, canalX, 1, d - 2], null));
    }
    ops.push(RING([0, 0, w - 1, d - 1], [1, 1], fence));
    ops.push(S([Math.floor(w / 2), 1, d - 1], "gate_s"));
    for (const [x, z] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]]) {
        ops.push(S([x, 2, z], "lantern"));
    }
    return finish(o.id, "farm", [w, 3, d], ops, [{ at: [Math.floor(w / 2), 1, d - 1], dir: "south", kind: "farm" }], 2);
}

/**
 * @param {{ id: string, w: number, d: number }} o
 * @returns {Blueprint2}
 */
function orchard(o) {
    const { w, d } = o;
    /** @type {Op[]} */
    const ops = [F([0, 0, 0, w - 1, 0, d - 1], "grass_blk"), F([1, 0, d - 2, w - 2, 0, d - 2], "path_dirt")];
    for (let x = 3; x <= w - 4; x += 5) {
        for (let z = 3; z <= d - 6; z += 5) {
            ops.push(F([x, 0, z, x, 0, z], "podzol"));
            ops.push(F([x, 1, z, x, 4, z], "lg_oak"));
            ops.push(F([x - 2, 3, z - 2, x + 2, 4, z + 2], "leaves_oak"));
            for (const [cx, cz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
                ops.push(S([x + (cx ?? 0), 3, z + (cz ?? 0)], null));
                ops.push(S([x + (cx ?? 0), 4, z + (cz ?? 0)], null));
            }
            ops.push(F([x - 1, 5, z - 1, x + 1, 5, z + 1], "leaves_oak"));
            ops.push(S([x, 6, z], "leaves_oak"));
            ops.push(S([x, 3, z], "lg_oak"));
            ops.push(S([x, 4, z], "lg_oak"));
        }
    }
    ops.push(RING([0, 0, w - 1, d - 1], [1, 1], "fence"));
    ops.push(S([Math.floor(w / 2), 1, d - 1], "gate_s"));
    return finish(o.id, "farm", [w, 7, d], ops, [{ at: [Math.floor(w / 2), 1, d - 1], dir: "south", kind: "orchard" }], 2);
}

/** @returns {Blueprint2} */
function pen() {
    const w = 15;
    const d = 11;
    /** @type {Op[]} */
    const ops = [F([0, 0, 0, w - 1, 0, d - 1], "grass_blk"), RING([0, 0, w - 1, d - 1], [1, 1], "fence_spruce")];
    ops.push(S([7, 1, d - 1], "gate_s"));
    ops.push(F([2, 1, 1, 4, 1, 1], "hay"), F([10, 1, 1, 11, 1, 1], "hay"));
    ops.push(RING([6, 3, 8, 5], [0, 0], "cobble"), F([7, 0, 4, 7, 0, 4], "water"));
    // shelter lean-to against the north fence
    ops.push(F([1, 1, 2, 1, 3, 2], "fence_spruce"), F([5, 1, 2, 5, 3, 2], "fence_spruce"), F([1, 4, 1, 5, 4, 2], "sl_spruce"));
    ops.push(F([12, 1, 2, 12, 3, 2], "fence_spruce"), F([13, 1, 2, 13, 3, 2], "fence_spruce"), F([12, 4, 1, 13, 4, 2], "sl_spruce"));
    return finish("pen_v2", "farm", [w, 5, d], ops, [{ at: [7, 1, d - 1], dir: "south", kind: "pen" }], 2);
}

/** @returns {Blueprint2} */
function garden() {
    const w = 9;
    const d = 9;
    /** @type {Op[]} */
    const ops = [F([0, 0, 0, w - 1, 0, d - 1], "grass_blk"), F([4, 0, 0, 4, 0, d - 1], "path_dirt"), F([0, 0, 4, w - 1, 0, 4], "path_dirt")];
    ops.push(RING([0, 0, w - 1, d - 1], [1, 1], "leaves_oak"));
    ops.push(F([4, 1, d - 1, 4, 1, d - 1], null), F([4, 1, 0, 4, 1, 0], null));
    for (const [x, z] of [[1, 1], [2, 2], [6, 1], [7, 2], [1, 6], [2, 7], [6, 6], [7, 7]]) {
        ops.push(S([x, 1, z], (x + z) % 3 === 0 ? "poppy" : (x + z) % 3 === 1 ? "dandelion" : "cornflower"));
    }
    ops.push(S([6, 1, 6], "berry_bush"), S([2, 1, 6], "berry_bush"), S([1, 1, 2], "composter_b"), S([4, 1, 4], "flower_pot_b"));
    return finish("garden_v2", "public", [w, 3, d], ops, [{ at: [4, 1, d - 1], dir: "south", kind: "garden" }], 2);
}

// ---------------------------------------------------------------- the blueprints

/** @type {Blueprint2[]} */
const LIST = [];

// -- houses (small / medium / large, gable + hip, different materials)
LIST.push(
    building({
        id: "house_s_v2", category: "residential", kind: "homes", w: 7, d: 5, wall: "pl_oak", base: "cobble", frame: "lg_oak", floor: "pl_spruce",
        roofFam: "spruce", ridge: "pl_spruce", chimney: 1,
        interior: [S([5, 1, 1], "table"), S([5, 2, 1], "lantern"), S([5, 1, 3], "chest_w"), S([3, 1, 1], "bookshelf")],
    }),
    building({
        id: "house_s_alt_v2", category: "residential", kind: "homes", w: 7, d: 5, wall: "mudbrick", base: "cobble", frame: "lg_dkoak", floor: "pl_dkoak",
        roofFam: "mud", roof: "hip", ridge: "mudbrick", doorFam: "dkoak", chimney: 5,
        interior: [S([1, 1, 1], "table"), S([1, 2, 1], "lantern"), S([1, 1, 3], "chest_e")],
    }),
    building({
        id: "house_m_v2", category: "residential", kind: "homes", w: 9, d: 7, wall: "clay_white", base: "cobble", frame: "lg_dkoak", floor: "pl_spruce",
        posts: [4], roofFam: "dkoak", ridge: "pl_dkoak", gable: "clay_white", doorFam: "spruce", porch: 2, chimney: 1,
        interior: [S([7, 1, 1], "table"), S([7, 2, 1], "lantern"), S([7, 1, 5], "chest_w"), S([2, 1, 5], "bookshelf"), S([2, 2, 5], "bookshelf"), S([5, 1, 1], "loom_b")],
    }),
    building({
        id: "house_m_alt_v2", category: "residential", kind: "homes", w: 9, d: 7, wall: "pl_birch", base: "cobble", frame: "lg_birch", floor: "pl_birch",
        roofFam: "brick", roof: "hip", ridge: "brick", doorFam: "birch", chimney: 7, pane: 2,
        interior: [S([1, 1, 1], "table"), S([1, 2, 1], "lantern"), S([1, 1, 5], "chest_e"), S([4, 1, 5], "smoker_b")],
    }),
    building({
        id: "house_l_v2", category: "residential", kind: "homes", w: 11, d: 9, wh: 7, upper: true, wall: "wall_plain", upperWall: "pl_oak", base: "wall_base",
        frame: "lg_oak", floor: "pl_spruce", posts: [5], roofFam: "spruce", ridge: "pl_spruce", gable: "pl_oak", doorFam: "spruce", winY: [2, 6], chimney: 1, porch: 2,
        interior: [S([8, 1, 1], "table"), S([8, 2, 1], "lantern"), S([9, 1, 7], "chest_w"), S([2, 1, 7], "bookshelf"), S([2, 2, 7], "bookshelf"), S([5, 5, 7], "chest_n")],
    }),
    building({
        id: "house_l_alt_v2", category: "residential", kind: "homes", w: 11, d: 7, wh: 3, wall: "sandstone", base: "cobble", frame: "lg_spruce", floor: "pl_spruce",
        posts: [5], roofFam: "sand", roof: "hip", ridge: "sandstone", doorFam: "spruce", porch: 3, chimney: 9, winY: [2],
        interior: [S([1, 1, 1], "table"), S([1, 2, 1], "lantern"), S([1, 1, 5], "bookshelf"), S([3, 1, 5], "chest_n"), S([7, 1, 1], "cartography_b")],
    }),
    building({
        id: "longhouse_v2", category: "residential", kind: "homes", w: 17, d: 7, wall: "wall_mud", base: "cobble", frame: "lg_spruce", floor: "pl_spruce",
        posts: [4, 8, 12], roofFam: "spruce", ridge: "pl_spruce", gable: "wall_mud", doorFam: "spruce", chimney: 8, fd: 3,
        interior: [S([2, 1, 1], "hay"), S([3, 1, 1], "hay"), S([14, 1, 1], "hay"), S([15, 1, 1], "hay"), S([2, 1, 5], "chest_n"), S([14, 1, 5], "chest_n"), S([11, 1, 1], "table"), S([5, 2, 1], "lantern"), S([12, 2, 5], "lantern")],
    }),
);

// -- craft, storage and trade
LIST.push(
    building({
        id: "workshop_v2", category: "industrial", kind: "workshop", w: 11, d: 9, wall: "pl_spruce", base: "cobble", frame: "lg_dkoak", floor: "cobble",
        posts: [5], roofFam: "dkoak", ridge: "pl_dkoak", doorFam: "dkoak", chimney: 1,
        interior: [S([8, 1, 1], "table"), S([9, 1, 1], "smithing_b"), S([8, 1, 7], "grindstone_b"), S([1, 1, 7], "fletching_b"), S([9, 1, 7], "loom_b"), S([3, 1, 1], "chest_s"), S([4, 1, 1], "chest_s"), S([5, 2, 1], "lantern")],
        carve: [F([2, 1, 8, 4, 2, 8], null), F([2, 3, 8, 4, 3, 8], "pl_dkoak"), ...[2, 4].map((x) => S([x, 1, 8], "fence_spruce"))],
    }),
    building({
        id: "smithy_v2", category: "industrial", kind: "smithy", w: 9, d: 9, wall: "wall_plain", base: "wall_base", frame: "lg_dkoak", floor: "cobble",
        roofFam: "stone", ridge: "wall_plain", doorFam: "dkoak", chimney: 1, fd: 4,
        interior: [S([2, 1, 1], "anvil_b"), S([4, 1, 1], "blast_b"), S([6, 1, 1], "blast_b"), S([7, 1, 3], "cauldron_b"), S([7, 1, 5], "grindstone_b"), S([1, 1, 5], "chest_e"), S([1, 1, 7], "barrel_b"), S([3, 2, 1], "lantern"), S([3, 1, 5], "coal_blk")],
    }),
    building({
        id: "kiln_v2", category: "industrial", kind: "kiln", w: 7, d: 7, wh: 4, wall: "wall_rubble", base: "cobble", frame: "cobble", floor: "cobble",
        roofFam: "cobble", roof: "hip", ridge: "wall_rubble", doorFam: "dkoak", chimney: 3, winY: [], fd: 3,
        interior: [S([2, 1, 1], "furnace_block"), S([4, 1, 1], "furnace_block"), S([1, 1, 3], "furnace_block"), S([5, 1, 3], "furnace_block"), S([2, 1, 5], "coal_blk"), S([4, 1, 5], "chest_n"), S([2, 3, 2], "lantern")],
    }),
    building({
        id: "warehouse_v2", category: "storage", kind: "storehouses", w: 17, d: 11, wall: "pl_spruce", base: "cobble", frame: "lg_dkoak", floor: "cobble",
        wh: 4, posts: [4, 8, 12], roofFam: "dkoak", ridge: "pl_dkoak", doorFam: "dkoak", doorXs: [7, 9], winY: [3], fd: 3,
        interior: [
            ...[2, 3, 4, 5, 6, 10, 11, 12, 13, 14].flatMap((x) => [S([x, 1, 1], "barrel_b"), S([x, 2, 1], "barrel_b")]),
            ...[2, 3, 14, 15].map((x) => S([x, 1, 5], "hay")), ...[2, 3, 14, 15].map((x) => S([x, 2, 5], "hay")),
            S([2, 1, 8], "chest_n"), S([3, 1, 8], "chest_n"), S([14, 1, 8], "chest_n"), S([15, 1, 8], "chest_n"), S([8, 3, 1], "lantern"), S([8, 3, 9], "lantern"),
        ],
    }),
    building({
        id: "warehouse_open_v2", category: "storage", kind: "storehouses", w: 15, d: 9, wall: "pl_oak", base: "cobble", frame: "lg_oak", floor: "yard_gravel",
        wh: 4, posts: [4, 8, 12], roofFam: "oak", ridge: "pl_oak", doorFam: "oak", winY: [3], fd: 3,
        interior: [...[2, 3, 4, 10, 11, 12].map((x) => S([x, 1, 1], "barrel_b")), ...[2, 3, 12, 13].map((x) => S([x, 1, 4], "hay")), S([7, 1, 1], "chest_s"), S([8, 1, 1], "chest_s"), S([7, 3, 4], "lantern")],
        carve: [F([5, 1, 8, 9, 3, 8], null), F([4, 4, 8, 10, 4, 8], "lg_oak")],
    }),
    building({
        id: "granary_v2", category: "storage", kind: "storehouses", w: 9, d: 9, wall: "pl_oak", base: "lg_oak", frame: "lg_oak", floor: "pl_spruce",
        roofFam: "oak", roof: "hip", ridge: "pl_oak", doorFam: "oak", posts: [4], fd: 3, winY: [3], pane: 2,
        interior: [...[1, 2, 3, 5, 6, 7].map((x) => S([x, 1, 1], "hay")), ...[1, 2, 3, 5, 6, 7].map((x) => S([x, 2, 1], "hay")), ...[1, 7].map((x) => S([x, 1, 4], "barrel_b")), S([4, 1, 6], "composter_b"), S([4, 3, 4], "lantern")],
    }),
    building({
        id: "mill_v2", category: "agricultural", kind: "mill", w: 9, d: 9, wh: 4, wall: "wall_plain", base: "wall_base", frame: "lg_dkoak", floor: "cobble",
        roofFam: "dkoak", roof: "hip", ridge: "pl_dkoak", doorFam: "dkoak", posts: [4], winY: [3], fd: 4,
        interior: [S([2, 1, 2], "grindstone_b"), S([6, 1, 2], "grindstone_b"), S([2, 1, 6], "composter_b"), S([6, 1, 6], "composter_b"), S([4, 1, 2], "hay"), S([1, 1, 4], "barrel_b"), S([7, 1, 4], "barrel_b"), S([4, 3, 4], "lantern")],
    }),
    building({
        id: "shop_v2", category: "commercial", kind: "shop", w: 9, d: 7, wall: "pl_birch", base: "cobble", frame: "lg_dkoak", floor: "pl_spruce",
        roofFam: "dkoak", ridge: "pl_dkoak", doorFam: "spruce", porch: 2, posts: [4], chimney: 1,
        interior: [S([2, 1, 3], "table"), ...[2, 3, 4, 5, 6].map((x) => S([x, 1, 5], "barrel_b")), S([7, 1, 1], "chest_s"), S([5, 1, 1], "chest_s"), S([4, 2, 1], "lantern")],
        carve: [F([0, 3, 7, 8, 3, 8], null), ...[0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((x) => [F([x, 3, 7, x, 3, 8], x % 2 === 0 ? "wool_red" : "wool_white")])],
    }),
    building({
        id: "inn_v2", category: "commercial", kind: "inn", w: 15, d: 11, wh: 7, upper: true, wall: "wall_plain", upperWall: "pl_oak", base: "wall_base",
        frame: "lg_dkoak", floor: "pl_spruce", posts: [4, 7, 10], roofFam: "dkoak", ridge: "pl_dkoak", gable: "pl_oak", doorFam: "dkoak", doorXs: [7], porch: 3, chimney: 1, winY: [2, 6], fd: 3,
        interior: [
            ...[3, 5, 9, 11].flatMap((x) => [S([x, 1, 3], "table"), S([x, 1, 4], "fence"), S([x, 2, 3], "lantern")]),
            ...[2, 3, 4, 5, 6].map((x) => S([x, 1, 8], "barrel_b")), S([12, 1, 8], "chest_w"), S([12, 1, 1], "chest_w"),
            ...[2, 4, 8, 10, 12].map((x) => S([x, 5, 3], "hay")), ...[2, 4, 8, 10, 12].map((x) => S([x, 5, 4], "wool_red")),
        ],
    }),
    building({
        id: "stable_v2", category: "military", kind: "stable", w: 15, d: 9, wall: "pl_spruce", base: "cobble", frame: "lg_dkoak", floor: "pl_dkoak",
        roofFam: "dkoak", ridge: "pl_dkoak", doorFam: "dkoak", posts: [4, 10], winY: [2], fd: 3,
        interior: [
            ...[2, 6, 8, 12].flatMap((x) => [S([x, 1, 1], "hay"), S([x, 1, 3], "fence_spruce"), S([x, 2, 3], "fence_spruce")]),
            S([5, 1, 1], "barrel_b"), S([9, 1, 1], "barrel_b"), S([5, 3, 3], "lantern"), S([9, 3, 3], "lantern"),
        ],
        carve: [F([2, 1, 8, 3, 2, 8], null), F([11, 1, 8, 12, 2, 8], null), S([2, 1, 8], "fence_spruce"), S([12, 1, 8], "fence_spruce"), F([2, 3, 8, 3, 3, 8], "pl_dkoak"), F([11, 3, 8, 12, 3, 8], "pl_dkoak")],
    }),
);

// -- military
LIST.push(
    building({
        id: "barracks_v2", category: "military", kind: "barracks", w: 21, d: 9, wh: 4, wall: "wall_plain", base: "wall_base", frame: "lg_dkoak", floor: "wall_floor",
        posts: [5, 10, 15], roofFam: "stone", ridge: "wall_plain", doorFam: "dkoak", doorXs: [10], winY: [3], fd: 4, interior: barracksInterior(21, 9),
    }),
    building({
        id: "armoury_v2", category: "military", kind: "armoury", w: 11, d: 9, wall: "wall_plain", base: "wall_base", frame: "lg_dkoak", floor: "wall_floor",
        roofFam: "stone", roof: "hip", ridge: "wall_plain", doorFam: "dkoak", posts: [5], winY: [], fd: 4,
        interior: [...[1, 2, 3, 7, 8, 9].map((x) => S([x, 1, 1], "chest_s")), S([5, 1, 1], "anvil_b"), S([1, 1, 4], "grindstone_b"), S([9, 1, 4], "blast_b"), S([5, 1, 4], "table"), S([3, 2, 4], "lantern"), S([7, 2, 4], "lantern")],
        carve: [...[3, 7].map((x) => S([x, 2, 0], "slit")), ...[3, 7].map((x) => S([x, 2, 8], "slit"))],
    }),
    building({
        id: "hospital_v2", category: "civic", kind: "hospital", w: 13, d: 9, wall: "clay_white", base: "cobble", frame: "lg_birch", floor: "pl_birch",
        posts: [6], roofFam: "birch", ridge: "pl_birch", gable: "clay_white", doorFam: "birch", doorXs: [6], porch: 2, chimney: 1, winY: [2], fd: 3,
        interior: [
            ...[2, 4, 8, 10].flatMap((x) => [S([x, 1, 1], "wool_white"), S([x, 1, 2], "wool_white"), S([x, 1, 3], "wool_red"), S([x, 2, 1], "lantern")]),
            S([11, 1, 6], "cauldron_b"), S([1, 1, 6], "composter_b"), S([2, 1, 6], "chest_e"), S([6, 1, 6], "cartography_b"),
        ],
    }),
    building({
        id: "school_v2", category: "civic", kind: "school", w: 13, d: 9, wall: "pl_oak", base: "cobble", frame: "lg_birch", floor: "pl_birch",
        posts: [6], roofFam: "birch", roof: "hip", ridge: "pl_birch", doorFam: "birch", doorXs: [6], porch: 2, winY: [2], fd: 3,
        interior: [
            ...[3, 5, 7, 9].flatMap((x) => [S([x, 1, 3], "table"), S([x, 1, 5], "table")]),
            S([6, 1, 1], "lectern_b"), ...[2, 3, 4, 8, 9, 10].map((x) => S([x, 1, 7], "bookshelf")), S([2, 2, 1], "lantern"), S([10, 2, 1], "lantern"),
        ],
    }),
);

// -- civic
LIST.push(
    building({
        id: "command_hall_v2", category: "civic", kind: "command", w: 23, d: 11, wh: 5, wall: "wall_plain", base: "wall_base", frame: "lg_dkoak", floor: "wall_floor",
        posts: [5, 11, 17], roofFam: "stone", roof: "hip", ridge: "wall_plain", doorFam: "dkoak", doorXs: [11], porch: 3, winY: [3], fd: 4,
        interior: [
            F([11, 1, 1, 11, 1, 9], "carpet_red"), F([8, 1, 3, 14, 1, 3], "pl_dkoak"), ...[3, 5, 7, 15, 17, 19].map((x) => S([x, 1, 1], "bookshelf")),
            ...[3, 5, 7, 15, 17, 19].map((x) => S([x, 2, 1], "bookshelf")), S([5, 1, 7], "chest_n"), S([17, 1, 7], "chest_n"), S([11, 2, 1], "lantern"), S([9, 4, 5], "lantern"), S([13, 4, 5], "lantern"),
        ],
    }),
    building({
        id: "chapel_v2", category: "civic", kind: "chapel", w: 9, d: 15, wh: 5, wall: "wall_plain", base: "wall_base", frame: "lg_birch", floor: "wall_floor",
        roofFam: "stone", ridge: "wall_plain", doorFam: "birch", winY: [3], pane: 2, fd: 3,
        interior: [
            F([4, 1, 1, 4, 1, 11], "carpet_red"), ...[2, 3, 5, 6].flatMap((x) => [F([x, 1, 4, x, 1, 5], "pl_birch"), F([x, 1, 8, x, 1, 9], "pl_birch")]),
            S([4, 1, 1], "lectern_b"), S([3, 2, 1], "lantern"), S([5, 2, 1], "lantern"), S([2, 1, 1], "bell_b"),
        ],
    }),
);

/**
 * Watch/guard structures built by hand (towers).
 * @returns {Blueprint2[]}
 */
function towers() {
    /** @type {Op[]} */
    const guard = [
        F([0, 0, 0, 4, 0, 4], "wall_floor"),
        F([0, 1, 0, 4, 7, 4], "wall_plain"),
        F([1, 1, 1, 3, 7, 3], null),
        RING([0, 0, 4, 4], [1, 1], "wall_base"),
        F([1, 4, 1, 3, 4, 3], "pl_spruce"),
        F([0, 8, 0, 4, 8, 4], "wall_plain"),
        F([1, 1, 1, 1, 8, 1], "ladder_s"),
        RING([0, 0, 4, 4], [9, 9], "wall_plain", 1, 0),
        ...door(2, 4, "dkoak"),
        S([0, 2, 2], "slit"), S([4, 2, 2], "slit"), S([2, 6, 0], "slit"), S([0, 6, 2], "slit"), S([4, 6, 2], "slit"),
        S([2, 1, 1], "lantern"), S([2, 5, 2], "lantern"),
    ];
    /** @type {Op[]} */
    const watch = [
        F([0, 0, 0, 4, 0, 4], "cobble"),
        RING([0, 0, 4, 4], [1, 6], "wall_rubble"),
        F([1, 1, 1, 3, 6, 3], null),
        F([1, 7, 1, 3, 7, 3], "pl_spruce"),
        RING([0, 0, 4, 4], [7, 7], "pl_spruce"),
        RING([0, 0, 4, 4], [8, 8], "fence_spruce"),
        ...[[0, 0], [4, 0], [0, 4], [4, 4]].map(([x, z]) => F([x ?? 0, 8, z ?? 0, x ?? 0, 11, z ?? 0], "lg_spruce")),
        F([1, 1, 1, 1, 8, 1], "ladder_s"),
        ...door(2, 4, "dkoak"),
        S([0, 3, 2], "slit"), S([4, 3, 2], "slit"), S([2, 3, 0], "slit"),
        S([2, 8, 2], "lantern"),
        ...hipRoof(0, 0, 5, 5, 12, "spruce", "pl_spruce").ops,
    ];
    return [
        finish("guard_post_v2", "military", [5, 10, 5], guard, [{ at: [2, 1, 4], dir: "south", kind: "guard_post" }], 3),
        finish("watchtower_v2", "military", [5, 15, 5], watch, [{ at: [2, 1, 4], dir: "south", kind: "watchtower" }], 4),
    ];
}
LIST.push(...towers());

/**
 * Citadel: walled courtyard with four corner turrets and a great hall.
 * @returns {Blueprint2}
 */
function citadel() {
    const w = 31;
    const d = 27;
    /** @type {Op[]} */
    const ops = [
        F([0, 0, 0, w - 1, 0, d - 1], "pave"),
        RING([0, 0, w - 1, d - 1], [1, 6], "wall", 2),
        RING([0, 0, w - 1, d - 1], [7, 7], "wall_plain", 1, 0),
        F([14, 1, d - 2, 16, 5, d - 1], null),
        F([14, 6, d - 2, 16, 6, d - 1], "wall_plain"),
        F([14, 5, d - 2, 16, 5, d - 2], "bars"),
    ];
    for (const [tx, tz] of [[0, 0], [w - 5, 0], [0, d - 5], [w - 5, d - 5]]) {
        const x = tx ?? 0;
        const z = tz ?? 0;
        ops.push(F([x, 1, z, x + 4, 10, z + 4], "wall"));
        ops.push(F([x + 1, 1, z + 1, x + 3, 9, z + 3], null));
        ops.push(F([x + 1, 5, z + 1, x + 3, 5, z + 3], "pl_spruce"));
        ops.push(F([x + 1, 1, z + 1, x + 1, 9, z + 1], "ladder_s"), S([x + 1, 5, z + 1], "ladder_s"));
        ops.push(RING([x, z, x + 4, z + 4], [11, 11], "wall_plain", 1, 0));
        ops.push(S([x + 2, 2, z + 3], "lantern"), S([x + 2, 7, z + 3], "lantern"));
        const inwardX = x === 0 ? x + 4 : x;
        ops.push(F([inwardX, 1, z + 2, inwardX, 2, z + 2], null));
    }
    const hall = building({
        id: "_hall", category: "civic", kind: "command", w: 21, d: 9, wh: 5, wall: "wall_plain", base: "wall_base", frame: "lg_dkoak", floor: "wall_floor",
        posts: [5, 10, 15], roofFam: "stone", ridge: "wall_plain", doorFam: "dkoak", doorXs: [10], winY: [3], fd: 4,
        interior: [F([10, 1, 1, 10, 1, 7], "carpet_red"), ...[2, 4, 16, 18].map((x) => S([x, 1, 1], "chest_s")), S([10, 1, 1], "table"), S([6, 4, 4], "lantern"), S([14, 4, 4], "lantern")],
    });
    ops.push(...shift(hall.ops, 5, 0, 4));
    // courtyard furniture: flag pole, well, braziers
    ops.push(F([15, 1, 19, 15, 8, 19], "fence_dkoak"), F([16, 6, 19, 17, 8, 19], "wool_red"));
    ops.push(RING([6, 18, 8, 20], [1, 1], "cobble"), S([7, 0, 19], "water"), S([7, 1, 19], null));
    ops.push(S([23, 1, 19], "campfire_b"), S([23, 1, 15], "campfire_b"));
    ops.push(F([13, 0, 14, 17, 0, d - 1], "pave_light"));
    return finish("hq_citadel_v2", "civic", [w, 12, d], ops, [{ at: [15, 1, d - 1], dir: "south", kind: "hq" }], 4);
}
LIST.push(citadel());

// -- open-air structures
LIST.push(
    ((/** @returns {Blueprint2} */) => {
        /** @type {Op[]} */
        const ops = [F([0, 0, 0, 4, 0, 2], "path_dirt")];
        for (const [x, z] of [[0, 0], [4, 0], [0, 2], [4, 2]]) {
            ops.push(F([x ?? 0, 1, z ?? 0, x ?? 0, 2, z ?? 0], "fence"));
        }
        for (let x = 0; x <= 4; x += 1) {
            ops.push(F([x, 3, 0, x, 3, 2], x % 2 === 0 ? "wool_red" : "wool_white"));
        }
        ops.push(S([1, 1, 1], "barrel_b"), S([2, 1, 1], "table"), S([3, 1, 1], "barrel_b"), S([2, 1, 0], "chest_s"), S([1, 2, 1], "hay"));
        return finish("market_stall_v2", "commercial", [5, 4, 3], ops, [{ at: [2, 1, 2], dir: "south", kind: "stall" }], 1);
    })(),
    ((/** @returns {Blueprint2} */) => {
        /** @type {Op[]} */
        const ops = [F([0, 0, 0, 4, 0, 2], "path_dirt")];
        for (const [x, z] of [[0, 0], [4, 0], [0, 2], [4, 2]]) {
            ops.push(F([x ?? 0, 1, z ?? 0, x ?? 0, 2, z ?? 0], "fence_spruce"));
        }
        for (let x = 0; x <= 4; x += 1) {
            ops.push(F([x, 3, 0, x, 3, 2], x % 2 === 0 ? "wool_blue" : "wool_yellow"));
        }
        ops.push(S([1, 1, 1], "melon_blk"), S([2, 1, 1], "hay"), S([3, 1, 1], "pumpkin_blk"), S([2, 1, 0], "barrel_b"), S([0, 1, 1], "composter_b"));
        return finish("market_stall_b_v2", "commercial", [5, 4, 3], ops, [{ at: [2, 1, 2], dir: "south", kind: "stall" }], 1);
    })(),
    ((/** @returns {Blueprint2} */) => {
        const w = 7;
        const d = 7;
        /** @type {Op[]} */
        const ops = [
            F([0, 0, 0, w - 1, 0, d - 1], "pave"),
            RING([2, 2, 4, 4], [1, 1], "cobble"),
            S([3, 0, 3], "water"),
            ...[[2, 2], [4, 2], [2, 4], [4, 4]].map(([x, z]) => F([x ?? 0, 2, z ?? 0, x ?? 0, 3, z ?? 0], "fence")),
            F([2, 4, 2, 4, 4, 4], "sl_spruce"),
            S([3, 5, 3], "lantern"),
        ];
        return finish("well_v2", "public", [w, 6, d], ops, [{ at: [3, 1, d - 1], dir: "south", kind: "well" }], 2);
    })(),
    ((/** @returns {Blueprint2} */) => {
        const w = 25;
        const d = 25;
        /** @type {Op[]} */
        const ops = [F([0, 0, 0, w - 1, 0, d - 1], "pave"), RING([0, 0, w - 1, d - 1], [0, 0], "wall_plain", 1), F([10, 0, 10, 14, 0, 14], "pave_light")];
        ops.push(RING([11, 11, 13, 13], [1, 1], "cobble"), S([12, 0, 12], "water"));
        for (const [x, z] of [[4, 4], [20, 4], [4, 20], [20, 20], [12, 4], [12, 20], [4, 12], [20, 12]]) {
            ops.push(F([x ?? 0, 1, z ?? 0, x ?? 0, 3, z ?? 0], "fence"), S([x ?? 0, 4, z ?? 0], "lantern"));
        }
        ops.push(F([12, 1, 0, 12, 1, 24], null));
        return finish("market_square_v2", "public", [w, 5, d], ops, [{ at: [12, 1, d - 1], dir: "south", kind: "square" }], 1);
    })(),
    ((/** @returns {Blueprint2} */) => {
        const w = 21;
        const d = 15;
        /** @type {Op[]} */
        const ops = [
            F([0, 0, 0, w - 1, 0, d - 1], "yard_gravel"),
            RING([0, 0, w - 1, d - 1], [1, 1], "fence_dkoak"),
            S([10, 1, d - 1], "gate_spruce_s"), S([10, 1, 0], "gate_spruce_s"),
            F([2, 1, 2, 6, 3, 6], "pl_spruce"), F([3, 1, 3, 5, 2, 5], null),
            ...door(4, 6, "dkoak"), F([2, 4, 2, 6, 4, 6], "sl_dkoak"),
            S([4, 1, 3], "table"), S([5, 1, 3], "chest_s"),
            ...[[13, 4], [15, 4], [17, 4], [14, 8], [16, 8]].map(([x, z]) => S([x ?? 0, 1, z ?? 0], "barrel_b")),
            ...[[13, 10], [14, 10]].map(([x, z]) => S([x ?? 0, 1, z ?? 0], "hay")),
            S([8, 1, 2], "lantern"), S([12, 1, 12], "campfire_b"),
        ];
        return finish("customs_yard_v2", "commercial", [w, 5, d], ops, [{ at: [10, 1, d - 1], dir: "south", kind: "customs" }], 2);
    })(),
    ((/** @returns {Blueprint2} */) => {
        const w = 23;
        const d = 17;
        /** @type {Op[]} */
        const ops = [F([0, 0, 0, w - 1, 0, d - 1], "yard_gravel"), RING([0, 0, w - 1, d - 1], [1, 1], "fence_spruce"), S([11, 1, d - 1], "gate_s")];
        for (const [x, z, hgt] of [[3, 3, 3], [6, 3, 2], [4, 6, 2], [15, 3, 3], [18, 4, 2], [16, 7, 2], [10, 8, 1]]) {
            ops.push(F([x ?? 0, 1, z ?? 0, (x ?? 0) + 2, hgt ?? 1, (z ?? 0) + 2], "stone_raw"));
        }
        ops.push(F([6, 1, 11, 8, 1, 12], "gravel"), ...[[14, 12], [16, 12], [18, 12]].map(([x, z]) => S([x ?? 0, 1, z ?? 0], "barrel_b")));
        ops.push(F([20, 1, 14, 20, 5, 14], "lg_spruce"), F([17, 5, 14, 20, 5, 14], "pl_spruce"), S([3, 1, 13], "lantern"));
        return finish("quarry_yard_v2", "industrial", [w, 6, d], ops, [{ at: [11, 1, d - 1], dir: "south", kind: "quarry" }], 2);
    })(),
    ((/** @returns {Blueprint2} */) => {
        const w = 31;
        const d = 23;
        /** @type {Op[]} */
        const ops = [F([0, 0, 0, w - 1, 0, d - 1], "path_dirt"), RING([0, 0, w - 1, d - 1], [1, 1], "fence_dkoak"), S([15, 1, d - 1], "gate_spruce_s"), S([3, 1, d - 1], "gate_spruce_s"), S([27, 1, d - 1], "gate_spruce_s")];
        for (let x = 5; x <= w - 6; x += 4) {
            ops.push(F([x, 1, 4, x, 2, 4], "fence_spruce"), S([x, 3, 4], "hay"));
        }
        ops.push(F([15, 1, 12, 15, 7, 12], "fence_dkoak"), F([16, 6, 12, 17, 7, 12], "wool_red"));
        for (const x of [4, 8, 22, 26]) {
            ops.push(F([x, 1, 16, x, 1, 16], "pumpkin_blk"));
        }
        ops.push(F([2, 1, 9, 2, 2, 9], "fence"), F([28, 1, 9, 28, 2, 9], "fence"), S([2, 3, 9], "lantern"), S([28, 3, 9], "lantern"));
        return finish("drill_ground_v2", "military", [w, 9, d], ops, [{ at: [15, 1, d - 1], dir: "south", kind: "drill" }], 2);
    })(),
);

// -- farming
LIST.push(
    cropField({ id: "farm_wheat_v2", w: 21, d: 21, crops: ["wheat"] }),
    cropField({ id: "farm_veg_v2", w: 19, d: 19, crops: ["carrot_crop", "potato_crop", "beet_crop"], fence: "fence_spruce" }),
    cropField({ id: "farm_irrigated_v2", w: 25, d: 23, crops: ["wheat", "carrot_crop", "potato_crop", "wheat"], canal: true, border: "dirt_coarse" }),
    cropField({ id: "farm_kitchen_v2", w: 13, d: 13, crops: ["carrot_crop", "beet_crop", "wheat"], fence: "fence_birch" }),
    cropField({ id: "farm_allot_v2", w: 9, d: 9, crops: ["carrot_crop", "potato_crop"], fence: "fence_birch" }),
    orchard({ id: "orchard_v2", w: 21, d: 19 }),
    pen(),
    garden(),
);

/** @type {Record<string, Blueprint2>} */
export const BLUEPRINTS2 = Object.fromEntries(LIST.map((bp) => [bp.id, bp]));

/** Lot kind -> blueprint ids (variants chosen by seeded hash). */
export const BLUEPRINT_VARIANTS = /** @type {Record<string, string[]>} */ ({
    house_s: ["house_s_v2", "house_s_alt_v2"],
    house_m: ["house_m_v2", "house_m_alt_v2"],
    house_l: ["house_l_v2", "house_l_alt_v2"],
    longhouse: ["longhouse_v2"],
    workshop: ["workshop_v2"],
    smithy: ["smithy_v2"],
    kiln: ["kiln_v2"],
    warehouse: ["warehouse_v2", "warehouse_open_v2"],
    granary: ["granary_v2"],
    mill: ["mill_v2"],
    shop: ["shop_v2"],
    inn: ["inn_v2"],
    stable: ["stable_v2"],
    barracks: ["barracks_v2"],
    armoury: ["armoury_v2"],
    hospital: ["hospital_v2"],
    school: ["school_v2"],
    chapel: ["chapel_v2"],
    command_hall: ["command_hall_v2"],
    hq_citadel: ["hq_citadel_v2"],
    guard_post: ["guard_post_v2"],
    watchtower: ["watchtower_v2"],
    market_stall: ["market_stall_v2", "market_stall_b_v2"],
    well: ["well_v2"],
    market_square: ["market_square_v2"],
    customs_yard: ["customs_yard_v2"],
    quarry_yard: ["quarry_yard_v2"],
    drill_ground: ["drill_ground_v2"],
    farm_wheat: ["farm_wheat_v2"],
    farm_veg: ["farm_veg_v2"],
    farm_irrigated: ["farm_irrigated_v2"],
    farm_kitchen: ["farm_kitchen_v2"],
    farm_allot: ["farm_allot_v2"],
    orchard: ["orchard_v2"],
    pen: ["pen_v2"],
    garden: ["garden_v2"],
});

// ---------------------------------------------------------------- expansion

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function hash3(x, y, z) {
    return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
}

/**
 * @param {number[]} box
 * @returns {Generator<[number, number, number]>}
 */
function* boxCells(box) {
    const [a, b, c, d, e, f] = /** @type {[number, number, number, number, number, number]} */ (box);
    for (let y = Math.min(b, e); y <= Math.max(b, e); y += 1) {
        for (let x = Math.min(a, d); x <= Math.max(a, d); x += 1) {
            for (let z = Math.min(c, f); z <= Math.max(c, f); z += 1) {
                yield [x, y, z];
            }
        }
    }
}

/**
 * Cells an op touches (same semantics as planner.js).
 * @param {Op} op
 * @returns {Generator<[number, number, number]>}
 */
export function* opCells(op) {
    if (op.op === "set") {
        yield /** @type {[number, number, number]} */ (op.at);
    } else if (op.op === "fill") {
        yield* boxCells(op.box);
    } else if (op.op === "hollow") {
        const [x1, y1, z1, x2, y2, z2] = op.box;
        for (const cell of boxCells(op.box)) {
            const [x, y, z] = cell;
            if (x === Math.min(x1, x2) || x === Math.max(x1, x2) || y === Math.min(y1, y2) || y === Math.max(y1, y2) || z === Math.min(z1, z2) || z === Math.max(z1, z2)) {
                yield cell;
            }
        }
    } else if (op.op === "ring") {
        const [x1, z1, x2, z2] = op.box;
        const loX = Math.min(x1, x2);
        const hiX = Math.max(x1, x2);
        const loZ = Math.min(z1, z2);
        const hiZ = Math.max(z1, z2);
        const t = op.t ?? 1;
        for (const [x, y, z] of boxCells([loX, op.y[0], loZ, hiX, op.y[1], hiZ])) {
            const depth = Math.min(x - loX, hiX - x, z - loZ, hiZ - z);
            if (depth < t && (op.parity === undefined || (((x + z) % 2) + 2) % 2 === op.parity)) {
                yield [x, y, z];
            }
        }
    } else {
        throw new Error(`unknown op '${String(op.op)}'`);
    }
}

/**
 * Rotate a local cell `turns` quarter turns clockwise inside a w x d footprint.
 * @param {number} x
 * @param {number} z
 * @param {number} w
 * @param {number} d
 * @param {number} turns
 * @returns {[number, number]}
 */
export function rotateInBox(x, z, w, d, turns) {
    let rx = x;
    let rz = z;
    let rw = w;
    let rd = d;
    for (let i = 0; i < ((turns % 4) + 4) % 4; i += 1) {
        const nx = rd - 1 - rz;
        rz = rx;
        rx = nx;
        const tmp = rw;
        rw = rd;
        rd = tmp;
    }
    return [rx, rz];
}

/**
 * Footprint dimensions after `turns` quarter turns.
 * @param {Blueprint2} bp
 * @param {number} turns
 * @returns {{ w: number, d: number }}
 */
export function rotatedSize(bp, turns) {
    return turns % 2 === 0 ? { w: bp.size[0], d: bp.size[2] } : { w: bp.size[2], d: bp.size[0] };
}

/**
 * Expand a blueprint into block placements, JSON-safe, in the planner's block shape.
 * (x, z) of the result are relative to the rotated footprint's min corner; y = blueprint y.
 * @param {Blueprint2} bp
 * @param {number} [rotation] quarter turns clockwise
 * @returns {{ x: number, y: number, z: number, id: string, name: string | undefined, states?: Record<string, any> }[]}
 */
export function expandBlueprint(bp, rotation = 0) {
    /** @type {Map<string, any>} */
    const map = new Map();
    for (const op of bp.ops) {
        for (const [lx, ly, lz] of opCells(op)) {
            const [x, z] = rotateInBox(lx, lz, bp.size[0], bp.size[2], rotation);
            let name;
            let spec = op.block;
            if (typeof spec === "string") {
                if (!Object.prototype.hasOwnProperty.call(PALETTE_V2, spec)) {
                    throw new Error(`${bp.id}: unknown palette token '${spec}'`);
                }
                name = spec;
                spec = PALETTE_V2[spec];
            }
            const key = `${String(x)},${String(ly)},${String(z)}`;
            if (spec === null || spec === undefined) {
                map.set(key, null);
                continue;
            }
            if (spec.mix !== undefined) {
                const total = spec.mix.reduce((/** @type {number} */ sum, /** @type {any} */ entry) => sum + entry[1], 0);
                let roll = hash3(x, ly, z) % total;
                for (const [option, weight] of spec.mix) {
                    if (roll < weight) {
                        spec = option;
                        break;
                    }
                    roll -= weight;
                }
            }
            const cell = { x, y: ly, z, id: spec.id, name, ...(spec.states !== undefined ? { states: { ...spec.states } } : {}) };
            if (spec.face !== undefined) {
                cell.states = { ...(cell.states ?? {}), ...encodeFacing({ ...spec.face, dir: rotateDir(spec.face.dir, rotation) }) };
            }
            map.set(key, cell);
        }
    }
    return [...map.values()].filter((cell) => cell !== null);
}
