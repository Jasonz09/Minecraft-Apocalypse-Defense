import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip, writeZip } from "./lib/zip.mjs";
import { validateTemplateDir } from "./validate-template.mjs";

/**
 * Build a shippable `.mctemplate` from an ARMED development world.
 *
 * The source world is only ever read. Everything is written into dist/ inside this repository,
 * and the only things removed are staging paths this script created under dist/. Existing
 * Minecraft worlds and packs are never touched.
 *
 * Pipeline (see docs/STARTER_WORLD.md):
 *   1. in a dedicated build world: civ:generate, then civ:starter_arm confirm
 *   2. Minecraft > Play > Edit > Export World  ->  a folder or a .mcworld
 *   3. node dev/build-template.mjs --world <that export> --receipt starter/build-receipt.json --zip
 *   4. node dev/validate-template.mjs --world dist/templates/<id>
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(projectRoot, "starter", "template.json"), "utf8"));

/** Files copied straight out of the exported world. Everything else is dropped on purpose. */
const WORLD_FILES = ["level.dat", "level.dat_old", "levelname.txt", "world_icon.jpeg", "world_behavior_packs.json", "world_resource_packs.json", "world_behavior_pack_history.json", "world_resource_pack_history.json"];

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

function copyTree(from, to, filter) {
    ensureDir(to);
    let copied = 0;
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = join(from, entry.name);
        const target = join(to, entry.name);
        if (entry.isDirectory()) {
            copied += copyTree(source, target, filter);
        } else if (!filter || filter(entry.name)) {
            ensureDir(dirname(target));
            copyFileSync(source, target);
            copied += 1;
        }
    }
    return copied;
}

function parseArgs(argv) {
    /** @type {Record<string, string | boolean>} */
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (!argv[i].startsWith("--")) continue;
        const name = argv[i].slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            out[name] = true;
        } else {
            out[name] = next;
            i += 1;
        }
    }
    return out;
}

/** A .mcworld is a zip; expand it into dist so nothing in the user's folders is modified. */
function materialiseSource(input, workDir) {
    if (!existsSync(input)) {
        throw new Error(`--world path does not exist: ${input}`);
    }
    if (statSync(input).isDirectory()) {
        return input;
    }
    ensureDir(workDir);
    const zip = join(workDir, "source.zip");
    copyFileSync(input, zip);
    const target = join(workDir, "source");
    // Ours, under dist/, and always start empty: Expand-Archive-style overwriting would leave the
    // previous (usually bigger) export's db files behind, and they would ship inside this template.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    ensureDir(target);
    extractZip(zip, target);
    // Windows Explorer and Minecraft both sometimes wrap the contents in one folder.
    const children = readdirSync(target, { withFileTypes: true });
    if (children.length === 1 && children[0].isDirectory() && existsSync(join(target, children[0].name, "level.dat"))) {
        return join(target, children[0].name);
    }
    return target;
}

function fail(messages) {
    for (const message of messages) console.error(`FAIL   ${message}`);
    process.exitCode = 1;
}

const options = parseArgs(process.argv.slice(2));
if (typeof options.world !== "string") {
    fail(["usage: node dev/build-template.mjs --world <exported world folder or .mcworld> [--receipt <file>] [--out <dir>] [--zip] [--dry-run]"]);
    process.exit(1);
}

const workDir = join(projectRoot, "dist", "work");
const distRoot = join(projectRoot, "dist");
const outRoot = resolve(typeof options.out === "string" ? options.out : join(distRoot, "templates"));
// Containment, not a string prefix: `dist` would also match `distX` or `distribution`, and this
// script deletes the staging directory it is about to rebuild.
const insideDist = (() => {
    const rel = relative(distRoot, outRoot);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
})();
if (!insideDist) {
    fail([`refusing to write outside dist/: ${outRoot}`]);
    process.exit(1);
}

const staged = join(outRoot, spec.templateId);
const receiptPath = typeof options.receipt === "string" ? resolve(options.receipt) : null;
const receipt = receiptPath && existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;

console.log(`source world: ${options.world}`);
const source = materialiseSource(resolve(String(options.world)), workDir);
console.log(`staging to:   ${staged}`);

if (!receipt && options.dry-run !== true) {
    fail([
        "no build receipt (--receipt). The saved SIMULATION state lives inside db/, which cannot be inspected offline,",
        "        so arming must be proven by the in-game `civ:starter_verify` output recorded in the receipt.",
        "        Pass --receipt starter/build-receipt.json, or --dry-run to stage without shipping.",
    ]);
    process.exit(1);
}
if (receipt) {
    const problems = [];
    if (receipt.templateId !== spec.templateId) problems.push(`receipt templateId ${String(receipt.templateId)} != ${spec.templateId}`);
    if (receipt.armed !== true) problems.push("the receipt does not say the world was armed (armed: true)");
    const built = new Set(receipt.builtDistricts ?? []);
    for (const required of spec.starter.builtRequired ?? []) {
        if (!built.has(required)) problems.push(`the receipt does not report ${required} as physically complete`);
    }
    if (Number(receipt.jobPending ?? 0) !== 0) problems.push(`the receipt reports ${String(receipt.jobPending)} pending job elements`);
    if (!Number.isInteger(receipt.centre?.x) || !Number.isInteger(receipt.centre?.z)) problems.push("the receipt has no city centre to check the spawn point against");
    if (problems.length > 0) {
        fail(problems);
        process.exit(1);
    }
}

if (existsSync(staged)) {
    rmSync(staged, { recursive: true, force: true });
}
ensureDir(staged);

let copiedFiles = 0;
for (const file of WORLD_FILES) {
    const from = join(source, file);
    if (existsSync(from) && statSync(from).isFile()) {
        ensureDir(dirname(join(staged, file)));
        copyFileSync(from, join(staged, file));
        copiedFiles += 1;
    }
}
if (!existsSync(join(staged, "level.dat"))) {
    fail(["the exported world has no level.dat - is --world pointing at an exported world, not a pack?"]);
    process.exit(1);
}
if (existsSync(join(source, "db"))) {
    // Exclude LevelDB lock/temp files: they are not part of a portable database snapshot.
    // LevelDB LOCK files and half-written .tmp files are not portable; .log/.ldb are the data.
    copiedFiles += copyTree(join(source, "db"), join(staged, "db"), (name) => name !== "LOCK" && !name.endsWith(".tmp"));
} else {
    fail(["the exported world has no db/ folder: the built city would not be in this package at all"]);
    process.exit(1);
}

for (const pack of spec.packs ?? []) {
    const from = join(projectRoot, pack.source);
    const to = join(staged, pack.kind, pack.packageDir);
    if (!existsSync(from)) {
        fail([`pack source is missing: ${pack.source}`]);
        continue;
    }
    // Packs are copied from the repository, never from the world, so the shipped scripts are current.
    copiedFiles += copyTree(from, to, (name) => !name.endsWith(".log") && name !== "package.json" && name !== "package-lock.json");
    console.log(`packed ${pack.kind}/${pack.packageDir} (${pack.packageDir.length} char folder name)`);
}

writeFileSync(
    join(staged, "manifest.json"),
    `${JSON.stringify(
        {
            header: {
                name: "pack.name",
                description: "pack.description",
                version: spec.templateVersion,
                uuid: spec.manifest.headerUuid,
            },
            modules: [{ version: spec.templateVersion, type: spec.manifest.moduleType, uuid: spec.manifest.moduleUuid }],
            format_version: spec.manifest.formatVersion,
        },
        null,
        4,
    )}\n`,
);
ensureDir(join(staged, "texts"));
writeFileSync(join(staged, "texts", "en_US.lang"), `pack.name=${spec.displayName}\npack.description=${spec.description}\n`);
writeFileSync(join(staged, "texts", "languages.json"), `${JSON.stringify(spec.languages, null, 4)}\n`);

console.log(`staged ${String(copiedFiles)} files`);

const result = validateTemplateDir(staged, spec, { receipt });
for (const note of result.notes) console.log(`note   ${note}`);
for (const problem of result.problems) console.error(`FAIL   ${problem}`);
if (result.problems.length > 0) {
    console.error(`template staging failed: ${String(result.problems.length)} problem(s)`);
    process.exitCode = 1;
} else {
    console.log(`template staged and validated: ${staged}`);
}

if (options.zip === true && result.problems.length === 0) {
    const target = join(outRoot, `${spec.templateId}.${spec.packageExtension}`);
    if (existsSync(target)) rmSync(target);
    // Our own writer, so the entry separators are '/' as the format requires and the bytes are
    // reproducible; PowerShell's Compress-Archive writes backslashes here.
    try {
        const packed = writeZip(staged, target);
        console.log(`packaged: ${target} (${String(packed.entries)} entries, ${(packed.bytes / 1048576).toFixed(1)} MB)`);
        console.log(`sha256 ${packed.sha256}`);
        console.log("import it by double-clicking; worlds created from it appear under Create New > Imported Templates");
    } catch (error) {
        fail([`could not build the .${spec.packageExtension}: ${String(error)}`]);
    }
}
