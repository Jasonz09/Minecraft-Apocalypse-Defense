import { rotateXZ } from "./facing.js";

/**
 * District layouts: where blueprints and ground features go. Pure data.
 *
 * Frame: x east, z south, y up; (0,0) is the district centre, ground surface y = -1.
 * Half-extent 24 (49 x 49 footprint). Rings from the centre outwards:
 *   |c| <= 1       arterial roads (N-S and E-W, 3 wide)
 *   2 .. 16        building cells (7x7) in four quadrants, 1-block lanes between them
 *   17 .. 19       ring road (3 wide) - the evacuation / reinforcement loop
 *   20 .. 21       free lane for wall stairs and tower spurs
 *   22 .. 24       curtain wall (3 thick, walkway on top)
 *
 * Quarter turns are clockwise from above, so `spins: [0,1,2,3]` repeats a feature on all
 * four sides (north, east, south, west).
 */

const WALL_HEIGHT = 6;

/**
 * Origin of a 7-wide cell in a quadrant. `cx`/`cz` count cells outward from the arterials.
 * @param {number} sx quadrant sign on x
 * @param {number} sz quadrant sign on z
 * @param {number} cx
 * @param {number} cz
 * @returns {{ x: number, z: number, facing: number }}
 */
function cell(sx, sz, cx, cz) {
    const x = sx > 0 ? 2 + 8 * cx : -8 - 8 * cx;
    const z = sz > 0 ? 2 + 8 * cz : -8 - 8 * cz;
    // Rotation (clockwise quarter turns) of a south-facing blueprint so its door faces a road:
    // inner column -> towards the arterial, outer column -> towards the ring road.
    const towardsArterial = cx === 0;
    const west = (sx > 0) === towardsArterial;
    return { x, z, facing: west ? 1 : 3 };
}

/**
 * @param {string} kind
 * @param {string} bp
 * @param {number} sx
 * @param {number} sz
 * @param {number} cx
 * @param {number} cz
 */
function slot(kind, bp, sx, sz, cx, cz) {
    const c = cell(sx, sz, cx, cz);
    return { kind, place: { op: "place", bp, kind, at: [c.x, -1, c.z], rotation: c.facing } };
}

const barracksCell = cell(1, -1, 0, 1);

const SLOTS = [
    // houses
    slot("homes", "house", 1, -1, 1, 0),
    slot("homes", "house", 1, -1, 1, 1),
    slot("homes", "house", -1, -1, 0, 0),
    slot("homes", "house", -1, -1, 0, 1),
    slot("homes", "house", -1, -1, 1, 0),
    slot("homes", "house", -1, 1, 0, 0),
    // storehouses
    slot("storehouses", "storehouse", -1, 1, 0, 1),
    slot("storehouses", "storehouse", -1, 1, 1, 0),
    slot("storehouses", "storehouse", -1, 1, 1, 1),
    // barracks: a double cell hugging the north-east arterial, door facing west onto the road
    { kind: "barracks", place: { op: "place", bp: "barracks", kind: "barracks", at: [barracksCell.x, -1, barracksCell.z], rotation: 1 } },
    // farms
    slot("farms", "farm", 1, 1, 0, 0),
    slot("farms", "farm", 1, 1, 0, 1),
    slot("farms", "farm", 1, 1, 1, 0),
    slot("farms", "farm", 1, 1, 1, 1),
];

const ALL_SPINS = [0, 1, 2, 3];

export const DISTRICT_LAYOUTS = {
    hearthgate: {
        version: 1,
        half: 24,
        /** Order matters: it is the iteration order of the record -> slot match. */
        slotKinds: ["homes", "storehouses", "barracks", "farms"],
        slots: SLOTS,
        gates: [
            { id: "gate-north", side: "north", inner: { x: 0, z: -23 } },
            { id: "gate-east", side: "east", inner: { x: 23, z: 0 } },
            { id: "gate-south", side: "south", inner: { x: 0, z: 23 } },
            { id: "gate-west", side: "west", inner: { x: -23, z: 0 } },
        ],
        wallStairBases: ALL_SPINS.map((spin) => {
            const [x, z] = rotateXZ(9, -21, spin);
            return { x, z };
        }),
        fixed: [
            // ground network
            { op: "ring", box: [-19, -19, 19, 19], t: 3, y: [-1, -1], block: "road" },
            { op: "fill", box: [-1, -1, -19, 1, -1, 19], block: "road" },
            { op: "fill", box: [-19, -1, -1, 19, -1, 1], block: "road" },
            { op: "fill", box: [-1, -1, -1, 1, -1, 1], block: "plaza" },
            { op: "fill", box: [-2, -1, -24, 2, -1, -20], block: "road_stone", spins: ALL_SPINS },
            { op: "fill", box: [19, -1, -19, 21, -1, -18], block: "road", spins: ALL_SPINS },
            { op: "fill", box: [8, -1, -21, 9, -1, -20], block: "road", spins: ALL_SPINS },

            // curtain wall: solid, hollowed inside, walkway on top, parapet with merlons
            { op: "fill", box: [-24, 0, -24, 24, WALL_HEIGHT, 24], block: "wall" },
            { op: "ring", box: [-24, -24, 24, 24], t: 3, y: [0, 0], block: "wall_base" },
            { op: "fill", box: [-21, 0, -21, 21, WALL_HEIGHT, 21], block: "air" },
            { op: "ring", box: [-24, -24, 24, 24], t: 3, y: [WALL_HEIGHT, WALL_HEIGHT], block: "wall_floor" },
            { op: "ring", box: [-24, -24, 24, 24], t: 1, y: [WALL_HEIGHT + 1, WALL_HEIGHT + 1], block: "wall" },
            { op: "ring", box: [-24, -24, 24, 24], t: 1, y: [WALL_HEIGHT + 2, WALL_HEIGHT + 2], block: "wall", parity: 0 },

            // gates: 5 wide, 5 high passage with a raised portcullis (bars) under the lintel
            { op: "fill", box: [-2, 0, -24, 2, 4, -22], block: "air", spins: ALL_SPINS },
            { op: "fill", box: [-2, 4, -23, 2, 4, -23], block: "bars", spins: ALL_SPINS },

            // towers flank every gate; the four corners are towers too
            { op: "place", bp: "gate_tower", kind: "gate_tower", at: [-8, -1, -24], spins: ALL_SPINS },
            { op: "place", bp: "gate_tower", kind: "gate_tower", at: [4, -1, -24], spins: ALL_SPINS },
            { op: "place", bp: "corner_tower", kind: "corner_tower", at: [20, -1, -24], spins: ALL_SPINS },

            // stairs from the free lane up to the walkway so the reserve can man the wall
            { op: "place", bp: "wall_stair", kind: "wall_stair", at: [10, 0, -21], spins: ALL_SPINS },

            // dressing: lamp posts at lane crossings, a market lamp in the central junction
            { op: "fill", box: [9, 0, 9, 9, 1, 9], block: "fence", spins: ALL_SPINS },
            { op: "set", at: [9, 2, 9], block: "lantern", spins: ALL_SPINS },
            { op: "fill", box: [0, 0, 0, 0, 2, 0], block: "fence" },
            { op: "set", at: [0, 3, 0], block: "lantern" },

            // the fourth north-west cell is the well yard
            { op: "place", bp: "well_yard", kind: "well_yard", at: [-16, -1, -16] },
        ],
    },
};
