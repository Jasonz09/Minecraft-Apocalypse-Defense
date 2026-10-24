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
- Dynamic property string limit ≈32,767 (community-documented, not official). Measured in the fake world after
  building all five districts: the kingdom blob is 6,611 characters (its five `district.civ` pointers are 1,546 B),
  the master plan plus five site payloads are 155,697 B in 13 keys with no value over the store's 30,000-char chunk
  size, and the five queues 11,029 B in 10 keys, plus 2,725 B of gate registry and 15 small per-gate keys -
  every one of them inside its own store's budget, none of them one giant string.


## Deployment
`node dev/deploy.mjs` copies `CivilizationApocalypse_BP` into the dev folder and verifies sha256 of
every file. It refuses to replace a folder with a different manifest UUID and never touches worlds
or other packs. Deployed as of commit `e8b5622`: **112 files**, each re-checked with
`git hash-object --path <pack path> <deployed file>` against the blob id stored in that commit - 0
mismatches, 0 missing, 0 extra; header UUID `fd04cb50-dddc-4ebe-83fc-5b5375819bcb`, the same as the
source manifest, and the manifest now declares `@minecraft/server-ui` 2.1.0 for the Ledger (never resolved
by a real game). Re-run `node dev/deploy.mjs` after any change and confirm the same file count with 0/0/0.
Deploying is not running: Minecraft has still never loaded this pack, so nothing here validates the
engine. See docs/TESTING.md for the in-game checklist.

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
- **Siege deadlock (balance) - fix merged to master (7679415); the original note follows:** over ~1000+ default-seed steps (≈40+ in-game days) every district can end
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

## Generate it (NEW test world; normal terrain supported)
1. New world (normal or Superflat), Creative, cheats on, Behavior Pack attached. Join once so the kingdom is seeded.
2. Stand outdoors near grass. Optionally find a good spot (read-only): `/scriptevent civ:district_scout` (radius 8-48, default 32).
3. Survey (read-only): `/scriptevent civ:district_generate district-1` (or `... district-1 at <x> <z>` from the scout).
   It reports the real ground heights, the platform height and the terrain work (cut/fill/resurface/clear).
4. Build: copy the exact command the survey prints, e.g. `/scriptevent civ:district_generate district-1 at X Z maxcut=4 maxfill=4 confirm terrain=<code>`.
   Without the code, a site that needs terrain work is refused; if the world changed since the survey the code no longer matches.
5. Others: `civ:district_status`, `civ:district_abort`, `civ:district_resume` (after an interruption or "paused").
6. `maxcut=N` / `maxfill=N` (0-6) change how much earthwork is allowed.

## Terrain rules (what is touched)
Only inside the 49x49 footprint: grass/flowers/loose plants, natural trees (trunk on natural ground, non-persistent leaves,
no player-made block touching), and natural ground (cut above / fill below one platform at the median ground height).
Refused (nothing changes): water or lava in the footprint, any non-natural block (planks, chests, farmland, ...), ground
hollow underneath, an isolated spike of ground (possible pillar), slopes beyond maxcut/maxfill, unloaded chunks, huge or
suspicious tree-like structures (a log-only build with no leaves refuses), and water or lava touching the footprint's edge. Limitation: id-based detection cannot tell a player's garden, hedge or dirt/stone wall from
terrain; the spike rule only catches pillars. Do not run it over such builds - always read the survey first.

## Still requires in-game testing
- Facing/state conventions are inferred, not confirmed: stairs (`weirdo_direction` 0=E,1=W,2=S,3=N ascending), doors
  (`minecraft:cardinal_direction`, both halves hinge=false), ladders (`facing_direction` 2=N..5=E), chests. Wrong
  values show as rotated roof/stairs or doors facing inward; if the engine *rejects* a state the block is placed plain and
  the final message says `state fallbacks N` with samples - send those lines.
- Gate leaves are not modelled (open arch with raised portcullis bars); fence gates in farms are closed.
- Real build time/lag, ticking-area behaviour, farmland staying hydrated, wheat appearance, lantern placement.
- Chests are empty; there are no beds (colour cannot be set from stable script); no NPCs or entities are spawned.

## Known limits
Terrain preparation is implemented (see Terrain rules); no undo; water/lava/caves refuse. Only `district-1`
has a layout. Simulation gate/wall state does not drive the physical blocks. Entities in the footprint (item frames,
armor stands) are not checked. A stuck build can always be re-surveyed with `resume`; an aborted district is left as is.

Independent adversarial run (about 80 scenarios on a fake world): no block that was not natural ground, a plant or a natural tree changed inside the footprint, and nothing changed outside it. It cannot prove real-engine behaviour (block ids/states, liquid flow, gravity blocks, ticking areas).

## Status after the goal pass (offline only; nothing below has run in Minecraft)

- Siege balance: merged to master (7679415); difficulty needs playtesting.
- Districts 2-5: build through the Hearthgate path behind the development gate (ad23eef); shared-wall deviation documented in FIVE_DISTRICT_BUILD.md.
- Invasion director: built and disabled by default; the tick calls it as a no-op (aa8977d, 86f14eb).
- Population LOD: built, spawning disabled, not wired into main.js (9d5e50b).
- Commander's Ledger: presenters, runtime and dev-gated wiring on master (50590e3, 7f35c71); unverified in game (server-ui dependency).
