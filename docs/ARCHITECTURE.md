# Architecture

## The one rule that makes this testable

The simulation core never imports the Minecraft runtime. `scripts/sim/*`,
`scripts/kingdom/*`, `scripts/ui/*` and `scripts/commands/args.js` contain **no runtime
`import ... from "@minecraft/server"`**, so the entire kingdom — siege, evacuation,
construction, expansion, growth — executes in plain Node. `dev/test/integration.test.mjs`
enforces this by scanning those directories and asserting the absence, with positive and
negative controls for the pattern; a misplaced import fails the suite.

The Bedrock boundary is deliberately thin:

```
scripts/main.js                      entry, subscribes everything
scripts/events/welcome.js          -> world.afterEvents.playerSpawn (initialSpawn)
scripts/commands/status.js         -> system.afterEvents.scriptEventReceive (civ:status)
scripts/commands/inspect.js        -> civ:district / civ:territory / civ:policy
scripts/commands/debug.js          -> civ:debug_* (tick, scenarios, scenario, build)
scripts/commands/reply.js          -> Player.sendMessage / world.sendMessage
scripts/integration/simulationLoop.js -> system.runInterval(1000 ticks) + save
scripts/integration/buildAdapter.js   -> Dimension.getBlock / setBlockType (opt-in)
```

`scripts/commands/args.js` holds the argument parsers separately from `reply.js` for
exactly this reason: they are pure, and the first version of this file put them next to the
chat code, which made them untestable offline and broke the test runner.

## Persistence model

`kingdom/store.js` stores the whole kingdom as one JSON string in the world dynamic
property `civ:kingdom`, and classifies every read:

`ok | absent | corrupt | invalid | migrated | newer | unsupported`

- **`migrated`** — a schema older than the current one is run through
  `kingdom/migrations.js` (v1 → v2 today, a registry keyed by source version). Before the
  upgraded state is written, the original payload is copied to `civ:kingdom-quarantine`. A
  valid player's progress is therefore never reseeded.
- **`newer` / `unsupported`** — the save is left byte-for-byte untouched and the player is
  told (`formatRefusedKingdomLines`). Nothing overwrites a schema it cannot read, and
  `save()` itself throws rather than downgrade a newer save.
- **`corrupt` / `invalid`** — quarantined first, then a fresh kingdom is seeded.

`serializeKingdom` validates before writing, so an invalid state cannot reach disk;
`store.save` on a malformed kingdom throws and leaves the previous bytes intact (tested).

## Simulation step

`sim/tick.js` fixes the order of one step:

```
war -> evacuation -> construction -> expansion -> policies -> population -> training
```

A step is an **in-game hour** (`SIM.stepTicks = 1000`; Minecraft is 24000 ticks/day, so 24
steps/day — `sim/clock.js` is the only place that knows this). The interval loop, not the
game tick, drives it, so cost is one bounded step per hour.

`advanceKingdomStep` snapshots the state, runs the systems, then calls
`findValidationProblems`. If the step produced a state the save layer would reject, the
step is **rolled back** and reported (`skipped`, `rejected[]`) instead of persisted
half-applied. The loop refuses to save a skipped step.

`advanceKingdom(kingdom, steps)` clamps `steps` to `SIM.maxCatchUpSteps` and rejects
non-integers, so no caller can start an unbounded catch-up.

## Determinism

`sim/rng.js` is mulberry32 over `kingdom.rngState`, a plain integer that travels in the
save. Every random decision draws from it and writes the advanced cursor back. Same seed +
same number of steps therefore yields a byte-identical kingdom (asserted in
`integration.test.mjs` and in the end-to-end run), and a different seed diverges. No system
calls `Math.random`.

## Economy and policies

`sim/policies.js` is the layer that makes the kingdom *autonomous* rather than merely
reactive. Per step, bounded to one decision per district:

- `runEconomyStep` — work gangs (one per 20 available civilians) produce materials,
  storehouses produce supplies, capped by a stockpile ceiling. Without this, only farms
  produced anything and every store could only ever fall.
- `runExpansionPolicy` — land opened by a victory outside the border is moved from
  `raided` to `military`, which is what `sim/expansion.js` needs before it can claim. A
  `paused` policy stops this entirely.
- recruitment — a secure district with a food surplus and supplies to equip them sends up
  `recruitBatchPerStep` into the training queue until it holds `garrisonTargetFraction` of
  its population.
- development — secured land schedules `farms` when its farms cannot feed it, `homes` at
  85% shelter, and storehouses/barracks when short; nothing is scheduled that cannot pay
  for its first stage.

## Saved-state bounds

The kingdom is one blob in a size-limited dynamic property, so growth is capped by
construction: `SIM.eventLogLimit` and `SIM.battleLogLimit` bound the logs, and
`tick.pruneCompletedProjects` keeps only `COMPLETED_PROJECT_HISTORY` finished project
records per district (their effect already lives in `district.buildings`). Measured over
400 autonomous steps: peak serialised size **≈15 KB**, never a rejected step.
`world.getDynamicPropertyTotalByteCount()` is the in-game instrument for this.

## Early execution

Script API v2 runs pack scripts in *early execution*, where touching world state throws.
Module scope in this pack therefore only ever builds plain objects and calls
`subscribe`/`runInterval`; every world read or write happens inside an event callback. Note
that `registerScriptEvent` does not exist in 2.x — inbound `scriptevent` traffic is
filtered at subscribe time with `{ namespaces: ["civ"] }`.
