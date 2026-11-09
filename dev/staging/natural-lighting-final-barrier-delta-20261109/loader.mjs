const active=new URL('../../../CivilizationApocalypse_BP/scripts/',import.meta.url), runtime=new URL('./runtime/',import.meta.url);
export async function resolve(s,c,next){let u;try{u=new URL(s,c.parentURL)}catch{return next(s,c)};if(u.href.startsWith(active.href))return next(new URL(u.href.slice(active.href.length),runtime).href,c);return next(s,c)}
