// A deterministic entity world for the command layer (dev only, never shipped in the pack).
//
// The orders driver moves, and only moves: to test "the levy stood at (-11,-22)" the world has to answer a ground
// probe, hold a wall line, and refuse a teleport into ground it has released. civharness's terrain is real but
// irregular, and irregular ground makes coordinate assertions word-for-word luck, so this fixture models the
// smallest world that can prove every rule of integration/peopleOrders.js:
//   - flat standable grass at y=63, a stone wall ring at each district's own footprint, and the two things a
//     ground probe must refuse: open water and lava;
//   - entities with tags, a `teleport(location, options)` that throws in unloaded ground (as the engine does) and
//     journals where the entity was and where it was sent, plus a `nameTag` backed by a journal;
//   - a query surface that behaves like 2.7.0's: `getEntities({ type, tags, location, maxDistance })` with AND
//     semantics on tags and a 3-dimensional distance, and an entity in an unloaded chunk invisible to it;
//   - a journal for EVERY world write: blocks and commands are traps that record and then refuse, so "wrote no
//     block" is a measurement rather than an assumption.
// It does not model movement, pathfinding or combat, because Script API v2.7.0 has no API for any of them and a
// fake world cannot supply vanilla AI. It proves the contract, not the engine.
import { createInitialKingdom } from "../../CivilizationApocalypse_BP/scripts/kingdom/state.js";
import { POP_ENTITY_TYPES, POP_TAG_PREFIX } from "../../CivilizationApocalypse_BP/scripts/population/settings.js";

/** The surface every column stands on, and the height a district's people are recorded at. */
export const GROUND_Y = 63;
export const STAND_Y = GROUND_Y + 1;

/** Where each starter district physically stands, matching dev/lib/streetsfixture.mjs. */
export const HOMES = {
    "district-1": { x: 0, y: STAND_Y, z: 0 },
    "district-2": { x: 200, y: STAND_Y, z: 0 },
    "district-3": { x: 400, y: STAND_Y, z: 0 },
    "district-4": { x: 0, y: STAND_Y, z: 200 },
    "district-5": { x: 200, y: STAND_Y, z: 200 },
};

/** The wall line every district's circuit is drawn on, in blocks from its centre (`commands/civ.js`'s footprint). */
export const WALL_HALF = 24;

const CHUNK = 16;
const WATER = "minecraft:water";
const LAVA = "minecraft:lava";
const GRASS = "minecraft:grass_block";
const WALL = "minecraft:stone_bricks";
const AIR = "minecraft:air";

/** @type {Map<string, {typeId: string, y: number}>} column key -> an override on the topmost block */
const surfaces = new Map();
/** @type {Set<string>} chunk keys the engine has released */
const unloaded = new Set();
/** @type {Map<string, any>} */
const records = new Map();

const journal = {
    /** @type {Array<{ id: string, from: any, to: any, options: any }>} */
    teleports: [],
    /** @type {Array<{ id: string, nameTag: string }>} */
    nameWrites: [],
    /** @type {Array<{ id: string, tag: string, how: string }>} */
    tagWrites: [],
    /** @type {Array<{ id: string, typeId: string }>} */
    spawns: [],
    /** @type {Array<{ id: string, how: string }>} */
    removals: [],
    /** @type {Array<{ what: string, at: any }>} */
    blockWrites: [],
    /** @type {Array<{ command: string }>} */
    commandRuns: [],
    reads: { getEntities: 0, getBlock: 0, topmost: 0 },
};

let nextId = 1;

/** @param {number} x @param {number} z @returns {string} */
const column = (x, z) => `${String(Math.floor(x))},${String(Math.floor(z))}`;
/** @param {number} x @param {number} z @returns {string} */
const chunkKey = (x, z) => `${String(Math.floor(x / CHUNK))},${String(Math.floor(z / CHUNK))}`;

/**
 * @param {number} x
 * @param {number} z
 * @returns {boolean} true when the engine would have this chunk loaded
 */
export function loadedAt(x, z) {
    if (x < -750 || x > 749 || z < -750 || z > 749) {
        return false;
    }
    return !unloaded.has(chunkKey(x, z));
}

/**
 * The topmost block of a column and its height: grass everywhere, the wall ring where one was laid, and whatever
 * a test painted with `paintColumn`.
 * @param {number} x
 * @param {number} z
 * @returns {{ typeId: string, y: number }}
 */
function topOf(x, z) {
    const painted = surfaces.get(column(x, z));
    if (painted !== undefined) {
        return painted;
    }
    const home = nearestHome(x, z);
    if (home !== null && Math.max(Math.abs(x - home.x), Math.abs(z - home.z)) === WALL_HALF) {
        return { typeId: WALL, y: GROUND_Y + 1 };
    }
    return { typeId: GRASS, y: GROUND_Y };
}

/** @param {number} x @param {number} z @returns {{ x: number, z: number } | null} */
function nearestHome(x, z) {
    /** @type {{ x: number, z: number } | null} */
    let best = null;
    for (const home of Object.values(HOMES)) {
        const reach = Math.max(Math.abs(x - home.x), Math.abs(z - home.z));
        if (reach > WALL_HALF + 2) {
            continue;
        }
        if (best === null || reach < Math.max(Math.abs(x - best.x), Math.abs(z - best.z))) {
            best = { x: home.x, z: home.z };
        }
    }
    return best;
}

/**
 * The dimension the driver is handed, plus the write traps that make "it never touched a block" provable.
 */
const dimension = {
    id: "minecraft:overworld",
    /** @param {any} [query] */
    getEntities(query = {}) {
        journal.reads.getEntities += 1;
        if (!query || typeof query !== "object") {
            return [];
        }
        /** @type {any[]} */
        const out = [];
        for (const record of records.values()) {
            if (record.alive !== true || !loadedAt(record.x, record.z)) {
                continue;
            }
            if (Array.isArray(query.tags) && !query.tags.every((tag) => record.tags.has(tag))) {
                continue;
            }
            if (Array.isArray(query.excludeTags) && query.excludeTags.some((tag) => record.tags.has(tag))) {
                continue;
            }
            if (typeof query.type === "string" && record.typeId !== query.type) {
                continue;
            }
            if (Array.isArray(query.excludeTypes) && query.excludeTypes.includes(record.typeId)) {
                continue;
            }
            if (query.location !== undefined && typeof query.maxDistance === "number") {
                const distance = Math.hypot(record.x - query.location.x, record.y - query.location.y, record.z - query.location.z);
                if (distance > query.maxDistance) {
                    continue;
                }
            }
            out.push(handleOf(record));
        }
        return out;
    },
    /** @param {string} typeId @param {any} location @param {any} [options] */
    spawnEntity(typeId, location, options = {}) {
        if (!loadedAt(location.x, location.z)) {
            throw new Error(`cannot spawn ${String(typeId)} into unloaded ground`);
        }
        const id = `e${String(nextId++)}`;
        const record = {
            id,
            typeId: String(typeId),
            x: location.x,
            y: location.y,
            z: location.z,
            tags: new Set(Array.isArray(options?.tags) ? options.tags : []),
            alive: true,
            nameTag: options?.nameTag,
            facing: undefined,
        };
        records.set(id, record);
        journal.spawns.push({ id, typeId: record.typeId });
        return handleOf(record);
    },
    /** @param {any} location */
    getBlock(location) {
        journal.reads.getBlock += 1;
        if (!Number.isFinite(location?.y)) {
            return undefined;
        }
        if (!loadedAt(location.x, location.z)) {
            throw new Error("getBlock in unloaded chunk");
        }
        const top = topOf(Math.floor(location.x), Math.floor(location.z));
        const y = Math.floor(location.y);
        if (y === top.y) {
            return { typeId: top.typeId, x: location.x, y, z: location.z };
        }
        if (y < top.y) {
            return { typeId: "minecraft:dirt", x: location.x, y, z: location.z };
        }
        return { typeId: AIR, x: location.x, y, z: location.z };
    },
    /** @param {any} location */
    getTopmostBlock(location) {
        journal.reads.topmost += 1;
        if (!loadedAt(location.x, location.z)) {
            return undefined;
        }
        const top = topOf(Math.floor(location.x), Math.floor(location.z));
        return { typeId: top.typeId, location: { x: Math.floor(location.x), y: top.y, z: Math.floor(location.z) } };
    },
    setBlock: trap("setBlock"),
    setBlockTypes: trap("setBlockTypes"),
    fillBlock: trap("fillBlock"),
    swapBlocks: trap("swapBlocks"),
    /** @param {string} command */
    runCommand: (command) => {
        journal.commandRuns.push({ command });
        throw new Error("the orders driver must never run a command");
    },
    runCommandAsync: (command) => {
        journal.commandRuns.push({ command });
        return Promise.reject(new Error("the orders driver must never run a command"));
    },
};

/** @param {string} what */
function trap(what) {
    return (...args) => {
        journal.blockWrites.push({ what, at: args[0] });
        throw new Error(`the orders driver must never write a block (${what})`);
    };
}

/**
 * A handle over one record: reads throw once the ground is gone, exactly as the engine's do, and `teleport`
 * refuses unloaded ground. Identity is the record, never the handle, so a driver cannot remember its way
 * around a reload.
 * @param {any} record
 */
function handleOf(record) {
    const live = () => {
        if (record.alive !== true) {
            throw new Error(`entity ${String(record.id)} is gone`);
        }
        if (!loadedAt(record.x, record.z)) {
            throw new Error(`entity ${String(record.id)} is in unloaded ground`);
        }
    };
    return {
        get id() {
            return record.id;
        },
        get typeId() {
            live();
            return record.typeId;
        },
        get location() {
            live();
            return { x: record.x, y: record.y, z: record.z };
        },
        get isValid() {
            return record.alive === true && loadedAt(record.x, record.z);
        },
        get nameTag() {
            live();
            return record.nameTag;
        },
        set nameTag(value) {
            live();
            record.nameTag = String(value);
            journal.nameWrites.push({ id: record.id, nameTag: String(value) });
        },
        getTags() {
            live();
            return [...record.tags];
        },
        hasTag(tag) {
            live();
            return record.tags.has(tag);
        },
        addTag(tag) {
            live();
            const added = record.tags.add(tag);
            journal.tagWrites.push({ id: record.id, tag, how: "add" });
            return added !== undefined;
        },
        removeTag(tag) {
            live();
            record.tags.delete(tag);
            journal.tagWrites.push({ id: record.id, tag, how: "remove" });
            return true;
        },
        teleport(location, options = {}) {
            live();
            if (!loadedAt(location.x, location.z)) {
                throw new Error("teleport into unloaded ground");
            }
            journal.teleports.push({
                id: record.id,
                from: { x: record.x, y: record.y, z: record.z },
                to: { x: location.x, y: location.y, z: location.z },
                options,
            });
            record.x = location.x;
            record.y = location.y;
            record.z = location.z;
        },
        tryTeleport(location) {
            try {
                this.teleport(location);
                return true;
            } catch (_error) {
                return false;
            }
        },
        triggerEvent(name) {
            live();
            journal.tagWrites.push({ id: record.id, tag: String(name), how: "event" });
        },
        lookAt(target) {
            live();
            record.facing = target;
        },
        remove() {
            record.alive = false;
            records.delete(record.id);
            journal.removals.push({ id: record.id, how: "remove" });
        },
        kill() {
            record.alive = false;
            records.delete(record.id);
            journal.removals.push({ id: record.id, how: "kill" });
        },
    };
}

/** The world the runtime reads its gate from. */
const properties = new Map();
const world = {
    getDynamicProperty(key) {
        return properties.get(String(key));
    },
    setDynamicProperty(key, value) {
        if (value === undefined) {
            properties.delete(String(key));
        } else {
            properties.set(String(key), value);
        }
    },
    getDimension(/** @type {string} */ name) {
        return name === "overworld" || name === "minecraft:overworld" ? dimension : undefined;
    },
    sendMessage(/** @type {string} */ text) {
        messages.push(text);
    },
};
const messages = [];

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

/**
 * A clean world: the starter kingdom with a physical record per district, the people gate on, nobody standing in
 * it yet, and no chunk unloaded.
 * @param {{ gate?: boolean }} [options]
 */
export function resetOrdersWorld(options = {}) {
    records.clear();
    surfaces.clear();
    unloaded.clear();
    properties.clear();
    messages.length = 0;
    nextId = 1;
    journal.teleports.length = 0;
    journal.nameWrites.length = 0;
    journal.tagWrites.length = 0;
    journal.spawns.length = 0;
    journal.removals.length = 0;
    journal.blockWrites.length = 0;
    journal.commandRuns.length = 0;
    journal.reads.getEntities = 0;
    journal.reads.getBlock = 0;
    journal.reads.topmost = 0;
    properties.set("civ_people", options.gate !== false);
    return kingdomFixture();
}

/**
 * The saved-state the driver reads: `createInitialKingdom` (5 districts, 30 soldiers, front 24 / reserve 6) with
 * the physical origin a built district carries. A district with no origin has no wall and gets no posts.
 * @param {{ unbuilt?: string[] }} [options] district ids to leave physically unbuilt
 * @returns {any}
 */
export function kingdomFixture(options = {}) {
    const kingdom = createInitialKingdom();
    for (const district of kingdom.districts) {
        if (options.unbuilt?.includes(district.id)) {
            continue;
        }
        const home = HOMES[district.id];
        district.physical = {
            status: "complete",
            layout: "hearthgate",
            planHash: `plan-${district.id}`,
            placed: 1000,
            total: 1000,
            version: 1,
            origin: { x: home.x, y: home.y, z: home.z },
        };
    }
    return kingdom;
}

/**
 * Stand a district's levy in the world the way `peopleStreets.js` leaves them: iron golems carrying the group tag
 * `civpop:v1:<district>:sol:<index>`, named `<district name> levy`, gathered on the soldier side of the streets.
 * @param {any} kingdom
 * @param {string} districtId
 * @param {number} count how many levy entities the streets hold
 * @param {{ at?: { x: number, y: number, z: number }, nameTag?: string }} [options]
 * @returns {any[]}
 */
export function putLevy(kingdom, districtId, count, options = {}) {
    const home = HOMES[districtId];
    const name = String(kingdom.districts.find((district) => district.id === districtId)?.name ?? districtId);
    /** @type {any[]} */
    const made = [];
    for (let index = 0; index < count; index += 1) {
        const at = options.at ?? { x: home.x + 3 + index * 3, y: home.y, z: home.z + 20 };
        made.push(
            dimension.spawnEntity(POP_ENTITY_TYPES.sol, at, {
                tags: [`${POP_TAG_PREFIX}${districtId}:sol:${String(index)}`],
                nameTag: options.nameTag ?? `${name} levy`,
            }),
        );
    }
    return made;
}

/** Stand a district's civilians in the world: villagers on `:civ:` tags, which this layer must never see. */
export function putCivilians(kingdom, districtId, count) {
    const home = HOMES[districtId];
    const name = String(kingdom.districts.find((district) => district.id === districtId)?.name ?? districtId);
    for (let index = 0; index < count; index += 1) {
        dimension.spawnEntity(POP_ENTITY_TYPES.civ, { x: home.x - 6 + index * 3, y: home.y, z: home.z - 6 }, {
            tags: [`${POP_TAG_PREFIX}${districtId}:civ:${String(index)}`],
            nameTag: `${name} folk`,
        });
    }
}

/** Environment clutter: a golem with no tag of ours, and an entity carrying a tag in our namespace that is not a group. */
export function putStrangers() {
    dimension.spawnEntity(POP_ENTITY_TYPES.sol, { x: 12, y: STAND_Y, z: 12 }, { tags: ["someones_else"] });
    dimension.spawnEntity(POP_ENTITY_TYPES.sol, { x: -12, y: STAND_Y, z: -12 }, { tags: [`${POP_TAG_PREFIX}district-1:sol:`] });
    dimension.spawnEntity(POP_ENTITY_TYPES.sol, { x: 14, y: STAND_Y, z: -14 }, { tags: [`${POP_TAG_PREFIX}district-9:sol:0`] });
    dimension.spawnEntity(POP_ENTITY_TYPES.civ, { x: -14, y: STAND_Y, z: 14 }, { tags: [`${POP_TAG_PREFIX}district-1:civ:0`] });
}

/**
 * Press a district the way `sim/war.js` would, and name the bearing the attack comes from the way the invasion
 * director would. `assault: 0` is peace.
 * @param {any} kingdom
 * @param {string} districtId
 * @param {{ assault: number, security: string, bearing?: string }} press
 */
export function press(kingdom, districtId, state) {
    const district = kingdom.districts.find((one) => one.id === districtId);
    if (district === undefined) {
        throw new Error(`the fixture has no ${districtId}`);
    }
    district.assault = state.assault;
    district.security = state.security;
    if (state.assault > 0 && state.bearing !== undefined) {
        kingdom.invasion = {
            ...(kingdom.invasion ?? {}),
            enabled: true,
            wave: { districtId, bearing: state.bearing, strike: 0, strikes: [], delivered: {}, plan: {} },
        };
    }
    return district;
}

/** Paint one column's topmost block: the way to put water or lava where a post would otherwise stand. */
export function paintColumn(x, z, typeId, y = GROUND_Y) {
    surfaces.set(column(x, z), { typeId, y });
}

/** Release a chunk, as the engine does to ground nobody has loaded. */
export function unloadChunk(cx, cz) {
    unloaded.add(`${String(cx)},${String(cz)}`);
}

/** The ctx `peopleRuntime.js` builds for its drivers, from the current world. */
export function context(kingdom, step, options = {}) {
    return {
        kingdom,
        report: { step, ran: 1 },
        dimension,
        world,
        tick: step * 1000,
        gateOn: options.gateOn === undefined ? properties.get("civ_people") === true : options.gateOn,
    };
}

/** Every entity in the world as plain data a test can assert on, whatever its chunk state. */
export function entityList() {
    return [...records.values()]
        .filter((record) => record.alive === true)
        .map((record) => ({
            id: record.id,
            typeId: record.typeId,
            tags: [...record.tags].sort(),
            x: record.x,
            y: record.y,
            z: record.z,
            nameTag: record.nameTag,
        }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** The ids of every entity that has ever been in this world and is still standing: the conservation check. */
export function entityIds() {
    return entityList().map((entity) => entity.id);
}

/** @param {string} districtId @param {"sol" | "civ"} [kind] */
export function withGroupTag(districtId, kind = "sol") {
    const marker = `${POP_TAG_PREFIX}${districtId}:${kind}:`;
    return entityList().filter((entity) => entity.tags.some((tag) => tag.startsWith(marker)));
}

export { dimension, journal, messages, records, world };
