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
