# Cavalry mount native schema repair — STAGED ONLY

The immutable closed content log contains exactly two errors: the mount legacy pushable component is absent from the schema and therefore its entity JSON failed to load. No warning, Molang error or ScriptException appears. The loader defect is established; native birth/seating and the durable aftermath of people ON are not accepted and must be audited separately. No world is retried/reset/removed here.

Cause: the mount declares format1.26.20, whereas legacy minecraft:pushable stopped parsing at1.26.10. Existing swordsman, archer and cavalry already use the two split components. This one entity retained the obsolete form.

Minimal proposal replaces only the old true/true component with empty minecraft:pushable_by_entity and minecraft:pushable_by_block. The format, health, family, collision, speed, navigation, seat and persistence stay exact; no script/owner/cursor/UUID or experimental setting changes.

Primary evidence: [Microsoft legacy component documentation](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitycomponents/minecraftcomponent_pushable?view=minecraft-bedrock-stable) explains the format cutoff and equivalence. The [immutable Mojang stable v1.26.20.4 horse](https://raw.githubusercontent.com/Mojang/bedrock-samples/46d817108cc218bfb4f6e8b93debf4d438eacadb/behavior_pack/entities/horse.json) uses both empty replacements at format1.26.10. The fixture records its SHA and relevant facts; no vanilla texture or complete copyrighted source is copied.

Four production-relative central-ready checks pass76.4137ms. Against the actual rejected baseline, three fail and one passes; failure evidence retained. Tests check all active modern entity component scopes, nested groups, exact inverse JSON parity and pinned primary facts. This is a targeted known-schema regression, NOT a complete Bedrock schema validator or native engine acceptance. No TypeScript source changes; TSC is inapplicable to this data-only delta.

Root must independently review, integrate and complete full gates, then build a NEW private variant if appropriate. Preserve the failed native world and every existing receipt. Need fresh log without mount load errors plus actual sole-owner role/ID/seating proof before native acceptance. The log also shows engine dependency promotion from requested server2.7 to2.11; do not call this a native2.7 execution proof.
