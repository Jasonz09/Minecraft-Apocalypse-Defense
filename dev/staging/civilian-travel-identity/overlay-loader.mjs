import{readFileSync}from'node:fs';
const root=new URL('../../../',import.meta.url),travel=new URL('CivilizationApocalypse_BP/scripts/integration/civilianTravel.js',root).href,fixture=new URL('dev/lib/civilian-travel-identity-fixture.mjs',root).href;
export async function resolve(specifier,context,next){
 if(specifier==='@minecraft/server')return{url:'data:text/javascript,export const world={};export const system={};',shortCircuit:true};
 let parent=context.parentURL;if(parent?.includes('/civilian-travel-identity/proposed-dev/test/'))parent=new URL('dev/test/'+parent.split('/').at(-1),root).href;
 if(parent&&specifier.startsWith('.')){const url=new URL(specifier,parent).href;if(url===fixture)return{url,shortCircuit:true};}
 return next(specifier,{...context,parentURL:parent});
}
export async function load(url,context,next){if(url===travel)return{format:'module',source:readFileSync(new URL('./proposed-civilianTravel.js',import.meta.url),'utf8'),shortCircuit:true};if(url===fixture)return{format:'module',source:readFileSync(new URL('./proposed-dev/lib/civilian-travel-identity-fixture.mjs',import.meta.url),'utf8'),shortCircuit:true};return next(url,context);}
