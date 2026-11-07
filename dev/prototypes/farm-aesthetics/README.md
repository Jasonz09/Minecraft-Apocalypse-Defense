# Farm-frontage lighting and spaced water piles

**Isolated prototype/design, not integrated or installed.** The active BP/RP, existing tests, saved plans, worlds and project documentation are unchanged. All implementation/checks here live under `dev/prototypes/farm-aesthetics/`. The module imports current pure production planners read-only and performs no native block mutations.

## Concrete alternatives

| Feature | Original | Explicit new prototype option |
|---|---|---|
| Small allotment/kitchen garden | Four corner lanterns | `farmLighting:"frontage-v1"`: one standing lantern beside the entrance |
| Vegetable/wheat/irrigated field | Four corner lanterns | Same version: two standing lanterns flanking the entrance |
| Water deck supports | Every perimeter cell plus the three-block interior grid | `waterPiles:"spaced-v1"`: corners and perimeter supports every three blocks; interior grid retained |

The farm lanterns use **existing fence supports** immediately adjacent to the gate. Nothing occupies the gate itself; no new lamp posts, fence supports, soil, crops or additional light types are introduced. The existing pathside lighting already provides some torch/lantern variety. This proposal fixes repeated bright farm outlines, rather than increasing global light density.

At seabed Y46, water Y62 and deck Y63, the unchanged production planner and the alternative give:

| Footprint | Old support columns / log blocks | New support columns / log blocks |
|---|---:|---:|
| 9×9 allotment | 36 / 576 | 16 / 256 |
| 19×19 vegetable field | 97 / 1,552 | 49 / 784 |

These are timber-pile calculations, **not a diagnosis of native dirt columns**. All non-pillar deck operations stay unchanged, every land/masonry support is retained, and no water is filled. The independent prototype proof requires complete retained columns to natural bearing, all deck cells, all four supported corners and no more than two horizontal Manhattan steps from a support. That is a conservative geometric screen consistent with the existing three-block interior grid, not a Bedrock physics or completed-building structural proof.

## Compatibility and limits

Absent options return the original canonical farm operations and original production deck result. Unknown versions refuse. The standalone tests check original op/checksum input equality for all five crop-field blueprints at all four rotations; the default deck is compared directly with production. This does **not** replace a full saved-site checksum/rehydration regression after future integration.

The new options must be persisted only when explicit. Old records without them must retain the four lanterns and dense piles under their original checksums. Do not silently change `cropField`, `DECK_PILLAR_EVERY`, default `planDeck` behavior or existing saved options.

The water-pile alternative is intentionally limited to reviewed farm footprints up to 25×25, the existing three-block support grid, bounded coordinates, current maximum depth 64 and cut 16. It preserves production failures for hollow ground, unreachable/deep foundations and invalid water deck levels. It is not a general bridge/house/harbor rewrite.

**Existing-world pile removal is not implemented or authorized by this prototype.** Soil/farm floor and shared structures need more provenance than a timber block match. Preserve existing piles; use the new version for a separately generated validation copy. Retrofitting structural piles would be another scoped feature requiring full final ownership, neighboring contacts, fluid/ground/remaining-support proof and native inspection.

## Guarded existing-world lighting migration protocol

`fixtureMigrationProposal` accepts the derived frontage draft plus a source checksum/owner and an `ownershipAt` provider. That provider must come from **complete checksum-verified saved-plan loading and all-stage final-write indexing**, including later overrides and relevant neighbor plans. The prototype does not authenticate a checksum-looking string or infer ownership from block ID. Unknown final ownership refuses. A neighboring explicit AIR clearance is not free space to occupy.

The proposal is immutable and fingerprinted. It proves the four original lantern placements, their existing anchors, the entrance gate and the new supported target coordinates. A source or anchor overwritten later—even with a similar-looking block—or a new target claimed by another plan refuses. New targets must be unplanned/known own AIR and actually empty.

The pure state machine models this order:

1. **Read-only preview:** exact original fixtures and their planned states must be present; current anchors/gate must match; new targets must be AIR. Changed/player/foreign states, containers, occupied new targets and unloaded/unreadable cells hold the entire farm. An identical new lantern already present without a trusted journal is not adopted.
2. **Prepare:** persist a bounded journal binding version, source checksum, farm owner and proposal fingerprint **before any native mutation**. `prepareFixtureMigration` only returns that proposed journal; it does not persist it.
3. **Place first:** `fixtureMigrationStep` returns at most one proposed new-fixture placement. Keep all four old lanterns until every new target is exact, supported and present. Call `migrationActionReady` again immediately before executing each proposed block change.
4. **Stability:** wait at least two real runtime ticks with all new fixtures present and all anchors intact. A reset tick epoch starts the wait again. A missing/dropped/changed new light vetoes removal. Offline tests cannot prove native attachment stability; save/rejoin checks are still required.
5. **Checkpoint then remove:** durably save the `removing` phase before deleting an exact original corner lantern. Re-read all guards/new fixtures and the particular source before every removal. AIR at an old source is accepted only during trusted removal/done replay. Unknown blocks and changed states are never removed.
6. **Done/rejoin:** all old source cells must be AIR and every new fixture/anchor exact. Repeating the same matching journal is a no-op. A mismatched/tampered journal, changed support or foreign block holds further work. Cancellation schedules no mutation and retains the resumable journal; it does not blindly tear down already placed fixtures.

Exact ID/state matching still cannot distinguish a player replacing a block with an identical block. Use this feature first on the known authoring/validation copy with backups and verified plan provenance. Do not market the matcher as universal historical ownership detection for arbitrary player worlds.

The current outdoor natural-light migration intentionally excludes farm building fixtures; simply extending its removal list would skip this placement/stability/provenance protocol. A dedicated guarded farm migration is the smaller reviewable boundary. Existing canonical plans/checksums should remain frozen. Any later maintenance or audit that checks a migrated fixture must recognize a verified, complete frontage alternate; otherwise it can restore the old corners or report expected differences incorrectly.

## Required integration steps

1. Add explicit `farmLighting`/`waterPiles` version persistence and rehydration in `civ/districtplan.js` (`persistedOptions`, `siteOptionsOf`, saved-plan regeneration). Keep absent/unknown behavior tested. Root command defaults should opt in only for newly planned validation districts after review.
2. Apply the frontage transform in `buildingOpsSteps` before support generation for the five reviewed open-air crop blueprints. Keep enclosed-room anchored lighting and all other open-air blueprints unchanged. Reuse production rotation, state encoding, final-op normalization and cooperative work budgeting.
3. Add the opt-in water-edge predicate to the farm deck planning path (`tryPadAt`/`planDeckSteps`/`foundations.planDeck`) without changing land supports, ordinary decks, roads, bridges or saved legacy behavior. Integrate the support proof into the normal bounded planning failure path.
4. Build a cooperative, target-only final-write provenance index from verified source records and relevant neighbors, not an unbounded synchronous whole-city array. Add a read-only farm preview and separate explicit-confirm migration command using existing construction exclusion, chunk loading/leases, journal recovery and cancellation infrastructure. Bound per-tick world reads/writes; never force unloaded chunks or weaken foreign-block guards.
5. Add a bounded saved migration codec, independent exact live fixture checks, place-first/stability/checkpoint/remove ordering and restart tests. Make successful maintenance/audit alternates conditional on both the verified original plan and exact supported migrated fixture state. Starter/export handling must surface unfinished migrations before release.
6. Run saved checksum/plan parity, focused runtime fault tests, strict typecheck and the full project gate before closed-world deployment. Then inspect a separate native validation copy; do not modify the currently accepted/frozen city as an implicit side effect.

## Acceptance and effort

Run the isolated checks:

```powershell
node --test dev/prototypes/farm-aesthetics/farm-aesthetics.test.mjs
```

**19 tests pass, zero failures/skips.** They cover all crop footprints/rotations, default checksum-input parity, supported sparse fixtures, unchanged non-light cells, exact pile counts, mixed shore preservation, support-proof failures, final ownership/overwrite refusals, foreign/changed states, late obstruction/unload, placement before removal, interrupted/repeated migration, dropped lights, cancellation, tick reset and malformed journals. No full project verification or native test was run for this isolated prototype.

Native acceptance still needs daytime/night aerial and walking views, stable fence attachment through save/rejoin, the entrance remaining clear, explicit crop growth after harvest/replant, intact deck/water behavior and repeated guarded maintenance. Fewer entrance lamps are **not** a promise of all-night growth across a large field. The current blueprints start with mature crops; that visual state does not validate future farming. [Minecraft's official farmland guidance](https://www.minecraft.net/da-dk/article/block-week-farmland) recommends some artificial light during darkness. If continuous nighttime cultivation is a requirement, measure it separately and choose limited working-area lighting rather than restoring a uniform four-corner frame everywhere.

Planning estimate: **two implementation slices**—versioned new-generation geometry, then guarded existing-world lighting migration/maintenance integration—roughly **3–6 focused engineer-hours**, before review findings. That is an estimate, not measured progress or a completion promise. Full verification and a separately generated native city/night/rejoin acceptance add variable time. The second slice depends on verified final-write provenance and durable migration plumbing; existing-world structural pile removal is outside this estimate. None of this finishes the broader mod roadmap by itself.
