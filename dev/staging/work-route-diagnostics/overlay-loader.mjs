import{readFileSync}from'node:fs';
const original=new URL('../../../CivilizationApocalypse_BP/scripts/people/workRoutePreview.js',import.meta.url).href;
export async function resolve(specifier,context,next){let parent=context.parentURL;if(parent?.includes('/work-route-diagnostics/proposed-dev/test/'))parent=new URL('../../../dev/test/'+parent.split('/').at(-1),import.meta.url).href;return next(specifier,{...context,parentURL:parent});}
export async function load(url,context,next){if(url===original)return{format:'module',source:readFileSync(new URL('./proposed-workRoutePreview.js',import.meta.url),'utf8'),shortCircuit:true};return next(url,context);}
