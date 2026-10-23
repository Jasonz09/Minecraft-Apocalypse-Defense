import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const loadModule = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { ROLES } = await loadModule("people", "occupations.js");
const { LOCATIONS, ROUTINE_RULES, dailySchedule, hoursPerLocation, isSleepHour, locationAt } = await loadModule("people", "routines.js");
const { STEPS_PER_DAY } = await loadModule("sim", "clock.js");

const SECURITY_STATES = ["secure", "alert", "contested", "breached", "isolated", "lost"];

test("every hour of every role resolves to exactly one location class", () => {
    for (const role of ROLES) {
        for (const security of SECURITY_STATES) {
            for (let hour = 0; hour < STEPS_PER_DAY; hour += 1) {
                const entry = locationAt({ step: hour, role, security });
                assert.equal(entry.hour, hour, `${role}/${security} reports hour ${String(hour)}`);
                if (security === "lost") {
                    assert.equal(entry.location, null, `${role} in a lost district has no location at hour ${String(hour)}`);
                } else {
                    assert.ok(LOCATIONS.includes(entry.location), `${role}/${security} hour ${String(hour)} -> '${String(entry.location)}'`);
                }
            }
        }
    }
});

test("a day has 24 entries and the hour is the simulation step modulo 24", () => {
    for (const role of ROLES) {
        const day = dailySchedule(role, "secure");
        assert.equal(day.length, 24);
        for (let hour = 0; hour < 24; hour += 1) {
            assert.deepEqual(locationAt({ step: hour + 24 * 37, role, security: "secure" }).location, day[hour].location, `${role} hour ${String(hour)} wraps`);
        }
    }
});

test("the hours of a role across locations add up to 24 in every security state that has a routine", () => {
    for (const role of ROLES) {
        for (const security of SECURITY_STATES.filter((state) => state !== "lost")) {
            const totals = hoursPerLocation(role, security);
            const sum = Object.values(totals).reduce((left, right) => left + right, 0);
            assert.equal(sum, 24, `${role}/${security} hours sum to ${String(sum)}`);
        }
    }
});

test("sleep is at home at night for every civilian, and sleep hours wrap midnight", () => {
    const nights = [22, 23, 0, 1, 2, 3, 4, 5];
    for (const hour of nights) {
        assert.equal(isSleepHour(hour), true, `hour ${String(hour)} is a sleep hour`);
    }
    for (const hour of [6, 7, 8, 12, 17, 18, 21]) {
        assert.equal(isSleepHour(hour), false, `hour ${String(hour)} is not a sleep hour`);
    }
    for (const role of ["farmer", "worker", "smith", "builder", "none", "child", "elder"]) {
        for (const hour of nights) {
            const entry = locationAt({ step: hour, role, security: "secure" });
            assert.equal(entry.location, "home", `${role} sleeps at home at hour ${String(hour)}`);
            assert.equal(entry.activity, "sleep");
        }
    }
});

test("working hours put each post at its workplace and the noon meal is taken at market by working adults", () => {
    for (let hour = ROUTINE_RULES.workFromHour; hour <= ROUTINE_RULES.workUntilHour; hour += 1) {
        if (hour === ROUTINE_RULES.noonMealHour) {
            continue;
        }
        assert.equal(locationAt({ step: hour, role: "farmer" }).location, "farm");
        assert.equal(locationAt({ step: hour, role: "worker" }).location, "work");
        assert.equal(locationAt({ step: hour, role: "smith" }).location, "work");
        assert.equal(locationAt({ step: hour, role: "builder" }).location, "work");
        assert.equal(locationAt({ step: hour, role: "none" }).location, "market");
        assert.equal(locationAt({ step: hour, role: "child" }).location, "home");
    }
    for (const role of ["farmer", "worker", "smith", "builder", "none"]) {
        assert.equal(locationAt({ step: ROUTINE_RULES.noonMealHour, role }).location, "market", `${role} eats at the market at noon`);
    }
    for (const role of ["child", "elder"]) {
        assert.equal(locationAt({ step: ROUTINE_RULES.noonMealHour, role }).location, "home", `${role} eats at home at noon`);
    }
});

test("meals happen at fixed hours and guards hold the wall from the barracks at every hour", () => {
    for (const role of ["farmer", "smith", "worker"]) {
        assert.equal(locationAt({ step: ROUTINE_RULES.breakfastHour, role }).activity, "eat");
        assert.equal(locationAt({ step: ROUTINE_RULES.supperHour, role }).activity, "eat");
    }
    for (let hour = 0; hour < 24; hour += 1) {
        const entry = locationAt({ step: hour, role: "guard", security: "secure" });
        assert.equal(entry.location, "barracks", `guard at hour ${String(hour)}`);
        assert.equal(entry.activity, "watch");
    }
});

test("under threat civilians take shelter around the clock and guards stay on the wall", () => {
    for (const security of ROUTINE_RULES.threatSecurity) {
        for (let hour = 0; hour < 24; hour += 1) {
            for (const role of ROLES.filter((item) => item !== "guard")) {
                assert.equal(locationAt({ step: hour, role, security }).location, "shelter", `${role} in ${security} at hour ${String(hour)}`);
            }
            assert.equal(locationAt({ step: hour, role: "guard", security }).location, "barracks");
        }
    }
    assert.equal(locationAt({ step: 9, role: "farmer", security: "alert" }).location, "farm", "alert alone does not move people");
});

test("the routine is deterministic and rejects bad input instead of guessing", () => {
    const first = JSON.stringify(dailySchedule("farmer", "alert"));
    assert.equal(JSON.stringify(dailySchedule("farmer", "alert")), first);
    assert.throws(() => locationAt({ step: -1, role: "farmer" }), /step must be a non-negative/);
    assert.throws(() => locationAt({ step: 1.5, role: "farmer" }), /step must be a non-negative/);
    assert.throws(() => locationAt({ step: 1, role: "wizard" }), /unknown role/);
});
