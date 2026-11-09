import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(n => Number.isInteger(n) && n >= 0);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export const REQUIRED_ENTITY_IDS=Object.freeze(["civ_trial:swordsman","civ_trial:archer","civ_trial:guard_arrow","civ_trial:cavalry","civ_trial:cavalry_mount"]);
const jsonFiles = (dir) => !existsSync(dir) ? [] : readdirSync(dir,{withFileTypes:true}).flatMap(e =>
    e.isDirectory() ? jsonFiles(join(dir,e.name)) : e.name.endsWith(".json") ? [join(dir,e.name)] : []);

/** Validate the actual BP/RP graph and referenced custom rendering assets, not a native parser. */
export function contentPackProblems(packs,{requiredEntities=REQUIRED_ENTITY_IDS,readFile=readFileSync,listJson=jsonFiles,fileExists=existsSync}={}) {
    const problems=[], loaded=[], identifiers=new Set();
    const read=(file)=>{try{return JSON.parse(readFile(file,"utf8"));}catch(error){problems.push(`unreadable content JSON ${file}: ${String(error)}`);return {};}};
    for(const pack of packs) {
        const manifest=read(join(pack.root,"manifest.json"));
        loaded.push({...pack,manifest});
        if(manifest.format_version!==2)problems.push(`content pack ${pack.root} requires manifest format_version 2`);
        for(const entry of [manifest.header,...(manifest.modules??[])]) {
            if(!uuid.test(entry?.uuid??""))problems.push(`invalid content pack UUID in ${pack.root}`);
            else if(identifiers.has(entry.uuid))problems.push(`duplicate content pack UUID ${entry.uuid}`);
            identifiers.add(entry?.uuid);
            if(!triple(entry?.version))problems.push(`invalid content pack version in ${pack.root}`);
        }
        if(!triple(manifest.header?.min_engine_version))problems.push(`missing content pack engine version in ${pack.root}`);
        const types=(manifest.modules??[]).map(m=>m.type);
        if(pack.kind==="resource_packs" && (types.length!==1||types[0]!=="resources"))problems.push(`resource pack ${pack.root} requires one resources module`);
        if(pack.kind==="behavior_packs" && listJson(join(pack.root,"entities")).length && !types.includes("data"))problems.push(`entity behavior pack ${pack.root} requires a data module`);
    }
    for(const pack of loaded)for(const dependency of pack.manifest.dependencies??[])if(dependency.uuid) {
        const matches=loaded.filter(p=>p.manifest.header?.uuid===dependency.uuid);
        if(matches.length!==1)problems.push(`missing or ambiguous content dependency ${dependency.uuid} required by ${pack.root}`);
        else if(!same(matches[0].manifest.header.version,dependency.version))problems.push(`content dependency version mismatch ${dependency.uuid}`);
    }
    const clients=new Map(), geometries=new Map(), animations=new Map(), controllers=new Map();
    for(const pack of loaded.filter(p=>p.kind==="resource_packs")) {
        for(const file of listJson(join(pack.root,"models","entity")))for(const geometry of read(file)["minecraft:geometry"]??[]) {
            const id=geometry.description?.identifier;
            if(geometries.has(id))problems.push(`duplicate geometry ${id}`);
            geometries.set(id,geometry);
        }
        for(const file of listJson(join(pack.root,"animations")))for(const [id,animation] of Object.entries(read(file).animations??{}))animations.set(id,animation);
        for(const file of listJson(join(pack.root,"render_controllers")))for(const [id,controller] of Object.entries(read(file).render_controllers??{}))controllers.set(id,controller);
        for(const file of listJson(join(pack.root,"entity"))) {
            const description=read(file)["minecraft:client_entity"]?.description;
            if(!description?.identifier){problems.push(`missing client entity identifier ${file}`);continue;}
            if(clients.has(description.identifier))problems.push(`duplicate client entity ${description.identifier}`);
            clients.set(description.identifier,{description,root:pack.root});
        }
    }
    for(const {description:d,root} of clients.values()) {
        // Reviewed vanilla arrow references are implicit engine assets, not custom
        // files. This exact profile cannot make any other missing asset benign.
        const builtinArrow=d.identifier==="civ_trial:guard_arrow"
            &&same(d.materials,{default:"arrow"})&&same(d.geometry,{default:"geometry.arrow"})
            &&same(d.textures,{default:"textures/entity/arrows"})&&same(d.animations,{move:"animation.arrow.move"})
            &&same(d.render_controllers,["controller.render.arrow"]);
        // Reviewed official legacy horse texture only for this exact custom client
        // profile. Its geometry/controller remain mandatory owned local assets.
        const builtinMount=d.identifier==="civ_trial:cavalry_mount"
            &&same(Object.keys(d).sort(),["identifier","materials","textures","geometry","render_controllers"].sort())
            &&same(d.materials,{default:"entity_alphatest"})
            &&same(d.geometry,{default:"geometry.civ_trial.cavalry_mount"})
            &&same(d.textures,{default:"textures/entity/horse/horse_brown"})
            &&same(d.render_controllers,["controller.render.civ_trial.swordsman"]);
        const bones=new Set();
        for(const id of Object.values(d.geometry??{})) {
            if(builtinArrow&&id==="geometry.arrow")continue;
            if(!geometries.has(id))problems.push(`missing geometry ${id} for ${d.identifier}`);
            else for(const bone of geometries.get(id).bones??[])bones.add(bone.name);
        }
        for(const path of Object.values(d.textures??{})) {
            if(builtinArrow&&path==="textures/entity/arrows")continue;
            if(typeof path!=="string"||!/^textures\/[A-Za-z0-9_/-]+$/.test(path)){problems.push(`unsafe texture reference for ${d.identifier}`);continue;}
            const file=join(root,`${path}.png`);
            if(!fileExists(file)){if(builtinMount&&path==="textures/entity/horse/horse_brown")continue;problems.push(`missing texture ${path} for ${d.identifier}`);continue;}
            const png=readFile(file);
            if(png.length<24||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))problems.push(`invalid PNG texture ${path}`);
        }
        for(const id of Object.values(d.animations??{})) {
            if(builtinArrow&&id==="animation.arrow.move")continue;
            if(!animations.has(id))problems.push(`missing animation ${id} for ${d.identifier}`);
            else for(const bone of Object.keys(animations.get(id).bones??{}))if(!bones.has(bone))problems.push(`unknown animation bone ${bone} for ${d.identifier}`);
        }
        for(const id of d.render_controllers??[]) {
            if(builtinArrow&&id==="controller.render.arrow")continue;
            if(!controllers.has(id)){problems.push(`missing render controller ${id} for ${d.identifier}`);continue;}
            const controller=controllers.get(id);
            for(const [field,table,expressions] of [["geometry",d.geometry,[controller.geometry]],["texture",d.textures,controller.textures??[]],["material",d.materials,(controller.materials??[]).flatMap(m=>Object.values(m))]])
                for(const expression of expressions)if(typeof expression==="string") {
                    const match=/^(Geometry|Texture|Material)\.([A-Za-z0-9_]+)$/i.exec(expression);
                    if(match&&!Object.hasOwn(table??{},match[2]))problems.push(`missing render ${field} alias ${match[2]} for ${d.identifier}`);
                }
        }
        const aliases=new Set(Object.keys(d.animations??{}));
        for(const entry of d.scripts?.animate??[])for(const alias of typeof entry==="string"?[entry]:Object.keys(entry))if(!aliases.has(alias))problems.push(`unknown animation alias ${alias} for ${d.identifier}`);
    }
    const behaviors=new Set(),shooters=[];
    for(const pack of loaded.filter(p=>p.kind==="behavior_packs"))for(const file of listJson(join(pack.root,"entities"))) {
        const definition=read(file)["minecraft:entity"],id=definition?.description?.identifier;
        for(const components of [definition?.components,...Object.values(definition?.component_groups??{})]){
            const shooter=components?.["minecraft:shooter"];
            if(shooter!==undefined)shooters.push({id,def:shooter?.def});
        }
        if(!id)problems.push(`missing behavior entity identifier ${file}`);
        else if(!clients.has(id))problems.push(`missing client entity for ${id}`);
        else {
            const resource=loaded.find(p=>p.root===clients.get(id).root);
            const dependency=pack.manifest.dependencies?.find(d=>d.uuid===resource.manifest.header?.uuid);
            if(!dependency)problems.push(`behavior entity ${id} requires an explicit resource-pack dependency`);
        }
        if(behaviors.has(id))problems.push(`duplicate behavior entity ${id}`);
        behaviors.add(id);
    }
    for(const {id,def}of shooters)if(typeof def!=="string"||!def||(!def.startsWith("minecraft:")&&!behaviors.has(def)))problems.push(`missing custom projectile ${String(def)} for ${String(id)}`);
    for(const id of requiredEntities)if(!behaviors.has(id)||!clients.has(id))problems.push(`required entity pair is missing: ${id}`);
    return problems;
}

/** Build both world binding lists from shipped manifests, never stale source-world bindings. */
export function packBindings(packs, kind, {readFile=readFileSync}={}) {
    return packs.filter(p=>p.kind===kind).map(p=>{
        const m=JSON.parse(readFile(join(p.root,"manifest.json"),"utf8"));
        return {pack_id:m.header.uuid,version:m.header.version};
    });
}

export function packBindingProblems(entries,wanted,label) {
    const problems=[];
    if(!Array.isArray(entries))return [`${label} must contain a binding array`];
    for(const pack of wanted) {
        const matches=entries.filter(e=>(e?.pack_id??e?.uuid)===pack.pack_id);
        if(matches.length!==1)problems.push(`${label} must bind shipped pack ${pack.pack_id} exactly once`);
        else if(!same(matches[0].version??matches[0].pack_version,pack.version))problems.push(`${label} version mismatch for ${pack.pack_id}`);
    }
    for(const entry of entries)if(!wanted.some(p=>p.pack_id===(entry?.pack_id??entry?.uuid)))problems.push(`${label} binds pack ${entry?.pack_id??entry?.uuid}, which is not shipped in this package`);
    return problems;
}
