import { CIV_LIMITS } from "./budget.js";

// Chunked, versioned, checksummed persistence for payloads larger than one dynamic property
// (the CivPlan, ~20-60 KB; also reused by civ/jobs.js for the job queue).
//
// Pure JS: the world is injected. Needed members: getDynamicProperty(key), setDynamicProperty(key, value).
// Optional members (treated defensively, never required): getDynamicPropertyIds, getDynamicPropertyTotalByteCount.
//
// Key layout for a store with prefix P (plan: "civ:plan", jobs: "civ:jobs"):
//   P:meta        envelope JSON (the ONLY pointer to live data; a single property write flips it)
//   P:a:0..n-1    chunks of generation family "a"
//   P:b:0..n-1    chunks of generation family "b"
//   P:quarantine  bounded copy of data found corrupt
//
// Atomic-ish save protocol (each numbered step is exactly one property write):
//   1. choose the INACTIVE family (the one meta does not point at)
//   2. write every chunk of the new payload into the inactive family   (live data untouched)
//   3. read everything back and verify the checksum                     (no writes)
//   4. write P:meta pointing at the new family                          (THE flip - one write)
//   5. delete the old family's chunks and any stale tail                (garbage only)
// A crash (exception, restart) before step 4 leaves the old meta and the old complete payload;
// after step 4 the new complete payload is live and only garbage remains, swept by the next save.
// The load path trusts nothing but meta plus a verified checksum, so a half payload is never returned.

export const STORE_ENVELOPE_SCHEMA = 1;

/**
 * Minimal world surface the stores use.
 * @typedef {{
 *   getDynamicProperty(key: string): any,
 *   setDynamicProperty(key: string, value?: any): void,
 *   getDynamicPropertyIds?: () => string[],
 *   getDynamicPropertyTotalByteCount?: () => number,
 * }} WorldLike
 * @typedef {{ format: string, version: number, schema: number, hash: string, chunks: number, bytes: number, fam: string, gen: number }} Envelope
 * @typedef {{ status: "ok"|"absent"|"corrupt"|"newer"|"unsupported", text?: string, meta?: Envelope, reason: string|undefined }} TextLoad
 * @typedef {{ ok: boolean, reason?: string, status?: string, bytes: number, limit?: number, chunks?: number, hash?: string, fam?: string, gen?: number }} SaveResult
 * @typedef {{ status: "ok"|"absent"|"corrupt"|"newer"|"unsupported", plan?: any, reason: string|undefined, migrated?: boolean, fromVersion?: number, meta?: Envelope }} PlanLoad
 */

/**
 * FNV-1a 32-bit over UTF-16 code units, lowercase hex, zero padded to 8 chars.
 * @param {string} text
 */
export function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * UTF-8 byte length without TextEncoder.
 * @param {string} text
 */
export function utf8Length(text) {
    let n = 0;
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                n += 4;
                i += 1;
            } else n += 3;
        } else n += 3;
    }
    return n;
}

/**
 * Split text into chunks of at most `chunkChars` UTF-16 units, never between a surrogate pair.
 * @param {string} text
 * @param {number} chunkChars
 */
export function splitChunks(text, chunkChars) {
    /** @type {string[]} */
    const out = [];
    let i = 0;
    while (i < text.length) {
        let end = Math.min(text.length, i + chunkChars);
        if (end < text.length) {
            const c = text.charCodeAt(end - 1);
            if (c >= 0xd800 && c <= 0xdbff) end -= 1;
        }
        out.push(text.slice(i, end));
        i = end;
    }
    return out;
}

/** @param {any} meta */
function validEnvelope(meta) {
    return (
        meta !== null &&
        typeof meta === "object" &&
        typeof meta.format === "string" &&
        Number.isInteger(meta.version) &&
        Number.isInteger(meta.schema) &&
        typeof meta.hash === "string" &&
        Number.isInteger(meta.chunks) &&
        meta.chunks >= 0 &&
        Number.isInteger(meta.bytes) &&
        meta.bytes >= 0 &&
        (meta.fam === "a" || meta.fam === "b") &&
        Number.isInteger(meta.gen)
    );
}

/**
 * Create a chunked store.
 * @param {WorldLike} world
 * @param {{
 *   prefix: string, format: string, version?: number, minVersion?: number, maxBytes?: number,
 *   chunkChars?: number, migrations?: Record<number, (payload: any) => any>,
 * }} options
 */
export function createChunkedStore(world, options) {
    const prefix = options.prefix;
    const format = options.format;
    const version = options.version ?? 1;
    const minVersion = options.minVersion ?? 1;
    const maxBytes = options.maxBytes ?? CIV_LIMITS.maxPlanBytes;
    const chunkChars = Math.min(options.chunkChars ?? CIV_LIMITS.maxPropertyChars, 32000);
    const migrations = options.migrations ?? {};
    const maxChunks = Math.ceil(maxBytes / Math.max(1, Math.floor(chunkChars / 3))) + 2; // worst case 3 bytes/char
    const metaKey = `${prefix}:meta`;
    const quarantineKey = `${prefix}:quarantine`;

    /** @param {string} fam @param {number} i */
    const chunkKey = (fam, i) => `${prefix}:${fam}:${String(i)}`;

    /** @returns {{ state: "absent"|"corrupt"|"ok", meta?: Envelope, reason?: string }} */
    function readMeta() {
        let raw;
        try {
            raw = world.getDynamicProperty(metaKey);
        } catch (error) {
            return { state: "corrupt", reason: `meta unreadable (${String(error)})` };
        }
        if (raw === undefined) return { state: "absent" };
        if (typeof raw !== "string") return { state: "corrupt", reason: `meta is a ${typeof raw}, expected a JSON string` };
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            return { state: "corrupt", reason: `meta is not valid JSON (${String(error)})` };
        }
        if (!validEnvelope(parsed)) return { state: "corrupt", reason: "meta envelope is malformed" };
        if (parsed.format !== format) return { state: "corrupt", reason: `meta format "${String(parsed.format)}" is not "${format}"` };
        return { state: "ok", meta: /** @type {Envelope} */ (parsed) };
    }

    /**
     * Read and verify the chunks the envelope points at.
     * @param {Envelope} meta
     * @returns {{ text?: string, reason?: string }}
     */
    function readPayload(meta) {
        /** @type {string[]} */
        const parts = [];
        for (let i = 0; i < meta.chunks; i += 1) {
            const part = world.getDynamicProperty(chunkKey(meta.fam, i));
            if (typeof part !== "string") return { reason: `chunk ${String(i)} of ${String(meta.chunks)} is missing` };
            parts.push(part);
        }
        const text = parts.join("");
        if (utf8Length(text) !== meta.bytes) return { reason: `payload is ${String(utf8Length(text))} bytes, expected ${String(meta.bytes)}` };
        if (fnv1a(text) !== meta.hash) return { reason: "checksum mismatch" };
        return { text };
    }

    /** Load and verify the raw payload text (no JSON parsing, no migration). @returns {TextLoad} */
    function loadText() {
        const m = readMeta();
        if (m.state === "absent") return { status: "absent", reason: "nothing stored" };
        if (m.state === "corrupt" || m.meta === undefined) return { status: "corrupt", reason: m.reason };
        const meta = m.meta;
        if (meta.schema > STORE_ENVELOPE_SCHEMA) {
            return { status: "newer", meta, reason: `envelope schema ${String(meta.schema)} is newer than ${String(STORE_ENVELOPE_SCHEMA)}` };
        }
        if (meta.version > version) {
            return { status: "newer", meta, reason: `data is v${String(meta.version)}, newer than this pack (v${String(version)})` };
        }
        if (meta.version < minVersion) {
            return { status: "unsupported", meta, reason: `data is v${String(meta.version)}; oldest readable is v${String(minVersion)}` };
        }
        const payload = readPayload(meta);
        if (payload.text === undefined) return { status: "corrupt", meta, reason: payload.reason };
        return { status: "ok", text: payload.text, meta, reason: undefined };
    }

    /**
     * Keep a bounded copy of whatever is stored, for inspection. One slot; newest wins.
     * @param {string} note
     */
    function quarantine(note) {
        try {
            const rawMeta = world.getDynamicProperty(metaKey);
            const m = readMeta();
            const fam = m.meta?.fam ?? "a";
            const head = world.getDynamicProperty(chunkKey(fam, 0));
            let keep = 20000;
            const build = () =>
                JSON.stringify({ note, meta: typeof rawMeta === "string" ? rawMeta.slice(0, 2000) : null, head: typeof head === "string" ? head.slice(0, keep) : null });
            let text = build();
            while (text.length > CIV_LIMITS.maxPropertyChars && keep > 0) {
                keep = Math.floor(keep / 2);
                text = build();
            }
            world.setDynamicProperty(quarantineKey, text);
            return true;
        } catch (_error) {
            return false;
        }
    }

    /**
     * Delete chunk keys of a family from index `from`, only touching keys that exist.
     * @param {string} fam @param {number} from @param {number} until
     */
    function sweep(fam, from, until) {
        let deleted = 0;
        for (let i = from; i < until; i += 1) {
            if (world.getDynamicProperty(chunkKey(fam, i)) !== undefined) {
                world.setDynamicProperty(chunkKey(fam, i), undefined);
                deleted += 1;
            }
        }
        return deleted;
    }

    /**
     * Save a text payload atomically (see the protocol at the top of the file).
     * @param {string} text
     * @param {{ version?: number }} [saveOptions]
     * @returns {SaveResult}
     */
    function saveText(text, saveOptions = {}) {
        const saveVersion = saveOptions.version ?? version;
        const bytes = utf8Length(text);
        // Size validation happens BEFORE any write.
        if (bytes > maxBytes) {
            return { ok: false, status: "too_large", reason: `payload is ${String(bytes)} bytes, over the ${String(maxBytes)} byte budget`, bytes, limit: maxBytes };
        }
        const parts = splitChunks(text, chunkChars);
        if (parts.length > maxChunks) {
            return { ok: false, status: "too_large", reason: `payload needs ${String(parts.length)} chunks, limit ${String(maxChunks)}`, bytes, limit: maxBytes };
        }
        if (saveVersion > version) {
            return { ok: false, status: "newer", reason: `cannot save v${String(saveVersion)} with a v${String(version)} store`, bytes };
        }

        const existing = readMeta();
        if (existing.state === "ok" && existing.meta !== undefined) {
            if (existing.meta.version > version || existing.meta.schema > STORE_ENVELOPE_SCHEMA) {
                // Never overwrite data written by a newer pack.
                return { ok: false, status: "newer", reason: `stored data is v${String(existing.meta.version)}, newer than v${String(version)}; left untouched`, bytes };
            }
        } else if (existing.state === "corrupt") {
            quarantine(existing.reason ?? "corrupt meta");
        }
        const old = existing.state === "ok" ? existing.meta : undefined;
        if (old !== undefined && readPayload(old).text === undefined) {
            quarantine("stored payload failed verification before overwrite");
        }

        const fam = old !== undefined && old.fam === "a" ? "b" : "a";
        const gen = (old?.gen ?? 0) + 1;
        const hash = fnv1a(text);
        /** @type {Envelope} */
        const meta = { format, version: saveVersion, schema: STORE_ENVELOPE_SCHEMA, hash, chunks: parts.length, bytes, fam, gen };

        try {
            for (let i = 0; i < parts.length; i += 1) {
                world.setDynamicProperty(chunkKey(fam, i), parts[i]);
            }
            const check = readPayload(meta);
            if (check.text === undefined) {
                try {
                    sweep(fam, 0, Math.max(maxChunks, parts.length));
                } catch (_error) {
                    // best effort; garbage is harmless
                }
                return { ok: false, status: "verify_failed", reason: `write verification failed: ${check.reason ?? "unknown"}`, bytes };
            }
            world.setDynamicProperty(metaKey, JSON.stringify(meta));
        } catch (error) {
            try {
                sweep(fam, 0, Math.max(maxChunks, parts.length));
            } catch (_error) {
                // a crashed process cannot clean up; the next save sweeps
            }
            return { ok: false, status: "write_failed", reason: `write failed: ${String(error)}`, bytes };
        }

        // Past the flip: failures here only leave garbage.
        try {
            if (old !== undefined) sweep(old.fam, 0, Math.max(maxChunks, old.chunks));
            sweep(fam, parts.length, maxChunks);
        } catch (_error) {
            // swept next time
        }
        return { ok: true, bytes, chunks: parts.length, hash, fam, gen };
    }

    /** Remove everything except the quarantine slot. Meta goes first, so a crash leaves only garbage. */
    function clear() {
        world.setDynamicProperty(metaKey, undefined);
        sweep("a", 0, maxChunks);
        sweep("b", 0, maxChunks);
    }

    /** Cheap summary of what is stored. */
    function info() {
        const m = readMeta();
        return { state: m.state, meta: m.meta, reason: m.reason };
    }

    /** Keys this store may own (for tests and diagnostics). */
    function ownedKeys() {
        const ids = typeof world.getDynamicPropertyIds === "function" ? world.getDynamicPropertyIds() : [];
        return ids.filter((k) => k.startsWith(`${prefix}:`));
    }

    return { prefix, format, version, metaKey, quarantineKey, maxBytes, chunkChars, maxChunks, chunkKey, loadText, saveText, quarantine, clear, info, ownedKeys, migrations };
}

export const PLAN_FORMAT = "civ-plan";
export const PLAN_VERSION = 1;
export const PLAN_PREFIX = "civ:plan";

/**
 * Plan store: JSON CivPlan <-> chunked properties.
 * `migrations[v]` upgrades a payload from version v to v+1 (register a function per step).
 * @param {WorldLike} world
 * @param {{ version?: number, minVersion?: number, maxBytes?: number, chunkChars?: number,
 *   migrations?: Record<number, (plan: any) => any>, prefix?: string, format?: string }} [options]
 */
export function createPlanStore(world, options = {}) {
    const migrations = options.migrations ?? {};
    const base = createChunkedStore(world, {
        prefix: options.prefix ?? PLAN_PREFIX,
        format: options.format ?? PLAN_FORMAT,
        version: options.version ?? PLAN_VERSION,
        minVersion: options.minVersion,
        maxBytes: options.maxBytes ?? CIV_LIMITS.maxPlanBytes,
        chunkChars: options.chunkChars,
        migrations,
    });

    /**
     * Load, verify (version, size, checksum) and migrate. Read-only unless `quarantine` is set,
     * in which case corrupt data is copied (bounded) to the quarantine slot (and left in place).
     * @param {{ quarantine?: boolean }} [loadOptions]
     * @returns {PlanLoad}
     */
    function loadPlan(loadOptions = {}) {
        const loaded = base.loadText();
        if (loaded.status !== "ok" || loaded.text === undefined || loaded.meta === undefined) {
            if (loaded.status === "corrupt" && loadOptions.quarantine === true) base.quarantine(loaded.reason ?? "corrupt");
            return { status: loaded.status, reason: loaded.reason, meta: loaded.meta };
        }
        let plan;
        try {
            plan = JSON.parse(loaded.text);
        } catch (error) {
            if (loadOptions.quarantine === true) base.quarantine("payload is not JSON");
            return { status: "corrupt", reason: `payload is not valid JSON (${String(error)})`, meta: loaded.meta };
        }
        const fromVersion = loaded.meta.version;
        let version = fromVersion;
        while (version < base.version) {
            const step = migrations[version];
            if (typeof step !== "function") {
                return { status: "unsupported", reason: `no migration from v${String(version)} to v${String(version + 1)}`, meta: loaded.meta };
            }
            try {
                plan = step(plan);
            } catch (error) {
                return { status: "unsupported", reason: `migration v${String(version)}->v${String(version + 1)} failed: ${String(error)}`, meta: loaded.meta };
            }
            version += 1;
            if (plan !== null && typeof plan === "object") plan.version = version;
        }
        return { status: "ok", plan, reason: undefined, migrated: version !== fromVersion, fromVersion, meta: loaded.meta };
    }

    /**
     * Serialise and save a plan. Refuses (without touching stored data) when too large,
     * when the stored data is newer, or when the write cannot be verified.
     * @param {any} plan
     * @returns {SaveResult}
     */
    function savePlan(plan) {
        let text;
        try {
            text = JSON.stringify(plan);
        } catch (error) {
            return { ok: false, status: "not_serialisable", reason: String(error), bytes: 0 };
        }
        if (typeof text !== "string") return { ok: false, status: "not_serialisable", reason: "plan is not JSON-serialisable", bytes: 0 };
        const planVersion = Number.isInteger(plan?.version) ? plan.version : base.version;
        return base.saveText(text, { version: planVersion });
    }

    /** Size a plan would take, without writing. @param {any} plan */
    function measurePlan(plan) {
        const text = JSON.stringify(plan);
        const bytes = utf8Length(text);
        return { bytes, chunks: splitChunks(text, base.chunkChars).length, fits: bytes <= base.maxBytes, limit: base.maxBytes };
    }

    return { ...base, loadPlan, savePlan, measurePlan };
}
