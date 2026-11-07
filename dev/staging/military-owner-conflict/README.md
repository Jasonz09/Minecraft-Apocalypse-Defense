# Isolated military-owner refusal diagnostics

**Proposal only: no production integration, deployment or native use.** The real B5 owner conflict group/actors remain unknown. The native guard's current1/1/1 census does not identify a conflict in the broader cached owner observation. Nothing here reconciles, removes, spawns, heals or retags an actor or changes ownership/cursor policy.

`proposed.patch` contains three small existing-file changes, with pinned pre-stage source hashes and proposed file hashes:

- `population/reconcile.js`: preserve the exact existing strict duplicate refusal condition and prefix, adding the first conflicting observed group, its full observed entry count, and the first two observed actor IDs. Each displayed token is capped64characters with nonidentifier characters replaced; ordinary signed native IDs are preserved exactly. Sampling does not sort or query again and does not grant recovery/cleanup permission. More than two actors still reports the full observed count with only two samples.
- `integration/popSync.js`: expose the already-cached global `lastPlan.refused` as the read-only `ownerRefused` inspection field. No new query, action, cursor or world state exists.
- `integration/peopleStreets.js`: replace misleading `Last owner birth` with `Cached owner result`, and display a global refusal separately as `Owner plan refusal (all observed groups)`. A selected actor that is already observed no longer appears to have suffered a failed birth merely because an unrelated group conflicted.

The native message currently comes from a loop over **every observed group**, not just selectedsol1. The adapter shares one ID-dedup map across district windows, player windows and the selected tag query. Stable API stringIDs are not duplicated by repeat sightings. Current selected census and cached owner pass are separate observations (B5's208669owner versus208682inspection). The old global error therefore does not prove a duplicate selected guard, identify a conflicting group, or justify any cleanup. The refusal returns no actions and the runtime skips applying actions/saving the cursor. The new message reveals that existing decision's evidence; it changes no decision.

## Checks

```text
python dev/staging/military-owner-conflict/prepare-overlay.py
node --test dev/staging/military-owner-conflict/conflict.test.mjs
node node_modules/typescript/bin/tsc -p dev/staging/military-owner-conflict/tsconfig.json
```

**5/5 standalone tests passed**,0failed/cancelled/skipped,202.5165ms (`test.log`); strict isolated TypeScript exit0, extending the unchanged root strict/checkJs/noImplicitAny settings. Tests execute the actual proposed adapter/reducer/streets code in the existing fake population world. They prove: an unrelated civilian duplicate reports its group/two real IDs while selectedguard stays1; zero actions/entity/property/cursor/kingdom changes on refusal; selected duplicate preservation; full count/two bounded sanitized samples; staged/original decision/report/state/write parity when masking ONLY the changed refusal message; and actual inspect output separating global refusal from an unattempted birth. No extra native query was added.

The test/typecheck overlay copies dependencies only into this staging directory. `source-hashes.json` pins the three untouched active inputs; `handoff-hashes.json` pins the proposal. Rebase explicitly if those inputs change. Root review, normal integration/static-contract/full checks and a native reinspection are still required. This proposal does not establish the actual B5 duplicate group, native ID stability, owner convergence, combat causality or rejoin acceptance. No current saved world/database was read or modified by this staging work.
