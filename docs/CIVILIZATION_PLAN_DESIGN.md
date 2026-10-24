# Civilization master plan - design contract (v1)

Goal: one terrain-aware, seeded, reproducible planner that lays out ALL FIVE districts as ONE irregular,
fully enclosed civilization (~175-200k enclosed block-columns, each district ~35-40k), plus the construction
pipeline that builds it in bounded, resumable stages. This document is the shared contract between modules; if
you must change it, change it HERE in the same commit and tell the integrator.

## Roles (assumption, recorded - the repo had no district roles)
| id | name | role | terrain preference |
| --- | --- | --- | --- |
| district-1 | Hearthgate | `command` (central military/command, civic core, barracks, HQ) | defensible high ground, NOT the geometric centre |
| district-2 | Ironquarry | `industrial` (smithies, quarry, warehouses, workshops) | rocky/hilly edge |
| district-3 | Whitethorn | `agricultural` (farms, granaries, orchards, mills) | flattest land |
| district-4 | Saltmere | `commercial` (markets, docks/bridges, inns) | near water if any |
| district-5 | Ashfall | `residential` (neighbourhoods, gardens, schools, chapel) | sheltered, gentle slopes |
Neighbour ring in the simulation: 1-2-3-4-5-1 (`district.neighbors`, `district.gates`). The physical adjacency must
include at least those pairs (extra adjacencies allowed); the existing 49x49 Hearthgate prototype stays untouched.

## Repository conventions (all agents)
- Pack = `CivilizationApocalypse_BP/scripts` (plain JS, ES modules, JSDoc types, strict `checkJs`: `npm run typecheck`
  must stay clean). Every relative import ends in `.js`. Dev code/tests live in `dev/` (never shipped).
- **Pure code** (no `@minecraft/server` import) lives in `scripts/civ/` (new, registered as a pure dir in
  `dev/test/integration.test.mjs` by the integrator). Runtime-boundary code lives in `scripts/integration/` or
  `scripts/commands/` and MUST import `@minecraft/server`.
- scriptevent ids: `civ:name` with exactly ONE colon, lowercase + underscores (`dev/test/commands.test.mjs` guards this).
- Tests: `node --test dev/test/*.test.mjs`. Synthetic terrain: `dev/lib/fakefield.mjs` (see its header for the
  height-field contract). Determinism is mandatory: only seeded randomness (`scripts/sim/rng.js` mulberry32 or a
  local pure hash); no `Math.random`, no `Date`.
- Do not edit files you do not own (matrix below). Report needed changes to the integrator instead.
- Never weaken an existing test. Add adversarial tests that can actually fail.
- No heredocs with apostrophes in shell; create files with the editor/Write tool.

## Height field (planner input)
`field.at(x, z) -> { g, k, tree }` and `field.bounds` exactly as in `dev/lib/fakefield.mjs`. In the pack a scanner
(`integration/`) fills a `Float`-free compact grid from `getTopmostBlock` reads and exposes the same interface
(`makeGridField` in `civ/field.js`, owned by the terrain agent). Planner code must only use `at` and `bounds`.

## CivPlan (JSON-safe, versioned, deterministic from `(seed, anchor, field)`)
All coordinates are WORLD block coordinates (integers) unless stated. District index 1..5 = `district-N`; 0 = outside.
```
CivPlan {
  version: 1,
  seed: int,
  anchor: {x, z},                 // search centre the plan was made around
  cell: 4,                        // coarse label-grid cell size in blocks
  grid: {x0, z0, w, h},           // cell (i,j) covers x0+4i .. x0+4i+3, z0+4j .. z0+4j+3
  labels: [[label, run], ...],    // row-major (j outer, i inner) run-length encoding of w*h ints 0..5
  districts: [{ index, id, name, role, area, cells, centroid:{x,z}, hq:{x,z}, bbox:{x0,z0,x1,z1},
                outline:[[x,z],...] }],   // area = enclosed block-columns (>= 30000, ideally 35-40k); hq != forced centre
  walls: [{ id, kind: "outer"|"shared", between:[a,b], closed:boolean,
            path:[[x,z],...], thickness: 3 }],     // wall CENTRELINE; consecutive points 8-connected after geom.rasterize
  gates: [{ id, wallId, at:{x,z}, axis:"x"|"z", width:5, between:[a,b], purpose:"main"|"evac"|"reinforce"|"field" }],
  roads: [{ id, kind:"arterial"|"street"|"link", district:int, width:int, path:[[x,z],...] }],
  routes: { evac:[{from, to, gates:[id...]}], reinforce:[{from, to, gates:[id...]}] },
  stats: { totalArea, perDistrictArea:[..5], compactness:[..5], bboxFill:[..5], wallLength, gateCount, roadLength },
}
```
Shared geometry helpers (single implementation, owned by the planner agent, imported by everyone) in `civ/geom.js`:
`rasterizePath(path, closed) -> [[x,z]...]` (Bresenham, 8-connected), `stamp(cells, thickness)` (disc/square dilation giving a
4-connected barrier), `decodeLabels(plan) -> Uint8Array`, `labelAt(plan,x,z)`, `polygonArea`, `pointInPolygon`,
`bboxOf`. Walls are sealed at BLOCK resolution: stamped thickness-3 rasterized wall pixels must be 4-connected barriers.

## Planner pipeline (Phase A) - `civ/masterplan.js`
1. Coarse suitability over a bounded region (radius <= `CIV.maxSearchRadius`, default 220 around anchor): reject water,
   lava, unloaded, steep cells; score slope/relief/trees/water proximity.
2. Pick an irregular settlement mask of ~190k+ columns (grown from suitable seeds with seeded noise on the frontier,
   never a rectangle/circle; shape must pass the non-geometric tests).
3. Place five seed points biased by role (command on defensible high ground and NOT centroid; agricultural on flattest;
   commercial near water/edge; industrial on rocky/hilly; residential sheltered), then region-grow (multi-source Dijkstra
   with terrain-cost weights + seeded noise) to area targets 35-40k +/- terrain variation; all five meaningfully different.
4. Boundaries as planar chains between junctions, smoothed (Chaikin/curvature-limited, endpoints at junctions fixed so
   neighbours share the identical chain), terrain-guided (cost-aware: prefer ridges/valleys/water edges), straight runs
   allowed where defensible. Single shared wall per adjacent pair; outer wall around the union.
5. Gates: >= 1 closable gate on every shared wall pair in the ring, >= 2 outer gates per district facing outside as needed
   (field gates for agricultural), each on a straight axis-aligned run of >= 11 wall blocks (planner straightens it).
6. Roads: arterial network connecting every gate and HQ per district (curving, terrain-adaptive, A*), streets for lots.
7. Routes: `evac` (each district -> safer neighbours through gates only) and `reinforce` (each pair in the ring both ways).
8. Reject (re-seed deterministically, bounded attempts) when validation (`civ/validate.js`) fails.

## Validation (Phase B) - `civ/validate.js` (independent of the planner)
Block-resolution geometry tests: every wall closed and 4-connected; flood fill from each district interior cannot
reach another district or outside except through a gate cell; gates sit on walls and connect exactly `between`; five
districts connected via gates; areas in range; outer boundary complete; no wall segment isolated/dangling; shape tests
(not square/rectangular/circular/symmetric: bboxFill < 0.80, compactness band, per-district shapes pairwise different,
no two outlines congruent under rotation/reflection, overall outline irregular); roads reach every gate and HQ;
evac/reinforce routes exist and use only gate cells; spacing/area sanity.

## Construction pipeline (Phases C-F) - runtime
Stages per district, each a bounded `system.runJob` generator with a persisted cursor, idempotent writes and the
existing per-cell safety classification (`structures/terrain.js classifyTerrainCell`, `siteRules`): 1 clear vegetation in
claimed footprints -> 2 wall foundations & walls (terrain-following) -> 3 gates -> 4 roads (stairs on slopes, bridges) ->
5 lots (foundation pads / retaining walls, then buildings from blueprints) -> 6 dressing. Ground profiles of walls/roads/lots are
sampled during the (read-only) planning scan and STORED in the plan so resume never re-reads our own blocks as ground.
Plans persist in chunked world dynamic properties (`civ/planstore.js`, <= 30000 chars per property, checksum, versioned).
Job cursors persist in `district.physical`-style records, never the 32 KB kingdom blob.

## Safety (non-negotiable)
Generation only on explicit command in a test world; never on pack activation; automatic world-start generation stays
disabled. Surveys/planning are read-only. Never overwrite player builds or existing walls; only natural ground, plants and
natural trees are modified; ambiguous = refuse. The 49x49 Hearthgate (`district.physical`, layout `hearthgate` v1) is never
regenerated, resized or erased: enlarged layouts are NEW versioned layouts with their own record (`district.civ`), and
generation refuses any footprint that touches an existing `physical` record's footprint.

## File ownership (parallel work)
| Agent | Owns (create/edit) |
| --- | --- |
| A planner | `scripts/civ/geom.js`, `civ/masterplan.js`, `civ/regions.js`, `civ/chains.js`, `civ/roadnet.js`, `dev/test/civ-masterplan.test.mjs` |
| B layout | `scripts/civ/zoning.js`, `civ/lots.js`, `structures/blueprints2.js`, `dev/test/civ-layout.test.mjs` |
| C terrain | `scripts/civ/field.js`, `civ/siteselect.js`, `civ/foundations.js`, `dev/test/civ-terrain.test.mjs` |
| D fortification | `scripts/civ/gates.js`, `civ/walls.js`, `sim/gatecontrol.js`, `integration/gateAdapter.js`, `commands/gates.js`, `dev/test/civ-gates.test.mjs` |
| E persistence | `scripts/civ/planstore.js`, `civ/jobs.js`, `civ/budget.js`, `dev/test/civ-persist.test.mjs` |
| F verification | `scripts/civ/validate.js`, `dev/test/civ-validate.test.mjs`, `dev/test/civ-adversarial.test.mjs` |
| integrator (main) | `config.js`, `main.js`, `kingdom/state.js`, `commands/civ.js`, `integration/civBuilder.js`, docs, every existing file |

## Contract clarifications (from the validator, adopted)
- `gate.axis` = the axis the WALL runs along; the opening spans `width` blocks along it and `thickness` across.
- `wall.closed:true` means the path repeats its first point. Open chains must end at junctions (touch another wall).
- `district.area` = labelled cells x 16 exactly; `bbox` may differ by <= 4 blocks (smoothing slack).
- Outer walls: `between` contains 0. Shared walls: two distinct positive indices.
- Movement may cut corners, so walls are stamped to 4-connected barriers (thickness >= 3). Roads may run <= 14 blocks past a gate.
- Decisions: site search uses `avoid` mode for existing footprints (old Hearthgate); search radius is an argument (default 220, max 400).

## Five-district build-once contract (adopted 2026-10-18)

The starting kingdom is built ONCE in a dedicated development world and shipped as a world template;
the procedural pipeline stays intact for later conquest and rebuilding.

- **One plan, one coordinate system.** `civ/masterplan.js` produces the whole civilization (five
  irregular districts, shared walls, gates, roads, routes) from `(seed, anchor, field)`. A district's
  site plan is always `planDistrictSite(plan, index, field, options)` against THAT plan. No district may
  pick its own site: `civ/worldplan.js` takes `options.district` (1..5) and refuses anything else.
- **Layouts.** `civ/districtplan.js` `ENLARGED_LAYOUTS` registers all five: `hearthgate-enlarged` (command),
  `ironquarry-enlarged` (industrial), `whitethorn-enlarged` (agricultural), `saltmere-enlarged` (commercial),
  `ashfall-enlarged` (residential). Facility mixes come from `civ/zoning.js` `ROLE_ZONES` ->
  `structures/blueprints2.js` `BLUEPRINT_VARIANTS`; no role may invent a facility with no blueprint.
- **Storage keys** (all under the prefixes the starter-world rules already keep or wipe): the master
  plan stays under the `civ:plan` plan-store prefix; each district's own site payload (ground +
  options + checksum) goes to a prefix built from it - `PLAN_PREFIX` + `":site:d" + index` - and each
  district's resumable queue to `JOB_PREFIX` + `":d" + index`, with district 1 keeping the plain
  legacy queue prefix and the old single-slot ground as a read path for saved worlds. Both are built
  by concatenation, never written as a literal here, because the repo-wide guard that forbids a
  two-colon `civ:` id scans docs too. `district.civ` in the kingdom blob stays a small
  pointer (status/seed/anchor/centre/checksum/stage/progress). Measured on a complete five-district build
  in the fake world: the master plan plus the five site payloads occupy 155,697 B in 13 keys, the longest
  value 30,000 chars (the store's own chunk ceiling, below the engine's 32,767), and the five queues
  11,029 B in 10 keys - 2,068-2,745 B each against the 16 KB `maxJobBytes`. The kingdom blob is 6,611
  chars with all five districts complete, of which the five `district.civ` pointers are 1,546 B
  (305-313 B each). Per-district block operations 58k-75k against the 400k per-district ceiling, 331,759
  for the whole civilization at the reference seed, 266,473 blocks actually written in the offline build.
- **Build order.** Neighbour ring 1-2-3-4-5-1, capital first. A shared wall is included in BOTH
  neighbours' records, so neither district's enclosure depends on which of them was built first. That
  duplication has a price the write guard has to pay: the clearance that keeps a later district out of a
  finished one's land also covers columns only the later district plans (62 of the 11,465 barrier columns
  at seed 21), so a wall op of the district being built is allowed into the *outward band* of a finished
  neighbour - never onto its own land, never an op that removes a block, and only onto raw terrain,
  because two districts' walls are the same stone and an identical id would otherwise read as "ours"
  (`integration/civBuilder.js` `isSharedWallFill`). Writes are place-only, so nothing here can take a
  neighbour's masonry down.
- **Arming requires the whole city.** `STARTER.builtRequired` (config.js) and `starter.builtRequired`
  (template.json) both list all five districts, and `dev/test/template.test.mjs` fails if the two
  lists drift. `civ:starter_arm confirm` therefore refuses a partially built world.
- **Release is stricter still.** `npm run template:release-check` needs all five marked
  `starterWorld: true, status: "built"`, receipted, and verified; `--zip` is refused while it fails.
- **Geometry invariants are asserted on the BUILT records**, not only on the plan:
  `dev/test/civ-fivedistrict.test.mjs` uses `civ/validate.js`'s own component labeller to check that
  walls + gate hardware seal every district from its neighbours and from the exterior, that the road
  network reaches every HQ and every gate and crosses between districts only at gate passages, and
  that each role's facilities are actually placed, spaced and - where a programme could not be sited
  - announced through `civ/facilities.js` rather than hidden behind a flattering statistic. Where one
  of these is red, the district is not shippable; the test is the record of the defect.
  Deliberately NOT asserted: cell-by-cell equality between the plan's square-stamped band and the
  blocks the records place - the terrain-following band and a square stamp of the centreline differ at
  corner cells, and the safety question is whether anything can walk through, which the sealed-separation
  tests answer directly. What IS measured is an internal inconsistency in the wall stage: summed over the
  five districts its elements report more band columns than their own operations cover - 15,146 against
  14,952 at seed 21 (194 apart, worst single element 30), 14,650 against 14,368 on flat ground (282
  apart, worst 34). The built line admits no walkable corridor, so this is bookkeeping in `civ/walls.js`,
  and fixing it moves district 1's stored checksum - a scheduled change, not something to slip in here.
