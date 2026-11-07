/** Explicit-command, read-only fixture inspection. No ownership or scheduling.
 * @typedef {import("@minecraft/server").Entity} Entity
 * @typedef {import("@minecraft/server").Player} Player
 * @typedef {import("@minecraft/server").Vector3} Point
 * @typedef {{state:"unknown"|"empty"|"item",typeId?:string,amount?:number}} SlotReading
 * @typedef {{status:"unverified"|"verified",ready:boolean,reasons:string[],id?:string,position?:Point,health:{readable:boolean,currentReadable:boolean,maxReadable:boolean,stable:boolean,current?:number,max?:number},slots:Record<string,SlotReading>,unique:boolean,profile:string}} FixtureSnapshot
 */
export const FIXTURE_NAME="CA_CombatFixture",FIXTURE_INSPECT_EVENT="ca_fixture:inspect",FIXTURE_RADIUS=64;
export const FIXTURE_PROFILES=Object.freeze({zombie:"minecraft:zombie",pillager:"minecraft:pillager",vindicator:"minecraft:vindicator"});
const SLOTS=Object.freeze([
 {label:"head",slot:/** @type {import("@minecraft/server").EquipmentSlot} */("Head")},
 {label:"chest",slot:/** @type {import("@minecraft/server").EquipmentSlot} */("Chest")},
 {label:"legs",slot:/** @type {import("@minecraft/server").EquipmentSlot} */("Legs")},
 {label:"feet",slot:/** @type {import("@minecraft/server").EquipmentSlot} */("Feet")},
 {label:"mainhand",slot:/** @type {import("@minecraft/server").EquipmentSlot} */("Mainhand")},
 {label:"offhand",slot:/** @type {import("@minecraft/server").EquipmentSlot} */("Offhand")}
]);
/** @param {Point} p */
const point=p=>p&&[p.x,p.y,p.z].every(Number.isFinite)&&Math.abs(p.x)<=30000000&&Math.abs(p.z)<=30000000&&Math.abs(p.y)<=2048;
/** @param {Point} a @param {Point} b */
const samePoint=(a,b)=>a.x===b.x&&a.y===b.y&&a.z===b.z;
/** @returns {FixtureSnapshot} */
function blank(){return{profile:"zombie",status:"unverified",ready:false,reasons:[],health:{readable:false,currentReadable:false,maxReadable:false,stable:false},slots:Object.fromEntries(SLOTS.map(s=>[s.label,{state:"unknown"}])),unique:false};}
/** Two capped censuses, six slot lookups, separate health/stability checks.
 * Unknown equipment never erases readable health or counts as empty.
 * @param {Entity|undefined} sender @param {string} [profile] @returns {FixtureSnapshot} */
export function inspectNamedFixture(sender,profile="zombie"){
 const out=blank();out.profile=profile;
 const type=Object.hasOwn(FIXTURE_PROFILES,profile)?FIXTURE_PROFILES[/** @type {keyof typeof FIXTURE_PROFILES} */(profile)]:undefined;
 if(!type){out.reasons.push("unknown fixed fixture profile");return out;}
 /** @type {Player} */ let player;
 /** @type {import("@minecraft/server").Dimension} */ let dimension;
 /** @type {Point} */ let center;
 try{if(!sender||sender.typeId!=="minecraft:player"||sender.isValid!==true){out.reasons.push("Overworld player source required");return out;}
  player=/** @type {Player} */(sender);dimension=player.dimension;center={...player.location};
  if(dimension.id!=="minecraft:overworld"||!point(center)){out.reasons.push("Overworld player position required");return out;}
 }catch(_error){out.reasons.push("caller context unreadable");return out;}
 const query=()=>dimension.getEntities({name:FIXTURE_NAME,location:center,maxDistance:FIXTURE_RADIUS,closest:2});
 /** @type {Entity[]} */ let first;
 try{first=query();if(first.length!==1){out.reasons.push(first.length===0?"zero named fixture actors within64":"ambiguous named fixture actors within64 (at least2)");return out;}}
 catch(_error){out.reasons.push("named-fixture query unreadable");return out;}
 const actor=first[0];
 try{const id=actor.id,position={...actor.location};
  if(actor.isValid!==true||actor.typeId!==type||actor.nameTag!==FIXTURE_NAME||actor.dimension.id!==dimension.id||typeof id!=="string"||!/^[A-Za-z0-9:_-]{1,128}$/.test(id)||!point(position)
   ||(position.x-center.x)**2+(position.y-center.y)**2+(position.z-center.z)**2>FIXTURE_RADIUS**2){out.reasons.push("fixture identity/position unreadable or outside scope");return out;}
  out.id=id;out.position=position;out.unique=true;
 }catch(_error){out.reasons.push("fixture identity/position unreadable");return out;}
 let health;
 try{health=actor.getComponent("minecraft:health");if(!health||health.isValid!==true)throw Error();}
 catch(_error){health=undefined;out.reasons.push("health component UNAVAILABLE");}
 if(health){
  try{const current=health.currentValue;if(!Number.isFinite(current)||current<0)throw Error();out.health.current=current;out.health.currentReadable=true;}
  catch(_error){out.reasons.push("current health UNREADABLE");}
  try{const max=health.effectiveMax;if(!Number.isFinite(max)||max<=0)throw Error();out.health.max=max;out.health.maxReadable=true;}
  catch(_error){out.reasons.push("maximum health UNREADABLE");}
  out.health.readable=out.health.currentReadable&&out.health.maxReadable&&/** @type {number} */(out.health.current)<=/** @type {number} */(out.health.max);
  if(out.health.currentReadable&&out.health.maxReadable&&!out.health.readable)out.reasons.push("health range invalid");
 }
 let equipment;
 try{equipment=actor.getComponent("minecraft:equippable");if(!equipment||equipment.isValid!==true)throw Error();}
 catch(_error){equipment=undefined;out.reasons.push("equippable component UNAVAILABLE; all six slots UNKNOWN");}
 if(equipment)for(const {label,slot} of SLOTS){try{const item=equipment.getEquipment(slot);
  if(item===undefined){out.slots[label]={state:"empty"};continue;}
  if(!item||typeof item.typeId!=="string"||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(item.typeId)||item.typeId.length>128||!Number.isSafeInteger(item.amount)||item.amount<1||item.amount>255)throw Error();
  out.slots[label]={state:"item",typeId:item.typeId,amount:item.amount};
 }catch(_error){out.reasons.push(label+" slot UNREADABLE");}}
 if(equipment)try{if(equipment.isValid!==true)out.reasons.push("equippable validity changed during snapshot");}catch(_error){out.reasons.push("final equippable validity UNREADABLE");}
 // Field failures remain independent: health can still prove injury when gear is unavailable.
 try{if(out.health.readable&&health){out.health.stable=health.isValid===true&&health.currentValue===out.health.current&&health.effectiveMax===out.health.max;if(!out.health.stable)out.reasons.push("health changed during snapshot");}}
 catch(_error){out.health.stable=false;out.reasons.push("final health read UNREADABLE");}
 try{const last=query();if(last.length!==1||last[0].id!==out.id||actor.isValid!==true||actor.typeId!==type||actor.nameTag!==FIXTURE_NAME||actor.dimension.id!==dimension.id
  ||!samePoint(actor.location,/** @type {Point} */(out.position))||player.isValid!==true||player.dimension.id!==dimension.id){out.unique=false;out.reasons.push("fixture/caller identity or position changed during snapshot");}}
 catch(_error){out.unique=false;out.reasons.push("final named-fixture census UNREADABLE");}
 if(out.unique&&out.health.readable&&out.health.stable&&SLOTS.every(s=>out.slots[s.label].state!=="unknown")&&out.reasons.length===0){out.status="verified";out.ready=out.health.current===out.health.max&&(profile!=="zombie"||out.health.max===20)&&SLOTS.every(s=>out.slots[s.label].state==="empty");}
 return out;
}
/** @param {FixtureSnapshot} snapshot @returns {string[]} */
export function formatFixtureSnapshot(snapshot){
 const lines=[`Profile ${snapshot.profile}; controlled filter fixture ONLY, not siege-owner integration.`,`[ca_fixture] ${snapshot.status==="verified"?"VERIFIED SNAPSHOT":"UNVERIFIED"}; ${snapshot.ready?"full measured HP and six slots empty NOW":"DO NOT ENGAGE as a verified bare/full-health fixture"}.`];
 if(snapshot.id&&snapshot.position){const p=snapshot.position;lines.push(`id=${snapshot.id}; position=${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}; local uniqueness=${snapshot.unique?"1":"UNVERIFIED"}.`);}
 lines.push(snapshot.health.readable?`Health READABLE ${snapshot.health.current}/${snapshot.health.max}; stable=${snapshot.health.stable}. Gear availability is separate.`:`Health PARTIAL/UNKNOWN current=${snapshot.health.currentReadable?snapshot.health.current:"UNKNOWN"}, max=${snapshot.health.maxReadable?snapshot.health.max:"UNKNOWN"}; no full measured-HP proof.`);
 for(const {label} of SLOTS){const s=snapshot.slots[label];lines.push(`${label}: ${s.state==="empty"?"EMPTY":s.state==="item"?`${s.typeId} x${s.amount}`:"UNKNOWN"}`);}
 if(snapshot.reasons.length)lines.push("Reasons: "+snapshot.reasons.join("; "));
 lines.push("Read-only instant snapshot within64 of caller; no automatic authorization, mutations or later-state guarantee.");return lines;
}
/** @param {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} event */
export function handleFixtureInspection(event){
 if(event.id!==FIXTURE_INSPECT_EVENT)return;
 const sender=event.sourceEntity;
 const profile=event.message.trim()||"zombie";
 if(!Object.hasOwn(FIXTURE_PROFILES,profile)){if(sender?.typeId==="minecraft:player")try{/** @type {Player} */(sender).sendMessage("[ca_fixture] UNVERIFIED: use /scriptevent ca_fixture:inspect [zombie|pillager|vindicator].");}catch(_error){}return;}
 const snapshot=inspectNamedFixture(event.sourceType==="Entity"?sender:undefined,profile);
 if(sender?.typeId==="minecraft:player")try{/** @type {Player} */(sender).sendMessage(formatFixtureSnapshot(snapshot).join("\n"));}catch(_error){}
 return snapshot;
}
let registered=false;
/** Early-execution safe: subscription only, no runtime queries.
 * @param {import("@minecraft/server").System} system */
export function registerFixtureInspection(system){if(registered)return false;system.afterEvents.scriptEventReceive.subscribe(handleFixtureInspection,{namespaces:["ca_fixture"]});registered=true;return true;}
