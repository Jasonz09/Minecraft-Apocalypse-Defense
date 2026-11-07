# Saved-source retention profile — offline only

Completed one below-normal-priority Node process (`--expose-gc`, actual priority10) against the pinned five completed saved sources. No active pack, installed pack, core tests or native world was modified. V2 policy staging remains paused.

Evidence: `dist/leaf-source-memory-profile-20261106.json`.
Reproduce: `node --expose-gc dev/staging/leaf-source-memory-profile/profile.mjs`.

| Source | Retain-all post-GC heap MiB | Discard-previous post-GC heap MiB |
|---|---:|---:|
| D1 |26.245|13.404|
| D2 |43.794|32.762|
| D3 |68.989|12.868|
| D4 |85.155|12.971|
| D5 |97.811|12.392|

Retain-all baseline9.158MiB →97.811MiB (+88.653MiB). After clearing the retained array, selected record and latest master references, post-GC heap is12.99MiB. Discard-mode baseline13.043MiB; end12.392MiB, after final references released12.26MiB. Sampled peaks (every100 generator yields plus source completion) are273.483MiB retain-all and252.984MiB discard. These are sampled Node peaks, not native heaps; mode order, warmup, explicit GC and the discard-D2 spike prevent a causal speed or precise reclaim comparison. Both loading modes verify all five exact checksums/complete queues and unchanged fake properties. Mode loading times are11.64s and11.17s; these are not native timings.

## Concrete source retention

- `commands/civ.js` retains `sources` records through all five loads, plus the selected record and latest master.
- `civ/districtplan.js:145,2487,2610`: a WeakMap record→producer map. Each live record makes its mapped regenerate closures reachable; the WeakMap itself does not root dead record keys.
- `:261`: ground snapshot allocates Int16 ground, Uint8 kind/tree and Int16 surface arrays, six bytes/column. The five source ground-column counts are86,020/81,760/74,465/87,756/78,384. These typed arrays alone cannot explain the observed88.65MiB retained delta.
- `:2229`: pad generator directly captures `pad.ops` object arrays plus lane keys; descriptors count44/51/66/42/51. This is proven reachability, not measured per-pad byte attribution.
- `:740,2487`: normalization/priority produces object arrays, typed keys/masks and drop sets. Regenerate closures capture producers/drop sets, and producer closures refer to planner ground/geometry. The profile does not identify each retained object's exact dominator; no claim all transient arrays survive.

## Smallest functional streaming design (not implemented)

For a new batch, load selected district first under the unchanged source/protection guard. Scan all stages for final walls, perform the existing bounded loaded survey, then immediately summarize only the admitted candidates'27-cell cubes from that same source. Release its record/generator after summary. Load each remaining verified source one at a time; collect only bounded source IDs, per-cell historical vetoes and exact final claims for those cubes, then release each record.

At64 targets the wanted coordinate set is at most1,728 cells, with at most five final district claims per cell. Preserve all existing source/master/queue checks, stage order, final-writer logic, source identity sorting, original requested order, full compile work counts, proof checkpoints and receipt digest/plan-ID parity. No writes until all five are verified. On pending recovery, the receipt supplies ORIGINAL candidates: no discovery survey or newly remaining-target admission. The retained summary must have the exact v1 semantic plan bytes; otherwise refuse rather than reinterpret a pending receipt.

This would change source/compiler orchestration and requires measured v1 golden output/receipt parity, late-source/protection and cancellation failure tests before review. It is a design, not a working controller, and cannot yet be claimed to fix the24 old156 or18 new157 native memory warnings. Native1-write held receipt remains pending and independently blocks v2.
