/**
 * Facing helpers. Logical directions are compass names; a rotation of `n` quarter turns is
 * clockwise seen from above (north -> east -> south -> west), matching x east / z south.
 * The state encoders map a logical facing to Bedrock block states. They are PURE and are the
 * only place that knows state value conventions, so a wrong convention is a one-line fix.
 */

export const DIRS = ["north", "east", "south", "west"];

/**
 * @param {string} dir
 * @param {number} quarterTurns
 */
export function rotateDir(dir, quarterTurns) {
    const index = DIRS.indexOf(dir);
    if (index < 0) {
        throw new Error(`unknown direction '${dir}'`);
    }
    return /** @type {string} */ (DIRS[(((index + quarterTurns) % 4) + 4) % 4]);
}

/**
 * @param {number} x
 * @param {number} z
 * @param {number} quarterTurns clockwise
 * @returns {[number, number]}
 */
export function rotateXZ(x, z, quarterTurns) {
    let rx = x;
    let rz = z;
    for (let i = 0; i < (((quarterTurns % 4) + 4) % 4); i += 1) {
        const nx = 0 - rz;
        rz = rx;
        rx = nx;
    }
    return [rx, rz];
}

/** @type {Record<string, number>} */
const STAIR_DIRECTION = { east: 0, west: 1, south: 2, north: 3 };
/** @type {Record<string, number>} */
const LADDER_FACING = { north: 2, south: 3, west: 4, east: 5 };

/**
 * @param {{ kind: string, dir: string, half?: string, part?: string }} face
 * @returns {Record<string, string | number | boolean>}
 */
export function encodeFacing(face) {
    const dir = face.dir;
    switch (face.kind) {
        case "stairs":
            return { weirdo_direction: /** @type {number} */ (STAIR_DIRECTION[dir]), upside_down_bit: false };
        case "chest":
            return { "minecraft:cardinal_direction": dir };
        case "fence_gate":
            return { "minecraft:cardinal_direction": dir, open_bit: false, in_wall_bit: false };
        case "door":
            return { "minecraft:cardinal_direction": dir, upper_block_bit: face.half === "upper", door_hinge_bit: false, open_bit: false };
        case "ladder":
            return { facing_direction: /** @type {number} */ (LADDER_FACING[dir]) };
        default:
            throw new Error(`unknown facing kind '${face.kind}'`);
    }
}
