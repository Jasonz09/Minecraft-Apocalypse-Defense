// Offline fake of the Minecraft pieces the Commander's Ledger touches, plus kingdom fixtures.
//
// Nothing here imports @minecraft/server or @minecraft/server-ui. The Ledger runtime takes all of
// them as injected dependencies, so the harness supplies the same shapes:
//   - a tick clock and a `system` with run / runTimeout / currentTick / scriptEventReceive;
//   - a `world` with afterEvents.itemUse and afterEvents.playerLeave, and players that own an
//     inventory container, a dimension whose spawnItem is recorded, and a chat log;
//   - vanilla-like ItemStack (typeId, nameTag, lore, lockMode, keepOnDeath, dynamic properties);
//   - ActionFormData / MessageFormData whose show() answers from a scripted queue, including
//     "UserBusy" and "UserClosed" cancellations, and rejects for a player who has left.
// Forms are shown through a promise, exactly like the real API, so tests must `await` settle().

import { createInitialKingdom, createV2Kingdom, serializeKingdom } from "../../CivilizationApocalypse_BP/scripts/kingdom/state.js";

/* ------------------------------------------------------------------ *
 * Clock and system
 * ------------------------------------------------------------------ */

/**
 * @param {number} [start]
 */
export function createClock(start = 1000) {
    return { tick: start };
}

/**
 * A scheduler with the real call shapes. Work queued with run() or runTimeout() waits for advance().
 * @param {{ tick: number }} clock
 */
export function createSystem(clock) {
    /** @type {{ id: number, due: number, fn: () => void }[]} */
    let tasks = [];
    let nextId = 1;
    /** @type {{ callback: (event: any) => void, options: any }[]} */
    const scriptSubscribers = [];
    /** @type {{ id: number, error: unknown }[]} */
    const failures = [];

    function runDue() {
        let ran = 0;
        for (;;) {
            const due = tasks.filter((task) => task.due <= clock.tick).sort((left, right) => left.due - right.due || left.id - right.id);
            if (due.length === 0) {
                return ran;
            }
            const task = due[0];
            tasks = tasks.filter((entry) => entry.id !== task.id);
            ran += 1;
            try {
                task.fn();
            } catch (error) {
                failures.push({ id: task.id, error });
            }
        }
    }

    const system = {
        get currentTick() {
            return clock.tick;
        },
        run(/** @type {() => void} */ fn) {
            const id = nextId++;
            tasks.push({ id, due: clock.tick, fn });
            return id;
        },
        runTimeout(/** @type {() => void} */ fn, /** @type {number} */ ticks = 1) {
            const id = nextId++;
            tasks.push({ id, due: clock.tick + Math.max(0, Math.floor(ticks)), fn });
            return id;
        },
        afterEvents: {
            scriptEventReceive: {
                subscribe(/** @type {(event: any) => void} */ callback, /** @type {any} */ options) {
                    scriptSubscribers.push({ callback, options });
                    return callback;
                },
            },
        },
        /** Runs queued work due now, without moving the clock. */
        flush() {
            return runDue();
        },
        /**
         * Moves the clock forward one tick at a time, running due work after each tick, and lets
         * promise continuations settle.
         * @param {number} ticks
         */
        async advance(ticks) {
            for (let step = 0; step < ticks; step += 1) {
                clock.tick += 1;
                runDue();
                await settle();
            }
            runDue();
            await settle();
        },
        pendingCount() {
            return tasks.length;
        },
        scriptSubscribers,
        failures,
    };
    return system;
}

/** Lets pending promise continuations run. */
export async function settle() {
    for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/* ------------------------------------------------------------------ *
 * Items and containers
 * ------------------------------------------------------------------ */

/** The real ItemLockMode values. */
export const FakeItemLockMode = Object.freeze({ none: "none", inventory: "inventory", slot: "slot" });

export class FakeItemStack {
    /**
     * @param {string} typeId
     * @param {number} [amount]
     */
    constructor(typeId, amount = 1) {
        if (typeof typeId !== "string" || !/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(typeId)) {
            throw new Error(`FakeItemStack: '${String(typeId)}' is not a valid item type`);
        }
        if (!Number.isInteger(amount) || amount < 1 || amount > 64) {
            throw new RangeError(`FakeItemStack: amount ${String(amount)} is outside 1..64`);
        }
        this.typeId = typeId;
        this.amount = amount;
        /** @type {string | undefined} */
        this.nameTag = undefined;
        this.keepOnDeath = false;
        this.lockMode = FakeItemLockMode.none;
        /** @type {string[]} */
        this.lore = [];
        /** @type {Map<string, unknown>} */
        this.properties = new Map();
    }

    /** @param {(string)[] | undefined} lines */
    setLore(lines) {
        this.lore = [...(lines ?? [])];
    }

    getLore() {
        return [...this.lore];
    }

    /** @param {string} identifier */
    getDynamicProperty(identifier) {
        return this.properties.get(identifier);
    }

    /**
     * @param {string} identifier
     * @param {unknown} [value]
     */
    setDynamicProperty(identifier, value) {
        if (value === undefined) {
            this.properties.delete(identifier);
        } else {
            this.properties.set(identifier, value);
        }
    }

    getDynamicPropertyIds() {
        return [...this.properties.keys()];
    }

    clone() {
        const copy = new FakeItemStack(this.typeId, this.amount);
        copy.nameTag = this.nameTag;
        copy.keepOnDeath = this.keepOnDeath;
        copy.lockMode = this.lockMode;
        copy.lore = [...this.lore];
        copy.properties = new Map(this.properties);
        return copy;
    }
}

export class FakeContainer {
    /** @param {number} size */
    constructor(size) {
        this.size = size;
        /** @type {(FakeItemStack | undefined)[]} */
        this.slots = Array.from({ length: size }, () => undefined);
    }

    get emptySlotsCount() {
        return this.slots.filter((slot) => slot === undefined).length;
    }

    /** @param {number} slot */
    getItem(slot) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= this.size) {
            throw new RangeError(`slot ${String(slot)} is outside 0..${String(this.size - 1)}`);
        }
        return this.slots[slot]?.clone();
    }

    /**
     * @param {number} slot
     * @param {FakeItemStack | undefined} item
     */
    setItem(slot, item) {
        this.slots[slot] = item === undefined ? undefined : item.clone();
    }

    /**
     * Like Container.addItem: stores the stack in the first empty slot and returns undefined, or
     * returns the stack unchanged when the container is full.
     * @param {FakeItemStack} item
     */
    addItem(item) {
        const slot = this.slots.findIndex((entry) => entry === undefined);
        if (slot === -1) {
            return item;
        }
        this.slots[slot] = item.clone();
        return undefined;
    }
}

/* ------------------------------------------------------------------ *
 * World and players
 * ------------------------------------------------------------------ */

/**
 * @param {ReturnType<typeof createSystem>} system
 */
export function createWorld(system) {
    /** @type {((event: any) => void)[]} */
    const itemUseSubscribers = [];
    /** @type {((event: any) => void)[]} */
    const leaveSubscribers = [];
    /** @type {Map<string, any>} */
    const players = new Map();

    return {
        system,
        players,
        afterEvents: {
            itemUse: {
                subscribe(/** @type {(event: any) => void} */ callback) {
                    itemUseSubscribers.push(callback);
                    return callback;
                },
            },
            playerLeave: {
                subscribe(/** @type {(event: any) => void} */ callback) {
                    leaveSubscribers.push(callback);
                    return callback;
                },
            },
        },
        /** @param {any} event */
        emitItemUse(event) {
            for (const callback of itemUseSubscribers) {
                callback(event);
            }
        },
        /** @param {{ playerId: string, playerName: string }} event */
        emitPlayerLeave(event) {
            const player = players.get(event.playerId);
            if (player !== undefined) {
                player.left = true;
            }
            for (const callback of leaveSubscribers) {
                callback(event);
            }
        },
        subscriberCounts() {
            return { itemUse: itemUseSubscribers.length, playerLeave: leaveSubscribers.length };
        },
    };
}

/**
 * @param {ReturnType<typeof createWorld>} world
 * @param {{ name: string, id?: string, slots?: number, location?: { x: number, y: number, z: number } }} options
 */
export function createPlayer(world, options) {
    const id = options.id ?? `player-${options.name.toLowerCase()}`;
    const container = new FakeContainer(options.slots ?? 36);
    /** @type {{ stack: FakeItemStack, location: unknown, dimension: string }[]} */
    const spawned = [];
    /** @type {string[]} */
    const messages = [];
    /** @type {string[]} */
    const commands = [];
    const player = {
        id,
        name: options.name,
        typeId: "minecraft:player",
        left: false,
        location: options.location ?? { x: 0, y: 64, z: 0 },
        dimension: {
            id: "minecraft:overworld",
            /**
             * @param {FakeItemStack} stack
             * @param {unknown} location
             */
            spawnItem(stack, location) {
                if (player.left) {
                    throw new Error("the player has left");
                }
                spawned.push({ stack: stack.clone(), location, dimension: "minecraft:overworld" });
            },
        },
        /** @param {string} name */
        getComponent(name) {
            return name === "minecraft:inventory" ? { container } : undefined;
        },
        /** @param {string} text */
        sendMessage(text) {
            if (player.left) {
                throw new Error("the player has left");
            }
            messages.push(String(text));
        },
        /** @param {string} command */
        runCommand(command) {
            commands.push(command);
            return { successCount: 1 };
        },
        container,
        messages,
        commands,
        spawned,
    };
    world.players.set(id, player);
    return player;
}

/* ------------------------------------------------------------------ *
 * Forms
 * ------------------------------------------------------------------ */

/**
 * A form kit. `script` is consumed in order, one entry per show(). An entry is a response object,
 * or a function (shown) => response that picks from what is on screen. With the script empty the
 * default response applies (closed by the player).
 *
 * @param {{ tick?: () => number }} [options]
 */
export function createFormKit(options = {}) {
    void options;
    /** @type {any[]} */
    const script = [];
    /** @type {any[]} */
    const shown = [];
    /** @type {Set<string>} player ids whose show() rejects, as for a player who has left */
    const gone = new Set();
    /** @type {{ canceled: boolean, cancelationReason?: string }} */
    let defaultResponse = { canceled: true, cancelationReason: "UserClosed" };

    /**
     * @param {any} form
     * @param {any} player
     */
    function present(form, player) {
        if (gone.has(String(player?.id))) {
            return Promise.reject(new Error("the player has left"));
        }
        const record = {
            kind: form.kind,
            title: form.titleText,
            body: form.bodyText,
            buttons: [...form.buttonLabels],
            playerId: String(player?.id),
        };
        shown.push(record);
        const next = script.length > 0 ? script.shift() : defaultResponse;
        if (next === "pending") {
            // the player is looking at the form: the answer never comes during this test
            return new Promise(() => undefined);
        }
        const response = typeof next === "function" ? next(record) : next;
        return Promise.resolve(normalize(response, form));
    }

    /**
     * @param {any} response
     * @param {any} form
     */
    function normalize(response, form) {
        if (response === undefined) {
            return { canceled: true, cancelationReason: "UserClosed" };
        }
        if (response.canceled === true) {
            return { canceled: true, cancelationReason: response.cancelationReason ?? "UserClosed" };
        }
        const selection = Number(response.selection);
        if (!Number.isInteger(selection) || selection < 0 || selection >= form.buttonLabels.length) {
            throw new Error(`selection ${String(response.selection)} is not one of ${String(form.buttonLabels.length)} buttons`);
        }
        return { canceled: false, selection, cancelationReason: undefined };
    }

    class ActionFormData {
        constructor() {
            this.kind = "action";
            this.titleText = "";
            this.bodyText = "";
            /** @type {string[]} */
            this.buttonLabels = [];
        }

        /** @param {string} text */
        title(text) {
            this.titleText = text;
            return this;
        }

        /** @param {string} text */
        body(text) {
            this.bodyText = text;
            return this;
        }

        /** @param {string} text */
        button(text) {
            this.buttonLabels.push(text);
            return this;
        }

        /** @param {any} player */
        show(player) {
            return present(this, player);
        }
    }

    class MessageFormData {
        constructor() {
            this.kind = "message";
            this.titleText = "";
            this.bodyText = "";
            /** @type {string[]} */
            this.buttonLabels = ["", ""];
        }

        /** @param {string} text */
        title(text) {
            this.titleText = text;
            return this;
        }

        /** @param {string} text */
        body(text) {
            this.bodyText = text;
            return this;
        }

        /** @param {string} text */
        button1(text) {
            this.buttonLabels[0] = text;
            return this;
        }

        /** @param {string} text */
        button2(text) {
            this.buttonLabels[1] = text;
            return this;
        }

        /** @param {any} player */
        show(player) {
            return present(this, player);
        }
    }

    return {
        ui: { ActionFormData, MessageFormData },
        script,
        shown,
        gone,
        /** @param {{ canceled: boolean, cancelationReason?: string }} response */
        setDefault(response) {
            defaultResponse = response;
        },
        /** The label list of the most recent form. */
        lastButtons() {
            return shown[shown.length - 1]?.buttons ?? [];
        },
    };
}

/* ------------------------------------------------------------------ *
 * Services (the binding's wrappers, faked)
 * ------------------------------------------------------------------ */

/**
 * @param {{ sessionRunning?: boolean, busy?: string, abortResult?: any, selfTestOk?: boolean, unmanagedOk?: boolean }} [options]
 */
export function createServices(options = {}) {
    /** @type {{ name: string, args: unknown[] }[]} */
    const calls = [];
    const record = (/** @type {string} */ name, /** @type {unknown[]} */ ...args) => calls.push({ name, args });
    let running = options.sessionRunning === true;
    return {
        calls,
        setRunning(/** @type {boolean} */ value) {
            running = value;
        },
        gates: {
            retryNow(/** @type {string} */ gateId) {
                record("gates.retryNow", gateId);
            },
            pump() {
                record("gates.pump");
            },
            setUnmanagedMode(/** @type {string} */ gateId, /** @type {string} */ mode) {
                record("gates.setUnmanagedMode", gateId, mode);
                return options.unmanagedOk !== false;
            },
            startSelfTest(/** @type {string} */ gateId, /** @type {(report: { lines: string[] }) => void} */ done) {
                record("gates.startSelfTest", gateId);
                if (options.selfTestOk === false) {
                    return { ok: false, reason: "the self test is already running" };
                }
                done({ lines: [`Self test of ${gateId}: passed.`] });
                return { ok: true, reason: null };
            },
        },
        civ: {
            abort() {
                record("civ.abort");
                if (!running) {
                    return undefined;
                }
                running = false;
                return options.abortResult ?? { kind: "civ-generate", stopped: { saved: true, done: 4, total: 10, counts: { placed: 3 } } };
            },
            /** @param {any} result @param {string} resumeId */
            abortLines(result, resumeId) {
                record("civ.abortLines", resumeId);
                return [`Build stopped after ${String(result.stopped.done)} of ${String(result.stopped.total)} operations.`, `Continue with ${resumeId}.`];
            },
            /** @param {any} player @param {number} district */
            resume(player, district) {
                record("civ.resume", district);
                if (options.busy !== undefined) {
                    return { ok: false, reason: `a ${options.busy} job is running` };
                }
                void player;
                return { ok: true };
            },
        },
    };
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

/**
 * A kingdom store with the same load/save contract as kingdom/store.js: save refuses anything that
 * would not validate (serializeKingdom throws) and load returns a copy.
 *
 * @param {any} initial
 */
export function createKingdomStore(initial) {
    let current = initial === undefined ? undefined : JSON.parse(JSON.stringify(initial));
    let failSaves = false;
    /** @type {any[]} */
    const saves = [];
    return {
        saves,
        load() {
            if (current === undefined) {
                return { kingdom: undefined, status: "absent", reason: "no kingdom has been stored yet" };
            }
            return { kingdom: JSON.parse(JSON.stringify(current)), status: "ok", reason: undefined };
        },
        /** @param {any} kingdom */
        save(kingdom) {
            if (failSaves) {
                throw new Error("storage is full");
            }
            serializeKingdom(kingdom);
            current = JSON.parse(JSON.stringify(kingdom));
            saves.push(JSON.parse(JSON.stringify(kingdom)));
        },
        /** @param {boolean} value */
        setFailSaves(value) {
            failSaves = value;
        },
        peek() {
            return current === undefined ? undefined : JSON.parse(JSON.stringify(current));
        },
    };
}

/* ------------------------------------------------------------------ *
 * Kingdom fixtures
 * ------------------------------------------------------------------ */

/**
 * @param {any} kingdom
 * @param {string} id
 */
function district(kingdom, id) {
    const found = kingdom.districts.find((entry) => entry.id === id);
    if (found === undefined) {
        throw new Error(`fixture: no ${id}`);
    }
    return found;
}

/**
 * Named kingdom states the presenter tests walk through.
 * @returns {Record<string, () => any>}
 */
export function kingdomStates() {
    return {
        fresh: () => createInitialKingdom(),
        midSiege: () => {
            const kingdom = createInitialKingdom();
            const second = district(kingdom, "district-2");
            second.security = "breached";
            second.assault = 14;
            second.defensiveIntegrity = 35;
            second.siegeSteps = 3;
            second.fallback = { pullback: 0.2, position: "giving ground" };
            const third = district(kingdom, "district-3");
            third.security = "contested";
            third.assault = 6;
            kingdom.step = 37;
            kingdom.battles.push({
                atStep: 36,
                districtId: "district-2",
                districtName: second.name,
                assault: 14,
                standing: 9,
                integrityBefore: 52,
                integrityAfter: 35,
                integrityLoss: 17,
                attackerLosses: 4,
            });
            kingdom.log.push({ atStep: 36, text: `${second.name} is under attack.` });
            return kingdom;
        },
        lostDistrict: () => {
            const kingdom = createInitialKingdom();
            const third = district(kingdom, "district-3");
            third.security = "lost";
            third.defensiveIntegrity = 0;
            third.soldiers = 0;
            third.garrison = { front: 0, reserve: 0 };
            third.civilians = 0;
            third.refugees = 0;
            third.trainingQueue = 0;
            kingdom.log.push({ atStep: 0, text: `${third.name} has fallen.` });
            return kingdom;
        },
        pausedPolicy: () => {
            const kingdom = createInitialKingdom();
            kingdom.policy.expansion = "paused";
            kingdom.territory[0].status = "raided";
            kingdom.territory[0].unlockedAtStep = 2;
            return kingdom;
        },
        physicalGates: () => {
            const kingdom = createInitialKingdom();
            const first = district(kingdom, "district-1");
            const second = district(kingdom, "district-2");
            const third = district(kingdom, "district-3");
            first.gates[0].mode = "auto";
            first.gates[0].physical = { state: "open" };
            second.gates[0].mode = "forced_closed";
            second.gates[0].state = "sealed";
            second.gates[0].physical = { state: "closed", target: "open", blocked: "a villager stands in the gateway" };
            third.gates[0].state = "broken";
            third.gates[0].mode = "auto";
            third.gates[0].physical = { state: "open" };
            first.civ = {
                status: "building",
                seed: 7,
                startedStep: 1,
                anchor: { x: 10, z: 10 },
                centre: { x: 34, z: 34 },
                checksum: "abc123",
                stage: "walls",
                ops: 120,
                opsTotal: 480,
                placed: 60,
                skipped: 2,
            };
            first.physical = {
                status: "building",
                layout: "hearthgate",
                planHash: "abc123",
                placed: 60,
                total: 480,
                version: 1,
                origin: { x: 10, y: 64, z: 10 },
            };
            return kingdom;
        },
        many: () => createV2Kingdom({
            name: "Long Kingdom",
            districts: Array.from({ length: 14 }, (_unused, index) => ({
                id: `district-${String(index + 1)}`,
                name: `District ${String(index + 1)}`,
                civilians: 30,
                soldiers: 10,
            })),
        }),
        empty: () => createV2Kingdom({
            name: "Empty",
            districts: [{ id: "district-1", name: "Lonely", civilians: 0, soldiers: 0 }],
        }),
    };
}

/**
 * The live status a binding would pass in. `running` simulates an active civilization session.
 * @param {{ running?: boolean, resumable?: number, busy?: string, unmanaged?: any[], moving?: string[] }} [options]
 */
export function liveStatus(options = {}) {
    return {
        civ: {
            session: options.running === true ? { district: 1, status: "building", stage: "walls", pct: 42, done: 42, total: 100 } : undefined,
            busy: options.busy,
            resumable: options.resumable === undefined
                ? { index: undefined, reason: "There is no generated civilization to resume." }
                : { index: options.resumable, reason: undefined, candidates: [options.resumable] },
            devGate: false,
        },
        gates: {
            moving: options.moving ?? [],
            unmanaged: options.unmanaged ?? [],
        },
    };
}

/**
 * Everything a runtime test needs, wired together.
 *
 * @param {{ kingdom?: any, live?: any, services?: any }} [options]
 */
export function createLedgerHarness(options = {}) {
    const clock = createClock();
    const system = createSystem(clock);
    const world = createWorld(system);
    const forms = createFormKit();
    const store = createKingdomStore(options.kingdom);
    const services = options.services ?? createServices();
    const liveRef = { value: options.live };
    const deps = {
        world,
        system,
        ui: forms.ui,
        ItemStack: FakeItemStack,
        ItemLockMode: FakeItemLockMode,
        kingdomStore: store,
        services,
        live: () => liveRef.value,
    };
    return {
        clock,
        system,
        world,
        forms,
        store,
        services,
        liveRef,
        deps,
        /** @param {string} name @param {{ slots?: number, location?: any }} [extra]*/
        player(name, extra = {}) {
            return createPlayer(world, { name, ...extra });
        },
        /**
         * A use of the item by a player, as the engine reports it.
         * @param {any} player
         * @param {any} [stack]
         */
        useItem(player, stack = undefined) {
            const item = stack ?? findLedgerInInventory(player);
            world.emitItemUse({ source: player, itemStack: item });
        },
        advance: (/** @type {number} */ ticks) => system.advance(ticks),
        settle,
    };
}

/**
 * @param {any} player
 */
function findLedgerInInventory(player) {
    for (let slot = 0; slot < player.container.size; slot += 1) {
        const item = player.container.getItem(slot);
        if (item !== undefined && item.getDynamicProperty("ca:ledger") === true) {
            return item;
        }
    }
    return undefined;
}

/**
 * A marker stack as the Ledger item is built, for tests that place one directly.
 */
export function makeMarkerStack() {
    const stack = new FakeItemStack("minecraft:book", 1);
    stack.nameTag = "Commander's Ledger";
    stack.setDynamicProperty("ca:ledger", true);
    stack.lockMode = FakeItemLockMode.inventory;
    stack.keepOnDeath = true;
    return stack;
}

/**
 * A plain book with no marker: the item the Ledger must never react to.
 */
export function makePlainBook() {
    return new FakeItemStack("minecraft:book", 1);
}
