import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { createInitialKingdom, findValidationProblems } = await loadModule("kingdom", "state.js");
const { advanceKingdomStep, runConstructionStep, runTrainingStep } = await loadModule("sim", "tick.js");
const { runWarStep, spawnThreats } = await loadModule("sim", "war.js");
const { runGateControlStep, validateGateRecords } = await loadModule("sim", "gatecontrol.js");
const { runEvacuationStep } = await loadModule("sim", "evacuation.js");
const { runExpansionStep } = await loadModule("sim", "expansion.js");
const { runPolicyStep } = await loadModule("sim", "policies.js");
const { runPopulationStep } = await loadModule("sim", "population.js");
const { nextInt } = await loadModule("sim", "rng.js");
const composition = await loadModule("sim", "invasion", "composition.js");
const director = await loadModule("sim", "invasion", "director.js");
const apply = await loadModule("sim", "invasion", "apply.js");

const { COMPOSITIONS, INVASION_LIMITS, UNIT_ORDER, strengthOf, planStrikes, validateCompositions } = composition;
const { INVASION_DEFAULTS, PHASE_EDGES } = director;

/** Six fixed seeds. No Math.random, no clocks: every number below replays exactly. */
const SEEDS = [20261017, 1, 2, 3, 424242, 987654321];
const VERDICTS = ["repelled", "breached", "fallen", "timed out"];

/**
 * @param {number} seed
 * @returns {any}
 */
function kingdomWithSeed(seed) {
    const kingdom = createInitialKingdom();
    kingdom.seed = seed;
    kingdom.rngState = seed >>> 0;
    return kingdom;
}

/**
 * @param {any} value
 * @returns {any[]}
 */
function eventsOf(result) {
    return Array.isArray(result) ? result.map(String) : Array.isArray(result?.events) ? result.events.map(String) : [];
}

/**
 * One tick in the order the integrator will wire it: the step counter moves, the director runs,
 * then the same systems as sim/tick.js in the same order. A step the validator refuses is rolled
 * back whole, director changes included. With `wired: false` this is exactly advanceKingdomStep,
 * which the no-op test below relies on.
 *
 * @param {any} kingdom
 * @param {{ wired?: boolean, options?: any }} [config]
 */
function tick(kingdom, config = {}) {
    const wired = config.wired !== false;
    const snapshot = JSON.stringify(kingdom);
    kingdom.step = Number(kingdom.step) + 1;
    /** @type {string[]} */
    const events = [];
    let directives = [];
    let results = [];
    /** @type {string[]} */
    let problems = [];
    try {
        if (wired) {
            const report = director.stepInvasion(kingdom, config.options ?? {});
            events.push(...report.events);
            directives = report.directives;
            results = report.results;
        }
        events.push(...eventsOf(runWarStep(kingdom)));
        events.push(...eventsOf(runGateControlStep(kingdom)));
        events.push(...eventsOf(runEvacuationStep(kingdom)));
        events.push(...runConstructionStep(kingdom));
        events.push(...eventsOf(runExpansionStep(kingdom)));
        events.push(...runPolicyStep(kingdom));
        events.push(...eventsOf(runPopulationStep(kingdom)));
        events.push(...runTrainingStep(kingdom));
        problems = [...findValidationProblems(kingdom), ...validateGateRecords(kingdom)];
    } catch (error) {
        problems = [`a simulation system threw: ${String(error)}`];
    }
    if (problems.length > 0) {
        for (const key of Object.keys(kingdom)) {
            delete kingdom[key];
        }
        Object.assign(kingdom, JSON.parse(snapshot));
        return { events: [], directives: [], results: [], problems };
    }
    return { events, directives, results, problems };
}

/**
 * Every wave record must stay inside the composition table and the caps, at every step.
 *
 * @param {any} wave
 * @param {string} label
 */
function assertWaveWithinCaps(wave, label) {
    const definition = COMPOSITIONS.find((candidate) => candidate.id === wave.compositionId);
    assert.ok(definition, `${label}: composition ${String(wave.compositionId)} must be in the table`);
    assert.equal(definition.kind, wave.kind, `${label}: wave kind follows its composition`);
    assert.ok(wave.strikes.length >= 1 && wave.strikes.length <= definition.strikes, `${label}: strike count`);
    let planned = 0;
    for (const strike of wave.strikes) {
        assert.equal(strike.strength, strengthOf(strike.counts), `${label}: strike strength matches its units`);
        assert.ok(strike.strength > 0 && strike.strength <= INVASION_LIMITS.maxWaveStrength, `${label}: strike within the wave cap`);
        for (const type of UNIT_ORDER) {
            assert.ok(strike.counts[type] <= INVASION_LIMITS.maxTypeCount[type], `${label}: ${type} count within its cap`);
        }
        planned += strike.strength;
    }
    assert.ok(planned <= definition.maxTotalStrength, `${label}: invasion total ${String(planned)} within composition cap ${String(definition.maxTotalStrength)}`);
    const current = wave.strikes[wave.strike];
    for (const type of UNIT_ORDER) {
        assert.ok(wave.delivered[type] <= current.counts[type], `${label}: delivered ${type} never exceeds the strike`);
    }
}

test("the composition table is sound and the director is disabled by default", () => {
    assert.deepEqual(validateCompositions(), []);
    assert.equal(INVASION_DEFAULTS.enabled, false);
    assert.equal(director.createInvasionState(5).enabled, false, "a new record starts disabled");
    assert.equal(director.isInvasionEnabled(director.createInvasionState(5)), false);
    assert.equal(director.isInvasionEnabled(undefined), false);
    assert.equal(director.isInvasionEnabled({ enabled: true }), true);
});

test("composition plans stay inside every cap across thousands of rolls", () => {
    for (const definition of COMPOSITIONS) {
        let state = 9001;
        for (let roll = 0; roll < 800; roll += 1) {
            const drawInt = (/** @type {number} */ min, /** @type {number} */ max) => {
                const draw = nextInt(state, min, max);
                state = draw.next;
                return draw.value;
            };
            const strikes = planStrikes(definition, drawInt);
            assert.ok(strikes.length >= 1 && strikes.length <= definition.strikes, `${definition.id}: strike count`);
            let total = 0;
            for (const strike of strikes) {
                assert.ok(strike.strength > 0 && strike.strength <= INVASION_LIMITS.maxWaveStrength, `${definition.id}: strike cap`);
                for (const type of UNIT_ORDER) {
                    assert.ok(strike.counts[type] <= INVASION_LIMITS.maxTypeCount[type], `${definition.id}: type cap`);
                }
                total += strike.strength;
            }
            assert.ok(total <= definition.maxTotalStrength, `${definition.id}: total cap`);
        }
    }
});

test("the assault cap this module mirrors is the one sim/war.js enforces", () => {
    let observed = 0;
    for (let seed = 1; seed <= 400 && observed < 20; seed += 1) {
        const kingdom = kingdomWithSeed(seed);
        for (const district of kingdom.districts) {
            district.assault = 30;
        }
        spawnThreats(kingdom);
        for (const district of kingdom.districts) {
            if (district.assault !== 30) {
                assert.equal(district.assault, INVASION_LIMITS.districtAssaultCap, "war.js caps a pressed district at the mirrored value");
                observed += 1;
            }
        }
    }
    assert.ok(observed > 0, "the probe must actually land a raid at the cap");
});

test("a kingdom with the director absent or disabled serialises byte for byte the same", () => {
    const seed = 20261017;
    const steps = 400;
    const plain = kingdomWithSeed(seed);
    const absent = kingdomWithSeed(seed);
    const disabled = kingdomWithSeed(seed);
    disabled.invasion = director.createInvasionState(seed, false);
    const pristineRecord = JSON.stringify(disabled.invasion);

    for (let index = 0; index < steps; index += 1) {
        const reference = advanceKingdomStep(plain);
        const absentTick = tick(absent);
        const disabledTick = tick(disabled);
        assert.deepEqual(absentTick.problems, []);
        assert.deepEqual(disabledTick.problems, []);
        assert.deepEqual(absentTick.events, reference.events, `step ${String(index)}: the wired tick matches today's tick`);
        assert.deepEqual(disabledTick.events, reference.events, `step ${String(index)}: a disabled director adds no event`);
    }

    assert.equal(JSON.stringify(absent), JSON.stringify(plain), "absent director: byte-identical kingdom");
    assert.equal("invasion" in absent, false, "absent director never creates a record");
    const { invasion, ...rest } = disabled;
    assert.equal(JSON.stringify(rest), JSON.stringify(plain), "disabled director: byte-identical outside its own record");
    assert.equal(JSON.stringify(disabled.invasion), pristineRecord, "disabled record itself never changes");
    assert.deepEqual(director.runInvasionDirectorStep(absent), [], "absent record: nothing to report");
    assert.equal(director.runInvasionDirectorStep(disabled).length, 0, "disabled record: nothing to report");
});

test("the planner refuses a disabled or damaged record without touching it", () => {
    const kingdom = kingdomWithSeed(7);
    const disabled = director.createInvasionState(7, false);
    const plannedOff = director.nextDirectorState(disabled, kingdom, disabled.rngCursor, {});
    assert.equal(plannedOff.state, disabled, "a disabled record comes back as the same object");
    assert.deepEqual(plannedOff.directives, []);
    assert.deepEqual(plannedOff.events, []);

    const damaged = director.createInvasionState(7, true);
    damaged.phase = "bogus";
    const before = JSON.stringify(damaged);
    const plannedBad = director.nextDirectorState(damaged, kingdom, damaged.rngCursor, {});
    assert.equal(plannedBad.state, damaged);
    assert.deepEqual(plannedBad.directives, []);
    assert.equal(plannedBad.events.length, 1);
    assert.match(plannedBad.events[0], /refused its saved state/);
    assert.equal(JSON.stringify(damaged), before);
});

test("validateInvasionState catches damage to a record", () => {
    const base = director.createInvasionState(5, true);
    assert.deepEqual(director.validateInvasionState(base), []);
    assert.ok(director.validateInvasionState({ ...base, phase: "bogus" }).length > 0);
    assert.ok(director.validateInvasionState({ ...base, rngCursor: -1 }).length > 0);
    assert.ok(director.validateInvasionState({ ...base, phase: "approach", wave: null }).length > 0, "an active stage needs a wave");
    assert.ok(director.validateInvasionState({ ...base, phase: "quiet", wave: {} }).length > 0, "quiet holds no wave");
    assert.ok(director.validateInvasionState({ ...base, history: "x" }).length > 0);
});

test("the planner never writes to the kingdom or to its input record", () => {
    const kingdom = kingdomWithSeed(11);
    kingdom.invasion = director.createInvasionState(11, true);
    for (let index = 0; index < 400; index += 1) {
        tick(kingdom);
    }
    const kingdomBefore = JSON.stringify(kingdom);
    const recordBefore = JSON.stringify(kingdom.invasion);
    const options = { proximity: { "district-1": 10 } };
    const first = director.nextDirectorState(kingdom.invasion, kingdom, kingdom.invasion.rngCursor, options);
    const second = director.nextDirectorState(kingdom.invasion, kingdom, kingdom.invasion.rngCursor, options);
    assert.equal(JSON.stringify(kingdom), kingdomBefore, "the kingdom is untouched");
    assert.equal(JSON.stringify(kingdom.invasion), recordBefore, "the input record is untouched");
    assert.deepEqual(first, second, "the same inputs always plan the same step");
    assert.notEqual(first.state, kingdom.invasion, "the result is a new record");
});

test("enableInvasion switches a record on without resetting it", () => {
    const fresh = kingdomWithSeed(77);
    assert.equal("invasion" in fresh, false);
    director.enableInvasion(fresh);
    assert.equal(fresh.invasion.enabled, true);
    assert.equal(fresh.invasion.seed, 77);

    const existing = kingdomWithSeed(77);
    existing.invasion = director.createInvasionState(77, false);
    existing.invasion.sequence = 4;
    director.enableInvasion(existing);
    assert.equal(existing.invasion.enabled, true);
    assert.equal(existing.invasion.sequence, 4, "history of a record is kept");
});

test("six seeds over 3000 steps: every cap, every stage, aftermath, then quiet", () => {
    const STEPS = 3000;
    const tuning = INVASION_DEFAULTS;
    let totalMajors = 0;
    let totalRaids = 0;
    const districtsAcrossSeeds = new Set();

    for (const seed of SEEDS) {
        const label = `seed ${String(seed)}`;
        const kingdom = kingdomWithSeed(seed);
        kingdom.invasion = director.createInvasionState(seed, true);

        /** @type {Map<string, { kind: string, startedStep: number, phases: Set<string>, districtId: string, bearing: string }>} */
        const waves = new Map();
        /** @type {Map<string, any>} */
        const finished = new Map();
        /** @type {Map<string, number>} */
        const spawnsByWave = new Map();
        const bearings = new Set();
        const districtsHit = new Set();
        let scouts = 0;
        let alarms = 0;
        let quietEntries = 0;
        let previous = "quiet";

        for (let index = 0; index < STEPS; index += 1) {
            const result = tick(kingdom);
            const step = kingdom.step;
            assert.deepEqual(result.problems, [], `${label}, step ${String(step)}: kingdom must stay save-valid`);
            assert.equal(result.results.length, result.directives.length, `${label}, step ${String(step)}: one result per directive`);
            assert.ok(
                result.results.every((entry) => entry.accepted),
                `${label}, step ${String(step)}: every director directive is accepted: ${JSON.stringify(result.results.filter((entry) => !entry.accepted))}`,
            );

            // Per-tick caps: directives, and strength landed per district and across the kingdom.
            assert.ok(result.directives.length <= INVASION_LIMITS.maxDirectivesPerStep, `${label}, step ${String(step)}: directive cap`);
            /** @type {Record<string, number>} */
            const landedOn = {};
            let landedTotal = 0;
            for (const directive of result.directives) {
                if (directive.kind === "spawn") {
                    landedOn[directive.districtId] = (landedOn[directive.districtId] ?? 0) + directive.strength;
                    landedTotal += directive.strength;
                    spawnsByWave.set(directive.waveId, (spawnsByWave.get(directive.waveId) ?? 0) + 1);
                } else if (directive.kind === "scout") {
                    scouts += 1;
                } else if (directive.kind === "alarm") {
                    alarms += 1;
                }
            }
            for (const [districtId, strength] of Object.entries(landedOn)) {
                assert.ok(strength <= INVASION_LIMITS.maxSpawnPerDistrictPerStep, `${label}, step ${String(step)}: ${districtId} per-district cap`);
            }
            assert.ok(landedTotal <= INVASION_LIMITS.maxSpawnPerStep, `${label}, step ${String(step)}: per-tick cap`);
            for (const district of kingdom.districts) {
                assert.ok(district.assault <= INVASION_LIMITS.districtAssaultCap, `${label}, step ${String(step)}: ${district.id} assault cap`);
            }

            const state = kingdom.invasion;
            assert.deepEqual(director.validateInvasionState(state), [], `${label}, step ${String(step)}: the record stays valid`);
            if (state.phase !== previous) {
                assert.ok(PHASE_EDGES[previous].includes(state.phase), `${label}, step ${String(step)}: ${previous} -> ${state.phase} is a stage change`);
                if (previous === "cooldown" && state.phase === "quiet") {
                    quietEntries += 1;
                }
                previous = state.phase;
            }

            if (state.wave) {
                const wave = state.wave;
                assertWaveWithinCaps(wave, `${label}, ${String(wave.id)}`);
                let record = waves.get(wave.id);
                if (!record) {
                    record = { kind: wave.kind, startedStep: wave.startedStep, phases: new Set(), districtId: wave.districtId, bearing: wave.bearing };
                    waves.set(wave.id, record);
                    bearings.add(wave.bearing);
                    districtsHit.add(wave.districtId);
                    districtsAcrossSeeds.add(wave.districtId);
                }
                record.phases.add(state.phase);
                assert.equal(wave.physical, false, `${label}: nobody is near, so nothing is physical`);
            }
            for (const entry of state.history) {
                finished.set(entry.id, entry);
            }
        }

        // Every wave that began has finished, except possibly the one still running at the end.
        assert.equal(waves.size, finished.size + (kingdom.invasion.wave ? 1 : 0), `${label}: every wave finishes`);
        assert.ok(waves.size >= 15, `${label}: the run produces real activity (${String(waves.size)} waves)`);
        assert.equal(scouts, waves.size, `${label}: each invasion is sighted exactly once`);
        assert.ok(quietEntries >= waves.size - 1, `${label}: the director returns to quiet after each wave`);

        for (const [id, entry] of finished) {
            const record = waves.get(id);
            assert.ok(record, `${label}: ${id} was seen`);
            assert.ok(record.phases.has("aftermath"), `${label}: ${id} reaches aftermath`);
            assert.ok(VERDICTS.includes(entry.outcome), `${label}: ${id} has a known outcome (${String(entry.outcome)})`);
            assert.ok(entry.deliveredStrength <= entry.plannedStrength, `${label}: ${id} never lands more than it was planned`);
            if (entry.outcome === "repelled") {
                assert.equal(entry.deliveredStrength, entry.plannedStrength, `${label}: ${id} landed everything it was planned`);
            }
            assert.ok(entry.landedStep !== null, `${label}: ${id} landed`);
            assert.ok(
                entry.landedStep - entry.startedStep >= tuning.scoutSteps + tuning.approachMin,
                `${label}: ${id} is sighted before it lands`,
            );
            const minimumSpawns = Math.ceil(entry.deliveredStrength / INVASION_LIMITS.maxSpawnPerDistrictPerStep);
            assert.ok((spawnsByWave.get(id) ?? 0) >= minimumSpawns, `${label}: ${id} arrives in bounded chunks, never in one step`);
        }
        assert.equal(
            alarms,
            [...finished.values()].filter((entry) => entry.outcome === "breached" || entry.outcome === "fallen").length,
            `${label}: an alarm for each breach or fall`,
        );

        // Major invasions: a minimum gap, and a sliding-window bound.
        const majorStarts = [...waves.values()]
            .filter((record) => record.kind === "major")
            .map((record) => record.startedStep)
            .sort((left, right) => left - right);
        for (let index = 1; index < majorStarts.length; index += 1) {
            assert.ok(majorStarts[index] - majorStarts[index - 1] >= tuning.majorGapMin, `${label}: majors keep their minimum gap`);
        }
        for (const start of majorStarts) {
            const inWindow = majorStarts.filter((other) => other > start - tuning.majorWindowSteps && other <= start).length;
            assert.ok(inWindow <= tuning.maxMajorsPerWindow, `${label}: at most ${String(tuning.maxMajorsPerWindow)} majors per window`);
        }
        totalMajors += majorStarts.length;
        totalRaids += waves.size - majorStarts.length;

        assert.ok(districtsHit.size >= 2, `${label}: attacks reach more than one district`);
        assert.ok(bearings.size >= 3, `${label}: attacks come from more than one bearing`);
    }

    assert.ok(districtsAcrossSeeds.size >= 4, "across the seeds, attacks cover most of the kingdom");
    assert.ok(totalMajors >= 3, "major invasions do happen");
    assert.ok(totalRaids > 2 * totalMajors, "raids are the common case and majors are rarer");
});

test("distance decides what is physical: near groups are flagged, far ones stay numbers", () => {
    const cases = [
        { label: "a player at the walls", distance: 40, expectPhysical: true },
        { label: "a player beyond the physical radius", distance: 200, expectPhysical: false },
        { label: "no player loaded", distance: null, expectPhysical: false },
    ];
    for (const scenario of cases) {
        const kingdom = kingdomWithSeed(3);
        kingdom.invasion = director.createInvasionState(3, true);
        const proximity = Object.fromEntries(kingdom.districts.map((district) => [district.id, scenario.distance]));
        let sawPhysical = false;
        let sawFlag = false;
        for (let index = 0; index < 800; index += 1) {
            const result = tick(kingdom, { options: { proximity } });
            assert.deepEqual(result.problems, []);
            if (kingdom.invasion.wave?.physical) {
                sawPhysical = true;
            }
            if (result.events.some((text) => /flagged for physical representation/.test(text))) {
                sawFlag = true;
            }
        }
        assert.equal(sawPhysical, scenario.expectPhysical, `${scenario.label}: physical flag`);
        assert.equal(sawFlag, scenario.expectPhysical, `${scenario.label}: flag is announced`);
    }
});

test("a run is reproducible: same seed, same kingdom, same events, and a different seed differs", () => {
    /**
     * @param {number} seed
     * @param {number} steps
     */
    const run = (seed, steps) => {
        const kingdom = kingdomWithSeed(seed);
        kingdom.invasion = director.createInvasionState(seed, true);
        const events = [];
        for (let index = 0; index < steps; index += 1) {
            events.push(...tick(kingdom).events);
        }
        return { json: JSON.stringify(kingdom), events };
    };
    const first = run(424242, 1200);
    const second = run(424242, 1200);
    assert.equal(first.json, second.json);
    assert.deepEqual(first.events, second.events);
    assert.notEqual(run(424243, 1200).json, first.json);
});

test("wave state survives a save and reload in the middle of an assault", () => {
    const seed = 3;
    const straight = kingdomWithSeed(seed);
    straight.invasion = director.createInvasionState(seed, true);
    let saved = kingdomWithSeed(seed);
    saved.invasion = director.createInvasionState(seed, true);

    let reloadedAt = -1;
    for (let index = 0; index < 800; index += 1) {
        tick(straight);
        tick(saved);
        if (reloadedAt < 0 && saved.invasion.phase === "assault") {
            saved = JSON.parse(JSON.stringify(saved));
            reloadedAt = index;
        }
    }
    assert.ok(reloadedAt >= 0, "the run must reload during an assault");
    assert.equal(JSON.stringify(saved), JSON.stringify(straight), "the reloaded run is identical to the uninterrupted one");
});

test("an invalid directive is refused with an event and changes no district", () => {
    const kingdom = kingdomWithSeed(20261017);
    const districtsBefore = JSON.stringify(kingdom.districts);
    const battlesBefore = JSON.stringify(kingdom.battles);
    const rngBefore = kingdom.rngState;
    const logBefore = kingdom.log.length;
    const lost = kingdomWithSeed(20261017);
    lost.districts[0].security = "lost";

    const refusals = [
        { label: "unknown district", directive: { kind: "spawn", districtId: "district-99", waveId: "W0001", counts: { raider: 2, archer: 0, brute: 0 }, strength: 2 } },
        { label: "negative count", directive: { kind: "spawn", districtId: "district-1", waveId: "W0001", counts: { raider: -1, archer: 0, brute: 0 }, strength: -1 } },
        { label: "fractional count", directive: { kind: "spawn", districtId: "district-1", waveId: "W0001", counts: { raider: 1.5, archer: 0, brute: 0 }, strength: 1.5 } },
        { label: "strength that does not match its units", directive: { kind: "spawn", districtId: "district-1", waveId: "W0001", counts: { raider: 2, archer: 0, brute: 0 }, strength: 5 } },
        { label: "empty landing", directive: { kind: "spawn", districtId: "district-1", waveId: "W0001", counts: { raider: 0, archer: 0, brute: 0 }, strength: 0 } },
        { label: "unknown unit type", directive: { kind: "spawn", districtId: "district-1", waveId: "W0001", counts: { dragon: 1 }, strength: 1 } },
        { label: "over the per-district cap", directive: { kind: "spawn", districtId: "district-1", waveId: "W0001", counts: { raider: 7, archer: 0, brute: 0 }, strength: 7 } },
        { label: "landing on a fallen district", directive: { kind: "spawn", districtId: "district-1", waveId: "W0001", counts: { raider: 2, archer: 0, brute: 0 }, strength: 2 }, kingdom: lost },
        { label: "unknown bearing", directive: { kind: "scout", districtId: "district-1", waveId: "W0001", bearing: "up", label: "a raid", target: { kind: "wall", section: "north" } } },
        { label: "gate without an id", directive: { kind: "scout", districtId: "district-1", waveId: "W0001", bearing: "north", label: "a raid", target: { kind: "gate" } } },
        { label: "alarm for an unknown reason", directive: { kind: "alarm", districtId: "district-1", waveId: "W0001", reason: "fine" } },
        { label: "unknown kind", directive: { kind: "teleport", districtId: "district-1" } },
        { label: "not an object", directive: "nonsense" },
    ];

    for (const { label, directive, kingdom: target } of refusals) {
        const subject = target ?? kingdom;
        const before = JSON.stringify(subject.districts);
        const verdict = apply.applyDirectivesDetailed(subject, [directive]);
        assert.equal(verdict.results[0].accepted, false, `${label}: must be refused`);
        assert.ok(verdict.events.some((text) => /refused/.test(text)), `${label}: an event says why`);
        assert.equal(JSON.stringify(subject.districts), before, `${label}: no district changes`);
        assert.match(subject.log[0].text, /refused/, `${label}: the refusal is the newest log entry`);
    }

    assert.equal(JSON.stringify(kingdom.districts), districtsBefore, "district records are untouched by every refusal");
    assert.equal(JSON.stringify(kingdom.battles), battlesBefore);
    assert.equal(kingdom.rngState, rngBefore);
    assert.ok(logBefore === 0 && kingdom.log.length > 0, "refusals are visible in the event log");
});

test("the per-tick directive cap and the per-tick strength cap refuse the excess", () => {
    const kingdom = kingdomWithSeed(5);
    const sighting = { kind: "scout", districtId: "district-2", waveId: "W0001", bearing: "north", label: "a raid", target: { kind: "wall", section: "east" } };
    const six = apply.applyDirectivesDetailed(kingdom, [sighting, sighting, sighting, sighting, sighting, sighting]);
    assert.equal(six.results.filter((entry) => entry.accepted).length, INVASION_LIMITS.maxDirectivesPerStep);
    assert.equal(six.results.filter((entry) => !entry.accepted).length, 2);

    const landing = (/** @type {string} */ districtId) => ({
        kind: "spawn",
        districtId,
        waveId: "W0002",
        counts: { raider: 5, archer: 0, brute: 0 },
        strength: 5,
    });
    const pair = apply.applyDirectivesDetailed(kingdom, [landing("district-1"), landing("district-2")]);
    assert.equal(pair.results[0].accepted, true);
    assert.equal(pair.results[1].accepted, false, "the second landing would take the kingdom past its per-tick cap");
});

test("an accepted landing only moves assault, and escalates security through war.js", () => {
    const kingdom = kingdomWithSeed(9);
    const district = kingdom.districts[0];
    const soldiers = district.soldiers;
    const integrity = district.defensiveIntegrity;
    const verdict = apply.applyDirectivesDetailed(kingdom, [
        { kind: "spawn", districtId: district.id, waveId: "W0001", counts: { raider: 3, archer: 1, brute: 0 }, strength: 5 },
    ]);
    assert.equal(verdict.results[0].accepted, true);
    assert.equal(district.assault, 5);
    assert.equal(district.soldiers, soldiers, "a landing takes no soldiers");
    assert.equal(district.defensiveIntegrity, integrity, "a landing does not touch the wall");
    assert.equal(district.security, "alert", "war.js escalates the security level for the landing");
    assert.ok(verdict.events.some((text) => /press the district/.test(text)));
    assert.deepEqual(findValidationProblems(kingdom), []);
});
