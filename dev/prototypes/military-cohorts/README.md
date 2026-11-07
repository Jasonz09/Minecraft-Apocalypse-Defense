# Exploratory military cohort/accounting spike

**Pure, isolated and not integrated.** Everything here lives under `dev/prototypes/military-cohorts/`. It changes no active BP/RP, world, existing test, production schema or roadmap document. There are no Minecraft imports, entity operations, timers or storage writes. It does not implement a casualty event listener or claim lossless death capture.

The original full-roster v1 experiment below is retained unchanged. The newer **reserve-backed v2** in [RESERVE_V2.md](RESERVE_V2.md) removes the recruitment-capacity coupling and adds home/host and native-instance distinctions. Its 128-surviving-birth lifecycle limit remains explicit; it is not production-ready.

This experiment makes the next accounting design concrete. Its explicit experimental rule is: **an eligible representative death removes that cohort's snapshotted represented headcount**. Default cohort size is five, matching current `groupSize.sol`; a partial cohort loses exactly its smaller snapshot. This is an accounting experiment, not an approved gameplay balance or a fixed swordsman/archer/cavalry mix.

## Model and pure API

`cohorts.mjs` exports `migrateLegacy`, `transact`, `validateRoster`, `savedBytes` and `LIMITS`. A roster is scoped to one district/lineage chosen by its future owner.

```js
const migrated = migrateLegacy({ rosterId: "lineageA_d1", soldiers: 12 });
// Three births: 5, 5, 2 represented soldiers. No actors are created or adopted.
const opened = transact(migrated.state, {
  type: "open",
  coveredIds: [migrated.state.cohorts[0].id],
});
const cohort = opened.state.cohorts[0];
const death = transact(opened.state, {
  type: "physicalDeath",
  receipt: {
    rosterId: opened.state.rosterId,
    sequence: opened.state.engagement.sequence,
    cohortId: cohort.id,
    generation: cohort.generation,
    representedHeadcount: cohort.headcount,
  },
});
// death.state contains soldiers=7 AND the consumed receipt identity.
// The other two durable births remain. The killed lowest birth is not recreated.
```

Each cohort has `{id, generation, headcount}`. IDs derive from a bounded lineage identifier and a monotonically increasing birth generation; they are independent of aggregate rank slots. **No ID or generation is reused.** Recruitment always creates new births rather than refilling an existing partial cohort, so surviving identities and active physical snapshots stay intact. Simulated loss consumes the oldest eligible birth first and reduces the last surviving partial cohort without changing its identity.

The authoritative state includes its aggregate `soldiers`, live cohorts, next birth generation, next engagement sequence, last closed engagement watermark and at most one active engagement. Validation requires the cohort sum to equal the aggregate. A successful `transact` returns `{ok:true, state, aggregate, consumedReceipt, effect}`; the whole new state is the proposed commit. A rejection returns `{ok:false, state:originalInput, aggregate:null, consumedReceipt:null, reason}` without modifying either input or command. The result is **one logical transaction**, not a native durability guarantee.

Migration is explicit and deterministic: legacy cohort/rank position `i` maps to initial birth generation `i+1`, including the exact partial final group. This does **not** attribute any live legacy actor to a new birth. A future versioned owner must journal that binding/adoption separately, preserve unknown actors and never rerun legacy migration after deaths or on corrupt/newer cohort data.

## Coverage prevents overlap by explicit authority

- `open` snapshots the exact live cohorts assigned to physical authority for one monotonic engagement sequence. All other live births are simulation-eligible. No automatic physical promotion or class distribution is inferred.
- `simulatedLoss` requires the exact current sequence and `scope:"uncovered"`. It can consume only simulation-eligible headcount. Ambiguous total-loss scope, missing scope or a count exceeding uncovered soldiers rejects the **entire** transaction; it never spills losses into a physical cohort.
- `physicalDeath` requires the same roster, current engagement, covered birth/generation and exact snapshot headcount. Uncovered, foreign, future, mismatched or impossible receipts refuse without a debit. The first accepted receipt removes that exact birth and records consumption in the same returned state; repeats are no-ops.
- Coverage cannot be changed while an engagement remains open. `close` requires a quiescent barrier, zero pending inbox receipts and exact surviving coverage attestations. Missing/duplicate/mismatched survivors or pending work refuses handoff. Recruitment during an engagement creates uncovered births; it does not silently alter existing physical coverage.
- Closing advances `closedThrough` and drops the per-engagement receipt set **in the same state transition**. Delayed receipts from closed sequences become harmless no-ops. A new engagement cannot reuse an old sequence; replacement recruits cannot reuse a dead birth.

The pure module cannot authenticate `quiescent:true`, pending counts or survivor attestations. These are an explicit **future owner/ingress barrier contract**, not proof supplied by a boolean. Real integration must stop the old combat authority, drain durably captured receipts and verify surviving actor bindings before closing coverage. A false attestation can lose a casualty; this experiment does not claim otherwise. Similarly, a caller must calculate simulation losses from the uncovered domain, rather than relabeling an existing whole-garrison loss as uncovered.

## Bounds and compaction

Current experimental limits are 128 live cohorts per roster, 32 physically covered cohorts in one engagement, 24,000 saved UTF-8 bytes and group sizes from 1 through 1,024. These are **prototype limits**, not changes to production population caps. All counters/counts must be safe integers; overflow, capacity exhaustion, unknown fields/versions, aggregate mismatch and invalid snapshots refuse. Recruitment never partially applies when capacity is insufficient.

Consumed receipts are bounded by current physical coverage. Compaction preserves both monotonically increasing birth and closed-engagement watermarks. It never resets sequence counters or permits a stale receipt to debit a newly recruited birth. Maximum-length IDs, large safe generations, a full live roster and a full consumed coverage ledger are checked against the byte ceiling. Generation/engagement exhaustion explicitly refuses further allocation.

## Checks

Run from the project root:

```powershell
node --test dev/prototypes/military-cohorts/cohorts.test.mjs
```

Tests exercise migration and partial groups; a killed lowest birth remaining absent; new reinforcement generations; immutable survivors; duplicate/stale/future/foreign receipts; simultaneous physical/simulated authority; commuting independent losses; rejected ambiguous handoffs; capacity, byte and safe-integer bounds; saved-state corruption; frozen-input purity; and 300 death/close/recruit cycles without unbounded receipt growth. These are pure accounting tests, not Bedrock event, combat or storage tests.

## Necessary production work and crash limits

1. **Schema/store:** introduce a versioned authoritative roster in the same saved kingdom transaction as soldiers and receipt consumption, with a real lineage/epoch binding, explicit legacy migration and refusal for unknown/corrupt roster data. Preserve the current aggregate/garrison validation. `kingdom/store.js:save` is not a compare-and-swap or a multi-property transaction; coordinate one sequential writer and persist the complete accepted state.
2. **Population owner:** adapt `population/groups.js` and LOD/adoption to durable births, retaining streets/popSync as the sole creation/removal owner. Bind each canonical actor to a verified birth and native instance generation. Rank-slot tags alone are insufficient. Birth journaling, live legacy adoption and type/class selection migration need their own crash-safe design; this module neither spawns actors nor adopts untagged strays.
3. **War/training/recruitment:** update `sim/war.js` assault **and counterattack** loss authority to use explicit engagement coverage. Route recruits, training completion, capture and any other soldier-count changes through roster transitions. Do not subtract physical receipts on top of the same simulated losses. Keep pure step rollback and garrison assignment consistent with the proposed roster/aggregate result.
4. **Death capture:** use the installed stable event API to capture only an exactly bound actor generation into a bounded durable inbox. Validate roster, cohort, represented snapshot and engagement before consumption. Missing/unloaded actors are never death evidence. Owner removal for LOD, teardown or rollback is not a casualty. Inbox overflow/read/write failure must hold authority transitions and replacement, rather than silently discard receipts.
5. **Commit/replay:** persist debit plus consumed identity together; clear separate inbox entries afterward. Crash before commit replays an unconsumed durable receipt. Crash after commit but before inbox cleanup finds it already consumed. Close/compaction must happen only after the real ingress barrier, so pending old-authority data cannot be discarded merely to bound storage.

There is still an unavoidable **unproven event-to-durable-inbox window**: a process/world failure can occur after native death but before its receipt is persisted, and there is no demonstrated replay of that event. This spike guarantees idempotent accounting only for supplied receipts under valid coverage, not total death capture or disk-level atomicity. Physical damage is not rolled back when a pure simulation transaction rejects. Actual actor persistence, native generation binding, save/rejoin behavior, authority handoff and crash ordering remain separate acceptance work.
