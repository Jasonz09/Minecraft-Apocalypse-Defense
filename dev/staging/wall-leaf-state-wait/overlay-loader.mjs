import {readFileSync} from "node:fs";
const mapping=new Map(["wallLeafTrim.js","wallLeafRepair.js"].map(name=>[new URL("../../../CivilizationApocalypse_BP/scripts/civ/"+name,import.meta.url).href,new URL(name,import.meta.url)]));
export async function load(url,context,next){if(mapping.has(url))return{format:"module",source:readFileSync(mapping.get(url),"utf8"),shortCircuit:true};return next(url,context);}

export async function resolve(specifier,context,next){
 if(context.parentURL?.includes("/wall-leaf-state-wait/proposed-dev/test/")&&specifier.startsWith(".")){
 const parent=new URL("../../../dev/test/"+context.parentURL.split("/").at(-1),import.meta.url).href;
 return next(specifier,{...context,parentURL:parent});
 }
 return next(specifier,context);
}
