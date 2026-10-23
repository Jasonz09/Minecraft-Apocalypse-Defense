# Commander's Ledger - implementation plan (presenters and runtime built; wiring reverted)

Gate: no Ledger code may be deployed until the enlarged Hearthgate has passed its first in-game test. Presenters and runtime are committed and unwired; the wiring is reverted (see Status below).
The existing script-event commands stay as developer/debug tools.

## Compatibility findings (research, medium-high confidence)
- Manifest: add `{ "module_name": "@minecraft/server-ui", "version": "2.1.0" }` beside `@minecraft/server` 2.7.0 (stable, peer deps
  `@minecraft/server ^2.0.0`; no experimental toggle). 2.2.0 is newer but wants a higher `min_engine_version` - stay on 2.1.0
  (matches our 1.26.20 floor). Add the typings to devDependencies at the same version so strict typecheck covers the UI.
- Forms: `ActionFormData` (buttons, header/label/divider), `MessageFormData` (two buttons, confirmations), `ModalFormData`
  (toggle/slider/dropdown/text). `show(player)` is a Promise, never callable from a beforeEvent (restricted mode). Handle
  `response.canceled` and `FormCancelationReason.UserBusy` (chat or another UI open): retry every ~10-20 ticks for ~100 ticks.
  No documented button cap: keep pages <= ~20 buttons and paginate. Button icons need a resource pack, so use text only.
- Item: use a VANILLA item (book/clock/compass) renamed with `nameTag`, `setLore`, a dynamic property `ca:ledger`, `lockMode =
  inventory`, `keepOnDeath = true`. Identify by typeId + property. A custom item JSON needs a resource pack for texture/name and
  its placeholder behaviour is unverified, so it is avoided.
- Open: `world.afterEvents.itemUse` (not beforeEvents); defer `show()` with `system.run`; debounce 5-10 ticks (a book can fire
  itemUse while targeting a block); one form in flight per player (Set of player ids); wrap `show()` in try/catch (player leaves).
- Give/recover: `inventory.container.addItem` (returns leftover -> `dimension.spawnItem` at the player), scan slots for an existing
  ledger first, recovery command `civ:ledger`, optional first-join grant idempotent via a PLAYER dynamic property.

## Architecture
- `scripts/ledger/` pure presenters (build menu models `{title, lines[], buttons[{id,label,enabled,reason}]}` from the kingdom; fully
  unit-tested offline, no `@minecraft/server`), `scripts/ledger/runtime.js` (runtime: item events, form rendering, navigation
  stack, busy-retry, debounce), `scripts/commands/ledger.js` (`civ:ledger` recover). Actions call the SAME functions the commands use
  (policy setter, `openRecruitment`, gate adapter, civ generation job control), never a parallel implementation.
- Every action that changes the world or kingdom asks a `MessageFormData` confirmation naming the effect; results are shown
  with a clear success/refusal message and a Back button. Short bullet summaries; no fake actions.

## Menus and what is real today
| Menu | Content (real data/actions) | Unavailable (shown disabled with a reason) |
| --- | --- | --- |
| Kingdom | totals (civilians, soldiers, districts), game time, policy, territory counts, refugees | - |
| Military | per-district soldiers, front/reserve garrison, training queue, security/assault; action: open recruitment (existing rules) | commanders, golems/wolves, patrol orders (future roadmap) |
| Districts | district cards, shelter/headroom, stores, buildings, neighbours, physical state, gates per district | per-district building orders |
| Construction | staged projects and queue, civ generation status/progress, actions: resume/abort generation, show coordinates + teleport command | placing arbitrary buildings, districts 2-5 (dev gate) |
| Expansion | territory list/status, eligibility reasons, expansion mode | manual claims (expansion is autonomous) |
| Diplomacy | - | entirely unavailable: no other kingdoms exist; shown as "not implemented" |
| Reports | recent event log, battle log, last invasions summary | invasion forecasts |
| Policies | expansion mode (balanced/paused/rapid), reinforcement reserve fraction (read), gate mode per gate (auto/open/closed) | per-district policies |

## Phases
1. Pure presenters + tests (menus, disabled reasons, pagination, formatting, no fake actions test: every enabled button maps to a real function).
2. Runtime UI with a fake `@minecraft/server`/`-ui` harness: item use, busy retry, navigation stack, debounce, concurrency of players, recovery.
3. Manifest dependency + typings, deploy, manual in-game checklist (open, back navigation, confirmations, recovery after dropping/deathless loss, full inventory, two players).
4. Independent safety/code review; update docs.

## Remaining dependencies
Enlarged Hearthgate in-game pass; functional gate controls verified in-game; civ generation status/abort/resume commands stable;
decision on first-join grant (default: off, grant only by `civ:ledger`).

## Status (reverted state)
Presenters (`scripts/ledger/`, tested), the injected-dependency runtime (`scripts/ledger/runtime.js`, tested) and the
recovery id `civ:ledger` are committed. The wiring (`integration/ledgerBindings.js`, dev-gated `civ_ledger_dev`) and the
manifest dependency on `@minecraft/server-ui` 2.1.0 were REVERTED (commits ee819b4 and a9dcd0f, reverting 6e24380 and 5026111) because they changed the
original reliability-runtime tests (subscriber count, harness). Re-adding them needs an explicit decision on those
expectations. Nothing here is verified in game.
