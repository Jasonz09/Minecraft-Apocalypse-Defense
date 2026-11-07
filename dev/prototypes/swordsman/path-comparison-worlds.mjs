import {cpSync,existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readLevelDat} from '../../lib/nbt.mjs';

// Closed-world fixture preparation only. Never overwrite an existing catalog entry.
const baseline='E:/CivilizationApocalypse/dist/backups/swordsman-sol1-peaceful-appearance-baseline-20261106';
const catalog='C:/Users/zhaoF/AppData/Roaming/Minecraft Bedrock/Users/16044254735791270272/games/com.mojang/minecraftWorlds';
const round=process.argv[2]??'';
assert.ok(round===''||/^[2-9]$/.test(round),'Optional round must be 2-9');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
function renameLevel(bytes,name){
  const old=readLevelDat(bytes),key=Buffer.concat([Buffer.from([8,9,0]),Buffer.from('LevelName')]);
  const start=bytes.indexOf(key);assert.ok(start>=8);assert.equal(bytes.indexOf(key,start+1),-1);
  const at=start+key.length,len=bytes.readUInt16LE(at),prior=bytes.subarray(at+2,at+2+len).toString('utf8');
  assert.equal(prior,old.data.LevelName);
  const value=Buffer.from(name),length=Buffer.alloc(2);length.writeUInt16LE(value.length);
  const next=Buffer.concat([bytes.subarray(0,at),length,value,bytes.subarray(at+2+len)]);
  next.writeInt32LE(bytes.readInt32LE(4)+value.length-len,4);
  const parsed=readLevelDat(next);assert.equal(parsed.data.LevelName,name);
  parsed.data.LevelName=prior;assert.deepEqual(parsed,old);return next;
}
const baselineFiles=files(baseline),baselineLevel=readFileSync(join(baseline,'level.dat'));
assert.equal(sha(baselineLevel),'7B0E743374390D57A63134CDE2997EBB9D4E8EC2DDE6555C8E5BF404FCB2F412');
const receipt={baseline,baselineLevelSha256:sha(baselineLevel),worlds:[]};
for(const arm of ['A','B']){
  const destination=join(catalog,`CA_Sol1_Path${arm}${round}_Nov6`),name=`CA Sol1 Path ${arm}${round} Nov6`;
  assert.equal(existsSync(destination),false,`Refusing existing ${destination}`);
  cpSync(baseline,destination,{recursive:true,errorOnExist:true});
  for(const file of baselineFiles)assert.equal(sha(readFileSync(join(destination,relative(baseline,file)))),sha(readFileSync(file)));
  writeFileSync(join(destination,'level.dat'),renameLevel(baselineLevel,name));
  writeFileSync(join(destination,'levelname.txt'),name);
  if(arm==='B'){
    const bindingFile=join(destination,'world_behavior_packs.json'),bindings=JSON.parse(readFileSync(bindingFile,'utf8'));
    assert.equal(bindings.length,1);assert.equal(bindings[0].pack_id,'fd04cb50-dddc-4ebe-83fc-5b5375819bcb');
    bindings.unshift({pack_id:'c8644dda-e2b4-46cc-b2cb-5b72f5d972c9',version:[0,0,1]});
    writeFileSync(bindingFile,JSON.stringify(bindings,null,2)+'\n');
  }
  const allowed=new Set(['level.dat','levelname.txt',...(arm==='B'?['world_behavior_packs.json']:[])]);
  for(const file of baselineFiles){const name=relative(baseline,file);if(!allowed.has(name))assert.equal(sha(readFileSync(join(destination,name))),sha(readFileSync(file)));}
  receipt.worlds.push({arm,name,destination,copiedAndVerifiedFiles:baselineFiles.length,levelSha256:sha(readFileSync(join(destination,'level.dat'))),changedFiles:[...allowed],behaviorBindings:JSON.parse(readFileSync(join(destination,'world_behavior_packs.json'),'utf8'))});
}
writeFileSync(`dist/swordsman-path-comparison-worlds${round?`-round${round}`:''}-20261106.json`,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
