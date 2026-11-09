# Cavalry owner composition — incremental foundation, staging only

Production/main packs, prior stages, worlds and Git branches were not edited. No timer, companion spawner, native call, class selection or cavalry asset was added to the running game. This stage composes real metadata and the EXISTING popSync single-owner path; compound native execution is deliberately still disabled.

## Implemented and working offline

* A fresh schema3 discriminated registry supports ordinary single-actor AND rider+mount records in the SAME exact issuance inventory. Single records support villager/golem/swordsman/archer; pair records keep their two distinct issued IDs/roles. This binding schema3 is separate from the kingdom schema3.
* The facade detects existing v2 and delegates to the exact byte-pinned archer+creation v2 core. Reads do not migrate or change any saved bytes. A cavalry request there explicitly refuses until a separately reviewed migration exists. Mixed/future namespaces, missing issued records and class/role conflicts hold. No silent v2 upgrade or epoch reset.
* Fresh v3 normal births use the same popSync implementation via a small removal-tag compatibility change. The store supplies its exact private v2/v3 birth tag on removal tickets; copied tickets refuse. Actual fake-world owner tests cover normal v3 birth, unloaded-survivor preservation, restart, positively verified LOD/gate-off removal, and birth/native-spawn/tag/cursor crash boundaries. Ordinary v2 still works without creating v3 keys.
* The actual LOD algorithm and reducer accept OPTIONAL validated physicalCost1/2 per group. Cost2 must fit both district8 and global24 before admission; no caps or fixed class mix are changed. Existing default decisions/counts stay identical. Weighted reports add admittedActorSlots, explicitly admission intent rather than a living census. The same popSync passes the optional cost callback to initial/replanning reducer calls; it creates no extra actor itself.
* Unified metadata also rejects cross-group actor-ID reuse before writing (including bad rollback), in addition to the prior cross-role guard. The old16 meaningful compound metadata safety/fault cases run against the new union registry.

## Exact validation

30/30 focused cases PASS219.548ms; strict copied-runtime root-option TypeScript exit0. These include16 compound fault regressions,8 mixed-store/admission checks and6 actual-owner adapter checks. Explicit exact-path Node loader only redirects the modified pure reducer/LOD. The fake-world movement of a previously hidden actor back inside the ordinary observation window is a test environment setup, not a production teleport. No native performance, mounted motion or real casualty proof is claimed.

Initial logs remain: one loader-relative dependency error, followed by two invalid test assumptions (an actor80blocks away is outside normal observation/removal windows; maxPhysicalPerDistrict1 also requires physicalFloorPerKind0). Source behavior was retained; tests now explicitly restore the observation-window setup and use a valid test config. One report-field TypeScript inference error was corrected with a precise optional-field type while preserving default runtime shape.

Run: node --import ./dev/staging/cavalry-owner-composition/register.mjs --test dev/staging/cavalry-owner-composition/unified.test.mjs dev/staging/cavalry-owner-composition/compound-regressions.test.mjs dev/staging/cavalry-owner-composition/same-owner.test.mjs

Typecheck: npx.cmd tsc -p dev/staging/cavalry-owner-composition/tsconfig.json --noEmit

## Production composition boundaries

The five proposed paths are integration/creationUnifiedV3.js, integration/creationUnifiedStore.js, integration/popSync.js, population/lod.js and population/reconcile.js. popSync baseline is the separate population-archer-composed owner, not installed main. The unchanged integration/creationBindings.js v2 dependency must be composed from that same stage (SHA717741BBBC0E7E42391C7C84802AE8E5172766BF2009FD897454F20576A01433). The root MJS files are explicit test-source counterparts; no fallback to active old implementations occurs for new core code.

This stage is NOT promotion-ready by itself. The real private fixture adapter still proves exact v2 header/trust and cannot initialize this v3 header accidentally. Default facade format is2. A trusted factory may select fresh format3 only after a new explicit activation/schema contract is reviewed. No public fresh=true flag or user-supplied proof grants permission. Existing v2 data remains preserved and functional; existing v2 worlds cannot enable cavalry until explicit transactional migration is implemented and fault-tested.

## Still missing before a horse may be spawned

The same owner needs a budgeted compound-action adapter: per-role births/completion across hours, exact two-body native clearance, tracked cleanup when only one part is observed, and positive partial removal across restart. A logical spawn/despawn action cannot secretly perform two uncharged native operations. Weighted admission alone does not account for unresolved reservations or stale/out-of-table survivors; those must be included before other groups may consume their slots.

Current popSync does NOT execute compound records or call addRider: it safely refuses a compound record through the single birth path. A rider-first birth requires an explicit second-role action even after the rider becomes canonical; mount-first requires tracked partial cleanup if the observer leaves before rider birth. Ignoring either gap would leave a horse or stalled pair. Both role actions must share existing spawn/action/work counters and timer authority. All store metadata getters precede final fresh native identity/policy/loaded proofs.

Next coherent slice: action-level component cost accounting and compound maintenance proposals through that one owner, then native spawn/remove/seat adapter and reviewed horse/rider data. Full two-direction seating, enlarged mounted collision, controlled combat/home/patrol, positive rider-vs-mount death authority and rejoin remain native gates. Aggregate soldier casualties remain zero here, pending the covered-cohort authority. No fixed soldier mix, ordinary live-guard conversion or new scheduler is authorized by this data.
