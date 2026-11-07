import assert from "node:assert/strict";
import test from "node:test";
import {starterArmProblems, classifyStarterKeys} from "../../CivilizationApocalypse_BP/scripts/sim/starter.js";

const ready = {
    kingdom: {districts:[{id:"district-1",civ:{status:"complete"}}]},
    planPresent:true, keysReadable:true, keys:[],
};

test("release arming preserves and refuses military trial selections and receipts", () => {
    assert.deepEqual(starterArmProblems(ready), []);
    for (const key of ["civ:military_trial", "civ:military_binding", "civ:military_inbox"]) {
        assert.match(starterArmProblems({...ready, keys:[key]}).join(" "), /military trial state remains/);
        // Even corrupt or future-version values are protected by presence. Arming
        // must not need to decode them successfully to avoid destroying evidence.
        assert.ok(!classifyStarterKeys([key]).wipe.includes(key));
    }
    assert.deepEqual(starterArmProblems({...ready, keys:["another:military_trial"]}), []);
    assert.match(starterArmProblems({...ready, keys:["civ:military_trial"], allowArmed:true}).join(" "), /no selection, binding or receipt may be discarded/);
});
