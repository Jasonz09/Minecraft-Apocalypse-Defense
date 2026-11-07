// Original geometry and pixel atlas. Writes only beside this file, never to active packs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
const root=dirname(fileURLToPath(import.meta.url));
const json=(path,data)=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(data,null,2)+"\n");};
export const TYPE="civ_trial:swordsman";
const bpUUID="396c29b5-e9fd-4a0b-9b3f-e36d7e796d0b",rpUUID="bb302c84-023f-43e8-bef8-87349accc27e";
json("BP/manifest.json",{format_version:2,header:{name:"CA Swordsman - Isolated Trial BP",description:"Opt-in prototype assets only; no script, spawn rules or casualty integration.",uuid:bpUUID,version:[0,1,0],min_engine_version:[1,26,20]},modules:[{type:"data",uuid:"4e585dde-8cf1-44ab-865f-36b2eb61f99d",version:[0,1,0]}],dependencies:[{uuid:rpUUID,version:[0,1,0]}]});
json("RP/manifest.json",{format_version:2,header:{name:"CA Swordsman - Isolated Trial RP",description:"Original human guard model, sword and pixel texture.",uuid:rpUUID,version:[0,1,0],min_engine_version:[1,26,20]},modules:[{type:"resources",uuid:"4ddac28a-99ea-458c-a615-fcb7bbd64386",version:[0,1,0]}]});
const friendly=["player","villager","irongolem","civ_guard"];
const targetFilter={all_of:[{test:"is_family",subject:"other",value:"zombie"},{test:"has_tag",subject:"other",value:"civbesiege:v1"},...friendly.map(value=>({test:"is_family",subject:"other",operator:"not",value}))]};
json("BP/entities/swordsman.json",{format_version:"1.26.20","minecraft:entity":{description:{identifier:TYPE,is_spawnable:false,is_summonable:true},components:{
  "minecraft:type_family":{family:["civ_guard","irongolem","mob"]},
  "minecraft:health":{value:30,max:30},"minecraft:collision_box":{width:.6,height:1.95},
  "minecraft:physics":{},"minecraft:pushable_by_entity":{},"minecraft:pushable_by_block":{},"minecraft:persistent":{},
  "minecraft:movement":{value:.23},"minecraft:movement.basic":{},"minecraft:jump.static":{},
  "minecraft:navigation.walk":{can_path_over_water:false,avoid_water:true,can_pass_doors:true,can_open_doors:false,can_break_doors:false},
  "minecraft:home":{restriction_radius:12,restriction_type:"all_movement"},
  "minecraft:attack":{damage:4},
  "minecraft:behavior.float":{priority:0},
  "minecraft:behavior.move_towards_home_restriction":{priority:1,speed_multiplier:1},
  "minecraft:behavior.nearest_attackable_target":{priority:2,must_see:true,must_reach:true,must_see_forget_duration:1,persist_time:0,scan_interval:10,within_radius:12,entity_types:[{filters:targetFilter,max_dist:10}]},
  "minecraft:behavior.melee_attack":{priority:3,speed_multiplier:1,track_target:true,require_complete_path:true,cooldown_time:1,reach_multiplier:1.5},
  "minecraft:behavior.look_at_player":{priority:5,look_distance:6,probability:.03},
  "minecraft:behavior.random_look_around":{priority:6}
}}});
// No hurt_by_target goal: accidental friendly hits must never select a friendly attacker.
json("RP/entity/swordsman.entity.json",{format_version:"1.10.0","minecraft:client_entity":{description:{identifier:TYPE,materials:{default:"entity_alphatest"},textures:{default:"textures/entity/civ_trial/swordsman"},geometry:{default:"geometry.civ_trial.swordsman"},animations:{walk:"animation.civ_trial.swordsman.walk",attack:"animation.civ_trial.swordsman.attack",look:"animation.civ_trial.swordsman.look"},scripts:{animate:["look",{walk:"query.modified_move_speed > 0.01"},{attack:"query.attack_time > 0.0"}]},render_controllers:["controller.render.civ_trial.swordsman"]}}});
json("RP/render_controllers/swordsman.render_controllers.json",{format_version:"1.8.0",render_controllers:{"controller.render.civ_trial.swordsman":{geometry:"Geometry.default",materials:[{"*":"Material.default"}],textures:["Texture.default"]}}});
json("RP/animations/swordsman.animation.json",{format_version:"1.8.0",animations:{
  "animation.civ_trial.swordsman.look":{loop:true,bones:{head:{rotation:["query.target_x_rotation","query.target_y_rotation",0]}}},
  "animation.civ_trial.swordsman.walk":{loop:true,animation_length:1,bones:{left_leg:{rotation:["math.cos(query.modified_distance_moved * 38.17) * query.modified_move_speed * 80",0,0]},right_leg:{rotation:["-math.cos(query.modified_distance_moved * 38.17) * query.modified_move_speed * 80",0,0]},left_arm:{rotation:["-math.cos(query.modified_distance_moved * 38.17) * query.modified_move_speed * 40",0,0]},right_arm:{rotation:["math.cos(query.modified_distance_moved * 38.17) * query.modified_move_speed * 25",0,0]}}},
  "animation.civ_trial.swordsman.attack":{loop:true,bones:{right_arm:{rotation:["-math.sin(query.attack_time * 180) * 90",0,"-math.sin(query.attack_time * 180) * 10"]}}}
}});
const face=(u,v,w,h)=>({uv:[u,v],uv_size:[w,h]});
const uv=(tile)=>Object.fromEntries(["north","south","east","west","up","down"].map(side=>[side,face(tile*8,0,8,8)]));
const cube=(origin,size,tile)=>({origin,size,uv:uv(tile)});
const bones=[
 {name:"body",pivot:[0,12,0],cubes:[cube([-4,12,-2],[8,10,4],1),cube([-4.25,12,-2.25],[8.5,1.5,4.5],4),cube([-3.5,16,-2.3],[7,5,.5],2)]},
 {name:"head",parent:"body",pivot:[0,22,0],cubes:[{...cube([-4,22,-4],[8,8,8],0),uv:{...uv(0),north:face(0,8,8,8)}},cube([-4.4,27,-4.4],[8.8,3.4,8.8],1),cube([-4.4,24.5,.5],[8.8,3,3.9],1)]},
 {name:"left_leg",parent:"body",pivot:[2,12,0],cubes:[cube([0,2,-2],[4,10,4],3),cube([0,0,-2.5],[4,3,4.5],4)]},
 {name:"right_leg",parent:"body",pivot:[-2,12,0],cubes:[cube([-4,2,-2],[4,10,4],3),cube([-4,0,-2.5],[4,3,4.5],4)]},
 {name:"left_arm",parent:"body",pivot:[5,21,0],cubes:[cube([4,13,-2],[3,9,4],1),cube([4,10,-2],[3,3,4],0)]},
 {name:"right_arm",parent:"body",pivot:[-5,21,0],cubes:[cube([-7,13,-2],[3,9,4],1),cube([-7,10,-2],[3,3,4],0)]},
 // Sword is fixed original geometry attached to the right hand, not a lootable item.
 {name:"sword",parent:"right_arm",pivot:[-5.5,11,-2],rotation:[-20,0,0],cubes:[cube([-6,8,-2.6],[1,3,1.2],4),cube([-8,11,-3],[5,1,1.5],5),cube([-6.2,12,-2.9],[1.4,10,.8],6),cube([-5.9,22,-2.9],[.8,1,.8],6)]}
];
json("RP/models/entity/swordsman.geo.json",{format_version:"1.12.0","minecraft:geometry":[{description:{identifier:"geometry.civ_trial.swordsman",texture_width:64,texture_height:32,visible_bounds_width:2.5,visible_bounds_height:3,visible_bounds_offset:[0,1.2,0]},bones}]});
// Deterministic 64x32 RGBA atlas: skin, steel, blue tabard, trousers, leather, brass, blade.
const colors=[[193,143,105],[128,144,155],[38,73,111],[53,61,69],[76,48,30],[178,145,67],[206,218,226],[36,28,25]];
const width=64,height=32,pixels=Buffer.alloc(width*height*4);
function pixel(x,y,color){const p=(y*width+x)*4;pixels[p]=color[0];pixels[p+1]=color[1];pixels[p+2]=color[2];pixels[p+3]=255;}
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const base=colors[Math.floor(x/8)],n=((x*17+y*11)%7)-3;pixel(x,y,base.map(c=>Math.max(0,Math.min(255,c+n))));}
// Friendly unmasked face, dark brows/hair, white eyes, neutral mouth; no copied textures.
for(let x=0;x<8;x++)pixel(x,8,colors[7]);
for(const x of [1,2,5,6])pixel(x,10,colors[7]);
pixel(2,11,[235,230,216]);pixel(5,11,[235,230,216]);pixel(2,12,[48,50,46]);pixel(5,12,[48,50,46]);
pixel(3,14,[116,68,51]);pixel(4,14,[116,68,51]);
function crc32(b){let crc=0xffffffff;for(const v of b){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
const scanlines=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)pixels.copy(scanlines,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
const texture=join(root,"RP/textures/entity/civ_trial/swordsman.png");mkdirSync(dirname(texture),{recursive:true});
writeFileSync(texture,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(scanlines)),chunk("IEND",Buffer.alloc(0))]));
console.log("Generated isolated BP/RP, original geometry and 64x32 texture; no active pack files touched.");
