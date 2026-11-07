// Proposed v2 provenance projection. No world access or mutation.
const TOKENS=new WeakMap();
const fail=message=>{throw new Error(message);};
const clone=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
const integer=n=>Number.isSafeInteger(n)&&Math.abs(n)<=29999980;
function outline(poly){
    if(!Array.isArray(poly)||poly.length<3||poly.length>256||poly.some(p=>!Array.isArray(p)||p.length!==2||!p.every(integer)))fail('invalid bounded polygon provenance');
    const xs=poly.map(p=>p[0]),zs=poly.map(p=>p[1]);
    // Bound all squared/cross arithmetic well below Number.MAX_SAFE_INTEGER.
    if(Math.max(...xs)-Math.min(...xs)>4096||Math.max(...zs)-Math.min(...zs)>4096)fail('oversized polygon provenance');
    if(new Set(poly.map(p=>p.join(','))).size!==poly.length)fail('repeated polygon vertex');
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const on=(a,b,p)=>cross(a,b,p)===0&&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])&&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1]);
    for(let i=0;i<poly.length;i++)for(let j=i+1;j<poly.length;j++){
        if(j===i+1||(i===0&&j===poly.length-1))continue;
        const a=poly[i],b=poly[(i+1)%poly.length],c=poly[j],d=poly[(j+1)%poly.length];
        const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
        if(on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)||(Math.sign(abC)!==Math.sign(abD)&&Math.sign(cdA)!==Math.sign(cdB)))fail('self-intersecting polygon provenance');
    }
    if(poly.reduce((sum,p,i)=>sum+cross(poly[0],p,poly[(i+1)%poly.length]),0)===0)fail('zero-area polygon provenance');
    return poly;
}
function edgeDistance(poly,x,z){
    let min=Infinity;
    for(let i=0;i<poly.length;i++){
        const a=poly[i],b=poly[(i+1)%poly.length],dx=b[0]-a[0],dz=b[1]-a[1];
        const length=dx*dx+dz*dz;
        if(!length)fail('degenerate polygon edge');
        const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/length));
        min=Math.min(min,Math.max(Math.abs(x-(a[0]+t*dx)),Math.abs(z-(a[1]+t*dz))));
    }
    return min;
}
function inside(poly,x,z){let result=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[i],b=poly[j];
    if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])result=!result;
}return result;}
function rect(area,x,z){return x>=area.x0&&x<=area.x1&&z>=area.z0&&z<=area.z1;}
/** Caller supplies actual protectedRects, verified records and the selected index.
 * Every polygon must exactly match a verified neighbor outline + grow4 bbox.
 * Rectangles remain opaque, never granted a margin exception.
 */
export function createMarginProtection(areas,sources,index){
    if(!Array.isArray(areas)||areas.length>128||!Array.isArray(sources)||sources.length!==5||!Number.isInteger(index)||index<1||index>5)fail('all five protection sources required');
    const records=new Map();for(const source of sources){const r=source.record;
        if(!r||records.has(r.districtIndex)||r.districtIndex<1||r.districtIndex>5||source.civ?.status!=='complete'||source.civ.checksum!==r.checksum||source.civ.dimension!=='minecraft:overworld')fail('invalid completed protection source');
        records.set(r.districtIndex,r);outline(r.outline);
    }
    if([1,2,3,4,5].some(n=>!records.has(n)))fail('missing protection source');
    const seen=new Set(),projected=areas.map(area=>{
        if(!area||![area.x0,area.z0,area.x1,area.z1].every(integer)||area.x0>area.x1||area.z0>area.z1)fail('unreadable protection rectangle');
        if(area.polygon===undefined)return {kind:'opaque',x0:area.x0,z0:area.z0,x1:area.x1,z1:area.z1};
        const n=area.districtIndex,r=records.get(n),poly=outline(area.polygon);
        if(n===index||!r||seen.has(n)||area.grow!==4||JSON.stringify(poly)!==JSON.stringify(r.outline))fail('unknown or duplicate city polygon provenance');
        const xs=poly.map(p=>p[0]),zs=poly.map(p=>p[1]);
        if(area.x0!==Math.min(...xs)-4||area.x1!==Math.max(...xs)+4||area.z0!==Math.min(...zs)-4||area.z1!==Math.max(...zs)+4)fail('city protection bbox differs');
        seen.add(n);return {kind:'city',districtIndex:n,grow:4,x0:area.x0,z0:area.z0,x1:area.x1,z1:area.z1,polygon:clone(poly)};
    });
    if([1,2,3,4,5].some(n=>n!==index&&!seen.has(n)))fail('protecting neighbor polygon missing');
    const value=freeze({policy:'wall-leaves-margin-v2',index,hardMargin:1,sources:sources.map(s=>({index:s.record.districtIndex,checksum:s.record.checksum})).sort((a,b)=>a.index-b.index),areas:projected});
    TOKENS.set(value,JSON.stringify(value));return value;
}
export function protectionStamp(value){const stamp=TOKENS.get(value);if(!stamp)fail('unverified margin protection token');return stamp;}
/** This is classification, not a native-read/write permission. All claims win.
 * hard/unknown blocks both target and benign contacts; outside every grow4 is
 * classified plain so v2 does not silently replace v1 on ordinary targets.
 */
export function classifyMarginColumn(value,x,z){
    protectionStamp(value);if(!integer(x)||!integer(z))return 'blocked';let margin=false;
    for(const area of value.areas){
        if(!rect(area,x,z))continue;
        if(area.kind==='opaque')return 'blocked';
        const distance=edgeDistance(area.polygon,x,z);
        if(inside(area.polygon,x,z)||distance<=1)return 'blocked';
        if(distance<=4)margin=true;
    }
    return margin?'margin':'plain';
}
