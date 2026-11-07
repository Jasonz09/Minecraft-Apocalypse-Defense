// Standalone tooling checks; deliberately outside dev/test/*.test.mjs while
// the active pack's full verification is frozen.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const project=resolve(import.meta.dirname,"../../..");
const tempBase=realpathSync(tmpdir());
const hash=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
function snapshot(dir,prefix="") {
    return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
        const path=join(dir,entry.name),name=prefix+entry.name;
        if(lstatSync(path).isSymbolicLink())return [[name,"link"]];
        return entry.isDirectory()?[[`${name}/`,"directory"],...snapshot(path,`${name}/`)]:[[name,hash(path)]];
    });
}
function fixture(t) {
    const root=mkdtempSync(join(tempBase,"civ-paired-deploy-"));
    t.after(()=>{
        const checked=realpathSync(root),rel=relative(tempBase,checked);
        assert.ok(rel.startsWith("civ-paired-deploy-")&&!rel.includes("..")&&dirname(checked)===tempBase);
        rmSync(checked,{recursive:true,force:true});
    });
    const source=join(root,"project"),bpTarget=join(root,"bp-target"),rpTarget=join(root,"rp-target"),backupRoot=join(root,"retained-backups");
    for(const dir of [join(source,"dev/lib"),bpTarget,rpTarget])mkdirSync(dir,{recursive:true});
    for(const pack of ["CivilizationApocalypse_BP","CivilizationApocalypse_RP"])cpSync(join(project,pack),join(source,pack),{recursive:true});
    for(const file of ["dev/deploy.mjs","dev/lib/content-packs.mjs"])cpSync(join(project,file),join(source,file));
    const run=(...extra)=>spawnSync(process.execPath,[join(source,"dev/deploy.mjs"),"--target",bpTarget,"--resource-target",rpTarget,"--backup-root",backupRoot,...extra],{encoding:"utf8"});
    return {root,source,bpTarget,rpTarget,backupRoot,run,bp:join(bpTarget,"CivilizationApocalypse_BP"),rp:join(rpTarget,"CivilizationApocalypse_RP")};
}
const output=run=>`${run.stdout}\n${run.stderr}`;
const assertPair=f=>{
    assert.deepEqual(snapshot(f.bp),snapshot(join(f.source,"CivilizationApocalypse_BP")));
    assert.deepEqual(snapshot(f.rp),snapshot(join(f.source,"CivilizationApocalypse_RP")));
};

test("paired dry run validates both complete packs without changing any file or directory",t=>{
    const f=fixture(t),before=snapshot(f.root),run=f.run("--dry-run");
    assert.equal(run.status,0,output(run));assert.match(output(run),/CivilizationApocalypse_BP/);assert.match(output(run),/CivilizationApocalypse_RP/);
    assert.match(output(run),/no files or directories changed/);assert.deepEqual(snapshot(f.root),before);
});

test("paired copy installs complete SHA-identical content and preserves unrelated files",t=>{
    const f=fixture(t);writeFileSync(join(f.bpTarget,"unrelated.txt"),"keep");
    const run=f.run();assert.equal(run.status,0,output(run));assert.match(output(run),/verified both packs/);assertPair(f);
    assert.equal(readFileSync(join(f.bpTarget,"unrelated.txt"),"utf8"),"keep");
    assert.equal(readdirSync(f.bpTarget).filter(n=>n.includes(".backup-")).length,0);
});

test("recognized old packs are retained in verified backups before replacement",t=>{
    const f=fixture(t);assert.equal(f.run().status,0);
    writeFileSync(join(f.bp,"obsolete.txt"),"old behavior bytes");
    writeFileSync(join(f.rp,"old-resource.txt"),"old resource bytes");
    const oldBP=snapshot(f.bp),oldRP=snapshot(f.rp),run=f.run();assert.equal(run.status,0,output(run));assertPair(f);
    for(const [name,old] of [["CivilizationApocalypse_BP",oldBP],["CivilizationApocalypse_RP",oldRP]]) {
        const backups=readdirSync(f.backupRoot).filter(n=>n.startsWith(`${name}.backup-`));assert.equal(backups.length,1);
        assert.deepEqual(snapshot(join(f.backupRoot,backups[0])),old);
    }
    assert.equal(readdirSync(f.backupRoot).filter(n=>n.includes(".staging-")).length,0);
    assert.deepEqual(readdirSync(f.bpTarget),["CivilizationApocalypse_BP"]);
    assert.deepEqual(readdirSync(f.rpTarget),["CivilizationApocalypse_RP"]);
});

test("missing RP source and missing texture refuse before modifying either destination",t=>{
    const f=fixture(t);assert.equal(f.run().status,0);
    const beforeBP=snapshot(f.bpTarget),beforeRP=snapshot(f.rpTarget),rpSource=join(f.source,"CivilizationApocalypse_RP");
    renameSync(rpSource,`${rpSource}.missing`);
    let run=f.run();assert.notEqual(run.status,0);assert.deepEqual(snapshot(f.bpTarget),beforeBP);assert.deepEqual(snapshot(f.rpTarget),beforeRP);
    renameSync(`${rpSource}.missing`,rpSource);
    const texture=join(rpSource,"textures/entity/civ_trial/swordsman.png");renameSync(texture,`${texture}.missing`);
    run=f.run();assert.notEqual(run.status,0);assert.match(output(run),/missing texture/);
    assert.deepEqual(snapshot(f.bpTarget),beforeBP);assert.deepEqual(snapshot(f.rpTarget),beforeRP);
});

test("foreign RP UUID refuses the entire pair without half-writing BP or deleting unknown data",t=>{
    const f=fixture(t);assert.equal(f.run().status,0);
    const manifestPath=join(f.rp,"manifest.json"),manifest=JSON.parse(readFileSync(manifestPath,"utf8"));manifest.header.uuid="00000000-0000-4000-8000-000000000001";
    writeFileSync(manifestPath,JSON.stringify(manifest));writeFileSync(join(f.rp,"personal.txt"),"preserve foreign pack");
    writeFileSync(join(f.bp,"old-content.txt"),"recognized but not yet replaced");
    const beforeBP=snapshot(f.bpTarget),beforeRP=snapshot(f.rpTarget),run=f.run();
    assert.notEqual(run.status,0);assert.match(output(run),/different UUID/);
    assert.deepEqual(snapshot(f.bpTarget),beforeBP);assert.deepEqual(snapshot(f.rpTarget),beforeRP);
});

test("custom BP targets require an explicit RP target and source overlap is refused",t=>{
    const f=fixture(t);
    let run=spawnSync(process.execPath,[join(f.source,"dev/deploy.mjs"),"--target",f.bpTarget],{encoding:"utf8"});
    assert.notEqual(run.status,0);assert.match(output(run),/explicit --resource-target/);
    const before=snapshot(f.source);
    run=spawnSync(process.execPath,[join(f.source,"dev/deploy.mjs"),"--target",f.source,"--resource-target",f.rpTarget],{encoding:"utf8"});
    assert.notEqual(run.status,0);assert.match(output(run),/overlaps source/);assert.deepEqual(snapshot(f.source),before);
    assert.deepEqual(readdirSync(f.bpTarget),[]);assert.deepEqual(readdirSync(f.rpTarget),[]);
});

test("linked destination ancestors are refused before any pack copy",t=>{
    const f=fixture(t),linked=join(f.root,"linked-target");symlinkSync(f.bpTarget,linked,process.platform==="win32"?"junction":"dir");
    const beforeRP=snapshot(f.rpTarget),run=spawnSync(process.execPath,[join(f.source,"dev/deploy.mjs"),"--target",linked,"--resource-target",f.rpTarget],{encoding:"utf8"});
    assert.notEqual(run.status,0);assert.match(output(run),/linked path/);assert.deepEqual(readdirSync(f.bpTarget),[]);assert.deepEqual(snapshot(f.rpTarget),beforeRP);
});

test("backup roots inside either scanned parent are refused before staging",t=>{
    const f=fixture(t),beforeBP=snapshot(f.bpTarget),beforeRP=snapshot(f.rpTarget);
    for(const unsafe of [join(f.bpTarget,"retained"),join(f.rpTarget,"retained")]) {
        const run=spawnSync(process.execPath,[join(f.source,"dev/deploy.mjs"),"--target",f.bpTarget,"--resource-target",f.rpTarget,"--backup-root",unsafe],{encoding:"utf8"});
        assert.notEqual(run.status,0);assert.match(output(run),/outside both scanned/);
        assert.deepEqual(snapshot(f.bpTarget),beforeBP);assert.deepEqual(snapshot(f.rpTarget),beforeRP);
    }
});

test("default retained backups live outside scanned pack parents",t=>{
    const f=fixture(t),args=[join(f.source,"dev/deploy.mjs"),"--target",f.bpTarget,"--resource-target",f.rpTarget];
    let run=spawnSync(process.execPath,args,{encoding:"utf8"});assert.equal(run.status,0,output(run));
    run=spawnSync(process.execPath,args,{encoding:"utf8"});assert.equal(run.status,0,output(run));
    const outside=join(f.root,"codex_pack_backups");
    assert.equal(readdirSync(outside).filter(n=>n.includes(".backup-")).length,2);
    assert.deepEqual(readdirSync(f.bpTarget),["CivilizationApocalypse_BP"]);
    assert.deepEqual(readdirSync(f.rpTarget),["CivilizationApocalypse_RP"]);
});
