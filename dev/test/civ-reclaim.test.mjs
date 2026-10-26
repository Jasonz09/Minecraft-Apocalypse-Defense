// Terrain-agnostic building: a rough or wet window is ADAPTED to (decks on pillars, piers over
// water) instead of being flattened or drained. The site policy that says so is a pure function of
// the ranked window and travels with the plan. Offline only (no Minecraft).
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);
const loadDev = (...parts) => import(pathToFileURL(join(projectRoot, "dev", ...parts)).href);

const SITE = await load("civ", "siteselect.js");
const F = await load("civ", "foundations.js");
const M = await load("civ", "masterplan.js");
const D = await load("civ", "districtplan.js");
const R = await load("civ", "regions.js");
const P = await load("civ", "siteprofile.js");
const { makeGridField } = await load("civ", "field.js");
const { makeField } = await loadDev("lib", "fakefield.mjs");

const T = { timeout: 600000 };

/** A field that answers everywhere inside `bounds` with the same cell. */
function flatField(cell, { x0 = -450, z0 = -450, size = 900 } = {}) {
    const bounds = { x0, z0, x1: x0 + size - 1, z1: z0 + size - 1 };
    return {
        seed: 1,
        bounds,
        at(x, z) {
            if (x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1) return { g: 0, k: "unloaded", tree: false };
            return { ...cell };
        },
    };
}

/** Deep sea: the bed is at y=30, the water surface at y=62. */
const OCEAN = flatField({ g: 30, k: "water", tree: false, surface: 62 });
/** A cliff wall: 12 blocks of rise over 3 blocks (relief 12 per analysis cell), dry land. */
const CLIFF = (() => {
    const base = flatField({ g: 70, k: "land", tree: false });
    return {
        seed: 2,
        bounds: base.bounds,
        at(x, z) {
            const cell = base.at(x, z);
            if (cell.k !== "land") return cell;
            return { g: 70 + x * 4, k: "land", tree: false };
        },
    };
})();

/** A rankSites field (lattice step 8) filled with `cell(x, z)`. */
function latticeField(cell, radius = 620) {
    const field = makeGridField({ x0: -radius, z0: -radius, w: radius * 2 + 16, h: radius * 2 + 16, step: 8 });
    for (let x = -radius; x <= radius; x += 8) for (let z = -radius; z <= radius; z += 8) field.set(x, z, cell(x, z));
    return field;
}

// ------------------------------------------------------------------------------ the policy

test("the terrain policy is derived from the window, and a normal land window keeps the old numbers", () => {
    assert.deepEqual(SITE.siteTerrainPolicy({ waterFraction: 0, steepFraction: 0, flatness: 1 }), { allowWater: false, adaptive: false, maxRelief: 8 });
    // Any open water in the window means roads may bridge / pier over it and lots may stand on decks.
    assert.equal(SITE.siteTerrainPolicy({ waterFraction: 0.01, steepFraction: 0, flatness: 1 }).allowWater, true);
    assert.equal(SITE.siteTerrainPolicy({ waterFraction: 0.01, steepFraction: 0, flatness: 1 }).adaptive, true);
    const rough = SITE.siteTerrainPolicy({ waterFraction: 0, steepFraction: 0.05, flatness: 1 });
    assert.equal(rough.maxRelief, 16);
    assert.equal(rough.adaptive, true);
    assert.equal(rough.allowWater, false);
    assert.equal(SITE.siteTerrainPolicy(null).allowWater, false);
});

// ------------------------------------------------------------------------------ site selection

test("an all-ocean window is a suitable site: water is a preparation price, not a veto", () => {
    const field = latticeField(() => ({ g: 30, k: "water", tree: false, surface: 62 }));
    const ranked = SITE.rankSites(field, { x: 0, z: 0 }, { searchRadius: 48 });
    assert.notEqual(ranked.site, null, JSON.stringify(ranked.reasons));
    assert.equal(ranked.site.waterFraction, 1);
    assert.equal(ranked.site.usableFraction, 1);
    assert.ok(ranked.site.prep.water > 0, "a pier lot costs a deck block per column");
    assert.ok(ranked.site.prep.total >= ranked.site.prep.water);
    assert.equal(SITE.siteTerrainPolicy(ranked.site).allowWater, true);
});

test("a mountainside is a suitable site, and tall ground costs more than flat ground", () => {
    const steep = latticeField((x) => ({ g: 70 + Math.round(x * 1.0), k: "land", tree: false }));
    const ranked = SITE.rankSites(steep, { x: 0, z: 0 }, { searchRadius: 48 });
    assert.notEqual(ranked.site, null, JSON.stringify(ranked.reasons));
    assert.ok(ranked.site.steepFraction > 0.5, `steep ${ranked.site.steepFraction}`);
    assert.ok(ranked.site.prep.terrace > 0);
    assert.equal(SITE.siteTerrainPolicy(ranked.site).maxRelief, 16);
});

test("lava is still a hard refusal (nothing is built on it)", () => {
    const field = latticeField((x, z) => ({ g: 62, k: (x + z) % 16 === 0 ? "land" : "lava", tree: false }));
    const ranked = SITE.rankSites(field, { x: 0, z: 0 }, { searchRadius: 48 });
    assert.equal(ranked.site, null);
    assert.ok(ranked.reasons.some((line) => /lava/.test(line)), ranked.reasons.join(" | "));
});

// ------------------------------------------------------------------------------ decks on pillars

test("a deck over deep water stands on pillars down to the sea bed and fills nothing", () => {
    const profile = F.makeProfile(-1, -1, 4, 4, () => ({ g: 30, water: 62 }));
    const rect = { x0: 0, z0: 0, x1: 1, z1: 1 };
    const limits = { baseY: 62, maxCut: 8 };
    const plain = F.planDeck(profile, rect, limits);
    const steps = R.runSync(D.planDeckSteps(profile, rect, limits, R.newOps()));
    assert.equal(plain.ok, true, JSON.stringify(plain.problems));
    assert.deepEqual({ ...steps, ops: [], touched: null }, { ...plain, ops: [], touched: null });
    assert.equal(plain.baseY, 62);
    assert.equal(plain.counts.fill, 0, "the sea is never filled");
    assert.equal(plain.ops.filter((op) => op.kind === "fill").length, 0);
    // the deck replaces the surface water blocks, one per inner column
    assert.equal(plain.ops.filter((op) => op.kind === "deck" && op.y === 62).length, 4);
    // pillars run from the bed to just under the deck (all four edge columns of a 2x2 deck)
    const pillars = plain.ops.filter((op) => op.kind === "pillar");
    assert.equal(pillars.length, 4 * 31, `pillar blocks ${pillars.length}`);
    assert.equal(Math.min(...pillars.map((op) => op.y)), 31, "the lowest pillar block stands on the sea bed");
    assert.equal(Math.max(...pillars.map((op) => op.y)), 61);
    // the apron is railed (a drop into the sea) and no op touches water above the deck
    assert.ok(plain.counts.rail > 0);
    assert.ok(plain.ops.every((op) => op.y <= 63));
});

test("a deck on a slope cuts only the uphill side, carries the downhill side on pillars, and fills nothing", () => {
    const profile = F.makeProfile(-1, -1, 6, 6, (x) => ({ g: 70 + x * 2 }));
    const rect = { x0: 0, z0: 0, x1: 3, z1: 3 };
    const deck = F.planDeck(profile, rect, { baseY: 72, maxCut: 8 });
    assert.equal(deck.ok, true, JSON.stringify(deck.problems));
    assert.equal(deck.counts.fill, 0);
    const cuts = deck.ops.filter((op) => op.kind === "cut");
    assert.ok(cuts.length > 0, "the uphill half is cut to the deck level");
    assert.ok(cuts.every((op) => op.y > 72 && op.y <= 72 + 8), "no cut goes deeper than the limit");
    const pillars = deck.ops.filter((op) => op.kind === "pillar");
    assert.ok(pillars.length > 0, "the downhill edge stands on pillars");
    assert.ok(pillars.every((op) => op.y > 70 && op.y < 72));
});

test("a deck refuses a cut deeper than its limit and a level below the water surface", () => {
    const slope = F.makeProfile(-1, -1, 6, 6, (x) => ({ g: 70 + x * 2 }));
    const deep = F.planDeck(slope, { x0: 0, z0: 0, x1: 3, z1: 3 }, { baseY: 70, maxCut: 2 });
    assert.equal(deep.ok, false);
    assert.match(deep.problems[0], /stands \d+ above the deck/);
    const sea = F.makeProfile(-1, -1, 4, 4, () => ({ g: 30, water: 62 }));
    const wet = F.planDeck(sea, { x0: 0, z0: 0, x1: 1, z1: 1 }, { baseY: 60 });
    assert.equal(wet.ok, false);
    assert.match(wet.problems[0], /under the water surface/);
});

test("the frozen ground keeps the water surface, so a pier rehydrates at the same level", () => {
    const field = flatField({ g: 30, k: "water", tree: false, surface: 62 });
    const region = { x0: -2, z0: -2, x1: 2, z1: 2 };
    const json = P.exportSiteGround(field, region);
    assert.equal(typeof json.s, "string", "water regions carry a surface stream");
    const back = P.importSiteGround(json);
    assert.deepEqual(back.at(0, 0), { g: 30, k: "water", tree: false, surface: 62 });
    assert.equal(back.sameAs(field), true);
    // a land-only region keeps the old streams (no `s` key), so its stored bytes do not change
    const land = flatField({ g: 70, k: "land", tree: false });
    assert.equal(P.exportSiteGround(land, region).s, undefined);
});

// ------------------------------------------------------------------------------ master plan

test("open ocean is settleable under the water policy and not without it", T, () => {
    const dry = M.planCivilizationDetailed(OCEAN, { seed: 3, policy: { allowWater: false, maxRelief: 8 } });
    assert.equal(dry.ok, false, "without allowWater no seed can be placed on the sea");
    const plan = M.planCivilizationDetailed(OCEAN, { seed: 3, policy: { allowWater: true, maxRelief: 8 } });
    assert.equal(plan.ok, true, plan.errors.slice(-4).join(" | "));
    assert.equal(plan.plan.districts.length, 5);
});

test("a cliff is passable only under the higher relief policy", () => {
    const ops = R.newOps();
    const flat = R.runSync(R.analyzeTerrainSteps(CLIFF, { x: 0, z: 0 }, 60, ops, { maxRelief: 8 }));
    const rough = R.runSync(R.analyzeTerrainSteps(CLIFF, { x: 0, z: 0 }, 60, R.newOps(), { maxRelief: 16 }));
    const count = (t) => t.passable.reduce((sum, v) => sum + v, 0);
    assert.equal(count(flat), 0, "relief 12 is impassable at the default 8");
    assert.ok(count(rough) > 0, "relief 12 is settleable (decks on pillars) at 16");
    // water stays impassable when the policy does not allow building over it
    const dry = R.runSync(R.analyzeTerrainSteps(OCEAN, { x: 0, z: 0 }, 60, R.newOps(), { maxRelief: 8 }));
    const wet = R.runSync(R.analyzeTerrainSteps(OCEAN, { x: 0, z: 0 }, 60, R.newOps(), { allowWater: true, maxRelief: 8 }));
    assert.equal(count(dry), 0);
    assert.ok(count(wet) > 0);
});

// ------------------------------------------------------------------------------ district on the sea

test("a district on the open sea stands on piers (deck + pillars) and rehydrates byte-identically", T, () => {
    const policy = { allowWater: true, adaptive: true, maxRelief: 8 };
    const made = M.planCivilizationDetailed(OCEAN, { seed: 5, policy });
    assert.equal(made.ok, true, made.errors.slice(-4).join(" | "));
    const plan = made.plan;
    const site = D.planDistrictSite(plan, 1, OCEAN, { seed: 5, policy });
    assert.equal(site.ok, true, site.problems.join(" | "));
    assert.ok(site.record.checksum);

    /** @type {Map<string, number>} */
    const kinds = new Map();
    let cappedAtSurface = 0;
    let deepestSupport = Infinity;
    for (const stage of D.SITE_STAGES) {
        const list = site.record[stage] ?? [];
        for (let i = 0; i < list.length; i += 1) {
            for (const op of D.siteOpsFor(site.record, stage, i)) {
                kinds.set(op.kind, (kinds.get(op.kind) ?? 0) + 1);
                if (op.kind === "fill" && op.y >= 62) cappedAtSurface += 1;
                if (op.kind === "support") deepestSupport = Math.min(deepestSupport, op.y);
            }
        }
    }
    // Pads record their foundation: on a sea site every one is a deck carried by pillars, with no fill.
    const pads = (site.record.lots ?? []).filter((el) => String(el.kind ?? "").startsWith("pad-"));
    assert.ok(pads.length > 0, "the sea district has lots");
    assert.ok(pads.some((el) => Number(el.padPillars ?? 0) > 0), "sea lots stand on pillars");
    assert.ok(pads.some((el) => Number(el.padDeck ?? 0) > 0), "sea lots are decks");
    assert.ok(pads.every((el) => Number(el.fill ?? 0) === 0), "no lot is built on fill");
    assert.ok((kinds.get("bridge") ?? 0) > 0, "streets over water are decks (canonical kind bridge)");
    assert.equal(cappedAtSurface, 0, "nothing is filled at or above the water surface (no capping / draining)");
    assert.ok(deepestSupport <= 40, `a pier reaches the sea bed (lowest support y=${String(deepestSupport)})`);

    const ground = D.exportSiteInputs(plan, 1, OCEAN);
    assert.equal(typeof ground.s, "string", "the stored ground keeps the water surface for the piers");
    const again = D.rehydrateSite(plan, 1, ground, { seed: 5, policy, expectChecksum: site.record.checksum });
    assert.equal(again.ok, true, again.problems.join(" | "));
    assert.equal(again.record.checksum, site.record.checksum);
});

test("a land plan's stored options are unchanged by the policy plumbing (no checksum break for old worlds)", T, () => {
    const field = makeField(21, { relief: 18, hills: 60 });
    const made = M.planCivilizationDetailed(field, { seed: 21 });
    assert.equal(made.ok, true);
    const plain = D.planDistrictSite(made.plan, 1, field, { seed: 21 });
    assert.equal(plain.ok, true, plain.problems.join(" | "));
    assert.equal(Object.prototype.hasOwnProperty.call(plain.record.options, "policy"), false);
    const withDefault = D.planDistrictSite(made.plan, 1, field, { seed: 21, policy: { allowWater: false, adaptive: false, maxRelief: 8 } });
    assert.equal(withDefault.record.checksum, plain.record.checksum);
    assert.equal(Object.prototype.hasOwnProperty.call(withDefault.record.options, "policy"), false);
});

test("a mountainside district plans with decks on pillars and stays inside its own land", T, () => {
    const base = flatField({ g: 70, k: "land", tree: false });
    const slope = {
        seed: 11,
        bounds: base.bounds,
        at(x, z) {
            const cell = base.at(x, z);
            if (cell.k !== "land") return cell;
            return { g: 70 + Math.round(x * 1.2), k: "land", tree: false };
        },
    };
    const policy = { allowWater: false, adaptive: true, maxRelief: 16 };
    const made = M.planCivilizationDetailed(slope, { seed: 11, policy });
    assert.equal(made.ok, true, made.errors.slice(-4).join(" | "));
    const site = D.planDistrictSite(made.plan, 1, slope, { seed: 11, policy });
    assert.equal(site.ok, true, site.problems.join(" | "));
    assert.deepEqual(D.siteContainmentProblems(made.plan, 1, site.record), []);
    assert.ok((site.record.lots ?? []).length > 0, "the district still has lots on the slope");
    const pads = (site.record.lots ?? []).filter((el) => String(el.kind ?? "").startsWith("pad-"));
    assert.ok(pads.some((el) => Number(el.padPillars ?? 0) > 0), "lots on the slope stand on pillars");
    assert.ok(pads.some((el) => Number(el.padDeck ?? 0) > 0), "lots on the slope are decks");
    const ground = D.exportSiteInputs(made.plan, 1, slope);
    const again = D.rehydrateSite(made.plan, 1, ground, { seed: 11, policy, expectChecksum: site.record.checksum });
    assert.equal(again.ok, true, again.problems.join(" | "));
    assert.equal(again.record.checksum, site.record.checksum);
});

test("a lake enclosed by land is refused with a reason; an open-sea window is not", () => {
    // A 120-block-radius lake in the middle of the window: ~20% water, none of it on the border.
    const lake = latticeField((x, z) => (x * x + z * z <= 120 * 120 ? { g: 62, k: "water", tree: false, surface: 63 } : { g: 70, k: "land", tree: false }));
    const ranked = SITE.rankSites(lake, { x: 0, z: 0 }, { searchRadius: 48 });
    assert.equal(ranked.site, null);
    assert.ok(ranked.reasons.some((line) => /enclosed water/.test(line)), ranked.reasons.join(" | "));
    // The same water, but reaching the window border, is open sea and stays a valid site.
    const sea = latticeField(() => ({ g: 30, k: "water", tree: false, surface: 62 }));
    assert.notEqual(SITE.rankSites(sea, { x: 0, z: 0 }, { searchRadius: 48 }).site, null);
});
