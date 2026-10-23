/**
 * Equipment tiers for soldiers, paid for from the district's own stores.
 *
 * Pure. Nothing here writes to the save. The caller applies the returned `spent` with its own
 * subtraction, and the tests check that no store can go negative.
 *
 * Tiers (per soldier):
 *   0 militia           no kit (only if a record says so)
 *   1 spear and shield  the basic kit. Issued at enlistment (population.openRecruitment already
 *                       charges `trainingSupplyCostPerRecruit`), so the 150 starting soldiers are
 *                       assumed to hold it. Upgrading 0 -> 1 costs `supplies` for the issue.
 *   2 mail              needs one barracks
 *   3 iron              needs two barracks (an armoury)
 *
 * Rules:
 *  - a soldier only moves UP, one tier per upgrade, lowest tier first, so the front is equipped
 *    before the reserve has any upgrades;
 *  - each step, a district can upgrade at most `upgradesPerBarrackPerStep` soldiers per barracks;
 *  - upgrades may spend at most `maxStockShare` of a store per step, so construction, repairs
 *    and recruitment are never starved by the armoury;
 *  - equipment never creates or removes soldiers: the tier counts always sum to `soldiers`.
 *
 * The save does not record tiers yet. `recorded` is the caller's record of tier counts; when it
 * is absent every soldier is treated as tier 1. See docs/PEOPLE_ROLES.md.
 */

/** Per-soldier tier table. `upgradeCost` is what moving a soldier INTO this tier costs. */
export const EQUIPMENT_TIERS = Object.freeze([
    Object.freeze({ tier: 0, name: "militia", upgradeCost: null, minBarracks: 0 }),
    Object.freeze({ tier: 1, name: "spear and shield", upgradeCost: Object.freeze({ supplies: 2 }), minBarracks: 0 }),
    Object.freeze({ tier: 2, name: "mail", upgradeCost: Object.freeze({ materials: 4, supplies: 2 }), minBarracks: 1 }),
    Object.freeze({ tier: 3, name: "iron", upgradeCost: Object.freeze({ materials: 8, supplies: 3 }), minBarracks: 2 }),
]);

/** Tunables local to this module. */
export const EQUIPMENT_RULES = Object.freeze({
    /** Soldiers one barracks can equip per step. */
    upgradesPerBarrackPerStep: 1,
    /** Share of a store one district may spend on equipment in a single step. */
    maxStockShare: 0.25,
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
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
    return Math.round(value * 100) / 100;
}

/**
 * Highest tier this district's barracks can equip.
 * @param {any} district
 * @returns {number}
 */
export function maxTierFor(district) {
    const barracks = count(district?.buildings?.barracks);
    let best = 1;
    for (const entry of EQUIPMENT_TIERS) {
        if (entry.tier >= 1 && barracks >= entry.minBarracks) {
            best = Math.max(best, entry.tier);
        }
    }
    return best;
}

/**
 * Tier counts for a district's soldiers. `recorded` maps tier -> number of soldiers; it defaults to
 * "everyone is tier 1". It must add up to `soldiers` exactly, or the call throws.
 *
 * @param {any} district
 * @param {Record<string, number> | null} [recorded]
 * @returns {Record<string, number>}
 */
export function tierCounts(district, recorded = null) {
    const soldiers = count(district?.soldiers);
    /** @type {Record<string, number>} */
    const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    if (recorded === null) {
        counts[1] = soldiers;
        return counts;
    }
    let total = 0;
    for (const [key, value] of Object.entries(recorded)) {
        if (!(key in counts)) {
            throw new Error(`tierCounts: unknown tier '${key}' in the record for ${String(district?.id)}`);
        }
        const amount = Number(value);
        if (!Number.isInteger(amount) || amount < 0) {
            throw new Error(`tierCounts: tier ${key} must be a non-negative whole number, got ${String(value)}`);
        }
        counts[key] = amount;
        total += amount;
    }
    if (total !== soldiers) {
        throw new Error(`tierCounts: ${String(district?.id)} records ${String(total)} equipped soldier(s) but has ${String(soldiers)}`);
    }
    return counts;
}

/**
 * Plan one step of equipment upgrades for one district.
 *
 * @param {any} district a PeopleDistrict
 * @param {Record<string, number> | null} [recorded] tier counts; null means everyone is tier 1
 * @returns {{
 *   districtId: string, lost: boolean, soldiers: number, maxTier: number, throughput: number,
 *   before: Record<string, number>, after: Record<string, number>,
 *   upgrades: Array<{ from: number, to: number, count: number, cost: Record<string, number> }>,
 *   spent: Record<string, number>, reserves: { before: Record<string, number>, after: Record<string, number> },
 *   reason: string | null
 * }}
 */
export function planEquipment(district, recorded = null) {
    if (district === null || typeof district !== "object") {
        throw new Error("planEquipment: district must be an object");
    }
    const districtId = String(district.id);
    const soldiers = count(district.soldiers);
    const before = tierCounts(district, recorded);
    const stock = {
        materials: Math.max(0, Number(district.reserves?.materials ?? 0)),
        supplies: Math.max(0, Number(district.reserves?.supplies ?? 0)),
    };
    const reservesBefore = { materials: stock.materials, supplies: stock.supplies };
    const maxTier = maxTierFor(district);
    const throughput = count(district.buildings?.barracks) * EQUIPMENT_RULES.upgradesPerBarrackPerStep;

    if (String(district.security) === "lost") {
        return {
            districtId, lost: true, soldiers, maxTier, throughput: 0, before, after: before, upgrades: [], spent: {},
            reserves: { before: reservesBefore, after: reservesBefore }, reason: "district lost: no equipment work",
        };
    }

    const allowance = {
        materials: stock.materials * EQUIPMENT_RULES.maxStockShare,
        supplies: stock.supplies * EQUIPMENT_RULES.maxStockShare,
    };
    /** @type {Record<string, number>} */
    const spent = {};
    /** @type {Record<string, number>} */
    const after = { ...before };
    /** @type {Array<{ from: number, to: number, count: number, cost: Record<string, number> }>} */
    const upgrades = [];
    let left = throughput;
    /** @type {string | null} */
    let reason = null;

    for (let from = 0; from < maxTier && left > 0; from += 1) {
        const to = from + 1;
        const entry = EQUIPMENT_TIERS[to];
        const cost = entry.upgradeCost;
        if (cost === null || cost === undefined) {
            continue;
        }
        const costEntries = Object.entries(cost);
        while (left > 0 && after[from] > 0) {
            // How many soldiers the remaining allowance pays for, at this tier's price.
            let affordable = Infinity;
            for (const [key, unit] of costEntries) {
                const available = allowance[/** @type {"materials" | "supplies"} */ (key)] - (spent[key] ?? 0);
                affordable = Math.min(affordable, Math.floor(round2(available) / Number(unit) + 1e-9));
            }
            const batch = Math.min(after[from], left, Math.max(0, affordable));
            if (batch <= 0) {
                reason = `equipment paused: the stores allow ${String(EQUIPMENT_RULES.maxStockShare * 100)}% of materials and supplies per step`;
                break;
            }
            /** @type {Record<string, number>} */
            const batchCost = {};
            for (const [key, unit] of costEntries) {
                batchCost[key] = round2(Number(unit) * batch);
                spent[key] = round2((spent[key] ?? 0) + batchCost[key]);
            }
            after[from] -= batch;
            after[to] += batch;
            left -= batch;
            upgrades.push({ from, to, count: batch, cost: batchCost });
        }
        if (reason !== null) {
            break;
        }
    }

    const reservesAfter = {
        materials: round2(stock.materials - (spent.materials ?? 0)),
        supplies: round2(stock.supplies - (spent.supplies ?? 0)),
    };
    if (reason === null && left > 0 && maxTier > 1 && throughput > 0 && upgrades.length === 0) {
        reason = "nothing to upgrade: every soldier is already at the tier this barracks can equip";
    }
    return {
        districtId,
        lost: false,
        soldiers,
        maxTier,
        throughput,
        before,
        after,
        upgrades,
        spent,
        reserves: { before: reservesBefore, after: reservesAfter },
        reason,
    };
}

/**
 * Tier of each soldier, lowest first, for reports and visible-entity mapping.
 * @param {Record<string, number>} counts
 * @returns {number[]}
 */
export function soldierTiers(counts) {
    /** @type {number[]} */
    const tiers = [];
    for (const entry of EQUIPMENT_TIERS) {
        for (let index = 0; index < (counts[entry.tier] ?? 0); index += 1) {
            tiers.push(entry.tier);
        }
    }
    return tiers;
}
