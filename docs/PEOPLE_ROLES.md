# People roles: pure models for visible population behaviour

Status: pure logic only. Nothing in this document spawns an entity, reads the world, or changes the
simulation. Every module lives in `CivilizationApocalypse_BP/scripts/people/` and imports nothing from
`@minecraft/server`. The records remain authoritative; these models describe what each visible unit
should be doing, derived from those records. Roadmap section A ([ROADMAP.md](ROADMAP.md)) is the requirement.

## Input shape: `PeopleDistrict`

Every model takes a real district record (`kingdom.districts[i]`, built by `makeDistrict()` in
`kingdom/state.js`). The fields read are:

| Field | Used by |
| --- | --- |
| `id`, `name`, `security` | all; `lost` turns every model off |
| `civilians`, `soldiers`, `builders`, `trainingQueue`, `trainingBuffer` | occupations, training, equipment, patrols, commanders |
| `garrison { front, reserve }` | patrols, commanders, support (engagement needs `front > 0`) |
| `reserves { food, materials, supplies }` | transport, equipment, support |
| `buildings { homes, farms, storehouses, barracks, walls }` | occupations (crews), transport (farm output, store ceiling), training (barracks), equipment (tiers), support (caps) |
| `gates [{ id, with, state }]` | patrols (route stops) |
| `assault` | support (engagement) |

Missing numbers read as 0 and a missing `security` reads as `secure`. Support records are a separate
object the caller keeps: `{ golems, wolves, lastGolemStep, lastWolfStep }`. Equipped tiers are a separate
record too: `{ 0, 1, 2, 3 }` soldier counts (see the equipment caveat below). Nothing in these models
needs a field the save does not already have, except those two records.

## Modules

| Module | Purpose | Main exports |
| --- | --- | --- |
| `occupations.js` | Assigns every civilian a role: builder, farmer, guard, worker, smith, none, child, elder. Lists unfilled posts. | `assignOccupations`, `occupationNeeds`, `occupationProblems`, `ROLES`, `OCCUPATION_RULES` |
| `routines.js` | Maps the game hour (`sim/clock.js` `hourOf(step)`) to exactly one location class. | `locationAt`, `dailySchedule`, `hoursPerLocation`, `LOCATIONS`, `ROUTINE_RULES` |
| `transport.js` | Plans food haul jobs (farm to storehouse, storehouse to consumers). Plans only; creates no food. | `planHaulJobs`, `applyHaulPlan`, `haulConservation`, `TRANSPORT_RULES` |
| `patrols.js` | Builds the wall circuit (gates and wall sections) and rotates patrol groups around it. | `planPatrols`, `coverageOverCycle`, `wallCircuit`, `PATROL_RULES` |
| `training.js` | Projects one training step: graduates, banked readiness, stage and the tier a graduate leaves with. | `projectTraining`, `graduateKit` |
| `command.js` | One commander per 10 soldiers, posted front or reserve, with an error state for a commander without soldiers. | `assignCommanders`, `commandersFor`, `commandProblems`, `COMMAND_RULES` |
| `equipment.js` | Equipment tiers 0 to 3, paid from materials and supplies within a per-step share of the stores. | `planEquipment`, `tierCounts`, `maxTierFor`, `EQUIPMENT_TIERS`, `EQUIPMENT_RULES` |
| `support.js` | Iron golems and trained wolves: caps from barracks, spawn budget, engagement with garrison, losses and replacement. | `supportCaps`, `spawnBudget`, `spendSupport`, `engageSupport`, `wolfFoodDemand`, `SUPPORT_RULES` |

## Rules and numbers

**Occupations.** Children are 25% and elders 10% of the civilian pool (no ages in the save, so this is a
plan parameter). Builders are reserved from the adult pool first. Crews: 3 farmers per farm, 2 workers and
1 smith per storehouse, 1 armourer per barracks, 2 guards per wall and 1 per barracks. Priority is farmers,
then guards, workers, smiths; under `contested`, `breached` or `isolated` the guards come first. Adults left
over are `none`. Starting district (80 civilians): 20 children, 8 elders, 12 farmers, 3 guards, 6 workers,
4 smiths, 27 idle, nothing unfilled.

**Routines** (hour of day). Guards are always at the barracks. Under `contested`, `breached` or `isolated`
every other civilian is in `shelter` for all 24 hours. Otherwise: sleep at home 22:00 to 05:59; meals at
07:00 and 18:00 at home; noon meal at 12:00 (market for working adults, home for children and elders); work
08:00 to 16:59 (farmers at the farm, idle adults at the market, others at `work`); evening rest at home.
`lost` returns `location: null`.

**Transport.** Planned from `farmFoodOutput` (nominal, before the yield jitter) and `district.reserves.food`,
with the store ceiling `stockpileCeiling` from `sim/policies.js` (max of 200 and 250 per storehouse). At most
8 jobs per district per step, 2 food per job, so at most 16 food planned per district per step. Stage one
moves farm output into the store while there is room; stage two delivers up to today's demand from the store.

**Patrols.** Eight wall sections by default (`<id>/wall-01` to `wall-08`, or ids supplied by the caller).
Gates are inserted just before evenly spaced sections in the order the district lists them. Groups have about
4 soldiers from `garrison.front`; there is one sector per group, so every section is watched at every step.
Groups rotate sector every 4 steps, so one cycle is `groups * 4` steps (24 steps for the starting district).

**Training.** Same arithmetic as `population.advanceTraining`: `barracks * 0.25` recruits per step banked
fractionally. Graduates come only from `trainingQueue`. A graduate leaves at tier 1. `lost` trains nobody.

**Command.** `commandersFor(soldiers) = max(1, floor(soldiers / 10))`, or 0 with no soldiers. The starting
district (30 soldiers, 24 front, 6 reserve) has 3 commanders: 2 front, 1 reserve. A commander with no soldiers,
or filed under another district, is an error state. A lost district has no command structure.

**Equipment.** Tier 0 militia; tier 1 spear and shield (issued at enlistment, assumed for the starting
garrison); tier 2 mail (4 materials, 2 supplies per soldier, needs 1 barracks); tier 3 iron (8 materials,
3 supplies, needs 2 barracks). One upgrade per barracks per step. A district may spend at most 25% of its
current materials and supplies per step. Upgrades go lowest tier first.

**Support.** Caps: 1 golem and 2 wolves per barracks. The starting kingdom therefore holds at most 5 golems
and 10 wolves. Golem costs 30 materials and 6 supplies, cooldown 24 steps. Wolf costs 4 supplies and 2 food,
cooldown 12 steps. At most one of each per district per step. A golem holds back 8 raiders in a step, a wolf
12. Garrison-equivalent strength: golem 4, wolf 1. Each engaged unit is lost with probability 0.15 (golem) or
0.10 (wolf) per step, drawn from an explicit cursor so the same seed gives the same losses. Engagement needs
`garrison.front > 0`. A lost district keeps its units frozen on the record, makes nothing and fights nothing.

## Invariants and where they are checked

| Invariant | Evidence |
| --- | --- |
| Roles add up to the civilian pool; farmers never exceed farm capacity | `occupationProblems`; `people-roles-occupations.test.mjs` |
| Each hour of each role has exactly one location class (none when lost) | `people-roles-routines.test.mjs` |
| Haul jobs move food, never create it; food from fields does not exceed farm output; delivery does not exceed demand | `haulConservation` delta 0; `people-roles-conservation.test.mjs`; `people-roles-longrun.test.mjs` |
| Haul jobs are bounded: 8 per district per step, 2 food each | `people-roles-caps.test.mjs` |
| A haul plan does not change the simulation's food accounting | `people-roles-conservation.test.mjs` (population report and records identical) |
| Equipment never creates or loses a soldier; stores never negative; spend within 25% per step | `people-roles-conservation.test.mjs`; `people-roles-longrun.test.mjs` |
| Materials and supplies spent exactly as the declared cost | `people-roles-conservation.test.mjs` |
| Training projection equals `population.advanceTraining` (graduates, queue, buffer) over a grid | `people-roles-conservation.test.mjs` |
| Soldiers come only from the queue; trainees only from enlistment | projection tests; `people-roles-longrun.test.mjs` |
| Commanders equal `max(1, floor(soldiers/10))`, every commander leads at least one soldier | `people-roles-caps.test.mjs` (0 to 80 soldiers, four splits); `commandProblems` each step in the long run |
| Patrol coverage: every section watched at every step; every group walks every sector per cycle | `people-roles-patrol.test.mjs` |
| Golems and wolves never above cap; cooldown respected; kingdom holds 5 golems and 10 wolves | `people-roles-caps.test.mjs`; `people-roles-longrun.test.mjs` |
| Support engages only with a garrison; losses never exceed engagement | `people-roles-caps.test.mjs` |
| Lost district: no people, routines, haul, patrol, training, command, equipment or support; record unchanged | `people-roles-lost.test.mjs`, including inside a real step loop |
| Deterministic, pure, no `@minecraft` import, no imports of files owned elsewhere | `people-roles-determinism.test.mjs` |
| 500 real steps (`advanceKingdomStep`, with real recruitment): every model holds at every step; the run is reproducible | `people-roles-longrun.test.mjs` |

## Test files

`dev/test/people-roles-*.test.mjs`: `routines`, `occupations`, `patrol`, `conservation`, `caps`, `lost`,
`longrun`, `determinism`. Run `node --test dev/test/people-roles-*.test.mjs`.

## Patches needed outside this module (not made here)

These are for the integrator. None of these files were edited.

1. `sim/population.js` `foodDemand`: add `wolfFoodDemand(support)` from `support.js`, or wolves eat for free.
2. `sim/war.js` `defensiveStrength` or `resolveAssault`: add `engageSupport(...).supportStrength` to the
   garrison-equivalent strength, or golems and wolves never change an assault.
3. `kingdom/state.js`: optional saved records `support` and `equipment` per district (`findValidationProblems`
   ignores unknown fields, so adding them is safe). Until then, supports start at zero and tiers are assumed.
4. Observed, not changed: `population.js` `eligibleRecruits` and `policies.js` `workGangs` subtract
   `trainingQueue` from `civilians`, but `openRecruitment` has already moved trainees out of `civilians`. The
   queue is therefore counted twice, which under-counts recruits and work gangs while a queue is open.
5. `scripts/people/*` is packed with the behaviour pack but nothing in `main.js` imports it, so it has no runtime effect.

## Unverified in the game

Everything above is arithmetic over saved records. Not verified and not claimed:

- pathing between locations, walking speed, crowding, and whether 500 entities can move without lag;
- whether the locations exist in the built districts: `civ/zoning.js` names market squares and trade frontages, a barracks quarter and farm fields, but no shelter zone, and storage is the closest thing to `work`; `shelter` is not yet placed anywhere;
- animations, villager profession mapping, and whether a farmer actually changes what a farm yields (the sim
  does not depend on farmers, so it does not);
- golem and wolf combat numbers against zombies, golem health, and whether wolves can be tamed or trained in
  Minecraft as modelled;
- the 25% and 10% child and elder shares, which are plan values and not observed from the game;
- persistent entity identity, reconciliation on load, and the level-of-detail budget (other modules).
