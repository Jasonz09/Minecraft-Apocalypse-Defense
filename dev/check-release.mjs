import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_DISTRICT_IDS, fullReleaseProblems, starterConfigProblems } from "./lib/release-readiness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "starter", "template.json"), "utf8"));
/** The pack's own release rules: this is what `civ:starter_arm confirm` enforces in Minecraft. */
const { STARTER } = await import(pathToFileURL(join(root, "CivilizationApocalypse_BP", "scripts", "config.js")).href);
const ix = process.argv.indexOf("--receipt");
const receiptPath = ix >= 0 ? process.argv[ix + 1] : join(root, "starter", "build-receipt.json");
if (!receiptPath || receiptPath.startsWith("--")) {
    console.error("Usage: node dev/check-release.mjs [--receipt <build receipt JSON>]");
    process.exit(2);
}
let receipt = null;
if (existsSync(resolve(receiptPath))) {
    try {
        receipt = JSON.parse(readFileSync(resolve(receiptPath), "utf8"));
    } catch (error) {
        console.error(`- Invalid receipt: ${String(error)}`);
        process.exit(2);
    }
}
const districts = Array.isArray(spec.districts) ? spec.districts : [];
const marked = RELEASE_DISTRICT_IDS.filter((id) => {
    const d = districts.find((entry) => entry.id === id);
    return d?.starterWorld === true && d?.status === "built";
});
console.log("Civilization Apocalypse — five-district release readiness");
console.log(`- Districts marked physically built: ${marked.length}/${RELEASE_DISTRICT_IDS.length}`);
console.log(`- Build receipt: ${receipt === null ? "missing" : "present"}`);
for (const id of RELEASE_DISTRICT_IDS) {
    const d = districts.find((entry) => entry.id === id);
    console.log(`- ${d?.name ?? id}: ${marked.includes(id) ? "marked built" : "NOT release-ready"}`);
}
const problems = [...fullReleaseProblems(spec, receipt), ...starterConfigProblems(spec, STARTER)];

/**
 * A `.mctemplate` that is already sitting in dist/ is not evidence of anything: this gate only
 * guards the tooling's own `--zip` path, so list whatever is there and say what it is.
 */
const templateDir = join(root, "dist", "templates");
const artifacts = existsSync(templateDir)
    ? readdirSync(templateDir, { recursive: true }).filter((name) => String(name).endsWith(`.${spec.packageExtension}`))
    : [];
for (const name of artifacts) {
    const file = join(templateDir, String(name));
    const bytes = readFileSync(file);
    console.log(`- Found ${String(name)} (${String(bytes.length)} bytes, ${statSync(file).mtime.toISOString()}, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}...)`);
}

if (problems.length > 0) {
    console.log("Release BLOCKED:");
    for (const problem of problems) console.log(`- ${problem}`);
    if (artifacts.length > 0) {
        console.log(`- ${String(artifacts.length)} archived template(s) exist in dist/templates; they were built by other means or from an earlier spec and MUST NOT be distributed as the starting kingdom.`);
    }
    console.log("Development staging remains available with dev/build-template.mjs without --zip.");
    process.exitCode = 1;
} else {
    if (artifacts.length > 0) {
        console.log(`- ${String(artifacts.length)} template archive(s) already in dist/templates: rebuild and compare sha256 rather than shipping an older file.`);
    }
    console.log("Release metadata: READY FOR PACKAGING CHECK (Minecraft import and saved-world verification still required).");
}
