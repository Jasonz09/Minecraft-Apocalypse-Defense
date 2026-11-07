/** Distant reports and diplomacy, advanced ONLY by the existing kingdom hour.
 * No physical settlements, coordinates, entities, chunk holds or army credit. */
export const DIPLOMACY = Object.freeze({version:1, realms:3, foodCost:6, supplyCost:2, scoutHours:12, envoyHours:18, allianceHours:24});
const NAMES = ["Alderwatch", "Sunmere", "Stonehaven"];
const BEARINGS = ["north", "southeast", "west"];
/** @returns {any} */
export function emptyDiplomacy(){return {v:1,realms:[],mission:null,lastAdvancedStep:0};}
/** @param {unknown} n @param {number} max */
const count=(n,max)=>Number.isSafeInteger(n)&&/** @type {number} */(n)>=0&&/** @type {number} */(n)<=max;
/** @param {any} raw @param {number} step @param {string[]} districtIds @returns {string[]} */
export function diplomacyProblems(raw,step,districtIds){
 const fail=(/** @type {string} */s)=>["diplomacy: "+s];
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||raw.v!==1)return fail("unsupported or missing version");
 if(!Array.isArray(raw.realms)||raw.realms.length>DIPLOMACY.realms||!count(raw.lastAdvancedStep,step))return fail("realm/clock bound");
 const ids=new Set();
 for(const [index,r] of raw.realms.entries()){
  if(!r||r.id!==`realm-${index+1}`||!/^realm-[1-3]$/.test(r.id)||ids.has(r.id)||r.name!==NAMES[Number(r.id.slice(-1))-1]||r.bearing!==BEARINGS[Number(r.id.slice(-1))-1])return fail("realm identity");ids.add(r.id);
  if(!count(r.discoveredAt,step)||!count(r.relation,100)||!['neutral','allied'].includes(r.treaty)||!count(r.population,10000)||r.population<1||!count(r.soldiers,5000)||r.soldiers>r.population||!count(r.food,20000)||!count(r.integrity,100))return fail("realm bounds");
  const p=r.report;if(!p||!count(p.at,step)||p.at<r.discoveredAt||!count(p.population,10000)||p.population<1||!count(p.soldiers,5000)||p.soldiers>p.population||!count(p.integrity,100))return fail("report bounds");
 }
 const m=raw.mission;
 if(m!==null){
  if(!m||!['scout','envoy','alliance'].includes(m.kind)||!districtIds.includes(m.fromDistrictId)||!count(m.sentAt,step)||!count(m.dueAt,Number.MAX_SAFE_INTEGER)||m.dueAt<=m.sentAt||m.dueAt-m.sentAt!==(m.kind==='scout'?DIPLOMACY.scoutHours:m.kind==='envoy'?DIPLOMACY.envoyHours:DIPLOMACY.allianceHours))return fail("mission bounds");
  if(m.kind==='scout'?(m.realmId!==null||raw.realms.length>=DIPLOMACY.realms):!ids.has(m.realmId))return fail("mission target");
 }
 return [];
}
/** @param {any} k */
function state(k){const problems=diplomacyProblems(k.diplomacy,k.step,k.districts.map((/** @type {any} */d)=>d.id));if(problems.length)throw Error(problems.join('; '));return k.diplomacy;}
/** @param {any} k @param {string} kind @param {string|null} realmId */
export function diplomaticReadiness(k,kind,realmId=null){
 try{
  const d=state(k);if(!['scout','envoy','alliance'].includes(kind))throw Error('Unknown diplomatic mission.');
  if(d.mission)throw Error('An expedition is already travelling.');
  if(!Number.isSafeInteger(k.step)||k.step>Number.MAX_SAFE_INTEGER-24)throw Error('The kingdom clock cannot schedule another journey.');
  const home=k.districts[0];if(!home||home.security!=='secure'||Number(home.assault)>0)throw Error('Headquarters must be secure before sending an expedition.');
  if(!Number.isFinite(home.reserves?.food)||!Number.isFinite(home.reserves?.supplies)||home.reserves.food<DIPLOMACY.foodCost||home.reserves.supplies<DIPLOMACY.supplyCost)throw Error('Headquarters needs 6 food and 2 supplies.');
  const realm=d.realms.find((/** @type {any} */r)=>r.id===realmId);
  if(kind==='scout'){if(realmId!==null||d.realms.length>=DIPLOMACY.realms)throw Error('All available regional contacts have been reported.');}
  else{
   if(!realm)throw Error('That realm has not been discovered.');
   if(kind==='alliance'&&(realm.treaty==='allied'||realm.relation<50))throw Error(realm.treaty==='allied'?'An alliance already exists.':'Relations must reach 50 before proposing an alliance.');
  }
  const hours=kind==='scout'?DIPLOMACY.scoutHours:kind==='envoy'?DIPLOMACY.envoyHours:DIPLOMACY.allianceHours;
  return {ok:true,homeId:String(home.id),homeName:String(home.name),hours,realmName:realm?.name??null};
 }catch(e){return {ok:false,reason:String(e instanceof Error?e.message:e)};}
}
/** Only called against the Ledger's fresh private save copy after confirmation.
 * @param {any} k @param {string} kind @param {string|null} [realmId] */
export function sendDiplomaticMission(k,kind,realmId=null){
 const ready=diplomaticReadiness(k,kind,realmId);if(!ready.ok)return ready;
 const home=k.districts[0],d=state(k);home.reserves.food=Math.round((home.reserves.food-DIPLOMACY.foodCost)*10)/10;home.reserves.supplies=Math.round((home.reserves.supplies-DIPLOMACY.supplyCost)*10)/10;
 d.mission={kind,realmId,fromDistrictId:ready.homeId,sentAt:k.step,dueAt:k.step+/** @type {number} */(ready.hours)};
 return {ok:true,hours:ready.hours,realmName:ready.realmName};
}
/** Independent deterministic distant pressure, does not consume the home RNG.
 * @param {any} k @param {number} ordinal @param {number} step */
function roll(k,ordinal,step){return (((k.seed>>>0)^Math.imul(ordinal,2654435761)^Math.imul(step,2246822519))>>>0);}
/** @param {any} realm @param {number} step */
function report(realm,step){realm.report={at:step,population:realm.population,soldiers:realm.soldiers,integrity:realm.integrity};}
/** Called once inside the existing transactional kingdom step, never by a timer.
 * @param {any} k @returns {string[]} */
export function runDiplomacyStep(k){
 const d=state(k);if(d.lastAdvancedStep===k.step)return [];
 if(d.lastAdvancedStep>k.step)throw Error('Diplomacy clock reversed.');
 const events=[];
 for(const r of d.realms){
  if(k.step%24===0){
   const food=Math.floor(r.population/10);r.food=Math.min(20000,r.food+food);
   if(r.integrity>=50&&r.food>=20){r.population=Math.min(10000,r.population+Math.max(1,Math.floor(r.population/100)));r.food-=20;}
   else if(r.integrity<25)r.population=Math.max(1,r.population-Math.max(1,Math.floor(r.population/100)));
   r.soldiers=Math.min(r.soldiers,r.population);
  }
  if(k.step%48===0){const force=20+roll(k,Number(r.id.slice(-1)),k.step)%41,loss=Math.min(r.soldiers,Math.max(1,Math.floor(force/10)));r.soldiers-=loss;r.integrity=Math.max(0,r.integrity-Math.max(1,force-Math.floor(r.soldiers/3)));}
  else if(r.integrity<100&&r.food>0){r.integrity=Math.min(100,r.integrity+1);r.food--;}
 }
 const m=d.mission;
 if(m&&m.dueAt<=k.step){
  if(m.kind==='scout'){
   const n=d.realms.length+1,r={id:`realm-${n}`,name:NAMES[n-1],bearing:BEARINGS[n-1],discoveredAt:k.step,relation:0,treaty:'neutral',population:300+roll(k,n,0)%201,soldiers:60+roll(k,n,1)%61,food:500,integrity:100,report:null};report(r,k.step);d.realms.push(r);events.push(`Scouts report ${r.name} to the ${r.bearing}; relations begin neutral. No settlement site has been surveyed for travel.`);
  }else{
   const r=d.realms.find((/** @type {any} */r)=>r.id===m.realmId);if(!r)throw Error('Diplomatic mission target disappeared.');
   if(m.kind==='envoy'){r.relation=Math.min(100,r.relation+25);events.push(`The envoy returned from ${r.name}; relations ${r.relation}.`);}
   else if(r.relation>=50&&r.integrity>=50&&r.soldiers>=20){r.treaty='allied';events.push(`${r.name} accepted an alliance. Assistance still requires a surveyed route.`);}
   else events.push(`${r.name} declined the alliance while its defenses are strained.`);
   report(r,k.step);
  }
  d.mission=null;
 }
 d.lastAdvancedStep=k.step;return events;
}
