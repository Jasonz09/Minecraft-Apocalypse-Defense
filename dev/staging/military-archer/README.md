# Archer — opt-in military vertical slice, staging only

This is actual proposed server/client/selection wiring, not a soldier spawner. Nothing in the active or installed packs, worlds or other staged modules was changed. One existing canonical soldier group may be selected as an archer before its normal owner creates it. There is no automatic class mix or replacement of an already living guard.

## Selection and ownership

The old schema1 swordsman selection is decoded and serialized byte-for-byte as before. Schema2 adds only the archer/class/type pair (`civ_trial:archer`); mismatched class/type/schema or unknown future versions refuse. The existing per-group policy returns that selected type consistently to the actual reducer/planning/apply path. Other soldier groups retain the normal golem type. The selection store keeps the same fresh fixture, census, busy/gate and read-back guards.

The public development proposal is the existing selection command with an optional explicit `class=archer`, before confirm. Old command syntax still selects swordsman. The current adapter retains its reviewed Nov3 D1 source contract; it is not a universal new-world freshness detector. A new blank creation-binding fixture does not automatically satisfy that saved-city contract. Root must prepare a new matching pristine clone or separately review an adapter before the first archer trial. Selection cannot convert, delete or retag a living original guard.

Orders excludes the selected group through its existing policy; no new posting/teleport path is added. Existing lifecycle diagnostics recognize both selected custom types with unchanged row/read/event budgets; they report physical events only. No aggregate soldier casualty debit, cohort reconciliation or lossless death capture is implemented.

## Proposed entity and appearance

The new archer retains the current human guard family/collision/30HP/navigation/home radius and exact managed-siege proactive targeting/friendly exclusions. It replaces melee with a documented ranged goal and custom shooter. Initial design values are range10 and reload1.5–2seconds; these are reviewable gameplay defaults, not native balance acceptance or previously approved fixed constants. Home restriction remains12. Existing zombie/illager-only self defense is retained.

A custom arrow uses the documented monster-family impact-damage filter and explicitly ignores player, both villager IDs, golem, swordsman and archer IDs. No vanilla arrow/entity definition is overridden. The projectile expires after five seconds through its own normal entity component; there is no new global/script timer. Proactive target acquisition requires the exact `civbesiege:v1` tag, not a prefix wildcard. A missed arrow can still strike a different monster; projectile damage filtering does not check siege tags. Native friendly-fire and attribution tests remain essential.

The client reuses the project's owned blue human texture and walk/look animations. A new copy of the owned geometry removes the sword and adds a fixed bow; this is explicitly **not** a verified inventory/equippable bow pipeline, drawn-string animation or native attack-pose acceptance. The custom arrow references official built-in arrow geometry/material/texture/controller. No proprietary image was downloaded or copied into the project.

## Primary schema references

* [Pinned Mojang skeleton ranged/shooter example, v1.26.0.2](https://github.com/Mojang/bedrock-samples/blob/v1.26.0.2/behavior_pack/entities/skeleton.json)
* [Official ranged goal properties](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_ranged_attack?view=minecraft-bedrock-stable)
* [Official projectile ignored_entities and impact_damage.filter properties](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitycomponents/minecraftcomponent_projectile?view=minecraft-bedrock-stable)
* [Pinned Mojang arrow client built-in references](https://github.com/Mojang/bedrock-samples/blob/v1.26.0.2/resource_pack/entity/arrow.entity.json)

These support the authored property shapes and references, not runtime acceptance of this custom entity. No external bow attachable is assumed.

## Verification and composition gates

54 focused cases pass,316.1523ms; strict copied-runtime TypeScript passes with original root options. Existing selected-owner/Orders/command/lifecycle controls run through an explicit four-module overlay. Added cases cover archer activation/owner birth, schema pairing/old stamp compatibility, selected Orders preservation, data filter friend exclusions/exact siege tag, arrow safety declarations, bounded geometry UVs and archer diagnostics. Asset checks are static; tests do not emulate Bedrock ballistics, client rendering or native collision. No full suite, package installation or Minecraft trial was run.

Run: `node --import ./dev/staging/military-archer/register.mjs --test dev/staging/military-archer/military-selection.test.mjs dev/staging/military-archer/military-command.test.mjs dev/staging/military-archer/military-lifecycle-diagnostics.test.mjs dev/staging/military-archer/assets.test.mjs`

Typecheck: `npx.cmd tsc -p dev/staging/military-archer/tsconfig.json --noEmit`

The separate creation-binding-v2 and creation-wiring stages currently allow only villager/golem/swordsman in their type tables/death filters. They were deliberately NOT edited here. Before composition, extend those tables/events coherently to archer and rerun their death/owner/generation/fault checks; otherwise the bound owner must refuse this type. No military class should silently bypass that future authority.

## First native acceptance on a disposable copy

1. Back up a matching pristine source, confirm no people activation or selected-group actor, select one exact group with `class=archer` before people-on, and let the existing streets owner alone spawn it.
2. Verify canonical/type/tag uniqueness, exact actor identity/HP and human/bow/arrow rendering with no fresh content-log errors. No manual archer summon/heal/teleport or original-guard conversion counts.
3. In a controlled safe range, test a managed zombie/pillager/vindicator with exact tag and known owner tick window. Measure actual shot/hit/cooldown and projectile source attribution, bounded pursuit and return.
4. Put a player/villager/golem/other guard in a controlled nonlethal line-of-fire test; verify actual HP unchanged. Negative proactive targeting of untagged mobs and friendly retaliation remain separate checks.
5. Save/rejoin and confirm the same representative ID remains, then test stop/LOD through its real owner. Aggregate casualties remain unchanged pending the separate durable cohort integration.
