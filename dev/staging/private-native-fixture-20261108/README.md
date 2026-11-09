# Genuine vanilla fixture — private proposal, not installed

This stage derives one private descriptor from root's witnessed **CA Never Owner Nov8** source and its immutable nine-file closed backup. It does not change active source, installed packs, the native world catalog or the pristine backup. Active production trust remains literal null. No activation, birth or other native acceptance is claimed.

`proposed/freshFixtureTrust.js` pins the actual source-receipt SHA, actual level.dat SHA, exact scoreboard nonce/name and stored participant ID **1**. `fixtureId` and `epoch` are newly assigned implementation identifiers; the epoch was generated once for this experiment. The `operatorKnownNewVanilla` assertion comes from root's recorded UI witness, not an inference from an empty loaded census.

The exact closed audit is pinned in the manifest. Its latest `scoreboard` NBT record is sequence391: one dummy objective with the expected display name, one `FakePlayerName=NEVER_PEOPLE_ON` entry (`IdentityType=3`, `ScoreboardId=1`), and one joined score0/id1. All465 WAL mutations form a unique contiguous1–465 range. This nine-file backup contains no SST, and the CRC-verified current manifest has no SST file edits/references. No DynamicProperties snapshot or main UUID byte hit appeared in that WAL. These are precise current-storage observations, **not** proof about arbitrarily erased or compacted historical state; root's witnessed new-world/no-main-pack/closed-copy chain remains part of provenance.

The original preflight safely refused because its assumed uppercase `Scoreboard` key was wrong. The original frozen tool remains unchanged. A separately pinned v2 tool uses the actual lowercase key and passes12 synthetic checks; the actual immutable copy then passes preflight. This does not suppress unknown data shapes or grant trust by itself.

## Reviewable candidate and derivative

`private-packs/` contains a staged **176-file** candidate copied from the frozen central176 source. Exactly one file differs: the proposed private trust module. Every script matches the strict-checked overlay. `PRIVATE-PACK-PLAN.json` pins every private file and the active-null baseline. These files are not in an installed pack directory.

`derivative-world/` is a disposable staged copy of the genuine nine-file source. Exactly two files differ: explicit BP/RP binding JSON lists naming the original main pack UUIDs/versions. The DB, level.dat, icon and all other bytes match the pristine source. This copy is **not** in Minecraft's world catalog and has never been opened. `DERIVATIVE-PLAN.json` records source hashes and the opening sequence. Do not open the pristine source again. Do not open this derivative until root has reviewed the proposal, finished the central full gate and deliberately prepared the matching private pack; opening it against an older installed pack could evolve its initial kingdom and require another pristine derivative.

The original same-BP namespace is retained. Before a later native first-activation test, root should close Minecraft, preserve installed pack bytes, install only the reviewed private candidate on the disposable test setup, and verify its inventory/bindings. On first spawn the absent developer flag causes a conservative hold. Before the first accepted simulation hour, use the existing development switch, then explicit creation confirmation:

```text
/scriptevent civ:generate_devgate on
/scriptevent civ:people creation fresh confirm
```

The adapter still requires native `FakePlayer` type, exact ID1/objective/nonce/sole score0, actual caller, developer flag, people off, no job, exact initial save and bounded all-dimension census. A changed/evolved or refused attempt must be preserved and replaced with a new pristine derivative, never reset, rewound or retrospectively blessed. Completion must be checked from the reply and durable intent/header/complete records, then save/close/rejoin before later lifecycle tests. The public military selector retains its **separate Nov3 saved-city contract**; this blank fixture does not automatically authorize an archer trial.

## Verification

`focused.log`: **11/11 PASS**,110.5762ms. Checks actual descriptor/source-receipt correspondence, unchanged pristine hashes, exactly-two derivative changes, active-null trust, actual adapter behavior against an explicitly fake exact world, native identity/score/type mismatches, caller/gates/evolved save refusals and all six activation write crash boundaries. Fake-world success is not an actual Minecraft activation.

`typecheck.log`: strict whole-script overlay exit0, original root options unchanged. `descriptor.test.mjs` and `tsconfig.json` reproduce the focused checks. The private pack's exact scripts equal that checked overlay. No full suite was repeated while root's central full gate was running.

Next gate: independent descriptor/chain review, central full pass, then root's controlled closed-game private installation and first native activation on a disposable derivative. No descriptor is promoted automatically by this stage.
