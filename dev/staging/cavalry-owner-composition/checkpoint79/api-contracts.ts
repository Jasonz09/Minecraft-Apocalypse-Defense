import type {Entity,EntityRideableComponent,EntityRidingComponent,EntityDieAfterEvent,Dimension} from "@minecraft/server";
// Compile-only verification against the installed 2.7 declarations, no runtime execution.
export function nativeShapes(rideable:EntityRideableComponent,rider:Entity,riding:EntityRidingComponent,event:EntityDieAfterEvent,dimension:Dimension){
 const seated:boolean=rideable.addRider(rider);const riders:Entity[]=rideable.getRiders();const mount:Entity=riding.entityRidingOn;
 const dead:Entity=event.deadEntity;const tags:string[]=dead.getTags();const spawned:Entity=dimension.spawnEntity("civ_trial:cavalry",{x:0,y:70,z:0});
 return{seated,riders,mount,tags,spawned};
}
