/**
 * Functional gate design for a straight, axis-aligned wall run. PURE: no Minecraft import.
 *
 * Local frame (so the same design serves both axes):
 *   u  runs ALONG the wall (the passage is 5 wide, u = -2..2);
 *   v  runs ACROSS it (the wall is 3 thick, v = -1..1; travellers cross along v);
 *   h  is height above the walking level (h = 0 is the first air block above the road; h = -1 is the road).
 * `spec.axis` is the direction the wall run extends in: 'x' means u maps to world x and v to world z.
 * `spec.at` is the centre column of the passage and `spec.y` the world Y of h = 0.
 *
 *            tower          passage (5 wide, 5 high)           tower
 *        ┌─────────┐                                       ┌─────────┐
 *        │ 3 x 5   │  lintel (h 5..6, bars slot at h 5)    │ 3 x 5   │
 *        │ tunnel  │ ┌───────────────────────────────────┐ │ tunnel  │
 *        │ h 7..8  │ │ portcullis: iron bars, plane v=0, │ │ h 7..8  │
 *        │         │ │ rows h 0..4; rows h 0..1 doubled  │ │         │
 *        └─────────┘ │ on v = -1 and v = +1 (the seal)   │ └─────────┘
 *                    └───────────────────────────────────┘
 *
 * What a gate owns
 *   - STATIC blocks (gatehouseBlocks): towers, lintel, floor sill, the raised-portcullis slot. Built once.
 *   - TOGGLED cells (cellsToToggle): the portcullis rows + seal (iron bars when closed, air when open) and
 *     the four levers (their `open_bit` mirrors the state). Only these are ever rewritten, and every op that
 *     touches them is classified `ours` (place the planned block) or `air` (clear our own bars). An op may
 *     replace only air or one of the ids in its own `ownIds`; classifyExisting() is the single judge and the
 *     Bedrock adapter must use it for every write, so a foreign block is never overwritten.
 *
 * Why a closed gate holds: the bars plane is complete from jamb to jamb and from floor to slot, the lintel and
 * both towers are solid above and beside it, and the seal doubles the lowest two rows, so a 1x1, 1x2 or 1x3
 * mob finds no jumpable gap and no diagonal squeeze (canMobCross proves it with corner-cutting allowed).
 * Spiders can climb outside faces, and nothing here stops flying or digging mobs: this is a mob-path barrier.
 *
 * @typedef {"open" | "closed"} VisualState
 * @typedef {{ id?: string, axis: "x" | "z", at: { x: number, z: number }, y: number, width?: number, wallTop?: number, passageHeight?: number }} GateSpec
 * @typedef {{
 *   id: string, axis: "x" | "z", at: { x: number, z: number }, y: number, width: number, thickness: number,
 *   wallTop: number, passageHeight: number, hw: number, towerTop: number
 * }} NormalSpec
 * @typedef {{
 *   x: number, y: number, z: number, id: string, kind: "ours" | "air", role: string,
 *   states?: Record<string, string | number | boolean>, ownIds: string[], row?: number, ground?: boolean
 * }} GateOp
 */

import { WALL, bodyBlock, cellHash } from "./walls.js";

export const GATE = Object.freeze({
    width: 5,
    thickness: 3,
    passageHeight: 5,
    /** Rows (from the floor) that are doubled on both faces of the wall. */
    sealRows: 2,
    /** The pieces of a transition are applied one row at a time; the adapter waits this long between rows. */
    rowDelayTicks: 4,
});

export const GATE_VISUAL_STATES = Object.freeze(["open", "closed"]);

const ID = Object.freeze({
    bars: "minecraft:iron_bars",
    lever: "minecraft:lever",
    floor: "minecraft:polished_andesite",
    cobble: "minecraft:cobblestone",
    air: "minecraft:air",
});

/** Every block id this module can emit (verified against the installed game data by the tests). */
export const GATE_BLOCK_IDS = Object.freeze([ID.bars, ID.lever, ID.floor, ID.cobble, "minecraft:stone_bricks", "minecraft:mossy_stone_bricks", "minecraft:cracked_stone_bricks"]);

/** Ids that count as "nothing here". */
export const AIR_IDS = Object.freeze(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

/** Entity types that cannot be trapped or crushed in a way that matters, so they never veto a closing. */
export const IGNORED_ENTITY_TYPES = Object.freeze([
    "minecraft:item", "minecraft:xp_orb", "minecraft:arrow", "minecraft:thrown_trident", "minecraft:snowball", "minecraft:egg",
    "minecraft:xp_bottle", "minecraft:ender_pearl", "minecraft:fireball", "minecraft:small_fireball", "minecraft:falling_block",
    "minecraft:area_effect_cloud", "minecraft:lightning_bolt", "minecraft:armor_stand", "minecraft:painting",
]);

/**
 * Validate and complete a gate spec. Throws on anything malformed so a bad plan fails loudly instead of
 * placing a half-formed gate.
 *
 * @param {GateSpec} spec
 * @returns {NormalSpec}
 */
export function normalizeSpec(spec) {
    if (spec === null || typeof spec !== "object") {
        throw new Error("gate spec must be an object");
    }
    if (spec.axis !== "x" && spec.axis !== "z") {
        throw new Error(`gate axis must be 'x' or 'z', got ${String(spec.axis)}`);
    }
    const at = spec.at;
    if (at === null || typeof at !== "object" || !Number.isInteger(at.x) || !Number.isInteger(at.z)) {
        throw new Error("gate 'at' must be { x, z } integers");
    }
    if (!Number.isInteger(spec.y)) {
        throw new Error("gate 'y' (the walking level) must be an integer");
    }
    const width = spec.width === undefined ? GATE.width : spec.width;
    if (width !== GATE.width) {
        throw new Error(`gate width must be ${String(GATE.width)}`);
    }
    const wallTop = spec.wallTop === undefined ? WALL.height : spec.wallTop;
    const passageHeight = spec.passageHeight === undefined ? GATE.passageHeight : spec.passageHeight;
    if (!Number.isInteger(passageHeight) || passageHeight < 3 || passageHeight > 8) {
        throw new Error("gate passageHeight must be an integer 3..8");
    }
    if (!Number.isInteger(wallTop) || wallTop < passageHeight + 2) {
        throw new Error("gate wallTop must be an integer at least passageHeight + 2");
    }
    return Object.freeze({
        id: typeof spec.id === "string" ? spec.id : "",
        axis: spec.axis,
        at: Object.freeze({ x: at.x, z: at.z }),
        y: spec.y,
        width,
        thickness: GATE.thickness,
        wallTop,
        passageHeight,
        hw: (width - 1) / 2,
        towerTop: wallTop + WALL.towerRise,
    });
}

/**
 * Local (u, v, h) -> world.
 * @param {NormalSpec} s
 * @param {number} u
 * @param {number} v
 * @param {number} h
 */
export function toWorld(s, u, v, h) {
    return s.axis === "x" ? { x: s.at.x + u, y: s.y + h, z: s.at.z + v } : { x: s.at.x + v, y: s.y + h, z: s.at.z + u };
}

/**
 * World footprint of the gatehouse (inclusive) - wall columns inside it belong to the gate.
 * @param {GateSpec} spec
 */
export function gateFootprint(spec) {
    const s = normalizeSpec(spec);
    const a = toWorld(s, -(s.hw + 3), -2, 0);
    const b = toWorld(s, s.hw + 3, 2, 0);
    return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) };
}

/**
 * Cardinal direction pointing from the wall toward local v (used for lever orientation).
 * @param {NormalSpec} s
 * @param {number} sign
 */
function outward(s, sign) {
    return s.axis === "x" ? (sign > 0 ? "south" : "north") : sign > 0 ? "east" : "west";
}

/**
 * @typedef {{
 *   u: number, v: number, h: number, id: string, role: string, row: number,
 *   states?: (open: boolean) => Record<string, string | number | boolean>
 * }} LocalToggle
 */

/**
 * The toggled cells in local coordinates, in a stable order (row ascending, then u, then v).
 * @param {NormalSpec} s
 * @returns {LocalToggle[]}
 */
function localToggles(s) {
    /** @type {LocalToggle[]} */
    const list = [];
    for (let h = 0; h < s.passageHeight; h += 1) {
        for (let u = -s.hw; u <= s.hw; u += 1) {
            for (const v of h < GATE.sealRows ? [-1, 0, 1] : [0]) {
                list.push({ u, v, h, id: ID.bars, role: v === 0 ? "bars" : "seal", row: h });
            }
        }
    }
    for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
            const direction = outward(s, sv);
            list.push({
                u: su * (s.hw + 1), v: sv * 3, h: 1, id: ID.lever, role: "lever", row: -1,
                states: (open) => ({ lever_direction: direction, open_bit: open }),
            });
        }
    }
    return list;
}

/**
 * Every cell this gate may rewrite after it is built, with the ids it may legitimately hold.
 *
 * @param {GateSpec} spec
 * @returns {{ x: number, y: number, z: number, u: number, v: number, h: number, row: number, role: string, ownIds: string[] }[]}
 */
export function cellsToToggle(spec) {
    const s = normalizeSpec(spec);
    return localToggles(s).map((cell) => {
        const w = toWorld(s, cell.u, cell.v, cell.h);
        return { x: w.x, y: w.y, z: w.z, u: cell.u, v: cell.v, h: cell.h, row: cell.row, role: cell.role, ownIds: [cell.id] };
    });
}

/**
 * @param {NormalSpec} s
 * @param {LocalToggle} cell
 * @param {VisualState} state
 * @returns {GateOp}
 */
function toggleOp(s, cell, state) {
    const w = toWorld(s, cell.u, cell.v, cell.h);
    if (cell.states !== undefined) {
        return { ...w, id: cell.id, kind: "ours", role: cell.role, states: cell.states(state === "open"), ownIds: [cell.id], row: cell.row };
    }
    if (state === "closed") {
        return { ...w, id: cell.id, kind: "ours", role: cell.role, ownIds: [cell.id], row: cell.row };
    }
    return { ...w, id: ID.air, kind: "air", role: cell.role, ownIds: [cell.id], row: cell.row };
}

/**
 * @param {unknown} state
 * @returns {VisualState}
 */
function mustState(state) {
    if (state !== "open" && state !== "closed") {
        throw new Error(`gate state must be 'open' or 'closed', got ${String(state)}`);
    }
    return state;
}

/**
 * The planned TOGGLED cells for a state: iron bars + levers when closed, air + levers when open.
 * Every op is `ours` or `air`.
 *
 * @param {GateSpec} spec
 * @param {VisualState} state
 * @returns {{ state: VisualState, ops: GateOp[] }}
 */
export function gateBlocks(spec, state) {
    const s = normalizeSpec(spec);
    const wanted = mustState(state);
    return { state: wanted, ops: localToggles(s).map((cell) => toggleOp(s, cell, wanted)) };
}

/**
 * Ordered, stepwise change between two states. Closing lowers the portcullis top row first; opening lifts it
 * bottom row first; the levers flip last. `from === to` is an empty transition (idempotent).
 *
 * @param {GateSpec} spec
 * @param {VisualState} from
 * @param {VisualState} to
 * @returns {{ from: VisualState, to: VisualState, steps: { row: number, ops: GateOp[] }[], ops: GateOp[] }}
 */
export function transition(spec, from, to) {
    const s = normalizeSpec(spec);
    const start = mustState(from);
    const end = mustState(to);
    if (start === end) {
        return { from: start, to: end, steps: [], ops: [] };
    }
    const toggles = localToggles(s);
    /** @type {number[]} */
    const rows = [];
    for (let h = 0; h < s.passageHeight; h += 1) {
        rows.push(end === "closed" ? s.passageHeight - 1 - h : h);
    }
    /** @type {{ row: number, ops: GateOp[] }[]} */
    const steps = rows.map((row) => ({
        row,
        ops: toggles.filter((cell) => cell.row === row).map((cell) => toggleOp(s, cell, end)),
    }));
    steps.push({ row: -1, ops: toggles.filter((cell) => cell.row === -1).map((cell) => toggleOp(s, cell, end)) });
    return { from: start, to: end, steps, ops: steps.flatMap((step) => step.ops) };
}

/**
 * The block ids a toggled/owned cell may hold, and the single judge of "may this op write here?".
 *
 * @param {GateOp} op
 * @param {string | undefined} existingId type id currently in the world (undefined = chunk not loaded)
 * @returns {"unloaded" | "built" | "ok" | "foreign"}
 *   built = already the planned block, ok = air or our own other-state block (safe to write), foreign = NEVER write
 */
export function classifyExisting(op, existingId) {
    if (existingId === undefined) {
        return "unloaded";
    }
    if (existingId === op.id || (op.kind === "air" && AIR_IDS.includes(existingId))) {
        return "built";
    }
    if (AIR_IDS.includes(existingId) || op.ownIds.includes(existingId)) {
        return "ok";
    }
    return "foreign";
}

/**
 * The static gatehouse: towers (with a walkway tunnel), lintel with the raised-portcullis slot, floor sill.
 * Cells flagged `ground` replace natural ground and must go through the same natural-terrain check as wall
 * footings; everything else needs air above ground.
 *
 * @param {GateSpec} spec
 * @returns {GateOp[]}
 */
export function gatehouseBlocks(spec) {
    const s = normalizeSpec(spec);
    /** @type {GateOp[]} */
    const ops = [];
    /**
     * @param {number} u @param {number} v @param {number} h @param {string} id @param {string} role @param {boolean} [ground]
     */
    const put = (u, v, h, id, role, ground = false) => {
        const w = toWorld(s, u, v, h);
        ops.push({ ...w, id, kind: "ours", role, ownIds: [id], ...(ground ? { ground: true } : {}) });
    };
    /** @param {number} u @param {number} v @param {number} h @param {string} role */
    const brick = (u, v, h, role) => {
        const w = toWorld(s, u, v, h);
        put(u, v, h, bodyBlock(w.x, w.y, w.z), role);
    };

    // Floor sill through the passage.
    for (let u = -s.hw; u <= s.hw; u += 1) {
        for (let v = -1; v <= 1; v += 1) {
            put(u, v, -1, ID.floor, "floor", true);
        }
    }
    // Towers on both sides, with a 1-wide, 2-high walkway tunnel at v = 0 from h = wallTop.
    for (const side of [-1, 1]) {
        for (let du = s.hw + 1; du <= s.hw + 3; du += 1) {
            const u = side * du;
            for (let v = -2; v <= 2; v += 1) {
                for (let h = -WALL.footing; h < s.towerTop; h += 1) {
                    if (v === 0 && h >= s.wallTop && h <= s.wallTop + 1) {
                        continue;
                    }
                    if (h < 0) {
                        const w = toWorld(s, u, v, h);
                        put(u, v, h, cellHash(w.x, w.y, w.z) % 100 < 60 ? ID.cobble : "minecraft:mossy_cobblestone", "foundation", true);
                    } else {
                        brick(u, v, h, "tower");
                    }
                }
                // Crenellated crown on the outer ring of the tower.
                const ring = du === s.hw + 1 || du === s.hw + 3 || Math.abs(v) === 2;
                const w = toWorld(s, u, v, s.towerTop);
                if (ring && (((w.x + w.z) % 2) + 2) % 2 === 0) {
                    brick(u, v, s.towerTop, "parapet");
                    brick(u, v, s.towerTop + 1, "parapet");
                }
            }
        }
    }
    // Lintel over the passage: stone with the raised-portcullis slot at h = passageHeight (v = 0).
    for (let u = -s.hw; u <= s.hw; u += 1) {
        for (let v = -1; v <= 1; v += 1) {
            for (let h = s.passageHeight; h < s.wallTop; h += 1) {
                if (v === 0 && h === s.passageHeight) {
                    put(u, v, h, ID.bars, "slot");
                } else if (v === 0 && h === s.wallTop - 1) {
                    put(u, v, h, ID.floor, "walkway");
                } else {
                    brick(u, v, h, "lintel");
                }
            }
            const w = toWorld(s, u, v, s.wallTop);
            if (Math.abs(v) === 1 && (((w.x + w.z) % 2) + 2) % 2 === 0) {
                brick(u, v, s.wallTop, "parapet");
                brick(u, v, s.wallTop + 1, "parapet");
            }
        }
    }
    return ops;
}

/**
 * Static gatehouse + the toggled cells for a state, air ops dropped. Used by the geometry proofs and by an
 * initial build that places a gate straight into its current state.
 *
 * @param {GateSpec} spec
 * @param {VisualState} state
 * @returns {GateOp[]}
 */
export function fullGateBlocks(spec, state) {
    return [...gatehouseBlocks(spec), ...gateBlocks(spec, state).ops.filter((op) => op.kind === "ours")];
}

/**
 * The box (inclusive block coordinates) that must hold no entity before the gate closes: the whole passage,
 * both wall faces of the seal included, floor to passage top.
 *
 * @param {GateSpec} spec
 * @returns {{ min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number } }}
 */
export function entityClearanceBox(spec) {
    const s = normalizeSpec(spec);
    const a = toWorld(s, -s.hw, -1, 0);
    const b = toWorld(s, s.hw, 1, s.passageHeight - 1);
    return {
        min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
        max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
    };
}

/**
 * Entities (feet position) that stand in, or close enough to the clearance box to be caught by, a closing
 * gate. `margin` covers the entity's half-width; items, arrows and similar are ignored.
 *
 * @param {GateSpec} spec
 * @param {{ typeId?: string, x: number, y: number, z: number }[]} entities
 * @param {number} [margin]
 */
export function blockersInClearance(spec, entities, margin = 0.6) {
    const box = entityClearanceBox(spec);
    return entities.filter((entity) => {
        if (entity.typeId !== undefined && IGNORED_ENTITY_TYPES.includes(entity.typeId)) {
            return false;
        }
        if (![entity.x, entity.y, entity.z].every((value) => Number.isFinite(value))) {
            return true; // a position we cannot read is never assumed to be clear
        }
        return (
            entity.x >= box.min.x - margin && entity.x < box.max.x + 1 + margin &&
            entity.z >= box.min.z - margin && entity.z < box.max.z + 1 + margin &&
            entity.y >= box.min.y - 0.5 && entity.y < box.max.y + 1
        );
    });
}

/**
 * Local solid set for the geometry proofs: gatehouse + toggled state + the plain 3-thick wall continuing
 * to the edge of the proof domain. Non-solid blocks (levers) are left out.
 *
 * @param {NormalSpec} s
 * @param {VisualState} state
 * @param {number} reachU
 * @returns {Set<string>}
 */
function localSolid(s, state, reachU) {
    /** @type {Set<string>} */
    const solid = new Set();
    for (const op of fullGateBlocks(s, state)) {
        if (op.id === ID.lever) {
            continue;
        }
        const [u, v, h] = worldToLocal(s, op.x, op.y, op.z);
        solid.add(`${String(u)},${String(v)},${String(h)}`);
    }
    for (let u = s.hw + 4; u <= reachU; u += 1) {
        for (const side of [-1, 1]) {
            for (let v = -1; v <= 1; v += 1) {
                for (let h = 0; h < s.wallTop; h += 1) {
                    solid.add(`${String(side * u)},${String(v)},${String(h)}`);
                }
            }
        }
    }
    return solid;
}

/**
 * @param {NormalSpec} s
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {[number, number, number]}
 */
function worldToLocal(s, x, y, z) {
    const dx = x - s.at.x;
    const dz = z - s.at.z;
    return s.axis === "x" ? [dx, dz, y - s.y] : [dz, dx, y - s.y];
}

/**
 * Can a ground mob of the given size get from one side of the wall to the other through this gate state?
 * Breadth-first search over standing positions with step-up of one block, drops of up to three, and - by
 * default - diagonal squeezing allowed even between two solid corners (the harshest model, so a pass proves the
 * barrier is a true 4-connected seal).
 *
 * @param {GateSpec} spec
 * @param {VisualState} state
 * @param {{ height?: number, squeeze?: boolean }} [options] mob height in blocks (default 2), squeeze (default true)
 * @returns {{ crosses: boolean, visited: number }}
 */
export function canMobCross(spec, state, options = {}) {
    const s = normalizeSpec(spec);
    const mobHeight = options.height === undefined ? 2 : options.height;
    const squeeze = options.squeeze !== false;
    const U = s.hw + 7;
    const V = 6;
    const HH = s.towerTop + mobHeight + 3;
    const solid = localSolid(s, mustState(state), U);

    /** @param {number} u @param {number} v @param {number} h */
    const isSolid = (u, v, h) => h < 0 || solid.has(`${String(u)},${String(v)},${String(h)}`);
    /** @param {number} u @param {number} v @param {number} lo @param {number} hi */
    const bodyFree = (u, v, lo, hi) => {
        for (let h = lo; h <= hi; h += 1) {
            if (h >= HH || isSolid(u, v, h)) {
                return false;
            }
        }
        return true;
    };
    const inside = (/** @type {number} */ u, /** @type {number} */ v) => u >= -U && u <= U && v >= -V && v <= V;
    /** @param {number} u @param {number} v @param {number} h */
    const idx = (u, v, h) => ((u + U) * (2 * V + 1) + (v + V)) * HH + h;

    /** @type {Uint8Array} */
    const seen = new Uint8Array((2 * U + 1) * (2 * V + 1) * HH);
    /** @type {[number, number, number][]} */
    const queue = [];
    for (let u = -U; u <= U; u += 1) {
        for (let h = 0; h < HH - mobHeight; h += 1) {
            if (bodyFree(u, -V, h, h + mobHeight - 1) && isSolid(u, -V, h - 1)) {
                seen[idx(u, -V, h)] = 1;
                queue.push([u, -V, h]);
            }
        }
    }
    let visited = 0;
    for (let head = 0; head < queue.length; head += 1) {
        const [u, v, h] = /** @type {[number, number, number]} */ (queue[head]);
        visited += 1;
        if (v === V) {
            return { crosses: true, visited };
        }
        for (let du = -1; du <= 1; du += 1) {
            for (let dv = -1; dv <= 1; dv += 1) {
                if (du === 0 && dv === 0) {
                    continue;
                }
                const nu = u + du;
                const nv = v + dv;
                if (!inside(nu, nv)) {
                    continue;
                }
                for (const dh of [0, 1, -1, -2, -3]) {
                    const nh = h + dh;
                    if (nh < 0 || nh >= HH - mobHeight) {
                        continue;
                    }
                    if (!bodyFree(nu, nv, nh, nh + mobHeight - 1) || !isSolid(nu, nv, nh - 1)) {
                        continue;
                    }
                    if (dh > 0 && !bodyFree(u, v, h + mobHeight, h + mobHeight + dh - 1)) {
                        continue; // no headroom to jump
                    }
                    if (dh < 0 && !bodyFree(nu, nv, nh, h + mobHeight - 1)) {
                        continue; // would hit its head going down
                    }
                    if (du !== 0 && dv !== 0 && !squeeze) {
                        const lo = Math.min(h, nh);
                        const hi = Math.max(h, nh) + mobHeight - 1;
                        if (!bodyFree(nu, v, lo, hi) || !bodyFree(u, nv, lo, hi)) {
                            continue;
                        }
                    }
                    const slot = idx(nu, nv, nh);
                    if (seen[slot] === 0) {
                        seen[slot] = 1;
                        queue.push([nu, nv, nh]);
                    }
                }
            }
        }
    }
    return { crosses: false, visited };
}

/**
 * Logical gate state (kingdom) <-> visual state (blocks).
 * @param {string} logical "open" | "sealed" | "broken"
 * @returns {VisualState}
 */
export function visualOf(logical) {
    return logical === "sealed" ? "closed" : "open";
}
