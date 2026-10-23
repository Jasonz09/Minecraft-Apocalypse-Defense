import assert from "node:assert/strict";
import test from "node:test";
import { contract, createKingdom, createLayout, createRng, lod } from "../lib/peopleharness.mjs";

const kingdom = createKingdom();
const districtIds = kingdom.districts.map((district) => district.id);
const layout = createLayout(districtIds);
const records = contract.createRoster(kingdom.districts.map((district) => ({ id: district.id, civilians: district.civilians, soldiers: district.soldiers, garrison: district.garrison })));
const everyLoaded = () => true;

/** Run the planner, feeding back its own output as the physical set, for `ticks` ticks. */
function converge(players, ticks, physical = [], extra = {}) {
    let current = physical.slice();
    let plan = null;
    for (let tick = 1; tick <= ticks; tick += 1) {
        plan = lod.planLod({ tick, players, records: extra.records ?? records, anchors: layout.anchors, physical: current, isLoaded: extra.isLoaded ?? everyLoaded, limits: extra.limits });
        current = plan.desired;
    }
    return { plan, physical: current };
}

test("one player materialises at most four people per tick, however many are in range", () => {
    const centre = layout.centres[0];
    const plan = lod.planLod({ tick: 1, players: [{ id: "p1", x: centre.x, z: centre.z }], records, anchors: layout.anchors, physical: [] });
    assert.equal(plan.materialise.length, 4);
    assert.equal(plan.budgets.spawns, 4);
    assert.ok(plan.deferred.some((entry) => entry.reason.includes("spawn budget")), "the rest are deferred, not dropped");
    assert.ok(plan.desired.length === 4);
});

test("per-district and per-kingdom caps hold while a crowd converges", () => {
    const centre = layout.centres[0];
    const { plan, physical } = converge([{ id: "p1", x: centre.x, z: centre.z }], 40);
    assert.equal(physical.length, lod.LOD_LIMITS.districtCap, "the district fills exactly to its cap");
    assert.equal(plan.budgets.perDistrict[districtIds[0]], 24);
    assert.ok(physical.length <= lod.LOD_LIMITS.maxPhysical);
});

test("kingdom cap binds when several districts are crowded at once", () => {
    const players = layout.centres.slice(0, 4).map((centre, index) => ({ id: `p${String(index + 1)}`, x: centre.x, z: centre.z }));
    const { physical } = converge(players, 60, [], { limits: { maxPhysical: 50, playerCap: 60 } });
    assert.equal(physical.length, 50);
});

test("a player's visibility budget caps the people within keep range of that player", () => {
    const centre = layout.centres[0];
    const { plan } = converge([{ id: "p1", x: centre.x, z: centre.z }], 40, [], { limits: { districtCap: 200, maxPhysical: 500, playerCap: 10 } });
    assert.equal(plan.desired.length, 10);
    assert.ok(plan.dematerialise.length === 0);
    const rejected = plan.deferred.filter((entry) => entry.reason.includes("cap"));
    assert.ok(rejected.length > 0);
});

test("hysteresis: a unit inside the radius is admitted, a unit outside it is not, and an admitted unit is kept until radius plus hysteresis", () => {
    const anchor = layout.anchors["district-1/home-01"];
    const one = contract.createRoster([{ id: "district-1", civilians: 1, soldiers: 0 }]);
    const single = one.map((record) => ({ ...record, state: "home", home: "district-1/home-01", workplace: null }));
    const at = (distance) => ({ id: "p1", x: anchor.x + distance, z: anchor.z });
    const id = single[0].id;

    const admitted = lod.planLod({ tick: 1, players: [at(lod.LOD_LIMITS.radius - 1)], records: single, anchors: layout.anchors, physical: [] });
    assert.deepEqual(admitted.desired, [id]);

    const outside = lod.planLod({ tick: 1, players: [at(lod.LOD_LIMITS.radius + 1)], records: single, anchors: layout.anchors, physical: [] });
    assert.deepEqual(outside.desired, [], "a non-physical unit beyond the radius is not admitted");

    const keepDistance = lod.LOD_LIMITS.radius + lod.LOD_LIMITS.hysteresis - 1;
    const kept = lod.planLod({ tick: 2, players: [at(keepDistance)], records: single, anchors: layout.anchors, physical: [id] });
    assert.deepEqual(kept.desired, [id], "a physical unit inside the keep band stays");
    assert.deepEqual(kept.dematerialise, []);

    const released = lod.planLod({ tick: 3, players: [at(keepDistance + 2)], records: single, anchors: layout.anchors, physical: [id] });
    assert.deepEqual(released.desired, []);
    assert.equal(released.dematerialise.length, 1);
});

test("hysteresis: a unit oscillating across the admission edge does not flicker", () => {
    const anchor = layout.anchors["district-1/home-01"];
    const single = contract.createRoster([{ id: "district-1", civilians: 1, soldiers: 0 }]).map((record) => ({ ...record, state: "home", home: "district-1/home-01", workplace: null }));
    let physical = [];
    let transitions = 0;
    for (let tick = 1; tick <= 200; tick += 1) {
        const distance = tick % 2 === 0 ? lod.LOD_LIMITS.radius - 1 : lod.LOD_LIMITS.radius + 4;
        const plan = lod.planLod({ tick, players: [{ id: "p1", x: anchor.x + distance, z: anchor.z }], records: single, anchors: layout.anchors, physical });
        if (plan.desired.length !== physical.length) transitions += 1;
        physical = plan.desired;
    }
    assert.equal(transitions, 1, "admitted once and never toggled off by a 4-block wobble");
});

test("a newcomer whose leash square touches an unloaded chunk is held, not spawned", () => {
    const centre = layout.centres[0];
    const player = [{ id: "p1", x: centre.x, z: centre.z }];
    const plan = lod.planLod({ tick: 1, players: player, records, anchors: layout.anchors, physical: [], isLoaded: () => false });
    assert.equal(plan.materialise.length, 0);
    assert.ok(plan.held.length > 0);
    assert.match(plan.held[0].reason, /not loaded/);
});

test("physical units stand within the leash of their anchor, and identical people do not stack", () => {
    const centre = layout.centres[1];
    const plan = lod.planLod({ tick: 1, players: [{ id: "p1", x: centre.x, z: centre.z }], records, anchors: layout.anchors, physical: [], limits: { districtCap: 200, playerCap: 200, maxPhysical: 300, maxSpawnsPerTick: 300 } });
    for (const entry of plan.materialise) {
        const anchor = layout.anchors[entry.slot];
        assert.ok(Math.abs(entry.at.x - anchor.x) <= lod.LOD_LIMITS.leash, entry.id);
        assert.ok(Math.abs(entry.at.z - anchor.z) <= lod.LOD_LIMITS.leash, entry.id);
    }
    const spots = new Set(plan.materialise.map((entry) => `${entry.at.x},${entry.at.z}`));
    assert.ok(spots.size > 20, `offsets spread people out (${String(spots.size)} distinct spots)`);
});

test("dead and graduated records are dematerialised when physical, and records with no anchor are reported", () => {
    const dead = records.find((record) => record.kind === "civilian");
    const tombstoned = contract.recordDeaths(records, dead.district, "civilian", 1).records.find((record) => record.state === "dead");
    const plan = lod.planLod({ tick: 1, players: [], records: [tombstoned], anchors: layout.anchors, physical: [tombstoned.id] });
    assert.equal(plan.dematerialise.length, 1);
    assert.match(plan.dematerialise[0].reason, /dead/);
    const noAnchor = lod.planLod({ tick: 1, players: [{ id: "p1", x: 0, z: 0 }], records: [{ ...dead, home: "district-1/home-01" }], anchors: {}, physical: [] });
    assert.deepEqual(noAnchor.noAnchor, [dead.id]);
    assert.deepEqual(noAnchor.desired, []);
});

test("planning is deterministic: the same inputs in any order give the same plan", () => {
    const players = [{ id: "p2", x: layout.centres[2].x + 9, z: layout.centres[2].z }, { id: "p1", x: layout.centres[0].x, z: layout.centres[0].z }];
    const a = lod.planLod({ tick: 5, players, records, anchors: layout.anchors, physical: [records[3].id] });
    const shuffled = records.slice().reverse();
    const b = lod.planLod({ tick: 5, players: players.slice().reverse(), records: shuffled, anchors: layout.anchors, physical: [records[3].id] });
    assert.deepEqual(a, b);
});

test("random crowds, walks and loaded-chunk patterns never break a budget", () => {
    const rng = createRng(20261023);
    const recordById = new Map(records.map((record) => [record.id, record]));
    for (let trial = 0; trial < 200; trial += 1) {
        const playerCount = Math.floor(rng() * 4);
        const players = Array.from({ length: playerCount }, (_unused, index) => {
            const centre = layout.centres[Math.floor(rng() * layout.centres.length)];
            return { id: `p${String(index + 1)}`, x: centre.x + Math.round((rng() - 0.5) * 120), z: centre.z + Math.round((rng() - 0.5) * 120) };
        });
        const physical = records.filter(() => rng() < 0.3).map((record) => record.id);
        const loadedRate = rng();
        const plan = lod.planLod({ tick: trial, players, records, anchors: layout.anchors, physical, isLoaded: () => rng() < loadedRate });
        assert.ok(plan.materialise.length <= lod.LOD_LIMITS.maxSpawnsPerTick, `trial ${String(trial)} spawns`);
        assert.ok(plan.desired.length <= lod.LOD_LIMITS.maxPhysical, `trial ${String(trial)} total`);
        const liveIds = new Set(records.map((record) => record.id));
        for (const id of plan.desired) assert.ok(liveIds.has(id), `${id} is a record`);
        const byDistrict = new Map();
        for (const id of plan.desired) {
            const district = id.split("-").slice(1, 3).join("-");
            byDistrict.set(district, (byDistrict.get(district) ?? 0) + 1);
        }
        for (const [district, count] of byDistrict) assert.ok(count <= lod.LOD_LIMITS.districtCap, `${district} in trial ${String(trial)}`);
        const keepSq = (lod.LOD_LIMITS.radius + lod.LOD_LIMITS.hysteresis) ** 2;
        for (const player of players) {
            const near = plan.desired.filter((id) => {
                const anchor = layout.anchors[contract.anchorSlotFor(recordById.get(id))];
                return (anchor.x - player.x) ** 2 + (anchor.z - player.z) ** 2 <= keepSq;
            });
            assert.ok(near.length <= lod.LOD_LIMITS.playerCap, `trial ${String(trial)}: ${String(near.length)} units near ${player.id}`);
        }
    }
});

test("limits must be non-negative numbers", () => {
    assert.throws(() => lod.resolveLimits({ radius: -1 }), /non-negative/);
    assert.throws(() => lod.resolveLimits({ chunkSize: 0 }), /chunkSize/);
    assert.equal(lod.resolveLimits({ districtCap: 30 }).districtCap, 30);
});
