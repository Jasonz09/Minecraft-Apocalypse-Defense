// Read-only target/source preflight; writes a NEW plan only inside this stage.
import {lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {makeSetupPlan,readSetupOptions} from './setup.mjs';
const [optionsPath,output]=process.argv.slice(2),base=resolve(import.meta.dirname,'plan-evidence');
if(!isAbsolute(optionsPath??'')||!isAbsolute(output??'')||!output.endsWith('.json'))throw Error('use absolute options and new stage/plan-evidence/output.json');
const rel=relative(base,resolve(output));if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw Error('plan output must remain inside this stage/plan-evidence');
for(let p=resolve(output);;p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())throw Error('linked plan output refused');}catch(error){if(error.code!=='ENOENT')throw error;}if(dirname(p)===p)break;}
const plan=makeSetupPlan(readSetupOptions(optionsPath));
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({planned:true,nativeInstalled:false,visibleName:plan.options.visibleName,newWorld:plan.world.dest,retainedPreviousPair:plan.packs.map(p=>p.backup),output},null,2));
