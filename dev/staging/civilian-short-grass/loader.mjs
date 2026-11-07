import{readFile}from'node:fs/promises';
const active=new URL('../../../CivilizationApocalypse_BP/scripts/',import.meta.url),stage=new URL('./proposed/',import.meta.url);
const paths=['people/walkSafety.js','integration/civilianTravel.js','people/workRoutePreview.js'];
export async function resolve(s,c,n){let url;try{url=new URL(s,c.parentURL);}catch{return n(s,c);}if(url.href.startsWith(stage.href)){const rel=url.href.slice(stage.href.length);if(!paths.includes(rel))return n(new URL(rel,active).href,c);}const rel=url.href.startsWith(active.href)?url.href.slice(active.href.length):null;if(paths.includes(rel))return{url:new URL(rel,stage).href,shortCircuit:true};return n(s,c);}
