import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { makeField } = await import(pathToFileURL(join(projectRoot, "dev", "lib", "fakefield.mjs")).href);

const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");
const W = await load("civ", "walls.js");

const seed = 21;
const field = makeField(seed, { relief: 18, hills: 60 });
const PLAN = M.planCivilizationDetailed(field, { seed }).plan;
const RECORD = D.planDistrictSite(PLAN, 1, field, { seed }).record;

const key = (x, z) => `${x},${z}`;
const labels = (() => {
    const w = PLAN.grid.w;
    const h = PLAN.grid.h;
    const out = new Array(w * h).fill(0);
    let cursor = 0;
    for (const [label, run] of PLAN.labels) {
        for (let i = 0; i < run && cursor < out.length; i += 1) out[cursor++] = label;
    }
    return out;
})();
const labelAt = (x, z) => {
    const gx = Math.floor((x - PLAN.grid.x0) / PLAN.cell);
    const gz = Math.floor((z - PLAN.grid.z0) / PLAN.cell);
    if (gx < 0 || gz < 0 || gx >= PLAN.grid.w || gz >= PLAN.grid.h) return 0;
    return labels[gz * PLAN.grid.w + gx];
};

const wallCells = new Set();
for (let i = 0; i < RECORD.walls.length; i += 1) {
    for (const op of D.siteOpsFor(RECORD, "walls", i)) wallCells.add(key(op.x, op.z));
}
const sealed = new Set(wallCells);
for (const gate of RECORD.gates) {
    const box = W.gateFootprintBox({ at: gate.at, axis: gate.axis });
    for (let x = box.x0 - 3; x <= box.x1 + 3; x += 1) for (let z = box.z0 - 3; z <= box.z1 + 3; z += 1) sealed.add(key(x, z));
}

const district = PLAN.districts.find((d) => d.index === 1);
const window = { x0: district.bbox.x0 - 60, z0: district.bbox.z0 - 60, x1: district.bbox.x1 + 60, z1: district.bbox.z1 + 60 };
const seen = new Set([key(district.centroid.x, district.centroid.z)]);
const queue = [[district.centroid.x, district.centroid.z]];
let escaped = null;
while (queue.length > 0) {
    const [x, z] = queue.shift();
    if (x <= window.x0 || x >= window.x1 || z <= window.z0 || z >= window.z1) { escaped = { x, z }; break; }
    for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        const k = key(nx, nz);
        if (seen.has(k)) continue;
        seen.add(k);
        if (sealed.has(k)) continue;
        queue.push([nx, nz]);
    }
}

// Distance from each reached non-district-1 cell to the nearest wall column.
const foreign = [...seen].map((k) => k.split(",").map(Number)).filter(([x, z]) => labelAt(x, z) !== 1);
const wallPoints = [...wallCells].map((k) => k.split(",").map(Number));
function nearestWall(x, z) {
    let best = Infinity;
    for (const [wx, wz] of wallPoints) {
        const d = Math.abs(wx - x) + Math.abs(wz - z);
        if (d < best) best = d;
        if (best === 0) break;
    }
    return best;
}
const byLabel = {};
for (const [x, z] of foreign) {
    const l = labelAt(x, z);
    byLabel[l] = (byLabel[l] ?? 0) + 1;
}
const dists = foreign.slice(0, 400).map(([x, z]) => nearestWall(x, z));
console.log(JSON.stringify({
    escaped,
    reachedCells: seen.size,
    foreignCells: foreign.length,
    foreignByLabel: byLabel,
    nearestWallDistance: { min: Math.min(...dists), median: dists.sort((a, b) => a - b)[Math.floor(dists.length / 2)], max: Math.max(...dists) },
    sampleForeign: foreign.slice(0, 5).map(([x, z]) => ({ x, z, label: labelAt(x, z), wallDist: nearestWall(x, z) })),
}, null, 1));
