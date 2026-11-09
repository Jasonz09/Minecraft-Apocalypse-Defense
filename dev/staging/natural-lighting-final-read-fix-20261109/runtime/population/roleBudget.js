/** Shared action budget for SAME owner role work. Each role attempt costs one op;
 * a role birth ALSO costs one spawn. No native operations occur here.
 * @param {{tick:number|null,ops:number,spawns:number}} prior @param {number} tick
 * @param {{maxOpsPerTick:number,maxSpawnsPerTick:number}} config */
export function createRoleBudget(prior,tick,config){
 if(!Number.isSafeInteger(tick)||tick<0||prior.tick!==null&&(!Number.isSafeInteger(prior.tick)||prior.tick<0)||![prior.ops,prior.spawns,config.maxOpsPerTick,config.maxSpawnsPerTick].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('invalid role budget');
 let ops=prior.tick===tick?prior.ops:0,spawns=prior.tick===tick?prior.spawns:0;
 return{reserve(/** @type {'spawn'|'remove'|'cancel'} */kind){if(!['spawn','remove','cancel'].includes(kind))throw Error('unknown role action');const birth=kind==='spawn';if(ops>=config.maxOpsPerTick||birth&&spawns>=config.maxSpawnsPerTick)return false;ops++;if(birth)spawns++;return true;},status:()=>({ops,spawns})};
}
