# Closed-only D4 fixture coordinate extraction — AUTHORED, UNRUN

Root must confirm Minecraft CLOSED and grant the single reconstruction window before either script runs. No live world path or SST access. No automatic subprocess/launch/UI. No new planner/options/source writes: use production loadSavedRunSteps to rebuild ONLY the actual saved D4 checksum/source/queue, then production buildingInteriorLightRevisionSteps.

Run in order from project root:

1. `python dev/staging/d4-interior-light-coordinate-extraction/extract-closed-input.py`
2. `node dev/staging/d4-interior-light-coordinate-extraction/inspect-saved-fixtures.mjs`

Python pins exact known CLOSED backup against existing15-file receipt+inventory and reuses existing AST-only parser/snapshot definitions. Writes only a saved-source input JSON in dist. Node uses production test harness/stub, fresh all-source raw guards before/after every cooperative yield, no native reads, verifies zero stub property/blockwrites and unchanged property snapshot. Output contains before/after/anchor ops ONLY watchtower3 and warehouse4, source checks/yield counts and pins. Never infer native state/brightness from planned ops. Both scripts currently UNRUN/unvalidated; root review precedes execution.

D5 extension AUTHORING ONLY: sequentially rebuild actual completed D5, enumerate exact all-stage finalops in chapel bbox+2/baseY-2..+32, planned lectern/wood/leaves, contact full history, nearby clear history/column summaries and original saved ground height/kind/tree flags. Output does not identify current native log states/coordinates, original tree topology, or cross-district lastwriters; it grants NO cleanup permission. Current source-valid lamps may coexist with obstructing greenery; do not claim visual acceptance. No v1wall/AIR bypass. Still UNRUN.

## Authorized closed execution results

Original AUTHORING-HASHES.json retained unchanged as lineage. Initial run failed absolute-zero propertywrite assertion after D4 reconstruction (resetWorld itself made2 initialization writes); see initial-counter-assertion.log. Root approved diagnostic-only correction: post-reset counters captured, unchanged counts/props asserted, baseline2 and extraction delta0 reported separately. Second run exit0,9.466435seconds tool walltime (artifact elapsed8977ms), D4checksum35635162 and D5checksum23a6aeca,26901 raw guard checks,0 extraction property/blockwrites. Closed input sequence328024/15verifiedfiles/36savedproperties. No native state/cleanup acceptance. See EXECUTION-HASHES.json and dist/d4-interior-light-saved-coordinates-20261106.json. No further hydration required.
