import { isTreePart } from "../structures/terrain.js";

/** A compact, exact list of cells proven natural before a resumable clearance starts.
 * @typedef {{ seed: number[], palette: string[], runs: string[], element: number, cursor: number, reach?: number }} TreeClearance
 */
const HEIGHT = 81;

/** @param {{x:number,y:number,z:number}} seed @param {{x:number,y:number,z:number,id:string}[]} cells @param {number} element @param {number} cursor @param {number} [reach] @returns {TreeClearance} */
export function encodeTreeClearance(seed, cells, element, cursor, reach = 8) {
    if (reach !== 8 && reach !== 16) throw new Error("Unsupported tree proof reach");
    const side = reach * 2 + 1;
    const palette = [...new Set(cells.map((c) => c.id))].sort();
    const runs = palette.map((id) => {
        const indices = cells.filter((c) => c.id === id).map((c) => ((c.x - seed.x + reach) * HEIGHT + c.y - seed.y + 40) * side + c.z - seed.z + reach).sort((a,b) => a-b);
        const out = [];
        for (let i = 0; i < indices.length;) {
            let j = i + 1;
            while (j < indices.length && indices[j] === indices[j-1] + 1) j++;
            out.push(`${indices[i].toString(36)}.${(j-i).toString(36)}`);
            i = j;
        }
        return out.join(",");
    });
    return { seed: [seed.x,seed.y,seed.z], palette, runs, element, cursor, ...(reach === 8 ? {} : {reach}) };
}

/** Validate before allocating or trusting a stored clearance, including duplicate cells.
 * @param {any} value @returns {{x:number,y:number,z:number,id:string}[] | undefined}
 */
export function decodeTreeClearance(value) {
    if (!value || !Array.isArray(value.seed) || value.seed.length !== 3 || !value.seed.every(Number.isInteger)
        || Math.abs(value.seed[0]) > 30000000 || Math.abs(value.seed[2]) > 30000000 || value.seed[1] < -64 || value.seed[1] > 319
        || !Number.isInteger(value.element) || value.element < 0 || !Number.isInteger(value.cursor) || value.cursor < 0
        || (value.reach !== undefined && value.reach !== 8 && value.reach !== 16)
        || !Array.isArray(value.palette) || value.palette.length < 1 || value.palette.length > 32
        || value.palette.some((/** @type {any} */ id) => typeof id !== "string" || !id.startsWith("minecraft:") || !isTreePart(id))
        || new Set(value.palette).size !== value.palette.length || !Array.isArray(value.runs) || value.runs.length !== value.palette.length) return undefined;
    const reach = value.reach ?? 8, side = reach * 2 + 1, size = side * side * HEIGHT;
    const seen = new Set();
    const cells = [];
    for (let p = 0; p < value.runs.length; p++) {
        const text = value.runs[p];
        if (typeof text !== "string" || text.length > 24000 || !/^[0-9a-z]+\.[0-9a-z]+(?:,[0-9a-z]+\.[0-9a-z]+)*$/.test(text)) return undefined;
        for (const run of text.split(",")) {
            const [a,b] = run.split(".").map((/** @type {string} */ n) => parseInt(n,36));
            if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 1 || a+b > size || cells.length+b > 4000) return undefined;
            for (let i = a; i < a+b; i++) {
                if (seen.has(i)) return undefined;
                seen.add(i);
                const z = i % side, column = Math.floor(i / side), y = column % HEIGHT, x = Math.floor(column / HEIGHT);
                cells.push({ x:value.seed[0]+x-reach, y:value.seed[1]+y-40, z:value.seed[2]+z-reach, id:value.palette[p] });
            }
        }
    }
    return cells.length ? cells : undefined;
}
