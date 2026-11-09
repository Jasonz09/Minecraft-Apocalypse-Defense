import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { inflateRawSync, deflateRawSync } from "node:zlib";

/**
 * The small ZIP writer/reader the world template needs, written by hand for two reasons:
 *
 * 1. `Compress-Archive` on Windows writes entry names with BACKSLASHES
 *    (`behavior_packs\CivApocBP\scripts\main.js`). The ZIP application note requires '/', and
 *    Minecraft's importer is what has to read this file - so the packager cannot leave the
 *    separator to whatever the host shell happens to produce.
 * 2. Determinism. Timestamps are fixed and entries are sorted, so the same staged tree always
 *    produces the same bytes and a rebuilt template can be compared by hash.
 *
 * Only what the format demands is implemented: stored and deflated entries, a central directory
 * written after the data, and no directory entries, comments or data descriptors.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;
// 1980-01-01 00:00:00 - the epoch the format starts at, chosen so no entry carries a real time.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[i] = value;
    }
    return table;
})();

/** CRC-32 as the ZIP local header wants it: reflected, polynomial 0xEDB88320. */
export function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

/**
 * Walk a directory into sorted entries whose names use forward slashes, ZIP-style.
 * @param {string} root
 * @returns {{ name: string, absolute: string }[]}
 */
export function collectEntries(root) {
    /** @type {{ name: string, absolute: string }[]} */
    const out = [];
    const walk = (dir, prefix) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const absolute = join(dir, entry.name);
            const name = prefix + entry.name;
            if (entry.isDirectory()) walk(absolute, `${name}/`);
            else if (entry.isFile()) out.push({ name, absolute });
        }
    };
    walk(root, "");
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Write `root`'s contents (never the folder itself - a wrapping directory is un-importable).
 * @param {string} root
 * @param {string} targetFile
 * @returns {{ entries: number, bytes: number, sha256: string }}
 */
export function writeZip(root, targetFile) {
    const entries = collectEntries(root);
    const fd = openSync(targetFile, "w");
    let offset = 0;
    /** @type {{ name: Buffer, crc: number, compressed: number, size: number, method: number, localOffset: number }[]} */
    const central = [];
    try {
        for (const entry of entries) {
            const data = readFileSync(entry.absolute);
            const deflated = data.length === 0 ? data : deflateRawSync(data, { level: 9 });
            const method = deflated.length < data.length ? 8 : 0;
            const payload = method === 8 ? deflated : data;
            const name = Buffer.from(entry.name, "utf8");
            const crc = crc32(data);

            const local = Buffer.alloc(30);
            local.writeUInt32LE(LOCAL_SIGNATURE, 0);
            local.writeUInt16LE(VERSION_NEEDED, 4);
            local.writeUInt16LE(FLAG_UTF8, 6);
            local.writeUInt16LE(method, 8);
            local.writeUInt16LE(DOS_TIME, 10);
            local.writeUInt16LE(DOS_DATE, 12);
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(payload.length, 18);
            local.writeUInt32LE(data.length, 22);
            local.writeUInt16LE(name.length, 26);
            local.writeUInt16LE(0, 28);
            writeSync(fd, local);
            writeSync(fd, name);
            writeSync(fd, payload);

            central.push({ name, crc, compressed: payload.length, size: data.length, method, localOffset: offset });
            offset += local.length + name.length + payload.length;
        }

        const directoryStart = offset;
        for (const entry of central) {
            const record = Buffer.alloc(46);
            record.writeUInt32LE(CENTRAL_SIGNATURE, 0);
            record.writeUInt16LE(VERSION_NEEDED, 4);
            record.writeUInt16LE(VERSION_NEEDED, 6);
            record.writeUInt16LE(FLAG_UTF8, 8);
            record.writeUInt16LE(entry.method, 10);
            record.writeUInt16LE(DOS_TIME, 12);
            record.writeUInt16LE(DOS_DATE, 14);
            record.writeUInt32LE(entry.crc, 16);
            record.writeUInt32LE(entry.compressed, 20);
            record.writeUInt32LE(entry.size, 24);
            record.writeUInt16LE(entry.name.length, 28);
            record.writeUInt32LE(entry.localOffset, 42);
            writeSync(fd, record);
            writeSync(fd, entry.name);
            offset += record.length + entry.name.length;
        }

        const end = Buffer.alloc(22);
        end.writeUInt32LE(END_SIGNATURE, 0);
        end.writeUInt16LE(central.length, 8);
        end.writeUInt16LE(central.length, 10);
        end.writeUInt32LE(offset - directoryStart, 12);
        end.writeUInt32LE(directoryStart, 16);
        writeSync(fd, end);
    } finally {
        closeSync(fd);
    }

    const bytes = statSync(targetFile).size;
    return { entries: central.length, bytes, sha256: createHash("sha256").update(readFileSync(targetFile)).digest("hex") };
}

/**
 * Read a zip's central directory. Enough to audit a package offline: entry names, sizes and CRCs.
 * @param {Uint8Array|Buffer} bytes
 * @returns {{ name: string, method: number, size: number, crc: number, localOffset: number }[]}
 */
export function listZip(bytes) {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = view.length - 22; i >= 0 && end < 0; i -= 1) {
        if (view.readUInt32LE(i) === END_SIGNATURE) end = i;
    }
    if (end < 0) throw new Error("not a zip archive: no end-of-central-directory record");
    const count = view.readUInt16LE(end + 10);
    let cursor = view.readUInt32LE(end + 16);
    /** @type {{ name: string, method: number, size: number, crc: number, localOffset: number }[]} */
    const out = [];
    for (let i = 0; i < count; i += 1) {
        if (view.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error(`central directory is corrupt at entry ${String(i)}`);
        const method = view.readUInt16LE(cursor + 10);
        const crc = view.readUInt32LE(cursor + 16);
        const size = view.readUInt32LE(cursor + 24);
        const nameLength = view.readUInt16LE(cursor + 28);
        const extraLength = view.readUInt16LE(cursor + 30);
        const commentLength = view.readUInt16LE(cursor + 32);
        const localOffset = view.readUInt32LE(cursor + 42);
        out.push({ name: view.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"), method, size, crc, localOffset });
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return out;
}

/**
 * Uncompress one entry, exactly as a reader would.
 * @param {Uint8Array|Buffer} bytes
 * @param {{ name: string, method: number, size: number, crc: number, localOffset: number }} entry
 */
export function readZipEntry(bytes, entry) {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.localOffset;
    if (view.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new Error(`entry ${entry.name} has no local header`);
    const nameLength = view.readUInt16LE(at + 26);
    const extraLength = view.readUInt16LE(at + 28);
    const start = at + 30 + nameLength + extraLength;
    const raw = view.subarray(start, start + (entry.method === 8 ? view.readUInt32LE(at + 18) : entry.size));
    const data = entry.method === 8 ? inflateRawSync(raw) : raw;
    if (crc32(data) !== entry.crc) throw new Error(`entry ${entry.name} fails its CRC check`);
    return data;
}

/**
 * The path an entry name is allowed to mean, as parts relative to the extraction root.
 * Entry names are input data, so this is the guard: absolute paths, drive letters, `..` and empty
 * names are refused rather than clamped - an "export" that tried to write outside its own folder
 * would otherwise make this tool drop files anywhere on the machine.
 *
 * @param {string} rawName
 * @returns {string[]} the relative parts
 */
export function entryParts(rawName) {
    const name = rawName.replace(/\\/g, "/");
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
        throw new Error(`refusing to extract '${rawName}': that path is absolute`);
    }
    const parts = name.split("/").filter((part) => part.length > 0 && part !== ".");
    if (parts.some((part) => part === "..")) {
        throw new Error(`refusing to extract '${rawName}': that path leaves the package`);
    }
    if (parts.length === 0) {
        throw new Error(`refusing to extract '${rawName}': that is not a file name`);
    }
    return parts;
}

/**
 * Extract an archive we were handed (an exported `.mcworld`) into a directory we own.
 *
 * @param {string} zipFile
 * @param {string} targetDir
 * @returns {{ written: number, entries: number }}
 */
export function extractZip(zipFile, targetDir) {
    const bytes = readFileSync(zipFile);
    const entries = listZip(bytes);
    let written = 0;
    for (const entry of entries) {
        if (entry.name.endsWith("/")) continue; // directory entry, implied by the files under it
        const parts = entryParts(entry.name);
        const target = join(targetDir, ...parts);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readZipEntry(bytes, entry));
        written += 1;
    }
    return { written, entries: entries.length };
}
