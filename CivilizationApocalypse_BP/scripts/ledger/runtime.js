import { LEDGER_EVENT_IDS, LEDGER_NAMESPACE } from "./ids.js";
import { findLedgerSlot, isLedgerStack, makeLedgerStack } from "./item.js";
import { actionSpec, navigateAction, runAction } from "./actions.js";
import { buildConfirmModel, buildMenu, buildResultModel } from "./menus.js";
import { currentFrame, goBack, goHome, newStack, openFrame, replaceFrame } from "./navigation.js";
import { enabledButton, menuModel } from "./model.js";
import { line, sanitize } from "./text.js";

/**
 * The Commander's Ledger at runtime: item use, the navigation stack per player, forms, confirmation,
 * results, busy retries, and the recovery command.
 *
 * This file imports NO Minecraft module. Everything the Ledger touches comes in through `deps`, so the
 * whole flow runs offline against the fake in dev/lib/ledgerharness.mjs. The binding file (written by
 * the integrator, see the report) imports the real `world`, `system`, `ui`, `ItemStack` and
 * `ItemLockMode` and passes them here.
 *
 * The development gate (ledger/devgate.js) is read live through `deps.gateOpen`. While it is off, a use of the
 * item and the recovery command both refuse with GATE_OFF_LINES and grant nothing, even if the handlers were
 * registered earlier in the session. An absent `gateOpen` means open (the binding always supplies one).
 *
 * Use-event rules:
 *  - the item is the marker stack (ledger/item.js); nothing else opens the Ledger;
 *  - a use is ignored for LEDGER_RUNTIME.debounceTicks after the last accepted use by the same player
 *    (a book can fire itemUse while aimed at a block, so one press can arrive twice);
 *  - at most one open form per player: a second use while one is open, or while a busy retry is
 *    pending, does nothing;
 *  - the first form is shown from system.run, never inside the event callback (restricted mode);
 *  - a form answered "UserBusy" (chat or another UI is open) is retried every busyRetryTicks, for at
 *    most busyWindowTicks after the first busy answer, then the player is told once;
 *  - show() is always called inside try/catch and its promise is handled, so a player who has left
 *    cannot throw into the event loop; playerLeave drops the player's state.
 *
 * @typedef {import("./navigation.js").Frame} Frame
 * @typedef {import("./model.js").MenuModel} MenuModel
 * @typedef {import("./model.js").Button} Button
 * @typedef {{
 *   world: { afterEvents: { itemUse: { subscribe: (callback: (event: any) => void) => unknown }, playerLeave?: { subscribe: (callback: (event: any) => void) => unknown } } },
 *   system: {
 *     currentTick: number,
 *     run: (callback: () => void) => unknown,
 *     runTimeout: (callback: () => void, ticks?: number) => unknown,
 *     afterEvents: { scriptEventReceive: { subscribe: (callback: (event: any) => void, options: { namespaces: string[] }) => unknown } },
 *   },
 *   ui: { ActionFormData: new () => any, MessageFormData: new () => any },
 *   ItemStack: new (typeId: string, amount?: number) => any,
 *   ItemLockMode: { inventory: string },
 *   kingdomStore: { load: () => { kingdom?: any, reason?: string }, save: (kingdom: any) => void },
 *   services?: any,
 *   live?: () => any,
 *   gateOpen?: () => boolean,
 * }} LedgerDeps
 * @typedef {{ player: any, key: string, stack: Frame[], current: MenuModel | undefined, notice: string[] | undefined, busySince: number | undefined }} Session
 */

export const LEDGER_RUNTIME = Object.freeze({
    /** Ticks after an accepted use during which a second use by the same player is ignored. */
    debounceTicks: 8,
    /** Ticks between attempts while the player has another UI open. */
    busyRetryTicks: 15,
    /** Ticks after the first busy answer before the Ledger gives up for this press. */
    busyWindowTicks: 100,
});

const PLAYER_TYPE = "minecraft:player";

/** What a player is told when the development gate is off (the item use and the recovery command). */
export const GATE_OFF_LINES = Object.freeze([
    "The Commander's Ledger is switched off in this build: it is still in development.",
    "A developer turns it on with: scriptevent civ:ledger_devgate on",
]);

/**
 * @param {unknown} entity
 * @returns {boolean}
 */
function isPlayer(entity) {
    if (entity === null || typeof entity !== "object") {
        return false;
    }
    const candidate = /** @type {{ typeId?: unknown, sendMessage?: unknown }} */ (entity);
    return candidate.typeId === PLAYER_TYPE && typeof candidate.sendMessage === "function";
}

/**
 * @param {any} player
 * @returns {string}
 */
function keyOf(player) {
    return String(player.id ?? player.name);
}

/**
 * Plain chat text for the player. A player who has already left is not an error.
 * @param {any} player
 * @param {string[]} lines
 */
function tell(player, lines) {
    try {
        player.sendMessage(lines.map((text) => sanitize(text)).join("\n"));
    } catch (_error) {
        // the player has left or cannot receive chat right now
    }
}

/**
 * @param {LedgerDeps} deps
 */
export function createLedgerUi(deps) {
    const { world, system, kingdomStore } = deps;
    /** @type {Map<string, Session>} the open session per player id (one form per player) */
    const sessions = new Map();
    /** @type {Map<string, number>} tick of the last accepted use per player id */
    const lastAccepted = new Map();
    let registered = false;

    /** @returns {number} */
    function now() {
        return Number(system.currentTick);
    }

    /** @returns {{ kingdom: any, reason: string | undefined }} */
    function readKingdom() {
        try {
            const loaded = kingdomStore.load();
            if (loaded.kingdom !== undefined) {
                return { kingdom: loaded.kingdom, reason: undefined };
            }
            return { kingdom: undefined, reason: String(loaded.reason ?? "no kingdom is saved") };
        } catch (error) {
            return { kingdom: undefined, reason: String(error) };
        }
    }

    /**
     * The development gate, read on every use. A gate that cannot be read is closed.
     * @returns {boolean}
     */
    function gateIsOpen() {
        if (deps.gateOpen === undefined) {
            return true;
        }
        try {
            return deps.gateOpen() === true;
        } catch (_error) {
            return false;
        }
    }

    /** @returns {any} */
    function liveStatus() {
        try {
            return deps.live === undefined ? undefined : deps.live();
        } catch (_error) {
            return undefined;
        }
    }

    /** @param {Session} session */
    function isCurrent(session) {
        return sessions.get(session.key) === session;
    }

    /** @param {Session} session */
    function finish(session) {
        if (isCurrent(session)) {
            sessions.delete(session.key);
        }
    }

    /**
     * @param {MenuModel} model
     * @returns {any}
     */
    function buildForm(model) {
        const body = model.lines.join("\n");
        if (model.kind === "confirm") {
            const form = new deps.ui.MessageFormData();
            form.title(model.title).body(body).button1(buttonText(model.buttons[0])).button2(buttonText(model.buttons[1]));
            return form;
        }
        const form = new deps.ui.ActionFormData();
        form.title(model.title).body(body);
        for (const button of model.buttons) {
            form.button(buttonText(button));
        }
        return form;
    }

    /** @param {Button | undefined} button */
    function buttonText(button) {
        if (button === undefined) {
            return "Back";
        }
        return button.enabled ? button.label : `${button.label} (unavailable)`;
    }

    /**
     * Shows one model and handles its answer. Show is deferred by the caller; here it is guarded.
     * @param {Session} session
     * @param {MenuModel} model
     */
    function showModel(session, model) {
        if (!isCurrent(session)) {
            return;
        }
        session.current = model;
        let pending;
        try {
            pending = buildForm(model).show(session.player);
        } catch (_error) {
            finish(session);
            return;
        }
        Promise.resolve(pending).then(
            (response) => onResponse(session, response),
            () => finish(session),
        );
    }

    /**
     * @param {Session} session
     */
    function render(session) {
        if (!isCurrent(session)) {
            return;
        }
        const loaded = readKingdom();
        if (loaded.kingdom === undefined) {
            showModel(
                session,
                menuModel({
                    id: "unavailable",
                    title: "Commander's Ledger",
                    lines: [`No kingdom can be read: ${String(loaded.reason)}`],
                    buttons: [enabledButton("close", "Close", { id: "nav.close" })],
                    back: false,
                }),
            );
            return;
        }
        const model = buildMenu(currentFrame(session.stack), loaded.kingdom, liveStatus());
        if (session.notice !== undefined) {
            const notice = session.notice;
            session.notice = undefined;
            showModel(session, { ...model, lines: [...notice, ...model.lines] });
            return;
        }
        showModel(session, model);
    }

    /**
     * @param {Session} session
     * @param {unknown} response
     */
    function onResponse(session, response) {
        try {
            if (!isCurrent(session)) {
                return;
            }
            const answer = /** @type {{ canceled?: boolean, cancelationReason?: string, selection?: number } | undefined} */ (response);
            if (answer === undefined || answer === null) {
                finish(session);
                return;
            }
            if (answer.canceled === true) {
                if (answer.cancelationReason === "UserBusy") {
                    retry(session);
                    return;
                }
                finish(session);
                return;
            }
            session.busySince = undefined;
            const button = session.current?.buttons[Number(answer.selection)];
            if (button === undefined) {
                finish(session);
                return;
            }
            choose(session, button);
        } catch (_error) {
            finish(session);
        }
    }

    /**
     * The player has another UI open: try again shortly, for a bounded window.
     * @param {Session} session
     */
    function retry(session) {
        const tick = now();
        if (session.busySince === undefined) {
            session.busySince = tick;
        }
        if (tick - session.busySince >= LEDGER_RUNTIME.busyWindowTicks) {
            tell(session.player, ["The Ledger did not open: another menu stayed open. Close it, then use the Ledger again."]);
            finish(session);
            return;
        }
        system.runTimeout(() => {
            if (isCurrent(session) && session.current !== undefined) {
                showModel(session, session.current);
            }
        }, LEDGER_RUNTIME.busyRetryTicks);
    }

    /**
     * @param {Session} session
     * @param {Button} button
     */
    function choose(session, button) {
        if (!button.enabled) {
            session.notice = [line(`Unavailable: ${button.reason ?? "not available"}`)];
            render(session);
            return;
        }
        const action = button.action;
        if (action === undefined) {
            render(session);
            return;
        }
        if (action.id.startsWith("nav.")) {
            navigate(session, action.id, action.params ?? {});
            return;
        }
        if (action.confirmed === true) {
            execute(session, action.id, action.params ?? {});
            return;
        }
        // A world change is never run straight from a menu: the confirm menu comes first.
        const loaded = readKingdom();
        if (loaded.kingdom === undefined) {
            render(session);
            return;
        }
        showModel(session, buildConfirmModel(action.id, action.params ?? {}, loaded.kingdom, liveStatus()));
    }

    /**
     * @param {Session} session
     * @param {string} id
     * @param {Record<string, unknown>} params
     */
    function navigate(session, id, params) {
        const step = navigateAction(id, params);
        if (step.op === "close") {
            finish(session);
            return;
        }
        if (step.op === "open" && step.frame !== undefined) {
            openFrame(session.stack, step.frame);
        } else if (step.op === "replace" && step.frame !== undefined) {
            replaceFrame(session.stack, step.frame);
        } else if (step.op === "back") {
            goBack(session.stack);
        } else if (step.op === "home") {
            goHome(session.stack);
        }
        render(session);
    }

    /**
     * Runs a confirmed action on a private copy of the kingdom, saves it only when the action succeeded,
     * then runs its physical follow-up. The result is shown as a result model.
     *
     * @param {Session} session
     * @param {string} id
     * @param {Record<string, unknown>} params
     */
    function execute(session, id, params) {
        const loaded = readKingdom();
        if (loaded.kingdom === undefined) {
            showModel(session, buildResultModel({ ok: false, title: "Not done", lines: [], reason: loaded.reason }));
            return;
        }
        const working = JSON.parse(JSON.stringify(loaded.kingdom));
        const outcome = runAction(id, {
            kingdom: working,
            services: deps.services,
            player: session.player,
            tell: (lines) => tell(session.player, lines),
        }, params);
        let result = outcome;
        if (outcome.ok && actionSpec(id)?.touchesKingdom === true) {
            try {
                kingdomStore.save(working);
            } catch (error) {
                result = { ok: false, title: "Not saved", lines: [], reason: `the kingdom could not be saved (${String(error)})` };
            }
        }
        if (result.ok && outcome.afterSave !== undefined) {
            try {
                outcome.afterSave();
            } catch (error) {
                result = { ...result, lines: [...result.lines, line(`The physical gate needs attention: ${String(error)}`)] };
            }
        }
        showModel(session, buildResultModel(result));
    }

    /** @param {any} event */
    function handleItemUse(event) {
        try {
            const player = event?.source;
            if (!isPlayer(player) || !isLedgerStack(event?.itemStack)) {
                return;
            }
            const key = keyOf(player);
            const tick = now();
            const previous = lastAccepted.get(key);
            if (previous !== undefined && tick - previous < LEDGER_RUNTIME.debounceTicks) {
                return;
            }
            if (sessions.has(key)) {
                return;
            }
            lastAccepted.set(key, tick);
            if (!gateIsOpen()) {
                tell(player, [...GATE_OFF_LINES]);
                return;
            }
            openFor(player);
        } catch (_error) {
            // a failed use must never break the event loop
        }
    }

    /**
     * Opens the Ledger for a player at the Kingdom menu. False when that player already has one open.
     * @param {any} player
     * @returns {boolean}
     */
    function openFor(player) {
        const key = keyOf(player);
        if (sessions.has(key)) {
            return false;
        }
        /** @type {Session} */
        const session = { player, key, stack: newStack(), current: undefined, notice: undefined, busySince: undefined };
        sessions.set(key, session);
        system.run(() => render(session));
        return true;
    }

    /** @param {any} event */
    function handlePlayerLeave(event) {
        try {
            const key = String(event?.playerId ?? "");
            if (key.length === 0) {
                return;
            }
            sessions.delete(key);
            lastAccepted.delete(key);
        } catch (_error) {
            // tolerant: nothing to clean up
        }
    }

    /**
     * The recovery command. Gives the Ledger only when the player does not already hold one.
     * @param {any} event
     * @returns {{ status: string, lines: string[] }}
     */
    function handleRecoverCommand(event) {
        const player = event?.sourceEntity;
        if (!isPlayer(player)) {
            return { status: "not-a-player", lines: [] };
        }
        if (!gateIsOpen()) {
            const refused = { status: "gate-off", lines: [...GATE_OFF_LINES] };
            tell(player, refused.lines);
            return refused;
        }
        const outcome = grantLedger(player, deps);
        tell(player, outcome.lines);
        return outcome;
    }

    /**
     * Subscribes to the item, the leave and the recovery events. Idempotent. Called once from the binding.
     * @returns {boolean} true the first time
     */
    function register() {
        if (registered) {
            return false;
        }
        registered = true;
        world.afterEvents.itemUse.subscribe(handleItemUse);
        const leave = world.afterEvents.playerLeave;
        if (leave !== undefined) {
            leave.subscribe(handlePlayerLeave);
        }
        system.afterEvents.scriptEventReceive.subscribe(
            (event) => {
                if (event.id === LEDGER_EVENT_IDS.recover) {
                    handleRecoverCommand(event);
                }
            },
            { namespaces: [LEDGER_NAMESPACE] },
        );
        return true;
    }

    return {
        register,
        handleItemUse,
        handlePlayerLeave,
        handleRecoverCommand,
        openFor,
        /** @param {string} playerId */
        isOpen: (playerId) => sessions.has(playerId),
        /** @returns {number} */
        openCount: () => sessions.size,
        /** @param {string} playerId */
        stackOf: (playerId) => sessions.get(playerId)?.stack.map((frame) => ({ ...frame })),
        /** @param {string} playerId */
        currentOf: (playerId) => sessions.get(playerId)?.current,
    };
}

/**
 * Gives the Ledger to a player, at most one. Pure over the player and the item factory.
 *
 * @param {any} player
 * @param {{ ItemStack: new (typeId: string, amount?: number) => any, ItemLockMode: { inventory: string } }} deps
 * @returns {{ status: string, slot?: number, lines: string[] }}
 */
export function grantLedger(player, deps) {
    /** @type {{ size: number, getItem: (slot: number) => unknown, addItem: (stack: any) => any } | undefined} */
    let container;
    try {
        container = player.getComponent("minecraft:inventory")?.container;
    } catch (_error) {
        container = undefined;
    }
    if (container === undefined) {
        return { status: "no-inventory", lines: ["The Ledger was not given: your inventory is not available."] };
    }
    const held = findLedgerSlot(container);
    if (held !== undefined) {
        return { status: "already-held", slot: held, lines: [`You already carry the Commander's Ledger (slot ${String(held + 1)}).`] };
    }
    let leftover;
    try {
        leftover = container.addItem(makeLedgerStack(deps.ItemStack, deps.ItemLockMode));
    } catch (error) {
        return { status: "failed", lines: [`The Ledger could not be given: ${sanitize(String(error))}`] };
    }
    if (leftover === undefined) {
        const slot = findLedgerSlot(container);
        return { status: "granted", slot, lines: [`The Commander's Ledger is in your inventory (slot ${String((slot ?? 0) + 1)}).`] };
    }
    try {
        player.dimension.spawnItem(leftover, player.location);
    } catch (error) {
        return { status: "failed", lines: [`Your inventory is full and the Ledger could not be dropped: ${sanitize(String(error))}`] };
    }
    return { status: "dropped", lines: ["Your inventory is full: the Commander's Ledger was dropped at your feet."] };
}
