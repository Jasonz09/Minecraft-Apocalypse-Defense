// An entity-capable fake Bedrock world for the physical siege (dev only, never shipped in the pack).
//
// It extends dev/lib/civharness.mjs - the proven fake world with a block grid, a property store holding the
// engine's 32767-character limit, ticking areas and the pack's own planning stack - with the one thing that
// harness does not model: entities. Everything else (terrain, `civ:plan`, the kingdom save, the build job slot)
// is civharness's, so the siege is tested against the same geometry the district builder writes with.
//
// What the entity half models, because integration/siegeMobs.js relies on every one of these:
//   - `spawnEntity(typeId, location, { initialPersistence, initialRotation, spawnEvent })` and
//     `getEntities({ tags, type, excludeTypes, excludeTags, location, maxDistance })` with the engine's AND
//     semantics on `tags`;
//   - an entity in UNLOADED ground is invisible to a query and a stale handle to it throws, and a spawn into
//     unloaded ground throws;
//   - `addTag` returns false when the tag is refused (the engine's own answer), `remove()` on an entity whose
//     chunk is unloaded throws, and `remove()`/`kill()` are the only ways an entity leaves;
//   - a WORLD RELOAD: the save (dynamic properties) survives, only entities spawned with `initialPersistence`
//     are still standing, and every survivor comes back through a BRAND NEW handle - which is exactly why
//     identity has to be the tag and not the process's memory;
//   - every block write, so a test can prove the siege layer never laid or broke one.
// It does NOT model movement, pathfinding or combat: vanilla AI is not something a fake world can supply, and
// the pack has no routing API in Script API v2.7.0. It proves the contract, not the engine.
import { BASE_Y, builder, civCommands, districtById, fileUrl, groundCell, key, load, mc, naturalAt, planstore, resetWorld, restart, dimension, store } from "./civharness.mjs";

const WORLD_MIN = -750;
const WORLD_MAX = 749;

/** Entities that were spawned without persistence, as the engine would drop them at a reload. */
let droppedAtReload = 0;

/** Everything the siege layer can do to a world, journaled so a test can assert it rather than infer it. */
export const siege = {
    /** @type {Map<string, any>} */
    records: new Map(),
    nextId: 1,
    /** @type {Array<{ id: string, typeId: string, x: number, y: number, z: number, options: any }>} */
    spawns: [],
    /** @type {Array<{ id: string, typeId: string, tags: string[], how: string }>} */
    removals: [],
    /** @type {Array<{ id: string, tag: string, ok: boolean }>} */
    tagWrites: [],
    teleports: 0,
    lookAts: 0,
    eventsFired: [],
    refusedSpawns: 0,
    droppedAtReload: 0,
    reloads: 0,
    /** When true, the next `addTag` in the world is refused by the engine (one shot). */
    refuseNextTag: false,
};

/**
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function loadedAt(x, z) {
    if (x < WORLD_MIN || x > WORLD_MAX || z < WORLD_MIN || z > WORLD_MAX) {
        return false;
    }
    if (groundCell(x, z) === undefined) {
        return false;
    }
    return !mc.unloaded({ x, y: BASE_Y, z });
}

/**
 * @param {any} record
 * @returns {boolean}
 */
function visible(record) {
    return record.alive === true && loadedAt(record.x, record.z);
}

/**
 * A handle for one entity record. Handles are created on demand and hold nothing but the record, so a reload
 * handing out new ones is indistinguishable from the engine's point of view - and a driver that remembered an
 * old handle will throw, exactly as it would in a game.
 *
 * @param {any} record
 */
function handleOf(record) {
    const live = () => {
        if (!record.alive) {
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
            return visible(record);
        },
        get nameTag() {
            return record.nameTag;
        },
        set nameTag(value) {
            live();
            record.nameTag = String(value);
        },
        getRotation: () => ({ x: 0, y: record.rotation ?? 0 }),
        getTags() {
            live();
            return [...record.tags];
        },
        hasTag(/** @type {string} */ tag) {
            live();
            return record.tags.has(tag);
        },
        addTag(/** @type {string} */ tag) {
            live();
            if (siege.refuseNextTag) {
                siege.refuseNextTag = false;
                siege.tagWrites.push({ id: record.id, tag, ok: false });
                return false;
            }
            if (record.tags.has(tag)) {
                siege.tagWrites.push({ id: record.id, tag, ok: false });
                return false;
            }
            record.tags.add(tag);
            siege.tagWrites.push({ id: record.id, tag, ok: true });
            return true;
        },
        removeTag(/** @type {string} */ tag) {
            live();
            const had = record.tags.delete(tag);
            siege.tagWrites.push({ id: record.id, tag, ok: had });
            return had;
        },
        lookAt(/** @type {any} */ target) {
            live();
            siege.lookAts += 1;
            record.facing = { x: target.x, y: target.y, z: target.z };
        },
        teleport(/** @type {any} */ location) {
            live();
            if (!loadedAt(location.x, location.z)) {
                throw new Error("teleport into unloaded ground");
            }
            record.x = location.x;
            record.y = location.y;
            record.z = location.z;
            siege.teleports += 1;
        },
        triggerEvent(/** @type {string} */ name) {
            live();
            siege.eventsFired.push({ id: record.id, name });
        },
        kill() {
            if (!record.alive) {
                return false;
            }
            record.alive = false;
            siege.records.delete(record.id);
            siege.removals.push({ id: record.id, typeId: record.typeId, tags: [...record.tags], how: "kill" });
            return true;
        },
        remove() {
            if (!record.alive) {
                throw new Error(`entity ${String(record.id)} was already removed`);
            }
            if (!loadedAt(record.x, record.z)) {
                throw new Error(`cannot remove ${String(record.id)}: its chunk is unloaded`);
            }
            record.alive = false;
            siege.records.delete(record.id);
            siege.removals.push({ id: record.id, typeId: record.typeId, tags: [...record.tags], how: "remove" });
        },
    };
}

/**
 * @param {any} record
 * @param {any} query
 * @returns {boolean}
 */
function matches(record, query) {
    if (Array.isArray(query.tags) && !query.tags.every((/** @type {string} */ tag) => record.tags.has(tag))) {
        return false;
    }
    if (Array.isArray(query.excludeTags) && query.excludeTags.some((/** @type {string} */ tag) => record.tags.has(tag))) {
        return false;
    }
    if (typeof query.type === "string" && record.typeId !== query.type) {
        return false;
    }
    if (Array.isArray(query.excludeTypes) && query.excludeTypes.includes(record.typeId)) {
        return false;
    }
    if (query.location !== undefined && typeof query.maxDistance === "number") {
        const distance = Math.hypot(record.x - query.location.x, record.y - query.location.y, record.z - query.location.z);
        if (distance > query.maxDistance) {
            return false;
        }
    }
    return true;
}

// The engine surface the siege layer uses, added onto civharness's fake dimension. civharness's own builders
// never call these, so nothing else in the pack sees them.
dimension.getEntities = (/** @type {any} */ query = {}) => {
    return [...siege.records.values()].filter((record) => visible(record) && matches(record, query)).map((record) => handleOf(record));
};

dimension.spawnEntity = (/** @type {string} */ typeId, /** @type {any} */ location, /** @type {any} */ options = {}) => {
    if (!loadedAt(location.x, location.z)) {
        siege.refusedSpawns += 1;
        throw new Error(`cannot spawn ${String(typeId)} into unloaded ground at ${String(location.x)}, ${String(location.y)}, ${String(location.z)}`);
    }
    const id = `siege${String(siege.nextId)}`;
    siege.nextId += 1;
    const record = {
        id,
        typeId: String(typeId),
        x: location.x,
        y: location.y,
        z: location.z,
        tags: new Set(),
        alive: true,
        persistent: options?.initialPersistence === true,
        rotation: options?.initialRotation,
        nameTag: undefined,
        facing: undefined,
    };
    siege.records.set(id, record);
    siege.spawns.push({ id, typeId: record.typeId, x: record.x, y: record.y, z: record.z, options: { ...options } });
    if (typeof options?.spawnEvent === "string") {
        siege.eventsFired.push({ id, name: options.spawnEvent });
    }
    return handleOf(record);
};

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

/**
 * A world to lay a siege on: civharness's terrain, the people gate on, no build job running, no entities.
 * @param {number} [seed]
 * @param {any} [options] passed through to civharness.resetWorld; `options.field` reaches dev/lib/fakefield.mjs
 *   (lakes, river, cliffs...), which is how a water approach is put on the map for real.
 */
export function resetSiegeWorld(seed = 1, options = {}) {
    resetWorld(seed, options);
    siege.records.clear();
    siege.nextId = 1;
    siege.spawns.length = 0;
    siege.removals.length = 0;
    siege.tagWrites.length = 0;
    siege.eventsFired.length = 0;
    siege.teleports = 0;
    siege.lookAts = 0;
    siege.refusedSpawns = 0;
    siege.refuseNextTag = false;
    siege.reloads = 0;
    droppedAtReload = 0;
    siege.droppedAtReload = 0;
    mc.props.set("civ_people", true);
    return siege;
}

/** Every block write the world has taken, so a test can prove the siege layer added none. */
export function blockState() {
    return { writes: mc.writes, written: mc.written.size, placed: mc.placed.size };
}

/**
 * Environment, not a driver write: paint a surface across a rectangle of columns, so desert ground exists for
 * the husk branch to be tested against the real classifier rather than a stubbed one.
 *
 * @param {number} x0
 * @param {number} z0
 * @param {number} x1
 * @param {number} z1
 * @param {string} id
 */
export function setSurface(x0, z0, x1, z1, id) {
    for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
            const g = groundCell(x, z)?.g ?? BASE_Y;
            mc.placed.set(key(x, g, z), id);
        }
    }
}

/**
 * Environment: take standing vegetation and trees off a rectangle, so the approach ground a test reasons about
 * is bare. Only log and leaf cells are written, which leaves water, sand and stone untouched.
 *
 * @param {number} x0
 * @param {number} z0
 * @param {number} x1
 * @param {number} z1
 */
export function clearTrees(x0, z0, x1, z1) {
    for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
            const g = groundCell(x, z)?.g ?? BASE_Y;
            for (let y = g + 1; y <= g + 9; y += 1) {
                const id = naturalAt(x, y, z);
                if (id === "minecraft:oak_log" || id === "minecraft:oak_leaves") {
                    mc.placed.set(key(x, y, z), "minecraft:air");
                }
            }
        }
    }
}

/**
 * Environment: stand a wall ring on the outline, out of the masonry the pack actually lays, so "outside the
 * wall" in a test is a statement about blocks that exist rather than about numbers.
 *
 * @param {number} x0
 * @param {number} z0
 * @param {number} x1
 * @param {number} z1
 */
export function buildWallRing(x0, z0, x1, z1) {
    /** @type {Array<[number, number]>} */
    const cells = [];
    for (let x = x0; x <= x1; x += 1) {
        cells.push([x, z0], [x, z1]);
    }
    for (let z = z0; z <= z1; z += 1) {
        cells.push([x0, z], [x1, z]);
    }
    for (const [x, z] of cells) {
        const y = (groundCell(x, z)?.g ?? BASE_Y) + 1;
        mc.placed.set(key(x, y, z), "minecraft:stone_bricks");
    }
}

/**
 * The master plan the pack stores for a built civilization, in the production slot through the production store:
 * one entry per district with the outline its wall was laid along.
 *
 * @param {Array<{ index: number, name: string, outline: [number, number][] }>} entries
 * @param {number} [seed]
 */
export function storeMasterPlan(entries, seed = 20261017) {
    const payload = {
        version: 1,
        plan: { districts: entries, anchor: { x: 0, z: 0 }, rows: entries.length },
        seed,
        planSeed: seed,
        anchor: { x: 0, z: 0 },
    };
    const result = planstore.createPlanStore(mc.world).savePlan(payload);
    if (result.ok !== true) {
        throw new Error(`the fixture could not store a master plan: ${String(result.reason ?? result.status)}`);
    }
    return payload;
}

/**
 * Give a district the records a physically built district carries: a `civ` build record with its centre, a
 * `physical` prototype origin, and its wall standing in the world. Saved through the pack's own store, so a
 * record the save validator would refuse fails here rather than quietly doing nothing.
 *
 * @param {string} districtId
 * @param {{ x: number, z: number, half?: number, status?: string, wall?: boolean }} site
 */
export function siteDistrict(districtId, site) {
    const half = site.half ?? 24;
    const loaded = store.load();
    const district = districtById(loaded.kingdom, districtId);
    if (district === undefined) {
        throw new Error(`the fixture has no ${districtId} to site`);
    }
    district.civ = {
        status: site.status ?? "complete",
        seed: 20261017,
        startedStep: 0,
        anchor: { x: site.x, z: site.z },
        centre: { x: site.x, z: site.z },
        checksum: `fixture-${districtId}`,
        stage: "complete",
        ops: { placed: 4000, skipped: 200 },
    };
    district.physical = {
        layout: "hearthgate",
        version: 1,
        status: "complete",
        origin: { x: site.x, y: BASE_Y + 1, z: site.z },
        dimension: "minecraft:overworld",
        placed: 4000,
        total: 4000,
        planHash: `fixture-${districtId}`,
    };
    store.save(loaded.kingdom);
    if (site.wall !== false) {
        buildWallRing(site.x - half, site.z - half, site.x + half, site.z + half);
    }
    return { id: districtId, x: site.x, z: site.z, half, outline: square(site.x, site.z, half) };
}

/**
 * @param {number} x
 * @param {number} z
 * @param {number} half
 * @returns {[number, number][]}
 */
export function square(x, z, half) {
    return [
        [x - half, z - half],
        [x + half, z - half],
        [x + half, z + half],
        [x - half, z + half],
    ];
}

/**
 * Press a district the way `sim/war.js` would, and save it: this is the state the siege layer reads.
 *
 * @param {string} districtId
 * @param {{ assault: number, security: string }} press
 */
export function threaten(districtId, press) {
    const loaded = store.load();
    const district = districtById(loaded.kingdom, districtId);
    if (district === undefined) {
        throw new Error(`the fixture has no ${districtId}`);
    }
    district.assault = press.assault;
    district.security = press.security;
    store.save(loaded.kingdom);
    return district;
}

/** The saved kingdom, read back through the pack's own store. */
export function savedKingdom() {
    return store.load().kingdom;
}

/** Every entity in the world, ours or not, as plain data a test can assert on. */
export function entityList() {
    return [...siege.records.values()].map((record) => ({
        id: record.id,
        typeId: record.typeId,
        tags: [...record.tags].sort(),
        x: record.x,
        y: record.y,
        z: record.z,
        persistent: record.persistent === true,
        nameTag: record.nameTag,
        rotation: record.rotation,
        facing: record.facing,
    }));
}

/** @param {string} tag */
export function withTag(tag) {
    return entityList().filter((entity) => entity.tags.includes(tag));
}

/**
 * A world reload: the save survives, everything the world never persisted is gone, and the survivors come back
 * through new handles. `restart()` is civharness's process restart, which forgets the pack's module state.
 */
export async function reloadWorld() {
    for (const [id, record] of [...siege.records.entries()]) {
        if (record.persistent !== true) {
            siege.records.delete(id);
            droppedAtReload += 1;
        }
    }
    siege.droppedAtReload = droppedAtReload;
    siege.reloads += 1;
    await restart();
    return { standing: siege.records.size, dropped: droppedAtReload };
}

/**
 * Import a pack module as if the script were loading for the first time after that reload: the query makes it a
 * new module instance, so any memory the driver kept in module scope is gone. Its own imports stay cached.
 *
 * @param {string[]} parts e.g. ["integration", "siegeMobs.js"]
 */
export async function freshImport(parts) {
    siege.nextId += 1;
    return import(`${fileUrl(...parts)}?fresh=${String(++freshImports)}`);
}

let freshImports = 0;

export { builder, civCommands, dimension, fileUrl, load, mc, planstore, resetWorld, store };
