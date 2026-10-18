import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const { makeField } = await import(pathToFileURL(join(projectRoot, "dev", "lib", "fakefield.mjs")).href);

const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");

const SEED = 21;
const field = makeField(SEED, { relief: 18, hills: 60 });
const planned = M.planCivilizationDetailed(field, { seed: SEED });
const PLAN = planned.plan;
const site = D.planDistrictSite(PLAN, 1, field, { seed: SEED });
const RECORD = site.record;

const key = (x, z) => `${x},${z}`;
const wall = new Set();
for (let i = 0; i < RECORD.walls.length; i += 1) {
    for (const op of D.siteOpsFor(RECORD, "walls", i)) wall.add(key(op.x, op.z));
}
const gates = RECORD.gates.map((g) => ({ x: g.at.x, z: g.at.z, axis: g.axis, width: g.width }));
const inGate = (x, z) =>
    gates.some((g) => {
        const half = Math.max(2, Math.floor(g.width / 2));
        const x0 = g.axis === "x" ? g.x - half : g.x - 2;
        const x1 = g.axis === "x" ? g.x + half : g.x + 2;
        const z0 = g.axis === "z" ? g.z - half : g.z - 2;
        const z1 = g.axis === "z" ? g.z + half : g.z + 2;
        return x >= x0 && x <= x1 && z >= z0 && z <= z1;
    });

const district = PLAN.districts.find((d) => d.index === 1);
console.log("walls:", RECORD.walls.map((w) => `${w.id} closed=${String(w.closed)} between=${JSON.stringify(w.between)} length=${String(w.length)} cols=${String(w.columns)}`).join("\n       "));
console.log("gates:", JSON.stringify(gates));
console.log("centroid:", JSON.stringify(district.centroid), "bbox:", JSON.stringify(district.bbox));

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
        if (wall.has(k) && !inGate(nx, nz)) continue;
        queue.push([nx, nz]);
    }
}
console.log("escaped:", JSON.stringify(escaped));
if (escaped) {
    // Walk back: where did the path cross the perimeter? Look at the ring of wall cells nearby.
    const near = gates.map((g) => `${g.x},${g.z} d=${Math.round(Math.hypot(g.x - escaped.x, g.z - escaped.z))}`);
    console.log("distance from leak to each gate:", near.join("  "));
    // Print the wall/gate occupancy across a slice through the leak.
    const row = [];
    for (let d = -6; d <= 6; d += 1) {
        const x = escaped.x + d;
        const z = escaped.z;
        row.push(`${x}:${wall.has(key(x, z)) ? (inGate(x, z) ? "G" : "#") : "."}`);
    }
    console.log("leak row z=" + String(escaped.z) + ":", row.join(" "));
    const col = [];
    for (let d = -6; d <= 6; d += 1) {
        const x = escaped.x;
        const z = escaped.z + d;
        col.push(`${z}:${wall.has(key(x, z)) ? (inGate(x, z) ? "G" : "#") : "."}`);
    }
    console.log("leak col x=" + String(escaped.x) + ":", col.join(" "));
    // Is the leak point inside the district label?
    const labelAt = (x, z) => {
        const gx = Math.floor((x - PLAN.grid.x0) / PLAN.cell);
        const gz = Math.floor((z - PLAN.grid.z0) / PLAN.cell);
        if (gx < 0 || gz < 0 || gx >= PLAN.grid.w || gz >= PLAN.grid.h) return 0;
        let cursor = 0;
        const target = gz * PLAN.grid.w + gx;
        for (const [label, run] of PLAN.labels) {
            if (target < cursor + run) return label;
            cursor += run;
        }
        return 0;
    };
    console.log("label at leak:", String(labelAt(escaped.x, escaped.z)));
    // Which wall paths pass near the leak?
    for (const w of RECORD.walls) {
        let best = Infinity;
        for (let i = 0; i + 1 < (w.path?.length ?? 0); i += 1) {
            const [px, pz] = w.path[i];
            best = Math.min(best, Math.hypot(px - escaped.x, pz - escaped.z));
        }
        console.log(`wall ${w.id}: nearest centreline point is ${Math.round(best)} blocks from the leak`);
    }
}
