import {newOps,runSync} from "./regions.js";
import {pace} from "./siteprofile.js";
// Versioned, sparse interior fixtures. A lantern's attachment is a vertical rule,
// not the generic six-neighbour connectivity used for roof structure.
const key=(/** @type {{x:number,y:number,z:number}} */ p)=>`${p.x},${p.y},${p.z}`;
const id=(/** @type {any} */ op)=>String(op?.id??"").replace(/^minecraft:/,"");
const lantern=(/** @type {any} */ op)=>id(op)==="lantern";

/** Deliberately excludes carpets, panes, stairs, slabs, doors and containers.
 * @param {any} op @param {boolean} [hanging] */
export function lanternAnchor(op,hanging=false) {
    if(!hanging&&/^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_fence$/.test(id(op)))return true;
    return /^(?:(?:stripped_)?(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(?:log|wood|planks)|(?:stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|cobblestone|mossy_cobblestone|polished_andesite|andesite|deepslate_tiles|bricks|crafting_table|bookshelf|hay_block|coal_block|barrel|furnace|blast_furnace|smoker)|(?:white|red|blue|yellow|green|black|brown|gray|light_gray|orange|pink|purple|cyan|light_blue|lime|magenta)_wool)$/.test(id(op));
}

/** @param {any} geo @param {number} x @param {number} z */
function nearDoor(geo,x,z) {
    return !geo?.door || Math.abs(x-geo.door.x)+Math.abs(z-geo.door.z)<=4;
}

/** Return the same number of fixtures, attached to exact planned solid blocks.
 * Existing valid positions win; unsupported ones move to a ceiling underside or
 * existing furniture. No new support blocks, fixtures or floor obstacles are added.
 * @param {any[]} source @param {number} baseY @param {any} geo @param {import("./regions.js").Ops} [ops]
 * @returns {Generator<void,{ops:any[],fixtures:{before:any,after:any,anchor:any}[]},void>} */
export function* anchoredInteriorLightsSteps(source,baseY,geo,ops=newOps()) {
    const at=new Map(source.map(op=>[key(op),op]));
    const lamps=[...at.values()].filter(lantern).sort((a,b)=>a.x-b.x||a.y-b.y||a.z-b.z);
    const used=new Set(lamps.map(key));
    /** @type {{before:any,after:any,anchor:any}[]} */ const fixtures=[];
    const empty=(/** @type {any} */ p)=>!used.has(key(p))&&(!at.has(key(p))||id(at.get(key(p)))==="air");
    const inside=(/** @type {any} */ p)=>p.x>geo.rect.x0&&p.x<geo.rect.x1&&p.z>geo.rect.z0&&p.z<geo.rect.z1;
    for(const before of lamps) {
        const below=at.get(key({...before,y:before.y-1})),above=at.get(key({...before,y:before.y+1}));
        let anchor,after;
        if(lanternAnchor(below)){anchor=below;after={...before,states:{hanging:false}};}
        else if(lanternAnchor(above,true)){anchor=above;after={...before,states:{hanging:true}};}
        else {
            const candidates=[];
            for(const solid of at.values()) {
                yield* pace(ops,30);
                if(!lanternAnchor(solid))continue;
                // Ceiling fixtures leave the full two-block walking volume open.
                const hanging={...before,x:solid.x,y:solid.y-1,z:solid.z,states:{hanging:true}};
                if(lanternAnchor(solid,true)&&hanging.y>=baseY+3&&inside(hanging)&&empty(hanging))candidates.push({after:hanging,anchor:solid,rank:0});
                // A table/shelf is already an obstacle. Its lantern adds no post.
                const standing={...before,x:solid.x,y:solid.y+1,z:solid.z,states:{hanging:false}};
                if(solid.y>baseY&&inside(standing)&&empty(standing)&&!nearDoor(geo,solid.x,solid.z))
                    candidates.push({after:standing,anchor:solid,rank:1});
            }
            candidates.sort((a,b)=>
                (Math.abs(a.after.x-before.x)+Math.abs(a.after.z-before.z)+Math.abs(a.after.y-before.y))-
                (Math.abs(b.after.x-before.x)+Math.abs(b.after.z-before.z)+Math.abs(b.after.y-before.y)) ||
                a.rank-b.rank ||
                a.after.x-b.after.x||a.after.y-b.after.y||a.after.z-b.after.z);
            const chosen=candidates[0];
            if(!chosen)throw new Error(`No supported interior lantern position at ${key(before)}`);
            ({anchor,after}=chosen);
            used.delete(key(before));used.add(key(after));
        }
        fixtures.push({before,after,anchor});
    }
    // Final occupancy only: moving a last-write lantern must never uncover an
    // earlier raw operation at the same coordinate.
    return {ops:[...[...at.values()].filter(op=>!lantern(op)),...fixtures.map(f=>f.after)],fixtures};
}

/** @param {any[]} source @param {number} baseY @param {any} geo */
export function anchoredInteriorLights(source,baseY,geo) {return runSync(anchoredInteriorLightsSteps(source,baseY,geo));}
