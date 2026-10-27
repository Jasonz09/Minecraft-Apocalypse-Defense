# Starter world - prebuilt kingdom as a Bedrock world template

Status: **tooling and contract are implemented and verified offline. No `.mctemplate` exists yet,
because the city the packaged template must contain has not been built in a starter world.** All five
districts have registered enlarged layouts and all five are marked `planner-ready` in
`starter/template.json`. Districts 1 (Hearthgate) and 2 (Ironquarry) **have been built end to end and
verified inside Minecraft** (Bedrock 1.26.5203, 2026-10-26) - in a development save, recorded in
`docs/PROGRESS.md`; that is not the starter world this document ships, and no district has been marked
`built`, armed, exported or imported. Not built in game either: the 49x49 prototype (offline-only per
`docs/PHYSICAL_DISTRICT_DESIGN.md`) and districts 3-5.

## 1. What "prebuilt" means here

The shipped artifact is a **world template** (`.mctemplate`), not a behavior pack that builds a city
on first join. A player picks the template in *Create New > Imported Templates*, and the kingdom is
already standing: walls, gates, roads, homes, farms, barracks, in normal surrounding terrain.

That forces one design decision this whole document revolves around:

> **The world's geography and the world's progress are different things, and they are stored in the
> same dynamic properties.**

A build world accumulates months of development state - battles fought, population drift, refugees,
quarantined blobs, half-finished job queues, a development gate unlock. A player must inherit the
city, never that history. So arming splits saved state three ways (`scripts/sim/starter.js`):

| kind | keys | why |
| --- | --- | --- |
| **reset** | `civ:kingdom` | the simulation goes back to the published baseline (5 districts / 400 civilians / 150 soldiers, `step` 0) **but keeps** each district's `civ` / `physical` records, because those say what is physically standing in the world |
| **keep** | `civ:kingdom`, `civ:plan`, `civ_gatereg`, `civ_gate_*` | the five-district master plan and the gate registry, so procedural construction and gate control stay available for expansion and rebuilding |
| **wipe** | `civ:kingdom-quarantine`, `civ:jobs`, `civ:debug`, `civ:demo-`, `civ_devgate` | development-only residue |

Matching is **longest-prefix-wins**, which is what lets `civ:kingdom-quarantine` be wiped while
`civ:kingdom` is kept. A key matched by neither list is reported as `unknown` and left alone: this
tool has no business deleting another add-on's properties.

Prefix lists live in **one** place - `starter/template.json` - and `config.js` `STARTER` mirrors them;
`dev/test/template.test.mjs` fails if the two drift.

## 2. Research findings (Bedrock world template format)

Verified against primary sources ([Microsoft Learn: Create a World Template from an Exported
World](https://learn.microsoft.com/en-us/minecraft/creator/documents/createaworldtemplate?view=minecraft-bedrock-stable),
[Bedrock Edition level format](https://minecraft.wiki/w/Bedrock_Edition_level_format)):

- A template is **an exported world, zipped, with `.mctemplate`**. The zip must contain the world's
  *contents* at the root; zipping the containing folder makes it un-importable.
- A template `manifest.json` is `format_version: 2`, `header.name = "pack.name"`,
  `header.description = "pack.description"`, and **two different UUIDs** (header + one module of
  `type: "world_template"`). Re-using a UUID that is already in `com.mojang` produces
  *"Failed to import"* - which is why the shipped UUIDs are fixed in `starter/template.json` and the
  validator refuses a template UUID that equals a pack UUID.
- `texts/en_US.lang` supplies the UI name (`pack.name=` / `pack.description=`); `texts/languages.json`
  lists the languages (`["en_US"]` minimum). Without them the template is literally named "pack.name".
- Add-on packs ride along in `behavior_packs/<dir>` + `world_behavior_packs.json` (and
  `resource_packs/...`). **Pack folder names inside a world template must be 10 characters or
  shorter** (an Xbox path-length issue); ours is `CivApocBP`.
- The random-seed variation deletes `db/` and sets `allow_random_seed: true`. **We deliberately do the
  opposite**: the city *is* the `db/` content, so `db/` must be present and `allow_random_seed` must
  not be set (`world.keepRandomSeed: false`).
- `level.dat` is an 8-byte header (int32 version, int32 payload length) followed by **uncompressed
  little-endian NBT** rooted at a compound. Java's gzip'd big-endian file is a different format.
- Inside `Level`, **`Generator` is an Int, not a word**: 0 Old, 1 Infinite, 2 Flat, 5 Void, and the
  seed is `RandomSeed` (Long). `SpawnX/Y/Z` are Ints. A validator that compares `Generator` to the
  string `"infinite"` fails every export Minecraft has ever produced - the fixture in
  `dev/test/template.test.mjs` therefore writes the numeric form, and the package gate maps
  id→name and still accepts a string if some tool writes one.
- `world_icon.jpeg` is optional for non-marketplace templates (800x450).

What that means for our tooling:

1. `db/` is a LevelDB of opaque binary logs. **Simulation state stored in dynamic properties cannot
   be inspected offline**, so the packager will not pretend to check it. It requires a *build
   receipt* (section 5) whose numbers came from the in-game `civ:starter_verify` output.
2. The pack copies inside an exported world can be stale. The builder therefore takes
   `behavior_packs/CivApocBP` **from the repository**, not from the export, so the shipped pack always
   matches the commit that built the template.
3. Packaging must not be delegated to the shell. Measured on this machine: PowerShell's
   `Compress-Archive` writes entry names with **backslashes**
   (`behavior_packs\CivApocBP\scripts\main.js`), while the ZIP application note mandates `/` - which is
   what Minecraft reads. `dev/lib/zip.mjs` writes the archive itself: `/` separators, no wrapping
   folder, no directory entries, fixed timestamps (so two builds of the same tree hash identically and
   a rebuild can be proved not to have changed), stored-or-deflated whichever is smaller, and CRC-32
   verified on read. A synthetic export run produced a 0.4 MB `.mctemplate` with 80 entries, no
   backslashes, no wrapper, and `scripts/main.js` inside it byte-identical to the repository copy.

## 3. Files

| path | role |
| --- | --- |
| `starter/template.json` | the contract: template id/version/UUIDs, pack staging, required/optional/forbidden world files, keep/wipe prefixes, per-district layout ids and status |
| `starter/build-receipt.example.json` | the human-signed proof that a world was built and armed (copy to `starter/build-receipt.json`) |
| `CivilizationApocalypse_BP/scripts/sim/starter.js` | pure: key classification, baseline construction, arm refusal list, release read-out |
| `CivilizationApocalypse_BP/scripts/commands/starter.js` | runtime boundary: `civ:starter_status`, `civ:starter_arm confirm`, `civ:starter_verify` |
| `dev/lib/nbt.mjs` | offline `level.dat` reader/writer (no new dependency) |
| `dev/lib/zip.mjs` | the template's own ZIP writer/reader: `/` separators, contents at the root, fixed timestamps so a rebuild is byte-identical, CRC verified on read, and entry names that try to escape the package (`../`, absolute, drive-letter) refused on the way in |
| `dev/validate-template.mjs` | spec gate + package gate; runs as the fifth verify gate |
| `dev/lib/release-readiness.mjs` | the stricter five-district **release** gate: all five marked built and required, all five in the signed receipt, the published baseline, zero pending jobs, the city centre/radius/version the spawn check needs, real verification notes - and `starterConfigProblems`, which demands the pack's `config.js STARTER` rules say the same thing |
| `dev/check-release.mjs` | read-only CLI for that gate (`npm run template:release-check`); exits nonzero while the civilization is unfinished, and names any `.mctemplate` already in `dist/templates/` as non-releasable |
| `dev/build-template.mjs` | export -> staged template -> `.mctemplate`; read-only on the source world, writes only under `dist/`, refuses a `--out` that overlaps the source or its own extraction workspace, refuses `--zip` until the release gate passes, and stamps `DEVELOPMENT-PREVIEW.txt` into any tree the gate blocks |
| `dev/test/template.test.mjs` | 18 tests: spec, mutations, NBT, staged package, failure cases, builder refusals, starter semantics |
| `dev/test/release-readiness.test.mjs` | 10 tests: the current one-district spec is refused, a completed five-district spec passes, and omitted / duplicated / falsely-built districts, placeholder and incomplete receipts, and a pack that disagrees with the spec each name their own refusal; plus a non-destructive overlap test with a real source directory and the preview-marker test |
| `dev/test/reliability-runtime.test.mjs` | starter arming driven through the fake `@minecraft/server` |

## 4. The commands, and what they refuse

```
/scriptevent civ:starter_status          read-only: keep/reset/wipe lists + what still blocks arming
/scriptevent civ:starter_arm confirm     writes the baseline, wipes development residue
/scriptevent civ:starter_verify          read-only: is this world consistent enough to export
```

`civ:starter_arm` is deliberately two words: without the literal `confirm` it explains itself and
writes nothing. It then refuses unless **every** one of these holds (fail-closed, no override flag):

- a kingdom is stored and readable (not quarantined, not a newer schema);
- each `starter.builtRequired` district has `district.civ.status === "complete"` - an empty or
  half-built template can never be packaged as the finished civilization;
- no district is `building`, **or `paused`** (a paused build's only resume handle is the job queue,
  which arming deletes), and no `district.physical` prototype build is in progress;
- no planning/survey/build session holds the job slot (`districtBuilder.isBusy()`) or the progress
  display (`civProgress.getProgress()`), because a live session would save development progress over
  the baseline it just wrote;
- the job queue reads `ok` **or** `absent` - a `corrupt`/`newer`/`unsupported` queue could still hold
  unfinished work, so it blocks;
- the gate registry `civ_gatereg` reads as `{v:1, gates:[…]}` and no listed gate carries a manual
  `mode` override or an adapter record (`civ_gate_<id>`) with a destination still to reach. An
  unreadable registry is a refusal, not an absence - `readGateRegistry()` turns corruption into "no
  gates", which is exactly what a shippable world looks like;
- the master plan is stored **and readable**; keys present but unreadable is reported as its own
  failure, not as "not stored".

Re-arming an already-armed world is refused, so a shipped template can't be silently rebuilt over
play state. Arming never generates or removes a block, and nothing in this path runs on player join.
The keep/wipe/builtRequired lists exist twice on purpose - `config.js` (what the game does) and
`starter/template.json` (what the package gate checks) - and
`dev/test/template.test.mjs › the release contract is the same in config.js and starter/template.json`
fails if they ever drift.

## 5. One-time repeatable workflow

Steps 1-5 happen inside Minecraft in a dedicated build world. As a run they have **not** been performed:
districts 1 and 2 were built (step 2) in a development save on 2026-10-26, not in a fresh build world, and
that save has not been returned to a shippable state, armed or exported. Steps 6-7 are offline and
implemented, and step 8 needs the game again.

1. **Create a dedicated build world** (e.g. `CIVBUILD-hearthgate`), normal/infinite generator, cheats
   on for `/scriptevent`. Never an existing world: the tooling never edits a live save.
2. **Build district 1**: `/scriptevent civ:generate` (dry survey), then `civ:generate_plan`,
   `civ:generate` to place, `civ:generate_status` / `civ:generate_resume` as the budgeted job walks
   through its stages. Slope survey is a read-only scan and can time out - resume, don't restart.
3. **Return the world to a shippable state**: every gate back to auto (`civ:gate_auto`), no job left
   pending, `civ:generate_abort` anything unfinished.
4. **Arm and read the receipt**: `/scriptevent civ:starter_status` → `/scriptevent civ:starter_arm
   confirm` → `/scriptevent civ:starter_verify`. Copy `starter/build-receipt.example.json` to
   `starter/build-receipt.json` and fill it from those two outputs (`armed`, `builtDistricts`,
   population, `jobPending: 0`, the city `centre` and `radius`).
5. **Export**: Play > Edit (that world) > General > File Management > **Export World**.
6. **Stage it as a development preview** (repository root; this never ships anything):
   ```
   node dev/build-template.mjs --world "<exported.mcworld or folder>" \
        --receipt starter/build-receipt.json
   node dev/validate-template.mjs --world dist/templates/civapoc-starter \
        --receipt starter/build-receipt.json
   ```
   `--dry-run` stages and validates without a receipt; `--out` must stay inside `dist/` and may not
   overlap the source world or `dist/work`, so an accidental path can neither write over a real
   Minecraft world nor have the builder delete one.
7. **Ask the release gate before shipping anything**:
   ```
   npm run template:release-check
   ```
   It exits nonzero until all five districts are marked built, required and receipted. Only then does
   adding `--zip` to step 6 produce `dist/templates/civapoc-starter.mctemplate`; with fewer than five
   districts the packager refuses, because a one-district archive named as the starting kingdom would
   misrepresent the game.
8. **Install for a test**: double-click `dist/templates/civapoc-starter.mctemplate` (importing the same
   UUID twice needs the old copy removed from `com.mojang\world_templates` first), then
   *Create New > Imported Templates*. The builder prints the artifact's `sha256`; record it with the
   receipt, because the file is reproducible and so a later rebuild can be proved identical.

The builder refuses a receipt that does not match `template.json` (`armed !== true`, wrong id,
`builtDistricts` missing a `builtRequired` entry, `jobPending !== 0`, non-integer centre).

## 6. Packaging checks (what `dev/validate-template.mjs` actually stops on)

Spec gate: valid/distinct/collide-free UUIDs, `moduleType = world_template`, `packageExtension =
mctemplate`, pack folder name ≤ 10 chars, pack source and manifest exist in the repo, `en_US` in
languages, `keepRandomSeed: false`, keep/wipe prefixes not overlapping, `civ:plan` kept, five districts
with unique ids/names/roles and unique `<name>-enlarged` layout ids, and `starterWorld: true` only for
a district whose layout is registered in `districtplan.ENLARGED_LAYOUTS` and whose status is not
`planned`. The last rule is the one that stops an incomplete template being called finished: today it
passes because all five registered layouts are present, and the run prints *"5 starter district(s) are
planner-ready but not physically built ... template:release-check must refuse packaging until each one is
built and verified in Minecraft"* rather than hiding it.

Package gate: required files present (`level.dat`, `levelname.txt`, `db/CURRENT`), no forbidden residue
(`db/*.tmp`, `db/DIM*/`, `level.dat_new`, `world_behavior_packs.json.bak`), `level.dat` parses as
Bedrock NBT with an integer spawn inside the receipt radius, generator is `infinite`, the bound pack
uuid exists in `behavior_packs/*/manifest.json`, the template `manifest.json` and `texts/` are correct,
and the size stays under `maxWorldBytes` (256 MB).

## 7. Full-release gate: a staged preview is not a release

**Development staging is not the finished product.** The existing starter spec marks all five districts as
starter-world districts and none of them `built`; no district of the packaged template has been built -
districts 1 and 2 stand only in a development save (`docs/PROGRESS.md`).
The earlier packager could create a `.mctemplate` when just Hearthgate was marked complete.
That was suitable for an experiment but misleading as a five-district release.

Before publishing, run:

```shell
npm run template:release-check
```

It reports the five required districts and explains why release is blocked. The regular
`node dev/build-template.mjs --world <export> --receipt <receipt>` command can still **stage** a
development world for review, but **adding `--zip` now refuses to create a release archive** until:

- All five original districts are explicitly marked `starterWorld: true, status: "built"` in
  `starter/template.json` and listed exactly once in `starter.builtRequired`.
- All five have genuinely been built and verified in a dedicated Minecraft world (and their
  layouts are registered by the planner). The in-game `civ:starter_arm confirm` must also
  enforce all five in the updated mirrored `STARTER.builtRequired` configuration.
- `starter/build-receipt.json` confirms all five as built, 400 civilians, 150 soldiers, five
  districts, zero queued construction jobs, a matching template id, the city `centre`/`radius` the
  spawn check is measured against, the world name and Minecraft build, and real verification notes.

Three things were added while reviewing the merge, because the gate as first written could still be
printed "READY" over a one-district world:

1. `starterConfigProblems` compares the shipped spec with the **pack's own** `config.js STARTER`
   rules. `starter/template.json` is only a declaration; `STARTER.builtRequired` is what
   `civ:starter_arm confirm` actually enforces in the world, and the two lists diverging is exactly
   how a Hearthgate-only save could arrive stamped as the five-district release.
2. A staging run that fails the gate still writes the tree, but writes
   `DEVELOPMENT-PREVIEW.txt` **inside** it, naming the blockers. Anyone who then zips the folder by
   hand - which no offline tool can prevent - ships the disclaimer with it.
3. `npm run template:release-check` lists any `.mctemplate` already sitting in `dist/templates/` with
   its size, timestamp and sha256 prefix and calls it non-releasable while the gate fails. One was
   found during review, left behind by an earlier probe run of this very tooling.

The receipt is **an attestation, not cryptographic proof of saved world contents**. A valid ZIP
still needs testing after import into Bedrock; the offline tools cannot confirm all block data or
kingdom dynamic properties inside the LevelDB. Never simply change `starterWorld` flags to get
through the gate without physically building and checking those districts.

Do not distribute an older artifact just because it is still present: the release check reports it
rather than deleting it, because deleting files this tool did not create in this session is not its
call.

The packager now also refuses a staging path that overlaps the source world or its own temporary
extraction directory; this prevents destructive cleanup caused by a bad `--out` argument.

## 8. Getting to five districts

`starter/template.json` already lists all five with their `-enlarged` layout ids, so the gap
is build time, not contract or code:

1. Done: `ENLARGED_LAYOUTS` in `scripts/civ/districtplan.js` maps **all five** indices
   (`hearthgate/ironquarry/whitethorn/saltmere/ashfall-enlarged`); the composer builds each district's
   walls, gatehouses, road profiles, pads, stairs and bridges from the master plan.
2. Done: every entry already carries `starterWorld: true`, with `status: "planner-ready"`. Each one moves
   to `built` only after that district has been built and inspected in the world being packaged.
3. Partly done: districts 1 and 2 are built, in ring order, one `civ:generate` job each - but in a
   development save that has never been armed or exported (`docs/PROGRESS.md`). Districts 3-5 still have
   to be built, and `civ:starter_verify` re-run afterwards: it must show 5 complete districts and 0
   pending jobs.
4. Inter-district wall/gate links come from the master plan's shared chains; the gate registry keeps
   them closable, so the template still ships with `auto` gates.

## 9. What must be tested in Minecraft (and nothing here claims it has been)

- Import the template, create a world from it, and confirm the walls/roads/buildings are the ones that
  were built - no generation runs at join.
- `/scriptevent civ:status` on first join: 5 districts / 400 civilians / 150 soldiers, `step` near 0 -
  i.e. the arming took, and `db/` really carried the armed properties.
- `/scriptevent civ:starter_verify` says *Ready for export* and lists no wiped keys.
- Rejoin after a quit: state persists and no `civ:jobs`/`civ:debug`/`civ:demo-` key reappears.
- Expansion still works procedurally: `civ:generate_plan` for district 2 against the shipped plan.
- The old 49x49 `district.physical` prototype world is untouched, and generation still refuses any
  footprint overlapping an existing physical record.

## 10. Known limitations

- **No template has been built or imported.** Steps 3-5 of section 5 still need Minecraft; step 2 has been
  walked in game, but only for districts 1-2 and only in a development save.
- Offline tooling cannot read simulation state out of `db/`; the receipt is a signed human step, not a
  cryptographic guarantee.
- Districts 1 and 2 have now been placed in a world, and the build-time surprises they did hit are
  recorded in `docs/PROGRESS.md`: a ticking-area chunk hold needs the player standing near the tile that
  is loading, and trees whose neighbours included melon, cocoa or bamboo were left standing on built lots.
  Districts 3-5 have still never been placed, so rivers, cliffs and unloaded chunks at the survey edge
  stay open risks there.
- `world_resource_packs.json` is copied if present, but this pack ships no resource pack, so that path
  is untested.
- The wipe list is one-colon prefixes on purpose, so the plan store's quarantine copy (the bounded
  duplicate it keeps under the plan prefix when plan data fails to load) rides along with the kept
  `civ:plan` rule instead of being wiped. Writing that key as a wipe prefix needs a two-colon literal,
  which the repo-wide "no `civ:` id may have two colons" guard refuses - and that guard is the more
  valuable instrument. The copy is data that was already unreadable, so it is inert; if it ever
  matters, give the plan store a one-colon quarantine key rather than teaching arming around the guard.
- The `.mctemplate` zip is written by `dev/lib/zip.mjs` and audited offline (entry names, CRCs, no wrapping folder).
  What is **not** known is whether Minecraft's importer is happy with it on every platform - that needs
  one real double-click, and until then the artifact is claimed only as *format-correct*, not as
  *import-verified*.

Sources:
- [Create a World Template from an Exported World - Microsoft Learn](https://learn.microsoft.com/en-us/minecraft/creator/documents/createaworldtemplate?view=minecraft-bedrock-stable)
- [Bedrock Edition level format - Minecraft Wiki](https://minecraft.wiki/w/Bedrock_Edition_level_format)
