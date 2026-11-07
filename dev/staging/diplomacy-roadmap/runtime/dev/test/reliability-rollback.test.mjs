// Reliability: the rollback branch of sim/tick.js advanceKingdomStep, executed.
// docs/TESTING.md says this branch was "verified by reading"; these tests force it.
//
// A fault is injected by a module-resolution hook that wraps ONLY the `./war.js` import
// made by sim/tick.js. With no fault armed the wrapper delegates to the real runWarStep,
// so every non-fault test exercises the production system untouched.
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const fileUrl = (...parts) => pathToFileURL(join(scriptsRoot, ...parts)).href;

const hooksSource = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "./war.js" && typeof context.parentURL === "string" && context.parentURL.endsWith("/sim/tick.js")) {
        const real = ${JSON.stringify(fileUrl("sim", "war.js"))};
        const wrapper = 'import { runWarStep as real } from ' + JSON.stringify(real) + ';' +
            'export function runWarStep(kingdom) { const f = globalThis.__reliabilityFault; return f ? f(kingdom, real) : real(kingdom); }';
        return { url: "data:text/javascript," + encodeURIComponent(wrapper), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooksSource));

const { createInitialKingdom, findValidationProblems } = await import(fileUrl("kingdom", "state.js"));
const { advanceKingdom, advanceKingdomStep } = await import(fileUrl("sim", "tick.js"));
const { SIM } = await import(fileUrl("config.js"));

function withFault(fault, body) {
    globalThis.__reliabilityFault = fault;
    try {
        return body();
    } finally {
        globalThis.__reliabilityFault = undefined;
    }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("hook sanity: with no fault armed the real war system runs and steps advance", () => {
    const kingdom = createInitialKingdom();
    const result = advanceKingdomStep(kingdom);
    assert.deepEqual(result.problems, []);
    assert.equal(kingdom.step, 1);
});

test("rollback: a system that corrupts state leaves the prior state intact, same object, and reports problems", () => {
    const kingdom = createInitialKingdom();
    advanceKingdom(kingdom, 3);
    const before = clone(kingdom);
    const identity = kingdom;
    const districtsBefore = kingdom.districts;

    const result = withFault(
        (state, real) => {
            real(state); // do legitimate work first, so the rollback has something to undo
            state.territory[0].status = "bogus"; // then break invariants no later system repairs
            state.districts[1].gates[0].state = "ajar";
            state.policy.expansion = "tampered";
            state.eventLog?.push?.("this event must never persist");
            return ["war: injected fault"];
        },
        () => advanceKingdomStep(kingdom),
    );

    assert.ok(result.problems.length >= 2, `expected the validator to flag the fault, got ${JSON.stringify(result.problems)}`);
    assert.ok(result.problems.some((problem) => problem.includes("territory")));
    assert.ok(result.problems.some((problem) => problem.includes("gate")));
    assert.deepEqual(result.events, [], "a rejected step reports no events");
    assert.deepEqual(kingdom, before, "state is exactly the pre-step state, including step counter, rng, logs");
    assert.equal(kingdom, identity, "callers keep the object they hold");
    assert.deepEqual(findValidationProblems(kingdom), []);
    // Documented consequence of restore(): nested objects are replaced, so a reference
    // held into the old tree is stale after a rollback.
    assert.notEqual(kingdom.districts, districtsBefore);
    assert.equal(result.step, before.step, "the reported step is the restored step, not the attempted one");
});

test("rollback: the rng cursor is restored, so a retried step is not perturbed by the failed attempt", () => {
    const control = createInitialKingdom();
    const subject = createInitialKingdom();
    advanceKingdom(control, 5);
    advanceKingdom(subject, 5);

    withFault(
        (state, real) => {
            real(state);
            state.territory[0].status = "bogus";
            return [];
        },
        () => advanceKingdomStep(subject),
    );
    assert.equal(subject.rngState, control.rngState);

    advanceKingdomStep(control);
    advanceKingdomStep(subject);
    assert.deepEqual(subject, control, "a clean retry after a rollback matches a run that never failed");
});

test("rollback: removing required structure (not just bad values) is also undone", () => {
    const kingdom = createInitialKingdom();
    const before = clone(kingdom);
    const result = withFault(
        (state) => {
            delete state.policy;
            state.districts.length = 0;
            return [];
        },
        () => advanceKingdomStep(kingdom),
    );
    assert.ok(result.problems.length > 0);
    assert.deepEqual(kingdom, before);
});

test("rollback: keys ADDED by a faulty step are removed (restore deletes before assigning)", () => {
    const kingdom = createInitialKingdom();
    const before = clone(kingdom);
    withFault(
        (state) => {
            state.leakedKey = { a: 1 };
            state.territory[0].status = "bogus";
            return [];
        },
        () => advanceKingdomStep(kingdom),
    );
    assert.equal("leakedKey" in kingdom, false);
    assert.deepEqual(kingdom, before);
});

test("rollback: advanceKingdom counts the rejection, never reports ran, and stopOnProblem halts after one", () => {
    const kingdom = createInitialKingdom();
    const before = clone(kingdom);
    const fault = (state) => {
        state.territory[0].status = "bogus";
        return ["war: should not surface"];
    };

    const all = withFault(fault, () => advanceKingdom(kingdom, 5));
    assert.equal(all.ran, 0);
    assert.equal(all.skipped, 5);
    assert.equal(all.rejected.length, 5);
    assert.deepEqual(all.events, [], "events from rejected steps are not leaked into the catch-up report");
    assert.deepEqual(kingdom, before);

    const halted = withFault(fault, () => advanceKingdom(kingdom, 5, { stopOnProblem: true }));
    assert.equal(halted.skipped, 1);
    assert.equal(halted.rejected.length, 1);
    assert.deepEqual(kingdom, before);
});

test("rollback: a fault that clears after N steps lets later steps through, with earlier ones skipped cleanly", () => {
    const kingdom = createInitialKingdom();
    let calls = 0;
    const result = withFault(
        (state, real) => {
            calls += 1;
            if (calls <= 2) {
                state.territory[0].status = "bogus";
                return [];
            }
            return real(state);
        },
        () => advanceKingdom(kingdom, 5),
    );
    assert.equal(result.skipped, 2);
    assert.equal(result.ran, 3);
    assert.equal(kingdom.step, 3, "only successful steps advance the clock");
    assert.deepEqual(findValidationProblems(kingdom), []);
});

test("advanceKingdom bounds: clamps to SIM.maxCatchUpSteps, rejects non-integers, treats undefined as zero", () => {
    const kingdom = createInitialKingdom();
    const result = advanceKingdom(kingdom, 10_000);
    assert.equal(result.ran + result.skipped, SIM.maxCatchUpSteps);
    assert.throws(() => advanceKingdom(kingdom, 1.5), /integer/);
    assert.throws(() => advanceKingdom(kingdom, Number.NaN), /integer/);
    const step = kingdom.step;
    assert.equal(advanceKingdom(kingdom, undefined).ran, 0);
    assert.equal(advanceKingdom(kingdom, -4).ran, 0);
    assert.equal(kingdom.step, step);
});

test("a throwing system leaves the in-memory kingdom untouched and is reported as a problem", () => {
    const kingdom = createInitialKingdom();
    const before = clone(kingdom);
    const result = withFault(
        () => {
            throw new Error("injected system crash");
        },
        () => advanceKingdomStep(kingdom),
    );
    assert.match(result.problems.join(" "), /injected system crash/);
    assert.deepEqual(kingdom, before);
});
