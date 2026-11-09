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
 * @returns {"ready" | "foreign" | "unloaded"} */
export function removalReadiness(group, read) {
    for (const op of group) {
        const block = read(op);
        if (!block) return "unloaded";
        if (block.typeId !== "minecraft:air" && block.typeId !== op.id) return "foreign";
    }
    return "ready";
}
