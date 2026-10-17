# Minecraft integration status (first real-game preparation)

## Verified (executed, offline)
Run `npm run verify` — all four gates green; `npm test` = 214 tests (incl. 66 reliability/regression
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
5. `civ:debug:scenario <id> --apply` misparsed `--apply` as the target → flags parsed anywhere.
6. A failed v1→v2 migration reseeded (overwrote) the world → now refused, save untouched.
7. Completed-project pruning kept the *oldest* records and dropped walls/gate → keeps newest, never drops walls/gate.
8. Project ids could collide after pruning → suffix is now max+1.

## Known bugs / limitations (not fixed)
- **Siege deadlock (balance):** over ~1000+ default-seed steps (≈40+ in-game days) every district can end
  `lost` (1–2 raiders cause 0 losses, counterattack needs 1.5× strength, repairs blocked while assault>0).
  Needs a design decision; short play sessions won't reach it.
- No production source of external victories: expansion only occurs via `civ:debug:scenario expansion`.
- No offline catch-up; simulation advances only while the world is loaded (1 step ≈ 1000 ticks).
- Build adapter draws a ring at a manual anchor and ignores construction geometry.
- Expansion "survey bound" log noise each step; `land-5` never surveyed; report label "Active construction
  projects" counts history; migrated saves skip quarantine in loop/debug-tick paths.
- Stale doc claims in ARCHITECTURE/GAME_DESIGN (e.g. counterattack ratio is 1.5×) pending cleanup.

## Command reference
Ids: `civ:status`, `civ:district <id>`, `civ:territory`, `civ:policy [balanced|paused|rapid]`,
`civ:debug:help`, `civ:debug:scenarios`, `civ:debug:scenario <id> [target] [--apply]`,
`civ:debug:tick <1-24>`, `civ:debug:build status|enable|disable|anchor x y z|preview|run [n]`.
(`/scriptevent civ` alone is invalid: ids need `namespace:name`.) Scenario ids: attack, evacuation,
counterattack, expansion, shortage, growth. Dry-run is the default; `--apply` writes.

## First in-game test checklist (use a NEW world; never an existing one)
1. Create a new Creative/cheats-enabled world → Behavior Packs → add "Civilization Apocalypse Behavior Pack".
   (Pack missing from list? check the content log / manifest errors.) Do not enable Beta APIs.
2. Join. Expect the welcome line then `Civilization Apocalypse: 5 districts, 400 civilians, 150 soldiers.`
3. `/scriptevent civ:status` → Districts 5, Civilians 400, Soldiers 150 (±small drift after steps).
4. `/scriptevent civ:district district-1`, `civ:district nope` (rejected, lists ids), `civ:territory`.
5. `civ:policy`, `civ:policy paused`, `civ:policy nonsense` (rejected), `civ:policy balanced`.
6. `civ:debug:help`, `civ:debug:scenarios`, `civ:debug:scenario attack` (dry run; `civ:status` unchanged),
   `civ:debug:scenario evacuation`, `civ:debug:scenario expansion` (dry run: Districts 5 -> 6).
7. `civ:debug:tick 5`, then `civ:debug:tick 0` / `abc` (rejected).
8. Save & quit, reopen → `Welcome back, <name>.` and unchanged numbers.
9. Check the content log for script errors; report any red text verbatim.
Skip `civ:debug:build` and `--apply` until the above pass.

## Next milestone
Physical world: first fortified district, limited real civilian entities, NPC soldiers, small zombie
invasion — only after the checklist above passes in a real game.
