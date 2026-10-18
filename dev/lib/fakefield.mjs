// Synthetic terrain for offline planning tests (dev only, never shipped in the pack).
//
// A "height field" is the planner's only view of the world. Contract (also used by the real
// scanner in the pack, which fills the same shape from getTopmostBlock reads):
//   field.at(x, z) -> { g: integer ground height (top natural ground block y),
//                       k: "land" | "water" | "lava" | "blocked" | "unloaded",
//                       tree: boolean (natural trees stand here, clearable) }
//   field.bounds  -> { x0, z0, x1, z1 } inclusive block bounds that `at` answers for
// Anything outside bounds is "unloaded".

/** @param {number} n @param {number} seed */
function hash2(x, z, seed) {
    let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** smooth value noise in [0,1) at wavelength `scale` blocks */
export function valueNoise(x, z, scale, seed) {
    const fx = x / scale;
    const fz = z / scale;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const a = hash2(ix, iz, seed);
    const b = hash2(ix + 1, iz, seed);
    const c = hash2(ix, iz + 1, seed);
    const d = hash2(ix + 1, iz + 1, seed);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * @param {number} seed
 * @param {{ x0?: number, z0?: number, size?: number, base?: number, relief?: number, hills?: number,
 *           river?: { z: number, width: number, wiggle: number } | null, lakes?: { x: number, z: number, r: number }[],
 *           forest?: number, cliffs?: { x: number, z0: number, z1: number, drop: number }[] }} [options]
 */
export function makeField(seed, options = {}) {
    const size = options.size ?? 900;
    const x0 = options.x0 ?? -size / 2;
    const z0 = options.z0 ?? -size / 2;
    const base = options.base ?? 70;
    const relief = options.relief ?? 10;
    const hills = options.hills ?? 80;
    const forest = options.forest ?? 0.25;
    const lakes = options.lakes ?? [];
    const cliffs = options.cliffs ?? [];
    const river = options.river ?? null;
    const bounds = { x0, z0, x1: x0 + size - 1, z1: z0 + size - 1 };
    /** @type {Map<string, { g: number, k: string, tree: boolean }>} */
    const cache = new Map();
    return {
        seed,
        bounds,
        at(x, z) {
            if (x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1) return { g: 0, k: "unloaded", tree: false };
            const key = `${x},${z}`;
            const hit = cache.get(key);
            if (hit) return hit;
            let g = base + Math.round((valueNoise(x, z, hills, seed) - 0.5) * 2 * relief + (valueNoise(x, z, hills / 4, seed + 1) - 0.5) * relief * 0.4);
            let k = "land";
            if (river) {
                const centre = river.z + Math.sin(x / 60) * river.wiggle;
                if (Math.abs(z - centre) <= river.width / 2) {
                    k = "water";
                    g = base - 3;
                }
            }
            for (const lake of lakes) if ((x - lake.x) ** 2 + (z - lake.z) ** 2 <= lake.r ** 2) { k = "water"; g = base - 4; }
            for (const cliff of cliffs) if (x >= cliff.x && z >= cliff.z0 && z <= cliff.z1) g += cliff.drop;
            const tree = k === "land" && valueNoise(x, z, 40, seed + 7) > 1 - forest && hash2(x, z, seed + 9) < 0.08;
            const value = { g, k, tree };
            cache.set(key, value);
            return value;
        },
    };
}
