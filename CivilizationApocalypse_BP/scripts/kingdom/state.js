import {
    DEFAULT_SEED,
    DISTRICT_DEFAULTS,
    DISTRICT_NAMES,
    GATE_STATES,
    KINGDOM_SCHEMA_VERSION,
    PACK_NAME,
    POLICY_DEFAULTS,
    PROJECT_TYPES,
    SECURITY_LEVELS,
    SIM,
    STARTING_SIMULATION,
    TERRITORY_NAMES,
    TERRITORY_STATES,
} from "../config.js";

/**
 * @param {number} total
 * @param {number} buckets
 * @returns {number[]}
 */
export function splitEvenly(total, buckets) {
    if (!Number.isInteger(total) || total < 0) {
        throw new Error(`splitEvenly: total must be a non-negative integer, got ${String(total)}`);
    }
    if (!Number.isInteger(buckets) || buckets <= 0) {
        throw new Error(`splitEvenly: buckets must be a positive integer, got ${String(buckets)}`);
    }
    const base = Math.floor(total / buckets);
    const remainder = total - base * buckets;
    return Array.from({ length: buckets }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

/**
 * @param {number} amount
 */
function roundTo1(amount) {
    return Math.round(amount * 10) / 10;
}

/**
 * A fully established district: walled, supplied, garrisoned, with housing and farms
 * already standing. Nothing here spawns entities - it is saved simulation state.
 *
 * @param {string} id
 * @param {string} name
 * @param {number} civilians
 * @param {number} soldiers
 * @param {string[]} neighbors
 * @param {string[]} gateTargets
 * @param {number} index
 */
export function makeDistrict(id, name, civilians, soldiers, neighbors, gateTargets, index) {
    const front = Math.floor(soldiers * DISTRICT_DEFAULTS.frontGarrisonFraction);
    return {
        id,
        name,
        seat: index + 1,
        civilians,
        civilianCapacity: DISTRICT_DEFAULTS.homesPerDistrict * DISTRICT_DEFAULTS.capacityPerHome,
        refugees: 0,
        evacuatedTo: null,
        soldiers,
        garrison: { front, reserve: soldiers - front },
        trainingQueue: 0,
        reserves: {
            food: DISTRICT_DEFAULTS.startingFood,
            materials: DISTRICT_DEFAULTS.startingMaterials,
            supplies: DISTRICT_DEFAULTS.startingSupplies,
        },
        buildings: {
            homes: DISTRICT_DEFAULTS.homesPerDistrict,
            farms: DISTRICT_DEFAULTS.farmsPerDistrict,
            storehouses: DISTRICT_DEFAULTS.storehousesPerDistrict,
            barracks: DISTRICT_DEFAULTS.barracksPerDistrict,
            walls: DISTRICT_DEFAULTS.wallsPerDistrict,
        },
        defensiveIntegrity: 100,
        security: "secure",
        assault: 0,
        siegeSteps: 0,
        neighbors,
        gates: gateTargets.map((target) => ({
            id: `gate-${id}-${target}`,
            with: target,
            owner: id,
            state: "open",
        })),
        projects: [],
        builders: 0,
    };
}

/**
 * Shared constructor for a v2 kingdom. Used both for a brand new world and for
 * upgrading a v1 save, so the two paths can never drift apart.
 *
 * @param {{ name?: string, districts?: { id: string, name: string, civilians: number, soldiers: number }[], seed?: number }} input
 */
export function createV2Kingdom(input) {
    const name = typeof input.name === "string" && input.name.length > 0 ? input.name : PACK_NAME;
    const seed = typeof input.seed === "number" && Number.isInteger(input.seed) ? input.seed : DEFAULT_SEED;
    const source = input.districts && input.districts.length > 0 ? input.districts : [];
    const count = source.length;

    const districts = source.map((entry, index) => {
        /** @param {number} offset */
        const wrap = (offset) => (((index + offset) % count) + count) % count;
        /** @param {number} offset */
        const idFor = (offset) => {
            const target = source[wrap(offset)];
            return typeof target?.id === "string" ? target.id : `district-${String(wrap(offset) + 1)}`;
        };
        const neighbors = count === 1 ? [] : count === 2 ? [idFor(1)] : [idFor(-1), idFor(1)];
        const gateTargets = count < 2 ? [] : [idFor(1)];
        return makeDistrict(
            typeof entry.id === "string" ? entry.id : `district-${String(index + 1)}`,
            typeof entry.name === "string" ? entry.name : `District ${String(index + 1)}`,
            entry.civilians,
            entry.soldiers,
            neighbors,
            gateTargets,
            index,
        );
    });

    return {
        schemaVersion: KINGDOM_SCHEMA_VERSION,
        name,
        seed,
        rngState: seed >>> 0,
        step: 0,
        policy: { ...POLICY_DEFAULTS },
        districts,
        territory: TERRITORY_NAMES.map((territoryName, index) => ({
            id: `land-${String(index + 1)}`,
            name: territoryName,
            status: "wild",
            adjacentDistrictId: districts.length > 0 ? districts[index % districts.length].id : null,
            unlockedAtStep: null,
            claimedAtStep: null,
            garrisonRequirement: 20 + index * 5,
            surveyProgress: 0,
        })),
        battles: [],
        log: [],
    };
}

/**
 * @returns {any}
 */
export function createInitialKingdom() {
    const { districtCount, civilians, soldiers } = STARTING_SIMULATION;

    if (DISTRICT_NAMES.length !== districtCount) {
        throw new Error(
            `config.js: DISTRICT_NAMES lists ${String(DISTRICT_NAMES.length)} districts but STARTING_SIMULATION.districtCount is ${String(districtCount)}`,
        );
    }

    const civilianSplit = splitEvenly(civilians, districtCount);
    const soldierSplit = splitEvenly(soldiers, districtCount);

    return createV2Kingdom({
        name: PACK_NAME,
        seed: DEFAULT_SEED,
        districts: DISTRICT_NAMES.map((districtName, index) => ({
            id: `district-${String(index + 1)}`,
            name: districtName,
            civilians: civilianSplit[index],
            soldiers: soldierSplit[index],
        })),
    });
}

/**
 * Totals are derived from the districts so saved state can never drift from them.
 * @param {{ districts: { civilians: number, soldiers: number, refugees?: number }[] }} kingdom
 */
export function computeTotals(kingdom) {
    let civilians = 0;
    let soldiers = 0;
    let refugees = 0;
    for (const district of kingdom.districts) {
        civilians += district.civilians;
        soldiers += district.soldiers;
        refugees += district.refugees ?? 0;
    }
    return { districts: kingdom.districts.length, civilians, soldiers, refugees };
}

/**
 * Shelter is shared: an evacuee counts against its host district's capacity, so
 * occupancy is residents plus refugees. Every system that fills or empties a
 * district must use these two helpers instead of inventing its own formula.
 *
 * @param {{ civilians?: number, refugees?: number, civilianCapacity?: number }} district
 */
export function districtOccupancy(district) {
    return Number(district.civilians ?? 0) + Number(district.refugees ?? 0);
}

/**
 * @param {{ civilians?: number, refugees?: number, civilianCapacity?: number }} district
 */
export function districtHeadroom(district) {
    return Math.max(0, Number(district.civilianCapacity ?? 0) - districtOccupancy(district));
}

/**
 * @param {any} kingdom
 * @param {string} districtId
 */
export function districtById(kingdom, districtId) {
    const list = /** @type {any[]} */ (kingdom.districts ?? []);
    return list.find((district) => district.id === districtId);
}

/**
 * @param {any} kingdom
 * @param {string} text
 */
export function pushEvent(kingdom, text) {
    kingdom.log.unshift({ atStep: kingdom.step, text });
    if (kingdom.log.length > SIM.eventLogLimit) {
        kingdom.log.length = SIM.eventLogLimit;
    }
}

/**
 * @param {any} kingdom
 * @param {any} battle
 */
export function pushBattle(kingdom, battle) {
    kingdom.battles.unshift(battle);
    if (kingdom.battles.length > SIM.battleLogLimit) {
        kingdom.battles.length = SIM.battleLogLimit;
    }
}

/**
 * @param {any} reserves
 * @param {any} cost
 */
export function canAfford(reserves, cost) {
    if (!reserves || typeof reserves !== "object" || !cost || typeof cost !== "object") {
        return false;
    }
    return Object.entries(cost).every(([key, amount]) => Number(reserves[key]) >= Number(amount));
}

/**
 * @param {any} reserves
 * @param {any} cost
 */
export function spend(reserves, cost) {
    if (!canAfford(reserves, cost)) {
        return false;
    }
    for (const [key, amount] of Object.entries(cost)) {
        reserves[key] = roundTo1(Number(reserves[key]) - Number(amount));
    }
    return true;
}

/**
 * @param {any} reserves
 * @param {any} gain
 */
export function grant(reserves, gain) {
    for (const [key, amount] of Object.entries(gain)) {
        reserves[key] = roundTo1(Number(reserves[key] ?? 0) + Number(amount));
    }
}

/**
 * @param {any} value
 * @returns {string[]}
 */
export function findValidationProblems(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return ["kingdom is not an object"];
    }
    if (value.schemaVersion !== KINGDOM_SCHEMA_VERSION) {
        return [`kingdom schemaVersion ${String(value.schemaVersion)}, expected ${String(KINGDOM_SCHEMA_VERSION)}`];
    }
    if (typeof value.name !== "string" || value.name.length === 0) {
        return ["kingdom name must be a non-empty string"];
    }
    if (!Array.isArray(value.districts) || value.districts.length === 0) {
        return ["kingdom must contain at least one district"];
    }

    const /** @type {string[]} */ problems = [];
    const seenIds = new Set();
    const districts = /** @type {any[]} */ (value.districts);
    districts.forEach((district, index) => {
        const label = `district ${String(index)}`;
        if (district === null || typeof district !== "object") {
            problems.push(`${label} is not an object`);
            return;
        }
        if (typeof district.id !== "string" || district.id.length === 0) {
            problems.push(`${label} has no id`);
        } else if (seenIds.has(district.id)) {
            problems.push(`${label} repeats id ${district.id}`);
        } else {
            seenIds.add(district.id);
        }
        if (typeof district.name !== "string" || district.name.length === 0) {
            problems.push(`${label} has no name`);
        }
        for (const field of ["civilians", "soldiers", "refugees", "trainingQueue", "civilianCapacity", "builders"]) {
            const amount = district[field];
            if (!Number.isInteger(amount) || amount < 0) {
                problems.push(`${label}.${field} must be a non-negative integer, got ${String(amount)}`);
            }
        }
        if (
            Number.isInteger(district.civilians) &&
            Number.isInteger(district.refugees) &&
            Number.isInteger(district.civilianCapacity) &&
            district.civilians + district.refugees > district.civilianCapacity
        ) {
            problems.push(
                `${label} is over shelter: ${String(district.civilians)} civilians + ${String(district.refugees)} refugees exceed capacity ${String(district.civilianCapacity)}`,
            );
        }
        if (district.security !== undefined && !SECURITY_LEVELS.includes(district.security)) {
            problems.push(`${label}.security '${String(district.security)}' is not one of ${SECURITY_LEVELS.join("/")}`);
        }
        if (typeof district.defensiveIntegrity !== "number" || district.defensiveIntegrity < 0 || district.defensiveIntegrity > 100) {
            problems.push(`${label}.defensiveIntegrity must be 0..100, got ${String(district.defensiveIntegrity)}`);
        }
        if (district.garrison !== undefined) {
            const front = district.garrison.front;
            const reserve = district.garrison.reserve;
            if (!Number.isInteger(front) || !Number.isInteger(reserve) || front < 0 || reserve < 0) {
                problems.push(`${label}.garrison must hold non-negative integers`);
            } else if (Number.isInteger(district.soldiers) && front + reserve !== district.soldiers) {
                problems.push(`${label}.garrison front+reserve (${String(front)}+${String(reserve)}) must equal soldiers (${String(district.soldiers)})`);
            }
        }
        if (district.reserves !== undefined) {
            for (const field of ["food", "materials", "supplies"]) {
                const amount = district.reserves[field];
                if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
                    problems.push(`${label}.reserves.${field} must be a non-negative number, got ${String(amount)}`);
                }
            }
        }
        if (Array.isArray(district.gates)) {
            const gates = /** @type {any[]} */ (district.gates);
            gates.forEach((gate, gateIndex) => {
                if (typeof gate?.id !== "string" || typeof gate?.with !== "string") {
                    problems.push(`${label}.gate ${String(gateIndex)} needs an id and a partner district`);
                } else if (gate.state !== undefined && !GATE_STATES.includes(gate.state)) {
                    problems.push(`${label}.gate ${String(gateIndex)}.state '${String(gate.state)}' is not one of ${GATE_STATES.join("/")}`);
                }
            });
        }
        if (district.physical !== undefined) {
            const physical = district.physical;
            const origin = physical?.origin;
            if (typeof physical !== "object" || physical === null) {
                problems.push(`${label}.physical must be an object`);
            } else {
                if (physical.status !== "building" && physical.status !== "complete") {
                    problems.push(`${label}.physical.status must be building or complete`);
                }
                if (typeof physical.layout !== "string" || typeof physical.planHash !== "string") {
                    problems.push(`${label}.physical needs a layout id and plan hash`);
                }
                for (const field of ["placed", "total", "version"]) {
                    if (!Number.isInteger(physical[field]) || physical[field] < 0) {
                        problems.push(`${label}.physical.${field} must be a non-negative integer`);
                    }
                }
                if (physical.built !== undefined && (physical.built === null || typeof physical.built !== "object" || !Object.values(physical.built).every((count) => Number.isInteger(count) && /** @type {number} */ (count) >= 0))) {
                    problems.push(`${label}.physical.built must map building kinds to non-negative integers`);
                }
                if (origin === null || typeof origin !== "object" || !["x", "y", "z"].every((axis) => Number.isInteger(origin[axis]))) {
                    problems.push(`${label}.physical.origin must hold integer x, y, z`);
                }
            }
        }
        if (Array.isArray(district.projects)) {
            const projects = /** @type {any[]} */ (district.projects);
            const catalogue = /** @type {Record<string, any>} */ (PROJECT_TYPES);
            projects.forEach((project, projectIndex) => {
                const kind = project?.kind;
                if (typeof kind !== "string" || catalogue[kind] === undefined) {
                    problems.push(`${label}.project ${String(projectIndex)} has unknown kind '${String(kind)}'`);
                    return;
                }
                const definition = catalogue[kind];
                if (!Number.isInteger(project.stage) || project.stage < 0 || project.stage > definition.stages) {
                    problems.push(`${label}.project ${String(projectIndex)}.stage must be 0..${String(definition.stages)}`);
                }
                if (!Number.isInteger(project.builders) || project.builders < 0) {
                    problems.push(`${label}.project ${String(projectIndex)}.builders must be a non-negative integer`);
                }
            });
        }
    });

    const districtIds = [...seenIds];
    for (const district of districts) {
        if (!Array.isArray(district?.neighbors)) {
            problems.push(`${String(district?.id)} has no neighbor list`);
            continue;
        }
        for (const neighbor of district.neighbors) {
            if (!districtIds.includes(neighbor)) {
                problems.push(`district ${String(district.id)} links to unknown neighbor ${String(neighbor)}`);
            }
            if (neighbor === district.id) {
                problems.push(`district ${String(district.id)} lists itself as a neighbor`);
            }
        }
        for (const gate of district.gates ?? []) {
            if (!districtIds.includes(gate.with)) {
                problems.push(`gate ${String(gate.id)} links to unknown district ${String(gate.with)}`);
            }
            if (gate.owner !== district.id) {
                problems.push(`gate ${String(gate.id)} is owned by ${String(gate.owner)} but listed under ${String(district.id)}`);
            }
        }
    }

    if (Array.isArray(value.territory)) {
        const territories = /** @type {any[]} */ (value.territory);
        territories.forEach((land, index) => {
            if (typeof land?.id !== "string" || typeof land?.name !== "string") {
                problems.push(`territory ${String(index)} needs an id and a name`);
            }
            if (land?.status !== undefined && !TERRITORY_STATES.includes(land.status)) {
                problems.push(`territory ${String(land.id)}.status '${String(land.status)}' is not one of ${TERRITORY_STATES.join("/")}`);
            }
            if (land?.adjacentDistrictId !== null && !districtIds.includes(land?.adjacentDistrictId)) {
                problems.push(`territory ${String(land?.id)} is adjacent to unknown district ${String(land?.adjacentDistrictId)}`);
            }
        });
    }

    for (const field of ["step", "seed"]) {
        if (!Number.isInteger(value[field]) || value[field] < 0) {
            problems.push(`kingdom.${field} must be a non-negative integer, got ${String(value[field])}`);
        }
    }
    if (!Number.isInteger(value.rngState) || value.rngState < 0) {
        problems.push(`kingdom.rngState must be a non-negative integer, got ${String(value.rngState)}`);
    }
    if (value.policy === null || typeof value.policy !== "object") {
        problems.push("kingdom.policy must be an object");
    }

    return problems;
}

/**
 * @param {any} kingdom
 * @returns {string}
 */
export function serializeKingdom(kingdom) {
    const problems = findValidationProblems(kingdom);
    if (problems.length > 0) {
        throw new Error(`refusing to save invalid kingdom state: ${problems.join("; ")}`);
    }
    return JSON.stringify(kingdom);
}

/**
 * @param {string} raw
 * @returns {{ kingdom: any, reason: string | undefined }}
 */
export function deserializeKingdom(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { kingdom: undefined, reason: `saved state is not valid JSON (${String(error)})` };
    }
    const problems = findValidationProblems(parsed);
    if (problems.length > 0) {
        return { kingdom: undefined, reason: problems.join("; ") };
    }
    return { kingdom: parsed, reason: undefined };
}
