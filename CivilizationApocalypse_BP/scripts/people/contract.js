import { DISTRICT_DEFAULTS } from "../config.js";

/**
 * People contract: the persistent record of every civilian and soldier.
 *
 * Pure JS. No `@minecraft` import, no world access, no randomness. The records are the
 * authority; a physical entity is only a view of one record, and it carries that record's id
 * in its tags. Everything that changes headcount is an explicit transition below, so the
 * totals can always be derived from the records and checked against the district counts.
 *
 * Record shape (every field is present on every record):
 *   id         "civ-<district>-<kind>-<nnn>"  e.g. "civ-district-1-civilian-007". Never reused, never changes.
 *   kind       "civilian" | "soldier"         fixed at creation (the id encodes it).
 *   district   "district-<k>"                 home district; the roster group the record belongs to.
 *   role       civilian: resident|farmer|builder|hauler
 *              soldier:  guard|reserve
 *   home       "<district>/<slot>"            where the person sleeps (a symbolic layout slot).
 *   workplace  "<district>/<slot>" | null     where the person works, stands guard or trains.
 *   state      civilian: home|work|training|sheltering|graduated|dead
 *              soldier:  wall|barracks|dead
 *   revision   integer >= 0                   bumped on every change to the record.
 *   successor  soldier id | null              set on a civilian in state "graduated" (training finished).
 *
 * Records are never deleted. A death is a tombstone (state "dead"); a graduated civilian keeps its
 * record and points at the soldier record it became. Those rules are what let a crash, a restart or
 * an unloaded chunk never change the number of people.
 */

export const RECORD_KINDS = Object.freeze(["civilian", "soldier"]);
export const CIVILIAN_ROLES = Object.freeze(["resident", "farmer", "builder", "hauler"]);
export const SOLDIER_ROLES = Object.freeze(["guard", "reserve"]);
export const CIVILIAN_STATES = Object.freeze(["home", "work", "training", "sheltering", "graduated", "dead"]);
export const SOLDIER_STATES = Object.freeze(["wall", "barracks", "dead"]);

/** Civilians who exist and may stand in the world. A "training" civilian is still a civilian record. */
const LIVE_STATES = Object.freeze({
    civilian: Object.freeze(["home", "work", "training", "sheltering"]),
    soldier: Object.freeze(["wall", "barracks"]),
});

/** Symbolic layout slots per district. Each name is "<prefix>-NN" with NN in 1..count, plus "barracks" and "yard". */
export const SLOT_COUNTS = Object.freeze({ home: 6, farm: 4, store: 3, wall: 8 });

/** Entity tags. Every physical entity carries MANAGED_TAG, one ID_TAG and one REV_TAG. */
export const MANAGED_TAG = "civ:people";
export const ID_TAG_PREFIX = "civ:id:";
export const REV_TAG_PREFIX = "civ:rev:";

const DISTRICT_RE = /^district-([1-9][0-9]*)$/;
const ID_RE = /^civ-(district-[1-9][0-9]*)-(civilian|soldier)-([0-9]{3,})$/;
const FIELDS = Object.freeze(["id", "kind", "district", "role", "home", "workplace", "state", "revision", "successor"]);

/** @typedef {{ id: string, kind: string, district: string, role: string, home: string, workplace: string | null, state: string, revision: number, successor: string | null }} PersonRecord */

/**
 * @param {number} value
 * @param {number} width
 */
function pad(value, width) {
    return String(value).padStart(width, "0");
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function nonNegInt(value, label) {
    if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
        throw new Error(`${label} must be a non-negative whole number, got ${String(value)}`);
    }
    return /** @type {number} */ (value);
}

/**
 * Sequence number of a record id. Ids are validated when they enter the roster, so the trailing digits are enough.
 * @param {string} id
 * @returns {number}
 */
export function seqOf(id) {
    return Number(id.slice(id.lastIndexOf("-") + 1));
}

/**
 * @param {string} district
 * @returns {number}
 */
export function districtNumber(district) {
    const match = DISTRICT_RE.exec(String(district));
    return match === null ? Number.NaN : Number(match[1]);
}

/**
 * @param {string} name
 * @returns {boolean} true for a symbolic slot name the layout knows
 */
export function validSlotName(name) {
    if (name === "barracks" || name === "yard") return true;
    const match = /^(home|farm|store|wall)-(\d{2})$/.exec(String(name));
    if (match === null) return false;
    const index = Number(match[2]);
    return index >= 1 && index <= SLOT_COUNTS[/** @type {keyof typeof SLOT_COUNTS} */ (match[1])];
}

/**
 * @param {string} district
 * @param {string} kind
 * @param {number} n one-based sequence number within (district, kind)
 * @returns {string}
 */
export function makeRecordId(district, kind, n) {
    if (!DISTRICT_RE.test(district)) throw new Error(`makeRecordId: bad district ${String(district)}`);
    if (kind !== "civilian" && kind !== "soldier") throw new Error(`makeRecordId: bad kind ${String(kind)}`);
    if (!Number.isInteger(n) || n < 1) throw new Error(`makeRecordId: sequence must be a positive whole number, got ${String(n)}`);
    return `civ-${district}-${kind}-${pad(n, 3)}`;
}

/**
 * @param {unknown} id
 * @returns {{ district: string, kind: "civilian" | "soldier", n: number } | null} null unless the id is canonical
 */
export function parseRecordId(id) {
    if (typeof id !== "string") return null;
    const match = ID_RE.exec(id);
    if (match === null) return null;
    const n = Number(match[3]);
    if (!Number.isInteger(n) || n < 1 || pad(n, 3) !== match[3]) return null;
    return { district: match[1], kind: /** @type {"civilian" | "soldier"} */ (match[2]), n };
}

/**
 * Tags a physical entity for this record must carry. The revision tag is what lets reconcile
 * notice a record changed while its entity was not looking.
 * @param {PersonRecord} record
 * @returns {string[]}
 */
export function expectedTags(record) {
    return [MANAGED_TAG, ID_TAG_PREFIX + record.id, REV_TAG_PREFIX + String(record.revision)];
}

/**
 * @param {string} tag
 * @returns {boolean} true for the tags this contract owns
 */
export function isManagedTag(tag) {
    return tag === MANAGED_TAG || tag.startsWith(ID_TAG_PREFIX) || tag.startsWith(REV_TAG_PREFIX);
}

/**
 * True when the record's person exists and may be physical.
 * @param {PersonRecord} record
 */
export function isLiveRecord(record) {
    const states = LIVE_STATES[/** @type {"civilian" | "soldier"} */ (record.kind)];
    return states !== undefined && states.includes(record.state);
}

/**
 * The symbolic slot a record's physical entity should stand at, from its state. Null when the
 * record is not live. Trainees stand at the barracks (enlistment moves their workplace there).
 * @param {PersonRecord} record
 * @returns {string | null}
 */
export function anchorSlotFor(record) {
    if (!isLiveRecord(record)) return null;
    switch (record.state) {
        case "work":
        case "wall":
        case "barracks":
        case "training":
            return record.workplace ?? record.home;
        default:
            return record.home;
    }
}

/**
 * @param {PersonRecord} record
 * @returns {string[]} problems; empty when the record is valid
 */
export function validateRecord(record) {
    /** @type {string[]} */
    const problems = [];
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        return ["record is not an object"];
    }
    for (const key of Object.keys(record)) {
        if (!FIELDS.includes(key)) problems.push(`unknown field ${key}`);
    }
    const parsed = parseRecordId(record.id);
    if (parsed === null) {
        problems.push(`id ${JSON.stringify(record.id)} is not civ-<district>-<kind>-<nnn>`);
    } else {
        if (parsed.district !== record.district) problems.push(`id ${record.id} disagrees with district ${String(record.district)}`);
        if (parsed.kind !== record.kind) problems.push(`id ${record.id} disagrees with kind ${String(record.kind)}`);
    }
    if (!RECORD_KINDS.includes(record.kind)) problems.push(`kind ${String(record.kind)} is not civilian or soldier`);
    if (typeof record.district !== "string" || !DISTRICT_RE.test(record.district)) {
        problems.push(`district ${String(record.district)} is not district-<k>`);
    }
    const roles = record.kind === "soldier" ? SOLDIER_ROLES : CIVILIAN_ROLES;
    const states = record.kind === "soldier" ? SOLDIER_STATES : CIVILIAN_STATES;
    if (!roles.includes(record.role)) problems.push(`role ${String(record.role)} is not valid for ${String(record.kind)}`);
    if (!states.includes(record.state)) problems.push(`state ${String(record.state)} is not valid for ${String(record.kind)}`);
    for (const field of /** @type {const} */ (["home"])) {
        const slot = record[field];
        if (typeof slot !== "string" || !slot.startsWith(`${String(record.district)}/`) || !validSlotName(slot.slice(String(record.district).length + 1))) {
            problems.push(`${field} ${String(slot)} is not a slot of ${String(record.district)}`);
        }
    }
    if (record.workplace !== null) {
        const slot = record.workplace;
        if (typeof slot !== "string" || !slot.startsWith(`${String(record.district)}/`) || !validSlotName(slot.slice(String(record.district).length + 1))) {
            problems.push(`workplace ${String(slot)} is not a slot of ${String(record.district)}`);
        }
    }
    if (!Number.isInteger(record.revision) || record.revision < 0) problems.push(`revision ${String(record.revision)} is not a count`);
    if (record.state === "graduated") {
        const successor = parseRecordId(record.successor);
        if (record.kind !== "civilian") problems.push("only a civilian can graduate");
        if (successor === null || successor.kind !== "soldier" || successor.district !== record.district) {
            problems.push(`graduated record needs a soldier successor in ${String(record.district)}`);
        }
    } else if (record.successor !== null) {
        problems.push(`successor is only valid in state graduated (state ${String(record.state)})`);
    }
    return problems;
}

/**
 * Sort by district number, then civilians before soldiers, then sequence number. A stable order is
 * what makes encoding, reconciliation and the tests deterministic.
 * @param {PersonRecord[]} records
 * @returns {PersonRecord[]} a new array
 */
export function sortRecords(records) {
    const keyed = records.map((record) => ({ record, district: districtNumber(record.district), kind: record.kind === "civilian" ? 0 : 1, n: seqOf(record.id) }));
    keyed.sort((left, right) => left.district - right.district || left.kind - right.kind || left.n - right.n);
    return keyed.map((entry) => entry.record);
}

/**
 * Whole-roster check: every record valid, ids unique, sequences contiguous from 1 per (district, kind)
 * (nothing was ever deleted or reused), and every graduate's successor is a real soldier of the same district.
 * @param {PersonRecord[]} records
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateRoster(records) {
    /** @type {string[]} */
    const problems = [];
    if (!Array.isArray(records)) return { ok: false, problems: ["roster is not an array"] };
    const ids = new Set();
    /** @type {Map<string, number>} */
    const counts = new Map();
    /** @type {Map<string, string>} */
    const successors = new Map();
    for (const record of records) {
        const recordProblems = validateRecord(record);
        for (const problem of recordProblems) problems.push(`${String(record?.id)}: ${problem}`);
        if (recordProblems.length > 0) continue;
        if (ids.has(record.id)) problems.push(`duplicate id ${record.id}`);
        ids.add(record.id);
        const parsed = parseRecordId(record.id);
        if (parsed === null) continue;
        const key = `${parsed.district}|${parsed.kind}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (record.successor !== null) {
            if (successors.has(record.successor)) problems.push(`soldier ${String(record.successor)} is the successor of two civilians`);
            successors.set(record.successor, record.id);
        }
    }
    for (const [key, count] of counts) {
        const [district, kind] = key.split("|");
        const seen = records.filter((record) => record.district === district && record.kind === kind).map((record) => parseRecordId(record.id)?.n ?? 0);
        const top = Math.max(...seen);
        if (top !== count) problems.push(`${district} ${kind} sequence has gaps (${String(count)} records, highest ${String(top)})`);
    }
    for (const [soldier] of successors) {
        if (!ids.has(soldier)) problems.push(`successor ${soldier} has no soldier record`);
    }
    return { ok: problems.length === 0, problems };
}

/**
 * The starting roster: one civilian record per civilian, one soldier record per soldier, placed on
 * the district's symbolic slots. Civilians cycle through the four roles; the first `front` soldiers
 * of a district are guards on the wall, the rest are reserves at the barracks.
 *
 * @param {{ id: string, civilians: number, soldiers: number, garrison?: { front?: number } }[]} districts
 * @returns {PersonRecord[]}
 */
export function createRoster(districts) {
    if (!Array.isArray(districts) || districts.length === 0) throw new Error("createRoster: at least one district is required");
    /** @type {PersonRecord[]} */
    const out = [];
    const ordered = districts.slice().sort((left, right) => districtNumber(left.id) - districtNumber(right.id));
    for (const district of ordered) {
        if (!DISTRICT_RE.test(district.id)) throw new Error(`createRoster: bad district id ${String(district.id)}`);
        const civilians = nonNegInt(district.civilians, `${district.id}.civilians`);
        const soldiers = nonNegInt(district.soldiers, `${district.id}.soldiers`);
        const front = district.garrison !== undefined && Number.isInteger(district.garrison.front)
            ? Number(district.garrison.front)
            : Math.floor(soldiers * Number(DISTRICT_DEFAULTS.frontGarrisonFraction));
        if (front < 0 || front > soldiers) throw new Error(`createRoster: ${district.id} front ${String(front)} is outside 0..${String(soldiers)}`);
        for (let n = 1; n <= civilians; n += 1) out.push(civilianStart(district.id, n));
        for (let n = 1; n <= soldiers; n += 1) out.push(soldierStart(district.id, n, n <= front));
    }
    return out;
}

/**
 * @param {string} district
 * @param {number} n
 * @returns {PersonRecord}
 */
function civilianStart(district, n) {
    const index = n - 1;
    const role = CIVILIAN_ROLES[index % CIVILIAN_ROLES.length];
    const home = `${district}/home-${pad((index % SLOT_COUNTS.home) + 1, 2)}`;
    /** @type {string | null} */
    let workplace = null;
    let state = "work";
    if (role === "resident") {
        state = "home";
    } else if (role === "farmer") {
        workplace = `${district}/farm-${pad((index % SLOT_COUNTS.farm) + 1, 2)}`;
    } else if (role === "builder") {
        workplace = `${district}/yard`;
    } else {
        workplace = `${district}/store-${pad((index % SLOT_COUNTS.store) + 1, 2)}`;
    }
    return { id: makeRecordId(district, "civilian", n), kind: "civilian", district, role, home, workplace, state, revision: 0, successor: null };
}

/**
 * @param {string} district
 * @param {number} n
 * @param {boolean} guard
 * @returns {PersonRecord}
 */
function soldierStart(district, n, guard) {
    return guard
        ? {
            id: makeRecordId(district, "soldier", n),
            kind: "soldier",
            district,
            role: "guard",
            home: `${district}/barracks`,
            workplace: `${district}/wall-${pad(((n - 1) % SLOT_COUNTS.wall) + 1, 2)}`,
            state: "wall",
            revision: 0,
            successor: null,
        }
        : {
            id: makeRecordId(district, "soldier", n),
            kind: "soldier",
            district,
            role: "reserve",
            home: `${district}/barracks`,
            workplace: `${district}/barracks`,
            state: "barracks",
            revision: 0,
            successor: null,
        };
}

/**
 * @param {PersonRecord[]} records
 * @param {string} district
 * @param {"civilian" | "soldier"} kind
 * @returns {number} the next unused sequence number for (district, kind)
 */
function nextSequence(records, district, kind) {
    let highest = 0;
    for (const record of records) {
        if (record.district !== district || record.kind !== kind) continue;
        highest = Math.max(highest, seqOf(record.id));
    }
    return highest + 1;
}

/**
 * @param {unknown} count
 * @returns {number}
 */
function countOf(count) {
    return nonNegInt(count, "count");
}

/**
 * Apply the given replacements and appended records. Keeps the sorted order.
 * @param {PersonRecord[]} records
 * @param {Map<string, PersonRecord>} replaced
 * @param {PersonRecord[]} created
 * @returns {PersonRecord[]}
 */
function applyChanges(records, replaced, created) {
    return sortRecords([...records.map((record) => replaced.get(record.id) ?? record), ...created]);
}

/**
 * Enlist civilians from a district into training. The trainee keeps the civilian record (no new
 * person appears) and moves to the barracks. Picks the lowest sequence numbers, so it is deterministic.
 * @param {PersonRecord[]} records
 * @param {string} district
 * @param {number} count
 * @returns {{ records: PersonRecord[], changed: string[] }}
 */
export function enlistRecruits(records, district, count) {
    const wanted = countOf(count);
    const pool = records
        .filter((record) => record.kind === "civilian" && record.district === district && (record.state === "home" || record.state === "work"))
        .sort((left, right) => seqOf(left.id) - seqOf(right.id));
    if (pool.length < wanted) {
        throw new Error(`enlistRecruits: ${district} has ${String(pool.length)} free civilians, cannot enlist ${String(wanted)}`);
    }
    const replaced = new Map();
    for (const record of pool.slice(0, wanted)) {
        replaced.set(record.id, { ...record, state: "training", workplace: `${district}/barracks`, revision: record.revision + 1 });
    }
    return { records: applyChanges(records, replaced, []), changed: [...replaced.keys()] };
}

/**
 * Finish training for the given number of trainees in a district. Each graduate keeps its civilian
 * record (state "graduated", successor set) and a new soldier record is created in the same district.
 * @param {PersonRecord[]} records
 * @param {string} district
 * @param {number} count
 * @returns {{ records: PersonRecord[], changed: string[], created: string[] }}
 */
export function graduateTrainees(records, district, count) {
    const wanted = countOf(count);
    const trainees = records
        .filter((record) => record.kind === "civilian" && record.district === district && record.state === "training")
        .sort((left, right) => seqOf(left.id) - seqOf(right.id));
    if (trainees.length < wanted) {
        throw new Error(`graduateTrainees: ${district} has ${String(trainees.length)} trainees, cannot graduate ${String(wanted)}`);
    }
    let soldierN = nextSequence(records, district, "soldier");
    /** @type {Map<string, PersonRecord>} */
    const replaced = new Map();
    /** @type {PersonRecord[]} */
    const created = [];
    for (const trainee of trainees.slice(0, wanted)) {
        const soldierId = makeRecordId(district, "soldier", soldierN);
        soldierN += 1;
        created.push({
            id: soldierId,
            kind: "soldier",
            district,
            role: "reserve",
            home: `${district}/barracks`,
            workplace: `${district}/barracks`,
            state: "barracks",
            revision: 0,
            successor: null,
        });
        replaced.set(trainee.id, { ...trainee, state: "graduated", successor: soldierId, revision: trainee.revision + 1 });
    }
    return { records: applyChanges(records, replaced, created), changed: [...replaced.keys()], created: created.map((record) => record.id) };
}

/**
 * Add `count` new people of a kind to a district (growth). Civilians arrive at home; soldiers at the barracks.
 * @param {PersonRecord[]} records
 * @param {string} district
 * @param {"civilian" | "soldier"} kind
 * @param {number} count
 * @returns {{ records: PersonRecord[], created: string[] }}
 */
export function recordBirths(records, district, kind, count) {
    const wanted = countOf(count);
    let n = nextSequence(records, district, kind);
    /** @type {PersonRecord[]} */
    const created = [];
    for (let i = 0; i < wanted; i += 1) {
        const id = makeRecordId(district, kind, n);
        if (kind === "civilian") {
            created.push({
                id,
                kind,
                district,
                role: "resident",
                home: `${district}/home-${pad(((n - 1) % SLOT_COUNTS.home) + 1, 2)}`,
                workplace: null,
                state: "home",
                revision: 0,
                successor: null,
            });
        } else {
            created.push({ id, kind, district, role: "reserve", home: `${district}/barracks`, workplace: `${district}/barracks`, state: "barracks", revision: 0, successor: null });
        }
        n += 1;
    }
    return { records: applyChanges(records, new Map(), created), created: created.map((record) => record.id) };
}

/**
 * Mark the highest-numbered live people of a kind in a district as dead. Records stay (tombstones).
 * Trainees are not in the civilian pool, so they are not picked.
 * @param {PersonRecord[]} records
 * @param {string} district
 * @param {"civilian" | "soldier"} kind
 * @param {number} count
 * @returns {{ records: PersonRecord[], changed: string[] }}
 */
export function recordDeaths(records, district, kind, count) {
    const wanted = countOf(count);
    const pool = records
        .filter((record) => record.kind === kind && record.district === district && isLiveRecord(record) && record.state !== "training")
        .sort((left, right) => seqOf(right.id) - seqOf(left.id));
    if (pool.length < wanted) {
        throw new Error(`recordDeaths: ${district} has ${String(pool.length)} living ${kind}s, cannot record ${String(wanted)} deaths`);
    }
    const replaced = new Map();
    for (const record of pool.slice(0, wanted)) {
        replaced.set(record.id, { ...record, state: "dead", revision: record.revision + 1 });
    }
    return { records: applyChanges(records, replaced, []), changed: [...replaced.keys()] };
}

/**
 * Derived headcounts from the records. `civilians` excludes trainees, `civilianKind` includes them,
 * matching the district economics (civilians + trainingQueue).
 * @param {PersonRecord[]} records
 */
export function populationTotals(records) {
    let civilians = 0;
    let trainees = 0;
    let sheltering = 0;
    let soldiers = 0;
    let graduated = 0;
    let dead = 0;
    /** @type {Record<string, { civilians: number, trainees: number, soldiers: number }>} */
    const byDistrict = {};
    for (const record of records) {
        const bucket = (byDistrict[record.district] ??= { civilians: 0, trainees: 0, soldiers: 0 });
        if (record.state === "dead") {
            dead += 1;
        } else if (record.kind === "soldier") {
            soldiers += 1;
            bucket.soldiers += 1;
        } else if (record.state === "graduated") {
            graduated += 1;
        } else if (record.state === "training") {
            trainees += 1;
            bucket.trainees += 1;
        } else {
            civilians += 1;
            bucket.civilians += 1;
            if (record.state === "sheltering") sheltering += 1;
        }
    }
    const civilianKind = civilians + trainees;
    return { records: records.length, civilians, trainees, sheltering, civilianKind, soldiers, graduated, dead, total: civilianKind + soldiers, byDistrict };
}

/**
 * The same totals as the kingdom states them.
 * @param {{ id: string, civilians: number, soldiers: number, trainingQueue?: number }[]} districts
 */
export function expectedTotals(districts) {
    let civilians = 0;
    let trainees = 0;
    let soldiers = 0;
    /** @type {Record<string, { civilians: number, trainees: number, soldiers: number }>} */
    const byDistrict = {};
    for (const district of districts) {
        const queue = countOf(district.trainingQueue ?? 0);
        civilians += countOf(district.civilians);
        trainees += queue;
        soldiers += countOf(district.soldiers);
        byDistrict[district.id] = { civilians: countOf(district.civilians), trainees: queue, soldiers: countOf(district.soldiers) };
    }
    return { civilians, trainees, civilianKind: civilians + trainees, soldiers, total: civilians + trainees + soldiers, byDistrict };
}

/**
 * Do the records agree with the district economics? Civilians and soldiers are compared kingdom-wide
 * (people move between districts through evacuation and reinforcement, which the records do not track),
 * trainees per district (training is a closed pipeline inside one district).
 * @param {PersonRecord[]} records
 * @param {{ id: string, civilians: number, soldiers: number, trainingQueue?: number }[]} districts
 * @returns {{ ok: boolean, mismatches: string[], totals: ReturnType<typeof populationTotals>, expected: ReturnType<typeof expectedTotals> }}
 */
export function checkPopulation(records, districts) {
    const totals = populationTotals(records);
    const expected = expectedTotals(districts);
    /** @type {string[]} */
    const mismatches = [];
    if (totals.civilians !== expected.civilians) mismatches.push(`civilians: records ${String(totals.civilians)}, districts ${String(expected.civilians)}`);
    if (totals.trainees !== expected.trainees) mismatches.push(`trainees: records ${String(totals.trainees)}, districts ${String(expected.trainees)}`);
    if (totals.soldiers !== expected.soldiers) mismatches.push(`soldiers: records ${String(totals.soldiers)}, districts ${String(expected.soldiers)}`);
    for (const id of Object.keys(expected.byDistrict)) {
        const want = expected.byDistrict[id].trainees;
        const have = totals.byDistrict[id]?.trainees ?? 0;
        if (have !== want) mismatches.push(`${id} trainees: records ${String(have)}, district ${String(want)}`);
    }
    return { ok: mismatches.length === 0, mismatches, totals, expected };
}

/**
 * Bring the records in line with the district economics.
 *
 * `events` are the exact economic transitions the caller just applied (the counts returned by
 * `openRecruitment` and `advanceTraining`): `{ op: "recruit" | "graduate", district, count }`. They are
 * applied first, so enlistment and graduation are recorded as what they were. Without events (a restart,
 * when the roster is behind the economy) the per-district trainee counts are brought in line by net
 * difference and the ops are marked `inferred`: totals stay exact, but a graduate and an enlistment in
 * the same window can be attributed differently. After that, births or deaths are applied kingdom-wide
 * to match the civilian and soldier headcounts (births go to the district with the largest shortfall,
 * deaths to the largest surplus, ties by district order). Idempotent: a second call returns no ops.
 *
 * @param {PersonRecord[]} records
 * @param {{ id: string, civilians: number, soldiers: number, trainingQueue?: number }[]} districts
 * @param {{ op: "recruit" | "graduate", district: string, count: number }[]} [events]
 * @returns {{ records: PersonRecord[], ops: { op: string, district: string, kind?: string, count: number, inferred?: boolean }[], problems: string[] }}
 */
export function syncPopulation(records, districts, events = []) {
    let current = sortRecords(records);
    /** @type {{ op: string, district: string, kind?: string, count: number, inferred?: boolean }[]} */
    const ops = [];
    /** @type {string[]} */
    const problems = [];
    const ordered = districts.slice().sort((left, right) => districtNumber(left.id) - districtNumber(right.id));

    for (const event of events) {
        try {
            if (event.op === "recruit") {
                current = enlistRecruits(current, event.district, countOf(event.count)).records;
                ops.push({ op: "enlist", district: event.district, count: countOf(event.count) });
            } else if (event.op === "graduate") {
                current = graduateTrainees(current, event.district, countOf(event.count)).records;
                ops.push({ op: "graduate", district: event.district, count: countOf(event.count) });
            } else {
                problems.push(`unknown economic event ${String(event.op)}`);
            }
        } catch (error) {
            problems.push(String(/** @type {Error} */ (error).message));
        }
    }

    for (const district of ordered) {
        const queue = countOf(district.trainingQueue ?? 0);
        const trainees = current.filter((record) => record.district === district.id && record.kind === "civilian" && record.state === "training").length;
        try {
            if (trainees < queue) {
                current = enlistRecruits(current, district.id, queue - trainees).records;
                ops.push({ op: "enlist", district: district.id, count: queue - trainees, inferred: true });
            } else if (trainees > queue) {
                current = graduateTrainees(current, district.id, trainees - queue).records;
                ops.push({ op: "graduate", district: district.id, count: trainees - queue, inferred: true });
            }
        } catch (error) {
            problems.push(String(/** @type {Error} */ (error).message));
        }
    }

    for (const kind of /** @type {("civilian" | "soldier")[]} */ (["civilian", "soldier"])) {
        const economy = (/** @type {{ civilians: number, soldiers: number }} */ district) => (kind === "civilian" ? countOf(district.civilians) : countOf(district.soldiers));
        const living = (/** @type {string} */ districtId) =>
            current.filter((record) => record.district === districtId && record.kind === kind && isLiveRecord(record) && record.state !== "training").length;
        let guard = 0;
        let delta = ordered.reduce((sum, district) => sum + economy(district) - living(district.id), 0);
        while (delta !== 0 && guard < 100000) {
            guard += 1;
            const gains = delta > 0;
            let best = ordered[0];
            let bestScore = Number.NEGATIVE_INFINITY;
            for (const district of ordered) {
                const score = gains ? economy(district) - living(district.id) : living(district.id) - economy(district);
                if (score > bestScore) {
                    best = district;
                    bestScore = score;
                }
            }
            try {
                current = gains
                    ? recordBirths(current, best.id, kind, 1).records
                    : recordDeaths(current, best.id, kind, 1).records;
                ops.push({ op: gains ? "birth" : "death", district: best.id, kind, count: 1, inferred: true });
            } catch (error) {
                problems.push(String(/** @type {Error} */ (error).message));
                break;
            }
            delta += gains ? -1 : 1;
        }
        if (delta !== 0) problems.push(`${kind} headcount could not be matched (${String(delta)} left)`);
    }
    return { records: current, ops: mergeOps(ops), problems };
}

/**
 * Collapse repeated (op, district, kind) entries so the report stays short.
 * @param {{ op: string, district: string, kind?: string, count: number, inferred?: boolean }[]} ops
 */
function mergeOps(ops) {
    /** @type {Map<string, { op: string, district: string, kind?: string, count: number, inferred?: boolean }>} */
    const merged = new Map();
    for (const op of ops) {
        const key = `${op.op}|${op.district}|${String(op.kind ?? "")}|${String(op.inferred === true)}`;
        const existing = merged.get(key);
        if (existing === undefined) merged.set(key, { ...op });
        else existing.count += op.count;
    }
    return [...merged.values()];
}
