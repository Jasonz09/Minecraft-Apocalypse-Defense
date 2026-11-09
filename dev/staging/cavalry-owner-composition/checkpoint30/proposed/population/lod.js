import { compareText, parseGroupId } from "./groups.js";

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
 *   homeDistance?: number,
 *   spotLoaded: boolean,
 *   bound: boolean,
 *   physicalCost?: 1|2,
 * }} LodInput
 * @typedef {{ level: "physical" | "coarse" | "simulated", admitted: boolean, reason: string }} LodDecision
 */

/**
 * How near a group counts as "the player is here". A district's people are a neighbourhood, not a point: the
 * player standing at the plaza is near the district even when a soldier's own post is 60 blocks down the wall.
 * The smaller of the group's spot distance and its district home distance is therefore the reach, and a caller
 * that supplies no home distance keeps the old spot-only reading.
 * @param {LodInput} input
 * @returns {number}
 */
function reachOf(input) {
    const home = Number(input.homeDistance);
    return Number.isFinite(home) ? Math.min(input.distance, home) : input.distance;
}

/**
 * @param {LodInput[]} inputs
 * @param {{ physicalRadius: number, holdRadius: number, coarseRadius: number, maxPhysicalPerDistrict: number, physicalFloorPerKind?: number, maxPhysicalTotal: number }} config
 * @param {{ ops: number }} meter work counter, incremented for every group evaluated and every comparison
 * @returns {{ decisions: Map<string, LodDecision>, counts: { physical: number, coarse: number, simulated: number, capped: number, chunkBlocked: number },actorSlots?:number }}
 */
export function planLevels(inputs, config, meter) {
    /** @type {Map<string, LodDecision>} */
    const decisions = new Map();
    /** @type {LodInput[]} */
    let candidates = [];
    let capped = 0;
    let chunkBlocked = 0;

    for (const input of inputs) {
        meter.ops += 1;
        if(input.physicalCost!==undefined&&input.physicalCost!==1&&input.physicalCost!==2)throw new Error("invalid physical actor cost");
        if (input.headcount <= 0) {
            decisions.set(input.id, { level: "simulated", admitted: false, reason: "empty" });
            continue;
        }
        if (!input.hasSpot) {
            decisions.set(input.id, { level: "simulated", admitted: false, reason: "no-home" });
            continue;
        }
        const reach = reachOf(input);
        const wanted = input.bound
            ? reach <= config.holdRadius
            : reach <= config.physicalRadius && input.spotLoaded;
        if (wanted) {
            candidates.push(input);
            continue;
        }
        if (!input.bound && reach <= config.physicalRadius) {
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

    // Each kind present in a district keeps its first `physicalFloorPerKind` slots before the rest of the
    // district budget is contested, so a crowd of civilian groups cannot hide the whole garrison. The floor
    // takes each kind's best-ranked candidates, so it costs nothing a nearer group would have won anyway.
    const floor = config.physicalFloorPerKind ?? 0;
    if (floor > 0 && candidates.length > 0) {
        /** @type {Map<string, number>} */
        const held = new Map();
        /** @type {Set<string>} */
        const taken = new Set();
        for (const candidate of candidates) {
            const parsed = parseGroupId(candidate.id);
            if (parsed === null) {
                continue;
            }
            const key = `${candidate.district} ${String(parsed.kind)}`;
            const used = held.get(key) ?? 0;
            if (used >= floor) {
                continue;
            }
            held.set(key, used + 1);
            taken.add(candidate.id);
        }
        if (taken.size > 0 && taken.size < candidates.length) {
            candidates = [...candidates.filter((candidate) => taken.has(candidate.id)), ...candidates.filter((candidate) => !taken.has(candidate.id))];
        }
    }

    const perDistrict = new Map();
    let total = 0;
    for (const candidate of candidates) {
        const used = perDistrict.get(candidate.district) ?? 0;
        const cost=candidate.physicalCost??1;
        if (total+cost > config.maxPhysicalTotal) {
            capped += 1;
            decisions.set(candidate.id, excluded(candidate, config, "capacity"));
        } else if (used+cost > config.maxPhysicalPerDistrict) {
            capped += 1;
            decisions.set(candidate.id, excluded(candidate, config, "capacity"));
        } else {
            total += cost;
            perDistrict.set(candidate.district, used + cost);
            decisions.set(candidate.id, { level: "physical", admitted: true, reason: "admitted" });
        }
    }

    const counts = { physical: 0, coarse: 0, simulated: 0, capped, chunkBlocked };
    for (const decision of decisions.values()) {
        counts[decision.level] += 1;
    }
    return { decisions, counts,...(inputs.some(i=>i.physicalCost===2)?{actorSlots:total}:{}) };
}

/**
 * A group inside the coarse ring is coarse; everything else is simulated.
 * @param {LodInput} input
 * @param {{ coarseRadius: number }} config
 * @returns {"coarse" | "simulated"}
 */
function ringLevel(input, config) {
    return input.hasSpot && reachOf(input) <= config.coarseRadius ? "coarse" : "simulated";
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
