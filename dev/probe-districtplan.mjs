import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { makeField } = await import(pathToFileURL(join(projectRoot, "dev", "lib", "fakefield.mjs")).href);
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");

const seed = 21;
const field = makeField(seed, { relief: 18, hills: 60 });
const t0 = Date.now();
const planned = M.planCivilizationDetailed(field, { seed });
console.log(`masterplan: ok=${String(planned.ok)} attempts=${String(planned.attempts)} ms=${String(Date.now() - t0)}`);
if (!planned.ok) {
    console.log("plan errors:", planned.errors.slice(-5));
    process.exit(1);
}

const t1 = Date.now();
const site = D.planDistrictSite(planned.plan, 1, field, { seed });
console.log(`districtplan: ok=${String(site.ok)} ms=${String(Date.now() - t1)}`);
console.log("problems:", site.problems.slice(0, 8));
console.log("notes:", site.notes.length, JSON.stringify(site.notes, null, 1));
if (site.record) {
    const kinds = {};
    for (const element of site.record.lots) {
        if (String(element.id).startsWith("building-")) {
            kinds[element.kind] = (kinds[element.kind] ?? 0) + 1;
        }
    }
    console.log("building kinds:", JSON.stringify(kinds));
}
if (site.record) {
    console.log("stats:", JSON.stringify(site.record.stats, null, 1));
    console.log("bytes:", String(site.record.recordBytes), "checksum:", String(site.record.checksum));
    let seen = 0;
    let slices = 0;
    let maxSlice = 0;
    for (const slice of D.siteOpSlices(site.record)) {
        slices += 1;
        seen += slice.ops.length;
        maxSlice = Math.max(maxSlice, slice.ops.length);
    }
    console.log("streamed ops:", String(seen), "slices:", String(slices), "maxSlice:", String(maxSlice), "siteOpCount:", String(D.siteOpCount(site.record)));
    console.log("containment:", D.siteContainmentProblems(planned.plan, 1, site.record).slice(0, 5));
    console.log("sample wall element:", JSON.stringify(site.record.walls[0], null, 1));
    console.log("sample gate element:", JSON.stringify(site.record.gates[0], null, 1));
    console.log("sample lot element:", JSON.stringify(site.record.lots.find((e) => String(e.id).startsWith("building-")), null, 1));
}
