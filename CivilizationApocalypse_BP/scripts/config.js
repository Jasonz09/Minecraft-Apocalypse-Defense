export const PACK_NAME = "Civilization Apocalypse";

export const KINGDOM_SCHEMA_VERSION = 2;

/** Oldest saved schema this build can still read (everything older is refused, never reseeded blindly). */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

export const STORAGE_KEYS = {
    kingdom: "civ:kingdom",
    /** Unreadable or newer-than-supported payloads are copied here instead of being overwritten. */
    quarantine: "civ:kingdom-quarantine",
};

export const SCRIPT_EVENT_NAMESPACE = "civ";

/** Ordinary inspection commands. */
export const SCRIPT_EVENT_IDS = {
    status: "civ:status",
    district: "civ:district",
    territory: "civ:territory",
    policy: "civ:policy",
};

/**
 * Debug and demonstration commands live behind their own id prefix, so nothing here can
 * fire from ordinary gameplay and every one of them is a deliberate, typed invocation.
 */
export const DEBUG_EVENT_IDS = {
    help: "civ:debug_help",
    tick: "civ:debug_tick",
    scenarios: "civ:debug_scenarios",
    scenario: "civ:debug_scenario",
    build: "civ:debug_build",
};

/**
 * Physical-world commands (district generation). Separate from the debug namespace on purpose:
 * generating a district is a deliberate world edit, never a demo toggle.
 */
export const PHYSICAL_EVENT_IDS = {
    generate: "civ:district_generate",
    resume: "civ:district_resume",
    status: "civ:district_status",
    abort: "civ:district_abort",
    scout: "civ:district_scout",
    gateList: "civ:gate_list",
    gateOpen: "civ:gate_open",
    gateClose: "civ:gate_close",
    gateAuto: "civ:gate_auto",
    gateStatus: "civ:gate_status",
    gateTest: "civ:gate_test",
};

/**
 * One-command civilization generation (explicit invocation only, never automatic).
 * NOTE: a space-separated command like "civ generate" is not a valid id - ids are namespace:name with exactly ONE colon.
 */
export const CIV_EVENT_IDS = {
    generate: "civ:generate",
    plan: "civ:generate_plan",
    status: "civ:generate_status",
    abort: "civ:generate_abort",
    resume: "civ:generate_resume",
    devgate: "civ:generate_devgate",
    diag: "civ:generate_diag",
};

export const CIV = {
    /** Search radius in blocks (argument radius=N may raise it up to maxSearchRadius). */
    defaultSearchRadius: 220,
    maxSearchRadius: 400,
    /** World dynamic property that unlocks building districts 2-5 (development only). */
    devGateKey: "civ_devgate",
    /** Ticks between construction slices (1 = every tick). */
    sliceEveryTicks: 1,
    /** Ticks to wait for one ticking area to finish loading before it is removed and retried. */
    holdTimeoutTicks: 1200,
    /** Retries of a stalled tile (so 1 + holdRetries attempts) before it is marked stalled. */
    holdRetries: 1,
    /** Back-off (ticks) before retrying a hold whose identifier still exists; at most 3 times. */
    idBackoffTicks: 5,
    /** Whole-planning deadline in ticks (30 minutes). */
    planDeadlineTicks: 36000,
    /** No progress at all for this many ticks marks the session stalled and cancels it safely. */
    stallTicks: 3600,
    /** A chat heartbeat at least this often while planning. */
    heartbeatTicks: 200,
};

/**
 * The Horn of Hearthgate: the player-facing way to start the civilization build. A vanilla,
 * non-stackable item carrying a marker dynamic property, because a custom item needs an item
 * definition (and a texture) in the pack, and a stackable item cannot carry a marker at all.
 */
export const BEACON = {
    itemId: "minecraft:goat_horn",
    /** Identity is typeId plus this marker, exactly like the Commander's Ledger. */
    marker: "ca:beacon",
    nameTag: "Horn of Hearthgate",
    /** Ticks between action-bar guide refreshes for a player holding the horn. */
    guideTicks: 20,
    /** One press can arrive twice (the item is aimed at a block); ignore a repeat inside this window. */
    dupUseTicks: 10,
};

/**
 * Starter-world arming. The shipped game is a world template: the civilization is already
 * built, so the simulation must start from its published baseline instead of inheriting
 * whatever a development world accumulated while the city was being generated and tested.
 */
export const STARTER_EVENT_IDS = {
    status: "civ:starter_status",
    arm: "civ:starter_arm",
    verify: "civ:starter_verify",
};

export const STARTER = {
    /** Must match starter/template.json in the repository; stamped into the shipped kingdom. */
    templateId: "civapoc-starter",
    templateVersion: [1, 0, 0],
    /**
     * Keys that carry the shipped world's own truth: the five-district master plan (so future
     * expansion and rebuilding still works), the reset kingdom baseline, and the records of the
     * gates that physically exist in the city.
     */
    keepKeyPrefixes: ["civ:kingdom", "civ:plan", "civ_gatereg", "civ_gate_"],
    /**
     * Development-only state that must not reach a player. One-colon prefixes throughout: the plan
     * store keeps its quarantine copy under the plan prefix, and it rides along with the kept plan -
     * see "Known limitations" in docs/STARTER_WORLD.md.
     */
    wipeKeyPrefixes: ["civ:kingdom-quarantine", "civ:jobs", "civ:debug", "civ:demo-", "civ_devgate", "civ_ledger_dev"],
    /** Districts that must be physically complete before a world may be armed. Mirrors template.json. */
    builtRequired: ["district-1", "district-2", "district-3", "district-4", "district-5"],
};

export const PHYSICAL = {
    /** The only physical layout so far, and the district record it mirrors. */
    prototypeDistrict: "district-1",
    layoutId: "hearthgate",
    /** Blocks placed per job slice before yielding to the engine. */
    blocksPerSlice: 400,
    /** Cells inspected per job slice while scanning a site. */
    scanPerSlice: 1500,
    /** Footprint columns read per job slice during a terrain survey. */
    columnsPerSlice: 60,
    /** Progress is persisted (and reported) every this many placed blocks. */
    saveEvery: 1500,
    /** Consecutive slices to wait for an unloaded chunk before pausing the build. */
    unloadedRetrySlices: 40,
    tickingAreaId: "civ-district-build",
    /** Terrain preparation limits (blocks cut from / filled onto the platform plane). */
    maxCut: 4,
    maxFill: 4,
    capCut: 6,
    capFill: 6,
    /** Chunks are held this far beyond the footprint so trees overhanging it can be read. */
    readApron: 8,
    treeCap: 600,
    scoutDefaultRadius: 32,
    scoutMaxRadius: 48,
    scoutStep: 8,
    scoutResults: 3,
};

export const DEBUG_EVENT_PREFIX = "civ:debug";

export const STARTING_SIMULATION = {
    districtCount: 5,
    civilians: 400,
    soldiers: 150,
};

export const DISTRICT_NAMES = ["Hearthgate", "Ironquarry", "Whitethorn", "Saltmere", "Ashfall"];

/** Adjacent lands that an outside victory can open up. One per starting district. */
export const TERRITORY_NAMES = ["Ashford Reach", "Broken Kettle", "Coldmoor Fen", "Emberdown", "Glassmoor Rampart"];

export const DEFAULT_SEED = 20261017;

export const SIM = {
    /** One simulation step = one in-game hour. Minecraft runs 24000 ticks per day, so 1000 ticks per hour divides exactly. */
    stepTicks: 1000,
    stepsPerDay: 24,
    /** Hard ceiling on catch-up work after a long offline period, so a step loop can never run away. */
    maxCatchUpSteps: 24,
    /** Placement budget per build tick, to keep chunk work bounded. */
    maxBlocksPerStep: 64,
    battleLogLimit: 12,
    eventLogLimit: 24,
};

export const POLICY_MODES = ["balanced", "paused", "rapid"];

export const POLICY_DEFAULTS = {
    expansion: "balanced",
    /** A neighbour may never send away more than this share of its garrison. */
    reinforcementKeepFraction: 0.5,
    /** Integrity below which a district is treated as breached. */
    breachIntegrity: 40,
    /** Consecutive breached steps with no defender relief before a district can fall. */
    fallAfterSiegeSteps: 12,
};

export const DISTRICT_DEFAULTS = {
    capacityPerHome: 20,
    homesPerDistrict: 6,
    farmsPerDistrict: 4,
    storehousesPerDistrict: 3,
    barracksPerDistrict: 1,
    wallsPerDistrict: 1,
    frontGarrisonFraction: 0.8,
    startingFood: 240,
    startingMaterials: 180,
    startingSupplies: 120,
    foodDemandPerCivilian: 0.02,
    foodDemandPerSoldier: 0.05,
    foodPerFarmPerStep: 1.2,
    materialsPerStep: 0.4,
    suppliesPerStep: 0.3,
    /** Repair per builder per step while a wall project is complete. */
    integrityRepairPerStep: 0.6,
};

export const SECURITY_LEVELS = ["secure", "alert", "contested", "breached", "isolated", "lost"];

export const GATE_STATES = ["open", "sealed", "broken"];

export const TERRITORY_STATES = ["wild", "raided", "military", "kingdom"];

/**
 * Data-driven construction catalogue. `stages` is the number of staged increments;
 * `cost` is paid per stage, so progress is always tied to spent resources.
 */
export const PROJECT_TYPES = {
    walls: { stages: 6, cost: { materials: 18, food: 4, supplies: 2 }, buildersRequired: 6, permanent: true },
    gate: { stages: 3, cost: { materials: 8, food: 2, supplies: 1 }, buildersRequired: 3, permanent: true },
    road: { stages: 2, cost: { materials: 4, food: 1, supplies: 1 }, buildersRequired: 2, permanent: false },
    homes: { stages: 4, cost: { materials: 10, food: 2, supplies: 1 }, buildersRequired: 4, permanent: false },
    farms: { stages: 3, cost: { materials: 6, food: 0, supplies: 2 }, buildersRequired: 4, permanent: false },
    storehouse: { stages: 3, cost: { materials: 9, food: 1, supplies: 1 }, buildersRequired: 3, permanent: false },
    barracks: { stages: 4, cost: { materials: 12, food: 2, supplies: 3 }, buildersRequired: 4, permanent: false },
};

/** The standard build order for newly claimed land. */
export const EXPANSION_PROJECT_PLAN = ["walls", "gate", "farms", "homes", "storehouse", "barracks", "road"];

export const POPULATION_DEFAULTS = {
    /** Civilians added per complete home above current population, per step, when food and safety allow. */
    growthPerStepPerHome: 0.06,
    trainingQueueCapacity: 12,
    recruitsPerStepPerBarracks: 0.25,
    trainingFoodCostPerRecruit: 6,
    trainingSupplyCostPerRecruit: 3,
    /** A district in alert or worse cannot recruit. */
    recruitmentAllowedSecurity: ["secure"],
};
