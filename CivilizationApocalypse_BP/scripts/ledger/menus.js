import { listGates } from "../sim/gatecontrol.js";
import { previewAction } from "./actions.js";
import { ROOT_MENU } from "./navigation.js";
import { diplomacyMenu, districtMenu, districtsMenu, kingdomMenu, militaryMenu, reportsMenu } from "./menus-kingdom.js";
import { constructionMenu, expansionMenu, gateMenu, gatesMenu, policiesMenu } from "./menus-works.js";
import { disabledButton, enabledButton, menuModel, missingModel } from "./model.js";
import { line } from "./text.js";

/**
 * The single entry point the runtime uses: a frame in, a menu model out. Also builds the two derived
 * models every mutating action goes through (confirm, then result), and enumerates every frame the
 * Ledger can show so the tests can walk all of them.
 *
 * @typedef {import("./model.js").MenuModel} MenuModel
 * @typedef {import("./navigation.js").Frame} Frame
 * @typedef {{ civ?: any, gates?: any }} Live
 */

/** Menus that take no subject: they exist once per kingdom. */
export const ROOT_MENUS = Object.freeze(["kingdom", "military", "districts", "construction", "expansion", "diplomacy", "reports", "policies", "gates"]);

/**
 * @param {Frame} frame
 * @param {any} kingdom
 * @param {Live} [live]
 * @returns {MenuModel}
 */
export function buildMenu(frame, kingdom, live = undefined) {
    switch (frame.menu) {
        case ROOT_MENU:
            return kingdomMenu(frame, kingdom, live);
        case "military":
            return militaryMenu(frame, kingdom);
        case "districts":
            return districtsMenu(frame, kingdom);
        case "district":
            return districtMenu(frame, kingdom);
        case "construction":
            return constructionMenu(frame, kingdom, live);
        case "expansion":
            return expansionMenu(frame, kingdom);
        case "diplomacy":
            return diplomacyMenu(frame);
        case "reports":
            return reportsMenu(frame, kingdom);
        case "policies":
            return policiesMenu(frame, kingdom, live);
        case "gates":
            return gatesMenu(frame, kingdom, live);
        case "gate":
            return gateMenu(frame, kingdom, live);
        default:
            return missingModel(frame.menu, "Unknown menu", `There is no menu called ${line(frame.menu)}.`);
    }
}

/**
 * The confirm model for a mutating action: the exact effect, a Confirm button that carries the
 * `confirmed` flag, and a Cancel button that returns to the menu the player came from.
 *
 * @param {string} actionId
 * @param {Record<string, unknown>} params
 * @param {any} kingdom
 * @param {Live} [live]
 * @returns {MenuModel}
 */
export function buildConfirmModel(actionId, params, kingdom, live = undefined) {
    const preview = previewAction(actionId, kingdom, params, live);
    const confirm =
        preview.blocked === undefined
            ? enabledButton("confirm", preview.confirmLabel, { id: actionId, params, confirmed: true })
            : disabledButton("confirm", preview.confirmLabel, preview.blocked);
    return menuModel({
        id: "confirm",
        kind: "confirm",
        title: preview.title,
        lines: [...preview.lines, "This changes the world. Confirm or cancel."],
        buttons: [confirm, enabledButton("cancel", "Cancel", { id: "nav.refresh" })],
        back: false,
    });
}

/**
 * The result model: what happened, or why it did not.
 * @param {{ ok: boolean, title: string, lines: string[], reason?: string }} result
 * @returns {MenuModel}
 */
export function buildResultModel(result) {
    const lines = result.ok ? result.lines : [`Refused: ${result.reason ?? "unknown reason"}`];
    return menuModel({
        id: "result",
        kind: "result",
        title: result.ok ? result.title : "Not done",
        lines,
        buttons: [enabledButton("back", "Back", { id: "nav.refresh" })],
        back: true,
    });
}

/**
 * Every frame the Ledger can show for a kingdom: the root menus, every district card, every gate card
 * (managed and unmanaged). Used by the exhaustive tests.
 *
 * @param {any} kingdom
 * @param {Live} [live]
 * @returns {Frame[]}
 */
export function enumerateFrames(kingdom, live = undefined) {
    /** @type {Frame[]} */
    const frames = ROOT_MENUS.map((menu) => ({ menu, params: {}, page: 0 }));
    for (const district of /** @type {any[]} */ (kingdom.districts ?? [])) {
        frames.push({ menu: "district", params: { districtId: String(district.id) }, page: 0 });
    }
    for (const { gate } of listGates(kingdom)) {
        frames.push({ menu: "gate", params: { gateId: String(gate.id) }, page: 0 });
    }
    for (const entry of /** @type {any[]} */ (live?.gates?.unmanaged ?? [])) {
        frames.push({ menu: "gate", params: { gateId: String(entry.id) }, page: 0 });
    }
    return frames;
}
