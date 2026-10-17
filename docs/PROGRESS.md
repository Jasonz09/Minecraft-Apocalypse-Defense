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
  run. It stays behind `civ:debug:build enable` + an explicit anchor.
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
