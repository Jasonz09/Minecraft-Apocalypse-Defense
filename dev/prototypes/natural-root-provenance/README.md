# Natural-root provenance audit (read-only design)

## Confirmed current behavior

`clearTree` already accepts a nonnatural base when `isBuiltPlanCell` proves its current block ID equals the saved plan's exact final non-AIR ID and its owning stage has been reached. Completed-city inspection uses all completed stages. Thus replacing original soil with the district's own final foundation is already supported. Mere former membership in the forest is not required and does not grant extra permission.

The base rejection includes its current ID and coordinate. A fresh completed-city `tree` inspection recomputes this proof in an independent session. A construction refusal is cached for component cells until another tree erasure clears the cache; placing foundation blocks does not invalidate that cache. Therefore a later exact planned foundation could make an old rejection stale within the same session. This is a plausible timing case, not a confirmed explanation for D5's16 refused targets. Native base coordinates/IDs and current inspection results are needed.

The persisted planning ground records column height `g`, kind `k`, and `tree` boolean. `tree` is `above.some(isTreePart)`; it does not identify a root or log component and includes leaves/vines. Neither specific original ground IDs nor specific original log cells/states are stored. Checksumming that data proves consistency, not block ownership or identity through time. A player can place a log structure on a column that previously carried a natural tree. Original `land/tree/g` plus current exact planned foundation cannot distinguish those histories.

## Minimum next evidence

Use existing read-only completed-city tree inspection at one exact remaining trunk cell. Capture full reason including base ID and coordinate. For each refused base, enumerate current ID/state, planned final ID and final stage, all historical planned non-AIR IDs, protected-column status, original ground `(g,k,tree)`, and which district(s) claim the cell. Distinguish an AIR gap from a later-stage foundation, neighbor-owned foundation, obsolete intermediate pad, foreign cell, missing column, or cached refusal. A screenshot cannot determine these.

The visible16/25 counters count skipped operations/attempts, not necessarily16/25 distinct trees. Deduplicate components before choosing a cleanup scope.

## Scope that can be safe without a broader naturality exception

If fresh inspection now succeeds under the existing exact-foundation rule, a separately versioned bounded completed-city maintenance command could use the existing full component proof and write-ahead checkpoint, with explicit preview/confirmation and precise saved-plan binding. It must retain all current ore/foreign-contact, player-leaf, whole-log-component, boundary and neighbor protections. No receipt from leaf-only trimming can authorize trunk felling. D1 unknown hall columns remain protected and veto the whole component wherever existing whole-tree proof requires it.

If fresh inspection rejects a stale cached root verdict but passes from a fresh session, a future minimal invalidation fix could discard only root-base cache entries after an actual write at their dependency coordinate. Store the refusal's base-coordinate dependency; never convert a refusal directly to permission. Re-run the entire natural-tree survey afterward. Do not clear arbitrary all-tree vetoes merely because a foundation was placed.

If the current base does not match an exact reached final planned cell and is not natural/log, original ground alone cannot authorize felling. Leave the component intact. Even allowing a historical intermediate planned ID is weaker than exact current final ownership and must not be adopted merely to clear a visual obstruction.

For stronger future provenance, capture an original exact natural component manifest and root-ground evidence before the first construction change, with source/policy binding and historical planned-tree/decor veto. Revalidate every current member and all neighboring cells before any erase, preserve unknown/protected/foreign contacts, and maintain a read-back-verified write-ahead journal. This still cannot cryptographically distinguish player replacement by identical logs; it improves conservative evidence, not absolute ownership. Such original manifests cannot be reconstructed retroactively from the current column profile.

No active source, test, world block, property, or lease was changed for this audit.

## Isolated actual-source reproduction

`node --test dev/prototypes/natural-root-provenance/repro.test.mjs` now confirms the possible stale path with the real private `clearTree`, `indexOwnBlocks`, and `applyOp`. A four-log/one-leaf tree above AIR is refused and cached. An actual successful exact planned stone-brick base write follows. The same session still returns its old AIR-root verdict, whereas a fresh full proof accepts all four logs and the leaf. This is a deterministic synthetic reproduction, not proof of D5's observed cause.

After production adopted the bounded generation-cache correction, this historical reproducer explicitly reconstructs the former untracked root-cache branch in memory. Its five cases still demonstrate the original bug and isolated delete-based proposal. The active generation-cache implementation and source hooks are tested separately in `dev/test/tree-root-refusal-cache.test.mjs`; this historical helper is not installed.

The isolated helper and instrumented fix invalidate only cache entries dependent on the exact successfully written root-base coordinate. Lookup is constant time for unrelated writes; matching invalidation visits at most4001candidate keys. Metadata is bounded to64base coordinates and8192total memberships. Overflow does not cache the new root refusal, preserving refusal behavior without stale uncoupled entries. A different/newer refusal on the same candidate is preserved by exact reason matching. A failed write does not invalidate anything. Successful tree clear also discards dependency metadata.

Tests show whole-proof copper/chest/protected/unknown-hall refusals remain intact in both source and fixed variants. The fixture's maximum reads per slice stays within the unchanged production budget. The actual helper grants no erase permission, creates no journal and performs no block/property/lease writes. `proposed-hooks.patch` is a design artifact; it is not a ready production patch and needs typed helper wiring, review of other successful write paths, regression integration and full validation before activation.
