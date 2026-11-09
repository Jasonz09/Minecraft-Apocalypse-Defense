export async function resolve(s,c,n){if(s==='@minecraft/server')return n(new URL('./native-stub.mjs',import.meta.url).href,c);return n(s,c);}
