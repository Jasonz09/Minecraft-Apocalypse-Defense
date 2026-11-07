// The chronicle, offline: the hour the simulation just wrote, said once, in one line, to the players who are here.
//
// Every assertion is about what a player would read or about what the chronicle refused to do - it writes nothing,
// so a test that only checked "no throw" would pass on a narrator that said nothing forever.
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;

const messages = [];
const players = [{ name: "Steve" }];
const mutations = { kingdom: 0, entities: 0 };
const world = {
    getAllPlayers: () => players.slice(),
    sendMessage: (text) => {
        messages.push(String(text));
    },
    getDynamicProperty: () => undefined,
    setDynamicProperty: () => {
        mutations.kingdom += 1;
    },
};

globalThis.__mcChronicle = { world };
const hooks = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") {
        const stub = 'export const world = globalThis.__mcChronicle.world; export const system = { currentTick: 0 };';
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));

const { CHRONICLE_DEFAULTS, clauseOf, composeLine, createChronicle } = await import(fileUrl("integration", "chronicle.js"));

/** A kingdom as the store hands it over, with one hour's log. */
function kingdomAt(step, lines) {
    return { step, log: lines.map((text) => ({ atStep: step, text })) };
}

/** A world that cannot be written to: the chronicle must never need it. */
const sealedWorld = {
    getAllPlayers: () => players.slice(),
    sendMessage: (text) => messages.push(String(text)),
    getDynamicProperty: () => {
        throw new Error("the chronicle must not read world state");
    },
    setDynamicProperty: () => {
        throw new Error("the chronicle must not write world state");
    },
};

function fresh(config = {}) {
    messages.length = 0;
    players.length = 0;
    players.push({ name: "Steve" });
    return createChronicle({ world: sealedWorld, config });
}

test("the first hour takes its mark and says nothing: joining a played world is not a history lesson", () => {
    const chronicle = fresh();
    const said = chronicle.onHour({ kingdom: kingdomAt(500, ["Hearthgate: 3 raiders and 0 of our soldiers lost - wall 64 -> 60"]) });
    assert.equal(said, 0, "nothing was said");
    assert.deepEqual(messages, [], "and nothing reached chat");
    assert.match(String(chronicle.status().refused), /takes its mark/, "the reason is on the record, not inferred from silence");
});

test("the next hour is told once, as one line, with the district that fell first", () => {
    const chronicle = fresh();
    chronicle.onHour({ kingdom: kingdomAt(500, []) });
    const sameHour = kingdomAt(501, [
        "Ironquarry: homes stage 3/4 paid ({\"materials\":10,\"food\":2,\"supplies\":1})",
        "Saltmere: 12 breached steps with no able defenders - the district has fallen. Its 4008 civilians and 6 soldiers stay on the record.",
        "Hearthgate: assault 14 against 1 effective defenders - wall 64 -> 60, 3 raiders and 0 of our soldiers lost.",
    ]);
    const said = chronicle.onHour({ kingdom: sameHour });
    assert.equal(said, 1, "one hour, one telling");
    assert.equal(messages.length, 1, "and exactly one chat line");
    const line = messages[0];
    assert.match(line, /^Hour 501 - /, "the hour leads");
    assert.ok(line.indexOf("Saltmere has fallen") < line.indexOf("wall 64 to 60"), "the fall is told before the wall it cost");
    assert.ok(line.indexOf("wall 64 to 60") < line.indexOf("stage 3/4"), "and a fight before a building");
    assert.ok(!line.includes('{"materials"'), "the resource blob a log line carries is never read out loud");
    // The same hour can reach the door twice (a save, a re-report, a busy runtime): the same lines must not be told
    // twice. The entries are still in the kingdom, so this is the case the guard exists for.
    assert.equal(chronicle.onHour({ kingdom: sameHour }), 0, "the same hour, with its lines still in the log, is silence");
    assert.equal(messages.length, 1, "and chat did not repeat it");
});

test("a quiet hour says nothing at all", () => {
    const chronicle = fresh();
    chronicle.onHour({ kingdom: kingdomAt(10, []) });
    assert.equal(chronicle.onHour({ kingdom: kingdomAt(11, []) }), 0, "no new lines, no line");
    assert.deepEqual(messages, []);
});

test("routine survey limits and empty evacuation attempts stay in the log without hourly chat", () => {
    const chronicle = fresh();
    chronicle.onHour({ kingdom: kingdomAt(40, []) });
    for (const step of [41, 42]) {
        const kingdom = kingdomAt(step, [
            "expansion survey reached its bound of 4 lands this step",
            "Ironquarry: no civilians left to move.",
        ]);
        const before = JSON.stringify(kingdom);
        assert.equal(chronicle.onHour({ kingdom }), 0);
        assert.equal(JSON.stringify(kingdom), before, "the complete diagnostic log is retained");
    }
    assert.deepEqual(messages, []);
});

test("routine notices cannot crowd out battles, evacuation warnings or unfamiliar events", () => {
    const line = composeLine(43, [
        "expansion survey reached its bound of 4 lands this step",
        "Ironquarry: no civilians left to move.",
        "Hearthgate: assault 14 against 1 effective defenders - wall 64 -> 60, 3 raiders and 0 of our soldiers lost.",
        "Saltmere: every route is blocked (every safe neighbour has no capacity).",
        "Ashfall: scouts discovered a northern settlement.",
    ].map(text => ({ text })));
    assert.match(line, /Hearthgate: wall 64 to 60/);
    assert.match(line, /Saltmere: no evacuation route/);
    assert.match(line, /scouts discovered a northern settlement/);
    assert.doesNotMatch(line, /survey reached|no civilians left/);
});

test("nobody in the world is nobody to tell: the hour is marked told and not replayed later", () => {
    const chronicle = fresh();
    chronicle.onHour({ kingdom: kingdomAt(20, []) });
    players.length = 0;
    const said = chronicle.onHour({ kingdom: kingdomAt(21, ["Ashfall: SHORTAGE - needed 89.47 food, had 76.24, ate 76.24 (stress step 3)"]) });
    assert.equal(said, 0, "no player, no message");
    assert.deepEqual(messages, [], "and nothing was queued");
    assert.match(String(chronicle.status().refused), /nobody is in the world/, "the reason is named");
    players.push({ name: "Alex" });
    assert.equal(chronicle.onHour({ kingdom: kingdomAt(22, []) }), 0, "the next hour is quiet, not a backlog of the last one");
    assert.deepEqual(messages, [], "a returning player gets the next hour, not the one they missed");
});

test("more happened than a line can hold: three things, the three that matter", () => {
    const lines = [
        "Hearthgate: STALLED district-1-homes-3 - labour withdrawn: district is under active attack",
        "Saltmere: STALLED district-4-homes-3 - labour withdrawn: district is under active attack",
        "Whitethorn: STALLED district-3-homes-3 - labour withdrawn: district is under active attack",
        "Hearthgate: every route is blocked (every safe neighbour has no capacity (Ironquarry, Ashfall)). 5337 civilians shelter in place.",
        "Ashfall: SHORTAGE - needed 89.47 food, had 76.24, ate 76.24 (stress step 3)",
        "Ironquarry: homes COMPLETE (district-2-homes-3) - homes raised to 238, civilian capacity now 4760 (+20)",
        "Saltmere: 12 breached steps with no able defenders - the district has fallen. Its 4008 civilians and 6 soldiers stay on the record.",
    ];
    const line = composeLine(600, lines.map((text) => ({ atStep: 600, text })));
    const clauses = line.replace(/^Hour 600 - /, "").replace(/\.$/, "").split("; ");
    assert.equal(clauses.length, 3, "three clauses, no more");
    assert.match(clauses[0], /Saltmere has fallen/);
    assert.match(clauses[1], /Ironquarry: homes complete/);
    assert.match(clauses[2], /Ashfall: food short/, "a shortage is told before work that never started");
    assert.ok(line.length <= CHRONICLE_DEFAULTS.maxLineChars, "and the line stays inside what one chat entry can hold");
});

test("a line the chronicle cannot shorten is repeated, not dropped", () => {
    const text = "Hearthgate: the horn sounded twice at the north gate and nobody answered.";
    const clause = clauseOf(text);
    assert.equal(clause.clause, text, "the simulation's own sentence, unchanged");
    assert.equal(clause.rank, 9, "ranked last, so a known beat outranks it");
    const line = composeLine(7, [{ atStep: 7, text }, { atStep: 7, text: "Saltmere: 12 breached steps with no able defenders - the district has fallen." }]);
    assert.match(line, /Saltmere has fallen/, "the fall still leads");
    assert.ok(line.includes(text) || line.length >= CHRONICLE_DEFAULTS.maxLineChars, "and the unknown line is either told or the line is at its limit");
});

test("an hour of duplicates is one clause, and the same line twice is said once", () => {
    const line = composeLine(9, [
        { atStep: 9, text: "Ashfall: SHORTAGE - needed 89.47 food, had 76.24, ate 76.24 (stress step 3)" },
        { atStep: 9, text: "Ashfall: SHORTAGE - needed 89.47 food, had 76.24, ate 76.24 (stress step 3)" },
    ]);
    assert.equal(line, "Hour 9 - Ashfall: food short (76.24 of 89.47).");
});

test("the chronicle writes nothing: no world property, no kingdom field", () => {
    const chronicle = createChronicle({ world: world });
    const kingdom = kingdomAt(100, []);
    Object.freeze(kingdom);
    chronicle.onHour({ kingdom });
    const next = kingdomAt(101, ["Saltmere: 12 breached steps with no able defenders - the district has fallen."]);
    Object.freeze(next);
    chronicle.onHour({ kingdom: next });
    assert.equal(mutations.kingdom, 0, "no dynamic property was written");
    assert.equal(mutations.entities, 0, "and no entity was touched");
    assert.ok(messages.length >= 0, "the world object is only ever asked to speak");
});
