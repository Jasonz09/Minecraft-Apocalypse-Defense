# Existing-owner encounter evidence — first bounded candidate

STAGING ONLY. No active source, native test or aggregate casualty authority.

The existing siege owner tops up its loaded band from simulation demand; its tags identify a district, not a specific issued wave. Existing war.resolveAssault already debits assault/soldiers, and population sol representatives cover up to5 people. Therefore a visible kill or missing census cannot safely debit aggregate counts. This proposal records observations without changing those policies.

Use one bounded, versioned metadata journal (maximum24 issued actors,8waves,<=8192UTF8bytes). Every entry originates ONLY from the exact handle returned by existing spawnOne after both expected tags succeed, bound to the current wave ID/district/step. Never adopt an old tag census. Native birth before evidence-save crash stays untracked; it is not a new spawn permission. The existing owner remains the only writer of entities and still makes its normal top-up decisions.

Optional injected callbacks in staged siegeMobs and creationRuntime copies will observe birth, positively verified owner removal and fresh entityDie through the existing subscription. There is no new timer/listener/spawner. If evidence persistence fails, preserve a diagnostic HOLD and leave existing population/war arithmetic unchanged. Query absence/unload produces no terminal event. Wave rollover cannot relabel an actor's original wave; stale/mismatched live-wave observation must hold rather than assign a death to the new battle. Event replay and save/restart are idempotent by exact bound actor ID+type+district+wave.

First metadata-only reducer returns advisory counts with humanCasualtyDebit0/aggregateDelta0. It cannot lower assault, soldiers, food, integrity or resource fees, cannot grant replacement, and cannot open a wall. Caps/corruption/future format/changed raw refuse; no clearing/overwrite recovery. Gate-off/owner-remove are distinct terminal reasons from death.

Required initial repros: current owner refills one removed representative without any casualty input; current war resolves aggregate losses with zero native events; naïve one-kill-one-soldier conflicts with groupSize.sol5 and partial-tail groups. These are missing-authority evidence, not bugs to fix by adding a debit.

Before any integration: independently review exact staged hook boundaries and default-disabled parity; typecheck; prove metadata writes use only the one new journal key; actual same-owner fake-world crash/duplicate/unload/rejoin and real native managed-contact tests. A later explicit transaction design must reconcile simulation and physical outcome modes before any aggregate debit; this stage cannot quietly become that authority.
