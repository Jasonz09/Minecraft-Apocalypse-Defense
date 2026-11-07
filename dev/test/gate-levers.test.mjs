import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { leverGateIndex, leverDecision } = await load("civ", "leverbindings.js");
const { cellsToToggle } = await load("civ", "gates.js");

test("every gatehouse lever resolves to its own gate, and nothing else does", () => {
    const spec = { id: "gate-d1-north", axis: "x", at: { x: 100, z: 200 }, y: 65, width: 5, wallTop: 7, passageHeight: 5 };
    const kingdom = {
        districts: [{ id: "district-1", gates: [{ id: "gate-d1-north", physical: { spec } }] }],
    };
    const index = leverGateIndex(kingdom);
    const levers = cellsToToggle(spec).filter((cell) => cell.role === "lever");
    assert.equal(levers.length, 4, "a gatehouse carries four levers");
    for (const cell of levers) {
        assert.equal(index.get(`${cell.x},${cell.y},${cell.z}`), "gate-d1-north");
    }
    assert.equal(index.size, 4, "no cell beyond the four levers is claimed");
    assert.equal(index.get("0,-64,0"), undefined, "an unrelated lever belongs to no gate");
});

test("a gate with no physical record contributes no lever", () => {
    const kingdom = { districts: [{ id: "district-1", gates: [{ id: "gate-d1-logical", state: "open" }] }] };
    assert.equal(leverGateIndex(kingdom).size, 0);
});

test("a press closes an open gate and opens a sealed one, reading a move already under way", () => {
    assert.deepEqual(leverDecision({ state: "open" }), { mode: "forced_closed", opening: false });
    assert.deepEqual(leverDecision({ state: "sealed" }), { mode: "forced_open", opening: true });
    // Mid-move: the pending target wins, so pressing again reverses the gate rather than repeating itself.
    assert.deepEqual(leverDecision({ state: "open", physical: { target: "sealed" } }), { mode: "forced_open", opening: true });
    assert.deepEqual(leverDecision({ state: "sealed", physical: { target: "open" } }), { mode: "forced_closed", opening: false });
});
