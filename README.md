# Civilization Apocalypse — Bedrock Behavior Pack

A Minecraft Bedrock Edition behavior pack holding a persistent, **autonomous** kingdom in
world storage: 5 districts, 400 civilians and 150 soldiers as starting values, then war,
evacuation, reinforcement, expansion, construction and recruitment simulated on top of them.

These are **simulation records held in saved state — no civilians or soldiers are spawned as
entities, and no city is generated.** Combat, real mobs, NPC AI and physical building are
deliberately not implemented in this milestone.

- Language: JavaScript (no build step — the files in the pack are the source)
- API: `@minecraft/server` **2.7.0** (stable, not beta)
- Storage: world dynamic properties (`civ:kingdom`), which survive save/reload
- Docs: [architecture](docs/ARCHITECTURE.md) ·
  [game design](docs/GAME_DESIGN.md) · [progress](docs/PROGRESS.md) ·
  [testing and the in-game script](docs/TESTING.md)

---

## Layout

```
CivilizationApocalypse/
├── CivilizationApocalypse_BP/          <- the pack: zip THIS folder's contents to install
│   ├── manifest.json
│   └── scripts/
│       ├── main.js                     entry point - subscriptions only, no world access
│       ├── config.js                   every tunable value
│       ├── kingdom/state.js            schema v2, derived totals, save validator
│       ├── kingdom/store.js            persistence, migration statuses, quarantine
│       ├── kingdom/migrations.js       v1 -> v2 upgrade registry
│       ├── sim/                        rng, clock, war, evacuation, construction,
│       │                               expansion, population, policies, tick, scenarios
│       ├── events/welcome.js           player-join welcome
│       ├── commands/                   args, reply, status, inspect, debug
│       ├── integration/                simulationLoop (1 step/hour), buildAdapter (opt-in)
│       └── ui/report.js                all player-facing text
├── dev/                                dev-only, never shipped in the pack
│   ├── verify.mjs  validate-manifest.mjs  e2e-kingdom.mjs  probe-*.mjs
│   └── test/*.test.mjs
├── docs/                               ARCHITECTURE, GAME_DESIGN, PROGRESS, TESTING
├── package.json  tsconfig.json  README.md  .gitignore
```

Everything under `scripts/sim/`, `scripts/kingdom/`, `scripts/ui/` and
`scripts/commands/args.js` contains **no runtime import of `@minecraft/server`** - the store
takes the world object as an argument - which is what lets the whole simulation be unit-tested
and run end-to-end in plain Node without launching the game. A test guards that boundary in
both directions.

---

## Requirements

| Item | Value |
| --- | --- |
| Game | Minecraft Bedrock — the pack asks for engine `1.26.20` or newer |
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

### Route B0 — dev deploy on the current Windows (GDK) install

```bash
node dev/deploy.mjs --dry-run
node dev/deploy.mjs   # copies + sha256-verifies; touches only CivilizationApocalypse_BP
```

Target: `development_behavior_packs` under
`%APPDATA%\Minecraft Bedrock\Users\Shared\games\com.mojang\`. Details in
[docs/MINECRAFT_INTEGRATION.md](docs/MINECRAFT_INTEGRATION.md).

### Route B — copy into `behavior_packs` (legacy Windows Store layout)

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
-- situation --
Time: Day 1, 05:00 (step 5), seed 20261017
Policy: expansion balanced, reinforcements keep 50% at home
Sheltered refugees: 0
Districts under attack: none
Territory: 0 claimed, 0 under military control, 5 unclaimed
Active construction projects: 0
```

**2b. Other readouts.** `/scriptevent civ:district district-3`, `civ:territory`,
`civ:policy`. Invalid input is rejected rather than guessed at - try
`/scriptevent civ:district nope`.

**2c. The kingdom runs itself.** One simulation step is one in-game hour, driven by
`system.runInterval`, not by the game tick. Watch it on demand with
`/scriptevent civ:debug:tick 12` and see what changed in `civ:status`.

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
npm run verify     # runs all four gates, reports every one even if an earlier one fails
```

| Gate | What it proves |
| --- | --- |
| `npm run validate` | 231 checks: manifest structure, real unique UUIDs, entry file exists, the pinned API version equals the installed types version, every relative import carries a `.js` extension and resolves, and the pack root has no dev junk in it |
| `npm run typecheck` | All 24 pack scripts checked with `checkJs` **strict** against the real 2.7.0 declarations |
| `npm run test` | 148 offline unit tests across 10 files: starting values, population splits, derived totals, validation, seed-once, restart round-trip, migration, quarantine, siege/evacuation/fallback/construction/expansion/population/policy behaviour |
| `npm run e2e` | A headless 52-stage kingdom run: migrate a v1 save, hold the realm, take a siege, evacuate, reinforce, counterattack, win beyond the border, claim and plan new land, be refused by a shortage, build, recruit, reload, and replay identically |

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

## Deliberately not in this milestone

Physical city generation, entity spawning of any kind, melee combat against real mobs, NPC
or civilian AI, iron golems and wolves, multiple kingdoms, UI screens, and player-driven
building. The kingdom is simulated as records: walls, districts and armies exist in saved
state, not as blocks and entities in the world. The one exception is opt-in and off by
default: `scripts/integration/buildAdapter.js` can materialise a project's next stage as
blocks, and refuses to run until it is enabled and given an anchor by hand.

Seams left for the next milestone:

- **New kingdom fields** — add them to `createV2Kingdom()` and to `findValidationProblems()`
  in `kingdom/state.js`, then raise `KINGDOM_SCHEMA_VERSION` and register an upgrade in
  `kingdom/migrations.js`. A schema mismatch is refused rather than silently misread, and the
  original save is quarantined before anything is rewritten.
- **New autonomous decisions** — `sim/policies.js` is the single place where the kingdom
  chooses, bounded to one decision per district per step.
- **More commands/events** — add IDs to `SCRIPT_EVENT_IDS` / `DEBUG_EVENT_IDS` in `config.js`;
  the `civ` namespace filter already admits them.
- **Physical building** — `collectBuildQueue()` is the read-only seam between a plan and the
  world; only the adapter consumes it.
- **Per-district storage** — `createKingdomStore()` takes the world object, so a second key
  (or an entity/block-scoped store) drops in without touching the state module.
- **Real custom slash commands** — `/civ status` via `system.beforeEvents.startup` →
  `customCommandRegistry.registerCommand(...)` is available in 2.1.0+ if you'd rather not
  depend on `/scriptevent`.

## Verification status

Four offline gates green: 231 manifest/packaging checks, strict typecheck against the real
2.7.0 declarations, 148 unit tests, and a 52-stage headless end-to-end kingdom run.
**Nothing has been run inside Minecraft** — it is not installed on the machine that built
this. `docs/TESTING.md` carries the in-game script for when it is, and `docs/PROGRESS.md`
lists the defects found and fixed during this milestone along with the remaining risks.
