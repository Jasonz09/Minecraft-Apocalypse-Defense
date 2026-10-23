# Future development roadmap (requirements recorded 2026-10-18)

Status: design requirements only. Nothing in this file is implemented. The current milestone is the enlarged
Hearthgate (see `CIVILIZATION_PLAN_DESIGN.md`, `QWEN_HANDOFF.md`, `MINECRAFT_INTEGRATION.md`); it is not interrupted
by this list. Every milestone below must be tested in Minecraft before the next one scales it up.

## Development order
1. Finish and test the enlarged Hearthgate (in progress).
2. Complete the five physical fortified districts (master plan already covers all five; construction is gated).
3. Add visible civilians and military units in ONE district.
4. Implement physical combat and a controlled zombie invasion.
5. Connect evacuation, reinforcements and gate behaviour to the physical world.
6. Expand physical NPC behaviour across the whole kingdom.
7. Recurring invasions, counteroffensives and autonomous territorial expansion.
The finished experience begins with an already functioning, populated civilization in a normal Minecraft world.

## A. Physical civilization population
The starting kingdom has 400 civilian villagers and 150 villager soldiers over five districts. They must become visible
entities that stay synchronised with the persistent simulated records (the records remain authoritative).
- Civilians: occupations, routines, movement; homes and workplaces; farming and resource transport.
- Soldiers: equipment, patrols, training, defensive behaviour; commanders controlling groups; iron golems and trained
  wolves supporting the army.
- Automatic recruitment and population growth (existing `population.js` rules drive it); evacuation behaviour in emergencies.
- Performance: a level-of-detail representation. Never spawn all 550 entities with full AI at once. Only nearby/active
  units are physical (bounded count per loaded area); distant units stay purely simulated and are materialised/dematerialised
  on demand. Each physical entity carries a persistent id tied to a simulation record (tag/dynamic property) so loading,
  unloading, crashes and restarts can neither duplicate nor lose population; reconciliation runs on load.
- Constraints to design for: bounded spawns per tick, loaded-chunk checks, entity cap per district, despawn safety
  (never kill a unit because a chunk unloaded), deterministic mapping record <-> entity.

## B. Physical zombie invasion system
A staged invasion director connected to `sim/war.js` (not a separate combat system): physical outcomes must update the
existing kingdom records (assault, integrity, casualties, security state, gate state, reinforcements).
- Periodic hostile activity plus major invasion stages; scout warnings before large attacks; variable attack directions and
  compositions; zombie groups approaching from outside district walls; attacks on gates and designated wall sections.
- Automatic military response and reinforcement; sirens and civilian evacuation after breaches; soldiers defend and
  retreat gradually only when necessary; counterattacks, recovery, territory reclamation after appropriate victories.
- Bounded spawning (never an army in one tick), loaded-chunk checks, persistence of wave state, distance-based simulation
  (far groups advance as numbers, near groups as entities).
- Difficulty: challenging but recoverable.

## C. Known balance problem (ADDRESSED offline - see SIEGE_BALANCE.md)

Status: fixed in commit 8810ef9. Under default defence 0 of 16 seeds end with all districts lost (baseline 16 of 16). The
change is an engaged attrition floor, a defender loss rate of 0.03, and a minimum wall crew of 2. The difficulty is still a
judgement call that needs playtesting in Minecraft. The original analysis follows.
The audit found a long-term siege deadlock in the simulation: over about 1,000 default-seed steps (about 40+ in-game
days) every district can end in the `lost` state. Mechanism (see `docs/MINECRAFT_INTEGRATION.md`, known limits): attacker
losses round to zero for bands of 1-2 raiders (`war.js`), the counterattack needs 1.5x strength, repairs are blocked while
an assault is active, construction cannot work in a `lost` district and no new threats spawn there. Investigate with the
deterministic scenario harness (`dev/probe-autonomy.mjs`, `dev/e2e-kingdom.mjs`), fix so a defended kingdom can recover,
and add long-horizon regression tests (multi-thousand-step runs must not end with all districts lost under balanced
defence) BEFORE the invasion director is tuned.

## Open questions to settle when each milestone starts
Entity types and tagging scheme for persistent identity; how villager professions map to the job/stage model; whether
iron golems and wolves are simulated records or derived from barracks capacity; siren mechanism (sound + particles
within stable APIs); LOD distances and per-player entity budgets.
