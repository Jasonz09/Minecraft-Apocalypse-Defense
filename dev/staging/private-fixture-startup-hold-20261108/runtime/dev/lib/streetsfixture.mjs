// A thin adapter over dev/lib/poptharness.mjs for the streets driver tests (dev only, never shipped).
//
// poptharness models the parts popSync depends on - entities in chunks, tag writes, a property store, crashes - but
// it has no custom names and no block face at all. The streets driver adds exactly two things on top of that world,
// and both have to be observable to be tested:
//   - `nameTag`, written on every entity the driver signs. The harness handles do not carry it, so this file gives
//     each handle a name backed by a journal (`journal.nameWrites`) instead of editing poptharness;
//   - a block/command surface that RECORDS AND REFUSES. The harness dimension has no setBlock, so "writes no blocks"
//     would be unprovable if the method simply did not exist: here a block write is a trap that fires.
// Nothing else changes: the kingdom store, the chunk model, the crash model and the tag journal are poptharness's own.
import { PEOPLE } from "../../CivilizationApocalypse_BP/scripts/config.js";
import { POP_TAG_PREFIX } from "../../CivilizationApocalypse_BP/scripts/population/settings.js";
import { createInitialKingdom } from "../../CivilizationApocalypse_BP/scripts/kingdom/state.js";
import { chunkKeyOf, createPopWorld } from "./poptharness.mjs";

/** Where each starter district physically stands, matching dev/test/population-sync.test.mjs. */
export const HOMES = {
    "district-1": { x: 0, y: 70, z: 0 },
    "district-2": { x: 200, y: 70, z: 0 },
    "district-3": { x: 400, y: 70, z: 0 },
    "district-4": { x: 0, y: 70, z: 200 },
    "district-5": { x: 200, y: 70, z: 200 },
};

/** The player who keeps a district's streets promoted: standing inside district-1. */
export const NEAR_D1 = { name: "Steve", x: 6, y: 70, z: 6 };

/**
 * The starter kingdom as the shipped world holds it: the published population baseline, and every district carrying
 * the physical record that a built district has - because a district with no origin has no ground for anybody to
 * stand on, and popSync has nowhere to put a representative.
 * @param {{ civilians?: number, soldiers?: number, built?: string[] }} [options] counts for district-1 only
 */
export function starterKingdom(options = {}) {
    const kingdom = createInitialKingdom();
    for (const district of kingdom.districts) {
        const first = district.id === "district-1";
        if (first) {
            if (options.civilians !== undefined) district.civilians = options.civilians;
            if (options.soldiers !== undefined) district.soldiers = options.soldiers;
            const front = Math.floor(district.soldiers * 0.8);
            district.garrison = { front, reserve: district.soldiers - front };
        }
        const built = options.built === undefined || options.built.includes(district.id);
        if (built) {
            district.physical = physicalRecord(district.id, HOMES[district.id]);
        }
    }
    return kingdom;
}

/**
 * A `district.physical` record that passes kingdom/state.js validation the way a finished build's does.
 * @param {string} districtId
 * @param {{ x: number, y: number, z: number }} origin
 */
export function physicalRecord(districtId, origin) {
    return {
        status: "complete",
        layout: "hearthgate",
        planHash: `plan-${districtId}`,
        placed: 1000,
        total: 1000,
        version: 1,
        phase: "structure",
        origin: { ...origin },
    };
}

/**
 * The fake world the driver runs against.
 * @param {{ loaded?: string[], homes?: Record<string, { x: number, y: number, z: number }> }} [options]
 */
export function createStreetWorld(options = {}) {
    const pop = createPopWorld({ homes: options.homes ?? HOMES, loaded: options.loaded });
    /** @type {Map<string, string>} entity id -> nameTag the driver wrote */
    const names = new Map();
    const journal = {
        /** @type {Array<{ id: string, nameTag: string }>} */
        nameWrites: [],
        /** @type {Array<{ what: string, at: any }>} */
        blockWrites: [],
        /** @type {Array<{ command: string }>} */
        commandRuns: [],
    };

    /**
     * A harness handle plus the one engine property the harness lacks. Reads and writes all still go through the
     * harness, so crash points and unloaded-chunk throws behave exactly as they do there.
     * @param {any} handle
     */
    const wrap = (handle) => {
        const id = String(handle.id);
        return {
            get id() {
                return handle.id;
            },
            get typeId() {
                return handle.typeId;
            },
            get location() {
                return handle.location;
            },
            get isValid() {
                return handle.isValid;
            },
            get nameTag() {
                if (handle.isValid === false) {
                    throw new Error(`entity ${id} cannot be read where it stands`);
                }
                return names.get(id) ?? "";
            },
            set nameTag(/** @type {string} */ value) {
                if (handle.isValid === false) {
                    throw new Error(`entity ${id} cannot be named where it stands`);
                }
                names.set(id, String(value));
                journal.nameWrites.push({ id, nameTag: String(value) });
            },
            getTags: () => handle.getTags(),
            addTag: (/** @type {string} */ tag) => handle.addTag(tag),
            removeTag: (/** @type {string} */ tag) => handle.removeTag(tag),
            remove: () => handle.remove(),
        };
    };

    const trap = (/** @type {string} */ what) => (/** @type {any} */ ...args) => {
        journal.blockWrites.push({ what, at: args[0] });
        throw new Error(`the streets driver must never write a block (${what})`);
    };

    const dimension = {
        id: pop.dimension.id,
        /** @param {any} [query] */
        getEntities(query = {}) {
            return pop.dimension.getEntities(query).map(wrap);
        },
        /**
         * @param {string} typeId
         * @param {{ x: number, y: number, z: number }} location
         */
        spawnEntity(typeId, location) {
            return wrap(pop.dimension.spawnEntity(typeId, location));
        },
        /** @param {{ x: number, y: number, z: number }} location */
        getBlock(location) {
            return pop.dimension.getBlock(location);
        },
        /** @param {{ x: number, z: number }} locationXZ */
        getTopmostBlock(locationXZ) {
            return pop.dimension.getTopmostBlock(locationXZ);
        },
        // World-writing surfaces, present only so that touching one is loud instead of silently impossible.
        setBlock: trap("setBlock"),
        setBlockTypes: trap("setBlockTypes"),
        runCommand: (/** @type {string} */ command) => {
            journal.commandRuns.push({ command });
            throw new Error("the streets driver must never run a command");
        },
        runCommandAsync: (/** @type {string} */ command) => {
            journal.commandRuns.push({ command });
            return Promise.reject(new Error("the streets driver must never run a command"));
        },
    };

    /** Every live entity that carries a group tag of ours, whatever its chunk state. */
    const census = () => {
        /** @type {any[]} */
        const rows = [];
        for (const record of pop.state.entities.values()) {
            if (!record.alive) {
                continue;
            }
            const groups = [...record.tags]
                .filter((tag) => tag.startsWith(POP_TAG_PREFIX))
                .map((tag) => tag.slice(POP_TAG_PREFIX.length))
                .sort();
            if (groups.length === 0) {
                continue;
            }
            rows.push({
                id: record.id,
                typeId: record.typeId,
                groups,
                nameTag: names.get(record.id) ?? "",
                loaded: pop.state.loaded.has(chunkKeyOf(record.x, record.z)),
                x: record.x,
                y: record.y,
                z: record.z,
            });
        }
        return rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    };

    /** @type {(kind: string) => any[]} */
    const ofKind = (kind) => census().filter((row) => row.groups.some((group) => group.split(":")[1] === kind));

    /** @param {any} kingdom @param {number} tick @param {any} [report] */
    const context = (kingdom, tick, report = { ran: 1 }) => ({ kingdom, report, dimension, world: pop.world, tick });

    return {
        pop,
        state: pop.state,
        dimension,
        world: pop.world,
        journal,
        names,
        context,
        census,
        ofKind,

        /** @param {boolean} on */
        setGate(on) {
            pop.setRawProperty(PEOPLE.gateKey, on === true ? true : undefined);
        },

        /** The distinct nameTags our representatives carry, sorted. */
        namesInUse() {
            return [...new Set(census().map((row) => row.nameTag))].sort();
        },
    };
}
