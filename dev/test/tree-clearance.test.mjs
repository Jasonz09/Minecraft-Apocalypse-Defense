import assert from "node:assert/strict";
import test from "node:test";
import { encodeTreeClearance, decodeTreeClearance } from "../../CivilizationApocalypse_BP/scripts/civ/treeclear.js";
import { createQueue, serializeQueue, parseQueue } from "../../CivilizationApocalypse_BP/scripts/civ/jobs.js";
import { CIV_LIMITS } from "../../CivilizationApocalypse_BP/scripts/civ/budget.js";

test("exact tree proof round-trips through a queue, including the full clearance cap", () => {
    const seed = {x:-274,y:72,z:-540};
    const cells = [];
    for(let x=-8;x<=8;x++) for(let y=-40;y<=40;y++) for(let z=-8;z<=8;z++) {
        if(cells.length < 4000) cells.push({x:seed.x+x,y:seed.y+y,z:seed.z+z,id:x===0&&z===0?"minecraft:jungle_log":"minecraft:jungle_leaves"});
    }
    const proof = encodeTreeClearance(seed,cells,0,3);
    const decoded = decodeTreeClearance(proof);
    const ordered = (cs) => cs.map(c=>`${c.x},${c.y},${c.z}:${c.id}`).sort();
    assert.deepEqual(ordered(decoded),ordered(cells));
    const queue = createQueue({clear:[{total:100}]});
    const original = serializeQueue(queue);
    assert.equal(serializeQueue(parseQueue(original).queue),original,"legacy bytes are unchanged");
    queue.cursor[0]=3;
    queue.treeClearance=proof;
    const text=serializeQueue(queue);
    assert.ok(Buffer.byteLength(text)<CIV_LIMITS.maxJobBytes,"a dense 4000-cell canopy fits the existing queue budget");
    const restored=parseQueue(text);
    assert.equal(restored.ok,true);
    assert.deepEqual(restored.queue.treeClearance,proof);
    assert.deepEqual(ordered(decodeTreeClearance(restored.queue.treeClearance)),ordered(cells));
});

test("malformed, oversized or retargeted pending clearances are refused", () => {
    const original=encodeTreeClearance({x:0,y:70,z:0},[{x:0,y:70,z:0,id:"minecraft:oak_log"}],0,3);
    for(const change of [p=>p.seed[0]=Infinity,p=>p.seed[1]=500,p=>p.palette[0]="minecraft:chest",p=>p.runs[0]="0.zzzz",p=>p.runs[0]="0.1,0.1",p=>p.runs[0]="0.0",p=>p.runs[0]="-1.1",p=>p.palette.push("minecraft:oak_log"),p=>p.reach=32,p=>p.reach="16"]) {
        const proof=structuredClone(original);change(proof);
        assert.equal(decodeTreeClearance(proof),undefined);
    }
    const q=createQueue({clear:[{total:10}]});q.cursor[0]=3;q.treeClearance=original;
    const text=JSON.parse(serializeQueue(q));text.tc.cursor=4;
    assert.match(parseQueue(JSON.stringify(text)).reason,/pending tree clearance/);
});

test("wider branch proofs retain exact edge cells and old pending proofs keep their original coordinates", () => {
    const legacy={seed:[0,70,0],palette:['minecraft:oak_log'],runs:['914.1'],element:0,cursor:3};
    assert.deepEqual(decodeTreeClearance(legacy),[{x:0,y:70,z:0,id:'minecraft:oak_log'}]);
    assert.deepEqual(encodeTreeClearance({x:0,y:70,z:0},decodeTreeClearance(legacy),0,3),legacy);
    const seed={x:-194,y:68,z:-146},cells=[];
    for(let x=-16;x<=16;x++)for(let y=-40;y<=40;y++)for(let z=-16;z<=16;z++){
        if(cells.length<4000)cells.push({x:seed.x+x,y:seed.y+y,z:seed.z+z,id:'minecraft:oak_leaves'});
    }
    cells[3999]={x:seed.x+16,y:seed.y+40,z:seed.z+16,id:'minecraft:oak_log'};
    const proof=encodeTreeClearance(seed,cells,0,3,16);
    assert.equal(proof.reach,16);
    const ordered=cs=>cs.map(c=>`${c.x},${c.y},${c.z}:${c.id}`).sort();
    assert.deepEqual(ordered(decodeTreeClearance(proof)),ordered(cells));
    const q=createQueue({clear:[{total:10}]});q.cursor[0]=3;q.treeClearance=proof;
    const encoded=serializeQueue(q);assert.ok(Buffer.byteLength(encoded)<CIV_LIMITS.maxJobBytes);
    const restored=parseQueue(encoded);assert.equal(restored.ok,true);
    assert.deepEqual(ordered(decodeTreeClearance(restored.queue.treeClearance)),ordered(cells));
});
