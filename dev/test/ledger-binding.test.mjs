// Commander's Ledger, part C: the binding (integration/ledgerBindings.js) and the development gate, through the
// real entry point (main.js) against the offline harness in dev/lib/ledgerharness.mjs.
//
// The fakes stand in for "@minecraft/server" and "@minecraft/server-ui" through a resolution hook. The world,
// the system and the forms are the harness's own, so the Ledger's real code runs unchanged. Covered here:
//   - the gate is off at load: no item-use or leave handler, no recovery, no item, no form;
//   - `civ:ledger_devgate on` registers the Ledger at once; `off` makes the item and the recovery refuse;
//   - the item is granted only by an explicit recovery and never twice; a use alone grants nothing;
//   - a world whose gate is on at load registers the Ledger on the first tick (a child process, because module
//     state is per process);
//   - static rules: only the binding imports the UI module, the Ledger modules never import the server module,
//     no `console` in pack code, and the whole pack typechecks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = join(root, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scripts, ...parts)).href;
const load = (...parts) => import(fileUrl(...parts));

const harness = await import(pathToFileURL(join(root, "dev", "lib", "ledgerharness.mjs")).href);
const { createClock, createSystem, createWorld, createPlayer, createFormKit, makeMarkerStack, makePlainBook, FakeItemLockMode, FakeItemStack } = harness;

// ---- fake runtime -------------------------------------------------------------------
const clock = createClock(1000);
const system = createSystem(clock);
const world = createWorld(system);
const forms = createFormKit();
const props = new Map();
const worldMessages = [];

Object.assign(world, {
    getDynamicProperty: (key) => props.get(key),
    setDynamicProperty(key, value) {
        if (value === undefined) {
            props.delete(key);
        } else {
            props.set(key, value);
        }
    },
    getDynamicPropertyIds: () => [...props.keys()],
    getDimension: (name) => ({ id: name }),
    sendMessage: (message) => worldMessages.push(message),
});
world.afterEvents.playerSpawn = { subscribe: () => undefined };
system.runInterval = () => 1;
system.clearRun = () => undefined;
const scriptSubscribers = system.scriptSubscribers;

const SERVER_NAMES = ["BlockPermutation", "ItemLockMode", "ItemStack", "ScriptEventSource", "system", "world"];
const UI_NAMES = ["ActionFormData", "MessageFormData"];
globalThis.__ledgerBind = {
    world,
    system,
    ui: forms.ui,
    ItemStack: FakeItemStack,
    ItemLockMode: FakeItemLockMode,
    BlockPermutation: { resolve: () => { throw new Error("BlockPermutation is not used by the Ledger"); } },
    ScriptEventSource: { Block: "Block", Entity: "Entity", NPCDialogue: "NPCDialogue", Server: "Server" },
};
const SERVER_STUB = SERVER_NAMES.map((name) => `export const ${name} = globalThis.__ledgerBind.${name};`).join("\n");
const UI_STUB = UI_NAMES.map((name) => `export const ${name} = globalThis.__ledgerBind.ui.${name};`).join("\n");
const hooksSource = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(SERVER_STUB)}), shortCircuit: true };
    }
    if (specifier === "@minecraft/server-ui") {
        return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(UI_STUB)}), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooksSource));

const { STORAGE_KEYS } = await load("config.js");
const { createInitialKingdom, serializeKingdom } = await load("kingdom", "state.js");
const { LEDGER_DEV_GATE_KEY, LEDGER_EVENT_IDS } = await load("ledger", "ids.js");
const { GATE_OFF_LINES } = await load("ledger", "runtime.js");

/** Delivers a script event to every subscriber whose namespace filter matches, as the engine does. */
function scriptEvent(id, message, player) {
    const namespace = id.split(":")[0];
    const event = { id, message, sourceType: "Entity", initiator: player, sourceEntity: player };
    for (const { callback, options } of [...scriptSubscribers]) {
        if (options?.namespaces === undefined || options.namespaces.includes(namespace)) {
            callback(event);
        }
    }
}

/** Ledger items a player carries. */
function ledgerCount(player) {
    return player.container.slots.filter((slot) => slot !== undefined && slot.getDynamicProperty("ca:ledger") === true).length;
}

// ---- the child process: the gate is ON when the pack loads ----------------------------
if (process.env.LEDGER_BINDING_CHILD === "gate-on-at-load") {
    props.set(LEDGER_DEV_GATE_KEY, true);
    props.set(STORAGE_KEYS.kingdom, serializeKingdom(createInitialKingdom()));
    await import(fileUrl("main.js"));
    await system.advance(1);
    const player = createPlayer(world, { name: "Child" });
    scriptEvent(LEDGER_EVENT_IDS.recover, "", player);
    const report = {
        itemUse: world.subscriberCounts().itemUse,
        playerLeave: world.subscriberCounts().playerLeave,
        granted: ledgerCount(player),
    };
    await new Promise((done) => process.stdout.write(`${JSON.stringify(report)}\n`, done));
    process.exit(0);
}

// ---- the parent: main.js loads with the gate OFF (the default) --------------------------
props.set(STORAGE_KEYS.kingdom, serializeKingdom(createInitialKingdom()));
await import(fileUrl("main.js"));
await system.advance(1);

test("gate off at load: no Ledger item-use or leave handler, and the recovery command does nothing", async () => {
    // The horn's own use handler is always on (integration/beaconBindings.js); the Ledger's is not.
    assert.deepEqual(world.subscriberCounts(), { itemUse: 1, playerLeave: 0 }, "only the horn listens; the Ledger's own world handlers are not registered");
    const player = createPlayer(world, { name: "Idle" });
    scriptEvent(LEDGER_EVENT_IDS.recover, "", player);
    await system.advance(1);
    assert.equal(ledgerCount(player), 0, "no item is granted by the recovery command while the gate is off");
    assert.deepEqual(player.messages, [], "nothing is said to the player: the Ledger was never registered");
    assert.equal(props.get(LEDGER_DEV_GATE_KEY), undefined, "the gate property is absent by default");
});

test("gate off at load: no item is granted at join or at pack activation, and a use opens no form", async () => {
    const player = createPlayer(world, { name: "Joiner" });
    await system.advance(30);
    assert.equal(ledgerCount(player), 0, "nothing is granted at join or at pack activation");
    world.emitItemUse({ source: player, itemStack: makeMarkerStack() });
    await system.advance(2);
    assert.equal(forms.shown.length, 0, "no form is shown");
});

test("the development switch listens while the gate is off; 'on' turns the gate on and registers the Ledger at once", async () => {
    const admin = createPlayer(world, { name: "Admin" });
    scriptEvent(LEDGER_EVENT_IDS.devgate, "on", admin);
    await system.advance(1);
    assert.equal(props.get(LEDGER_DEV_GATE_KEY), true, "the gate property is on");
    assert.match(admin.messages.join("\n"), /development gate is on/, "the operator is told the gate is on");
    assert.deepEqual(world.subscriberCounts(), { itemUse: 2, playerLeave: 1 }, "the Ledger registered its handlers next to the horn's");

    scriptEvent(LEDGER_EVENT_IDS.devgate, "on", admin);
    assert.deepEqual(world.subscriberCounts(), { itemUse: 2, playerLeave: 1 }, "a second 'on' adds no duplicate handler");
});

test("gate on: a use opens the Ledger; a use alone grants no item; a plain book opens nothing", async () => {
    const ada = createPlayer(world, { name: "Ada" });
    world.emitItemUse({ source: ada, itemStack: makePlainBook() });
    await system.advance(10);
    assert.equal(forms.shown.length, 0, "a plain book is not the Ledger");

    world.emitItemUse({ source: ada, itemStack: makeMarkerStack() });
    await system.advance(2);
    assert.equal(forms.shown.length, 1, "the Ledger's first form is shown");
    assert.equal(ledgerCount(ada), 0, "using the item grants nothing");
});

test("gate on: the item is granted only by an explicit recovery, and a second recovery grants nothing more", () => {
    const ada = createPlayer(world, { name: "Ada2" });
    scriptEvent(LEDGER_EVENT_IDS.recover, "", ada);
    assert.equal(ledgerCount(ada), 1, "the first recovery gives one Ledger");
    assert.match(ada.messages.join("\n"), /in your inventory/);

    scriptEvent(LEDGER_EVENT_IDS.recover, "", ada);
    assert.equal(ledgerCount(ada), 1, "the second recovery is idempotent");
    assert.match(ada.messages.join("\n"), /already carry/);
});

test("gate off again: the item use and the recovery both refuse with the clear message, and grant nothing", async () => {
    const admin = createPlayer(world, { name: "Admin2" });
    scriptEvent(LEDGER_EVENT_IDS.devgate, "off", admin);
    assert.equal(props.get(LEDGER_DEV_GATE_KEY), false, "the gate property is off");
    assert.match(admin.messages.join("\n"), /development gate is off/);

    const newcomer = createPlayer(world, { name: "Newcomer" });
    scriptEvent(LEDGER_EVENT_IDS.recover, "", newcomer);
    assert.equal(ledgerCount(newcomer), 0, "the recovery refuses while the gate is off");
    assert.deepEqual(newcomer.messages, [GATE_OFF_LINES.join("\n")], "the refusal names the gate and the command");

    const holder = createPlayer(world, { name: "Holder" });
    scriptEvent(LEDGER_EVENT_IDS.recover, "", holder);
    assert.equal(ledgerCount(holder), 0, "a holder of an old Ledger is refused too, and nothing is granted");
    const shownBefore = forms.shown.length;
    await system.advance(10);
    world.emitItemUse({ source: holder, itemStack: makeMarkerStack() });
    await system.advance(2);
    assert.equal(forms.shown.length, shownBefore, "no form opens while the gate is off");
    assert.match(holder.messages.join("\n"), /switched off in this build/, "the item use says why it does nothing");
});

test("unknown switch arguments are refused with usage and change nothing", () => {
    const admin = createPlayer(world, { name: "Admin3" });
    props.set(LEDGER_DEV_GATE_KEY, false);
    scriptEvent(LEDGER_EVENT_IDS.devgate, "maybe", admin);
    assert.equal(props.get(LEDGER_DEV_GATE_KEY), false, "the gate did not change");
    assert.match(admin.messages.join("\n"), /Usage: scriptevent civ:ledger_devgate on\|off/);
});

// ---- the child process: gate on at load -------------------------------------------------
test("a world whose gate is on at load registers the Ledger on the first tick", () => {
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: root,
        env: { ...env, LEDGER_BINDING_CHILD: "gate-on-at-load" },
        encoding: "utf8",
        timeout: 120000,
    });
    assert.equal(child.status, 0, `child exited ${String(child.status)}: ${child.stderr}`);
    const report = JSON.parse(child.stdout.trim().split("\n").pop());
    assert.deepEqual({ itemUse: report.itemUse, playerLeave: report.playerLeave }, { itemUse: 2, playerLeave: 1 }, "the horn's handler plus the Ledger's, registered on the first tick");
    assert.equal(report.granted, 1, "the recovery command works once the gate is on at load");
});

// ---- static rules -----------------------------------------------------------------------
function walk(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...walk(full));
        } else if (entry.name.endsWith(".js")) {
            found.push(full);
        }
    }
    return found;
}

test("only the two binding files import @minecraft/server-ui", () => {
    const importers = walk(scripts)
        .filter((file) => /from\s*"@minecraft\/server-ui"/.test(readFileSync(file, "utf8")))
        .map((file) => relative(scripts, file).split("\\").join("/"))
        .sort();
    assert.deepEqual(importers, ["integration/beaconBindings.js", "integration/ledgerBindings.js"], "every UI use is confined to an integration binding, so a broken UI pin cannot spread through the pack");
});

test("the Ledger modules never import a Minecraft module: the binding is the only Minecraft-facing file", () => {
    const ledgerFiles = walk(join(scripts, "ledger"));
    assert.ok(ledgerFiles.length > 5, "the ledger folder is scanned");
    for (const file of ledgerFiles) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /from\s*"@minecraft\//, `${relative(scripts, file)} must not import a Minecraft module`);
    }
});

test("no console identifier in pack code", () => {
    for (const file of walk(scripts)) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /\bconsole\s*\./, `${relative(scripts, file)} uses console`);
    }
});

test("the whole pack typechecks (npm run typecheck)", () => {
    const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], {
        cwd: root,
        encoding: "utf8",
        timeout: 300000,
    });
    assert.equal(result.status, 0, `tsc reported errors:\n${result.stdout}${result.stderr}`);
});
