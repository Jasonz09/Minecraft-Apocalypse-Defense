// Deterministic district fixture for the undo suites. Not a test file (no *.test.mjs suffix), so the
// test runner does not execute it. Terrain ops come from the real planTerrain (structures/terrain.js),
// so the cut / fill / top mix is what the builder would really journal for a hilly 49 x 49 site.
import { planTerrain } from "../../CivilizationApocalypse_BP/scripts/structures/terrain.js";
import { AIR, createJournal, planUndo, recordWrite } from "../../CivilizationApocalypse_BP/scripts/civ/undo.js";

export const DIM = "minecraft:overworld";
export const ORIGIN = { x: -120, z: 340 };
export const HALF = 24; // footprint 49 x 49

/** Seeded linear congruential generator, returns floats in [0, 1). */
export function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** Deterministic integer hash of footprint-local coordinates. */
const hash = (x, z, seed) => (Math.imul(x * 73856093 ^ z * 19349663 ^ seed * 83492791, 2654435761) >>> 0) % 1000;

/** Block id of the surface and of the strata under it, by depth below the surface (0 = surface). */
export function strataAt(topId, depth) {
    if (depth === 0) return topId;
    return depth <= 3 ? "minecraft:dirt" : "minecraft:stone";
}

/**
 * Build the journal a district build would write, using the real terrain planner.
 * Defaults: hard-cap limits 6 / 6 (about 5,800 cut + fill + top cells) and about 400 vegetation cells.
 * @param {{ seed?: number, amp?: number, freq?: number, clearColumnChance?: number, half?: number, limits?: { maxCut: number, maxFill: number } }} [options]
 */
export function buildDistrictJournal(options = {}) {
    const seed = options.seed ?? 21;
    const amp = options.amp ?? 6;
    const freq = options.freq ?? 0.35;
    const half = options.half ?? HALF;
    const clearChance = options.clearColumnChance ?? 0.2;
    const limits = options.limits ?? { maxCut: 6, maxFill: 6 };
    const size = half * 2 + 1;

    /** @type {{ ground: number, topId: string }[]} */
    const columns = [];
    for (let i = 0; i < size; i += 1) {
        for (let j = 0; j < size; j += 1) {
            const x = i - half;
            const z = j - half;
            const noise = (Math.sin(freq * x + seed) + Math.cos(freq * 0.83 * z + 2 * seed) + 0.5 * Math.sin(freq * 0.47 * (x - z) + seed * 3)) / 2.5;
            const ground = 64 + Math.round(amp * noise);
            const roll = hash(x, z, seed) % 10;
            const topId = roll < 8 ? "minecraft:grass_block" : roll < 9 ? "minecraft:dirt" : "minecraft:sand";
            columns.push({ ground, topId });
        }
    }
    const plan = planTerrain(columns, half, limits);
    if (!plan.ok) throw new Error(`fixture terrain refused: ${plan.problems.join("; ")}`);

    const journal = createJournal(DIM);
    /** @type {Map<string, { ground: number, topId: string }>} */
    const columnAt = new Map();
    for (let i = 0; i < size; i += 1) {
        for (let j = 0; j < size; j += 1) columnAt.set(`${i - half},${j - half}`, columns[i * size + j]);
    }
    const written = [];
    for (const op of plan.ops) {
        const col = columnAt.get(`${op.x},${op.z}`);
        const wx = ORIGIN.x + op.x;
        const wz = ORIGIN.z + op.z;
        let prior;
        let id;
        if (op.kind === "cut") {
            prior = strataAt(col.topId, col.ground - op.y);
            id = AIR;
        } else if (op.kind === "top") {
            prior = strataAt(col.topId, col.ground - op.y);
            id = "minecraft:grass_block";
        } else {
            prior = AIR;
            id = op.id;
        }
        const r = recordWrite(journal, { x: wx, y: op.y, z: wz, kind: op.kind, prior, written: id });
        if (!r.recorded) throw new Error(`fixture write refused: ${String(r.reason)}`);
        written.push(`${wx},${op.y},${wz}`);
    }

    // Vegetation above the surface, only on columns the platform does not fill (the builder clears these first).
    const pick = rng(seed * 7 + 1);
    let plants = 0;
    for (let i = 0; i < size; i += 1) {
        for (let j = 0; j < size; j += 1) {
            const x = i - half;
            const z = j - half;
            const col = columns[i * size + j];
            if (col.ground < plan.baseY) continue;
            if (pick() >= clearChance) continue;
            const tall = pick() < 0.5;
            const cells = tall ? 2 : 1;
            for (let k = 1; k <= cells; k += 1) {
                const r = recordWrite(journal, {
                    x: ORIGIN.x + x,
                    y: col.ground + k,
                    z: ORIGIN.z + z,
                    kind: "clear",
                    prior: tall ? "minecraft:tall_grass" : "minecraft:fern",
                    written: AIR,
                });
                if (!r.recorded) throw new Error(`fixture clear refused: ${String(r.reason)}`);
                plants += 1;
            }
        }
    }
    return { journal, plan: { baseY: plan.baseY, counts: plan.counts }, plants, columns, half };
}

/**
 * Live world after the build: every journaled cell holds what the builder wrote.
 * @param {ReturnType<typeof buildDistrictJournal>["journal"]} journal
 */
export function liveAfterBuild(journal) {
    /** @type {Map<string, string>} */
    const live = new Map();
    for (const e of journal.entries.values()) live.set(`${e.x},${e.y},${e.z}`, e.written);
    return live;
}

/**
 * Deterministic mutations of the live world, disjoint by construction, with the exact expected outcome.
 * @param {ReturnType<typeof buildDistrictJournal>["journal"]} journal
 * @param {number} seed
 */
export function mutateDistrict(journal, seed) {
    const live = liveAfterBuild(journal);
    const entries = [...journal.entries.values()].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
    const used = new Set();
    const r = rng(seed);
    /** @param {(e: any) => boolean} predicate @param {number} n */
    const take = (predicate, n) => {
        const candidates = entries.filter((e) => !used.has(`${e.x},${e.y},${e.z}`) && predicate(e));
        const chosen = [];
        for (let i = 0; i < n && candidates.length > 0; i += 1) {
            const at = Math.floor(r() * candidates.length);
            const [e] = candidates.splice(at, 1);
            used.add(`${e.x},${e.y},${e.z}`);
            chosen.push(e);
        }
        return chosen;
    };
    const key = (/** @type {any} */ e) => `${e.x},${e.y},${e.z}`;

    const placed = take((e) => e.kind === "cut", 40);
    for (const e of placed) live.set(key(e), "minecraft:oak_planks"); // a player built on our cut cell
    const removed = take((e) => e.kind === "top", 15);
    for (const e of removed) live.set(key(e), AIR); // a player broke our resurfaced cell
    const already = take((e) => e.kind === "clear", 10);
    for (const e of already) live.set(key(e), e.prior); // restored by hand already
    const unloaded = take((e) => e.kind === "fill", 30);
    const unloadedKeys = new Set(unloaded.map(key));
    const protectedCells = take((e) => e.kind === "fill", 25);
    const sameAsPrior = take((e) => e.kind === "cut", 8);

    /** @type {Map<string, string | null>} */
    const protect = new Map();
    for (const e of protectedCells) protect.set(key(e), "minecraft:stone_bricks"); // a wall cell of the plan
    for (const e of sameAsPrior) protect.set(key(e), e.prior); // a plan cell that already equals the prior id

    const changed = placed.length + removed.length;
    return {
        live,
        protect,
        unloadedKeys,
        expected: {
            changed,
            already: already.length,
            unloaded: unloaded.length,
            protected: protectedCells.length,
            restoredSameAsPrior: sameAsPrior.length,
        },
        touched: { placed, removed, protectedCells, unloaded, already, sameAsPrior },
    };
}

export class Crash extends Error {}

/**
 * Map-backed world with the engine's string-size limit and write-count crash injection.
 * Pass `props` to simulate a restart: a new world object over the same stored properties.
 * @param {{ props?: Map<string, unknown>, limit?: number, crashAfter?: number | null }} [options]
 */
export function fakeWorld(options = {}) {
    const props = options.props ?? new Map();
    const limit = options.limit ?? 32767;
    const world = {
        props,
        writes: 0,
        crashAfter: options.crashAfter ?? null,
        dead: false,
        /** @param {string} k */
        getDynamicProperty: (k) => props.get(k),
        /** @param {string} k @param {any} v */
        setDynamicProperty(k, v) {
            if (world.dead || (world.crashAfter !== null && world.writes >= world.crashAfter)) {
                world.dead = true;
                throw new Crash("simulated crash");
            }
            if (typeof v === "string" && v.length > limit) throw new RangeError(`property value of ${String(v.length)} chars exceeds ${String(limit)}`);
            world.writes += 1;
            if (v === undefined) props.delete(k);
            else props.set(k, v);
        },
        getDynamicPropertyIds: () => [...props.keys()],
    };
    return world;
}

/**
 * Run the cooperative planner to completion, recording the shape of every slice.
 * @param {any} journal @param {(x: number, y: number, z: number) => string | undefined} read @param {any} [options]
 */
export function runPlan(journal, read, options = {}) {
    const it = planUndo(journal, read, options);
    /** @type {any[]} */
    const ops = [];
    /** @type {{ ops: number, reads: number, cursor: number }[]} */
    const slices = [];
    let r = it.next();
    while (!r.done) {
        slices.push({ ops: r.value.ops.length, reads: r.value.reads, cursor: r.value.cursor });
        ops.push(...r.value.ops);
        r = it.next();
    }
    return { ops, slices, summary: r.value };
}

/** Apply restore ops to a live map, as the builder would with setPermutation. @param {Map<string, string>} live @param {{ x: number, y: number, z: number, id: string }[]} ops */
export function applyOps(live, ops) {
    for (const op of ops) live.set(`${op.x},${op.y},${op.z}`, op.id);
}
