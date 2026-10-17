import { SIM } from "../config.js";
import { collectBuildQueue } from "../sim/construction.js";
import { world } from "@minecraft/server";

/**
 * Opt-in physical construction adapter.
 *
 * The simulation itself never writes blocks: it plans staged projects in saved state. This
 * module is the only thing that turns a plan into blocks, and it is deliberately gated
 * behind a demo switch plus an anchor the player sets by hand, because physical building
 * cannot be verified without a running Minecraft world.
 *
 * Safety rules enforced here:
 *  - refuse unless the demo switch is on and an anchor has been set deliberately;
 *  - skip any position whose chunk is not loaded (getBlock throws for unloaded chunks);
 *  - never overwrite a block that is not air, so player builds and terrain stay intact;
 *  - place at most SIM.maxBlocksPerStep blocks per call.
 */

const DEMO_SWITCH_KEY = "civ:demo-build";
const ANCHOR_KEY = "civ:demo-anchor";

/** Demo vocabulary only - what each planned project kind looks like when materialised. */
const BLOCK_FOR_KIND = /** @type {Record<string, string>} */ ({
    walls: "minecraft:stone_bricks",
    gate: "minecraft:iron_bars",
    road: "minecraft:coarse_dirt",
    homes: "minecraft:oak_planks",
    farms: "minecraft:farmland",
    storehouse: "minecraft:deepslate_bricks",
    barracks: "minecraft:polished_andesite",
});

/**
 * @typedef {{ getDynamicProperty: (key: string) => any, setDynamicProperty: (key: string, value?: any) => void }} PropertyTarget
 */

/**
 * @param {PropertyTarget} target
 */
export function isDemoEnabled(target) {
    return target.getDynamicProperty(DEMO_SWITCH_KEY) === true;
}

/**
 * @param {PropertyTarget} target
 * @param {boolean} enabled
 */
export function setDemoEnabled(target, enabled) {
    target.setDynamicProperty(DEMO_SWITCH_KEY, enabled);
}

/**
 * @param {PropertyTarget} target
 * @param {{ x: number, y: number, z: number }} position
 */
export function setDemoAnchor(target, position) {
    target.setDynamicProperty(ANCHOR_KEY, position);
}

/**
 * @param {PropertyTarget} target
 * @returns {{ x: number, y: number, z: number } | undefined}
 */
export function getDemoAnchor(target) {
    const value = target.getDynamicProperty(ANCHOR_KEY);
    if (value === null || typeof value !== "object") {
        return undefined;
    }
    const anchor = /** @type {{ x?: unknown, y?: unknown, z?: unknown }} */ (value);
    if (typeof anchor.x !== "number" || typeof anchor.y !== "number" || typeof anchor.z !== "number") {
        return undefined;
    }
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(anchor.z)) {
        return undefined;
    }
    return { x: Math.floor(anchor.x), y: Math.floor(anchor.y), z: Math.floor(anchor.z) };
}

/**
 * A deterministic square ring around the anchor, growing with each completed stage, so the
 * same plan always produces the same outline.
 *
 * @param {{ x: number, y: number, z: number }} anchor
 * @param {number} stage
 * @param {number} maxBlocks
 */
export function ringPositions(anchor, stage, maxBlocks) {
    const radius = 2 + Math.max(0, stage);
    const /** @type {{ x: number, y: number, z: number }[]} */ positions = [];
    const push = (
        /** @type {number} */ x,
        /** @type {number} */ y,
        /** @type {number} */ z,
    ) => {
        if (positions.length < maxBlocks) {
            positions.push({ x, y, z });
        }
    };

    for (let offset = -radius; offset <= radius; offset += 1) {
        if (positions.length >= maxBlocks) {
            break;
        }
        push(anchor.x + offset, anchor.y, anchor.z - radius);
        push(anchor.x + offset, anchor.y, anchor.z + radius);
        if (offset > -radius && offset < radius) {
            push(anchor.x - radius, anchor.y, anchor.z + offset);
            push(anchor.x + radius, anchor.y, anchor.z + offset);
        }
    }
    return positions;
}

/**
 * Materialise the next piece of the first in-progress project.
 *
 * @param {any} dimension a Minecraft Dimension (world.getDimension())
 * @param {any} kingdom
 * @param {{ limit?: number, anchor?: { x: number, y: number, z: number } }} options
 * @returns {{ placed: number, skipped: { position: any, reason: string }[], project: string | undefined, kind: string | undefined, blocked: string | undefined }}
 */
export function materialiseNextStage(dimension, kingdom, options = {}) {
    const limit = Math.max(1, Math.min(Number(SIM.maxBlocksPerStep), Number(options.limit ?? SIM.maxBlocksPerStep)));
    const anchor = options.anchor ?? getDemoAnchor(world);
    if (anchor === undefined) {
        return { placed: 0, skipped: [], project: undefined, kind: undefined, blocked: "no demo anchor is set" };
    }

    const queue = collectBuildQueue(kingdom, 1);
    if (queue.length === 0) {
        return { placed: 0, skipped: [], project: undefined, kind: undefined, blocked: "nothing is under construction" };
    }

    const entry = queue[0];
    const blockType = BLOCK_FOR_KIND[String(entry.kind)] ?? "minecraft:stone_bricks";
    const districts = /** @type {any[]} */ (kingdom.districts ?? []);
    const district = districts.find((candidate) => candidate.id === entry.districtId);
    const projects = /** @type {any[]} */ (district?.projects ?? []);
    const project = projects.find((candidate) => candidate.id === entry.projectId);
    if (project === undefined) {
        return { placed: 0, skipped: [], project: entry.projectId, kind: entry.kind, blocked: "the queued project is no longer on its district" };
    }

    const alreadyPlaced = Number.isInteger(project.placedBlocks) ? Number(project.placedBlocks) : 0;
    const positions = /** @type {{ x: number, y: number, z: number }[]} */ (ringPositions(anchor, Number(project.stage), limit + alreadyPlaced));
    const /** @type {{ position: any, reason: string }[]} */ skipped = [];
    let placed = 0;

    for (const position of positions.slice(alreadyPlaced)) {
        if (placed >= limit) {
            break;
        }
        let block;
        try {
            block = dimension.getBlock(position);
        } catch (error) {
            skipped.push({ position, reason: `chunk is not loaded (${String(error)})` });
            continue;
        }
        if (block === undefined) {
            skipped.push({ position, reason: "no block at this position" });
            continue;
        }
        if (block.isAir !== true) {
            skipped.push({ position, reason: `${String(block.typeId)} is not air - nothing is overwritten` });
            continue;
        }
        try {
            dimension.setBlockType(block.location, blockType);
            placed += 1;
        } catch (error) {
            skipped.push({ position: block.location, reason: `setBlockType failed (${String(error)})` });
        }
    }

    project.placedBlocks = alreadyPlaced + placed;
    return { placed, skipped, project: project.id, kind: project.kind, blocked: undefined };
}

export const DEMO_KEYS = { switch: DEMO_SWITCH_KEY, anchor: ANCHOR_KEY };
