# Isolated swordsman prototype

This folder is a reviewable prototype, **not part of the active or installed pack**. No active pack, existing test, world or population record is changed. The standalone BP contains a custom entity definition only: no script, spawn rules, spawn egg, independent soldier spawner, replacement routine or casualty debit.

## What is present

- `BP/`: format 1.26.20 custom `civ_trial:swordsman`, data-module manifest and exact-version RP dependency draft.
- `RP/`: matching client definition, render controller, original human model, walk/look/attack animation definitions and original 64×32 pixel texture. A blue medieval tabard, steel helmet, visible face and sword distinguish the guard. The sword is **fixed model geometry attached to the right arm**, not accepted item equipment, inventory, attachable rendering or loot.
- `group-type-resolver.mjs`: pure integration draft selecting **one explicitly named existing soldier group**. Off by default. No class proportions or soldier-count changes. Fresh activation refuses an already admitted selected group; rehydrating an already verified selection preserves its canonical group ID.
- `prototype.test.mjs`: standalone checks against the real pure group table plus asset/filter contracts.
- `validation/`: pinned, unmodified official schema snapshots, provenance and an honest schema report.

The combat definition selects only zombie-family entities carrying the exact existing siege-owner marker `civbesiege:v1`. It also explicitly excludes player, villager, iron-golem and guard families, including mixed-family targets. There is no unrestricted retaliation behavior. The common marker is confirmed in `scripts/integration/siegeMobs.js`; `has_tag` does not do namespace-prefix matching. This first slice intentionally does not attack skeletons, pillagers, unrelated natural zombies or future civilizations.

Damage 4, health 30, a one-second attack cooldown, acquisition range 10, target-follow limit 12 and home restriction radius 12 are **trial values**, not accepted military balance. The home component remembers the spawn position, and `all_movement` is intended to limit pursuit around that position. A higher-priority return-home behavior is included. Doors are not opened/broken, and no wandering goal is included. Physics, knockback, terrain and save/reload can still defeat assumptions; these limits are not claimed as a tested hard spatial fence.

## Reproduce the offline checks

Run these commands from this folder:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
node generate-assets.mjs
node --test prototype.test.mjs
node validate-schemas.mjs
```

Optional local geometry inspection (Pillow required): `python preview.py`. The included `preview.png` was checked for a visible blade outside the arm and a readable human face. It is an offline rest pose, not a screenshot from Minecraft.

The generator is deterministic and writes only `BP/` and `RP/` beside itself. It uses original procedural pixels and explicit UV faces; no proprietary game texture or vanilla model is copied. The renderer, if used, is a geometry preview and does not validate Minecraft rendering.

Initial results: **9/9 tests passed, zero failures or skips**. The schema tool recognizes all **19 components** in pinned official 1.26.20 metadata: **6 have structured schemas; 13 are dynamic/unconstrained**. A negative control rejects an invalid string melee cooldown.

**The unmodified official filter metadata does not pass.** `Filter Group` uses `oneOf(Test, Array, Map)`, while `Filter Group Map` accepts every unknown property. A valid leaf test therefore also matches the map and violates `oneOf`. The report retains the raw errors. The validator then closes only that map to its documented operator keys **in memory**, which strengthens the map branch and removes the overlap; cached official files stay unchanged. The structured checks pass with this explicitly recorded correction. This is not an unmodified full-schema pass, nor a full entity/client/Molang engine parser. Offline filter truth-table tests separately exercise the actual prototype filter.

## Required owner integration before the first native test

1. Freeze/backup the accepted city checkpoint; create a separate fresh trial copy. Keep the ordinary people switch off while selecting the group. Both asset packs must be explicitly enabled there; do not deploy this prototype into the current authoring world.
2. Verify the normal owner census and real derived group table. Select exactly one canonical `sol` group before it becomes physical. `prepareTrialSelection` requires an explicit fresh-trial assertion and census; it is not itself a proof that a caller inspected the world. Refuse an existing golem/custom representative for that group. Do not remove or convert it.
3. Persist a bounded, versioned, verified selection in the normal owner integration, with refusal for corrupt/unknown selection versions. The draft has **no persistence adapter**. Rejoin must reload that same selection; do not rerun fresh activation on a group that is now physical. The resolver defensively copies the selected ID into its closure.
4. Thread the same resolver through `population/reconcile.js` where spawn actions currently use `POP_ENTITY_TYPES[detail.kind]`, then through the existing `integration/popSync.js` action application. Keep streets/popSync as the **only** population creation/removal owner, with unchanged identity tag `civpop:v1:<groupId>`, LOD/caps, loaded-ground checks and operation budgets. The resolver must be supplied to type-aware adoption/validation as well as creation. A conflicting existing type is a refusal, not permission for a replacement.
5. Update the `peopleOrders.js` fixed `LEVY_TYPE` census assumption before enabling the selected class under ordinary orders. Until home/post semantics are reconciled, disable order-driven teleporting for the selected trial group instead of resetting its home accidentally. Naming/status/teardown must still use the admitted canonical group, never a second entity list or spawner.
6. Choose one packaging approach after review: copy entity data into the main BP and add a data module plus the RP dependency while preserving existing script modules, or explicitly enable this separate data BP/RP alongside the main BP in the trial copy. The supplied manifest UUIDs belong only to this isolated draft; this folder is not automatically shipped.

## First native acceptance (not run)

1. Content log has no entity, component, Molang, texture, model or render-controller errors on the installed 1.26.20-compatible engine. The normal owner produces one visibly human swordsman with a visible sword; civilians and all unselected soldiers retain their existing types and counts.
2. Record the entity ID, canonical group tag, selected-group metadata and represented headcount. Reconcile several times: exactly one representative for that group, no added soldier population, no live golem replacement.
3. Place a friendly villager, player and existing friendly guard/golem nearby. No friendly target acquisition or retaliation, including after an accidental friendly hit. Test both a natural zombie without the marker (ignored) and a zombie created/tagged by the existing siege owner (eligible); no separate attacker spawner is supplied here.
4. On a loaded, flat, enclosed trial area, observe actual damage timings and hit cooldown against the managed zombie, weapon visibility/swing and zombie counterattack. The `irongolem` family is included for vanilla hostile recognition; that interaction needs native proof.
5. Move the managed target beyond acquisition/follow limits and beyond the guard's original home radius. Confirm pursuit stops and return behavior works, including corners, water, blocked doors and knockback. Home restriction is centered on the original spawn, not a dynamically issued command post.
6. Unload/reload the chunk, then save/quit/rejoin. Re-run the owner census: identity/selection remain, no duplicate representative or accidental default golem appears. Repeat gate-off teardown through the sole owner.

**Casualties are not implemented.** The current derived soldier group normally represents five people, with a partial final group possible. Entity death must not automatically imply a one-person or five-person debit. Before lethal acceptance, agree represented-headcount semantics and integrate generation-specific, durable death receipts with existing simulated defender losses, atomic debit/receipt consumption and restart replay. Never infer death from missing/unloaded entities. Until that work is complete, the current owner could respawn a dead representative without reducing soldiers; this prototype must not be described as a finished casualty/combat system.

## Primary references

Checked November 5, 2026. Schema snapshots are pinned to Mojang commit `15701fa9c13923f12662984c32c124327e40e3d3` and select engine format **1.26.20**, rather than copying newer sample entities wholesale.

- [Official versioned entity schemas](https://github.com/Mojang/bedrock-samples/tree/15701fa9c13923f12662984c32c124327e40e3d3/metadata/json_schemas/server/entity/1.26.20)
- [Melee attack and cooldown](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_melee_attack?view=minecraft-bedrock-stable)
- [Target selection and follow radius](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_nearest_attackable_target?view=minecraft-bedrock-stable)
- [Home restriction](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitycomponents/minecraftcomponent_home?view=minecraft-bedrock-stable)
- [Return home behavior](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_move_towards_home_restriction?view=minecraft-bedrock-stable)
- [Exact has_tag filter](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/filters/has_tag?view=minecraft-bedrock-stable)
- [Legacy pushable removal in 1.26.10](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitycomponents/minecraftcomponent_pushable?view=minecraft-bedrock-stable)
- [Official entity/client asset structure](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoaddentity)
- [Official animation and Molang linkage](https://learn.microsoft.com/en-us/minecraft/creator/documents/animations/animationsoverview?view=minecraft-bedrock-stable)

All original prototype model/texture/code assets were created for this project. Official metadata remains attributed to Mojang/Microsoft; see `validation/MOJANG-LICENSE.md`.
