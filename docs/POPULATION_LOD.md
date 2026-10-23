# Population representation and level of detail (WP4)

Status: **built, tested offline, not wired.** Nothing in the pack imports or starts the population sync. The
default configuration spawns nothing, and `popSync` refuses to apply actions unless its caller passes
`enabled: true`. No in-game run has been performed. Requirements are in `docs/ROADMAP.md` section A.

## What it is

The 400 civilians and 150 soldiers stay purely simulated in `kingdom` records. Only a bounded subset becomes
physical entities, and only near players. This document covers the layer between those records and the entities:
which group is physical, how an entity is bound to its record, and how a crash, a restart, a chunk unload or a
duplicate cannot duplicate or lose population.

Files:

| File | Role |
| --- | --- |
| `CivilizationApocalypse_BP/scripts/population/settings.js` | every number and key (pure data) |
| `CivilizationApocalypse_BP/scripts/population/groups.js` | group table, stable ids, spawn spots, fight predicate |
| `CivilizationApocalypse_BP/scripts/population/identity.js` | tag scheme: read and classify tags |
| `CivilizationApocalypse_BP/scripts/population/lod.js` | level of detail with hysteresis and caps |
| `CivilizationApocalypse_BP/scripts/population/cursor.js` | the persisted cursor, versioned and bounded |
| `CivilizationApocalypse_BP/scripts/population/reconcile.js` | the pure reducer |
| `CivilizationApocalypse_BP/scripts/integration/popSync.js` | the runtime boundary (the only file that imports `@minecraft/server`) |
| `dev/lib/poptharness.mjs` | fake Bedrock world used by the sync tests |
| `dev/test/population-lod.test.mjs` | pure tests, including a seeded property run |
| `dev/test/population-sync.test.mjs` | adapter tests against the fake world |

## Groups, not individuals

Each district's civilians and soldiers are split into groups: a civilian group is 10 people, a soldier group is 5.
Group `i` of a kind covers people `[i*size, (i+1)*size)`, so the last group is the remainder. An 80-civilian district
has 8 civilian groups (the last holds 10), and a 30-soldier district has 6 soldier groups.

- Ids are `district:kind:index`, for example `district-1:civ:3`. Growth adds a higher index, shrinkage removes the
  highest index, and nothing is renumbered.
- A group's headcount comes from the record on every reconcile. Observation never changes a count. Drift (entities
  that claim people the record does not hold) is reported and never corrected.
- Not represented as groups: trainees (`trainingQueue`) and refugees. They are reported as `unrepresented` in the
  drift section. Whether they need their own kind is an open question.

## Identity: the tag is the binding

A physical entity carries exactly one canonical tag, `civpop:v1:<groupId>`. Every tag outside the `civpop:`
namespace belongs to someone else and is never read for identity, changed or removed. Entities with no own tags are
player units and are never touched. An own-namespace tag that cannot be read (a future version, garbage) or that
names an unknown district makes the entity an **orphan**: it is reported and left in place.

An entity claiming two groups, or carrying a stray own-namespace tag next to its canonical one, is **retagged** to
its primary (lowest) group. Only own-namespace tags are removed.

Because identity lives in the tags, the cursor is advisory. Losing or corrupting it costs an adoption report, never
a duplicate or a lost unit (the tests prove this under random cursor loss).

## Levels of detail

Each group is exactly one of:

- **physical**: an entity stands for it, bounded by the caps below;
- **coarse**: no entity, a record marker only, inside `coarseRadius`;
- **simulated**: no entity, far away.

Rules, applied in order by `lod.js`:

1. No people, or no physical home (a district without `physical.origin`): simulated.
2. A **bound** group (an entity already represents it) stays physical out to `holdRadius`, whatever its chunk state.
3. An **unbound** group is promoted only inside `physicalRadius` and only with its spot chunk loaded.
4. Candidates are admitted **bound first, then nearest, then by id**, until the district or total cap is full. A bound
   group that loses its place to a cap is demoted (reason `capacity`). An unbound one waits in the coarse ring.
5. A bound group beyond `holdRadius` is demoted (reason `out-of-range`).

The bound-first rule plus the wider hold radius is the hysteresis: a unit standing on the physical edge does not flap
between spawn and despawn.

## Caps and budgets (final values, `settings.js`)

| Setting | Value | Meaning |
| --- | --- | --- |
| `groupSize` | civ 10, sol 5 | people per representative |
| `physicalRadius` | 48 | promotion radius (horizontal blocks from the nearest anchor) |
| `holdRadius` | 56 | a bound group stays physical out to here (hysteresis band 8) |
| `coarseRadius` | 128 | coarse ring |
| `maxPhysicalPerDistrict` | 8 | representatives per district |
| `maxPhysicalTotal` | 24 | representatives across the kingdom |
| `maxSpawnsPerTick` | 2 | spawns per tick; carried in the cursor, so repeats in one tick cannot spend it twice |
| `maxOpsPerTick` | 6 | spawns, despawns and retags combined, per tick |
| `workBudget` | 6000 | work units per reconcile (entity visits, group evaluations, tag reads, sort comparisons) |
| `POP_DISTRICT_OBSERVE_RADIUS` | 48 | adapter looks this far from each district's home |
| anchor observation radius | 144 | `coarseRadius + 16` around each player |

Measured work for one reconcile over five districts and 550 units: **1163** (every unit in view, 70 of them ours)
and **1093** (550 untagged units, nothing of ours), against a budget of 6000. The only super-linear step is the sort
of a group's representatives, and every comparison is charged to the meter.

Priority order inside one tick, as budgeted: duplicate removals, retags, demotions, spawns. Duplicates come first
because the one-representative rule is a correctness rule. Anything not done is reported as `pending`.

## The reducer

```
reconcile(state, observation, tick, overrides) -> { actions, state, report }
```

`observation` = `{ kingdom, entities: [{ id, tags, x, y, z, loaded?, inFight?, valid? }], anchors: [{x, z}],
homes: { [districtId]: {x, y, z} }, loadedChunks: Set<"cx,cz"> | string[] }`.

- `kingdom` is validated with `findValidationProblems` and never mutated (the tests deep-freeze it). Invalid records
  are **refused** with a reason; no actions are produced.
- A non-integer `tick` or an invalid override **throws** with the offending value.
- `actions` are data: `{op:"spawn", groupId, district, kind, index, at, typeId}`,
  `{op:"despawn", entityId, groupId, reason}`, `{op:"retag", entityId, groupId}`.
- Despawn reasons: `duplicate`, `out-of-range`, `capacity`, `empty` (a claimed group the records no longer hold).
- Deferred (never silently dropped): `chunk-unloaded`, `in-fight`, `spawn-in-fight`.
- Nothing is spawned or demoted while no anchor is near any player (`report.hold`). Duplicates and retags are still
  resolved, because removing a surplus never loses a unit.
- A removal needs: the chunk loaded at apply time, and no active fight. An active fight is `assault > 0` or
  security `contested`/`breached`. A `lost` district is not an active fight.
- Idempotence: apply the actions, reconcile again at the same tick, and the result is empty unless the budget was
  binding. The per-tick budget is in the cursor, so a repeat within one tick does not spend it again.
- A tick smaller than the stored one (a server restart resets the game tick) starts a new epoch and reports
  `clockReset`.

## The runtime boundary: `integration/popSync.js`

`createPopSync({ world, dimension, readKingdom?, anchors?, homes?, isChunkLoaded?, enabled?, config? })`

- `dryRun(tick)` reads the world and returns the plan. It writes nothing (tested: zero mutations).
- `reconcileOnce(tick)` refuses unless `enabled` is true. Otherwise it applies the plan, then saves the cursor.
- The cursor is saved **after** the actions. A crash in between leaves the cursor behind the world, and the next run
  adopts the representatives it finds.
- Every action is re-verified against the live world before it touches anything:
  - despawn and retag re-read the tags and require the planned group to still be claimed, and require the chunk to be
    loaded at apply time;
  - a spawn first runs a dimension-wide tag query. If a representative already exists (for example it wandered out of
    the observation window), it is adopted in a second planning pass and no spawn happens;
  - if the tag write fails after `spawnEntity`, the unit just created is removed again (a rollback of our own action,
    not a removal of population).
- Observation reads the windows around each district home and each anchor. Entities outside both windows are
  invisible to the reducer; the spawn guard covers representatives that wandered that far.
- A newer cursor version is refused and never overwritten. A corrupt cursor is reset to empty: safe, because the
  world is the truth.

## Persistence

Key `civ_pop` (a dynamic property), format `{"v":1,"t":tick,"n":runs,"s":spawnsOnTick,"o":opsOnTick,"p":[physical ids]}`.

Measured, UTF-8 bytes:

| State | Bytes |
| --- | --- |
| empty (nothing physical yet) | 41 |
| 8 physical (one district at its cap) | 199 |
| 24 physical (kingdom cap, five districts) | 503 |
| worst case used in the tests (24 long ids) | 517 |
| ceiling (`POP_CURSOR_MAX_BYTES`) | 1024 |

The cursor grows only with the physical list, which the caps bound. It does not grow with the number of units. A list over 48 entries, a non-integer counter, or a malformed id makes the cursor corrupt.

## Tests

Run: `node --test dev/test/population-lod.test.mjs dev/test/population-sync.test.mjs`

- `population-lod.test.mjs`: 34 tests. Covers the group table and stable ids, tags, hysteresis, caps, gating, fights,
  duplicates, orphans, retags, drift, budgets, idempotence, determinism, adoption, clock epochs, refusals, the cursor,
  the 550-unit benchmark, and a property run: 12 seeds x 250 steps applying every plan to an in-memory model that
  refuses forbidden actions. Coverage over the 12 seeds: 1317 spawns, 37 retags, 61 duplicate removals, 1215
  out-of-range despawns, 256 simulated crashes, 61 restarts, 25 lost cursors, 580 budget-limited ticks.
- `population-sync.test.mjs`: 21 tests against the fake world. Covers the default-off configuration, the static check
  that nothing in the pack names the sync, dry run versus apply, convergence, restart, lost cursor, crash after spawns
  before the cursor is saved, crash between spawn and tag (the untagged stray is never touched), tag-failure rollback,
  the spawn guard, foreign and player units, orphans, duplicates, unload deferral (nothing removed while unloaded, same
  units adopted on reload), corrupt and newer cursors, growth and shrinkage, and a long run through the adapter (5
  seeds x 160 steps: 698 completed ticks, 102 crashes, 34 restarts, 518 spawns, 517 despawns, 4 duplicate removals).
- Counts at the time of writing: 55 tests in the two files, all passing. `npm run validate` passes (882 checks).
  `dev/test/integration.test.mjs` (the runtime boundary guard) passes with `popSync.js` included.

The fake world (`dev/lib/poptharness.mjs`) models chunk visibility, a crash that kills every later call, the
property size limit, and a write journal. It does not model movement, pathing, or query cost. It proves the contract,
not the engine.

## Wiring the integrator must do later (none of it is done)

1. Build the sync only when explicitly chosen: `createPopSync({ world, dimension: overworld, enabled: true })`. Keep
   `enabled` false in the shipped configuration. Do not import it from `main.js` until the in-game checks below pass.
2. Choose a cadence for `reconcileOnce(tick)`, for example every 20 ticks through `system.runInterval`, and never more
   than once per tick. Do not start it from module scope.
3. Supply real homes. The default reads `district.physical.origin`, which exists only for districts with a physical
   footprint. Until the other four districts are physically built, only the district with an origin can be physical.
4. Supply real ground spots. `spotFor` is a deterministic offset grid from the home. The physical layer owns the
   ground check, and a spot on bad ground needs a rule.
5. Strip `civpop:*` tags from any template that could carry them, and add `civ_pop` to the wipe prefixes in
   `STARTER.wipeKeyPrefixes`. That change is in `config.js`, which this work does not edit. Nothing is spawned in a
   shipped world, so no tag exists yet, but the rule must be in place before the first spawn ships.
6. Decide the typed spawn for each kind. Both kinds currently spawn `minecraft:villager_v2`; soldiers are told apart by
   their tag only.

## Open questions for in-game testing

- Does `dimension.getEntities` return entities in unloaded chunks, and does an old handle to one throw? The design
  assumes it does not and defers anything it cannot see.
- Is `getBlock` returning `undefined` a reliable "chunk not loaded" probe? The adapter uses it for spot chunks.
- Cost of `getEntities` over 144 blocks around each player, and over each district, with 550 units plus everything
  else in view. This decides whether the observation windows need a cadence of their own.
- The crash window between `spawnEntity` and `addTag` (two consecutive calls) can leave one untagged stray. The design
  never removes or retags an untagged unit. The in-game run should measure how often the window is hit.
- Villagers wander. A representative that walks beyond the observation windows is found only by the spawn guard. The
  physical layer should keep representatives tethered; the tests assume this.
- Hold semantics: with no player anywhere, nothing is demoted. Do ticking areas or loaded chunks keep representatives
  alive in that state, and is that the behaviour we want?
- Per-player budgets and the LOD radii (48, 56, 128) are estimates. They need playtesting with real movement speed.
- Trainees and refugees are not represented. Is a third kind needed, or do they stay simulated?
- Does a restart reset `system.currentTick`? The reducer assumes it can, and treats a smaller tick as a new epoch.
