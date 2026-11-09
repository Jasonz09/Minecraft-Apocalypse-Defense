import test from 'node:test';import assert from 'node:assert/strict';
import {createInitialKingdom} from '../../../CivilizationApocalypse_BP/scripts/kingdom/state.js';
import {resolveAssault} from '../../../CivilizationApocalypse_BP/scripts/sim/war.js';
import {buildGroupTable} from '../../../CivilizationApocalypse_BP/scripts/population/groups.js';
import {POP_SYNC_DEFAULTS} from '../../../CivilizationApocalypse_BP/scripts/population/settings.js';
test('actual war resolver consumes aggregate soldiers and assault without any native event input',()=>{const k=createInitialKingdom(),d=k.districts[0];d.assault=100;d.security='contested';const soldiers=d.soldiers,assault=d.assault;const events=resolveAssault(k,d);assert.ok(d.soldiers<soldiers);assert.ok(d.assault<assault);assert.ok(events.length);});
test('actual representation covers five soldiers and a smaller tail; entity death weight is not one by default',()=>{const k=createInitialKingdom();k.districts[0].soldiers=7;const t=buildGroupTable(k,POP_SYNC_DEFAULTS);assert.deepEqual(t.problems,[]);assert.deepEqual(t.groups.filter(g=>g.district==='district-1'&&g.kind==='sol').map(g=>g.headcount),[5,2]);});
