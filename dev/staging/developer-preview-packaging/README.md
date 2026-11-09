# Developer pack preview — isolated release-preparation increment

This is STAGING ONLY. Three proposed dev-tool files plus one central-ready test are pinned. No active BP/RP, installed Minecraft pack, world directory, existing release script, starter spec, build receipt or historical template archive was edited. No UI, import, deployment, planner, full-project suite or Git operation was performed.

## Why this exists

`dev/check-release.mjs` still correctly blocks the historical17,345,764-byte `dist/templates/civapoc-starter.mctemplate`: source165 has99pack/binding parity problems, including stale BP modules, all6missing RP files and missing RP world binding. A new world template must still pass the existing armed/clean five-district release rules and native saved-world checks. Updating packs alone cannot establish those facts. Existing `dev/build-template.mjs --zip`/release guards are unchanged.

This workflow creates **PACKS ONLY**, explicitly named developer previews: exactly two complete MCPACK archives inside one MCADDON, plus separate generated expected-binding examples, source SHA/byte inventories, output hashes and a developer-only notice/receipt. No world/database or `.mctemplate` is included. The receipt explicitly says worldIncluded=false, releaseApproved=false, cleanStarterVerified=false, nativeImportVerified=false and starterGateOverridden=false. It accepts no `--receipt`, `--zip`, clean-world boolean, release bypass or install argument.

Microsoft's [file extension documentation](https://learn.microsoft.com/en-us/minecraft/creator/documents/minecraftfileextensions?view=minecraft-bedrock-stable) describes MCADDON as a container for MCPACK/MCWORLD archives and MCPACK as a zipped behavior/resource pack. This tool deliberately includes only the two MCPACKs. Actual Minecraft import of this generated artifact remains UNTESTED.

## Proposed commands after central promotion

`node dev/preview-packs.mjs --label current-dev --dry-run`

`node dev/preview-packs.mjs --label current-dev --build`

`node dev/validate-preview.mjs --directory dist/developer-previews/current-dev`

Optional `--project <checkout>` points to a source checkout; optional `--bindings <closed-export-folder>` reads ONLY that folder's world_behavior_packs.json and world_resource_packs.json and checks exact shipped IDs/versions, including duplicates/unknown packs. It does not copy these files or read/decode any DB. Without this flag, binding status is honestly NOT_CHECKED: generated examples are not evidence of a world's installed/active bindings. World readiness and clean release remain separate.

For this unpromoted stage, prefix the command with `node --import ./dev/staging/developer-preview-packaging/register.mjs` and use the proposed CLI under `dev/staging/developer-preview-packaging/proposed/dev/`, with explicit `--project E:/CivilizationApocalypse`. The isolated loader only resolves unchanged shared Node packaging helpers; no game/native API is mocked or invoked.

## Safety and validation

Default is dry-run, with no output creation. Labels are bounded slugs and outputs are restricted to `<project>/dist/developer-previews/<label>`. Existing targets, even empty, refuse; no overwrite or unknown-folder backup/delete. Linked ancestors/content refuse. Source/output overlap and escaped output paths refuse. Preflight validates both full pack trees, canonical unique UUIDs, stable server2.7 dependency/script entry and the existing BP/RP/custom-render asset graph before mutation. Unexpected source world/db payloads refuse rather than silently shipping private world bytes. Source snapshots are buffered, every captured file is packaged, and source/bindings are reread before publication.

Only a newly created checked scratch directory can be recursively cleaned. A final directory rename publishes completed output; tests cover source changes and a target appearing during construction, preserving both user edits and unknown concurrent output. This is not a cross-process hostile-filesystem transaction or continuous source lock. Validation later compares current source and exact output inventory again.

The validator never extracts archives. It checks bounded canonical ZIP directories, duplicate/path identities, matching local/central headers, compressed ranges, limited inflation, CRC and SHA of every inner/outer entry against the complete current pair. Rewriting receipt output hashes cannot bless tampered ZIP local headers. Unknown output/world files refuse before their contents are hashed. Limits are2,048files/pack,16MiB/file,64MiBsource,80MiB/archive; they are explicit safe bounds, not general-purpose ZIP compatibility. Native script/parser/render behavior still requires real acceptance.

Pack UUIDs, versions, names and all source bytes remain unchanged; importing may therefore replace packs with those UUIDs. This stage performs no import. Use only backed-up disposable testing when a later native check is authorized.

## Proof

15/15 focused tests PASS3,067.9336ms (`focused-complete.log`). Tests use small actual paired manifest/entity/RP assets with synthetic script source and real temporary files/archives. They cover complete two-pack/hash/binding parity; deterministic archive bytes; missing RP/texture/bad dependency; unsupported script entry/language/case-folded UUID collision; malformed/duplicate world bindings; existing outputs/path/junction refusal; concurrent source edits/new output preservation; stale/missing/unexpected output; forged localZIPCRC with updated receipt hash; world-payload refusal; and actual builder/validator CLI paths.

Initial12/13 passed with a Windows test-only `--import` absolute path URL failure. The original log/test are retained; using pathToFileURL for the test subprocess fixed it. Subsequent13/13 and14/14 logs are retained. Four final JavaScript source/test proposals pass Node syntax checks. No main TypeScript flags were changed or relaxed; repository main strict checks do not cover Node dev tools, and @types/node is not installed. No synthetic loose ambient types or fake TSC pass is claimed.

`ACTUAL-EVIDENCE.json` pins all output files of two non-overwritten165-source developer previews (initial and final authoring run). Final current output is `dist/developer-previews/source165-pack-preview-final-20261107`. Both archives are byte-identical SHA25640BF2EEFD3971112165C6A34B0B5D950B6BB1438825160E0AB0A7F8AB189927F. Final receipt SHA256AA46AFA000538E283330F1DD3C24A43CCB774753A34D391B05BC1E0215335222. All165pack files equal frozen source165, including159BP+6RP, and final standalone validation passes. Actual world bindings were not supplied and remain NOT_CHECKED.

Historical archive/receipt/spec and all3existing release tools remain SHA/byte unchanged from ACTUAL-BEFORE.json. Running the ORIGINAL check-release CLI after preview creation still returns exit1, Release BLOCKED,99mismatches (`release-still-blocked.log`). The old archive was read as a ZIP for pack parity, not parsed as a database; no source world directory was accessed or mutated. The preview neither fixes that archive nor supplies a clean-release receipt.

The central-ready test file uses ordinary production/dev imports and real CLI paths; no staging/dist runtime import exists. It preserves all15 stage test assertions with location-only adaptation. It is syntax-checked, while executed proof is the equivalent staged paths. Root should run it against actual centrally promoted files before any full/deploy gate. Independent review is still required before promotion.
