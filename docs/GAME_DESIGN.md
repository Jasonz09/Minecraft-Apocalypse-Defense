# Game design — as implemented

Everything below is saved simulation state. **No civilian, soldier, golem or wolf entity is
spawned anywhere in this build**, and no city is generated. Iron golems, wolves, real
models, combat and NPC AI are future milestones named in the brief, not features here.

## The kingdom

Five fortified districts — Hearthgate, Ironquarry, Whitethorn, Saltmere, Ashfall — starting
with **400 civilians and 150 soldiers**, split evenly (80 / 30 each). The realm begins fully
established: every district starts at `defensiveIntegrity 100`, with walls, homes, farms,
storehouses and barracks already counted as buildings, and stores of food 240 / materials
180 / supplies 120.

Each district tracks: population and shelter capacity, refugees sheltering there, an
assigned garrison split into `front` / `reserve`, a training queue, food/materials/supplies
stores, defensive integrity, a security state, connected neighbours and gates, and its own
list of staged construction projects. Totals are always **derived** from the districts
(`computeTotals`) so a save can never disagree with itself.

## Rules and where they are enforced

| Rule | Enforcement |
| --- | --- |
| Neighbouring districts reinforce automatically, without abandoning their own walls | `war.requestReinforcements` caps each donor at `policy.reinforcementKeepFraction` of its *home strength* (present troops + troops already away), and records the deficit honestly |
| Soldiers keep defending; withdrawal is gradual | `war.updateFallback` advances a per-district `pullback` (0 → 0.6, ±0.2/0.1 per step) that `assignDefenders` applies to the wall/reserve split; while giving ground at least one soldier stays on the wall, the population does not move, and walls are not demolished. `war.resolveAssault` chips integrity per step; `recoverAfterDefense` repairs with materials and walks security back down the ladder |
| A breached wall is not a capture | `lost` requires `policy.fallAfterSiegeSteps` consecutive breached steps **with no able defenders**; the district record, its walls and its population survive being taken |
| Civilians evacuate | `evacuation.runEvacuationStep` moves up to `MAX_EVACUEES_PER_STEP` per step down an open gate to a neighbour that is safe and has room |
| Evacuation cannot exceed shelter or enter unsafe land | occupancy is shared: `civilians + refugees <= civilianCapacity`, enforced by the save validator and by `kingdom/state.js` `districtOccupancy`/`districtHeadroom`; growth is capped by the same room |
| Blocked routes are handled | sealed or broken gates make a district `isolated`; when nowhere qualifies, people shelter in place and the event says why |
| Gates isolate logically, never destroy walls | `evacuation.setGateState` changes a gate's state only; `defensiveIntegrity` and `buildings.walls` are untouched |
| Counterattack once reinforced | `war.counterattack` engages when defenders outnumber attackers |
| District walls are permanent | `construction.removeProject`/`cancelProject` refuse `permanent: true` kinds; nothing in the tick loop can lower a wall count |
| Expansion needs an outside victory first | `territory` land starts `wild`; only `recordExternalVictory` can open it |
| Balanced automatic expansion | victory → `raided` → `policies.runExpansionPolicy` establishes military control → upkeep is paid each step → `expansion.evaluateExpansion` must pass → `runExpansionStep` claims it |
| Expansion can be refused | `evaluateExpansion` returns `{eligible, reasons[]}`: security, integrity floor, surplus field army versus the land's garrison requirement, stores for the first stage of every planned project (×1.25 margin when `balanced`), and shelter headroom for the settlers |
| Existing walls are never removed by building | claims and construction only ever add; `expansion.runExpansionStep` refuses when `paused` |
| Growth depends on housing, food, capacity, safety | `population.runPopulationStep` grows toward remaining shelter only with food and `security: secure`, and states the reason it stopped |
| Recruitment respects limits and suspends | `population.openRecruitment` rejects non-integers, negatives and over-population enlistment; the queue cannot exceed capacity; a shortage or an emergency halts it |
| Builders develop secured land | `policies.nextDevelopmentWork` schedules farms/homes/storehouses/barracks when the district actually needs them, and will not schedule what it cannot pay for |

## Policy modes

`civ:policy balanced|paused|rapid`. `balanced` is the default and demands the full surplus
margins; `rapid` relaxes the resource margin but **never** the security checks; `paused`
blocks occupation and claims outright.

## Time and pace

One simulation step is one in-game hour (24 steps to a Minecraft day). The step runs on a
1000-tick interval, never per game tick, and catch-up is clamped to `SIM.maxCatchUpSteps`.

## Deliberately not designed yet

Physical city generation, entity spawning of any kind, melee combat resolution against real
mobs, player-controlled building, multiple kingdoms, UI screens, and any AI for named
characters. The demo build adapter places blocks only when explicitly opted in — see
`docs/TESTING.md`.
