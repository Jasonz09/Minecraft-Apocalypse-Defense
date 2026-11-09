/** First movement trial: one short, flat corridor, no pathfinding or resource accounting. */
export const TRAVEL_LIMITS=Object.freeze({interval:4,maxLength:24,maxReads:256,nearMaxLength:8,nearDefaultLength:4,nearFinalReads:64,speed:0.04,maxImpulse:0.3,arrival:0.15,offRoute:0.75});
/** @typedef {{x:number,y:number,z:number}} TravelPoint */
/** @typedef {{groupId:string,home:TravelPoint,farm:TravelPoint}} TravelRoute */

/** @param {string} message @returns {{route?:TravelRoute,error?:string}} */
export function parseTravelRoute(message) {
    const match=/^start district=([1-5]) group=(0|[1-9]\d{0,4}) home=(-?\d+),(-?\d+),(-?\d+) farm=(-?\d+),(-?\d+),(-?\d+)$/.exec(message.trim());
    if(!match)return {error:"Usage: civ:people travel start district=N group=G home=X,Y,Z farm=X,Y,Z (flat, straight, at most 24 blocks)."};
    const [hx,hy,hz,fx,fy,fz]=match.slice(3).map(Number);
    if(![hx,hy,hz,fx,fy,fz].every(Number.isSafeInteger)||Math.max(Math.abs(hx),Math.abs(hz),Math.abs(fx),Math.abs(fz))>29999980
        ||hy< -63||hy>318||fy!==hy||!(hx===fx||hz===fz))return {error:"The trial needs safe integer coordinates on one flat, straight corridor."};
    const length=Math.abs(hx-fx)+Math.abs(hz-fz);
    if(length<1||length>TRAVEL_LIMITS.maxLength)return {error:"The trial corridor must be 1–24 blocks long."};
    return {route:{groupId:`district-${match[1]}:civ:${match[2]}`,home:{x:hx+0.5,y:hy,z:hz+0.5},farm:{x:fx+0.5,y:fy,z:fz+0.5}}};
}

/** Read-only inspection or synchronous route discovery around an existing actor.
 * @param {string} message
 * @returns {{kind?:"inspect"|"start-near",groupId?:string,length?:number,cadence?:1,error?:string}} */
export function parseTravelNear(message) {
    const match=/^(inspect|start-near) district=([1-5]) group=(0|[1-9]\d{0,4})(?: length=([1-8]))?(?: cadence=(1))?$/.exec(message.trim());
    if(!match||(match[1]==="inspect"&&(match[4]||match[5])))return {error:"Usage: civ:people travel inspect district=N group=G | start-near district=N group=G [length=1-8]."};
    return {kind:/** @type {"inspect"|"start-near"} */(match[1]),groupId:`district-${match[2]}:civ:${match[3]}`,length:Number(match[4]??TRAVEL_LIMITS.nearDefaultLength),...(match[5]?{cadence:/** @type {1} */(1)}:{})};
}

/** Candidate geometry only. Native validation still checks every swept body cell.
 * Preserve the actor's fractional X/Z instead of steering it onto a guessed centre.
 * Short prefixes first let one bounded native cache serve the complete search.
 * @param {string} groupId @param {TravelPoint} position @param {number} length
 * @returns {{routes?:TravelRoute[],error?:string}} */
export function travelNearRoutes(groupId,position,length) {
    const y=Math.round(position.y);
    if(!/^district-[1-5]:civ:(0|[1-9]\d{0,4})$/.test(groupId)||!Number.isSafeInteger(length)||length<1||length>TRAVEL_LIMITS.nearMaxLength
        ||![position.x,position.y,position.z].every(Number.isFinite)||Math.abs(position.y-y)>0.25||y< -63||y>318
        ||Math.max(Math.abs(position.x),Math.abs(position.z))+length>29999980)
        return {error:"The existing representative needs readable, near-integer standing height and safe world coordinates."};
    /** @type {TravelRoute[]} */ const routes=[];
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(let n=1;n<=length;n++) {
        const home={x:position.x,y,z:position.z};
        routes.push({groupId,home,farm:{x:home.x+dx*n,y,z:home.z+dz*n}});
    }
    return {routes};
}

/** @param {TravelRoute} route @param {TravelPoint} p */
export function nearTravelRoute(route,p) {
    if(![p.x,p.y,p.z].every(Number.isFinite)||Math.abs(p.y-route.home.y)>0.25)return false;
    const dx=Math.max(Math.min(route.home.x,route.farm.x)-p.x,0,p.x-Math.max(route.home.x,route.farm.x));
    const dz=Math.max(Math.min(route.home.z,route.farm.z)-p.z,0,p.z-Math.max(route.home.z,route.farm.z));
    return Math.hypot(dx,dz)<=TRAVEL_LIMITS.offRoute;
}

/** Horizontal correction preserves gravity/vertical velocity; never launches or teleports.
 * @param {{x:number,z:number}} velocity @param {{x:number,z:number}} desired */
export function travelImpulse(velocity,desired) {
    const x=desired.x-velocity.x,z=desired.z-velocity.z,n=Math.hypot(x,z);
    if(![x,z,n].every(Number.isFinite))return undefined;
    const scale=n>TRAVEL_LIMITS.maxImpulse?TRAVEL_LIMITS.maxImpulse/n:1;
    return {x:x*scale,y:0,z:z*scale};
}
