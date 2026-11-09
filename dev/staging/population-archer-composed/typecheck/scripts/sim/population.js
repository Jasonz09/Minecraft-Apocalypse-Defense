import { DISTRICT_DEFAULTS, POPULATION_DEFAULTS, SECURITY_LEVELS } from "../config.js";
import { canAfford, districtById, pushEvent, spend } from "../kingdom/state.js";
import { nextChance, nextFloat } from "./rng.js";

/**
 * Growth, feeding and recruitment.
 *
 * Saved simulation state only - no entities, no `@minecraft/server` import, no world
 * access. Randomness comes from `sim/rng.js` and the advanced cursor is always written
 * back to `kingdom.rngState`, so a seed plus a step count reproduces a kingdom exactly.
 *
 * Rules this module is responsible for:
 *  - every district eats before it grows: `foodDemandPerCivilian` / `foodDemandPerSoldier`,
 *    covered by farm output of `foodPerFarmPerStep` each;
 *  - population climbs toward `civilianCapacity` at `growthPerStepPerHome` per standing
 *    home, and **only** while there is no food shortage and `security` is safe. When it is
 *    suspended the report carries the reason instead of failing silently;
 *  - recruitment moves civilians into `trainingQueue` (never clones them) and training
 *    moves them into `soldiers`; `civilians + trainingQueue + soldiers` is conserved across
 *    both, nothing ever goes negative, and `garrison.front + garrison.reserve` is re-derived
 *    from `DISTRICT_DEFAULTS.frontGarrisonFraction` after every change so the hard validator
 *    in `kingdom/state.js` stays satisfied.
 *
 * Step order owned by the tick: `runPopulationStep(kingdom)` then
 * `advanceTraining(kingdom, district)` for each district in stable id order.
 */

/** Local tunables: config.js names the demand/growth rates but none of these gates. */
export const POPULATION_RULES = {
    /** Security levels that allow growth at all. `POPULATION_DEFAULTS.recruitmentAllowedSecurity` only covers enlistment. */
    growthAllowedSecurity: ["secure"],
    /** Per-step chance of losing a civilian while the district is starving. */
    attritionChance: 0.25,
    /** Full steps of shortage a district rides out before people start dying. */
    starvationGraceSteps: 1,
    /** Cap on the banked fractional growth, so a long pause cannot turn into an instant boom. */
    growthBufferCap: 1,
    /** +- share of randomness applied to farm yield each step. */
    yieldJitter: 0.25,
    /** Cap on the banked fractional training, mirrors growthBufferCap. */
    trainingBufferCap: 1,
};

/**
 * @param {number} value
 * @returns {number}
 */
function intOr0(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
}

/**
 * @param {number} value
 * @returns {number}
 */
function numberOr(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : fallback;
}

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function roundTo(value, digits = 1) {
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

/**
 * Keep the validator's hard garrison invariant true after any change to `soldiers`.
 * Uses the same formula as `makeDistrict()` in kingdom/state.js.
 * @param {any} district
 * @returns {{ front: number, reserve: number }}
 */
export function syncGarrison(district) {
    const soldiers = intOr0(district?.soldiers);
    district.soldiers = soldiers;
    if (district.garrison === null || typeof district.garrison !== "object") {
        district.garrison = { front: 0, reserve: 0 };
    }
    const front = Math.floor(soldiers * Number(DISTRICT_DEFAULTS.frontGarrisonFraction));
    district.garrison.front = front;
    district.garrison.reserve = soldiers - front;
    return district.garrison;
}

/**
 * Standing farm output of a district before the per-step yield draw. Pure, so the
 * construction tests can prove that a finished `farms` project really raises food output.
 * @param {any} district
 * @returns {number}
 */
export function farmFoodOutput(district) {
    return roundTo(intOr0(district?.buildings?.farms) * Number(DISTRICT_DEFAULTS.foodPerFarmPerStep), 2);
}

/**
 * @param {any} district
 * @returns {number} food the district needs this step
 */
export function foodDemand(district) {
    return roundTo(
        intOr0(district?.civilians) * Number(DISTRICT_DEFAULTS.foodDemandPerCivilian)
        + intOr0(district?.soldiers) * Number(DISTRICT_DEFAULTS.foodDemandPerSoldier),
        2,
    );
}

/**
 * @param {any} district
 * @returns {number} civilians that can be enlisted (Builders and trainees are already spoken for)
 */
export function eligibleRecruits(district) {
    const civilians = intOr0(district?.civilians);
    return Math.max(0, civilians - intOr0(district?.builders) - intOr0(district?.trainingQueue));
}

/**
 * One feeding/growing step for the whole kingdom, districts in stable id order.
 *
 * @param {any} kingdom
 * @param {{ pushEvents?: boolean }} [options]
 * @returns {{ events: string[], districts: Array<Record<string, any>>, totals: Record<string, number> }}
 */
export function runPopulationStep(kingdom, options = {}) {
    /** @type {string[]} */
    const events = [];
    /** @type {Array<Record<string, any>>} */
    const reports = [];
    const districts = /** @type {any[]} */ (kingdom?.districts ?? [])
        .slice()
        .sort((left, right) => compareId(left?.id, right?.id));

    let cursor = Number(kingdom?.rngState ?? 0) >>> 0;
    const totals = { demand: 0, produced: 0, consumed: 0, grown: 0, lost: 0, short: 0 };

    for (const district of districts) {
        if (district.reserves === null || typeof district.reserves !== "object") {
            district.reserves = { food: 0, materials: 0, supplies: 0 };
        }
        const demand = foodDemand(district);
        const yieldDraw = nextFloat(cursor);
        cursor = yieldDraw.next;
        const factor = 1 + (yieldDraw.value * 2 - 1) * Number(POPULATION_RULES.yieldJitter);
        const produced = roundTo(farmFoodOutput(district) * factor, 2);

        // Food is balanced at full precision here: rounding the eaten amount down would
        // report a phantom shortage for a district that has plenty (state.js `spend()`
        // rounds reserves to 0.1, so construction costs stay coarse on purpose).
        const stock = numberOr(district.reserves?.food);
        const net = roundTo(stock + produced, 2);
        const consumed = roundTo(Math.min(net, demand), 2);
        district.reserves.food = roundTo(net - consumed, 2);
        const shortage = demand > 0 && consumed + 1e-9 < demand;

        district.foodStress = shortage ? intOr0(district.foodStress) + 1 : 0;
        totals.demand = roundTo(totals.demand + demand, 2);
        totals.produced = roundTo(totals.produced + produced, 2);
        totals.consumed = roundTo(totals.consumed + consumed, 2);

        let lost = 0;
        if (shortage) {
            totals.short += 1;
            if (intOr0(district.foodStress) > Number(POPULATION_RULES.starvationGraceSteps)) {
                const chance = Number(POPULATION_RULES.attritionChance) * intOr0(district.foodStress);
                const draw = nextChance(cursor, Math.min(0.9, chance));
                cursor = draw.next;
                if (draw.value) {
                    lost = Math.min(intOr0(district.civilians), 1);
                    district.civilians = intOr0(district.civilians) - lost;
                }
            }
            events.push(
                `${String(district.name)}: SHORTAGE - needed ${String(demand)} food, had ${String(net)}, ` +
                    `ate ${String(consumed)} (stress step ${String(district.foodStress)})` +
                    (lost > 0 ? `, ${String(lost)} civilian lost to hunger` : ""),
            );
        }

        let grew = 0;
        /** @type {string | null} */
        let reason = null;
        const capacity = intOr0(district.civilianCapacity);
        // Shelter is shared with refugees: evacuation models occupancy as
        // `civilians + refugees <= civilianCapacity`, so growth can only fill the
        // room that guests have not already taken.
        const room = capacity - intOr0(district.refugees);
        if (shortage) {
            reason = "growth suspended: the district is short of food";
        } else if (!POPULATION_RULES.growthAllowedSecurity.includes(String(district.security))) {
            reason =
                `growth suspended: security '${String(district.security)}' is not one of ` +
                `${POPULATION_RULES.growthAllowedSecurity.join("/")} (people do not settle in an emergency)`;
        } else if (intOr0(district.civilians) >= room) {
            district.growthBuffer = 0;
            reason = `growth stopped at shelter room ${String(room)} (capacity ${String(capacity)} - refugees ${String(intOr0(district.refugees))})`;
        } else {
            const homes = intOr0(district.buildings?.homes);
            const rate = roundTo(homes * Number(POPULATION_DEFAULTS.growthPerStepPerHome), 4);
            let buffer = numberOr(district.growthBuffer) + rate;
            while (buffer >= 1 && intOr0(district.civilians) < room) {
                district.civilians = intOr0(district.civilians) + 1;
                buffer = roundTo(buffer - 1, 4);
                grew += 1;
            }
            district.growthBuffer = Math.min(buffer, Number(POPULATION_RULES.growthBufferCap));
            if (grew === 0 && homes <= 0) {
                reason = "growth stalled: the district has no homes to fill";
            }
        }
        district.growthBuffer = roundTo(numberOr(district.growthBuffer), 4);
        totals.grown += grew;
        totals.lost += lost;

        reports.push({
            districtId: String(district.id),
            name: String(district.name),
            demand,
            produced,
            consumed,
            shortage,
            foodStress: intOr0(district.foodStress),
            lost,
            grew,
            civilians: intOr0(district.civilians),
            civilianCapacity: capacity,
            reason,
        });
    }

    kingdom.rngState = cursor >>> 0;
    if (options.pushEvents !== false) {
        events.forEach((event) => pushEvent(kingdom, event));
    }
    return { events, districts: reports, totals };
}

/**
 * @param {any} left
 * @param {any} right
 */
function compareId(left, right) {
    const a = String(left ?? "");
    const b = String(right ?? "");
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}

/**
 * Enlist civilians into the training queue.
 *
 * Bad input is an error, never a silent clamp: fractions, negative counts, more recruits
 * than the district can spare, an over-full queue, an unsafe district or an unaffordable
 * levy all throw with the numbers in the message. Enlistment charges
 * `trainingFoodCostPerRecruit` and `trainingSupplyCostPerRecruit` up front, so a recruit in
 * the queue has already been paid for.
 *
 * @param {any} district
 * @param {number} recruits
 * @param {{ emergency?: boolean, reason?: string, kingdom?: any }} [options]
 * @returns {{ ok: true, districtId: string, recruits: number, trainingQueue: number, civilians: number, cost: Record<string, number> }}
 */
export function openRecruitment(district, recruits, options = {}) {
    if (district === null || typeof district !== "object") {
        throw new Error("openRecruitment: district must be an object");
    }
    if (!Number.isInteger(recruits)) {
        throw new Error(
            `openRecruitment: recruits must be a whole number of people, got ${String(recruits)} ` +
                `(district ${String(district.id)})`,
        );
    }
    if (recruits <= 0) {
        throw new Error(
            `openRecruitment: recruits must be greater than zero, got ${String(recruits)} (district ${String(district.id)})`,
        );
    }

    const label = String(district.name ?? district.id);
    if (!POPULATION_DEFAULTS.recruitmentAllowedSecurity.includes(String(district.security))) {
        throw new Error(
            `openRecruitment: recruitment is suspended in ${label} - security is '${String(district.security)}' ` +
                `and only ${POPULATION_DEFAULTS.recruitmentAllowedSecurity.join("/")} may enlist`,
        );
    }
    if (options.emergency === true) {
        throw new Error(
            `openRecruitment: recruitment is suspended in ${label} - emergency: ${String(options.reason ?? "the district is under attack")}`,
        );
    }

    const available = eligibleRecruits(district);
    if (recruits > available) {
        throw new Error(
            `openRecruitment: ${label} cannot field ${String(recruits)} recruits - only ${String(available)} civilians ` +
                `are free (${String(intOr0(district.civilians))} citizens, ${String(intOr0(district.builders))} building, ` +
                `${String(intOr0(district.trainingQueue))} already in the queue)`,
        );
    }
    const room = intOr0(POPULATION_DEFAULTS.trainingQueueCapacity) - intOr0(district.trainingQueue);
    if (recruits > room) {
        throw new Error(
            `openRecruitment: ${label}'s training queue holds ${String(room)} more recruit(s) of ` +
                `${POPULATION_DEFAULTS.trainingQueueCapacity} - ${String(recruits)} will not fit`,
        );
    }

    /** @type {Record<string, number>} */
    const cost = {
        food: roundTo(recruits * Number(POPULATION_DEFAULTS.trainingFoodCostPerRecruit), 1),
        supplies: roundTo(recruits * Number(POPULATION_DEFAULTS.trainingSupplyCostPerRecruit), 1),
    };
    if (!canAfford(district.reserves, cost)) {
        /** @type {string[]} */
        const short = [];
        for (const [field, amount] of Object.entries(cost)) {
            const have = Number(district.reserves?.[field] ?? 0);
            if (have < Number(amount)) {
                short.push(`${field} ${roundTo(have, 1)} < ${String(amount)}`);
            }
        }
        throw new Error(`openRecruitment: ${label} cannot equip ${String(recruits)} recruit(s) - ${short.join(", ")}`);
    }

    spend(district.reserves, cost);
    district.civilians = intOr0(district.civilians) - recruits;
    district.trainingQueue = intOr0(district.trainingQueue) + recruits;
    district.trainingBuffer = numberOr(district.trainingBuffer);
    // Builders are drawn from the civilian pool, so re-check the ceiling after the transfer.
    if (intOr0(district.builders) > intOr0(district.civilians)) {
        district.builders = intOr0(district.civilians);
    }
    if (options.kingdom !== undefined) {
        pushEvent(
            options.kingdom,
            `${label}: ${String(recruits)} recruit(s) entered training for ` +
                `${JSON.stringify(cost)} (queue ${String(district.trainingQueue)})`,
        );
    }
    return {
        ok: true,
        districtId: String(district.id),
        recruits,
        trainingQueue: intOr0(district.trainingQueue),
        civilians: intOr0(district.civilians),
        cost,
    };
}

/**
 * Finish the recruits a district can train this step.
 *
 * Throughput is `buildings.barracks * recruitsPerStepPerBarracks`, banked fractionally in
 * `district.trainingBuffer`, so one barracks produces a recruit every four steps instead of
 * snapping to whole numbers. When a trainee is inducted he leaves `civilians` (at
 * enlistment) and joins `soldiers` here, and `syncGarrison()` re-derives the front/reserve
 * split so `garrison.front + garrison.reserve === soldiers` always holds.
 *
 * @param {any} kingdom
 * @param {any} district
 * @returns {{ districtId: string, graduated: number, trainingQueue: number, soldiers: number, garrison: any, reason: string | null }}
 */
export function advanceTraining(kingdom, district) {
    if (district === null || typeof district !== "object") {
        throw new Error("advanceTraining: district must be an object");
    }
    if (kingdom !== undefined && districtById(kingdom, String(district.id)) === undefined) {
        throw new Error(`advanceTraining: district ${String(district.id)} is not part of this kingdom`);
    }

    const queue = intOr0(district.trainingQueue);
    /** @type {{ districtId: string, graduated: number, trainingQueue: number, soldiers: number, garrison: any, reason: string | null }} */
    const result = {
        districtId: String(district.id),
        graduated: 0,
        trainingQueue: queue,
        soldiers: intOr0(district.soldiers),
        garrison: district.garrison,
        reason: null,
    };

    if (queue <= 0) {
        district.trainingBuffer = 0;
        result.reason = "no recruits in the training queue";
        return result;
    }

    const barracks = intOr0(district.buildings?.barracks);
    if (barracks <= 0) {
        result.reason = "no barracks - the recruits cannot be trained until a training hall is built";
        return result;
    }

    const perStep = roundTo(barracks * Number(POPULATION_DEFAULTS.recruitsPerStepPerBarracks), 4);
    const buffer = numberOr(district.trainingBuffer) + perStep;
    const graduated = Math.max(0, Math.min(queue, Math.floor(buffer)));
    district.trainingBuffer = roundTo(Math.min(buffer - graduated, Number(POPULATION_RULES.trainingBufferCap)), 4);
    district.trainingQueue = queue - graduated;
    district.soldiers = intOr0(district.soldiers) + graduated;
    result.garrison = syncGarrison(district);

    result.graduated = graduated;
    result.trainingQueue = intOr0(district.trainingQueue);
    result.soldiers = intOr0(district.soldiers);
    result.reason = graduated > 0
        ? null
        : `training ${roundTo(buffer * 100, 1)}% of the way to the next recruit`;
    return result;
}

/**
 * Readiness view for the report layer: what each district could enlist right now.
 * @param {any} kingdom
 * @returns {Array<Record<string, any>>}
 */
export function describeRecruitment(kingdom) {
    const districts = /** @type {any[]} */ (kingdom?.districts ?? []).slice().sort((l, r) => compareId(l?.id, r?.id));
    return districts.map((district) => {
        const allowed = POPULATION_DEFAULTS.recruitmentAllowedSecurity.includes(String(district.security));
        return {
            districtId: String(district.id),
            name: String(district.name),
            security: String(district.security),
            knownSecurityLevels: SECURITY_LEVELS,
            civilians: intOr0(district.civilians),
            civilianCapacity: intOr0(district.civilianCapacity),
            eligible: eligibleRecruits(district),
            trainingQueue: intOr0(district.trainingQueue),
            queueRoom: Math.max(0, intOr0(POPULATION_DEFAULTS.trainingQueueCapacity) - intOr0(district.trainingQueue)),
            barracks: intOr0(district.buildings?.barracks),
            open: allowed,
            reason: allowed ? null : `security '${String(district.security)}' may not enlist`,
        };
    });
}
