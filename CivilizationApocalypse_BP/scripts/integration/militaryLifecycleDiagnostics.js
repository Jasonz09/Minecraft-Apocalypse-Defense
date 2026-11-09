import {classifyTags,isCanonicalFor} from "../population/identity.js";
import {SWORDSMAN_TYPE,MILITARY_TYPES} from "../population/militarySelection.js";

/** Live read only. Missing/throwing fields are unknown, never replaced by spawn coordinates.
 * @param {any} handle */
export function militaryActorSnapshot(handle){
    /** @type {any} */const row={location:null,health:null};
    try{const p=handle.location;if([p.x,p.y,p.z].every(Number.isFinite))row.location={x:p.x,y:p.y,z:p.z};}catch(_error){}
    try{const h=handle.getComponent("minecraft:health")?.currentValue;if(Number.isFinite(h))row.health=h;}catch(_error){}
    return row;
}

/** Session-only, opt-in negative/positive evidence. Never an entity owner or casualty ledger.
 * @param {{readSelection:()=>any,tick:()=>number}} deps */
export function createMilitaryLifecycleDiagnostics(deps){
    let enabled=false;
    /** @type {any[]} */const events=[];
    /** @type {Map<string,any>} */const bindings=new Map();
    let lastObservation="";
    /** Hurt evidence has its own ring; combat traffic never evicts lifecycle events. @type {any[]} */const hurts=[];
    let hurtTick=/** @type {number|null} */(null),hurtUsed=0,hurtDropped=0,hurtProcessed=0,hurtHeld=0,incoming=0,outgoing=0;
    const hurtLimits={perTick:32,session:1000000,rows:16};
    const clipped=(/** @type {any} */v)=>String(v??"unknown").slice(0,160);
    function selected(){if(!enabled)return null;try{const r=deps.readSelection();return r?.status==="ok"&&MILITARY_TYPES.includes(r.selection?.typeId)?{...r.selection,stamp:r.stamp}:null;}catch(_error){return null;}}
    const tick=()=>{try{const t=deps.tick();return Number.isFinite(t)?t:null;}catch(_error){return null;}};
    /** @param {any} row */
    function append(row){events.push({tick:tick(),...row});if(events.length>16)events.shift();}
    /** All calls are informational and fail closed without propagating into ownership.
     * @param {string} groupId @param {any[]} handles */
    function observe(groupId,handles){try{
        const s=selected();if(!s||s.groupId!==groupId)return;
        if(!Array.isArray(handles)||handles.length!==1){const code=`${s.stamp}:${handles?.length??"unknown"}`;if(lastObservation!==code)append({kind:"loaded census",detail:`${handles?.length??"unknown"} matches; no unique live binding`});lastObservation=code;return;}
        const h=handles[0],tags=h.getTags();if(!Array.isArray(tags)||tags.length>64||h.isValid===false||String(h.typeId)!==s.typeId||!isCanonicalFor(classifyTags(tags).ownTags,groupId))return;
        const id=h.id;if(typeof id!=="string"||id.length===0||id.length>128)return;
        const known=bindings.get(id),row={id,stamp:s.stamp,groupId,typeId:s.typeId,...militaryActorSnapshot(h)};
        bindings.delete(id);bindings.set(id,row);while(bindings.size>4)bindings.delete(/** @type {string} */(bindings.keys().next().value));
        if(!known||known.stamp!==s.stamp)append({kind:"verified canonical binding",id,detail:groupId});
        lastObservation=`${s.stamp}:1`;
    }catch(_error){}}
    /** @param {any} action @param {any} outcome */
    function ownerOutcome(action,outcome){try{const s=selected();if(!s||action.groupId!==s.groupId)return;
        append({kind:`owner ${clipped(action.op)} ${outcome.ok?"applied":"not applied"}`,id:clipped(outcome.entityId??action.entityId),detail:clipped(outcome.reason??action.reason??"no reason supplied")});
    }catch(_error){}}
    /** @param {any} event */
    function onDie(event){try{
        const s=selected();if(!s)return;
        const h=event.deadEntity,id=String(h.id),bound=bindings.get(id);if(!bound||bound.stamp!==s.stamp||bound.groupId!==s.groupId)return;
        let identity="prior verified canonical binding; death identity unreadable";
        try{const tags=h.getTags();if(!Array.isArray(tags)||tags.length>64||String(h.typeId)!==s.typeId||!isCanonicalFor(classifyTags(tags).ownTags,s.groupId))return;identity="fresh canonical death identity verified";}catch(_error){}
        let cause="unknown",damager="unknown";try{cause=clipped(event.damageSource?.cause);}catch(_error){}try{damager=clipped(event.damageSource?.damagingEntity?.typeId);}catch(_error){}
        append({kind:"entityDie event",id,detail:`${identity}; cause=${cause}; damager=${damager}`});
    }catch(_error){}}
    /** Removal includes unloading and post-death removal; it is never a death verdict.
     * @param {any} event */
    function onRemove(event){try{const s=selected();if(!s)return;const id=String(event.removedEntityId),bound=bindings.get(id);
        if(bound?.stamp!==s.stamp||bound.groupId!==s.groupId||event.typeId!==s.typeId)return;
        append({kind:"entityRemove event",id,detail:"removed/unloaded; cause unknown (not a casualty verdict)"});
    }catch(_error){}}
    /** Read-only after-event evidence. Global callback work is capped before any
     * entity/selection reads; no target queries, timers, damage or actor writes.
     * @param {any} event */
    function onHurt(event){try{
        if(!enabled||bindings.size===0)return;
        const now=tick();if(now!==null&&now!==hurtTick){hurtTick=now;hurtUsed=0;}
        if(hurtUsed>=hurtLimits.perTick||hurtProcessed>=hurtLimits.session){hurtDropped=Math.min(1000000,hurtDropped+1);return;}
        hurtUsed++;hurtProcessed++;
        /** @type {any} */let victim,damager;
        try{victim=event.hurtEntity;}catch(_error){}
        try{damager=event.damageSource?.damagingEntity;}catch(_error){}
        let victimId="",damagerId="";
        try{victimId=String(victim?.id);}catch(_error){}
        try{damagerId=String(damager?.id);}catch(_error){}
        const a=bindings.get(victimId),b=bindings.get(damagerId);if(!a&&!b)return;
        const s=selected();if(!s)return;
        const matches=(/** @type {any} */bound)=>bound?.stamp===s.stamp&&bound.groupId===s.groupId;
        const received=matches(a),delivered=matches(b);if(!received&&!delivered)return;
        const h=received?victim:damager,id=received?victimId:damagerId;
        const keep=(/** @type {any} */row)=>{hurts.push({tick:now,...row});if(hurts.length>hurtLimits.rows)hurts.shift();};
        let verified=false;
        try{const tags=h.getTags();verified=lastObservation===`${s.stamp}:1`&&h.isValid!==false&&String(h.typeId)===s.typeId&&Array.isArray(tags)&&tags.length<=64&&isCanonicalFor(classifyTags(tags).ownTags,s.groupId);}catch(_error){}
        if(!verified){hurtHeld++;keep({id,direction:"held",detail:"prior binding only; fresh selected canonical/unique observation unavailable"});return;}
        if(received)incoming++;if(delivered)outgoing++;
        const other=received?damager:victim;
        let otherId="unknown",otherType="unknown",siege="unknown",cause="unknown",damage=/** @type {number|null} */(null);
        try{if(other){otherId=clipped(other.id);otherType=clipped(other.typeId);}}catch(_error){}
        try{const tags=other?.getTags();if(Array.isArray(tags)&&tags.length<=64)siege=tags.includes("civbesiege:v1")?"yes":"no";}catch(_error){}
        try{cause=clipped(event.damageSource?.cause);}catch(_error){}
        try{const value=event.damage;if(Number.isFinite(value)&&value>=0)damage=value;}catch(_error){}
        const snap=militaryActorSnapshot(h),p=snap.location;
        keep({id,direction:received&&delivered?"incoming+outgoing":received?"incoming":"outgoing",
            detail:`fresh canonical; damage=${damage??"unknown"}; cause=${cause}; other=${otherType} (${otherId}); siege-tag=${siege}; health=${snap.health??"unknown"}; position=${p?`${p.x},${p.y},${p.z}`:"unknown"}`});
    }catch(_error){}}
    function statusLines(){return [`Military lifecycle diagnostics: ${enabled?"on":"off"}; session-only, max16 events/4 bindings; no casualty accounting.`,
        ...(enabled?events.map(e=>`tick ${e.tick??"unknown"}: ${e.kind}${e.id?` actor ${e.id}`:""}; ${e.detail}`):[]),
        ...(enabled&&hurtProcessed>0?[`Hurt evidence (all session bindings): incoming ${incoming}, outgoing ${outgoing}, held ${hurtHeld}, budget-dropped ${hurtDropped}; cap32 callbacks/tick, 1000000/session, separate16 rows. Absence is not proof of no attack.`,
            ...hurts.map(e=>`tick ${e.tick??"unknown"}: hurt ${e.direction} actor ${e.id}; ${e.detail}`)]:[])];}
    /** @param {string} message */
    function command(message){const match=/^diagnostics(?: (on|off|status))?$/.exec(message.trim());if(!match)return["Usage: civ:people military diagnostics on|off|status"];
        if(match[1]==="on"){enabled=true;}else if(match[1]==="off"){enabled=false;events.length=0;bindings.clear();lastObservation="";hurts.length=0;hurtTick=null;hurtUsed=0;hurtDropped=0;hurtProcessed=0;hurtHeld=0;incoming=0;outgoing=0;}
        return statusLines();}
    return {observe,ownerOutcome,onDie,onRemove,onHurt,statusLines,command};
}

/** Subscription only: no world/selection/entity read during early execution.
 * @param {import("@minecraft/server").World} world
 * @param {ReturnType<typeof createMilitaryLifecycleDiagnostics>} diagnostics */
export function registerMilitaryLifecycleSignals(world,diagnostics){
    world.afterEvents.entityDie?.subscribe(event=>diagnostics.onDie(event),{entityTypes:[...MILITARY_TYPES]});
    world.afterEvents.entityRemove?.subscribe(event=>diagnostics.onRemove(event),{entityTypes:[...MILITARY_TYPES]});
    world.afterEvents.entityHurt?.subscribe(event=>diagnostics.onHurt(event));
}
