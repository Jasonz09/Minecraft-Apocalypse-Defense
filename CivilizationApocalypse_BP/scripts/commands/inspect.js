import { POLICY_MODES, SCRIPT_EVENT_IDS, SCRIPT_EVENT_NAMESPACE } from "../config.js";
import { districtById } from "../kingdom/state.js";
import { system } from "@minecraft/server";
import { formatDistrictLines, formatErrorLines, formatPolicyLines, formatTerritoryLines, formatUnknownDistrictLines } from "../ui/report.js";
import { parseArgs } from "./args.js";
import { reply } from "./reply.js";

/**
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 * @typedef {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ScriptEvent
 */

let registered = false;

/**
 * Inspection commands. Read-only except `civ:policy <mode>`, which is the one deliberate
 * gameplay change a commander is expected to make.
 *
 * @param {KingdomStore} kingdomStore
 */
export function registerInspectionCommands(kingdomStore) {
    if (registered) {
        return;
    }
    registered = true;

    system.afterEvents.scriptEventReceive.subscribe((event) => {
        if (event.id === SCRIPT_EVENT_IDS.district) {
            handleDistrict(kingdomStore, event);
            return;
        }
        if (event.id === SCRIPT_EVENT_IDS.territory) {
            const loaded = kingdomStore.load();
            if (loaded.kingdom) {
                reply(formatTerritoryLines(loaded.kingdom), event);
            } else {
                reply(formatErrorLines("Territory report", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
            }
            return;
        }
        if (event.id === SCRIPT_EVENT_IDS.policy) {
            handlePolicy(kingdomStore, event);
        }
    }, { namespaces: [SCRIPT_EVENT_NAMESPACE] });
}

/**
 * @param {any} kingdom
 */
function districtIds(kingdom) {
    return /** @type {any[]} */ (kingdom.districts ?? []).map((district) => district.id);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handleDistrict(kingdomStore, event) {
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatErrorLines("District report", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }
    const requested = parseArgs(event.message)[0];
    if (requested === undefined) {
        reply(formatErrorLines("District report", ["Usage: /scriptevent civ:district <district-id>", `Known districts: ${districtIds(loaded.kingdom).join(", ")}`]), event);
        return;
    }
    const district = districtById(loaded.kingdom, requested);
    if (!district) {
        reply(formatUnknownDistrictLines(districtIds(loaded.kingdom), requested), event);
        return;
    }
    reply(formatDistrictLines(loaded.kingdom, district), event);
}

/**
 * @param {KingdomStore} kingdomStore
 * @param {ScriptEvent} event
 */
function handlePolicy(kingdomStore, event) {
    const loaded = kingdomStore.load();
    if (!loaded.kingdom) {
        reply(formatErrorLines("Policy", [`No readable kingdom in this world: ${String(loaded.reason)}`]), event);
        return;
    }
    const requested = parseArgs(event.message)[0];
    if (requested === undefined) {
        reply(formatPolicyLines(loaded.kingdom), event);
        return;
    }
    if (!POLICY_MODES.includes(requested)) {
        reply(formatErrorLines("Policy rejected", [`'${requested}' is not a policy mode.`, `Choose one of: ${POLICY_MODES.join(", ")}`]), event);
        return;
    }
    loaded.kingdom.policy.expansion = requested;
    kingdomStore.save(loaded.kingdom);
    reply(formatPolicyLines(loaded.kingdom), event);
}
