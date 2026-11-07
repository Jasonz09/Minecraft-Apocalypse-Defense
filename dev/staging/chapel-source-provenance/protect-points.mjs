import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {builder} from '../../lib/civharness.mjs';
const local=new URL('./',import.meta.url),j=JSON.parse(readFileSync(new URL('provenance.json',local),'utf8')),input=JSON.parse(readFileSync(new URL('targets-input.json',local),'utf8')),points=new Map();
for(const r of input.rows)for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){const p={x:r.position.x+x,y:r.position.y+y,z:r.position.z+z};points.set(`${p.x},${p.y},${p.z}`,p);}
const rows=[...points.values()].flatMap(point=>j.protectionAreasForActive5.filter(a=>builder.inProtectedArea([a],point.x,point.z)).map(area=>({point,label:area.label,districtIndex:area.districtIndex??null,rectangle:!area.polygon,grow:area.grow??0,actualInterior:!!area.polygon&&builder.inProtectedArea([{...area,grow:0}],point.x,point.z)})));
assert.equal(points.size,j.uniqueRelevant27Cells);writeFileSync(new URL('protected-neighborhoods.json',local),JSON.stringify({scope:'Pure actual production protection predicate on alreadyverified closed master/kingdom projection; no native reads or hydration',checkedCells:points.size,protectedCellAreaPairs:rows.length,rows},null,2));console.log(JSON.stringify({checkedCells:points.size,protectedCellAreaPairs:rows.length}));
