import { compareText } from "./groups.js";

// Levels of detail. Every group is exactly one of:
//   physical   an entity stands for it (bounded by the per-district and kingdom caps);
//   coarse     no entity, but the group is near enough that its record marker matters (the ring);
//   simulated  no entity, far away: only the record exists.
//
// The decision is a pure function of positions, chunk state, bindings and caps. A group that already has an
// entity ("bound") is held on the wider holdRadius, so a unit standing on the edge of the physical radius does
// not flap between spawn and despawn. Candidates are admitted bound-first, then nearest first, then by id,
// which makes the choice deterministic and stable under restarts.

/**
 * @typedef {{
 *   id: string,
 *   district: string,
 *   headcount: number,
 *   hasSpot: boolean,
 *   distance: number,
 *   spotLoaded: boolean,
 *   bound: boolean,
 * }} LodInput
 * @typedef {{ level: "physical" | "coarse" | "simulated", admitted: boolean, reason: string }} LodDecision
 */

/**
 * @param {LodInput[]} inputs
 * @param {{ physicalRadius: number, holdRadius: number, coarseRadius: number, maxPhysicalPerDistrict: number, maxPhysicalTotal: number }} config
 * @param {{ ops: number }} meter work counter, incremented for every group evaluated and every comparison
 * @returns {{ decisions: Map<string, LodDecision>, counts: { physical: number, coarse: number, simulated: number, capped: number, chunkBlocked: number } }}
 */
export function planLevels(inputs, config, meter) {
    /** @type {Map<string, LodDecision>} */
    const decisions = new Map();
    /** @type {LodInput[]} */
    const candidates = [];
    let capped = 0;
    let chunkBlocked = 0;

    for (const input of inputs) {
        meter.ops += 1;
        if (input.headcount <= 0) {
            decisions.set(input.id, { level: "simulated", admitted: false, reason: "empty" });
            continue;
        }
        if (!input.hasSpot) {
            decisions.set(input.id, { level: "simulated", admitted: false, reason: "no-home" });
            continue;
        }
        const wanted = input.bound
            ? input.distance <= config.holdRadius
            : input.distance <= config.physicalRadius && input.spotLoaded;
        if (wanted) {
            candidates.push(input);
            continue;
        }
        if (!input.bound && input.distance <= config.physicalRadius) {
            chunkBlocked += 1;
            decisions.set(input.id, { level: ringLevel(input, config), admitted: false, reason: "chunk-unloaded" });
            continue;
        }
        decisions.set(input.id, { level: ringLevel(input, config), admitted: false, reason: "out-of-range" });
    }

    candidates.sort((left, right) => {
        meter.ops += 1;
        const bound = Number(right.bound) - Number(left.bound);
        if (bound !== 0) {
            return bound;
        }
        if (left.distance !== right.distance) {
            return left.distance - right.distance;
        }
        return compareText(left.id, right.id);
    });

    const perDistrict = new Map();
    let total = 0;
    for (const candidate of candidates) {
        const used = perDistrict.get(candidate.district) ?? 0;
        if (total >= config.maxPhysicalTotal) {
            capped += 1;
            decisions.set(candidate.id, excluded(candidate, config, "capacity"));
        } else if (used >= config.maxPhysicalPerDistrict) {
            capped += 1;
            decisions.set(candidate.id, excluded(candidate, config, "capacity"));
        } else {
            total += 1;
            perDistrict.set(candidate.district, used + 1);
            decisions.set(candidate.id, { level: "physical", admitted: true, reason: "admitted" });
        }
    }

    const counts = { physical: 0, coarse: 0, simulated: 0, capped, chunkBlocked };
    for (const decision of decisions.values()) {
        counts[decision.level] += 1;
    }
    return { decisions, counts };
}

/**
 * A group inside the coarse ring is coarse; everything else is simulated.
 * @param {LodInput} input
 * @param {{ coarseRadius: number }} config
 * @returns {"coarse" | "simulated"}
 */
function ringLevel(input, config) {
    return input.hasSpot && input.distance <= config.coarseRadius ? "coarse" : "simulated";
}

/**
 * A wanted group that lost its place to the caps. A bound one is demoted (its entity may be despawned by
 * the sync guards); an unbound one waits in the coarse ring. Either way the reason says why.
 * @param {LodInput} input
 * @param {{ coarseRadius: number }} config
 * @param {string} reason
 * @returns {LodDecision}
 */
function excluded(input, config, reason) {
    return { level: ringLevel(input, config), admitted: false, reason };
}
