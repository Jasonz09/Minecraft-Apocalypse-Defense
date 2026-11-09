import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialKingdom} from '../../../CivilizationApocalypse_BP/scripts/kingdom/state.js';
import {buildStarterBaseline,starterArmProblems} from '../../../CivilizationApocalypse_BP/scripts/sim/starter.js';
// Intentionally failing desired-contract repros. No native authority or edits.
test('desired no-reset arming preserves an evolved clock',()=>{const k=createInitialKingdom();k.step=77;assert.equal(buildStarterBaseline({current:k,armedAtStep:77}).step,77);});
test('desired reviewed empty-v3 arming needs a distinct acceptance path',()=>{const k=createInitialKingdom();assert.equal(starterArmProblems({kingdom:k,keys:['civ:pop_bind:v3:meta','civ:creation_activation:v3']}).some(p=>p.includes('physical creation history remains')),false);});
