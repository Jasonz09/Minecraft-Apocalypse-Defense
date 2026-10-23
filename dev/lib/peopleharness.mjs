// Fake world and soak harness for the people LOD layer (dev only, never shipped).
//
// The fake world models what the pack can observe and do:
//   - entities with a type, a position, tags and a chunk; spawn, despawn, addTag, removeTag, moveTo;
//   - chunk loaded flags. An entity in an unloaded chunk is persisted but NOT visible to scripts, exactly
//     like the engine; it reappears when its chunk loads (a "dormant" entity);
//   - dynamic properties with the engine's 32767-character value limit, and crash injection on writes;
//   - a crash between `spawnEntity` and the tag writes (SimulatedCrash), the case reconcile must heal.
// Everything is seeded: the same seed gives the same digest.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

export const contract = await load("people", "contract.js");
export const lod = await load("people", "lod.js");
export const reconciler = await load("people", "reconcile.js");
export const roster = await load("people", "roster.js");
export const population = await load("sim", "population.js");
export const state = await load("kingdom", "state.js");
export const config = await load("config.js");

/** Thrown where a real crash would end the script run. The harness catches it and restarts. */
export class SimulatedCrash extends Error {
    constructor(message) {
        super(message);
        this.name = "SimulatedCrash";
    }
}

/** Deterministic PRNG (mulberry32). */
export function createRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A tick clock. The soak advances it once per simulated tick. */
export function createClock(start = 0) {
    let tick = start;
    return {
        now: () => tick,
        advance: (count = 1) => {
            tick += count;
            return tick;
        },
    };
}

/**
 * Fake world. `loaded` is a set of "cx,cz" chunk keys; the soak replaces it every tick.
 * @param {{ chunkSize?: number, maxPropertyChars?: number }} [options]
 */
export function createFakeWorld(options = {}) {
    const chunkSize = options.chunkSize ?? 16;
    const maxPropertyChars = options.maxPropertyChars ?? 32767;
    let nextHandle = 1;
    /** @type {Map<string, { handle: string, typeId: string, x: number, y: number, z: number, tags: Set<string> }>} */
    const entities = new Map();
    /** @type {Set<string>} */
    let loaded = new Set();
    /** @type {Map<string, string>} */
    const props = new Map();
    let writesUntilCrash = -1;
    const counters = { spawns: 0, despawns: 0, tagWrites: 0, moves: 0, propertyWrites: 0 };

    /** @param {number} x @param {number} z */
    const chunkKeyOf = (x, z) => `${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`;
    /** @param {{ x: number, z: number }} at */
    const isLoadedAt = (at) => loaded.has(chunkKeyOf(at.x, at.z));

    /** @param {{ handle: string, typeId: string, x: number, y: number, z: number, tags: Set<string> }} entity */
    const view = (entity) => ({ handle: entity.handle, typeId: entity.typeId, district: null, x: entity.x, y: entity.y, z: entity.z, tags: [...entity.tags].sort() });

    return {
        counters,
        entities,
        /** @param {Set<string>} chunks */
        setLoaded(chunks) {
            loaded = chunks;
        },
        /** @param {number} cx @param {number} cz */
        isLoaded(cx, cz) {
            return loaded.has(`${cx},${cz}`);
        },
        /** Entities a script can see: those standing in loaded chunks, sorted by handle. */
        visible() {
            return [...entities.values()].filter((entity) => isLoadedAt(entity)).sort((a, b) => (a.handle < b.handle ? -1 : 1)).map(view);
        },
        /** Everything the engine still holds, including dormant entities. */
        persisted() {
            return [...entities.values()].map(view);
        },
        /** @param {string} typeId @param {{ x: number, y: number, z: number }} at */
        spawn(typeId, at) {
            if (!isLoadedAt(at)) throw new Error(`spawn: chunk of ${JSON.stringify(at)} is not loaded`);
            const handle = `e${String(nextHandle).padStart(6, "0")}`;
            nextHandle += 1;
            entities.set(handle, { handle, typeId, x: at.x, y: at.y, z: at.z, tags: new Set() });
            counters.spawns += 1;
            return handle;
        },
        /** @param {string} handle */
        despawn(handle) {
            const entity = entities.get(handle);
            if (entity === undefined) throw new Error(`despawn: no entity ${handle}`);
            if (!isLoadedAt(entity)) throw new Error(`despawn: ${handle} is in an unloaded chunk; scripts cannot reach it`);
            entities.delete(handle);
            counters.despawns += 1;
        },
        /** @param {string} handle @param {string} tag */
        addTag(handle, tag) {
            const entity = entities.get(handle);
            if (entity === undefined || !isLoadedAt(entity)) throw new Error(`addTag: ${handle} not reachable`);
            entity.tags.add(tag);
            counters.tagWrites += 1;
        },
        /** @param {string} handle @param {string} tag */
        removeTag(handle, tag) {
            const entity = entities.get(handle);
            if (entity === undefined || !isLoadedAt(entity)) throw new Error(`removeTag: ${handle} not reachable`);
            entity.tags.delete(tag);
            counters.tagWrites += 1;
        },
        /** @param {string} handle @param {{ x: number, y: number, z: number }} to */
        moveTo(handle, to) {
            const entity = entities.get(handle);
            if (entity === undefined || !isLoadedAt(entity)) throw new Error(`moveTo: ${handle} not reachable`);
            entity.x = to.x;
            entity.y = to.y;
            entity.z = to.z;
            counters.moves += 1;
        },
        /** @param {string} key */
        getDynamicProperty(key) {
            return props.get(key);
        },
        /** @param {string} key @param {any} [value] */
        setDynamicProperty(key, value) {
            if (writesUntilCrash === 0) {
                writesUntilCrash = -1;
                throw new SimulatedCrash(`crash while writing ${key}`);
            }
            if (writesUntilCrash > 0) writesUntilCrash -= 1;
            counters.propertyWrites += 1;
            if (value === undefined) {
                props.delete(key);
                return;
            }
            if (typeof value === "string" && value.length > maxPropertyChars) {
                throw new Error(`property ${key} is ${String(value.length)} characters; the limit is ${String(maxPropertyChars)}`);
            }
            props.set(key, value);
        },
        getDynamicPropertyIds() {
            return [...props.keys()].sort();
        },
        /** Let `count` property writes succeed, then crash on the next one. */
        armCrashAfterWrites(count) {
            writesUntilCrash = count;
        },
        disarmCrash() {
            writesUntilCrash = -1;
        },
    };
}

/**
 * Districts on a ring, with symbolic slots placed around each centre (all within the 49-block footprint).
 * @param {string[]} districtIds
 * @param {number} [ring]
 */
export function createLayout(districtIds, ring = 160) {
    const anchors = {};
    const centres = districtIds.map((id, index) => {
        const angle = (2 * Math.PI * index) / districtIds.length;
        return { id, x: Math.round(ring * Math.cos(angle)), z: Math.round(ring * Math.sin(angle)) };
    });
    for (const centre of centres) {
        const put = (slot, dx, dz) => {
            anchors[`${centre.id}/${slot}`] = { x: centre.x + dx, y: 64, z: centre.z + dz };
        };
        for (let k = 0; k < 6; k += 1) put(`home-0${k + 1}`, Math.round(14 * Math.cos((k * Math.PI) / 3)), Math.round(14 * Math.sin((k * Math.PI) / 3)));
        [[18, 18], [-18, 18], [-18, -18], [18, -18]].forEach(([dx, dz], k) => put(`farm-0${k + 1}`, dx, dz));
        [[0, -20], [-20, 0], [20, 0]].forEach(([dx, dz], k) => put(`store-0${k + 1}`, dx, dz));
        for (let k = 0; k < 8; k += 1) put(`wall-0${k + 1}`, Math.round(22 * Math.cos((k * Math.PI) / 4)), Math.round(22 * Math.sin((k * Math.PI) / 4)));
        put("barracks", 0, 6);
        put("yard", -6, -6);
    }
    return { centres, anchors };
}

/**
 * Nearest district centre within 60 blocks, else null (outside every footprint).
 * @param {{ centres: { id: string, x: number, z: number }[] }} layout
 * @param {number} x
 * @param {number} z
 */
export function districtAt(layout, x, z) {
    let best = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const centre of layout.centres) {
        const d = (centre.x - x) ** 2 + (centre.z - z) ** 2;
        if (d < bestD) {
            best = centre.id;
            bestD = d;
        }
    }
    return bestD <= 60 * 60 ? best : null;
}

/**
 * Players walking the ring from centre to centre. `reverse` walks the other way round.
 * @param {{ centres: { id: string, x: number, z: number }[] }} layout
 * @param {{ speed?: number, players?: number }} [options]
 */
export function createMovers(layout, options = {}) {
    const speed = options.speed ?? 0.8;
    const count = options.players ?? 2;
    const order = layout.centres;
    const walkers = Array.from({ length: count }, (_unused, index) => {
        const route = index % 2 === 0 ? order : order.slice().reverse();
        const start = route[index % route.length];
        return { id: `p${String(index + 1)}`, route, leg: index % route.length, x: start.x, z: start.z };
    });
    return {
        /** @returns {{ id: string, x: number, z: number }[]} */
        step() {
            for (const walker of walkers) {
                const target = walker.route[(walker.leg + 1) % walker.route.length];
                const dx = target.x - walker.x;
                const dz = target.z - walker.z;
                const dist = Math.hypot(dx, dz);
                if (dist <= speed) {
                    walker.x = target.x;
                    walker.z = target.z;
                    walker.leg = (walker.leg + 1) % walker.route.length;
                } else {
                    walker.x += (dx / dist) * speed;
                    walker.z += (dz / dist) * speed;
                }
            }
            return walkers.map((walker) => ({ id: walker.id, x: walker.x, z: walker.z }));
        },
    };
}

/**
 * Apply actions to the fake world, in order. `crashBetweenSpawnAndTag` makes the next spawn throw
 * before its tags are written, which is the crash the reconciler must heal.
 * @param {ReturnType<typeof createFakeWorld>} world
 * @param {any[]} actions
 * @param {{ crashAfterSpawn?: boolean, typeIdFallback?: string }} [options]
 */
export function applyActionsToWorld(world, actions, options = {}) {
    for (const action of actions) {
        if (action.op === "despawn") {
            world.despawn(action.handle);
        } else if (action.op === "tag" || action.op === "adopt") {
            for (const tag of action.remove) world.removeTag(action.handle, tag);
            for (const tag of action.add) world.addTag(action.handle, tag);
        } else if (action.op === "move") {
            world.moveTo(action.handle, action.to);
        } else if (action.op === "spawn") {
            const handle = world.spawn(action.typeId, action.at);
            if (options.crashAfterSpawn === true) throw new SimulatedCrash(`crash after spawning ${action.id} (${handle}) before its tags`);
            for (const tag of action.tags) world.addTag(handle, tag);
        } else {
            throw new Error(`unknown action ${String(action.op)}`);
        }
    }
}

/** A kingdom in the shipped starting shape, with stores large enough that only people are under test. */
export function createKingdom() {
    const kingdom = state.createInitialKingdom();
    for (const district of kingdom.districts) {
        district.reserves = { food: 5000, materials: 5000, supplies: 5000 };
    }
    return kingdom;
}

/**
 * Loaded chunks: a square of `view` chunks around every player.
 * @param {{ x: number, z: number }[]} players
 * @param {number} view
 */
export function loadedAround(players, view) {
    const set = new Set();
    for (const player of players) {
        const cx = Math.floor(player.x / 16);
        const cz = Math.floor(player.z / 16);
        for (let dx = -view; dx <= view; dx += 1) {
            for (let dz = -view; dz <= view; dz += 1) set.add(`${cx + dx},${cz + dz}`);
        }
    }
    return set;
}

/** FNV-1a over a string, as 8 hex characters. */
export function fnv(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Run the full soak: walking players, economy (recruitment and training), LOD plan, reconcile, injected
 * crashes between spawn and tag writes and during roster saves, and a restart after each crash.
 *
 * Returns the counters and a list of violated invariants (empty when everything holds).
 * @param {{ ticks?: number, seed?: number, crashRate?: number, economyEvery?: number, players?: number, forcedUnloads?: boolean, view?: number }} [options]
 */
export function runSoak(options = {}) {
    const ticks = options.ticks ?? 1200;
    const seed = options.seed ?? 1;
    const crashRate = options.crashRate ?? 0.01;
    const economyEvery = options.economyEvery ?? 8;
    const view = options.view ?? 6;
    const rng = createRng(seed);
    const clock = createClock(0);
    const kingdom = createKingdom();
    const districtIds = kingdom.districts.map((district) => district.id);
    const layout = createLayout(districtIds);
    const movers = createMovers(layout, { players: options.players ?? 2 });
    const world = createFakeWorld();
    const rosterStore = roster.createRosterStore(world);
    const limits = lod.LOD_LIMITS;

    let records = contract.createRoster(kingdom.districts.map((district) => ({ id: district.id, civilians: district.civilians, soldiers: district.soldiers, garrison: district.garrison })));
    const initialSave = rosterStore.save(records);
    const summary = {
        ticks,
        seed,
        spawns: 0,
        despawns: 0,
        tagWrites: 0,
        moves: 0,
        adopts: 0,
        crashesAfterSpawn: 0,
        crashesDuringSave: 0,
        restarts: 0,
        economySteps: 0,
        graduations: 0,
        maxPhysical: 0,
        maxPerDistrict: 0,
        maxPerPlayer: 0,
        maxSpawnsPerTick: 0,
        maxRecords: 0,
        recordsAtStart: records.length,
        totalsAtStart: contract.populationTotals(records).total,
        digest: "",
        violations: /** @type {string[]} */ ([]),
        initialSave,
    };
    let digestText = "";
    /** @type {Map<string, number>} chunk key -> tick until which a forced unload holds */
    const blocked = new Map();
    /** @param {number} x @param {number} z */
    const chunkKeyOf = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
    /** @type {Map<string, number>} */
    const materialisedPerRecord = new Map();
    /** @type {Map<string, boolean>} */
    const physicalLastTick = new Map();
    const violate = (message) => {
        if (summary.violations.length < 50) summary.violations.push(message);
    };

    /** Reload the roster after a restart and bring it back in line with the economy. */
    const restart = () => {
        summary.restarts += 1;
        const loaded = rosterStore.load({ quarantine: true });
        if (loaded.status !== "ok") {
            violate(`restart could not load the roster: ${loaded.status} ${String(loaded.reason)}`);
            return;
        }
        const sync = contract.syncPopulation(loaded.records, kingdom.districts);
        if (sync.problems.length > 0) violate(`restart sync problems: ${sync.problems.join("; ")}`);
        records = sync.records;
        const saved = rosterStore.save(records);
        if (!saved.ok) violate(`restart save failed: ${saved.status} ${String(saved.reason)}`);
    };

    for (let step = 0; step < ticks; step += 1) {
        const tick = clock.advance(1);
        const players = movers.step();
        if (options.forcedUnloads === true && tick % 150 === 0) {
            const victim = world.visible().find((entity) => entity.tags.some((tag) => tag.startsWith("civ:id:")));
            if (victim !== undefined) blocked.set(chunkKeyOf(victim.x, victim.z), tick + 20);
        }
        for (const [key, until] of [...blocked]) if (tick >= until) blocked.delete(key);
        const loadedNow = loadedAround(players, view);
        for (const key of blocked.keys()) loadedNow.delete(key);
        world.setLoaded(loadedNow);

        // Economy: recruitment and training move people between roles; the records follow by sync.
        if (tick % economyEvery === 0) {
            summary.economySteps += 1;
            const district = kingdom.districts[Math.floor(rng() * kingdom.districts.length)];
            const wanted = 1 + Math.floor(rng() * 3);
            /** @type {{ op: "recruit" | "graduate", district: string, count: number }[]} */
            const events = [];
            try {
                const enlisted = population.openRecruitment(district, wanted, { kingdom });
                events.push({ op: "recruit", district: district.id, count: enlisted.recruits });
            } catch (_error) {
                // Refusals (shortage, not enough free civilians) are part of the economy; nothing to record.
            }
            for (const other of kingdom.districts) {
                const trained = population.advanceTraining(kingdom, other);
                if (trained.graduated > 0) events.push({ op: "graduate", district: other.id, count: trained.graduated });
            }
            const before = records.filter((record) => record.state === "graduated").length;
            const sync = contract.syncPopulation(records, kingdom.districts, events);
            if (sync.ops.some((op) => op.inferred === true)) violate(`tick ${String(tick)}: economy step needed inferred ops ${JSON.stringify(sync.ops)}`);
            if (sync.problems.length > 0) violate(`economy sync problems at tick ${String(tick)}: ${sync.problems.join("; ")}`);
            records = sync.records;
            summary.graduations += records.filter((record) => record.state === "graduated").length - before;
            const check = contract.checkPopulation(records, kingdom.districts);
            if (!check.ok) violate(`population mismatch at tick ${String(tick)}: ${check.mismatches.join("; ")}`);
            if (contract.populationTotals(records).total !== summary.totalsAtStart) {
                violate(`totals changed at tick ${String(tick)}: ${String(contract.populationTotals(records).total)} != ${String(summary.totalsAtStart)}`);
            }
            if (rng() < crashRate) {
                world.armCrashAfterWrites(Math.floor(rng() * 3));
            }
            const saved = rosterStore.save(records);
            world.disarmCrash();
            if (!saved.ok) {
                summary.crashesDuringSave += 1;
                restart();
            }
            digestText += `E${String(tick)}:${String(records.length)};`;
        }

        // Physical reconciliation: observe, plan, reconcile, apply.
        const observed = world.visible().map((entity) => ({ ...entity, district: districtAt(layout, entity.x, entity.z) }));
        const physical = reconciler.physicalIds(observed);
        const plan = lod.planLod({ tick, players, records, anchors: layout.anchors, physical, isLoaded: world.isLoaded, limits: {} });
        const reconciled = reconciler.reconcile({ records, observed, plan });
        if (reconciled.problems.length > 0) violate(`reconcile problems at tick ${String(tick)}: ${reconciled.problems.join("; ")}`);

        const perDistrict = {};
        for (const id of plan.desired) {
            const record = records.find((item) => item.id === id);
            if (record !== undefined) perDistrict[record.district] = (perDistrict[record.district] ?? 0) + 1;
        }
        const spawnsThisTick = plan.materialise.length;
        summary.maxSpawnsPerTick = Math.max(summary.maxSpawnsPerTick, spawnsThisTick);
        if (spawnsThisTick > limits.maxSpawnsPerTick) violate(`tick ${String(tick)} planned ${String(spawnsThisTick)} spawns`);
        if (plan.desired.length > limits.maxPhysical) violate(`tick ${String(tick)} plan holds ${String(plan.desired.length)} units`);
        for (const [district, count] of Object.entries(perDistrict)) {
            if (count > limits.districtCap) violate(`tick ${String(tick)} plan holds ${String(count)} units in ${district}`);
        }

        const crashNow = rng() < crashRate;
        let crashed = false;
        try {
            applyActionsToWorld(world, reconciled.actions, { crashAfterSpawn: crashNow });
        } catch (error) {
            if (!(error instanceof SimulatedCrash)) throw error;
            crashed = true;
            summary.crashesAfterSpawn += 1;
        }
        for (const action of reconciled.actions) {
            if (action.op === "spawn") {
                const key = action.id;
                materialisedPerRecord.set(key, (materialisedPerRecord.get(key) ?? 0) + 1);
            }
            if (action.op === "adopt") summary.adopts += 1;
        }
        digestText += `T${String(tick)}:${reconciled.actions.map((action) => `${action.op}:${String(action.handle ?? action.id)}`).join(",")};`;
        if (crashed) {
            restart();
            continue;
        }

        // Invariants after a clean reconcile.
        // Duplicates are judged over everything the engine holds (dormant units included); caps and remnants over what scripts can see.
        const persisted = world.persisted();
        const taggedAll = persisted.filter((entity) => entity.tags.some((tag) => tag.startsWith("civ:id:")));
        const visible = world.visible();
        const tagged = visible.filter((entity) => entity.tags.some((tag) => tag.startsWith("civ:id:")));
        const untagged = visible.filter((entity) => entity.typeId === "minecraft:villager_v2" && !entity.tags.some((tag) => tag.startsWith("civ:id:")));
        /** @type {Map<string, number>} */
        const perRecord = new Map();
        for (const entity of taggedAll) {
            for (const tag of entity.tags.filter((item) => item.startsWith("civ:id:"))) {
                const id = tag.slice("civ:id:".length);
                perRecord.set(id, (perRecord.get(id) ?? 0) + 1);
            }
        }
        for (const [id, count] of perRecord) {
            if (count > 1) violate(`tick ${String(tick)}: ${String(count)} entities carry ${id}`);
            if (!records.some((record) => record.id === id)) violate(`tick ${String(tick)}: entity carries unknown record ${id}`);
        }
        if (untagged.length > 0) violate(`tick ${String(tick)}: ${String(untagged.length)} untagged remnants survived a clean reconcile`);
        summary.dormant = Math.max(summary.dormant ?? 0, persisted.length - visible.length);
        if (tagged.length > limits.maxPhysical) violate(`tick ${String(tick)}: ${String(tagged.length)} physical entities exceed ${String(limits.maxPhysical)}`);
        /** @type {Record<string, number>} */
        const districtCount = {};
        for (const entity of tagged) {
            const id = entity.tags.find((tag) => tag.startsWith("civ:id:")).slice("civ:id:".length);
            const record = records.find((item) => item.id === id);
            if (record !== undefined) districtCount[record.district] = (districtCount[record.district] ?? 0) + 1;
        }
        for (const [district, count] of Object.entries(districtCount)) {
            summary.maxPerDistrict = Math.max(summary.maxPerDistrict, count);
            if (count > limits.districtCap) violate(`tick ${String(tick)}: ${String(count)} physical in ${district}`);
        }
        for (const player of players) {
            let near = 0;
            for (const entity of tagged) {
                if ((entity.x - player.x) ** 2 + (entity.z - player.z) ** 2 <= (limits.radius + limits.hysteresis) ** 2) near += 1;
            }
            summary.maxPerPlayer = Math.max(summary.maxPerPlayer, near);
            if (near > limits.playerCap) violate(`tick ${String(tick)}: ${String(near)} physical near ${player.id}`);
        }
        summary.maxPhysical = Math.max(summary.maxPhysical, tagged.length);
        summary.maxRecords = Math.max(summary.maxRecords, records.length);
        if (records.length < summary.recordsAtStart) violate(`tick ${String(tick)}: records fell from ${String(summary.recordsAtStart)} to ${String(records.length)}`);
        const physicalNow = new Set(reconciler.physicalIds(world.visible().map((entity) => ({ ...entity, district: null }))));
        for (const id of physicalNow) {
            if (physicalLastTick.get(id) !== true) {
                materialisedPerRecord.set(`in:${id}`, (materialisedPerRecord.get(`in:${id}`) ?? 0) + 1);
            }
        }
        physicalLastTick.clear();
        for (const id of physicalNow) physicalLastTick.set(id, true);
        digestText += `P${String(tick)}:${String(tagged.length)};`;
    }

    summary.spawns = world.counters.spawns;
    summary.despawns = world.counters.despawns;
    summary.tagWrites = world.counters.tagWrites;
    summary.moves = world.counters.moves;
    summary.finalTotals = contract.populationTotals(records);
    summary.finalCheck = contract.checkPopulation(records, kingdom.districts);
    summary.roster = roster.rosterSizeReport(records);
    const perRecordMax = Math.max(0, ...[...materialisedPerRecord.entries()].filter(([key]) => key.startsWith("in:")).map(([, count]) => count));
    summary.maxMaterialisationsPerRecord = perRecordMax;
    summary.digest = fnv(digestText + JSON.stringify(records.map((record) => [record.id, record.state, record.revision])));
    return summary;
}
