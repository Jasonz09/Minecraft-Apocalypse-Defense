# Physical district prototype - design

Scope: ONE walled district (`district-1`, Hearthgate) built into a NEW test world on explicit command.
No NPCs/entities. Simulation stays authoritative; the physical build mirrors the saved record.

## Pipeline
`blueprints.js` (pure data) -> `planner.js` (pure: expands blueprints + district record into a
deterministic block list, route graph and counts) -> `districtBuilder.js` (Bedrock boundary:
pre-scan, confirmation, budgeted placement via `system.runJob`) -> `district.physical` in saved state.

## Local frame
x east, z south, y up. (0,0,0) = centre of the district at the first air layer above ground
(ground surface at y=-1). Footprint 49x49 (|x|,|z| <= 24).

## Layout
- Curtain wall: ring 3 thick (|c| 22..24), solid y0..6, walkway top y=6 (stand at 7), outer parapet y=7,
  merlons y=8 on alternate cells. PERMANENT: the generator only ever adds wall blocks; nothing demolishes.
- 4 corner towers (7x7, to y=13, roofed) and 4 gate towers flanking each gate.
- 4 gates (N,E,S,W) each a 5-wide, 5-high passage with portcullis (iron bars) + doors, guardhouse room
  above. E gate links `district-2`, W gate links `district-5` (from the district record's gates/neighbors);
  N and S are field gates.
- Roads (3 wide, gravel/path): N-S and E-W arterials meeting at a central plaza with a well, plus a ring
  road 3 blocks inside the wall. Every building door opens onto a road cell (tested by BFS).
- Wall stairs: 4 two-wide staircases from the ring road to the walkway so reserves can reach the wall.
- Buildings (counts from the record, capped by available slots): 6 houses, 1 barracks (beds, chests),
  3 storehouses (barrels/chests), 4 farms (farmland + water + wheat), plaza well.
- Routes (metadata saved in the plan, for future NPC pathing): `evacuation` = house doors -> nearest gate
  along roads; `reinforcement` = barracks door -> wall stairs and -> each gate.

## Safety
- Never run without a player invoker; origin = player's feet block.
- `generate` = dry run: scans footprint, reports conflicts, writes nothing.
- `generate confirm` = places. Refuses if any above-ground cell is not air/replaceable plants, if the
  ground layer is not natural terrain, or if any chunk is unloaded. Terrain surface (y=-1) under roads,
  farms and floors IS modified - that is what confirmation covers. No force/override option.
- Placement is idempotent: cells already holding the target block are accepted, so `resume` can finish
  an interrupted build.
- Budget: <= 400 blocks per job slice; total blocks hard-capped by the plan (asserted in tests).
