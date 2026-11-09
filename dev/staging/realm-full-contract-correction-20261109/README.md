# Realm full-run contract corrections — STAGED TESTS ONLY

The retained full run completed2530/2533 unit cases:2assertion failures and1cancelled test,0skips,1,245,853.7838ms. Other four verification gates and52headless cases passed. This is not an all-green full run.

Both assertions were independently reproduced against unchanged central tests:

1. Command namespace audit recognized plan/jobs/farm_lights/wall_leaf_trim durable families but not the new exact realm/realm_claims families. Actual source uses REALM_SOURCE_FAMILY=civ:realm: and REALM_CLAIM_FAMILY=civ:realm_claims:, with strict own source codecs. This is a property identifier, not a command. The proposal adds ONLY those two exact family names. It retains the one-colon registered-ID requirement for script examples, literal event comparisons/switches/runCommand and unknown old command-like literals. New positive property fixtures and negative malformed realm event/unknown near-family controls run through the same audit. No production registry or event gate changes.

2. Tree inspection's old golden contract allowed its inspector-only dispatcher but expected a literal s.dimension getter. The reviewed realm adapter intentionally routes construction native reads through (s.realmBlocks??s.dimension). The proposal preserves the entire prior function byte comparison modulo ONLY the inspector dispatch and that ONE exact accessor replacement. It additionally rejects changing persistent-leaf semantics or removing the realm accessor, and executes the actual extracted private reader with injected native ports: normal fallback, guarded realm read, guard refusal without falling back, exact read counts. No tree proof or mutation policy changed.

The isolated interior-lights runtime case PASS1/1 in40,428.5859ms, while the contended full cancelled at300,005.7427ms. This is consistent with contention but not a proven performance cause. No timeout, production behavior or assertion was changed. Full rerun remains required.

Two proposed existing central test files,22/22focusedPASS2,232.2827ms against exact current active source in an isolated validation project. No runtime/staging/dist fallback is introduced into proposed tests; the historical source fixture remains unchanged. Main194 production and all central tests are untouched.

Only promote these two exact tests after root review. Retain full failed log and original repro logs; do not relabel isolated PASS as full verification.
