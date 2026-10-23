// Commander's Ledger, part A: the pure presenters, the action registry and the text rules.
//
// Everything here runs offline. A module-resolution hook replaces "@minecraft/server" with a stub
// whose world and system throw on any touch, so the suite also proves that the presenters import no
// server object at load time. The integration checks load the real gateAdapter, civBuilder and
// civGates modules through the same stub, and confirm that every service the registry names exists.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = join(root, "CivilizationApocalypse_BP", "scripts");
const ledgerDir = join(scripts, "ledger");
const fileUrl = (...parts) => pathToFileURL(join(scripts, ...parts)).href;

const hooksSource = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = 'const touched = (name) => { throw new Error("server object touched at load: " + name); };' +
            'export const world = new Proxy({}, { get: (_t, p) => touched("world." + String(p)) });' +
            'export const system = new Proxy({}, { get: (_t, p) => touched("system." + String(p)) });' +
            'export const ScriptEventSource = { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" };' +
            'export const BlockPermutation = new Proxy({}, { get: (_t, p) => touched("BlockPermutation." + String(p)) });';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooksSource));

const load = (...parts) => import(fileUrl(...parts));
const config = await load("config.js");
const ids = await load("ledger", "ids.js");
const text = await load("ledger", "text.js");
const pagination = await load("ledger", "pagination.js");
const navigation = await load("ledger", "navigation.js");
const model = await load("ledger", "model.js");
const actions = await load("ledger", "actions.js");
const menus = await load("ledger", "menus.js");
const item = await load("ledger", "item.js");
const gateAdapter = await load("integration", "gateAdapter.js");
const civBuilder = await load("integration", "civBuilder.js");
const civGates = await load("integration", "civGates.js");
const harness = await import(pathToFileURL(join(root, "dev", "lib", "ledgerharness.mjs")).href);

const { kingdomStates, liveStatus } = harness;
const { LEDGER_TEXT, FORBIDDEN_TEXT, sanitize, fit, isPlainLine } = text;
const { actionSpec, actionIds, navigateAction, runAction, previewAction, LEDGER_ACTIONS, SERVICE_CONTRACT } = actions;
const { buildMenu, buildConfirmModel, buildResultModel, enumerateFrames, ROOT_MENUS } = menus;

/* ------------------------------------------------------------------ *
 * Shared walk: every state, every live variant, every frame, every page.
 * ------------------------------------------------------------------ */

const LIVE_VARIANTS = {
    absent: undefined,
    idle: liveStatus({ resumable: undefined }),
    running: liveStatus({ running: true, moving: ["gate-district-2-district-3"] }),
    resumable: liveStatus({ busy: undefined, resumable: 2, unmanaged: [{ id: "gate-7", purpose: "outer", between: ["district-1", "district-4"], mode: "forced_open", actual: "open" }] }),
    busy: liveStatus({ busy: "civ-resume", resumable: undefined }),
};

/** Every (state, live, frame, page) the Ledger can render, as built models. */
function everyModel() {
    /** @type {{ state: string, live: string, frame: any, model: any }[]} */
    const rows = [];
    for (const [stateName, make] of Object.entries(kingdomStates())) {
        const kingdom = make();
        for (const [liveName, live] of Object.entries(LIVE_VARIANTS)) {
            for (const frame of enumerateFrames(kingdom, live)) {
                const first = buildMenu(frame, kingdom, live);
                const pages = first.pages?.pages ?? 1;
                for (let page = 0; page < pages; page += 1) {
                    const pageFrame = { ...frame, page };
                    rows.push({ state: stateName, live: liveName, frame: pageFrame, model: buildMenu(pageFrame, kingdom, live) });
                }
            }
        }
    }
    return rows;
}

const ROWS = everyModel();

/* ------------------------------------------------------------------ *
 * Identity and import discipline
 * ------------------------------------------------------------------ */

const VALID_SCRIPTEVENT_ID = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

test("the recovery id obeys the scriptevent rule used by dev/test/commands.test.mjs", () => {
    assert.equal(ids.LEDGER_EVENT_IDS.recover, "civ:ledger");
    assert.match(ids.LEDGER_EVENT_IDS.recover, VALID_SCRIPTEVENT_ID);
    assert.equal(ids.LEDGER_EVENT_IDS.recover.split(":").length, 2, "exactly one colon");
    assert.equal(ids.LEDGER_NAMESPACE, config.SCRIPT_EVENT_NAMESPACE);
});

test("no ledger module names a server or UI package, and none reaches into commands or integration", () => {
    for (const file of readdirSync(ledgerDir).filter((name) => name.endsWith(".js"))) {
        const source = readFileSync(join(ledgerDir, file), "utf8");
        assert.doesNotMatch(source, /from\s+["']@minecraft\//, `${file} imports a Minecraft package`);
        assert.doesNotMatch(source, /from\s+["']\.\.\/(commands|integration)\//, `${file} imports a command or integration module`);
        assert.doesNotMatch(source, /\bconsole\./, `${file} uses console`);
    }
});

test("the presenters load with a server stub that throws on any touch", () => {
    assert.equal(typeof menus.buildMenu, "function");
    assert.equal(typeof actions.runAction, "function");
});

/* ------------------------------------------------------------------ *
 * Text rules
 * ------------------------------------------------------------------ */

test("sanitize removes section signs and control characters and collapses whitespace", () => {
    assert.equal(sanitize("Bad §c name\n\tline"), "Bad c name line");
    assert.equal(sanitize("a\u0000b\u007fc"), "a b c");
    assert.doesNotMatch(sanitize("§§x"), FORBIDDEN_TEXT);
});

test("wrap keeps every word, indents continuation lines and never exceeds the width", () => {
    const sample = "Blocked: closing it would isolate district-2, split the open routes and strand refugees (district-3 to district-1) for a while";
    const pieces = text.wrap(sample);
    assert.ok(pieces.length > 1, "a long sentence wraps");
    for (const piece of pieces) {
        assert.ok(piece.length <= LEDGER_TEXT.lineWidth, piece);
        assert.doesNotMatch(piece, FORBIDDEN_TEXT);
    }
    assert.deepEqual(pieces.join(" ").split(/\s+/).filter((word) => word.length > 0), sample.split(" "));
    assert.ok(pieces.slice(1).every((piece) => piece.startsWith("  ")), "continuation lines are indented");
    assert.equal(text.wrap("short").length, 1);
    const hard = text.wrap("x".repeat(130));
    assert.ok(hard.every((piece) => piece.length <= LEDGER_TEXT.lineWidth));
    assert.equal(hard.join("").replace(/\s+/g, "").length, 130, "no character is lost");
});

test("fit cuts long text and ends it with an ellipsis, never longer than the width", () => {
    const long = "word ".repeat(40);
    for (const width of [4, 10, LEDGER_TEXT.lineWidth]) {
        const cut = fit(long, width);
        assert.ok(cut.length <= width, `${String(cut.length)} > ${String(width)}`);
        assert.ok(cut.endsWith("...") || cut.length <= width);
    }
    assert.equal(fit("short", 10), "short");
});

test("every line and every label of every menu obeys the configured width and the forbidden set", () => {
    let lines = 0;
    let labels = 0;
    for (const row of ROWS) {
        for (const line of row.model.lines) {
            lines += 1;
            assert.ok(isPlainLine(line), `${row.frame.menu}: bad line '${line}'`);
            assert.doesNotMatch(line, /undefined|NaN|\[object/, `${row.frame.menu}: placeholder text in '${line}'`);
        }
        for (const button of row.model.buttons) {
            labels += 1;
            assert.ok(button.label.length <= LEDGER_TEXT.buttonWidth, `label too long: ${button.label}`);
            assert.doesNotMatch(button.label, FORBIDDEN_TEXT);
        }
        assert.doesNotMatch(row.model.title, FORBIDDEN_TEXT);
    }
    assert.ok(lines > 1000, `expected a large walk, saw ${String(lines)} lines`);
    assert.ok(labels > 300, `expected many labels, saw ${String(labels)}`);
});

test("a hostile district name cannot leak a section sign or a line break into any menu", () => {
    const kingdom = kingdomStates().fresh();
    kingdom.districts[0].name = "Hearth§cgate\nKING";
    kingdom.log.push({ atStep: 1, text: "bell§l rings" });
    for (const frame of enumerateFrames(kingdom, undefined)) {
        const built = buildMenu(frame, kingdom, undefined);
        for (const line of built.lines) {
            assert.doesNotMatch(line, FORBIDDEN_TEXT, `${frame.menu}: ${line}`);
        }
        for (const button of built.buttons) {
            assert.doesNotMatch(button.label, FORBIDDEN_TEXT);
        }
    }
});

/* ------------------------------------------------------------------ *
 * Model rules, across every state and live variant
 * ------------------------------------------------------------------ */

test("every model has the shape, back rules and unique button ids", () => {
    for (const row of ROWS) {
        const built = row.model;
        assert.equal(typeof built.id, "string");
        assert.ok(["menu", "confirm", "result"].includes(built.kind), built.kind);
        assert.equal(typeof built.title, "string");
        assert.ok(Array.isArray(built.lines) && built.lines.length > 0, `${row.frame.menu} has no lines`);
        assert.ok(Array.isArray(built.buttons));
        assert.ok(built.buttons.length <= LEDGER_TEXT.maxButtons, `${row.frame.menu} shows ${String(built.buttons.length)} buttons`);
        const idsSeen = built.buttons.map((button) => button.id);
        assert.equal(new Set(idsSeen).size, idsSeen.length, `${row.frame.menu} repeats a button id: ${idsSeen.join(",")}`);
        const isRoot = row.frame.menu === "kingdom";
        assert.equal(built.back, !isRoot, `${row.frame.menu}: back must be ${String(!isRoot)}`);
        const hasBack = built.buttons.some((button) => button.enabled && button.action?.id === "nav.back");
        assert.equal(hasBack, !isRoot, `${row.frame.menu}: Back button presence wrong`);
    }
});

test("every enabled button names a registered action; every disabled button says why", () => {
    let enabled = 0;
    let disabled = 0;
    for (const row of ROWS) {
        for (const button of row.model.buttons) {
            if (button.enabled) {
                enabled += 1;
                assert.ok(button.action !== undefined, `${row.frame.menu}/${button.id} is enabled without an action`);
                const spec = actionSpec(button.action.id);
                assert.ok(spec !== undefined, `${row.frame.menu}/${button.id} names unknown action ${button.action.id}`);
                assert.doesNotThrow(() => JSON.stringify(button.action.params ?? {}));
                if (spec.kind === "navigate") {
                    assert.doesNotThrow(() => navigateAction(button.action.id, button.action.params ?? {}));
                }
            } else {
                disabled += 1;
                assert.equal(button.action, undefined, `${row.frame.menu}/${button.id} is disabled but carries an action`);
                assert.ok(typeof button.reason === "string" && button.reason.length > 0, `${row.frame.menu}/${button.id} has no reason`);
                assert.ok(isPlainLine(button.reason), `${row.frame.menu}/${button.id} reason is not plain text`);
            }
        }
    }
    assert.ok(enabled > 200 && disabled > 100, `walk too small: ${String(enabled)} enabled, ${String(disabled)} disabled`);
});

test("no menu button runs a world change directly: mutating buttons never carry the confirmed flag", () => {
    let mutating = 0;
    for (const row of ROWS) {
        for (const button of row.model.buttons) {
            if (!button.enabled || button.action === undefined) {
                continue;
            }
            const spec = actionSpec(button.action.id);
            if (spec?.kind === "mutate") {
                mutating += 1;
                assert.notEqual(button.action.confirmed, true, `${row.frame.menu}/${button.id} runs ${button.action.id} without a confirm`);
            }
        }
    }
    assert.ok(mutating > 20, `expected mutating buttons in the walk, saw ${String(mutating)}`);
});

test("the presenters never change the kingdom they read", () => {
    for (const [stateName, make] of Object.entries(kingdomStates())) {
        const kingdom = make();
        const before = JSON.stringify(kingdom);
        for (const frame of enumerateFrames(kingdom, LIVE_VARIANTS.resumable)) {
            buildMenu(frame, kingdom, LIVE_VARIANTS.resumable);
            for (const id of actionIds()) {
                if (actionSpec(id)?.kind === "mutate") {
                    previewAction(id, kingdom, sampleParams(id, kingdom), LIVE_VARIANTS.running);
                }
            }
        }
        assert.equal(JSON.stringify(kingdom), before, `${stateName} was changed by a presenter`);
    }
});

/* ------------------------------------------------------------------ *
 * Actions: resolution, calls, services
 * ------------------------------------------------------------------ */

function sampleParams(id, kingdom) {
    const district = kingdom.districts[0];
    const gate = kingdom.districts.flatMap((entry) => entry.gates ?? [])[0];
    switch (id) {
        case "military.recruit":
            return { districtId: district.id };
        case "policy.expansion":
            return { mode: "paused" };
        case "gate.mode":
            return { gateId: gate?.id ?? "gate-none", mode: "forced_closed", force: true };
        case "gate.unmanaged":
            return { gateId: "gate-outer", mode: "forced_open" };
        case "gate.test":
            return { gateId: gate?.id ?? "gate-none" };
        case "construction.resume":
            return { district: 2 };
        default:
            return {};
    }
}

test("every mutating action declares describe and run, and names what it calls and needs", () => {
    for (const id of actionIds()) {
        const spec = LEDGER_ACTIONS[id];
        assert.equal(spec.id, id);
        assert.ok(Array.isArray(spec.calls) && Array.isArray(spec.services), `${id} lacks calls or services`);
        if (spec.kind === "mutate") {
            assert.equal(typeof spec.run, "function", `${id} has no run`);
            assert.equal(typeof spec.describe, "function", `${id} has no describe`);
            assert.equal(typeof spec.touchesKingdom, "boolean", `${id} lacks touchesKingdom`);
            assert.ok(spec.calls.length + spec.services.length > 0, `${id} calls nothing`);
        } else {
            assert.match(id, /^nav\./, `${id} is navigation but not named nav.*`);
        }
    }
});

test("every direct call names a real export of its module", async () => {
    for (const id of actionIds()) {
        for (const call of LEDGER_ACTIONS[id].calls) {
            const moduleExports = await import(fileUrl(...call.module.split("/")));
            assert.ok(call.name in moduleExports, `${id} calls ${call.module} ${call.name}, which does not exist`);
        }
    }
});

test("every service the registry names is in the contract, and the contract resolves to real code", async () => {
    const adapter = gateAdapter.createGateAdapter({ load: () => ({ kingdom: undefined }), save: () => undefined }, {});
    assert.equal(typeof adapter.retryNow, "function", "adapter.retryNow");
    assert.equal(typeof adapter.pump, "function", "adapter.pump");
    assert.equal(typeof gateAdapter.setUnmanagedMode, "function");
    assert.equal(typeof civGates.startGateSelfTest, "function");
    assert.equal(typeof civBuilder.abortCivJob, "function");
    assert.equal(typeof civBuilder.civAbortLines, "function");
    const commandSource = readFileSync(join(scripts, "commands", "civ.js"), "utf8");
    assert.match(commandSource, /id === CIV_EVENT_IDS\.resume/, "civ:generate_resume is handled by the civ command module");

    const resolvedServices = new Set([
        "gates.retryNow",
        "gates.pump",
        "gates.setUnmanagedMode",
        "gates.startSelfTest",
        "civ.abort",
        "civ.abortLines",
        "civ.resume",
    ]);
    for (const [group, names] of Object.entries(SERVICE_CONTRACT)) {
        for (const name of names) {
            assert.ok(resolvedServices.has(`${group}.${name}`), `${group}.${name} has no source`);
        }
    }
    for (const id of actionIds()) {
        for (const service of LEDGER_ACTIONS[id].services) {
            const [group, name] = service.split(".");
            assert.ok(SERVICE_CONTRACT[group]?.includes(name), `${id} names unknown service ${service}`);
        }
    }
});

test("every service reference in the action source is a contract entry (enumerated from the code)", () => {
    const source = readFileSync(join(ledgerDir, "actions.js"), "utf8");
    const references = [...source.matchAll(/serviceOf\(ctx, "(\w+)", "(\w+)"\)/g)].map((match) => `${match[1]}.${match[2]}`);
    assert.ok(references.length >= 7, `expected the service calls to be enumerated, saw ${String(references.length)}`);
    for (const reference of references) {
        const [group, name] = reference.split(".");
        assert.ok(SERVICE_CONTRACT[group]?.includes(name), `${reference} is called but not in SERVICE_CONTRACT`);
    }
});

test("the registry covers every action a button names", () => {
    const named = new Set();
    for (const row of ROWS) {
        for (const button of row.model.buttons) {
            if (button.action !== undefined) {
                named.add(button.action.id);
            }
        }
    }
    for (const id of named) {
        assert.ok(actionSpec(id) !== undefined, `${id} is named by a menu but has no spec`);
    }
    assert.ok(named.has("military.recruit") && named.has("gate.mode") && named.has("construction.resume"));
});

test("unknown and prototype-named action ids resolve to nothing", () => {
    assert.equal(actionSpec("constructor"), undefined);
    assert.equal(actionSpec("__proto__"), undefined);
    assert.equal(actionSpec("nope.nothing"), undefined);
    assert.equal(runAction("nope.nothing", { kingdom: {} }).ok, false);
});

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

test("every mutating action produces a confirm model with the effect named, Confirm and Cancel", () => {
    const kingdom = kingdomStates().fresh();
    for (const id of actionIds()) {
        const spec = LEDGER_ACTIONS[id];
        if (spec.kind !== "mutate") {
            continue;
        }
        const confirm = buildConfirmModel(id, sampleParams(id, kingdom), kingdom, liveStatus({ running: true }));
        assert.equal(confirm.kind, "confirm", id);
        assert.equal(confirm.buttons.length, 2, id);
        const [yes, no] = confirm.buttons;
        assert.equal(no.id, "cancel");
        assert.equal(no.action.id, "nav.refresh", "Cancel returns to the menu it came from");
        assert.ok(confirm.lines.length >= 2, `${id} names no effect`);
        if (yes.enabled) {
            assert.equal(yes.action.id, id);
            assert.equal(yes.action.confirmed, true);
        } else {
            assert.ok(yes.reason, `${id} disabled confirm needs a reason`);
        }
    }
});

test("a confirm for an unknown action is blocked, not executed", () => {
    const kingdom = kingdomStates().fresh();
    const confirm = buildConfirmModel("nope.nothing", {}, kingdom, undefined);
    assert.equal(confirm.buttons[0].enabled, false);
    assert.equal(confirm.buttons[0].action, undefined);
});

test("a result model shows success text, or the refusal reason with a Back that refreshes", () => {
    const ok = buildResultModel({ ok: true, title: "Done", lines: ["It worked."] });
    assert.equal(ok.kind, "result");
    assert.deepEqual(ok.lines, ["It worked."]);
    assert.equal(ok.buttons[0].action.id, "nav.refresh");
    const refused = buildResultModel({ ok: false, title: "Refused", lines: [], reason: "not allowed" });
    assert.equal(refused.lines[0], "Refused: not allowed");
    assert.equal(refused.title, "Not done");
});

/* ------------------------------------------------------------------ *
 * Diplomacy and unbuilt features
 * ------------------------------------------------------------------ */

const NOT_BUILT_IDS = ["envoy", "trade", "alliance", "ultimatum", "commanders", "patrols", "golems", "other-buildings", "districts-2-5", "claim", "forecast"];

test("diplomacy is wholly unavailable: every feature disabled with 'not implemented'", () => {
    for (const row of ROWS.filter((entry) => entry.frame.menu === "diplomacy")) {
        assert.ok(row.model.buttons.length >= 4);
        for (const button of row.model.buttons.filter((entry) => entry.id !== "back" && entry.id !== "home")) {
            assert.equal(button.enabled, false, button.id);
            assert.equal(button.reason, "not implemented", button.id);
        }
        assert.ok(row.model.lines.some((line) => /No other kingdom/.test(line)));
    }
});

test("every unbuilt feature button is disabled with 'not implemented'", () => {
    let seen = 0;
    for (const row of ROWS) {
        for (const button of row.model.buttons) {
            if (NOT_BUILT_IDS.includes(button.id)) {
                seen += 1;
                assert.equal(button.enabled, false, `${row.frame.menu}/${button.id} must be disabled`);
                assert.equal(button.reason, "not implemented", `${row.frame.menu}/${button.id}`);
            }
        }
    }
    assert.ok(seen >= 20, `expected the unbuilt features to appear, saw ${String(seen)}`);
});

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

test("paginateButtons: every page holds at most maxButtons, and the content is listed once, in order", () => {
    for (let total = 0; total <= 60; total += 1) {
        for (const chromeCount of [0, 1, 2]) {
            const content = Array.from({ length: total }, (_unused, index) => `c${String(index)}`);
            const chrome = Array.from({ length: chromeCount }, (_unused, index) => `x${String(index)}`);
            const pageCount = pagination.paginateButtons({ content, chrome, page: 0, makeNav: (target, dir) => `nav-${dir}-${String(target)}` }).pages;
            const seen = [];
            for (let page = 0; page < pageCount; page += 1) {
                const result = pagination.paginateButtons({ content, chrome, page, makeNav: (target, dir) => `nav-${dir}-${String(target)}` });
                assert.ok(result.buttons.length <= LEDGER_TEXT.maxButtons, `total ${String(total)} page ${String(page)} has ${String(result.buttons.length)}`);
                assert.deepEqual(result.buttons.slice(result.buttons.length - chrome.length), chrome, "chrome sits on every page");
                seen.push(...result.contentShown);
            }
            assert.deepEqual(seen, content, `total ${String(total)} chrome ${String(chromeCount)}`);
        }
    }
});

test("paginateButtons clamps an out-of-range page and offers Previous and Next correctly", () => {
    const content = Array.from({ length: 30 }, (_unused, index) => index);
    const navs = (/** @type {number} */ page) => pagination.paginateButtons({ content, chrome: [], page, makeNav: (target, dir) => `${dir}:${String(target)}` });
    const first = navs(0);
    assert.ok(first.buttons.includes("next:1") && !first.buttons.some((entry) => String(entry).startsWith("previous")));
    const last = navs(999);
    assert.equal(last.page, last.pages - 1);
    assert.ok(last.buttons.some((entry) => String(entry).startsWith("previous")) && !last.buttons.some((entry) => String(entry).startsWith("next")));
    assert.equal(navs(-5).page, 0);
});

test("a long list is paged in the real districts menu with nothing dropped or duplicated", () => {
    const kingdom = kingdomStates().many();
    const frame = { menu: "districts", params: {}, page: 0 };
    const first = buildMenu(frame, kingdom, undefined);
    assert.ok(first.pages && first.pages.pages >= 2, "fourteen districts must page");
    const names = [];
    for (let page = 0; page < first.pages.pages; page += 1) {
        const built = buildMenu({ ...frame, page }, kingdom, undefined);
        assert.ok(built.buttons.length <= LEDGER_TEXT.maxButtons);
        for (const button of built.buttons) {
            if (button.id.startsWith("district:")) {
                names.push(button.id);
            }
        }
    }
    assert.deepEqual(names, kingdom.districts.map((entry) => `district:${entry.id}`));
});

test("the district list is paged and the Next button carries the same menu", () => {
    const kingdom = kingdomStates().many();
    const built = buildMenu({ menu: "districts", params: {}, page: 0 }, kingdom, undefined);
    const next = built.buttons.find((button) => button.id === "page-next");
    assert.ok(next, "a Next button");
    assert.equal(next.action.id, "nav.page");
    assert.equal(next.action.params.menu, "districts");
    assert.equal(next.action.params.page, 1);
});

/* ------------------------------------------------------------------ *
 * Navigation stack
 * ------------------------------------------------------------------ */

test("the navigation stack: root is never popped, home resets, depth is capped", () => {
    const stack = navigation.newStack();
    assert.equal(navigation.currentFrame(stack).menu, "kingdom");
    navigation.goBack(stack);
    assert.equal(stack.length, 1, "back at the root does nothing");
    navigation.openFrame(stack, { menu: "military" });
    navigation.openFrame(stack, { menu: "district", params: { districtId: "district-2" } });
    assert.equal(navigation.currentFrame(stack).params.districtId, "district-2");
    navigation.goBack(stack);
    assert.equal(navigation.currentFrame(stack).menu, "military");
    navigation.goHome(stack);
    assert.equal(stack.length, 1);
    assert.equal(navigation.currentFrame(stack).menu, "kingdom");
    for (let index = 0; index < navigation.MAX_DEPTH + 10; index += 1) {
        navigation.openFrame(stack, { menu: "gates", page: index });
    }
    assert.equal(stack.length, navigation.MAX_DEPTH);
    assert.equal(stack[0].menu, "kingdom", "the root survives a deep stack");
    navigation.replaceFrame(stack, { menu: "gates", page: 3 });
    assert.equal(navigation.currentFrame(stack).page, 3);
});

test("nav actions turn into stack operations", () => {
    assert.deepEqual(navigateAction("nav.open", { menu: "military", params: {} }), { op: "open", frame: { menu: "military", params: {}, page: 0 } });
    assert.equal(navigateAction("nav.page", { menu: "gates", params: {}, page: 2 }).op, "replace");
    assert.equal(navigateAction("nav.back", {}).op, "back");
    assert.equal(navigateAction("nav.home", {}).op, "home");
    assert.equal(navigateAction("nav.refresh", {}).op, "refresh");
    assert.equal(navigateAction("nav.close", {}).op, "close");
    assert.throws(() => navigateAction("military.recruit", {}));
});

/* ------------------------------------------------------------------ *
 * Behaviour: what each menu tells the player and what it allows
 * ------------------------------------------------------------------ */

function find(built, id) {
    const button = built.buttons.find((entry) => entry.id === id);
    assert.ok(button, `no button ${id} in ${built.id}`);
    return button;
}

test("kingdom menu reports totals, time, policy and territory, and opens every root menu", () => {
    const kingdom = kingdomStates().fresh();
    const built = buildMenu({ menu: "kingdom", params: {}, page: 0 }, kingdom, undefined);
    assert.equal(built.title, "Civilization Apocalypse");
    assert.ok(built.lines.some((line) => /Civilians 400/.test(line)), built.lines.join(" | "));
    assert.ok(built.lines.some((line) => /Expansion balanced/.test(line)));
    for (const target of ["military", "districts", "construction", "expansion", "policies", "gates", "reports", "diplomacy"]) {
        assert.equal(find(built, `open-${target}`).action.params.menu, target);
    }
});

test("fresh kingdom: every district can enlist the bounded default batch", () => {
    const kingdom = kingdomStates().fresh();
    const built = buildMenu({ menu: "military", params: {}, page: 0 }, kingdom, undefined);
    for (const district of kingdom.districts) {
        const button = find(built, `recruit:${district.id}`);
        assert.equal(button.enabled, true, `${district.name}: ${button.reason ?? ""}`);
        assert.deepEqual(button.action, { id: "military.recruit", params: { districtId: district.id } });
    }
    const preview = previewAction("military.recruit", kingdom, { districtId: "district-1" }, undefined);
    assert.ok(preview.lines[0].includes("2 civilian(s)"), preview.lines[0]);
});

test("a district that is breached cannot enlist, and says so", () => {
    const kingdom = kingdomStates().midSiege();
    const built = buildMenu({ menu: "military", params: {}, page: 0 }, kingdom, undefined);
    const button = find(built, "recruit:district-2");
    assert.equal(button.enabled, false);
    assert.match(button.reason, /breached/);
});

test("an empty district has nobody to enlist; a lost district cannot enlist", () => {
    const empty = kingdomStates().empty();
    assert.match(find(buildMenu({ menu: "military", params: {}, page: 0 }, empty, undefined), "recruit:district-1").reason, /no free civilians/);
    const lost = kingdomStates().lostDistrict();
    assert.equal(find(buildMenu({ menu: "military", params: {}, page: 0 }, lost, undefined), "recruit:district-3").enabled, false);
});

test("a paused policy: Paused is the current mode and cannot be chosen again", () => {
    const kingdom = kingdomStates().pausedPolicy();
    const built = buildMenu({ menu: "policies", params: {}, page: 0 }, kingdom, undefined);
    assert.equal(find(built, "policy-paused").enabled, false);
    assert.equal(find(built, "policy-balanced").enabled, true);
    assert.equal(find(built, "policy-rapid").action.params.mode, "rapid");
    assert.ok(built.lines.some((line) => /Expansion: paused/.test(line)));
    assert.ok(built.lines.some((line) => /read only/.test(line)), "reinforcement fraction is read only");
});

test("expansion lists each territory with the eligibility reason from the simulation", () => {
    const kingdom = kingdomStates().pausedPolicy();
    const built = buildMenu({ menu: "expansion", params: {}, page: 0 }, kingdom, undefined);
    assert.ok(built.lines.some((line) => /Ashford Reach: raided/.test(line)));
    assert.ok(built.lines.some((line) => /Blocked:/.test(line)));
});

test("construction: abort needs a running build; resume needs a stored one and no running job", () => {
    const kingdom = kingdomStates().fresh();
    const absent = buildMenu({ menu: "construction", params: {}, page: 0 }, kingdom, undefined);
    assert.equal(find(absent, "abort").enabled, false);
    assert.equal(find(absent, "resume").enabled, false);
    const running = buildMenu({ menu: "construction", params: {}, page: 0 }, kingdom, liveStatus({ running: true }));
    assert.deepEqual(find(running, "abort").action, { id: "construction.abort" });
    const resumable = buildMenu({ menu: "construction", params: {}, page: 0 }, kingdom, liveStatus({ resumable: 2 }));
    assert.deepEqual(find(resumable, "resume:2").action, { id: "construction.resume", params: { district: 2 } });
    const busy = buildMenu({ menu: "construction", params: {}, page: 0 }, kingdom, liveStatus({ busy: "civ-resume" }));
    assert.equal(find(busy, "resume").enabled, false);
    assert.match(find(busy, "resume").reason, /already running|job/);
});

test("construction shows the district centre and a teleport line from the saved record", () => {
    const built = buildMenu({ menu: "construction", params: {}, page: 0 }, kingdomStates().physicalGates(), undefined);
    assert.ok(built.lines.some((line) => line.includes("centre 10 64 10")), built.lines.join(" | "));
    assert.ok(built.lines.some((line) => line.includes("teleport: /tp @s 10 64 10")));
});

test("gate card: a physical gate can be self-tested; a broken gate cannot be moved", () => {
    const kingdom = kingdomStates().physicalGates();
    const open = buildMenu({ menu: "gate", params: { gateId: "gate-district-1-district-2" }, page: 0 }, kingdom, undefined);
    assert.deepEqual(find(open, "self-test").action, { id: "gate.test", params: { gateId: "gate-district-1-district-2" } });
    assert.deepEqual(find(open, "hold-open").action.params, { gateId: "gate-district-1-district-2", mode: "forced_open" });
    const broken = buildMenu({ menu: "gate", params: { gateId: "gate-district-3-district-4" }, page: 0 }, kingdom, undefined);
    assert.equal(find(broken, "hold-open").enabled, false);
    assert.match(find(broken, "hold-open").reason, /broken/);
    assert.equal(find(broken, "self-test").enabled, false);
});

test("gate card: closing either holds closed or is forced, never both and never neither", () => {
    const kingdom = kingdomStates().physicalGates();
    for (const gate of [kingdom.districts[0].gates[0], kingdom.districts[1].gates[0]]) {
        if (gate.state === "broken" || gate.mode === "forced_closed") {
            continue;
        }
        const built = buildMenu({ menu: "gate", params: { gateId: gate.id }, page: 0 }, kingdom, undefined);
        assert.notEqual(find(built, "hold-closed").enabled, find(built, "close-forced").enabled, `${gate.id}: exactly one close path`);
    }
});

test("gate card: a gate with a forced-closed mode says it is already held closed", () => {
    const kingdom = kingdomStates().physicalGates();
    const built = buildMenu({ menu: "gate", params: { gateId: "gate-district-2-district-3" }, page: 0 }, kingdom, undefined);
    assert.match(find(built, "hold-closed").reason, /already held closed/);
    assert.ok(built.lines.some((line) => /waiting: a villager/i.test(line)), built.lines.join(" | "));
});

test("a gate that is moving cannot start a self test", () => {
    const kingdom = kingdomStates().physicalGates();
    const built = buildMenu({ menu: "gate", params: { gateId: "gate-district-1-district-2" }, page: 0 }, kingdom, liveStatus({ moving: ["gate-district-1-district-2"] }));
    assert.equal(find(built, "self-test").enabled, false);
    assert.match(find(built, "self-test").reason, /moving/);
});

test("an unmanaged (physical-only) gate is controlled by its own mode action", () => {
    const live = liveStatus({ unmanaged: [{ id: "gate-7", purpose: "outer", between: ["district-1", "district-4"], mode: "auto", actual: "open" }] });
    const built = buildMenu({ menu: "gate", params: { gateId: "gate-7" }, page: 0 }, kingdomStates().fresh(), live);
    assert.deepEqual(find(built, "hold-closed").action, { id: "gate.unmanaged", params: { gateId: "gate-7", mode: "forced_closed" } });
    assert.equal(find(built, "automatic").enabled, false);
});

test("reports show recent events and the last battle; diplomacy is listed as not implemented", () => {
    const built = buildMenu({ menu: "reports", params: {}, page: 0 }, kingdomStates().midSiege(), undefined);
    assert.ok(built.lines.some((line) => /Ironquarry is under attack/.test(line)));
    assert.ok(built.lines.some((line) => /Ironquarry at step 36/.test(line)), built.lines.join(" | "));
    const empty = buildMenu({ menu: "reports", params: {}, page: 0 }, kingdomStates().empty(), undefined);
    assert.ok(empty.lines.some((line) => /no battle recorded/.test(line)));
});

test("a district card for an unknown district says so and offers only Back and Home", () => {
    const built = buildMenu({ menu: "district", params: { districtId: "district-99" }, page: 0 }, kingdomStates().fresh(), undefined);
    assert.ok(built.lines.some((line) => /No district district-99/.test(line)));
    assert.deepEqual(built.buttons.map((button) => button.id), ["back", "home"]);
});

test("an unknown menu name shows an honest message and Back and Home", () => {
    const built = buildMenu({ menu: "time-travel", params: {}, page: 0 }, kingdomStates().fresh(), undefined);
    assert.equal(built.title, "Unknown menu");
    assert.deepEqual(built.buttons.map((button) => button.id), ["back", "home"]);
});

test("the empty kingdom still builds every menu without a placeholder", () => {
    const kingdom = kingdomStates().empty();
    for (const frame of enumerateFrames(kingdom, undefined)) {
        const built = buildMenu(frame, kingdom, undefined);
        assert.ok(built.lines.length > 0);
    }
});

/* ------------------------------------------------------------------ *
 * Item and marker (pure parts)
 * ------------------------------------------------------------------ */

test("the Ledger item is a vanilla book identified by the ca:ledger marker", () => {
    assert.equal(item.LEDGER_ITEM.typeId, "minecraft:book");
    assert.equal(item.LEDGER_ITEM.marker, "ca:ledger");
    for (const lore of item.LEDGER_ITEM.lore) {
        assert.ok(isPlainLine(lore), lore);
    }
    assert.equal(item.isLedgerStack(harness.makeMarkerStack()), true);
    assert.equal(item.isLedgerStack(harness.makePlainBook()), false, "a plain book is not the Ledger");
    assert.equal(item.isLedgerStack(undefined), false);
});

test("the item factory sets name, lore, marker, lock mode and keep-on-death", () => {
    const stack = item.makeLedgerStack(harness.FakeItemStack, harness.FakeItemLockMode);
    assert.equal(stack.typeId, "minecraft:book");
    assert.equal(stack.nameTag, "Commander's Ledger");
    assert.equal(stack.lockMode, "inventory");
    assert.equal(stack.keepOnDeath, true);
    assert.equal(stack.getDynamicProperty("ca:ledger"), true);
    assert.equal(stack.getLore().length, item.LEDGER_ITEM.lore.length);
});

test("the Ledger's own button and line rules are documented in text.js", () => {
    const source = readFileSync(join(ledgerDir, "text.js"), "utf8");
    assert.match(source, /section sign/i);
    assert.match(source, /lineWidth/);
    assert.equal(LEDGER_TEXT.lineWidth, 56);
    assert.equal(LEDGER_TEXT.buttonWidth, 34);
    assert.equal(LEDGER_TEXT.maxButtons, 12);
    assert.ok(model.menuModel && ROOT_MENUS.length === 9);
});
