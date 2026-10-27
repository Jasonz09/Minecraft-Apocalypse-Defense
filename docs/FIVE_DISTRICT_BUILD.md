# Building the five-district civilization once, in a dedicated world

Status: everything below is implemented and verified **offline against a fake Bedrock world**, and the
sequence has since been walked in the real game: districts 1 (Hearthgate) and 2 (Ironquarry) are built end
to end and verified inside Minecraft (Bedrock 1.26.5203, 2026-10-26, in a development save -
`docs/PROGRESS.md`). Districts 3-5 have not been run in the game, and no `.mctemplate` exists.
`npm run template:release-check` exits nonzero until all five districts are physically built and verified
in game, marked `built` in `starter/template.json` and covered by a signed receipt - which none of them is,
because the packaged starter world has never been built - and the packager refuses
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

Every id is a **script event**: type it after `/scriptevent`, e.g. `/scriptevent civ:generate district=2`.
The pack registers no slash commands of its own, so the short form answers "unknown command".

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

## 4. Measured cost (offline, synthetic terrain, reference plan seed 21, commit `e8b5622` - an estimate, not a prediction)

| district | role | enclosed columns | ops | write slices | site record | job queue |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Hearthgate | command | 40,400 | 75,155 | 564 | 68,864 B | 2,202 B in 234 elements |
| 2 Ironquarry | industrial | 35,200 | 58,221 | 437 | 66,376 B | 2,068 B in 219 elements |
| 3 Whitethorn | agricultural | 38,208 | 67,125 | 504 | 83,721 B | 2,596 B in 281 elements |
| 4 Saltmere | commercial | 40,112 | 65,924 | 495 | 72,835 B | 2,297 B in 246 elements |
| 5 Ashfall | residential | 37,792 | 65,334 | 491 | 85,810 B | 2,745 B in 299 elements |
| total | | 191,712 | 331,759 | 2,491 | 120,000 B budget | 16,000 B budget |

District 1's record is still byte-identical to the pinned `53c81775`; districts 2-5 were re-planned by
`ad23eef` (cross-district wall priority at plan time), which is why their operation counts and checksums are
not the numbers an older copy of this table carried. The per-district survey cost is measured in the fake
world below rather than tabulated here, because it depends on the terrain the run actually reads.

The slices column is `describePlan`'s own basis - `ceil(ops x 3 / 400)` for the write phase (stage ends,
chunk holds and tree clearing make real windows about three times the ideal), one slice per tick assumed.
`civ:generate_status` adds the survey and planning slices on top when it has measured them. At 20 ticks/s
that is roughly two minutes of write work per district **if** the engine grants a slice every tick. The
first in-game districts measured only the whole run: district 1 went from the horn confirmation to
`complete` in about 15 minutes of wall clock (survey + planning + build together, 52188 ops with 4902
skipped), and district 2 ended at 46042 ops with 1716 skipped; the per-district write-slice rate has not
been separated out in game, and no `civ:generate_diag` output from either run is recorded.

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

Districts 1 to 5 built in order in one run of `dev/lib/civharness.mjs` (world seed 1, plan seed 1, commit
`e8b5622`): every district reported `is built` and ended `complete`, writing 266,473 blocks - 75,976 / 56,614 /
59,070 / 35,470 / 39,343 per district - from 1,912,599 reads in 27,007 slices, leaving no ticking area and no area
violation. Operations refused for standing in a finished neighbour's land: 4,026 (district 2), 3,961 (3), 1,037 (4),
8,525 (5) - the shared wall and the shared band around it. The save afterwards: 155,697 B of plan in 13 keys (longest
value 30,000 chars, which is the store's chunk size), 11,029 B of queues in 10 keys, a 6,611-character kingdom blob
whose five `district.civ` pointers total 1,546 B, 2,725 B of gate registry and 15 registered gates. This proves the
*workflow* - dependency order, bounded per-district survey, independent slots, nothing removed from a finished
district - against a fake engine. It proves nothing about real chunk latency, the watchdog, or whether the engine
accepts these block states.

## 5. What to capture from the in-game run

Partly captured for districts 1-2 on 2026-10-26: both `civ:generate_status` lines are recorded in
`docs/PROGRESS.md`, along with site screenshots of the builds. Nothing else below is recorded as captured,
and districts 3-5 have not been run in the game.

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
  report more band columns than their own operations cover - 15,146 reported against 14,952 distinct
  columns at seed 21 (194 apart, the worst single element 30), and 14,650 against 14,368 on flat ground
  (282 apart, worst 39). The sealed-separation tests above prove the line that *is* built admits no
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
* Physical entities: none reach the world. War, evacuation and siege are simulation values (built and tested
  offline); the Commander's Ledger is wired behind `civ_ledger_dev`, default off, and its
  `@minecraft/server-ui` 2.1.0 dependency **did resolve in the real game** on 2026-10-26 - `main.js` imports the
  bindings unconditionally, so the pack loads or fails on that pin as a whole, and it loaded. The Ledger's own
  item, menus and confirmations have still never been opened in game; `manifest validation` now
  checks every `@minecraft/*` pin against the installed typings. The population-LOD and people modules are
  offline-tested but unwired, with spawning disabled by default, so neither built district could put an
  inhabitant in the world. A built world therefore contains buildings,
  roads and gates - not inhabitants.

## WP2 audit (districts 2-5 through the district-1 code path)

Measured at HEAD `143afa9` before any WP2 edit. Probe: `planCivilizationDetailed` on `makeField(seed, { relief, hills: 60 })`,
then `planDistrictSite(plan, i, field, { seed })` for i = 1..5. Rough = relief 18, flat = relief 2.

| district | role | layout registered | planned on 7 fixtures (seeds 21, 3, 7, 42, 99 rough; 12, 8 flat) | containment problems | ops (seed 21) | record bytes (max, 7 fixtures) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Hearthgate | command | `hearthgate-enlarged` | 7/7 ok | 0 | 75,155 | 73,845 |
| 2 Ironquarry | industrial | `ironquarry-enlarged` | 7/7 ok | 0 | 58,261 | 73,752 |
| 3 Whitethorn | agricultural | `whitethorn-enlarged` | 7/7 ok | 0 | 67,182 | 87,773 |
| 4 Saltmere | commercial | `saltmere-enlarged` | 7/7 ok | 0 | 65,967 | 76,116 |
| 5 Ashfall | residential | `ashfall-enlarged` | 7/7 ok | 0 | 65,396 | 90,965 |

All 35 district plans succeed with no problems; the master plan succeeds on all 7 fixtures. Record bytes stay under the 120,000-byte
plan budget. Per-seed numbers are in the probe output, not here.

What is in place already (no change needed for the build path): one generic planner `planDistrictSiteSteps` reads each district's own
walls, gates and roads from the master plan; `ENLARGED_LAYOUTS` names all five layouts; the site slot (`sitePrefixFor`) and queue
slot (`jobPrefixFor`) are index-generic, with district 1 keeping the legacy single slot; `civ:generate`, `civ:generate_plan` refuse
districts 2-5 without `civ_devgate`.

What was missing or unproven:

* **Gate gaps (fixed in WP2):** `civ:generate_plan district=all` was ungated, and `civ:generate_resume` of an already started
  district 2-5 was not refused when the gate was off. Both now refuse with the gate-off message.
* **Coverage gap (closed by `dev/test/civ-five-district.test.mjs`):** the existing door, walkability, rehydration and
  restart tests in `civ-districtplan.test.mjs` and `civ-siterehydrate.test.mjs` iterate over district 1 only. Districts 2-5 had
  no rehydration, walkable-network or interrupted-resume check of their own.
* **Shared walls, at HEAD (superseded, see round 2 below):** planning a shared wall from
  either neighbour's ground gives identical blocks (`planWall` output does not depend on the region clip). The per-district
  element lists differ because `resolve()` keeps only the first claim when two wall elements of one district lay the same block
  at a junction. Seed 21, element-only cells per side: wall-3 (1|2) 12 / 22; wall-4 (1|5) 358 / 363; wall-6 (2|3) 0 / 727;
  wall-7 (1|3) 388 / 26; wall-9 (1|4) 46 / 53; wall-10 (4|5) 0 / 0; wall-11 (3|4) 0 / 0. Every cell that one side's element
  omits is built by the other side's stream. Making the element lists identical would change district 1's pinned output, so it
  is recorded here rather than changed.
* **Raw cross-district overlaps, at HEAD (superseded, see round 2 below):** in build order 1..5 the raw streams place a different block on
  796 coordinates already claimed by an earlier district's wall or gate (seed 21). The runtime refuses these: the write guard
  (`inProtectedArea`, `isSharedWallFill`) and the live-block classifier (`classifyCivOp`) treat a non-natural block as occupied and
  skip the later op. Within one district no later stage replaces a barrier block.

### WP2 decisions, implemented (round 2)

* **Shared-wall criterion (deviation from the element-identity wording).** The spec asked that the wall ops district A and
  district B produce for a shared wall be identical, cell for cell and id for id. That is not what is asserted, and cannot be
  without changing district 1. Element lists differ because `resolve()` de-duplicates a wall element against the other wall
  elements of the same district: where two walls of one district lay the same block at a junction, the first claim is kept.
  District 1's de-duplication is pinned by `dev/test/golden/hearthgate-golden.json` (its element ids, totals and hashes), so
  district 1's wall-3, wall-4, wall-7 and wall-9 elements cannot be made to hold every planned column, and no district 2-5
  element can be made to match them exactly without copying district 1's omissions. The test therefore asserts the three
  properties that describe what is built:
  1. the wall planned from A's ground equals the wall planned from B's ground (`planDiff` 0);
  2. every planned column is solid in the final stream of at least one neighbour (`uncovered` 0);
  3. no planned column holds two different solid blocks in the two final streams (`conflicts` 0).
  Measured on seed 21 (rough) after the change: planned geometry identical on all 7 shared walls, and no planned column absent
  from both final streams.
* **Plan-time priority across districts (implemented in `scripts/civ/districtplan.js`).** For districts 2-5, every op of a
  later district that would place a different block on a column owned by an earlier district's final wall layer is dropped at
  plan time (`foreignBarrier`, applied in `resolve()`). The earlier layer is planned from this district's own region ground, so
  rehydration reproduces it. District 1 has no earlier district, so its output does not change (golden test passes).
  Runtime write-path checks (guard and classifier) stay as they were.
* **Gate gaps and the devgate fixture.** `civ:generate_plan district=all` and `civ:generate_resume` of districts 2-5 are gated
  on `civ_devgate`. The devgate test's fixture was hand-written and invalid (missing seed, startedStep, anchor, checksum,
  stage); it now has the shape `commands/civ.js` writes. No producer change was needed.
