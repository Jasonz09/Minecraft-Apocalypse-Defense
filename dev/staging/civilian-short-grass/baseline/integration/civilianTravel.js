import {locationAt} from "../people/routines.js";
import {assignOccupations} from "../people/occupations.js";
import {TRAVEL_LIMITS,nearTravelRoute,parseTravelNear,parseTravelRoute,travelImpulse,travelNearRoutes} from "../people/travel.js";

// Ownership remains exclusively streets/popSync. This driver only reads an admitted
// canonical representative and applies horizontal impulses; it never creates a life.
export const TRAVEL_IDENTITY=Object.freeze({prefix:"civpop:v1:",type:"minecraft:villager_v2"});
import {isKnownTravelFooting,isTravelBodyAir} from "../people/walkSafety.js";

/** @param {{world?:any,readKingdom:()=>any,admittedGroups:()=>readonly string[],isGateOn:()=>boolean,isBusy:()=>boolean}} deps */
export function createCivilianTravel(deps) {
    const world=deps.world??runtimeWorld;
    /** @type {import("../people/travel.js").TravelRoute|undefined} */ let route;
    /** @type {string|undefined} */ let boundActorId;
    /** @type {1|4} */let correctionInterval=TRAVEL_LIMITS.interval;
    let state="off",lastTick=-TRAVEL_LIMITS.interval,impulses=0,arrivals=0,reads=0,lastDestination="";
    const pointText=(/** @type {{x:number,y:number,z:number}} */ p)=>[p.x,p.y,p.z].map(n=>Number(n.toFixed(3))).join(",");
    const statusLines=()=>[`Civilian travel trial: ${state}.`,...(route?[`Group ${route.groupId}; bound actor ${boundActorId??"unavailable"}; one representative, no extra population or production.`,`Replacement requires another explicit start/start-near setup; no automatic identity rebinding.`,`Trial endpoints ${pointText(route.home)} -> ${pointText(route.farm)} (routine labels only, not physical farming).`,`Impulses ${impulses}; arrivals ${arrivals}; last probes ${reads}/${TRAVEL_LIMITS.maxReads}.`,...(correctionInterval===1?[`Opt-in correction cadence 1 tick; braking horizon ${TRAVEL_LIMITS.interval} ticks.`]:[])]:[])];
    // Bounded observations from this SAME callback only; no native reads or movement permissions.
    /** @type {any[]} */const trace=[];
    /** @type {any} */let traceFrame;
    /** @type {any} */let traceSetup;
    let traceEpoch=0,traceLatched=false,traceStopped=false;
    /** @param {any} p */
    const tracePoint=p=>p?{x:p.x,y:p.y,z:p.z}:null;
    /** @param {string} kind @param {number} tick */
    const newTraceFrame=(kind,tick)=>({epoch:traceEpoch,kind,tick:Number.isSafeInteger(tick)&&tick>=0?tick:null,tickBasis:kind==="stop"?"last driver tick":"driver callback",actorId:boundActorId??null,state,feet:null,routine:null,destination:null,desired:null,impulse:null,velocity:"unavailable (not separately sampled)",applyReturned:false});
    /** @param {any} frame @param {boolean} [terminal] */
    function retainTrace(frame,terminal=false){
        if(!frame||frame.epoch!==traceEpoch||(!terminal&&(traceLatched||traceStopped))||(terminal&&traceStopped))return;
        frame.state=state;
        const outside=frame.state==="paused: outside flat corridor";
        const limit=outside||terminal?16:15;
        while(trace.length>=limit)trace.shift();trace.push(frame);
        if(outside)traceLatched=true;if(terminal)traceStopped=true;
    }
    function resetTrace(){trace.length=0;traceEpoch=(traceEpoch+1)%2147483647;traceLatched=false;traceStopped=false;traceSetup=route?{actorId:boundActorId??null,groupId:route.groupId,home:tracePoint(route.home),farm:tracePoint(route.farm),cadence:correctionInterval}:null;}
    /** Pure formatter: uses stored primitive data only, never census/getters/probes. */
    function traceLines(){
        const point=(/** @type {any} */p)=>p?`${p.x},${p.y??"-"},${p.z}`:"unavailable";
        return[`Travel trace: ${trace.length}/16; first-outside ${traceLatched?"latched":"not seen"}; stopped ${traceStopped?"yes":"no"}.`,
            ...(traceSetup?[`Explicit setup ${traceSetup.groupId}; bound ${traceSetup.actorId}; home ${point(traceSetup.home)}; farm ${point(traceSetup.farm)}.`]:[]),
            ...(traceSetup?.cadence===1?[`Opt-in correction cadence 1 tick; braking horizon ${TRAVEL_LIMITS.interval} ticks.`]:[]),
            ...trace.map(row=>`${row.kind} tick ${row.tick??"unknown"} (${row.tickBasis}): ${row.state}; actor ${row.actorId??"unavailable"}; feet ${point(row.feet)}; routine ${row.routine??"not reached"}; destination ${point(row.destination)}; desired ${point(row.desired)}; impulse ${point(row.impulse)}; apply returned ${row.applyReturned?"yes":"no"}; ${typeof row.velocity==="string"?"velocity "+row.velocity:`pre-impulse horizontal velocity from existing read x=${row.velocity.x}, z=${row.velocity.z}; y=not sampled`}.`),
            "Observed control intent/corrections only; no AI cause, arrival, production or navigation authority inferred. Trace retained after stop; successful explicit setup/session resets it."];
    }
    /** An ambiguous duplicate is reconciler work, never permission to move both.
     * @param {{groupId:string}} wanted */
    function actor(wanted) {
        if(!deps.admittedGroups().includes(wanted.groupId))return undefined;
        const dimension=world.getDimension("overworld"),tag=TRAVEL_IDENTITY.prefix+wanted.groupId;
        const found=dimension.getEntities({type:TRAVEL_IDENTITY.type,tags:[tag]});
        if(found.length!==1)return undefined;
        const entity=found[0],own=entity.getTags().filter((/** @type {string} */ t)=>t.startsWith("civpop:"));
        if(entity.isValid===false||entity.typeId!==TRAVEL_IDENTITY.type||entity.dimension?.id!==dimension.id||own.length!==1||own[0]!==tag)return undefined;
        return {entity,dimension};
    }
    /** Full swept corridor, including the actor's lateral drift, is freshly checked.
     * Only known footing and two empty body cells are accepted; no loading requests.
     * @param {any} dimension @param {import("../people/travel.js").TravelRoute} wanted @param {{x:number,y:number,z:number}} position
     * @param {boolean} [reset] @param {Map<string,string|undefined>} [cache] @param {number} [limit] */
    function corridor(dimension,wanted,position,reset=true,cache=undefined,limit=TRAVEL_LIMITS.maxReads) {
        if(reset)reads=0;
        const x0=Math.floor(Math.min(wanted.home.x,wanted.farm.x,position.x)-0.35),x1=Math.floor(Math.max(wanted.home.x,wanted.farm.x,position.x)+0.35);
        const z0=Math.floor(Math.min(wanted.home.z,wanted.farm.z,position.z)-0.35),z1=Math.floor(Math.max(wanted.home.z,wanted.farm.z,position.z)+0.35);
        const y=wanted.home.y;
        for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)for(let dy=-1;dy<=1;dy++) {
            const at=[x,y+dy,z].join(",");let id;
            if(cache?.has(at))id=cache.get(at);
            else {
                if(reads>=limit)return "probe budget exhausted";
                reads++;
                let block;try{block=dimension.getBlock({x,y:y+dy,z});}catch(_error){return `corridor unloaded at ${at}`;}
                id=block&&block.isValid!==false?block.typeId:undefined;cache?.set(at,id);
            }
            if(id===undefined)return `corridor unloaded at ${at}`;
            if(dy===-1?!isKnownTravelFooting(id):!isTravelBodyAir(id))return `corridor obstructed or unsafe at ${at} (${id}; ${dy===-1?"footing":"body clearance"})`;
        }
        return undefined;
    }
    /** @param {any} entity @returns {string|undefined} */
    function actorId(entity){const id=entity?.id;return typeof id==="string"&&id.length>0&&id.length<=128?id:undefined;}
    /** @param {any} a @param {any} b */
    const sameFeet=(a,b)=>a&&b&&[a.x,a.y,a.z,b.x,b.y,b.z].every(Number.isFinite)&&Math.abs(a.x-b.x)<=0.000001&&Math.abs(a.y-b.y)<=0.000001&&Math.abs(a.z-b.z)<=0.000001;
    /** The velocity/method getters happen BEFORE the final identity/feet guard.
     * No block is read here; the caller's freshly probed position must still match.
     * @param {{entity:any,dimension:any}} a @param {import("../people/travel.js").TravelRoute} wanted @param {{x:number,y:number,z:number}} position @param {{x:number,z:number}} desired */
    function steer(a,wanted,position,desired) {
        const expectedId=boundActorId;
        if(route!==wanted||!expectedId||actorId(a.entity)!==expectedId)throw new Error("bound representative changed; explicit setup required");
        const apply=a.entity.applyImpulse.bind(a.entity),observedVelocity=a.entity.getVelocity();
        // Let the unchanged helper perform each native axis read AND coercion in its original order.
        // Local accessors cache only that same read; no Proxy, repeated axis read or Y sample.
        /** @type {any} */let velocityX,velocityZ;
        const velocity={get x(){return velocityX=observedVelocity.x;},get z(){return velocityZ=observedVelocity.z;}},impulse=travelImpulse(velocity,desired);
        if(traceFrame){traceFrame.desired={x:desired.x,z:desired.z};traceFrame.impulse=tracePoint(impulse);if(Number.isFinite(velocityX)&&Number.isFinite(velocityZ))traceFrame.velocity={x:velocityX,z:velocityZ};}
        if(!impulse)throw new Error("unreadable velocity");
        if(route!==wanted||boundActorId!==expectedId||!deps.isGateOn()||deps.isBusy())throw new Error("travel binding, gate or maintenance changed before impulse");
        const final=actor(wanted);
        if(!final||actorId(final.entity)!==expectedId)throw new Error("bound representative unavailable, unadmitted, ambiguous or changed; explicit setup required for replacement");
        const feet={...final.entity.location};
        if(route!==wanted||boundActorId!==expectedId)throw new Error("travel binding changed during final identity proof");
        if(!sameFeet(feet,position)||!nearTravelRoute(wanted,feet))throw new Error("bound representative feet changed after corridor/velocity read");
        if(!deps.isGateOn()||deps.isBusy()||route!==wanted||boundActorId!==expectedId)throw new Error("travel gate, maintenance or binding changed at final impulse barrier");
        if(Math.hypot(impulse.x,impulse.z)>0.0001){apply(impulse);if(traceFrame)traceFrame.applyReturned=true;impulses++;}
    }
    /** A remote unloaded cell must not prevent braking a still-loaded actor.
     * @param {{entity:any,dimension:any}} a @param {import("../people/travel.js").TravelRoute} wanted @param {boolean} [reset] */
    function brakeLocal(a,wanted,reset=false) {
        if(!boundActorId||actorId(a.entity)!==boundActorId)return;
        const p={...a.entity.location};
        if(traceFrame&&traceFrame.feet===null)traceFrame.feet=tracePoint(p);
        const point={x:p.x,y:wanted.home.y,z:p.z};
        if(!corridor(a.dimension,{...wanted,home:point,farm:point},p,reset))steer(a,wanted,p,{x:0,z:0});
    }
    function stop(reset=true) {
        // Observations retain existing stop behavior, including no permission bypass for braking.
        const previousFrame=traceFrame,stopFrame=route&&!traceStopped?newTraceFrame("stop",lastTick):undefined;
        traceFrame=stopFrame;
        try{if(route){const a=actor(route);if(a&&actorId(a.entity)===boundActorId&&nearTravelRoute(route,a.entity.location))brakeLocal(a,route,reset);}}catch(_error){}
        route=undefined;boundActorId=undefined;state="off";lastDestination="";
        retainTrace(stopFrame,true);traceFrame=previousFrame;correctionInterval=TRAVEL_LIMITS.interval;
    }
    /** @param {string} message */
    function command(message) {
        const text=message.trim();
        if(text==="trace")return traceLines();
        if(text==="stop"){stop();return statusLines();}
        if(text==="status"||text==="")return [...statusLines(),...(route?inspect(route.groupId):[]),`Admitted group intents (not a fresh loaded-actor census): ${deps.admittedGroups().filter(id=>/^district-[1-5]:civ:\d+$/.test(id)).slice(0,8).join(", ")||"none"}.`,`Session-only; rejoin starts off. Use civ:people travel stop to cancel.`];
        const near=/^(?:inspect|start-near)(?:\s|$)/.test(text)?parseTravelNear(text):undefined;
        if(near?.error)return [near.error];
        const selectedCadence=near?.cadence===1?1:TRAVEL_LIMITS.interval;
        if(near?.kind==="inspect"&&near.groupId)return inspect(near.groupId);
        const parsed=near?undefined:parseTravelRoute(text);
        if(!near&&!parsed?.route)return [parsed?.error??"Invalid travel route."];
        if(!deps.isGateOn())return ["Travel needs the existing people gate on; no entities were created."];
        if(deps.isBusy())return ["Travel cannot start during construction or maintenance."];
        let selected=parsed?.route;
        /** @type {string|undefined} */ let selectedId;
        try{const groupId=near?.groupId??selected?.groupId;
            if(!groupId)return ["Invalid travel group."];
            const a=actor({groupId});if(!a)return ["That group has no unique admitted civilian representative; wait for streets reconciliation."];
            if(near) {
                const position={...a.entity.location},candidates=travelNearRoutes(groupId,position,near.length??TRAVEL_LIMITS.nearDefaultLength);
                if(!candidates.routes)return [candidates.error??"No safe nearby trial geometry."];
                reads=0;const cache=new Map(),searchLimit=TRAVEL_LIMITS.maxReads-TRAVEL_LIMITS.nearFinalReads;
                let blockedDirection="",lastReason="no safe corridor";
                for(const candidate of candidates.routes) {
                    const dx=Math.sign(candidate.farm.x-candidate.home.x),dz=Math.sign(candidate.farm.z-candidate.home.z),direction=[dx,dz].join(",");
                    if(direction===blockedDirection)continue;
                    const reason=corridor(a.dimension,candidate,position,false,cache,searchLimit);
                    if(reason){lastReason=reason;blockedDirection=direction;if(reason==="probe budget exhausted")break;continue;}
                    const length=Math.abs(candidate.farm.x-candidate.home.x)+Math.abs(candidate.farm.z-candidate.home.z);
                    const best=selected?Math.abs(selected.farm.x-selected.home.x)+Math.abs(selected.farm.z-selected.home.z):0;
                    if(length>best)selected=candidate;
                    if(length===(near.length??TRAVEL_LIMITS.nearDefaultLength))break;
                }
                if(!selected)return [`Travel refused: ${lastReason}; no safe 1-${near.length??TRAVEL_LIMITS.nearDefaultLength} block trial corridor; nothing moved.`];
            }
            if(!selected)return ["No trial corridor selected."];
            // Re-read identity and feet after discovery, then repeat all native
            // probes without the search cache. Nothing is moved during setup.
            const fresh=actor({groupId});
            if(!fresh||fresh.entity.id!==a.entity.id)return ["The representative changed during inspection; nothing moved."];
            const position={...fresh.entity.location};
            if(!nearTravelRoute(selected,position))return ["The representative is outside this short flat corridor; nothing moved."];
            const reason=corridor(fresh.dimension,selected,position,!near);if(reason)return [`Travel refused: ${reason}; nothing moved.`];
            const final=actor({groupId}),feet=final?.entity.location;
            if(!final||final.entity.id!==fresh.entity.id||!feet||Math.abs(feet.x-position.x)>0.000001||Math.abs(feet.y-position.y)>0.000001||Math.abs(feet.z-position.z)>0.000001)
                return ["The representative changed while probing the corridor; nothing moved."];
            if(!deps.isGateOn()||deps.isBusy())return ["Travel setup was interrupted; nothing moved."];
            selectedId=actorId(final.entity);if(!selectedId)return ["The representative ID is unreadable; nothing moved."];
        }catch(_error){return ["Travel could not safely read this representative; nothing moved."];}
        if(route&&boundActorId===selectedId&&JSON.stringify(route)===JSON.stringify(selected)){correctionInterval=selectedCadence;resetTrace();return statusLines();}
        stop(false);route=selected;boundActorId=selectedId;correctionInterval=selectedCadence;state="ready";lastTick=-TRAVEL_LIMITS.interval;lastDestination="";resetTrace();return statusLines();
    }
    /** Read-only; neither block probes nor steering are needed to locate a unique actor.
     * @param {string} groupId */
    function inspect(groupId) {
        try {
            const a=actor({groupId});if(!a)return [`Group ${groupId}: no unique admitted civilian representative.`];
            const p=a.entity.location;if(![p.x,p.y,p.z].every(Number.isFinite))return [`Group ${groupId}: actor position unreadable.`];
            return [`Group ${groupId}; actor ${a.entity.id}; feet ${pointText(p)}.`,`Read-only inspection; no representative moved.`];
        }catch(_error){return [`Group ${groupId}: actor position unreadable.`];}
    }
    /** @param {number} tick */
    function onTick(tick) {
        if(!route||!Number.isSafeInteger(tick)||tick-lastTick<correctionInterval)return;
        lastTick=tick;
        const previousFrame=traceFrame,observation=traceLatched||traceStopped?undefined:newTraceFrame("tick",tick);traceFrame=observation;
        try {
            if(!deps.isGateOn()){stop();return;}
            if(deps.isBusy()){stop();state="off (construction or maintenance)";return;}
            const kingdom=deps.readKingdom(),district=kingdom?.districts?.find((/** @type {any} */ d)=>d.id===route?.groupId.split(":")[0]);
            const a=actor(route);if(!a){state="paused: bound representative unavailable, unadmitted or ambiguous";return;}
            if(!boundActorId||actorId(a.entity)!==boundActorId){state="paused: bound representative changed; explicit setup required";return;}
            const position={...a.entity.location};
            if(traceFrame)traceFrame.feet=tracePoint(position);
            if(!nearTravelRoute(route,position)){state="paused: outside flat corridor";return;}
            const unsafe=corridor(a.dimension,route,position);
            if(unsafe){state=`paused: ${unsafe}`;brakeLocal(a,route);return;}
            if(!district||district.civ?.status!=="complete"||!(assignOccupations(district,{withRoster:false}).roles.farmer>0)) {state="paused: no completed farming district";steer(a,route,position,{x:0,z:0});return;}
            const intent=locationAt({step:kingdom.step,role:"farmer",security:district.security});
            if(traceFrame)traceFrame.routine=intent.location;
            if(intent.location!=="farm"&&intent.location!=="home"){state=`paused: routine ${intent.location??"inactive"}`;steer(a,route,position,{x:0,z:0});return;}
            const destination=route[intent.location],dx=destination.x-position.x,dz=destination.z-position.z,distance=Math.hypot(dx,dz);
            if(traceFrame)traceFrame.destination=tracePoint(destination);
            if(distance<=TRAVEL_LIMITS.arrival){steer(a,route,position,{x:0,z:0});if(lastDestination!==intent.location)arrivals++;lastDestination=intent.location;state=`at ${intent.location}`;return;}
            lastDestination="";state=`traveling to ${intent.location}`;
            const speed=Math.min(TRAVEL_LIMITS.speed,distance/TRAVEL_LIMITS.interval);
            steer(a,route,position,{x:dx/distance*speed,z:dz/distance*speed});
        }catch(error){state=route?"paused: "+String(error instanceof Error?error.message:"entity or world became unreadable"):"off";}
        finally{retainTrace(observation);traceFrame=previousFrame;}
    }
    return {command,onTick,stop,statusLines,isActive:()=>route!==undefined};
}
import {world as runtimeWorld} from "@minecraft/server";
