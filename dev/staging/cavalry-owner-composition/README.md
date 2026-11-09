# Cavalry: concrete same-owner native proposal, staging only

**79/79 focused tests pass (410.7575 ms); strict composed TypeScript passes.** No active pack, world, installed file, branch or Git operation was changed. This proposal now includes real spawnEntity/addRider calls behind a staged factory opt-in that is OFF by default. It has not run inside Minecraft. The old30,50 and65 checkpoints and independent failing evidence remain preserved.

## Working increment

Twelve proposed script paths extend the existing population owner, not a companion system. Five additive BP/RP data files define the distinct managed rider and mount. There is no second scheduler, owner, scripted spawner, automatic vanilla override or addrider entity component.

The actual owner pipeline now supports this sequence when its trusted factory explicitly supplies compoundNativeTrial:true on a fresh-v3 store: reserve exact pair metadata with no native actor; next owner pass prepay one role operation and one spawn, persist rider pending intent, validate both landing bodies, spawn/tag/confirm the rider; a later pass performs the separately charged mount birth; another separately charged action calls addRider and verifies getRiders AND rider.entityRidingOn. A same-tick restart cannot buy the second component with the first component's quota. Default calls remain disabled and create no pair intent.

Physical admission reserves two slots for every unresolved pair, including unloaded/out-of-table parts. An admitted pair is not double charged. Existing district8/global24 limits remain. Pending/uncertain actors are not retried from absence. Known-never cancellation and positive two-part cleanup run through the same owner/tick, with exact native role proofs, foreign-passenger refusal, prepaid cursor rechecks and final deletion-target identity after counterpart callbacks. Single/v2 behavior and old schema1 swordsman/schema2 archer data remain supported without migration.

Each physical clearance pass reads exactly48 blocks: conservative 3x3 horse footing with four-high composite body plus a distinct adjacent rider footing/two-high body. Both pre-intent and post-intent passes use actual loaded blocks and the existing exact safe-footing/AIR-or-short-grass predicates. Unknown blocks, holes, liquids, low ceilings and unloaded cells refuse. A bounded nearby-entity census rejects foreign occupants. No terrain clearing, chunk loading, actor teleport or seating-distance bypass occurs. Failed or unverified seating retains both identities. Tag rollback may remove only the exact newborn handle and records a terminal outcome only after positive remove success.

The existing creationRuntime death subscription is extended with the two exact managed types and role-aware identity routing; no new listener is registered. Only fresh entityDie evidence retires the matching generation/role. Missing actors/entityRemove/unload never imply death. Mount death cannot debit soldiers, and this stage introduces no aggregate human casualty debit either.

## Tests and exact scope

Run the six focused files using this stage's explicit loader: unified.test.mjs, compound-regressions.test.mjs, same-owner.test.mjs, maintenance.test.mjs, completion.test.mjs and native.test.mjs.

`node --import ./dev/staging/cavalry-owner-composition/register.mjs --test dev/staging/cavalry-owner-composition/unified.test.mjs dev/staging/cavalry-owner-composition/compound-regressions.test.mjs dev/staging/cavalry-owner-composition/same-owner.test.mjs dev/staging/cavalry-owner-composition/maintenance.test.mjs dev/staging/cavalry-owner-composition/completion.test.mjs dev/staging/cavalry-owner-composition/native.test.mjs`

`npx.cmd tsc -p dev/staging/cavalry-owner-composition/tsconfig.json --noEmit`

The79 cases include the historical65 plus minimal late-quota-ticket regression and13 native-adapter/asset/wiring cases. Actual proposed owner tests cover rider/mount/seat across hours, shared quotas, rejoin, default-off parity,19 mutation/crash boundaries, pending obstruction, failed tags, unload, seat refusal, positive role death and foreign passenger preservation. These are fake-world simulations, not native engine proof. `api-contracts.ts` also compiles the actual stable2.7 addRider/getRiders/entityRidingOn/entityDie/spawnEntity signatures. Original tiny native test failure was an incorrect unloaded Z range; its log remains, and the corrected test unloads the actor's actual chunk. No policy was relaxed to pass it.

Independent50 review exposed two real gaps: counterpart callbacks could invalidate an earlier deletion target; late policy callbacks could revoke prepaid quota. Both have permanent regressions. Independent65 review exposed a metadata-helper ticket-return gap: core.prepareRole could revoke prepaid quota after its prior check. The minimal post-prepare admission/cursor check now throws and preserves the pending intent. Old failure logs and exact checkpoints remain; old normal passes are not claimed as safety acceptance.

## Composition and defaults

Current scripts are under proposed/, additive entities/clients/original simple mount geometry under data-proposal/. proposal.patch uses pinned baselines; native-only.patch shows the change from immutable checkpoint65. The unchanged single-v2 dependency is the archer/creation core SHA717741BBBC0E7E42391C7C84802AE8E5172766BF2009FD897454F20576A01433. Typechecking copies those parent dependencies; it does not silently substitute active incompatible modules. Current stages are proposals against that pinned parent, not an instruction to overwrite newer main files.

Fresh activation is STILL a required gate. The existing private adapter proves exact v2 header/null trust and cannot initialize this v3 header. No public fresh=true or parsed job authorizes cavalry, no existing guard is retyped, and no v2 record is silently migrated. A separately reviewed trusted fresh-v3 activation adapter and explicit transactional v2 migration are missing. The expanded role-aware initial census and starter/export guards must be composed with that adapter before promotion. New injected modules need exact central architecture-test allowlists with inverse native-import tests.

The rider reuses the project's existing owned swordsman art and existing target/friendly filters, adding only the dedicated rider family and documented mount_pathing goal. Mount geometry is an original simple static block horse using a built-in horse texture reference; it is not a polished animated release model. Client texture availability, actual mounted pose, visible sword, behavior priority, mounted navigation/combat, addRider semantics and gateoff/unload/rejoin must be checked in Minecraft. No fixed class mix or balance claim is made.

## Next native gate after review

First prepare a genuine new known-blank fixture, compile its reviewed fresh-v3 trust, compose the existing sole factory/subscription and additive assets, and keep all prior worlds untouched. On a loaded flat open patch, select one valid group before population begins and use only the normal owner. Confirm one rider on the first charged pass, one mount on the next, then exact two-direction seating with two durable IDs and cost2 admission. Save/rejoin, move observer away/back, gate off, and independently verify both positive removals and no replacement from unloaded absence. A controlled positive mount death must leave the human aggregate unchanged and retire only that role; aggregate soldier casualty integration remains a separate roadmap gate. Do not manually summon or teleport a rider/mount to claim owner success.

## Primary references

[Rideable component](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitycomponents/minecraftcomponent_rideable?view=minecraft-bedrock-stable) documents seat_count, family_types, seats and pull_in_entities. [Mount pathing](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_mount_pathing?view=minecraft-bedrock-stable) documents the rider goal. [Stable rideable API](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entityrideablecomponent?view=minecraft-bedrock-stable) and local installed2.7 declarations provide the methods compiled by api-contracts.ts. Referenced on2026-11-08; documentation/API shape does not prove this custom entity's native behavior.

The final self-review correction includes compound role births in report.actions.spawn, matching applied actions and quota counters. Exact prior79 bytes remain in checkpoint79/; no behavior or admission policy changed.
