import { POPULATION_DEFAULTS } from "../config.js";
import { computeTotals, districtById, districtHeadroom } from "../kingdom/state.js";
import { formatGameTime } from "../sim/clock.js";
import { describeRecruitment } from "../sim/population.js";
import { desiredGarrison } from "../sim/policies.js";
import { listGates } from "../sim/gatecontrol.js";
import { defaultRecruitCount } from "./actions.js";
import { assemble, orNone } from "./frames.js";
import { disabledButton, enabledButton, navButton, notImplemented } from "./model.js";
import { tenths, whole } from "./text.js";

/**
 * The menus about people, land and troops: Kingdom (root), Military, Districts, a district card,
 * Reports and Diplomacy. Each builder is pure: it reads the kingdom and the optional live status
 * and returns a menu model. None of them changes anything.
 *
 * @typedef {import("./model.js").Button} Button
 * @typedef {{ menu: string, params: Record<string, unknown>, page: number }} Frame
 * @typedef {{ civ?: any, gates?: any }} Live
 */

/** @param {any} kingdom @param {unknown} id */
function nameOf(kingdom, id) {
    const district = districtById(kingdom, String(id));
    return district === undefined ? String(id) : String(district.name);
}

/**
 * The construction summary shared by the Kingdom menu.
 * @param {any} kingdom
 * @param {Live | undefined} live
 */
export function constructionSummary(kingdom, live) {
    const session = live?.civ?.session;
    if (session !== undefined) {
        return `running ${String(session.stage)} ${String(session.pct)}%`;
    }
    if (live?.civ?.busy !== undefined) {
        return `${String(live.civ.busy)} job running`;
    }
    const civs = /** @type {any[]} */ (kingdom.districts).map((district) => district.civ?.status ?? "not started");
    const count = (/** @type {string} */ status) => civs.filter((entry) => entry === status).length;
    return `${String(count("complete"))} complete, ${String(count("building") + count("paused"))} unfinished, ${String(count("not started"))} not started`;
}

/**
 * @param {any} kingdom
 * @param {any} district
 * @returns {{ enabled: boolean, reason?: string }}
 */
export function recruitReadiness(kingdom, district) {
    const info = describeRecruitment(kingdom).find((entry) => entry.districtId === String(district.id));
    if (info === undefined) {
        return { enabled: false, reason: "district not found" };
    }
    if (!info.open) {
        return { enabled: false, reason: info.reason ?? "recruitment is suspended" };
    }
    if (info.queueRoom < 1) {
        return { enabled: false, reason: `training queue full (${String(info.trainingQueue)} of ${String(POPULATION_DEFAULTS.trainingQueueCapacity)})` };
    }
    if (info.eligible < 1) {
        return { enabled: false, reason: "no free civilians to enlist" };
    }
    if (defaultRecruitCount(district) < 1) {
        return { enabled: false, reason: "food or supplies too low to equip a recruit" };
    }
    return { enabled: true };
}

/**
 * @param {any} district
 */
function recruitButton(district) {
    return { id: `recruit:${String(district.id)}`, text: `Recruit in ${String(district.name)}`, params: { districtId: String(district.id) } };
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 * @param {Live | undefined} live
 */
export function kingdomMenu(frame, kingdom, live) {
    const totals = computeTotals(kingdom);
    const threatened = /** @type {any[]} */ (kingdom.districts).filter((district) => Number(district.assault) > 0).map((district) => String(district.name));
    const lands = /** @type {any[]} */ (kingdom.territory ?? []);
    const count = (/** @type {string} */ status) => lands.filter((land) => land.status === status).length;
    const gates = listGates(kingdom).map((entry) => entry.gate);
    const managed = gates.filter((gate) => gate.mode !== undefined || gate.physical !== undefined).length;
    const states = (/** @type {string} */ state) => gates.filter((gate) => String(gate.state ?? "open") === state).length;
    return assemble(frame, {
        title: String(kingdom.name),
        lines: [
            `Time: ${formatGameTime(Number(kingdom.step))} (step ${String(kingdom.step)})`,
            `Civilians ${String(totals.civilians)}, soldiers ${String(totals.soldiers)}, refugees ${String(totals.refugees)}`,
            `Districts ${String(totals.districts)}. Under attack: ${threatened.join(", ") || "none"}`,
            `Expansion ${String(kingdom.policy.expansion)}; reinforcements keep ${String(whole(Number(kingdom.policy.reinforcementKeepFraction) * 100))}% home`,
            `Territory: ${String(count("kingdom"))} kingdom, ${String(count("military"))} military, ${String(count("raided"))} raided, ${String(count("wild"))} wild`,
            `Gates: ${String(gates.length)} (${String(managed)} managed), ${String(states("open"))} open, ${String(states("sealed"))} sealed, ${String(states("broken"))} broken`,
            `Construction: ${constructionSummary(kingdom, live)}`,
        ],
        content: [
            navButton("open-military", "Military", "military"),
            navButton("open-districts", "Districts", "districts"),
            navButton("open-construction", "Construction", "construction"),
            navButton("open-expansion", "Expansion", "expansion"),
            navButton("open-policies", "Policies", "policies"),
            navButton("open-gates", "Gates", "gates"),
            navButton("open-reports", "Reports", "reports"),
            navButton("open-diplomacy", "Diplomacy", "diplomacy"),
        ],
    });
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 */
export function militaryMenu(frame, kingdom) {
    const totals = computeTotals(kingdom);
    const target = /** @type {any[]} */ (kingdom.districts).reduce((sum, district) => sum + desiredGarrison(district), 0);
    const training = /** @type {any[]} */ (kingdom.districts).reduce((sum, district) => sum + Number(district.trainingQueue ?? 0), 0);
    /** @type {string[]} */
    const lines = [`Troops ${String(totals.soldiers)} (wanted ${String(target)}); in training ${String(training)}`];
    /** @type {Button[]} */
    const content = [];
    for (const district of /** @type {any[]} */ (kingdom.districts)) {
        lines.push(`${String(district.name)} (${String(district.security)}): ${String(district.soldiers)} troops`);
        lines.push(`  ${String(district.garrison.front)} on the wall, ${String(district.garrison.reserve)} in reserve, training ${String(district.trainingQueue)}`);
        const readiness = recruitReadiness(kingdom, district);
        const entry = recruitButton(district);
        content.push(
            readiness.enabled
                ? enabledButton(entry.id, entry.text, { id: "military.recruit", params: entry.params })
                : disabledButton(entry.id, entry.text, readiness.reason ?? "not available"),
        );
    }
    const threatened = /** @type {any[]} */ (kingdom.districts).filter((district) => Number(district.assault) > 0);
    lines.push(threatened.length === 0 ? "No district is under attack." : `Under attack: ${threatened.map((district) => String(district.name)).join(", ")}`);
    content.push(notImplemented("commanders", "Commanders"), notImplemented("patrols", "Patrol orders"), notImplemented("golems", "Golems and wolves"));
    return assemble(frame, { title: "Military", lines, content });
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 */
export function districtsMenu(frame, kingdom) {
    /** @type {string[]} */
    const lines = [];
    for (const district of /** @type {any[]} */ (kingdom.districts)) {
        lines.push(`${String(district.name)}: ${String(district.security)}, ${String(district.civilians)} people, ${String(district.soldiers)} troops`);
        lines.push(`  integrity ${String(whole(district.defensiveIntegrity))}%, shelter free ${String(districtHeadroom(district))}`);
    }
    const content = /** @type {any[]} */ (kingdom.districts).map((district) => navButton(`district:${String(district.id)}`, String(district.name), "district", { districtId: String(district.id) }));
    return assemble(frame, { title: "Districts", lines, content });
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 */
export function districtMenu(frame, kingdom) {
    const id = String(frame.params.districtId ?? "");
    const district = districtById(kingdom, id);
    if (district === undefined) {
        return assemble(frame, { title: "District", lines: [`No district ${id} in this kingdom.`], content: [] });
    }
    const neighbours = /** @type {string[]} */ (district.neighbors ?? []).map((neighbour) => nameOf(kingdom, neighbour));
    const projects = /** @type {any[]} */ (district.projects ?? []);
    const physical = district.physical;
    const civ = district.civ;
    /** @type {string[]} */
    const lines = [
        `Security ${String(district.security)}; assault ${String(whole(district.assault))}; siege steps ${String(district.siegeSteps)}`,
        `Integrity ${String(whole(district.defensiveIntegrity))}% (walls standing ${String(district.buildings.walls)})`,
        `Shelter ${String(district.civilians)} of ${String(district.civilianCapacity)} (refugees ${String(district.refugees)}, free ${String(districtHeadroom(district))})`,
        `Garrison ${String(district.soldiers)}: ${String(district.garrison.front)} on the wall, ${String(district.garrison.reserve)} in reserve`,
        `Training queue ${String(district.trainingQueue)}; builders ${String(district.builders)}`,
        `Stores: food ${String(tenths(district.reserves.food))}, materials ${String(tenths(district.reserves.materials))}, supplies ${String(tenths(district.reserves.supplies))}`,
        `Buildings: homes ${String(district.buildings.homes)}, farms ${String(district.buildings.farms)}, storehouses ${String(district.buildings.storehouses)}, barracks ${String(district.buildings.barracks)}`,
        `Neighbours: ${neighbours.join(", ") || "none"}; evacuated to ${orNone(district.evacuatedTo, "nobody")}`,
        physical === undefined
            ? "Physical district: no generated record"
            : `Physical district: ${String(physical.status)}, ${String(physical.placed)} of ${String(physical.total)} blocks`,
        civ === undefined ? "Civilization build: not started" : `Civilization build: ${String(civ.status)}, stage ${String(civ.stage)}`,
        projects.length === 0 ? "Projects: none scheduled" : `Projects: ${String(projects.length)} (${projects.slice(0, 3).map((project) => String(project.kind)).join(", ")})`,
    ];
    const gateButtons = /** @type {any[]} */ (district.gates ?? []).map((gate) =>
        navButton(`gate:${String(gate.id)}`, `Gate ${String(gate.id)}`, "gate", { gateId: String(gate.id) }),
    );
    const readiness = recruitReadiness(kingdom, district);
    const recruit = recruitButton(district);
    const content = [
        readiness.enabled
            ? enabledButton(recruit.id, recruit.text, { id: "military.recruit", params: recruit.params })
            : disabledButton(recruit.id, recruit.text, readiness.reason ?? "not available"),
        ...gateButtons,
    ];
    return assemble(frame, { title: String(district.name), lines, content });
}

/**
 * @param {Frame} frame
 * @param {any} kingdom
 */
export function reportsMenu(frame, kingdom) {
    /** @type {string[]} */
    const lines = ["Recent events:"];
    const log = /** @type {any[]} */ (kingdom.log ?? []);
    if (log.length === 0) {
        lines.push("  none yet");
    }
    for (const entry of log.slice(0, 8)) {
        lines.push(`  step ${String(entry.atStep)}: ${String(entry.text)}`);
    }
    const battles = /** @type {any[]} */ (kingdom.battles ?? []);
    lines.push("Last battle:");
    const last = battles[0];
    if (last === undefined) {
        lines.push("  no battle recorded yet");
    } else {
        lines.push(`  ${String(last.districtName)} at step ${String(last.atStep)}: assault ${String(whole(last.assault))}`);
        lines.push(`  integrity ${String(whole(last.integrityBefore))}% to ${String(whole(last.integrityAfter))}%`);
    }
    return assemble(frame, { title: "Reports", lines, content: [notImplemented("forecast", "Invasion forecasts")] });
}

/**
 * @param {Frame} frame
 */
export function diplomacyMenu(frame) {
    return assemble(frame, {
        title: "Diplomacy",
        lines: [
            "No other kingdom is known to this one.",
            "Every diplomatic feature is shown disabled until a second kingdom exists.",
        ],
        content: [
            notImplemented("envoy", "Send an envoy"),
            notImplemented("trade", "Open trade"),
            notImplemented("alliance", "Propose an alliance"),
            notImplemented("ultimatum", "Send an ultimatum"),
        ],
    });
}
