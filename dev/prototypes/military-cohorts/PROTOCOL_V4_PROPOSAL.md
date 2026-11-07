# Proposed protocol v4: standing casualties, host battles and dormant survivors

**Design only, 2026-11-05. No v4 implementation or active integration.** Existing accounting/storage source and all88 standalone checks remain unchanged. This proposal supersedes neither production behavior nor verified native acceptance. It is a functional path for ordinary verified transitions, with cohort-local uncertainty on actual failures; it cannot manufacture a native event-to-disk guarantee.

## 1. Separate immutable birth, remaining soldiers and physical authority

A birth keeps immutable `{birthId, generation, home, initialHeadcount}`. It also keeps `{remaining, host, authorityEpoch, mode}`. `0 <= remaining <= initialHeadcount`; default initial size is five and partial initial groups stay exact. Recruitment adds anonymous reserve or allocates a genuinely new birth; it **never refills a surviving birth**. A dead birth (`remaining=0`) cannot reactivate. Class assignment remains explicit; no soldier mix is inferred.

`initialHeadcount` replaces v3's ambiguous immutable `headcount` meaning. SIM casualties may reduce `remaining` while preserving the original ID/generation/home/initial count. A native binding snapshots **current remaining**, not initial size. While that binding has physical authority, simulation cannot mutate its remaining count or host. Its verified native death sets that exact remaining snapshot to zero once.

| Mode | Native actor / authority | Permitted count changes |
| --- | --- | --- |
| SIM | No active native instance; may be archived or working | Explicit simulated loss can reduce remaining; host transfers are atomic with loans. |
| SPAWN_PENDING | Issued instance nonce; sole owner is creating/binding | Freeze this birth's SIM loss/transfer until success or proven cancellation; unknown spawn outcome holds this birth. |
| PHYS | Exact birth/epoch/native-ID binding, including standing peace-time coverage | Verified native death consumes its snapshotted remaining. Unloading does not end authority. |
| RETIRING | Owner is ending a PHYS instance | Still physical casualty authority until live-removal/death and ingress settlement are established. |
| UNRESOLVED | Actual crash, missing binding evidence or contradictory lifecycle outcome | No invented death/refill/respawn/SIM transfer. Exclude from available combat strength; other cohorts and hosts continue. |
| DEAD | Remaining zero; terminal debit recorded | No reactivation or refilling; old consumed receipts are no-ops. |

Standing coverage records `{birthId, authorityEpoch, instanceGeneration, nativeId, representedRemaining, inboxSlot}`. Its authority exists independently of a battle. This makes an exactly bound peaceful player/lava/natural death eligible, rather than requiring an artificial siege engagement. The receipt must match lineage, birth, epoch, instance, native identity and represented snapshot. A missing actor, a failed query and `entityRemove` are **not** death receipts.

## 2. Independent host battle records

Replace the one-global-engagement gate with `battle[host] = {epoch, actionSequence, phase, sourceRoot}`. A/B/C/D/E may be attacked concurrently; each has its own ordered actions. The starting five hosts fit a bounded table; later expansion uses the same host-index mechanism, not a hard-coded five-host loop.

Standing physical coverage remains global only for ownership/budget accounting. Preserve the current **24 total representatives and eight per district**, which include civilians; do not reserve24 soldier slots or invent a fixed civilian/soldier mix. A soldier's standing binding is a subset of the sole streets owner's admissions. SPAWN_PENDING/RETIRING instances occupy their slot until settled; invisible actors do not free a slot.

For every host, derive three disjoint domains from one root snapshot:

- **SIM eligible:** anonymous reserve plus remaining of all SIM births, including dormant archived births.
- **PHYS:** exact standing bound instances; deaths come only from verified native receipts, inside or outside battles.
- **Unavailable:** pending/retiring/unresolved instances. They do not silently become SIM or contribute invulnerable effective defense.

Both `resolveAssault` and `counterattack` must calculate their simulated defender loss from the SIM domain. An existing whole-garrison loss must not merely be relabeled uncovered or capped after subtracting it. If it exceeds the eligible domain, recompute the domain-specific battle action before committing; never spill into PHYS. The physical attacker/defender outcome bridge and balance remain separate integration work: this accounting proposal does not prove that decorative siege bands equal aggregate pressure or make the integrated siege finished.

Political capture does not fabricate deaths or convert allegiance automatically. Historical home, current host and faction/loan ownership are distinct concepts. A host may lose a battle while an unresolved cohort remains unavailable; uncertainty about one actor must not indefinitely block the entire host's battle or grant defensive strength to a ghost.

## 3. Ordinary handoff through the existing owner

**SIM -> PHYS:** commit a birth claim with a new global instance generation and exact remaining snapshot before native creation. Only streets/popSync may spawn. Successful creation/tagging plus durable exact native-ID binding activates PHYS. If a crash leaves the outcome unknown (including spawn-before-tag/binding), do not infer that no actor was created from an empty loaded census; hold that birth and reconcile the bounded intent area. Untagged actors are not adopted or deleted by guesswork. This remains an unavoidable native-operation/persistence acceptance boundary.

**PHYS -> SIM:** keep PHYS authority while committing RETIRING intent. While loaded, freshly verify exact instance/identity and positive live health, then call the owner's non-death `remove()` without yielding. Persist the explicit successful live-removal outcome and drain the matching ingress before ending coverage. A verified death encountered instead consumes the PHYS snapshot. Only a settled live-removal outcome returns the same surviving birth and remaining to SIM. Archival follows that transition; archival itself changes no count.

Do not use unload or `getEntity` absence as this proof. Demote while loaded when possible. A bounded existing-owner cleanup job may load the last verified instance area with owned leases and repeat exact checks; no guard/player teleport and no second spawner. If no exact outcome can be established, mark only that birth UNRESOLVED and retain its slot/receipt evidence. Other SIM cohorts can still fight, train, reinforce and take losses, so visiting a district no longer creates a permanent host-wide combat veto.

**Important open native proof:** the installed API supplies death/removal events but no demonstrated event-flush fence or transactional native-remove-plus-property-save. Positive-health/read/remove ordering, delayed callbacks and the live-removal receipt must be tested. A boolean `quiescent` is not authentication. An old **consumed** receipt can safely replay as a no-op. A newly observed death that contradicts a claimed live-removal terminal is a protocol conflict, not something to ignore merely because its epoch is old. Hold/reconcile that birth rather than charging a newer instance. A crash after native death/removal but before durable ingress/outcome can remain ambiguous; this proposal does not claim to eliminate that window.

## 4. Dormant SIM losses and representation

Archived SIM births are normal eligible soldiers. For an explicit count, walk a deterministic birth order, set whole consumed births to zero, and reduce the last partial survivor's `remaining`. Retain that survivor's ID/home/initial count; no child replacement or renumbering is necessary. Zero births are never promoted again. For example, initial5/remaining5 -> SIM loss2 -> same birth remaining3 -> PHYS snapshot3 -> verified death3 -> zero. No stage subtracts five again.

Ranges become an **optimization**, not an authority/capacity gate. Merge only rows with identical initial, remaining, home, host and compatible lifecycle metadata. Sparse visits, distinct epochs or partial casualties may fragment ranges arbitrarily; fall back to authoritative fixed-size pages rather than refuse ordinary host combat at128 ranges.

Suggested concrete paging design, to validate in a future isolated version:

- Logical pages cover128 consecutive birth generations, so slot identity is implicit and never shifts. Bounded tuples retain initial/remaining, home/host indices and lifecycle metadata. Enforce at most24,000 UTF8 bytes per serialized page; spill optional opaque/native metadata to separately hashed records rather than assume an undocumented engine-ID length.
- A content-addressed/copy-on-write radix directory has bounded fanout64 and at most eight levels. That addresses all safe-integer generation pages (generation index remains below2^46). A root contains hashes/pointers/counters, not an unbounded page-key array. Directory nodes and pages obey the same byte bound.
- An absent/corrupt page is UNKNOWN, not dead. A fully dead page can be replaced only by an explicit authenticated dead-page tombstone in the directory. Next-generation and terminal watermarks never move backward or reuse IDs.
- Per-host/subtree sums record SIM/PHYS/unavailable remaining and total; every changed page updates its ancestor summaries in the same proposed root. Loading a cohort reads one bounded path, not the entire world's history. Actual storage exhaustion holds a new allocation with evidence intact; no model can honestly promise infinite storage.

This removes v3's fragmentation-induced combat refusal while keeping per-property, per-slice and per-transaction memory bounded. It requires a new paged store; the present fixed12-key/96KB prototype is not that implementation.

## 5. One commit authority and bounded ingress

The root commit must cover kingdom counts, cohort pages, reserve pools, garrison/loan/training effects, battle actions and consumed receipt position. Do not publish an army root and then independently save an old kingdom snapshot. `advanceKingdomStep` must prepare the whole proposal, validate it, then publish one authority; its rollback remains all-or-nothing for the proposed step.

Allocate bounded death/control inbox slots with standing bindings, at most one first-death record and one live-removal control record per occupied instance. No replacement/rebinding until its predecessor's terminal record is consumed/settled. Thus the24 physical slots bound eligible outstanding first deaths, independent of population. Duplicate ingress for the same instance/terminal identity does not consume new slots. An overflow/read/write error stops further transitions rather than discarding receipts. Native ingress is the sole event producer; it does not independently mutate kingdom counts.

Copy-on-write page staging can proceed in bounded job slices while the previous root stays authoritative. Freeze new army transitions while staging; exact bound deaths may append durable inbox records for the next commit. After successful publication, consume/replay against the new root, then clear consumed inbox slots. Receipt/terminal high-water marks plus bounded active holes avoid a permanent per-death history. Do not compact an instance whose ingress/handoff is unresolved. Page GC protects the current root, retained prior root and pending transaction, using exact owned allocation receipts; no broad prefix deletion or unknown-manifest cleanup.

Native disk ordering/CAS is still unproven. The present store's injected crash model and88 checks do not prove that ingress reaches disk before a world failure. Preserve/refuse contradictory or future state instead of falling back to a roster that could resurrect casualties.

## Counter-scenarios that must pass before coding promotion

1. A and B fight in the same hour while a peaceful C guard dies to lava: three independent valid authorities; no global engagement lock.
2. Initial5 SIM birth loses2, survives as3 under the same ID, binds a3-head snapshot, then dies: total debit2+3 exactly once.
3. A PHYS guard unloads: no debit and no automatic SIM promotion. An actual later matching death event remains eligible while its standing epoch is active.
4. Owner live-removal races a death or crashes: only settled evidence decides; an ambiguous actor does not respawn or become an effective invulnerable defender, and other host combat continues.
5. A death receipt replays after rebind: a consumed receipt is ignored; a conflicting unseen old-instance death holds the birth and cannot debit the replacement.
6. A lends a surviving3-head cohort through B to C: historical home remains A, host changes, loan route is explicit, and transfer waits for that cohort's physical settlement. Return to lender B is not guessed from home A.
7. Ten thousand dormant births receive scattered one-head SIM losses: stable IDs/initial counts remain; bounded pages handle fragmentation without the old128-range combat veto.
8. A step is rejected, or power fails before/after root publish: no half-applied training/loan/casualty state; inbox replay is idempotent. Native event-to-disk loss remains a separately declared limitation.

**Recommended next step:** review this policy first; then implement only a new isolated v4 pure model for concurrent host action IDs, standing coverage and partial SIM survivors, followed by paged storage. Keep production debit disabled until the native birth/death/removal/identity tests and ingress barrier are accepted. No v4 code has been written here.
