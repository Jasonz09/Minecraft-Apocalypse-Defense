/**
 * Civilian occupations: which civilian does which job, derived from the district record.
 *
 * Pure. No `@minecraft/server` import, no world access, no randomness. The caller decides
 * what a roster means for entities; this module only says who should be doing what.
 *
 * INPUT SHAPE - `PeopleDistrict`. This is the subset of a real district record
 * (`kingdom.districts[i]`, see kingdom/state.js `makeDistrict`) that these modules read:
 *   id, name, security, civilians, soldiers, builders, trainingQueue, trainingBuffer,
 *   garrison { front, reserve }, reserves { food, materials, supplies },
 *   buildings { homes, farms, storehouses, barracks, walls }, gates [{ id, with, state }],
 *   assault, defensiveIntegrity, civilianCapacity, refugees
 * Missing numbers read as 0 and a missing security reads as "secure". Nothing else is needed.
 *
 * Model facts, stated rather than hidden:
 *  - The save has no ages. Children and elders are a fixed share of the civilian pool
 *    (OCCUPATION_RULES.childShare / elderShare). That is a plan parameter, not save data.
 *  - `civilians` already includes `builders`: construction.js draws crews from the pool
 *    without reducing it. Builders are therefore reserved out of the adult pool first.
 *  - Trainees have already left `civilians` (population.openRecruitment), so they are not
 *    in this pool at all.
 *  - Farm output in the simulation does not depend on how many farmers exist (population.js
 *    `farmFoodOutput` counts farms only). An unfilled farm crew is reported, not penalised.
 */

/** Every role a civilian can hold. `none` is an able adult with no post in the district's needs. */
export const ROLES = Object.freeze(["builder", "farmer", "guard", "worker", "smith", "none", "child", "elder"]);

/** Tunables local to this module. config.js is not edited to add them. */
export const OCCUPATION_RULES = Object.freeze({
    /** Share of the civilian pool that are children (no ages in the save). */
    childShare: 0.25,
    /** Share of the civilian pool that are elders. */
    elderShare: 0.1,
    /** Farmers per standing farm: the farm capacity of a district. */
    farmCrewPerFarm: 3,
    /** Hauling workers per storehouse. */
    workersPerStorehouse: 2,
    /** Smiths (equipment and materials work) per storehouse. Workshops are not a building yet. */
    smithsPerStorehouse: 1,
    /** Armourers per barracks, feeding equipment.js. */
    smithsPerBarracks: 1,
    /** Militia guards per wall count on the record. */
    guardsPerWall: 2,
    /** Night and day watch posted at each barracks. */
    guardsPerBarracks: 1,
    /** Under these security levels the wall needs bodies more than the fields, so guards are filled first. */
    threatSecurity: Object.freeze(["contested", "breached", "isolated"]),
});

/**
 * @param {any} value
 * @returns {number} a non-negative whole number; anything unreadable is 0
 */
function count(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

/**
 * @returns {Record<string, number>} every role at zero
 */
function zeroRoles() {
    /** @type {Record<string, number>} */
    const roles = {};
    for (const role of ROLES) {
        roles[role] = 0;
    }
    return roles;
}

/**
 * How many people each post needs, read straight from the district's buildings.
 * Pure arithmetic over the record; nothing is assigned here.
 *
 * @param {any} district
 * @returns {{ farmer: { need: number, capacity: number }, guard: { need: number }, worker: { need: number }, smith: { need: number } }}
 */
export function occupationNeeds(district) {
    const buildings = district?.buildings ?? {};
    const farms = count(buildings.farms);
    const storehouses = count(buildings.storehouses);
    const barracks = count(buildings.barracks);
    const walls = count(buildings.walls);
    const farmCapacity = farms * OCCUPATION_RULES.farmCrewPerFarm;
    return {
        farmer: { need: farmCapacity, capacity: farmCapacity },
        guard: { need: walls * OCCUPATION_RULES.guardsPerWall + barracks * OCCUPATION_RULES.guardsPerBarracks },
        worker: { need: storehouses * OCCUPATION_RULES.workersPerStorehouse },
        smith: { need: storehouses * OCCUPATION_RULES.smithsPerStorehouse + barracks * OCCUPATION_RULES.smithsPerBarracks },
    };
}

/**
 * Assign every civilian in one district a role.
 *
 * Order is fixed: children and elders first (they hold no post), then builders (already
 * working), then the posts in priority order. Under threat the guards are filled before the
 * farmers; otherwise farmers come first because food is survival. Adults left over after every
 * post is filled are `none`. A district that is `lost` is not assigned anything at all.
 *
 * @param {any} district a PeopleDistrict
 * @param {{ withRoster?: boolean }} [options] `withRoster: false` skips the per-person list
 * @returns {{
 *   districtId: string, name: string, lost: boolean, total: number,
 *   roles: Record<string, number>, needs: ReturnType<typeof occupationNeeds>,
 *   unfilled: Array<{ role: string, count: number, reason: string }>,
 *   priority: string[], threat: boolean, reason: string | null,
 *   roster: Array<{ slot: number, role: string }>
 * }}
 */
export function assignOccupations(district, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("assignOccupations: district must be an object");
    }
    const districtId = String(district.id);
    const name = String(district.name ?? district.id);
    const security = String(district.security ?? "secure");

    if (security === "lost") {
        return {
            districtId, name, lost: true, total: 0, roles: zeroRoles(), needs: occupationNeeds({}),
            unfilled: [], priority: [], threat: false, reason: "district lost: nothing is assigned", roster: [],
        };
    }

    const pool = count(district.civilians);
    const childCount = Math.floor(pool * OCCUPATION_RULES.childShare);
    const elderCount = Math.floor(pool * OCCUPATION_RULES.elderShare);
    const adults = pool - childCount - elderCount;
    const builderCount = Math.min(count(district.builders), adults);
    let free = adults - builderCount;

    const threat = OCCUPATION_RULES.threatSecurity.includes(security);
    const priority = threat ? ["guard", "farmer", "worker", "smith"] : ["farmer", "guard", "worker", "smith"];
    const needs = occupationNeeds(district);
    const roles = zeroRoles();
    roles.child = childCount;
    roles.elder = elderCount;
    roles.builder = builderCount;

    /** @type {Array<{ role: string, count: number, reason: string }>} */
    const unfilled = [];
    for (const role of priority) {
        const wanted = /** @type {Record<string, { need: number }>} */ (needs)[role].need;
        const take = Math.min(wanted, free);
        roles[role] = take;
        free -= take;
        if (take < wanted) {
            unfilled.push({ role, count: wanted - take, reason: `${String(wanted - take)} short: only ${String(take)} free adult(s) for ${String(wanted)} post(s)` });
        }
    }
    roles.none = free;

    /** @type {Array<{ slot: number, role: string }>} */
    const roster = [];
    if (options.withRoster !== false) {
        for (const role of ["builder", "farmer", "guard", "worker", "smith", "none", "child", "elder"]) {
            for (let index = 0; index < roles[role]; index += 1) {
                roster.push({ slot: roster.length, role });
            }
        }
    }

    return {
        districtId,
        name,
        lost: false,
        total: pool,
        roles,
        needs,
        unfilled,
        priority,
        threat,
        reason: unfilled.length > 0 ? "some posts are unfilled" : null,
        roster,
    };
}

/**
 * @param {ReturnType<typeof assignOccupations>} result
 * @returns {string[]} invariant violations (empty when the assignment is sound)
 */
export function occupationProblems(result) {
    /** @type {string[]} */
    const problems = [];
    const sum = ROLES.reduce((total, role) => total + (result.roles[role] ?? 0), 0);
    if (sum !== result.total) {
        problems.push(`roles add to ${String(sum)} but the pool is ${String(result.total)}`);
    }
    if (result.roles.farmer > result.needs.farmer.capacity) {
        problems.push(`${String(result.roles.farmer)} farmers exceed farm capacity ${String(result.needs.farmer.capacity)}`);
    }
    for (const role of ROLES) {
        if ((result.roles[role] ?? 0) < 0) {
            problems.push(`${role} is negative`);
        }
    }
    if (result.roster.length > 0 && result.roster.length !== result.total) {
        problems.push(`roster has ${String(result.roster.length)} entries for ${String(result.total)} people`);
    }
    return problems;
}
