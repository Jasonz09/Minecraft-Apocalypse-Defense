// Canonical snapshot of one district's site record, shared by the golden generator and the golden test.
//
// A snapshot is a pure function of (plan, field, seed): the record's checksum and op count, the SHA-256 of
// the full op stream in stage order (exactly what the runtime would execute, element after element), and
// every element's own hash and total. The golden file pins Hearthgate (district 1) at a known-good commit,
// so any change to district 1 output - a different op, a different order, a different hash - fails the test.
import { createHash } from "node:crypto";

/** The fixture set the golden file pins: three seeds, rough and flat terrain. */
export const GOLDEN_CASES = Object.freeze([
    { name: "seed 21 rough", seed: 21, relief: 18 },
    { name: "seed 3 rough", seed: 3, relief: 18 },
    { name: "seed 7 rough", seed: 7, relief: 18 },
    { name: "seed 21 flat", seed: 21, relief: 2 },
    { name: "seed 3 flat", seed: 3, relief: 2 },
    { name: "seed 7 flat", seed: 7, relief: 2 },
]);

/** @param {string} text */
export function sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}

/**
 * Every op of a live record, in stage order then element order, exactly as siteOpsFor regenerates them.
 * @param {any} D districtplan module
 * @param {any} record
 */
export function opStream(D, record) {
    /** @type {any[]} */
    const ops = [];
    for (const stage of D.SITE_STAGES) {
        const list = record[stage] ?? [];
        for (let i = 0; i < list.length; i += 1) {
            for (const op of D.siteOpsFor(record, stage, i)) ops.push(op);
        }
    }
    return ops;
}

/**
 * @param {any} D districtplan module
 * @param {any} record a live site record
 */
export function snapshotOfRecord(D, record) {
    const ops = opStream(D, record);
    /** @type {{ stage: string, id: string, total: number, hash: string }[]} */
    const elements = [];
    for (const stage of D.SITE_STAGES) {
        const list = record[stage] ?? [];
        for (const element of list) {
            elements.push({ stage, id: String(element.id), total: Number(element.total), hash: String(element.hash) });
        }
    }
    return {
        checksum: String(record.checksum),
        siteOpCount: D.siteOpCount(record),
        opCount: ops.length,
        opsSha256: sha256(JSON.stringify(ops)),
        elements,
    };
}

/**
 * District 1 (Hearthgate) for one golden case, planned from the five-district master plan.
 * @param {{ M: any, D: any, makeField: (seed: number, options: object) => any }} lib
 * @param {{ name: string, seed: number, relief: number }} spec
 */
export function hearthgateCase(lib, spec) {
    const field = lib.makeField(spec.seed, { relief: spec.relief, hills: 60 });
    const planned = lib.M.planCivilizationDetailed(field, { seed: spec.seed });
    if (!planned.ok) throw new Error(`${spec.name}: master plan failed`);
    const site = lib.D.planDistrictSite(planned.plan, 1, field, { seed: spec.seed });
    if (!site.ok) throw new Error(`${spec.name}: district 1 failed: ${site.problems.slice(0, 3).join(" | ")}`);
    return { plan: planned.plan, field, site, snapshot: snapshotOfRecord(lib.D, site.record) };
}
