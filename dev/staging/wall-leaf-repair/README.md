# Staged precise wall-leaf repair

**Proposal only. Nothing here is registered, installed or copied into the active pack.** The active 152-file source proof remained unchanged at assembly. The original `dev/prototypes/wall-leaf-trim` snapshot remains untouched.

The proposed command is:

```text
/scriptevent civ:generate_diag leafrepair district=4 policy=wall-leaves-trim-v1
/scriptevent civ:generate_diag leafrepair district=4 policy=wall-leaves-trim-v1 confirm
```

Use any district 1â€“5. The existing development gate must be on, the selected saved civilization must be complete in the Overworld, and the caller must be an Overworld player. The command shares the existing exclusive construction job slot and cancellation path. There are no timers, second spawners, actor mutations, ordinary construction-queue updates, chunk holds or chunk-loading calls in the new repair handler. The existing read-only `leafpreview` pages remain available for the observed candidate list.

## Proposed integration

`proposed.patch` contains four changes, all assembled inside this directory:

- `civ/wallLeafTrim.js`: typed pure proof/receipt engine derived from the isolated prototype, with the original proof barriers intact. It exports immutable receipt inspection and the reviewed masonry set. Two defensive checks make missing proof targets/entries refuse explicitly.
- `civ/wallLeafRepair.js`: cooperative generic survey/admission/resume controller, bounded raw source fence, and native block-handle adapter.
- `commands/civ.js`: explicit parser/help plus source verification and the native adapter invocation.
- `sim/starter.js`: hard keep for every `civ:wall_leaf_trim:` property, ahead of exact wipe rules, and a blocking arm/verify/export-readiness problem for pending, completed and unknown maintenance receipts.

Review those copies before applying them. Reassemble against the latest parent source before promotion; `assembly-source-hashes.json` records the exact active files used. Promotion still needs root's normal static contract review/full verification and closed-world installation/native checks. No active test allowlists have been weakened or edited here.

## Permission and recovery

The handler verifies every existing civilization's saved original source through the actual `loadSavedRunSteps`, requires completed queues and identical master plans, rejects noncanonical district identifiers and orphan saved queue metadata, and fences original plan/queue bytes and kingdom protection geometry across every yield. Simulation resources/hour do not invalidate geometry. Current source changes, cancellation, unknown/incomplete neighbors, missing metadata or unreadable source all refuse.

A loaded survey may observe at most64 tree-occupied final wall targets. Eligible candidates are compiled against **all** verified source stages and historical plans. Ownership must be the selected final stateless solid masonry wall; historical vegetation/decor, conflicting other-source final claims, and protected local columns veto. The whole 3Ã—3Ã—3 neighborhood must be readable and permitted by the unchanged strict prototype policy. Copper and other contacts outside the existing strict policy remain foreign; no new whitelist is introduced. The inherited prototype uses terrain.isBenign for judgment contacts, including natural logs/vines and the existing coal_ore companion allowance. That does not grant permission to replace those contacts: logs/vines/ores are never repair targets, foreign masonry/structures and historical decor still veto, and persistent or unknown-state leaves refuse. Only a nonpersistent natural leaf itself is replaced, directly with its exact planned masonry. No connected tree is felled. Root explicitly retained that inherited judgment policy: no ore writes, no new whole-tree ore exception, and no copper whitelist.

Each admitted target repeats its27-cell proof twice; target read55 is followed by27 protection checks and a full source/receipt barrier. The native setter uses the **same Block handle returned by that final target read**, with a pre-resolved masonry permutation; it performs no extra hidden block getter before setting. Read56 verifies the result. Setter/readback/checkpoint errors retain pending state and do not mark an unverified write as a verified replacement.

Receipts use separate bounded keys `civ:wall_leaf_trim:v1:dN:PLANID` and schema2. The `v1` key identifies the policy, not the receipt schema. They bind checksum/master/dimension/all neighbor source identities, the original ordered coordinates, desired materials, before states and digests. Resume recompiles the original coordinates and all current source proof. Cancellation and rejoin do not shrink the batch to whatever leaves remain. Completed history is retained; a reappearing leaf at an already completed coordinate is not automatically reauthorized. Source/neighbor changes preserve the old receipt and refuse automatic migration. No journal-clear command exists. A release copy with any receipt currently refuses arming/export readiness until a separate reviewed reconciliation design exists.

Bounds:64 targets,56 native block reads per commit slice,27 per admission slice,400 compile operations between yields,64 per survey slice,1728 cached native handles,16 retained batches per district/80 globally,128 source keys/4096 total keys/1.5MB source text,24KB per receipt. New batches do not discard history to make room. No whole-city completion is claimed: unreadable wall regions remain explicitly outside the loaded survey; admitted unreadable cells remain held. Summary distinguishes attempted setters from verified committed replacements.

## Evidence and reproducibility

The development fixture contains **no runtime allowlist**. `extract-closed-source.py` reads only the SHA-verified closed backup `dist/backups/corrected-d4-leaf-preview14-20261106`, verifies all parent receipt hashes and level.dat `0109A6B32F47536BFB53261DA771ECE8F62E47BF1ABAF1DAFB55AF43E71C1018`, CRC-verifies WAL physical records, and extracts the latest saved-source snapshot (sequence274030,36 source properties). It never reads a live database. The actual current source loader reconstructs all five completed plans/checksums and master9e5e307e. This proves saved-plan provenance; the fixture does not establish physical block states. Tests combine those actual plans/protection with explicitly simulated local blocks and the native read-only preview's14 eligible/3 protected observations. Those coordinates exist only in test/evidence data.

```powershell
python dev/staging/wall-leaf-repair/assemble.py
python dev/staging/wall-leaf-repair/typecheck.py
node node_modules/typescript/bin/tsc -p dev/staging/wall-leaf-repair/tsconfig.json
node --test dev/staging/wall-leaf-repair/leaf-trim.test.mjs dev/staging/wall-leaf-repair/repair.test.mjs dev/staging/wall-leaf-repair/command.test.mjs dev/staging/wall-leaf-repair/safety.test.mjs
```

The isolated typecheck overlay extends the unchanged root strict/checkJs/noImplicitAny configuration and copies current scripts only inside `typecheck/`; it never overwrites active files. The full proposed command itself is executed through the real fake-Bedrock event route, including developer-gate refusal, read-only14/3 preview, job scheduling and orphan-neighbor refusal. The actual starter arm/verify handlers are run against the proposed pure readiness module, proving receipts remain byte-identical. Validation: clean combined standalone suite **42/42 passed**,0 failed/cancelled/skipped,131154.7684ms (`final-tests.log`); strict isolated TypeScript exit0 (`typecheck.log`). The earlier35/36 combined log records a line-ending-sensitive negative-control fixture failure; preserving LF and rerunning the unchanged weakened-barrier control produced the clean42/42 result. Local tests cannot prove engine setter behavior, native safety outcomes, performance in Bedrock, or eligibility of currently unloaded wall cells. No native repair has been run.
