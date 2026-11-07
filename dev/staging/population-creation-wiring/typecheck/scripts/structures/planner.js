import { BLUEPRINTS } from "./blueprints.js";
import { encodeFacing, rotateDir, rotateXZ } from "./facing.js";
import { DISTRICT_LAYOUTS } from "./layout.js";
import { PALETTE } from "./palette.js";

/**
 * Pure structure planner: blueprints + a layout + a district record -> a deterministic,
 * JSON-safe list of block placements, entrances and a road graph. No Minecraft access, so
 * it is fully unit-tested offline and the same plan is regenerated whenever it is needed
 * (the plan itself is never persisted).
 *
 * Local frame: x east, z south, y up. (0, 0, 0) is the district centre at the first air
 * layer above the ground surface; the surface itself is y = -1.
 */

export const MAX_PLAN_BLOCKS = 30000;
export const ROAD_NAMES = ["road", "road_stone", "plaza", "wall_floor"];
const VECTOR = /** @type {Record<string, [number, number]>} */ ({ north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] });

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function hash(x, y, z) {
    return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
}

/**
 * @param {any} token
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{ name: string | undefined, spec: any } | null}
 */
function resolveToken(token, x, y, z) {
    let name;
    let spec = token;
    if (typeof token === "string") {
        if (!Object.prototype.hasOwnProperty.call(PALETTE, token)) {
            throw new Error(`unknown palette token '${token}'`);
        }
        name = token;
        spec = /** @type {any} */ (PALETTE)[token];
    }
    if (spec === null) {
        return null;
    }
    if (spec.mix !== undefined) {
        const total = spec.mix.reduce((/** @type {number} */ sum, /** @type {any} */ entry) => sum + entry[1], 0);
        let roll = hash(x, y, z) % total;
        for (const [option, weight] of spec.mix) {
            if (roll < weight) {
                spec = option;
                break;
            }
            roll -= weight;
        }
    }
    return { name, spec };
}

/**
 * @param {number[]} box [x1,y1,z1,x2,y2,z2] in any corner order
 */
function* boxCells(box) {
    const [a, b, c, d, e, f] = /** @type {[number, number, number, number, number, number]} */ (box);
    for (let y = Math.min(b, e); y <= Math.max(b, e); y += 1) {
        for (let x = Math.min(a, d); x <= Math.max(a, d); x += 1) {
            for (let z = Math.min(c, f); z <= Math.max(c, f); z += 1) {
                yield /** @type {[number, number, number]} */ ([x, y, z]);
            }
        }
    }
}

/**
 * Cells an op touches, in blueprint/district-local coordinates.
 * @param {any} op
 * @returns {Generator<[number, number, number]>}
 */
function* opCells(op) {
    if (op.op === "set") {
        yield /** @type {[number, number, number]} */ (op.at);
    } else if (op.op === "fill") {
        yield* boxCells(op.box);
    } else if (op.op === "hollow") {
        const [x1, y1, z1, x2, y2, z2] = op.box;
        const loX = Math.min(x1, x2);
        const hiX = Math.max(x1, x2);
        const loY = Math.min(y1, y2);
        const hiY = Math.max(y1, y2);
        const loZ = Math.min(z1, z2);
        const hiZ = Math.max(z1, z2);
        for (const cell of boxCells(op.box)) {
            const [x, y, z] = cell;
            if (x === loX || x === hiX || y === loY || y === hiY || z === loZ || z === hiZ) {
                yield cell;
            }
        }
    } else if (op.op === "ring") {
        const [x1, z1, x2, z2] = op.box;
        const loX = Math.min(x1, x2);
        const hiX = Math.max(x1, x2);
        const loZ = Math.min(z1, z2);
        const hiZ = Math.max(z1, z2);
        const t = op.t ?? 1;
        const parity = op.parity;
        for (const [x, y, z] of boxCells([loX, op.y[0], loZ, hiX, op.y[1], hiZ])) {
            const depth = Math.min(x - loX, hiX - x, z - loZ, hiZ - z);
            if (depth < t && (parity === undefined || (((x + z) % 2) + 2) % 2 === parity)) {
                yield /** @type {[number, number, number]} */ ([x, y, z]);
            }
        }
    } else {
        throw new Error(`unknown op '${String(op.op)}'`);
    }
}

/**
 * Rotate a blueprint-local cell `turns` quarter turns clockwise inside a w x d footprint.
 * @param {number} x
 * @param {number} z
 * @param {number} w
 * @param {number} d
 * @param {number} turns
 * @returns {[number, number]}
 */
function rotateInBox(x, z, w, d, turns) {
    let rx = x;
    let rz = z;
    let rw = w;
    let rd = d;
    for (let i = 0; i < ((turns % 4) + 4) % 4; i += 1) {
        const nx = rd - 1 - rz;
        rz = rx;
        rx = nx;
        const tmp = rw;
        rw = rd;
        rd = tmp;
    }
    return [rx, rz];
}

/**
 * @typedef {{ name: string | undefined, id: string, states?: Record<string, any>, face?: any }} PlanCell
 */

/**
 * Apply ops through a transform into the cell map. Later ops override earlier ones.
 * @param {Map<string, PlanCell | null>} map
 * @param {any[]} ops
 * @param {{ bpSize?: number[], rotation: number, at: number[], spin: number }} xf
 */
function applyOps(map, ops, xf) {
    const turns = xf.rotation + xf.spin;
    for (const op of ops) {
        for (const [lx, ly, lz] of opCells(op)) {
            let x = lx;
            let z = lz;
            if (xf.bpSize !== undefined) {
                [x, z] = rotateInBox(lx, lz, xf.bpSize[0] ?? 1, xf.bpSize[2] ?? 1, xf.rotation);
            }
            x += xf.at[0] ?? 0;
            z += xf.at[2] ?? 0;
            const y = ly + (xf.at[1] ?? 0);
            [x, z] = rotateXZ(x, z, xf.spin);
            const resolved = resolveToken(op.block, x, y, z);
            const key = `${String(x)},${String(y)},${String(z)}`;
            if (resolved === null) {
                map.set(key, null);
                continue;
            }
            const spec = resolved.spec;
            /** @type {PlanCell} */
            const cell = { name: resolved.name, id: spec.id };
            if (spec.states !== undefined) {
                cell.states = { ...spec.states };
            }
            if (spec.face !== undefined) {
                cell.face = { ...spec.face, dir: rotateDir(spec.face.dir, turns) };
            }
            map.set(key, cell);
        }
    }
}

/**
 * @param {any} entrance blueprint entrance { at, dir, kind }
 * @param {any} placement
 * @param {any} bp
 */
function transformEntrance(entrance, placement, bp) {
    const rotation = placement.rotation ?? 0;
    const spin = placement.spin ?? 0;
    let [x, z] = rotateInBox(entrance.at[0], entrance.at[2], bp.size[0], bp.size[2], rotation);
    x += placement.at[0];
    z += placement.at[2];
    const y = entrance.at[1] + placement.at[1];
    [x, z] = rotateXZ(x, z, spin);
    const dir = rotateDir(entrance.dir, rotation + spin);
    const [dx, dz] = /** @type {[number, number]} */ (VECTOR[dir]);
    return { door: { x, y, z }, facing: dir, front: { x: x + dx, z: z + dz } };
}

/**
 * Pick the physical slots a district record asks for. A record asking for more buildings than
 * the layout has slots is reported, never silently ignored.
 * @param {any} layout
 * @param {any} district
 */
function selectSlots(layout, district) {
    const buildings = district?.buildings ?? {};
    /** @type {Record<string, number>} */
    const wanted = {};
    /** @type {Record<string, number>} */
    const built = {};
    /** @type {string[]} */
    const notes = [];
    /** @type {any[]} */
    const chosen = [];
    for (const kind of layout.slotKinds) {
        const slots = layout.slots.filter((/** @type {any} */ slot) => slot.kind === kind);
        const asked = Number.isFinite(buildings[kind]) ? Math.max(0, Math.floor(buildings[kind])) : slots.length;
        wanted[kind] = asked;
        const take = Math.min(asked, slots.length);
        built[kind] = take;
        chosen.push(...slots.slice(0, take));
        if (asked > slots.length) {
            notes.push(`record has ${String(asked)} ${kind} but the layout has only ${String(slots.length)} slots`);
        }
    }
    return { chosen, wanted, built, notes };
}

const ATTACHED = ["minecraft:ladder", "minecraft:lantern", "minecraft:wooden_door", "minecraft:fence_gate", "minecraft:wheat", "minecraft:glass_pane", "minecraft:iron_bars"];

/** @param {{ id: string }} block */
function priority(block) {
    if (block.id === "minecraft:water") {
        return 2;
    }
    return ATTACHED.includes(block.id) ? 1 : 0;
}

/**
 * @param {any} district the simulated district record (read-only)
 * @param {string} [layoutId]
 */
export function planDistrict(district, layoutId = "hearthgate") {
    const layout = /** @type {Record<string, any>} */ (DISTRICT_LAYOUTS)[layoutId];
    if (layout === undefined) {
        throw new Error(`unknown layout '${layoutId}'`);
    }
    const map = /** @type {Map<string, PlanCell | null>} */ (new Map());
    const { chosen, wanted, built, notes } = selectSlots(layout, district);
    /** @type {any[]} */
    const entrances = [];

    /** @param {any} step */
    const run = (step) => {
        const spins = step.spins ?? [step.spin ?? 0];
        for (const spin of spins) {
            if (step.op === "place") {
                const bp = /** @type {Record<string, any>} */ (BLUEPRINTS)[step.bp];
                if (bp === undefined) {
                    throw new Error(`unknown blueprint '${String(step.bp)}'`);
                }
                applyOps(map, bp.ops, { bpSize: bp.size, rotation: step.rotation ?? 0, at: step.at, spin });
                for (const entrance of bp.entrances ?? []) {
                    const kind = step.kind ?? entrance.kind;
                    entrances.push({
                        ...transformEntrance(entrance, { ...step, spin }, bp),
                        kind,
                        blueprint: step.bp,
                        id: `${String(kind)}@${step.at.join(",")}/${String(spin)}`,
                    });
                }
            } else {
                applyOps(map, [step], { rotation: 0, at: [0, 0, 0], spin });
            }
        }
    };

    for (const step of layout.fixed) {
        run(step);
    }
    for (const slot of chosen) {
        run(slot.place);
    }

    /** @type {{ x: number, y: number, z: number, id: string, states?: Record<string, any>, name?: string }[]} */
    const blocks = [];
    for (const [key, cell] of map) {
        if (cell === null) {
            continue;
        }
        const [x, y, z] = /** @type {[number, number, number]} */ (key.split(",").map(Number));
        /** @type {{ x: number, y: number, z: number, id: string, states?: Record<string, any>, name?: string }} */
        const block = { x, y, z, id: `minecraft:${cell.id}`, name: cell.name };
        const states = { ...(cell.states ?? {}), ...(cell.face ? encodeFacing(cell.face) : {}) };
        if (Object.keys(states).length > 0) {
            block.states = states;
        }
        blocks.push(block);
    }
    // Build order: structure first, then blocks that attach to it (so ladders, doors, lanterns
    // and crops never exist before their support), then liquids last.
    blocks.sort((a, b) => priority(a) - priority(b) || a.y - b.y || a.x - b.x || a.z - b.z);
    if (blocks.length > MAX_PLAN_BLOCKS) {
        throw new Error(`plan has ${String(blocks.length)} blocks, over the ${String(MAX_PLAN_BLOCKS)} cap`);
    }

    // Road graph: ground-plane road cells with clear headroom.
    const occupied = new Set(blocks.filter((block) => block.y >= 0 && block.y <= 1).map((block) => `${String(block.x)},${String(block.z)}`));
    /** @type {Set<string>} */
    const roadCells = new Set();
    for (const block of blocks) {
        if (block.y === -1 && block.name !== undefined && ROAD_NAMES.includes(block.name) && !occupied.has(`${String(block.x)},${String(block.z)}`)) {
            roadCells.add(`${String(block.x)},${String(block.z)}`);
        }
    }

    const east = district?.gates?.[0]?.with ?? null;
    const west = (district?.neighbors ?? []).find((/** @type {string} */ id) => id !== east) ?? null;
    const gates = layout.gates.map((/** @type {any} */ gate) => ({
        id: gate.id,
        side: gate.side,
        inner: gate.inner,
        links: gate.side === "east" ? east : gate.side === "west" ? west : null,
    }));

    let minY = Infinity;
    let maxY = -Infinity;
    for (const block of blocks) {
        minY = Math.min(minY, block.y);
        maxY = Math.max(maxY, block.y);
    }

    return {
        layoutId,
        version: layout.version,
        half: layout.half,
        blockCount: blocks.length,
        bounds: { min: { x: -layout.half, y: minY, z: -layout.half }, max: { x: layout.half, y: maxY, z: layout.half } },
        blocks,
        entrances,
        gates,
        roadCells: [...roadCells],
        wallStairs: layout.wallStairBases,
        counts: { wanted, built },
        notes,
    };
}

/**
 * Compact deterministic fingerprint of a plan (FNV-1a over the placement list), stored with a
 * partially built district so a resume can refuse a changed blueprint.
 * @param {{ blocks: { x: number, y: number, z: number, id: string, states?: any }[] }} plan
 */
export function planHash(plan) {
    let h = 0x811c9dc5;
    for (const block of plan.blocks) {
        const text = `${String(block.x)},${String(block.y)},${String(block.z)}:${block.id}:${block.states ? JSON.stringify(block.states) : ""};`;
        for (let i = 0; i < text.length; i += 1) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
    }
    return h.toString(16).padStart(8, "0");
}

/**
 * Breadth-first reachability over road cells (4-neighbour).
 * @param {{ roadCells: string[] }} plan
 * @param {string} from "x,z"
 * @returns {Set<string>}
 */
export function reachableRoadCells(plan, from) {
    const roads = new Set(plan.roadCells);
    /** @type {Set<string>} */
    const seen = new Set();
    if (!roads.has(from)) {
        return seen;
    }
    const queue = [from];
    seen.add(from);
    while (queue.length > 0) {
        const current = /** @type {string} */ (queue.shift());
        const [x, z] = /** @type {[number, number]} */ (current.split(",").map(Number));
        for (const [dx, dz] of /** @type {[number, number][]} */ ([[1, 0], [-1, 0], [0, 1], [0, -1]])) {
            const next = `${String(x + dx)},${String(z + dz)}`;
            if (roads.has(next) && !seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return seen;
}
