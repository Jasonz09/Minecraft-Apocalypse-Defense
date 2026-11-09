# Archer/creation integration readiness and closed-fixture evidence

This new stage preserves all 21 proposed production files from the frozen `population-archer-composed` stage **byte-for-byte**. It fixes a concrete central-test integration blocker and provides executable read-only preparation tooling for root's genuine vanilla source. No production, old frozen stage, installed pack, Git branch, world or desktop was changed. Trust remains literal null; no provenance is fabricated.

## Integration blocker reproduced and fixed

The current central `integration.test.mjs` requires engine imports in runtime-directory files unless they are explicitly capability-injected boundaries. The four new creation modules correctly avoid engine imports but were missing from that exact list. Running the actual central boundary test against the composed source failed on `integration/creationBindings.js` (`boundary-before.log`). The proposed test adds only `creationBindings.js`, `creationRuntime.js`, `privateFreshFixture.js` and `freshFixtureTrust.js` to the existing exact allowlist. The inverse assertion that these modules must not import either Minecraft engine/UI module remains unchanged. No production import or behavior changed.

That actual boundary test now passes: 1/1, 327.2182 ms (`boundary-after.log`). This was a focused test selection, not a central full-suite run. The combined archer/creation suite still passes **165/165**, 1091.831 ms (`compatibility-final.log`), and strict unchanged-option TypeScript exits 0 (`typecheck-final.log`). All final scripts match the overlay bytes. Root should centrally integrate the 21 proposed production paths **and the exact boundary-test delta**, then run the normal full verification gate before considering installation.

## Executable closed-copy preflight

`closed-fixture-preflight.py` reads only a named backup under `dist/backups`, never the engine database. It reuses SHA-pinned CRC-WAL and NBT parser definitions from the existing closed-journal audit without executing that prototype's hardcoded-world code. It hashes every file twice, enforces bounds and no links/reparse points, requires both explicit empty pack-binding files, checks the exact planned level name, validates WAL CRC/fragment ordering plus unparsed padding, reports the current Scoreboard tree and exact planned-string paths, and refuses main-pack owner/history appearing anywhere in the inspected WAL, even if a later record deletes it. It writes new JSON evidence exclusively under this stage/native-evidence, outside the source backup.

Run only after root has actually created, saved/quit, fully closed Minecraft and pinned a genuinely new vanilla source with no behavior/resource packs. Preserve that original source forever and use disposable derivatives. The existing preparation plan is `dist/creation-never-owner-preparation-plan-20261106.json`; it is a plan, not an attestation. Substitute the actual closed backup path:

```powershell
python dev/staging/population-archer-readiness/closed-fixture-preflight.py --backup dist/backups/ACTUAL-CLOSED-VANILLA-SOURCE --plan dist/creation-never-owner-preparation-plan-20261106.json --output dev/staging/population-archer-readiness/native-evidence/actual-closed-evidence.json
```

The tool deliberately returns `EVIDENCE_ONLY_REQUIRES_ROOT_REVIEW`, `compiledTrust:null`, `operatorKnownNewVanillaAttested:false` and `runtimeParticipantIdentityAndExactScoreReviewed:false`. It does not guess Bedrock's participant ID/score semantics, compile a descriptor, write any scoreboard/property, reset a kingdom, bind a pack or activate population. Root must inspect the actual Scoreboard NBT and verify one objective, one FakePlayer participant, its genuine native identity ID and score 0; corroborate the witnessed new-world/closed-copy chain and full source receipt before separately compiling trust. The tree is retained so that unknown native data shapes are reviewable rather than silently normalized.

WAL absence **does not prove SST, entity or historical owner absence**. SST files are listed as not decoded, never treated as empty. A nonzero observed score is exposed and never certified. The native runtime must still perform its exact marker/caller/source/census checks before activation. A source copied while Minecraft was running is not made valid by stable hashes alone. The adapter's exact initial kingdom/first-hour/developer-flag boundary and the military selector's separate Nov3 saved-city contract remain unchanged; this tool does not bridge either provenance gap.

`preflight-tests.log`: **12/12 synthetic tests pass**, 0.271 s. Covers exact immutable inventory/no trust grant, CRC corruption, short unparsed tails, nonempty/missing bindings, wrong level, absent marker, conflicting same-sequence Scoreboard snapshots, historical main owner namespace even after deletion, changed source, live-path/output-overwrite rejection, and explicit unverified SST/nonzero-score evidence. No actual user's source was read by these tests. Run `python dev/staging/population-archer-readiness/closed-fixture-preflight.test.py`.

## Review and next gate

`PROMOTION-HASHES.json` pins predecessor sources, all 21 production copies, the one new central-test proposal and preparation evidence/tooling. Original failed boundary evidence is preserved. The separately requested cavalry review is at `dev/staging/cavalry-owner-composition/independent-review/REVIEW.json`: 30/30 and strict typecheck passed; its limited v3/single-owner foundation has no identified blocker, while compound native actions and v3 activation remain explicitly disabled/missing.

The next concrete gate is root's actual new vanilla creation → closed backup → preflight evidence → independent exact marker/receipt review. Then compile a reviewed descriptor only on a disposable derivative and test initial activation/owner birth/unload/rejoin/gate-off with the same owner. Central full verification, native archer projectile/friendly damage/rendering and genuine military-source compatibility remain required. No roadmap-complete or native-ready claim is made here.
