// Operation budgets and a cost model for the staged civilization build. Pure JS: no
// @minecraft/server, no Date, no randomness. All "time" is measured in operation counts
// (blocks written, cells/blocks read) and in slices/ticks derived from them.

/**
 * Hard caps shared by the planner, the stores and the builder.
 * Every value is a ceiling the runtime must respect; configuration may only lower them.
 */
export const CIV_LIMITS = Object.freeze({
    /** Largest planning radius (blocks) around the anchor. */
    maxSearchRadius: 220,
    /** Blocks written per job slice before the generator must yield. */
    maxBlocksPerSlice: 400,
    /** Cells / blocks read per job slice before the generator must yield. */
    maxReadsPerSlice: 1500,
    /** Largest persisted CivPlan (UTF-8 bytes, all chunks together). */
    maxPlanBytes: 120000,
    /** Largest persisted job queue (UTF-8 bytes); the design target is 8 KB. */
    maxJobBytes: 16000,
    /** Largest in-memory height/field grid (bytes). */
    maxFieldBytes: 1500000,
    /** Characters per dynamic property chunk (engine limit is 32767). */
    maxPropertyChars: 30000,
    /** Job slices the engine is assumed to grant per tick (conservative). */
    slicesPerTick: 1,
    /** Game ticks per second. */
    ticksPerSecond: 20,
});

/** Bytes per field-grid column: Int16 ground height + 1 byte kind/flags. */
export const FIELD_BYTES_PER_COLUMN = 3;

/**
 * Default summary of the planned civilization (five districts, ~190k enclosed columns).
 * Every field may be overridden by a real plan summary.
 */
export const DEFAULT_SUMMARY = Object.freeze({
    searchRadius: 220,
    area: 190000,
    /** Fraction of columns carrying trees/plants that must be cleared. */
    vegetationFraction: 0.12,
    blocksPerVegetationColumn: 4,
    wallLength: 3200,
    wallThickness: 3,
    wallHeight: 7,
    wallFoundationDepth: 2,
    gateCount: 15,
    gateWidth: 5,
    gateHeight: 8,
    roadLength: 5200,
    roadWidth: 3,
    /** Surface block plus stairs / fill / bridge deck per road column. */
    roadBlocksPerColumn: 1.5,
    lotCount: 420,
    lotPadColumns: 196,
    buildingBlocksPerLot: 450,
    dressingBlocksPerLot: 25,
    /** One lamp/tree/fence group every N road blocks. */
    dressingRoadInterval: 16,
    dressingBlocksPerRoadGroup: 4,
    /** Typical job-queue element count (for memory estimates). */
    jobElements: 600,
    /** Typical persisted plan size. */
    planBytes: 60000,
});

/**
 * @typedef {typeof DEFAULT_SUMMARY} CostSummary
 * @typedef {{ blocks: number, reads: number, slices: number }} StageCost
 * @typedef {{ stages: Record<string, StageCost>, totalBlocks: number, totalReads: number,
 *   blockSlices: number, readSlices: number, totalSlices: number, ticks: number, seconds: number,
 *   minutes: number, memory: { fieldBytes: number, planBytes: number, jobBytes: number, totalBytes: number },
 *   warnings: string[] }} CostEstimate
 */

/** @param {number} n */
function ceilInt(n) {
    return Math.ceil(n - 1e-9);
}

/**
 * Estimate block counts, read counts, slices and memory for a plan summary.
 * @param {Partial<CostSummary>} [summary]
 * @param {{ maxBlocksPerSlice?: number, maxReadsPerSlice?: number, slicesPerTick?: number, ticksPerSecond?: number }} [options]
 * @returns {CostEstimate}
 */
export function estimateCost(summary = {}, options = {}) {
    const s = { ...DEFAULT_SUMMARY, ...summary };
    const blocksPerSlice = Math.max(1, Math.min(options.maxBlocksPerSlice ?? CIV_LIMITS.maxBlocksPerSlice, CIV_LIMITS.maxBlocksPerSlice));
    const readsPerSlice = Math.max(1, Math.min(options.maxReadsPerSlice ?? CIV_LIMITS.maxReadsPerSlice, CIV_LIMITS.maxReadsPerSlice));
    const slicesPerTick = Math.max(1, options.slicesPerTick ?? CIV_LIMITS.slicesPerTick);
    const tps = options.ticksPerSecond ?? CIV_LIMITS.ticksPerSecond;

    /** @type {Record<string, { blocks: number, reads: number }>} */
    const raw = {
        clear: { blocks: ceilInt(s.area * s.vegetationFraction * s.blocksPerVegetationColumn), reads: s.area },
        walls: {
            blocks: ceilInt(s.wallLength * s.wallThickness * (s.wallHeight + s.wallFoundationDepth)),
            reads: ceilInt(s.wallLength * s.wallThickness),
        },
        gates: {
            blocks: ceilInt(s.gateCount * (s.gateWidth + 4) * s.wallThickness * s.gateHeight),
            reads: ceilInt(s.gateCount * (s.gateWidth + 4) * s.wallThickness),
        },
        roads: {
            blocks: ceilInt(s.roadLength * s.roadWidth * s.roadBlocksPerColumn),
            reads: ceilInt(s.roadLength * s.roadWidth),
        },
        lots: {
            blocks: ceilInt(s.lotCount * (s.lotPadColumns + s.buildingBlocksPerLot)),
            reads: ceilInt(s.lotCount * s.lotPadColumns),
        },
        dressing: {
            blocks: ceilInt(s.lotCount * s.dressingBlocksPerLot + (s.roadLength / s.dressingRoadInterval) * s.dressingBlocksPerRoadGroup),
            reads: ceilInt(s.lotCount * 4 + s.roadLength / s.dressingRoadInterval),
        },
    };

    /** @type {Record<string, StageCost>} */
    const stages = {};
    let totalBlocks = 0;
    let totalReads = 0;
    let blockSlices = 0;
    let readSlices = 0;
    let totalSlices = 0;
    for (const [name, c] of Object.entries(raw)) {
        // A slice is limited by BOTH caps; the stage needs as many slices as the tighter one demands.
        const slices = Math.max(ceilInt(c.blocks / blocksPerSlice), ceilInt(c.reads / readsPerSlice));
        stages[name] = { blocks: c.blocks, reads: c.reads, slices };
        totalBlocks += c.blocks;
        totalReads += c.reads;
        blockSlices += ceilInt(c.blocks / blocksPerSlice);
        readSlices += ceilInt(c.reads / readsPerSlice);
        totalSlices += slices;
    }
    const ticks = ceilInt(totalSlices / slicesPerTick);
    const seconds = ticks / tps;

    const side = 2 * s.searchRadius + 1;
    const fieldBytes = side * side * FIELD_BYTES_PER_COLUMN;
    const jobBytes = ceilInt(s.jobElements * 6.5) + 300;
    const memory = { fieldBytes, planBytes: s.planBytes, jobBytes, totalBytes: fieldBytes + s.planBytes + jobBytes };

    /** @type {string[]} */
    const warnings = [];
    if (s.searchRadius > CIV_LIMITS.maxSearchRadius) warnings.push(`search radius ${String(s.searchRadius)} exceeds ${String(CIV_LIMITS.maxSearchRadius)}`);
    if (fieldBytes > CIV_LIMITS.maxFieldBytes) warnings.push(`field grid ${String(fieldBytes)} B exceeds ${String(CIV_LIMITS.maxFieldBytes)}`);
    if (s.planBytes > CIV_LIMITS.maxPlanBytes) warnings.push(`plan ${String(s.planBytes)} B exceeds ${String(CIV_LIMITS.maxPlanBytes)}`);
    if (jobBytes > CIV_LIMITS.maxJobBytes) warnings.push(`job queue ${String(jobBytes)} B exceeds ${String(CIV_LIMITS.maxJobBytes)}`);

    return { stages, totalBlocks, totalReads, blockSlices, readSlices, totalSlices, ticks, seconds, minutes: seconds / 60, memory, warnings };
}

/**
 * Per-slice (and per-tick) operation tracker. A "slice" is one stretch of work between two
 * yields; the budget is counted in operations, never wall-clock time.
 */
export class Budget {
    /**
     * @param {{ maxOps?: number, maxReads?: number, slicesPerTick?: number }} [options]
     */
    constructor(options = {}) {
        this.maxOps = Math.max(1, Math.min(options.maxOps ?? CIV_LIMITS.maxBlocksPerSlice, CIV_LIMITS.maxBlocksPerSlice));
        this.maxReads = Math.max(1, Math.min(options.maxReads ?? CIV_LIMITS.maxReadsPerSlice, CIV_LIMITS.maxReadsPerSlice));
        this.slicesPerTick = Math.max(1, options.slicesPerTick ?? CIV_LIMITS.slicesPerTick);
        this.ops = 0;
        this.reads = 0;
        this.slices = 0;
        this.sliceInTick = 0;
        this.totalOps = 0;
        this.totalReads = 0;
        this.ticks = 0;
    }

    /**
     * Whether `ops` writes and `reads` reads still fit in the current slice. A single request
     * larger than an empty slice can never fit (callers must split it).
     * @param {number} ops
     * @param {number} [reads]
     */
    canSpend(ops, reads = 0) {
        return this.ops + ops <= this.maxOps && this.reads + reads <= this.maxReads;
    }

    /**
     * Record spending; throws if it would break a cap (a builder bug, never silently clamped).
     * @param {number} ops
     * @param {number} [reads]
     */
    spend(ops, reads = 0) {
        if (!this.canSpend(ops, reads)) {
            throw new RangeError(`slice budget exceeded: ${String(this.ops + ops)}/${String(this.maxOps)} ops, ${String(this.reads + reads)}/${String(this.maxReads)} reads`);
        }
        this.ops += ops;
        this.reads += reads;
        this.totalOps += ops;
        this.totalReads += reads;
    }

    /** Writes still available in this slice. */
    opsRemaining() {
        return this.maxOps - this.ops;
    }

    /** Reads still available in this slice. */
    readsRemaining() {
        return this.maxReads - this.reads;
    }

    /** Combined load 0..1: the fuller of the two budgets. */
    load() {
        return Math.max(this.ops / this.maxOps, this.reads / this.maxReads);
    }

    /**
     * Yield heuristic: true once either cap is full (>= `threshold`), or the two partial loads
     * together reach 1.5x the threshold (mixed read/write slices are costlier than either alone).
     * @param {number} [threshold]
     */
    yieldNow(threshold = 1) {
        return this.load() >= threshold || this.ops / this.maxOps + this.reads / this.maxReads >= threshold * 1.5;
    }

    /** Close the slice: counters reset, slice/tick bookkeeping advances. */
    endSlice() {
        this.ops = 0;
        this.reads = 0;
        this.slices += 1;
        this.sliceInTick += 1;
        if (this.sliceInTick >= this.slicesPerTick) {
            this.sliceInTick = 0;
            this.ticks += 1;
        }
    }
}

/**
 * Split items into slices whose summed cost never exceeds the caps.
 * Items are atomic; an item that alone exceeds a cap throws RangeError.
 * @template T
 * @param {readonly T[]} items
 * @param {{ maxOps?: number, maxReads?: number, opsOf?: (item: T) => number, readsOf?: (item: T) => number }} [options]
 * @returns {T[][]}
 */
export function chunkOps(items, options = {}) {
    const maxOps = Math.min(options.maxOps ?? CIV_LIMITS.maxBlocksPerSlice, CIV_LIMITS.maxBlocksPerSlice);
    const maxReads = Math.min(options.maxReads ?? CIV_LIMITS.maxReadsPerSlice, CIV_LIMITS.maxReadsPerSlice);
    const opsOf = options.opsOf ?? (() => 1);
    const readsOf = options.readsOf ?? (() => 0);
    /** @type {T[][]} */
    const slices = [];
    /** @type {T[]} */
    let current = [];
    let ops = 0;
    let reads = 0;
    for (const item of items) {
        const o = opsOf(item);
        const r = readsOf(item);
        if (o > maxOps || r > maxReads) {
            throw new RangeError(`single item costs ${String(o)} ops / ${String(r)} reads, above the ${String(maxOps)}/${String(maxReads)} slice caps`);
        }
        if (current.length > 0 && (ops + o > maxOps || reads + r > maxReads)) {
            slices.push(current);
            current = [];
            ops = 0;
            reads = 0;
        }
        current.push(item);
        ops += o;
        reads += r;
    }
    if (current.length > 0) slices.push(current);
    return slices;
}

/**
 * Split a counted range [0, total) into [from, to) slices of at most `maxOps` each.
 * @param {number} total
 * @param {number} [maxOps]
 * @returns {Array<[number, number]>}
 */
export function chunkRange(total, maxOps = CIV_LIMITS.maxBlocksPerSlice) {
    const cap = Math.max(1, Math.min(maxOps, CIV_LIMITS.maxBlocksPerSlice));
    /** @type {Array<[number, number]>} */
    const out = [];
    for (let from = 0; from < total; from += cap) {
        out.push([from, Math.min(total, from + cap)]);
    }
    return out;
}
