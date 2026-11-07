import {assignOccupations,ROLES} from './occupations.js';
import {parseGroupId,districtInFight} from '../population/groups.js';
import {POP_SYNC_DEFAULTS} from '../population/settings.js';
import {destinationProofIsCurrent} from './destinations.js';
import {TRAVEL_LIMITS} from './travel.js';

// Session-only compiler token, never person/casualty/production authority.
const ASSIGNMENTS=new WeakMap();
export const WORK_ASSIGNMENT_VERSION=1;
export const WORK_ASSIGNMENT_LIMITS=Object.freeze({candidates:128,roles:8});
/** @param {string} message @returns {never} */
const fail=message=>{throw new Error(message);};
/** @param {any} value @returns {any} */
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;};
/** @param {any} value @returns {any} */
const clone=value=>JSON.parse(JSON.stringify(value));
/** @param {any} n */
const exactCount=n=>Number.isSafeInteger(n)&&n>=0;
/** Derive a group's REAL current aggregate slot interval, never build a full roster.
 * This mirrors assignOccupations's ROLES order; tests compare its actual slot list.
 * @param {any} district @param {string} groupId */
export function representativeOccupation(district,groupId){
 const group=parseGroupId(groupId),size=POP_SYNC_DEFAULTS.groupSize.civ;
 if(!group||group.kind!=='civ'||!/^district-[1-5]$/.test(group.district)||district?.id!==group.district||!exactCount(group.index)||!exactCount(district.civilians))fail('invalid civilian aggregate identity/count');
 if(district.security!=='secure'||districtInFight(district))fail('district threat prevents work assignment');
 if(!exactCount(district.builders)||!district.buildings||['farms','storehouses','barracks','walls'].some(k=>!exactCount(district.buildings[k])))fail('occupation inputs are not exact bounded counts');
 const first=group.index*size;if(!Number.isSafeInteger(first)||first>=district.civilians)fail('group is outside aggregate civilian population');
 const headcount=Math.min(size,district.civilians-first),last=first+headcount;
 if(!Number.isSafeInteger(last))fail('unsafe aggregate slot range');
 const result=assignOccupations(district,{withRoster:false});
 if(result.lost||ROLES.length!==WORK_ASSIGNMENT_LIMITS.roles||Object.values(result.roles).some(n=>!exactCount(n)))fail('occupation interval unavailable');
 let cursor=0;const intersections=[];
 for(const role of ROLES){const end=cursor+result.roles[role];if(!Number.isSafeInteger(end))fail('unsafe occupation interval');
  const overlap=Math.max(0,Math.min(end,last)-Math.max(cursor,first));if(overlap)intersections.push({role,count:overlap});cursor=end;
 }
 if(cursor!==district.civilians||intersections.reduce((n,r)=>n+r.count,0)!==headcount)fail('occupation counts do not cover the group');
 if(intersections.length!==1||intersections[0].role!=='farmer')fail('representative group is mixed-role or not farmer');
 return freeze({groupId,districtId:group.district,role:'farmer',firstSlot:first,lastSlotExclusive:last,representedHeadcount:headcount,groupSize:size,
  roleStamp:JSON.stringify(ROLES.map(role=>[role,result.roles[role]]))});
}
/** Compile only compiler-owned CURRENT saved building candidates.
 * No admitted/census/native-clearance claims are manufactured by this pure step.
 * @param {any} compiled @param {{district:any,groupId:string,homeBuilding:string,farmBuilding:string}} input */
export function compileRepresentativeWorkAssignment(compiled,input){
 if(!destinationProofIsCurrent(compiled))fail('saved destination compiler provenance is absent/stale');
 const district=input.district,occupation=representativeOccupation(district,input.groupId);
 if(district.civ?.status!=='complete'||district.civ.stage!=='complete'||district.civ.dimension!=='minecraft:overworld'||district.civ.checksum!==compiled.checksum||occupation.districtId!==`district-${compiled.index}`)fail('completed district/source/dimension differs');
 if(!Array.isArray(compiled.candidates)||compiled.candidates.length>WORK_ASSIGNMENT_LIMITS.candidates)fail('destination candidate budget exceeded');
 /** @param {string} id @param {string} role */
 function choose(id,role){
  if(typeof id!=='string'||!/^building-[A-Za-z0-9_-]{1,87}$/.test(id))fail('invalid saved building identity');
  const matches=compiled.candidates.filter((/** @type {any} */ c)=>c.id===id&&c.role===role);if(matches.length!==1)fail('requested saved role/building is missing or ambiguous');
  const c=matches[0],floor=c.frontageSurface,feet=c.frontageFeet;
  if(c.checksum!==compiled.checksum||c.districtId!==occupation.districtId||typeof c.lotId!=='string'||!floor||floor.kind!=='road'||!feet||![feet.x,feet.y,feet.z].every(Number.isSafeInteger)||feet.y!==floor.y+1||feet.x!==floor.x||feet.z!==floor.z)fail('exact saved frontage provenance is unresolved');
  return{buildingId:c.id,lotId:c.lotId,role,blueprint:c.blueprint,checksum:c.checksum,door:clone(c.door),exit:clone(c.exit),floor:clone(floor),feet:clone(feet)};
 }
 const home=choose(input.homeBuilding,'home'),farm=choose(input.farmBuilding,'farm');
 if(home.buildingId===farm.buildingId||home.lotId===farm.lotId)fail('home and farm must be distinct saved lots');
 const a=home.feet,b=farm.feet,length=Math.abs(a.x-b.x)+Math.abs(a.z-b.z);
 if(a.y!==b.y||!(a.x===b.x||a.z===b.z)||length<1||length>TRAVEL_LIMITS.maxLength)fail('saved frontages do not form a supported flat straight1-24 corridor');
 const result=freeze({v:WORK_ASSIGNMENT_VERSION,policy:'representative-saved-farm-v1',groupId:input.groupId,districtId:occupation.districtId,checksum:compiled.checksum,
  dimension:'minecraft:overworld',occupation,home,farm,route:{groupId:input.groupId,home:{x:a.x+0.5,y:a.y,z:a.z+0.5},farm:{x:b.x+0.5,y:b.y,z:b.z+0.5}},
  scope:'Visual representative assignment only; not ten workers, physical farming, household occupancy, food/crop/resource accounting or persistent person identity.',sessionOnly:true});
 ASSIGNMENTS.set(result,true);return result;
}
/** Pure freshness only; runtime still needs source-property, identity and full native corridor guards.
 * @param {any} assignment @param {any} district */
export function representativeAssignmentIsCurrent(assignment,district){
 try{return ASSIGNMENTS.has(assignment)&&district?.civ?.status==='complete'&&district.civ.stage==='complete'&&district.civ.dimension===assignment.dimension&&district.civ.checksum===assignment.checksum
  &&JSON.stringify(representativeOccupation(district,assignment.groupId))===JSON.stringify(assignment.occupation);}catch{return false;}
}
