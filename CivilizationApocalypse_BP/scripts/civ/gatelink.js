/**
 * Link the PHYSICAL gates of a civilization site plan to the SIMULATION's gate records. PURE: no Minecraft import.
 *
 * The simulation owns exactly one logical gate record per ring pair (`gate-district-1-district-2` is owned by
 * district-1, `gate-district-5-district-1` by district-5, ...). The site plan may emit several physical gates for
 * one pair (Hearthgate has a `main` and a `reinforce` gate on the 1-5 wall) and gates that have no simulation
 * counterpart at all (outer `evac`/`field` gates, non-ring walls). The rules, in order:
 *
 *   1. Never invent and never remove a simulation gate. A plan gate is matched to an EXISTING record by the
 *      unordered district pair in `between`; records are not created, deleted or renamed.
 *   2. One PRIMARY physical gate per simulation record: purpose `main` first, then the lowest numeric id. The record
 *      carries its spec in `gate.physical.spec` (what the adapter already reads) and `gate.physical.link`.
 *   3. Every other physical gate of the same pair is a COMPANION: it is controlled TOGETHER with the primary. The
 *      simulation sees one route; the logical state only changes once EVERY unit of the record has really moved
 *      (the defensive meaning of "sealed" holds, and a half-closed pair never reads as closed). Companions live in
 *      `gate.physical.companions` with their own spec and their own `civ_gate_<planId>` adapter record.
 *   4. Gates with no counterpart (a `between` of 0, or a pair the simulation has no record for) are UNMANAGED by
 *      the simulation: they only change by explicit command (`civ:gate_close <planId>`), otherwise they stay open.
 *      They are listed in the gate registry (see `registryOf`), never in the kingdom.
 *   5. `gate.mode` is set to `auto` only when absent: a manual `forced_*` override survives a re-link.
 *   6. Linking is idempotent (a second call reports no changes), never touches `gate.state` and keeps an existing
 *      physical `state` / `target` / `blocked`. A built gate starts OPEN. The one exception: a record whose
 *      logical state is already `sealed` gets `target: 'closed'` so the blocks catch up with what the
 *      simulation already believes (state itself stays what it was).
 *
 * @typedef {{ at: { x: number, z: number }, axis: "x" | "z", y: number, dimension?: string }} LinkSpec
 * @typedef {"primary" | "companion" | "unmanaged"} LinkRole
 * @typedef {{ id: string, between: number[], purpose: string, role: LinkRole, simGateId: string | null, spec: LinkSpec }} GateLink
 * @typedef {{ kind: string, gateId: string, detail: string }} LinkChange
 */

import { AIR_IDS, cellsToToggle, normalizeSpec, toWorld } from "./gates.js";

export const LINK_VERSION = 1;
const PURPOSE_RANK = Object.freeze({ main: 0, field: 1, reinforce: 2, evac: 3 });
const MAX_REASON = 160;

/** Block ids a walker passes through (everything else, iron bars included, is solid for the proof). */
const PASSABLE_IDS = Object.freeze([
    ...AIR_IDS, "minecraft:lever", "minecraft:short_grass", "minecraft:tallgrass", "minecraft:fern", "minecraft:snow_layer",
    "minecraft:red_flower", "minecraft:yellow_flower", "minecraft:deadbush", "minecraft:torch", "minecraft:wall_sign", "minecraft:standing_sign",
]);

/** @param {string} id */
function naturalKey(id) {
    return id.replace(/\d+/g, (digits) => digits.padStart(8, "0"));
}

/** @param {string} a @param {string} b */
function compareIds(a, b) {
    const left = naturalKey(a);
    const right = naturalKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {unknown} value */
function purposeRank(value) {
    const rank = /** @type {Record<string, number>} */ (PURPOSE_RANK)[String(value)];
    return rank === undefined ? 9 : rank;
}

/**
 * @param {any} kingdom
 * @returns {{ gate: any, owner: any }[]}
 */
function simGates(kingdom) {
    /** @type {{ gate: any, owner: any }[]} */
    const list = [];
    for (const district of Array.isArray(kingdom?.districts) ? kingdom.districts : []) {
        for (const gate of Array.isArray(district?.gates) ? district.gates : []) {
            if (gate && typeof gate.id === "string") {
                list.push({ gate, owner: district });
            }
        }
    }
    return list.sort((a, b) => compareIds(String(a.gate.id), String(b.gate.id)));
}

/**
 * Normalise one plan / site-record gate into a LinkSpec, or say why not.
 *
 * @param {any} gate plan gate ({id, at, axis, between, purpose}) or site-record gate (+ walkingLevel)
 * @param {{ dimension?: string, walkingLevel?: (gate: any) => number | undefined }} options
 * @returns {{ link?: { id: string, between: number[], purpose: string, spec: LinkSpec }, problem?: string }}
 */
export function specOfPlanGate(gate, options = {}) {
    const id = typeof gate?.id === "string" ? gate.id : "";
    if (id.length === 0) {
        return { problem: "a gate without an id was ignored" };
    }
    const y = Number.isInteger(gate.walkingLevel) ? gate.walkingLevel : Number.isInteger(gate.y) ? gate.y : options.walkingLevel?.(gate);
    if (!Number.isInteger(y)) {
        return { problem: `gate ${id} has no walking level (walkingLevel), so no physical spec can be made` };
    }
    /** @type {LinkSpec} */
    const spec = { at: { x: Number(gate.at?.x), z: Number(gate.at?.z) }, axis: gate.axis, y: /** @type {number} */ (y) };
    if (typeof options.dimension === "string" && options.dimension.length > 0) {
        spec.dimension = options.dimension;
    }
    try {
        normalizeSpec({ id, ...spec, ...(gate.width === undefined ? {} : { width: Number(gate.width) }) });
    } catch (error) {
        return { problem: `gate ${id} is not a valid physical gate: ${String(error instanceof Error ? error.message : error)}` };
    }
    const between = Array.isArray(gate.between) ? gate.between.map(Number) : [];
    return { link: { id, between, purpose: String(gate.purpose ?? "main"), spec } };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Link physical gates to the simulation records. Mutates `kingdom` (only gate.mode and gate.physical) and
 * returns what it did; never throws on bad input, it warns.
 *
 * @param {any} kingdom
 * @param {any[]} sitePlanGates plan.gates or siteRecord.gates (gates of ONE district are fine; gates of all five too)
 * @param {{ dimension?: string, walkingLevel?: (gate: any) => number | undefined }} [options]
 * @returns {{ changes: LinkChange[], warnings: string[], links: GateLink[] }}
 */
export function linkPhysicalGates(kingdom, sitePlanGates, options = {}) {
    /** @type {LinkChange[]} */
    const changes = [];
    /** @type {string[]} */
    const warnings = [];
    /** @type {GateLink[]} */
    const links = [];
    if (!Array.isArray(sitePlanGates)) {
        return { changes, warnings: ["no gate list was given"], links };
    }
    const sim = simGates(kingdom);

    /** @type {Map<string, { id: string, between: number[], purpose: string, spec: LinkSpec }>} */
    const accepted = new Map();
    for (const raw of sitePlanGates) {
        const result = specOfPlanGate(raw, options);
        if (result.link === undefined) {
            warnings.push(String(result.problem));
        } else if (accepted.has(result.link.id)) {
            warnings.push(`gate id ${result.link.id} appears twice in the plan; the first one is used`);
        } else {
            accepted.set(result.link.id, result.link);
        }
    }

    /** @type {Map<string, { id: string, between: number[], purpose: string, spec: LinkSpec }[]>} sim gate id -> candidates */
    const byRecord = new Map();
    /** @type {{ id: string, between: number[], purpose: string, spec: LinkSpec }[]} */
    const loose = [];
    for (const candidate of [...accepted.values()].sort((a, b) => compareIds(a.id, b.id))) {
        const pair = candidate.between;
        if (pair.length !== 2 || pair.some((n) => !Number.isInteger(n) || n <= 0) || pair[0] === pair[1]) {
            loose.push(candidate);
            continue;
        }
        const wanted = new Set([`district-${String(pair[0])}`, `district-${String(pair[1])}`]);
        const records = sim.filter(({ gate, owner }) => {
            const ends = new Set([String(owner.id), String(gate.with)]);
            return ends.size === 2 && [...wanted].every((id) => ends.has(id));
        });
        if (records.length === 0) {
            loose.push(candidate);
            warnings.push(`${candidate.id} joins districts ${String(pair[0])} and ${String(pair[1])}, which have no simulation gate; it stays unmanaged (open unless a command forces it)`);
            continue;
        }
        const record = /** @type {{ gate: any, owner: any }} */ (records[0]);
        for (const extra of records.slice(1)) {
            warnings.push(`simulation gate ${String(extra.gate.id)} duplicates the pair of ${String(record.gate.id)}; it is left logical-only`);
        }
        const key = String(record.gate.id);
        byRecord.set(key, [...(byRecord.get(key) ?? []), candidate]);
    }

    for (const [recordId, candidates] of byRecord) {
        const found = sim.find((entry) => entry.gate.id === recordId);
        if (found === undefined) {
            continue;
        }
        const ordered = [...candidates].sort((a, b) => purposeRank(a.purpose) - purposeRank(b.purpose) || compareIds(a.id, b.id));
        const primary = /** @type {{ id: string, between: number[], purpose: string, spec: LinkSpec }} */ (ordered[0]);
        const companions = ordered.slice(1);
        const gate = found.gate;

        links.push({ id: primary.id, between: primary.between, purpose: primary.purpose, role: "primary", simGateId: recordId, spec: primary.spec });
        for (const companion of companions) {
            links.push({ id: companion.id, between: companion.between, purpose: companion.purpose, role: "companion", simGateId: recordId, spec: companion.spec });
        }

        if (gate.mode === undefined) {
            gate.mode = "auto";
            changes.push({ kind: "mode", gateId: recordId, detail: "mode set to auto" });
        }
        const wantedLink = { planId: primary.id, purpose: primary.purpose };
        const wantedCompanions = companions.map((entry) => ({ id: entry.id, purpose: entry.purpose, spec: entry.spec }));
        const existing = gate.physical !== null && typeof gate.physical === "object" ? gate.physical : undefined;
        if (existing === undefined) {
            /** @type {any} */
            const record = { state: "open", spec: primary.spec, link: wantedLink };
            if (wantedCompanions.length > 0) {
                record.companions = wantedCompanions;
            }
            if (gate.state === "sealed") {
                record.target = "closed";
            }
            gate.physical = record;
            changes.push({
                kind: "linked",
                gateId: recordId,
                detail: `${primary.id} (${primary.purpose})${companions.length > 0 ? ` + ${companions.map((entry) => entry.id).join(", ")} together` : ""}`,
            });
            continue;
        }
        let updated = false;
        if (!same(existing.spec, primary.spec)) {
            existing.spec = primary.spec;
            updated = true;
        }
        if (!same(existing.link, wantedLink)) {
            existing.link = wantedLink;
            updated = true;
        }
        if (wantedCompanions.length === 0) {
            if (existing.companions !== undefined) {
                delete existing.companions;
                updated = true;
            }
        } else if (!same(existing.companions, wantedCompanions)) {
            existing.companions = wantedCompanions;
            updated = true;
        }
        if (existing.state !== "open" && existing.state !== "closed") {
            existing.state = "open";
            updated = true;
        }
        if (updated) {
            changes.push({ kind: "relinked", gateId: recordId, detail: `${primary.id}${companions.length > 0 ? ` + ${companions.map((entry) => entry.id).join(", ")}` : ""}` });
        }
    }

    for (const candidate of loose) {
        links.push({ id: candidate.id, between: candidate.between, purpose: candidate.purpose, role: "unmanaged", simGateId: null, spec: candidate.spec });
    }
    links.sort((a, b) => compareIds(a.id, b.id));
    return { changes, warnings, links };
}

/**
 * The adapter units of a simulation gate record: the primary (keyed by the record id, as before) and its
 * companions (keyed by their plan id). Empty when the record is not physical.
 *
 * @param {any} gate
 * @returns {{ id: string, planId: string | null, purpose: string, spec: any, primary: boolean }[]}
 */
export function unitsOfGate(gate) {
    const physical = gate?.physical;
    if (physical === null || typeof physical !== "object") {
        return [];
    }
    /** @type {{ id: string, planId: string | null, purpose: string, spec: any, primary: boolean }[]} */
    const units = [{ id: String(gate.id), planId: typeof physical.link?.planId === "string" ? physical.link.planId : null, purpose: String(physical.link?.purpose ?? "main"), spec: physical.spec, primary: true }];
    for (const companion of Array.isArray(physical.companions) ? physical.companions : []) {
        if (companion && typeof companion.id === "string") {
            units.push({ id: companion.id, planId: companion.id, purpose: String(companion.purpose ?? "reinforce"), spec: companion.spec, primary: false });
        }
    }
    return units;
}

/**
 * Registry stored beside the kingdom (world property `civ_gatereg`): every linked physical gate, so commands can
 * address companions and unmanaged gates by plan id. Modes of unmanaged gates live here.
 *
 * @typedef {{ v: number, gates: (GateLink & { mode?: string })[] }} GateRegistry
 */

/**
 * Merge freshly computed links into an existing registry (keeps the `mode` of unmanaged gates, never drops an
 * entry that is not in `links`).
 *
 * @param {GateRegistry | undefined} previous
 * @param {GateLink[]} links
 * @returns {GateRegistry}
 */
export function mergeRegistry(previous, links) {
    /** @type {Map<string, GateLink & { mode?: string }>} */
    const merged = new Map();
    for (const entry of previous?.gates ?? []) {
        merged.set(entry.id, entry);
    }
    for (const link of links) {
        const old = merged.get(link.id);
        /** @type {GateLink & { mode?: string }} */
        const next = { ...link };
        if (link.role === "unmanaged" && old?.mode !== undefined) {
            next.mode = old.mode;
        }
        merged.set(link.id, next);
    }
    return { v: LINK_VERSION, gates: [...merged.values()].sort((a, b) => compareIds(a.id, b.id)) };
}

/**
 * What an UNMANAGED gate should be: open unless a command forced it closed.
 * @param {{ mode?: string }} entry
 * @returns {"open" | "closed"}
 */
export function unmanagedWanted(entry) {
    return entry.mode === "forced_closed" ? "closed" : "open";
}

/**
 * Problems in the link data of a kingdom (the fields gatecontrol's validator does not know).
 *
 * @param {any} kingdom
 * @returns {string[]}
 */
export function validateGateLinks(kingdom) {
    /** @type {string[]} */
    const problems = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const { gate, owner } of simGates(kingdom)) {
        const physical = gate.physical;
        if (physical === null || typeof physical !== "object") {
            continue;
        }
        const label = `${String(owner.id)}.gate ${String(gate.id)}`;
        for (const unit of unitsOfGate(gate)) {
            if (seen.has(unit.id)) {
                problems.push(`${label}: physical unit id ${unit.id} is used twice`);
            }
            seen.add(unit.id);
            if (unit.spec === undefined) {
                continue; // a physical record without a location is allowed; the adapter reports it
            }
            try {
                normalizeSpec({ id: unit.id, ...unit.spec });
            } catch (error) {
                problems.push(`${label}: unit ${unit.id} has a bad spec (${String(error instanceof Error ? error.message : error)})`);
            }
        }
        if (physical.companions !== undefined && !Array.isArray(physical.companions)) {
            problems.push(`${label}.physical.companions must be a list`);
        }
        if (physical.link !== undefined && (physical.link === null || typeof physical.link !== "object" || typeof physical.link.planId !== "string")) {
            problems.push(`${label}.physical.link needs a planId`);
        }
    }
    return problems;
}

/* ------------------------------------------------------------------ *
 * Read-only verification of what is REALLY in the world around a gate
 * ------------------------------------------------------------------ */

/**
 * State of the portcullis lattice (bars + seal cells; levers ignored) from the block ids actually found.
 *
 * @param {any} spec
 * @param {(x: number, y: number, z: number) => string | undefined} typeAt undefined = chunk not loaded
 * @returns {{ state: "open" | "closed" | "partial" | "foreign" | "unloaded", cells: number, bars: number, air: number, foreign: number, unloaded: number, firstForeign: string }}
 */
export function latticeState(spec, typeAt) {
    const cells = cellsToToggle(spec).filter((cell) => cell.role !== "lever");
    let bars = 0;
    let air = 0;
    let foreign = 0;
    let unloaded = 0;
    let firstForeign = "";
    for (const cell of cells) {
        const id = typeAt(cell.x, cell.y, cell.z);
        if (id === undefined) {
            unloaded += 1;
        } else if (id === "minecraft:iron_bars") {
            bars += 1;
        } else if (AIR_IDS.includes(id)) {
            air += 1;
        } else {
            foreign += 1;
            if (firstForeign === "") {
                firstForeign = `${id.replace("minecraft:", "")} at ${String(cell.x)} ${String(cell.y)} ${String(cell.z)}`;
            }
        }
    }
    /** @type {"open" | "closed" | "partial" | "foreign" | "unloaded"} */
    let state = "partial";
    if (unloaded > 0) {
        state = "unloaded";
    } else if (foreign > 0) {
        state = "foreign";
    } else if (bars === cells.length) {
        state = "closed";
    } else if (air === cells.length) {
        state = "open";
    }
    return { state, cells: cells.length, bars, air, foreign, unloaded, firstForeign };
}

/** Dimensions of the walker proof. */
const PROOF = Object.freeze({ reachBeyondTower: 4, across: 6 });

/**
 * Every cell the crossing proof must READ from the world: the gatehouse columns (|u| <= hw + 3) and the strip of
 * ground in front of and behind them, from the walking level up to the proof ceiling. Below the walking level the
 * proof assumes ground (as civ/gates.js canMobCross does); beyond the towers it assumes the plain wall continues.
 *
 * @param {any} spec
 * @returns {{ x: number, y: number, z: number }[]}
 */
export function proofCells(spec) {
    const s = normalizeSpec(spec);
    const ceiling = s.towerTop + 3 + 3;
    /** @type {{ x: number, y: number, z: number }[]} */
    const cells = [];
    for (let u = -(s.hw + 3); u <= s.hw + 3; u += 1) {
        for (let v = -PROOF.across; v <= PROOF.across; v += 1) {
            for (let h = 0; h < ceiling; h += 1) {
                cells.push(toWorld(s, u, v, h));
            }
        }
    }
    return cells;
}

/**
 * Can a ground walker of `height` blocks get across the wall through this gate, judged on the REAL block ids?
 * Breadth-first over standing positions with a one block step-up, drops of up to three and (by default) diagonal
 * squeezing past solid corners - the harshest movement model, same as civ/gates.js canMobCross.
 *
 * @param {any} spec
 * @param {Map<string, string | undefined>} ids block id per "x,y,z" for every cell of proofCells(spec); undefined = unloaded
 * @param {{ height?: number, squeeze?: boolean }} [options]
 * @returns {{ crosses: boolean, unloaded: number, visited: number }}
 */
export function crossingFromWorld(spec, ids, options = {}) {
    const s = normalizeSpec(spec);
    const mobHeight = options.height === undefined ? 2 : options.height;
    const squeeze = options.squeeze !== false;
    const U = s.hw + 3 + PROOF.reachBeyondTower;
    const V = PROOF.across;
    const HH = s.towerTop + mobHeight + 3;
    let unloaded = 0;
    /** @type {Map<string, boolean>} */
    const memo = new Map();

    /** @param {number} u @param {number} v @param {number} h */
    const isSolid = (u, v, h) => {
        if (h < 0) {
            return true;
        }
        if (Math.abs(u) > s.hw + 3) {
            return Math.abs(v) <= 1 && h < s.wallTop; // the plain wall continues
        }
        const label = `${String(u)},${String(v)},${String(h)}`;
        const cached = memo.get(label);
        if (cached !== undefined) {
            return cached;
        }
        const w = toWorld(s, u, v, h);
        const id = ids.get(`${String(w.x)},${String(w.y)},${String(w.z)}`);
        let solid;
        if (id === undefined) {
            unloaded += 1;
            solid = true; // an unread cell is never assumed passable... and the caller reports it
        } else {
            solid = !PASSABLE_IDS.includes(id);
        }
        memo.set(label, solid);
        return solid;
    };
    /** @param {number} u @param {number} v @param {number} lo @param {number} hi */
    const bodyFree = (u, v, lo, hi) => {
        for (let h = lo; h <= hi; h += 1) {
            if (h >= HH || isSolid(u, v, h)) {
                return false;
            }
        }
        return true;
    };
    const inside = (/** @type {number} */ u, /** @type {number} */ v) => u >= -U && u <= U && v >= -V && v <= V;
    const idx = (/** @type {number} */ u, /** @type {number} */ v, /** @type {number} */ h) => ((u + U) * (2 * V + 1) + (v + V)) * HH + h;
    const seen = new Uint8Array((2 * U + 1) * (2 * V + 1) * HH);
    /** @type {[number, number, number][]} */
    const queue = [];
    for (let u = -U; u <= U; u += 1) {
        for (let h = 0; h < HH - mobHeight; h += 1) {
            if (bodyFree(u, -V, h, h + mobHeight - 1) && isSolid(u, -V, h - 1)) {
                seen[idx(u, -V, h)] = 1;
                queue.push([u, -V, h]);
            }
        }
    }
    let visited = 0;
    for (let head = 0; head < queue.length; head += 1) {
        const [u, v, h] = /** @type {[number, number, number]} */ (queue[head]);
        visited += 1;
        if (v === V) {
            return { crosses: true, unloaded, visited };
        }
        for (let du = -1; du <= 1; du += 1) {
            for (let dv = -1; dv <= 1; dv += 1) {
                if (du === 0 && dv === 0) {
                    continue;
                }
                const nu = u + du;
                const nv = v + dv;
                if (!inside(nu, nv)) {
                    continue;
                }
                for (const dh of [0, 1, -1, -2, -3]) {
                    const nh = h + dh;
                    if (nh < 0 || nh >= HH - mobHeight) {
                        continue;
                    }
                    if (!bodyFree(nu, nv, nh, nh + mobHeight - 1) || !isSolid(nu, nv, nh - 1)) {
                        continue;
                    }
                    if (dh > 0 && !bodyFree(u, v, h + mobHeight, h + mobHeight + dh - 1)) {
                        continue;
                    }
                    if (dh < 0 && !bodyFree(nu, nv, nh, h + mobHeight - 1)) {
                        continue;
                    }
                    if (du !== 0 && dv !== 0 && !squeeze) {
                        const lo = Math.min(h, nh);
                        const hi = Math.max(h, nh) + mobHeight - 1;
                        if (!bodyFree(nu, v, lo, hi) || !bodyFree(u, nv, lo, hi)) {
                            continue;
                        }
                    }
                    const slot = idx(nu, nv, nh);
                    if (seen[slot] === 0) {
                        seen[slot] = 1;
                        queue.push([nu, nv, nh]);
                    }
                }
            }
        }
    }
    return { crosses: false, unloaded, visited };
}

/**
 * @param {string} text
 */
export function clipReason(text) {
    return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 3)}...` : text;
}
