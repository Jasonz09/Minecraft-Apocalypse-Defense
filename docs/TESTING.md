# Testing

**Where we are — step2 of8 is current; the whole roadmap is unfinished.**

**Current lighting checkpoint:** the regular191-file build is installed with all private settings NULL.2,417/2,417 tests, all5gates and52headless stages pass (613,522.031ms,0fail/cancel/skip), with382source/installed hash-and-size checks. Natural-lighting cleanup now validates final fixture states, source authority and fresh support; read-only preview is available. A separately preserved played-city copy is undergoing native review. D1 preview completed with0obsolete/174desired fixtures (151lanterns/23torches), without reported block/journal/hold writes. Preparation is slow and being measured; desired counts are not whole-map coverage. All-five-district day/night aesthetics and cleanup acceptance remain OPEN. Evidence: `dist/lighting-central-installed-verification-20261109.json`, `dist/lighting-central-full-verify-20261109.log`, `dist/lighting-city-copy-created-20261109.json`.

**Native test update — November 8 evening:** the fresh-v3 activation was verified in a closed save, but Minecraft rejected the cavalry mount definition with two schema errors. The subsequent halted save retains people enabled, zero registered issuance, no pending intent and no observed role registration; this does not prove entity absence or native cavalry behavior. Both failed-trial saves remain preserved. A minimal documented push-component replacement is now integrated, with four focused regression checks passing; all2,387 tests, all5gates and52headless stages pass (612,727.1659ms,0fail/cancel/skip). The fixed regular191 build is installed with private settings NULL, verified by382source/installed checks. The subsequent private first-pair birth, seating and full restart slice is accepted below; broader cavalry gameplay remains OPEN. Evidence: `dev/staging/cavalry-v3-native-evidence-20261109/AUDIT.json` and `dist/cavalry-mount-schema-integration-20261109.json`, `dist/cavalry-mount-fixed-installed-verification-20261109.json` and `dist/cavalry-mount-schema-full-verify-20261109.log`.

**Fixed native load gate:** the new disposable b61e trial passed fresh-v3 activation and a complete clean1535-byte loading log, then preserved that state across restart. Independent closed12-file audit: `dev/staging/cavalry-fixed-native-evidence-20261109/AUDIT.json`. The first population pass correctly deferred creation during a simulated attack; a closed10-file audit and actual-state reproduction prove `spawn-in-fight`, with no ownership reset. The same trial is continuing normally. The same normal owner then reserved generation1, created rider `-21474836479` and mount `-21474836478`, and seated that exact pair (two-way YES at16874 and17601). After full save/close/relaunch, tick18757 reports the SAME generation/IDs and two-way YES. Both10-file saves, production-v3 record reads and whole clean logs are independently verified. Scoped first-pair birth/seating/rejoin acceptance: `dev/staging/cavalry-fixed-seated-rejoin-evidence-20261109/COMBINED-ACCEPTANCE.json`. Unload, cleanup, death, combat and ordinary-city selection remain OPEN. These observations do not establish city or release acceptance.

**November 8 verified checkpoint:** the191-file cavalry development build is
installed with all three private settings NULL.2,383/2,383 tests, all5 gates and
52/52 headless stages pass (608,679.8169ms,0fail/cancel/skip). Root verifies382
source/installed SHA+size checks and exact inventories. Versus the startup176
build,169 files remain identical,7 reviewed files changed and15 were added.

The existing population owner now supports the tested cavalry lifecycle and a
private read-only inspector for both riding directions. No extra owner, timer or
listener was added. Real cavalry spawning, seating, rendering, unload/death and
combat acceptance remain OPEN. A separately reviewed genuine-source191 private
trial is prepared; normal settings remain disabled. The first full run's two old
test expectations were corrected without weakening guards; that failed run and
its evidence remain preserved. Evidence:
`dist/cavalry-observed-installed-verification-20261109.json`,
`dist/cavalry-observed-central-full-verify-20261109.log`.

The actual vanilla `CA Never Owner Nov8` fixture was created with no behavior/local
resource packs. Its witnessed unique scoreboard marker and9-file closed backup
were independently audited (exact fake participant ID1/score0); a separate private
configuration/derivative was reviewed and used for the first native attempt.
Activation refused because the clock advanced from exact initial step0 to step1
before confirmation. That failed10-file trial is preserved. A separately reviewed
startup hold and a new pristine-derived trial now pass native fresh activation,
normal scheduled step1 afterward, and save/close/rejoin with fresh history intact.
Both new10-file saves are preserved. The regular NULL176 packs were restored;
the three startup-hold source changes are integrated, fully verified and installed. No evolved-state relaxation/reset, population birth or combat acceptance.
Evidence: `dev/staging/private-hold2-native-evidence/AUDIT.json` verifies all20 saved-file pins and byte-identical activation/header across restart. Both whole closed logs have0warnings/errors/high-memory messages/exceptions; individual publication crash boundaries remain unproven because the engine coalesced the writes. Cavalry remains
staged with native births/seating disabled. Current evidence:
`dist/archer-preview-installed-verification-20261108.json`,
`dist/vanilla-never-owner-backup-20261108.json`.

| Step | Roadmap milestone | Current position / next gate |
|---|---|---|
|1|Save, ownership and recovery foundations|Implemented and tested; final release/long-running recovery checks remain.|
|2|Finish the five-district city|**CURRENT / OPEN.** Five districts built;14 repaired wall cells and3 protected leaf IDs persist. Loaded fresh repeat makes0 changes. Finish remaining lighting/vegetation and actual walking checks.|
|3|Clean playable release/template|Open: verify first join, saved city,400 civilians/150 soldiers and clean release state.|
|4|Ledger and multiplayer usability|Partial: finish normal player controls, permissions and multi-player acceptance.|
|5|One living district|Early trials: real civilian work/travel, military classes, integrated siege and casualty authority remain open.|
|6|All five districts living together|Open: extend proven behavior across districts and multiplayer within population/performance limits.|
|7|Recurring war and physical expansion|Open: connect simulated war/reinforcement/expansion to accepted physical gameplay.|
|8|Other civilizations and diplomacy|Partial: scouting/reports/envoys/alliances installed for native testing; physical settlements, allied support and conflict remain open.|

**Latest result:**191-file development build installed;2,383tests/all5gates/52headless
stages pass. Full computer control is authorized; native cavalry acceptance remains open.

**Historical combat checkpoint:** the pillager trial was saved without engagement.
The same original guard is full-health30 and unique1/1/1, but the owner refused all
observed groups because two separate civilians shared `district-1:civ:10`.
Actual native cause remains under investigation. Three offline checks reproduce
the unchanged owner creating a replacement for an unloaded living civilian, then
refusing both when the old area reloads; this is a code vulnerability, not proof
of that exact save's origin. See `dev/staging/population-unloaded-duplicate/repro-evidence.json`. Equipment readings remain UNKNOWN and the visual
was incomplete, so no proactive-filter, combat-balance or real-siege acceptance
is claimed. The13-file backup and whole473,940-byte closed log are verified;
zero warnings/errors/high-memory messages/exceptions. See
`dist/native-pillager-filter-preparation-20261106.json`.

Room-census progress visibility has now been integrated in source: bounded messages
show saved-source checks and native cell counts while preserving the existing
read-only checks. Central focused44/44 and strict typecheck pass. The first combined
run exposed a test-harness dependency omission, corrected by injecting the real
progress helper and clock into the existing extracted-command test; no acceptance
assertion was weakened. Full verification and closed deployment now pass as
recorded below; native progress-message checks now pass as scoped below. Evidence:
`dist/room-progress-integration-20261106.json`,
`dist/room-progress-integrated-focused-20261106.log`.

**Native162 visibility accepted:** all8 bounded saved-source messages,1 planned-cell
message and2 native-cell messages were observed; the page2 census completed with
475/475loaded cells,0unloaded/unreadable and39discrepancies. It supplied the7remaining
oak-leaf descriptions. The22logs+17leaves are descriptions across two separate
censuses, not one atomic snapshot or cleanup capability. Closed15-file backup,
whole2,781-byte zero-warning/error/high-memory/exception log andCRC385924 preserve
the same35source/job raw values and original complete14wall receipt. See
`dist/native-room-progress-162-20261106.json` and
`dist/native162-room-progress-source-audit-20261106.json`,
`dist/native162-room-progress-independent-proof-20261106.json`.

Offline all5-source provenance at the prior closedCRC383540 checks435,683operations:
none of the39observed IDs matches a planned placement at that coordinate; none
of239queried neighborhood cells has a historical planned tree/log/leaf claim or
other-district/prototype protection. D5 has14savedAIR targets and25no-op targets.
This rules out planned placement at these cells, not player/natural origin, present
state or permission to clear them. No log or leaf was removed. Evidence:
`dev/staging/chapel-source-provenance/provenance.json`.

The next velocity-trace candidate is integrated in source, with76focused checks
and strict main typecheck passing. It records finite horizontal velocity from the
existing native read, preserves helper coercion/getter order and all steering
barriers, and adds no physics/AI control. Full verification and closed deployment
now pass as recorded below. The previous progress-visibility162/1984 remains
retained. No walking fix or native velocity acceptance is claimed.

**Historical installed165 development build:**165 files/schema3,2,092/2,092 tests,
all5 verification gates and52/52headless stages pass. Installed changes include
confirmed Ledger scouting/envoy/alliance missions, exact short-grass body clearance,
command-local immutable room decoding and bounded streamed readonly tree inspection.
No plant removal, extra lamp grid, new population owner or AI/physics control was added.
Native migration, missions, movement and memory improvement remain unverified.

The first164 combined run exposed4 regressions; the first165 run exposed3
diagnostic contracts. Original failures, before-fix bytes and tests are retained;
the final full run passes with all old preservation assertions intact. Evidence:
`dist/roadmap-grass-cache-corrections-20261106.json`,
`dist/tree-streaming-diagnostic-corrections-20261106.json`,
`dist/tree-streaming-central-verify-corrected-20261106.log`.

**Separate staged roadmap work:** durable population activation/composition has90
focused/predecessor checks and strictTSC passing, independent restart/streets review,
and literalNULL compiled trust. Genuine vanilla-world provenance and native gates
still prevent promotion. Archer has54focused checks plus independent review;
rendering, projectile safety and native combat remain open. Cavalry compound metadata
has16unique tests plus2independent repeats passing after two reviewed fixes; it is
fresh-only, not a v2 migration, unified owner, two-actor budget or mounted-gameplay
implementation. These stages are not installed. The next live gates are recorded
in `dist/source165-next-native-gates-20261106.json`.

**Latest native2004 session:** the existing readonly tree tool verifies all five
sources, then refuses the627-cell component (120logs/315leaves) because the lowest
trunk stands onAIR at(-214,68,-539). It reports no block/queue changes and releases
its temporary holds. The whole closed16,072-byte log has28high-memory warnings,
0errors/exceptions; this is not an isolated causal/performance measurement. The
old tool retains allneighbor records; a streamed readonly replacement is staged
separately. Do not rerun the heavy path for pruning or infer original tree origin.
D5civ13 separately has2loaded canonical actors; neither was moved/removed.
D5civ1 is unique/HP20, but a1-block setup refuses short_grass bodyclearance at
(-194,63,-465). No successful setup/impulse/velocity sample occurred. Closed16-file
backup andCRC389880 preserve35raw source/job values and the same complete14receipt.
Evidence: `dist/native-tree-inspection-2004-20261106.json`,
`dist/native-velocity-setup-refusals-2004-20261106.json`,
`dist/native2004-tree-setup-independent-proof-20261106.json`.

**Release gate refreshed:** the historical17,345,764-byte starter archive still
refuses release:99pack mismatches, including missing RP content/binding. This is a
separate gate from the five development checks and cannot be treated as a finished
release. Evidence: `dist/source165-release-readiness-20261106.log`.

**Build now:** installed **176 files / 2,240 passing tests**, all5gates/52headless
stages pass. Closed deployment2026-11-08T23:49:10.671UTC (18:49local), nonce86e5c68c.
Root352checks and exact165BP+11RP inventories pass; prior165pair retained outside
scanned pack parents. Active trustNULL. Native activation/archer appearance,
projectiles, combat and lifecycle acceptance remain unverified. The developer
preview is validated at `dist/developer-previews/integrated176-nov8`; no world,
clean-starter or release approval is included.

**Historical installed165 checkpoint:** installed **165 files / 2,092 passing tests**, all **five gates green**
and **52/52 headless stages passing**. Full session14580 exits0 with no failures,
cancellations or skips in519,057.5998ms. Closed deployment was **November7,
03:09:31.261UTC** (**November6,22:09local**), nonce406611fb. The previous162-file
pair is retained outside scanned pack parents. Root verifies330 source/installed
SHA checks and exact inventories; RP/server dependencies and external27-file v004
fixture remain unchanged. Independent installed verification also passes330checks,
exact inventories, prior162pair preservation and the externalfixture. See
`dist/tree-streaming-independent-installed-verification-20261106.json`.
The closed pre-schema3 city source+backup remain byte-exact (32checks/16files each).
Rollback after schema3 play requires the pre-upgrade world backup and older pack.
Evidence: `dist/tree-streaming-installed-verification-20261106.json`,
`dist/tree-streaming-preupgrade-backup-recheck-20261106.json`.
No native movement/mission/memory acceptance or finished release is claimed.

**Historical installed162/velocity checkpoint:** installed **162 files / 2,004 passing tests**, all **five gates green**
and **52/52 headless stages passing**. Full session4511 exits0 with no failures,
cancellations or skips in542,270.25ms. Closed deployment was **November7,
01:50:23.054UTC** (**November6,20:50local**), noncec5578b28; the previous
progress-visibility162 pair is retained. Root verifies324 source/installedSHA checks
and exact inventories. Only the driver changed in the production pack: it now logs
finite pre-impulse horizontal velocity from the existing read, preserving native
getter/coercion order, steering and safety checks. Native velocity proof is pending;
no movement fix or AI cause is claimed. Evidence:
`dist/velocity-trace-central-verify-20261106.log`,
`dist/velocity-trace-installed-verification-20261106.json`,
`dist/velocity-trace-independent-integration-review-20261106.json`,
`dist/velocity-trace-independent-installed-verification-20261106.json`.

**Historical installed162/progress checkpoint:** installed **162 files / 1,984 passing tests**, all **five gates green** and
**52/52 headless stages passing**. Full session47547 exits0 with no failures,
cancellations or skips in546,438.3573ms. Closed deployment was **November7,
01:26:27.842UTC** (**November6,20:26local**), nonce98c28527; the prior161pair is
retained outside scanned pack directories. Root verifies all324 source/installed
SHA checks and exact inventories against the162-file freeze. Independent review
also confirms the RP dependency and unchanged external27-file fixture. Evidence:
`dist/room-progress-central-verify-20261106.log`,
`dist/room-progress-installed-verification-20261106.json`,
`dist/room-progress-independent-installed-verification-20261106.json`.
Native progress-message visibility now passes on the scoped session above; this improves visibility,
not census speed, walking, vegetation cleanup or population identity.

**Historical installed161 checkpoint:** installed **161 files / 1,974 passing tests**, all **five gates green** and
**52/52 headless checks passing**. Full session 81342 finishes with no failures, cancellations or
skips in 521,443.6604 ms (exit 0). Closed deployment was at **November 7, 00:03:29.653 UTC**
(**November 6, 19:03 local**); the previous 1,917-test pair is retained (nonce `e9b1973c`).
Independent checks confirm all 322 source/installed hashes, exact inventories and the resource-pack
dependency. The separate 27-file v004 filter fixture is unchanged. Evidence:
`dist/cadence-room-preview-independent-installed-verification-20261106.json`.

The opt-in one-tick civilian correction and read-only chapel room census are installed.
**The loaded chapel census now completes; one-tick HOME holding failed and WORK movement remains untested.**
Earlier WORK overshoot, route negatives
and lighting observations remain evidence from the 1,917-test or earlier revisions, not acceptance
of this revision. The roadmap remains at step 2 of 8.

**Separate one-tick HOME trial on 161:** the same civ19 actor failed sustained corridor
holding; the final sampled frame safely refused steering outside the corridor, then explicit
stop was observed OFF. DesiredZ is positive: the middle dash in `x,-,z` is unavailableY,
not a direction error. Only the last6 of a rolling16-frame trace were transcribed; no AI
cause, WORK or return acceptance follows. Evidence:
`dist/native-civilian-cadence1-HOME-20261106.json`.

**Separate daytime setup attempts on 161:** no new movement trial started. Civ19 had no
unique admitted representative (fresh loaded counts 0/0/0; this is not death proof).
Civ13 and22 refused oak-fence body clearance; civ24 refused AIR footing. No successful
setup, trial impulses, new actor, NPC teleport or terrain changes occurred. The previous
HOME trace remains because failed setups do not reset it; it is not a new daytime trace.
**WORK movement remains untested.** The final refusal may straddle day hour16/17.
Closed session proof is now verified: exact15-file backup hashes/inventory and the whole
29,748-byte session log (zero warnings, errors, high-memory warnings or script exceptions).
CRC383540 preserves the original complete14 wall receipt and35 plan/job raw values; it
adds no actor, death, WORK, cleanup or causal performance proof. Evidence:
`dist/native-civilian-DAYTIME-setup-refusals-20261106.json`,
`dist/native161-city-census-cadence1-source-audit-20261106.json`.

**Current native rejoin checks on 161:** six read-only compound checks pass: all 14 repaired
wall cells retain their exact masonry IDs; the 3 protected cells retain jungle-leaf IDs; the D4
watchtower lantern remains standing on spruce support; both warehouse lanterns remain standing on
barrel/hay supports. Both D5 chapel lanterns, their birch supports and the adjacent oak-leaf ID
also pass a fresh compound check. These are sampled persistence checks, with no writes or protected-leaf
state proof. The D5 room census, started at hour 1068 and observed complete after hour 1074,
reads **475/475 loaded cells**, with zero unloaded/unreadable and **39 source discrepancies**.
Page 1 of 3 shows 32 rows: **22 logs and 10 oak-leaf cells**, with full primitive states captured.
The logs include a jungle 2×2 column cluster and oak branches; their origin is unknown. The leaf
rows are nonpersistent, but that alone grants no cleanup authority. This accepts the read-only
loaded census, not vegetation cleanup, atomic room state or performance. Other pages rerun a new
census. One-tick HOME movement failed as recorded above; this session's closed backup/log checks are verified.
Evidence: `dist/native-room-census-161-20261106.json` and
`dist/native161-city-rejoin-checks-20261106.json`.

**Earlier native D1 result — the 1,864-test installed revision:** saved destinations now **PASS9 candidates/0 refused**,
checksum`07515fcb`,84,852 operation visits, **0 native block reads/writes/entity changes**. From the
D4 observer position, the home check correctly reports **UNLOADED after1/3 reads**. After moving
only the observer to **(-117.5,100,-617.5)**, `building-d1-house_s-4` frontage **(-60,67,-631)**
verifies the exact floor plus2AIR cells in **3/3 reads**,0writes/entity changes. The farm frontage
**(-176,76,-605)** also **VERIFIES3/3** exact floor+2AIR,0writes. Both sampled frontage points are
accepted; doorway access/walking/work are not proved. The read-only route safely returns
**PARTIAL_NO_PATH** (observed16:24:19UTC, simulation hour643): **2,195 reads**, maximum
**171/256 per slice**,409visited,141unloaded and0path edges. The observer remains fixed at the
midpoint. This is not a world-wide impossibility claim or walking/work acceptance; loading and
body-obstruction causes still need bounded diagnostic output. The closed-session log has **0 warnings,
errors, high-memory warnings or exceptions** (27,434 bytes; whole-session scope, not isolated timing).
Closed CRC sequence319677 retains the identical complete14 receipt and all35 plan/job raw values
from sequence306235. Evidence: `dist/native-d1-route-closed-log-audit-20261106.json` and
`dist/native-d1-route-source-receipt-audit-20261106.json`.

**New native diagnostics on the 1,906-test revision:** the fixed observer at
(-117.5, 100, -617.5) again gets `PARTIAL_NO_PATH`: 2,195 reads, maximum 171 per slice,
409 visited and 141 unloaded, matching the earlier counts. The new bounded diagnostics report
939 footing, 610 body and 1 headroom rejection (overlapping categories), with seven samples.
Unloaded examples are (-62, 65, -641) and (-62, 66, -641); stairs/path at alternate heights and
a wall are also reported. These samples establish neither a flora cause nor a world-wide lack of
a route. Lowering only observer height to 80 produces the same result and samples. At that
midpoint, testing (-62, 65, -641) reports outside-world; after moving only the observer 16 blocks
north to (-117.5, 80, -633.5), the identical test reports Dirt Path instead of the requested AIR.
This proves observer-position-dependent readability for that cell, not a complete route or a
loading-only cause. The northern route comparison also returns **PARTIAL_NO_PATH**:
2,836 reads, maximum 171 per slice, 538 visited and 132 unloaded, with overlapping rejection
counts of 1,146 footing, 874 body and 1 headroom. New unreadable samples are (-50, 62, -608)
and (-50, 63, -608). More search positions were observed, but no path was found. The previews
moved no civilian. Evidence: `dist/native-d1-route-diagnostics-repeat-20261106.json`.

**Pinned civilian trial — limited HOME-phase observation:** existing group `district-1:civ:19`,
actor `-103079215055`, passes a one-block setup at simulation hour 689 (day hour 17, HOME), using
12 of the shared 256 reads. At simulation hour 693 (day hour 21, also HOME), the same actor is
outside the flat corridor; the driver pauses after 3 impulses and 0 arrivals. Stop at hour 694
returns off. Identity, pause and stop were observed; continuous controlled walking was not
accepted. That HOME-only trial did not test farmward WORK movement; the later WORK trace below
provides separate evidence. Native AI interaction is a hypothesis. No NPC was teleported and no second owner
was introduced. Evidence: `dist/native-civilian-pinned-trial-20261106.json`.

**A5 swordsman persistence — scoped pass:** rejoining the historical A5 trial finds the same
original actor `-34359738142` at 3 health, with canonical/type/tag counts of 1/1/1. No new fight,
heal, spawn or actor teleport was used. This accepts loaded same-actor/health persistence only;
managed-illager combat and casualty accounting remain open. Independently checked: all 14 closed
backup files match their receipt, and the 102,810-byte closed log matches its hash with zero
warnings, errors, high-memory warnings or script exceptions. Evidence:
`dist/native-swordsman-A5-rejoin-20261106.json` and its linked backup/log receipts.

**B5 owner rejoin — reproduction not observed:** two normal owner updates report zero errors and
no duplicate conflict. The loaded selected-soldier census is empty, consistent with the historical
original guard death; this says nothing about unloaded actors. The original conflict cause remains
unresolved, and no repair or combat success is claimed. All 13 closed backup files and the
9,538-byte zero-warning/error log independently match their receipts. Evidence:
`dist/native-swordsman-B5-owner-rejoin-20261106.json`.

**Native WORK trace — partial progress, not sustained walking:** on installed 1,917, the same
rejoined actor `-103079215055` runs the one-block trial during WORK hours 9–10. Four frames show
travel toward the farm, one **at-farm** sample, continued drift despite returned negative-X
corrections, then **paused outside the flat corridor**. The first exit is retained; explicit stop
returns off, and the stop frame preserves the original four observations. This proves neither
sustained arrival/return nor an AI cause. No replacement actor or teleport was used.
Evidence: `dist/native-civilian-WORK-trace-20261106.json`.

**Current revision verification:** 165 central runtime/movement/room checks pass in
530.9651 ms with strict whole-production typechecking, followed by the full 1,974-test run above.
All nine integrated paths match their reviewed stage or exact runtime-test correction; the complete
source and installed pair match `dist/cadence-room-preview-pack-hashes-20261106.json`.

The cadence option preserves the four-tick default and braking horizon, speed, impulse, geometry,
identity guards and 256-read cap. The room census reads 475 cells, at most one per cooperative
slice, and grants no cleanup permission. Native census operation is now observed; cleanup and one-tick walking remain pending. The isolated v004
fixture and two fresh disposable worlds are prepared for controlled filter checks, separately from
real siege ownership and casualties.

**Retained failure history:** the earlier cadence-only full run passed 1,937 of 1,940 tests;
three old timer-four assumptions failed. Four scoped test lines now check the single timer-one
registration, idempotence and every-tick idle world-access traps. That correction passed 131
focused checks, then the combined 165 focused checks and the successful full run above. The
failed log and correction receipt remain recorded; they are not the current build result.

**Targeted city lighting — vegetation acceptance remains open:** read-only previews preserve the
D4 watchtower contact identified as Vines and the warehouse contact identified as Copper Ore.
Both D5 chapel lanterns repeatedly pass standing-state and birch-support checks; the adjacent
nonpersistent oak-leaf cluster still crowds the lectern in the camera view. Stable lamps do not
resolve that interior obstruction. All inspections make no changes; the camera was cleared before
save/close. The latest closed backup independently matches all 15 files. Its 136,637-byte log
matches its hash and has zero warnings, errors, high-memory warnings or script exceptions across
the entire extended session, not an isolated performance trial. Closed CRC sequence 374118 versus
328024 preserves the exact completed 14-cell receipt and all 35 plan/job raw values, with the same
single leaf-receipt key. No new physical rejoin acceptance follows from this file audit.
Evidence: `dist/native-city-targeted-lights-20261106.json` and
`dist/native-WORK-trace-city-lights-source-audit-20261106.json`.

**Passive trace — installed and observed:** the three-file driver/test/fixture integration passes
central typecheck, 50 focused checks and the full 1,917-test run. The native WORK observation above
confirms bounded first-exit and stop reporting, not successful locomotion. Full log:
`dist/civilian-travel-trace-verify-20261106.log`. Freeze:
`dist/civilian-travel-trace-pack-hashes-20261106.json`.

**Previous identity/diagnostic revision safety checks:** those changes pass 167 central focused
checks and strict typechecking, followed by the historical full 1,906-test run. Every raw source audit still runs
before and after native reads. A tiny simulated case retains 186 full audits while reducing
validated kingdom loads from 557 to 187; this proves call counts, not native speed or memory.
The actor pin refuses replacement identity and repeats the final setup checks before motion.
Historical freeze: `dist/route-diagnostics-identity-pack-hashes-20261106.json`.

**Next:** repeat the read-only D1 route preview and inspect its bounded loading/body samples.
Test the managed-illager guard filter on a separate controlled copy. Then prove one existing civilian's short walk/turn/step and return through the same driver.
A path preview is not walking, farming or food production. The original source-road path failure
remains preserved; no actor assignment or new timer is included in the160-file route slice.

The installed158 fresh completed-city repeat has **0 write attempts/0 changes**, all14 original
masonry and3 protected leaf IDs pass, and the original completed receipt/35 plan-job raw values
remain unchanged. Its closed log and the separate safely-held pending-copy log each have
**0 warnings/errors/Molang/script exceptions**, scoped to those sessions. This is neither whole-wall
coverage (29,153 targets unreadable) nor a global memory/stability or AIR-decay cause claim.

**Evidence checkpoints and retained history follow.**

**Source160 integration note — Nov6:** all160 source hashes match the current freeze. Across the
6 route production files and3 tests/helper, **8 are byte-exact** to reviewed staging;
`civilianTravel.js` differs only in CRLF→LF, and the controller's reviewed dependency cleanup
removes only the static `runtimeWorld` import and its two fallbacks. This exactly accounts for the
promoted differences; no command/movement policy changes. Full verification and closed160deployment now pass; native acceptance is pending. Earlier
installed158/1,828 evidence remains historical and scoped to its native sessions.


**Historical installed158 checkpoint — Nov6:** streaming build **158 files /1,828 passing tests**,
frozen in `dist/leaf-source-streaming-pack-hashes-20261106.json`. Closed deployment succeeds
(`dist/leaf-source-streaming-deploy-20261106.log`); verification records **316 source/installed
SHA checks and exact inventories** (`dist/leaf-source-streaming-installed-verification-20261106.json`).
Root-reviewed streaming changes comprise5 production files,4 central tests and2 fixtures.
Production strict typechecking passes. Central focused session53238 **PASSES82/82**,
**0 failed/cancelled/skipped**, **68,461.9983ms** (`dist/leaf-source-streaming-focused-20261106.log`).
Fresh full session95969 **PASSES1,828/1,828** (actual count;1,827 was the estimate),
**0 failed/cancelled/skipped**, **535,939.5456ms**, all **five gates green and52/52 headless**,
exit0 (`dist/leaf-source-streaming-verify-20261106.log`). Native streaming now has a scoped
**zero-warning/error closed session**, with a safe partial repair held below; overall native
memory/performance acceptance remains incomplete. Prior17/18/24-warning logs remain historical;
no global heap or causal reduction claim follows. Prior staging evidence passes:
52 focused checks/strict typechecking, real pending-receipt parity1/1, fresh deep-frozen real parity1/1
and converted central fresh-source check1/1. Their offline survey is **34,673/1,238 unreadable**,
not the native **6,758/29,153**; those scopes must not be combined.

**Latest native streaming pending-copy result — Nov6 (installed158):** the preserved
`CA Stream Resume Nov6` copy reports **9 new verified replacements /9 write attempts**, then
**HELD** (simulation hour583). A later native `/testforblock` confirms **AIR at(-322,55,-455)**;
the cause and exact change time are unknown. The protected-three jungle marker
`CA_STREAM_PROTECTED_OK` **PASSES**. Do not relax the AIR policy or overwrite the fault copy.
Closed15-file source/backup inventories and all hashes match
(`dist/native-streaming-held10-independent-hash-check-20261106.json`). Root's closed CRC audit
sequence296845 confirms the same schema2/v1 `c835b06e` receipt: **10done/4pending**, unchanged
immutable identity/before states, the same single leaf key and **35 unchanged source/job raw values**;
the actual production parser passes (`dist/native-streaming-held10-receipt-audit-20261106.json`).
The closed25,120-byte log has **0 warnings,0 errors,0 high-memory warnings,0 Molang and0 script
exceptions** (`dist/native-streaming-pending-closed-log-audit-20261106.json`, SHA
`B3BB8188C61DB45E3ABB294219E7E18FC33293BB045097C4B69E2412CC2F6130`). This is a scoped
warning-free run, not global memory/stability or causal improvement proof. The preceding
WAIT157 world's **all14 masonry +3 protected rejoin proof remains valid**, separate from this held copy.

**Latest native streaming FRESH repeat — installed158:** the original completed city reports
**0 write attempts /0 verified changes**, **6,758/35,911 surveyed**, **29,153 unreadable** and
**3 refused**. Independent native markers confirm **all14 exact masonry cells +3 protected leaves
PASS** (`dist/native-streaming-fresh-repeat-20261106.json`). The closed23,073-byte session log has
**0 warnings/errors/high-memory/Molang/script exceptions**, SHA
`0B57CFFE0FC93B332DC2B5C7A1934E9CB44AB4A0A7FFDD443475A4764E9A2B28`
(`dist/native-streaming-fresh-closed-log-audit-20261106.json`). Closed CRC sequence306235 versus
298898 confirms the original schema2 `c835b06e` **complete14 receipt raw text unchanged**, the same
**35 source/job raw values**, no extra leaf key and production-parser PASS
(`dist/native-streaming-fresh-zero14-receipt-audit-20261106.json`). Independent source15/backup15
SHA/size/inventory checks pass (`dist/native-streaming-fresh-independent-hash-check-20261106.json`).
This accepts the bounded fresh zero-write flow and physical preservation; unreadable areas and
global memory/heap stability remain outside that proof. The separate pending-copy AIR hold remains
preserved; no AIR bypass or natural-decay cause is inferred.

Independent civilian-assignment staging passes **65 focused checks +strict typechecking**, but
actual pinned D1 has **no supported home/farm pair** for its flatstraight1–24primitive. That
checkpoint is frozen separately. Revised selected-source road staging now has **86/87 focused checks passing and strict typechecking**;
its required actual-D1 path gate **FAILS** (both endpoints exist, but start road component has10nodes).
This negative gate is retained: no native walkability/cause inference, route promotion or daily-work
acceptance. A bounded loaded safe-footing detour may be needed through the existing driver.

**Latest native WAIT result — Nov6 (tested on preceding WAIT157/1,808 build):** recovery completes
**13 new verified replacements /13 write attempts**, adding to the prior1 for **all14 original
batch targets**, same `c835b06e` identity. Completion reports at simulation hour576 and is observed
at **13:29:24 UTC** (`dist/native-wall-leaf-wait-resume-20261106.json`). All six independent native
markers **A/B/C/D/E/protected PASS**, proving **14 exact masonry block IDs and3 protected jungle
leaf IDs** (`dist/native-leaf-wait-postrepair-checks-20261106.json`). Protected leaf state values
were not checked. Source city completion and queues are **reported unchanged**.

The saved/closed copy has a **16-file backup**, independently verified across **32 source/copy SHA
checks**,0 mismatches and exact inventories: `dist/backups/leaf-repair-complete14-20261106`,
receipt `dist/native-wall-leaf-complete14-backup-hashes-20261106.json`; level SHA256
`8FF02AEF033366270CD281EB6ACB545C13CE871D9E19AA5C02A9828E7C6954B8`.
**Rejoin ID checks PASS** at13:49:21UTC: native markers **AB/CD/EP** recheck all14 masonry IDs
and3 protected jungle IDs without a repair-command rerun. These establish scoped persistence,
not protected leaf-state equality or repeat-command idempotence. Latest saved/closed backup:
`dist/backups/leaf-repair-rejoin14-20261106`, **15 SHA-matching files**, receipt
`dist/native-wall-leaf-rejoin14-backup-hashes-20261106.json`; level SHA256
`52868D7589DA5CBBD2718A2C6AAB88EFA01A05E3FB064E3088A521009D2DD3F6`.
The closed CRC-verified receipt audit at sequence**296522** is production-parser accepted:
**schema2 `c835b06e`,14done/0pending**, original immutable identity/before-states unchanged and
**35 plan/jobs raw properties unchanged** (`dist/native-leaf-complete14-receipt-audit-20261106.json`).
The unfinished-v1 veto is therefore cleared; **v2 remains PAUSED and unvalidated**, not promoted.
The completed WAIT session's closed log has
**17 high-memory warnings**,08:18:56–08:19:12, with **0 errors,0 Molang errors and0 script exceptions**:
`dist/native-leaf-wait-closed-log-audit-20261106.json` (23,034 bytes; SHA256
`A3D58B1C2105754857310FF1EF69232E25D30838A3F2E002C868462292352150`). Earlier18/24-warning logs
remain separate evidence; warning counts do not establish a memory fix. The original hold-time
mismatch cause is **UNKNOWN**: success proves neither an `update_bit` cause nor that a particular
wait was necessary. The closed14done receipt clears its unfinished-v1 veto, but v2 stays **PAUSED**;
no broader wall/release or performance/stability acceptance follows. City acceptance is **step2/8,
OPEN**.

**Earlier held1/recovery-build checkpoint — Nov6:** installed157 is now the exact-state WAIT build,
**1,808/1,808 passing tests**, all five gates green and52/52 headless stages.
The preceding157 build’s native CONFIRM on **CA Leaf Repair Nov6** restores **1/14** targets, then safely
**HOLDS**: `admitted leaf identity/states changed; preserve target and receipt`. The original
schema2 v1 receipt **`c835b06e`** is preserved with **1 done /13 pending**, `complete=false`;
this is not completed repair acceptance. Receipt audit:
`dist/native-leaf-held1-receipt-audit-20261106.json` (closed WAL sequence289905, CRC-verified).
The closed backup `dist/backups/leaf-repair-held1-20261106` independently matches **15/15 SHA hashes**,
with0 mismatches (`dist/native-wall-leaf-held1-backup-hashes-20261106.json`); level SHA256
`2AC125056CA0689B8C71E14CE67508F53BFB8712A14D724EDE87C7C162D91E46`.

The **closed157 confirmation log has18 high-memory warnings**,07:18:33–07:18:50, with
**0 errors, 0 Molang errors and0 script exceptions**
(`dist/native-leaf-confirm-157-closed-log-audit-20261106.json`,26,131 bytes). The earlier live0
reading was buffered, not stability proof. The prior156 preview's24 warnings remain separate
historical evidence; no causal memory-fix or recovered-heap claim follows from the counts.
The `update_bit` explanation for the hold is **unconfirmed**: later native false/false checks
succeeded, so they do not establish the exact state difference at the hold.

The **exact-state WAIT recovery build** changes only `civ/wallLeafTrim.js`,
`civ/wallLeafRepair.js` and `commands/civ.js` versus the preceding installed157. It waits rather
than accepting altered receipt identity; original receipts and exact state equality remain
authoritative. **56/56 focused checks** (including14 new checks) and strict typechecking pass.
Full session55899 **PASSES1,808/1,808**, **0 failed/cancelled/skipped**, **516,989.7239ms**, exit0,
all five gates and52/52 headless stages (`dist/leaf-exact-state-wait-verify-20261106.log`).

Minecraft is fully closed for deployment at **13:11:13.556 UTC**, previous pair retained with
nonce`c9257b64` (`dist/leaf-exact-state-wait-deploy-20261106.log`). Independent read-only verification
at13:12:22UTC matches **314 source/installed SHA checks**, exact **151 BP +6 RP inventories**,
**0 mismatches/extra/missing files**, script entry, RP UUID/version dependency and installed local
API declarations **server2.7.0/server-ui2.1.0**. Frozen manifest:
`dist/leaf-exact-state-wait-pack-hashes-20261106.json`; deployment verification:
`dist/leaf-exact-state-wait-installed-verification-20261106.json`.
At that deployment checkpoint native recovery was pending with1done/13pending. The subsequent
native completion, rejoin ID checks and the verified14done receipt are recorded above.
Margin-v2 stays **PAUSED/unvalidated** despite its unfinished-v1 veto now clearing. City acceptance is
**step2/8, OPEN**.

**Historical installed157 checkpoint — Nov6 (before WAIT deployment):** **157 files /1,794 passing tests**, all five gates green
and **52/52 headless stages**, exit0. Full session52247 has **0 failed/cancelled/skipped**, in
**541,082.5059ms** (`dist/native-fixes-frontage-guard-verify-rerun-20261106.log`). Deployment occurs
with Minecraft fully closed/process absent at **12:09:09.062 UTC**; the previous156 pair is retained
outside scanned pack directories (nonce `13ecec75`). Deploy log:
`dist/native-fixes-frontage-guard-deploy-20261106.log`. All **314 source/installed SHA checks** and
both157-file inventories match the final freeze, with **0 mismatches**; receipt:
`dist/native-fixes-frontage-guard-installed-verification-20261106.json`.

The prior installed156 native D1 destination preview **REFUSED** with
`invalid or duplicate saved destination lot metadata`: it mistook a saved farm foundation pad for
a building entrance. The exact refusal is reproduced from pinned saved D1 source. Its compiler fix,
frontage inspection and owner diagnostics are now installed, with **new native acceptance pending**.
The subsequent CONFIRM is now **held after1 verified replacement**, with the original13 pending
receipt entries preserved; the latest recovery-candidate status above takes precedence.

**Working source is 157 files**, with the building-only compiler fix, read-only three-cell frontage
inspection and bounded global-owner diagnostics. **77 destination/frontage checks**, **89 owner-related
checks** and strict typechecking pass. Guard-only source checking is also integrated after
**49/49 focused checks** (7 parity +42 existing fault/command checks) and strict typechecking.
The earlier source157 full run **FAILED**, session31549: **1,789/1,790 passed,0 failed,
1 cancelled,0 skipped**, **1,233,147.1708ms**. The existing school-roof runtime test hit its
**180,000ms timeout/cancellation** (`dist/native-fixes-frontage-guard-verify-20261106.log`);
the other four gates and52/52 headless stages pass. The isolated school-roof rerun **PASSES1/1**,
session17025: **69,708.939ms test /70,184.3254ms suite**,0 failed/cancelled/skipped. This does not
replace the failed full run. A new **157-file freeze** adds only the approved specific abort
wording in `integration/civBuilder.js`; its **4 actual-builder checks pass in 386.919ms**, and strict
typechecking passes. The other 156 pack files, including the guard optimization, are unchanged.
The final fresh full session52247 now **PASSES1,794/1,794** and this157-file build is installed;
the failed full31549 and isolated17025 rerun remain historical evidence. **New native acceptance
is pending**, including mutation/rejoin/performance checks. Frontage inspection is a loaded floor/feet/head snapshot, not a route or movement/work
permission. The original 156-file source is preserved at
`dist/source156-before-native-fixes-20261106`; this is a source backup, not a new world baseline.

The installed156 copied-world **read-only leaf-repair preview COMPLETES at simulation hour527**:
**14 eligible candidates inspected, 0 replacement attempts, 0 verified replacements**, with
**3 protected refusals**. Only **6,758/35,911 wall targets** are surveyed; **29,153 are unreadable**.
This is scoped functional acceptance of the **14/3 preview**, not complete-wall, repair-write,
release-performance, stability or rejoin acceptance. The computed **batch receipt key is `c835b06e`**;
preview does **not** save an actual receipt. The final source label says “batch receipt key”,
replacing the misleading “retained receipt” wording without changing logic.
The preview copy is saved/closed, with a **15-file SHA-verified backup** at
`dist/backups/leaf-repair-copy-preview14-20261106` and receipt
`dist/native-wall-leaf-preview-copy-backup-hashes-20261106.json`; level SHA256
`17EA25149B96A2D3A7089460DB5CBD80A19F3E91DE67692ABD4D432C0FF495E2`.
The final closed native log contains **24 watchdog high-memory warnings**,06:18:51–06:23:08,
all in the initial installed156 D3 verification period, with **0 errors, 0 Molang errors and
0 script exceptions**. Evidence: `dist/native-leaf-preview-closed-log-audit-20261106.json`
(14,542 bytes, SHA256 `5DABB234B4036268CE88EC1F052FA8C80E0054D395CCE04788FC73E5C5A81D34`).
The earlier **11-warning live snapshot** remains preserved separately in
`dist/native-leaf-preview-live-log-counts-20261106.json` (8,365 bytes at11:43:15UTC); it was partial.
Attribution is **UNKNOWN**; neither recovered heap nor a warning cap is inferred. Retained prior
record generators/raw foundation inputs and repeated old-guard serialization are plausible
source-level pressure paths, not measured heap attribution or a proven leak.
**The new guard is not claimed to fix native memory warnings.**
The guard optimization
preserves exact checkpoints and API-call counts. Desktop guard CPU benchmarks improve **6.12×**
on the actual fixture and **28.38×** on1.5MB input; these are **not native timing proof**, whole-loader
speedup or evidence of fewer loader yields. City acceptance stays **step 2, OPEN**.

Current frozen source manifest:
`dist/native-fixes-frontage-guard-abort-label-pack-hashes-20261106.json`.
The preceding abort-only freeze was independently verified across **157 source hashes**, with
**0 mismatches**; its sole change was `integration/civBuilder.js`, SHA256
`2BE8D7A5F577624D06C789B956AF41D317489FF97F1629AD049C4CF606B3450F`.
The final freeze additionally changes only the receipt label in `commands/civ.js` (CRLF preserved).
The final installed157 source/installed verification is recorded in
`dist/native-fixes-frontage-guard-installed-verification-20261106.json` (314 SHA checks and exact
inventories). Earlier installed156 verification is historical; native guard performance remains
unaccepted, with the prior24 memory warnings unresolved.

**Latest native combat checkpoint — Nov6 (A5/B5, tested on prior156/1,741 build):**
production is now157/1,794; these historical native combat limits remain unchanged. A5's original guard142 starts at 30 HP and survives this encounter at **3 HP**,
with **9 incoming /6 outgoing hits**. The named-zombie loaded census later finds no target;
this does **not** prove its death or absence in unloaded regions. B5's separate original142 starts
at 30 HP and dies at **214995**, with **10 incoming /5 outgoing hits**. The selected guard was1/1/1
before the fight, but a broader owner duplicate-conflict refusal remains **unresolved**: the
conflicting group/actors are unknown, not proven to be the selected soldier. Its surviving named
zombie5659 is returned to the cage **after** the outcome and measures **0.31999945640563965/20HP**.

Both trials use the isolated 13-file v3 fixture; native camera/clear execution and pre-fight 20/20
fixture health are observed. **All six equipment slots remain API-UNKNOWN**; a bare appearance
is only visual evidence, with incomplete top-of-head coverage. Each closed trial backup has 13
SHA-verified files; **rejoin persistence is pending**. A4 remains an invalid staging attempt.
These limited outcomes establish neither a pathfinding cause nor general military acceptance:
**no production AI change is promoted**. Exact traces, backup receipts and limits:
`dist/native-controlled-combat-A5B5-20261106.json`.

City acceptance remains **step 2, OPEN**. Installed leaf preview has scoped **14 eligible/3 refused**
functional acceptance only; repair writes, rejoin, performance and stability remain pending.
The saved destination preview still has **no native acceptance**. The earlier 37-check frontage staging result is historical; that slice is now in **source 157**
with77 central destination/frontage checks and clean full verification; it is now installed157,
with native preview/frontage acceptance pending. Full civilian work, military classes/casualty authority,
integrated siege/expansion and diplomacy remain unfinished; no overall completion percentage is claimed.

The eight-step development order is maintained in [ROADMAP.md](ROADMAP.md#development-order);
step 2 remains open and the later whole-roadmap features are unfinished.

**Historical installed156 checkpoint — Nov6 (superseded by157 above):** **156 files** (150 BP +6 RP), with all source and
installed hashes independently matched to `dist/destinations-wall-leaf-contract-pack-hashes.json`:
**0 mismatches**. The clean full rerun finishes **1,741/1,741 tests**, **0 failed/cancelled/skipped**,
**515,314.7625ms**, all **five gates green** and **52/52 headless stages**, exit0
(`dist/destinations-wall-leaf-verify-rerun.log`, session53771). Minecraft was fully closed with
no process before deployment at **08:53:15 UTC** (`dist/destinations-wall-leaf-deploy.log`);
the previous pair is retained under suffix **2026-11-06T08-53-15-295Z-49e7df34**.
Independent receipt: `dist/destinations-wall-leaf-installed-verification-20261106.json`.

The installed additions are the **read-only saved civilian home/farm destination preview** and
**explicit guarded leaf-only wall maintenance**. The read-only leaf preview now has scoped14/3
functional acceptance; native repair writes/rejoin/performance remain pending. Destination preview
remains refused on installed156.
Source-level destination33 checks and leaf42 unique checks now also have the clean central run;
local physical blocks in the leaf tests remain simulated against real saved-source provenance.
A separate **CA Leaf Repair Nov6** copy is prepared with16 SHA-verified files
(`dist/native-leaf-repair-catalog-receipt-20261106.json`); its read-only preview completes at hour527
with14 eligible/3 protected refusals and no attempts or writes;
the original city remains preserved. The grass/fern movement proposal remains staged and is
**not included** in this installed156-file build.

The initial combined run remains **FAILED**, **1,735/1,737**,2 test-contract failures,
0 cancelled/skipped, **522,313.1657ms** (`dist/destinations-wall-leaf-verify.log`); the other four
gates and52/52 stages passed. Durable-property/event separation and deferred-join checks were
corrected with **67 focused checks**. The later owner-README audit extension has its own
**7/7 focused pass** (`dist/destination-contract-command-owner-readme.log`); it changed during
the full rerun, so exact latest test-file coverage is not inferred from the pack-only hash proof.
Production source156 stayed frozen. City acceptance remains open, followed by civilian work/travel,
accepted military roles/casualties, integrated siege/expansion, other civilizations/diplomacy and
a fresh accepted release template.

**Earlier trial preparation, before A4/A5:** A3 was briefly opened in Peaceful and saved/quit without commands or combat; it is **not a trial**
and its game save has advanced. B3 was never opened. Fresh A4/B4 with the same controlled hostile
fixture pack are planned; **no outcome is recorded**. Production melee reach/path are unchanged;
reach is a separate hypothesis, not a diagnosed cause.

**Earlier measured comparison — Nov6 (A2/B2), both original guards died:** the installed **152-file /
1,662-test** production build remains unchanged, with **`require_complete_path=true`**. A2 and
B2 each record **five guard-to-zombie hits**, **ten incoming hits of3 HP**, and **0 held /
0 budget-dropped** hurt observations. A2's baseline guard dies at201771. B2's separately cloned
baseline actor **`-34359738142`** starts at30HP, **1/1/1** (inspect201443, owner200669, age774),
then dies at **208316**, fresh canonical identity verified, cause **entityAttack / minecraft:zombie**;
removal208336 and zero loaded census208669 follow.

B2's one ordinary zombie **`-38654705656`** is **not siege-tagged** and visibly wears a
**chainmail helmet**, unlike A2. Its five received guard hits occur at
**208149,208197,208246,208269,208311**, gaps **48,49,23,42 ticks**, approximately **3.3856 damage
per hit** versus A2's approximately3.936. Random equipment therefore **confounds the comparison**;
these observations do not establish that the complete-path setting causes or fixes the losses.
Actual hit attribution is demonstrated, while full animation timing, cooldown, general combat
and overall guard acceptance remain open. **No production AI change is promoted.**

B2's later visible guard is the **distinct normal-owner replacement `-38654705655`**, born209669,
inspected210966 (owner210669, age297) at30HP and canonical1; it is **not survival of baseline142**.
The next combat gate needs an equipment-controlled fixture. Exact measured traces and earlier
trial history remain in `dist/native-swordsman-sol1-20261106.json`.

B2 is saved to the world list; its closed backup
`dist/backups/swordsman-path-B2-measured-failed-20261106` has **13 files independently SHA-verified**
against `dist/swordsman-path-B2-measured-failed-backup-hashes.json`; level SHA256
`C5DB051EB24972D83E6A2DE95A0232F8B9491ED5A8115EA605534D3900E5BBA4`.
Fresh A3/B3 copies are prepared (`dist/swordsman-path-comparison-worlds-round3-20261106.json`),
**not yet opened or tested** at this checkpoint; preparation is not an outcome.

**Earlier measured control — Nov6, installed hurt-diagnostics build:** current production is
**152 SHA-matching files**, full rerun **1,662/1,662 passed**, **0 failed/cancelled/skipped**,
**509,263.7766 ms**, all **five gates green** and **52/52 headless stages**
(`dist/swordsman-hurt-evidence-verify-rerun.log`). The earlier school-roof timeout/cancellation
remains recorded as a failed run; its isolated rerun passes in **27,731.176 ms**. It is not
substituted for the clean full rerun. Deployment occurred with Minecraft fully closed at
**07:19:45 UTC**, receipt `dist/swordsman-hurt-evidence-deploy.log`, retaining the previous pair
under suffix **2026-11-06T07-19-45-706Z-946efef9**. Source and installed152 hashes were independently
rechecked against `dist/swordsman-hurt-evidence-hashes.json`. This adds bounded read-only hurt
telemetry; production **`require_complete_path=true`** remains unchanged.

**A2 measured control lost, but can attack:** baseline actor **`-34359738142`**, **30 HP**,
**1/1/1** at inspect **198609** (owner197669, age940), starts with no zombies within12 blocks.
One ordinary zombie fixture **`-38654705659`**, **not siege-tagged**, is introduced near the
existing guard; the guard is not summoned or teleported. Normal / spawningfalse / night229000 /
Spectator conditions match the recorded trial. Hurt telemetry records **five outgoing hits** at
**201608,201634,201673,201725,201748**, gaps **26,39,52,23 ticks**, approximately **3.936 damage
per hit**, and **ten incoming hits of3 HP**, with **0 held / 0 budget-dropped** observations.
Fresh-canonical zombie entityAttack death occurs at **201771**, removal201791; inspection
**202866** (owner202669, age197) has **0/0/0** loaded matches. A sampled arm-raised pose is observed;
full animation timing/cooldown is not accepted. A different normal-owner replacement becomes
visible later, around simulationhour201 before Save and Quit; it is **not the dead142 survivor**.

A2 is saved/closed. Backup `dist/backups/swordsman-path-A2-measured-failed-20261106` contains
**13 SHA-verified files**, with stable source hashes during copying; level SHA256
`8516C81F7C02EA477861EB2DD9E96C5946201B9B3497178DC171296697ADA5B0`.
Receipt: `dist/swordsman-path-A2-measured-failed-backup-hashes.json`. At that checkpoint **B2 was pending**;
no definitive complete-path cause, production AI change or overall guard acceptance is claimed.
Exact traces: `dist/native-swordsman-sol1-20261106.json` (`measuredPathComparisonRound2.A2`).

**Earlier city diagnostic — Nov6, read-only D4 leaf preview:** installed **152-file / 1,657-check**
production build, checksum **35635162**, observer **(-320.5,78,-456.5)**, simulation hours **489–490**.
The preview is **INCOMPLETE**: **35,911 targets**, **6,758 surveyed**, **29,153 unreadable wall
cells**, **0 unreadable contacts**. Among the **17 observed tree cells**, **14 are eligible**,
**3 are refused near protected neighbors**, and **0 are now present as expected masonry**.
All 17 have **persistent_bit=false** and **27/27 readable contacts**; page1/1 (limit64) lists every
observed candidate. One eligible cell is oak leaves; the other16 observed cells are jungle leaves.

This establishes scoped eligibility for **14 cells**, replacing the earlier unknown eligibility
for those cells; it does not accept the unreadable walls or authorize stale writes. **No blocks
changed**. Preserve the three refused boundary cells. A future guarded mutator must reverify plans,
protection, exact live leaf state and contacts before each write. Exact coordinates, expected wall
IDs and refused-neighbor coordinates: `dist/native-wall-leaf-preview-20261106.json`.

The city was then saved/quit and Minecraft fully closed (Sky showed only Codex).
Closed backup `dist/backups/corrected-d4-leaf-preview14-20261106` has **16 files independently
SHA-verified** against `dist/corrected-d4-leaf-preview14-backup-hashes.json`; level SHA256
`0109A6B32F47536BFB53261DA771ECE8F62E47BF1ABAF1DAFB55AF43E71C1018`.
The three refused candidates' expected wall IDs are confirmed as **mossy stone bricks, stone
bricks, mossy stone bricks**, respectively; the neighboring coordinates explain the refusals.

**Earlier paired path comparison — Nov6, experimental only:** Active Packs UI shows only the
original BP in **CA Sol1 Path A Nov6**; B shows **Civ Swordsman Path Probe (Isolated)** above
the original BP, with the UI explaining that the highest-ranked asset applies. Both copies start
from the same baseline, including actor ID **`-34359738142`**; this matching ID in separate worlds
is not continuous identity across the two trials. Production at that checkpoint remained **152 files / 1,657 full
checks passed**, without promotion of the experimental path change.

Both trials use **Normal**, **`doMobSpawning=false`**, night **229000**, a **12-block zombie
query with no baseline targets**, then **one ordinary zombie at guard-relative `~ ~ ~1`**.
A starts at **30 HP**, canonical/type/tag **1/1/1** (inspect200671, owner200669, age2), then
records a fresh-canonical **zombie entityAttack death at207507**, removal207527, loaded census0
at207669. B starts at **30 HP**, **1/1/1** (inspect/binding197590, owner196669, age921), at
**(-90.69999694824219,66,-630.7000122070312)**. After the encounter, the zombie is absent,
a rotten-flesh drop is visible and the guard remains visible. Inspection **200462**
(owner199669, age793) confirms the **same B actor at6 HP**, **1/1/1**, at
**(-92.184326171875,67,-632.6124267578125)**; no guard death is recorded, and the final
12-block zombie query has no targets. The observer did not attack anything.

This **one paired trial supports the complete-path hypothesis**, while authoritative guard damage,
attack motion, cooldown and definitive causality remain unproved. B's sole entity change is
**`require_complete_path: true → false`**. Overall guard acceptance remains open. Bounded
read-only hurt telemetry is the next diagnostic work; no production AI change is promoted here.

Both trials are now saved/closed with **13 files independently SHA-verified per backup**:
A `dist/backups/swordsman-path-A-combat-failed-20261106`, level SHA256
`22265E305FC910E041D4AA8BB9D4706DFCFB3091A2A295EA130BEF28F2664574`;
B `dist/backups/swordsman-path-B-survived6-20261106`, level SHA256
`9DCD74BCB2D9EC9214D15A3BF8ACFE335C8F7CC3016AB7F3E751FC49761B3716`.
Receipts: `dist/swordsman-path-A-combat-failed-backup-hashes.json` and
`dist/swordsman-path-B-survived6-backup-hashes.json`. Scoped native history:
`dist/native-swordsman-sol1-20261106.json`.

**Earlier comparison preparation — Nov6, before the paired trial:** Minecraft is saved/closed;
only Codex is observed before preparing the fixtures. Failure checkpoint
`dist/backups/swordsman-sol1-render-player-pass-combat-failed-20261106` contains **13 SHA-verified
files**; `level.dat` is **3,076 bytes**, saved **01:21:13 local**, SHA256
`A7ECE5CAE64D097E56FF8788B21C8ADDF65A8EBCE37BDEB6DB9DCD3ED14F0249` (independently matched).

Two **new catalog worlds** are prepared from the same **13-file SHA-verified Peaceful baseline**
`7B0E743374390D57A63134CDE2997EBB9D4E8EC2DDE6555C8E5BF404FCB2F412`:
**CA Sol1 Path A Nov6** (`CA_Sol1_PathA_Nov6`) changes only NBT LevelName and `levelname.txt`;
**CA Sol1 Path B Nov6** (`CA_Sol1_PathB_Nov6`) makes those naming changes and adds a behavior-pack
binding. All database/other copied files remain identical to that baseline. Receipt:
`dist/swordsman-path-comparison-worlds-20261106.json`; preparation script:
`dev/prototypes/swordsman/path-comparison-worlds.mjs`.

B's intended binding order is data-only override **c8644dda-e2b4-46cc-b2cb-5b72f5d972c9 v0.0.1**
then original script BP **fd04cb50-dddc-4ebe-83fc-5b5375819bcb v1.0.0**, retaining the original
saved-property namespace. The unique **CA_Swordsman_PathProbe_Nov6** development pack contains
only **two SHA-verified data files**. Deep entity comparison confirms exactly one field change:
**`minecraft:behavior.melee_attack.require_complete_path: true → false`**; no new script/spawner.
At that preparation checkpoint, three standalone checks passed; native A/B and UI loading-priority
proof were still pending. The later paired observations above supersede those pending statuses;
definitive causality and full combat acceptance remain open.
This is **not a promoted implementation**. Original production BP/RP remain unchanged: at
**06:25:50.003 UTC**, all **152 source and 152 installed hashes** still match the combined handoff;
the probe's separate two-file source/installed hashes also independently match.

**Earlier controlled-combat result — Nov6, installed combined152:** daytime front views now
show the human face, helmet, tunic, pants, belt, boots **and sword**. The Sol1 trial alone is
set to **Normal** with **`doMobSpawning=false`**. In Survival, one empty-hand player click reduces
guard **`-34359738142` from 30 to 29 HP**; inspection **206931** (owner206669, age262) confirms
**1/1/1 loaded matches**, at **(-90.062255859375,66,-630.7000122070312)**. More than **20 seconds**
of observation shows the player still at **ten full hearts**, with no guard attack observed.
This **specific player-retaliation negative case passes**, not all friendly-family cases.

Back in Spectator at night (**time229000**), a guard-centered **12-block zombie query finds
no targets**. Exactly **one ordinary vanilla zombie** is manually introduced at guard-relative
`~ ~ ~1` as a hostile fixture; the guard is neither manually spawned nor teleported. The zombie
attacks and knocks the guard up steps/moves it to the right; there is **no authoritative guard
attack-swing proof**. Actor **`-34359738142` dies at213434**, fresh canonical identity verified,
cause **entityAttack**, damager **minecraft:zombie**; removal follows at213454. The exact damaging
zombie ID/tag is not captured. Effective zombie self-defense **fails/remains unaccepted**; the
specific targeting/path/home failure mechanism is not yet established.

The normal owner spawns a **different guard**, **`-38654705656` at213669**. Inspection **214781**
(owner214669, age112) confirms **1/1/1**, **30 HP**, at
**(-90.69999694824219,66,-629.7000122070312)**. This replacement is not the dead actor. At that observation Sol1 was
open in **Spectator / Normal / spawningfalse**, diagnostics on; it is subsequently closed and
the separate A/B preparation above is recorded. No full combat, other-friendly or casualty acceptance is claimed.

**Earlier post-install guard appearance — Nov6, before controlled combat:** Sol1 actor
**`-34359738142`** survives the application restart/install and remains **30 HP**. Inspection
**196468** (owner **195669**, age **799**) reports admitted intent yes and **one canonical /
one expected-type / one exact-tag loaded match**, at
**(-90.062255859375,66,-630.3861083984375)**; fresh settling uses **27/240 reads**. Diagnostics
are on before inspection and record its verified binding at **195669**.

Close observer-only view `~ ~0.2 ~0.9 180 0` passes and shows a **human face and blue helmet**.
View `~ ~1 ~3 180 20` passes and shows the **full blue human helmet/tunic, dark trousers,
belt and boots**, with **Hearthgate levy** visible. **Base human appearance now passes on the
current build.** No actor is summoned or teleported for these checks. At that appearance check the world is
**Peaceful / Spectator**; the later Normal controlled test and scoped player result are above.
Earlier invisibility's complete cause is unresolved because the viewing angles also changed.

Fresh session log **`ContentLog2026-11-06_00-56-52_1.txt`**, **4,170 bytes**, has **zero errors,
zero warnings and no unsupported attack-query occurrences**; historical log errors are not
counted. Scoped evidence: `dist/native-swordsman-sol1-20261106.json`. Overall guard acceptance
remains partial until the combat/lifecycle gates pass.

**Latest full verification and installation — combined 152 files, Nov6:**
`dist/swordsman-combat-render-verify.log` finishes **1,657/1,657 tests**, zero failures,
cancellations or skips (unit duration **892,213.9352 ms**), all five gates green with exit0 and
**52/52 headless stages**; session **86332**. The exact 152-file source snapshot matches
`dist/swordsman-combat-render-handoff-hashes.json`. With Minecraft fully closed (no process;
only Codex in the app inventory), deployment succeeds at **2026-11-06 05:56:35.900 UTC**;
`dist/swordsman-combat-render-deploy.log` records **152 source/installed SHA-identical files**
(**146 BP + six RP**), independently rechecked. Both previous152 packs are retained outside
scanned directories under suffix **2026-11-06T05-56-35-900Z-a29b9cc1**.

Minecraft **26.62** subsequently relaunches successfully to its main menu, then the Sol1 trial
reopens. The post-install base appearance and same-ID/30HP persistence checks above pass;
effective zombie self-defense remains unaccepted; the later single player-retaliation negative
case passes, while broader friendly targeting and combat motion remain open.
The earlier six-line Molang defect and zombie deaths belong to the old152 snapshot below.

**Latest native farm acceptance — Nov6, then-installed old 152:** corrected-city
`building-d4-farm_allot-1` passes a read-only preview (**one farm / one ready / zero changed,
preserved, unloaded or pending**), then confirmed sparse-light migration: **five changes,
one frontage lantern placed and four old corner lanterns removed**, with zero preserved,
unloaded or pending. The report preserves source plans, crops, fences and piles.

Native baseline checks pass for fern **(-448,66,-571)**, short grass **(-448,66,-573)** and
birch-fence anchor **(-439,66,-575)**. One post-migration execute chain confirms all four old
corners at **X{-447,-439}, Z{-580,-572}, Y67 are AIR**, the same fern/grass/anchor remain, and
the new **(-439,67,-575) lantern** is present. These are exact checked cells, not a complete crop
or world census. **Save/rejoin confirmed repeat passes:** one farm / one ready, **zero changed, placed,
removed, preserved, unloaded or pending fixtures**. The same combined four-AIR-corners +
fern/grass/fence/new-lantern check passes again after rejoin. No native property-write count is
claimed.
The separate combat/RP correction **was not installed during this farm run**; deployment follows afterward.

Closed checkpoint `dist/backups/corrected-d4-allot1-fern-light-migrated-20261106` has **15
SHA-verified files**. `level.dat`: **3,073 bytes**, saved **00:49:52 local**, SHA256
`34D91C03F4671081D122A3751F15C0501A366A86AB1E5C92CFC5DFB1447E2188` (independently matched).
The newer post-rejoin closed checkpoint is
`dist/backups/corrected-d4-allot1-fern-light-rejoin-zero-20261106`: **15 SHA-verified files**,
`level.dat` **3,073 bytes**, saved **00:55:16 local**, SHA256
`3FF9D4515C80BEF6C43F6825A1B95B864A39746BD8E51B28F7B2550FA6A4A0F7` (independently matched).
Scoped evidence: `dist/native-farm-d4-allot1-20261106.json`. Historical master **9e5e307e**, D4
source **35635162**, allotment2 journal plan **2515fcee** and kitchen1 **91a58719** remain recorded;
no new allotment1 journal ID is inferred. Full city appearance/acceptance remains open.

**Earlier appearance isolation — Nov6, before the combined correction:** replacement actor
**`-34359738167` also dies at 183910**, with fresh canonical identity verified, cause
**`entityAttack`**, damager **`minecraft:zombie`**; removal follows at **183930**. The damager's
managed-siege tag remains unknown. The Sol1 trial alone is then set to **Peaceful**, after about
simulation hour **181**, for appearance isolation. This supplies no combat proof.

The normal owner spawns **`-34359738142` at 184933**. Inspection **186208** (owner185933,
age275) finds **30 HP** at **(-90.68219757080078,66,-630.5811157226562)**; inspection **188881**
(owner187933, age948) finds the **same ID / 30 HP**. Observer-only north/south selector teleports
pass; no actor is teleported. A spectator overhead command (`~ ~3 ~ 0 90`) also passes, placing
the observer near **(-90.06,69,-630.39)**; **no model is visible in that tested view**. Earlier
ground views may have been occluded. Appearance remains unaccepted.

After flushing the fresh content log, the agent finds **six Molang error lines** for unsupported
**`query.attack_time`** at three RP references: one client attack condition and two right-arm
rotation expressions. World Resource Packs **ACTIVE** lists **Civilization Apocalypse Resource
Pack**, and activation succeeds. This establishes RP definition consumption and an expression
defect, **not the complete cause of model invisibility** or accepted melee rendering.

The combined **152-file source candidate was frozen for verification**, hash list
`dist/swordsman-combat-render-handoff-hashes.json`: exactly three pack files differed from the then-installed
old152 (BP swordsman entity, RP client entity and RP animation). It adds filtered zombie-only
hurt-by self-defense with friendly-family exclusions; proactive targeting, home/path/cooldown
remain unchanged. The RP patch replaces exactly three `query.attack_time` references with
`variable.attack_time`. **19/19 focused checks**, strict typecheck and **1,324 manifest checks**
pass. The subsequent combined full run **86332** now passes **1,657/1,657**, all five gates and
52/52 headless stages and is installed, as recorded above; native base appearance now passes, while combat
acceptance remains pending.
The intermediate self-defense run **25400**, `dist/swordsman-self-defense-verify.log`, is
**canceled/incomplete, exit1**. The combined 1,657-test run supplies its own proof; the canceled run remains incomplete.

The appearance baseline was **saved/closed in Peaceful with the spectator overhead** before deployment. Closed baseline
`dist/backups/swordsman-sol1-peaceful-appearance-baseline-20261106` has **13 SHA-verified files**;
`level.dat` is **3,076 bytes**, saved **00:39:33 local**, SHA256
`7B0E743374390D57A63134CDE2997EBB9D4E8EC2DDE6555C8E5BF404FCB2F412` (independently matched).
The guard remains **not accepted**. Scoped chronology: `dist/native-swordsman-sol1-20261106.json`.

**Earlier native cause evidence — Nov6, installed 152:** the owner spawns canonical Sol1 actor
**`-34359738176` at tick 181933**. At **182221**, lifecycle diagnostics capture an **`entityDie`
event with fresh canonical identity verified**, cause **`entityAttack`**, damager
**`minecraft:zombie`**. This establishes zombie death **only for that actor**. The damager's
managed-siege tag is **unknown**; neither ordinary/untagged nor managed status is established.
An `entityRemove` event follows at **182241**, with removal cause unknown; the preceding death
event already proves death. Earlier actors' disappearance causes remain unresolved.

The normal owner spawns replacement **`-34359738167` at 182933**. Inspection **182972** (age
**39 ticks**) finds **one canonical / one expected-type / one exact-tag loaded match**, **30 HP**,
at **(-90.69999694824219,66,-629.7000122070312)**. Appearance is still unverified and the guard
is **not accepted**. The subsequent combined self-defense/RP correction was frozen for verification,
as recorded above; proactive acquisition remains **managed-siege-only**. Its combined full
verification and deployment now pass; native guard acceptance remains pending. See `dist/native-swordsman-sol1-20261106.json` for the scoped event sequence.

**Earlier native evidence — 2026-11-06, installed 152:** the normal population owner spawns
selected Sol1 actor **`-30064771070`**, `civ_trial:swordsman`, observed at
**(-90.69999694824219,66,-629.7000122070312)** with **30 HP** and exactly **one canonical /
one expected-type / one exact-tag loaded match**. The **same actor ID and 30 HP survive
save/quit/rejoin**. This advances existence and persistence acceptance for this actor.
**Appearance remains unverified; no render defect is established.** Native
`/testforblock -91 66 -630 air` passes for that one cell; the fresh content log is **0 bytes**.
Neither observation establishes a model-rendering result. Friendly exclusion, combat/cooldown/
pursuit and authoritative casualties remain open. This is a different actor from Nov5's
`-25769803745`; the earlier loaded absence still has no established cause.

Closed checkpoint `dist/backups/swordsman-sol1-alive30-render-unproven-20261106` contains
**13 SHA-verified copied files**. `level.dat`: **3,076 bytes**, saved **00:13:34 local**,
SHA256 `86C8C871DF5CCD20AF521E4A2700E98EC671FAEE78C112A36A842E31ABB0D75A` (independently
re-read and matched). Scoped evidence: `dist/native-swordsman-sol1-20261106.json`.

**Earlier Nov6 absence — guard acceptance remains open:** near simulation hour **174**, an
observer-only teleport using the guard selector returns **NO TARGETS**; no actor teleport occurs.
Read-only inspection at tick **181141** reports owner tick **180933**, age **208**, admitted intent
yes, but **zero canonical / expected-type / exact-tag loaded matches**. Its fresh terrain probe
finds a safe settle point **(-91,66,-630)** using **27/240 block reads**; the last owner birth
status is **not queued within the attempt budget**. The separate native AIR checks at
**(-91,66,-630)** and conditional **(-91,67,-630) / (-91,68,-630)** both pass.

Lifecycle diagnostics were **OFF during the disappearance** and are reenabled before that
inspection; only a **loaded census of zero** is recorded. **The cause of that earlier actor's absence is unknown.** The earlier
same-ID/30HP save/rejoin pass remains an earlier positive observation, not proof of continued
presence. Appearance remains unverified; no death/removal/unload or render cause is established,
and the guard is **not accepted**.

**Historical old152 — root-cache verification/installation (2026-11-05):**
`dist/tree-root-cache-verify.log` completes **1,652/1,652 tests**, zero failures, cancellations
or skips (unit duration **476,893.229 ms**), all five gates with exit 0 and **52/52 headless
stages**; session **65981**. All **152 frozen hashes** match
`dist/tree-root-cache-pack-hashes.json`. Both packs were installed at **19:52:07 UTC** after
Minecraft was fully closed: deployment preflight then observed no Minecraft process and only
Codex in Sky. All **152 source/installed SHA256 hashes matched at that checkpoint (146 BP + six RP)**. The prior 151-file
packs remain backed up under suffix `2026-11-05T19-52-07-384Z-e004db39`.

This revision adds the bounded root-refusal dependency cache: an actual exact owned foundation
write permits another full tree proof, with existing tree eligibility, ore/foreign-contact and
protection rules unchanged. Relevant focused checks pass **72/72**, root's independent new
checks **7/7**, historical isolated reproduction **5/5**, and strict typecheck passes.
Native checks resume on installed 152 on Nov6, as recorded above. The earlier closed/manual-open
status is superseded. D5's native cause, leaf eligibility/trimming, guard appearance/combat and
casualty completion remain unestablished; the positive Sol1 save/rejoin result is scoped to its
exact actor and does not explain Nov5's loaded absence.

**Historical revision 151 — completed full verification and installation (2026-11-05):**
`dist/fern-military-diagnostics-verify.log` completes **1,645/1,645 tests**, zero failures,
cancellations or skips (unit duration **965,736.9703 ms**), all five gates with exit 0 and
**52/52 headless stages**; session **54866**. All **151 frozen pack hashes** match
`dist/fern-military-diagnostics-pack-hashes.json`. Both packs are installed at **12:40:24 UTC**
with Minecraft fully closed beforehand: **151 source/installed SHA256 matches (145 BP + six RP)**.
The prior 150-file packs are retained under `codex_pack_backups` with suffix
`12-40-24-771Z-4c85a8c2`.

This revision includes the narrow fern-contact preservation extension and opt-in selected-guard
lifecycle diagnostics, default off. **Native checks on that installed 151 snapshot were not run.** Two reopen
attempts fail in Sky with `accessibility window-opened handler did not become ready`, including
after a kernel reset; no Minecraft window is observed. Offline verification and installation
are complete; in-game fern, lifecycle, rendering and rejoin acceptance remain open.

**Historical revision 150 — completed full/native checkpoint:**
`dist/natural-farm-hold-verify.log` finishes **1,633/1,633 tests**, zero failures, cancellations
or skips (unit duration 995,542.3817 ms), all five verification gates with exit 0, and **52/52**
headless stages. The verified snapshot contains **150 pack files** (144 BP + six RP), recorded
in `dist/natural-farm-hold-pack-hashes.json`; session 92156. This exact snapshot was then installed;
later source changes require fresh verification.

Historical 150 deployment: both packs are installed after Minecraft closes at **11:50:35 UTC**; all
**150 source/installed SHA256 hashes match**. Deployment retains the old 149-file packs under
`codex_pack_backups`. The pre-farm closed authoring checkpoint is
`dist/backups/corrected-five-built-gates-doors-wall-passed-chapel-leaves-open-20261105`:
all **19 copied files** verify SHA-identically. Its `level.dat` is 3,073 bytes, saved **06:48:42**
local, SHA256 `8023B4AA1EA705C37741011057E2C5DD9F7CEF025643F71CAE0A938CC4C005CB`.
This is a playing world around hour **435**, closed near **(-217.5,90,-550.5)**, not the fresh
400-civilian/150-soldier release baseline.

**Earlier native farm acceptance — then-installed revision 150:** D4's three-farm preview reports
**one ready, one preserved, one unloaded and zero changes**. Allotment 1 remains held by an
unplanned fern at **(-448,66,-571)**; allotment 2 is outside the observer's loaded view.
The kitchen-only confirmed migration completes with **one ready, five changes: one frontage
lantern placed and four old corner lanterns removed**, with zero preserved/unloaded/pending
fixtures. Native checks pass for the new lantern, all four old corners being AIR, and the
short grass at **(-414,64,-554)** remaining intact. After **save/rejoin**, a confirmed kitchen-only
repeat completes with **one ready and zero changes, placements, removals, preserved, unloaded
or pending fixtures**. Native chat measures fixture block changes; no native property-write
count is claimed. Facts: `dist/native-farm-d4-kitchen-20261105.json`.

The previous closed city checkpoint is
`dist/backups/corrected-d4-kitchen-rejoin-zero-wall17-20261105`: **15 files SHA-verified**,
`level.dat` SHA256 `295C032EBF4D15A314BD02F8BDDFE5DCA02F401824DD8399AAD24DB48BB9273C`.
The D4 repeat wall audit reports **22,327 surveyed, 22,274 present, 17 tree-occupied, 36 other,
8,584 protected/unread, zero missing and zero unloaded**. Completed D5 adds protection, so
these are different coverage counts from the historical pre-D5 audit. The first four leaf
coordinate samples in `dist/native-farm-d4-kitchen-20261105.json` contain block IDs only;
they establish no leaf state, trim eligibility or condition of protected cells.

The earlier 15-file farm checkpoint remains
`dist/backups/corrected-d4-kitchen-frontage-migrated-fern-held-20261105`, `level.dat` SHA256
`FDA4AF3FECCE2FBE940DD50EF0A802F53983F9BA648D815504505BBF12A7CB18`. Its independent
closed-backup journal inspection verifies master **9e5e307e**, all five saved civ records
complete, and D4 **allotment 2 plus kitchen 1 journals done**, source **35635162**.
`dist/closed-kitchen-fern-journal-audit.json` is saved-journal evidence for that earlier backup,
not a physical block/entity census or a journal audit of the newer backup.

The isolated wall-leaf trim prototype passes **28/28** after correcting final-read source and
protection checks. It remains isolated: active leaf preview is read-only, with no native
trimming or trim eligibility accepted. All-district lighting and day/night appearance remain open.

The fresh **CA_SwordsmanSol1_Nov5** trial uses **13 SHA-identical files** from the reviewed
D1-only fixture (original `level.dat` SHA256
`672745b7baae286ee34f1edd22b53116d00d6a0d12abad5d86564c058a839524`). Selection of
**`district-1:sol:1` is accepted before people are switched on**. At owner tick **148445**, the
normal owner records an **APPLIED `civ_trial:swordsman` birth**, settled at **(-101,69,-618)**.
Inspection at **149337** finds exactly **one canonical / one expected-type / one exact-tag**
loaded match, actor **`-25769803745`**; native `/testfor` finds Hearthgate levy and an observer-only
teleport matches the guard. The guard is not teleported for this check.

Later, native queries find no targets and inspection reports **0/0/0 loaded matches**, despite
admitted intent remaining yes; the last birth status is not queued within the attempt budget.
**No cause is established.** A nearby vanilla gold zombie is not causal evidence.
This proves the first native custom-type birth and one exact loaded identity, not accepted human
model rendering, persistence/rejoin, friendly exclusion, combat/cooldown/pursuit or casualties.
The closed **13-file SHA-verified** backup is
`dist/backups/swordsman-sol1-first-birth-later-absent-20261105`, `level.dat` SHA256
`6A6D0EF0F26701A3E6F0BA400A5CFE25C847D5AE4C82657A4E9950F1EBB629D4`.
Scoped facts: `dist/native-swordsman-sol1-20261105.json`. The separate native D4 kitchen
acceptance and remaining fern hold are recorded above; the guard's disappearance is still unexplained.

Isolated military accounting remains exploratory: reserve-v2 retains its **43 standalone
checks** (22 new + 21 historical); archive-v3 brings the combined isolated suite to **60/60**
(17 further cases). Compressed ranges preserve exact birth/headcount/home/host through 10,000
simulated distinct actor visits, allowing explicit archival/reactivation beyond the old 128
working-birth ceiling. There is no silent reserve folding or renumbering. **128 archive ranges**
still bound fragmented history; capacity/split conflicts refuse safely, and dormant births hold
ambiguous combat-authority handoff. Real absence/ingress authentication, durable storage and
native casualty capture are unimplemented. These checks do not count toward active military
completion or the installed 1,633-test pipeline.

The installed revision combines persisted-run-count fair birth attempts, bounded admission-versus-loaded
actor inspection, guarded sparse farm fixtures preserving unplanned short grass and legitimate
planned crop growth, read-only leaf preview, and the tree/normal hold-cache correction. Focused
checks pass **143/143** for population/boundaries (including **18 new cases**), **30 farm migration
plus one starter check**, **6/6** leaf preview and **4/4** hold routing regressions; strict typecheck
and independent read-only reviews pass. All 128 legal growth checks on actual frozen D4 crop
contacts pass with unchanged proposal fingerprints. None of these offline results establishes
native movement, guard appearance, new farm-contact acceptance or corrected chunk loading.

Earlier `dist/population-farm-leaf-verify.log` retains its **1,623/1,623** full pass only for the
older 150-file snapshot in `dist/population-farm-leaf-pack-hashes.json`, not this newer source.
A real-D4-proposal in-memory regression (`dist/farm-contact-crop-state-regression-20261105.json`)
then exposes overstrict `growth:7` versus `growth:0` contact refusal despite intact guards;
these are simulated states, not native-world crop changes. The intermediate hold-cache run,
session 70544, `dist/construction-hold-cache-verify.log`, is deliberately stopped and **incomplete
(exit 1)**. The fresh completed 1,633-test run above verifies the combined corrections; it does
not turn that canceled run into a pass. The current installed 152-file proof is recorded above.

**Historical revision 149 — prior completed full/native checkpoint (2026-11-05):** `dist/farm-frontage-reverify.log` passes
**1,592/1,592 tests**, zero failures/cancellations/skips, all five gates and **52/52** headless
stages (821,878.5717 ms). That previously installed snapshot contains **149 pack files** (143 BP + six RP),
hashes in `dist/farm-frontage-pack-hashes.json`. Both packs were installed while Minecraft
was fully closed with **149 hashes verified**; its partial native farm evidence follows. Previous
revision 147 retains its separate 1,562/1,562 full pass. Standalone deployment checks pass **9/9**.
The first 149-file run had 1,591/1,592 passing because a parity test omitted the new versioned
options; its test-only correction passes focused parity 1/1 and the complete rerun above.
Later working-tree edits require fresh verification and do not inherit this installed proof.

The farm trial on then-installed revision 149 is partial: D4 `building-d4-farm_allot-2` changes exactly
five blocks (one supported frontage lantern placed, four original corner lanterns removed).
After save/rejoin, its confirmed farm-specific repeat reports one ready and **zero changes**,
preserved or unloaded cells. The other two farms remain unchanged/held by short-grass contacts
at **(-448,66,-573)** and **(-414,64,-554)**. No grass is removed. The closed 15-file SHA-verified
backup and observations are recorded in `dist/native-farm-d4-20261105.json`. Installed revision 150 permits
only verified unplanned, non-role short grass to remain untouched; fixture, target, support,
entrance, protected-neighbor and changed-contact guards remain in force. Its newer native kitchen
acceptance is recorded above; allotment1 was fern-held on that older150 snapshot and now migrates and repeats with zero changes on old152. Full day/night
appearance and water-deck inspection remain open.

The corrected copy now has **all five districts built; city acceptance is unfinished**. D5 on
installed revision 149 processes all **52,044 saved operations** after its loading pause and
operator-assisted resume. Its final report covers the **resume run only**: **38,293 placed +
6,805 already present + 4,902 skipped = 50,000 operations**, exactly 52,044 minus the earlier
cursor 2,044. It is not the cumulative whole-build placement/skip report. That resumed run has
zero failed writes/state fallbacks, 3,215 slices, maximum 400 operations and 993 reads per slice;
220 natural trees / 31,606 blocks cleared and 25 trees preserved. Listed resume-only skip reasons
include 4,801 protected cells, 20 foreign doorway cells, 20 melon, 16 nonnatural roots and 12 coal.
Closed-journal D5 identity is checksum **`23a6aeca`**, **complete / 52,044 operations**.
Its actual saved `civ.centre` is **(-207,-473)**; **(-258,-446)** is HQ/tour. Native completion
chat labels that HQ/tour point “Centre”, which caused the earlier documentation conflation;
the UI label does not change the saved centre. All four gate references pass native close/sealed/reopen/
passable phases and return open. Door maintenance finds **32 pairs present and restores nine**
(**41 total**), with zero missing, blocked, unloaded or failed. The first wall audit finds one
missing cell at **(-239,74,-368)**, expected cracked stone bricks. Guarded maintenance restores
exactly one cell, finds 20,509 already present and preserves 3,635, with zero failed writes.
Repeat audit: **24,063 targets**, **20,465 surveyed**, **20,428 present**, **zero missing/tree/
unloaded**, **37 other occupied**, **3,598 protected/unread**. Protected counts do not establish
those cells' physical condition. Supported-light confirmation checks **41 buildings / 58 fixtures**:
**56 ready, zero changed, two preserved, zero unloaded/unstable**. Both preserved fixtures belong
to `building-d5-chapel-1`; native inspection confirms oak leaves at contact **(-217,69,-536)**.
Those leaves remain untouched. Full visual/gameplay acceptance remains pending.

Before construction, the installed-149 D5 survey reads **78,384 columns**, then saves a **52,044-operation** plan. Its first construction
pause is at cursor **2,044**, target **(-303,63,-492)**: the clear read returns no block. The
reported active hold is X **[-336,-209]**, Z **[-480,-353]**, `lastheld=true`, with manager
capacity **64/300**; the target Z is outside that reported rectangle. This native observation
alone did not identify the cause. The observer moves to **(-303.5,105,-492.5)**;
`/scriptevent civ:generate_resume district=5` accepts the existing saved plan, reloads its
checksum and construction resumes at approximately **4.2%**. D5 supported-light and full city acceptance remain pending;
this resume does not establish a hold-bug fix.

Source inspection confirms a matching loader-cache failure path: after a tree hold replaces
the actual held rectangle, the normal-window `lastHoldBox` cache can remain stale. Returning to
the same normal box can take the already-requested fast path despite failed actual containment.
The latest verified 150-file snapshot invalidates that cache at the tree-hold transition. Four
focused routing regressions, including a one-line-removed negative control matching the native
rectangle, pass; normal/no-capacity retry and cancellation behavior remain covered. Installed149
completes D5 through operator-assisted loading. The correction is now installed but not natively
retested; offline proof and deployment do not establish native loading acceptance.

D4 completes 71,853 operations,
passes all three gates, finds 37 door pairs and restores five. Seventeen wall leaf obstructions
and two supported fixtures remain preserved. Closed D3/D4 ground comparison passes at all three
coastal samples: original beds **46/48/57**, water surface **62**, wall top **75**; the native
sample is stone at Y75 and AIR at the former inflated Y88. Vegetation, foundations, actual walking
and daytime/night appearance remain open.

Historical native trial status on revision147 (superseded by the Nov6 owner-created Sol1 and measured combat evidence above): fresh-fixture military selection accepts D1 group `sol0`,
but no guard is observed after many simulated hours. Admission counters do not prove an actor
exists. A separate read-only reproducer demonstrates possible admission starvation; it does not
establish the native ground-probe cause. Civilian group 0 is observed as actor `-25769803760` at
**(-31.837,67,-644.159)**; `start-near ... length=4` refuses because no safe 1–4-block corridor
is found. Nothing moves, so military appearance/combat and civilian travel acceptance remain open.

For the installed 149-file farm candidate, preview with
`/scriptevent civ:farm_lights district=N [farm=ID]`; append `confirm` only for the backed-up
validation copy. Inspect `/scriptevent civ:farm_lights_status district=N`. Verify new supported
fixtures before removal, two actual stability ticks, foreign-block refusal, interruption/restart,
zero-write repeat and save/rejoin. `/scriptevent civ:starter_status` and `civ:starter_verify`
refuse corrupt, unfinished or wrong-source farm journals; completed matching journals survive
starter preparation. New-generation `farmLighting:'frontage-v1'` / `waterPiles:'spaced-v1'`
are persisted versions, absent legacy options remain exact, and existing-world piles are preserved.
Native attachment, entrance clearance, crop growth, day/night appearance and water-deck checks
remain pending. Preview/confirmation and a complete journal do not prove those visual/gameplay checks.

Installed-150 diagnostic commands (native acceptance still required):
`/scriptevent civ:people inspect group=district-1:sol:0` reads the cached last owner plan and
its tick/age separately from one fresh exact-tag loaded census. It reports the chosen post,
requested/settled spot, actual previous birth result and at most 240 native block reads, two
entity identities and 64 tags per identity; no reconciliation, gate toggle, spawning or movement
is triggered. Loaded absence does not establish absence in unloaded chunks. Fairness tests
cover failed early civilians, selected soldier opportunity, persisted distinct hours/rejoin,
same-tick caps, no duplicates, admission parity and lost-cursor recovery.

`/scriptevent civ:generate_diag leafpreview district=N [page=P]` is read-only. It first verifies
completed saved own/neighbor plans and reads only already player-loaded chunks; it changes no
blocks, properties, holds or plans. The bounded preview lists conservative candidates and
refusals; it authorizes no trimming and does not resolve the 17 native D4 leaf obstructions.
With the verified 150-file revision now installed, repeat both diagnostics
natively, prove a selected guard actually appears safely, and retry held farm migrations with
backup/rejoin/zero-write repeats before recording acceptance.

The verification and deployment paragraphs below are historical checkpoints; their old pending
statements are superseded by the current checkpoint above.

Previous completed verification (2026-11-05): `dist/interior-travel-reverify.log`, **1,519/1,519** tests,
zero failures/cancellations/skips, all five gates, **52/52** headless stages, exit 0.
137 pack files install SHA-identically while closed. Native hall-only fixture repair passes
3 ready / 1 changed / 0 preserved, unloaded or unstable; standing-state block check passes and
the table lantern survives rejoin. Post-rejoin confirmed repeat checks three ready fixtures with
zero changes, preservation, unloading or instability. Native civilian travel remains pending.
Earlier first combined run fails three obsolete planner/timer expectations; corrected tests
also check legacy fixture reproducibility, timer identity and zero unconfigured-timer effects.
Only tests changed between that failed run and the fresh all-green run.

Previous completed verification (2026-11-05): `roof-anchored-columns-verify.log`, **1,499/1,499** tests,
zero failures/cancellations/skips, all five gates, **52/52** headless stages, exit 0.
Includes opt-in anchored-column preservation, actual production hall connectivity/headroom,
read-only/default refusal, required-joist barrier, changed anchors after interruption, restart,
idempotence and released leases. Nine focused roof tests and strict typecheck pass.
Deployed 134 SHA-identical files while closed. Native preview accepts the restored hall fixture;
confirmed migration changes 1,367 supports, retains one anchored unknown birch column and clears
the entrance. A Creative collision-checked interior position succeeds. The restored original
lantern becomes AIR after support removal; durable fixture migration is under verification.
The new civilian travel trial passes 63 focused tests, runtime-boundary checks and strict TSC,
but is not yet deployed or tested with native villager AI. Full combined verification is pending.

Previous completed verification (2026-11-05): `shared-boundary-verify.log`, **1,492/1,492** tests,
zero failures/cancellations/skips, all five gates, **52/52** headless stages, exit 0.
Adds exact integer boundary geometry, independent per-neighbor final wall provenance, later-stage
and third-neighbor vetoes, interrupted proof/clear-before-placement restart, exact wall restoration,
foreign/persistent preservation and missing/mismatched dimension refusal. 41 focused tests pass.
Deployed 133 SHA-identical files while the world was closed; native acceptance is pending.

Previous completed verification (2026-11-05): `shared-margin-verify.log`, **1,469/1,469** tests,
zero failures/cancellations/skips, all five gates, **52/52** headless stages, exit 0.
Includes 15 additional production proof/compiler/command regressions for maintenance-only exact
wall targets, verified completed neighbors, historical planting vetoes, strict fresh adjacency,
interrupted-proof protection changes and unchanged ordinary-construction guards. Native read-only
inspection in the isolated restored CA Shared Margin Nov5 copy preserves the whole Saltmere tree:
oak_log (-220,88,-595) remains protected and outside the exact wall-target permission.
388 cells surveyed, 76 logs, 249 leaves; no blocks/plans/progress changed and holds released.
No new-policy repair yet. Closed pre-support backup `shared-margin-readonly-preserved-20261105`
has level.dat 3,069 bytes, Nov 5 00:16:42, SHA256
`14cc3d1109eca6deda95a147e5b9b153e98b6bc18d757920d12709220369cd62`.

Previous completed verification (2026-11-04 19:11:10): `tree-boundary-diagnostic-verify.log`, **1,454/1,454**
tests, zero failures/cancellations/skips, all five gates, **52/52** headless stages, exit 0.
Includes the notification changes, read-only final-wall audit, construction-lease recovery,
failed-chunk continuation, independent wall/doorway maintenance and foreign-block preservation.
The tree-refusal cache regression fails before correction and passes afterward; the full run
includes it. Unchanged trees retain refusal caching, successful neighbor erasure invalidates it,
and the original 4,000-cell cap and chest preservation still apply. Earlier results below are history.
The exact protected/bounded-clearance log diagnostic is included, with two additional regressions
proving inspection and construction refuse identically without block/state/property/queue changes.

Native Minecraft 26.62: Ashfall's audit first finds 14 air and 316 tree-occupied wall targets.
Guarded maintenance restores 330 blocks with zero failed writes. Repeat audit reads 20,404
matching targets, zero air, zero tree, 61 other occupied, 3,598 protected/not read and zero unloaded.
All four gates pass again and restore their prior states. Closed backup:
`branch-walls-audited-gates-passed-20261104`. Saltmere's first audit finds 39,586 targets:
29,176 readable, 27,840 present, zero air, 88 tree-occupied, 1,248 other occupied, 10,410 protected
and zero unloaded. Guarded Saltmere maintenance restores three blocks with no failed writes;
the repeat wall audit confirms all wall counters unchanged. Exact native tree proof refuses
a trunk/branch crossing protected clearance (379 cells, 76 logs, 249 leaves). All three Saltmere
gate references pass afterward and restore their prior open states.
These ID-only checks do not prove block states, foundations or player walking.

The completed five-district pass reads all eligible wall targets with zero air gaps and zero
unloaded targets. Hearthgate retains 195 tree targets, Saltmere 88 and Ironquarry one; Whitethorn
and Ashfall retain none. Other occupied/protected targets stay preserved. All 13 canonical gate
references controlling 14 physical gatehouses pass close/sealed/reopen/passable, including
paired passages. Each single passage has six sealed and six open engine-block crossing checks;
paired 5–1 has twelve per phase. This is not manual walking. Closed checkpoint:
`branch-all-walls-audited-all-gates-passed-20261104` (Nov 4 19:21:58).
The 132-file verified diagnostic pack deploys while closed; native rejoin and exact Saltmere
protected-log output pass, naming oak_log at (-221,89,-594) without clearing the component.

The earlier notification-only change passes all 10 chronicle tests, strict typechecking and
1,173 manifest/package checks. It suppresses only the routine survey-bound and empty-evacuation
chat notices, preserving the log and other event types. The 132-file installation is SHA-identical.
Native hours 363–365 retain battle, construction and returning-refugee reports; status at step 364
still contains the survey-limit log. Hospital clearance at (-222.5,66,-512.5) also passes. Closed
backup: `branch-repair-alerts-native-passed-20261104`. The 1,446-test full run predates this small change.

Earlier rooted-tree checkpoint (2026-11-04): the leaf-linked forest reproduction fails under the old
traversal and passes under the rooted-log revision. Six focused checks and nine recovery checks
pass with zero failures, including protected builds, unreadable cells, cross-chunk loading,
an eight-crash sweep and a two-crash neighboring-district build. Strict typechecking passes.
The 132-file SHA-identical development installation resumes CA Branch Clearance Nov3's exact
queue past the previously blocked jungle-leaf gate at (-219,70,-374), completes gates and enters
roads/lots, then completes all 52,258 operations without another watchdog shutdown. All four
Ashfall gate tests pass all phases, including the paired passages. Full verification passes
1,440 tests, zero failures/cancellations/skips, five gates and 52/52 e2e stages, exit 0
(`rooted-tree-verify.log`, Nov 4 00:28:59). Closed backup:
`branch-rooted-clearance-complete-gates-20261104` (Nov 4 00:30:45). Rejoin succeeds.
Blocked doors, earlier skipped wall sections and full native city acceptance remain pending.

Fresh live tests: Minecraft **26.60** on 2026-11-02–03, using an imported city copy and a separate **CA Authoring 2026-11-02** world. Ledger recovery, use, Military/recruitment, construction resume/stop and restart persistence passed. Gate-link repair succeeded on the old copy; its physical test preserved a jungle-log obstruction. Fresh Hearthgate completed 75,588 operations after live abort/rejoin/resume and removal of nine melons at an obstructed gatehouse. Ironquarry completed 75,400 operations after shoreline-plant and construction-loading fixes. Whitethorn completed 65,847 after an 87,892-column survey and a Ledger resume past the corrected kelp classification. Its new sparse lighting was inspected by day and night. The distant gate pair passes close/sealed/reopen/passable checks using automatic temporary loading, with no manual area. All 1,397 automated tests and five verification gates passed through the natural lighting, survey-loading and kelp revisions. See `docs/PROGRESS.md` for exact evidence.

Historical template-import attempts initially failed with a generic error, including separate UUID and ZIP probes. A later diagnostic template with corrected headers imports and creates a world successfully, as recorded in the current checkpoint. The production archive remains stale and the parity gate refuses it. Release remains blocked pending clean authoring-state export, spawn, independent-baseline and save/rejoin checks.

Subsequent coastal validation supersedes geometry acceptance of the completed authoring records:
native topmost-block reads returned the solid seabed beneath water, and the former reader treated
that as dry land. The corrected reader passes at the same native coordinates (surface 62, bed 51),
and new coastal gate plans use dry floors with measured bed-supported foundations. The complete
corrective run passes **1,403 tests**, zero failures/skips, all five gates and 52/52 e2e stages
(`dist/verification-20261102/coastal-complete-verify.log`). The prior authoring world is preserved;
**CA Surface Test 2026-11-03** is testing a fresh corrected build on the same terrain seed.
That world's read-only site check identified unrecognized smooth-basalt beds. At native
(-171,-797), the corrected support-only classification now returns water surface 62 and bed 25;
smooth basalt remains protected from terrain cutting/clearing. Latest verification passes
**1,405 tests**, zero failures/skips, all five gates and 52/52 e2e stages
(`dist/verification-20261102/basalt-bed-verify.log`). The restarted native city build is pending.
The next native probe identified submerged chiseled stone bricks, which now classify as
known protected `blocked` terrain rather than unread water beds. The same-coordinate native
retest passes. Full follow-up verification passes **1,406 tests**, zero failures/skips, all
five gates and 52/52 e2e stages (`dist/verification-20261102/submerged-obstruction-verify.log`).

After deploying, **Save & Quit and re-enter** the test world. `/reload` is not a dependable script-reload verification path for these changes. The installed development pack can override an embedded pack with the same UUID/version.

## Supported indoor fixtures and civilian travel (2026-11-05, native checks pending)

On a backed-up completed authoring district, preview only the preserved command hall:
`/scriptevent civ:interior_lights district=1 building=building-d1-command_hall-1`.
After its guards pass, append `confirm`. Check the same fixture count, exact support and hanging
state, two-tick stability, clear entrance, repeat with zero writes, then save/rejoin and repeat.
For the frozen Hearthgate hall, the old carpet lantern at (19,69,-544) moves onto the existing
council table at (21,69,-544). Unknown birch and furniture must stay. A later
`roof_support district=1 keep_columns confirm` must retain that verified fixture and write nothing.

The first travel trial is deliberately session-only and moves one already-admitted civilian.
Enable the existing people layer, wait for streets reconciliation, then inspect
`/scriptevent civ:people travel status`. Choose a real loaded, flat, straight, clear route of
1–24 blocks, using integer block X/Z and standing/foot Y for both endpoints. Start with
`/scriptevent civ:people travel start district=1 group=0 home=X,Y,Z farm=X,Y,Z`.
For a villager that keeps moving before those coordinates can be entered, use
`/scriptevent civ:people travel inspect district=1 group=0` to read the unique admitted
actor's ID and current feet without moving it or probing blocks. Active travel status also
reports its current feet. Then use
`/scriptevent civ:people travel start-near district=1 group=0 length=4`.
`length` is optional (default 4, permitted 1–8). This captures that same existing actor in
the command turn, searches straight east/west/south/north prefixes, and selects the longest
safe prefix found, with that order breaking ties. The endpoints retain its fractional X/Z;
they are arbitrary trial endpoints, not proof of actual homes, fields or farming work.
Discovery and fresh final validation share a ceiling of 256 native block reads, including
braking an earlier trial. Discovery reserves 64 reads for the uncached final proof. Changed
identity/feet, unsafe footing, blocked headroom, unavailable chunks or exhausted budget refuse
setup. No chunk holds, blocks, entities, tags or production are created by route discovery.
Verify that setup itself leaves the representative at its existing feet, then observe
continuous movement; a successful setup alone is not a motion acceptance result.
The existing farmer routine controls direction; meal/shelter hours pause, work hours target farm,
and rest targets home. Verify continuous motion, both arrivals, unchanged canonical tag/count,
an obstruction/unload pause, `/scriptevent civ:people travel stop`, and off-after-rejoin.
Do not teleport the representative to manufacture success or count trial travel as food production.
This is not general navigation, hauling, physical evacuation or completion of civilian routines.

## Goal-pass test additions

Run `npm run verify` (manifest, typecheck, unit tests, end-to-end). New offline suites include
invasion-director, population-lod, population-sync, ledger-presenters, ledger-ui, civ-five-district (with the
golden Hearthgate pin). Run the template suites on their own: they share a folder and must not run concurrently with another run.

## The five gates

```bash
npm install      # typescript + @minecraft/server@2.7.0 types + @minecraft/common
npm run verify   # runs every gate, reports each one even if an earlier one fails
```

Current results: see `docs/PROGRESS.md` and `docs/ENLARGED_HEARTHGATE.md` (counts change as tests are added; run `npm run verify`). The older counts quoted elsewhere in this file are historical.

| Command | Gate | What it actually proves |
| --- | --- | --- |
| `npm run validate` | manifest + packaging | Manifest structure, real unique UUIDs, entry file exists, the `@minecraft/server` pin **equals the installed types version** (so the code cannot be checked against one API and shipped against another), every relative import carries a `.js` extension and resolves (a missing extension is a silent pack-load failure), no dev junk inside the pack root |
| `npm run typecheck` | strict `checkJs` | Every pack script is typed against the real 2.7.0 declarations: catches `initial` vs `initialSpawn`, `scriptEventReceived` vs `scriptEventReceive`, non-existent methods, implicit `any` |
| `npm run test` | 1307 unit tests (clean export of HEAD, 2026-10-30) | Simulation behaviour, save/migration, invariants, reporting text, argument parsing |
| `npm run e2e` | headless kingdom run | The whole gameplay sequence over a v1 save: migrate → peace → siege → evacuation → reinforcement → counterattack → victory → autonomous claim → shortage refusal → construction → recruitment → persistence → deterministic replay → readouts |
| `npm run template:validate` | starter-world template contract | `starter/template.json` against the real pack and planner: distinct, collide-free UUIDs, `world_template` module type, pack folder name ≤ 10 characters, `en_US` language, the keep/wipe prefix sets (the master plan must survive, `civ:kingdom-quarantine` must not), five unique districts with unique layout ids, and **no district marked `starterWorld` unless its enlarged layout is actually registered** - which is what stops an empty template being called finished |

Individual gates: `npm run validate`, `npm run typecheck`, `npm run test`.

Release tooling (not verify gates, because they are expected to differ): `npm run template:validate`
(passes - the contract is sound), `npm run template:release-check` (**exits 0 as of 2026-10-30**: all five
districts are physically built, receipted and packaged; it still refuses a district that is missing or
unreceipted, see `docs/STARTER_WORLD.md`), and `node dev/build-template.mjs --world <export> --receipt <receipt>`
which stages a development preview and refuses `--zip` until the release check would pass.

## What the gates cannot prove

- That the pack loads, that chat renders, that any event fires, or that blocks place. All of
  that needs the game.
- **Pure JS vs runtime boundary.** Everything under `scripts/sim/`, `scripts/kingdom/`,
  `scripts/ui/` and `scripts/commands/args.js` runs in Node and is covered. These files are
  the Bedrock boundary and are **only** typechecked:
  `main.js`, `events/welcome.js`, `commands/{status,inspect,debug,reply,civ,gates,physical,starter}.js`,
  `integration/{simulationLoop,buildAdapter}.js`. `integration.test.mjs` guards the split in
  both directions — the core must not import the runtime, and boundary files must. Most of them
  are nevertheless *driven* offline: `dev/test/reliability-runtime.test.mjs` delivers real
  scriptevents to the whole subscription set through a fake `@minecraft/server`, including the
  `civ:starter_arm confirm` path, so registration, refusal branches and dynamic-property writes
  are exercised - only the actual engine behaviour (chat rendering, block placement, chunk
  loading) is not.
- The rollback branch in `tick.advanceKingdomStep` (validator rejection and a throwing system)
  is covered by `dev/test/reliability-rollback.test.mjs` with injected faults.
- Saved-state size is asserted as a blob budget (peak ≈15 KB over 400 steps). In-game,
  `world.getDynamicPropertyTotalByteCount()` is the instrument.

## Proving the typecheck gate is still live

A green typecheck means nothing if `checkJs` stopped reading the files. Verify it:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --listFiles | grep CivilizationApocalypse_BP   # must list every pack script
```

Then break something deliberately, re-run, restore, and re-run:

```bash
# in scripts/events/welcome.js: event.initialSpawn -> event.initial   (the old 1.x name)
# in scripts/kingdom/store.js:  getDynamicProperty -> getDynamicPropertyX
```

Expected (these are the errors this project actually produced when run):

```
welcome.js(12,20): error TS2339: Property 'initial' does not exist on type 'PlayerSpawnAfterEvent'.
store.js(15,28):  error TS2551: Property 'getDynamicPropertyX' does not exist on type 'World'. Did you mean 'getDynamicProperty'?
```

Restore from a copy (not `git checkout`) and confirm byte-identity with `cmp`.

## In-game manual test script

Requires a world with cheats enabled (needed for `/scriptevent`).

1. **Install** per `README.md`, add the pack as a **Behavior Pack** to a world.
2. **First join** — expect: `Welcome to the ruins. Civilization Apocalypse has been
   founded.` then `Civilization Apocalypse: 5 districts, 400 civilians, 150 soldiers.` and
   the hint to run `civ:status`.
3. `/scriptevent civ:status` — the header, `Districts: 5`, `Civilians: 400`,
   `Soldiers:  150`, five district lines, then `-- situation --` with the in-game day,
   policy, refugee count, districts under attack, territory and project counts.
4. `/scriptevent civ:district district-3` — full district card (security, integrity,
   garrison split, stores, buildings, neighbours, projects).
   `/scriptevent civ:district nope` must be **rejected** with the list of real ids.
5. `/scriptevent civ:territory` — the five border lands and their status.
6. `/scriptevent civ:policy` then `civ:policy paused`, then `civ:policy nonsense` (must be
   rejected). Restore with `civ:policy balanced`.
7. **Autonomy** — leave the world for a day of real play and return; `civ:status` should show
   the step counter advanced, projects scheduled, and the army replacing its losses.
8. **Persistence** — quit to title and rejoin. The greeting should read
   `Welcome back, <name>.` (proof it loaded a save instead of re-seeding) and the numbers
   must match what you left.
9. **Debug scenarios** — `/scriptevent civ:debug_help`, `civ:debug_scenarios`, then
   `civ:debug_scenario attack`. It must report a **dry run against a copy**; `civ:status`
   afterwards must be unchanged. `civ:debug_scenario expansion` on a healthy border should
   end `Districts: 5 -> 6` with the seven-project plan listed; add `--apply` to write it.
   `civ:debug_tick 5` advances five hours; `civ:debug_tick 0`, `civ:debug_tick abc` and
   `civ:debug_scenario not-a-scenario` must all be rejected.
10. **Physical build demo (opt-in, unverified by me)** —
    `/scriptevent civ:debug_build enable`, stand somewhere flat and empty,
    `civ:debug_build anchor <x y z>`, `civ:debug_build preview`, then
    `civ:debug_build run`. It should place a ring of blocks for the next unfinished stage,
    report `skipped ... is not air` rather than replacing anything, and report `chunk is not
    loaded` if you aim it at unloaded ground. `civ:debug_build disable` turns it off.
11. **Migration** — if you still have a world from the first release, the join greeting must
    say `Welcome back` and the totals must survive; a pre-migration copy is kept in the
    `civ:kingdom-quarantine` dynamic property.
12. **Starter arming (a build world only, see `docs/STARTER_WORLD.md`)** —
    `/scriptevent civ:starter_status` must list the keys that will be kept and wiped and, in an
    unfinished world, name the blocker (`never built`, `still under construction`, `job queue
    reads as 'corrupt'`, `plan cannot be read`). `civ:starter_arm` with no argument must write
    nothing. After the city is genuinely finished, `civ:starter_arm confirm` must reset
    `civ:status` to `5 districts / 400 civilians / 150 soldiers` while `civ:starter_verify`
    reports district 1 as built, the master plan as stored and no wipeable keys left. Running
    `civ:starter_arm confirm` a second time must be refused as `already armed`.

If the scripts fail to load at all, check the content log for the module version message and
follow the pin fix in `README.md` → Troubleshooting.

Gate-passage correction (2026-11-03): full verification passes 1,407 tests with zero failures or skips, strict typecheck, all five verification gates and 52/52 headless gameplay stages. See dist/verification-20261102/gate-passage-verify.log. The new runtime regression preserves a bookshelf obstruction, resumes through natural grass and confirms every gate remains open after later construction stages. Native generation acceptance is separate; consult PROGRESS.md for live gate repairs and tests.

Shared-gate and population follow-up (2026-11-03): the consolidated full run passes 1,412 tests with zero failures/skips, strict typecheck, all five gates and 52/52 headless stages (dist/verification-20261102/shared-gate-complete-verify.log). The boundary and gate-focused checks also pass 115/115. Native saved-plan recovery restored one shared-gate link; its test passed afterward without masonry removal. A later Whitethorn build preserved the existing shared gate without recovery; its new district gate and both outer gates also passed. Detailed evidence and remaining geometry acceptance are in PROGRESS.md.

Roof-bypass follow-up (2026-11-03): full verification passes 1,413 tests, zero failures/skips, all five gates and 52/52 headless stages (`dist/verification-20261102/gate-roof-verify.log`). The new test reproduces a raised deck crossing a closed gate's roof gaps on both axes; the guarded roof stops all six walker variants and preserves open passage. The native Saltmere 4-5 gate passes after an air-only 24-bar roof repair; shared 3-4 and outer 12 also pass. New guarded-plan generation still needs native acceptance. The template-header follow-up passes 21 focused tests (`template-header-focused.log`); its separate diagnostic candidate imports and creates/loads a world through Minecraft's template UI. It uses archived city data and is not a release baseline.

Shared-ground and template Ledger follow-up (2026-11-03): full verification passes 1,417 tests, zero failures/skips, all five gates and 52/52 headless stages (dist/verification-20261102/shared-ground-verify.log). The neighbor regression first failed with a shared gate shifted Y71 to Y78; frozen-ground reuse preserves its original height and prior blocks. Corrupt prior ground refuses before construction. Ledger join/recovery/off-override/full-inventory checks also pass. Native regeneration and automatic template join acceptance are still pending; see PROGRESS.md.

Later Nov 3 checkpoints supersede those native-pending statements: the separate template imports, automatically delivers one Ledger, opens its menu through item use and retains exactly one after rejoining. Ashfall's original-ground rebuild removes the stacked shared gatehouse; shared 4–5, paired 5–1 and outer 13/14 pass all four native gate-test phases, also after the survey-aware facility rebuild. Closed backups preserve each result. The first survey-aware run exposed one crash-recovery failure (1,418/1,419 passing). Exact pending tree-cell journaling then passes the full **1,422/1,422**, zero skips, five gates and 52/52 end-to-end stages (`tree-journal-verify.log`). Focused tests also preserve player changes during interrupted clearance. A later balanced-lot read-only preview and additional mid-clearance guards are under test; do not extend the 1,422 full-pass claim to unverified later changes. City acceptance remains blocked by garden/farm omissions and physical tours; see PROGRESS.md.

The subsequent balanced-default and final mid-clearance guard run also passes **1,422/1,422**,
zero failures/skips, all five gates and **52/52** end-to-end stages
(`dist/verification-20261102/balanced-siting-verify.log`). This verifies those later source changes.
The native read-only balanced preview retains chapel/school/hospital and restores five gardens
and two kitchen farms. Actual balanced construction and city/player-walk acceptance are separate
and remain pending in CA Balanced City Nov3; consult PROGRESS.md.

Paired-door follow-up (Nov 3): `paired-door-final-verify.log` passes **1,427/1,427**,
zero failures/skips, all five gates and 52/52 e2e stages. It verifies atomic lower-half native
placement, foreign-block protection, no orphan upper writes and idempotent saved-plan repair.
This run predates remote chunk leasing and the subsequent stable-API footing correction.
The native remote audit reaches all 41 pairs (38 present, three blocked, none unloaded), but
`testforblock` proves the first supposedly unsupported sill is polished andesite. `Block.isSolid`
is absent from stable API 2.7; the harness incorrectly supplied it. It has been removed from
the harness, and the production check now accepts a conservative known full-block floor list.
Four helper tests and two production-runtime regressions plus strict typecheck pass. The
loader-only full run was interrupted to fix this defect; current consolidated full run is
`paired-door-footing-verify.log`. Native repair with that correction is pending. Instantaneous
computer-use movement did not move the player, so actual walking is not claimed.

That consolidated door/remote-loading/API-footing source subsequently passes **1,428/1,428**,
zero failures/skips, all five gates and 52/52 e2e (`paired-door-footing-verify.log`). Native
repair reports 38 present, three placed, zero blocked/unloaded/failed. The school then exposes
an independent usability defect: the hip-roof support pass fills its entrance aisle with stone
pillars, reproduced in a clean seed-12 plan. New persisted `roofSupport: joists` keeps two-high
headroom and face-connected roof support while legacy checksums still rehydrate. Its pure test,
three production pipeline/door checks and strict typecheck pass. School-only saved-plan repair
also passes foreign-block preservation, read-only inspection, capacity refusal, remote holds,
interruption/resume and idempotence. That interruption test first caught a leaked lease when
engine job cancellation skipped inner-generator cleanup; the runner now closes it and settles
its caller. Eight prior abort/cancellation checks pass. Full roof/cancellation verification is
`school-roof-verify.log` subsequently finishes 1,429/1,430: one expected-plan comparison
omitted the new roof option. That fixture is corrected and its focused rerun passes.

Latest consolidated source checkpoint (Nov 3): `building-roof-verify.log` passes
**1,430/1,430 tests**, zero failures/cancellations/skips, all five gates and **52/52** e2e
stages, exit 0. This includes both support repair commands and cancellation cleanup. Native
school repair changes 360 blocks, passes player-sized clearance, survives rejoin and repeats
with zero changes. Ashfall-wide maintenance changes 489 additional support blocks and Saltmere
changes 461; neither reports preserved/unloaded buildings. Whitethorn changes 802, Ironquarry
changes 872 plus 92 on a successful nearby retry, and Hearthgate changes 716 while preserving
one command hall with an unexpected birch log. The diagnostics-source consolidated run also
passes all five gates, 1,430 tests and 52/52 stages (`roof-diagnostics-verify.log`). Ashfall and
Hearthgate repeat with zero further writes after rejoin. Native clearance checks do not
constitute keyboard walking acceptance.

Tree-boundary follow-up: an offline synthetic branch reproduces a cleared trunk with logs
left floating beyond the former horizontal reach of eight. New exact proofs support reach 16
while decoding old proofs unchanged; connected logs crossing the new limit or protected
clearance boundary refuse before removal. The first wider loader run exposed a stale apron
check, a dense-restart leaf difference and excessive chunk churn. Final source re-evaluates
changing boundary verdicts, requests wide holds only for tree operations, and retains overlapping
chunks when moving a lease. Four construction regressions pass unchanged reuse/read budgets,
fragmented loading, cancellation and eight-crash final-world equivalence. Fourteen branch,
legacy/new-proof and lease tests pass; strict typecheck passes. Full consolidated verification
is running in `tree-branch-verify.log`, with runtime source frozen. All 132 installed pack
files match the new source. A separate imported D4-checkpoint copy, **CA Branch Clearance Nov3**
(`57+p8n4Au6E=`), is now generating district 5 with seed 1. Native acceptance is pending.

That first full tree run finishes **1,434/1,436**: both failures are gate messages losing the
bookshelf cause when nearby preserved leaves obstruct first. All other gates and 52/52 e2e
pass. The cache/message correction passes both existing preservation/resume regressions
unchanged and strict typecheck. Latest consolidated run: `tree-branch-final-verify.log`,
pending. The message correction awaits deployment after the active native build closes;
do not describe the first full tree run as all green.

The corrected tree run subsequently passes **1,436/1,436**, zero failures/skips, five gates
and 52/52 e2e (`tree-branch-final-verify.log`, exit 0). Native construction nevertheless
terminates with a scripting watchdog at 21:04:33; native acceptance is failed, not implied by
the offline result. Closed backup `branch-clearance-watchdog-20261103` preserves the failure.
Read-only backup journal/plan integrity checks identify the saved next clear operation at
(-209,68,-541), 361/52,258 operations done, no pending proven-tree journal.
The next CPU-work cap meters at most 32 visited tree cells between yields independently of
cached versus actual block reads. Three focused CPU-bound/reuse/dense-crash checks and strict
typecheck pass; the 132-file candidate is deployed SHA-identically with the world closed.
The native saved queue is being resumed. Full verification of this last cap remains pending.

That CPU-budget full run completes Nov 3 at 21:40: `tree-cpu-budget-verify.log`, **1,437/1,437**
tests, zero failures/cancellations/skips, five passing gates and **52/52** headless stages,
exit 0. The native retry passes the prior 361-operation crash point and reaches 2.7% in the
latest observed status. Diagnostics report no session error, loaded construction chunks and
storage within budget. Full native construction and watchdog acceptance remain pending.

That native retry later pauses safely at **2,061/52,258 operations** (3.9%), on a tree read
needed for operation (-303,63,-492). Closed backup `branch-clearance-loading-paused-20261103`
preserves the queue and plan checksum fa4d47e1, with no pending proven-tree transaction.
The diagnostic follow-up reports an unreadable tree cell's exact coordinate, engine error and
held bounds. Its new preservation/pause/resume regression and two existing CPU-budget and
unloaded-final-world-equivalence regressions pass (3/3), along with strict typecheck
(`tree-unread-diagnostics-focused.log`). All 132 installed files match that source.
Native retry passes the prior unreadable operation and reaches 4.0% after world reload and
hold reacquisition. No cause or automatic loading fix is established from this partial result.

`tree-unread-diagnostics-verify.log` finishes Nov 3 23:37:12 with **1,438/1,438 tests**, zero
failures/cancellations/skips, five gates and **52/52** e2e, exit 0. Native retry finishes
clearing and is deliberately stopped in walls at **16,419/52,258 operations** to install a
profile-guided protection cache. Closed backup: `branch-before-protected-cache-20261103`,
level.dat saved 23:41:57. The stopped native CPU capture records about 48.9% inclusive time in
protection geometry; this does not establish the earlier watchdog's cause. New session-local
column caching preserves the old predicate and bounded memory. Seven focused boundary,
neighbor protection, chunk reuse, unread recovery, CPU-bound and crash-equivalence checks pass
(`protected-columns-focused.log`, `protected-columns-recovery.log`), as does strict typecheck.
Latest 132 files are deployed SHA-identically. `protected-columns-verify.log` is running;
native performance and completed construction remain pending.

The installed cache-source full run, `protected-columns-verify.log`, completes **23:53:32**:
**1,439/1,439 tests**, zero failures/cancellations/skips, five gates, **52/52** e2e, exit 0.
Native resume reaches **47.4%**. A second stopped CPU capture at 23:51:24 contains zero sampled
protection-geometry time; block reads are now its largest cost (50.8%). These are different
construction samples, not a controlled overall speed comparison. The raw captures and summaries
are preserved under `dist/verification-20261102`. Full native construction remains pending.
