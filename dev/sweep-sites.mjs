// Sweep: master plans that validate -> Hearthgate site plan -> containment. Dev only, not shipped.
//
//   node dev/sweep-sites.mjs [seedsPerTerrain=22] [firstSeed=1]
//
// Five terrains (rough, hilly, flat, river, lakes) x N seeds (default 22 -> 110 seeds). Uses
// planCivilizationAsync (master plan + validator) and planDistrictSite + siteContainmentProblems, and reports
// the share of validated plans that give an ok, contained site, with the reasons of every failure.
// Exit code 1 when that share is below 95%.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (...parts) => import(pathToFileURL(join(root, ...parts)).href);
const { makeField } = await load("dev", "lib", "fakefield.mjs");
const M = await load("CivilizationApocalypse_BP", "scripts", "civ", "masterplan.js");
const D = await load("CivilizationApocalypse_BP", "scripts", "civ", "districtplan.js");

const perTerrain = Number(process.argv[2] ?? 22);
const first = Number(process.argv[3] ?? 1);
const terrains = {
    rough: (seed) => makeField(seed, { relief: 18, hills: 60 }),
    hilly: (seed) => makeField(seed, { relief: 10, hills: 40 }),
    flat: (seed) => makeField(seed, { relief: 2, hills: 60 }),
    river: (seed) => makeField(seed, { relief: 6, hills: 60, river: { z: ((seed * 37) % 120) - 60, width: 9, wiggle: 25 } }),
    lakes: (seed) => makeField(seed, { relief: 8, hills: 50, lakes: [{ x: ((seed * 53) % 100) - 50, z: ((seed * 29) % 100) - 50, r: 30 }, { x: 70 - ((seed * 17) % 140), z: 60 - ((seed * 11) % 120), r: 22 }] }),
};

let total = 0;
let validated = 0;
let good = 0;
const failures = [];
for (const [name, make] of Object.entries(terrains)) {
    let tv = 0;
    let tg = 0;
    for (let seed = first; seed < first + perTerrain; seed += 1) {
        total += 1;
        const field = make(seed);
        const planned = await M.planCivilizationAsync(field, { seed });
        if (!planned.ok) continue;
        tv += 1;
        validated += 1;
        let verdict = "";
        try {
            const site = D.planDistrictSite(planned.plan, 1, field, { seed });
            const contained = site.record === null ? ["no record"] : D.siteContainmentProblems(planned.plan, 1, site.record);
            verdict = site.ok && contained.length === 0 ? "" : [...site.problems, ...contained].slice(0, 2).join(" | ");
        } catch (error) {
            verdict = `threw ${String(error)}`;
        }
        if (verdict === "") {
            tg += 1;
            good += 1;
        } else {
            failures.push(`${name} seed ${String(seed)}: ${verdict}`);
        }
    }
    console.log(`${name.padEnd(6)} validated ${String(tv)}/${String(perTerrain)}, ok+contained ${String(tg)}/${String(tv)}`);
}
console.log(`TOTAL  validated ${String(validated)}/${String(total)}, ok+contained ${String(good)}/${String(validated)} (${validated === 0 ? 0 : ((good / validated) * 100).toFixed(1)}%)`);
for (const f of failures) console.log("  FAIL", f);
process.exit(validated > 0 && good / validated >= 0.95 ? 0 : 1);
