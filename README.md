# Civilization Apocalypse — Bedrock Behavior Pack (foundation build)

A Minecraft Bedrock Edition behavior pack that keeps a persistent **kingdom** in world
storage: 5 districts, 400 civilians and 150 soldiers as starting simulation values.

These are **simulation numbers held in saved state — no civilians or soldiers are spawned
as entities in this build.** Buildings, combat and NPC AI are deliberately not implemented.

- Language: JavaScript (no build step — the files in the pack are the source)
- API: `@minecraft/server` **2.7.0** (stable, not beta)
- Storage: world dynamic properties (`civ:kingdom`), which survive save/reload

---

## Layout

```
CivilizationApocalypse/
├── CivilizationApocalypse_BP/          <- the pack: zip THIS folder's contents to install
│   ├── manifest.json
│   └── scripts/
│       ├── main.js                     entry point: wires the store to the two systems
│       ├── config.js                   all tunable values (districts, populations, keys)
│       ├── kingdom/state.js            pure state: defaults, splitting, validation, (de)serialize
│       ├── kingdom/store.js            persistence over world dynamic properties
│       ├── events/welcome.js           player-join welcome message
│       ├── commands/status.js          /scriptevent civ:status handler
│       └── ui/report.js                text formatting for the readouts
├── dev/                                dev-only, never shipped in the pack
│   ├── validate-manifest.mjs
│   ├── verify.mjs
│   └── test/kingdom.test.mjs
├── package.json  tsconfig.json  README.md  .gitignore
```

`state.js`, `store.js` and `report.js` contain no runtime import of `@minecraft/server`
(the store takes the world object as an argument), which is what lets the whole
simulation core be unit-tested in plain Node without launching the game.

---

## Requirements

| Item | Value |
| --- | --- |
| Game | Minecraft Bedrock — the pack asks for engine `1.21.114` or newer |
| Script API | `@minecraft/server` 2.7.0 stable |
| Experimental toggles | **None.** Stable 2.x does not need "Beta APIs" |
| For `/scriptevent` | Cheats/op must be enabled in the world (it is a command) |

---

## Install

### Route A — `.mcpack` (simplest, works on Windows/macOS/iOS/Android)

From this folder:

```bash
cd CivilizationApocalypse_BP
zip -r ../civ-apocalypse.mcpack manifest.json scripts
```

On Windows, from `E:\CivilizationApocalypse`, PowerShell does the same job:

```powershell
Compress-Archive -Path .\CivilizationApocalypse_BP\manifest.json, .\CivilizationApocalypse_BP\scripts -DestinationPath .\civ-apocalypse.zip
Rename-Item -Path .\civ-apocalypse.zip -NewName civ-apocalypse.mcpack
```

(or select `manifest.json` + `scripts` in Explorer, send to → zipped folder, then rename
the `.zip` to `.mcpack`). Double-click the `.mcpack`, or open it with Minecraft. It imports
as "Civilization Apocalypse Behavior Pack".

The zip root must be `manifest.json` — do not zip the enclosing folder itself.

### Route B — copy into `behavior_packs` (Windows Bedrock)

```
%LOCALAPPDATA%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs\
```

Copy the whole `CivilizationApocalypse_BP` folder there (the folder that contains
`manifest.json`, not its parent). If your install is not the Store version, locate the
folder with:

```bash
powershell -NoProfile -Command "Get-ChildItem -Path $env:LOCALAPPDATA\Packages -Recurse -Depth 4 -Filter com.mojang -Directory | Select-Object FullName"
```

### Attach it to a world

1. Minecraft → **Play** → create a new world (or **Settings → Copy** on an existing one).
2. Before creating: **Settings → Resource Packs** is *not* where this goes — use
   **Behavior Packs → Add** on the world's Settings screen and pick
   *Civilization Apocalypse Behavior Pack*. (For an existing world, the same option is in
   its Settings page.)
3. Turn on **Enable Cheats** (required for `/scriptevent`).
4. Join.

---

## Test script

Run these in order; each step states exactly what you should see.

**1. First join seeds the kingdom.**
Chat shows three lines:

```
Welcome to the ruins. Civilization Apocalypse has been founded.
Civilization Apocalypse: 5 districts, 400 civilians, 150 soldiers.
Run /scriptevent civ:status for the full report.
```

**2. Ask for the saved statistics.** Type:

```
/scriptevent civ:status
```

Expected (only visible to you, the requester):

```
=== Civilization Apocalypse ===
Districts: 5
Civilians: 400
Soldiers:  150
-- districts --
Hearthgate: 80 civilians, 30 soldiers
Ironquarry: 80 civilians, 30 soldiers
Whitethorn: 80 civilians, 30 soldiers
Saltmere: 80 civilians, 30 soldiers
Ashfall: 80 civilians, 30 soldiers
```

**3. Persistence.** Quit to title, re-enter the world, run `/scriptevent civ:status` again
→ identical numbers. The join greeting now says `Welcome back, <name>.` instead of
"has been founded" — that is the proof it loaded saved state rather than re-seeding.

**4. State really is on disk.** Leave the world, edit nothing, and rejoin later; the values
are still there. The kingdom lives in the world's dynamic properties, so it also survives
a server restart.

**5. Empty-state path (fresh world, no join yet).** From a command block or the server
console run `scriptevent civ:status` *before* any player spawns. You should get:

```
=== Civilization Apocalypse ===
No kingdom is saved in this world yet.
Reason: no kingdom has been stored yet
Join the world as a player once to seed the starting kingdom.
```

**6. Nothing else listens.** Run `scriptevent civ:anythingelse` → no response, no error.
Handlers are filtered to the `civ` namespace and only act on `civ:status`.

If the pack loads but nothing happens, open **Settings → Storage/Content Log** (or the
dedicated server log) and look for script errors — see troubleshooting below.

---

## Dev verification (no Minecraft required)

```bash
npm install        # typescript + @minecraft/server@2.7.0 types + @minecraft/common
npm run verify     # runs all three gates, reports every one even if an earlier one fails
```

| Gate | What it proves |
| --- | --- |
| `npm run validate` | Manifest structure, real unique UUIDs, entry file exists, the pinned API version equals the installed types version, every relative import carries a `.js` extension and resolves (a missing extension is a silent pack-load failure), and the pack root has no dev junk in it |
| `npm run typecheck` | Every pack script is checked with `checkJs` **strict** against the real 2.7.0 declarations |
| `npm run test` | 14 offline unit tests on the simulation core: starting values, exact population splits, derived totals, validation rejects, seed-once, restart round-trip, corrupt-state recovery, and fail-closed saves |

The typecheck gate was mutation-tested: renaming `initialSpawn` → `initial` (the old 1.x
name) and `getDynamicProperty` → `getDynamicPropertyX` both produced errors at the right
lines, so a green run is meaningful rather than vacuous.

Useful single gates: `npm run validate`, `npm run typecheck`, `npm run test`.

---

## Troubleshooting

- **"Module @minecraft/server version 2.7.0 is not available"** — your game ships a newer
  API. Bump `dependencies[0].version` in `manifest.json` to a version your game supports
  (current stable is listed on the
  [`@minecraft/server` module page](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/minecraft-server?view=minecraft-bedrock-stable)),
  then re-run `npm install` with that version in `package.json` and `npm run verify` — the
  validate gate fails if the manifest pin and the installed types drift apart. Code
  changes are unlikely: everything this pack uses (`scriptEventReceive`, `initialSpawn`,
  dynamic properties) is present from 2.3.0 up.
- **Pack won't apply / greys out** — `min_engine_version` is above your game build; lower it.
- **`/scriptevent` says you lack permission** — cheats are off for that player/world.
- **No welcome message** — the pack must be a *behavior* pack on the world, and the greeting
  fires only on a player's first spawn in a session (`initialSpawn`), not on death respawn.
- **`Script API v2` early-execution errors** — nothing in this pack touches world state at
  module scope; only `subscribe` calls run at load time. If you add code, keep world access
  inside event handlers or after `world.afterEvents.worldLoad`.

---

## Deliberately not in this build

Buildings/structures, combat, NPC or civilian AI, entity spawning of any kind, resource
gathering, multiple kingdoms, UI screens, and any periodic simulation tick. There is no
`system.runInterval` loop yet — the state is static until you act on it.

Seams left for expansion:

- **New kingdom fields** — add them to `createInitialKingdom()` and to
  `findValidationProblems()` in `kingdom/state.js`, then raise `KINGDOM_SCHEMA_VERSION`.
  Loads reject a schema mismatch instead of silently misreading old saves.
- **More commands/events** — add IDs to `SCRIPT_EVENT_IDS` in `config.js` and another
  early-return branch in `commands/status.js`; the `civ` namespace filter already admits them.
- **A simulation tick** — put it in a new `scripts/systems/*.js` and register it from
  `main.js`; `computeTotals()` is the single source of truth for the population figures.
- **Per-district storage** — `createKingdomStore()` takes the world object, so a second key
  (or an entity/block-scoped store) drops in without touching the state module.
- **Real custom slash commands** — `/civ status` via `system.beforeEvents.startup` →
  `customCommandRegistry.registerCommand(...)` is available in 2.1.0+ if you'd rather not
  depend on `/scriptevent`.

## Files created in this foundation

`CivilizationApocalypse_BP/manifest.json`, `scripts/main.js`, `scripts/config.js`,
`scripts/kingdom/state.js`, `scripts/kingdom/store.js`, `scripts/events/welcome.js`,
`scripts/commands/status.js`, `scripts/ui/report.js`, plus `package.json`,
`tsconfig.json`, `dev/validate-manifest.mjs`, `dev/verify.mjs`,
`dev/test/kingdom.test.mjs`, `README.md`, `.gitignore`.
