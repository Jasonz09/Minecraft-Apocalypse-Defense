import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {inspectNamedFixture,formatFixtureSnapshot,handleFixtureInspection,registerFixtureInspection} from './BP/scripts/fixtureInspection.js';
const labels=['head','chest','legs','feet','mainhand','offhand'],slotNames=['Head','Chest','Legs','Feet','Mainhand','Offhand'];
function fixture(options={}){
 const stats={queries:[],slots:[],components:[],writes:0,messages:[]},state={health:options.health??20,max:options.max??20,position:{x:40,y:68,z:0},id:'zombie-id-1'};
 const denied=()=>{stats.writes++;throw Error('MUTATION FORBIDDEN');};
 const health={isValid:true,get currentValue(){if(options.healthThrows)throw Error('current unreadable');return state.health;},get effectiveMax(){if(options.maxThrows)throw Error('max unreadable');return state.max;}};
 const equipment={isValid:true,getEquipment(slot){stats.slots.push(slot);if(options.slotThrows===slot)throw Error('slot unreadable');options.onSlot?.(slot,state);return options.items?.[slot];},setEquipment:denied};
 const dimension={id:options.dimension??'minecraft:overworld',getEntities(query){stats.queries.push(structuredClone(query));if(options.queryThrows===stats.queries.length)throw Error('query failed');if(options.lastReplacement&&stats.queries.length===2)return[{...actor,id:'replacement'}];return Array.from({length:options.count??1},(_,i)=>i?{...actor,id:'duplicate'+i}:actor).slice(0,query.closest);},spawnEntity:denied,runCommand:denied};
 const target={isValid:true,typeId:options.type??'minecraft:zombie',nameTag:'CA_CombatFixture',dimension,get id(){return state.id;},get location(){return{...state.position};},
  getComponent(id){stats.components.push(id);if(id==='minecraft:health')return options.noHealth?undefined:health;if(id==='minecraft:equippable'){if(options.componentThrows)throw Error('component read failed');return options.noEquipment?undefined:equipment;}throw Error('unreviewed component');},teleport:denied,applyDamage:denied,triggerEvent:denied,addEffect:denied,setDynamicProperty:denied};
 const actor=new Proxy(target,{set(){denied();return false;}});
 const player={isValid:true,typeId:options.playerType??'minecraft:player',dimension,location:{x:0,y:68,z:0},sendMessage(lines){stats.messages.push(...(Array.isArray(lines)?lines:[lines]));stats.lastMessageWasString=typeof lines==='string';},setDynamicProperty:denied,teleport:denied};
 const event={id:'ca_fixture:inspect',message:'',sourceType:'Entity',sourceEntity:player};
 return{stats,state,actor,player,event,health,equipment,inspect(){const result=inspectNamedFixture(player,options.profile);assert.equal(stats.writes,0);return result;}};
}
test('complete healthy empty snapshot uses exactly2 capped queries and6 readonly slot reads',()=>{
 const f=fixture(),s=f.inspect();assert.equal(s.status,'verified');assert.equal(s.ready,true);assert.equal(s.id,'zombie-id-1');assert.deepEqual(s.position,{x:40,y:68,z:0});assert.deepEqual(s.health,{readable:true,currentReadable:true,maxReadable:true,stable:true,current:20,max:20});assert.equal(f.stats.queries.length,2);assert.deepEqual(f.stats.slots,slotNames);
 for(const q of f.stats.queries){assert.deepEqual(q,{name:'CA_CombatFixture',location:{x:0,y:68,z:0},maxDistance:64,closest:2});}for(const label of labels)assert.equal(s.slots[label].state,'empty');assert.match(formatFixtureSnapshot(s).join('\n'),/full measured HP and six slots empty NOW/);
});
test('unavailable equippable preserves readable20health and reports all6slotsUNKNOWN, never empty',()=>{
 const f=fixture({noEquipment:true}),s=f.inspect();assert.equal(s.status,'unverified');assert.equal(s.ready,false);assert.equal(s.health.current,20);assert.equal(s.health.max,20);assert.equal(s.health.readable,true);assert.equal(s.health.stable,true);assert.equal(f.stats.slots.length,0);for(const label of labels)assert.equal(s.slots[label].state,'unknown');const text=formatFixtureSnapshot(s).join('\n');assert.match(text,/Health READABLE 20\/20/);assert.equal((text.match(/UNKNOWN/g)??[]).length>=6,true);assert.match(text,/equippable component UNAVAILABLE/);
});
test('each one-slot failure leaves the other5readings and health independent',()=>{
 for(let i=0;i<6;i++){const f=fixture({slotThrows:slotNames[i]}),s=f.inspect();assert.equal(s.ready,false);assert.equal(s.status,'unverified');assert.equal(s.slots[labels[i]].state,'unknown');for(const other of labels.filter(l=>l!==labels[i]))assert.equal(s.slots[other].state,'empty');assert.equal(s.health.current,20);assert.equal(s.health.stable,true);assert.equal(f.stats.slots.length,6);}
});
test('current/max read failures are independent and do not erase available gear or the other health field',()=>{
 const a=fixture({healthThrows:true}).inspect();assert.equal(a.health.currentReadable,false);assert.equal(a.health.maxReadable,true);assert.equal(a.health.max,20);assert.equal(a.ready,false);
 const b=fixture({maxThrows:true}).inspect();assert.equal(b.health.currentReadable,true);assert.equal(b.health.current,20);assert.equal(b.health.maxReadable,false);assert.equal(b.ready,false);assert.match(formatFixtureSnapshot(b).join('\n'),/current=20, max=UNKNOWN/);for(const s of [a,b])for(const l of labels)assert.equal(s.slots[l].state,'empty');
});
test('missing health differs from missing entity; equipped or injured snapshots are known but not ready',()=>{
 const missing=fixture({noHealth:true}).inspect();assert.equal(missing.unique,true);assert.equal(missing.id,'zombie-id-1');assert.equal(missing.health.readable,false);assert.match(missing.reasons.join(' '),/health component/);for(const l of labels)assert.equal(missing.slots[l].state,'empty');
 const armed=fixture({items:{Head:{typeId:'minecraft:chainmail_helmet',amount:1}}}).inspect();assert.equal(armed.status,'verified');assert.equal(armed.ready,false);assert.deepEqual(armed.slots.head,{state:'item',typeId:'minecraft:chainmail_helmet',amount:1});
 const f=fixture();f.state.health=19;const injured=f.inspect();assert.equal(injured.status,'verified');assert.equal(injured.ready,false);assert.equal(injured.health.current,19);
});
test('zero/duplicate/query failures refuse boundedly before component reads',()=>{
 for(const options of [{count:0},{count:2},{count:5000},{queryThrows:1}]){const f=fixture(options),s=f.inspect();assert.equal(s.ready,false);assert.equal(s.unique,false);assert.equal(f.stats.components.length,0);assert.equal(f.stats.queries.length,1);}
});
test('nonmatching event performs no context reads or queries; invalid context/arguments never queries',()=>{
 assert.equal(handleFixtureInspection(new Proxy({},{get(_t,k){if(k==='id')return'other:event';throw Error('unrelated event context touched');}})),undefined);
 for(const options of [{dimension:'minecraft:nether'},{playerType:'minecraft:zombie'}]){const f=fixture(options);assert.equal(f.inspect().ready,false);assert.equal(f.stats.queries.length,0);}
 for(const change of [{sourceType:'Server'},{message:'unexpected'}]){const f=fixture();handleFixtureInspection({...f.event,...change});assert.equal(f.stats.queries.length,0);assert.equal(f.stats.writes,0);}
});
test('late census change/failure and health drift preserve readable fields but cannot produce readiness',()=>{
 for(const options of [{lastReplacement:true},{queryThrows:2},{onSlot(slot,state){if(slot==='Offhand')state.health=19;}}]){const f=fixture(options),s=f.inspect();assert.equal(s.ready,false);assert.equal(s.status,'unverified');assert.equal(s.health.current,20);assert.equal(f.stats.queries.length,2);}
});
test('null item/invalid amount is UNKNOWN, and absent ID or out-of-scope position never passes',()=>{
 for(const item of [null,{typeId:'minecraft:helmet',amount:0},{typeId:'bad identifier',amount:1}]){const s=fixture({items:{Head:item}}).inspect();assert.equal(s.slots.head.state,'unknown');assert.equal(s.ready,false);}
 const a=fixture();a.state.id=undefined;assert.equal(a.inspect().unique,false);assert.equal(a.stats.slots.length,0);const b=fixture();b.state.position.x=65;assert.equal(b.inspect().ready,false);assert.equal(b.stats.slots.length,0);
});
test('thrown equippable access reports readable health separately and event replies only to its player',()=>{
 const f=fixture({componentThrows:true}),s=handleFixtureInspection(f.event);assert.equal(s.ready,false);assert.equal(s.health.current,20);assert.match(f.stats.messages.join('\n'),/Health READABLE 20\/20/);assert.match(f.stats.messages.join('\n'),/UNVERIFIED/);assert.equal(f.stats.lastMessageWasString,true);assert.ok(f.stats.messages[0].includes('\n'));assert.equal(f.stats.writes,0);
});
test('entry registers once with one namespace subscription and no startup query/timer',async()=>{
 let subscribed=0,callback;const system={afterEvents:{scriptEventReceive:{subscribe(fn,options){subscribed++;callback=fn;assert.deepEqual(options,{namespaces:['ca_fixture']});}}}};globalThis.__caFixtureSystem=system;
 const entry=readFileSync(new URL('./BP/scripts/main.js',import.meta.url),'utf8').replace('"@minecraft/server"',JSON.stringify('data:text/javascript,export const system=globalThis.__caFixtureSystem;')).replace('"./fixtureInspection.js"',JSON.stringify(new URL('./BP/scripts/fixtureInspection.js',import.meta.url).href));
 await import('data:text/javascript;base64,'+Buffer.from(entry).toString('base64'));assert.equal(subscribed,1);assert.equal(registerFixtureInspection(system),false);assert.equal(subscribed,1);const f=fixture();assert.equal(f.stats.queries.length,0);callback(f.event);assert.equal(f.stats.queries.length,2);assert.equal(f.stats.writes,0);delete globalThis.__caFixtureSystem;
});
test('script AST has no actor/property/command/equipment mutations, timers or owner imports',()=>{
 const forbidden=new Set(['spawnEntity','spawnItem','teleport','tryTeleport','applyDamage','kill','remove','triggerEvent','addEffect','removeEffect','setEquipment','setCurrentValue','resetToMaxValue','resetToDefaultValue','setDynamicProperty','setDynamicProperties','clearDynamicProperties','runCommand','runCommandAsync','run','runTimeout','runInterval','runJob','setTimeout','setInterval']);
 for(const name of ['fixtureInspection.js','main.js']){const raw=readFileSync(new URL('./BP/scripts/'+name,import.meta.url),'utf8'),ast=ts.createSourceFile(name,raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let subscriptions=0;
  const visit=n=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)){assert.equal(forbidden.has(n.expression.name.text),false,n.expression.name.text);if(n.expression.name.text==='subscribe')subscriptions++;}if(ts.isImportDeclaration(n))assert.ok(['@minecraft/server','./fixtureInspection.js'].includes(n.moduleSpecifier.text));ts.forEachChild(n,visit);};visit(ast);assert.equal(subscriptions,name==='fixtureInspection.js'?1:0);
 }
});

for(const profile of ['pillager','vindicator'])test(profile+' actual measured max and full health remain independent of gear support',()=>{
 const f=fixture({profile,type:'minecraft:'+profile,health:31,max:31}),snap=f.inspect();assert.equal(snap.health.current,31);assert.equal(snap.health.max,31);assert.equal(snap.ready,true);assert.equal(snap.profile,profile);assert.equal(f.stats.queries.length,2);
 const g=fixture({profile,type:'minecraft:'+profile,health:24,max:24,noEquipment:true}),unknown=g.inspect();assert.equal(unknown.health.readable,true);assert.equal(unknown.health.stable,true);assert.equal(unknown.ready,false);assert.ok(Object.values(unknown.slots).every(s=>s.state==='unknown'));
 const h=fixture({profile,type:'minecraft:'+profile,health:23,max:24});assert.equal(h.inspect().ready,false);
});
test('fixed profiles cannot accept wrong type or hide a cross-profile named duplicate',()=>{
 const f=fixture({profile:'pillager',type:'minecraft:vindicator'});assert.equal(f.inspect().ready,false);assert.equal(f.stats.components.length,0);
 const g=fixture({profile:'pillager',type:'minecraft:pillager',count:2});assert.equal(g.inspect().unique,false);assert.equal(g.stats.components.length,0);assert.equal('type' in g.stats.queries[0],false);
 const h=fixture({profile:'__proto__'});assert.equal(h.inspect().ready,false);assert.equal(h.stats.queries.length,0);
});
