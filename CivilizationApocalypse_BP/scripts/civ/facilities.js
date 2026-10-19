/**
 * Per-role facility expectations for an enlarged district site record (Phase D: all five districts).
 *
 * Nothing here invents a building or a second facility system: the programmes come from
 * `civ/zoning.js` `ROLE_ZONES` (which kinds a role asks for) and the spacing rules from
 * `civ/lots.js` `requiredGap`/`rectGap`. This module only reads a finished site record and answers
 * three questions that the record itself cannot answer:
 *
 *   1. mix      - is the district recognisably its role? A handful of structures define a role (a command
 *                 district without a citadel is not a command district), and no role may site a building
 *                 that belongs exclusively to another.
 *   2. loudness - every kind the programme wanted but did not site (either because `civ/lots.js`
 *                 found no lot, or because `civ/districtplan.js` found no buildable pad for the lot)
 *                 must be reported in `record.notes`. A district may not "succeed" in silence.
 *   3. density  - the enlarged layout must stay spacious: the measured gap between every pair of
 *                 building footprints meets the required gap, and the footprint area stays a small
 *                 fraction of the enclosed land, with a density that differs by role.
 *
 * Nothing here is a floor copied from what the planner happened to achieve. The identity kinds come
 * from the design brief, and the kinds the planner is NOT known to be able to site on every terrain
 * are named in `SITING_GAPS` with their reason: a gap kind may legitimately be absent (it must still
 * be reported), a kind outside the list that vanishes is a regression and is reported as one. The
 * spaciousness numbers are design targets - the prototype they replace is quoted next to each of them.
 *
 * Pure: no `@minecraft/*` import, no `Math.random`, no `Date`. It is a READ-ONLY auditor: importing
 * it cannot change a site record, which is what keeps district 1's stored checksum intact.
 */

import { KIND_GROUP, ROLE_ZONES } from "./zoning.js";
import { HOUSE_KINDS, MIN_SPACING, rectGap, requiredGap } from "./lots.js";

export const FACILITIES_VERSION = 1;

/**
 * Per role, the structures that make it that role: each must be sited at least once, in every district,
 * on every terrain. These are the buildings the design brief names for the role, and they are chosen so
 * that the claim is checkable - a district that loses one of them has lost the function, not a variant.
 * @type {Record<string, readonly string[]>}
 */
export const DEFINING = Object.freeze({
    command: Object.freeze(["hq_citadel", "armoury", "barracks", "well"]),
    industrial: Object.freeze(["smithy", "kiln", "workshop", "warehouse", "well"]),
    agricultural: Object.freeze(["longhouse", "granary", "farm_allot", "well"]),
    commercial: Object.freeze(["market_stall", "inn", "warehouse", "well"]),
    residential: Object.freeze(["house_s", "house_m", "house_l", "chapel", "school", "well"]),
});

/**
 * Per role, the programme kinds the lot-siting stage cannot guarantee on every terrain: they need a big
 * flat pad, a specific zone, or a clear frontage, and on some grounds nothing in the district qualifies.
 * Absence is allowed ONLY if the record says so - `unsitedProblems` still refuses an unexplained zero, and
 * the offline battery pins this list, so a kind may leave it (when siting improves) but may not join it
 * quietly. Dev: raise lot-siting capacity for these kinds, then delete them from here.
 * @type {Record<string, readonly string[]>}
 */
export const SITING_GAPS = Object.freeze({
    command: Object.freeze(["command_hall", "drill_ground", "stable", "farm_veg", "orchard"]),
    industrial: Object.freeze(["farm_veg", "pen"]),
    agricultural: Object.freeze(["stable", "barracks", "shop", "mill", "orchard", "pen", "garden"]),
    commercial: Object.freeze(["market_square", "customs_yard", "barracks", "farm_kitchen", "orchard"]),
    residential: Object.freeze(["barracks", "warehouse", "shop", "farm_kitchen", "farm_veg", "orchard"]),
});

/** Kinds that only ever belong to one role's programme: any other district placing one is a mix bug. */
export const EXCLUSIVE_OWNER = Object.freeze({
    hq_citadel: "command",
    command_hall: "command",
    drill_ground: "command",
    smithy: "industrial",
    kiln: "industrial",
    workshop: "industrial",
    quarry_yard: "industrial",
    longhouse: "agricultural",
    mill: "agricultural",
    farm_wheat: "agricultural",
    farm_irrigated: "agricultural",
    market_square: "commercial",
    inn: "commercial",
    customs_yard: "commercial",
    chapel: "residential",
    school: "residential",
});

/** Spaciousness targets: the prototype is quoted so each number has a stated basis, not a measured one. */
export const DENSITY = Object.freeze({
    /** open land each building may call its own, block-columns. The 49x49 prototype gave ~48 per building. */
    minOpenColumnsPerBuilding: 300,
    /** building footprints may never cover more than about a fifth of the enclosed land. */
    maxFootprintFraction: 0.22,
    /** the roomiest and the densest role must differ by at least this ratio, or the roles mean nothing. */
    minSpreadRatio: 1.15,
    /** roles that must stay roomier than the farming and living roles. */
    roomyRoles: Object.freeze(["command", "industrial", "commercial"]),
    crowdedRoles: Object.freeze(["agricultural", "residential"]),
});

const NOTE_NO_SITE = /^no site for (\d+) x ([a-z_0-9]+)$/;
const NOTE_PAD_DROP = /^lot d\d+-([a-z_0-9]+)-\d+ has no buildable pad/;

/** @param {any} record @returns {any[]} */
function buildingsOf(record) {
    return /** @type {any[]} */ ((record?.lots ?? [])).filter((element) => String(element.id).startsWith("building-"));
}

/**
 * Placed building counts by kind (the blueprint role name, without the `building-` element prefix).
 * @param {any} record
 * @returns {{ kinds: Record<string, number>, groups: Record<string, number>, buildings: number }}
 */
export function mixOf(record) {
    /** @type {Record<string, number>} */
    const kinds = {};
    /** @type {Record<string, number>} */
    const groups = {};
    for (const element of buildingsOf(record)) {
        const kind = String(element.kind).replace("building-", "");
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        const group = KIND_GROUP[kind] ?? "other";
        groups[group] = (groups[group] ?? 0) + 1;
    }
    return { kinds, groups, buildings: buildingsOf(record).length };
}

/**
 * What the role's programme asks for, straight from `ROLE_ZONES` (a `fill` programme has no fixed
 * count, and `repeat` multiplies the zone).
 * @param {string} role
 * @returns {Record<string, number>}
 */
export function programmeWants(role) {
    /** @type {Record<string, number>} */
    const want = {};
    for (const zone of /** @type {any[]} */ (ROLE_ZONES[role] ?? [])) {
        const repeat = Number(zone.repeat ?? 1);
        for (const program of /** @type {any[]} */ (zone.programs ?? [])) {
            if (program.fill === true) continue;
            want[program.kind] = (want[program.kind] ?? 0) + Number(program.count ?? 1) * repeat;
        }
    }
    return want;
}

/**
 * Kinds the programme wanted more of than the district sited.
 * @param {any} record
 * @returns {{ kind: string, wanted: number, placed: number, missing: number }[]}
 */
export function shortfallOf(record) {
    const mix = mixOf(record);
    const want = programmeWants(String(record?.role ?? ""));
    const out = [];
    for (const [kind, wanted] of Object.entries(want)) {
        const placed = mix.kinds[kind] ?? 0;
        if (placed < wanted) out.push({ kind, wanted, placed, missing: wanted - placed });
    }
    return out.sort((left, right) => left.kind.localeCompare(right.kind));
}

/**
 * What the record itself admits to not siting: `no site for N x kind` from the zoning/lots stage and
 * `lot <id> has no buildable pad` from the foundation stage.
 * @param {any} record
 */
export function reportedShortfalls(record) {
    /** @type {Record<string, number>} */
    const noSite = {};
    /** @type {Record<string, number>} */
    const padDropped = {};
    let padNotes = 0;
    for (const note of /** @type {string[]} */ (record?.notes ?? [])) {
        let match = NOTE_NO_SITE.exec(String(note));
        if (match) {
            noSite[match[2]] = (noSite[match[2]] ?? 0) + Number(match[1]);
            continue;
        }
        match = NOTE_PAD_DROP.exec(String(note));
        if (match) {
            padDropped[match[1]] = (padDropped[match[1]] ?? 0) + 1;
            padNotes += 1;
        }
    }
    return { noSite, padDropped, padNotes, total: Object.values(noSite).reduce((s, n) => s + n, 0) + Object.values(padDropped).reduce((s, n) => s + n, 0) };
}

/**
 * Unsited lots must be loud. Returns one problem per kind that vanished without a note, and per
 * note that does not match the record's own lot accounting.
 * @param {any} record
 * @returns {string[]}
 */
export function unsitedProblems(record) {
    /** @type {string[]} */
    const problems = [];
    const reported = reportedShortfalls(record);
    for (const miss of shortfallOf(record)) {
        const explained = (reported.noSite[miss.kind] ?? 0) + (reported.padDropped[miss.kind] ?? 0);
        if (explained < miss.missing) {
            problems.push(`${String(record.districtIndex)}/${String(record.role)}: ${String(miss.missing - explained)} x ${miss.kind} wanted ${String(miss.wanted)} sited ${String(miss.placed)} and nothing says so`);
        }
    }
    const withoutPad = Number(record?.stats?.lotsWithoutPad ?? 0);
    if (reported.padNotes < withoutPad) {
        problems.push(`${String(record.districtIndex)}/${String(record.role)}: ${String(withoutPad)} lots have no pad but only ${String(reported.padNotes)} carry a reason`);
    }
    return problems;
}

/**
 * Does the placed mix still look like the role?
 *   - every defining structure of the role is sited at least once;
 *   - no programme kind disappears unless it is listed in `SITING_GAPS`, where its absence is expected
 *     (and even then the record must say so - that half is `unsitedProblems`);
 *   - no district sites a kind that belongs exclusively to another role.
 * `peers` (all five records, optional) adds the city-wide half of the exclusivity check.
 * @param {any} record
 * @param {any[]} [peers]
 * @returns {string[]}
 */
export function mixProblems(record, peers = []) {
    /** @type {string[]} */
    const problems = [];
    const role = String(record?.role ?? "");
    const defining = DEFINING[role];
    if (defining === undefined) {
        return [`${String(record?.districtIndex)}: role '${role}' has no facility definition`];
    }
    const mix = mixOf(record);
    const gaps = SITING_GAPS[role] ?? [];
    for (const kind of defining) {
        if ((mix.kinds[kind] ?? 0) < 1) problems.push(`${String(record.districtIndex)}/${role}: ${kind} is not sited at all, and the role is defined by it`);
    }
    for (const [kind, wanted] of Object.entries(programmeWants(role))) {
        if ((mix.kinds[kind] ?? 0) > 0 || gaps.includes(kind) || defining.includes(kind)) continue;
        problems.push(`${String(record.districtIndex)}/${role}: ${kind} (wanted ${String(wanted)}) sited none, and it is not listed as a siting gap`);
    }
    for (const [kind, owner] of Object.entries(EXCLUSIVE_OWNER)) {
        if (role === owner) continue;
        if ((mix.kinds[kind] ?? 0) > 0) problems.push(`${String(record.districtIndex)}/${role}: sited ${String(mix.kinds[kind])} x ${kind}, which belongs to ${owner}`);
    }
    if (peers.length > 1) {
        for (const [kind, owner] of Object.entries(EXCLUSIVE_OWNER)) {
            const placed = peers.filter((peer) => String(peer?.role ?? "") !== owner && mixOf(peer).kinds[kind] !== undefined).length;
            if (placed > 0) problems.push(`${kind}: ${String(placed)} district(s) outside '${owner}' sited it`);
        }
    }
    return problems;
}

/**
 * Measured spacing between the building footprints, using `civ/lots.js` own rules.
 * @param {any} record
 */
export function spacingOf(record) {
    const buildings = buildingsOf(record);
    let minGap = Infinity;
    let minSlack = Infinity;
    let belowRequired = 0;
    let overlaps = 0;
    let worst = "";
    for (let a = 0; a < buildings.length; a += 1) {
        for (let b = a + 1; b < buildings.length; b += 1) {
            const kindA = String(buildings[a].kind).replace("building-", "");
            const kindB = String(buildings[b].kind).replace("building-", "");
            const gap = rectGap(buildings[a].bbox, buildings[b].bbox);
            if (gap < 0) {
                overlaps += 1;
                continue;
            }
            const need = requiredGap(kindA, kindB);
            const slack = gap - need;
            if (slack < 0) belowRequired += 1;
            if (gap < minGap) minGap = gap;
            if (slack < minSlack) {
                minSlack = slack;
                worst = `${kindA}|${kindB} gap ${String(gap)} need ${String(need)}`;
            }
        }
    }
    return {
        buildings: buildings.length,
        minGap: Number.isFinite(minGap) ? minGap : -1,
        minSlack: Number.isFinite(minSlack) ? minSlack : -1,
        belowRequired,
        overlaps,
        worst,
        houseKinds: HOUSE_KINDS.length,
        minSpacing: MIN_SPACING,
    };
}

/**
 * Density of a district: enclosed columns from the record, footprint columns from the building bboxes.
 * @param {any} record
 */
export function densityOf(record) {
    const buildings = buildingsOf(record);
    const enclosed = Number(record?.area ?? 0);
    let footprintColumns = 0;
    for (const element of buildings) {
        const box = element.bbox;
        footprintColumns += (Number(box.x1) - Number(box.x0) + 1) * (Number(box.z1) - Number(box.z0) + 1);
    }
    const perBuilding = buildings.length === 0 ? enclosed : enclosed / buildings.length;
    return {
        enclosedColumns: enclosed,
        buildings: buildings.length,
        footprintColumns,
        footprintFraction: enclosed === 0 ? 1 : footprintColumns / enclosed,
        openColumnsPerBuilding: Math.round(perBuilding),
        buildingsPer1000Columns: enclosed === 0 ? 0 : (buildings.length / enclosed) * 1000,
    };
}

/**
 * One entry point for a caller that is about to build or ship ONE district: mix, loudness and
 * spaciousness for that record alone. An empty array means the district is a complete, roomy,
 * self-reporting site of its own role - it says nothing about how the other four look.
 * @param {any} record
 * @returns {string[]}
 */
export function auditRecord(record) {
    /** @type {string[]} */
    const problems = [];
    if (record === null || record === undefined) return ["a district produced no record"];
    for (const problem of unsitedProblems(record)) problems.push(problem);
    for (const problem of mixProblems(record)) problems.push(problem);
    const spacing = spacingOf(record);
    if (spacing.overlaps > 0) problems.push(`${String(record.districtIndex)}: ${String(spacing.overlaps)} overlapping building footprints`);
    if (spacing.belowRequired > 0) problems.push(`${String(record.districtIndex)}: ${String(spacing.belowRequired)} building pairs closer than requiredGap (${spacing.worst})`);
    const density = densityOf(record);
    if (density.openColumnsPerBuilding < DENSITY.minOpenColumnsPerBuilding) {
        problems.push(`${String(record.districtIndex)}/${String(record.role)}: only ${String(density.openColumnsPerBuilding)} open columns per building`);
    }
    if (density.footprintFraction > DENSITY.maxFootprintFraction) {
        problems.push(`${String(record.districtIndex)}/${String(record.role)}: footprints cover ${(density.footprintFraction * 100).toFixed(1)}% of the land`);
    }
    return problems;
}

/**
 * The city-wide rules, which only mean something when the roles they compare are all present: a
 * one-record or two-record list is a district, not a civilization, and must not be judged as one.
 * @param {any[]} records
 * @returns {string[]}
 */
export function auditCity(records) {
    /** @type {string[]} */
    const problems = [];
    const list = /** @type {any[]} */ (records ?? []);
    /** @type {Map<string, any>} */
    const byRole = new Map();
    for (const record of list) {
        if (record === null || record === undefined) continue;
        const known = byRole.get(String(record.role));
        if (known !== undefined) problems.push(`role '${String(record.role)}' appears twice (${String(known.districtIndex)} and ${String(record.districtIndex)})`);
        byRole.set(String(record.role), record);
    }
    const roles = [...DENSITY.roomyRoles, ...DENSITY.crowdedRoles];
    if (!roles.every((role) => byRole.has(role))) return problems;
    const roomy = DENSITY.roomyRoles.map((role) => densityOf(byRole.get(role)).openColumnsPerBuilding);
    const crowded = DENSITY.crowdedRoles.map((role) => densityOf(byRole.get(role)).openColumnsPerBuilding);
    const tightest = Math.max(...crowded);
    const roomiest = Math.min(...roomy);
    if (roomiest <= tightest) {
        problems.push(`density does not follow the role: the roomy roles average down to ${String(roomiest)} columns per building while farming/living go up to ${String(tightest)}`);
    }
    const all = roles.map((role) => densityOf(byRole.get(role)).openColumnsPerBuilding);
    if (Math.max(...all) < Math.min(...all) * DENSITY.minSpreadRatio) {
        problems.push(`the districts are equally dense (${String(Math.min(...all))}..${String(Math.max(...all))} columns per building) - one role is jammed or another is empty`);
    }
    return problems;
}

/**
 * One entry point for a caller that has the whole set of district records: every per-district rule plus
 * the rules that only mean something across a civilization.
 * @param {any[]} records
 * @returns {string[]}
 */
export function auditRecords(records) {
    const list = /** @type {any[]} */ (records ?? []);
    const problems = [];
    for (const record of list) for (const problem of auditRecord(record)) problems.push(problem);
    for (const problem of auditCity(list)) problems.push(problem);
    return problems;
}
