import {copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {contentPackProblems,packBindings,packBindingProblems} from './content-packs.mjs';
import {crc32,listZip,writeZip} from './zip.mjs';

export const PREVIEW_KIND='CivilizationApocalypseDeveloperPreview';
export const PREVIEW_LIMITS=Object.freeze({filesPerPack:2048,fileBytes:16*1024*1024,totalBytes:64*1024*1024,archiveBytes:80*1024*1024});
const PACKS=Object.freeze([{source:'CivilizationApocalypse_BP',kind:'behavior_packs',archive:'behavior.mcpack'},{source:'CivilizationApocalypse_RP',kind:'resource_packs',archive:'resources.mcpack'}]);
const OUTPUTS=['DEVELOPER-PREVIEW.txt','developer-preview.mcaddon','packs/behavior.mcpack','packs/resources.mcpack','world-bindings/world_behavior_packs.json','world-bindings/world_resource_packs.json'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const json=path=>{if(lstatSync(path).size>2*1024*1024)refuse('metadata JSON byte limit');return JSON.parse(readFileSync(path,'utf8'));};
const inside=(a,b)=>{const rel=relative(a,b);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const refuse=message=>{throw Error(message);};
function noLinks(path){for(let p=resolve(path);;p=dirname(p)){let st;try{st=lstatSync(p);}catch(e){if(e.code!=='ENOENT')throw e;}if(st?.isSymbolicLink())refuse('linked path refused: '+p);if(dirname(p)===p)break;}}
function futureReal(path){noLinks(path);if(existsSync(path))return realpathSync(path);if(dirname(path)===path)refuse('missing output volume');return join(futureReal(dirname(path)),relative(dirname(path),path));}
function tree(root,allowed,maxFiles=PREVIEW_LIMITS.filesPerPack){noLinks(root);const files=[];let directories=0;const visit=(dir,prefix='')=>{if(++directories>4096)refuse('directory census bound exceeded');for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const full=join(dir,entry.name),st=lstatSync(full),name=prefix+entry.name;if(st.isSymbolicLink())refuse('linked content refused: '+full);if(st.isDirectory()){if(allowed&&!allowed.some(p=>p.startsWith(name+'/')))refuse('unexpected preview directory: '+name);visit(full,name+'/');}else if(st.isFile()){if(allowed&&!allowed.includes(name))refuse('unexpected preview file: '+name);if(files.length>=maxFiles)refuse('file census bound exceeded');files.push({name,path:full,bytes:st.size});}else refuse('non-file content refused: '+full);}};visit(root);return files.sort((a,b)=>a.name<b.name?-1:1);}
function canonicalName(name){return typeof name==='string'&&name.length>0&&name.length<=240&&!name.includes('\\')&&!name.includes(':')&&!name.includes('\0')&&name.split('/').every(p=>p&&p!=='.'&&p!=='..');}
function inventory(dir,allowed){return tree(dir,allowed).map(({name,path,bytes})=>({name,bytes,sha256:hash(readFileSync(path))}));}
function equalInventory(actual,wanted,label){if(!same(actual,wanted))refuse(label+' inventory/SHA differs');}
function sourcePlan(projectRoot){
 const root=realpathSync(resolve(projectRoot));noLinks(projectRoot);
 const packs=PACKS.map(p=>({...p,root:join(root,p.source)}));let total=0;
 for(const p of packs){p.files=tree(p.root).map(f=>{if(f.name==='level.dat'||f.name==='level.dat_old'||f.name==='levelname.txt'||f.name.startsWith('db/')||/\.(mcworld|mctemplate)$/i.test(f.name))refuse('world/database payload is not a pack preview: '+f.name);if(!canonicalName(f.name)||f.bytes>PREVIEW_LIMITS.fileBytes)refuse('unsafe/oversize source entry: '+f.name);total+=f.bytes;if(total>PREVIEW_LIMITS.totalBytes)refuse('source byte limit exceeded');const bytes=readFileSync(f.path);if(bytes.length!==f.bytes||bytes.length>PREVIEW_LIMITS.fileBytes)refuse('source changed/oversize during read');return{name:f.name,bytes:bytes.length,sha256:hash(bytes),data:bytes};});if(!p.files.length||p.files.length>PREVIEW_LIMITS.filesPerPack)refuse('source file-count limit');}
 const identities=new Set();for(const p of packs){p.manifest=json(join(p.root,'manifest.json'));for(const entry of [p.manifest.header,...(p.manifest.modules??[])]){const id=String(entry?.uuid??'').toLowerCase();if(identities.has(id))refuse('duplicate canonical pack/module UUID');identities.add(id);}}
 const problems=contentPackProblems(packs);if(problems.length)refuse('paired content preflight failed: '+problems.join('; '));
 const behavior=json(join(packs[0].root,'manifest.json'));
 const scripts=(behavior.modules??[]).filter(m=>m.type==='script');
 if(scripts.length!==1||scripts[0].language!=='javascript'||!canonicalName(scripts[0].entry)||!scripts[0].entry.endsWith('.js')||!packs[0].files.some(f=>f.name===scripts[0].entry))refuse('behavior script entry must resolve inside complete pack');
 if(!(behavior.dependencies??[]).some(d=>d.module_name==='@minecraft/server'&&d.version==='2.7.0'))refuse('expected stable @minecraft/server2.7.0 dependency');
 for(const p of packs)p.manifest=json(join(p.root,'manifest.json'));
 const bindings={world_behavior_packs:packBindings(packs,'behavior_packs'),world_resource_packs:packBindings(packs,'resource_packs')};
 for(const p of packs)equalInventory(inventory(p.root),p.files.map(({data,...f})=>f),'source changed during preflight');
 return{root,packs,bindings,total};
}
function bindingCheck(dir,bindings){if(!dir)return{state:'NOT_CHECKED',scope:'No world supplied; examples are not installed bindings or clean-world proof'};noLinks(dir);for(const [key,wanted]of Object.entries(bindings)){const file=join(dir,key+'.json');noLinks(file);const problems=packBindingProblems(json(file),wanted,key);if(problems.length)refuse('read-only binding check failed: '+problems.join('; '));}return{state:'MATCHES',scope:'Only two supplied JSON pack-binding lists checked; no database/arming/clean-world evidence'};}
function outputPath(root,label){if(typeof label!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(label))refuse('label must be a bounded lowercase slug');const parent=join(root,'dist','developer-previews'),target=join(parent,label);const checked=futureReal(target);if(!inside(root,checked)||!inside(futureReal(parent),checked)||checked===futureReal(parent))refuse('preview path escaped workspace output');for(const p of PACKS)if(inside(join(root,p.source),checked)||inside(checked,join(root,p.source)))refuse('output overlaps source pack');return{parent,target};}
function revalidate(plan){for(const p of plan.packs)equalInventory(inventory(p.root),p.files.map(({data,...f})=>f),'source changed before preview publication');}
function cleanup(parent,temp){noLinks(parent);noLinks(temp);const base=realpathSync(parent),actual=realpathSync(temp);if(!inside(base,actual)||actual===base||!relative(base,actual).startsWith('.preview-build-'))refuse('refusing unowned cleanup path');tree(temp,undefined,2*PREVIEW_LIMITS.filesPerPack+32);rmSync(temp,{recursive:true,force:false});}
/** Safe developer artifact only: never reads/copies world databases or changes release gates.
 * Hooks are a privileged offline fault seam, not CLI/request arguments. */
export function buildDeveloperPreview({projectRoot,label='current-dev',dryRun=true,bindingsDir,hooks={}}){
 const plan=sourcePlan(projectRoot),out=outputPath(plan.root,label),bindingStatus=bindingCheck(bindingsDir,plan.bindings);
 if(existsSync(out.target))refuse('preview target already exists; preserve it and choose a new label');
 const summary={kind:PREVIEW_KIND,v:1,label,developerPreview:true,worldIncluded:false,releaseApproved:false,cleanStarterVerified:false,sourceFiles:plan.packs.reduce((n,p)=>n+p.files.length,0),bindings:plan.bindings,bindingStatus};
 if(dryRun)return{...summary,dryRun:true,output:out.target};
 noLinks(out.parent);mkdirSync(out.parent,{recursive:true});noLinks(out.parent);
 const temp=mkdtempSync(join(out.parent,'.preview-build-'));
 try{
  const work=join(temp,'work'),publish=join(temp,'publish'),bundle=join(work,'bundle');mkdirSync(join(publish,'packs'),{recursive:true});mkdirSync(join(publish,'world-bindings'),{recursive:true});mkdirSync(bundle,{recursive:true});
  for(const p of plan.packs){const packdir=join(work,p.source);for(const f of p.files){const target=join(packdir,f.name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,f.data,{flag:'wx'});}writeZip(packdir,join(publish,'packs',p.archive));copyFileSync(join(publish,'packs',p.archive),join(bundle,p.archive));}
  writeZip(bundle,join(publish,'developer-preview.mcaddon'));
  for(const [key,value]of Object.entries(plan.bindings))writeFileSync(join(publish,'world-bindings',key+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(publish,'DEVELOPER-PREVIEW.txt'),'DEVELOPER PREVIEW — PACKS ONLY\nNot a starter world or clean release. No world/database is included.\nBoth pack UUIDs and bytes are preserved; import/native acceptance is untested.\nUse only a backed-up disposable test world. Binding examples do not modify a world.\nThe existing dev/check-release.mjs and starter verification gates still apply.\n',{flag:'wx'});
  const receipt={...summary,createdUTC:new Date().toISOString(),packs:plan.packs.map(p=>({source:p.source,kind:p.kind,archive:p.archive,header:p.manifest.header,files:p.files.map(({data,...f})=>f)})),outputs:inventory(publish),nativeImportVerified:false,starterGateOverridden:false};
  writeFileSync(join(publish,'preview-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  validateDeveloperPreview({projectRoot:plan.root,directory:publish,bindingsDir});
  hooks.beforePublish?.({directory:publish,target:out.target});revalidate(plan);bindingCheck(bindingsDir,plan.bindings);noLinks(out.target);if(existsSync(out.target))refuse('preview target appeared; preserved without overwrite');
  renameSync(publish,out.target);
  return{...summary,dryRun:false,output:out.target,receiptSha256:hash(readFileSync(join(out.target,'preview-receipt.json'))),archiveSha256:hash(readFileSync(join(out.target,'developer-preview.mcaddon')))};
 }finally{if(existsSync(temp))cleanup(out.parent,temp);}
}
// Strict bounded ZIP reader for the exact canonical stored/deflated format we emit.
// Never extracts user input; output-size cap is supplied before inflation.
function checkedArchive(bytes,wanted,label){
 if(bytes.length<22||bytes.length>PREVIEW_LIMITS.archiveBytes)refuse(label+' archive byte bound');const end=bytes.length-22;if(bytes.readUInt32LE(end)!==0x06054b50||bytes.readUInt16LE(end+20)!==0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0||bytes.readUInt16LE(end+8)!==wanted.size||bytes.readUInt16LE(end+10)!==wanted.size||bytes.readUInt32LE(end+12)+bytes.readUInt32LE(end+16)!==end)refuse(label+' noncanonical archive directory');
 const entries=listZip(bytes),seen=new Set(),data=new Map();const central=bytes.readUInt32LE(end+16);let lastEnd=0,centralCursor=central;
 for(const e of entries){const expected=wanted.get(e.name);if(!canonicalName(e.name)||!expected||seen.has(e.name)||e.size!==expected.bytes||e.size>PREVIEW_LIMITS.archiveBytes||![0,8].includes(e.method))refuse(label+' unexpected/duplicate/oversize entry');seen.add(e.name);const compressedInCentral=bytes.readUInt32LE(centralCursor+20),centralFlags=bytes.readUInt16LE(centralCursor+8),centralName=bytes.readUInt16LE(centralCursor+28),centralExtra=bytes.readUInt16LE(centralCursor+30),centralComment=bytes.readUInt16LE(centralCursor+32);if(centralFlags!==0x800||centralExtra!==0||centralComment!==0)refuse(label+' unsupported central metadata');centralCursor+=46+centralName+centralExtra+centralComment;const at=e.localOffset;if(at!==lastEnd||at+30>central||bytes.readUInt32LE(at)!==0x04034b50||bytes.readUInt16LE(at+8)!==e.method||bytes.readUInt16LE(at+6)!==0x800||bytes.readUInt32LE(at+14)!==e.crc||bytes.readUInt32LE(at+22)!==e.size)refuse(label+' local header mismatch');const n=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28),start=at+30+n+extra,compressed=bytes.readUInt32LE(at+18);if(extra!==0||compressed!==compressedInCentral||start+compressed>central||bytes.subarray(at+30,at+30+n).toString('utf8')!==e.name)refuse(label+' local name/range mismatch');const raw=bytes.subarray(start,start+compressed),content=e.method===8?inflateRawSync(raw,{maxOutputLength:Math.max(1,e.size)}):raw;if(content.length!==e.size||hash(content)!==expected.sha256||crc32(content)!==e.crc)refuse(label+' entry bytes/SHA/CRC differ');data.set(e.name,content);lastEnd=start+compressed;}
 if(lastEnd!==central||centralCursor!==end)refuse(label+' archive range gap');if(seen.size!==wanted.size)refuse(label+' missing archive entries');return data;
}
export function validateDeveloperPreview({projectRoot,directory,bindingsDir}){
 const plan=sourcePlan(projectRoot);noLinks(directory);const dir=realpathSync(directory),receiptPath=join(dir,'preview-receipt.json');noLinks(receiptPath);if(lstatSync(receiptPath).size>2*1024*1024)refuse('preview receipt byte limit');const receipt=json(receiptPath);
 if(receipt.kind!==PREVIEW_KIND||receipt.v!==1||receipt.developerPreview!==true||receipt.worldIncluded!==false||receipt.releaseApproved!==false||receipt.cleanStarterVerified!==false||receipt.nativeImportVerified!==false||receipt.starterGateOverridden!==false)refuse('preview receipt must explicitly refuse release/world/native claims');
 if(!same(receipt.bindings,plan.bindings)||receipt.sourceFiles!==plan.packs.reduce((n,p)=>n+p.files.length,0)||!Array.isArray(receipt.packs)||receipt.packs.length!==2)refuse('preview pair/binding receipt differs');
 const outputNames=[...OUTPUTS,'preview-receipt.json'].sort();const actual=inventory(dir,outputNames);if(!same(actual.map(x=>x.name),outputNames)||!same(actual.filter(x=>x.name!=='preview-receipt.json'),receipt.outputs))refuse('preview output inventory/SHA differs');
 const nested=new Map();for(let i=0;i<2;i++){const p=plan.packs[i],expected=p.files.map(({data,...f})=>f),saved=receipt.packs[i];if(saved.source!==p.source||saved.kind!==p.kind||saved.archive!==p.archive||!same(saved.header,p.manifest.header)||!same(saved.files,expected))refuse('preview source snapshot is stale');const file=join(dir,'packs',p.archive),bytes=readFileSync(file);checkedArchive(bytes,new Map(expected.map(f=>[f.name,f])),p.source);nested.set(p.archive,{bytes:bytes.length,sha256:hash(bytes)});}
 checkedArchive(readFileSync(join(dir,'developer-preview.mcaddon')),nested,'paired addon');
 for(const [key,value]of Object.entries(plan.bindings))if(!same(json(join(dir,'world-bindings',key+'.json')),value))refuse('binding example differs from paired manifests');
 revalidate(plan);const bindingStatus=bindingCheck(bindingsDir,plan.bindings);
 return{valid:true,kind:PREVIEW_KIND,sourceFiles:receipt.sourceFiles,pairedPacks:2,worldIncluded:false,releaseApproved:false,cleanStarterVerified:false,bindingStatus,receiptSha256:hash(readFileSync(receiptPath)),archiveSha256:hash(readFileSync(join(dir,'developer-preview.mcaddon')))};
}
