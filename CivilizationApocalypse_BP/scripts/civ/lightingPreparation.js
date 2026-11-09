// Pure preparation-only cooperative adapter. No native reads, writes, timer or owner.
export const LIGHT_PREPARATION_BATCH=8;
/** Applies ONLY to read-only saved-source loading / pure rehydration. Native fixture
 * inspection and mutation retain their existing per-getter/final barriers.
 * @template T @param {Generator<any,T,any>} generator
 * @param {{assertSources:()=>void,fastCurrent:()=>boolean,onProgress?:(units:number)=>void}} ports
 * @returns {Generator<void,T,void>} */
export function* lightingPreparationSteps(generator,ports){
 let units=0,finished=false;
 try{for(;;){
  if(!ports.fastCurrent())throw Error('lighting preparation cancelled or owner changed');
  ports.assertSources();
  for(let at=0;at<LIGHT_PREPARATION_BATCH;at++){
   if(!ports.fastCurrent())throw Error('lighting preparation cancelled or owner changed');
   const next=generator.next();units++;
   if(next.done){ports.assertSources();if(!ports.fastCurrent())throw Error('lighting preparation cancelled or owner changed');finished=true;return next.value;}
  }
  ports.assertSources();if(!ports.fastCurrent())throw Error('lighting preparation cancelled or owner changed');
  if(ports.onProgress){ports.onProgress(units);ports.assertSources();if(!ports.fastCurrent())throw Error('lighting preparation cancelled or owner changed');}
  yield;
 }}finally{if(!finished)generator.return(/** @type {any} */(undefined));}
}
