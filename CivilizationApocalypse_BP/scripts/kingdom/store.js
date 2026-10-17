import { KINGDOM_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, STORAGE_KEYS } from "../config.js";
import { migrateKingdom, readSchemaVersion } from "./migrations.js";
import { createInitialKingdom, deserializeKingdom, serializeKingdom } from "./state.js";

/**
 * Persistence for the kingdom, with schema migration.
 *
 * The `world` object is injected rather than imported so this module stays runnable
 * outside Minecraft (the offline suite uses a Map-backed stand-in) and so nothing
 * touches world state during early execution.
 *
 * Load statuses:
 *   ok | absent | corrupt | invalid | migrated | newer | unsupported
 * The last three never overwrite stored data - valid progress written by another pack
 * version, or a save older than the supported range, is refused instead of reset.
 *
 * @param {import("@minecraft/server").World} target
 */
export function createKingdomStore(target) {
    const storageKey = STORAGE_KEYS.kingdom;
    const quarantineKey = STORAGE_KEYS.quarantine;

    function readStoredVersion() {
        const raw = target.getDynamicProperty(storageKey);
        if (typeof raw !== "string") {
            return undefined;
        }
        try {
            return readSchemaVersion(JSON.parse(raw));
        } catch (_error) {
            return undefined;
        }
    }

    /**
     * Keep a copy of a payload we are about to replace. Dynamic property values are
     * size limited, so the copy is truncated rather than refused.
     * @param {string} note
     */
    function quarantine(note) {
        const raw = target.getDynamicProperty(storageKey);
        if (typeof raw !== "string") {
            return false;
        }
        let version;
        try {
            version = readSchemaVersion(JSON.parse(raw));
        } catch (_error) {
            version = undefined;
        }
        // Truncate by the *serialised* size: escaping quotes can double the payload.
        let keep = 20000;
        let serialised = JSON.stringify({ note, schemaVersion: version, payload: raw.slice(0, keep) });
        while (serialised.length > 30000 && keep > 0) {
            keep = Math.floor(keep / 2);
            serialised = JSON.stringify({ note, schemaVersion: version, payload: raw.slice(0, keep) });
        }
        target.setDynamicProperty(quarantineKey, serialised);
        return true;
    }

    function load() {
        const raw = target.getDynamicProperty(storageKey);
        if (raw === undefined) {
            return { kingdom: undefined, status: "absent", reason: "no kingdom has been stored yet" };
        }
        if (typeof raw !== "string") {
            return { kingdom: undefined, status: "corrupt", reason: `stored kingdom is a ${typeof raw}, expected a JSON string` };
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            return { kingdom: undefined, status: "corrupt", reason: `saved state is not valid JSON (${String(error)})` };
        }

        const version = readSchemaVersion(parsed);
        if (version === undefined) {
            return { kingdom: undefined, status: "corrupt", reason: "saved state has no schemaVersion" };
        }
        if (version > KINGDOM_SCHEMA_VERSION) {
            return {
                kingdom: undefined,
                status: "newer",
                reason: `saved state is schema v${String(version)}, newer than this pack (v${String(KINGDOM_SCHEMA_VERSION)})`,
            };
        }
        if (version < MIN_SUPPORTED_SCHEMA_VERSION) {
            return {
                kingdom: undefined,
                status: "unsupported",
                reason: `saved state is schema v${String(version)}; the oldest readable version is v${String(MIN_SUPPORTED_SCHEMA_VERSION)}`,
            };
        }
        if (version < KINGDOM_SCHEMA_VERSION) {
            const result = migrateKingdom(parsed);
            if (result.problems) {
                return { kingdom: undefined, status: "corrupt", reason: `migration failed: ${result.problems.join("; ")}` };
            }
            return { kingdom: result.kingdom, status: "migrated", fromVersion: version, path: result.path, reason: undefined };
        }

        const deserialized = deserializeKingdom(raw);
        if (deserialized.kingdom === undefined) {
            return { kingdom: undefined, status: "invalid", reason: deserialized.reason };
        }
        return { kingdom: deserialized.kingdom, status: "ok", reason: undefined };
    }

    /**
     * @param {any} kingdom
     */
    function save(kingdom) {
        const storedVersion = readStoredVersion();
        if (storedVersion !== undefined && storedVersion > KINGDOM_SCHEMA_VERSION) {
            throw new Error(`refusing to overwrite a v${String(storedVersion)} save with v${String(KINGDOM_SCHEMA_VERSION)}`);
        }
        target.setDynamicProperty(storageKey, serializeKingdom(kingdom));
    }

    function ensureInitial() {
        const loaded = load();

        if (loaded.status === "migrated") {
            quarantine(`pre-migration copy of schema v${String(loaded.fromVersion)}`);
            save(loaded.kingdom);
            return { kingdom: loaded.kingdom, seeded: false, migrated: true, fromVersion: loaded.fromVersion, reason: undefined };
        }
        if (loaded.kingdom !== undefined) {
            return { kingdom: loaded.kingdom, seeded: false, migrated: false, reason: undefined };
        }
        if (loaded.status === "newer" || loaded.status === "unsupported") {
            return { kingdom: undefined, seeded: false, migrated: false, refused: true, reason: loaded.reason };
        }

        quarantine(loaded.status);
        const kingdom = createInitialKingdom();
        save(kingdom);
        return { kingdom, seeded: true, migrated: false, reason: loaded.reason };
    }

    return { storageKey, quarantineKey, load, save, ensureInitial, readStoredVersion };
}
