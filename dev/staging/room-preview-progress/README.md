# Room census progress — integrated / verified / installed162

Root integrated the three reviewed production paths, the new10-case test and
before-module fixture. All5 copied bytes match EXECUTION-HASHES.json. The existing
34-case room test harness now injects the real progress helper and clock; its
assertions are unchanged. Central focused44/44PASS203.3461ms and strict mainTSC pass.
Source162 nowpasses1,984tests/all5gates/52headless, full546,438.3573ms,exit0.
Closed-deployed01:26:27.842UTC nonce98c28527; previous161pairretained.
Root324source/installedSHAchecks+exactinventoriesPASS. Nativeprogresspending. See
`dist/room-progress-independent-review-20261106.json` and
`dist/room-progress-central-verify-20261106.log`.

## Historical authoring checkpoint

All files remain under this staging directory. No production edit, promotion,
install, generator, tests or typecheck was executed while Minecraft native tests
are open. The installed baseline is the reviewed 161-file / 1,974-test revision.
`AUTHORING-HASHES.json` records three proposed production paths, one new test and
one exact before-module fixture. `proposed.patch` contains the production diff.

This adds visibility, not a speed optimization: every existing source/player/job
check, getter bracket, cell yield and final-result barrier remains. No memoization
or source audit is removed. The exact final census data and formatter are intended
to remain unchanged; the added progress itself is always labeled unfinished.

A command-local helper emits at most 16 progress messages: at most 8 for saved
source validation, 2 for planned-cell indexing and 6 for native cell counts.
Source counters are reported every 512 completed generator slices, planned ops
every 3,200 operations and native counts every 64 cells plus the final count.
Within a phase messages are at least 200 existing system ticks apart; a phase
transition may be announced immediately. No percentage or promised remaining
runtime is inferred. Invalid clocks skip progress, not source checks.

Every tick read and send is bracketed with the SAME full current guard. Reentry
marks the helper invalid and rejects the outer callback. Cancellation/source or
player changes after reply refuse further work/result publication. Small primitive
counters and no snapshots/native handles are retained. It uses the existing job
and timer; there are no new writes, leases, intervals, entities or receipts.

Ten tests are authored but UNRUN: message/time/phase caps, invalid inputs, source
and cancellation races around reply/tick getter, send reentry, exact 475-cell result,
formatter/native-read/yield parity with the frozen previous module, progress
callback invalidation at cells64 and475, and retained production command barriers.
The next closed window needs focused execution and strict isolated typecheck;
root review, central/full/deploy/native gates follow. Do not treat authored cases
as passing evidence.

Current movement scope is separate: root reports the native cadence-one HOME
trial failed to hold its corridor; the cadence-one WORK-hour trial is pending.
The earlier four-tick WORK trace reached one at-farm sample then overshot. This
progress proposal neither changes nor accepts movement. Another agent owns the
movement artifact; it is not rewritten here.

## Closed-window independent validation (staging only)

Original AUTHORING-HASHES retained. Initial9/10PASS1FAIL151.0038ms: exact staticerrorlabel drift, notescaping. Baselineimport/full475result+nativegetter/yieldparity passedbeforechange. Corrected ONLY newtest expectedliteral to actualunchangedguard; beforetest/loaderbytes and initiallog retained. Final10/10PASS152.3845ms,0fail/cancel/skip; strictisolatedTSCexit0. All161activeBP/RP hashes/inventory before=after. See EXECUTION-HASHES.json for final5filepins and sourcechecks. No promotion/full/install/nativeproof. Progress is not speedoptimization or guaranteed heartbeat after its boundedsourcecap is exhausted.
