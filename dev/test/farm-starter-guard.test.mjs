import assert from "node:assert/strict";
import test from "node:test";
import {starterArmProblems,classifyStarterKeys} from "../../CivilizationApocalypse_BP/scripts/sim/starter.js";

const ready={kingdom:{districts:[{id:"district-1",civ:{status:"complete"}}]},planPresent:true,keysReadable:true,keys:[]};

test("farm fixture journals survive arming and need an explicit complete validation report",()=>{
    const keys=["civ:farm_lights:1","civ:farm_lights:5"];
    assert.deepEqual(classifyStarterKeys(keys),{keep:keys,wipe:[],unknown:[]});
    assert.match(starterArmProblems({...ready,keys}).join(" "),/farm lighting must finish/);
    assert.match(starterArmProblems({...ready,keys,farmLighting:{ready:false,reasons:["pending fixture removal"]}}).join(" "),/pending fixture removal/);
    assert.deepEqual(starterArmProblems({...ready,keys,farmLighting:{ready:true,reasons:[]}}),[]);
    assert.match(starterArmProblems({...ready,keys,farmLighting:{ready:false},allowArmed:true}).join(" "),/before arming or export/);
    assert.deepEqual(starterArmProblems({...ready,keys:["another:farm_lights:1"]}),[]);
});
