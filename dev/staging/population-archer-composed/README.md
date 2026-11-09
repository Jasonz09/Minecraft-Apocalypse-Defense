# Archer and durable creation composition — staged only

This new stage composes the reviewed archer54 and creation90 proposals. The original frozen stages remain unchanged. It contains 21 proposed BP/RP paths and a combined test overlay; production, installed165, worlds and desktop were not changed. The private fixture trust module remains **literal null**. There is no genuine activation receipt, new owner, script timer, spawner or aggregate casualty authority.

## Coherent identity support

The only additional production changes beyond the two source proposals are in three creation modules. `creationBindings.js` exports frozen `CUSTOM_CREATION_ENTITY_TYPES` (swordsman, archer) and `CREATION_ENTITY_TYPES` (villager, golem and those two custom guards). The durable binding parser/issuance/observation checks and both existing death-registration entrypoints use the same list. The private virgin-world census now refuses either untagged custom guard before publishing any activation intent. Runtime still registers only its one existing death handler; the core helper is not additionally called by main.

Creation binding schema remains 2 with the same records, inventory, tickets, limits and recovery semantics. No stored field is rewritten, no actor converted and no legacy namespace automatically migrated. The military selection schema-1 swordsman byte format remains unchanged; schema-2 archer class/type pairing is inherited from the reviewed archer stage. Normal unselected soldier groups remain golems. Unknown class/type/version combinations continue to refuse. Older builds that do not understand an archer binding must preserve/refuse it; do not treat downgrade as a migration path.

The sole `popSync` owner, streets adapter, first-spawn hook, activation-family hold, starter/export protection and explicit command refusal replies are copied exactly from creation90. All four archer selection/command/diagnostics modules and all seven server/client asset files are copied exactly from archer54. Their source hashes are recorded in `SOURCE-PINS.json`; only the three creation modules above differ from their source-stage bytes. The owner algorithm, native last-getter guards, birth tags and removal tickets are unchanged.

## Combined lifecycle and faults

`compatibility-final.log`: **165/165 PASS**, 681.2814 ms, zero skipped/cancelled. This includes all 90 creation cases, all 54 archer cases and 21 new combined cases through a single module overlay. New cases exercise the actual proposed owner and streets paths, with synthetic private-fixture provenance:

- Exactly one bound archer birth; unloaded absence and restart preserve its ID; positive gate-off removal retires the exact instance and a later birth advances generation without changing aggregate soldiers.
- Both death filter declarations contain the shared types; the real runtime handler records an exact archer physical death, deduplicates repeats and rejects wrong type/token. This remains a physical-instance receipt, not soldier casualty debit.
- Duplicate, foreign-token and changed-selection conflicts preserve the actor before ordinary owner actions. An explicit gate-off may still retire its positively bound exact actor. Deleting selection never converts the durable archer binding into a golem; subsequent default-type refill holds. Selection/type reconciliation is deliberately explicit.
- Archer tag failure uses positive rollback, then retries at a new generation; terminal persistence failure holds across restart; a selection change inside a birth metadata getter prevents native spawn.
- Before/after each of the four durable issuance writes restarts conservatively. A pre-intent failure can retry; any persisted incomplete/pending issuance never gains a birth permission solely from absence.
- An untagged archer invalidates the private blank census before any intent/header write. Null trust still refuses. Schema-1 swordsman remains byte-compatible and completes its bound lifecycle. Legacy archer observation never gains missing-actor refill/removal permission.

`typecheck-final.log`: strict project-option TypeScript exit 0, with unchanged compiler options and no suppressions. The typecheck overlay uses current production dependencies plus every final proposed script byte-for-byte.

Run the focused suite in PowerShell:

```powershell
$archerTests = @(Get-ChildItem -LiteralPath dev/staging/population-archer-composed -Filter '*.test.mjs' -File | Select-Object -ExpandProperty FullName)
node --import ./dev/staging/population-archer-composed/register.mjs --test @archerTests
npx.cmd tsc -p dev/staging/population-archer-composed/tsconfig.json --noEmit
```

Initial test history is retained. `compatibility-initial.log` reports a test-loader fallback mistake, fixed by returning the resolved active dependency URL; no production condition changed. `combined-initial.log` contains a mistaken gate-off expectation: existing positive owner removal is permitted even after selection is removed. The test was corrected to check ordinary-hour preservation and separately proves gate-off retirement cannot retype/refill the binding. No owner predicate was changed for these tests.

## Remaining gates

Private creation activation and the public military selector retain **separate provenance contracts**. Creation activation must happen against the exact initial kingdom before its first accepted hour, with authentic compiled receipt/marker and existing developer flag. A null descriptor does not grant fresh permission. The private hook never sets that flag, resets or rewinds a world. The public military command still requires its reviewed Nov3 D1 source fingerprint. A new vanilla creation receipt does not magically satisfy that city-source contract. Combined tests use the lower selection store's explicit synthetic proof; they do not claim the existing public selector can activate on an arbitrary new creation fixture. Root must prepare a matching witnessed derivative or independently review a fixture adapter before a native archer trial.

The inherited archer has static projectile/friendly-filter and owned appearance checks only. Native ranged firing, hits/damage attribution, friendly HP preservation, human/bow rendering, chase/home behavior, save/rejoin and full crash/gate-off acceptance remain unverified. No actual ballistic, gameplay balance or native source-authentication claim is made. Cavalry/pair actors, army/class mixes and cohort casualty accounting remain outside this stage.

`PROMOTION-HASHES.json` pins all 21 proposed paths, current active baselines, source-stage receipts and evidence. `proposed.patch` includes only proposed production deltas. Independent combined review, central full verification, genuine fixture receipt/preparation and native acceptance are still required before installation. This stage does not change the currently installed pack or complete those roadmap gates.
