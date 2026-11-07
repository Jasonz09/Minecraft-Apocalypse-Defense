# Isolated C reach probe — staged only

**Hypothesis test, not an identified cause or production fix.** No installation, world creation, native commands, production edits or UI actions were performed. `BP/` contains only a new data-only manifest and the full current `civ_trial:swordsman` entity definition. Its sole field difference is:

```text
minecraft:behavior.melee_attack.reach_multiplier: 1.5 → 2
```

`require_complete_path` remains **true**. Health30, damage4, cooldown1s, priority3, movement, collision box, home radius/return priority, filtered zombie self-defense, friendly exclusions, managed-siege proactive target filter and canonical owner identity are byte-for-byte preserved. No scripts, functions, spawners, resources or spawn rules are added.

Source SHA256: `C0AB66464976DF1EF0ADE7685C0C5800AB96D4EE0BA8A8AEDAED462098958D82`. The variant is a single literal replacement in those exact source bytes; reversing that literal reproduces the original source bytes. If the production source hash changes, review/rebuild the probe rather than interpreting a stale comparison.

## Basis and limits

The [official melee documentation](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_melee_attack?view=minecraft-bedrock-stable) lists reach_multiplier default2 and notes stricter schema handling from1.26.0. Mojang's [pinned1.26.0 schema](https://raw.githubusercontent.com/Mojang/bedrock-samples/v1.26.0.2/metadata/json_schemas/server/entity/1.26.0/MeleeAttackDefinition.json) specifies a numeric reach multiplier, minimum0, default2. `source-pin.json` records the exact schema URL, Git blob, downloaded SHA256 and reviewed property. These justify a supported isolated setting; they do not prove the current losses are caused by reach.

The multiplier works with entity base size. **2 does not mean a guaranteed two-block attack radius.** Melee still needs a valid target and the attack component; target acquisition, pathing, body sizes, home limits, terrain, timing and gear can affect observed combat. Preserve all those controls for a useful comparison. Static parity is not native entity-definition consumption or path/attack-distance readback.

## Future C stack, only after root review

C pack UUID: `97395889-9805-4903-a863-de65eefd0458`, version `[0,0,1]`; data module UUID `0566c7d7-8f6b-430f-85a4-d907d9b822e2`. It explicitly depends on the unchanged original BP UUID `fd04cb50-dddc-4ebe-83fc-5b5375819bcb` and RP UUID `e634c636-7b98-49f7-81cd-13483bfa3f9f`, both `[1,0,0]`. Keep the original owner BP active so its dynamic-property namespace and sole population owner remain intact.

Expected future priority, highest first:

1. C reach probe.
2. Shared controlled-combat fixture.
3. Original Civilization Apocalypse BP.

Keep the original RP active. **Do not also enable B's complete-path override in C**: both override the same complete entity identifier, so stacking both would obscure which single change was tested. A control uses the same original BP/RP and shared fixture, without either override. UI priority, bindings, exact hashes, fresh content logs and actor identity must be checked; precedence is expected from [official identifier-based overwriting](https://learn.microsoft.com/en-us/minecraft/creator/documents/overwritingassets?view=minecraft-bedrock-stable), not asserted as a verified native readback.

No C world has been made. If root proceeds after the A4/B4 results, create a fresh A/C pair from the same closed full-health baseline, keep the shared fixture/settings/equipment/terrain/operator checks identical, and alter only C's override binding. Verify original guard identity,1/1/1 canonical/type/tag and health30, safe staging height/floor/clearance, one initialized named vanilla adult zombie and successful six-slot clears before engagement. Record exact incoming/outgoing damage and actor survival. No guard spawn, teleport, healing or buffs belong in the comparison. A replacement guard is not survival of the baseline actor. Confounded or duplicate cases must be discarded.

## Standalone verification

`node --test dev/staging/swordsman-reach-override/reach-override.test.mjs`

**5/5 passed**,0 failed/cancelled/skipped,76.0479ms. Checks prove the unique one-field structural difference and byte-exact inverse; complete-pathtrue and every other melee field; all other components and explicit friendly/managed-target controls; data-only scope, unique UUIDs and exact dependencies; and the reviewed primary schema's supported numeric default. These checks make no native combat or full-schema-engine acceptance claim. `pack-hashes.json` records both staged pack files. Production entity remains C0AB unchanged.
