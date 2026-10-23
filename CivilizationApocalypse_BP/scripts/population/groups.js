import { CHUNK_SIZE, POP_FIGHT_SECURITY, POP_KINDS, POP_SPOTS } from "./settings.js";

// Groups, not individuals. Each district's civilians and soldiers are split into groups of a fixed size;
// one physical entity may stand for one group. The group table is DERIVED from the kingdom records on every
// reconcile, so a group's headcount always comes from the record and is never invented from observation.
//
// Group i of a kind covers the people with positions [i*size, (i+1)*size) of that count, so the last group is
// the partial one. Ids are stable: growth adds a higher index, shrinkage removes the highest index, and no
// surviving group is renumbered.

/** @typedef {"civ" | "sol"} GroupKind */
/** @typedef {{ x: number, y: number, z: number }} Point */
/** @typedef {{ id: string, district: string, kind: GroupKind, index: number, headcount: number }} GroupRecord */

/**
 * @param {string} a
 * @param {string} b
 */
export function compareText(a, b) {
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}

/**
 * @param {unknown} value
 * @returns {value is GroupKind}
 */
export function isGroupKind(value) {
    return value === "civ" || value === "sol";
}

/**
 * Stable group id: `district:kind:index`. District ids must not contain ':' (buildGroupTable refuses them).
 * @param {string} district
 * @param {GroupKind} kind
 * @param {number} index
 */
export function groupIdOf(district, kind, index) {
    return `${district}:${kind}:${String(index)}`;
}

const INDEX_PATTERN = /^(0|[1-9][0-9]{0,5})$/;

/**
 * Parse a group id. Returns null for anything that does not round-trip exactly, so a hand-edited or
 * foreign string can never be mistaken for a group.
 * @param {unknown} id
 * @returns {{ district: string, kind: GroupKind, index: number } | null}
 */
export function parseGroupId(id) {
    if (typeof id !== "string") {
        return null;
    }
    const parts = id.split(":");
    if (parts.length !== 3) {
        return null;
    }
    const [district, kind, digits] = parts;
    if (district.length === 0 || !isGroupKind(kind) || !INDEX_PATTERN.test(digits)) {
        return null;
    }
    const index = Number(digits);
    if (groupIdOf(district, kind, index) !== id) {
        return null;
    }
    return { district, kind, index };
}

/**
 * The group table for a validated kingdom. Districts are visited in id order, kinds in POP_KINDS order.
 * @param {any} kingdom validated by kingdom/state.js findValidationProblems
 * @param {{ groupSize: { civ: number, sol: number } }} config
 * @returns {{ groups: GroupRecord[], problems: string[] }}
 */
export function buildGroupTable(kingdom, config) {
    /** @type {GroupRecord[]} */
    const groups = [];
    /** @type {string[]} */
    const problems = [];
    const districts = /** @type {any[]} */ (kingdom.districts)
        .slice()
        .sort((left, right) => compareText(String(left.id), String(right.id)));
    for (const district of districts) {
        const districtId = String(district.id);
        if (districtId.includes(":")) {
            problems.push(`district id ${districtId} contains ':' and cannot be tagged, so it has no groups`);
            continue;
        }
        for (const kind of POP_KINDS) {
            const people = Number(kind === "civ" ? district.civilians : district.soldiers);
            const size = config.groupSize[kind];
            const count = Math.ceil(people / size);
            for (let index = 0; index < count; index += 1) {
                groups.push({
                    id: groupIdOf(districtId, kind, index),
                    district: districtId,
                    kind,
                    index,
                    headcount: Math.min(size, people - index * size),
                });
            }
        }
    }
    return { groups, problems };
}

/**
 * Deterministic spawn spot for a group: a grid inside the district's physical footprint.
 * @param {Point} home
 * @param {GroupKind} kind
 * @param {number} index
 * @returns {Point}
 */
export function spotFor(home, kind, index) {
    const column = index % POP_SPOTS.gridWidth;
    const row = Math.floor(index / POP_SPOTS.gridWidth);
    const band = kind === "sol" ? POP_SPOTS.soldierRowOffset : 0;
    return {
        x: home.x + POP_SPOTS.inset + column * POP_SPOTS.spacing,
        y: home.y,
        z: home.z + POP_SPOTS.inset + band + row * POP_SPOTS.spacing,
    };
}

/**
 * @param {number} x
 * @param {number} z
 * @returns {string} "cx,cz"
 */
export function chunkKeyOf(x, z) {
    return `${String(Math.floor(x / CHUNK_SIZE))},${String(Math.floor(z / CHUNK_SIZE))}`;
}

/**
 * Horizontal distance from a point to the nearest anchor. Infinity when there are no anchors.
 * @param {Point} point
 * @param {ReadonlyArray<{ x: number, z: number }>} anchors
 */
export function nearestDistance(point, anchors) {
    let best = Infinity;
    for (const anchor of anchors) {
        const distance = Math.hypot(point.x - anchor.x, point.z - anchor.z);
        if (distance < best) {
            best = distance;
        }
    }
    return best;
}

/**
 * A district is in an active fight while raiders are on it or its security says so. Nothing spawns or
 * despawns in an active fight: a unit is never removed in the middle of combat.
 * @param {any} district
 */
export function districtInFight(district) {
    return Number(district?.assault ?? 0) > 0 || POP_FIGHT_SECURITY.includes(String(district?.security));
}
