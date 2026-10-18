# Minecraft integration status

In-game verified by the user (previous milestone): the pack loads, `civ:status` and save persistence work.
The physical district below is **built and tested offline only**; nothing in it has run in the game yet.

## Verified (executed, offline)
Run `npm run verify` — all four gates green; `npm test` = 253 tests (incl. 66 reliability/regression
tests added during integration). **None of this proves in-game behaviour.**

## Environment (inspected)
- Minecraft Bedrock `Microsoft.MinecraftUWP 1.26.5203.0`, GDK-style layout.
- Dev behavior packs: `%APPDATA%\Minecraft Bedrock\Users\Shared\games\com.mojang\development_behavior_packs`
  (was empty; no worlds existed at inspection time). Two per-user folders exist under `Users\`;
  one has `minecraftWorlds` — not touched.
- Content logs: `%APPDATA%\Minecraft Bedrock\logs` was empty (game never run). In-game, enable
  Settings → Creator → "Enable Content Log GUI" and/or read the log folder after the first run.

## Compatibility assumptions (documented, not game-verified)
- `@minecraft/server` 2.7.0 is a stable module (published 2026-05-05; shipped with game 1.26.20),
  no Beta APIs/experiments needed. `min_engine_version` raised to `[1,26,20]`.
- No deprecated/beta APIs used; world access happens only inside event/interval callbacks.
- Dynamic property string limit ≈32,767 (community-documented, not official). Saved state plateaus ≈15 KB.

## Deployment
`node dev/deploy.mjs` copies `CivilizationApocalypse_BP` into the dev folder and verifies sha256 of
every file. It refuses to replace a folder with a different manifest UUID and never touches worlds
or other packs. Deployed: 25 files, byte-identical (re-run to confirm after any change).

## Bugs fixed during integration
1. A system exception inside a step left the in-memory kingdom half-mutated → now rolled back and reported.
2. `civ:territory` was silent without a readable save → now explains.
3. Rejected simulation hours were silently dropped → logged (`console.warn`) and passed to `onStep`.
4. Quarantine copy could exceed the property limit after JSON escaping → size-bounded.
5. `civ:debug_scenario <id> --apply` misparsed `--apply` as the target → flags parsed anywhere.
6. A failed v1→v2 migration reseeded (overwrote) the world → now refused, save untouched.
7. Completed-project pruning kept the *oldest* records and dropped walls/gate → keeps newest, never drops walls/gate.
8. Project ids could collide after pruning → suffix is now max+1.

## Known bugs / limitations (not fixed)
- **Siege deadlock (balance):** over ~1000+ default-seed steps (≈40+ in-game days) every district can end
  `lost` (1–2 raiders cause 0 losses, counterattack needs 1.5× strength, repairs blocked while assault>0).
  Needs a design decision; short play sessions won't reach it.
- No production source of external victories: expansion only occurs via `civ:debug_scenario expansion`.
- No offline catch-up; simulation advances only while the world is loaded (1 step ≈ 1000 ticks).
- Build adapter draws a ring at a manual anchor and ignores construction geometry.
- Expansion "survey bound" log noise each step; `land-5` never surveyed; report label "Active construction
  projects" counts history; migrated saves skip quarantine in loop/debug-tick paths.
- Stale doc claims in ARCHITECTURE/GAME_DESIGN (e.g. counterattack ratio is 1.5×) pending cleanup.

## Command ids: ONE colon only
`/scriptevent` ids are `namespace:name` with exactly one colon; an id with two colons (the old district-generate id) is rejected by the game
("Identifier must have a namespace that is not 'minecraft'"). All ids now use underscores for sub-commands
(`civ:district_generate`, `civ:debug_tick`, ...). `dev/test/commands.test.mjs` guards every registered id and every
documented example. Cause was inferred from docs and your in-game result; the exact validator is not documented.

## Command reference
Ids: `civ:status`, `civ:district <id>`, `civ:territory`, `civ:policy [balanced|paused|rapid]`,
`civ:debug_help`, `civ:debug_scenarios`, `civ:debug_scenario <id> [target] [--apply]`,
`civ:debug_tick <1-24>`, `civ:debug_build status|enable|disable|anchor x y z|preview|run [n]`.
(A bare `civ` is not an id: ids are `namespace:name` with exactly ONE colon.) Scenario ids: attack, evacuation,
counterattack, expansion, shortage, growth. Dry-run is the default; `--apply` writes.

## First in-game test checklist (use a NEW world; never an existing one)
1. Create a new Creative/cheats-enabled world → Behavior Packs → add "Civilization Apocalypse Behavior Pack".
   (Pack missing from list? check the content log / manifest errors.) Do not enable Beta APIs.
2. Join. Expect the welcome line then `Civilization Apocalypse: 5 districts, 400 civilians, 150 soldiers.`
3. `/scriptevent civ:status` → Districts 5, Civilians 400, Soldiers 150 (±small drift after steps).
4. `/scriptevent civ:district district-1`, `civ:district nope` (rejected, lists ids), `civ:territory`.
5. `civ:policy`, `civ:policy paused`, `civ:policy nonsense` (rejected), `civ:policy balanced`.
6. `civ:debug_help`, `civ:debug_scenarios`, `civ:debug_scenario attack` (dry run; `civ:status` unchanged),
   `civ:debug_scenario evacuation`, `civ:debug_scenario expansion` (dry run: Districts 5 -> 6).
7. `civ:debug_tick 5`, then `civ:debug_tick 0` / `abc` (rejected).
8. Save & quit, reopen → `Welcome back, <name>.` and unchanged numbers.
9. Check the content log for script errors; report any red text verbatim.
Skip `civ:debug_build` and `--apply` until the above pass.

## Next milestone
Physical world: first fortified district, limited real civilian entities, NPC soldiers, small zombie
invasion — only after the checklist above passes in a real game.


---

# Physical district prototype (district-1, Hearthgate)

Design: [PHYSICAL_DISTRICT_DESIGN.md](PHYSICAL_DISTRICT_DESIGN.md). Code: `scripts/structures/` (pure: palette,
facing, blueprints, layout, planner, siteRules), `integration/districtBuilder.js` and `commands/physical.js`
(Bedrock boundary). The saved record gains an optional validated `district.physical`
{layout, version, status, origin, dimension, placed, total, planHash, built}; no schema bump.

## Generate it (NEW test world only)
1. New world (Superflat is easiest for now; normal worlds work only on a flat, empty clearing), Creative, cheats on, with the Behavior Pack attached. Join once so the kingdom is seeded.
2. Stand at the **centre of a flat, empty area** (about 55x55 blocks of clear grass; the district is centred on your feet).
3. Survey (writes nothing): `/scriptevent civ:district_generate district-1`
4. Build: `/scriptevent civ:district_generate district-1 confirm`
5. Others: `civ:district_status`, `civ:district_abort`, `civ:district_resume` (after an interruption or "paused").
   `civ:district` now also shows a `Physical:` line once built.

## What is verified (executed, offline)
`npm test`: 253/253; `npm run verify` all gates green (manifest 279 checks, typecheck, e2e). Tests prove: deterministic plan
(8,7xx blocks, inside 49x49, y -1..12); counts mirror the record (6/3/1/4 + 1 wall + 4 gates); wall ring complete except
the four gate passages; every door/gate/wall-stair is road-connected (evacuation and reinforcement routes); every block
id exists in the installed game data and every state *name* is valid; dry run writes nothing; obstructions, player builds
and non-natural ground refuse the whole site; a cell occupied after the survey is never overwritten; pause on unloaded
chunks, resume, abort, single job at a time, state-fallback; simulation continues unchanged over a built district.
Independent reviewers: code review (4 confirmed/suspected issues fixed: unresumable build after sim changes, abort/re-run
race, hook cleanup, gravel in roads) and a flood-fill geometry audit (all doors/towers/walkway reachable, no floating or
unsupported blocks, roofs cover interiors).

## Still requires in-game testing
- Facing/state conventions are inferred, not confirmed: stairs (`weirdo_direction` 0=E,1=W,2=S,3=N ascending), doors
  (`minecraft:cardinal_direction`, both halves hinge=false), ladders (`facing_direction` 2=N..5=E), chests. Wrong
  values show as rotated roof/stairs or doors facing inward; if the engine *rejects* a state the block is placed plain and
  the final message says `state fallbacks N` with samples - send those lines.
- Gate leaves are not modelled (open arch with raised portcullis bars); fence gates in farms are closed.
- Real build time/lag, ticking-area behaviour, farmland staying hydrated, wheat appearance, lantern placement.
- Chests are empty; there are no beds (colour cannot be set from stable script); no NPCs or entities are spawned.

## Known limits
Flat ground required: on normal terrain the generator refuses and changes nothing (design for hills/forests: NATURAL_TERRAIN_DESIGN.md; not built). Only `district-1`
has a layout. Simulation gate/wall state does not drive the physical blocks. Entities in the footprint (item frames,
armor stands) are not checked. A stuck build can always be re-surveyed with `resume`; an aborted district is left as is.
