# Distant diplomacy and Ledger — staged vertical slice

This is proposed development only. No active BP/RP, world, native UI, timer,
population owner or installed build was changed by this agent. The 13 promotion
paths are frozen in `PROMOTION-HASHES.json`; `proposed.patch` is the normalized
review diff. Existing targets still match `BEFORE.json` byte hashes.

## Playable behavior proposed

The ordinary Diplomacy page can send scouts through the existing confirmation and
private-copy save boundary. An expedition costs 6 food and 2 supplies from secure
headquarters. Twelve accepted kingdom hours later, scouts return a neutral contact.
An envoy takes 18 hours, improves relations by up to 25 and refreshes the report.
At relations 50, an alliance proposal takes 24 hours and rechecks the recipient's
actual defenses and forces when it arrives; a strained realm can decline.

Only one expedition may travel at a time across all players. Each confirmed action
rechecks current reserves, home security, mission occupancy and target identity.
Save failure commits neither the debit nor the mission. The existing kingdom step
advances missions transactionally, and its ordinary log receives returning reports.
No additional timer, store, command bypass, native event subscription or actor is
added. The existing Ledger access and confirmation rules remain the authority;
this does not establish native multiplayer permission acceptance.

At most three reported distant realms have bounded civilian/defense/food state.
Their deterministic daily growth, zombie pressure and recovery run only on that
same accepted hour, without consuming the home kingdom's random sequence. The
Ledger displays the last received report and its age, not hidden current foreign
population, troop or defense values. Returning missions refresh that news.

The defaults Alderwatch/north, Sunmere/southeast and Stonehaven/west, mission fees,
durations, relations and distant pressure rules are reasonable procedural design
choices for review, not previously confirmed user constants. The requested neutral
starting relations are preserved. There are no coordinates or claims of surveyed,
explorable physical settlements: the interface says sites/routes are not yet
surveyed. Trade and routed assistance remain disabled. An alliance grants no
instant home soldiers, resources or teleported reinforcements.

## Saved-state migration

This proposes schema **3**, with registered v1→2→3 and v2→3 paths. The v2 upgrade
retains every existing record by spreading it and adds an empty version1 diplomacy
record; districts, city geometry, construction queues, physical records, starter
metadata and other fields are not reconstructed. New saves still begin with the
same five districts, 400 civilians and 150 soldiers. The constructor retains its
historical `createV2Kingdom` export name for compatibility while producing the
current format; the registered v1 migration explicitly returns intermediate v2.

An unexpected diplomacy extension already present in a legacy save is refused for
explicit migration, never overwritten. A future schema or nested diplomacy version
is preserved by load, ensureInitial and direct save guards. The proposed current
record validator bounds identity, population, reports, mission kinds/deadlines,
target membership and clock values. A new-schema save cannot be loaded by the old
schema2 build; restoring a pre-upgrade backup is necessary for rollback.

## Exact validation

- New focused cases: **30/30 PASS**, 162.5836ms, `focused-final.log`.
- Existing core/store/runtime/rollback/Ledger suites plus the new cases:
  **222/222 PASS**, zero failed/cancelled/skipped, 835.823ms,
  `compatibility-final.log`. This includes the existing 200-day storage budget test.
- Strict copied-runtime typecheck: **exit0**, `typecheck-final.log`, with the
  unchanged strict project configuration in `runtime/tsconfig.json`.

Three existing test files have narrowly reviewed contract updates: the expected
schema uses the current constant, old v1 migrations expect the current format,
future-version fixtures use current+1, and the obsolete wholly-disabled diplomacy
assertion now checks actual confirmed scouting while physical trade/assistance
remain unavailable. All unrelated assertions remain. No test flags were relaxed.

The initial logs are retained. First19 cases had two failures: an invalid synthetic
city fixture and a line-wrapped confirmation expectation. The first real runtime
form tests expected the model word `confirm` instead of the harness's actual
MessageFormData kind `message`; only that test selector was corrected. The initial
compatibility run passed199/201; its two failures were the old expected schema2
literal and obsolete disabled-diplomacy contract. Initial strict typecheck found
one missing union property, fixed with explicit narrowing. These historical runs
are not passing evidence.

## Remaining acceptance and roadmap scope

Root review, central five-gate verification/template checks, backed-up closed
deployment and native Ledger/travel/rejoin/multiplayer checks are still required.
No native UI or distant gameplay acceptance is inherited from these fake-runtime
tests. This is one complete simulated diplomacy interaction slice, **not completion
of roadmap step8**. Physical settlement generation/spacing, exploration encounters,
real envoys, trade, route-aware aid with travel and visible arrival, territory loss
and recovery, human conflict and peace still need implementation and acceptance.
