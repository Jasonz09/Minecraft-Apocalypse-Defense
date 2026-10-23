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
`npm run verify` runs four gates: manifest/packaging (**231 checks**), strict `checkJs`
typecheck against `@minecraft/server` 2.7.0 (**0 errors**), unit tests (**148 across 10
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
district is 58k-75k block operations (331,961 total; 2,491 write-phase slices). `civ:generate` takes `district=` and
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
"is built" and status `complete`; 266,473 blocks written, 1,912,722 reads across 27,011 slices, zero ticking areas left,
zero area violations; 4,036 / 3,970 / 1,041 / 8,623 operations refused for standing in a finished neighbour's land;
afterward the save holds 155,697 B of plan in 13 keys, 11,029 B of queues in 10 keys, a 6,611-character kingdom blob
whose five `district.civ` pointers total 1,546 B, and 15 registered gates. New offline coverage:
`dev/test/civ-fivedistrict.test.mjs` (14 tests: sealed separation on the wall+gate barrier built from the records,
exterior cannot reach any interior, one connected road network crossing between districts only at gate passages, the
write guard's effect on the line that actually gets built, shared walls planned by both neighbours, role identity and
the siting registry, spacing/density, per-district budgets, determinism) plus 7 runtime tests (crash-and-restart
equivalence, per-district persistence and independent wipes, refusal while a neighbour builds, legacy single-slot
worlds still resume). Suite 745 tests, five verify gates green. District 1's checksum is pinned unchanged
(`53c81775`), so existing Hearthgate saves are untouched. NOT DONE: nothing has been built in Minecraft; the wall
stage's own reported column count exceeds the columns its operations cover by 179 at seed 21 (260 on flat ground) -
sound, but to be closed in `civ/walls.js`, which moves district 1's checksum, so it is scheduled rather than slipped;
the 14 registry kinds (`orchard`, `customs_yard`, `command_hall`, `stable`, `drill_ground`, `mill`, `market_square`,
`pen`, `shop`, `garden`, `warehouse`, `barracks`, `farm_veg`, `farm_kitchen`) cannot always be sited, which is capacity,
not honesty; and the shared band's duplicate ownership is the root cause the wall-versus-clearance rule works around
(dev task 27). `template:release-check` exits 1 and `--zip` stays refused until all five are built and verified in
game. See FIVE_DISTRICT_BUILD.md, CIVILIZATION_PLAN_DESIGN.md, STARTER_WORLD.md.

## Goal pass (offline)
- Siege balance: fix parked on branch siege-balance-candidate (8810ef9), NOT on master: it changed existing test expectations. Needs playtesting and explicit approval before merge.
- Districts 2-5 on the Hearthgate path, behind civ_devgate; golden keeps Hearthgate unchanged (FIVE_DISTRICT_BUILD.md).
- Invasion director: built, disabled, tick no-op (INVASION_DIRECTOR.md).
- Population LOD: built, spawning disabled, unwired (POPULATION_LOD.md).
- Commander's Ledger: presenters and runtime committed and tested; wiring and manifest dependency reverted (unwired).
- Reverts on master: Ledger wiring (6e24380), manifest dependency (5026111), siege balance (8810ef9). Original tests restored; full verify 1177/1177 at 5fff901.
