# Fixed cavalry native gate — root execution only

Plan, not executed proof. Only the NEW root-approved fixed fixture cavalry-pad-fixed-20261109-b61e / epoch cavalry-owner-c69474372d104b22a33e1f5af93ef748. Preserve both halted c739e1b4 snapshots forever; never retry, reset, migrate or remove them. Use only independently reviewed fixed bundle after ALL central gates pass and guarded closed-game installation. New world label CA Cavalry Fixed Nov8 b61e; verify the actual final setup receipt/catalog folder before opening.

## 1. Activation and load gate — people must never have been ON

Keep the prepared observer outside the native four-block clearance radius (the existing pad spectator position8.5,307,8.5 is suitable). Do not move an NPC, change pad geometry, advance clocks or set arbitrary properties. Before first activation do NOT send people off: the pristine admission contract expects only initial kingdom plus devgate, and creating a new gate property is not part of that exact fresh state.

Use existing commands, one at a time:

    /scriptevent civ:generate_devgate on
    /scriptevent civ:people creation status

Initial-spawn activation may already have completed only if the developer flag existed. Otherwise, after verifying pending status and people remaining OFF:

    /scriptevent civ:people creation fresh confirm
    /scriptevent civ:people creation status
    /scriptevent civ:people status

Require fresh history,0issuedgroups,pendingissuance none; no held/error, no activated v2 fallback. DO NOT repeat fresh confirm on completed activation. Stop on any refused/partial activation; no clock reset or new epoch in the same world.

SAVE & QUIT, close Minecraft, hash-backup the closed world and inspect the ENTIRE current-session content log BEFORE people ON. Require zero mount/entity-schema load errors, ScriptExceptions and Molang errors. Pin all warnings rather than silently ignoring them. Closed receipt audit must prove this new v3 epoch/fixture and complete activation, issued0, no role/birth record, and people never ON. Schema repair static tests do not replace this native load gate.

Reopen this SAME activated copy. Creation status must remain complete fresh0/pendingnone before ON. Keep the original immutable vanilla-pad source untouched. If loader errors persist, quit/preserve/restore regularNULL; do not enable people.

## 2. Four minimum normal owner passes — no fast-forward command

    /scriptevent civ:people on
    /scriptevent civ:people status
    /scriptevent civ:people inspect group=district-1:sol:0

Use people status streets hour counter to identify each actual accepted pass (ordinary cadence1000ticks per simulated hour). Do not confuse elapsed UI time, worldtime, or teardown count with an accepted owner pass. Wait normal existing scheduler; do not summon or step an alternate owner. First successful four passes should be:

1. Reservation: durable compound epoch/newgeneration, rider never/noID, mount never/noID. This is metadata-only, NOT a birth. First reserve reports waiting; distinguish the expected reservation reason from unrelated global owner refusal.
2. Rider birth: durable rider alive with NEW recorded actualID R; mount never. Existing inspector reports metadata-only while incomplete. Supplementary loaded selector below may show rider presence but cannot prove unloaded absence or final two-way seating.
3. Mount birth: riderID stays R, durable mount alive with NEW recorded actualID M; both loaded role queries exact1. Before seating both-side-unseated NO is valid. Record bothIDs and fresh typed identities rather than inventing IDs.
4. Seating: SAME R/M; inspector prints rider R riding.entityRidingOn=M AND Mount M getRiders=[R], Two-way seating observed:YES. No manual /ride, NPCtp, healing, extra actors or patched metadata may produce this result.

Inspect after EVERY pass using the same existing command. Corroborating read-only loaded-presence queries:

    /testfor @e[type=civ_trial:cavalry,tag="civpop:v1:district-1:sol:0"]
    /testfor @e[type=civ_trial:cavalry_mount]

These selectors are supplemental only: loaded presence is not durable uniqueness; no-targets is not death. Binding ledger+known IDs+bounded fresh role census+both relationship directions are the required proof. Inspector is non-atomic, so take another later sample with SAME R/M and YES. Native screenshot should show rider and horse together without occlusion; identity/seating read proof does not by itself accept model/animation quality.

## 3. Stop conditions and preservation

Immediately stop advancement/people activity and save/quit on: any new content load error, incomplete activation/issuance, unknown/duplicate/wrong-type role, foreign passenger, changed durable/native identity, clearance failure, quota refusal, owner exception, or unverified riding component. No reset/remove/reconcile command is authorized as a workaround. If safe to issue people off, record exactly when: it invokes normal same-owner teardown on later hours and may remove positively owned roles. OFF is NOT a passive pause for a persistence test; avoid it before save/rejoin proof. Save/quit is the preservation stop when cleanup would confound identity.

## 4. Rejoin, unload and lifecycle gates remain separate

After stable sameIDs+YES, save/quit with people stillON, close, pin world+wholelog+v3 receipt/cursor. Rejoin SAME copy and inspect BEFORE interpreting absence. Require durable R/M unchanged and, once both are loaded, exact two-wayYES without replacement. Repeat after a bounded observer-away/rejoin experiment only once baseline proof exists; do not lure/teleport actors or infer death from unload. Actor disappearance/unknown API must HOLD, never create a replacement merely from missing loaded census.

An explicit OFF cleanup test is a DIFFERENT recorded phase: only existing sole-owner positively verified role cleanup, original IDs/receipts preserved, no foreign actor removed. Native death acceptance is also separate and NOT required to fabricate in the first seat gate: only exact entityDie role+boundID evidence may retire that role. entityRemove/unload/missing is never death. No mount death or rider death in this increment has aggregate soldier/civilian casualty or resource/reinforcement authority. Do not claim siege, cavalry combat, casualty, retreat or whole-roadmap completion from one seated pair.

## Evidence per phase

Record build/freeze/bundle/setup receipts, exact visible world, creation status, actual owner counter/tick, durable epoch/generation, R/M IDs, both relationship fields, screenshots, whole-session error/warning counts, closed backupSHA and parsed durable journal after each stopped/rejoin gate. No invented native IDs, birth claims from metadata alone, or clean-release authority.
