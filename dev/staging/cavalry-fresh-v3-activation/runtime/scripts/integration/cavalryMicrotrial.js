// @ts-check
import {PRIVATE_CAVALRY_TRIAL} from "./cavalryMicrotrialTrust.js";
import {REVIEWED_CAVALRY_FIXTURE} from "./cavalryFreshTrust.js";
import {decodeMilitarySelection} from "../population/militarySelection.js";
import {POP_SPOTS} from "../population/settings.js";
/** A private disposable-fixture configuration, NOT the production military selector or a saved city.
 * NULL mode is inert and reads no world state. It never changes kingdom counts or terrain.
 * @param {{creation:any}} deps */
export function createCavalryMicrotrial(deps){
 const p=PRIVATE_CAVALRY_TRIAL,d=REVIEWED_CAVALRY_FIXTURE;
 if(p===null)return{streetsOptions:()=>({}),description:"off"};
 if(!d||p.v!==1||p.fixtureId!==d.fixtureId||![p.origin.x,p.origin.y,p.origin.z].every(Number.isFinite)||!Number.isSafeInteger(p.origin.y)||p.origin.y< -63||p.origin.y>315)throw Error("private cavalry profile does not match reviewed v3 fixture");
 const origin=Object.freeze({...p.origin}),home=Object.freeze({x:origin.x-POP_SPOTS.inset,y:origin.y,z:origin.z-POP_SPOTS.inset-POP_SPOTS.soldierRowOffset});
 const selected=JSON.stringify({v:3,trialId:d.fixtureId,fixtureId:d.fixtureId,groupId:"district-1:sol:0",class:"cavalry",typeId:"civ_trial:cavalry",dimension:"minecraft:overworld"});
 function readSelection(){const s=deps.creation.activeStore();if(!s||s.format()!==3)throw Error("private cavalry trial requires completed fresh-v3 activation");return decodeMilitarySelection(selected);}
 function streetsOptions(){return{compoundNativeTrial:true,homes:()=>({"district-1":{...home}}),anchors:()=>[{...origin}],config:{physicalRadius:1,holdRadius:3,coarseRadius:4,physicalFloorPerKind:0,maxPhysicalPerDistrict:2,maxPhysicalTotal:2,maxSpawnsPerTick:1,maxOpsPerTick:1},readMilitarySelection:readSelection};}
 return{streetsOptions,description:"private one-group owner trial; source-city military selection is not tested"};
}
