# Compound metadata increment — staged only

The original pure nine-case design is byte-preserved in plan9-frozen/ and CHECKPOINT-plan9.json. The new compoundBindings.mjs is an injected dynamic-property metadata implementation. It imports no engine API and creates/removes/seats no actor. The fourteen new tests simulate privileged owner steps around it; they do not test a production compound owner.

## Implemented

* Fresh schema3 namespace under civ:pop_bind:, exact one-group rider+mount record, immutable epoch/group/generation, separate role IDs/types/pending/alive/removing/terminal state. Mount is not another soldier group.
* Exact append-only issuance inventory: max2048pairs,32chunks of64IDs,1536ASCII bytes/pair,4096/chunk,8192/header and4096-key census. Four durable reservation writes (intent/chunk/record/header) recover only exact never-issued metadata. No role birth permission exists before reservation completes.
* Each role separately persists pending before its caller may spawn. Private one-use birth/removal tickets bind exact raw header/record/epoch/type/role/generation. IDs cannot be reused across roles. Pending unknown never means never-created; exact known loaded identity may recover after restart.
* Exact positive rider and mount death receipts stay distinct; duplicates are idempotent, stale identities refuse, horse loss debits no human soldier. Surviving counterpart prevents pair renewal.
* Removal-save failure remains removing across restart. The CALLING sole owner must positively prove native remove succeeded; commitRemoved/rollbackRemoved are metadata methods, not native observers. No isValid=false/unload inference is accepted as a documented caller contract.
* Pair renewal requires both roles terminal or explicitly cancelled as never-created. Cancellation only accepts persisted never state, never pending/alive/unknown. This avoids spawning a horse after the rider died before mount birth, and closes wholly uncreated gate-off reservations without inventing death.

## Verification

14/14 focused cases pass129.1486ms; strict root-option isolated TypeScript passes. Coverage includes every before/after four-write pair reservation; per-role pending/spawn-ID/confirmation write faults with simulated births between them; restart/lost tickets; missing record plus same-count substitution; v2/future namespace refusal; forged/stale tickets; wrong role/type/generation/canonical identity; both kinds of death with survivor preservation; terminal-save failure; exact known pending recovery; terminal reappearance; never-created cancellation; and inventory64→65 boundary. The earlier nine decision-model checks remain separate evidence. No full suite or native test ran.

## Mandatory missing pieces

This is NOT a drop-in creation-binding-v2 replacement. It is fresh-compound-only and refuses all v2/other-version family keys. A production combined store must support discriminated single-actor AND compound records, migrate/preserve old v2 inventory and receipts transactionally, and bind exact private activation schema. Its initialize signature/header differs from the current private fixture adapter. No migration or adapter was fabricated.

There is no compound popSync adapter, seating, class selection, mount asset, global timer or event subscriber. Actual global24/district8 actor caps and per-hour budgets are NOT enforced by this metadata store: the same LOD/reducer/owner must count both parts AND pending reservations as cost2. Existing ordinary people must continue through that unified store. Do not compose a second horse spawner/cleanup loop.

The owner must authenticate native events and recheck identity/loading/policy after metadata getters before every spawn/remove/seat. Store tests use synthetic primitive evidence, not unforgeable native receipts. Unreadable death events can conservatively hold; lossless event durability is not claimed. No aggregate casualty/cohort debit exists (death results return zero human debit), including for the rider. Pending crashes can leave tracked uncertainty or an untagged stray, never automatic adoption/deletion/replacement.

Next cohesive implementation: unified migration/record API plus cost2 LOD and sole-owner action proposal; then reviewed rider/mount data and a fresh disposable native seating/rejoin/partial-removal proof. Mounted patrol/combat/support/counterattack, collision at gates/slopes and release remain open.

Run: node --test dev/staging/military-cavalry/compoundBindings.test.mjs

Typecheck: npx.cmd tsc -p dev/staging/military-cavalry/tsconfig.json --noEmit
