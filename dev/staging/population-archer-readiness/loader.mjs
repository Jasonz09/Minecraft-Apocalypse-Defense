import {existsSync} from 'node:fs';
const active=new URL('../../../CivilizationApocalypse_BP/scripts/',import.meta.url),stage=new URL('./proposed/CivilizationApocalypse_BP/scripts/',import.meta.url);
export async function resolve(s,c,n){
 if(s==='@minecraft/server')return{url:new URL('./native-stub.mjs',import.meta.url).href,shortCircuit:true};
 let u;try{u=new URL(s,c.parentURL);}catch{return n(s,c);}
 if(u.href.startsWith(active.href)){const candidate=new URL(u.href.slice(active.href.length),stage);if(existsSync(candidate))u=candidate;}
 if(c.parentURL?.startsWith(stage.href)&&s.startsWith('.')){
  const synthetic=c.parentURL.includes('?synthetic');
  if(u.pathname.endsWith('/freshFixtureTrust.js')&&synthetic)return n(new URL('./synthetic-trust.mjs',import.meta.url).href,c);
  if(u.href.startsWith(stage.href)&&!existsSync(u))u=new URL(u.href.slice(stage.href.length),active);
  if(synthetic&&u.href.startsWith(stage.href))u.search='?synthetic';
 }
 if(u.href.startsWith(stage.href)||u.href.startsWith(active.href))return n(u.href,c);
 return n(s,c);
}
