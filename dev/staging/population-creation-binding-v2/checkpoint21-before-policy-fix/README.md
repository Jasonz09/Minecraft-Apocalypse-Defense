# Durable creation binding schema 2 â€” staged, not integrated

This replaces the unsafe isolated schema-1 experiment; that folder and its independent failing safety reproductions remain unchanged. Active packs, installed packs and production tests were not modified. The proposed owner is a copy of the existing sole population owner with an optional injected binding store, not a second spawner.

## What changed

An append-only, exact group issuance inventory distinguishes never-created groups from issued records that have disappeared. The metadata commits exact chunk membership and fingerprints; a missing issued record, an unrelated replacement key, unknown sibling schema or foreign standby refuses safely. Fingerprints detect accidental corruption, not malicious edits.

First issuance writes four durable steps before granting a private birth ticket: header intent, inventory chunk, pending group record, final header. Recovery completes only those exact metadata strings. A recovered pending group never gains birth permission solely because its actor is absent. Other never-issued groups remain eligible after recovery. Fault tests inject exceptions before and after each write. A crash after a durable intent can conservatively strand that group; there is no automatic missing-actor rescue.

Private removal tickets bind the exact header, group record, epoch, generation, type, actor and removing phase, and are consumed once. The owner requires a successful exact removal and an invalid handle before committing terminal owner-removal. Birth failure rollback similarly checks the exact newly created actor. Retags and unknown legacy removals are held.

Normal near/far owner dematerialization is distinct from unload: a positive completed owner-removal permits the next generation; loaded absence does not. Strict canonical entityDie snapshots can record a physical-instance terminal event. No entityRemove inference, aggregate soldier casualty debit or lossless event capture is claimed.

## Bounds and migration

At most 2,048 issued group records, 64 group IDs per inventory chunk, 32 chunks; each group record is at most 1,024 ASCII bytes, chunk 4,096 bytes and header 8,192 bytes. World-property census is capped at 4,096 keys and one observation pass at 48 rows. The issuance inventory never silently forgets a group to reclaim capacity. Capacity exhaustion requires an explicit future lifecycle design.

Fresh initialization still depends on a privileged injected `verifyFreshWorld` test contract. **A real source-authenticated native activation adapter is missing, so this stage is not approved for production promotion.** A caller-supplied boolean is not sufficient production provenance. Legacy mode preserves unknown history; it cannot automatically refill an unseen legacy group, migrate existing duplicates, or delete/merge survivors. No main/streets/starter wiring is included. Store operations are synchronous and reentry-guarded; native persistence/event guarantees remain unverified.

## Validation

21 focused tests pass (177.0496 ms), using the proposed owner plus actual production reducer/harness dependencies. These cover all three independently reproduced predecessor blockers, the independently reproduced late-removal metadata-getter retag race, one-shot native tag/location/type mutations, delete-plus-substitute keysets, every four-step issuance crash boundary, foreign standby preservation, safe never-created retries, unloaded actors, real owner dematerialization, selected swordsman birth, tag/save/cursor faults, positive death identity, duplicate/legacy preservation and late-query races. Strict isolated TypeScript passes without suppressions or relaxed compiler options. This is fake-world/offline verification, not Minecraft acceptance or full-pipeline proof.

Run: `node --test dev/staging/population-creation-binding-v2/binding.test.mjs`

Typecheck: `npx.cmd tsc -p dev/staging/population-creation-binding-v2/tsconfig.json --noEmit`

The original 19-case pins are preserved under checkpoint19-before-late-native-fix. The final removal path performs all metadata work first, then repeated fresh native identity/type/birth/canonical/validity/location proof around the loaded-column probe, without metadata getters before remove. This closes the demonstrated stale copied-tag window; it does not claim atomicity against arbitrary adversarial mutation inside every final native getter.
