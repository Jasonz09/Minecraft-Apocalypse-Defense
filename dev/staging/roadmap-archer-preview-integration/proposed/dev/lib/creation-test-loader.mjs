// Offline test-only native seam. Synthetic trust never ships in either pack.
const scripts=new URL('../../CivilizationApocalypse_BP/scripts/',import.meta.url);
export async function resolve(s,c,next){
 if(s==='@minecraft/server')return{url:new URL('../fixtures/creation-native-stub.mjs',import.meta.url).href,shortCircuit:true};
 let u;try{u=new URL(s,c.parentURL);}catch{return next(s,c);}
 if(c.parentURL?.startsWith(scripts.href)&&c.parentURL.includes('?synthetic')&&s.startsWith('.')){
  if(u.pathname.endsWith('/freshFixtureTrust.js'))return next(new URL('../fixtures/synthetic-creation-trust.mjs',import.meta.url).href,c);
  if(u.href.startsWith(scripts.href))u.search='?synthetic';
 }
 return next(u.href,c);
}
