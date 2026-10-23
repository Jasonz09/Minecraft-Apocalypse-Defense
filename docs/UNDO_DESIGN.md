# Undo for terrain changes - design and decision

Status: the pure part is implemented and offline-tested (`civ/undo.js`, `dev/test/undo-*.test.mjs`, 29 tests).
It is NOT wired into the district or civilization builders, and nothing here has been checked in Minecraft.
All engine behaviour below is an assumption until the in-game steps in section 9 are run.

Read first: `ENLARGED_HEARTHGATE.md` (Safety model) and `NATURAL_TERRAIN_DESIGN.md` (Phase 4, undo).

## 1. Scope

Undone: the terrain writes of the district and civilization builders, i.e. every cell the builder actually
writes with kind `clear`, `cut`, `fill`, `top`, and the foundation kinds (`retain`, `stair`, `footing`, `wall`,
`deck`, `pillar`, `rail`, `road`) when they are part of terrain preparation. A cell that already holds its target
id ("built") is never written and never journaled, so undo cannot touch what was there before the build.

Not undone: the structure blocks placed in the structure phase (`district_generate` blocks), and anything a
player built. District walls and gates are protected (section 5), so undoing a district is terrain-only: its walls
and gates stay. This is stated, not hidden.

## 2. Journal model

For each written cell: `x, y, z`, `kind`, `prior` (the id read from the live cell immediately before the write)
and `written` (the id written). Rules, enforced by `recordWrite`:

- A no-op write (prior equals written) is refused. A cell with an unknown prior is refused.
- A cell written twice keeps its first `prior` and takes the last `written`. If it returns to its original id, the
  entry is removed.
- Write-ahead: the builder journals a slice's cells BEFORE writing that slice. A journaled cell that was never written
  is harmless, because its live id equals `prior`, so the planner reports it as already restored. A written cell that
  was not journaled would be lost, so the order is fixed.

## 3. Encoding and measured sizes

Text = one-line JSON header + `\n` + body. Header: format, schema, dimension, cell count, bounding box and reference
height, an id dictionary (sorted), and a pair table `[kind, writtenIndex, priorIndex]` (sorted).
Body, column by column in row-major order over the bounding box, only columns that hold cells:
`skip` (empty columns since the previous listed column), `runCount`, then per run `gap` (or zigzag height for the
first run), `length - 1`, `pairIndex`. A run is consecutive cells of one column that share a pair. Numbers use a
64-symbol varint (values 0-31 end a number, 32-63 continue it), so most numbers are one character.
Encoding is canonical: the same cells give the same text whatever the insertion order.

Measured (synthetic 49 x 49 footprint, terrain from the real `planTerrain`, deterministic):

| Case | Cells | Cut/fill/top | Clear | Runs | Chars | Share of 30,000 | Chars per cell |
|---|---|---|---|---|---|---|---|
| Realistic district, hard-cap terrain 6/6 | 6,017 | 5,584 | 433 | 4,422 | 17,793 | 59% | 2.96 |
| Design default terrain 4/4 | 4,213 | 3,874 | 339 | 3,635 | 15,044 | 50% | 3.57 |
| Stress: 6 alternating priors per column | 14,406 | - | - | 14,406 | 48,191 | 161% (2 chunks) | 3.35 |
| Naive JSON of the same realistic journal | 6,017 | | | | 564,658 | | 93.8 |

The realistic district fits ONE dynamic property. The 60,000-byte per-district cap (`UNDO_MAX_BYTES`) holds about
20,000 realistic cells. These numbers come from synthetic terrain; real Minecraft terrain can have more runs.

## 4. Persistence (reuses civ/planstore.js)

`createUndoStore` is a `createChunkedStore` with a per-district prefix (UNDO_PREFIX plus the district id; the code
separates them with a colon, and this document writes that separator as an underscore so the id guard in
`dev/test/commands.test.mjs` can scan it), format
`civ-undo`, and a 60,000-byte cap. The keys are `civ:undo_d1:meta`, `_a_n` and `_b_n`, the same atomic protocol as the
plan: write the inactive family, verify the checksum, flip one meta property, then sweep. A save over the cap returns
`too_large` before any write, so the builder must refuse terrain mode when the journal cannot be saved.
Restart: `loadJournal` verifies the checksum, then `decodeJournal` re-checks every index, count and bound.

Save schedule (proposed): one save before each terrain slice of at most 400 writes. That is about 15 saves per
realistic district, each rewriting about 18 KB. Cost in game: unmeasured.

## 5. Safety predicate

For each journaled cell, with `current` the live id now:

| Order | Condition | Decision |
|---|---|---|
| 1 | `current` unknown (chunk not loaded) | skipped-unloaded (never guess) |
| 2 | `current` equals `prior` | already-restored (no write; this is what makes undo idempotent) |
| 3 | cell is a wall or gate of a district and `prior` is not that plan id (or two plan ids disagree) | skipped-protected |
| 4 | `current` equals `written` | restore to `prior` |
| 5 | anything else (a player placed or removed a block) | skipped-changed (reported, never touched) |

Bounds: an optional box is checked before any read; outside cells are skipped-outside.

Blind spots (accepted, documented):
- Only type ids are compared. A player who replaces our block with the same type id and different states is not seen.
- Air is air: a player who builds on a cut cell and then breaks it again leaves the cell matching `written`, so it is
  restored. Acceptable because the cell is what the builder left.

## 6. Undo planner

`planUndo(journal, read, options)` is a generator. Each yielded slice holds at most 400 ops (`CIV_LIMITS.maxBlocksPerSlice`)
and at most 1,500 reads (`maxReadsPerSlice`); both caps are clamped, so a caller cannot raise them. The generator
returns the summary: counts over the whole journal, which add up to the journal size.

Order: removals of what we placed over air (top-down), then ground restores (bottom-up, so sand and gravel are not
left unsupported), then plants. Cells are disjoint, so the caller may apply each slice before resuming.

Properties tested: undo twice is a no-op (the second run yields read-only slices with zero writes); identical inputs
give identical output; a restart in the middle of an undo, from the stored journal, reaches the same final world as an
uninterrupted undo; slice size changes pacing, never the result.

## 7. Snapshot alternative

Mechanism: `world.structureManager` (`createFromWorld`, `place`, `delete`; size cap unverified; the design note in
`NATURAL_TERRAIN_DESIGN.md` says `createFromWorld` throws above the maximum size). `planSnapshotTiles` tiles a column
region into chunk-aligned tiles of at most 64 chunks (8 x 8 chunks, 128 x 128 blocks). A 49 x 49 footprint is one tile
of 16 chunks.

| Question | Journal (`civ/undo.js`) | Structure snapshot |
|---|---|---|
| What is stored | only the cells we wrote, with their prior ids | whole volumes, including air and player blocks |
| Can it leave player builds alone | yes, per cell (section 5) | no: `place` overwrites every block in bounds; a per-cell diff is needed, which reads the same cells anyway |
| Block states | type id only (gap, section 8) | full states (advantage) |
| Storage | dynamic properties, about 18 KB per district | structure storage, size cap unverified |
| Restart | chunked store with checksum, tested offline | structure ids need exactly one colon; behaviour unverified |
| Failure mode | save refused before any write | a failed snapshot leaves no restore point |

**Recommendation: the journal.** The safety requirement is per cell: no overwriting anything placed or changed since the
build. A snapshot restore cannot meet it without a per-cell diff, and once the diff exists the snapshot adds only block
states. Keep snapshots as a fallback only if the in-game check (section 9) shows that restoring type ids alone is wrong
for trees or double plants.

## 8. Known gaps (not verified in game)

- Block states are not journaled: logs (axis), leaves (distance, persistent), double plants (upper half), snow layers
  (layers) and stairs come back with default states. Proposed policy until verified: do not auto-restore tree parts or
  double plants; report them.
- Restoring leaves may start leaf decay. Restoring a single plant needs ground under it, which the ordering provides.
- Fluids: a cut next to water can start a flow. The planner does not handle fluids.
- Unloaded chunks during the restore: skipped and counted, then retried by running the undo again.
- Property budget: five districts at about 18 KB each plus the plan (40-60 KB) is about 150 KB of dynamic properties.
  The engine's total per-world limit is unverified. The 32-character key limit is assumed (longest key 17 characters).

## 9. Patches needed (not applied: the files are not owned by this task)

1. `integration/districtBuilder.js`, terrain loop in `startBuild`: before each `target.setPermutation`, call
   `recordWrite(journal, { x, y, z, kind: op.kind, prior: target.typeId, written: op.id })`; for `clear` ops the written id
   is `minecraft:air`. Before each slice of writes, call `saveJournal(store, journal)`; if it is not `ok`, stop the terrain
   phase with a message and write nothing else.
2. `integration/civBuilder.js`, the write path that uses `classifyCivOp`: the same recording for the terrain kinds; a `built`,
   `skip`, `tree` or `unloaded` decision is not journaled.
3. A new command (for example `civ:undo_district <id>`), in the commands folder: `loadJournal(createUndoStore(world, { prefix: "civ:undo_" + id }))`;
   `protect = protectedFromPlan(wall and gate cells of that district)`; drive `planUndo` one slice per `system.runJob` step;
   apply each op with `getBlock` (check `isValid`) and `setPermutation(BlockPermutation.resolve(op.id))`; print the counts;
   call `store.clear()` only when every restore op was applied.
4. No change to `config.js`, `main.js`, `kingdom/state.js`, `package.json` or `manifest.json` is needed.

In-game steps, in a NEW normal Creative world, on a small flat test patch first:
1. Build one terrain phase with the recording on; check the save count and the chunk count (a status command must be added for this).
2. Run `civ:undo_district`; compare the counts with the offline expectation (all restored on an unchanged patch).
3. Place a block on a cut cell, break a resurfaced cell, and undo: those two must be reported as changed and left as they are.
4. Undo twice: the second run must write nothing.
5. Reload the world between save and undo: the restart path must restore the same counts.

## 10. Open decisions

- Tree and double-plant policy (section 8).
- Save frequency (section 4): a save must precede the writes it covers. One save per slice of 400 writes is the proposal.
  A coarser schedule is possible only if the priors of the whole batch are read and journaled before its first write.
- Whether district walls and gates should ever be undone by a separate, explicit command. The planner never does so.
