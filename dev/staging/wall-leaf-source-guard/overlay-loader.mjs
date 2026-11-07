const actual=new URL('../../../CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js',import.meta.url).href;
const proposed=new URL('./proposed/CivilizationApocalypse_BP/scripts/civ/wallLeafRepair.js',import.meta.url).href;
export async function resolve(specifier,context,next){
 if(context.parentURL===proposed&&specifier.startsWith('.'))return next(new URL(specifier,actual).href,context);
 const result=await next(specifier,context);return result.url===actual?{...result,url:proposed}:result;
}
