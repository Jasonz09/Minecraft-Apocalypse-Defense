import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fullReleaseProblems, starterConfigProblems, RELEASE_DISTRICT_IDS } from "../lib/release-readiness.mjs";
import { nbt, writeLevelDat } from "../lib/nbt.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const current = JSON.parse(readFileSync(join(root, "starter", "template.json"), "utf8"));
const example = JSON.parse(readFileSync(join(root, "starter", "build-receipt.example.json"), "utf8"));
/** The real pack rules, imported the way the release CLI reads them. */
const { STARTER: packStarter } = await import(pathToFileURL(join(root, "CivilizationApocalypse_BP", "scripts", "config.js")).href);

const copy = (v) => JSON.parse(JSON.stringify(v));
function finished() {
    const spec = copy(current);
    const receipt = copy(example);
    spec.starter.builtRequired = [...RELEASE_DISTRICT_IDS];
    for (const district of spec.districts) {
        district.starterWorld = true;
        district.status = "built";
    }
    receipt.builtDistricts = [...RELEASE_DISTRICT_IDS];
    receipt.verifiedBy = "Verified in a fresh Bedrock test world, 2026-10-18";
    return { spec, receipt };
}

test("a planner-ready spec is STILL not a releasable five-district template", () => {
    const problems = fullReleaseProblems(current, example);
    const text = problems.join(" | ");
    // All five layouts are registered and marked starter districts, and the example receipt lists all
    // five - yet nothing has been built in Minecraft, so "status: planner-ready" must keep it red.
    for (const id of ["district-1", "district-2", "district-3", "district-4", "district-5"]) {
        assert.match(text, new RegExp(`${id} is not marked starterWorld`), `${id} must be reported as not physically built`);
    }
    assert.match(text, /verifiedBy must record actual in-game verification/, "the example receipt is a placeholder and must never pass");
});

test("fully built five-district spec and signed receipt clear the release check", () => {
    const { spec, receipt } = finished();
    assert.deepEqual(fullReleaseProblems(spec, receipt), []);
});

test("release refuses omitted, duplicate or falsely completed districts", () => {
    const cases = [
        ["starterWorld withdrawn from district-2", ({ spec }) => { spec.districts[1].starterWorld = false; }, /district-2 is not marked starterWorld/],
        ["district-3 downgraded from built", ({ spec }) => { spec.districts[2].status = "planner-ready"; }, /district-3 is not marked starterWorld/],
        ["district-5 dropped from builtRequired", ({ spec }) => { spec.starter.builtRequired.pop(); }, /district-5 is not in starter\.builtRequired/],
        ["builtRequired lists district-1 twice", ({ spec }) => { spec.starter.builtRequired = ["district-1", "district-1", "district-3", "district-4", "district-5"]; }, /builtRequired must contain exactly the five original districts/],
        ["receipt drops district-5", ({ receipt }) => { receipt.builtDistricts.pop(); }, /district-5 is not in the signed build receipt/],
        ["receipt lists district-1 twice", ({ receipt }) => { receipt.builtDistricts = ["district-1", "district-1", "district-3", "district-4", "district-5"]; }, /builtDistricts must contain exactly the five original districts/],
        ["two district records share an id", ({ spec }) => { spec.districts[4].id = "district-4"; }, /exactly the five original district records/],
    ];
    for (const [label, mutate, expected] of cases) {
        const options = finished();
        mutate(options);
        assert.match(fullReleaseProblems(options.spec, options.receipt).join(" | "), expected, `${label} must be refused`);
    }
});

test("release refuses nonbaseline population, active jobs, and unverified receipts", () => {
    const cases = [
        ["world not armed", ({ receipt }) => { receipt.armed = false; }, /must confirm the development world was armed/],
        ["four districts instead of five", ({ receipt }) => { receipt.districts = 4; }, /five-district 400-civilian 150-soldier baseline/],
        ["civilians off the published baseline", ({ receipt }) => { receipt.civilians = 399; }, /five-district 400-civilian 150-soldier baseline/],
        ["soldiers off the published baseline", ({ receipt }) => { receipt.soldiers = 149; }, /five-district 400-civilian 150-soldier baseline/],
        ["a construction job still queued", ({ receipt }) => { receipt.jobPending = 1; }, /zero pending construction jobs/],
        ["no verification recorded", ({ receipt }) => { receipt.verifiedBy = ""; }, /verifiedBy must record actual in-game verification/],
        ["verification left as the example text", ({ receipt }) => { receipt.verifiedBy = "civ:starter_verify output pasted here"; }, /verifiedBy must record actual in-game verification/],
        ["receipt belongs to another template", ({ receipt }) => { receipt.templateId = "another-template"; }, /templateId must match/],
    ];
    for (const [label, mutate, expected] of cases) {
        const options = finished();
        mutate(options);
        assert.match(fullReleaseProblems(options.spec, options.receipt).join(" | "), expected, `${label} must be refused`);
    }
});

test("a missing receipt is refused rather than treated as an empty one", () => {
    const { spec } = finished();
    assert.match(fullReleaseProblems(spec, null).join(" | "), /must confirm the development world was armed/);
    assert.match(fullReleaseProblems(spec, undefined).join(" | "), /five-district 400-civilian 150-soldier baseline/);
});

test("the receipt must also carry the city centre the spawn check is measured against", () => {
    const cases = [
        ["no centre", ({ receipt }) => { receipt.centre = undefined; }, /integer centre/],
        ["fractional centre", ({ receipt }) => { receipt.centre = { x: 1.5, z: 0 }; }, /integer centre/],
        ["no radius", ({ receipt }) => { receipt.radius = 0; }, /positive radius/],
        ["no world name", ({ receipt }) => { receipt.worldName = ""; }, /receipt\.worldName/],
        ["no Minecraft version", ({ receipt }) => { receipt.minecraftVersion = "  "; }, /receipt\.minecraftVersion/],
    ];
    for (const [label, mutate, expected] of cases) {
        const options = finished();
        mutate(options);
        assert.match(fullReleaseProblems(options.spec, options.receipt).join(" | "), expected, `${label} must be refused`);
    }
});

test("the pack's own arming rules agree with the shipped spec today", () => {
    assert.deepEqual(starterConfigProblems(current, packStarter), [], "config.js STARTER and starter/template.json must agree before anything else is checked");
});

test("the release gate refuses when the game would arm fewer districts than the spec claims", () => {
    // The hole this closes: template.json + receipt can say "five built" while `civ:starter_arm
    // confirm` still accepts a Hearthgate-only world, and the gate would print READY.
    const cases = [
        ["the pack would arm only Hearthgate", (starter) => { starter.builtRequired = ["district-1"]; }, /builtRequired .*does not match template\.json/],
        ["keep list drifted", (starter) => { starter.keepKeyPrefixes = ["civ:kingdom"]; }, /keepKeyPrefixes drifted/],
        ["wipe list drifted", (starter) => { starter.wipeKeyPrefixes = ["civ:jobs"]; }, /wipeKeyPrefixes drifted/],
        ["template id differs", (starter) => { starter.templateId = "something-else"; }, /templateId .*!= template\.json/],
        ["version differs", (starter) => { starter.templateVersion = [9, 9, 9]; }, /templateVersion must equal/],
    ];
    for (const [label, mutate, expected] of cases) {
        const starter = JSON.parse(JSON.stringify(packStarter));
        mutate(starter);
        const spec = finished().spec; // claims all five are starter districts
        assert.match(starterConfigProblems(spec, starter).join(" | "), expected, `${label} must be refused`);
    }
    assert.match(starterConfigProblems(finished().spec, undefined).join(" | "), /could not be read/);
    // and the same spec, once the pack agrees, is clean:
    const aligned = JSON.parse(JSON.stringify(packStarter));
    aligned.builtRequired = [...RELEASE_DISTRICT_IDS];
    assert.deepEqual(starterConfigProblems(finished().spec, aligned), [], "a five-district spec plus a five-district pack must pass");
});

test("a blocked release still stages, and the staged folder carries its own warning", () => {
    const source = join(root, "dist", "preview-source");
    const out = join(root, "dist", "preview-out");
    const builder = join(root, "dev", "build-template.mjs");
    try {
        mkdirSync(join(source, "db"), { recursive: true });
        writeFileSync(join(source, "levelname.txt"), "CIVBUILD-preview\n");
        writeFileSync(join(source, "db", "CURRENT"), "MANIFEST-000004\n");
        // A real-shaped level.dat, so the only thing standing between this and a release is the
        // five-district gate - a staging failure here would prove nothing about the marker.
        writeFileSync(join(source, "level.dat"), writeLevelDat({ Level: nbt.compound({
            Name: nbt.string("CIVBUILD-preview"), Generator: nbt.int(1),
            SpawnX: nbt.int(0), SpawnY: nbt.int(70), SpawnZ: nbt.int(0), RandomSeed: nbt.long(7),
            GameType: nbt.int(1), SizeSuitableForWorldVersion: nbt.int(1) }) }));

        const staged = spawnSync(process.execPath, [builder, "--world", source, "--out", out, "--receipt", join(root, "starter", "build-receipt.example.json")], { encoding: "utf8" });
        assert.equal(staged.status, 0, `${staged.stdout}\n${staged.stderr}`);
        assert.match(staged.stdout, /staged as DEVELOPMENT PREVIEW/);
        const marker = join(out, current.templateId, "DEVELOPMENT-PREVIEW.txt");
        assert.ok(existsSync(marker), "a preview that cannot be released must say so from inside the folder");
        assert.match(readFileSync(marker, "utf8"), /THIS IS NOT A RELEASE/);
        assert.match(readFileSync(marker, "utf8"), /district-2/, "the marker must name the missing districts, not just warn");

        const zipped = spawnSync(process.execPath, [builder, "--world", source, "--out", out, "--receipt", join(root, "starter", "build-receipt.example.json"), "--zip"], { encoding: "utf8" });
        assert.notEqual(zipped.status, 0, "--zip is the shipping route and must stay refused");
        assert.match(`${zipped.stdout}${zipped.stderr}`, /five-district release is NOT ready/);
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
    }
});

test("packager rejects staging paths overlapping source or temporary extraction, without deleting anything", () => {
    const builder = join(root, "dev", "build-template.mjs");
    const source = join(root, "dist", "never-touch-source");
    const sentinel = join(source, "level.dat");
    try {
        // A source that really exists: the guard must refuse before the builder rmSync's its staging
        // directory, and the only way to prove that is to leave something there to be deleted.
        mkdirSync(source, { recursive: true });
        writeFileSync(sentinel, "not-a-real-world-but-a-witness");

        for (const out of [join(root, "dist", "work"), source]) {
            const run = spawnSync(process.execPath, [builder, "--world", source, "--out", out], { encoding: "utf8" });
            assert.notEqual(run.status, 0, `--out ${out} must be refused before anything is written`);
            assert.match(`${run.stdout}${run.stderr}`, /overlaps|refusing --out/i);
        }
        assert.ok(existsSync(sentinel), "a refused --out must not have deleted the source world");
        assert.equal(readFileSync(sentinel, "utf8"), "not-a-real-world-but-a-witness");
        assert.equal(existsSync(join(root, "dist", "work", current.templateId)), false, "the refusal must not have staged into dist/work");
    } finally {
        rmSync(source, { recursive: true, force: true });
    }
});
