# Isolated complete-path combat probe

Prepared only under `dev/prototypes`; not installed, imported, activated or used in a world by this preparation. Production BP/RP files stay unchanged. The `BP` folder contains exactly a manifest and the full current swordsman entity definition, with **one entity-field difference**: `minecraft:behavior.melee_attack.require_complete_path` is `false` instead of `true`.

Source entity SHA256: `C0AB66464976DF1EF0ADE7685C0C5800AB96D4EE0BA8A8AEDAED462098958D82`. This is the combined self-defense/render revision verified by the 1,657-test full pipeline. The probe must be reviewed/rebuilt if that source changes. The supported native animation RP remains required, unchanged.

This is not a candidate production fix yet. A zombie killing a guard does not prove the guard dealt zero damage. The home/target filters, friendly exclusions, attack damage, cooldown, priority and movement bounds remain identical. No new guard spawner, script, timer, event handler or population store exists in the probe.

## Identity and pack stack

Keep the original behavior pack active: UUID `fd04cb50-dddc-4ebe-83fc-5b5375819bcb`, version `[1,0,0]`. It alone owns the saved kingdom, selection, cursor and normal actor creation. Replacing that BP with a new script-pack UUID would lose its saved dynamic-property namespace, invalidating the comparison. The probe is a separate **data-only** pack, UUID `c8644dda-e2b4-46cc-b2cb-5b72f5d972c9`, version `[0,0,1]`; its module UUID is distinct. It depends explicitly on the original BP and RP.

In copy B, the Active Behavior Packs UI must show **Civ Swordsman Path Probe (Isolated) above Civilization Apocalypse Behavior Pack**. Copy A has the original BP only. Both have the original RP UUID `e634c636-7b98-49f7-81cd-13483bfa3f9f`, `[1,0,0]`.

Intended B behavior binding order, highest first:

```json
[
  {"pack_id":"c8644dda-e2b4-46cc-b2cb-5b72f5d972c9","version":[0,0,1]},
  {"pack_id":"fd04cb50-dddc-4ebe-83fc-5b5375819bcb","version":[1,0,0]}
]
```

These are instructions/example metadata, not edits to any world. Use the actual UI to confirm the resulting priority and dependencies; do not rely on a JSON array alone as proof that the engine consumed this entity definition. Confirm the original BP appears exactly once, the new module has no scripts, and native `military status`/`inspect` still read the existing selected group and same canonical baseline actor.

Microsoft documents that behavior packs stack and recommends moving an overriding pack above others, and that BP entities can be overwritten by identifier. Those sources justify this test's expected precedence. They do not independently prove which definition a particular live world has consumed. Record UI priority, exact files/hashes and fresh content-log errors before interpreting B; if a content log provides no positive definition trace, report that limitation rather than claiming a native readback or compare-and-swap guarantee.

- [Behavior pack stacking and priority](https://learn.microsoft.com/en-us/minecraft/creator/documents/behaviorpackfromscratch?view=minecraft-bedrock-stable)
- [Identifier-based entity overwrites](https://learn.microsoft.com/en-us/minecraft/creator/documents/overwritingassets?view=minecraft-bedrock-stable)
- [Melee path requirement](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_melee_attack?view=minecraft-bedrock-stable)
- [Home-return eligibility](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_move_towards_home_restriction?view=minecraft-bedrock-stable)

## Discriminating native comparison (operator only)

1. With Minecraft closed, preserve the full-HP peaceful baseline and create A/B copies from that **same** closed snapshot. Record baseline hashes. Preserve the original BP/RP and all saved owner properties. No manual guard spawn, conversion, relocation or teleport is part of this test.
2. Keep A/B settings equal: Normal, natural mob spawning disabled, night/time matched, only one controlled vanilla zombie, observer Spectator. Record selected canonical guard ID, live health 30 and live position before each encounter. A is complete-path `true`; B adds only the higher-priority probe pack with `false`.
3. Enable session-only military lifecycle diagnostics and inspect the selected group before introducing the attacker, so the current exact canonical actor is bound. Confirm no pre-existing zombie within 12 blocks. Introduce the same single vanilla zombie at the same guard-relative one-block offset as the prior trial. Do not tag it as a siege attacker: that would add another changed condition.
4. Observe both actors continuously, keeping the terrain and camera comparable. Record guard ID/health over time, displacement relative to the original spawn/home, clear attack/hurt flashes, attacker presence, and exact lifecycle events/cause. A replacement actor is a new trial subject; it cannot be counted as survival of the original.
5. Interpret cautiously: B delivering clear damage or surviving where A repeatedly fails supports a path-condition effect. Both losing does not isolate target acquisition, reach, home-return competition or damage balance. Zombie disappearance alone does not prove guard damage. If outgoing damage remains unclear, a separate bounded `entityHurt` observer tied to verified selected actor identity is the next discriminating diagnostic; do not adjust home priority simultaneously.

The home component records spawn position natively. Return-home priority alone is not an established cause: the documented return-home behavior is eligible only outside the 12-block restriction radius. This probe changes neither home priority nor that radius. No native CAS, pathfinding correctness, hard pursuit fence or successful retaliation is established by static tests.

## Standalone checks

`node --test dev/prototypes/swordsman/path-override/path-override.test.mjs`

Checks pin the source entity hash, prove exactly one changed field, verify the data-only unique identity and both required pack dependencies, and retain all friendly/home/spawn controls. They do not run Minecraft, install anything or open world databases.
