import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packRoot = join(projectRoot, "CivilizationApocalypse_BP");
const manifestPath = join(packRoot, "manifest.json");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /<uuid>|change_me|your-?uuid|xxxx/i;

const failures = [];
const passes = [];

function check(condition, label, detail) {
    if (condition) {
        passes.push(label);
    } else {
        failures.push(`${label}${detail ? ` -> ${detail}` : ""}`);
    }
    return condition;
}

function isVersionTriple(value) {
    return Array.isArray(value) && value.length === 3 && value.every((part) => Number.isInteger(part) && part >= 0);
}

function listJsFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...listJsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            found.push(fullPath);
        }
    }
    return found;
}

let manifest;
if (!check(existsSync(manifestPath), "manifest.json exists at the pack root")) {
    console.error(`FATAL: no manifest at ${manifestPath}`);
    process.exit(1);
}
const manifestText = readFileSync(manifestPath, "utf8");
try {
    manifest = JSON.parse(manifestText);
    check(true, "manifest.json parses as JSON");
} catch (error) {
    check(false, "manifest.json parses as JSON", String(error));
    report();
}

check(manifest.format_version === 2, "format_version is 2 (script modules require it)", `got ${String(manifest.format_version)}`);

const header = manifest.header ?? {};
check(typeof header.name === "string" && header.name.length > 0, "header.name is set");
check(typeof header.description === "string" && header.description.length > 0, "header.description is set");
if (check(typeof header.uuid === "string", "header.uuid is a string")) {
    check(UUID_RE.test(header.uuid), "header.uuid is a valid UUID", header.uuid);
    check(!PLACEHOLDER_RE.test(header.uuid), "header.uuid is not a placeholder");
}
check(isVersionTriple(header.version), "header.version is a [major, minor, patch] triple", JSON.stringify(header.version));
check(isVersionTriple(header.min_engine_version), "header.min_engine_version is a triple", JSON.stringify(header.min_engine_version));

const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
check(modules.length >= 1, "at least one module is declared");

const scriptModules = modules.filter((entry) => entry.type === "script");
check(scriptModules.length === 1, "exactly one script module", `found ${String(scriptModules.length)}`);

const scriptModule = scriptModules[0] ?? {};
check(scriptModule.language === "javascript", "script module language is javascript", String(scriptModule.language));
check(typeof scriptModule.entry === "string" && scriptModule.entry.length > 0, "script module has an entry path");
if (typeof scriptModule.entry === "string") {
    const entryPath = join(packRoot, scriptModule.entry);
    check(existsSync(entryPath), `entry file exists on disk (${scriptModule.entry})`);
}
if (check(typeof scriptModule.uuid === "string", "script module uuid is a string")) {
    check(UUID_RE.test(scriptModule.uuid), "script module uuid is valid", scriptModule.uuid);
}
check(isVersionTriple(scriptModule.version), "script module version is a triple", JSON.stringify(scriptModule.version));

const uuids = [header.uuid, ...modules.map((entry) => entry.uuid)].filter((value) => typeof value === "string");
check(new Set(uuids).size === uuids.length, "all uuids in the manifest are unique");

const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
const serverDependency = dependencies.find((entry) => entry.module_name === "@minecraft/server");
if (check(Boolean(serverDependency), "manifest declares a @minecraft/server dependency")) {
    check(
        typeof serverDependency.version === "string" && /^\d+\.\d+\.\d+$/.test(serverDependency.version),
        "@minecraft/server dependency is an exact stable version",
        String(serverDependency.version),
    );

    const installedTypesPath = join(projectRoot, "node_modules", "@minecraft", "server", "package.json");
    if (check(existsSync(installedTypesPath), "the @minecraft/server types used for typechecking are installed")) {
        const installed = JSON.parse(readFileSync(installedTypesPath, "utf8"));
        check(
            installed.version === serverDependency.version,
            "manifest API pin matches the installed types version",
            `manifest ${serverDependency.version} vs node_modules ${installed.version}`,
        );
    }
}

for (const [index, dependency] of dependencies.entries()) {
    if (dependency.uuid) {
        check(UUID_RE.test(dependency.uuid), `dependency ${String(index)} uuid is valid`, String(dependency.uuid));
    }
}

const packRootEntries = readdirSync(packRoot);
for (const forbidden of ["node_modules", "package.json", "package-lock.json", "tsconfig.json"]) {
    check(!packRootEntries.includes(forbidden), `pack root stays clean (no ${forbidden})`);
}

const scriptsDir = join(packRoot, "scripts");
const jsFiles = listJsFiles(scriptsDir);
check(jsFiles.length > 0, "the pack contains script files", `found ${String(jsFiles.length)}`);

const importRe = /(?:^|\n)\s*(?:import|export)\s[^"'’]*?from\s*["']([^"']+)["']/g;
for (const file of jsFiles) {
    const label = relative(projectRoot, file).split("\\").join("/");
    const source = readFileSync(file, "utf8");
    if (!check(!PLACEHOLDER_RE.test(source), `${label} has no placeholder text`)) continue;

    let match;
    let importCount = 0;
    while ((match = importRe.exec(source)) !== null) {
        importCount += 1;
        const specifier = match[1];
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
            check(specifier.endsWith(".js"), `${label} relative import '${specifier}' carries a .js extension`);
            check(existsSync(resolve(dirname(file), specifier)), `${label} relative import '${specifier}' resolves to a file`);
        } else {
            check(specifier.startsWith("@minecraft/"), `${label} bare import '${specifier}' is a @minecraft module`);
        }
    }
    check(importCount > 0 || /export\s/.test(source), `${label} declares at least one import or export`);
}

check(
    /"entry":\s*"scripts\/main\.js"/.test(manifestText),
    "entry points at scripts/main.js",
);

function report() {
    console.log(`manifest validation: ${String(passes.length)} passed, ${String(failures.length)} failed`);
    for (const failure of failures) {
        console.error(`FAIL ${failure}`);
    }
    if (failures.length > 0) {
        process.exitCode = 1;
        return;
    }
    console.log("all manifest and packaging checks passed");
}

report();
