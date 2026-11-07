// Offline, journal-only geometry evidence. Never opens LevelDB or reads a live world.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createPlanStore} from '../../CivilizationApocalypse_BP/scripts/civ/planstore.js';
import {rehydrateSite,siteOpsFor,SITE_STAGES,SITE_PLAN_VERSION} from '../../CivilizationApocalypse_BP/scripts/civ/districtplan.js';
import {importSiteGround} from '../../CivilizationApocalypse_BP/scripts/civ/siteprofile.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const LIMIT={logs:16,totalBytes:64*1024*1024,recordBytes:16*1024*1024,records:20000,operations:200000,tags:20000,depth:16};
const sha=b=>createHash('sha256').update(b).digest('hex');
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?(n>>>1)^0x82f63b78:n>>>1;return n>>>0;});
function crc32c(bytes){let crc=0xffffffff;for(const b of bytes)crc=(crc>>>8)^table[(crc^b)&255];return (crc^0xffffffff)>>>0;}
const masked=crc=>((((crc>>>15)|(crc<<17))>>>0)+0xa282ead8)>>>0;

export function logicalRecords(bytes) {
    const out=[];let parts=[],size=0;
    for(let o=0;o<bytes.length;) {
        const remaining=32768-o%32768;
        if(remaining<7){if(bytes.subarray(o,Math.min(bytes.length,o+remaining)).some(b=>b!==0))throw Error('Nonzero journal trailer');o+=remaining;continue;}
        if(o+7>bytes.length)throw Error('Truncated journal header');
        const length=bytes.readUInt16LE(o+4),type=bytes[o+6];
        if(!length&&!type){if(bytes.subarray(o,Math.min(bytes.length,o+remaining)).some(b=>b!==0))throw Error('Nonzero journal padding');o+=remaining;continue;}
        if(type<1||type>4||length>remaining-7||o+7+length>bytes.length)throw Error('Invalid or truncated journal frame');
        const payload=bytes.subarray(o+7,o+7+length);
        if(masked(crc32c(Buffer.concat([Buffer.from([type]),payload])))!==bytes.readUInt32LE(o))throw Error('Journal CRC32C mismatch');
        if(type===1){if(parts.length)throw Error('Unfinished fragmented record');if(length>LIMIT.recordBytes)throw Error('Record too large');out.push(payload);}
        else if(type===2){if(parts.length)throw Error('Overlapping fragmented records');parts=[payload];size=length;}
        else {if(!parts.length)throw Error('Fragment without first record');parts.push(payload);size+=length;if(size>LIMIT.recordBytes)throw Error('Record too large');if(type===4){out.push(Buffer.concat(parts));parts=[];size=0;}}
        if(out.length>LIMIT.records)throw Error('Too many journal records');o+=7+length;
    }
    if(parts.length)throw Error('Truncated fragmented record');return out;
}
function varint(bytes,cursor) {
    let value=0;
    for(let i=0;i<5;i++){if(cursor.i>=bytes.length)throw Error('Truncated varint');const b=bytes[cursor.i++];value+=(b&127)*2**(i*7);if(!(b&128)){if(value>0xffffffff)throw Error('Oversized varint');return value;}}
    throw Error('Invalid varint');
}
function take(bytes,cursor,n){if(n<0||cursor.i+n>bytes.length)throw Error('Truncated record value');const value=bytes.subarray(cursor.i,cursor.i+n);cursor.i+=n;return value;}
export function batchOperations(record) {
    if(record.length<12)throw Error('Truncated write batch');
    const sequence=record.readBigUInt64LE(0),count=record.readUInt32LE(8),cursor={i:12},ops=[];
    if(count>LIMIT.operations)throw Error('Write batch operation limit');
    for(let i=0;i<count;i++) {
        const type=take(record,cursor,1)[0];if(type!==0&&type!==1)throw Error('Unsupported write-batch type');
        const key=take(record,cursor,varint(record,cursor));
        const value=type===1?take(record,cursor,varint(record,cursor)):null;
        ops.push({sequence:sequence+BigInt(i),key,value});
    }
    if(cursor.i!==record.length)throw Error('Trailing write-batch data');return ops;
}

// Native little-endian NBT, bounded before every read/allocation. Decode the whole
// snapshot structure, but expose only this pack's plan and kingdom properties.
export function dynamicProperties(bytes,namespace) {
    if(bytes.length>LIMIT.recordBytes)throw Error('NBT snapshot limit');let i=0,tags=0;
    const takeN=n=>{if(n<0||i+n>bytes.length)throw Error('Truncated NBT');const b=bytes.subarray(i,i+n);i+=n;return b;};
    const u8=()=>takeN(1)[0],i32=()=>takeN(4).readInt32LE(0);
    const string=()=>takeN(takeN(2).readUInt16LE(0)).toString('utf8');
    function value(type,depth) {
        if(depth>LIMIT.depth||++tags>LIMIT.tags)throw Error('NBT structure limit');
        if(type===1)return takeN(1).readInt8(0);
        if(type===2)return takeN(2).readInt16LE(0);
        if(type===3)return i32();
        if(type===4)return takeN(8).readBigInt64LE(0);
        if(type===5)return takeN(4).readFloatLE(0);
        if(type===6)return takeN(8).readDoubleLE(0);
        if(type===8)return string();
        if(type===7||type===11||type===12){const n=i32(),width=type===7?1:type===11?4:8;takeN(n*width);return null;}
        if(type===9){const subtype=u8(),n=i32();if(n<0||n>LIMIT.tags)throw Error('NBT list limit');for(let k=0;k<n;k++)value(subtype,depth+1);return null;}
        if(type===10){const out=Object.create(null);for(;;){const t=u8();if(t===0)break;const name=string();if(Object.hasOwn(out,name))throw Error('Duplicate NBT name');out[name]=value(t,depth+1);}return out;}
        throw Error('Unsupported NBT tag');
    }
    if(u8()!==10)throw Error('Expected root NBT compound');string();const root=value(10,0);
    if(i!==bytes.length)throw Error('Trailing NBT snapshot bytes');
    const own=root[namespace];if(!own||typeof own!=='object')throw Error('Pack namespace absent from journal snapshot');
    const properties=new Map();
    for(const [key,v] of Object.entries(own))if(key==='civ:kingdom'||/^civ:plan(?::site:d[1-5])?:(?:meta|[ab]:\d+)$/.test(key)){
        if(typeof v!=='string')throw Error('Non-string plan/kingdom property');properties.set(key,v);
    }
    return properties;
}

export function inspectBackup(input,{districts=[3,4],points=[[-368,-646],[-338,-650]],expected=new Map()}={}) {
    if(!districts.length||districts.length>5||districts.some(n=>!Number.isInteger(n)||n<1||n>5)||[...expected.keys()].some(n=>!districts.includes(n)))throw Error('District/expected-checksum scope mismatch');
    if(!points.length||points.length>8||points.some(p=>p.length!==2||p.some(n=>!Number.isSafeInteger(n)||Math.abs(n)>29999980)))throw Error('Point scope limit');
    const base=fs.realpathSync(path.join(ROOT,'dist/backups')),backup=fs.realpathSync(path.resolve(ROOT,input));
    if(!backup.startsWith(base+path.sep)||!fs.statSync(backup).isDirectory())throw Error('Only separately closed backups under dist/backups are accepted');
    const db=fs.realpathSync(path.join(backup,'db'));if(!db.startsWith(backup+path.sep))throw Error('Backup DB leaves its closed-backup folder');
    const logs=fs.readdirSync(db).filter(n=>/^\d+\.log$/.test(n)).sort();
    if(!logs.length||logs.length>LIMIT.logs)throw Error('Journal file count limit or no journals');
    let total=0,count=0,operations=0,latest=null;const sources=[];
    for(const name of logs) {
        const filename=fs.realpathSync(path.join(db,name));if(!filename.startsWith(db+path.sep))throw Error('Journal leaves closed-backup DB folder');
        const size=fs.statSync(filename).size;total+=size;if(total>LIMIT.totalBytes)throw Error('Journal byte limit');
        const bytes=fs.readFileSync(filename),records=logicalRecords(bytes);count+=records.length;if(count>LIMIT.records)throw Error('Journal record limit');
        sources.push({file:path.relative(ROOT,filename),bytes:size,sha256:sha(bytes),records:records.length});
        for(const record of records)for(const op of batchOperations(record)) {
            if(++operations>LIMIT.operations)throw Error('Journal operation limit');
            if(!op.key.equals(Buffer.from('DynamicProperties')))continue;
            if(latest&&op.sequence===latest.sequence&&sha(op.value??Buffer.alloc(0))!==sha(latest.value??Buffer.alloc(0)))throw Error('Conflicting journal snapshots at the same sequence');
            if(!latest||op.sequence>latest.sequence)latest={...op,file:name};
        }
    }
    if(!latest?.value)throw Error('No complete latest DynamicProperties put in visible journals (SST files are not read)');
    const namespace=JSON.parse(fs.readFileSync(path.join(ROOT,'CivilizationApocalypse_BP/manifest.json'),'utf8')).header.uuid;
    const props=dynamicProperties(latest.value,namespace),world={getDynamicProperty:key=>props.get(key),setDynamicProperty:()=>{throw Error('Inspection cannot write properties');}};
    const master=createPlanStore(world).loadPlan();if(master.status!=='ok')throw Error('Master plan journal verification failed: '+master.status+' '+(master.reason??''));
    const plan=master.plan.plan??master.plan;
    const kingdom=props.has('civ:kingdom')?JSON.parse(props.get('civ:kingdom')):null;
    const levelFile=fs.realpathSync(path.join(backup,'level.dat'));if(!levelFile.startsWith(backup+path.sep))throw Error('Level metadata leaves closed-backup folder');
    const wall7=plan.walls.find(w=>w.id==='wall-7'||w.id==='sharedwall-7');
    const result={journalOnly:true,limitation:'Visible closed-journal snapshot only; no SST/global database resolution or live block reads. Absence does not prove unbuilt.',backup:path.relative(ROOT,backup),levelDatSha256:sha(fs.readFileSync(levelFile)),sources,snapshot:{journal:latest.file,sequence:String(latest.sequence),bytes:latest.value.length,sha256:sha(latest.value),namespace,planProperties:props.size},master:{envelopeHash:master.meta.hash,seed:master.plan.seed,anchor:plan.anchor,wall7:wall7?{id:wall7.id,between:wall7.between,points:wall7.path.length,pathSha256:sha(JSON.stringify(wall7.path)),endpoints:[wall7.path[0],wall7.path.at(-1)]}:null},districts:[]};
    for(const index of districts) {
        const stored=createPlanStore(world,{prefix:`civ:plan:site:d${index}`}).loadPlan(),civ=kingdom?.districts?.find(d=>d.id===`district-${index}`)?.civ;
        const row={district:index,status:stored.status,kingdom:civ?{status:civ.status,stage:civ.stage,checksum:civ.checksum,centre:civ.centre,opsTotal:civ.opsTotal}:null};result.districts.push(row);
        if(stored.status!=='ok'){if(expected.has(index))throw Error(`D${index} requested native site is not verifiable in this journal snapshot`);row.reason=`No verified site in this journal snapshot (${stored.reason??stored.status}); native state still requires verification.`;continue;}
        const payload=stored.plan;if(payload.site?.version!==SITE_PLAN_VERSION)throw Error(`D${index} site version mismatch`);
        if(expected.has(index)&&expected.get(index)!==payload.siteChecksum)throw Error(`D${index} differs from requested native checksum`);
        if(civ&&civ.checksum!==payload.siteChecksum)throw Error(`D${index} kingdom/site checksum mismatch`);
        const rebuilt=rehydrateSite(plan,index,payload.ground,{...payload.siteOptions,expectChecksum:payload.siteChecksum});
        if(!rebuilt.ok)throw Error(`D${index} rehydration refused: ${rebuilt.problems.slice(0,3).join('; ')}`);
        const r=rebuilt.record,ground=importSiteGround(payload.ground);
        Object.assign(row,{envelopeHash:stored.meta.hash,checksum:r.checksum,options:payload.siteOptions,ops:SITE_STAGES.reduce((sum,stage)=>sum+r[stage].reduce((n,e)=>n+e.total,0),0),points:[]});
        for(const [x,z] of points) {
            const columns=[];
            for(let i=0;i<r.walls.length;i++) {
                const e=r.walls[i];if(x<e.bbox.x0||x>e.bbox.x1||z<e.bbox.z0||z>e.bbox.z1)continue;
                const cells=siteOpsFor(r,'walls',i).filter(op=>op.x===x&&op.z===z&&op.id!=='minecraft:air');
                if(!cells.length)continue;
                const topY=Math.max(...cells.map(op=>op.y));columns.push({element:e.id,index:i,hash:e.hash,minY:Math.min(...cells.map(op=>op.y)),topY,top:cells.filter(op=>op.y===topY).map(op=>({id:op.id,kind:op.kind,states:op.states}))});
            }
            row.points.push({x,z,savedGround:ground.at(x,z),plannedWallColumns:columns});
        }
    }
    return result;
}

function selfTest() {
    assert.equal(crc32c(Buffer.from('123456789')),0xe3069283);
    const vi=n=>{const out=[];do{out.push((n&127)|(n>=128?128:0));n=Math.floor(n/128);}while(n);return Buffer.from(out);};
    const str=s=>{const b=Buffer.from(s);const n=Buffer.alloc(2);n.writeUInt16LE(b.length);return Buffer.concat([n,b]);};
    const tag=(name,v)=>Buffer.concat([Buffer.from([8]),str(name),str(v)]);
    const nbt=Buffer.concat([Buffer.from([10]),str(''),Buffer.from([10]),str('fixture'),tag('civ:plan:a:0','a'.repeat(20000)),tag('civ:plan:a:1','b'.repeat(20000)),Buffer.from([0,0])]);
    const header=Buffer.alloc(12);header.writeBigUInt64LE(10n);header.writeUInt32LE(1,8);
    const key=Buffer.from('DynamicProperties'),batch=Buffer.concat([header,Buffer.from([1]),vi(key.length),key,vi(nbt.length),nbt]);
    const chunks=[];let offset=0;
    while(offset<batch.length){const n=Math.min(32761,batch.length-offset),type=offset===0?(n===batch.length?1:2):(offset+n===batch.length?4:3),p=batch.subarray(offset,offset+n),h=Buffer.alloc(7);h.writeUInt32LE(masked(crc32c(Buffer.concat([Buffer.from([type]),p]))));h.writeUInt16LE(n,4);h[6]=type;chunks.push(h,p);offset+=n;}
    const log=Buffer.concat(chunks),records=logicalRecords(log);assert.equal(records.length,1);
    const ops=batchOperations(records[0]);assert.equal(ops[0].sequence,10n);assert.equal(dynamicProperties(ops[0].value,'fixture').get('civ:plan:a:1'),'b'.repeat(20000));
    const corrupt=Buffer.from(log);corrupt[100]^=1;assert.throws(()=>logicalRecords(corrupt),/CRC32C/);assert.throws(()=>logicalRecords(log.subarray(0,log.length-1)),/truncated/i);
    console.log('PASS: CRC32C known vector, fragmented journal/write-batch/NBT round-trip, corruption and truncation refusal. No files written.');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    try {
        const args=process.argv.slice(2);if(args.length===1&&args[0]==='--self-test')selfTest();
        else {
            const input=args.shift();if(!input)throw Error('Usage: node dev/prototypes/inspect-city-geometry.mjs dist/backups/NAME [--districts=3,4] [--expect=3:CHECKSUM] [--point=X,Z]');
            const options={expected:new Map()};let explicitPoints=false;
            for(const arg of args) {
                if(/^--districts=[1-5](?:,[1-5]){0,4}$/.test(arg))options.districts=[...new Set(arg.slice(12).split(',').map(Number))];
                else if(/^--expect=[1-5]:[a-f0-9]{8}$/.test(arg)){const [n,sum]=arg.slice(9).split(':');options.expected.set(Number(n),sum);}
                else if(/^--point=-?\d+,-?\d+$/.test(arg)){if(!explicitPoints){options.points=[];explicitPoints=true;}const p=arg.slice(8).split(',').map(Number);if(p.some(n=>!Number.isSafeInteger(n)||Math.abs(n)>29999980)||options.points.length>=8)throw Error('Point limit');options.points.push(p);}
                else throw Error('Unsupported argument');
            }
            console.log(JSON.stringify(inspectBackup(input,options),null,2));
        }
    }catch(error){console.error('Geometry inspection refused: '+String(error instanceof Error?error.message:error));process.exitCode=1;}
}
