// Command-identifier audit. /scriptevent ids must be `namespace:name` with exactly ONE colon
// (a second colon makes the game reject the command: "Identifier must have a namespace that is
// not 'minecraft'"). This guards every id we register AND every example we print or document.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = join(root, "CivilizationApocalypse_BP", "scripts");
const config = await import(pathToFileURL(join(scripts, "config.js")).href);

// The generation family is driven through the shared fake-Bedrock harness, because the defect this file
// guards is not about the ids' spelling: it is that two of them were never heard when the development gate
// was off - the state every released/armed world ships with - so a player saw only the engine's
// "Script event ... has been sent" echo and no pack reply.
const { CIV_EVENT_IDS: GEN_IDS, flush, makePlayer, resetWorld, send, text } = await import("../lib/civharness.mjs");

const VALID = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;
const groups = { SCRIPT_EVENT_IDS: config.SCRIPT_EVENT_IDS, DEBUG_EVENT_IDS: config.DEBUG_EVENT_IDS, PHYSICAL_EVENT_IDS: config.PHYSICAL_EVENT_IDS, CIV_EVENT_IDS: config.CIV_EVENT_IDS, STARTER_EVENT_IDS: config.STARTER_EVENT_IDS };
const allIds = Object.values(groups).flatMap((group) => Object.values(group));
const {LEDGER_EVENT_IDS}=await import(pathToFileURL(join(scripts,"ledger","ids.js")).href);
const knownContextIds=[...allIds,...Object.values(LEDGER_EVENT_IDS)];

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

// A prose colon in an existing line comment is punctuation, not part of a
// copyable command. Quoted/code examples and literal event handlers stay strict.
function exampleId(match,source){
    let id=match[1].replace(/[.,;]+$/,"");
    const lineStart=source.lastIndexOf("\n",match.index)+1,prefix=source.slice(lineStart,match.index);
    if(id.endsWith(":")&&VALID.test(id.slice(0,-1))&&/^\s*(?:\/\/|\*)/.test(prefix)
        &&/^\s+[A-Za-z]/.test(source.slice(match.index+match[0].length)))id=id.slice(0,-1);
    return id;
}

// Optional isolated BP examples are checked against their own actual script
// registration, never added to the production namespace/known command registry.
function foreignFixtureIds(source,file){
    const ids=new Set(),normalized=file.replaceAll("\\","/"),prefix=root.replaceAll("\\","/")+"/dev/staging/";
    if(!normalized.startsWith(prefix))return ids;
    const validScriptPack=bp=>{
        let manifest;try{manifest=JSON.parse(readFileSync(join(bp,"manifest.json"),"utf8"));}catch{return false;}
        return manifest.modules?.some(m=>m.type==="script"&&typeof m.entry==="string"&&m.entry.startsWith("scripts/")
            &&!m.entry.split(/[\\/]/).includes("..")&&existsSync(join(bp,m.entry)))===true;
    };
    const at=normalized.indexOf("/BP/",prefix.length);
    if(at<0){
        // Only an owner's README may borrow its own package's verified BP handlers.
        // Never search sibling packages or relax root/docs/production known IDs.
        if(!normalized.endsWith("/README.md"))return ids;
        let owner=dirname(file);
        while(owner.replaceAll("\\","/").startsWith(prefix)){
            const bp=join(owner,"BP");
            if(existsSync(join(bp,"manifest.json"))){
                if(!validScriptPack(bp)||!existsSync(join(bp,"scripts")))return ids;
                const files=walk(join(bp,"scripts")).filter(f=>f.endsWith(".js"));if(files.length>64)return ids;
                for(const handler of files)for(const id of foreignFixtureIds(readFileSync(handler,"utf8"),handler))ids.add(id);
                return ids;
            }
            const parent=dirname(owner);if(parent===owner)break;owner=parent;
        }
        return ids;
    }
    if(!validScriptPack(normalized.slice(0,at+3)))return ids;
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),constants=new Map(),functions=new Map();
    for(const n of ast.statements){
        if(ts.isFunctionDeclaration(n)&&n.name)functions.set(n.name.text,n);
        if(ts.isVariableStatement(n)&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))for(const d of n.declarationList.declarations)
            if(ts.isIdentifier(d.name)&&d.initializer&&ts.isStringLiteralLike(d.initializer)&&VALID.test(d.initializer.text)&&!d.initializer.text.startsWith("civ:"))constants.set(d.name.text,d.initializer.text);
    }
    const compare=(node,name)=>{let yes=false;const visit=n=>{if(ts.isBinaryExpression(n)&&[ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind)){
        if(n.left.getText(ast)==="event.id"&&ts.isIdentifier(n.right)&&n.right.text===name||n.right.getText(ast)==="event.id"&&ts.isIdentifier(n.left)&&n.left.text===name)yes=true;
    }ts.forEachChild(n,visit);};visit(node);return yes;};
    const visit=n=>{
        if(ts.isCallExpression(n)&&n.expression.getText(ast).endsWith(".scriptEventReceive.subscribe")&&n.arguments.length>=2&&ts.isIdentifier(n.arguments[0])&&ts.isObjectLiteralExpression(n.arguments[1])){
            const handler=functions.get(n.arguments[0].text),names=n.arguments[1].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(ast)==="namespaces");
            if(handler&&names&&ts.isPropertyAssignment(names)&&ts.isArrayLiteralExpression(names.initializer))for(const [name,id]of constants)
                if(names.initializer.elements.some(e=>ts.isStringLiteralLike(e)&&e.text===id.split(":")[0])&&compare(handler,name))ids.add(id);
        }ts.forEachChild(n,visit);
    };visit(ast);return ids;
}

test("every /scriptevent example in the pack, docs, README and tests names a real id", () => {
    let examples = 0;
    for (const file of [...walk(scripts), ...walk(join(root, "docs")), ...walk(join(root, "dev")), join(root, "README.md")]) {
        if (file.endsWith("commands.test.mjs")) continue;
        const text = readFileSync(file, "utf8");
        const known = new Set([...knownContextIds,...foreignFixtureIds(text,file)]);
        for (const match of text.matchAll(/\/scriptevent\s+([^\s`"'<>|)\]/\\]+)/g)) {
            const id = exampleId(match,text);
            if (id.includes("${")) continue; // dynamic template, validated where the id is registered
            examples += 1;
            assert.match(id, VALID, `${file}: '/scriptevent ${id}' is not a valid id`);
            assert.ok(known.has(id), `${file}: '/scriptevent ${id}' is not a registered command`);
        }
    }
    assert.ok(examples > 30, `expected many documented examples, saw ${String(examples)}`);
});

// Durable world-property namespaces may be hierarchical. They are never valid
// script-event identifiers; explicit command contexts always use the strict audit.
function assertIdentifierContexts(source,file,known=new Set(knownContextIds)) {
    for(const m of source.matchAll(/\/scriptevent\s+([^\s`"'<>|)\]\/\\]+)/g)){
        const id=exampleId(m,source);
        if(id.includes("${"))continue;
        assert.match(id,VALID,`${file}: invalid script-event identifier ${id}`);
        assert.ok(known.has(id),`${file}: unregistered script-event identifier ${id}`);
    }
    const strictEvent=id=>{assert.match(id,VALID,`${file}: invalid literal event identifier ${id}`);assert.ok(known.has(id),`${file}: unregistered literal event identifier ${id}`);};
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const eventId=n=>ts.isPropertyAccessExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==="event"&&n.name.text==="id"
        ||ts.isElementAccessExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==="event"&&ts.isStringLiteral(n.argumentExpression)&&n.argumentExpression.text==="id";
    const compareOps=new Set([ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken]);
    const visit=n=>{
        if(ts.isBinaryExpression(n)&&compareOps.has(n.operatorToken.kind)){
            if(eventId(n.left)&&ts.isStringLiteralLike(n.right))strictEvent(n.right.text);
            if(eventId(n.right)&&ts.isStringLiteralLike(n.left))strictEvent(n.left.text);
        }
        if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&["runCommand","runCommandAsync"].includes(n.expression.name.text)
            &&n.arguments.length&&ts.isStringLiteralLike(n.arguments[0])){
            const m=/^\/?scriptevent\s+(\S+)/.exec(n.arguments[0].text.trim());if(m)strictEvent(m[1]);
        }
        if(ts.isSwitchStatement(n)&&eventId(n.expression))for(const c of n.caseBlock.clauses)if(ts.isCaseClause(c)&&ts.isStringLiteralLike(c.expression))strictEvent(c.expression.text);
        ts.forEachChild(n,visit);
    };
    if(/\bevent\s*(?:\.|\[)|runCommand/.test(source))visit(ast);
    const durableFamilies=new Set(["plan","jobs","farm_lights","wall_leaf_trim"]);
    for(const m of source.matchAll(/\bciv:([a-z_]+):([a-z0-9_]+)/g)){
        assert.ok(durableFamilies.has(m[1]),`${file}: leftover multi-colon command-like identifier ${m[0]}`);
    }
}
test("command identifiers stay one-colon while known durable-property families may be hierarchical",()=>{
    for(const file of [...walk(scripts),...walk(join(root,"docs")),join(root,"README.md")])assertIdentifierContexts(readFileSync(file,"utf8"),file);
});
test("identifier audit rejects malformed command events even when they resemble allowed durable keys",()=>{
    assert.doesNotThrow(()=>assertIdentifierContexts('const key="civ:wall_leaf_trim:v1:d4:12345678"; const q="civ:jobs:meta";',"property fixture"));
    for(const bad of ["civ:generate:plan","civ:wall_leaf_trim:v1:d4:12345678","civ:jobs:meta","civ:status:","civ:not_registered"]){
        assert.throws(()=>assertIdentifierContexts("/scriptevent "+bad,"bad command fixture"),/script-event|multi-colon/);
    }
    assert.throws(()=>assertIdentifierContexts('const legacy="civ:generate:plan";',"legacy fixture"),/multi-colon/);
    for(const code of ['if(event.id === "civ:jobs:meta") {}','if("civ:wall_leaf_trim:v1" === event.id) {}','switch(event.id){case "civ:plan:meta":break;}','if(event["id"] === "civ:jobs:meta") {}','dimension.runCommand("scriptevent civ:jobs:meta")'])
        assert.throws(()=>assertIdentifierContexts(code,"bad literal handler fixture"),/literal event/);
    assert.doesNotThrow(()=>assertIdentifierContexts('if(event.id === "civ:status") {} switch(event.id){case "civ:people":break;}',"valid handler fixture"));
    const fixtureFile=join(root,"dev","staging","swordsman-combat-fixture","BP","scripts","fixtureInspection.js");
    if(existsSync(fixtureFile)){
        const fixture=readFileSync(fixtureFile,"utf8"),valid=foreignFixtureIds(fixture,fixtureFile);assert.ok(valid.has("ca_fixture:inspect"));
        assert.equal(foreignFixtureIds(fixture,join(scripts,"commands","fixtureInspection.js")).size,0,"foreign commands never enter production scope");
        const ownerReadme=join(root,"dev","staging","swordsman-combat-fixture","README.md");
        assert.ok(foreignFixtureIds("/scriptevent ca_fixture:inspect",ownerReadme).has("ca_fixture:inspect"),"owner README uses only its same-package actual BP registration");
        assert.equal(foreignFixtureIds("/scriptevent ca_fixture:inspect",join(root,"docs","README.md")).size,0,"unrelated README cannot borrow a staged handler");
        assert.equal(foreignFixtureIds("/scriptevent ca_fixture:inspect",join(root,"dev","staging","__missing_fixture_manifest_contract__","README.md")).size,0,"missing owner manifest grants no command scope");
        assert.ok(!foreignFixtureIds('export const COUNTERFEIT="counterfeit:inspect";',ownerReadme).has("counterfeit:inspect"),"README declarations do not self-authorize an unregistered event");
        assert.equal(foreignFixtureIds(fixture.replace('event.id!==FIXTURE_INSPECT_EVENT','event.id!=="unused"'),fixtureFile).size,0,"missing actual handler comparison cannot authorize a fixture example");
        assert.equal(foreignFixtureIds(fixture.replace('namespaces:["ca_fixture"]','namespaces:["different_namespace"]'),fixtureFile).size,0,"namespace mismatch cannot authorize a fixture example");
    }
});

// ---------------------------------------------------------------------------------------------
// A shipped/armed world has `civ_devgate` off and wiped, so the generation listener used to be absent and
// /scriptevent civ:generate_plan district=all and /scriptevent civ:generate_status were answered by nobody.
// Measured live in Minecraft 1.26: the engine echoed "has been sent", the player got no pack line at all,
// while civ:status / civ:district / civ:people / civ:starter_verify (other modules' ids) answered normally.

test("civ:generate_plan and civ:generate_status answer with the development gate off (never silence)", { timeout: 120000 }, async () => {
    resetWorld(1);
    send(GEN_IDS.devgate, "off", makePlayer());
    const plan = makePlayer();
    send(GEN_IDS.plan, "district=all", plan);
    await flush();
    assert.notEqual(text(plan), "", "civ:generate_plan district=all must reply: the engine's 'has been sent' echo is not an answer");
    assert.match(text(plan), /development gate is off/i, text(plan));
    const status = makePlayer();
    send(GEN_IDS.status, "", status);
    await flush();
    assert.notEqual(text(status), "", "civ:generate_status must reply with the gate off");
    assert.match(text(status), /development gate is off/i, text(status));
});

test("the same two ids answer while the development gate is on", { timeout: 120000 }, async () => {
    resetWorld(1);
    const plan = makePlayer();
    send(GEN_IDS.plan, "district=all", plan);
    await flush();
    assert.match(text(plan), /no five-district master plan/, text(plan));
    const status = makePlayer();
    send(GEN_IDS.status, "", status);
    await flush();
    assert.match(text(status), /Civilization generation/, text(status));
});
