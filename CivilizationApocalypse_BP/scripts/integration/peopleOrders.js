import { world as runtimeWorld } from "@minecraft/server";
import { protectedRects } from "../commands/civ.js";
import { BEARINGS } from "../sim/invasion/composition.js";
import { invasionThreatOf } from "../sim/invasion/director.js";
import { hourOf } from "../sim/clock.js";
import { peopleGateOn } from "../people/gate.js";
import { assignCommanders, commandProblems, commandersFor } from "../people/command.js";
import { PATROL_RULES, planPatrols } from "../people/patrols.js";
import { loadMasterPlan } from "./civBuilder.js";
import { BEARING_VECTORS, SIEGE_DEFAULTS, bearingOf, columnAt, physicalCentreOf } from "./siegeMobs.js";

/**
 * The command layer: once an in-game hour, a district's EXISTING levy entities are put on wall duty, rotated
 * between sectors, given their officers, and pulled toward the bearing the attack comes from - so the kingdom
 * posts its troops whether or not a player is watching.
 *
 * It is a `peopleRuntime.js` driver - `{ id: "orders", onHour(ctx) }` - so it runs once per accepted simulation
 * hour, never on the 20-tick path, and never while a district build holds the world. The integrator registers it
 * in main.js; nothing here runs at import (Script API v2 early execution).
 *
 * What it is NOT, and that is the whole design:
 *  - it owns no lives. `integration/peopleStreets.js` creates and removes the kingdom's people; this file only
 *    ever calls `teleport()` and writes `nameTag` on an entity that already carries a `civpop:v1:<district>:sol:<index>`
 *    tag. It never spawns, removes, kills, retags or re-founds anything, and it never touches a `:civ:` entity:
 *    the census asks the dimension for the garrison type (`LEVY_TYPE`) only, so a civilian is not even enumerated;
 *  - it makes no new policy. The circuit, the sector arithmetic and the rotation cadence are `people/patrols.js`;
 *    the officer count is `people/command.js`; the clock is `sim/clock.js`; the wall line is the pack's own
 *    protection geometry (`commands/civ.js` `protectedRects`); the standable ground and the bearings are
 *    `integration/siegeMobs.js`, which solved the same geometry for the attackers. Re-implementing any of them
 *    here would let the orders and the simulation disagree;
 *  - it writes no block, runs no command and saves nothing. No `kingdomStore`, no new dynamic property: an hour
 *    of orders leaves the save byte-identical;
 *  - it is not a movement system. @minecraft/server 2.7.0 has no pathfinding, no navigation and no velocity API,
 *    so a levy is placed ON its post with `teleport()` and told which way to look, and nothing more.
 *
 * The promises it carries through from the pure modules:
 *  - `people/patrols.js`: "Every `rotationSteps` steps the groups move on to the next sector ... so no soldier is
 *    left on the same stretch of wall all day", and "Only the front garrison walks the wall (`garrison.front`);
 *    the reserve stays in the district." Both hold here: the step handed to `planPatrols` is the in-game hour
 *    (`sim/clock.js` `hourOf(kingdom.step)`), and the number of levy put on the wall is the district's front
 *    share of the entities that actually stand in it - the reserve share is left exactly where it is. On top of
 *    the groups' own sector rotation, an individual levy changes group every hour (`(k + hour) mod groups`), so
 *    no entity holds one stretch of wall even within a rotation step.
 *  - `people/command.js`: "A commander with no soldiers is an ERROR state, never a silent zero." When
 *    `assignCommanders` reports that (or `commandProblems` finds anything), the hour does not quietly title
 *    nobody: the problem is put in `status().notes` and the officers are titled from the levy physically on the
 *    wall instead, with a note saying that is what happened.
 *  - `sim/clock.js`: one step is one in-game hour, and `hourOf` is the only notion of time in the pack. The same
 *    hour therefore produces the same posts, twice over: an hour that runs again (a retry, a dev probe) finds
 *    every levy already on its post and moves nothing.
 *
 * Bounds (see ORDERS_DEFAULTS; house style is SIEGE_DEFAULTS in siegeMobs.js and POP_SYNC_DEFAULTS in
 * population/settings.js, and every number is justified there): districts worked, moves per district and per
 * hour, ground probes per district, titles per district and per hour, notes and status rows. A failed teleport is
 * counted and the hour continues; unloaded ground is refused by the engine and caught, never pre-assumed.
 *
 * Interaction the integrator should know about: `peopleStreets.js` names every levy `<district> levy`, and this
 * file names its officers `<district> levy sergeant`. Both write only when the name differs, so an officer costs
 * one name write from streets and one from orders per hour - which is why `orders` is registered AFTER `streets`
 * in main.js (the officer's title is the last word) and why `ORDERS_DEFAULTS.titlesTotal` is small.
 *
 * @typedef {any} DimensionLike
 * @typedef {any} Kingdom
 * @typedef {{ x: number, z: number }} Point
 * @typedef {{ x: number, y: number, z: number, water: boolean, surface: string, class: string }} Column
 * @typedef {{ handle: any, id: string, index: number, groupId: string, districtId: string }} LevyRow
 */

/** The name an officer carries. A player reads the district and the rank, nothing else. */
export const OFFICER_LABEL = "levy sergeant";

/**
 * The garrison's identity tag, exactly as `population/identity.js` writes it: `civpop:v1:<districtId>:sol:<index>`.
 *
 * This layer restates it, and the garrison's entity type below, because the pack keeps exactly ONE door from the
 * runtime to the population reducer - `dev/test/population-sync.test.mjs` asserts that only the gated streets
 * driver may import `population/` - and the orders layer is not that door. It reads the tag as data, never writes
 * one. `dev/test/people-orders.test.mjs` pins both restatements against the real
 * `tagFor(groupIdOf(...))`, `POP_TAG_PREFIX`, `POP_ENTITY_TYPES` and `POP_DISTRICT_OBSERVE_RADIUS`, so what is
 * duplicated here cannot drift: a change on the population side fails that test, not a live world.
 */
const LEVY_TAG = /^civpop:v1:([^:]+):sol:(0|[1-9][0-9]{0,5})$/;

/** `POP_ENTITY_TYPES.sol`: the iron golem is the one vanilla entity that fights the pack's raiders. */
export const LEVY_TYPE = "minecraft:iron_golem";

/**
 * LOCAL tunables (config.js is another phase's file; people/patrols.js and sim/war.js keep the same convention).
 * Every one of these is a ceiling for ONE hour, never a target.
 */
export const ORDERS_DEFAULTS = Object.freeze({
    /** The starter kingdom's five districts plus one for expansion: an hour never works more districts than this. */
    maxDistricts: 6,
    /**
     * Moves one district's levy may take in an hour. Equal to `PATROL_RULES.sectionsPerDistrict`: a district can
     * have its whole circuit re-posted in one hour, and never more than one move per stretch of wall.
     */
    movesPerDistrict: PATROL_RULES.sectionsPerDistrict,
    /**
     * Hard ceiling on moves across the kingdom for one hour. `POP_SYNC_DEFAULTS.maxPhysicalPerDistrict` is 8 and
     * `maxPhysicalTotal` is 24, so this is two districts' whole circuits, or two thirds of every person entity the
     * pack will allow to exist - enough to redraw the posts, not enough to look like a migration.
     */
    movesTotal: 16,
    /** Titles per district: `commandersFor()` for a starter district (30 soldiers at 10 per commander is 3). */
    titlesPerDistrict: 3,
    /** Titles across the kingdom for one hour: the same two-districts-worth of work the move cap allows. */
    titlesTotal: 8,
    /**
     * Ground columns read per district. Four probes per move (8 moves), which is what one post needs when the
     * first stretch is roofed or wet - and a fifth of `SIEGE_DEFAULTS.maxProbes`, because a post is known
     * geometry that only has to be validated, not searched for.
     */
    probesPerDistrict: PATROL_RULES.sectionsPerDistrict * 4,
    /** Vegetation depth a column probe walks down through - the same figure the siege layer probes with. */
    maxClearSteps: SIEGE_DEFAULTS.maxClearSteps,
    /** Blocks inside the wall line a post stands at: the wall itself is masonry, not a parapet walk. */
    postInset: 2,
    /** Blocks along the circuit between two levy posted on one section, so no two share a column. */
    postSpacing: 2,
    /** Slides a post may try, outward to either side, before the stretch is given up on. */
    maxPostTries: 4,
    /** A footprint this thin is not a walled district: no posts (see `minWallHalf`). */
    minWallHalf: 6,
    /** And a footprint this wide is a merged or mis-recorded rect, not one district's wall. */
    maxWallHalf: 64,
    /**
     * How far from a district's centre its levy is looked for: `POP_DISTRICT_OBSERVE_RADIUS`, the radius
     * `peopleStreets.js` observes its own people at, restated here for the reason given on `LEVY_TAG` and pinned
     * to it by a test. A levy that has walked further than this is left alone rather than dragged back.
     */
    observeRadius: 48,
    /** Wall sections in the circuit when the district record says no more than the pack's default. */
    sectionsPerDistrict: PATROL_RULES.sectionsPerDistrict,
    /** Within this many blocks of its post a levy counts as already standing there: what makes an hour repeatable. */
    standTolerance: 0.75,
    /** Sections a post is pulled toward the bearing an assault comes from. 0 at peace - and peace is 0 by rule. */
    threatPull: 2,
    /** Notes and status rows one hour may keep, so a huge world cannot grow the report without limit. */
    maxNotes: 12,
    maxRowsPerDistrict: PATROL_RULES.sectionsPerDistrict,
});

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
    return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

/**
 * The topmost-block plus headroom read a column probe needs. `columnAt` is the siege layer's own, so anything
 * that can hold a pillager can hold a levy; a dimension that cannot answer those two reads gets no posts at all.
 * @param {any} value
 * @returns {boolean}
 */
function looksLikeDimension(value) {
    return (
        isObject(value) &&
        typeof value.getEntities === "function" &&
        typeof value.getBlock === "function" &&
        typeof value.getTopmostBlock === "function"
    );
}

/* ------------------------------------------------------------------ *
 * The clock: which hour's orders are these
 * ------------------------------------------------------------------ */

/**
 * The hour the posts are drawn from. `sim/clock.js` `hourOf` on the step the simulation just advanced is the
 * pack's only notion of time, and `advanceKingdom` reports that step in the hour's report, so a driver reached
 * outside the runtime (a dev probe, a command) still reads the same clock the runtime did.
 *
 * @param {any} ctx the hour's people context
 * @returns {number} 0..STEPS_PER_DAY-1, the hour of the day these posts belong to
 */
export function rotationHour(ctx) {
    const candidates = [ctx?.report?.step, ctx?.kingdom?.step];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isFinite(value)) {
            return hourOf(Math.floor(value));
        }
    }
    return 0;
}

/* ------------------------------------------------------------------ *
 * Identity: whose levy is this, and is it ours to move
 * ------------------------------------------------------------------ */

/**
 * The levy this layer may post, read off an entity's tags, or nothing at all.
 *
 * Identity is the tag, and only the tag: a tag in no namespace, an entity claiming someone else's tag, a claim
 * outside the `civpop:v1` version this pack writes, a malformed claim inside it, and a `:civ:` claim all answer
 * `null`, so this layer cannot be made to move a thing it does not recognise. Where an entity claims more than
 * one stretch of the garrison, the lowest index wins, which is what `population/groups.js` would have kept.
 *
 * @param {Iterable<string> | any} tags
 * @returns {{ districtId: string, index: number, groupId: string } | null}
 */
export function levyIdentityOf(tags) {
    const list = typeof tags?.[Symbol.iterator] === "function" ? [...tags] : [];
    /** @type {{ districtId: string, index: number, groupId: string } | null} */
    let claimed = null;
    for (const tag of list) {
        const match = LEVY_TAG.exec(String(tag));
        if (match === null) {
            continue;
        }
        const digits = match[2];
        const index = Number(digits);
        if (!Number.isInteger(index) || String(index) !== digits) {
            continue; // the round trip `population/groups.js` insists on: `007` is not a group id
        }
        if (claimed === null || index < claimed.index) {
            claimed = { districtId: match[1], index, groupId: `${match[1]}:sol:${digits}` };
        }
    }
    return claimed;
}

/* ------------------------------------------------------------------ *
 * The circuit: a patrol sector as a place in the world
 * ------------------------------------------------------------------ */

/**
 * One point on the perimeter of a square circuit, `p` blocks clockwise from its north-west corner.
 * Bedrock: north is -Z, east is +X, so the walk is north edge eastward, east edge southward, south edge
 * westward, west edge northward.
 *
 * @param {number} half the circuit's half-width in blocks
 * @param {number} p distance walked along the perimeter
 * @returns {{ x: number, z: number }}
 */
function perimeterPoint(half, p) {
    const side = 2 * half;
    const perimeter = 4 * side;
    let walk = ((p % perimeter) + perimeter) % perimeter;
    if (walk < side) {
        return { x: -half + walk, z: -half };
    }
    walk -= side;
    if (walk < side) {
        return { x: half, z: -half + walk };
    }
    walk -= side;
    if (walk < side) {
        return { x: half - walk, z: half };
    }
    walk -= side;
    return { x: -half, z: half - walk };
}

/**
 * THE mapping this layer exists for: a wall section of the patrol circuit to a world position.
 *
 * The circuit is the district's own footprint outline (see `footprintHalf`), split into `sectionCount` equal
 * stretches in `people/patrols.js`' order, and a post is the middle of its stretch, `inset` blocks inside the
 * wall line. Two levy on one stretch are told apart by `slide`, which walks the perimeter.
 *
 * @param {Point} centre the district's physical centre
 * @param {number} halfWidth the wall line's distance from the centre
 * @param {number} section the wall section index (0..sectionCount-1, wrapped)
 * @param {number} sectionCount sections in the circuit
 * @param {{ inset?: number, slide?: number }} [options]
 * @returns {{ x: number, z: number, section: number }}
 */
export function wallPostAt(centre, halfWidth, section, sectionCount, options = {}) {
    const sections = Math.max(1, toInt(sectionCount) > 0 ? toInt(sectionCount) : PATROL_RULES.sectionsPerDistrict);
    const wanted = ((toInt(section) % sections) + sections) % sections;
    const half = Math.max(1, toInt(halfWidth) - Math.max(0, toInt(options.inset)));
    const perimeter = 8 * half;
    const slide = Number.isFinite(Number(options.slide)) ? Number(options.slide) : 0;
    const point = perimeterPoint(half, ((wanted + 0.5) * perimeter) / sections + slide);
    return {
        x: Math.round(Number(centre?.x ?? 0) + point.x),
        z: Math.round(Number(centre?.z ?? 0) + point.z),
        section: wanted,
    };
}

/**
 * Which wall section faces the bearing an attack comes from: the stretch whose midpoint points nearest along
 * that bearing. Ties take the lower index, so the answer never depends on object order.
 *
 * @param {string} bearing one of `sim/invasion/composition.js` BEARINGS
 * @param {number} sectionCount
 * @returns {number}
 */
export function anchorSectionFor(bearing, sectionCount) {
    const sections = Math.max(1, toInt(sectionCount) > 0 ? toInt(sectionCount) : PATROL_RULES.sectionsPerDistrict);
    const dir = BEARING_VECTORS[String(bearing)] ?? BEARING_VECTORS.north;
    const length = Math.hypot(dir.x, dir.z) || 1;
    let best = 0;
    let bestScore = -Infinity;
    for (let section = 0; section < sections; section += 1) {
        const point = perimeterPoint(10, ((section + 0.5) * 80) / sections);
        const reach = Math.hypot(point.x, point.z) || 1;
        const score = (point.x * (dir.x / length) + point.z * (dir.z / length)) / reach;
        if (score > bestScore + 1e-9) {
            bestScore = score;
            best = section;
        }
    }
    return best;
}

/**
 * Pull a post toward the attacked stretch along the shortest way round the circuit, by at most `pull` sections.
 * A post already within `pull` of the anchor stays on it; `pull` 0 (peace) changes nothing at all.
 *
 * @param {number} section
 * @param {number} anchor
 * @param {number} sectionCount
 * @param {number} pull
 * @returns {number}
 */
export function shiftTowards(section, anchor, sectionCount, pull) {
    const sections = Math.max(1, toInt(sectionCount));
    const from = ((toInt(section) % sections) + sections) % sections;
    const step = Math.max(0, toInt(pull));
    if (step === 0) {
        return from;
    }
    const to = ((toInt(anchor) % sections) + sections) % sections;
    const forward = (to - from + sections) % sections;
    const signed = forward > sections / 2 ? forward - sections : forward;
    const moved = from + (signed > 0 ? Math.min(signed, step) : Math.max(signed, -step));
    return ((moved % sections) + sections) % sections;
}

/**
 * Which wall section a group holds this step: the section `people/patrols.js` named as its stop when that stop
 * is a section, otherwise the section of its sector the step lands on. Never a gate id: a levy is posted on the
 * wall, and the gate is a gate module's business.
 *
 * @param {ReturnType<typeof planPatrols>} plan
 * @param {any} group one of `plan.groups`
 * @param {number} step the hour
 * @returns {number} index into `plan.sections`
 */
export function postSectionOf(plan, group, step) {
    /** @type {string[]} */
    const sections = Array.isArray(plan?.sections) ? plan.sections : [];
    if (sections.length === 0) {
        return 0;
    }
    const stop = String(group?.stop ?? "");
    const direct = sections.indexOf(stop);
    if (direct >= 0) {
        return direct;
    }
    /** @type {string[]} */
    const own = Array.isArray(group?.sectorSections) ? group.sectorSections : [];
    if (own.length === 0) {
        return 0;
    }
    const hour = Math.max(0, toInt(step));
    const picked = sections.indexOf(own[hour % own.length]);
    return picked >= 0 ? picked : 0;
}

/* ------------------------------------------------------------------ *
 * How many of a district's levy walk the wall, and how many are officers
 * ------------------------------------------------------------------ */

/**
 * The front share of the levy that actually stands in the district - `people/patrols.js`'s rule that only the
 * front garrison walks the wall, applied to entities instead of soldiers.
 *
 * @param {number} present levy entities of this district in view
 * @param {unknown} front `district.garrison.front`
 * @param {unknown} soldiers `district.soldiers`
 * @returns {number} how many of them are posted; never more than `present`
 */
export function frontShareOf(present, front, soldiers) {
    const men = Math.max(0, toInt(front));
    const total = Math.max(0, toInt(soldiers));
    const here = Math.max(0, toInt(present));
    if (here === 0) {
        return 0;
    }
    if (men === 0) {
        // No front garrison on the record: patrols reports the wall uncovered and the reserve stays in the district.
        return 0;
    }
    if (total === 0) {
        return here;
    }
    return Math.min(here, Math.max(1, Math.floor((here * men) / total)));
}

/**
 * How many of a district's posted levy are titled this hour, from `people/command.js` and nothing else.
 *
 * `assignCommanders` answers the error state ("a commander with no soldiers") rather than a silent zero, and so
 * does this: the problems are handed back for the hour's notes, and the count falls back to the commander
 * arithmetic on the levy standing on the wall, which is the only garrison this layer can actually see.
 *
 * @param {any} district
 * @param {number} posted entities going onto the wall
 * @returns {{ count: number, problems: string[] }}
 */
export function officersFor(district, posted) {
    const men = Math.max(0, toInt(posted));
    if (men === 0) {
        return { count: 0, problems: [] };
    }
    /** @type {string[]} */
    let problems = [];
    let front = 0;
    try {
        const command = assignCommanders(district, {});
        problems = [...(command.errors ?? []), ...commandProblems(district, command)];
        front = command.front;
    } catch (error) {
        problems = [`the command structure could not be read: ${String(error)}`];
    }
    if (problems.length > 0) {
        return { count: Math.min(men, Math.max(1, commandersFor(men))), problems };
    }
    return { count: Math.min(men, Math.max(0, front)), problems };
}

/* ------------------------------------------------------------------ *
 * The district's wall: where it is, and how far round it
 * ------------------------------------------------------------------ */

/**
 * The district's own footprint, from the pack's protection geometry rather than a re-typed wall thickness:
 * `commands/civ.js` `protectedRects` over the stored master plan answers the rects a district's own land makes -
 * the prototype origin it was recorded at, and the outline its wall was actually laid along. The OUTERMOST one
 * containing the centre is the wall a levy stands on, because a district that has been built has outgrown its
 * prototype record rather than replaced it. `maxWallHalf` refuses a rect too large to be one district's wall, so
 * an unexpected merge is a refusal, never a post dropped in a neighbour's streets.
 *
 * @param {any[]} areas
 * @param {string} districtId
 * @param {Point} centre
 * @param {any} config
 * @returns {number | null} half-width in blocks, or null when there is no honest wall to post along
 */
function footprintHalf(areas, districtId, centre, config) {
    /** @type {number | null} */
    let best = null;
    for (const area of Array.isArray(areas) ? areas : []) {
        const label = String(area?.label ?? "");
        if (!label.startsWith(`${districtId} `)) {
            continue;
        }
        if (centre.x < toInt(area.x0) || centre.x > toInt(area.x1) || centre.z < toInt(area.z0) || centre.z > toInt(area.z1)) {
            continue;
        }
        const half = Math.min(centre.x - toInt(area.x0), toInt(area.x1) - centre.x, centre.z - toInt(area.z0), toInt(area.z1) - centre.z);
        if (best === null || half > best) {
            best = half;
        }
    }
    if (best === null) {
        return null;
    }
    const wall = Math.floor(best);
    if (wall < toInt(config.minWallHalf) || wall > toInt(config.maxWallHalf)) {
        return null;
    }
    return wall;
}

/**
 * The bearing this district's fight is coming from, as the simulation states it: the wave's own bearing when the
 * wave is pointed at this district, else `siegeMobs.js` `bearingOf`, the district's fixed deterministic bearing.
 *
 * @param {any} district
 * @param {any} wave `kingdom.invasion.wave`, when there is one
 * @returns {string}
 */
function assaultBearing(district, wave) {
    if (isObject(wave) && String(wave.districtId) === String(district?.id) && BEARINGS.includes(String(wave.bearing))) {
        return String(wave.bearing);
    }
    return bearingOf(String(district?.id ?? "district"));
}

/* ------------------------------------------------------------------ *
 * Census: the levy standing in one district
 * ------------------------------------------------------------------ */

/**
 * The height a district's people stand at, from its own physical record.
 * @param {any} district
 * @returns {number | null}
 */
function standingY(district) {
    const candidates = [district?.physical?.origin?.y, district?.civ?.centre?.y];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isFinite(value)) {
            return Math.floor(value);
        }
    }
    return null;
}

/**
 * The garrison entities of one district, in a stable order: asked for by TYPE, so a civilian is never returned,
 * and within the radius `peopleStreets.js` observes its own people at (`ORDERS_DEFAULTS.observeRadius`, or as far
 * round as the district's own wall line plus a slack, whichever is further), so a levy that has wandered out of
 * the district's neighbourhood is left alone rather than dragged back - and one standing on its post is never lost
 * to the window. An entity is claimed by the district on its OWN tag, never by the window it was found in, so two
 * districts' queries cannot both post one golem.
 *
 * @param {DimensionLike} dimension
 * @param {any} district
 * @param {Point} centre
 * @param {number | null} reach the district's wall line, once it is known: the window never excludes a post
 * @param {any} config
 * @param {string[]} notes
 * @returns {LevyRow[]}
 */
function levyOf(dimension, district, centre, reach, config, notes) {
    const districtId = String(district?.id);
    /** @type {LevyRow[]} */
    const rows = [];
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {any[]} */
    let found = [];
    // The window is 3-dimensional in 2.7.0, so it is only used when the district's own record says what height
    // its people stand at. With no honest y the query stays type-only: a wider read, never a wrong move,
    // because every handle is still claimed by the district on its own tag.
    /** @type {any} */
    const query = { type: LEVY_TYPE };
    const level = standingY(district);
    if (level !== null) {
        query.location = { x: centre.x, y: level, z: centre.z };
        query.maxDistance = Math.max(toInt(config.observeRadius), Math.ceil((toInt(reach) * 3) / 2) + 8);
    }
    try {
        found = /** @type {any[]} */ (dimension.getEntities(query));
    } catch (error) {
        notes.push(`${districtId}: its levy could not be read: ${String(error)}`);
        return rows;
    }
    for (const handle of Array.isArray(found) ? found : []) {
        try {
            if (handle === null || handle === undefined || handle.isValid === false) {
                continue;
            }
            const identity = levyIdentityOf(handle.getTags());
            if (identity === null || identity.districtId !== districtId) {
                continue;
            }
            const id = String(handle.id);
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            rows.push({ handle, id, index: identity.index, groupId: identity.groupId, districtId });
        } catch (_error) {
            // A handle that no longer answers is not in view this hour: never a reason to move a guess.
        }
    }
    rows.sort((left, right) => (left.index !== right.index ? left.index - right.index : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return rows;
}

/* ------------------------------------------------------------------ *
 * The driver
 * ------------------------------------------------------------------ */

/**
 * Build the `orders` driver for `integration/peopleRuntime.js`.
 *
 * Dependency injection (all optional - the registration line in main.js needs none of it):
 *   config    overrides for ORDERS_DEFAULTS; every cap is read from the merged object each hour
 *   isGateOn  (world) => boolean; defaults to `people/gate.js` `peopleGateOn`, used only when ctx says nothing
 *   readPlan  () => the stored master plan the wall line is taken from; defaults to civBuilder.loadMasterPlan
 *   probe     (dimension, x, z, config) => Column | null; defaults to `siegeMobs.js` `columnAt`
 *
 * @param {{
 *   config?: Partial<typeof ORDERS_DEFAULTS> & Record<string, unknown>,
 *   isGateOn?: (world: any) => boolean,
 *   readPlan?: () => any,
 *   probe?: (dimension: any, x: number, z: number, config: any) => any,
 * }} [deps]
 * @returns {{ id: "orders", onHour: (ctx: any) => number, status: () => Record<string, any>, config: any }}
 */
export function createOrdersDriver(deps = {}) {
    const config = {
        ...ORDERS_DEFAULTS,
        ...(isObject(deps.config) ? deps.config : {}),
    };
    const gateRead = typeof deps.isGateOn === "function" ? deps.isGateOn : peopleGateOn;
    const readPlan = typeof deps.readPlan === "function" ? deps.readPlan : () => loadMasterPlan().plan;
    const probeColumn = typeof deps.probe === "function" ? deps.probe : columnAt;

    /** @type {{ hours: number, moved: number, titled: number, failedMoves: number, refused: string | null, districts: any[], notes: string[] }} */
    const done = {
        hours: 0,
        moved: 0,
        titled: 0,
        failedMoves: 0,
        refused: null,
        districts: [],
        notes: [],
    };

    /**
     * The wall line, from the same geometry the attackers are refused entry by. A plan that cannot be read is not
     * an error: `protectedRects` falls back to the recorded centre, which is what a district built without a
     * master plan actually has. A protection list that cannot be read means no wall is known, and nothing is posted.
     *
     * @param {any} kingdom
     * @param {string[]} notes
     * @returns {any[] | null}
     */
    function footprints(kingdom, notes) {
        /** @type {any} */
        let plan;
        try {
            plan = readPlan();
        } catch (error) {
            notes.push(`the master plan could not be read, so the recorded centre decides the wall line: ${String(error)}`);
        }
        try {
            // pad 0, grow 0, exceptIndex -1: the footprint exactly as the wall was laid, for every district.
            return protectedRects(kingdom, 0, plan === undefined || plan === null ? undefined : plan, 0, -1);
        } catch (error) {
            notes.push(`the protected footprints could not be read, so nobody was posted this hour: ${String(error)}`);
            return null;
        }
    }

    /**
     * One district's levy, onto its circuit.
     *
     * @param {any} district
     * @param {LevyRow[]} rows
     * @param {number | null} wall the district's wall line in blocks from its centre, from `footprintHalf`
     * @param {number} hour
     * @param {boolean} assaulted
     * @param {any} wave
     * @param {any} budget the hour's shared move and title allowance
     * @param {string[]} notes
     * @param {DimensionLike} dimension
     * @returns {{ districtId: string, posted: number, moved: number, titled: number, failed: number, probes: number, reason: string, rows: any[] }}
     */
    function postDistrict(district, rows, wall, hour, assaulted, wave, budget, notes, dimension) {
        const districtId = String(district.id);
        const districtName = String(district.name ?? districtId);
        /** @type {any[]} */
        const out = [];
        const result = { districtId, posted: 0, moved: 0, titled: 0, failed: 0, probes: 0, reason: "", rows: out };

        const centre = physicalCentreOf(district);
        if (centre === null) {
            // No physical build record: there is no wall and no ground this layer is allowed to claim. Nothing moves.
            result.reason = "no physical build record: this district has no wall to watch";
            return result;
        }
        if (wall === null) {
            result.reason = "no wall line could be read from the district's footprint: nobody was posted";
            return result;
        }

        /** @type {any} */
        let plan = null;
        try {
            plan = planPatrols(district, { step: hour, sectionCount: toInt(config.sectionsPerDistrict) });
        } catch (error) {
            result.reason = `the patrol plan could not be made: ${String(error)}`;
            notes.push(`${districtId}: ${result.reason}`);
            return result;
        }
        const posted = Math.min(frontShareOf(rows.length, district?.garrison?.front, district?.soldiers), toInt(config.movesPerDistrict));
        result.posted = posted;
        if (posted === 0 || plan.groupCount === 0 || plan.groups.length === 0) {
            result.reason = plan.reason !== null ? String(plan.reason) : "no levy of this district stands in view";
            return result;
        }
        const sections = plan.sections.length;
        const groups = Math.min(plan.groups.length, posted);
        const bearing = assaulted ? assaultBearing(district, wave) : "";
        const anchor = anchorSectionFor(bearing, sections);
        const approach = BEARING_VECTORS[bearing] ?? BEARING_VECTORS.north;
        const officer = officersFor(district, posted);
        if (officer.problems.length > 0) {
            notes.push(`${districtId}: ${officer.problems[0]} - officers titled from the ${String(posted)} levy on the wall instead`);
        }

        /** @type {Set<string>} */
        const used = new Set();
        for (let position = 0; position < posted; position += 1) {
            const row = rows[position];
            // The groups rotate sectors every PATROL_RULES.rotationSteps hours; the levy rotate groups every hour,
            // so no entity is on the same stretch of wall even inside one rotation step.
            const group = plan.groups[(position + hour) % groups];
            const baseSection = postSectionOf(plan, group, hour);
            const section = assaulted ? shiftTowards(baseSection, anchor, sections, toInt(config.threatPull)) : baseSection;

            /** @type {{ x: number, z: number, section: number } | null} */
            let spot = null;
            /** @type {any} */
            let column = null;
            for (let attempt = 0; attempt < Math.max(1, toInt(config.maxPostTries)) && result.probes < toInt(config.probesPerDistrict); attempt += 1) {
                const offset = attempt === 0 ? 0 : (attempt % 2 === 1 ? 1 : -1) * Math.ceil(attempt / 2) * toInt(config.postSpacing);
                const candidate = wallPostAt(centre, wall, section, sections, { inset: toInt(config.postInset), slide: offset });
                const key = `${String(candidate.x)},${String(candidate.z)}`;
                if (used.has(key)) {
                    continue;
                }
                result.probes += 1;
                const ground = probeColumn(dimension, candidate.x, candidate.z, config);
                if (ground === null || ground === undefined || ground.water === true) {
                    continue;
                }
                spot = candidate;
                column = ground;
                used.add(key);
                break;
            }
            if (spot === null || column === null) {
                result.failed += 1;
                if (notes.length < toInt(config.maxNotes)) {
                    notes.push(`${districtId}: no standable ground on wall section ${String(section)} for ${row.id}`);
                }
                continue;
            }

            /** @type {{ x: number, y: number, z: number }} */
            const destination = { x: spot.x + 0.5, y: toInt(column.y), z: spot.z + 0.5 };
            // Which way a posted levy looks. At peace it watches the ground outside its own stretch of wall; under
            // assault every post turns toward the bearing the attack comes from. `facingLocation` is a stable
            // TeleportOptions field in 2.7.0, and there is no navigation or pathfinding API to ask for more.
            const facing = assaulted
                ? { x: spot.x + Math.round(Number(approach.x) * 8), y: destination.y, z: spot.z + Math.round(Number(approach.z) * 8) }
                : { x: spot.x + (spot.x - centre.x), y: destination.y, z: spot.z + (spot.z - centre.z) };
            let standing;
            try {
                standing = row.handle.location;
            } catch (_error) {
                continue;
            }
            const alreadyHere =
                Math.abs(Number(standing?.x ?? NaN) - destination.x) <= Number(config.standTolerance) &&
                Math.abs(Number(standing?.z ?? NaN) - destination.z) <= Number(config.standTolerance);
            if (out.length < toInt(config.maxRowsPerDistrict)) {
                out.push({ id: row.id, group: (position + hour) % groups, sector: group?.sector ?? null, section: spot.section, x: spot.x, z: spot.z, moved: !alreadyHere });
            }
            if (alreadyHere) {
                continue;
            }
            if (budget.moves >= toInt(config.movesTotal)) {
                if (notes.length < toInt(config.maxNotes)) {
                    notes.push(`${districtId}: the hour's ${String(config.movesTotal)} move(s) were spent, ${row.id} keeps its post`);
                }
                break;
            }
            try {
                row.handle.teleport(destination, { facingLocation: { x: facing.x, y: destination.y, z: facing.z } });
                budget.moves += 1;
                result.moved += 1;
            } catch (error) {
                // Unloaded ground, a released handle, a chunk the engine has let go: one levy stays put, the hour does not.
                result.failed += 1;
                // A throw still spent the hour's allowance: a district standing in ground the engine has released
                // cannot make every later district pay for trying it again.
                budget.moves += 1;
                if (notes.length < toInt(config.maxNotes)) {
                    notes.push(`${districtId}: ${row.id} could not be moved to ${String(spot.x)}, ${String(spot.z)}: ${String(error)}`);
                }
            }
        }

        const wanted = Math.min(officer.count, toInt(config.titlesPerDistrict), budget.titles);
        for (let index = 0; index < wanted; index += 1) {
            const handle = rows[index].handle;
            const label = `${districtName} ${OFFICER_LABEL}`;
            try {
                if (handle.isValid === false || handle.nameTag === label) {
                    continue;
                }
                handle.nameTag = label;
                result.titled += 1;
                budget.titles -= 1;
            } catch (_error) {
                // A name that cannot be written is a name that was not written: the levy still stands its post.
            }
        }

        result.reason = assaulted
            ? `under assault from the ${bearing}: ${String(result.posted)} levy posted toward it`
            : `at peace: ${String(result.posted)} levy on the circuit`;
        return result;
    }

    /**
     * One accepted simulation hour: draw the posts, walk the levy onto them, title the officers.
     *
     * @param {any} ctx the people context (kingdom, report, dimension, world, tick, gateOn)
     * @returns {number} entities this hour changed by moving or titling - never created, never removed
     */
    function onHour(ctx) {
        /** @type {string[]} */
        const notes = [];
        done.hours += 1;
        const dimension = ctx?.dimension;
        const kingdom = ctx?.kingdom;
        const world = ctx?.world ?? runtimeWorld;
        if (!looksLikeDimension(dimension)) {
            done.refused = "no dimension to read the levy from";
            done.districts = [];
            done.notes = [done.refused];
            return 0;
        }
        if (!isObject(kingdom) || !Array.isArray(kingdom.districts)) {
            done.refused = "no kingdom records";
            done.districts = [];
            done.notes = [done.refused];
            return 0;
        }

        // An hour that arrives with the gate off is a teardown hour, and teardown is not ours to do: the levy are
        // peopleStreets' entities and it removes them. So this hour moves nothing, renames nobody and says so.
        const gateOn = ctx?.gateOn === undefined ? gateRead(world) : ctx.gateOn === true;
        if (gateOn !== true) {
            done.refused = "civ:people is off: the levy are not ours to remove, so nothing is moved or renamed";
            done.districts = [];
            done.notes = [];
            return 0;
        }
        done.refused = null;

        const hour = rotationHour(ctx);
        const areas = footprints(kingdom, notes);
        /** @type {any} */
        let threat = { threatened: false, districtIds: [] };
        try {
            threat = invasionThreatOf(kingdom);
        } catch (error) {
            notes.push(`the war state could not be read, so every district was posted as if at peace: ${String(error)}`);
        }
        /** @type {Set<string>} */
        const assaulted = new Set(Array.isArray(threat?.districtIds) ? threat.districtIds.map(String) : []);
        const wave = isObject(kingdom.invasion) && kingdom.invasion.enabled === true ? kingdom.invasion.wave : null;

        const budget = { moves: 0, titles: toInt(config.titlesTotal) };
        /** @type {any[]} */
        const districts = [];
        let moved = 0;
        let titled = 0;
        let failed = 0;
        /** @type {Set<string>} */
        const claimed = new Set();

        if (areas === null) {
            // No footprint list is no right to move anybody: a wall that cannot be read is a wall nobody can be
            // posted on. The reason is already in the notes, from the read that failed.
            done.districts = [];
            done.notes = notes.slice(0, Math.max(1, toInt(config.maxNotes)));
            return 0;
        }

        const sorted = [...kingdom.districts]
            .filter((/** @type {any} */ district) => isObject(district) && district.id !== undefined)
            .sort((/** @type {any} */ left, /** @type {any} */ right) => (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0))
            .slice(0, Math.max(1, toInt(config.maxDistricts)));

        for (const district of sorted) {
            const districtId = String(district.id);
            if (String(district.security) === "lost") {
                // people/patrols.js: a lost district has no patrols. Its levy are left where they are.
                continue;
            }
            const centre = physicalCentreOf(district);
            if (centre === null) {
                continue;
            }
            // The wall line first, because it sizes the window the levy are looked for in: a district whose circuit
            // reaches further than the streets driver's observation radius must still see its own posted troops.
            const wall = footprintHalf(areas, districtId, centre, config);
            const found = levyOf(dimension, district, centre, wall, config, notes).filter((/** @type {LevyRow} */ row) => {
                if (claimed.has(row.id)) {
                    return false;
                }
                claimed.add(row.id);
                return true;
            });
            if (found.length === 0) {
                // Silent before: an empty street and a district with no garrison both printed nothing, so
                // `civ:people` could not be read. This is the one refusal a player needs to see.
                notes.push(`${districtId}: no levy of this district stands within view (wall line ${wall === null ? "unreadable" : `${String(wall)} blocks`}), so nobody was posted`);
                continue;
            }
            const result = postDistrict(district, found, wall, hour, assaulted.has(districtId), wave, budget, notes, dimension);
            districts.push(result);
            moved += result.moved;
            titled += result.titled;
            failed += result.failed;
        }

        done.moved += moved;
        done.titled += titled;
        done.failedMoves += failed;
        done.districts = districts;
        done.notes = notes.slice(0, Math.max(1, toInt(config.maxNotes)));
        return moved + titled;
    }

    /** What the last hour did, for `civ:people status` and for a dev probe. */
    function status() {
        return {
            hours: done.hours,
            moved: done.moved,
            titled: done.titled,
            failedMoves: done.failedMoves,
            refused: done.refused,
            districts: done.districts.map((/** @type {any} */ row) => ({
                districtId: row.districtId,
                posted: row.posted,
                moved: row.moved,
                titled: row.titled,
                failed: row.failed,
                probes: row.probes,
                reason: row.reason,
                levy: row.rows,
            })),
            notes: done.notes,
        };
    }

    return { id: "orders", onHour, status, config };
}
