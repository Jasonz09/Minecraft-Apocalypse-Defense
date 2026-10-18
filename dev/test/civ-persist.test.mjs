// Persistence / job queue / budget suite for the civilization pipeline (civ/planstore.js,
// civ/jobs.js, civ/budget.js). Uses a fake world with a property-size limit and crash injection.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "CivilizationApocalypse_BP", "scripts", "civ");
const load = (name) => import(pathToFileURL(join(root, name)).href);
const store = await load("planstore.js");
const jobs = await load("jobs.js");
const budget = await load("budget.js");

const PROPERTY_LIMIT = 32767;

class Crash extends Error {}

/** Map-backed world with the engine's string-size limit and write-count crash injection. */
function fakeWorld({ withIds = true, limit = PROPERTY_LIMIT } = {}) {
    const props = new Map();
    const world = {
        props,
        writes: 0,
        crashAfter: null, // number of writes allowed before the process "dies"
        dead: false,
        getDynamicProperty: (k) => props.get(k),
        setDynamicProperty(k, v) {
            if (world.dead || (world.crashAfter !== null && world.writes >= world.crashAfter)) {
                world.dead = true;
                throw new Crash("simulated crash");
            }
            if (typeof v === "string" && v.length > limit) throw new RangeError("dynamic property value too long");
            world.writes += 1;
            if (v === undefined) props.delete(k);
            else props.set(k, v);
        },
        arm(n) {
            world.crashAfter = world.writes + n;
            world.dead = false;
        },
        restart() {
            world.crashAfter = null;
            world.dead = false;
        },
    };
    if (withIds) world.getDynamicPropertyIds = () => [...props.keys()];
    return world;
}

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Deterministic plan-shaped JSON of roughly `targetBytes` bytes. */
function makePlan(targetBytes, seed = 1, version = 1) {
    const r = rng(seed);
    const plan = { version, seed, anchor: { x: 10, z: -4 }, cell: 4, labels: [], walls: [] };
    let size = JSON.stringify(plan).length;
    while (size < targetBytes - 60) {
        const row = [Math.floor(r() * 6), Math.floor(r() * 90) + 1];
        plan.labels.push(row);
        size += JSON.stringify(row).length + 1;
    }
    plan.tag = `seed${String(seed)}`;
    return plan;
}

// ------------------------------------------------------------------------ plan store

test("fnv1a and utf8Length are stable and correct", () => {
    assert.equal(store.fnv1a(""), "811c9dc5");
    assert.equal(store.fnv1a("a"), "e40c292c");
    assert.equal(store.utf8Length("abc"), 3);
    assert.equal(store.utf8Length("é"), 2);
    assert.equal(store.utf8Length("€"), 3);
    assert.equal(store.utf8Length("\u{1F600}"), 4);
    const chunks = store.splitChunks("a\u{1F600}b", 2); // boundary would fall inside the surrogate pair
    assert.equal(chunks.join(""), "a\u{1F600}b");
    for (const c of chunks) assert.ok(!/[\ud800-\udbff]$/.test(c), "chunk must not end on a high surrogate");
});

for (const kb of [5, 30, 60]) {
    test(`plan round trip ${String(kb)} KB, every property within the limit`, () => {
        const world = fakeWorld();
        const ps = store.createPlanStore(world);
        const plan = makePlan(kb * 1000, kb);
        const m = ps.measurePlan(plan);
        assert.ok(m.bytes >= kb * 1000 - 200 && m.bytes <= kb * 1000, `plan size ${String(m.bytes)}`);
        const saved = ps.savePlan(plan);
        assert.equal(saved.ok, true, saved.reason);
        assert.equal(saved.chunks, Math.ceil(m.bytes / 30000));
        for (const [k, v] of world.props) assert.ok(typeof v !== "string" || v.length <= 30000, `${k} is ${String(v.length)} chars`);
        const loaded = ps.loadPlan();
        assert.equal(loaded.status, "ok");
        assert.deepEqual(loaded.plan, plan);
        console.log(`plan ${String(kb)} KB -> ${String(saved.chunks)} chunk(s), ${String(world.props.size)} properties, meta ${String(world.props.get("civ:plan:meta").length)} chars`);
    });
}

test("absent store reports absent; world without optional members still works", () => {
    const world = fakeWorld({ withIds: false });
    const ps = store.createPlanStore(world);
    assert.equal(ps.loadPlan().status, "absent");
    assert.equal(ps.savePlan(makePlan(2000)).ok, true);
    assert.equal(ps.loadPlan().status, "ok");
    assert.deepEqual(ps.ownedKeys(), []); // no getDynamicPropertyIds -> defensive empty
});

test("property-size limit enforced by the world: failed save keeps the old plan, no half generation", () => {
    const world = fakeWorld({ limit: 20000 }); // stricter than the engine: chunks of 30000 chars cannot be written
    const small = store.createPlanStore(world, { chunkChars: 9000 });
    const old = makePlan(8000, 3);
    assert.equal(small.savePlan(old).ok, true);
    const big = makePlan(50000, 4);
    const res = store.createPlanStore(world, { chunkChars: 30000 }).savePlan(big);
    assert.equal(res.ok, false);
    assert.equal(res.status, "write_failed");
    assert.match(res.reason, /too long/);
    assert.deepEqual(small.loadPlan().plan, old);
    assert.deepEqual(small.ownedKeys().sort(), ["civ:plan:meta", "civ:plan:a:0"].sort());
    // and with chunks that fit, the same plan is stored fine
    assert.equal(small.savePlan(big).ok, true);
    assert.deepEqual(small.loadPlan().plan, big);
    for (const v of world.props.values()) assert.ok(typeof v !== "string" || v.length <= 20000);
    assert.ok(store.createPlanStore(fakeWorld(), { chunkChars: 99999 }).chunkChars <= 32000, "chunk size is clamped below the engine limit");
});

test("size validation happens BEFORE any write and reports the budget", () => {
    const world = fakeWorld();
    const ps = store.createPlanStore(world, { maxBytes: 50000 });
    const res = ps.savePlan(makePlan(60000, 5));
    assert.equal(res.ok, false);
    assert.equal(res.status, "too_large");
    assert.equal(res.limit, 50000);
    assert.ok(res.bytes > 50000);
    assert.equal(world.writes, 0, "nothing may be written when over budget");
    const dflt = store.createPlanStore(fakeWorld());
    assert.equal(dflt.maxBytes, budget.CIV_LIMITS.maxPlanBytes);
    assert.equal(dflt.savePlan(makePlan(125000, 6)).ok, false);
    assert.equal(dflt.savePlan(makePlan(118000, 6)).ok, true);
});

for (const [kb, chunkChars] of [[30, 30000], [60, 30000], [20, 3000]]) {
    test(`crash injection at EVERY write: ${String(kb)} KB plan, chunk ${String(chunkChars)}`, () => {
        const oldPlan = makePlan(kb * 1000, 11);
        const newPlan = makePlan(kb * 1000 + 777, 12);
        let sawOld = 0;
        let sawNew = 0;
        let completed = false;
        for (let n = 0; n < 200 && !completed; n += 1) {
            const world = fakeWorld();
            const ps = store.createPlanStore(world, { chunkChars });
            assert.equal(ps.savePlan(oldPlan).ok, true);
            world.arm(n);
            let result;
            try {
                result = ps.savePlan(newPlan);
            } catch (error) {
                assert.ok(error instanceof Crash);
            }
            const crashed = world.dead;
            world.restart();
            const reloaded = store.createPlanStore(world, { chunkChars }).loadPlan();
            assert.equal(reloaded.status, "ok", `n=${String(n)}: ${String(reloaded.reason)}`);
            const isOld = JSON.stringify(reloaded.plan) === JSON.stringify(oldPlan);
            const isNew = JSON.stringify(reloaded.plan) === JSON.stringify(newPlan);
            assert.ok(isOld !== isNew, `n=${String(n)}: neither old nor new (or both)`);
            if (isOld) sawOld += 1;
            else sawNew += 1;
            if (result?.ok === true) assert.ok(isNew, "a save that returned ok must be live");
            if (!crashed) completed = true;
            // The store heals: the next save always works and leaves exactly one generation.
            const again = store.createPlanStore(world, { chunkChars });
            assert.equal(again.savePlan(newPlan).ok, true);
            const keys = again.ownedKeys().sort();
            const meta = JSON.parse(world.props.get("civ:plan:meta"));
            const expected = ["civ:plan:meta", ...Array.from({ length: meta.chunks }, (_, i) => `civ:plan:${meta.fam}:${String(i)}`)].sort();
            assert.deepEqual(keys, expected, `n=${String(n)} leaves orphans`);
        }
        assert.ok(completed, "loop must reach a crash-free save");
        assert.ok(sawOld > 0 && sawNew > 0, `old=${String(sawOld)} new=${String(sawNew)}: the crash window must exist on both sides of the flip`);
        console.log(`${String(kb)} KB/chunk ${String(chunkChars)}: ${String(sawOld + sawNew)} crash points, old ${String(sawOld)} / new ${String(sawNew)}, zero mixes`);
    });
}

test("crash injection on the very first save: absent or complete, never partial", () => {
    const plan = makePlan(45000, 21);
    let completed = false;
    let absent = 0;
    for (let n = 0; n < 50 && !completed; n += 1) {
        const world = fakeWorld();
        const ps = store.createPlanStore(world);
        world.arm(n);
        try {
            ps.savePlan(plan);
        } catch (_e) {
            /* swallowed by savePlan */
        }
        const crashed = world.dead;
        world.restart();
        const r = ps.loadPlan();
        assert.ok(r.status === "absent" || (r.status === "ok" && JSON.stringify(r.plan) === JSON.stringify(plan)), `n=${String(n)} ${r.status}`);
        if (r.status === "absent") absent += 1;
        if (!crashed) completed = true;
    }
    assert.ok(completed && absent > 0);
});

test("corruption: flipped character, dropped chunk, missing meta chunks, bad meta, wrong format", () => {
    const plan = makePlan(40000, 31);
    const base = () => {
        const w = fakeWorld();
        const ps = store.createPlanStore(w);
        assert.equal(ps.savePlan(plan).ok, true);
        return { w, ps, meta: JSON.parse(w.props.get("civ:plan:meta")) };
    };
    {
        const { w, ps, meta } = base();
        const key = `civ:plan:${meta.fam}:1`;
        const text = w.props.get(key);
        const i = Math.floor(text.length / 2);
        w.props.set(key, text.slice(0, i) + (text[i] === "1" ? "2" : "1") + text.slice(i + 1));
        const r = ps.loadPlan();
        assert.equal(r.status, "corrupt");
        assert.match(r.reason, /checksum/);
    }
    {
        const { w, ps, meta } = base();
        w.props.delete(`civ:plan:${meta.fam}:0`);
        assert.equal(ps.loadPlan().status, "corrupt");
    }
    {
        const { w, ps, meta } = base();
        w.props.set(`civ:plan:${meta.fam}:1`, w.props.get(`civ:plan:${meta.fam}:1`).slice(0, -3));
        assert.equal(ps.loadPlan().status, "corrupt");
    }
    {
        const { w, ps } = base();
        w.props.set("civ:plan:meta", "{not json");
        assert.equal(ps.loadPlan().status, "corrupt");
        w.props.set("civ:plan:meta", JSON.stringify({ format: "other", version: 1, schema: 1, hash: "x", chunks: 1, bytes: 1, fam: "a", gen: 1 }));
        assert.equal(ps.loadPlan().status, "corrupt");
        w.props.set("civ:plan:meta", 12);
        assert.equal(ps.loadPlan().status, "corrupt");
    }
    {
        // checksum valid but payload not JSON
        const w = fakeWorld();
        const cs = store.createChunkedStore(w, { prefix: "civ:plan", format: "civ-plan", version: 1 });
        assert.equal(cs.saveText("this is not json").ok, true);
        assert.equal(store.createPlanStore(w).loadPlan().status, "corrupt");
    }
});

test("quarantine keeps a bounded copy of corrupt data, and a later save still works", () => {
    const w = fakeWorld();
    const ps = store.createPlanStore(w);
    ps.savePlan(makePlan(50000, 41));
    const meta = JSON.parse(w.props.get("civ:plan:meta"));
    w.props.delete(`civ:plan:${meta.fam}:1`);
    assert.equal(ps.loadPlan().status, "corrupt");
    assert.equal(w.props.has("civ:plan:quarantine"), false, "plain load must not write");
    assert.equal(ps.loadPlan({ quarantine: true }).status, "corrupt");
    const q = w.props.get("civ:plan:quarantine");
    assert.ok(typeof q === "string" && q.length <= 30000 && q.includes("civ-plan"));
    assert.ok(w.props.has(`civ:plan:${meta.fam}:0`), "corrupt data stays in place for inspection");
    const fresh = makePlan(9000, 42);
    assert.equal(ps.savePlan(fresh).ok, true);
    assert.deepEqual(ps.loadPlan().plan, fresh);
    assert.ok(w.props.get("civ:plan:quarantine").length <= 30000);
});

test("versions: newer never overwritten, older-than-min unsupported, newer envelope schema respected", () => {
    const w = fakeWorld();
    const v1 = store.createPlanStore(w);
    const v2 = store.createPlanStore(w, { version: 2 });
    const plan2 = makePlan(12000, 51, 2);
    assert.equal(v2.savePlan(plan2).ok, true);
    const before = JSON.stringify([...w.props.entries()]);
    const loaded = v1.loadPlan();
    assert.equal(loaded.status, "newer");
    assert.equal(loaded.plan, undefined);
    const attempt = v1.savePlan(makePlan(3000, 52));
    assert.equal(attempt.ok, false);
    assert.equal(attempt.status, "newer");
    assert.equal(JSON.stringify([...w.props.entries()]), before, "newer data must be byte-identical afterwards");
    assert.equal(w.writes, v2.loadPlan().meta.chunks + 1, "no writes beyond the v2 save");

    // plan object newer than the store
    assert.equal(store.createPlanStore(fakeWorld()).savePlan(makePlan(100, 1, 2)).status, "newer");

    // unsupported (too old)
    const w2 = fakeWorld();
    const old = store.createPlanStore(w2);
    old.savePlan(makePlan(1000, 1));
    const strict = store.createPlanStore(w2, { version: 3, minVersion: 2 });
    assert.equal(strict.loadPlan().status, "unsupported");

    // future envelope schema
    const w3 = fakeWorld();
    const p3 = store.createPlanStore(w3);
    p3.savePlan(makePlan(1000, 2));
    const m = JSON.parse(w3.props.get("civ:plan:meta"));
    m.schema = 99;
    w3.props.set("civ:plan:meta", JSON.stringify(m));
    assert.equal(p3.loadPlan().status, "newer");
    assert.equal(p3.savePlan(makePlan(500, 3)).status, "newer");
});

test("migration registry: v1 -> v2 placeholder, missing step is unsupported", () => {
    const w = fakeWorld();
    const v1 = store.createPlanStore(w);
    const original = makePlan(6000, 61);
    v1.savePlan(original);
    const calls = [];
    const v2 = store.createPlanStore(w, { version: 2, migrations: { 1: (p) => (calls.push(1), { ...p, upgraded: true }) } });
    const r = v2.loadPlan();
    assert.equal(r.status, "ok");
    assert.equal(r.migrated, true);
    assert.equal(r.fromVersion, 1);
    assert.equal(r.plan.version, 2);
    assert.equal(r.plan.upgraded, true);
    assert.equal(r.plan.tag, original.tag);
    assert.deepEqual(calls, [1]);
    // stored data is untouched by loading (migration is in memory until the caller saves)
    assert.equal(JSON.parse(w.props.get("civ:plan:meta")).version, 1);
    assert.equal(v2.savePlan(r.plan).ok, true);
    assert.equal(JSON.parse(w.props.get("civ:plan:meta")).version, 2);
    assert.equal(v2.loadPlan().migrated, false);

    const w2 = fakeWorld();
    store.createPlanStore(w2).savePlan(makePlan(500, 1));
    assert.equal(store.createPlanStore(w2, { version: 2 }).loadPlan().status, "unsupported");
    const throwing = store.createPlanStore(w2, { version: 2, migrations: { 1: () => { throw new Error("boom"); } } });
    const t = throwing.loadPlan();
    assert.equal(t.status, "unsupported");
    assert.match(t.reason, /boom/);
});

test("clear removes data (meta first) but keeps quarantine", () => {
    const w = fakeWorld();
    const ps = store.createPlanStore(w);
    ps.savePlan(makePlan(40000, 71));
    w.props.set("civ:plan:quarantine", "{}");
    ps.clear();
    assert.deepEqual([...w.props.keys()], ["civ:plan:quarantine"]);
    assert.equal(ps.loadPlan().status, "absent");
});

// ------------------------------------------------------------------------ job queue

function standardSpecs(seed = 7) {
    const r = rng(seed);
    const counts = { clear: 10, walls: 60, gates: 16, roads: 120, lots: 300, dressing: 60 };
    const specs = {};
    for (const [stage, n] of Object.entries(counts)) {
        specs[stage] = Array.from({ length: n }, (_, i) => ({ total: 1 + Math.floor(r() * 900), inputs: { stage, i, k: Math.floor(r() * 1e6) } }));
    }
    return specs;
}

test("queue serialises compactly: ~600 elements well under 8 KB, exact round trip", () => {
    const q = jobs.createQueue(standardSpecs(), { planHash: "deadbeef" });
    assert.equal(q.total.length, 566);
    // worst-ish case: scattered states, cursors and attempts
    const r = rng(3);
    for (let i = 0; i < q.total.length; i += 1) {
        const x = r();
        if (x < 0.4) jobs.markProgress(q, i, q.total[i]);
        else if (x < 0.55) jobs.markProgress(q, i, Math.floor(q.total[i] / 2));
        else if (x < 0.6) jobs.markFailure(q, i);
        else if (x < 0.62) jobs.markSkipped(q, i);
    }
    const text = jobs.serializeQueue(q);
    console.log(`job queue: ${String(q.total.length)} elements -> ${String(text.length)} bytes (scattered states)`);
    assert.ok(text.length < 8192, `serialised queue is ${String(text.length)} bytes`);
    const back = jobs.parseQueue(text);
    assert.equal(back.ok, true);
    assert.deepEqual(back.queue, q);
    const fresh = jobs.serializeQueue(jobs.createQueue(standardSpecs()));
    console.log(`job queue fresh: ${String(fresh.length)} bytes`);
    // padded to ~600 elements by an extra stage sized 34
    const big = jobs.createQueue({ ...standardSpecs(), dressing: standardSpecs().dressing.concat(Array.from({ length: 34 }, (_, i) => ({ total: 5, inputs: i }))) });
    assert.ok(jobs.serializeQueue(big).length < 8192);
});

test("parseQueue rejects tampering", () => {
    const text = jobs.serializeQueue(jobs.createQueue(standardSpecs()));
    for (const mutate of [
        (o) => (o.h = o.h.slice(0, -1)),
        (o) => (o.s = "p5"),
        (o) => (o.f = "x"),
        (o) => (o.v = 9),
        (o) => (o.st = "weird"),
        (o) => (o.sg[0][1] += 1),
        (o) => (o.c = "zz:zz"),
    ]) {
        const o = JSON.parse(text);
        mutate(o);
        assert.equal(jobs.parseQueue(JSON.stringify(o)).ok, false);
    }
    assert.equal(jobs.parseQueue("nope").ok, false);
});

test("stage barriers: no lots before walls+gates are done; failed element blocks", () => {
    const q = jobs.createQueue({
        clear: [{ total: 10, inputs: 1 }],
        walls: [{ total: 30, inputs: 2 }, { total: 30, inputs: 3 }],
        gates: [{ total: 12, inputs: 4 }],
        roads: [{ total: 20, inputs: 5 }],
        lots: [{ total: 50, inputs: 6 }],
        dressing: [{ total: 5, inputs: 7 }],
    });
    const order = [];
    const stageDone = (name) => jobs.stageSatisfied(q, name);
    for (let guard = 0; guard < 100; guard += 1) {
        const w = jobs.nextWork(q, { maxOps: 15 });
        if (w.items.length === 0) break;
        for (const it of w.items) {
            if (it.stage === "lots") assert.ok(stageDone("walls") && stageDone("gates"), "lots issued before walls+gates");
            if (it.stage === "gates") assert.ok(stageDone("walls"));
            order.push(it.stage);
            jobs.markProgress(q, it.element, it.to);
        }
    }
    assert.equal(q.state, "complete");
    const firstIdx = (s) => order.indexOf(s);
    const lastIdx = (s) => order.lastIndexOf(s);
    const names = jobs.JOB_STAGES;
    for (let i = 1; i < names.length; i += 1) assert.ok(lastIdx(names[i - 1]) < firstIdx(names[i]), `${names[i - 1]} must finish before ${names[i]}`);

    // blocked by an unfinished wall (one wall reset), lots do not start
    jobs.resetElement(q, q.stages[1].start);
    jobs.resetElement(q, q.stages[4].start);
    const w = jobs.nextWork(q, { maxOps: 400 });
    assert.ok(w.items.every((it) => it.stage === "walls"));
    // failure blocks the barrier
    const q2 = jobs.createQueue({ walls: [{ total: 4, inputs: 1 }], lots: [{ total: 4, inputs: 2 }] }, { maxAttempts: 2 });
    jobs.nextWork(q2);
    jobs.markFailure(q2, 0);
    jobs.nextWork(q2);
    assert.equal(jobs.markFailure(q2, 0), "failed");
    const blocked = jobs.nextWork(q2);
    assert.equal(blocked.items.length, 0);
    assert.match(blocked.blocked, /failed/);
    jobs.markSkipped(q2, 0);
    assert.equal(jobs.nextWork(q2).items[0].stage, "lots");
});

test("nextWork slices never exceed the cap and cover each element exactly in order", () => {
    const q = jobs.createQueue(standardSpecs(9));
    const seen = new Map();
    let slices = 0;
    for (;;) {
        const w = jobs.nextWork(q);
        if (w.items.length === 0) break;
        slices += 1;
        assert.ok(w.ops <= budget.CIV_LIMITS.maxBlocksPerSlice);
        assert.equal(w.items.reduce((s, it) => s + it.ops, 0), w.ops);
        for (const it of w.items) {
            assert.equal(it.from, seen.get(it.element) ?? 0, "ranges must be contiguous");
            seen.set(it.element, it.to);
            jobs.markProgress(q, it.element, it.to);
        }
    }
    assert.equal(q.state, "complete");
    q.total.forEach((t, i) => assert.equal(seen.get(i), t));
    const totalOps = q.total.reduce((a, b) => a + b, 0);
    assert.ok(slices >= Math.ceil(totalOps / 400) && slices <= Math.ceil(totalOps / 400) + 6, `slices=${String(slices)} ops=${String(totalOps)}`);
    // caller cannot exceed the hard cap
    const q2 = jobs.createQueue({ clear: [{ total: 5000, inputs: 1 }] });
    assert.equal(jobs.nextWork(q2, { maxOps: 99999 }).ops, 400);
});

test("pause / resume / abort / reset / recover / reconcile", () => {
    const q = jobs.createQueue({ clear: [{ total: 100, inputs: 1 }, { total: 100, inputs: 2 }], walls: [{ total: 50, inputs: 3 }] });
    const w = jobs.nextWork(q, { maxOps: 150 });
    assert.deepEqual(w.items.map((i) => [i.element, i.from, i.to]), [[0, 0, 100], [1, 0, 50]]);
    assert.equal(q.status[1], "running");
    jobs.markProgress(q, 0, 100);
    jobs.markProgress(q, 1, 50);
    jobs.pause(q);
    assert.equal(jobs.nextWork(q).items.length, 0);
    assert.equal(jobs.nextWork(q).blocked, "paused");
    jobs.markProgress(q, 1, 60); // an in-flight slice may still land while paused
    assert.equal(q.cursor[1], 60);
    jobs.resume(q);
    assert.equal(jobs.nextWork(q).items[0].from, 60);
    assert.equal(jobs.recover(q), 1);
    assert.equal(q.status[1], "pending");
    assert.equal(q.cursor[1], 60);
    assert.equal(q.attempts[1], 1);
    // progress never moves backwards, never beyond total
    jobs.markProgress(q, 1, 10);
    assert.equal(q.cursor[1], 60);
    assert.throws(() => jobs.markProgress(q, 1, 101), RangeError);
    // reconcile keeps unchanged elements, resets changed ones
    const re = jobs.reconcile(q, { clear: [{ total: 100, inputs: 1 }, { total: 100, inputs: "CHANGED" }], walls: [{ total: 50, inputs: 3 }] });
    assert.equal(re.kept, 2);
    assert.equal(re.reset, 1);
    assert.equal(re.queue.status[0], "done");
    assert.equal(re.queue.cursor[1], 0);
    jobs.resetElement(q, 0);
    assert.equal(q.status[0], "pending");
    jobs.abort(q);
    assert.equal(jobs.nextWork(q).items.length, 0);
    assert.equal(jobs.resume(q), "aborted", "abort is terminal");
    const done = jobs.createQueue({ clear: [{ total: 0, inputs: 1 }] });
    assert.equal(done.state, "complete");
});

test("poison element: crashes during one element eventually mark it failed instead of looping forever", () => {
    const q = jobs.createQueue({ clear: [{ total: 10, inputs: 1 }] }, { maxAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
        jobs.nextWork(q);
        jobs.recover(q);
    }
    assert.equal(q.status[0], "failed");
});

test("progress report: percent by stage and ETA in slices", () => {
    const q = jobs.createQueue({ clear: [{ total: 800, inputs: 1 }], walls: [{ total: 1600, inputs: 2 }] });
    let p = jobs.progress(q);
    assert.equal(p.pct, 0);
    assert.equal(p.etaSlices, 6);
    jobs.markProgress(q, 0, 800);
    jobs.markProgress(q, 1, 400);
    p = jobs.progress(q);
    assert.equal(p.byStage[0].pct, 100);
    assert.equal(p.byStage[1].pct, 25);
    assert.equal(p.pct, 50);
    assert.equal(p.remainingOps, 1200);
    assert.equal(p.etaSlices, 3);
    assert.equal(p.byStage[2].pct, 100); // empty stage
});

test("job store: atomic persistence under the same crash protocol", () => {
    const w = fakeWorld();
    const js = store.createChunkedStore(w, { prefix: "civ:jobs", format: "civ-jobs", version: 1 });
    assert.ok(js);
    const jstore = jobs.createJobStore(w);
    assert.equal(jstore.loadQueue().status, "absent");
    const q = jobs.createQueue(standardSpecs(), { planHash: "abc" });
    assert.equal(jstore.saveQueue(q).ok, true);
    jobs.markProgress(q, 0, q.total[0]);
    let completed = false;
    let sawOld = 0;
    let sawNew = 0;
    for (let n = 0; n < 40 && !completed; n += 1) {
        const w2 = fakeWorld();
        const s = jobs.createJobStore(w2);
        const oldQ = jobs.createQueue(standardSpecs(), { planHash: "abc" });
        s.saveQueue(oldQ);
        w2.arm(n);
        try {
            s.saveQueue(q);
        } catch (_e) {
            /* ignore */
        }
        const crashed = w2.dead;
        w2.restart();
        const r = jobs.createJobStore(w2).loadQueue();
        assert.equal(r.status, "ok", `n=${String(n)}`);
        const text = jobs.serializeQueue(r.queue);
        if (text === jobs.serializeQueue(oldQ)) sawOld += 1;
        else if (text === jobs.serializeQueue(q)) sawNew += 1;
        else assert.fail("mixed queue");
        if (!crashed) completed = true;
    }
    assert.ok(completed && sawOld > 0 && sawNew > 0);
    for (const key of w.props.keys()) assert.ok(key.startsWith("civ:jobs:"));
    // size budget
    const tiny = jobs.createJobStore(fakeWorld(), { maxBytes: 100 });
    assert.equal(tiny.saveQueue(q).status, "too_large");
});

test("restart recovery at random points: same final state, every op at least once, none skipped, barriers kept", () => {
    const names = jobs.JOB_STAGES;
    const baselineSpecs = standardSpecs(5);

    function barrierViolation(applied, specs, stage) {
        const idx = names.indexOf(stage);
        for (let s = 0; s < idx; s += 1) {
            for (const arr of applied.get(names[s])) if (arr.some((c) => c === 0)) return names[s];
        }
        return null;
    }

    function runOnce(seed, crashy) {
        const r = rng(seed);
        const world = fakeWorld();
        const js = jobs.createJobStore(world);
        const applied = new Map(names.map((n) => [n, baselineSpecs[n].map((e) => new Uint8Array(e.total))]));
        let restarts = 0;
        let queue = null;
        let slicesSinceSave = 0;
        const maybeCrash = (p) => {
            if (crashy && r() < p) throw new Crash("boom");
        };
        const boot = () => {
            world.restart();
            const loaded = js.loadQueue();
            if (loaded.status === "absent") {
                queue = jobs.createQueue(baselineSpecs, { planHash: "p", maxAttempts: 100000 });
            } else {
                assert.equal(loaded.status, "ok", loaded.reason);
                queue = loaded.queue;
                queue.maxAttempts = 100000;
                // never-skip invariant: everything the persisted cursor claims is really applied
                for (const stage of queue.stages) {
                    for (let k = 0; k < stage.count; k += 1) {
                        const i = stage.start + k;
                        const claimed = queue.status[i] === "done" ? queue.total[i] : queue.cursor[i];
                        const arr = applied.get(stage.name)[k];
                        for (let o = 0; o < claimed; o += 1) assert.ok(arr[o] > 0, `cursor claims op ${String(o)} of ${stage.name}[${String(k)}] but it never ran`);
                    }
                }
            }
            slicesSinceSave = 0;
        };
        boot();
        for (let guard = 0; guard < 100000; guard += 1) {
            try {
                const w = jobs.nextWork(queue, { maxOps: 400 });
                if (w.items.length === 0) {
                    assert.equal(queue.state, "complete", `stuck: ${String(w.blocked)}`);
                    // persist the final state, then finish
                    if (!js.saveQueue(queue).ok) throw new Crash("final save lost");
                    break;
                }
                for (const it of w.items) {
                    const bad = barrierViolation(applied, baselineSpecs, it.stage);
                    assert.equal(bad, null, `${it.stage} ran while ${String(bad)} incomplete`);
                    const arr = applied.get(it.stage)[it.index];
                    const stopAt = crashy && r() < 0.01 ? it.from + Math.floor(r() * (it.to - it.from)) : it.to;
                    for (let o = it.from; o < stopAt; o += 1) arr[o] += 1;
                    if (stopAt < it.to) throw new Crash("mid-slice");
                    jobs.markProgress(queue, it.element, it.to);
                }
                maybeCrash(0.01); // applied + marked in memory, not persisted
                slicesSinceSave += 1;
                if (slicesSinceSave >= 1 + Math.floor(r() * 5)) {
                    if (crashy && r() < 0.1) world.arm(Math.floor(r() * 4));
                    js.saveQueue(queue);
                    slicesSinceSave = 0;
                    if (world.dead) throw new Crash("mid-save");
                }
            } catch (error) {
                if (!(error instanceof Crash)) throw error;
                restarts += 1;
                boot();
            }
        }
        return { queue, applied, restarts };
    }

    const base = runOnce(1, false);
    assert.equal(base.restarts, 0);
    let totalRestarts = 0;
    let reexecuted = 0;
    for (let seed = 100; seed < 112; seed += 1) {
        const run = runOnce(seed, true);
        totalRestarts += run.restarts;
        assert.ok(run.restarts > 0, `seed ${String(seed)} never crashed (test would prove nothing)`);
        // same final done-set
        assert.deepEqual(run.queue.status, base.queue.status);
        assert.deepEqual(run.queue.cursor.map((c, i) => (run.queue.status[i] === "done" ? run.queue.total[i] : c)), base.queue.total);
        // every op ran at least once; replays are allowed
        for (const stage of names) {
            for (const arr of run.applied.get(stage)) {
                for (const c of arr) {
                    assert.ok(c >= 1, "an operation was skipped");
                    if (c > 1) reexecuted += 1;
                }
            }
        }
    }
    console.log(`restart recovery: 12 seeded runs, ${String(totalRestarts)} simulated restarts, ${String(reexecuted)} replayed ops (idempotent), 0 skipped`);
    assert.ok(reexecuted > 0, "crashes must actually cause replay for the test to be meaningful");
});

test("recovery self-test can fail: a queue that marks progress BEFORE executing would skip ops", () => {
    // Model the buggy ordering and show the invariant detects it, proving the check has teeth.
    const q = jobs.createQueue({ clear: [{ total: 100, inputs: 1 }] });
    const w = jobs.nextWork(q);
    jobs.markProgress(q, 0, w.items[0].to); // persisted "done"...
    const applied = new Uint8Array(100); // ...but nothing executed before the crash
    const claimed = q.status[0] === "done" ? q.total[0] : q.cursor[0];
    let skipped = 0;
    for (let o = 0; o < claimed; o += 1) if (applied[o] === 0) skipped += 1;
    assert.equal(skipped, 100);
});

// ------------------------------------------------------------------------ budgets

test("CIV_LIMITS are frozen and match the contract", () => {
    const L = budget.CIV_LIMITS;
    assert.ok(Object.isFrozen(L));
    assert.equal(L.maxSearchRadius, 220);
    assert.equal(L.maxBlocksPerSlice, 400);
    assert.equal(L.maxReadsPerSlice, 1500);
    assert.equal(L.maxPlanBytes, 120000);
    assert.ok(L.maxPropertyChars <= 30000);
    assert.ok(L.maxJobBytes >= 8192);
});

test("Budget tracks ops/reads per slice, refuses overspend, yields when full", () => {
    const b = new budget.Budget();
    assert.equal(b.canSpend(400), true);
    assert.equal(b.canSpend(401), false);
    b.spend(399);
    assert.equal(b.canSpend(2), false);
    assert.throws(() => b.spend(2), RangeError);
    assert.equal(b.yieldNow(), false);
    b.spend(1);
    assert.equal(b.yieldNow(), true);
    b.endSlice();
    assert.equal(b.ops, 0);
    assert.equal(b.slices, 1);
    assert.equal(b.ticks, 1);
    b.spend(0, 1500);
    assert.equal(b.yieldNow(), true);
    assert.throws(() => b.spend(0, 1), RangeError);
    b.endSlice();
    b.spend(300, 700); // 0.75 + 0.47 > 1.5 * ... mixed load
    assert.equal(b.yieldNow(), false);
    b.spend(50, 400);
    assert.equal(b.yieldNow(), true);
    // configuration may only lower caps
    const big = new budget.Budget({ maxOps: 99999, maxReads: 99999 });
    assert.equal(big.maxOps, 400);
    assert.equal(big.maxReads, 1500);
    assert.equal(new budget.Budget({ maxOps: 50 }).maxOps, 50);
    const two = new budget.Budget({ slicesPerTick: 2 });
    two.endSlice();
    assert.equal(two.ticks, 0);
    two.endSlice();
    assert.equal(two.ticks, 1);
});

test("chunkOps / chunkRange never exceed caps (fuzz) and preserve every item in order", () => {
    const r = rng(77);
    for (let round = 0; round < 50; round += 1) {
        const items = Array.from({ length: 200 }, (_, i) => ({ i, ops: 1 + Math.floor(r() * 120), reads: Math.floor(r() * 500) }));
        const slices = budget.chunkOps(items, { opsOf: (x) => x.ops, readsOf: (x) => x.reads });
        assert.deepEqual(slices.flat().map((x) => x.i), items.map((x) => x.i));
        for (const s of slices) {
            assert.ok(s.reduce((a, x) => a + x.ops, 0) <= 400);
            assert.ok(s.reduce((a, x) => a + x.reads, 0) <= 1500);
            assert.ok(s.length > 0);
        }
    }
    assert.throws(() => budget.chunkOps([1], { opsOf: () => 401 }), RangeError);
    assert.equal(budget.chunkOps([], {}).length, 0);
    const ranges = budget.chunkRange(1234);
    assert.deepEqual(ranges, [[0, 400], [400, 800], [800, 1200], [1200, 1234]]);
    assert.equal(budget.chunkRange(0).length, 0);
    assert.deepEqual(budget.chunkRange(10, 99999), [[0, 10]]);
});

test("cost estimate for the ~190k-column civilization", () => {
    const e = budget.estimateCost();
    console.log("COST ESTIMATE (190k columns, 5 districts)");
    for (const [stage, c] of Object.entries(e.stages)) console.log(`  ${stage.padEnd(9)} blocks ${String(c.blocks).padStart(8)}  reads ${String(c.reads).padStart(8)}  slices ${String(c.slices).padStart(6)}`);
    console.log(`  TOTAL blocks ${String(e.totalBlocks)}, reads ${String(e.totalReads)}, slices @400 blocks/1500 reads ${String(e.totalSlices)} (block-bound ${String(e.blockSlices)}, read-bound ${String(e.readSlices)})`);
    console.log(`  1 slice/tick: ${String(e.ticks)} ticks = ${e.minutes.toFixed(1)} min; memory field ${String(e.memory.fieldBytes)} B, plan ${String(e.memory.planBytes)} B, jobs ${String(e.memory.jobBytes)} B`);
    assert.deepEqual(e.warnings, []);
    assert.equal(e.totalSlices, Object.values(e.stages).reduce((a, s) => a + s.slices, 0));
    for (const c of Object.values(e.stages)) assert.ok(c.slices * 400 >= c.blocks && c.slices * 1500 >= c.reads);
    assert.ok(e.totalBlocks > 200000 && e.totalBlocks < 1500000, `blocks ${String(e.totalBlocks)}`);
    assert.ok(e.memory.fieldBytes <= budget.CIV_LIMITS.maxFieldBytes);
    assert.equal(e.ticks, e.totalSlices);
    // monotone: more area, more work; more slices per tick, fewer ticks
    assert.ok(budget.estimateCost({ area: 380000 }).totalSlices > e.totalSlices);
    assert.ok(budget.estimateCost({}, { slicesPerTick: 4 }).ticks < e.ticks);
    // smaller slices than the cap are honoured; larger are clamped
    assert.ok(budget.estimateCost({}, { maxBlocksPerSlice: 100 }).totalSlices > e.totalSlices);
    assert.equal(budget.estimateCost({}, { maxBlocksPerSlice: 9999 }).totalSlices, e.totalSlices);
    // warnings fire on violations
    assert.ok(budget.estimateCost({ searchRadius: 400 }).warnings.length >= 2);
    assert.ok(budget.estimateCost({ planBytes: 500000 }).warnings.some((w) => /plan/.test(w)));
    // the real queue for this civilization is far smaller than the elements-times-slice figure
    const q = jobs.createQueue(standardSpecs());
    assert.ok(jobs.serializeQueue(q).length < e.memory.jobBytes + 4000);
});
