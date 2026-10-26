/**
 * Terrain-aware construction primitives. Pure planning (no Minecraft imports): every function
 * takes ground heights in WORLD/LOCAL block coordinates (whatever the caller uses, consistently)
 * and returns op lists `{ x, y, z, id, kind }` plus counts and `problems` (reject reasons).
 * `ok === false` always means ops is empty: the caller must not build a partial result.
 *
 * Direction names: north = -z, south = +z, east = +x, west = -x. A stair's `dir` is
 * the direction you walk to climb it.
 */

/**
 * @typedef {"north" | "south" | "east" | "west"} Dir
 * @typedef {"cut" | "fill" | "top" | "retain" | "stair" | "footing" | "wall" | "deck" | "pillar" | "rail" | "road"} OpKind
 * @typedef {{ x: number, y: number, z: number, id: string, kind: OpKind, dir?: Dir }} Op
 * @typedef {{ x0: number, z0: number, x1: number, z1: number }} Rect
 * @typedef {{ x0: number, z0: number, w: number, h: number, g: number[], water: (number | undefined)[], hollow: boolean[] }} Profile
 */

export const IDS = Object.freeze({
    dirt: "minecraft:dirt",
    grass: "minecraft:grass_block",
    air: "minecraft:air",
    retain: "minecraft:stone_bricks",
    stair: "minecraft:stone_brick_stairs",
    slab: "minecraft:stone_brick_slab",
    footTop: "minecraft:stone_bricks",
    footDeep: "minecraft:cobblestone",
    wall: "minecraft:stone_bricks",
    deck: "minecraft:stone_bricks",
    rail: "minecraft:stone_brick_wall",
    road: "minecraft:grass_path",
});

/**
 * Build a ground profile from a sampler. `water` is the water SURFACE y over a column (g is then the bed).
 * @param {number} x0 @param {number} z0 @param {number} w @param {number} h
 * @param {(x: number, z: number) => { g: number, water?: number, hollow?: boolean }} sampler
 * @returns {Profile}
 */
export function makeProfile(x0, z0, w, h, sampler) {
    /** @type {Profile} */
    const p = { x0, z0, w, h, g: [], water: [], hollow: [] };
    for (let z = z0; z < z0 + h; z += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
            const s = sampler(x, z);
            p.g.push(s.g);
            p.water.push(s.water);
            p.hollow.push(s.hollow === true);
        }
    }
    return p;
}

/**
 * @param {Profile} p @param {number} x @param {number} z
 * @returns {{ g: number, water: number | undefined, hollow: boolean } | null}
 */
export function profileAt(p, x, z) {
    if (x < p.x0 || z < p.z0 || x >= p.x0 + p.w || z >= p.z0 + p.h) return null;
    const i = (z - p.z0) * p.w + (x - p.x0);
    return { g: /** @type {number} */ (p.g[i]), water: p.water[i], hollow: p.hollow[i] === true };
}

/** @param {Op[]} ops @param {OpKind} kind */
const countKind = (ops, kind) => ops.filter((o) => o.kind === kind).length;

/** @param {Dir} d */
const vec = (d) => (d === "north" ? { x: 0, z: -1 } : d === "south" ? { x: 0, z: 1 } : d === "east" ? { x: 1, z: 0 } : { x: -1, z: 0 });
/** @param {number} dx @param {number} dz @returns {Dir} */
const dirOf = (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? "east" : "west") : dz >= 0 ? "south" : "north");
/** @param {Dir} d @returns {Dir} */
const opposite = (d) => (d === "north" ? "south" : d === "south" ? "north" : d === "east" ? "west" : "east");

// ---------------------------------------------------------------------------------------------
// Pad

/**
 * Level a rectangular foundation pad (inclusive rect) with cut/fill, ringed by a 1-block apron
 * that carries retaining walls (|height difference| >= 2) or a single stair block (difference 1).
 * Nothing outside rect + 1 is ever touched. The pad height is the cheapest one within the cut/fill
 * limits whose apron walls are also within `maxWall`. Water is a refusal: a lot over water or a
 * large drop uses `planDeck` instead, so the sea is never capped and a slope is never flattened.
 *
 * @param {Profile} profile @param {Rect} rect
 * @param {{ maxCut?: number, maxFill?: number, maxWall?: number, baseY?: number }} [limits]
 * @returns {{ ok: boolean, baseY: number, ops: Op[], counts: { cut: number, fill: number, top: number, retain: number, stair: number }, problems: string[], touched: Rect }}
 */
export function planPad(profile, rect, limits = {}) {
    const maxCut = limits.maxCut ?? 4;
    const maxFill = limits.maxFill ?? 4;
    const maxWall = limits.maxWall ?? 4;
    const touched = { x0: rect.x0 - 1, z0: rect.z0 - 1, x1: rect.x1 + 1, z1: rect.z1 + 1 };
    /** @param {string} problem */
    const fail = (problem) => ({ ok: false, baseY: 0, ops: [], counts: { cut: 0, fill: 0, top: 0, retain: 0, stair: 0 }, problems: [problem], touched });
    if (![rect.x0, rect.z0, rect.x1, rect.z1].every(Number.isInteger) || rect.x1 < rect.x0 || rect.z1 < rect.z0) return fail("pad rectangle is invalid");
    /** @type {{ x: number, z: number, g: number }[]} */
    const inner = [];
    /** @type {{ x: number, z: number, g: number }[]} */
    const apron = [];
    for (let z = touched.z0; z <= touched.z1; z += 1) {
        for (let x = touched.x0; x <= touched.x1; x += 1) {
            const p = profileAt(profile, x, z);
            if (p === null) return fail(`ground profile does not cover (${String(x)}, ${String(z)}) (pad + 1 block apron)`);
            if (p.hollow) return fail(`hollow ground at (${String(x)}, ${String(z)})`);
            if (p.water !== undefined) return fail(`water at (${String(x)}, ${String(z)})`);
            const isInner = x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
            (isInner ? inner : apron).push({ x, z, g: p.g });
        }
    }
    const gs = inner.map((c) => c.g);
    const lo = Math.max(...gs) - maxCut;
    const hi = Math.min(...gs) + maxFill;
    if (limits.baseY === undefined && lo > hi) return fail(`terrain is too uneven for the pad: ground y=${String(Math.min(...gs))}..${String(Math.max(...gs))} exceeds cut ${String(maxCut)} / fill ${String(maxFill)}`);
    const sorted = [...gs].sort((a, b) => a - b);
    const median = /** @type {number} */ (sorted[Math.floor(sorted.length / 2)]);
    const range = limits.baseY !== undefined ? [limits.baseY] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    let best = -1;
    let bestCost = Infinity;
    for (const y of range) {
        if (inner.some((c) => c.g - y > maxCut || y - c.g > maxFill)) continue;
        let cost = 0;
        for (const c of inner) cost += Math.abs(c.g - y);
        let wallOk = true;
        for (const c of apron) {
            const d = Math.abs(c.g - y);
            if (d >= 2) {
                if (d > maxWall) wallOk = false;
                cost += d;
            }
        }
        if (!wallOk) continue;
        if (cost < bestCost || (cost === bestCost && Math.abs(y - median) < Math.abs(best - median))) {
            best = y;
            bestCost = cost;
        }
    }
    if (bestCost === Infinity) return fail(`no pad height satisfies cut <= ${String(maxCut)}, fill <= ${String(maxFill)} and retaining walls <= ${String(maxWall)}`);
    const baseY = best;

    /** @type {Op[]} */
    const cuts = [];
    /** @type {Op[]} */
    const fills = [];
    /** @type {Op[]} */
    const retains = [];
    /** @type {Op[]} */
    const tops = [];
    /** @type {Op[]} */
    const stairs = [];
    for (const c of inner) {
        if (c.g > baseY) {
            for (let y = c.g; y > baseY; y -= 1) cuts.push({ x: c.x, y, z: c.z, id: IDS.air, kind: "cut" });
            tops.push({ x: c.x, y: baseY, z: c.z, id: IDS.grass, kind: "top" });
        } else if (c.g < baseY) {
            for (let y = c.g + 1; y < baseY; y += 1) fills.push({ x: c.x, y, z: c.z, id: IDS.dirt, kind: "fill" });
            fills.push({ x: c.x, y: baseY, z: c.z, id: IDS.grass, kind: "fill" });
        }
    }
    for (const c of apron) {
        const diff = c.g - baseY;
        const edgeX = c.x >= rect.x0 && c.x <= rect.x1;
        const edgeZ = c.z >= rect.z0 && c.z <= rect.z1;
        if (diff >= 2) {
            for (let y = baseY + 1; y <= c.g; y += 1) retains.push({ x: c.x, y, z: c.z, id: IDS.retain, kind: "retain" });
        } else if (diff <= -2) {
            for (let y = c.g + 1; y <= baseY; y += 1) retains.push({ x: c.x, y, z: c.z, id: IDS.retain, kind: "retain" });
        } else if ((edgeX || edgeZ) && Math.abs(diff) === 1) {
            // direction pointing away from the pad
            const away = edgeX ? (c.z < rect.z0 ? "north" : "south") : c.x < rect.x0 ? "west" : "east";
            if (diff === 1) stairs.push({ x: c.x, y: c.g, z: c.z, id: IDS.stair, kind: "stair", dir: away });
            else stairs.push({ x: c.x, y: baseY, z: c.z, id: IDS.stair, kind: "stair", dir: opposite(away) });
        }
    }
    cuts.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
    fills.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    retains.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    tops.sort((a, b) => a.x - b.x || a.z - b.z);
    stairs.sort((a, b) => a.x - b.x || a.z - b.z);
    const ops = [...cuts, ...fills, ...retains, ...tops, ...stairs];
    return { ok: true, baseY, ops, counts: { cut: cuts.length, fill: fills.length, top: tops.length, retain: retains.length, stair: stairs.length }, problems: [], touched };
}

// ---------------------------------------------------------------------------------------------
// Deck on pillars

/**
 * A raised deck platform ("stilts"): ONE flat surface over uneven ground, a drop or open water,
 * carried by spaced pillars down to natural ground / the sea bed. Only ground standing above the
 * deck is cut (at most `maxCut`); nothing is filled, so a slope is not flattened and the sea is not
 * drained - the water stays beside and under the deck. The apron carries a half-step slab where the
 * ground is one below the deck, a stair where it is one above, and a railing wherever the drop is
 * two or more (water included). The door lane's columns override apron ops (commitLot), so the
 * entrance stays open.
 *
 * @param {Profile} profile @param {Rect} rect
 * @param {{ baseY?: number, maxCut?: number, pillarEvery?: number, maxDepth?: number }} [limits]
 * @returns {{ ok: boolean, baseY: number, ops: Op[], counts: { cut: number, fill: number, top: number, retain: number, stair: number, deck: number, pillar: number, rail: number }, problems: string[], touched: Rect }}
 */
export function planDeck(profile, rect, limits = {}) {
    const maxCut = limits.maxCut ?? 2;
    const pillarEvery = limits.pillarEvery ?? 3;
    const maxDepth = limits.maxDepth ?? 64;
    const touched = { x0: rect.x0 - 1, z0: rect.z0 - 1, x1: rect.x1 + 1, z1: rect.z1 + 1 };
    const counts = { cut: 0, fill: 0, top: 0, retain: 0, stair: 0, deck: 0, pillar: 0, rail: 0 };
    /** @param {string} problem */
    const fail = (problem) => ({ ok: false, baseY: 0, ops: [], counts, problems: [problem], touched });
    if (![rect.x0, rect.z0, rect.x1, rect.z1].every(Number.isInteger) || rect.x1 < rect.x0 || rect.z1 < rect.z0) return fail("deck rectangle is invalid");
    if (!Number.isInteger(pillarEvery) || pillarEvery < 1) return fail("pillarEvery must be a positive integer");
    /** @type {{ x: number, z: number, g: number, water: number | undefined }[]} */
    const inner = [];
    /** @type {{ x: number, z: number, g: number, water: number | undefined }[]} */
    const apron = [];
    for (let z = touched.z0; z <= touched.z1; z += 1) {
        for (let x = touched.x0; x <= touched.x1; x += 1) {
            const p = profileAt(profile, x, z);
            if (p === null) return fail(`ground profile does not cover (${String(x)}, ${String(z)}) (deck + 1 block apron)`);
            if (p.hollow) return fail(`hollow ground at (${String(x)}, ${String(z)}): nothing solid to carry a pillar`);
            const cell = { x, z, g: p.g, water: p.water };
            const isInner = x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
            (isInner ? inner : apron).push(cell);
        }
    }
    const surface = (/** @type {{ g: number, water: number | undefined }} */ c) => (c.water !== undefined ? c.water : c.g);
    const baseY = limits.baseY ?? Math.max(...inner.map(surface));
    for (const c of inner) {
        if (c.water !== undefined && baseY < c.water) return fail(`deck at y=${String(baseY)} would be under the water surface (y=${String(c.water)}) at (${String(c.x)}, ${String(c.z)})`);
        if (c.g - baseY > maxCut) return fail(`ground at (${String(c.x)}, ${String(c.z)}) stands ${String(c.g - baseY)} above the deck (max cut ${String(maxCut)}): build the deck higher or move it`);
    }
    /** @type {Op[]} */
    const cuts = [];
    /** @type {Op[]} */
    const decks = [];
    /** @type {Op[]} */
    const pillars = [];
    /** @type {Op[]} */
    const rails = [];
    /** @type {Op[]} */
    const stairs = [];
    /** @type {Op[]} */
    const slabs = [];
    for (const c of inner) {
        if (c.g > baseY) for (let y = c.g; y > baseY; y -= 1) cuts.push({ x: c.x, y, z: c.z, id: IDS.air, kind: "cut" });
        decks.push({ x: c.x, y: baseY, z: c.z, id: IDS.deck, kind: "deck" });
        const onEdge = c.x === rect.x0 || c.x === rect.x1 || c.z === rect.z0 || c.z === rect.z1;
        const onGrid = (c.x - rect.x0) % pillarEvery === 0 && (c.z - rect.z0) % pillarEvery === 0;
        if (!onEdge && !onGrid) continue;
        const depth = baseY - 1 - c.g;
        if (depth <= 0) continue;
        if (depth > maxDepth) return fail(`pillar at (${String(c.x)}, ${String(c.z)}) would be ${String(depth)} deep (max ${String(maxDepth)}): no sea floor within reach`);
        for (let y = c.g + 1; y < baseY; y += 1) pillars.push({ x: c.x, y, z: c.z, id: y === baseY - 1 ? IDS.footTop : IDS.footDeep, kind: "pillar" });
    }
    for (const c of apron) {
        const diff = c.g - baseY;
        if (diff <= -2 || c.water !== undefined) {
            rails.push({ x: c.x, y: baseY + 1, z: c.z, id: IDS.rail, kind: "rail" });
            continue;
        }
        const edgeX = c.x >= rect.x0 && c.x <= rect.x1;
        const edgeZ = c.z >= rect.z0 && c.z <= rect.z1;
        if (!edgeX && !edgeZ) continue;
        const away = edgeX ? (c.z < rect.z0 ? "north" : "south") : c.x < rect.x0 ? "west" : "east";
        if (diff === -1) slabs.push({ x: c.x, y: baseY, z: c.z, id: IDS.slab, kind: "stair" });
        else if (diff === 1) stairs.push({ x: c.x, y: c.g, z: c.z, id: IDS.stair, kind: "stair", dir: away });
    }
    cuts.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
    pillars.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    decks.sort((a, b) => a.x - b.x || a.z - b.z);
    rails.sort((a, b) => a.x - b.x || a.z - b.z);
    stairs.sort((a, b) => a.x - b.x || a.z - b.z);
    slabs.sort((a, b) => a.x - b.x || a.z - b.z);
    const ops = [...cuts, ...pillars, ...decks, ...rails, ...stairs, ...slabs];
    return {
        ok: true,
        baseY,
        ops,
        counts: { fill: 0, top: 0, retain: 0, cut: cuts.length, stair: stairs.length + slabs.length, deck: decks.length, pillar: pillars.length, rail: rails.length },
        problems: [],
        touched,
    };
}

// ---------------------------------------------------------------------------------------------
// Foundation columns

/**
 * Pillars/footing columns that carry a building floor down to natural ground over slopes, small
 * cliffs and shallow water. The floor's lowest block is at `floorY`; a column fills
 * ground+1 .. floorY-1. Refuses hollow ground (nothing to stand on), ground that is already above
 * the floor (that needs a pad cut), and columns deeper than `maxDepth`.
 *
 * @param {Profile} profile
 * @param {{ rect?: Rect, cells?: { x: number, z: number }[], floorY: number }} footprint
 * @param {{ maxDepth?: number }} [limits]
 * @returns {{ ok: boolean, ops: Op[], columns: { x: number, z: number, ground: number, depth: number, water: boolean }[], counts: { columns: number, blocks: number, maxDepth: number }, problems: string[] }}
 */
export function planFoundationColumns(profile, footprint, limits = {}) {
    const maxDepth = limits.maxDepth ?? 8;
    /** @type {{ x: number, z: number }[]} */
    let cells = footprint.cells ?? [];
    if (footprint.rect !== undefined) {
        cells = [];
        for (let z = footprint.rect.z0; z <= footprint.rect.z1; z += 1) for (let x = footprint.rect.x0; x <= footprint.rect.x1; x += 1) cells.push({ x, z });
    }
    /** @type {string[]} */
    const problems = [];
    /** @type {Op[]} */
    const ops = [];
    /** @type {{ x: number, z: number, ground: number, depth: number, water: boolean }[]} */
    const columns = [];
    if (cells.length === 0) problems.push("footprint is empty");
    let deepest = 0;
    for (const c of cells) {
        const p = profileAt(profile, c.x, c.z);
        if (p === null) {
            problems.push(`ground profile does not cover (${String(c.x)}, ${String(c.z)})`);
            continue;
        }
        if (p.hollow) {
            problems.push(`hollow ground under (${String(c.x)}, ${String(c.z)}): nothing solid to found on`);
            continue;
        }
        if (p.g >= footprint.floorY) {
            problems.push(`ground at (${String(c.x)}, ${String(c.z)}) is y=${String(p.g)}, not below the floor at y=${String(footprint.floorY)} (cut a pad first)`);
            continue;
        }
        const depth = footprint.floorY - 1 - p.g;
        if (depth > maxDepth) {
            problems.push(`foundation at (${String(c.x)}, ${String(c.z)}) would be ${String(depth)} deep (max ${String(maxDepth)})`);
            continue;
        }
        deepest = Math.max(deepest, depth);
        columns.push({ x: c.x, z: c.z, ground: p.g, depth, water: p.water !== undefined });
        for (let y = p.g + 1; y < footprint.floorY; y += 1) ops.push({ x: c.x, y, z: c.z, id: y === footprint.floorY - 1 ? IDS.footTop : IDS.footDeep, kind: "footing" });
    }
    if (problems.length > 0) return { ok: false, ops: [], columns: [], counts: { columns: 0, blocks: 0, maxDepth: 0 }, problems };
    ops.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    return { ok: true, ops, columns, counts: { columns: columns.length, blocks: ops.length, maxDepth: deepest }, problems };
}

// ---------------------------------------------------------------------------------------------
// Walls

/**
 * Terrain-following wall: per column the base sits `footing` below the lowest neighbouring ground
 * (so no daylight under a step) and the top is the smallest line that is >= ground + height and
 * changes by at most `maxStep` per block. Refuses walls that would tower more than `maxExtra`
 * above `height` (cliffs).
 *
 * @param {(number | { x: number, z: number, g: number })[]} samples ground along the wall, in order
 * @param {number} height
 * @param {{ footing?: number, maxStep?: number, maxExtra?: number, id?: string }} [options]
 * @returns {{ ok: boolean, columns: { x: number, z: number, base: number, top: number }[], ops: Op[], counts: { wall: number, footing: number }, problems: string[] }}
 */
export function planWallProfile(samples, height, options = {}) {
    const footing = options.footing ?? 1;
    const maxStep = options.maxStep ?? 1;
    const maxExtra = options.maxExtra ?? 6;
    const id = options.id ?? IDS.wall;
    const pts = samples.map((s, i) => (typeof s === "number" ? { x: i, z: 0, g: s } : s));
    /** @param {string} problem */
    const fail = (problem) => ({ ok: false, columns: [], ops: [], counts: { wall: 0, footing: 0 }, problems: [problem] });
    if (pts.length === 0) return fail("no ground samples");
    if (!Number.isInteger(height) || height < 1) return fail("wall height must be a positive integer");
    if (pts.some((p) => !Number.isFinite(p.g))) return fail("a ground sample is not a number");
    const n = pts.length;
    const g = pts.map((p) => p.g);
    const top = g.map((v) => v + height);
    for (let i = 1; i < n; i += 1) top[i] = Math.max(/** @type {number} */ (top[i]), /** @type {number} */ (top[i - 1]) - maxStep);
    for (let i = n - 2; i >= 0; i -= 1) top[i] = Math.max(/** @type {number} */ (top[i]), /** @type {number} */ (top[i + 1]) - maxStep);
    for (let i = 0; i < n; i += 1) {
        const extra = /** @type {number} */ (top[i]) - /** @type {number} */ (g[i]) - height;
        if (extra > maxExtra) return fail(`wall would stand ${String(height + extra)} high at column ${String(i)} (limit ${String(height + maxExtra)}): ground drops too sharply`);
    }
    /** @type {Op[]} */
    const ops = [];
    const columns = [];
    for (let i = 0; i < n; i += 1) {
        const p = /** @type {{ x: number, z: number, g: number }} */ (pts[i]);
        const base = Math.min(/** @type {number} */ (g[Math.max(0, i - 1)]), /** @type {number} */ (g[i]), /** @type {number} */ (g[Math.min(n - 1, i + 1)])) - footing;
        const t = /** @type {number} */ (top[i]);
        columns.push({ x: p.x, z: p.z, base, top: t });
        for (let y = base; y <= t; y += 1) ops.push({ x: p.x, y, z: p.z, id, kind: y <= p.g ? "footing" : "wall" });
    }
    return { ok: true, columns, ops, counts: { wall: countKind(ops, "wall"), footing: countKind(ops, "footing") }, problems: [] };
}

// ---------------------------------------------------------------------------------------------
// Stairs

/**
 * Stair run (L-shaped, x first then z) from one surface block to another: at most 1 block of
 * rise per block of run, flat blocks elsewhere. `from` is the landing you start on and is not
 * placed; each following cell gets its walking surface block at that cell's height. With a
 * `profile` it also fills under the run and cuts headroom, within `maxCut`/`maxFill`.
 *
 * @param {{ x: number, y: number, z: number }} from @param {{ x: number, y: number, z: number }} to
 * @param {{ profile?: Profile, maxCut?: number, maxFill?: number }} [options]
 * @returns {{ ok: boolean, ops: Op[], surface: { x: number, y: number, z: number }[], counts: { stair: number, top: number, fill: number, cut: number }, problems: string[] }}
 */
export function planStairs(from, to, options = {}) {
    /** @param {string} problem */
    const fail = (problem) => ({ ok: false, ops: [], surface: [], counts: { stair: 0, top: 0, fill: 0, cut: 0 }, problems: [problem] });
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const rise = to.y - from.y;
    const run = Math.abs(dx) + Math.abs(dz);
    if (run === 0) return fail("stairs need a horizontal run");
    if (run < Math.abs(rise)) return fail(`too steep for stairs: rise ${String(Math.abs(rise))} over a run of ${String(run)}`);
    const maxCut = options.maxCut ?? 4;
    const maxFill = options.maxFill ?? 6;
    /** @type {{ x: number, z: number }[]} */
    const path = [];
    for (let i = 1; i <= Math.abs(dx); i += 1) path.push({ x: from.x + Math.sign(dx) * i, z: from.z });
    for (let i = 1; i <= Math.abs(dz); i += 1) path.push({ x: to.x, z: from.z + Math.sign(dz) * i });
    /** @type {Op[]} */
    const ops = [];
    const surface = [];
    let prevY = from.y;
    let prev = { x: from.x, z: from.z };
    for (let k = 1; k <= path.length; k += 1) {
        const c = /** @type {{ x: number, z: number }} */ (path[k - 1]);
        const y = from.y + Math.round((rise * k) / path.length);
        const travel = dirOf(c.x - prev.x, c.z - prev.z);
        if (y !== prevY) ops.push({ x: c.x, y, z: c.z, id: IDS.stair, kind: "stair", dir: y > prevY ? travel : opposite(travel) });
        else ops.push({ x: c.x, y, z: c.z, id: IDS.deck, kind: "top" });
        surface.push({ x: c.x, y, z: c.z });
        if (options.profile !== undefined) {
            const p = profileAt(options.profile, c.x, c.z);
            if (p === null) return fail(`ground profile does not cover (${String(c.x)}, ${String(c.z)})`);
            if (p.hollow || p.water !== undefined) return fail(`stairs cross water or hollow ground at (${String(c.x)}, ${String(c.z)})`);
            if (p.g - y > maxCut || y - p.g > maxFill) return fail(`stairs at (${String(c.x)}, ${String(c.z)}) need ${String(p.g > y ? p.g - y : y - p.g)} cut/fill (limits ${String(maxCut)}/${String(maxFill)})`);
            for (let fy = p.g + 1; fy < y; fy += 1) ops.push({ x: c.x, y: fy, z: c.z, id: IDS.footDeep, kind: "fill" });
            for (let cy = p.g; cy > y; cy -= 1) ops.push({ x: c.x, y: cy, z: c.z, id: IDS.air, kind: "cut" });
        }
        prevY = y;
        prev = c;
    }
    return { ok: true, ops, surface, counts: { stair: countKind(ops, "stair"), top: countKind(ops, "top"), fill: countKind(ops, "fill"), cut: countKind(ops, "cut") }, problems: [] };
}

// ---------------------------------------------------------------------------------------------
// Bridge

/**
 * Straight, axis-aligned bridge across a gap. `span` lists the cells in order: the first and last
 * are bank cells (solid ground), the cells between are the gap with their bed height `g` and
 * optional water surface. The deck is flat at the higher bank; pillars stand every `pillarEvery`
 * cells (and on a lower bank); railings run along the span. Lateral bed is assumed equal to the
 * centre line. Refuses long spans, banks of very different heights, pillars deeper than
 * `maxDepth`, a deck that would be flooded, and terrain that pokes above the deck.
 *
 * @param {{ x: number, z: number, g: number, water?: number }[]} span
 * @param {{ pillarEvery?: number, maxSpan?: number, maxDepth?: number, width?: number, railings?: boolean, maxBankDiff?: number }} [options]
 * @returns {{ ok: boolean, deckY: number, ops: Op[], pillars: number[], counts: { deck: number, pillar: number, rail: number }, problems: string[] }}
 */
export function planBridge(span, options = {}) {
    const every = options.pillarEvery ?? 6;
    const maxSpan = options.maxSpan ?? 24;
    const maxDepth = options.maxDepth ?? 10;
    const width = options.width ?? 3;
    const maxBankDiff = options.maxBankDiff ?? 3;
    /** @param {string} problem */
    const fail = (problem) => ({ ok: false, deckY: 0, ops: [], pillars: [], counts: { deck: 0, pillar: 0, rail: 0 }, problems: [problem] });
    const n = span.length;
    if (n < 3) return fail("a bridge needs two bank cells and at least one gap cell");
    if (!Number.isInteger(every) || every < 2) return fail("pillarEvery must be an integer >= 2");
    if (!Number.isInteger(width) || width < 1 || width > 7) return fail("bridge width must be 1..7");
    const first = /** @type {{ x: number, z: number, g: number }} */ (span[0]);
    const last = /** @type {{ x: number, z: number, g: number }} */ (span[n - 1]);
    const dx = last.x - first.x;
    const dz = last.z - first.z;
    if ((dx !== 0 && dz !== 0) || (dx === 0 && dz === 0)) return fail("bridges must run along one axis");
    const ux = Math.sign(dx);
    const uz = Math.sign(dz);
    for (let i = 0; i < n; i += 1) {
        const c = /** @type {{ x: number, z: number }} */ (span[i]);
        if (c.x !== first.x + ux * i || c.z !== first.z + uz * i) return fail(`span cell ${String(i)} is not on the straight line`);
    }
    const gap = n - 2;
    if (gap > maxSpan) return fail(`span of ${String(gap)} blocks exceeds the limit of ${String(maxSpan)}`);
    if (Math.abs(first.g - last.g) > maxBankDiff) return fail(`banks differ by ${String(Math.abs(first.g - last.g))} blocks (limit ${String(maxBankDiff)})`);
    const deckY = Math.max(first.g, last.g);
    /** @type {number[]} */
    const pillars = [];
    for (let i = 1; i <= n - 2; i += 1) {
        const c = /** @type {{ g: number, water?: number }} */ (span[i]);
        if (c.g > deckY) return fail(`terrain at span cell ${String(i)} (y=${String(c.g)}) is higher than the deck (y=${String(deckY)})`);
        if (c.water !== undefined && c.water >= deckY) return fail(`deck at y=${String(deckY)} would be under water (surface y=${String(c.water)}) at cell ${String(i)}`);
        if (i % every === 0 && c.g < deckY) {
            if (deckY - c.g > maxDepth) return fail(`pillar at span cell ${String(i)} would be ${String(deckY - c.g)} deep (limit ${String(maxDepth)})`);
            pillars.push(i);
        }
    }
    // lowest-risk check: the longest unsupported run must not exceed every - 1 cells
    let run = 0;
    for (let i = 1; i <= n - 2; i += 1) {
        run = pillars.includes(i) || /** @type {{ g: number }} */ (span[i]).g >= deckY ? 0 : run + 1;
        if (run > every - 1) return fail(`unsupported run longer than ${String(every - 1)} blocks near span cell ${String(i)} (pillar position unsafe)`);
    }
    const lx = -uz;
    const lz = ux;
    const half = Math.floor(width / 2);
    const offsets = Array.from({ length: width }, (_, k) => k - half);
    const outer = width === 1 ? [0] : [offsets[0] ?? 0, offsets[width - 1] ?? 0];
    /** @type {Op[]} */
    const ops = [];
    for (let i = 0; i < n; i += 1) {
        const c = /** @type {{ x: number, z: number, g: number }} */ (span[i]);
        const isBank = i === 0 || i === n - 1;
        for (const o of offsets) ops.push({ x: c.x + lx * o, y: deckY, z: c.z + lz * o, id: IDS.deck, kind: "deck" });
        if (pillars.includes(i) || (isBank && c.g < deckY - 1)) {
            for (const o of outer) for (let y = c.g + 1; y < deckY; y += 1) ops.push({ x: c.x + lx * o, y, z: c.z + lz * o, id: IDS.footTop, kind: "pillar" });
        }
        if (options.railings !== false && !isBank) for (const o of outer) ops.push({ x: c.x + lx * o, y: deckY + 1, z: c.z + lz * o, id: IDS.rail, kind: "rail" });
    }
    return { ok: true, deckY, ops, pillars, counts: { deck: countKind(ops, "deck"), pillar: countKind(ops, "pillar"), rail: countKind(ops, "rail") }, problems: [] };
}

// ---------------------------------------------------------------------------------------------
// Roads

/**
 * Smoothed road surface along a centre line: moving average (radius `smooth`), then limited to
 * `maxStep` (1) per block so every height change is exactly one stair block. The surface may
 * deviate from natural ground by at most `maxDev`; deeper cuts/fills or any water refuse (use
 * `planBridge` for crossings). Width is the caller's business: plan each lane's centre line.
 *
 * @param {(number | { x: number, z: number, g: number, water?: boolean })[]} samples
 * @param {{ smooth?: number, maxStep?: number, maxDev?: number }} [options]
 * @returns {{ ok: boolean, surface: number[], ops: Op[], counts: { road: number, stair: number, fill: number, cut: number }, maxStep: number, problems: string[] }}
 */
export function planRoadProfile(samples, options = {}) {
    const smooth = options.smooth ?? 2;
    const maxStep = options.maxStep ?? 1;
    const maxDev = options.maxDev ?? 3;
    const pts = samples.map((s, i) => (typeof s === "number" ? { x: i, z: 0, g: s, water: false } : { water: false, ...s }));
    /** @param {string} problem */
    const fail = (problem) => ({ ok: false, surface: [], ops: [], counts: { road: 0, stair: 0, fill: 0, cut: 0 }, maxStep: 0, problems: [problem] });
    const n = pts.length;
    if (n === 0) return fail("no samples");
    const wet = pts.findIndex((p) => p.water);
    if (wet >= 0) return fail(`road crosses water at sample ${String(wet)}: plan a bridge`);
    if (pts.some((p) => !Number.isFinite(p.g))) return fail("a ground sample is not a number");
    const g = pts.map((p) => p.g);
    const s = g.map((_, i) => {
        if (i === 0 || i === n - 1) return /** @type {number} */ (g[i]);
        let sum = 0;
        let c = 0;
        for (let k = Math.max(0, i - smooth); k <= Math.min(n - 1, i + smooth); k += 1) {
            sum += /** @type {number} */ (g[k]);
            c += 1;
        }
        return Math.round(sum / c);
    });
    for (let i = 1; i < n; i += 1) s[i] = Math.max(/** @type {number} */ (s[i - 1]) - maxStep, Math.min(/** @type {number} */ (s[i - 1]) + maxStep, /** @type {number} */ (s[i])));
    for (let i = n - 2; i >= 0; i -= 1) s[i] = Math.max(/** @type {number} */ (s[i + 1]) - maxStep, Math.min(/** @type {number} */ (s[i + 1]) + maxStep, /** @type {number} */ (s[i])));
    for (let i = 0; i < n; i += 1) {
        const dev = Math.abs(/** @type {number} */ (s[i]) - /** @type {number} */ (g[i]));
        if (dev > maxDev) return fail(`road surface would differ from the ground by ${String(dev)} at sample ${String(i)} (limit ${String(maxDev)}): ground is too steep for this route`);
    }
    /** @type {Op[]} */
    const ops = [];
    let biggest = 0;
    for (let i = 0; i < n; i += 1) {
        const p = /** @type {{ x: number, z: number, g: number }} */ (pts[i]);
        const y = /** @type {number} */ (s[i]);
        const prev = i > 0 ? /** @type {{ x: number, z: number }} */ (pts[i - 1]) : null;
        const prevY = i > 0 ? /** @type {number} */ (s[i - 1]) : y;
        const travel = prev === null ? "east" : dirOf(p.x - prev.x, p.z - prev.z);
        biggest = Math.max(biggest, Math.abs(y - prevY));
        for (let cy = p.g; cy > y; cy -= 1) ops.push({ x: p.x, y: cy, z: p.z, id: IDS.air, kind: "cut" });
        for (let fy = p.g + 1; fy < y; fy += 1) ops.push({ x: p.x, y: fy, z: p.z, id: IDS.dirt, kind: "fill" });
        if (y !== prevY) ops.push({ x: p.x, y, z: p.z, id: IDS.stair, kind: "stair", dir: y > prevY ? travel : opposite(travel) });
        else ops.push({ x: p.x, y, z: p.z, id: IDS.road, kind: "road" });
    }
    return { ok: true, surface: s, ops, counts: { road: countKind(ops, "road"), stair: countKind(ops, "stair"), fill: countKind(ops, "fill"), cut: countKind(ops, "cut") }, maxStep: biggest, problems: [] };
}

export { vec as directionVector };
