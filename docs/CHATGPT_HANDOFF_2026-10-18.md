# Civilization Apocalypse — uploaded-repository handoff (2026-10-18)

## What I found

- The ZIP already contains world-template work in commit `c9c3d46` (701 tests reported there),
  including `dev/build-template.mjs`, `dev/validate-template.mjs`, and the in-game starter arming.
- The existing project is further along than the last chat status: there is no reason to replace
  these scripts with the older standalone toolkit.
- Six source files arrived with pre-existing working-tree modifications that appear to be line-ending
  conversions. They were left untouched in this handoff. Check your local `git status` before merging.
- The actual five-district world does **not** exist. The repository marks only Hearthgate as built
  for the template; layouts for districts 2–5 still need physical implementation and testing.
  *(Superseded 2026-10-26: all five enlarged layouts are registered, and districts 1 and 2 have been built
  and verified in a development save. The starter template still marks none of the five as built.)*

## Added in this handoff

- `dev/lib/release-readiness.mjs`: strict five-district release gate; development staging allowed.
- `dev/check-release.mjs`: read-only CLI to show missing release requirements.
- `dev/test/release-readiness.test.mjs`: negative and positive tests for the strict gate.
- `dev/build-template.mjs`: blocks `--zip` for incomplete starter worlds and refuses output paths
  overlapping the input world or extraction workspace.
- `dev/test/template.test.mjs`: distinguishes safe development staging from shipping a completed
  five-district `.mctemplate`; still verifies reproducible ZIP encoding.
- `package.json`: `npm run template:release-check` shortcut.
- `docs/STARTER_WORLD.md`: updated workflow and release-blocker explanation.

## Testing performed in this environment

- `node --test dev/test/template.test.mjs dev/test/release-readiness.test.mjs`: PASS 23/23.
- `npm run typecheck`: PASS.
- `npm run validate`: PASS (644 checks).
- `npm run template:validate`: PASS (four unfinished districts explicitly reported).
- `npm run e2e`: PASS (52/52 stages).
- `npm run template:release-check`: intentionally exits nonzero because districts 2–5 are not
  built and no final build receipt exists.
- A full `npm run verify` was attempted but exceeded the current execution time limit during
  synthetic world geometry tests; this is **not** evidence of a failure or an all-green run.
- No Minecraft client tests, world import, world modification, or Git commits were performed.

## Next steps for Qoder / Claude

1. Review and merge the small patch with any local uncommitted work (especially `dev/build-template.mjs`).
2. Run `npm run verify` in the local Windows development environment.
3. Continue physical district layouts 2–5 and connect all walls, gates, roads, and evacuation routes.
4. Build all five once in a **dedicated** normal Minecraft development world; validate in-game,
   reset development simulation history with `civ:starter_arm confirm`, verify with
   `civ:starter_verify`, set a central safe spawn, and export the world.
5. Only after the build exists should the starter spec, in-game required-district list and
   signed receipt be changed together to reflect all five completed districts.
6. Run release readiness check, build the `.mctemplate`, import into Minecraft and verify a newly
   created world starts inside a full physical civilization with fresh simulated kingdom state.

Future milestones (not completed): Commander's Ledger item/menus; physical civilians and archers,
swordsmen and cavalry; zombie sieges; neutral distant civilizations and diplomacy.

---

## Integrator notes (Qoder, same day, commit after `c9c3d46`)

Merged cleanly on top of `c9c3d46`: `dev/build-template.mjs` and `dev/test/template.test.mjs` diffs were
**additions only**, so the round of repairs that commit recorded (Int `Generator` handling, `dist/`
containment, reading the real `civ_gatereg` / `civ_gate_<id>` shapes, the `config.js` ↔ `template.json`
drift test) all survived the merge. No second packaging system was introduced; the new gate is called
from the existing packager.

Two claims in the note above are wrong and were corrected rather than carried:

- "The older, smaller Hearthgate prototype was previously built in-game." It was not. `docs/TESTING.md`
  line 3, `docs/PROGRESS.md`, `docs/QWEN_HANDOFF.md` and `docs/ENLARGED_HEARTHGATE.md` all recorded that
  **nothing had ever run inside Minecraft** - the 49x49 prototype was verified against a fake world only.
  `docs/STARTER_WORLD.md` stated that plainly. (Superseded on 2026-10-26, when districts 1 and 2 were built
  and verified in a development save - `docs/PROGRESS.md`. The 49x49 prototype still has not been built in
  game, and no district has been built in the packaged starter template.)
- "npm run verify … exceeded the current execution time limit … not evidence of failure". Correct, and
  it has since been run here: all five gates pass.

Local changes made while integrating:

- `dev/test/release-readiness.test.mjs`: each refusal case now asserts **which** rule tripped instead of
  "some problem exists"; added a missing-receipt case; the overlap test now also proves the refusal is
  non-destructive (the refused path is not created or deleted).
- `dev/test/template.test.mjs`: restored reproducibility across **two full staging runs**, not just two
  zips of one tree (dropped the then-unused `node:crypto` import).
- `docs/STARTER_WORLD.md`: new gate and CLI added to the file table, the workflow split into
  preview-staging vs release, and the unnumbered section folded back into the numbering.

Suite now 711 tests, typecheck clean, `npm run verify` all five gates green, and
`npm run template:release-check` exits **1** with 25 blockers. `template:release-check` is deliberately
**not** one of the verify gates, because verify gates are expected to pass.

An independent review of the merged gate found three more holes, closed the same day:

- **The gate guarded only `--zip`.** Staging was ungated, `dev/lib/zip.mjs` is public, and a
  single-district `.mctemplate` from an earlier probe run was in fact sitting in `dist/templates/`
  (424,607 bytes, its `level.dat` matching `dist/probe-export/level.dat`). Now: a blocked staging writes
  `DEVELOPMENT-PREVIEW.txt` inside the tree so a hand-zipped preview ships its own disclaimer, and
  `check-release.mjs` lists every archive found under `dist/templates/` with size, timestamp and sha256
  prefix and calls it non-releasable. The stale file was deleted (it was this session's own scratch).
- **The gate read only `starter/template.json`.** `civ:starter_arm confirm` enforces `config.js`
  `STARTER.builtRequired`, so a spec claiming five districts with a pack still requiring one printed
  READY. `starterConfigProblems()` now compares the two, and the builder's `--zip` refusal runs it too.
- **Two receipt validators disagreed** - the packager accepted a receipt the release gate rejected, and
  the release gate ignored `centre`/`radius`, the only input to the spawn-inside-the-city check. The
  strict gate now also requires the centre, radius, world name and Minecraft build.

The review's remaining note stands: a receipt is a human attestation, and no offline check can stop
someone zipping a directory by hand. What the tooling can do is refuse, label, and never report READY
against a world it cannot have armed.

