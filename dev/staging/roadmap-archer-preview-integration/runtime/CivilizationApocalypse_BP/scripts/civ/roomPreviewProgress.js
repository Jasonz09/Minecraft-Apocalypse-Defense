/** Bounded command-local progress only. No jobs, timers, native reads or stored authority. */
export const ROOM_PROGRESS_LIMITS=Object.freeze({minTicks:200,totalMessages:16,sourceMessages:8,plannedMessages:2,censusMessages:6});
/** @param {{current:()=>boolean,readTick:()=>number,send:(line:string)=>void}} deps */
export function createRoomPreviewProgress(deps){
 let busy=false,reentered=false,sent=0,lastTick=-1,lastRank=-1;
 const counts=[0,0,0],lastCount=[-1,-1,-1];
 function check(){if(deps.current()!==true||reentered)throw Error("Room progress source/player/cancellation changed");}
 /** @param {"source"|"planned"|"census"} phase @param {number} count @param {number} [total] */
 function report(phase,count,total){
  if(busy){reentered=true;throw Error("Room progress callback reentered");}
  const rank=phase==="source"?0:phase==="planned"?1:phase==="census"?2:-1;
  if(rank<0||!Number.isSafeInteger(count)||count<0||rank<lastRank||count<lastCount[rank])throw Error("Invalid room progress counters");
  if(phase==="census"&&(!Number.isSafeInteger(total)||/** @type {number} */(total)<count||/** @type {number} */(total)>1024))throw Error("Invalid room progress total");
  busy=true;
  try{
   check();const tick=deps.readTick();check();
   if(!Number.isSafeInteger(tick)||tick<0)return;
   const cap=rank===0?ROOM_PROGRESS_LIMITS.sourceMessages:rank===1?ROOM_PROGRESS_LIMITS.plannedMessages:ROOM_PROGRESS_LIMITS.censusMessages;
   lastCount[rank]=count;
   if(sent>=ROOM_PROGRESS_LIMITS.totalMessages||counts[rank]>=cap||(rank===lastRank&&tick-lastTick<ROOM_PROGRESS_LIMITS.minTicks))return;
   const line=phase==="source"?`Still verifying the saved chapel: ${count} source slices checked; no changes.`:phase==="planned"?`Saved chapel verified; checking planned room cells (${count} source operations).`:`Room cells read ${count}/${total}; result still being checked, no changes.`;
   check();deps.send(line);check();
   sent++;counts[rank]++;lastTick=tick;lastRank=rank;
  }finally{busy=false;}
 }
 return{report};
}
