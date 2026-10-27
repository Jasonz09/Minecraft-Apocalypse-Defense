import { world as runtimeWorld } from "@minecraft/server";
import { classifyBlock } from "../civ/environments.js";
import { districtById, findValidationProblems } from "../kingdom/state.js";
import { createKingdomStore } from "../kingdom/store.js";
import { protectedRects } from "../commands/civ.js";
import { inProtectedArea, loadMasterPlan, PROTECT_MARGIN, WRITE_PROTECT_GROW } from "./civBuilder.js";
import { BEARINGS } from "../sim/invasion/composition.js";
import { armInvasionDirector, invasionThreatOf } from "../sim/invasion/director.js";
import { peopleGateOn } from "../people/gate.js";

/**
 * The siege, made physical: when the simulation says a district is under attack, the attackers stand outside
 * its wall and fight whoever is on it; when the simulation says the attack is spent, they go away.
 *
 * It is a `peopleRuntime.js` driver - `{ id: "siege", onHour(ctx) }` - so it runs once per accepted simulation
 * hour and never while a district build holds the world. The runtime also calls it on the hours the people gate
 * is off, with `ctx.gateOn === false`: those hours are teardown only, because Script API v2.7.0 has no removal
 * event to clean up behind a switched-off world. The integrator registers it in main.js; nothing here runs at
 * import (Script API v2 early execution).
 *
 * What "under attack" means is the simulation's own reading, not a new one: `sim/invasion/director.js`
 * `invasionThreatOf()` - a district with a non-zero `assault` and its `security` at `alert` or worse. The same
 * call also arms the invasion director (`armInvasionDirector`), so the numbers that decide the battle and the
 * entities that fight it are one decision made once per hour. Outcomes still come from `sim/war.js`: these mobs
 * are the fight, not the arithmetic, and no number is read back out of them.
 *
 * Rules this module will not break:
 *  - it never writes a block, ever. It reads columns to find a standable place to stand, and that is all;
 *  - it never spawns inside any district's protected footprint. The geometry is the pack's own
 *    (`commands/civ.js` `protectedRects` + `civBuilder.js` `inProtectedArea` over the stored master plan), so a
 *    wall the builder laid is a wall the attackers have to come at from outside;
 *  - the band is small and capped (see SIEGE_DEFAULTS), whatever the assault number claims;
 *  - `SIEGE_REFUSED_TYPES` is a refusal list, not advice: a creeper, enderman or vex is never selected, from
 *    whatever config, threat or wave the hour describes;
 *  - identity is the tag, not memory. After a world reload the band is found by census, so it is neither
 *    doubled nor orphaned, and a district whose record has vanished has its mobs removed.
 *
 * Movement is not this module's job: there is no pathfinding request, no navigation and no velocity setter in
 * Script API v2.7.0. Pillagers advance on their own AI, and the garrison a district loses is `war.js`'s business.
 * The two levers used here are where a mob is put and which way it looks on spawn.
 *
 * Deliberately NOT waited for: the director's `wave.physical` flag, which is set from player proximity. The
 * brief is a siege with no player involvement, so the war state alone decides.
 *
 * @typedef {any} DimensionLike
 * @typedef {any} Kingdom
 * @typedef {{ x: number, y: number, z: number, water: boolean, surface: string, class: string }} Column
 * @typedef {{ districtId: string, districtName: string, assault: number, desired: number, brutes: number,
 *   large: boolean, centre: { x: number, z: number }, bearing: string, reason: string, reach: number }} BandOrder
 */

/** Namespace marker: the one tag every attacker carries, and so the one query that finds the whole band. */
export const SIEGE_TAG = "civbesiege:v1";

/** Per-district tag: `civbesiege:v1:<districtId>`, which is what makes a census groupable after a reload. */
export const SIEGE_TAG_PREFIX = "civbesiege:v1:";

/**
 * NEVER spawned, in any numbers, from any config or threat. This is a refusal list in code, not prose:
 *  - `minecraft:creeper`: it detonates. The wall it would open is the one the pack just spent 15 minutes
 *    laying block by block, and `sim/war.js` has not decided anything was breached.
 *  - `minecraft:enderman`: it picks blocks up, so a district's masonry walks away overnight.
 *  - `minecraft:vex`: it phases through walls, which moves the fight inside the district instead of at it.
 * Nothing that touches blocks belongs here; `minecraft:ravager` is left out of the roster for the same reason.
 */
export const SIEGE_REFUSED_TYPES = Object.freeze([
    "minecraft:creeper",
    "minecraft:enderman",
    "minecraft:vex",
]);

/** The vanilla last-resort type. Not on the refusal list, and never replaced by config. */
const FALLBACK_TYPE = "minecraft:pillager";

/**
 * LOCAL tunables (config.js is another phase's file; sim/war.js keeps the same convention).
 * `maxPerDistrict` and `maxTotal` are hard: an hour may bring a band up to them, never past.
 */
export const SIEGE_DEFAULTS = Object.freeze({
    /** a few entities per attacked district - this is a siege to see, not a lag spike */
    maxPerDistrict: 6,
    /** hard ceiling across the kingdom, shared out in district-id order */
    maxTotal: 12,
    /** raider-equivalent assault (`district.assault`) each attacker stands for */
    assaultPerAttacker: 4,
    /** assault at or above which the force counts as large, and a vindicator may join it */
    largeForceAssault: 12,
    /** how many of a district's band may be vindicators */
    maxVindicators: 2,
    /** blocks past the protected footprint the band forms up at, before searching outward */
    standoff: 4,
    /** and no further out than this many blocks from the wall line */
    maxOffWall: 40,
    /** radius steps (blocks) between the outward rings of the search */
    radiusStep: 2,
    /** lateral offsets tried within a ring, in blocks, and how many each side */
    lateralGap: 3,
    lateralSteps: 5,
    /** blocks of vegetation a column probe may walk down through before it gives up */
    maxClearSteps: 6,
    /** columns a district may be asked about per hour; the cheap protection test rejects most of them */
    maxCandidates: 240,
    /** block reads spent per district per hour - the expensive half of the search, and what really bounds it */
    maxProbes: 72,
    /** the roster. Terrain picks which of these three a column gets; `large` picks the fourth. */
    types: Object.freeze({
        raider: "minecraft:pillager",
        desert: "minecraft:husk",
        water: "minecraft:drowned",
        large: "minecraft:vindicator",
    }),
});

/** Approach bearings as unit vectors. Bedrock: north is -Z, east is +X. Keys are composition.js BEARINGS. */
export const BEARING_VECTORS = /** @type {Record<string, Readonly<{ x: number, z: number }>>} */ (Object.freeze({
    north: Object.freeze({ x: 0, z: -1 }),
    "north-east": Object.freeze({ x: 1, z: -1 }),
    east: Object.freeze({ x: 1, z: 0 }),
    "south-east": Object.freeze({ x: 1, z: 1 }),
    south: Object.freeze({ x: 0, z: 1 }),
    "south-west": Object.freeze({ x: -1, z: 1 }),
    west: Object.freeze({ x: -1, z: 0 }),
    "north-west": Object.freeze({ x: -1, z: -1 }),
}));

/** Block kinds vegetation: a column whose top is one of these is probed one block lower. */
const CLEARABLE = Object.freeze(["tree", "cover"]);

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toInt(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
    if (!(value > min)) {
        return min;
    }
    return value > max ? max : value;
}

/**
 * @param {string} districtId
 * @returns {string}
 */
export function siegeTagFor(districtId) {
    return `${SIEGE_TAG_PREFIX}${String(districtId)}`;
}

/**
 * Which district does a set of tags claim? Null when the tags are not ours at all (never ours to touch),
 * "" when the namespace tag is there but the district half is missing (a malformed leftover, so an orphan).
 *
 * @param {Iterable<string>} tags
 * @returns {string | null}
 */
export function districtOfTags(tags) {
    const list = [...tags];
    if (!list.includes(SIEGE_TAG)) {
        return null;
    }
    for (const tag of list) {
        if (tag.startsWith(SIEGE_TAG_PREFIX)) {
            return tag.slice(SIEGE_TAG_PREFIX.length);
        }
    }
    return "";
}

/**
 * A stable district ordering, so the kingdom-wide cap is shared out the same way every hour.
 * @param {string[]} ids
 */
function sortedIds(ids) {
    return ids.slice().sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * A deterministic bearing when the director has not named one: the district's own id, so a band does not
 * rotate around the walls every hour.
 *
 * @param {string} districtId
 * @returns {string}
 */
export function bearingOf(districtId) {
    let sum = 0;
    const text = String(districtId);
    for (let index = 0; index < text.length; index += 1) {
        sum += text.charCodeAt(index);
    }
    return BEARINGS[sum % BEARINGS.length];
}

/**
 * The direction the siege is coming from, as the director states it: the wave's bearing, else its wall section,
 * else the district's own fixed bearing.
 *
 * @param {any} district
 * @param {any} wave
 * @returns {string}
 */
function bearingFor(district, wave) {
    if (isObject(wave) && String(wave.districtId) === String(district?.id)) {
        if (BEARINGS.includes(String(wave.bearing))) {
            return String(wave.bearing);
        }
        const section = wave.target?.section;
        if (typeof section === "string" && BEARINGS.includes(section)) {
            return section;
        }
    }
    return bearingOf(String(district?.id ?? "district"));
}

/**
 * Yaw (degrees) that faces `target` from `from`. Bedrock: 0 = +Z (south), 90 = -X (west).
 * @param {{ x: number, z: number }} from
 * @param {{ x: number, z: number }} target
 */
function yawTowards(from, target) {
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    if (dx === 0 && dz === 0) {
        return 0;
    }
    return (((Math.atan2(-dx, dz) * 180) / Math.PI) % 360 + 360) % 360;
}

/* ------------------------------------------------------------------ *
 * Type selection, with the refusal list in front of everything
 * ------------------------------------------------------------------ */

/**
 * @param {string} typeId
 * @returns {boolean} true when nothing may ever stand this type
 */
export function isRefusedType(typeId) {
    return SIEGE_REFUSED_TYPES.includes(String(typeId));
}

/**
 * Resolve a proposed type against the refusal list. A refused candidate falls back - to the ordinary raider
 * type, then to the vanilla pillager - and if even that is refused nothing is returned at all, so config cannot
 * put a creeper in the world by naming it three times over.
 *
 * @param {unknown} proposed
 * @param {any} config
 * @returns {string | null}
 */
export function spawnableType(proposed, config) {
    const candidates = [String(proposed ?? ""), String(config?.types?.raider ?? ""), FALLBACK_TYPE];
    for (const candidate of candidates) {
        if (candidate.startsWith("minecraft:") && !isRefusedType(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * The roster, from the ground the approach actually has: water means drowned, desert-class ground means husks,
 * anything else means pillagers; a large force may put a vindicator in front of it.
 *
 * @param {Column | null} column
 * @param {boolean} wantsLarge
 * @param {any} config
 * @returns {string | null}
 */
export function attackerTypeFor(column, wantsLarge, config) {
    if (column === null || column === undefined) {
        return null;
    }
    if (wantsLarge) {
        return spawnableType(config?.types?.large, config);
    }
    if (column.water === true) {
        return spawnableType(config?.types?.water, config);
    }
    if (column.class === "desert") {
        return spawnableType(config?.types?.desert, config);
    }
    return spawnableType(config?.types?.raider, config);
}

/* ------------------------------------------------------------------ *
 * Numbers: how many, and how big a force
 * ------------------------------------------------------------------ */

/**
 * What the simulation's numbers ask for at one district. `district.assault` is raider-equivalents on the ground
 * (the same unit the director lands waves in), so the band scales with the threat and then hits its cap.
 *
 * @param {any} district
 * @param {any} wave the director's band, when it is pointed at this district
 * @param {any} config
 * @returns {{ assault: number, desired: number, brutes: number, large: boolean }}
 */
export function bandFor(district, wave, config) {
    const assault = toInt(district?.assault);
    if (assault <= 0) {
        return { assault, desired: 0, brutes: 0, large: false };
    }
    const fromWar = Math.ceil(assault / Math.max(1, toInt(config.assaultPerAttacker)));
    const fromWave = isObject(wave) && String(wave.districtId) === String(district?.id)
        ? toInt(wave.strikes?.[wave.strike]?.counts?.raider) + toInt(wave.strikes?.[wave.strike]?.counts?.archer)
        : 0;
    const wanted = Math.max(fromWar, fromWave > 0 ? Math.min(fromWave, toInt(config.maxPerDistrict)) : 0);
    const desired = clamp(wanted, 1, toInt(config.maxPerDistrict));
    const large = assault >= toInt(config.largeForceAssault) || (isObject(wave) && String(wave.kind) === "major" && String(wave.districtId) === String(district?.id));
    const deliveredBrutes = isObject(wave) && String(wave.districtId) === String(district?.id) ? toInt(wave.delivered?.brute) : 0;
    const brutes = large ? clamp(Math.max(1, deliveredBrutes), 1, toInt(config.maxVindicators)) : 0;
    return { assault, desired, brutes, large };
}

/* ------------------------------------------------------------------ *
 * Geometry: where a band stands up
 * ------------------------------------------------------------------ */

/**
 * The district's own physical record, as the pack stores it: a civilization build record with a centre, or a
 * prototype layout with an origin. A district the simulation has never built has neither, and there is no wall
 * to attack and no ground to stand on, so nothing is asked for.
 *
 * @param {any} district
 * @returns {{ x: number, z: number, source: string } | null}
 */
export function physicalCentreOf(district) {
    const centre = district?.civ?.centre;
    if (isObject(centre) && Number.isInteger(centre.x) && Number.isInteger(centre.z)) {
        return { x: centre.x, z: centre.z, source: district?.civ?.status === "complete" ? "civilization build record" : "civilization build (under way)" };
    }
    const origin = district?.physical?.origin;
    if (isObject(origin) && Number.isInteger(origin.x) && Number.isInteger(origin.z)) {
        return { x: origin.x, z: origin.z, source: "prototype layout" };
    }
    return null;
}

/**
 * The outline the wall was laid along, from the stored master plan - the same outline `protectedRects` grows into
 * a protected footprint. Undefined for a world with no plan, where the footprint rectangles decide on their own.
 *
 * @param {any} plan
 * @param {any} district
 * @returns {[number, number][] | undefined}
 */
function outlineOf(plan, district) {
    const index = Number(String(district?.id ?? "").replace(/^district-/, ""));
    const entry = Array.isArray(plan?.districts) ? plan.districts.find((/** @type {any} */ one) => Number(one?.index) === index) : undefined;
    return Array.isArray(entry?.outline) && entry.outline.length > 2 ? /** @type {[number, number][]} */ (entry.outline) : undefined;
}

/**
 * How far the protected footprint reaches from the centre in the direction of attack. Derived from the
 * production geometry rather than a re-typed wall thickness, so a thicker band pushes the band further out
 * automatically.
 *
 * @param {any[]} areas
 * @param {{ x: number, z: number }} centre
 * @param {{ x: number, z: number }} dir
 * @param {[number, number][] | undefined} outline
 * @returns {number}
 */
function wallReach(areas, centre, dir, outline) {
    let reach = 0;
    for (const area of areas) {
        if (centre.x < area.x0 || centre.x > area.x1 || centre.z < area.z0 || centre.z > area.z1) {
            continue;
        }
        const ex = dir.x > 0 ? area.x1 - centre.x : dir.x < 0 ? centre.x - area.x0 : 0;
        const ez = dir.z > 0 ? area.z1 - centre.z : dir.z < 0 ? centre.z - area.z0 : 0;
        reach = Math.max(reach, Math.abs(ex), Math.abs(ez));
    }
    if (outline !== undefined) {
        for (const point of outline) {
            const dx = Math.abs(point[0] - centre.x);
            const dz = Math.abs(point[1] - centre.z);
            reach = Math.max(reach, dir.x !== 0 ? dx : 0, dir.z !== 0 ? dz : 0);
        }
    }
    return reach;
}

/**
 * The columns a band may form up on, in the order they are tried: outward rings from the wall, each ring swept
 * from the bearing's centreline outwards. Bounded by `maxProbes`, and every column is re-checked against the
 * protected footprints before it is read, so a candidate is never inside a district's land.
 *
 * @param {{ x: number, z: number }} centre
 * @param {string} bearing
 * @param {number} reach
 * @param {any} config
 * @returns {{ x: number, z: number }[]}
 */
function candidateColumns(centre, bearing, reach, config) {
    const dir = BEARING_VECTORS[bearing] ?? BEARING_VECTORS.north;
    const length = Math.hypot(dir.x, dir.z) || 1;
    const bx = dir.x / length;
    const bz = dir.z / length;
    const lateral = { x: -bz, z: bx };
    const gap = Math.max(1, toInt(config.lateralGap));
    const steps = toInt(config.lateralSteps);
    /** @type {{ x: number, z: number }[]} */
    const spots = [];
    const offsets = [];
    for (let index = 0; index <= steps; index += 1) {
        offsets.push(index * gap);
        if (index > 0) {
            offsets.push(-index * gap);
        }
    }
    const first = reach + Math.max(1, toInt(config.standoff));
    const last = reach + Math.max(first, toInt(config.maxOffWall));
    const step = Math.max(1, toInt(config.radiusStep));
    for (let radius = first; radius <= last && spots.length < toInt(config.maxCandidates); radius += step) {
        for (const side of offsets) {
            if (spots.length >= toInt(config.maxCandidates)) {
                break;
            }
            spots.push({
                x: Math.round(centre.x + bx * radius + lateral.x * side),
                z: Math.round(centre.z + bz * radius + lateral.z * side),
            });
        }
    }
    return spots;
}

/**
 * Read one column: what stands on it, and whether a mob can stand there. Vegetation is walked down through;
 * lava, an unreadable chunk and a column with a roof over it are refused. Water is not refused - it is where a
 * drowned is posted.
 *
 * Reads only: nothing here writes a block, and the fake world proves that.
 *
 * @param {DimensionLike} dimension
 * @param {number} x
 * @param {number} z
 * @param {any} config
 * @returns {Column | null}
 */
export function columnAt(dimension, x, z, config) {
    let top;
    try {
        top = dimension.getTopmostBlock({ x, z });
    } catch (_error) {
        return null;
    }
    if (top === undefined || top === null) {
        return null;
    }
    let y = Math.floor(Number(top.location?.y));
    let id = String(top.typeId);
    if (!Number.isFinite(y)) {
        return null;
    }
    for (let step = 0; step < toInt(config.maxClearSteps); step += 1) {
        if (!CLEARABLE.includes(classifyBlock(id).kind)) {
            break;
        }
        let below;
        try {
            below = dimension.getBlock({ x, y: y - 1, z });
        } catch (_error) {
            return null;
        }
        if (below === undefined || below === null) {
            return null;
        }
        y -= 1;
        id = String(below.typeId);
    }

    const info = classifyBlock(id);
    if (info.kind === "lava") {
        return null;
    }
    if (info.kind === "water") {
        return { x, y, z, water: true, surface: id, class: "water" };
    }

    for (const headroom of [y + 1, y + 2]) {
        let cell;
        try {
            cell = dimension.getBlock({ x, y: headroom, z });
        } catch (_error) {
            return null;
        }
        if (cell === undefined || cell === null) {
            return null;
        }
        const kind = classifyBlock(String(cell.typeId)).kind;
        if (kind !== "air" && kind !== "cover") {
            return null;
        }
    }
    return { x, y: y + 1, z, water: false, surface: id, class: info.class ?? "bare" };
}

/* ------------------------------------------------------------------ *
 * Census: who is already standing here
 * ------------------------------------------------------------------ */

/**
 * @param {any} handle
 * @returns {boolean}
 */
function isUsable(handle) {
    try {
        return handle !== undefined && handle !== null && handle.isValid !== false;
    } catch (_error) {
        return false;
    }
}

/**
 * The tags a handle carries, or nothing at all when the handle has gone: an unreadable tag list is never
 * treated as "not ours".
 *
 * @param {any} handle
 * @returns {string[]}
 */
function tagTextOf(handle) {
    try {
        return [...handle.getTags()];
    } catch (_error) {
        return [];
    }
}

/**
 * The type a handle reports, or a phrase saying it no longer answers: a note must never be the thing that
 * throws out of an hour.
 *
 * @param {any} handle
 * @returns {string}
 */
function typeTextOf(handle) {
    try {
        return String(handle.typeId);
    } catch (_error) {
        return "an entity that has already gone";
    }
}

/**
 * @param {any} handle
 * @param {any} config
 * @returns {boolean}
 */
function isLargeUnit(handle, config) {
    try {
        return String(handle.typeId) === String(config.types.large);
    } catch (_error) {
        return false;
    }
}

/**
 * The column a handle stands on, as the key that keeps two attackers out of the same block.
 * @param {any} handle
 */
function columnKeyOf(handle) {
    try {
        const at = handle.location;
        return `${String(Math.floor(at.x))},${String(Math.floor(at.z))}`;
    } catch (_error) {
        return "";
    }
}

/**
 * Find our own mobs by census - the only route that survives a world reload, because `world.afterEvents`
 * reports a removed entity's id and nothing else, and a fresh process holds no handles.
 *
 * @param {DimensionLike} dimension
 * @param {any} notes
 * @returns {Map<string, any[]>} district id ("" for an orphan) to handles
 */
function censusOf(dimension, notes) {
    /** @type {Map<string, any[]>} */
    const grouped = new Map();
    let found;
    try {
        found = /** @type {any[]} */ (dimension.getEntities({ tags: [SIEGE_TAG] }));
    } catch (error) {
        notes.push(`the siege census could not be read: ${String(error)}`);
        return grouped;
    }
    for (const handle of found) {
        const districtId = districtOfTags(tagTextOf(handle));
        if (districtId === null) {
            // Not ours after all: a foreign entity that happens to share a word. Never touched.
            continue;
        }
        const list = grouped.get(districtId) ?? [];
        list.push(handle);
        grouped.set(districtId, list);
    }
    for (const [districtId, list] of grouped) {
        list.sort((left, right) => (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0));
        if (districtId === "") {
            notes.push(`${String(list.length)} attacker(s) carry the siege tag without a district: they are orphans, and go.`);
        }
    }
    return grouped;
}

/**
 * Send a list of our own mobs away. Re-reads the tags first, so a mob that has been retagged (picked up by
 * another system, or transformed by the game) is left alone rather than deleted under someone else's name.
 *
 * @param {any[]} handles
 * @param {any} notes
 * @param {string} reason
 * @returns {number} removed
 */
function retire(handles, notes, reason) {
    let removed = 0;
    for (const handle of handles) {
        if (!isUsable(handle)) {
            continue;
        }
        if (districtOfTags(tagTextOf(handle)) === null) {
            notes.push(`an entity in the census is no longer ours (${typeTextOf(handle)}); left in place`);
            continue;
        }
        try {
            handle.remove();
            removed += 1;
        } catch (error) {
            notes.push(`could not send an attacker away (${reason}): ${String(error)}`);
        }
    }
    return removed;
}

/**
 * Every attacker in the world, ours, gone: the gate closing or the war ending.
 * @param {DimensionLike} dimension
 * @param {any} notes
 * @param {string} reason
 */
function retireEverywhere(dimension, notes, reason) {
    return retire([...censusOf(dimension, notes).values()].flat(), notes, reason);
}

/**
 * Retire everything of ours and put the teardown in one line, with its count, so `civ:people status` and a dev
 * probe can say what the hour did rather than that it did something.
 *
 * @param {DimensionLike} dimension
 * @param {string[]} notes
 * @param {string} reason
 * @returns {number}
 */
function sweep(dimension, notes, reason) {
    const cleared = retireEverywhere(dimension, notes, reason);
    if (cleared > 0) {
        notes.push(`${String(cleared)} attacker(s) sent away: ${reason}`);
    }
    return cleared;
}

/* ------------------------------------------------------------------ *
 * The driver
 * ------------------------------------------------------------------ */

/**
 * @param {any} value
 * @returns {boolean}
 */
function looksLikeStore(value) {
    return isObject(value) && typeof value.load === "function" && typeof value.save === "function";
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function looksLikeDimension(value) {
    return (
        isObject(value) &&
        typeof value.getEntities === "function" &&
        typeof value.spawnEntity === "function" &&
        typeof value.getTopmostBlock === "function"
    );
}

/**
 * Builds the `siege` driver for `integration/peopleRuntime.js`.
 *
 * Dependency injection (all optional - the registration line in main.js needs none of it):
 *   kingdomStore   where the armed invasion record is saved; defaults to a store over `ctx.world`
 *   config         overrides for SIEGE_DEFAULTS, including `types`. Every type still passes the refusal list.
 *   readPlan       () => the stored master plan; defaults to civBuilder.loadMasterPlan()
 *   arm            (kingdom, threat) => verdict; defaults to director.armInvasionDirector
 *   checkPeopleGate false skips the `civ:people` re-check (for a caller that has already gated)
 *
 * @param {any} [deps] a kingdom store, or { kingdomStore, config, readPlan, arm, checkPeopleGate }
 */
export function createSiegeDriver(deps = {}) {
    const options = looksLikeStore(deps) ? { kingdomStore: deps } : deps;
    /** @type {any} */
    const config = {
        ...SIEGE_DEFAULTS,
        ...(isObject(options?.config) ? options.config : {}),
        types: { ...SIEGE_DEFAULTS.types, ...(isObject(options?.config?.types) ? options.config.types : {}) },
    };
    const readPlan = typeof options.readPlan === "function" ? options.readPlan : () => loadMasterPlan().plan;
    const arm = typeof options.arm === "function" ? options.arm : armInvasionDirector;
    const checkPeopleGate = options.checkPeopleGate !== false;
    const explicitStore = looksLikeStore(options.kingdomStore) ? options.kingdomStore : undefined;

    /** @type {any} */
    let last = { ran: 0, armed: false, threat: null, districts: [], created: 0, removed: 0, notes: [], reason: "has not run yet" };

    /**
     * Arm the invasion director on the saved kingdom, and only write when the arming actually changed it.
     * The hour's decision comes from `ctx.kingdom`; this persists it so the next hour's tick runs a director
     * that exists. Refuses to save a kingdom the validator would reject, and a failed write is a note, not a
     * thrown error: the tick must survive it.
     *
     * @param {any} world
     * @param {{ threatened: boolean, assault: number, districtIds: string[] }} threat
     * @param {string[]} notes
     */
    function persistArming(world, threat, notes) {
        if (typeof arm !== "function") {
            return { armed: false, changed: false, reason: "arming is not available" };
        }
        const store = explicitStore ?? (isObject(world) ? createKingdomStore(world) : undefined);
        if (store === undefined) {
            notes.push("no world to read the kingdom from, so the invasion director was not armed");
            return { armed: false, changed: false, reason: "no world" };
        }
        try {
            const loaded = store.load();
            if (loaded.kingdom === undefined) {
                return { armed: false, changed: false, reason: `no readable kingdom save (${String(loaded.status)})` };
            }
            const verdict = arm(loaded.kingdom, threat);
            if (verdict.changed !== true) {
                return verdict;
            }
            const problems = findValidationProblems(loaded.kingdom);
            if (problems.length > 0) {
                notes.push(`the armed kingdom would not save, so nothing was written: ${problems[0]}`);
                return { ...verdict, changed: false, reason: `not saved: ${problems[0]}` };
            }
            store.save(loaded.kingdom);
            notes.push(`invasion director ${verdict.armed === true ? "armed" : "stood down"} (${verdict.reason})`);
            return { ...verdict, saved: true };
        } catch (error) {
            notes.push(`the invasion director could not be armed: ${String(error)}`);
            return { armed: false, changed: false, reason: String(error) };
        }
    }

    /**
     * One attacker, put where the approach allows it to stand and pointed at the district.
     *
     * @param {DimensionLike} dimension
     * @param {BandOrder} order
     * @param {Column} column
     * @param {string} typeId
     * @param {string[]} notes
     * @returns {boolean}
     */
    function spawnOne(dimension, order, column, typeId, notes) {
        const rotation = yawTowards(order.centre, column);
        let entity;
        try {
            entity = dimension.spawnEntity(typeId, { x: column.x + 0.5, y: column.y, z: column.z + 0.5 }, {
                initialPersistence: true,
                initialRotation: rotation,
            });
        } catch (error) {
            notes.push(`${order.districtId}: no attacker could be placed at ${String(column.x)}, ${String(column.y)}, ${String(column.z)}: ${String(error)}`);
            return false;
        }
        // Tag it before anything else: an untagged mob is an orphan no census will ever find again.
        try {
            const namespaceTagged = entity.addTag(SIEGE_TAG) === true;
            const districtTagged = entity.addTag(siegeTagFor(order.districtId)) === true;
            if (!namespaceTagged || !districtTagged) {
                throw new Error("the siege tags were refused");
            }
            entity.nameTag = `Besieger of ${String(order.districtName ?? order.districtId)}`;
        } catch (error) {
            try {
                entity.remove();
                notes.push(`${order.districtId}: an attacker was rolled back because it could not be tagged: ${String(error)}`);
            } catch (_inner) {
                notes.push(`${order.districtId}: an attacker is untagged and cannot be rolled back: ${String(error)}`);
            }
            return false;
        }
        return true;
    }

    /**
     * One hour of the siege.
     * @param {any} ctx
     * @returns {number} entities created or removed
     */
    function onHour(ctx) {
        /** @type {string[]} */
        const notes = [];
        const kingdom = ctx?.kingdom;
        const dimension = ctx?.dimension;
        // The runtime hands every driver its world; the fallback is the same object it read them from, so a
        // caller that forgets to pass one still gets gated against the live world rather than an unguarded one.
        const world = ctx?.world ?? runtimeWorld;
        if (!looksLikeDimension(dimension)) {
            last = { ran: last.ran + 1, armed: false, threat: null, districts: [], created: 0, removed: 0, notes: ["no dimension to place a siege in"], reason: "refused" };
            return 0;
        }
        if (!isObject(kingdom)) {
            last = { ran: last.ran + 1, armed: false, threat: null, districts: [], created: 0, removed: 0, notes: ["no kingdom records"], reason: "refused" };
            return 0;
        }

        // The runtime hands every driver its teardown hour: `ctx.gateOn` is false while `civ:people` is off,
        // because 2.7.0 gives no removal event to clean up after. Off means "remove what is yours, spawn nothing".
        // A caller that passes no verdict at all is read against the world directly, so a driver reached outside
        // the runtime still cannot fill a world the operator switched off.
        const gateOn = ctx === undefined || ctx === null || ctx.gateOn === undefined ? peopleGateOn(world) : ctx.gateOn === true;
        if (checkPeopleGate && !gateOn) {
            const cleared = sweep(dimension, notes, "the people gate is off");
            last = { ran: last.ran + 1, armed: false, threat: null, districts: [], created: 0, removed: cleared, notes, reason: "civ:people is off" };
            return cleared;
        }

        const threat = invasionThreatOf(kingdom);
        const armed = persistArming(world, threat, notes);

        if (threat.threatened !== true) {
            const cleared = sweep(dimension, notes, "no district is under attack");
            last = { ran: last.ran + 1, armed: armed.armed === true, threat, districts: [], created: 0, removed: cleared, notes, reason: "no district is under attack" };
            return cleared;
        }

        let plan;
        try {
            plan = readPlan();
        } catch (error) {
            notes.push(`the master plan could not be read: ${String(error)}`);
        }
        /** @type {any[]} */
        let areas = [];
        let areasRead = true;
        try {
            // exceptIndex 0 names no district, so every district's land - this one's included - is off limits.
            areas = protectedRects(kingdom, PROTECT_MARGIN, plan, WRITE_PROTECT_GROW, 0);
        } catch (error) {
            // No protection list means no right to place anything: an empty list would read as "everything is
            // open ground", and an attacker standing inside a district is exactly the failure this layer has.
            areasRead = false;
            notes.push(`the protected footprints could not be read, so nothing was placed this hour: ${String(error)}`);
        }

        const census = censusOf(dimension, notes);
        const wave = isObject(kingdom.invasion) && kingdom.invasion.enabled === true ? kingdom.invasion.wave : null;
        const districtNameOf = (/** @type {string} */ id) => String(districtById(kingdom, id)?.name ?? id);

        /** @type {Map<string, BandOrder>} */
        const orders = new Map();
        /** @type {Set<string>} */
        const unbuilt = new Set();
        /** @type {Array<{ districtId: string, assault: number, desired: number, present: number, created: number, removed: number, bearing: string, reason: string }>} */
        const rows = [];
        let created = 0;
        let removed = 0;

        for (const districtId of sortedIds(threat.districtIds)) {
            const district = districtById(kingdom, districtId);
            const centre = physicalCentreOf(district);
            if (centre === null) {
                // No physical record: nothing was ever built here, so there is no wall to attack and no ground
                // outside it to form up on. Nothing is asked for, and anything of ours there already goes.
                unbuilt.add(districtId);
                rows.push({ districtId, assault: toInt(district?.assault), desired: 0, present: (census.get(districtId) ?? []).length, created: 0, removed: 0, bearing: "-", reason: "no physical record: this district has never been built" });
                continue;
            }
            const asked = bandFor(district, wave, config);
            const bearing = bearingFor(district, wave);
            const dir = BEARING_VECTORS[bearing] ?? BEARING_VECTORS.north;
            orders.set(districtId, {
                districtId,
                districtName: districtNameOf(districtId),
                assault: asked.assault,
                desired: asked.desired,
                brutes: asked.brutes,
                large: asked.large,
                centre: { x: centre.x, z: centre.z },
                bearing,
                reason: `assault ${String(asked.assault)} against ${String(district?.security ?? "secure")} (${centre.source})`,
                reach: wallReach(areas, centre, dir, outlineOf(plan, district)),
            });
        }

        // Anything of ours that this hour no longer asked for goes: a repelled district, a district that has
        // lost its physical record, a district that has left the kingdom's records entirely, and any orphan.
        for (const [districtId, handles] of census) {
            if (orders.has(districtId)) {
                continue;
            }
            const gone = retire(handles, notes, districtId === "" ? "no district on its tag" : `no siege at ${districtId}`);
            removed += gone;
            if (districtId === "") {
                continue;
            }
            if (districtById(kingdom, districtId) === undefined) {
                notes.push(`${districtId}: its district record has gone, and its ${String(gone)} attacker(s) went with it`);
            } else if (unbuilt.has(districtId)) {
                notes.push(`${districtId}: never had a physical record, so its ${String(gone)} attacker(s) have no wall to be attacking`);
            } else {
                notes.push(`${districtId}: the attack is over - ${String(gone)} attacker(s) sent away`);
            }
        }

        // Share out what is left of the kingdom-wide cap, in district-id order: trim, then top up.
        let budget = toInt(config.maxTotal);
        for (const districtId of sortedIds([...orders.keys()])) {
            const order = /** @type {any} */ (orders.get(districtId));
            const present = (census.get(districtId) ?? []).filter(isUsable);
            const allowed = Math.min(order.desired, Math.max(0, budget));
            const row = { districtId, assault: order.assault, desired: order.desired, present: present.length, created: 0, removed: 0, bearing: order.bearing, reason: order.reason };
            rows.push(row);

            /** @type {any[]} */
            let standing = present;
            if (present.length > allowed) {
                // Excess vindicators go first (a force that is no longer large loses its brute before its rank),
                // then the tail of the band in id order.
                const excess = present.length - allowed;
                const vindicators = present.filter((handle) => isLargeUnit(handle, config));
                /** @type {any[]} */
                const drops = vindicators.slice(0, Math.min(excess, vindicators.length));
                if (drops.length < excess) {
                    drops.push(...present.filter((handle) => !drops.includes(handle)).slice(0, excess - drops.length));
                }
                const gone = retire(drops, notes, `${districtId} is over its band`);
                removed += gone;
                row.removed += gone;
                row.present = present.length - gone;
                standing = present.filter((handle) => !drops.includes(handle));
            }

            budget = Math.max(0, budget - standing.length);
            let vindicators = standing.filter((handle) => isLargeUnit(handle, config)).length;
            const want = allowed - standing.length;
            if (want > 0) {
                row.reason = `${row.reason}; ${String(want)} to bring up`;
            }

            const used = new Set(standing.map((handle) => columnKeyOf(handle)));
            /** @type {Map<string, Column | null>} */
            const probed = new Map();
            for (const spot of want > 0 && areasRead ? candidateColumns(order.centre, order.bearing, order.reach, config) : []) {
                if (standing.length + row.created >= allowed) {
                    break;
                }
                if (probed.size >= toInt(config.maxProbes)) {
                    notes.push(`${districtId}: the column search stopped at ${String(config.maxProbes)} probes`);
                    break;
                }
                const key = `${String(spot.x)},${String(spot.z)}`;
                if (used.has(key) || inProtectedArea(areas, spot.x, spot.z)) {
                    continue;
                }
                if (!probed.has(key)) {
                    probed.set(key, columnAt(dimension, spot.x, spot.z, config));
                }
                const column = /** @type {Column | null} */ (probed.get(key));
                if (column === null) {
                    continue;
                }
                const asBrute = vindicators < Math.min(order.brutes, toInt(config.maxVindicators));
                const typeId = attackerTypeFor(column, asBrute, config);
                if (typeId === null) {
                    notes.push(`${districtId}: every proposed attacker type is on the refusal list, so nothing was spawned`);
                    break;
                }
                if (spawnOne(dimension, order, column, typeId, notes)) {
                    used.add(key);
                    row.created += 1;
                    created += 1;
                    budget = Math.max(0, budget - 1);
                    if (asBrute) {
                        vindicators += 1;
                    }
                    if (column.water === true || column.class === "desert") {
                        row.reason = `${row.reason}; ${column.water === true ? "the shallows" : "sand"} took ${String(typeId)}`;
                    }
                }
            }
            if (standing.length + row.created < allowed) {
                notes.push(`${districtId}: only ${String(standing.length + row.created)} of ${String(allowed)} attackers could be placed - no more standable ground outside the wall`);
            }
        }

        last = { ran: last.ran + 1, armed: armed.armed === true, arming: armed, threat, districts: rows, created, removed, notes, reason: `${String(threat.districtIds.length)} district(s) pressed` };
        return created + removed;
    }

    return {
        id: "siege",
        onHour,
        /** What the last hour did, for `civ:people status` and for a dev probe. */
        status: () => last,
        config,
    };
}
