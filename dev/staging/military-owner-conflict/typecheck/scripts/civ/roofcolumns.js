// Opt-in support retention. No world access; snapshots must be freshly read by the caller.
const AIR="minecraft:air",STONE="minecraft:stone_bricks";
const key=(/** @type {{x:number,y:number,z:number}} */ p)=>`${p.x},${p.y},${p.z}`;
const log=(/** @type {string} */ id)=>/^minecraft:(?:stripped_)?(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/.test(id);
const anchor=(/** @type {string} */ id)=>/^minecraft:(?:stone|stone_bricks|cobblestone|polished_andesite|andesite|deepslate_tiles|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_planks)$/.test(id);
const directions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

/** Accept only a proved fixture migration, never an arbitrary missing furnishing.
 * Fixture entries must come from the verified all-stage saved-plan revision.
 * @param {any} group @param {any[]} fixtures @param {ReadonlyMap<string,string>} live
 * @param {ReadonlyMap<string,boolean>} states */
export function roofFixtureAlternates(group,fixtures,live,states) {
    const original=new Map((group.original??[]).map((/** @type {any} */ op)=>[key(op),op]));
    const revised=new Map((group.revised??[]).map((/** @type {any} */ op)=>[key(op),op]));
    const skip=new Set(),guards=new Map(),stateGuards=[];
    for(const f of fixtures) {
        const source=key(f.before),target=key(f.after),anchor=key(f.anchor);
        if(source===target||original.get(source)?.id!=="minecraft:lantern"||live.get(source)!==AIR||live.get(target)!=="minecraft:lantern"
            ||states.get(target)!==(f.after.states?.hanging===true)||live.get(anchor)!==f.anchor.id)continue;
        const desired=revised.get(target);
        if(desired&&desired.id!==AIR)continue;
        original.set(source,{...f.before,id:AIR});revised.set(source,{...f.before,id:AIR});
        original.set(target,f.after);revised.set(target,f.after);skip.add(target);
        guards.set(source,AIR);guards.set(target,"minecraft:lantern");guards.set(anchor,f.anchor.id);stateGuards.push(f.after);
    }
    return {group:{...group,original:[...original.values()],revised:[...revised.values()],changes:group.changes.filter((/** @type {any} */ op)=>!skip.has(key(op)))},guards,stateGuards};
}

/** @param {any} e @param {number} x @param {number} z */
export function roofEntranceColumn(e,x,z) {
    const facing=/** @type {Record<string,number[]>} */({north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]})[e.facing];
    if(!facing||!e.door||!e.exit)return true;
    const [dx,dz]=facing;
    for(let n=-4;n<=Math.abs(e.exit.x-e.door.x)+Math.abs(e.exit.z-e.door.z);n++)
        if(x===e.door.x+dx*n&&z===e.door.z+dz*n)return true;
    return false;
}

/** Plan the sole supported exception: a vanilla log on an obsolete removal cell,
 * with its existing exact stone support chain anchored to a verified planned floor.
 * Unknown structure, attachment contacts, entrance columns and missing anchors refuse.
 * @param {any} group @param {ReadonlyMap<string,string>} live
 * @returns {Generator<void,{ok:boolean,reason?:string,keep:Set<string>,columns:number,expected:Map<string,string>},void>} */
export function* retainedRoofColumnsSteps(group,live) {
    const keep=new Set(),expected=new Map();let work=0,columns=0;
    const fail=(/** @type {string} */ reason)=>({ok:false,reason,keep,columns,expected});
    const e=group.element;
    if(!Array.isArray(group.original)||!Array.isArray(group.revised)||!Number.isInteger(e.baseY))return fail("missing verified roof geometry");
    const original=new Map(group.original.map((/** @type {any} */ op)=>[key(op),op]));
    const desired=new Map(group.revised.map((/** @type {any} */ op)=>[key(op),op]));
    const changes=new Map(group.changes.map((/** @type {any} */ op)=>[key(op),op]));
    for(const [k,op] of original) {
        if(++work%128===0)yield;
        if(!changes.has(k)&&live.get(k)!==op.id)return fail(`changed structure at ${k}`);
    }
    for(const [k,op] of changes) {
        if(++work%128===0)yield;
        const id=live.get(k);
        if(id===op.before||id===op.id)continue;
        if(op.id!==AIR||op.before!==STONE||op.kind!=="support"||!id||!log(id)||op.y<=e.baseY+2)
            return fail(`unsupported foreign ${id??"unreadable"} at ${k}`);
        if(roofEntranceColumn(e,op.x,op.z))return fail(`retained column blocks entrance circulation at ${k}`);
        columns++;keep.add(k);expected.set(k,id);
        for(let y=op.y-1;y>e.baseY;y--) {
            if(++work%128===0)yield;
            const p={x:op.x,y,z:op.z},at=key(p),support=changes.get(at);
            if(!support||support.before!==STONE||support.id!==AIR||support.kind!=="support"||live.get(at)!==STONE)
                return fail(`retained log lacks its existing exact stone column at ${at}`);
            keep.add(at);expected.set(at,STONE);
        }
        const floor=key({x:op.x,y:e.baseY,z:op.z}),base=original.get(floor);
        if(!base||!anchor(base.id)||desired.get(floor)?.id!==base.id||live.get(floor)!==base.id)
            return fail(`retained column lacks a verified planned floor at ${floor}`);
    }
    // Retained-column contacts cannot hide an attached/foreign block behind the exception.
    for(const k of keep) {
        const [x,y,z]=k.split(",").map(Number);
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++) {
            if(++work%128===0)yield;
            if(y+dy<e.baseY)continue;
            const at=key({x:x+dx,y:y+dy,z:z+dz}),id=live.get(at),before=original.get(at)?.id,after=desired.get(at)?.id;
            if(id===undefined)return fail(`unreadable retained-column contact at ${at}`);
            if(id!==AIR&&!keep.has(at)&&id!==before&&id!==after)return fail(`foreign retained-column contact ${id} at ${at}`);
        }
    }
    // Independent six-neighbor proof includes retained extras, never relies on them to
    // substitute for a required joist, and rejects a floating retained object.
    const final=new Map(desired);
    for(const [k,id] of expected) {const [x,y,z]=k.split(",").map(Number);final.set(k,{x,y,z,id});}
    const seen=new Set(),queue=[];
    for(const [k,op] of final) {
        if(++work%128===0)yield;
        if(op.id===AIR){final.delete(k);continue;}
        if(op.y<=e.baseY){seen.add(k);queue.push(op);}
    }
    for(let i=0;i<queue.length;i++)for(const [dx,dy,dz] of directions) {
        if(++work%128===0)yield;
        const p=queue[i],at=key({x:p.x+dx,y:p.y+dy,z:p.z+dz});
        if(final.has(at)&&!seen.has(at)){seen.add(at);queue.push(final.get(at));}
    }
    if(seen.size!==final.size)return fail("revised roof or retained column is disconnected from the planned floor");
    return {ok:true,keep,columns,expected};
}
