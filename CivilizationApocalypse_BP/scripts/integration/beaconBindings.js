import { ItemLockMode, ItemStack, system, world } from "@minecraft/server";
import { MessageFormData } from "@minecraft/server-ui";
import { parseCivArgs, runGenerate, runResume } from "../commands/civ.js";
import { BEACON, CIV } from "../config.js";
import { isBusy } from "./districtBuilder.js";
import { formatErrorLines } from "../ui/report.js";
import { beaconCentre, beaconIntent, confirmBody, confirmButton, confirmTitle, findBeaconSlot, guideLine, guideLines, isBeaconStack, makeBeaconStack } from "../inventory/beaconRules.js";

/**
 * The Horn of Hearthgate, the player-facing way in to the civilization build.
 *
 * It does nothing on its own: a use opens a confirmation, and only a confirmed answer calls the
 * same runGenerate()/runResume() the typed commands call. So every refusal, the one-district-at-a-
 * time rule, the write guard, the persisted queue and the dev gate all apply unchanged.
 *
 * The item is granted once per player (a vanilla horn, marked, locked to the inventory and kept on
 * death), and while it is held its action bar shows how far the city is and which way to walk.
 *
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("@minecraft/server").Player} Player
 */

let registered = false;

/** Player id -> tick of the last accepted use, so one press aimed at a block cannot count twice. */
const lastUseTick = new Map();

/**
 * @param {KingdomStore} kingdomStore
 */
export function registerSeedBeacon(kingdomStore) {
    if (registered) {
        return false;
    }
    registered = true;

    world.afterEvents.itemUse.subscribe((event) => {
        if (!isBeaconStack(event.itemStack)) {
            return;
        }
        handleUse(kingdomStore, event.source);
    });

    world.afterEvents.playerSpawn.subscribe((event) => {
        if (event.initialSpawn) {
            grant(event.player);
        }
    });

    system.runInterval(() => guideTick(kingdomStore), BEACON.guideTicks);
    return true;
}

/** @param {Player} player */
function heldBeacon(player) {
    try {
        const container = player.getComponent("minecraft:inventory")?.container;
        const stack = container?.getItem(player.selectedSlotIndex);
        return isBeaconStack(stack) ? stack : undefined;
    } catch (_error) {
        return undefined;
    }
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {Player} player
 */
function handleUse(kingdomStore, player) {
    const now = system.currentTick;
    const last = lastUseTick.get(player.id);
    if (last !== undefined && now - last < BEACON.dupUseTicks) {
        return;
    }
    lastUseTick.set(player.id, now);

    const loaded = kingdomStore.load();
    const intent = beaconIntent(loaded.kingdom, { busy: isBusy() });

    if (intent.kind === "unavailable") {
        player.sendMessage(formatErrorLines("The horn is silent", [String(intent.reason ?? "This world holds no kingdom."), "Join the world once as a player to found it."]));
        return;
    }
    if (intent.kind === "busy") {
        player.sendMessage(formatErrorLines("The horn is silent", [
            `A job is already running and ${intent.name} is ${String(intent.status ?? "busy")}.`,
            "Wait for it, or check /scriptevent civ:generate_status.",
        ]));
        return;
    }
    if (intent.kind === "guide") {
        const centre = beaconCentre(loaded.kingdom);
        if (centre === undefined) {
            player.sendMessage([`${intent.name} is complete, but its centre is not recorded in this save.`]);
            return;
        }
        player.sendMessage(guideLines(centre, player.location, intent.name, intent.status));
        ping(player, centre, intent.name, intent.status);
        return;
    }
    askToBuild(kingdomStore, player, intent);
}

/**
 * The confirmation, shown off the event callback (a form cannot be shown in restricted execution).
 * @param {KingdomStore} kingdomStore
 * @param {Player} player
 * @param {ReturnType<typeof beaconIntent>} intent
 */
function askToBuild(kingdomStore, player, intent) {
    const kind = intent.kind === "resume" ? "resume" : "build";
    system.runTimeout(() => {
        const form = new MessageFormData()
            .title(confirmTitle(kind, intent.name))
            .body(confirmBody(kind, intent.name, CIV.defaultSearchRadius))
            .button1(confirmButton(kind))
            .button2("Cancel");
        let pending;
        try {
            pending = form.show(player);
        } catch (error) {
            player.sendMessage(formatErrorLines("The horn could not open", [String(error), "Use /scriptevent civ:generate for the same build."]));
            return;
        }
        Promise.resolve(pending).then(
            (response) => {
                if (response.canceled === true || response.selection !== 0) {
                    player.sendMessage([`Cancelled: ${intent.name} was not ${kind === "resume" ? "resumed" : "started"}.`]);
                    return;
                }
                if (kind === "resume") {
                    void runResume(kingdomStore, player, parseCivArgs([]));
                } else {
                    void runGenerate(kingdomStore, player, parseCivArgs([]), false);
                }
            },
            () => {
                // the player left before answering; nothing was written
            },
        );
    }, 1);
}

/**
 * @param {KingdomStore} kingdomStore
 */
function guideTick(kingdomStore) {
    const holders = world.getAllPlayers().filter((player) => heldBeacon(player) !== undefined);
    if (holders.length === 0) {
        return;
    }
    const loaded = kingdomStore.load();
    const centre = beaconCentre(loaded.kingdom);
    if (centre === undefined) {
        return;
    }
    const intent = beaconIntent(loaded.kingdom);
    for (const player of holders) {
        ping(player, centre, intent.name, intent.status);
    }
}

/**
 * @param {Player} player
 * @param {{ x: number, z: number }} centre
 * @param {string} name
 * @param {string} [status]
 */
function ping(player, centre, name, status) {
    try {
        if (!player.isValid) {
            return;
        }
        player.onScreenDisplay.setActionBar(guideLine(centre, player.location, name, status));
    } catch (_error) {
        // a player who left mid-tick cannot break the guide interval
    }
}

/**
 * Gives the horn to a player who does not hold one. Returns nothing: a full inventory drops it.
 * @param {Player} player
 */
function grant(player) {
    let container;
    try {
        container = player.getComponent("minecraft:inventory")?.container;
    } catch (_error) {
        container = undefined;
    }
    if (container === undefined || findBeaconSlot(container) !== undefined) {
        return;
    }
    let leftover;
    try {
        leftover = container.addItem(makeBeaconStack(ItemStack, ItemLockMode));
    } catch (_error) {
        return;
    }
    if (leftover === undefined) {
        player.sendMessage([`The ${BEACON.nameTag} is in your inventory: use it to raise Hearthgate, and to find your way back to it.`]);
        return;
    }
    try {
        player.dimension.spawnItem(leftover, player.location);
    } catch (_error) {
        // nothing else can be done for a full inventory in an unreachable dimension
    }
}
