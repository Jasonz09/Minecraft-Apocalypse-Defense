import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { levelSection, nbt, readLevelDat, writeLevelDat } = await import(pathToFileURL(join(projectRoot, "dev", "lib", "nbt.mjs")).href);
const { collectEntries, crc32, entryParts, extractZip, listZip, readZipEntry, writeZip } = await import(pathToFileURL(join(projectRoot, "dev", "lib", "zip.mjs")).href);
const { validateTemplateDir, validateTemplateSpec } = await import(pathToFileURL(join(projectRoot, "dev", "validate-template.mjs")).href);
const starter = await load("sim", "starter.js");
const districtplan = await load("civ", "districtplan.js");
const { STARTER, STARTER_EVENT_IDS } = await load("config.js");

const SPEC = JSON.parse(readFileSync(join(projectRoot, "starter", "template.json"), "utf8"));
const layouts = Object.fromEntries(Object.entries(districtplan.ENLARGED_LAYOUTS ?? {}).map(([index, id]) => [Number(index), id]));

/**
 * A synthetic but format-correct Bedrock level.dat. `Generator` is an **Int** (1 = infinite) and the
 * seed is `RandomSeed` (Long), exactly as the level format documents them: a fixture that invented
 * friendlier types would let the validator pass on nothing but fixtures.
 */
function makeLevelDat({ spawn = { x: 12, y: 70, z: -34 }, generator = 1, seed = 12345 } = {}) {
    return writeLevelDat({
        Level: nbt.compound({
            Name: nbt.string("CIVBUILD-hearthgate"),
            Generator: nbt.int(generator),
            SpawnX: nbt.int(spawn.x),
            SpawnY: nbt.int(spawn.y),
            SpawnZ: nbt.int(spawn.z),
            RandomSeed: nbt.long(seed),
            GameType: nbt.int(1),
            Version: nbt.intArray([1, 2, 3]),
            SizeSuitableForWorldVersion: nbt.int(1),
        }),
    });
}

function stageWorld(overrides = {}) {
    const dir = mkdtempSync(join(tmpdir(), "civtemplate-"));
    const written = new Set();
    const put = (file, contents) => {
        const target = join(dir, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, typeof contents === "string" ? contents : Buffer.from(contents));
        written.add(file);
    };
    put("level.dat", overrides.level ?? makeLevelDat());
    put("levelname.txt", "CIVBUILD-hearthgate\n");
    put("db/CURRENT", "MANIFEST-000004\n");
    put("db/000012.log", Buffer.from("fake-leveldb-payload"));
    if (overrides.behaviorPacks !== false) {
        put("world_behavior_packs.json", JSON.stringify([{ pack_id: JSON.parse(readFileSync(join(projectRoot, SPEC.packs[0].manifest), "utf8")).header.uuid, version: [1, 0, 0] }]));
    }
    if (overrides.pack !== false) {
        put(`behavior_packs/${SPEC.packs[0].packageDir}/manifest.json`, readFileSync(join(projectRoot, SPEC.packs[0].manifest), "utf8"));
    }
    put("manifest.json", JSON.stringify({ header: { name: "pack.name", description: "pack.description", version: [1, 0, 0], uuid: SPEC.manifest.headerUuid }, modules: [{ version: [1, 0, 0], type: "world_template", uuid: SPEC.manifest.moduleUuid }], format_version: 2 }));
    put("texts/en_US.lang", `pack.name=${SPEC.displayName}\npack.description=${SPEC.description}\n`);
    put("texts/languages.json", JSON.stringify(SPEC.languages));
    for (const [file, contents] of Object.entries(overrides.extra ?? {})) put(file, contents);
    return dir;
}

const receipt = { armed: true, templateId: SPEC.templateId, builtDistricts: ["district-1"], jobPending: 0, centre: { x: 12, z: -34 }, radius: 220 };

/* ------------------------------------------------------------------ spec */

test("the shipped starter spec validates against the real pack and planner", () => {
    const result = validateTemplateSpec(SPEC, { enlargedLayouts: layouts });
    assert.deepEqual(result.problems, [], result.problems.join(" | "));
    assert.ok(result.notes.some((note) => note.includes("prepared but not started")), "the four unbuilt districts should be reported as prepared, not hidden");
});

test("the spec gate actually fails on the packaging mistakes that matter", () => {
    const check = (mutate) => {
        const spec = JSON.parse(JSON.stringify(SPEC));
        mutate(spec);
        return validateTemplateSpec(spec, { enlargedLayouts: layouts }).problems;
    };

    assert.ok(check((s) => (s.packageExtension = "mcworld")).some((p) => p.includes("mctemplate")), "an .mcworld is an imported world, not a template");
    assert.ok(check((s) => (s.manifest.moduleType = "data")).some((p) => p.includes("world_template")));
    assert.ok(check((s) => (s.packs[0].packageDir = "CivilizationApocalypse_BP")).some((p) => p.includes("10 characters")), "long pack folder names can fail to load on Xbox");
    assert.ok(check((s) => (s.manifest.headerUuid = s.manifest.moduleUuid)).some((p) => p.includes("must differ")));
    assert.ok(
        check((s) => (s.packs[0].packageDir = "CivApocBpx", (s.manifest.headerUuid = JSON.parse(readFileSync(join(projectRoot, s.packs[0].manifest), "utf8")).header.uuid))).some((p) => p.includes("collide")),
        "a template uuid equal to a pack uuid makes import fail",
    );
    assert.ok(check((s) => (s.starter.keepKeyPrefixes = ["civ:kingdom"])).some((p) => p.includes("master plan")), "losing civ:plan would break future expansion");
    assert.ok(check((s) => s.starter.wipeKeyPrefixes.push("civ:kingdom")).some((p) => p.includes("both kept and wiped")));
    assert.ok(check((s) => (s.districts[1].starterWorld = true)).some((p) => p.includes("no layout registered")), "marking district 2 a starter district needs the planner to support it");
    assert.ok(check((s) => (s.districts[1].layoutId = "hearthgate")).some((p) => p.includes("prototype layout id")));
    assert.ok(check((s) => (s.districts[4].status = "planned", (s.districts[4].starterWorld = true))).some((p) => p.includes("would ship unbuilt")));
    assert.ok(check((s) => (s.languages = [])).some((p) => p.includes("en_US")));
    assert.ok(check((s) => (s.world.keepRandomSeed = true)).some((p) => p.includes("authored")));
});

/* ------------------------------------------------------------------ level.dat parsing */

test("level.dat round-trips as uncompressed little-endian Bedrock NBT", () => {
    const parsed = readLevelDat(makeLevelDat({ spawn: { x: -300, y: 64, z: 900 }, seed: 987654321 }));
    const level = levelSection(parsed.data);
    assert.equal(parsed.version, 8);
    assert.equal(level.Generator, 1);
    assert.deepEqual([level.SpawnX, level.SpawnY, level.SpawnZ], [-300, 64, 900]);
    assert.equal(level.RandomSeed, 987654321);
    assert.equal(level.SizeSuitableForWorldVersion, 1);
    assert.deepEqual(level.Version, [1, 2, 3]);
});

test("a Java Edition or truncated level.dat is refused, not misread", () => {
    assert.throws(() => readLevelDat(new Uint8Array([0x1f, 0x8b, ...new Uint8Array(64)])), /Java Edition/);
    assert.throws(() => readLevelDat(new Uint8Array([8, 0, 0, 0])), /too short/);
    const good = makeLevelDat();
    assert.throws(() => readLevelDat(good.slice(0, 20)), /too short|declares/);
    const truncated = Buffer.from(good);
    truncated.writeInt32LE(truncated.length + 500, 4);
    assert.throws(() => readLevelDat(new Uint8Array(truncated)), /declares/);
    // Long enough to clear the size guard, but its first tag is a list: must be named as
    // "not a compound", not silently parsed into something plausible.
    assert.throws(() => readLevelDat(new Uint8Array([8, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0])), /compound/);
});

/* ------------------------------------------------------------------ the package */

test("a correctly staged template directory passes every packaging check", () => {
    const dir = stageWorld();
    try {
        const result = validateTemplateDir(dir, SPEC, { receipt });
        assert.deepEqual(result.problems, [], result.problems.join(" | "));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("missing city data, bad pack bindings and a spawn outside the walls all fail the check", () => {
    const cases = [];

    const noDb = stageWorld({ extra: {} });
    rmSync(join(noDb, "db"), { recursive: true, force: true });
    cases.push(["db/", validateTemplateDir(noDb, SPEC, { receipt }).problems]);

    const badBind = stageWorld({ behaviorPacks: false });
    writeFileSync(join(badBind, "world_behavior_packs.json"), JSON.stringify([{ pack_id: "00000000-dead-beef-0000-000000000000", version: [1, 0, 0] }]));
    cases.push(["unknown bound pack", validateTemplateDir(badBind, SPEC, { receipt }).problems]);

    const farSpawn = stageWorld({ level: makeLevelDat({ spawn: { x: 5000, y: 70, z: 5000 } }) });
    cases.push(["spawn far from the city", validateTemplateDir(farSpawn, SPEC, { receipt }).problems]);

    const noLang = stageWorld();
    writeFileSync(join(noLang, "texts", "en_US.lang"), "pack.name=\n");
    cases.push(["empty pack.name", validateTemplateDir(noLang, SPEC, { receipt }).problems]);

    // 1 = infinite in a real level.dat; 2 is a flat world, i.e. not the authored kingdom.
    const flat = stageWorld({ level: makeLevelDat({ generator: 2 }) });
    cases.push(["a flat generator", validateTemplateDir(flat, SPEC, { receipt }).problems]);

    const noManifest = stageWorld();
    rmSync(join(noManifest, "manifest.json"));
    cases.push(["no template manifest.json (an imported world, not a template)", validateTemplateDir(noManifest, SPEC, { receipt }).problems]);

    const randomSeed = stageWorld();
    const manifest = JSON.parse(readFileSync(join(randomSeed, "manifest.json"), "utf8"));
    manifest.header.allow_random_seed = true;
    writeFileSync(join(randomSeed, "manifest.json"), JSON.stringify(manifest));
    cases.push(["allow_random_seed, which would regenerate the terrain under the city", validateTemplateDir(randomSeed, SPEC, { receipt }).problems]);

    const javaDims = stageWorld({ extra: { "db/DIM-1/data.2": "java dimension leftovers" } });
    cases.push(["db/DIM* residue from a Java world", validateTemplateDir(javaDims, SPEC, { receipt }).problems]);

    let seen = 0;
    for (const [label, problems] of cases) {
        assert.ok(problems.length > 0, `the validator accepted a package with ${label}`);
        seen += 1;
    }
    assert.equal(seen, 8);
    for (const dir of [noDb, badBind, farSpawn, noLang, flat, noManifest, randomSeed, javaDims]) rmSync(dir, { recursive: true, force: true });
});

test("a real-shaped level.dat (Generator as an Int) passes the packaging gate", () => {
    // The inverse of the case above: if the only level.dat that ever validates is one this repo
    // invented, the gate proves nothing about an export from Minecraft.
    const dir = stageWorld({ level: makeLevelDat() });
    try {
        const result = validateTemplateDir(dir, SPEC, { receipt });
        assert.deepEqual(result.problems, [], result.problems.join(" | "));
        assert.ok(result.notes.some((note) => note.includes("RandomSeed")), `the seed note should name the field it read: ${result.notes.join(" | ")}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an export without a receipt is refused, and with one the template stages and validates", () => {
    const source = stageWorld({ extra: { "db/LOCK": "", "db/000009.tmp": "stale leveldb junk" } });
    const out = join(projectRoot, "dist", "test-templates");
    const builder = join(projectRoot, "dev", "build-template.mjs");
    try {
        const noReceipt = spawnSync(process.execPath, [builder, "--world", source, "--out", out], { encoding: "utf8" });
        assert.notEqual(noReceipt.status, 0, "packaging without a receipt must fail");
        assert.match(`${noReceipt.stdout}${noReceipt.stderr}`, /receipt/);
        assert.ok(!existsSync(join(out, SPEC.templateId, "manifest.json")), "it must fail before staging anything");

        const withReceipt = spawnSync(process.execPath, [builder, "--world", source, "--out", out, "--receipt", join(projectRoot, "starter", "build-receipt.example.json")], { encoding: "utf8" });
        assert.equal(withReceipt.status, 0, `${withReceipt.stdout}\n${withReceipt.stderr}`);
        assert.match(withReceipt.stdout, /template staged and validated/);
        const staged = join(out, SPEC.templateId);
        assert.ok(existsSync(join(staged, "manifest.json")), "a template needs its own manifest.json");
        assert.ok(existsSync(join(staged, "level.dat")), "the authored terrain must ship");
        assert.ok(existsSync(join(staged, "db", "CURRENT")), "the city data lives in db/");
        assert.ok(existsSync(join(staged, "behavior_packs", SPEC.packs[0].packageDir, "manifest.json")), "the pack ships from the repository, current, not the world's stale copy");
        assert.ok(existsSync(join(staged, "texts", "languages.json")));
        assert.ok(!existsSync(join(staged, "db", "LOCK")), "LevelDB lock files are not portable");
        assert.ok(!existsSync(join(staged, "db", "000009.tmp")), "the forbidden db/*.tmp residue must not be copied");
        assert.ok(readFileSync(join(staged, "manifest.json"), "utf8").includes("world_template"));
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
    }
});

test("the packaged template is a spec-shaped zip: '/' separators, contents at the root, reproducible", () => {
    const source = stageWorld({ extra: { "db/LOCK": "", "db/000009.tmp": "stale leveldb junk" } });
    const out = join(projectRoot, "dist", "test-templates");
    const builder = join(projectRoot, "dev", "build-template.mjs");
    const receiptPath = join(projectRoot, "starter", "build-receipt.example.json");
    const artifact = join(out, `${SPEC.templateId}.${SPEC.packageExtension}`);
    try {
        const first = spawnSync(process.execPath, [builder, "--world", source, "--out", out, "--receipt", receiptPath, "--zip"], { encoding: "utf8" });
        assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
        const bytes = readFileSync(artifact);
        const entries = listZip(bytes);
        const names = entries.map((entry) => entry.name);

        assert.equal(names.filter((name) => name.includes("\\")).length, 0, "ZIP requires forward slashes; PowerShell's Compress-Archive writes backslashes and Minecraft must read this");
        assert.equal(names.filter((name) => name.startsWith(`${SPEC.templateId}/`)).length, 0, "zipping the containing folder makes the template un-importable");
        assert.ok(!!entries.find((entry) => entry.name === "manifest.json"));
        assert.ok(!!entries.find((entry) => entry.name === "db/CURRENT"), "without db/ there is no city to ship");
        assert.ok(!!entries.find((entry) => entry.name === "texts/en_US.lang"));
        assert.ok(!!entries.find((entry) => entry.name === `behavior_packs/${SPEC.packs[0].packageDir}/scripts/main.js`));
        assert.equal(names.filter((name) => name.startsWith("db/") && (name.endsWith(".tmp") || name.endsWith("LOCK"))).length, 0);

        // What went in must come back out unchanged, including the binary level.dat.
        const staged = join(out, SPEC.templateId);
        assert.deepEqual(
            names.slice().sort(),
            collectEntries(staged).map((entry) => entry.name).sort(),
            "the archive must hold exactly the validated staged tree",
        );
        const level = readZipEntry(bytes, entries.find((entry) => entry.name === "level.dat"));
        assert.deepEqual(level, readFileSync(join(staged, "level.dat")));
        assert.equal(levelSection(readLevelDat(level).data).Generator, 1, "and it still reads as an infinite generator after the round trip");

        const hashes = [createHash("sha256").update(bytes).digest("hex")];
        const again = spawnSync(process.execPath, [builder, "--world", source, "--out", out, "--receipt", receiptPath, "--zip"], { encoding: "utf8" });
        assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
        hashes.push(createHash("sha256").update(readFileSync(artifact)).digest("hex"));
        assert.equal(hashes[0], hashes[1], "the same staged tree must produce byte-identical packages, or a rebuilt template cannot be compared by hash");
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
    }
});

test("the zip codec stores, deflates and detects a damaged entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "civzip-"));
    const target = join(projectRoot, "dist", "test-zip.zip");
    mkdirSync(join(projectRoot, "dist"), { recursive: true });
    try {
        mkdirSync(join(dir, "sub"), { recursive: true });
        writeFileSync(join(dir, "text.txt"), "civilization apocalypse ".repeat(200)); // compresses
        // Deterministic pseudorandom bytes: deflate cannot shrink them, so the codec must store
        // the entry rather than pad the archive.
        const incompressible = Buffer.alloc(16384);
        let state = 0x9e3779b9;
        for (let i = 0; i < incompressible.length; i += 1) {
            state = (state * 1664525 + 1013904223) >>> 0;
            incompressible[i] = (state >>> 24) ^ (state & 0xff);
        }
        writeFileSync(join(dir, "sub", "noise.bin"), incompressible);
        writeFileSync(join(dir, "empty.txt"), "");

        const packed = writeZip(dir, target);
        assert.equal(packed.entries, 3);
        const bytes = readFileSync(target);
        const entries = listZip(bytes);
        assert.deepEqual(entries.map((entry) => entry.name).sort(), ["empty.txt", "sub/noise.bin", "text.txt"], "names are relative, rooted and use '/'");
        assert.equal(entries.find((entry) => entry.name === "text.txt").method, 8, "compressible data is deflated");
        assert.equal(entries.find((entry) => entry.name === "sub/noise.bin").method, 0, "incompressible data is stored instead of padded");

        for (const entry of entries) {
            const data = readZipEntry(bytes, entry);
            assert.deepEqual([...data], [...readFileSync(join(dir, entry.name))], `${entry.name} round-trips`);
            assert.equal(crc32(data), entry.crc);
        }

        // A reader that trusts CRC: one flipped payload byte must be named, not silently returned.
        // The stored entry is used deliberately - corrupting deflated data usually fails in the
        // decompressor first, which would not exercise the check this is about.
        const noise = entries.find((entry) => entry.name === "sub/noise.bin");
        const corrupted = Buffer.from(bytes);
        const dataStart = noise.localOffset + 30 + noise.name.length;
        corrupted[dataStart] ^= 0xff;
        assert.throws(() => readZipEntry(corrupted, listZip(corrupted).find((entry) => entry.name === "sub/noise.bin")), /CRC/);
        assert.throws(() => listZip(Buffer.from("this is not a zip archive at all")), /end-of-central-directory/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(target, { force: true });
    }
});

test("an exported .mcworld is read back by our own reader, and hostile entry names are refused", () => {
    const source = stageWorld();
    const dist = join(projectRoot, "dist");
    const mcworld = join(dist, "test-export.mcworld");
    const out = join(dist, "test-templates");
    const extracted = join(dist, "test-extract");
    try {
        mkdirSync(dist, { recursive: true });
        writeZip(source, mcworld);

        // The reader is what turns a real export into a staging tree; check it reproduces every byte.
        extractZip(mcworld, extracted);
        const roundTrip = collectEntries(extracted);
        assert.deepEqual(roundTrip.map((entry) => entry.name), collectEntries(source).map((entry) => entry.name));
        for (const entry of roundTrip) {
            assert.ok(readFileSync(entry.absolute).equals(readFileSync(join(source, entry.name))), `${entry.name} must extract byte-identical`);
        }

        const run = spawnSync(process.execPath, [join(projectRoot, "dev", "build-template.mjs"), "--world", mcworld, "--out", out, "--receipt", join(projectRoot, "starter", "build-receipt.example.json")], { encoding: "utf8" });
        assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
        assert.ok(existsSync(join(out, SPEC.templateId, "db", "CURRENT")), "the city data must survive the zip round trip");

        assert.deepEqual(entryParts("db/CURRENT"), ["db", "CURRENT"]);
        assert.deepEqual(entryParts("behavior_packs\\CivApocBP\\manifest.json"), ["behavior_packs", "CivApocBP", "manifest.json"], "backslash names are normalised, not extracted as one weird file");
        for (const hostile of ["../escape.txt", "db/../../escape.txt", "/etc/passwd", "C:/Users/me/escape.txt", "..", "db/../db/CURRENT"]) {
            assert.throws(() => entryParts(hostile), /refusing|not a file name/i, `${hostile} must never be written`);
        }
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(extracted, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
        rmSync(mcworld, { force: true });
    }
});

test("the builder refuses to write outside dist/", () => {
    const source = stageWorld();
    const escape = join(tmpdir(), "definitely-not-in-dist");
    // A sibling of dist/ shares its *string* prefix, and the builder deletes the staging directory
    // before rebuilding it - a prefix test would have it rmSync outside dist/.
    const sibling = join(projectRoot, "distribution");
    try {
        const run = spawnSync(process.execPath, [join(projectRoot, "dev", "build-template.mjs"), "--world", source, "--out", escape], { encoding: "utf8" });
        assert.notEqual(run.status, 0);
        assert.match(`${run.stdout}${run.stderr}`, /outside dist/);
        assert.ok(!existsSync(join(escape, SPEC.templateId)));

        const near = spawnSync(process.execPath, [join(projectRoot, "dev", "build-template.mjs"), "--world", source, "--out", sibling], { encoding: "utf8" });
        assert.notEqual(near.status, 0, "a directory whose name merely starts with 'dist' is not inside dist/");
        assert.match(`${near.stdout}${near.stderr}`, /outside dist/);
        assert.ok(!existsSync(sibling), "the refused path must not have been created or deleted");
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(escape, { recursive: true, force: true });
        rmSync(sibling, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------------------ arming decisions */

test("key classification keeps the world's truth and wipes development residue", () => {
    const keys = ["civ:kingdom", "civ:kingdom-quarantine", "civ:plan:meta", "civ:plan:plan:0", "civ:jobs:meta", "civ_devgate", "civ_gatereg", "civ_gate_gate-1", "civ:demo-build", "some_other_pack:key"];
    const classified = starter.classifyStarterKeys(keys);
    assert.ok(classified.keep.includes("civ:kingdom"), "the kingdom baseline ships");
    assert.ok(classified.keep.includes("civ:plan:meta") && classified.keep.includes("civ:plan:plan:0"), "the master plan ships");
    assert.ok(classified.keep.includes("civ_gatereg") && classified.keep.includes("civ_gate_gate-1"), "gate records describe the built world");
    assert.ok(classified.wipe.includes("civ:kingdom-quarantine"), "quarantined dev blobs must not ship");
    assert.ok(classified.wipe.includes("civ:jobs:meta"), "an unfinished job queue must not ship");
    assert.ok(classified.wipe.includes("civ_devgate"), "the districts 2-5 development unlock must not ship");
    assert.ok(classified.wipe.includes("civ:demo-build"));
    assert.deepEqual(classified.unknown, ["some_other_pack:key"], "another add-on's keys are left alone");
    assert.deepEqual(
        starter.classifyStarterKeys(["civ:debug", "civ:debug_build"]),
        { keep: [], wipe: ["civ:debug", "civ:debug_build"], unknown: [] },
        "debug state must not reach a player",
    );
    assert.deepEqual(starter.classifyStarterKeys([]).wipe, []);
    assert.equal(STARTER.keepKeyPrefixes.length, starter.classifyStarterKeys ? STARTER.keepKeyPrefixes.length : 0);
});

test("arming resets the simulation but keeps the records of the built city", async () => {
    const devWorld = {
        name: "Civilization Apocalypse",
        seed: 4242,
        districts: [
            { id: "district-1", name: "Hearthgate", civilians: 612, soldiers: 41, refugees: 37, civ: { status: "complete", seed: 9, startedStep: 3, anchor: { x: 10, z: 20 }, centre: { x: 12, z: 22 }, checksum: "abcd", stage: "dressing" }, projects: [] },
            { id: "district-2", name: "Ironquarry", civilians: 80, soldiers: 30, projects: [] },
        ],
        step: 5000,
    };
    const notes = [];
    const baseline = starter.buildStarterBaseline({ current: devWorld, armedAtStep: 0, notes });

    assert.equal(baseline.districts.length, 5);
    const first = baseline.districts[0];
    assert.equal(first.civilians, 80, "dev population must not ship");
    assert.equal(first.soldiers, 30, "a war-weakened garrison must not ship");
    assert.equal(first.refugees, 0, "dev evacuee bookkeeping must not ship");
    assert.equal(first.civ.status, "complete", "the fact that Hearthgate is physically built must ship");
    assert.equal(baseline.districts[1].civ, undefined, "an unbuilt district must not gain a build record");
    assert.equal(baseline.starter.templateId, SPEC.templateId);
    assert.equal(baseline.starter.sourceSeed, 4242);
    assert.equal(baseline.step, 0);
    assert.ok(notes.some((note) => /population reset/.test(note)), notes.join(" | "));
    const { findValidationProblems } = await load("kingdom", "state.js");
    assert.deepEqual(findValidationProblems(baseline), [], "the baseline must be savable");
});

test("arming refuses an unfinished or already-armed world", () => {
    const built = { districts: [{ id: "district-1", civ: { status: "complete" } }] };
    const settled = { status: "ok", units: 1, overrides: [], moving: [] };
    const base = { kingdom: built, planPresent: true, gates: settled, job: { pending: 0, status: "ok" }, builtRequired: ["district-1"] };
    assert.deepEqual(starter.starterArmProblems(base), []);

    assert.match(starter.starterArmProblems({ ...base, kingdom: undefined }).join(" "), /generate the city first/);
    assert.match(starter.starterArmProblems({ ...base, planPresent: false }).join(" "), /master plan is not stored/);
    assert.match(starter.starterArmProblems({ ...base, planPresent: false, planStoredKeys: true, planStatus: "corrupt" }).join(" "), /master plan cannot be read .*corrupt/);
    assert.match(starter.starterArmProblems({ ...base, job: { pending: 0, status: "corrupt" } }).join(" "), /job queue reads as 'corrupt'/);
    assert.match(starter.starterArmProblems({ ...base, job: { pending: 12 } }).join(" "), /12 construction job element/);
    assert.match(starter.starterArmProblems({ ...base, gates: { status: "ok", units: 2, overrides: ["g (mode 'forced_closed')"], moving: [] } }).join(" "), /return every gate to auto/);
    assert.match(starter.starterArmProblems({ ...base, gates: { status: "ok", units: 2, overrides: [], moving: ["g -> closed"] } }).join(" "), /still moving/);
    assert.match(starter.starterArmProblems({ ...base, gates: { status: "corrupt", units: 0, overrides: [], moving: [] } }).join(" "), /gate registry reads as 'corrupt'/);
    assert.match(starter.starterArmProblems({ ...base, planningRunning: true, planningDescription: "plan session (running)" }).join(" "), /generation session is still running .*plan session/);
    assert.match(starter.starterArmProblems({ kingdom: { districts: [{ id: "district-1", civ: { status: "building" } }] }, planPresent: true }).join(" "), /still under construction/);
    assert.match(
        starter.starterArmProblems({ ...base, kingdom: { districts: [{ id: "district-1", civ: { status: "paused", stage: "walls" } }] } }).join(" "),
        /build paused at 'walls'/,
    );
    assert.match(
        starter.starterArmProblems({ ...base, kingdom: { districts: [{ id: "district-1", civ: { status: "complete" }, physical: { status: "building" } }] } }).join(" "),
        /prototype district build is still in progress/,
    );
    assert.match(
        starter.starterArmProblems({ ...base, kingdom: { ...built, starter: { templateId: SPEC.templateId } } }).join(" "),
        /already armed/,
    );
});

test("the release contract is the same in config.js and starter/template.json", () => {
    // Both lists are read at ship time - the pack from the game, the package gate from the JSON - and
    // arming that wipes what the planner needs is unrecoverable in a player's world.
    assert.equal(STARTER.templateId, SPEC.templateId, "the stamped template id and the packaged one must agree");
    assert.deepEqual(STARTER.templateVersion, SPEC.templateVersion);
    assert.deepEqual(STARTER.keepKeyPrefixes, SPEC.starter.keepKeyPrefixes, "keep lists drifted between config.js and template.json");
    assert.deepEqual(STARTER.wipeKeyPrefixes, SPEC.starter.wipeKeyPrefixes, "wipe lists drifted between config.js and template.json");
    assert.deepEqual(STARTER.builtRequired, SPEC.starter.builtRequired, "which districts must be built before arming drifted");
    assert.equal(STARTER.keepKeyPrefixes.includes("civ:plan"), true, "arming that wipes the master plan would strand districts 2-5 forever");
    assert.equal(STARTER.wipeKeyPrefixes.includes("civ:plan"), false);
    assert.equal(STARTER.wipeKeyPrefixes.includes("civ:kingdom"), false, "the kingdom is reset by writing a baseline, never deleted");
});

test("the starter read-out agrees with the state it describes", () => {
    const described = starter.describeStarterState({
        kingdom: { districts: [{ id: "district-1", civilians: 80, soldiers: 30, civ: { status: "complete" } }, { id: "district-2", civilians: 80, soldiers: 30 }], starter: { templateId: "civapoc-starter", templateVersion: [1, 0, 0] } },
        keys: ["civ:kingdom", "civ:jobs:meta"],
        gates: { status: "ok", units: 4, overrides: [], moving: [] },
        job: { pending: 3 },
    });
    assert.equal(described.armed, "civapoc-starter");
    assert.equal(described.civilians, 160);
    assert.equal(described.districts, 2);
    assert.equal(described.gates, 4);
    assert.deepEqual(described.builtDistricts, ["district-1"]);
    assert.equal(described.jobPending, 3);
    assert.deepEqual(described.wipeKeys, ["civ:jobs:meta"]);
    assert.equal(starter.STARTER_EXPECTED_POPULATION.civilians, 400);
});

/* ------------------------------------------------------------------ join-time safety */

test("joining never triggers terrain work or generation", async () => {
    const welcome = readFileSync(join(scriptsRoot, "events", "welcome.js"), "utf8");
    const main = readFileSync(join(scriptsRoot, "main.js"), "utf8");
    const starterCommands = readFileSync(join(scriptsRoot, "commands", "starter.js"), "utf8");
    for (const source of [welcome, main]) {
        assert.doesNotMatch(source, /civScan|siteprofile|analyzeTerrain|requestChunk|addTickingArea|generateWork|survey/i, "join path must not reach for terrain scanning");
    }
    assert.doesNotMatch(welcome, /planCivilization|planDistrictSite|civ:generate/, "the join handler must not plan or build anything");
    assert.match(starterCommands, /civ:starter_arm|STARTER_EVENT_IDS\.arm/);
    assert.match(starterCommands, /args\[0\] !== "confirm"/, "arming must need a second, deliberate argument");

    const ids = Object.values(STARTER_EVENT_IDS);
    assert.equal(ids.length, 3);
    for (const id of ids) {
        assert.equal(id.split(":").length, 2, `${id} must have exactly one colon`);
        assert.match(id, /^civ:[a-z_]+$/, `${id} must be a lowercase civ: identifier`);
    }
});
