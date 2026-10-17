// Deploys CivilizationApocalypse_BP into Minecraft's development_behavior_packs folder.
// Touches ONLY <dev packs>/CivilizationApocalypse_BP, and only if it is absent or already
// carries this pack's header UUID. Never touches worlds or other packs.
// Usage: node dev/deploy.mjs [--dry-run] [--target <development_behavior_packs dir>]
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(root, "CivilizationApocalypse_BP");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetFlag = args.indexOf("--target");
const devPacks =
    targetFlag >= 0
        ? resolve(args[targetFlag + 1])
        : join(process.env.APPDATA ?? "", "Minecraft Bedrock", "Users", "Shared", "games", "com.mojang", "development_behavior_packs");
const dest = join(devPacks, "CivilizationApocalypse_BP");

function listFiles(dir, base = dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
        else out.push(relative(base, full).replaceAll("\\", "/"));
    }
    return out.sort();
}
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (!existsSync(devPacks)) {
    console.error(`development_behavior_packs not found: ${devPacks}`);
    process.exit(1);
}
const uuid = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")).header.uuid;
if (existsSync(dest)) {
    const existing = join(dest, "manifest.json");
    const existingUuid = existsSync(existing) ? JSON.parse(readFileSync(existing, "utf8")).header?.uuid : undefined;
    if (existingUuid !== uuid) {
        console.error(`Refusing: ${dest} exists and is not this pack (uuid ${String(existingUuid)}).`);
        process.exit(1);
    }
}
console.log(`${dryRun ? "[dry run] " : ""}source: ${source}\ntarget: ${dest}`);
if (!dryRun) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(source, dest, { recursive: true });
}
const files = listFiles(source);
if (dryRun) {
    console.log(`would copy ${files.length} files`);
    process.exit(0);
}
const destFiles = listFiles(dest);
const mismatches = files.filter((f) => !destFiles.includes(f) || hash(join(source, f)) !== hash(join(dest, f)));
const extras = destFiles.filter((f) => !files.includes(f));
if (mismatches.length || extras.length) {
    console.error("VERIFY FAILED", { mismatches, extras });
    process.exit(1);
}
console.log(`deployed and verified: ${files.length} files byte-identical (sha256)`);
