// Command-identifier audit. /scriptevent ids must be `namespace:name` with exactly ONE colon
// (a second colon makes the game reject the command: "Identifier must have a namespace that is
// not 'minecraft'"). This guards every id we register AND every example we print or document.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = join(root, "CivilizationApocalypse_BP", "scripts");
const config = await import(pathToFileURL(join(scripts, "config.js")).href);

const VALID = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;
const groups = { SCRIPT_EVENT_IDS: config.SCRIPT_EVENT_IDS, DEBUG_EVENT_IDS: config.DEBUG_EVENT_IDS, PHYSICAL_EVENT_IDS: config.PHYSICAL_EVENT_IDS, CIV_EVENT_IDS: config.CIV_EVENT_IDS, STARTER_EVENT_IDS: config.STARTER_EVENT_IDS };
const allIds = Object.values(groups).flatMap((group) => Object.values(group));

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(js|mjs|md)$/.test(name)) out.push(full);
    }
    return out;
}

test("every registered id has exactly one colon, a lowercase name and the civ namespace", () => {
    assert.ok(allIds.length >= 19, `expected the full command set, saw ${String(allIds.length)}`);
    for (const id of allIds) {
        assert.match(id, VALID, `${id} is not a valid scriptevent id`);
        assert.equal(id.split(":").length, 2, `${id} must have exactly one colon`);
        assert.equal(id.split(":")[0], config.SCRIPT_EVENT_NAMESPACE, `${id} is outside the registered namespace`);
        assert.notEqual(id.split(":")[0], "minecraft");
    }
    assert.equal(new Set(allIds).size, allIds.length, "ids are unique");
});

test("every id is actually handled by a command module", () => {
    const sources = walk(join(scripts, "commands")).map((file) => readFileSync(file, "utf8")).join("\n");
    for (const [groupName, group] of Object.entries(groups)) {
        for (const key of Object.keys(group)) {
            assert.ok(sources.includes(`${groupName}.${key}`) || sources.includes(`event.id === ${groupName}.${key}`) || new RegExp(`\b[A-Z_]*IDS\.${key}\b`).test(sources), `no handler for ${groupName}.${key}`);
        }
    }
});

test("every /scriptevent example in the pack, docs, README and tests names a real id", () => {
    const known = new Set(allIds);
    let examples = 0;
    for (const file of [...walk(scripts), ...walk(join(root, "docs")), ...walk(join(root, "dev")), join(root, "README.md")]) {
        if (file.endsWith("commands.test.mjs")) continue;
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/\/scriptevent\s+([^\s`"'<>|)\]/\\]+)/g)) {
            const id = match[1].replace(/[.,;:]+$/, "");
            if (id.includes("${")) continue; // dynamic template, validated where the id is registered
            examples += 1;
            assert.match(id, VALID, `${file}: '/scriptevent ${id}' is not a valid id`);
            assert.ok(known.has(id), `${file}: '/scriptevent ${id}' is not a registered command`);
        }
    }
    assert.ok(examples > 30, `expected many documented examples, saw ${String(examples)}`);
});

test("no leftover multi-colon ids anywhere", () => {
    for (const file of [...walk(scripts), ...walk(join(root, "docs")), join(root, "README.md")]) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /\bciv:[a-z_]+:[a-z_]+/, `${file} still mentions a two-colon id`);
    }
});
