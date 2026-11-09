import { DISTRICT_DEFAULTS, PROJECT_TYPES } from "../config.js";
import { canAfford, computeTotals, grant } from "../kingdom/state.js";
import { collectBuildQueue, scheduleProject } from "./construction.js";
import { establishMilitaryControl } from "./expansion.js";
import { farmFoodOutput, foodDemand, openRecruitment } from "./population.js";

/**
 * Strategic policies: the decisions the kingdom makes on its own between steps.
 *
 * The individual systems (war, evacuation, construction, expansion, population) only do
 * what they are told. Without this layer the kingdom is reactive: it loses soldiers to
 * every siege and never replaces them, and it never decides to build anything, so
 * "autonomous" expansion never actually happens. These policies are deliberately dumb and
 * bounded - one decision per district per step - and they suspend themselves during
 * shortages or emergencies.
 */

const POLICY_RULES = {
    /** Share of the people under arms that a district tries to keep trained. */
    garrisonTargetFraction: 0.2,
    /** Men sent into the training queue per district per step. */
    recruitBatchPerStep: 2,
    /** Equipping a recruit costs supplies; a district below this keeps its people at home. */
    minSuppliesPerLevy: 6,
    /** A district at or above this shelter share asks for homes. */
    shelterPressure: 0.85,
    /** Only this many projects may be open on one district at a time. */
    maxOpenProjectsPerDistrict: 3,
    /** Development only happens on land the enemy is not currently walking through. */
    developmentSecurity: ["secure", "alert"],
    recruitmentSecurity: ["secure"],
    /** Kinds a settled district may schedule itself. Walls already stand and are permanent. */
    developmentKinds: ["farms", "homes", "storehouse", "barracks", "road"],
};

/**
 * @param {any} district
 */
export function desiredGarrison(district) {
    const people = Number(district.civilians ?? 0);
    return Math.max(0, Math.round(people * Number(POLICY_RULES.garrisonTargetFraction)));
}

/**
 * @param {any} district
 */
export function garrisonShortfall(district) {
    return Math.max(0, desiredGarrison(district) - Number(district.soldiers ?? 0) - Number(district.trainingQueue ?? 0));
}

/**
 * True when the district can still feed itself after today's demand.
 * @param {any} district
 */
export function hasFoodSurplus(district) {
    return Number(district.reserves.food ?? 0) - foodDemand(district) > 0;
}

/**
 * @param {any} district
 */
export function isStarving(district) {
    return farmFoodOutput(district) < foodDemand(district);
}

/**
 * @param {any} district
 */
export function shelterPressureOf(district) {
    const capacity = Number(district.civilianCapacity ?? 0);
    if (capacity <= 0) {
        return 1;
    }
    return (Number(district.civilians ?? 0) + Number(district.refugees ?? 0)) / capacity;
}

/**
 * @param {any} kingdom
 * @param {any} district
 * @returns {{ kind: string, reason: string } | undefined}
 */
export function nextDevelopmentWork(kingdom, district) {
    const open = /** @type {any[]} */ (district.projects ?? []).filter((project) => project.status !== "complete");
    if (open.length >= Number(POLICY_RULES.maxOpenProjectsPerDistrict)) {
        return undefined;
    }

    if (isStarving(district) && !open.some((project) => project.kind === "farms")) {
        return { kind: "farms", reason: `${district.name} cannot feed its people from its own farms` };
    }
    if (shelterPressureOf(district) >= Number(POLICY_RULES.shelterPressure) && !open.some((project) => project.kind === "homes")) {
        return { kind: "homes", reason: `${district.name} is at ${String(Math.round(shelterPressureOf(district) * 100))}% of shelter` };
    }
    if (Number(district.buildings.storehouses ?? 0) < Number(DISTRICT_DEFAULTS.storehousesPerDistrict) && !open.some((project) => project.kind === "storehouse")) {
        return { kind: "storehouse", reason: `${district.name} is short of storehouses` };
    }
    if (Number(district.soldiers ?? 0) > 0 && Number(district.buildings.barracks ?? 0) < 1 && !open.some((project) => project.kind === "barracks")) {
        return { kind: "barracks", reason: `${district.name} keeps troops with no barracks` };
    }
    return undefined;
}

/**
 * Non-food production. Without it a kingdom can only ever spend its way to zero: farms
 * make food, but nothing replenished the materials and supplies that construction,
 * repairs and recruitment all draw down. Output is tied to standing infrastructure and to
 * the labour that is not already manning a wall, a project or a training field.
 */
const ECONOMY_RULES = {
    suppliesPerStorehousePerStep: DISTRICT_DEFAULTS.suppliesPerStep,
    materialsPerWorkGangPerStep: DISTRICT_DEFAULTS.materialsPerStep,
    civiliansPerWorkGang: 20,
    /** A district cannot stockpile without limit; storehouses set the ceiling. */
    stockpilePerStorehouse: 250,
    minStockpile: 200,
};

/**
 * @param {any} district
 */
export function stockpileCeiling(district) {
    return Math.max(
        Number(ECONOMY_RULES.minStockpile),
        Number(district.buildings?.storehouses ?? 0) * Number(ECONOMY_RULES.stockpilePerStorehouse),
    );
}

/**
 * @param {any} district
 */
function workGangs(district) {
    const available = Math.max(
        0,
        Number(district.civilians ?? 0) - Number(district.builders ?? 0) - Number(district.trainingQueue ?? 0),
    );
    return Math.floor(available / Number(ECONOMY_RULES.civiliansPerWorkGang));
}

/**
 * Adds this step's materials and supplies, honouring the storehouse ceiling.
 *
 * @param {any} kingdom
 * @returns {string[]}
 */
export function runEconomyStep(kingdom) {
    const /** @type {string[]} */ events = [];
    for (const district of [.../** @type {any[]} */ (kingdom.districts ?? [])].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
        const ceiling = stockpileCeiling(district);
        const gangs = workGangs(district);
        const materials = Number(ECONOMY_RULES.materialsPerWorkGangPerStep) * gangs;
        const supplies = Number(ECONOMY_RULES.suppliesPerStorehousePerStep) * Number(district.buildings?.storehouses ?? 0);

        const gains = /** @type {[string, number][]} */ ([["materials", materials], ["supplies", supplies]]);
        for (const [field, gain] of gains) {
            if (gain <= 0) {
                continue;
            }
            const current = Number(district.reserves[field] ?? 0);
            if (current >= ceiling) {
                continue;
            }
            const added = Math.min(gain, ceiling - current);
            grant(district.reserves, { [field]: Math.round(added * 10) / 10 });
            if (current < ceiling && current + added >= ceiling) {
                events.push(`${district.name} has filled its storehouses to ${String(ceiling)}.`);
            }
        }
    }
    return events;
}

/**
 * Committing to ground we have beaten. `runExpansionStep` will only claim land that is
 * already under military control, and a victory alone leaves a territory at `raided` - so
 * without this the expansion pipeline stalls forever. Occupying opened land is a policy
 * decision, bounded to one territory per step, and it is refused outright while expansion
 * is paused.
 *
 * @param {any} kingdom
 * @returns {string[]}
 */
export function runExpansionPolicy(kingdom) {
    if (String(kingdom?.policy?.expansion) === "paused") {
        return [];
    }
    const events = [];
    const lands = [.../** @type {any[]} */ (kingdom.territory ?? [])].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    for (const land of lands) {
        if (String(land.status) !== "raided") {
            continue;
        }
        const control = establishMilitaryControl(kingdom, String(land.id), {});
        if (control && control.ok !== false) {
            events.push(`${land.name} was won beyond the border - the banner is raised and military control is established.`);
            break;
        }
        events.push(`Could not occupy ${String(land.name)}: ${String(control?.reason ?? "military control refused")}`);
        break;
    }
    return events;
}

/**
 * One bounded policy pass. Called from sim/tick.js after expansion and before population.
 *
 * @param {any} kingdom
 * @returns {string[]}
 */
export function runPolicyStep(kingdom) {
    const /** @type {string[]} */ events = [];
    events.push(...runEconomyStep(kingdom));
    events.push(...runExpansionPolicy(kingdom));
    const districts = [.../** @type {any[]} */ (kingdom.districts ?? [])].sort((left, right) => String(left.id).localeCompare(String(right.id)));

    for (const district of districts) {
        // Recruitment: only on safe land, only while the stores can stand it.
        const shortfall = garrisonShortfall(district);
        if (
            POLICY_RULES.recruitmentSecurity.includes(String(district.security)) &&
            shortfall > 0 &&
            hasFoodSurplus(district) &&
            Number(district.civilians ?? 0) > 1 &&
            Number(district.reserves.supplies ?? 0) >= Number(POLICY_RULES.minSuppliesPerLevy)
        ) {
            const asking = Math.min(Number(POLICY_RULES.recruitBatchPerStep), shortfall, Math.max(0, Number(district.civilians) - 1));
            if (asking > 0) {
                try {
                const levy = /** @type {any} */ (openRecruitment(district, asking, {}));
                    if (levy && levy.ok === true) {
                        events.push(`${district.name} sends ${String(levy.recruits)} recruit(s) to the training queue (needs ${String(shortfall)} more hands on the wall).`);
                    } else if (levy && levy.ok === false) {
                        events.push(`${district.name} wanted ${String(asking)} recruits but could not: ${String(levy.reason ?? "recruitment refused")}`);
                    }
                } catch (error) {
                    events.push(`${district.name} recruitment refused: ${String(error)}`);
                }
            }
        }

        // Development: secured land feeds and houses itself before it grows any further.
        if (POLICY_RULES.developmentSecurity.includes(String(district.security))) {
            const work = nextDevelopmentWork(kingdom, district);
            if (work !== undefined) {
                const catalogue = /** @type {Record<string, any>} */ (PROJECT_TYPES);
                const cost = catalogue[work.kind]?.cost;
                if (cost !== undefined && canAfford(district.reserves, cost)) {
                    try {
                        scheduleProject(district, work.kind, { atStep: Number(kingdom.step) });
                        events.push(`${district.name}: ${work.reason} - a ${work.kind} project is scheduled.`);
                    } catch (error) {
                        events.push(`${district.name} could not schedule ${work.kind}: ${String(error)}`);
                    }
                } else {
                    events.push(`${district.name} needs ${work.kind} but cannot pay for the first stage yet.`);
                }
            }
        }
    }

    return events;
}

/**
 * A compact readout of what the policies think, for the status report.
 * @param {any} kingdom
 */
export function describePolicies(kingdom) {
    const totals = computeTotals(kingdom);
    const openProjects = /** @type {any[]} */ (kingdom.districts ?? []).reduce((sum, district) => {
        const projects = /** @type {any[]} */ (district.projects ?? []);
        return sum + projects.filter((project) => project.status !== "complete").length;
    }, 0);
    return {
        underArms: totals.soldiers,
        target: /** @type {any[]} */ (kingdom.districts ?? []).reduce((sum, district) => sum + desiredGarrison(district), 0),
        training: /** @type {any[]} */ (kingdom.districts ?? []).reduce((sum, district) => sum + Number(district.trainingQueue ?? 0), 0),
        openProjects,
        queuedBlocks: collectBuildQueue(kingdom, 64).length,
        districtCount: totals.districts,
    };
}

export const POLICY_DECISION_RULES = POLICY_RULES;
