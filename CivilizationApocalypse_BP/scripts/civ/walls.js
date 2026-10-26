/**
 * Terrain-following wall construction. PURE: no Minecraft import, no world access.
 *
 * Input is a wall CENTRELINE (integer [x, z] points; consecutive points that are not 8-adjacent are
 * rasterised here with Bresenham) plus a ground profile sampled during the read-only planning scan. Output is
 * a stream of PLACE-ONLY block ops, grouped into bounded segments so a `system.runJob` generator can persist
 * a cursor (the segment index) and resume. Nothing in this module ever produces an air/removal op, so a
 * wall segment can never be demolished by running it again; every cell is emitted at most once per plan.
 *
 * Cross-section (thickness 3 = the 3x3 square dilation of the centreline, which is a 4-connected barrier):
 *
 *      merlon (2 high, every other column)        merlon
 *      ┌──┐   walkway (polished andesite)   ┌──┐
 *   ───┘  └───────────────────────────────┘  └───   <- top block y = ground + WALL.height
 *      stone-brick body, solid, no hollows
 *   ───────────────────────────────────────────────  <- ground surface
 *      cobblestone footing, WALL.footing deep (+2 spare where the ground height is only estimated)
 *
 * Ground height convention: `groundY` is the Y of the top solid block of the ground, so a player stands at
 * groundY + 1. The wall's top block is at groundY + WALL.height; the walkway stands one above it.
 *
 * Terrain following: top(i) = max over j of (ground(j) + height - |i - j|) along the centreline, then a 2-D
 * relaxation over the 8-neighbourhood of columns, so every pair of adjacent wall columns differs by at most
 * ONE block in height (a walkable stair-step) and no column is ever lower than ground + WALL.height.
 *
 * @typedef {{ x: number, y: number, z: number, id: string, layer: "footing" | "body" | "walkway" | "parapet" | "tower" | "buttress" }} WallOp
 * @typedef {{ index: number, columns: number, ops: WallOp[] }} WallSegment
 * @typedef {{ x: number, z: number, index: number, kind: "corner" | "spacing" | "end" }} WallTower
 * @typedef {{ at: { x: number, z: number }, axis: "x" | "z" }} GateFootprintInput
 * @typedef {{
 *   closed?: boolean, towerSpacing?: number, cornerAngle?: number, buttressSpacing?: number,
 *   gates?: GateFootprintInput[], maxOpsPerSegment?: number, height?: number,
 *   baseFor?: (x: number, z: number) => number | undefined, maxFoundation?: number
 * }} WallOptions
 */

/** Wall geometry constants shared with civ/gates.js. */
export const WALL = Object.freeze({
    thickness: 3,
    height: 7,
    footing: 2,
    /** Extra footing where the ground height under a column is only an estimate from neighbours. */
    estimateFooting: 2,
    towerRadius: 2,
    towerRise: 4,
    towerSpacingMin: 30,
    towerSpacingMax: 40,
    towerSpacingDefault: 34,
    cornerAngleDefault: 60,
    buttressSpacing: 8,
    merlonHeight: 2,
    maxPathLength: 6000,
    minSegmentOps: 64,
    defaultSegmentOps: 400,
    /** Half extents of the gatehouse footprint that wall columns must leave free (see civ/gates.js). */
    gateHalfU: 5,
    gateHalfV: 2,
});

const ID = Object.freeze({
    stone: "minecraft:stone_bricks",
    mossy: "minecraft:mossy_stone_bricks",
    cracked: "minecraft:cracked_stone_bricks",
    cobble: "minecraft:cobblestone",
    mossyCobble: "minecraft:mossy_cobblestone",
    walkway: "minecraft:polished_andesite",
});

/** Every block id this module can emit (the tests verify them against the installed game data). */
export const WALL_BLOCK_IDS = Object.freeze(Object.values(ID));

/**
 * Deterministic coordinate hash in 0..2^32-1.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function cellHash(x, y, z) {
    let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function bodyBlock(x, y, z) {
    const roll = cellHash(x, y, z) % 100;
    return roll < 70 ? ID.stone : roll < 85 ? ID.mossy : ID.cracked;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function footingBlock(x, y, z) {
    return cellHash(x, y, z) % 100 < 60 ? ID.cobble : ID.mossyCobble;
}

/** @param {number} x @param {number} z */
const keyOf = (x, z) => `${String(x)},${String(z)}`;

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {number}
 */
function mustInt(value, what) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${what} must be an integer, got ${String(value)}`);
    }
    return value;
}

/**
 * Bresenham rasterisation of a centreline into 8-connected cells. `source[i]` is the (fractional) index of
 * the original path point cell i lies on, used to interpolate array-shaped ground profiles.
 *
 * @param {number[][]} path
 * @param {boolean} closed
 * @returns {{ cells: [number, number][], source: number[] }}
 */
export function rasterizePath(path, closed) {
    if (!Array.isArray(path) || path.length < 2) {
        throw new Error("a wall path needs at least two points");
    }
    /** @type {[number, number][]} */
    const points = path.map((point, index) => {
        if (!Array.isArray(point) || point.length < 2) {
            throw new Error(`path point ${String(index)} must be [x, z]`);
        }
        return [mustInt(point[0], `path[${String(index)}].x`), mustInt(point[1], `path[${String(index)}].z`)];
    });
    const legs = closed ? points.length : points.length - 1;
    /** @type {[number, number][]} */
    const cells = [];
    /** @type {number[]} */
    const source = [];
    for (let leg = 0; leg < legs; leg += 1) {
        const [x0, z0] = /** @type {[number, number]} */ (points[leg]);
        const [x1, z1] = /** @type {[number, number]} */ (points[(leg + 1) % points.length]);
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
        for (let t = leg === 0 ? 0 : 1; t <= steps; t += 1) {
            const fraction = steps === 0 ? 0 : t / steps;
            const x = Math.round(x0 + (x1 - x0) * fraction);
            const z = Math.round(z0 + (z1 - z0) * fraction);
            const last = cells[cells.length - 1];
            if (last !== undefined && last[0] === x && last[1] === z) {
                continue;
            }
            cells.push([x, z]);
            source.push(leg + fraction);
            if (cells.length > WALL.maxPathLength) {
                throw new Error(`wall path longer than ${String(WALL.maxPathLength)} cells`);
            }
        }
    }
    if (closed && cells.length > 1) {
        const first = /** @type {[number, number]} */ (cells[0]);
        const last = /** @type {[number, number]} */ (cells[cells.length - 1]);
        if (first[0] === last[0] && first[1] === last[1]) {
            cells.pop();
            source.pop();
        }
    }
    if (cells.length < 2) {
        throw new Error("a wall path needs at least two distinct cells");
    }
    return { cells, source };
}

/**
 * @typedef {((x: number, z: number) => number | undefined) | Map<string, number> | Record<string, number> | number[]} GroundProfile
 */

/**
 * @param {GroundProfile} profile
 * @param {[number, number][]} cells
 * @param {number[]} source
 * @param {number} pathLength
 * @returns {{ ground: number[], exact: (x: number, z: number) => number | undefined }}
 */
function resolveGround(profile, cells, source, pathLength) {
    /** @type {(x: number, z: number) => number | undefined} */
    let exact = () => undefined;
    /** @type {(number | undefined)[]} */
    const raw = new Array(cells.length).fill(undefined);
    if (Array.isArray(profile)) {
        if (profile.length !== pathLength) {
            throw new Error(`ground profile array must be parallel to the path (${String(profile.length)} vs ${String(pathLength)})`);
        }
        for (let i = 0; i < cells.length; i += 1) {
            const s = /** @type {number} */ (source[i]);
            const lo = Math.min(profile.length - 1, Math.floor(s));
            const hi = Math.min(profile.length - 1, lo + 1);
            const a = profile[lo];
            const b = profile[hi];
            if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) {
                raw[i] = undefined;
            } else {
                raw[i] = Math.round(a + (b - a) * (s - lo));
            }
        }
    } else {
        if (typeof profile === "function") {
            exact = profile;
        } else if (profile instanceof Map) {
            exact = (x, z) => profile.get(keyOf(x, z));
        } else if (profile !== null && typeof profile === "object") {
            const table = /** @type {Record<string, number>} */ (profile);
            exact = (x, z) => table[keyOf(x, z)];
        } else {
            throw new Error("ground profile must be a function, Map, object or array");
        }
        for (let i = 0; i < cells.length; i += 1) {
            const [x, z] = /** @type {[number, number]} */ (cells[i]);
            const value = exact(x, z);
            raw[i] = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
        }
    }
    if (raw.every((value) => value === undefined)) {
        throw new Error("ground profile has no samples along the wall path");
    }
    // Fill holes from the nearest sample (forward then backward), never invent a height from nothing.
    /** @type {number[]} */
    const ground = new Array(cells.length);
    let last;
    for (let i = 0; i < cells.length; i += 1) {
        if (raw[i] !== undefined) {
            last = raw[i];
        }
        ground[i] = /** @type {number} */ (last === undefined ? Number.NaN : last);
    }
    let next;
    for (let i = cells.length - 1; i >= 0; i -= 1) {
        if (raw[i] !== undefined) {
            next = raw[i];
        }
        if (Number.isNaN(ground[i])) {
            ground[i] = /** @type {number} */ (next);
        }
    }
    return { ground, exact };
}

/**
 * Raise `top` so adjacent entries differ by at most one. Closed rings go round twice.
 * @param {number[]} top
 * @param {boolean} closed
 */
function relaxAlong(top, closed) {
    const n = top.length;
    const laps = closed ? 2 : 1;
    for (let lap = 0; lap < laps; lap += 1) {
        for (let i = 1; i < n; i += 1) {
            top[i] = Math.max(/** @type {number} */ (top[i]), /** @type {number} */ (top[i - 1]) - 1);
        }
        if (closed) {
            top[0] = Math.max(/** @type {number} */ (top[0]), /** @type {number} */ (top[n - 1]) - 1);
        }
        for (let i = n - 2; i >= 0; i -= 1) {
            top[i] = Math.max(/** @type {number} */ (top[i]), /** @type {number} */ (top[i + 1]) - 1);
        }
        if (closed) {
            top[n - 1] = Math.max(/** @type {number} */ (top[n - 1]), /** @type {number} */ (top[0]) - 1);
        }
    }
}

/**
 * Footprint (world bbox, inclusive) a gatehouse reserves, in the same orientation convention as civ/gates.js.
 * @param {GateFootprintInput} gate
 */
export function gateFootprintBox(gate) {
    const halfX = gate.axis === "x" ? WALL.gateHalfU : WALL.gateHalfV;
    const halfZ = gate.axis === "x" ? WALL.gateHalfV : WALL.gateHalfU;
    return { x0: gate.at.x - halfX, x1: gate.at.x + halfX, z0: gate.at.z - halfZ, z1: gate.at.z + halfZ };
}

/**
 * @typedef {{
 *   x: number, z: number, first: number, top: number, ground: number, exact: boolean,
 *   centre: boolean, kind: "wall" | "tower" | "buttress", ring: boolean, tunnel: number | undefined, hollowTop: number | undefined,
 *   base?: number
 * }} Column
 */

/**
 * Plan a wall. Pure and deterministic; the same inputs always give the same plan.
 *
 * @param {number[][]} path wall centreline
 * @param {GroundProfile} profile ground heights (top solid block Y)
 * @param {WallOptions} [options]
 */
export function planWall(path, profile, options = {}) {
    const closed = options.closed === true;
    const height = options.height === undefined ? WALL.height : mustInt(options.height, "height");
    if (height < 4 || height > 16) {
        throw new Error("wall height must be 4..16");
    }
    const spacing = Math.max(
        WALL.towerSpacingMin,
        Math.min(WALL.towerSpacingMax - 6, options.towerSpacing === undefined ? WALL.towerSpacingDefault : mustInt(options.towerSpacing, "towerSpacing")),
    );
    const cornerCos = Math.cos(((options.cornerAngle === undefined ? WALL.cornerAngleDefault : options.cornerAngle) * Math.PI) / 180);
    const buttressSpacing = options.buttressSpacing === undefined ? WALL.buttressSpacing : mustInt(options.buttressSpacing, "buttressSpacing");
    const gates = (options.gates ?? []).map((gate, index) => {
        if (gate?.axis !== "x" && gate?.axis !== "z") {
            throw new Error(`gates[${String(index)}].axis must be 'x' or 'z'`);
        }
        mustInt(gate.at?.x, `gates[${String(index)}].at.x`);
        mustInt(gate.at?.z, `gates[${String(index)}].at.z`);
        return gateFootprintBox(gate);
    });
    /** @param {number} x @param {number} z @param {number} pad */
    const inGate = (x, z, pad = 0) => gates.some((box) => x >= box.x0 - pad && x <= box.x1 + pad && z >= box.z0 - pad && z <= box.z1 + pad);

    const { cells, source } = rasterizePath(path, closed);
    const n = cells.length;
    const { ground, exact } = resolveGround(profile, cells, source, path.length);

    // 1. Wall top along the centreline: never below ground + height, never more than one step between cells.
    const top = ground.map((g) => g + height);
    relaxAlong(top, closed);

    // 2. Columns: 3x3 square dilation of every centreline cell (a 4-connected barrier of thickness >= 3).
    /** @type {Map<string, Column>} */
    const columns = new Map();
    /** @type {Set<string>} */
    const band = new Set();
    for (let i = 0; i < n; i += 1) {
        const [cx, cz] = /** @type {[number, number]} */ (cells[i]);
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
                const x = cx + dx;
                const z = cz + dz;
                const key = keyOf(x, z);
                band.add(key);
                if (inGate(x, z)) {
                    continue;
                }
                const sample = exact(x, z);
                const hasExact = typeof sample === "number" && Number.isFinite(sample);
                const here = /** @type {number} */ (ground[i]);
                const existing = columns.get(key);
                if (existing === undefined) {
                    columns.set(key, {
                        x, z, first: i, top: /** @type {number} */ (top[i]), ground: hasExact ? Math.round(/** @type {number} */ (sample)) : here,
                        exact: hasExact, centre: dx === 0 && dz === 0, kind: "wall", ring: false, tunnel: undefined, hollowTop: undefined,
                    });
                } else {
                    existing.top = Math.max(existing.top, /** @type {number} */ (top[i]));
                    if (!existing.exact) {
                        existing.ground = Math.min(existing.ground, here);
                    }
                    existing.centre = existing.centre || (dx === 0 && dz === 0);
                }
            }
        }
    }

    // 3. 2-D relaxation: adjacent (8-neighbour) columns differ by at most one block, raising only.
    {
        /** @type {Column[]} */
        const work = [...columns.values()];
        let guard = 0;
        while (work.length > 0) {
            const column = /** @type {Column} */ (work.pop());
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dz = -1; dz <= 1; dz += 1) {
                    if (dx === 0 && dz === 0) {
                        continue;
                    }
                    const other = columns.get(keyOf(column.x + dx, column.z + dz));
                    if (other !== undefined && other.top < column.top - 1) {
                        other.top = column.top - 1;
                        work.push(other);
                    }
                }
            }
            guard += 1;
            if (guard > columns.size * 64 + 1024) {
                throw new Error("wall relaxation did not converge");
            }
        }
    }

    // 4. Towers: end caps, sharp corners, then regular spacing (never more than towerSpacingMax apart).
    /** @type {Map<number, WallTower["kind"]>} */
    const towerAt = new Map();
    const reach = 4;
    /** @type {{ index: number, cos: number }[]} */
    const cornerCandidates = [];
    for (let i = 0; i < n; i += 1) {
        if (!closed && (i < reach || i >= n - reach)) {
            continue;
        }
        const [px, pz] = /** @type {[number, number]} */ (cells[(i - reach + n) % n]);
        const [cx, cz] = /** @type {[number, number]} */ (cells[i]);
        const [qx, qz] = /** @type {[number, number]} */ (cells[(i + reach) % n]);
        const ax = cx - px;
        const az = cz - pz;
        const bx = qx - cx;
        const bz = qz - cz;
        const la = Math.hypot(ax, az);
        const lb = Math.hypot(bx, bz);
        if (la === 0 || lb === 0) {
            continue;
        }
        const cos = (ax * bx + az * bz) / (la * lb);
        if (cos <= cornerCos) {
            cornerCandidates.push({ index: i, cos });
        }
    }
    // One tower per cluster of consecutive candidates: the sharpest one.
    for (let k = 0; k < cornerCandidates.length; ) {
        let best = /** @type {{ index: number, cos: number }} */ (cornerCandidates[k]);
        let m = k + 1;
        while (m < cornerCandidates.length && /** @type {{ index: number }} */ (cornerCandidates[m]).index - /** @type {{ index: number }} */ (cornerCandidates[m - 1]).index <= 3) {
            const candidate = /** @type {{ index: number, cos: number }} */ (cornerCandidates[m]);
            if (candidate.cos < best.cos) {
                best = candidate;
            }
            m += 1;
        }
        towerAt.set(best.index, "corner");
        k = m;
    }
    if (!closed) {
        towerAt.set(0, "end");
        towerAt.set(n - 1, "end");
    } else if (!towerAt.has(0)) {
        towerAt.set(0, "spacing");
    }
    {
        let sinceLast = 0;
        const lookahead = 6;
        for (let i = closed ? 0 : 1; i < n; i += 1) {
            const stepLength = i === 0 ? 0 : Math.hypot(/** @type {[number, number]} */ (cells[i])[0] - /** @type {[number, number]} */ (cells[i - 1])[0], /** @type {[number, number]} */ (cells[i])[1] - /** @type {[number, number]} */ (cells[i - 1])[1]);
            sinceLast += stepLength;
            if (towerAt.has(i)) {
                sinceLast = 0;
                continue;
            }
            if (sinceLast >= spacing) {
                let cornerSoon = false;
                for (let k = 1; k <= lookahead && i + k < n; k += 1) {
                    if (towerAt.get(i + k) !== undefined) {
                        cornerSoon = true;
                        break;
                    }
                }
                if (!cornerSoon) {
                    towerAt.set(i, "spacing");
                    sinceLast = 0;
                }
            }
        }
    }
    /** @type {WallTower[]} */
    const towers = [];
    for (const index of [...towerAt.keys()].sort((a, b) => a - b)) {
        const [tx, tz] = /** @type {[number, number]} */ (cells[index]);
        if (inGate(tx, tz, WALL.towerRadius + 1)) {
            continue;
        }
        towers.push({ x: tx, z: tz, index, kind: /** @type {WallTower["kind"]} */ (towerAt.get(index)) });
    }

    // 5. Overlay towers (5x5, taller than the wall, with a 1-wide 2-high tunnel along the walkway).
    for (const tower of towers) {
        const window = [];
        for (let j = tower.index - 2; j <= tower.index + 2; j += 1) {
            if (closed || (j >= 0 && j < n)) {
                window.push((j + n) % n);
            }
        }
        const maxTop = Math.max(...window.map((j) => /** @type {number} */ (top[j])));
        const towerTop = maxTop + WALL.towerRise;
        /** @type {Map<string, number>} tunnel cells -> walkway top of that cell */
        const tunnel = new Map();
        for (let w = 0; w < window.length; w += 1) {
            const j = /** @type {number} */ (window[w]);
            const [x, z] = /** @type {[number, number]} */ (cells[j]);
            tunnel.set(keyOf(x, z), /** @type {number} */ (top[j]));
            const nextJ = window[w + 1];
            if (nextJ !== undefined) {
                const [nx, nz] = /** @type {[number, number]} */ (cells[nextJ]);
                if (nx !== x && nz !== z) {
                    // diagonal step: carve one orthogonal connector so a 0.6-wide walker can pass
                    const link = columns.get(keyOf(nx, z));
                    if (link !== undefined) {
                        tunnel.set(keyOf(nx, z), Math.max(/** @type {number} */ (top[j]), /** @type {number} */ (top[nextJ])));
                    }
                }
            }
        }
        const baseGround = Math.min(...window.map((j) => /** @type {number} */ (ground[j]))) - 1;
        for (let dx = -WALL.towerRadius; dx <= WALL.towerRadius; dx += 1) {
            for (let dz = -WALL.towerRadius; dz <= WALL.towerRadius; dz += 1) {
                const x = tower.x + dx;
                const z = tower.z + dz;
                if (inGate(x, z)) {
                    continue;
                }
                const key = keyOf(x, z);
                const ring = Math.max(Math.abs(dx), Math.abs(dz)) === WALL.towerRadius;
                const existing = columns.get(key);
                const tunnelTop = tunnel.get(key);
                if (existing === undefined) {
                    columns.set(key, {
                        x, z, first: tower.index, top: towerTop, ground: baseGround, exact: false, centre: false,
                        kind: "tower", ring, tunnel: tunnelTop, hollowTop: tunnelTop,
                    });
                } else {
                    existing.kind = "tower";
                    existing.ring = ring;
                    existing.top = towerTop;
                    existing.tunnel = tunnelTop;
                    existing.hollowTop = tunnelTop;
                    existing.centre = false;
                }
                band.add(key);
            }
        }
    }

    // 6. Buttresses: one-wide, below the walkway, on both faces of straight runs, away from towers and gates.
    let buttressCount = 0;
    if (buttressSpacing > 0) {
        const towerIndices = towers.map((tower) => tower.index);
        for (let i = Math.floor(buttressSpacing / 2); i < n; i += buttressSpacing) {
            if (!closed && (i < 3 || i >= n - 3)) {
                continue;
            }
            if (towerIndices.some((t) => Math.min(Math.abs(t - i), closed ? n - Math.abs(t - i) : Infinity) < 5)) {
                continue;
            }
            const [px, pz] = /** @type {[number, number]} */ (cells[(i - 2 + n) % n]);
            const [qx, qz] = /** @type {[number, number]} */ (cells[(i + 2) % n]);
            const [cx, cz] = /** @type {[number, number]} */ (cells[i]);
            const dx = qx - px;
            const dz = qz - pz;
            // straight run only: the 5-cell chord must be (nearly) axis-aligned
            if (Math.min(Math.abs(dx), Math.abs(dz)) > 0) {
                continue;
            }
            const normals = Math.abs(dx) > 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
            for (const normal of normals) {
                const bx = cx + /** @type {number[]} */ (normal)[0] * 2;
                const bz = cz + /** @type {number[]} */ (normal)[1] * 2;
                const key = keyOf(bx, bz);
                if (columns.has(key) || band.has(key) || inGate(bx, bz, 1)) {
                    continue;
                }
                columns.set(key, {
                    x: bx, z: bz, first: i, top: /** @type {number} */ (top[i]) - 2, ground: /** @type {number} */ (ground[i]) - 1,
                    exact: false, centre: false, kind: "buttress", ring: false, tunnel: undefined, hollowTop: undefined,
                });
                buttressCount += 1;
            }
        }
    }

    // Over water the column's `ground` is deliberately the water surface (the top is planned from it), and
    // `baseFor` names the bed-side base the footing must reach. Deeper than maxFoundation is refused rather
    // than building a column that stops short of the sea floor.
    if (typeof options.baseFor === "function") {
        const maxFoundation = options.maxFoundation ?? 64;
        for (const column of columns.values()) {
            const base = options.baseFor(column.x, column.z);
            if (base === undefined || !Number.isFinite(base)) {
                continue;
            }
            const rounded = Math.round(/** @type {number} */ (base));
            if (rounded >= column.ground) {
                continue;
            }
            if (column.ground - rounded > maxFoundation) {
                throw new Error(`wall column at (${String(column.x)}, ${String(column.z)}) needs a ${String(column.ground - rounded)}-block foundation (max ${String(maxFoundation)})`);
            }
            column.base = rounded;
        }
    }

    // Column order: along the path, then x, then z (a stable, resumable emission order).
    const ordered = [...columns.values()].sort((a, b) => a.first - b.first || a.x - b.x || a.z - b.z);

    /**
     * Is the column on the outer edge of the wall band (gets merlons)?
     * @param {Column} column
     */
    const isEdge = (column) =>
        !band.has(keyOf(column.x + 1, column.z)) ||
        !band.has(keyOf(column.x - 1, column.z)) ||
        !band.has(keyOf(column.x, column.z + 1)) ||
        !band.has(keyOf(column.x, column.z - 1));

    /** @param {Column} column */
    const baseOf = (column) => column.ground - WALL.footing - (column.exact ? 0 : WALL.estimateFooting);
    /** @param {Column} column */
    const merlonHere = (column) => (((column.x + column.z) % 2) + 2) % 2 === 0;

    /**
     * Ops of one column, bottom to top.
     * @param {Column} column
     * @returns {WallOp[]}
     */
    const columnOps = (column) => {
        /** @type {WallOp[]} */
        const ops = [];
        const { x, z } = column;
        const base = column.base ?? baseOf(column);
        for (let y = base; y <= column.top; y += 1) {
            if (column.tunnel !== undefined && y > column.tunnel && y <= column.tunnel + 2) {
                continue; // the 2-high tunnel through a tower along the walkway
            }
            if (y <= column.ground) {
                ops.push({ x, y, z, id: footingBlock(x, y, z), layer: "footing" });
            } else if (y < column.top) {
                ops.push({ x, y, z, id: bodyBlock(x, y, z), layer: column.kind === "tower" ? "tower" : column.kind === "buttress" ? "buttress" : "body" });
            } else if (column.kind === "wall" && !isEdge(column)) {
                ops.push({ x, y, z, id: ID.walkway, layer: "walkway" });
            } else {
                ops.push({ x, y, z, id: bodyBlock(x, y, z), layer: column.kind === "tower" ? "tower" : column.kind === "buttress" ? "buttress" : "body" });
            }
        }
        const crowned = (column.kind === "wall" && isEdge(column)) || (column.kind === "tower" && column.ring);
        if (crowned && merlonHere(column)) {
            for (let k = 1; k <= WALL.merlonHeight; k += 1) {
                ops.push({ x, y: column.top + k, z, id: bodyBlock(x, column.top + k, z), layer: "parapet" });
            }
        }
        return ops;
    };

    // Exact op count without materialising everything.
    let blockCount = 0;
    for (const column of ordered) {
        blockCount += columnOps(column).length;
    }

    let length = 0;
    for (let i = 1; i < n; i += 1) {
        length += Math.hypot(/** @type {[number, number]} */ (cells[i])[0] - /** @type {[number, number]} */ (cells[i - 1])[0], /** @type {[number, number]} */ (cells[i])[1] - /** @type {[number, number]} */ (cells[i - 1])[1]);
    }

    return {
        cells,
        ground,
        top,
        closed,
        towers,
        columns: ordered,
        columnOps,
        estimate: {
            columns: ordered.length,
            blocks: blockCount,
            towers: towers.length,
            buttresses: buttressCount,
            length: Math.round(length),
        },
    };
}

/**
 * Lazily yield bounded segments (<= maxOps ops each, whole columns only), in a stable order, so a runJob
 * generator can persist `segment.index` as its cursor. Re-running from any index is safe and idempotent
 * (ops only place; the Bedrock layer treats a cell that already holds the planned block as done).
 *
 * @param {ReturnType<typeof planWall>} plan
 * @param {number} [maxOps]
 * @param {number} [fromIndex]
 * @returns {Generator<WallSegment, void, undefined>}
 */
export function* wallOpSegments(plan, maxOps = WALL.defaultSegmentOps, fromIndex = 0) {
    const limit = Math.max(WALL.minSegmentOps, Math.floor(maxOps));
    /** @type {WallOp[]} */
    let batch = [];
    let columns = 0;
    let index = 0;
    for (const column of plan.columns) {
        const ops = plan.columnOps(column);
        if (batch.length + ops.length > limit && batch.length > 0) {
            if (index >= fromIndex) {
                yield { index, columns, ops: batch };
            }
            index += 1;
            batch = [];
            columns = 0;
        }
        batch.push(...ops);
        columns += 1;
    }
    if (batch.length > 0 && index >= fromIndex) {
        yield { index, columns, ops: batch };
    }
}

/**
 * Convenience: plan and materialise all segments.
 *
 * @param {number[][]} path
 * @param {GroundProfile} profile
 * @param {WallOptions} [options]
 */
export function wallOps(path, profile, options = {}) {
    const plan = planWall(path, profile, options);
    const segments = [...wallOpSegments(plan, options.maxOpsPerSegment)];
    return { segments, towers: plan.towers, estimate: { ...plan.estimate, segments: segments.length }, plan };
}
