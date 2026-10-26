/**
 * The Horn of Hearthgate, minus Minecraft: identity, intent and the guide arithmetic.
 *
 * A vanilla, non-stackable item carrying a marker dynamic property, exactly like the Commander's
 * Ledger (ledger/item.js). A custom item would need an item definition and a texture in the pack;
 * a stackable item cannot carry a marker at all, so a horn - not a compass - is the carrier.
 *
 * No `@minecraft/server` import, so the whole module runs in plain Node.
 */

import { BEACON, DISTRICT_NAMES } from "../config.js";

export const BEACON_ITEM = Object.freeze({
    typeId: BEACON.itemId,
    marker: BEACON.marker,
    nameTag: BEACON.nameTag,
    lore: Object.freeze([
        "Use it to raise Hearthgate on the nearest",
        "suitable ground, and to find your way back.",
    ]),
});

export const FIRST_DISTRICT_ID = "district-1";
export const FIRST_DISTRICT_NAME = DISTRICT_NAMES[0];

/**
 * @typedef {{ typeId?: string, getDynamicProperty?: (identifier: string) => unknown }} StackLike
 * @typedef {{ size: number, getItem: (slot: number) => unknown }} ContainerLike
 * @typedef {{ x: number, z: number }} Point2
 * @typedef {{ kind: "build" | "resume" | "guide" | "busy" | "unavailable", name: string, status?: string, reason?: string }} BeaconIntent
 */

/**
 * True for the horn and nothing else.
 * @param {unknown} stack
 * @returns {boolean}
 */
export function isBeaconStack(stack) {
    if (stack === null || typeof stack !== "object") {
        return false;
    }
    const candidate = /** @type {StackLike} */ (stack);
    return candidate.typeId === BEACON_ITEM.typeId && typeof candidate.getDynamicProperty === "function" && candidate.getDynamicProperty(BEACON_ITEM.marker) === true;
}

/**
 * The first inventory slot holding the horn, or undefined.
 * @param {ContainerLike} container
 * @returns {number | undefined}
 */
export function findBeaconSlot(container) {
    for (let slot = 0; slot < container.size; slot += 1) {
        if (isBeaconStack(container.getItem(slot))) {
            return slot;
        }
    }
    return undefined;
}

/**
 * A new horn: one item, named, with lore, the marker, locked to the inventory and kept on death.
 * `setDynamicProperty` throws on stackable items, which is why the carrier is `minecraft:goat_horn`.
 *
 * @param {new (typeId: string, amount?: number) => any} ItemStackClass
 * @param {{ inventory: string }} lockMode the ItemLockMode enum
 * @returns {any}
 */
export function makeBeaconStack(ItemStackClass, lockMode) {
    const stack = new ItemStackClass(BEACON_ITEM.typeId, 1);
    stack.nameTag = BEACON_ITEM.nameTag;
    stack.setLore([...BEACON_ITEM.lore]);
    stack.setDynamicProperty(BEACON_ITEM.marker, true);
    stack.lockMode = lockMode.inventory;
    stack.keepOnDeath = true;
    return stack;
}

/**
 * What using the horn should do right now. Hearthgate first: the city is raised district by
 * district, so the horn is the way in to district 1 and the way back to it afterwards.
 *
 * @param {any} kingdom
 * @param {{ busy?: boolean }} [options]
 * @returns {BeaconIntent}
 */
export function beaconIntent(kingdom, options = {}) {
    const districts = Array.isArray(kingdom?.districts) ? /** @type {any[]} */ (kingdom.districts) : [];
    const district = districts.find((one) => one?.id === FIRST_DISTRICT_ID);
    if (district === undefined) {
        return { kind: "unavailable", name: FIRST_DISTRICT_NAME, reason: "This world holds no kingdom that carries Hearthgate." };
    }
    const name = String(district.name ?? FIRST_DISTRICT_NAME);
    const civ = district.civ;
    if (civ === undefined) {
        return { kind: "build", name };
    }
    const status = String(civ.status);
    if (status === "complete") {
        return { kind: "guide", name, status };
    }
    if (options.busy === true) {
        return { kind: "busy", name, status };
    }
    return { kind: "resume", name, status };
}

/**
 * Where the city centre is, from the district record. Undefined until a plan has been stored.
 * @param {any} kingdom
 * @returns {Point2 | undefined}
 */
export function beaconCentre(kingdom) {
    const districts = Array.isArray(kingdom?.districts) ? /** @type {any[]} */ (kingdom.districts) : [];
    const centre = districts.find((one) => one?.id === FIRST_DISTRICT_ID)?.civ?.centre;
    if (centre === null || typeof centre !== "object" || !Number.isInteger(centre.x) || !Number.isInteger(centre.z)) {
        return undefined;
    }
    return { x: centre.x, z: centre.z };
}

/**
 * Degrees clockwise from north. Minecraft: north is -z and east is +x.
 * @param {Point2} from
 * @param {Point2} to
 * @returns {number} 0 <= degrees < 360
 */
export function bearingDegrees(from, to) {
    const east = to.x - from.x;
    const north = -(to.z - from.z);
    if (east === 0 && north === 0) {
        return 0;
    }
    return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** @param {number} degrees @returns {string} */
export function compassPoint(degrees) {
    const wrapped = ((degrees % 360) + 360) % 360;
    return COMPASS_POINTS[Math.round(wrapped / 45) % COMPASS_POINTS.length];
}

/**
 * The one-line action-bar guide, refreshed while the horn is held.
 * @param {Point2} centre @param {Point2} location @param {string} name @param {string} [status]
 * @returns {string}
 */
export function guideLine(centre, location, name, status = "complete") {
    const distance = Math.round(Math.hypot(centre.x - location.x, centre.z - location.z));
    const point = compassPoint(bearingDegrees(location, centre));
    const suffix = status === "building" ? " · rising" : status === "paused" ? " · paused" : "";
    return `${name} · ${String(distance)}m ${point}${suffix}`;
}

/**
 * The chat readout when the horn is used after the city stands.
 * @param {Point2} centre @param {Point2} location @param {string} name @param {string} [status]
 * @returns {string[]}
 */
export function guideLines(centre, location, name, status = "complete") {
    const distance = Math.round(Math.hypot(centre.x - location.x, centre.z - location.z));
    const point = compassPoint(bearingDegrees(location, centre));
    const lines = [`${name} stands at ${String(centre.x)}, ${String(centre.z)} — ${String(distance)} blocks ${point} of you.`];
    if (status === "building") {
        lines.push("It is still being raised; the line at the top of your screen follows you to it.");
    } else if (status === "paused") {
        lines.push("Its build is paused; use the horn again to continue it.");
    } else {
        lines.push(`Tour it: /tp @s ${String(centre.x)} ~ ${String(centre.z)}`);
    }
    return lines;
}

/**
 * @param {"build" | "resume" | "guide" | "busy" | "unavailable"} kind
 * @param {string} name
 * @returns {string}
 */
export function confirmTitle(kind, name) {
    return kind === "resume" ? `Resume ${name}?` : `Raise ${name}?`;
}

/**
 * The confirmation the horn opens before anything is written. The site is not known yet - the
 * survey is what finds it - so the body states the search radius and what may be replaced.
 *
 * @param {"build" | "resume"} kind
 * @param {string} name
 * @param {number} radius
 * @returns {string}
 */
export function confirmBody(kind, name, radius) {
    if (kind === "resume") {
        return [
            `${name} is unfinished. It continues from its own stored plan and queue.`,
            "Placed blocks stay; nothing is generated twice.",
        ].join("\n\n");
    }
    return [
        `The nearest suitable ground within ${String(radius)} blocks is surveyed, then ${name} is raised there - about 76,000 blocks.`,
        "Natural-looking terrain (dirt, stone, sand, gravel, clay, snow, moss) will be replaced. Planks, bricks, glass, chests, ores and farmland are protected.",
        "Use a dedicated test world. The build runs over several minutes and is saved as it goes.",
    ].join("\n\n");
}

/**
 * The button that actually does the work.
 * @param {"build" | "resume"} kind
 * @returns {string}
 */
export function confirmButton(kind) {
    return kind === "resume" ? "Resume the build" : "Build Hearthgate here";
}
