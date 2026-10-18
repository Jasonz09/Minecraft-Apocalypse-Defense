/**
 * Minimal Bedrock `level.dat` reader/writer for offline validation only.
 *
 * Bedrock's level.dat is: int32 version, int32 payload length, then UNCOMPRESSED
 * little-endian NBT. Java Edition's is big-endian and gzip'd - this is not that.
 * Written by hand on purpose: no new dependency for one file format, and the tooling
 * must keep working when Minecraft is not installed.
 *
 * Tag types: 0 End, 1 Byte, 2 Short, 3 Int, 4 Long, 5 Float, 6 Double, 7 ByteArray,
 * 8 String, 9 List, 10 Compound, 11 IntArray, 12 LongArray.
 */

const TAG = {
    end: 0,
    byte: 1,
    short: 2,
    int: 3,
    long: 4,
    float: 5,
    double: 6,
    byteArray: 7,
    string: 8,
    list: 9,
    compound: 10,
    intArray: 11,
    longArray: 12,
};

/**
 * @param {DataView} view
 * @param {{ cursor: number }} cursor
 */
function readString(view, cursor) {
    const length = view.getUint16(cursor.value, true);
    cursor.value += 2;
    let text = "";
    for (let i = 0; i < length; i += 1) {
        text += String.fromCharCode(view.getUint8(cursor.value + i));
    }
    cursor.value += length;
    return text;
}

/** Scalar payloads. Arrays are decoded in readValue, where their length prefix is consumed. */
function readPayload(view, cursor, type) {
    switch (type) {
        case TAG.byte:
            return view.getInt8(cursor.value++);
        case TAG.short: {
            const value = view.getInt16(cursor.value, true);
            cursor.value += 2;
            return value;
        }
        case TAG.int: {
            const value = view.getInt32(cursor.value, true);
            cursor.value += 4;
            return value;
        }
        case TAG.long: {
            const low = view.getUint32(cursor.value, true);
            const high = view.getInt32(cursor.value + 4, true);
            cursor.value += 8;
            // Level heights, seeds and times fit comfortably; anything beyond 2^53 is flagged.
            const value = high * 4294967296 + low;
            if (!Number.isSafeInteger(value)) {
                throw new Error(`64-bit value ${String(value)} is outside JavaScript's safe integer range`);
            }
            return value;
        }
        case TAG.float: {
            const value = view.getFloat32(cursor.value, true);
            cursor.value += 4;
            return value;
        }
        case TAG.double: {
            const value = view.getFloat64(cursor.value, true);
            cursor.value += 8;
            return value;
        }
        case TAG.string:
            return readString(view, cursor);
        default:
            throw new Error(`unsupported tag type ${String(type)}`);
    }
}

function readValue(view, cursor, type) {
    if (type === TAG.list) {
        const elementType = view.getUint8(cursor.value++);
        const length = view.getInt32(cursor.value, true);
        cursor.value += 4;
        /** @type {any[]} */
        const items = [];
        for (let i = 0; i < length; i += 1) {
            items.push(readValue(view, cursor, elementType));
        }
        return items;
    }
    if (type === TAG.compound) {
        /** @type {Record<string, any>} */
        const out = {};
        for (;;) {
            const childType = view.getUint8(cursor.value++);
            if (childType === TAG.end) {
                return out;
            }
            const name = readString(view, cursor);
            out[name] = readValue(view, cursor, childType);
        }
    }
    // Arrays carry their own element count, which must be consumed before the payload.
    if (type === TAG.byteArray || type === TAG.intArray || type === TAG.longArray) {
        const count = view.getInt32(cursor.value, true);
        cursor.value += 4;
        const stride = type === TAG.byteArray ? 1 : type === TAG.intArray ? 4 : 8;
        if (count < 0 || cursor.value + count * stride > view.byteLength) {
            throw new Error(`array of ${String(count)} elements overruns the buffer`);
        }
        /** @type {number[]} */
        const out = [];
        for (let i = 0; i < count; i += 1) {
            if (type === TAG.byteArray) {
                out.push(view.getInt8(cursor.value));
            } else if (type === TAG.intArray) {
                out.push(view.getInt32(cursor.value, true));
            } else {
                const low = view.getUint32(cursor.value, true);
                const high = view.getInt32(cursor.value + 4, true);
                const value = high * 4294967296 + low;
                if (!Number.isSafeInteger(value)) {
                    throw new Error(`64-bit array element ${String(value)} is outside JavaScript's safe integer range`);
                }
                out.push(value);
            }
            cursor.value += stride;
        }
        return out;
    }
    return readPayload(view, cursor, type);
}

/**
 * Parse a level.dat buffer (or any Bedrock NBT blob) into plain JavaScript.
 * @param {Uint8Array} bytes
 * @returns {{ version: number, name: string, data: Record<string, any> }}
 */
export function readLevelDat(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
        throw new Error("level.dat is missing or too short to be a Bedrock level.dat");
    }
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        throw new Error("this level.dat is gzip-compressed: that is the Java Edition format, not Bedrock");
    }
    if (bytes[8] !== TAG.compound) {
        throw new Error(`level.dat payload should start with a compound tag, found tag ${String(bytes[8])}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = { version: view.getInt32(0, true), length: view.getInt32(4, true) };
    if (header.length <= 0 || header.length + 8 > bytes.length) {
        throw new Error(`level.dat declares ${String(header.length)} payload bytes but the file holds ${String(bytes.length - 8)}`);
    }
    const cursor = { value: 9 };
    const name = readString(view, cursor);
    const data = readValue(view, cursor, TAG.compound);
    return { version: header.version, name, data };
}

/**
 * Unwrap whatever `readLevelDat` returned into the `Level` compound.
 * @param {Record<string, any>} root
 */
export function levelSection(root) {
    return root?.Level ?? root ?? {};
}

/** @param {number} value */
function u8(value) {
    return [value & 0xff];
}

function encodeString(text) {
    // Little-endian length prefix, matching how Bedrock writes it; big-endian here makes every
    // string look longer than the buffer and desyncs the reader.
    const bytes = [];
    bytes.push(text.length & 0xff, (text.length >> 8) & 0xff);
    for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i) & 0xff);
    return bytes;
}

function encodeInt(value) {
    return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function encodeLong(value) {
    const low = value >>> 0;
    const high = Math.floor(value / 4294967296) | 0;
    return [...encodeInt(low), ...encodeInt(high)];
}

function encodeNamed(type, payload) {
    return [...u8(type), ...encodeString(""), ...payload];
}

function encodeValue(type, value) {
    switch (type) {
        case TAG.byte:
            return [value & 0xff];
        case TAG.short:
            return [value & 0xff, (value >> 8) & 0xff];
        case TAG.int:
            return encodeInt(value);
        case TAG.long:
            return encodeLong(value);
        case TAG.string:
            return encodeString(value);
        case TAG.compound: {
            /** @type {number[]} */
            const out = [];
            for (const [key, entry] of Object.entries(value)) {
                out.push(...u8(entry.type), ...encodeString(key), ...encodeValue(entry.type, entry.value));
            }
            out.push(TAG.end);
            return out;
        }
        case TAG.list: {
            const first = value.items[0];
            const out = first === undefined ? u8(TAG.end) : u8(first.type);
            out.push(...encodeInt(value.items.length));
            for (const item of value.items) out.push(...encodeValue(item.type, item.value));
            return out;
        }
        case TAG.intArray:
            return [...encodeInt(value.items.length), ...value.items.flatMap(encodeInt)];
        default:
            throw new Error(`writer does not support tag type ${String(type)}`);
    }
}

/** Builders, so tests can fabricate a real level.dat without Minecraft. */
export const nbt = {
    TAG,
    byte: (/** @type {number} */ value) => ({ type: TAG.byte, value }),
    short: (/** @type {number} */ value) => ({ type: TAG.short, value }),
    int: (/** @type {number} */ value) => ({ type: TAG.int, value }),
    long: (/** @type {number} */ value) => ({ type: TAG.long, value }),
    string: (/** @type {string} */ value) => ({ type: TAG.string, value }),
    compound: (/** @type {Record<string, any>} */ value) => ({ type: TAG.compound, value }),
    intArray: (/** @type {number[]} */ items) => ({ type: TAG.intArray, value: { items } }),
    list: (/** @type {any[]} */ items) => ({ type: TAG.list, value: { items } }),
};

/**
 * Serialise a compound into a level.dat buffer. Only used by tests and fixtures.
 * @param {Record<string, any>} compound entries as nbt.* builders
 * @param {{ name?: string, version?: number }} [options]
 */
export function writeLevelDat(compound, options = {}) {
    // encodeValue closes the root compound; a second End byte would be stray payload.
    const payload = [...u8(TAG.compound), ...encodeString(options.name ?? ""), ...encodeValue(TAG.compound, compound)];
    const header = [...encodeInt(options.version ?? 8), ...encodeInt(payload.length)];
    return new Uint8Array([...header, ...payload]);
}
