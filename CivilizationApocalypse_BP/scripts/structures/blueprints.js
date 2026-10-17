/**
 * Reusable building blueprints. Pure data (plus tiny helpers that build op lists).
 *
 * Coordinates are blueprint-local: x east, z south, y up, y = 0 is the FLOOR layer, which sits
 * on the replaced ground surface (the layout places blueprints at y = -1). Every blueprint is
 * authored facing SOUTH (its entrance is on the +z side) and is rotated clockwise in quarter
 * turns by the layout. `entrances` list the lower door cell and which way it faces, so the
 * planner can derive the road-side "front" cell for route checks.
 *
 * Op vocabulary (see planner.js): set | fill | hollow | ring. Later ops override earlier ones;
 * `"air"` carves.
 */

/**
 * Walls + floor + roof shared by houses, storehouses and the barracks. Width runs along x,
 * depth is fixed at 7 so the gable ridge (z = 3) is centred.
 * @param {number} width
 * @param {{ wall: string, base: string, frame: string, floor: string }} style
 * @returns {any[]}
 */
function gabledShell(width, style) {
    const last = width - 1;
    return [
        { op: "fill", box: [0, 0, 0, last, 0, 6], block: style.floor },
        { op: "ring", box: [0, 0, last, 6], t: 1, y: [1, 1], block: style.base },
        { op: "ring", box: [0, 0, last, 6], t: 1, y: [2, 3], block: style.wall },
        ...[[0, 0], [last, 0], [0, 6], [last, 6]].map(([x, z]) => ({ op: "fill", box: [x, 1, z, x, 3, z], block: style.frame })),
        // roof: stepped stairs rising to a ridge at z = 3, gable ends closed with planks
        { op: "fill", box: [0, 4, 0, last, 4, 0], block: "roof_s" },
        { op: "fill", box: [0, 4, 6, last, 4, 6], block: "roof_n" },
        { op: "fill", box: [0, 5, 1, last, 5, 1], block: "roof_s" },
        { op: "fill", box: [0, 5, 5, last, 5, 5], block: "roof_n" },
        { op: "fill", box: [0, 6, 2, last, 6, 2], block: "roof_s" },
        { op: "fill", box: [0, 6, 4, last, 6, 4], block: "roof_n" },
        { op: "fill", box: [0, 7, 3, last, 7, 3], block: "plank_dark" },
        ...[0, last].flatMap((x) => [
            { op: "fill", box: [x, 4, 1, x, 4, 5], block: style.wall },
            { op: "fill", box: [x, 5, 2, x, 5, 4], block: style.wall },
            { op: "set", at: [x, 6, 3], block: style.wall },
        ]),
    ];
}

/** @param {number} x door column on the south wall */
function southDoor(x) {
    return [
        { op: "set", at: [x, 1, 6], block: "door_lo_s" },
        { op: "set", at: [x, 2, 6], block: "door_hi_s" },
    ];
}

/**
 * Tower shell: solid block, a ground room (y1-5), a floor at y6 flush with the wall walkway,
 * an upper room (y7-10), a roof platform at y11 with a battlement, one ladder shaft, a south
 * door and walkway openings.
 * @param {{ openings: number[][], doorX?: number }} options
 * @returns {any[]}
 */
function towerOps(options) {
    const doorX = options.doorX ?? 2;
    // blueprint y = world y + 1: floor layer 0 is the ground surface, so the wall walkway
    // (world y 6) is blueprint y 7 and the tower's upper floor sits flush with it.
    return [
        { op: "fill", box: [0, 0, 0, 4, 12, 4], block: "wall" },
        { op: "fill", box: [1, 1, 1, 3, 6, 3], block: "air" },
        { op: "fill", box: [1, 7, 1, 3, 7, 3], block: "plank" },
        { op: "fill", box: [1, 8, 1, 3, 11, 3], block: "air" },
        { op: "set", at: [2, 7, 1], block: "air" },
        { op: "set", at: [2, 12, 1], block: "air" },
        { op: "fill", box: [2, 1, 1, 2, 7, 1], block: "ladder_s" },
        { op: "fill", box: [2, 8, 1, 2, 12, 1], block: "ladder_s" },
        { op: "ring", box: [0, 0, 4, 4], t: 1, y: [13, 13], block: "wall", parity: 0 },
        // arrow slits and a lantern in each room
        { op: "set", at: [0, 4, 2], block: "slit" },
        { op: "set", at: [4, 4, 2], block: "slit" },
        { op: "set", at: [0, 10, 2], block: "slit" },
        { op: "set", at: [4, 10, 2], block: "slit" },
        { op: "set", at: [2, 10, 4], block: "slit" },
        { op: "set", at: [3, 1, 3], block: "lantern" },
        { op: "set", at: [3, 8, 3], block: "lantern" },
        // south door into the ground room
        ...southDoor(doorX).map((entry) => ({ ...entry, at: [entry.at[0], entry.at[1], 4] })),
        // openings onto the wall walkway at the upper-room level
        ...options.openings.map((box) => ({ op: "fill", box, block: "air" })),
    ];
}

/** Climb steps along +x: step k sits at x = k, y = k, with solid support beneath. */
function wallStairOps() {
    /** @type {any[]} */
    const ops = [];
    for (let k = 0; k <= 6; k += 1) {
        if (k > 0) {
            ops.push({ op: "fill", box: [k, 0, 0, k, k - 1, 0], block: "cobble" });
        }
        ops.push({ op: "set", at: [k, k, 0], block: "stair_e" });
    }
    return ops;
}

export const BLUEPRINTS = {
    house: {
        size: [7, 8, 7],
        entrances: [{ at: [3, 1, 6], dir: "south", kind: "homes" }],
        ops: [
            ...gabledShell(7, { wall: "plank", base: "cobble", frame: "log", floor: "plank_dark" }),
            ...[[2, 0], [4, 0], [0, 2], [0, 4], [6, 2], [6, 4], [2, 6], [4, 6]].map(([x, z]) => ({ op: "set", at: [x, 2, z], block: "glass" })),
            ...southDoor(3),
            { op: "set", at: [1, 1, 1], block: "table" },
            { op: "set", at: [1, 2, 1], block: "lantern" },
            { op: "set", at: [5, 1, 1], block: "chest_s" },
            { op: "set", at: [5, 1, 5], block: "furnace_block" },
            { op: "set", at: [1, 1, 5], block: "bookshelf" },
            { op: "set", at: [1, 2, 5], block: "bookshelf" },
        ],
    },

    storehouse: {
        size: [7, 8, 7],
        entrances: [{ at: [3, 1, 6], dir: "south", kind: "storehouses" }],
        ops: [
            ...gabledShell(7, { wall: "plank_dark", base: "cobble", frame: "log", floor: "cobble" }),
            ...[[2, 6], [4, 6], [0, 3], [6, 3]].map(([x, z]) => ({ op: "set", at: [x, 2, z], block: "glass" })),
            ...southDoor(3),
            // stacked stores: barrels and hay along the walls, two chests, a lantern
            ...[1, 2, 3, 4, 5].map((x) => ({ op: "set", at: [x, 1, 1], block: "barrel_up" })),
            { op: "set", at: [1, 1, 3], block: "hay" },
            { op: "set", at: [1, 2, 3], block: "hay" },
            { op: "set", at: [5, 1, 3], block: "chest_w" },
            { op: "set", at: [5, 1, 4], block: "chest_w" },
            { op: "set", at: [3, 1, 1], block: "table" },
            { op: "set", at: [3, 2, 1], block: "lantern" },
        ],
    },

    barracks: {
        size: [15, 8, 7],
        entrances: [{ at: [7, 1, 6], dir: "south", kind: "barracks" }],
        ops: [
            ...gabledShell(15, { wall: "wall_plain", base: "wall_base", frame: "log", floor: "wall_floor" }),
            ...[2, 4, 10, 12].map((x) => ({ op: "set", at: [x, 2, 6], block: "glass" })),
            ...[2, 4, 6, 8, 10, 12].map((x) => ({ op: "set", at: [x, 2, 0], block: "glass" })),
            ...southDoor(7),
            // armoury chests and bunks (straw) in two rows, a briefing table in the middle
            ...[1, 3, 5, 9, 11, 13].map((x) => ({ op: "set", at: [x, 1, 1], block: "chest_s" })),
            ...[3, 11].map((x) => ({ op: "set", at: [x, 2, 1], block: "lantern" })),
            { op: "set", at: [7, 1, 1], block: "table" },
            ...[2, 4, 6, 8, 10, 12].map((x) => ({ op: "set", at: [x, 1, 3], block: "hay" })),
            ...[2, 12].map((x) => ({ op: "set", at: [x, 1, 5], block: "furnace_block" })),
        ],
    },

    farm: {
        size: [7, 3, 7],
        entrances: [{ at: [3, 1, 6], dir: "south", kind: "farms" }],
        ops: [
            { op: "fill", box: [0, 0, 0, 6, 0, 6], block: "dirt" },
            { op: "fill", box: [1, 0, 1, 5, 0, 5], block: "farmland" },
            { op: "fill", box: [1, 0, 3, 5, 0, 3], block: "water" },
            { op: "fill", box: [1, 1, 1, 5, 1, 2], block: "wheat" },
            { op: "fill", box: [1, 1, 4, 5, 1, 5], block: "wheat" },
            { op: "ring", box: [0, 0, 6, 6], t: 1, y: [1, 1], block: "fence" },
            { op: "set", at: [3, 1, 6], block: "gate_s" },
            { op: "set", at: [0, 2, 0], block: "lantern" },
            { op: "set", at: [6, 2, 0], block: "lantern" },
        ],
    },

    well_yard: {
        size: [7, 4, 7],
        entrances: [],
        ops: [
            { op: "fill", box: [0, 0, 0, 6, 0, 6], block: "plaza" },
            { op: "ring", box: [2, 2, 4, 4], t: 1, y: [1, 1], block: "cobble" },
            { op: "set", at: [3, 0, 3], block: "water" },
            ...[[2, 2], [4, 2], [2, 4], [4, 4]].map(([x, z]) => ({ op: "fill", box: [x, 2, z, x, 3, z], block: "fence" })),
            { op: "fill", box: [2, 4, 2, 4, 4, 4], block: "slab_roof" },
        ],
    },

    gate_tower: {
        size: [5, 14, 5],
        entrances: [{ at: [2, 1, 4], dir: "south", kind: "gate_tower" }],
        ops: towerOps({ openings: [[0, 8, 1, 0, 9, 2], [4, 8, 1, 4, 9, 2]] }),
    },

    corner_tower: {
        size: [5, 14, 5],
        entrances: [{ at: [1, 1, 4], dir: "south", kind: "corner_tower" }],
        ops: towerOps({ doorX: 1, openings: [[0, 8, 1, 0, 9, 2], [2, 8, 4, 3, 9, 4]] }),
    },

    wall_stair: {
        size: [7, 7, 1],
        entrances: [],
        ops: wallStairOps(),
    },
};
