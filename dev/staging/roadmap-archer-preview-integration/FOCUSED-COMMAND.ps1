# Run from the project root only after reviewed baseline-SHA guarded promotion.
$reviewedArcherPreviewTests = @(
    'dev/test/archer-content-packs.test.mjs'
    'dev/test/developer-preview.test.mjs'
    'dev/test/integration.test.mjs'
    'dev/test/military-archer-assets.test.mjs'
    'dev/test/military-command.test.mjs'
    'dev/test/military-lifecycle-diagnostics.test.mjs'
    'dev/test/military-selection.test.mjs'
    'dev/test/population-archer-creation.test.mjs'
    'dev/test/population-bound-teardown.test.mjs'
    'dev/test/population-creation-bindings.test.mjs'
    'dev/test/population-creation-command-refusal.test.mjs'
    'dev/test/population-creation-runtime.test.mjs'
    'dev/test/population-sync.test.mjs'
    'dev/test/private-creation-fixture.test.mjs'
    'dev/test/content-packs.test.mjs'
)
& node --test @reviewedArcherPreviewTests
exit $LASTEXITCODE
