import test from 'node:test';import assert from 'node:assert/strict';
import {world,system} from '../native-stub.mjs';
import {registerPeopleCommand} from '../proposed/commands/people.js';
test('new creation command must report private activation refusal instead of silently swallowing it',()=>{const lines=[];let receive;world.sendMessage=s=>lines.push(s);system.afterEvents={scriptEventReceive:{subscribe(fn){receive=fn;}}};registerPeopleCommand({statusLines:()=>[],creationCommand(){throw Error('no actual reviewed compiled blank-world receipt configured');}});receive({id:'civ:people',message:'creation fresh confirm'});assert.ok(lines.some(s=>s.includes('receipt configured')),'private command refusal disappeared in generic catch');});
