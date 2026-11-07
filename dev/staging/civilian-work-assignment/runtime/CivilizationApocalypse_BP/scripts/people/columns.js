/**
 * The standing height of a plan column, as one dimension sees it. A civilization build record stores only X/Z
 * (the builder never records a height), so the Y has to come from the world rather than be invented.
 * `getTopmostBlock` is one read, and it throws for an unloaded chunk - which is the answer we want: no home
 * this hour, rather than a villager placed inside a hill or dropped into a void.
 *
 * It lives beside the population sync rather than inside it because three layers read it - the sync's own homes,
 * the streets driver's teardown census and the orders driver's levy census - and `dev/test/population-sync.test.mjs`
 * keeps the sync itself reachable through exactly one gated door. Two copies of this rule is how the readers were
 * allowed to disagree; a second door into the population layer is worse.
 *
 * @param {any} dimension
 * @returns {(x: number, z: number) => (number | undefined)}
 */
export function surfaceAtOf(dimension) {
    return (x, z) => {
        // A missing method is not an unloaded chunk. Swallowing that difference turns a caller that handed in
        // the wrong object, or a world model that forgot to forward it, into a silently empty street.
        if (typeof dimension?.getTopmostBlock !== "function") {
            throw new TypeError("this dimension has no getTopmostBlock, so no plan column can be measured");
        }
        try {
            const top = dimension.getTopmostBlock({ x, z });
            const y = top?.location?.y ?? top?.y;
            return Number.isFinite(y) ? /** @type {number} */ (y) + 1 : undefined;
        } catch (_error) {
            return undefined;
        }
    };
}

/** A block a person must never be asked to stand on: the canopy is not a street. */
const CANOPY = /leaves|log|wood|bamboo|vine|mangrove_roots|roots|shroomlight|wart_block|azalea|propagule/;

/** A block that is not ground either, and cannot be stood on by a villager or a golem. */
const NO_FOOTING = /^(?:minecraft:)?(?:water|flowing_water|lava|flowing_lava)$/;

/**
 * Blocks one canopy column may be walked down through. A jungle crown is 10-20 blocks of trunk and leaves,
 * and there is an air gap of a few blocks under it before the forest floor; the descent counts every one of
 * those blocks, so 16 (the old figure) could stop in mid-air and read the whole column as unstandable.
 */
const MAX_DESCENT = 24;

/**
 * Hard ceiling on block reads for one `standableNear` call. Without a canopy a column costs 3 reads; under
 * one it costs up to 27. The cap keeps a fully wooded district from turning one search into thousands of
 * reads: it is spent nearest-ring first, so the street around the plan point is always what gets read.
 */
const SEARCH_READS = 240;

/** Offsets tried around a plan point, nearest ring first: 0, then 8 compass directions at each radius. */
const SEARCH_RINGS = [0, 4, 8, 12, 16, 20, 24];

/**
 * Open ground near a plan point, for placing the people of a district.
 *
 * A civilization build record stores only X/Z, so the Y comes from the world - but "topmost block" over a
 * district centre is often a roof, a wall top or a tree crown, and a villager spawned there is invisible from
 * every street. This samples a small disc around the point and takes the LOWEST top surface it finds as street
 * level (buildings only ever add height above the ground they stand on), then returns the nearest sampled column
 * that is at that level, with two blocks of open air above it.
 *
 * A column whose topmost block is canopy is walked DOWN, through leaves, trunks and the air gap beneath them,
 * to the first solid block: the forest floor is the street of a district built in a jungle. A column whose
 * canopy has no floor inside `MAX_DESCENT`, or whose floor is water or lava, is left out rather than guessed
 * at. `surfaceAtOf` remains the last-resort fallback for callers that have nothing better; it still answers
 * the topmost block, because changing it would put people on tree tops and roofs.
 *
 * Bounded and read-only: at most `SEARCH_READS` block reads, started at the nearest ring. An unloaded chunk
 * answers `undefined`, which the caller reads as "no home this hour" - never as a place to invent.
 *
 * @param {any} dimension
 * @param {number} x
 * @param {number} z
 * @param {{ radius?: number }} [options]
 * @returns {{ x: number, y: number, z: number } | undefined}
 */
export function standableNear(dimension, x, z, options = {}) {
    if (typeof dimension?.getTopmostBlock !== "function") {
        throw new TypeError("this dimension has no getTopmostBlock, so no standing ground can be found");
    }
    const radius = Number.isFinite(options.radius) ? Math.max(4, Math.floor(/** @type {number} */ (options.radius))) : 24;
    /** @type {Array<{ x: number, y: number, z: number, distance: number }>} */
    const columns = [];
    /** Every topmost read and every block probe below counts against this, so one call has a fixed cost. */
    let reads = 0;
    search:
    for (const ring of SEARCH_RINGS) {
        if (ring > radius) {
            break;
        }
        const steps = ring === 0 ? 1 : 8;
        for (let step = 0; step < steps; step += 1) {
            if (reads >= SEARCH_READS) {
                break search;
            }
            const angle = (Math.PI * 2 * step) / steps;
            const cx = Math.round(x + Math.cos(angle) * ring);
            const cz = Math.round(z + Math.sin(angle) * ring);
            let top;
            try {
                top = dimension.getTopmostBlock({ x: cx, z: cz });
            } catch (_error) {
                continue;
            }
            reads += 1;
            const rawY = top?.location?.y ?? top?.y;
            if (!Number.isFinite(rawY)) {
                continue;
            }
            let y = Math.floor(/** @type {number} */ (rawY));
            let id = String(top?.typeId ?? "");
            // The canopy is not a street, but the floor under it is. Descend only when the top is canopy: a
            // roof or a wall top is solid and stays the surface it always was for the lowest-level rule.
            if (CANOPY.test(id)) {
                let lost = false;
                let descended = 0;
                while (CANOPY.test(id) || id === "minecraft:air") {
                    if (descended >= MAX_DESCENT || reads >= SEARCH_READS) {
                        lost = true;
                        break;
                    }
                    let below;
                    try {
                        below = dimension.getBlock({ x: cx, y: y - 1, z: cz });
                    } catch (_error) {
                        below = undefined;
                    }
                    reads += 1;
                    if (below === undefined || below === null) {
                        lost = true;
                        break;
                    }
                    id = String(below.typeId ?? "");
                    y -= 1;
                    descended += 1;
                }
                // No floor inside the budget is "we could not see the ground here", never a canopy height.
                if (lost || CANOPY.test(id) || id === "minecraft:air") {
                    continue;
                }
            }
            // Water and lava are not a home for a villager (the siege layer is where drowning is allowed).
            if (NO_FOOTING.test(id)) {
                continue;
            }
            // Headroom: a column whose two blocks above the surface are not open air is inside a solid mass.
            let open = true;
            for (const headroom of [y + 1, y + 2]) {
                if (reads >= SEARCH_READS) {
                    open = false;
                    break;
                }
                let cell;
                try {
                    cell = dimension.getBlock({ x: cx, y: headroom, z: cz });
                } catch (_error) {
                    cell = undefined;
                }
                reads += 1;
                if (cell === undefined || cell === null || String(cell.typeId ?? "minecraft:air") !== "minecraft:air") {
                    open = false;
                    break;
                }
            }
            if (!open) {
                continue;
            }
            columns.push({ x: cx, y: y + 1, z: cz, distance: Math.hypot(cx - x, cz - z) });
        }
    }
    if (columns.length === 0) {
        return undefined;
    }
    // Street level is the lowest open surface found; a building or a wall is always above the ground it stands on.
    const ground = Math.min(...columns.map((column) => column.y));
    const atLevel = columns.filter((column) => column.y <= ground + 1);
    const chosen = atLevel.reduce((best, column) => (column.distance < best.distance ? column : best));
    return { x: chosen.x, y: chosen.y, z: chosen.z };
}
