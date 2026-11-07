# Saved civilian destinations — staging only

This is an integration-ready **read-only preview**, not accepted civilian work or
movement. No files in the active BP/RP, installed packs, root tests or project docs
were changed. The population streets/reconciler remains the only actor owner.

## Proposed production changes

Promote only these four files after review and the native guard checkpoint:

- `scripts/people/destinations.js`: pure saved entrance compiler/parser/formatter.
- `scripts/integration/civilianDestinations.js`: on-demand async verifier/preview.
- `scripts/commands/people.js`: copied current source with a separate async preview
  branch; existing travel commands remain synchronous. Arrays, never promises,
  reach `reply`; failures have a catch handler.
- `scripts/main.js`: copied current source with complete factory initialization
  using the actual kingdom store, saved loader, scheduler and exclusive job owner.

`proposal.patch` contains exactly those four changes. `handoff.json` records base
and proposal hashes; check the existing source hashes before applying because
other work may advance main/people command. Do not overwrite unrelated changes.
The tiny `scripts/civ/districtplan.js` and `scripts/structures/blueprints2.js` files
are **staging-test import shims only**, not production proposals. The
`validation-overlay/` is a disposable validation copy, also not for promotion.

## Actual integration chain

`main.js` constructs `civilianDestinations` with:

1. `readKingdom: () => kingdomStore.load().kingdom` (no early-execution world read).
2. `loadSaved: (civ,index) => loadSavedRunSteps(civ,newOps(),index)`.
3. `runJob: runJobAsync`, `reserveJob`, `finishJob` from the existing native boundary.
4. `registerPeopleCommand({destinationsCommand:civilianDestinations.command,...})`.

The command requires a player in the explicit saved dimension, one completed
district identity and the verified complete queue/plan hash. The existing loader
rehydrates/checksums the frozen master/site/queue; no synthetic `verified=true`
input substitutes for that path. The compiler also rejects a JSON-cloned record
without live generators and mismatched source district/checksum. Repeated calls
rebuild evidence rather than reusing a stale destination cache. Every cancellation,
loader failure and compiler failure releases only its own exclusive job token.
The player dimension and saved civ identity are freshly checked before replying.
Metadata is checked again after all candidate-review yields, so a late change
cannot evade the final source check.

The compiler reads actual `building-*` descriptors, blueprint entrance rotations,
door/exit/frontage and lot identities. Homes use the existing four house kinds;
farms use the five existing crop-farm blueprints. A complete final-write scan
checks exact door halves or gate ownership and counts later AIR or same-ID
foreign overrides. It retains only candidate columns; a uniquely resolved final
road-kind surface supplies frontage height; road support/fill ops cannot masquerade as a surface. Ambiguous/missing planned height remains
`null`, never a guessed coordinate. No doors or gates are opened.

Input bounds: 4,096 elements, 128 candidates, 512,000 metadata characters,
100,000 declared ops per element, 2,000,000 declared/scanned ops, at most
384 cells per retained column and eight output candidates per page. The scan
yields every 256 op visits; each candidate then reviews at most 382 elevations.
The existing saved rehydration and per-element op-array generation remain inherited
planner work, not a newly proven native CPU-time guarantee. The bounds are preview
refusals, not kingdom population/building limits.

## Validation performed

`node --test dev/staging/civilian-destinations/destinations.test.mjs`:
**33 passed, zero failed/cancelled/skipped**, 2,313 ms. One real small production
planner fixture is generated once; it yields 11 exact home/farm candidates.
Synthetic stream injection is explicitly limited to focused override cases,
leaving the compiler body unchanged. Checks cover checksum/live identity,
duplicate IDs/entrances, work/candidate bounds, blueprint geometry, mutation
during yields, AIR/same-ID overrides, incomplete doors, unresolved frontage,
exclusive job ownership, cancellation, late dimension/checksum changes, async
command success/rejection and unchanged synchronous travel handling.

Strict typecheck passes against a full isolated copy of current production
scripts with the four proposal files overlaid. This is not a central full-suite
pass and has not been deployed or tried in Minecraft.

## First native acceptance after integration

On a backed-up trial copy with a completed saved district and no running job:

```text
/scriptevent civ:people travel destinations district=1 page=1
```

Compare printed building/lot/checksum/door/exit/frontage against the verified saved
plan and native visible entrances. Repeat page2 if present, cancel during source
verification, retry, and repeat after save/rejoin. Native loaded/unloaded clearance
remains **UNVERIFIED** on every row: the preview performs zero native block reads
and does not request chunk holds. Do not interpret a planned door or frontage as a
route or a safe teleport/spawn destination. Verify no actors/blocks/people gate,
plans or queues were changed by the preview itself. Simulation independently
continues its normal authoritative saves.

Next work, after accepting this preview, is bounded native entrance/clearance and
waypoint validation for one existing admitted civilian. Movement, stable household
assignment, routine scheduling, evacuation, hauling and food/work accounting are
separate unfinished features; this preview credits none of them.

## Final staging review

Two concrete regressions were reproduced failing before the review fixes: a
source descriptor changed after the scan but during candidate-review yields, and
a stone support op inside a road element misreported as a frontage surface.
The staged compiler now checks source metadata again before returning and keeps
`op.kind` provenance, requiring `kind=road` for a resolved frontage surface.
Both negative cases and a genuine-road positive control pass. The proposal/hash
manifest has been regenerated; no active source or root test was edited.
