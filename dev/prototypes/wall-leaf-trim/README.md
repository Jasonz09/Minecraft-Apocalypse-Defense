# Isolated completed-wall leaf trim

This is a pure authoring-maintenance prototype. It is **not in the active BP/RP**, registered commands, installed files, or Minecraft worlds. It contains no whole-tree clearer or native adapter. Injected `read`/`write` functions exist only to test the proposed boundary.

Run from the project root:

```powershell
node --test dev/prototypes/wall-leaf-trim/leaf-trim.test.mjs
```

Result: **26/26 standalone tests pass**, zero skips. Tests demonstrate the contract against a fake local world; native leaf updates, world loading and block-write behavior remain untested.

## What the real D4 evidence establishes

The separately preserved Saltmere plan is `35635162`, master envelope `9e5e307e`, centre `(-368,-554)`. The recorded native wall audit reports 35,911 targets, zero missing/unloaded, **17 tree-occupied targets**, 52 other occupied cells and protected exclusions. The following ordinary guarded repair restores zero blocks: its 17 tree attempts are refused because copper touches the connected component. Logs, ores, melons, protected footprints and unknown structures remain preserved.

**This folder has no complete list of the 17 coordinates, current leaf states or local contacts. Their exact eligibility is therefore UNKNOWN.** The count is not evidence that all 17 qualify. The seventeen-target test is explicitly synthetic and is not a preview of those real cells.

A future read-only native preview must enumerate all remaining tree-occupied final wall targets, then classify each using fresh reads. It should print/export every coordinate and reason, with separate counts for eligible nonpersistent leaves, already-correct masonry, source/protection/decor vetoes, local foreign contacts, other tree types and unreadable cells. Return a complete-list indicator; a capped sample of six cells cannot establish the eligibility of seventeen. No mutation should precede this preview.

## Proposed permission boundary

The policy string is `wall-leaves-trim-v1`. It is an explicit authoring-maintenance permission, not a new terrain or generation rule.

- Only the selected completed district's exact final `walls` operation of `kind=wall` can qualify. The target must be a reviewed stateless solid masonry ID. Later AIR, gates, roads, lots, decorations, slabs/stairs and other final owners refuse.
- Every own and neighboring source must first pass the existing saved-plan checksum rehydration, completion, dimension and same-master checks. The prototype checks the supplied record identities; it does **not** independently establish those caller assertions.
- Historical planned logs, leaves, vines, plants and non-masonry lot/dressing cells veto the target and its 27-cell neighborhood, including cells later overwritten by AIR or masonry. This deliberately preserves old crop/furniture/decor locations too. Final non-tree IDs alone do not erase that history.
- Current protection applies to every neighboring column and the target. True, unknown or throwing protection refuses. There is **no** shared-band, exact-boundary, completed-neighbor or prototype exception.
- The live target must pass the existing leaf recognizer and expose `persistent_bit === false`. Persistent, missing-state, invalid or unreadable leaves refuse. Logs, vines, ores, AIR and unrelated blocks can never be trim targets.
- Local contacts use the existing conservative natural-contact test, or an exact verified planned **masonry** identity. Persistent/unknown-state neighboring leaves, unknown structures, foreign planks/chests and copper ore refuse. There is no copper whitelist. A copper block farther than the local cube is neither traversed nor changed.
- The sole block mutation replaces one leaf directly with the exact planned masonry. There is no intermediate AIR operation, trunk/canopy traversal, root proof relaxation, felling, neighbor mutation, new ore companion or change to ordinary repair.

`persistent_bit=false` cannot prove the absence of every possible player action. The exact saved wall footprint, historical-plan checks, conservative current protection and local contacts keep this deliberately narrower than felling, but do not turn a block flag into universal provenance.

## Budgets and recovery

The compiler accepts at most 64 unique supplied candidates, indexes only their local coordinates and yields at most every 400 source operations. It still scans all relevant records/stages so later writes cannot be missed. This is not a full-city occupancy map.

Preview reads at most 27 blocks per proposal and has no journal/writer. Separate cooperative admission (`prepareLeafTrimSteps`) reads at most 27 blocks between yields, captures each original leaf ID/full bounded state snapshot and checkpoints the entire admitted batch before any block write. A later commit performs two fresh 27-cell checks, one final target check and one post-write verification: **at most 56 block reads, one block write**, no yield between the local proof and mutation. A future adapter must budget before entering this bounded synchronous section. The 1-block contact apron spans at most four chunks for one target, rather than the felling algorithm's 17-block apron.

A separate exact source/policy-bound journal is saved and read back before any block mutation. The v2 prototype receipt includes policy, district, dimension, master, source receipts/checksum, the ORIGINAL admitted coordinate list, coordinate digest, exact planned masonry, observed leaf ID/states, immutable-entry digest and per-target completion. It is capped at 64 targets and 24,000 UTF-8 bytes. Refused targets cannot enter an admitted batch; their unresolved wall status remains separate. Unknown versions/policies (including the older v1 prototype shape), changed sources/materials, invalid digests and invalid checkpoints refuse without consuming the old journal. A new audit may naturally contain fewer leaves after partial progress; resume recompiles the ORIGINAL receipt coordinates instead of replacing them with the reduced audit list. Newly discovered targets are not silently added to that receipt. It must never share the normal construction or ordinary city-repair prefix.

Crash after replacement and before the done checkpoint leaves pending work; rejoin observes the exact desired masonry and adopts it without another block write. A silently failed block write does not mark the entry done. A pending leaf whose type or full observed state changes also holds its receipt instead of adopting a new natural-looking leaf. This may conservatively hold natural state changes; there is no automatic journal deletion or overwrite to clear that refusal. Already completed entries that later contain a player change are preserved/refused rather than repaired. The prototype gives a logical single-property checkpoint, not a claim of disk-level atomicity or lossless process-failure handling.

Suggested future prefix: `civ:wall_leaf_trim:v1:<district>`. Any pending, unknown, wrong-source or unreadable journal must block starter arming/export, and no trimming journal should be silently wiped. Decide whether to retain a valid completed journal or explicitly reconcile it on the separate release copy. The current active starter code has **no such prefix integration** because this prototype is not active.

## Isolated recovery and conflict closure

`runLeafTrimSteps` drives cooperative compile/admission and then one admitted target per yielded slice. Every journal entry point requires the explicit policy before touching the store. The future native adapter must supply `ctx.sourcesCurrent(plan)`, a fresh saved-source/master/protection verdict; an absent/non-true result fails closed. The prototype checks its input receipt identities across yields too, but that is not a substitute for actual native source validation.

Journal compare-and-swap barriers and the required source guard bracket every compile/admission/post-write yield, and run again after the two local proofs. After the final target read, all 27 local protection verdicts and the full source/journal barrier are checked again immediately before the sole write. These protection checks add no native block reads. Regression injections flip source or neighboring protection during read 55; both refuse with zero writes and preserve the pending receipt. An in-memory weakened-barrier negative control reproduces the old one-write gap. The batch retains the exact raw checkpoint returned by its own verified save; it never adopts an externally replaced receipt as its next expected value.

Other districts' final AIR, road, gate, different masonry or stateful target claims veto the target even when the selected district still ends in wall masonry. Matching exact stateless wall claims may agree. Contact masonry is explained only when all recorded final claims at that contact agree on the same stateless reviewed material; historical vegetation/decor and current protection still veto it.

The new tests reproduce crash-after-write with a reduced one-leaf audit, recovery of the original two-coordinate receipt, and an empty-audit completed rejoin with zero writes/checkpoints. Timed injections replace the journal after yields, during the second 27-cell proof and at the final target read, change sources, and corrupt admitted coordinates/states/materials. All preserve unknown receipts and prevent further writes. Independent **in-memory negative controls** remove one target-claim veto, journal CAS or original-list restoration: they respectively admit a neighbor's later AIR claim, write/overwrite a foreign receipt, or fail reduced-audit crash recovery. Those unsafe variants run only against the fake world, never an active file/world.

The synchronous `prepareLeafTrim` wrapper is for offline tests only. A production controller must schedule `prepareLeafTrimSteps` cooperatively and own bounded local leases/cancellation. Starter guards and native adapter are still **not integrated**. Current active `wallleafpreview.js` remains read-only and does not inherit these new mutator guarantees.

## Smallest production hook after review

1. Keep the current frozen build and installed pack unchanged until full verification ends.
2. Add an explicit parser branch such as `civ:generate_diag repair district=4 wall_leaves=trim-v1 [confirm]`. Default `repair district=4 confirm` must retain every existing tree/foreign-block rule and never consume the new journal. A separate `wall_leaves` subcommand would also be clear.
3. Reuse completed-source loading/protection compilation from `repairSavedCity`, but compile a dedicated final-wall candidate list and retained historical veto set. Require no pending ordinary `treeClearance`; do not inherit its approval or resume it under this policy.
4. Reuse the one-chunk wall-audit enumeration pattern, expanded only for the one-block local apron. Preview all real candidates and report their precise reasons. Do not guess the real D4 eligibility from the synthetic test.
5. Prefer a tiny dedicated leaf-trim job/session over a generic `classifyCivOp` exception: before the existing `clearTree` dispatch, a broad exception is too easy to leak into ordinary construction, gate opening or shared-neighbor maintenance. If a narrow helper is hooked into `applyOp`, require **both** completed maintenance and the exact policy, refuse protected cells before the hook, restrict to wall operations and use a separate journal/cursor.
6. Keep source plans, city completion record, ordinary queue and ordinary repair journal byte-identical. Count `wallLeavesReplaced` separately from trees felled. Release local leases on completion, interruption, refusal and cancellation.
7. Run the existing felling/repair/protected-boundary suites unchanged, add real adapter/checkpoint failure tests, then inspect native persistence and surrounding vegetation. Re-audit wall IDs, inspect foundations/appearance separately, and verify no ore/log/vine/foreign cell changed.

## Native limits

Replacing a natural leaf may trigger native block updates or later foliage decay. The pure fake world does not model that. Inspect adjacent natural and protected foliage after actual ticks, chunk unload/reload and save/rejoin before claiming that only the explicitly written cells visibly changed. This proposal does not solve the other 52 occupied wall targets, prove foundation support or walking, or complete city acceptance.
