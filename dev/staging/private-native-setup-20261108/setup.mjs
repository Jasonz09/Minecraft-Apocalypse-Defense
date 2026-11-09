// Staged helper only. No import-time actions, default paths, game launch or cleanup.
// Path/UUID/hash/retained-backup rules follow dev/deploy.mjs, with paired rollback.
import {closeSync,cpSync,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readSync,readdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,parse,relative,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {readLevelDat} from '../../lib/nbt.mjs';

const LIMIT=16*1024*1024;
const names=['CivilizationApocalypse_BP','CivilizationApocalypse_RP'];
const scanned=new Set(['behavior_packs','resource_packs','development_behavior_packs','development_resource_packs']);
const fail=m=>{throw Error(m);};
const inside=(a,b)=>{const r=relative(a,b);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../');};
const overlap=(a,b)=>inside(a,b)||inside(b,a);
function absolute(p){if(typeof p!=='string'||!isAbsolute(p))fail('absolute path required');return resolve(p);}
function noLinks(path){for(let p=absolute(path);;p=dirname(p)){let s;try{s=lstatSync(p);}catch(e){if(e.code!=='ENOENT')throw e;}if(s?.isSymbolicLink())fail('linked path refused');if(dirname(p)===p)break;}}
function future(path){noLinks(path);return existsSync(path)?realpathSync(path):join(future(dirname(path)),relative(dirname(path),path));}
function bounded(base,path){noLinks(base);noLinks(path);if(path===base||!inside(base,path)||!inside(future(base),future(path)))fail('path escaped intended directory');}
function read(path){noLinks(path);const fd=openSync(path,'r');try{const s=fstatSync(fd);if(!s.isFile()||!Number.isSafeInteger(s.size)||s.size>LIMIT)fail('file byte bound');const b=Buffer.alloc(s.size);let at=0;while(at<b.length){const n=readSync(fd,b,at,b.length-at,at);if(!n)fail('file truncated');at+=n;}if(readSync(fd,Buffer.alloc(1),0,1,at))fail('file grew');return b;}finally{closeSync(fd);}}
const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
const json=p=>JSON.parse(read(p).toString('utf8').replace(/^\uFEFF/,''));
export const readSetupOptions=path=>json(absolute(path));
export function inventory(dir){noLinks(dir);const result=[];let dirs=0,total=0;function walk(at,prefix=''){if(++dirs>4096)fail('directory cap');for(const entry of readdirSync(at,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(at,entry.name),s=lstatSync(p),name=prefix+entry.name;if(s.isSymbolicLink())fail('linked content');if(s.isDirectory())walk(p,name+'/');else if(s.isFile()){if(result.length>=4096||s.size>LIMIT||(total+=s.size)>64*1024*1024)fail('inventory bound');const bytes=read(p);if(bytes.length!==s.size)fail('inventory changed');result.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}else fail('nonregular content');}}walk(dir);return result.sort((a,b)=>a.path.localeCompare(b.path));}
function verify(dir,expected){if(!isDeepStrictEqual(inventory(dir),expected))fail('inventory/hash mismatch: '+dir);}
function expectedRows(rows){return rows.map(r=>({path:r.path,bytes:r.bytes,sha256:r.sha256})).sort((a,b)=>a.path.localeCompare(b.path));}

// Full bounded NBT walk locates one real LevelName string without reserializing
// unrelated tag types. Existing reader independently reparses semantic contents.
function nameSpan(bytes){if(bytes.length<12||bytes.readInt32LE(4)!==bytes.length-8)fail('NBT exact payload length');let at=8,nodes=0;const matches=[];
 const take=n=>{if(!Number.isSafeInteger(n)||n<0||at+n>bytes.length)fail('NBT bounds');const begin=at;at+=n;return begin;};
 const u8=()=>bytes[take(1)],u16=()=>bytes.readUInt16LE(take(2)),count=()=>{const n=bytes.readInt32LE(take(4));if(n<0||n>1000000)fail('NBT array/list bound');return n;};
 const str=()=>{const begin=at,n=u16(),p=take(n);return{begin,end:at,value:new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(p,p+n))};};
 function payload(type,path,depth){if(++nodes>100000||depth>64)fail('NBT tree bound');if(type===8){const s=str();if(path.join('/')==='LevelName'||path.join('/')==='Level/LevelName')matches.push({...s,path});return;}
  if([1,2,3,4,5,6].includes(type)){take(({1:1,2:2,3:4,4:8,5:4,6:8})[type]);return;}
  if(type===7||type===11||type===12){take(count()*(type===7?1:type===11?4:8));return;}
  if(type===9){const sub=u8(),n=count();if(n&&sub===0)fail('NBT invalid list type');for(let i=0;i<n;i++)payload(sub,[...path,String(i)],depth+1);return;}
  if(type===10){const seen=new Set();for(;;){const sub=u8();if(!sub)break;const key=str().value;if(seen.has(key))fail('NBT duplicate name');seen.add(key);payload(sub,[...path,key],depth+1);}return;}fail('unsupported NBT tag');
 }
 if(u8()!==10)fail('NBT root compound required');str();payload(10,[],0);if(at!==bytes.length||matches.length!==1)fail('NBT one exact LevelName required');return matches[0];
}
export function renameWorldLevel(bytes,visibleName){if(typeof visibleName!=='string'||!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(visibleName))fail('bounded visible name required');const span=nameSpan(bytes);if(span.value===visibleName)fail('visible name must differ from pristine source');const before=readLevelDat(bytes),text=Buffer.from(visibleName,'utf8'),length=Buffer.alloc(2);length.writeUInt16LE(text.length);const result=Buffer.concat([bytes.subarray(0,span.begin),length,text,bytes.subarray(span.end)]);result.writeInt32LE(result.length-8,4);const after=readLevelDat(result),check=nameSpan(result),expected=structuredClone(before);let slot=expected.data;for(const k of span.path.slice(0,-1))slot=slot[k];slot[span.path.at(-1)]=visibleName;if(check.value!==visibleName||!isDeepStrictEqual(after,expected))fail('NBT unrelated fields changed');return result;}

export function assertMinecraftClosed(){const script="$p=@(Get-Process | Where-Object { $_.ProcessName -match '^Minecraft(\\.Windows|\\.Bedrock)?$' }); if($p.Count -ne 0){exit 7}";try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:'pipe',windowsHide:true});}catch{fail('Minecraft is running or closed-game process check failed');}}

export function makeSetupPlan(options){
 const o={...options};for(const key of ['bundleRoot','behaviorParent','resourceParent','worldParent','backupRoot'])o[key]=absolute(o[key]);
 if(!/^[A-F0-9]{64}$/.test(o.bundleManifestSha256??''))fail('reviewed bundle manifest SHA required');
 o.transactionId??='private-'+randomUUID();if(!/^[A-Za-z0-9_-]{1,64}$/.test(o.transactionId)||!/^[A-Za-z0-9_-]{1,64}$/.test(o.worldFolder??''))fail('bounded new transaction/world folder required');
 for(const p of [o.behaviorParent,o.resourceParent,o.worldParent]){noLinks(p);if(!lstatSync(p).isDirectory())fail('existing target parent required');}
 noLinks(o.bundleRoot);noLinks(o.backupRoot);if(existsSync(o.backupRoot)&&!lstatSync(o.backupRoot).isDirectory())fail('backup root must be directory');if(o.backupRoot.split(/[\\/]/).some(p=>scanned.has(p.toLowerCase())))fail('backup must be outside all scanned pack parents');
 if(overlap(o.backupRoot,o.bundleRoot))fail('backup overlaps immutable bundle');
 const parents=[o.behaviorParent,o.resourceParent,o.worldParent];for(const p of parents){if(overlap(p,o.backupRoot)||overlap(p,o.bundleRoot)||parse(p).root.toLowerCase()!==parse(o.backupRoot).root.toLowerCase())fail('backup/source/target containment or volume mismatch');}
 for(let i=0;i<parents.length;i++)for(let j=i+1;j<parents.length;j++)if(overlap(parents[i],parents[j]))fail('target parents must be disjoint');
 const manifestFile=join(o.bundleRoot,'PROMOTION-HASHES.json');if(sha(read(manifestFile))!==o.bundleManifestSha256)fail('bundle manifest changed');const m=json(manifestFile),packPlan=json(join(o.bundleRoot,'PRIVATE-PACK-PLAN.json'));
 if(sha(read(join(o.bundleRoot,'PRIVATE-PACK-PLAN.json')))!==m.stagedPrivatePack.sha256||sha(read(join(o.bundleRoot,'DERIVATIVE-PLAN.json')))!==m.derivative.sha256)fail('bundle plan pin mismatch');
 const run=join(o.backupRoot,o.transactionId),world=join(o.worldParent,o.worldFolder);bounded(o.backupRoot,run);bounded(o.worldParent,world);if(existsSync(run)||existsSync(world))fail('new transaction/world target already exists');
 const packs=names.map((name,i)=>{const source=join(o.bundleRoot,'private-packs',name),base=parents[i],dest=join(base,name),expected=expectedRows(packPlan.inventory.filter(f=>f.path.startsWith(name+'/')).map(f=>({...f,path:f.path.slice(name.length+1)})));verify(source,expected);bounded(base,dest);let previous=null;if(existsSync(dest)){if(json(join(dest,'manifest.json')).header.uuid!==json(join(source,'manifest.json')).header.uuid)fail('unrecognized installed UUID');previous=inventory(dest);}return{name,source,base,dest,expected,previous,stage:join(run,'staged-'+i),backup:join(run,'previous-'+i),failed:join(run,'retained-new-'+i),restoreStage:join(run,'restore-staged-'+i)};});
 // Prevent a second same-UUID pack elsewhere in normal Shared/user scan roots.
 const scanRoots=new Set(parents.flatMap(p=>[...scanned].map(name=>join(dirname(p),name))));scanRoots.add(o.behaviorParent);scanRoots.add(o.resourceParent);
 for(const base of scanRoots)if(existsSync(base)){noLinks(base);const entries=readdirSync(base,{withFileTypes:true});if(entries.length>1024)fail('scanned parent directory cap');for(const entry of entries){const folder=join(base,entry.name);if(!entry.isDirectory())continue;noLinks(folder);const file=join(folder,'manifest.json');if(!existsSync(file))continue;const id=json(file).header?.uuid;for(const p of packs)if(String(id??'').toLowerCase()===String(json(join(p.source,'manifest.json')).header.uuid).toLowerCase()&&future(folder)!==future(p.dest))fail('duplicate pack UUID in another scanned folder: '+folder);}}
 if(Boolean(packs[0].previous)!==Boolean(packs[1].previous))fail('existing pair must be complete or both absent');
 const sourceWorld=join(o.bundleRoot,'derivative-world'),sourceExpected=inventory(sourceWorld);if(!isDeepStrictEqual(sourceExpected.map(({path,sha256})=>({path,sha256})),m.derivative.files))fail('derivative source pin mismatch');
 const renamed=renameWorldLevel(read(join(sourceWorld,'level.dat')),o.visibleName);const worldNameBytes=Buffer.from(o.visibleName+'\n');const expectedWorld=sourceExpected.map(f=>f.path==='level.dat'?{path:f.path,bytes:renamed.length,sha256:sha(renamed)}:f.path==='levelname.txt'?{path:f.path,bytes:worldNameBytes.length,sha256:sha(worldNameBytes)}:f);if(read(join(sourceWorld,'levelname.txt')).toString('utf8').trim()===o.visibleName)fail('visible name not distinct');
 return{v:1,options:o,run,packs,world:{source:sourceWorld,sourceExpected,expected:expectedWorld,dest:world,stage:join(run,'staged-world'),failed:join(run,'retained-world'),renamedLevelSha256:sha(renamed)},nativeInstalled:false};
}

/** Explicit execution API only; no CLI or import-time install. Hook is a test-only fault seam. */
export function applySetupPlan(plan,{assertClosed=assertMinecraftClosed,hooks={}}={}){
 const fresh=makeSetupPlan(plan.options);if(!isDeepStrictEqual(fresh,plan))fail('setup plan stale');assertClosed();const state={v:1,phase:'starting',plan,steps:[],rollback:[],manualRecovery:false};let receipt=0,worldPublished=false,worldExpected;
 const journal=phase=>{state.phase=phase;writeFileSync(join(plan.run,`receipt-${String(++receipt).padStart(3,'0')}.json`),JSON.stringify(state,null,2)+'\n',{flag:'wx'});};
 const move=(fromBase,from,toBase,to,expected,label)=>{assertClosed();bounded(fromBase,from);bounded(toBase,to);verify(from,expected);if(existsSync(to))fail('refuse overwrite: '+to);hooks.beforeMove?.(label,{from,to,state});assertClosed();bounded(fromBase,from);bounded(toBase,to);verify(from,expected);if(existsSync(to))fail('target appeared: '+to);renameSync(from,to);state.steps.push(label);};
 mkdirSync(plan.options.backupRoot,{recursive:true});noLinks(plan.options.backupRoot);bounded(plan.options.backupRoot,plan.run);mkdirSync(plan.run);
 try{
  for(const p of plan.packs){mkdirSync(p.stage);cpSync(p.source,p.stage,{recursive:true,errorOnExist:true,force:false});verify(p.stage,p.expected);}
  mkdirSync(plan.world.stage);cpSync(plan.world.source,plan.world.stage,{recursive:true,errorOnExist:true,force:false});verify(plan.world.stage,plan.world.sourceExpected);
  writeFileSync(join(plan.world.stage,'level.dat'),renameWorldLevel(read(join(plan.world.stage,'level.dat')),plan.options.visibleName));writeFileSync(join(plan.world.stage,'levelname.txt'),plan.options.visibleName+'\n');worldExpected=plan.world.expected;verify(plan.world.stage,worldExpected);
  const changed=worldExpected.filter((e,i)=>e.sha256!==plan.world.sourceExpected[i]?.sha256).map(e=>e.path);if(!isDeepStrictEqual(changed.sort(),['level.dat','levelname.txt']))fail('world metadata change escaped exact naming scope');
  for(const p of plan.packs)verify(p.source,p.expected);verify(plan.world.source,plan.world.sourceExpected);journal('staged-and-verified');
  for(const p of plan.packs)if(p.previous){move(p.base,p.dest,plan.run,p.backup,p.previous,'backup-'+p.name);p.oldMoved=true;verify(p.backup,p.previous);journal('backed-up-'+p.name);}
  for(const p of plan.packs){move(plan.run,p.stage,p.base,p.dest,p.expected,'install-'+p.name);p.newMoved=true;verify(p.dest,p.expected);journal('installed-'+p.name);}
  move(plan.run,plan.world.stage,plan.options.worldParent,plan.world.dest,worldExpected,'publish-world');worldPublished=true;verify(plan.world.dest,worldExpected);journal('complete');return state;
 }catch(error){state.error=String(error);
  try{
   assertClosed();if(worldPublished){move(plan.options.worldParent,plan.world.dest,plan.run,plan.world.failed,worldExpected,'retain-failed-world');state.rollback.push('world-retained');}
   for(const p of [...plan.packs].reverse()){if(p.newMoved){move(p.base,p.dest,plan.run,p.failed,p.expected,'retain-'+p.name);state.rollback.push('new-retained-'+p.name);}if(p.oldMoved){assertClosed();bounded(plan.run,p.restoreStage);if(existsSync(p.restoreStage))fail('restore staging collision');verify(p.backup,p.previous);mkdirSync(p.restoreStage);cpSync(p.backup,p.restoreStage,{recursive:true,errorOnExist:true,force:false});verify(p.restoreStage,p.previous);move(plan.run,p.restoreStage,p.base,p.dest,p.previous,'restore-'+p.name);p.oldRestored=true;state.rollback.push('old-restored-copy-'+p.name);}}
  }catch(rollback){state.manualRecovery=true;state.rollbackError=String(rollback);}
  try{journal('failed-preserved');}catch{}const failure=Error('private setup failed; all bytes retained for recovery: '+String(error));failure.receipt=state;throw failure;
 }
}
