import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { levelSection, readLevelDat } from "./lib/nbt.mjs";

/**
 * Offline validation of the starter-world packaging: the repository-side spec, and (when given a
 * directory) a staged or exported world. Nothing here needs Minecraft installed; what it cannot
 * check it says out loud instead of passing silently.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = ["command", "industrial", "agricultural", "commercial", "residential"];

function isTriple(value) {
    return Array.isArray(value) && value.length === 3 && value.every((part) => Number.isInteger(part) && part >= 0);
}

function walk(dir, prefix = "") {
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...walk(join(dir, entry.name), relative));
        } else {
            out.push(relative);
        }
    }
    return out;
}

function directorySize(dir) {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        total += entry.isDirectory() ? directorySize(full) : statSync(full).size;
    }
    return total;
}

/**
 * @param {any} spec
 * @param {{ readJson?: (file: string) => any, enlargedLayouts?: Record<number, string> }} [ctx]
 */
export function validateTemplateSpec(spec, ctx = {}) {
    const /** @type {string[]} */ problems = [];
    const /** @type {string[]} */ notes = [];
    const readJson = ctx.readJson ?? ((file) => JSON.parse(readFileSync(join(projectRoot, file), "utf8")));

    const ok = (condition, label, detail) => {
        if (!condition) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
    };

    ok(typeof spec.templateId === "string" && /^[a-z0-9][a-z0-9-]{1,31}$/.test(spec.templateId), "templateId must be a lowercase slug", String(spec.templateId));
    ok(isTriple(spec.templateVersion), "templateVersion must be [major, minor, patch]", JSON.stringify(spec.templateVersion));
    ok(spec.packageExtension === "mctemplate", "packageExtension must be mctemplate (a world TEMPLATE, not an imported .mcworld)", String(spec.packageExtension));
    ok(typeof spec.displayName === "string" && spec.displayName.length > 0, "displayName is required");
    ok(typeof spec.description === "string" && spec.description.length > 20, "description is required", "a player reads this before creating the world");

    const manifest = spec.manifest ?? {};
    ok(UUID_RE.test(String(manifest.headerUuid)), "manifest.headerUuid must be a valid v4 UUID", String(manifest.headerUuid));
    ok(UUID_RE.test(String(manifest.moduleUuid)), "manifest.moduleUuid must be a valid v4 UUID", String(manifest.moduleUuid));
    ok(manifest.headerUuid !== manifest.moduleUuid, "the template's two UUIDs must differ");
    ok(manifest.moduleType === "world_template", 'manifest.moduleType must be "world_template"', String(manifest.moduleType));
    ok(manifest.formatVersion === 2, "manifest.formatVersion must be 2", String(manifest.formatVersion));

    const packUuids = new Set();
    const packs = Array.isArray(spec.packs) ? spec.packs : [];
    ok(packs.length >= 1, "at least one pack must be shipped with the template");
    for (const pack of packs) {
        const label = `pack ${String(pack.packageDir)}`;
        ok(typeof pack.packageDir === "string" && pack.packageDir.length <= 10, `${label} folder name must be 10 characters or fewer (Xbox path limit: longer pack folders can fail to load)`, String(pack.packageDir));
        ok(/^[A-Za-z0-9_-]+$/.test(String(pack.packageDir)), `${label} folder name must be plain [A-Za-z0-9_-]`);
        ok(["behavior_packs", "resource_packs"].includes(pack.kind), `${label}.kind must be behavior_packs or resource_packs`, String(pack.kind));
        ok(pack.source && existsSync(join(projectRoot, pack.source)), `${label}.source must exist in the repo`, String(pack.source));
        if (!pack.manifest || !existsSync(join(projectRoot, pack.manifest))) {
            problems.push(`${label}.manifest must point at a real pack manifest`);
            continue;
        }
        const packManifest = readJson(pack.manifest);
        const uuid = packManifest?.header?.uuid;
        ok(UUID_RE.test(String(uuid)), `${label} manifest uuid must be valid`, String(uuid));
        packUuids.add(String(uuid));
        ok(uuid !== manifest.headerUuid && uuid !== manifest.moduleUuid, `${label} uuid must not collide with the template uuids (duplicate uuids make Minecraft refuse the import)`);
        for (const module of packManifest?.modules ?? []) {
            packUuids.add(String(module.uuid));
            ok(module.uuid !== manifest.headerUuid && module.uuid !== manifest.moduleUuid, `${label} module uuid must not collide with the template uuids`);
        }
    }

    const world = spec.world ?? {};
    ok(Array.isArray(world.requiredFiles) && world.requiredFiles.includes("level.dat"), "world.requiredFiles must include level.dat");
    ok((world.requiredFiles ?? []).includes("levelname.txt"), "world.requiredFiles must include levelname.txt");
    ok((world.requiredFiles ?? []).includes("db/CURRENT") || (world.optionalFiles ?? []).includes("db/CURRENT"), "an authored template must ship its db/ - deleting db/ is only for random-seed templates");
    const overlap = (world.requiredFiles ?? []).filter((file) => (world.optionalFiles ?? []).includes(file));
    ok(overlap.length === 0, "a file cannot be both required and optional", overlap.join(", "));
    ok(["infinite", "flat", "old"].includes(world.generatorMustBe), "world.generatorMustBe must be infinite, flat or old", String(world.generatorMustBe));
    ok(Number(world.maxWorldBytes) > 1_000_000, "world.maxWorldBytes must be a sane byte count", String(world.maxWorldBytes));
    ok(world.keepRandomSeed === false, "keepRandomSeed must be false: this world is authored, not seeded-and-regenerated", String(world.keepRandomSeed));

    const starter = spec.starter ?? {};
    ok(starter.templateId === spec.templateId, "starter.templateId must equal the spec templateId", `${String(starter.templateId)} vs ${String(spec.templateId)}`);
    ok((starter.keepKeyPrefixes ?? []).length >= 1, "starter.keepKeyPrefixes must list what survives arming");
    ok((starter.wipeKeyPrefixes ?? []).length >= 1, "starter.wipeKeyPrefixes must list the development state to remove");
    const both = (starter.keepKeyPrefixes ?? []).filter((prefix) => (starter.wipeKeyPrefixes ?? []).includes(prefix));
    ok(both.length === 0, "a key prefix cannot be both kept and wiped", both.join(", "));
    ok((starter.keepKeyPrefixes ?? []).includes("civ:plan"), "the five-district master plan must be kept, or districts 2-5 could never be built or rebuilt");
    ok(Array.isArray(starter.builtRequired) && starter.builtRequired.length >= 1, "starter.builtRequired must name the districts that must be physically complete");

    const districts = Array.isArray(spec.districts) ? spec.districts : [];
    ok(districts.length === 5, "the starter spec must describe all five districts", String(districts.length));
    const indices = new Set();
    const layoutIds = new Set();
    for (const district of districts) {
        const label = `district ${String(district.index)}`;
        ok(Number.isInteger(district.index) && district.index >= 1 && district.index <= 5 && !indices.has(district.index), `${label}.index must be a unique 1..5`);
        indices.add(district.index);
        ok(district.id === `district-${String(district.index)}`, `${label}.id must match its index`, String(district.id));
        ok(ROLES.includes(district.role), `${label}.role must be one of ${ROLES.join("/")}`, String(district.role));
        ok(typeof district.layoutId === "string" && district.layoutId.endsWith("-enlarged"), `${label}.layoutId must be a new enlarged layout id`, String(district.layoutId));
        ok(district.layoutId !== "hearthgate", `${label} must not reuse the 49x49 prototype layout id`);
        ok(!layoutIds.has(district.layoutId), `${label}.layoutId must be unique`);
        layoutIds.add(district.layoutId);
        ok(["planned", "planner-ready", "built"].includes(district.status), `${label}.status must be planned, planner-ready or built`, String(district.status));
        if (district.starterWorld === true) {
            ok(district.status !== "planned", `${label} is marked starterWorld but is only planned - it would ship unbuilt`);
        }
    }
    const shipped = districts.filter((district) => district.starterWorld === true);
    ok(shipped.length >= 1, "at least one district must be marked starterWorld");
    for (const required of starter.builtRequired ?? []) {
        ok(districts.some((district) => district.id === required && district.starterWorld === true), `starter.builtRequired names ${required}, which is not a starter-world district`);
    }

    const registered = ctx.enlargedLayouts ?? {};
    for (const district of shipped) {
        ok(Object.hasOwn(registered, district.index), `district ${district.index} ships in the starter world but civ/districtplan.js has no layout registered for it`, `registered: ${Object.keys(registered).join(", ") || "none"}`);
    }
    for (const index of Object.keys(registered)) {
        ok(shipped.some((district) => String(district.index) === String(index)), `civ/districtplan.js registers district ${index} but the starter spec does not mark it starterWorld`);
    }
    const planned = districts.filter((district) => !district.starterWorld);
    if (planned.length > 0) {
        notes.push(`${planned.length} district(s) are prepared but not started: ${planned.map((district) => `${district.name} (${district.layoutId}, ${district.status})`).join(", ")}`);
    }

    ok(Array.isArray(spec.languages) && spec.languages.includes("en_US"), "languages must include en_US (the template falls back to the literal text \"pack.name\" without it)");

    return { problems, notes };
}

/**
 * Bedrock stores `Level.Generator` as an **Int** (0 Old, 1 Infinite, 2 Flat, 5 Void), not as the
 * word - see the Bedrock level format page. Comparing the raw tag to `"infinite"` would fail every
 * real export, so both spellings are normalised to a name before the spec is checked.
 */
const GENERATOR_NAMES = { 0: "old", 1: "infinite", 2: "flat", 5: "void" };

/** @param {any} value @returns {string} */
function generatorName(value) {
    if (typeof value === "string") return value.toLowerCase();
    if (Number.isInteger(value)) return GENERATOR_NAMES[value] ?? `generator ${String(value)}`;
    return "no generator tag";
}

/** Both forms in one message, because 'the generator is 2' means nothing without 'flat'. */
function describeGeneratorTag(value) {
    return `${String(value)} ('${generatorName(value)}')`;
}

/**
 * Validate a staged template directory. Point it at a raw exported world and it will report the
 * missing template `manifest.json`: that is the difference between the two, and it must be a failure.
 *
 * @param {string} dir
 * @param {any} spec
 * @param {{ receipt?: any, skipDb?: boolean }} [options]
 */
export function validateTemplateDir(dir, spec, options = {}) {
    const /** @type {string[]} */ problems = [];
    const /** @type {string[]} */ notes = [];
    const ok = (condition, label, detail) => {
        if (!condition) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
    };

    if (!existsSync(dir)) {
        return { problems: [`world directory does not exist: ${dir}`], notes };
    }
    const files = walk(dir);
    const has = (file) => files.includes(file);

    for (const required of spec.world?.requiredFiles ?? []) {
        ok(has(required), `required world file is missing: ${required}`);
    }

    let level = null;
    if (has("level.dat")) {
        try {
            const parsed = readLevelDat(new Uint8Array(readFileSync(join(dir, "level.dat"))));
            level = levelSection(parsed.data);
            const wanted = String(spec.world?.generatorMustBe ?? "infinite").toLowerCase();
            const found = generatorName(level.Generator);
            ok(found === wanted, `the world generator is ${describeGeneratorTag(level.Generator)}, but the template requires '${wanted}' (a flat or legacy world is not the authored kingdom)`);
            for (const axis of ["SpawnX", "SpawnY", "SpawnZ"]) {
                ok(Number.isInteger(level[axis]), `level.dat ${axis} must be an integer, got ${String(level[axis])}`);
            }
            if (Number.isInteger(level.SpawnY)) {
                ok(level.SpawnY > -64 && level.SpawnY < 320, `spawn y=${String(level.SpawnY)} is outside the world`);
            }
            if (options.receipt?.centre && Number.isInteger(level.SpawnX) && Number.isInteger(level.SpawnZ)) {
                const dx = level.SpawnX - options.receipt.centre.x;
                const dz = level.SpawnZ - options.receipt.centre.z;
                const radius = Number(options.receipt.radius ?? 220);
                ok(Math.hypot(dx, dz) <= radius, `spawn (${String(level.SpawnX)}, ${String(level.SpawnZ)}) is ${Math.round(Math.hypot(dx, dz))} blocks from the built city centre - players should start inside the kingdom`);
            } else {
                notes.push("no build receipt: spawn-inside-the-city could not be checked (record `civ:starter_status` output in starter/build-receipt.json)");
            }
            const seedField = ["RandomSeed", "WorldSeed", "Seed"].find((field) => level[field] !== undefined);
            notes.push(`world seed ${String(seedField === undefined ? "unknown (no seed tag found)" : level[seedField])} (${String(seedField ?? "none")}) is baked in; the template keeps the authored terrain (allow_random_seed is deliberately not set)`);
        } catch (error) {
            ok(false, "level.dat could not be read", String(error));
        }
    }

    for (const forbidden of spec.world?.forbiddenFiles ?? []) {
        const pattern = forbidden.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        const hit = files.filter((file) => new RegExp(`^${pattern}$`).test(file));
        ok(hit.length === 0, `forbidden file(s) present in the template: ${hit.slice(0, 3).join(", ")}`);
    }

    if (has("world_behavior_packs.json")) {
        let bound;
        try {
            bound = JSON.parse(readFileSync(join(dir, "world_behavior_packs.json"), "utf8"));
        } catch (error) {
            ok(false, "world_behavior_packs.json is not valid JSON", String(error));
            bound = [];
        }
        const entries = Array.isArray(bound) ? bound : [];
        const wanted = new Set((spec.packs ?? []).filter((pack) => pack.kind === "behavior_packs").map((pack) => pack.packageDir));
        for (const packDir of wanted) {
            ok(has(`behavior_packs/${packDir}/manifest.json`), `the bound behavior pack folder behavior_packs/${packDir} is not in the package`);
        }
        const manifestUuids = new Set();
        for (const pack of spec.packs ?? []) {
            try {
                manifestUuids.add(JSON.parse(readFileSync(join(projectRoot, pack.manifest), "utf8")).header.uuid);
            } catch (error) {
                /* reported by validateTemplateSpec */
            }
        }
        for (const entry of entries) {
            const id = String(entry?.pack_id ?? entry?.uuid ?? "");
            ok(manifestUuids.has(id), `world_behavior_packs.json binds pack ${id}, which is not shipped in this package`);
            const version = entry?.version ?? entry?.pack_version;
            ok(version !== undefined, `world_behavior_packs.json entry ${id} has no version`);
        }
    } else {
        notes.push("no world_behavior_packs.json: Minecraft will not auto-attach the pack to worlds created from this template");
    }

    if (has("manifest.json")) {
        try {
            const templateManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
            ok(templateManifest?.header?.uuid === spec.manifest.headerUuid, "template manifest.json header uuid must match starter/template.json");
            ok(templateManifest?.modules?.[0]?.type === "world_template", 'template manifest.json module type must be "world_template"');
            ok(templateManifest?.format_version === 2, "template manifest.json format_version must be 2");
            ok(templateManifest?.header?.allow_random_seed !== true, "template manifest.json sets allow_random_seed: the built city lives in db/, and a re-seeded world regenerates the terrain away from it");
            ok(/^pack\.name$/.test(String(templateManifest?.header?.name ?? "")), 'template manifest.json header.name must be the literal "pack.name"');
        } catch (error) {
            ok(false, "template manifest.json is not valid JSON", String(error));
        }
    } else {
        ok(false, "the package has no manifest.json, so Minecraft imports it as an exported world, not as a world template", "add manifest.json with a module of type world_template");
    }

    if (has("texts/en_US.lang")) {
        const lang = readFileSync(join(dir, "texts/en_US.lang"), "utf8");
        ok(/^pack\.name=.+/m.test(lang), "texts/en_US.lang must define a non-empty pack.name");
        ok(/^pack\.description=.+/m.test(lang), "texts/en_US.lang must define a non-empty pack.description");
    }

    const size = directorySize(dir);
    ok(size <= Number(spec.world?.maxWorldBytes ?? 0), `the package is ${Math.round(size / 1048576)} MB, above the ${Math.round(Number(spec.world?.maxWorldBytes ?? 0) / 1048576)} MB budget`);
    notes.push(`package size ${(size / 1048576).toFixed(1)} MB`);
    if (!has("db/CURRENT")) {
        problems.push("db/ is missing: the built city lives in the level database, so this package would ship an empty world");
    }
    notes.push("saved SIMULATION state (civ:kingdom, civ:plan, gates) lives inside db/*.log and cannot be inspected offline: the in-game `civ:starter_verify` output is the authority that this world was armed");

    return { problems, notes, files, level };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dirArgIndex = process.argv.indexOf("--world");
    const spec = JSON.parse(readFileSync(join(projectRoot, "starter", "template.json"), "utf8"));
    const layouts = {};
    try {
        const module = await import(pathToFileURL(join(projectRoot, "CivilizationApocalypse_BP", "scripts", "civ", "districtplan.js")).href);
        for (const index of Object.keys(module.ENLARGED_LAYOUTS ?? {})) {
            layouts[Number(index)] = module.ENLARGED_LAYOUTS[index];
        }
    } catch (error) {
        console.error(`could not load civ/districtplan.js: ${String(error)}`);
    }
    const specResult = validateTemplateSpec(spec, { enlargedLayouts: layouts });
    for (const note of specResult.notes) console.log(`note   ${note}`);
    for (const problem of specResult.problems) console.error(`FAIL   ${problem}`);
    console.log(`starter spec: ${String(specResult.problems.length === 0 ? "ok" : `${String(specResult.problems.length)} problem(s)`)}`);

    let exitCode = specResult.problems.length === 0 ? 0 : 1;
    if (dirArgIndex !== -1 && process.argv[dirArgIndex + 1]) {
        const dir = resolve(process.argv[dirArgIndex + 1]);
        const receiptPath = process.argv.indexOf("--receipt") !== -1 ? resolve(process.argv[process.argv.indexOf("--receipt") + 1]) : null;
        const receipt = receiptPath && existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
        const dirResult = validateTemplateDir(dir, spec, { receipt });
        for (const note of dirResult.notes) console.log(`note   ${note}`);
        for (const problem of dirResult.problems) console.error(`FAIL   ${problem}`);
        console.log(`world package ${dir}: ${String(dirResult.problems.length === 0 ? "ok" : `${String(dirResult.problems.length)} problem(s)`)}`);
        if (dirResult.problems.length > 0) exitCode = 1;
    }
    process.exitCode = exitCode;
}
