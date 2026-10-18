# Testing

Minecraft Bedrock 1.26.5203 is now installed, but **no in-game run has been performed yet**.
The gates run headless and claim no in-game behaviour. Use the manual script at the bottom and
`docs/MINECRAFT_INTEGRATION.md` for the first real test.

## The four gates

```bash
npm install      # typescript + @minecraft/server@2.7.0 types + @minecraft/common
npm run verify   # runs every gate, reports each one even if an earlier one fails
```

Current results are recorded in `docs/MINECRAFT_INTEGRATION.md`.

| Command | Gate | What it actually proves |
| --- | --- | --- |
| `npm run validate` | manifest + packaging | Manifest structure, real unique UUIDs, entry file exists, the `@minecraft/server` pin **equals the installed types version** (so the code cannot be checked against one API and shipped against another), every relative import carries a `.js` extension and resolves (a missing extension is a silent pack-load failure), no dev junk inside the pack root |
| `npm run typecheck` | strict `checkJs` | All 24 pack scripts are typed against the real 2.7.0 declarations: catches `initial` vs `initialSpawn`, `scriptEventReceived` vs `scriptEventReceive`, non-existent methods, implicit `any` |
| `npm run test` | 148 unit tests across 10 files | Simulation behaviour, save/migration, invariants, reporting text, argument parsing |
| `npm run e2e` | headless kingdom run | The whole gameplay sequence over a v1 save: migrate → peace → siege → evacuation → reinforcement → counterattack → victory → autonomous claim → shortage refusal → construction → recruitment → persistence → deterministic replay → readouts |

Individual gates: `npm run validate`, `npm run typecheck`, `npm run test`.

## What the gates cannot prove

- That the pack loads, that chat renders, that any event fires, or that blocks place. All of
  that needs the game.
- **Pure JS vs runtime boundary.** Everything under `scripts/sim/`, `scripts/kingdom/`,
  `scripts/ui/` and `scripts/commands/args.js` runs in Node and is covered. These files are
  the Bedrock boundary and are **only** typechecked:
  `main.js`, `events/welcome.js`, `commands/{status,inspect,debug,reply}.js`,
  `integration/{simulationLoop,buildAdapter}.js`. `integration.test.mjs` guards the split in
  both directions — the core must not import the runtime, and boundary files must.
- The rollback branch in `tick.advanceKingdomStep` (validator rejection and a throwing system)
  is covered by `dev/test/reliability-rollback.test.mjs` with injected faults.
- Saved-state size is asserted as a blob budget (peak ≈15 KB over 400 steps). In-game,
  `world.getDynamicPropertyTotalByteCount()` is the instrument.

## Proving the typecheck gate is still live

A green typecheck means nothing if `checkJs` stopped reading the files. Verify it:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --listFiles | grep CivilizationApocalypse_BP   # must list every pack script
```

Then break something deliberately, re-run, restore, and re-run:

```bash
# in scripts/events/welcome.js: event.initialSpawn -> event.initial   (the old 1.x name)
# in scripts/kingdom/store.js:  getDynamicProperty -> getDynamicPropertyX
```

Expected (these are the errors this project actually produced when run):

```
welcome.js(12,20): error TS2339: Property 'initial' does not exist on type 'PlayerSpawnAfterEvent'.
store.js(15,28):  error TS2551: Property 'getDynamicPropertyX' does not exist on type 'World'. Did you mean 'getDynamicProperty'?
```

Restore from a copy (not `git checkout`) and confirm byte-identity with `cmp`.

## In-game manual test script

Requires a world with cheats enabled (needed for `/scriptevent`).

1. **Install** per `README.md`, add the pack as a **Behavior Pack** to a world.
2. **First join** — expect: `Welcome to the ruins. Civilization Apocalypse has been
   founded.` then `Civilization Apocalypse: 5 districts, 400 civilians, 150 soldiers.` and
   the hint to run `civ:status`.
3. `/scriptevent civ:status` — the header, `Districts: 5`, `Civilians: 400`,
   `Soldiers:  150`, five district lines, then `-- situation --` with the in-game day,
   policy, refugee count, districts under attack, territory and project counts.
4. `/scriptevent civ:district district-3` — full district card (security, integrity,
   garrison split, stores, buildings, neighbours, projects).
   `/scriptevent civ:district nope` must be **rejected** with the list of real ids.
5. `/scriptevent civ:territory` — the five border lands and their status.
6. `/scriptevent civ:policy` then `civ:policy paused`, then `civ:policy nonsense` (must be
   rejected). Restore with `civ:policy balanced`.
7. **Autonomy** — leave the world for a day of real play and return; `civ:status` should show
   the step counter advanced, projects scheduled, and the army replacing its losses.
8. **Persistence** — quit to title and rejoin. The greeting should read
   `Welcome back, <name>.` (proof it loaded a save instead of re-seeding) and the numbers
   must match what you left.
9. **Debug scenarios** — `/scriptevent civ:debug_help`, `civ:debug_scenarios`, then
   `civ:debug_scenario attack`. It must report a **dry run against a copy**; `civ:status`
   afterwards must be unchanged. `civ:debug_scenario expansion` on a healthy border should
   end `Districts: 5 -> 6` with the seven-project plan listed; add `--apply` to write it.
   `civ:debug_tick 5` advances five hours; `civ:debug_tick 0`, `civ:debug_tick abc` and
   `civ:debug_scenario not-a-scenario` must all be rejected.
10. **Physical build demo (opt-in, unverified by me)** —
    `/scriptevent civ:debug_build enable`, stand somewhere flat and empty,
    `civ:debug_build anchor <x y z>`, `civ:debug_build preview`, then
    `civ:debug_build run`. It should place a ring of blocks for the next unfinished stage,
    report `skipped ... is not air` rather than replacing anything, and report `chunk is not
    loaded` if you aim it at unloaded ground. `civ:debug_build disable` turns it off.
11. **Migration** — if you still have a world from the first release, the join greeting must
    say `Welcome back` and the totals must survive; a pre-migration copy is kept in the
    `civ:kingdom-quarantine` dynamic property.

If the scripts fail to load at all, check the content log for the module version message and
follow the pin fix in `README.md` → Troubleshooting.
