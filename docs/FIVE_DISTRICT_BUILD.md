# Building the five-district civilization once, in a dedicated world

Status: everything below is implemented and verified **offline against a fake Bedrock world**. Nothing
has been run inside Minecraft, and no `.mctemplate` exists. `npm run template:release-check` exits
nonzero until all five districts are physically built and verified in game, and the packager refuses
`--zip` while it does. That refusal is the design, not a failure to work around.

## 1. What changed in the model

`civ:generate_plan` used to plan the whole civilization and then build Hearthgate only, with a single
plan slot and a single job queue. Now:

* The **master plan** (five irregular districts, shared walls, gates, roads, evacuation and
  reinforcement routes) is planned once, validated once, and stored once.
* Each district gets **its own site payload** (its persisted ground, options and checksum) and **its
  own resumable queue**, so five districts fit the size budgets instead of overwriting each other.
  Site slots are `PLAN_PREFIX` + a `site:dN` segment, queue slots are `JOB_PREFIX` + a `dN` segment -
  built by concatenation in `integration/civBuilder.js`, and deliberately not spelled out as a literal
  here because the repo-wide "no two-colon `civ:` id" guard scans docs too. District 1 still reads the
  old single-slot layout, so a world saved before this change resumes unchanged.
* Districts 2-5 are buildable. The old development gate no longer means "not implemented"; it still
  refuses nonsense, and `districts=` (plural) is refused with a reason.

## 2. Command grammar

| command | arguments | effect |
| --- | --- | --- |
| `civ:generate_plan` | `[district=1-5]` `[site=here]` `[radius=24-400]` `[seed=N]` | read-only: survey, master plan, site plan, validation, estimates. `district=all` gives the cheap whole-civilization overview from the stored plan - it reads no terrain |
| `civ:generate` | `[district=1-5]` `[site=here]` `[radius=…]` `[seed=N]` | plans if needed, stores everything, then builds that one district |
| `civ:generate_status` | none | all five districts: status, stage, placed/skipped, ops/opsTotal, centre coordinates |
| `civ:generate_resume` | `[district=1-5]` | continues the district that is building (or the named one) after an abort, a crash or a Minecraft restart |
| `civ:generate_abort` | `[district=1-5]` | stops cleanly; blocks already placed stay, the queue keeps its cursor |
| `civ:generate_diag` | none | survey/tile/chunk/timing diagnostics |
| `civ:generate_devgate` | `on` / `off` | the development flag for privileged build privileges; refuses any other value |

Omitting `district=` means district 1, so the previous single-district usage is unchanged.

## 3. The sequence

Do this in a **new** world (normal generator, cheats on, pack attached). Never a world you care about:
generation writes blocks, and the safety model can only protect blocks it can prove are not natural
terrain - a player build made entirely of dirt, stone or sand is indistinguishable from ground.

1. Stand where you want the capital, outdoors, with open land around you.
2. `civ:generate_plan site=here` - read-only. Read the site, the district areas, compactness and bbox
   fill, the wall/gate/road counts, the estimated operations and the stored sizes. If it reports
   "Facilities NOT sited", that is a real shortfall (named in the notes), not a warning to ignore.
3. `civ:generate site=here` - builds district 1. One invocation authorises the whole build; it never
   starts on world load or pack activation.
4. `civ:generate_status` - expect district 1 `complete` and the other four `unbuilt`.
5. Then districts 2, 3, 4, 5 in that order (`civ:generate district=2` …). The neighbour ring is
   1-2-3-4-5-1, so each district is built next to one that already exists. Each one surveys only its
   own region; nothing re-scans distant terrain, because the master plan is already stored.
6. If a build stops (crash, quit, unloaded chunks), run `civ:generate_resume` - it reloads the plan
   and the ground from the property store, verifies the checksum against the district's own record,
   and continues. It refuses, without writing, on a checksum mismatch, a site-version mismatch, a
   corrupt ground, or a queue that belongs to another district.

Shared walls are planned by **both** neighbours, so whichever district is built first lays the wall and
the second one fills in the columns the first left empty. Nothing in this path removes a neighbour's
masonry: writes are place-only, and a block the earlier district placed is skipped as occupied. Each
finished district's footprint, grown by four blocks, is closed to the next one (`WRITE_PROTECT_GROW`),
with exactly one exception - a district may lay its **own wall** on a column in that clearance that the
neighbour left empty, because the wall band is shared land and the clearance covers it. Measured on all
five districts over rough and flat ground, a finished district's masonry reaches exactly 3 blocks past
its own outline, which is why the clearance is 4 and not less; without the exception the clearance ate
62 of the 11,465 planned barrier columns (all of them in the second district's wall) and every district
raised after the capital lost its enclosure - their deep interiors became walkable from outside, and
from each other. `dev/test/civ-fivedistrict.test.mjs` pins both halves: the line that gets built equals
the line that was planned, and no write lands on a finished district's own land. Making the clearance
wider is not a fix: at 10 blocks it suppresses 1,581 of the district's own building operations and 3,133
road operations on land nobody had built on.

## 4. Measured cost (offline, synthetic terrain, reference plan seed 21 - an estimate, not a prediction)

| district | role | enclosed columns | ops | build slices | full-resolution survey | worst-case chunks |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Hearthgate | command | 40,400 | 75,155 | 564 | 96,673 columns | 576 |
| 2 Ironquarry | industrial | 35,200 | 58,261 | 437 | 73,920 columns | 576 |
| 3 Whitethorn | agricultural | 38,208 | 67,182 | 504 | 86,609 columns | 576 |
| 4 Saltmere | commercial | 40,112 | 65,967 | 495 | 87,912 columns | 576 |
| 5 Ashfall | residential | 37,792 | 65,396 | 491 | 80,085 columns | 576 |
| total | | 191,712 | 331,961 | 2,491 | 425,199 columns | bounded per district |

The slices column is `describePlan`'s own basis - `ceil(ops x 3 / 400)` for the write phase (stage ends,
chunk holds and tree clearing make real windows about three times the ideal), one slice per tick assumed.
`civ:generate_status` adds the survey and planning slices on top when it has measured them. At 20 ticks/s
that is roughly two minutes of write work per district **if** the engine grants a slice every tick - the
first in-game run must measure the real number and replace this paragraph.

Storage as measured in the fake world (its own seed, `civ:generate_plan site=here` then one build): master
plan 20,764 B in 2 property keys, one district's site payload 27,537 B in 2 keys, that district's queue
2,155 B in 2 keys - 48,091 B of the 120,000 B plan budget, nothing above 30,000 characters in a key
(engine limit 32,767). Offline at the reference plan seed the five site records are 66,376-85,810 B each
(budget 120,000) and their queues 2,068-2,745 B in 219-299 job elements, 13-17% of the 16,000 B queue
budget. Budgets were not raised to make this fit.

`site=here` reads only as far as the master plan reaches: surveyed radius 316 blocks (`MASTER_REACH`),
341,988 column reads, the farthest read 320 blocks out - where the site search reads 376,512 columns and
reaches 512 blocks. That difference is the point of the mode, and `civ-survey.test.mjs` asserts both sides
of it (it does not pin the counts, which are re-measured per run).

## 4a. The whole city, built once, in the fake world (offline evidence - not Minecraft)

Districts 1 to 5 built in order in one run of `dev/lib/civharness.mjs`: every district reported `is built` and ended
`complete`, writing 266,473 blocks from 1,912,722 reads in 27,011 slices, leaving no ticking area and no area
violation. Operations refused for standing in a finished neighbour's land: 4,036 (district 2), 3,970 (3), 1,041 (4),
8,623 (5) - the shared wall and the shared band around it. The save afterwards: 155,697 B of plan in 13 keys (longest
value 30,000 chars, which is the store's chunk size), 11,029 B of queues in 10 keys, a 6,611-character kingdom blob
whose five `district.civ` pointers total 1,546 B, and 15 registered gates. This proves the *workflow* - dependency
order, bounded per-district survey, independent slots, nothing removed from a finished district - against a fake
engine. It proves nothing about real chunk latency, the watchdog, or whether the engine accepts these block states.

## 5. What to capture from the in-game run

* `civ:generate_status` text, once per district and once at the end.
* `civ:generate_diag` after the first district, so the survey/slice timing becomes measured rather
  than estimated.
* Chat screenshots of: the plan summary line (areas, compactness, bbox fill), the first survey line
  (tile and chunk counts), a stall/heartbeat if one happens, and the completion line with coordinates.
* A screenshot from inside each district's walls and one from outside showing the perimeter, plus one
  at each shared wall and each gate, and one of a gate closing (`civ:gate_close <id>` then
  `civ:gate_status <id>`).
* Coordinates of all five centres from `civ:generate_status`, for the build receipt.
* Interrupt tests, per district: `civ:generate_abort` then `civ:generate_resume`; and quit-to-title
  mid-build then `civ:generate_resume` after reopening. A resume that re-places nothing is correct.

Then, and only then: return every gate to `auto`, run `civ:starter_status` → `civ:starter_arm confirm` →
`civ:starter_verify`, copy `starter/build-receipt.example.json` to `starter/build-receipt.json` from
that output, export the world, and follow `docs/STARTER_WORLD.md`.

## 6. What is still deliberately not finished

* `starter/template.json` marks all five districts `starterWorld: true` with `status: "planner-ready"`.
  A district becomes `built` only after it has been built and inspected in Minecraft, and
  `template:release-check` plus `--zip` enforce that. Do not edit the flags to get a package out.
* Known geometry imperfection, inside the wall stage: summed over the five districts, the wall elements
  report more band columns than their own operations cover - 15,146 reported against 14,967 distinct
  columns at seed 21 (179 apart, the worst single element 30), and 14,650 against 14,390 on flat ground
  (260 apart, worst 34). The sealed-separation tests above prove the line that *is* built admits no
  walkable corridor, so this is a bookkeeping gap in `civ/walls.js`, not a hole in the wall; closing it
  moves district 1's stored checksum, so it is a scheduled change rather than something to slip in.
* Known siting shortfall: the auditor keeps a named registry (`civ/facilities.js` `SITING_GAPS`) of the
  programme kinds the lot-siting stage cannot guarantee on every terrain - `command_hall`, `drill_ground`,
  `stable`, `farm_veg`, `orchard`, `pen`, `mill`, `market_square`, `customs_yard`, `barracks`, `shop`,
  `garden`, `warehouse`, `farm_kitchen`. Each one is announced in the plan notes and printed by
  `civ:generate_plan`, and the offline battery asserts that **nothing else** may go to zero: a kind outside
  the registry that vanishes is a hard failure, and a registry entry can only be removed by siting it
  everywhere. What the role is *defined* by (`hq_citadel`, `smithy`, `longhouse`, `market_stall`, the houses,
  `chapel`, `school`, wells) is required to be physically present in every district on every terrain.
* Physical entities: none. Civilians and soldiers remain simulation values; the Commander's Ledger,
  zombie sieges, NPCs and diplomacy are later milestones.
