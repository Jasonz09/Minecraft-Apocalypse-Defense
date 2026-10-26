// The Horn of Hearthgate: identity, intent and the guide arithmetic. All pure, no runtime.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rules = await import(pathToFileURL(join(root, "CivilizationApocalypse_BP", "scripts", "inventory", "beaconRules.js")).href);

const BEACON = rules.BEACON_ITEM;

class FakeStack {
    constructor(typeId, amount = 1) {
        this.typeId = typeId;
        this.amount = amount;
        this.props = new Map();
        this.lore = [];
        this.nameTag = undefined;
        this.lockMode = undefined;
        this.keepOnDeath = false;
    }
    setLore(lines) {
        this.lore = lines;
    }
    setDynamicProperty(id, value) {
        this.props.set(id, value);
    }
    getDynamicProperty(id) {
        return this.props.get(id);
    }
}

function horn() {
    const stack = new FakeStack(BEACON.typeId);
    stack.setDynamicProperty(BEACON.marker, true);
    return stack;
}

function containerOf(items) {
    return { size: items.length, getItem: (slot) => items[slot] };
}

test("the horn is identified by type plus marker, never by name", () => {
    assert.equal(rules.isBeaconStack(undefined), false);
    assert.equal(rules.isBeaconStack(null), false);
    assert.equal(rules.isBeaconStack({}), false);
    assert.equal(rules.isBeaconStack(new FakeStack(BEACON.typeId)), false, "an unmarked horn is not ours");
    assert.equal(rules.isBeaconStack(horn()), true);
    const impostor = new FakeStack("minecraft:compass");
    impostor.setDynamicProperty(BEACON.marker, true);
    assert.equal(rules.isBeaconStack(impostor), false, "the marker alone is not enough");
});

test("the slot search skips everything that is not the horn", () => {
    const container = containerOf([undefined, new FakeStack("minecraft:stone"), horn()]);
    assert.equal(rules.findBeaconSlot(container), 2);
    assert.equal(rules.findBeaconSlot(containerOf([])), undefined);
    assert.equal(rules.findBeaconSlot(containerOf([new FakeStack("minecraft:book")])), undefined);
});

test("a new horn is named, marked, locked and kept", () => {
    const stack = rules.makeBeaconStack(FakeStack, { inventory: "inventory" });
    assert.equal(stack.typeId, BEACON.typeId);
    assert.equal(stack.amount, 1);
    assert.equal(stack.nameTag, BEACON.nameTag);
    assert.equal(stack.getDynamicProperty(BEACON.marker), true);
    assert.equal(stack.lockMode, "inventory");
    assert.equal(stack.keepOnDeath, true);
    assert.deepEqual(stack.lore, [...BEACON.lore]);
    assert.equal(rules.isBeaconStack(stack), true);
});

test("intent: no Hearthgate record means build, a finished one means guide", () => {
    const kingdom = (civ) => ({ districts: [{ id: "district-1", name: "Hearthgate", civ }, { id: "district-2", name: "Ironquarry" }] });
    assert.equal(rules.beaconIntent(undefined).kind, "unavailable");
    assert.equal(rules.beaconIntent({ districts: [] }).kind, "unavailable");
    assert.equal(rules.beaconIntent(kingdom(undefined)).kind, "build");
    assert.equal(rules.beaconIntent(kingdom({ status: "complete", centre: { x: 1, z: 2 } })).kind, "guide");
    assert.equal(rules.beaconIntent(kingdom({ status: "paused" })).kind, "resume");
    assert.equal(rules.beaconIntent(kingdom({ status: "building" })).kind, "resume");
});

test("intent: a running job is reported, and a finished district still guides through it", () => {
    const civ = (status) => ({ districts: [{ id: "district-1", name: "Hearthgate", civ: { status } }] });
    assert.equal(rules.beaconIntent(civ("building"), { busy: true }).kind, "busy");
    assert.equal(rules.beaconIntent(civ("paused"), { busy: true }).kind, "busy");
    assert.equal(rules.beaconIntent(civ("complete"), { busy: true }).kind, "guide", "the guide never needs the job slot");
});

test("the centre is only used when it is a pair of integers", () => {
    const withCentre = (centre) => ({ districts: [{ id: "district-1", civ: { status: "building", centre } }] });
    assert.deepEqual(rules.beaconCentre(withCentre({ x: -164, z: -8 })), { x: -164, z: -8 });
    assert.equal(rules.beaconCentre(withCentre({ x: 1.5, z: 2 })), undefined);
    assert.equal(rules.beaconCentre(withCentre(undefined)), undefined);
    assert.equal(rules.beaconCentre({ districts: [] }), undefined);
});

test("bearings are clockwise from north, with Minecraft's axes", () => {
    const origin = { x: 0, z: 0 };
    assert.equal(rules.bearingDegrees(origin, { x: 0, z: -100 }), 0, "north is -z");
    assert.equal(rules.bearingDegrees(origin, { x: 100, z: 0 }), 90, "east is +x");
    assert.equal(rules.bearingDegrees(origin, { x: 0, z: 100 }), 180);
    assert.equal(rules.bearingDegrees(origin, { x: -100, z: 0 }), 270);
    assert.equal(rules.bearingDegrees(origin, { x: 100, z: -100 }), 45);
    assert.equal(rules.bearingDegrees(origin, origin), 0, "standing on the centre has no direction, not NaN");
});

test("compass points wrap at north", () => {
    assert.equal(rules.compassPoint(0), "N");
    assert.equal(rules.compassPoint(45), "NE");
    assert.equal(rules.compassPoint(90), "E");
    assert.equal(rules.compassPoint(135), "SE");
    assert.equal(rules.compassPoint(180), "S");
    assert.equal(rules.compassPoint(225), "SW");
    assert.equal(rules.compassPoint(270), "W");
    assert.equal(rules.compassPoint(315), "NW");
    assert.equal(rules.compassPoint(359), "N");
    assert.equal(rules.compassPoint(720), "N");
});

test("the guide line carries distance and direction, and its status suffix", () => {
    const centre = { x: 3, z: 4 };
    const here = { x: 0, z: 0 };
    assert.equal(rules.guideLine(centre, here, "Hearthgate"), "Hearthgate · 5m SE", "+z is south, so 3,4 is south-east");
    assert.equal(rules.guideLine(centre, here, "Hearthgate", "building"), "Hearthgate · 5m SE · rising");
    assert.equal(rules.guideLine(centre, here, "Hearthgate", "paused"), "Hearthgate · 5m SE · paused");
    assert.equal(rules.guideLine({ x: 0, z: -250 }, here, "Hearthgate"), "Hearthgate · 250m N");
});

test("the chat readout differs by status and always names the centre", () => {
    const centre = { x: -164, z: -8 };
    const here = { x: 0, z: 0 };
    const tour = rules.guideLines(centre, here, "Hearthgate");
    assert.match(tour[0], /Hearthgate stands at -164, -8/);
    assert.match(tour[0], /164 blocks/);
    assert.ok(tour.some((line) => line.includes("/tp @s -164 ~ -8")));
    assert.ok(rules.guideLines(centre, here, "Hearthgate", "building").some((line) => line.includes("still being raised")));
    assert.ok(rules.guideLines(centre, here, "Hearthgate", "paused").some((line) => line.includes("paused")));
});

test("the confirmation states the search radius and what may be overwritten", () => {
    const body = rules.confirmBody("build", "Hearthgate", 220);
    assert.match(body, /within 220 blocks/);
    assert.match(body, /Hearthgate/);
    assert.match(body, /dirt, stone, sand/);
    assert.match(body, /Planks, bricks, glass, chests, ores and farmland are protected/);
    assert.equal(rules.confirmTitle("build", "Hearthgate"), "Raise Hearthgate?");
    assert.equal(rules.confirmTitle("resume", "Hearthgate"), "Resume Hearthgate?");
    assert.equal(rules.confirmButton("build"), "Build Hearthgate here");
    assert.equal(rules.confirmButton("resume"), "Resume the build");
    assert.match(rules.confirmBody("resume", "Hearthgate", 220), /stored plan and queue/);
});
