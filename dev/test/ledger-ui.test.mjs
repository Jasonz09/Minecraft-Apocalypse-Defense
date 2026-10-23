// Commander's Ledger, part B: the runtime (ledger/runtime.js) against the offline harness.
//
// The runtime takes every Minecraft object as a dependency. These tests drive it with the fake world,
// fake forms and a tick clock from dev/lib/ledgerharness.mjs: item use, debounce, one form per
// player, busy retry, cancel, navigation, confirmation, results, recovery, full inventory, two
// players at once, and a player leaving while a form is open. A server stub that throws on any touch
// is installed first, so the file also proves that importing the runtime touches no world.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = join(root, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scripts, ...parts)).href;

const hooksSource = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server" || specifier === "@minecraft/server-ui") {
        const stub = 'const touched = (name) => { throw new Error("server object touched: " + name); };' +
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

const runtime = await import(fileUrl("ledger", "runtime.js"));
const { createLedgerUi, grantLedger, LEDGER_RUNTIME } = runtime;
const harness = await import(pathToFileURL(join(root, "dev", "lib", "ledgerharness.mjs")).href);
const { createLedgerHarness, kingdomStates, liveStatus, makeMarkerStack, makePlainBook, FakeItemStack, FakeItemLockMode } = harness;
const { LEDGER_EVENT_IDS } = await import(fileUrl("ledger", "ids.js"));

/** The index of a button label on the form on screen, or a miss that the test will see. */
function pick(label, misses = []) {
    return (/** @type {{ buttons: string[] }} */ shown) => {
        const index = shown.buttons.indexOf(label);
        if (index < 0) {
            misses.push(`no '${label}' among ${shown.buttons.join(" | ")}`);
            return { canceled: true, cancelationReason: "UserClosed" };
        }
        return { canceled: false, selection: index };
    };
}

const CLOSED = { canceled: true, cancelationReason: "UserClosed" };
const BUSY = { canceled: true, cancelationReason: "UserBusy" };

/** Opens the Ledger for a player with the item in hand, then lets the deferred show run. */
async function openFor(h, player) {
    h.world.emitItemUse({ source: player, itemStack: makeMarkerStack() });
    await h.advance(1);
}

function markerCount(player) {
    let count = 0;
    for (let slot = 0; slot < player.container.size; slot += 1) {
        const item = player.container.getItem(slot);
        if (item !== undefined && item.getDynamicProperty("ca:ledger") === true) {
            count += 1;
        }
    }
    return count;
}

/* ------------------------------------------------------------------ *
 * Import discipline and registration
 * ------------------------------------------------------------------ */

test("importing the runtime touches no world; the runtime file names no Minecraft package", () => {
    const source = readFileSync(join(scripts, "ledger", "runtime.js"), "utf8");
    assert.doesNotMatch(source, /@minecraft\//);
    assert.doesNotMatch(source, /\bconsole\./);
    assert.doesNotMatch(source, /playerSpawn|worldInitialize|worldLoad/, "no world-start hook and no join grant");
    assert.equal(typeof createLedgerUi, "function");
});

test("creating the runtime with dependencies that throw on access does not touch them", () => {
    const bomb = new Proxy({}, { get: (_target, property) => { throw new Error(`touched ${String(property)}`); } });
    assert.doesNotThrow(() => createLedgerUi({ world: bomb, system: bomb, ui: bomb, ItemStack: FakeItemStack, ItemLockMode: FakeItemLockMode, kingdomStore: bomb, services: undefined }));
});

test("register subscribes item use, player leave and the recovery id once, and only once", () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    assert.equal(ui.register(), true);
    assert.equal(ui.register(), false, "second registration does nothing");
    assert.deepEqual(h.world.subscriberCounts(), { itemUse: 1, playerLeave: 1 });
    assert.equal(h.system.scriptSubscribers.length, 1);
    assert.deepEqual(h.system.scriptSubscribers[0].options, { namespaces: ["civ"] });
});

test("the recovery id is handled, and only that id", () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const handler = h.system.scriptSubscribers[0].callback;
    handler({ id: "civ:generate_status", sourceEntity: alex });
    assert.equal(markerCount(alex), 0, "another command is not the Ledger's");
    handler({ id: LEDGER_EVENT_IDS.recover, sourceEntity: alex });
    assert.equal(markerCount(alex), 1);
});

test("the timing constants sit inside the documented ranges", () => {
    assert.ok(LEDGER_RUNTIME.debounceTicks >= 5 && LEDGER_RUNTIME.debounceTicks <= 10);
    assert.ok(LEDGER_RUNTIME.busyRetryTicks >= 10 && LEDGER_RUNTIME.busyRetryTicks <= 20);
    assert.equal(LEDGER_RUNTIME.busyWindowTicks, 100);
});

/* ------------------------------------------------------------------ *
 * Item use
 * ------------------------------------------------------------------ */

test("using the Ledger opens it at the Kingdom menu, from a deferred show, not in the event", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    assert.equal(h.forms.shown.length, 0, "nothing is shown inside the event");
    h.forms.script.push(CLOSED);
    await h.advance(1);
    assert.equal(h.forms.shown.length, 1);
    assert.equal(h.forms.shown[0].title, "Civilization Apocalypse");
    assert.equal(h.forms.shown[0].kind, "action");
});

test("a plain book, a non-player source and an empty use open nothing", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.world.emitItemUse({ source: alex, itemStack: makePlainBook() });
    h.world.emitItemUse({ source: { typeId: "minecraft:zombie", id: "z1", sendMessage: () => undefined }, itemStack: makeMarkerStack() });
    h.world.emitItemUse({ source: alex, itemStack: undefined });
    await h.advance(3);
    assert.equal(h.forms.shown.length, 0);
    assert.equal(ui.openCount(), 0);
});

test("debounce: a second use within the window is ignored; after it, a use opens again", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.forms.script.push(CLOSED, CLOSED);
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    await h.advance(1);
    assert.equal(h.forms.shown.length, 1, "two uses in one tick make one form");
    await h.advance(2);
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    await h.advance(1);
    assert.equal(h.forms.shown.length, 1, "still inside the debounce window");
    await h.advance(LEDGER_RUNTIME.debounceTicks);
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    await h.advance(1);
    assert.equal(h.forms.shown.length, 2, "after the window the Ledger opens again");
});

test("one open form per player: a use while the form is open does nothing", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.forms.script.push("pending");
    await openFor(h, alex);
    assert.equal(ui.isOpen(alex.id), true);
    await h.advance(LEDGER_RUNTIME.debounceTicks + 5);
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    await h.advance(3);
    assert.equal(h.forms.shown.length, 1, "no second form while one is open");
    assert.equal(ui.openCount(), 1);
});

test("two players can use the Ledger at the same moment, with separate stacks", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const sam = h.player("Sam");
    const misses = [];
    h.forms.script.push(pick("Military", misses), "pending", "pending");
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    h.world.emitItemUse({ source: sam, itemStack: makeMarkerStack() });
    await h.advance(1);
    await h.advance(1);
    assert.deepEqual(misses, []);
    assert.equal(ui.openCount(), 2, "both players have a form open");
    assert.equal(ui.stackOf(alex.id).at(-1).menu, "military", "Alex is on Military");
    assert.equal(ui.stackOf(sam.id).at(-1).menu, "kingdom", "Sam is still at the root");
    const titles = h.forms.shown.map((entry) => `${entry.playerId}:${entry.title}`);
    assert.ok(titles.includes(`${alex.id}:Military`) && titles.includes(`${sam.id}:Civilization Apocalypse`), titles.join(", "));
});

/* ------------------------------------------------------------------ *
 * Busy, cancel, leave
 * ------------------------------------------------------------------ */

test("busy retry: a form answered busy is shown again on the retry interval until it is answered", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.forms.script.push(BUSY, BUSY, "pending");
    await openFor(h, alex);
    assert.equal(h.forms.shown.length, 1);
    await h.advance(LEDGER_RUNTIME.busyRetryTicks - 1);
    assert.equal(h.forms.shown.length, 1, "not before the interval");
    await h.advance(1);
    assert.equal(h.forms.shown.length, 2);
    await h.advance(LEDGER_RUNTIME.busyRetryTicks);
    assert.equal(h.forms.shown.length, 3);
    assert.equal(ui.isOpen(alex.id), true, "still waiting for the player");
    assert.equal(alex.messages.length, 0);
});

test("busy retry gives up after the window and tells the player once", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.forms.setDefault(BUSY);
    await openFor(h, alex);
    await h.advance(LEDGER_RUNTIME.busyWindowTicks + LEDGER_RUNTIME.busyRetryTicks * 2);
    assert.equal(ui.isOpen(alex.id), false, "the Ledger stopped trying");
    assert.equal(alex.messages.length, 1);
    assert.match(alex.messages[0], /did not open/);
    const shownBefore = h.forms.shown.length;
    await h.advance(LEDGER_RUNTIME.busyWindowTicks);
    assert.equal(h.forms.shown.length, shownBefore, "no retry after giving up");
});

test("cancel: a form closed by the player ends the session and a later use opens afresh", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.forms.script.push(pick("Military"), CLOSED);
    await openFor(h, alex);
    await h.advance(1);
    assert.equal(ui.isOpen(alex.id), false, "closing ends the session");
    await h.advance(LEDGER_RUNTIME.debounceTicks);
    h.forms.script.push(CLOSED);
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    await h.advance(1);
    assert.equal(h.forms.shown.at(-1).title, "Civilization Apocalypse", "a fresh session starts at the root");
});

test("a player who leaves while a form is open loses the session, and nothing throws", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.forms.script.push("pending");
    await openFor(h, alex);
    assert.equal(ui.isOpen(alex.id), true);
    assert.doesNotThrow(() => h.world.emitPlayerLeave({ playerId: alex.id, playerName: alex.name }));
    assert.equal(ui.isOpen(alex.id), false);
    assert.doesNotThrow(() => ui.handlePlayerLeave({}));
    assert.doesNotThrow(() => ui.handlePlayerLeave(undefined));
});

test("a form that cannot be shown (the player is gone) is dropped quietly", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.forms.gone.add(alex.id);
    h.world.emitItemUse({ source: alex, itemStack: makeMarkerStack() });
    await h.advance(2);
    assert.equal(ui.isOpen(alex.id), false, "the session is dropped");
    assert.equal(h.forms.shown.length, 0, "no form was recorded for a player who is gone");
    assert.equal(h.system.failures.length, 0, "no task failed");
});

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

test("navigation: root to Military, Back to the root, then Home from a deep menu", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Military", misses), pick("Back", misses), pick("Districts", misses), pick("Hearthgate", misses), pick("Home", misses), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 6; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    const titles = h.forms.shown.map((entry) => entry.title);
    assert.deepEqual(titles.slice(0, 6), ["Civilization Apocalypse", "Military", "Civilization Apocalypse", "Districts", "Hearthgate", "Civilization Apocalypse"]);
    assert.equal(ui.stackOf(alex.id).length, 1, "Home leaves only the root");
});

test("a disabled button is refused with its reason and the same menu comes back", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().midSiege() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Military", misses), pick("Recruit in Ironquarry (unavailable)", misses), "pending");
    await openFor(h, alex);
    await h.advance(1);
    await h.advance(1);
    assert.deepEqual(misses, []);
    const again = h.forms.shown.at(-1);
    assert.equal(again.title, "Military");
    assert.match(again.body, /Unavailable: security 'breached'/);
    assert.equal(h.store.saves.length, 0);
});

/* ------------------------------------------------------------------ *
 * Confirmation and results
 * ------------------------------------------------------------------ */

test("a world change needs a confirm: cancelling saves nothing and returns to the menu", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Military", misses), pick("Recruit in Hearthgate", misses), pick("Cancel", misses), "pending");
    await openFor(h, alex);
    await h.advance(1);
    await h.advance(1);
    await h.advance(1);
    assert.deepEqual(misses, []);
    const confirm = h.forms.shown.find((entry) => entry.kind === "message");
    assert.ok(confirm, "a two-button confirm was shown");
    assert.deepEqual(confirm.buttons, ["Recruit", "Cancel"]);
    assert.match(confirm.body, /2 civilian\(s\) enter training in Hearthgate/);
    assert.equal(h.forms.shown.at(-1).title, "Military", "Cancel returns to Military");
    assert.equal(h.store.saves.length, 0, "nothing was saved");
});

test("a confirmed recruitment saves the kingdom, shows the result, and Back returns to the menu", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Military", misses), pick("Recruit in Hearthgate", misses), pick("Recruit", misses), pick("Back", misses), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 5; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    assert.equal(h.store.saves.length, 1);
    const saved = h.store.peek();
    assert.equal(saved.districts[0].trainingQueue, 2);
    assert.equal(saved.districts[0].civilians, 78);
    const result = h.forms.shown.find((entry) => entry.title === "Recruited in Hearthgate");
    assert.ok(result, "the result is shown");
    assert.match(result.body, /2 recruit\(s\) entered training/);
    assert.equal(h.forms.shown.at(-1).title, "Military");
});

test("a stale view is refused on confirm and nothing is saved", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    const contested = kingdomStates().fresh();
    contested.districts[0].security = "contested";
    h.forms.script.push(pick("Military", misses), pick("Recruit in Hearthgate", misses), () => {
        h.store.save(contested);
        return { canceled: false, selection: 0 };
    }, "pending");
    await openFor(h, alex);
    for (let step = 0; step < 3; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    const refused = h.forms.shown.find((entry) => entry.title === "Not done");
    assert.ok(refused, "a refusal is shown");
    assert.match(refused.body, /Refused: recruitment is suspended/);
    assert.equal(h.store.saves.length, 1, "only the test's own save happened");
});

test("a failed save is reported and the kingdom is left as it was", async () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const before = JSON.stringify(h.store.peek());
    h.store.setFailSaves(true);
    h.forms.script.push(pick("Military"), pick("Recruit in Hearthgate"), pick("Recruit"), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 4; step += 1) {
        await h.advance(1);
    }
    const shown = h.forms.shown.find((entry) => entry.title === "Not done");
    assert.ok(shown, "the save failure is shown as a refusal");
    assert.match(shown.body, /could not be saved/);
    assert.equal(JSON.stringify(h.store.peek()), before, "the stored kingdom is unchanged");
});

/** Picks a gate from the Gates list by its id. */
function gateCardPick(gateId, misses) {
    return (shown) => {
        const index = shown.buttons.indexOf(`Gate ${gateId}`);
        if (index < 0) {
            misses.push(`no gate ${gateId} on the list`);
            return CLOSED;
        }
        return { canceled: false, selection: index };
    };
}

test("a gate change saves first, then the physical gate is retried and pumped once", async () => {
    const services = harness.createServices();
    const h = createLedgerHarness({ kingdom: kingdomStates().physicalGates(), services, live: liveStatus() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    const gate = "gate-district-1-district-2";
    // Closing this gate is not harmless, so the card offers the forced path only: that is the path under test.
    h.forms.script.push(pick("Gates", misses), gateCardPick(gate, misses), pick("Close anyway (forced)", misses), pick("Close", misses), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 5; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    assert.equal(h.store.peek().districts[0].gates.find((entry) => entry.id === gate).mode, "forced_closed");
    const names = services.calls.map((entry) => entry.name);
    assert.equal(names.filter((name) => name === "gates.retryNow").length, 1);
    assert.equal(names.filter((name) => name === "gates.pump").length, 1);
    assert.ok(names.indexOf("gates.retryNow") < names.indexOf("gates.pump"), names.join(", "));
    assert.equal(services.calls.find((entry) => entry.name === "gates.retryNow").args[0], gate);
});

test("a gate whose blocks already head that way is saved but not poked", async () => {
    const services = harness.createServices();
    const h = createLedgerHarness({ kingdom: kingdomStates().physicalGates(), services, live: liveStatus() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Gates", misses), gateCardPick("gate-district-2-district-3", misses), pick("Hold open", misses), pick("Apply", misses), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 5; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    assert.equal(h.store.peek().districts[1].gates[0].mode, "forced_open");
    assert.equal(services.calls.filter((entry) => entry.name === "gates.retryNow").length, 0, "the blocks were already heading that way");
});

test("a self test starts through the service and its report goes to the player's chat", async () => {
    const services = harness.createServices();
    const h = createLedgerHarness({ kingdom: kingdomStates().physicalGates(), services, live: liveStatus() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Gates", misses), gateCardPick("gate-district-2-district-3", misses), pick("Run a self test", misses), pick("Start test", misses), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 5; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    assert.ok(services.calls.some((entry) => entry.name === "gates.startSelfTest"));
    assert.ok(alex.messages.some((message) => /Self test of gate-district-2-district-3: passed/.test(message)), alex.messages.join(" | "));
});

test("construction abort stops the running build through the service and reports the lines", async () => {
    const services = harness.createServices({ sessionRunning: true });
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh(), services, live: liveStatus({ running: true }) });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Construction", misses), pick("Stop the build", misses), pick("Stop build", misses), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 4; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    assert.ok(services.calls.some((entry) => entry.name === "civ.abort"));
    const result = h.forms.shown.find((entry) => entry.title === "Build stopped");
    assert.ok(result, "the stop is reported");
    assert.match(result.body, /Build stopped after 4 of 10 operations/);
});

test("resume runs through the service with the district index", async () => {
    const services = harness.createServices();
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh(), services, live: liveStatus({ resumable: 2 }) });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    const misses = [];
    h.forms.script.push(pick("Construction", misses), pick("Resume district-2", misses), pick("Resume", misses), "pending");
    await openFor(h, alex);
    for (let step = 0; step < 4; step += 1) {
        await h.advance(1);
    }
    assert.deepEqual(misses, []);
    assert.deepEqual(services.calls.find((entry) => entry.name === "civ.resume").args, [2]);
});

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

test("recovery gives one Ledger to a player without one, and is idempotent", () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    const alex = h.player("Alex");
    const first = ui.handleRecoverCommand({ sourceEntity: alex });
    assert.equal(first.status, "granted");
    assert.equal(markerCount(alex), 1);
    const stack = alex.container.getItem(first.slot);
    assert.equal(stack.typeId, "minecraft:book");
    assert.equal(stack.nameTag, "Commander's Ledger");
    assert.equal(stack.lockMode, "inventory");
    assert.equal(stack.keepOnDeath, true);
    const second = ui.handleRecoverCommand({ sourceEntity: alex });
    assert.equal(second.status, "already-held");
    assert.equal(markerCount(alex), 1, "still exactly one");
    assert.match(alex.messages.at(-1), /already carry/);
});

test("recovery never grants to a source that is not a player", () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    assert.equal(ui.handleRecoverCommand({ sourceEntity: undefined }).status, "not-a-player");
    assert.equal(ui.handleRecoverCommand({ sourceEntity: { typeId: "minecraft:armor_stand" } }).status, "not-a-player");
});

test("a full inventory drops the Ledger at the player's feet", () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    const alex = h.player("Alex", { slots: 2, location: { x: 4, y: 70, z: -3 } });
    alex.container.setItem(0, new FakeItemStack("minecraft:stone", 64));
    alex.container.setItem(1, new FakeItemStack("minecraft:dirt", 64));
    const outcome = ui.handleRecoverCommand({ sourceEntity: alex });
    assert.equal(outcome.status, "dropped");
    assert.equal(alex.spawned.length, 1);
    assert.deepEqual(alex.spawned[0].location, { x: 4, y: 70, z: -3 });
    assert.equal(alex.spawned[0].stack.getDynamicProperty("ca:ledger"), true);
    assert.equal(markerCount(alex), 0, "the inventory is untouched");
    assert.match(alex.messages.at(-1), /dropped at your feet/);
});

test("grantLedger reports a missing inventory honestly", () => {
    const player = { getComponent: () => undefined, dimension: { spawnItem: () => undefined }, location: {} };
    const outcome = grantLedger(player, { ItemStack: FakeItemStack, ItemLockMode: FakeItemLockMode });
    assert.equal(outcome.status, "no-inventory");
});

test("the Ledger is never handed out on join: a join creates no item", () => {
    const h = createLedgerHarness({ kingdom: kingdomStates().fresh() });
    const ui = createLedgerUi(h.deps);
    ui.register();
    const alex = h.player("Alex");
    h.world.emitItemUse({ source: alex, itemStack: undefined });
    assert.equal(markerCount(alex), 0);
});
