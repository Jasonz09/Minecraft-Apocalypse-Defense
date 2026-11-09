# Read-only lighting cuecard — CA Natural Lights Nov9 78a94a0c

Use ONLY the new copy. People gate is ON; root accepts ordinary population/simulation evolution on this clone. No NPC manipulation, OFF/DP patch/reset, cleanup or coverage/release claim. Observer-only TP is allowed. Natural day/night; no time reset.

**D1 first:** `/tp @s -69 110 -599`, then `/scriptevent civ:lights_natural district=1 preview`. This is the explicit read-only preview; do not omit preview or append confirm. Then `/scriptevent civ:lights_status` and `/time query daytime`.

The TP height110 is a chosen aerial view, not a saved/surveyed floor or walkable spot. Civ records store X/Z only and no camera pose. All physical.origin fields are absent.

| District | Saved centre X,Z | Saved HQ X,Z | Saved master bbox X0,Z0 → X1,Z1 | Observer-only TP |
|---|---|---|---|---|
| D1 Hearthgate | -69,-599 | 26,-574 | -232,-700 → 67,-489 | `/tp @s -69 110 -599` |
| D2 Ironquarry | -56,-772 | 10,-766 | -180,-884 → 71,-645 | `/tp @s -56 110 -772` |
| D3 Whitethorn | -266,-733 | -266,-814 | -396,-848 → -157,-625 | `/tp @s -266 110 -733` |
| D4 Saltmere | -368,-554 | -386,-574 | -488,-656 → -221,-413 | `/tp @s -368 110 -554` |
| D5 Ashfall | -207,-473 | -258,-446 | -320,-600 → -77,-365 | `/tp @s -207 110 -473` |

Shared saved anchor **-187,-621**; it is not five separate origins. Bounds are saved geometry, not movement/build permission. Checksums: D1 07515fcb, D2 e6d55467, D3 6b9f8114, D4 35635162, D5 23a6aeca.

**D4 masonry + protected leaves:** observer `/tp @s -340 64 -460` (historically used viewpoint), then the exact3 read-only commands below. Unloaded/mismatch → record and stop; do not repair. The wall receipt has14done entries; the3protected leaves have historical point evidence, NOT a separate receipt.

repaired-masonry-first7:

`/execute if block -323 55 -455 minecraft:cracked_stone_bricks if block -323 56 -455 minecraft:stone_bricks if block -324 51 -456 minecraft:stone_bricks if block -324 55 -456 minecraft:stone_bricks if block -324 56 -456 minecraft:stone_bricks if block -323 55 -456 minecraft:stone_bricks run testforblock -323 56 -456 minecraft:mossy_stone_bricks`

repaired-masonry-second7:

`/execute if block -323 57 -456 minecraft:stone_bricks if block -322 55 -456 minecraft:cracked_stone_bricks if block -322 56 -456 minecraft:mossy_stone_bricks if block -322 57 -456 minecraft:stone_bricks if block -322 58 -456 minecraft:stone_bricks if block -322 55 -455 minecraft:cracked_stone_bricks run testforblock -322 56 -455 minecraft:mossy_stone_bricks`

protected3-jungle-leaf-IDs:

`/execute if block -321 56 -456 minecraft:jungle_leaves if block -321 56 -455 minecraft:jungle_leaves run testforblock -320 56 -456 minecraft:jungle_leaves`

Later optional no-confirm samples after current source checks:

`/scriptevent civ:interior_lights district=4 building=building-d4-watchtower-3`

`/scriptevent civ:interior_lights district=4 building=building-d4-warehouse-4`

`/scriptevent civ:interior_lights district=5 building=building-d5-chapel-1`

`/scriptevent civ:farm_lights district=4 farm=building-d4-farm_kitchen-1`

Keep Vines/Copper Ore/fern/unknown leaves untouched. No heavy tree inspector. Capture same-view day/night only when actually observed; clear camera before save/close. A fresh after-session clone backup/log/source comparison is separate; this card makes no native acceptance claim.

Extracted from immutable176 city snapshot457089; verified35plan/job raw pins, master/site chunk envelopes and16file preservation. New/live clone DB was never opened by this extraction.
