/**
 * Soldier patrols along a district's wall circuit.
 *
 * Pure and deterministic. The save records a district's walls as a count and its gates as a
 * list, so the circuit is built here from those records:
 *   - the wall is `sectionCount` wall sections in order around the district (default
 *     `WALL_RULES.sectionsPerDistrict`; the physical layer may pass real section ids instead);
 *   - each gate is placed on the circuit at an evenly spaced section, in the order the district
 *     lists its gates, so the same record always gives the same route;
 *   - a route is an ordered list of gate and wall-section ids.
 *
 * Only the front garrison walks the wall (`garrison.front`); the reserve stays in the district.
 * Groups of about `soldiersPerGroup` soldiers each take one sector of the circuit. There is one
 * sector per group, so at every step each wall section is watched by exactly one group. Every
 * `rotationSteps` steps the groups move on to the next sector. Over one full rotation cycle
 * (`groups * rotationSteps` steps) every group has walked every sector, so no soldier is left
 * on the same stretch of wall all day.
 *
 * A `lost` district has no patrols. A district with no front garrison has no patrols, and every
 * section is reported uncovered with the reason.
 */

/** Tunables local to this module. */
export const PATROL_RULES = Object.freeze({
    /** Wall sections in a district's circuit when the caller gives no section ids. */
    sectionsPerDistrict: 8,
    /** Soldiers in one patrol group, the target size before the sector count is capped. */
    soldiersPerGroup: 4,
    /** Steps a group holds one sector before rotating to the next. */
    rotationSteps: 4,
});

/**
 * @param {any} value
 * @returns {number}
 */
function count(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

/**
 * Default wall section ids for a district, `<id>/wall-01` .. `<id>/wall-NN`.
 * @param {string} districtId
 * @param {number} [sections]
 * @returns {string[]}
 */
export function defaultWallSections(districtId, sections = PATROL_RULES.sectionsPerDistrict) {
    return Array.from({ length: sections }, (_unused, index) => `${districtId}/wall-${String(index + 1).padStart(2, "0")}`);
}

/**
 * The ordered circuit: every gate sits immediately before the wall section it is placed at.
 *
 * @param {any} district
 * @param {string[]} [wallSections] ordered section ids; defaults to `defaultWallSections`
 * @returns {Array<{ id: string, kind: "gate" | "section", sectionIndex: number, state: string | null }>}
 */
export function wallCircuit(district, wallSections) {
    const districtId = String(district.id);
    const sections = wallSections !== undefined && wallSections.length > 0 ? wallSections.map(String) : defaultWallSections(districtId);
    /** @type {any[]} */
    const gates = Array.isArray(district.gates) ? district.gates : [];
    /** @type {Array<Array<{ id: string, state: string | null }>>} */
    const gatesAt = sections.map(() => []);
    gates.forEach((gate, index) => {
        const position = Math.min(sections.length - 1, Math.floor((index * sections.length) / gates.length));
        gatesAt[position].push({ id: String(gate.id), state: gate.state === undefined ? null : String(gate.state) });
    });

    /** @type {Array<{ id: string, kind: "gate" | "section", sectionIndex: number, state: string | null }>} */
    const circuit = [];
    sections.forEach((section, position) => {
        for (const gate of gatesAt[position]) {
            circuit.push({ id: gate.id, kind: "gate", sectionIndex: position, state: gate.state });
        }
        circuit.push({ id: section, kind: "section", sectionIndex: position, state: null });
    });
    return circuit;
}

/**
 * Plan the patrols for one district at one step.
 *
 * @param {any} district a PeopleDistrict
 * @param {{ step?: number, wallSections?: string[], sectionCount?: number }} [options]
 * @returns {{
 *   districtId: string, lost: boolean, reason: string | null,
 *   sections: string[], circuit: string[], groupCount: number, rotationSteps: number, cycleSteps: number,
 *   groups: Array<{ id: string, soldiers: number, sector: number, sectorSections: string[], route: string[], stop: string | null }>,
 *   covered: string[], uncovered: string[]
 * }}
 */
export function planPatrols(district, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("planPatrols: district must be an object");
    }
    const districtId = String(district.id);
    const step = Number.isInteger(options.step) ? Number(options.step) : 0;
    const circuit = wallCircuit(district, options.wallSections ?? defaultWallSections(districtId, options.sectionCount ?? PATROL_RULES.sectionsPerDistrict));
    const sections = circuit.filter((item) => item.kind === "section").map((item) => item.id);
    if (new Set(sections).size !== sections.length) {
        throw new Error(`planPatrols: district ${districtId} lists a wall section more than once`);
    }
    const circuitIds = circuit.map((item) => item.id);

    if (String(district.security) === "lost") {
        return {
            districtId, lost: true, reason: "district lost: no patrols", sections: [], circuit: [], groupCount: 0,
            rotationSteps: PATROL_RULES.rotationSteps, cycleSteps: 0, groups: [], covered: [], uncovered: [],
        };
    }

    const front = count(district.garrison?.front);
    const sectionCount = sections.length;
    const groupCount = front > 0 ? Math.min(sectionCount, Math.max(1, Math.floor(front / PATROL_RULES.soldiersPerGroup))) : 0;
    if (groupCount === 0) {
        return {
            districtId, lost: false, reason: "no front garrison: nobody walks the wall", sections, circuit: circuitIds,
            groupCount: 0, rotationSteps: PATROL_RULES.rotationSteps, cycleSteps: 0, groups: [], covered: [], uncovered: [...sections],
        };
    }

    // Sector s holds sections [floor(s*S/G), floor((s+1)*S/G)); every section belongs to exactly one.
    /** @type {number[]} */
    const sectorOf = new Array(sectionCount).fill(0);
    for (let sector = 0; sector < groupCount; sector += 1) {
        const from = Math.floor((sector * sectionCount) / groupCount);
        const to = Math.floor(((sector + 1) * sectionCount) / groupCount);
        for (let position = from; position < to; position += 1) {
            sectorOf[position] = sector;
        }
    }

    const base = Math.floor(front / groupCount);
    const extra = front % groupCount;
    const rotation = Math.floor(step / PATROL_RULES.rotationSteps);

    /** @type {Array<{ id: string, soldiers: number, sector: number, sectorSections: string[], route: string[], stop: string | null }>} */
    const groups = [];
    /** @type {Set<string>} */
    const covered = new Set();
    for (let index = 0; index < groupCount; index += 1) {
        const sector = (index + rotation) % groupCount;
        const sectorSections = sections.filter((_section, position) => sectorOf[position] === sector);
        const route = circuit.filter((item) => sectorOf[item.sectionIndex] === sector).map((item) => item.id);
        const stop = route.length > 0 ? route[step % route.length] : null;
        for (const section of sectorSections) {
            covered.add(section);
        }
        groups.push({
            id: `${districtId}:patrol-${String(index + 1)}`,
            soldiers: base + (index < extra ? 1 : 0),
            sector,
            sectorSections,
            route,
            stop,
        });
    }

    return {
        districtId,
        lost: false,
        reason: null,
        sections,
        circuit: circuitIds,
        groupCount,
        rotationSteps: PATROL_RULES.rotationSteps,
        cycleSteps: groupCount * PATROL_RULES.rotationSteps,
        groups,
        covered: sections.filter((section) => covered.has(section)),
        uncovered: sections.filter((section) => !covered.has(section)),
    };
}

/**
 * Walk one full rotation cycle and count how often each section is watched, and how many
 * distinct sectors each group visits. Pure: runs `planPatrols` for each step in the cycle.
 *
 * @param {any} district
 * @param {{ startStep?: number, wallSections?: string[], sectionCount?: number }} [options]
 * @returns {{ cycleSteps: number, watches: Record<string, number>, sectorsVisited: Record<string, number>, uncoveredSteps: number }}
 */
export function coverageOverCycle(district, options = {}) {
    const first = Number.isInteger(options.startStep) ? Number(options.startStep) : 0;
    const probe = planPatrols(district, { step: first, wallSections: options.wallSections, sectionCount: options.sectionCount });
    const cycleSteps = probe.cycleSteps;
    /** @type {Record<string, number>} */
    const watches = {};
    for (const section of probe.sections) {
        watches[section] = 0;
    }
    /** @type {Record<string, Set<number>>} */
    const visited = {};
    let uncoveredSteps = 0;
    for (let offset = 0; offset < cycleSteps; offset += 1) {
        const plan = planPatrols(district, { step: first + offset, wallSections: options.wallSections, sectionCount: options.sectionCount });
        if (plan.uncovered.length > 0) {
            uncoveredSteps += 1;
        }
        for (const section of plan.covered) {
            watches[section] += 1;
        }
        for (const group of plan.groups) {
            if (visited[group.id] === undefined) {
                visited[group.id] = new Set();
            }
            visited[group.id].add(group.sector);
        }
    }
    /** @type {Record<string, number>} */
    const sectorsVisited = {};
    for (const [groupId, sectors] of Object.entries(visited)) {
        sectorsVisited[groupId] = sectors.size;
    }
    return { cycleSteps, watches, sectorsVisited, uncoveredSteps };
}
