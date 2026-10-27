// The one door between the hourly kingdom simulation and entities: the gate's default, the isolation from a
// running district build, and fault isolation between drivers. Offline only (dev/lib/civharness.mjs fake world).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CIV_EVENT_IDS, districtBuilder, load, makePlayer, mc, resetWorld, scriptsRoot, send, store, text } from "../lib/civharness.mjs";

const gate = await load("people", "gate.js");
const runtime = await load("integration", "peopleRuntime.js");
const peopleCommand = await load("commands", "people.js");

// The switch subscribes once per process, so the command tests share this runtime instance.
const switched = runtime.createPeopleRuntime(store);
assert.equal(peopleCommand.registerPeopleCommand(switched), true, "the first registration subscribes");
assert.equal(peopleCommand.registerPeopleCommand(switched), false, "registering twice does not double-subscribe");

/** @param {(ctx: any) => (number | void)} [work] */
function recorder(id, work) {
    /** @type {any[]} */
    const calls = [];
    return {
        calls,
        driver: {
            id,
            onHour: (ctx) => {
                calls.push(ctx);
                return work === undefined ? 1 : work(ctx);
            },
        },
    };
}

/** A world whose gate is on, with no district build running. */
function inhabited() {
    resetWorld(1);
    mc.props.set("civ_people", true);
    return runtime.createPeopleRuntime(store);
}

test("the gate is off by default, and an off hour is a teardown hour, not a skipped one", () => {
    assert.equal(gate.peopleGateOn(undefined), false, "no world at all is off");
    assert.equal(gate.peopleGateOn({ getDynamicProperty() { throw new Error("world not ready"); } }), false, "an unreadable world is off, not a crash");
    resetWorld(1);
    assert.notEqual(store.load().kingdom, undefined, "a stored kingdom, so a refusal below is a refusal and not an early exit");
    const off = runtime.createPeopleRuntime(store);
    const seen = recorder("walker");
    off.register(seen.driver);
    off.onStep({ ran: 1 });
    // "Off" has to mean "nobody is standing in the street". 2.7.0 gives no removal event to clean up after,
    // so the driver must be reached with the gate off or its own citizens would linger forever.
    assert.equal(seen.calls.length, 1, "the driver still runs, to remove what it owns");
    assert.equal(seen.calls[0].gateOn, false, "and it is told which way the gate is");
    assert.equal(off.stats.teardownHours, 1);
    assert.equal(off.stats.hours, 1);
});

test("a world with no driver wired does no world work at all, gate or no gate", () => {
    resetWorld(1);
    const bare = runtime.createPeopleRuntime(store);
    bare.onStep({ ran: 1 });
    assert.equal(bare.stats.hours, 0, "nothing registered, nothing ran");
    mc.props.set("civ_people", true);
    try {
        bare.onStep({ ran: 1 });
        assert.equal(bare.stats.hours, 0, "an on gate with no driver is still inert");
    } finally {
        mc.props.delete("civ_people");
    }
});

test("with the gate on, a driver runs once per hour and its entity changes are reported", () => {
    const live = inhabited();
    const seen = recorder("walker");
    const quiet = recorder("silent", () => 0);
    live.register(seen.driver);
    live.register(quiet.driver);
    live.onStep({ ran: 1 });
    live.onStep({ ran: 1 });
    assert.equal(seen.calls.length, 2, "one pass per accepted hour");
    assert.equal(seen.calls[0].kingdom.districts.length, 5, "the driver sees the saved kingdom");
    assert.equal(seen.calls[0].dimension, mc.world.getDimension("overworld"), "the driver gets the overworld");
    const lines = live.statusLines().join("\n");
    assert.match(lines, /walker: 2 hour\(s\), 2 entity change/);
    assert.match(lines, /silent: 2 hour\(s\), 0 entity change/);
});

test("a driver that throws is counted and skipped - the simulation loop survives it", () => {
    const live = inhabited();
    const bad = recorder("broken", () => {
        throw new Error("entity exploded");
    });
    const good = recorder("healthy");
    live.register(bad.driver);
    live.register(good.driver);
    live.onStep({ ran: 1 });
    assert.equal(good.calls.length, 1, "the next driver still ran");
    assert.match(live.statusLines().join("\n"), /broken: 1 hour\(s\).*last error Error: entity exploded/);
    assert.match(live.statusLines().join("\n"), /Last error: broken: Error: entity exploded/);
});

test("no people walk the streets while a district build holds the world", () => {
    const live = inhabited();
    const seen = recorder("walker");
    live.register(seen.driver);
    const token = districtBuilder.reserveJob("civ-build");
    assert.ok(token, "the job slot is taken");
    live.onStep({ ran: 1 });
    assert.equal(seen.calls.length, 0, "the build's slice budget and ticking areas are not shared mid-hour");
    assert.equal(live.stats.refusedBusy, 1);
    districtBuilder.finishJob(token);
    live.onStep({ ran: 1 });
    assert.equal(seen.calls.length, 1, "the hour after the build finishes runs again");
});

test("main.js wires the streets driver, so the pack's one door has something behind it", () => {
    const source = readFileSync(join(scriptsRoot, "main.js"), "utf8");
    assert.match(source, /peopleRuntime\.register\(createPeopleStreets\(\)\)/, "the streets driver is registered in main.js");
    assert.match(source, /startSimulationLoop\(kingdomStore, \{ onStep:/, "and the loop reports each hour to the runtime");
});

test("a driver must be a real driver, and two drivers cannot share an id", () => {
    const live = inhabited();
    assert.throws(() => live.register({ id: "nope" }), TypeError);
    assert.equal(live.register(recorder("twice").driver), true);
    assert.equal(live.register(recorder("twice").driver), false, "the second is refused, not duplicated");
});

test("civ:people on|off is the switch, and it answers with what the drivers have done", () => {
    resetWorld(1);
    const player = makePlayer();
    send(CIV_EVENT_IDS.people, "status", player);
    assert.match(text(player) + mc.messages.join("\n"), /People entities are off/);
    assert.equal(mc.props.get("civ_people"), undefined, "asking for status must not change the gate");

    send(CIV_EVENT_IDS.people, "on", player);
    assert.equal(mc.props.get("civ_people"), true, "the switch writes the gate property");
    let shown = text(player) + mc.messages.join("\n");
    assert.match(shown, /People entities are on/);
    assert.match(shown, /No driver is registered/);

    const seen = recorder("walker");
    switched.register(seen.driver);
    switched.onStep({ ran: 1 });
    assert.equal(switched.stats.hours, 1, "the hour ran against the stored kingdom");
    assert.equal(seen.calls.length, 1);
    send(CIV_EVENT_IDS.people, "off", player);
    shown = text(player) + mc.messages.join("\n");
    assert.match(shown, /People entities are off/);
    assert.match(shown, /walker: 1 hour\(s\)/, "the counters survive switching the gate off");
    switched.onStep({ ran: 1 });
    assert.equal(seen.calls.length, 2, "the hour after switching off is spent tearing down, not ignored");
    assert.equal(seen.calls[1].gateOn, false);
});

test("a rejected hour still reaches the drivers, and it hands them the kingdom the loop refused to change", () => {
    const live = inhabited();
    const seen = recorder("walker");
    live.register(seen.driver);
    const savedKingdom = mc.props.get("civ:kingdom");
    assert.notEqual(savedKingdom, undefined, "a stored kingdom, so the comparison below is not two undefineds");
    mc.propWrites = 0;
    live.onStep({ ran: 0, skipped: 1, problem: "territory land-1.status 'bogus' is not one of wild/raided/military/kingdom" });
    // simulationLoop reports a refusal and returns WITHOUT saving, so this door is not a refused door: the
    // drivers still get the hour, and what they get is the last accepted kingdom, byte for byte.
    assert.equal(seen.calls.length, 1, "the drivers still run, because a refused hour must not also refuse the teardown pass");
    assert.equal(seen.calls[0].report.skipped, 1, "the driver can see that nothing advanced");
    // mc.writes counts BLOCK writes; a persisting runtime is a PROPERTY write.
    assert.equal(mc.propWrites, 0, "the runtime writes no dynamic property, so a rejected step stays rejected");
    assert.equal(mc.props.get("civ:kingdom"), savedKingdom, "the saved kingdom is unchanged after a refused hour");
});
