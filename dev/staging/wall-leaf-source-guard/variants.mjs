import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import '../../../dev/lib/civharness.mjs';
const source=new URL('../../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js',import.meta.url);
const frozenFile=new URL('./frozen-wallLeafRepair.js',import.meta.url),proposedFile=new URL('./proposed/CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js',import.meta.url);
const rebased=file=>readFileSync(file,'utf8').replace(/from\s+(['"])(\.[^'"]+)\1/g,(_m,q,s)=>'from '+q+new URL(s,source).href+q);
const load=file=>import('data:text/javascript;base64,'+Buffer.from(rebased(file)).toString('base64'));
export const frozen=await load(frozenFile),optimized=await load(proposedFile);
export const frozenSha256=createHash('sha256').update(readFileSync(frozenFile)).digest('hex').toUpperCase();
export function state(){const props=new Map([['civ:plan:meta','plan bytes'],['civ:jobs:d4:meta','queue bytes']]),calls=[];let kingdom={hour:1,resources:{food:2},districts:[{id:'district-4',civ:{status:'complete',checksum:'12345678',dimension:'minecraft:overworld'},physical:{origin:{x:1,y:64,z:2}}}]},cancelled=false;
 const flags={idsError:false,propertyError:null,kingdomError:false,cancelError:false,idsOverride:null};
 const world={getDynamicPropertyIds(){calls.push('ids');if(flags.idsError)throw Error('ids unavailable');return flags.idsOverride??[...props.keys()];},getDynamicProperty(k){calls.push('raw:'+k);if(flags.propertyError===k)throw Error('raw unavailable');return props.get(k);},setDynamicProperty(){throw Error('WRITE FORBIDDEN');}};
 const readKingdom=()=>{calls.push('protection');if(flags.kingdomError)throw Error('kingdom unavailable');return kingdom;};
 const cancel=()=>{if(flags.cancelError)throw Error('cancel unavailable');return cancelled;};
 return{props,calls,flags,world,readKingdom,cancel,get kingdom(){return kingdom;},set kingdom(v){kingdom=v;},set cancelled(v){cancelled=v;},reset(){calls.length=0;}};
}
