// Population representation tunables (WP4). Pure data: importing this file spawns nothing.
//
// Every number that limits how many physical entities may exist, how fast they may appear and how
// much work one reconcile may do lives here, so the whole budget can be read in one place.
// popSync refuses to apply any action unless its caller passes `enabled: true`; the pack default is off.

/** Dynamic property key of the small reconciliation cursor (population/cursor.js). */
export const POP_CURSOR_KEY = "civ_pop";
export const POP_CURSOR_VERSION = 1;
/** Hard ceiling on the persisted cursor, in UTF-8 bytes. */
export const POP_CURSOR_MAX_BYTES = 1024;
/** Most physical group ids the cursor may name. Above this the cursor is treated as corrupt. */
export const POP_CURSOR_MAX_PHYSICAL = 48;

/** Entity tags are `civpop:v1:<groupId>`. Any tag outside the `civpop:` namespace belongs to someone else. */
export const POP_TAG_NAMESPACE = "civpop";
export const POP_TAG_VERSION = 1;
export const POP_TAG_PREFIX = `${POP_TAG_NAMESPACE}:v${String(POP_TAG_VERSION)}:`;

/** Group kinds, in the stable order used by the group table. */
export const POP_KINDS = Object.freeze(/** @type {const} */ (["civ", "sol"]));

/** Entity type spawned for each kind. Soldiers are told apart from civilians by their group tag. */
export const POP_ENTITY_TYPES = Object.freeze({ civ: "minecraft:villager_v2", sol: "minecraft:villager_v2" });

/** Security levels that count as an active fight: nothing spawns or despawns there. */
export const POP_FIGHT_SECURITY = Object.freeze(["contested", "breached"]);

/** Chunk edge length in blocks (Bedrock chunks are 16 x 16 columns). */
export const CHUNK_SIZE = 16;

/**
 * How far from a district's physical home the adapter looks for representatives. Units belong to districts, so
 * they are observed whether or not a player is near: a duplicate or a due removal in a loaded chunk is never left
 * waiting for someone to walk past. Covers the spot grid (which reaches about 25 blocks) with room for wandering.
 */
export const POP_DISTRICT_OBSERVE_RADIUS = 48;

/**
 * Deterministic spawn spots: a grid inside a district's physical footprint. Soldiers sit one row band
 * further along z so the two kinds never share a spot. The physical layer still owns the ground check.
 */
export const POP_SPOTS = Object.freeze({
    inset: 4,
    spacing: 3,
    gridWidth: 4,
    soldierRowOffset: 20,
});

/**
 * @typedef {{
 *   enabled: boolean,
 *   groupSize: { civ: number, sol: number },
 *   physicalRadius: number,
 *   holdRadius: number,
 *   coarseRadius: number,
 *   maxPhysicalPerDistrict: number,
 *   maxPhysicalTotal: number,
 *   maxSpawnsPerTick: number,
 *   maxOpsPerTick: number,
 *   workBudget: number,
 * }} PopSyncConfig
 */

/**
 * The budget. Each cap is a ceiling for one reconcile, and `resolveConfig` (population/reconcile.js)
 * refuses values that would break the invariants (for example a hold radius smaller than the physical radius).
 * @type {PopSyncConfig}
 */
export const POP_SYNC_DEFAULTS = Object.freeze({
    /** Nothing is applied to the world unless the caller opts in. */
    enabled: false,
    /** People represented by one physical entity, per kind. */
    groupSize: Object.freeze({ civ: 10, sol: 5 }),
    /** Horizontal blocks from the nearest anchor within which an unbound group may be promoted. */
    physicalRadius: 48,
    /** A bound group stays physical out to this radius. The gap to physicalRadius is the hysteresis band. */
    holdRadius: 56,
    /** Groups inside this radius are coarse (a record marker only). Beyond it they are simulated. */
    coarseRadius: 128,
    /** Physical representatives allowed per district. */
    maxPhysicalPerDistrict: 8,
    /** Physical representatives allowed across the whole kingdom. */
    maxPhysicalTotal: 24,
    /** New representatives spawned per tick. */
    maxSpawnsPerTick: 2,
    /** Spawns, despawns and retags per tick, combined. */
    maxOpsPerTick: 6,
    /** Fixed ceiling on work units (entity visits, group evaluations, tag reads, comparisons) per reconcile. */
    workBudget: 6000,
});
