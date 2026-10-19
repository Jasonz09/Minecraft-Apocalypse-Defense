# Enlarged Hearthgate - status and test instructions

**Nothing here has run inside Minecraft.** Everything below is verified offline against a fake Bedrock world only.

## What it is
One explicit command plans a whole five-district civilization (irregular districts of about 35-40k block-columns each,
about 182-198k in total, shared and outer walls, gates, roads, routes) and then physically builds one district per
invocation. All five districts now have enlarged layouts registered (`hearthgate/ironquarry/whitethorn/saltmere/ashfall-enlarged`)
and their own plan slot and resumable queue, so building district 2 never overwrites district 1's data or blocks.
Building them all, in order, is `docs/FIVE_DISTRICT_BUILD.md`. The original 49x49 Hearthgate (`district.physical`) is
never overlapped, resized or erased; the site search excludes it with a margin and every write re-checks it.

## Commands (all scriptevent ids have exactly ONE colon)
- `civ:generate [district=N] [site=here] [radius=N] [seed=N]` - the one-command workflow (player only), one district at
  a time; `district=` defaults to 1, so the old usage is unchanged. Default radius 220, max 400. `site=here` fixes the
  capital on your own position and reads only as far as the master plan reaches (no distant chunk storms).
- `civ:generate_plan [district=N|all] ...` - same scan + plan + validation but READ-ONLY (writes nothing); prints site,
  district areas, shape metrics, wall length, gates, lots, estimated ops/slices/minutes, the stored sizes, and any
  facility kinds the programme could not site. `district=all` reads no terrain and totals the civilization.
- `civ:generate_status`, `civ:generate_abort [district=N]`, `civ:generate_resume [district=N]` - progress across all
  five districts, pause (keeps blocks and queue), continue (also after a Minecraft restart: plan and ground are reloaded
  and the checksum is verified).
- `civ:generate_devgate on|off` - the development flag; districts 2-5 are implemented, so it no longer means "unavailable".
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

## Planner hang investigation (2026-10-18) - survey progress, timeouts, diagnostics
Symptom (real game, new normal world): `civ:generate_plan` printed its first survey line, then nothing for a long time;
`civ:generate_status` said "Not generated" and "Job slot: civ-plan".
CONFIRMED from code, typings and an offline reproduction: ticking-area loads were awaited with no timeout (the API promise
resolves only when every chunk is loaded and ticking, and has no failure reason for a stall); the survey was 100 serial 128x128
tiles (about 6,400 chunks, about 6,280 of them ungenerated in a fresh world) with progress only every 25 tiles; status read
only `district.civ`, so an active planning session was invisible. HYPOTHESES (need real-game evidence): fresh-world chunk
generation is simply very slow, or an area promise never settles for some tiles. The string "[1/3]" in the report does not
exist in this repo (it prints "[n/6]"); the exact in-game text still needs to be confirmed.
Changes (all offline-tested only): per-tile hold timeout (1200 ticks, 1 retry, tile shrinking on `OverChunkLimit`, stall abort
with a clear message), progressive nearest-first survey that stops when a site is found, a progress registry with 10-second
heartbeats, `civ:generate_status` showing the active/last session (phase, tiles, chunks, elapsed, "no progress for N s",
last error), stall (3 min) and deadline (30 min) protection, cleanup of abandoned ticking areas, duplicate-job refusal showing
phase and age, and a new `civ:generate_diag` (maxChunkCount, chunkCount, capacity, your chunk, owned areas, last error).

### Retest the read-only planner in a NEW normal Creative world
1. New normal Creative world, cheats on, Behavior Pack attached (the redeployed pack). Join, stay near spawn.
2. `/scriptevent civ:generate_diag` - note maxChunkCount and whether a 64-chunk tile has capacity.
3. `/scriptevent civ:generate_plan` - expect an up-front chunk estimate, then a heartbeat at least every ~10 s.
4. While it runs, `/scriptevent civ:generate_status` - expect phase n/6, tile i/N, chunks scanned/pending, elapsed time.
5. If nothing progresses for 3 minutes the run stops itself and says why (tile coordinates, maxChunkCount). Send me that text
   and the `civ:generate_diag` output. `/scriptevent civ:generate_abort` cancels and clears a stuck session.
6. Nothing is written to the world by `civ:generate_plan`; do not run `civ:generate` until the plan finishes.
