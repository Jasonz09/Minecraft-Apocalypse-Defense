// Isolated policy helper: call invalidation ONLY after a successful actual write.
// It removes stale evidence; it never produces an affirmative tree verdict.
const states=new WeakMap();
export const LIMITS=Object.freeze({bases:64,memberships:8192,cells:4001});
const key=p=>`${p.x},${p.y},${p.z}`;
export function rememberRootRefusal(session,base,cells,seed,reason){
    const keys=new Set([...cells,seed].map(key));
    if(keys.size>LIMITS.cells)return false;
    const state=states.get(session)??{groups:new Map(),memberships:0};
    const at=key(base),old=state.groups.get(at),group=new Map(old??[]);
    for(const k of keys)group.set(k,reason);
    const count=state.memberships-(old?.size??0)+group.size;
    if((!old&&state.groups.size>=LIMITS.bases)||count>LIMITS.memberships)return false;
    state.groups.set(at,group);state.memberships=count;states.set(session,state);
    for(const k of keys)session.treeRefused.set(k,reason);
    return true;
}
export function invalidateAfterActualWrite(session,cell){
    const state=states.get(session),at=key(cell),group=state?.groups.get(at);
    if(!group)return 0;
    let removed=0;
    for(const [k,reason] of group)if(session.treeRefused.get(k)===reason){session.treeRefused.delete(k);removed++;}
    state.groups.delete(at);state.memberships-=group.size;
    return removed;
}
export function forgetRootDependencies(session){states.delete(session);}
