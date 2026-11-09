# Highest-value bounded offline follow-up

## P2 — An open Ledger confirmation bypasses a revoked live gate

Current production `ledger/runtime.js` reads `gateIsOpen()` for item use, recovery and automatic item granting. `onResponse`, `showModel`, busy retry and `execute` do not recheck it. `integration/ledgerBindings.js` supplies the actual live `ledgerEnabled(kingdomStore)` callback; `ledger/devgate.js` makes an explicit false override win, including in an armed template.

Concrete player sequence: open Military → Recruit in Hearthgate → an operator switches Ledger OFF while the confirmation is open → confirm Recruit. Production runtime still saves recruitment: trainingQueue2 and civilians78 instead of preserving the original state. Current gate-ON control saves once as expected; the revoked-gate desired-contract repro fails because it ALSO saves once. This is an in-flight usability/permission-control gap, not evidence of untrusted native port races or a new actor owner.

Exact reproducible file `ledger-gate-revocation.test.mjs` imports ACTUAL production runtime and the existing SDK-shaped Ledger harness. Results:2cases,1controlPASS,1requiredFAIL. No source, world, gate or installed pack changed. A synthetic callback revokes the dependency at the confirmation response boundary, modeling an ordinary gate change while a form is open. The offline harness has no actual Minecraft UI, so this is production callback proof, not native visual acceptance.

### Bounded next implementation

Revalidate live gate before processing each form response and before starting a confirmed action, and refuse/close the session with the existing switched-off message. Guard deferred show/retry so a revoked gate cannot keep reopening forms. Keep normal enabled flow, shared services, confirmation structure, one session/player and saved-state revalidation. Preserve closed gate's no-item/no-recovery behavior and existing registered-listener lifetime; no new permission system is needed. Mutations and physical follow-ups still require their existing fresh checks; do not silently undo a save or pretend a gate is an atomic native lock.

Focused regressions: revoke on a confirm→zero saves; unreadable gate→zero saves; revoke during busy retry→no further form; revoke then re-enable→explicit fresh open works; live-enabled control remains one save; cancel/leave/multiplayer session isolation unchanged. Exercise both kingdom-saving action and service-only action refusal BEFORE calling the service. Actual same callback source paths, no copied production runtime in central tests. Existing Ledger suite is small enough for the next gated verification; no full planner needed for the staged fix.

### Priority

This is the top actionable item. It uses existing architecture, has a concrete failed production callback, and needs one narrow module change plus focused tests. I did not identify a second equally justified offline defect in the sampled civilian-travel/military/diplomacy paths. Saved-route movement and allied physical assistance remain larger unimplemented/native-gated work, not reasons to invent a second quick fix. This was targeted sampling, not complete review of those systems.
