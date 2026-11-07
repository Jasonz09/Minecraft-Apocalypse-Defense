// Copies the complete BP/RP pair. Never touches worlds or deletes prior packs.
// Usage: node dev/deploy.mjs [--dry-run]
// Custom targets: --target <BP directory> --resource-target <RP directory>
// Optional --backup-root <directory outside scanned pack parents, same volume>.
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentPackProblems } from "./lib/content-packs.mjs";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const inside=(parent,path)=>{const r=relative(parent,path);return r===""||(!isAbsolute(r)&&r!==".."&&!r.startsWith("..\\")&&!r.startsWith("../"));};
const overlaps=(a,b)=>inside(a,b)||inside(b,a);
const hash=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
const parsed={dryRun:false,target:undefined,resourceTarget:undefined,backupRoot:undefined};
function reject(message){throw new Error(message);}
function parse(argv) {
    const seen=new Set();
    for(let i=0;i<argv.length;i++) {
        const flag=argv[i];
        if(seen.has(flag))reject(`duplicate option ${flag}`);seen.add(flag);
        if(flag==="--dry-run"){parsed.dryRun=true;continue;}
        if(!["--target","--resource-target","--backup-root"].includes(flag))reject(`unknown option ${flag}`);
        const value=argv[++i];if(!value||value.startsWith("--"))reject(`${flag} needs a directory`);
        parsed[flag==="--target"?"target":flag==="--resource-target"?"resourceTarget":"backupRoot"]=resolve(value);
    }
    if(parsed.target&&!parsed.resourceTarget)reject("a custom --target also requires an explicit --resource-target directory");
}
// A linked ancestor can redirect an apparently bounded destination.
function noLinks(path) {
    for(let point=resolve(path);;point=dirname(point)) {
        let stat;try{stat=lstatSync(point);}catch(error){if(error.code!=="ENOENT")throw error;}
        if(stat?.isSymbolicLink())reject(`refusing linked path: ${point}`);
        if(dirname(point)===point)break;
    }
}
function manifest(path){return JSON.parse(readFileSync(join(path,"manifest.json"),"utf8"));}
function futureReal(path) {
    noLinks(path);
    if(existsSync(path))return realpathSync(path);
    if(dirname(path)===path)reject(`backup or target volume does not exist: ${path}`);
    return join(futureReal(dirname(path)),relative(dirname(path),path));
}
function files(dir,base=dir) {
    const entries=[];
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
        const full=join(dir,entry.name),stat=lstatSync(full);
        if(stat.isSymbolicLink())reject(`refusing linked content: ${full}`);
        if(stat.isDirectory())entries.push(...files(full,base));
        else if(stat.isFile())entries.push(relative(base,full).replaceAll("\\","/"));
        else reject(`refusing non-file content: ${full}`);
    }
    return entries.sort();
}
const fingerprint=dir=>new Map(files(dir).map(name=>[name,hash(join(dir,name))]));
function verify(dir,expected) {
    const actual=fingerprint(dir);
    if(actual.size!==expected.size||[...expected].some(([name,value])=>actual.get(name)!==value))reject(`SHA256 verification failed: ${dir}`);
}
function bounded(base,path) {
    noLinks(base);noLinks(path);
    const realBase=futureReal(base);
    const checked=futureReal(path);
    if(checked===realBase||!inside(realBase,checked)||!inside(base,path))reject(`refusing path outside intended pack directory: ${path}`);
    return checked;
}
function move(fromBase,from,toBase,to) {
    bounded(fromBase,from);bounded(toBase,to);
    if(existsSync(to))reject(`refusing to overwrite existing path: ${to}`);
    renameSync(from,to);
}
function run() {
    parse(process.argv.slice(2));
    if(!parsed.target&&!process.env.APPDATA)reject("APPDATA is unavailable; provide both explicit target directories");
    const shared=join(process.env.APPDATA??"","Minecraft Bedrock","Users","Shared","games","com.mojang");
    const nonce=`${new Date().toISOString().replaceAll(/[:.]/g,"-")}-${randomUUID().slice(0,8)}`;
    const packs=[
        {name:"CivilizationApocalypse_BP",kind:"behavior_packs",base:parsed.target??join(shared,"development_behavior_packs")},
        {name:"CivilizationApocalypse_RP",kind:"resource_packs",base:parsed.resourceTarget??join(shared,"development_resource_packs")},
    ].map(p=>({...p,base:resolve(p.base),source:join(root,p.name)}));
    const backupRoot=futureReal(parsed.backupRoot??join(dirname(packs[0].base),"codex_pack_backups"));
    if(existsSync(backupRoot)&&!lstatSync(backupRoot).isDirectory())reject(`backup root is not a directory: ${backupRoot}`);
    const scanned=new Set(["behavior_packs","resource_packs","development_behavior_packs","development_resource_packs"]);
    if(backupRoot.split(/[\\/]/).some(part=>scanned.has(part.toLowerCase())))reject("backup root must be outside all scanned pack directories");
    for(const p of packs) {
        noLinks(p.base);noLinks(p.source);
        if(!existsSync(p.base)||!lstatSync(p.base).isDirectory())reject(`development pack directory not found: ${p.base}`);
        p.source=realpathSync(p.source);p.base=realpathSync(p.base);
        p.dest=join(p.base,p.name);p.stage=join(backupRoot,`${p.name}.staging-${nonce}`);p.backup=join(backupRoot,`${p.name}.backup-${nonce}`);
        p.sourceHash=fingerprint(p.source);
        bounded(p.base,p.dest);
        for(const path of [p.stage,p.backup])bounded(backupRoot,path);
        if(existsSync(p.stage)||existsSync(p.backup))reject(`staging/backup collision for ${p.name}`);
    }
    const problems=contentPackProblems(packs.map(p=>({root:p.source,kind:p.kind})));
    if(problems.length)reject(`source content validation failed:\n${problems.join("\n")}`);
    // Preflight the complete pair before staging or modifying either installed pack.
    for(const p of packs) {
        if(parsePath(p.base).root.toLowerCase()!==parsePath(backupRoot).root.toLowerCase())reject("backup root must be on the same volume as both development pack directories");
        for(const other of packs) {
            for(const path of [p.dest,p.stage,p.backup])if(overlaps(path,other.source))reject(`target overlaps source content: ${path}`);
            if(p!==other&&overlaps(p.dest,other.dest))reject("BP and RP destinations must be disjoint");
            if(inside(other.base,backupRoot)||inside(other.base,p.backup))reject("backup root must be outside both scanned development pack parents");
        }
        if(existsSync(p.dest)) {
            if(!lstatSync(p.dest).isDirectory())reject(`existing target is not a directory: ${p.dest}`);
            let old;try{old=manifest(p.dest);}catch(_error){reject(`existing target is not a recognized pack: ${p.dest}`);}
            if(old.header?.uuid!==manifest(p.source).header.uuid)reject(`existing target has a different UUID: ${p.dest}`);
            p.oldHash=fingerprint(p.dest);
        }
        console.log(`${parsed.dryRun?"[dry run] ":""}${p.name}: ${p.sourceHash.size} files\n  source: ${p.source}\n  target: ${p.dest}${p.oldHash?`\n  retained backup: ${p.backup}`:""}`);
    }
    if(parsed.dryRun){console.log("preflight passed; no files or directories changed");return;}
    if(!existsSync(backupRoot)) {
        noLinks(backupRoot);
        for(const p of packs)if(inside(p.base,backupRoot)||overlaps(backupRoot,p.source))reject("backup root containment changed after preflight");
        mkdirSync(backupRoot,{recursive:true});
    }
    // Stage and verify both packs before the first installed pack is renamed.
    for(const p of packs) {
        bounded(backupRoot,p.stage);mkdirSync(p.stage);
        bounded(backupRoot,p.stage);cpSync(p.source,p.stage,{recursive:true,errorOnExist:true});
        verify(p.stage,p.sourceHash);
    }
    // Two directory commits are not a multi-directory atomic transaction.
    // On filesystem failure retain originals/staging for manual recovery.
    for(const p of packs) {
        if(p.oldHash) {
            verify(p.dest,p.oldHash);move(p.base,p.dest,backupRoot,p.backup);verify(p.backup,p.oldHash);
        } else if(existsSync(p.dest))reject(`target appeared after preflight: ${p.dest}`);
        move(backupRoot,p.stage,p.base,p.dest);verify(p.dest,p.sourceHash);
    }
    console.log(`deployed and SHA256-verified both packs: ${packs.reduce((sum,p)=>sum+p.sourceHash.size,0)} files byte-identical`);
}
try{run();}catch(error){console.error(`Deploy refused or interrupted: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;}
