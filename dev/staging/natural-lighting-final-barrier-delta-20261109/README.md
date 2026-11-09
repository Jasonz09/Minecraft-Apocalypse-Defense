# Outdoor lighting final support/source barrier delta

NEW one-production-path correction to frozen D1C4A9BB965120D7F66855414807869C23190B1AC6A2635EDE4515459290D9A0. The original source, actual independent failure file/log and readonly audit remain unchanged. No active source/Git/UI/native/install changes.

The reviewer reproduced two concrete actual-runtime failures: a final target read changed the previously checked ground support to AIR yet2fixture cells were placed; and the third final native state getter revoked source metadata yet1lantern deletion occurred before the post-write assertion. Both exact cases now pass in the copied independent runtime regression body.

Deletion now validates sources AFTER the final native state comparison and BEFORE invoking the captured setter. Addition captures its initial ground support ID, freshly rereads support after the final target/metadata callbacks for EVERY placement, then rechecks target AIR and current support identity/validity immediately before the captured setter. Changed/unloaded footing pauses with the saved current fixture cursor; no unsupported later cell is added. No rollback/delete of already verified placed cells is attempted.

Per-cell partial semantics are explicit: if a fence was safely placed and ground becomes AIR before the later lantern, the fence remains and the lantern is refused. A tested explicit rerun after real footing is restored keeps that fence and places only the missing lantern. This is not atomicity for the whole fixture and does not claim impossibility of arbitrary mutually side-effecting getters; native engine/positive-world gates remain. Player/foreign target conflicts retain original preserved-fixture semantics.

Every cursor publication now validates sources before and after writing the existing journal. Final complete is assigned only AFTER its completion journal save succeeds, so a source-revoked no-op or failed completion publication cannot report successful completion/start the next district. Unknown state is preserved, not reset.

30 focused PASS344.5409ms, strict170-JS overlay0. This includes prior20 cases, both exact independent regressions, and8new footing/partial-resume/journal checks. New coverage includes late water/shortgrass/bookshelf footing, unloaded final support, partial fence retention, explicit safe resume, source revocation in a no-op state getter and failed completion publication preventing chaining. Old runtime/command/port assertions remain, no timers/event filters or guard assertions removed. Only a final explanatory comment changed after the successful strict/test run; executable bytes are unchanged.

Promotion resolution: use this proposed/integration/lightingRevision.js INSTEAD OF the same path from D1C4. Retain that parent's civ/lightingRevision.js, commands/civ.js and proposed-dev/lib/civharness.mjs byte-exact. No preview/parser/planner/style/ownership changes in this delta. Generated runtime is test scaffolding. The copied harness-defaults compatibility test imports the exact frozen parent test project because this delta does not change that test port.

Full central planner/suite, accurate native state/lease/performance checks and actual new-city-clone readonly preview/day-night gates remain OPEN. No bulkcleanup/native acceptance. Use the already pinned natural-lighting-step2-audit NATIVE-CHECK-PLAN.md only after independent review/central promotion/install verification. Foreign/player realm stages are separate.

Run: node --import ./dev/staging/natural-lighting-final-barrier-delta-20261109/register.mjs --test dev/staging/natural-lighting-final-barrier-delta-20261109/runtime-safety.test.mjs dev/staging/natural-lighting-final-barrier-delta-20261109/command-preview.test.mjs dev/staging/natural-lighting-final-barrier-delta-20261109/harness-defaults.test.mjs
Typecheck: node_modules/.bin/tsc.cmd -p dev/staging/natural-lighting-final-barrier-delta-20261109/tsconfig.json
