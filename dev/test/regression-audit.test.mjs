const COMPLETED_PROJECT_HISTORY = 2; // mirrors sim/tick.js
import assert from "node:assert/strict";
import test from "node:test";
import { createInitialKingdom } from "../../CivilizationApocalypse_BP/scripts/kingdom/state.js";
import { runConstructionStep } from "../../CivilizationApocalypse_BP/scripts/sim/tick.js";
import { scheduleProject } from "../../CivilizationApocalypse_BP/scripts/sim/construction.js";

const rec = (id, kind, status = "complete") => ({ id, kind, status });

test("prune keeps the newest completed records and every completed wall/gate", () => {
    const kingdom = createInitialKingdom();
    const d = kingdom.districts[0];
    d.projects = [rec("w", "walls"), rec("g", "gate")];
    const total = COMPLETED_PROJECT_HISTORY + 3;
    for (let i = 1; i <= total; i += 1) d.projects.push(rec(`homes-${i}`, "homes"));
    runConstructionStep(kingdom);
    const ids = d.projects.map((p) => p.id);
    assert.ok(ids.includes("w") && ids.includes("g"), "permanent records survive");
    assert.ok(ids.includes(`homes-${total}`), "newest record kept");
    assert.ok(!ids.includes("homes-1"), "oldest record dropped");
});

test("new project ids stay unique after older records were pruned", () => {
    const kingdom = createInitialKingdom();
    const d = kingdom.districts[0];
    d.projects = [rec(`${d.id}-homes-5`, "homes")];
    const project = scheduleProject(d, "homes", {});
    assert.notEqual(project.id, `${d.id}-homes-5`);
    assert.equal(new Set(d.projects.map((p) => p.id)).size, d.projects.length);
});
