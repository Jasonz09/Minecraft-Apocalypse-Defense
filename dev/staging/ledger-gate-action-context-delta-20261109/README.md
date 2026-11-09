# Corrected action-context boundary — separate Ledger delta

OriginalCC218 stage and independent9-case7PASS2FAIL repro/log are preserved. This NEW overlay overrides only its proposed runtime and central test file. No active source/test, world, UI or installation edits.

The context is now assembled BEFORE the last live access check immediately before `runAction`. A `deps.services` getter which revokes access therefore cannot call the confirmed service. After an action returns with access closed, neutral wording says it was ATTEMPTED and asks the player to check status; it does not assert that a failed/throwing service actually performed a mutation. Completed-save wording and paused physical follow-up remain as before. No rollback, retry, new timer, subscription, session owner or atomic permission-lock claim.

Actual source-relative central tests:15new cases (previous13 +2peer-derived service regressions) plus33existing Ledger UI=48/48PASS207.636ms. Strict24pure-source closure0diagnostics. Independent peer's exact9tests also pass111.9918ms against this candidate using their documented source override; these overlap the central suite and are NOT nine additional unique features/tests. This is an author retest; peer independent signoff still required.

The last access check cannot make arbitrary native services/getters/setters atomic. A service already running can close access or partially mutate state; it is not undone or falsely labeled never-run. Existing source/action/service checks remain responsible for their native operations. Current change addresses the two exact independently reproduced callback boundaries only. Native visual acceptance and parent promotion/full gate remain separate.
