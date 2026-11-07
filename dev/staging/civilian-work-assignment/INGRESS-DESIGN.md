# Actual-actor ingress and nearby saved-home selection — AUTHORING ONLY

The straight65 `bindWorkAssignment` requirement that the actor already stands at the selected saved home remains unchanged. It is an honest micro-gate, not autonomous life. No ingress source/driver code has been added or executed. Actual-D1 saved-road connectivity and native turn/one-level stepping remain the first gates.

## What streets actually does

- `integration/popSync.js:723 homesFromRecords` prefers civilization centre, then HQ/anchor; that "home" means a population plaza post, not a saved house or person residence.
- `:608 postsFromRecords` adds the centre plus a3×3 lattice at±40X/Z, probing open ground within12 and falling back to a readable topmost column. The loaded/probed post list can change; no record associates it with a house.
- `population/groups.js:118 postOf` selects `index % posts.length`.
- `:133 spotFor` offsets by inset4 plus3-block grid spacing,4 columns; civilians have no soldier-band20 offset.
- `integration/popSync.js:193` observes/probes those planned spots. Final safe spawn settlement and later villager movement mean the ACTUAL admitted actor position, not a reconstructed post, is authoritative.
- `integration/peopleStreets.js:82` owns supplying these native posts to the sole reconciler. Ingress must not replace it or move/respawn an actor to a guessed post.

## Concrete actual D1 gate

Read fresh `civ:people status`/`inspect group=...` and `travel inspect district=1 group=G`; select a currently admitted, unique canonical civilian whose full current aggregate interval is farmer. Capture exact native actor ID/feet/dimension and source/occupation stamp. Historic group0 locations and reconstructed lattice positions are not current evidence.

Compile actual saved home/farm candidates and the owned road graph. Rank at most8 home frontages by a deterministic tuple: bounded proved ingress distance from ACTUAL feet to an owned public road node, graph distance to home frontage, then stable building ID. Use native squared distance only as a candidate-order hint, never as reachability. List IDs/checksum/lot/frontage and why each failed. The user/operator may explicitly choose among eligible saved homes. This is an opt-in visual representative assignment; neither a house occupant nor an individual farmer is inferred from group10, post index, proximity or legacy person slots.

## Minimal bounded ingress primitive

First try a short flat cardinal connector (max8blocks) from current feet to a source-owned safe road node, then follow the SAME verified road graph to the chosen home. If cardinal ingress does not work, a later reviewed local cardinal search may use a small fixed radius/node cap; it must not become unrestricted world navigation.

The start point is the current existing actor, not an arbitrary endpoint; the preferred destination is an exact verified road node. Ordinary nonmutating walking does NOT require block-authoring ownership. Known safe off-road grass/dirt/stone/placed footing may use the SAME existing driver FOOTING predicate plus fresh native full-footprint/two-high swept clearance. Unknown historical ownership of safe grass is not a refusal or a new permission requirement. Metadata remains authoritative for assigning the actual saved home/farm, not for granting permission to stand on every intermediate block.

Collision/footing proof rejects solids/closed doors/gates/crops, hazards, unknown collision IDs and unloaded cells; search must not use an unknown-block fallback. A building's geometry is avoided through actual swept collision, with saved roads preferred for intended routing. Authoring prototype/neighbor-grow margins and historical planned-op vetoes used for destructive leaf replacement are NOT movement restrictions. No clear/placement/door opening is allowed. Existing source/actor/admission/threat/job/stop/dimension/read-budget fences remain; no new approval flow is introduced.

Use one256native-read budget per existing four-tick slice, including footprints, exact floors, headroom, landing and any brake probe. Search-time cells are hints only across yields; source/occupation/player/actor ID and original feet must remain consistent while preparing. If actor moves during asynchronous setup, refuse/restart once with an explicit bounded attempt limit. Before every impulse requery the canonical actor and fresh local segment/landing volume; no cached native proof from an earlier slice grants movement. Stop at turns;±1 transitions share the separately proven physical step/hop microgate. Unknown/far-loaded failure waits without a chunk hold or teleport. Rejoin resumes OFF.

Ingress reaches and records the actual chosen home frontage FIRST. Only then may the existing saved work schedule begin its home→farm→visual-work→home cycle. Keep states explicit: `ingress`, `at assigned home`, `travel to farm`, `at assigned farm (visual only)`, `return home`, `paused`. No food/crop credit, ten-worker allocation, household registration, birth, removal, retagging or second timer.

Required next tests after the first road/step gates: actual native actor near streets post but not at any home; deterministic nearest eligible home selection; no eligible/loaded connector; moving actor during preparation; duplicate/wrong-type/replacement; late source/footing/body changes; inner-turn corner obstacle; per-slice256sharedreads; no offset actor placement; same-ID ingress→home→farm→return; threat/stop/unload/rejoinOFF. A synthetic ingress is insufficient to claim actual D1 daily life.
