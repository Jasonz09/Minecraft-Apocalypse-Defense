import test from 'node:test';
import assert from 'node:assert/strict';
import{readFileSync,readdirSync}from'node:fs';
const bp=new URL('./BP/',import.meta.url),read=p=>readFileSync(new URL(p,bp),'utf8'),lines=p=>read(p).split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
const base='functions/ca_combat_fixture/',G='@e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"]',P='@s[type=minecraft:player,m=spectator,x=-145.5,y=82,z=-630.5,r=128]';
const named='@e[name="CA_CombatFixture"]',tagName='@e[name="CA_CombatFixture",tag="civbesiege:v1"]';
const walk=(url,prefix='')=>readdirSync(url,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(new URL(d.name+'/',url),prefix+d.name+'/'):[prefix+d.name]);
test('exact27-file native pack inventory, fixed manifests, no entity override or second population module',()=>{
 const expected=['manifest.json','scripts/main.js','scripts/fixtureInspection.js',...['clear_gear','engage','prepare','spawn_caged','spawn','view_cage','view_guard'].map(n=>base+n+'.mcfunction'),...['clear_gear_body','engage_body','prepare_body'].map(n=>base+'internal/'+n+'.mcfunction')];
 for(const p of ['pillager','vindicator'])expected.push(...['spawn_caged','clear_gear','engage','return'].map(n=>base+p+'/'+n+'.mcfunction'),...['clear_gear_body','engage_body','return_body'].map(n=>base+p+'/internal/'+n+'.mcfunction'));
 assert.deepEqual(walk(bp).sort(),expected.sort());assert.equal(expected.length,27);const m=JSON.parse(read('manifest.json'));assert.deepEqual(m.header.version,[0,0,4]);assert.equal(m.header.uuid,'fddde689-c92c-43bd-a68a-3cda9f5203d6');assert.ok(m.modules.every(x=>JSON.stringify(x.version)==='[0,0,4]'));assert.deepEqual(m.modules.map(x=>x.type),['data','script']);assert.equal(m.dependencies.find(x=>x.uuid)?.uuid,'fd04cb50-dddc-4ebe-83fc-5b5375819bcb');assert.equal(m.dependencies.find(x=>x.module_name)?.version,'2.7.0');
});
test('shared prepare blocks loaded names across ALL profiles, same42glass/3air and observer-only geometry',()=>{
 assert.ok(lines(base+'prepare.mcfunction')[0].includes('unless entity '+named));const body=lines(base+'internal/prepare_body.mcfunction');assert.deepEqual(body.slice(0,6),['difficulty normal','gamerule doMobSpawning false','gamerule doDaylightCycle false','time set 229000','fill -202 68 -632 -200 72 -630 minecraft:glass','fill -201 69 -631 -201 71 -631 minecraft:air']);assert.equal(body.length,8);assert.ok(body[6].startsWith('tp @s '));assert.ok(body[7].includes('camera @s '));
});
for(const profile of ['pillager','vindicator']){
 const target=`@e[type=minecraft:${profile},name="CA_CombatFixture"]`,tagged=target.slice(0,-1)+',tag="civbesiege:v1"]',root=base+profile+'/',call='ca_combat_fixture/'+profile+'/';
 test(profile+' spawn reuses all45 exact cell checks, refuses occupied cage and any loaded named profile, no siege tag',()=>{
  const l=lines(root+'spawn_caged.mcfunction');assert.equal(l.length,1);assert.ok(l[0].startsWith(`execute in overworld if entity ${P} if entity ${G} unless entity ${named} unless entity @e[family=mob`));assert.ok(l[0].includes('unless entity @e[type=!minecraft:player,x=-202,y=68,z=-632,dx=2,dy=4,dz=2]'));
  const matches=[...l[0].matchAll(/if block (-?\d+) (-?\d+) (-?\d+) (minecraft:\w+)/g)];assert.equal(matches.length,45);const observed=new Map(matches.map(m=>[m.slice(1,4).join(','),m[4]]));assert.equal(observed.size,45);for(let x=-202;x<=-200;x++)for(let y=68;y<=72;y++)for(let z=-632;z<=-630;z++)assert.equal(observed.get(`${x},${y},${z}`),x===-201&&z===-631&&y>=69&&y<=71?'minecraft:air':'minecraft:glass');assert.ok(l[0].endsWith(`run summon minecraft:${profile} -200.5 69 -630.5 0 0 minecraft:entity_spawned CA_CombatFixture`));assert.equal(l[0].includes('civbesiege'),false);
 });
 test(profile+' six clears happen before tag; target-only TP requires tag success; no district tags or guard writes',()=>{
  const clear=lines(root+'internal/clear_gear_body.mcfunction'),engage=lines(root+'internal/engage_body.mcfunction');assert.equal(clear.length,6);assert.deepEqual(clear.map(l=>l.split(' ')[3]),['slot.armor.head','slot.armor.chest','slot.armor.legs','slot.armor.feet','slot.weapon.mainhand','slot.weapon.offhand']);assert.ok(clear.every(l=>l.startsWith('replaceitem entity '+target)&&l.endsWith(' 0 minecraft:air')));assert.deepEqual(engage.slice(0,6),clear);assert.deepEqual(engage.slice(6),[`tag ${target} add civbesiege:v1`,`execute if entity ${tagged} at ${G} run tp ${tagged} ~ ~ ~1`]);
  for(const name of ['clear_gear','engage']){const command=lines(root+name+'.mcfunction');assert.deepEqual(command,[`execute in overworld if entity ${P} if entity ${G} if entity ${target} unless entity ${tagName} run function ${call}internal/${name==='engage'?'engage_body':'clear_gear_body'}`]);}
 });
 test(profile+' aftermath removes namespace before target-only return; failed removal cannot teleport; current empty intact cage required',()=>{
  const r=lines(root+'return.mcfunction')[0];assert.ok(r.startsWith(`execute in overworld if entity ${P} if entity ${target} unless entity @e[type=!minecraft:player,x=-202,y=68,z=-632,dx=2,dy=4,dz=2]`));assert.equal((r.match(/if block /g)||[]).length,45);assert.ok(r.endsWith('run function '+call+'internal/return_body'));assert.deepEqual(lines(root+'internal/return_body.mcfunction'),[`tag ${target} remove civbesiege:v1`,`execute unless entity ${tagName} run tp ${target} -200.5 69 -630.5`]);assert.equal(r.includes(G),false,'cleanup can return surviving target after guard death');
 });
}
test('real production namespace parser classifies fixture as orphan, never a district-adoptable attacker',()=>{
 const source=readFileSync(new URL('../../../CivilizationApocalypse_BP/scripts/integration/siegeMobs.js',import.meta.url),'utf8'),start=source.indexOf('export function districtOfTags('),end=source.indexOf('\n}',start)+2,fn=source.slice(start,end).replace('export ','');const classify=Function('SIEGE_TAG','SIEGE_TAG_PREFIX',fn+';return districtOfTags;')('civbesiege:v1','civbesiege:v1:');assert.equal(classify([]),null);assert.equal(classify(['civbesiege:v1']),'');assert.equal(classify(['civbesiege:v1','civbesiege:v1:district-1']),'district-1');assert.match(source,/dimension\.getEntities\(\{ tags: \[SIEGE_TAG\] \}\)/);assert.ok(source.includes('no district on its tag'));assert.ok(source.includes('its district record has gone'));
 for(const f of walk(bp).filter(p=>p.endsWith('.mcfunction'))){const code=lines(f).join('\n');assert.doesNotMatch(code,/civbesiege:v1:/);assert.doesNotMatch(code,/summon civ_trial:|(?:tp|teleport) @e\[type=civ_trial:|effect |event entity |damage |scoreboard |tickingarea |scriptevent civ:/);assert.doesNotMatch(code,/c=1/);}
});
test('all native function references resolve within exact reviewed pack, and no auto tick/load function exists',()=>{
 for(const p of walk(bp).filter(p=>p.endsWith('.mcfunction')))for(const m of read(p).matchAll(/run function ([a-z0-9_/]+)/g))assert.ok(walk(bp).includes('functions/'+m[1]+'.mcfunction'),m[1]);assert.equal(walk(bp).some(p=>p.endsWith('.json')&&p!=='manifest.json'),false);
});
