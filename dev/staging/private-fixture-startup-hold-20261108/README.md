# Private fixture startup hold — staging only

The first private trial seeded **exactly** the expected step0 bytes, then accepted a real simulation hour before activation. The closed audit proves step1 with changed RNG, soldiers, reserves, battles/log and survey values; it was not a serialization/order mismatch. That failed world remains unchanged. This proposal fixes preparation deterministically rather than racing UI commands or accepting evolved saves.

Only three regular source paths change: `creationRuntime.js`, `simulationLoop.js` and `main.js`. Active source/installed packs are untouched. The existing loop receives an optional `beforeStep` callback from the creation runtime. The ordinary NULL profile supplies **undefined**, performs no additional world reads and retains its old saved bytes/read sequence. No timer, clock reset, catch-up step, actor owner or implicit developer flag is added.

With a compiled private profile, readiness requires the existing full durable activation/store validation. Configured-but-unactivated, incomplete, unknown, corrupt or changing state returns HOLD. A valid complete fresh activation or deliberately initialized valid legacy store permits the normal hour. A HOLD occurs before even loading the kingdom; readiness is checked again after existing save/player-anchor reads immediately before the pure transaction. Exceptions and non-true callback results hold. The loop's original timer keeps running, and the next scheduled callback after genuine completion advances exactly one normal hour. It never rewinds or resets state.

The exact initial-property proof, marker/caller/gates/census, durable intent/header/completion and downgrade/refusal rules are unchanged. An evolved world is still refused even while simulation is held. Completed status remains durable-receipt/core validation, not recurring scoreboard or developer-gate permission.

## Proof

`focused-final.log`: **14/14 PASS**,417.2135ms. The actual proposed loop callback runs past5000ticks with byte-exact step0 and zero property writes/reports, then explicit native-like activation resumes the same timer at the next callback. Ordinary NULL mode runs16hours with exact old-loop raw bytes, writes, reports and native read sequence. Other cases cover strict boolean/throw refusal before load, valid legacy continuation, invalid status on a later hour, metadata/save/anchor getter invalidation, all six activation write crash boundaries/rejoin and evolved-save/devflag preservation. Fixtures are explicit fakes; this is not native activation acceptance.

`existing-contracts.log`: **87/87 PASS**,5273.5933ms, using actual existing main/early-execution/timer/sole-owner tests against the proposal. No test assertion changed. The added main option follows `onStep`, preserving the existing exact source assertion. Initial missing test-stub API and option-order logs are retained. A mistaken baseline-active invocation is labeled separately and is not claimed as proposal validation.

`typecheck-final.log` and `typecheck-private.log`: unchanged strict whole-script options, exit0 for the regular NULL proposal and the actual staged private176 variant. No full suite was repeated. All three regular proposal scripts match the tested runtime; the private override files are pinned separately.

## New disposable trial, not the failed world

`native-variant/` contains a new private176 pair with exactly four overrides versus regular176: the three guard files plus a genuine-source-derived descriptor with a **new** fixture/epoch. The source is still the immutable original nine-file vanilla backup, never the failed ten-file attempt. The staged derivative is unopened; only its two binding lists differ from pristine. The setup helper will additionally patch and pin only its two naming files, leaving the DB unchanged.

The next visible label is **CA Creation Hold Nov8 69162c9b**, with folder `CA_CreationHold_69162c9b`. The new epoch is `owner-hold-69162c9b95214489a7971fadd8fad1dc`. `native-variant/PROMOTION-HASHES.json` uses the existing private setup helper's bundle shape. `native-variant/OPTIONS-EXAMPLE.json` names the new bundle, transaction and world; it has not been applied to real targets.

Root should independently review the three deltas and private pins, then use the reviewed closed-game helper on this **new** derivative. Open only the new visible world, allow at least one normal hour-callback interval, and verify that the kingdom remains step0. Then explicitly enable the existing developer gate and confirm fresh creation. Require positive durable completion; only then should a later scheduled callback advance. Save/close/rejoin and inspect the actual records before people-on. No retry/reset of the failed world is authorized. Native proof remains the next gate, and the public military selector still has its separate saved-city provenance contract.
