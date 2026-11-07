import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const stage=resolve('dev/staging/swordsman-combat-fixture'),bp=join(stage,'BP');
const read=p=>readFileSync(join(bp,p),'utf8'),lines=p=>read(p).split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
const G='@e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"]',Z='@e[type=minecraft:zombie,name="CA_CombatFixture"]',P='@s[type=minecraft:player,m=spectator,x=-145.5,y=82,z=-630.5,r=128]',M='@e[family=mob,x=-200.5,y=69,z=-630.5,r=4]',I='@e[type=!minecraft:player,x=-202,y=68,z=-632,dx=2,dy=4,dz=2]';
const base=`execute in overworld if entity ${P} if entity ${G}`,safety=`${base} unless entity ${Z} unless entity ${M} unless entity ${I}`;
const prepare=lines('functions/ca_combat_fixture/prepare.mcfunction'),body=lines('functions/ca_combat_fixture/internal/prepare_body.mcfunction'),spawn=lines('functions/ca_combat_fixture/spawn_caged.mcfunction');
const cells=[];for(let x=-202;x<=-200;x++)for(let y=68;y<=72;y++)for(let z=-632;z<=-630;z++)cells.push({x,y,z,id:x===-201&&z===-631&&y>=69&&y<=71?'minecraft:air':'minecraft:glass'});
const key=p=>`${p.x},${p.y},${p.z}`;
function model(options={}){const f={guard:{id:'actor142',health:30,position:{x:-90.7,y:66,z:-630.7}},observer:{dimension:options.dimension??'minecraft:overworld',mode:options.mode??'spectator',position:{x:-90.7,y:75,z:-630.7}},blocks:new Map(),mutations:[],zombies:[],settings:{},prepared:false};
 const before=structuredClone(f.guard),allowed=()=>f.observer.dimension==='minecraft:overworld'&&f.observer.mode==='spectator'&&(options.guards??1)>0&&!(options.named??0)&&!(options.nearMobs??0)&&!(options.insideEntity??0)&&(!options.operatorPrecheck||(options.guards??1)===1);
 f.prepare=()=>{if(!allowed())return false;assert.deepEqual(prepare,[safety+' run function ca_combat_fixture/internal/prepare_body']);
  for(const c of body){if(c==='difficulty normal'){f.settings.difficulty='normal';continue;}if(c==='gamerule doMobSpawning false'){f.settings.spawning=false;continue;}if(c==='gamerule doDaylightCycle false'){f.settings.daylight=false;continue;}if(c==='time set 229000'){f.settings.time=229000;continue;}
   if(c==='fill -202 68 -632 -200 72 -630 minecraft:glass'){for(const p of cells)f.blocks.set(key(p),'minecraft:glass');f.mutations.push({kind:'fill',cells:45});continue;}
   if(c==='fill -201 69 -631 -201 71 -631 minecraft:air'){for(const p of cells.filter(p=>p.id==='minecraft:air'))f.blocks.set(key(p),'minecraft:air');f.mutations.push({kind:'air',cells:3});continue;}
   if(c==='tp @s -145.5 82 -630.5'){f.observer.position={x:-145.5,y:82,z:-630.5};f.mutations.push({kind:'observerTP'});continue;}
   assert.equal(c,`execute at ${G} run camera @s set minecraft:free pos ~ ~5 ~5 facing ${G}`);f.mutations.push({kind:'observerCamera'});
  }assert.deepEqual(f.guard,before);f.prepared=true;return true;};
 f.spawn=()=>{if(!allowed()||f.zombies.length||cells.some(p=>f.blocks.get(key(p))!==p.id))return false;
  f.zombies.push({type:'minecraft:zombie',name:'CA_CombatFixture',adult:true,health:20,position:{x:-200.5,y:69,z:-630.5}});f.mutations.push({kind:'summon'});assert.deepEqual(f.guard,before);return true;};return f;}
test('v3 packs only approved modules/functions and retains UUID/dependencies with version0.0.3',()=>{
 const m=JSON.parse(read('manifest.json'));assert.deepEqual(m.header.version,[0,0,3]);assert.deepEqual(m.modules.map(m=>m.type),['data','script']);assert.ok(m.modules.every(m=>JSON.stringify(m.version)==='[0,0,3]'));assert.deepEqual(readdirSync(bp).sort(),['functions','manifest.json','scripts']);assert.ok(m.dependencies.some(d=>d.uuid==='fd04cb50-dddc-4ebe-83fc-5b5375819bcb'));assert.ok(m.dependencies.some(d=>d.module_name==='@minecraft/server'&&d.version==='2.7.0'));
});
test('prepare is bounded45cells with exactly42glass/3air, observer-onlyTP/camera and no guard/effect/health changes',()=>{
 const f=model();assert.equal(f.prepare(),true);assert.equal(f.blocks.size,45);assert.equal([...f.blocks.values()].filter(v=>v==='minecraft:glass').length,42);assert.equal([...f.blocks.values()].filter(v=>v==='minecraft:air').length,3);for(const p of cells)assert.equal(f.blocks.get(key(p)),p.id);
 assert.deepEqual(f.observer.position,{x:-145.5,y:82,z:-630.5});assert.equal(f.guard.health,30);assert.deepEqual(f.settings,{difficulty:'normal',spawning:false,daylight:false,time:229000});assert.equal(body.filter(c=>c.startsWith('fill ')).length,2);assert.equal(body.length,8);
});
test('nonOverworld/nonSpectator/missingguard/namedmob/nearbyanimal/insideentity all refuse before ANY fill/settings/actor write',()=>{
 for(const o of [{dimension:'minecraft:nether'},{mode:'survival'},{guards:0},{named:1},{nearMobs:1},{insideEntity:1},{guards:2,operatorPrecheck:true}]){const f=model(o);assert.equal(f.prepare(),false);assert.equal(f.spawn(),false);assert.equal(f.blocks.size,0);assert.deepEqual(f.settings,{});assert.equal(f.mutations.length,0);}
});
test('spawn_caged requires all45currentexpectedblocks and then summons exactlyone fixed adult; replay refuses',()=>{
 const expected=safety+' '+cells.map(p=>`if block ${p.x} ${p.y} ${p.z} ${p.id}`).join(' ')+' run summon minecraft:zombie -200.5 69 -630.5 0 0 minecraft:as_adult CA_CombatFixture';assert.deepEqual(spawn,[expected]);
 assert.equal(cells.filter(p=>p.id==='minecraft:glass').length,42);assert.equal(cells.filter(p=>p.id==='minecraft:air').length,3);
 const f=model();assert.equal(f.spawn(),false);f.prepare();assert.equal(f.spawn(),true);assert.equal(f.zombies.length,1);assert.deepEqual(f.zombies[0].position,{x:-200.5,y:69,z:-630.5});assert.equal(f.spawn(),false);assert.equal(f.zombies.length,1);
});
test('every missing/wrong shell or air cell independently vetoes spawning',()=>{
 for(const p of cells){const f=model();f.prepare();f.blocks.set(key(p),p.id==='minecraft:air'?'minecraft:stone':'minecraft:air');const before=f.mutations.length;assert.equal(f.spawn(),false,key(p));assert.equal(f.zombies.length,0);assert.equal(f.mutations.length,before);}
});
test('unsafe free-spawn body is absent and old public name delegates only to caged wrapper',()=>{
 assert.equal(existsSync(join(bp,'functions/ca_combat_fixture/internal/spawn_body.mcfunction')),false);assert.deepEqual(lines('functions/ca_combat_fixture/spawn.mcfunction'),['function ca_combat_fixture/spawn_caged']);assert.equal(spawn[0].includes('~40'),false);assert.equal(spawn.filter(s=>s.includes('run summon')).length,1);
});
test('unchanged engage stillclears6thenTPonlynamedzombie; clear-only has no spawn/TP',()=>{
 const engage=lines('functions/ca_combat_fixture/internal/engage_body.mcfunction'),clear=lines('functions/ca_combat_fixture/internal/clear_gear_body.mcfunction');assert.deepEqual(clear,engage.slice(0,6));assert.equal(clear.length,6);assert.ok(clear.every(c=>c.startsWith('replaceitem entity '+Z)));assert.equal(engage.at(-1),`execute at ${G} run tp ${Z} ~ ~ ~1`);
});
test('camera shortcuts only address Spectator observer, preserving loaded midpoint location',()=>{
 assert.deepEqual(lines('functions/ca_combat_fixture/view_cage.mcfunction'),[`${base} run camera @s set minecraft:free pos -200.5 70.5 -626.5 facing -200.5 70 -630.5`]);assert.deepEqual(lines('functions/ca_combat_fixture/view_guard.mcfunction'),[`${base} at ${G} run camera @s set minecraft:free pos ~ ~5 ~5 facing ${G}`]);
 const observer={x:-145.5,y:82,z:-630.5},zombie={x:-200.5,y:69,z:-630.5},guard={x:-90.7,y:66,z:-630.7};for(const p of [zombie,guard])assert.ok(Math.hypot(p.x-observer.x,p.y-observer.y,p.z-observer.z)<64);
});
test('A5/B5 are NEWclosedbaselinecopies with all6DBfiles identical and onlyBpathoverride difference',()=>{
 const r=JSON.parse(readFileSync(join(stage,'worlds-v003-receipt.json'),'utf8'));assert.equal(r.baselineLevelSha256,'7B0E743374390D57A63134CDE2997EBB9D4E8EC2DDE6555C8E5BF404FCB2F412');assert.equal(r.worlds.length,2);
 const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();const a=r.worlds.find(w=>w.arm==='A'),b=r.worlds.find(w=>w.arm==='B');assert.deepEqual(b.behaviorBindings.slice(1),a.behaviorBindings);
 for(const w of r.worlds){assert.match(w.worldFolder,/Path[AB]5_Nov6$/);assert.equal(w.allFilesCopiedAndVerified,13);assert.deepEqual(w.changedFiles.sort(),['level.dat','levelname.txt','world_behavior_packs.json']);const fixture=w.behaviorBindings.find(p=>p.pack_id==='fddde689-c92c-43bd-a68a-3cda9f5203d6');assert.deepEqual(fixture.version,[0,0,3]);for(const[p,sha]of Object.entries(w.hashes)){assert.equal(hash(resolve(w.stagedDirectory,p)),sha);if(p.startsWith('db/'))assert.equal(sha,r.baselineHashes[p]);}assert.equal(Object.keys(w.hashes).filter(p=>p.startsWith('db/')).length,6);}
});
