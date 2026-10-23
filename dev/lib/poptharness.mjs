// Fake Bedrock world for the population sync tests (dev only, never shipped in the pack).
//
// What it models, because the adapter relies on each of these:
//   - entities live in chunks; an entity in an UNLOADED chunk is invisible to queries, and an old handle to it
//     throws when used (the real engine's behaviour is the open question in docs/POPULATION_LOD.md);
//   - a spawn into an unloaded chunk throws;
//   - a property store with the engine's 32767-character value limit;
//   - a crash: `crashAfterMutations(n)` lets n more writes land, then the process is dead and EVERY later call
//     throws, so nothing after the crash point can reach the world. `restart()` is a new process on the same world;
//   - a journal of every write, so tests can assert what happened and what was refused.
// It does NOT model movement, combat, pathing, or the real cost of queries. It proves the contract, not the engine.
import { STORAGE_KEYS } from "../../CivilizationApocalypse_BP/scripts/config.js";
import { serializeKingdom } from "../../CivilizationApocalypse_BP/scripts/kingdom/state.js";

export class Crash extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "Crash";
    }
}

export const CHUNK = 16;

/**
 * @param {number} x
 * @param {number} z
 */
export function chunkKeyOf(x, z) {
    return `${String(Math.floor(x / CHUNK))},${String(Math.floor(z / CHUNK))}`;
}

/**
 * @param {{ dimensionId?: string, loaded?: string[], homes?: Record<string, { x: number, y: number, z: number }> }} [options]
 */
export function createPopWorld(options = {}) {
    const state = {
        dimensionId: options.dimensionId ?? "minecraft:overworld",
        /** @type {Map<string, any>} */
        entities: new Map(),
        loaded: new Set(options.loaded ?? []),
        /** @type {Map<string, string>} */
        props: new Map(),
        /** @type {Array<{ name: string, x: number, y: number, z: number }>} */
        players: [],
        homes: options.homes ?? {},
        mutations: 0,
        /** @type {number | null} */
        crashAfter: null,
        dead: false,
        nextId: 1,
        /** @type {Array<{ id: string, tags: string[], x: number, y: number, z: number }>} */
        removals: [],
        removeAttemptsUnloaded: 0,
        /** @type {Array<{ id: string, tag: string, op: "add" | "remove" }>} */
        tagWrites: [],
        /** @type {string[]} */
        spawned: [],
        spawnRejections: 0,
        /** @type {Array<{ key: string, bytes: number }>} */
        propertyWrites: [],
        /** When true, the next addTag throws an ordinary error (the process stays alive). */
        failNextTag: false,
    };

    const alive = () => {
        if (state.dead) {
            throw new Crash("the process is dead");
        }
    };

    /**
     * Every write goes through here. A crash point is checked BEFORE the write, so the write never happens.
     * @template T
     * @param {string} what
     * @param {() => T} write
     * @returns {T}
     */
    const mutate = (what, write) => {
        alive();
        if (state.crashAfter !== null && state.mutations >= state.crashAfter) {
            state.dead = true;
            throw new Crash(`crash before ${what}`);
        }
        state.mutations += 1;
        return write();
    };

    /** @param {{ x: number, z: number }} point */
    const isLoadedAt = (point) => state.loaded.has(chunkKeyOf(point.x, point.z));

    /** @param {any} record */
    const isLoadedRecord = (record) => state.loaded.has(chunkKeyOf(record.x, record.z));

    /** @param {any} record */
    const handleOf = (record) => {
        const live = () => {
            alive();
            if (!record.alive) {
                throw new Error(`entity ${String(record.id)} was removed`);
            }
            if (!isLoadedRecord(record)) {
                throw new Error(`entity ${String(record.id)} is in an unloaded chunk`);
            }
        };
        return {
            get id() {
                return record.id;
            },
            get typeId() {
                return record.typeId;
            },
            get location() {
                return { x: record.x, y: record.y, z: record.z };
            },
            get isValid() {
                return !state.dead && record.alive && isLoadedRecord(record);
            },
            getTags() {
                live();
                return [...record.tags];
            },
            addTag(/** @type {string} */ tag) {
                return mutate("addTag", () => {
                    live();
                    if (state.failNextTag) {
                        state.failNextTag = false;
                        throw new Error("tag write refused by the engine");
                    }
                    if (record.tags.has(tag)) {
                        return false;
                    }
                    if (record.tags.size >= 256) {
                        throw new Error("entity has too many tags");
                    }
                    record.tags.add(tag);
                    state.tagWrites.push({ id: record.id, tag, op: "add" });
                    return true;
                });
            },
            removeTag(/** @type {string} */ tag) {
                return mutate("removeTag", () => {
                    live();
                    const had = record.tags.delete(tag);
                    if (had) {
                        state.tagWrites.push({ id: record.id, tag, op: "remove" });
                    }
                    return had;
                });
            },
            remove() {
                return mutate("remove", () => {
                    if (!record.alive) {
                        throw new Error(`entity ${String(record.id)} was already removed`);
                    }
                    if (!isLoadedRecord(record)) {
                        state.removeAttemptsUnloaded += 1;
                        throw new Error(`cannot remove ${String(record.id)}: its chunk is unloaded`);
                    }
                    record.alive = false;
                    state.entities.delete(record.id);
                    state.removals.push({ id: record.id, tags: [...record.tags], x: record.x, y: record.y, z: record.z });
                });
            },
        };
    };

    const dimension = {
        id: state.dimensionId,
        /** @param {any} [query] */
        getEntities(query = {}) {
            alive();
            /** @type {any[]} */
            let list = [...state.entities.values()].filter((record) => record.alive && isLoadedRecord(record));
            if (query.location !== undefined && query.maxDistance !== undefined) {
                const { location, maxDistance } = query;
                list = list.filter((record) => Math.hypot(record.x - location.x, record.y - location.y, record.z - location.z) <= maxDistance);
            }
            if (Array.isArray(query.tags)) {
                list = list.filter((record) => query.tags.every((/** @type {string} */ tag) => record.tags.has(tag)));
            }
            return list.map(handleOf);
        },
        /**
         * @param {string} typeId
         * @param {{ x: number, y: number, z: number }} location
         */
        spawnEntity(typeId, location) {
            return mutate("spawnEntity", () => {
                if (!isLoadedAt(location)) {
                    state.spawnRejections += 1;
                    throw new Error(`cannot spawn into an unloaded chunk at ${JSON.stringify(location)}`);
                }
                const id = `e${String(state.nextId)}`;
                state.nextId += 1;
                const record = { id, typeId, x: location.x, y: location.y, z: location.z, tags: new Set(), alive: true };
                state.entities.set(id, record);
                state.spawned.push(id);
                return handleOf(record);
            });
        },
        /** @param {{ x: number, y: number, z: number }} location */
        getBlock(location) {
            alive();
            return isLoadedAt(location) ? { typeId: "minecraft:grass_block", isValid: true } : undefined;
        },
    };

    const world = {
        /** @param {string} key */
        getDynamicProperty(key) {
            alive();
            return state.props.get(key);
        },
        /**
         * @param {string} key
         * @param {string | undefined} value
         */
        setDynamicProperty(key, value) {
            mutate("setDynamicProperty", () => {
                if (typeof value === "string" && value.length > 32767) {
                    throw new RangeError("dynamic property value exceeds 32767 characters");
                }
                if (value === undefined) {
                    state.props.delete(key);
                } else {
                    state.props.set(key, value);
                }
                state.propertyWrites.push({ key, bytes: typeof value === "string" ? value.length : 0 });
            });
        },
        getAllPlayers() {
            alive();
            return state.players.map((player) => ({
                name: player.name,
                location: { x: player.x, y: player.y, z: player.z },
                dimension: { id: state.dimensionId },
            }));
        },
    };

    return {
        state,
        world,
        dimension,
        homes: state.homes,

        /**
         * Environment, not behaviour: adds an entity without counting as a write.
         * @param {{ id?: string, typeId?: string, x: number, y?: number, z: number, tags?: string[] }} entity
         */
        addEntity(entity) {
            const id = entity.id ?? `e${String(state.nextId)}`;
            if (entity.id === undefined) {
                state.nextId += 1;
            }
            state.entities.set(id, {
                id,
                typeId: entity.typeId ?? "minecraft:villager_v2",
                x: entity.x,
                y: entity.y ?? 70,
                z: entity.z,
                tags: new Set(entity.tags ?? []),
                alive: true,
            });
            return id;
        },

        /** Environment: moves an entity (the physical layer's job in the real game). */
        moveEntity(/** @type {string} */ id, /** @type {number} */ x, /** @type {number} */ z) {
            const record = state.entities.get(id);
            if (record !== undefined) {
                record.x = x;
                record.z = z;
            }
        },

        /**
         * Environment: loads every chunk covering the block rectangle.
         * @param {number} x0
         * @param {number} z0
         * @param {number} x1
         * @param {number} z1
         */
        loadArea(x0, z0, x1, z1) {
            for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx += 1) {
                for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz += 1) {
                    state.loaded.add(`${String(cx)},${String(cz)}`);
                }
            }
        },

        /**
         * Environment: unloads every chunk covering the block rectangle.
         * @param {number} x0
         * @param {number} z0
         * @param {number} x1
         * @param {number} z1
         */
        unloadArea(x0, z0, x1, z1) {
            for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx += 1) {
                for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz += 1) {
                    state.loaded.delete(`${String(cx)},${String(cz)}`);
                }
            }
        },

        /** @param {Array<{ name: string, x: number, y: number, z: number }>} players */
        setPlayers(players) {
            state.players = players.map((player) => ({ ...player }));
        },

        /** Environment: stores the kingdom the way the pack does (civ:kingdom, validated). */
        setKingdom(/** @type {any} */ kingdom) {
            state.props.set(STORAGE_KEYS.kingdom, serializeKingdom(kingdom));
        },

        /** Environment: the stored kingdom, parsed. */
        storedKingdom() {
            const raw = state.props.get(STORAGE_KEYS.kingdom);
            return raw === undefined ? undefined : JSON.parse(raw);
        },

        /** Environment: the next addTag fails with an ordinary error (no crash). */
        failNextTag() {
            state.failNextTag = true;
        },

        /** Environment: writes a raw cursor string, for corruption tests. */
        setRawProperty(/** @type {string} */ key, /** @type {string | undefined} */ value) {
            if (value === undefined) {
                state.props.delete(key);
            } else {
                state.props.set(key, value);
            }
        },

        /**
         * Lets `n` more writes land. The write after those throws Crash and the process is dead.
         * @param {number} n
         */
        crashAfterMutations(n) {
            state.crashAfter = state.mutations + n;
        },

        /** A new process on the same world: nothing is pending, crash points are cleared. */
        restart() {
            state.dead = false;
            state.crashAfter = null;
        },

        /**
         * Entities per group, counted from the canonical tags in our namespace.
         * Returns Map<groupId, { total, loaded }>.
         */
        groupCounts() {
            /** @type {Map<string, { total: number, loaded: number }>} */
            const counts = new Map();
            for (const record of state.entities.values()) {
                for (const tag of record.tags) {
                    if (!tag.startsWith("civpop:v1:")) {
                        continue;
                    }
                    const groupId = tag.slice("civpop:v1:".length);
                    const row = counts.get(groupId) ?? { total: 0, loaded: 0 };
                    row.total += 1;
                    if (isLoadedRecord(record)) {
                        row.loaded += 1;
                    }
                    counts.set(groupId, row);
                }
            }
            return counts;
        },

        /** Number of live entities, optionally only the ones carrying a tag from our namespace. */
        liveCount(/** @type {{ ours?: boolean }} */ filter = {}) {
            let count = 0;
            for (const record of state.entities.values()) {
                if (!record.alive) {
                    continue;
                }
                if (filter.ours === true && ![...record.tags].some((tag) => tag.startsWith("civpop:"))) {
                    continue;
                }
                count += 1;
            }
            return count;
        },

        /** A JSON-serialisable picture of the world, for determinism checks. */
        snapshot() {
            const entities = [...state.entities.values()]
                .map((record) => ({ id: record.id, typeId: record.typeId, x: record.x, y: record.y, z: record.z, tags: [...record.tags].sort() }))
                .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
            return {
                entities,
                props: [...state.props.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
                loaded: [...state.loaded].sort(),
            };
        },
    };
}
