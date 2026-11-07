import {cpSync,existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readLevelDat} from '../../lib/nbt.mjs';

// Offline fixture preparation only: never inspect or overwrite a live city.
const validation=JSON.parse(readFileSync('dist/native-d5-hold-source-validation-20261106.json','utf8'));
const source=validation.source;
const destination='C:/Users/zhaoF/AppData/Roaming/Minecraft Bedrock/Users/16044254735791270272/games/com.mojang/minecraftWorlds/CA_D5_Hold_Nov6';
const name='CA D5 Hold Nov6';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
function hashes(dir){return Object.fromEntries(files(dir).map(p=>[relative(dir,p),sha(readFileSync(p))]));}
const before=hashes(source);
assert.deepEqual(before,validation.fileHashes);
assert.equal(validation.all15FilesMatchReceiptAndOriginalBackup,true);
assert.equal(validation.districts.length,4);
assert.equal(validation.district5.civAbsent,true);
assert.equal(validation.district5.savedD5SiteAndJobKeysAbsent,true);
assert.equal(existsSync(destination),false,`Refusing existing ${destination}`);

// Replace the single raw LevelName string and adjust payload length only.
const bytes=readFileSync(join(source,'level.dat')),old=readLevelDat(bytes);
const key=Buffer.concat([Buffer.from([8,9,0]),Buffer.from('LevelName')]);
const start=bytes.indexOf(key);assert.ok(start>=8);assert.equal(bytes.indexOf(key,start+1),-1);
const at=start+key.length,len=bytes.readUInt16LE(at),prior=bytes.subarray(at+2,at+2+len).toString('utf8');
assert.equal(prior,old.data.LevelName);
const value=Buffer.from(name),length=Buffer.alloc(2);length.writeUInt16LE(value.length);
const next=Buffer.concat([bytes.subarray(0,at),length,value,bytes.subarray(at+2+len)]);
next.writeInt32LE(bytes.readInt32LE(4)+value.length-len,4);
const parsed=readLevelDat(next);assert.equal(parsed.data.LevelName,name);
parsed.data.LevelName=prior;assert.deepEqual(parsed,old);
assert.deepEqual(next.subarray(8,at),bytes.subarray(8,at));
assert.deepEqual(next.subarray(at+2+value.length),bytes.subarray(at+2+len));

cpSync(source,destination,{recursive:true,errorOnExist:true,force:false});
assert.deepEqual(hashes(destination),before);
writeFileSync(join(destination,'level.dat'),next);
writeFileSync(join(destination,'levelname.txt'),name);
const after=hashes(destination),changed=Object.keys(before).filter(p=>before[p]!==after[p]);
assert.deepEqual(changed.sort(),['level.dat','levelname.txt']);
assert.equal(Object.keys(after).length,15);
assert.deepEqual(hashes(source),before,'Source changed during preparation');
const bp=JSON.parse(readFileSync(join(destination,'world_behavior_packs.json'),'utf8'));
const rp=JSON.parse(readFileSync(join(destination,'world_resource_packs.json'),'utf8'));
assert.deepEqual(bp,[{pack_id:'fd04cb50-dddc-4ebe-83fc-5b5375819bcb',version:[1,0,0]}]);
assert.deepEqual(rp,[{pack_id:'e634c636-7b98-49f7-81cd-13483bfa3f9f',version:[1,0,0]}]);
const receipt={status:'Prepared only; not opened in Minecraft',source,destination,name,
 sourceValidationReceipt:'dist/native-d5-hold-source-validation-20261106.json',
 sourceValidation:validation,copiedAndVerifiedFiles:15,sourceUnchanged:true,
 changedFiles:changed,semanticNbtDifferenceOnly:'LevelName',rawNbtOtherPayloadBytesIdentical:true,
 sourceLevelDatSha256:before['level.dat'],newLevelDatSha256:after['level.dat'],
 behaviorBindings:bp,resourceBindings:rp,finalFileHashes:after,
 nextNativeGate:'Confirm D1-D4 complete, D5 unbuilt, no pending jobs, original packs active before any D5 generation. Test hold behavior without observer relocation to mask failures.',
 actionsNotTaken:['Open world','Minecraft UI input','Read current city database','Generate district','Active pack edits']};
writeFileSync('dist/native-d5-hold-catalog-receipt-20261106.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({destination,name,files:15,changed,newLevelDatSha256:receipt.newLevelDatSha256,sourceUnchanged:true},null,2));
