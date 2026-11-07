import {readFileSync} from "node:fs";
const root=new URL("../../../",import.meta.url);
const names=["wallLeafTrim.js","leafSourceStreaming.js","wallleafpreview.js","wallLeafRepair.js"];
const mapping=new Map(names.map(name=>[new URL("CivilizationApocalypse_BP/scripts/civ/"+name,root).href,new URL("proposed/CivilizationApocalypse_BP/scripts/civ/"+name,import.meta.url)]));
mapping.set(new URL("CivilizationApocalypse_BP/scripts/commands/civ.js",root).href,new URL("proposed/CivilizationApocalypse_BP/scripts/commands/civ.js",import.meta.url));
export async function resolve(specifier,context,next){
 let parent=context.parentURL;
 if(parent?.includes("/leaf-source-streaming/proposed-dev/test/"))parent=new URL("dev/test/"+parent.split("/").at(-1),root).href;
 if(specifier.startsWith(".")&&parent){const url=new URL(specifier,parent).href;if(mapping.has(url))return{url,shortCircuit:true};}
 return next(specifier,{...context,parentURL:parent});
}
export async function load(url,context,next){if(mapping.has(url))return{format:"module",source:readFileSync(mapping.get(url),"utf8"),shortCircuit:true};return next(url,context);}
