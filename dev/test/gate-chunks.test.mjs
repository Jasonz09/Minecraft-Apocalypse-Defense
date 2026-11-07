import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@minecraft/server") return {url: "data:text/javascript,export const world = {}; export const system = {};", shortCircuit: true};
    return nextResolve(specifier, context);
}`));
const { createChunkLoader } = await import("../../CivilizationApocalypse_BP/scripts/integration/chunkLeases.js");

function fixture(options = {}) {
    let tick = 100;
    const areas = new Map(), pending = [], removed = [];
    const manager = {
        maxChunkCount: 300, chunkCount: 0,
        hasCapacity: () => true,
        hasTickingArea: (id) => areas.has(id),
        getTickingArea: (id) => areas.get(id),
        getAllTickingAreas: () => [...areas.values()],
        removeTickingArea(id) { removed.push(id); areas.delete(id); },
        createTickingArea(id, request) {
            areas.set(id, { identifier: id, isFullyLoaded: false, request });
            return new Promise((resolve, reject) => pending.push({ id, request, resolve, reject }));
        },
    };
    const loader = createChunkLoader(() => manager, () => tick, options);
    const unit = (x, z) => ({ dimension: { id: "minecraft:overworld" }, cells: [{ x, y: 64, z }, { x: x + 4, y: 70, z: z + 4 }] });
    const pair = [unit(-92, -636), unit(-84, -468)];
    return { manager, loader, pair, unit, areas, pending, removed, advance: (n) => { tick += n; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("moving a bounded lease retains overlapping loaded chunks without another group or duplicate creation", async()=>{
    const f=fixture({padding:0,maxGroups:1,maxChunks:2,maxUnits:2});
    const a=f.unit(0,0),b=f.unit(16,0),c=f.unit(32,0);
    const lease=f.loader.acquire([a,b]);
    for(const pending of f.pending)pending.resolve();await flush();
    const retained=f.pending[1].id;
    assert.equal(lease.retarget([b,c]).state,'loading');
    assert.equal(f.pending.length,3,'only the incoming chunk is created');
    assert.equal(f.areas.size,2);assert.ok(f.areas.has(retained));
    assert.match(f.loader.acquire([a]).status().reason,/busy/,'retarget keeps the original group reservation');
    f.pending[2].resolve();await flush();assert.equal(lease.status().state,'ready');
    assert.equal(lease.retarget([b,c]).state,'ready');assert.equal(f.pending.length,3,'unchanged geometry is reused');
    lease.release();assert.equal(f.areas.size,0);
    const next=f.loader.acquire([a,b]);assert.equal(next.status().state,'loading');next.release();
});

test("retired moving-lease requests clean up late completions without touching their replacements", async()=>{
    const f=fixture({padding:0,maxGroups:1,maxChunks:2,maxUnits:2});
    const lease=f.loader.acquire([f.unit(0,0),f.unit(16,0)]),retired=f.pending[0];
    lease.retarget([f.unit(16,0),f.unit(32,0)]);
    const replacement=f.pending[2];
    f.areas.set(retired.id,{identifier:retired.id,isFullyLoaded:true});retired.resolve();await flush();
    assert.equal(f.areas.has(retired.id),false);assert.ok(f.areas.has(replacement.id));
    lease.release();
    f.areas.set(replacement.id,{identifier:replacement.id,isFullyLoaded:true});replacement.resolve();
    f.pending[1].reject(new Error('late cancelled creation'));await flush();assert.equal(f.areas.size,0);
});

test("failed lease movement returns its budget and preserves unrelated areas", ()=>{
    const f=fixture({padding:0,maxGroups:1,maxChunks:2,maxUnits:2});
    f.areas.set('unrelated',{identifier:'unrelated'});
    const lease=f.loader.acquire([f.unit(0,0),f.unit(16,0)]);
    f.manager.hasCapacity=()=>false;
    assert.match(lease.retarget([f.unit(16,0),f.unit(32,0)]).reason,/capacity/);
    assert.deepEqual([...f.areas.keys()],['unrelated']);
    f.manager.hasCapacity=()=>true;
    const next=f.loader.acquire([f.unit(0,0),f.unit(16,0)]);assert.equal(next.status().state,'loading');next.release();
    assert.deepEqual([...f.areas.keys()],['unrelated']);
});

test("construction lease recovery preserves gate leases and unrelated areas", () => {
    const f = fixture({ prefix: "civ-build-load-", padding: 0, maxUnits: 16, maxChunks: 16 });
    for (const id of ["civ-build-load-123-0", "civ-gate-load-123-0", "another-addon", "civ-build-load-player"]) f.areas.set(id, { identifier: id });
    f.loader.recover();
    assert.deepEqual([...f.areas.keys()], ["civ-gate-load-123-0", "another-addon", "civ-build-load-player"]);
});

test("distant companion gatehouses use separate small holds, retained until the whole move releases", async () => {
    const f = fixture();
    const lease = f.loader.acquire(f.pair);
    assert.equal(lease.status().state, "loading");
    assert.equal(f.pending.length, 2);
    for (const { request } of f.pending) {
        assert.ok(request.to.z - request.from.z < 64, "do not hold the 168-block corridor between gatehouses");
        assert.ok(request.to.x - request.from.x < 64);
    }
    f.pending[0].resolve(); await flush();
    assert.equal(lease.status().state, "loading", "both must finish loading before any gate closes");
    f.pending[1].resolve(); await flush();
    assert.equal(lease.status().state, "ready");
    assert.equal(f.areas.size, 2);
    lease.release(); lease.release();
    assert.equal(f.areas.size, 0);
    assert.equal(f.removed.length, 2, "release is idempotent");
});

test("a cancelled hold's late completion cannot remove the next gate's hold", async () => {
    const f = fixture();
    const old = f.loader.acquire(f.pair);
    old.release();
    const next = f.loader.acquire(f.pair);
    const newIds = f.pending.slice(2).map((entry) => entry.id);
    // Emulate an engine callback re-materializing an area after cancellation.
    for (const entry of f.pending.slice(0, 2)) { f.areas.set(entry.id, { identifier: entry.id, isFullyLoaded: true }); entry.resolve(); }
    await flush();
    assert.equal(old.status().state, "failed");
    assert.deepEqual([...f.areas.keys()].sort(), newIds.sort());
    next.release();
    for (const entry of f.pending.slice(2)) entry.reject(new Error("late cancelled creation"));
    await flush();
    assert.equal(f.areas.size, 0);
});

test("loading deadlines use actual ticks, release all areas, and reject missing capacity without creating anything", () => {
    const f = fixture({ timeoutTicks: 20 });
    const lease = f.loader.acquire(f.pair);
    for (let i = 0; i < 6500; i += 1) assert.equal(lease.status().state, "loading");
    f.advance(20);
    assert.match(lease.status().reason, /deadline/);
    assert.equal(f.areas.size, 0);
    f.manager.hasCapacity = () => false;
    assert.match(f.loader.acquire(f.pair).status().reason, /capacity/);
    assert.equal(f.pending.length, 2);
});

test("per-world gate loading has a shared budget, returns it on release, and rejects oversized geometry", () => {
    const f = fixture({ maxGroups: 1, maxChunks: 16 });
    const a = f.loader.acquire(f.pair);
    assert.match(f.loader.acquire(f.pair).status().reason, /busy/);
    a.release();
    const b = f.loader.acquire(f.pair);
    assert.equal(b.status().state, "loading");
    b.release();
    assert.match(f.loader.acquire([{ ...f.unit(0, 0), cells: [{ x: 0, y: 64, z: 0 }, { x: 10000, y: 64, z: 10000 }] }]).status().reason, /budget/);
    assert.equal(f.areas.size, 0);
});

test("reload cleanup removes only reserved gate lease ids; engine failure releases the entire group", async () => {
    const f = fixture();
    for (const id of ["civ-gate-load-123-0", "civ-generate", "another-addon", "civ-gate-load-player"]) f.areas.set(id, { identifier: id });
    f.loader.recover();
    assert.deepEqual([...f.areas.keys()], ["civ-generate", "another-addon", "civ-gate-load-player"]);
    const lease = f.loader.acquire(f.pair);
    f.pending[0].reject(new Error("engine rejected creation")); await flush();
    assert.match(lease.status().reason, /engine rejected/);
    assert.equal(f.areas.size, 3, "all our group holds released; foreign areas preserved");
    f.pending[1].resolve(); await flush();
    assert.equal(f.areas.size, 3);
});
