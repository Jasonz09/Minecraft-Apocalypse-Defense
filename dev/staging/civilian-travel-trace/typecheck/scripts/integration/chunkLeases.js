import { system, world } from "@minecraft/server";

/**
 * Short-lived, bounded chunk leases. Callers own separate identifier prefixes,
 * so gatehouses and fragmented construction holds cannot clean up each other.
 * No blocks or kingdom records are written here.
 */
let sequence = 0;

/**
 * @param {() => import("@minecraft/server").TickingAreaManager | undefined} managerFor
 * @param {() => number} tick
 * @param {{ maxGroups?: number, maxChunks?: number, timeoutTicks?: number, maxUnits?: number, padding?: number, prefix?: string }} [options]
 */
export function createChunkLoader(managerFor = () => world.tickingAreaManager, tick = () => system.currentTick, options = {}) {
    const maxGroups = options.maxGroups ?? 2;
    const maxChunks = options.maxChunks ?? 32;
    const timeout = options.timeoutTicks ?? 1200;
    const prefix = options.prefix ?? "civ-gate-load-";
    const padding = options.padding ?? 2;
    const maxUnits = options.maxUnits ?? 4;
    let groups = 0;
    let chunks = 0;

    /** Remove only this caller's abandoned leases after a world reload. */
    function recover() {
        const manager = managerFor();
        if (!manager) return;
        for (const area of manager.getAllTickingAreas()) {
            if (area.identifier.startsWith(prefix) && /^\d+-\d+$/.test(area.identifier.slice(prefix.length))) manager.removeTickingArea(area.identifier);
        }
    }

    /**
     * @param {{ dimension: import("@minecraft/server").Dimension, cells: { x: number, y: number, z: number }[] }[]} units
     */
    function acquire(units) {
        const manager = managerFor();
        let released = false;
        let accounted = false;
        let failure = /** @type {string | undefined} */ (undefined);
        let started = tick();
        /** @type {{ id: string, ready: boolean, retired: boolean, key: string, size: number }[]} */
        let areas = [];
        let cost = 0;
        function release() {
            if (released) return;
            released = true;
            if (accounted) { groups -= 1; chunks -= cost; }
            for (const area of areas) {
                try { if (manager?.hasTickingArea(area.id)) manager.removeTickingArea(area.id); } catch (_error) { /* already gone */ }
            }
        }
        /** @returns {{ state: "ready" | "loading" | "failed", reason?: string }} */
        function status() {
            if (failure) return { state: "failed", reason: failure };
            if (released) return { state: "failed", reason: "chunk loading was cancelled" };
            if (!manager) return { state: "ready" }; // Older test adapters use only already-loaded blocks.
            try {
                if (areas.every((area) => area.ready || manager.getTickingArea(area.id)?.isFullyLoaded === true)) return { state: "ready" };
            } catch (error) { failure = `cannot inspect chunk loading: ${String(error)}`; }
            if (!failure && tick() - started >= timeout) failure = "chunks did not load before the deadline";
            if (failure) { release(); return { state: "failed", reason: failure }; }
            return { state: "loading" };
        }
        /** @param {typeof units} nextUnits */
        function requestsFor(nextUnits) {
            const serial = ++sequence;
            if (nextUnits.length === 0 || nextUnits.length > maxUnits || nextUnits.some((unit) => unit.cells.length === 0 || unit.cells.some((cell) => ![cell.x, cell.y, cell.z].every(Number.isFinite)))) {
                throw new Error("invalid chunk loading geometry");
            }
            const requests = nextUnits.map((unit, index) => {
                const xs = unit.cells.map((cell) => cell.x), zs = unit.cells.map((cell) => cell.z);
                const x0 = Math.floor((Math.min(...xs) - padding) / 16), x1 = Math.floor((Math.max(...xs) + padding) / 16);
                const z0 = Math.floor((Math.min(...zs) - padding) / 16), z1 = Math.floor((Math.max(...zs) + padding) / 16);
                const size = (x1 - x0 + 1) * (z1 - z0 + 1);
                return { id: `${prefix}${serial}-${index}`, key:`${unit.dimension.id}:${x0},${z0},${x1},${z1}`, size,
                    options: { dimension: unit.dimension, from: { x: x0 * 16, y: 64, z: z0 * 16 }, to: { x: x1 * 16 + 15, y: 64, z: z1 * 16 + 15 } } };
            });
            if (new Set(requests.map(request=>request.key)).size!==requests.length) throw new Error("duplicate chunk loading geometry");
            return requests;
        }
        /** @param {ReturnType<typeof requestsFor>[number]} request */
        function create(request) {
            if (!manager) return;
            const area = { id: request.id, key:request.key, size:request.size, ready: false, retired:false };
            areas.push(area);
            Promise.resolve(manager.createTickingArea(area.id, request.options)).then(() => {
                if (released || area.retired) {
                    // Unique ids keep a retired request's late completion from
                    // deleting a newer window that overlaps its coordinates.
                    try { if (manager.hasTickingArea(area.id)) manager.removeTickingArea(area.id); } catch (_error) { /* gone */ }
                } else area.ready = true;
            }, (error) => {
                if (!released && !area.retired) { failure = `chunk loading failed: ${String(error)}`; release(); }
            });
        }
        /** Move this lease while retaining its already-loaded overlapping areas.
         * Outgoing areas are released before incoming ones reserve capacity.
         * @param {typeof units} nextUnits */
        function retarget(nextUnits) {
            if (released || failure || !manager) return status();
            try {
                const requests=requestsFor(nextUnits),nextCost=requests.reduce((sum,request)=>sum+request.size,0);
                if (chunks-cost+nextCost>maxChunks) throw new Error("chunk loading budget is busy; waiting for another operation");
                const keys=new Set(requests.map(request=>request.key));
                for (const area of areas) if (!keys.has(area.key)) {
                    area.retired=true;
                    if (manager.hasTickingArea(area.id)) manager.removeTickingArea(area.id);
                }
                areas=areas.filter(area=>!area.retired);
                const kept=new Set(areas.map(area=>area.key)),incoming=requests.filter(request=>!kept.has(request.key));
                const added=incoming.reduce((sum,request)=>sum+request.size,0);
                chunks+=nextCost-cost;cost=nextCost;started=tick();
                if (manager.chunkCount+added>manager.maxChunkCount || incoming.some(request=>!manager.hasCapacity(request.options))) throw new Error("not enough ticking-area capacity for this operation");
                for (const request of incoming) create(request);
            } catch(error) {failure=String(error);release();}
            return status();
        }
        if (!manager) return { status, release, retarget };
        try {
            const requests = requestsFor(units);
            cost=requests.reduce((sum,request)=>sum+request.size,0);
            if (groups >= maxGroups || chunks + cost > maxChunks) throw new Error("chunk loading budget is busy; waiting for another operation");
            if (manager.chunkCount + cost > manager.maxChunkCount || requests.some((request) => !manager.hasCapacity(request.options))) throw new Error("not enough ticking-area capacity for this operation");
            groups += 1; chunks += cost; accounted = true;
            for (const request of requests) create(request);
        } catch (error) { failure = String(error); release(); }
        return { status, release, retarget };
    }
    return { acquire, recover };
}
