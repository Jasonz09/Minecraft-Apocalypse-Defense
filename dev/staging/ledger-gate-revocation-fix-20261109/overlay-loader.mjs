import fs from 'node:fs';
const target=new URL('../../../CivilizationApocalypse_BP/scripts/ledger/runtime.js',import.meta.url).href;
const testURL=new URL('./proposed-tests/ledger-access-revocation.test.mjs',import.meta.url).href;
const centralURL=new URL('../../../dev/test/ledger-access-revocation.test.mjs',import.meta.url).href;
export async function resolve(specifier,context,next){
 if(context.parentURL===testURL){return next(new URL(specifier,centralURL).href,context);}
 return next(specifier,context);
}
export async function load(url,context,next){
 if(url===target&&process.env.CIV_LEDGER_OVERLAY!=='baseline')return{format:'module',shortCircuit:true,source:fs.readFileSync(new URL('./proposed/ledger/runtime.js',import.meta.url),'utf8')};
 return next(url,context);
}
