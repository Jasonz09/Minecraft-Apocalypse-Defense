# Qwen handoff — Phase C, enlarged Hearthgate construction planner

Written for Claude, who resumes this repo after a temporary takeover. Read before touching Phase C.

## 0. Provenance

- **Starting commit:** `a826afd` — "Civilization master planner, validator, terrain/site selection,
  lots/zoning, gates+walls, persistence/jobs (Phases A,B,D core); 500 tests".
- **Tree at start: clean.** `git status --porcelain` returned nothing, so the "untracked files left
  by interrupted subagents" mentioned in my brief **did not exist**. Nothing needed rescuing, and I
  did not delete or overwrite any work of yours.
- **My change is purely additive.** `git status` after my work lists 5 new files and *zero modified
  tracked files*. Your 500 tests, the master planner, validator, zoning, lots, walls, gates,
  foundations, jobs, planstore and the 49x49 prototype are byte-for-byte as you left them.
- **Commit hash of my work:** see `git log --oneline -1` at handoff time (message starts
  `Phase C: enlarged Hearthgate construction planner`).

## 1. What I was asked to do, and what I did

Complete the **pure** construction planner for the enlarged, irregular Hearthgate (district 1):
one seed-deterministic physical plan built on top of your five-district master plan. No deployment,
no world changes, no other districts, no simulation rewrite.

The pieces all existed but **nothing joined them**: `planWall`, `gatehouseBlocks`, `planRoadProfile`,
`planPad`, `planFoundationColumns`, `planStairs`, `planBridge`, `zoneDistrict`, `makeLots` and
`expandBlueprint` had **no production caller** anywhere in `scripts/`. The seam between them is what
I built.

### New file: `CivilizationApocalypse_BP/scripts/civ/districtplan.js` (pure, no `@minecraft/server`)

```
planDistrictSite(plan, index, field, options) -> { ok, problems, notes, record }
siteOpsFor(record, stage, elementIndex)       -> Op[]        // regenerated on demand
siteOpsById(record, stage, elementId)         -> Op[]
siteOpSlices(record, { maxOps, stages })      -> generator   // <= CIV_LIMITS.maxBlocksPerSlice per slice
siteJobSpecs(record)                          -> { clear: [...], walls: [...], ... }  // for jobs.createQueue
siteContainmentProblems(plan, index, record)  -> string[]
siteOpCount(record)                           -> number
SITE_PLAN_VERSION, ENLARGED_LAYOUTS, SITE_RULES, SITE_STAGES
```

Design points worth reviewing first:

- **`ENLARGED_LAYOUTS` is `{ 1: "hearthgate-enlarged" }` only.** Districts 2-5 return
  `ok: false` with an explicit "Phase C plans Hearthgate only" problem, per my scope. It is a new
  versioned layout id, so `district.physical` / layout `hearthgate` v1 (49x49) is never resized,
  regenerated or erased — your safety rule from `CIVILIZATION_PLAN_DESIGN.md:100`.
- **The record is JSON-safe and holds element *descriptors* only**, with exact op counts and an
  op-content hash per element. Ops are regenerated from closures held in a module-level `WeakMap`
  keyed on the record. A 40k-column district therefore never holds its block list in memory at once,
  and the record serialises to **57 KB** (budget `CIV_LIMITS.maxPlanBytes` = 120 KB). A test asserts
  no element ever stores an `ops` array and that streaming leaves the record size unchanged.
- `options.excludeFootprints` implements your "generation refuses any footprint that touches an
  existing physical record" rule: overlapping elements are skipped, noted, and counted.
- Determinism: seeded only, from `options.seed ?? plan.seed`; stable sort by element id everywhere;
  no `Math.random`, no `Date`. Two runs give an identical `record.checksum`.

## 2. Measured result for Hearthgate (seed 21, `makeField(21, { relief: 18, hills: 60 })`)

`ok: true`, `problems: []`, planning wall time ~1.0 s after the ~0.35 s master-plan run.

| | |
| --- | --- |
| walls planned | 5 (1 outer + 3 shared + 1 extra adjacency), 977 centreline length, **34 towers**, 42 buttresses, 40,877 ops |
| gates + gatehouses | 4 — purposes `main` x2, `reinforce`, `evac`; 26,966 ops |
| roads | 50 elements, 3,294 centreline cells, **incl. the surfaced patrol ring** (1,911 ordered cells of a 1,625-cell lane), 9,412 ops, 0 refusals |
| lots | 51 placed → 43 pads + 43 footings + 43 buildings; 18 defence lots (3 watchtowers, 11 guard posts, 2 barracks, armoury, citadel), 10 residential; 8 lots dropped for no buildable pad |
| terrain work | 5 wall-access stairs, cut/fill/retaining counts per pad, road stairs on slopes, elevation span 25 levels, bridge ops verified separately on a forced river |
| total ops | **96,033** across stages `clear/walls/gates/roads/lots/dressing`, streamed in **357 slices of ≤ 400** |
| record | 57,740 bytes serialised (budget 120,000), checksum stable across re-runs, `siteContainmentProblems` → `[]` |
| enclosure | sealed-fill from the centroid reaches 39,383 cells and **cannot** reach the survey window edge; 89 enclosed cells (0.23 %) carry a foreign coarse label, all within 0–1 blocks of a wall column |

## 3. Tests — commands and results

```bash
npm run verify        # all four gates
node --test dev/test/civ-districtplan.test.mjs    # my 24 tests alone
```

At handoff: **`offline unit tests 524 pass / 0 fail`** (your 500 + my 24),
**`manifest + packaging 438 checks / 0 failed`**, **`typecheck 0 errors`** (strict `checkJs`, so the
new module is covered like the rest), **`headless end-to-end 52/52`**. Total suite time ~66 s.

New file `dev/test/civ-districtplan.test.mjs` (24 tests) covers the twelve areas I was asked for,
with **independent** geometry in the test file (own flood fill, own label decoder, own gap maths) so
a bug in the composer cannot be confirmed by the same bug in its helper:

irregular-boundary (bbox fill < 0.8, ≥ 12 outline vertices, perimeter spans > 40 distinct x and z) ·
continuous enclosure with gates shut (no escape, no deep foreign land) · gates-open connectivity
(reachable only into ring neighbours 2/5, never 3/4) · ring walls and outer wall each carry a gate ·
every gate on its own wall band and served by a road · road terrain-following + stairs + zero refusals ·
bridge appears when a road meets water (tested on `civfixture.validFullPlan(7)` with a forced river) ·
building spacing, no shared columns, no building inside the wall band · every lot pad-ready or
explicitly noted · door/frontage on the surfaced network · evacuation + reinforcement routes name only
real gates · containment via `siteContainmentProblems` · link roads leave only toward one district and
only through a gate · **prototype planner unchanged** (`planDistrict` still 49x49, same `planHash`) ·
parent `validatePlan` still passes · protected-footprint refusal · districts 2-5 refused ·
determinism (same seed equal, other seed differs) · op totals/hashes reproducible · bounded memory ·
`jobs.createQueue` accepts `siteJobSpecs` and reports nothing pre-done.

Reused your utilities rather than duplicating: `dev/lib/fakefield.mjs`, `dev/lib/civfixture.mjs`,
`civ/jobs.js`, `civ/budget.js`, `civ/validate.js`, `structures/planner.js`. No new dependencies.

Three throwaway diagnostics also landed in `dev/` and are **safe for you to delete**:
`probe-districtplan.mjs`, `probe-enclosure.mjs`, `probe-seal.mjs`.

## 4. Defects I found and fixed in my own code

1. `const bbox` reassigned in the wall loop (hard `TypeError`, caught by the first smoke run).
2. `bboxOfOps` was handed a *point* where it wanted rects → `NaN` serialised as `null` in gate bboxes.
   Now it throws on non-finite input instead of silently producing `null`.
3. Wall-access stairs: the first version asked `planStairs` for a rise over a 3-cell run, got
   `ok: false`, and **silently dropped** the element (2 of 4 placed). Rewritten to search run lengths
   3..12 toward the centroid and to note every refusal.
4. I stored a stair op count in a descriptor field named `ops`, which collided with my own
   "no ops in the record" assertion — renamed `opCount`.
5. Two of my assertions were wrong, not the code (worth knowing, because they show what the invariants
   actually are): "sealed perimeter" ignored that gate openings are holes *by design* — the real
   claim needs the gate footprints sealed; and "every wall has a gate" over-asserted, since your
   contract only requires gates on ring pairs.

## 5. Things you should know about — I documented rather than rewrote

1. **The patrol lane was a phantom street.** `zoneDistrict` routes 12 of 43 house frontages onto
   `zones.patrol` (`frontage.via === "patrol"`), but nothing in the repo ever *surfaces* those cells:
   arterials come from `plan.roads`, streets from `zones.streets` + `lots.extraStreets`, and the
   patrol list is scan-ordered, not a path. A physical plan that ignores it gives 40-odd buildings
   doors onto nothing. I surfaced it inside my composer (`orderRing` nearest-neighbour walk →
   `planRoadProfile`, kind `road-ring`). **If you build a second district planner, take it from
   `districtplan.js` or hoist it into `zoning.js`** — do not re-derive it.
2. **Boundary slack: 89 enclosed cells (0.23 %) carry a foreign coarse label.** One 3-thick wall
   serves two districts, so cells pressed against the inner edge of a shared wall can be labelled
   `2`, `5`, `3`, `4` or even `0` (wilderness) while sitting inside Hearthgate's perimeter. All are
   within 0–1 blocks of a wall column. Consequence for the runtime: a per-cell authority check based
   on the **label grid** will refuse legitimate wall/lane cells. Use the wall band (or the district
   outline) for build authority, not `labelAt`. `validatePlan` passes today because it erodes before
   flood-filling.
3. **`wall-7` is a real shared wall between districts 1 and 3 with no gate.** The label grid made 1
   and 3 adjacent, but the simulation ring is 1-2-3-4-5-1, and `CIVILIZATION_PLAN_DESIGN.md:74`
   requires gates only on ring pairs. So physically 1 and 3 are walled off from each other, and the
   kingdom graph (`district.neighbors`) does not know they touch at all. Your call: add the gate, or
   forbid non-ring adjacencies in `regions.js`. I changed nothing.
4. **8 of 51 lots got no buildable pad** on this terrain (`planPad` cut ≤ 4 / fill ≤ 4 / retaining
   ≤ 4, one note reads `ground y=61..73`). They are counted in `stats.lotsWithoutPad` and each has a
   note, but the plan is 16 % thinner on buildings than zoning asked for. Probably wants multi-level
   terracing across a pad, or role-scaled limits.
5. **The new record is not wired to the runtime.** `commands/physical.js` still hard-refuses
   everything except `district-1` with layout `hearthgate`, and `integration/districtBuilder.js`
   consumes the old flat `plan.blocks` list, not `siteOpSlices`. Deliberate: my brief forbade
   deployment work. `siteJobSpecs` already matches `jobs.createQueue` (exact `total` + `hash` per
   element) and the op ids arrive in **three conventions** — `minecraft:`-prefixed from
   `foundations.js`, bare tokens from `walls.js`, and palette-resolved ids plus a `name` token from
   blueprints. Decide the canonical form before writing the builder, or it will re-normalise per call.
6. **Stale docs, not my scope to fix:** `docs/PROGRESS.md` and `docs/TESTING.md` still claim 148
   tests / 231 manifest checks (now 524 / 438), and `PROGRESS.md` never mentions the civ layer.

## 6. Recommended next steps, in order

1. Review `civ/districtplan.js` — it is the whole change; the rest is tests and probes.
2. Pick the canonical op-id form, then write `integration/civBuilder.js`: consume
   `siteOpSlices(record, { stages })`, classify each op through `structures/siteRules.js` +
   `terrain.js` (your existing per-cell safety path), and drive it with `jobs.createQueue(siteJobSpecs(record))`.
   Keep `civ:district_generate` dry-run/confirm semantics and refuse when `record.problems` is non-empty.
3. Add a `planstore` round-trip test for the district record (57 KB → 2 chunks at 30,000 chars) — I
   did not exercise chunking, only the byte budget.
4. Decide items 5.3 (the ungated 1↔3 wall) and 5.4 (terracing) and reflect them in
   `CIVILIZATION_PLAN_DESIGN.md`, which is your stated shared contract.
5. Hoist `orderRing` + patrol surfacing out of `districtplan.js` if you want it for districts 2-5.
6. Only then: register a layout id per district, lift the `prototypeDistrict` guard in
   `commands/physical.js`, and do the in-game verification pass — nothing in this milestone has ever
   run inside Minecraft.

## 7. Scope compliance

No deployment. No world or `com.mojang` change. The 49x49 Hearthgate was not regenerated, resized or
erased (asserted in tests). No simulation rewrite, no NPC armies, no other district started, no
automatic-generation workflow, no architectural changes outside Phase C, no destructive Git
operations, and nothing was left in a state I described as complete that is not verified —
in-game behaviour specifically remains **unverified**, as it was before I started.
