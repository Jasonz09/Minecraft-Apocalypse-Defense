import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url)),project=resolve(here,'../../..');
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const bases=JSON.parse(readFileSync(join(here,'base-hashes.json'),'utf8'));
for(const row of bases)if(digest(join(project,row.path))!==row.sha256)throw new Error('Baseline changed: '+row.path);
// Fail rather than silently test a moving dependency tree.
const snapshot=JSON.parse(readFileSync(join(here,'pack-base-hashes.json'),'utf8'));
for(const row of snapshot)if(digest(join(project,row.path))!==row.sha256)throw new Error('Frozen dependency changed: '+row.path);
const runtime=join(here,'runtime');mkdirSync(runtime,{recursive:true});
cpSync(join(project,'CivilizationApocalypse_BP'),join(runtime,'CivilizationApocalypse_BP'),{recursive:true});
cpSync(join(project,'dev/lib'),join(runtime,'dev/lib'),{recursive:true});
mkdirSync(join(runtime,'dev/fixtures'),{recursive:true});
for(const name of ['wall-leaf-closed-source-20261106.json','wall-leaf-preview-20261106.json'])cpSync(join(project,'dev/fixtures',name),join(runtime,'dev/fixtures',name));
cpSync(join(here,'proposed/CivilizationApocalypse_BP'),join(runtime,'CivilizationApocalypse_BP'),{recursive:true});
writeFileSync(join(here,'overlay-receipt.json'),JSON.stringify({scope:'ISOLATED test overlay only; no active or installed edits',bases,dependencyFiles:snapshot.length},null,2)+'\n');
console.log('Prepared isolated overlay only. No test, planner, native action or deployment executed.');
