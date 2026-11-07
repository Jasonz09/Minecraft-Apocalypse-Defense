# Starter world - prebuilt kingdom as a Bedrock world template

Latest source verification (2026-11-05): **1,519 tests, five gates, 52/52 headless stages pass**.
Boundary and opt-in anchored-column revisions are deployed to a separate restored test copy.
Native tree inspection preserves a component entering a real neighboring interior. Four legacy
districts now have 2,943 support changes, with one changed command hall preserved; Ashfall uses
joists already. All four migrated districts repeat without further writes after rejoin.
Native retained-column preview and raised legacy wall-profile validation remain pending.
The release remains blocked on city acceptance, a fresh baseline and source-parity packaging.

Prior checkpoint (2026-11-04): **release blocked**. The archive below is preserved historical
output and now fails source-parity checks. A separate diagnostic template with explicit
`lock_template_options: false` and `base_game_version: [1,26,60]` now imports through
Create New World > Owned by me > Import templates and creates/loads a disposable world.
The builder and validators now require these header fields. That candidate uses archived city
data, not a release baseline. Corrected five-district validation copies now complete Ashfall
without stacking shared gatehouses, and its shared/paired/outer gates pass native checks.
A later balanced-layout copy completes with core services, five gardens and two kitchen farms;
its shared/paired/outer gates pass and three missing door pairs are repaired. A street-level school
check exposed pillars blocking its interior; guarded support repair clears the aisle, survives
rejoin and repeats without changes. Wider repair reaches all five districts; one command hall
is preserved because its live blocks differ from the original support plan. All five automated
gates pass with 1,454 tests and 52/52 gameplay stages, including the read-only wall audit,
notification changes, guarded wall/doorway maintenance, roof maintenance, tree-boundary
corrections, work budgets and protected-column caching. Native construction first hits Minecraft's
scripting watchdog; later saved-plan retries pass the unreadable cell and leaf-linked gate pause,
then complete 52,258 operations and all four Ashfall gate tests. Subsequent maintenance restores
2,537 wall/doorway blocks without failed writes; previously blocked doorway and wall samples
pass exact native reads. A further 330 wall targets are restored and Ashfall's repeat audit
confirms zero eligible air gaps and tree obstructions; other occupied and protected targets remain
preserved. The tree-refusal cache correction and its failing-before/passing-after regression
are included in the full pass. Complete city acceptance remains open. Neither the
offline pass nor this partial native result establishes a releasable city or fresh baseline.
The separate automatic Ledger delivery/menu/rejoin test passes natively.
Full visual/gameplay acceptance and a fresh starting baseline remain.
Source fixes clean newer development state and retain physical gate links during arming.
See [PROGRESS.md](PROGRESS.md) for current evidence. The original chat also records a prototype
completion in October; the older "offline-only" description below is historical and contradicted
by that chat evidence.

Status (2026-10-30): **built.** All five districts stand in a Minecraft world, the world was armed
with `civ:starter_arm confirm`, verified with `civ:starter_verify`, exported, and packaged as
`dist/templates/civapoc-starter.mctemplate` (17,345,764 bytes, 142 entries, sha256
`19d3dde36cc42a98db2dda05063dd308fe2b50d01a60e82f266270dd4567fc45`). All five are marked `built` in
`starter/template.json`, `starter/build-receipt.json` records the run, and
`npm run template:release-check` exits 0. The staged contents were reopened in game and verified
(section 9); importing the archive through Minecraft's own import UI is the one step **not** done -
this machine has no `.mctemplate` file association. The 49x49 prototype remains offline-only per
`docs/PHYSICAL_DISTRICT_DESIGN.md`.

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
- Include an explicit boolean `header.lock_template_options` and the authored
  `header.base_game_version`; both are stored in `starter/template.json` and checked before
  export. The current values were exercised in a successful native import/create test.
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

Steps 1-5 happen inside Minecraft. As a run they were performed on 2026-10-30, in the world
"CivTest Hearthgate" (Bedrock 1.26.52): the five districts were added to the development save
district by district as they were built, and that save was then returned to a shippable state, armed,
verified and exported (`starter/build-receipt.json`, `dist/export/CivTest-Hearthgate.mcworld`).
Steps 6-7 are offline and now pass. Step 8 was only partly exercised: the staged tree was copied into
`minecraftWorlds` and opened in the game (it verified as armed, below), but the `.mctemplate` archive
was never imported through Minecraft's own import UI - this machine has no `.mctemplate` file
association.

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
   It exits nonzero until all five districts are marked built, required and receipted. For this
   release it exits 0 (5/5 districts, receipt present, archive present); only then does
   adding `--zip` to step 6 produce `dist/templates/civapoc-starter.mctemplate`. With fewer than five
   districts the packager refuses, because a one-district archive named as the starting kingdom would
   misrepresent the game.
8. **Install for a test**: double-click `dist/templates/civapoc-starter.mctemplate` (importing the same
   UUID twice needs the old copy removed from `com.mojang\world_templates` first), then
   *Create New > Imported Templates*. The builder prints the artifact's `sha256`; record it with the
   receipt, because the file is reproducible and so a later rebuild can be proved identical.
   **Not exercised for this release**: no `.mctemplate` file association is registered on this machine,
   and dropping the folder into `com.mojang\world_templates` was not recognised by the game as an
   imported template. What was tested instead: the staged tree (`dist/templates/civapoc-starter`) was
   copied into `minecraftWorlds` and opened - see section 9.

The builder refuses a receipt that does not match `template.json` (`armed !== true`, wrong id,
`builtDistricts` missing a `builtRequired` entry, `jobPending !== 0`, non-integer centre).

## 6. Packaging checks (what `dev/validate-template.mjs` actually stops on)

Spec gate: valid/distinct/collide-free UUIDs, `moduleType = world_template`, `packageExtension =
mctemplate`, pack folder name ≤ 10 chars, pack source and manifest exist in the repo, `en_US` in
languages, `keepRandomSeed: false`, keep/wipe prefixes not overlapping, `civ:plan` kept, five districts
with unique ids/names/roles and unique `<name>-enlarged` layout ids, and `starterWorld: true` only for
a district whose layout is registered in `districtplan.ENLARGED_LAYOUTS` and whose status is not
`planned`. The last rule is the one that stops an incomplete template being called finished: it
refused packaging while any starter district was still `planner-ready`, printing *"N starter
district(s) are planner-ready but not physically built ... template:release-check must refuse packaging
until each one is built and verified in Minecraft"*. For this release all five are marked `built`, so
the validator reports no such note - and `dev/test/template.test.mjs` keeps both sides covered by
flipping one district back to `planner-ready` on a clone and asserting the refusal returns.

Package gate: required files present (`level.dat`, `levelname.txt`, `db/CURRENT`), no forbidden residue
(`db/*.tmp`, `db/DIM*/`, `level.dat_new`, `world_behavior_packs.json.bak`), `level.dat` parses as
Bedrock NBT with an integer spawn inside the receipt radius, generator is `infinite`, the bound pack
uuid exists in `behavior_packs/*/manifest.json`, the template `manifest.json` and `texts/` are correct,
and the size stays under `maxWorldBytes` (256 MB).

## 7. Full-release gate: a staged preview is not a release

**Development staging is not the finished product.** The starter spec asks for five starter-world
districts and refuses packaging until each is marked `built` *and* receipted. For this release all
five are marked `built`, all five stand physically in the packaged world (built in the development
save between 2026-10-26 and 2026-10-30, `docs/PROGRESS.md`), and the receipt attests the run.
The earlier packager could create a `.mctemplate` when just Hearthgate was marked complete.
That was suitable for an experiment but misleading as a five-district release.

Before publishing, run:

```shell
npm run template:release-check
```

It reports the five required districts and exits nonzero if any is missing or unreceipted. The regular
`node dev/build-template.mjs --world <export> --receipt <receipt>` command can still **stage** a
development world for review, but **adding `--zip` now refuses to create a release archive** until:

- All five original districts are explicitly marked `starterWorld: true, status: "built"` in
  `starter/template.json` and listed exactly once in `starter.builtRequired`.
- All five have genuinely been built and inspected in the saved world that was packaged (the
  development save, reset by arming rather than reused as-is), and their layouts are registered by
  the planner. The in-game `civ:starter_arm confirm` also enforces all five through the mirrored
  `STARTER.builtRequired` configuration.
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
2. Done: every entry carries `starterWorld: true`, and all five now carry `status: "built"` - each
   moved to `built` only after that district had been built and inspected in the world being packaged.
3. Done (2026-10-30): all five districts were built in ring order, one `civ:generate` job each. The
   world was then returned to a shippable state, armed (`civ:starter_arm confirm`), verified
   (`civ:starter_verify`: five complete districts, 400/150, 0 pending jobs, no wiped keys) and
   exported; `--zip` produced the archive. See `docs/PROGRESS.md`.
4. Inter-district wall/gate links come from the master plan's shared chains; the gate registry keeps
   them closable, so the template still ships with `auto` gates.

## 9. What was tested in Minecraft, and what was not

Checked on 2026-10-30, in a copy of the staged tree opened directly from `minecraftWorlds`
(Bedrock 1.26.52; the `.mctemplate` import path itself was not exercised - section 5, step 8):

- the world opened without running any generation, and the player stood beside Heartgate at the
  saved spawn (-187, 90, -621; the world's own spawn is -187, 56, -621);
- the join message read *"Civilization Apocalypse: 5 districts, 400 civilians, 150 soldiers"*, so the
  armed kingdom really did ride inside `db/`;
- `civ:status` answered with all five district lines (80 civilians each, ~30 soldiers each with the
  small losses the siege had already caused) and the live situation block - the city, its people and
  the simulation all came from the packaged files;
- `civ:starter_status` reported the kept key prefixes (`civ:kingdom`, `civ:plan`, `civ:gatereg`,
  `civ:gate_`), nothing wiped on arming, and refused to re-arm: *"this world is already armed as
  'civapoc-starter' - re-arming would discard play state"* (the fail-closed step);
- `civ:starter_verify` reported *Armed as 'civapoc-starter' v1.0.0*, five built districts, master plan
  stored, no development keys - and, because that copy had been left running for six simulated hours,
  a drifted population (410/147) rather than the baseline, which it named honestly.

Still not tested, and nothing here claims otherwise:

- importing the `.mctemplate` through the game's own *Create New > Imported Templates* UI;
- quitting and rejoining a world made from the template (dynamic-property persistence across a
  second load);
- post-ship expansion: `civ:generate_plan` for district 2 against the shipped plan;
- the old 49x49 `district.physical` prototype world was not opened or generated in during this run.

## 10. Known limitations

- **The template has been built, but not imported through the game UI.** The archive exists, passes
  every offline check, and its staged contents were opened as a world and verified in game (section 9);
  step 8 of section 5 is the one part of the workflow still unperformed.
- Offline tooling cannot read simulation state out of `db/`; the receipt is a signed human step, not a
  cryptographic guarantee.
- All five districts have now been placed in a world, and the build-time surprises they hit are
  recorded in `docs/PROGRESS.md`: a ticking-area chunk hold needs the player standing near the tile that
  is loading, and trees whose neighbours included melon, cocoa or bamboo were left standing on built lots.
  Blocks between the built districts and the survey edge (rivers, cliffs) were only inspected where the
  districts reached; the packaged world is the evidence of what shipped.
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
