import assert from "node:assert/strict";
import test from "node:test";
import { contract, createKingdom, population } from "../lib/peopleharness.mjs";

const startingRoster = (kingdom = createKingdom()) =>
    contract.createRoster(kingdom.districts.map((district) => ({ id: district.id, civilians: district.civilians, soldiers: district.soldiers, garrison: district.garrison })));

test("the starting roster holds 400 civilians and 150 soldiers split 80/30 over five districts", () => {
    const kingdom = createKingdom();
    const records = startingRoster(kingdom);
    assert.equal(records.length, 550);
    const totals = contract.populationTotals(records);
    assert.equal(totals.civilianKind, 400);
    assert.equal(totals.soldiers, 150);
    assert.equal(totals.total, 550);
    for (const district of kingdom.districts) {
        const bucket = totals.byDistrict[district.id];
        assert.equal(bucket.civilians, 80, `${district.id} civilians`);
        assert.equal(bucket.soldiers, 30, `${district.id} soldiers`);
        assert.equal(bucket.trainees, 0);
    }
    assert.deepEqual(contract.validateRoster(records), { ok: true, problems: [] });
    assert.equal(contract.checkPopulation(records, kingdom.districts).ok, true);
});

test("record ids are canonical: they encode district and kind, and only the canonical form parses", () => {
    assert.equal(contract.makeRecordId("district-1", "civilian", 7), "civ-district-1-civilian-007");
    assert.deepEqual(contract.parseRecordId("civ-district-5-soldier-120"), { district: "district-5", kind: "soldier", n: 120 });
    assert.equal(contract.parseRecordId("civ-district-1-civilian-7"), null, "unpadded sequence");
    assert.equal(contract.parseRecordId("civ-district-01-civilian-007"), null, "leading zero in district");
    assert.equal(contract.parseRecordId("civ-district-1-villager-007"), null, "unknown kind");
    assert.equal(contract.parseRecordId(undefined), null);
    assert.throws(() => contract.makeRecordId("district-1", "civilian", 0));
    assert.throws(() => contract.makeRecordId("hearthgate", "civilian", 1));
});

test("validators reject records that break the contract", () => {
    const [good] = startingRoster().filter((record) => record.kind === "civilian");
    assert.deepEqual(contract.validateRecord(good), []);
    const cases = [
        ["mismatched district", { ...good, district: "district-2" }],
        ["role of the wrong kind", { ...good, role: "guard" }],
        ["state of the wrong kind", { ...good, state: "wall" }],
        ["slot of another district", { ...good, home: "district-2/home-01" }],
        ["unknown slot", { ...good, home: "district-1/home-09" }],
        ["negative revision", { ...good, revision: -1 }],
        ["unknown field", { ...good, hp: 20 }],
        ["successor without graduation", { ...good, successor: "civ-district-1-soldier-031" }],
        ["graduated without successor", { ...good, state: "graduated" }],
    ];
    for (const [label, record] of cases) {
        assert.ok(contract.validateRecord(record).length > 0, label);
    }
});

test("roster validation catches gaps, duplicates and dangling successors", () => {
    const records = startingRoster();
    const withoutMiddle = records.filter((record) => record.id !== "civ-district-1-civilian-010");
    assert.match(contract.validateRoster(withoutMiddle).problems.join("; "), /sequence has gaps/);
    const duplicated = [...records, { ...records[0] }];
    assert.match(contract.validateRoster(duplicated).problems.join("; "), /duplicate id/);
    const soldier = records.find((record) => record.kind === "soldier");
    const dangling = records.map((record) => (record.kind === "civilian" && record.district === "district-1" && record.id.endsWith("001")
        ? { ...record, state: "graduated", successor: soldier.id.replace("soldier-001", "soldier-999") }
        : record));
    assert.match(contract.validateRoster(dangling).problems.join("; "), /successor/);
});

test("enlistment moves people into training without creating or losing anyone", () => {
    const kingdom = createKingdom();
    const records = startingRoster(kingdom);
    const next = contract.enlistRecruits(records, "district-2", 5).records;
    assert.equal(next.length, records.length, "no record is created or deleted");
    const totals = contract.populationTotals(next);
    assert.equal(totals.trainees, 5);
    assert.equal(totals.civilianKind, 400, "trainees are still civilian records, so 400 holds");
    assert.equal(totals.soldiers, 150);
    const trainee = next.find((record) => record.state === "training");
    assert.equal(trainee.workplace, "district-2/barracks");
    assert.equal(trainee.revision, 1, "every change bumps the revision");
    assert.throws(() => contract.enlistRecruits(records, "district-2", 81), /cannot enlist/);
});

test("graduation keeps the civilian record, adds one soldier record, and conserves the 550 people", () => {
    const records = startingRoster();
    const trained = contract.enlistRecruits(records, "district-3", 4).records;
    const graduated = contract.graduateTrainees(trained, "district-3", 3);
    assert.equal(graduated.records.length, records.length + 3, "three new soldier records");
    assert.equal(graduated.created.length, 3);
    const totals = contract.populationTotals(graduated.records);
    assert.equal(totals.graduated, 3);
    assert.equal(totals.trainees, 1);
    assert.equal(totals.civilianKind, 397);
    assert.equal(totals.soldiers, 153);
    assert.equal(totals.total, 550);
    const retired = graduated.records.find((record) => record.state === "graduated");
    assert.ok(graduated.records.some((record) => record.id === retired.successor), "successor exists");
    assert.deepEqual(contract.validateRoster(graduated.records), { ok: true, problems: [] });
});

test("deaths are tombstones: the records remain and the living totals fall", () => {
    const records = startingRoster();
    const died = contract.recordDeaths(records, "district-4", "civilian", 2).records;
    assert.equal(died.length, records.length, "no record deleted");
    assert.equal(died.filter((record) => record.state === "dead").length, 2);
    assert.equal(contract.populationTotals(died).civilianKind, 398);
});

test("sync is idempotent, and exact economy events are applied without inference", () => {
    const kingdom = createKingdom();
    const records = startingRoster(kingdom);
    kingdom.districts[0].civilians -= 2;
    kingdom.districts[0].trainingQueue += 2;
    const first = contract.syncPopulation(records, kingdom.districts, [{ op: "recruit", district: "district-1", count: 2 }]);
    assert.deepEqual(first.problems, []);
    assert.ok(first.ops.every((op) => op.inferred !== true), "the event was exact");
    assert.equal(contract.checkPopulation(first.records, kingdom.districts).ok, true);
    const second = contract.syncPopulation(first.records, kingdom.districts);
    assert.deepEqual(second.ops, []);
    assert.deepEqual(second.records, first.records);
});

test("a restart with no events restores exact totals and marks what it inferred", () => {
    const kingdom = createKingdom();
    const stale = startingRoster(kingdom);
    kingdom.districts[1].civilians -= 3;
    kingdom.districts[1].trainingQueue += 3;
    kingdom.districts[1].soldiers += 1;
    const healed = contract.syncPopulation(stale, kingdom.districts);
    assert.deepEqual(healed.problems, []);
    assert.equal(contract.checkPopulation(healed.records, kingdom.districts).ok, true);
    assert.ok(healed.ops.length > 0);
    assert.ok(healed.ops.every((op) => op.inferred === true), "every op from the net path is marked inferred");
    assert.equal(contract.populationTotals(healed.records).total, 551, "the economy really did gain one soldier here");
});

test("recruitment and training from population.js stay consistent with the records step by step", () => {
    const kingdom = createKingdom();
    let records = startingRoster(kingdom);
    let seed = 11;
    const pick = (limit) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % limit;
    };
    for (let step = 1; step <= 300; step += 1) {
        const district = kingdom.districts[pick(kingdom.districts.length)];
        const events = [];
        try {
            const enlisted = population.openRecruitment(district, 1 + pick(3), { kingdom });
            events.push({ op: "recruit", district: district.id, count: enlisted.recruits });
        } catch (_refused) {
            // Shortage or a full queue: the economy refused, nothing changed.
        }
        for (const other of kingdom.districts) {
            const trained = population.advanceTraining(kingdom, other);
            if (trained.graduated > 0) events.push({ op: "graduate", district: other.id, count: trained.graduated });
        }
        const synced = contract.syncPopulation(records, kingdom.districts, events);
        assert.deepEqual(synced.problems, [], `step ${String(step)}`);
        assert.ok(synced.ops.every((op) => op.inferred !== true), `step ${String(step)} needed no inference`);
        records = synced.records;
        const check = contract.checkPopulation(records, kingdom.districts);
        assert.equal(check.ok, true, `step ${String(step)}: ${check.mismatches.join("; ")}`);
        assert.equal(contract.populationTotals(records).total, 550, `step ${String(step)} totals`);
    }
    assert.ok(contract.populationTotals(records).graduated > 0, "training actually happened");
});

test("the contract never removes a record: no operation shrinks the roster", () => {
    let records = startingRoster();
    const sizes = [records.length];
    records = contract.enlistRecruits(records, "district-1", 3).records;
    sizes.push(records.length);
    records = contract.graduateTrainees(records, "district-1", 3).records;
    sizes.push(records.length);
    records = contract.recordDeaths(records, "district-1", "soldier", 2).records;
    sizes.push(records.length);
    records = contract.recordBirths(records, "district-1", "civilian", 2).records;
    sizes.push(records.length);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), "monotone non-decreasing");
});
