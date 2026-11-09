import { siteOpsFor } from "./districtplan.js";

/** Only the generated outdoor posts and wall lights; interiors and buildings are preserved.
 * @param {any} record @returns {any[][]} */
export function outdoorLightGroups(record) {
    /** @type {any[][]} */
    const groups = [];
    for (const [index, element] of record.dressing.entries()) {
        if (element.kind !== "lamps") continue;
        const columns = /** @type {Map<string, any[]>} */ (new Map());
        for (const op of siteOpsFor(record, "dressing", index)) {
            const key = `${op.x},${op.z}`;
            if (!columns.has(key)) columns.set(key, []);
            /** @type {any[]} */ (columns.get(key)).push(op);
        }
        for (const column of columns.values()) groups.push(column.sort((a, b) => b.y - a.y));
    }
    for (const [index] of record.walls.entries()) {
        for (const op of siteOpsFor(record, "walls", index)) {
            if (op.id === "minecraft:lantern") groups.push([op]);
        }
    }
    return groups;
}

/** Check the whole known fixture before changing any of it. A changed player block preserves the fixture.
 * Air is accepted for a safely repeated removal after a crash.
 * @param {any[]} group @param {(op: any) => any} read
 * @param {((op:any)=>Record<string,boolean|number|string>)|undefined} [expectedStates]
 * @returns {"ready" | "foreign" | "unloaded"} */
export function removalReadiness(group, read, expectedStates=undefined) {
    for (const op of group) {
        const block = read(op);
        if (!block) return "unloaded";
        if (block.typeId !== "minecraft:air" && !lightingFixtureMatches(block,op,expectedStates?.(op))) return "foreign";
    }
    return "ready";
}

/** Expected planned states only in pure calls. Runtime supplies all native resolved
 * permutation states; missing/unreadable state proof never grants deletion.
 * @param {any} block @param {any} op @param {Record<string,boolean|number|string>} [states] */
export function lightingFixtureMatches(block,op,states=undefined){try{if(!block||block.isValid===false||block.typeId!==op.id)return false;const expected=states??{...(op.id==="minecraft:lantern"?{hanging:false}:{}),...(op.states??{})};return Object.entries(expected).every(([k,v])=>block.permutation?.getState(k)===v);}catch{return false;}}
