# One-tick correction microtrial — staging only

This is a narrow opt-in comparison after the native four-tick WORK trace reached
one at-farm sample, drifted onward, and safely paused outside the corridor. That
observation does not establish an AI cause or prove this candidate will fix it.

Three production proposals: the same main timer runs every tick; the driver
continues to correct at four-tick cadence unless a successful explicit
`start-near district=1 group=19 length=1 cadence=1` requests one tick. The optional
suffix is accepted nowhere else. No second timer or owner is added. Default
command results, status, trace and native control sequences retain parity.

The braking horizon stays `TRAVEL_LIMITS.interval=4`. Desired speed 0.04, impulse
cap 0.3, arrival 0.15, corridor tolerance 0.75, exact safe footing and two AIR
body cells are unchanged. All setup/late identity/feet/gate/maintenance guards
and the shared 256-read limit remain. No movement component lease, block edits,
loading, teleport, spawning, persistence or food credit is introduced. Stop and
rejoin turn the session off; a later ordinary setup uses cadence four. Only the
opt-in session adds status/trace labels for cadence one and horizon four.

23 focused tests pass in 473.8199 ms; strict isolated whole-BP typecheck passes.
Tests import the actual proposed production files at their default paths in an
isolated copied tree. The frozen installed controller is used only for exact
parity comparison. Tests cover six default scenarios, per-tick opt-in callbacks,
unchanged near-arrival horizon and geometry, shared read caps, obstruction,
unload, duplicate/replacement, late velocity-getter races and cancellation,
bounded trace, stop/rejoin-off and one timer authority. No full or native gate
is inherited. The initial typecheck failure and its annotation-only fix remain
recorded. See `PROMOTION-HASHES.json` for exact source pins and five targets.

After root review and central/full/deploy gates, inspect the existing admitted
actor first. During a WORK hour on a naturally safe loaded one-block corridor,
start the explicit cadence option, capture trace promptly, then stop. Require
same-ID trace, controlled arrival without an outside-corridor exit, continued
fresh safety checks and a clean closed log; then separately test controlled
return/unload. No NPC relocation or assumed success. Active opt-in callbacks
may perform four times the prior per-second census/probe work: the per-callback
256-read bound is unchanged, not a performance acceptance claim.
