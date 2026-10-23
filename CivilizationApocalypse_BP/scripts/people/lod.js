import { anchorSlotFor, isLiveRecord } from "./contract.js";

/**
 * Level of detail: which people are physical right now.
 *
 * Pure JS and deterministic: the same records, players, anchors and observed set always give the
 * same plan (no randomness, no clocks, no world access). The caller observes the world and passes
 * in the ids of the physical entities it found; the plan says which records to materialise, which
 * to dematerialise, and where each desired entity should stand.
 *
 * Bands (horizontal distance, squared arithmetic only):
 *   near   a record whose anchor is within `radius` of any player may be materialised
 *   keep   a physical record stays physical until its anchor is beyond `radius + hysteresis`
 *   far    everything else is purely simulated (the record remains authoritative)
 *
 * Budgets, enforced in this order (physical units are admitted before new ones, so budgets never
 * make an existing unit flicker):
 *   maxPhysical  total physical units in the kingdom
 *   districtCap  physical units per district (by record district)
 *   playerCap    physical units within keep range of one player
 *   maxSpawnsPerTick  new materialisations per plan (despawns are not budgeted: they only free load)
 *
 * Chunk safety: a unit is only materialised when every chunk its leash square touches is loaded.
 * Units are pinned within `leash` blocks of their anchor, so an entity that exists is always in a
 * loaded chunk when its record's leash square is loaded, and it cannot be spawned twice. Units
 * whose chunks are unloaded are never despawned (the engine keeps them; they are reconciled when
 * the chunk loads again).
 */

export const LOD_LIMITS = Object.freeze({
    /** Materialise a record whose anchor is within this many blocks (horizontal) of a player. */
    radius: 40,
    /** A physical record is kept until its anchor is beyond radius + hysteresis. */
    hysteresis: 8,
    /** Physical units stand within this many blocks of their anchor. */
    leash: 12,
    /** Physical units per district (district = the record's district). */
    districtCap: 24,
    /** Physical units within keep range of any one player. */
    playerCap: 48,
    /** Physical units in the whole kingdom. */
    maxPhysical: 96,
    /** New materialisations per plan. */
    maxSpawnsPerTick: 4,
    /** Blocks per chunk side. */
    chunkSize: 16,
});

/**
 * @typedef {{ id: string, x: number, z: number }} PlanPlayer
 * @typedef {{ x: number, y: number, z: number }} Point
 * @typedef {{ id: string, district: string, kind: string, slot: string, at: Point, d2: number }} PlanEntry
 * @typedef {{
 *   tick: number,
 *   players: PlanPlayer[],
 *   records: import("./contract.js").PersonRecord[],
 *   anchors: Record<string, Point>,
 *   physical: string[],
 *   isLoaded?: (cx: number, cz: number) => boolean,
 *   limits?: Partial<typeof LOD_LIMITS>,
 * }} LodInput
 */

/**
 * Chunk coordinate of a block coordinate.
 * @param {number} value
 * @param {number} [size]
 */
export function chunkCoord(value, size = LOD_LIMITS.chunkSize) {
    return Math.floor(value / size);
}

/**
 * Deterministic spot inside the leash for a record's entity, so people sharing an anchor do not stack.
 * @param {string} id
 * @returns {{ dx: number, dz: number }} each in -4..4
 */
export function offsetFor(id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i += 1) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return { dx: (h % 9) - 4, dz: (Math.floor(h / 9) % 9) - 4 };
}

/**
 * Squared horizontal distance.
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 */
export function distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
}

/**
 * @param {LodInput["limits"]} overrides
 * @returns {typeof LOD_LIMITS}
 */
export function resolveLimits(overrides) {
    const merged = { ...LOD_LIMITS, ...(overrides ?? {}) };
    for (const [key, value] of Object.entries(merged)) {
        if (!Number.isFinite(value) || Number(value) < 0) throw new Error(`LOD limit ${key} must be a non-negative number, got ${String(value)}`);
    }
    if (merged.chunkSize <= 0) throw new Error("LOD limit chunkSize must be positive");
    return /** @type {typeof LOD_LIMITS} */ (merged);
}

/**
 * Plan one tick of materialisation.
 * @param {LodInput} input
 */
export function planLod(input) {
    const limits = resolveLimits(input.limits);
    const isLoaded = input.isLoaded ?? (() => true);
    const players = input.players.slice().sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const physical = new Set(input.physical);
    const keepRange = limits.radius + limits.hysteresis;
    const keepSq = keepRange * keepRange;
    const nearSq = limits.radius * limits.radius;
    const anchors = new Map(Object.entries(input.anchors));
    const records = input.records.slice().sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

    /** @type {{ id: string, district: string, reason: string }[]} */
    const dematerialise = [];
    /** @type {{ id: string, reason: string }[]} */
    const held = [];
    /** @type {{ id: string, reason: string }[]} */
    const deferred = [];
    /** @type {string[]} */
    const noAnchor = [];
    /** @type {PlanEntry[]} */
    const keepers = [];
    /** @type {PlanEntry[]} */
    const newcomers = [];

    for (const record of records) {
        if (!isLiveRecord(record)) {
            if (physical.has(record.id)) dematerialise.push({ id: record.id, district: record.district, reason: `record is ${record.state}` });
            continue;
        }
        const slot = anchorSlotFor(record);
        const anchor = slot === null ? undefined : anchors.get(slot);
        if (slot === null || anchor === undefined) {
            noAnchor.push(record.id);
            continue;
        }
        const offset = offsetFor(record.id);
        /** @type {PlanEntry} */
        const entry = {
            id: record.id,
            district: record.district,
            kind: record.kind,
            slot,
            at: { x: anchor.x + offset.dx, y: anchor.y, z: anchor.z + offset.dz },
            d2: nearestSquared(players, anchor),
        };
        if (physical.has(record.id)) {
            if (entry.d2 <= keepSq) keepers.push(entry);
            else dematerialise.push({ id: record.id, district: record.district, reason: `beyond ${String(keepRange)} blocks of every player` });
        } else if (entry.d2 <= nearSq) {
            newcomers.push(entry);
        }
    }

    const byDistance = (/** @type {PlanEntry} */ left, /** @type {PlanEntry} */ right) =>
        left.d2 !== right.d2 ? left.d2 - right.d2 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    keepers.sort(byDistance);
    newcomers.sort(byDistance);

    /** @type {Map<string, number>} */
    const perDistrict = new Map();
    /** @type {Map<string, number>} */
    const perPlayer = new Map(players.map((player) => [player.id, 0]));
    let total = 0;
    let spawns = 0;
    /** @type {Record<string, Point>} */
    const placements = {};
    /** @type {PlanEntry[]} */
    const materialise = [];
    /** @type {string[]} */
    const desired = [];

    /**
     * @param {PlanEntry} entry
     * @returns {{ ok: true } | { ok: false, reason: string }}
     */
    const withinCaps = (entry) => {
        if (total + 1 > limits.maxPhysical) return { ok: false, reason: `kingdom cap ${String(limits.maxPhysical)} reached` };
        if ((perDistrict.get(entry.district) ?? 0) + 1 > limits.districtCap) {
            return { ok: false, reason: `district cap ${String(limits.districtCap)} reached in ${entry.district}` };
        }
        const anchor = /** @type {Point} */ (anchors.get(entry.slot));
        for (const player of players) {
            if (distanceSquared(player, anchor) > keepSq) continue;
            if ((perPlayer.get(player.id) ?? 0) + 1 > limits.playerCap) {
                return { ok: false, reason: `player ${player.id} cap ${String(limits.playerCap)} reached` };
            }
        }
        return { ok: true };
    };

    /** @param {PlanEntry} entry */
    const count = (entry) => {
        total += 1;
        perDistrict.set(entry.district, (perDistrict.get(entry.district) ?? 0) + 1);
        const anchor = /** @type {Point} */ (anchors.get(entry.slot));
        for (const player of players) {
            if (distanceSquared(player, anchor) <= keepSq) perPlayer.set(player.id, (perPlayer.get(player.id) ?? 0) + 1);
        }
        desired.push(entry.id);
        placements[entry.id] = { ...entry.at };
    };

    for (const entry of keepers) {
        const verdict = withinCaps(entry);
        if (verdict.ok) {
            count(entry);
        } else {
            dematerialise.push({ id: entry.id, district: entry.district, reason: verdict.reason });
        }
    }

    for (const entry of newcomers) {
        const anchor = /** @type {Point} */ (anchors.get(entry.slot));
        if (!leashLoaded(anchor, limits.leash, isLoaded)) {
            held.push({ id: entry.id, reason: "a chunk in the leash square is not loaded" });
            continue;
        }
        if (spawns >= limits.maxSpawnsPerTick) {
            deferred.push({ id: entry.id, reason: `spawn budget ${String(limits.maxSpawnsPerTick)} used this tick` });
            continue;
        }
        const verdict = withinCaps(entry);
        if (!verdict.ok) {
            deferred.push({ id: entry.id, reason: verdict.reason });
            continue;
        }
        spawns += 1;
        count(entry);
        materialise.push(entry);
    }

    desired.sort();
    dematerialise.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const byId = (/** @type {{ id: string }} */ left, /** @type {{ id: string }} */ right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    materialise.sort(byId);

    return {
        tick: input.tick,
        desired,
        placements,
        materialise: materialise.map((entry) => ({ id: entry.id, district: entry.district, kind: entry.kind, slot: entry.slot, at: entry.at })),
        dematerialise,
        held: held.sort(byId),
        deferred: deferred.sort(byId),
        noAnchor: noAnchor.sort(),
        budgets: {
            limits,
            physicalBefore: physical.size,
            physicalAfter: total,
            spawns,
            perDistrict: Object.fromEntries([...perDistrict.entries()].sort()),
            perPlayer: Object.fromEntries([...perPlayer.entries()].sort()),
        },
    };
}

/**
 * @param {PlanPlayer[]} players
 * @param {{ x: number, z: number }} anchor
 */
function nearestSquared(players, anchor) {
    let best = Number.POSITIVE_INFINITY;
    for (const player of players) {
        const d2 = distanceSquared(player, anchor);
        if (d2 < best) best = d2;
    }
    return best;
}

/**
 * Every chunk the leash square around an anchor touches must be loaded.
 * @param {Point} anchor
 * @param {number} leash
 * @param {(cx: number, cz: number) => boolean} isLoaded
 */
export function leashLoaded(anchor, leash, isLoaded) {
    const x0 = chunkCoord(anchor.x - leash);
    const x1 = chunkCoord(anchor.x + leash);
    const z0 = chunkCoord(anchor.z - leash);
    const z1 = chunkCoord(anchor.z + leash);
    for (let cx = x0; cx <= x1; cx += 1) {
        for (let cz = z0; cz <= z1; cz += 1) {
            if (!isLoaded(cx, cz)) return false;
        }
    }
    return true;
}

