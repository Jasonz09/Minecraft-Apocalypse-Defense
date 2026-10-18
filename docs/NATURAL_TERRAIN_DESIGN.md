# Natural-terrain generation - design (NOT implemented yet)

Status: design only. Today's generator (`civ:district_generate`) needs flat natural ground and an empty
49x49x13 footprint; on hills, forests, water or near player builds it **refuses the whole site and
changes nothing**. That safe refusal stays the default. Nothing below is built; it is the agreed approach.

APIs checked in the stable 2.7.0 typings (no @beta): `Dimension.getTopmostBlock`, `getBlocks(volume, filter)`,
`fillBlocks(volume, block, {blockFilter, ignoreChunkBoundErrors})`, `getEntities({location, volume})`,
`isChunkLoaded`, `heightRange`, `Block.hasTag/getComponent`, `world.structureManager`
(`createFromWorld/place/delete`; size cap untested). There is no `Block.isSolid`: solidity comes from id lists/tags.

## Phase 1 - pure logic (offline-testable)
- `terrainPlan(heightmap, baseY, limits)` -> `{cut[], fill[], clear[], foundation[], counts}` for ONE terraced platform at
  `baseY` over the 49x49 footprint (roads, ring road and wall share a level; the route graph assumes coplanar roads).
  Per-building pads rejected. Limits: `maxcut` 4, `maxfill` 4 (hard caps 6), foundation depth <= 8.
  `baseY` = footprint median clamped to [minGround-maxfill, maxGround+maxcut], tie-break lowest cut+fill.
- `looksPlayerMade(id, tags)` deny list (planks, brick, glass, door, chest, barrel, torch, lantern, bed, redstone, rail,
  sign, fence, stairs, slab, wall, furnace, crafting table, ladder, wool, concrete, terracotta, carpet, hopper, ...) plus
  block entities (inventory/sign components) plus entities (item frame, armor stand, painting, villager, minecart, boat,
  named/tagged entities). Reject on doubt and print sample coordinates.
- Natural-tree classifier: flood-fill over log/leaves/vine (cap ~400). Natural only if it has a log, leaves have
  `persistent_bit=false`, no player-made neighbour within 1 block, trunk on natural ground. Leaves overhanging from
  outside are cleared only inside the footprint.
- Auto-clear list: grass, fern, flowers, snow layer, vine, double plants, berry bush, mushrooms, dead bush, sugar cane,
  kelp/seagrass, lily pad; shallow water (<=2 deep) may be filled. Lava anywhere, deep water >10%, hollow fill columns
  (air/lava/water within 3 below), exposed ores, cultivated farmland with crops: refuse.
- `scoreSite`: hard rejects first; soft score `3*cut + 2*fill + 5*steps>1 + 8*water + trees`, small bonus near the player.

## Phase 2 - read-only scout (no writes)
`civ:district_scout [radius] [step]` (runJob, reuses reserveJob/holdChunks): heightmap by `getTopmostBlock` per column
(skip canopy to real ground), score candidate origins, report the best 3 with cut/fill/clear/water/tree counts. A
`civ:district_scout_use` style pick would store a pending site in memory (ids must keep ONE colon).

## Phase 3 - terraced generate
Dry run prints `cut X, fill Y, clear Z, foundation F, water W, baseY`. Plain `confirm` is refused when any terrain change
is non-zero; terrain needs a second explicit phrase naming the counts (fails if the re-scan fingerprint differs).
Every write goes through one `classifyTerrainCell` with: inside-footprint assertion, natural-id check, Y-range check.
Order: clear -> cut -> fill/foundation -> existing structure placement. Strict flat-mode classifier and tests stay.

## Phase 4 - record, resume, undo
`district.physical` gains optional `terrainMode`, `terrain {cut,fill,clear,maxcut,maxfill}`, `terrainHash`, `phase`.
`planHash` stays over structure blocks (old records remain valid). Terrain ops are idempotent (already-flat cells count as
built). Undo: best-effort structure snapshot (`createFromWorld`) if the size cap allows; otherwise refuse terrain mode or
document terrain changes as permanent. Never silently overwrite player edits made after the snapshot.

## Phase 5 - in-game verification
Hills, forest, lake shore, village, cave mouth, desert/snow. Risks: fluid flow after cuts, falling gravel/sand, leaf
decay, biome surfaces (sand/mud), heuristic false positives (dungeons, villages) - mitigated by reject-on-doubt.

## Invariants carried over
Simulation and saved data unchanged; permanent wall rule unchanged (nothing here removes district wall blocks); no
entities spawned; all work time-sliced and capped; no change outside the 49x49 footprint without an explicit opt-in.

## Reviewer caveats (adopted)
- The deny list is heuristic: player-placed dirt, stone or leaves look natural. **Anything ambiguous refuses the whole
  site**; auto-clear applies only to blocks that are unambiguously natural by id and tree-classifier rules.
- `getBlocks` has a third `allowUnloadedChunks` parameter: scans must check `isChunkLoaded` first.
- `createFromWorld` throws when bounds exceed the maximum structure size; a 49x49 footprint may fail, so undo is
  best-effort and the fallback is refusing terrain mode / documenting changes as permanent.
- Structure ids used for snapshots also need exactly one colon (for example `civ:snapshot_district1`).
