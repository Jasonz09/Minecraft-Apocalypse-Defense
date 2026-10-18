import { CIV_LIMITS } from "./budget.js";
import { planBridge, planFoundationColumns, planPad, planRoadProfile, planStairs } from "./foundations.js";
import { labelAt as planLabelAt, rasterizePath } from "./geom.js";
import { fnv1a, utf8Length } from "./planstore.js";
import { planWall, wallOpSegments, WALL } from "./walls.js";
import { regionFromPlan, zoneDistrict } from "./zoning.js";
import { makeLots } from "./lots.js";
import { fullGateBlocks, gatehouseBlocks, normalizeSpec } from "./gates.js";
import { BLUEPRINTS2, expandBlueprint } from "../structures/blueprints2.js";

/**
 * Enlarged irregular district construction planner - Phase C.
 *
 * The parts already existed but nothing joined them: `civ/walls.js` turns a centreline into
 * terrain-following wall columns, `civ/gates.js` builds a gatehouse on a straight wall run,
 * `civ/zoning.js` zones one district, `civ/lots.js` places spaced building footprints,
 * `civ/foundations.js` levels pads and surfaces roads with stairs and bridges, and
 * `structures/blueprints2.js` holds the buildings. This module composes them into ONE
 * complete, reproducible construction plan for a single district: what to clear, every wall
 * column and tower, every gate, every road/stair/bridge cell, every lot pad and every
 * blueprint cell, plus the evacuation and reinforcement routes - expressed as the bounded,
 * resumable job elements `civ/jobs.js` expects.
 *
 * Memory: the returned `record` is JSON-safe and holds element *descriptors* with exact op
 * counts and op hashes. Ops are regenerated on demand from those descriptors (a WeakMap of
 * closures), so a ~40k-column district never holds its whole block list in memory, and the
 * persisted record stays inside `CIV_LIMITS.maxPlanBytes`.
 *
 * Nothing here touches the runtime or the world: placement, per-cell safety classification
 * and "never overwrite a player build" stay in `integration/districtBuilder.js`, behind an
 * explicit command.
 *
 * Determinism: every choice derives from the plan seed and the district index through the
 * same seeded streams the existing modules use. No `Math.random`, no `Date`.
 */

export const SITE_PLAN_VERSION = 1;

/**
 * Enlarged layouts, keyed by district index. Deliberately absent for 2-5: Phase C is
 * Hearthgate only, and an enlargement is a NEW versioned layout - the 49x49 `hearthgate` v1
 * prototype is never resized, regenerated or erased.
 */
export const ENLARGED_LAYOUTS = Object.freeze({ 1: "hearthgate-enlarged" });

export const SITE_RULES = Object.freeze({
    wallHeight: WALL.height,
    arterialWidth: 5,
    streetWidth: 3,
    /** Pad cut/fill/retaining limits handed to planPad. */
    maxPadCut: 4,
    maxPadFill: 4,
    maxRetain: 4,
    /** Wall walk access stairs: one per this much perimeter, clamped. */
    wallStairsPerimeterDivisor: 320,
    wallStairsMin: 4,
    wallStairsMax: 12,
    stairRunCells: 3,
    /** HQ plaza half-extent. */
    hqRadius: 5,
    /** Bytes a district record may occupy once serialised. */
    maxRecordBytes: CIV_LIMITS.maxPlanBytes,
});

const STAGES = ["clear", "walls", "gates", "roads", "lots", "dressing"];

/** Boundary structures sit ON the district edge, so containment treats them as exempt. */
const BOUNDARY_KINDS = new Set(["outer-wall", "shared-wall", "wall-band", "wall-stairs", "gate-main", "gate-evac", "gate-reinforce", "gate-field"]);

/** @type {WeakMap<object, Map<string, () => any[]> >} */
const LAZY_OPS = new WeakMap();

/**
 * @param {string} key
 * @param {any[]} ops
 */
function hashOps(key, ops) {
    let text = key;
    for (const op of ops) {
        text += `${String(op.x)},${String(op.y)},${String(op.z)}|${String(op.id)}|${String(op.kind ?? op.layer ?? op.role ?? "")}|${String(op.dir ?? "")};`;
    }
    return fnv1a(text);
}

/**
 * @param {any} a
 * @param {any} b
 */
function rectsOverlap(a, b) {
    return a.x0 <= b.x1 + 1 && b.x0 <= a.x1 + 1 && a.z0 <= b.z1 + 1 && b.z0 <= a.z1 + 1;
}

/**
 * @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 */
function bboxOf(x0, z0, x1, z1) {
    return { x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) };
}

/**
 * @param {any[]} ops
 * @param {any[]} extras
 */
function bboxOfOps(ops, extras = []) {
    if (ops.length === 0) {
        return extras[0] ?? { x0: 0, z0: 0, x1: 0, z1: 0 };
    }
    let box = { x0: ops[0].x, z0: ops[0].z, x1: ops[0].x, z1: ops[0].z };
    for (const op of ops) {
        if (!Number.isFinite(op.x) || !Number.isFinite(op.z)) {
            throw new Error(`bboxOfOps: op at ${JSON.stringify(op)} has no finite x/z`);
        }
        box = bboxOf(box.x0, box.z0, op.x, op.z);
    }
    for (const extra of extras) {
        if (!Number.isFinite(extra.x0) || !Number.isFinite(extra.z0) || !Number.isFinite(extra.x1) || !Number.isFinite(extra.z1)) {
            throw new Error(`bboxOfOps: extra ${JSON.stringify(extra)} is not a rect`);
        }
        box = { x0: Math.min(box.x0, extra.x0), z0: Math.min(box.z0, extra.z0), x1: Math.max(box.x1, extra.x1), z1: Math.max(box.z1, extra.z1) };
    }
    return box;
}

/**
 * @param {number[]} values
 */
function minOf(values) {
    let best = Infinity;
    for (const value of values) {
        if (value < best) best = value;
    }
    return best;
}

/**
 * @param {number[]} values
 */
function maxOf(values) {
    let best = -Infinity;
    for (const value of values) {
        if (value > best) best = value;
    }
    return best;
}

/**
 * Height-field samplers. Unloaded columns read as `undefined` ground so the sub-planners
 * refuse them instead of inventing a surface.
 *
 * @param {any} field
 */
function makeSamplers(field) {
    if (field === null || typeof field !== "object" || typeof field.at !== "function") {
        throw new Error("planDistrictSite: field must expose at(x, z) -> { g, k, tree }");
    }
    /** @param {number} x @param {number} z */
    const cellAt = (x, z) => {
        const cell = field.at(Math.floor(x), Math.floor(z));
        return cell === null || cell === undefined ? undefined : cell;
    };
    /** @param {number} x @param {number} z @returns {number | undefined} */
    const ground = (x, z) => {
        const cell = cellAt(x, z);
        if (cell === undefined || cell.k === "unloaded" || !Number.isFinite(cell.g)) {
            return undefined;
        }
        return Math.floor(cell.g);
    };
    /** @param {number} x @param {number} z @returns {{ g: number, water?: number, hollow?: boolean }} */
    const sampler = (x, z) => {
        const cell = cellAt(x, z);
        const g = cell === undefined || !Number.isFinite(cell.g) ? 0 : Math.floor(cell.g);
        /** @type {{ g: number, water?: number, hollow?: boolean }} */
        const out = { g, hollow: cell === undefined || cell.k === "unloaded" };
        if (cell !== undefined && cell.k === "water") {
            out.water = g + 1;
        }
        return out;
    };
    /** @param {number} x @param {number} z */
    const vegetated = (x, z) => {
        const cell = cellAt(x, z);
        return cell !== undefined && cell.tree === true;
    };
    /** @param {number} x @param {number} z */
    const unusable = (x, z) => {
        const cell = cellAt(x, z);
        return cell === undefined || cell.k === "unloaded" || cell.k === "lava";
    };
    return { cellAt, ground, sampler, vegetated, unusable };
}

/**
 * @param {import("./foundations.js").Profile} profile
 * @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 * @param {(x: number, z: number) => { g: number, water?: number, hollow?: boolean }} sampler
 */
function fillProfileRect(profile, x0, z0, x1, z1, sampler) {
    for (let z = z0; z <= z1; z += 1) {
        for (let x = x0; x <= x1; x += 1) {
            const sample = sampler(x, z);
            profile.g.push(sample.g);
            profile.water.push(sample.water);
            profile.hollow.push(sample.hollow === true);
        }
    }
}

/**
 * @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 * @param {(x: number, z: number) => { g: number, water?: number, hollow?: boolean }} sampler
 */
function makeRectProfile(x0, z0, x1, z1, sampler) {
    /** @type {import("./foundations.js").Profile} */
    const profile = { x0, z0, w: x1 - x0 + 1, h: z1 - z0 + 1, g: [], water: [], hollow: [] };
    fillProfileRect(profile, x0, z0, x1, z1, sampler);
    return profile;
}

/**
 * Cells a polyline covers at block resolution.
 *
 * @param {number[][]} path
 * @param {boolean} closed
 * @returns {[number, number][]}
 */
function pathCells(path, closed) {
    const raster = rasterizePath(/** @type {any} */ (path), closed);
    if (Array.isArray(raster)) {
        return /** @type {[number, number][]} */ (raster);
    }
    return /** @type {[number, number][]} */ ((/** @type {any} */ (raster)).cells ?? []);
}

/**
 * Lateral offsets perpendicular to travel, for road width.
 *
 * @param {number} dx
 * @param {number} dz
 * @param {number} half
 * @returns {[number, number][]}
 */
function lateralOffsets(dx, dz, half) {
    const /** @type {[number, number][]} */ out = [];
    if (half <= 0) {
        return out;
    }
    const alongX = Math.abs(dx) >= Math.abs(dz);
    for (let step = 1; step <= half; step += 1) {
        if (alongX) {
            out.push([0, step], [0, -step]);
        } else {
            out.push([step, 0], [-step, 0]);
        }
    }
    return out;
}

/**
 * @param {any} plan
 * @param {number} index
 * @param {string[]} problems
 */
function inputProblems(plan, index, problems) {
    if (plan === null || typeof plan !== "object") {
        problems.push("plan must be a CivPlan object");
        return false;
    }
    if (plan.version !== 1) {
        problems.push(`unsupported CivPlan version ${String(plan.version)}`);
        return false;
    }
    if (!Number.isInteger(index) || index < 1 || index > 5) {
        problems.push(`district index must be 1..5, got ${String(index)}`);
        return false;
    }
    if (!Array.isArray(plan.districts) || !/** @type {any[]} */ (plan.districts).some((district) => district?.index === index)) {
        problems.push(`the plan has no district ${String(index)}`);
        return false;
    }
    if (!Array.isArray(plan.walls) || plan.walls.length === 0) {
        problems.push("the plan has no walls");
        return false;
    }
    return true;
}

/**
 * Build the complete construction plan for one district.
 *
 * @param {any} plan a CivPlan from civ/masterplan.js
 * @param {number} index district index (1 = Hearthgate)
 * @param {any} field height field exposing at(x, z) -> { g, k, tree }
 * @param {{
 *   seed?: number,
 *   excludeFootprints?: { x0: number, z0: number, x1: number, z1: number }[],
 *   attempts?: number,
 *   wallHeight?: number,
 *   streetWidth?: number,
 *   validate?: (record: any) => string[],
 * }} [options]
 */
export function planDistrictSite(plan, index, field, options = {}) {
    const /** @type {string[]} */ problems = [];
    const /** @type {string[]} */ notes = [];

    if (!inputProblems(plan, index, problems)) {
        return { ok: false, problems, notes, record: null };
    }
    const layoutId = /** @type {Record<number, string>} */ (ENLARGED_LAYOUTS)[index];
    if (layoutId === undefined) {
        return {
            ok: false,
            problems: [`district ${String(index)} has no enlarged layout (Phase C plans Hearthgate only; districts 2-5 are deliberately unstarted)`],
            notes,
            record: null,
        };
    }

    const seed = (options.seed ?? plan.seed ?? 1) | 0;
    const { ground, sampler, vegetated, unusable } = makeSamplers(field);
    const district = /** @type {any[]} */ (plan.districts).find((entry) => entry?.index === index);
    const protectedRects = /** @type {any[]} */ (options.excludeFootprints ?? []);
    const wallHeight = Number(options.wallHeight ?? SITE_RULES.wallHeight);

    /** @param {number} x @param {number} z */
    const mineAt = (x, z) => Number(planLabelAt(plan, x, z)) === index;

    // ------------------------------------------------------------------ district's own parts
    const districtWalls = /** @type {any[]} */ (plan.walls ?? [])
        .filter((wall) => (/** @type {any[]} */ (wall?.between ?? [])).includes(index))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (districtWalls.length === 0) {
        problems.push(`district ${String(index)} has no walls of its own`);
    }
    const wallIds = new Set(districtWalls.map((wall) => String(wall.id)));
    const districtGates = /** @type {any[]} */ (plan.gates ?? [])
        .filter((gate) => wallIds.has(String(gate?.wallId)))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    const planRoads = /** @type {any[]} */ (plan.roads ?? [])
        .filter((road) => {
            if (Number(road?.district) === index) {
                return true;
            }
            return pathCells(/** @type {number[][]} */ (road?.path ?? []), false).some(([x, z]) => mineAt(x, z));
        })
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    if (problems.length > 0) {
        return { ok: false, problems, notes, record: null };
    }

    const region = regionFromPlan(plan, index);
    const /** @type {Map<string, () => any[]>} */ lazy = new Map();
    /** @type {Record<string, any[]>} */
    const elements = { clear: [], walls: [], gates: [], roads: [], lots: [], dressing: [] };

    /**
     * Register one bounded job element: descriptor in the record, ops regenerated on demand.
     * The producer is run once here to fix the exact op count and content hash.
     *
     * @param {string} stage
     * @param {string} kind
     * @param {string} id
     * @param {any} bbox
     * @param {() => any[]} produce
     * @param {any} extra
     */
    function addElement(stage, kind, id, bbox, produce, extra = {}) {
        const ops = produce();
        for (const op of ops) {
            if (typeof op?.id !== "string" || op.id.length === 0 || !Number.isInteger(op.x) || !Number.isInteger(op.y) || !Number.isInteger(op.z)) {
                throw new Error(`${stage}/${id}: producer emitted an op without integer x/y/z and a block id`);
            }
        }
        const spec = { id, stage, kind, bbox, total: ops.length, hash: hashOps(`${stage}:${id}`, ops), ...extra };
        if (ops.length > 0) {
            lazy.set(`${stage}:${id}`, produce);
        }
        elements[stage].push(spec);
        return spec;
    }

    /**
     * Refuse anything landing on a protected footprint (the 49x49 prototype).
     *
     * @param {any} bbox
     * @param {string} label
     */
    function conflicts(bbox, label) {
        for (const rect of protectedRects) {
            if (rectsOverlap(bbox, rect)) {
                notes.push(`${label} skipped: its footprint touches a protected record`);
                return true;
            }
        }
        return false;
    }

    /** @param {[number, number][]} cells @returns {() => any[]} */
    const clearCells = (cells) =>
        function produceClear() {
            /** @type {any[]} */
            const out = [];
            for (const [x, z] of cells) {
                if (vegetated(x, z)) {
                    const g = ground(x, z);
                    if (g !== undefined) {
                        out.push({ x, y: g + 1, z, id: "minecraft:air", kind: "clear" });
                    }
                }
            }
            return out;
        };

    // ------------------------------------------------------------------ 1. walls
    /** @type {Map<string, any>} */
    const wallBuilt = new Map();
    for (const wall of districtWalls) {
        const gatesOnWall = districtGates.filter((gate) => String(gate.wallId) === String(wall.id));
        let built;
        try {
            built = planWall(wall.path, ground, {
                closed: wall.closed === true,
                height: wallHeight,
                gates: gatesOnWall.map((gate) => ({ at: gate.at, axis: gate.axis })),
            });
        } catch (error) {
            problems.push(`wall ${String(wall.id)} cannot be planned against this terrain: ${String(error)}`);
            continue;
        }
        const cells = /** @type {[number, number][]} */ (built.cells);
        let bbox = cells.length > 0 ? bboxOf(cells[0][0], cells[0][1], cells[0][0], cells[0][1]) : { x0: 0, z0: 0, x1: 0, z1: 0 };
        for (const [x, z] of cells) {
            bbox = bboxOf(Math.min(bbox.x0, x), Math.min(bbox.z0, z), Math.max(bbox.x1, x), Math.max(bbox.z1, z));
        }
        if (conflicts(bbox, `wall ${String(wall.id)}`)) {
            continue;
        }

        /** @type {() => any[]} */
        const produce = () => {
            /** @type {any[]} */
            const out = [];
            for (const segment of wallOpSegments(built, CIV_LIMITS.maxBlocksPerSlice)) {
                out.push(...segment.ops);
            }
            return out;
        };
        addElement("walls", wall.kind === "shared" ? "shared-wall" : "outer-wall", String(wall.id), bbox, produce, {
            between: /** @type {number[]} */ (wall.between ?? []),
            closed: wall.closed === true,
            length: Math.round(built.estimate.length),
            columns: built.columns.length,
            towers: built.towers.length,
            buttresses: built.estimate.buttresses,
            walkwayMinY: minOf(built.top),
            walkwayMaxY: maxOf(built.top),
            groundMinY: minOf(built.ground),
            groundMaxY: maxOf(built.ground),
        });
        addElement("clear", "wall-band", `clear-${String(wall.id)}`, bbox, clearCells(cells), { cells: cells.length });
        wallBuilt.set(String(wall.id), built);
    }

    // ------------------------------------------------------------------ 2. gates
    for (const gate of districtGates) {
        const g = ground(gate.at.x, gate.at.z);
        if (g === undefined) {
            problems.push(`gate ${String(gate.id)} sits on unloaded or invalid ground`);
            continue;
        }
        const spec = {
            id: String(gate.id),
            axis: gate.axis,
            at: { x: gate.at.x, z: gate.at.z },
            y: g + 1,
            width: Number(gate.width ?? SITE_RULES.arterialWidth),
            wallTop: g + wallHeight,
            passageHeight: 5,
        };
        let normalised;
        try {
            normalised = normalizeSpec(spec);
            gatehouseBlocks(spec);
        } catch (error) {
            problems.push(`gate ${String(gate.id)} is not a valid gate on this terrain: ${String(error)}`);
            continue;
        }
        /** @type {() => any[]} */
        const produce = () => {
            const house = gatehouseBlocks(spec);
            const passage = fullGateBlocks(spec, "open");
            return [...house, ...(Array.isArray(passage) ? passage : (/** @type {any} */ (passage)).ops ?? [])];
        };
        let ops;
        try {
            ops = produce();
        } catch (error) {
            problems.push(`gate ${String(gate.id)} blocks could not be produced: ${String(error)}`);
            continue;
        }
        const bbox = bboxOfOps([...ops, { x: spec.at.x, y: spec.y, z: spec.at.z }]);
        if (conflicts(bbox, `gate ${String(gate.id)}`)) {
            continue;
        }
        addElement("gates", `gate-${String(gate.purpose ?? "main")}`, String(gate.id), bbox, produce, {
            at: { x: Number(gate.at.x), z: Number(gate.at.z) },
            wallId: String(gate.wallId),
            between: /** @type {number[]} */ (gate.between ?? []),
            purpose: String(gate.purpose ?? "main"),
            axis: gate.axis,
            width: normalised.width,
            walkingLevel: normalised.y,
            lintelLevel: normalised.wallTop,
        });
    }

    // ------------------------------------------------------------------ 3. zoning, lots, buildings
    const zones = zoneDistrict(region, planRoads, {
        seed,
        walls: districtWalls,
        gates: districtGates,
        streetWidth: Number(options.streetWidth ?? SITE_RULES.streetWidth),
    });
    const lots = makeLots(region, zones, planRoads, { seed, attempts: options.attempts ?? 4 });
    if (lots.composition?.ok !== true) {
        notes.push(`zoning composition incomplete: ${(/** @type {string[]} */ (lots.composition?.missing ?? [])).join(", ")}`);
    }
    for (const unplaced of /** @type {any[]} */ (lots.unplaced ?? [])) {
        if (Number(unplaced.wanted ?? 0) > Number(unplaced.placed ?? 0)) {
            notes.push(`no site for ${String(Number(unplaced.wanted) - Number(unplaced.placed))} x ${String(unplaced.kind)}`);
        }
    }

    for (const lot of /** @type {any[]} */ (lots.lots ?? [])) {
        const rect = { x0: lot.x, z0: lot.z, x1: lot.x + lot.w - 1, z1: lot.z + lot.d - 1 };
        if (conflicts(rect, `lot ${String(lot.id)}`)) {
            continue;
        }
        const bp = BLUEPRINTS2[lot.blueprint];
        if (bp === undefined) {
            problems.push(`lot ${String(lot.id)} names unknown blueprint '${String(lot.blueprint)}'`);
            continue;
        }
        const profile = makeRectProfile(rect.x0 - 1, rect.z0 - 1, rect.x1 + 1, rect.z1 + 1, sampler);

        let pad;
        try {
            pad = planPad(profile, rect, { maxCut: SITE_RULES.maxPadCut, maxFill: SITE_RULES.maxPadFill, maxWall: SITE_RULES.maxRetain });
        } catch (error) {
            notes.push(`lot ${String(lot.id)} pad error: ${String(error)}`);
            continue;
        }
        if (pad.ok !== true) {
            notes.push(`lot ${String(lot.id)} has no buildable pad: ${(/** @type {string[]} */ (pad.problems)).join("; ")}`);
            continue;
        }
        const baseY = pad.baseY;
        const depth = Math.max(1, Number(bp.foundation?.depth ?? 1));

        addElement("lots", `pad-${String(lot.kind)}`, `pad-${String(lot.id)}`, rect, () => pad.ops, {
            blueprint: bp.id,
            baseY,
            lot: String(lot.id),
            zoneType: lot.zoneType,
            cut: pad.counts.cut,
            fill: pad.counts.fill,
            retain: pad.counts.retain,
            padStairs: pad.counts.stair,
        });
        addElement("lots", `footings-${String(lot.kind)}`, `footings-${String(lot.id)}`, rect, () => planFoundationColumns(profile, { rect, floorY: baseY }, { maxDepth: depth }).ops, {
            lot: String(lot.id),
            depth,
        });
        /** @type {() => any[]} */
        const buildingProduce = () => {
            /** @type {any[]} */
            const out = [];
            for (const cell of expandBlueprint(bp, lot.rot)) {
                out.push({
                    x: lot.x + cell.x,
                    y: baseY + cell.y,
                    z: lot.z + cell.z,
                    id: cell.id,
                    name: cell.name,
                    kind: "building",
                    ...(cell.states !== undefined ? { states: { ...cell.states } } : {}),
                });
            }
            return out;
        };
        addElement("lots", `building-${String(lot.kind)}`, `building-${String(lot.id)}`, rect, buildingProduce, {
            blueprint: bp.id,
            rot: lot.rot,
            door: lot.door,
            exit: lot.exit,
            facing: lot.facing,
            frontage: lot.frontage,
            lot: String(lot.id),
        });
        /** @type {[number, number][]} */
        const plotCells = [];
        for (let z = rect.z0; z <= rect.z1; z += 1) {
            for (let x = rect.x0; x <= rect.x1; x += 1) {
                plotCells.push([x, z]);
            }
        }
        addElement("clear", "lot-plot", `clear-${String(lot.id)}`, rect, clearCells(plotCells), { cells: plotCells.length });
    }

    // ------------------------------------------------------------------ 4. roads: terrain-following
    /**
     * @param {any} road
     * @param {number} width
     * @param {string} idPrefix
     */
    const addRoad = (road, width, idPrefix) => {
        const raster = pathCells(/** @type {number[][]} */ (road.path ?? []), false);
        /** @type {[number, number][]} */
        const centre = [];
        for (const [x, z] of raster) {
            const last = centre[centre.length - 1];
            if (last === undefined || last[0] !== x || last[1] !== z) {
                centre.push([x, z]);
            }
        }
        if (centre.length < 2) {
            notes.push(`${idPrefix}: road has no usable path`);
            return;
        }

        /** @type {() => any[]} */
        const produce = () => {
            /** @type {any[]} */
            const out = [];
            /** @type {string[]} */
            const refusals = [];
            let cursor = 0;
            while (cursor < centre.length) {
                const runStart = cursor;
                while (cursor < centre.length && sampler(centre[cursor][0], centre[cursor][1]).water === undefined && !unusable(centre[cursor][0], centre[cursor][1])) {
                    cursor += 1;
                }
                const run = centre.slice(runStart, cursor);
                if (run.length >= 2) {
                    const samples = run.map(([x, z]) => {
                        const sample = sampler(x, z);
                        return { x, z, g: sample.g, water: sample.water !== undefined };
                    });
                    const surfaced = planRoadProfile(samples, { smooth: 2, maxStep: 1, maxDev: 3 });
                    if (surfaced.ok === true) {
                        out.push(...surfaced.ops);
                        for (const op of surfaced.ops) {
                            const at = run.findIndex(([x, z]) => x === op.x && z === op.z);
                            const next = run[Math.min(at + 1, run.length - 1)];
                            const prev = run[Math.max(at - 1, 0)];
                            for (const [ox, oz] of lateralOffsets(next[0] - prev[0], next[1] - prev[1], Math.floor(width / 2))) {
                                if (op.kind === "stair" || op.kind === "cut") {
                                    continue;
                                }
                                const sx = op.x + ox;
                                const sz = op.z + oz;
                                const side = sampler(sx, sz);
                                for (let fy = side.g + 1; fy < op.y; fy += 1) {
                                    out.push({ x: sx, y: fy, z: sz, id: "minecraft:dirt", kind: "fill" });
                                }
                                out.push({ x: sx, y: op.y, z: sz, id: op.id, kind: op.kind });
                            }
                        }
                    } else {
                        for (const problem of surfaced.problems) {
                            refusals.push(problem);
                        }
                    }
                }
                if (cursor < centre.length) {
                    const wetStart = cursor;
                    while (cursor < centre.length && (sampler(centre[cursor][0], centre[cursor][1]).water !== undefined || unusable(centre[cursor][0], centre[cursor][1]))) {
                        cursor += 1;
                    }
                    const span = centre.slice(Math.max(0, wetStart - 1), Math.min(centre.length, cursor + 1));
                    const axisAligned = span.length >= 3 && span.every(([x, z]) => x === span[0][0] || z === span[0][1]);
                    if (axisAligned) {
                        const bridged = planBridge(span.map(([x, z]) => ({ x, z, g: sampler(x, z).g })), { width: Math.max(1, Math.min(7, width)) });
                        if (bridged.ok === true) {
                            out.push(...bridged.ops);
                        } else {
                            for (const problem of bridged.problems) {
                                refusals.push(`no bridge: ${problem}`);
                            }
                        }
                    } else if (span.length >= 2) {
                        refusals.push(`water crossing near cell ${String(wetStart)} is not axis-aligned: the route needs a reroute, not a bridge`);
                    }
                }
            }
            for (const refusal of refusals) {
                out.push({ x: centre[0][0], y: -1, z: centre[0][1], id: "minecraft:air", kind: "note", note: `${idPrefix}: ${refusal}` });
            }
            return out;
        };

        let ops;
        try {
            ops = produce();
        } catch (error) {
            problems.push(`${idPrefix} could not be surfaced: ${String(error)}`);
            return;
        }
        const real = ops.filter((op) => op.kind !== "note");
        if (real.length === 0) {
            notes.push(`${idPrefix}: nothing could be surfaced (${ops.length} refusals)`);
            return;
        }
        for (const op of ops) {
            if (op.kind === "note") {
                notes.push(String(op.note));
            }
        }
        const bbox = bboxOfOps(real);
        if (conflicts(bbox, idPrefix)) {
            return;
        }
        const ys = real.map((op) => op.y);
        // Where do this road's cells actually lie? Streets and arterials belong to us; a link is
        // an approved connection and must leave only toward the paired district, through a gate.
        const labels = new Set();
        let outside = 0;
        for (const [x, z] of centre) {
            const label = Number(planLabelAt(plan, x, z));
            if (label !== index) {
                outside += 1;
                labels.add(label);
            }
        }
        const touchesGate = districtGates.some((gate) =>
            centre.some(([x, z]) => Math.abs(x - gate.at.x) <= Math.max(2, Number(gate.width ?? 5)) && Math.abs(z - gate.at.z) <= Math.max(2, Number(gate.width ?? 5))),
        );
        addElement("roads", `road-${String(road.kind ?? "street")}`, idPrefix, bbox, produce, {
            district: Number(road.district ?? index),
            width,
            length: centre.length,
            surfaceMinY: minOf(ys),
            surfaceMaxY: maxOf(ys),
            refusals: ops.length - real.length,
            outsideCells: outside,
            crossesTo: [...labels].sort(),
            throughGate: touchesGate,
        });
    };

    for (const road of planRoads) {
        addRoad(road, Number(road.width ?? (road.kind === "arterial" ? SITE_RULES.arterialWidth : SITE_RULES.streetWidth)), String(road.id));
    }
    for (const street of [.../** @type {any[]} */ (zones.streets ?? []), .../** @type {any[]} */ (lots.extraStreets ?? [])]) {
        addRoad(street, Number(street.width ?? SITE_RULES.streetWidth), String(street.id));
    }

    // The patrol lane is a real street in the defence plan - zoning routes house doors onto it via
    // `frontage.via === "patrol"` - so it has to be surfaced too, or those doors open onto nothing.
    const patrolCells = /** @type {[number, number][]} */ (zones.patrol?.cells ?? []);
    if (patrolCells.length >= 2) {
        addRoad({ id: "patrol-lane", kind: "ring", district: index, path: orderRing(patrolCells) }, Number(zones.patrol?.width ?? 2), "patrol-lane");
    }

    // ------------------------------------------------------------------ 5. dressing: wall access + HQ plaza
    // Stairs must actually reach the walkway: the run has to be at least as long as the rise.
    // Walking straight inward from a wall cell toward the district centroid gives that run, so
    // the search is over the run length, and a refusal is recorded instead of swallowed.
    const centroid = district.centroid ?? region.hq;
    let stairsPlaced = 0;
    for (const [wallId, built] of wallBuilt) {
        const cells = /** @type {[number, number][]} */ (built.cells);
        const tops = /** @type {number[]} */ (built.top);
        const targets = Math.max(1, Math.round(cells.length / 220));
        const stride = Math.max(1, Math.floor(cells.length / targets));
        for (let i = 0; i < cells.length; i += stride) {
            const [wx, wz] = cells[i];
            const topY = tops[i];
            if (!Number.isInteger(topY)) {
                continue;
            }
            const inwardX = Math.sign(centroid.x - wx);
            const inwardZ = Math.sign(centroid.z - wz);
            if (inwardX === 0 && inwardZ === 0) {
                continue;
            }
            let chosen = null;
            for (let run = 3; run <= 12 && chosen === null; run += 1) {
                const fx = wx - inwardX * run;
                const fz = wz - inwardZ * run;
                const g = ground(fx, fz);
                if (g === undefined) {
                    continue;
                }
                const rise = topY - (g + 1);
                if (rise < 1 || rise > run) {
                    continue;
                }
                const step = run === 0 ? 1 : Math.round(run / rise);
                if (step < 1) {
                    continue;
                }
                chosen = planStairs({ x: fx, y: g + 1, z: fz }, { x: wx, y: topY, z: wz }, { maxCut: SITE_RULES.maxPadCut, maxFill: 6 });
                if (chosen.ok === true && chosen.ops.length > 0) {
                    break;
                }
                chosen = null;
            }
            if (chosen === null) {
                notes.push(`wall ${String(wallId)} at ${String(wx)},${String(wz)}: no stair run of 3..12 cells reaches the walkway at y=${String(topY)}`);
                continue;
            }
            stairsPlaced += 1;
            addElement("dressing", "wall-stairs", `stairs-${String(stairsPlaced)}`, bboxOfOps(chosen.ops), () => chosen.ops, {
                wallId: String(wallId),
                opCount: chosen.ops.length,
                rise: chosen.counts.stair + chosen.counts.top,
            });
        }
    }
    if (stairsPlaced < SITE_RULES.wallStairsMin) {
        notes.push(`only ${String(stairsPlaced)} wall access stairs could be placed (target ${String(SITE_RULES.wallStairsMin)}); the terrain does not offer enough gentle approaches`);
    }

    const hqRect = {
        x0: region.hq.x - SITE_RULES.hqRadius,
        z0: region.hq.z - SITE_RULES.hqRadius,
        x1: region.hq.x + SITE_RULES.hqRadius,
        z1: region.hq.z + SITE_RULES.hqRadius,
    };
    if (!conflicts(hqRect, "HQ plaza")) {
        const hqProfile = makeRectProfile(hqRect.x0 - 1, hqRect.z0 - 1, hqRect.x1 + 1, hqRect.z1 + 1, sampler);
        const hqPad = planPad(hqProfile, hqRect, { maxCut: SITE_RULES.maxPadCut, maxFill: SITE_RULES.maxPadFill, maxWall: SITE_RULES.maxRetain });
        if (hqPad.ok === true) {
            addElement("dressing", "hq-plaza", "hq-plaza", hqRect, () => hqPad.ops, { at: region.hq, baseY: hqPad.baseY });
        } else {
            notes.push(`HQ plaza refused: ${(/** @type {string[]} */ (hqPad.problems)).join("; ")}`);
        }
    }

    // ------------------------------------------------------------------ routes
    /** @param {string} key */
    const routesOf = (key) =>
        /** @type {any[]} */ ((plan.routes ?? {})[key] ?? [])
            .filter((route) => Number(route?.from) === index || Number(route?.to) === index)
            .sort((left, right) => `${String(left.from)}-${String(left.to)}`.localeCompare(`${String(right.from)}-${String(right.to)}`))
            .map((route) => {
                const ids = /** @type {string[]} */ ((/** @type {any[]} */ (route.gates ?? [])).map(String));
                return {
                    from: Number(route.from),
                    to: Number(route.to),
                    gates: ids,
                    throughDistrictGates: ids.filter((id) => districtGates.some((gate) => String(gate.id) === id)).length,
                };
            });
    const routes = { evac: routesOf("evac"), reinforce: routesOf("reinforce") };

    // ------------------------------------------------------------------ record
    /** @type {Record<string, number>} */
    const counts = {};
    for (const stage of STAGES) {
        counts[stage] = elements[stage].reduce((sum, element) => sum + Number(element.total), 0);
    }
    const totalOps = Object.values(counts).reduce((sum, value) => sum + Number(value), 0);

    /** @type {Record<string, any>} */
    const record = {
        version: SITE_PLAN_VERSION,
        layoutId,
        seed,
        districtIndex: index,
        districtId: district.id,
        name: district.name,
        role: district.role,
        planSeed: plan.seed,
        anchor: plan.anchor,
        cell: plan.cell,
        bbox: { x0: region.bbox.x0, z0: region.bbox.z0, x1: region.bbox.x1, z1: region.bbox.z1 },
        area: district.area,
        outline: district.outline,
        stats: {
            walls: elements.walls.length,
            wallLength: elements.walls.reduce((sum, element) => sum + Number(element.length ?? 0), 0),
            towers: elements.walls.reduce((sum, element) => sum + Number(element.towers ?? 0), 0),
            buttresses: elements.walls.reduce((sum, element) => sum + Number(element.buttresses ?? 0), 0),
            gates: elements.gates.length,
            gatesByPurpose: elements.gates.reduce((acc, gate) => ({ ...acc, [gate.purpose]: (acc[gate.purpose] ?? 0) + 1 }), {}),
            roads: elements.roads.length,
            roadCells: elements.roads.reduce((sum, element) => sum + Number(element.length ?? 0), 0),
            roadRefusals: elements.roads.reduce((sum, element) => sum + Number(element.refusals ?? 0), 0),
            lots: (/** @type {any[]} */ (lots.lots ?? [])).length,
            pads: elements.lots.filter((element) => String(element.id).startsWith("pad-")).length,
            buildings: elements.lots.filter((element) => String(element.id).startsWith("building-")).length,
            lotsWithoutPad: (/** @type {any[]} */ (lots.lots ?? [])).length - elements.lots.filter((element) => String(element.id).startsWith("pad-")).length,
            defenceLots: elements.lots.filter((element) => String(element.id).startsWith("building-") && /watchtower|guard_post|barracks|armoury|drill_ground|citadel/.test(String(element.kind))).length,
            residentialLots: elements.lots.filter((element) => String(element.id).startsWith("building-") && /house|cottage|tenement|garden/.test(String(element.kind))).length,
            wallStairs: elements.dressing.filter((element) => element.kind === "wall-stairs").length,
            reserveFraction: zones.reserve?.fraction ?? 0,
            guardPosts: zones.defence?.guardPosts ?? 0,
            perimeter: zones.defence?.perimeter ?? 0,
            patrolCells: (/** @type {any[]} */ (zones.patrol?.cells ?? [])).length,
            ringRoads: elements.roads.filter((element) => String(element.kind) === "road-ring").length,
            elevationSpan: (() => {
                const ys = elements.roads.map((element) => Number(element.surfaceMaxY) - Number(element.surfaceMinY));
                return ys.length === 0 ? 0 : Math.max(...ys);
            })(),
            totalOps,
            byStage: counts,
        },
        walls: elements.walls,
        gates: elements.gates,
        roads: elements.roads,
        lots: elements.lots,
        dressing: elements.dressing,
        clear: elements.clear,
        routes,
        patrol: { width: zones.patrol?.width ?? 2, cells: (/** @type {any[]} */ (zones.patrol?.cells ?? [])).length },
        notes,
        problems,
        limits: { maxBlocksPerSlice: CIV_LIMITS.maxBlocksPerSlice, maxRecordBytes: SITE_RULES.maxRecordBytes },
    };

    const serialised = JSON.stringify({ ...record, notes: undefined, problems: undefined });
    const recordBytes = utf8Length(serialised);
    if (recordBytes > SITE_RULES.maxRecordBytes) {
        problems.push(`the district record is ${String(recordBytes)} bytes, above the ${String(SITE_RULES.maxRecordBytes)} budget`);
        return { ok: false, problems, notes, record: null };
    }
    record.recordBytes = recordBytes;
    record.checksum = fnv1a(JSON.stringify({ ...record, checksum: undefined }));

    LAZY_OPS.set(record, lazy);

    if (typeof options.validate === "function") {
        for (const problem of options.validate(record)) {
            problems.push(problem);
        }
    }

    return { ok: problems.length === 0, problems, notes, record };
}

/**
 * Ops of one element, regenerated from its descriptor. Deterministic and side-effect free.
 *
 * @param {any} record
 * @param {string} stage
 * @param {number} elementIndex
 * @returns {any[]}
 */
export function siteOpsFor(record, stage, elementIndex) {
    const lazy = LAZY_OPS.get(record);
    const list = /** @type {any[]} */ (record?.[stage] ?? []);
    const element = list[elementIndex];
    if (element === undefined) {
        throw new RangeError(`no element ${String(stage)}[${String(elementIndex)}]`);
    }
    const producer = lazy?.get(`${stage}:${element.id}`);
    if (producer === undefined) {
        return [];
    }
    return producer();
}

/**
 * @param {any} record
 * @param {string} stage
 * @param {string} elementId
 */
export function siteOpsById(record, stage, elementId) {
    const list = /** @type {any[]} */ (record?.[stage] ?? []);
    return siteOpsFor(record, stage, list.findIndex((element) => element.id === elementId));
}

/**
 * Bounded slices across every stage, in job order. Holds one slice at a time.
 *
 * @param {any} record
 * @param {{ maxOps?: number, stages?: string[] }} [options]
 */
export function* siteOpSlices(record, options = {}) {
    const limit = Math.min(Number(options.maxOps ?? CIV_LIMITS.maxBlocksPerSlice), CIV_LIMITS.maxBlocksPerSlice);
    const stages = /** @type {string[]} */ (options.stages ?? STAGES);
    for (const stage of stages) {
        const list = /** @type {any[]} */ (record?.[stage] ?? []);
        for (let index = 0; index < list.length; index += 1) {
            const ops = siteOpsFor(record, stage, index);
            for (let start = 0; start < ops.length; start += limit) {
                yield { stage, element: list[index].id, elementIndex: index, ops: ops.slice(start, start + limit) };
            }
        }
    }
}

/**
 * Element specs for `civ/jobs.js` createQueue: exact totals plus an op-content hash, so a
 * resumed job can tell "already placed" from "the plan changed since".
 *
 * @param {any} record
 */
export function siteJobSpecs(record) {
    /** @type {Record<string, any[]>} */
    const specs = {};
    for (const stage of STAGES) {
        specs[stage] = /** @type {any[]} */ (record?.[stage] ?? []).map((element) => ({
            total: element.total,
            hash: element.hash,
            inputs: { id: element.id, kind: element.kind, bbox: element.bbox },
        }));
    }
    return specs;
}

/**
 * Structures must sit inside their own district. Walls, gates, gate bands and wall stairs are
 * boundary structures and are exempt. Streets and arterials must be wholly inside. A link road
 * is an approved connection: it may leave, but only toward one paired district and only through
 * a gate it actually passes by.
 *
 * @param {any} plan
 * @param {number} index
 * @param {any} record
 * @returns {string[]}
 */
export function siteContainmentProblems(plan, index, record) {
    const /** @type {string[]} */ out = [];
    const gateCells = new Set();
    for (const gate of /** @type {any[]} */ (record?.gates ?? [])) {
        const at = /** @type {any} */ (gate).at ?? {};
        const reach = Math.max(2, Number(gate.width ?? 5));
        for (let dx = -reach; dx <= reach; dx += 1) {
            for (let dz = -reach; dz <= reach; dz += 1) {
                gateCells.add(`${String(Number(at.x ?? 0) + dx)},${String(Number(at.z ?? 0) + dz)}`);
            }
        }
    }

    for (const stage of ["lots", "dressing"]) {
        const list = /** @type {any[]} */ (record?.[stage] ?? []);
        for (let i = 0; i < list.length; i += 1) {
            const element = list[i];
            if (BOUNDARY_KINDS.has(String(element.kind))) {
                continue;
            }
            const stray = [];
            for (const op of siteOpsFor(record, stage, i)) {
                if (!mine(plan, op.x, op.z, index)) {
                    stray.push(`${String(op.x)},${String(op.z)}`);
                }
            }
            if (stray.length > 0) {
                out.push(`${stage}/${element.id}: ${String(stray.length)} cells fall outside district ${String(index)} (first: ${stray.slice(0, 3).join(" ")})`);
            }
        }
    }

    const roads = /** @type {any[]} */ (record?.roads ?? []);
    for (let i = 0; i < roads.length; i += 1) {
        const element = roads[i];
        const isLink = String(element.kind) === "road-link" || Number(element.district) !== index;
        const outside = [];
        for (const op of siteOpsFor(record, "roads", i)) {
            if (!mine(plan, op.x, op.z, index) && !gateCells.has(`${String(op.x)},${String(op.z)}`)) {
                outside.push(op);
            }
        }
        if (!isLink) {
            if (outside.length > 0) {
                out.push(`roads/${element.id}: ${String(outside.length)} cells leave district ${String(index)} without being an approved link (first: ${String(outside[0].x)},${String(outside[0].z)})`);
            }
            continue;
        }
        if (outside.length > 0) {
            const targets = new Set(outside.map((op) => Number(planLabelAt(plan, op.x, op.z))));
            const districts = [...targets].filter((label) => label > 0);
            if (districts.length > 1) {
                out.push(`roads/${element.id}: a link may join one paired district, this one enters ${districts.join(", ")}`);
            }
            if (element.throughGate !== true) {
                out.push(`roads/${element.id}: leaves the district but passes no gate`);
            }
        }
    }
    return out;
}

/**
 * Order a ring band of cells into one walkable polyline by nearest-neighbour walk, with a fixed
 * tie-break so the result never depends on iteration luck. The patrol lane arrives from zoning as
 * a scan-ordered list; `planRoadProfile` needs an ordered path to smooth and to place stairs on.
 *
 * @param {[number, number][]} cells
 * @returns {[number, number][]}
 */
function orderRing(cells) {
    if (cells.length === 0) {
        return [];
    }
    const map = new Map();
    for (const [x, z] of cells) {
        map.set(`${String(x)},${String(z)}`, [x, z]);
    }
    const /** @type {Set<string>} */ remaining = new Set(map.keys());
    const /** @type {[number, number][]} */ out = [];
    let current = /** @type {[number, number]} */ (map.get([...remaining][0]));
    while (remaining.size > 0) {
        remaining.delete(`${String(current[0])},${String(current[1])}`);
        out.push(current);
        let best = null;
        let bestD = Infinity;
        for (const k of remaining) {
            const candidate = /** @type {[number, number]} */ (map.get(k));
            const d = Math.abs(candidate[0] - current[0]) + Math.abs(candidate[1] - current[1]);
            if (d < bestD || (d === bestD && best !== null && (candidate[0] < best[0] || (candidate[0] === best[0] && candidate[1] < best[1])))) {
                bestD = d;
                best = candidate;
            }
        }
        if (best === null) {
            break;
        }
        current = best;
    }
    return out;
}

/**
 * @param {any} plan
 * @param {number} x
 * @param {number} z
 * @param {number} index
 */
function mine(plan, x, z, index) {
    return Number(planLabelAt(plan, x, z)) === index;
}

/**
 * Total ops the plan will emit, from the stored element totals (no regeneration).
 * @param {any} record
 */
export function siteOpCount(record) {
    return STAGES.reduce((sum, stage) => sum + /** @type {any[]} */ (record?.[stage] ?? []).reduce((inner, element) => inner + Number(element.total), 0), 0);
}

export const SITE_STAGES = STAGES;
