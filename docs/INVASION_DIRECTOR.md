# Invasion director

Gate: the director acts only when `kingdom.invasion` exists with `enabled: true`. Nothing in the shipped pack creates or
enables that record, and no command sets it (`enableInvasion` has no callers). Enabling it therefore needs code or a
development build; it is not reachable from chat.

Status: built, tested offline, **wired into the tick as a no-op and disabled by default**. `sim/tick.js`
calls `runInvasionDirectorStep` every step; it returns nothing unless `kingdom.invasion` exists, and nothing
in the shipped pack creates that record yet (`enableInvasion` has no callers). Roadmap section B asks for this; see [ROADMAP.md](ROADMAP.md).

The director is a staged, seeded planner that drives the existing war simulation in `sim/war.js`.
It never spawns entities, never reads the world, and never touches walls or population directly.
Physical outcomes still come from the numbers in `war.js`; the director only decides when waves
arrive, where, and how big they are.

## Files

| File | Role |
| --- | --- |
| `CivilizationApocalypse_BP/scripts/sim/invasion/director.js` | State machine, planner, `INVASION_DEFAULTS`, `runInvasionDirectorStep` |
| `CivilizationApocalypse_BP/scripts/sim/invasion/composition.js` | Composition table (data), `INVASION_LIMITS`, strength arithmetic |
| `CivilizationApocalypse_BP/scripts/sim/invasion/apply.js` | `applyDirectives` / `applyDirectivesDetailed`: the only writer |
| `dev/test/invasion-director.test.mjs` | 15 deterministic tests |

Plain Node: no `@minecraft/server` import, no `console`, no randomness outside the seeded cursor.

## Gate and the disabled path

- `kingdom.invasion` absent: `runInvasionDirectorStep` returns `[]` and reads nothing it could change.
- `kingdom.invasion.enabled !== true`: the same. The record is returned untouched.
- `INVASION_DEFAULTS.enabled` is `false`, and `createInvasionState` makes disabled records by default.
- `enableInvasion(kingdom)` is the explicit opt-in. Nothing calls it.

Test `a kingdom with the director absent or disabled serialises byte for byte the same` runs 400
steps three ways and compares the saved JSON.

## Stages

One invasion runs at a time. A step moves the stage along one edge of the table below. The only
exception is a district that falls while the band reaches the wall, which goes straight from
`approach` to `aftermath` in that step.

| Stage | What happens | Ends when |
| --- | --- | --- |
| `quiet` | A periodic activity is due at `nextEventStep`. The planner rolls raid or major, a district, a bearing, a wall section or gate, and a composition. | An activity starts (-> `scouting`) |
| `scouting` | A `scout` directive announces the host and its bearing. Nothing lands. | `scoutSteps` (2) |
| `approach` | The group marches. While a player is within `physicalRadius` (96 blocks) it is flagged `physical`. | `approachSteps` (3 to 5 drawn), or `regroupSteps` (2) between strikes |
| `assault` | Each step lands at most one chunk of the current strike as a `spawn` directive. When the strike is in and `district.assault` reaches 0, the next strike regroups, or the wave moves on. | Last strike spent (-> `aftermath`), a fall (-> `aftermath`), or `maxAssaultSteps` (40, a backstop) |
| `aftermath` | The war's own counterattack and recovery run. A breach or a fall raises an `alarm` directive. | `aftermathSteps` (6) |
| `cooldown` | Rest. | `cooldownSteps` (12), then `quiet` with a new `nextEventStep` |

Allowed changes are listed in `PHASE_EDGES` and checked on every step of the long-run test.
A district that falls while the band marches goes straight from `approach` to `aftermath`.

Timing: one step is one in-game hour. Periodic activity is due every 48 to 96 steps (2 to 4 days).
Majors are rarer: a 25% chance per due activity, at least 240 steps (10 days) apart, and no more than
two starting in any 720-step window.

## Compositions

Strength is in raider-equivalents, the unit of `district.assault` in `war.js`.

| Id | Kind | Strikes | Raiders | Archers (2) | Brutes (3) | Strike strength | Invasion cap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `probe` | raid | 1 | 3-6 | 0 | 0 | 3-6 | 6 |
| `skirmish` | raid | 1 | 6-9 | 0-2 | 0 | 6-13 | 13 |
| `warband` | raid | 1 | 8-12 | 1-3 | 0-1 | 10-21 | 21 |
| `siege-host` | major | 2 | 10-14 | 2-4 | 1-2 | 17-24 (capped) | 40 |
| `great-host` | major | 3 | 8-12 | 2-3 | 1-2 | 15-24 | 48 |

A roll that is too large is trimmed deterministically: brutes first, then archers, then raiders.
`validateCompositions()` checks the table; the tests fuzz 800 rolls per composition against the caps.

## Caps

| Cap | Value | Enforced in |
| --- | --- | --- |
| Directives per tick | 4 | planner and `applyDirectives` (excess is refused in order) |
| Strength landed per tick, whole kingdom | 8 | `applyDirectives` (refusal) |
| Strength landed per district per tick | 6 | planner (chunk budget) and `applyDirectives` (refusal) |
| Strength in one strike | 24 | planner fitting |
| Units of one type in one strike | raider 16, archer 6, brute 3 | planner fitting, `applyDirectives` checks the counts |
| District assault after landing | 32 | planner (room), `applyDirectives` (refusal) |

So a 24-strength strike needs four steps to land. No army arrives in one step.

The 32 cap mirrors `ASSAULT_CAP` in `war.js`, which is not exported. A test drives `spawnThreats` and
checks that a press on a district at 30 lands exactly on 32.

## Directives

`applyDirectives(kingdom, directives)` returns the events it produced and logs them to `kingdom.log`.
`applyDirectivesDetailed` also returns one result per directive.

| Kind | Fields | Effect |
| --- | --- | --- |
| `scout` | `districtId`, `waveId`, `bearing`, `label`, `target` | A sighting event. No state change. |
| `spawn` | `districtId`, `waveId`, `strikeIndex`, `counts`, `strength` | `district.assault += strength`, then `war.updateAlertState` escalates the security level. `strength` must equal the sum of the counts. |
| `alarm` | `districtId`, `waveId`, `reason` (`breached` or `fallen`) | A sirens event. Evacuation still follows the security state. |

Anything else is refused with an event and changes nothing. Refusals are also logged, since a refused
directive is a planner bug or a bad caller. Test `an invalid directive is refused with an event and
changes no district` covers 13 kinds of bad input, and the per-tick caps.

`war.js` exports no function that lands a directed band, so the single `assault` increment lives in
`apply.js`. It calls `defensiveStrength` for the event text and `updateAlertState` for escalation.

## Determinism and purity

- The director has its own cursor, `state.rngCursor`, seeded from the invasion seed. It never draws
  from `kingdom.rngState`, so enabling it cannot shift the war's stream.
- `nextDirectorState(state, kingdom, rng, options)` returns `{ state, directives, events }`. It writes
  nothing to the kingdom or the input. The same inputs give the same output.
- `stepInvasion(kingdom, options)` is the one writer: it plans, applies, stores `kingdom.invasion`,
  and logs.
- All state is JSON-safe, so a save and reload mid-assault resumes identically (tested).

## Distance and the physical flag

`options.proximity` maps a district id to the distance in blocks from the nearest player, or `null`
when no player is in the loaded area. Missing entries count as far. A group within `physicalRadius`
is flagged `wave.physical` and announced. The flag is for the entity layer. Outcomes still come from
the numbers in `war.js`, so nothing depends on it yet.

## Persistence

`kingdom.invasion` holds the whole record: stages, the wave in progress, the planned strikes,
delivered counts, the last 12 outcomes, and the cursor. `validateInvasionState` checks its shape.
`findValidationProblems` in `kingdom/state.js` does not check it yet. A damaged record is refused by
the planner with one event and changes nothing. Recreate it with `createInvasionState` to recover.

## Integration (for the integrator)

The tick call is already in place (commit aa8977d). It sits inside the `try` block, after the step counter
moves and before `runWarStep`:

```js
import { runInvasionDirectorStep } from "./invasion/director.js";
// ...
events.push(...runInvasionDirectorStep(kingdom));           // or { proximity } from loaded players
events.push(...toEvents(runWarStep(kingdom)));
```

Placing it inside the `try` means a rolled-back step also rolls back the director. Turning it on needs
`enableInvasion(kingdom)` once, from a command or a setup step. Until then it changes nothing.

`dev/test/invasion-director.test.mjs` runs the same order (`tick()` in the test file), so its long runs
exercise the wiring. The test file's `tick()` copies `advanceKingdomStep` and is checked against it when
the director is absent, so the copy cannot drift silently.

## Measured behaviour (full tick pipeline, six seeds, 3000 steps each)

Measured with the director wired as in the integration section. These numbers were taken from
throwaway scripts, not committed.

- 27 to 30 waves per seed, 1 to 3 majors per seed. The save validator never refused a step.
- Outcomes over all 164 finished waves: 131 `repelled`, 26 `breached`, 10 `fallen`. A wave whose target falls before it lands is recorded as `withdrawn`. Seed 424242 is
  the breach-heavy one (8 breached, 2 fallen of 27), as its walls wear down.
- District-loss entries (a district becoming `lost`): 75 without the director, 91 with it. The
  baseline already loses districts repeatedly under the siege deadlock in ROADMAP section C. The
  director adds about a fifth more losses on top of that.
- First district loss: step 251 on the default seed with and without the director. On the other
  seeds it came between steps 1282 and 1712 without the director, and between 1296 and 1608 with it.

Recommendation: keep the director disabled until the siege balance fix lands, then re-measure and
tune `INVASION_LIMITS` and the composition strengths against the loss count above.

## Not done

- Directed landings in `war.js`: the director writes `assault` itself, under the mirrored cap.
  Exporting `ASSAULT_CAP` and a landing function from `war.js` would remove the duplicate.
- Chunk-loaded checks, entity materialisation and per-player entity budgets: the entity layer's job.
  It reads `kingdom.invasion.wave` (`physical`, `districtId`, `target`, `bearing`).
- `kingdom/state.js` validation of `kingdom.invasion`.
- Gate-specific effects: `target.kind === "gate"` is recorded and announced but changes no gate.
