const active=new URL('../../../CivilizationApocalypse_BP/scripts/',import.meta.url),stage=new URL('./proposed/',import.meta.url);
export async function resolve(s,c,n){let url;try{url=new URL(s,c.parentURL);}catch{return n(s,c);}if(c.parentURL?.startsWith(stage.href)){
 if(s==='./creationBindings.js')return n(new URL('../population-creation-binding-v2/bindings.mjs',import.meta.url).href,c);
 if(s==='./freshFixtureTrust.js'&&!c.parentURL.includes('?unconfigured'))return n(new URL('./synthetic-trust.mjs',import.meta.url).href,c);
 if(url.href.startsWith(new URL('./',stage).href)&&s.startsWith('../'))return n(new URL(s,new URL('integration/privateFreshFixture.js',active)).href,c);
 }return n(s,c);}
