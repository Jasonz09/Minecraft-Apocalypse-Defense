# Reserve-backed military accounting experiment v2

**Isolated, pure and not integrated.** `reserve-v2.mjs` and its tests do not import Minecraft, edit BP/RP, create entities, change the production kingdom schema or debit a native death. Original `cohorts.mjs` v1 and its 21 checks remain as historical full-roster work. This v2 is a separate candidate model, not a migration of any deployed v1 roster.

## What changed

The original `128 cohorts × groupSize5` experiment could cap 128 one-person graduations because every recruit batch allocated a permanent birth. V2 stores unmaterialized soldiers in **aggregate reserve pools**, keyed by immutable home province and current host province. Each province's home=host pool is preallocated and retained even when empty. Ordinary graduation adds to that pool; it allocates neither a tracked cohort nor a native actor. Ten thousand one-person graduations work with zero tracked births, and another ten thousand work when all 128 tracked slots are already occupied. Even a full 256-entry transfer-pool table retains every province's recruitment slot.

This removes an accounting cap on ordinary recruitment, not every lifecycle limit. Counts and their total must fit a nonnegative safe integer. Invalid state, revision exhaustion or numeric overflow still rejects the whole transaction.

**The 129th distinct surviving tracked birth still refuses materialization.** Releasing native instances after visiting 128 distinct groups leaves their live birth identities intact; visiting a new group cannot silently fold those survivors into an anonymous reserve. A regression demonstrates this deliberate refusal. The prototype therefore does **not** solve long-lived worldwide materialization capacity. Production needs stable-ID archival/reactivation (or bounded compressed identity ranges plus an authenticated archive manifest) before promoting arbitrarily many distinct live groups. Never free capacity by erasing or renumbering surviving births merely because chunks unload. This missing architecture is a blocker for broad rollout, not for further isolated experiments.

## Invariants and pure API

- State v2 has a bounded province table, home/host reserve pools, tracked births, native bindings and at most one explicitly covered engagement. `v2Aggregate` derives total, per-host and per-home counts; returned garrison front+reserve equals the host total.
- `materialize` moves an exact positive represented headcount (at most configured groupSize, default five) from a reserve pool into `{id,generation,headcount,home,host}`. Birth ID, birth generation, headcount and home are immutable throughout that birth's life. There is no class field or fixed soldier mix. Recruitment does not refill or alter a surviving partial snapshot.
- `transferCohort` changes host only, after its instance is settled/released and outside coverage. `transferReserve` preserves home while moving host. Home is historical origin, **not** a replacement for the production reinforcement loan ledger, political allegiance or commander ownership.
- `bind` allocates a separate monotonically increasing **native instance generation**, plus an opaque actor token. It does not spawn, tag or authenticate a Minecraft actor. Explicit owner `release` removes only that binding, after a supplied settled/no-pending-receipts barrier; it changes no headcount or birth identity. Ordinary unload is not permission to release a binding or declare death.
- `open` requires all tracked births at the engagement host, with exact native bindings. Those snapshots gain physical casualty authority. At most 32 are covered; more tracked births at that host refuse the handoff. Other soldiers at that host are aggregate reserve, the explicitly simulation-eligible domain. Promotion into an active host is refused rather than silently changing coverage.
- `simulatedLoss` accepts only `scope:"uncovered-reserve"`, the current engagement sequence at that host, and a count no greater than eligible reserve. With no active host engagement, a host containing any tracked birth refuses simulation until authority is explicitly settled. It never fills a reserve deficit by killing or partially resizing a physical snapshot. Losses across home-origin reserve buckets use canonical home order, an experimental accounting rule rather than approved gameplay balance.
- `physicalDeath` needs lineage, current sequence, exact birth/home/host/headcount and exact bound native instance/token. One accepted receipt removes precisely that whole cohort and records consumption in the same returned state. Partial groups lose their exact snapshot. Duplicate receipts are no-ops even if their original optimistic revision is stale. Closed-sequence receipts are bounded by a monotonic closed watermark and cannot debit a newer birth or instance.
- `close` requires quiescent ingress, zero pending receipts and exact surviving instance attestations. It then compacts consumed coverage while preserving birth, instance and engagement high-water marks. These supplied attestations are **not authenticated by the pure model**.
- `recruit`, `transferReserve`, `transferCohort`, `found`, `capture`, `assignGarrison`, `open`, `simulatedLoss`, `physicalDeath`, `close`, `bind`, and `release` are explicit operations in `transactReserveV2`. `found` creates a province and moves its founding reserve in one rollback-safe proposal. `capture` changes only the province controller, after local bindings/coverage settle; it does not decide soldier allegiance, convert civilians or infer casualties. `assignGarrison` partitions the host count without creating soldiers.

```js
import { migrateReserveV2, transactReserveV2, deathReceiptV2 } from './reserve-v2.mjs';
const result = migrateReserveV2({
  lineage: 'fresh_trial',
  provinces: [{ id: 'district-1', controller: 'kingdom', soldiers: 12 }],
});
const state = result.state;
const proposed = transactReserveV2(state, {
  type: 'materialize', revision: state.revision,
  home: 'district-1', host: 'district-1', headcount: 5,
});
// proposed.state + proposed.aggregate are ONE proposed logical commit.
// A future sole population owner must authenticate/spawn/bind the actor separately.
```

Success returns `{ok,state,aggregate,consumedReceipt,effect,changed}`. Rejection returns the original state reference unchanged with a reason. Each ordinary mutation requires the exact current revision; replaying the same assault/training command with its old revision refuses. This is **not a production store CAS** and does not deduplicate a caller that intentionally submits the same simulated loss again with a fresh revision. A production step/event identity and sequential writer remain necessary. Physical receipt identity, in contrast, has explicit replay handling in the returned roster.

## Bounds and failure behavior

Prototype limits: 128 retained tracked births/bindings, 32 covered snapshots, 32 provinces, 256 pools, groupSize1..1024 and 96,000 serialized ASCII bytes. These are model bounds, **not production soldier caps or approved world limits**. A transfer that needs a new full-table pool refuses atomically; base recruitment pools remain available. Every aggregate, counter and amount is a safe integer. Overflow, corrupt/future state, missing allocation, exhausted generation/revision, changed receipt identity and ambiguous authority reject without mutating state or commands. Empty foreign pools compact; base pools remain.

The 96KB prototype bound exceeds one Bedrock dynamic property's limit. A real saved roster therefore needs verified chunked storage plus an atomic manifest/commit design, or tighter per-shard budgets. This model's single returned transaction proves neither disk atomicity nor a safe multi-property commit. It must not be copied into one native property.

## Production mutation-path audit and smallest coherent integration

Current production source pointers below were read on 2026-11-05. They identify work still required, not active changes.

| Current path | Existing mutation | Required cohesive adapter |
| --- | --- | --- |
| `scripts/kingdom/state.js:53 makeDistrict`, `:100 createV2Kingdom`, baseline construction | Initial aggregate/garrison | One explicit new lineage + reserve migration with safe schema versioning. Never migrate again from a later aggregate after a casualty. No inference that old rank-slot actors belong to new births. |
| `scripts/sim/population.js:268 openRecruitment` | Civilians become training queue, not soldiers | Preserve queue semantics; no cohort or soldier increment here. |
| `scripts/sim/population.js:368 advanceTraining`, increment at `:404`; `sim/tick.js:93` | Graduated count increases soldiers | Enlist exactly that graduation into home=host reserve within the same kingdom step/queue decrement transaction. No count cap from tracked slots. |
| `scripts/sim/war.js:537 requestReinforcements`, donor/recipient writes `:608/:610` | Transfers host count; maintains `reinforcedBy` | Move explicit home-preserving reserve/cohorts plus the real loan ledger atomically. Covered or bound cohort transfer must settle/refuse, never move only its aggregate. The existing max16 ledger plus unattributed overflow needs a loss/return attribution policy; these home/host pools do not replace it. |
| `scripts/sim/war.js:714/:716 releaseReinforcements` within `recoverAfterDefense(:919)` | Returns surviving loan amounts | Route exact remaining origin/loan tranches back to the previous lender; chained A→B→C assistance must not jump straight to historical home A. Preserve ledger rollback with the host move. |
| `scripts/sim/war.js:749 resolveAssault`, loss `:776` | Main simulated defender loss | Calculate a reserve-domain loss from explicit authority coverage; do not subtract the existing whole-garrison loss then relabel it uncovered. Covered representative deaths are separate exact receipts. |
| `scripts/sim/war.js:853 counterattack`, second loss `:869` | Additional defender loss | Apply the same partition/revision contract; this second writer must not remain as a raw aggregate subtraction. Previous v1 prose mentioning a withdrawal loss was inaccurate; this actual second writer is counterattack. |
| `scripts/sim/war.js:830` lost/capture state transition | Changes control/security without a soldier subtraction | Preserve historical home/current host and settle actor/engagement authority before any new political/allegiance policy. No invented casualty or automatic conversion. |
| `scripts/sim/expansion.js:559 claimTerritory`, donor `:607` + new district creation | Founding garrison transfer along with civilians/resources/projects | Use one broader kingdom clone/commit including province founding, count transfer, resources, settlers and queues. Prototype `found` proves only the soldier/province part; resource/build rollback still belongs to the existing transaction. |
| `scripts/sim/war.js:289 assignDefenders`; `scripts/sim/population.js:78 syncGarrison` | Normalizes total and partitions front/reserve | Derive authoritative host totals from roster; only partition them. Reject disagreements rather than silently repairing the aggregate away from known identities. |
| `scripts/sim/starter.js buildStarterBaseline`, invoked by `commands/starter.js:273` | Restores published starting counts | Explicit fresh lineage only for the prepared fresh-world path, after existing development-state guards; never reset a live roster/receipt ledger to resurrect killed births. |

The source-wide `.soldiers` assignment audit also finds `people/contract.js:543`, which is a derived per-person summary bucket, not a mutation of the current kingdom's soldier total. That older individual-person contract/roster path is not the current streets owner; it must not become a second casualty or population authority. Reinforcement `existing.soldiers` / `untracked.soldiers` writes are loan-ledger entries, not extra independent troops; their accounting must remain coupled to the host transfer.

Prototype `v:2` is unrelated to production kingdom schema version2. A real additive production roster needs a new explicit schema/migration boundary, with older-pack refusal and legacy v1→existing-v2 handling reviewed rather than stamping the new version over an unmigrated state.

**Smallest coherent production slice after first native guard:** first version the kingdom/store schema and stage a fresh-fixture reserve ledger, with every soldier writer above routed through a single sequential pure transaction path. Keep native casualty debit disabled until covered engagement receipts and stable actor-instance binding are wired. Preserve sole streets/popSync creation/removal, selected-group opt-in and wrong-type/duplicate/query-error holds. Production legacy adoption, rebinding military selection from rank slot to birth, garrison authority and archive/reactivation are separate required work; adding only an entity-die listener would be incomplete.

Native first-guard acceptance remains prerequisite: visible selected human guard, friendly target exclusion, managed-siege combat/cooldown, pursuit bounds, identity after unload/rejoin. Then use a separate backed-up fixture for one covered cohort: verify exact represented headcount, actual instance binding, one managed death receipt/debit, duplicate replay, simulation reserve loss beside it, close/rejoin and a genuinely new recruit generation. Test owner LOD removal/teardown separately as no-casualty transitions. Natural/lava/player deaths outside covered engagements remain **unsupported/refused**, not total casualty coverage.

## Crash and event limits

No native death event is persisted by this experiment. A future crash after native death but before durable inbox capture may lose the event; no replay guarantee has been demonstrated. Missing/unloaded actors and engine entity-remove notifications are not death evidence. A caller-supplied barrier/actor token cannot prove the actor is gone, inbox is drained or ownership is legitimate. Disk writes, loader behavior, combat targeting, global archive retention and native instance generation tags all require separate integration/acceptance. This prototype guarantees only pure, bounded accounting for supplied valid transitions and explicitly covered receipts, with no lossless-event or fully solved lifecycle claim.

Verification on 2026-11-05: **43/43 standalone checks pass** (22 new reserve-v2 cases plus the retained 21 v1 cases), zero failures/cancellations/skips, about9.6seconds in the recorded run. `reserve-v2-focused.log` is isolated output, not part of the active full pipeline. No native acceptance, production integration or typecheck of an active-pack change is claimed.

Run from the project root:

```powershell
node --test dev/prototypes/military-cohorts/*.test.mjs
```
