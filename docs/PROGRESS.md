# Progress

Checkpoints are in the local git history (`git log --oneline`). This project is **the first
autonomous kingdom-simulation milestone**, not a finished mod.

## Phase A — simulation architecture
`scripts/config.js` (all tunables), `scripts/sim/rng.js` (seeded mulberry32 travelling in
`kingdom.rngState`), `scripts/sim/clock.js` (one step = one in-game hour),
`scripts/kingdom/state.js` (schema v2, derived totals, save validator, occupancy helpers),
`scripts/kingdom/migrations.js` (v1 → v2 registry), `scripts/kingdom/store.js`
(status-classified load, quarantine, refuse-to-downgrade).

## Phase B — district management
Five districts with independent population/capacity, garrison and reserve, stores,
defensive integrity, security, neighbours, gates and projects. Reporting: `ui/report.js`
`formatStatusLines` (original five lines preserved, plus a `-- situation --` block),
`formatDistrictLines`, `formatTerritoryLines`, `formatPolicyLines`. No city is generated.

## Phase C — military defence and evacuation
`scripts/sim/war.js` (threats, alert states, defensive assignment, reinforcement with a
home-strength cap, assault resolution, counterattack, recovery, `runWarStep`) and
`scripts/sim/evacuation.js` (target search with honest blocked-route reasons, bounded
per-step movement, gate state changes, isolation, refugee return).
`war.test.mjs` 34 tests, `evacuation.test.mjs` 20 tests.

## Phase D — conquest and balanced automatic expansion
`scripts/sim/expansion.js` (victory → military control with upkeep → evaluation with
reasons → claim → new district record wired into the graph, with the standard build plan
scheduled) and `scripts/sim/construction.js` (data-driven `PROJECT_TYPES`, staged progress
paid per stage, stalls loudly when it cannot pay, permanent kinds cannot be removed,
bounded `collectBuildQueue` view for the adapter).

## Phase E — population and recruitment
`scripts/sim/population.js` (feeding, farm output, growth toward remaining shelter,
training queue, `advanceTraining`, recruitment limits and refusals) plus
`scripts/sim/policies.js` for the autonomous decisions: production, occupation of opened
land, drafting to a share of population, and development scheduling.

## Phase F — commands, scenarios, adapters
`sim/tick.js` (fixed step order, validator-gated rollback, clamped catch-up),
`sim/scenarios.js` (six deterministic demonstrations), `commands/{args,reply,status,inspect,debug}.js`,
`integration/{simulationLoop,buildAdapter}.js`, `events/welcome.js`, `main.js`.

## Verification
`npm run verify` runs four gates: manifest/packaging (**903 checks**), strict `checkJs`
typecheck against `@minecraft/server` 2.7.0 (**0 errors**), unit tests (**1029 across the tracked test files; was 148 across 10
files**), headless end-to-end kingdom run (**52/52 stages**).

## Defects found while integrating this milestone, and fixed

1. **The kingdom could not sustain an army.** `DISTRICT_DEFAULTS.suppliesPerStep` and
   `materialsPerStep` existed in config but **no module ever used them** — only farms
   produced anything, so stores could only shrink. Measured over 500 steps: 150 soldiers →
   **19**, and recruitment was blocked on supplies for 552 district-steps. Fixed by
   `policies.runEconomyStep` (work gangs → materials, storehouses → supplies, capped by a
   stockpile ceiling). Now: 110–190 soldiers sustained, population 400 → 980.
2. **Expansion could never happen on its own.** `runExpansionStep` only claims land already
   at `military`, and nothing moved `raided → military`, so a border victory stalled the
   pipeline forever. Fixed by `policies.runExpansionPolicy`, with `paused` still refusing.
   The end-to-end run now proves victory → control → claim → 6th district with seven
   staged projects, without any manual claim call.
3. **Saved state grew without bound.** Completed projects stayed in `district.projects`
   forever: peak blob **23.5 KB** and climbing. Fixed by `tick.pruneCompletedProjects`
   (keeping two as history); peak is now **≈15 KB** over 400 steps, asserted in tests.
4. **Two modules disagreed about shelter.** Evacuation modelled occupancy as
   `civilians + refugees <= capacity`; population growth capped only at `civilianCapacity`,
   so a host taking refugees could overfill. Fixed by `districtOccupancy`/`districtHeadroom`
   in the schema, growth now capped by remaining room, and a **new validator rule** that
   refuses to save an over-sheltered district.
5. **Quarantine lost the version of the copy it kept** (`readSchemaVersion` was handed the
   JSON *string*, so `schemaVersion` came out `undefined`). Caught by a new test.
6. **Two of my own end-to-end assertions were vacuous** — a `||` disjunction that passed
   while the district actually fell, and a "sent 30 troops" check that passed on
   `sent = 0`. Rewritten to assert the mechanism on fresh, deterministic kingdoms.
7. Earlier phase-A fixes: an `any[]` typing pass, a validator assertion that failed a
   constants module for having no imports, and a purity guard that flagged a JSDoc *type*
   reference as a runtime import.
8. **Found by the final review: "gradual fallback when a position is overwhelmed" was not
   implemented.** The only `FALLBACK_*` symbols in `war.js` were unrelated config defaults,
   and my own design notes had claimed the behaviour. Added `war.updateFallback` /
   `fallbackPullback`, applied by `assignDefenders`, driven once per district from
   `runWarStep`, plus `dev/test/fallback.test.mjs` (7 tests: gradual thinning, never
   abandoning the wall, monotonic recovery, unchanged default split, savability, determinism).
   The first version also floored the *default* one-soldier split and broke an existing war
   test; the floor now applies only while a district is actually giving ground.

## Known limitations and open risks

- **Nothing has been run inside Minecraft.** No client on this machine; every result here is
  headless. See `docs/TESTING.md` for the in-game script.
- **`buildAdapter.js` is unexercised.** Its API use typechecks against 2.7.0, but block
  placement, unloaded-chunk refusal and "never overwrite non-air" have only been read, not
  run. It stays behind `civ:debug_build enable` + an explicit anchor.
- **The step-rollback branch is verified by inspection**, not by an executable case: no
  currently reachable system produces an invalid state, so there is nothing to trip it with
  short of injecting a fault. The guard it protects (validator rejects save) *is* tested.
- Reinforcements are gate-agnostic by design (a garrison marches out to meet raiders; gates
  govern civilian movement only).
- Gates are recorded one-way (`owner` is the clockwise district) and read as shared two-way
  routes.
- Newly claimed districts inherit only a share of the parent's stores, so they stall within
  a stage or two until the economy catches up — a balance flag, not a crash.
- A kingdom at war can be too weak to expand: expansion needs a secure, supplied border with
  surplus field army, which is intended, but it means "balanced" is genuinely slow.
- `PROJECT_TYPES` has no kind→effect metadata; effects are wired by a switch in
  `construction.js`, so a new kind would be recorded but do nothing else.
- `SIM.maxBlocksPerStep` is used as both a block budget and a queue-entry limit.

## Next milestone (not started)
Real entity counterparts for squads and civilians, physical city generation from the
project footprints, combat against actual mobs, iron golems and wolves, multiple kingdoms,
and a UI. Explicitly out of this milestone per the brief.


## Physical district prototype
First physical district (district-1) implemented and tested offline; see MINECRAFT_INTEGRATION.md. Next: in-game verification, then district 2-5 layouts, NPC/entity bridge.


## Civilization layer
Master planner, validator, terrain/site selection, layout, gates + walls, persistence/jobs, enlarged Hearthgate construction planner and runtime (`civ:generate`) are implemented and tested offline (637 tests at last full run; manifest 600 checks). Nothing in this layer has run in Minecraft. See ENLARGED_HEARTHGATE.md, CIVILIZATION_PLAN_DESIGN.md, ROADMAP.md, LEDGER_PLAN.md.


## Starter world template (current)
The shipped game is planned as a **prebuilt world template**, not a city generated on first join. Implemented and
verified offline: `scripts/sim/starter.js` (pure key classification with longest-prefix-wins, the reset-but-keep-the-built-
city baseline, the fail-closed arm refusal list, the release read-out), `scripts/commands/starter.js`
(`civ:starter_status` / `civ:starter_arm confirm` / `civ:starter_verify`), the contract in `starter/template.json`, the
hand-written Bedrock `level.dat` codec in `dev/lib/nbt.mjs`, `dev/validate-template.mjs` (now the fifth verify gate) and
`dev/build-template.mjs` (export -> staged template -> `.mctemplate`, source world read-only, writes only under `dist/`)
and `dev/lib/zip.mjs` (the archive is written by us: PowerShell's `Compress-Archive` was measured writing backslash entry
separators, which is not what the ZIP format or Minecraft's importer expects, so the packager now produces `/` separators,
no wrapping folder and byte-identical rebuilds - verified against a synthetic export, never against the game).
Arming resets population/step to the published baseline while keeping each district's `civ`/`physical` record, the
five-district master plan and the gate registry, and wiping jobs/debug/demo/devgate/quarantine/progress/survey residue;
it refuses an incomplete district, a running build, a pending or unreadable job queue, a forced gate and an unreadable
plan, and refuses to re-arm an armed world. Tests: 701 pass (18 new in `dev/test/template.test.mjs`, 10 new arming cases
driven through the fake `@minecraft/server` in `dev/test/reliability-runtime.test.mjs`), manifest/packaging 638 checks,
typecheck clean against 2.7.0, e2e 52/52, all five verify gates green (manifest/packaging 644 checks).
An independent review round then found eight real defects, all fixed and each with a test that now fails
if it comes back: the package gate compared `Level.Generator` to the string `"infinite"` while Bedrock writes
an Int (every real export would have been rejected, and the fixture had been invented with the friendly type);
`civ:starter_arm` never passed `planningRunning`/`builtRequired`, so the running-session refusal could not fire
and a live generation session could re-save dev progress over the just-armed baseline; the gate check read
invented `state`/`forced` fields instead of the registry's real `{v, gates:[{id, role, mode}]}` plus the
`civ_gate_<id>` adapter records, so a forced or mid-move gate shipped; only `civ.status === "building"` blocked,
so a paused half-district armed and then lost its only resume handle; `--out` was checked with a string prefix
(`distX` passed, and the builder deletes its staging directory); a previous, larger export's `db` files could
survive in `dist/work/source`; two packaging assertions could not fail (a missing template `manifest.json` was
"reported" by checking `level.dat`, and a no-arg condition), and one test compared a list's length to itself. **No `.mctemplate` has been produced and nothing
has run inside Minecraft**: district 1 has never been physically built, and `ENLARGED_LAYOUTS` registers only district 1,
so districts 2-5 are contract-ready and build-blocked. See STARTER_WORLD.md.

A second handoff (ChatGPT, 2026-10-18) then added the **release gate** on top of that commit, merged the same
day with no loss of the repairs above (its builder and test diffs were additions only): `dev/lib/release-readiness.mjs`
+ `npm run template:release-check` require all five districts marked `starterWorld: true, status: "built"`, listed
in `starter.builtRequired`, and receipted with the 400/150 baseline, zero pending jobs and a real `verifiedBy`;
`--zip` is refused while it fails, staging a development preview still works, and a `--out` overlapping the source
world or `dist/work` is refused before the builder deletes anything. It exits **1** today (0/5 built, no receipt),
which is the intended state, and is deliberately not a verify gate. Integrating it also meant refusing one claim in
that handoff - the 49x49 prototype was never built in-game either; see `docs/CHATGPT_HANDOFF_2026-10-18.md`.
A review pass over the merged gate then found three more holes, all closed with tests: `--zip` was the only
guarded route (a staged tree could be zipped by hand, and a stray single-district `.mctemplate` from an
earlier probe was already sitting in `dist/templates/`), so a blocked staging now writes
`DEVELOPMENT-PREVIEW.txt` into the tree and `template:release-check` reports any archive found in `dist/`
as non-releasable; the gate read only `template.json`, never the pack's own `STARTER.builtRequired`, so a
five-district spec with a one-district pack printed READY; and the two receipt validators disagreed.
Suite now 711 tests, all five verify gates green, `template:release-check` exits 1 with 25 blockers.



## Five-district construction (current)
All five enlarged physical layouts are registered (`hearthgate/ironquarry/whitethorn/saltmere/ashfall-enlarged`) and
plan from ONE master CivPlan in ONE coordinate system: measured at plan seed 21, areas 40,400 / 35,200 / 38,208 /
40,112 / 37,792 columns (191,712 total), compactness 0.57-0.80, bbox fill 0.56-0.66, `validatePlan` clean. Each
district is 58k-75k block operations (331,759 total at seed 21 on commit `e8b5622`; 2,491 write-phase slices). `civ:generate` takes `district=` and
`site=here` (bounded survey: radius 316, 341,988 column reads, farthest read 320 - the unbounded site search reads
376,512 and reaches 512). Building district N closes its finished neighbours' land to everything except the wall it
shares with them: measured, a finished district's masonry reaches exactly 3 blocks past its outline (hence a
clearance of 4), and that clearance also covers 62 columns only the later district plans, so a wall operation may fill
a band column that is still raw terrain and nothing else. Without that rule districts 2-5 lost their enclosure; with
it, a district-2 build that had replaced 9 finished blocks of district 1's wall face now replaces none, which the
runtime test forbids explicitly. `civ/facilities.js` audits role identity (every `DEFINING` kind must be physically
sited, on every terrain in the battery), names the kinds the siting stage cannot guarantee (`SITING_GAPS`, 14 of them),
and refuses any shortfall the record did not announce; `civ:generate_plan` prints it instead of hiding it (reference
plan: 0 facility problems, 2 announced shortfalls).
OFFLINE EVIDENCE - a fake Bedrock world, NOT Minecraft: districts 1 to 5 built in order in one run, all five reporting
"is built" and status `complete`; 266,473 blocks written, 1,912,599 reads across 27,007 slices, zero ticking areas left,
zero area violations; 4,026 / 3,961 / 1,037 / 8,525 operations refused for standing in a finished neighbour's land;
afterward the save holds 155,697 B of plan in 13 keys, 11,029 B of queues in 10 keys, a 6,611-character kingdom blob
whose five `district.civ` pointers total 1,546 B, and 15 registered gates. New offline coverage:
`dev/test/civ-fivedistrict.test.mjs` (14 tests: sealed separation on the wall+gate barrier built from the records,
exterior cannot reach any interior, one connected road network crossing between districts only at gate passages, the
write guard's effect on the line that actually gets built, shared walls planned by both neighbours, role identity and
the siting registry, spacing/density, per-district budgets, determinism) plus 7 runtime tests (crash-and-restart
equivalence, per-district persistence and independent wipes, refusal while a neighbour builds, legacy single-slot
worlds still resume). Suite on commit `e8b5622`: 1202 unit tests, 0 failures, 934 manifest/packaging checks, five
verify gates green. District 1's checksum is pinned unchanged
(`53c81775`), so existing Hearthgate saves are untouched. NOT DONE: nothing has been built in Minecraft; the wall
stage's own reported column count exceeds the columns its operations cover by 194 at seed 21 (282 on flat ground) -
sound, but to be closed in `civ/walls.js`, which moves district 1's checksum, so it is scheduled rather than slipped;
the 14 registry kinds (`orchard`, `customs_yard`, `command_hall`, `stable`, `drill_ground`, `mill`, `market_square`,
`pen`, `shop`, `garden`, `warehouse`, `barracks`, `farm_veg`, `farm_kitchen`) cannot always be sited, which is capacity,
not honesty; and the shared band's duplicate ownership is the root cause the wall-versus-clearance rule works around
(dev task 27). `template:release-check` exits 1 and `--zip` stays refused until all five are built and verified in
game. See FIVE_DISTRICT_BUILD.md, CIVILIZATION_PLAN_DESIGN.md, STARTER_WORLD.md.

## Goal pass (offline)
- Siege balance: merged to master (7679415) after the user approved the changed test expectations. Difficulty needs in-game playtesting.
- Districts 2-5 on the Hearthgate path, behind civ_devgate; golden keeps Hearthgate unchanged (FIVE_DISTRICT_BUILD.md).
- Invasion director: built, disabled, tick no-op (INVASION_DIRECTOR.md).
- Population LOD: built, spawning disabled, unwired (POPULATION_LOD.md).
- Commander's Ledger: presenters, runtime and dev-gated wiring on master (50590e3); manifest dependency on server-ui 2.1.0 (7f35c71), UNVERIFIED in game.
- Approved expectation changes (user option A): war.test.mjs wall-crew values (standing crew 2); evacuation.test.mjs repair expectations (integrity 100, materials 135) and the 'wall rebuilt first' check now asserts integrity above breachIntegrity; reliability-runtime.test.mjs subscriber count 7 to 8 (the Ledger development switch) and harness stubs; siege-longhorizon.test.mjs first-breach bound 1000 to 1500 (its own new file). Verified on a clean export of 89f442c: exit 0, 903/903 manifest, 1029/1029 unit, e2e 52/52.

## The Horn of Hearthgate (player-facing entry point)
`inventory/beaconRules.js` (pure: identity, intent, bearing, guide text) and
`integration/beaconBindings.js` (the Minecraft-facing half: grant, use, confirmation, guide ticker).
The horn is a vanilla `minecraft:goat_horn` carrying the marker dynamic property `ca:beacon`, named and
lored, locked to the inventory and kept on death - the same identity mechanism as the Commander's Ledger
(`ledger/item.js`). A horn rather than a compass because `ItemStack.setDynamicProperty` refuses stackable
items, and a custom item would need an item definition plus a texture in the pack.

Granted on the first spawn of each session when absent. A use runs `beaconIntent`:
no Hearthgate record -> **build** (confirmation form, then the same `runGenerate` the typed command calls);
`building`/`paused` -> **resume** (`runResume`, stored plan and queue); `complete` -> **guide** (chat readout
with centre, distance, compass point and a `/tp` line). While the horn is held, a 20-tick ticker sets the
action bar to `Hearthgate · <n>m <point>` (with `· rising` / `· paused`), so the city can be found from any
distance. Everything dangerous still goes through the command path: the one-district-at-a-time rule, the
dev gate for districts 2-5, the write guard, and the persisted queue are unchanged, and the horn writes
nothing itself.

Tests: `dev/test/beacon.test.mjs` (11 tests: identity by type+marker, slot search, stack construction,
intent matrix including guide-wins-when-busy, centre validation, bearing conventions with Minecraft's axes,
compass wrap, guide line suffixes, chat readout, confirmation copy). The Ledger's binding tests now count
`itemUse: 1` (the horn) as the baseline and `2` once the Ledger registers; `reliability-runtime.test.mjs`
expects two `playerSpawn` subscribers and three intervals (gate poll 40, horn guide 20, simulation hour),
and the server-ui rule now names both integration binding files. Verified offline: 954 manifest checks,
1213/1213 unit tests, e2e 52/52, five gates green. NOT DONE: none of this has run in Minecraft yet.

## First in-game run (2026-10-26, Minecraft 1.26.5203)
The pack was deployed with `node dev/deploy.mjs` (114 files, sha256-verified) and loaded in the existing
Creative test world "CivTest Hearthgate". **The pack loads**: `@minecraft/server` 2.7.0 and
`@minecraft/server-ui` 2.1.0 both resolved (no pack-level failure), the horn was granted on the first spawn
and appeared in hotbar slot 1, a right-click opened "Raise Hearthgate?", and confirming it started the real
`runGenerate` survey. Input note: synthetic mouse clicks land on the form's default-focused button (Cancel);
keyboard focus (`UP`, `ENTER`) selects "Build Hearthgate here", so the run was driven by keyboard.

Both site searches refused, correctly writing no blocks:
- around spawn (hills): "180 of 261 candidates: unloaded", next "52 ... steep ground"; 17,089 columns read.
- on plains at (-288, -96) after teleporting: 81/81 tiles, 4,288 chunks, **15,089 columns read, 0 unloaded**,
  then "260 of 261 candidates: unloaded"; the single readable candidate was steep (33.1% > 4%) with usable
  land 65.8% < 82.5%.

Root cause of the "unloaded" verdict, found from those two runs:
1. `planScan(anchor, 536, 8)` plans (2×67+1)² = 18,225 lattice columns, but only 15,089 were read. The
   difference (3,136 columns, 17%) was never attempted, and `stats.unloaded` stayed 0 because that counter
   only counts columns that were *attempted and unread*.
2. The unread columns belong to survey tiles that **stalled and were skipped** (`surveyTile` -> `stalledTiles`,
   silent unless three in a row or >25% abort). A 128-block tile is 64 chunks; in a fresh world they do not
   finish generating inside `holdTimeoutTicks` (60 s) × 2 attempts, so the tile is dropped and its lattice
   points stay `unloaded` for ever.
3. `rankSites` disqualifies any window with a single unknown cell (`unknown > 0`), so a 17%-hole field fails
   almost every candidate, and the refusal text then leads with "unloaded" and reads like a terrain verdict.

The offline harness cannot see any of this: `dev/lib/fakefield.mjs` answers every coordinate, so its field has
no holes and its surveys never stall. Fix candidates (not yet implemented): report skipped tiles in the
`[2/6]` line and the site refusal; retry a stalled tile after its neighbours are generated instead of dropping
it; only rank windows whose lattice lies inside fully-read tiles; and raise or make adaptive the hold timeout
for fresh terrain. The guide ticker was not exercised in game because no district record exists (the run never
reached planning).

## Fix (2026-10-26): stalled tiles are retried, and unread ground is named
`scanProgressive` now makes one bounded second pass over the tiles that stalled, after the rest of the ring
has been generated (`retriedTiles`). A tile that still refuses stays in `stalledTiles`, and `skippedColumns`
counts the lattice columns that were never read. The `[2/6]` line prints `coverageProblem(...)` whenever a
tile was skipped ("N survey tile(s) never finished loading ... M column(s) of ground were never read; every
candidate window over them is disqualified"), and the site refusal carries the same sentence, so an
incomplete survey can no longer read as a terrain verdict. Because the last ring's ranking runs before the
retry pass, `planWorld` re-ranks after a recovery (`recoveredTiles > 0`) instead of judging a completed
field on its holes. The retry attempts are not counted as extra surveyed tiles.

Offline proof (`dev/test/civ-survey.test.mjs`, 30 tests): a tile whose two attempts hang is asked for again
and its columns are recovered (`retriedTiles 1`, `recoveredTiles 256`, plan valid, no coverage line); a tile
that never loads on either pass keeps `stalledTiles 1` and `skippedColumns > 0`, the summary and the refusal
name it, and nothing is written; `coverageProblem` is unit-tested for both cases. The debug probe showed the
stale-ranking bug directly: without the re-rank a complete field was refused with "the anchor itself is
unloaded"; with it the same run produces a valid plan. All five gates green, 1215 tests.

## Second in-game attempt (2026-10-26): the 30-minute deadline is the binding limit
Re-ran the horn on the same plains spot with the fixed pack. The survey reached tile 81/81 (29 min 50 s) and
was then cancelled by the overall planning deadline: "Planning timed out - cancelled, nothing was changed -
Planning ran past its deadline of 30 min 0 s (phase 1/6 survey)." Nothing was written. In that world chunk
generation costs ~20 s per 128-block tile (64 chunks), so a full 536-block radius survey (81 tiles) cannot
finish inside 30 minutes on first-visit terrain; it needs ~27 min of tiles alone, plus the retry pass and
ranking. The deadline is therefore what stops the build, not the scan holes.

That run also revealed a world-state problem worth its own task: "CivTest Hearthgate" is the prebuilt starter
world and already holds a kingdom (5 districts, 1590 civilians, 227 soldiers: Hearthgate, Ironquarry,
Whitetorn, Saltmere, Ashfall) with 10-11 active construction projects. It ships district records but no
master plan, so a new `civ:generate` searches for a site instead of refusing or resuming. The horn and the
command therefore need a populated-world policy (resume / extend / refuse), and end-to-end build proof needs
a world with no district records.

## Fix (2026-10-26): "no progress", and any terrain

**Why it showed no progress.** `scanProgressive` evaluated candidate windows only after a whole ring: the first
ring is a 340-block square = 36 tiles, so the first possible "site found" message came after ~12 minutes at the
in-game 20 s/tile, and the heartbeat said `tile 0/81` until the first tile finished. With the old land vetoes
(82.5% usable, ≤4% steep, ≤12% water, 0 lava) a mountain or ocean start qualified nowhere, so the scan ran all 81
tiles and was cancelled by the 30-minute planning deadline — the user-visible result was "it just sits there".

**Fix: evaluate every tile, and never guess.**
- `scanProgressive` calls `evaluate` after every tile with `knownHalf`, the largest square centred on the anchor
  that is covered by tiles that actually loaded (world-aligned tile rectangles, so it is exact; a stalled tile is
  removed from the set). `planWorld` only ranks within `knownHalf - window/2 - 2*step`, so the early stop cannot
  miss a closer window. A site is announced the moment it appears
  (`suitable terrain N blocks away; confirming the rest of its window before stopping`), and the chat heartbeat now
  names the tile being read and the columns read. In the fake world the survey now stops at 36 of 100 tiles and can
  stop mid-ring; `rings` can legitimately be 0 because no full ring was needed.
- The heartbeat no longer says "no progress for …" while `chunksPending > 0`: a hold that is generating chunks is
  working. The stall detector and its 3-minute cancel are unchanged (a hold that never loads is still stalled).

**Any terrain, adapted to - not flattened.** Site selection no longer treats terrain as a land-use veto. A window's
*preparable* columns are land + water + steep ground (water costs a deck block per column, steep ground two support
blocks per column); only lava, blocked (cave/foreign) and unread columns are excluded. Lava is still a hard refusal
because the write side does not build on it. Water the window ENCLOSES (a lake or inland bay: >12% of the window
with less than 20% of its border under water) is refused with a reason - the districts would have to claim it, which
the solid-region and area contract cannot hold - and the survey picks a nearby dry, coastal or open-sea window. The
ranked site yields a `TerrainPolicy` (a pure function of the window): `allowWater` when the window holds any water,
`adaptive` when it is wet or rough, `maxRelief 16` when the old 4% steep cap would have rejected it. The policy is
stored in the master plan and in every district's persisted site options, so a resume replans byte-identically. A
window the old rules accepted keeps the old numbers, and a land plan's options object is unchanged - the
five-district golden snapshots still match.

Downstream, on a rough or wet site nothing is levelled and nothing is drained:
- `planDeck` (civ/foundations.js) replaces the pad for such lots (ground relief under the lot > 3, or any water):
  ONE flat deck at a level near the street, cut only on the uphill side (max 16, the deepest levelling tier the old
  planner tried), carried by pillars down to the natural ground - or, over water, down to the sea bed (max 64).
  Nothing is filled, so the water stays beside and under the deck. The apron carries half-step slabs where the
  ground is one lower, stairs where it is one higher, and railings wherever the drop is two or more (water
  included). `planDeckSteps` is its budgeted twin (it calls the same function), and `tryPadAt` tries the nearest
  street level first, then alternates above/below within the door lane's reach.
- Door lanes and lots accept water (`isBuildable`). A lane over water is a pier: `surfaceOps` writes a deck on a
  pillar down to the bed at every water cell instead of a trench of fills, and the approach profile is pinned to the
  water surface (not the bed) so the walker stays dry.
- Streets cross water with a bridge when a straight one fits, else with a pier deck: a deck at the highest surface of
  the span, pillars every 6 cells down to the bed, railings on the outer edges (`pierOpsFor`). The old capped
  causeway (which filled the sea) is gone. A road's dry shoulder is only filled over land (`G.isLand`).
- A district's own roads are clipped to its own plan labels (a link is not clipped), which is the containment
  contract the runtime checks; on land this filters nothing.
- The write guard lets additive kinds stand in still water (`fill`, `pad`, footing, wall/tower/merlon/walk/rubble/
  gate, road/stair/deck/bridge/pillar/rail/retain). A `cut` or `clear` still refuses to remove water, and a player's
  block is still protected.

**Survey: the sea bed is now read.** A pier needs the floor under the water, so `terrainScan.readColumn` accepts
`{ bed: true }` (used only by the civ survey): under still water it keeps walking to the natural ground and reports
`surface` and `bed`. `cellFromColumn` returns `g = bed` plus `surface`, the full-resolution field keeps a water
plane (`makeGridField({ water: true })`), and the frozen ground format gains an optional `s` stream: one rice-coded
residual per water column (nothing for land), so a sea district's ground stays small (a 253x329 sea region: 263,697
-> 27,879 bytes of JSON with the surface stream included). A region without water omits `s`, so land plans remain
byte-identical.

Offline proof: `dev/test/civ-reclaim.test.mjs` (13 tests: policy thresholds, ocean and cliff sites, lava refusal,
deck-on-pillars parity and refusals, a slope deck that cuts only uphill, water-surface ground round-trip, master plan
on the sea with and without `allowWater`, a full sea district whose lots are decks with `padPillars > 0`, zero fills
at/above the surface and identical rehydration, unchanged land options, a mountainside district on pillars with clean
containment) and `dev/test/civ-reclaim-runtime.test.mjs` (3 tests through the production runtime: an all-sea world is
surveyed and planned, a full `civ:generate` completes with no skipped water op, and the write guard's water matrix).
The survey now stops at 64 of 100 tiles on that world and the district plan is stored at 46,447 / 120,000 bytes.

In-game caveats: a sea district is a deck city on piles, not a drained seabed; pillars reach the scanned floor (a
column deeper than 64 blocks is refused, never guessed). The read walk is bounded by `MAX_WALK` (96 cells from the
topmost block), so an abyss deeper than that is planned without pillars. Lava, unread ground and protected blocks
still refuse, as before.

## In-game proof (2026-10-26): one command built a whole district in ~15 minutes

Ran the Horn of Hearthgate in "CivTest Hearthgate" (the prebuilt starter save: simulation step 746, seed 20261017,
5 districts, 1590 civilians, 227 soldiers, 14 construction projects) at 16:48 local time, anchored at
(-192, -448). The survey stopped early at its certified site instead of reading all 81 tiles, the run passed
through phases 5/6 and 6/6, and `civ:generate_status` afterwards reported:

    district-1 Hearthgate: complete, stage complete 52188 / 52188 ops, placed 47827, skipped 4903,
    centre -187, -621, plan 214bbd16
    Stored queue: 100 (52188 / 52188 ops), state complete
    Storage: civ:plan 22503 B, civ:plansite:d1 32454 B, civ:jobs 1982 B; total 56939 B (every family inside its
    budget)
    No job running.

The run's own estimate before building was "~52188 block operations ... estimated minutes 14.9"; the wall clock
from the horn confirmation to `complete` was ~14.8 minutes (survey + planning + build), so the estimate now holds
in game. The 3-minute false-stall cancel from the first attempt did not recur: the stall clock is measured per
hold attempt (commit 5ea1fbe), and each hold that was generating chunks unblocked when the player was teleported
onto the tile's centre (a 128-block tile is 64 chunks; a ticking area alone did not finish them inside 60 s even
with the game's 640-block (40-chunk) render distance). Building skipped 4903 of 52188 ops (9.4%: occupied cells
and trees) with `failed 0`; no op was cancelled.

Live evidence: `scratch/district-complete-status-2026-10-26.png` (the status lines above) and
`scratch/district-built-2026-10-26.png` (the crenellated wall, towers, piers and streets around the bay at
-187, -621). The build is a coastal city on decks and piers, not a flattened site.

## Populated worlds: a new site search is now a deliberate choice

The same run demonstrated the world-state problem recorded above: the starter world held a running kingdom but
no physical district plan, so `civ:generate` started a 10-30 minute site search in a world that was already being
played. `runGenerate` now refuses that default when the kingdom is populated (`populatedKingdom`: simulation
step > 0, or any district holding construction projects) and no master plan is stored, before reserving a job or
touching a block. The refusal reports the kingdom (districts, civilians, soldiers, active projects, step), says
that the build would add a NEW physical site and leave the kingdom's population, projects and territory as they
are, and names the two deliberate routes: the Horn of Hearthgate (its confirmation form is the acknowledgement)
or `site=here` (build exactly where the player stands). The horn passes `confirmed = true` to `runGenerate`, so
its form keeps the search behaviour it describes; a confirmed or `site=here` run prints the same kingdom summary
as a note in its start message. Worlds at step 0 (dedicated test worlds), builds from a stored master plan
(extend) and `civ:generate_resume` (resume) are unchanged.

Offline proof (`dev/test/civ-runtime.test.mjs`): the predicate (fresh / ticked / project-only), a populated world
refused with zero writes, no job and no district record, the refusal naming both routes, and the confirmed call
starting the identical run and aborting cleanly. All five verify gates green, 1236 offline tests, e2e 52/52,
template spec ok.
