// Actual production runtime, synthetic existing SDK-shaped Ledger harness.
// No source/world edits. The second case intentionally fails current behavior.
import test from 'node:test';import assert from 'node:assert/strict';
import {createLedgerUi} from '../../../CivilizationApocalypse_BP/scripts/ledger/runtime.js';
import {createLedgerHarness,kingdomStates,makeMarkerStack} from '../../lib/ledgerharness.mjs';
async function run(revoke){const h=createLedgerHarness({kingdom:kingdomStates().fresh()});let gate=true;h.deps.gateOpen=()=>gate;const ui=createLedgerUi(h.deps);ui.register();const p=h.player('Synthetic Commander');const pick=label=>shown=>{const selection=shown.buttons.indexOf(label);assert.notEqual(selection,-1);return{canceled:false,selection};};h.forms.script.push(pick('Military'),pick('Recruit in Hearthgate'),shown=>{if(revoke)gate=false;return pick('Recruit')(shown);},'pending');h.world.emitItemUse({source:p,itemStack:makeMarkerStack()});for(let i=0;i<6;i++)await h.advance(1);return{h,gate};}
test('control: confirmed recruitment with live gate ON saves once',async()=>{const {h}=await run(false);assert.equal(h.store.saves.length,1);assert.equal(h.store.peek().districts[0].trainingQueue,2);});
test('REQUIRED: revoking Ledger gate while confirmation open prevents mutation',async()=>{const {h,gate}=await run(true);assert.equal(gate,false);assert.equal(h.store.saves.length,0,'open confirmation must not bypass a revoked live Ledger gate');assert.equal(h.store.peek().districts[0].trainingQueue,0);});
