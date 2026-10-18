/**
 * Building lots: turns the zones of one district (see zoning.js) into concrete, non-overlapping, well spaced
 * building placements along the curved streets. Pure and deterministic (seeded).
 *
 *   makeLots(region, zones, roads, options) -> {
 *     lots: [{ id, kind, group, blueprint, x, z, rot, w, d, zone, zoneType, district, door, facing, frontage, approach, foundation }],
 *     counts, unplaced, composition, densityReport, ... }
 *
 * Lot geometry: (x, z) is the MIN corner (north-west) of the footprint after rotation; w/d are the rotated
 * x/z extents; `rot` is the number of clockwise quarter turns applied to the south-facing blueprint
 * (expandBlueprint(BLUEPRINTS2[blueprint], rot) cells are relative to (x, z)). `door` is the lower door cell,
 * `exit` the outermost footprint cell in line with the door (differs from `door` when there is a porch),
 * `facing` the compass direction the door faces, `frontage` the road (or patrol-lane) cell reached by
 * walking straight out of the exit, `approach` the path cells between exit and frontage (to be paved).
 * `foundation.rect` is the world rect [x0, z0, x1, z1] (inclusive) a foundation pad may fill, depth below y 0.
 *
 * Spacing rule: the gap between two lots (empty blocks between footprints, max of the x and z gaps) is at least
 * 4, and at least 6 when either is a house; houses are placed with extra seeded slack so gaps are 6-10.
 */

import { rotateDir } from "../structures/facing.js";
import { BLUEPRINT_VARIANTS, BLUEPRINTS2, expandBlueprint, rotateInBox, rotatedSize } from "../structures/blueprints2.js";
import { CELL, KIND_GROUP, MIN_COMPOSITION, Router, densify, distanceTransform, hash2, makeRng, stampCells, stampRoads } from "./zoning.js";

export const LOTS_VERSION = 1;
export const MIN_SPACING = 4;
export const HOUSE_SPACING = 6;
export const HOUSE_KINDS = ["house_s", "house_m", "house_l", "longhouse"];

const VEC = /** @type {Record<string, [number, number]>} */ ({ north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] });
const CARDINALS = ["north", "east", "south", "west"];

/**
 * Required minimum gap between two lot kinds.
 * @param {string} a
 * @param {string} b
 */
export function requiredGap(a, b) {
    return HOUSE_KINDS.includes(a) || HOUSE_KINDS.includes(b) ? HOUSE_SPACING : MIN_SPACING;
}

/**
 * Empty blocks between two inclusive rects (max of the axis gaps); negative or zero-overlap means they intersect.
 * @param {{ x0: number, z0: number, x1: number, z1: number }} a
 * @param {{ x0: number, z0: number, x1: number, z1: number }} b
 */
export function rectGap(a, b) {
    const gx = Math.max(b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
    const gz = Math.max(b.z0 - a.z1 - 1, a.z0 - b.z1 - 1);
    return Math.max(gx, gz);
}

/** @type {Map<string, { blocks: number, farmland: number }>} */
const BLOCK_CACHE = new Map();

/**
 * Non-air block count and farmland count of a blueprint (cached).
 * @param {string} id
 */
export function blueprintBlocks(id) {
    let hit = BLOCK_CACHE.get(id);
    if (hit === undefined) {
        const bp = BLUEPRINTS2[id];
        if (bp === undefined) {
            throw new Error(`unknown blueprint '${id}'`);
        }
        const cells = expandBlueprint(bp, 0);
        hit = { blocks: cells.length, farmland: cells.filter((c) => c.id === "farmland").length };
        BLOCK_CACHE.set(id, hit);
    }
    return hit;
}

/**
 * @typedef {{ id: string, kind: string, group: string, blueprint: string, x: number, z: number, rot: number, w: number, d: number,
 *   zone: number, zoneType: string, district: number, door: { x: number, z: number }, exit: { x: number, z: number }, facing: string,
 *   frontage: { x: number, z: number, via: string }, approach: [number, number][], clippedRoadCells?: number,
 *   foundation: { depth: number, rect: [number, number, number, number] } }} Lot
 */

const SHOWPIECES = ["hq_citadel", "command_hall", "market_square", "chapel", "school", "hospital", "barracks", "drill_ground", "customs_yard", "mill", "smithy", "inn", "armoury"];

/**
 * Lay out the lots of one district. Several deterministic attempts (different random streams) are made and the
 * one that places the most (showpieces and the minimum composition first) wins.
 * @param {any} region
 * @param {any} zones result of zoneDistrict
 * @param {any[]} roads
 * @param {{ seed?: number, attempts?: number }} [options]
 */
export function makeLots(region, zones, roads, options = {}) {
    const attempts = Math.max(1, Math.min(8, Math.floor(options.attempts ?? 4)));
    /** @type {ReturnType<typeof layoutOnce> | null} */
    let best = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = layoutOnce(region, zones, roads, options.seed ?? 1, attempt);
        const missed = result.unplaced.reduce((sum, u) => sum + Math.max(0, u.wanted - u.placed) * (SHOWPIECES.includes(u.kind) ? 3 : 1), 0);
        const score = (result.composition.ok ? 1000 : 0) - missed;
        if (score > bestScore) {
            bestScore = score;
            best = result;
        }
        if (result.composition.ok && !result.unplaced.some((u) => SHOWPIECES.includes(u.kind))) {
            break;
        }
    }
    return /** @type {ReturnType<typeof layoutOnce>} */ (best);
}

/**
 * @param {any} region
 * @param {any} zones
 * @param {any[]} roads
 * @param {number} planSeed
 * @param {number} attempt
 */
function layoutOnce(region, zones, roads, planSeed, attempt) {
    const seed = (planSeed * 7919 + region.index * 104729 + attempt * 15485863 + 17) >>> 0;
    const rand = makeRng(seed);
    /** @type {import("./zoning.js").Grids} */
    const G = zones.grids;
    const N = G.w * G.h;
    const setback = zones.setback;
    /** @type {Lot[]} */
    const lots = [];
    /** @type {{ kind: string, rect: { x0: number, z0: number, x1: number, z1: number } }[]} */
    const placed = [];
    const occ = new Int32Array(N);
    const lane = new Uint8Array(N);
    const road = new Uint8Array(N);
    const front = new Uint8Array(N);
    /** @type {Record<string, number>} */
    const rejects = {};
    /** @type {Record<string, Record<string, number>>} */
    const rejectsByKind = {};
    let curKind = "";
    /** @param {string} why */
    const no = (why) => {
        rejects[why] = (rejects[why] ?? 0) + 1;
        const bucket = (rejectsByKind[curKind] ??= {});
        bucket[why] = (bucket[why] ?? 0) + 1;
        return null;
    };
    /** @type {{ id: string, kind: string, width: number, zone: number, path: [number, number][] }[]} */
    const extraStreets = [];
    const unplaced = /** @type {{ zone: number, zoneType: string, kind: string, wanted: number, placed: number }[]} */ ([]);

    // road masks: the caller's roads plus the zoning streets
    stampRoads(G, road, roads);
    /** @type {{ cells: [number, number][], edge: number, id: string }[]} */
    const lines = [];
    for (const r of roads) {
        if (Array.isArray(r?.path) && r.path.length > 0) {
            const width = Number.isFinite(r.width) ? r.width : r.kind === "arterial" ? 5 : 3;
            lines.push({ cells: densify(r.path), edge: (Math.max(1, Math.floor(width)) - 1) / 2 + 1, id: String(r.id ?? "road") });
        }
    }
    for (const s of zones.streets) {
        stampCells(G, road, s.path, (s.width - 1) / 2);
        lines.push({ cells: s.path, edge: (s.width - 1) / 2 + 1, id: s.id });
    }
    front.set(road);
    for (const [x, z] of zones.patrol.cells) {
        const i = (z - G.z0) * G.w + (x - G.x0);
        if (road[i] === 0) {
            front[i] = 2;
        }
    }

    const elig = /** @type {Uint8Array} */ (zones.elig);
    const inGrid = (/** @type {number} */ x, /** @type {number} */ z) => x >= G.x0 && z >= G.z0 && x < G.x0 + G.w && z < G.z0 + G.h;
    const idx = (/** @type {number} */ x, /** @type {number} */ z) => (z - G.z0) * G.w + (x - G.x0);

    /** @param {number} x @param {number} z @returns {string} zone type at a block (none = '') */
    const typeAt = (x, z) => {
        const id = zones.zoneAt(x, z);
        return id === 0 ? "" : /** @type {{ type: string }} */ (zones.zoneById(id)).type;
    };

    /** @param {string} kind @returns {string[]} */
    const variantsOf = (kind) => {
        const v = BLUEPRINT_VARIANTS[kind];
        if (v === undefined) {
            throw new Error(`no blueprint variants for lot kind '${kind}'`);
        }
        return v;
    };

    /**
     * Walk straight out of the door until a road/patrol cell; returns the path or null.
     * @param {{ x: number, z: number }} door
     * @param {string} facing
     * @param {number} maxLane
     * @param {boolean} allowSquare
     */
    const walkLane = (door, facing, maxLane, allowSquare) => {
        const [dx, dz] = /** @type {[number, number]} */ (VEC[facing]);
        /** @type {[number, number][]} */
        const path = [];
        let x = door.x + dx;
        let z = door.z + dz;
        for (let k = 0; k <= maxLane; k += 1) {
            if (!inGrid(x, z)) {
                return null;
            }
            const i = idx(x, z);
            if (front[i] !== 0) {
                return { frontage: { x, z, via: front[i] === 2 ? "patrol" : "road" }, approach: path };
            }
            if (G.ins[i] === 0 || G.wall[i] === 1 || occ[i] !== 0) {
                return null;
            }
            const t = typeAt(x, z);
            if (t === "reserve" || (t === "square" && !allowSquare)) {
                return null;
            }
            path.push([x, z]);
            x += dx;
            z += dz;
        }
        return null;
    };

    /**
     * Check static + dynamic constraints and commit.
     * @param {{ kind: string, bpId: string, x0: number, z0: number, turns: number, zoneId: number, wantGap: number, maxLane: number,
     *   allowCommons?: boolean, allowSquare?: boolean, types?: string[], clip?: { x: number, z: number, r: number }, overRoads?: boolean }} c
     * @returns {Lot | null}
     */
    const tryPlace = (c) => {
        curKind = c.kind;
        const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[c.bpId]);
        const { w, d } = rotatedSize(bp, c.turns);
        const x1 = c.x0 + w - 1;
        const z1 = c.z0 + d - 1;
        if (!inGrid(c.x0 - 2, c.z0 - 2) || !inGrid(x1 + 2, z1 + 2)) {
            return no("grid");
        }
        const zoneId = c.zoneId;
        const midZone = zones.zoneAt(c.x0 + (w >> 1), c.z0 + (d >> 1));
        if (zoneId !== 0 && midZone !== zoneId && c.types === undefined) {
            return no("zone");
        }
        // footprint cells (roads that end at the HQ forecourt may be overbuilt by the citadel itself)
        const clipped = (/** @type {number} */ x, /** @type {number} */ z) => c.overRoads === true || (c.clip !== undefined && Math.hypot(x - c.clip.x, z - c.clip.z) <= c.clip.r);
        for (let z = c.z0 - 1; z <= z1 + 1; z += 1) {
            for (let x = c.x0 - 1; x <= x1 + 1; x += 1) {
                const i = idx(x, z);
                const border = x < c.x0 || x > x1 || z < c.z0 || z > z1;
                if (border) {
                    if (road[i] === 1 && !clipped(x, z)) {
                        return no("road-clearance");
                    }
                    continue;
                }
                if (elig[i] === 0) {
                    return no("ineligible");
                }
                if ((road[i] === 1 && !clipped(x, z)) || front[i] === 2) {
                    return no("on-road");
                }
                if (lane[i] === 1 || occ[i] !== 0) {
                    return no("occupied");
                }
                const t = typeAt(x, z);
                if (c.types !== undefined && !c.types.includes(t)) {
                    return no(`zone-type-${t}`);
                }
                if (t === "reserve" || (t === "square" && c.allowSquare !== true) || ((t === "" || t === "commons") && c.allowCommons !== true)) {
                    return no(`zone-type-${t}`);
                }
            }
        }
        // spacing against neighbours
        const reach = 12;
        /** @type {Set<number>} */
        const seen = new Set();
        const me = { x0: c.x0, z0: c.z0, x1, z1 };
        for (let z = Math.max(G.z0, c.z0 - reach); z <= Math.min(G.z0 + G.h - 1, z1 + reach); z += 1) {
            for (let x = Math.max(G.x0, c.x0 - reach); x <= Math.min(G.x0 + G.w - 1, x1 + reach); x += 1) {
                const o = occ[idx(x, z)] ?? 0;
                if (o === 0 || seen.has(o)) {
                    continue;
                }
                seen.add(o);
                const other = /** @type {{ kind: string, rect: { x0: number, z0: number, x1: number, z1: number } }} */ (placed[o - 1]);
                const need = Math.max(requiredGap(c.kind, other.kind), c.wantGap);
                if (rectGap(me, other.rect) < need) {
                    return no("spacing");
                }
            }
        }
        // door and approach lane
        const [ex, , ez] = /** @type {number[]} */ (bp.entrances[0]?.at ?? [(bp.size[0] - 1) >> 1, 1, bp.size[2] - 1]);
        const [rx, rz] = rotateInBox(ex ?? 0, ez ?? 0, bp.size[0], bp.size[2], c.turns);
        const door = { x: c.x0 + rx, z: c.z0 + rz };
        // the outermost cell of the footprint in line with the door (a porch edge for buildings with a porch)
        const [exx, exz] = rotateInBox(ex ?? 0, bp.size[2] - 1, bp.size[0], bp.size[2], c.turns);
        const exit = { x: c.x0 + exx, z: c.z0 + exz };
        const facing = rotateDir("south", c.turns);
        const out = walkLane(exit, facing, c.maxLane, c.allowSquare === true);
        if (out === null) {
            return no("lane");
        }
        // commit
        const id = `d${String(region.index)}-${c.kind}-${String(lots.filter((l) => l.kind === c.kind).length + 1)}`;
        const zone = /** @type {{ id: number, type: string }} */ (zones.zoneById(midZone) ?? { id: 0, type: "defence" });
        const rect = /** @type {[number, number, number, number]} */ ([c.x0 - 1, c.z0 - 1, x1 + 1, z1 + 1]);
        /** @type {Lot} */
        const lot = {
            id,
            kind: c.kind,
            group: KIND_GROUP[c.kind] ?? "other",
            blueprint: c.bpId,
            x: c.x0,
            z: c.z0,
            rot: c.turns,
            w,
            d,
            zone: zone.id,
            zoneType: zone.type,
            district: region.index,
            door,
            exit,
            facing,
            frontage: out.frontage,
            approach: out.approach,
            foundation: { depth: bp.foundation.depth, rect },
        };
        lots.push(lot);
        placed.push({ kind: c.kind, rect: me });
        const tag = lots.length;
        for (let z = c.z0; z <= z1; z += 1) {
            for (let x = c.x0; x <= x1; x += 1) {
                occ[idx(x, z)] = tag;
            }
        }
        for (const [x, z] of out.approach) {
            lane[idx(x, z)] = 1;
        }
        if (c.clip !== undefined && c.overRoads !== true) {
            // the roads that ran into the HQ site now end at its footprint
            let removed = 0;
            for (let z = c.z0; z <= z1; z += 1) {
                for (let x = c.x0; x <= x1; x += 1) {
                    const i = idx(x, z);
                    if (road[i] === 1) {
                        road[i] = 0;
                        front[i] = 0;
                        removed += 1;
                    }
                }
            }
            lot.clippedRoadCells = removed;
        }
        return lot;
    };

    // ------------------------------------------------------------ candidate generation along streets
    /**
     * @param {string} kind
     * @param {import("./zoning.js").Zone} zone
     * @param {number} step cells between samples
     * @returns {{ bpId: string, x0: number, z0: number, turns: number, cx: number, cz: number, wantGap: number }[]}
     */
    const frontageCandidates = (kind, zone, step) => {
        /** @type {{ bpId: string, x0: number, z0: number, turns: number, cx: number, cz: number, wantGap: number }[]} */
        const out = [];
        const variants = variantsOf(kind);
        const isHouse = HOUSE_KINDS.includes(kind);
        for (const ln of lines) {
            const cells = ln.cells;
            for (let i = 0; i < cells.length; i += step) {
                const p = /** @type {[number, number]} */ (cells[i]);
                // quick reject: far from the zone bounding box
                if (p[0] < zone.bbox.x0 - 40 || p[0] > zone.bbox.x1 + 40 || p[1] < zone.bbox.z0 - 40 || p[1] > zone.bbox.z1 + 40) {
                    continue;
                }
                const a = /** @type {[number, number]} */ (cells[Math.max(0, i - 3)]);
                const b = /** @type {[number, number]} */ (cells[Math.min(cells.length - 1, i + 3)]);
                let tx = b[0] - a[0];
                let tz = b[1] - a[1];
                const len = Math.hypot(tx, tz);
                if (len < 1e-6) {
                    continue;
                }
                tx /= len;
                tz /= len;
                for (const side of [1, -1]) {
                    const nx = -tz * side;
                    const nz = tx * side;
                    // facing: cardinal closest to the direction from the lot towards the road
                    let best = 0;
                    let bestDot = -Infinity;
                    for (let k = 0; k < 4; k += 1) {
                        const v = /** @type {[number, number]} */ (VEC[/** @type {string} */ (CARDINALS[k])]);
                        const dot = v[0] * -nx + v[1] * -nz + (hash2(p[0], p[1], seed + k) - 0.5) * 0.02;
                        if (dot > bestDot) {
                            bestDot = dot;
                            best = k;
                        }
                    }
                    const turns = (best - 2 + 4) % 4;
                    const bpId = /** @type {string} */ (variants[Math.floor(hash2(p[0] * 3 + side, p[1], seed + 7) * variants.length)]);
                    const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[bpId]);
                    const { w, d } = rotatedSize(bp, turns);
                    for (const extra of [0, 2, 4, 6]) {
                        const yard = (isHouse ? 3 : 2) + Math.floor(rand() * 2) + extra;
                        const off = ln.edge + yard + (Math.abs(nx) * w + Math.abs(nz) * d) / 2;
                        const slide = (rand() - 0.5) * 5;
                        const cx = p[0] + 0.5 + nx * off + tx * slide;
                        const cz = p[1] + 0.5 + nz * off + tz * slide;
                        const x0 = Math.round(cx - w / 2);
                        const z0 = Math.round(cz - d / 2);
                        out.push({ bpId, x0, z0, turns, cx, cz, wantGap: isHouse ? HOUSE_SPACING + Math.floor(rand() * 4) : MIN_SPACING + Math.floor(rand() * 2) });
                    }
                }
            }
        }
        return out;
    };

    /** @param {string} kind */
    const laneFor = (kind) => {
        const g = KIND_GROUP[kind];
        return g === "farm" ? 10 : g === "homes" ? 8 : 12;
    };

    /**
     * Place `count` lots of `kind` in a zone.
     * @param {import("./zoning.js").Zone} zone
     * @param {string} kind
     * @param {number} count
     * @param {{ allowCommons?: boolean }} [opt]
     */
    const placeFrontage = (zone, kind, count, opt = {}) => {
        let got = 0;
        const ref = zone.squareCenter ?? zone.centroid;
        const cluster = zone.style === "neighbourhood" || zone.style === "market";
        for (let pass = 0; pass < 3 && got < count; pass += 1) {
            const cands = frontageCandidates(kind, zone, pass === 2 ? 1 : 2);
            // deterministic order: clustered around the square/centre for neighbourhoods, shuffled otherwise
            const keyed = cands.map((c) => ({ c, key: cluster ? Math.hypot(c.cx - ref.x, c.cz - ref.z) + rand() * 10 : rand() }));
            keyed.sort((p, q) => p.key - q.key);
            for (const { c } of keyed) {
                if (got >= count) {
                    break;
                }
                const lot = tryPlace({
                    kind,
                    bpId: c.bpId,
                    x0: c.x0,
                    z0: c.z0,
                    turns: c.turns,
                    zoneId: zone.id,
                    wantGap: pass === 0 ? c.wantGap : MIN_SPACING,
                    maxLane: laneFor(kind),
                    allowCommons: opt.allowCommons === true,
                });
                if (lot !== null) {
                    got += 1;
                }
            }
        }
        return got;
    };

    /**
     * Place a lot as close as possible to a point (squares, compound centres): rings of offsets, nearest road first.
     * @param {import("./zoning.js").Zone} zone
     * @param {string} kind
     * @param {{ x: number, z: number }} at
     * @param {number} maxLane
     * @param {boolean} [inSquare]
     * @param {number} [reachR]
     * @param {{ x: number, z: number, r: number }} [clip]
     * @param {boolean} [overRoads] a plaza may pave over the roads that cross it (they stay walkable)
     */
    const placeAt = (zone, kind, at, maxLane, inSquare = false, reachR = 26, clip = undefined, overRoads = false) => {
        const bpId = /** @type {string} */ (variantsOf(kind)[0]);
        const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[bpId]);
        /** @type {[number, number][]} */
        const offsets = [[0, 0]];
        for (let r = 2; r <= (inSquare ? 3 : reachR); r += 2) {
            const steps = Math.max(8, Math.round(r * 1.5));
            for (let k = 0; k < steps; k += 1) {
                const a = (k / steps) * Math.PI * 2 + r;
                offsets.push([Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)]);
            }
        }
        for (const [ox, oz] of offsets) {
            const px = at.x + ox;
            const pz = at.z + oz;
            const order = [0, 1, 2, 3].map((turns) => {
                const f = rotateDir("south", turns);
                const [dx, dz] = /** @type {[number, number]} */ (VEC[f]);
                let k = 0;
                let x = px;
                let z = pz;
                while (k < 40 && inGrid(x, z) && front[idx(x, z)] === 0) {
                    x += dx;
                    z += dz;
                    k += 1;
                }
                return { turns, k };
            });
            order.sort((a, b) => a.k - b.k);
            for (const { turns } of order) {
                const { w, d } = rotatedSize(bp, turns);
                const lot = tryPlace({
                    kind,
                    bpId,
                    x0: Math.round(px - w / 2),
                    z0: Math.round(pz - d / 2),
                    turns,
                    zoneId: inSquare ? 0 : zone.id,
                    wantGap: MIN_SPACING,
                    maxLane,
                    allowSquare: inSquare,
                    ...(clip !== undefined ? { clip } : {}),
                    overRoads,
                });
                if (lot !== null) {
                    return lot;
                }
            }
        }
        return null;
    };

    /** A virtual zone covering the whole district: second chances and the minimum-composition top-up use it. */
    /** @type {import("./zoning.js").Zone} */
    const anywhere = {
        id: 0, type: "topup", name: "top-up", style: "frontage", cells: [], area: 0, buildable: true,
        centroid: { x: Math.round((zones.bbox.x0 + zones.bbox.x1) / 2), z: Math.round((zones.bbox.z0 + zones.bbox.z1) / 2) },
        anchors: [], programs: [], bbox: zones.bbox,
    };

    // ------------------------------------------------------------ placement, biggest buildings first across all zones
    /** @type {{ zone: import("./zoning.js").Zone, program: import("./zoning.js").Program | null, key: number }[]} */
    const tasks = [];
    for (const zone of zones.zones) {
        if (!zone.buildable || zone.programs.length === 0) {
            continue;
        }
        if (zone.style === "field") {
            tasks.push({ zone, program: null, key: -1 });
            continue;
        }
        for (const program of zone.programs) {
            const hasSquare = zones.zones.some((/** @type {any} */ z) => z.type === "square" && z.parent === zone.id);
            const squareBound = hasSquare && (program.kind === "well" || program.kind === "market_square");
            tasks.push({ zone, program, key: program.kind === "hq_citadel" ? 2e6 : squareBound ? 1e6 : footprint(program.kind) });
        }
    }
    tasks.sort((a, b) => b.key - a.key || a.zone.id - b.zone.id);
    for (const { zone, program } of tasks) {
        if (program === null) {
            fillFields(zone, zone.programs[0]);
            continue;
        }
        const square = zones.zones.find((/** @type {any} */ z) => z.type === "square" && z.parent === zone.id);
        const wanted = program.count ?? 0;
        let got = 0;
        if (square !== undefined && (program.kind === "well" || program.kind === "market_square") && !lots.some((l) => l.kind === program.kind && l.zone === zone.id && l.zoneType === zone.type && inSquareOf(l, square))) {
            const lot = placeAt(zone, program.kind, square.squareCenter ?? square.centroid, 30, true, 26, undefined, program.kind === "market_square");
            if (lot !== null) {
                got += 1;
                lot.zone = zone.id;
                lot.zoneType = zone.type;
            }
        }
        if (zone.style === "compound" && got === 0 && wanted > 0) {
            // compounds sit around the zone anchor
            const anchor = zone.anchors[0] ?? zone.centroid;
            for (let k = 0; k < wanted - got; k += 1) {
                const lot = placeAt(zone, program.kind, program.kind === "hq_citadel" ? zones.hq : anchor, laneFor(program.kind), false, 30, program.kind === "hq_citadel" ? { x: zones.hq.x, z: zones.hq.z, r: 24 } : undefined);
                if (lot !== null) {
                    got += 1;
                    lot.zone = zone.id;
                    lot.zoneType = zone.type;
                }
            }
        }
        if (got < wanted) {
            got += placeFrontage(zone, program.kind, wanted - got);
        }
        if (got < wanted) {
            unplaced.push({ zone: zone.id, zoneType: zone.type, kind: program.kind, wanted, placed: got });
        }
    }

    /**
     * @param {Lot} lot
     * @param {import("./zoning.js").Zone} square
     */
    function inSquareOf(lot, square) {
        const c = square.squareCenter ?? square.centroid;
        return Math.abs(lot.x + lot.w / 2 - c.x) < 14 && Math.abs(lot.z + lot.d / 2 - c.z) < 14;
    }

    /**
     * Rescue pass: a zone whose frontage ran out gets one more street into its largest free pocket, then retries.
     * @param {import("./zoning.js").Zone} zone
     * @param {{ kind: string, wanted: number, placed: number }[]} misses
     */
    function rescueZone(zone, misses) {
        const router = new Router(G, seed + 1);
        for (let round = 0; round < 3 && misses.some((m) => m.placed < m.wanted); round += 1) {
            const obstacle = new Uint8Array(N);
            for (let z = 0; z < G.h; z += 1) {
                for (let x = 0; x < G.w; x += 1) {
                    const i = z * G.w + x;
                    obstacle[i] = elig[i] === 0 || occ[i] !== 0 || road[i] === 1 || lane[i] === 1 || (zone.id !== 0 && zones.zoneAt(G.x0 + x, G.z0 + z) !== zone.id) ? 1 : 0;
                }
            }
            const dFree = distanceTransform(G.w, G.h, obstacle);
            let bi = -1;
            // the pocket must hold the biggest missing lot plus the gap to its neighbours
            let biggest = 0;
            for (const m of misses) {
                if (m.placed < m.wanted) {
                    biggest = Math.max(biggest, footprintSide(m.kind));
                }
            }
            let bd = Math.max(7.5, biggest / 2 + 7);
            for (let i = 0; i < N; i += 1) {
                const v = /** @type {number} */ (dFree[i]) + hash2(i, round, seed) * 2;
                if (v > bd) {
                    bd = v;
                    bi = i;
                }
            }
            if (bi < 0) {
                break;
            }
            const occMask = new Uint8Array(N);
            for (let i = 0; i < N; i += 1) {
                occMask[i] = occ[i] !== 0 ? 1 : 0;
            }
            const dOcc = distanceTransform(G.w, G.h, occMask);
            const path = router.route(
                [bi],
                (i) => road[i] === 1 && G.ins[i] === 1,
                (i) => {
                    // keep the new street (3 wide) and a 1-block verge away from every building
                    if (elig[i] === 0 || /** @type {number} */ (dOcc[i]) < 3.5 || lane[i] === 1) {
                        return Infinity;
                    }
                    const t = typeAt(G.x0 + (i % G.w), G.z0 + Math.floor(i / G.w));
                    return t === "reserve" || t === "square" ? Infinity : 1;
                },
            );
            if (path === null) {
                break;
            }
            const cells = path.map((i) => /** @type {[number, number]} */ ([G.x0 + (i % G.w), G.z0 + Math.floor(i / G.w)]));
            stampCells(G, road, cells, 1);
            stampCells(G, front, cells, 1);
            const street = { id: `d${String(region.index)}-x${String(extraStreets.length + 1)}`, kind: "street", width: 3, zone: zone.id, path: cells };
            extraStreets.push(street);
            lines.push({ cells, edge: 2, id: street.id });
            for (const m of misses) {
                if (m.placed < m.wanted) {
                    m.placed += placeFrontage(zone, m.kind, m.wanted - m.placed, { allowCommons: zone.id === 0 });
                }
            }
        }
    }

    /** @param {string} kind longest side of the lot's blueprint */
    function footprintSide(kind) {
        const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[/** @type {string} */ (variantsOf(kind)[0])]);
        return Math.max(bp.size[0], bp.size[2]);
    }

    /** @param {string} kind */
    function footprint(kind) {
        const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[/** @type {string} */ (variantsOf(kind)[0])]);
        return bp.size[0] * bp.size[2];
    }

    /**
     * Sweep plots along every street that crosses a field zone.
     * @param {import("./zoning.js").Zone} zone
     * @param {import("./zoning.js").Program | undefined} program
     */
    function fillFields(zone, program) {
        const mix = Object.entries(program?.mix ?? { farm_wheat: 1 });
        const total = mix.reduce((s, [, v]) => s + v, 0);
        let plots = 0;
        for (const ln of lines) {
            for (const side of [1, -1]) {
                let i = 0;
                while (i < ln.cells.length) {
                    const p = /** @type {[number, number]} */ (ln.cells[i]);
                    if (zones.zoneAt(p[0], p[1]) === 0 || p[0] < zone.bbox.x0 - 40 || p[0] > zone.bbox.x1 + 40 || p[1] < zone.bbox.z0 - 40 || p[1] > zone.bbox.z1 + 40) {
                        i += 3;
                        continue;
                    }
                    const a = /** @type {[number, number]} */ (ln.cells[Math.max(0, i - 4)]);
                    const b = /** @type {[number, number]} */ (ln.cells[Math.min(ln.cells.length - 1, i + 4)]);
                    let tx = b[0] - a[0];
                    let tz = b[1] - a[1];
                    const len = Math.hypot(tx, tz);
                    if (len < 1e-6) {
                        i += 3;
                        continue;
                    }
                    tx /= len;
                    tz /= len;
                    const nx = -tz * side;
                    const nz = tx * side;
                    let best = 0;
                    let bestDot = -Infinity;
                    for (let k = 0; k < 4; k += 1) {
                        const v = /** @type {[number, number]} */ (VEC[/** @type {string} */ (CARDINALS[k])]);
                        const dot = v[0] * -nx + v[1] * -nz;
                        if (dot > bestDot) {
                            bestDot = dot;
                            best = k;
                        }
                    }
                    // weighted blueprint pick
                    let roll = hash2(p[0], p[1] + side * 977, seed + 31) * total;
                    let kind = /** @type {string} */ (mix[0]?.[0]);
                    for (const [k, v] of mix) {
                        if (roll < v) {
                            kind = k;
                            break;
                        }
                        roll -= v;
                    }
                    const turns = (best - 2 + 4) % 4;
                    const bpId = /** @type {string} */ (variantsOf(kind)[0]);
                    const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[bpId]);
                    const { w, d } = rotatedSize(bp, turns);
                    const off = ln.edge + 1 + bp.size[2] / 2;
                    const cx = p[0] + 0.5 + nx * off;
                    const cz = p[1] + 0.5 + nz * off;
                    /** @type {Lot | null} */
                    let lot = null;
                    // the picked plot first, then smaller ones that still fit the remaining land
                    for (const tryKind of [kind, ...["farm_irrigated", "farm_wheat", "farm_veg", "farm_kitchen", "farm_allot"].filter((k) => k !== kind)]) {
                        const id2 = /** @type {string} */ (variantsOf(tryKind)[0]);
                        const bp2 = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[id2]);
                        const sz = rotatedSize(bp2, turns);
                        const off2 = ln.edge + 2 + (Math.abs(nx) * sz.w + Math.abs(nz) * sz.d) / 2;
                        lot = tryPlace({
                            kind: tryKind,
                            bpId: id2,
                            x0: Math.round(p[0] + 0.5 + nx * off2 - sz.w / 2),
                            z0: Math.round(p[1] + 0.5 + nz * off2 - sz.d / 2),
                            turns,
                            zoneId: 0,
                            types: ["fields", "commons"],
                            wantGap: MIN_SPACING,
                            maxLane: 8,
                        });
                        if (lot !== null) {
                            break;
                        }
                    }
                    if (lot !== null) {
                        plots += 1;
                        lot.zone = zone.id;
                        lot.zoneType = zone.type;
                        // advance along the street by the plot's lateral extent plus the gap
                        i += Math.max(3, Math.round((Math.abs(tx) > Math.abs(tz) ? lot.w : lot.d) + MIN_SPACING - 2));
                    } else {
                        i += 2;
                    }
                }
            }
        }
        void plots;
    }

    // ------------------------------------------------------------ perimeter defence (guard posts, watchtowers)
    {
        /** @type {{ x: number, z: number, a: number }[]} */
        const ring = [];
        for (let z = 0; z < G.h; z += 1) {
            for (let x = 0; x < G.w; x += 1) {
                const i = z * G.w + x;
                const dist = /** @type {number} */ (G.dist[i]);
                if (elig[i] === 1 && dist >= zones.defence.minDist + 1 && dist < zones.defence.minDist + 13) {
                    ring.push({ x: G.x0 + x, z: G.z0 + z, a: 0 });
                }
            }
        }
        // order by angle around the region centroid
        let cxm = 0;
        let czm = 0;
        for (const r of ring) {
            cxm += r.x;
            czm += r.z;
        }
        cxm /= Math.max(1, ring.length);
        czm /= Math.max(1, ring.length);
        for (const r of ring) {
            r.a = Math.atan2(r.z - czm, r.x - cxm);
        }
        ring.sort((p, q) => p.a - q.a);
        /** @param {string} kind @param {number} count @param {number} phase */
        const perimeter = (kind, count, phase) => {
            let got = 0;
            if (ring.length === 0 || count <= 0) {
                return 0;
            }
            for (let k = 0; k < count; k += 1) {
                const base = Math.floor(((k + phase) / count) * ring.length) % ring.length;
                let ok = false;
                const span = Math.max(30, Math.floor(ring.length / count / 2));
                for (let tries = 0; tries < 500 && !ok; tries += 1) {
                    const r = /** @type {{ x: number, z: number }} */ (ring[(base + ((tries * 37) % (2 * span + 1)) - span + ring.length * 2) % ring.length]);
                    const bpId = /** @type {string} */ (variantsOf(kind)[0]);
                    const bp = /** @type {import("../structures/blueprints2.js").Blueprint2} */ (BLUEPRINTS2[bpId]);
                    // door faces the wall: the cardinal in which the barrier distance falls fastest
                    let bestT = 0;
                    let bestV = Infinity;
                    for (let t = 0; t < 4; t += 1) {
                        const f = rotateDir("south", t);
                        const [dx, dz] = /** @type {[number, number]} */ (VEC[f]);
                        const xx = r.x + dx * 6;
                        const zz = r.z + dz * 6;
                        const v = inGrid(xx, zz) ? /** @type {number} */ (G.dist[idx(xx, zz)]) : -1;
                        if (v < bestV) {
                            bestV = v;
                            bestT = t;
                        }
                    }
                    const { w, d } = rotatedSize(bp, bestT);
                    const lot = tryPlace({ kind, bpId, x0: r.x - (w >> 1), z0: r.z - (d >> 1), turns: bestT, zoneId: 0, wantGap: 6, maxLane: 11, allowCommons: true });
                    if (lot !== null) {
                        ok = true;
                        got += 1;
                        lot.zoneType = "defence";
                    }
                }
            }
            return got;
        };
        const gp = perimeter("guard_post", zones.defence.guardPosts, 0);
        const wt = perimeter("watchtower", zones.defence.towers, 0.5);
        const haveDefence = lots.filter((l) => l.group === "defence").length;
        if (haveDefence < MIN_COMPOSITION.defence) {
            perimeter("guard_post", MIN_COMPOSITION.defence - haveDefence, 0.25);
        }
        if (gp < zones.defence.guardPosts) {
            unplaced.push({ zone: 0, zoneType: "defence", kind: "guard_post", wanted: zones.defence.guardPosts, placed: gp });
        }
        if (wt < zones.defence.towers) {
            unplaced.push({ zone: 0, zoneType: "defence", kind: "watchtower", wanted: zones.defence.towers, placed: wt });
        }
    }

    // ------------------------------------------------------------ minimum composition top-up
    // Every district keeps homes, farm access, storage, market access and defence even when its showpiece
    // zones were cramped: add the cheapest lot kind of each missing group wherever a street has room.
    {
        const groupCount = (/** @type {string} */ g) => lots.filter((l) => l.group === g).length;
        const kindCount = (/** @type {string} */ k) => lots.filter((l) => l.kind === k).length;
        const missingOf = (/** @type {string} */ g, /** @type {number} */ min) => Math.max(0, min - groupCount(g));
        /** @type {[string, string[], number][]} */
        const wants = [
            ["homes", ["house_s", "house_m"], MIN_COMPOSITION.homes],
            ["farm", ["farm_allot", "farm_kitchen", "pen"], MIN_COMPOSITION.farm],
            ["storage", ["granary", "warehouse"], MIN_COMPOSITION.storage],
            ["market", ["market_stall", "shop"], MIN_COMPOSITION.market],
        ];
        for (const [group, kinds, min] of wants) {
            for (const kind of kinds) {
                const n = missingOf(group, min);
                if (n > 0) {
                    placeFrontage(anywhere, kind, n, { allowCommons: true });
                }
            }
            // still short: cut a new street into the biggest free pocket of the district and try the cheapest kind there
            const short = missingOf(group, min);
            if (short > 0) {
                rescueZone(anywhere, [{ kind: /** @type {string} */ (kinds[0]), wanted: short, placed: 0 }]);
            }
        }
        if (kindCount("well") < MIN_COMPOSITION.well) {
            placeFrontage(anywhere, "well", MIN_COMPOSITION.well - kindCount("well"), { allowCommons: true });
        }
    }

    // rescue: zones whose frontage ran out get an extra street into their biggest free pocket
    for (const zone of zones.zones) {
        const misses = unplaced.filter((u) => u.zone === zone.id);
        if (misses.length > 0 && zone.style !== "field") {
            rescueZone(zone, misses);
            for (const m of misses) {
                if (m.placed >= m.wanted) {
                    unplaced.splice(unplaced.indexOf(m), 1);
                }
            }
        }
    }

    // second chance, after the minimum composition is safe: whatever a cramped zone could not hold goes to any
    // free street frontage left in the district (never the other way round, or showpieces would crowd out farms)
    for (const miss of [...unplaced]) {
        if (miss.zoneType === "defence") {
            continue;
        }
        const more = placeFrontage(anywhere, miss.kind, miss.wanted - miss.placed, { allowCommons: true });
        miss.placed += more;
        if (miss.placed >= miss.wanted) {
            unplaced.splice(unplaced.indexOf(miss), 1);
        }
    }

    // ------------------------------------------------------------ reports
    /** @type {Record<string, number>} */
    const byKind = {};
    /** @type {Record<string, number>} */
    const byGroup = {};
    /** @type {Record<string, number>} */
    const byZone = {};
    /** @type {Record<string, number>} */
    const byZoneType = {};
    let footprintColumns = 0;
    let farmland = 0;
    let blocks = 0;
    /** @type {Record<string, number>} */
    const blocksByKind = {};
    for (const lot of lots) {
        byKind[lot.kind] = (byKind[lot.kind] ?? 0) + 1;
        byGroup[lot.group] = (byGroup[lot.group] ?? 0) + 1;
        byZone[String(lot.zone)] = (byZone[String(lot.zone)] ?? 0) + 1;
        byZoneType[lot.zoneType] = (byZoneType[lot.zoneType] ?? 0) + 1;
        footprintColumns += lot.w * lot.d;
        const b = blueprintBlocks(lot.blueprint);
        farmland += b.farmland;
        blocks += b.blocks;
        blocksByKind[lot.kind] = (blocksByKind[lot.kind] ?? 0) + b.blocks;
    }
    /** nearest-neighbour gaps */
    let minGap = Infinity;
    let sumNearest = 0;
    let houseMin = Infinity;
    let houseSum = 0;
    let houseN = 0;
    for (let i = 0; i < placed.length; i += 1) {
        const a = /** @type {{ kind: string, rect: { x0: number, z0: number, x1: number, z1: number } }} */ (placed[i]);
        let near = Infinity;
        let nearHouse = Infinity;
        for (let j = 0; j < placed.length; j += 1) {
            if (i === j) {
                continue;
            }
            const b = /** @type {{ kind: string, rect: { x0: number, z0: number, x1: number, z1: number } }} */ (placed[j]);
            const g = rectGap(a.rect, b.rect);
            near = Math.min(near, g);
            if (HOUSE_KINDS.includes(a.kind) && HOUSE_KINDS.includes(b.kind)) {
                nearHouse = Math.min(nearHouse, g);
            }
        }
        if (Number.isFinite(near)) {
            minGap = Math.min(minGap, near);
            sumNearest += near;
        }
        if (Number.isFinite(nearHouse)) {
            houseMin = Math.min(houseMin, nearHouse);
            houseSum += nearHouse;
            houseN += 1;
        }
    }
    let roadColumns = 0;
    let setbackColumns = 0;
    for (let i = 0; i < N; i += 1) {
        if (G.ins[i] === 1) {
            if (road[i] === 1) {
                roadColumns += 1;
            }
            if (/** @type {number} */ (G.dist[i]) < setback + 1) {
                setbackColumns += 1;
            }
        }
    }
    const area = Math.max(1, G.area);
    const g = (/** @type {string} */ k) => byGroup[k] ?? 0;
    const composition = {
        homes: g("homes"),
        farm: g("farm"),
        storage: g("storage"),
        defence: g("defence"),
        market: g("market"),
        well: byKind["well"] ?? 0,
    };
    const missing = /** @type {string[]} */ ([]);
    for (const [k, v] of Object.entries(MIN_COMPOSITION)) {
        if ((/** @type {Record<string, number>} */ (composition)[k] ?? 0) < v) {
            missing.push(k);
        }
    }
    const houses = HOUSE_KINDS.reduce((s, k) => s + (byKind[k] ?? 0), 0);
    return {
        version: LOTS_VERSION,
        district: region.index,
        role: region.role,
        lots,
        counts: { total: lots.length, houses, byKind, byGroup, byZone, byZoneType },
        unplaced,
        extraStreets,
        rejects,
        rejectsByKind,
        composition: { ...composition, ok: missing.length === 0, missing },
        roadMask: road,
        laneMask: lane,
        densityReport: {
            districtColumns: G.area,
            lots: lots.length,
            footprintColumns,
            footprintFraction: footprintColumns / area,
            farmlandColumns: farmland,
            roadColumns,
            roadFraction: roadColumns / area,
            setbackColumns,
            reserveFraction: zones.reserve.fraction,
            openFraction: Math.max(0, 1 - footprintColumns / area - roadColumns / area),
            buildingsPer1000Columns: (lots.length / area) * 1000,
            housesPer1000Columns: (houses / area) * 1000,
            minGap: Number.isFinite(minGap) ? minGap : null,
            meanNearestGap: placed.length > 1 ? sumNearest / placed.length : null,
            houseMinGap: Number.isFinite(houseMin) ? houseMin : null,
            houseMeanNearestGap: houseN > 0 ? houseSum / houseN : null,
            blockEstimate: blocks,
            blocksByKind,
        },
    };
}

/** @typedef {ReturnType<typeof makeLots>} DistrictLots */
export { CELL };
