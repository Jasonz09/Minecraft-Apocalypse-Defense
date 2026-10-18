# Enlarged Hearthgate - status and test instructions

**Nothing here has run inside Minecraft.** Everything below is verified offline against a fake Bedrock world only.

## What it is
One explicit command plans a whole five-district civilization (irregular districts of about 35-40k block-columns each,
about 182-198k in total, shared and outer walls, gates, roads, routes) and then physically builds ONLY the enlarged,
irregular Hearthgate (district 1). The other four districts are planned but not built; building them is behind the
development gate and refused ("not enabled in this build"). The original 49x49 Hearthgate (`district.physical`) is never
overlapped, resized or erased; the site search excludes it with a margin and every write re-checks it.

## Commands (all scriptevent ids have exactly ONE colon)
- `civ:generate [radius=N] [seed=N]` - the one-command workflow (player only). Default radius 220, max 400.
- `civ:generate_plan [radius=N] [seed=N]` - same scan + plan + validation but READ-ONLY (writes nothing); prints site,
  district areas, shape metrics, wall length, gates, lots, estimated ops/slices/minutes.
- `civ:generate_status`, `civ:generate_abort`, `civ:generate_resume` - progress, pause (keeps blocks and queue), continue
  (also after a Minecraft restart: plan and ground are reloaded and the checksum is verified).
- `civ:generate_devgate on|off` - development gate for districts 2-5 (not implemented in this build).
- Gates: `civ:gate_list`, `civ:gate_status [id]`, `civ:gate_open <id>`, `civ:gate_close <id>`, `civ:gate_auto <id>`,
  `civ:gate_test <id>` (safe close -> verify sealed -> reopen -> verify passable; refuses if entities are in the gateway).
- Old manual commands (`civ:district_scout`, `civ:district_generate ...`) still work and are unchanged.

## How to test (NEW normal Creative world; never your original Hearthgate world)
1. Create a new normal (not Superflat) Creative world with cheats on and the Behavior Pack attached. Join once.
2. Stand somewhere outdoors with plenty of natural land around (the search covers a radius of several hundred blocks).
3. Dry run first: `/scriptevent civ:generate_plan` (read-only). Read the site, the warning and the estimates.
4. Build: `/scriptevent civ:generate` (one invocation authorises the whole workflow; no further confirmation).
   Progress is reported in chat every 10%; the end message gives the centre and a `/tp` command.
5. Check: `/scriptevent civ:generate_status`, then `civ:gate_list`, `civ:gate_status <id>`, `civ:gate_test <id>`.
6. Interrupt test: `civ:generate_abort`, then `civ:generate_resume`. Restart test: quit the world mid-build, reopen, `civ:generate_resume`.

## Safety model
Reads and planning are read-only and happen before any write; every failure (no site, water/lava, invalid plan, unloaded
chunks, oversize plan) stops with zero writes. Every block write is re-classified against the live block: only air, loose
plants, proven-natural trees and natural ground are modified; walls are place-only; blocks that are not clearly natural are
skipped and counted. **Limitation:** player builds made only of dirt, stone, andesite, granite, diorite, sandstone, sand,
gravel, clay, snow or moss are indistinguishable from terrain and WOULD be modified. Planks, bricks, glass, chests, ores,
farmland, stripped logs and so on are protected. Use only in a dedicated new world. Generation never starts at pack
activation or on player join.

## Offline numbers (fake world, smooth synthetic terrain - not predictive of real Minecraft)
- Plan: about 65-78k block operations for Hearthgate (before the follow-up fixes seed-21 was 96k with oversized gatehouses),
  222-250 job elements, queue 6.5-7.3 KB, persisted plan+ground about 40-48 KB of the 120 KB budget.
- Survey: about 18k coarse columns (100 slices) and 87k full-resolution columns (232 slices); build about 490 slices of
  <= 400 ops. About 2,000 slices in total; at one slice per tick that is roughly 100 s - an ESTIMATE until measured in game.
- Planning is split into yielding steps (<= ~25k elementary operations between yields; validated with an op meter).

## Known gaps / not verified in game
Chunk loading and ticking-area timing; the Bedrock interpreter speed vs the script watchdog; block states (stairs, doors,
ladders, lever) and `persistent_bit`; real terrain behaviour (rivers, caves, villages, biomes); gate closing against real
mobs; actual throughput; lots the layout could not site on some seeds (orchard, command hall, extra guard posts); stairs and
roof eaves are architecture, not extra supports. Districts 2-5, entity population, invasions: see ROADMAP.md.
